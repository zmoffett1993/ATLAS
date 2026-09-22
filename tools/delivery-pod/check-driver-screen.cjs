// Bounded browser smoke check. All external requests are intercepted; no real accounts.
const assert=require('node:assert/strict'),{resolve}=require('node:path'),{pathToFileURL}=require('node:url');
const {chromium}=require(process.env.ATLAS_PLAYWRIGHT_PATH||'playwright');
const repo=resolve(__dirname,'../..'),USER='11111111-1111-4111-8111-111111111111',host='atlas-routing-app-test-uc.a.run.app';
const binding={id:'33333333-3333-4333-8333-333333333333',driver_id:USER,driver_name:'Bubba',sales_order:'SO-68032',customer:'Anaheim Packaging',address:'100 Example Road, Anaheim, CA',trip_index:0,shipment_number:1,shipment_total:1,current:true,source_assignment:'Bubba:truck',source_shipment:{palletSpaces:4,boxAllocation:[{sku:'CGSC1-8OZ-0401',boxes:80}]},delivery:{timeWindow:'8:00 AM–2:00 PM',checkOnDelivery:true,notes:'Receiving door 3'}};
(async()=>{
 const {createPermanentHost}=await import(pathToFileURL(resolve(repo,'cloud-run/atlas-routing-app/server.mjs')));
 const config={K_SERVICE:'atlas-routing-app',ATLAS_ROUTING_APP_ORIGIN:'https://'+host,ATLAS_ROUTING_APP_TESTER_ID:USER,ATLAS_ROUTING_SUPABASE_PUBLISHABLE_KEY:'sb_publishable_synthetic',ATLAS_POD_ENABLED:'true'};
 const server=createPermanentHost({env:k=>config[k],fetchImpl:async()=>{throw Error('No upstream permitted');}});
 server.prependListener('request',req=>{req.headers.host=host;if(req.headers.origin?.startsWith('http://127.0.0.1:'))req.headers.origin='https://'+host;});await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const browser=await chromium.launch({executablePath:process.env.ATLAS_BROWSER_PATH,headless:true});
 try{for(const [role,capability,width] of [['picker','driver',390],['supervisor','viewer',1440],['admin','office',1440]]){
  const context=await browser.newContext({viewport:{width,height:900},serviceWorkers:'block',hasTouch:width===390,isMobile:width===390});
  await context.addInitScript(({role,USER})=>localStorage.setItem('sb-dwrrbpiprcmajfyronlf-auth-token',JSON.stringify({access_token:'synthetic-token',expires_at:Math.floor(Date.now()/1000)+3600,user:{id:USER,app_metadata:{role,home_warehouse_code:'CA'},user_metadata:{display_name:role==='picker'?'Bubba':'Office test'}}})),{role,USER});
  let loads=0,assignments=0;
  await context.route('**/*',async route=>{
   const req=route.request(),url=new URL(req.url());if(url.hostname==='127.0.0.1')return route.continue();if(!url.hostname.endsWith('.supabase.co'))return route.abort();
   let body=[];const p=url.pathname;
   if(p.endsWith('/atlas_pod_driver_access'))body={capability,canEdit:role==='admin'};
   else if(p.endsWith('/atlas_pod_driver_roster'))body={revision:1,drivers:[{id:USER,name:'Bubba'},{id:'22222222-2222-4222-8222-222222222222',name:'Backup worker'}],trips:[{index:0,stops:2,pallets:6,driver_name:null}]};
   else if(p.endsWith('/atlas_pod_assign_trip')){assignments++;assert.equal(req.postDataJSON().p_revision,1);body={assigned:2};}
   else if(p.endsWith('/delivery-pod'))body={capability,warehouse:'CA',email_enabled:false,shipments:[binding,{...binding,id:'44444444-4444-4444-8444-444444444444',customer:'Fullerton Distribution',sales_order:'SO-68033',address:'200 Example Road, Fullerton, CA',source_shipment:{palletSpaces:2,boxAllocation:[{sku:'CGSC1-8OZ-0401',boxes:40}]},delivery:{timeWindow:'',notes:'',checkOnDelivery:false}}]};
   else if(p.endsWith('/atlas_routing_preview_load')){loads++;body={warehouse:'CA',date:req.postDataJSON().p_day,revision:0,document:null,canEdit:role==='admin'};}
   else if(p.endsWith('/profiles'))body=[{user_id:USER,role,display_name:role==='picker'?'Bubba':'Office test',warehouse_id:'ca'}];
   else if(p.endsWith('/warehouses'))body=[{id:'ca',code:'CA',display_name:'California',active:true}];
   else if(p.endsWith('/auth/v1/user'))body={id:USER,app_metadata:{role,home_warehouse_code:'CA'}};
   return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(body),headers:{'Access-Control-Allow-Origin':'*'}});
  });
  const page=await context.newPage();page.on('pageerror',e=>console.error(e.message));await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.waitForFunction(()=>document.documentElement.dataset.atlasRoutingConnection==='ready');
  if(width<1024)await page.locator('.premium-menu-button').click();await page.locator('[data-action="routing"]').click();
  if(role==='picker'){
   await page.locator('.atlas-driver-overview').first().waitFor();
   await page.locator('.premium-toast').waitFor({state:'hidden'});
   if(process.env.ATLAS_QA_OUTPUT)await page.screenshot({path:resolve(process.env.ATLAS_QA_OUTPUT,'pod-driver-today.png'),fullPage:true});
   await page.locator('.atlas-driver-overview > .atlas-route-primary').click();
   await page.locator('.atlas-driver-stop').first().waitFor();assert.equal(loads,0,'driver must not fetch an office saved day');
   assert.equal(await page.locator('.atlas-route-header h1').innerText(),'My Deliveries');assert.equal(await page.locator('[data-route-history]').first().isVisible(),false);
   assert.equal(await page.locator('[data-pod-scan]').count(),1);assert.equal(await page.locator('.atlas-driver-check').innerText(),'CHECK ON DELIVERY');
   await page.locator('.atlas-driver-stepper [data-pod-stop="1"]').click();assert.match(await page.locator('.atlas-driver-stop h4').innerText(),/Fullerton/);
   await page.locator('[data-pod-tab="documents"]').click();assert.match(await page.locator('.atlas-driver-empty').innerText(),/No documents yet/);
   await page.locator('[data-pod-tab="stops"]').click();assert.match(await page.locator('.atlas-driver-stop h4').innerText(),/Fullerton/);
   await page.locator('[data-pod-action="refresh"]').click();await page.locator('.atlas-driver-stop h4').waitFor();assert.match(await page.locator('.atlas-driver-stop h4').innerText(),/Fullerton/);
   await page.locator('.atlas-driver-stepper [data-pod-stop="0"]').click();
  }else{
   await page.waitForFunction(()=>document.querySelector('[data-route-save-status]')?.textContent.includes('day')||document.querySelector('[data-route-save-status]')?.textContent.includes('Read-only'));
   if(role==='supervisor'){assert.equal(await page.locator('[data-route-manual-order]').isDisabled(),true);assert.equal(await page.locator('[data-route-truck-target]').isDisabled(),true);}
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
