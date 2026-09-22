const BASE = "https://dwrrbpiprcmajfyronlf.supabase.co";
export function createReminderStore({ secretKey, fetchImpl = fetch }) {
  if (!/^sb_secret_[A-Za-z0-9_-]+$/.test(secretKey || "")) throw new Error("Private notification database configuration required.");
  async function rpc(action, payload) {
    const response = await fetchImpl(`${BASE}/rest/v1/rpc/atlas_routing_notification_server`, { method:"POST", redirect:"error", signal:AbortSignal.timeout(10000),
      headers:{apikey:secretKey,"Content-Type":"application/json"},body:JSON.stringify({p_action:action,p_payload:payload}) });
    const reader=response.body?.getReader();if(!reader)throw new Error("Notification database unavailable.");
    const chunks=[];let size=0;
    try{while(true){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>32768){await reader.cancel();throw new Error("Invalid notification database response.");}chunks.push(value);}}
    finally{reader.releaseLock();}
    if(!response.ok)throw new Error("Notification database request failed.");
    const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
    try{return JSON.parse(new TextDecoder().decode(bytes));}catch{throw new Error("Invalid notification database response.");}
  }
  return Object.freeze({
    authorizedDevices:async(recipientId,warehouse)=>(await rpc("devices",{recipientId,warehouse}))||[],
    claim:payload=>rpc("claim",payload),
    stillAuthorized:(deviceId,binding,recipientId,warehouse)=>rpc("authorized",{deviceId,binding,recipientId,warehouse}),
    finish:(deviceId,day,state)=>rpc("finish",{deviceId,day,state}),
    retire:(deviceId,binding)=>rpc("retire",{deviceId,binding}),
  });
}
