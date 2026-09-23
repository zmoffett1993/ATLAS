const test = require('node:test');
const assert = require('node:assert/strict');
const { document: snapshot, createClient } = require('../atlas-routing-storage.js');
const USER = '11111111-1111-4111-8111-111111111111', OTHER = '22222222-2222-4222-8222-222222222222';
const DAY = '2026-09-22';
const example = () => ({ schemaVersion: 1, date: DAY, orders: [{ id: OTHER, orderNumber: 'TEST-001', customer: 'Synthetic Customer', address: '100 Test Road', city: 'Fullerton', timeWindow: '', notes: 'CHECK ON DELIVERY', checkOnDelivery: true, serviceMinutes: 25,
  lines: [{ sku: 'CGSC1-8OZ-0401', caseQty: 100, itemQty: '20000' }], photos: [{ url: 'blob:temporary', file: 'synthetic-photo' }] }],
  catalog: [{ model: 'CGSC1-8OZ', caseQty: '200', caseDimensions: '24X20X16', caseWeightLb: '25LB', boxesPerPallet: '20', palletDimensions: '49X41X81', sourceRow: 24 }],
  settings: { truckPalletTarget: 11, dailyTripTarget: 3, reloadMinutes: 40, lunch: '12:00', preserveOrder: true }, assignments: { 0: 'Achmad:van2' }, vanConfirmed: { 0: true } });
const session = (id=USER) => ({ user: { id }, access_token: 'synthetic-test-token' });
function fixture(overrides={}) {
  let identity = session(); const calls=[];
  const client = createClient({ enabled: true, key: 'sb_publishable_synthetic', getSession: () => identity, getValidSession: async () => identity,
    fetchImpl: async (url, init) => { calls.push({url,init}); const p=JSON.parse(init.body); return Response.json({ warehouse: 'CA', date: p.p_day, revision: p.p_expected_revision == null ? 0 : p.p_expected_revision+1, document: p.p_document || null, canEdit: true }); }, ...overrides });
  return {client,calls,identity: value => { identity=value; }};
}
test('only reviewed fields persist; files, photos, raw OCR, Google results and tokens never serialize', () => {
  const source=example(); source.token='synthetic-secret'; source.planned={googleResult:'do not save'}; source.orders[0].ocr='raw OCR';
  const data=snapshot(source), json=JSON.stringify(data);
  for(const term of ['blob:', 'synthetic-photo','synthetic-secret','do not save','raw OCR','photos']) assert.equal(json.includes(term),false);
  assert.equal(data.orders[0].lines[0].caseQty,100); assert.equal(data.orders[0].lines[0].itemQty,20000);
  assert.equal(data.catalog[0].boxesPerPallet,'20'); assert.deepEqual(data.assignments,{0:'Achmad:van2'}); assert.equal(data.orders[0].timeWindow,'');
});
test('snapshots are independent, preserve TBA and NEW rows, and allow blank optional units', () => {
  const source=example(); source.catalog[0].model+=' (NEW)'; source.catalog[0].caseDimensions='TBA'; source.orders[0].lines[0].itemQty=null;
  const data=snapshot(source); source.orders[0].lines[0].caseQty=1;
  assert.equal(data.orders[0].lines[0].caseQty,100); assert.equal(data.orders[0].lines[0].itemQty,null); assert.equal(data.catalog[0].caseDimensions,'TBA');
});
test('invalid dates, duplicate orders and IDs, non-integer quantities and unsupported assignments are rejected', () => {
  const invalid=[d=>d.date='2026-02-30', d=>d.orders.push({...d.orders[0]}), d=>d.orders.push({...d.orders[0],id:USER,orderNumber:'test-001'}), d=>d.orders[0].lines[0].caseQty=1.2,
    d=>d.orders[0].lines[0].caseQty=0,d=>d.orders[0].lines[0].itemQty='abc',d=>d.orders[0].serviceMinutes=0,d=>d.assignments[0]='Achmad:truck',d=>d.settings.lunch='13:30',d=>d.vanConfirmed[0]='true',d=>d.schemaVersion=4];
  for(const change of invalid) { const d=example();change(d);assert.throws(()=>snapshot(d)); }
});
test('saving is disabled by default and makes no network requests',async()=> {
  const f=fixture({enabled:false}); await assert.rejects(f.client.save(DAY,0,example()),{code:'DISABLED'});assert.equal(f.calls.length,0);
});
test('round-trip uses fixed Supabase RPC, authenticated no-store request, expected revision and CA scope',async()=> {
  const f=fixture();const saved=await f.client.save(DAY,4,example()); assert.equal(saved.revision,5);
  const {url,init}=f.calls[0];assert.equal(url,'https://dwrrbpiprcmajfyronlf.supabase.co/rest/v1/rpc/atlas_routing_preview_save');
  assert.equal(init.redirect,'error');assert.equal(init.cache,'no-store');assert.equal(init.credentials,'omit');assert.equal(init.headers.Authorization,'Bearer synthetic-test-token');
  const body=JSON.parse(init.body);assert.equal(body.p_expected_revision,4);assert.equal(body.p_warehouse,'CA');assert.equal('photos' in body.p_document.orders[0],false);
  assert.deepEqual(await f.client.load(DAY),{warehouse:'CA',date:DAY,revision:0,document:null,canEdit:true});
});
test('wrong date and invalid revision cannot send a save',async()=> {
  const f=fixture();await assert.rejects(f.client.save('2026-09-23',0,example()));await assert.rejects(f.client.save(DAY,-1,example()));assert.equal(f.calls.length,0);
});
test('save conflict remains explicit and is never automatically retried',async()=> {
  let count=0;const f=fixture({fetchImpl:async()=>{count++;return Response.json({code:'40001',message:'internal sensitive detail'},{status:409});}});
  await assert.rejects(f.client.save(DAY,3,example()),error=>error.code==='CONFLICT'&&!error.message.includes('sensitive'));assert.equal(count,1);
});
test('unauthorized and uninstalled database responses are sanitized',async()=> {
  for(const [code,expected] of [['42501','ACCESS_DENIED'],['PGRST202','DISABLED'],['22023','UNAVAILABLE']]) {
    const f=fixture({fetchImpl:async()=>Response.json({code,message:'secret database details'},{status:400})});
    await assert.rejects(f.client.load(DAY),e=>e.code===expected&&!e.message.includes('secret'));
  }
});
test('account change while refreshing session prevents the request',async()=> {
  const f=fixture({getValidSession:async()=>session(OTHER)});await assert.rejects(f.client.load(DAY),{code:'SESSION_CHANGED'});assert.equal(f.calls.length,0);
});
test('account switch during a request discards its response',async()=> {
  let release;const pending=new Promise(r=>release=r);
  const f=fixture({fetchImpl:async()=>{await pending;return Response.json({warehouse:'CA',date:DAY,revision:0,document:null,canEdit:true});}});
  const result=f.client.load(DAY);await new Promise(r=>setImmediate(r));f.identity(session(OTHER));release();await assert.rejects(result,{code:'SESSION_CHANGED'});
});
test('reset aborts inflight work even when the transport ignores abort',async()=> {
  let release,signal;const pending=new Promise(r=>release=r);
  const f=fixture({fetchImpl:async(_url,init)=>{signal=init.signal;await pending;return Response.json({warehouse:'CA',date:DAY,revision:0,document:null,canEdit:true});}});
  const result=f.client.load(DAY);await new Promise(r=>setImmediate(r));f.client.reset();assert.equal(signal.aborted,true);release();await assert.rejects(result,{code:'SESSION_CHANGED'});
});
test('network failure after sending a save reports uncertainty without retry',async()=> {
  let count=0;const f=fixture({fetchImpl:async()=>{count++;throw new TypeError('synthetic secret');}});
  await assert.rejects(f.client.save(DAY,0,example()),e=>e.code==='UNAVAILABLE'&&e.message.includes('could not be confirmed'));assert.equal(count,1);
});
test('cross-warehouse, cross-date, malformed and oversized saved responses are rejected',async()=> {
  for(const patch of [{warehouse:'TX'},{date:'2026-09-23'},{revision:1},{canEdit:'yes'},{document:{}}]) {
    const f=fixture({fetchImpl:async()=>Response.json({warehouse:'CA',date:DAY,revision:0,document:null,canEdit:true,...patch})});await assert.rejects(f.client.load(DAY));
  }
  const f=fixture({fetchImpl:async()=>new Response('x'.repeat(1200001))});await assert.rejects(f.client.load(DAY),{code:'UNAVAILABLE'});
});
test('concurrent clients keep the losing draft intact with compare-and-swap, including first creation',async()=> {
  let stored=null,revision=0;
  const fetchImpl=async(_url,init)=> { const p=JSON.parse(init.body);if(p.p_expected_revision!==revision)return Response.json({code:'40001'},{status:409});stored=p.p_document;revision++;return Response.json({warehouse:'CA',date:DAY,revision,document:stored,canEdit:true}); };
  const a=fixture({fetchImpl}).client,b=fixture({fetchImpl}).client;
  const first=example(),second=example();second.orders[0].notes='My unsaved changes';
  await a.save(DAY,0,first);await assert.rejects(b.save(DAY,0,second),{code:'CONFLICT'});
  assert.equal(second.orders[0].notes,'My unsaved changes');assert.equal(stored.orders[0].notes,'CHECK ON DELIVERY');
});


test('history metadata persists in v2; v1 days still round-trip without inventing delivery',()=> {
 const d=example();d.schemaVersion=2;Object.assign(d.orders[0],{invoiceNumbers:['inv-us-42','INV-US-42'],fulfillmentNumbers:['IF-US-12'],dispatchedOn:'2026-09-20',deliveredOn:'2026-09-20',deliveryException:''});
 const row=snapshot(d).orders[0];assert.deepEqual(row.invoiceNumbers,['INV-US-42']);assert.deepEqual(row.fulfillmentNumbers,['IF-US-12']);assert.equal(row.deliveredOn,'2026-09-20');
 assert.equal(snapshot(example()).schemaVersion,1);assert.equal(snapshot(example()).orders[0].deliveredOn,undefined);
 for(const change of [r=>r.invoiceNumbers=['x'.repeat(81)],r=>r.fulfillmentNumbers=Array(21).fill('IF-1'),r=>r.deliveredOn='2026-02-30',r=>r.deliveryException='x'.repeat(501)]){const invalid=structuredClone(d);change(invalid.orders[0]);assert.throws(()=>snapshot(invalid));}
});
test('v3 retains reviewed trip snapshots without serializing extra fields', () => {
 const d=example();d.schemaVersion=3;Object.assign(d.orders[0],{dispatchedOn:DAY,invoiceNumbers:[],fulfillmentNumbers:[],deliveredOn:null,deliveryException:''});
 d.lockedTrips=[{sentOn:DAY,palletSpaces:5,assignment:'Achmad:van2',vanConfirmed:true,completedOrderIds:[OTHER],shipments:[{orderId:OTHER,palletSpaces:5,boxAllocation:[{sku:'CGSC1-8OZ-0401',boxes:100}],rawPhoto:'discard'}],extra:'discard'}];
 const saved=snapshot(d);assert.equal(saved.schemaVersion,3);assert.deepEqual(saved.lockedTrips[0].shipments[0].boxAllocation,[{sku:'CGSC1-8OZ-0401',boxes:100}]);
 assert.doesNotMatch(JSON.stringify(saved),/rawPhoto|extra|blob:|synthetic-photo/);
 for(const mutate of [x=>x.lockedTrips[0].shipments[0].boxAllocation[0].boxes=101,x=>x.lockedTrips[0].palletSpaces=4,x=>x.lockedTrips[0].completedOrderIds=[USER],x=>x.assignments[0]='Bubba:truck']) {
   const invalid=structuredClone(d);mutate(invalid);assert.throws(()=>snapshot(invalid));
 }
});

test('delivery status uses Pacific 5 PM, only dispatched orders, with exceptions taking priority',()=> {
 const {deliveryStatus}=require('../atlas-routing-storage.js');
 const before=new Date('2026-09-21T23:59:00Z'),after=new Date('2026-09-22T00:00:00Z');
 assert.equal(deliveryStatus({},after).label,'Scheduled');
 assert.equal(deliveryStatus({dispatchedOn:'2026-09-21'},before).label,'Out for delivery');
 assert.equal(deliveryStatus({dispatchedOn:'2026-09-21'},after).label,'Assumed delivered');
 assert.equal(deliveryStatus({dispatchedOn:'2026-09-22'},after).label,'Out for delivery');
 assert.equal(deliveryStatus({dispatchedOn:'2026-09-20',deliveryException:'Returned'},after).label,'Delivery issue');
 assert.equal(deliveryStatus({deliveredOn:'2026-09-20'},after).label,'Confirmed delivered');
 assert.equal(deliveryStatus({dispatchedOn:'2026-12-01'},new Date('2026-12-02T00:59:00Z')).label,'Out for delivery');
 assert.equal(deliveryStatus({dispatchedOn:'2026-12-01'},new Date('2026-12-02T01:00:00Z')).label,'Assumed delivered');
});
const searchRow=()=>({date:DAY,orderId:OTHER,orderNumber:'SO-US-42',customer:'Synthetic',city:'Fullerton',invoiceNumbers:['INV-US-42'],fulfillmentNumbers:['IF-US-12'],dispatchedOn:null,deliveredOn:null,deliveryException:''});
test('history search uses fixed authenticated CA RPC and bounded literal filters',async()=>{
 let body,url;const f=fixture({fetchImpl:async(u,i)=>{url=u;body=JSON.parse(i.body);return Response.json({warehouse:'CA',matches:[searchRow()],hasMore:false});}});
 const result=await f.client.search({query:'INV-US-42',from:'2026-09-01',to:DAY,dateField:'delivered',offset:50});
 assert.ok(url.endsWith('/atlas_routing_preview_search'));assert.deepEqual(body,{p_warehouse:'CA',p_query:'INV-US-42',p_from:'2026-09-01',p_to:DAY,p_date_field:'delivered',p_offset:50});assert.equal(result.matches[0].invoiceNumbers[0],'INV-US-42');
 for(const filters of [{query:'x'.repeat(81)},{from:DAY,to:'2026-09-01'},{offset:-1},{dateField:'arbitrary'}])await assert.rejects(f.client.search(filters));
});
test('search rejects cross-warehouse, oversized and malformed responses',async()=>{
 for(const patch of [{warehouse:'TX'},{matches:Array(51).fill(searchRow())},{hasMore:'yes'},{matches:[{...searchRow(),orderId:'bad'}]},{matches:[{...searchRow(),deliveredOn:'2026-02-30'}]}]){
 const f=fixture({fetchImpl:async()=>Response.json({warehouse:'CA',matches:[],hasMore:false,...patch})});await assert.rejects(f.client.search({}));}
});
test('history results are discarded after account changes and reset',async()=>{
 for(const reset of [false,true]) {let release;const pending=new Promise(r=>release=r);const f=fixture({fetchImpl:async()=>{await pending;return Response.json({warehouse:'CA',matches:[searchRow()],hasMore:false});}});
 const result=f.client.search({});await new Promise(r=>setImmediate(r));if(reset)f.client.reset();else f.identity(session(OTHER));release();await assert.rejects(result,{code:'SESSION_CHANGED'});}
});


test('scanner uploads use the authenticated atomic RPC and remove photos from the order',async()=>{
 const seed=snapshot({...example(),schemaVersion:3,orders:[],assignments:{},vanConfirmed:{},lockedTrips:[]});
 const input=snapshot({...seed,orders:example().orders}).orders[0];
 const f=fixture({fetchImpl:async(url,init)=>{
  assert.ok(url.endsWith('/atlas_routing_scanner_upload'));
  const payload=JSON.parse(init.body);assert.equal(payload.p_warehouse,'CA');assert.equal('photos' in payload.p_order,false);
  return Response.json({warehouse:'CA',date:DAY,revision:1,canEdit:true,document:{...seed,orders:[input]},order:input,duplicate:false});
 }});
 const result=await f.client.upload(DAY,{...input,photos:['transient']},{parserVersion:'test'},seed);
 assert.equal(result.duplicate,false);assert.equal(result.document.orders.length,1);
});
test('scanner status and uploads reject late responses after account switch',async()=>{
 let finish;const pending=new Promise(resolve=>finish=resolve);
 const f=fixture({fetchImpl:async()=>{await pending;return Response.json({enabled:true,status:'pending'});}});
 const response=f.client.scannerStatus(DAY);await new Promise(resolve=>setImmediate(resolve));f.identity(session(OTHER));finish();
 await assert.rejects(response,{code:'SESSION_CHANGED'});
});
