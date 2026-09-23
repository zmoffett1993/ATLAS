const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const { stripTypeScriptTypes } = require('node:module');
const JSZip = require('../atlas-jszip.min.js');
const root = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

function backend(options = {}) {
  let handler;
  const calls = [];
  const delivery = { id: 'delivery', station_id: 'ca-station', status: 'RECEIVED',
    workbook_object_path: 'ca/test.xlsx', report_snapshot: { warehouseCode: 'CA' } };
  const candidate = { id: 'draft', delivery_id: 'delivery', warehouse_code: 'CA',
    status: 'PENDING', parsed_workbook: options.headers || {} };
  const db = {
    from(table) {
      const filters = [];
      const query = {
        select() { return query; }, eq(key, value) { filters.push([key, value]); return query; },
        order() { return query; }, limit() { return query; },
        async single() {
          calls.push({ table, filters });
          return { data: table === 'coc_deliveries' ? delivery : candidate };
        },
        async maybeSingle() { return { data: null }; },
      };
      return query;
    },
    async rpc() { calls.push('approve'); throw new Error('approval reached'); },
  };
  const user = { id: 'office-user', app_metadata: { role: options.role || 'admin' } };
  const context = {
    JSZip, Request, Response, Uint8Array, TextEncoder, crypto: require('node:crypto').webcrypto,
    atob, console: { error() {} },
    Deno: { env: { get: key => key === 'SUPABASE_URL' ? 'https://synthetic.invalid' : 'synthetic-only' }, serve: fn => { handler = fn; } },
    createClient: () => ({ ...db, auth: { getUser: async () => ({ data: { user } }) } }),
    stationForWarehouse: async (actor, code) => {
      if (code === 'TX' && options.role !== 'admin') throw Object.assign(new Error('WAREHOUSE_ACCESS_DENIED'), { status: 403 });
      return { context: { selectedWarehouse: { code: code || 'CA' } }, station: { id: 'ca-station' } };
    },
  };
  const source = read('supabase/functions/coc-workbook-revisions/index.ts').replace(/^import .*;\r?\n/gm, '');
  vm.runInNewContext(stripTypeScriptTypes(source) + ';globalThis.parse = parseWorkbook;', context);
  return { calls, parse: context.parse, request: body => handler(new Request('https://synthetic.invalid', {
    method: 'POST', headers: { Authorization: 'Bearer synthetic-only' }, body: JSON.stringify({ deliveryId: 'delivery', ...body }),
  })) };
}

// Deliberately synthetic workbook: never read or alter the official master.
async function workbook(invoice = '', fulfillment = '') {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', '<Types/>');
  zip.file('xl/workbook.xml', '<workbook><sheet name="Sheet1"/></workbook>');
  zip.file('xl/styles.xml', '<styleSheet/>');
  const cell = (r, text) => `<c r="${r}" t="inlineStr"><is><t>${text}</t></is></c>`;
  zip.file('xl/worksheets/sheet1.xml', '<worksheet><sheetData><row>' +
    cell('B2', 'SYNTHETIC CUSTOMER') + cell('B3', invoice) + cell('B4', fulfillment) +
    cell('A7', 'TEST-SKU') + cell('B7', '000123-A') + cell('C7', '10') +
    '</row></sheetData><mergeCells><mergeCell ref="A1:C1"/><mergeCell ref="A5:C5"/><mergeCell ref="C3:C4"/></mergeCells></worksheet>');
  return zip.generateAsync({ type: 'uint8array' });
}

test('pending workbook accepts missing references; final workbook requires both and preserves exact lot', async () => {
  const { parse } = backend();
  const bytes = await workbook();
  const pending = await parse(bytes, true);
  assert.equal(pending.cells.B7, '000123-A');
  await assert.rejects(parse(bytes), /HEADER_FIELDS_REQUIRED/);
  await assert.rejects(parse(await workbook('INV-1')), /HEADER_FIELDS_REQUIRED/);
  assert.equal((await parse(await workbook('INV-1', 'IF-1'))).invoiceNumber, 'INV-1');
});

test('office and administrator can resume a pending COC; warehouse workers cannot edit', async () => {
  for (const role of ['office', 'office_receiver', 'supervisor', 'admin', 'administrator']) {
    const f = backend({ role });
    const response = await f.request({ action: 'pending-revision', warehouseCode: 'CA' });
    assert.equal(response.status, 200, role);
    assert.ok(f.calls[0].filters.some(([key, value]) => key === 'station_id' && value === 'ca-station'));
  }
  assert.equal((await backend({ role: 'warehouse' }).request({ action: 'save-pending' })).status, 403);
  assert.equal((await backend({ role: 'office' }).request({ action: 'pending-revision', warehouseCode: 'TX' })).status, 403);
});

test('an incomplete saved revision cannot call the approval RPC', async () => {
  const f = backend({ headers: { customerName: 'TEST', invoiceNumber: 'INV-1', ifNumber: '' } });
  assert.equal((await f.request({ action: 'approve-revision', revisionId: 'draft' })).status, 400);
  assert.ok(!f.calls.includes('approve'));
  const complete = backend({ headers: { customerName: 'TEST', invoiceNumber: 'INV-1', ifNumber: 'IF-1' } });
  await complete.request({ action: 'approve-revision', revisionId: 'draft' });
  assert.ok(complete.calls.includes('approve'));
});

test('receiver pending validation permits only missing references, not incomplete pallet data', () => {
  const source = read('coc-receiver/receiver.js');
  const fn = source.slice(source.indexOf('  function nativeWorkbookData('), source.indexOf('  async function loadPendingWorkbook('));
  const editor = { customerName: 'TEST', invoiceNumber: '', ifNumber: '',
    lines: [{ model: 'TEST-BK', lot: '000123-A', quantity: 10, palletNumber: 1 }] };
  const context = { revisionState: { editor }, completeSkuRecord: model => model === 'TEST-BK' ? { modelNumber: model } : null };
  vm.runInNewContext(fn + ';globalThis.data = nativeWorkbookData;', context);
  assert.throws(() => context.data(), /HEADER_FIELDS_REQUIRED/);
  assert.equal(context.data({ allowPending: true }).pallets[0].modelBlocks[0].lots[0].cleanLot, '000123-A');
  editor.lines[0].quantity = 0;
  assert.throws(() => context.data({ allowPending: true }), /LINE_INVALID/);
});

test('server finalization refuses missing references or an unreviewed saved revision', async () => {
  const source = read('supabase/functions/coc-receiver/index.ts');
  const block = source.slice(source.indexOf('  if(action==="mark-completed"){'), source.indexOf('  throw Object.assign(new Error("COC_ACTION_NOT_SUPPORTED")'));
  async function run(snapshot, pending = []) {
    let writes = 0;
    const db = { from(table) {
      const q = { select: () => q, eq: () => q, limit: () => Promise.resolve({ data: pending }),
        single: async () => ({ data: { status: 'RECEIVED', report_snapshot: snapshot } }),
        update() { writes++; throw new Error('write reached'); } };
      return q;
    } };
    const context = { action: 'mark-completed', db, body: { deliveryId: 'test' }, device: { station_id: 'ca' }, user: { id: 'office' } };
    await assert.rejects(vm.runInNewContext('(async()=>{' + block + '})()', context), /COC_FINAL_REFERENCES_REQUIRED|COC_PENDING_REVISION_REQUIRES_REVIEW/);
    assert.equal(writes, 0);
  }
  await run({ invoiceNumber: '', ifNumber: 'IF-1' });
  await run({ invoiceNumber: 'INV-1', ifNumber: 'IF-1' }, [{ id: 'draft' }]);
});

test('Save as Pending returns to inbox only after a successful server save, with no download', async () => {
  const source = read('coc-receiver/receiver.js');
  const fn = source.slice(source.indexOf('  async function stageNativeRevision('), source.indexOf('  async function approveRevision('));
  for (const fails of [false, true]) {
    let returned = false, action;
    const errorNode = {}, submit = {};
    const context = {
      selected: { id: 'delivery' }, receiverAccountId: 'office', revisionState: {},
      branchCode: () => 'CA', syncNativeEditor() {}, render() {},
      nativeWorkbookData: options => { assert.equal(options.allowPending, true); return { customerName: 'TEST', invoiceNumber: '', ifNumber: '' }; },
      loadWorkbook: async () => ({ blob: new Blob(['synthetic']) }), Uint8Array,
      blobToBase64: async () => 'synthetic-only',
      window: { AtlasCocExcel: { populateOfficialTemplate: async () => new Uint8Array([1]), outputFileName: () => 'test.xlsx', renderOfficialWorkbookPreview: async () => '' } },
      Delivery: { cocWorkbookRevision: async (value, payload, warehouse) => {
        action = value; assert.equal(warehouse, 'CA'); assert.equal(payload.deliveryId, 'delivery');
        if (fails) throw new Error('offline'); return { candidate: { id: 'draft' } };
      } },
      returnPendingToInbox: () => { returned = true; },
      revisionError: error => error.message,
    };
    vm.runInNewContext(fn + ';globalThis.save = stageNativeRevision;', context);
    await context.save({ querySelector: selector => selector === '[data-revision-error]' ? errorNode : submit }, { savePending: true });
    assert.equal(action, 'save-pending');
    assert.equal(returned, !fails);
    if (fails) assert.equal(context.revisionState.error, 'offline');
  }
});
