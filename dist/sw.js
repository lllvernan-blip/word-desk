/* 单词翻译练习台 · Service Worker
   缓存应用外壳与词库内容，支持离线打开。
   注意：file:// 下 Service Worker 不生效，请通过 http(s) 访问。 */
const CACHE = 'wtp-shell-v32';
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
  const isAudio = url.pathname.includes('/audio/');

  if (isAudio) {
    // 发音包按字节区间读取，Range 请求得到的是 206，Cache API 存不了，直接放行交给浏览器。
    // index.json 走网络优先：音频包重建后偏移会变，旧索引配新分片会解码失败。
    if (req.headers.get('range')) return;
    const isAudioIndex = /\/audio\/index\.json$/.test(url.pathname);
    if (isAudioIndex) {
      event.respondWith(
        fetch(req)
          .then((res) => {
            if (res && res.ok) {
              const copy = res.clone();
              caches.open(CACHE).then((c) => c.put(req, copy));
            }
            return res;
          })
          .catch(() => caches.match(req))
      );
      return;
    }
    event.respondWith(
      caches.match(req).then((hit) => hit || fetch(req).then((res) => {
        if (res && res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
        }
        return res;
      }))
    );
    return;
  }

  // 主脚本与样式走网络优先：否则用户端会长期停在旧 app.js，出现「改了没反应」
  const isShellCode = /\/(app\.js|styles\.css)$/.test(url.pathname);

  if (isDocument || isContent || isShellCode) {
    // 页面、词库内容、主脚本：网络优先，失败回退缓存
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
