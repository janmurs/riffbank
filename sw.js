// sw.js (RiffBank)
// Goal: stop “stuck on old version” after deploys
// Strategy:
// - skipWaiting + clientsClaim (fast activate)
// - network-first for navigations (HTML shell updates)
// - cache-first for static assets
// - versioned caches + cleanup

// Type ./start.sh to start local server

const CACHE_VERSION = "2026-04-03_8"; // <-- bump this when you deploy
const STATIC_CACHE = `riffbank-static-${CACHE_VERSION}`;
const RUNTIME_CACHE = `riffbank-runtime-${CACHE_VERSION}`;

const PRECACHE_URLS = [
  "/",              // important for navigations
  "/index.html",
  "/styles.css",
  "/src/app.js",
  "/src/supabase.js",
  "/src/ui/dom.js",
  "/src/splash/splash.js",
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
  const url = new URL(req.url);

  // Handle Web Share Target POST — stash the shared file, then redirect
  if (req.method === "POST" && url.pathname === "/" && url.searchParams.has("share-target")) {
    event.respondWith((async () => {
      try {
        const formData = await req.formData();
        const file = formData.get("audio");
        if (file && file.size > 0) {
          // Store in a temporary cache so the app can pick it up
          const cache = await caches.open("riffbank-share-target");
          await cache.put("shared-audio-file", new Response(file, {
            headers: {
              "X-File-Name": encodeURIComponent(file.name || "audio"),
              "X-File-Type": file.type || "audio/*",
              "X-File-Size": String(file.size || 0),
            }
          }));
        }
      } catch (err) {
        console.error("[SW] share-target error:", err);
      }
      // Redirect to app with a flag so the client knows to check for the file
      return Response.redirect("/?shared=1", 303);
    })());
    return;
  }

  if (req.method !== "GET") return;

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

// ── Push Notifications ──

// Handle push events (from server-side push, if implemented later)
self.addEventListener("push", (event) => {
  const data = event.data ? event.data.json() : {};
  const title = data.title || "RiffBank";
  const options = {
    body: data.body || "You have a new notification",
    icon: "/icon-1024.png",
    badge: "/icon-1024.png",
    tag: data.tag || "riffbank-notification",
    renotify: true,
    data: { url: data.url || "/" },
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

// Handle notification click — focus or open the app
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = event.notification.data?.url || "/";
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(clients => {
      // Focus existing tab if found
      for (const client of clients) {
        if (client.url.includes(self.location.origin) && "focus" in client) {
          return client.focus();
        }
      }
      // Otherwise open new window
      return self.clients.openWindow(url);
    })
  );
});