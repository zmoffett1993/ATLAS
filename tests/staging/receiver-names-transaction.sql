begin;
do $test$
declare actor uuid; subject uuid:=gen_random_uuid(); op uuid; initial jsonb; initial_profile jsonb; initial_grants jsonb; initial_keys jsonb; operation_count bigint;
begin
 select user_id into strict actor from public.profiles where display_name='STAGING admin TX';
 insert into auth.users(id,email,raw_app_meta_data) values(subject,'namesrollbackbase@users.atlas.invalid',jsonb_build_object('atlas_assignment_request',jsonb_build_object('actor_id',actor,'operation_id',gen_random_uuid(),'expected_revision',0,'role','picker','warehouse_code','TX','login_name','Names Rollback Base','login_key','namesrollbackbase','display_name','STAGING rollback')));
 set constraints all immediate;
 set constraints all deferred;
 select to_jsonb(u) into initial from auth.users u where id=subject;
 select to_jsonb(p) into initial_profile from public.profiles p where user_id=subject;
 select jsonb_agg(to_jsonb(a)) into initial_grants from public.profile_warehouse_access a where user_id=subject;
 select jsonb_agg(to_jsonb(k)) into initial_keys from atlas_account_private.login_keys k where user_id=subject;
 select count(*) into operation_count from atlas_account_private.operations where user_id=subject;
 begin
  update auth.users set email='namesrollbackchanged@users.atlas.invalid' where id=subject;
  update auth.users set raw_app_meta_data=raw_app_meta_data||jsonb_build_object('atlas_assignment_request',jsonb_build_object('actor_id',actor,'operation_id',gen_random_uuid(),'expected_revision',1,'role','picker','warehouse_code','CA','login_name','Names Rollback Changed','login_key','namesrollbackchanged','display_name','STAGING changed')) where id=subject;
  set constraints all immediate;
  if not exists(select 1 from auth.users where id=subject and raw_app_meta_data->>'login_name'='Names Rollback Changed') then raise exception 'RENAMED_STATE_MISSING'; end if;
  raise exception 'SYNTHETIC_POST_ASSIGNMENT_FAILURE' using errcode='P0002';
 exception when no_data_found then
  if sqlerrm<>'SYNTHETIC_POST_ASSIGNMENT_FAILURE' then raise; end if;
 end;
 if (select to_jsonb(u) from auth.users u where id=subject) is distinct from initial or (select to_jsonb(p) from public.profiles p where user_id=subject) is distinct from initial_profile or (select jsonb_agg(to_jsonb(a)) from public.profile_warehouse_access a where user_id=subject) is distinct from initial_grants or (select jsonb_agg(to_jsonb(k)) from atlas_account_private.login_keys k where user_id=subject) is distinct from initial_keys or (select count(*) from atlas_account_private.operations where user_id=subject)<>operation_count then raise exception 'ROLLBACK_RESIDUE'; end if;
 begin
  update auth.users set email='namesbypass@users.atlas.invalid' where id=subject;
  set constraints all immediate;
  raise exception 'UNMARKED_RENAME_ALLOWED';
 exception when check_violation then
  if sqlerrm<>'ASSIGNMENT_PROTOCOL_REQUIRED' then raise; end if;
 end;
 begin
  update auth.users set raw_app_meta_data=raw_app_meta_data||jsonb_build_object('atlas_assignment_request',jsonb_build_object('actor_id',actor,'operation_id',gen_random_uuid(),'expected_revision',0,'role','picker','warehouse_code','TX','login_name','Names Rollback Base','login_key','namesrollbackbase','display_name','STAGING stale')) where id=subject;
  raise exception 'STALE_REVISION_ALLOWED';
 exception when serialization_failure then
  if sqlerrm<>'ASSIGNMENT_REVISION_CONFLICT' then raise; end if;
 end;
 if (select to_jsonb(u) from auth.users u where id=subject) is distinct from initial then raise exception 'FAILED_GUARD_MUTATED_USER'; end if;
end $test$;
rollback;
select 'PASS email-first rename, deferred final consistency, complete rollback across identity/profile/grants/key claims/operations, unmarked rename denied, stale revision denied; no test data retained' as result;
