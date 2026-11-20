// Risk Desk service worker: works offline after the first load.
// Precaches the app files and every data file listed in data/index.json, then serves them cache-first.
// The cache name carries VERSION: the app version plus a fingerprint of every cached file, written by
// `node tools/stamp-sw.mjs`. Run it after changing any app or data file, so phones fetch the new files
// (the page offers a Reload when the new version is ready); a test fails while VERSION is stale.
// Old caches are deleted. Only this app's own files are cached. Nothing else is fetched.

const VERSION = '1.0.0-4300615454e6';
const CACHE = `risk-desk-${VERSION}`;
const SHELL = [
  './',
  'index.html',
  'styles.css',
  'manifest.webmanifest',
  'app/main.js',
  'app/ui.js',
  'app/store.js',
  'app/screens/trade.js',
  'app/screens/accounts.js',
  'app/screens/journal.js',
  'app/screens/rules.js',
  'app/screens/backup.js',
  'engine/calc.js',
  'icons/icon.svg',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/apple-touch-icon.png',
  'data/index.json',
];

// Same reading of data/index.json as the app (app/ui.js dataPathsFromIndex): paths stay inside data/.
function dataPaths(index) {
  const out = [];
  const add = (entry) => {
    let p = typeof entry === 'string' ? entry : entry && typeof entry === 'object' ? (entry.path || entry.file || entry.href) : null;
    if (typeof p !== 'string') return;
    p = p.trim().replace(/^\.\//, '');
    if (!p || p.includes('..') || p.includes('://') || p.startsWith('/') || !p.endsWith('.json')) return;
    if (!p.startsWith('data/')) p = 'data/' + p;
    if (p !== 'data/index.json' && !out.includes(p)) out.push(p);
  };
  const walk = (v) => {
    if (Array.isArray(v)) v.forEach((e) => (Array.isArray(e) || (e && typeof e === 'object' && !e.path && !e.file && !e.href) ? walk(e) : add(e)));
    else if (v && typeof v === 'object') for (const k of ['files', 'firms', 'instruments']) if (v[k]) walk(v[k]);
  };
  walk(index);
  return out;
}

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    // The app shell must be complete, or this version doesn't install (the old one keeps working).
    await cache.addAll(SHELL.map((u) => new Request(u, { cache: 'reload' })));
    // Data files: each one that loads is cached; a missing one is reported by the app itself.
    try {
      const res = await cache.match('data/index.json');
      const files = dataPaths(await res.json());
      await Promise.all(files.map((f) => cache.add(new Request(f, { cache: 'reload' })).catch((err) => console.warn('Not cached:', f, err))));
    } catch (err) {
      console.warn('Data files not cached:', err);
    }
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.filter((n) => n.startsWith('risk-desk-') && n !== CACHE).map((n) => caches.delete(n)));
    await self.clients.claim();
  })());
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const hit = await cache.match(req, { ignoreSearch: req.mode === 'navigate' });
    if (hit) return hit;
    try {
      const res = await fetch(req);
      if (res.ok && res.type === 'basic') cache.put(req, res.clone());
      return res;
    } catch (err) {
      if (req.mode === 'navigate') {
        const shell = await cache.match('index.html');
        if (shell) return shell;
      }
      throw err;
    }
  })());
});
