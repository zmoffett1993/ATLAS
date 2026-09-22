-- LOCAL REVIEW DRAFT ONLY. Not applied. No changes to existing routing/COC tables.
-- Generate a migration with the Supabase CLI and verify on an isolated database
-- before activation. Driver and office memberships require explicit provisioning.
begin;
create schema if not exists atlas_pod_private;
revoke all on schema atlas_pod_private from public, anon, authenticated;
create table atlas_pod_private.members (
 warehouse_id uuid references public.warehouses(id), user_id uuid references auth.users(id),
 capability text not null check(capability in ('office','driver')), enabled boolean not null default false,
 primary key(warehouse_id,user_id)
);
create table atlas_pod_private.bindings (
 id uuid primary key default gen_random_uuid(), warehouse_id uuid not null references public.warehouses(id),
 planning_day date not null, order_id uuid not null, trip_index integer not null check(trip_index>=0),
 source_revision integer not null, source_shipment jsonb not null, source_assignment text not null,
 driver_id uuid not null references auth.users(id), customer text not null, sales_order text not null,
 address text not null, shipment_number integer not null, shipment_total integer not null,
 created_by uuid not null references auth.users(id), created_at timestamptz not null default now(),
 check(shipment_number>=1 and shipment_total>=shipment_number),
 unique(warehouse_id,planning_day,order_id,trip_index),
 foreign key(warehouse_id,planning_day) references atlas_routing_preview_private.days(warehouse_id,planning_day)
);
create table atlas_pod_private.submissions (
 id uuid primary key, binding_id uuid not null references atlas_pod_private.bindings(id),
 actor_id uuid not null references auth.users(id), manifest_hash text not null check(manifest_hash~'^[0-9a-f]{64}$'),
 state text not null default 'uploading' check(state in ('uploading','received')),
 object_prefix text not null unique, filename text not null, pdf_hash text, page_count integer not null check(page_count between 1 and 10),
 created_at timestamptz not null default now(), received_at timestamptz, netsuite_uploaded_at timestamptz, netsuite_actor uuid references auth.users(id),
 unique(binding_id)
);
create table atlas_pod_private.events (
 id bigint generated always as identity primary key, binding_id uuid not null references atlas_pod_private.bindings(id),
 actor_id uuid not null references auth.users(id), event text not null, at timestamptz not null default now()
);
alter table atlas_pod_private.members enable row level security;
alter table atlas_pod_private.bindings enable row level security;
alter table atlas_pod_private.submissions enable row level security;
alter table atlas_pod_private.events enable row level security;
revoke all on all tables in schema atlas_pod_private from public,anon,authenticated;

-- No public storage access, listing, upsert, deletion or user-write policies.
-- The Edge adapter authorizes a specific binding before every storage operation.
insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
 values('atlas-pod-originals','atlas-pod-originals',false,15000000,array['image/jpeg','image/png']),
 ('atlas-pod-documents','atlas-pod-documents',false,25000000,array['application/pdf']);

create function atlas_pod_private.access(p_user uuid,p_session uuid,p_warehouse uuid) returns text
language sql stable security definer set search_path='' as $$
 select m.capability from atlas_pod_private.members m
 join public.warehouses w on w.id=m.warehouse_id and w.active and w.code='CA'
 join public.profiles p on p.user_id=m.user_id
 join auth.users u on u.id=m.user_id
 where m.user_id=p_user and m.warehouse_id=p_warehouse and m.enabled
 and not coalesce(u.is_anonymous,false) and (u.banned_until is null or u.banned_until<=now())
 and exists(select 1 from auth.sessions s where s.id=p_session and s.user_id=p_user and (s.not_after is null or s.not_after>now()))
 and (p.warehouse_id=w.id or exists(select 1 from public.profile_warehouse_access a where a.user_id=p_user and a.warehouse_id=w.id))
 and (m.capability='driver' or (lower(p.role::text) in ('admin','administrator','supervisor') and
 (lower(u.raw_app_meta_data->>'role') in ('admin','administrator','supervisor') or lower(u.raw_app_meta_data->>'atlas_role') in ('admin','administrator','supervisor') or
 exists(select 1 from jsonb_array_elements_text(case when jsonb_typeof(u.raw_app_meta_data->'roles')='array' then u.raw_app_meta_data->'roles' else '[]'::jsonb end) r(role) where lower(r.role) in ('admin','administrator','supervisor')))))
$$;
create function atlas_pod_private.is_current(b atlas_pod_private.bindings) returns boolean
language sql stable security definer set search_path='' as $$
 select exists(select 1 from atlas_routing_preview_private.days d where d.warehouse_id=b.warehouse_id and d.planning_day=b.planning_day
 and d.document->'lockedTrips'->b.trip_index->>'assignment'=b.source_assignment
 and exists(select 1 from jsonb_array_elements(d.document->'lockedTrips'->b.trip_index->'shipments') s where s=b.source_shipment)
 and exists(select 1 from jsonb_array_elements(d.document->'orders') o where o->>'id'=b.order_id::text and o->>'orderNumber'=b.sales_order and o->>'customer'=b.customer and o->>'address'=b.address))
$$;
create function atlas_pod_private.context(p_binding uuid) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare b atlas_pod_private.bindings; c text; s uuid := (auth.jwt()->>'session_id')::uuid;
begin
 select * into b from atlas_pod_private.bindings where id=p_binding;
 c:=atlas_pod_private.access(auth.uid(),s,b.warehouse_id);
 if c is null or (c='driver' and b.driver_id<>auth.uid()) then raise exception using errcode='42501',message='POD_ACCESS_DENIED'; end if;
 if c='driver' and not atlas_pod_private.is_current(b) then raise exception using errcode='40001',message='SHIPMENT_CHANGED_REVIEW_REQUIRED'; end if;
 return to_jsonb(b)||jsonb_build_object('actor_id',auth.uid(),'session_id',s,'capability',c,'current',atlas_pod_private.is_current(b),'document',(select jsonb_build_object('object_prefix',object_prefix,'filename',filename,'pdf_hash',pdf_hash) from atlas_pod_private.submissions where binding_id=b.id and state='received'));
end $$;
create function atlas_pod_private.list_day(p_day date) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare w uuid; c text;
begin
 select id into w from public.warehouses where code='CA' and active;
 c:=atlas_pod_private.access(auth.uid(),(auth.jwt()->>'session_id')::uuid,w);
 if c is null then raise exception using errcode='42501',message='POD_ACCESS_DENIED'; end if;
 return jsonb_build_object('capability',c,'warehouse','CA','shipments',coalesce((select jsonb_agg(to_jsonb(b)||jsonb_build_object('current',atlas_pod_private.is_current(b),'submission',case when s.id is null then null else jsonb_build_object('id',s.id,'state',s.state,'filename',s.filename,'received_at',s.received_at,'netsuite_uploaded_at',s.netsuite_uploaded_at) end) order by b.trip_index,b.customer)
 from atlas_pod_private.bindings b left join atlas_pod_private.submissions s on s.binding_id=b.id
 where b.warehouse_id=w and b.planning_day=p_day and (c='office' or b.driver_id=auth.uid())),'[]'::jsonb));
end $$;
-- Bind only a completely dispatched order: future split numbering must not be guessed.
-- A later allocation-approval workflow is required to bind partial departures earlier.
create function atlas_pod_private.bind(p_day date,p_revision integer,p_trip integer,p_order uuid,p_driver uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare w uuid; d atlas_routing_preview_private.days; o jsonb; sh jsonb; total integer; num integer; b atlas_pod_private.bindings;
begin
 select id into w from public.warehouses where code='CA' and active;
 if atlas_pod_private.access(auth.uid(),(auth.jwt()->>'session_id')::uuid,w) is distinct from 'office' or not atlas_routing_preview_private.can_access(true) then raise exception using errcode='42501',message='POD_OFFICE_REQUIRED'; end if;
 if not exists(select 1 from atlas_pod_private.members where warehouse_id=w and user_id=p_driver and capability='driver' and enabled) then raise exception 'APPROVED_DRIVER_REQUIRED'; end if;
 select * into strict d from atlas_routing_preview_private.days where warehouse_id=w and planning_day=p_day for share;
 if d.revision<>p_revision or p_trip<0 then raise exception using errcode='40001',message='SAVED_DAY_CHANGED'; end if;
 select value into o from jsonb_array_elements(d.document->'orders') where value->>'id'=p_order::text;
 select value into sh from jsonb_array_elements(d.document->'lockedTrips'->p_trip->'shipments') where value->>'orderId'=p_order::text;
 if o is null or sh is null or o->>'dispatchedOn' is null then raise exception 'COMPLETE_SHIPMENT_ALLOCATION_REQUIRED'; end if;
 select count(*),count(*) filter(where ord-1<=p_trip) into total,num from jsonb_array_elements(d.document->'lockedTrips') with ordinality as t(trip,ord)
 where exists(select 1 from jsonb_array_elements(trip->'shipments') s where s->>'orderId'=p_order::text);
 insert into atlas_pod_private.bindings(warehouse_id,planning_day,order_id,trip_index,source_revision,source_shipment,source_assignment,driver_id,customer,sales_order,address,shipment_number,shipment_total,created_by)
 values(w,p_day,p_order,p_trip,p_revision,sh,d.document->'lockedTrips'->p_trip->>'assignment',p_driver,o->>'customer',o->>'orderNumber',o->>'address',num,total,auth.uid()) returning * into b;
 insert into atlas_pod_private.events(binding_id,actor_id,event) values(b.id,auth.uid(),'binding_created');
 return to_jsonb(b);
end $$;

-- Server-only transaction. Actor/session originate from the user's context RPC,
-- never from a client-supplied actor or warehouse in an upload request.
create function public.atlas_pod_receive(p_binding uuid,p_actor uuid,p_session uuid,p_submission uuid,p_manifest text,p_filename text,p_pages integer,p_pdf_hash text default null) returns jsonb
language plpgsql security definer set search_path='' as $$
declare b atlas_pod_private.bindings; s atlas_pod_private.submissions; c text;
begin
 select * into strict b from atlas_pod_private.bindings where id=p_binding for update;
 c:=atlas_pod_private.access(p_actor,p_session,b.warehouse_id);
 if c is null or (c='driver' and b.driver_id<>p_actor) or not atlas_pod_private.is_current(b) then raise exception using errcode='42501',message='POD_ACCESS_DENIED_OR_CHANGED'; end if;
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
 insert into atlas_pod_private.events(binding_id,actor_id,event) values(b.id,p_actor,'pod_received_email_disabled');
 end if;
 end if;
 return to_jsonb(s);
end $$;
create function public.atlas_pod_context(p_binding uuid) returns jsonb language sql stable set search_path='' as $$select atlas_pod_private.context(p_binding)$$;
create function public.atlas_pod_list(p_day date) returns jsonb language sql stable set search_path='' as $$select atlas_pod_private.list_day(p_day)$$;
create function public.atlas_pod_bind(p_day date,p_revision integer,p_trip integer,p_order uuid,p_driver uuid) returns jsonb language sql set search_path='' as $$select atlas_pod_private.bind(p_day,p_revision,p_trip,p_order,p_driver)$$;
revoke all on all functions in schema atlas_pod_private from public,anon,authenticated;
revoke all on function public.atlas_pod_receive(uuid,uuid,uuid,uuid,text,text,integer,text) from public,anon,authenticated;
grant execute on function public.atlas_pod_receive(uuid,uuid,uuid,uuid,text,text,integer,text) to service_role;
revoke all on function public.atlas_pod_context(uuid),public.atlas_pod_list(date),public.atlas_pod_bind(date,integer,integer,uuid,uuid) from public,anon;
grant usage on schema atlas_pod_private to authenticated;
grant execute on function atlas_pod_private.context(uuid),atlas_pod_private.list_day(date),atlas_pod_private.bind(date,integer,integer,uuid,uuid) to authenticated;
grant execute on function public.atlas_pod_context(uuid),public.atlas_pod_list(date),public.atlas_pod_bind(date,integer,integer,uuid,uuid) to authenticated;
commit;
