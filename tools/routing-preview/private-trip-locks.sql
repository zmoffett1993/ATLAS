-- Private CA routing-preview trip snapshots. Existing access checks and RLS remain in place.
-- Applied to the existing private validator and revisioned save RPC only.
CREATE OR REPLACE FUNCTION atlas_routing_preview_private.valid_document(j jsonb, p_day date)
 RETURNS boolean
 LANGUAGE plpgsql
 IMMUTABLE
 SET search_path TO ''
AS $function$
declare o jsonb; l jsonb; c jsonb; s jsonb; k text; v jsonb;
  ids text[] := '{}'; numbers text[] := '{}'; n text; t jsonb; sh jsonb; ba jsonb; done_id text; trip_index integer := 0; trip_sum integer;
  packed jsonb := '{}'::jsonb; packed_key text; ordered_boxes bigint; completed_ids text[] := '{}';
begin
  if not atlas_routing_preview_private.exact_keys(j,array['schemaVersion','date','orders','catalog','settings','assignments','vanConfirmed'] ||
    case when j->'schemaVersion'='3'::jsonb then array['lockedTrips'] else array[]::text[] end)
    or j->'schemaVersion' not in ('1'::jsonb,'2'::jsonb,'3'::jsonb) or j->>'date' <> to_char(p_day,'YYYY-MM-DD')
    or octet_length(j::text)>1200000 then return false; end if;
  if jsonb_typeof(j->'orders') is distinct from 'array' or jsonb_array_length(j->'orders')>200
    or jsonb_typeof(j->'catalog') is distinct from 'array' or jsonb_array_length(j->'catalog')>2000 then return false; end if;
  for o in select value from jsonb_array_elements(j->'orders') loop
    if not atlas_routing_preview_private.exact_keys(o,array['id','orderNumber','customer','address','city','timeWindow','notes','serviceMinutes','checkOnDelivery','lines'] ||
      case when j->'schemaVersion' in ('2'::jsonb,'3'::jsonb) then array['invoiceNumbers','fulfillmentNumbers','dispatchedOn','deliveredOn','deliveryException'] else array[]::text[] end) then return false; end if;
    if j->'schemaVersion' in ('2'::jsonb,'3'::jsonb) then
      foreach k in array array['invoiceNumbers','fulfillmentNumbers'] loop
        if jsonb_typeof(o->k) is distinct from 'array' or jsonb_array_length(o->k)>20 then return false; end if;
        for v in select value from jsonb_array_elements(o->k) loop
          if jsonb_typeof(v) is distinct from 'string' or length(btrim(v #>> '{}')) not between 1 and 80 then return false; end if;
        end loop;
      end loop;
      foreach k in array array['dispatchedOn','deliveredOn'] loop
        if o->k <> 'null'::jsonb then
          if jsonb_typeof(o->k) is distinct from 'string' or (o->>k) !~ '^20[0-9]{2}-[0-9]{2}-[0-9]{2}$'
            or to_char((o->>k)::date,'YYYY-MM-DD') <> o->>k then return false; end if;
        end if;
      end loop;
      if (o->>'deliveredOn')::date < (o->>'dispatchedOn')::date then return false; end if;
      if jsonb_typeof(o->'deliveryException') is distinct from 'string' or length(o->>'deliveryException')>500 then return false; end if;
    end if;
    if jsonb_typeof(o->'id') is distinct from 'string' or (o->>'id') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      or lower(o->>'id')=any(ids) then return false; end if;
    ids := array_append(ids,lower(o->>'id'));
    foreach k in array array['orderNumber','customer','address','city','timeWindow','notes'] loop
      if jsonb_typeof(o->k) is distinct from 'string' then return false; end if;
      if k = 'orderNumber' and length(o->>k)>80 then return false; end if;
      if k = 'customer' and length(o->>k)>160 then return false; end if;
      if k = 'address' and length(o->>k)>300 then return false; end if;
      if k = 'notes' and length(o->>k)>1000 then return false; end if;
      if k in ('city','timeWindow') and length(o->>k)>100 then return false; end if;
      if k in ('orderNumber','customer','address','city') and length(btrim(o->>k))=0 then return false; end if;
    end loop;
    n := upper(btrim(o->>'orderNumber')); if n=any(numbers) then return false; end if; numbers := array_append(numbers,n);
    if not atlas_routing_preview_private.integer_between(o->'serviceMinutes',1,480)
      or jsonb_typeof(o->'checkOnDelivery') is distinct from 'boolean'
      or jsonb_typeof(o->'lines') is distinct from 'array' or jsonb_array_length(o->'lines') not between 1 and 200 then return false; end if;
    for l in select value from jsonb_array_elements(o->'lines') loop
      if not atlas_routing_preview_private.exact_keys(l,array['sku','caseQty','itemQty'])
        or jsonb_typeof(l->'sku') is distinct from 'string' or length(btrim(l->>'sku')) not between 1 and 100
        or not atlas_routing_preview_private.integer_between(l->'caseQty',1,1000000)
        or (l->'itemQty' <> 'null'::jsonb and not atlas_routing_preview_private.integer_between(l->'itemQty',1,1000000000)) then return false; end if;
    end loop;
  end loop;
  for c in select value from jsonb_array_elements(j->'catalog') loop
    if not atlas_routing_preview_private.exact_keys(c,array['model','caseQty','caseDimensions','caseWeightLb','boxesPerPallet','palletDimensions','sourceRow']) then return false; end if;
    foreach k in array array['model','caseQty','caseDimensions','caseWeightLb','boxesPerPallet','palletDimensions'] loop
      if jsonb_typeof(c->k) is distinct from 'string' or length(c->>k)>200 or (k='model' and length(btrim(c->>k))=0) then return false; end if;
    end loop;
    if not atlas_routing_preview_private.integer_between(c->'sourceRow',1,1000000) then return false; end if;
  end loop;
  s := j->'settings';
  if not atlas_routing_preview_private.exact_keys(s,array['truckPalletTarget','dailyTripTarget','reloadMinutes','lunch','preserveOrder'])
    or not atlas_routing_preview_private.integer_between(s->'truckPalletTarget',1,100)
    or not atlas_routing_preview_private.integer_between(s->'dailyTripTarget',1,100)
    or not atlas_routing_preview_private.integer_between(s->'reloadMinutes',0,120)
    or jsonb_typeof(s->'lunch') is distinct from 'string' or (s->>'lunch') !~ '^(11|12|13):[0-5][0-9]$' or (s->>'lunch')>'13:00'
    or jsonb_typeof(s->'preserveOrder') is distinct from 'boolean' then return false; end if;
  if jsonb_typeof(j->'assignments') is distinct from 'object' or jsonb_typeof(j->'vanConfirmed') is distinct from 'object' then return false; end if;
  for k,v in select * from jsonb_each(j->'assignments') loop
    if k !~ '^(0|[1-9][0-9]{0,3})$' or jsonb_typeof(v) is distinct from 'string'
      or (v #>> '{}') !~ '^(Bubba:(truck|van1|van2)|Achmad:van[12])$' then return false; end if;
  end loop;
  for k,v in select * from jsonb_each(j->'vanConfirmed') loop
    if k !~ '^(0|[1-9][0-9]{0,3})$' or jsonb_typeof(v) is distinct from 'boolean' then return false; end if;
  end loop;
  if j->'schemaVersion'='3'::jsonb then
    if jsonb_typeof(j->'lockedTrips') is distinct from 'array' or jsonb_array_length(j->'lockedTrips')>200 then return false; end if;
    for t in select value from jsonb_array_elements(j->'lockedTrips') loop
      if not atlas_routing_preview_private.exact_keys(t,array['shipments','palletSpaces','assignment','vanConfirmed','sentOn','completedOrderIds'])
        or not atlas_routing_preview_private.integer_between(t->'palletSpaces',1,100)
        or jsonb_typeof(t->'assignment') is distinct from 'string'
        or (t->>'assignment') !~ '^(Bubba:(truck|van1|van2)|Achmad:van[12])$'
        or j->'assignments'->>trip_index::text is distinct from t->>'assignment'
        or jsonb_typeof(t->'vanConfirmed') is distinct from 'boolean'
        or j->'vanConfirmed'->trip_index::text is distinct from t->'vanConfirmed'
        or jsonb_typeof(t->'sentOn') is distinct from 'string'
        or (t->>'sentOn') !~ '^20[0-9]{2}-[0-9]{2}-[0-9]{2}$'
        or to_char((t->>'sentOn')::date,'YYYY-MM-DD') <> t->>'sentOn'
        or (t->>'sentOn')::date < p_day
        or jsonb_typeof(t->'shipments') is distinct from 'array'
        or jsonb_array_length(t->'shipments') not between 1 and 200
        or jsonb_typeof(t->'completedOrderIds') is distinct from 'array' then return false; end if;
      trip_sum := 0;
      for sh in select value from jsonb_array_elements(t->'shipments') loop
        if not atlas_routing_preview_private.exact_keys(sh,array['orderId','palletSpaces','boxAllocation'])
          or jsonb_typeof(sh->'orderId') is distinct from 'string'
          or lower(sh->>'orderId') <> all(ids)
          or not atlas_routing_preview_private.integer_between(sh->'palletSpaces',1,100)
          or jsonb_typeof(sh->'boxAllocation') is distinct from 'array'
          or jsonb_array_length(sh->'boxAllocation') not between 1 and 200 then return false; end if;
        trip_sum := trip_sum + (sh->>'palletSpaces')::integer;
        for ba in select value from jsonb_array_elements(sh->'boxAllocation') loop
          if not atlas_routing_preview_private.exact_keys(ba,array['sku','boxes'])
            or jsonb_typeof(ba->'sku') is distinct from 'string'
            or length(btrim(ba->>'sku')) not between 1 and 100
            or not atlas_routing_preview_private.integer_between(ba->'boxes',1,1000000) then return false; end if;
          packed_key := lower(sh->>'orderId') || ':' || (ba->>'sku');
          select sum((l2->>'caseQty')::bigint) into ordered_boxes
            from jsonb_array_elements(j->'orders') o2
            cross join lateral jsonb_array_elements(o2->'lines') l2
            where lower(o2->>'id')=lower(sh->>'orderId') and l2->>'sku'=ba->>'sku';
          if ordered_boxes is null then return false; end if;
          packed := jsonb_set(packed,array[packed_key],to_jsonb(coalesce((packed->>packed_key)::bigint,0)+(ba->>'boxes')::bigint),true);
          if (packed->>packed_key)::bigint > ordered_boxes then return false; end if;
        end loop;
      end loop;
      if trip_sum <> (t->>'palletSpaces')::integer then return false; end if;
      for ba in select value from jsonb_array_elements(t->'completedOrderIds') loop
        if jsonb_typeof(ba) is distinct from 'string' then return false; end if;
        done_id := lower(ba #>> '{}');
        if done_id=any(completed_ids)
          or not exists(select 1 from jsonb_array_elements(t->'shipments') sh2 where lower(sh2->>'orderId')=done_id)
          or not exists(select 1 from jsonb_array_elements(j->'orders') o2 where lower(o2->>'id')=done_id and o2->'dispatchedOn' <> 'null'::jsonb)
          then return false; end if;
        completed_ids := array_append(completed_ids,done_id);
      end loop;
      trip_index := trip_index + 1;
    end loop;
    for done_id in select unnest(completed_ids) loop
      for o in select value from jsonb_array_elements(j->'orders') where lower(value->>'id')=done_id loop
        for l in select value from jsonb_array_elements(o->'lines') loop
          packed_key := done_id || ':' || (l->>'sku');
          select sum((l2->>'caseQty')::bigint) into ordered_boxes
            from jsonb_array_elements(o->'lines') l2 where l2->>'sku'=l->>'sku';
          if (packed->>packed_key)::bigint is distinct from ordered_boxes then return false; end if;
        end loop;
      end loop;
    end loop;
  end if;
  return true;
exception when others then return false;
end;
$function$
;
CREATE OR REPLACE FUNCTION atlas_routing_preview_private.save_day(p_warehouse text, p_day date, p_expected_revision integer, p_document jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare w uuid; saved_revision integer;
begin
  if p_warehouse is distinct from 'CA' or not atlas_routing_preview_private.can_access(true) then
    raise exception using errcode='42501', message='ROUTING_ACCESS_DENIED'; end if;
  if p_day is null or p_day not between date '2000-01-01' and date '2099-12-31'
    or p_expected_revision is null or p_expected_revision not between 0 and 2147483646
    or not atlas_routing_preview_private.valid_document(p_document,p_day) then
    raise exception using errcode='22023', message='INVALID_ROUTING_DOCUMENT'; end if;
  select id into strict w from public.warehouses where code='CA' and active;
  -- An older tab must not discard saved history or sent-out trips.
  if exists(select 1 from atlas_routing_preview_private.days d where d.warehouse_id=w and d.planning_day=p_day
    and (d.document->>'schemaVersion')::integer > (p_document->>'schemaVersion')::integer) then
    raise exception using errcode='0A000', message='ROUTING_CLIENT_UPDATE_REQUIRED'; end if;
  if exists(select 1 from jsonb_array_elements(p_document->'orders') o
    where (o->>'deliveredOn')::date > (now() at time zone 'America/Los_Angeles')::date
       or (o->>'dispatchedOn')::date > (now() at time zone 'America/Los_Angeles')::date) then
    raise exception using errcode='22023', message='FUTURE_DELIVERY_STATUS'; end if;
  if p_document->'schemaVersion'='3'::jsonb and exists(
    select 1 from jsonb_array_elements(p_document->'lockedTrips') t
    where (t->>'sentOn')::date > (now() at time zone 'America/Los_Angeles')::date) then
    raise exception using errcode='22023', message='FUTURE_ROUTING_DISPATCH'; end if;
  if p_expected_revision=0 then
    insert into atlas_routing_preview_private.days(warehouse_id,planning_day,revision,document,updated_by)
    values(w,p_day,1,p_document,auth.uid()) on conflict(warehouse_id,planning_day) do nothing
    returning revision into saved_revision;
  else
    update atlas_routing_preview_private.days set document=p_document,revision=revision+1,updated_by=auth.uid(),updated_at=now()
      where warehouse_id=w and planning_day=p_day and revision=p_expected_revision
      returning revision into saved_revision;
  end if;
  if saved_revision is null then raise exception using errcode='40001', message='ROUTING_SAVE_CONFLICT'; end if;
  return jsonb_build_object('warehouse','CA','date',to_char(p_day,'YYYY-MM-DD'),'revision',saved_revision,'document',p_document,'canEdit',true);
end;
$function$
;
