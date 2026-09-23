import {pathToFileURL} from 'node:url';
import {runScannerPlanningOnce} from '../../tools/routing-preview/scanner-planning-worker.mjs';
import {buildPlannerTrip,summarizePlannerTrip} from '../atlas-routing-preview/trip-model.mjs';
const PROJECT='project-6a63ee65-40cb-4d53-b32';
const BASE='https://dwrrbpiprcmajfyronlf.supabase.co';
const META='http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token';
async function json(response,limit=1500000){
 if(!response.ok)throw Error('PLANNING_FAILED');
 const reader=response.body.getReader();const chunks=[];let length=0;
 try{while(true){const {value,done}=await reader.read();if(done)break;length+=value.length;if(length>limit){await reader.cancel();throw Error('PLANNING_FAILED');}chunks.push(value);}}finally{reader.releaseLock();}
 return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
export async function runScannerJob({env=n=>process.env[n],fetchImpl=fetch,sleep=ms=>new Promise(r=>setTimeout(r,ms))}={}){
 if(env('ATLAS_SCANNER_ENABLED')!=='true')return {status:'disabled'};
 if(env('CLOUD_RUN_JOB')!=='atlas-routing-scanner')throw Error('Private scanner job required');
 const key=env('ATLAS_SCANNER_DB_SECRET');if(!/^sb_secret_[A-Za-z0-9_-]+$/.test(key||''))throw Error('Private database configuration required');
 const request=(url,options={})=>fetchImpl(url,{...options,redirect:'error',signal:AbortSignal.timeout(30000)});
 let activeLease;
 const rpc=async(name,args)=>{
  if(!['atlas_routing_scanner_claim','atlas_routing_scanner_finish','atlas_routing_scanner_budget'].includes(name))throw Error('Unsupported scanner action');
  const result=await request(`${BASE}/rest/v1/rpc/${name}`,{method:'POST',headers:{apikey:key,'Content-Type':'application/json'},body:JSON.stringify(args)}).then(json);
  if(name.endsWith('_claim'))activeLease=result?.lease;
  return result;
 };
 const budget=async kind=>{if(!await rpc('atlas_routing_scanner_budget',{p_lease:activeLease,p_kind:kind}))throw Error('Daily planning limit reached');};
 let token,lastRoute=0,lookups=0;const locations=new Map();
 const auth=async()=>{if(!token){const response=await request(META,{headers:{'Metadata-Flavor':'Google'}});if(response.headers.get('Metadata-Flavor')!=='Google')throw Error('Workload identity unavailable');token=(await json(response,32768)).access_token;}return {Authorization:`Bearer ${token}`,'X-Goog-User-Project':PROJECT};};
 const geocode=async address=>{
  if(locations.has(address))return locations.get(address);
  if(++lookups>100)throw Error('Address review limit');
  await budget('geocode');
  const data=await json(await request(`https://geocode.googleapis.com/v4/geocode/address/${encodeURIComponent(address)}`,{headers:await auth()}));
  if(data.results?.length!==1||data.results[0].partialMatch)throw Error('Address needs review');
  const result=data.results[0],point=result.location;
  if(!['ROOFTOP','RANGE_INTERPOLATED'].includes(result.granularity)||!result.addressComponents?.some(p=>p.types?.includes('street_number'))||!result.addressComponents?.some(p=>p.types?.includes('country')&&p.shortText==='US')||!Number.isFinite(point?.latitude)||!Number.isFinite(point?.longitude)||Math.abs(point.latitude)>90||Math.abs(point.longitude)>180)throw Error('Address needs review');
  const value={location:point,formattedAddress:result.formattedAddress};locations.set(address,value);return value;
 };
 const route=async input=>{
  const delay=Math.max(0,31000-(Date.now()-lastRoute));if(delay)await sleep(delay);lastRoute=Date.now();
  const requestBody=buildPlannerTrip(input,{latitude:33.9229391,longitude:-117.931362});
  await budget('route');
  const result=await json(await request(`https://routeoptimization.googleapis.com/v1/projects/${PROJECT}:optimizeTours`,{method:'POST',headers:{...await auth(),'Content-Type':'application/json'},body:JSON.stringify(requestBody)}));
  return summarizePlannerTrip(result,input.stops.length);
 };
 return runScannerPlanningOnce(rpc,{geocode,route});
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 try{console.log(JSON.stringify(await runScannerJob()));}catch{console.error('Scanner planning failed; uploaded orders remain saved.');process.exitCode=1;}
}
