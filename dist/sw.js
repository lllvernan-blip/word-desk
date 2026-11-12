/* 单词翻译练习台 · Service Worker
   缓存应用外壳与词库内容，支持离线打开。
   注意：file:// 下 Service Worker 不生效，请通过 http(s) 访问。 */
const CACHE = 'wtp-shell-v66';
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
  './content/roots.json',
  './content/sensitive.json',
  // examples.json 不进预缓存：默认关闭，开启时才按需拉取；从未联网加载过时，离线看不到例句（不阻塞练习）
  './audio/index.json'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(CORE.map((url) => new Request(url, { cache: 'reload' })))).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys
        .filter((k) => k.startsWith('wtp-shell-') && k !== CACHE) // 只清旧壳，音频缓存按 index.v 由页面管
        .map((k) => caches.delete(k))))
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
        fetch(req, { cache: 'no-cache' })
          .then((res) => {
            if (res && res.ok) {
              const copy = res.clone();
              caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
              return res;
            }
            return caches.match(req).then((hit) => hit || res);
          })
          .catch(() => caches.match(req).then((hit) => hit || Response.error()))
      );
      return;
    }
    event.respondWith(
      caches.match(req).then((hit) => hit || fetch(req, { cache: 'no-cache' }).then((res) => {
        if (res && res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
        }
        return res;
      }))
    );
    return;
  }

  // 敏感词表：命中缓存先返回，后台再更新。
  // 理由：这张表卡在首屏渲染之前（app 里 await），走网络优先等于让每次启动多等一个往返；
  // 而它已在 install 阶段进 CORE，缓存命中率接近 100%。
  // 取舍：允许本次会话用上一版词表（该表极少变，且改动只影响「哪些中危词能进干扰项」）。
  // 边界：缓存与网络都没有时请求失败，页面侧降级为「只保留内置 5 个高危剔除词 + 释义正则」。
  const isSensitive = /\/content\/sensitive\.json$/.test(url.pathname);
  if (isSensitive) {
    event.respondWith(
      caches.match(req).then((hit) => {
        const network = fetch(req, { cache: 'no-cache' }).then((res) => {
          if (res && res.ok) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
          }
          return res;
        }).catch(() => hit || Response.error());
        event.waitUntil(network.then(() => {}));
        return hit || network;
      })
    );
    return;
  }

  // 主脚本与样式走网络优先：否则用户端会长期停在旧 app.js，出现「改了没反应」
  const isShellCode = /\/(app\.js|styles\.css)$/.test(url.pathname);

  if (isDocument || isContent || isShellCode) {
    // 页面、词库内容、主脚本：网络优先，失败回退缓存
    event.respondWith(
      fetch(req, { cache: 'no-cache' })
        .then((res) => {
          if (res && res.ok) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
            return res;
          }
          return caches.match(req).then((hit) => hit || res);
        })
        .catch(() => caches.match(req).then((hit) => hit || (isDocument ? caches.match('./index.html') : Response.error())))
    );
    return;
  }

  // 静态资源：缓存优先，后台更新
  event.respondWith(
    caches.match(req).then((hit) => {
      const network = fetch(req, { cache: 'no-cache' }).then((res) => {
        if (res && res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
        }
        return res;
      }).catch(() => hit || Response.error());
      event.waitUntil(network.then(() => {}));
      return hit || network;
    })
  );
});
