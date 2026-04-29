// 缓存名称，更新 SW 后需修改版本号
const CACHE_NAME = 'anjian-v1';

// 需要预缓存的所有资源（路径相对于网站根目录）
const PRECACHE_URLS = [
  'index.html',
  'manifest.json',
  // CDN 依赖（必须全部列出，否则离线会失效）
  'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/2.16.105/pdf.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/2.16.105/pdf.worker.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/mammoth/1.4.2/mammoth.browser.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/fuse.js/6.6.2/fuse.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/pinyin/2.11.0/pinyin.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js'
];

// 安装事件：预缓存所有核心资源
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => {
        console.log('正在缓存关键资源...');
        // 逐个添加，避免单个失败导致全部回滚
        return Promise.allSettled(
          PRECACHE_URLS.map(url => 
            cache.add(url).catch(err => {
              console.warn('缓存失败: ' + url, err);
            })
          )
        );
      })
      .then(() => {
        console.log('预缓存完成，立即激活');
        return self.skipWaiting();
      })
  );
});

// 激活事件：清理旧缓存
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(cacheNames => {
      return Promise.all(
        cacheNames
          .filter(name => name !== CACHE_NAME)
          .map(name => caches.delete(name))
      );
    }).then(() => self.clients.claim())
  );
});

// 请求拦截：优先使用缓存，同时更新缓存（Stale-While-Revalidate）
self.addEventListener('fetch', event => {
  // 只处理 GET 请求
  if (event.request.method !== 'GET') return;
  
  event.respondWith(
    caches.open(CACHE_NAME).then(cache => {
      return cache.match(event.request).then(cachedResponse => {
        // 后台发起网络请求更新缓存
        const fetchPromise = fetch(event.request)
          .then(networkResponse => {
            // 只缓存成功响应（状态码 200）
            if (networkResponse && networkResponse.status === 200) {
              cache.put(event.request, networkResponse.clone());
            }
            return networkResponse;
          })
          .catch(() => {
            // 网络失败，依赖缓存（已经返回 cachedResponse）
          });

        // 如果有缓存，立即返回；否则等待网络请求
        return cachedResponse || fetchPromise;
      });
    })
  );
});