/**
 * 安监智能辅助系统 · 完整六模块版
 * ===================================================
 * 应用入口文件 - 负责模块加载顺序和全局初始化协调
 * 
 * ===================================================
 * 项目结构:
 * ===================================================
 * src/
 *   css/
 *     variables.css        - CSS 变量/主题
 *     layout.css           - 布局
 *     components.css       - 组件样式
 *     modules.css          - 模块样式
 *     responsive.css       - 响应式
 *   js/
 *     app.js               - 入口文件 (本文件，含 PWA 安装提示 / 屏蔽 Kimi 扩展 逻辑，原 pwa.js/anti-kimi.js/engine.js 已内联)
 *     modules/
 *       utils.js           - 公共工具函数 (TAB_ORDER, switchTab, pinyinMatch, dbManager, storageManager, 全局进度条)
 *       errorMonitor.js    - 全局错误监控 (window error / unhandledrejection 捕获上报)
 *       perfMonitor.js     - 性能监控 (搜索耗时埋点)
 *       issue.js           - 检查信息模块 (IndexedDB + Fuse 模糊搜索)
 *       rule.js            - 规章制度模块 (IndexedDB + 全文检索)
 *       diary.js           - 工作日志模块 (写实记录)
 *       memo.js            - 备忘提醒模块
 *       phone.js           - 应急电话模块 (含天气查询)
 *       handbook.js        - 检查手册模块 (四级目录大纲)
 *       swipe.js           - 侧滑手势切换模块
 *       doubao-common.js   - 智能助手公共工具 (表格渲染/上下文拼装)
 *       smart-check.js     - 智能对规模块
 *       smart-writer.js    - 智能写作模块 (资料库/历史报告)
 *       doubao.js          - 智能助手主模块 (DeepSeek API 对话/对规/写作/BM25 检索)
 *       agent-memory.js    - 智能体任务记忆 (IndexedDB)
 *       agent-core.js      - 智能体规划器 + 工具集 (ReAct)
 *       backup.js          - 全局备份与恢复模块 (ZIP 打包)
 *
 * ===================================================
 * 外部依赖 (通过 <script> 标签在 HTML 中加载):
 * ===================================================
 *   - XLSX v0.18.5       : xlsx.full.min.js
 *   - pdf.js v2.16.105   : pdf.min.js (mammoth.js依赖)
 *   - Mammoth v1.4.2     : mammoth.browser.min.js (Word文档解析)
 *   - Fuse.js v6.6.2     : fuse.min.js (模糊搜索)
 *   - Pinyin v2.11.0     : pinyin.min.js (拼音匹配)
 *   - JSZip v3.10.1      : jszip.min.js (ZIP 打包)
 *   - xml-js v1.6.11     : xml-js.min.js (XML解析)
 *   - html-docx-js v0.3.1: html-docx.js (HTML转Word)
 *
 * ===================================================
 * 模块加载顺序:
 * ===================================================
 *   1. utils.js           - 公共工具 (最先加载，其他模块依赖)
 *   2. errorMonitor.js    - 全局错误监控
 *   3. perfMonitor.js     - 性能监控
 *   4. diary.js           - 工作日志
 *   5. issue.js           - 检查信息
 *   6. rule.js            - 规章制度
 *   7. memo.js            - 备忘提醒
 *   8. phone.js           - 应急电话
 *   9. handbook.js        - 检查手册
 *  10. swipe.js           - 侧滑手势
 *  11. doubao-common.js   - 智能助手公共工具
 *  12. smart-check.js     - 智能对规
 *  13. smart-writer.js    - 智能写作
 *  14. doubao.js          - 智能助手主模块
 *  15. agent-memory.js    - 智能体任务记忆
 *  16. agent-core.js      - 智能体规划器
 *  17. backup.js          - 备份恢复 (最后加载，依赖所有其他模块)
 *  (PWA 安装提示 / 屏蔽 Kimi 扩展逻辑已内联在本文件 app.js 中)
 *
 * ===================================================
 * HTML 结构要求:
 * ===================================================
 *   - .nav-btn[id=tab-*] : 导航按钮
 *   - .panel[id=panel-*] : 对应的面板容器
 *   - .modal[id]         : 模态框
 *   - 各模块特定 DOM 元素 (参见各模块文件注释)
 */

'use strict';

// ============================================================
// 初始化协调逻辑
// ============================================================

document.addEventListener('DOMContentLoaded', function() {
    console.log('%c安监智能辅助系统 · 初始化开始', 'color:#1a365d;font-weight:bold;');

    // 启动时检查存储配额（延迟3秒等各模块初始化完成）
    if (window.storageManager) {
        setTimeout(function() {
            window.storageManager.warnIfNearLimit(80).then(function(nearLimit) {
                if (!nearLimit) {
                    window.storageManager.checkQuota().then(function(info) {
                        console.log('[storage] 存储正常: ' + info.usageMB + '/' + info.quotaMB + ' MB (' + info.usagePercent.toFixed(1) + '%)');
                    });
                }
            });
        }, 3000);
    }

    // 各模块的初始化由各自的 IIFE 自行处理
    // 跨模块协调逻辑如下：
});

// ============================================================
// Agent 桥接函数（供 agent-core.js 工具调用）
// ============================================================
(function() {
    // ---- 智能体搜索辅助：模糊匹配(复用全局 Fuse，缓存实例) + 子串降级 ----
    var _fuseCache = {};
    function _getFuse(data, keys) {
        var cacheKey = keys.join(',');
        var entry = _fuseCache[cacheKey];
        // 缓存命中：同一数据集引用不重建 Fuse 索引（节省 3-5ms/次）
        if (entry && entry.data === data) return entry.fuse;
        var fuse = new window.Fuse(data, { keys: keys, threshold: 0.4, ignoreLocation: true, includeScore: true, minMatchCharLength: 1 });
        _fuseCache[cacheKey] = { data: data, fuse: fuse };
        return fuse;
    }
    function _fuzzyFilter(data, keyword, keys, limit) {
        limit = limit || 10;
        if (!keyword) return data.slice(0, limit);
        var kws = String(keyword).split(/[\s,，、]+/).filter(Boolean);
        if (!kws.length) return data.slice(0, limit);
        if (typeof window.Fuse !== 'undefined') {
            try {
                var fuse = _getFuse(data, keys);
                var map = {};
                kws.forEach(function(kw) {
                    fuse.search(kw).forEach(function(h) {
                        var i = data.indexOf(h.item);
                        if (i === -1) return;
                        if (!map[i]) map[i] = { item: h.item, n: 0 };
                        map[i].n++;
                    });
                });
                return Object.keys(map).map(function(k) { return map[k].item; }).slice(0, limit);
            } catch (e) {}
        }
        var lower = kws.map(function(k) { return k.toLowerCase(); });
        return data.filter(function(d) {
            return keys.some(function(k) {
                var v = (d[k] || '').toLowerCase();
                return lower.some(function(kw) { return v.indexOf(kw) !== -1; });
            });
        }).slice(0, limit);
    }
    /** 搜索检查信息（支持日期/性质筛选 + 模糊搜索） */
    window._agentGetIssues = function(keyword, unit, category, limit, dateFrom, dateTo, nature) {
        var data = [];
        try {
            if (typeof window.getIssueData === 'function') data = window.getIssueData();
        } catch(e) { return { total: 0, items: [] }; }
        if (!data.length) return { total: 0, items: [] };
        var filtered = data;
        if (unit) filtered = filtered.filter(function(i) { return (i.unit||'').indexOf(unit) !== -1; });
        if (category) filtered = filtered.filter(function(i) { return (i.category||'').indexOf(category) !== -1; });
        // 日期范围过滤（datetime 字段，前缀匹配即可）
        if (dateFrom) filtered = filtered.filter(function(i) { return (i.datetime||'') >= dateFrom; });
        if (dateTo)   filtered = filtered.filter(function(i) { return (i.datetime||'') <= dateTo + ' 23:59:59'; });
        // 性质筛选（A类/B类/C类/红线/空白）
        if (nature) filtered = filtered.filter(function(i) { return (i['性质']||'') === nature; });
        // 典型问题引用默认 35 条；用户要求更多时无硬上限
        var lim = (typeof limit === 'number' && limit > 0) ? limit : 35;
        // 先取未截断的全量匹配（用于统计总数），再按 lim 截取引用列表
        var matchedFull = _fuzzyFilter(filtered, keyword, ['性质','category','content','regulation','unit'], Number.MAX_SAFE_INTEGER);
        return { total: matchedFull.length, items: matchedFull.slice(0, lim) };
    };

    /** 统计检查信息（时间范围内全部计入，不封顶；可按 性质/category/unit 分组） */
    window._agentCountIssues = function(keyword, unit, category, dateFrom, dateTo, nature, groupBy) {
        var data = [];
        try {
            if (typeof window.getIssueData === 'function') data = window.getIssueData();
        } catch(e) { return { total: 0, groups: {} }; }
        if (!data.length) return { total: 0, groups: {} };
        var filtered = data;
        if (unit) filtered = filtered.filter(function(i) { return (i.unit||'').indexOf(unit) !== -1; });
        if (category) filtered = filtered.filter(function(i) { return (i.category||'').indexOf(category) !== -1; });
        if (dateFrom) filtered = filtered.filter(function(i) { return (i.datetime||'') >= dateFrom; });
        if (dateTo)   filtered = filtered.filter(function(i) { return (i.datetime||'') <= dateTo + ' 23:59:59'; });
        if (nature) filtered = filtered.filter(function(i) { return (i['性质']||'') === nature; });
        var kw = (keyword && String(keyword).trim()) ? keyword : '';
        var matched = kw ? _fuzzyFilter(filtered, kw, ['性质','category','content','regulation','unit'], Number.MAX_SAFE_INTEGER) : filtered;
        var groups = {};
        if (groupBy) {
            matched.forEach(function(i) {
                var k = (i[groupBy] != null && i[groupBy] !== '') ? i[groupBy] : '(未分类)';
                groups[k] = (groups[k] || 0) + 1;
            });
        }
        return { total: matched.length, groups: groups };
    };

    /** 搜索规章制度（返回 {total:未截断匹配数, items:截断列表}，与 search_issues 一致，避免 AI 统计相关条数时被 limit 截断） */
    window._agentGetRules = function(keyword, limit) {
        var rules = [];
        try {
            if (typeof window.getRulesData === 'function') rules = window.getRulesData();
        } catch(e) { return { total: 0, items: [] }; }
        if (!rules.length) return { total: 0, items: [] };
        var lim = (typeof limit === 'number' && limit > 0) ? limit : 10;
        // 先用未截断的全量匹配统计真实总数，再按 lim 截取引用列表
        var matchedFull = _fuzzyFilter(rules, keyword, ['title','content','trade'], Number.MAX_SAFE_INTEGER);
        return { total: matchedFull.length, items: matchedFull.slice(0, lim) };
    };

    /** 写入工作日志（支持结构化 issueIds） */
    window._agentWriteDiary = async function(content, issues, date, issueIds) {
        try {
            if (typeof window.addIssueToDiary !== 'function') return { ok: false, error: '日志模块未就绪' };
            var fullContent = (content || '').trim();
            if (issueIds && Array.isArray(issueIds) && issueIds.length) {
                var issueData = window.getIssueData ? window.getIssueData() : [];
                issueIds.forEach(function(id) {
                    var iss = issueData[id];
                    if (!iss) return;
                    fullContent += '\n  · [' + (iss['性质']||'') + '] ' + (iss.content||'').slice(0,80) + '（' + (iss.unit||'') + '）';
                });
            } else if (issues && String(issues).trim()) {
                fullContent += (fullContent ? '｜' : '') + '发现问题：' + String(issues).trim();
            }
            // addIssueToDiary 无返回值（成功亦为 undefined），未抛异常即视为写入成功
            window.addIssueToDiary(fullContent, '', date || '');
            return { ok: true, message: '日志已写入' };
        } catch(e) { return { ok: false, error: e.message }; }
    };

    /** 保存报告到写作资料库（同名自动追加 vN 防覆盖） */
    window._agentSaveReport = async function(title, content) {
        try {
            if (typeof window.wrAgentSaveMaterial !== 'function') return { ok: false, error: '写作模块未就绪' };
            // 查重：若同名已存在，自动追加版本号
            var existing = [];
            try {
                if (typeof window._wrGetAllReports === 'function') existing = await window._wrGetAllReports();
                else if (typeof window.getWrMatList === 'function') existing = await window.getWrMatList();
            } catch(e) { existing = []; }
            var sameCount = existing.filter(function(m) { return (m.title||'').trim() === (title||'').trim(); }).length;
            var finalTitle = sameCount > 0 ? (title + '（v' + (sameCount + 1) + '）') : title;
            var ok = window.wrAgentSaveMaterial(finalTitle, content);
            return { ok: !!ok, message: ok ? '报告已保存' : '保存失败', title: finalTitle };
        } catch(e) { return { ok: false, error: e.message }; }
    };

    /** 搜索手册（返回 {total:未截断匹配数, items:截断列表}，与 search_issues 一致） */
    window._agentGetHandbook = function(keyword, limit) {
        var hb = [];
        try {
            if (typeof window.getHandbookData === 'function') hb = window.getHandbookData();
        } catch(e) { return { total: 0, items: [] }; }
        if (!hb.length) return { total: 0, items: [] };
        var lim = (typeof limit === 'number' && limit > 0) ? limit : 10;
        var matchedFull = _fuzzyFilter(hb, keyword, ['chapter','section','item','subitem','content'], Number.MAX_SAFE_INTEGER);
        return { total: matchedFull.length, items: matchedFull.slice(0, lim) };
    };

    /** 按 id(数组下标) 取单条完整记录，供智能体按需获取全文 */
    window._agentGetIssueDetail = function(id) {
        try { return (window.getIssueData() || [])[id] || null; } catch(e) { return null; }
    };
    window._agentGetRuleDetail = function(id) {
        try { return (window.getRulesData() || [])[id] || null; } catch(e) { return null; }
    };
    window._agentGetHandbookDetail = function(id) {
        try { return (window.getHandbookData() || [])[id] || null; } catch(e) { return null; }
    };
})();

// ============================================================
// 全局事件处理
// ============================================================

// --- DeepSeek 气泡样式 ---
(function() {
    const style = document.createElement('style');
    style.textContent = [
        '.ds-row-user { display:flex; justify-content:flex-end; }',
        '.ds-row-assistant { display:flex; justify-content:flex-start; }',
        '.ds-row-system { display:flex; justify-content:center; }',
        '.ds-bubble-user {',
        '    background:#dbeafe;',
        '    color:#1e3a5f;',
        '    padding:10px 14px;',
        '    border-radius:14px 14px 4px 14px;',
        '    max-width:75%;',
        '    font-size:0.92rem;',
        '    line-height:1.6;',
        '    white-space:pre-wrap;',
        '    word-break:break-word;',
        '}',
        '.ds-bubble-assistant {',
        '    background:#fff;',
        '    color:var(--text);',
        '    padding:10px 14px;',
        '    border-radius:14px 14px 14px 4px;',
        '    max-width:85%;',
        '    font-size:0.92rem;',
        '    line-height:1.7;',
        '    word-break:break-word;',
        '    white-space:pre-wrap;',
        '    box-shadow:0 1px 4px rgba(0,0,0,.08);',
        '    border:1px solid var(--border);',
        '}',
        '.ds-bubble-system {',
        '    background:#fff3cd;',
        '    color:#856404;',
        '    padding:8px 14px;',
        '    border-radius:8px;',
        '    font-size:0.85rem;',
        '    max-width:90%;',
        '    white-space:pre-wrap;',
        '    word-break:break-word;',
        '    border:1px solid #ffc107;',
        '}',
        '.ds-cursor { animation:dsBlink 1s step-end infinite; }',
        '@keyframes dsBlink { 0%,100%{opacity:1;} 50%{opacity:0;} }',
        '.ds-typing {',
        '    display:inline-flex;align-items:center;gap:6px;',
        '    color:var(--text-secondary);font-size:0.85rem;',
        '}',
        '.ds-typing::before {',
        '    content:"";display:inline-block;',
        '    width:14px;height:14px;',
        '    border:2px solid var(--border);',
        '    border-top-color:var(--primary);',
        '    border-radius:50%;',
        '    animation:dsSpin 0.6s linear infinite;',
        '    flex-shrink:0;',
        '}',
        '@keyframes dsSpin { to{transform:rotate(360deg)} }',
        '.ds-typing .ds-dot { display:inline-block;animation:dsDotBounce 1.4s infinite; }',
        '.ds-typing .ds-dot:nth-child(2) { animation-delay:.2s; }',
        '.ds-typing .ds-dot:nth-child(3) { animation-delay:.4s; }',
        '@keyframes dsDotBounce { 0%,80%,100%{opacity:0;transform:translateY(0)} 40%{opacity:1;transform:translateY(-3px)} }'
    ].join('');
    document.head.appendChild(style);
})();

// 全局回车搜索
document.addEventListener('keypress', function(e) {
    if (e.key === 'Enter') {
        var activePanel = document.querySelector('.panel.active');
        if (!activePanel) return;
        if (activePanel.id === 'panel-issue') issueDoSearch();
        else if (activePanel.id === 'panel-rule') renderResults();
        else if (activePanel.id === 'panel-phone') phoneDoSearch();
    }
});

// 点击模态框外部关闭
window.onclick = function(e) {
    if (e.target.classList.contains('modal')) e.target.classList.remove('active');
};

// ============================================================
// PWA 安装提示
// ============================================================
(function() {
    // 无论当前环境是否支持 Service Worker，都先给这几个对外接口一个安全的空实现。
    // 不支持 SW 时下面的 return 会让整个 IIFE 提前结束，若不在此处兜底，
    // window.switchUpdateBtn 等会一直是 undefined —— 调用方虽然大多有判空，
    // 但新增调用点很容易漏掉，属于隐患。有空实现则调用方永远拿到函数。
    window.switchUpdateBtn = window.switchUpdateBtn || function() {};
    window.triggerApplyUpdate = window.triggerApplyUpdate || function() {};
    window.applyPendingUpdate = window.applyPendingUpdate || function() {};

    if (!('serviceWorker' in navigator)) return;
    var _deferredPrompt = null;
    var _installBtn = null;
    var _installBtnAdded = false;

    var _manualUpdateCheck = false;  // 仅手动「检查更新」时才弹新版本提示
    var _pendingReload = false;      // 手动更新后，新 SW 接管即刷新
    var _pendingReloadAt = 0;        // _pendingReload 置位时间戳，用于有效期判断（防折叠屏误重载）

    // 离线优先策略：SW 默认直接从缓存秒开页面，打开时不联网拉取 HTML/JS/CSS，
    // 也不在打开时自动检查更新。新版本仅由用户点击「设置→检查更新」触发下载。
    console.log('[PWA] SW 注册中(离线优先)...');

    // 必须给 register 兜底：非 HTTPS 站点、隐私模式、被裁剪的 WebView 都可能让
    // register 直接抛错或 reject。原实现既无 try/catch 也无 .catch()，一旦失败
    // 整个 IIFE 就中断了 —— 后面的 triggerApplyUpdate / switchUpdateBtn /
    // applyPendingUpdate 全部不会挂到 window 上，设置面板的「检查更新」直接失效，
    // 表现就是「部分功能点不了」。
    var _regPromise = null;
    try {
        _regPromise = navigator.serviceWorker && navigator.serviceWorker.register
            ? navigator.serviceWorker.register('sw.js')
            : null;
    } catch (swErr) {
        console.warn('[PWA] SW 注册异常，降级为无离线模式:', swErr && swErr.message);
        _regPromise = null;
    }
    if (!_regPromise || typeof _regPromise.then !== 'function') {
        console.warn('[PWA] 当前环境不支持 Service Worker，离线能力不可用');
        _regPromise = null;
    } else {
        _regPromise.catch(function (swErr) {
            console.warn('[PWA] SW 注册失败，降级为无离线模式:', swErr && swErr.message);
        });
    }

    (_regPromise || Promise.resolve(null)).then(function(reg) {
        if (!reg) return;                       // SW 不可用：保持已有 UI，不做注册后逻辑
        console.log('[PWA] SW 注册成功');

        // 【v3.38】离线优先：打开时【不】调用 reg.update()，避免在后台静默从远程重新下载新 SW/资源。
        // 系统默认打开完全使用离线内容（SW 已 CacheFirst 提供页面）。
        // 新版本仅在用户点击「设置 → 检查更新」时通过 triggerApplyUpdate() 主动拉取并预备（waiting 状态）。

        // 检测新版本：仅手动检查时才提示，避免打开即打扰
        reg.addEventListener('updatefound', function() {
            var sw = reg.installing;
            sw.addEventListener('statechange', function() {
                if (sw.state === 'installed' && navigator.controller) {
                    if (_manualUpdateCheck && window.switchUpdateBtn) window.switchUpdateBtn('update');
                }
            });
        });
    }).catch(function(err) {
        console.warn('[PWA] SW 注册失败:', err);
    });

    // 新 SW 接管页面后，若本次为手动更新则刷新以应用新版本
    navigator.serviceWorker.addEventListener('controllerchange', function() {
        _fetchSwVersion(); // 刷新离线获取的 12 位版本号
        // 修复：_pendingReload 仅在有效期内（10s）生效，过期作废。
        // 避免折叠屏文档重建偶然触发历史残留 reload（用户曾点过「立即更新」但未真正生效），
        // 导致「明明没更新却重启」的误重载。
        if (_pendingReloadAt && (Date.now() - _pendingReloadAt) > 10000) {
            _pendingReload = false;
            _pendingReloadAt = 0;
        }
        if (_pendingReload) {
            _pendingReload = false;
            _pendingReloadAt = 0;
            window.location.reload();
        }
    });

    // 暴露给「检查更新」按钮：拉取并预备最新版本（离线优先下更新唯一入口）
    function triggerApplyUpdate() {
        _manualUpdateCheck = true;
        // SW 不可用时（非 HTTPS / 隐私模式 / 注册失败）直接退出，
        // 否则后面 getRegistration() 会抛错，点「检查更新」等于点了没反应。
        if (!navigator.serviceWorker || !navigator.serviceWorker.getRegistration) {
            _manualUpdateCheck = false;
            return;
        }
        navigator.serviceWorker.getRegistration().then(function(reg) {
            if (!reg) { _manualUpdateCheck = false; return; }
            // 浏览器已自动检测到等待中的新 SW：直接提示应用
            if (reg.waiting) { if (window.switchUpdateBtn) window.switchUpdateBtn('update'); return; }
            var done = false;
            var onReady = function(r) { if (r && r.waiting && !done) { done = true; if (window.switchUpdateBtn) window.switchUpdateBtn('update'); } };
            reg.update().then(function() {
                // updatefound 会处理；兜底 2s 后再查一次 waiting 状态
                setTimeout(function() { navigator.serviceWorker.getRegistration().then(onReady); }, 2000);
            }).catch(function(e) {
                console.warn('[PWA] SW 更新检查失败:', e);
                _manualUpdateCheck = false;
            });
        });
    }
    window.triggerApplyUpdate = triggerApplyUpdate;

    // 【v3.26】执行「立即更新」：通知等待中的新 SW 立即接管（SKIP_WAITING），
    // 由 controllerchange 触发刷新应用新版本。设置面板原位按钮与各入口共用。
    // 关键：SKIP_WAITING 必须发给 reg.waiting（等待中的新 SW），不能发给
    // navigator.serviceWorker.controller（当前控制的旧 SW，收了也不会激活）。
    // 也不要在此同步 reload()——否则新 SW 尚未激活、页面仍在旧 SW 控制下刷新，
    // 会导致「检测到新版本→点更新→仍是旧版→再次检测」死循环。
    // 真正刷新交由 controllerchange 事件（新 SW 确实接管后才触发）。
    function applyPendingUpdate() {
        _pendingReload = true;
        _pendingReloadAt = Date.now();
        // 应用更新：清除红点标记（刷新后由新版本接管，_has_update 不再成立）
        try { localStorage.removeItem('_has_update'); } catch (e) {}
        document.getElementById('tab-settings')?.classList.remove('has-update-badge');
        document.getElementById('check-update-btn')?.classList.remove('has-update-badge');
        navigator.serviceWorker.getRegistration().then(function(reg) {
            var target = (reg && reg.waiting) ? reg.waiting : navigator.serviceWorker.controller;
            if (target) target.postMessage({ type: 'SKIP_WAITING' });
        }).catch(function() {});
        // 兜底：若 1.5s 内 controllerchange 未触发（极端情况），强制刷新一次确保生效
        setTimeout(function() {
            if (_pendingReload) {
                _pendingReload = false;
                window.location.reload();
            }
        }, 1500);
    }
    window.applyPendingUpdate = applyPendingUpdate;

    // 【v3.26】设置面板「检查更新」按钮原位切换（v3.25 起：发现新版本时，
    // 立即更新按钮直接覆盖在检查更新按钮位置；更新完成/无新版本时恢复检查更新）。
    // mode: 'normal'(检查更新) | 'checking'(检查中) | 'update'(循环图标立即更新)
    function switchUpdateBtn(mode) {
        var btn = document.getElementById('check-update-btn');
        if (!btn) return;
        var title = document.getElementById('check-update-title');
        var arrow = document.getElementById('check-update-arrow');
        var ver = document.getElementById('setting-current-version');
        if (mode === 'update') {
            btn.onclick = function() { applyPendingUpdate(); };
            btn.classList.add('has-update-badge');
            btn.style.background = 'var(--primary)';
            btn.style.borderColor = 'var(--primary)';
            btn.style.color = '#fff';
            if (title) { title.textContent = '🔄 立即更新'; title.style.color = '#fff'; }
            if (arrow) arrow.textContent = '点击应用 →';
            if (ver) ver.style.color = 'rgba(255,255,255,.85)';
        } else if (mode === 'checking') {
            btn.onclick = function() { checkForUpdate(); };
            btn.style.background = 'var(--card-bg)';
            btn.style.borderColor = 'var(--border)';
            btn.style.color = 'inherit';
            if (title) { title.textContent = '⏳ 正在检查…'; title.style.color = 'inherit'; }
            if (arrow) arrow.textContent = '';
            if (ver) ver.style.color = '#94a3b8';
        } else { // normal
            btn.onclick = function() { checkForUpdate(); };
            btn.classList.remove('has-update-badge');
            btn.style.background = 'var(--card-bg)';
            btn.style.borderColor = 'var(--border)';
            btn.style.color = 'inherit';
            if (title) { title.textContent = '🔄 检查更新'; title.style.color = 'inherit'; }
            if (arrow) arrow.textContent = '点击检查 →';
            if (ver) ver.style.color = '#94a3b8';
        }
    }
    window.switchUpdateBtn = switchUpdateBtn;

    window.addEventListener('beforeinstallprompt', function(e) {
        if (localStorage.getItem('pwa_install_dismissed') === '1') return;
        e.preventDefault();
        _deferredPrompt = e;
        showInstallButton();
    });

    window.addEventListener('appinstalled', function() {
        console.log('[PWA] 应用已安装');
        _deferredPrompt = null;
        hideInstallButton();
    });

    function showInstallButton() {
        if (_installBtnAdded) return;
        _installBtnAdded = true;
        _installBtn = document.createElement('div');
        _installBtn.id = '_pwa_install_bar';
        _installBtn.innerHTML = [
            '<span style="font-size:1.2rem;">📲</span>',
            '<span style="flex:1;text-align:left;">安装「安监助手」到桌面</span>',
            '<button id="_pwa_install_btn" style="',
            '  background:var(--card-bg);color:var(--text);border:none;border-radius:20px;',
            '  padding:6px 18px;font-size:0.85rem;font-weight:700;cursor:pointer;',
            '  white-space:nowrap;',
            '">安装</button>',
            '<button id="_pwa_install_close" style="',
            '  background:none;border:none;color:rgba(255,255,255,0.6);',
            '  font-size:1.1rem;cursor:pointer;padding:0 4px;margin-left:4px;',
            '">✕</button>'
        ].join('');
        Object.assign(_installBtn.style, {
            position:'fixed', bottom:'0', left:'0', right:'0',
            background:'rgba(26,54,93,0.97)', color:'#fff',
            display:'flex', alignItems:'center', gap:'8px',
            padding:'12px 16px', zIndex:'99999',
            fontSize:'0.92rem', fontWeight:'600',
            boxShadow:'0 -2px 12px rgba(0,0,0,.25)',
            transform:'translateY(100%)', transition:'transform .3s ease'
        });
        document.body.appendChild(_installBtn);
        requestAnimationFrame(function() { _installBtn.style.transform = 'translateY(0)'; });

        document.getElementById('_pwa_install_btn').onclick = function() {
            if (!_deferredPrompt) return;
            _deferredPrompt.prompt();
            _deferredPrompt.userChoice.then(function(choice) {
                console.log('[PWA] 用户选择:', choice.outcome);
                _deferredPrompt = null;
            });
        };
        document.getElementById('_pwa_install_close').onclick = function() {
            hideInstallButton();
            try { localStorage.setItem('pwa_install_dismissed', '1'); } catch(e) {}
        };
    }

    function hideInstallButton() {
        if (_installBtn) {
            _installBtn.style.transform = 'translateY(100%)';
            setTimeout(function() {
                if (_installBtn && _installBtn.parentNode) _installBtn.parentNode.removeChild(_installBtn);
                _installBtnAdded = false;
                _installBtn = null;
            }, 300);
        }
    }

    if (window.matchMedia('(display-mode: standalone)').matches) {
        console.log('[PWA] 已作为应用运行');
    }
})();

// ============================================================
// 屏蔽 Kimi 扩展悬浮按钮（JS 层兜底）
// ============================================================
(function() {
    function removeKimiElements() {
        document.querySelectorAll('[id*="kimi" i],[class*="kimi" i],[class*="kimi-extension" i]').forEach(function(el) {
            if (el.id !== '_block_kimi_fab' && el.closest('header,main,nav,section')) return;
            el.remove();
        });
        document.querySelectorAll('kimi-chat-widget,kimi-fab').forEach(function(el) { el.remove(); });
        document.querySelectorAll('body > div').forEach(function(el) {
            var s = getComputedStyle(el);
            if (s.position === 'fixed' && s.zIndex && parseInt(s.zIndex) > 100000 && !el.id && !el.className) {
                el.remove();
            }
        });
    }
    setTimeout(removeKimiElements, 500);
    setTimeout(removeKimiElements, 2000);
    var mo = new MutationObserver(function() {
        removeKimiElements();
    });
    mo.observe(document.body, { childList: true, subtree: true });
})();

window.toggleSettingsPanel = function() {
    var p = document.getElementById('settings-panel');
    if (!p) return;
    var isOpening = (p.style.display === 'none' || p.style.display === '');
    if (isOpening) {
        p.style.display = 'block';
        if (window.updateDataManagementStats) window.updateDataManagementStats();
        if (window.syncDarkModeToggle) window.syncDarkModeToggle();
        if (window.syncCapabilityToggles) window.syncCapabilityToggles();
        // 移动端：展开设置时自动收起顶部导航下拉（模块选择框），与其它模块按钮行为一致（否则下拉残留重叠）
        var nav = document.getElementById('mainNav');
        var toggle = document.getElementById('navToggle');
        if (nav && nav.classList.contains('nav-open')) {
            nav.classList.remove('nav-open');
            if (toggle) toggle.classList.remove('open');
        }
    } else {
        p.style.display = 'none';
    }
};

// 点击设置面板外部（含页面任意其它区域）自动收起设置下拉窗，与工具按钮下拉行为一致
document.addEventListener('click', function(e) {
    var p = document.getElementById('settings-panel');
    if (!p || p.style.display === 'none') return;
    var btn = document.getElementById('tab-settings');
    if (p.contains(e.target)) return;          // 点面板内部不关
    if (btn && btn.contains(e.target)) return;  // 点设置按钮本身不关（由 toggleSettingsPanel 处理）
    p.style.display = 'none';
});

window.clearAllCache = function() {
    if (!confirm('⚠️ 将清除所有缓存数据并刷新页面，确定继续？')) return;

    var pending = [];

    // 清除 SW 缓存（等待删除完成，避免竞态导致旧缓存残留）
    if ('caches' in window) {
        pending.push(
            caches.keys().then(function(names) {
                return Promise.all(names.map(function(n) { return caches.delete(n); }));
            })
        );
    }
    // 注销 SW 注册
    if ('serviceWorker' in navigator) {
        pending.push(
            navigator.serviceWorker.getRegistrations().then(function(regs) {
                return Promise.all(regs.map(function(r) { return r.unregister(); }));
            })
        );
    }

    // 等所有清理完成再刷新（不再用固定 300ms 强刷，杜绝竞态）
    Promise.all(pending).then(function() {
        location.reload(true);
    }).catch(function() {
        location.reload(true);
    });
};

window.showAboutPanel = function() {
    var p = document.getElementById('about-panel');
    if (p) p.style.display = 'flex';
};

// ==================== 主题模式（跟随系统 / 亮色 / 暗黑） ====================
function _readThemeMode() {
    try {
        var m = localStorage.getItem('themeMode');
        if (!m && localStorage.getItem('darkMode') !== null) {
            m = localStorage.getItem('darkMode') === '1' ? 'dark' : 'light';
        }
        return m || 'system';
    } catch (e) { return 'system'; }
}

function _systemPrefersDark() {
    return !!(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
}

// 依据 themeMode 计算实际明暗并应用到 <html data-theme>
function applyTheme() {
    var mode = _readThemeMode();
    var dark = mode === 'dark' || (mode === 'system' && _systemPrefersDark());
    if (dark) document.documentElement.setAttribute('data-theme', 'dark');
    else document.documentElement.removeAttribute('data-theme');
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', dark ? '#1e1e1e' : '#ffffff');
    syncThemeModeUI();
    return mode;
}

// 设置主题模式并持久化（兼容旧 darkMode 字段）
window.setThemeMode = function(mode) {
    try {
        localStorage.setItem('themeMode', mode);
        localStorage.removeItem('darkMode');
    } catch (e) {}
    applyTheme();
};

// 同步三态分段控件选中态 + 提示文字
function syncThemeModeUI() {
    var seg = document.getElementById('themeModeSeg');
    if (!seg) return;
    var mode = _readThemeMode();
    var btns = seg.querySelectorAll('button[data-mode]');
    if (btns.forEach) {
        btns.forEach(function(b) {
            var on = b.getAttribute('data-mode') === mode;
            b.style.background = on ? 'var(--primary)' : 'var(--card-bg)';
            b.style.color = on ? '#fff' : 'var(--text)';
            b.style.borderColor = on ? 'var(--primary)' : 'var(--border)';
            b.style.fontWeight = on ? '700' : '400';
        });
    }
    var hint = document.getElementById('themeModeHint');
    if (hint) {
        hint.textContent = mode === 'system'
            ? ('跟随系统（当前' + (_systemPrefersDark() ? '暗黑' : '亮色') + '）')
            : (mode === 'dark' ? '已固定为暗黑' : '已固定为亮色');
    }
}
// 兼容旧调用入口
window.syncDarkModeToggle = function() { syncThemeModeUI(); };
// 兼容旧开关（如有地方仍以布尔切换）
window.toggleDarkMode = function(on) { window.setThemeMode(on ? 'dark' : 'light'); };

// DeepSeek V4 能力开关：思考模式 / JSON 输出模式
window.toggleThinkingMode = function(on) {
    try { localStorage.setItem('ds_thinking', on ? '1' : '0'); } catch (e) {}
    var hint = document.getElementById('thinkingHint');
    if (hint) hint.textContent = on ? '开启' : '关闭';
};
window.toggleJsonMode = function(on) {
    try { localStorage.setItem('ds_json_mode', on ? '1' : '0'); } catch (e) {}
    var hint = document.getElementById('jsonModeHint');
    if (hint) hint.textContent = on ? '开启' : '关闭';
};
window.toggleToolCalls = function(on) {
    try { localStorage.setItem('ds_tool_calls', on ? '1' : '0'); } catch (e) {}
    var hint = document.getElementById('toolCallsHint');
    if (hint) hint.textContent = on ? '开启' : '关闭';
};
// P2 对话前缀续写（Beta）：默认关
window.togglePrefixMode = function(on) {
    try { localStorage.setItem('ds_prefix', on ? '1' : '0'); } catch (e) {}
    var hint = document.getElementById('prefixHint');
    if (hint) hint.textContent = on ? '开启' : '关闭';
};
// 进入设置时同步 V4 能力开关状态
window.syncCapabilityToggles = function() {
    var t = document.getElementById('thinkingToggle');
    if (t) { var on = localStorage.getItem('ds_thinking') !== '0'; t.checked = on; var h = document.getElementById('thinkingHint'); if (h) h.textContent = on ? '开启' : '关闭'; }
    var j = document.getElementById('jsonModeToggle');
    if (j) { var jon = localStorage.getItem('ds_json_mode') === '1'; j.checked = jon; var h2 = document.getElementById('jsonModeHint'); if (h2) h2.textContent = jon ? '开启' : '关闭'; }
    var tc = document.getElementById('toolCallsToggle');
    if (tc) { var tcon = localStorage.getItem('ds_tool_calls') === '1'; tc.checked = tcon; var h3 = document.getElementById('toolCallsHint'); if (h3) h3.textContent = tcon ? '开启' : '关闭'; }
    var pf = document.getElementById('prefixToggle');
    if (pf) { var pfon = localStorage.getItem('ds_prefix') === '1'; pf.checked = pfon; var h4 = document.getElementById('prefixHint'); if (h4) h4.textContent = pfon ? '开启' : '关闭'; }
};

// API 配置：根据选中的 API 地址自动推荐模型
window._updateModelList = function() {
    var urlEl = document.getElementById('modal-apiurl');
    var modelEl = document.getElementById('modal-model');
    if (!urlEl || !modelEl) return;
    var url = (urlEl.value || '').trim();
    // 常用 API 地址 → 默认模型映射
    var map = {
        'https://api.deepseek.com/chat/completions': 'deepseek-v4-flash',
        'https://api.openai.com/v1/chat/completions': 'gpt-5-mini',
        'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions': 'qwen3-turbo',
        'https://open.bigmodel.cn/api/paas/v4/chat/completions': 'GLM-5-Flash',
        'https://api.moonshot.cn/v1/chat/completions': 'kimi-k2-turbo',
        'https://api.baichuan-ai.com/v1/chat/completions': 'Baichuan4-Turbo',
        'https://api.minimax.chat/v1/text/chatcompletion_v2': 'abab7',
        'https://api.stepfun.com/v1/chat/completions': 'step-2-16k'
    };
    if (map[url]) modelEl.value = map[url];
};

console.log('%c安监智能辅助系统 · app.js 已加载', 'color:#1a365d;font-weight:bold;');

// ==================== 版本管理 ====================
const APP_VERSION = 'v3.47'; // 单一版本源：设置面板与关于面板的版本号均在 DOMContentLoaded 时从此注入；发版时只需改此处 + 同步 version.json
// 检查更新源：读取「当前部署站点同源」的 version.json（./version.json，随 CloudStudio/EdgeOne 等部署环境自动指向当前域名）
// 注意：version.json 在 SW 中走网络策略（不读缓存，fetch 落入“其他请求”分支直连网络），可拿到最新部署版本
const UPDATE_CHECK_URL = './version.json';
// 12 位 SW 缓存版本号（YYYYMMDDHHMMSS），从 sw.js 提取后注入设置/关于面板
var _SW_VERSION = '';

// 页面加载时注入版本号（设置面板 + 关于面板均从 APP_VERSION 动态取，避免 HTML 写死陈旧值）
function _applySwVersion() {
    if (!_SW_VERSION) return;
    var verSpan = document.getElementById('setting-current-version');
    if (verSpan && !verSpan.textContent.includes('·')) verSpan.textContent = APP_VERSION + ' · ' + _SW_VERSION;
    var aboutVer = document.getElementById('about-app-version');
    if (aboutVer && !aboutVer.textContent.includes('·')) aboutVer.textContent = APP_VERSION + ' · ' + _SW_VERSION;
}

// 通过 SW 消息(完全离线)获取 12 位缓存版本号，避免打开时联网 fetch sw.js
function _fetchSwVersion() {
    if (!('serviceWorker' in navigator) || !navigator.serviceWorker.controller) return;
    try {
        var ch = new MessageChannel();
        ch.port1.onmessage = function(e) {
            if (e.data && e.data.type === 'SW_VERSION' && e.data.version) {
                _SW_VERSION = e.data.version;
                _applySwVersion();
            }
        };
        navigator.serviceWorker.controller.postMessage({ type: 'GET_SW_VERSION' }, [ch.port2]);
    } catch (e) {}
}

document.addEventListener('DOMContentLoaded', function() {
    // 主题模式：旧 darkMode(0/1) 迁移到新的 themeMode，再应用（首屏内联脚本已提前设好，避免闪烁）
    try {
        if (!localStorage.getItem('themeMode') && localStorage.getItem('darkMode') !== null) {
            localStorage.setItem('themeMode', localStorage.getItem('darkMode') === '1' ? 'dark' : 'light');
            localStorage.removeItem('darkMode');
        }
    } catch (e) {}
    applyTheme();
    // 跟随系统：OS 主题切换时实时更新（仅在 system 模式下生效）
    try {
        if (window.matchMedia) {
            window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', function () {
                if (_readThemeMode() === 'system') applyTheme();
            });
        }
    } catch (e) {}
    if (window.syncCapabilityToggles) window.syncCapabilityToggles();
    var verSpan = document.getElementById('setting-current-version');
    if (verSpan) verSpan.textContent = APP_VERSION;
    var aboutVer = document.getElementById('about-app-version');
    if (aboutVer) aboutVer.textContent = APP_VERSION;
    // 离线获取 SW 缓存版本号（12位精确时间戳），追加显示到版本号后
    _fetchSwVersion();
    // 离线恢复更新红点：若此前检测到新版本但未应用，离线打开仍提示（不联网拉取）
    try {
      if (localStorage.getItem('_has_update') === 'true') {
        document.getElementById('tab-settings')?.classList.add('has-update-badge');
        document.getElementById('check-update-btn')?.classList.add('has-update-badge');
      }
    } catch (e) {}
    // 折叠屏/旋转会话状态恢复：文档重建后还原模块、滚动位置、草稿、弹窗
    if (window._restorePageState) {
        try { window._restorePageState(); } catch (e) { console.warn('[page-state] 恢复失败', e); }
    }
    // 自动检查更新：系统以离线数据完全打开后 30s，再连接远程测试有无新版本；
    // 仅在线时执行（离线时页面照常使用本地缓存，不打扰、不阻塞）。发现更新在页面顶部弹提示条。
    // 内置 1 小时节流（silentCheckUpdate）：避免频繁请求版本服务器。
    if (navigator.onLine !== false) {
        setTimeout(function() {
            if (navigator.onLine !== false && typeof silentCheckUpdate === 'function') {
                silentCheckUpdate();
            }
        }, 30000);
    }
    // 网络恢复后立即补一次检查：此前离线打开则不会弹出更新提示
    window.addEventListener('online', function() {
        try { if (typeof silentCheckUpdate === 'function') silentCheckUpdate(); } catch (e) {}
    });
});

// 手动检查（点击设置中的检查更新按钮触发）
async function checkForUpdate() {
    const statusEl = document.getElementById('update-status');
    if (!statusEl) return;
    // v3.26：检查中按钮显示为「⏳ 正在检查…」
    if (window.switchUpdateBtn) window.switchUpdateBtn('checking');
    statusEl.textContent = '⏳ 正在检查...';
    statusEl.style.color = 'var(--primary)';
    await performUpdateCheck(UPDATE_CHECK_URL, true);
    // 同时触发 SW 实际拉取并预备新版本（离线优先策略下，更新只在此时发生）
    if (window.triggerApplyUpdate) window.triggerApplyUpdate();
}

// 静默检查
async function silentCheckUpdate() {
    const lastCheck = localStorage.getItem('_last_version_check');
    if (lastCheck && (Date.now() - parseInt(lastCheck)) < 3600000) {
        return;
    }
    await performUpdateCheck(UPDATE_CHECK_URL, false);
    localStorage.setItem('_last_version_check', Date.now());
}

// 页面顶部更新提示条：发现新版本时弹出小窗，点击即应用更新（离线优先策略下，
// 新 SW 已由 triggerApplyUpdate 预拉取进入 waiting，点击触发 SKIP_WAITING + 刷新）。
function showUpdateBanner(remoteVersion) {
    if (!remoteVersion) return;
    var existing = document.getElementById('_update_banner');
    if (existing) {
        var txt = existing.querySelector('[data-ver]');
        if (txt) txt.textContent = '🆕 发现新版本 ' + remoteVersion + '，点击立即更新';
        return;
    }
    var bar = document.createElement('div');
    bar.id = '_update_banner';
    bar.innerHTML =
        '<span data-ver style="flex:1;text-align:left;line-height:1.3;">🆕 发现新版本 ' + remoteVersion + '，点击立即更新</span>' +
        '<button data-close style="background:none;border:none;color:rgba(255,255,255,0.75);' +
        'font-size:1.1rem;cursor:pointer;margin-left:8px;padding:0 4px;line-height:1;">✕</button>';
    Object.assign(bar.style, {
        position: 'fixed',
        top: '56px', left: '0', right: '0',
        background: 'linear-gradient(90deg,#2563eb,#1d4ed8)',
        color: '#fff',
        display: 'flex', alignItems: 'center', gap: '8px',
        padding: '10px 16px', zIndex: '12000',
        fontSize: '0.88rem', fontWeight: '600',
        boxShadow: '0 6px 18px rgba(37,99,235,0.35)',
        cursor: 'pointer',
        transform: 'translateY(-120%)', transition: 'transform .3s ease'
    });
    bar.onclick = function() {
        if (window.applyPendingUpdate) window.applyPendingUpdate();
    };
    bar.querySelector('[data-close]').addEventListener('click', function(e) {
        e.stopPropagation();
        hideUpdateBanner();
    });
    document.body.appendChild(bar);
    requestAnimationFrame(function() { bar.style.transform = 'translateY(0)'; });
    // 12s 后自动收起（设置面板「立即更新」按钮与红点仍保留入口），不强制打断用户
    setTimeout(function() {
        if (document.getElementById('_update_banner') === bar) hideUpdateBanner(true);
    }, 12000);
}

function hideUpdateBanner(skipAnimate) {
    var bar = document.getElementById('_update_banner');
    if (!bar) return;
    if (skipAnimate) { bar.remove(); return; }
    bar.style.transform = 'translateY(-120%)';
    setTimeout(function() { if (bar.parentNode) bar.parentNode.removeChild(bar); }, 320);
}
window.showUpdateBanner = showUpdateBanner;
window.hideUpdateBanner = hideUpdateBanner;

// 核心检测函数
async function performUpdateCheck(url, showStatus) {
    if (showStatus === undefined) showStatus = false;
    const statusEl = document.getElementById('update-status');
    try {
        // 必须带超时：「连上 WiFi 但没有外网」时 fetch 不会立即失败，
        // 而是长时间挂起，按钮会一直停在「⏳ 正在检查…」，用户以为卡死。
        const _uctrl = (typeof AbortController !== 'undefined') ? new AbortController() : null;
        const _utimer = _uctrl ? setTimeout(function() { try { _uctrl.abort(); } catch (e) {} }, 8000) : null;
        let resp;
        try {
            resp = await fetch(url, {
                method: 'GET',
                headers: { 'Accept': 'application/json' },
                cache: 'no-cache',
                signal: _uctrl ? _uctrl.signal : undefined
            });
        } finally {
            if (_utimer) clearTimeout(_utimer);
        }
        // 404 = version.json 不存在（部署配置异常）
        if (resp.status === 404) {
            if (showStatus) {
                statusEl.textContent = 'ℹ️ 未找到版本信息文件，请确认部署包含 version.json';
                statusEl.style.color = '#64748b';
            }
            return;
        }
        if (!resp.ok) throw new Error('HTTP ' + resp.status);
        const data = await resp.json();
        const remoteVersion = data.tag_name || data.version || data.latestVersion || '';
        const releaseNotes = data.body || data.releaseNotes || data.notes || '';
        const downloadUrl = data.html_url || data.downloadUrl || 'https://github.com/haibing321/36075739-2/releases';

        if (!remoteVersion) {
            if (showStatus) {
                statusEl.textContent = '❌ 远程版本信息缺失，检查接口格式';
                statusEl.style.color = '#dc2626';
            }
            return;
        }

        const isNew = compareVersions(remoteVersion, APP_VERSION) > 0;
        if (isNew) {
            document.getElementById('tab-settings')?.classList.add('has-update-badge');
            document.getElementById('check-update-btn')?.classList.add('has-update-badge');
            localStorage.setItem('_has_update', 'true');
            // v3.26：「立即更新」按钮原位覆盖「检查更新」按钮（循环图标样式）
            if (window.switchUpdateBtn) window.switchUpdateBtn('update');
            if (showStatus) {
                statusEl.innerHTML = '🆕 发现新版本 <strong>' + remoteVersion + '</strong>（当前 ' + APP_VERSION + '）<br>' + (releaseNotes ? '📝 ' + releaseNotes.slice(0, 120) + (releaseNotes.length > 120 ? '…' : '') : '') + '<br>新版已就绪，点击上方「🔄 立即更新」应用新版本';
                statusEl.style.color = '#dc2626';
            }
            // 自动预备 SW 更新（离线优先策略下，更新仅在此触发）
            if (window.triggerApplyUpdate) window.triggerApplyUpdate();
            // 页面顶部弹出更新提示条（手动/静默检查均生效），点击即应用
            if (window.showUpdateBanner) window.showUpdateBanner(remoteVersion);
        } else {
            document.getElementById('tab-settings')?.classList.remove('has-update-badge');
            document.getElementById('check-update-btn')?.classList.remove('has-update-badge');
            localStorage.removeItem('_has_update');
            // v3.26：无新版本/更新完成 → 恢复「检查更新」按钮
            if (window.switchUpdateBtn) window.switchUpdateBtn('normal');
            if (showStatus) {
                statusEl.textContent = '✅ 已是最新版 (' + APP_VERSION + ')';
                statusEl.style.color = '#16a34a';
            }
        }
    } catch (err) {
        if (showStatus) {
            // 版本服务器不可达（如离线）时不报红错：SW 本地更新通道仍可用（下方 triggerApplyUpdate 已触发），避免误报「监测失败」
            statusEl.textContent = 'ℹ️ 无法连接版本服务器（可能离线），已尝试检查本地更新';
            statusEl.style.color = '#64748b';
        }
        // v3.26：检查失败恢复「检查更新」按钮
        if (window.switchUpdateBtn) window.switchUpdateBtn('normal');
        console.warn('[Update]', err);
    }
}

// 版本号比较
function compareVersions(v1, v2) {
    function clean(v) { return v.replace(/^v/, '').split('.').map(Number); }
    var a = clean(v1), b = clean(v2);
    var len = Math.max(a.length, b.length);
    for (var i = 0; i < len; i++) {
        var n1 = a[i] || 0, n2 = b[i] || 0;
        if (n1 > n2) return 1;
        if (n1 < n2) return -1;
    }
    return 0;
}
