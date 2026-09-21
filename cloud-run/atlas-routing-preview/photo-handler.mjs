import { createPreviewAccess, RoutingError, fail, readJson } from "./preview-access.mjs";

const PROJECT = "project-6a63ee65-40cb-4d53-b32";
const ORIGINS = new Set(["http://localhost:18766", "http://127.0.0.1:18766"]);
export const PHOTO_REQUEST_LIMIT = 2800200;

export function validatePhoto(input) {
  if (!input || input.warehouse !== "CA") fail(403, "WAREHOUSE_ACCESS_DENIED");
  if (Object.keys(input).some((key) => !["action", "warehouse", "image"].includes(key)) || input.action !== "readOrderPhoto") fail(400, "INVALID_REQUEST");
  if (typeof input.image !== "string" || input.image.length < 16 || input.image.length > 2800000 ||
      input.image.length % 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(input.image)) fail(400, "INVALID_PHOTO");
  const image = Buffer.from(input.image, "base64");
  if (image.toString("base64") !== input.image || image[0] !== 255 || image[1] !== 216 || image[2] !== 255 ||
      image.at(-2) !== 255 || image.at(-1) !== 217) fail(400, "INVALID_PHOTO");
  return input.image;
}

export function photoResult(result) {
  if (!Array.isArray(result.responses) || result.responses.length !== 1) fail(502, "PHOTO_READING_UNAVAILABLE");
  const response = result.responses[0];
  if (response.error) fail(502, "PHOTO_READING_UNAVAILABLE");
  const annotation = response.fullTextAnnotation;
  if (!annotation?.pages?.length) return { warehouse: "CA", scope: "order-photo", pages: [{ text: "", words: [] }] };
  if (annotation.pages.length !== 1 || typeof annotation.text !== "string" || annotation.text.length > 100000) fail(502, "PHOTO_TOO_COMPLEX");
  const page = annotation.pages[0], words = [];
  if (!(page.width > 0 && page.height > 0)) fail(502, "PHOTO_READING_UNAVAILABLE");
  for (const block of page.blocks || []) for (const paragraph of block.paragraphs || []) for (const word of paragraph.words || []) {
    if (words.length >= 10000) fail(502, "PHOTO_TOO_COMPLEX");
    const text = (word.symbols || []).map((s) => s.text || "").join("");
    const vertices = word.boundingBox?.vertices;
    if (!text || text.length > 200 || !Array.isArray(vertices) || vertices.length !== 4) continue;
    const xs = vertices.map((v) => (v.x || 0) / page.width), ys = vertices.map((v) => (v.y || 0) / page.height);
    const x = Math.min(...xs), y = Math.min(...ys), w = Math.max(...xs) - x, h = Math.max(...ys) - y;
    if (![x, y, w, h].every(Number.isFinite) || w <= 0 || h <= 0 || x < 0 || y < 0 || x + w > 1.01 || y + h > 1.01) continue;
    words.push({ text, x, y: y + h / 2, w, h, confidence: Number.isFinite(word.confidence) ? word.confidence : null });
  }
  return { warehouse: "CA", scope: "order-photo", pages: [{ text: annotation.text, words }] };
}

export function createPhotoHandler({ env, fetchImpl = fetch, now = Date.now }) {
  const access = createPreviewAccess({ env, fetchImpl, now });
  let busy = false, lastAttempt = -Infinity, count = 0, day = "";
  return async (request) => {
    const origin = request.headers.get("origin");
    const headers = { "Content-Type": "application/json", "Cache-Control": "no-store", Vary: "Origin" };
    if (ORIGINS.has(origin)) Object.assign(headers, { "Access-Control-Allow-Origin": origin,
      "Access-Control-Allow-Methods": "POST, OPTIONS", "Access-Control-Allow-Headers": "authorization, content-type" });
    const reply = (status, body) => new Response(JSON.stringify(body), { status, headers });
    try {
      if (!ORIGINS.has(origin)) fail(403, "ORIGIN_NOT_ALLOWED");
      if (request.method === "OPTIONS") return new Response(null, { status: 204, headers });
      if (request.method !== "POST") fail(405, "METHOD_NOT_ALLOWED");
      // Separate opt-in. Existing routing approval never silently enables OCR.
      if (env("ATLAS_ROUTING_PREVIEW_ENABLED") !== "true" || env("ATLAS_ROUTING_PHOTO_ENABLED") !== "true") fail(503, "PHOTO_READING_DISABLED");
      if (!/^application\/json(?:;|$)/i.test(request.headers.get("content-type") || "")) fail(415, "JSON_REQUIRED");
      await access.authorize(request);
      const input = await readJson(request, PHOTO_REQUEST_LIMIT, 400), image = validatePhoto(input);
      const today = new Date(now()).toISOString().slice(0, 10);
      if (day !== today) { count = 0; day = today; }
      if (busy || now() - lastAttempt < 1500) fail(429, "PHOTO_RATE_LIMITED");
      // Instance guard only: restarts reset it. A Google project quota is needed too.
      if (count >= 100) fail(429, "PHOTO_TEST_LIMIT_REACHED");
      busy = true; lastAttempt = now(); count++;
      try {
        const token = await access.googleToken();
        const response = await access.call("https://vision.googleapis.com/v1/images:annotate", { method: "POST",
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", "x-goog-user-project": PROJECT },
          body: JSON.stringify({ requests: [{ image: { content: image }, features: [{ type: "DOCUMENT_TEXT_DETECTION" }] }] }),
        }, 25000);
        if (!response.ok) {
          if (response.status === 401) access.clearToken();
          fail(response.status === 429 ? 429 : 502, response.status === 429 ? "GOOGLE_QUOTA_REACHED" : "PHOTO_READING_UNAVAILABLE");
        }
        return reply(200, photoResult(await readJson(response, 4000000)));
      } finally { busy = false; }
    } catch (error) {
      return reply(error instanceof RoutingError ? error.status : 502, { error: error instanceof RoutingError ? error.code : "PHOTO_READING_UNAVAILABLE" });
    }
  };
}
