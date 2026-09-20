const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const crypto=require('node:crypto').webcrypto;
const source=fs.readFileSync(require('node:path').join(__dirname,'../service-worker.js'),'utf8');
function fixture(){
 const events={},stores=new Map();let offline=false,status=200,quota=false;
 const caches={open:async name=>{if(!stores.has(name))stores.set(name,new Map());const rows=stores.get(name);
  return {put:async(req,res)=>{if(quota)throw new Error('quota');rows.set(req.url||req,{request:req,response:res.clone()});},
   match:async req=>rows.get(req.url||req)?.response.clone(),delete:async req=>rows.delete(req.url||req),addAll:async()=>{}};},
  keys:async()=>[...stores.keys()],delete:async name=>stores.delete(name),match:async()=>undefined};
 vm.runInNewContext(source,{Request,Response,URL,TextEncoder,Uint8Array,crypto,caches,
  self:{location:{origin:'https://fixture.invalid'},addEventListener:(name,fn)=>events[name]=fn,skipWaiting(){},clients:{claim(){}}},
  fetch:async req=>{if(offline)throw new TypeError('offline');return new Response(JSON.stringify({session:req.headers.get('Authorization'),range:req.headers.get('Range')}),{status});}});
 const read=async(token='CA',query='?select=id',headers={})=>{
  let response;events.fetch({request:new Request('https://fixture.supabase.co/rest/v1/locations'+query,{headers:{...(token?{Authorization:'Bearer '+token}:{}),apikey:'fixture-only',...headers}}),respondWith:value=>response=value});return response;
 };
 return {read,stores,setOffline:v=>offline=v,setStatus:v=>status=v,setQuota:v=>quota=v,activate:async()=>{let wait;events.activate({waitUntil:p=>wait=p});await wait;}};
}
test('same-session offline data remains available while another account fails closed',async()=>{
 const f=fixture();await f.read('CA');f.setOffline(true);assert.equal((await f.read('CA')).status,200);assert.equal((await f.read('TX')).status,503);assert.equal((await f.read('')).status,503);
});
test('both sessions retain only their own response for the same URL',async()=>{
 const f=fixture();await f.read('CA');await f.read('TX');f.setOffline(true);
 assert.equal((await (await f.read('CA')).json()).session,'Bearer CA');assert.equal((await (await f.read('TX')).json()).session,'Bearer TX');
});
test('query, range, schema and refreshed token cannot inherit a different cached response',async()=>{
 const f=fixture();await f.read('CA','?select=id',{Range:'0-9','Accept-Profile':'public'});f.setOffline(true);
 for(const request of [()=>f.read('CA','?select=id',{Range:'10-19','Accept-Profile':'public'}),()=>f.read('CA','?select=id',{Range:'0-9','Accept-Profile':'private'}),()=>f.read('new-CA'),()=>f.read('CA','?select=id&warehouse_id=eq.TX')])assert.equal((await request()).status,503);
});
test('raw credential headers are not persisted in cache keys',async()=>{
 const f=fixture();await f.read('CA');for(const rows of f.stores.values())for(const {request} of rows.values()){
  assert.equal(request.headers.has('Authorization'),false);assert.equal(request.headers.has('apikey'),false);assert.doesNotMatch(request.url,/Bearer|fixture-only/);
 }
});
for(const status of [401,403])test('authorization denial '+status+' invalidates that session cache',async()=>{
 const f=fixture();await f.read('CA');f.setStatus(status);assert.equal((await f.read('CA')).status,status);f.setOffline(true);assert.equal((await f.read('CA')).status,503);
});
test('cache quota failure does not hide successful live data',async()=>{
 const f=fixture();f.setQuota(true);assert.equal((await f.read()).status,200);
});
test('activation removes obsolete ATLAS cache versions and preserves unrelated caches',async()=>{
 const f=fixture();f.stores.set('atlas-pwa-v353-account-transaction-warehouse-data',new Map());f.stores.set('unrelated-cache',new Map());await f.read();await f.activate();
 assert.equal(f.stores.has('atlas-pwa-v353-account-transaction-warehouse-data'),false);assert.equal(f.stores.has('unrelated-cache'),true);assert.ok([...f.stores.keys()].some(k=>k.includes('v358')));
});
