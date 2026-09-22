-- Synthetic prerequisite shapes only. Runs exclusively inside in-memory PGlite.
-- auth helpers simulate PostgREST claims; JWT cryptography/HTTP/storage are not tested here.
create role anon nologin;
create role authenticated nologin;
create role service_role nologin bypassrls;
create schema auth;
create schema storage;
create schema atlas_routing_preview_private;
create table auth.users(id uuid primary key, is_anonymous boolean default false,
 banned_until timestamptz, raw_app_meta_data jsonb default '{}');
create table auth.sessions(id uuid primary key,user_id uuid references auth.users,not_after timestamptz);
create function auth.jwt() returns jsonb language sql stable as $$
 select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb $$;
create function auth.uid() returns uuid language sql stable as $$select (auth.jwt()->>'sub')::uuid$$;
grant usage on schema auth to authenticated,anon,service_role;
create table public.warehouses(id uuid primary key,code text unique,active boolean default true);
create table public.profiles(user_id uuid primary key references auth.users,warehouse_id uuid references warehouses,role text);
create table public.profile_warehouse_access(user_id uuid references auth.users,warehouse_id uuid references warehouses,primary key(user_id,warehouse_id));
create table atlas_routing_preview_private.members(warehouse_id uuid references warehouses,user_id uuid references auth.users,permission text,enabled boolean);
create table atlas_routing_preview_private.days(warehouse_id uuid references warehouses,planning_day date,revision integer,document jsonb,primary key(warehouse_id,planning_day));
create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
-- Read-only verified helper definition from ATLAS, September 21, 2026.
create function atlas_routing_preview_private.can_access(p_write boolean)
returns boolean language sql stable security definer set search_path='' as $$
 select auth.uid() is not null and exists (
  select 1 from atlas_routing_preview_private.members m
  join public.warehouses w on w.id=m.warehouse_id and w.active and w.code='CA'
  join public.profiles p on p.user_id=m.user_id
  join auth.users u on u.id=m.user_id
  where m.user_id=auth.uid() and m.enabled and (not p_write or m.permission='editor')
  and lower(p.role::text) in ('admin','administrator','supervisor')
  and exists(select 1 from public.profile_warehouse_access a where a.user_id=m.user_id and a.warehouse_id=w.id)
  and not coalesce(u.is_anonymous,false) and (u.banned_until is null or u.banned_until<=now())
  and exists(select 1 from auth.sessions s where s.user_id=u.id and s.id::text=auth.jwt()->>'session_id' and (s.not_after is null or s.not_after>now()))
  and (lower(u.raw_app_meta_data->>'role') in ('admin','administrator','supervisor')
    or lower(u.raw_app_meta_data->>'atlas_role') in ('admin','administrator','supervisor')
    or exists(select 1 from jsonb_array_elements_text(case when jsonb_typeof(u.raw_app_meta_data->'roles')='array' then u.raw_app_meta_data->'roles' else '[]'::jsonb end) r(role) where lower(r.role) in ('admin','administrator','supervisor')))
 );
$$;
