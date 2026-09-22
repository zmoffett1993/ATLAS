// Real IndexedDB/browser checks with synthetic pages and intercepted POD requests.
// Set ATLAS_PLAYWRIGHT_PATH to an existing Playwright package and ATLAS_BROWSER_PATH
// to an installed Chromium/Edge executable. No packages or browsers are downloaded.
const assert=require('node:assert/strict');
const {readFileSync}=require('node:fs');
const {resolve}=require('node:path');
const {pathToFileURL}=require('node:url');
const http=require('node:http');
const {chromium}=require(process.env.ATLAS_PLAYWRIGHT_PATH||'playwright');
const repo=resolve(__dirname,'../..'),jpeg=require('../../tests/fixtures/pod-jpeg.cjs');
const USER='11111111-1111-4111-8111-111111111111',OTHER='22222222-2222-4222-8222-222222222222',BIND='33333333-3333-4333-8333-333333333333';
const scripts=['atlas-routing-pod-core.js','atlas-routing-pod-queue.js','atlas-routing-pod.js'];
const html=`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><main id="pod"></main>${scripts.map(s=>`<script src="/${s}"></script>`).join('')}<script>
 window.testUser=${JSON.stringify(USER)};
 window.AtlasAuth={getSession:()=>({user:{id:window.testUser}}),getValidSession:async()=>({user:{id:window.testUser},access_token:'synthetic-session'})};
 atlasRoutingPOD.configure({enabled:true});atlasRoutingPOD.mount(document.querySelector('#pod'),()=> '2026-09-21');atlasRoutingPOD.load();
 </script>`;
(async()=>{
 const server=http.createServer((req,res)=>{
  const name=req.url.slice(1);if(req.url==='/'){res.setHeader('Content-Type','text/html');return res.end(html);}
  if(!scripts.includes(name)){res.statusCode=404;return res.end();}
  res.setHeader('Content-Type','text/javascript');res.end(readFileSync(resolve(repo,name)));
 });
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const origin=`http://127.0.0.1:${server.address().port}`;
 const browser=await chromium.launch({executablePath:process.env.ATLAS_BROWSER_PATH,headless:true});
 const context=await browser.newContext({viewport:{width:390,height:844},hasTouch:true,isMobile:true,serviceWorkers:'block'});
 let receipt=null,writes=0,posts=0,lists=0,dropReceipt=true,deny=false;
 const binding={id:BIND,actor_id:USER,warehouse_id:'ca-fixture',sales_order:'SO-US-68032',customer:'Synthetic customer',address:'Synthetic address',trip_index:0,shipment_number:1,shipment_total:1,current:true};
 const {createHandler}=await import(pathToFileURL(resolve(repo,'supabase/functions/delivery-pod/handler.mjs')));
 const handler=createHandler({enabled:true,origins:[origin],authenticate:async()=>({id:USER}),context:async()=>binding,
  list:async()=>({warehouse:'CA',shipments:[{...binding,submission:receipt}]}),
  receive:async(b,input)=>{receipt={id:input.id,state:input.pdfHash?'received':receipt?.state||'uploading'};return {...receipt,object_prefix:'synthetic/'+input.id};},
  putImmutable:async()=>{writes++;}
 });
 await context.route('**/*',async route=>{
  const req=route.request();if(new URL(req.url()).origin===origin)return route.continue();
  if(!req.url().endsWith('/delivery-pod'))return route.abort();
  if(req.method()==='OPTIONS')return route.fulfill({status:204,headers:{'Access-Control-Allow-Origin':origin,'Access-Control-Allow-Headers':'authorization,content-type','Access-Control-Allow-Methods':'POST'}});
  const multipart=(req.headers()['content-type']||'').includes('multipart');if(multipart)posts++;else lists++;
  if(deny)return route.fulfill({status:403,contentType:'application/json',body:'{"error":"ACCESS_DENIED"}',headers:{'Access-Control-Allow-Origin':origin}});
  const response=await handler(new Request(req.url(),{method:req.method(),headers:req.headers(),body:req.postDataBuffer()}));
  if(multipart&&dropReceipt){dropReceipt=false;return route.abort();}
  return route.fulfill({status:response.status,headers:Object.fromEntries(response.headers),body:Buffer.from(await response.arrayBuffer())});
 });
 const newPage=async({offline=false}={})=>{
  const page=await context.newPage();page.on('dialog',d=>d.accept());
  if(offline)await page.addInitScript(()=>Object.defineProperty(navigator,'onLine',{configurable:true,get:()=>false}));
  await page.goto(origin);return page;
 };
 const records=page=>page.evaluate(()=>atlasRoutingPodQueue.list({userId:testUser,warehouse:'CA'}));
 try{
  let page=await newPage();await page.locator('[data-pod-scan]').click();
  await page.locator('[data-pod-file]').setInputFiles({name:'synthetic.jpg',mimeType:'image/jpeg',buffer:jpeg});
  await page.waitForFunction(()=>document.querySelector('#pod').textContent.includes('Saved draft'));
  let saved=(await records(page))[0];assert.equal(saved.pages.length,1);assert.equal(saved.status,'draft');
  const original=await page.evaluate(async()=>{const [d]=await atlasRoutingPodQueue.list({userId:testUser,warehouse:'CA'});return [...new Uint8Array(await d.pages[0].original.arrayBuffer())];});
  assert.deepEqual(original,[...jpeg],'original preserved byte-for-byte');
  await page.locator('[data-pod-action="refresh"]').click();await page.locator('[data-pod-resume]').click();
  await context.setOffline(true);await page.locator('[data-pod-action="submit"]').click();
  await page.waitForFunction(()=>document.querySelector('#pod').textContent.includes('Waiting to send'));
  const id=(await records(page))[0].submissionId;assert.ok(id);assert.equal(posts,0,'offline submission makes no upload');
  await page.close();await context.setOffline(false);
  page=await newPage({offline:true});await page.locator('[data-pod-resume]').click();await page.locator('.atlas-pod-pages img').waitFor();
  assert.equal(await page.locator('.atlas-pod-pages img').count(),1,'photo restored after closing the page');
  assert.equal((await records(page))[0].submissionId,id,'retry identifier survives page closure');
  assert.equal(await page.locator('[data-pod-rotate]').isDisabled(),true,'submitted content stays immutable');
  await page.evaluate(()=>{Object.defineProperty(navigator,'onLine',{configurable:true,get:()=>true});window.dispatchEvent(new Event('online'));});
  await page.waitForFunction(()=>document.querySelector('#pod').textContent.includes('POD received'),null,{timeout:20000});
  assert.equal(posts,1,'uncertain receipt is reconciled without another photo upload');assert.equal(writes,3);
  assert.equal((await records(page))[0].status,'received');
  await page.evaluate(id=>{window.testUser=id;window.dispatchEvent(new CustomEvent('atlas-auth-changed',{detail:{session:{user:{id}}}}));},OTHER);
  assert.equal(await page.locator('.atlas-pod-pages img').count(),0,'account switch removes photo previews');
  assert.equal((await records(page)).length,0,'another account cannot inherit drafts');
  assert.equal(await page.evaluate(id=>atlasRoutingPodQueue.list({userId:id,warehouse:'TX'}).then(d=>d.length),USER),0,'warehouse queues are isolated');
  console.log('PASS: durable photos, Done/resume, offline queue, closed-page recovery, receipt reconciliation, account/warehouse isolation.');
  // A local storage failure must not claim a saved photo or clear the unload guard.
  const failing=await browser.newContext({serviceWorkers:'block'});
  await failing.route('**/*',async route=>new URL(route.request().url()).origin===origin?route.continue():route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({warehouse:'CA',shipments:[binding]}),headers:{'Access-Control-Allow-Origin':origin,'Access-Control-Allow-Headers':'authorization,content-type'}}));
  const failedPage=await failing.newPage();await failedPage.goto(origin);await failedPage.locator('[data-pod-scan]').click();
  await failedPage.evaluate(()=>{atlasRoutingPodQueue={...atlasRoutingPodQueue,write:async()=>{throw Error('Device storage is full.');}};});
  await failedPage.locator('[data-pod-file]').setInputFiles({name:'synthetic.jpg',mimeType:'image/jpeg',buffer:jpeg});
  await failedPage.waitForFunction(()=>document.querySelector('#pod').textContent.includes('Not saved'));
  assert.equal(await failedPage.evaluate(()=>atlasRoutingPOD.hasPending()),true);
  assert.equal(await failedPage.locator('.atlas-pod-pages img').count(),1,'unsaved photo remains recoverable in the open tab');
  console.log('PASS: storage failure stays visibly unsaved with the leave-page guard.');await failing.close();
  console.log(JSON.stringify({uploadRequests:posts,immutableWrites:writes,listRequests:lists,externalNetwork:'intercepted',realIndexedDB:true}));
 }finally{await context.close();await browser.close();await new Promise(r=>server.close(r));}
})().catch(e=>{console.error(e);process.exitCode=1;});
