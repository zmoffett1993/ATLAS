import { createServer } from "node:http";
import { pathToFileURL } from "node:url";
import { createRoutingHandler } from "../../supabase/functions/atlas-routing-preview/handler.mjs";
import { createPlannerHandler } from "./planner-handler.mjs";
import { createPhotoHandler, PHOTO_REQUEST_LIMIT } from "./photo-handler.mjs";

// No runtime packages, private keys, request logging or local data persistence.
export function createPreviewServer({ handler = createRoutingHandler({ env: (name) => process.env[name] }), plannerHandler = createPlannerHandler({ env: (name) => process.env[name] }), photoHandler = createPhotoHandler({ env: (name) => process.env[name] }) } = {}) {
  const server = createServer({ requestTimeout: 10000, headersTimeout: 10000, maxHeaderSize: 16384 }, async (req, res) => {
    const send = (status, value) => {
      res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store", Connection: "close" });
      res.end(JSON.stringify(value));
    };
    // Deliberately do not reflect or log the request URL, headers or payload.
    // Cloud Run reserves some paths ending in z; retain the old local alias.
    if (["/health", "/healthz"].includes(req.url) && req.method === "GET") return send(200, { status: "ok" });
    if (!["/optimize-trip", "/plan-trip", "/read-order-photo"].includes(req.url)) return send(404, { error: "NOT_FOUND" });
    if (!["POST", "OPTIONS"].includes(req.method)) return send(405, { error: "METHOD_NOT_ALLOWED" });
    if (req.headers["content-encoding"]) return send(415, { error: "ENCODING_NOT_SUPPORTED" });
    const limit = req.url === "/read-order-photo" ? PHOTO_REQUEST_LIMIT : 32768;
    if (Number(req.headers["content-length"] || 0) > limit) return send(413, { error: "PAYLOAD_TOO_LARGE" });
    try {
      let size = 0; const chunks = [];
      // Continue draining an oversized chunked upload without retaining its data.
      for await (const chunk of req) { size += chunk.length; if (size <= limit) chunks.push(chunk); }
      if (size > limit) return send(413, { error: "PAYLOAD_TOO_LARGE" });
      const headers = new Headers();
      for (const name of ["origin", "authorization", "content-type"]) {
        const value = req.headers[name];
        if (typeof value === "string") headers.set(name, value);
      }
      const request = new Request(`http://routing.internal${req.url}`, {
        method: req.method, headers,
        ...(req.method === "POST" ? { body: Buffer.concat(chunks) } : {}),
      });
      const response = await (req.url === "/read-order-photo" ? photoHandler : req.url === "/plan-trip" ? plannerHandler : handler)(request);
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(Buffer.from(await response.arrayBuffer()));
    } catch {
      if (!res.headersSent && !res.destroyed) send(502, { error: "ROUTING_UNAVAILABLE" });
      else res.end();
    }
  });
  server.maxHeadersCount = 32;
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.PORT || 8080);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid server port");
  const server = createPreviewServer();
  server.listen(port, "0.0.0.0");
  process.on("SIGTERM", () => { server.close(); setTimeout(() => process.exit(0), 9000).unref(); });
}
