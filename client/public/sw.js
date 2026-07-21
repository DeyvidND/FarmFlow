// Offline service worker for the roadside „Проверка" check screen (Task 15).
//
// The headline use case: a courier is pulled over with no signal and must show
// the day's signed handover protocols immediately. In production the Next
// server is remote, so a signal-less phone can't fetch the page shell at all —
// IndexedDB (see src/lib/protocol-cache.ts) can only help once the page itself
// has loaded. This worker caches the check screen + its build assets so the
// shell can load with zero network, then the page's own cache-first logic
// takes over for the protocol data.
//
// Deliberately narrow (YAGNI): no manifest, no precaching the whole app, no
// push/background sync — just enough to make one screen work offline.
const CACHE = 'ff-check-v1';
const SHELL = '/protocols/check';

self.addEventListener('install', (e) => {
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // NEVER intercept the API/BFF — those must fail loudly so the page falls
  // back to its IndexedDB cache and shows the offline banner. Silently
  // serving a stale API response to a police officer would be worse than
  // showing nothing.
  if (url.pathname.startsWith('/bff/') || url.pathname.startsWith('/api/')) return;

  // Immutable hashed build assets → cache-first.
  //
  // Only true for a production build. `next dev` reuses the SAME chunk URL across
  // recompiles, so cache-first there pins the first version of a chunk forever and
  // your edits silently stop appearing — the page renders, no error, just stale
  // code. Cost real debugging time once already; skip the whole branch on
  // localhost so dev always hits the network.
  const isDevHost = self.location.hostname === 'localhost' || self.location.hostname === '127.0.0.1';
  if (!isDevHost && url.pathname.startsWith('/_next/static/')) {
    event.respondWith(
      caches.match(req).then(
        (hit) =>
          hit ||
          fetch(req).then((res) => {
            if (res.ok) {
              const c = res.clone();
              caches.open(CACHE).then((ca) => ca.put(req, c));
            }
            return res;
          }),
      ),
    );
    return;
  }

  // The check screen itself → network-first, fall back to the cached copy.
  const isCheckNav = req.mode === 'navigate' && url.pathname === SHELL;
  if (isCheckNav) {
    event.respondWith(
      fetch(req)
        .then((res) => {
          if (res.ok) {
            const c = res.clone();
            caches.open(CACHE).then((ca) => ca.put(SHELL, c));
          }
          return res;
        })
        .catch(() => caches.match(SHELL).then((hit) => hit || Response.error())),
    );
  }
});
