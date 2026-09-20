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
  const commit=(id,data)=>{
    const marker=data.app_metadata?.atlas_assignment_request;
    writes.push({id,data});
    if(mode==='abort')return {error:{status:500,message:'private database detail'}};
    let user=users.find(u=>u.id===id);
    if(!user){user={id,app_metadata:{}};users.push(user);}
    if(marker){
      user.login_name=marker.login_name;user.assignment_revision=marker.expected_revision+1;
      user.app_metadata.atlas_assignment_revision=user.assignment_revision;
      operations.set(marker.operation_id,{user_id:id,revision:user.assignment_revision,
        request:{role:marker.role,warehouse_code:marker.warehouse_code,login_name:marker.login_name,display_name:marker.display_name}});
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
  return {users,operations,writes,actor,setMode:v=>mode=v,setAdmin:v=>isAdmin=v,
    call:async(body,token='session')=>{const r=await handler(new Request('https://fixture.invalid',{method:'POST',headers:{Authorization:'Bearer '+token},body:JSON.stringify(body)}));return {status:r.status,...await r.json()};}};
}
const input=(role='picker',warehouse_code='TX')=>({action:'create',operation_id:randomUUID(),display_name:'Employee Display',login_name:'Separate.Login',password:'synthetic-only-password',role,warehouse_code});
for(const [role,home] of [['picker','TX'],['supervisor','TX'],['office_receiver','TX'],['admin','TX'],['picker','CA']])
test('one Auth write and committed operation result: '+role+' '+home,async()=>{
  const f=fixture(),body=input(role,home),r=await f.call(body);
  assert.equal(r.status,200);assert.equal(r.assignment_revision,1);assert.equal(r.login_name,'separate.login');assert.equal(f.writes.length,1);
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
