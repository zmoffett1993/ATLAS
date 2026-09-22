const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const root=path.resolve(__dirname,'..');
const source=fs.readFileSync(path.join(root,'atlas-dashboard.js'),'utf8');
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
function fixture(){
  let renders=0,html='',now=0,id=0,gate=null,failAdmin=false;
  const timers=new Map(),events={};
  const session={access_token:'fixture-only',user:{id:'actor',app_metadata:{role:'admin'}}};
  const warehouses=[{id:'ca',code:'CA',display_name:'California'},{id:'tx',code:'TX',display_name:'Texas'}];
  const content={contains:()=>false,querySelector:()=>null,get innerHTML(){return html;},set innerHTML(value){renders++;html=value;}};
  const dashboard={querySelector:()=>null,contains:()=>false};
  const document={visibilityState:'visible',activeElement:null,documentElement:{scrollTop:0},addEventListener(){},querySelector:selector=>selector==='[data-dashboard-content]'?content:null,getElementById:()=>dashboard};
  const window={document,crypto:require('node:crypto').webcrypto,scrollTo(){},addEventListener:(name,fn)=>events[name]=fn,
    setTimeout:(fn,ms)=>{timers.set(++id,{fn,time:now+ms});return id;},clearTimeout:id=>timers.delete(id),
    setInterval:(fn,ms)=>{timers.set(++id,{fn,time:now+ms,interval:ms});return id;},clearInterval:id=>timers.delete(id),
    AtlasCocDelivery:{warehouseContext:async()=>({accessibleWarehouses:warehouses,selectedWarehouse:warehouses[0]})}};
  const requests=[];
  const fetch=async(url,options={})=>{
    requests.push({url,body:options.body?JSON.parse(options.body):null});
    if(failAdmin&&url.includes('atlas-user-admin')&&JSON.parse(options.body||'{}').action!=='list')throw new Error('synthetic transport failure');
    if(gate&&url.includes(gate.match))await gate.promise;
    const payload=url.includes('/profiles?')?[{user_id:'actor',role:'admin',display_name:'Test administrator',warehouse_id:'ca'}]:url.includes('atlas-user-admin')?{users:[]}:url.includes('/rest/')?[]:{};
    return {ok:true,status:200,json:async()=>payload};
  };
  const context=vm.createContext({window,document,fetch,MutationObserver:class{observe(){}},localStorage:{getItem:()=>null},sessionStorage:{getItem:()=>null},Intl,URL,Date,console,Map,Set});
  vm.runInContext(fs.readFileSync(path.join(root,'atlas-login.js'),'utf8'),context);
  vm.runInContext(source.replace('window.atlasOpenDashboard = openDashboard;','window.atlasOpenDashboard = openDashboard; window.testApi = {state,loadData,loadAdminUsers,startDashboardRefresh,flushBackgroundRender,render,renderAccountModal,renderAccessManagement,handleClick,handleSubmit,handleChange,syncReceiverIdentity,renderCocOversight,renderDashboard,scannerApi,loadScannerData};'),context);
  const api=window.testApi;
  Object.assign(api.state,{mounted:true,open:true,view:'access',currentProfile:{role:'admin'},session,warehouses,selectedWarehouse:warehouses[0],skus:[{id:'s'}]});
  const tick=async ms=>{const until=now+ms;while(true){const next=[...timers].filter(([,timer])=>timer.time<=until).sort((a,b)=>a[1].time-b[1].time)[0];if(!next)break;const [key,timer]=next;now=timer.time;if(timer.interval)timer.time+=timer.interval;else timers.delete(key);timer.fn();for(let i=0;i<25;i++)await Promise.resolve();}now=until;};
  return {api,window,requests,events,content,tick,failAdmin(){failAdmin=true;},get renders(){return renders;},gate(match){const item=deferred();gate={...item,match};return item;}};
}
for(const mode of ['create','edit','confirm-delete'])test(`60-second dashboard refresh preserves open ${mode} dialog, even without field focus`,async()=>{
  const f=fixture();f.api.state.accountModal={mode};f.api.startDashboardRefresh();const before=f.renders;
  await f.tick(125000);assert.equal(f.renders,before);assert.ok(f.requests.length>=14);
  f.api.state.accountModal=null;f.api.flushBackgroundRender();assert.ok(f.renders>before);
});
test('dashboard response begun before dialog opens defers completion render',async()=>{
  const f=fixture();const gate=f.gate('/skus?');const pending=f.api.loadData();await Promise.resolve();f.api.state.accountModal={mode:'create'};const before=f.renders;
  gate.resolve();await pending;assert.equal(f.renders,before);assert.equal(f.api.state.loading,false);
  f.api.state.accountModal=null;f.api.flushBackgroundRender();assert.ok(f.renders>before);
});
test('account-list response begun before dialog opens defers completion render and tab anchor',async()=>{
  const f=fixture();const gate=f.gate('atlas-user-admin');const pending=f.api.loadAdminUsers({anchorViewportTop:120,anchorScrollTop:40});f.api.state.accountModal={mode:'edit'};const before=f.renders;
  gate.resolve();await pending;assert.equal(f.renders,before);assert.equal(f.api.state.adminLoading,false);
  f.api.state.accountModal=null;f.api.flushBackgroundRender();assert.ok(f.renders>before);
});
test('late account list cannot repopulate prior account state after sign-out',async()=>{
  const f=fixture();const gate=f.gate('atlas-user-admin');const pending=f.api.loadAdminUsers();f.api.state.open=false;
  f.events['atlas-auth-changed']({detail:{session:null}});gate.resolve();await pending;
  assert.equal(f.api.state.adminUsersLoaded,false);assert.equal(f.api.state.adminUsers.length,0);assert.equal(f.api.state.accountModal,null);
});
test('truthful warehouse labels, edit home, filter and sort',()=>{
  const f=fixture();f.api.state.adminUsers=[{id:'missing',display_name:'Missing',role:'picker',active:true},{id:'txadmin',display_name:'TX Admin',role:'admin',active:true,warehouse_code:'TX',warehouse_access:['CA','TX']}];
  const html=f.api.renderAccessManagement();assert.match(html,/Home warehouse: Unassigned/);assert.match(html,/CA \+ TX/);
  f.api.state.accountModal={mode:'edit',userId:'missing'};assert.match(f.api.renderAccountModal(),/value="" selected>Unassigned/);
  f.api.state.accountModal={mode:'edit',userId:'txadmin'};assert.match(f.api.renderAccountModal(),/value="TX" selected/);
  f.api.state.accountWarehouseFilter='CA';assert.doesNotMatch(f.api.renderAccessManagement(),/data-account-edit/);
  f.api.state.accountWarehouseFilter='TX';assert.match(f.api.renderAccessManagement(),/data-user-id="txadmin"/);assert.doesNotMatch(f.api.renderAccessManagement(),/data-user-id="missing"/);
});
test('custom dashboard eye toggles both type and accessible label',()=>{
  const f=fixture();const input={type:'password',focus(){}};const labels={};
  const button={matches:selector=>selector==='[data-password-toggle]',closest:()=>({querySelector:()=>input}),setAttribute:(key,value)=>labels[key]=value};
  const event={target:{matches:()=>false,closest:()=>button}};
  f.api.handleClick(event);assert.equal(input.type,'text');assert.equal(labels['aria-label'],'Hide password');
  f.api.handleClick(event);assert.equal(input.type,'password');assert.equal(labels['aria-label'],'Show password');
});
test('main and Receiver shared sign-in eye responds with correct labels',async()=>{
  const authSource=fs.readFileSync(path.join(root,'atlas-auth.js'),'utf8');
  const events={};const document={addEventListener:(name,fn)=>events[name]=fn};
  const window={document,addEventListener(){},setTimeout(){},clearTimeout(){}};
  const storage={getItem:()=>null,setItem(){},removeItem(){}};
  vm.runInNewContext(authSource,{window,document,localStorage:storage,sessionStorage:storage,CustomEvent:class{},MutationObserver:class{observe(){}}});
  const input={type:'password',focus(){}};const labels={};const toggle={closest:()=>({querySelector:()=>input}),setAttribute:(key,value)=>labels[key]=value};
  const event={target:{closest:()=>toggle}};
  await events.click(event);assert.equal(input.type,'text');assert.equal(labels['aria-label'],'Hide password');
  await events.click(event);assert.equal(input.type,'password');assert.equal(labels['aria-label'],'Show password');
});
test('submission reads current DOM values after deferred refresh',async()=>{
  const f=fixture();f.api.state.accountModal={mode:'create'};await f.api.loadData();
  const fields={display_name:'Entered display',login_name:'entered.login',role:'supervisor',warehouse_code:'TX',password:'synthetic-only'};
  const form={matches:selector=>selector==='[data-account-create]',elements:Object.fromEntries(Object.entries(fields).map(([name,value])=>[name,{value}])),querySelector:()=>null};
  f.api.handleSubmit({target:form,preventDefault(){}});
  for(let i=0;i<25;i++)await Promise.resolve();
  const submitted=f.requests.find(request=>request.body?.action==='create');assert.ok(submitted);
  assert.match(submitted.body.operation_id,/^[0-9a-f-]{36}$/);
  assert.deepEqual(submitted.body,{action:'create',...fields,operation_id:form.atlasOperationId});
});
test('failed create retries reuse the operation ID without retaining a password payload',async()=>{
  const f=fixture();f.failAdmin();f.api.state.accountModal={mode:'create'};
  const fields={display_name:'Name',login_name:'name',role:'picker',warehouse_code:'TX',password:'synthetic-only'};
  const form={matches:s=>s==='[data-account-create]',elements:Object.fromEntries(Object.entries(fields).map(([k,value])=>[k,{value}])),querySelector:()=>null};
  for(let attempt=0;attempt<2;attempt++){
    f.api.handleSubmit({target:form,preventDefault(){}});for(let i=0;i<30;i++)await Promise.resolve();
  }
  const writes=f.requests.filter(r=>r.body?.action==='create');assert.equal(writes.length,2);
  assert.equal(writes[0].body.operation_id,writes[1].body.operation_id);
  assert.deepEqual(Object.keys(form).sort(),['atlasOperationId','elements','matches','querySelector'].sort());
  assert.equal(f.api.state.accountModal.mode,'create');
});
test('update submits the opened revision even if a later list response changes the row',async()=>{
  const f=fixture();f.failAdmin();f.api.state.accountModal={mode:'edit',userId:'subject',expectedRevision:3};
  f.api.state.adminUsers=[{id:'subject',assignment_revision:4}];
  const fields={user_id:'subject',display_name:'Name',login_name:'name',role:'picker',warehouse_code:'TX'};
  const form={matches:s=>s==='[data-account-update]',elements:Object.fromEntries(Object.entries(fields).map(([k,value])=>[k,{value}])),querySelector:()=>null};
  f.api.handleSubmit({target:form,preventDefault(){}});for(let i=0;i<30;i++)await Promise.resolve();
  assert.equal(f.requests.find(r=>r.body?.action==='update').body.expected_revision,3);
});
test('late account save cannot close the next signed-in account form',async()=>{
  const f=fixture();f.api.state.accountModal={mode:'create'};const gate=f.gate('atlas-user-admin');
  const fields={display_name:'Name',login_name:'name',role:'picker',warehouse_code:'TX',password:'synthetic-only'};
  const form={matches:s=>s==='[data-account-create]',elements:Object.fromEntries(Object.entries(fields).map(([k,value])=>[k,{value}])),querySelector:()=>null};
  f.api.handleSubmit({target:form,preventDefault(){}});await Promise.resolve();f.api.state.open=false;
  f.events['atlas-auth-changed']({detail:{session:{user:{id:'next-account'}}}});
  // Even returning to the original identity is a new sign-in session.
  f.events['atlas-auth-changed']({detail:{session:{user:{id:'actor'}}}});
  const nextModal={mode:'create'};f.api.state.accountModal=nextModal;
  gate.resolve();for(let i=0;i<30;i++)await Promise.resolve();
  assert.equal(f.api.state.accountModal,nextModal);assert.equal(f.api.state.adminNotice,'');
});
test('Edge suppression is scoped to custom-toggle wrappers, including shared Receiver auth',()=>{
  const dashboard=fs.readFileSync(path.join(root,'atlas-dashboard.css'),'utf8');const auth=fs.readFileSync(path.join(root,'atlas-auth.css'),'utf8');
  assert.match(dashboard,/\.atlas-password-field > input::-ms-reveal,/);assert.match(dashboard,/\.atlas-password-field > input::-ms-clear\s*\{\s*display: none/);
  assert.match(auth,/\.atlas-auth-password-field>input::-ms-reveal,\.atlas-auth-password-field>input::-ms-clear\{display:none\}/);
  assert.match(fs.readFileSync(path.join(root,'coc-receiver/index.html'),'utf8'),/atlas-auth.css\?v=4/);
});
test('all APP_SHELL assets exist and modified HTML asset versions match',()=>{
  const sw=fs.readFileSync(path.join(root,'service-worker.js'),'utf8');const shell=vm.runInNewContext(sw.slice(0,sw.indexOf('self.addEventListener'))+';APP_SHELL');
  for(const url of shell)assert.ok(fs.existsSync(path.join(root,url.split('?')[0])),url);
  for(const file of ['index.html','coc-receiver/index.html']){
    const html=fs.readFileSync(path.join(root,file),'utf8');
    for(const name of ['atlas-login.js','atlas-auth.js','atlas-dashboard.js','atlas-dashboard.css','atlas-auth.css']){
      const match=html.match(new RegExp(name.replaceAll('.','\\.')+'\\?v=([0-9]+)'));if(match)assert.ok(shell.includes(`./${name}?v=${match[1]}`),`${file}: ${name}`);
    }
    assert.match(html,/service-worker.js\?v=277/);
  }
  assert.match(sw,/atlas-pwa-v375-pod-driver-access/);
});

for(const code of ['CA','TX'])test(code+' Office Receiver form synchronizes names without replacing account UUID',()=>{
 const f=fixture(),note={};const elements={role:{value:'office_receiver'},warehouse_code:{value:code},display_name:{value:'Old display'},login_name:{value:'oldkey'}};
 const form={elements,querySelector:()=>note};f.api.syncReceiverIdentity(form);
 assert.equal(elements.display_name.value,code+' COC Receiver');assert.equal(elements.login_name.value,code+' COC Receiver');assert.equal(elements.login_name.readOnly,true);assert.match(note.textContent,new RegExp('home: '+code));
 elements.warehouse_code.value=code==='CA'?'TX':'CA';f.api.handleChange({target:{name:'warehouse_code',closest:()=>form}});assert.equal(elements.login_name.value,elements.warehouse_code.value+' COC Receiver');
 f.api.state.adminUsers=[{id:'original-id',role:'office_receiver',display_name:'Old display',login_name:'oldkey',warehouse_code:code}];f.api.state.accountModal={mode:'edit',userId:'original-id'};
 const html=f.api.renderAccountModal();assert.match(html,/name="user_id" value="original-id"/);assert.equal((html.match(new RegExp('value="'+code+' COC Receiver"','g'))||[]).length,2);assert.doesNotMatch(html,/value="oldkey"/);
});
test('Receiver name drift is blocked before account submission',async()=>{
 const f=fixture();f.api.state.accountModal={mode:'create'};const message={};
 const values={role:'office_receiver',warehouse_code:'TX',display_name:'TX COC Receiver',login_name:'tampered',password:'synthetic-only'};
 const form={elements:Object.fromEntries(Object.entries(values).map(([k,value])=>[k,{value}])),matches:s=>s==='[data-account-create]',querySelector:s=>s==='[data-account-message]'?message:null};
 f.api.handleSubmit({target:form,preventDefault(){}});for(let i=0;i<10;i++)await Promise.resolve();assert.equal(f.requests.length,0);assert.match(message.textContent,/identical/);
});

for(const role of ['supervisor','admin'])test('COC Operations label and Scanner Intelligence access: '+role,async()=>{
 const f=fixture();Object.assign(f.api.state,{view:'cocs',currentProfile:{role},cocWorkspace:'scanner'});
 const html=f.api.renderDashboard();assert.match(html,/COC<br>Operations/);assert.ok(html.includes('>COC Operations</button>'));assert.doesNotMatch(html,/COC Oversight|COC<br>Oversight/);
 assert.equal(html.includes('data-coc-workspace="scanner"'),role==='admin');
 if(role==='supervisor'){
  assert.equal(f.api.state.cocWorkspace,'operations');assert.doesNotMatch(html,/Scanner Intelligence/);
  await f.api.loadScannerData();assert.equal(f.requests.length,0);
  await assert.rejects(f.api.scannerApi('metrics'),/Administrator access/);assert.equal(f.requests.length,0);
 }else{await f.api.loadScannerData();assert.equal(f.requests.filter(r=>r.url.includes('scanner-intelligence')).length,2);}
});
