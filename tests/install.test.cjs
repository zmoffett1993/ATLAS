const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require('node:path').join(__dirname, '../install/install.js'), 'utf8');
function fixture(options = {}) {
  const elements = {}, events = {}, calls = [];
  const element = id => elements[id] ||= { hidden: false, textContent: '', addEventListener(name, fn) { this[name] = fn; } };
  const navigator = { userAgent: options.ua || 'Android', platform: options.platform || '', maxTouchPoints: options.touch || 0, onLine: true,
    serviceWorker: { getRegistration: async scope => { calls.push(['lookup', scope]); return options.existing ? { scope, update: async () => calls.push(['update']) } : undefined; },
      register: async (...args) => calls.push(['register', ...args]) } };
  vm.runInNewContext(source, { document: { getElementById: element }, navigator, URL,
    window: { isSecureContext: true, location: { href: 'https://zmoffett1993.github.io/ATLAS/install/' },
      matchMedia: () => ({ matches: !!options.installed, addEventListener() {} }), addEventListener: (name, fn) => events[name] = fn } });
  return { element, events, calls, navigator };
}
test('iPhone and touch iPad receive manual Safari instructions without an unavailable install button', () => {
  for (const options of [{ ua: 'iPhone' }, { ua: 'Macintosh', platform: 'MacIntel', touch: 5 }]) {
    const f = fixture(options); assert.equal(f.element('iphone').hidden, false); assert.equal(f.element('install-button').hidden, true);
    f.events.beforeinstallprompt({ preventDefault() {} }); assert.equal(f.element('install-button').hidden, true);
  }
});
for (const outcome of ['accepted', 'dismissed', 'error']) test('install prompt is used only once: ' + outcome, async () => {
  const f = fixture(); let prompts = 0;
  assert.equal(f.element('install-button').hidden, true);
  f.events.beforeinstallprompt({ preventDefault() {}, prompt: async () => { prompts++; if (outcome === 'error') throw Error('unavailable'); }, userChoice: Promise.resolve({ outcome }) });
  assert.equal(f.element('install-button').hidden, false);
  await Promise.all([f.element('install-button').click(), f.element('install-button').click()]);
  assert.equal(prompts, 1); assert.equal(f.element('install-button').hidden, true); assert.ok(f.element('install-status').textContent);
});
test('installed and offline states remain useful without accessing account data', () => {
  const f = fixture({ installed: true }); assert.equal(f.element('device-heading').textContent, 'ATLAS is installed');
  assert.equal(f.element('open-app').textContent, 'Open ATLAS');
  f.navigator.onLine = false; f.events.offline(); assert.equal(f.element('offline-note').hidden, false);
  const fresh = fixture(); fresh.events.appinstalled(); assert.equal(fresh.element('device-heading').textContent, 'ATLAS is installed');
});
test('copy link shares only the universal URL and provides a fallback when clipboard access fails', async () => {
  const f = fixture(); let copied;
  f.navigator.clipboard = { writeText: async value => copied = value };
  await f.element('copy-link').click();
  assert.equal(copied, 'https://zmoffett1993.github.io/ATLAS/install/');
  assert.equal(f.element('copy-status').textContent, 'Link copied.');
  f.navigator.clipboard.writeText = async () => { throw Error('denied'); };
  await f.element('copy-link').click();
  assert.match(f.element('copy-status').textContent, /Press and hold/);
});
test('install preserves an existing root worker or registers the shared module at the ATLAS scope', async () => {
  for (const existing of [true, false]) {
    const f = fixture({ existing }); await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.calls[0][1], 'https://zmoffett1993.github.io/ATLAS/');
    assert.equal(f.calls[1][0], existing ? 'update' : 'register');
    if (!existing) { assert.equal(f.calls[1][1], '../atlas-routing-worker.mjs?v=281'); assert.equal(f.calls[1][2].type, 'module'); }
  }
});
test('offline installation navigation uses its public page, while main and Receiver keep their own fallbacks', async () => {
  const worker = fs.readFileSync(require('node:path').join(__dirname, '../service-worker.js'), 'utf8');
  const events = {};
  vm.runInNewContext(worker, { URL, Response,
    self: { location: { origin: 'https://fixture.invalid' }, addEventListener: (name, fn) => events[name] = fn },
    caches: { open: async () => ({ match: async () => undefined }), match: async path => new Response(path) },
    fetch: async () => { throw Error('offline'); } });
  for (const [path, expected] of [['install/', './install/index.html'], ['coc-receiver/', './coc-receiver/index.html'], ['', './index.html']]) {
    let response;
    events.fetch({ request: { url: 'https://fixture.invalid/ATLAS/' + path, method: 'GET', mode: 'navigate' }, respondWith: value => response = value });
    assert.equal(await (await response).text(), expected);
  }
});
