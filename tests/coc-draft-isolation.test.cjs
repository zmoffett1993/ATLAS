const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Actual COC modules, synthetic browser storage, no network or real account data.
function boot(storage, user, overrides = {}) {
  const listeners = new Map();
  const elements = new Map();
  const timers = new Map();
  let timerId = 0;
  const context = {
    console, structuredClone, Blob,
    localStorage: {
      getItem: key => storage.get(key) ?? null,
      setItem: (key, value) => storage.set(key, String(value)),
      removeItem: key => storage.delete(key),
    },
    navigator: { onLine: false },
    document: {
      readyState: 'loading', visibilityState: 'hidden', addEventListener() {},
      documentElement: { classList: { toggle() {}, remove() {}, add() {} } },
      getElementById: id => elements.get(id) || null,
      querySelectorAll: () => [], querySelector: () => null,
      createElement: () => ({ innerHTML: '', querySelectorAll: () => [] }),
      body: { appendChild: element => elements.set(element.id, element) },
    },
    addEventListener(name, callback) {
      if (!listeners.has(name)) listeners.set(name, []);
      listeners.get(name).push(callback);
    },
    setInterval() {}, clearInterval() {},
    setTimeout(fn) { timers.set(++timerId, fn); return timerId; },
    clearTimeout(id) { timers.delete(id); },
    AtlasCocParser: {}, AtlasCocExcel: {}, AtlasCocStorage: {},
    AtlasCocCaseQuantities: { loadRemote() {} },
    AtlasCocDelivery: { currentUser: () => user, requestedWarehouseCode: () => user?.warehouse,
      getAuthSession: () => user ? { access_token: 'synthetic-only', user } : null },
    ...overrides,
  };
  context.window = context;
  vm.createContext(context);
  for (const file of ['atlas-coc-core.js', 'atlas-coc.js']) {
    let source = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
    if (file === 'atlas-coc.js') source = source.replace(/\}\)\(\);\s*$/, `
      window.audit = { restoreFromCloud, scheduleCloudSync, resetDraftContext, persist,
        rememberClosedDraft, flushClosedDrafts, sendCompletedCoc,
        setSession(value) { session = value; }, getKey: () => draftContextKey, getSendState: () => sendState };
    })();`);
    vm.runInContext(source, context, { filename: file });
  }
  return { context, timers, setUser: value => { user = value; }, emit: (name, detail) => {
    for (const listener of listeners.get(name) || []) listener({ detail });
  } };
}

function caDraft() {
  return boot(new Map(), { id: 'synthetic-ca', warehouse: 'CA' }).context.AtlasCocCore.createSession({
    customerName: 'SYNTHETIC AUDIT', salesOrderNumber: 'AUDIT-ONLY',
    employee: 'synthetic-ca', warehouseCode: 'CA', deviceId: 'synthetic-device',
  });
}

test('TX account cannot restore the previous CA account active draft', () => {
  const storage = new Map([['atlas-coc-active-v1', JSON.stringify(caDraft())]]);
  const { context } = boot(storage, { id: 'synthetic-tx', warehouse: 'TX' });
  assert.equal(context.atlasCoc.getState(), null, 'Previous account draft must not become current account state');
});

test('sign-out releases active COC state without deleting the saved draft', () => {
  const snapshot = caDraft();
  const key = 'atlas-coc-active-v2:synthetic-ca:CA';
  const storage = new Map([[key, JSON.stringify({ ownerUserId: 'synthetic-ca', warehouseCode: 'CA', snapshot })]]);
  const { context, emit, setUser } = boot(storage, { id: 'synthetic-ca', warehouse: 'CA' });
  assert.equal(context.atlasCoc.getState().id, snapshot.id);
  setUser(null);
  emit('atlas-auth-changed', { session: null });
  assert.equal(context.atlasCoc.getState(), null, 'Signed-out session must not retain account draft');
  assert.ok(storage.get(key), 'Sign-out must preserve the owned draft');
});

test('legacy drafts are preserved unchanged, never silently adopted', () => {
  const raw = JSON.stringify(caDraft());
  const storage = new Map([['atlas-coc-active-v1', raw]]);
  const { context } = boot(storage, { id: 'synthetic-ca', warehouse: 'CA' });
  assert.equal(context.atlasCoc.getState(), null);
  assert.equal(storage.get('atlas-coc-active-v1'), raw);
});

test('same user restores only the selected warehouse; switching back restores CA', () => {
  const snapshot = caDraft();
  const storage = new Map([['atlas-coc-active-v2:admin:CA', JSON.stringify({ ownerUserId: 'admin', warehouseCode: 'CA', snapshot })]]);
  const f = boot(storage, { id: 'admin', warehouse: 'CA' });
  assert.equal(f.context.atlasCoc.getState().id, snapshot.id);
  f.setUser({ id: 'admin', warehouse: 'TX' }); f.context.audit.resetDraftContext();
  assert.equal(f.context.atlasCoc.getState(), null);
  f.setUser({ id: 'admin', warehouse: 'CA' }); f.context.audit.resetDraftContext();
  assert.equal(f.context.atlasCoc.getState().id, snapshot.id);
});

test('misplaced owner or warehouse envelope cannot restore', () => {
  for (const [ownerUserId, warehouseCode] of [['other', 'CA'], ['synthetic-ca', 'TX']]) {
    const storage = new Map([['atlas-coc-active-v2:synthetic-ca:CA', JSON.stringify({ ownerUserId, warehouseCode, snapshot: caDraft() })]]);
    assert.equal(boot(storage, { id: 'synthetic-ca', warehouse: 'CA' }).context.atlasCoc.getState(), null);
  }
});

test('late cloud restore cannot replace the next account state, including switching back', async () => {
  let resolve;
  const pending = new Promise(done => { resolve = done; });
  const f = boot(new Map(), { id: 'synthetic-ca', warehouse: 'CA' }, {
    navigator: { onLine: true }, atlasSupabaseConfig: { url: 'https://synthetic.invalid', key: 'fixture' },
    fetch: () => pending,
  });
  const restore = f.context.audit.restoreFromCloud();
  f.setUser(null); f.context.audit.resetDraftContext();
  f.setUser({ id: 'synthetic-ca', warehouse: 'CA' }); f.context.audit.resetDraftContext();
  resolve({ ok: true, text: async () => JSON.stringify({ ...caDraft(), ownerUserId: 'synthetic-ca' }) });
  await restore;
  assert.equal(f.context.atlasCoc.getState(), null);
});

test('queued save is canceled on sign-out and never sent using another account', async () => {
  let calls = 0;
  const f = boot(new Map(), { id: 'synthetic-ca', warehouse: 'CA' }, { fetch: () => { calls++; } });
  f.context.audit.setSession(caDraft());
  f.context.audit.scheduleCloudSync();
  const queued = [...f.timers.values()];
  f.setUser({ id: 'synthetic-tx', warehouse: 'TX' }); f.context.audit.resetDraftContext();
  for (const fn of queued) await fn();
  assert.equal(calls, 0);
});

test('offline owned draft survives reload with exact reference strings and warehouse', () => {
  const storage = new Map();
  const user = { id: 'synthetic-ca', warehouse: 'CA' };
  const f = boot(storage, user);
  const snapshot = caDraft();
  snapshot.invoiceNumber = '000123-A';
  f.context.audit.setSession(snapshot);
  assert.equal(f.context.audit.persist({ cloud: false }), true);
  const restored = boot(storage, user).context.atlasCoc.getState();
  assert.equal(restored.id, snapshot.id);
  assert.equal(restored.invoiceNumber, '000123-A');
  assert.equal(restored.warehouseCode, 'CA');
  assert.equal(boot(storage, { id: 'other-ca', warehouse: 'CA' }).context.atlasCoc.getState(), null);
});

test('cloud restore accepts only the signed-in owner and selected warehouse', async () => {
  for (const [ownerUserId, warehouseCode, accepted] of [
    ['synthetic-ca', 'CA', true], ['other', 'CA', false], ['synthetic-ca', 'TX', false],
  ]) {
    const f = boot(new Map(), { id: 'synthetic-ca', warehouse: 'CA' }, {
      navigator: { onLine: true }, atlasSupabaseConfig: { url: 'https://synthetic.invalid', key: 'fixture' },
      fetch: async () => ({ ok: true, text: async () => JSON.stringify({ ...caDraft(), ownerUserId, warehouseCode }) }),
    });
    await f.context.audit.restoreFromCloud();
    assert.equal(Boolean(f.context.atlasCoc.getState()), accepted);
  }
});

test('closed marker survives failed cloud close and suppresses local draft resurrection', async () => {
  const storage = new Map();
  const user = { id: 'synthetic-ca', warehouse: 'CA' };
  const f = boot(storage, user, {
    navigator: { onLine: true }, atlasSupabaseConfig: { url: 'https://synthetic.invalid', key: 'fixture' },
    fetch: async () => { throw new Error('simulated offline'); },
  });
  const snapshot = caDraft();
  f.context.audit.setSession(snapshot); f.context.audit.persist({ cloud: false });
  f.context.audit.rememberClosedDraft(snapshot);
  await assert.rejects(f.context.audit.flushClosedDrafts(), /simulated offline/);
  assert.equal(boot(storage, user).context.atlasCoc.getState(), null);
  const key = 'atlas-coc-active-v2:synthetic-ca:CA:closed';
  assert.equal(JSON.parse(storage.get(key))[0].pending, true);
  const recovered = boot(storage, user, {
    navigator: { onLine: true }, atlasSupabaseConfig: { url: 'https://synthetic.invalid', key: 'fixture' },
    fetch: async () => ({ ok: true, text: async () => '' }),
  });
  await recovered.context.audit.flushClosedDrafts();
  assert.equal(JSON.parse(storage.get(key))[0].pending, false);
});

test('account switch during workbook generation cannot submit the previous report', async () => {
  let resolve; let writes = 0;
  const generation = new Promise(done => { resolve = done; });
  const f = boot(new Map(), { id: 'synthetic-ca', warehouse: 'CA' }, {
    AtlasCocExcel: { generateCompanyCoc: () => generation },
    AtlasCocStorage: { upsertCompleted: () => { writes++; } },
  });
  f.context.AtlasCocDelivery.stationNameForWarehouse = code => code;
  const snapshot = caDraft(); snapshot.status = 'report';
  f.context.audit.setSession(snapshot);
  const sending = f.context.audit.sendCompletedCoc();
  f.setUser({ id: 'synthetic-tx', warehouse: 'TX' }); f.context.audit.resetDraftContext();
  resolve({ bytes: new Uint8Array(), fileName: 'synthetic.xlsx' });
  await sending;
  assert.equal(writes, 0);
});

for(const status of ['RECEIVED','OFFICE_COMPLETED'])test('accepted '+status+' retry preserves server state in UI and saved history',async()=>{
 const saved=[];
 const f=boot(new Map(),{id:'synthetic-ca',warehouse:'CA'}, {
  AtlasCocExcel:{generateCompanyCoc:async()=>({bytes:new Uint8Array(1),fileName:'synthetic.xlsx'})},
  AtlasCocStorage:{upsertCompleted:async value=>saved.push(value),putPending:async()=>{},deletePending:async()=>{}},
 });
 Object.assign(f.context.AtlasCocDelivery,{
  stationNameForWarehouse:code=>code,stationKeyForWarehouse:code=>code,
  submitCoc:async()=>({deliveryId:'synthetic',status,sentAt:'2026-09-20',receivedAt:'2026-09-20',officeCompletedAt:status==='OFFICE_COMPLETED'?'2026-09-20':null}),
 });
 const snapshot=caDraft();snapshot.status='report';f.context.audit.setSession(snapshot);
 await f.context.audit.sendCompletedCoc();
 assert.equal(saved.at(-1).officeTransferStatus,status);
 assert.equal(f.context.audit.getSendState().phase,status==='RECEIVED'?'received':'office_completed');
 assert.equal(f.context.atlasCoc.getState(),null);
});
