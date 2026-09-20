const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
function fixture(){
 const requests=[],storage=new Map();
 const document={addEventListener(){},querySelector(){return null;}};
 const window={document,localStorage:{getItem:k=>storage.get(k)||null,setItem:(k,v)=>storage.set(k,v)},sessionStorage:{getItem:()=>null,setItem(){}},addEventListener(){},dispatchEvent(){},setTimeout(){},clearTimeout(){},atlasSupabaseConfig:{url:'https://fixture.invalid',key:'fixture'}};
 const context=vm.createContext({window,document,CustomEvent:class{},MutationObserver:class{observe(){}},fetch:async(url,options)=>{const body=JSON.parse(options.body);requests.push({url,body});return {ok:true,json:async()=>({access_token:'test',expires_in:3600,user:{id:body.email.startsWith('ca')?'ca-office':'tx-office'}})};}});
 for(const file of ['atlas-login.js','atlas-auth.js'])vm.runInContext(fs.readFileSync(path.join(__dirname,'..',file),'utf8'),context);
 return {auth:window.AtlasAuth,requests};
}
for(const [name,key,id] of [['CA COC Receiver','cacocreceiver','ca-office'],['TX COC Receiver','txcocreceiver','tx-office'],[' tx   coc Receiver ','txcocreceiver','tx-office'],['Separate.Login','separate.login','tx-office']])test('actual shared authentication accepts '+name,async()=>{
 const f=fixture(),session=await f.auth.signIn(name,'synthetic-password');
 assert.equal(f.requests[0].body.email,key+'@users.atlas.invalid');assert.equal(session.user.id,id);
 assert.equal(f.requests[0].url,'https://fixture.invalid/auth/v1/token?grant_type=password');
});
test('email input is rejected before authentication transport',async()=>{
 const f=fixture();await assert.rejects(f.auth.signIn('person@example.com','synthetic-password'));assert.equal(f.requests.length,0);
});
