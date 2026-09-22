// Reused from commit 53e3845. Synthetic fixtures only; no external requests.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
function fixture(){
 const source=fs.readFileSync(path.join(__dirname,'../atlas-auth.js'),'utf8');
 const project=source.match(/const PROJECT_REF = "([a-z]+)"/)[1],authKey='sb-'+project+'-auth-token';
 const session={access_token:'fixture-session',user:{id:'office'},expires_at:Math.floor(Date.now()/1000)+3600};
 const local=new Map([[authKey,JSON.stringify(session)],['atlas-coc-receiver-warehouse-v1:office','TX'],['fixture-CA-pairing','preserved-ca'],['fixture-TX-pairing','preserved-tx']]);
 const temporary=new Map([['atlas-dashboard-session-v1',JSON.stringify(session)]]),requests=[];
 const storage=map=>({getItem:k=>map.get(k)||null,setItem:(k,v)=>map.set(k,v),removeItem:k=>map.delete(k)});
 const document={addEventListener(){},querySelector(){return null;}};
 const window={document,localStorage:storage(local),sessionStorage:storage(temporary),addEventListener(){},dispatchEvent(){},setTimeout(){},clearTimeout(){},atlasSupabaseConfig:{url:'https://fixture.invalid',key:'fixture-only'}};
 vm.runInNewContext(source,{window,document,MutationObserver:class{observe(){}},CustomEvent:class{},fetch:async(url,options)=>{requests.push({url,options});return {ok:true,json:async()=>({})};}});
 return {window,local,temporary,requests,authKey};
}
test('Receiver local sign-out removes current auth storage but preserves pairing/binding keys',async()=>{
 const f=fixture();await f.window.AtlasAuth.signOut({scope:'local'});await Promise.resolve();
 assert.equal(f.window.AtlasAuth.getSession(),null);assert.equal(f.local.has(f.authKey),false);assert.equal(f.temporary.size,0);
 assert.equal(f.local.get('atlas-coc-receiver-warehouse-v1:office'),'TX');
 assert.equal(f.local.get('fixture-CA-pairing'),'preserved-ca');assert.equal(f.local.get('fixture-TX-pairing'),'preserved-tx');
 assert.equal(f.requests.length,1);assert.equal(f.requests[0].url,'https://fixture.invalid/auth/v1/logout?scope=local');
});
test('default ATLAS sign-out retains its existing global endpoint',async()=>{
 const f=fixture();await f.window.AtlasAuth.signOut();await Promise.resolve();
 assert.equal(f.requests[0].url,'https://fixture.invalid/auth/v1/logout');
});
