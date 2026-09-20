import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createHandler } from '../supabase/functions/atlas-user-admin/handler.mjs';

// Tests the HTTP orchestration boundary, not a simulation of PostgreSQL triggers.
// Actual transactions, constraints and RLS are exercised in tests/staging.
function fixture() {
  const actor={id:randomUUID(),app_metadata:{role:'admin'}};
  const users=[],operations=new Map(),writes=[];
  let mode='ok',isAdmin=true;
  let injected=null;
  const commit=(id,data)=>{
    const marker=data.app_metadata?.atlas_assignment_request;
    writes.push({id,data});
    if(mode==='collision'){users.push({id:randomUUID(),login_name:marker.login_name,app_metadata:{}});return {error:{status:500,code:'unexpected_failure',message:'private unique constraint detail'}};}
    if(injected)return {error:injected};
    if(mode==='abort')return {error:{status:500,message:'private database detail'}};
    let user=users.find(u=>u.id===id);
    if(!user){user={id,app_metadata:{}};users.push(user);}
    if(marker){
      user.email=data.email;user.login_name=marker.login_name;user.app_metadata.login_key=marker.login_key;user.assignment_revision=marker.expected_revision+1;
      user.app_metadata.atlas_assignment_revision=user.assignment_revision;
      operations.set(marker.operation_id,{user_id:id,revision:user.assignment_revision,
        request:{role:marker.role,warehouse_code:marker.warehouse_code,login_name:marker.login_name,login_key:marker.login_key,display_name:marker.display_name}});
    }
    if(mode==='lost')return {error:{status:500,message:'response lost after commit'}};
    return {data:{user:{id,app_metadata:{}}},error:null}; // deliberately stale create response
  };
  const db={
    rpc:async(name,args)=>{
      assert.equal(name,'atlas_account_admin_snapshot');
      if(args.p_operation)return {data:operations.get(args.p_operation)||null,error:null};
      if(!isAdmin)return {error:{code:'42501'},data:null};
      return {data:structuredClone(users),error:null};
    },
    from(table){
      assert.equal(table,'warehouses','handler must never perform separate profile/access writes');
      return {select:()=>({eq:async()=>({data:[{id:'ca',code:'CA',active:true},{id:'tx',code:'TX',active:true}],error:null})})};
    },
    auth:{getUser:async token=>({data:{user:token==='session'?actor:null},error:null}),admin:{
      createUser:async data=>commit(randomUUID(),data),
      updateUserById:async(id,data)=>commit(id,data),
      getUserById:async id=>({data:{user:structuredClone(users.find(u=>u.id===id))},error:null}),
      deleteUser:async(id,soft)=>{writes.push({delete:id,soft});return {data:{},error:null};}
    }}
  };
  const handler=createHandler(()=>db);
  return {users,operations,writes,actor,setMode:v=>mode=v,setAdmin:v=>isAdmin=v,setError:v=>injected=v,
    call:async(body,token='session')=>{const r=await handler(new Request('https://fixture.invalid',{method:'POST',headers:{Authorization:'Bearer '+token},body:JSON.stringify(body)}));return {status:r.status,...await r.json()};}};
}
const input=(role='picker',warehouse_code='TX')=>({action:'create',operation_id:randomUUID(),display_name:role==='office_receiver'?warehouse_code+' COC Receiver':'Employee Display',login_name:role==='office_receiver'?warehouse_code+' COC Receiver':'Separate.Login',password:'synthetic-only-password',role,warehouse_code});
for(const [role,home] of [['picker','TX'],['supervisor','TX'],['office_receiver','TX'],['admin','TX'],['picker','CA']])
test('one Auth write and committed operation result: '+role+' '+home,async()=>{
  const f=fixture(),body=input(role,home),r=await f.call(body);
  assert.equal(r.status,200);assert.equal(r.assignment_revision,1);assert.equal(r.login_name,body.login_name);assert.equal(f.writes.length,1);
  const sent=f.writes[0].data;assert.equal(sent.app_metadata.atlas_assignment_request.actor_id,f.actor.id);
  assert.equal(sent.app_metadata.atlas_assignment_request.warehouse_code,home);
  assert.equal(sent.ban_duration,undefined);assert.equal(sent.app_metadata.role,undefined);
  assert.equal(JSON.stringify([...f.operations.values()]).includes(body.password),false);
});
for(const home of ['',null,{},'C-A','XX','OFF'])test('invalid warehouse rejected before Auth write: '+JSON.stringify(home),async()=>{
  const f=fixture();assert.equal((await f.call(input('picker',home))).status,400);assert.equal(f.writes.length,0);
});
test('response lost after commit resolves durable operation without compensation',async()=>{
  const f=fixture();f.setMode('lost');const body=input(),r=await f.call(body);
  assert.equal(r.status,200);assert.equal((await f.call(body)).user_id,r.user_id);assert.equal(f.writes.length,1);
});
test('failed uncommitted create is retryable without blind deletion',async()=>{
  const f=fixture();f.setMode('abort');const body=input(),r=await f.call(body);
  assert.equal(r.status,503);assert.doesNotMatch(r.error,/private database detail/);assert.equal(f.operations.size,0);
  f.setMode('ok');assert.equal((await f.call(body)).status,200);assert.equal(f.users.length,1);
});
test('operation cannot be reused with altered assignment',async()=>{
  const f=fixture(),body=input();await f.call(body);
  assert.equal((await f.call({...body,warehouse_code:'CA'})).status,409);assert.equal(f.writes.length,1);
});
test('update revision required; stale edit never writes; valid replay never writes again',async()=>{
  const f=fixture(),create=input(),made=await f.call(create);
  const update={...create,action:'update',user_id:made.user_id,operation_id:randomUUID(),warehouse_code:'CA'};
  assert.equal((await f.call(update)).status,409);
  assert.equal((await f.call({...update,expected_revision:0})).status,409);assert.equal(f.writes.length,1);
  assert.equal((await f.call({...update,expected_revision:1})).assignment_revision,2);
  assert.equal((await f.call({...update,expected_revision:1})).status,200);assert.equal(f.writes.length,2);
});
test('current database authorization rejects a stale admin token and editable role spoof',async()=>{
  const f=fixture();f.setAdmin(false);f.actor.user_metadata={role:'admin'};
  assert.equal((await f.call(input())).status,403);assert.equal((await f.call({action:'list'})).status,403);assert.equal(f.writes.length,0);
  assert.equal((await f.call({action:'list'},'bad')).status,401);
});
test('self-demotion can reconcile own committed operation without authorizing new work',async()=>{
  const f=fixture(),body=input();const first=await f.call(body);f.setAdmin(false);
  assert.equal((await f.call(body)).user_id,first.user_id);
  assert.equal((await f.call({...body,operation_id:randomUUID()})).status,403);
});
test('snapshot returned without inferring missing warehouse or grants',async()=>{
  const f=fixture();f.users.push({id:randomUUID(),warehouse_code:null,warehouse_access:[],assignment_revision:0});
  assert.deepEqual((await f.call({action:'list'})).users,f.users);
});
test('old clients require refresh; duplicate normalized login is rejected',async()=>{
  const f=fixture(),body=input();assert.equal((await f.call({...body,operation_id:undefined})).status,409);
  await f.call(body);assert.equal((await f.call({...body,operation_id:randomUUID(),login_name:' Separate.LOGIN '})).status,409);assert.equal(f.writes.length,1);
});
test('password updates remain Auth-only; deletion remains soft and self-delete denied',async()=>{
  const f=fixture(),made=await f.call(input());f.writes.length=0;
  assert.equal((await f.call({action:'password',user_id:made.user_id,password:'another-test-only-value'})).status,200);
  assert.deepEqual(Object.keys(f.writes[0].data),['password']);
  assert.equal((await f.call({action:'delete',user_id:f.actor.id})).status,409);
  assert.equal((await f.call({action:'delete',user_id:made.user_id})).status,200);assert.equal(f.writes[1].soft,true);
});

for(const code of ['CA','TX'])test(code+' Receiver assignment keeps visible names, hidden key and original UUID',async()=>{
 const f=fixture(),body=input('office_receiver',code),r=await f.call(body);
 assert.equal(r.status,200);assert.equal(r.login_name,code+' COC Receiver');assert.equal(r.login_key,undefined);
 const marker=f.writes[0].data.app_metadata.atlas_assignment_request;
 assert.equal(marker.login_key,code.toLowerCase()+'cocreceiver');assert.equal(marker.display_name,marker.login_name);assert.equal(marker.warehouse_code,code);
 assert.equal(f.writes[0].data.email,marker.login_key+'@users.atlas.invalid');
});
test('legacy null revision rename is explicit revision zero and preserves account UUID/password/relationships',async()=>{
 const f=fixture(),id=randomUUID(),old={id,login_name:'officecocstation',app_metadata:{},history:['existing-coc'],receiverId:'paired-device'};f.users.push(old);
 const body={...input('office_receiver','CA'),action:'update',user_id:id,expected_revision:0};
 const result=await f.call(body);assert.equal(result.status,200);assert.equal(result.user_id,id);assert.equal(result.assignment_revision,1);
 assert.equal(f.users.length,1);assert.deepEqual(old.history,['existing-coc']);assert.equal(old.receiverId,'paired-device');assert.equal(f.writes[0].data.password,undefined);
 assert.equal(old.email,'cacocreceiver@users.atlas.invalid');assert.notEqual(old.email,'officecocstation@users.atlas.invalid');
});
test('failed rename leaves fixture account and operation ledger unchanged',async()=>{
 const f=fixture(),made=await f.call(input('office_receiver','TX'));const before=structuredClone(f.users),ledger=structuredClone([...f.operations]);f.setMode('abort');
 const r=await f.call({...input('office_receiver','TX'),action:'update',user_id:made.user_id,expected_revision:1});assert.equal(r.status,503);assert.deepEqual(f.users,before);assert.deepEqual([...f.operations],ledger);
});
test('Receiver visible-name drift and wrong warehouse identity are rejected before Auth',async()=>{
 const f=fixture();for(const edit of [{display_name:'Wrong'},{login_name:'txcocreceiver'},{warehouse_code:'CA'}])assert.equal((await f.call({...input('office_receiver','TX'),...edit})).status,400);assert.equal(f.writes.length,0);
});
test('equivalent visible names cannot claim the same internal key',async()=>{
 const f=fixture();await f.call({...input(),login_name:'José Smith'});const r=await f.call({...input(),login_name:' JOSE   SMITH '});assert.equal(r.status,409);assert.equal(f.writes.length,1);
});
test('known backend failures become safe messages and never raw diagnostics',async()=>{
 const f=fixture();for(const [code,status] of [['email_exists',409],['LOGIN_KEY_COLLISION',409],['40001',409],['WAREHOUSE_INACTIVE_OR_UNKNOWN',400],['ACCOUNT_NOT_FOUND',404],['42501',403]]){
  f.setError({code,status:500,message:'sensitive internal detail'});const r=await f.call(input());assert.equal(r.status,status);assert.doesNotMatch(r.error,/sensitive internal detail/);
 }
});

test('concurrent unique failure becomes a safe conflict after fresh reconciliation',async()=>{
 const f=fixture();f.setMode('collision');const r=await f.call(input());assert.equal(r.status,409);assert.equal(r.error,'That sign-in name is already in use.');assert.equal(f.operations.size,0);assert.doesNotMatch(r.error,/private|constraint/);
});
