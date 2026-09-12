// ============================================================================
//  Service Worker — deliberately minimal (no Workbox), and deliberately
//  narrow in what it caches.
//
//  SAFETY NOTE: this app talks to Supabase for live booking/availability data.
//  A service worker that caches those responses is how a customer ends up
//  booking a slot the cache still thinks is free. So the rule here is simple:
//    • Same-origin STATIC assets (JS/CSS/fonts/icons) → cache-first.
//    • Everything else (HTML navigation, and every cross-origin request —
//      which covers 100% of Supabase calls, since they go to *.supabase.co,
//      never this origin) → network-only, no caching, straight pass-through.
//  This is why there's no "network-first for API calls" branch below: API
//  calls are never same-origin here, so they never even reach the cache logic.
// ============================================================================
const CACHE_NAME = "salon-static-v1";
const OFFLINE_URL = "/offline.html";

const PRECACHE_URLS = [
  "/",
  "/manifest.json",
  "/icon-192.png",
  "/icon-512.png",
  OFFLINE_URL,
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(PRECACHE_URLS)).catch(() => {})
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((names) =>
      Promise.all(names.filter((n) => n !== CACHE_NAME).map((n) => caches.delete(n)))
    )
  );
  self.clients.claim();
});

function isStaticAsset(url) {
  return /\.(js|css|woff2?|ttf|otf|png|svg|jpg|jpeg|webp|ico)$/i.test(url.pathname);
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // Cross-origin (Supabase, fonts CDN, etc.) — never intercept. Let the
  // browser handle it exactly as if this service worker didn't exist.
  if (url.origin !== self.location.origin) return;

  // Only ever cache GETs — never touch POST/PATCH/DELETE traffic.
  if (request.method !== "GET") return;

  if (isStaticAsset(url)) {
    event.respondWith(
      caches.match(request).then((cached) => {
        if (cached) return cached;
        return fetch(request)
          .then((response) => {
            const clone = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(request, clone)).catch(() => {});
            return response;
          })
          .catch(() => cached);
      })
    );
    return;
  }

  // HTML navigations: always go to the network first (fresh app shell), and
  // only fall back to the offline page if the network is truly unreachable.
  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request).catch(() => caches.match(OFFLINE_URL))
    );
  }
});
