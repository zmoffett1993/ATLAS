import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { request } from "node:http";
import { createPreviewServer } from "../cloud-run/atlas-routing-preview/server.mjs";
import { createRoutingHandler } from "../supabase/functions/atlas-routing-preview/handler.mjs";

test("planner HTTP route uses its dedicated protected handler and never the legacy handler", async (t) => {
  let calls = 0;
  const server = createPreviewServer({ handler: () => { throw new Error("Legacy should not run"); }, plannerHandler: async (req) => {
    calls++; assert.equal(new URL(req.url).pathname, "/plan-trip");
    assert.equal(req.headers.get("authorization"), "Bearer synthetic-only");
    return Response.json({ scope: "daily-planner-trip" });
  } });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await fetch(`${base}/plan-trip`, { method: "POST", headers: { Authorization: "Bearer synthetic-only" }, body: "{}" })).status, 200);
  assert.equal((await fetch(`${base}/plan-trip?elsewhere=true`, { method: "POST", body: "{}" })).status, 404);
  assert.equal(calls, 1);
});

async function listening(t, handler) {
  const server = createPreviewServer({ handler });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }));
  return `http://127.0.0.1:${server.address().port}`;
}
test("real HTTP server: liveness reveals no config; disabled routing does no network work", async (t) => {
  const handler = createRoutingHandler({ env: () => undefined, fetchImpl: () => { throw new Error("Unexpected external call"); } });
  const base = await listening(t, handler);
  for (const path of ["/health", "/healthz"]) {
    const health = await fetch(`${base}${path}`);
    assert.equal(health.status, 200);
    assert.equal(health.headers.get("Cache-Control"), "no-store");
    assert.deepEqual(await health.json(), { status: "ok" });
  }
  const denied = await fetch(`${base}/optimize-trip`, { method: "POST", headers: {
    Origin: "http://localhost:18766", "Content-Type": "application/json",
  }, body: "{}" });
  assert.equal(denied.status, 503); assert.equal(denied.headers.get("Cache-Control"), "no-store");
  assert.equal((await denied.json()).error, "PREVIEW_DISABLED");
});
test("real HTTP adapter preserves user auth and CORS without forwarding arbitrary headers", async (t) => {
  const base = await listening(t, async (req) => {
    assert.equal(req.headers.get("authorization"), "Bearer test-user-token");
    assert.equal(req.headers.get("x-private-header"), null);
    assert.deepEqual(await req.json(), { warehouse: "CA" });
    return new Response(JSON.stringify({ ok: true }), { headers: {
      "Content-Type": "application/json", "Cache-Control": "no-store", "Access-Control-Allow-Origin": req.headers.get("origin"),
    } });
  });
  const response = await fetch(`${base}/optimize-trip`, { method: "POST", headers: {
    Authorization: "Bearer test-user-token", Origin: "http://localhost:18766", "x-private-header": "should-not-forward",
  }, body: JSON.stringify({ warehouse: "CA" }) });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Access-Control-Allow-Origin"), "http://localhost:18766");
  assert.deepEqual(await response.json(), { ok: true });
});
test("unsupported paths, query strings, methods and encodings never invoke routing", async (t) => {
  let called = false;
  const base = await listening(t, async () => { called = true; return new Response("bad"); });
  assert.equal((await fetch(`${base}/optimize-trip?key=do-not-log`)).status, 404);
  assert.equal((await fetch(`${base}/optimize-trip`)).status, 405);
  assert.equal((await fetch(`${base}/optimize-trip`, { method: "POST", headers: { "Content-Encoding": "gzip" }, body: "x" })).status, 415);
  assert.equal(called, false);
});
test("declared and chunked oversized uploads are rejected before routing", async (t) => {
  let calls = 0;
  const base = await listening(t, async () => { calls++; return new Response("bad"); });
  const declared = await fetch(`${base}/optimize-trip`, { method: "POST", body: "x".repeat(33000) });
  assert.equal(declared.status, 413);
  const chunkedStatus = await new Promise((resolve, reject) => {
    const req = request(`${base}/optimize-trip`, { method: "POST", headers: { "Transfer-Encoding": "chunked" } }, (res) => {
      res.resume(); res.on("end", () => resolve(res.statusCode));
    });
    req.on("error", reject); req.write("x".repeat(20000)); req.end("x".repeat(20000));
  });
  assert.equal(chunkedStatus, 413); assert.equal(calls, 0);
});
test("preflight passes through while HTTP handler failures stay sanitized", async (t) => {
  const base = await listening(t, createRoutingHandler({ env: () => undefined }));
  const result = await fetch(`${base}/optimize-trip`, { method: "OPTIONS", headers: { Origin: "http://localhost:18766" } });
  assert.equal(result.status, 204);
  const broken = await listening(t, () => { throw new Error("must-not-expose"); });
  const failure = await fetch(`${broken}/optimize-trip`, { method: "POST", body: "{}" });
  assert.equal(failure.status, 502); assert.equal((await failure.text()).includes("must-not-expose"), false);
});
