const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Actual COC modules, synthetic browser storage, no network or real account data.
function boot(storage, user, overrides = {}) {
  const listeners = new Map();
  const documentListeners = new Map();
  const elements = new Map();
  const timers = new Map();
  let timerId = 0;
  const context = {
    console, structuredClone, Blob,
    FormData: class { constructor(form) { this.values = form.values; } get(key) { return this.values[key]; } },
    localStorage: {
      getItem: key => storage.get(key) ?? null,
      setItem: (key, value) => storage.set(key, String(value)),
      removeItem: key => storage.delete(key),
    },
    navigator: { onLine: false },
    document: {
      readyState: 'loading', visibilityState: 'hidden',
      addEventListener(name, callback) {
        if (!documentListeners.has(name)) documentListeners.set(name, []);
        documentListeners.get(name).push(callback);
      },
      documentElement: { classList: { toggle() {}, remove() {}, add() {} } },
      getElementById: id => elements.get(id) || null,
      querySelectorAll: () => [], querySelector: () => null,
      createElement: () => ({ innerHTML: '', querySelectorAll: () => [], setAttribute() {},
        classList: { add() {}, remove() {} } }),
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
    AtlasAuth: { getSession: () => user ? { access_token: 'synthetic-only', user } : null },
    AtlasCocDelivery: { currentUser: () => user, requestedWarehouseCode: () => user?.warehouse,
      getAuthSession: () => user ? { access_token: 'synthetic-only', user } : null },
    ...overrides,
  };
  context.window = context;
  vm.createContext(context);
  const deliveryOverrides = context.AtlasCocDelivery;
  for (const file of ['atlas-coc-delivery.js', 'atlas-coc-core.js', 'atlas-coc.js']) {
    let source = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
    if (file === 'atlas-coc.js') source = source.replace(/\}\)\(\);\s*$/, `
      window.audit = { restoreFromCloud, scheduleCloudSync, resetDraftContext, persist,
        rememberClosedDraft, flushClosedDrafts, sendCompletedCoc, navigateWorkflows, getView:()=>workflowView, getModal:()=>modal,
        handleAction, landingMarkup, modalMarkup, expectedCountMarkup, boxCountError,
        setSession(value) { session = value; }, getKey: () => draftContextKey, getSendState: () => sendState };
    })();`);
    vm.runInContext(source, context, { filename: file });
    if (file === 'atlas-coc-delivery.js') context.AtlasCocDelivery = { ...context.AtlasCocDelivery, ...deliveryOverrides };
  }
  return { context, timers, elements, documentListeners, setUser: value => { user = value; }, emit: (name, detail) => {
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

const LEGACY = 'atlas-coc-active-v1';
const supervisor = (role = 'supervisor') => ({ id: 'synthetic-ca', warehouse: 'CA', app_metadata: { role } });
const click = (f, action) => f.context.audit.handleAction({ dataset: { cocAction: action } });
function legacyFixture(raw = JSON.stringify(caDraft()), user = supervisor()) {
  const storage = new Map([
    [LEGACY, raw],
    ['atlas-coc-active-v2:synthetic-ca:CA', JSON.stringify({ ownerUserId: 'synthetic-ca', warehouseCode: 'CA', snapshot: caDraft() })],
    ['atlas-coc-active-v2:synthetic-tx:TX', 'synthetic-TX-data'],
    ['atlas-coc-active-v2:synthetic-ca:CA:closed', '[]'],
    ['office-coc-receiver-credentials:OFFICE_COC_01', 'synthetic-pairing'],
    ['atlas-coc-device-id-v1', 'synthetic-device'],
    ['atlas-selected-warehouse-v1', 'CA'],
    ['sb-synthetic-auth-token', 'synthetic-session'],
    ['unrelated-key', 'preserve-byte-for-byte'],
  ]);
  const before = new Map(storage);
  const completed = [{ cocId: 'synthetic-completed', workbook: 'untouched' }];
  const f = boot(storage, user, {
    // Any call into completed COC / IndexedDB persistence would fail this fixture.
    AtlasCocStorage: new Proxy({}, { get() { assert.fail('Legacy cleanup must not touch completed COC storage'); } }),
    fetch() { assert.fail('Legacy cleanup must not call the network'); },
  });
  f.elements.set('atlas-coc-workflows-root', { innerHTML: '' });
  f.context.atlasCoc.openWorkflows();
  return { ...f, storage, before, completed };
}

test('picker and editable-metadata admin cannot review or delete; normal landing remains usable', async () => {
  for (const user of [null, { id: 'picker', warehouse: 'CA', user_metadata: { role: 'admin' } }]) {
    const f = legacyFixture(undefined, user);
    const landing = f.context.audit.landingMarkup();
    assert.match(landing, /An older COC draft is preserved/);
    assert.doesNotMatch(landing, /Review Old Draft/);
    assert.match(landing, /Start COC/);
    assert.match(landing, /COMPLETED COCs/);
    for (const action of ['review-old-draft', 'review-delete-old-draft', 'confirm-delete-old-draft']) await click(f, action);
    assert.equal(f.context.audit.modalMarkup(), '');
    assert.deepEqual(f.storage, f.before);
    assert.equal(f.context.atlasCoc.getState(), null);
    if (user) {
      await click(f, 'start-setup');
      assert.match(f.elements.get('atlas-coc-workflows-root').innerHTML, /atlas-coc-start-form/);
    }
  }
});

test('trusted supervisor/admin roles review safely; Keep Draft cancels either step unchanged', async () => {
  for (const role of ['supervisor', 'admin', 'administrator']) {
    const f = legacyFixture(undefined, supervisor(role));
    assert.match(f.context.audit.landingMarkup(), /Review Old Draft/);
    await click(f, 'review-old-draft');
    assert.match(f.context.audit.modalMarkup(), /Review saved draft/);
    assert.match(f.context.audit.modalMarkup(), /review-delete-old-draft/);
    assert.doesNotMatch(f.context.audit.modalMarkup(), /confirm-delete-old-draft|review-discard|Resume|Upload/);
    await click(f, 'close-modal');
    assert.equal(f.context.audit.modalMarkup(), '');
    assert.deepEqual(f.storage, f.before);
    await click(f, 'review-old-draft');
    await click(f, 'review-delete-old-draft');
    assert.match(f.context.audit.modalMarkup(), /Delete this older draft\?/);
    await click(f, 'close-modal');
    assert.deepEqual(f.storage, f.before);
    assert.match(f.context.audit.landingMarkup(), /older COC draft/);
  }
});

test('review escapes allowlisted summary fields and never renders credentials or raw JSON', async () => {
  const draft = caDraft();
  Object.assign(draft, { customerName: '<img src=x onerror=alert(1)>', salesOrderNumber: 'SO-0001<&',
    employeeDisplayName: '<script>bad()</script>', updatedAt: '2026-09-22T12:00:00Z',
    access_token: 'PRIVATE-FIXTURE-MUST-NOT-RENDER', arbitrary: 'UNLISTED-FIXTURE' });
  const f = legacyFixture(JSON.stringify(draft));
  await click(f, 'review-old-draft');
  const html = f.context.audit.modalMarkup();
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.match(html, /SO-0001&lt;&amp;/);
  assert.match(html, /&lt;script&gt;bad\(\)&lt;\/script&gt;/);
  assert.match(html, /Warehouse:<\/strong> CA/);
  assert.match(html, /Pallet count:<\/strong> 1/);
  assert.match(html, /Recorded box count:<\/strong> 0/);
  assert.doesNotMatch(html, /<img|<script|PRIVATE-FIXTURE|UNLISTED-FIXTURE|atlas-coc-active/);
  assert.deepEqual(f.storage, f.before);
});

test('invalid, empty and unsanitizable legacy values remain stored and reviewable', async () => {
  for (const raw of ['{invalid JSON', '', 'null', '{"pallets":[{"lots":[{"lot":""}]}]}']) {
    const f = legacyFixture(raw);
    assert.match(f.context.audit.landingMarkup(), /Review Old Draft/);
    await click(f, 'review-old-draft');
    assert.match(f.context.audit.modalMarkup(), /Draft details are unavailable. The original data is still stored on this device./);
    await click(f, 'close-modal');
    assert.deepEqual(f.storage, f.before);
  }
});

test('only second-step deletion removes the exact legacy key; owned drafts and device state survive reload', async () => {
  const f = legacyFixture();
  const snapshot = f.context.atlasCoc.getState();
  const removed = [];
  f.context.localStorage.removeItem = key => { removed.push(key); f.storage.delete(key); };
  await click(f, 'confirm-delete-old-draft');
  await click(f, 'review-old-draft');
  await click(f, 'confirm-delete-old-draft');
  assert.deepEqual(f.storage, f.before, 'Cannot skip confirmation');
  await click(f, 'review-old-draft');
  await click(f, 'review-delete-old-draft');
  assert.deepEqual(f.storage, f.before, 'Opening confirmation is read-only');
  await click(f, 'confirm-delete-old-draft');
  const expected = new Map(f.before); expected.delete(LEGACY);
  assert.deepEqual(removed, [LEGACY]);
  assert.deepEqual(f.storage, expected);
  assert.deepEqual(f.context.atlasCoc.getState(), snapshot);
  assert.deepEqual(f.completed, [{ cocId: 'synthetic-completed', workbook: 'untouched' }]);
  assert.equal(f.context.audit.modalMarkup(), '');
  assert.doesNotMatch(f.elements.get('atlas-coc-workflows-root').innerHTML, /older COC draft|Review Old Draft/);
  assert.equal(f.elements.get('atlas-coc-toast').textContent, 'Older draft removed from this device');
  const reload = boot(f.storage, supervisor());
  assert.doesNotMatch(reload.context.audit.landingMarkup(), /older COC draft/);
  assert.deepEqual(JSON.parse(JSON.stringify(reload.context.atlasCoc.getState())), JSON.parse(JSON.stringify(snapshot)));
});

test('throwing or ineffective deletion preserves warning and never reports success', async () => {
  for (const remove of [() => { throw new Error('storage denied'); }, () => {}]) {
    const f = legacyFixture();
    f.context.localStorage.removeItem = remove;
    await click(f, 'review-old-draft');
    await click(f, 'review-delete-old-draft');
    await click(f, 'confirm-delete-old-draft');
    assert.deepEqual(f.storage, f.before);
    assert.match(f.context.audit.landingMarkup(), /older COC draft/);
    assert.equal(f.elements.get('atlas-coc-toast').textContent, 'The older draft could not be removed. No COC data was changed.');
  }
});

test('sign-out, account, warehouse and role changes or expired sessions block both destructive steps', async () => {
  const changes = [
    f => f.setUser(null),
    f => f.setUser({ ...supervisor(), id: 'another-admin' }),
    f => f.setUser({ ...supervisor(), warehouse: 'TX' }),
    f => f.setUser({ ...supervisor('picker'), user_metadata: { role: 'admin' } }),
    f => { f.context.AtlasCocDelivery.getAuthSession = () => ({ user: supervisor(), access_token: 'expired-fixture', expires_at: 1 }); },
    f => { f.setUser(null); f.emit('atlas-auth-changed', { session: null }); f.setUser(supervisor()); f.emit('atlas-auth-changed', { session: {} }); },
  ];
  for (const change of changes) for (const stage of ['review', 'confirm']) {
    const f = legacyFixture();
    await click(f, 'review-old-draft');
    if (stage === 'confirm') await click(f, 'review-delete-old-draft');
    change(f);
    if (stage === 'review') await click(f, 'review-delete-old-draft');
    await click(f, 'confirm-delete-old-draft');
    assert.deepEqual(f.storage, f.before);
    assert.equal(f.context.audit.modalMarkup(), '');
  }
});

test('another tab replacing the reviewed draft requires a new review', async () => {
  const f = legacyFixture();
  await click(f, 'review-old-draft');
  await click(f, 'review-delete-old-draft');
  const replacement = JSON.stringify({ ...caDraft(), customerName: 'NEW SYNTHETIC DRAFT' });
  f.storage.set(LEGACY, replacement);
  await click(f, 'confirm-delete-old-draft');
  assert.equal(f.storage.get(LEGACY), replacement);
  assert.match(f.elements.get('atlas-coc-toast').textContent, /changed. Review it again/);
  await click(f, 'review-old-draft');
  f.emit('storage', undefined); // unrelated storage event cannot delete anything
  assert.equal(f.storage.get(LEGACY), replacement);
});

test('pallet setup labels, empty validation and other setup wording remain correctly scoped', () => {
  const f = boot(new Map(), supervisor());
  const Core = f.context.AtlasCocCore;
  for (const number of [1, 2, 3]) {
    const snapshot = caDraft(); snapshot.pallets[0].number = number;
    f.context.audit.setSession(snapshot);
    const html = f.context.audit.expectedCountMarkup(snapshot.pallets[0]);
    assert.ok(html.includes(`<strong>Boxes on Pallet ${number}${number === 1 ? ' or Loose Boxes' : ''}</strong>`));
    assert.match(html, /placeholder="Enter box count"/);
    assert.match(html, /maxlength="6"/);
    assert.ok(html.includes(`Set Up Pallet ${number}`));
    assert.ok(html.includes(`First Model on Pallet ${number}`));
    assert.ok(html.includes(`Start Pallet ${number}`));
    assert.match(html, /Enter the box count and first model on this pallet./);
    const error = { textContent: '' };
    const form = { id: 'atlas-coc-expected-form', values: { expectedBoxes: '' }, querySelector: () => error };
    for (const handler of f.documentListeners.get('submit')) handler({ target: form, preventDefault() {} });
    assert.equal(error.textContent, number === 1 ? 'Enter the Pallet 1 or loose-box count.' : `Enter the box count for Pallet ${number}.`);
    // Existing correction-dialog validation is outside the initial setup wording change.
    assert.equal(f.context.audit.boxCountError('', number), `Enter the total number of boxes on Pallet ${number}.`);
  }
  for (const [value, message] of [['0', 'Box count must be greater than 0.'], ['1.5', 'Enter a whole number of boxes.'], ['abc', 'Enter a whole number of boxes.']]) {
    assert.equal(f.context.audit.boxCountError(value, 1, true), message);
  }
  for (const count of [1, 2]) {
    let snapshot = Core.addModel(caDraft(), { modelNumber: 'SYNTHETIC-SKU', caseQuantity: 10 });
    f.context.audit.setSession(snapshot);
    const error = { textContent: '' };
    const form = { id: 'atlas-coc-expected-form', values: { expectedBoxes: String(count) }, querySelector: () => error };
    for (const handler of f.documentListeners.get('submit')) handler({ target: form, preventDefault() {} });
    snapshot = f.context.atlasCoc.getState();
    assert.equal(error.textContent, '');
    assert.equal(Core.activePallet(snapshot).expectedBoxes, count);
    snapshot = Core.addLot(snapshot, '000123-TEST').session;
    if (count === 2) snapshot = Core.addCase(snapshot);
    assert.equal(Core.sessionTotal(snapshot), count);
    assert.equal(Core.sessionUnitTotal(snapshot), count * 10);
    if (count === 2) assert.throws(() => Core.setExpectedBoxCount(snapshot, 1), /lower|BELOW/);
    snapshot = Core.verifyPallet(snapshot).session;
    assert.equal(Core.completeSession(snapshot).status, 'report');
  }
});

for(const status of ['report','active'])test('COC resumes '+status+' without a visible navigation button',async()=>{
 const snapshot=caDraft();snapshot.status=status; snapshot.invoiceNumber='INV-1';
 const f=boot(new Map(),{id:'synthetic-ca',warehouse:'CA'});f.context.audit.setSession(snapshot);
 let calls=0;f.context.scrollTo=()=>{};
 f.context.AtlasNavigation={openSection:async key=>{assert.equal(key,'workflows');calls++;f.elements.set('atlas-coc-workflows-root',{innerHTML:'',querySelectorAll:()=>[]});}};
 await f.context.audit.navigateWorkflows({resume:true});
 assert.equal(calls,1);assert.equal(f.context.audit.getView(),'session');assert.equal(f.context.atlasCoc.getState().invoiceNumber,'INV-1');
});
test('COC navigation failure and account change preserve saved data',async()=>{
 const f=boot(new Map(),{id:'synthetic-ca',warehouse:'CA'});const snapshot=caDraft();f.context.audit.setSession(snapshot);
 f.context.AtlasNavigation={openSection:async()=>{throw Error('timeout');}};
 await f.context.audit.navigateWorkflows({resume:true});assert.match(f.elements.get('atlas-coc-toast').textContent,/still saved/);assert.equal(f.context.atlasCoc.getState().id,snapshot.id);
 f.setUser({id:'other',warehouse:'CA'});let calls=0;f.context.AtlasNavigation.openSection=async()=>calls++;
 await f.context.audit.navigateWorkflows({resume:true});assert.equal(calls,0);
});
