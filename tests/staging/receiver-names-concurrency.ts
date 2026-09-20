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

  const suffix=crypto.randomUUID().slice(0,8),name='Concurrent '+suffix;
  const made=await ok(admin,'atlas-user-admin',{action:'create',operation_id:crypto.randomUUID(),role:'picker',warehouse_code:'TX',display_name:'STAGING concurrency',login_name:name,password});
  const base={action:'update',user_id:made.user_id,expected_revision:1,role:'picker',warehouse_code:'TX',display_name:'STAGING concurrency'};
  const outcomes=await Promise.all([' A',' B'].map(extra=>request(admin,'atlas-user-admin',{...base,operation_id:crypto.randomUUID(),login_name:name+extra})));
  assert(outcomes.filter(x=>x.status===200).length===1&&outcomes.filter(x=>x.status!==200).length===1,'ONE_CONCURRENT_WINNER');
  const u=await db.auth.admin.getUserById(made.user_id);assert(u.data.user?.app_metadata.atlas_assignment_revision===2,'ONE_REVISION_INCREMENT');
  const winner=outcomes.find(x=>x.status===200)!;const meta=u.data.user!.app_metadata;assert(meta.login_name===winner.body.login_name&&u.data.user!.email===meta.login_key+'@users.atlas.invalid','CONSISTENT_WINNER');
  const dupe='Duplicate '+crypto.randomUUID().slice(0,8);
  const collisions=await Promise.all([dupe,dupe.toLowerCase().replace(' ','   ')].map(login_name=>request(admin,'atlas-user-admin',{action:'create',operation_id:crypto.randomUUID(),role:'picker',warehouse_code:'CA',display_name:'STAGING duplicate',login_name,password})));
  assert(collisions.filter(x=>x.status===200).length===1&&collisions.filter(x=>x.status!==200).length===1,'ONE_CANONICAL_KEY_WINNER');
  return Response.json({completed:true,checks:['Concurrent edits: one winner, one revision increment, consistent identity','Concurrent equivalent-name creates: one winner'],rejectedStatuses:{edit:outcomes.find(x=>x.status!==200)?.status,create:collisions.find(x=>x.status!==200)?.status},productionTouched:false});
 }catch(error){return Response.json({completed:false,checks,error:String(error.message).slice(0,200),productionTouched:false},{status:500});}
});
