// Server-only Gmail adapter. No SDK, provider payload logging, or automatic sends/retries.
const encoder = new TextEncoder();
const fault = code => Object.assign(Error(code), {emailCode:code});
export const MAX_PDF_BYTES = 18_000_000;
function base64(bytes) {
 let binary='';
 for(let i=0;i<bytes.length;i+=8192)binary+=String.fromCharCode(...bytes.subarray(i,i+8192));
 return btoa(binary);
}
export function makeMessage({bytes,filename,sender,recipient,replyTo,attemptId}) {
 if(!(bytes instanceof Uint8Array)||bytes.length>MAX_PDF_BYTES)throw fault('PDF_TOO_LARGE');
 if(!new TextDecoder().decode(bytes.subarray(0,8)).startsWith('%PDF-')||!new TextDecoder().decode(bytes.subarray(-40)).includes('%%EOF'))throw fault('INVALID_PDF');
 if(!/^POD-SO-\d{1,20}(-SHIPMENT-\d+-OF-\d+)?\.pdf$/.test(filename)||filename.length>150)throw fault('INVALID_PDF_NAME');
 for(const address of [sender,recipient,replyTo])if(/[\r\n]/.test(address||'')||!/^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/.test(address||''))throw fault('EMAIL_CONFIGURATION_REQUIRED');
 if(!/^[0-9a-f-]{36}$/i.test(attemptId))throw fault('EMAIL_CONFIGURATION_REQUIRED');
 const boundary=`atlas_pod_${attemptId}`,body=base64(bytes).match(/.{1,76}/g).join('\r\n');
 const mime=[`From: ATLAS POD Delivery <${sender}>`,`To: ${recipient}`,`Reply-To: ${replyTo}`,`Subject: ${filename.slice(0,-4)}`,
  `Date: ${new Date().toUTCString()}`,`Message-ID: <${attemptId}@atlas-pod.invalid>`,'MIME-Version: 1.0',`Content-Type: multipart/mixed; boundary="${boundary}"`,'',
  `--${boundary}`,'Content-Type: text/plain; charset=UTF-8','Content-Transfer-Encoding: 7bit','','POD attached.','',
  `--${boundary}`,`Content-Type: application/pdf; name="${filename}"`,'Content-Transfer-Encoding: base64',`Content-Disposition: attachment; filename="${filename}"`,'',body,`--${boundary}--`,''].join('\r\n');
 return base64(encoder.encode(mime)).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
}
export function createGmail({clientId,clientSecret,refreshToken,sender,recipient,replyTo,fetcher=fetch}) {
 return async ({bytes,filename,attemptId,beforeSend}) => {
  if(!clientId||!clientSecret||!refreshToken)throw fault('EMAIL_CONFIGURATION_REQUIRED');
  const raw=makeMessage({bytes,filename,attemptId,sender,recipient,replyTo});
  let token;
  try {
   const response=await fetcher('https://oauth2.googleapis.com/token',{method:'POST',redirect:'error',signal:AbortSignal.timeout(10000),
    headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({client_id:clientId,client_secret:clientSecret,refresh_token:refreshToken,grant_type:'refresh_token'})});
   if(!response.ok)throw fault('GMAIL_AUTH_REQUIRED');
   const result=await response.json();if(typeof result.access_token!=='string'||!result.access_token)throw fault('GMAIL_AUTH_REQUIRED');token=result.access_token;
  }catch(e){throw fault(e.emailCode||'GMAIL_AUTH_UNAVAILABLE');}
  // Current account/session/warehouse authorization is checked again immediately before sending.
  await beforeSend();
  try {
   const response=await fetcher('https://gmail.googleapis.com/gmail/v1/users/me/messages/send',{method:'POST',redirect:'error',signal:AbortSignal.timeout(15000),
    headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify({raw})});
   if(!response.ok)throw fault(response.status>=500?'SEND_OUTCOME_UNKNOWN':response.status===401?'GMAIL_AUTH_REQUIRED':response.status===429?'GMAIL_RATE_LIMITED':'GMAIL_SEND_REJECTED');
   const result=await response.json();if(typeof result.id!=='string'||!/^[a-zA-Z0-9_-]{1,200}$/.test(result.id))throw fault('SEND_OUTCOME_UNKNOWN');
   return result.id;
  }catch(e){throw fault(e.emailCode||'SEND_OUTCOME_UNKNOWN');}
 };
}

// SQL claims serialize sends. A lost provider response stays held for explicit office review.
export function createEmailService({enabled=false,context,claim,finish,download,send,filename}) {
 return async (token,actor,input) => {
  const b=await context(token,input.podId);
  if(b.actor_id!==actor.id||b.document?.id!==input.podId)throw Object.assign(Error('ACCESS_DENIED'),{status:403});
  if(input.mode!=='send'&&b.capability!=='office')throw Object.assign(Error('OFFICE_REQUIRED'),{status:403});
  if(!enabled)return {email_status:'disabled'};
  const attempt=await claim(b,input);
  if(!attempt.claimed)return attempt;
  let messageId,errorCode;
  try {
   let file;
   try{file=await download(b);}catch{throw fault('PDF_UNAVAILABLE');}
   const name=filename(b);if(name!==b.document.filename)throw fault('INVALID_PDF_NAME');
   messageId=await send({bytes:file.bytes,filename:name,attemptId:attempt.attempt_id,beforeSend:async()=>{
    const current=await context(token,input.podId);
    if(current.actor_id!==actor.id||current.document?.id!==input.podId)throw fault('EMAIL_ACCESS_CHANGED');
   }});
  }catch(e){errorCode=e.emailCode||'EMAIL_PREPARATION_FAILED';}
  try{return await finish(b,{attemptId:attempt.attempt_id,messageId,errorCode});}
  catch{return {email_status:'sending',email_error_code:'SEND_OUTCOME_UNKNOWN'};}
 };
}
