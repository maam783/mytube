// Offline-Schale. Nur die App-Dateien werden gecacht — niemals API-Antworten.
//
// Beim Ändern der App die Version hochzählen, sonst serviert das iPad die alte
// Fassung weiter. In den Einstellungen gibt es dafür auch einen Update-Knopf.

const VERSION = 'v9';
const CACHE = `mytube-${VERSION}`;

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
        // Eine 404- oder 500-Antwort ist technisch erfolgreich, aber für die App
        // wertlos. Ohne diese Prüfung würde bei einer GitHub-Störung die
        // Fehlerseite durchgereicht, statt die gecachte App zu starten.
        if (!response || !response.ok) throw new Error(`HTTP ${response?.status}`);
        const copy = response.clone();
        caches.open(CACHE).then((cache) => cache.put(request, copy));
        return response;
      })
      .catch(async () => {
        const treffer = await caches.match(request);
        if (treffer) return treffer;
        if (request.mode === 'navigate') {
          const schale = await caches.match('./index.html');
          if (schale) return schale;
        }
        // Lieber eine verständliche Meldung als eine kryptische Browser-Fehlerseite.
        return new Response('MyTube ist offline und diese Datei liegt nicht im Zwischenspeicher.',
          { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
      }),
  );
});

self.addEventListener('message', (event) => {
  if (event.data === 'skipWaiting') self.skipWaiting();
});
