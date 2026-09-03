const VERSION = "atlas-pwa-v279-dynamic-pallet-completion-label";
const SHELL_CACHE = `${VERSION}-shell`;
const DATA_CACHE = `${VERSION}-warehouse-data`;

const APP_SHELL = [
  "./",
  "./index.html",
  "./atlas-dashboard.css?v=156",
  "./atlas-dashboard.js?v=163",
  "./atlas-auth.css?v=3",
  "./atlas-auth.js?v=6",
  "./atlas-coc.css?v=58",
  "./atlas-zxing-browser.min.js?v=1",
  "./atlas-coc-scanner.js?v=7",
  "./atlas-coc-parser.js?v=11",
  "./atlas-coc-case-quantities.js?v=3",
  "./atlas-coc-core.js?v=21",
  "./atlas-jszip.min.js?v=1",
  "./atlas-coc-storage.js?v=4",
  "./atlas-coc-delivery.js?v=7",
  "./atlas-coc-excel.js?v=18",
  "./atlas-coc.js?v=67",
  "./coc-receiver/index.html",
  "./coc-receiver/receiver.css?v=19",
  "./coc-receiver/receiver.js?v=18",
  "./atlas-guided-workflows.css?v=4",
  "./atlas-guided-workflows.js?v=4",
  "./atlas-restock.css?v=3",
  "./atlas-restock.js?v=3",
  "./atlas-delete-approval.js?v=1",
  "./atlas-desktop.css?v=145",
  "./atlas-desktop-menu-typography.css?v=1",
  "./atlas-alerts.css?v=2",
  "./atlas-mobile-menu.css?v=2",
  "./atlas-desktop.js?v=131",
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

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  const isNavigation = request.mode === "navigate";
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
        caches.match(url.pathname.startsWith("/coc-receiver")
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
    event.respondWith(networkFirst(request, DATA_CACHE, unavailable));
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
