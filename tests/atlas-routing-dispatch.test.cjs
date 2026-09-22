const test = require('node:test');
const assert = require('node:assert/strict');
const core = require('../atlas-routing-core.js');
const order = (id, palletSpaces) => ({id,customer:id,palletSpaces,lines:[]});
const options = {truckPalletTarget:11,dailyTripTarget:3,lockedTrips:[]};
test('priority move preserves every order and exposes actual repacked loads',()=>{
 const orders=[order('A',8),order('B',5),order('C',4),order('D',6)];
 const result=core.previewPriorityMove(orders,options,'D',1,['C']);
 assert.deepEqual(result.orders.map(o=>o.id),['A','D','B','C']);
 assert.deepEqual(result.after.trips.map(t=>t.palletSpaces),[8,11,4]);
 assert.deepEqual(orders.map(o=>o.id),['A','B','C','D']);
 assert.deepEqual(result.displaced,['C']);assert.equal(result.actualTrip,1);
});
test('sent-out orders and target trips cannot be moved',()=>{
 const orders=[{...order('A',8),dispatchedOn:'2026-09-21'},order('B',5)];
 const locked={...options,lockedTrips:[{shipments:[{orderId:'A',palletSpaces:8,boxAllocation:[]}],palletSpaces:8,sentOn:'2026-09-21'}]};
 assert.throws(()=>core.previewPriorityMove(orders,locked,'A',1),/not been sent out/);
 assert.throws(()=>core.previewPriorityMove(orders,locked,'B',0),/not been sent out/);
 assert.throws(()=>core.previewPriorityMove(orders,options,'A',0),/not been sent out/);
});
test('oversized orders retain all split quantities and locked allocations',()=>{
 const orders=[order('A',24),order('B',3)];
 const result=core.previewPriorityMove(orders,options,'B',0);
 assert.equal(result.after.trips.flatMap(t=>t.shipments).filter(s=>s.orderId==='A').reduce((n,s)=>n+s.palletSpaces,0),24);
 assert.throws(()=>core.previewPriorityMove(orders,options,'B',0,['A']),/Split shipments/);
});
test('invalid displacement cannot silently remove or duplicate orders',()=>{
 const orders=[order('A',8),order('B',5)];
 assert.throws(()=>core.previewPriorityMove(orders,options,'B',0,['B']),/Review the orders/);
 assert.throws(()=>core.previewPriorityMove(orders,options,'B',0,['unknown']),/Review the orders/);
});
