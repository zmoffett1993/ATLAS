import { createPreviewAccess, RoutingError, fail, readJson } from "./preview-access.mjs";
// Isolated Cloud Run planner adapter. Authorization mirrors the unchanged legacy handler.
import { buildPlannerTrip as buildGoogleRequest, summarizePlannerTrip as summarizeResult } from "./trip-model.mjs";
// Nothing here persists orders, uploads photos, or modifies warehouse records.
const PROJECT = "project-6a63ee65-40cb-4d53-b32";
const OPTIMIZE_URL = `https://routeoptimization.googleapis.com/v1/projects/${PROJECT}:optimizeTours`;
const ORIGINS = new Set(["http://localhost:18766", "http://127.0.0.1:18766"]);

const object = (value) => value && typeof value === "object" && !Array.isArray(value);
function keys(value, allowed) {
  if (!object(value) || Object.keys(value).some((key) => !allowed.includes(key))) fail(400, "INVALID_REQUEST");
}
function coordinate(value) {
  keys(value, ["latitude", "longitude"]);
  if (!Number.isFinite(value.latitude) || !Number.isFinite(value.longitude) ||
      Math.abs(value.latitude) > 90 || Math.abs(value.longitude) > 180) fail(400, "INVALID_COORDINATE");
  return { latitude: value.latitude, longitude: value.longitude };
}
function timestamp(value) {
  if (typeof value !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,9})?(?:Z|[+-]\d\d:\d\d)$/.test(value) ||
      !Number.isFinite(Date.parse(value))) fail(400, "INVALID_TIME");
  const [year, month, day] = value.slice(0, 10).split("-").map(Number);
  if (month < 1 || month > 12 || day < 1 || day > new Date(Date.UTC(year, month, 0)).getUTCDate()) fail(400, "INVALID_TIME");
  return new Date(value).toISOString();
}
function localTime(value) {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles", year: "numeric",
    month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" })
    .formatToParts(new Date(value));
  const get = (type) => parts.find((part) => part.type === type).value;
  return { day: `${get("year")}-${get("month")}-${get("day")}`, minutes: +get("hour") * 60 + +get("minute") + +get("second") / 60 };
}

export function createPlannerHandler({ env, fetchImpl = fetch, now = Date.now }) {
  // Per-instance protection only; Google project quotas provide the shared limit.
  let busy = false, lastAttempt = -Infinity;
  const { call, authorize, googleToken, clearToken } = createPreviewAccess({ env, fetchImpl, now });
  return async (request) => {
    const origin = request.headers.get("origin");
    const headers = { "Content-Type": "application/json", "Cache-Control": "no-store", Vary: "Origin" };
    if (ORIGINS.has(origin)) Object.assign(headers, { "Access-Control-Allow-Origin": origin,
      "Access-Control-Allow-Methods": "POST, OPTIONS", "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info" });
    const reply = (status, body) => new Response(JSON.stringify(body), { status, headers });
    try {
      if (!ORIGINS.has(origin)) fail(403, "ORIGIN_NOT_ALLOWED");
      if (request.method === "OPTIONS") return new Response(null, { status: 204, headers });
      if (request.method !== "POST") fail(405, "METHOD_NOT_ALLOWED");
      if (env("ATLAS_ROUTING_PREVIEW_ENABLED") !== "true") fail(503, "PREVIEW_DISABLED");
      if (!/^application\/json(?:;|$)/i.test(request.headers.get("content-type") || "")) fail(415, "JSON_REQUIRED");
      const input = await readJson(request, 32768, 400);
      if (!object(input) || input.warehouse !== "CA") fail(403, "WAREHOUSE_ACCESS_DENIED");
      await authorize(request);
      let depot;
      try { depot = JSON.parse(env("ATLAS_ROUTING_CA_DEPOT_JSON") || ""); coordinate(depot); }
      catch { fail(503, "DEPOT_NOT_CONFIGURED"); }
      let model;
      try { model = buildGoogleRequest(input, depot, now()); }
      catch (error) { fail(400, error.code || "INVALID_REQUEST"); }
      if (busy || now() - lastAttempt < 30000) fail(429, "PREVIEW_RATE_LIMITED");
      busy = true; lastAttempt = now();
      try {
        const accessToken = await googleToken();
        const response = await call(OPTIMIZE_URL, { method: "POST", headers: {
          Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json",
        }, body: JSON.stringify(model) }, 25000);
        if (!response.ok) {
          if (response.status === 401) clearToken();
          fail(response.status === 429 ? 429 : 502, response.status === 429 ? "GOOGLE_QUOTA_REACHED" : "GOOGLE_ROUTING_UNAVAILABLE");
        }
        const result = await readJson(response, 1048576);
        // No upstream errors, credentials, request echoes or customer text returned.
        return reply(200, summarizeResult(result, input.stops.length));
      } finally { busy = false; }
    } catch (error) {
      return reply(error instanceof RoutingError ? error.status : 502, {
        error: error instanceof RoutingError ? error.code : "ROUTING_UNAVAILABLE",
      });
    }
  };
}
