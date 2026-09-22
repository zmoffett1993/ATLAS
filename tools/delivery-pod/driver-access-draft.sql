-- Local review source, not an applied or CLI-generated migration.
-- Apply after the approved base POD and Gmail sources, only with separate approval.
begin;

create function atlas_pod_private.is_admin(p_user uuid) returns boolean
language sql stable set search_path='' as $$
 select exists(select 1 from public.profiles p join auth.users u on u.id=p.user_id
 where p.user_id=p_user and lower(p.role::text) in ('admin','administrator')
 and (lower(u.raw_app_meta_data->>'role') in ('admin','administrator')
 or lower(u.raw_app_meta_data->>'atlas_role') in ('admin','administrator')
 or exists(select 1 from jsonb_array_elements_text(case when jsonb_typeof(u.raw_app_meta_data->'roles')='array' then u.raw_app_meta_data->'roles' else '[]'::jsonb end) r(role) where lower(r.role) in ('admin','administrator'))))
$$;

create function atlas_pod_private.eligible_driver(p_user uuid,p_warehouse uuid) returns boolean
language sql stable set search_path='' as $$
 select exists(select 1 from public.profiles p join auth.users u on u.id=p.user_id
 join public.warehouses w on w.id=p.warehouse_id and w.active and w.code='CA'
 where p.user_id=p_user and w.id=p_warehouse and lower(p.role::text)='picker'
 and not coalesce(u.is_anonymous,false) and (u.banned_until is null or u.banned_until<=now())
 and not exists(select 1 from atlas_pod_private.members m where m.user_id=p_user and m.warehouse_id=w.id and (not m.enabled or m.capability<>'driver')))
$$;

create function atlas_pod_private.driver_access() returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare w uuid; c text; s uuid := (auth.jwt()->>'session_id')::uuid;
begin
 select id into w from public.warehouses where code='CA' and active;
 c:=atlas_pod_private.access(auth.uid(),s,w);
 if c is null then
  if not atlas_pod_private.eligible_driver(auth.uid(),w) or not exists(select 1 from auth.sessions where id=s and user_id=auth.uid() and (not_after is null or not_after>now())) then
   raise exception using errcode='42501',message='POD_ACCESS_DENIED';
  end if;
  c:='unassigned';
 end if;
 return jsonb_build_object('capability',c,'canEdit',c='office' and atlas_routing_preview_private.can_access(true));
end $$;

create function atlas_pod_private.driver_roster(p_day date) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare w uuid; d atlas_routing_preview_private.days;
begin
 select id into w from public.warehouses where code='CA' and active;
 if not atlas_routing_preview_private.can_access(true) or atlas_pod_private.access(auth.uid(),(auth.jwt()->>'session_id')::uuid,w) is distinct from 'office' then
  raise exception using errcode='42501',message='POD_OFFICE_REQUIRED';
 end if;
 select * into d from atlas_routing_preview_private.days where warehouse_id=w and planning_day=p_day;
 return jsonb_build_object('revision',coalesce(d.revision,0),'drivers',coalesce((select jsonb_agg(jsonb_build_object('id',p.user_id,'name',p.display_name) order by p.display_name)
 from public.profiles p where atlas_pod_private.eligible_driver(p.user_id,w)),'[]'::jsonb),
 'trips',coalesce((select jsonb_agg(jsonb_build_object('index',t.ord-1,'stops',jsonb_array_length(t.trip->'shipments'),'pallets',t.trip->'palletSpaces',
 'driver_name',(select string_agg(distinct p.display_name,', ' order by p.display_name) from atlas_pod_private.bindings b join public.profiles p on p.user_id=b.driver_id where b.warehouse_id=w and b.planning_day=p_day and b.trip_index=t.ord-1)) order by t.ord)
 from jsonb_array_elements(d.document->'lockedTrips') with ordinality t(trip,ord)),'[]'::jsonb));
end $$;

create function atlas_pod_private.assign_trip(p_day date,p_revision integer,p_trip integer,p_driver uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare w uuid; d atlas_routing_preview_private.days; sh jsonb; b atlas_pod_private.bindings; count_assigned integer:=0;
begin
 select id into w from public.warehouses where code='CA' and active;
 if not atlas_routing_preview_private.can_access(true) or atlas_pod_private.access(auth.uid(),(auth.jwt()->>'session_id')::uuid,w) is distinct from 'office' then
  raise exception using errcode='42501',message='POD_OFFICE_REQUIRED';
 end if;
 if not atlas_pod_private.eligible_driver(p_driver,w) then raise exception 'APPROVED_DRIVER_REQUIRED'; end if;
 -- Serialize against other assignments and saved-day changes; no partial grants.
 select * into d from atlas_routing_preview_private.days where warehouse_id=w and planning_day=p_day for update;
 if d.revision is distinct from p_revision or d.revision is null then raise exception using errcode='40001',message='SAVED_DAY_CHANGED'; end if;
 if p_trip is null or p_trip<0 or p_trip>=jsonb_array_length(d.document->'lockedTrips') then raise exception 'INVALID_TRIP'; end if;
 insert into atlas_pod_private.members(warehouse_id,user_id,capability,enabled) values(w,p_driver,'driver',true) on conflict do nothing;
 for sh in select value from jsonb_array_elements(d.document->'lockedTrips'->p_trip->'shipments') loop
  select * into b from atlas_pod_private.bindings where warehouse_id=w and planning_day=p_day and trip_index=p_trip and order_id=(sh->>'orderId')::uuid;
  if b.id is not null then
   if b.driver_id<>p_driver then raise exception 'POD_TRIP_ALREADY_ASSIGNED'; end if;
   if not atlas_pod_private.is_current(b) then raise exception 'POD_ASSIGNMENT_CHANGED'; end if;
  else
   perform atlas_pod_private.bind(p_day,p_revision,p_trip,(sh->>'orderId')::uuid,p_driver);
  end if;
  count_assigned:=count_assigned+1;
 end loop;
 if count_assigned=0 then raise exception 'INVALID_TRIP'; end if;
 return jsonb_build_object('assigned',count_assigned);
end $$;

create function atlas_pod_private.driver_list(p_day date) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare result jsonb; c jsonb;
begin
 c:=atlas_pod_private.driver_access();
 if c->>'capability'='unassigned' then return jsonb_build_object('capability','driver','warehouse','CA','shipments','[]'::jsonb); end if;
 result:=atlas_pod_private.list_day(p_day);
 return jsonb_set(result,'{shipments}',coalesce((select jsonb_agg(s.item||jsonb_build_object('driver_name',p.display_name,
 'delivery',case when (s.item->>'current')::boolean then jsonb_build_object('timeWindow',o.item->>'timeWindow','notes',o.item->>'notes','checkOnDelivery',o.item->'checkOnDelivery') else '{}'::jsonb end)
 order by b.trip_index,stop.ord)
 from jsonb_array_elements(result->'shipments') s(item)
 join atlas_pod_private.bindings b on b.id=(s.item->>'id')::uuid
 join public.profiles p on p.user_id=b.driver_id
 join atlas_routing_preview_private.days d on d.warehouse_id=b.warehouse_id and d.planning_day=b.planning_day
 left join lateral jsonb_array_elements(d.document->'orders') o(item) on o.item->>'id'=b.order_id::text
 left join lateral jsonb_array_elements(d.document->'lockedTrips'->b.trip_index->'shipments') with ordinality stop(item,ord) on stop.item->>'orderId'=b.order_id::text),'[]'::jsonb));
end $$;

create function public.atlas_pod_driver_access() returns jsonb language sql set search_path='' as $$select atlas_pod_private.driver_access()$$;
create function public.atlas_pod_driver_roster(p_day date) returns jsonb language sql set search_path='' as $$select atlas_pod_private.driver_roster(p_day)$$;
create function public.atlas_pod_assign_trip(p_day date,p_revision integer,p_trip integer,p_driver uuid) returns jsonb language sql set search_path='' as $$select atlas_pod_private.assign_trip(p_day,p_revision,p_trip,p_driver)$$;
create or replace function public.atlas_pod_list(p_day date) returns jsonb language sql set search_path='' as $$select atlas_pod_private.driver_list(p_day)$$;

revoke all on function atlas_pod_private.is_admin(uuid),atlas_pod_private.eligible_driver(uuid,uuid),atlas_pod_private.driver_access(),atlas_pod_private.driver_roster(date),atlas_pod_private.assign_trip(date,integer,integer,uuid),atlas_pod_private.driver_list(date) from public,anon,authenticated;
revoke all on function public.atlas_pod_driver_access(),public.atlas_pod_driver_roster(date),public.atlas_pod_assign_trip(date,integer,integer,uuid),public.atlas_pod_list(date) from public,anon,authenticated;
grant execute on function atlas_pod_private.driver_access(),atlas_pod_private.driver_roster(date),atlas_pod_private.assign_trip(date,integer,integer,uuid),atlas_pod_private.driver_list(date),public.atlas_pod_driver_access(),public.atlas_pod_driver_roster(date),public.atlas_pod_assign_trip(date,integer,integer,uuid),public.atlas_pod_list(date) to authenticated;

-- Replacement authorization definitions follow. Existing data and policies remain.
create or replace function atlas_routing_preview_private.can_access(p_write boolean)
returns boolean language sql stable security definer set search_path='' as $$
 select auth.uid() is not null and exists (
  select 1 from atlas_routing_preview_private.members m
  join public.warehouses w on w.id=m.warehouse_id and w.active and w.code='CA'
  join public.profiles p on p.user_id=m.user_id
  join auth.users u on u.id=m.user_id
  where m.user_id=auth.uid() and m.enabled and (not p_write or (m.permission='editor' and atlas_pod_private.is_admin(auth.uid())))
  and lower(p.role::text) in ('admin','administrator','supervisor')
  and exists(select 1 from public.profile_warehouse_access a where a.user_id=m.user_id and a.warehouse_id=w.id)
  and not coalesce(u.is_anonymous,false) and (u.banned_until is null or u.banned_until<=now())
  and exists(select 1 from auth.sessions s where s.user_id=u.id and s.id::text=auth.jwt()->>'session_id' and (s.not_after is null or s.not_after>now()))
  and (lower(u.raw_app_meta_data->>'role') in ('admin','administrator','supervisor')
    or lower(u.raw_app_meta_data->>'atlas_role') in ('admin','administrator','supervisor')
    or exists(select 1 from jsonb_array_elements_text(case when jsonb_typeof(u.raw_app_meta_data->'roles')='array' then u.raw_app_meta_data->'roles' else '[]'::jsonb end) r(role) where lower(r.role) in ('admin','administrator','supervisor')))
 );
$$;

create or replace function atlas_pod_private.access(p_user uuid,p_session uuid,p_warehouse uuid) returns text
language sql stable security definer set search_path='' as $$
 select case when m.capability='office' and not atlas_pod_private.is_admin(p_user) then 'viewer' else m.capability end from atlas_pod_private.members m
 join public.warehouses w on w.id=m.warehouse_id and w.active and w.code='CA'
 join public.profiles p on p.user_id=m.user_id
 join auth.users u on u.id=m.user_id
 where m.user_id=p_user and m.warehouse_id=p_warehouse and m.enabled
 and not coalesce(u.is_anonymous,false) and (u.banned_until is null or u.banned_until<=now())
 and exists(select 1 from auth.sessions s where s.id=p_session and s.user_id=p_user and (s.not_after is null or s.not_after>now()))
 and (p.warehouse_id=w.id or exists(select 1 from public.profile_warehouse_access a where a.user_id=p_user and a.warehouse_id=w.id))
 and ((m.capability='driver' and lower(p.role::text)='picker') or (m.capability='office' and lower(p.role::text) in ('admin','administrator','supervisor') and
 (lower(u.raw_app_meta_data->>'role') in ('admin','administrator','supervisor') or lower(u.raw_app_meta_data->>'atlas_role') in ('admin','administrator','supervisor') or
 exists(select 1 from jsonb_array_elements_text(case when jsonb_typeof(u.raw_app_meta_data->'roles')='array' then u.raw_app_meta_data->'roles' else '[]'::jsonb end) r(role) where lower(r.role) in ('admin','administrator','supervisor')))))
$$;

create or replace function public.atlas_pod_receive(p_binding uuid,p_actor uuid,p_session uuid,p_submission uuid,p_manifest text,p_filename text,p_pages integer,p_pdf_hash text default null) returns jsonb
language plpgsql security definer set search_path='' as $$
declare b atlas_pod_private.bindings; s atlas_pod_private.submissions; c text;
begin
 select * into strict b from atlas_pod_private.bindings where id=p_binding for update;
 c:=atlas_pod_private.access(p_actor,p_session,b.warehouse_id);
 if c is null or c='viewer' or (c='driver' and b.driver_id<>p_actor) or not atlas_pod_private.is_current(b) then raise exception using errcode='42501',message='POD_ACCESS_DENIED_OR_CHANGED'; end if;
 if p_filename !~ '^POD-SO-[0-9]+(-SHIPMENT-[0-9]+-OF-[0-9]+)?\.pdf$' or length(p_filename)>150 then raise exception 'INVALID_FILENAME'; end if;
 select * into s from atlas_pod_private.submissions where binding_id=b.id;
 if s.id is not null and (s.id<>p_submission or s.actor_id<>p_actor or s.manifest_hash<>p_manifest or s.filename<>p_filename or s.page_count<>p_pages) then raise exception using errcode='40001',message='POD_ALREADY_EXISTS_OR_RETRY_CHANGED'; end if;
 if s.id is null then
 insert into atlas_pod_private.submissions(id,binding_id,actor_id,manifest_hash,object_prefix,filename,page_count)
 values(p_submission,b.id,p_actor,p_manifest,b.warehouse_id::text||'/'||b.id::text||'/'||p_submission::text,p_filename,p_pages) returning * into s;
 end if;
 if p_pdf_hash is not null then
 if p_pdf_hash !~ '^[0-9a-f]{64}$' or (s.pdf_hash is not null and s.pdf_hash<>p_pdf_hash) then raise exception 'PDF_HASH_CONFLICT'; end if;
 if s.state<>'received' then
 update atlas_pod_private.submissions set state='received',pdf_hash=p_pdf_hash,received_at=now() where id=s.id returning * into s;
 insert into atlas_pod_private.events(binding_id,actor_id,event) values(b.id,p_actor,'pod_received');
 end if;
 end if;
 return to_jsonb(s);
end $$;

create or replace function atlas_pod_private.email_claim(p_submission uuid,p_actor uuid,p_session uuid,p_request uuid,p_mode text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare s atlas_pod_private.submissions; b atlas_pod_private.bindings; c text;
begin
 select * into s from atlas_pod_private.submissions where id=p_submission for update;
 select * into b from atlas_pod_private.bindings where id=s.binding_id;
 c:=atlas_pod_private.access(p_actor,p_session,b.warehouse_id);
 if c is null or c='viewer' or s.state is distinct from 'received' or (c='driver' and (b.driver_id<>p_actor or not atlas_pod_private.is_current(b))) then
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
 where b.warehouse_id=w and b.planning_day=p_day and (c in ('office','viewer') or b.driver_id=auth.uid())),'[]'::jsonb));
end $$;
commit;
