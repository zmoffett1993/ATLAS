import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { request } from "node:http";
import { createNotificationRpc, connectNotifications } from "../tools/routing-preview/notification-client.mjs";
import { createReminderStore } from "../cloud-run/atlas-routing-reminders/store.mjs";
import { runReminderJob } from "../cloud-run/atlas-routing-reminders/job.mjs";
import { createPermanentHost } from "../cloud-run/atlas-routing-app/server.mjs";
const USER="11111111-1111-4111-8111-111111111111", OTHER="22222222-2222-4222-8222-222222222222", BINDING="33333333-3333-4333-8333-333333333333";
const session=()=>({user:{id:USER},access_token:"synthetic-atlas-access-token-only"});
test("device RPC uses fixed CA API with current user credentials, no cookies and no redirects",async()=>{
  const calls=[];const rpc=createNotificationRpc({key:"sb_publishable_synthetic",getSession:session,getValidSession:async()=>session(),fetchImpl:async(...args)=>{calls.push(args);return Response.json({eligible:true,userId:USER,warehouse:"CA"});}});
  assert.equal((await rpc("status",{binding:BINDING})).eligible,true);
  assert.equal(calls[0][0],"https://dwrrbpiprcmajfyronlf.supabase.co/rest/v1/rpc/atlas_routing_notification_device");
  assert.equal(calls[0][1].credentials,"omit");assert.equal(calls[0][1].redirect,"error");assert.equal(calls[0][1].cache,"no-store");
  assert.deepEqual(JSON.parse(calls[0][1].body),{p_action:"status",p_payload:{binding:BINDING}});
  await assert.rejects(rpc("send"));assert.equal(calls.length,1);
});
test("account changes during refresh or response reject registration results",async()=>{
  let current=session(),calls=0;
  const rpc=createNotificationRpc({key:"test",getSession:()=>current,getValidSession:async()=>{current={...current,user:{id:OTHER}};return current;},fetchImpl:async()=>{calls++;return Response.json({});}});
  await assert.rejects(rpc("prepare"));assert.equal(calls,0);
  current=session();const later=createNotificationRpc({key:"test",getSession:()=>current,getValidSession:async()=>current,fetchImpl:async()=>{current={...current,user:{id:OTHER}};return Response.json({enabled:true,binding:BINDING});}});
  await assert.rejects(later("register"));
});
test("device RPC bounds output and does not expose database error text",async()=>{
  for(const response of [new Response('private database detail',{status:403}),new Response('x'.repeat(4097)),new Response('{broken')]){
    const rpc=createNotificationRpc({key:"test",getSession:session,getValidSession:async()=>session(),fetchImpl:async()=>response});
    await assert.rejects(rpc("status"),error=>!error.message.includes('private database detail'));
  }
});
test("temporary origins and disabled config never touch device storage or request permission",async()=>{
  for(const config of [{notificationsEnabled:false},{notificationsEnabled:true,notificationOrigin:"https://18766-test.cs-test.cloudshell.dev"}]){
    assert.equal(await connectNotifications(config,{location:{origin:"https://18766-test.cs-test.cloudshell.dev",protocol:"https:",hostname:"18766-test.cs-test.cloudshell.dev"}}),null);
  }
});
test("server store accepts only a server secret and exposes only fixed RPC operations",async()=>{
  assert.throws(()=>createReminderStore({secretKey:"sb_publishable_not_server"}));const calls=[];
  const store=createReminderStore({secretKey:"sb_secret_synthetic_only",fetchImpl:async(...args)=>{calls.push(args);return Response.json([]);}});
  await store.authorizedDevices(USER,"CA");await store.claim({recipientId:USER,warehouse:"CA",deviceId:OTHER,binding:BINDING,day:"2026-09-21"});
  assert.ok(calls.every(([url])=>url==="https://dwrrbpiprcmajfyronlf.supabase.co/rest/v1/rpc/atlas_routing_notification_server"));
  assert.equal(calls[0][1].headers.apikey,"sb_secret_synthetic_only");assert.equal(calls[0][1].redirect,"error");
  assert.equal(JSON.stringify(JSON.parse(calls[0][1].body)).includes("sb_secret"),false);
});
test("server store masks backend errors and rejects oversized responses",async()=>{
  for(const response of [new Response('private credential detail',{status:500}),new Response('x'.repeat(32769))]){
    const store=createReminderStore({secretKey:"sb_secret_synthetic_only",fetchImpl:async()=>response});
    await assert.rejects(store.authorizedDevices(USER,"CA"),e=>!e.message.includes('private credential detail'));
  }
});
test("job is inert when disabled and rejects unexpected runtime before importing libraries",async()=>{
  let loaded=0;const loadWebPush=async()=>{loaded++;return {};};
  assert.equal((await runReminderJob({env:()=>undefined,loadWebPush})).skipped,true);
  await assert.rejects(runReminderJob({env:k=>k==="ATLAS_NOTIFICATIONS_ENABLED"?"true":undefined,loadWebPush}));assert.equal(loaded,0);
});
test("job connects actual RPC store and VAPID library contract, with no direct customer payload",async()=>{
  const values={ATLAS_NOTIFICATIONS_ENABLED:"true",CLOUD_RUN_JOB:"atlas-routing-reminders",ATLAS_PUSH_PUBLIC_KEY:'B'+'A'.repeat(86),ATLAS_PUSH_PRIVATE_KEY:'A'.repeat(43),ATLAS_PUSH_SUBJECT:'mailto:test@example.test',ATLAS_NOTIFICATION_RECIPIENT_ID:USER,ATLAS_NOTIFICATION_DB_SECRET:'sb_secret_synthetic_only'};
  const operations=[],sent=[];
  const result=await runReminderJob({env:key=>values[key],now:()=>new Date('2026-09-22T00:00:00Z'),loadWebPush:async()=>({sendNotification:async(...args)=>sent.push(args)}),fetchImpl:async(url,init)=>{
    const {p_action}=JSON.parse(init.body);operations.push(p_action);
    return Response.json(p_action==='devices'?[{id:OTHER,binding:BINDING,userId:USER,warehouse:'CA',enabled:true,authorized:true,subscription:{endpoint:'https://web.push.apple.com/test',keys:{p256dh:'B'+'A'.repeat(86),auth:'A'.repeat(22)}}}]:p_action==='claim'?{claimed:true}:true);
  }});
  assert.deepEqual(result,{attempted:1,sent:1,skipped:false});assert.deepEqual(operations,['devices','claim','authorized','finish']);
  assert.equal(sent.length,1);assert.equal(sent[0][2].vapidDetails.privateKey,values.ATLAS_PUSH_PRIVATE_KEY);assert.equal(sent[0][1].includes(USER),false);assert.equal(sent[0][1].includes(values.ATLAS_PUSH_PRIVATE_KEY),false);
});
const ORIGIN="https://atlas-routing-app-340839522237.us-central1.run.app";
const http=(url,options)=>new Promise((resolve,reject)=>{const req=request(url,options,res=>{const chunks=[];res.on('data',c=>chunks.push(c));res.on('end',()=>resolve(new Response(Buffer.concat(chunks),{status:res.statusCode,headers:res.headers})));});req.on('error',reject);req.end(options.body);});
async function hostFixture(t,fetchImpl=async()=>{throw Error('Unexpected network');}){
  const values={K_SERVICE:'atlas-routing-app',ATLAS_ROUTING_APP_ORIGIN:ORIGIN,ATLAS_ROUTING_APP_TESTER_ID:USER,ATLAS_ROUTING_SUPABASE_PUBLISHABLE_KEY:'sb_publishable_synthetic',ATLAS_NOTIFICATIONS_ENABLED:'true'};
  const server=createPermanentHost({env:k=>values[k],fetchImpl});server.listen(0,'127.0.0.1');await once(server,'listening');
  t.after(()=>new Promise(r=>{server.close(r);server.closeAllConnections();}));
  return (path,options={})=>http(`http://127.0.0.1:${server.address().port}${path}`,{method:'GET',headers:{Host:new URL(ORIGIN).host},...options});
}
test("permanent host serves a root-scope worker and manifest while hiding sender, configuration and database files",async t=>{
  const invoke=await hostFixture(t);const worker=await invoke('/tools/routing-preview/routing-notification-sw.mjs');
  assert.equal(worker.status,200);assert.equal(worker.headers.get('Service-Worker-Allowed'),'/');assert.match(await worker.text(),/notificationclick/);
  const manifest=await invoke('/routing.webmanifest');assert.equal((await manifest.json()).scope,'/');
  const config=await (await invoke('/runtime-config.json')).json();assert.equal(config.notificationsEnabled,true);assert.equal(config.notificationOrigin,ORIGIN);assert.equal(JSON.stringify(config).includes(USER),false);
  for(const p of ['/tools/routing-preview/notification-dispatcher.mjs','/cloud-run/atlas-routing-reminders/job.mjs','/.env','/AGENTS.md','/api/send','/NEW%20COC%202.xlsx'])assert.equal((await invoke(p)).status,404);
});
test("permanent host rejects foreign Origin/Host and unapproved account without requesting Google credentials",async t=>{
  const calls=[];const invoke=await hostFixture(t,async url=>{calls.push(url);return Response.json({id:OTHER});});
  assert.equal((await invoke('/',{headers:{Host:'evil.test'}})).status,403);
  assert.equal((await invoke('/runtime-config.json',{headers:{Host:new URL(ORIGIN).host,Origin:'https://evil.test'}})).status,403);
  const response=await invoke('/api/plan-trip',{method:'POST',headers:{Host:new URL(ORIGIN).host,Origin:ORIGIN,'X-Atlas-Authorization':'Bearer synthetic-atlas-access-token-only','Content-Type':'application/json'},body:'{}'});
  assert.equal(response.status,403);assert.deepEqual(calls,['https://dwrrbpiprcmajfyronlf.supabase.co/auth/v1/user']);
});
