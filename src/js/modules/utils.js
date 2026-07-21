/**
 * Utils（公共工具函数）模块
 * ===================================================
 * 功能：
 *   - TAB_LABELS: 导航栏 Tab 名称映射
 *   - toggleNav(): 移动端导航菜单切换
 *   - switchTab(tab): 切换主面板 Tab
 *   - closeModal(id) / openModal(id): 模态框控制
 *   - autoResize(textarea): 自动调整文本框高度
 *   - pinyinMatch(text, keyword): 拼音匹配
 *   - extractDigits(str): 提取数字
 *   - TAB_ORDER, _tabHistory: 模块切换历史
 * 
 * 导出到 window:
 *   - window.toggleNav, window.switchTab, window.closeModal
 *   - window.openModal, window.autoResize
 *   - window._fvScrollbarReset
 */

// ============================================================
// 全局工具函数
        // ========== 全局工具函数 ==========
        // 导航栏 Tab 名称映射
        const TAB_LABELS = {
            handbook: '📖 检查手册',
            issue: '📊 检查信息',
            rule: '📋 规章制度',
            diary: '📝 工作日志',
            phone: '📞 应急电话',
            material: '📚 资料中心',
            doubao: '🤖 智能助手'
        };

        window.toggleNav = function() {
            const nav = document.getElementById('mainNav');
            const toggle = document.getElementById('navToggle');
            const isOpen = nav.classList.contains('nav-open');
            if (isOpen) {
                nav.classList.remove('nav-open');
                toggle.classList.remove('open');
            } else {
                nav.classList.add('nav-open');
                toggle.classList.add('open');
            }
        };

        // ===== 模块切换历史记录（最近5次）=====
        const TAB_ORDER = ['handbook','issue','rule','diary','phone','doubao'];
        const _tabHistory = []; // 最近5次切换记录 [{from, to, label}]

        window.switchTab = function(tab, fromSwipe) {
            // 性能埋点
            if (window.perfMonitor) perfMonitor.start('tab_switch');

            // 记住当前模块，供刷新后恢复首屏（点击/侧滑均经此函数）
            try { localStorage.setItem('current_module', tab); } catch (e) {}

            // 记录历史（侧滑或手动切换都记录）
            const prevActiveBtn = document.querySelector('.nav-btn.active');
            let prevTab = null;
            if (prevActiveBtn) {
                const m = prevActiveBtn.id.match(/^tab-(.+)$/);
                if (m) prevTab = m[1];
            }
            if (prevTab && prevTab !== tab) {
                _tabHistory.push({ from: prevTab, to: tab, label: TAB_LABELS[tab] || tab });
                if (_tabHistory.length > 5) _tabHistory.shift();
            }
            document.querySelectorAll('.nav-btn').forEach(function(t) {
                t.classList.remove('active');
            });
            document.querySelectorAll('.panel').forEach(function(p) {
                p.classList.remove('active');
            });
            var activeBtn = document.getElementById('tab-' + tab);
            if (activeBtn) {
                activeBtn.classList.add('active');
            }
            var activePanel = document.getElementById('panel-' + tab);
            if (activePanel) activePanel.classList.add('active');
            // 更新移动端当前Tab标签
            const labelEl = document.getElementById('navCurrentLabel');
            if (labelEl) labelEl.textContent = TAB_LABELS[tab] || '';
            // 切换后自动收起导航菜单（移动端）
            const nav = document.getElementById('mainNav');
            const toggle = document.getElementById('navToggle');
            if (nav && nav.classList.contains('nav-open')) {
                nav.classList.remove('nav-open');
                toggle.classList.remove('open');
            }
            // 侧滑时不再显示 Toast 记录框
            // if (fromSwipe) {
            //     _showSwipeToast(tab);
            // }
            // 模块专属刷新钩子（如资料中心打开时渲染列表）
            if (typeof window['onShow_' + tab] === 'function') {
                try { window['onShow_' + tab](); } catch (e) { console.warn('onShow_' + tab + ' 失败', e); }
            }
            if (window.perfMonitor) perfMonitor.end('tab_switch', { targetTab: tab });
        };

        window.closeModal = function(id) { 
            document.getElementById(id).classList.remove('active'); 
            if (id === 'rule-fullViewModal' && typeof _imgLazyObserver !== 'undefined' && _imgLazyObserver) {
                _imgLazyObserver.disconnect();
            }
        };
        window.openModal = function(id) { document.getElementById(id).classList.add('active'); };

        // 自定义滚动条已移除（改用原生滚动，消除手机端高频DOM计算卡顿）
        window._fvScrollbarReset = function() {}; // 空函数，保持原有调用不报错

        window.autoResize = function(textarea) {
            if (!textarea) return;
            void textarea.offsetHeight;
            textarea.style.height = 'auto';
            textarea.style.height = Math.max(40, textarea.scrollHeight) + 'px';
        };

        window.addEventListener('resize', function() {
            setTimeout(function() {
                document.querySelectorAll('.diary-issue-input, .diary-textarea').forEach(function(el) {
                    autoResize(el);
                });
            }, 100);
        });

        function pinyinMatch(text, keyword) {
            if (!text || !keyword) return false;
            const lowerText = text.toLowerCase();
            if (lowerText.includes(keyword.toLowerCase())) return true;
            try {
                const pinyinFull = pinyin(text, { style: pinyin.STYLE_NORMAL, heteronym: false }).flat().join('').toLowerCase();
                if (pinyinFull.includes(keyword.toLowerCase())) return true;
                const pinyinFirst = pinyin(text, { style: pinyin.STYLE_FIRST_LETTER }).flat().join('').toLowerCase();
                if (pinyinFirst.includes(keyword.toLowerCase())) return true;
            } catch (e) {}
            return false;
        }
        function extractDigits(str) {
            return (str || '').replace(/\D/g, '');
        }

        // ============================================================
        // 统一安全函数（XSS 防护）
        // ============================================================

        /**
         * HTML 实体转义 — 统一版本，替代各模块重复实现
         * 覆盖: diary.js:294, phone.js:127, rule.js:427 的本地副本
         * 用法: window.escapeHtml('<script>alert(1)</script>')
         * 返回: '&lt;script&gt;alert(1)&lt;/script&gt;'
         */
        window.escapeHtml = function(text) {
            if (text === null || text === undefined) return '';
            return String(text)
                .replace(/&/g, '&amp;')
                .replace(/</g, '&lt;')
                .replace(/>/g, '&gt;')
                .replace(/"/g, '&quot;')
                .replace(/'/g, '&#039;');
        };

        /**
         * 安全 HTML 渲染 — DOMPurify 包装 + 降级回退
         *
         * 优先使用 DOMPurify（允许安全的 HTML 标签如 <br><strong> 等），
         * 若 CDN 加载失败则降级为纯转义（所有标签都变文本）。
         *
         * @param {string} dirty - 可能包含恶意 HTML 的字符串
         * @param {object} [options] - 传给 DOMPurify.sanitize 的选项
         *   - allowedTags: 允许的标签白名单（默认：常用安全标签）
         *   - allowedAttributes: 允许的属性白名单
         *   - forceEscape: true 时强制纯文本模式（不保留任何HTML标签）
         * @returns {string} 安全的 HTML 字符串，可直接赋值给 innerHTML
         *
         * 用法示例:
         *   el.innerHTML = safeHtml(userContent);              // 默认允许 br/b/strong/i/em/p
         *   el.innerHTML = safeHtml(aiResponse, {forceEscape:true}); // 纯文本模式
         *   el.innerHTML = safeHtml(markdown, {allowedTags:['br','h3','div','pre','code']});
         */
        window.safeHtml = function(dirty, options) {
            if (dirty === null || dirty === undefined) return '';

            // 强制纯文本模式（不信任任何HTML标签）
            if (options && options.forceEscape) {
                return window.escapeHtml(dirty);
            }

            // DOMPurify 可用时使用完整 sanitize
            if (typeof DOMPurify !== 'undefined' && DOMPurify.sanitize) {
                try {
                    var purifyOptions = {
                        ALLOWED_TAGS: ['b', 'i', 'em', 'strong', 'p', 'br', 'span',
                                        'h1','h2','h3','h4','h5','h6',
                                        'ul','ol','li','blockquote',
                                        'pre','code','div',
                                        'table','thead','tbody','tr','th','td',
                                        'a', 'img', 'hr', 'sub', 'sup', 'mark'],
                        ALLOWED_ATTR: ['href', 'src', 'alt', 'title', 'class', 'style',
                                       'id', 'target', 'rel', 'data-*'],
                        ADD_ATTR: ['target'],
                        FORCE_BODY: false
                    };
                    // 合并用户自定义选项
                    if (options) {
                        if (options.allowedTags) purifyOptions.ALLOWED_TAGS = options.allowedTags;
                        if (options.allowedAttributes) purifyOptions.ALLOWED_ATTR = options.allowedAttributes;
                        if (options.allowHref) purifyOptions.ALLOWED_ATTR.push('href');
                    }
                    return DOMPurify.sanitize(dirty, purifyOptions);
                } catch(e) {
                    console.warn('[safeHtml] DOMPurify sanitize 失败，降级为转义:', e.message);
                }
            }

            // 降级方案：CDN 未加载或异常时，全部转义为纯文本
            // 保留换行符转为 <br>（这是最常见的安全需求）
            var escaped = window.escapeHtml(dirty);
            return escaped.replace(/\n/g, '<br>');
        };

        

        // ============================================================
        // IndexedDB 连接管理器（单例模式 + Promise 缓存）
        // ============================================================

        /**
         * 统一 DB 连接管理器 — 解决多模块重复打开同一数据库的问题
         *
         * 问题背景：
         *   RailwayIssueDB_v2 被 issue.js + doubao.js 各自打开
         *   RailwayRuleDB 被 rule.js + doubao.js + backup.js 各自打开
         *   DiaryMediaDB 被 diary.js 每次读写都重新打开
         *   同一数据库被打开多次 → 浪费连接、版本冲突风险、onversionchange 竞态
         *
         * 设计：
         *   - 每个 name+version 组合只保留一个连接（单例）
         *   - 首次调用时创建并缓存，后续返回缓存的 Promise/连接
         *   - 内置 onversionchange / onclose 自动清除失效缓存
         *   - backup.js 等一次性操作可用 closeDB() 用完即关
         *
         * 注册的数据库（各模块在 DOMContentLoaded 中调用 register）：
         *   'RailwayIssueDB_v2'  → { version: 2,  upgrade: issue.js 的 schema }
         *   'RailwayRuleDB'      → { version: 3, upgrade: rule.js 的 schema }
         *   'DiaryMediaDB'       → { version: 1, upgrade: diary.js 的 schema }
         *   'railway_writer_db'  → { version: 2, upgrade: doubao.js 写作模块的 schema }
         *
         * @example
         *   // 注册（各模块 init 时执行一次）
         *   dbManager.register('RailwayIssueDB_v2', 1, function(db, e) { ... });
         *
         *   // 获取连接
         *   var dbConn = await dbManager.getDB('RailwayIssueDB_v2');
         *   var tx = dbConn.transaction(['issues'], 'readonly');
         */
        (function() {
            var _cache = {};    // { dbName: { db: IDBDatabase, promise: Promise, version: number } }
            var _upgrades = {}; // { dbName: upgradeFn(db, event) }

            /**
             * 注册数据库升级回调（必须在首次 getDB 前调用）
             * @param {string} name - 数据库名
             * @param {number} version - 版本号
             * @param {function} upgradeFn - onupgradeneeded 回调 (db, event) => void
             */
            function register(name, version, upgradeFn) {
                _upgrades[name] = { version: version, fn: upgradeFn };
                // 如已有缓存的低版本连接，清除让下次 getDB 升级
                if (_cache[name] && (!_cache[name].version || _cache[name].version < version)) {
                    if (_cache[name].db) { try { _cache[name].db.close(); } catch(e) {} }
                    delete _cache[name];
                }
            }

            /**
             * 获取数据库连接（带缓存的单例）
             * @param {string} name - 数据库名
             * @param {number} [forceVersion] - 可选，强制以指定版本打开（用于修复 store 缺失场景）
             * @returns {Promise<IDBDatabase>}
             */
            function getDB(name, forceVersion) {
                // 已有有效缓存
                if (_cache[name] && _cache[name].db) {
                    try {
                        void _cache[name].db.objectStoreNames;
                        return Promise.resolve(_cache[name].db);
                    } catch(e) {
                        console.log('[dbManager] 缓存连接已失效(' + name + ')，重新打开');
                        delete _cache[name];
                    }
                }

                // 正在打开中（防止并发重复 open）
                if (_cache[name] && _cache[name].promise) {
                    return _cache[name].promise;
                }

                var info = _upgrades[name] || { version: 1, fn: null };
                // 如果调用方传了 forceVersion，优先使用
                var baseVer = (forceVersion !== undefined) ? forceVersion : info.version;

                // 先探测现有版本，避免 "requested version (N) is less than existing (M)" 报错
                var p = new Promise(function(resolve, reject) {
                    var probeReq = indexedDB.open(name);
                    probeReq.onsuccess = function() {
                        var existingVer = probeReq.result.version;
                        probeReq.result.close();
                        // 使用 max(注册版本, 已有版本) 打开，确保 >= 已有版本
                        var targetVer = Math.max(baseVer, existingVer);
                        if (targetVer < existingVer) targetVer = existingVer;
                        var req = indexedDB.open(name, targetVer);
                        req.onerror = function() { reject(req.error); };
                        req.onblocked = function() {
                            console.warn('[dbManager] 升级被阻塞:', name);
                            if (_cache[name] && _cache[name].db) {
                                try { _cache[name].db.close(); } catch(e) {}
                                delete _cache[name];
                            }
                        };
                        req.onsuccess = function() {
                            var db = req.result;
                            db.onversionchange = function() {
                                console.log('[dbManager] 版本变化，关闭连接:', name);
                                db.close();
                                delete _cache[name];
                            };
                            db.onclose = function() {
                                console.log('[dbManager] 连接已关闭:', name);
                                delete _cache[name];
                            };
                            _cache[name].db = db;
                            _cache[name].version = targetVer;
                            resolve(db);
                        };
                        if (info.fn && targetVer > existingVer) {
                            req.onupgradeneeded = function(e) {
                                try { info.fn(e.target.result, e); }
                                catch(upgradeErr) { console.error('[dbManager] upgrade 失败:', name, upgradeErr); }
                            };
                        }
                    };
                    probeReq.onerror = function() {
                        // 探测失败（可能是全新DB）→ 直接用注册版本打开
                        var req = indexedDB.open(name, info.version);
                        req.onerror = function() { reject(req.error); };
                        req.onblocked = function() { console.warn('[dbManager] 升级被阻塞:', name); };
                        req.onsuccess = function() {
                            var db = req.result;
                            db.onversionchange = function() { db.close(); delete _cache[name]; };
                            db.onclose = function() { delete _cache[name]; };
                            _cache[name].db = db;
                            _cache[name].version = info.version;
                            resolve(db);
                        };
                        if (info.fn) {
                            req.onupgradeneeded = function(e) {
                                try { info.fn(e.target.result, e); }
                                catch(upgradeErr) { console.error('[dbManager] upgrade 失败:', name, upgradeErr); }
                            };
                        }
                    };
                });

                _cache[name] = { promise: p, db: null, version: info.version };
                return p;
            }

            /**
             * 关闭指定数据库连接并清除缓存
             * @param {string} name - 数据库名
             */
            function closeDB(name) {
                if (_cache[name] && _cache[name].db) {
                    try { _cache[name].db.close(); } catch(e) {}
                }
                delete _cache[name];
            }

            /** 关闭所有数据库连接 */
            function closeAll() {
                Object.keys(_cache).forEach(function(name) { closeDB(name); });
            }

            /**
             * 获取数据库状态信息（用于调试和配额监控）
             * @returns {{ count: number, databases: string[] }}
             */
            function getStatus() {
                var names = Object.keys(_cache);
                return {
                    count: names.length,
                    databases: names.map(function(n) {
                        return { name: n, connected: !!(_cache[n] && _cache[n].db) };
                    })
                };
            }

            // 导出到 window
            window.dbManager = {
                register: register,
                getDB: getDB,
                closeDB: closeDB,
                closeAll: closeAll,
                getStatus: getStatus
            };
        })();


        // ============================================================
        // 存储配额管理器（Quota Monitor + Auto Cleanup）
        // ============================================================

        /**
         * 统一存储管理 — 配额监控、自动清理、使用量统计
         *
         * 解决问题：
         *   - 原有 issue.js 用采样*2 粗估存储（不靠谱）
         *   - rule.js 硬编码 500MB 上限（不同浏览器实际限额差异巨大）
         *   - DiaryMediaDB 媒体文件无限增长无清理机制
         *   - 存储满时静默失败，用户不知原因
         *
         * 能力：
         *   1. navigator.storage.estimate() 真实配额检测（Chrome 61+, Firefox 57+）
         *      不支持时降级为 localStorage 估算
         *   2. DiaryMediaDB LRU 自动清理（可配置最大年龄/最大条数）
         *   3. 接近限额时自动警告提示
         *   4. 统一接口供各模块 updateStorage() 调用
         */
        (function() {
            /** 缓存最近的配额检测结果（5分钟有效） */
            var _quotaCache = { data: null, timestamp: 0, TTL: 5 * 60 * 1000 };
            var _warnedThreshold = 0; // 已警告过的阈值（避免重复弹窗）

            /**
             * 获取浏览器存储配额信息
             * @returns {Promise<{usage: number, quota: number, usagePercent: number, usageMB: number, quotaMB: number}>}
             */
            function checkQuota() {
                var now = Date.now();
                if (_quotaCache.data && (now - _quotaCache.timestamp) < _quotaCache.TTL) {
                    return Promise.resolve(_quotaCache.data);
                }

                if (navigator.storage && typeof navigator.storage.estimate === 'function') {
                    return navigator.storage.estimate().then(function(est) {
                        var usageMB = est.usage / 1024 / 1024;
                        var quotaMB = est.quota / 1024 / 1024;
                        var result = {
                            usage: est.usage,
                            quota: est.quota,
                            usagePercent: est.quota > 0 ? (est.usage / est.quota * 100) : 0,
                            usageMB: parseFloat(usageMB.toFixed(2)),
                            quotaMB: parseFloat(quotaMB.toFixed(2)),
                            source: 'storage.api'
                        };
                        _quotaCache.data = result;
                        _quotaCache.timestamp = now;
                        return result;
                    }).catch(function() {
                        return _fallbackEstimate();
                    });
                }
                return _fallbackEstimate();
            }

            /** 降级方案：通过 localStorage 估算 */
            function _fallbackEstimate() {
                var total = 0;
                try {
                    for (var i = 0; i < localStorage.length; i++) {
                        var key = localStorage.key(i);
                        total += (localStorage.getItem(key) || '').length;
                    }
                } catch(e) {}
                // localStorage 通常共享 ~5-10MB 配额（IndexedDB 另算）
                var estQuota = 50 * 1024 * 1024; // 保守估计 50MB
                var result = {
                    usage: total,
                    quota: estQuota,
                    usagePercent: total / estQuota * 100,
                    usageMB: parseFloat((total / 1024 / 1024).toFixed(2)),
                    quotaMB: 50,
                    source: 'fallback'
                };
                _quotaCache.data = result;
                _quotaCache.timestamp = Date.now();
                return Promise.resolve(result);
            }

            /**
             * 获取格式化的存储状态字符串（用于 UI 显示）
             * @param {number} [customUsageMB] - 自定义使用量 MB（可选，用于模块级显示）
             * @returns {Promise<string>} 如 "12.5 / 250 MB (5%)""
             */
            function getFormattedInfo(customUsageMB) {
                return checkQuota().then(function(info) {
                    if (customUsageMB !== undefined) {
                        return customUsageMB.toFixed(1) + ' / ' + info.quotaMB + ' MB (' + info.usagePercent.toFixed(0) + '%)';
                    }
                    return info.usageMB + ' / ' + info.quotaMB + ' MB (' + info.usagePercent.toFixed(1) + '%)';
                });
            }

            /**
             * 检查是否接近存储上限并发出警告
             * @param {number} [warnPercent=80] - 触发警告的使用百分比
             * @returns {Promise<boolean>} true = 接近限额
             */
            async function warnIfNearLimit(warnPercent) {
                warnPercent = warnPercent || 80;
                var info = await checkQuota();

                if (info.usagePercent >= warnPercent && _warnedThreshold < warnPercent) {
                    _warnedThreshold = warnPercent;
                    console.warn('[storage] 存储使用率已达 ' + info.usagePercent.toFixed(1) + '% (' + info.usageMB + '/' + info.quotaMB + ' MB)');
                    // 仅在 DOM 就绪后尝试显示 UI 警告
                    if (document.body) {
                        var bar = document.createElement('div');
                        bar.className = 'storage-warning-toast';
                        bar.style.cssText = [
                            'position:fixed;top:-60px;left:50%;transform:translateX(-50%);',
                            'background:linear-gradient(135deg,#dc2626,#b91c1c);',
                            'color:#fff;padding:10px 24px;border-radius:0 0 12px 12px;',
                            'font-size:0.9rem;font-weight:600;z-index:99999;',
                            'box-shadow:0 4px 20px rgba(220,38,38,0.4);',
                            'transition:top 0.4s ease;'
                        ].join('');
                        bar.innerHTML = '⚠️ 存储空间不足 (' + info.usageMB + '/' + info.quotaMB + ' MB)，建议清理旧数据或导出备份';
                        document.body.appendChild(bar);
                        requestAnimationFrame(function() { bar.style.top = '0'; });
                        setTimeout(function() {
                            bar.style.top = '-60px';
                            setTimeout(function() { if (bar.parentNode) bar.parentNode.removeChild(bar); }, 400);
                        }, 6000);
                    }
                    return true;
                }
                return false;
            }

            /**
             * LRU 清理 DiaryMediaDB 中过期的媒体文件
             * 按时间排序，删除最旧的记录，直到低于限制
             *
             * @param {object} [opts]
             * @param {number} [opts.maxAgeDays=365] - 最大保留天数
             * @param {number} [opts.maxCount=500] - 最大保留条数
             * @param {number} [opts.targetMB=100] - 目标最大占用 MB（达到时触发清理）
             * @returns {Promise<{removed: number, freedMB: number}>}
             */
            async function cleanupOldMedia(opts) {
                opts = opts || {};
                var maxAgeDays = opts.maxAgeDays || 365;
                var maxCount = opts.maxCount || 500;
                var targetMB = opts.targetMB || 100;

                try {
                    var db = await window.dbManager.getDB('DiaryMediaDB');

                    return new Promise(function(resolve) {
                        var tx = db.transaction('media', 'readonly');
                        var store = tx.objectStore('media');
                        var getAllReq = store.getAll();

                        getAllReq.onsuccess = function() {
                            var allRecords = getAllReq.result || [];
                            if (allRecords.length === 0) resolve({ removed: 0, freedMB: 0 });

                            var now = Date.now();
                            var cutoffTime = now - maxAgeDays * 24 * 60 * 60 * 1000;

                            // 标记需要删除的：超龄 或 超过数量上限（取最旧的）
                            var toDelete = [];
                            var totalSize = 0;

                            allRecords.forEach(function(r) {
                                totalSize += (r.blob ? r.blob.byteLength || r.blob.length || 0 : 0);
                                var ageDays = (now - (r.timestamp || 0)) / 86400000;
                                if (ageDays > maxAgeDays) toDelete.push({ id: r.id, reason: 'expired', age: ageDays });
                            });

                            // 数量超出限制时，按时间排序删除最旧的
                            var sorted = allRecords.slice().sort(function(a, b) {
                                return (a.timestamp || 0) - (b.timestamp || 0);
                            });
                            for (var i = 0; i < sorted.length - maxCount; i++) {
                                if (!toDelete.find(function(d) { return d.id === sorted[i].id; })) {
                                    toDelete.push({ id: sorted[i].id, reason: 'overflow', age: 0 });
                                }
                            }

                            // 总大小超过目标时继续清理
                            var totalMB = totalSize / 1024 / 1024;
                            if (totalMB > targetMB && toDelete.length < allRecords.length) {
                                var remaining = allRecords.filter(function(r) {
                                    return !toDelete.find(function(d) { return d.id === r.id; });
                                }).sort(function(a, b) {
                                    return (a.timestamp || 0) - (b.timestamp || 0);
                                });
                                for (var j = 0; j < remaining.length; j++) {
                                    var recSize = remaining[j].blob ? remaining[j].blob.byteLength || remaining[j].blob.length || 0 : 0;
                                    toDelete.push({ id: remaining[j].id, reason: 'size_limit', age: 0 });
                                    totalSize -= recSize;
                                    if ((totalSize / 1024 / 1024) <= targetMB) break;
                                }
                            }

                            if (toDelete.length === 0) {
                                resolve({ removed: 0, freedMB: 0, totalRecords: allRecords.length, totalMB: parseFloat(totalMB.toFixed(2)) });
                                return;
                            }

                            // 执行删除（去重）
                            var uniqueIds = [];
                            toDelete.forEach(function(d) {
                                if (uniqueIds.indexOf(d.id) === -1) uniqueIds.push(d.id);
                            });

                            var freedBytes = 0;
                            uniqueIds.forEach(function(id) {
                                var rec = allRecords.find(function(r) { return r.id === id; });
                                if (rec && rec.blob) freedBytes += rec.blob.byteLength || rec.blob.length || 0;
                            });

                            var delTx = db.transaction('media', 'readwrite');
                            var delStore = delTx.objectStore('media');
                            uniqueIds.forEach(function(id) { delStore.delete(id); });

                            delTx.oncomplete = function() {
                                var freedMB = parseFloat((freedBytes / 1024 / 1024).toFixed(2));
                                console.log('[storage] 清理完成: 删除 ' + uniqueIds.length + ' 条媒体记录，释放 ' + freedMB + ' MB');
                                resolve({
                                    removed: uniqueIds.length,
                                    freedMB: freedMB,
                                    totalRecords: allRecords.length - uniqueIds.length,
                                    details: toDelete.slice(0, 10)
                                });
                            };
                            delTx.onerror = function() { resolve({ removed: 0, freedMB: 0, error: delTx.error }); };
                        };
                        getAllReq.onerror = function() { resolve({ removed: 0, freedMB: 0 }); };
                    });
                } catch(e) {
                    console.warn('[storage] cleanupOldMedia 失败:', e.message || e);
                    return { removed: 0, freedMB: 0, error: e.message };
                }
            }

            /**
             * 一键清理所有可回收存储（供用户手动触发）
             * 包括：过期媒体、localStorage 中过大的缓存条目等
             * @returns {Promise<object>} 清理结果汇总
             */
            async function cleanupAll() {
                var result = { media: null, quota: null };

                // 1. 清理媒体
                result.media = await cleanupOldMedia({ maxAgeDays: 730, maxCount: 300, targetMB: 50 }); // 2年/300条/50MB

                // 2. 检测配额
                result.quota = await checkQuota();

                return result;
            }

            // 导出到 window
            window.storageManager = {
                checkQuota: checkQuota,
                getFormattedInfo: getFormattedInfo,
                warnIfNearLimit: warnIfNearLimit,
                cleanupOldMedia: cleanupOldMedia,
                cleanupAll: cleanupAll
            };

            // ========== 动态加载脚本（按需加载大型库）==========
            window.loadScript = function(src) {
                return new Promise(function(resolve, reject) {
                    if (document.querySelector('script[src="' + src + '"]')) {
                        return resolve();
                    }
                    var script = document.createElement('script');
                    script.src = src;
                    script.onload = function() { resolve(); };
                    script.onerror = function() { reject(new Error('加载失败: ' + src)); };
                    document.head.appendChild(script);
                });
            };

            // ========== 通用文件下载（移动端兼容，单点实现）==========
            // 桌面端：标准 a.click()；移动端复杂格式(.docx/.zip/.xlsx)：data URL + 显式可点按钮
            window.downloadBlob = function(blob, filename) {
                if (!blob) return;
                // 旧 IE / EdgeHTML / 部分华为内核
                if (window.navigator && window.navigator.msSaveOrOpenBlob) {
                    try { window.navigator.msSaveOrOpenBlob(blob, filename); return; } catch (e) {}
                }
                if (window.navigator && window.navigator.msSaveBlob) {
                    try { window.navigator.msSaveBlob(blob, filename); return; } catch (e) {}
                }
                var isMobile = /Mobi|Android|iPhone|iPad|iPod/i.test(navigator.userAgent || '');
                var isComplex = /\.(zip|docx|xlsx|pptx)$/i.test(filename);
                if (isMobile && isComplex) {
                    // 手机端复杂文件：blob URL 常被拦截，改用 data URL + 真实 <a download> 按钮
                    var reader = new FileReader();
                    reader.onload = function() { _showMobileDownloadBtn(reader.result, filename, true); };
                    reader.onerror = function() {
                        var url = URL.createObjectURL(blob);
                        _showMobileDownloadBtn(url, filename, false);
                    };
                    reader.readAsDataURL(blob);
                    return;
                }
                var a = document.createElement('a');
                var dlUrl = URL.createObjectURL(blob);
                a.href = dlUrl;
                a.download = filename;
                a.style.display = 'none';
                document.body.appendChild(a); // 华为等浏览器要求元素在 DOM 树中
                a.click();
                setTimeout(function() {
                    if (a.parentNode) document.body.removeChild(a);
                    setTimeout(function() { URL.revokeObjectURL(dlUrl); }, 60000);
                }, isMobile ? 2000 : 500);
            };

            function _showMobileDownloadBtn(url, filename, isDataUrl) {
                var old = document.getElementById('_mobile_dl_btn');
                if (old && old.parentNode) old.parentNode.removeChild(old);
                var oldTip = document.getElementById('_mobile_dl_tip');
                if (oldTip && oldTip.parentNode) oldTip.parentNode.removeChild(oldTip);
                var displayName = filename.length > 30 ? filename.slice(0, 27) + '...' : filename;

                // 点击触发：华为等浏览器会静默忽略 <a download>，所以多重兜底
                function triggerDownload() {
                    // 1) 新标签打开（点击手势内，多数移动浏览器对已知类型会直接下载）
                    try {
                        var w = window.open(url, '_blank');
                        if (w) return;
                    } catch (e) {}
                    // 2) 标准 a.download 兜底（仍在用户手势内）
                    try {
                        var a = document.createElement('a');
                        a.href = url;
                        a.download = filename;
                        a.style.display = 'none';
                        document.body.appendChild(a);
                        a.click();
                        setTimeout(function () { if (a.parentNode) a.parentNode.removeChild(a); }, 1000);
                        return;
                    } catch (e2) {}
                    // 3) 最后尝试直接导航兜底
                    try { window.location.href = url; } catch (e3) {}
                }

                var btn = document.createElement('a');
                btn.id = '_mobile_dl_btn';
                btn.href = url;
                btn.setAttribute('download', filename);
                btn.innerHTML = '<span style="font-size:1.3rem;vertical-align:middle;">📥</span> 点击下载: ' + displayName;
                btn.style.cssText = [
                    'display:block;position:fixed;bottom:80px;left:50%;',
                    'transform:translateX(-50%);',
                    'background:linear-gradient(135deg,#059669,#10b981);',
                    'color:#fff;padding:14px 28px;border-radius:25px;',
                    'text-decoration:none;font-size:0.95rem;font-weight:600;',
                    'z-index:99999;box-shadow:0 4px 20px rgba(5,150,105,0.4);',
                    'white-space:nowrap;animation:_mbdlFadeIn .3s ease;cursor:pointer;'
                ].join('');
                btn.addEventListener('click', function (e) {
                    e.preventDefault();
                    triggerDownload();
                });
                if (!document.getElementById('_mobile_dl_style')) {
                    var s = document.createElement('style');
                    s.id = '_mobile_dl_style';
                    s.textContent = '@keyframes _mbdlFadeIn{from{opacity:0;transform:translateX(-50%) translateY(20px);}to{opacity:1;transform:translateX(-50%) translateY(0);}}';
                    document.head.appendChild(s);
                }
                document.body.appendChild(btn);

                // 兜底提示：长按链接 / 系统浏览器打开
                var tip = document.createElement('div');
                tip.id = '_mobile_dl_tip';
                tip.style.cssText = 'position:fixed;bottom:24px;left:50%;transform:translateX(-50%);max-width:92%;background:rgba(0,0,0,0.78);color:#fff;font-size:0.8rem;padding:8px 14px;border-radius:14px;z-index:99999;text-align:center;line-height:1.5;';
                if (isDataUrl) {
                    tip.innerHTML = '若点击仍无反应，请在手机<b>系统浏览器</b>中打开本页再下载';
                } else {
                    tip.innerHTML = '若点击无反应，可<b>长按下方链接</b>选择「保存」：<br><a id="_mobile_dl_link" href="' + url + '" style="color:#7dd3fc;word-break:break-all;">' + displayName + '</a>';
                }
                document.body.appendChild(tip);

                setTimeout(function() {
                    if (btn.parentNode) btn.parentNode.removeChild(btn);
                    if (tip.parentNode) tip.parentNode.removeChild(tip);
                    if (!isDataUrl) setTimeout(function() { URL.revokeObjectURL(url); }, 30000);
                }, 15000);
            }

            // ========== 复制文本（移动端 webview 兜底）==========
            window.copyTextToClipboard = async function(text) {
                try {
                    if (navigator.clipboard && navigator.clipboard.writeText) {
                        await navigator.clipboard.writeText(text);
                        return true;
                    }
                } catch (e) {}
                try {
                    var ta = document.createElement('textarea');
                    ta.value = text;
                    ta.style.position = 'fixed';
                    ta.style.top = '-9999px';
                    ta.style.opacity = '0';
                    document.body.appendChild(ta);
                    ta.focus();
                    ta.select();
                    var ok = document.execCommand('copy');
                    document.body.removeChild(ta);
                    return ok;
                } catch (e) { return false; }
            };

            // ========== 防抖工具 ==========
            window.debounce = function(fn, delay) {
                delay = delay || 300;
                var timer;
                return function() {
                    var args = arguments;
                    var ctx = this;
                    clearTimeout(timer);
                    timer = setTimeout(function() { fn.apply(ctx, args); }, delay);
                };
            };

            // ========== 设置面板 — 各模块数据计数更新 ==========
            window.updateDataManagementStats = async function() {
                var els = { handbook: 'set-handbook-count', issue: 'set-issue-count', rule: 'set-rule-count', diary: 'set-diary-count', phone: 'set-phone-count', wrmat: 'set-wr-count', wrrpt: 'set-wrhist-count', term: 'set-term-count' };
                var getters = {
                    handbook: function() { return window.getHandbookData ? window.getHandbookData().length : 0; },
                    issue:    function() { return window.getIssueData    ? window.getIssueData().length    : 0; },
                    rule:     function() { return window.getRulesData   ? window.getRulesData().length   : 0; },
                    diary:    function() { return window.getDiaryData   ? window.getDiaryData().length   : 0; },
                    phone:    function() { return window.getPhoneData   ? window.getPhoneData().length   : 0; },
                    wrmat:    async function() { return window.getWrMatCount ? await window.getWrMatCount() : '—'; },
                    wrrpt:    async function() { return window.getWrRptCount ? await window.getWrRptCount() : '—'; },
                    term:     function() { return window.getTermCount   ? window.getTermCount()          : '—'; }
                };
                var keys = Object.keys(els);
                for (var i = 0; i < keys.length; i++) {
                    var k = keys[i];
                    var el = document.getElementById(els[k]);
                    if (!el) continue;
                    var v = await getters[k]();
                    el.textContent = typeof v === 'number' ? v + '条' : v;
                }
            };
        })();

// ==================== 全局进度条 ====================
window.showProgress = function(pct, label) {
    var bar = document.getElementById('global-progress-bar');
    var fill = document.getElementById('global-progress-fill');
    var pctEl = document.getElementById('global-progress-pct');
    var labelEl = document.getElementById('global-progress-label');
    if (!bar) return;
    bar.style.display = 'block';
    if (fill) fill.style.width = Math.min(pct, 100) + '%';
    if (pctEl) pctEl.textContent = Math.round(pct) + '%';
    if (labelEl && label !== undefined) labelEl.textContent = label;
};
window.hideProgress = function() {
    var bar = document.getElementById('global-progress-bar');
    if (bar) { bar.style.display = 'none'; }
};
window.finishProgress = function(label) {
    window.showProgress(100, label || '✅ 完成');
    setTimeout(window.hideProgress, 2000);
};