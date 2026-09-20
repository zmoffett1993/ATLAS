const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '..', 'atlas-coc-delivery.js'), 'utf8');
function fixture() {
  let user = { id: 'synthetic-ca', app_metadata: { home_warehouse_code: 'CA' } };
  let validSession;
  let response;
  const calls = [];
  const events = {};
  const session = () => user ? { user, access_token: 'synthetic-' + user.id } : null;
  const window = {
    localStorage: { getItem: () => null },
    atlasSupabaseConfig: { url: 'https://fixture.invalid', key: 'fixture-only' },
    AtlasAuth: { getSession: session, getValidSession: () => validSession || Promise.resolve(session()) },
    addEventListener: (name, listener) => { events[name] = listener; },
  };
  vm.runInNewContext(source, { window, btoa, Uint8Array, fetch: async (url, options) => {
    calls.push({ url, body: JSON.parse(options.body) });
    return response || { ok: true, json: async () => ({ selectedWarehouse: { code: 'CA' } }) };
  } });
  return { api: window.AtlasCocDelivery, calls,
    setUser(value) { user = value; events['atlas-auth-changed']?.(); },
    setValidSession(value) { validSession = value; },
    setResponse(value) { response = value; }, session,
  };
}

test('account switch during token refresh cannot send the old request as the new account', async () => {
  const f = fixture(); let resolve;
  f.setValidSession(new Promise(done => { resolve = done; }));
  const request = f.api.warehouseContext();
  f.setUser({ id: 'synthetic-tx', app_metadata: { home_warehouse_code: 'TX' } });
  resolve(f.session());
  await assert.rejects(request, /ATLAS_AUTH_REQUIRED/);
  assert.equal(f.calls.length, 0);
});

test('late warehouse context from the previous account is rejected', async () => {
  const f = fixture(); let resolve;
  f.setResponse(new Promise(done => { resolve = done; }));
  const request = f.api.warehouseContext();
  await Promise.resolve(); await Promise.resolve();
  f.setUser(null);
  f.setUser({ id: 'synthetic-ca', app_metadata: { home_warehouse_code: 'CA' } });
  resolve({ ok: true, json: async () => ({ selectedWarehouse: { code: 'CA' } }) });
  await assert.rejects(request, /ATLAS_AUTH_REQUIRED/);
});

test('same-account token event preserves a valid warehouse request', async () => {
  const f = fixture();
  f.setUser(f.session().user);
  assert.equal((await f.api.warehouseContext()).selectedWarehouse.code, 'CA');
});

for(const status of ['SENT','RECEIVED','OFFICE_COMPLETED','WAREHOUSE_COMPLETE']){
 test('submission retry handles server state '+status,async()=>{
  const f=fixture();await f.api.warehouseContext();
  f.setResponse({ok:true,json:async()=>({deliveryId:'synthetic-delivery',status})});
  // The test exercises the actual submitCoc response contract; fake bytes are not uploaded.
  const input={cocId:'synthetic',idempotencyKey:'synthetic',snapshot:{warehouseCode:'CA'},workbookBytes:new Uint8Array(),workbookFileName:'synthetic.xlsx'};
  const result=f.api.submitCoc(input);
  if(status==='WAREHOUSE_COMPLETE')await assert.rejects(result,/COC_SEND_NOT_CONFIRMED/);
  else assert.equal((await result).status,status);
 });
}
