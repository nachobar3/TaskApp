// Service worker mínimo para instalabilidad PWA. Pasamanos de red sin caché:
// la app es local y de tiempo real (poll cada 2s) — cachear /api mostraría
// estado viejo, y los assets los sirve el server de al lado sin latencia.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});
self.addEventListener("fetch", (event) => {
  event.respondWith(fetch(event.request));
});
