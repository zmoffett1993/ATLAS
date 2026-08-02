const VERSION = "atlas-pwa-v62-control-center-step-1";
const SHELL_CACHE = `${VERSION}-shell`;
const DATA_CACHE = `${VERSION}-warehouse-data`;

const APP_SHELL = [
  "./",
  "./index.html",
  "./manifest.webmanifest",
  "./product-images.json",
  "./atlas-192.png",
  "./atlas-512.png",
  "./atlas-maskable-512.png",
  "./apple-touch-icon.png",
  "./favicon-32.png",
  "./atlas-warehouse-management.png",
  "./atlas-home-logo-v2.png",
  "./atlas-home-lockup-v3.png",
  "./atlas-command-center-menu.jpeg",
  "./chubby-gorilla-about-v2.jpeg",
  "./chubby-gorilla-header-v2.png",
  "./atlas-menu-brand-lockup.png",
  "./atlas-menu-lockup-v2.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE).then((cache) => cache.addAll(APP_SHELL)),
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
      networkFirst(request, SHELL_CACHE, caches.match("./index.html")),
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
