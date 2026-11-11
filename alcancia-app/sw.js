// Guarda la interfaz para que abra rápido; el saldo siempre viene de la red.
const CACHE = "alcancia-v2";
const ARCHIVOS = ["./", "index.html", "estilos.css", "app.js", "analisis.js", "config.js", "icono.svg", "manifest.webmanifest"];

self.addEventListener("install", (evento) => {
  evento.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(ARCHIVOS)));
});

self.addEventListener("activate", (evento) => {
  evento.waitUntil(
    caches.keys().then((nombres) =>
      Promise.all(nombres.filter((nombre) => nombre !== CACHE).map((nombre) => caches.delete(nombre)))),
  );
});

self.addEventListener("fetch", (evento) => {
  if (new URL(evento.request.url).origin !== self.location.origin) return;
  evento.respondWith(fetch(evento.request).catch(() => caches.match(evento.request)));
});
