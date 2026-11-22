// Offline cache for the app shell. The AI endpoint (api/) is never cached.
const CACHE = 'baymax-v11';
const SHELL = [
  './', 'index.html', 'css/app.css', 'icon.svg', 'manifest.webmanifest',
  'icons/apple-touch-icon.png', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/icon-maskable-512.png', 'icons/favicon-32.png',
  'js/app.js', 'js/store.js', 'js/parser.js', 'js/timeparse.js', 'js/actions.js', 'js/routines.js', 'js/scheduler.js',
  'js/voice.js', 'js/ai.js', 'js/main.js', 'js/auth.js', 'js/config.js', 'js/cloud.js', 'js/sync.js', 'js/bankparse.js', 'js/bankfeed.js', 'js/statement.js', 'js/importui.js', 'js/zerodha.js', 'js/mail.js', 'js/vault.js', 'js/keystore.js', 'js/gate.js', 'js/mailtriage.js', 'js/mailtasks.js', 'vendor/supabase-2.117.2.js', 'js/finance.js', 'js/money.js', 'js/money-actions.js', 'js/dashboard.js', 'js/sheet.js', 'js/avatar.js',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

// Network first (so updates show up straight away), falling back to the cache when offline.
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin || url.pathname.includes('/api/')) return;
  e.respondWith(caches.open(CACHE).then(async (cache) => {
    try {
      const res = await fetch(e.request);
      if (res.ok) cache.put(e.request, res.clone());
      return res;
    } catch {
      return (await cache.match(e.request, { ignoreSearch: true })) || (await cache.match('index.html'));
    }
  }));
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  e.waitUntil(self.clients.matchAll({ type: 'window' }).then((list) => {
    const client = list.find((c) => 'focus' in c);
    return client ? client.focus() : self.clients.openWindow('./');
  }));
});
