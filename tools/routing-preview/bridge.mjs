// Temporary Cloud Shell preview only. Never deploy this operator-authenticated bridge.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolve, dirname } from "node:path";
import { randomBytes } from "node:crypto";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const BACKEND = "https://atlas-routing-preview-340839522237.us-central1.run.app";
const SUPABASE = "https://dwrrbpiprcmajfyronlf.supabase.co";
const STATIC = new Map([
  ["/", ["tools/routing-preview/index.html", "text/html"]],
  ["/preview.mjs", ["tools/routing-preview/preview.mjs", "text/javascript"]],
  ["/maps.mjs", ["tools/routing-preview/maps.mjs", "text/javascript"]],
  ["/preview.css", ["tools/routing-preview/preview.css", "text/css"]],
  ...["atlas-login.js", "atlas-auth.js", "atlas-routing-core.js", "atlas-routing-intake.js", "atlas-routing-storage.js", "atlas-routing-notifications.js", "atlas-routing-planner.js", "atlas-routing-catalog.js", "atlas-routing.js", "atlas-jszip.min.js"].map((file) => [`/${file}`, [file, "text/javascript"]]),
  ...["atlas-auth.css", "atlas-routing.css"].map((file) => [`/${file}`, [file, "text/css"]]),
  ["/atlas-brand-landscape-dark.svg", ["atlas-brand-landscape-dark.svg", "image/svg+xml"]],
  ["/chubby-gorilla-header-v2.png", ["chubby-gorilla-header-v2.png", "image/png"]],
]);
const exec = promisify(execFile);
const mintOperatorToken = async () => (await exec("gcloud", ["auth", "print-identity-token"], { timeout: 15000, maxBuffer: 16384 })).stdout.trim();

export function createPreviewBridge({ origin, publishableKey, browserKey = publishableKey, mapsBrowserKey = "", photoEnabled = false, storageEnabled = false, permanent = false, notificationsEnabled = false, authorizeCaller, getGoogleToken = mintOperatorToken, fetchImpl = fetch, now = Date.now }) {
  const parsed = new URL(origin);
  const validHost = permanent ? /^atlas-routing-app-[a-z0-9-]+(?:\.[a-z0-9-]+)?\.run\.app$/.test(parsed.hostname) : /^18766-[a-z0-9-]+\.cs-[a-z0-9-]+\.cloudshell\.dev$/.test(parsed.hostname);
  if (parsed.protocol !== "https:" || !validHost || parsed.origin !== origin) throw new Error("Approved preview origin required");
  if (permanent && (getGoogleToken === mintOperatorToken || typeof authorizeCaller !== "function")) throw new Error("Permanent hosting requires a workload identity and caller authorization.");
  const staticFiles = new Map(STATIC);
  if (permanent) {
    for (const file of ["notification-binding.mjs", "notification-client.mjs", "notification-worker.mjs", "routing-notification-sw.mjs"]) staticFiles.set(`/tools/routing-preview/${file}`, [`tools/routing-preview/${file}`, "text/javascript"]);
    for (const file of ["atlas-icon-v2-192.png", "atlas-icon-v2-512.png", "atlas-icon-v2-180.png"]) staticFiles.set(`/${file}`, [file,"image/png"]);
    staticFiles.set("/routing.webmanifest", ["tools/routing-preview/routing.webmanifest", "application/manifest+json"]);
  }
  if (!/^sb_publishable_[A-Za-z0-9_-]+$/.test(publishableKey || "")) throw new Error("Publishable configuration required");
  // Existing ATLAS Auth sends its application key as a bearer on sign-in.
  // Preserve that module using the existing anon key; the backend uses modern keys.
  if (browserKey !== publishableKey) {
    let claims;
    try { claims = JSON.parse(Buffer.from(browserKey.split(".")[1], "base64url")); } catch { throw new Error("Invalid browser configuration"); }
    if (claims.role !== "anon" || claims.ref !== "dwrrbpiprcmajfyronlf") throw new Error("Only existing anon browser configuration is allowed");
  }
  if (mapsBrowserKey && !/^AIza[\w-]{30,60}$/.test(mapsBrowserKey)) throw new Error("Invalid Maps browser configuration");
  let photoAttempts = 0, lastPhoto = -Infinity;
  let busy = false, attempts = 0, plannerAttempts = 0, lastAttempt = -Infinity;
  const server = createServer({ requestTimeout: 10000, headersTimeout: 10000, maxHeaderSize: 16384 }, async (req, res) => {
    const nonce = randomBytes(18).toString("base64");
    const headers = {
      "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "strict-origin-when-cross-origin",
      "Content-Security-Policy": `default-src 'self'; script-src 'self' 'nonce-${nonce}' https://maps.googleapis.com https://maps.gstatic.com; style-src 'self' 'nonce-${nonce}' https://fonts.googleapis.com; img-src 'self' blob: data: https://*.googleapis.com https://*.gstatic.com https://*.google.com https://*.googleusercontent.com; connect-src 'self' ${SUPABASE} https://*.googleapis.com https://*.gstatic.com https://*.google.com; font-src https://fonts.gstatic.com; worker-src ${permanent ? "'self' " : ""}blob:; frame-src https://*.google.com; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors ${permanent ? "'none'" : "'self' https://shell.cloud.google.com https://console.cloud.google.com"}`,
    };
    const send = (status, body, type = "application/json") => { res.writeHead(status, { ...headers, "Content-Type": type }); res.end(type === "application/json" ? JSON.stringify(body) : body); };
    const reject = (status, error) => send(status, { error });
    try {
      const host = req.headers.host;
      // Cloud Shell may preserve the external host or forward to its local port.
      if (![parsed.host, ...(permanent ? [] : ["localhost:18766", "127.0.0.1:18766"])].includes(host)) return reject(403, "HOST_NOT_ALLOWED");
      if (req.headers.origin && req.headers.origin !== origin) return reject(403, "ORIGIN_NOT_ALLOWED");
      const path = new URL(req.url, origin).pathname;
      // Google sign-in returns through a cross-site top-level navigation. Allow
      // only the static entry page; configuration and API requests stay guarded.
      const entryNavigation = req.method === "GET" && path === "/" && !req.headers.origin
        && req.headers["sec-fetch-mode"] === "navigate" && req.headers["sec-fetch-dest"] === "document";
      if (req.headers["sec-fetch-site"] === "cross-site" && !entryNavigation) return reject(403, "ORIGIN_NOT_ALLOWED");
      if (req.method === "GET" && staticFiles.has(path)) {
        const [file, type] = staticFiles.get(path);
        let content = await readFile(resolve(ROOT, file));
        if (permanent && type === "text/html") content = content.toString().replace("</head>", '<link rel="manifest" href="/routing.webmanifest"><link rel="apple-touch-icon" href="/atlas-icon-v2-180.png"><meta name="theme-color" content="#071b40"></head>').replace("This temporary preview is available while the Cloud Shell session is running.", "This private routing preview uses permanent hosting; live ATLAS remains separate.");
        if (permanent && path === "/tools/routing-preview/routing-notification-sw.mjs") headers["Service-Worker-Allowed"] = "/";
        if (type === "text/html") content = content.toString().replaceAll("<script ", `<script nonce="${nonce}" `).replace("</head>", `<style nonce="${nonce}"></style></head>`);
        return send(200, content, type);
      }
      if (req.url === "/runtime-config.json" && req.method === "GET") return send(200, { url: SUPABASE, key: browserKey, mapsBrowserKey, photoEnabled: photoEnabled === true, storageEnabled: storageEnabled === true,
        ...(permanent ? {notificationsEnabled: notificationsEnabled === true, notificationOrigin: origin} : {}) });
      if (!["/api/optimize-trip", "/api/plan-trip", "/api/read-order-photo"].includes(req.url)) return reject(404, "NOT_FOUND");
      const planning = req.url === "/api/plan-trip", photo = req.url === "/api/read-order-photo";
      if (photo && photoEnabled !== true) return reject(503, "PHOTO_READING_DISABLED");
      const limit = photo ? 2800200 : 32768;
      if (req.method !== "POST") return reject(405, "METHOD_NOT_ALLOWED");
      if (req.headers.origin !== origin) return reject(403, "ORIGIN_NOT_ALLOWED");
      // Cloud Shell's Google gateway consumes Authorization before this bridge.
      // Carry ATLAS credentials separately, then translate for the fixed backend.
      const atlasAuthorization = req.headers["x-atlas-authorization"];
      if (!/^Bearer [^\s]{20,8192}$/i.test(atlasAuthorization || "")) return reject(401, "SIGN_IN_REQUIRED");
      if (permanent && await authorizeCaller(atlasAuthorization) !== true) return reject(403, "PREVIEW_ACCESS_DENIED");
      if (req.headers["content-encoding"] || !/^application\/json(?:;|$)/i.test(req.headers["content-type"] || "")) return reject(415, "JSON_REQUIRED");
      if (Number(req.headers["content-length"] || 0) > limit) return reject(413, "PAYLOAD_TOO_LARGE");
      let size = 0; const chunks = [];
      for await (const chunk of req) { size += chunk.length; if (size <= limit) chunks.push(chunk); }
      if (size > limit) return reject(413, "PAYLOAD_TOO_LARGE");
      let payload;
      try { payload = JSON.parse(Buffer.concat(chunks).toString()); } catch { return reject(400, "INVALID_REQUEST"); }
      if (payload?.warehouse !== "CA" || payload?.action !== (photo ? "readOrderPhoto" : planning ? "planTrip" : "optimizeTrip")) return reject(400, "INVALID_REQUEST");
      if (busy || (photo ? now() - lastPhoto < 1500 : now() - lastAttempt < 30000)) return reject(429, "PREVIEW_RATE_LIMITED");
      if (photo ? photoAttempts >= 100 : planning ? plannerAttempts >= 20 : attempts >= 5) return reject(429, "PREVIEW_TEST_LIMIT_REACHED");
      busy = true; if (photo) { photoAttempts++; lastPhoto = now(); }
      else { if (planning) plannerAttempts++; else attempts++; lastAttempt = now(); }
      try {
        const googleToken = await getGoogleToken();
        if (!googleToken || /\s/.test(googleToken)) throw new Error("Identity unavailable");
        // Fixed target only: this cannot act as a general proxy. Never forward cookies.
        const response = await fetchImpl(`${BACKEND}/${photo ? "read-order-photo" : planning ? "plan-trip" : "optimize-trip"}`, {
          method: "POST", redirect: "error", signal: AbortSignal.timeout(45000),
          headers: { "Content-Type": "application/json", Origin: "http://localhost:18766",
            Authorization: atlasAuthorization, "X-Serverless-Authorization": `Bearer ${googleToken}` },
          body: JSON.stringify(payload),
        });
        if (!/application\/json/i.test(response.headers.get("content-type") || "")) return reject(502, "PREVIEW_UNAVAILABLE");
        const reader = response.body.getReader(); let total = 0; const parts = [];
        try {
          while (true) { const { done, value } = await reader.read(); if (done) break; total += value.length;
            if (total > 1048576) { await reader.cancel(); throw new Error("Response too large"); } parts.push(value); }
        } finally { reader.releaseLock(); }
        const result = JSON.parse(Buffer.concat(parts).toString());
        if (!response.ok) return reject(response.status, /^[A-Z_]{1,64}$/.test(result.error || "") ? result.error : "PREVIEW_UNAVAILABLE");
        // The fixed backend already sanitizes results. Do not forward response headers.
        if (result.scope !== (photo ? "order-photo" : planning ? "daily-planner-trip" : "single-truck-trip") || result.warehouse !== "CA" || (!photo && result.wholeDayValidated !== false)) throw new Error("Unexpected result");
        return send(200, result);
      } finally { busy = false; }
    } catch { if (!res.headersSent) reject(502, "PREVIEW_UNAVAILABLE"); else res.end(); }
  });
  server.maxHeadersCount = 32;
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // Configuration is an external private file, never part of the upload/source tree.
  const config = JSON.parse(await readFile(process.env.ATLAS_PREVIEW_CONFIG, "utf8"));
  const origin = `https://18766-${process.env.WEB_HOST}`;
  const server = createPreviewBridge({ origin, publishableKey: config.ATLAS_ROUTING_SUPABASE_PUBLISHABLE_KEY, browserKey: config.ATLAS_PREVIEW_BROWSER_ANON_KEY, mapsBrowserKey: config.ATLAS_PREVIEW_MAPS_BROWSER_KEY, photoEnabled: config.ATLAS_ROUTING_PHOTO_ENABLED === true, storageEnabled: config.ATLAS_ROUTING_STORAGE_ENABLED === true });
  server.listen(18766, "127.0.0.1", () => console.log(`Private routing preview: ${origin}`));
  process.on("SIGTERM", () => { server.close(); setTimeout(() => process.exit(0), 9000).unref(); });
}
