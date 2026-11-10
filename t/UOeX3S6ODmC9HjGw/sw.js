// Offline helper and notifications for the trip page.
// The page stays encrypted in the cache; the key lives only on the phone.
const CACHE = "trip-v3";
const SHELL = ["./", "../../assets/claude-shim.js?v=9", "./icon-192.png"];
self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE && k !== "trip-files").map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", (e) => {
  if (e.request.method !== "GET") return;
  const u = new URL(e.request.url);
  const mine = u.origin === location.origin;
  const font = /(^|\.)fonts\.(googleapis|gstatic)\.com$/.test(u.hostname);
  if (!mine && !font) return; // weather, trip sync, Wikipedia and AI always go to the network
  // Pages and app files: always ask the server for the newest copy (falls back to the saved copy offline)
  const req = mine ? new Request(e.request, { cache: "no-cache" }) : e.request;
  e.respondWith(
    fetch(req).then((r) => {
      if (r.ok || r.type === "opaque") { const copy = r.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); }
      return r;
    }).catch(() => caches.match(e.request).then((m) => m || (e.request.mode === "navigate" ? caches.match("./") : undefined)))
  );
});
self.addEventListener("push", (e) => {
  let m = {};
  try { m = e.data ? e.data.json() : {}; } catch { m = { title: "וייטנאם 2026", body: e.data ? e.data.text() : "" }; }
  e.waitUntil(self.registration.showNotification(m.title || "וייטנאם 2026", {
    body: m.body || "", tag: m.tag || undefined, icon: "icon-192.png", badge: "icon-192.png", dir: "rtl", lang: "he", renotify: !!m.tag,
  }));
});
self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  e.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
    for (const c of list) if (c.url.startsWith(self.registration.scope)) return c.focus();
    return self.clients.openWindow("./");
  }));
});
