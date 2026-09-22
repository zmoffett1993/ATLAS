import test from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { createPreviewBridge } from '../tools/routing-preview/bridge.mjs';
import { requestTrip, requestPhoto } from '../tools/routing-preview/preview.mjs';

const LIVE='https://zmoffett1993.github.io', API='https://atlas-routing-app-tbcotacnuq-uc.a.run.app';
async function fixture(t, liveEnabled=true) {
  let authorized=0, upstream=0;
  const server=createPreviewBridge({origin:API,publishableKey:'sb_publishable_synthetic',permanent:true,fullAtlas:true,liveEnabled,
    authorizeCaller:async()=>{authorized++;return false;},getGoogleToken:async()=>{upstream++;throw Error('No Google calls');}});
  server.listen(0,'127.0.0.1');await once(server,'listening');
  t.after(()=>new Promise(resolve=>{server.close(resolve);server.closeAllConnections();}));
  const invoke=(path,method='GET',headers={})=>new Promise((resolve,reject)=>{
    const req=request({host:'127.0.0.1',port:server.address().port,path,method,
      headers:{Host:new URL(API).host,Origin:LIVE,'Sec-Fetch-Site':'cross-site',...headers}},res=>{
      const chunks=[];res.on('data',b=>chunks.push(b));res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,body:Buffer.concat(chunks).toString()}));
    });req.on('error',reject);req.end();
  });
  return {invoke,authorized:()=>authorized,upstream:()=>upstream};
}
test('live routing is opt-in and grants CORS only to the exact ATLAS origin and API paths',async t=>{
  const disabled=await fixture(t,false);assert.equal((await disabled.invoke('/runtime-config.json')).status,403);
  const f=await fixture(t);
  const config=await f.invoke('/runtime-config.json');assert.equal(config.status,200);
  assert.equal(config.headers['access-control-allow-origin'],LIVE);assert.equal(config.headers['cache-control'],'no-store');
  assert.equal(config.headers['access-control-allow-credentials'],undefined);
  for(const origin of ['https://evil.example',LIVE+'.evil.example','null'])assert.equal((await f.invoke('/runtime-config.json','GET',{Origin:origin})).status,403);
  for(const path of ['/','/index.html','/api/send','/runtime-config.json?redirect=evil'])assert.equal((await f.invoke(path)).status,403);
  assert.equal(f.upstream(),0);
});
test('live preflight is bounded; actual requests still require authenticated approved users',async t=>{
  const f=await fixture(t),preflight={'Access-Control-Request-Method':'POST','Access-Control-Request-Headers':'content-type,x-atlas-authorization'};
  const result=await f.invoke('/api/plan-trip','OPTIONS',preflight);assert.equal(result.status,204);
  assert.equal(f.authorized(),0);assert.equal(f.upstream(),0);
  assert.equal((await f.invoke('/api/plan-trip','OPTIONS',{...preflight,'Access-Control-Request-Headers':'authorization'})).status,403);
  assert.equal((await f.invoke('/api/plan-trip','POST')).status,401);
  const denied=await f.invoke('/api/plan-trip','POST',{'X-Atlas-Authorization':'Bearer synthetic-denied-atlas-token'});
  assert.equal(denied.status,403);assert.equal(denied.headers['access-control-allow-origin'],LIVE);
  assert.equal(f.authorized(),1);assert.equal(f.upstream(),0);
});
test('live route and photo calls use only the fixed gateway with current ATLAS bearer and no cookies',async()=>{
  const session={user:{id:'synthetic-user'},access_token:'synthetic-atlas-token'},calls=[];
  const fetchImpl=async(url,init)=>{
    calls.push([url,init]);return Response.json(url.endsWith('read-order-photo')?{warehouse:'CA',scope:'order-photo',pages:[{words:[]}]}:{warehouse:'CA',scope:'daily-planner-trip',wholeDayValidated:false,visits:[],skippedStopIndices:[]});
  };
  await requestTrip({session,payload:{action:'planTrip'},apiBase:API,fetchImpl});
  await requestPhoto({session,image:'synthetic',apiBase:API,fetchImpl});
  assert.deepEqual(calls.map(c=>c[0]),[API+'/api/plan-trip',API+'/api/read-order-photo']);
  for(const [,init] of calls){assert.equal(init.credentials,'omit');assert.equal(init.redirect,'error');assert.equal(init.cache,'no-store');assert.equal(init.headers['X-Atlas-Authorization'],'Bearer '+session.access_token);}
  await assert.rejects(requestPhoto({session,apiBase:'https://evil.example',fetchImpl}));
  await assert.rejects(requestTrip({session,payload:{},apiBase:'https://evil.example',fetchImpl}));
  assert.equal(calls.length,2);
});
test('live entry and receiver share one module worker without modifying receiver icon or main app identity',()=>{
  const read=file=>readFileSync(new URL('../'+file,import.meta.url),'utf8');
  for(const file of ['index.html','coc-receiver/index.html'])assert.match(read(file),/atlas-routing-worker\.mjs\?v=281/);
  assert.equal((read('index.html').match(/src="\.\/tools\/routing-preview\/full-site-client\.mjs\?v=2"/g)||[]).length,1);
  assert.match(read('atlas-routing-worker.mjs'),/import "\.\/service-worker\.js"/);
  assert.match(read('atlas-routing-worker.mjs'),/routing-notification-sw\.mjs/);
  assert.equal(JSON.parse(read('manifest.webmanifest')).short_name,'ATLAS');
});
