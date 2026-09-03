/* アプリ本体はキャッシュしてオフラインでも起動できるようにする。
   地図タイルは別扱いで、一度見た範囲だけを上限つきで貯める。
   ファイルを更新したら SHELL の版を上げること。 */
const SHELL = 'trailmap-shell-v6';
const TILES = 'trailmap-tiles-v1';
const TILE_LIMIT = 1200;

const ASSETS = [
  './', './index.html', './style.css',
  './geo.js', './exif.js', './store.js', './minimap.js',
  './supa.js', './social.js', './social-ui.js', './app.js',
  './manifest.webmanifest', './icon-192.png', './icon-512.png',
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(SHELL)
      .then(c => Promise.allSettled(ASSETS.map(a => c.add(a))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== SHELL && k !== TILES).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

/** 貯めすぎないよう、古いタイルから捨てる */
async function trimTiles(cache) {
  const keys = await cache.keys();
  if (keys.length <= TILE_LIMIT) return;
  for (const k of keys.slice(0, keys.length - TILE_LIMIT)) await cache.delete(k);
}

// 通知をタップしたら、開いているアプリに戻る (無ければ開く)
self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil((async () => {
    const list = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of list) {
      if (c.url.includes('/map/') && 'focus' in c) return c.focus();
    }
    if (self.clients.openWindow) return self.clients.openWindow('./index.html');
  })());
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // 地図タイル: まずキャッシュ、無ければ取得して保存 (オフラインでも一度見た範囲は出る)
  if (/\/\d+\/\d+\/\d+\.png$/.test(url.pathname)) {
    e.respondWith(
      caches.open(TILES).then(async cache => {
        const hit = await cache.match(req);
        if (hit) return hit;
        try {
          const res = await fetch(req);
          if (res && res.ok) { await cache.put(req, res.clone()); trimTiles(cache); }
          return res;
        } catch (err) {
          return new Response('', { status: 504 });   // 圏外では空タイル
        }
      })
    );
    return;
  }

  if (url.origin !== self.location.origin) return;

  e.respondWith(
    caches.match(req).then(hit => hit || fetch(req).then(res => {
      if (res && res.ok) {
        const copy = res.clone();
        caches.open(SHELL).then(c => c.put(req, copy));
      }
      return res;
    }).catch(() => caches.match('./index.html')))
  );
});
