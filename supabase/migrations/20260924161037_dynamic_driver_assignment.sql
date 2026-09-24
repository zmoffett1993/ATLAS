-- Review package, not a generated migration filename.
begin;

-- Source: tools/delivery-pod/dynamic-driver-draft.sql
-- LOCAL PROTOTYPE ONLY. Not a generated migration and not approved for activation.
-- Requires the existing POD driver-access and next-load priority sources.

create schema atlas_driver_private;
revoke all on schema atlas_driver_private from public,anon,authenticated;
create table atlas_driver_private.accounts(
 user_id uuid primary key references auth.users(id), is_test boolean not null default false,
 schedule_id text not null default 'standard' check(schedule_id in ('standard','relief')),
 is_default boolean not null default false, updated_by uuid not null references auth.users(id),
 updated_at timestamptz not null default now(), check(not(is_test and is_default))
);
create unique index one_default_driver on atlas_driver_private.accounts(is_default) where is_default;
create table atlas_driver_private.trips(
 id uuid primary key default gen_random_uuid(), warehouse_id uuid not null references public.warehouses(id),
 planning_day date not null, trip_index integer not null check(trip_index between 0 and 199),
 is_test boolean not null default false, driver_id uuid not null references auth.users(id), driver_name text not null,
 vehicle_id text not null check(vehicle_id in ('box_truck','van_1','van_2')),
 schedule_id text not null check(schedule_id in ('standard','relief')),
 source_revision integer not null, version integer not null default 1,
 status text not null default 'assigned' check(status in ('assigned','sent','complete','cancelled')),
 created_by uuid not null references auth.users(id), created_at timestamptz not null default now(),
 unique(warehouse_id,planning_day,trip_index,is_test)
);
create index driver_trips_by_owner on atlas_driver_private.trips(driver_id,planning_day,is_test);
create table atlas_driver_private.stops(
 id uuid primary key default gen_random_uuid(), trip_id uuid not null references atlas_driver_private.trips(id),
 ordinal integer not null check(ordinal between 0 and 199), order_id uuid not null,
 is_test boolean not null, detail jsonb not null,
 status text not null default 'pending' check(status in ('pending','arrived','complete','exception')),
 recipient text, signature_ack boolean not null default false, collection_ack boolean not null default false, exception text,
 unique(trip_id,ordinal)
);
create table atlas_driver_private.receipts(
 id uuid primary key, stop_id uuid not null unique references atlas_driver_private.stops(id),
 actor_id uuid not null references auth.users(id), is_test boolean not null,
 manifest_hash text not null check(manifest_hash~'^[0-9a-f]{64}$'), object_prefix text not null unique,
 filename text not null, page_count integer not null check(page_count between 1 and 10), pdf_hash text,
 state text not null default 'uploading' check(state in ('uploading','received')),
 created_at timestamptz not null default now(), received_at timestamptz
);
create table atlas_driver_private.events(
 id bigint generated always as identity primary key, trip_id uuid references atlas_driver_private.trips(id),
 stop_id uuid references atlas_driver_private.stops(id), actor_id uuid not null references auth.users(id),
 is_test boolean not null, event text not null, detail jsonb not null default '{}', at timestamptz not null default now()
);
create index driver_events_by_trip on atlas_driver_private.events(trip_id,at);
alter table atlas_driver_private.accounts enable row level security;
alter table atlas_driver_private.trips enable row level security;
alter table atlas_driver_private.stops enable row level security;
alter table atlas_driver_private.receipts enable row level security;
alter table atlas_driver_private.events enable row level security;
revoke all on all tables in schema atlas_driver_private from public,anon,authenticated;

create function atlas_driver_private.active_ca(p_user uuid) returns boolean
language sql stable set search_path='' as $$
 select exists(select 1 from public.profiles p join auth.users u on u.id=p.user_id
 join public.warehouses w on w.code='CA' and w.active
 where p.user_id=p_user and lower(p.role::text) in ('picker','supervisor','admin','administrator')
 and exists(select 1 from public.profile_warehouse_access g where g.user_id=p_user and g.warehouse_id=w.id)
 and not coalesce(u.is_anonymous,false) and (u.banned_until is null or u.banned_until<=now())
 and nullif(to_jsonb(u)->>'deleted_at','') is null
 and coalesce(to_jsonb(p)->>'active','true')<>'false'
 and coalesce(to_jsonb(p)->>'disabled','false')<>'true'
 and nullif(to_jsonb(p)->>'deleted_at','') is null
 and not exists(select 1 from atlas_pod_private.members m where m.user_id=p_user and m.warehouse_id=w.id and not m.enabled))
$$;
create function atlas_driver_private.session_ok(p_user uuid,p_session uuid) returns boolean
language sql stable set search_path='' as $$
 select atlas_driver_private.active_ca(p_user) and exists(select 1 from auth.sessions s
 where s.id=p_session and s.user_id=p_user and (s.not_after is null or s.not_after>now()))
$$;
create function atlas_driver_private.test_account(p_user uuid) returns boolean
language sql stable set search_path='' as $$select coalesce((select is_test from atlas_driver_private.accounts where user_id=p_user),false)$$;
create function atlas_driver_private.manager() returns boolean
language sql stable set search_path='' as $$select atlas_routing_preview_private.can_access(true)
 and not atlas_driver_private.test_account(auth.uid())$$;
create function atlas_driver_private.can_drive(t atlas_driver_private.trips,p_user uuid,p_session uuid) returns boolean
language sql stable set search_path='' as $$select t.driver_id=p_user and t.status<>'cancelled'
 and t.is_test=atlas_driver_private.test_account(p_user) and atlas_driver_private.session_ok(p_user,p_session)$$;

create function public.atlas_driver_candidates(p_test boolean default false) returns jsonb
language plpgsql stable security definer set search_path='' as $$
begin
 if not atlas_driver_private.manager() then raise exception using errcode='42501',message='ADMIN_REQUIRED'; end if;
 return jsonb_build_object('schemaVersion',4,'defaultDriverUserId',(select user_id from atlas_driver_private.accounts where is_default and atlas_driver_private.active_ca(user_id)),
 'candidates',coalesce((select jsonb_agg(jsonb_build_object('userId',p.user_id,'displayName',p.display_name,
 'role',p.role,'roleLabel',case when lower(p.role::text)='picker' then 'Warehouse' else initcap(p.role::text) end,
 'homeWarehouseCode',w.code,'testAccount',atlas_driver_private.test_account(p.user_id),'scheduleId',coalesce(a.schedule_id,'standard')) order by lower(p.display_name),p.user_id)
 from public.profiles p join public.warehouses w on w.id=p.warehouse_id left join atlas_driver_private.accounts a on a.user_id=p.user_id
 where atlas_driver_private.active_ca(p.user_id) and nullif(trim(p.display_name),'') is not null
 and atlas_driver_private.test_account(p.user_id)=p_test),'[]'::jsonb));
end $$;

create function public.atlas_driver_configure_account(p_user uuid,p_test boolean,p_schedule text,p_default boolean default false) returns jsonb
language plpgsql security definer set search_path='' as $$
begin
 if not atlas_driver_private.manager() then raise exception using errcode='42501',message='ADMIN_REQUIRED'; end if;
 if not atlas_driver_private.active_ca(p_user) or p_test is null or p_default is null or p_schedule not in ('standard','relief') then raise exception 'INVALID_DRIVER'; end if;
 -- Do not convert an account while its current assignments would cross the test boundary.
 if exists(select 1 from atlas_driver_private.trips where driver_id=p_user and status not in ('complete','cancelled') and is_test<>p_test)
 or (p_test and exists(select 1 from atlas_pod_private.bindings where driver_id=p_user)) then raise exception 'ACTIVE_ASSIGNMENTS_REQUIRE_REVIEW'; end if;
 if p_default then update atlas_driver_private.accounts set is_default=false where is_default; end if;
 insert into atlas_driver_private.accounts(user_id,is_test,schedule_id,is_default,updated_by) values(p_user,p_test,p_schedule,p_default,auth.uid())
 on conflict(user_id) do update set is_test=excluded.is_test,schedule_id=excluded.schedule_id,is_default=excluded.is_default,updated_by=auth.uid(),updated_at=now();
 insert into atlas_driver_private.events(actor_id,is_test,event,detail) values(auth.uid(),p_test,'account_configured',jsonb_build_object('userId',p_user,'scheduleId',p_schedule,'default',p_default));
 return jsonb_build_object('userId',p_user,'testAccount',p_test);
end $$;

-- A projection is built on the server from saved allocations, never browser customer data.
create function public.atlas_driver_publish(p_day date,p_revision integer,p_trip integer) returns jsonb
language plpgsql security definer set search_path='' as $$
declare w uuid; d atlas_routing_preview_private.days; a jsonb; load jsonb; sh jsonb; o jsonb;
 t atlas_driver_private.trips; old_driver uuid; old_name text; old_vehicle text; n integer:=0;
begin
 if not atlas_driver_private.manager() then raise exception using errcode='42501',message='ADMIN_REQUIRED'; end if;
 select id into strict w from public.warehouses where code='CA' and active;
 select * into d from atlas_routing_preview_private.days where warehouse_id=w and planning_day=p_day for update;
 if d.revision is distinct from p_revision then raise exception using errcode='40001',message='SAVED_DAY_CHANGED'; end if;
 if p_trip is null or p_trip<0 or p_trip>199 or d.document->'schemaVersion'<>'4'::jsonb then raise exception 'REVIEW_ASSIGNMENT'; end if;
 load:=d.document->'lockedTrips'->p_trip; a:=d.document->'assignments'->p_trip::text;
 if load is null or a is null or a is distinct from load->'assignment' then raise exception 'SEND_TRIP_BEFORE_PUBLISHING'; end if;
 if not atlas_driver_private.active_ca((a->>'driverUserId')::uuid) or atlas_driver_private.test_account((a->>'driverUserId')::uuid) then raise exception 'INVALID_DRIVER'; end if;
 select * into t from atlas_driver_private.trips where warehouse_id=w and planning_day=p_day and trip_index=p_trip and not is_test for update;
 if t.id is not null then
  if t.driver_id<>(a->>'driverUserId')::uuid or t.vehicle_id<>a->>'vehicleId' then raise exception 'SENT_ASSIGNMENT_LOCKED'; end if;
  return jsonb_build_object('id',t.id,'version',t.version);
 end if;
 insert into atlas_driver_private.trips(warehouse_id,planning_day,trip_index,driver_id,driver_name,vehicle_id,schedule_id,source_revision,status,created_by)
 values(w,p_day,p_trip,(a->>'driverUserId')::uuid,a->>'driverName',a->>'vehicleId',coalesce(a->>'scheduleId','standard'),p_revision,'sent',auth.uid()) returning * into t;
 for sh in select value from jsonb_array_elements(load->'shipments') loop
  select value into strict o from jsonb_array_elements(d.document->'orders') where value->>'id'=sh->>'orderId';
  insert into atlas_driver_private.stops(trip_id,ordinal,order_id,is_test,detail) values(t.id,n,(sh->>'orderId')::uuid,false,
   jsonb_build_object('customer',o->>'customer','sales_order',o->>'orderNumber','address',o->>'address','timeWindow',o->>'timeWindow',
   'notes',o->>'notes','checkOnDelivery',o->'checkOnDelivery','source_shipment',sh,'podRequired',true,'recipientRequired',false,
   'shipment_number',(select count(*) from jsonb_array_elements(d.document->'lockedTrips') with ordinality x(v,i) where i<=p_trip+1 and exists(select 1 from jsonb_array_elements(v->'shipments') s where s->>'orderId'=sh->>'orderId')),
   'shipment_total',(select count(*) from jsonb_array_elements(d.document->'lockedTrips') x(v) where exists(select 1 from jsonb_array_elements(v->'shipments') s where s->>'orderId'=sh->>'orderId'))));
  if o->>'dispatchedOn' is null then raise exception 'COMPLETE_SHIPMENT_ALLOCATION_REQUIRED'; end if;
  n:=n+1;
 end loop;
 if n=0 then raise exception 'EMPTY_TRIP'; end if;
 insert into atlas_driver_private.events(trip_id,actor_id,is_test,event,detail) values(t.id,auth.uid(),false,'trip_published',a);
 return jsonb_build_object('id',t.id,'version',t.version);
end $$;

create function public.atlas_driver_my_trips(p_day date) returns jsonb
language plpgsql stable security definer set search_path='' as $$
begin
 if not atlas_driver_private.session_ok(auth.uid(),(auth.jwt()->>'session_id')::uuid) then raise exception using errcode='42501',message='DRIVER_ACCESS_DENIED'; end if;
 return jsonb_build_object('testAccount',atlas_driver_private.test_account(auth.uid()),'trips',coalesce((select jsonb_agg(jsonb_build_object(
 'id',t.id,'warehouseId',t.warehouse_id,'date',t.planning_day,'tripIndex',t.trip_index,'driverName',t.driver_name,'vehicleId',t.vehicle_id,'status',t.status,'version',t.version,'isTest',t.is_test,
 'stops',(select jsonb_agg(s.detail||jsonb_build_object('id',s.id,'status',s.status,'collectionAck',s.collection_ack,'recipient',s.recipient,'signatureConfirmed',s.signature_ack,'exception',s.exception,
 'submission',(select jsonb_build_object('id',r.id,'state',r.state,'received_at',r.received_at)||coalesce((select atlas_pod_private.email_summary(e) from atlas_pod_private.submissions e where e.id=r.id),jsonb_build_object('email_status','disabled')) from atlas_driver_private.receipts r where r.stop_id=s.id)) order by s.ordinal) from atlas_driver_private.stops s where s.trip_id=t.id)) order by t.trip_index)
 from atlas_driver_private.trips t where t.planning_day=p_day and atlas_driver_private.can_drive(t,auth.uid(),(auth.jwt()->>'session_id')::uuid)),'[]'::jsonb));
end $$;

create function public.atlas_driver_stop_action(p_stop uuid,p_version integer,p_action text,p_details jsonb default '{}') returns jsonb
language plpgsql security definer set search_path='' as $$
declare s atlas_driver_private.stops; t atlas_driver_private.trips;
begin
 select * into s from atlas_driver_private.stops where id=p_stop;
 select * into t from atlas_driver_private.trips where id=s.trip_id for update;
 if not coalesce(atlas_driver_private.can_drive(t,auth.uid(),(auth.jwt()->>'session_id')::uuid),false) then raise exception using errcode='42501',message='DRIVER_ACCESS_DENIED'; end if;
 if t.version is distinct from p_version then raise exception using errcode='40001',message='TRIP_CHANGED'; end if;
 if not t.is_test and t.status='assigned' then raise exception 'TRIP_NOT_SENT'; end if;
 if t.status='complete' or s.status in ('complete','exception') then raise exception 'STOP_ALREADY_RESOLVED'; end if;
 if jsonb_typeof(p_details) is distinct from 'object' or exists(select 1 from jsonb_object_keys(p_details) k where k not in ('recipient','collectionAck','signatureConfirmed','reason')) then raise exception 'INVALID_STOP_DETAILS'; end if;
 if p_action='arrived' then update atlas_driver_private.stops set status='arrived' where id=s.id;
 elsif p_action='complete' then
  if not exists(select 1 from atlas_driver_private.receipts where stop_id=s.id and state='received') then raise exception 'POD_REQUIRED'; end if;
  if coalesce((s.detail->>'checkOnDelivery')::boolean,false) and p_details->'collectionAck' is distinct from 'true'::jsonb then raise exception 'CHECK_COLLECTION_REQUIRED'; end if;
  if coalesce((s.detail->>'recipientRequired')::boolean,false) and nullif(trim(p_details->>'recipient'),'') is null then raise exception 'RECIPIENT_REQUIRED'; end if;
  if coalesce((s.detail->>'signatureRequired')::boolean,false) and p_details->'signatureConfirmed' is distinct from 'true'::jsonb then raise exception 'SIGNATURE_REQUIRED'; end if;
  if length(coalesce(p_details->>'recipient',''))>160 then raise exception 'INVALID_RECIPIENT'; end if;
  update atlas_driver_private.stops set status='complete',recipient=p_details->>'recipient',signature_ack=coalesce((p_details->>'signatureConfirmed')::boolean,false),collection_ack=coalesce((p_details->>'collectionAck')::boolean,false) where id=s.id;
 elsif p_action='exception' then
  if coalesce(p_details->>'reason','') not in ('Customer unavailable','Rejected','Unable to deliver','Other') then raise exception 'INVALID_EXCEPTION'; end if;
  update atlas_driver_private.stops set status='exception',exception=p_details->>'reason' where id=s.id;
 else raise exception 'INVALID_ACTION'; end if;
 insert into atlas_driver_private.events(trip_id,stop_id,actor_id,is_test,event,detail) values(t.id,s.id,auth.uid(),t.is_test,'stop_'||p_action,p_details);
 if not exists(select 1 from atlas_driver_private.stops where trip_id=t.id and status not in ('complete','exception')) then
  update atlas_driver_private.trips set status='complete' where id=t.id;
  insert into atlas_driver_private.events(trip_id,actor_id,is_test,event) values(t.id,auth.uid(),t.is_test,'trip_complete');
 end if;
 return jsonb_build_object('ok',true);
end $$;

create function public.atlas_driver_pod_context(p_stop uuid) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare s atlas_driver_private.stops; t atlas_driver_private.trips;
begin
 select * into s from atlas_driver_private.stops where id=p_stop;
 select * into t from atlas_driver_private.trips where id=s.trip_id;
 if not coalesce(atlas_driver_private.can_drive(t,auth.uid(),(auth.jwt()->>'session_id')::uuid),false) then raise exception using errcode='42501',message='DRIVER_ACCESS_DENIED'; end if;
 return s.detail||jsonb_build_object('id',s.id,'trip_id',t.id,'warehouse_id',t.warehouse_id,'is_test',t.is_test,'actor_id',auth.uid(),'session_id',(auth.jwt()->>'session_id')::uuid,
 'current',t.is_test or t.status in ('sent','complete'),'version',t.version,'document',(select jsonb_build_object('object_prefix',r.object_prefix,'filename',r.filename,'pdf_hash',r.pdf_hash) from atlas_driver_private.receipts r where r.stop_id=s.id and r.state='received'));
end $$;

create function public.atlas_driver_pod_receive(p_stop uuid,p_actor uuid,p_session uuid,p_version integer,p_submission uuid,p_manifest text,p_filename text,p_pages integer,p_pdf_hash text default null) returns jsonb
language plpgsql security definer set search_path='' as $$
declare s atlas_driver_private.stops; t atlas_driver_private.trips; r atlas_driver_private.receipts;
begin
 select * into s from atlas_driver_private.stops where id=p_stop;
 select * into t from atlas_driver_private.trips where id=s.trip_id for update;
 if not coalesce(atlas_driver_private.can_drive(t,p_actor,p_session),false) or t.version is distinct from p_version or s.status='exception' then raise exception using errcode='42501',message='DRIVER_ACCESS_DENIED'; end if;
 if not t.is_test and t.status='assigned' then raise exception 'TRIP_NOT_SENT'; end if;
 if p_filename !~ '^POD-SO-([0-9]+|TEST-[0-9]+)(-SHIPMENT-[0-9]+-OF-[0-9]+)?\.pdf$' or length(p_filename)>150 or (not t.is_test and p_filename like '%TEST%') then raise exception 'INVALID_FILENAME'; end if;
 select * into r from atlas_driver_private.receipts where stop_id=s.id;
 if r.id is not null and (r.id<>p_submission or r.actor_id<>p_actor or r.manifest_hash<>p_manifest or r.filename<>p_filename or r.page_count<>p_pages) then raise exception using errcode='40001',message='POD_RETRY_CHANGED'; end if;
 if r.id is null then
  insert into atlas_driver_private.receipts(id,stop_id,actor_id,is_test,manifest_hash,object_prefix,filename,page_count)
  values(p_submission,s.id,p_actor,t.is_test,p_manifest,(case when t.is_test then 'pod-test/' else 'pod/' end)||t.warehouse_id||'/'||t.id||'/'||s.id||'/'||p_submission,p_filename,p_pages) returning * into r;
  insert into atlas_driver_private.events(trip_id,stop_id,actor_id,is_test,event) values(t.id,s.id,p_actor,t.is_test,'pod_requested');
 end if;
 if p_pdf_hash is not null then
  if p_pdf_hash !~ '^[0-9a-f]{64}$' or (r.pdf_hash is not null and r.pdf_hash<>p_pdf_hash) then raise exception 'PDF_HASH_CONFLICT'; end if;
  if r.state<>'received' then
   update atlas_driver_private.receipts set state='received',pdf_hash=p_pdf_hash,received_at=now() where id=r.id returning * into r;
   insert into atlas_driver_private.events(trip_id,stop_id,actor_id,is_test,event) values(t.id,s.id,p_actor,t.is_test,'pod_finalized');
  end if;
 end if;
 return to_jsonb(r);
end $$;

-- Test trips never enter routing days, scanner queues, reminders or legacy email tables.
create function public.atlas_driver_seed_test(p_day date,p_driver uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare w uuid; t atlas_driver_private.trips; n integer;
begin
 if not atlas_driver_private.manager() then raise exception using errcode='42501',message='ADMIN_REQUIRED'; end if;
 if not atlas_driver_private.active_ca(p_driver) or not atlas_driver_private.test_account(p_driver) or p_day is null then raise exception 'TEST_ACCOUNT_REQUIRED'; end if;
 select id into strict w from public.warehouses where code='CA' and active;
 insert into atlas_driver_private.trips(warehouse_id,planning_day,trip_index,is_test,driver_id,driver_name,vehicle_id,schedule_id,source_revision,created_by)
 values(w,p_day,0,true,p_driver,(select display_name from public.profiles where user_id=p_driver),'box_truck','standard',0,auth.uid()) returning * into t;
 for n in 1..3 loop
  insert into atlas_driver_private.stops(trip_id,ordinal,order_id,is_test,detail) values(t.id,n-1,gen_random_uuid(),true,
  jsonb_build_object('customer','ATLAS TEST CUSTOMER '||n||' — DO NOT DELIVER','sales_order','SO-TEST-000'||n,'address','123 TEST STREET, FULLERTON, CA',
   'timeWindow','8:00 AM–2:00 PM','notes','TEST MODE — Do not load or deliver.','checkOnDelivery',n=2,'podRequired',true,'recipientRequired',n=1,'signatureRequired',n=1,
   'shipment_number',1,'shipment_total',1,'source_shipment',jsonb_build_object('palletSpaces',case when n=1 then 2 when n=2 then 1 else 0 end,'boxAllocation',jsonb_build_array(jsonb_build_object('sku','TEST-SKU','boxes',n*2)))));
 end loop;
 insert into atlas_driver_private.events(trip_id,actor_id,is_test,event) values(t.id,auth.uid(),true,'test_trip_created');
 return jsonb_build_object('id',t.id,'version',t.version);
end $$;

create function public.atlas_driver_reassign(p_trip uuid,p_version integer,p_driver uuid,p_vehicle text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare t atlas_driver_private.trips; a atlas_driver_private.accounts; new_name text;
begin
 if not atlas_driver_private.manager() then raise exception using errcode='42501',message='ADMIN_REQUIRED'; end if;
 select * into t from atlas_driver_private.trips where id=p_trip for update;
 if t.version is distinct from p_version then raise exception using errcode='40001',message='TRIP_CHANGED'; end if;
 if not t.is_test then raise exception 'EDIT_SAVED_TRIP_ASSIGNMENT'; end if;
 if t.status<>'assigned' or exists(select 1 from atlas_driver_private.stops where trip_id=t.id and status<>'pending') or exists(select 1 from atlas_driver_private.receipts r join atlas_driver_private.stops s on s.id=r.stop_id where s.trip_id=t.id) then raise exception 'SENT_ASSIGNMENT_LOCKED'; end if;
 if not atlas_driver_private.active_ca(p_driver) or atlas_driver_private.test_account(p_driver)<>t.is_test or p_vehicle not in ('box_truck','van_1','van_2') then raise exception 'INVALID_DRIVER'; end if;
 select display_name into strict new_name from public.profiles where user_id=p_driver;
 update atlas_driver_private.trips set driver_id=p_driver,driver_name=new_name,vehicle_id=p_vehicle,version=version+1 where id=t.id;
 insert into atlas_driver_private.events(trip_id,actor_id,is_test,event,detail) values(t.id,auth.uid(),t.is_test,'driver_reassigned',jsonb_build_object('previousDriverId',t.driver_id,'previousDriverName',t.driver_name,'driverUserId',p_driver,'driverName',new_name,'previousVehicle',t.vehicle_id,'vehicleId',p_vehicle));
 return jsonb_build_object('id',t.id,'version',t.version+1);
end $$;

revoke all on all functions in schema atlas_driver_private from public,anon,authenticated;
revoke all on function public.atlas_driver_candidates(boolean),public.atlas_driver_configure_account(uuid,boolean,text,boolean),public.atlas_driver_publish(date,integer,integer),public.atlas_driver_my_trips(date),public.atlas_driver_stop_action(uuid,integer,text,jsonb),public.atlas_driver_pod_context(uuid),public.atlas_driver_seed_test(date,uuid),public.atlas_driver_reassign(uuid,integer,uuid,text) from public,anon;
grant execute on function public.atlas_driver_candidates(boolean),public.atlas_driver_configure_account(uuid,boolean,text,boolean),public.atlas_driver_publish(date,integer,integer),public.atlas_driver_my_trips(date),public.atlas_driver_stop_action(uuid,integer,text,jsonb),public.atlas_driver_pod_context(uuid),public.atlas_driver_seed_test(date,uuid),public.atlas_driver_reassign(uuid,integer,uuid,text) to authenticated;
revoke all on function public.atlas_driver_pod_receive(uuid,uuid,uuid,integer,uuid,text,text,integer,text) from public,anon,authenticated;
grant execute on function public.atlas_driver_pod_receive(uuid,uuid,uuid,integer,uuid,text,text,integer,text) to service_role;


-- Source: tools/routing-preview/dynamic-assignment-draft.sql
-- LOCAL PROTOTYPE ONLY. Run after dynamic-driver-draft.sql and next-load-priority-draft.sql.

do $$ begin
 execute replace(pg_get_functiondef('atlas_routing_preview_private.valid_document(jsonb,date)'::regprocedure),
  'FUNCTION atlas_routing_preview_private.valid_document(', 'FUNCTION atlas_routing_preview_private.valid_document_before_driver(');
 execute replace(pg_get_functiondef('atlas_routing_preview_private.can_access(boolean)'::regprocedure),
  'FUNCTION atlas_routing_preview_private.can_access(', 'FUNCTION atlas_routing_preview_private.can_access_before_driver(');
 execute replace(pg_get_functiondef('atlas_pod_private.access(uuid,uuid,uuid)'::regprocedure),
  'FUNCTION atlas_pod_private.access(', 'FUNCTION atlas_pod_private.access_before_driver(');
end $$;
revoke all on function atlas_routing_preview_private.valid_document_before_driver(jsonb,date),atlas_routing_preview_private.can_access_before_driver(boolean),atlas_pod_private.access_before_driver(uuid,uuid,uuid) from public,anon,authenticated;

create or replace function atlas_routing_preview_private.can_access(p_write boolean) returns boolean
language sql stable security definer set search_path='' as $$select not atlas_driver_private.test_account(auth.uid()) and atlas_routing_preview_private.can_access_before_driver(p_write)$$;
create or replace function atlas_pod_private.access(p_user uuid,p_session uuid,p_warehouse uuid) returns text
language sql stable security definer set search_path='' as $$select case when not atlas_driver_private.test_account(p_user) then atlas_pod_private.access_before_driver(p_user,p_session,p_warehouse) end$$;

create function atlas_driver_private.valid_assignment(a jsonb) returns boolean
language sql immutable set search_path='' as $$select coalesce(jsonb_typeof(a)='object'
 and not exists(select 1 from jsonb_object_keys(a) k where k not in ('driverUserId','driverName','vehicleId','scheduleId'))
 and a->>'driverUserId' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
 and jsonb_typeof(a->'driverName')='string' and length(trim(a->>'driverName')) between 1 and 160
 and a->>'vehicleId' in ('box_truck','van_1','van_2') and coalesce(a->>'scheduleId','standard') in ('standard','relief'),false)$$;

create or replace function atlas_routing_preview_private.valid_document(j jsonb,p_day date) returns boolean
language plpgsql immutable set search_path='' as $$
declare legacy jsonb; k text; a jsonb; v text; i integer:=0; t jsonb;
begin
 if j->'schemaVersion' is distinct from '4'::jsonb then return atlas_routing_preview_private.valid_document_before_driver(j,p_day); end if;
 legacy:=jsonb_set(j,'{schemaVersion}','3'::jsonb);
 for k,a in select key,value from jsonb_each(j->'assignments') loop
  if not atlas_driver_private.valid_assignment(a) then return false; end if;
  -- Reuse unchanged v3 order/catalog/quantity validation. Identity is checked separately.
  v:='Bubba:'||case a->>'vehicleId' when 'box_truck' then 'truck' when 'van_1' then 'van1' else 'van2' end;
  legacy:=jsonb_set(legacy,array['assignments',k],to_jsonb(v));
 end loop;
 for t in select value from jsonb_array_elements(j->'lockedTrips') loop
  a:=t->'assignment';
  if not atlas_driver_private.valid_assignment(a) or a is distinct from j->'assignments'->i::text then return false; end if;
  legacy:=jsonb_set(legacy,array['lockedTrips',i::text,'assignment'],legacy->'assignments'->i::text); i:=i+1;
 end loop;
 return atlas_routing_preview_private.valid_document_before_driver(legacy,p_day);
exception when others then return false;
end $$;

create function atlas_driver_private.protect_day() returns trigger
language plpgsql security definer set search_path='' as $$
declare k text; a jsonb; t jsonb; old_trip jsonb; old_assignment text; i integer; locked integer; matches integer;
begin
 if new.document->'schemaVersion' is distinct from '4'::jsonb then
  if tg_op='UPDATE' and old.document->'schemaVersion'='4'::jsonb then raise exception 'ROUTING_CLIENT_UPDATE_REQUIRED'; end if;
  return new;
 end if;
 if not atlas_routing_preview_private.valid_document(new.document,new.planning_day) then raise exception 'INVALID_ROUTING_DOCUMENT'; end if;
 locked:=jsonb_array_length(new.document->'lockedTrips');
 for k,a in select key,value from jsonb_each(new.document->'assignments') loop
  if k::integer>=locked or tg_op='INSERT' or k::integer>=jsonb_array_length(coalesce(old.document->'lockedTrips','[]')) then
   if not atlas_driver_private.active_ca((a->>'driverUserId')::uuid) or atlas_driver_private.test_account((a->>'driverUserId')::uuid)
    or not exists(select 1 from public.profiles where user_id=(a->>'driverUserId')::uuid and display_name=a->>'driverName') then raise exception 'INVALID_DRIVER'; end if;
  end if;
 end loop;
 for i in 0..locked-1 loop
  t:=new.document->'lockedTrips'->i;
  if (t->>'sentOn')::date>(now() at time zone 'America/Los_Angeles')::date then raise exception 'FUTURE_ROUTING_DISPATCH'; end if;
  if tg_op='UPDATE' and i<jsonb_array_length(coalesce(old.document->'lockedTrips','[]')) then
   old_trip:=old.document->'lockedTrips'->i;
   if old.document->'schemaVersion'='4'::jsonb then
    if old_trip is distinct from t then raise exception 'SENT_ASSIGNMENT_LOCKED'; end if;
   else
    old_assignment:=old_trip->>'assignment'; a:=t->'assignment';
    select count(*) into matches from public.profiles p where lower(trim(p.display_name))=lower(split_part(old_assignment,':',1)) and atlas_driver_private.active_ca(p.user_id) and not atlas_driver_private.test_account(p.user_id);
    if matches<>1 or (old_trip-'assignment') is distinct from (t-'assignment')
     or lower(a->>'driverName')<>lower(split_part(old_assignment,':',1))
     or (a->>'vehicleId')<>(case split_part(old_assignment,':',2) when 'truck' then 'box_truck' when 'van1' then 'van_1' else 'van_2' end)
     or not exists(select 1 from public.profiles where user_id=(a->>'driverUserId')::uuid and lower(trim(display_name))=lower(split_part(old_assignment,':',1))) then raise exception 'LEGACY_ASSIGNMENT_REVIEW_REQUIRED'; end if;
   end if;
  end if;
 end loop;
 if tg_op='UPDATE' then
  if jsonb_array_length(coalesce(old.document->'lockedTrips','[]'))>locked+1 then raise exception 'REOPEN_LATEST_TRIP_ONLY'; end if;
  -- Published delivery projections must be explicitly cancelled before corrections.
  if exists(select 1 from atlas_driver_private.trips t where t.warehouse_id=new.warehouse_id and t.planning_day=new.planning_day and not t.is_test and t.status in ('sent','complete') and t.trip_index>=locked) then raise exception 'PUBLISHED_TRIP_REQUIRES_REVIEW'; end if;
  if old.document->'assignments' is distinct from new.document->'assignments' then
   insert into atlas_driver_private.events(actor_id,is_test,event,detail) values(auth.uid(),false,'planning_assignments_changed',jsonb_build_object('day',new.planning_day,'before',old.document->'assignments','after',new.document->'assignments'));
  end if;
 end if;
 return new;
end $$;
create trigger protect_driver_day before insert or update of document on atlas_routing_preview_private.days for each row execute function atlas_driver_private.protect_day();
revoke all on function atlas_driver_private.valid_assignment(jsonb),atlas_driver_private.protect_day() from public,anon,authenticated;
-- Preserve the scanner's optimistic save path while admitting v4 days.
-- Refuse unexpected deployed function text instead of guessing through drift.
do $$
declare source text;
begin
 source:=pg_get_functiondef('public.atlas_routing_scanner_upload(text,date,jsonb,jsonb,jsonb)'::regprocedure);
 if strpos(source,'doc->''schemaVersion'' is distinct from ''3''::jsonb')=0
 or strpos(source,'p_seed->''schemaVersion'' is distinct from ''3''::jsonb')=0 then raise exception 'SCANNER_SOURCE_REVIEW_REQUIRED'; end if;
 source:=replace(source,'doc->''schemaVersion'' is distinct from ''3''::jsonb','coalesce(doc->''schemaVersion'' not in (''3''::jsonb,''4''::jsonb),true)');
 source:=replace(source,'p_seed->''schemaVersion'' is distinct from ''3''::jsonb','coalesce(p_seed->''schemaVersion'' not in (''3''::jsonb,''4''::jsonb),true)');
 execute source;
end $$;


-- Source: tools/delivery-pod/dynamic-driver-workflow-draft.sql
-- Local additive driver workflow completion; requires the two dynamic driver drafts.

create function public.atlas_driver_publish_ready(p_day date,p_revision integer,p_trip integer,p_shipments jsonb,p_plan jsonb default null) returns jsonb
language plpgsql security definer set search_path='' as $$
declare d atlas_routing_preview_private.days; w uuid; a jsonb; sh jsonb; o jsonb; t atlas_driver_private.trips; n integer:=0; previous jsonb; entry jsonb; ln jsonb;
begin
 if not atlas_driver_private.manager() then raise exception using errcode='42501',message='ADMIN_REQUIRED'; end if;
 select id into strict w from public.warehouses where code='CA' and active;
 select * into d from atlas_routing_preview_private.days where warehouse_id=w and planning_day=p_day for update;
 if d.revision is distinct from p_revision then raise exception using errcode='40001',message='SAVED_DAY_CHANGED'; end if;
 a:=d.document->'assignments'->p_trip::text;
 if d.document->'schemaVersion' is distinct from '4'::jsonb or not coalesce(atlas_driver_private.valid_assignment(a),false)
 or p_trip>199 or p_trip<0 then raise exception 'REVIEW_ASSIGNMENT'; end if;
 if not atlas_driver_private.active_ca((a->>'driverUserId')::uuid) or atlas_driver_private.test_account((a->>'driverUserId')::uuid) then raise exception 'INVALID_DRIVER'; end if;
 if jsonb_typeof(p_shipments) is distinct from 'array' or jsonb_array_length(p_shipments) not between 1 and 20 then raise exception 'INVALID_SHIPMENTS'; end if;
 if p_plan is not null then
  if jsonb_typeof(p_plan) is distinct from 'array' or jsonb_array_length(p_plan) not between 1 and 200 or p_plan->p_trip is distinct from p_shipments then raise exception 'INVALID_PLAN'; end if;
  for entry in select value from jsonb_array_elements(p_plan) loop
   if jsonb_typeof(entry) is distinct from 'array' or jsonb_array_length(entry) not between 1 and 20 then raise exception 'INVALID_PLAN'; end if;
   if (select count(distinct x->>'orderId') from jsonb_array_elements(entry) x)<>jsonb_array_length(entry) then raise exception 'DUPLICATE_SHIPMENT'; end if;
   for sh in select value from jsonb_array_elements(entry) loop
    if not atlas_routing_preview_private.exact_keys(sh,array['orderId','palletSpaces','boxAllocation']) or not atlas_routing_preview_private.integer_between(sh->'palletSpaces',1,100000) or jsonb_typeof(sh->'boxAllocation') is distinct from 'array' then raise exception 'INVALID_SHIPMENT'; end if;
    select value into o from jsonb_array_elements(d.document->'orders') where value->>'id'=sh->>'orderId';
    if o is null then raise exception 'UNKNOWN_ORDER'; end if;
    if (select count(distinct x->>'sku') from jsonb_array_elements(sh->'boxAllocation') x)<>jsonb_array_length(sh->'boxAllocation') then raise exception 'DUPLICATE_SKU'; end if;
    for ln in select value from jsonb_array_elements(sh->'boxAllocation') loop
     if not atlas_routing_preview_private.exact_keys(ln,array['sku','boxes']) or not atlas_routing_preview_private.integer_between(ln->'boxes',1,100000000) or not exists(select 1 from jsonb_array_elements(o->'lines') l where l->>'sku'=ln->>'sku') then raise exception 'INVALID_BOX_ALLOCATION'; end if;
    end loop;
   end loop;
  end loop;
  for o in select ord.value from jsonb_array_elements(d.document->'orders') ord where exists(select 1 from jsonb_array_elements(p_plan) x cross join lateral jsonb_array_elements(x) y where y->>'orderId'=ord.value->>'id') loop
   for ln in select value from jsonb_array_elements(o->'lines') loop
    if (select coalesce(sum((b->>'boxes')::numeric),0) from jsonb_array_elements(p_plan) x cross join lateral jsonb_array_elements(x) y cross join lateral jsonb_array_elements(y->'boxAllocation') b where y->>'orderId'=o->>'id' and b->>'sku'=ln->>'sku')<>(ln->>'caseQty')::numeric then raise exception 'INCOMPLETE_BOX_ALLOCATION'; end if;
   end loop;
  end loop;
  if exists(select 1 from jsonb_array_elements(d.document->'lockedTrips') with ordinality x(v,i) where v->'shipments' is distinct from p_plan->(i-1)::int) then raise exception 'SENT_PLAN_CHANGED'; end if;
 end if;
 select * into t from atlas_driver_private.trips where warehouse_id=w and planning_day=p_day and trip_index=p_trip and not is_test for update;
 if t.id is not null and t.status in ('sent','complete') then
  if t.driver_id<>(a->>'driverUserId')::uuid or t.vehicle_id<>a->>'vehicleId' or (select jsonb_agg(detail->'source_shipment' order by ordinal) from atlas_driver_private.stops where trip_id=t.id) is distinct from p_shipments then raise exception 'SENT_ASSIGNMENT_LOCKED'; end if;
  return jsonb_build_object('id',t.id,'version',t.version);
 end if;
 if t.id is not null then
  if t.status not in ('assigned','cancelled') or exists(select 1 from atlas_driver_private.stops s where s.trip_id=t.id and s.status<>'pending') or exists(select 1 from atlas_driver_private.receipts r join atlas_driver_private.stops s on s.id=r.stop_id where s.trip_id=t.id) then raise exception 'TRIP_ACTIVITY_REQUIRES_REVIEW'; end if;
  previous:=jsonb_build_object('driverUserId',t.driver_id,'driverName',t.driver_name,'vehicleId',t.vehicle_id);
  delete from atlas_driver_private.stops where trip_id=t.id;
  update atlas_driver_private.trips set status='assigned',driver_id=(a->>'driverUserId')::uuid,driver_name=a->>'driverName',vehicle_id=a->>'vehicleId',schedule_id=coalesce(a->>'scheduleId','standard'),source_revision=p_revision,version=version+1 where id=t.id returning * into t;
 else
  insert into atlas_driver_private.trips(warehouse_id,planning_day,trip_index,driver_id,driver_name,vehicle_id,schedule_id,source_revision,created_by)
  values(w,p_day,p_trip,(a->>'driverUserId')::uuid,a->>'driverName',a->>'vehicleId',coalesce(a->>'scheduleId','standard'),p_revision,auth.uid()) returning * into t;
 end if;
 for sh in select value from jsonb_array_elements(p_shipments) loop
  if not atlas_routing_preview_private.exact_keys(sh,array['orderId','palletSpaces','boxAllocation']) or not atlas_routing_preview_private.integer_between(sh->'palletSpaces',1,100000) then raise exception 'INVALID_SHIPMENT'; end if;
  select value into o from jsonb_array_elements(d.document->'orders') where value->>'id'=sh->>'orderId';
  if o is null or ((nullif(o->>'dispatchedOn','') is not null or nullif(o->>'deliveredOn','') is not null) and p_trip>=jsonb_array_length(d.document->'lockedTrips')) then raise exception 'ORDER_ALREADY_SENT'; end if;
  -- Before departure, publish only a complete order allocation. Split shipments use the locked allocation path.
  if p_plan is null and (jsonb_typeof(sh->'boxAllocation') is distinct from 'array' or jsonb_array_length(sh->'boxAllocation')<>jsonb_array_length(o->'lines') or
   exists(select 1 from jsonb_array_elements(o->'lines') l where (select count(*) from jsonb_array_elements(sh->'boxAllocation') b where b->>'sku'=l->>'sku' and b->'boxes'=l->'caseQty' and atlas_routing_preview_private.exact_keys(b,array['sku','boxes']))<>1) ) then raise exception 'SPLIT_ALLOCATION_REQUIRES_SENT_PLAN'; end if;
  if exists(select 1 from atlas_driver_private.stops s join atlas_driver_private.trips x on x.id=s.trip_id where x.id<>t.id and x.warehouse_id=w and x.planning_day=p_day and not x.is_test and x.status<>'cancelled' and s.order_id=(o->>'id')::uuid and (p_plan is null or not exists(select 1 from jsonb_array_elements(p_plan->x.trip_index) z where z=s.detail->'source_shipment'))) then raise exception 'ORDER_ALREADY_ASSIGNED'; end if;
  insert into atlas_driver_private.stops(trip_id,ordinal,order_id,is_test,detail) values(t.id,n,(o->>'id')::uuid,false,
   jsonb_build_object('customer',o->>'customer','sales_order',o->>'orderNumber','address',o->>'address','timeWindow',o->>'timeWindow','notes',o->>'notes','checkOnDelivery',o->'checkOnDelivery','source_shipment',sh,'podRequired',true,'recipientRequired',false,'shipment_number',case when p_plan is null then 1 else (select count(*) from jsonb_array_elements(p_plan) with ordinality x(v,i) where i<=p_trip+1 and exists(select 1 from jsonb_array_elements(v) z where z->>'orderId'=o->>'id')) end,'shipment_total',case when p_plan is null then 1 else (select count(*) from jsonb_array_elements(p_plan) x where exists(select 1 from jsonb_array_elements(x) z where z->>'orderId'=o->>'id')) end));n:=n+1;
 end loop;
 if p_trip<jsonb_array_length(d.document->'lockedTrips') then update atlas_driver_private.trips set status='sent' where id=t.id; end if;
 if (select count(distinct order_id) from atlas_driver_private.stops where trip_id=t.id)<>n then raise exception 'DUPLICATE_SHIPMENT'; end if;
 insert into atlas_driver_private.events(trip_id,actor_id,is_test,event,detail) values(t.id,auth.uid(),false,'trip_published',jsonb_build_object('previous',previous,'assignment',a));
 return jsonb_build_object('id',t.id,'version',t.version);
end $$;

create function public.atlas_driver_open_trip(p_trip uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare t atlas_driver_private.trips; result jsonb;
begin
 select * into t from atlas_driver_private.trips where id=p_trip;
 if not coalesce(atlas_driver_private.can_drive(t,auth.uid(),(auth.jwt()->>'session_id')::uuid),false) then raise exception using errcode='42501',message='DRIVER_ACCESS_DENIED'; end if;
 insert into atlas_driver_private.events(trip_id,actor_id,is_test,event) values(t.id,auth.uid(),t.is_test,'trip_opened');
 select value into result from jsonb_array_elements(public.atlas_driver_my_trips(t.planning_day)->'trips') where value->>'id'=t.id::text;
 return result;
end $$;

create function public.atlas_driver_admin_trips(p_day date,p_test boolean default false) returns jsonb language plpgsql stable security definer set search_path='' as $$
begin
 if not atlas_driver_private.manager() then raise exception using errcode='42501',message='ADMIN_REQUIRED'; end if;
 return jsonb_build_object('trips',coalesce((select jsonb_agg(to_jsonb(t)||jsonb_build_object('stops',(select jsonb_agg(s.detail||jsonb_build_object('id',s.id,'status',s.status,'recipient',s.recipient,'exception',s.exception,'submission',(select to_jsonb(r)-'manifest_hash' from atlas_driver_private.receipts r where r.stop_id=s.id)) order by s.ordinal) from atlas_driver_private.stops s where s.trip_id=t.id),'events',(select jsonb_agg(to_jsonb(e) order by e.at) from atlas_driver_private.events e where e.trip_id=t.id)) order by t.trip_index) from atlas_driver_private.trips t join public.warehouses w on w.id=t.warehouse_id and w.code='CA' where t.planning_day=p_day and t.is_test=p_test),'[]'::jsonb));
end $$;

-- No data is erased by cancellation. Historical attribution and PODs remain immutable.
create function public.atlas_driver_cancel(p_trip uuid,p_version integer,p_reason text) returns jsonb language plpgsql security definer set search_path='' as $$
declare t atlas_driver_private.trips;
begin
 if not atlas_driver_private.manager() then raise exception using errcode='42501',message='ADMIN_REQUIRED'; end if;
 select * into t from atlas_driver_private.trips where id=p_trip for update;
 if t.version is distinct from p_version or nullif(trim(p_reason),'') is null or length(p_reason)>300 then raise exception 'REVIEW_CANCELLATION'; end if;
 if exists(select 1 from atlas_driver_private.receipts r join atlas_driver_private.stops s on s.id=r.stop_id where s.trip_id=t.id) or exists(select 1 from atlas_driver_private.stops where trip_id=t.id and status<>'pending') then raise exception 'TRIP_ACTIVITY_REQUIRES_REVIEW'; end if;
 update atlas_driver_private.trips set status='cancelled',version=version+1 where id=t.id;
 insert into atlas_driver_private.events(trip_id,actor_id,is_test,event,detail) values(t.id,auth.uid(),t.is_test,'assignment_removed',jsonb_build_object('driverUserId',t.driver_id,'driverName',t.driver_name,'reason',p_reason));
 return jsonb_build_object('id',t.id,'version',t.version+1);
end $$;
revoke all on function public.atlas_driver_publish_ready(date,integer,integer,jsonb,jsonb),public.atlas_driver_open_trip(uuid),public.atlas_driver_admin_trips(date,boolean),public.atlas_driver_cancel(uuid,integer,text) from public,anon;
grant execute on function public.atlas_driver_publish_ready(date,integer,integer,jsonb,jsonb),public.atlas_driver_open_trip(uuid),public.atlas_driver_admin_trips(date,boolean),public.atlas_driver_cancel(uuid,integer,text) to authenticated;

create function atlas_driver_private.sync_projection() returns trigger language plpgsql security definer set search_path='' as $$
declare t atlas_driver_private.trips; sh jsonb; lock jsonb;
begin
 if old.document is not distinct from new.document then return new; end if;
 for t in select * from atlas_driver_private.trips where warehouse_id=new.warehouse_id and planning_day=new.planning_day and not is_test and status='assigned' for update loop
  lock:=new.document->'lockedTrips'->t.trip_index;
  select jsonb_agg(detail->'source_shipment' order by ordinal) into sh from atlas_driver_private.stops where trip_id=t.id;
  if lock is not null and lock->'shipments'=sh and lock->'assignment'->>'driverUserId'=t.driver_id::text and lock->'assignment'->>'vehicleId'=t.vehicle_id then
   update atlas_driver_private.trips set status='sent',source_revision=new.revision where id=t.id;
   insert into atlas_driver_private.events(trip_id,actor_id,is_test,event) values(t.id,auth.uid(),false,'trip_sent');
  else
   if exists(select 1 from atlas_driver_private.receipts r join atlas_driver_private.stops s on s.id=r.stop_id where s.trip_id=t.id) or exists(select 1 from atlas_driver_private.stops where trip_id=t.id and status<>'pending') then raise exception 'TRIP_ACTIVITY_REQUIRES_REVIEW'; end if;
   update atlas_driver_private.trips set status='cancelled',version=version+1 where id=t.id;
   insert into atlas_driver_private.events(trip_id,actor_id,is_test,event,detail) values(t.id,auth.uid(),false,'assignment_removed',jsonb_build_object('reason','Saved plan changed; publish the reviewed trip again.','driverUserId',t.driver_id));
  end if;
 end loop;return new;
end $$;
create trigger sync_driver_projection after update of document on atlas_routing_preview_private.days for each row execute function atlas_driver_private.sync_projection();
revoke all on function atlas_driver_private.sync_projection() from public,anon,authenticated;
-- Normal finalized PODs use the existing office receiver/email pipeline; test PODs never enter it.
create function atlas_driver_private.mirror_receipt() returns trigger language plpgsql security definer set search_path='' as $$
declare s atlas_driver_private.stops; t atlas_driver_private.trips; d atlas_routing_preview_private.days;
begin
 if new.is_test or new.state<>'received' then return new; end if;
 select * into strict s from atlas_driver_private.stops where id=new.stop_id;
 select * into strict t from atlas_driver_private.trips where id=s.trip_id;
 select * into strict d from atlas_routing_preview_private.days where warehouse_id=t.warehouse_id and planning_day=t.planning_day;
 if t.is_test or t.status not in ('sent','complete') then raise exception 'TRIP_NOT_SENT'; end if;
 insert into atlas_pod_private.bindings(id,warehouse_id,planning_day,order_id,trip_index,source_revision,source_shipment,source_assignment,driver_id,customer,sales_order,address,shipment_number,shipment_total,created_by)
 values(s.id,t.warehouse_id,t.planning_day,s.order_id,t.trip_index,t.source_revision,s.detail->'source_shipment',(d.document->'lockedTrips'->t.trip_index->'assignment')::text,t.driver_id,s.detail->>'customer',s.detail->>'sales_order',s.detail->>'address',(s.detail->>'shipment_number')::int,(s.detail->>'shipment_total')::int,t.created_by) on conflict(id) do nothing;
 insert into atlas_pod_private.submissions(id,binding_id,actor_id,manifest_hash,state,object_prefix,filename,pdf_hash,page_count,received_at)
 values(new.id,s.id,new.actor_id,new.manifest_hash,new.state,new.object_prefix,new.filename,new.pdf_hash,new.page_count,new.received_at) on conflict(id) do nothing;
 return new;
end $$;
create trigger mirror_driver_receipt after insert or update of state on atlas_driver_private.receipts for each row execute function atlas_driver_private.mirror_receipt();
revoke all on function atlas_driver_private.mirror_receipt() from public,anon,authenticated;
create or replace function atlas_pod_private.access(p_user uuid,p_session uuid,p_warehouse uuid) returns text
language sql stable security definer set search_path='' as $$
 select case when not atlas_driver_private.test_account(p_user) then coalesce(atlas_pod_private.access_before_driver(p_user,p_session,p_warehouse),
 (select 'driver'::text where exists(select 1 from atlas_driver_private.trips t where t.warehouse_id=p_warehouse and not t.is_test and atlas_driver_private.can_drive(t,p_user,p_session)))) end
$$;

-- Cleanup has a review/freeze phase. Only exact server-generated test paths may be removed.
create function public.atlas_driver_cleanup_prepare(p_trip uuid,p_version integer,p_freeze boolean default false) returns jsonb language plpgsql security definer set search_path='' as $$
declare t atlas_driver_private.trips; r atlas_driver_private.receipts; files jsonb:='[]'; n integer; ready boolean;
begin
 if not atlas_driver_private.manager() then raise exception using errcode='42501',message='ADMIN_REQUIRED'; end if;
 select * into t from atlas_driver_private.trips where id=p_trip for update;
 if t.id is null or not t.is_test or t.version<>p_version then raise exception 'TEST_TRIP_REQUIRED'; end if;
 if p_freeze and t.status<>'cancelled' then
  update atlas_driver_private.trips set status='cancelled',version=version+1 where id=t.id returning * into t;
  insert into atlas_driver_private.events(trip_id,actor_id,is_test,event) values(t.id,auth.uid(),true,'cleanup_frozen');
 end if;
 ready:=t.status='cancelled' and not exists(select 1 from atlas_driver_private.events where trip_id=t.id and at>now()-interval '2 minutes');
 for r in select receipt.* from atlas_driver_private.receipts receipt join atlas_driver_private.stops s on s.id=receipt.stop_id where s.trip_id=t.id loop
  if not r.is_test or r.object_prefix<>'pod-test/'||t.warehouse_id||'/'||t.id||'/'||r.stop_id||'/'||r.id then raise exception 'TEST_PATH_REQUIRED'; end if;
  for n in 1..r.page_count loop
   files:=files||jsonb_build_array(jsonb_build_object('bucket','atlas-pod-originals','path',r.object_prefix||'/original-'||n||'.jpg'),jsonb_build_object('bucket','atlas-pod-originals','path',r.object_prefix||'/original-'||n||'.png'),jsonb_build_object('bucket','atlas-pod-originals','path',r.object_prefix||'/processed-'||n||'.jpg'));
  end loop;
  files:=files||jsonb_build_array(jsonb_build_object('bucket','atlas-pod-documents','path',r.object_prefix||'/document.pdf'));
 end loop;
 return jsonb_build_object('id',t.id,'version',t.version,'ready',ready,'actor',auth.uid(),'session',(auth.jwt()->>'session_id')::uuid,'files',files,'stops',(select count(*) from atlas_driver_private.stops where trip_id=t.id));
end $$;
create function public.atlas_driver_cleanup_finish(p_trip uuid,p_version integer,p_actor uuid,p_session uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare t atlas_driver_private.trips;
begin
 if not atlas_driver_private.session_ok(p_actor,p_session) or not atlas_pod_private.is_admin(p_actor) then raise exception using errcode='42501',message='ADMIN_REQUIRED'; end if;
 select * into t from atlas_driver_private.trips where id=p_trip for update;
 if t.id is null or not t.is_test or t.version<>p_version or t.status<>'cancelled' or exists(select 1 from atlas_driver_private.events where trip_id=t.id and at>now()-interval '2 minutes') then raise exception 'TEST_CLEANUP_NOT_READY'; end if;
 delete from atlas_driver_private.receipts where stop_id in(select id from atlas_driver_private.stops where trip_id=t.id) and is_test;
 delete from atlas_driver_private.events where trip_id=t.id and is_test;
 delete from atlas_driver_private.stops where trip_id=t.id and is_test;
 delete from atlas_driver_private.trips where id=t.id and is_test;
 insert into atlas_driver_private.events(actor_id,is_test,event,detail) values(p_actor,true,'test_data_cleaned',jsonb_build_object('tripId',t.id,'driverUserId',t.driver_id));
 return jsonb_build_object('deleted',true);
end $$;
revoke all on function public.atlas_driver_cleanup_prepare(uuid,integer,boolean),public.atlas_driver_cleanup_finish(uuid,integer,uuid,uuid) from public,anon,authenticated;
grant execute on function public.atlas_driver_cleanup_prepare(uuid,integer,boolean) to authenticated;
grant execute on function public.atlas_driver_cleanup_finish(uuid,integer,uuid,uuid) to service_role;

commit;
