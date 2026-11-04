/* 单词翻译练习台 · Service Worker
   缓存应用外壳与词库内容，支持离线打开。
   注意：file:// 下 Service Worker 不生效，请通过 http(s) 访问。 */
const CACHE = 'wtp-shell-v29';
const CORE = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './words-core.js',
  './words.js',
  './roots-data.js',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
  './content/manifest.json',
  './content/words-extra.json',
  './content/roots.json'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => Promise.all(CORE.map((url) =>
      cache.add(url).catch(() => null)
    ))).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  const isDocument = req.mode === 'navigate' || (req.headers.get('accept') || '').includes('text/html');
  const isContent = url.pathname.includes('/content/');

  if (isDocument || isContent) {
    // 页面与词库内容：网络优先，失败回退缓存
    event.respondWith(
      fetch(req)
        .then((res) => {
          if (res && res.ok) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(req, copy));
          }
          return res;
        })
        .catch(() => caches.match(req).then((hit) => hit || caches.match('./index.html')))
    );
    return;
  }

  // 静态资源：缓存优先，后台更新
  event.respondWith(
    caches.match(req).then((hit) => {
      const network = fetch(req).then((res) => {
        if (res && res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
        }
        return res;
      }).catch(() => hit);
      return hit || network;
    })
  );
});
