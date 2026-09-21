import test from "node:test";
import assert from "node:assert/strict";
import { buildPlannerTrip, summarizePlannerTrip } from "../cloud-run/atlas-routing-preview/trip-model.mjs";
import { createPlannerHandler } from "../cloud-run/atlas-routing-preview/planner-handler.mjs";
const USER = "11111111-1111-4111-8111-111111111111", OTHER = "22222222-2222-4222-8222-222222222222";
const NOW = Date.parse("2026-09-20T12:00:00Z"), depot = { latitude: 34, longitude: -118 };
const input = () => ({ action: "planTrip", warehouse: "CA", driver: "Bubba", vehicle: "truck", palletTarget: 12, preserveOrder: false,
  departure: "2026-09-21T06:30:00-07:00", returnBy: "2026-09-21T20:00:00-07:00",
  lunch: { start: "2026-09-21T12:00:00-07:00", end: "2026-09-21T13:00:00-07:00" },
  stops: [{ location: depot, pallets: 12, serviceMinutes: 25 }] });
function fixture(options = {}) {
  const calls = [], values = { K_SERVICE: "atlas-routing-preview", ATLAS_ROUTING_PREVIEW_ENABLED: "true", ATLAS_ROUTING_TESTER_IDS: USER,
    ATLAS_ROUTING_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_synthetic_only", ATLAS_ROUTING_CA_DEPOT_JSON: JSON.stringify(depot), ...options.env };
  const handler = createPlannerHandler({ env: (name) => values[name], now: () => NOW, fetchImpl: async (url, init) => {
    calls.push({ url, init }); assert.equal(init.redirect, "error");
    if (url.includes("supabase.co")) {
      assert.equal(init.method, undefined, "Only read-only caller-scoped checks are allowed");
      assert.equal(init.headers.Authorization, "Bearer synthetic-user-access-token");
      if (url.endsWith("/auth/v1/user")) return Response.json(options.user || { id: USER, app_metadata: { role: "admin" } });
      if (url.includes("/profiles?")) return Response.json(options.profiles || [{ user_id: USER, role: "admin", warehouse_id: "ca" }]);
      if (url.includes("/profile_warehouse_access?")) return Response.json(options.access || []);
      if (url.includes("/warehouses?")) return Response.json(options.warehouses || [{ id: "ca", code: "CA", active: true }]);
    }
    if (url.endsWith("/email")) return new Response(options.identity || "atlas-routing-preview@project-6a63ee65-40cb-4d53-b32.iam.gserviceaccount.com", { headers: { "Metadata-Flavor": "Google" } });
    if (url.endsWith("/token")) return new Response(JSON.stringify({ access_token: "synthetic-google-token", token_type: "Bearer", expires_in: 3600 }), { headers: { "Metadata-Flavor": "Google" } });
    if (url.endsWith(":optimizeTours")) {
      assert.equal(init.headers.Authorization, "Bearer synthetic-google-token");
      if (options.googleStatus) return Response.json({ privateDetail: "must not leak" }, { status: options.googleStatus });
      return Response.json({ routes: [{ visits: [{ startTime: "2026-09-21T14:00:00Z" }], vehicleStartTime: "2026-09-21T13:30:00Z", vehicleEndTime: "2026-09-21T15:00:00Z",
        breaks: [{ startTime: "2026-09-21T19:00:00Z", duration: "3600s" }], metrics: { travelDuration: "3600s", totalDuration: "5400s", travelDistanceMeters: 20000 } }] });
    }
    throw new Error("Unexpected outbound request");
  } });
  return { calls, invoke: (body = input(), headers = {}) => handler(new Request("https://example.test/plan-trip", { method: "POST",
    headers: { Origin: "http://localhost:18766", Authorization: "Bearer synthetic-user-access-token", "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) })) };
}
test("daily adapter permits a reviewed 12-pallet target, traffic, lunch and optional manual order", () => {
  const body = input(); body.stops = [{ ...body.stops[0], pallets: 6 }, { ...body.stops[0], pallets: 6 }]; body.preserveOrder = true;
  const request = buildPlannerTrip(body, depot, NOW);
  assert.equal(request.considerRoadTraffic, true); assert.equal(request.model.vehicles[0].loadLimits.pallets.maxLoad, "12");
  assert.equal(request.model.vehicles[0].breakRule.breakRequests[0].minDuration, "3600s");
  assert.equal(request.model.precedenceRules.length, 1);
  assert.equal(JSON.stringify(request).includes("Bubba"), false);
});
test("daily adapter validates driver, van, target, duration, actual dates and anonymous stop payloads", () => {
  for (const patch of [{ driver: "Unknown" }, { driver: "Achmad" }, { palletTarget: 0 }, { palletTarget: 11 }, { preserveOrder: "yes" }, { departure: "2026-02-30T06:30:00-08:00" }, { customer: "private" }]) assert.throws(() => buildPlannerTrip({ ...input(), ...patch }, depot, NOW));
  const body = input(); body.stops[0].serviceMinutes = 0; assert.throws(() => buildPlannerTrip(body, depot, NOW));
});
test("daily adapter estimates beyond normal shift without permitting arbitrary overnight planning", () => {
  assert.doesNotThrow(() => buildPlannerTrip({ ...input(), departure: "2026-09-21T16:00:00-07:00", lunch: null }, depot, NOW));
  assert.throws(() => buildPlannerTrip({ ...input(), returnBy: "2026-09-22T08:00:00-07:00" }, depot, NOW));
  assert.throws(() => buildPlannerTrip({ ...input(), returnBy: "2026-09-21T21:00:00-07:00" }, depot, NOW));
});
test("new Cloud Run route retains disabled/origin/account/CA protections before Google calls", async () => {
  const cases = [
    { env: { ATLAS_ROUTING_PREVIEW_ENABLED: "false" } }, { env: { ATLAS_ROUTING_TESTER_IDS: "" } },
    { user: { id: OTHER, app_metadata: { role: "admin" } } }, { user: { id: USER, user_metadata: { role: "admin" } } },
    { profiles: [{ user_id: USER, role: "staff", warehouse_id: "ca" }] },
    { profiles: [{ user_id: USER, role: "admin", warehouse_id: "tx" }], access: [{ user_id: OTHER, warehouse_id: "ca" }] },
    { warehouses: [{ id: "ca", code: "CA", active: false }] },
  ];
  for (const options of cases) {
    const f = fixture(options); assert.ok([403, 503].includes((await f.invoke()).status));
    assert.equal(f.calls.some(({ url }) => url.includes("google")), false);
  }
  assert.equal((await fixture().invoke(input(), { Origin: "https://evil.test" })).status, 403);
  assert.equal((await fixture().invoke({ ...input(), warehouse: "TX" })).status, 403);
});
test("new Cloud Run route uses keyless identity, caller RLS, bounded calls and sanitized results", async () => {
  const f = fixture(); const response = await f.invoke(); assert.equal(response.status, 200);
  const result = await response.json(); assert.equal(result.scope, "daily-planner-trip"); assert.equal(result.breaks[0].durationSeconds, 3600);
  assert.equal(JSON.stringify(result).includes("token"), false);
  assert.equal((await f.invoke()).status, 429);
  assert.equal(f.calls.filter(({ url }) => url.endsWith(":optimizeTours")).length, 1);
});
test("new Cloud Run route rejects wrong runtime identity and never exposes upstream errors", async () => {
  assert.equal((await fixture({ identity: "wrong@example.test" }).invoke()).status, 503);
  const f = fixture({ googleStatus: 429 }); const response = await f.invoke(); assert.equal(response.status, 429);
  assert.deepEqual(await response.json(), { error: "GOOGLE_QUOTA_REACHED" });
  assert.equal(f.calls.filter(({ url }) => url.endsWith(":optimizeTours")).length, 1);
});
test("response retains omitted stops and rejects duplicate stops and invalid breaks", () => {
  assert.deepEqual(summarizePlannerTrip({ routes: [] }, 2).skippedStopIndices, [0, 1]);
  assert.throws(() => summarizePlannerTrip({ routes: [{ visits: [{ startTime: "2026-09-21T14:00:00Z" }, { startTime: "2026-09-21T15:00:00Z" }] }] }, 2));
  assert.throws(() => summarizePlannerTrip({ routes: [{ breaks: [{ startTime: "2026-09-21T19:00:00Z", duration: "invalid" }] }] }, 1));
});
