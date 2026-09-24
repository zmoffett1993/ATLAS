-- Local additive driver workflow completion; requires the two dynamic driver drafts.
begin;
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
