// Bounded browser smoke check. All external requests are intercepted; no real accounts.
const assert=require('node:assert/strict'),{resolve}=require('node:path'),{pathToFileURL}=require('node:url');
const {chromium}=require(process.env.ATLAS_PLAYWRIGHT_PATH||'playwright');
const repo=resolve(__dirname,'../..'),USER='11111111-1111-4111-8111-111111111111',host='atlas-routing-app-test-uc.a.run.app';
const storage=require('../../atlas-routing-storage.js');
const live=process.env.ATLAS_QA_LIVE==='true';
const sampleDay=day=>storage.document({schemaVersion:3,date:day,orders:[['Anaheim Packaging','Anaheim',8],['Irvine Plastics','Irvine',5],['Santa Ana Supply','Santa Ana',4],['Ontario Containers','Ontario',6],['Riverside Molding','Riverside',3],['Fullerton Distribution','Fullerton',1]].map(([customer,city,pallets],i)=>({id:`00000000-0000-4000-8000-${String(i+1).padStart(12,'0')}`,orderNumber:`SO-${68032+i}`,customer,address:`${100+i} Example Road, ${city}, CA`,city,timeWindow:i===0?'8:00 AM–11:00 AM':'',notes:'',checkOnDelivery:i===0,serviceMinutes:25,lines:[{sku:'CGSC1-8OZ-0401',caseQty:pallets*20,itemQty:null}]})),catalog:[{model:'CGSC1-8OZ',caseQty:'200',caseDimensions:'24X20X16',caseWeightLb:'25LB',boxesPerPallet:'20',palletDimensions:'49X41X81',sourceRow:24}],settings:{truckPalletTarget:11,dailyTripTarget:3,reloadMinutes:40,lunch:'12:00',preserveOrder:true},assignments:{},vanConfirmed:{},lockedTrips:[]});
const binding={id:'33333333-3333-4333-8333-333333333333',driver_id:USER,driver_name:'Bubba',sales_order:'SO-68032',customer:'Anaheim Packaging',address:'100 Example Road, Anaheim, CA',trip_index:0,shipment_number:1,shipment_total:1,current:true,source_assignment:'Bubba:truck',source_shipment:{palletSpaces:4,boxAllocation:[{sku:'CGSC1-8OZ-0401',boxes:80}]},delivery:{timeWindow:'8:00 AM–2:00 PM',checkOnDelivery:true,notes:'Receiving door 3'}};
(async()=>{
 const {createPermanentHost}=await import(pathToFileURL(resolve(repo,'cloud-run/atlas-routing-app/server.mjs')));
 const config={K_SERVICE:'atlas-routing-app',ATLAS_ROUTING_APP_ORIGIN:'https://'+host,ATLAS_ROUTING_APP_TESTER_ID:USER,ATLAS_ROUTING_SUPABASE_PUBLISHABLE_KEY:'sb_publishable_synthetic',ATLAS_POD_ENABLED:'true',ATLAS_ROUTING_PHOTO_ENABLED:'true'};
 const server=createPermanentHost({env:k=>config[k],fetchImpl:async()=>{throw Error('No upstream permitted');}});
 server.prependListener('request',req=>{req.headers.host=host;if(req.headers.origin?.startsWith('http://127.0.0.1:'))req.headers.origin='https://'+host;});await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const browser=await chromium.launch({executablePath:process.env.ATLAS_BROWSER_PATH,headless:true});
 try{for(const [role,capability,width] of live?[['picker','driver',390],['admin','office',1440]]:[['picker','driver',360],['picker','driver',390],['picker','driver',393],['picker','driver',430],['picker','driver',1440],['supervisor','viewer',1440],['admin','office',1440],['admin','office',390]]){
  const context=await browser.newContext({viewport:{width,height:width===360?800:width===390?844:width===393?852:width===430?932:900},serviceWorkers:'block',hasTouch:width<750,isMobile:width<750});
  await context.addInitScript(({role,USER})=>localStorage.setItem('sb-dwrrbpiprcmajfyronlf-auth-token',JSON.stringify({access_token:'synthetic-token',expires_at:Math.floor(Date.now()/1000)+3600,user:{id:USER,app_metadata:{role,home_warehouse_code:'CA'},user_metadata:{display_name:role==='picker'?'Bubba':'Office test'}}})),{role,USER});
  let loads=0,assignments=0,receipt=null,oneStop=false,split=false,submissions=0;
  await context.route('**/*',async route=>{
   const req=route.request(),url=new URL(req.url());if(url.hostname==='127.0.0.1')return route.continue();
   if(live&&url.origin==='https://zmoffett1993.github.io'){
    assert.ok(url.pathname.startsWith('/ATLAS/'));const file=url.pathname.slice('/ATLAS/'.length)||'index.html';
    const {readFileSync}=require('node:fs');const type={html:'text/html',js:'text/javascript',mjs:'text/javascript',css:'text/css',json:'application/json',svg:'image/svg+xml',png:'image/png',webmanifest:'application/manifest+json'}[file.split('.').pop()]||'application/octet-stream';
    return route.fulfill({status:200,contentType:type,body:readFileSync(resolve(repo,file))});
   }
   if(live&&url.origin==='https://atlas-routing-app-tbcotacnuq-uc.a.run.app'){
    assert.equal(url.pathname,'/runtime-config.json');return route.fulfill({status:200,contentType:'application/json',headers:{'Access-Control-Allow-Origin':'https://zmoffett1993.github.io'},body:JSON.stringify({url:'https://dwrrbpiprcmajfyronlf.supabase.co',key:'sb_publishable_synthetic',storageEnabled:true,podEnabled:true,photoEnabled:true,notificationsEnabled:false})});
   }
   if(!url.hostname.endsWith('.supabase.co'))return route.abort();
   let body=[];const p=url.pathname;
   if(p.endsWith('/atlas_pod_driver_access'))body={capability,canEdit:role==='admin'};
   else if(p.endsWith('/atlas_pod_driver_roster'))body={revision:1,drivers:[{id:USER,name:'Bubba'},{id:'22222222-2222-4222-8222-222222222222',name:'Backup worker'}],trips:[{index:0,stops:2,pallets:6,driver_name:null}]};
   else if(p.endsWith('/atlas_pod_assign_trip')){assignments++;assert.equal(req.postDataJSON().p_revision,1);body={assigned:2};}
   else if(p.endsWith('/delivery-pod')){
    if((req.headers()['content-type']||'').includes('multipart')){
     submissions++;await new Promise(resolve=>setTimeout(resolve,500));const submissionId=req.postDataBuffer().toString().match(/name="submissionId"\r\n\r\n([^\r]+)/)[1];body=receipt={id:submissionId,state:'received'};
    }else body={capability,warehouse:'CA',email_enabled:false,shipments:[{...binding,shipment_total:split?2:1,delivery:{...binding.delivery,notes:'Synthetic UI test — do not load or deliver.'},submission:receipt},...oneStop?[]:[{...binding,id:'44444444-4444-4444-8444-444444444444',customer:'Fullerton Distribution',sales_order:'SO-68033',address:'200 Example Road, Fullerton, CA',source_shipment:{palletSpaces:2,boxAllocation:[{sku:'CGSC1-8OZ-0401',boxes:40}]},delivery:{timeWindow:'',notes:'',checkOnDelivery:false}}]]};
   }
   else if(p.endsWith('/atlas_routing_preview_load')){loads++;const day=req.postDataJSON().p_day;body={warehouse:'CA',date:day,revision:1,document:sampleDay(day),canEdit:role==='admin'};}
   else if(p.endsWith('/profiles'))body=[{user_id:USER,role,display_name:role==='picker'?'Bubba':'Office test',warehouse_id:'ca'}];
   else if(p.endsWith('/warehouses'))body=[{id:'ca',code:'CA',display_name:'California',active:true}];
   else if(p.endsWith('/auth/v1/user'))body={id:USER,app_metadata:{role,home_warehouse_code:'CA'}};
   return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(body),headers:{'Access-Control-Allow-Origin':'*'}});
  });
  const page=await context.newPage();page.on('pageerror',e=>console.error(e.message));await page.goto(live?'https://zmoffett1993.github.io/ATLAS/':`http://127.0.0.1:${server.address().port}`);
  const shot=async name=>{assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'no horizontal overflow');if(process.env.ATLAS_QA_OUTPUT){await page.screenshot({path:resolve(process.env.ATLAS_QA_OUTPUT,`driver-mobile-${name}-${width}.png`),fullPage:true});await page.screenshot({path:resolve(process.env.ATLAS_QA_OUTPUT,`driver-mobile-${name}-${width}-viewport.png`)});}};
  await page.waitForFunction(()=>document.documentElement.dataset.atlasRoutingConnection==='ready');
  if(width<1024)await page.locator('.premium-menu-button').click();
  assert.equal(await page.locator('.atlas-menu-nav [data-action="dashboard"]').isVisible(),width>=1024,'Dashboard remains desktop-only');
  assert.equal(await page.locator('.atlas-menu-nav [data-nav="Workflows"] .atlas-menu-label').innerText(),'COC');
  assert.match(await page.locator('.bottom-nav [data-nav="Workflows"]').textContent(),/COC/);
  await page.locator('.atlas-menu-nav [data-nav="Workflows"]').click();
  await page.locator('#atlas-coc-workflows-root').waitFor();
  if(width<1024)await page.locator('.bottom-nav button').filter({hasText:'Home'}).click();
  if(width<1024)await page.locator('.premium-menu-button').click();
  await page.locator('[data-action="routing"]').click();
  if(role==='picker'){
   await page.locator('.atlas-driver-overview').first().waitFor();
   await page.locator('.premium-toast').waitFor({state:'hidden'});
   await shot('driver-today');
   assert.equal(await page.getByRole('button',{name:'Open ATLAS menu',exact:true}).count(),1);
   await page.getByRole('button',{name:'Open ATLAS menu',exact:true}).click();
   await page.locator('[data-action="routing"]').click();
   await page.locator('.atlas-driver-overview').first().waitFor();
   await page.locator('.atlas-driver-overview > .atlas-route-primary').click();
   await page.locator('.atlas-driver-stop').first().waitFor();assert.equal(loads,0,'driver must not fetch an office saved day');
   assert.equal(await page.locator('.atlas-route-header h1').innerText(),'My Deliveries');assert.equal(await page.locator('[data-route-history]').first().isVisible(),false);
   assert.equal(await page.locator('[data-pod-scan]').count(),1);assert.equal(await page.locator('.atlas-driver-check').innerText(),'CHECK ON DELIVERY');
   await page.locator('.atlas-driver-stepper [data-pod-stop="1"]').click();assert.match(await page.locator('.atlas-driver-stop h4').innerText(),/Fullerton/);
   await page.locator('[data-pod-tab="documents"]').click();assert.match(await page.locator('.atlas-driver-empty').innerText(),/No documents yet/);
   await page.locator('[data-pod-tab="stops"]').click();assert.match(await page.locator('.atlas-driver-stop h4').innerText(),/Fullerton/);
   await page.locator('[data-pod-action="refresh"]').click();await page.locator('.atlas-driver-stop h4').waitFor();assert.match(await page.locator('.atlas-driver-stop h4').innerText(),/Fullerton/);
   await page.locator('.atlas-driver-stepper [data-pod-stop="0"]').click();
   await shot('driver-stop');
   const maps=await page.locator('.atlas-driver-stop-actions a').getAttribute('href');assert.equal(new URL(maps).searchParams.get('query'),binding.address);
   await page.locator('.atlas-driver-boxes summary').click();await page.waitForFunction(()=>document.querySelector('.atlas-driver-boxes summary')?.getAttribute('aria-expanded')==='true');assert.match(await page.locator('.atlas-driver-boxes').innerText(),/80 boxes/);await shot('load-details');
   oneStop=true;await page.locator('[aria-label="Refresh route"]').click();await page.locator('.atlas-driver-stop h4').waitFor();await shot('one-stop');
   split=true;await page.locator('[aria-label="Refresh route"]').click();await page.locator('.atlas-driver-split').waitFor();assert.match(await page.locator('.atlas-driver-split').innerText(),/SHIPMENT 1 OF 2/);await shot('split-shipment');
   oneStop=false;split=false;await page.locator('[aria-label="Refresh route"]').click();await page.locator('.atlas-driver-stop h4').waitFor();
   await page.evaluate(()=>window.scrollTo(0,document.body.scrollHeight));
   await page.locator('[data-pod-scan]').click();await page.locator('.atlas-pod-camera-empty').waitFor();
   assert.equal(await page.locator('[data-pod-action="submit"]').isDisabled(),true);await page.waitForFunction(()=>window.scrollY===0);await shot('pod-capture');
   const photo=await page.evaluate(()=>{
    const canvas=document.createElement('canvas');canvas.width=1000;canvas.height=1300;const c=canvas.getContext('2d');c.fillStyle='white';c.fillRect(0,0,1000,1300);c.fillStyle='#183d61';c.font='bold 38px sans-serif';c.fillText('SYNTHETIC POD · UI REVIEW',65,100);c.font='24px sans-serif';['Not a real shipment or signature','Anaheim Packaging','Sales order SO-68032','4 pallets · 80 boxes','Received by: TEST ONLY'].forEach((s,i)=>c.fillText(s,65,220+i*90));c.strokeStyle='#b5c6d7';c.lineWidth=2;for(let y=700;y<=1100;y+=80){c.beginPath();c.moveTo(65,y);c.lineTo(935,y);c.stroke();}return canvas.toDataURL('image/png').split(',')[1];
   });
   await page.locator('[data-pod-file]').setInputFiles({name:'synthetic-pod.png',mimeType:'image/png',buffer:Buffer.from(photo,'base64')});
   await page.locator('[data-pod-state="review"]').waitFor();await shot('pod-review');
   assert.equal(await page.locator('[data-pod-action="submit"]').isDisabled(),false);
   await page.evaluate(()=>Object.defineProperty(navigator,'onLine',{configurable:true,get:()=>false}));
   await page.locator('[data-pod-action="submit"]').click();await page.locator('[data-pod-state="queued"]').waitFor();assert.equal(submissions,0);await shot('offline-queued');
   await page.evaluate(()=>{Object.defineProperty(navigator,'onLine',{configurable:true,get:()=>true});window.dispatchEvent(new Event('online'));});
   await page.locator('[data-pod-action="submit"]:disabled').waitFor();await shot('submitting');
   await page.locator('[data-pod-state="received"]').waitFor();assert.equal(submissions,1);
   assert.match(await page.locator('.atlas-pod-receipt').innerText(),/Email disabled/);await shot('pod-received');
   await page.locator('[data-pod-next]').click();await page.locator('.atlas-driver-stop h4').waitFor();assert.match(await page.locator('.atlas-driver-stop h4').innerText(),/Fullerton/);
   await page.locator('[data-pod-tab="documents"]').click();await shot('documents');
  }else{
   await page.locator('[data-route-row]').first().waitFor();
   if(role==='supervisor'){assert.equal(await page.locator('[data-route-manual-order]').isDisabled(),true);assert.equal(await page.locator('[data-route-truck-target]').isDisabled(),true);}
   await page.locator('[data-route-row]').first().waitFor();await page.locator('.premium-toast').waitFor({state:'hidden'});await shot('office-orders');
   if(role==='admin'){
    assert.equal(await page.locator('[data-dispatch-next]').isVisible(),true);
    await page.locator('[data-dispatch-tab="queue"]').click();await shot('office-queue');
    await page.locator('[data-dispatch-tab="trips"]').click();await shot('office-trips');
    await page.locator('[data-dispatch-tab="orders"]').click();
    await page.locator('[data-route-intake]').click();await page.locator('[data-route-capture]').waitFor();await shot('order-photo');await page.locator('[data-route-capture-done]').click();
    await page.locator('.atlas-dispatch-tabs [data-route-history]').click();await page.locator('[data-route-history-dialog]').waitFor();await shot('saved-search');await page.locator('[data-route-close-history]').click();
   }
   await page.locator('[data-dispatch-tab="pods"]').click();await page.locator('.atlas-driver-stop').first().waitFor();
   if(role==='supervisor'){assert.equal(await page.locator('[data-pod-scan]').count(),0);assert.equal(await page.locator('[data-pod-action="assign"]').count(),0);}
   else{await page.locator('[data-pod-action="assign"]').click();await page.locator('[data-pod-assign-trip] select').selectOption('22222222-2222-4222-8222-222222222222');await page.locator('[data-pod-assign-trip] button').click();await page.locator('[data-pod-assign-trip]').waitFor({state:'detached'});assert.equal(assignments,1);}
  }
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'no horizontal overflow');
  await page.locator('.premium-toast').waitFor({state:'hidden'});
  if(process.env.ATLAS_QA_OUTPUT)await page.screenshot({path:resolve(process.env.ATLAS_QA_OUTPUT,`pod-driver-${role}.png`),fullPage:true});
  console.log(`PASS: ${role} screen at ${width}px; office loads=${loads}, assignment calls=${assignments}.`);await context.close();
 }}finally{await browser.close();await new Promise(r=>server.close(r));}
})().catch(e=>{console.error(e);process.exitCode=1;});
