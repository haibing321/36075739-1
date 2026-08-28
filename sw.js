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
var CACHE_VERSION = '20260829075323';
var CACHE_NAME = CACHE_PREFIX + CACHE_VERSION;

// ========== 预缓存资源列表（App Shell）==========
// 【重要】本清单是「最小兜底集」，不再作为唯一依据。
// 原因：手工清单会漂移——index.html 新增模块/CSS 后若忘记同步这里，
// 这些资源就只能靠运行期拦截缓存；而 SW 首次安装时页面已经加载完毕，
// 那些请求根本没被 SW 拦截过，于是「第一次访问后立刻断网」时全部取不到。
// 因此 install 时会额外 fetch('./index.html') 解析出全部本地引用一并缓存
// （见 buildPrecacheUrls），清单永不漂移。
var PRECACHE_URLS = [
  './',
  './index.html',
  './manifest.json',
  './favicon.ico',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-svg.svg',
  // ==== iOS 启动图（apple-touch-startup-image）====
  './icons/splash/iphone-se1.png',
  './icons/splash/iphone-8.png',
  './icons/splash/iphone-8plus.png',
  './icons/splash/iphone-x.png',
  './icons/splash/iphone-xr.png',
  './icons/splash/iphone-xsmax.png',
  './icons/splash/iphone-12.png',
  './icons/splash/iphone-12promax.png',
  // ==== 本地CSS（离线时保证样式正常）====
  './src/css/variables.css',
  './src/css/layout.css',
  './src/css/components.css',
  './src/css/modules.css',
  './src/css/ds-deepseek.css',
  './src/css/responsive.css',
  './src/css/dark.css',
  './src/css/unify.css',
  './src/css/flat.css',
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
  './src/js/modules/agent-memory.js',
  './src/js/modules/agent-core.js',
  './src/js/modules/agent-goals.js',
  './src/js/modules/backup.js',
  './src/js/modules/page-state.js',
  './src/js/modules/unified-enhancements.js',
  './version.json'
];

// ========== 运行时按需从 CDN 加载的大型库 ==========
// 这些库在联网首次成功加载后会被写入缓存，之后即可离线使用。
// 这里主动预热，避免「用户第一次用某功能时刚好断网」导致功能不可用。
var WARM_CDN_URLS = [
  'https://cdnjs.cloudflare.com/ajax/libs/fuse.js/6.6.2/fuse.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/mammoth/1.4.2/mammoth.browser.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/2.16.105/pdf.min.js',
  'https://cdn.jsdelivr.net/npm/html-docx-js@0.3.1/dist/html-docx.js'
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
 * 从 index.html 解析出所有「本地相对引用」，与静态清单合并后去重。
 * 这样新增模块/CSS 时无需手工同步 PRECACHE_URLS，杜绝清单漂移导致的离线空洞。
 */
function extractLocalRefs(htmlText) {
  var out = [];
  var re = /\b(?:src|href)\s*=\s*["']([^"']+)["']/gi;
  var m;
  while ((m = re.exec(htmlText)) !== null) {
    var v = (m[1] || '').trim();
    if (!v) continue;
    if (/^(https?:)?\/\//i.test(v)) continue;                       // 外链
    if (/^(data|mailto|tel|javascript|blob|about|#):?/i.test(v)) continue;
    out.push(v.replace(/^\.\//, ''));
  }
  return out;
}

/**
 * 构建完整预缓存清单：静态清单 + index.html 中解析出的本地引用。
 * index.html 解析失败（首次离线安装等）时退回静态清单，保证安装流程不被阻断。
 */
function buildPrecacheUrls() {
  return fetch('./index.html', { cache: 'reload' })
    .then(function(resp) { return resp.ok ? resp.text() : ''; })
    .then(function(text) {
      var all = PRECACHE_URLS.slice();
      if (text) {
        extractLocalRefs(text).forEach(function(u) {
          if (u && all.indexOf(u) === -1) all.push(u);
        });
      }
      return all;
    })
    .catch(function() { return PRECACHE_URLS.slice(); });
}

/**
 * 预缓存 App Shell 核心资源
 * 逐条 add（而非 cache.addAll）—— 单条 404 不会导致整批失败，
 * 避免「index.html 里有一个暂时取不到的资源」就让整个 App Shell 缓存落空。
 */
function precache(event) {
  event.waitUntil(
    buildPrecacheUrls().then(function(urls) {
      return caches.open(CACHE_NAME).then(function(cache) {
        return Promise.all(urls.map(function(u) {
          // 不指定 cache:'reload'：这些资源刚被页面加载过，浏览器 HTTP 缓存里就是新鲜的。
          // 用 reload 会强制绕过 HTTP 缓存重新下载一遍 —— 首次访问等于双倍流量、双倍耗时。
          // 版本化缓存名（CACHE_VERSION）已经保证了发版时整体重建，不需要靠 reload 取新。
          return cache.add(u).catch(function(err) {
            console.warn('[SW] 预缓存失败(已跳过):', u, err && err.message);
          });
        }));
      });
    })
  );
}

/**
 * 预热 CDN 大型库：仅在缓存中没有时才联网拉取，失败静默忽略。
 * 目的是「用户联网打开过一次 → 之后这些功能可离线使用」，
 * 不抢占 App Shell 的关键带宽，故延迟执行。
 */
function warmCdnLibs() {
  setTimeout(function() {
    caches.open(CACHE_NAME).then(function(cache) {
      WARM_CDN_URLS.forEach(function(u) {
        cache.match(u).then(function(hit) {
          if (hit) return;                       // 已缓存，无需联网
          return fetchWithTimeout(new Request(u, { mode: 'cors' }), 15000)
            .then(function(resp) {
              if (resp && resp.ok) return cache.put(u, resp.clone());
            })
            .catch(function() { /* 离线/受限时静默跳过，不影响其它功能 */ });
        }).catch(function() {});
      });
    }).catch(function() {});
  }, 3000);
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

// v3.17 新增：离线/network 失败且缓存中也没有 index.html 时，
// 返回带「自动跳转」的 200 HTML 兜底页，确保浏览器一定能在合理时间内拿到
// 一个完整的 HTML 文档并结束 splash，绝不让 navigate 阻塞到永久挂起。
function _fallbackShell(retryCount) {
  var origin = self.location && self.location.origin ? self.location.origin : '';
  var base = origin ? (origin + '/') : '/';
  var n = retryCount || 0;
  // 无限自动刷新会让真正离线的用户陷入「每 3 秒白闪一次」的死循环，
  // 且持续消耗电量。超过上限后停止自动刷新，改为明确告知用户该怎么做。
  var MAX_AUTO_RETRY = 3;
  var canAutoRetry = n < MAX_AUTO_RETRY;
  var retry = base + (base.indexOf('?') === -1 ? '?swretry=' : '&swretry=') + (n + 1);
  var body = canAutoRetry
    ? ('<div class="spinner"></div><div>正在准备本地资源…</div>' +
       '<div class="tip">首次使用需要联网下载本地资源</div>')
    : ('<div style="font-size:2rem;">📶</div>' +
       '<div>当前处于离线状态，且本地资源尚未缓存完成</div>' +
       '<div class="tip">请联网打开本系统一次，资源缓存后即可离线使用</div>');
  var autoScript = canAutoRetry
    ? '<script>setTimeout(function(){location.replace("' + retry + '")},3000);<\/script>'
    : '';
  var html = '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<title>安监智能辅助系统</title>' +
    '<style>html,body{margin:0;padding:0;height:100%;background:#0f172a;color:#e2e8f0;' +
    'font-family:-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;' +
    'display:flex;align-items:center;justify-content:center;flex-direction:column;gap:12px;padding:24px;text-align:center;}' +
    '.spinner{width:32px;height:32px;border:3px solid rgba(255,255,255,.18);' +
    'border-top-color:#ffd700;border-radius:50%;animation:r .9s linear infinite;}' +
    '@keyframes r{to{transform:rotate(360deg)}}' +
    '.tip{color:#94a3b8;font-size:.82rem;line-height:1.7;max-width:320px;}' +
    'a{color:#ffd700;text-decoration:none;border:1px solid #ffd700;border-radius:18px;' +
    'padding:6px 16px;font-size:.9rem;margin-top:6px;display:inline-block;}</style></head>' +
    '<body>' + body +
    '<a href="' + base + '" onclick="location.replace(this.href);return false;">点此重试</a>' +
    autoScript +
    '</body></html>';
  return new Response(html, {
    status: 200,
    statusText: 'OK',
    headers: { 'Content-Type': 'text/html; charset=utf-8' }
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
    cleanupOldCaches()
      .then(function() { return self.clients.claim(); })
      .then(function() {
        // 补齐 App Shell：SW 首次安装时页面已加载完毕，那些请求没被 SW 拦截过，
        // 光靠 install 阶段的预缓存可能仍不完整。激活后网络通常还可用，再补一次。
        return buildPrecacheUrls().then(function(urls) {
          return caches.open(CACHE_NAME).then(function(cache) {
            return cache.keys().then(function(keys) {
              var have = {};
              keys.forEach(function(r) { have[r.url] = true; });
              return Promise.all(urls.map(function(u) {
                var abs = new URL(u, self.location.href).href;
                if (have[abs]) return Promise.resolve();
                return cache.add(u).catch(function() {});
              }));
            });
          });
        });
      })
      .then(function() { warmCdnLibs(); })
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

  // 1. 导航请求（HTML 页面）：离线优先(CacheFirst)。
  //    【v3.38】改为完全离线优先——打开时直接返回缓存页面，不再每次联网重新下载 HTML，
  //    确保"系统默认打开完全使用离线内容"。新版本仅在用户点击「设置→检查更新→立即更新」时，
  //    由新 SW 的 precache（新缓存名）落盘、skipWaiting 激活、controllerchange 刷新后生效。
  //    仅当缓存缺失（如首次安装/清缓存）才联网兜底并写入缓存；离线且缓存缺失时返回内置启动页。
  if (req.mode === 'navigate') {
    event.respondWith(
      caches.match(req, { cacheName: CACHE_NAME }).then(function(c) {
        if (c) return c;                       // 离线优先：命中缓存直接返回，不联网
        // 缓存未命中（首次安装/清缓存）才联网获取并写回缓存
        return fetchWithTimeout(req, 3000).then(function(resp) {
          if (resp.ok) {
            var clone = resp.clone();
            caches.open(CACHE_NAME).then(function(cache) { cache.put(req, clone); });
          }
          return resp;
        }).catch(function() {
          return caches.match('./index.html', { cacheName: CACHE_NAME })
            .then(function(c2) {
              if (c2) return c2;
              // 读取重试次数（fallback 页用 URL 参数传递），避免离线时无限自动刷新
              var n = 0;
              try {
                var rm = new URL(req.url).searchParams.get('swretry');
                n = rm ? parseInt(rm, 10) || 0 : 0;
              } catch (e) {}
              return _fallbackShell(n);
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
