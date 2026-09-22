-- LOCAL REVIEW DRAFT. Apply after schema-draft.sql in isolated verification only.
-- No secrets, message bodies, public Storage policies, or changes to routing tables.
begin;
alter table atlas_pod_private.submissions
 add column email_status text not null default 'pending' check(email_status in ('pending','sending','sent','failed')),
 add column email_attempted_at timestamptz,
 add column email_sent_at timestamptz,
 add column gmail_message_id text,
 add column email_retry_count integer not null default 0,
 add column email_error_code text,
 add column email_attempt_id uuid;
create table atlas_pod_private.email_attempts (
 id uuid primary key, submission_id uuid not null references atlas_pod_private.submissions(id),
 actor_id uuid not null references auth.users(id), mode text not null check(mode in ('send','retry','resend')),
 state text not null check(state in ('sending','sent','failed')), attempted_at timestamptz not null default now(),
 finished_at timestamptz, gmail_message_id text, error_code text
);
alter table atlas_pod_private.email_attempts enable row level security;
revoke all on atlas_pod_private.email_attempts from public,anon,authenticated;

create function atlas_pod_private.email_summary(s atlas_pod_private.submissions) returns jsonb
language sql stable set search_path='' as $$
 select jsonb_build_object('email_status',s.email_status,'email_attempted_at',s.email_attempted_at,
 'email_sent_at',s.email_sent_at,'gmail_message_id',s.gmail_message_id,'email_retry_count',s.email_retry_count,'email_error_code',s.email_error_code)
$$;
create function atlas_pod_private.email_context(p_submission uuid) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare s atlas_pod_private.submissions; b jsonb;
begin
 select * into s from atlas_pod_private.submissions where id=p_submission and state='received';
 if s.id is null then raise exception using errcode='42501',message='POD_ACCESS_DENIED'; end if;
 b:=atlas_pod_private.context(s.binding_id);
 return b||jsonb_build_object('document',jsonb_build_object('id',s.id,'object_prefix',s.object_prefix,'filename',s.filename,'pdf_hash',s.pdf_hash));
end $$;
create function public.atlas_pod_email_context(p_submission uuid) returns jsonb
language sql stable set search_path='' as $$select atlas_pod_private.email_context(p_submission)$$;

create function atlas_pod_private.email_claim(p_submission uuid,p_actor uuid,p_session uuid,p_request uuid,p_mode text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare s atlas_pod_private.submissions; b atlas_pod_private.bindings; c text;
begin
 select * into s from atlas_pod_private.submissions where id=p_submission for update;
 select * into b from atlas_pod_private.bindings where id=s.binding_id;
 c:=atlas_pod_private.access(p_actor,p_session,b.warehouse_id);
 if c is null or s.state is distinct from 'received' or (c='driver' and (b.driver_id<>p_actor or not atlas_pod_private.is_current(b))) then
  raise exception using errcode='42501',message='POD_ACCESS_DENIED'; end if;
 if p_mode is null or p_mode not in ('send','retry','resend') or p_request is null then raise exception 'INVALID_EMAIL_ATTEMPT'; end if;
 if p_mode<>'send' and c<>'office' then raise exception using errcode='42501',message='POD_OFFICE_REQUIRED'; end if;
 -- A repeated request, including a lost resend response, never creates another send.
 if exists(select 1 from atlas_pod_private.email_attempts where id=p_request) then
  return atlas_pod_private.email_summary(s)||jsonb_build_object('claimed',false); end if;
 if (p_mode='send' and s.email_status<>'pending') or
    (p_mode='retry' and (s.email_status not in ('pending','failed') or s.email_error_code='SEND_OUTCOME_UNKNOWN')) or
    (p_mode='resend' and s.email_status not in ('sent','sending','failed')) then
  return atlas_pod_private.email_summary(s)||jsonb_build_object('claimed',false); end if;
 -- Do not reclaim an active send. Stale sends require an explicit, warned manager resend.
 if s.email_attempted_at>now()-(case when s.email_status='sending' then interval '5 minutes' else interval '30 seconds' end) then
  return atlas_pod_private.email_summary(s)||jsonb_build_object('claimed',false); end if;
 insert into atlas_pod_private.email_attempts(id,submission_id,actor_id,mode,state) values(p_request,s.id,p_actor,p_mode,'sending');
 update atlas_pod_private.submissions set email_status='sending',email_attempt_id=p_request,email_error_code=null,
 email_attempted_at=now(),email_retry_count=email_retry_count+case when email_attempt_id is null then 0 else 1 end
 where id=s.id returning * into s;
 insert into atlas_pod_private.events(binding_id,actor_id,event) values(b.id,p_actor,'pod_email_'||p_mode||'_started');
 return atlas_pod_private.email_summary(s)||jsonb_build_object('claimed',true,'attempt_id',p_request);
end $$;
create function atlas_pod_private.email_finish(p_submission uuid,p_attempt uuid,p_message text,p_error text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare s atlas_pod_private.submissions; a atlas_pod_private.email_attempts;
begin
 select * into strict s from atlas_pod_private.submissions where id=p_submission for update;
 select * into strict a from atlas_pod_private.email_attempts where id=p_attempt and submission_id=s.id for update;
 if a.state<>'sending' or s.email_attempt_id<>p_attempt then return atlas_pod_private.email_summary(s); end if;
 if p_message is not null and p_message !~ '^[a-zA-Z0-9_-]{1,200}$' then raise exception 'INVALID_MESSAGE_RECEIPT'; end if;
 if p_message is null and (p_error is null or p_error not in ('PDF_UNAVAILABLE','PDF_TOO_LARGE','INVALID_PDF','INVALID_PDF_NAME','EMAIL_CONFIGURATION_REQUIRED',
 'GMAIL_AUTH_REQUIRED','GMAIL_AUTH_UNAVAILABLE','EMAIL_ACCESS_CHANGED','GMAIL_RATE_LIMITED','GMAIL_SEND_REJECTED','SEND_OUTCOME_UNKNOWN','EMAIL_PREPARATION_FAILED')) then raise exception 'INVALID_EMAIL_ERROR'; end if;
 update atlas_pod_private.email_attempts set state=case when p_message is null then 'failed' else 'sent' end,
 finished_at=now(),gmail_message_id=p_message,error_code=case when p_message is null then p_error else null end where id=a.id;
 update atlas_pod_private.submissions set email_status=case when p_message is null then 'failed' else 'sent' end,
 gmail_message_id=coalesce(p_message,gmail_message_id),email_sent_at=case when p_message is null then email_sent_at else now() end,
 email_error_code=case when p_message is null then p_error else null end where id=s.id returning * into s;
 insert into atlas_pod_private.events(binding_id,actor_id,event) values(s.binding_id,a.actor_id,'pod_email_'||s.email_status);
 return atlas_pod_private.email_summary(s);
end $$;
create function public.atlas_pod_email_claim(p_submission uuid,p_actor uuid,p_session uuid,p_request uuid,p_mode text) returns jsonb
language sql set search_path='' as $$select atlas_pod_private.email_claim(p_submission,p_actor,p_session,p_request,p_mode)$$;
create function public.atlas_pod_email_finish(p_submission uuid,p_attempt uuid,p_message text,p_error text) returns jsonb
language sql set search_path='' as $$select atlas_pod_private.email_finish(p_submission,p_attempt,p_message,p_error)$$;

create or replace function atlas_pod_private.list_day(p_day date) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare w uuid; c text;
begin
 select id into w from public.warehouses where code='CA' and active;
 c:=atlas_pod_private.access(auth.uid(),(auth.jwt()->>'session_id')::uuid,w);
 if c is null then raise exception using errcode='42501',message='POD_ACCESS_DENIED'; end if;
 return jsonb_build_object('capability',c,'warehouse','CA','shipments',coalesce((select jsonb_agg(to_jsonb(b)||jsonb_build_object('current',atlas_pod_private.is_current(b),
 'submission',case when s.id is null then null else jsonb_build_object('id',s.id,'state',s.state,'filename',s.filename,'received_at',s.received_at,'netsuite_uploaded_at',s.netsuite_uploaded_at)||atlas_pod_private.email_summary(s) end) order by b.trip_index,b.customer)
 from atlas_pod_private.bindings b left join atlas_pod_private.submissions s on s.binding_id=b.id
 where b.warehouse_id=w and b.planning_day=p_day and (c='office' or b.driver_id=auth.uid())),'[]'::jsonb));
end $$;
revoke all on function atlas_pod_private.email_summary(atlas_pod_private.submissions),atlas_pod_private.email_context(uuid),atlas_pod_private.email_claim(uuid,uuid,uuid,uuid,text),atlas_pod_private.email_finish(uuid,uuid,text,text) from public,anon,authenticated;
revoke all on function public.atlas_pod_email_context(uuid),public.atlas_pod_email_claim(uuid,uuid,uuid,uuid,text),public.atlas_pod_email_finish(uuid,uuid,text,text) from public,anon,authenticated;
grant execute on function atlas_pod_private.email_context(uuid),public.atlas_pod_email_context(uuid) to authenticated;
grant usage on schema atlas_pod_private to service_role;
grant execute on function atlas_pod_private.email_claim(uuid,uuid,uuid,uuid,text),atlas_pod_private.email_finish(uuid,uuid,text,text),public.atlas_pod_email_claim(uuid,uuid,uuid,uuid,text),public.atlas_pod_email_finish(uuid,uuid,text,text) to service_role;
commit;
