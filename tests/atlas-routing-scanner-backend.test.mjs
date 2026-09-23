import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import storage from '../atlas-routing-storage.js';
import {buildScannerDraft,runScannerPlanningOnce} from '../tools/routing-preview/scanner-planning-worker.mjs';
const require=createRequire(new URL('../tools/delivery-pod/package.json',import.meta.url));
const {PGlite}=require('@electric-sql/pglite');
const id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const day='2026-09-22',ca=id(1),tx=id(2),admin=id(10),supervisor=id(11),texas=id(12);
const example=()=>storage.document({schemaVersion:3,date:day,orders:[],
 catalog:[{model:'CGSC1-8OZ',caseQty:'200',caseDimensions:'24X20X16',caseWeightLb:'25LB',boxesPerPallet:'20',palletDimensions:'49X41X81',sourceRow:1}],
 settings:{truckPalletTarget:11,dailyTripTarget:3,reloadMinutes:40,lunch:'12:00',preserveOrder:true},assignments:{},vanConfirmed:{},lockedTrips:[]});
const order=(n=1,boxes=100)=>storage.document({...example(),orders:[{id:id(100+n),orderNumber:`SO-US-${n}`,customer:'Synthetic customer',address:'100 Test Road',city:'Fullerton',timeWindow:'',notes:'',serviceMinutes:25,checkOnDelivery:false,lines:[{sku:'CGSC1-8OZ-0401',caseQty:boxes,itemQty:null}]}]}).orders[0];
const metadata={parserVersion:'packing-slip-v1',purchaseOrder:'PO4128',packingSlip:'IF-59709',fields:[{field:'customer',original:'Synthetic customer',reviewed:'Synthetic customer',confidence:.99,source:'template'}]};

test('scanner transactions and queue run on isolated PostgreSQL',async t=>{
 const db=await PGlite.create();t.after(()=>db.close());
 const q=(sql,args=[])=>db.query(sql,args),v=async(sql,args=[])=>Object.values((await q(sql,args)).rows[0])[0];
 const read=path=>readFile(new URL('../'+path,import.meta.url),'utf8');
 await db.exec(await read('tools/delivery-pod/test-prerequisites.sql'));
 await db.exec("alter table profiles add column display_name text; alter table atlas_routing_preview_private.days add column updated_by uuid, add column updated_at timestamptz default now(); insert into storage.buckets values('atlas-pod-originals','atlas-pod-originals',false,15000000,array['image/jpeg','image/png']),('atlas-pod-documents','atlas-pod-documents',false,25000000,array['application/pdf'])");
 for(const file of ['schema-draft.sql','email-schema-draft.sql','driver-access-draft.sql'])await db.exec(await read('tools/delivery-pod/'+file));
 // Inspected deployed definitions of scalar helpers absent from the checkout.
 // The actual v3 document validator and save function below are repository source.
 await db.exec(`create function atlas_routing_preview_private.exact_keys(j jsonb,keys text[]) returns boolean language sql immutable as $$
 select coalesce(jsonb_typeof(j)='object' and j ?& keys and j - keys = '{}'::jsonb,false) $$;
 create function atlas_routing_preview_private.integer_between(j jsonb,lo bigint,hi bigint) returns boolean language sql immutable as $$
 select case when jsonb_typeof(j)='number' then j::text::numeric=trunc(j::text::numeric) and j::text::numeric between lo and hi else false end $$;`);
 await db.exec(await read('tools/routing-preview/private-trip-locks.sql'));
 await db.exec(await read('tools/routing-preview/scanner-backend-draft.sql'));
 await q("insert into warehouses values($1,'CA',true),($2,'TX',true)",[ca,tx]);
 for(const who of [admin,supervisor,texas]){
  const wh=who===texas?tx:ca,role=who===supervisor?'supervisor':'admin';
  await q('insert into auth.users(id,raw_app_meta_data) values($1,$2)',[who,{role}]);
  await q('insert into auth.sessions values($1,$2,null)',[id(Number(who.slice(-12))+1000),who]);
  await q('insert into profiles values($1,$2,$3,$4)',[who,wh,role,'Synthetic user']);
  await q('insert into profile_warehouse_access values($1,$2)',[who,wh]);
  await q("insert into atlas_routing_preview_private.members values($1,$2,'editor',true)",[wh,who]);
 }
 const user=async(who=admin)=>{await db.exec('reset role');await q("select set_config('request.jwt.claims',$1,false)",[JSON.stringify({sub:who,session_id:id(Number(who.slice(-12))+1000),user_metadata:{role:'admin'}})]);await db.exec('set role authenticated');};
 const upload=(o=order(),m=metadata)=>v("select public.atlas_routing_scanner_upload('CA',$1,$2,$3,$4)",[day,o,m,example()]);
 const service=()=>db.exec('reset role; set role service_role');
 const due=()=>db.exec("reset role; update atlas_scanner_private.planning set due_at=now()-interval '1 second'");
 const claim=async()=>{await service();return v('select public.atlas_routing_scanner_claim()');};
 const finish=(job,plan=buildScannerDraft(job.document),error=null)=>v('select public.atlas_routing_scanner_finish($1,$2,$3,$4)',[day,job.lease,plan,error]);
 const scenario=(name,fn)=>t.test(name,async()=>{await db.exec('reset role; begin');try{await fn();}finally{await db.exec('rollback; reset role');}});
 await scenario('disabled by default; no live enablement is implied',async()=>{await user();await assert.rejects(upload(),/SCANNER_DISABLED/);});
 await db.exec('update atlas_scanner_private.settings set enabled=true');
 await scenario('durable upload, exact duplicate, sidecar metadata, and atomic queue',async()=>{
  await user();const first=await upload();assert.equal(first.revision,1);assert.equal(first.duplicate,false);
  assert.equal((await upload({...order(),customer:'Do not overwrite'})).duplicate,true);
  await db.exec('reset role');assert.equal(await v('select count(*)::int from atlas_scanner_private.extractions'),1);
  assert.equal(await v('select generation::int from atlas_scanner_private.planning'),1);
  assert.equal(await v("select document->'orders'->0->>'customer' from atlas_routing_preview_private.days"),'Synthetic customer');
  assert.equal(await v("select document::text like '%parserVersion%' from atlas_routing_preview_private.days"),false);
 });
 await scenario('invalid order rolls back its day, metadata and queue',async()=>{
  await user();await db.exec('savepoint invalid');await assert.rejects(upload({...order(),lines:[]}),/INVALID_ROUTING_DOCUMENT/);
  await db.exec('rollback to invalid; reset role');assert.equal(await v('select count(*)::int from atlas_routing_preview_private.days'),0);
  assert.equal(await v('select count(*)::int from atlas_scanner_private.planning'),0);
 });
 await scenario('raw OCR and extra metadata are rejected',async()=>{await user();await assert.rejects(upload(order(),{...metadata,rawText:'not stored'}),/INVALID_SCANNER_UPLOAD/);});
 for(const who of [supervisor,texas])await scenario('denies unauthorized upload '+who,async()=>{await user(who);await assert.rejects(upload(),{code:'42501'});});
 await scenario('browser cannot claim jobs or read private tables',async()=>{
  await user();await db.exec('savepoint denied');await assert.rejects(v('select public.atlas_routing_scanner_claim()'),{code:'42501'});
  await db.exec('rollback to denied');await assert.rejects(q('select * from atlas_scanner_private.extractions'),{code:'42501'});
 });
 await scenario('debounces bursts and admits only one active worker per day',async()=>{
  await user();await upload();await upload(order(2));assert.equal(await claim(),null);
  await due();const job=await claim();assert.equal(job.revision,2);assert.equal(await claim(),null);
  const result=await finish(job);assert.equal(result.status,'updated');
  await user(supervisor);assert.equal((await v("select public.atlas_routing_scanner_status('CA',$1)",[day])).status,'updated');
 });
 await scenario('daily usage limit survives claims and denies browser access',async()=>{
  await user();await upload();await due();const job=await claim();
  assert.equal(await v("select public.atlas_routing_scanner_budget($1,'geocode')",[job.lease]),true);
  await db.exec("reset role; update atlas_scanner_private.usage set used=100");await service();
  assert.equal(await v("select public.atlas_routing_scanner_budget($1,'geocode')",[job.lease]),false);
  await user();await assert.rejects(v("select public.atlas_routing_scanner_budget($1,'geocode')",[job.lease]),{code:'42501'});
 });
 await scenario('upload during planning invalidates old result and schedules one follow-up',async()=>{
  await user();await upload();await due();const job=await claim();
  await user();await upload(order(2));await service();assert.equal((await finish(job)).status,'pending');
  await due();const next=await claim();assert.equal(next.revision,2);assert.equal((await finish(next)).status,'updated');
 });
 await scenario('failure retains last good draft and saved orders',async()=>{
  await user();await upload();await due();let job=await claim();await finish(job);
  await user();await upload(order(2));await due();job=await claim();await finish(job,null,'PLANNING_FAILED');
  await user();const status=await v("select public.atlas_routing_scanner_status('CA',$1)",[day]);
  assert.equal(status.status,'attention');assert.equal(status.planRevision,1);assert.ok(status.plan);
  assert.equal(await v("select public.atlas_routing_scanner_retry('CA',$1)",[day]),true);
  assert.equal(await v("select public.atlas_routing_scanner_retry('CA',$1)",[day]),false);
  const retry=await claim();assert.equal((await finish(retry)).status,'updated');
 });
 await scenario('expired lease is recoverable and old worker cannot complete it',async()=>{
  await user();await upload();await due();const old=await claim();
  await db.exec("reset role; update atlas_scanner_private.planning set lease_until=now()-interval '1 second'");
  const fresh=await claim();assert.notEqual(fresh.lease,old.lease);await db.exec('savepoint stale');
  await assert.rejects(finish(old),/SCANNER_LEASE_EXPIRED/);await db.exec('rollback to stale');await finish(fresh);
 });
});

test('background draft conserves split boxes, leaves sent loads alone, and never assigns drivers',()=>{
 const doc={...example(),orders:[order(1,300),order(2,10)]};
 doc.orders[0].dispatchedOn=day;
 doc.assignments={'0':'Bubba:truck'};
 doc.lockedTrips=[{assignment:'Bubba:truck',vanConfirmed:false,sentOn:day,completedOrderIds:[],palletSpaces:11,shipments:[{orderId:id(101),palletSpaces:11,boxAllocation:[{sku:'CGSC1-8OZ-0401',boxes:220}]}]}];
 const before=JSON.stringify(doc),plan=buildScannerDraft(doc);
 assert.equal(JSON.stringify(doc),before);
 assert.equal(plan.trips.flatMap(t=>t.shipments).flatMap(s=>s.boxAllocation).reduce((n,b)=>n+b.boxes,0),90);
 assert.equal(plan.trips[0].palletSpaces,5);assert.equal(JSON.stringify(plan).includes('Bubba'),false);
 assert.equal(plan.timingStatus,'unavailable');
});
test('worker sanitizes planning failure and has no transport or scheduler side effects on import',async()=>{
 const calls=[];const result=await runScannerPlanningOnce(async(name,args)=>{calls.push({name,args});return name.endsWith('claim')?{date:day,lease:id(99),document:{bad:true}}:{status:'attention'};});
 assert.equal(result.status,'attention');assert.equal(calls[1].args.p_error,'PLANNING_FAILED');assert.equal(calls[1].args.p_plan,null);
});


test('worker connects the existing traffic planner without persisting driver assignments',async()=>{
 const doc={...example(),orders:[order()]};let finished;
 const rpc=async(name,args)=>{if(name.endsWith('claim'))return {date:day,lease:id(90),document:doc};finished=args;return {status:'updated'};};
 const result=await runScannerPlanningOnce(rpc,{now:Date.parse('2026-09-21T00:00:00Z'),
 geocode:async()=>({location:{latitude:34,longitude:-118},formattedAddress:'Synthetic test address'}),
 route:async payload=>({visits:[{stopIndex:0,arrival:payload.departure}],skippedStopIndices:[],departure:payload.departure,returnTime:day+'T17:00:00Z',driveSeconds:1200,distanceMeters:10000,polyline:'',trafficInfeasible:false,breaks:[]})});
 assert.equal(result.status,'updated');assert.equal(finished.p_error,null);assert.equal(finished.p_plan.timingStatus,'estimated');
 assert.equal(finished.p_plan.timed.complete,true);assert.deepEqual(doc.assignments,{});
});

test('same-day scanner uses a future loading departure after the usual 6:30 start',async()=>{
 const doc={...example(),orders:[order()]};let finished,departure;
 const rpc=async(name,args)=>{if(name.endsWith('claim'))return {date:day,lease:id(90),document:doc};finished=args;return {status:'updated'};};
 await runScannerPlanningOnce(rpc,{now:Date.parse(day+'T15:00:00Z'),
 geocode:async()=>({location:{latitude:34,longitude:-118},formattedAddress:'Synthetic address'}),
 route:async payload=>{departure=payload.departure;return {visits:[{stopIndex:0,arrival:departure}],skippedStopIndices:[],departure,returnTime:day+'T17:00:00Z',driveSeconds:1200,distanceMeters:10000,polyline:'',trafficInfeasible:false,breaks:[]};}});
 assert.equal(finished.p_error,null);assert.equal(departure,day+'T15:30:00.000Z');
});
