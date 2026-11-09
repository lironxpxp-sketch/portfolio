// Offline helper for the trip page: show the last version when there's no signal.
// The page stays encrypted in the cache; the key lives only on the phone.
const CACHE = "trip-v1";
const SHELL = ["./", "../../assets/claude-shim.js?v=9", "./icon-192.png"];
self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", (e) => {
  if (e.request.method !== "GET") return;
  const u = new URL(e.request.url);
  const mine = u.origin === location.origin;
  const font = /(^|\.)fonts\.(googleapis|gstatic)\.com$/.test(u.hostname);
  if (!mine && !font) return; // weather, trip sync, Wikipedia and AI always go to the network
  e.respondWith(
    fetch(e.request).then((r) => {
      if (r.ok || r.type === "opaque") { const copy = r.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); }
      return r;
    }).catch(() => caches.match(e.request, { ignoreSearch: false }).then((m) => m || (e.request.mode === "navigate" ? caches.match("./") : undefined)))
  );
});
