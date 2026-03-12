// sw.js (RiffBank)
// Goal: stop “stuck on old version” after deploys
// Strategy:
// - skipWaiting + clientsClaim (fast activate)
// - network-first for navigations (HTML shell updates)
// - cache-first for static assets
// - versioned caches + cleanup

// Type ./start.sh to start local server

const CACHE_VERSION = "2026-03-12_40"; // <-- bump this when you deploy
const STATIC_CACHE = `riffbank-static-${CACHE_VERSION}`;
const RUNTIME_CACHE = `riffbank-runtime-${CACHE_VERSION}`;

const PRECACHE_URLS = [
  "/",              // important for navigations
  "/index.html",
  "/styles.css",
  "/src/app.js",
  "/manifest.json",
  "/icon-1024.png",
  "/songs-card.jpg",
  "/projects-card.jpg",
  "/releases-card.jpg",
  "/lyrics-card.jpg",
  "/actions-card.jpg",
];

self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "SKIP_WAITING") {
    self.skipWaiting();
  }
});

self.addEventListener("install", (event) => {
  self.skipWaiting(); // activate ASAP
  event.waitUntil(
    caches.open(STATIC_CACHE).then((cache) => cache.addAll(PRECACHE_URLS))
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    // Take control of all clients right away
    await self.clients.claim();

    // Delete old caches
    const keys = await caches.keys();
    await Promise.all(
      keys
        .filter((k) => k.startsWith("riffbank-") && !k.includes(CACHE_VERSION))
        .map((k) => caches.delete(k))
    );
  })());
});

async function networkFirst(request) {
  const cache = await caches.open(RUNTIME_CACHE);
  try {
    const fresh = await fetch(request);
    cache.put(request, fresh.clone());
    return fresh;
  } catch (err) {
    const cached = await cache.match(request);
    return cached || Response.error();
  }
}

async function cacheFirst(request) {
  const cache = await caches.open(STATIC_CACHE);
  const cached = await cache.match(request);
  if (cached) return cached;

  const fresh = await fetch(request);
  cache.put(request, fresh.clone());
  return fresh;
}

self.addEventListener("fetch", (event) => {
  const req = event.request;

  if (req.method !== "GET") return;

  const url = new URL(req.url);

  // Never intercept cross-origin requests (Google auth, APIs, CDNs, etc.)
  if (url.origin !== self.location.origin) return;

  // KEY FIX: navigations (HTML shell) should be network-first
  if (req.mode === "navigate") {
    event.respondWith(networkFirst(req));
    return;
  }

  // Same-origin static assets -> cache-first
  if (url.origin === self.location.origin) {
    const p = url.pathname.toLowerCase();
    const isStatic =
      p.endsWith(".js") ||
      p.endsWith(".css") ||
      p.endsWith(".png") ||
      p.endsWith(".jpg") ||
      p.endsWith(".jpeg") ||
      p.endsWith(".svg") ||
      p.endsWith(".webp") ||
      p.endsWith(".json") ||
      p.endsWith(".ico");

    const isJSON = p.endsWith(".json");
    if (isJSON) {
      event.respondWith(networkFirst(req));
      return;
    }

    if (isStatic) {
      event.respondWith(cacheFirst(req));
      return;
    }
  }

  // Default: network-first
  event.respondWith(networkFirst(req));
});