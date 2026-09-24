import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import assignment from '../atlas-routing-assignment.js';
import storage from '../atlas-routing-storage.js';
const require=createRequire(new URL('../tools/delivery-pod/package.json',import.meta.url));
const {PGlite}=require('@electric-sql/pglite');
const id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const ca=id(1),tx=id(2),admin=id(10),supervisor=id(11),bubba=id(12),backup=id(13),texas=id(14),receiver=id(15),tester=id(16),tester2=id(17),multi=id(18),day='2026-09-22';
const a=(who=bubba,name='Bubba')=>({driverUserId:who,driverName:name,vehicleId:'box_truck',scheduleId:'standard'});
const document=()=>storage.document({schemaVersion:4,date:day,orders:[{id:id(30),orderNumber:'SO-123',customer:'Synthetic customer',address:'100 Test Street',city:'Fullerton',timeWindow:'',notes:'',serviceMinutes:25,checkOnDelivery:false,dispatchedOn:day,lines:[{sku:'TEST',caseQty:20,itemQty:null}]}],catalog:[],settings:{truckPalletTarget:11,dailyTripTarget:3,reloadMinutes:40,lunch:'12:00',preserveOrder:false},assignments:{0:a()},vanConfirmed:{0:false},lockedTrips:[{assignment:a(),shipments:[{orderId:id(30),palletSpaces:1,boxAllocation:[{sku:'TEST',boxes:20}]}],palletSpaces:1,vanConfirmed:false,sentOn:day,completedOrderIds:[id(30)]}]});

test('structured assignments preserve identity, exact keys, vehicle and ambiguous legacy review',()=>{
 assert.deepEqual(storage.document(document()),document());
 for(const value of [{...a(),driverUserId:'Bubba'},{...a(),vehicleId:'truck'},{...a(),extra:true},{...a(),driverName:''}])assert.throws(()=>assignment.validate(value));
 assert.equal(assignment.resolve('Bubba:truck',[]).needsReview,true);
 assert.equal(assignment.resolve('Bubba:truck',[{userId:bubba,displayName:'Bubba'},{userId:backup,displayName:'Bubba'}]).needsReview,true);
 assert.deepEqual(assignment.resolve('Bubba:truck',[{userId:bubba,displayName:'Bubba'}]),a());
 const changed=document();changed.assignments[0]=a(backup,'Backup');assert.throws(()=>storage.document(changed),/Sent-out assignment/);
 const legacy=document();legacy.schemaVersion=3;legacy.assignments[0]='Bubba:truck';legacy.lockedTrips[0].assignment='Bubba:truck';assert.equal(storage.document(legacy).schemaVersion,3);
});

test('dynamic drivers: isolated PostgreSQL contract, account isolation and POD finalization',async t=>{
 const db=await PGlite.create();t.after(()=>db.close());
 const q=(sql,args=[])=>db.query(sql,args),v=async(sql,args=[])=>Object.values((await q(sql,args)).rows[0])[0];
 const read=p=>readFile(new URL('../'+p,import.meta.url),'utf8');
 await db.exec(await read('tools/delivery-pod/test-prerequisites.sql'));
 await db.exec("alter table profiles add column display_name text; alter table atlas_routing_preview_private.days add column updated_by uuid, add column updated_at timestamptz default now(); insert into storage.buckets values('atlas-pod-originals','atlas-pod-originals',false,15000000,array['image/jpeg','image/png']),('atlas-pod-documents','atlas-pod-documents',false,25000000,array['application/pdf'])");
 for(const f of ['schema-draft.sql','email-schema-draft.sql','driver-access-draft.sql'])await db.exec(await read('tools/delivery-pod/'+f));
 await db.exec(`create function atlas_routing_preview_private.exact_keys(j jsonb,keys text[]) returns boolean language sql immutable as $$select coalesce(jsonb_typeof(j)='object' and j ?& keys and j-keys='{}'::jsonb,false)$$;
 create function atlas_routing_preview_private.integer_between(j jsonb,lo bigint,hi bigint) returns boolean language sql immutable as $$select case when jsonb_typeof(j)='number' then j::text::numeric=trunc(j::text::numeric) and j::text::numeric between lo and hi else false end$$;`);
 for(const f of ['private-trip-locks.sql','scanner-backend-draft.sql','next-load-priority-draft.sql'])await db.exec(await read('tools/routing-preview/'+f));
 await db.exec(await read('tools/delivery-pod/dynamic-driver-draft.sql'));
 await db.exec(await read('tools/routing-preview/dynamic-assignment-draft.sql'));
 await db.exec(await read('tools/delivery-pod/dynamic-driver-workflow-draft.sql'));
 await q("insert into warehouses values($1,'CA',true),($2,'TX',true)",[ca,tx]);
 for(const who of [admin,supervisor,bubba,backup,texas,receiver,tester,tester2,multi]){
  const role=who===admin?'admin':who===supervisor?'supervisor':who===receiver?'office_receiver':'picker',wh=[texas,multi].includes(who)?tx:ca;
  await q('insert into auth.users(id,raw_app_meta_data) values($1,$2)',[who,{role}]);
  await q('insert into auth.sessions values($1,$2,null)',[id(Number(who.slice(-12))+100),who]);
  await q('insert into profiles values($1,$2,$3,$4)',[who,wh,role,who===bubba?'Bubba':'Synthetic '+who.slice(-2)]);
  await q('insert into profile_warehouse_access values($1,$2)',[who,wh]);
 }
 await q('insert into profile_warehouse_access values($1,$2)',[multi,ca]);
 for(const who of [admin,supervisor]){
  await q("insert into atlas_routing_preview_private.members values($1,$2,'editor',true)",[ca,who]);
  await q("insert into atlas_pod_private.members values($1,$2,'office',true)",[ca,who]);
 }
 const user=async who=>{await db.exec('reset role');await q("select set_config('request.jwt.claims',$1,false)",[JSON.stringify({sub:who,session_id:id(Number(who.slice(-12))+100),user_metadata:{role:'admin',is_test:false}})]);await db.exec('set role authenticated');};
 const scenario=(name,fn)=>t.test(name,async()=>{await db.exec('reset role; begin');try{await fn();}finally{await db.exec('rollback; reset role');}});
 const save=(d=document(),rev=0)=>v("select atlas_routing_preview_private.save_day('CA',$1,$2,$3)",[day,rev,d]);
 // Only the existing public save wrapper can invoke this private function in production.
 await db.exec("create function public.test_driver_save(d date,r integer,j jsonb) returns jsonb language sql security definer set search_path='' as $$select atlas_routing_preview_private.save_day('CA',d,r,j)$$");
 const saved=(d=document(),rev=0)=>v('select public.test_driver_save($1,$2,$3)',[day,rev,d]);
 const configure=who=>v("select public.atlas_driver_configure_account($1,true,'standard',false)",[who]);
 const seed=who=>v('select public.atlas_driver_seed_test($1,$2)',[day,who]);
 const list=()=>v('select public.atlas_driver_my_trips($1)',[day]);
 const receive=(stop,who=tester,version=1,hash=null)=>v('select public.atlas_driver_pod_receive($1,$2,$3,$4,$5,$6,$7,1,$8)',[stop.id,who,id(Number(who.slice(-12))+100),version,id(50),'a'.repeat(64),'POD-SO-TEST-0001.pdf',hash]);

 await scenario('directory is admin-only and filters role, warehouse, ban and test accounts',async()=>{
  await user(admin);await configure(tester);const data=await v('select public.atlas_driver_candidates(false)');
  assert.deepEqual(new Set(data.candidates.map(x=>x.userId)),new Set([admin,supervisor,bubba,backup,tester2,multi]));
  assert.equal(data.candidates.find(x=>x.userId===bubba).roleLabel,'Warehouse');
  assert.deepEqual((await v('select public.atlas_driver_candidates(true)')).candidates.map(x=>x.userId),[tester]);
  for(const who of [supervisor,backup,texas]){await user(who);await db.exec('savepoint denied');await assert.rejects(v('select public.atlas_driver_candidates(false)'),{code:'42501'});await db.exec('rollback to denied');}
 });
 await scenario('v4 saves through revision protection; locked assignments and future dispatch cannot change',async()=>{
  await user(admin);assert.equal((await saved()).revision,1);
  await db.exec('savepoint invalid');await assert.rejects(saved(document(),0),{code:'40001'});await db.exec('rollback to invalid');
  const d=document();d.assignments[0]=a(backup,'Synthetic 13');d.lockedTrips[0].assignment=d.assignments[0];
  await assert.rejects(saved(d,1),/SENT_ASSIGNMENT_LOCKED/);
 });
 await scenario('production publish projects only required fields and only to assigned account',async()=>{
  await user(admin);await saved();const published=await v('select public.atlas_driver_publish($1,1,0)',[day]);assert.ok(published.id);
  await user(bubba);const result=await list();assert.equal(result.trips.length,1);assert.equal(result.trips[0].stops[0].customer,'Synthetic customer');
  assert.equal(JSON.stringify(result).includes('catalog'),false);assert.equal(JSON.stringify(result).includes('assignments'),false);
  await user(backup);assert.equal((await list()).trips.length,0);await assert.rejects(v('select public.atlas_driver_pod_context($1)',[result.trips[0].stops[0].id]),{code:'42501'});
 });
 await scenario('test route, receipts and events never enter operational days or email records',async()=>{
  await user(admin);await configure(tester);await seed(tester);await user(tester);const trip=(await list()).trips[0],stop=trip.stops[0];assert.equal(trip.isTest,true);
  const ctx=await v('select public.atlas_driver_pod_context($1)',[stop.id]);assert.equal(ctx.is_test,true);
  await db.exec('reset role; set role service_role');const r=await receive(stop);assert.ok(r.object_prefix.startsWith('pod-test/'));assert.equal((await receive(stop,tester,1,'b'.repeat(64))).state,'received');
  await user(tester);await v("select public.atlas_driver_stop_action($1,1,'complete',$2)",[stop.id,{recipient:'Test recipient',signatureConfirmed:true}]);
  await db.exec('reset role');assert.equal(await v('select count(*)::int from atlas_routing_preview_private.days'),0);assert.equal(await v('select count(*)::int from atlas_pod_private.submissions'),0);
  assert.equal(await v('select count(*)::int from atlas_driver_private.events where not is_test'),0);
 });
 await scenario('reassignment revokes old access and rejects stale mutation and receipt finalization',async()=>{
  await user(admin);await configure(tester);await configure(tester2);const trip=await seed(tester);
  await user(tester);const stop=(await list()).trips[0].stops[0];await user(admin);
  assert.equal((await v("select public.atlas_driver_reassign($1,1,$2,'van_1')",[trip.id,tester2])).version,2);
  await user(tester);assert.equal((await list()).trips.length,0);await db.exec('savepoint denied');await assert.rejects(v("select public.atlas_driver_stop_action($1,1,'arrived')",[stop.id]),{code:'42501'});await db.exec('rollback to denied');
  await db.exec('reset role; set role service_role');await db.exec('savepoint denied');await assert.rejects(receive(stop),{code:'42501'});await db.exec('rollback to denied');
  await user(tester2);assert.equal((await list()).trips.length,1);
 });
 await scenario('test driver cannot be assigned production work; exception is not delivery completion',async()=>{
  await user(admin);await configure(tester);await seed(tester);const d=document();d.assignments[0]=a(tester,'Synthetic 16');d.lockedTrips[0].assignment=d.assignments[0];
  await db.exec('savepoint invalid');await assert.rejects(saved(d),/INVALID_DRIVER/);await db.exec('rollback to invalid');
  await user(tester);const stop=(await list()).trips[0].stops[2];await v("select public.atlas_driver_stop_action($1,1,'exception',$2)",[stop.id,{reason:'Customer unavailable'}]);assert.equal((await list()).trips[0].stops[2].status,'exception');
 });
 await scenario('POD and check collection are required; forged planning fields are rejected',async()=>{
  await user(admin);await configure(tester);await seed(tester);await user(tester);const stop=(await list()).trips[0].stops[1];
  await db.exec('savepoint invalid');await assert.rejects(v("select public.atlas_driver_stop_action($1,1,'complete')",[stop.id]),/POD_REQUIRED/);await db.exec('rollback to invalid');
  await db.exec('savepoint invalid');await assert.rejects(v("select public.atlas_driver_stop_action($1,1,'arrived',$2)",[stop.id,{driverUserId:tester2}]),/INVALID_STOP_DETAILS/);await db.exec('rollback to invalid');
  await db.exec('reset role; set role service_role');await receive(stop,tester,1,'b'.repeat(64));await user(tester);
  await assert.rejects(v("select public.atlas_driver_stop_action($1,1,'complete')",[stop.id]),/CHECK_COLLECTION_REQUIRED/);
 });

 await scenario('ready trip publishes before departure, revokes on plan edit and becomes sent on dispatch',async()=>{
  await user(admin);const d=document();d.lockedTrips=[];d.orders[0].dispatchedOn=null;await saved(d);
  const sh=document().lockedTrips[0].shipments;
  const published=await v('select public.atlas_driver_publish_ready($1,1,0,$2)',[day,sh]);
  await user(bubba);let mine=await list();assert.equal(mine.trips[0].status,'assigned');
  await db.exec('savepoint denied');await assert.rejects(v("select public.atlas_driver_stop_action($1,1,'arrived')",[mine.trips[0].stops[0].id]),/TRIP_NOT_SENT/);await db.exec('rollback to denied');
  await user(admin);await saved(document(),1);await user(bubba);mine=await list();assert.equal(mine.trips[0].status,'sent');
  await v("select public.atlas_driver_stop_action($1,1,'arrived')",[mine.trips[0].stops[0].id]);
 });

 await scenario('split publication conserves boxes and numbers each shipment before departure',async()=>{
  await user(admin);const d=document();d.lockedTrips=[];d.orders[0].dispatchedOn=null;d.assignments[1]=a(backup,'Synthetic 13');await saved(d);
  const plan=[10,10].map(boxes=>[{orderId:id(30),palletSpaces:1,boxAllocation:[{sku:'TEST',boxes}]}]);
  await v('select public.atlas_driver_publish_ready($1,1,0,$2,$3)',[day,plan[0],plan]);
  await v('select public.atlas_driver_publish_ready($1,1,1,$2,$3)',[day,plan[1],plan]);
  await user(backup);const stop=(await list()).trips[0].stops[0];assert.equal(stop.shipment_number,2);assert.equal(stop.shipment_total,2);
  await user(admin);const bad=structuredClone(plan);bad[1][0].boxAllocation[0].boxes=11;
  await db.exec('savepoint invalid');await assert.rejects(v('select public.atlas_driver_publish_ready($1,1,0,$2,$3)',[day,bad[0],bad]),/INCOMPLETE_BOX_ALLOCATION/);await db.exec('rollback to invalid');
 });
 await scenario('cleanup is test-only, waits for uploads, retains the account and leaves production untouched',async()=>{
  await user(admin);await saved();await configure(tester);const trip=await seed(tester);
  const plan=await v('select public.atlas_driver_cleanup_prepare($1,1,true)',[trip.id]);assert.equal(plan.ready,false);
  await db.exec('reset role');await q("update atlas_driver_private.events set at=now()-interval '3 minutes' where trip_id=$1",[trip.id]);await db.exec('set role service_role');
  await v('select public.atlas_driver_cleanup_finish($1,$2,$3,$4)',[trip.id,plan.version,admin,id(110)]);
  await db.exec('reset role');assert.equal(await v('select count(*)::int from atlas_routing_preview_private.days'),1);assert.equal(await v('select count(*)::int from atlas_driver_private.accounts where user_id=$1',[tester]),1);
 });
 await scenario('normal POD reaches existing office/email records; test POD never does',async()=>{
  await user(admin);await saved();await v('select public.atlas_driver_publish($1,1,0)',[day]);await user(bubba);const stop=(await list()).trips[0].stops[0];
  await db.exec('reset role; set role service_role');
  const args=[stop.id,bubba,id(112),id(60),'b'.repeat(64),'c'.repeat(64)];
  await v("select public.atlas_driver_pod_receive($1,$2,$3,1,$4,$5,'POD-SO-123.pdf',1,$6)",args);
  await user(bubba);const context=await v('select public.atlas_pod_email_context($1)',[id(60)]);assert.equal(context.document.id,id(60));
  await user(admin);const office=await v('select public.atlas_pod_list($1)',[day]);assert.equal(office.shipments.some(x=>x.id===stop.id&&x.submission.state==='received'),true);
 });
 await scenario('private tables have RLS, no browser table access, and privileged receipts are server-only',async()=>{
  assert.equal(await v("select count(*)::int from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='atlas_driver_private' and c.relkind='r' and c.relrowsecurity"),5);
  for(const table of ['accounts','trips','stops','receipts','events'])assert.equal(await v("select has_table_privilege('authenticated',$1,'SELECT,INSERT,UPDATE,DELETE')",['atlas_driver_private.'+table]),false);
  assert.equal(await v("select has_function_privilege('anon','public.atlas_driver_candidates(boolean)','EXECUTE')"),false);
  assert.equal(await v("select has_function_privilege('authenticated','public.atlas_driver_pod_receive(uuid,uuid,uuid,integer,uuid,text,text,integer,text)','EXECUTE')"),false);
 });
});
