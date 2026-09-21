import test from "node:test";
import assert from "node:assert/strict";
import { createRoutingHandler, buildGoogleRequest, summarizeResult } from "../supabase/functions/atlas-routing-preview/handler.mjs";

const NOW = Date.parse("2026-09-20T12:00:00Z");
const USER = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const CA = "33333333-3333-4333-8333-333333333333";
const TX = "44444444-4444-4444-8444-444444444444";
const DEPOT = { latitude: 34, longitude: -118 }; // Synthetic test location, not the configured depot.
const ACCOUNT = "atlas-routing-preview@project-6a63ee65-40cb-4d53-b32.iam.gserviceaccount.com";
const input = () => ({ action: "optimizeTrip", warehouse: "CA", departure: "2026-09-20T06:30:00-07:00",
  returnBy: "2026-09-20T15:00:00-07:00", stops: [{ location: { latitude: 34.1, longitude: -118.1 }, pallets: 4 }] });
const googleResult = () => ({ routes: [{ visits: [{ startTime: "2026-09-20T14:00:00Z" }],
  vehicleStartTime: "2026-09-20T13:30:00Z", vehicleEndTime: "2026-09-20T15:00:00Z",
  metrics: { travelDuration: "3600s", totalDuration: "5400s", travelDistanceMeters: 20000 } }] });
function fixture(options = {}) {
  const calls = []; let clock = NOW;
  const values = { ATLAS_ROUTING_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_synthetic_test_only", K_SERVICE: "atlas-routing-preview",
    ATLAS_ROUTING_PREVIEW_ENABLED: "true", ATLAS_ROUTING_TESTER_IDS: USER,
    ATLAS_ROUTING_CA_DEPOT_JSON: JSON.stringify(DEPOT),
    ...options.env };
  const response = (data, status = 200) => new Response(JSON.stringify(data), { status });
  const handler = createRoutingHandler({ env: (key) => values[key], now: () => clock, fetchImpl: async (url, init) => {
    calls.push({ url, init });
    assert.equal(init.redirect, "error");
    if (url.endsWith("/auth/v1/user")) {
      assert.equal(init.headers.Authorization, "Bearer fake-user-token-long-enough");
      return response(options.user || { id: USER, app_metadata: { role: "admin" } }, options.authStatus || 200);
    }
    if (url.includes("/rest/v1/")) {
      assert.equal(init.method, undefined, "Database requests must remain GET-only");
      assert.equal(init.headers.Authorization, "Bearer fake-user-token-long-enough", "RLS must run as the caller");
      assert.equal(init.headers.apikey, "sb_publishable_synthetic_test_only");
      if (options.databaseStatus) return response({ message: "private database error" }, options.databaseStatus);
      const parsed = new URL(url);
      if (parsed.pathname.endsWith("/profiles")) {
        assert.equal(parsed.searchParams.get("user_id"), `eq.${USER}`);
        return response(options.profiles || [{ user_id: USER, role: "admin", warehouse_id: CA }]);
      }
      if (parsed.pathname.endsWith("/profile_warehouse_access")) {
        assert.equal(parsed.searchParams.get("user_id"), `eq.${USER}`);
        return response(options.access || []);
      }
      if (parsed.pathname.endsWith("/warehouses")) return response(options.warehouses || [{ id: CA, code: "CA", active: true }]);
    }
    if (url.startsWith("http://metadata.google.internal/")) {
      assert.deepEqual(init.headers, { "Metadata-Flavor": "Google" });
      const headers = options.noMetadataHeader ? {} : { "Metadata-Flavor": "Google" };
      if (url.endsWith("/email")) return new Response(options.identity || ACCOUNT, { headers });
      if (url.endsWith("/token")) return new Response(JSON.stringify(options.token || {
        access_token: "fake-google-token", token_type: "Bearer", expires_in: 3600,
      }), { status: options.tokenStatus || 200, headers });
    }
    if (url.endsWith(":optimizeTours")) {
      assert.equal(init.headers.Authorization, "Bearer fake-google-token");
      if (options.googleThrow) throw new Error("SECRET ERROR THAT MUST NOT LEAK");
      return response(options.result || googleResult(), options.googleStatus || 200);
    }
    throw new Error("Unexpected network destination");
  } });
  return { calls, advance: (ms) => { clock += ms; }, invoke: (body = input(), headers = {}, method = "POST") => handler(new Request("https://example.test/function", {
    method, headers: { Origin: "http://localhost:18766", Authorization: "Bearer fake-user-token-long-enough", "Content-Type": "application/json", ...headers },
    ...(method === "POST" ? { body: typeof body === "string" ? body : JSON.stringify(body) } : {}),
  })) };
}

test("disabled preview, forbidden origin and preflight never contact any backend", async () => {
  const f = fixture({ env: { ATLAS_ROUTING_PREVIEW_ENABLED: "false" } });
  assert.equal((await f.invoke()).status, 503);
  assert.equal((await f.invoke(input(), { Origin: "https://untrusted.test" })).status, 403);
  assert.equal((await f.invoke(input(), {}, "OPTIONS")).status, 204);
  assert.equal(f.calls.length, 0);
});
test("missing/invalid authentication and unapproved accounts fail closed", async () => {
  for (const options of [{ authStatus: 401 }, { user: { id: OTHER, app_metadata: { role: "admin" } } }, { env: { ATLAS_ROUTING_TESTER_IDS: "" } }]) {
    const f = fixture(options); assert.ok([401, 403].includes((await f.invoke()).status));
    assert.equal(f.calls.some((call) => call.url.includes("googleapis")), false);
  }
  assert.equal((await fixture().invoke(input(), { Authorization: "" })).status, 401);
});
test("user-editable role metadata and non-admin profiles cannot authorize routing", async () => {
  for (const options of [
    { user: { id: USER, user_metadata: { role: "admin" } } },
    { profiles: [{ user_id: USER, role: "staff", warehouse_id: CA }] },
    { profiles: [] },
  ]) assert.equal((await fixture(options).invoke()).status, 403);
});
test("CA access requires the same user's active warehouse or explicit grant", async () => {
  assert.equal((await fixture().invoke({ ...input(), warehouse: "TX" })).status, 403);
  const tx = { profiles: [{ user_id: USER, role: "admin", warehouse_id: TX }] };
  assert.equal((await fixture(tx).invoke()).status, 403);
  assert.equal((await fixture({ ...tx, access: [{ user_id: OTHER, warehouse_id: CA }] }).invoke()).status, 403);
  assert.equal((await fixture({ warehouses: [{ id: CA, code: "CA", active: false }] }).invoke()).status, 403);
  assert.equal((await fixture({ ...tx, access: [{ user_id: USER, warehouse_id: CA }] }).invoke()).status, 200);
});
test("rejects oversized JSON, non-JSON content, injected models and customer text", async () => {
  assert.equal((await fixture().invoke("x".repeat(33000))).status, 400);
  assert.equal((await fixture().invoke(input(), { "Content-Type": "text/plain" })).status, 415);
  assert.equal((await fixture().invoke({ ...input(), model: { vehicles: [] } })).status, 400);
  const body = input(); body.stops[0].customer = "Must not transmit";
  const f = fixture(); assert.equal((await f.invoke(body)).status, 400);
  assert.equal(f.calls.some((call) => call.url.includes("googleapis")), false);
});
test("truck capacity, driver hours, coordinate and time-window validation", () => {
  const invalid = [];
  let body = input(); body.stops[0].pallets = 12; invalid.push(body);
  body = input(); body.stops.push({ ...body.stops[0], pallets: 8 }); invalid.push(body);
  body = input(); body.stops[0].location.latitude = 100; invalid.push(body);
  body = input(); body.returnBy = "2026-09-20T15:01:00-07:00"; invalid.push(body);
  body = input(); body.returnBy = "2026-09-20T15:00:01-07:00"; invalid.push(body);
  body = input(); body.departure = "2026-09-20T06:00:00-07:00"; invalid.push(body);
  body = input(); body.stops[0].timeWindow = { start: body.returnBy, end: body.departure }; invalid.push(body);
  for (const bad of invalid) assert.throws(() => buildGoogleRequest(bad, DEPOT, NOW));
  const winter = input(); winter.departure = "2026-12-01T06:30:00-08:00"; winter.returnBy = "2026-12-01T15:00:00-08:00";
  assert.equal(buildGoogleRequest(winter, DEPOT, Date.parse("2026-12-01T12:00:00Z")).model.globalStartTime, "2026-12-01T14:30:00.000Z");
});
test("keyless metadata credentials and a bounded traffic-aware trip return sanitized results", async () => {
  const f = fixture(); const response = await f.invoke(); const data = await response.json();
  assert.equal(response.status, 200); assert.equal(response.headers.get("Cache-Control"), "no-store");
  assert.equal(data.wholeDayValidated, false); assert.equal(data.driveSeconds, 3600);
  assert.equal(data.visits[0].stopIndex, 0); assert.deepEqual(data.skippedStopIndices, []);
  const request = JSON.parse(f.calls.find((call) => call.url.endsWith(":optimizeTours")).init.body);
  assert.equal(request.considerRoadTraffic, true); assert.equal(request.model.vehicles.length, 1);
  assert.deepEqual(request.model.vehicles[0].startLocation, request.model.vehicles[0].endLocation);
  assert.equal(request.model.shipments[0].deliveries[0].duration, "1500s");
  assert.equal(JSON.stringify(data).includes("fake-"), false);
  const fractional = googleResult(); fractional.routes[0].visits[0].startTime = "2026-09-20T14:00:00.100Z";
  assert.equal(summarizeResult(fractional, 1).visits[0].arrival, "2026-09-20T14:00:00.100Z");
});
test("manual ordering uses precedence constraints and missing stops stay visible", () => {
  const body = input(); body.preserveOrder = true; body.stops.push({ ...body.stops[0] });
  assert.deepEqual(buildGoogleRequest(body, DEPOT, NOW).model.precedenceRules, [
    { firstIndex: 0, firstIsDelivery: true, secondIndex: 1, secondIsDelivery: true },
  ]);
  const result = googleResult(); result.routes[0].hasTrafficInfeasibilities = true;
  const summary = summarizeResult(result, 2);
  assert.deepEqual(summary.skippedStopIndices, [1]); assert.equal(summary.trafficInfeasible, true);
});
test("upstream quota/errors are sanitized and are never automatically retried", async () => {
  for (const options of [{ googleStatus: 429 }, { googleStatus: 403 }, { googleThrow: true }]) {
    const f = fixture(options), response = await f.invoke();
    assert.equal(response.status, options.googleStatus === 429 ? 429 : 502);
    assert.equal((await response.text()).includes("SECRET"), false);
    assert.equal(f.calls.filter((call) => call.url.endsWith(":optimizeTours")).length, 1);
  }
});
test("local throttling avoids repeated billed calls and safely reuses OAuth token", async () => {
  const f = fixture(); assert.equal((await f.invoke()).status, 200);
  assert.equal((await f.invoke()).status, 429); f.advance(30001);
  assert.equal((await f.invoke()).status, 200);
  assert.equal(f.calls.filter((call) => call.url.endsWith("/token")).length, 1);
});
test("invalid configuration cannot access the Google metadata service", async () => {
  for (const env of [{ ATLAS_ROUTING_CA_DEPOT_JSON: "" },
    { ATLAS_ROUTING_SUPABASE_PUBLISHABLE_KEY: "" },
    { ATLAS_ROUTING_SUPABASE_PUBLISHABLE_KEY: "sb_secret_rejected" },
    { K_SERVICE: "" }, { K_SERVICE: "unrelated-service" },
  ]) {
    const f = fixture({ env }); assert.equal((await f.invoke()).status, 503);
    assert.equal(f.calls.some((call) => call.url.includes("metadata.google.internal") || call.url.includes("googleapis")), false);
  }
});
test("wrong runtime identity, forged metadata and invalid tokens fail closed", async () => {
  for (const options of [{ identity: "other@example.test" }, { noMetadataHeader: true },
    { tokenStatus: 500 }, { token: { access_token: "fake", token_type: "Bearer", expires_in: 10 } },
  ]) {
    const f = fixture(options); assert.ok([502, 503].includes((await f.invoke()).status));
    assert.equal(f.calls.some((call) => call.url.endsWith(":optimizeTours")), false);
  }
});
test("token expiry renews identity checks and cached tokens never skip user authorization", async () => {
  const f = fixture(); assert.equal((await f.invoke()).status, 200);
  f.advance(3600000); assert.equal((await f.invoke()).status, 200);
  assert.equal(f.calls.filter((call) => call.url.endsWith("/token")).length, 2);
  assert.equal(f.calls.filter((call) => call.url.endsWith("/email")).length, 2);
  assert.equal(f.calls.filter((call) => call.url.endsWith("/auth/v1/user")).length, 2);
  assert.equal((await f.invoke(input(), { Authorization: "" })).status, 401);
});
test("RLS denial fails closed without leaking database errors", async () => {
  const f = fixture({ databaseStatus: 403 }); const result = await f.invoke();
  assert.equal(result.status, 503); assert.equal((await result.text()).includes("private"), false);
  assert.equal(f.calls.some((call) => call.url.includes("metadata.google.internal")), false);
});
test("malformed route response cannot invent or duplicate customer stops", () => {
  const result = googleResult(); result.routes[0].visits.push({ ...result.routes[0].visits[0] });
  assert.throws(() => summarizeResult(result, 1));
  assert.throws(() => summarizeResult({ routes: [{ metrics: { travelDistanceMeters: -1 } }] }, 1));
});
