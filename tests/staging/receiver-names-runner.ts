// Temporary staging-only audit endpoint. No credential or workbook contents in results.
import { createClient } from 'npm:@supabase/supabase-js@2.57.4';
const TARGET='https://qiaixkmwnfnondiwdmya.supabase.co';
const EXPECTED_HASH='__RUN_HASH__';
const pacedFetch=async(input:any,init?:any)=>{
 for(let attempt=0;;attempt++){
  try{
   const r=await fetch(input,init);
   if(r.status!==429||attempt>=3)return r;
   await new Promise(resolve=>setTimeout(resolve,20000));
  }catch(error){
   if(attempt>=3||!/Rate limit exceeded/.test(String(error)))throw error;
   await new Promise(resolve=>setTimeout(resolve,20000));
  }
 }
};
const options={auth:{persistSession:false,autoRefreshToken:false},global:{fetch:pacedFetch}};
const digest=async(bytes:Uint8Array)=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))).map(b=>b.toString(16).padStart(2,'0')).join('');
const decode=(s:string)=>Uint8Array.from(atob(s),c=>c.charCodeAt(0));
const assert=(ok:unknown,name:string)=>{if(!ok)throw new Error(name);};
Deno.serve(async req=>{
 if(req.method!=='POST'||Deno.env.get('SUPABASE_URL')!==TARGET)return new Response(null,{status:403});
 const nonce=(req.headers.get('Authorization')||'').replace(/^Bearer /,'');
 if(await digest(new TextEncoder().encode(nonce))!==EXPECTED_HASH)return new Response(null,{status:401});
 const db=createClient(TARGET,Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,options);
 const key=Deno.env.get('SUPABASE_ANON_KEY')!;
 const checks:string[]=[],findings:string[]=[];
 const request=async(user:any,name:string,body:unknown,credentials:any=null)=>{
  const headers:any={Authorization:'Bearer '+user.token,apikey:key,'Content-Type':'application/json'};
  if(credentials){headers['X-Atlas-Receiver-Id']=credentials.id;headers['X-Atlas-Receiver-Secret']=credentials.secret;}
  const r=await pacedFetch(TARGET+'/functions/v1/'+name,{method:'POST',headers,body:JSON.stringify(body)});
  return {status:r.status,body:await r.json()};
 };
 const ok=async(user:any,name:string,body:any,credentials:any=null)=>{
  const r=await request(user,name,body,credentials);
  assert(r.status===200,name+':'+body.action+':'+r.status+':'+String(r.body.error||'').slice(0,120));return r.body;
 };
 try{

  const seed=await db.from('profiles').select('user_id').eq('display_name','STAGING admin TX').single();assert(seed.data,'SEED_ADMIN');
  const password=crypto.randomUUID()+crypto.randomUUID(),adminName='names-admin-'+crypto.randomUUID().slice(0,8);
  const created=await db.auth.admin.createUser({email:adminName+'@users.atlas.invalid',password,email_confirm:true,app_metadata:{atlas_assignment_request:{actor_id:seed.data.user_id,operation_id:crypto.randomUUID(),expected_revision:0,role:'admin',warehouse_code:'TX',login_name:adminName,login_key:adminName,display_name:'STAGING naming audit administrator'}}});assert(!created.error,'ADMIN_CREATE');
  const signIn=async(email:string,pass=password)=>{const client=createClient(TARGET,key,options);const r=await client.auth.signInWithPassword({email,password:pass});return {client,result:r,token:r.data.session?.access_token,id:r.data.user?.id};};
  const admin=await signIn(adminName+'@users.atlas.invalid');assert(admin.token,'ADMIN_SIGN_IN');
  const records:any[]=[];
  for(const warehouse of ['CA','TX']){

    const oldName='names-'+warehouse.toLowerCase()+'-'+crypto.randomUUID().slice(0,8);

    const fixture=await db.auth.admin.createUser({email:oldName+'@users.atlas.invalid',password,email_confirm:true,app_metadata:{role:'office_receiver',atlas_role:'office_receiver',login_name:oldName,home_warehouse_code:warehouse,warehouse_code:warehouse,warehouse_access:[warehouse]},user_metadata:{display_name:'STAGING naming '+warehouse}});
    assert(!fixture.error&&fixture.data.user,'FIXTURE_CREATE_'+warehouse+':'+String(fixture.error?.code||''));const id=fixture.data.user.id;
    const w=await db.from('warehouses').select('id').eq('code',warehouse).single();
    assert(!(await db.from('profiles').update({warehouse_id:w.data!.id}).eq('user_id',id)).error,'FIXTURE_PROFILE_HOME');
    assert(!(await db.from('profile_warehouse_access').insert({user_id:id,warehouse_id:w.data!.id,granted_by_user_id:admin.id})).error,'FIXTURE_GRANT');
    // Reproduce the trusted pre-upgrade revision-1 office identity without renaming it.
    if(warehouse==='TX')assert(!(await db.auth.admin.updateUserById(id,{app_metadata:{atlas_assignment_revision:1,atlas_assignment_actor_id:admin.id}})).error,'MANAGED_FIXTURE');
    const office=await signIn(oldName+'@users.atlas.invalid');assert(office.id===id,'OLD_SIGN_IN');
    const credential={id:crypto.randomUUID(),secret:crypto.randomUUID()+crypto.randomUUID()},stationKey=warehouse==='CA'?'OFFICE_COC_01':'OFFICE_COC_TX';
    const pairing=await ok(office,'coc-receiver',{action:'create-pairing',warehouseCode:warehouse,devicePublicId:credential.id,deviceSecret:credential.secret,deviceDescription:'STAGING naming audit'});
    await ok(admin,'coc-receiver',{action:'approve-pairing',warehouseCode:warehouse,pairingCode:pairing.pairingCode,replaceExisting:true});
    await ok(office,'coc-receiver',{action:'verify-receiver',stationKey},credential);
    const body={action:'update',user_id:id,operation_id:crypto.randomUUID(),expected_revision:warehouse==='CA'?0:1,role:'office_receiver',warehouse_code:warehouse,display_name:warehouse+' COC Receiver',login_name:warehouse+' COC Receiver'};
    const renamed=await ok(admin,'atlas-user-admin',body);assert(renamed.user_id===id&&renamed.assignment_revision===body.expected_revision+1,'RENAME_UUID_REVISION');
    const replay=await ok(admin,'atlas-user-admin',body);assert(replay.assignment_revision===renamed.assignment_revision,'IDEMPOTENT_REPLAY');
    const altered=await request(admin,'atlas-user-admin',{...body,role:'picker'});assert(altered.status===409,'OPERATION_REUSE_DENIED');
    const stale=await request(admin,'atlas-user-admin',{...body,operation_id:crypto.randomUUID()});assert(stale.status===409,'STALE_REVISION_DENIED');
    const old=await signIn(oldName+'@users.atlas.invalid');assert(old.result.error&&!old.token,'OLD_SIGN_IN_DENIED');
    const current=await signIn(warehouse.toLowerCase()+'cocreceiver@users.atlas.invalid');assert(current.id===id,'NEW_SIGN_IN_SAME_USER_PASSWORD');
    const refreshed=await office.client.auth.refreshSession();assert(!refreshed.error&&refreshed.data.user?.id===id,'EXISTING_SESSION_REFRESH');
    await ok(current,'coc-receiver',{action:'verify-receiver',stationKey},credential);
    const user=await db.auth.admin.getUserById(id);const meta=user.data.user?.app_metadata;assert(meta?.login_name===body.login_name&&meta?.login_key===warehouse.toLowerCase()+'cocreceiver'&&meta?.home_warehouse_code===warehouse&&JSON.stringify(meta?.warehouse_access)===JSON.stringify([warehouse]),'TRUSTED_METADATA');
    const profile=await db.from('profiles').select('display_name,warehouse_id').eq('user_id',id).single();assert(profile.data?.display_name===body.display_name,'PROFILE_DISPLAY');
    const grants=await db.from('profile_warehouse_access').select('warehouse_id').eq('user_id',id);assert(grants.data?.length===1&&grants.data[0].warehouse_id===profile.data.warehouse_id,'HOME_ONLY_GRANT');
    const duplicate=await request(admin,'atlas-user-admin',{action:'create',operation_id:crypto.randomUUID(),role:'picker',warehouse_code:warehouse,display_name:'STAGING duplicate',login_name:warehouse.toLowerCase()+'   coc receiver',password});assert(duplicate.status===409,'CANONICAL_DUPLICATE_DENIED');
    checks.push(warehouse+' rename/legacy upgrade, UUID/password preserved, old sign-in denied, new sign-in accepted, session refresh, pairing preserved, replay/stale/operation/collision guards');
    records.push({warehouse,id,office:current,credential,stationKey});
  }
  for(const own of records){const other=records.find(r=>r.warehouse!==own.warehouse);const denied=await request(own.office,'coc-receiver',{action:'verify-receiver',stationKey:other.stationKey},other.credential);assert(denied.status===403,'FOREIGN_RECEIVER_DENIED');}
  checks.push('CA/TX foreign Receiver access rejected after renames');
  const list=await ok(admin,'atlas-user-admin',{action:'list'});for(const row of records){const user=list.users.find((u:any)=>u.id===row.id);assert(user?.login_name===row.warehouse+' COC Receiver'&&user?.display_name===user.login_name&&!('login_key' in user),'VISIBLE_ACCOUNT_LIST');}
  checks.push('Account list returns exact visible names without hidden login keys');
  return Response.json({completed:true,checks,productionTouched:false});
 }catch(error){return Response.json({completed:false,checks,error:String((error as Error).message).slice(0,200),productionTouched:false},{status:500});}
});
