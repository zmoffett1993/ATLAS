import {authenticated,cors,encodeBase64,fail,hasRole,json,receiver,service,sha256,station} from "../_shared/coc.ts";
import QRCode from "npm:qrcode@1.5.4";

const randomDigits=()=>String(crypto.getRandomValues(new Uint32Array(1))[0]%1000000).padStart(6,"0");
const randomToken=()=>Array.from(crypto.getRandomValues(new Uint8Array(32))).map(value=>value.toString(16).padStart(2,"0")).join("");
const deliveryFields="id,status,report_snapshot,workbook_file_name,completed_at,sent_at,received_at,office_completed_at,receiver_archived_at";
const pageNumber=(value:unknown)=>Math.max(1,Math.min(100000,Number.parseInt(String(value||"1"),10)||1));
const pageSize=(value:unknown)=>Math.max(1,Math.min(50,Number.parseInt(String(value||"8"),10)||8));
const searchTerm=(value:unknown)=>String(value||"").trim().toLowerCase().replace(/[,%_()]/g," ").replace(/\s+/g," ").slice(0,120);
const sortSpec=(value:unknown)=>({
  oldest:["office_completed_at",true],
  "customer-asc":["receiver_customer_name",true],
  "customer-desc":["receiver_customer_name",false],
  "invoice-asc":["receiver_invoice_number",true],
  "invoice-desc":["receiver_invoice_number",false],
  "if-asc":["receiver_if_number",true],
  "if-desc":["receiver_if_number",false],
}[String(value||"")]||["office_completed_at",false]) as [string,boolean];
Deno.serve(async(req)=>{if(req.method==="OPTIONS")return new Response("ok",{headers:cors});try{
  const user=await authenticated(req),body=await req.json(),action=String(body.action||""),db=service();
  if(action==="official-template"){
    const path=Deno.env.get("COC_TEMPLATE_OBJECT_PATH")||"official/NEW COC 2.xlsx",download=await db.storage.from("coc-templates").download(path);if(download.error)throw Object.assign(new Error("COC_TEMPLATE_UNAVAILABLE"),{status:503});const bytes=new Uint8Array(await download.data.arrayBuffer()),expected=Deno.env.get("COC_TEMPLATE_SHA256")||"";if(expected&&await sha256(bytes)!==expected)throw Object.assign(new Error("COC_TEMPLATE_SIGNATURE_MISMATCH"),{status:503});return json({workbookBase64:encodeBase64(bytes)});
  }
  if(action==="station-status"){const target=await station(String(body.stationKey||"")),online=Boolean(target.last_heartbeat_at&&Date.now()-new Date(target.last_heartbeat_at).valueOf()<45000);return json({stationId:target.id,stationKey:target.station_key,displayName:target.display_name,online,lastHeartbeatAt:target.last_heartbeat_at})}
  if(action==="delivery-statuses"){const ids=(Array.isArray(body.deliveryIds)?body.deliveryIds:[]).slice(0,100);let query=db.from("coc_deliveries").select("id,status,sent_at,received_at,office_completed_at").in("id",ids);if(!hasRole(user,["office","office_receiver","supervisor","admin","administrator"]))query=query.eq("submitted_by_user_id",user.id);const result=await query;if(result.error)throw result.error;return json({deliveries:result.data})}
  if(action==="create-pairing"){const target=await station(String(body.stationKey||"")),pairingCode=randomDigits(),qrToken=randomToken(),expiresAt=new Date(Date.now()+10*60*1000).toISOString(),secret=String(body.deviceSecret||"");if(!secret||!body.devicePublicId)throw Object.assign(new Error("PAIRING_DEVICE_INVALID"),{status:400});const created=await db.from("coc_pairing_sessions").insert({station_id:target.id,device_public_id:body.devicePublicId,device_secret_hash:await sha256(secret),device_description:String(body.deviceDescription||"").slice(0,240),pairing_code_hash:await sha256(pairingCode),qr_token_hash:await sha256(qrToken),created_by_user_id:user.id,expires_at:expiresAt}).select("id").single();if(created.error)throw created.error;const appUrl=Deno.env.get("COC_APP_URL")||"https://atlas.example.invalid/";const separator=appUrl.includes("?")?"&":"?",qrSvg=await QRCode.toString(`${appUrl}${separator}cocPair=${encodeURIComponent(qrToken)}`,{type:"svg",margin:1,width:220,errorCorrectionLevel:"M"});return json({pairingSessionId:created.data.id,pairingCode,qrToken,qrSvg,expiresAt,status:"PENDING"})}
  if(action==="pairing-status"){const result=await db.from("coc_pairing_sessions").select("*,coc_stations(id,station_key)").eq("id",body.pairingSessionId).eq("device_public_id",body.devicePublicId).eq("created_by_user_id",user.id).single();if(result.error)throw Object.assign(new Error("PAIRING_NOT_FOUND"),{status:404});const item=result.data;if(item.status==="PENDING"&&new Date(item.expires_at).valueOf()<Date.now()){await db.from("coc_pairing_sessions").update({status:"EXPIRED"}).eq("id",item.id);return json({status:"EXPIRED"})}if(item.status!=="PAIRED")return json({status:item.status,expiresAt:item.expires_at});const device=await db.from("coc_receiver_devices").select("id,paired_at").eq("device_public_id",item.device_public_id).eq("active",true).single();if(device.error)throw device.error;return json({status:"PAIRED",stationId:item.station_id,deviceId:device.data.id,pairedAt:device.data.paired_at})}
  if(action==="approve-pairing"){
    if(!hasRole(user,["supervisor","admin","administrator"]))throw Object.assign(new Error("SUPERVISOR_REQUIRED"),{status:403});const target=await station(String(body.stationKey||"")),codeHash=body.pairingCode?await sha256(String(body.pairingCode)):"",qrHash=body.qrToken?await sha256(String(body.qrToken)):"";const candidates=await db.from("coc_pairing_sessions").select("*").eq("station_id",target.id).eq("status","PENDING").gt("expires_at",new Date().toISOString());if(candidates.error)throw candidates.error;const item=candidates.data.find((value:any)=>(codeHash&&value.pairing_code_hash===codeHash)||(qrHash&&value.qr_token_hash===qrHash));if(!item)throw Object.assign(new Error("PAIRING_CODE_INVALID_OR_EXPIRED"),{status:404});const current=await db.from("coc_receiver_devices").select("id").eq("station_id",target.id).eq("active",true);if(current.data?.length&&!body.replaceExisting)throw Object.assign(new Error("STATION_ALREADY_HAS_ACTIVE_RECEIVER"),{status:409});if(current.data?.length)await db.from("coc_receiver_devices").update({active:false,revoked_at:new Date().toISOString()}).eq("station_id",target.id).eq("active",true);const device=await db.from("coc_receiver_devices").insert({station_id:target.id,device_public_id:item.device_public_id,secret_hash:item.device_secret_hash,description:item.device_description,paired_by_user_id:user.id}).select("id,paired_at").single();if(device.error)throw device.error;await db.from("coc_pairing_sessions").update({status:"PAIRED",approved_by_user_id:user.id,approved_at:new Date().toISOString(),consumed_at:new Date().toISOString()}).eq("id",item.id).eq("status","PENDING");return json({status:"PAIRED",deviceId:device.data.id,pairedAt:device.data.paired_at})
  }
  const device=await receiver(req,user);if(device.coc_stations.station_key!==String(body.stationKey||device.coc_stations.station_key))throw Object.assign(new Error("RECEIVER_STATION_MISMATCH"),{status:403});
  if(action==="verify-receiver")return json({stationId:device.station_id,deviceId:device.id,displayName:device.coc_stations.display_name});
  if(action==="heartbeat"){const now=new Date().toISOString();await db.from("coc_receiver_devices").update({last_seen_at:now}).eq("id",device.id);await db.from("coc_stations").update({last_heartbeat_at:now,updated_at:now}).eq("id",device.station_id);return json({online:true,at:now})}
  if(action==="receiver-inbox"){
    const section=String(body.section||"");
    if(section==="metrics"){
      const suppliedStart=String(body.dayStart||""),dayStart=Number.isFinite(new Date(suppliedStart).valueOf())?suppliedStart:new Date(new Date().setHours(0,0,0,0)).toISOString();
      const [awaiting,receivedToday,completedToday]=await Promise.all([
        db.from("coc_deliveries").select("id",{count:"exact",head:true}).eq("station_id",device.station_id).in("status",["SENT","RECEIVED"]),
        db.from("coc_deliveries").select("id",{count:"exact",head:true}).eq("station_id",device.station_id).gte("received_at",dayStart),
        db.from("coc_deliveries").select("id",{count:"exact",head:true}).eq("station_id",device.station_id).eq("status","OFFICE_COMPLETED").gte("office_completed_at",dayStart),
      ]);
      for(const result of [awaiting,receivedToday,completedToday])if(result.error)throw result.error;
      return json({awaiting:awaiting.count||0,receivedToday:receivedToday.count||0,completedToday:completedToday.count||0});
    }
    if(section==="active"){
      const result=await db.from("coc_deliveries").select(deliveryFields).eq("station_id",device.station_id).in("status",["SENT","RECEIVED"]).order("sent_at",{ascending:false}).limit(100);
      if(result.error)throw result.error;return json({deliveries:result.data,total:result.data.length,page:1,pageSize:100});
    }
    if(section==="completed"||section==="archive"){
      const page=pageNumber(body.page),size=pageSize(body.pageSize),search=searchTerm(body.search),[sortColumn,ascending]=sortSpec(body.sort);
      let query=db.from("coc_deliveries").select(deliveryFields,{count:"exact"}).eq("station_id",device.station_id).eq("status","OFFICE_COMPLETED");
      query=section==="archive"?query.not("receiver_archived_at","is",null):query.is("receiver_archived_at",null);
      if(search)query=query.ilike("receiver_search_text",`%${search}%`);
      const result=await query.order(sortColumn,{ascending,nullsFirst:false}).order("id",{ascending:true}).range((page-1)*size,page*size-1);
      if(result.error)throw result.error;return json({deliveries:result.data,total:result.count||0,page,pageSize:size});
    }
    const result=await db.from("coc_deliveries").select(deliveryFields).eq("station_id",device.station_id).in("status",["SENT","RECEIVED","OFFICE_COMPLETED"]).is("receiver_archived_at",null).order("sent_at",{ascending:false}).limit(100);
    if(result.error)throw result.error;return json({deliveries:result.data});
  }
  if(action==="archive-completed"||action==="restore-archived"){
    const restoring=action==="restore-archived",archiveAll=Boolean(body.archiveAll)&&!restoring,ids=[...new Set((Array.isArray(body.deliveryIds)?body.deliveryIds:[]).map((value:unknown)=>String(value||"")).filter(Boolean))].slice(0,100);
    if(!archiveAll&&!ids.length)throw Object.assign(new Error("COC_ARCHIVE_SELECTION_REQUIRED"),{status:400});
    const now=new Date().toISOString(),changes=restoring?{receiver_archived_at:null,receiver_archived_by_user_id:null,updated_at:now}:{receiver_archived_at:now,receiver_archived_by_user_id:user.id,updated_at:now};
    let query=db.from("coc_deliveries").update(changes).eq("station_id",device.station_id).eq("status","OFFICE_COMPLETED");
    query=restoring?query.not("receiver_archived_at","is",null):query.is("receiver_archived_at",null);
    if(!archiveAll)query=query.in("id",ids);
    const result=await query.select("id");if(result.error)throw result.error;const updated=result.data||[];
    if(updated.length){const events=updated.map((item:any)=>({delivery_id:item.id,event_type:restoring?"COC_RECEIVER_RESTORED":"COC_RECEIVER_ARCHIVED",actor_user_id:user.id,actor_device_id:device.id,detail:{archive_all:archiveAll}})),logged=await db.from("coc_delivery_events").insert(events);if(logged.error)throw logged.error}
    return json({updated:updated.length,deliveryIds:updated.map((item:any)=>item.id),archived:!restoring});
  }
  if(action==="download-workbook"){const deliveryId=String(body.deliveryId||"");if(!deliveryId)throw Object.assign(new Error("COC_DELIVERY_REQUIRED"),{status:400});const result=await db.from("coc_deliveries").select("workbook_file_name,workbook_object_path").eq("id",deliveryId).eq("station_id",device.station_id).in("status",["RECEIVED","OFFICE_COMPLETED"]).single();if(result.error||!result.data?.workbook_object_path)throw Object.assign(new Error("COC_WORKBOOK_NOT_AVAILABLE"),{status:404});const signed=await db.storage.from("coc-reports").createSignedUrl(result.data.workbook_object_path,300);if(signed.error||!signed.data?.signedUrl)throw signed.error||Object.assign(new Error("COC_WORKBOOK_NOT_AVAILABLE"),{status:404});return json({fileName:result.data.workbook_file_name||"Company_COC.xlsx",downloadUrl:signed.data.signedUrl})}
  if(action==="acknowledge"){const now=new Date().toISOString(),result=await db.from("coc_deliveries").update({status:"RECEIVED",received_at:now,received_by_device_id:device.id,updated_at:now}).eq("id",body.deliveryId).eq("station_id",device.station_id).eq("status","SENT").select("id,status,received_at").maybeSingle();if(result.error)throw result.error;if(result.data)await db.from("coc_delivery_events").insert({delivery_id:result.data.id,event_type:"COC_RECEIVED",actor_user_id:user.id,actor_device_id:device.id});if(result.data)return json(result.data);const existing=await db.from("coc_deliveries").select("id,status,received_at").eq("id",body.deliveryId).eq("station_id",device.station_id).single();if(existing.error)throw existing.error;return json(existing.data)}
  if(action==="mark-completed"){const now=new Date().toISOString(),result=await db.from("coc_deliveries").update({status:"OFFICE_COMPLETED",office_completed_at:now,office_completed_by_user_id:user.id,updated_at:now}).eq("id",body.deliveryId).eq("station_id",device.station_id).eq("status","RECEIVED").select("id,status,office_completed_at").maybeSingle();if(result.error)throw result.error;if(result.data)await db.from("coc_delivery_events").insert({delivery_id:result.data.id,event_type:"COC_OFFICE_COMPLETED",actor_user_id:user.id,actor_device_id:device.id});if(result.data)return json(result.data);const existing=await db.from("coc_deliveries").select("id,status,office_completed_at").eq("id",body.deliveryId).eq("station_id",device.station_id).single();if(existing.error)throw existing.error;if(existing.data.status!=="OFFICE_COMPLETED")throw Object.assign(new Error("COC_MUST_BE_RECEIVED_FIRST"),{status:409});return json(existing.data)}
  throw Object.assign(new Error("COC_ACTION_NOT_SUPPORTED"),{status:400});
}catch(error){return fail(error)}});
