const test=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const {readFileSync}=require('node:fs');
const tick=()=>new Promise(resolve=>setImmediate(resolve));

test('personal shortcut clears on account switch and ignores a late previous-account response',async()=>{
  const listeners=new Map(), notices=[];let session={user:{id:'first'},access_token:'synthetic'},release;
  const window={AtlasAuth:{getSession:()=>session,getValidSession:async()=>session},addEventListener:(name,fn)=>listeners.set(name,fn),dispatchEvent:event=>notices.push(event.type)};
  let requests=0;
  const context={window,location:{origin:'https://zmoffett1993.github.io',pathname:'/ATLAS/'},document:{readyState:'loading',addEventListener(){}},Event,AbortController,AbortSignal,
    fetch:async()=>{requests++;return new Promise(r=>release=r);},connectRouting:async()=>{}};
  const code=readFileSync('tools/routing-preview/full-site-client.mjs','utf8').replace(/^import[^\n]+\n/,'').replaceAll('export const','const');
  vm.runInNewContext(code,context);
  listeners.get('atlas-auth-changed')();await tick();assert.equal(requests,1);
  session=null;listeners.get('atlas-auth-changed')();assert.equal(window.atlasPersonalScannerAllowed(),false);
  release({ok:true,json:async()=>({capabilities:['routing_scanner_quick_action']})});await tick();
  assert.equal(window.atlasPersonalScannerAllowed(),false);
  session={user:{id:'second'},access_token:'synthetic2'};listeners.get('atlas-auth-changed')();await tick();
  release({ok:true,json:async()=>({capabilities:[]})});await tick();assert.equal(window.atlasPersonalScannerAllowed(),false);
  session={user:{id:'first'},access_token:'synthetic'};listeners.get('atlas-auth-changed')();await tick();
  release({ok:true,json:async()=>({capabilities:['routing_scanner_quick_action']})});await tick();assert.equal(window.atlasPersonalScannerAllowed(),true);
  session.user.user_metadata={full_name:'Renamed'};assert.equal(window.atlasPersonalScannerAllowed(),true);
  session={user:{id:'other'}};assert.equal(window.atlasPersonalScannerAllowed(),false);
  assert.ok(notices.length>=5);
});
