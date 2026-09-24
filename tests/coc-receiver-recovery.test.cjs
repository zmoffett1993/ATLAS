const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
const source = read('coc-receiver/receiver.js');
const extract = (start, end) => source.slice(source.indexOf(start), source.indexOf(end));

test('dashboard labels unfinished COCs Pending and retains Completed', () => {
  const declaration = read('atlas-dashboard.js').match(/const cocStatus = .*;/)[0];
  const status = vm.runInNewContext(declaration + ';cocStatus');
  for (const value of ['SENT', 'RECEIVED']) assert.equal(status({ status: value }), 'Pending');
  assert.equal(status({ status: 'OFFICE_COMPLETED' }), 'Completed');
});

test('receiver reports ready only after successful inbox sync, including recovery', () => {
  const strong = {}, small = {}, copy = {}, reset = {};
  const status = { classList: { toggle() {} }, querySelector: s => s === 'strong' ? strong : small };
  const context = { connection: 'connected', inboxLoaded: false, inboxFailed: false,
    lastSynced: null, time: String,
    root: { querySelector: s => s === '.receiver-status' ? status : s === '[data-receiver-ready-copy]' ? copy : reset } };
  vm.runInNewContext(extract('  function updateReceiverStatus()', '  function focusedReceiverControl()') + ';globalThis.update=updateReceiverStatus', context);
  for (const [loaded, failed, ready] of [[false,false,false],[true,false,true],[true,true,false],[true,false,true]]) {
    context.inboxLoaded = loaded; context.inboxFailed = failed; context.update();
    assert.equal(strong.textContent.includes('CONNECTED · READY'), ready);
    assert.equal(reset.hidden, ready);
    assert.equal(copy.textContent.includes('Connection not confirmed'), !ready);
  }
  context.connection = 'offline'; context.update();
  assert.match(strong.textContent, /OFFLINE/);
});

test('heartbeat cannot advance the last inbox sync time', async () => {
  const timestamp = new Date('2026-09-23T10:00:00Z');
  const context = { credentials: {}, receiverAuthState: 'paired', lastSynced: timestamp,
    Delivery: { heartbeat: async () => ({ at: '2026-09-23T11:00:00Z' }) },
    updateReceiverStatus() {}, loadInbox() {}, navigator: { onLine: true } };
  vm.runInNewContext(extract('  function syncReceiverConnection()', '  function connect()') + ';syncReceiverConnection()', context);
  await Promise.resolve();
  assert.equal(context.lastSynced, timestamp);
});

test('failed inbox request from previous account cannot mark current account as failed', async () => {
  let reject;
  const context = { credentials: {}, loadSequence: 0, loading: false, inboxFailed: false,
    resetReportingPeriodAtMidnight: () => false, inboxSignature: () => '',
    reportingPeriodBounds: () => ({ periodStart: 'today' }),
    Delivery: { receiverInbox: () => new Promise((resolve, fail) => { reject = fail; }) },
    loadReportList: async () => ({ deliveries: [] }) };
  vm.runInNewContext(extract('  async function loadInbox(', '  async function startPairing()') + ';globalThis.load=loadInbox', context);
  const pending = context.load();
  context.loadSequence++; context.loading = true;
  reject(new Error('old account disconnected')); await pending;
  assert.equal(context.inboxFailed, false);
  assert.equal(context.loading, true);
});
