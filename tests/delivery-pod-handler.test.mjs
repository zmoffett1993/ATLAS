import test from 'node:test';
import assert from 'node:assert/strict';
import jpeg from './fixtures/pod-jpeg.cjs';
import {createHandler} from '../supabase/functions/delivery-pod/handler.mjs';
import {makePdf,jpegSize} from '../supabase/functions/delivery-pod/pdf.mjs';
const binding='11111111-1111-4111-8111-111111111111',submission='22222222-2222-4222-8222-222222222222';
const sample={id:binding,actor_id:'actor',warehouse_id:'ca',session_id:'session',sales_order:'SO-US-68032',shipment_number:1,shipment_total:2};
function rig(overrides={}){const writes=[],receipts=[];let contexts=0;return {writes,receipts,get contexts(){return contexts;},handle:createHandler({enabled:true,origins:['https://test.example'],authenticate:async()=>({id:'actor'}),context:async()=>{contexts++;return sample;},list:async()=>({shipments:[]}),receive:async(b,input)=>{receipts.push(input);return{id:input.id,state:input.pdfHash?'received':'uploading',object_prefix:`${b.warehouse_id}/${b.id}/${input.id}`};},putImmutable:async(...args)=>writes.push(args),download:async()=>({bytes:makePdf([jpeg])}),...overrides})};}
function request({origin='https://test.example',reviewed='true',page=jpeg,id=binding}={}){const form=new FormData();form.set('bindingId',id);form.set('submissionId',submission);form.set('reviewed',reviewed);form.append('original',new Blob([jpeg],{type:'image/jpeg'}),'private-name.jpg');form.append('page',new Blob([page],{type:'image/jpeg'}),'processed.jpg');return new Request('https://api.example',{method:'POST',headers:{Origin:origin,Authorization:'Bearer synthetic'},body:form});}
test('POD is off by default and does not authenticate or write',async()=>{
 const r=rig({enabled:false,authenticate:()=>{throw Error('unexpected');}});assert.equal((await r.handle(request())).status,503);assert.equal(r.writes.length,0);
});
test('POD stores originals and generated PDF only after authorization, then rechecks session',async()=>{
 const r=rig(),response=await r.handle(request());assert.equal(response.status,200);const result=await response.json();assert.equal(result.filename,'POD-SO-68032-SHIPMENT-1-OF-2.pdf');assert.equal(result.email,'disabled');assert.equal(r.contexts,2);assert.equal(r.writes.length,3);assert.equal(r.receipts.length,2);assert.match(r.receipts[1].pdfHash,/^[a-f0-9]{64}$/);assert.ok(r.writes.every(([,path])=>path.startsWith('ca/'+binding+'/'+submission+'/')));
});
test('wrong origin, actor and binding cannot upload',async()=>{
 const crossOrigin=rig();assert.equal((await crossOrigin.handle(request({origin:'https://evil.example'}))).status,403);assert.equal(crossOrigin.writes.length,0);
 const wrong=rig({context:async()=>({...sample,actor_id:'other'})});assert.equal((await wrong.handle(request())).status,403);assert.equal(wrong.writes.length,0);
 const invalid=rig();assert.equal((await invalid.handle(request({id:'../other'}))).status,400);assert.equal(invalid.contexts,0);
});
test('denied warehouse or stale allocation fails closed before storage',async()=>{
 const r=rig({context:async()=>{throw Object.assign(Error('DENIED'),{status:403});}});assert.equal((await r.handle(request())).status,403);assert.equal(r.writes.length,0);
});
test('receipt retry does not upload or duplicate finalization',async()=>{
 const r=rig({receive:async()=>({id:submission,state:'received'})});assert.equal((await r.handle(request())).status,200);assert.equal(r.writes.length,0);
});
test('missing review or malformed image does not create a receipt',async()=>{
 for(const input of [{reviewed:'false'},{page:new Uint8Array([1,2,3])}]){const r=rig();assert.ok((await r.handle(request(input))).status>=400);assert.equal(r.receipts.length,0);assert.equal(r.writes.length,0);}
});
test('storage failure cannot claim POD received',async()=>{
 const r=rig({putImmutable:async()=>{throw Error('unavailable');}});assert.equal((await r.handle(request())).status,500);assert.equal(r.receipts.length,1);assert.equal(r.receipts[0].pdfHash,undefined);
});
test('JPEG parser bounds dimensions and PDF has byte-correct object offsets',()=>{
 assert.deepEqual(jpegSize(jpeg),{width:32,height:48,channels:3});const pdf=makePdf([jpeg,jpeg]),str=Buffer.from(pdf).toString('latin1');assert.match(str,/\/Count 2/);assert.match(str,/\/Filter \/DCTDecode/);const xref=Number(str.match(/startxref\n(\d+)/)[1]);assert.equal(str.slice(xref,xref+4),'xref');assert.throws(()=>makePdf([]));assert.throws(()=>jpegSize(new Uint8Array([255,216,255,217])));
});

test('assigned-trip POD rechecks version, uses test paths and never queues email',async()=>{
 const dynamicRequest=async(version=1)=>{const original=request(),form=await original.formData();form.set('workflow','assigned-trip');form.set('tripVersion',String(version));return new Request(original.url,{method:'POST',headers:{Origin:'https://test.example',Authorization:'Bearer synthetic'},body:form});};
 const testBinding={...sample,is_test:true,sales_order:'SO-TEST-0001',shipment_total:1,version:1};
 const r=rig({emailEnabled:true,driverContext:async()=>testBinding,driverReceive:async(b,input)=>({id:input.id,state:input.pdfHash?'received':'uploading',object_prefix:`pod-test/ca/${b.id}/${input.id}`})});
 const result=await r.handle(await dynamicRequest());assert.equal(result.status,200);assert.equal((await result.json()).email,'disabled');assert.equal(r.receipts.length,0);assert.equal(r.writes.length,3);assert.ok(r.writes.every(([,p])=>p.startsWith('pod-test/')));
 const stale=rig({driverContext:async()=>({...testBinding,version:2}),driverReceive:async()=>{throw Error('must not write');}});assert.equal((await stale.handle(await dynamicRequest())).status,409);assert.equal(stale.writes.length,0);
 const off=rig();assert.equal((await off.handle(await dynamicRequest())).status,503);
});
