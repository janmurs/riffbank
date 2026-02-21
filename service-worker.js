/* RiffBank service-worker.js
   - Instant updates (skipWaiting + clientsClaim)
   - Cache-first for same-origin GET requests (fast)
   - Cleans old caches when a new SW activates
*/

const CACHE_PREFIX = "riffbank-cache";
const CACHE_VERSION = `${Date.now()}`; // new cache each deploy (new SW install)
const CACHE_NAME = `${CACHE_PREFIX}-${CACHE_VERSION}`;

self.addEventListener("message", (event) => {
  if (event.data?.type === "SKIP_WAITING") {
    self.skipWaiting();
  }
});

self.addEventListener("install", (event) => {
  // We keep install light to avoid “stuck installing” on iOS.
  event.waitUntil((async () => {
    // Create the cache so it exists (optional).
    await caches.open(CACHE_NAME);
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    // Take control immediately
    await self.clients.claim();

    // Delete old caches
    const keys = await caches.keys();
    await Promise.all(
      keys
        .filter((k) => k.startsWith(CACHE_PREFIX) && k !== CACHE_NAME)
        .map((k) => caches.delete(k))
    );
  })());
});

// Cache strategy: cache-first for same-origin GET, fallback to network
self.addEventListener("fetch", (event) => {
  const req = event.request;

  // Only handle GET
  if (req.method !== "GET") return;

  const url = new URL(req.url);

  // Only same-origin assets/pages
  if (url.origin !== self.location.origin) return;

  // Don’t cache the SW file itself
  if (url.pathname.endsWith("/service-worker.js")) return;

  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);
    const cached = await cache.match(req);

    if (cached) return cached;

    try {
      const fresh = await fetch(req);

      // Cache successful/basic responses (avoid opaque weirdness)
      if (fresh && (fresh.status === 200 || fresh.type === "basic")) {
        cache.put(req, fresh.clone()).catch(() => {});
      }
      return fresh;
    } catch (err) {
      // If offline and we had a cached copy, use it
      if (cached) return cached;
      throw err;
    }
  })());
});
