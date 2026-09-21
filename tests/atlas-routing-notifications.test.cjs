const test = require('node:test');
const assert = require('node:assert/strict');
const policy = require('../atlas-routing-notifications.js');
const USER = '11111111-1111-4111-8111-111111111111';
const BINDING = '22222222-2222-4222-8222-222222222222';
const DEVICE = '33333333-3333-4333-8333-333333333333';
const OTHER = '44444444-4444-4444-8444-444444444444';
const example = () => ({ endpoint: 'https://web.push.apple.com/test-only', keys: { p256dh: 'B'+'A'.repeat(86), auth: 'A'.repeat(22) } });
const monday = () => new Date('2026-09-22T00:00:00Z'); // Monday 17:00 Pacific.

test('reminders are due at 5 PM Pacific on weekdays, in both daylight-saving and standard time', () => {
  for (const instant of ['2026-09-22T00:00:00Z','2026-09-26T00:00:00Z','2026-01-06T01:00:00Z','2026-03-10T00:00:00Z','2026-11-03T01:00:00Z']) assert.ok(policy.dueDay(new Date(instant)), instant);
  for (const instant of ['2026-09-21T23:59:59Z','2026-09-22T00:15:00Z','2026-09-22T01:00:00Z','2026-09-27T00:00:00Z','2026-09-28T00:00:00Z','2026-01-06T00:00:00Z']) assert.equal(policy.dueDay(new Date(instant)),null,instant);
  assert.equal(policy.schedule.recipient,'Zach only'); assert.ok(Object.isFrozen(policy.schedule.weekdays));
});
test('only dispatched, unreviewed orders need reminders; plans, confirmations, issues and other days do not', () => {
  const date='2026-09-21';
  assert.equal(policy.reviewCount([{dispatchedOn:date},{dispatchedOn:date,deliveredOn:date},{dispatchedOn:date,deliveryException:'Customer closed'}, {}, {dispatchedOn:'2026-09-20'},{dispatchedOn:'2026-09-22'}],date),1);
  assert.equal(policy.reviewCount([],date),0); assert.equal(policy.reviewCount([{dispatchedOn:'2026-02-30'}],'2026-02-30'),0);
});
test('push endpoints reject arbitrary hosts, redirects in URLs, credentials, invalid keys and oversized inputs', () => {
  for (const endpoint of ['http://web.push.apple.com/a','https://web.push.apple.com.evil.test/a','https://fcm.googleapis.com@evil.test/a','https://web.push.apple.com:444/a','https://127.0.0.1/a','https://metadata.google.internal/a','https://fcm.googleapis.com/a?redirect=evil','https://web.push.apple.com/a#test','https://updates.push.services.mozilla.com/']) assert.throws(()=>policy.subscription({...example(),endpoint}));
  for(const host of ['web.push.apple.com','fcm.googleapis.com','updates.push.services.mozilla.com']) assert.equal(policy.subscription({...example(),endpoint:`https://${host}/synthetic-only`}).endpoint,`https://${host}/synthetic-only`);
  assert.throws(()=>policy.subscription({...example(),keys:{p256dh:'short',auth:'short'}}));
  assert.throws(()=>policy.subscription({...example(),endpoint:'https://fcm.googleapis.com/'+ 'a'.repeat(2048)}));
});
test('notification content is generic and click URL stays in the app scope regardless of supplied contents', () => {
  const notice=policy.notificationOptions({...policy.notice('2026-09-21',BINDING),customer:'PRIVATE CUSTOMER',url:'https://evil.test'},'https://atlas.example/ATLAS/');
  assert.equal(notice.options.data.url,'https://atlas.example/ATLAS/#delivery-review=2026-09-21');
  assert.equal(JSON.stringify(notice).includes('PRIVATE CUSTOMER'),false); assert.equal(notice.options.renotify,false);
  assert.equal(policy.notificationOptions({version:1,type:'atlas-delivery-review',day:'2026-02-30',binding:BINDING},'https://atlas.example/'),null);
});
const ready = () => ({ connected:true,secure:true,stableOrigin:true,supported:true,eligible:true });
test('capability gates support iPhone and Android, avoid prompting on temporary origins or denied permission',()=>{
  assert.equal(policy.availability().canEnable,false);
  assert.equal(policy.availability({...ready(),ios:true,standalone:false}).canEnable,false);
  assert.equal(policy.availability({...ready(),ios:true,standalone:true}).canEnable,true);
  assert.equal(policy.availability({...ready(),ios:false}).canEnable,true);
  for(const override of [{permission:'denied'},{eligible:false},{stableOrigin:false},{secure:false},{supported:false}]) assert.equal(policy.availability({...ready(),...override}).canEnable,false);
});
function controllerFixture(overrides={}) {
  let owner=USER; const events=[];
  const acquired={ toJSON:example,unsubscribe:async()=>{events.push('unsubscribe');} };
  const config={eligible:true,userId:USER,warehouse:'CA',binding:BINDING,publicKey:'synthetic-public-key'};
  const backend={prepare:async()=>{events.push('prepare');return config;},register:async()=>{events.push('register');return {enabled:true,binding:BINDING};},revoke:async()=>{events.push('revoke');}};
  const device={requestPermission:async()=>{events.push('permission');return 'granted';},subscribe:async()=>{events.push('subscribe');return acquired;},bind:async()=>{events.push('bind');},clear:async()=>{events.push('clear');},unsubscribe:acquired.unsubscribe};
  const c=policy.createController({environment:ready,identity:()=>owner,device:{...device,...overrides.device},backend:{...backend,...overrides.backend},...overrides.options});
  return {c,events,config,identity:(id)=>{owner=id;}};
}
test('enable starts permission in the user gesture and registers only the current authorized CA account',async()=>{
  const f=controllerFixture();const pending=f.c.enable();assert.deepEqual(f.events,['permission']);
  assert.equal(await pending,true);assert.deepEqual(f.events,['permission','prepare','subscribe','register','bind']);assert.equal(f.c.status().enabled,true);
  assert.equal(await f.c.enable(),false);
});
test('disabled or denied permissions make no server registration calls',async()=>{
  const f=controllerFixture({options:{environment:()=>({})}});assert.equal(await f.c.enable(),false);assert.equal(f.events.length,0);
  const denied=controllerFixture({device:{requestPermission:async()=> 'denied'}});assert.equal(await denied.c.enable(),false);assert.equal(denied.events.length,0);
});
test('wrong recipient or warehouse cannot subscribe',async()=>{
  for(const change of [{userId:OTHER},{warehouse:'TX'},{eligible:false}]) {
    const f=controllerFixture();Object.assign(f.config,change);assert.equal(await f.c.enable(),false);assert.equal(f.events.includes('subscribe'),false);
  }
});
test('unconfirmed server registration unsubscribes and clears binding; never reports enabled',async()=>{
  const f=controllerFixture({backend:{register:async()=>{throw new Error('synthetic timeout');}}});
  assert.equal(await f.c.enable(),false);assert.equal(f.c.status().enabled,false);assert.ok(f.events.includes('clear'));assert.ok(f.events.includes('unsubscribe'));assert.ok(f.events.includes('revoke'));
});
test('account change while enabling invalidates late registration and suppresses the device',async()=>{
  let release;const f=controllerFixture({backend:{register:()=>new Promise(r=>{release=r;})}});
  const pending=f.c.enable();while(!release) await new Promise(r=>setImmediate(r));
  f.identity(OTHER);await f.c.reset();release({enabled:true,binding:BINDING});
  assert.equal(await pending,false);assert.equal(f.c.status().enabled,false);assert.equal(f.events.includes('bind'),false);
});
test('opt-out suppresses locally before network revocation and reports uncertain failures honestly',async()=>{
  const f=controllerFixture();await f.c.enable();f.events.length=0;assert.equal(await f.c.disable(),true);assert.deepEqual(f.events,['clear','unsubscribe','revoke']);assert.equal(f.c.status().enabled,false);
  const offline=controllerFixture({backend:{revoke:async()=>{throw new Error('offline');}}});await offline.c.enable();assert.equal(await offline.c.disable(),false);assert.match(offline.c.status().message,/Could not confirm/);
});
async function dispatcherFixture(overrides={}) {
  const {createDispatcher}=await import('../tools/routing-preview/notification-dispatcher.mjs');
  const calls=[], claims=new Set();const device={id:DEVICE,binding:BINDING,userId:USER,warehouse:'CA',authorized:true,enabled:true,subscription:example()};
  const store={authorizedDevices:async()=>[device],claim:async({deviceId,day})=>{const key=deviceId+day; if(claims.has(key))return {claimed:false};claims.add(key);return {claimed:true};},stillAuthorized:async()=>true,finish:async(...args)=>{calls.push(['finish',...args]);},retire:async(...args)=>{calls.push(['retire',...args]);}};
  const dispatch=createDispatcher({enabled:true,recipientId:USER,now:monday,store:{...store,...overrides.store},sendNotification:async(...args)=>{calls.push(['send',...args]);},...overrides.options});
  return {dispatch,calls,device};
}
test('sender remains off by default and refuses a list or missing single recipient',async()=>{
  const {createDispatcher}=await import('../tools/routing-preview/notification-dispatcher.mjs');
  assert.deepEqual(await createDispatcher({})(),{attempted:0,sent:0,skipped:true});
  assert.throws(()=>createDispatcher({enabled:true,recipientId:USER+','+OTHER}));assert.throws(()=>createDispatcher({enabled:true}));
});
test('sender deduplicates concurrent runs per device/day and sends only generic data with bounded TTL',async()=>{
  const f=await dispatcherFixture();await Promise.all([f.dispatch(),f.dispatch()]);const sent=f.calls.filter(c=>c[0]==='send');assert.equal(sent.length,1);
  assert.deepEqual(JSON.parse(sent[0][2]),policy.notice('2026-09-21',BINDING));assert.equal(sent[0][3].TTL,900);assert.equal(sent[0][3].timeout,10000);
});
test('no other account, warehouse, disabled device or revoked authorization receives pushes',async()=>{
  for(const change of [{userId:OTHER},{warehouse:'TX'},{authorized:false},{enabled:false}]){const f=await dispatcherFixture();Object.assign(f.device,change);await f.dispatch();assert.equal(f.calls.length,0);}
  const revoked=await dispatcherFixture({store:{stillAuthorized:async()=>false}});await revoked.dispatch();assert.equal(revoked.calls.length,0);
});
test('no reminder without a DB claim (no unreviewed dispatches), or on weekends',async()=>{
  const empty=await dispatcherFixture({store:{claim:async()=>({claimed:false})}});await empty.dispatch();assert.equal(empty.calls.length,0);
  const weekend=await dispatcherFixture({options:{now:()=>new Date('2026-09-27T00:00:00Z')}});assert.equal((await weekend.dispatch()).skipped,true);assert.equal(weekend.calls.length,0);
});
test('expired subscriptions retire and ambiguous network failures never automatically retry',async()=>{
  for(const statusCode of [404,410,500,undefined]){
    let attempts=0;const f=await dispatcherFixture({options:{sendNotification:async()=>{attempts++;throw {statusCode};}}});await f.dispatch();await f.dispatch();
    assert.equal(attempts,1);assert.equal(f.calls.some(c=>c[0]==='retire'),statusCode===404||statusCode===410);
  }
});
async function workerFixture(overrides={}){
  const {createNotificationHandlers}=await import('../tools/routing-preview/notification-worker.mjs');const calls=[];
  return {calls,handlers:createNotificationHandlers({scope:'https://atlas.example/ATLAS/',now:monday,getBinding:async()=>BINDING,registration:{showNotification:async(...a)=>calls.push(['show',...a])},clients:{matchAll:async()=>[],openWindow:async u=>calls.push(['open',u])},...overrides})};
}
test('worker ignores malformed, stale, weekend and previous-account messages',async()=>{
  const f=await workerFixture();
  for(const payload of ['bad','x'.repeat(1025),JSON.stringify(policy.notice('2026-09-20',BINDING)),JSON.stringify(policy.notice('2026-09-21',OTHER))])await f.handlers.push({data:{text:()=>payload}});
  assert.equal(f.calls.length,0);
  const weekend=await workerFixture({now:()=>new Date('2026-09-27T00:00:00Z')});await weekend.handlers.push({data:{text:()=>JSON.stringify(policy.notice('2026-09-26',BINDING))}});assert.equal(weekend.calls.length,0);
  await f.handlers.push({data:{text:()=>JSON.stringify(policy.notice('2026-09-21',BINDING))}});assert.equal(f.calls.length,1);
});
test('notification tap opens only the app review URL and never mutates delivery records',async()=>{
  const f=await workerFixture();await f.handlers.click({notification:{data:{...policy.notice('2026-09-21',BINDING),url:'https://evil.test/'},close:()=>{}}});
  assert.deepEqual(f.calls,[['open','https://atlas.example/ATLAS/#delivery-review=2026-09-21']]);
});
test('notification tap preserves an already-open draft by messaging and focusing instead of navigating',async()=>{
  const actions=[];const f=await workerFixture({clients:{matchAll:async()=>[{url:'https://atlas.example/ATLAS/',postMessage:m=>actions.push(['message',m]),focus:async()=>actions.push(['focus'])}],openWindow:()=>{throw Error('must preserve draft');}}});
  await f.handlers.click({notification:{data:policy.notice('2026-09-21',BINDING),close:()=>{}}});assert.deepEqual(actions,[['message',{type:'atlas-delivery-review',day:'2026-09-21'}],['focus']]);
});
