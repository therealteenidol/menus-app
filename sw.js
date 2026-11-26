// Service worker: guarda la "carcasa" de la app para que abra rápido y funcione como app instalada.
// Los datos (Supabase) siempre van por red.
const CACHE = "menus-v1";
const SHELL = [
  "./", "./index.html", "./styles.css", "./config.js", "./js/app.js", "./js/shopping.js",
  "./manifest.webmanifest", "./icons/icon.svg", "./icons/icon-192.png",
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET") return;
  // Librería de Supabase desde el CDN: caché primero (la versión está fijada)
  if (url.hostname === "cdn.jsdelivr.net") {
    e.respondWith(caches.match(e.request).then((r) => r || fetch(e.request).then((res) => {
      const copy = res.clone();
      caches.open(CACHE).then((c) => c.put(e.request, copy));
      return res;
    })));
    return;
  }
  if (url.origin !== location.origin) return;
  // Archivos de la app: red primero (para recibir actualizaciones) y caché si no hay conexión
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy));
        return res;
      })
      .catch(() => caches.match(e.request).then((r) => r || caches.match("./index.html"))),
  );
});
