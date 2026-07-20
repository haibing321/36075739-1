/**
 * 安监智能辅助系统 - Service Worker v1
 * 策略: AppShell precache + CDN runtime cache + NetworkFirst for HTML
 */

var CACHE_PREFIX = 'aj-v';
// 使用时间戳作为缓存版本，每次部署自动更新，确保用户获取最新资源
var CACHE_VERSION = '20260720223601';
var CACHE_NAME = CACHE_PREFIX + CACHE_VERSION;

// ========== 预缓存资源列表（App Shell）==========
var PRECACHE_URLS = [
  './',
  './index.html',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-svg.svg',
  // ==== 本地CSS（离线时保证样式正常）====
  './src/css/variables.css',
  './src/css/layout.css',
  './src/css/components.css',
  './src/css/modules.css',
  './src/css/responsive.css',
  // ==== 本地JS模块（离线时功能可用）====
  './src/js/app.js',
  './src/js/modules/utils.js',
  './src/js/modules/errorMonitor.js',
  './src/js/modules/perfMonitor.js',
  './src/js/modules/pinyin.js',
  './src/js/modules/issue.js',
  './src/js/modules/rule.js',
  './src/js/modules/diary.js',
  './src/js/modules/memo.js',
  './src/js/modules/phone.js',
  './src/js/modules/handbook.js',
  './src/js/modules/swipe.js',
  './src/js/modules/doubao-common.js',
  './src/js/modules/smart-check.js',
  './src/js/modules/smart-writer.js',
  './src/js/modules/doubao.js',
  './src/js/modules/backup.js',
  './version.json'
];

// 本地 CSS/JS 模块（构建时需更新，此处用通配匹配）
var LOCAL_PATTERNS = [
  /\/src\/css\//,
  /\/src\/js\/modules\//
];

// CDN 域名
var CDN_HOSTS = [
  'cdnjs.cloudflare.com',
  'cdn.jsdelivr.net',
  'unpkg.com'
];

// ========== 缓存策略配置 ==========

/**
 * 预缓存 App Shell 核心资源
 */
function precache(event) {
  event.waitUntil(
    caches.open(CACHE_NAME).then(function(cache) {
      return cache.addAll(PRECACHE_URLS).catch(function(err) {
        // 预缓存部分失败不阻断 SW 注册
        console.warn('[SW] 部分预缓存失败:', err);
        return Promise.resolve();
      });
    })
  );
}

/**
 * 清理旧版本缓存
 */
function cleanupOldCaches() {
  return caches.keys().then(function(keys) {
    return Promise.all(
      keys.filter(function(key) {
        return key.indexOf(CACHE_PREFIX) === 0 && key !== CACHE_NAME;
      }).map(function(key) {
        console.log('[SW] 删除旧缓存:', key);
        return caches.delete(key);
      })
    );
  });
}

/**
 * 判断是否为本地模块资源
 */
function isLocalModule(url) {
  try {
    var u = new URL(url);
    return LOCAL_PATTERNS.some(function(p) { return p.test(u.pathname); });
  } catch(e) {
    return false;
  }
}

/**
 * 判断是否为 CDN 资源
 */
function isCDN(url) {
  try {
    var u = new URL(url);
    return CDN_HOSTS.indexOf(u.hostname) !== -1;
  } catch(e) {
    return false;
  }
}

// ========== 事件监听 ==========

// 安装：预缓存核心资源
self.addEventListener('install', function(event) {
  console.log('[SW] 安装中...', CACHE_VERSION);
  event.waitUntil(precache(event));
  // 立即激活，不等旧 SW 释放
  self.skipWaiting();
});

// 激活：清理旧缓存 + 立即接管页面
self.addEventListener('activate', function(event) {
  console.log('[SW] 已激活', CACHE_VERSION);
  event.waitUntil(
    cleanupOldCaches().then(function() {
      return self.clients.claim();
    })
  );
});

// 拦截请求
self.addEventListener('fetch', function(event) {
  var req = event.request;
  var url = req.url;

  // 只处理 GET 请求
  if (req.method !== 'GET') return;

  // 不缓存 IndexedDB / chrome-extension / 非-http(s)
  try {
    var u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return;
    if (u.pathname.indexOf('/api/') !== -1) return; // API 请求走网络
  } catch(e) {
    return;
  }

  // --- 策略选择 ---

  // 1. 导航请求（HTML 页面）：NetworkFirst → CacheFallback
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req).then(function(resp) {
        // 成功获取后缓存一份
        if (resp.ok) {
          var clone = resp.clone();
          caches.open(CACHE_NAME).then(function(cache) {
            cache.put(req, clone);
          });
        }
        return resp;
      }).catch(function() {
        // 网络不可用时返回缓存的 index.html
        return caches.match('./index.html').then(function(cached) {
          return cached || new Response('离线模式 - 请检查网络连接', {
            status: 503,
            statusText: 'Service Unavailable'
          });
        });
      })
    );
    return;
  }

  // 2. CDN 资源：CacheFirst（7天过期，跳过缓存的非200响应）
  if (isCDN(url)) {
    event.respondWith(
      caches.match(req).then(function(cached) {
        // 有缓存时检查：状态码必须为 2xx 且未过期
        if (cached && cached.ok) {
          var dateHeader = cached.headers.get('sw-cache-time');
          if (dateHeader) {
            var age = Date.now() - parseInt(dateHeader, 10);
            if (age < 7 * 24 * 60 * 60 * 1000) {
              return cached;
            }
            // 已过期，下面走网络重新获取
          } else {
            return cached; // 无时间标记且状态正常则直接使用
          }
        }
        // 缓存未命中 / 已过期 / 缓存是错误响应 → 走网络
        return fetch(req).then(function(resp) {
          if (resp.ok) {
            var respToCache = resp.clone();
            var headers = new Headers(respToCache.headers);
            headers.set('sw-cache-time', Date.now().toString());
            var modifiedResp = new Response(respToCache.body, {
              status: respToCache.status,
              statusText: respToCache.statusText,
              headers: headers
            });
            caches.open(CACHE_NAME).then(function(cache) {
              cache.put(req, modifiedResp);
            });
          }
          return resp;
        }).catch(function() {
          // 网络失败：只有缓存是正常响应时才降级返回
          return (cached && cached.ok) ? cached : new Response('', { status: 404 });
        });
      })
    );
    return;
  }

  // 3. 本地 JS/CSS 模块：StaleWhileRevalidate（缓存优先，后台更新）
  if (isLocalModule(url)) {
    event.respondWith(
      caches.open(CACHE_NAME).then(function(cache) {
        return cache.match(req).then(function(cached) {
          var fetchPromise = fetch(req).then(function(networkResp) {
            if (networkResp.ok) {
              // 克隆 response，因为 body 只能消费一次
              cache.put(req, networkResp.clone());
            }
            return networkResp;
          }).catch(function() { return null; });

          // 有缓存先返回，无缓存等网络
          return cached || fetchPromise;
        });
      })
    );
    return;
  }

  // 4. 图标/字体等静态资源：CacheFirst
  if (url.match(/\.(png|jpg|svg|ico|woff|woff2|ttf|eot)(\?.*)?$/i)) {
    event.respondWith(
      caches.match(req).then(function(cached) {
        return cached || fetch(req).then(function(resp) {
          if (resp.ok) {
            caches.open(CACHE_NAME).then(function(cache) {
              cache.put(req, resp.clone());
            });
          }
          return resp;
        });
      })
    );
    return;
  }

  // 5. 其他请求：默认走网络，不做缓存干预
});

// ========== 消息通信 ==========

self.addEventListener('message', function(event) {
  var data = event.data || {};
  switch (data.type) {
    case 'SKIP_WAITING':
      self.skipWaiting();
      break;
    case 'CACHE_STATUS':
      caches.open(CACHE_NAME).then(function(cache) {
        return cache.keys();
      }).then(function(keys) {
        event.source.postMessage({
          type: 'CACHE_STATUS_RESULT',
          count: keys.length,
          version: CACHE_VERSION
        });
      });
      break;
  }
});
