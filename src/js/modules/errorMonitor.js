/**
 * 安监智能辅助系统 - 全局错误监控模块
 * 捕获 JS 运行错误 + 未处理 Promise 拒绝 + CDN 加载失败
 * 日志存储到 localStorage（最近 50 条）
 * 导出: window.errorMonitor
 */
(function() {
    'use strict';

    // ========== 配置 ==========
    var STORAGE_KEY = 'aj_error_logs';
    var MAX_LOGS = 50;
    var MAX_STACK_DEPTH = 20; // 堆栈截断行数

    // ========== 内部状态 ==========
    var _logs = [];
    var _initialized = false;
    var _listeners = []; // 外部订阅者

    // ========== 工具函数 ==========

    /**
     * 获取当前时间戳字符串
     */
    function nowStr() {
        try {
            return new Date().toISOString();
        } catch(e) {
            return String(Date.now());
        }
    }

    /**
     * 安全截断字符串
     */
    function truncate(s, maxLen) {
        if (!s) return '';
        if (typeof s !== 'string') s = String(s);
        return s.length > maxLen ? s.substring(0, maxLen) + '...' : s;
    }

    /**
     * 安全获取堆栈信息并截断
     */
    function safeStack(error) {
        if (!error || typeof error.stack !== 'string') return '';
        var lines = error.stack.split('\n');
        return truncate(lines.slice(0, MAX_STACK_DEPTH).join('\n'), 2000);
    }

    /**
     * 从 URL 中提取简短的文件名+行号
     */
    function shortSource(url, line, col) {
        if (!url) return '(unknown)';
        try {
            var u = new URL(url);
            var path = u.pathname.split('/').pop();
            if (line) path += ':' + line;
            if (col) path += ':' + col;
            return path;
        } catch(e) {
            return url.length > 60 ? url.substring(0, 60) + '...' : url;
        }
    }

    /**
     * 生成唯一 ID
     */
    function uid() {
        return Date.now().toString(36) + Math.random().toString(36).substring(2, 8);
    }

    // ========== 核心逻辑 ==========

    /**
     * 创建一条结构化错误日志
     */
    function createEntry(type, opts) {
        return {
            id: uid(),
            time: nowStr(),
            timestamp: Date.now(),
            type: type,              // 'js_error' | 'promise' | 'cdn' | 'custom' | 'api'
            message: truncate(opts.message || '', 500),
            source: truncate(opts.source || '', 300),
            line: opts.line || 0,
            col: opts.col || 0,
            stack: truncate(opts.stack || '', 3000),
            detail: truncate(opts.detail || '', 1000), // 额外上下文
            userAgent: typeof navigator !== 'undefined' ? truncate(navigator.userAgent, 200) : '',
            url: typeof location !== 'undefined' ? truncate(location.href, 500) : ''
        };
    }

    /**
     * 新增日志条目（内存 + 持久化）
     */
    var _pushing = false;   // 重入保护：记录过程中再抛错会递归触发 window error
    function pushEntry(entry) {
        if (_pushing) return;
        _pushing = true;
        try {
            _logs.push(entry);

            // 限制内存中数量
            if (_logs.length > MAX_LOGS * 2) {
                _logs = _logs.slice(-MAX_LOGS);
            }

            persist();

            // 通知订阅者
            notifyListeners(entry);
        } catch (e) {
            // 记录逻辑自身出错绝不能再抛，否则会再次进入 window.onerror 形成死循环
        } finally {
            _pushing = false;
        }
    }

    /**
     * 持久化到 localStorage
     * 高频抛错时（如渲染循环内报错）每条都做一次全量 JSON 序列化会反向加剧卡顿，
     * 这里做 30 秒节流；离开页面前再强制落盘一次。
     */
    var _persistTimer = null;
    function persist(force) {
        if (!force) {
            if (_persistTimer) return;
            _persistTimer = setTimeout(function() {
                _persistTimer = null;
                persist(true);
            }, 30000);
            return;
        }
        if (_persistTimer) { clearTimeout(_persistTimer); _persistTimer = null; }
        try {
            var toSave = _logs.slice(-MAX_LOGS);
            localStorage.setItem(STORAGE_KEY, JSON.stringify(toSave));
        } catch(e) {
            // 存储满或禁用时静默失败
            console.warn('[ErrorMonitor] 持久化失败:', e.message);
        }
    }

    /**
     * 从 localStorage 加载历史日志
     */
    function load() {
        try {
            var raw = localStorage.getItem(STORAGE_KEY);
            if (raw) {
                var parsed = JSON.parse(raw);
                if (Array.isArray(parsed)) {
                    _logs = parsed.slice(-MAX_LOGS);
                }
            }
        } catch(e) {
            console.warn('[ErrorMonitor] 加载历史失败:', e.message);
        }
    }

    /**
     * 通知外部监听器
     */
    function notifyListeners(entry) {
        for (var i = 0; i < _listeners.length; i++) {
            try { _listeners[i](entry); } catch(e2) {}
        }
    }

    // ========== 错误捕获 ==========

    /**
     * 捕获 JS 运行时错误 + 资源加载失败
     */
    function onJsError(msg, source, lineNo, colNo, error, target) {
        // 只有「真实的资源元素」才算资源加载失败。
        // 运行时 JS 错误的 error 事件是在 window 上派发的，在 window 的 capture 监听里
        // e.target === window（truthy）。若直接 `if (target)`，所有 JS 异常都会被误判成
        // CDN 资源错误，message / 行号 / 堆栈全部丢弃 —— js_error 类型事实上永远产生不了。
        var resTarget = (target && target !== window && target !== document && target.tagName) ? target : null;

        // 资源加载失败的通用事件（脚本/CSS/图片等）
        if (resTarget || (lineNo === 0 && colNo === 0 && !error &&
            msg && (msg.indexOf('Script error') === 0 || msg === ''))) {
            if (resTarget) {
                onCdnError(resTarget);
            } else if (source) {
                // 跨域脚本无 detail，构造一个虚拟 target
                onCdnError({ src: source, tagName: 'SCRIPT' });
            }
            return;
        }
        pushEntry(createEntry('js_error', {
            message: msg,
            source: source,
            line: lineNo,
            col: colNo,
            stack: safeStack(error)
        }));
    }

    /**
     * 捕获未处理的 Promise 拒绝
     */
    function onUnhandledRejection(event) {
        var reason = event.reason;
        var msg = '';
        var stack = '';

        if (reason instanceof Error) {
            msg = reason.message;
            stack = safeStack(reason);
        } else if (reason !== undefined && reason !== null) {
            msg = truncate(String(reason), 500);
        } else {
            msg = 'undefined rejection';
        }

        pushEntry(createEntry('promise', {
            message: msg,
            stack: stack,
            detail: 'Unhandled Promise Rejection'
        }));
    }

    /**
     * 捕获 CDN 资源加载失败
     */
    function onCdnError(target) {
        if (!target) return;

        var src = target.src || target.href || '';
        var tag = (target.tagName || '').toLowerCase();
        var libName = extractLibName(src);

        pushEntry(createEntry('cdn', {
            message: (tag.toUpperCase() + ' 加载失败: ') + libName,
            source: src,
            detail: '资源类型: ' + tag + ' | 可能原因: 网络不可达 / CDN 被墙 / DNS 解析失败 / CSP 拦截'
        }));

        // 同时显示用户可见的 Toast 提示（带 URL 便于诊断）
        showCdnErrorToast(libName, src);
    }

    /**
     * 从 URL 中提取资源名称用于友好展示
     */
    function extractLibName(url) {
        if (!url) return '未知资源';
        // CDN JS 库: /xxx.min.js 或 /xxx.js
        var match = url.match(/\/([^/]+?)\.min\.js$/);
        if (match) return match[1];
        match = url.match(/\/([^/]+?)\.js(\?|$)/);
        if (match) return match[1];
        // CSS 文件
        match = url.match(/\/([^/]+?)\.css(\?|$)/);
        if (match) return match[1] + '(CSS)';
        // 图片
        match = url.match(/\/([^/]+?)\.(png|svg|ico|webp|jpg|gif)(\?|$)/i);
        if (match) return match[1] + '.' + match[2] + '(图)';
        // 字体
        match = url.match(/\/([^/]+?)\.(woff2?|ttf|eot)(\?|$)/i);
        if (match) return match[1] + '.' + match[2] + '(字体)';
        // manifest / 其他文件
        var name = url.split('/').pop().split('?')[0];
        return name || '未知资源';
    }

    /**
     * 获取用于显示的短 URL（去掉协议和域名）
     */
    function shortUrlForDisplay(fullUrl) {
        try {
            var u = new URL(fullUrl);
            return u.pathname + (u.search ? u.search : '');
        } catch(e) {
            return fullUrl.length > 60 ? fullUrl.substring(0, 60) + '...' : fullUrl;
        }
    }

    /**
     * CDN 加载失败的用户提示 Toast
     */
    function showCdnErrorToast(libName, url) {
        // 忽略第三方 iframe 内的资源错误（如 doubao.com 的 CSP/策略违规）
        if (url) {
            var knownThirdParties = ['doubao.com', 'bytedance.com', 'bytedance.net', 'douyin.com', 'toutiao.com'];
            for (var i = 0; i < knownThirdParties.length; i++) {
                if (url.indexOf(knownThirdParties[i]) !== -1) return;
            }
        }
        // 忽略空 URL 或提取失败的未知资源
        if (!url || libName === '未知资源' || libName === '') return;

        // Toast 已关闭 — 用户反馈频繁误报，仅保留控制台日志
        // showCdnErrorToast 调用已被注释，如需恢复请取消下行注释:
        // _showToast(libName, url);
    }

    function _showToast(libName, url) {
        var toastKey = '_cdn_toast_' + (libName || 'unknown');
        if (window[toastKey]) return;
        window[toastKey] = true;
        setTimeout(function() { window[toastKey] = false; }, 30000);

        try {
            var toast = document.createElement('div');
            toast.id = '_cdn_err_toast_' + Date.now();
            Object.assign(toast.style, {
                position: 'fixed', top: '12px', left: '50%', transform: 'translateX(-50%)',
                background: 'rgba(220, 38, 38, 0.95)', color: '#fff',
                padding: '10px 18px', zIndex: '100001', borderRadius: '8px',
                fontSize: '0.85rem', fontWeight: '600',
                boxShadow: '0 4px 16px rgba(220,38,38,.4)',
                display: 'flex', alignItems: 'center', gap: '6px',
                fontFamily: '-apple-system, "Microsoft YaHei", sans-serif',
                maxWidth: '520px', flexWrap: 'wrap'
            });
            var urlHint = url ? '<span style="opacity:0.7;font-weight:400;font-size:0.78rem;margin-left:4px;">(' + escapeHtml(shortUrlForDisplay(url)) + ')</span>' : '';
            toast.innerHTML = '<span>⚠️ ' + escapeHtml(libName) + ' 未加载，请检查网络后刷新</span>' + urlHint;
            document.body.appendChild(toast);

            setTimeout(function() {
                toast.style.opacity = '0';
                toast.style.transition = 'opacity .5s ease';
                setTimeout(function() { if (toast.parentNode) toast.parentNode.removeChild(toast); }, 520);
            }, 8000);
        } catch(e) {}
    }

    // XSS 防护：转义 HTML
    function escapeHtml(str) {
        var d = document.createElement('div');
        d.appendChild(document.createTextNode(str));
        return d.innerHTML;
    }

    // ========== 公共 API ==========

    /**
     * 手动记录自定义错误
     */
    function logCustomError(message, detail, extra) {
        pushEntry(createEntry('custom', {
            message: message,
            detail: detail || '',
            source: (extra && extra.source) || ''
        }));
    }

    /**
     * 记录 API 错误
     */
    function logApiError(apiUrl, status, message) {
        pushEntry(createEntry('api', {
            message: 'API [' + status + ']: ' + (message || ''),
            source: apiUrl,
            detail: 'HTTP 状态码: ' + status
        }));
    }

    /**
     * 获取所有日志
     */
    function getLogs(filterType) {
        var result = _logs.slice();
        if (filterType) {
            result = result.filter(function(e) { return e.type === filterType; });
        }
        return result;
    }

    /**
     * 获取统计摘要
     */
    function getSummary() {
        var summary = { total: _logs.length, byType: {}, latest: null };
        for (var i = 0; i < _logs.length; i++) {
            var t = _logs[i].type;
            summary.byType[t] = (summary.byType[t] || 0) + 1;
        }
        if (_logs.length > 0) {
            summary.latest = _logs[_logs.length - 1];
        }
        return summary;
    }

    /**
     * 清空日志
     */
    function clearLogs() {
        _logs = [];
        try { localStorage.removeItem(STORAGE_KEY); } catch(e) {}
    }

    /**
     * 导出日志为文本（可下载）
     */
    function exportText() {
        var header = [
            '=== 安监智能辅助系统 - 错误日志导出 ===',
            '导出时间: ' + nowStr(),
            '总计: ' + _logs.length + ' 条',
            '========================================\n'
        ].join('\n');

        var lines = [];
        for (var i = 0; i < _logs.length; i++) {
            var e = _logs[i];
            lines.push([
                '[' + e.time + ']',
                '[' + e.type.toUpperCase() + ']',
                e.message,
                '| 来源: ' + e.source,
                (e.line ? '| 行号: ' + e.line : ''),
                (e.detail ? '| 详情: ' + e.detail : ''),
                (e.stack ? '\n堆栈:\n' + e.stack : '')
            ].filter(Boolean).join(' '));
        }

        return header + lines.join('\n\n') + '\n';
    }

    /**
     * 导出日志为 JSON
     */
    function exportJSON() {
        return JSON.stringify(_logs, null, 2);
    }

    /**
     * 监听新错误事件
     */
    function subscribe(callback) {
        if (typeof callback === 'function') {
            _listeners.push(callback);
        }
        return this; // 支持链式调用
    }

    /**
     * 初始化（自动调用一次即可）
     */
    function init() {
        if (_initialized) return this;
        _initialized = true;

        // 加载历史
        load();

        // 注册全局监听
        window.addEventListener('error', function(e) {
            onJsError(e.message, e.filename, e.lineno, e.colno, e.error, e.target);
            // 不 preventDefault — 让其他处理器也能看到
        }, true); // capture phase（必须 capture 才能捕获资源加载错误）

        window.addEventListener('unhandledrejection', function(e) {
            onUnhandledRejection(e);
            // 不 preventDefault
        });

        // 持久化做了 30 秒节流，离开/隐藏页面时强制落盘，避免最近的错误丢失
        var flush = function() { try { persist(true); } catch(e) {} };
        window.addEventListener('pagehide', flush);
        window.addEventListener('beforeunload', flush);
        document.addEventListener('visibilitychange', function() {
            if (document.visibilityState === 'hidden') flush();
        });

        console.log('[ErrorMonitor] 全局错误监控已启动');

        return this;
    }

    // ========== 暴露公共接口 ==========
    window.errorMonitor = {
        init: init,
        log: logCustomError,
        logApi: logApiError,
        getLogs: getLogs,
        getSummary: getSummary,
        clear: clearLogs,
        exportText: exportText,
        exportJSON: exportJSON,
        subscribe: subscribe,

        // 内部方法（供特殊场景使用）
        _onCdnError: onCdnError
    };

    // 自动初始化（DOM 就绪后）
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', function() { init(); });
    } else {
        init();
    }
})();
