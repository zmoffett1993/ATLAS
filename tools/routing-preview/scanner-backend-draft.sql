-- LOCAL REVIEW ONLY. Requires the existing v3 saved-day validator and admin-only access helper.
-- No deployment, scheduler, credentials, or public table access is enabled by this file.
begin;
create schema atlas_scanner_private;
revoke all on schema atlas_scanner_private from public,anon,authenticated,service_role;
create table atlas_scanner_private.settings(enabled boolean not null default false, catalog jsonb not null default '[]'::jsonb);
insert into atlas_scanner_private.settings(enabled) values(false);
alter table atlas_scanner_private.settings enable row level security;

create table atlas_scanner_private.extractions (
 warehouse_id uuid not null, planning_day date not null, sales_order text not null,
 order_id uuid not null, created_by uuid not null references auth.users(id),
 metadata jsonb not null, created_at timestamptz not null default now(),
 primary key(warehouse_id,planning_day,sales_order),
 foreign key(warehouse_id,planning_day) references atlas_routing_preview_private.days(warehouse_id,planning_day)
);
create table atlas_scanner_private.planning (
 warehouse_id uuid not null, planning_day date not null,
 generation bigint not null default 1, due_at timestamptz not null default now(),
 lease uuid, lease_until timestamptz, claimed_generation bigint, source_revision integer,
 status text not null default 'pending' check(status in ('pending','planning','updated','attention')),
 plan jsonb, plan_revision integer, error_code text,
 primary key(warehouse_id,planning_day),
 foreign key(warehouse_id,planning_day) references atlas_routing_preview_private.days(warehouse_id,planning_day)
);
alter table atlas_scanner_private.extractions enable row level security;
alter table atlas_scanner_private.planning enable row level security;
revoke all on all tables in schema atlas_scanner_private from public,anon,authenticated,service_role;

-- Durable counters apply across restarts; only an active lease may spend.
create table atlas_scanner_private.usage (
 usage_day date not null, kind text not null check(kind in ('geocode','route')),
 used integer not null check(used between 0 and 100), primary key(usage_day,kind)
);
alter table atlas_scanner_private.usage enable row level security;
revoke all on atlas_scanner_private.usage from public,anon,authenticated,service_role;
create function public.atlas_routing_scanner_budget(p_lease uuid,p_kind text) returns boolean
language plpgsql security definer set search_path='' as $$
declare spent integer;
begin
 if p_kind is null or p_kind not in ('geocode','route') or not exists(
  select 1 from atlas_scanner_private.planning where lease=p_lease and lease_until>now() and status='planning'
 ) or not exists(select 1 from atlas_scanner_private.settings where enabled) then
  raise exception using errcode='42501',message='SCANNER_LEASE_REQUIRED'; end if;
 insert into atlas_scanner_private.usage(usage_day,kind,used)
 values((now() at time zone 'America/Los_Angeles')::date,p_kind,1)
 on conflict(usage_day,kind) do update set used=atlas_scanner_private.usage.used+1
 where atlas_scanner_private.usage.used<100 returning used into spent;
 return spent is not null;
end $$;
revoke all on function public.atlas_routing_scanner_budget(uuid,text) from public,anon,authenticated,service_role;
grant execute on function public.atlas_routing_scanner_budget(uuid,text) to service_role;

-- Only bounded field diagnostics, never the original photo or full OCR response.
create function atlas_scanner_private.valid_metadata(j jsonb) returns boolean
language plpgsql immutable set search_path='' as $$
declare f jsonb; k text;
begin
 if not atlas_routing_preview_private.exact_keys(j,array['parserVersion','purchaseOrder','packingSlip','fields'])
   or octet_length(j::text)>180000 then return false; end if;
 foreach k in array array['parserVersion','purchaseOrder','packingSlip'] loop
  if jsonb_typeof(j->k) is distinct from 'string' or length(j->>k)>80 then return false; end if;
 end loop;
 if length(j->>'parserVersion')=0 or jsonb_typeof(j->'fields') is distinct from 'array'
   or jsonb_array_length(j->'fields')>605 then return false; end if;
 for f in select value from jsonb_array_elements(j->'fields') loop
  if not atlas_routing_preview_private.exact_keys(f,array['field','original','reviewed','confidence','source'])
    or jsonb_typeof(f->'field') is distinct from 'string'
    or (f->>'field') !~ '^(orderNumber|customer|address|timeWindow|boxes|lines\.[0-9]{1,3}\.(sku|caseQty|itemQty))$'
    or jsonb_typeof(f->'original') is distinct from 'string' or length(f->>'original')>300
    or jsonb_typeof(f->'reviewed') is distinct from 'string' or length(f->>'reviewed')>300
    or jsonb_typeof(f->'source') is distinct from 'string'
    or (f->>'source') not in ('template','generic','manual') then return false; end if;
  if f->'confidence' <> 'null'::jsonb and (jsonb_typeof(f->'confidence') is distinct from 'number'
    or (f->>'confidence')::numeric not between 0 and 1) then return false; end if;
 end loop;
 return true;
exception when others then return false;
end $$;

-- Any saved-day revision invalidates its draft. A running lease is retained;
-- the new generation schedules one follow-up after that worker finishes.
create function atlas_scanner_private.enqueue_day() returns trigger
language plpgsql security definer set search_path='' as $$
begin
 if not exists(select 1 from atlas_scanner_private.settings where enabled) then return new; end if;
 if not exists(select 1 from public.warehouses where id=new.warehouse_id and code='CA' and active) then return new; end if;
 insert into atlas_scanner_private.planning(warehouse_id,planning_day,due_at)
 values(new.warehouse_id,new.planning_day,now()+interval '5 seconds')
 on conflict(warehouse_id,planning_day) do update set generation=atlas_scanner_private.planning.generation+1,
 due_at=now()+interval '5 seconds',status=case when atlas_scanner_private.planning.lease_until>now() then 'planning' else 'pending' end,
 error_code=null;
 return new;
end $$;
create trigger atlas_scanner_enqueue after insert or update of revision on atlas_routing_preview_private.days
for each row execute function atlas_scanner_private.enqueue_day();

create function public.atlas_routing_scanner_upload(p_warehouse text,p_day date,p_order jsonb,p_metadata jsonb,p_seed jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare w uuid; d atlas_routing_preview_private.days; existing jsonb; doc jsonb; saved jsonb; so text;
begin
 if p_warehouse is distinct from 'CA' or not atlas_routing_preview_private.can_access(true)
   or not atlas_pod_private.is_admin(auth.uid()) then
  raise exception using errcode='42501',message='ROUTING_ACCESS_DENIED'; end if;
 if not exists(select 1 from atlas_scanner_private.settings where enabled) then
  raise exception using errcode='0A000',message='SCANNER_DISABLED'; end if;
 if p_day is null or p_day not between date '2000-01-01' and date '2099-12-31'
   or not coalesce(atlas_scanner_private.valid_metadata(p_metadata),false)
   or jsonb_typeof(p_order) is distinct from 'object'
   or coalesce(p_order->>'orderNumber','') !~* '^SO(-US)?-[0-9]+$'
   or p_order->'dispatchedOn' is distinct from 'null'::jsonb
   or p_order->'deliveredOn' is distinct from 'null'::jsonb then
  raise exception using errcode='22023',message='INVALID_SCANNER_UPLOAD'; end if;
 select id into strict w from public.warehouses where code='CA' and active;
 so:=upper(btrim(p_order->>'orderNumber'));
 -- Serializes two first uploads even when the day row does not exist yet.
 perform pg_advisory_xact_lock(hashtextextended(w::text||':'||p_day::text,0));
 select * into d from atlas_routing_preview_private.days where warehouse_id=w and planning_day=p_day for update;
 if found then
  select value into existing from jsonb_array_elements(d.document->'orders') where upper(btrim(value->>'orderNumber'))=so;
  if existing is not null then
   return jsonb_build_object('warehouse','CA','canEdit',true,'document',d.document,'duplicate',true,'order',existing,'date',p_day,'revision',d.revision); end if;
  doc:=d.document;
  if doc->'schemaVersion' is distinct from '3'::jsonb then
   raise exception using errcode='0A000',message='ROUTING_CLIENT_UPDATE_REQUIRED'; end if;
 else
  if p_seed->'schemaVersion' is distinct from '3'::jsonb or p_seed->'orders' is distinct from '[]'::jsonb
    or p_seed->'lockedTrips' is distinct from '[]'::jsonb or p_seed->'assignments' is distinct from '{}'::jsonb
    or p_seed->'vanConfirmed' is distinct from '{}'::jsonb then
   raise exception using errcode='22023',message='INVALID_SCANNER_SEED'; end if;
  doc:=p_seed;
 end if;
 -- Preserve existing model rows; add only absent reference rows for newly scanned SKUs.
 doc:=jsonb_set(doc,'{catalog}',(doc->'catalog')||coalesce((select jsonb_agg(c) from atlas_scanner_private.settings s cross join lateral jsonb_array_elements(s.catalog) c where not exists(select 1 from jsonb_array_elements(doc->'catalog') old where old->>'model'=c->>'model')),'[]'::jsonb));
 p_order:=jsonb_set(p_order,'{orderNumber}',to_jsonb(so));
 doc:=jsonb_set(doc,'{orders}',(doc->'orders')||jsonb_build_array(p_order));
 saved:=atlas_routing_preview_private.save_day('CA',p_day,coalesce(d.revision,0),doc);
 insert into atlas_scanner_private.extractions(warehouse_id,planning_day,sales_order,order_id,created_by,metadata)
 values(w,p_day,so,(p_order->>'id')::uuid,auth.uid(),p_metadata);
 return saved||jsonb_build_object('duplicate',false,'order',p_order,'planningStatus','pending');
end $$;

-- Worker RPCs are service-only, never callable by browser users.
create function public.atlas_routing_scanner_claim() returns jsonb
language plpgsql security definer set search_path='' as $$
declare j atlas_scanner_private.planning; d atlas_routing_preview_private.days; token uuid;
begin
 if not exists(select 1 from atlas_scanner_private.settings where enabled) then return null; end if;
 perform pg_advisory_xact_lock(720260922);
 if exists(select 1 from atlas_scanner_private.planning where lease_until>now()) then return null; end if;
 select p.* into j from atlas_scanner_private.planning p join public.warehouses w on w.id=p.warehouse_id and w.code='CA' and w.active
 where (p.status='pending' or (p.status='planning' and p.lease_until<=now()))
 and p.due_at<=now() and (p.lease_until is null or p.lease_until<=now())
 order by p.due_at for update of p skip locked limit 1;
 if not found then return null; end if;
 select * into strict d from atlas_routing_preview_private.days where warehouse_id=j.warehouse_id and planning_day=j.planning_day;
 token:=gen_random_uuid();
 update atlas_scanner_private.planning set lease=token,lease_until=now()+interval '15 minutes',
 claimed_generation=generation,source_revision=d.revision,status='planning'
 where warehouse_id=j.warehouse_id and planning_day=j.planning_day;
 return jsonb_build_object('warehouse','CA','date',j.planning_day,'lease',token,'revision',d.revision,'document',d.document);
end $$;

create function public.atlas_routing_scanner_finish(p_day date,p_lease uuid,p_plan jsonb,p_error text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare w uuid; d atlas_routing_preview_private.days; j atlas_scanner_private.planning;
begin
 if not exists(select 1 from atlas_scanner_private.settings where enabled) then
  raise exception using errcode='0A000',message='SCANNER_DISABLED'; end if;
 select id into strict w from public.warehouses where code='CA' and active;
 -- Always lock the day before the queue, matching the upload/trigger lock order.
 select * into strict d from atlas_routing_preview_private.days where warehouse_id=w and planning_day=p_day for update;
 select * into strict j from atlas_scanner_private.planning where warehouse_id=w and planning_day=p_day for update;
 if p_lease is null or j.lease is distinct from p_lease or j.lease_until<=now() then
  raise exception using errcode='40001',message='SCANNER_LEASE_EXPIRED'; end if;
 if j.generation<>j.claimed_generation or d.revision<>j.source_revision then
  update atlas_scanner_private.planning set lease=null,lease_until=null,status='pending' where warehouse_id=w and planning_day=p_day;
  return jsonb_build_object('status','pending'); end if;
 if p_error is not null then
  if p_error not in ('PLANNING_FAILED','MISSING_SPECIFICATION','TRAFFIC_UNAVAILABLE') then
   raise exception using errcode='22023',message='INVALID_PLANNING_ERROR'; end if;
  update atlas_scanner_private.planning set lease=null,lease_until=null,status='attention',error_code=p_error
  where warehouse_id=w and planning_day=p_day;
  return jsonb_build_object('status','attention'); end if;
 if jsonb_typeof(p_plan) is distinct from 'object' or octet_length(p_plan::text)>600000
   or not atlas_routing_preview_private.exact_keys(p_plan,array['trips','unscheduled','warnings','timingStatus','timed'])
   or jsonb_typeof(p_plan->'trips') is distinct from 'array'
   or jsonb_typeof(p_plan->'unscheduled') is distinct from 'array'
   or jsonb_typeof(p_plan->'warnings') is distinct from 'array'
   or jsonb_typeof(p_plan->'timingStatus') is distinct from 'string'
   or p_plan->>'timingStatus' not in ('unavailable','estimated') then
  raise exception using errcode='22023',message='INVALID_DRAFT_PLAN'; end if;
 -- This sidecar never replaces orders, assignments, sent-out trips or delivery state.
 update atlas_scanner_private.planning set plan=p_plan,plan_revision=d.revision,status='updated',
 error_code=null,lease=null,lease_until=null where warehouse_id=w and planning_day=p_day;
 return jsonb_build_object('status','updated','revision',d.revision);
end $$;

create function public.atlas_routing_scanner_status(p_warehouse text,p_day date) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare w uuid; j atlas_scanner_private.planning;
begin
 if p_warehouse is distinct from 'CA' or not atlas_routing_preview_private.can_access(false) then
  raise exception using errcode='42501',message='ROUTING_ACCESS_DENIED'; end if;
 select id into strict w from public.warehouses where code='CA' and active;
 select * into j from atlas_scanner_private.planning where warehouse_id=w and planning_day=p_day;
 return jsonb_build_object('catalog',(select catalog from atlas_scanner_private.settings limit 1),'enabled',exists(select 1 from atlas_scanner_private.settings where enabled),'uploadedToday',(select count(*) from atlas_scanner_private.extractions e where e.warehouse_id=w and e.created_by=auth.uid() and (e.created_at at time zone 'America/Los_Angeles')::date=(now() at time zone 'America/Los_Angeles')::date),'currentRevision',coalesce((select revision from atlas_routing_preview_private.days where warehouse_id=w and planning_day=p_day),0),'status',coalesce(j.status,'idle'),'plan',j.plan,'planRevision',j.plan_revision,'error',j.error_code);
end $$;
create function public.atlas_routing_scanner_retry(p_warehouse text,p_day date) returns boolean
language plpgsql security definer set search_path='' as $$
declare w uuid; changed integer;
begin
 if p_warehouse is distinct from 'CA' or not atlas_routing_preview_private.can_access(true)
   or not atlas_pod_private.is_admin(auth.uid()) then
  raise exception using errcode='42501',message='ROUTING_ACCESS_DENIED'; end if;
 if not exists(select 1 from atlas_scanner_private.settings where enabled) then
  raise exception using errcode='0A000',message='SCANNER_DISABLED'; end if;
 select id into strict w from public.warehouses where code='CA' and active;
 update atlas_scanner_private.planning set status='pending',due_at=now(),error_code=null,
 generation=generation+1 where warehouse_id=w and planning_day=p_day and status='attention';
 get diagnostics changed=row_count;
 return changed=1;
end $$;
revoke all on all functions in schema atlas_scanner_private from public,anon,authenticated,service_role;
revoke all on function public.atlas_routing_scanner_upload(text,date,jsonb,jsonb,jsonb),public.atlas_routing_scanner_status(text,date),
 public.atlas_routing_scanner_retry(text,date),public.atlas_routing_scanner_claim(),public.atlas_routing_scanner_finish(date,uuid,jsonb,text) from public,anon,authenticated,service_role;
grant execute on function public.atlas_routing_scanner_upload(text,date,jsonb,jsonb,jsonb),public.atlas_routing_scanner_status(text,date),public.atlas_routing_scanner_retry(text,date) to authenticated;
grant execute on function public.atlas_routing_scanner_claim(),public.atlas_routing_scanner_finish(date,uuid,jsonb,text) to service_role;
commit;
