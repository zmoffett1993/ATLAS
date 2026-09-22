// Isolated legacy-worker upgrade and /ATLAS/ offline check. No external requests.
const assert=require('node:assert/strict'),{createServer}=require('node:http'),{readFileSync}=require('node:fs'),{resolve}=require('node:path');
const {chromium}=require(process.env.ATLAS_PLAYWRIGHT_PATH||'playwright');
const root=resolve(__dirname,'../..');
const files=new Set([...JSON.parse(readFileSync(resolve(root,'cloud-run/atlas-routing-app/static-files.json'))),
 ...['full-site-client.mjs','preview.mjs','maps.mjs','notification-client.mjs','notification-binding.mjs','notification-worker.mjs','routing-notification-sw.mjs'].map(f=>'tools/routing-preview/'+f)]);
(async()=>{
 const server=createServer((req,res)=>{
  const path=new URL(req.url,'http://localhost').pathname;
  if(path==='/ATLAS/upgrade-fixture.html'){res.setHeader('Content-Type','text/html');return res.end('<script>navigator.serviceWorker.register("./legacy-worker.js")</script>');}
  if(path==='/ATLAS/legacy-worker.js'){res.setHeader('Content-Type','text/javascript');return res.end('self.addEventListener("install",e=>e.waitUntil(Promise.all([caches.open("atlas-pwa-v378-shell"),caches.open("unrelated-test-cache")]).then(()=>self.skipWaiting())));self.addEventListener("activate",e=>e.waitUntil(self.clients.claim()));');}
  const file=path.startsWith('/ATLAS/')?(path.slice(7)||'index.html'):'';
  if(!files.has(file)){res.writeHead(404);return res.end();}
  const type={html:'text/html',js:'text/javascript',mjs:'text/javascript',css:'text/css',json:'application/json',webmanifest:'application/manifest+json',svg:'image/svg+xml',png:'image/png'}[file.split('.').pop()]||'application/octet-stream';
  res.setHeader('Content-Type',type);res.end(readFileSync(resolve(root,file)));
 });
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const browser=await chromium.launch({executablePath:process.env.ATLAS_BROWSER_PATH,headless:true});
 try{
  const context=await browser.newContext();
  await context.addInitScript(()=>{if(location.pathname==='/ATLAS/')sessionStorage.setItem('test-main-loads',String(Number(sessionStorage.getItem('test-main-loads')||0)+1));});
  await context.route('**/*',route=>new URL(route.request().url()).hostname==='127.0.0.1'?route.continue():route.abort());
  const page=await context.newPage(),base=`http://127.0.0.1:${server.address().port}/ATLAS/`;
  await page.goto(base+'upgrade-fixture.html');await page.evaluate(()=>navigator.serviceWorker.ready);
  await page.goto(base);await page.waitForFunction(()=>Number(sessionStorage.getItem('test-main-loads'))>=2&&document.readyState==='complete'&&navigator.serviceWorker.controller?.scriptURL.includes('atlas-routing-worker.mjs'));
  const state=await page.evaluate(async()=>({scope:(await navigator.serviceWorker.ready).scope,keys:await caches.keys(),receiver:Boolean(await caches.match('./coc-receiver/index.html')),boot:Boolean(await caches.match('./tools/routing-preview/full-site-client.mjs?v=2'))}));
  assert.equal(state.scope,base);assert.ok(state.keys.includes('atlas-pwa-v379-routing-live-connection-shell'));
  assert.ok(!state.keys.includes('atlas-pwa-v378-shell'));assert.ok(state.keys.includes('unrelated-test-cache'));assert.ok(state.receiver&&state.boot);
  await context.setOffline(true);await page.reload();assert.ok((await page.title()).includes('ATLAS'));
  await page.goto(base+'coc-receiver/index.html');assert.match(await page.title(),/Receiver/i);
  console.log('PASS: legacy worker upgraded at /ATLAS/; main and Receiver open offline; unrelated cache retained.');
 }finally{await browser.close();await new Promise(r=>server.close(r));}
})().catch(error=>{console.error(error);process.exitCode=1;});
