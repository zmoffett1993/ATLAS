const test=require('node:test');
const assert=require('node:assert/strict');
const core=require('../atlas-routing-core.js');
const storage=require('../atlas-routing-storage.js');
const catalog=[{model:'CGSC1-8OZ',caseQty:'200',caseDimensions:'24X20X16',caseWeightLb:'25',boxesPerPallet:'20',palletDimensions:'49X41X81',sourceRow:1}];
const id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const order=(n,pallets)=>({id:id(n),orderNumber:`SO-${n}`,customer:`Test ${n}`,address:'1 Test St',city:'Fullerton',timeWindow:'',notes:'',serviceMinutes:25,checkOnDelivery:false,lines:[{sku:'CGSC1-8OZ-0401',caseQty:pallets*20,itemQty:null}]});
const doc=()=>({schemaVersion:3,date:'2026-09-22',orders:[order(1,4),order(2,7),order(3,3)],catalog,settings:{truckPalletTarget:11,dailyTripTarget:3,reloadMinutes:40,lunch:'12:00',preserveOrder:false},assignments:{},vanConfirmed:{},lockedTrips:[],nextLoadPriority:[id(3),id(1)]});
const plan=d=>core.countTruckTrips(d.orders.map(o=>core.analyzeOrder(o,d.catalog)),{...d.settings,lockedTrips:d.lockedTrips,nextLoadPriority:d.nextLoadPriority});
test('explicit next-load sequence survives storage and original row sorting',()=>{
 const d=storage.document(doc()),before=JSON.stringify(d.orders);
 assert.deepEqual(plan(d).trips[0].shipments.map(s=>s.orderId),[id(3),id(1)]);
 assert.equal(plan(d).trips[1].palletSpaces,7);assert.equal(JSON.stringify(d.orders),before);
 const restored=storage.document(JSON.parse(JSON.stringify(d)));
 assert.deepEqual(plan(restored),plan(d));
 const ordinary=plan({...d,nextLoadPriority:[]});assert.equal(ordinary.trips[0].palletSpaces,11);
 assert.deepEqual(ordinary.trips[0].shipments.map(s=>s.orderId),[id(1),id(2)]);
});
test('priority does not lose oversized allocations or unknown orders',()=>{
 const d=doc();d.orders=[order(1,15),order(2,4),order(3,3)];d.nextLoadPriority=[id(3)];
 const p=plan(d);assert.equal(p.trips.flatMap(t=>t.shipments).flatMap(s=>s.boxAllocation).reduce((n,b)=>n+b.boxes,0),440);
 assert.ok(p.trips.every(t=>t.palletSpaces<=11));
 const unknown=core.analyzeOrder({...order(4,1),lines:[{sku:'UNKNOWN',caseQty:5}]},catalog);
 assert.equal(core.countTruckTrips([unknown],{nextLoadPriority:[id(4)]}).unscheduled.length,1);
});
test('saved priorities cannot reference missing, duplicate, or sent-out orders',()=>{
 const d=doc();
 for(const list of [[id(99)],[id(1),id(1)],null])assert.throws(()=>storage.document({...d,nextLoadPriority:list}));
 d.orders[0].dispatchedOn=d.date;d.nextLoadPriority=[id(1)];assert.throws(()=>storage.document(d));
 const legacy=doc();delete legacy.nextLoadPriority;assert.equal(Object.hasOwn(storage.document(legacy),'nextLoadPriority'),false);
});
