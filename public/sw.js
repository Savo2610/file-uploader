// Service Worker der Abhol-Seite.
//
// Er ist nicht da, um Daten zu sparen, sondern weil Android nur dann eine
// echte App auf den Startbildschirm legt – mit eigenem Symbol statt einer
// Verknüpfung mit Chrome-Logo in der Ecke –, wenn es ein Manifest UND einen
// Service Worker mit fetch-Behandlung gibt.
//
// Wichtig: hier wird ausschließlich das Gerüst der Seite zwischengespeichert.
// Alles unter /api/ – Dateilisten, Texte, die Dateien selbst – geht immer ans
// Netz und landet nie in einem Cache. Das ist kein Detail: gespeicherte
// Antworten blieben auf dem Gerät liegen, auch nachdem die Sitzung abgelaufen
// oder die Datei gelöscht ist.

const CACHE = 'abholen-v1';

const GERUEST = [
  '/',
  '/style.css',
  '/icons/abholen-192.png',
  '/icons/abholen-512.png',
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE)
      .then(c => c.addAll(GERUEST))
      // Eine einzelne fehlende Datei darf die Installation nicht verhindern –
      // sonst wäre die Seite gar nicht mehr installierbar.
      .catch(() => {})
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    for (const name of await caches.keys()) {
      if (name !== CACHE) await caches.delete(name);
    }
    await self.clients.claim();
  })());
});

// ── Benachrichtigungen ──────────────────────────────────────────────────────
//
// Die Nutzlast kommt verschlüsselt an; entschlüsselt hat sie der Browser
// bereits, bevor er hier ankommt. Der Push-Dienst dazwischen hat den
// Dateinamen nie gesehen.

self.addEventListener('push', event => {
  let daten = {};
  try { daten = event.data ? event.data.json() : {}; } catch { /* dann eben ohne */ }

  // Angemeldet wurde mit userVisibleOnly – es MUSS also etwas angezeigt
  // werden, auch wenn die Nutzlast unterwegs verloren ging.
  event.waitUntil(self.registration.showNotification(
    daten.titel || 'Etwas ist angekommen',
    {
      body: daten.text || '',
      icon: '/icons/abholen-192.png',
      badge: '/icons/abholen-192.png',
      // Gleicher tag: eine neue Meldung ersetzt die alte, statt sich zu
      // stapeln. Die Zahl steht ohnehin schon im Titel.
      tag: 'abholen',
      renotify: true,
    },
  ));
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil((async () => {
    // Ist die App schon offen, dorthin – sonst öffnet jeder Tipp einen
    // weiteren Tab.
    const offen = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of offen) {
      if (new URL(c.url).origin === self.location.origin) return c.focus();
    }
    return self.clients.openWindow('/');
  })());
});

self.addEventListener('fetch', event => {
  const { request } = event;
  const url = new URL(request.url);

  // Nichts anfassen, was nicht zum Gerüst gehören kann.
  if (request.method !== 'GET') return;
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/')) return;

  // Seitenaufrufe: erst das Netz, damit eine neue Fassung sofort ankommt.
  // Der Cache ist nur der Rettungsanker ohne Verbindung – dann steht das
  // Codefeld da, statt der Fehlerseite des Browsers.
  if (request.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        const res = await fetch(request);
        const cache = await caches.open(CACHE);
        cache.put('/', res.clone());
        return res;
      } catch {
        return (await caches.match('/')) || Response.error();
      }
    })());
    return;
  }

  // Stylesheet und Symbole: erst aus dem Cache, im Hintergrund erneuern.
  event.respondWith((async () => {
    const treffer = await caches.match(request);
    const frisch = fetch(request).then(res => {
      if (res.ok) caches.open(CACHE).then(c => c.put(request, res.clone()));
      return res;
    }).catch(() => null);
    return treffer || (await frisch) || Response.error();
  })());
});
