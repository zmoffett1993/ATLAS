import { pathToFileURL } from "node:url";
import { createPreviewBridge } from "../../tools/routing-preview/bridge.mjs";
const BACKEND="https://atlas-routing-preview-340839522237.us-central1.run.app";
const ACCOUNT="atlas-routing-app@project-6a63ee65-40cb-4d53-b32.iam.gserviceaccount.com";
const METADATA="http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default";
async function bounded(response,limit){
  const reader=response.body?.getReader();if(!reader)throw Error("Connection unavailable.");let length=0;const parts=[];
  try{while(true){const {value,done}=await reader.read();if(done)break;length+=value.length;if(length>limit){await reader.cancel();throw Error("Response too large.");}parts.push(value);}}finally{reader.releaseLock();}
  return Buffer.concat(parts).toString("utf8");
}
export function createPermanentHost({env=name=>process.env[name],fetchImpl=fetch}){
  if(env("K_SERVICE")!=="atlas-routing-app")throw Error("Permanent routing workload required.");
  const recipient=env("ATLAS_ROUTING_APP_TESTER_ID"),key=env("ATLAS_ROUTING_SUPABASE_PUBLISHABLE_KEY");
  if(!/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(recipient||""))throw Error("One approved preview account required.");
  const call=(url,options={})=>fetchImpl(url,{...options,redirect:"error",signal:AbortSignal.timeout(10000)});
  return createPreviewBridge({permanent:true,origin:env("ATLAS_ROUTING_APP_ORIGIN"),publishableKey:key,browserKey:env("ATLAS_PREVIEW_BROWSER_ANON_KEY")||key,
    mapsBrowserKey:env("ATLAS_PREVIEW_MAPS_BROWSER_KEY")||"",photoEnabled:env("ATLAS_ROUTING_PHOTO_ENABLED")==="true",storageEnabled:true,
    notificationsEnabled:env("ATLAS_NOTIFICATIONS_ENABLED")==="true",fetchImpl,
    authorizeCaller:async authorization=>{
      const response=await call("https://dwrrbpiprcmajfyronlf.supabase.co/auth/v1/user",{headers:{apikey:key,Authorization:authorization}});
      const body=await bounded(response,65536);if(!response.ok)return false;
      const user=JSON.parse(body);return user.id===recipient && user.is_anonymous!==true;
      // Existing routing backend independently checks current roles, tester allowlist and CA access.
    },
    getGoogleToken:async()=>{
      const headers={"Metadata-Flavor":"Google"};const identity=await call(`${METADATA}/email`,{headers});
      if(!identity.ok||identity.headers.get("Metadata-Flavor")!=="Google"||(await bounded(identity,512)).trim()!==ACCOUNT)throw Error("Workload identity unavailable.");
      const response=await call(`${METADATA}/identity?audience=${encodeURIComponent(BACKEND)}&format=full`,{headers});
      if(!response.ok||response.headers.get("Metadata-Flavor")!=="Google")throw Error("Workload identity unavailable.");
      const token=(await bounded(response,16384)).trim();if(!/^[A-Za-z0-9_.-]+$/.test(token))throw Error("Workload identity unavailable.");return token;
    },
  });
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  const port=Number(process.env.PORT||8080);if(!Number.isInteger(port)||port<1||port>65535)throw Error("Invalid port.");
  const server=createPermanentHost({});server.listen(port,"0.0.0.0");
  process.on("SIGTERM",()=>{server.close();setTimeout(()=>process.exit(0),9000).unref();});
}
