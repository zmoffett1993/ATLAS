import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { request } from "node:http";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { createPreviewBridge } from "../tools/routing-preview/bridge.mjs";
import { sampleTrip, requestTrip, checkPreviewConnection } from "../tools/routing-preview/preview.mjs";
const ORIGIN = "https://18766-test.cs-us-west1-test.cloudshell.dev";
const TOKEN = "synthetic-atlas-access-token-for-test";
const CONFIG = { origin: ORIGIN, publishableKey: "sb_publishable_synthetic_test_only" };
test("combined preview serves and packages the login helper required by current ATLAS auth", async (t) => {
  const f = await fixture(t);
  const html = await (await f.invoke("/", { method: "GET", body: undefined })).text();
  assert.match(html, /<script\b[^>]*src="\/atlas-login\.js"[^>]*defer[^>]*><\/script>/);
  assert.ok(html.indexOf('/atlas-login.js') < html.indexOf('/preview.mjs'));
  const response = await f.invoke("/atlas-login.js", { method: "GET", body: undefined });
  assert.equal(response.status, 200);
  const window = {};
  vm.runInNewContext(await response.text(), { window });
  assert.equal(window.AtlasLogin.identity('CA COC Receiver').key, 'cacocreceiver');
  for (const name of ['Dockerfile', 'Dockerfile.dockerignore', 'upload.ignore']) {
    assert.match(readFileSync(new URL('../cloud-run/atlas-routing-app/' + name, import.meta.url), 'utf8'), /atlas-login\.js/);
  }
  assert.equal(f.tokenCalls(), 0);
  assert.equal(f.calls.length, 0);
});
const http = (url, options) => new Promise((resolve, reject) => {
  const req = request(url, options, (res) => {
    const chunks = []; res.on("data", (chunk) => chunks.push(chunk));
    res.on("end", () => resolve(new Response(Buffer.concat(chunks), { status: res.statusCode, headers: res.headers })));
  });
  req.on("error", reject); req.end(options.body);
});
async function fixture(t, options = {}) {
  const calls = []; let tokenCalls = 0, clock = 0;
  const server = createPreviewBridge({ ...CONFIG, now: () => clock,
    getGoogleToken: async () => { tokenCalls++; return "synthetic-google-identity-token"; },
    fetchImpl: async (url, options) => { calls.push({ url, options }); return Response.json({ preview: true, scope: "single-truck-trip", warehouse: "CA", wholeDayValidated: false, visits: [], skippedStopIndices: [] }); }, ...options });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }));
  return { calls, tokenCalls: () => tokenCalls, advance: () => { clock += 31000; },
    invoke: (path = "/api/optimize-trip", overrides = {}) => http(`http://127.0.0.1:${server.address().port}${path}`, {
      method: "POST", headers: { Host: new URL(ORIGIN).host, Origin: ORIGIN, "X-Atlas-Authorization": `Bearer ${TOKEN}`, "Content-Type": "application/json" }, body: JSON.stringify(sampleTrip(new Date("2026-09-19T20:00:00Z"))), ...overrides,
    }),
  };
}
test("private preview rejects incorrect host, cross-origin and missing ATLAS credentials before Google", async (t) => {
  const f = await fixture(t);
  for (const [headers, status] of [[{ Host: "evil.example", Origin: ORIGIN }, 403], [{ Host: new URL(ORIGIN).host, Origin: "https://evil.example" }, 403], [{ Host: new URL(ORIGIN).host }, 403], [{ Host: new URL(ORIGIN).host, Origin: ORIGIN }, 401]]) {
    assert.equal((await f.invoke(undefined, { headers })).status, status);
  }
  assert.equal(f.tokenCalls(), 0); assert.equal(f.calls.length, 0);
});
test("private preview only serves allowlisted files; no config files or arbitrary proxy paths", async (t) => {
  const f = await fixture(t);
  for (const path of ["/.routing-preview-config.json", "/AGENTS.md", "/.git/config", "/supabase/config.toml", "/api/optimize-trip?url=https://evil.example"]) {
    assert.equal((await f.invoke(path, { method: "GET", body: undefined })).status, 404);
  }
  const config = await f.invoke("/runtime-config.json", { method: "GET", body: undefined });
  assert.equal(config.headers.get("Cache-Control"), "no-store");
  assert.equal((await config.json()).key, CONFIG.publishableKey);
  assert.equal(f.tokenCalls(), 0);
});

test("saved-day activation is explicit and disabled by default; its module is allowlisted", async (t) => {
  for (const [storageEnabled, expected] of [[undefined, false], ["true", false], [true, true]]) {
    const f = await fixture(t, { storageEnabled });
    const config = await f.invoke("/runtime-config.json", { method: "GET", body: undefined });
    assert.equal((await config.json()).storageEnabled, expected);
    const source = await f.invoke("/atlas-routing-storage.js", { method: "GET", body: undefined });
    assert.equal(source.status, 200); assert.match(source.headers.get("Content-Type"), /javascript/);
    assert.equal(f.calls.length, 0);
  }
});

test("trip sheets can load the existing Chubby Gorilla logo without backend requests", async (t) => {
  const f = await fixture(t);
  const logo = await f.invoke("/chubby-gorilla-header-v2.png", { method: "GET", body: undefined });
  assert.equal(logo.status, 200);
  assert.equal(logo.headers.get("Content-Type"), "image/png");
  assert.deepEqual([...new Uint8Array(await logo.arrayBuffer()).slice(0, 8)], [137,80,78,71,13,10,26,10]);
  assert.equal(f.calls.length, 0); assert.equal(f.tokenCalls(), 0);
});

test("reminder controls are served without enabling push or exposing worker/sender internals", async (t) => {
  const f = await fixture(t);
  const response = await f.invoke("/atlas-routing-notifications.js", { method: "GET", body: undefined });
  assert.equal(response.status, 200);
  const config = await f.invoke("/runtime-config.json", { method: "GET", body: undefined });
  assert.equal((await config.json()).notificationsEnabled, undefined);
  for (const path of ["/notification-worker.mjs", "/notification-dispatcher.mjs", "/api/notifications"]) {
    assert.equal((await f.invoke(path, { method: "GET", body: undefined })).status, 404);
  }
  assert.equal(f.calls.length, 0);
});

test("Google sign-in may navigate to the static entry page without opening cross-site data or API access", async (t) => {
  const f = await fixture(t);
  const headers = { Host: new URL(ORIGIN).host, "Sec-Fetch-Site": "cross-site", "Sec-Fetch-Mode": "navigate", "Sec-Fetch-Dest": "document" };
  const navigation = { method: "GET", body: undefined, headers };
  const entry = await f.invoke("/?authuser=0", navigation);
  assert.equal(entry.status, 200);
  assert.match(entry.headers.get("Content-Type"), /text\/html/);
  assert.equal(entry.headers.get("Cache-Control"), "no-store");
  assert.equal(entry.headers.get("Access-Control-Allow-Origin"), null);
  for (const path of ["/runtime-config.json", "/api/optimize-trip", "/preview.mjs", "/.git/config"]) {
    assert.equal((await f.invoke(path, navigation)).status, 403);
  }
  for (const overrides of [
    { ...headers, "Sec-Fetch-Mode": "cors", "Sec-Fetch-Dest": "empty" },
    { ...headers, "Sec-Fetch-Dest": "iframe" },
    { ...headers, Origin: "https://evil.example" },
    { ...headers, Origin: "null" },
    { ...headers, Host: "evil.example" },
  ]) assert.equal((await f.invoke("/", { ...navigation, headers: overrides })).status, 403);
  assert.equal((await f.invoke("/", { headers })).status, 403);
  assert.equal((await f.invoke(undefined, { headers: { ...headers, Origin: ORIGIN, "X-Atlas-Authorization": `Bearer ${TOKEN}`, "Content-Type": "application/json" } })).status, 403);
  assert.equal(f.tokenCalls(), 0); assert.equal(f.calls.length, 0);
});
test("private preview preserves ATLAS bearer and adds a separate Google identity without forwarding cookies", async (t) => {
  const f = await fixture(t);
  const response = await f.invoke(undefined, { headers: { Host: new URL(ORIGIN).host, Origin: ORIGIN, "X-Atlas-Authorization": `Bearer ${TOKEN}`, "Content-Type": "application/json", Cookie: "private-cookie", "X-Serverless-Authorization": "attacker-value" } });
  assert.equal(response.status, 200);
  const { url, options } = f.calls[0];
  assert.equal(url, "https://atlas-routing-preview-340839522237.us-central1.run.app/optimize-trip");
  assert.equal(options.headers.Authorization, `Bearer ${TOKEN}`);
  assert.equal(options.headers["X-Atlas-Authorization"], undefined);
  assert.equal(options.headers["X-Serverless-Authorization"], "Bearer synthetic-google-identity-token");
  assert.equal(options.headers.Origin, "http://localhost:18766");
  assert.equal(options.headers.Cookie, undefined); assert.equal(options.redirect, "error");
  assert.equal((await response.text()).includes("token"), false);
});
test("private preview rejects TX and oversized requests; caps attempts without retries", async (t) => {
  const f = await fixture(t);
  assert.equal((await f.invoke(undefined, { body: JSON.stringify({ action: "optimizeTrip", warehouse: "TX" }) })).status, 400);
  assert.equal((await f.invoke(undefined, { body: "x".repeat(33000) })).status, 413);
  assert.equal(f.tokenCalls(), 0);
  assert.equal((await f.invoke()).status, 200);
  assert.equal((await f.invoke()).status, 429);
  for (let i = 0; i < 4; i++) { f.advance(); assert.equal((await f.invoke()).status, 200); }
  f.advance(); assert.equal((await f.invoke()).status, 429);
  assert.equal(f.calls.length, 5);
});
test("private preview sanitizes token-provider and upstream failures", async (t) => {
  const f = await fixture(t, { getGoogleToken: async () => { throw new Error("private-credential-must-not-leak"); } });
  const response = await f.invoke(); assert.equal(response.status, 502);
  assert.deepEqual(await response.json(), { error: "PREVIEW_UNAVAILABLE" });
  const g = await fixture(t, { fetchImpl: async () => Response.json({ error: "private-credential-must-not-leak" }, { status: 503 }) });
  assert.deepEqual(await (await g.invoke()).json(), { error: "PREVIEW_UNAVAILABLE" });
});
test("sample trip uses tomorrow in Pacific time across DST, with no customer information", () => {
  assert.equal(sampleTrip(new Date("2026-03-07T20:00:00Z")).departure, "2026-03-08T06:30:00-07:00");
  assert.equal(sampleTrip(new Date("2026-10-31T20:00:00Z")).departure, "2026-11-01T06:30:00-08:00");
  const trip = sampleTrip(new Date("2026-09-20T03:00:00Z"));
  assert.equal(trip.departure, "2026-09-20T06:30:00-07:00");
  assert.deepEqual(Object.keys(trip.stops[0]), ["location", "pallets", "serviceMinutes"]);
});
test("private preview cannot expose a service-role key through browser configuration", () => {
  const jwt = (role) => `synthetic.${Buffer.from(JSON.stringify({ role, ref: "dwrrbpiprcmajfyronlf" })).toString("base64url")}.test`;
  assert.throws(() => createPreviewBridge({ ...CONFIG, browserKey: jwt("service_role") }), /Only existing anon/);
  assert.throws(() => createPreviewBridge({ ...CONFIG, browserKey: "sb_secret_invalid" }), /Invalid browser/);
  assert.doesNotThrow(() => createPreviewBridge({ ...CONFIG, browserKey: jwt("anon") }));
});
test("browser connector requires sign-in, uses only same-origin proxy, and never retries", async () => {
  let count = 0;
  const fetchImpl = async (url, options) => { count++; assert.equal(url, "/api/optimize-trip"); assert.equal(options.credentials, "same-origin"); assert.equal(options.headers["X-Atlas-Authorization"], `Bearer ${TOKEN}`); assert.equal(options.headers.Authorization, undefined); return Response.json({ error: "GOOGLE_QUOTA_REACHED" }, { status: 429 }); };
  await assert.rejects(requestTrip({ session: null, payload: {}, fetchImpl }), /Sign into ATLAS/);
  assert.equal(count, 0);
  await assert.rejects(requestTrip({ session: { user: { id: "test" }, access_token: TOKEN }, payload: {}, fetchImpl }), /quota/);
  assert.equal(count, 1);
});

test("connection diagnostics isolate proxy headers without real credentials or routing calls", async (t) => {
  const f = await fixture(t);
  let calls = 0;
  const message = await checkPreviewConnection(async (url, options) => {
    calls++; assert.equal(url, "/api/optimize-trip"); assert.equal(options.body, "null");
    assert.equal(options.redirect, "error"); assert.equal(options.credentials, "same-origin");
    return f.invoke(url, { ...options, headers: { ...options.headers, Host: new URL(ORIGIN).host, Origin: ORIGIN } });
  });
  assert.equal(calls, 3); assert.equal(message, "No bearer: HTTP 401 · Standard bearer: HTTP 401 · App header: HTTP 400");
  assert.equal(f.tokenCalls(), 0); assert.equal(f.calls.length, 0);
  const failure = await checkPreviewConnection(async () => { throw new Error("private network detail"); });
  assert.equal(failure.includes("private network detail"), false);
});

test("standard bearer alone cannot authorize the bridge; app bearer remains subject to origin checks", async (t) => {
  const f = await fixture(t);
  assert.equal((await f.invoke(undefined, { headers: { Host: new URL(ORIGIN).host, Origin: ORIGIN, Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" } })).status, 401);
  assert.equal((await f.invoke(undefined, { headers: { Host: new URL(ORIGIN).host, Origin: "https://evil.example", "X-Atlas-Authorization": `Bearer ${TOKEN}`, "Content-Type": "application/json" } })).status, 403);
  assert.equal(f.tokenCalls(), 0); assert.equal(f.calls.length, 0);
});

test("browser network errors offer a safe diagnostic message and do not retry", async () => {
  let calls = 0;
  await assert.rejects(requestTrip({ session: { user: { id: "test" }, access_token: TOKEN }, payload: {}, fetchImpl: async () => { calls++; throw new TypeError("Failed to fetch private detail"); } }), /Check your connection/);
  assert.equal(calls, 1);
});

test("daily planner bridge accepts only its fixed action and backend with the same auth boundary", async (t) => {
  const f = await fixture(t, { fetchImpl: async (url, options) => {
    assert.equal(url, "https://atlas-routing-preview-340839522237.us-central1.run.app/plan-trip");
    assert.equal(options.headers.Authorization, `Bearer ${TOKEN}`);
    return Response.json({ scope: "daily-planner-trip", warehouse: "CA", wholeDayValidated: false });
  } });
  assert.equal((await f.invoke("/api/plan-trip")).status, 400);
  assert.equal((await f.invoke("/api/plan-trip", { body: JSON.stringify({ action: "planTrip", warehouse: "CA" }) })).status, 200);
  assert.equal((await f.invoke("/api/plan-trip?target=elsewhere")).status, 404);
});
test("Maps CSP keeps scripts nonce-bound without permitting inline code or eval; config stays uncached", async (t) => {
  const f = await fixture(t); const a = await f.invoke("/", { method: "GET", body: undefined });
  const csp = a.headers.get("Content-Security-Policy"), html = await a.text();
  assert.match(csp, /maps\.googleapis\.com/); assert.doesNotMatch(csp, /unsafe-inline|unsafe-eval/);
  const nonce = csp.match(/'nonce-([^']+)'/)[1]; assert.ok(html.includes(`nonce="${nonce}"`));
  const b = await f.invoke("/", { method: "GET", body: undefined }); assert.notEqual(b.headers.get("Content-Security-Policy"), csp);
});
