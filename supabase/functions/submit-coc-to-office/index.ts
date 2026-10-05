import {authenticated,cors,decodeBase64,fail,json,normalizeWarehouseCode,service,sha256,stationForWarehouse} from "../_shared/coc.ts";

const metricInteger=(value:unknown,maximum=1000000)=>{const number=Number(value);return Number.isSafeInteger(number)&&number>=0?Math.min(number,maximum):0;};
const submissionMetrics=(snapshot:any)=>{
  const analytics=snapshot?.analytics||{};
  const lots=(Array.isArray(snapshot?.pallets)?snapshot.pallets:[]).flatMap((pallet:any)=>Array.isArray(pallet?.lots)?pallet.lots:[]);
  const manualMethods=new Set(["manual","manual_review","manual_edit","manual_entry"]);
  const scanSuccesses=metricInteger(analytics.scanSuccesses);
  const scanFailures=metricInteger(analytics.scanFailures);
  const scanAttempts=Math.max(metricInteger(analytics.scanAttempts),scanSuccesses+scanFailures);
  return {
    warehouse_active_duration_ms:metricInteger(analytics.activeDurationMs,2592000000)||null,
    scan_attempt_count:scanAttempts,
    scan_success_count:Math.min(scanSuccesses,scanAttempts),
    scan_canceled_count:metricInteger(analytics.scanCanceled),
    distinct_lot_count:lots.length,
    manual_lot_count:lots.filter((lot:any)=>manualMethods.has(String(lot?.captureMethod||"").toLowerCase())).length,
  };
};

Deno.serve(async(req)=>{if(req.method==="OPTIONS")return new Response("ok",{headers:cors});try{
  const user=await authenticated(req),body=await req.json(),db=service();
  const snapshotWarehouse=normalizeWarehouseCode(body.reportSnapshot?.warehouseCode)||"CA";
  const resolved=await stationForWarehouse(user,body.warehouseCode||snapshotWarehouse),target=resolved.station,warehouse=resolved.context.selectedWarehouse;
  if(snapshotWarehouse!==warehouse.code)throw Object.assign(new Error("COC_WAREHOUSE_IMMUTABLE"),{status:409});
  const cocId=String(body.cocId||"").slice(0,140),idempotencyKey=String(body.idempotencyKey||"").slice(0,240);
  const forceResend=body.forceResend===true;
  if(!cocId||!idempotencyKey||!body.reportSnapshot||!body.workbookBase64)throw Object.assign(new Error("COC_SUBMISSION_INVALID"),{status:400});
  const existing=await db.from("coc_deliveries").select("id,warehouse_id,status,sent_at,received_at,office_completed_at,submitted_by_user_id,workbook_object_path,created_at").eq("idempotency_key",idempotencyKey).maybeSingle();
  if(existing.data?.submitted_by_user_id!==undefined&&existing.data.submitted_by_user_id!==user.id)throw Object.assign(new Error("COC_IDEMPOTENCY_OWNER_MISMATCH"),{status:403});
  if(existing.data?.warehouse_id&&existing.data.warehouse_id!==warehouse.id)throw Object.assign(new Error("COC_WAREHOUSE_IMMUTABLE"),{status:409});
  if(existing.data&&forceResend&&existing.data.status!=="WAREHOUSE_COMPLETE"){
    if(existing.data.status==="OFFICE_COMPLETED")throw Object.assign(new Error("COC_ALREADY_COMPLETED_AT_OFFICE"),{status:409});
    const resentAt=new Date().toISOString();
    const reset=await db.from("coc_deliveries").update({status:"SENT",sent_at:resentAt,received_at:null,received_by_device_id:null,updated_at:resentAt}).eq("id",existing.data.id).neq("status","OFFICE_COMPLETED").select("id").maybeSingle();
    if(reset.error)throw reset.error;
    if(!reset.data)throw Object.assign(new Error("COC_ALREADY_COMPLETED_AT_OFFICE"),{status:409});
    await db.from("coc_delivery_events").insert({delivery_id:existing.data.id,event_type:"COC_SENT",actor_user_id:user.id,detail:{resend:true}});
    return json({deliveryId:existing.data.id,status:"SENT",sentAt:resentAt,resent:true});
  }
  if(existing.data&&existing.data.status!=="WAREHOUSE_COMPLETE")return json({deliveryId:existing.data.id,status:existing.data.status,sentAt:existing.data.sent_at,receivedAt:existing.data.received_at,officeCompletedAt:existing.data.office_completed_at,idempotent:true});
  if(existing.data?.status==="WAREHOUSE_COMPLETE"){if(Date.now()-new Date(existing.data.created_at).valueOf()<120000)throw Object.assign(new Error("COC_SUBMISSION_IN_PROGRESS"),{status:409});if(existing.data.workbook_object_path)await db.storage.from("coc-reports").remove([existing.data.workbook_object_path]);await db.from("coc_deliveries").delete().eq("id",existing.data.id).eq("status","WAREHOUSE_COMPLETE")}
  const snap={...body.reportSnapshot,warehouseCode:warehouse.code,warehouseName:warehouse.display_name};
  if(snap.id!==cocId||snap.status!=="report"||!snap.completedAt||!Array.isArray(snap.pallets)||!snap.pallets.length)throw Object.assign(new Error("COC_REPORT_NOT_COMPLETE"),{status:409});
  for(const pallet of snap.pallets){const recorded=(pallet.lots||[]).reduce((sum:number,lot:any)=>sum+Number(lot.cases||0),0);if(!Number.isInteger(recorded)||recorded!==Number(pallet.expectedBoxes)||pallet.verificationState!=="completed")throw Object.assign(new Error(`PALLET_${pallet.number}_NOT_VERIFIED`),{status:409})}
  const bytes=decodeBase64(body.workbookBase64);if(bytes.length<1000||bytes.length>15728640)throw Object.assign(new Error("COC_WORKBOOK_SIZE_INVALID"),{status:413});
  const workbookHash=await sha256(bytes),fileName=String(body.workbookFileName||`COC_${cocId}.xlsx`).replace(/[^A-Za-z0-9_.-]/g,"_").slice(0,160),objectPath=`${target.id}/${cocId}/${workbookHash}.xlsx`;
  const created=await db.from("coc_deliveries").insert({coc_id:cocId,station_id:target.id,warehouse_id:warehouse.id,idempotency_key:idempotencyKey,submitted_by_user_id:user.id,status:"WAREHOUSE_COMPLETE",report_snapshot:snap,workbook_file_name:fileName,workbook_object_path:objectPath,completed_at:snap.completedAt,...submissionMetrics(snap)}).select("id").single();
  if(created.error){const race=await db.from("coc_deliveries").select("id,status,sent_at").eq("idempotency_key",idempotencyKey).maybeSingle();if(race.data?.status&&race.data.status!=="WAREHOUSE_COMPLETE")return json({deliveryId:race.data.id,status:race.data.status,sentAt:race.data.sent_at,idempotent:true});if(race.data)throw Object.assign(new Error("COC_SUBMISSION_IN_PROGRESS"),{status:409});throw created.error}
  const deliveryId=created.data.id;
  await db.from("coc_delivery_events").insert({delivery_id:deliveryId,event_type:"COC_COMPLETED",actor_user_id:user.id,detail:{workbook_sha256:workbookHash}});
  const upload=await db.storage.from("coc-reports").upload(objectPath,bytes,{contentType:"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",upsert:false});
  if(upload.error){await db.from("coc_deliveries").delete().eq("id",deliveryId);throw upload.error}
  const sentAt=new Date().toISOString();const updated=await db.from("coc_deliveries").update({status:"SENT",sent_at:sentAt,updated_at:sentAt}).eq("id",deliveryId).eq("status","WAREHOUSE_COMPLETE");if(updated.error)throw updated.error;
  await db.from("coc_delivery_events").insert({delivery_id:deliveryId,event_type:"COC_SENT",actor_user_id:user.id});
  return json({deliveryId,status:"SENT",sentAt});
}catch(error){return fail(error)}});
