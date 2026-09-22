// Shared only by the private Cloud Run planner and photo reader.
const PROJECT = "project-6a63ee65-40cb-4d53-b32";
const ACCOUNT = `atlas-routing-preview@${PROJECT}.iam.gserviceaccount.com`;
const METADATA = "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ROLES = new Set(["admin", "administrator", "supervisor"]);
class RoutingError extends Error {
  constructor(status, code) { super(code); this.status = status; this.code = code; }
}
const fail = (status, code) => { throw new RoutingError(status, code); };
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
export { RoutingError, fail, readJson };
export function createPreviewAccess({ env, fetchImpl = fetch, now = Date.now }) {
  let token = null;
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
  return { call, authorize, googleToken, clearToken: () => { token = null; } };
}
