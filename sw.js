// Offline-Schale. Nur die App-Dateien werden gecacht — niemals API-Antworten.
//
// Beim Ändern der App die Version hochzählen, sonst serviert das iPad die alte
// Fassung weiter. In den Einstellungen gibt es dafür auch einen Update-Knopf.

const VERSION = 'v3';
const CACHE = `privatetube-${VERSION}`;

const SHELL = [
  './',
  './index.html',
  './manifest.webmanifest',
  './css/style.css',
  './js/main.js',
  './js/db.js',
  './js/settings.js',
  './js/youtube.js',
  './js/ai.js',
  './js/rank.js',
  './js/sync.js',
  './js/anthropic.js',
  './icon.svg',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE)
      // Einzeln, damit eine fehlende Datei nicht die ganze Installation kippt.
      // `no-cache` auch hier — sonst installiert sich der neue Worker mit den
      // alten Dateien aus dem HTTP-Cache.
      .then((cache) => Promise.all(SHELL.map(
        (url) => cache.add(new Request(url, { cache: 'no-cache' })).catch(() => null))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  // Fremde Hosts (googleapis, anthropic, youtube) gehen den Service Worker nichts an.
  if (url.origin !== self.location.origin) return;

  // GitHub Pages liefert `Cache-Control: max-age=600`. Ohne `no-cache` würde
  // der HTTP-Cache des Browsers dem Service Worker eine veraltete Datei geben,
  // die dieser dann dauerhaft einfriert — ein Deploy käme nie an. `no-cache`
  // erzwingt eine Rückfrage beim Server; unverändert kostet das nur ein 304.
  const revalidating = new Request(request, { cache: 'no-cache' });

  event.respondWith(
    // Netz zuerst, damit ein Deploy sofort ankommt; Cache als Rückfallebene,
    // damit die App im Flugzeug oder bei totem Hotel-WLAN trotzdem startet.
    fetch(revalidating)
      .then((response) => {
        if (response && response.ok) {
          const copy = response.clone();
          caches.open(CACHE).then((cache) => cache.put(request, copy));
        }
        return response;
      })
      .catch(() => caches.match(request).then((hit) => hit
        || (request.mode === 'navigate' ? caches.match('./index.html') : undefined))),
  );
});

self.addEventListener('message', (event) => {
  if (event.data === 'skipWaiting') self.skipWaiting();
});
