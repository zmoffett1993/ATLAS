import test from "node:test";
import assert from "node:assert/strict";
import { request } from "node:http";
import { once } from "node:events";
import { createPhotoHandler, validatePhoto, photoResult } from "../cloud-run/atlas-routing-preview/photo-handler.mjs";
import { createPreviewServer } from "../cloud-run/atlas-routing-preview/server.mjs";
import { createPreviewBridge } from "../tools/routing-preview/bridge.mjs";
import { requestPhoto } from "../tools/routing-preview/preview.mjs";
const http = (url, options) => new Promise((resolve,reject) => {
  const req=request(url, options, res=> { const chunks=[]; res.on('data',chunk=>chunks.push(chunk)); res.on('end',()=>resolve(new Response(Buffer.concat(chunks),{status:res.statusCode,headers:res.headers}))); });
  req.on('error',reject); req.end(options.body);
});
const USER = "11111111-1111-4111-8111-111111111111", OTHER = "22222222-2222-4222-8222-222222222222";
const PHOTO = Buffer.from([255,216,255,224,0,0,0,0,0,0,255,217]).toString('base64');
const payload = () => ({ action: "readOrderPhoto", warehouse: "CA", image: PHOTO });
const annotation = () => ({ responses: [{ fullTextAnnotation: { text: 'CGST1-95MM-0401', pages: [{ width: 100, height: 100,
  blocks: [{ paragraphs: [{ words: [{ symbols: [{ text: 'CGST1-95MM-0401' }], confidence: .99,
    boundingBox: { vertices: [{ x: 10, y: 20 }, { x: 40, y: 20 }, { x: 40, y: 25 }, { x: 10, y: 25 }] } }] }] }] }] } }] });
function fixture(options = {}) {
  const calls = [], env = { ATLAS_ROUTING_PREVIEW_ENABLED: 'true', ATLAS_ROUTING_PHOTO_ENABLED: 'true', K_SERVICE: 'atlas-routing-preview',
    ATLAS_ROUTING_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_synthetic', ATLAS_ROUTING_TESTER_IDS: USER, ...options.env };
  let clock = Date.parse('2026-09-20T12:00:00Z');
  const handler = createPhotoHandler({ env: k => env[k], now: () => clock, fetchImpl: async (url, init) => {
    calls.push({ url, init }); assert.equal(init.redirect, 'error');
    if (url.includes('supabase.co')) {
      assert.equal(init.method, undefined); assert.equal(init.headers.Authorization, 'Bearer synthetic-user-access-token');
      assert.equal(JSON.stringify(init).includes(PHOTO), false);
      if (url.endsWith('/auth/v1/user')) return Response.json(options.user || { id: USER, app_metadata: { role: 'admin' } });
      if (url.includes('/profiles?')) return Response.json(options.profiles || [{ user_id: USER, role: 'admin', warehouse_id: 'ca' }]);
      if (url.includes('/profile_warehouse_access?')) return Response.json(options.access || []);
      if (url.includes('/warehouses?')) return Response.json([{ id: 'ca', code: 'CA', active: true }]);
    }
    if (url.endsWith('/email')) return new Response(options.identity || 'atlas-routing-preview@project-6a63ee65-40cb-4d53-b32.iam.gserviceaccount.com', { headers: { 'Metadata-Flavor': 'Google' } });
    if (url.endsWith('/token')) return Response.json({ access_token: 'synthetic-google', expires_in: 3600, token_type: 'Bearer' }, { headers: { 'Metadata-Flavor': 'Google' } });
    assert.equal(url, 'https://vision.googleapis.com/v1/images:annotate');
    assert.equal(init.headers.Authorization, 'Bearer synthetic-google');
    assert.deepEqual(JSON.parse(init.body), { requests: [{ image: { content: PHOTO }, features: [{ type: 'DOCUMENT_TEXT_DETECTION' }] }] });
    return options.status ? Response.json({ error: { secret: 'must not leak' } }, { status: options.status }) : Response.json(annotation());
  } });
  return { calls, advance: () => clock += 2000, invoke: (body = payload(), origin = 'http://localhost:18766', authorization = 'Bearer synthetic-user-access-token') => handler(new Request('http://local/read-order-photo', {
    method: 'POST', headers: { Origin: origin, Authorization: authorization, 'Content-Type': 'application/json' }, body: JSON.stringify(body) })) };
}
test('OCR disabled by default; bad origins and missing authentication cannot reach Vision', async () => {
  const disabled = fixture({ env: { ATLAS_ROUTING_PHOTO_ENABLED: 'false' } });
  assert.equal((await disabled.invoke()).status, 503); assert.equal(disabled.calls.length, 0);
  const denied = fixture(); assert.equal((await denied.invoke(payload(), 'https://evil.test')).status, 403);
  assert.equal((await denied.invoke(payload(), undefined, '')).status, 401); assert.equal(denied.calls.length, 0);
});
test('photo authorization retains tester, trusted role, caller profile and CA warehouse isolation', async () => {
  for (const options of [
    { user: { id: OTHER, app_metadata: { role: 'admin' } } },
    { user: { id: USER, user_metadata: { role: 'admin' } } },
    { profiles: [{ user_id: USER, role: 'staff', warehouse_id: 'ca' }] },
    { profiles: [{ user_id: USER, role: 'admin', warehouse_id: 'tx' }], access: [{ user_id: OTHER, warehouse_id: 'ca' }] },
  ]) { const f = fixture(options); assert.equal((await f.invoke()).status, 403); assert.ok(f.calls.every(c => c.url.includes('supabase.co'))); }
  const f = fixture(); assert.equal((await f.invoke({ ...payload(), warehouse: 'TX' })).status, 403);
  assert.ok(f.calls.every(c => c.url.includes('supabase.co')));
});
test('only bounded inline JPEGs are accepted; URLs, model injection and malformed base64 fail', () => {
  assert.equal(validatePhoto(payload()), PHOTO);
  for (const image of ['https://evil.test/a.jpg', 'x'.repeat(2800004), '', 'AAAA', PHOTO + '!']) assert.throws(() => validatePhoto({ ...payload(), image }));
  assert.throws(() => validatePhoto({ ...payload(), imageUri: 'https://evil.test' }));
});
test('Vision uses keyless runtime identity and returns only text geometry; no photos or credentials echoed', async () => {
  const f = fixture(), res = await f.invoke(); assert.equal(res.status, 200); assert.equal(res.headers.get('Cache-Control'), 'no-store');
  const result = await res.json(); assert.equal(result.scope, 'order-photo'); assert.equal(result.pages[0].words[0].text, 'CGST1-95MM-0401');
  assert.equal(JSON.stringify(result).includes(PHOTO), false); assert.equal(JSON.stringify(result).includes('synthetic-google'), false);
  assert.equal((await f.invoke()).status, 429);
  assert.equal((await fixture({ identity: 'unexpected@example.test' }).invoke()).status, 503);
});
test('photo requests are capped, not automatically retried, and upstream errors stay private', async () => {
  const f = fixture(); for (let i=0; i<100; i++) { assert.equal((await f.invoke()).status, 200); f.advance(); }
  assert.equal((await f.invoke()).status, 429); assert.equal(f.calls.filter(c => c.url.includes('vision.googleapis')).length, 100);
  const failure = fixture({ status: 500 }); const res = await failure.invoke();
  assert.deepEqual(await res.json(), { error: 'PHOTO_READING_UNAVAILABLE' }); assert.equal(failure.calls.filter(c=>c.url.includes('vision.googleapis')).length, 1);
  assert.throws(() => photoResult({ responses: [{ error: { message: 'private' } }] }));
  assert.equal(photoResult({ responses: [{}] }).pages[0].text, '');
});
async function listen(t, server) {
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  return `http://127.0.0.1:${server.address().port}`;
}
test('HTTP photo route has its own size limit; original routing limits remain intact', async t => {
  let calls=0;
  const base=await listen(t,createPreviewServer({ photoHandler: async req => { calls++; assert.ok((await req.text()).length>32768); return Response.json({scope:'order-photo'}); } }));
  assert.equal((await fetch(base+'/read-order-photo',{method:'POST',body:'x'.repeat(40000)})).status,200);
  assert.equal((await fetch(base+'/plan-trip',{method:'POST',body:'x'.repeat(40000)})).status,413);
  assert.equal((await http(base+'/read-order-photo',{method:'POST',headers:{'Content-Length':'2800201'},body:''})).status,413); assert.equal(calls,1);
});
test('bridge OCR is separately disabled, fixes its target and retains app and operator authentication', async t => {
  const origin='https://18766-test.cs-us-west1-test.cloudshell.dev'; let calls=0;
  const options={origin,publishableKey:'sb_publishable_synthetic',getGoogleToken:async()=> 'synthetic-operator',fetchImpl:async(url,init)=>{
    calls++; assert.equal(url,'https://atlas-routing-preview-340839522237.us-central1.run.app/read-order-photo');
    assert.equal(init.headers.Authorization,'Bearer synthetic-user-access-token');
    assert.equal(init.headers['X-Serverless-Authorization'],'Bearer synthetic-operator');
    return Response.json({warehouse:'CA',scope:'order-photo',pages:[{text:'',words:[]}]});
  }};
  const headers={Host:'localhost:18766',Origin:origin,'Content-Type':'application/json','X-Atlas-Authorization':'Bearer synthetic-user-access-token'};
  const disabled=await listen(t,createPreviewBridge(options));
  assert.equal((await http(disabled+'/api/read-order-photo',{method:'POST',headers,body:JSON.stringify(payload())})).status,503); assert.equal(calls,0);
  const enabled=await listen(t,createPreviewBridge({...options,photoEnabled:true}));
  assert.equal((await http(enabled+'/api/read-order-photo',{method:'POST',headers,body:JSON.stringify(payload())})).status,200); assert.equal(calls,1);
});
test('browser photo client uses same-origin app auth; rejected or mismatched results never pass', async () => {
  const session={user:{id:USER},access_token:'synthetic-user-access-token'}; let calls=0;
  await requestPhoto({session,image:PHOTO,fetchImpl:async(url,init)=>{
    calls++; assert.equal(url,'/api/read-order-photo'); assert.equal(init.credentials,'same-origin');
    assert.equal(init.headers.Authorization,undefined); assert.equal(init.headers['X-Atlas-Authorization'],'Bearer synthetic-user-access-token');
    return Response.json({scope:'order-photo',warehouse:'CA',pages:[{text:'',words:[]}]});
  }}); assert.equal(calls,1);
  await assert.rejects(requestPhoto({session,image:PHOTO,fetchImpl:async()=>Response.json({error:'PHOTO_READING_DISABLED'},{status:503})}),/not connected/);
  await assert.rejects(requestPhoto({session,image:PHOTO,fetchImpl:async()=>Response.json({scope:'order-photo',warehouse:'TX',pages:[]})}),/Unexpected/);
});
