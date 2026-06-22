/**
 * 安监智能辅助系统 - 性能监控模块
 * 轻量级 Web Vitals + 业务指标采集（无外部依赖）
 * 导出: window.perfMonitor
 */
(function() {
    'use strict';

    // ========== 配置 ==========
    var STORAGE_KEY = 'aj_perf_data';
    var MAX_SAMPLES = 200; // 保留最近 N 条采样

    // ========== 内部状态 ==========
    var _metrics = {};     // { lcp: [...], cls: [...], inp: [...], fcp: [...], ... }
    var _timers = {};      // 业务计时器 { name: startTime }
    var _initialized = false;
    var _supportedVitals = [];

    // ========== 工具函数 ==========

    function now() {
        try { return performance.now(); } catch(e) { return Date.now(); }
    }

    function ts() {
        try { return new Date().toISOString(); } catch(e) { return String(Date.now()); }
    }

    /**
     * 安全记录一条指标
     */
    function record(name, value, extra) {
        if (!_metrics[name]) _metrics[name] = [];
        _metrics[name].push({
            value: Math.round(value * 100) / 100,
            time: ts(),
            url: typeof location !== 'undefined' ? location.href : '',
            extra: extra || null
        });
        // 限制条数
        if (_metrics[name].length > MAX_SAMPLES) {
            _metrics[name] = _metrics[name].slice(-MAX_SAMPLES);
        }
    }

    /**
     * 持久化到 localStorage（节流：最多30秒一次）
     */
    var _saveTimer = null;
    function persist() {
        if (_saveTimer) return;
        _saveTimer = setTimeout(function() {
            _saveTimer = null;
            try {
                localStorage.setItem(STORAGE_KEY, JSON.stringify({
                    metrics: _metrics,
                    supported: _supportedVitals,
                    lastUpdate: ts()
                }));
            } catch(e) {}
        }, 30000);
    }

    function load() {
        try {
            var raw = localStorage.getItem(STORAGE_KEY);
            if (raw) {
                var d = JSON.parse(raw);
                if (d.metrics) _metrics = d.metrics;
                if (d.supported) _supportedVitals = d.supported;
            }
        } catch(e) {}
    }

    // ========== Web Vitals 采集 ==========

    /**
     * LCP (Largest Contentful Paint) - 最大内容绘制
     */
    function observeLCP() {
        if (!('PerformanceObserver' in window)) return false;

        try {
            var obs = new PerformanceObserver(function(list) {
                var entries = list.getEntries();
                for (var i = 0; i < entries.length; i++) {
                    record('lcp', entries[i].startTime, {
                        element: entries[i].element ? entries[i].element.tagName : '',
                        id: entries[i].element ? entries[i].element.id : ''
                    });
                }
            });
            obs.observe({ type: 'largest-contentful-paint', buffered: true });
            _supportedVitals.push('lcp');
            return true;
        } catch(e) { return false; }
    }

    /**
     * CLS (Cumulative Layout Shift) - 累积布局偏移
     */
    function observeCLS() {
        if (!('PerformanceObserver' in window)) return false;

        try {
            var clsValue = 0;
            var obs = new PerformanceObserver(function(list) {
                var entries = list.getEntries();
                for (var i = 0; i < entries.length; i++) {
                    if (!entries[i].hadRecentInput) {
                        clsValue += entries[i].value;
                    }
                }
                record('cls', clsValue, { sessionShifts: entries.length });
            });
            obs.observe({ type: 'layout-shift', buffered: true });
            _supportedVitals.push('cls');
            return true;
        } catch(e) { return false; }
    }

    /**
     * INP (Interaction to Next Paint) - 交互到下次绘制
     */
    function observeINP() {
        if (!('PerformanceObserver' in window)) return false;
        // INP 需要 InteractionCount API 或 EventTiming entries
        // 检查是否支持 eventTiming
        try {
            // 尝试注册，不支持的浏览器会抛错
            PerformanceEntry.supportedEntryTypes.indexOf('eventTiming');
        } catch(e) {
            return false; // 不支持 INP
        }

        try {
            var inpEntries = [];
            var obs = new PerformanceObserver(function(list) {
                var entries = list.getEntries();
                for (var i = 0; i < entries.length; i++) {
                    var e = entries[i];
                    // 只关注 pointer/keyboard 交互
                    if (e.name === 'click' || e.name === 'keydown' ||
                        e.name === 'pointerdown' || e.name === 'pointerup') {
                        inpEntries.push({
                            duration: e.duration,
                            processingStart: e.processingStart,
                            name: e.name
                        });
                        // 取所有交互的 p75 作为 INP 近似值
                        inpEntries.sort(function(a, b) { return b.duration - a.duration; });
                        var idx = Math.max(0, Math.floor(inpEntries.length * 0.75) - 1);
                        record('inp', inpEntries[idx].duration, {
                            interaction: e.name,
                            totalInteractions: inpEntries.length
                        });
                    }
                }
            });
            obs.observe({ type: 'event', buffered: true });
            _supportedVitals.push('inp');
            return true;
        } catch(e) { return false; }
    }

    /**
     * FCP (First Contentful Paint) - 首次内容绘制
     */
    function observeFCP() {
        if (!('PerformanceObserver' in window)) return false;

        try {
            var obs = new PerformanceObserver(function(list) {
                var entries = list.getEntries();
                for (var i = 0; i < entries.length; i++) {
                    record('fcp', entries[i].startTime);
                }
            });
            obs.observe({ type: 'paint', buffered: true });
            _supportedVitals.push('fcp');
            return true;
        } catch(e) { return false; }
    }

    // ========== 业务指标计时器 ==========

    /**
     * 开始计时
     * @param {string} name 计时器名称（如 'tab_switch', 'search_issue', 'api_deepseek'）
     */
    function startTimer(name) {
        _timers[name] = now();
    }

    /**
     * 结束计时并记录
     * @param {string} name 计时器名称
     * @param {object} extra 附加信息
     * @returns {number} 耗时(ms)，失败返回 -1
     */
    function endTimer(name, extra) {
        if (!_timers[name]) return -1;
        var elapsed = now() - _timers[name];
        delete _timers[name];
        record(name, elapsed, extra);
        persist();
        return Math.round(elapsed);
    }

    // ========== 公共 API ==========

    /**
     * 初始化性能监控
     */
    function init() {
        if (_initialized) return this;
        _initialized = true;
        load();
        _supportedVitals = []; // 重置后重新检测，避免 localStorage 恢复后重复堆积

        // 注册 Web Vitals 观察者
        observeLCP();
        observeCLS();
        observeINP();
        observeFCP();

        // 记录 DOM 就绪时间
        if (document.readyState !== 'loading') {
            record('dom_ready', now());
        } else {
            document.addEventListener('DOMContentLoaded', function() {
                record('dom_ready', now());
            });
        }

        console.log('[PerfMonitor] 性能监控已启动, 支持: [' + _supportedVitals.join(', ') + ']');

        return this;
    }

    /**
     * 获取某指标的所有采样值
     */
    function getMetric(name) {
        return (_metrics[name] || []).slice();
    }

    /**
     * 获取最新的一条指标值
     */
    function getLatest(name) {
        var arr = _metrics[name];
        if (!arr || arr.length === 0) return null;
        return arr[arr.length - 1];
    }

    /**
     * 获取汇总报告
     */
    function getReport() {
        var report = {
            supportedVitals: _supportedVitals.slice(),
            webVitals: {},
            businessMetrics: {},
            summary: {}
        };

        // Web Vitals 汇总
        var vitals = ['lcp', 'cls', 'inp', 'fcp'];
        for (var i = 0; i < vitals.length; i++) {
            var v = vitals[i];
            var samples = _metrics[v] || [];
            if (samples.length > 0) {
                var latest = samples[samples.length - 1];
                report.webVitals[v] = {
                    latest: latest.value,
                    samples: samples.length,
                    unit: getUnit(v),
                    status: getStatus(v, latest.value)
                };
            }
        }

        // 业务指标汇总
        var bizKeys = Object.keys(_metrics).filter(function(k) {
            return vitals.indexOf(k) === -1 && k !== 'dom_ready';
        });
        for (var j = 0; j < bizKeys.length; j++) {
            var bk = bizKeys[j];
            var bsamples = _metrics[bk] || [];
            if (bsamples.length > 0) {
                var sum = 0;
                for (var s = 0; s < bsamples.length; s++) sum += bsamples[s].value;
                report.businessMetrics[bk] = {
                    avg: Math.round(sum / bsamples.length * 100) / 100,
                    latest: bsamples[bsamples.length - 1].value,
                    samples: bsamples.length,
                    unit: 'ms'
                };
            }
        }

        report.summary.totalSamples = Object.keys(_metrics).reduce(function(acc, k) {
            return acc + (_metrics[k] ? _metrics[k].length : 0);
        }, 0);

        return report;
    }

    function getUnit(metric) {
        switch (metric) {
            case 'lcp': case 'fcp': return 'ms';
            case 'cls': return 'score';
            case 'inp': return 'ms';
            default: return 'ms';
        }
    }

    function getStatus(metric, value) {
        // 基于 Google 推荐阈值
        switch (metric) {
            case 'lcp':
                if (value <= 2500) return 'good';
                if (value <= 4000) return 'needs-improvement';
                return 'poor';
            case 'cls':
                if (value <= 0.1) return 'good';
                if (value <= 0.25) return 'needs-improvement';
                return 'poor';
            case 'inp':
            case 'fcp':
                if (value <= 200) return 'good';
                if (value <= 500) return 'needs-improvement';
                return 'poor';
            default:
                return 'unknown';
        }
    }

    /**
     * 清空所有数据
     */
    function clear() {
        _metrics = {};
        _timers = {};
        try { localStorage.removeItem(STORAGE_KEY); } catch(e) {}
    }

    /**
     * 导出格式化文本报告
     */
    function exportText() {
        var r = getReport();
        var lines = [
            '=== 性能监控报告 ===',
            '生成时间: ' + ts(),
            '支持指标: ' + (r.supportedVitals.join(', ') || '(无)'),
            ''
        ];

        lines.push('-- Web Vitals --');
        var vk = Object.keys(r.webVitals);
        for (var i = 0; i < vk.length; i++) {
            var v = r.webVitals[vk[i]];
            lines.push('  ' + vk[i].toUpperCase() + ': ' + v.latest + ' ' + v.unit +
                ' (' + v.status + '), ' + v.samples + ' 条采样');
        }

        lines.push('');
        lines.push('-- 业务指标 --');
        var bk = Object.keys(r.businessMetrics);
        for (var j = 0; j < bk.length; j++) {
            var b = r.businessMetrics[bk[j]];
            lines.push('  ' + bk[j] + ': avg=' + b.avg + 'ms, latest=' + b.latest + 'ms (' + b.samples + ' 次)');
        }

        lines.push('');
        lines.push('总计: ' + r.summary.totalSamples + ' 条采样数据');

        return lines.join('\n');
    }

    // ========== 暴露公共接口 ==========
    window.perfMonitor = {
        init: init,

        // 计时器 API（供业务代码调用）
        start: startTimer,
        end: endTimer,

        // 数据查询
        getMetric: getMetric,
        getLatest: getLatest,
        getReport: getReport,

        // 管理
        clear: clear,
        exportText: exportText,

        // 元信息
        getSupportedVitals: function() { return _supportedVitals.slice(); }
    };

    // 自动初始化
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', function() { init(); });
    } else {
        init();
    }
})();
