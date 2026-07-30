-- ATLAS combined glitch fix
-- Run this entire file once in Supabase: SQL Editor -> New query -> Run.
-- It is safe to run again.

begin;

-- Replace the older rule that required Aisle 22 to store the literal words
-- LEFT/MIDDLE/RIGHT. The new ATLAS standard stores A/B/C consistently.
alter table public.locations
drop constraint if exists locations_section_valid;

-- Aisle 22 is the overflow floor location:
-- Left = Section A, Middle = Section B, Right = Section C.
update public.locations as location
set
  section = case upper(trim(location.section))
    when 'LEFT' then 'A'
    when 'MIDDLE' then 'B'
    when 'RIGHT' then 'C'
    else upper(trim(location.section))
  end,
  updated_at = now()
where
  location.aisle = 22
  and upper(trim(location.section)) in ('LEFT', 'MIDDLE', 'RIGHT', 'A', 'B', 'C');

alter table public.locations
add constraint locations_section_valid
check (
  case
    when aisle between 1 and 9
      then upper(trim(section)) in ('A', 'B', 'C', 'D')
    when aisle between 10 and 19
      then upper(trim(section)) in ('B', 'C', 'D')
    when aisle in (20, 21)
      then upper(trim(section)) in ('B', 'C')
    when aisle = 22
      then upper(trim(section)) in ('A', 'B', 'C')
    else false
  end
);

-- A dedicated correction function avoids the ambiguous pick_first reference in
-- the previous database routine. Every column reference below is table-qualified.
create or replace function public.correct_inventory_location(
  p_source_location_id uuid,
  p_destination_location_id uuid default null,
  p_new_aisle integer default null,
  p_new_section text default null,
  p_employee_name text default null,
  p_reason text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  source_location public.locations%rowtype;
  destination_location public.locations%rowtype;
  normalized_section text;
begin
  if nullif(trim(coalesce(p_employee_name, '')), '') is null then
    raise exception 'Employee name or initials are required.';
  end if;

  if nullif(trim(coalesce(p_reason, '')), '') is null then
    raise exception 'A correction reason is required.';
  end if;

  select location.*
  into source_location
  from public.locations as location
  where location.id = p_source_location_id
  for update;

  if not found then
    raise exception 'The incorrect location no longer exists.';
  end if;

  if not coalesce(source_location.is_active, false) then
    raise exception 'The incorrect location is already inactive.';
  end if;

  if p_destination_location_id is not null then
    if p_destination_location_id = p_source_location_id then
      raise exception 'The correct location must be different from the incorrect location.';
    end if;

    select location.*
    into destination_location
    from public.locations as location
    where location.id = p_destination_location_id
    for update;

    if not found then
      raise exception 'The selected correct location no longer exists.';
    end if;

    if destination_location.sku_id <> source_location.sku_id then
      raise exception 'The selected correct location belongs to a different SKU.';
    end if;

    if not coalesce(destination_location.is_active, false) then
      raise exception 'The selected correct location is not active.';
    end if;

    update public.locations as location
    set
      is_active = false,
      pick_first = false,
      updated_at = now()
    where location.id = source_location.id;

    if coalesce(source_location.pick_first, false) then
      update public.locations as location
      set
        pick_first = false,
        updated_at = now()
      where
        location.sku_id = source_location.sku_id
        and location.is_active = true;

      update public.locations as location
      set
        pick_first = true,
        updated_at = now()
      where location.id = destination_location.id;
    end if;

    return jsonb_build_object(
      'status', 'corrected',
      'source_location_id', source_location.id,
      'destination_location_id', destination_location.id,
      'aisle', destination_location.aisle,
      'section', destination_location.section
    );
  end if;

  if p_new_aisle is null or p_new_section is null then
    raise exception 'Choose an existing location or enter a new aisle and section.';
  end if;

  normalized_section := upper(trim(p_new_section));
  if p_new_aisle = 22 then
    normalized_section := case normalized_section
      when 'LEFT' then 'A'
      when 'MIDDLE' then 'B'
      when 'RIGHT' then 'C'
      else normalized_section
    end;
  end if;

  if p_new_aisle < 1 or p_new_aisle > 22 then
    raise exception 'Aisle must be between 1 and 22.';
  end if;

  if p_new_aisle = 22 and normalized_section not in ('A', 'B', 'C') then
    raise exception 'Aisle 22 uses Section A (Left), B (Middle), or C (Right).';
  elsif p_new_aisle in (20, 21) and normalized_section not in ('B', 'C') then
    raise exception 'Aisles 20 and 21 use Sections B or C.';
  elsif p_new_aisle between 10 and 19 and normalized_section not in ('B', 'C', 'D') then
    raise exception 'This aisle uses Sections B, C, or D.';
  elsif p_new_aisle between 1 and 9 and normalized_section not in ('A', 'B', 'C', 'D') then
    raise exception 'This aisle uses Sections A, B, C, or D.';
  end if;

  -- If this SKU already has the requested destination, deactivate only the
  -- incorrect duplicate and preserve/transfer Pick First safely.
  select location.*
  into destination_location
  from public.locations as location
  where
    location.sku_id = source_location.sku_id
    and location.is_active = true
    and location.id <> source_location.id
    and location.aisle = p_new_aisle
    and upper(trim(location.section)) = normalized_section
  order by location.created_at asc, location.id asc
  limit 1
  for update;

  if found then
    update public.locations as location
    set
      is_active = false,
      pick_first = false,
      updated_at = now()
    where location.id = source_location.id;

    if coalesce(source_location.pick_first, false) then
      update public.locations as location
      set
        pick_first = false,
        updated_at = now()
      where
        location.sku_id = source_location.sku_id
        and location.is_active = true;

      update public.locations as location
      set
        pick_first = true,
        updated_at = now()
      where location.id = destination_location.id;
    end if;

    return jsonb_build_object(
      'status', 'corrected',
      'source_location_id', source_location.id,
      'destination_location_id', destination_location.id,
      'aisle', destination_location.aisle,
      'section', destination_location.section
    );
  end if;

  update public.locations as location
  set
    aisle = p_new_aisle,
    section = normalized_section,
    updated_at = now()
  where location.id = source_location.id;

  return jsonb_build_object(
    'status', 'moved',
    'source_location_id', source_location.id,
    'destination_location_id', source_location.id,
    'aisle', p_new_aisle,
    'section', normalized_section
  );
end;
$function$;

revoke all on function public.correct_inventory_location(
  uuid,
  uuid,
  integer,
  text,
  text,
  text
) from public;

grant execute on function public.correct_inventory_location(
  uuid,
  uuid,
  integer,
  text,
  text,
  text
) to anon, authenticated;

commit;

-- Verification: this should return zero rows after the update.
select
  location.id,
  location.aisle,
  location.section
from public.locations as location
where
  location.aisle = 22
  and upper(trim(location.section)) not in ('A', 'B', 'C');
