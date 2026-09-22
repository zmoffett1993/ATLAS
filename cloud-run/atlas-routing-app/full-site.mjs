import { readFileSync } from "node:fs";
const files = JSON.parse(readFileSync(new URL("./static-files.json", import.meta.url), "utf8"));
const mime = { html: "text/html", js: "text/javascript", css: "text/css", json: "application/json", webmanifest: "application/manifest+json", png: "image/png", svg: "image/svg+xml", jpeg: "image/jpeg", jpg: "image/jpeg", webp: "image/webp", ico: "image/x-icon" };
export const fullSiteFiles = new Map(files.map(file => [`/${file}`, [file, mime[file.split('.').pop()]]]));
fullSiteFiles.set("/", ["index.html", "text/html"]);
fullSiteFiles.set("/coc-receiver/", ["coc-receiver/index.html", "text/html"]);
fullSiteFiles.set("/tools/routing-preview/full-site-client.mjs", ["tools/routing-preview/full-site-client.mjs", "text/javascript"]);

export function fullSitePage(html, nonce, receiver = false) {
  // This transform is private-host-only. Production HTML and its navigation stay intact.
  const worker = '"/tools/routing-preview/routing-notification-sw.mjs", { type: "module", scope: "/", updateViaCache: "none" },';
  html = html.replace(/"\.{1,2}\/service-worker\.js\?v=\d+",(?:\s*\{ updateViaCache: "none" \},)?/, worker);
  html = html.replace(/<script\b(?![^>]*\bnonce=)/g, `<script nonce="${nonce}"`);
  html = html.replace(/<title>([^<]*)<\/title>/, '<title>$1 · Testing</title>');
  if (!receiver) html = html.replace('</body>', '<script type="module" nonce="'+nonce+'" src="/tools/routing-preview/full-site-client.mjs"></script></body>');
  return html;
}

export function fullSiteWorker(source) {
  // Reuse main's session-isolated cache and offline fallbacks. Never cache runtime config.
  // The existing reminder worker lives below /tools/, so shell URLs must be root-relative.
  source = source.replaceAll('"./', '"/');
  source = source.replace('const VERSION = "atlas-pwa-v376-integrated-routing-ui";', 'const VERSION = "atlas-pwa-v376-testing-host-v1";');
  source = source.replace('self.addEventListener("install",', 'APP_SHELL.push("/tools/routing-preview/full-site-client.mjs", "/preview.mjs", "/maps.mjs");\nself.addEventListener("install",');
  source = source.replace('const isNavigation = request.mode === "navigate";', 'if (url.origin === self.location.origin && (url.pathname === "/runtime-config.json" || url.pathname.startsWith("/api/"))) return;\n  const isNavigation = request.mode === "navigate";');
  return source;
}
