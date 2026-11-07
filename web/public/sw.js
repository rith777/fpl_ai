// Offline support for the home-screen app. The page and data are fetched fresh
// when online and served from the cache when not; hashed build assets never
// change, so they come from the cache once seen. Live FPL calls are left alone.
const CACHE = "fpl-ai";

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin || url.pathname.startsWith("/fpl/")) return;
  if (url.pathname.startsWith("/assets/")) {
    e.respondWith(caches.match(e.request).then((hit) => hit || fetch(e.request).then(keep(e.request))));
  } else {
    e.respondWith(fetch(e.request).then(keep(e.request))
      .catch(() => caches.match(e.request, { ignoreSearch: true }).then((hit) => hit || Response.error())));
  }
});

const keep = (req) => (res) => {
  if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); }
  return res;
};
