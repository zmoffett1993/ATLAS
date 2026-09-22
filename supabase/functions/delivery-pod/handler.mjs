import { makePdf, jpegSize } from './pdf.mjs';
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const fail=(message,status=400)=>{throw Object.assign(Error(message),{status});};
export async function digest(bytes){return [...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(n=>n.toString(16).padStart(2,'0')).join('');}
function filename(b){const match=/^(?:SO(?:[- ]US)?[- ])?([0-9]{1,20})$/.exec(String(b.sales_order).trim().toUpperCase().replace(/ +/g,' '));
 if(!match||!Number.isInteger(b.shipment_number)||!Number.isInteger(b.shipment_total)||b.shipment_number<1||b.shipment_total<b.shipment_number)fail('SHIPMENT_NAMING_REVIEW_REQUIRED');
 return `POD-SO-${match[1]}${b.shipment_total>1?`-SHIPMENT-${b.shipment_number}-OF-${b.shipment_total}`:''}.pdf`;}
export function createHandler({enabled=false,origins=[],authenticate,context,list,receive,putImmutable,download}){
 return async request=>{
  const origin=request.headers.get('origin'),headers={'Cache-Control':'no-store','Vary':'Origin','X-Content-Type-Options':'nosniff'};
  if(origin&&!origins.includes(origin))return new Response(null,{status:403,headers});
  if(origin)Object.assign(headers,{'Access-Control-Allow-Origin':origin,'Access-Control-Allow-Headers':'authorization,apikey,content-type','Access-Control-Allow-Methods':'POST,OPTIONS'});
  const json=(body,status=200)=>new Response(JSON.stringify(body),{status,headers:{...headers,'Content-Type':'application/json'}});
  if(request.method==='OPTIONS')return new Response(null,{status:204,headers});
  if(!enabled)return json({error:'POD_NOT_ACTIVATED'},503);
  if(request.method!=='POST')return json({error:'METHOD_NOT_ALLOWED'},405);
  try{
   const token=request.headers.get('authorization');if(!/^Bearer \S+$/.test(token||''))fail('AUTH_REQUIRED',401);
   const actor=await authenticate(token);if(!actor?.id)fail('AUTH_REQUIRED',401);
   const type=request.headers.get('content-type')||'';
   if(type.includes('application/json')){
    const reader=request.body?.getReader();if(!reader)fail('EMPTY_REQUEST');const parts=[];let length=0;
    while(true){const {done,value}=await reader.read();if(done)break;length+=value.length;if(length>3000){await reader.cancel();fail('REQUEST_TOO_LARGE',413);}parts.push(value);}
    const bytes=new Uint8Array(length);let at=0;parts.forEach(value=>{bytes.set(value,at);at+=value.length;});const input=JSON.parse(new TextDecoder().decode(bytes));
    if(input.action==='list'){if(!/^20\d\d-\d\d-\d\d$/.test(input.date||''))fail('INVALID_DAY');return json(await list(token,input.date));}
    if(input.action==='download'){
     if(!uuid.test(input.bindingId||''))fail('INVALID_BINDING');const b=await context(token,input.bindingId);
     if(b.actor_id!==actor.id||b.id!==input.bindingId)fail('ACCESS_DENIED',403);const file=await download(b);
     return new Response(file.bytes,{headers:{...headers,'Content-Type':'application/pdf','Content-Disposition':`attachment; filename="${filename(b)}"`}});
    }fail('UNKNOWN_ACTION');
   }
   if(!type.includes('multipart/form-data'))fail('INVALID_CONTENT_TYPE');
   // Bound the body before parsing; never trust Content-Length alone.
   const reader=request.body.getReader(),chunks=[];let total=0;
   while(true){const {done,value}=await reader.read();if(done)break;total+=value.length;if(total>25_000_000){await reader.cancel();fail('UPLOAD_TOO_LARGE',413);}chunks.push(value);}
   const body=new Uint8Array(total);let offset=0;chunks.forEach(b=>{body.set(b,offset);offset+=b.length;});
   const form=await new Response(body,{headers:{'Content-Type':type}}).formData();
   const bindingId=form.get('bindingId'),submissionId=form.get('submissionId');if(!uuid.test(bindingId||'')||!uuid.test(submissionId||''))fail('INVALID_SUBMISSION');
   const b=await context(token,bindingId);if(b.actor_id!==actor.id||b.id!==bindingId)fail('ACCESS_DENIED',403);if(b.current===false)fail('SHIPMENT_CHANGED_REVIEW_REQUIRED',409);
   const originals=form.getAll('original'),pages=form.getAll('page');if(!pages.length||pages.length>10||pages.length!==originals.length)fail('INVALID_PAGE_COUNT');
   if(form.get('reviewed')!=='true')fail('REVIEW_REQUIRED');
   const jpeg=[],files=[],hashes=[];
   for(let i=0;i<pages.length;i++){
    if(!(pages[i] instanceof Blob)||!(originals[i] instanceof Blob)||originals[i].size>15_000_000)fail('INVALID_PAGE');
    const page=new Uint8Array(await pages[i].arrayBuffer()),original=new Uint8Array(await originals[i].arrayBuffer());jpegSize(page);
    const png=original[0]===137&&original[1]===80&&original[2]===78&&original[3]===71&&original[4]===13&&original[5]===10&&original[6]===26&&original[7]===10;
    const jpg=original[0]===255&&original[1]===216&&original.at(-2)===255&&original.at(-1)===217;
    if(!png&&!jpg)fail('ORIGINAL_MUST_BE_JPEG_OR_PNG');
    jpeg.push(page);files.push({original,page,type:png?'image/png':'image/jpeg',ext:png?'png':'jpg'});hashes.push([await digest(original),await digest(page)]);
   }
   const name=filename(b),manifest=await digest(new TextEncoder().encode(JSON.stringify({bindingId,hashes,name})));
   const receipt=await receive(b,{id:submissionId,manifest,filename:name,pages:pages.length});
   if(receipt.state==='received')return json({id:receipt.id,state:'received',filename:name,email:'disabled'});
   for(let i=0;i<files.length;i++){
    await putImmutable('atlas-pod-originals',`${receipt.object_prefix}/original-${i+1}.${files[i].ext}`,files[i].original,files[i].type);
    await putImmutable('atlas-pod-originals',`${receipt.object_prefix}/processed-${i+1}.jpg`,files[i].page,'image/jpeg');
   }
   const pdf=makePdf(jpeg);await putImmutable('atlas-pod-documents',`${receipt.object_prefix}/document.pdf`,pdf,'application/pdf');
   // Revalidate the user's current session/allocation after storage writes.
   const current=await context(token,bindingId);if(current.actor_id!==actor.id)fail('ACCESS_DENIED',403);
   const final=await receive(current,{id:submissionId,manifest,filename:name,pages:pages.length,pdfHash:await digest(pdf)});
   return json({id:final.id,state:'received',filename:name,email:'disabled'});
  }catch(error){return json({error:error.status?error.message:'POD_REQUEST_FAILED'},error.status||500);}
 };
}
