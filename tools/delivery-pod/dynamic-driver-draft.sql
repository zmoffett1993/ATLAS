-- LOCAL PROTOTYPE ONLY. Not a generated migration and not approved for activation.
-- Requires the existing POD driver-access and next-load priority sources.
begin;
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
commit;
