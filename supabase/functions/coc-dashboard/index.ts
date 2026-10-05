import {authenticated,cors,fail,hasRole,json,service,stationForWarehouse,warehouseDayStart} from "../_shared/coc.ts";

const deliveryFields="id,coc_id,station_id,warehouse_id,status,report_snapshot,workbook_file_name,workbook_object_path,created_at,completed_at,sent_at,received_at,office_completed_at,submitted_by_user_id";
const pageNumber=(value:unknown)=>Math.max(1,Math.min(100000,Number.parseInt(String(value||"1"),10)||1));
const pageSize=(value:unknown)=>Math.max(1,Math.min(50,Number.parseInt(String(value||"8"),10)||8));
const searchTerm=(value:unknown)=>String(value||"").trim().toLowerCase().replace(/[,%_()]/g," ").replace(/\s+/g," ").slice(0,120);
const sortSpec=(value:unknown)=>({oldest:["created_at",true],"customer-asc":["receiver_customer_name",true]}[String(value||"")]||["created_at",false]) as [string,boolean];

const withSubmitterNames=async(db:any,deliveries:any[])=>{
  const items=Array.isArray(deliveries)?deliveries:[];
  const ids=[...new Set(items.map((item:any)=>String(item?.submitted_by_user_id||"")).filter(Boolean))];
  const names=new Map<string,string>();
  if(ids.length){
    const profiles=await db.from("profiles").select("user_id,display_name").in("user_id",ids);
    if(!profiles.error)for(const profile of profiles.data||[])names.set(String(profile.user_id),String(profile.display_name||"").trim());
  }
  return items.map((item:any)=>({...item,submitted_by_display_name:names.get(String(item.submitted_by_user_id||""))||String(item.report_snapshot?.employeeDisplayName||item.report_snapshot?.employee||"").trim()}));
};

Deno.serve(async(req)=>{
  if(req.method==="OPTIONS")return new Response("ok",{headers:cors});
  try{
    const user=await authenticated(req);
    if(!hasRole(user,["supervisor","admin","administrator"]))throw Object.assign(new Error("SUPERVISOR_REQUIRED"),{status:403});
    const body=await req.json(),action=String(body.action||""),db=service();
    const resolved=await stationForWarehouse(user,body.warehouseCode);
    const target=resolved.station;

    if(action==="metrics"){
      const dayStart=warehouseDayStart(String(target.warehouses?.time_zone||"UTC"));
      const performanceRange=["7","30","all"].includes(String(body.performanceRange||""))?String(body.performanceRange):"30";
      const performanceStart=performanceRange==="all"?null:new Date(Date.now()-Number(performanceRange)*86400000).toISOString();
      const [total,awaiting,receivedToday,completedToday,performance]=await Promise.all([
        db.from("coc_deliveries").select("id",{count:"exact",head:true}).eq("station_id",target.id),
        db.from("coc_deliveries").select("id",{count:"exact",head:true}).eq("station_id",target.id).in("status",["SENT","RECEIVED"]),
        db.from("coc_deliveries").select("id",{count:"exact",head:true}).eq("station_id",target.id).gte("received_at",dayStart),
        db.from("coc_deliveries").select("id",{count:"exact",head:true}).eq("station_id",target.id).eq("status","OFFICE_COMPLETED").gte("office_completed_at",dayStart),
        db.rpc("coc_performance_metrics",{p_station_id:target.id,p_range_start:performanceStart}),
      ]);
      for(const result of [total,awaiting,receivedToday,completedToday,performance])if(result.error)throw result.error;
      const measured=performance.data?.[0]||{};
      return json({
        warehouse:resolved.context.selectedWarehouse,
        total:total.count||0,awaiting:awaiting.count||0,receivedToday:receivedToday.count||0,completedToday:completedToday.count||0,
        performanceRange,
        performance:{
          completionSamples:Number(measured.completion_sample_count||0),
          averageActiveDurationMs:Number(measured.average_active_duration_ms||0),
          medianActiveDurationMs:Number(measured.median_active_duration_ms||0),
          scanAttempts:Number(measured.scan_attempt_count||0),
          scanSuccesses:Number(measured.scan_success_count||0),
          scanCanceled:Number(measured.scan_canceled_count||0),
          distinctLots:Number(measured.distinct_lot_count||0),
          manualLots:Number(measured.manual_lot_count||0),
        },
      });
    }

    if(action==="list"){
      const section=String(body.section||"all"),page=pageNumber(body.page),size=pageSize(body.pageSize),search=searchTerm(body.search),[sortColumn,ascending]=sortSpec(body.sort);
      let query=db.from("coc_deliveries").select(deliveryFields,{count:"exact"}).eq("station_id",target.id);
      if(section==="active")query=query.in("status",["SENT","RECEIVED"]);
      else if(section==="completed")query=query.eq("status","OFFICE_COMPLETED");
      else if(section!=="all")throw Object.assign(new Error("COC_SECTION_INVALID"),{status:400});
      if(search)query=query.ilike("receiver_search_text",`%${search}%`);
      const result=await query.order(sortColumn,{ascending,nullsFirst:false}).order("id",{ascending:true}).range((page-1)*size,page*size-1);
      if(result.error)throw result.error;
      return json({warehouse:resolved.context.selectedWarehouse,deliveries:await withSubmitterNames(db,result.data||[]),total:result.count||0,page,pageSize:size});
    }

    if(action==="download-workbook"){
      const deliveryId=String(body.deliveryId||"");
      if(!deliveryId)throw Object.assign(new Error("COC_DELIVERY_REQUIRED"),{status:400});
      const result=await db.from("coc_deliveries").select("workbook_file_name,workbook_object_path").eq("id",deliveryId).eq("station_id",target.id).single();
      if(result.error||!result.data?.workbook_object_path)throw Object.assign(new Error("COC_WORKBOOK_NOT_AVAILABLE"),{status:404});
      const signed=await db.storage.from("coc-reports").createSignedUrl(result.data.workbook_object_path,300);
      if(signed.error||!signed.data?.signedUrl)throw signed.error||Object.assign(new Error("COC_WORKBOOK_NOT_AVAILABLE"),{status:404});
      return json({fileName:result.data.workbook_file_name||"Official_COC.xlsx",downloadUrl:signed.data.signedUrl});
    }

    if(action==="delete-coc"){
      if(!hasRole(user,["admin","administrator"]))throw Object.assign(new Error("ADMINISTRATOR_REQUIRED"),{status:403});
      const deliveryId=String(body.deliveryId||""),reason=String(body.reason||"").trim().slice(0,300);
      if(!deliveryId)throw Object.assign(new Error("COC_DELIVERY_REQUIRED"),{status:400});
      if(reason.length<4)throw Object.assign(new Error("COC_DELETE_REASON_REQUIRED"),{status:400});
      const selected=await db.from("coc_deliveries").select("*").eq("id",deliveryId).eq("station_id",target.id).single();
      if(selected.error||!selected.data)throw Object.assign(new Error("COC_NOT_FOUND"),{status:404});
      if(selected.data.status!=="OFFICE_COMPLETED")throw Object.assign(new Error("ONLY_COMPLETED_COCS_CAN_BE_DELETED"),{status:409});
      const deleted=await db.rpc("delete_completed_coc_with_audit",{p_delivery_id:deliveryId,p_station_id:target.id,p_deleted_by_user_id:user.id,p_reason:reason});
      if(deleted.error||!deleted.data?.[0])throw deleted.error||Object.assign(new Error("COC_DELETE_CONFLICT"),{status:409});
      const result=deleted.data[0];
      let workbookRemoved=true;
      if(result.workbook_object_path){const storage=await db.storage.from("coc-reports").remove([result.workbook_object_path]);workbookRemoved=!storage.error;}
      return json({deleted:true,deliveryId,auditId:result.audit_id,deletedAt:result.deleted_at,workbookRemoved});
    }

    throw Object.assign(new Error("COC_DASHBOARD_ACTION_NOT_SUPPORTED"),{status:400});
  }catch(error){return fail(error)}
});
