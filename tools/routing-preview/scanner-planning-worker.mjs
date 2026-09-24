// Transport-independent worker preparation. No scheduler or remote connection starts on import.
import core from '../../atlas-routing-core.js';
import storage from '../../atlas-routing-storage.js';
import assignmentContract from '../../atlas-routing-assignment.js';
import planner from '../../atlas-routing-planner.js';

export function buildScannerDraft(input) {
 const doc=storage.document(input);
 const remaining=new Map(doc.orders.map(order=>[order.id,new Map()]));
 for(const order of doc.orders)for(const line of order.lines){
  const quantities=remaining.get(order.id);
  quantities.set(line.sku,(quantities.get(line.sku)||0)+line.caseQty);
 }
 const lockedOrders=new Set();
 for(const trip of doc.lockedTrips||[])for(const shipment of trip.shipments){
  lockedOrders.add(shipment.orderId);
  const quantities=remaining.get(shipment.orderId);
  for(const line of shipment.boxAllocation){
   const left=(quantities?.get(line.sku)??-1)-line.boxes;
   if(left<0)throw Error('PLANNING_FAILED');
   quantities.set(line.sku,left);
  }
 }
 const eligible=doc.orders.filter(order=>!order.deliveredOn&&(!order.dispatchedOn||lockedOrders.has(order.id)))
  .map(order=>({...order,lines:[...remaining.get(order.id)].filter(([,boxes])=>boxes>0)
   .map(([sku,caseQty])=>({sku,caseQty,itemQty:null}))})).filter(order=>order.lines.length);
 const analyzed=eligible.map(order=>core.analyzeOrder(order,doc.catalog));
 const draft=core.countTruckTrips(analyzed,{...doc.settings,nextLoadPriority:doc.nextLoadPriority || []});
 // Unknown specifications remain visible as unscheduled; never invent a box allocation.
 const allocated=new Map();
 for(const trip of draft.trips)for(const shipment of trip.shipments){
  if(!shipment.boxAllocation)throw Error('MISSING_SPECIFICATION');
  for(const line of shipment.boxAllocation){
   const key=shipment.orderId+':'+line.sku;
   allocated.set(key,(allocated.get(key)||0)+line.boxes);
  }
 }
 const unscheduled=new Set(draft.unscheduled.map(order=>order.orderId));
 for(const order of eligible)for(const line of order.lines){
  if(!unscheduled.has(order.id)&&allocated.get(order.id+':'+line.sku)!==line.caseQty)throw Error('PLANNING_FAILED');
 }
 return {trips:draft.trips,unscheduled:draft.unscheduled,warnings:draft.warnings,timingStatus:'unavailable',timed:null};
}

// Inject an authenticated service-side RPC adapter during a separately approved rollout.
// One invocation handles at most one day. Bursts and overlapping invocations are leased in SQL.
export async function runScannerPlanningOnce(rpc, traffic) {
 const job=await rpc('atlas_routing_scanner_claim',{});
 if(!job)return {status:'idle'};
 let plan=null,error=null;
 try {
  plan=buildScannerDraft(job.document);
  if(traffic && plan.trips.length && !job.document.lockedTrips?.length && !Object.values(job.document.assignments||{}).some(a=>assignmentContract.read(a).vehicleId!=='box_truck')){
   const loads=plan.trips.map((trip,i)=>{
    const assignment=job.document.assignments?.[i]||'Bubba:truck';
    return {...trip,...assignmentContract.load(assignment),palletTarget:job.document.settings.truckPalletTarget};
   });
   const timed=await planner.planDay({date:job.date,loads,orders:job.document.orders,
    ...traffic,departureNotBefore:(traffic.now ?? Date.now())+30*60000,preserveOrder:job.document.settings.preserveOrder,reloadMinutes:job.document.settings.reloadMinutes,
    lunchMinutes:planner.clock(job.document.settings.lunch)});
   // Save estimates, not driver assignments or dispatch commands. These are reviewed drafts.
   plan={...plan,timed,trips:timed.trips.map(({driver,vehicleId,vehicle,...trip})=>trip),
    unscheduled:[...plan.unscheduled,...timed.unscheduled],warnings:[...plan.warnings,...timed.warnings],timingStatus:'estimated'};
  } else if(job.document.lockedTrips?.length)plan.warnings.push('Sent-out trips are unchanged. Recalculate remaining departure times on desktop.');
 }
 catch(e){error=e.message==='MISSING_SPECIFICATION'?'MISSING_SPECIFICATION':'PLANNING_FAILED';}
 return rpc('atlas_routing_scanner_finish',{p_day:job.date,p_lease:job.lease,p_plan:plan,p_error:error});
}
