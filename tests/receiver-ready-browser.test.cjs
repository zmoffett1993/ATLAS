// Real browser; actual Receiver scripts with synthetic services. No production requests.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),http=require('node:http'),os=require('node:os');
const {chromium}=require(process.env.ATLAS_PLAYWRIGHT_PATH||path.join(os.homedir(),'.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'));
const root=path.resolve(__dirname,'..');
for(const home of ['CA','TX'])test(`${home} Receiver survives quiet refresh failures, offline recovery and explicit rejection`,async t=>{
 const server=http.createServer((req,res)=>{res.setHeader('Content-Type','text/html');res.end('<!doctype html><div id="receiver-root"><h1>CONNECTING…</h1></div>');});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>server.close(r)));
 const browser=await chromium.launch({executablePath:process.env.ATLAS_BROWSER_PATH||'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',headless:true});t.after(()=>browser.close());
 const page=await browser.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.route('**/*',route=>new URL(route.request().url()).hostname==='127.0.0.1'?route.continue():route.abort());
 await page.goto('http://127.0.0.1:'+server.address().port);
 await page.evaluate(home=>{
  const stationKey=home==='CA'?'OFFICE_COC_01':'OFFICE_COC_TX';
  const user={id:'synthetic-'+home,app_metadata:{role:'office_receiver',home_warehouse_code:home}};
  const saved={warehouseCode:home,stationKey,stationId:'synthetic-station-'+home,devicePublicId:'synthetic-device-'+home,deviceSecret:'synthetic-secret'};
  window.fixture={user,saved,settings:new Map([['office-coc-receiver-credentials:'+stationKey,{value:saved}]]),calls:[],deletes:0,failInbox:false,failHeartbeat:false,verifyError:null};
  localStorage.setItem('atlas-selected-warehouse-v1',home==='CA'?'TX':'CA');
  window.ATLAS_COC_RECEIVER_MODE=true;window.atlasSupabaseConfig={url:'https://fixture.invalid',key:'synthetic'};
  const session=()=>fixture.user?{user:fixture.user,access_token:'synthetic'}:null;
  window.AtlasAuth={getSession:session,getValidSession:async()=>session()};
  window.AtlasCocStorage={getSetting:async key=>fixture.settings.get(key),setSetting:async(key,value)=>fixture.settings.set(key,{value}),deleteSetting:async key=>{fixture.deletes++;fixture.settings.delete(key);}};
  window.fetch=async(url,options)=>{
   const body=JSON.parse(options.body);fixture.calls.push(body);
   let status=200,value={};
   if(body.action==='warehouse-context')value={selectedWarehouse:{code:body.warehouseCode}};
   if(body.action==='verify-receiver'){if(fixture.verifyError){status=fixture.verifyError.status;value={error:fixture.verifyError.error};}else value={stationId:saved.stationId};}
   if(body.action==='heartbeat'){if(fixture.failHeartbeat){status=503;value={error:'TEMPORARY_FAILURE'};}else value={online:true};}
   if(body.action==='receiver-inbox'){if(fixture.failInbox){status=503;value={error:'TEMPORARY_FAILURE'};}else value={deliveries:[],total:0};}
   return new Response(JSON.stringify(value),{status,headers:{'Content-Type':'application/json'}});
  };
 },home);
 await page.addScriptTag({content:fs.readFileSync(path.join(root,'atlas-coc-delivery.js'),'utf8')});
 await page.evaluate(()=>{window.AtlasCocDelivery={...window.AtlasCocDelivery,subscribeToDeliveries:options=>{fixture.socket=options;return{close(){}};}};});
 const source=fs.readFileSync(path.join(root,'coc-receiver/receiver.js'),'utf8');
 await page.addScriptTag({content:source.replace('  void refreshReceiverAuth();','  window.receiverTest={loadInbox,refreshReceiverAuth,syncReceiverConnection};\n  void refreshReceiverAuth();')});
 const status=page.locator('.receiver-status strong');await status.filter({hasText:'CONNECTED · READY'}).waitFor();
 assert.equal(await page.getByText('Set up this computer',{exact:true}).count(),0);
 assert.equal(await page.evaluate(()=>AtlasCocDelivery.requestedWarehouseCode()),home);
 const credentialsBefore=await page.evaluate(()=>JSON.stringify([...fixture.settings]));
 await page.evaluate(()=>{fixture.dom=document.querySelector('.receiver-incoming');fixture.failInbox=true;return receiverTest.loadInbox();});
 assert.match(await status.innerText(),/CONNECTED · SYNC DELAYED/);
 assert.equal(await page.evaluate(()=>fixture.dom===document.querySelector('.receiver-incoming')),true);
 assert.equal(await page.getByText('TEMPORARY_FAILURE',{exact:true}).count(),0);
 await page.evaluate(()=>{fixture.failHeartbeat=true;receiverTest.syncReceiverConnection();});
 await status.filter({hasText:'CONNECTED · SYNC DELAYED'}).waitFor();
 assert.equal(await page.getByText(/RECONNECTING|Reconnecting/).count(),0);
 await page.context().setOffline(true);await status.filter({hasText:'OFFLINE'}).waitFor();
 await page.evaluate(()=>{fixture.failInbox=false;fixture.failHeartbeat=false;});
 await page.context().setOffline(false);await page.evaluate(()=>receiverTest.refreshReceiverAuth());await page.evaluate(()=>receiverTest.loadInbox());
 await status.filter({hasText:'CONNECTED · READY'}).waitFor();
 await page.evaluate(()=>{fixture.verifyError={status:401,error:'ATLAS_AUTH_REQUIRED'};return receiverTest.refreshReceiverAuth();});
 assert.equal(await page.getByText('Pair this computer',{exact:true}).count(),0);
 assert.equal(await page.evaluate(()=>JSON.stringify([...fixture.settings])),credentialsBefore);
 await page.evaluate(()=>{fixture.verifyError=null;return receiverTest.refreshReceiverAuth();});await page.evaluate(()=>receiverTest.loadInbox());
 await status.filter({hasText:'CONNECTED · READY'}).waitFor();
 await page.evaluate(()=>{fixture.verifyError={status:403,error:'RECEIVER_NOT_AUTHORIZED'};return receiverTest.refreshReceiverAuth();});
 await page.getByText('Pair this computer',{exact:true}).waitFor();
 assert.equal(await page.evaluate(()=>JSON.stringify([...fixture.settings])),credentialsBefore);
 assert.equal(await page.evaluate(()=>fixture.deletes),0);
 assert.equal(await page.evaluate(()=>fixture.calls.some(c=>['create-pairing','approve-pairing'].includes(c.action))),false);
 assert.equal(await page.evaluate(home=>localStorage.getItem('atlas-coc-receiver-warehouse-v1:synthetic-'+home),home),home);
 assert.deepEqual(errors,[]);
});
