-- ATLAS inventory integrity upgrade
-- Run this file once in Supabase SQL Editor. It is safe to re-run.
-- Internal location codes remain: 22 = Overflow and 23 = Samples Rack.

create or replace function public.atlas_normalize_warehouse_section(
  p_aisle integer,
  p_section text
)
returns text
language plpgsql
immutable
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_section text := upper(btrim(coalesce(p_section, '')));
begin
  if p_aisle = 22 then
    v_section := case v_section
      when 'LEFT' then 'A'
      when 'MIDDLE' then 'B'
      when 'RIGHT' then 'C'
      else v_section
    end;
  end if;

  if p_aisle = 1 and v_section in ('A', 'B', 'C') then return v_section; end if;
  if p_aisle between 2 and 9 and v_section in ('A', 'B', 'C', 'D') then return v_section; end if;
  if p_aisle between 10 and 19 and v_section in ('B', 'C', 'D') then return v_section; end if;
  if p_aisle in (20, 21) and v_section in ('B', 'C') then return v_section; end if;
  if p_aisle = 22 and v_section in ('A', 'B', 'C') then return v_section; end if;
  if p_aisle = 23 and v_section in ('A', 'B') then return v_section; end if;

  if p_aisle = 1 then raise exception 'Aisle 1 uses Sections A, B, or C.'; end if;
  if p_aisle between 2 and 9 then raise exception 'This aisle uses Sections A, B, C, or D.'; end if;
  if p_aisle between 10 and 19 then raise exception 'This aisle uses Sections B, C, or D.'; end if;
  if p_aisle in (20, 21) then raise exception 'Aisles 20 and 21 use Sections B or C.'; end if;
  if p_aisle = 22 then raise exception 'Overflow uses Left, Middle, or Right.'; end if;
  if p_aisle = 23 then raise exception 'Samples Rack uses Section A or B.'; end if;
  raise exception 'Choose a valid warehouse location.';
end;
$function$;

create or replace function public.add_inventory_location(p_sku_id uuid, p_new_aisle integer, p_new_section text, p_employee_name text, p_reason text)
returns table(location_id uuid, sku_id uuid, aisle integer, section text, is_active boolean, pick_first boolean)
language plpgsql security definer set search_path to 'public', 'pg_temp'
as $function$
#variable_conflict use_column
declare
  v_location public.locations%rowtype;
  v_history public.location_history%rowtype;
  v_id uuid := gen_random_uuid();
  v_activity_id uuid;
  v_section text := public.atlas_normalize_warehouse_section(p_new_aisle, p_new_section);
  v_employee text := btrim(p_employee_name);
  v_reason text := btrim(p_reason);
begin
  if not exists (select 1 from public.skus s where s.id = p_sku_id and s.active is not false) then raise exception 'The selected SKU does not exist or is inactive.'; end if;
  if char_length(v_employee) not between 2 and 60 or char_length(v_reason) not between 3 and 250 then raise exception 'Employee name and reason are required.'; end if;
  if exists (select 1 from public.locations l where l.sku_id = p_sku_id and l.aisle = p_new_aisle and upper(btrim(l.section)) = v_section) then raise exception 'This SKU already has that location. Restore it if it was cleared.'; end if;
  insert into public.locations(id, sku_id, aisle, section, level_info, verified, is_active, pick_first)
    values(v_id, p_sku_id, p_new_aisle, v_section, 'All Levels', true, true, false) returning * into v_location;
  insert into public.location_history(location_id, sku_id, action, old_record, new_record, employee_name, reason, changed_at)
    values(v_id, p_sku_id, 'ADD_LOCATION', '{}'::jsonb, jsonb_build_object('location', to_jsonb(v_location)), v_employee, v_reason, now()) returning * into v_history;
  insert into public.inventory_activity(event_type, sku_id, location_id, new_aisle, new_section, employee_name, reason, details)
    values('ADD_LOCATION', p_sku_id, v_id, p_new_aisle, v_section, v_employee, v_reason, jsonb_build_object('sku', (select s.sku from public.skus s where s.id = p_sku_id))) returning id into v_activity_id;
  perform public.atlas_write_undo_snapshot('inventory_activity', v_activity_id::text, 'add_location', p_sku_id, v_id, '{}', jsonb_build_object('location', to_jsonb(v_location)));
  return query select v_location.id, v_location.sku_id, v_location.aisle, v_location.section, v_location.is_active, v_location.pick_first;
end;
$function$;

create or replace function public.move_inventory_location(p_location_id uuid, p_new_aisle integer, p_new_section text, p_employee_name text, p_reason text)
returns table(location_id uuid, sku_id uuid, previous_aisle integer, previous_section text, new_aisle integer, new_section text, employee_name text, reason text, moved_at timestamp with time zone)
language plpgsql security definer set search_path to 'public', 'pg_temp'
as $function$
#variable_conflict use_column
declare
  v_before public.locations%rowtype; v_after public.locations%rowtype; v_history public.location_history%rowtype; v_activity_id uuid;
  v_section text := public.atlas_normalize_warehouse_section(p_new_aisle, p_new_section);
  v_employee text := btrim(p_employee_name); v_reason text := btrim(p_reason);
begin
  if p_location_id is null then raise exception 'A location is required.'; end if;
  if char_length(v_employee) not between 2 and 60 then raise exception 'Employee name or initials must be 2 to 60 characters.'; end if;
  if char_length(v_reason) not between 3 and 250 then raise exception 'Reason must be 3 to 250 characters.'; end if;
  select * into v_before from public.locations l where l.id = p_location_id for update;
  if not found then raise exception 'The selected location no longer exists.'; end if;
  if not v_before.is_active then raise exception 'Restore this location before moving it.'; end if;
  if v_before.aisle = p_new_aisle and upper(btrim(v_before.section)) = v_section then raise exception 'The new location is the same as the current location.'; end if;
  if exists (select 1 from public.locations l where l.sku_id = v_before.sku_id and l.aisle = p_new_aisle and upper(btrim(l.section)) = v_section and l.id <> v_before.id) then raise exception 'This SKU already has the selected aisle and section.'; end if;
  insert into public.location_history(sku_id, location_id, previous_aisle, previous_section, new_aisle, new_section, employee_name, reason)
    values(v_before.sku_id, v_before.id, v_before.aisle, upper(btrim(v_before.section)), p_new_aisle, v_section, v_employee, v_reason) returning * into v_history;
  update public.locations l set aisle = p_new_aisle, section = v_section, verified = true, updated_at = now() where l.id = v_before.id returning * into v_after;
  insert into public.inventory_activity(event_type, sku_id, location_id, previous_aisle, previous_section, new_aisle, new_section, employee_name, reason, details)
    values('MOVE_LOCATION', v_before.sku_id, v_before.id, v_before.aisle, upper(btrim(v_before.section)), p_new_aisle, v_section, v_employee, v_reason, jsonb_build_object('sku', (select s.sku from public.skus s where s.id = v_before.sku_id))) returning id into v_activity_id;
  perform public.atlas_write_undo_snapshot('inventory_activity', v_activity_id::text, 'move_location', v_before.sku_id, v_before.id, jsonb_build_object('location', to_jsonb(v_before)), jsonb_build_object('location', to_jsonb(v_after)));
  return query select v_history.location_id, v_history.sku_id, v_history.previous_aisle, v_history.previous_section, v_history.new_aisle, v_history.new_section, v_history.employee_name, v_history.reason, v_history.moved_at;
end;
$function$;

create or replace function public.create_inventory_sku(p_sku text, p_description text, p_aisle integer, p_section text, p_employee_name text)
returns table(sku_id uuid, location_id uuid, sku text, aisle integer, section text)
language plpgsql security definer set search_path to 'public', 'pg_temp'
as $function$
#variable_conflict use_column
declare
  v_sku public.skus%rowtype; v_location public.locations%rowtype; v_history public.location_history%rowtype; v_activity_id uuid;
  v_sku_id uuid := gen_random_uuid(); v_location_id uuid := gen_random_uuid();
  v_value text := upper(btrim(p_sku)); v_section text := public.atlas_normalize_warehouse_section(p_aisle, p_section); v_employee text := btrim(p_employee_name);
begin
  if char_length(v_value) not between 4 and 120 or v_value !~ '^[A-Z0-9][A-Z0-9./-]*$' then raise exception 'SKU must use letters, numbers, hyphens, decimal points, or slashes.'; end if;
  if exists (select 1 from public.skus s where upper(btrim(s.sku)) = v_value) then raise exception 'That SKU already exists in ATLAS.'; end if;
  if char_length(v_employee) not between 2 and 60 then raise exception 'Employee name or initials must be 2 to 60 characters.'; end if;
  insert into public.skus(id, sku, description, active) values(v_sku_id, v_value, nullif(btrim(p_description), ''), true) returning * into v_sku;
  insert into public.locations(id, sku_id, aisle, section, level_info, verified, is_active, pick_first) values(v_location_id, v_sku_id, p_aisle, v_section, 'All Levels', true, true, false) returning * into v_location;
  insert into public.location_history(location_id, sku_id, action, old_record, new_record, employee_name, reason, changed_at)
    values(v_location_id, v_sku_id, 'CREATE_SKU', '{}'::jsonb, jsonb_build_object('sku', to_jsonb(v_sku), 'location', to_jsonb(v_location)), v_employee, 'New SKU and first warehouse location created', now()) returning * into v_history;
  insert into public.inventory_activity(event_type, sku_id, location_id, new_aisle, new_section, employee_name, reason, details) values('CREATE_SKU', v_sku_id, v_location_id, p_aisle, v_section, v_employee, 'New SKU and first warehouse location created', jsonb_build_object('sku', v_value, 'description', v_sku.description, 'pick_first', false)) returning id into v_activity_id;
  perform public.atlas_write_undo_snapshot('inventory_activity', v_activity_id::text, 'create_sku', v_sku_id, v_location_id, '{}', jsonb_build_object('sku', to_jsonb(v_sku), 'locations', jsonb_build_array(to_jsonb(v_location))));
  return query select v_sku.id, v_location.id, v_sku.sku, v_location.aisle, v_location.section;
end;
$function$;

create or replace function public.correct_inventory_location(p_source_location_id uuid, p_destination_location_id uuid default null, p_new_aisle integer default null, p_new_section text default null, p_employee_name text default null, p_reason text default null)
returns jsonb
language plpgsql security definer set search_path to 'public', 'pg_temp'
as $function$
declare
  v_source public.locations%rowtype; v_destination public.locations%rowtype; v_after_source public.locations%rowtype; v_after_destination public.locations%rowtype;
  v_history public.location_history%rowtype; v_activity_id uuid;
  v_section text; v_employee text := btrim(p_employee_name); v_reason text := btrim(p_reason);
begin
  if p_source_location_id is null then raise exception 'The incorrect location is required.'; end if;
  if char_length(v_employee) not between 2 and 60 then raise exception 'Employee name or initials must be 2 to 60 characters.'; end if;
  if char_length(v_reason) not between 3 and 250 then raise exception 'Correction reason must be 3 to 250 characters.'; end if;
  select * into v_source from public.locations l where l.id = p_source_location_id for update;
  if not found then raise exception 'The incorrect location no longer exists.'; end if;
  if not coalesce(v_source.is_active, false) then raise exception 'The incorrect location is already inactive.'; end if;

  if p_destination_location_id is not null then
    if p_destination_location_id = p_source_location_id then raise exception 'The correct location must be different from the incorrect location.'; end if;
    select * into v_destination from public.locations l where l.id = p_destination_location_id for update;
    if not found then raise exception 'The selected correct location no longer exists.'; end if;
    if v_destination.sku_id <> v_source.sku_id or not coalesce(v_destination.is_active, false) then raise exception 'Choose an active location for the same SKU.'; end if;
  else
    if p_new_aisle is null or p_new_section is null then raise exception 'Choose an existing location or enter a new aisle and section.'; end if;
    v_section := public.atlas_normalize_warehouse_section(p_new_aisle, p_new_section);
    select * into v_destination from public.locations l where l.sku_id = v_source.sku_id and l.is_active = true and l.id <> v_source.id and l.aisle = p_new_aisle and upper(btrim(l.section)) = v_section order by l.created_at asc, l.id asc limit 1 for update;
  end if;

  if found then
    update public.locations l set is_active = false, pick_first = false, verified = true, updated_at = now() where l.id = v_source.id returning * into v_after_source;
    if coalesce(v_source.pick_first, false) then
      update public.locations l set pick_first = false, updated_at = now() where l.sku_id = v_source.sku_id and l.is_active = true;
      update public.locations l set pick_first = true, updated_at = now() where l.id = v_destination.id returning * into v_after_destination;
    else
      v_after_destination := v_destination;
    end if;
    insert into public.location_history(sku_id, location_id, action, previous_aisle, previous_section, new_aisle, new_section, employee_name, reason)
      values(v_source.sku_id, v_source.id, 'CORRECT_LOCATION', v_source.aisle, upper(btrim(v_source.section)), v_destination.aisle, upper(btrim(v_destination.section)), v_employee, v_reason) returning * into v_history;
    insert into public.inventory_activity(event_type, sku_id, location_id, previous_aisle, previous_section, new_aisle, new_section, employee_name, reason, details)
      values('CORRECT_LOCATION', v_source.sku_id, v_source.id, v_source.aisle, upper(btrim(v_source.section)), v_destination.aisle, upper(btrim(v_destination.section)), v_employee, v_reason, jsonb_build_object('sku', (select s.sku from public.skus s where s.id = v_source.sku_id), 'correction_mode', 'consolidated')) returning id into v_activity_id;
    perform public.atlas_write_undo_snapshot('inventory_activity', v_activity_id::text, 'consolidate_location', v_source.sku_id, v_source.id, jsonb_build_object('source', to_jsonb(v_source), 'destination', to_jsonb(v_destination)), jsonb_build_object('source', to_jsonb(v_after_source), 'destination', to_jsonb(v_after_destination)));
    return jsonb_build_object('status', 'corrected', 'source_location_id', v_source.id, 'destination_location_id', v_destination.id, 'aisle', v_destination.aisle, 'section', v_destination.section);
  end if;

  update public.locations l set aisle = p_new_aisle, section = v_section, verified = true, updated_at = now() where l.id = v_source.id returning * into v_after_source;
  insert into public.location_history(sku_id, location_id, action, previous_aisle, previous_section, new_aisle, new_section, employee_name, reason)
    values(v_source.sku_id, v_source.id, 'CORRECT_LOCATION', v_source.aisle, upper(btrim(v_source.section)), p_new_aisle, v_section, v_employee, v_reason) returning * into v_history;
  insert into public.inventory_activity(event_type, sku_id, location_id, previous_aisle, previous_section, new_aisle, new_section, employee_name, reason, details)
    values('CORRECT_LOCATION', v_source.sku_id, v_source.id, v_source.aisle, upper(btrim(v_source.section)), p_new_aisle, v_section, v_employee, v_reason, jsonb_build_object('sku', (select s.sku from public.skus s where s.id = v_source.sku_id), 'correction_mode', 'moved')) returning id into v_activity_id;
  perform public.atlas_write_undo_snapshot('inventory_activity', v_activity_id::text, 'move_location', v_source.sku_id, v_source.id, jsonb_build_object('location', to_jsonb(v_source)), jsonb_build_object('location', to_jsonb(v_after_source)));
  return jsonb_build_object('status', 'moved', 'source_location_id', v_source.id, 'destination_location_id', v_source.id, 'aisle', p_new_aisle, 'section', v_section);
end;
$function$;

create or replace function public.consolidate_inventory_location(p_source_location_id uuid, p_destination_location_id uuid, p_employee_name text, p_reason text)
returns table(location_id uuid, sku_id uuid, previous_aisle integer, previous_section text, new_aisle integer, new_section text, employee_name text, reason text, moved_at timestamp with time zone)
language plpgsql security definer set search_path to 'public', 'pg_temp'
as $function$
declare
  v_source public.locations%rowtype; v_destination public.locations%rowtype; v_history public.location_history%rowtype; v_after_source public.locations%rowtype; v_activity_id uuid;
  v_employee text := btrim(p_employee_name); v_reason text := btrim(p_reason);
begin
  if p_source_location_id is null or p_destination_location_id is null or p_source_location_id = p_destination_location_id then raise exception 'Choose two different inventory locations.'; end if;
  if char_length(v_employee) not between 2 and 60 or char_length(v_reason) not between 3 and 250 then raise exception 'Employee name and reason are required.'; end if;
  perform 1 from public.locations l where l.id in (p_source_location_id, p_destination_location_id) order by l.id for update;
  select * into v_source from public.locations l where l.id = p_source_location_id; select * into v_destination from public.locations l where l.id = p_destination_location_id;
  if v_source.id is null or v_destination.id is null or v_source.sku_id <> v_destination.sku_id or not v_source.is_active or not v_destination.is_active then raise exception 'Both active locations for the same SKU are required.'; end if;
  insert into public.location_history(sku_id, location_id, action, previous_aisle, previous_section, new_aisle, new_section, employee_name, reason) values(v_source.sku_id, v_source.id, 'UPDATE', v_source.aisle, upper(btrim(v_source.section)), v_destination.aisle, upper(btrim(v_destination.section)), v_employee, v_reason) returning * into v_history;
  update public.locations l set is_active = false, pick_first = false, verified = true, updated_at = now() where l.id = v_source.id returning * into v_after_source;
  insert into public.inventory_activity(event_type, sku_id, location_id, previous_aisle, previous_section, new_aisle, new_section, employee_name, reason, details) values('CONSOLIDATE_LOCATION', v_source.sku_id, v_source.id, v_source.aisle, upper(btrim(v_source.section)), v_destination.aisle, upper(btrim(v_destination.section)), v_employee, v_reason, jsonb_build_object('sku', (select s.sku from public.skus s where s.id = v_source.sku_id))) returning id into v_activity_id;
  perform public.atlas_write_undo_snapshot('location_history', v_history.id::text, 'consolidate_location', v_source.sku_id, v_source.id, jsonb_build_object('source', to_jsonb(v_source), 'destination', to_jsonb(v_destination)), jsonb_build_object('source', to_jsonb(v_after_source), 'destination', to_jsonb(v_destination)));
  return query select v_history.location_id, v_history.sku_id, v_history.previous_aisle, v_history.previous_section, v_history.new_aisle, v_history.new_section, v_history.employee_name, v_history.reason, v_history.moved_at;
end;
$function$;

create or replace function public.set_inventory_location_active(p_location_id uuid, p_is_active boolean, p_employee_name text, p_reason text)
returns table(location_id uuid, sku_id uuid, is_active boolean, pick_first boolean)
language plpgsql security definer set search_path to 'public', 'pg_temp'
as $function$
#variable_conflict use_column
declare
  v_before public.locations%rowtype; v_after public.locations%rowtype; v_history public.location_history%rowtype; v_activity_id uuid;
  v_employee text := btrim(p_employee_name); v_reason text := btrim(p_reason);
begin
  if p_is_active is null then raise exception 'Choose whether the location should be active.'; end if;
  if char_length(v_employee) not between 2 and 60 then raise exception 'Employee name or initials must be 2 to 60 characters.'; end if;
  if char_length(v_reason) not between 3 and 250 then raise exception 'Reason must be 3 to 250 characters.'; end if;
  select * into v_before from public.locations l where l.id = p_location_id for update;
  if not found then raise exception 'The selected location no longer exists.'; end if;
  if v_before.is_active = p_is_active then raise exception 'That location already has the selected status.'; end if;
  if p_is_active and exists (select 1 from public.locations l where l.sku_id = v_before.sku_id and l.is_active = true and l.id <> v_before.id and l.aisle = v_before.aisle and upper(btrim(l.section)) = upper(btrim(v_before.section))) then raise exception 'Cannot restore this location because this SKU is already active at the same location.'; end if;
  update public.locations l set is_active = p_is_active, pick_first = case when p_is_active then l.pick_first else false end, updated_at = now() where l.id = v_before.id returning * into v_after;
  insert into public.location_history(location_id, sku_id, action, old_record, new_record, employee_name, reason, changed_at)
    values(v_before.id, v_before.sku_id, case when p_is_active then 'RESTORE_LOCATION' else 'CLEAR_LOCATION' end, jsonb_build_object('location', to_jsonb(v_before)), jsonb_build_object('location', to_jsonb(v_after)), v_employee, v_reason, now()) returning * into v_history;
  insert into public.inventory_activity(event_type, sku_id, location_id, previous_aisle, previous_section, new_aisle, new_section, employee_name, reason, details) values(case when p_is_active then 'RESTORE_LOCATION' else 'CLEAR_LOCATION' end, v_before.sku_id, v_before.id, v_before.aisle, upper(btrim(v_before.section)), v_after.aisle, upper(btrim(v_after.section)), v_employee, v_reason, jsonb_build_object('previous_is_active', v_before.is_active, 'new_is_active', v_after.is_active, 'previous_pick_first', v_before.pick_first, 'new_pick_first', v_after.pick_first)) returning id into v_activity_id;
  perform public.atlas_write_undo_snapshot('inventory_activity', v_activity_id::text, case when p_is_active then 'restore_location' else 'clear_location' end, v_before.sku_id, v_before.id, jsonb_build_object('location', to_jsonb(v_before)), jsonb_build_object('location', to_jsonb(v_after)));
  return query select v_after.id, v_after.sku_id, v_after.is_active, v_after.pick_first;
end;
$function$;

create or replace function public.set_inventory_pick_first(p_sku_id uuid, p_location_id uuid, p_enabled boolean, p_employee_name text)
returns jsonb
language plpgsql security definer set search_path to 'public', 'pg_temp'
as $function$
declare
  v_target public.locations%rowtype; v_history public.location_history%rowtype; v_before jsonb; v_after jsonb; v_activity_id uuid;
  v_employee text := nullif(btrim(p_employee_name), '');
begin
  if p_enabled is null then raise exception 'Choose whether Pick First should be enabled.'; end if;
  if char_length(v_employee) not between 2 and 60 then raise exception 'Employee name or initials must be 2 to 60 characters.'; end if;
  select * into v_target from public.locations l where l.id = p_location_id and l.sku_id = p_sku_id for update;
  if not found or not coalesce(v_target.is_active, false) then raise exception 'Pick First can only be changed for an active location.'; end if;
  perform 1 from public.locations l where l.sku_id = p_sku_id order by l.id for update;
  select coalesce(jsonb_agg(to_jsonb(l) order by l.id), '[]'::jsonb) into v_before from public.locations l where l.sku_id = p_sku_id;
  if p_enabled then update public.locations l set pick_first = false, updated_at = now() where l.sku_id = p_sku_id and l.pick_first = true; update public.locations l set pick_first = true, updated_at = now() where l.id = p_location_id and l.sku_id = p_sku_id and l.is_active = true; else update public.locations l set pick_first = false, updated_at = now() where l.id = p_location_id and l.sku_id = p_sku_id; end if;
  select coalesce(jsonb_agg(to_jsonb(l) order by l.id), '[]'::jsonb) into v_after from public.locations l where l.sku_id = p_sku_id;
  insert into public.location_history(location_id, sku_id, action, old_record, new_record, employee_name, changed_at) values(p_location_id, p_sku_id, case when p_enabled then 'pick_first_enabled' else 'pick_first_disabled' end, jsonb_build_object('pick_first', v_target.pick_first, 'employee', v_employee), jsonb_build_object('pick_first', p_enabled, 'employee', v_employee), v_employee, now()) returning * into v_history;
  insert into public.inventory_activity(event_type, sku_id, location_id, previous_aisle, previous_section, new_aisle, new_section, employee_name, reason, details) values(case when p_enabled then 'PICK_FIRST_ENABLED' else 'PICK_FIRST_DISABLED' end, p_sku_id, p_location_id, v_target.aisle, upper(btrim(v_target.section)), v_target.aisle, upper(btrim(v_target.section)), v_employee, 'Pick First updated', jsonb_build_object('previous_pick_first', v_target.pick_first, 'new_pick_first', p_enabled)) returning id into v_activity_id;
  perform public.atlas_write_undo_snapshot('location_history', v_history.id::text, 'pick_first', p_sku_id, p_location_id, jsonb_build_object('locations', v_before), jsonb_build_object('locations', v_after));
  return jsonb_build_object('status', 'updated', 'sku_id', p_sku_id, 'location_id', p_location_id, 'pick_first', p_enabled);
end;
$function$;

create or replace function public.edit_inventory_sku(p_sku_id uuid, p_new_sku text, p_description text, p_employee_name text)
returns jsonb
language plpgsql security definer set search_path to 'public', 'pg_temp'
as $function$
declare
  v_old public.skus%rowtype; v_new public.skus%rowtype; v_history public.location_history%rowtype; v_activity_id uuid;
  v_employee text := nullif(btrim(p_employee_name), ''); v_value text := upper(btrim(p_new_sku));
begin
  if char_length(v_employee) not between 2 and 60 then raise exception 'Employee name or initials must be 2 to 60 characters.'; end if;
  if char_length(v_value) not between 4 and 120 or v_value !~ '^[A-Z0-9][A-Z0-9./-]*$' then raise exception 'SKU must use letters, numbers, hyphens, decimal points, or slashes.'; end if;
  select * into v_old from public.skus s where s.id = p_sku_id for update;
  if not found or v_old.active = false then raise exception 'SKU not found or inactive.'; end if;
  if exists (select 1 from public.skus s where upper(btrim(s.sku)) = v_value and s.id <> p_sku_id) then raise exception 'That SKU already exists in ATLAS.'; end if;
  update public.skus s set sku = v_value, description = nullif(btrim(p_description), ''), updated_at = now() where s.id = p_sku_id returning * into v_new;
  insert into public.location_history(location_id, sku_id, action, old_record, new_record, changed_at) values(null, p_sku_id, 'sku_edited', jsonb_build_object('sku', v_old.sku, 'description', v_old.description, 'employee', v_employee), jsonb_build_object('sku', v_new.sku, 'description', v_new.description, 'employee', v_employee), now()) returning * into v_history;
  insert into public.inventory_activity(event_type, sku_id, location_id, employee_name, reason, details) values('SKU_EDIT', p_sku_id, null, v_employee, 'SKU details corrected', jsonb_build_object('previous_sku', v_old.sku, 'new_sku', v_new.sku, 'previous_description', v_old.description, 'new_description', v_new.description)) returning id into v_activity_id;
  perform public.atlas_write_undo_snapshot('location_history', v_history.id::text, 'edit_sku', p_sku_id, null, jsonb_build_object('sku', to_jsonb(v_old)), jsonb_build_object('sku', to_jsonb(v_new)));
  return jsonb_build_object('id', v_new.id, 'sku', v_new.sku, 'description', v_new.description);
end;
$function$;
