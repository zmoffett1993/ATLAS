// ATLAS routing preview v2. Shared Cloud Run handler; not a Supabase deployment.
// Nothing here persists orders, uploads photos, or modifies warehouse records.
const PROJECT = "project-6a63ee65-40cb-4d53-b32";
const ACCOUNT = `atlas-routing-preview@${PROJECT}.iam.gserviceaccount.com`;
const METADATA = "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default";
const OPTIMIZE_URL = `https://routeoptimization.googleapis.com/v1/projects/${PROJECT}:optimizeTours`;
const ORIGINS = new Set(["http://localhost:18766", "http://127.0.0.1:18766"]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ROLES = new Set(["admin", "administrator", "supervisor"]);

class RoutingError extends Error {
  constructor(status, code) { super(code); this.status = status; this.code = code; }
}
const fail = (status, code) => { throw new RoutingError(status, code); };
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

// One already allocated truck trip, not a claim that an entire workday fits.
export function buildGoogleRequest(input, depot, now = Date.now()) {
  keys(input, ["action", "warehouse", "departure", "returnBy", "stops", "preserveOrder"]);
  if (input.action !== "optimizeTrip" || input.warehouse !== "CA" ||
      (input.preserveOrder !== undefined && typeof input.preserveOrder !== "boolean")) fail(400, "INVALID_REQUEST");
  const departure = timestamp(input.departure), returnBy = timestamp(input.returnBy);
  const start = Date.parse(departure), end = Date.parse(returnBy);
  const localStart = localTime(departure), localEnd = localTime(returnBy);
  if (start < now || start > now + 31 * 86400000 || end <= start ||
      localStart.day !== localEnd.day || localStart.minutes < 390 || localEnd.minutes > 900) fail(400, "INVALID_TRIP_WINDOW");
  if (!Array.isArray(input.stops) || input.stops.length < 1 || input.stops.length > 20) fail(400, "INVALID_STOPS");
  let pallets = 0;
  const shipments = input.stops.map((stop, index) => {
    keys(stop, ["location", "pallets", "serviceMinutes", "timeWindow"]);
    if (!Number.isInteger(stop.pallets) || stop.pallets < 1 || stop.pallets > 11) fail(400, "INVALID_PALLETS");
    pallets += stop.pallets;
    const minutes = stop.serviceMinutes ?? 25;
    if (!Number.isInteger(minutes) || minutes < 5 || minutes > 120) fail(400, "INVALID_STOP_DURATION");
    const visit = { arrivalLocation: coordinate(stop.location), duration: `${minutes * 60}s` };
    if (stop.timeWindow != null) {
      keys(stop.timeWindow, ["start", "end"]);
      const windowStart = timestamp(stop.timeWindow.start), windowEnd = timestamp(stop.timeWindow.end);
      if (Date.parse(windowStart) < start || Date.parse(windowEnd) > end ||
          Date.parse(windowEnd) <= Date.parse(windowStart)) fail(400, "INVALID_STOP_WINDOW");
      visit.timeWindows = [{ startTime: windowStart, endTime: windowEnd }];
    }
    return { label: `stop-${index}`, deliveries: [visit], loadDemands: { pallets: { amount: String(stop.pallets) } } };
  });
  if (pallets > 11) fail(400, "TRUCK_CAPACITY_EXCEEDED");
  const location = coordinate(depot);
  const model = { globalStartTime: departure, globalEndTime: returnBy, shipments,
    vehicles: [{ label: "truck-trip", travelMode: "DRIVING", startLocation: location, endLocation: location,
      startTimeWindows: [{ startTime: departure, endTime: departure }],
      endTimeWindows: [{ startTime: departure, endTime: returnBy }],
      loadLimits: { pallets: { maxLoad: "11" } }, costPerHour: 1 }] };
  if (input.preserveOrder) model.precedenceRules = shipments.slice(1).map((_, index) => ({
    firstIndex: index, firstIsDelivery: true, secondIndex: index + 1, secondIsDelivery: true,
  }));
  return { timeout: "20s", considerRoadTraffic: true, populatePolylines: true, model };
}

async function readJson(response, limit, errorStatus = 502) {
  const reader = response.body?.getReader();
  if (!reader) fail(errorStatus, "INVALID_JSON");
  const chunks = []; let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) { await reader.cancel(); fail(errorStatus, "PAYLOAD_TOO_LARGE"); }
      chunks.push(value);
    }
    const bytes = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch (error) {
    if (error instanceof RoutingError) throw error;
    fail(errorStatus, "INVALID_JSON");
  } finally { reader.releaseLock(); }
}
export function createRoutingHandler({ env, fetchImpl = fetch, now = Date.now }) {
  // Per-instance protection only; Google project quotas provide the shared limit.
  let busy = false, lastAttempt = -Infinity, token = null;
  const call = (url, options = {}, timeout = 10000) => fetchImpl(url, {
    ...options, redirect: "error", signal: AbortSignal.timeout(timeout),
  });
  async function authorize(request) {
    const auth = request.headers.get("authorization") || "";
    if (!/^Bearer [^\s]{20,8192}$/i.test(auth)) fail(401, "SIGN_IN_REQUIRED");
    const base = "https://dwrrbpiprcmajfyronlf.supabase.co";
    const publicKey = env("ATLAS_ROUTING_SUPABASE_PUBLISHABLE_KEY");
    // Require the modern publishable-key format; never accept a service-role key.
    if (!/^sb_publishable_[A-Za-z0-9_-]+$/.test(publicKey || "")) fail(503, "PREVIEW_NOT_CONFIGURED");
    const headers = { apikey: publicKey, Authorization: auth };
    const authResponse = await call(`${base}/auth/v1/user`, { headers });
    if (!authResponse.ok) fail(authResponse.status >= 500 ? 503 : 401, "SIGN_IN_REQUIRED");
    const user = await readJson(authResponse, 65536);
    if (!UUID.test(user.id || "")) fail(401, "SIGN_IN_REQUIRED");
    const testers = (env("ATLAS_ROUTING_TESTER_IDS") || "").split(",").map((id) => id.trim()).filter((id) => UUID.test(id));
    if (!testers.includes(user.id)) fail(403, "PREVIEW_ACCESS_DENIED");
    const metadata = user.app_metadata || {};
    const roles = [metadata.role, metadata.atlas_role, ...(Array.isArray(metadata.roles) ? metadata.roles : [])];
    if (!roles.some((role) => ROLES.has(String(role).toLowerCase()))) fail(403, "PREVIEW_ACCESS_DENIED");
    async function rows(table, params) {
      const response = await call(`${base}/rest/v1/${table}?${new URLSearchParams(params)}`, { headers });
      if (!response.ok) fail(503, "ACCESS_CHECK_UNAVAILABLE");
      const result = await readJson(response, 65536);
      if (!Array.isArray(result)) fail(503, "ACCESS_CHECK_UNAVAILABLE");
      return result;
    }
    const profiles = await rows("profiles", { select: "user_id,role,warehouse_id", user_id: `eq.${user.id}`, limit: "2" });
    if (profiles.length !== 1 || profiles[0].user_id !== user.id || !ROLES.has(String(profiles[0].role).toLowerCase())) fail(403, "PREVIEW_ACCESS_DENIED");
    const access = await rows("profile_warehouse_access", { select: "user_id,warehouse_id", user_id: `eq.${user.id}` });
    const ids = new Set([profiles[0].warehouse_id, ...access.filter((row) => row.user_id === user.id).map((row) => row.warehouse_id)]);
    const warehouses = await rows("warehouses", { select: "id,code,active", code: "eq.CA", active: "eq.true", limit: "2" });
    if (warehouses.length !== 1 || warehouses[0].code !== "CA" || warehouses[0].active !== true || !ids.has(warehouses[0].id)) fail(403, "WAREHOUSE_ACCESS_DENIED");
  }
  async function googleToken() {
    if (token && token.expires > now() + 60000) return token.value;
    if (env("K_SERVICE") !== "atlas-routing-preview") fail(503, "CLOUD_RUN_IDENTITY_REQUIRED");
    // Fixed metadata endpoints only. Never forward the user's JWT to Google.
    const metadataHeaders = { "Metadata-Flavor": "Google" };
    const identity = await call(`${METADATA}/email`, { headers: metadataHeaders }, 3000);
    if (!identity.ok || identity.headers.get("Metadata-Flavor") !== "Google") fail(503, "CLOUD_RUN_IDENTITY_REQUIRED");
    const identityReader = identity.body?.getReader();
    if (!identityReader) fail(503, "CLOUD_RUN_IDENTITY_REQUIRED");
    let identityText = "";
    try {
      while (true) {
        const { value, done } = await identityReader.read();
        if (done) break;
        identityText += new TextDecoder().decode(value);
        if (identityText.length > 512) { await identityReader.cancel(); fail(503, "CLOUD_RUN_IDENTITY_REQUIRED"); }
      }
    } finally { identityReader.releaseLock(); }
    if (identityText.trim() !== ACCOUNT) fail(503, "CLOUD_RUN_IDENTITY_REQUIRED");
    const response = await call(`${METADATA}/token`, { headers: metadataHeaders }, 3000);
    if (!response.ok) fail(502, "GOOGLE_AUTH_UNAVAILABLE");
    if (response.headers.get("Metadata-Flavor") !== "Google") fail(502, "GOOGLE_AUTH_UNAVAILABLE");
    const data = await readJson(response, 32768);
    if (typeof data.access_token !== "string" || !data.access_token || data.token_type !== "Bearer" ||
        !Number.isFinite(data.expires_in) || data.expires_in < 60) fail(502, "GOOGLE_AUTH_UNAVAILABLE");
    token = { value: data.access_token, expires: now() + Math.min(data.expires_in, 3600) * 1000 };
    return token.value;
  }
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
      const model = buildGoogleRequest(input, depot, now());
      if (busy || now() - lastAttempt < 30000) fail(429, "PREVIEW_RATE_LIMITED");
      busy = true; lastAttempt = now();
      try {
        const accessToken = await googleToken();
        const response = await call(OPTIMIZE_URL, { method: "POST", headers: {
          Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json",
        }, body: JSON.stringify(model) }, 25000);
        if (!response.ok) {
          if (response.status === 401) token = null;
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

function seconds(value) {
  if (value == null) return 0; // Protobuf JSON omits zero-valued fields.
  if (typeof value !== "string" || !/^\d+(?:\.\d+)?s$/.test(value)) fail(502, "INVALID_ROUTING_RESPONSE");
  return Number(value.slice(0, -1));
}
export function summarizeResult(result, stopCount) {
  if (!object(result) || !Array.isArray(result.routes) || result.routes.length > 1 ||
      (result.skippedShipments && !Array.isArray(result.skippedShipments))) fail(502, "INVALID_ROUTING_RESPONSE");
  const route = result.routes[0] || {}, seen = new Set();
  const index = (value) => {
    const number = value ?? 0;
    if (!Number.isInteger(number) || number < 0 || number >= stopCount || seen.has(number)) fail(502, "INVALID_ROUTING_RESPONSE");
    seen.add(number); return number;
  };
  const visits = (route.visits || []).map((visit) => ({ stopIndex: index(visit.shipmentIndex), arrival: timestamp(visit.startTime) }));
  const skipped = (result.skippedShipments || []).map((stop) => index(stop.index));
  // A missing shipment must never silently disappear from a reviewed plan.
  for (let i = 0; i < stopCount; i++) if (!seen.has(i)) skipped.push(i);
  const metrics = route.metrics || {};
  const distanceMeters = metrics.travelDistanceMeters ?? 0;
  if (!Number.isFinite(distanceMeters) || distanceMeters < 0) fail(502, "INVALID_ROUTING_RESPONSE");
  const polyline = route.routePolyline?.points || "";
  if (typeof polyline !== "string" || polyline.length > 200000 || /[^\x3f-\x7e]/.test(polyline)) fail(502, "INVALID_ROUTING_RESPONSE");
  return { preview: true, scope: "single-truck-trip", warehouse: "CA", wholeDayValidated: false,
    visits, skippedStopIndices: skipped, departure: route.vehicleStartTime ? timestamp(route.vehicleStartTime) : null,
    returnTime: route.vehicleEndTime ? timestamp(route.vehicleEndTime) : null,
    trafficInfeasible: Boolean(route.hasTrafficInfeasibilities), distanceMeters,
    driveSeconds: seconds(metrics.travelDuration), totalSeconds: seconds(metrics.totalDuration), polyline };
}
