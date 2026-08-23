/**
 * 安监智能辅助系统 - Service Worker v1
 * 策略: AppShell precache + 混合缓存。
 *   - 导航(HTML): 在线时「网络优先」(NetworkFirst)，确保已安装 PWA 不会一直使用
 *     旧的、含外部 CDN <script> 的缓存壳，从而避免移动端弱网/被墙时该脚本挂起、
 *     页面卡在启动图标界面(load 永不触发)。离线时直接返回缓存(秒开)。
 *   - 本地模块/CSS/图片: CacheFirst(离线优先, 不轮询网络)。
 */

var CACHE_PREFIX = 'aj-v';
// 使用时间戳作为缓存版本，每次部署自动更新，确保用户获取最新资源
var CACHE_VERSION = '20260823143147';
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
  './src/js/vendor/purify.min.js',
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
  /\/src\/js\/modules\//,
  /\/src\/js\/vendor\//
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

// 带超时的 fetch：弱网/被墙资源若长时间无响应，超时后主动失败，
// 避免 <script defer> 等请求永久 pending 导致页面卡在启动图标界面（load 永不触发）。
var FETCH_TIMEOUT = 8000;
function fetchWithTimeout(req, ms) {
  return new Promise(function(resolve, reject) {
    var settled = false;
    var timer = setTimeout(function() {
      if (!settled) { settled = true; reject(new Error('fetch-timeout')); }
    }, ms);
    fetch(req).then(function(resp) {
      if (!settled) { settled = true; clearTimeout(timer); resolve(resp); }
    }, function(err) {
      if (!settled) { settled = true; clearTimeout(timer); reject(err); }
    });
  });
}

// ========== 事件监听 ==========

// 安装：预缓存核心资源
self.addEventListener('install', function(event) {
  console.log('[SW] 安装中...', CACHE_VERSION);
  event.waitUntil(precache(event));
  // 注意：此处【不要】调用 self.skipWaiting()。
  // 否则新 SW 一装好就静默接管，页面已加载的旧 JS/CSS 不会刷新，
  // 表现为「点击检查更新无效果」。正确流程：新 SW 进入 waiting 状态后，
  // 由「检查更新 → 立即更新」弹窗通过 postMessage({type:'SKIP_WAITING'}) 显式激活并刷新页面
  // （见下方 message 事件处理）。首次安装因无旧 SW，仍会立即激活，不受影响。
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

  // 1. 导航请求（HTML 页面）：在线时「网络优先」(NetworkFirst) 获取最新页面，
  //    确保已安装的 PWA 不会一直使用旧的、含外部 CDN <script> 的缓存壳，
  //    从而避免移动端弱网/被墙时该脚本挂起、页面卡在启动图标界面(load 永不触发)。
  //    离线时直接返回缓存(秒开)，不联网等待。
  if (req.mode === 'navigate') {
    // 离线：直接返回缓存中的页面，避免无网络时长时间等待/白屏
    if (self.navigator && self.navigator.onLine === false) {
      event.respondWith(
        caches.match(req, { cacheName: CACHE_NAME })
          .then(function(c) { return c || caches.match('./index.html', { cacheName: CACHE_NAME }); })
          .then(function(c) {
            return c || new Response('离线模式 - 请检查网络连接', {
              status: 503,
              statusText: 'Service Unavailable'
            });
          })
      );
      return;
    }
    // 在线：优先联网获取最新页面（带超时，避免永久挂起），失败再回退缓存
    event.respondWith(
      fetchWithTimeout(req, 5000).then(function(resp) {
        if (resp.ok) {
          var clone = resp.clone();
          caches.open(CACHE_NAME).then(function(cache) { cache.put(req, clone); });
        }
        return resp;
      }).catch(function() {
        return caches.match(req, { cacheName: CACHE_NAME })
          .then(function(c) { return c || caches.match('./index.html', { cacheName: CACHE_NAME }); })
          .then(function(c) {
            return c || new Response('离线模式 - 请检查网络连接', {
              status: 503,
              statusText: 'Service Unavailable'
            });
          });
      })
    );
    return;
  }

  // 2. CDN 资源：CacheFirst（离线优先，默认不联网轮询）
  if (isCDN(url)) {
    event.respondWith(
      caches.match(req).then(function(cached) {
        if (cached) return cached;
        return fetchWithTimeout(req, FETCH_TIMEOUT).then(function(resp) {
          if (resp.ok) {
            var clone = resp.clone();
            caches.open(CACHE_NAME).then(function(cache) {
              cache.put(req, clone);
            });
          }
          return resp;
        }).catch(function() {
          return new Response('', { status: 504, statusText: 'Gateway Timeout' });
        });
      })
    );
    return;
  }

  // 3. 本地 JS/CSS 模块：CacheFirst（离线优先，不后台轮询网络）
  if (isLocalModule(url)) {
    event.respondWith(
      caches.match(req).then(function(cached) {
        if (cached) return cached;
        return fetchWithTimeout(req, FETCH_TIMEOUT).then(function(resp) {
          if (resp.ok) {
            var clone = resp.clone();
            caches.open(CACHE_NAME).then(function(cache) {
              cache.put(req, clone);
            });
          }
          return resp;
        }).catch(function() {
          return new Response('', { status: 504, statusText: 'Gateway Timeout' });
        });
      })
    );
    return;
  }

  // 4. 图标/字体等静态资源：CacheFirst
  if (url.match(/\.(png|jpg|svg|ico|woff|woff2|ttf|eot)(\?.*)?$/i)) {
    event.respondWith(
      caches.match(req).then(function(cached) {
        return cached || fetchWithTimeout(req, FETCH_TIMEOUT).then(function(resp) {
          if (resp.ok) {
            caches.open(CACHE_NAME).then(function(cache) {
              cache.put(req, resp.clone());
            });
          }
          return resp;
        }).catch(function() {
          return new Response('', { status: 504, statusText: 'Gateway Timeout' });
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
    case 'GET_SW_VERSION':
      // 离线回传 12 位缓存版本号，避免页面打开时联网 fetch sw.js
      if (event.ports && event.ports[0]) {
        event.ports[0].postMessage({ type: 'SW_VERSION', version: CACHE_VERSION });
      }
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
