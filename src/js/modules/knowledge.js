/**
 * 统一检索层（Knowledge Base）
 * ==========================================================================
 * 解决什么问题：
 *   旧路径把「一条记录 = 一整篇文档」拿去做 BM25，命中后只把正文**截前 300 字**喂给模型。
 *   而一篇几千字的办法，前 300 字几乎必然是"第一条 为加强…制定本办法"这类总则，
 *   真正相关的那一条根本进不了上下文 —— 模型只能泛泛引用，甚至编条款号。
 *   本模块把各源**按自然粒度分块**（规章按条、手册按项点、资料按段落、问题库/电话/日志按条），
 *   命中哪一块就把那一块**完整**喂进去，并带上出处路径。
 *
 * 覆盖的源（6 类，7 个数据列表）：
 *   rules    规章制度   window.getRulesData()      → 按「章/节/条」切
 *   issues   检查信息   window.getIssueData()      → 一条一记录
 *   handbook 检查手册   window.getHandbookData()   → 一个项点一块（四级路径）
 *   materials 写作资料  _wrGetAllMaterials()       → 按段落切
 *   reports  历史报告   _wrGetAllReports()         → 按段落切
 *   phone    应急电话   window.getPhoneData()      → 一条一记录
 *   diary    工作日志   window.getDiaryData()      → 一天一块
 *
 * 设计要点：
 *   · 打分复用 doubao.js 暴露的 window.LightBM25（倒排表 + 词频累加，千级语料毫秒级）
 *   · **懒建**：某个源第一次被检索时才建索引，不在启动路径上（v3.15 的教训）
 *   · 每个源一个独立索引：BM25 的 idf 只在同一语料内有可比性，跨源不混算分数，
 *     KB.search 按源分组返回（消费方按源拼提示词，天然带上"来自哪个库"的语义）
 *   · 失效沿用统一契约：doubao.js 的 dsInvalidateRagCache() 会调 KB.invalidate()；
 *     各源另有「数组引用 + 条数」兜底指纹
 *   · 不引入新库、不用 Worker（索引全在内存，导入后自动失效重建）
 *
 * 加载顺序：不依赖 DOM，可放在 doubao.js 之前；LightBM25 在首次检索时才取用（懒依赖）。
 */
(function () {
    'use strict';

    var CHUNK_MAX = 500;      // 单块字数上限（长段落按句读续切）
    var MIN_CHUNK = 40;       // 小于此长度的片段不单独成块
    var MAX_PER_DOC = 2;      // 同一来源文档最多贡献几块（避免 topK 被同一篇占满）
    var SRC_BUDGET = 6000;    // 单源上下文预算（与 doubao.js 的 DS_MAX_CTX_CHARS 对齐）

    var EMPTY = [];

    // 分片切块：各源的 chunk 函数都是"逐条独立"的（条目之间无共享状态），
    // 因此可以按条切片调用、片间让出事件循环 —— 4 万条语料切块实测约 400ms 同步阻塞，手机更久。
    function chunkAllAsync(s, list, onProgress) {
        var SLICE = 150;
        var out = [], i = 0;
        return new Promise(function (resolve) {
            function step() {
                var end = Math.min(i + SLICE, list.length);
                if (end > i) {
                    var part = s.chunk(list.slice(i, end));
                    for (var k = 0; k < part.length; k++) out.push(part[k]);
                }
                i = end;
                if (onProgress) onProgress(i, list.length);
                if (i < list.length) setTimeout(step, 0);
                else resolve(out);
            }
            step();
        });
    }

    // ==================== 文本工具 ====================

    function stripTags(html) {
        return String(html == null ? '' : html)
            .replace(/<br\s*\/?>/gi, '\n')
            .replace(/<\/(p|div|li|tr|h[1-6]|section|article)>/gi, '\n')
            .replace(/<[^>]+>/g, '')
            .replace(/&nbsp;/g, ' ')
            .replace(/&lt;/g, '<')
            .replace(/&gt;/g, '>')
            .replace(/&quot;/g, '"')
            .replace(/&#39;/g, "'")
            .replace(/&amp;/g, '&')
            .replace(/[ \t\u00a0]+/g, ' ')
            .replace(/\n[ \t]+/g, '\n')
            .replace(/\n{2,}/g, '\n')
            .trim();
    }

    var RE_MARK = /(^|\n)[ \t　]*(第[一二三四五六七八九十百千零〇0-9]+[章节条])/g;

    function firstLine(seg) {
        var line = String(seg || '').split('\n')[0].replace(/\s+/g, ' ').trim();
        return line.length > 60 ? line.slice(0, 60) + '…' : line;
    }

    // 长文本按句读切分，尽量不切断句子；续块补前缀（如「第十二条（续）」）
    function splitLong(seg, prefix) {
        var s = String(seg == null ? '' : seg);
        if (s.length <= CHUNK_MAX) return s.trim() ? [s.trim()] : [];
        var out = [];
        var rest = s;
        while (rest.length > CHUNK_MAX) {
            var win = rest.slice(0, CHUNK_MAX);
            var i = win.lastIndexOf('。');
            if (i < CHUNK_MAX * 0.5) i = win.lastIndexOf('；');
            if (i < CHUNK_MAX * 0.5) i = win.lastIndexOf(';');
            if (i < CHUNK_MAX * 0.5) i = win.lastIndexOf('\n');
            if (i < CHUNK_MAX * 0.5) i = CHUNK_MAX - 1;
            out.push(rest.slice(0, i + 1).trim());
            rest = rest.slice(i + 1);
        }
        if (rest.trim()) out.push(rest.trim());
        return out.filter(Boolean).map(function (t, i) { return i === 0 ? t : (prefix || '') + '（续）' + t; });
    }

    // 按段落切（空行优先，其次换行），段落过长再按长度切
    function splitParagraphs(text, prefix) {
        var s = stripTags(text);
        if (!s) return [];
        var byBlank = s.split(/\n{2,}/).map(function (x) { return x.trim(); }).filter(Boolean);
        var paras = byBlank.length > 1 ? byBlank : s.split(/\n/).map(function (x) { return x.trim(); }).filter(Boolean);
        var out = [];
        paras.forEach(function (p) {
            if (p.length <= CHUNK_MAX) { if (p) out.push(p); return; }
            splitLong(p, prefix).forEach(function (x) { out.push(x); });
        });
        return out;
    }

    function makeChunk(src, srcLabel, path, text, doc, extra) {
        var t = String(text == null ? '' : text).trim();
        if (!t) return null;
        var c = {
            src: src,
            srcLabel: srcLabel,
            path: path,
            text: t,
            doc: doc,                                   // 归属的原始记录（用于同文档限流）
            searchText: path + '\n' + t                 // 出处也参与检索（与旧路径 title+content 一致）
        };
        if (extra) for (var k in extra) if (extra.hasOwnProperty(k)) c[k] = extra[k];
        return c;
    }

    // ==================== 各源分块 ====================

    // 规章制度：按 章/节/条 切（纯函数，便于离线基准台直接调用）
    function chunkRules(rules) {
        var out = [];
        (rules || EMPTY).forEach(function (rule) {
            var title = String((rule && rule.title) || '未命名规章').trim();
            var trade = String((rule && rule.trade) || '通用').trim();
            var head = '[' + trade + ']《' + title + '》';
            var text = stripTags(rule && rule.content);
            if (!text) { var one = makeChunk('rules', '规章制度', head, title, rule, { trade: trade, title: title }); if (one) out.push(one); return; }

            var marks = [], m;
            RE_MARK.lastIndex = 0;
            while ((m = RE_MARK.exec(text)) !== null) marks.push({ idx: m.index + (m[1] ? m[1].length : 0), tag: m[2] });
            var curChapter = '', curSection = '';
            function pathOf(ref) {
                return head + (curChapter ? ' > ' + curChapter : '') + (curSection ? ' > ' + curSection : '') + (ref ? ' > ' + ref : '');
            }
            function push(ref, body) {
                splitLong(body, ref).forEach(function (piece) {
                    var c = makeChunk('rules', '规章制度', pathOf(ref), piece, rule, { ref: ref, trade: trade, title: title });
                    if (c) out.push(c);
                });
            }
            if (!marks.length) {
                splitParagraphs(text, '').forEach(function (p) { push('', p); });
                return;
            }
            if (marks[0].idx > 0) push('', text.slice(0, marks[0].idx));
            for (var i = 0; i < marks.length; i++) {
                var start = marks[i].idx;
                var end = (i + 1 < marks.length) ? marks[i + 1].idx : text.length;
                var seg = text.slice(start, end).trim();
                if (!seg) continue;
                var tag = marks[i].tag, kind = tag.charAt(tag.length - 1);
                if (kind === '章') {
                    curChapter = firstLine(seg); curSection = '';
                    var restC = seg.split('\n').slice(1).join('\n').trim();
                    if (restC.length >= MIN_CHUNK) push('', restC);
                } else if (kind === '节') {
                    curSection = firstLine(seg);
                    var restS = seg.split('\n').slice(1).join('\n').trim();
                    if (restS.length >= MIN_CHUNK) push('', restS);
                } else {
                    push(tag, seg);
                }
            }
        });
        return out;
    }

    // 检查信息：一条记录一块（本身就是"条"粒度）
    function chunkIssues(issues) {
        var out = [];
        (issues || EMPTY).forEach(function (it) {
            var body = stripTags(it && it.content);
            if (!body) return;
            var path = '[' + (it['性质'] || '未定级') + '][' + (it.category || '未分类') + ']' + (it.unit ? ' ' + it.unit : '') + (it.datetime ? ' ' + it.datetime : '');
            splitLong(body, '').forEach(function (piece) {
                var c = makeChunk('issues', '检查信息', path, piece, it, { date: it.datetime || '', category: it.category || '', level: it['性质'] || '' });
                if (c) out.push(c);
            });
        });
        return out;
    }

    // 检查手册：一个项点一块（四级路径 chapter > section > item > subitem）
    function chunkHandbook(hb) {
        var out = [];
        (hb || EMPTY).forEach(function (it) {
            var body = stripTags(it && it.content);
            if (!body) return;
            var parts = [it.chapter, it.section, it.item, it.subitem].filter(Boolean).map(function (x) { return String(x).trim(); });
            var path = parts.length ? parts.join(' > ') : '检查手册';
            splitLong(body, parts.length ? parts[parts.length - 1] : '').forEach(function (piece) {
                var c = makeChunk('handbook', '检查手册', path, piece, it);
                if (c) out.push(c);
            });
        });
        return out;
    }

    // 写作资料（含模板）：按段落切，路径 = [类型]《标题》 > 第 N 段
    function chunkMaterials(list) {
        var out = [];
        (list || EMPTY).forEach(function (it) {
            var title = String((it && (it.title || it.fileName)) || '未命名资料').trim();
            var type = String((it && it.matType) || '其它');
            var head = '[' + type + ']《' + title + '》';
            var paras = splitParagraphs(it && it.content, '');
            paras.forEach(function (p, i) {
                var path = head + (paras.length > 1 ? ' > 第' + (i + 1) + '段' : '');
                var c = makeChunk('materials', '写作资料库', path, p, it, { matType: type, title: title });
                if (c) out.push(c);
            });
        });
        return out;
    }

    // 历史报告：按段落切（仅供文风/结构参考）
    function chunkReports(list) {
        var out = [];
        (list || EMPTY).forEach(function (it) {
            var title = String((it && it.title) || '未命名报告').trim();
            var date = String((it && it.date) || '').slice(0, 10);
            var head = '《' + title + '》' + (date ? '（' + date + '）' : '');
            var paras = splitParagraphs(it && it.content, '');
            paras.forEach(function (p, i) {
                var path = head + (paras.length > 1 ? ' > 第' + (i + 1) + '段' : '');
                var c = makeChunk('reports', '历史报告', path, p, it, { date: date, title: title });
                if (c) out.push(c);
            });
        });
        return out;
    }

    // 应急电话：一条号码记录一块
    function chunkPhone(list) {
        var out = [];
        (list || EMPTY).forEach(function (it) {
            if (!it) return;
            var label = [it.单位, it.站名, it.线名].filter(Boolean).join(' - ');
            if (!label && !it.路电 && !it.市电) return;
            var body = (label || '') + '：路电 ' + (it.路电 || '无') + ' / 市电 ' + (it.市电 || '无');
            var c = makeChunk('phone', '应急电话', label || '应急电话', body, it);
            if (c) out.push(c);
        });
        return out;
    }

    // 工作日志：一天一块
    function chunkDiary(list) {
        var out = [];
        (list || EMPTY).forEach(function (it) {
            if (!it) return;
            var issues = (it.issues || []).filter(Boolean).join('；');
            var body = '工作内容：' + stripTags(it.work || '') + (issues ? '\n发现问题：' + issues : '');
            var path = '工作日志 ' + (it.date || '');
            splitLong(body, '').forEach(function (piece) {
                var c = makeChunk('diary', '工作日志', path, piece, it, { date: it.date || '' });
                if (c) out.push(c);
            });
        });
        return out;
    }

    // ==================== 源注册表（懒建 + 兜底指纹） ====================

    // 检查信息索引范围：台账动辄几万条，全量常驻代价过高（实测 40166 条 → 建索引 3.57s、常驻 157MB）。
    // 默认只索引**最近 12000 条**；面板可切 1 万 / 2 万 / 全部。全量「按单位/日期精确查询」仍由
    // 智能体的 search_issues、以及各模块自己的全量过滤负责，不受此限制（只是粗排不覆盖老数据）。
    var ISSUE_LIMIT_DEFAULT = 12000;
    function issueLimit() {
        try {
            var v = localStorage.getItem('kb_issue_limit');
            if (v === 'all') return 0;
            var n = parseInt(v, 10);
            return isNaN(n) ? ISSUE_LIMIT_DEFAULT : n;
        } catch (e) { return ISSUE_LIMIT_DEFAULT; }
    }
    function prepareIssues(list) {
        var lim = issueLimit();
        if (!lim || !list || list.length <= lim) return list;
        var arr = list.slice().sort(function (a, b) {
            var ta = a && a.datetime ? new Date(a.datetime).getTime() : 0;
            var tb = b && b.datetime ? new Date(b.datetime).getTime() : 0;
            if (isNaN(ta)) ta = 0;
            if (isNaN(tb)) tb = 0;
            return tb - ta;
        });
        return arr.slice(0, lim);
    }

    // loader 返回 { list, async } ：sync 源就地取数；async 源由 KB.ensure() 预载
    var SOURCES = [
        { key: 'rules', label: '规章制度', grain: '条款', accessor: 'getRulesData', chunk: chunkRules },
        { key: 'issues', label: '检查信息', grain: '条', accessor: 'getIssueData', chunk: chunkIssues, prepare: prepareIssues },
        { key: 'handbook', label: '检查手册', grain: '项点', accessor: 'getHandbookData', chunk: chunkHandbook },
        { key: 'materials', label: '写作资料库', grain: '段落', async: true, loader: '_wrGetAllMaterials', chunk: chunkMaterials },
        { key: 'reports', label: '历史报告', grain: '段落', async: true, loader: '_wrGetAllReports', chunk: chunkReports },
        { key: 'phone', label: '应急电话', grain: '条', accessor: 'getPhoneData', chunk: chunkPhone },
        { key: 'diary', label: '工作日志', grain: '天', accessor: 'getDiaryData', chunk: chunkDiary }
    ];
    var SRC_MAP = {};
    SOURCES.forEach(function (s) { SRC_MAP[s.key] = s; });

    // 每源状态：{ chunks, bm, srcRef, srcLen, list, loading }
    var STATE = {};

    function srcList(s) {
        if (s.async) return STATE[s.key] && STATE[s.key].list || EMPTY;
        if (typeof window === 'undefined') return EMPTY;
        var fn = window[s.accessor];
        if (typeof fn !== 'function') return EMPTY;
        try { return fn() || EMPTY; } catch (e) { return EMPTY; }
    }

    function ensureSource(key) {
        var s = SRC_MAP[key];
        if (!s) return null;
        var st = STATE[key];
        if (st && st.chunks) {
            // 兜底指纹：数据数组的引用或条数变了就重建（async 源按已缓存的 list 判断）
            var cur = s.async ? (st.list || EMPTY) : srcList(s);
            if (cur === st.srcRef && cur.length === st.srcLen) return st;
            invalidate(key);
        }
        var raw = s.async ? ((STATE[key] && STATE[key].list) || EMPTY) : srcList(s);
        var prepared = s.prepare ? s.prepare(raw) : raw;
        STATE[key] = {
            chunks: s.chunk(prepared),
            bm: null,
            // ⚠️ 指纹必须用**原始**数组：prepare（如检查信息按时间窗裁剪）每次都会生成新数组，
            //    拿它当指纹会导致每次检索都重建索引
            srcRef: raw,
            srcLen: raw.length,
            list: s.async ? raw : null,
            indexed: prepared.length,
            rawTotal: raw.length
        };
        return STATE[key];
    }

    // 统一「预载 + 建索引」（v3.73）：
    //   · async 源（资料库/历史报告在 IndexedDB）先取数
    //   · 所有源都用**分片异步**建索引（大语料不冻结界面），超过 250ms 的用全局进度条提示
    // 消费方约定：检索前先 await KB.ensure(要用的源)，之后 KB.search 就是纯内存毫秒级操作。
    function ensure(sources, opts) {
        opts = opts || {};
        var keys = (sources && sources.length) ? sources : SOURCES.map(function (s) { return s.key; });
        var onProgress = opts.onProgress;
        return Promise.all(keys.map(function (key) { return ensureOne(key, onProgress); }));
    }

    function ensureOne(key, onProgress) {
        var s = SRC_MAP[key];
        if (!s) return Promise.resolve();
        // —— 1) async 源：先取数（只存原始 list，chunks 交给 ensureSource 建）——
        var pre = Promise.resolve();
        if (s.async) {
            var st0 = STATE[key];
            if (!(st0 && st0.list)) {
                var fn = (typeof window !== 'undefined') ? window[s.loader] : null;
                if (typeof fn === 'function') {
                    pre = Promise.resolve().then(function () { return fn(); }).then(function (list) {
                        var arr = Array.isArray(list) ? list : EMPTY;
                        var cur = STATE[key] || {};
                        if (cur.srcRef === arr && cur.srcLen === arr.length) return;
                        STATE[key] = { list: arr, chunks: null, bm: null };   // 换新数据 → 丢弃旧索引
                    }).catch(function () { /* 取数失败：该源本次不出结果，不阻塞其它源 */ });
                }
            }
        }
        // —— 2) 分片切块 + 分片异步建索引 ——
        return pre.then(function () {
            var raw = s.async ? ((STATE[key] && STATE[key].list) || EMPTY) : srcList(s);
            var st = STATE[key];
            // 数据未变且索引已在 → 直接复用
            if (st && st.chunks && st.bm && st.srcRef === raw && st.srcLen === raw.length) return null;
            var prepared = s.prepare ? s.prepare(raw) : raw;
            var startedAt = Date.now();
            var big = prepared.length >= 2000;
            function report(phase, done, total) {
                if (typeof onProgress === 'function') { try { onProgress(key, done, total, phase); } catch (e) {} }
                if (big && typeof window !== 'undefined' && typeof window.showProgress === 'function' && Date.now() - startedAt > 250) {
                    var label = phase === 'chunk' ? '正在切块' : '正在建立本地索引';
                    window.showProgress(Math.max(5, Math.round(done / Math.max(1, total) * 100)), label + '：' + s.label + '（' + done + '/' + total + '）');
                }
            }
            // 切块：chunk 函数都是"逐条独立"的，按条切片调用，片间让出事件循环
            // ⚠️ 必须先建好"本次构建自己的"状态对象并持有局部引用：构建是**分片异步**的（要等好几轮
            //    setTimeout），期间任何 KB.invalidate()（数据导入/清空、dsInvalidateRagCache、连续点重建、
            //    改索引范围）都会把 STATE[key] 删掉或换掉。旧写法在 await 之后才写 STATE[key].bm，
            //    一旦中途被失效就抛 "Cannot set properties of undefined (setting 'bm')"（v3.73 修复）。
            var myState = {
                chunks: null, bm: null,
                srcRef: raw, srcLen: raw.length,
                list: s.async ? raw : null,
                indexed: prepared.length, rawTotal: raw.length
            };
            STATE[key] = myState;
            return chunkAllAsync(s, prepared, function (done, total) { report('chunk', done, total); }).then(function (chunks) {
                if (STATE[key] !== myState) {                  // 切块期间已被失效/替换 → 丢弃本次结果
                    if (big && typeof window !== 'undefined' && typeof window.finishProgress === 'function') window.finishProgress('索引构建已取消（数据已变更，下次检索会自动重建）');
                    return null;
                }
                myState.chunks = chunks;
                if (!chunks.length) return null;
                var BM = (typeof window !== 'undefined') ? window.LightBM25 : null;
                if (typeof BM !== 'function') return null;
                var docs = chunks.map(function (c) {
                    return { src: c.src, srcLabel: c.srcLabel, path: c.path, text: c.text, doc: c.doc, ref: c.ref, trade: c.trade, title: c.title, date: c.date, searchText: c.searchText };
                });
                var inst = new BM(docs, 1.2, 0.75, true);      // defer：不在构造里同步建
                return inst.buildAsync({
                    slice: 400,
                    onProgress: function (done, total) { report('index', done, total); }
                }).then(function () {
                    if (STATE[key] !== myState) {              // 建索引期间被失效/替换 → 丢弃（不把陈旧索引塞回去）
                        if (big && typeof window !== 'undefined' && typeof window.finishProgress === 'function') window.finishProgress('索引构建已取消（数据已变更，下次检索会自动重建）');
                        return null;
                    }
                    myState.bm = inst;
                    if (big && typeof window !== 'undefined' && typeof window.finishProgress === 'function') {
                        window.finishProgress('✅ 本地索引已就绪（' + s.label + '，' + chunks.length + ' 块）');
                    }
                });
            });
        }).catch(function (e) {
            // 单个源建索引失败不应中断其它源（重建面板按源报告）
            if (typeof console !== 'undefined') console.warn('[KB] 建立索引失败（' + s.label + '）：', e && e.message);
            throw e;      // 交给 rebuild 汇总，面板能显示"哪个源失败"
        });
    }

    function getBM(key) {
        var st = ensureSource(key);
        if (!st || !st.chunks.length) return null;
        if (!st.bm) {
            var BM = (typeof window !== 'undefined') ? window.LightBM25 : null;
            if (typeof BM !== 'function') return null;
            st.bm = new BM(st.chunks.map(function (c) {
                // 用 searchText 作检索字段，text 保持原样供提示词引用
                return { src: c.src, srcLabel: c.srcLabel, path: c.path, text: c.text, doc: c.doc, ref: c.ref, trade: c.trade, title: c.title, date: c.date, searchText: c.searchText };
            }));
        }
        return st.bm;
    }

    /**
     * 统一检索
     * @param query 用户问题
     * @param opts  { sources:['rules','issues',...] , topK:4 , perDoc:2 , recentMonth:false }
     * @returns [{ key, label, grain, total, hits:[{path,text,doc,...}] }]  —— 只含有命中的源
     */
    function search(query, opts) {
        opts = opts || {};
        var keys = (opts.sources && opts.sources.length) ? opts.sources : SOURCES.map(function (s) { return s.key; });
        var topK = opts.topK || 4;
        var perDoc = opts.perDoc || MAX_PER_DOC;
        var oneMonthAgo = Date.now() - 30 * 24 * 3600 * 1000;
        var results = [];
        keys.forEach(function (key) {
            var s = SRC_MAP[key];
            if (!s) return;
            var st = ensureSource(key);
            if (!st || !st.chunks.length) return;
            var bm = getBM(key);
            if (!bm) return;
            var raw = bm.search(query, Math.max(topK * 4, 12));
            var seen = new Map(), hits = [];
            for (var i = 0; i < raw.length && hits.length < topK; i++) {
                var h = raw[i];
                if (opts.recentMonth && key === 'issues') {
                    var t = h.date ? new Date(h.date).getTime() : 0;
                    if (t && t < oneMonthAgo) continue;        // 只看近一个月（与智能写作的既有口径一致）
                }
                var n = seen.get(h.doc) || 0;
                if (n >= perDoc) continue;
                seen.set(h.doc, n + 1);
                hits.push(h);
            }
            if (hits.length) results.push({ key: key, label: s.label, grain: s.grain, total: st.srcLen, chunks: st.chunks.length, hits: hits });
        });
        return results;
    }

    // 单源便捷检索（对规等只关心规章时用）
    function searchRules(query, topK) {
        var r = search(query, { sources: ['rules'], topK: topK || 4 });
        return r.length ? r[0].hits : [];
    }

    // 组装引用文本（带出处路径，每块完整内容；单源超预算则截断）
    function buildRefText(results, opts) {
        opts = opts || {};
        var budget = opts.budget || SRC_BUDGET;
        var out = '';
        (results || EMPTY).forEach(function (r) {
            var txt = '【' + r.label + '（数据 ' + r.total + ' 条 → 命中 ' + r.hits.length + ' 块，按' + r.grain + '定位）】\n';
            r.hits.forEach(function (h, i) {
                txt += (i + 1) + '. ' + h.path + '\n   ' + h.text + '\n';
            });
            if (txt.length > budget) txt = txt.slice(0, budget) + '\n（内容已截断）\n';
            out += txt + '\n';
        });
        return out;
    }

    // ==================== 维护接口 ====================

    function invalidate(key) {
        if (key && SRC_MAP[key]) { delete STATE[key]; return; }
        STATE = {};
    }

    function stats() {
        return SOURCES.map(function (s) {
            var st = STATE[s.key];
            var list = st ? (st.list || (s.async ? EMPTY : srcList(s))) : (s.async ? EMPTY : srcList(s));
            return {
                key: s.key,
                label: s.label,
                grain: s.grain,
                total: list.length,
                indexed: (st && typeof st.indexed === 'number') ? st.indexed : list.length,
                chunks: st && st.chunks ? st.chunks.length : 0,
                built: !!(st && st.chunks),
                async: !!s.async,
                // 异步源（资料库/历史报告在 IndexedDB）是否已取过数：没取过 ≠ 没数据，
                // 面板必须区分这两种状态，否则会误报"无数据"（v3.73 修）
                loaded: !s.async || !!(st && st.list)
            };
        });
    }

    // 一键重建（设置页按钮）：清空后逐源重建；每源之间让出一次事件循环，
    // 既让面板能刷进度，也避免一次性同步建索引把界面卡住（v3.15 的教训）。
    function rebuild(keys, onProgress) {
        invalidate();
        var list = (keys && keys.length) ? keys.slice() : SOURCES.map(function (s) { return s.key; });
        var i = 0;
        var failures = [];      // 单源失败不中断整体重建，最后汇总给面板显示
        function step() {
            if (i >= list.length) return Promise.resolve(failures);
            var key = list[i++];
            var s = SRC_MAP[key];
            if (!s) return step();
            // 统一走 ensure：async 源会先取数，所有源都用分片异步建索引（进度由 ensure 回调上报）
            return ensure([key], { onProgress: onProgress }).catch(function (e) {
                failures.push((SRC_MAP[key] ? SRC_MAP[key].label : key) + '：' + (e && e.message ? e.message : e));
            }).then(function () {
                return new Promise(function (r) { setTimeout(r, 0); });
            }).then(step);
        }
        return step();
    }

    // 设置页自测：直接返回"将会喂给模型的引用文本"（便于人工核对命中是否对得上）
    function testSearch(query, opts) {
        return buildRefText(search(query, opts || { topK: 3, sources: ['rules', 'issues', 'handbook', 'materials', 'reports'] }));
    }

    // ==================== 设置页「知识库」面板 ====================

    function panelRender(hint) {
        if (typeof document === 'undefined') return;
        var host = document.getElementById('kb-source-list');
        var sum = document.getElementById('kb-summary');
        if (!host) return;
        function paint(rows) {
            var totalItems = 0, totalChunks = 0, pending = 0;
            rows.forEach(function (r) { totalItems += r.total; totalChunks += r.chunks; if (!r.loaded) pending++; });
            if (sum) {
                sum.textContent = '共 ' + totalItems + ' 条数据 → ' + totalChunks + ' 块索引'
                    + (pending ? '（' + pending + ' 个源读取中…）' : '')
                    + (hint ? '（' + hint + '）' : '');
            }
            var scopeEl = document.getElementById('kb-issue-scope');
            if (scopeEl) {
                var lim = issueLimit();
                var iss = null;
                rows.forEach(function (r) { if (r.key === 'issues') iss = r; });
                scopeEl.textContent = (lim ? '最近 ' + lim + ' 条' : '全部')
                    + (iss && iss.chunks ? '（当前已索引 ' + iss.indexed + ' 条）' : '');
            }
            host.innerHTML = rows.map(function (r) {
                if (!r.loaded) return '<div>⏳ ' + r.label + '：读取中…（按' + r.grain + '切）</div>';
                var dot = r.chunks ? '🟢' : (r.total ? '⚪' : '⚫');
                var head = dot + ' ' + r.label + '：' + r.total + ' 条 / ' + r.chunks + ' 块，按' + r.grain + '切';
                var tail;
                if (r.chunks) tail = (r.indexed && r.total && r.indexed < r.total) ? '（已索引最近 ' + r.indexed + ' 条）' : '';
                else tail = r.total ? '（未建索引：首次检索该源时自动建，也可点「一键重建」）' : '（无数据）';
                return '<div>' + head + tail + '</div>';
            }).join('');
        }
        var rows = stats();
        paint(rows);
        // 异步源（资料库/历史报告）计数要先去 IndexedDB 取；取完再补一次真实数字
        var waiting = rows.filter(function (r) { return !r.loaded; }).map(function (r) { return r.key; });
        if (waiting.length) ensure(waiting).then(function () { paint(stats()); }).catch(function () {});
    }

    function panelRebuild() {
        if (typeof document === 'undefined') return;
        var sum = document.getElementById('kb-summary');
        var t0 = (typeof performance !== 'undefined') ? performance.now() : Date.now();
        if (sum) sum.textContent = '正在重建索引…';
        rebuild(null, function (key, done, total, phase) {
            var s = SRC_MAP[key];
            var label = s ? s.label : key;
            var what = phase === 'chunk' ? '切块' : '建索引';
            if (sum) sum.textContent = '正在重建：' + label + '（' + what + ' ' + done + '/' + total + '）';
        }).then(function (failures) {
            var ms = Math.round(((typeof performance !== 'undefined') ? performance.now() : Date.now()) - t0);
            var bad = failures && failures.length;
            // 构建期间若数据发生变更（导入/编辑/盯控写入），该源的本次构建会被取消 —— 提示用户再点一次即可
            var missing = stats().filter(function (r) { return r.total && !r.chunks; }).map(function (r) { return r.label; });
            panelRender(bad ? ('已重建，' + bad + ' 个源失败') : ('已重建，耗时 ' + ms + 'ms'));
            if (bad) {
                if (sum) sum.textContent = '重建完成，但 ' + bad + ' 个源失败：' + failures.join('；');
            } else if (missing.length) {
                if (sum) sum.textContent = '已重建，耗时 ' + ms + 'ms；以下源构建期间数据有变动，已自动取消，再点一次即可：' + missing.join('、');
            } else if (window.Toast && typeof window.Toast.success === 'function') {
                window.Toast.success('知识库索引已重建（' + ms + 'ms）');
            }
        }).catch(function (e) {
            if (sum) sum.textContent = '重建失败：' + (e && e.message ? e.message : e);
        });
    }

    // 检查信息索引范围（设置页按钮）：n=0 表示全部
    function setIssueLimit(n) {
        try { localStorage.setItem('kb_issue_limit', n ? String(n) : 'all'); } catch (e) {}
        invalidate('issues');
        if (typeof document !== 'undefined') {
            var sum = document.getElementById('kb-summary');
            if (sum) sum.textContent = '正在按新范围重建检查信息索引…';
        }
        return rebuild(['issues']).then(function () { panelRender('检查信息索引范围已更新'); });
    }

    function panelTest() {
        if (typeof document === 'undefined') return;
        var inp = document.getElementById('kb-test-input');
        var out = document.getElementById('kb-test-out');
        if (!inp || !out) return;
        var q = String(inp.value || '').trim();
        if (!q) { out.textContent = '请先输入一句检查问题或关键词'; return; }
        out.textContent = '检索中…';
        var t0 = (typeof performance !== 'undefined') ? performance.now() : Date.now();
        ensure(['materials', 'reports']).then(function () {
            var txt = testSearch(q, { topK: 3 });
            var ms = Math.round(((typeof performance !== 'undefined') ? performance.now() : Date.now()) - t0);
            out.textContent = txt ? (txt + '— 耗时 ' + ms + 'ms') : '未命中任何内容（' + ms + 'ms）';
        }).catch(function (e) { out.textContent = '检索失败：' + (e && e.message ? e.message : e); });
    }

    // 打开设置面板「数据」分区时刷新面板（自包含：不改 app.js 的设置面板逻辑）
    if (typeof document !== 'undefined') {
        document.addEventListener('click', function (e) {
            var t = e.target;
            if (!t || !t.closest) return;
            if (t.closest('.st-nav-item[data-sec="data"]')) setTimeout(function () { panelRender(); }, 0);
        });
        if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', function () { panelRender(); });
        else panelRender();
    }

    var KB = {
        CHUNK_MAX: CHUNK_MAX,
        SOURCES: SOURCES.map(function (s) { return { key: s.key, label: s.label, grain: s.grain, async: !!s.async }; }),
        stripTags: stripTags,
        splitLong: splitLong,
        splitParagraphs: splitParagraphs,
        chunkRules: chunkRules,
        chunkIssues: chunkIssues,
        chunkHandbook: chunkHandbook,
        chunkMaterials: chunkMaterials,
        chunkReports: chunkReports,
        chunkPhone: chunkPhone,
        chunkDiary: chunkDiary,
        ensure: ensure,
        search: search,
        searchRules: searchRules,
        buildRefText: buildRefText,
        stats: stats,
        invalidate: invalidate,
        rebuild: rebuild,
        testSearch: testSearch,
        panelRender: panelRender,
        panelRebuild: panelRebuild,
        panelTest: panelTest,
        setIssueLimit: setIssueLimit,
        getIssueLimit: issueLimit
    };
    window.KB = KB;
})();
