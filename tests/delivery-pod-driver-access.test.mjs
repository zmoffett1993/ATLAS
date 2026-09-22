import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
const require=createRequire(new URL('../tools/delivery-pod/package.json',import.meta.url));
const {PGlite}=require('@electric-sql/pglite');
const id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const ca=id(1),tx=id(2),admin=id(10),supervisor=id(11),driver=id(12),backup=id(13),texas=id(14),order=id(30),day='2026-09-21';
test('driver assignment and administrator-only editing on isolated PostgreSQL',async t=>{
 const db=await PGlite.create();t.after(()=>db.close());
 const q=(sql,args=[])=>db.query(sql,args),value=async(sql,args=[])=>Object.values((await q(sql,args)).rows[0])[0];
 const user=async who=>{await db.exec('reset role');await q("select set_config('request.jwt.claims',$1,false)",[JSON.stringify({sub:who,session_id:id(Number(who.slice(-12))+100),user_metadata:{role:'admin'}})]);await db.exec('set role authenticated');};
 const scenario=(name,fn)=>t.test(name,async()=>{await db.exec('reset role; begin');try{await fn();}finally{await db.exec('rollback; reset role');}});
 await db.exec(await readFile(new URL('../tools/delivery-pod/test-prerequisites.sql',import.meta.url),'utf8'));
 await db.exec("alter table public.profiles add column display_name text; insert into storage.buckets values('atlas-pod-originals','atlas-pod-originals',false,15000000,array['image/jpeg','image/png']),('atlas-pod-documents','atlas-pod-documents',false,25000000,array['application/pdf'])");
 for(const file of ['schema-draft.sql','email-schema-draft.sql','driver-access-draft.sql'])await db.exec(await readFile(new URL('../tools/delivery-pod/'+file,import.meta.url),'utf8'));
 await db.exec("create function public.test_routing_access(write_access boolean) returns boolean language sql security definer set search_path='' as $$select atlas_routing_preview_private.can_access(write_access)$$");
 await q("insert into warehouses values($1,'CA',true),($2,'TX',true)",[ca,tx]);
 for(const who of [admin,supervisor,driver,backup,texas]){
  const role=who===admin?'admin':who===supervisor?'supervisor':'picker',wh=who===texas?tx:ca;
  await q('insert into auth.users(id,raw_app_meta_data) values($1,$2)',[who,{role}]);
  await q('insert into auth.sessions values($1,$2,null)',[id(Number(who.slice(-12))+100),who]);
  await q('insert into profiles values($1,$2,$3,$4)',[who,wh,role,who===driver?'Bubba':who===backup?'Backup worker':role]);
  await q('insert into profile_warehouse_access values($1,$2)',[who,wh]);
 }
 for(const who of [admin,supervisor]){
  await q("insert into atlas_pod_private.members values($1,$2,'office',true)",[ca,who]);
  await q("insert into atlas_routing_preview_private.members values($1,$2,'editor',true)",[ca,who]);
 }
 await q("insert into atlas_pod_private.members values($1,$2,'driver',true)",[ca,driver]);
 const doc={orders:[{id:order,orderNumber:'SO-123',customer:'Synthetic customer',address:'Test address',dispatchedOn:day,timeWindow:'8 AM–2 PM',checkOnDelivery:true,notes:'Dock 2'}],lockedTrips:[{assignment:'Bubba:truck',palletSpaces:4,shipments:[{orderId:order,palletSpaces:4,boxAllocation:[{sku:'TEST',boxes:80}]}]}]};
 await q('insert into atlas_routing_preview_private.days values($1,$2,1,$3)',[ca,day,doc]);
 const assign=(who=backup,revision=1)=>value('select public.atlas_pod_assign_trip($1,$2,0,$3)',[day,revision,who]);
 const list=()=>value('select public.atlas_pod_list($1)',[day]);

 await scenario('administrator assigns a backup worker atomically; repeat is idempotent',async()=>{
  await user(admin);assert.equal((await assign()).assigned,1);assert.equal((await assign()).assigned,1);
  await db.exec('reset role');assert.equal(await value('select count(*)::int from atlas_pod_private.bindings'),1);
  assert.equal(await value("select count(*)::int from atlas_pod_private.events where event='binding_created'"),1);
  await user(backup);const s=(await list()).shipments[0];assert.equal(s.sales_order,'SO-123');assert.equal(s.source_shipment.palletSpaces,4);assert.equal(s.delivery.checkOnDelivery,true);assert.equal(s.delivery.timeWindow,'8 AM–2 PM');assert.equal(s.driver_name,'Backup worker');
  await user(driver);assert.deepEqual((await list()).shipments,[]);
 });
 await scenario('supervisor can read but cannot edit routes or assign a driver',async()=>{
  await user(admin);await assign();await user(supervisor);
  assert.equal(await value('select public.test_routing_access(false)'),true);
  assert.equal(await value('select public.test_routing_access(true)'),false);
  assert.equal((await value('select public.atlas_pod_driver_access()')).capability,'viewer');
  assert.equal((await list()).shipments.length,1);
  await assert.rejects(assign(),{code:'42501'});
 });
 await scenario('supervisor cannot submit a POD even through the privileged receipt adapter',async()=>{
  await user(admin);await assign();const b=(await list()).shipments[0];await db.exec('reset role');
  await assert.rejects(q('select public.atlas_pod_receive($1,$2,$3,$4,$5,$6,1,null)',[b.id,supervisor,id(111),id(40),'a'.repeat(64),'POD-SO-123.pdf']),{code:'42501'});
 });
 await scenario('supervisor cannot send or retry email through a server claim',async()=>{
  await user(admin);await assign();const b=(await list()).shipments[0];await db.exec('reset role');
  await q('select public.atlas_pod_receive($1,$2,$3,$4,$5,$6,1,$7)',[b.id,backup,id(113),id(40),'a'.repeat(64),'POD-SO-123.pdf','b'.repeat(64)]);
  await assert.rejects(q("select public.atlas_pod_email_claim($1,$2,$3,$4,'send')",[id(40),supervisor,id(111),id(41)]),{code:'42501'});
 });
 await scenario('unassigned worker sees empty deliveries and cannot self-assign',async()=>{
  await user(backup);assert.equal((await value('select public.atlas_pod_driver_access()')).capability,'unassigned');assert.deepEqual((await list()).shipments,[]);await assert.rejects(assign(),{code:'42501'});
 });
 await scenario('TX workers cannot open CA driver access',async()=>{
  await user(texas);await assert.rejects(value('select public.atlas_pod_driver_access()'),{code:'42501'});
 });
 await scenario('a promoted supervisor cannot retain writable driver access',async()=>{
  await q("update profiles set role='supervisor' where user_id=$1",[driver]);
  await q('update auth.users set raw_app_meta_data=$2 where id=$1',[driver,{role:'supervisor'}]);
  await user(driver);await assert.rejects(value('select public.atlas_pod_driver_access()'),{code:'42501'});
 });
 await scenario('stale saved revision does not grant a worker access',async()=>{
  await user(admin);await db.exec('savepoint attempt');await assert.rejects(assign(backup,99),{code:'40001'});await db.exec('rollback to attempt; reset role');
  assert.equal(await value('select count(*)::int from atlas_pod_private.members where user_id=$1',[backup]),0);
 });
 await scenario('an existing assignment cannot be silently transferred',async()=>{
  await user(admin);await assign(driver);await assert.rejects(assign(backup),/POD_TRIP_ALREADY_ASSIGNED/);
 });
 await scenario('incomplete split allocation rolls back the entire assignment and membership',async()=>{
  await q("update atlas_routing_preview_private.days set document=document #- '{orders,0,dispatchedOn}'");await user(admin);await db.exec('savepoint attempt');
  await assert.rejects(assign(),/COMPLETE_SHIPMENT_ALLOCATION_REQUIRED/);await db.exec('rollback to attempt; reset role');
  assert.equal(await value('select count(*)::int from atlas_pod_private.bindings'),0);
  assert.equal(await value('select count(*)::int from atlas_pod_private.members where user_id=$1',[backup]),0);
 });
 await scenario('revoked session and user-editable admin claim cannot permit assignments',async()=>{
  await q('delete from auth.sessions where user_id=$1',[admin]);await user(admin);await assert.rejects(assign(),{code:'42501'});
 });
 await scenario('new RPCs remain unavailable anonymously and private tables stay closed',async()=>{
  assert.equal(await value("select has_function_privilege('anon','public.atlas_pod_assign_trip(date,integer,integer,uuid)','EXECUTE')"),false);
  assert.equal(await value("select has_table_privilege('authenticated','atlas_pod_private.bindings','SELECT')"),false);
 });
});
