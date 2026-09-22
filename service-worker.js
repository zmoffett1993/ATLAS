const VERSION = "atlas-pwa-v382-todays-routes-mobile";
const SHELL_CACHE = `${VERSION}-shell`;
const DATA_CACHE = `${VERSION}-warehouse-data`;

const APP_SHELL = [
  "./",
  "./index.html",
  "./atlas-dashboard.css?v=171",
  "./atlas-coc-references.js?v=2",
  "./atlas-dashboard.js?v=189",
  "./atlas-auth.css?v=4",
  "./atlas-login.js?v=1",
  "./atlas-auth.js?v=8",
  "./atlas-coc.css?v=68",
  "./atlas-zxing-browser.min.js?v=1",
  "./atlas-coc-scanner.js?v=7",
  "./atlas-coc-parser.js?v=11",
  "./atlas-coc-case-quantities.js?v=4",
  "./atlas-coc-core.js?v=23",
  "./atlas-jszip.min.js?v=1",
  "./atlas-coc-storage.js?v=5",
  "./atlas-coc-delivery.js?v=16",
  "./atlas-coc-excel.js?v=20",
  "./atlas-coc.js?v=84",
  "./coc-receiver/index.html",
  "./coc-receiver/coc-receiver-favicon.svg?v=4",
  "./coc-receiver/coc-receiver-favicon-16.png?v=4",
  "./coc-receiver/coc-receiver-favicon-32.png?v=4",
  "./coc-receiver/receiver.css?v=39",
  "./coc-receiver/receiver.js?v=46",
  "./atlas-guided-workflows.css?v=4",
  "./atlas-guided-workflows.js?v=4",
  "./atlas-restock.css?v=3",
  "./atlas-restock.js?v=3",
  "./atlas-delete-approval.js?v=1",
  "./atlas-desktop.css?v=154",
  "./atlas-desktop-menu-typography.css?v=1",
  "./atlas-alerts.css?v=2",
  "./atlas-mobile-menu.css?v=3",
  "./atlas-desktop.js?v=136",
  "./atlas-routing.css?v=22",
  "./atlas-routing-core.js?v=12",
  "./atlas-routing-planner.js?v=6",
  "./atlas-routing-catalog.js?v=2",
  "./atlas-routing-intake.js?v=5",
  "./atlas-routing-storage.js?v=3",
  "./atlas-routing-notifications.js?v=2",
  "./atlas-routing-pod-core.js?v=1",
  "./atlas-routing-pod-queue.js?v=1",
  "./atlas-routing-pod.js?v=6",
  "./atlas-routing.js?v=36",
  "./tools/routing-preview/full-site-client.mjs?v=2",
  "./tools/routing-preview/preview.mjs",
  "./tools/routing-preview/maps.mjs",
  "./tools/routing-preview/notification-client.mjs",
  "./tools/routing-preview/notification-binding.mjs",
  "./tools/routing-preview/notification-worker.mjs",
  "./tools/routing-preview/routing-notification-sw.mjs",
  "./manifest.webmanifest?v=107",
  "./product-images.json?v=20260831-thick-wall-supabase-gallery-v106",
  "./pallet-guides.json?v=20260831-thick-wall-aliases-v7",
  "./product-images/cgasb1-60ml-cnl-owh.png",
  "./atlas-icon-v2-180.png?v=101",
  "./atlas-icon-v2-192.png?v=101",
  "./atlas-icon-v2-512.png?v=101",
  "./atlas-icon-v2-maskable-512.png?v=101",
  "./atlas-favicon-v2-32.png?v=101",
  "./atlas-warehouse-management.png",
  "./atlas-home-logo-v2.png",
  "./atlas-home-lockup-v3.png",
  "./atlas-brand-portrait-light.svg?v=97",
  "./atlas-brand-portrait-dark.svg?v=97",
  "./atlas-brand-landscape-light.svg?v=97",
  "./atlas-brand-landscape-dark.svg?v=128",
  "./atlas-brand-mark-light.svg?v=97",
  "./atlas-brand-mark-dark.svg?v=97",
  "./chubby-gorilla-about-v2.jpeg",
  "./chubby-gorilla-header-v2.png",
  "./atlas-menu-brand-lockup.png",
  "./atlas-menu-lockup-v2.png?v=81",
  "./atlas-about-mark-v1.png?v=81",
  "./atlas-about-hero-polished-v6.png?v=87",
  "./atlas-about-inventory-stylized-v2.webp?v=87",
  "./atlas-about-product-clear-trimmed.webp?v=86",
  "./atlas-about-product-clear-black-trimmed.webp?v=86",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(SHELL_CACHE)
      .then((cache) => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter(
              (key) =>
                key.startsWith("atlas-pwa-") &&
                ![SHELL_CACHE, DATA_CACHE].includes(key),
            )
            .map((key) => caches.delete(key)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("message", (event) => {
  if (event.data?.type === "SKIP_WAITING") self.skipWaiting();
});

async function networkFirst(request, cacheName, fallback) {
  const cache = await caches.open(cacheName);
  try {
    const response = await fetch(request);
    if (response.ok) await cache.put(request, response.clone());
    return response;
  } catch {
    return (await cache.match(request)) || fallback;
  }
}

async function warehouseRead(request, unavailable) {
  // Cache API URL matching does not isolate Authorization headers by itself.
  // Include the full request-header context (session, schema, range, etc.) in an
  // opaque key. Never persist raw bearer tokens in the cached Request headers.
  const context = JSON.stringify([...request.headers.entries()].sort());
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(context));
  const fingerprint = [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
  const url = new URL(request.url);
  url.searchParams.set("__atlas_cache_context", fingerprint);
  const key = new Request(url.href);
  const cache = await caches.open(DATA_CACHE);
  let response;
  try {
    response = await fetch(request);
  } catch {
    return (await cache.match(key)) || unavailable;
  }
  if (response.ok) await cache.put(key, response.clone()).catch(() => {});
  else if (response.status === 401 || response.status === 403) await cache.delete(key);
  return response;
}

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  const isNavigation = request.mode === "navigate";
  const isReceiverAsset =
    url.origin === self.location.origin &&
    url.pathname.includes("/coc-receiver/");
  const isSupabaseRead =
    url.hostname.endsWith(".supabase.co") &&
    url.pathname.startsWith("/rest/v1/");
  const isProductImage =
    url.hostname.endsWith(".supabase.co") &&
    url.pathname.startsWith(
      "/storage/v1/object/public/product-images/",
    );

  if (isNavigation) {
    event.respondWith(
      networkFirst(
        request,
        SHELL_CACHE,
        caches.match(url.pathname.includes("/coc-receiver/")
          ? "./coc-receiver/index.html"
          : "./index.html"),
      ),
    );
    return;
  }

  if (isSupabaseRead) {
    const unavailable = new Response(
      JSON.stringify({
        message:
          "Warehouse data is unavailable offline until ATLAS completes one successful online load.",
      }),
      { status: 503, headers: { "Content-Type": "application/json" } },
    );
    event.respondWith(warehouseRead(request, unavailable));
    return;
  }

  if (isProductImage) {
    event.respondWith(
      caches.open(DATA_CACHE).then(async (cache) => {
        const cached = await cache.match(request);
        if (cached) return cached;
        const response = await fetch(request);
        if (response.ok) await cache.put(request, response.clone());
        return response;
      }),
    );
    return;
  }

  if (isReceiverAsset) {
    event.respondWith(
      networkFirst(request, SHELL_CACHE, caches.match(request)),
    );
    return;
  }

  if (url.origin === self.location.origin) {
    event.respondWith(
      caches.match(request).then(
        (cached) =>
          cached ||
          fetch(request).then(async (response) => {
            if (response.ok) {
              const cache = await caches.open(SHELL_CACHE);
              await cache.put(request, response.clone());
            }
            return response;
          }),
      ),
    );
  }
});
