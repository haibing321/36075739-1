const CACHE_NAME = 'railway-safety-v6';
const STATIC_ASSETS = [
  './',
  './index.html',
  './manifest.json'
];

// 安装时缓存静态资源
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      console.log('缓存静态资源');
      return cache.addAll(STATIC_ASSETS);
    }).catch(err => {
      console.log('静态资源缓存失败（非关键）:', err);
    })
  );
  self.skipWaiting();
});

// 激活时清理旧缓存
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames
          .filter((name) => name !== CACHE_NAME)
          .map((name) => caches.delete(name))
      );
    })
  );
  self.clients.claim();
});

//  fetch事件处理 - 网络优先策略（对API/动态数据），缓存优先（对静态资源）
self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // 对HTML使用网络优先（确保获取最新版本）
  if (request.mode === 'navigate' || request.destination === 'document') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          // 网络成功，更新缓存
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
          return response;
        })
        .catch(() => {
          // 网络失败，回退缓存
          return caches.match(request).then((response) => {
            return response || new Response('<h1>离线模式</h1><p>当前无网络连接，且未缓存该页面。</p>', {
              headers: { 'Content-Type': 'text/html' }
            });
          });
        })
    );
    return;
  }

  // 对CDN资源（JS/CSS）使用缓存优先，带网络回退和更新
  if (url.hostname.includes('cdn.jsdelivr.net') || url.hostname.includes('unpkg')) {
    event.respondWith(
      caches.match(request).then((response) => {
        if (response) {
          // 返回缓存，同时后台更新
          fetch(request).then((networkResponse) => {
            if (networkResponse.ok) {
              caches.open(CACHE_NAME).then((cache) => {
                cache.put(request, networkResponse.clone());
              });
            }
          }).catch(() => {});
          return response;
        }
        // 缓存未命中，网络获取并缓存
        return fetch(request).then((networkResponse) => {
          if (networkResponse.ok) {
            const clone = networkResponse.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
          }
          return networkResponse;
        }).catch(() => {
          return new Response('// 资源加载失败', { status: 408 });
        });
      })
    );
    return;
  }

  // 其他资源：缓存优先
  event.respondWith(
    caches.match(request).then((response) => {
      return response || fetch(request).then((networkResponse) => {
        if (networkResponse.ok) {
          const clone = networkResponse.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
        }
        return networkResponse;
      });
    }).catch(() => {
      return new Response('离线模式', { status: 503 });
    })
  );
});

// 后台同步（用于未来可能的离线数据同步功能）
self.addEventListener('sync', (event) => {
  if (event.tag === 'background-sync') {
    console.log('后台同步触发');
  }
});
