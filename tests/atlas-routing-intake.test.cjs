const test = require('node:test');
const assert = require('node:assert/strict');
const { parsePage, combinePages, preparePhoto } = require('../atlas-routing-intake.js');
const { createPhotoQueue, quickReadingIssues, assessOrderReading } = require('../atlas-routing-intake.js');
const core = require('../atlas-routing-core.js');
const tick = () => new Promise(resolve => setImmediate(resolve));
const photo = name => ({ file: { type: 'image/jpeg', size: 100, name }, name });

test('capture advances before reading completes, groups pages, and never doubles quantities', async () => {
  let release, started = 0, accepted = [];
  const queue = createPhotoQueue({ read: async file => { if (++started === 1) await new Promise(resolve => { release = resolve; }); return document({ id: file.name === 'second' ? 'SO-US-98765' : undefined }); },
    accept: async job => { accepted.push(job.result); job.status = 'added'; } });
  const first = queue.add([photo('first')], { date: '2026-09-21' });
  queue.add([photo('invoice')], {}, first); queue.seal(first);
  const second = queue.add([photo('second')], { date: '2026-09-22' }); queue.seal(second);
  assert.equal(queue.jobs().length, 2); assert.equal(started, 1); assert.equal(accepted.length, 0);
  release(); await tick();
  assert.equal(accepted.length, 2); assert.equal(accepted[0].lines[0].caseQty, 100);
  assert.equal(accepted[1].orderNumber, 'SO-US-98765'); assert.equal(second.date, '2026-09-22');
});

test('unsealed readings are never added; failures preserve photos and let the next order proceed', async () => {
  const accepted = [], queue = createPhotoQueue({ read: async file => { if (file.name === 'bad') throw Error('Offline'); return document(); }, accept: async job => { accepted.push(job); job.status = 'added'; } });
  const bad = queue.add([photo('bad')], {}); queue.seal(bad);
  const good = queue.add([photo('good')], {}); await tick();
  assert.equal(bad.status, 'review'); assert.equal(bad.photos.length, 1); assert.equal(accepted.length, 0);
  queue.seal(good); await tick(); assert.equal(accepted.length, 1);
  assert.throws(() => queue.add([photo('extra')], {}, good), /queued/);
});

test('account reset aborts pending reading and discards late results', async () => {
  let release, signal, accepted = 0;
  const queue = createPhotoQueue({ read: async (_, value) => { signal = value; await new Promise(resolve => { release = resolve; }); return document(); }, accept: async () => accepted++ });
  const job = queue.add([photo('first')], {}); queue.seal(job);
  queue.reset(); assert.equal(signal.aborted, true); release(); await tick();
  assert.equal(accepted, 0); assert.equal(queue.jobs().length, 0);
});

test('capture is bounded and rejects oversized or non-image files before reading', () => {
  const queue = createPhotoQueue({ read: async () => document(), accept: async () => {} });
  assert.throws(() => queue.add([{ file: { type: 'text/plain', size: 1 } }], {}), /photos/);
  assert.throws(() => queue.add([{ file: { type: 'image/jpeg', size: 16 * 1024 * 1024 } }], {}), /photos/);
  assert.throws(() => queue.add(Array.from({ length: 21 }, () => photo('a')), {}), /batch/);
  queue.reset();
});

test('operational review requires known SKU and consistent box/unit counts; TBA remains load review', () => {
  const catalog = [{ model: 'CGST1-95MM', caseQty: 300, boxesPerPallet: 'TBA', caseDimensions: 'TBA' }], page = document();
  assert.deepEqual(quickReadingIssues(combinePages([page]), [page], catalog, core), []);
  assert.ok(quickReadingIssues(combinePages([page]), [page], [], core).length);
  for (const confidence of [0.7, undefined]) {
    const unclear = structuredClone(page); unclear.words[5].confidence = confidence;
    assert.ok(quickReadingIssues(combinePages([unclear]), [unclear], catalog, core).length);
  }
  const mismatch = document({ units: '20,000' });
  assert.ok(quickReadingIssues(combinePages([mismatch]), [mismatch], catalog, core).length);
  const conflict = [document(), document({ cases: '50' })];
  assert.ok(quickReadingIssues(combinePages(conflict), conflict, catalog, core).length);
});

const assessmentCatalog = [{ model: 'CGST1-95MM', caseQty: 300, boxesPerPallet: 20 }];
const assess = pages => assessOrderReading(combinePages(pages), pages, assessmentCatalog, core);
test('unclear unrelated notes and billing text do not block operational fields', () => {
  const page = document();
  page.words[0].confidence = .1;
  page.words.push({ text: 'unrelated', x: .1, y: .9, w: .12, h: .012 });
  const result = assess([page]);
  assert.equal(result.ready, true);
  assert.deepEqual(result.blockingIssues, []);
  assert.equal(result.fields.lines[0].sku.status, 'confirmed');
});
test('uncertain critical text flags only the field it supports', () => {
  for (const [text, field] of [['Test Receiver', 'customer'], ['123 Example Street', 'address'], ['Fullerton CA 92835', 'city'], ['8:00 AM - 3:00 PM', 'timeWindow'], ['SO-US-64939', 'orderNumber']]) {
    const page = document({ hours: '8:00 AM - 3:00 PM' });
    page.words.push({ text: 'SO-US-64939', x: .7, y: .05, w: .2, h: .012, confidence: .98 });
    page.words.find(w => w.text === text).confidence = .4;
    const result = assess([page]);
    assert.equal(result.fields[field].status, 'confirm_required', field);
    assert.equal(result.fields.lines[0].caseQty.status, 'confirmed');
    assert.equal(result.ready, false);
  }
  for (const [text, field] of [['CGST1-95MM-0401','sku'], ['100','caseQty']]) {
    const page = document(); page.words.find(w => w.text === text).confidence = undefined;
    const result = assess([page]);
    assert.equal(result.fields.lines[0][field].status, 'confirm_required');
    assert.equal(result.fields.customer.status, 'confirmed');
  }
});
test('complementary pages resolve missing fields without stale page-wide blocks', () => {
  const result = assess([document({ noCases: true }), document()]);
  assert.equal(result.ready, true);
  assert.equal(result.fields.lines[0].caseQty.value, 100);
  assert.equal(assess([document({ noCases: true })]).fields.lines[0].caseQty.status, 'missing');
});
test('genuine field conflicts and mixed orders remain blocking despite later agreement', () => {
  const result = assess([document(), document({ cases: '50' }), document()]);
  assert.equal(result.fields.lines[0].caseQty.status, 'conflicting');
  assert.deepEqual(result.fields.lines[0].caseQty.candidates, [100, 50]);
  const other = document(); other.words.find(w => w.text === '123 Example Street').text = '456 Other Street';
  assert.equal(assess([document(),other,document()]).fields.address.status, 'conflicting');
  assert.equal(assess([document(), document({ id: 'SO-US-99999' })]).ready, false);
});
test('repeated high-confidence evidence can confirm a weak reading but incomplete SKU suffix remains flagged', () => {
  const weak = document(); weak.words.find(w => w.text === '100').confidence = .3;
  assert.equal(assess([weak,document()]).fields.lines[0].caseQty.status, 'confirmed');
  const partial = document(); partial.words.find(w => w.text === 'CGST1-95MM-0401').text = 'CGST1-95MM-';
  partial.text = partial.text.replace('CGST1-95MM-0401','CGST1-95MM-');
  assert.equal(assess([partial]).fields.lines[0].sku.status, 'confirm_required');
});

function document(overrides = {}) {
  const words = [];
  const at = (text, x, y, w = .05) => words.push({ text, x, y, w, h: .012, confidence: .98 });
  at('Bill', .1, .20); at('To', .14, .20); at('Ship', .4, .20); at('To', .45, .20);
  at('Wrong Billing Customer', .1, .22, .22); at('Test Receiver', .4, .22, .16);
  at('999 Wrong Street', .1, .24, .22); at('123 Example Street', .4, .24, .2);
  at('Austin TX 78701', .1, .26, .20); at('Fullerton CA 92835', .4, .26, .2);
  if (overrides.hours) at(overrides.hours, .4, .28, .2);
  at('Pmt Method', .1, .32, .1); at('COD', .1, .34);
  at('Item', .1, .40); at('Item', .5, .40, .03); at('Qty', .535, .40, .03);
  at('Case', .63, .40, .03); at('Qty', .665, .40, .03);
  at('CGST1-95MM-0401', .1, .43, .2);
  if (!overrides.noUnits) at(overrides.units || '30,000', .508, .442, .04);
  if (!overrides.noCases) at(overrides.cases || '100', .648, .442, .03);
  if (overrides.repeat) { at('CGST1-95MM-0401', .1, .50, .2); at('30,000', .508, .50, .04); at('100', .648, .50, .03); }
  const text = `${overrides.id || 'SO-US-64939'}\n${words.map(w => w.text).join('\n')}\n${overrides.note || ''}`;
  return { words, text };
}

test('reads Ship To instead of Bill To; Case Qty is boxes and full color SKU is retained', () => {
  const result = parsePage(document());
  assert.equal(result.orderNumber, 'SO-US-64939'); assert.equal(result.customer, 'Test Receiver');
  assert.equal(result.address, '123 Example Street, Fullerton CA 92835'); assert.equal(result.city, 'Fullerton');
  assert.equal(result.timeWindow, ''); assert.equal(result.checkOnDelivery, false);
  assert.deepEqual(result.lines[0], { sku: 'CGST1-95MM-0401', caseQty: 100, itemQty: 30000, source: 1 });
});
test('only explicit CHECK ON DELIVERY sets collection; hours come from Ship To', () => {
  const result = parsePage(document({ note: 'CHECK\nON DELIVERY', hours: '8:00 AM - 3:00 PM' }));
  assert.equal(result.checkOnDelivery, true); assert.equal(result.timeWindow, '8:00 AM–3:00 PM');
  assert.equal(parsePage(document({ note: 'COD' })).checkOnDelivery, false);
});
test('never substitutes unit quantities for unreadable boxes', () => {
  const result = parsePage(document({ noCases: true }));
  assert.equal(result.lines[0].caseQty, null); assert.equal(result.lines[0].itemQty, 30000); assert.ok(result.issues.length);
});
test('sales order, invoice and packing list duplicates are counted once', () => {
  const result = combinePages([document(), document({ note: 'CHECK ON DELIVERY' }), document()]);
  assert.equal(result.lines.length, 1); assert.equal(result.lines[0].caseQty, 100); assert.equal(result.checkOnDelivery, true);
  assert.deepEqual(result.lines[0].sources, [1, 2, 3]);
});
test('conflicting counts and repeated SKU lines require manual complete-order quantities', () => {
  for (const pages of [[document(), document({ cases: '50' })], [document({ repeat: true })]]) {
    const result = combinePages(pages); assert.equal(result.lines[0].caseQty, null); assert.ok(result.issues.some(s => s.includes('conflicting')));
  }
});
test('missing readings are completed by another document without adding quantities, in either order', () => {
  for (const partial of [{ noCases: true }, { noUnits: true }, { noCases: true, noUnits: true }]) {
    for (const pages of [[document(partial), document()], [document(), document(partial)]]) {
      const result = combinePages(pages);
      assert.equal(result.lines.length, 1);
      assert.equal(result.lines[0].caseQty, 100);
      assert.equal(result.lines[0].itemQty, 30000);
      assert.equal(result.lines[0].uncertain, false);
      assert.deepEqual(result.lines[0].sources, [1, 2]);
    }
  }
});
test('complementary documents retain boxes and units while preserving photo review warnings', () => {
  const result = combinePages([document({ noCases: true }), document({ noUnits: true })]);
  assert.equal(result.lines[0].caseQty, 100); assert.equal(result.lines[0].itemQty, 30000);
  assert.ok(result.issues.some(s => s.includes('Photo 1:') && s.includes('Case Qty')));
});
test('unreadable boxes stay blank while known units remain available for review', () => {
  const result = combinePages([document({ noCases: true }), document({ noCases: true, noUnits: true })]);
  assert.equal(result.lines[0].caseQty, null); assert.equal(result.lines[0].itemQty, 30000);
  assert.equal(result.lines[0].uncertain, true);
});
test('later agreement or missing values never erase a real quantity conflict', () => {
  for (const conflict of [{ cases: '50' }, { units: '15,000' }]) {
    const pages = [document(), document(conflict), document({ noCases: true, noUnits: true }), document()];
    for (const order of [pages, [...pages].reverse()]) {
      const result = combinePages(order);
      assert.equal(result.lines[0].caseQty, null); assert.equal(result.lines[0].itemQty, null);
      assert.equal(result.lines[0].uncertain, true);
      assert.ok(result.issues.some(s => s.includes('conflicting')));
    }
  }
});
test('a repeated SKU on one photo cannot be resolved by an agreeing second photo', () => {
  for (const pages of [[document({ repeat: true }), document()], [document(), document({ repeat: true })]]) {
    const result = combinePages(pages);
    assert.equal(result.lines[0].caseQty, null); assert.equal(result.lines[0].itemQty, null);
  }
});
test('a notes-only invoice adds CHECK ON DELIVERY without removing recognized order lines', () => {
  const result = combinePages([document(), { text: 'Invoice\nSO-US-64939\nCHECK ON DELIVERY', words: [] }]);
  assert.equal(result.lines[0].caseQty, 100); assert.equal(result.checkOnDelivery, true);
  assert.equal(result.mixedOrders, false);
  const unrelated = combinePages([document(), { text: 'Invoice SO-US-12345 CHECK ON DELIVERY', words: [] }]);
  assert.equal(unrelated.mixedOrders, true); assert.deepEqual(unrelated.lines, []);
});
test('multiple order IDs prevent document merging; missing headers do not infer an address', () => {
  const result = combinePages([document(), document({ id: 'SO-US-99999' })]);
  assert.equal(result.mixedOrders, true); assert.deepEqual(result.lines, []); assert.equal(result.address, '');
  assert.equal(parsePage({ text: 'Bill To\n123 Wrong Street', words: [] }).address, '');
});
test('disagreeing addresses stay blank and low-confidence product text is flagged', () => {
  const a = document(), b = document(); b.words.find(w => w.text === '123 Example Street').text = '456 Other Street';
  assert.equal(combinePages([a, b]).address, '');
  a.words.find(w => w.text === '100').confidence = .3;
  assert.ok(parsePage(a).issues.some(s => s.includes('uncertain')));
});
module.exports = { document };
test('active SVG documents and oversized files are rejected before image decoding', async () => {
  for (const file of [{ type: 'image/svg+xml', size: 100 }, { type: 'image/jpeg', size: 16 * 1024 * 1024 }]) {
    await assert.rejects(preparePhoto(file), /photo smaller/);
  }
});
test('OCR-split hyphens rejoin the full printed SKU without borrowing quantity columns', () => {
  for (const split of [['CGST1-95MM', '-0401'], ['CGST1', '-', '95MM', '-', '0401']]) {
    const page = document(); page.words = page.words.filter(w => w.text !== 'CGST1-95MM-0401');
    let x = .1;
    for (const text of split) { const w = text.length * .008; page.words.push({ text, x, y: .43, w, h: .012, confidence: .98 }); x += w + .002; }
    const result = parsePage(page); assert.equal(result.lines[0].sku, 'CGST1-95MM-0401'); assert.equal(result.lines[0].caseQty, 100);
  }
});
test('skewed color suffix uses only an unambiguous full printed SKU; base quantities are retained', () => {
  const page = document(); page.words.find(w => w.text === 'CGST1-95MM-0401').text = 'CGST1-95MM';
  page.words.push({ text: '-', x: .303, y: .43, w: .005, h: .012 });
  assert.equal(parsePage(page).lines[0].sku, 'CGST1-95MM-0401');
  page.text += '\nCGST1-95MM-0502';
  const uncertain = parsePage(page); assert.equal(uncertain.lines[0].sku, 'CGST1-95MM');
  assert.equal(uncertain.lines[0].caseQty, 100); assert.ok(uncertain.issues.some(s => s.includes('color suffix')));
});

test('explicit invoice and Item Fulfillment numbers attach to one sales order without inferring unlabeled digits',()=>{
 const r=combinePages([document({note:'Invoice # INV-US-12345\nItem Fulfillment number IF-US-45678'}),document({note:'INV-US-12345\nIF-US-67890'})]);
 assert.deepEqual(r.invoiceNumbers,['INV-US-12345']);assert.deepEqual(r.fulfillmentNumbers,['IF-US-45678','IF-US-67890']);assert.equal(r.orderNumber,'SO-US-64939');
 const noIds=parsePage(document({note:'Invoice\nTotal 12345\nItem Fulfillment\nAmount 45678'}));assert.deepEqual(noIds.invoiceNumbers,[]);assert.deepEqual(noIds.fulfillmentNumbers,[]);
 const mixed=combinePages([document({note:'INV-US-12345'}),document({id:'SO-US-99999',note:'IF-US-67890'})]);assert.deepEqual(mixed.invoiceNumbers,[]);assert.deepEqual(mixed.fulfillmentNumbers,[]);
});


test('packing slip separates PO/hours from customer and uses shipped case column',()=>{
 const words=[];const at=(text,x,y,w=.09)=>words.push({text,x,y,w,h:.012,confidence:.99});
 at('Packing Slip',.7,.12,.2);at('IF-59709',.7,.16);at('Ship To',.1,.3);
 at('PO4128 "coc" rec.hrs 6am-2:30pm',.1,.32,.35);
 at('One Up Manufacturing',.1,.34,.3);at('550 EAST AIRLINE WAY',.1,.36,.3);at('GARDENA CA 90248',.1,.38,.25);
 at('Ship Via',.4,.45);at('SO-US-68159',.75,.47,.2);
 at('Item',.1,.52);at('Ordered',.4,.52);at('Back Ordered',.53,.52);
 at('Item',.7,.52,.04);at('Qty',.75,.52,.04);at('Case',.85,.52,.04);at('Qty',.90,.52,.04);
 at('Shipped',.70,.54);at('Shipped',.85,.54);
 at('CGUB1-60MLV3-BK',.1,.58,.25);at('60,000',.4,.58);at('0',.55,.58);at('60,000',.71,.58,.06);at('120',.89,.58,.035);
 const parsed=parsePage({words,text:words.map(w=>w.text).join('\n')});
 assert.equal(parsed.customer,'One Up Manufacturing');assert.equal(parsed.timeWindow,'6:00 AM–2:30 PM');
 assert.equal(parsed.orderNumber,'SO-US-68159');assert.equal(parsed.lines[0].caseQty,120);assert.equal(parsed.lines[0].itemQty,60000);
 assert.equal(parsed.packingSlip,'IF-59709');assert.equal(parsed.parserVersion,'packing-slip-v1');
 const cat=[{model:'CGUB1-60MLV3',caseQty:500,boxesPerPallet:35}];
 assert.equal(assessOrderReading(combinePages([{words,text:words.map(w=>w.text).join('\n')}]),[{words}],cat,core).ready,true);
});
test('receiving hours normalize compact and military forms without inventing ambiguous periods',()=>{
 const {normalizeHours}=require('../atlas-routing-intake.js');
 for(const value of ['6am-2:30pm','6 am to 2:30 pm','06:00-14:30','0600-1430'])assert.equal(normalizeHours(value),'6:00 AM–2:30 PM');
 assert.equal(normalizeHours('9-5'),'9-5');
});
