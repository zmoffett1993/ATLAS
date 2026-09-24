-- LOCAL PROTOTYPE ONLY. Run after dynamic-driver-draft.sql and next-load-priority-draft.sql.
begin;
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
commit;
