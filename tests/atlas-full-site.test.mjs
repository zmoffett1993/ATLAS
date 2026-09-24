import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { request } from 'node:http';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { createPermanentHost } from '../cloud-run/atlas-routing-app/server.mjs';
import { fullSitePage, fullSiteWorker, fullSiteFiles } from '../cloud-run/atlas-routing-app/full-site.mjs';
const root = new URL('../', import.meta.url);
const ORIGIN = 'https://atlas-routing-app-test-uc.a.run.app';
async function fixture(t) {
  const values = { K_SERVICE:'atlas-routing-app', ATLAS_ROUTING_APP_ORIGIN:ORIGIN, ATLAS_ROUTING_APP_TESTER_ID:'11111111-1111-4111-8111-111111111111', ATLAS_ROUTING_SUPABASE_PUBLISHABLE_KEY:'sb_publishable_synthetic' };
  let calls=0;
  const server=createPermanentHost({ env:k=>values[k], fetchImpl:async()=>{calls++;throw Error('No external calls permitted');} });
  server.listen(0,'127.0.0.1');await once(server,'listening');
  t.after(()=>new Promise(resolve=>{server.close(resolve);server.closeAllConnections();}));
  const get=(path,headers={})=>new Promise((resolve,reject)=>{
    const req=request({host:'127.0.0.1',port:server.address().port,path,headers:{Host:new URL(ORIGIN).host,...headers}},res=>{
      const chunks=[];res.on('data',b=>chunks.push(b));res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,body:Buffer.concat(chunks).toString()}));
    });req.on('error',reject);req.end();
  });return {get,calls:()=>calls};
}
test('full testing host serves original ATLAS navigation and Receiver with nonce-protected scripts',async t=>{
  const f=await fixture(t);
  for(const url of ['/','/index.html','/coc-receiver/','/coc-receiver/index.html']){
    const r=await f.get(url);assert.equal(r.status,200);assert.equal(r.headers['cache-control'],'no-store');
    const nonce=r.headers['content-security-policy'].match(/'nonce-([^']+)'/)[1];
    assert.ok([...r.body.matchAll(/<script\b([^>]*)>/g)].every(m=>m[1].includes('nonce="'+nonce+'"')),'every actual script tag has the response nonce');
    assert.ok(r.body.includes('· Testing</title>'));
    assert.ok(r.body.includes('"/tools/routing-preview/routing-notification-sw.mjs", { type: "module", scope: "/", updateViaCache: "none" },'));
    if(url.startsWith('/coc-receiver/'))assert.ok(!r.body.includes('full-site-client.mjs'));
    else { assert.ok(r.body.includes('data-action="routing"'));assert.ok(r.body.includes('full-site-client.mjs')); }
  }
  assert.equal(f.calls(),0);
});
test('public installation page and shared worker load without authentication or external requests',async t=>{
  const f=await fixture(t),page=await f.get('/install/');
  assert.equal(page.status,200);assert.ok(page.body.includes('Install ATLAS'));
  assert.ok(!page.body.includes('full-site-client.mjs'));
  assert.equal((await f.get('/atlas-routing-worker.mjs?v=281')).status,200);
  assert.equal(f.calls(),0);
});

test('all shell and boot assets are allowlisted, present, correctly packaged, and no secrets or workbooks are served',async t=>{
  const f=await fixture(t),source=fullSiteWorker(readFileSync(new URL('service-worker.js',root),'utf8'));
  const shell=vm.runInNewContext(source.slice(0,source.indexOf('self.addEventListener'))+';APP_SHELL');
  assert.ok(shell.every(url=>url.startsWith('/')), 'module worker under /tools must precache root-relative assets');
  for(const url of [...shell,'/tools/routing-preview/full-site-client.mjs'])assert.equal((await f.get(new URL(url,ORIGIN).pathname+new URL(url,ORIGIN).search)).status,200,url);
  const docker=readFileSync(new URL('cloud-run/atlas-routing-app/Dockerfile',root),'utf8');
  for(const [, [file]] of fullSiteFiles){assert.ok(readFileSync(new URL(file,root)).length);assert.ok(docker.includes(file),file+' missing from container');}
  for(const path of ['/AGENTS.md','/.git/config','/.env','/supabase/config.toml','/NEW%20COC%202.xlsx','/NEW COC 2.xlsx'.replaceAll(' ','%20'),'/cloud-run/atlas-routing-app/server.mjs','/cloud-run/atlas-routing-app/static-files.json','/index%20(1).html','/tools/routing-preview/private-trip-locks.sql'])assert.equal((await f.get(path)).status,404,path);
  for(const [, [file, type]] of fullSiteFiles) if(type === 'application/json') {
    const response=await f.get('/'+file);
    assert.equal(response.body,readFileSync(new URL(file,root),'utf8'),'static JSON must retain its original bytes');
  }
  const manifest=JSON.parse((await f.get('/manifest.webmanifest')).body);assert.equal(manifest.name,'ATLAS Testing');
  assert.equal(f.calls(),0);
});
test('combined worker preserves push handling and session-isolated offline caches while excluding runtime configuration',async t=>{
  const f=await fixture(t),worker=await f.get('/tools/routing-preview/routing-notification-sw.mjs');
  assert.equal(worker.headers['service-worker-allowed'],'/');assert.ok(worker.body.startsWith('import "/service-worker.js";'));
  assert.ok(worker.body.includes('notificationclick'));assert.ok(worker.body.includes('pushsubscriptionchange'));
  const base=(await f.get('/service-worker.js')).body;assert.ok(base.includes('atlas-pwa-v389-testing-host-v1'));
  assert.ok(base.includes('url.pathname === "/runtime-config.json"'));assert.ok(base.includes('warehouseRead(request, unavailable)'));
});
test('host remains origin-restricted and runtime configuration exposes no tester identity or private setting',async t=>{
  const f=await fixture(t);
  assert.equal((await f.get('/',{Origin:'https://unapproved.invalid'})).status,403);
  assert.equal((await f.get('/runtime-config.json',{'Sec-Fetch-Site':'cross-site'})).status,403);
  assert.equal((await f.get('/',{'Sec-Fetch-Site':'cross-site','Sec-Fetch-Mode':'navigate','Sec-Fetch-Dest':'document'})).status,200);
  const config=JSON.parse((await f.get('/runtime-config.json')).body);assert.equal(config.notificationsEnabled,false);assert.ok(!JSON.stringify(config).includes('11111111'));assert.equal(f.calls(),0);
});
