import test from 'node:test';
import assert from 'node:assert/strict';
import {createGmail,createEmailService,makeMessage,MAX_PDF_BYTES} from '../supabase/functions/delivery-pod/gmail.mjs';
import {createHandler,filename} from '../supabase/functions/delivery-pod/handler.mjs';
import {makePdf} from '../supabase/functions/delivery-pod/pdf.mjs';
import jpeg from './fixtures/pod-jpeg.cjs';
const id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const pdf=makePdf([jpeg]);
const config={clientId:'synthetic-client',clientSecret:'synthetic-secret',refreshToken:'synthetic-refresh',sender:'chubbygorilla.pod@gmail.com',recipient:'calogistics@chubbygorilla.com',replyTo:'calogistics@chubbygorilla.com'};
const b={id:id(1),actor_id:id(2),session_id:id(3),capability:'driver',sales_order:'SO-US-68032',shipment_number:1,shipment_total:1,document:{id:id(4),filename:'POD-SO-68032.pdf'}};
const input={action:'send-email',podId:id(4),requestId:id(5),mode:'send'};
const req=(extra={},headers={Authorization:'Bearer synthetic'})=>new Request('https://pod.invalid',{method:'POST',headers:{'Content-Type':'application/json',...headers},body:JSON.stringify({...input,...extra})});
function rig(overrides={}){
 let state={email_status:'pending'},sends=0,mode='ok',capability='driver';
 const send=createGmail({...config,fetcher:async(url,opts)=>{
  if(url.includes('oauth2'))return Response.json({access_token:'synthetic-access'});
  sends++;assert.equal(opts.redirect,'error');assert.equal(JSON.parse(opts.body).raw.includes('synthetic-secret'),false);
  if(mode==='lost')throw Error('synthetic-access must never escape');
  return mode==='reject'?Response.json({error:'synthetic-secret'},{status:403}):Response.json({id:'gmail123'});
 }});
 const email=createEmailService({enabled:true,filename,context:async()=>({...b,capability}),download:async()=>({bytes:pdf}),send,
  claim:async(_,i)=>{if(state.email_status==='sent'||state.email_status==='sending'||(i.mode==='send'&&state.email_status!=='pending'))return {...state,claimed:false};state={email_status:'sending'};return {...state,claimed:true,attempt_id:i.requestId};},
  finish:async(_,r)=>{state={email_status:r.messageId?'sent':'failed',gmail_message_id:r.messageId,email_error_code:r.errorCode,email_sent_at:r.messageId?'2026-09-22T00:00:00Z':null};return state;},...overrides});
 const handler=createHandler({enabled:true,emailEnabled:true,authenticate:async()=>({id:b.actor_id}),email});
 return {handler,get state(){return state;},get sends(){return sends;},set mode(v){mode=v;},set capability(v){capability=v;}};
}
test('Gmail MIME matches standard/split names, locked addresses and original PDF bytes',()=>{
 for(const total of [1,2]){
  const name=filename({...b,shipment_total:total}),raw=makeMessage({...config,bytes:pdf,filename:name,attemptId:id(5)}),mime=Buffer.from(raw,'base64url').toString();
  assert.match(mime,/From: ATLAS POD Delivery <chubbygorilla.pod@gmail.com>\r\nTo: calogistics@chubbygorilla.com\r\nReply-To: calogistics@chubbygorilla.com/);
  assert.ok(mime.includes(`Subject: POD-SO-68032${total===2?'-SHIPMENT-1-OF-2':''}\r\n`));assert.ok(mime.includes(`filename="${name}"`));assert.ok(mime.includes('POD attached.'));
  const encoded=mime.split('Content-Disposition:')[1].split('\r\n\r\n')[1].split('\r\n--')[0];assert.deepEqual(Buffer.from(encoded,'base64'),Buffer.from(pdf));
 }
 for(const bytes of [new Uint8Array([1,2]),new Uint8Array(MAX_PDF_BYTES+1)])assert.throws(()=>makeMessage({...config,bytes,filename:b.document.filename,attemptId:id(5)}));
 assert.throws(()=>makeMessage({...config,sender:'sender@example.com\r\nBcc: injected@example.com',bytes:pdf,filename:b.document.filename,attemptId:id(5)}));
});
test('Gmail endpoint rejects overrides, unauthenticated callers and unauthorized record access',async()=>{
 const r=rig();for(const extra of [{sender:'other@example.com'},{recipient:'other@example.com'},{filename:'bad.pdf'},{path:'other/document.pdf'}])assert.equal((await r.handler(req(extra))).status,400);
 assert.equal((await r.handler(req({},{}))).status,401);
 const denied=rig({context:async()=>{throw Object.assign(Error('ACCESS_DENIED'),{status:403});}});assert.equal((await denied.handler(req())).status,403);
 const wrong=rig({context:async()=>({...b,actor_id:id(9)})});assert.equal((await wrong.handler(req())).status,403);
 assert.equal(r.sends,0);
});
test('send success stores receipt; concurrent and repeated submissions send once',async()=>{
 const r=rig();const responses=await Promise.all([r.handler(req()),r.handler(req())]);assert.ok(responses.every(s=>s.status===200));assert.equal(r.sends,1);
 const body=await(await r.handler(req())).json();assert.equal(body.email_status,'sent');assert.equal(body.gmail_message_id,'gmail123');assert.ok(body.email_sent_at);assert.equal(r.sends,1);
});
test('failed email preserves receipt and allows office retry without another upload',async()=>{
 const r=rig();r.mode='reject';const fail=await(await r.handler(req())).json();assert.equal(fail.email_status,'failed');assert.equal(fail.email_error_code,'GMAIL_SEND_REJECTED');assert.ok(!JSON.stringify(fail).includes('synthetic-secret'));
 assert.equal((await r.handler(req({mode:'retry'}))).status,403);r.capability='office';r.mode='ok';
 assert.equal((await(await r.handler(req({mode:'retry',requestId:id(6)}))).json()).email_status,'sent');assert.equal(r.sends,2);
});
test('missing/invalid PDF, disabled sending and token failure make no email request',async()=>{
 for(const overrides of [{download:async()=>{throw Error('missing');}},{download:async()=>({bytes:new Uint8Array([1,2])})},{enabled:false}]){
  const r=rig(overrides);assert.equal((await r.handler(req())).status,200);assert.equal(r.sends,0);
 }
 let calls=0;const send=createGmail({...config,fetcher:async()=>{calls++;return Response.json({error:'private-provider-detail'},{status:400});}});
 await assert.rejects(send({bytes:pdf,filename:b.document.filename,attemptId:id(5),beforeSend:async()=>{}}),{message:'GMAIL_AUTH_REQUIRED'});assert.equal(calls,1);
});
test('ambiguous send and lost status persistence never cause an automatic second send',async()=>{
 const r=rig();r.mode='lost';assert.equal((await(await r.handler(req())).json()).email_error_code,'SEND_OUTCOME_UNKNOWN');await r.handler(req());assert.equal(r.sends,1);
 const lost=rig({finish:async()=>{throw Error('database secret');}});const body=await(await lost.handler(req())).json();assert.deepEqual(body,{email_status:'sending',email_error_code:'SEND_OUTCOME_UNKNOWN'});await lost.handler(req());assert.equal(lost.sends,1);
});
