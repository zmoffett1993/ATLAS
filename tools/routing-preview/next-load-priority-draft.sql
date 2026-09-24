-- LOCAL PREPARATION ONLY. Review deployed definitions before approved activation.
-- Optional v3 metadata: old days remain valid; scanners preserve the existing document.
begin;
do $$ begin
  if to_regprocedure('atlas_routing_preview_private.valid_document_before_priority(jsonb,date)') is null then
    execute replace(pg_get_functiondef('atlas_routing_preview_private.valid_document(jsonb,date)'::regprocedure),
      'FUNCTION atlas_routing_preview_private.valid_document(',
      'FUNCTION atlas_routing_preview_private.valid_document_before_priority(');
  end if;
end $$;
revoke all on function atlas_routing_preview_private.valid_document_before_priority(jsonb,date) from public,anon,authenticated;

create or replace function atlas_routing_preview_private.valid_document(j jsonb, p_day date)
returns boolean language plpgsql immutable set search_path='' as $$
declare item jsonb; order_id text; seen text[] := '{}';
begin
  if not atlas_routing_preview_private.valid_document_before_priority(j-'nextLoadPriority',p_day) then return false; end if;
  if not (j ? 'nextLoadPriority') then return true; end if;
  if j->'schemaVersion' is distinct from '3'::jsonb
    or jsonb_typeof(j->'nextLoadPriority') is distinct from 'array'
    or jsonb_array_length(j->'nextLoadPriority')>200 then return false; end if;
  for item in select value from jsonb_array_elements(j->'nextLoadPriority') loop
    order_id := item #>> '{}';
    if jsonb_typeof(item) is distinct from 'string' or order_id=any(seen)
      or not exists(select 1 from jsonb_array_elements(j->'orders') o
        where o->>'id'=order_id and o->'dispatchedOn'='null'::jsonb and o->'deliveredOn'='null'::jsonb)
      or exists(select 1 from jsonb_array_elements(j->'lockedTrips') t,
        lateral jsonb_array_elements(t->'shipments') s where lower(s->>'orderId')=lower(order_id))
    then return false; end if;
    seen := array_append(seen,order_id);
  end loop;
  return true;
exception when others then return false;
end $$;
revoke all on function atlas_routing_preview_private.valid_document(jsonb,date) from public,anon,authenticated;

-- The row trigger checks OLD under the same row lock as the revisioned save.
-- Older clients project unknown fields away; require an explicit [] to clear priority.
create or replace function atlas_routing_preview_private.protect_next_load_priority()
returns trigger language plpgsql set search_path='' as $$
begin
  if old.document ? 'nextLoadPriority' and not (new.document ? 'nextLoadPriority') then
    raise exception using errcode='0A000',message='ROUTING_CLIENT_UPDATE_REQUIRED';
  end if;
  return new;
end $$;
revoke all on function atlas_routing_preview_private.protect_next_load_priority() from public,anon,authenticated;
create or replace trigger protect_next_load_priority before update of document
on atlas_routing_preview_private.days for each row
execute function atlas_routing_preview_private.protect_next_load_priority();
commit;
