import fs from 'node:fs';
import '../atlas-login.js';
const {rules}=globalThis.AtlasLogin;
const literal=s=>"'"+s.replaceAll("'","''")+"'";
const pgPattern=s=>s.replace(/\\u([0-9a-f]{4})/gi,(_,h)=>String.fromCharCode(parseInt(h,16)));
const baseline=JSON.parse(fs.readFileSync(new URL('../release/receiver-login-baseline.json',import.meta.url)));
const body=name=>baseline.find(f=>f.proname===name).definition.trim().replace(/;?$/,';');
let prepare=body('prepare_assignment');
const immediate=/    if tg_op='UPDATE' and previous_revision>0 and new.deleted_at is null\s+and lower\(new.email\)[\s\S]*?end if;/;
if(!immediate.test(prepare))throw Error('BASELINE_EMAIL_GUARD_CHANGED');
prepare=prepare.replace(immediate,'    -- Email may change before app_metadata within one Auth transaction.\n    -- The deferred consistency trigger validates the final identity at commit.');
prepare=prepare.replace('home_code text; target_role text; login_name text;', 'home_code text; target_role text; login_name text; login_key text;');
prepare=prepare.replaceAll("new.raw_app_meta_data->'roles',new.raw_app_meta_data->'warehouse_code'","new.raw_app_meta_data->'roles',new.raw_app_meta_data->'login_name',new.raw_app_meta_data->'login_key',new.raw_app_meta_data->'warehouse_code'");
prepare=prepare.replaceAll("old.raw_app_meta_data->'roles',old.raw_app_meta_data->'warehouse_code'","old.raw_app_meta_data->'roles',old.raw_app_meta_data->'login_name',old.raw_app_meta_data->'login_key',old.raw_app_meta_data->'warehouse_code'");
prepare=prepare.replace("login_name := request->>'login_name';","login_name := atlas_account_private.visible_login_name(request->>'login_name');\n  login_key := atlas_account_private.login_key(login_name);\n  if request ? 'login_key' and login_key is distinct from request->>'login_key' then raise exception 'LOGIN_KEY_INVALID' using errcode='22023'; end if;");
prepare=prepare.replace(/if login_name is null or login_name !~ '[^']+' or lower\(new.email\) is distinct from login_name\|\|'@users.atlas.invalid' then/,"if lower(new.email) is distinct from login_key||'@users.atlas.invalid' then");
prepare=prepare.replace("  lock table public.warehouses in share mode;",`  if target_role='office_receiver' and (home_code not in ('CA','TX') or login_name is distinct from home_code||' COC Receiver' or display_name is distinct from login_name) then
    raise exception 'RECEIVER_IDENTITY_MISMATCH' using errcode='22023';
  end if;
  if exists(select 1 from auth.users u where u.id<>new.id and u.deleted_at is null
    and lower(u.email)=login_key||'@users.atlas.invalid') then
    raise exception 'LOGIN_KEY_COLLISION' using errcode='23505';
  end if;
  lock table public.warehouses in share mode;`);
prepare=prepare.replace("'atlas_role',target_role,'login_name',login_name,","'atlas_role',target_role,'login_name',login_name,'login_key',login_key,");
let consistency=body('check_consistency');
consistency=consistency.replace('  select * into p from public.profiles',`  if lower(u.email) is distinct from coalesce(u.raw_app_meta_data->>'login_key',u.raw_app_meta_data->>'login_name')||'@users.atlas.invalid' then
    raise exception 'ASSIGNMENT_PROTOCOL_REQUIRED' using errcode='23514';
  end if;
  if u.raw_app_meta_data ? 'login_key' and u.raw_app_meta_data->>'login_key' is distinct from atlas_account_private.login_key(u.raw_app_meta_data->>'login_name') then
    raise exception 'LOGIN_KEY_INVALID' using errcode='23514';
  end if;
  select * into p from public.profiles`);
let capture=body('capture_request').replace("'login_name',new.raw_app_meta_data->>'login_name',","'login_name',new.raw_app_meta_data->>'login_name',\n    'login_key',new.raw_app_meta_data->>'login_key',");
const helpers=`-- Generated from atlas-login.js rules; do not maintain another canonicalizer.
create or replace function atlas_account_private.visible_login_name(value text) returns text
language plpgsql immutable set search_path='' as $$
declare result text;
begin
  result:=btrim(regexp_replace(normalize(value,NFKC),${literal(pgPattern(rules.whitespace))},' ','g'));
  if result is null or length(result) not between 2 and ${rules.visibleMaximum} or position('@' in result)>0 then
    raise exception 'LOGIN_NAME_INVALID' using errcode='22023'; end if;
  return result;
end $$;
create or replace function atlas_account_private.login_key(value text) returns text
language plpgsql immutable set search_path='' as $$
declare folded text; result text;
begin
  folded:=regexp_replace(normalize(atlas_account_private.visible_login_name(value),NFKD),${literal(pgPattern(rules.marks))},'','g');
  if folded !~ ${literal(rules.allowed)} then raise exception 'LOGIN_NAME_INVALID' using errcode='22023'; end if;
  result:=replace(translate(folded,'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz'),' ','');
  if result !~ ${literal(rules.keyAllowed)} then raise exception 'LOGIN_KEY_INVALID' using errcode='22023'; end if;
  return result;
end $$;
revoke all on function atlas_account_private.visible_login_name(text), atlas_account_private.login_key(text) from public,anon,authenticated;
-- Include legacy email keys without changing any existing account. The index
-- serializes concurrent claims even before assignment metadata arrives.
create table atlas_account_private.login_keys (
  login_key text primary key,
  user_id uuid not null unique references auth.users(id) on delete cascade deferrable initially deferred
);
alter table atlas_account_private.login_keys enable row level security;
revoke all on atlas_account_private.login_keys from public,anon,authenticated;
insert into atlas_account_private.login_keys(login_key,user_id)
  select lower(split_part(email,'@',1)),id from auth.users
  where deleted_at is null and lower(email) like '%@users.atlas.invalid';
create or replace function atlas_account_private.reserve_login_key() returns trigger
language plpgsql security definer set search_path='' as $$
declare proposed text;
begin
  if new.deleted_at is null and lower(new.email) like '%@users.atlas.invalid' then proposed:=lower(split_part(new.email,'@',1)); end if;
  delete from atlas_account_private.login_keys where user_id=new.id and login_key is distinct from proposed;
  if proposed is not null then
    insert into atlas_account_private.login_keys(login_key,user_id) values(proposed,new.id) on conflict(login_key) do nothing;
    if not exists(select 1 from atlas_account_private.login_keys where login_key=proposed and user_id=new.id) then
      raise exception 'LOGIN_KEY_COLLISION' using errcode='23505';
    end if;
  end if;
  return new;
end $$;
revoke all on function atlas_account_private.reserve_login_key() from public,anon,authenticated;
create trigger atlas_reserve_login_key before insert or update of email,deleted_at on auth.users
  for each row execute function atlas_account_private.reserve_login_key();
`;
const diagnostics = definition => definition.replace(/end (\$function\$|\$fn\$|\$\$);$/, `exception when others then
  raise log 'ATLAS_ASSIGNMENT_FAILED category=% sqlstate=%',
    case when SQLERRM in ('ASSIGNMENT_PROTOCOL_REQUIRED','ASSIGNMENT_REVISION_CONFLICT','ACCOUNT_ASSIGNMENT_INCONSISTENT','LOGIN_NAME_INVALID','LOGIN_KEY_INVALID','LOGIN_KEY_COLLISION','RECEIVER_IDENTITY_MISMATCH','ADMINISTRATOR_REQUIRED','WAREHOUSE_REQUIRED_OR_INVALID') then SQLERRM else 'DATABASE_TRANSACTION_FAILED' end, SQLSTATE;
  raise;
end $1;`);
prepare=diagnostics(prepare);consistency=diagnostics(consistency);
const sql=["set local lock_timeout='5s';",helpers,prepare,consistency,capture,"notify pgrst,'reload schema';"].join('\n\n');
fs.writeFileSync(new URL('../release/receiver-login-proposal.json',import.meta.url),JSON.stringify({status:'PREPARED ONLY — NOT APPLIED',name:'atlas_receiver_visible_login_names',sql},null,2)+'\n');
console.log('Generated review-only database proposal from verified deployed functions and shared login rules.');
