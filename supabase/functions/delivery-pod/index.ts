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
Deno.serve(createHandler({
 email,emailEnabled,
 enabled:Deno.env.get('ATLAS_POD_ENABLED')==='true',
 origins:(Deno.env.get('ATLAS_POD_ORIGINS')||'').split(',').map(s=>s.trim()).filter(Boolean),
 authenticate:async(token:string)=>{const result=await admin.auth.getUser(token.slice(7));if(result.error)throw Object.assign(Error('AUTH_REQUIRED'),{status:401});return result.data.user;},
 context:async(token:string,id:string)=>checked(await user(token).rpc('atlas_pod_context',{p_binding:id})),
 list:async(token:string,date:string)=>checked(await user(token).rpc('atlas_pod_list',{p_day:date})),
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
