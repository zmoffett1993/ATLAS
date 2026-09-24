import { createClient } from 'npm:@supabase/supabase-js@2.57.4';
import { createHandler, digest, filename } from './handler.mjs';
import { createGmail, createEmailService } from './gmail.mjs';
const url=Deno.env.get('SUPABASE_URL')!,key=Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const admin=createClient(url,key,{auth:{persistSession:false,autoRefreshToken:false}});
const user=(authorization:string)=>createClient(url,Deno.env.get('SUPABASE_ANON_KEY')!,{global:{headers:{Authorization:authorization}},auth:{persistSession:false,autoRefreshToken:false}});
const checked=({data,error}:any)=>{if(error)throw Object.assign(Error('POD_ACCESS_OR_STORAGE_ERROR'),{status:error.code==='42501'?403:error.code==='40001'?409:500});return data;};
const download=async(b:any)=>{
  if(!b.document)throw Object.assign(Error('DOCUMENT_NOT_RECEIVED'),{status:404});
  const file=checked(await admin.storage.from('atlas-pod-documents').download(`${b.document.object_prefix}/document.pdf`));
  const bytes=new Uint8Array(await file.arrayBuffer());
  if(await digest(bytes)!==b.document.pdf_hash)throw Object.assign(Error('DOCUMENT_INTEGRITY_ERROR'),{status:409});
  return {bytes};
 };
const emailEnabled=Deno.env.get('ATLAS_POD_EMAIL_ENABLED')==='true';
const emailContext=async(token:string,id:string)=>checked(await user(token).rpc('atlas_pod_email_context',{p_submission:id}));
const email=createEmailService({enabled:emailEnabled,context:emailContext,download,filename,
 claim:async(b:any,input:any)=>checked(await admin.rpc('atlas_pod_email_claim',{p_submission:b.document.id,p_actor:b.actor_id,p_session:b.session_id,p_request:input.requestId,p_mode:input.mode})),
 finish:async(b:any,result:any)=>checked(await admin.rpc('atlas_pod_email_finish',{p_submission:b.document.id,p_attempt:result.attemptId,p_message:result.messageId||null,p_error:result.errorCode||null})),
 send:createGmail({clientId:Deno.env.get('GMAIL_CLIENT_ID'),clientSecret:Deno.env.get('GMAIL_CLIENT_SECRET'),refreshToken:Deno.env.get('GMAIL_REFRESH_TOKEN'),
 sender:Deno.env.get('GMAIL_SENDER_EMAIL'),recipient:Deno.env.get('POD_RECIPIENT_EMAIL'),replyTo:Deno.env.get('POD_REPLY_TO_EMAIL')})
});
const dynamicEnabled=Deno.env.get('ATLAS_DYNAMIC_DRIVERS_ENABLED')==='true';
const driverList=async(token:string,date:string)=>{
 const result=checked(await user(token).rpc('atlas_driver_my_trips',{p_day:date}));
 return result.trips.flatMap((trip:any)=>trip.stops.map((stop:any)=>({...stop,workflow:'assigned-trip',is_test:trip.isTest,trip_id:trip.id,trip_version:trip.version,
  warehouse_id:trip.warehouseId,submission:stop.submission||null,trip_index:trip.tripIndex,driver_name:trip.driverName,vehicle_id:trip.vehicleId,current:trip.isTest||trip.status==='sent'||trip.status==='complete',trip_status:trip.status,
  source_assignment:trip.driverName+':'+({box_truck:'truck',van_1:'van1',van_2:'van2'} as any)[trip.vehicleId],
  delivery:{timeWindow:stop.timeWindow,notes:stop.notes,checkOnDelivery:stop.checkOnDelivery,signatureRequired:stop.signatureRequired}})));
};
Deno.serve(createHandler({
 driverContext:dynamicEnabled?async(token:string,id:string)=>checked(await user(token).rpc('atlas_driver_pod_context',{p_stop:id})):undefined,
 driverReceive:dynamicEnabled?async(b:any,input:any)=>checked(await admin.rpc('atlas_driver_pod_receive',{p_stop:b.id,p_actor:b.actor_id,p_session:b.session_id,p_version:b.version,p_submission:input.id,p_manifest:input.manifest,p_filename:input.filename,p_pages:input.pages,p_pdf_hash:input.pdfHash||null})):undefined,
 cleanup:dynamicEnabled?async(token:string,input:any)=>{
  const plan=checked(await user(token).rpc('atlas_driver_cleanup_prepare',{p_trip:input.tripId,p_version:input.version,p_freeze:false}));
  if(!plan.ready)throw Object.assign(Error('Wait two minutes after freezing the test trip, then retry cleanup.'),{status:409});
  for(const bucket of ['atlas-pod-originals','atlas-pod-documents']){
   const paths=plan.files.filter((f:any)=>f.bucket===bucket).map((f:any)=>f.path);
   if(paths.some((p:string)=>!p.startsWith('pod-test/')||!p.includes('/'+input.tripId+'/')))throw Error('INVALID_TEST_PATH');
   if(paths.length)checked(await admin.storage.from(bucket).remove(paths));
  }
  return checked(await admin.rpc('atlas_driver_cleanup_finish',{p_trip:input.tripId,p_version:plan.version,p_actor:plan.actor,p_session:plan.session}));
 }:undefined,
 email,emailEnabled,
 enabled:Deno.env.get('ATLAS_POD_ENABLED')==='true',
 origins:(Deno.env.get('ATLAS_POD_ORIGINS')||'').split(',').map(s=>s.trim()).filter(Boolean),
 authenticate:async(token:string)=>{const result=await admin.auth.getUser(token.slice(7));if(result.error)throw Object.assign(Error('AUTH_REQUIRED'),{status:401});return result.data.user;},
 context:async(token:string,id:string)=>checked(await user(token).rpc('atlas_pod_context',{p_binding:id})),
 list:async(token:string,date:string,driverOnly=false)=>{
  if(dynamicEnabled&&driverOnly)return {capability:'driver',warehouse:'CA',shipments:await driverList(token,date)};
  const legacy=await user(token).rpc('atlas_pod_list',{p_day:date});
  if(!dynamicEnabled)return checked(legacy);
  if(legacy.error && legacy.error.code!=='42501')return checked(legacy);
  const assigned=await driverList(token,date);
  return {...(legacy.error?{capability:'driver',warehouse:'CA'}:legacy.data),shipments:[...(legacy.data?.shipments||[]).filter((s:any)=>!assigned.some((a:any)=>a.id===s.id)),...assigned]};
 },
 receive:async(b:any,input:any)=>checked(await admin.rpc('atlas_pod_receive',{p_binding:b.id,p_actor:b.actor_id,p_session:b.session_id,p_submission:input.id,p_manifest:input.manifest,p_filename:input.filename,p_pages:input.pages,p_pdf_hash:input.pdfHash||null})),
 putImmutable:async(bucket:string,path:string,bytes:Uint8Array,contentType:string)=>{
  const result=await admin.storage.from(bucket).upload(path,bytes,{contentType,upsert:false});
  if(!result.error)return;
  // An uncertain retry may encounter its own immutable object. Compare content;
  // never overwrite an object or accept an unverified collision.
  const existing=checked(await admin.storage.from(bucket).download(path));
  if(await digest(new Uint8Array(await existing.arrayBuffer()))!==await digest(bytes))throw Object.assign(Error('IMMUTABLE_OBJECT_CONFLICT'),{status:409});
 },
 download,

}));
