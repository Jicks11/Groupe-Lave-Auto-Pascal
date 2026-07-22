/* Service worker minimal — icône / installation écran d'accueil */
const CACHE = "lave-auto-shell-v1";
const SHELL = ["./", "index.html", "styles.css", "app.js", "manifest.webmanifest"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  // Ne pas cacher l'API (soldes live)
  if (url.pathname.startsWith("/api/")) return;
  event.respondWith(
    fetch(event.request)
      .then((res) => res)
      .catch(() => caches.match(event.request).then((r) => r || caches.match("./")))
  );
});
