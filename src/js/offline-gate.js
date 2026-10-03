/**
 * 【2026-10-03 用户口径】全站「离线加载」硬门禁
 * ============================================================================
 * 用户要求：**只有两种情况允许远程加载** ——
 *   ① 检查/执行系统更新（`update`）
 *   ② 清除缓存（`clear`，清完要强制重取静态资源）
 * 其它一律禁止远程加载，严格执行离线加载（折叠开合、切 Tab、切子视图、重建、启动……都不许联网）。
 *
 * 唯一的**功能性例外**：AI 推理接口（对话/智能体/风险研判/写作/对规的模型调用）与智能体的天气工具。
 *   这不是"加载资源"，而是本产品的核心功能本身，禁掉等于应用失效 —— 故单列为 `ai` 意图并**显式声明**。
 *   若确实要做到"连 AI 也不许联网"，把下面 `ALLOW.ai = []` 清空即可（应用会变成纯本地工具）。
 *
 * 拦截范围：fetch / XMLHttpRequest（覆盖 AI 接口、数据接口、远程 JSON、后台预缓存请求等）。
 * 记录：被拦次数、最近被拦 URL、放行次数（按意图）—— 供「设置 → 关于 → 离线状态」直读自证，不再靠感觉。
 */
(function () {
    'use strict';

    var INTENT = null;                      // 当前放行的意图：null | 'update' | 'clear'
    var stats = { blocked: 0, allowed: 0, local: 0, lastBlocked: '', lastAllowed: '', byIntent: { update: 0, clear: 0, ai: 0 } };

    var AI_HOSTS = /^https?:\/\/(api\.deepseek\.com|api\.openai\.com|dashscope\.aliyuncs\.com|open\.bigmodel\.cn|api\.moonshot\.cn|api\.baichuan-ai\.com|api\.stepfun\.com|api\.open-meteo\.com|geocoding-api\.open-meteo\.com)(\/|$)/i;
    var UPDATE_HOSTS = /^https?:\/\/(github\.com|api\.github\.com|objects\.githubusercontent\.com|raw\.githubusercontent\.com|codeload\.github\.com|haibing321\.github\.io)(\/|$)/i;

    function isSameOrigin(u) {
        try { return new URL(u, location.href).origin === location.origin; } catch (e) { return true; }
    }
    function isAi(u) {
        if (AI_HOSTS.test(u)) return true;
        // 用户可在「设置 → API 配置」里填任意地址：只认出**推理端点**这一形态（POST /chat/completions 等），
        // 不因为"域名没在白名单里"就把 AI 功能一起禁掉。
        return /\/(chat\/completions|v1\/messages|completions)(\?|$)/i.test(u);
    }

    /** 判定某个请求是否放行；放行时把命中意图记进 stats */
    function decide(url, method) {
        var u = String(url || '');
        // ① 更新流程内的同源/更新域请求
        if (INTENT === 'update' && (isSameOrigin(u) || UPDATE_HOSTS.test(u))) return tag('update');
        // ② **同源请求 = 本机加载（离线加载），一律放行**：
        //    用户口径禁的是"远程加载"；应用自身的静态资源/本机接口走 SW 缓存与本地服务，属离线范畴。
        //    若在这里也拦，会在"清缓存后重建""本地文件读取"等场景误伤（chat-fixes 实测被拦过一次）。
        //    单独用 local 计数，**不计入"放行联网次数"**，避免自证面板的数字被本机请求灌水。
        if (isSameOrigin(u)) { stats.local++; return 'local'; }
        // ③ AI 推理：功能必需（见文件头"功能性例外"）
        if (isAi(u)) return tag('ai');
        return null;
    }
    function tag(name) { stats.byIntent[name] = (stats.byIntent[name] || 0) + 1; stats.allowed++; stats.lastAllowed = name; return name; }

    function block(url, method) {
        stats.blocked++;
        stats.lastBlocked = String(url || '').slice(0, 180);
        try {
            console.warn('[offline-gate] 已禁止远程加载（' + (method || 'GET') + '）：' + stats.lastBlocked
                + '\n  · 只有"检查/执行更新"和"清除缓存"允许联网；AI 推理接口除外。');
        } catch (e) {}
        return stats.lastBlocked;
    }

    // ---------------- fetch ----------------
    var _fetch = window.fetch;
    if (typeof _fetch === 'function') {
        window.fetch = function (input, init) {
            var url = (input && input.url) ? input.url : String(input || '');
            var method = (init && init.method) || (input && input.method) || 'GET';
            if (decide(url, method)) return _fetch.apply(this, arguments);
            block(url, method);
            return Promise.reject(new Error('offline-gate: 已禁止远程加载 ' + url));
        };
    }

    // ---------------- XMLHttpRequest ----------------
    if (window.XMLHttpRequest && window.XMLHttpRequest.prototype) {
        var _open = window.XMLHttpRequest.prototype.open;
        var _send = window.XMLHttpRequest.prototype.send;
        window.XMLHttpRequest.prototype.open = function (method, url) {
            this.__ogAllowed = !!decide(url, method);
            if (!this.__ogAllowed) block(url, method);
            if (!this.__ogAllowed) { this.__ogBlocked = true; return; }   // 不建立连接
            return _open.apply(this, arguments);
        };
        window.XMLHttpRequest.prototype.send = function () {
            if (this.__ogBlocked) throw new Error('offline-gate: 已禁止远程加载');
            return _send.apply(this, arguments);
        };
    }

    window.OfflineGate = {
        /** 当前是否有放行意图（update / clear）；AI 推理不受此影响 */
        isOpen: function () { return INTENT !== null; },
        current: function () { return INTENT; },
        setIntent: function (name) { INTENT = name || null; return INTENT; },
        clearIntent: function () { INTENT = null; },
        /** 包住"允许联网"的那一小段：run('update', fn) */
        run: function (name, fn) {
            var prev = INTENT; INTENT = name || null;
            var done = function () { INTENT = prev; };
            try {
                var r = fn();
                if (r && typeof r.then === 'function') return r.then(function (v) { done(); return v; }, function (e) { done(); throw e; });
                done(); return r;
            } catch (e) { done(); throw e; }
        },
        /** 供「离线状态」面板直读：不放 URL 细节，只报计数与最近一条，便于自证 */
        status: function () {
            return {
                blocked: stats.blocked, allowed: stats.allowed, local: stats.local, lastBlocked: stats.lastBlocked,
                byIntent: { update: stats.byIntent.update, clear: stats.byIntent.clear, ai: stats.byIntent.ai }
            };
        },
        /** 仅测试用：清零计数 */
        _reset: function () { stats.blocked = 0; stats.allowed = 0; stats.local = 0; stats.lastBlocked = ''; stats.lastAllowed = ''; stats.byIntent = { update: 0, clear: 0, ai: 0 }; }
    };
})();
