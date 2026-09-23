const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const source = fs.readFileSync(require('node:path').join(__dirname, '../atlas-coc.js'), 'utf8');
const review = source.slice(source.indexOf('  function reviewCompleteModal()'), source.indexOf('  function mismatchModal()'));
function render(status, verified, hasWork = true) {
  const pallet = { id: 'test-pallet', number: 1, status: status === 'report' ? 'locked' : 'active', lots: hasWork ? [{ model: 'TEST-SKU', lot: '000123' }] : [] };
  const context = {
    session: { status, pallets: [pallet] }, activePallet: () => pallet,
    Core: { palletProgress: () => ({ verified, expected: hasWork ? 1 : 0 }), palletTotal: () => hasWork ? 1 : 0, displayLot: x => x },
    escapeHtml: x => String(x), plural: (n, word) => `${n} ${word}`,
    lotQuantityReviewMarkup: () => '<span>1 box</span>',
    modalShell: (html, options) => ({ html, options }),
  };
  return vm.runInNewContext(`${review}; reviewCompleteModal()`, context);
}
test('pre-completion review has one Accept action and retains pallet validation', () => {
  const ready = render('active', true);
  assert.match(ready.html, /<h2>Final Review<\/h2>/);
  assert.doesNotMatch(ready.html, /atlas-coc-eyebrow|view-draft-official/);
  assert.match(ready.html, /data-coc-action="complete-coc" >Accept COC/);
  assert.equal(ready.options.label, 'Final Review');
  assert.equal(ready.options.backAction, 'coc-back');
  for (const state of [render('active', false), render('active', false, false)]) {
    assert.match(state.html, /data-coc-action="complete-coc" disabled/);
  }
});
test('completed review retains close semantics and original lot display', () => {
  const completed = render('report', true);
  assert.match(completed.html, /Review completed COC/);
  assert.match(completed.html, /data-coc-action="close-modal">Complete COC/);
  assert.doesNotMatch(completed.html, /Accept COC|view-draft-official/);
  assert.match(completed.html, /000123/);
  assert.equal(completed.options.label, 'Completed COC review');
  assert.equal(completed.options.backAction, 'back-to-verified-pallet');
});
