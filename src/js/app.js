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
    // ============================================================
    // 关键词召回 / 精确统计（唯一实现，2026-09-19 P0′）
    // ------------------------------------------------------------
    // 为什么替换原 Fuse 分支（实测数据，真实规模：检查信息 40166 条）：
    //   ① Fuse 走 CDN（cdnjs + SW 缓存）→ **召回结果随网络状态变**：同一查询在线(模糊)命中
    //      687/687、离线(子串)命中 0 条，同一功能两副面孔；
    //   ② `count_issues` 的 total 也走同一函数 → 带关键词统计时**数字含模糊命中**，在线/离线不一致，
    //      与提示词「必须真实总数」冲突；
    //   ③ 代价大：Fuse 在 4 万条×5 字段上建索引 ~1.3s、常驻 +23MB，数据引用一变就重建；
    //      离线子串全扫 44.6ms。而本实现是纯内存 n-gram 计数，毫秒级、零依赖、零常驻。
    // 口径（重要）：**召回宽松、统计严格，两者分离**
    //   · `_kwRecall`   —— 召回：查询的 2~4 字 n-gram 命中计数打分（中文无需分词），
    //                       精确子串命中额外加权，保证"字面命中"排最前（与页内检索"精确优先"一致）；
    //   · `_exactFilter`—— 统计：**精确子串**（多关键词 OR，跨字段），用于 total / count_issues，
    //                       保证数字可信、在线/离线一致。
    function _kwSplit(keyword) {
        return String(keyword == null ? '' : keyword).split(/[\s,，、;；]+/).filter(Boolean);
    }
    // 目标字段拼成一段小写文本（去 HTML 标签），供两种匹配共用
    function _kwHay(d, keys) {
        var hay = '';
        for (var i = 0; i < keys.length; i++) {
            var v = d[keys[i]];
            if (v == null || v === '') continue;
            hay += ' ' + ('' + v);
        }
        return hay.replace(/<[^>]+>/g, '').toLowerCase();
    }
    function _kwTokens(keyword) {
        var set = {};
        _kwSplit(keyword).forEach(function (kw0) {
            var kw = kw0.toLowerCase();
            if (/[\u4e00-\u9fa5]/.test(kw)) {
                // 中文：2~4 字滑窗（"信号机显示不良" → 信号/号机/机显/显示/…/信号机显/…）
                for (var i = 0; i < kw.length - 1; i++) {
                    if (!/[\u4e00-\u9fa5]/.test(kw[i])) continue;
                    for (var len = 2; len <= Math.min(4, kw.length - i); len++) set[kw.slice(i, i + len)] = 1;
                }
            } else if (kw) {
                set[kw] = 1;        // 英文/数字：整词
            }
        });
        return Object.keys(set);
    }
    function _exactFilter(data, keyword, keys) {
        var kws = _kwSplit(keyword).map(function (k) { return k.toLowerCase(); });
        if (!kws.length) return data;
        return data.filter(function (d) {
            var hay = _kwHay(d, keys);
            if (!hay) return false;
            for (var i = 0; i < kws.length; i++) { if (hay.indexOf(kws[i]) !== -1) return true; }
            return false;
        });
    }
    function _kwRecall(data, keyword, keys, limit) {
        limit = limit || 10;
        if (!keyword) return data.slice(0, limit);
        var toks = _kwTokens(keyword);
        if (!toks.length) return data.slice(0, limit);
        var kws = _kwSplit(keyword).map(function (k) { return k.toLowerCase(); });
        // 保守模式（可回退）：localStorage.agentStrictKw='1' → 召回也只认精确子串
        var strict = false;
        try { strict = localStorage.getItem('agentStrictKw') === '1'; } catch (e) {}
        var scored = [];
        for (var i = 0; i < data.length; i++) {
            var hay = _kwHay(data[i], keys);
            if (!hay) continue;
            var exact = false;
            for (var e = 0; e < kws.length; e++) { if (hay.indexOf(kws[e]) !== -1) { exact = true; break; } }
            if (strict) { if (exact) scored.push({ i: i, s: 1000 }); continue; }
            var s = 0;
            for (var t = 0; t < toks.length; t++) {
                // 长 n-gram 是更强的证据（命中"作业人员"远比命中"作业"有意义）→ 按长度加权
                if (hay.indexOf(toks[t]) !== -1) s += Math.max(1, toks[t].length - 1);
            }
            if (!s && !exact) continue;
            scored.push({ i: i, s: s + (exact ? 1000 : 0) });   // 字面命中恒排近似命中之前
        }
        scored.sort(function (a, b) { return b.s - a.s || a.i - b.i; });
        return scored.slice(0, limit).map(function (x) { return data[x.i]; });
    }
    /**
     * 【2026-09-21】日期入参归一化（工具参数校验层）：
     *   兼容 '2026-8-1' / '2026/08/01' / '2026.08.01' / '2026-08'（月粒度自动补 01 / 月末 31）。
     *   原实现是纯字符串字典序比较（`i.datetime >= dateFrom`），模型传 '2026-08'（月）时因为
     *   '-'（0x2D）大于空格（0x20）会把整月数据**全部排除**，静默给出错误数字；未补零的
     *   '2026-8-1' 同样全空。库内 datetime 还可能是 '2026/09/01 09:00:00' → 统一把 '/' 视作 '-'。
     */
    function _agentNormDate(v, isEnd) {
        var s = String(v == null ? '' : v).trim();
        if (!s) return '';
        var m = s.match(/^(\d{4})[-/.](\d{1,2})(?:[-/.](\d{1,2}))?/);
        if (!m) return s.replace(/\//g, '-');                       // 非标准样式：只做斜杠归一，保持旧行为
        var y = m[1], mo = String(+m[2]).padStart(2, '0'), d = m[3];
        if (!d) return y + '-' + mo + (isEnd ? '-31' : '-01');       // 月粒度：起点 01 / 终点 31
        return y + '-' + mo + '-' + String(+d).padStart(2, '0');
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
        // 日期范围过滤：先归一化入参（兼容 '2026-8-1' / '2026/09/01' / '2026-09' 月粒度），
        //   并把库内 'YYYY/MM/DD' 一并归一，避免跨格式漏检（原来纯字典序比较会静默出错，见 _agentNormDate）
        if (dateFrom) { var _df = _agentNormDate(dateFrom, false); filtered = filtered.filter(function(i) { return String(i.datetime||'').replace(/\//g, '-') >= _df; }); }
        if (dateTo)   { var _dt = _agentNormDate(dateTo, true);    filtered = filtered.filter(function(i) { return String(i.datetime||'').replace(/\//g, '-') <= _dt + ' 23:59:59'; }); }
        // 性质筛选：按首字符匹配（模型传 'A类问题' / 'A' 都能命中库内 'A类'；'红线' → '红'）
        if (nature) { var _nK = String(nature).trim().charAt(0).toUpperCase(); filtered = filtered.filter(function(i) { return String(i['性质']||'').trim().charAt(0).toUpperCase() === _nK; }); }
        // 典型问题引用默认 35 条；用户要求更多时无硬上限
        var lim = (typeof limit === 'number' && limit > 0) ? limit : 35;
        // 【P0′】统计与召回分离：total=精确子串命中数（数字可信、在线/离线一致）；
        //   items=关键词召回样例（宽松，字面命中恒排近似命中之前）
        var _keysI = ['性质','category','content','regulation','unit'];
        return {
            total: _exactFilter(filtered, keyword, _keysI).length,
            items: _kwRecall(filtered, keyword, _keysI, lim),
            统计口径: 'total 为「含关键词字面」的精确命中数（可信）；items 为关键词召回样例（含近似命中，按相关度排序），条数可能少于 total'
        };
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
        // 日期/性质口径与 _agentGetIssues 完全一致（归一化 + 首字符匹配），避免"搜索与统计数字不一致"
        if (dateFrom) { var _cdf = _agentNormDate(dateFrom, false); filtered = filtered.filter(function(i) { return String(i.datetime||'').replace(/\//g, '-') >= _cdf; }); }
        if (dateTo)   { var _cdt = _agentNormDate(dateTo, true);    filtered = filtered.filter(function(i) { return String(i.datetime||'').replace(/\//g, '-') <= _cdt + ' 23:59:59'; }); }
        if (nature) { var _cnK = String(nature).trim().charAt(0).toUpperCase(); filtered = filtered.filter(function(i) { return String(i['性质']||'').trim().charAt(0).toUpperCase() === _cnK; }); }
        var kw = (keyword && String(keyword).trim()) ? keyword : '';
        // 【P0′】统计**一律精确子串**：原先复用 Fuse 模糊匹配 → total 含近似命中，
        //   同一查询在线/离线数字不同（提示词要求"必须真实总数、不得估算"）。实测：
        //   查询「作业人员未执行标准化作业程序」旧 Fuse 报 687/687，精确子串才是真值。
        var matched = kw ? _exactFilter(filtered, kw, ['性质','category','content','regulation','unit']) : filtered;
        var groups = {};
        var _gbErr = '';
        if (groupBy) {
            // 【2026-09-21】白名单 + 月份桶。原实现是任意字段直接索引：模型传「单位」「月份」这类中文名时
            //   全部落入 (未分类)，却照样出报告（静默错误）。month 桶用于"近 N 个月趋势"，一次调用即可拿到。
            if (groupBy === 'month') {
                matched.forEach(function(i) {
                    var k = String(i.datetime || '').replace(/\//g, '-').slice(0, 7) || '(无日期)';
                    groups[k] = (groups[k] || 0) + 1;
                });
            } else if (['性质', 'category', 'unit', 'trade'].indexOf(groupBy) !== -1) {
                matched.forEach(function(i) {
                    var k = (i[groupBy] != null && i[groupBy] !== '') ? i[groupBy] : '(未分类)';
                    groups[k] = (groups[k] || 0) + 1;
                });
            } else {
                _gbErr = 'groupBy 仅支持 性质/category/unit/trade/month（month=按 YYYY-MM 分组，用于时间趋势）；收到：' + groupBy;
            }
        }
        var _out = { total: matched.length, groups: groups };
        if (_gbErr) _out.参数错误 = _gbErr;
        return _out;
    };

    /**
     * 【2026-09-21】导出检查信息清单（CSV / UTF-8 BOM，Excel、WPS 直接打开）
     *   补齐"批量导出"能力缺口 —— 原先智能体只能把 ≤35 条念成文本，用户要清单只能自己复制。
     *   筛选口径与 _agentCountIssues / _agentGetIssues 完全一致（日期归一 + 性质首字符匹配）。
     *   返回 {条数, 文件名, ...}；>5000 条按 5000 截断并明确提示（避免一次生成几十 MB 文件）。
     */
    window._agentExportIssues = function(opts) {
        opts = opts || {};
        var data = [];
        try { if (typeof window.getIssueData === 'function') data = window.getIssueData() || []; } catch (e) { data = []; }
        if (!data.length) return { error: '本地暂无检查信息可导出' };
        var filtered = data;
        if (opts.unit) filtered = filtered.filter(function(i) { return String(i.unit || '').indexOf(opts.unit) !== -1; });
        if (opts.category) filtered = filtered.filter(function(i) { return String(i.category || '').indexOf(opts.category) !== -1; });
        if (opts.dateFrom) { var _df = _agentNormDate(opts.dateFrom, false); filtered = filtered.filter(function(i) { return String(i.datetime || '').replace(/\//g, '-') >= _df; }); }
        if (opts.dateTo) { var _dt = _agentNormDate(opts.dateTo, true); filtered = filtered.filter(function(i) { return String(i.datetime || '').replace(/\//g, '-') <= _dt + ' 23:59:59'; }); }
        if (opts.nature) { var _nk = String(opts.nature).trim().charAt(0).toUpperCase(); filtered = filtered.filter(function(i) { return String(i['性质'] || '').trim().charAt(0).toUpperCase() === _nk; }); }
        if (opts.keyword) filtered = _exactFilter(filtered, opts.keyword, ['性质', 'category', 'content', 'regulation', 'unit']);
        var total = filtered.length;
        if (!total) return { 条数: 0, 说明: '按当前条件没有匹配到检查信息，未生成文件' };
        var CAP = 5000;
        var rows = filtered.slice(0, CAP);
        var q = function(v) { return '"' + String(v == null ? '' : v).replace(/"/g, '""').replace(/[\r\n]+/g, ' ') + '"'; };
        var csv = '\ufeff' + ['时间', '性质', '类别', '单位', '专业', '问题描述', '规章依据'].join(',') + '\r\n';
        rows.forEach(function(i) {
            csv += [i.datetime || '', i['性质'] || '', i.category || '', i.unit || '', i.trade || '', i.content || '', i.regulation || ''].map(q).join(',') + '\r\n';
        });
        var name = '检查信息_' + (opts.unit || '全部') + '_' + (opts.dateFrom || '起') + '-' + (opts.dateTo || '今') + '.csv';
        try {
            if (typeof window.downloadBlob !== 'function') return { error: '下载组件未就绪（downloadBlob 缺失）' };
            window.downloadBlob(new Blob([csv], { type: 'text/csv;charset=utf-8' }), name);
        } catch (e) { return { error: '导出失败：' + ((e && e.message) || '未知错误') }; }
        var out = { 条数: total, 文件名: name, 说明: 'CSV（UTF-8 BOM），Excel/WPS 可直接打开' };
        if (total > CAP) out.截断提示 = '本次仅导出前 ' + CAP + ' 条（共 ' + total + ' 条），请缩小筛选范围后分批导出';
        return out;
    };

    /** 搜索规章制度（返回 {total:未截断匹配数, items:截断列表}，与 search_issues 一致，避免 AI 统计相关条数时被 limit 截断） */
    window._agentGetRules = function(keyword, limit) {
        var rules = [];
        try {
            if (typeof window.getRulesData === 'function') rules = window.getRulesData();
        } catch(e) { return { total: 0, items: [] }; }
        if (!rules.length) return { total: 0, items: [] };
        var lim = (typeof limit === 'number' && limit > 0) ? limit : 10;
        // 【P0′】total=精确子串命中数（可信）；items=关键词召回样例（宽松）
        var _keysR = ['title','content','trade'];
        return {
            total: _exactFilter(rules, keyword, _keysR).length,
            items: _kwRecall(rules, keyword, _keysR, lim),
            统计口径: 'total 为「含关键词字面」的精确命中数（可信）；items 为关键词召回样例（含近似命中），条数可能少于 total'
        };
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
            // ⚠️ 必须采用 diary.js 返回的真实结果：它区分
            // saved / empty（内容为空）/ duplicate（当日重复已去重）。
            // 原先无条件 return ok:true，导致"AI 向用户确认日志已写入、其实什么都没写"。
            if (!fullContent) return { ok: false, error: 'content 不能为空：未提供要写入日志的内容' };
            var res = window.addIssueToDiary(fullContent, '', date || '');
            if (res && res.ok) return { ok: true, message: res.message || '日志已写入', date: res.date };
            if (res && res.reason === 'duplicate') return { ok: false, error: res.message || '当日已存在完全相同的问题，未重复写入' };
            if (res && res.reason) return { ok: false, error: res.message || '日志未写入' };
            // 兼容旧实现（无返回值）：未抛异常即视为写入成功
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
            // 版本号：扫描已存在的「标题（vN）」取最大 N 再 +1。
            // 原先只统计与基础标题"完全相同"的条数：已存在的 X（v2）不计入，
            // 于是第二次保存仍生成 X（v2），报告库里堆出多条同名同版本，用户无法分辨先后。
            var baseTitle = String(title || '').trim();
            var maxV = 0;
            existing.forEach(function(m) {
                var t = String(m.title || '').trim();
                if (t === baseTitle) { maxV = Math.max(maxV, 1); return; }
                try {
                    var mm = t.match(new RegExp('^' + baseTitle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '（v(\\d+)）$'));
                    if (mm) maxV = Math.max(maxV, parseInt(mm[1], 10) || 0);
                } catch (e) {}
            });
            var finalTitle = maxV > 0 ? (baseTitle + '（v' + (maxV + 1) + '）') : baseTitle;
            // ⚠️ wrAgentSaveMaterial 是 async：原先 `var ok = window.wrAgentSaveMaterial(...)` 后取 !!ok，
            // Promise 恒为真 → 落库失败（配额/异常）也报"报告已保存"。改为 await 真实结果，
            // 并加 20s 上限，避免底层 Promise 不 settle 时把智能体整轮卡死。
            var saved = await Promise.race([
                window.wrAgentSaveMaterial(finalTitle, content),
                new Promise(function(res) { setTimeout(function() { res('__timeout__'); }, 20000); })
            ]);
            if (saved === '__timeout__') {
                return { ok: false, error: '保存超时（20s）未确认写入；报告内容仍在对话里，可手动复制保存' };
            }
            var ok = saved !== false;
            return { ok: ok, message: ok ? '报告已保存' : '保存失败（可能是存储空间不足）', title: finalTitle };
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
        // 【P0′】total=精确子串命中数（可信）；items=关键词召回样例（宽松）
        var _keysH = ['chapter','section','item','subitem','content'];
        return {
            total: _exactFilter(hb, keyword, _keysH).length,
            items: _kwRecall(hb, keyword, _keysH, lim),
            统计口径: 'total 为「含关键词字面」的精确命中数（可信）；items 为关键词召回样例（含近似命中），条数可能少于 total'
        };
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
    // 【2026-09-19】file:// 下浏览器**必定**拒绝注册 Service Worker（origin 'null' 不受支持），
    //   原来会打下 2 条 warn（"注册失败，降级为无离线模式" + "SW 注册失败: TypeError..."），
    //   在"双击 index.html 自测"场景里纯属噪音，且这是浏览器硬限制、代码改不掉。
    //   这里直接**跳过注册尝试**（只留一条会被静默的调试日志）；http/https 行为完全不变。
    var _swSkipForFile = (location.protocol === 'file:');
    if (_swSkipForFile) {
        console.log('[PWA] file:// 本地打开：跳过 Service Worker（离线/PWA 需 http/https，部署后自动启用）');
    } else {
        console.log('[PWA] SW 注册中(离线优先)...');
    }

    // 必须给 register 兜底：非 HTTPS 站点、隐私模式、被裁剪的 WebView 都可能让
    // register 直接抛错或 reject。原实现既无 try/catch 也无 .catch()，一旦失败
    // 整个 IIFE 就中断了 —— 后面的 triggerApplyUpdate / switchUpdateBtn /
    // applyPendingUpdate 全部不会挂到 window 上，设置面板的「检查更新」直接失效，
    // 表现就是「部分功能点不了」。
    var _regPromise = null;
    try {
        _regPromise = (!_swSkipForFile && navigator.serviceWorker && navigator.serviceWorker.register)
            ? navigator.serviceWorker.register('sw.js')
            : null;
    } catch (swErr) {
        console.warn('[PWA] SW 注册异常，降级为无离线模式:', swErr && swErr.message);
        _regPromise = null;
    }
    if (!_regPromise || typeof _regPromise.then !== 'function') {
        // file:// 是有意跳过（上面已给过提示），不再打 warn；其它环境仍如实告警
        if (!_swSkipForFile) console.warn('[PWA] 当前环境不支持 Service Worker，离线能力不可用');
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
    // ⚠️ 需守卫：没有 Service Worker 的环境（老 WebView / file://）里若直接访问会抛错，
    //   而这行在 IIFE 里 —— 一抛就把后面挂在 window 上的「检查更新」等函数全部丢掉。
    if (navigator.serviceWorker && navigator.serviceWorker.addEventListener) {
    navigator.serviceWorker.addEventListener('controllerchange', function() {
        _fetchSwVersion(); // 刷新离线获取的 12 位版本号
        // 修复：_pendingReload 仅在有效期内（60s）生效，过期作废。
        // 避免折叠屏文档重建偶然触发历史残留 reload（用户曾点过「立即更新」但未真正生效），
        // 导致「明明没更新却重启」的误重载。
        // 【v3.51】放宽到 60s：applyPendingUpdate 可能要轮询等待新 SW 进入 waiting
        // （最多约 8s），原 10s 窗口过窄，会把正常等待中的更新判为过期而不刷新。
        if (_pendingReloadAt && (Date.now() - _pendingReloadAt) > 60000) {
            _pendingReload = false;
            _pendingReloadAt = 0;
        }
        if (_pendingReload) {
            _pendingReload = false;
            _pendingReloadAt = 0;
            window.location.reload();
        }
    });
    }   // ← 守卫块结束（见上方 if (navigator.serviceWorker && ...)）

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
    // controllerchange 迟迟不来时的刷新兜底（此时新 SW 已激活，刷新即可拿到新版本）
    function _armReloadFallback(delay) {
        setTimeout(function() {
            if (_pendingReload) {
                _pendingReload = false;
                _applyingUpdate = false;
                window.location.reload();
            }
        }, delay);
    }

    // 强制硬更新：清空 SW 缓存 + 注销 SW 后刷新。
    // 仅在「始终等不到 waiting 状态的新 SW」时启用——说明常规更新链路走不通，
    // 若不处理就表现为「点立即更新没反应 / 刷新后仍是旧版」。
    function forceHardReload(reg) {
        var cleanup = Promise.resolve();
        if (window.caches && caches.keys) {
            cleanup = caches.keys().then(function(keys) {
                return Promise.all(keys.map(function(k) { return caches.delete(k); }));
            }).catch(function() {});
        }
        cleanup.then(function() {
            if (reg && reg.unregister) return reg.unregister().catch(function() {});
        }).then(function() { window.location.reload(); },
                function() { window.location.reload(); });
    }
    window.forceHardReload = forceHardReload;

    var _applyingUpdate = false;   // 防重入：等待新 SW 期间禁止重复点击

    function applyPendingUpdate() {
        if (_applyingUpdate) return;
        _applyingUpdate = true;
        _pendingReload = true;
        _pendingReloadAt = Date.now();
        // 应用更新：清除红点标记（刷新后由新版本接管，_has_update 不再成立）
        try { localStorage.removeItem('_has_update'); } catch (e) {}
        setUpdateBadge(false);
        // 立即给出反馈，避免用户以为点了没反应
        var _updTitle = document.getElementById('check-update-title');
        var _updArrow = document.getElementById('check-update-arrow');
        if (_updTitle) _updTitle.textContent = '⏳ 正在更新…';
        if (_updArrow) _updArrow.textContent = '请勿关闭';

        if (!navigator.serviceWorker || !navigator.serviceWorker.getRegistration) {
            forceHardReload(null); return;
        }
        navigator.serviceWorker.getRegistration().then(function(reg) {
            if (!reg) { forceHardReload(null); return; }
            // 快速路径：新 SW 已在 waiting，直接令其接管
            if (reg.waiting) {
                reg.waiting.postMessage({ type: 'SKIP_WAITING' });
                _armReloadFallback(3000);
                return;
            }
            // 关键修复：waiting 尚未就绪时（triggerApplyUpdate 的 reg.update() 仍在进行），
            // 原实现会把 SKIP_WAITING 发给 navigator.serviceWorker.controller（已激活的旧 SW），
            // 而 skipWaiting() 对已激活的 SW 无效 → 不触发 controllerchange → 1.5s 后强制刷新
            // 仍被旧 SW 的 CacheFirst 拦下返回旧页面，表现为「点更新没反应 / 还是旧版」。
            // 改为主动再拉一次更新，并轮询等待新 SW 进入 waiting（最多约 8s）。
            try { reg.update().catch(function() {}); } catch (e) {}
            var _tries = 0, MAX_TRIES = 20; // 20 × 400ms ≈ 8s
            var _timer = setInterval(function() {
                navigator.serviceWorker.getRegistration().then(function(r2) {
                    if (r2 && r2.waiting) {
                        clearInterval(_timer);
                        r2.waiting.postMessage({ type: 'SKIP_WAITING' });
                        _armReloadFallback(3000);
                    } else if (++_tries >= MAX_TRIES) {
                        clearInterval(_timer);
                        forceHardReload(r2 || reg); // 常规链路走不通 → 清缓存注销后硬刷新
                    }
                }).catch(function() {
                    clearInterval(_timer);
                    forceHardReload(reg);
                });
            }, 400);
        }).catch(function() { forceHardReload(null); });
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
        var hitKimi = false;
        try {
            hitKimi = !!document.querySelector('[id*="kimi" i],[class*="kimi" i],[class*="kimi-extension" i],kimi-chat-widget,kimi-fab');
        } catch (e) { hitKimi = false; }
        if (hitKimi) {
            document.querySelectorAll('[id*="kimi" i],[class*="kimi" i],[class*="kimi-extension" i]').forEach(function(el) {
                if (el.id !== '_block_kimi_fab' && el.closest('header,main,nav,section')) return;
                el.remove();
            });
            document.querySelectorAll('kimi-chat-widget,kimi-fab').forEach(function(el) { el.remove(); });
        }
        // 【启动/运行优化 2026-09-18】没有 kimi 元素时**快速短路**：原实现每次 DOM 变动都要跑两次
        // 全文档 querySelectorAll + 对 body 直接子元素逐个 getComputedStyle（强制样式计算），
        // 而 AI 流式对话是逐字插入 DOM 的 —— 每一次都会触发这轮扫描，是运行期最明显的一处白工。
        // 现在只做一次轻量兜底：只扫 body 直接子元素、且每个节点只判一次（判过打标记），
        // 这样"无 kimi 环境"下的单次成本从 O(全文档) 降到 O(body 子元素数)。
        var kids = document.body ? document.body.children : [];
        for (var i = 0; i < kids.length; i++) {
            var el = kids[i];
            if (!el || el.tagName !== 'DIV' || el.id || el.className) continue;
            if (el.getAttribute('data-aj-scanned') === '1') continue;
            el.setAttribute('data-aj-scanned', '1');
            var s = getComputedStyle(el);
            if (s.position === 'fixed' && s.zIndex && parseInt(s.zIndex) > 100000) { el.remove(); return true; }
        }
        return false;
    }
    setTimeout(removeKimiElements, 500);
    setTimeout(removeKimiElements, 2000);
    // 防抖：一次 DOM 抖动只跑一次；10s 后停止监听（扩展注入发生在页面加载早期，
    // 之后再挂一个全文档 MutationObserver 只会在流式渲染时白白唤醒主线程）。
    var _kimiTimer = null;
    var mo = new MutationObserver(function() {
        if (_kimiTimer) return;
        _kimiTimer = setTimeout(function() { _kimiTimer = null; removeKimiElements(); }, 400);
    });
    mo.observe(document.body, { childList: true, subtree: true });
    setTimeout(function() { try { mo.disconnect(); } catch (e) {} }, 10000);
})();

// 更新红点的统一维护（v3.63）
// 三处入口需同时同步：顶栏「设置」按钮、设置面板「关于」页的「检查更新」按钮，
// 以及设置面板「关于」分类项本身 —— 面板改成模态后入口被遮罩盖住，若不在分类上提示，
// 用户打开设置也看不出有新版本。
function setUpdateBadge(on) {
    var yes = !!on;
    ['tab-settings', 'check-update-btn'].forEach(function(id) {
        var el = document.getElementById(id);
        if (el) el.classList.toggle('has-update-badge', yes);
    });
    var navAbout = document.querySelector('#settings-panel .st-nav-item[data-sec="about"]');
    if (navAbout) navAbout.classList.toggle('has-update-badge', yes);
}

// ==================== 设置面板分类导航（v3.63） ====================
// 面板结构：通用 / 数据 / 接口 / 关于 四类，HTML 中 .st-nav-item 与 .st-sec 以 data-sec 成对匹配。
// 切换只改 is-active，不重建 DOM —— 避免打断输入框焦点、滚动位置与已展开的折叠项。
window.stGoSection = function(key) {
    var panel = document.getElementById('settings-panel');
    if (!panel || !key) return;
    var items = panel.querySelectorAll('.st-nav-item[data-sec]');
    var secs = panel.querySelectorAll('.st-sec[data-sec]');
    var hit = false;
    for (var i = 0; i < items.length; i++) {
        if (items[i].getAttribute('data-sec') === key) hit = true;
    }
    if (!hit) return;
    for (var j = 0; j < items.length; j++) {
        items[j].classList.toggle('is-active', items[j].getAttribute('data-sec') === key);
    }
    for (var k = 0; k < secs.length; k++) {
        secs[k].classList.toggle('is-active', secs[k].getAttribute('data-sec') === key);
    }
    panel.setAttribute('data-active-sec', key);
    var content = document.getElementById('st-content');
    if (content) content.scrollTop = 0;
    // 数据页的数量是懒加载的：分类后默认页不再是数据页，故切到该页时再刷新一次
    if (key === 'data' && window.updateDataManagementStats) {
        try { window.updateDataManagementStats(); } catch (e) {}
    }
};

// ==================== 设置页折叠分组（v3.74 数据页整理） ====================
// <details class="st-fold" data-fold-key="xxx" ontoggle="stRememberFold(this)">
// 目的：把「各模块数据」「知识库」这类长列表默认收起，界面一眼清爽；
//       用户展开过一次后记住状态，下次打开面板仍是展开。
window.stRememberFold = function(el) {
    if (!el || !el.getAttribute) return;
    var k = el.getAttribute('data-fold-key');
    if (!k) return;
    try { localStorage.setItem('st_fold_' + k, el.open ? '1' : '0'); } catch (e) {}
};
window.stRestoreFolds = function() {
    var panel = document.getElementById('settings-panel');
    if (!panel) return;
    var list = panel.querySelectorAll('details.st-fold[data-fold-key]');
    for (var i = 0; i < list.length; i++) {
        var k = list[i].getAttribute('data-fold-key');
        var v = null;
        try { v = localStorage.getItem('st_fold_' + k); } catch (e) {}
        // 只在用户明确设置过时恢复；默认保持 HTML 里的初始状态（收起）
        if (v === '1') list[i].open = true;
        else if (v === '0') list[i].open = false;
    }
};

// 时机兜底：defer 脚本正常时早于 DOMContentLoaded；但若脚本执行时页面已就绪（实测会遇到），
// 也必须恢复一次 —— 否则监听器永不触发，表现就是"记住展开状态"失效。
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', window.stRestoreFolds);
else window.stRestoreFolds();

window.toggleSettingsPanel = function() {
    var p = document.getElementById('settings-panel');
    if (!p) return;
    var isOpening = (p.style.display === 'none' || p.style.display === '');
    if (isOpening) {
        p.style.display = 'flex';   // 模态：外层是遮罩容器，用 flex 让对话框居中
        if (window.updateDataManagementStats) window.updateDataManagementStats();
        if (window.syncDarkModeToggle) window.syncDarkModeToggle();
        if (window.syncCapabilityToggles) window.syncCapabilityToggles();
        // 回到上次停留的分类（首次为「通用」）；分类状态异常时兜底回通用页，避免打开是空白
        window.stGoSection(p.getAttribute('data-active-sec') || 'general');
        // 折叠分组的展开状态：每次打开展板再同步一次（幂等，避免加载时序问题导致状态丢失）
        if (window.stRestoreFolds) window.stRestoreFolds();
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

// 点击外部收起：v3.63 起设置面板是「遮罩 + 对话框」模态，遮罩自身已绑定关闭，
// 这里对模态直接放行（避免与遮罩点击重复触发）；保留旧的下拉行为以兼容无遮罩的结构。
document.addEventListener('click', function(e) {
    var p = document.getElementById('settings-panel');
    if (!p || p.style.display === 'none') return;
    if (p.classList.contains('st-modal')) return;
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

    // 【v3.76 修复】清完 SW 缓存还不够 —— **静态资源仍可能被浏览器的 HTTP 缓存复用**：
    //   本项目部署在 python http.server 等"不发 Cache-Control"的环境下时，浏览器会按"启发式新鲜度"
    //   直接用旧副本，而 location.reload(true) 的强制刷新参数在现代 Chrome 已失效（等同普通刷新）。
    //   表现就是"点了清除缓存、刷新后脚本还是旧的"（本次排查卡滞问题时亲自踩到）。
    //   所以在刷新前，把当前页面引用到的 js/css（以及 sw.js）用 cache:'reload' **强制从网络重取一遍**
    //   —— 它绕过缓存读取并**同时刷新该 URL 的缓存条目**，之后 reload 就能拿到真正的最新文件。
    function _refreshStaticAssets() {
        try {
            var urls = [];
            Array.prototype.forEach.call(document.querySelectorAll('script[src]'), function(s) {
                if (s.src) urls.push(s.src);
            });
            Array.prototype.forEach.call(document.querySelectorAll('link[rel="stylesheet"]'), function(l) {
                if (l.href) urls.push(l.href);
            });
            try { urls.push(new URL('sw.js', location.href).href); } catch (e) {}
            return Promise.all(urls.map(function(u) {
                return fetch(u.split('#')[0], { cache: 'reload' }).catch(function() {});
            }));
        } catch (e) {
            return Promise.resolve();
        }
    }

    // 等所有清理完成再刷新（不再用固定 300ms 强刷，杜绝竞态）
    Promise.all(pending).then(_refreshStaticAssets).catch(function() {}).then(function() {
        location.reload();
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
            b.classList.toggle('is-on', on);   // 供 settings.css 在暗色下强制主色（压过 flat.css 的 button 广谱覆盖）
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

// ==================== 思考模式（自动 / 始终开启 / 始终关闭） ====================
// v3.62：由「DeepSeek V4 高级能力」折叠区移出。它是跨 5 个模块（智能对话/智能体/对规/写作/风险研判）
// 共用的基础参数，而非实验开关。同批移除两个零收益开关：
//   · JSON 输出模式——全库仅此处使用，开了只会让聊天窗口吐 JSON，不开则毫无作用；
//   · 前缀续写 Beta——FIM 能力，与主力模型 deepseek-flash 的兼容性未确认，用途极窄。
// 自动档的分级判定在 doubao-common.js 的 dsAutoThinkingEffort()，此处只负责读写与 UI 同步。
function _readThinkingMode() {
    if (typeof window.dsThinkingLevel === 'function') return window.dsThinkingLevel();
    try {
        var raw = localStorage.getItem('ds_thinking');
        if (raw === '1') return 'on';
        if (raw === '0') return 'off';
        if (raw === 'on' || raw === 'off') return raw;
    } catch (e) {}
    return 'auto';
}

// 设置思考模式并持久化；顺带清理已废弃开关的 localStorage 残留
window.setThinkingMode = function(mode) {
    if (mode !== 'auto' && mode !== 'on' && mode !== 'off') mode = 'auto';
    try {
        localStorage.setItem('ds_thinking', mode);
        localStorage.removeItem('ds_json_mode');
        localStorage.removeItem('ds_prefix');
        localStorage.removeItem('ds_tool_calls');
    } catch (e) {}
    syncThinkingModeUI();
};

// 同步三态分段控件选中态 + 提示文字（样式对齐「主题模式」分段控件）
function syncThinkingModeUI() {
    var seg = document.getElementById('thinkingModeSeg');
    if (!seg) return;
    var mode = _readThinkingMode();
    var btns = seg.querySelectorAll('button[data-mode]');
    if (btns.forEach) {
        btns.forEach(function(b) {
            var on = b.getAttribute('data-mode') === mode;
            b.classList.toggle('is-on', on);   // 供 settings.css 在暗色下强制主色（压过 flat.css 的 button 广谱覆盖）
            b.style.background = on ? 'var(--primary)' : 'var(--card-bg)';
            b.style.color = on ? '#fff' : 'var(--text)';
            b.style.borderColor = on ? 'var(--primary)' : 'var(--border)';
            b.style.fontWeight = on ? '700' : '400';
        });
    }
    var hint = document.getElementById('thinkingModeHint');
    if (hint) {
        hint.textContent = mode === 'auto'
            ? '按问题复杂度自动选用思考强度：闲聊、润色、常识类快答，分析、研判、写报告走深度推理'
            : (mode === 'on'
                ? '始终使用深度推理（质量最好，但响应更慢、更费 token）'
                : '始终不使用深度推理（响应最快，适合问答与资料检索类场景）');
    }
}
// 兼容旧调用入口（设置面板打开时会调用）
window.syncCapabilityToggles = syncThinkingModeUI;

// API 配置：根据选中的 API 地址自动推荐模型
window._updateModelList = function() {
    var urlEl = document.getElementById('modal-apiurl');
    var modelEl = document.getElementById('modal-model');
    if (!urlEl || !modelEl) return;
    var url = (urlEl.value || '').trim();
    // 常用 API 地址 → 默认模型映射
    var map = {
        'https://api.deepseek.com/chat/completions': 'deepseek-flash',
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
const APP_VERSION = 'v4.00'; // 单一版本源：设置面板与关于面板的版本号均在 DOMContentLoaded 时从此注入；发版时只需改此处 + 同步 version.json
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
        setUpdateBadge(true);
      }
    } catch (e) {}
    // 折叠屏/旋转会话状态恢复：文档重建后还原模块、滚动位置、草稿、弹窗
    if (window._restorePageState) {
        try { window._restorePageState(); } catch (e) { console.warn('[page-state] 恢复失败', e); }
    }
    // 自动检查更新：系统以离线数据完全打开后 12s，再连接远程测试有无新版本；
    // 仅在线时执行（离线时页面照常使用本地缓存，不打扰、不阻塞）。发现更新在页面顶部弹提示条。
    // 内置 10 分钟节流（silentCheckUpdate）：避免频繁请求版本服务器（version.json 很小，10 分钟足够省）。
    // 【2026-09-19】30s→12s / 1h→10min：发补丁当天用户能较快收到"发现新版本"提示（原来 30s+1h 导致当天几乎收不到）。
    if (navigator.onLine !== false) {
        setTimeout(function() {
            if (navigator.onLine !== false && typeof silentCheckUpdate === 'function') {
                silentCheckUpdate();
            }
        }, 12000);
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
    // 节流 10 分钟（原 1 小时：发补丁当天用户往往一小时内就被节流挡住，收不到更新提示）
    if (lastCheck && (Date.now() - parseInt(lastCheck)) < 600000) {
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

        // 【2026-09-19 修复】"新版本"判定必须**也看构建号**，否则"同版本号打补丁"永远检测不到：
        //   本项目的发版习惯是「v3.76 补丁 ×N」——version 字段不变、只有 build/sw 时间戳变，
        //   而 compareVersions('v3.76','v3.76') 恒为 0 → 红点/顶部横幅/自动预备 全都不会触发，
        //   用户只能靠"清缓存"才拿到新版（2026-09-19 DOCX 导出失效就是这么暴露的）。
        //   参照物：_SW_VERSION = 当前 SW 的 CACHE_VERSION（12 位时间戳，与 version.json 的 sw 同格式），
        //   由 SW 经 MessageChannel 离线回报；拿不到时（首装/无 SW）只按版本号判定，避免误报。
        const remoteSw = String(data.sw || '').replace(/\D/g, '');
        const curSw = String(_SW_VERSION || '').replace(/\D/g, '');
        const buildDiffers = !!(remoteSw && curSw && remoteSw !== curSw);
        const verIsNew = compareVersions(remoteVersion, APP_VERSION) > 0;
        const isNew = verIsNew || buildDiffers;
        // 提示文案：同版本号的补丁要显示构建时间，否则用户看到"发现新版本 v3.76（当前 v3.76）"会困惑
        const _fmtBuild = function (b) {
            var m = String(b || '').match(/^(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})/);
            return m ? (m[1] + '-' + m[2] + '-' + m[3] + ' ' + m[4] + ':' + m[5]) : '';
        };
        const _bTxt = _fmtBuild(data.build);
        const remoteLabel = (buildDiffers && !verIsNew && _bTxt)
            ? (remoteVersion + '（' + _bTxt + ' 构建）')
            : remoteVersion;
        if (isNew) {
            setUpdateBadge(true);
            localStorage.setItem('_has_update', 'true');
            // v3.26：「立即更新」按钮原位覆盖「检查更新」按钮（循环图标样式）
            if (window.switchUpdateBtn) window.switchUpdateBtn('update');
            if (showStatus) {
                statusEl.innerHTML = '🆕 发现新版本 <strong>' + remoteLabel + '</strong>（当前 ' + APP_VERSION + '）<br>' + (releaseNotes ? '📝 ' + releaseNotes.slice(0, 120) + (releaseNotes.length > 120 ? '…' : '') : '') + '<br>新版已就绪，点击上方「🔄 立即更新」应用新版本';
                statusEl.style.color = '#dc2626';
            }
            // 自动预备 SW 更新（离线优先策略下，更新仅在此触发）
            if (window.triggerApplyUpdate) window.triggerApplyUpdate();
            // 页面顶部弹出更新提示条（手动/静默检查均生效），点击即应用
            if (window.showUpdateBanner) window.showUpdateBanner(remoteLabel);
        } else {
            setUpdateBadge(false);
            localStorage.removeItem('_has_update');
            // 判定"已是最新"时顺手收起可能残留的顶部横幅（否则会出现"已是最新却还挂着发现新版本"的矛盾画面，
            // 原实现只能等它 12s 自动收起）
            if (window.hideUpdateBanner) { try { window.hideUpdateBanner(); } catch (e) {} }
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
