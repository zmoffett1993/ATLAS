const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {stripTypeScriptTypes}=require('node:module');
const source=stripTypeScriptTypes(fs.readFileSync(path.join(__dirname,'../supabase/functions/scanner-intelligence/index.ts'),'utf8')).replace(/^import .*;\n/,'');
function fixture(role,code='CA',spoof=false){
 let handler,reads=0;const user={id:'fixture-user',app_metadata:{role,home_warehouse_code:code},user_metadata:spoof?{role:'admin'}:{}};
 const query={};for(const name of ['select','eq','gte','order','range'])query[name]=()=>query;query.then=resolve=>Promise.resolve(resolve({data:[],error:null}));
 const client={auth:{getUser:async()=>({data:{user},error:null})},from(){reads++;return query;}};
 vm.runInNewContext(source,{createClient:()=>client,Deno:{env:{get:()=> 'fixture'},serve:fn=>handler=fn},Response,console:{error(){}},Uint8Array,atob});
 return {get reads(){return reads;},call:action=>handler(new Request('https://fixture.invalid',{method:'POST',headers:{Authorization:'Bearer fixture','Content-Type':'application/json'},body:JSON.stringify({action,warehouseCode:code})}))};
}
for(const code of ['CA','TX'])for(const role of ['supervisor','picker','office_receiver'])for(const action of ['metrics','list-corrections','correction-detail','review-correction'])test(`${code} ${role} denied ${action} before data access`,async()=>{
 const f=fixture(role,code,true),r=await f.call(action);assert.equal(r.status,403);assert.equal((await r.json()).error,'ADMINISTRATOR_REQUIRED');assert.equal(f.reads,0);
});
for(const role of ['admin','administrator'])test(`${role} retains analytics`,async()=>{const f=fixture(role),r=await f.call('metrics');assert.equal(r.status,200);assert.equal((await r.json()).summary.attempts,0);assert.equal(f.reads,1);});
for(const role of ['supervisor','picker'])test(`${role} retains normal scan submission validation`,async()=>{const f=fixture(role),r=await f.call('record-attempt');assert.equal(r.status,400);assert.equal((await r.json()).error,'SCANNER_EVENT_ID_INVALID');});
