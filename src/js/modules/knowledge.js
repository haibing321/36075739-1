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
 * 覆盖的源（9 个；本段曾停留在"6 类 7 列表"的旧口径，2026-09-30 按实现更新）：
 *   rules     规章制度   window.getRulesData()      → 按「章/节/条」切（非案例类文档：pick=nonCaseDocs）
 *   cases     案例/汇编  window.getRulesData()      → 同上切法，但只取标题像案例汇编的文档
 *                        （CASE_DOC_RE 分流；与手册模块的 accidents 是**两个不同概念**的"案例"）
 *   issues    检查信息   window.getIssueData()      → 一条一记录（**windowed**：默认只索引最近 N 条）
 *   handbook  检查手册   window.getHandbookData()   → 一个项点一块（四级路径）
 *   accidents 事故案例   window.getAccidentData()   → 一个项点一块（与手册平行的第二份四级数据）
 *   materials 写作资料   _wrGetAllMaterials()       → 按段落切（**懒建**）
 *   reports   历史报告   _wrGetAllReports()         → 按段落切（**懒建**；指写作库的历史报告）
 *   phone     应急电话   window.getPhoneData()      → 一条一记录
 *   diary     工作日志   window.getDiaryData()      → 一天一块
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

    // 【2026-09-30 准确性修复】条号标记支持**多级条号**（如「第4.3.4条」）：
    //   原来只认 `第[数字/中文数字]+[章节条]`，多级条号整段落进上一块 ⇒ 粒度变粗、命中不精确。
    //   现在允许数字/中文数字之间夹小数点（最多 10 位），捕获组仍是 2 个（m[1]=行首、m[2]=标记）。
    var RE_MARK = /(^|\n)[ \t　]*(第[一二三四五六七八九十百千零〇0-9][一二三四五六七八九十百千零〇0-9.．]{0,9}[章节条])/g;

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

    // 【2026-09-30 准确性修复】标题/出处**加权**倍数：head（[专业]《规章名》/《资料名》）在检索文本里
    //   出现 1 + (HEAD_REPEAT-1) 次。动因来自真实召回基准（80 条"问题描述→引用规章"，Recall@10 仅 56.3%、
    //   MRR 0.326）：漏检几乎都是"正确的办法输给主题相近的另一份办法"——查询是上百字的问题描述
    //   （几十个 token），标题只贡献几个 token，被长查询稀释。重复 head 提高其 tf，等于给标题加权；
    //   纯加词、不改打分逻辑，可用 localStorage['kb_head_weight']=1 关掉（1~4）。
    var HEAD_REPEAT = (function () {
        try { var v = parseInt(localStorage.getItem('kb_head_weight'), 10); if (v >= 1 && v <= 4) return v; } catch (e) {}
        return 2;
    })();

    function makeChunk(src, srcLabel, path, text, doc, extra) {
        var t = String(text == null ? '' : text).trim();
        if (!t) return null;
        var c = {
            src: src,
            srcLabel: srcLabel,
            path: path,
            doc: doc                                     // 归属的原始记录（用于同文档限流）
        };
        // 出处也参与检索（与旧路径 title+content 一致）；head 按权重重复（见 HEAD_REPEAT 注释）
        var _head = (extra && extra.head) ? String(extra.head) : '';
        var _rep = (_head && HEAD_REPEAT > 1) ? new Array(HEAD_REPEAT).join(_head + '\n') : '';
        c.searchText = _rep + path + '\n' + t;
        // 【2026-09-22 省内存】text 不再单独复制一份：直接取 searchText 的切片 —— V8 对够长的 slice 生成
        //   SlicedString（只存父串引用 + 偏移，不复制字符），`c.text` 取值与原来完全一致。
        //   真数据规章 139385 块的量级下，这省掉的就是"同一段正文存两份"里的那一份。
        c.text = (t.length >= 13) ? c.searchText.slice(_rep.length + path.length + 1) : t;
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
                    var c = makeChunk('rules', '规章制度', pathOf(ref), piece, rule, { ref: ref, trade: trade, title: title, head: head });
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
    function chunkHandbook(hb) { return chunkFourLevel(hb, 'handbook', '检查手册'); }
    /**
     * 【2026-09-22】「事故案例」与「检查手册」同为四级目录数据（章/节/条/款），分块规则完全一致，
     *   只有源标识不同 —— 参数化后两者共用一套分块（一处改、两处生效）。
     */
    function chunkAccidents(list) { return chunkFourLevel(list, 'accidents', '事故案例'); }
    function chunkFourLevel(hb, srcKey, srcLabel) {
        var out = [];
        (hb || EMPTY).forEach(function (it) {
            var body = stripTags(it && it.content);
            if (!body) return;
            var parts = [it.chapter, it.section, it.item, it.subitem].filter(Boolean).map(function (x) { return String(x).trim(); });
            var path = parts.length ? parts.join(' > ') : srcLabel;
            splitLong(body, parts.length ? parts[parts.length - 1] : '').forEach(function (piece) {
                var c = makeChunk(srcKey, srcLabel, path, piece, it);
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
                var c = makeChunk('materials', '写作资料库', path, p, it, { matType: type, title: title, head: head });
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
                var c = makeChunk('reports', '历史报告', path, p, it, { date: date, title: title, head: head });
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
    // 【C2-a/v3.74】窗口外的老数据不再"沉默查不到"：检索时空命中或命中不足会**自动做一次全量兜底扫描**
    //   （实测 4 万条 15~45ms），并在提示词里如实标注"索引只覆盖最近 N 条"；置 `kb_fallback`='0' 可关。
    var ISSUE_LIMIT_DEFAULT = 12000;
    function issueLimit() {
        try {
            var v = localStorage.getItem('kb_issue_limit');
            if (v === 'all') return 0;
            var n = parseInt(v, 10);
            return isNaN(n) ? ISSUE_LIMIT_DEFAULT : n;
        } catch (e) { return ISSUE_LIMIT_DEFAULT; }
    }
    // 【启动优化 2026-09-18】排序键改为「先算一次、再比较」：
    //   原实现在比较器里调 `new Date(datetime).getTime()` —— 4 万条排序约 60 万次比较
    //   = 120 万次日期解析，实测占掉一次 300ms 级主线程长任务。现在每条只解析一次，
    //   且标准格式（'YYYY-MM-DD HH:mm:ss'）直接从字符串切片得到 YYYYMMDDHHMMSS，零 Date 开销。
    var _DT_RE = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?/;
    function _dtKey(v) {
        var s = (v == null) ? '' : String(v).trim();
        var m = _DT_RE.exec(s);
        if (m) return m[1] + m[2] + m[3] + (m[4] || '00') + (m[5] || '00') + (m[6] || '00');
        var t = new Date(s).getTime();
        if (isNaN(t)) return '00000000000000';
        var d = new Date(t), p = function (n) { return (n < 10 ? '0' : '') + n; };
        return '' + d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
    }
    function prepareIssues(list) {
        var lim = issueLimit();
        if (!lim || !list || list.length <= lim) return list;
        var keyed = new Array(list.length);
        for (var i = 0; i < list.length; i++) {
            keyed[i] = { it: list[i], k: _dtKey(list[i] && list[i].datetime) };
        }
        keyed.sort(function (a, b) { return b.k > a.k ? 1 : (b.k < a.k ? -1 : 0); });   // 新的在前
        var out = new Array(lim);
        for (var j = 0; j < lim; j++) out[j] = keyed[j].it;
        return out;
    }

    /**
     * 【2026-09-22 真实数据修复】案例/汇编类文档单独成源。
     *
     * 背景（阶段 0 召回基线实测，`scripts/kb-recall-bench.js`）：用 43585 条真实检查信息里
     *   "它引用的规章"做 ground truth，对规主链路 Recall@10 只有 48.8%；归因发现
     *   **《全路事故案例（2006-2025）》这类汇编文档满是现场描述词**（"检查""未按规定""防护网"…），
     *   在"规章制度"源里天然抢走真条款的候选位 —— 实测它抢到第 1 位 20%、进前 5 达 47%。
     *   它们**不是"办法条款"**，不该参与"这条违规违反了哪个条款"的召回。
     * 处理：按标题把它们拆到独立源 `cases`（对规只查 rules → 自然不受挤占；对话/写作可按需加入）。
     *   判据只看标题（正文里"案例"两字太常见）；紧口径实测只命中 2 篇 / 66 万字（真规章一篇不动）。
     */
    var CASE_DOC_RE = /事故案例|典型案例|案例汇编|案例集|案例选编|案例库|法律法规.*汇编|规范性文件汇编/;
    function isCaseDoc(r) { return CASE_DOC_RE.test(String((r && r.title) || '')); }
    function nonCaseDocs(arr) { return (arr || EMPTY).filter(function (r) { return !isCaseDoc(r); }); }
    function onlyCaseDocs(arr) { return (arr || EMPTY).filter(isCaseDoc); }

    // loader 返回 { list, async } ：sync 源就地取数；async 源由 KB.ensure() 预载
    var SOURCES = [
        { key: 'rules', label: '规章制度', grain: '条款', accessor: 'getRulesData', pick: nonCaseDocs, chunk: chunkRules },
        // 【2026-09-30 用户反馈"案例/汇编是啥，是否和事故案例重了"】标签改清楚：
        //   本源 = **规章制度库里标题像"汇编"的文档**（判据见 CASE_DOC_RE：事故案例/典型案例/案例汇编/案例集/
        //   案例选编/案例库/法律法规XX汇编/规范性文件汇编），与「事故案例」源**完全是两回事**：
        //     · 本源：来源=规章制度库，导入入口=规章导入，按「章/节/条」切，用户实测本地命中 1 篇
        //       《铁路运输安全生产法律法规及规范性文件汇编》；
        //     · 事故案例源（key=accidents）：来源=检查手册模块的**平行四级数据**，导入入口=设置→检查手册/事故案例，
        //       按「章/节/项点」切，本地是《全路事故案例（2006-2025）》。
        //   拆源的目的（2026-09-22）：汇编类文档满是现场描述词，在"规章制度"源里会抢走真条款的候选位
        //   （实测抢第 1 位 20%、进前 5 达 47%），对规只查 rules ⇒ 天然不受挤占。
        { key: 'cases', label: '汇编文档（法规/案例汇编）', grain: '条款', accessor: 'getRulesData', pick: onlyCaseDocs, chunk: chunkRules },
        { key: 'issues', label: '检查信息', grain: '条', accessor: 'getIssueData', chunk: chunkIssues, prepare: prepareIssues },
        { key: 'handbook', label: '检查手册', grain: '项点', accessor: 'getHandbookData', chunk: chunkHandbook },
        { key: 'accidents', label: '事故案例', grain: '项点', accessor: 'getAccidentData', chunk: chunkAccidents },   // 【2026-09-22】与手册平行的第二份四级目录数据
        { key: 'materials', label: '写作资料库', grain: '段落', async: true, loader: '_wrGetAllMaterials', chunk: chunkMaterials },
        { key: 'reports', label: '历史报告', grain: '段落', async: true, loader: '_wrGetAllReports', chunk: chunkReports },
        { key: 'phone', label: '应急电话', grain: '条', accessor: 'getPhoneData', chunk: chunkPhone },
        { key: 'diary', label: '工作日志', grain: '天', accessor: 'getDiaryData', chunk: chunkDiary }
    ];
    var SRC_MAP = {};
    SOURCES.forEach(function (s) { SRC_MAP[s.key] = s; });

    // 每源状态：{ chunks, bm, srcRef, srcLen, list, loading }
    var STATE = {};

    // 【2026-10-08 P0 性能修复 —— "一发消息就卡"的元凶】pick 结果**按 key 记忆化**。
    //   背景：`rules` / `cases` 两个源共用同一个 accessor（getRulesData），各带一个 pick
    //   （nonCaseDocs / onlyCaseDocs，见 368-369 行）。旧实现每次 srcList() 都执行
    //   `arr = s.pick(arr)` ⇒ **每次返回新数组** ⇒ ensureSource 的兜底指纹 `cur === st.srcRef`
    //   **恒为 false** ⇒ 每次都 `invalidate` ⇒ **整库重新切块 + 重建 BM25 倒排**。
    //   真机后果：每发一条消息，规章制度库（几十万字）要重切 **4~6 次**（ensure 1 + search 1 +
    //   getBM 1，rules/cases 各算），且 IndexedDB 索引缓存对这两个源**永远命中不了**
    //   （刚写回又被判失效）—— 这是首字延迟与操作卡顿的最大单点。
    //   修法：以"原始数组引用未变"为条件复用上一次的 pick 结果 ⇒ 引用稳定 ⇒ 指纹有效 ⇒ 只在
    //   数据真正变化时重建。失效由 invalidate(key) 负责（见下方维护接口，已同步清理本缓存）。
    var _pickCache = {};      // key -> { raw: 原始数组, arr: pick 结果 }

    function srcList(s) {
        if (s.async) return STATE[s.key] && STATE[s.key].list || EMPTY;
        if (typeof window === 'undefined') return EMPTY;
        var fn = window[s.accessor];
        if (typeof fn !== 'function') return EMPTY;
        try {
            var arr = fn() || EMPTY;
            // 【2026-09-22】同一份原始数据的子集切分（如 rules / cases 共用 getRulesData）
            if (s.pick) {
                var pc = _pickCache[s.key];
                if (pc && pc.raw === arr) return pc.arr;      // 原始数组引用未变 ⇒ 复用（引用稳定）
                var picked = s.pick(arr);
                _pickCache[s.key] = { raw: arr, arr: picked };
                return picked;
            }
            return arr;
        } catch (e) { return EMPTY; }
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

    // ==================== 索引持久化（v3.74）====================
    // 索引只存在内存里 → 重启/刷新即清空，首次检索要重建（大源 1–3 秒，用户可感）。
    // 这里把「切块结果 + BM25 索引」缓存到 IndexedDB，启动后命中缓存就直接恢复。
    // 有效性的唯一判据是**数据指纹**（sourceSig）：数据变了指纹就变 → 视为失效并重建。
    // ⚠️ 序列化格式与 LightBM25 内部实现绑定：改动分词/倒排/打分必须提升 KB_INDEX_VER。
    var CACHE_DB = 'RailwayKBCache_v1';
    var CACHE_STORE = 'kb_index';
    var KB_INDEX_VER = 2;   // 【2026-09-30】1 → 2：分块检索文本（标题加权 head 重复）与分词（NFKC/条号归一）都变了，
                            //   必须升版本 ⇒ 旧格式缓存一律作废、按新规则重建（否则设备会恢复旧索引、改动永不生效）
    var KB_CACHE_MAX_ITEMS = 50000;      // 超过此条数不做缓存（避免几十 MB 的写入与配额风险）
    var _lastCacheErr = '';              // 最近一次缓存写入失败原因（面板展示，便于诊断）
    var _cacheDbp = null;

    function cacheDB() {
        if (typeof indexedDB === 'undefined') return Promise.reject(new Error('IndexedDB 不可用'));
        if (_cacheDbp) return _cacheDbp;
        _cacheDbp = new Promise(function (resolve, reject) {
            var req = indexedDB.open(CACHE_DB, 1);
            req.onupgradeneeded = function () {
                var db = req.result;
                if (!db.objectStoreNames.contains(CACHE_STORE)) db.createObjectStore(CACHE_STORE);
            };
            req.onsuccess = function () { resolve(req.result); };
            req.onerror = function () { _cacheDbp = null; reject(req.error || new Error('打开缓存库失败')); };
        });
        return _cacheDbp;
    }

    function cacheTx(mode, fn) {
        return cacheDB().then(function (db) {
            return new Promise(function (resolve, reject) {
                var tx = db.transaction(CACHE_STORE, mode);
                var store = tx.objectStore(CACHE_STORE);
                var out = fn(store);
                tx.oncomplete = function () { resolve(out && out.result !== undefined ? out.result : out); };
                tx.onerror = function () { reject(tx.error || new Error('缓存事务失败')); };
                tx.onabort = function () { reject(tx.error || new Error('缓存事务中止')); };
            });
        });
    }
    function cacheGet(key) { return cacheTx('readonly', function (s) { return s.get(key); }); }
    function cachePut(key, rec) { return cacheTx('readwrite', function (s) { s.put(rec, key); return null; }); }
    function cacheDel(key) { return cacheTx('readwrite', function (s) { s.delete(key); return null; }); }
    function cacheClear() { return cacheTx('readwrite', function (s) { s.clear(); return null; }); }

    // ==================== 【2026-09-21】惰性 df 缓存（跨会话复用）====================
    //   背景：退化（scan+lazy）模式里"每个新查询词都要扫一遍全库算 df"是检索耗时的主要来源
    //   （真数据实测：短查询 114~175ms；长句查询 550~950ms，因为词多且互不重复）。
    //   把"查过的词 → df"持久化后，下次打开同一个库时这些词直接命中缓存，二次检索回到百毫秒内。
    var _dfDirty = {}, _dfTimer = null, _DF_CACHE_MAX = 4000;
    /** 便宜的指纹（只取块数/平均长度/首尾块片段，不遍历全部块）：数据一变就不复用缓存 */
    function dfSigOf(prepared, bm) {
        var n = prepared ? prepared.length : 0;
        var first = n ? String(prepared[0] && prepared[0].content || '').slice(0, 24) : '';
        var last = n ? String(prepared[n - 1] && prepared[n - 1].content || '').slice(-24) : '';
        return n + ':' + Math.round((bm && bm.avgLen) || 0) + ':' + first + ':' + last;
    }
    /** 建完索引即尝试恢复 df 缓存（只有惰性 df 模式的源需要；指纹不符则丢弃） */
    function attachDfCache(key, st, prepared) {
        try {
            if (!st || !st.bm || !st.bm._lazyDf) return;
            st.dfSig = dfSigOf(prepared, st.bm);
            var sig = st.dfSig;
            cacheGet('dfcache:' + key).then(function (rec) {
                if (!rec || !rec.df) return;
                if (rec.sig !== sig) { cacheDel('dfcache:' + key).catch(function () {}); return; }
                var n = st.bm.importDfCache(rec.df, _DF_CACHE_MAX);
                if (n && typeof console !== 'undefined') console.log('[KB] 惰性 df 缓存命中：' + key + ' 复用 ' + n + ' 个词');
            }).catch(function () {});
        } catch (e) {}
    }
    function scheduleDfFlush() {
        if (_dfTimer) return;
        _dfTimer = setTimeout(function () { _dfTimer = null; flushDfCache(); }, 1500);
    }
    /** 回写 df 缓存（节流调用 + pagehide 兜底；不阻塞检索） */
    function flushDfCache() {
        Object.keys(_dfDirty).forEach(function (key) {
            delete _dfDirty[key];
            var st = STATE[key];
            if (!st || !st.bm || !st.bm._lazyDf || !st.dfSig) return;
            var df = null;
            try { df = st.bm.exportDfCache(); } catch (e) { df = null; }
            if (!df) return;
            cachePut('dfcache:' + key, { sig: st.dfSig, df: df, at: Date.now() }).catch(function () {});
        });
    }
    try { if (typeof window !== 'undefined') window.addEventListener('pagehide', function () { try { flushDfCache(); } catch (e) {} }); } catch (e) {}

    // 数据指纹：条数 + 每条的位置/正文长度/正文首尾片段/关键字段（改一条正文也会变）
    function sourceSig(items) {
        var h = 2166136261;
        function mix(str) {
            for (var i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = (h * 16777619) >>> 0; }
        }
        for (var i = 0; i < items.length; i++) {
            var it = items[i] || {};
            var c = String(it.content == null ? '' : it.content);
            mix(String(i)); mix(String(c.length)); mix(c.slice(0, 24)); mix(c.slice(-24));
            // 【2026-09-30 准确性修复】补**中段抽样**：原来只取首尾 24 字，一份文档若"中段被等长改写"
            //   （长度不变、首尾不变）指纹不变 ⇒ 缓存里可能恢复出旧索引。加一段中段抽样，成本仍与条数线性。
            var _mid = (c.length >> 1);
            mix(c.slice(Math.max(0, _mid - 12), _mid + 12));
            mix(String(it.title || '') + String(it.datetime || '') + String(it['性质'] || '') + String(it.category || '') + String(it.trade || '') + String(it.fileNumber || ''));
        }
        return items.length + ':' + (h >>> 0).toString(36);
    }

    // 切块 → 可持久化形式：doc 换成在 prepared 中的下标（恢复时挂回**同一个对象引用**），
    // searchText 由 path+text 现算，不存。
    function packChunks(chunks, prepared) {
        var idxOf = new Map();
        for (var i = 0; i < prepared.length; i++) idxOf.set(prepared[i], i);
        return chunks.map(function (c) {
            var o = {};
            for (var k in c) { if (c.hasOwnProperty(k) && k !== 'doc' && k !== 'searchText') o[k] = c[k]; }
            var d = idxOf.get(c.doc);
            o.d = (typeof d === 'number') ? d : -1;
            return o;
        });
    }
    function unpackChunks(packed, prepared) {
        return (packed || []).map(function (o) {
            var c = {};
            for (var k in o) { if (o.hasOwnProperty(k) && k !== 'd') c[k] = o[k]; }
            c.doc = (o.d >= 0 && o.d < prepared.length) ? prepared[o.d] : null;
            c.searchText = String(c.path == null ? '' : c.path) + '\n' + String(c.text == null ? '' : c.text);
            return c;
        });
    }
    // 切块 → BM25 文档（检索字段用 searchText，text 保持原样供提示词引用）
    function bmDocsOf(chunks) {
        return chunks.map(function (c) {
            return { src: c.src, srcLabel: c.srcLabel, path: c.path, text: c.text, doc: c.doc, ref: c.ref, trade: c.trade, title: c.title, date: c.date, searchText: c.searchText };
        });
    }

    // 统一「预载 + 建索引」（v3.73）：
    //   · async 源（资料库/历史报告在 IndexedDB）先取数
    //   · 所有源都用**分片异步**建索引（大语料不冻结界面），超过 250ms 的用全局进度条提示
    //   · 【v3.74】建好后缓存到 IndexedDB；下次启动先尝试缓存恢复（force 时跳过恢复）
    // 消费方约定：检索前先 await KB.ensure(要用的源)，之后 KB.search 就是纯内存毫秒级操作。
    function ensure(sources, opts) {
        opts = opts || {};
        var keys = (sources && sources.length) ? sources : SOURCES.map(function (s) { return s.key; });
        var onProgress = opts.onProgress;
        // countOnly（v3.74）：只把 async 源的数据取进内存（供面板显示条数），**不切块、不建索引**。
        // 设置页「刷新」原先走全量 ensure → 打开面板就会把写作资料库/历史报告 6000+ 块索引静默建起来，
        // 表现为"其余源都是 ⚪、只有这两个 🟢"，既误导用户又白吃内存。
        var countOnly = !!opts.countOnly;
        // force（v3.74）：「一键重建」用 —— 跳过"从缓存恢复"，强制重新切块建索引（建完覆盖缓存）
        var force = !!opts.force;
        // restoreOnly（v3.74）：启动后台自动载入用 —— 只尝试"从缓存恢复"，**绝不触发重建**
        // （数据变过就保持未载入，留给首次检索按需重建，避免开机就白跑几秒 CPU）
        var restoreOnly = !!opts.restoreOnly;
        return Promise.all(keys.map(function (key) { return ensureOne(key, onProgress, countOnly, force, restoreOnly); }));
    }

    // 【v3.75】并发去重：同一时刻对同一个源只允许一份在途工作。
    //   典型撞车场景：开机 autoLoadCaches() 正在"恢复索引"（大源要读几十 MB 缓存、解包、importIndex），
    //   用户此时点发送又调 ensure() → 旧实现会**把同一份活完整干两遍**，首次发送的等待被拉长近一倍。
    //   复用规则（安全约束，勿简化）：
    //     ① 新请求是 restoreOnly（开机自动载入）→ 可复用任何在途请求；
    //     ② 新请求是"恢复 + 按需建立"（检索/发送）→ **只能**复用在途的同样完整请求，
    //        绝不复用 restoreOnly（否则会拿到"只尝试恢复、可能什么都没建"的结果，检索会静默少一个源）。
    //   force（一键重建）/countOnly（只统计条数）语义不同，一律不参与复用。
    var _inflight = {};
    function ensureOne(key, onProgress, countOnly, force, restoreOnly) {
        var s = SRC_MAP[key];
        if (!s) return Promise.resolve();
        var rec = _inflight[key];
        if (rec && !force && !countOnly) {
            // ① 弱请求（仅恢复）可复用任何在途请求；② 强请求（确保就绪）可复用同为强请求的在途请求。
            if (restoreOnly || !rec.restoreOnly) return rec.p;
            // ③ 在途是"仅恢复"、本次要求"确保就绪" → **先等它结束，再完整跑一遍**：
            //     既不会重复读几十 MB 缓存（两个请求各读一遍），也不会像"直接复用"那样缺源
            //     —— 因为结束后若已恢复，第二遍会命中"数据未变、索引已在"而近乎零成本；
            //     若没恢复（无缓存/数据变了），第二遍才真正建立。
            return rec.p.then(
                function () { return _startEnsureOne(key, onProgress, countOnly, force, restoreOnly); },
                function () { return _startEnsureOne(key, onProgress, countOnly, force, restoreOnly); }
            );
        }
        return _startEnsureOne(key, onProgress, countOnly, force, restoreOnly);
    }
    function _startEnsureOne(key, onProgress, countOnly, force, restoreOnly) {
        var p = _ensureOneInner(key, onProgress, countOnly, force, restoreOnly);
        if (!countOnly && !force) {
            var ent = { p: p, restoreOnly: !!restoreOnly };
            _inflight[key] = ent;
            var _clear = function () { if (_inflight[key] === ent) delete _inflight[key]; };
            p.then(_clear, _clear);
        }
        return p;
    }

    function _ensureOneInner(key, onProgress, countOnly, force, restoreOnly) {
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
            if (countOnly) return null;                    // 面板只要条数：取到 list 就够，索引留给首次检索（懒建）
            var raw = s.async ? ((STATE[key] && STATE[key].list) || EMPTY) : srcList(s);
            var st = STATE[key];
            // 数据未变且索引已在 → 直接复用
            if (st && st.chunks && st.bm && st.srcRef === raw && st.srcLen === raw.length) return null;
            var prepared = s.prepare ? s.prepare(raw) : raw;
            var startedAt = Date.now();
            var big = prepared.length >= 2000;
            // 缓存相关（v3.74）：指纹用于判缓存有效性；超量源不缓存，避免几十 MB 写入与配额风险
            var _BM = (typeof window !== 'undefined') ? window.LightBM25 : null;
            var _canWrite = !!(_BM && _BM.prototype && typeof _BM.prototype.exportIndex === 'function');
            var _canRead = !!(_BM && typeof _BM.importIndex === 'function');
            var _cacheable = prepared.length > 0 && prepared.length <= KB_CACHE_MAX_ITEMS && _canWrite;
            var _sig = _cacheable ? sourceSig(prepared) : '';
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
            // —— a) 先尝试「本机缓存恢复」（v3.74）——
            //   仅当：未强制重建 + 源可缓存 + 缓存版本与数据指纹都对得上。恢复期间同样要防失效。
            var restore = (!force && _cacheable && _canRead)
                ? cacheGet(key).then(function (rec) {
                    if (!rec || rec.ver !== KB_INDEX_VER || rec.sig !== _sig || !rec.chunks || !rec.bm) return false;
                    if (STATE[key] !== myState) return true;                 // 期间已被失效 → 放弃恢复
                    var chunks = unpackChunks(rec.chunks, prepared);
                    if (!chunks.length || chunks.length !== rec.chunks.length) return false;
                    if (rec.bm.mode === 'postings' && rec.bm.docLen && rec.bm.docLen.length !== chunks.length) return false;
                    myState.chunks = chunks;
                    myState.bm = _BM.importIndex(rec.bm, bmDocsOf(chunks));
                    myState.restored = true;
                    attachDfCache(key, myState, prepared);   // 惰性 df 模式：把上次会话查过的词接回来
                    // ⚠️ startedAt 是 Date.now()（墙钟），这里也必须用 Date.now() 相减，
                    //    别混用 performance.now()（单调钟，起点是页面导航）→ 会算出负数。
                    if (typeof console !== 'undefined') console.log('[KB] 已从本机缓存恢复索引：' + s.label + '（' + chunks.length + ' 块，'
                        + Math.max(0, Date.now() - startedAt) + 'ms）');
                    return true;
                }).catch(function () { return false; })
                : Promise.resolve(false);

            return restore.then(function (restored) {
                if (restored) return null;
                if (restoreOnly) {                            // 只恢复不重建：没有可用缓存就直接返回
                    if (STATE[key] === myState && !myState.chunks) { delete STATE[key]; }   // 不留"空壳状态"，面板显示才准确
                    return null;
                }
                if (STATE[key] !== myState) return null;      // 等缓存期间已被失效 → 交给新的持有者
                return chunkAllAsync(s, prepared, function (done, total) { report('chunk', done, total); }).then(function (chunks) {
                    if (STATE[key] !== myState) {                  // 切块期间已被失效/替换 → 丢弃本次结果
                        if (big && typeof window !== 'undefined' && typeof window.finishProgress === 'function') window.finishProgress('索引构建已取消（数据已变更，下次检索会自动重建）');
                        return null;
                    }
                    myState.chunks = chunks;
                    if (!chunks.length) return null;
                    var inst = new _BM(bmDocsOf(chunks), 1.2, 0.75, true);   // defer：不在构造里同步建
                    return inst.buildAsync({
                        slice: 400,
                        onProgress: function (done, total) { report('index', done, total); }
                    }).then(function () {
                        if (STATE[key] !== myState) {              // 建索引期间被失效/替换 → 丢弃（不把陈旧索引塞回去）
                            if (big && typeof window !== 'undefined' && typeof window.finishProgress === 'function') window.finishProgress('索引构建已取消（数据已变更，下次检索会自动重建）');
                            return null;
                        }
                        myState.bm = inst;
                        attachDfCache(key, myState, prepared);   // 惰性 df 模式：把上次会话查过的词接回来
                        // —— b) 建好即缓存到本机。——
                        // ⚠️ 必须**等写完**再报"就绪"：大源（1.2 万条 ≈ 7MB）序列化 + 落盘要一段时间，
                        //    原先"发射后不管"会让用户看到"已重建"就立刻重启 → 缓存还没写完 → 索引看似没保留。
                        var _writeP = Promise.resolve();
                        if (_cacheable && typeof inst.exportIndex === 'function') {
                            if (big && typeof window !== 'undefined' && typeof window.showProgress === 'function') {
                                window.showProgress(96, '正在写入本机缓存（重启后免重建）：' + s.label);
                            }
                            try {
                                _writeP = cachePut(key, { ver: KB_INDEX_VER, sig: _sig, at: Date.now(), chunks: packChunks(chunks, prepared), bm: inst.exportIndex() })
                                    .then(function () { _lastCacheErr = ''; })
                                    .catch(function (e) {                     // 配额不足等 → 不影响本次使用，但记下来供面板提示
                                        _lastCacheErr = (e && e.name ? e.name + '：' : '') + ((e && e.message) || '写入失败');
                                        if (typeof console !== 'undefined') console.warn('[KB] 索引缓存写入失败：', _lastCacheErr);
                                    });
                            } catch (e2) { /* 忽略 */ }
                        }
                        return _writeP.then(function () {
                            if (STATE[key] !== myState) return null;      // 写缓存期间被失效 → 不报"就绪"
                            // 诊断日志（v3.75）：把"恢复了多少/建了多久"写进控制台，排查"每次都要重新准备"时一眼可见
                            if (typeof console !== 'undefined') console.log('[KB] 本地索引已建立：' + s.label + '（' + chunks.length + ' 块'
                                + (_cacheable ? '，已写入本机缓存' : '，未缓存') + '，'
                                + Math.max(0, Date.now() - startedAt) + 'ms）');
                            if (big && typeof window !== 'undefined' && typeof window.finishProgress === 'function') {
                                window.finishProgress('✅ 本地索引已就绪（' + s.label + '，' + chunks.length + ' 块'
                                    + (_cacheable ? '，已缓存到本机' : '') + '）');
                            }
                        });
                    });
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
            st.bm = new BM(bmDocsOf(st.chunks));   // 检索字段用 searchText，text 保持原样供提示词引用
        }
        return st.bm;
    }

    /**
     * 统一检索
     * @param query 用户问题
     * @param opts  { sources:['rules','issues',...] , topK:4 , perDoc:2 , recentMonth:false }
     * @returns [{ key, label, grain, total, hits:[{path,text,doc,...}] }]  —— 只含有命中的源
     */
    // ==================== 【2026-09-30 准确性修复】同义词/术语表（KB 层公共能力）====================
    // 原来这张表只存在于「智能对规」（smart-check.js），对话 / 写作 / 智能体走 KB 时完全是字面滑窗
    // ⇒ 口语化表达（"没挂地线" vs "接地线"、"未设置" vs "未设/缺少"）跨源召回吃亏。
    // 现在以 KB 为**单一来源**：smart-check 若发现 window.KB.SYNONYM_MAP 就直接复用（见其注释）。
    // 关掉扩展：localStorage['kb_synonym'] = '0'（对照/排障用）。扩展只**追加**同义词、不改原查询。
    var SYNONYM_MAP = {
        '天窗': ['封闭时间', '施工时间', '施工窗口'],
        '防护': ['防护员', '安全防护', '设防护', '防护措施'],
        '上道': ['上轨道', '进入线路', '进线作业', '上线路'],
        '违规': ['违章', '违反规定', '不符合规定', '不按规定', '违章作业', '违章行为'],
        '超限': ['超出限界', '限界超限'],
        '信号机': ['信号灯', '信号设备'],
        '道岔': ['转辙器', '岔道'],
        '行车': ['行驶', '运行', '列车运行'],
        '防溜': ['防止溜逸', '止溜', '防溜措施'],
        '闭塞': ['闭塞区间', '区间闭塞'],
        '限速': ['限制速度', '降速'],
        '接触网': ['供电线路', '架空线'],
        '作业人员': ['工作人员', '施工人员', '作业者', '现场人员'],
        '检查': ['巡查', '巡检', '查看', '核查'],
        '列车': ['火车', '机车', '车列'],
        '铁路': ['铁道', '轨道线路'],
        '违章': ['违规', '违反规定', '违章作业'],
        '未设置': ['未设', '未配备', '未安装', '缺少'],
        '擅自': ['未经允许', '未经批准', '私自', '未经许可'],
        '未确认': ['未核实', '未检查', '未核对'],
        '制动': ['刹车', '制动系统'],
        '瞭望': ['观察', '了望', '眺望'],
        '调车': ['编组调车', '调车作业'],
        '施工': ['施工作业', '维修作业', '作业施工'],
        '封锁': ['线路封锁', '区间封锁', '施工封锁'],
        '命令': ['调度命令', '行车命令', '作业命令'],
        '进路': ['行车进路', '列车进路'],
        '联控': ['车机联控', '呼唤应答']
    };

    function search(query, opts) {
        opts = opts || {};
        // 【2026-09-30】KB 层同义词扩展（默认开，见上方注释）：把命中的同义词追加到查询尾部。
        //   追加而非替换 —— 原查询的字面信号完全保留，只多给几个"同义表达"的机会。
        var q = String(query == null ? '' : query);
        try {
            if (localStorage.getItem('kb_synonym') !== '0') {
                var _added = [];
                Object.keys(SYNONYM_MAP).forEach(function (key) {
                    if (q.indexOf(key) === -1) return;
                    (SYNONYM_MAP[key] || []).forEach(function (syn) {
                        if (q.indexOf(syn) === -1 && _added.indexOf(syn) === -1) _added.push(syn);
                    });
                });
                if (_added.length) q = q + ' ' + _added.slice(0, 12).join(' ');
            }
        } catch (e) {}
        var keys = (opts.sources && opts.sources.length) ? opts.sources : SOURCES.map(function (s) { return s.key; });
        var topK = opts.topK || 4;
        var topKByKey = opts.topKByKey || null;      // 【C1】按源分档 topK（如"仅文风参考"的资料库/历史报告给 2）
        var perDoc = opts.perDoc || MAX_PER_DOC;
        var oneMonthAgo = Date.now() - 30 * 24 * 3600 * 1000;
        // 【C2-a】窗口外老数据的全量兜底：默认开，置 localStorage `kb_fallback`='0' 可关（应急/对照用）
        var fbOn = opts.fallbackScan !== false;
        if (fbOn) { try { fbOn = localStorage.getItem('kb_fallback') !== '0'; } catch (e) {} }
        var results = [];
        keys.forEach(function (key) {
            var s = SRC_MAP[key];
            if (!s) return;
            var st = ensureSource(key);
            if (!st || !st.chunks.length) return;
            var k = Math.max(1, (topKByKey && topKByKey[key]) || topK);
            var bm = getBM(key);
            if (!bm) return;
            var raw = bm.search(q, Math.max(k * 4, 12));   // 用扩展后的查询（见 search 开头）
            var seen = new Map(), hits = [];
            for (var i = 0; i < raw.length && hits.length < k; i++) {
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
            // 该源索引是否只覆盖了部分数据（窗口）→ 供上限提示与兜底判断
            var windowed = !!(st.indexed && st.rawTotal > st.indexed);
            var fb = false;
            // 【C2-a】窗口外老数据兜底：**始终扫描**（实测 4 万条 5~50ms，代价可忽略），
            //   因为"只在空命中时兜底"几乎不会触发 —— BM25 对外窗口外的老数据总有模糊命中，
            //   hits 非空 → 老数据照样查不到（实测仍 0/30）。并入策略：
            //   ① BM25 无命中 → 直接用兜底结果；
            //   ② topK 未填满 → 用兜底补足；
            //   ③ 兜底命中"强证据"（≥3 个查询词命中）时，额外最多并入 2 条（不挤掉已有命中）。
            if (fbOn && windowed && !s.async && s.prepare && typeof s.chunk === 'function') {
                var fh = fallbackScan(key, query, Math.max(k * 4, 12));
                if (fh && fh.length) {
                    if (!hits.length) {
                        hits = fh.slice(0, k);
                        fb = true;
                    } else {
                        var merged = hits.slice(0, k);
                        var extra = (merged.length < k) ? (k - merged.length) : 0;
                        var added = 0;
                        for (var x = 0; x < fh.length && (added < extra || (added < extra + 2 && fh[x].fbScore >= 3)); x++) {
                            var cand = fh[x];
                            if (cand.fbScore < 3 && added >= extra) break;
                            var dup = false;
                            for (var y = 0; y < merged.length; y++) {
                                if (merged[y] === cand || (merged[y].doc && merged[y].doc === cand.doc)) { dup = true; break; }
                            }
                            if (dup) continue;
                            merged.push(cand); added++; fb = true;
                        }
                        hits = merged;
                    }
                }
            }
            // 【P2 低分块前移过滤】把"明显不相关"的命中块在**注入前**丢掉，而不是交给模型去忽略。
            //   为什么必要：topK 是"最多取 k 块"，不是"取 k 块相关的" —— 问题与语料弱相关时，
            //   BM25 仍会凑满 k 块并全部塞进提示词，既占预算又干扰模型（实测表现为"硬扯上无关条款"）。
            //   做法：按**源内相对阈值**过滤（跨源分数不可比 —— 各源独立 idf，见文件头注释）；
            //   兜底扫描命中（fbScore，命中查询词个数）另用绝对门槛，且不与 BM25 分数混算。
            //   永远保留最佳命中（fail-open），避免"全被过滤 → 明明有资料却像查不到"。
            var _droppedLow = 0;
            try {
                var _ratio = 0.25;
                try {
                    var _rv = localStorage.getItem('kb_min_score_ratio');
                    if (_rv !== null) { var _rn = parseFloat(_rv); if (!isNaN(_rn) && _rn >= 0 && _rn <= 1) _ratio = _rn; }
                } catch (e) {}
                if (_ratio > 0 && hits.length > 1) {
                    var _bmH = [], _fbH = [];
                    hits.forEach(function (h) {
                        if (h && h.score == null && h.fbScore != null) _fbH.push(h); else _bmH.push(h);
                    });
                    var _kept = _bmH;
                    if (_bmH.length > 1) {
                        var _top = 0;
                        _bmH.forEach(function (h) { var sc = (h && h.score) || 0; if (sc > _top) _top = sc; });
                        if (_top > 0) {
                            var _floor = _top * _ratio;
                            var _f = _bmH.filter(function (h) { return ((h && h.score) || 0) >= _floor; });
                            if (!_f.length) _f = [_bmH[0]];
                            _droppedLow += (_bmH.length - _f.length);
                            _kept = _f;
                        }
                    }
                    // 窗口外兜底命中：至少命中 2 个查询词才算有效证据（其证据强度由既有逻辑保证 ≥3 才会额外并入）
                    var _fbKept = _fbH.filter(function (h) { return (h && h.fbScore || 0) >= 2; });
                    if (!_fbKept.length && _fbH.length) _fbKept = [_fbH[0]];
                    _droppedLow += (_fbH.length - _fbKept.length);
                    hits = _kept.concat(_fbKept);
                }
            } catch (e) { /* 过滤失败则保持原样（fail-open） */ }
            if (hits.length) {
                results.push({
                    key: key, label: s.label, grain: s.grain,
                    total: st.srcLen, chunks: st.chunks.length,
                    indexed: st.indexed || 0, windowed: windowed, fallback: fb,
                    droppedLow: _droppedLow,
                    hits: hits
                });
            }
        });
        // 【2026-09-21】本轮检索里惰性 df 模式的源可能新算了若干词组 → 标记回写（节流 1.5s，不阻塞检索）
        try {
            var _dirty = false;
            keys.forEach(function (key) {
                var st = STATE[key];
                if (st && st.bm && st.bm._lazyDf && st.bm._lazyDf.size > 0 && st.dfSig) { _dfDirty[key] = 1; _dirty = true; }
            });
            if (_dirty) scheduleDfFlush();
        } catch (e) {}
        return results;
    }

    // 【C2-a】全量兜底扫描（仅"有窗口截断"的源用得上，目前只有检查信息）：
    //   索引只覆盖最近 N 条时，老数据在 KB 路径里是**沉默查不到**的（实测窗口外召回 0/30）。
    //   实测 4 万条按 8 个词 indexOf 全扫 ≈ 30~50ms → 空命中时兜底扫描的代价可忽略，
    //   换来"老数据不再查不到"。命中块复用该源自己的 chunk 函数，出处/字段与常规命中完全一致。
    function fbGrams(q) {
        var s = String(q || '').replace(/[^\u4e00-\u9fa5A-Za-z0-9]+/g, ' ').trim();
        if (!s) return [];
        var seenG = {}, list = [];
        function add(g) { if (g.length >= 2 && !seenG[g]) { seenG[g] = 1; list.push(g); } }
        s.split(/\s+/).forEach(function (w) {
            if (w.length <= 4) { add(w); return; }
            for (var i = 0; i + 4 <= w.length; i++) add(w.slice(i, i + 4));   // 4 字滑窗
        });
        list.sort(function (a, b) { return b.length - a.length; });
        return list.slice(0, 8);
    }
    function fallbackScan(key, query, topK) {
        var s = SRC_MAP[key];
        if (!s) return null;
        var full = srcList(s);                       // 全量（未经 prepare 窗口截断）
        if (!full || !full.length) return null;
        var grams = fbGrams(query);
        if (!grams.length) return null;
        var need = Math.min(2, grams.length);        // 单词查询放宽到 1 个即可
        // 性能（实测 4 万条 8 个词逐一 indexOf = 238ms/次，太贵）：
        //   先用**一个合并正则**做单遍快筛（原生扫描，比 JS 层 8 次 indexOf 快得多），
        //   只有通过快筛的少量候选才做"命中几个词"的精确计数 → 实测降到 ~40ms 量级。
        var re = null;
        try {
            re = new RegExp(grams.map(function (g) { return g.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }).join('|'));
        } catch (e) { re = null; }
        var scored = [];
        for (var i = 0; i < full.length; i++) {
            var it = full[i];
            if (!it) continue;
            var c0 = String(it.content == null ? '' : it.content);
            if (re && !re.test(c0)) continue;        // 快筛：正文里一个查询词都没有 → 直接跳过
            var score = 0, matched = 0;
            for (var g = 0; g < grams.length; g++) {
                if (c0.indexOf(grams[g]) !== -1) { score += grams[g].length * grams[g].length; matched++; }
            }
            if (matched < need) {                    // 少数记录正文没命中，再看标题/分类/单位等字段
                var alt = String(it.title || '') + ' ' + String(it.category || '') + ' '
                    + String(it.unit || '') + ' ' + String(it['性质'] || '');
                for (var g2 = 0; g2 < grams.length; g2++) {
                    if (alt.indexOf(grams[g2]) !== -1) { score += grams[g2].length * grams[g2].length; matched++; }
                }
            }
            if (matched >= need) {
                scored.push({ it: it, score: score, matched: matched, t: it.datetime ? (new Date(it.datetime).getTime() || 0) : 0 });
            }
        }
        if (!scored.length) return null;
        scored.sort(function (a, b) { return (b.score - a.score) || (b.t - a.t); });   // 同分取较新
        var picked = scored.slice(0, Math.max(topK * 2, 8)).map(function (x) { return x.it; });
        var matchedOf = new Map();
        for (var m = 0; m < picked.length; m++) matchedOf.set(picked[m], scored[m].matched);
        var chunks = s.chunk(picked) || [];
        var seen = new Map(), out = [];
        for (var c = 0; c < chunks.length && out.length < topK; c++) {
            var n = seen.get(chunks[c].doc) || 0;
            if (n >= MAX_PER_DOC) continue;
            seen.set(chunks[c].doc, n + 1);
            chunks[c].fallback = true;
            chunks[c].fbScore = matchedOf.get(chunks[c].doc) || 0;   // 命中查询词个数：并入策略的"强证据"判据
            out.push(chunks[c]);
        }
        return out.length ? out : null;
    }

    // 单源便捷检索（对规等只关心规章时用）
    function searchRules(query, topK) {
        var r = search(query, { sources: ['rules'], topK: topK || 4 });
        return r.length ? r[0].hits : [];
    }

    // 组装引用文本（带出处路径，每块完整内容；单源超预算则截断）
    // 【C1/v3.74】新增 opts.totalBudget —— 单轮**总量**预算（字）。
    //   此前只有"单源预算" SRC_BUDGET=6000，而实测各源 5 块最多 ~2000 字 → 该预算从不触顶、形同虚设，
    //   真正生效的只有 topK。现按源顺序从总量里分配：用尽后**后续源不再注入**，单源仍受单源预算约束。
    // 【C2-a】header 里如实标注"索引仅覆盖最近 N 条 / 本次为窗口外兜底命中"，让模型知道口径边界。
    function buildRefText(results, opts) {
        opts = opts || {};
        var budget = opts.budget || SRC_BUDGET;      // 单源上限
        var total = opts.totalBudget || 0;           // 单轮总量预算（0 = 不限，保持旧行为）
        var srcs = (results || EMPTY).filter(function (r) { return r && r.hits && r.hits.length; });
        function headerOf(r) {
            var txt = '【' + r.label + '（数据 ' + r.total + ' 条 → 命中 ' + r.hits.length + ' 块，按' + r.grain + '定位';
            if (r.windowed) {
                txt += '；⚠️ 本源索引仅覆盖最近 ' + r.indexed + ' 条，更早的 '
                    + Math.max(0, r.total - r.indexed) + ' 条不在索引内，查历史数据请用精确查询工具';
            }
            if (r.fallback) txt += '；本次为窗口外全量兜底命中';
            if (r.droppedLow) txt += '；已过滤 ' + r.droppedLow + ' 块弱相关命中';
            return txt + '）】\n';
        }
        function renderFull(r) {
            var txt = headerOf(r);
            r.hits.forEach(function (h, i) { txt += (i + 1) + '. ' + h.path + '\n   ' + h.text + '\n'; });
            if (txt.length > budget) txt = txt.slice(0, budget) + '\n（内容已截断）\n';
            return txt;
        }
        var full = srcs.map(renderFull);
        var alloc = full.map(function (t) { return t.length; });
        var truncated = 0;
        if (total > 0 && srcs.length) {
            // 【P2 按源保底配额】原实现按**源顺序**吃预算：rules/cases 排在最前时会把 4500 字用光，
            //   后面的手册/电话/日志**一块都进不去**（关键依据被静默挤掉，而模型只会说"未检索到"）。
            //   现改为两轮：① 每源先保底 minShare（按源数均分的一部分，且不超过自身长度与剩余总量）；
            //   ② 剩余预算再按源顺序追加。每个有命中的源都能贡献内容，预算也不浪费。
            //   注意 left 递减守卫：极小总量下也要保证总长不超预算（正确性优先于保底）。
            var minShare = Math.max(200, Math.floor(total / srcs.length * 0.55));
            var left = total, sum = 0;
            alloc = full.map(function (t) {
                var a = Math.min(t.length, budget, minShare, left > 0 ? left : 0);
                left -= a; sum += a;
                return a;
            });
            var rest = total - sum;
            for (var i = 0; i < full.length && rest > 0; i++) {
                var room = Math.min(full[i].length, budget) - alloc[i];
                if (room <= 0) continue;
                var add = Math.min(room, rest);
                alloc[i] += add; rest -= add;
            }
        }
        var out = '';
        for (var j = 0; j < full.length; j++) {
            var t = full[j];
            if (alloc[j] < t.length) { t = t.slice(0, alloc[j]) + '\n（内容已截断）\n'; truncated++; }
            out += t + '\n';
        }
        // 【P2 统计】记下"实际注入多少 / 过滤与截断多少"，供「关于」面板与后续调参（此前完全没有数据）
        try {
            window.__kbLastStats = {
                ts: Date.now(),
                injected: alloc.reduce(function (a, b) { return a + b; }, 0),
                truncated: truncated,
                dropped: srcs.reduce(function (a, r) { return a + (r.droppedLow || 0); }, 0),
                budgetTotal: total,
                sources: srcs.map(function (r, i) { return { key: r.key, hits: r.hits.length, dropped: r.droppedLow || 0, chars: alloc[i] }; })
            };
        } catch (e) {}
        return out;
    }

    // ==================== 维护接口 ====================

    function invalidate(key) {
        // 【2026-09-30 准确性修复】原来只删内存 STATE ⇒ 持久化缓存仍在，重启后可能**恢复出旧索引**
        //   （配合 sourceSig 已加"中段抽样"；两者一起保证"数据变了，索引一定跟着变"）。
        //   一并删掉该源的索引缓存与 df 缓存；异步、失败不影响主流程。下次访问该源会重建索引。
        try {
            var _ks = key ? [key] : SOURCES.map(function (s) { return s.key; });
            _ks.forEach(function (k) {
                try { cacheDel(k).catch(function () {}); } catch (e) {}
                try { cacheDel('dfcache:' + k).catch(function () {}); } catch (e) {}
            });
        } catch (e) {}
        // 【2026-10-08 同上】一并清掉 pick 记忆化：数据变更后若不清，srcList 会继续返回旧快照，
        //   导致"数据已改但索引/检索仍是旧的"（指纹有效 ⇒ 不重建，反而更隐蔽）。
        if (key && SRC_MAP[key]) { delete STATE[key]; delete _pickCache[key]; return; }
        STATE = {};
        _pickCache = {};
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
                // 本次索引是否来自本机缓存恢复（v3.74）
                restored: !!(st && st.restored),
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
            return ensure([key], { onProgress: onProgress, force: true }).catch(function (e) {
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

    function fmtBytes(bytes) {
        if (!bytes) return '—';
        return bytes >= 1048576 ? (Math.round(bytes / 1048576 * 10) / 10) + ' MB' : Math.max(1, Math.round(bytes / 1024)) + ' KB';
    }
    // 索引缓存能力是否就绪：需要 doubao.js 新版提供的 exportIndex / importIndex。
    // 若页面跑的是被浏览器/SW 缓存的旧脚本，这里会是 false —— 表现为"重建了也留不住索引"。
    function cacheCapable() {
        var BM = (typeof window !== 'undefined') ? window.LightBM25 : null;
        if (typeof BM !== 'function') return false;
        return (typeof BM.importIndex === 'function') && !!(BM.prototype && typeof BM.prototype.exportIndex === 'function');
    }

    // 输出落到折叠区里时，自动把祖先折叠项展开（面板里"高级与自检/说明"是收起的，否则用户看不到结果）
    function revealInFolds(elm) {
        var n = elm;
        while (n && n.tagName && n.tagName !== 'BODY') {
            if (n.tagName === 'DETAILS') {
                n.open = true;
                if (typeof window.stRememberFold === 'function') { try { window.stRememberFold(n); } catch (e) {} }
            }
            n = n.parentNode;
        }
    }

    // 缓存自检：一次性回答"为什么索引没留住"
    function diag() {
        var BM = (typeof window !== 'undefined') ? window.LightBM25 : null;
        var out = {
            cacheVer: KB_INDEX_VER,
            maxItems: KB_CACHE_MAX_ITEMS,
            lightBM25: typeof BM === 'function',
            canExport: !!(BM && BM.prototype && typeof BM.prototype.exportIndex === 'function'),
            canImport: !!(BM && typeof BM.importIndex === 'function'),
            idb: typeof indexedDB !== 'undefined',
            cacheCount: 0,
            cacheBytes: 0,
            lastErr: _lastCacheErr,
            diagErr: '',
            sources: []
        };
        return cacheInfo().then(function (list) {
            var byKey = {};
            list.forEach(function (x) { byKey[x.key] = x; out.cacheBytes += x.bytes || 0; });
            out.cacheCount = list.length;
            stats().forEach(function (r) {
                var cc = byKey[r.key];
                out.sources.push({
                    key: r.key, label: r.label,
                    built: !!r.chunks, restored: !!r.restored,
                    cacheBytes: cc ? cc.bytes : 0,
                    cacheOk: cc ? sigMatches(r, cc) : null,
                    cacheAt: cc ? cc.at : 0
                });
            });
            return out;
        }).catch(function (e) {
            out.diagErr = (e && e.name ? e.name + '：' : '') + ((e && e.message) || '读取缓存失败');
            return out;
        });
    }

    function panelDiag() {
        if (typeof document === 'undefined') return;
        var host = document.getElementById('kb-diag-out');
        var sum = document.getElementById('kb-summary');
        if (host) { host.style.display = 'block'; host.textContent = '正在自检…'; revealInFolds(host); }
        diag().then(function (d) {
            var lines = [];
            var capable = d.canExport && d.canImport;
            lines.push(capable
                ? '✅ 脚本能力正常（索引导出 ✓ / 恢复 ✓）'
                : '⚠️ 脚本能力缺失：导出 ' + (d.canExport ? '✓' : '✗') + ' / 恢复 ' + (d.canImport ? '✓' : '✗')
                  + ' —— 当前页面运行的很可能不是 v3.74 脚本（被浏览器/Service Worker 缓存了旧文件）。请强制刷新（Ctrl+F5）或「设置 → 清除缓存」后再试。');
            lines.push('IndexedDB：' + (d.idb ? '可用' : '不可用')
                + '；缓存记录 ' + d.cacheCount + ' 个 / 合计 ' + fmtBytes(d.cacheBytes)
                + '；缓存格式版本 v' + d.cacheVer + '；单源上限 ' + d.maxItems + ' 条');
            if (d.lastErr) lines.push('⚠️ 最近一次缓存写入失败：' + d.lastErr);
            if (d.diagErr) lines.push('⚠️ 自检读取出错：' + d.diagErr);
            d.sources.forEach(function (x) {
                lines.push('· ' + x.label + '：' + (x.built ? (x.restored ? '已从缓存恢复' : '已建（本次新建）') : '未建')
                    + '；本机缓存 ' + (x.cacheBytes ? fmtBytes(x.cacheBytes) : '无')
                    + (x.cacheOk === true ? '（与当前数据一致 → 重启可直接恢复）'
                        : x.cacheOk === false ? '（与当前数据不一致 → 重启会重建；属正常，只要改过数据）' : ''));
            });
            if (host) host.textContent = lines.join('\n');
            if (sum && !capable) sum.textContent = '⚠️ 索引缓存能力缺失：页面可能仍运行旧脚本，请强制刷新（Ctrl+F5）后重试';
        });
    }

    // 缓存是否"对得上当前数据"：算一次数据指纹与缓存里的对比（只在面板/自检时算，不在检索路径上）
    function sigMatches(r, cc) {
        if (!cc || !cc.sig) return null;
        var s = SRC_MAP[r.key];
        if (!s || !r.loaded) return null;               // 异步源还没取数 → 先不下结论
        try {
            var raw = s.async ? ((STATE[r.key] && STATE[r.key].list) || EMPTY) : srcList(s);
            var prepared = s.prepare ? s.prepare(raw) : raw;
            return sourceSig(prepared) === cc.sig;
        } catch (e) { return null; }
    }

    function panelRender(hint) {
        if (typeof document === 'undefined') return;
        var host = document.getElementById('kb-source-list');
        var sum = document.getElementById('kb-summary');
        if (!host) return;
        var _chk = document.getElementById('kb-autoload-chk');
        if (_chk) _chk.checked = autoLoadEnabled();
        syncSwitchUI();
        var fmtMB = fmtBytes;
        function paint(rows, cacheMap, sigMap) {
            cacheMap = cacheMap || {};
            sigMap = sigMap || {};
            // 【2026-09-16 精简】面板文字大幅瘦身（用户："缓存多少条、多少 M 即可，其它说明能少则少，太乱了"）：
            //   摘要只留「N 条 · 缓存 X MB」，明细行只留「条数 · 缓存 X MB」，长句解释全部删除；
            //   只在异常态（缓存能力缺失 / 缓存写入失败）保留一句短警告，便于诊断。
            var totalItems = 0, pending = 0, totalBytes = 0;
            rows.forEach(function (r) {
                totalItems += r.total;
                if (!r.loaded) pending++;
                if (cacheMap[r.key]) totalBytes += (cacheMap[r.key].bytes || 0);
            });
            if (sum) {
                sum.textContent = totalItems + ' 条'
                    + (totalBytes ? ' · 缓存 ' + fmtMB(totalBytes) : '')
                    + (pending ? ' · 读取中…' : '')
                    + (hint ? ' · ' + hint : '')
                    + (_lastCacheErr ? ' · ⚠️缓存写入失败' : '')
                    + (cacheCapable() ? '' : ' · ⚠️缓存能力缺失，请强刷 Ctrl+F5');
            }
            var scopeEl = document.getElementById('kb-issue-scope');
            if (scopeEl) {
                var lim = issueLimit();
                var iss = null;
                rows.forEach(function (r) { if (r.key === 'issues') iss = r; });
                scopeEl.textContent = (lim ? '最近 ' + lim + ' 条' : '全部')
                    + (iss && iss.chunks ? '（已索引 ' + iss.indexed + ' 条）' : '');
            }
            host.innerHTML = rows.map(function (r) {
                if (!r.loaded) return '<div>⏳ ' + r.label + ' 读取中…</div>';
                if (!r.total) return '<div>⚫ ' + r.label + ' 无数据</div>';
                var cc = cacheMap[r.key];
                // 🟢 已就绪（在内存中）｜🟡 本机已有可用缓存、未载入｜⚪ 尚无索引（首次检索时自动建）
                var dot = r.chunks ? '🟢' : (cc && cacheCapable() && sigMap[r.key] !== false ? '🟡' : '⚪');
                return '<div>' + dot + ' ' + r.label + ' ' + r.total + ' 条'
                    + (cc ? ' · 缓存 ' + fmtMB(cc.bytes) : '')
                    + '</div>';
            }).join('');
        }
        var rows = stats();
        var cacheMap = {};
        var sigMap = {};
        paint(rows, cacheMap, sigMap);
        // 顺带读出本机缓存清单（体积 + 是否对得上当前数据），让"有没有缓存"一眼可见（v3.74）
        cacheInfo().then(function (list) {
            list.forEach(function (x) { cacheMap[x.key] = x; });
            stats().forEach(function (r) { if (cacheMap[r.key]) sigMap[r.key] = sigMatches(r, cacheMap[r.key]); });
            paint(stats(), cacheMap, sigMap);
        }).catch(function () {});
        // 异步源（资料库/历史报告）计数要先去 IndexedDB 取；取完再补一次真实数字
        // 只取数（countOnly）——面板是"状态显示"，不该顺手把 6000+ 块索引建起来（v3.74 修）
        var waiting = rows.filter(function (r) { return !r.loaded; }).map(function (r) { return r.key; });
        if (waiting.length) {
            ensure(waiting, { countOnly: true }).then(function () {
                var rows2 = stats();                       // 取到数后才能判定异步源的缓存是否可用
                rows2.forEach(function (r) { if (cacheMap[r.key] && sigMap[r.key] === undefined) sigMap[r.key] = sigMatches(r, cacheMap[r.key]); });
                paint(rows2, cacheMap, sigMap);
            }).catch(function () {});
        }
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
        revealInFolds(out);
        out.textContent = '检索中…';
        var t0 = (typeof performance !== 'undefined') ? performance.now() : Date.now();
        ensure(['rules', 'issues', 'handbook', 'materials', 'reports']).then(function () {
            var txt = testSearch(q, { topK: 3 });
            var ms = Math.round(((typeof performance !== 'undefined') ? performance.now() : Date.now()) - t0);
            out.textContent = txt ? (txt + '— 耗时 ' + ms + 'ms') : '未命中任何内容（' + ms + 'ms）';
        }).catch(function (e) { out.textContent = '检索失败：' + (e && e.message ? e.message : e); });
    }

    // ==================== 统一检索层开关（v3.74 上设置页）====================
    // 背景：v3.73 起有几个 localStorage 开关散落在各模块里（kb_prompt / kb_autocheck），
    // 只能手改 localStorage。这里统一成面板上的勾选框，默认都是"开"。
    //   kb_prompt    ：智能对话 / 智能写作 使用统一检索层（'0' = 回退旧多源采样）
    //   kb_autocheck ：AI 对规使用统一检索层的条款级召回（'0' = 回退关键词召回）
    //   kb_agent     ：智能体的旧检索工具（search_rules/search_handbook/search_material）
    //                  与风险研判的案例检索优先走统一检索层（'0' = 回退各自的原实现）
    var UI_SWITCH_KEYS = ['kb_prompt', 'kb_autocheck', 'kb_agent'];

    function getSwitch(key) {
        if (UI_SWITCH_KEYS.indexOf(key) === -1) return true;
        var v = '1';
        try { v = localStorage.getItem(key) || '1'; } catch (e) {}
        return v !== '0';
    }
    function setSwitch(key, on) {
        if (UI_SWITCH_KEYS.indexOf(key) === -1) return false;
        try { localStorage.setItem(key, on ? '1' : '0'); } catch (e) {}
        if (typeof console !== 'undefined') console.log('[KB] 开关 ' + key + ' → ' + (on ? '开' : '关') + '（下次检索生效）');
        return !!on;
    }
    function syncSwitchUI() {
        if (typeof document === 'undefined') return;
        var map = { kb_prompt: 'kb-sw-prompt', kb_autocheck: 'kb-sw-autocheck', kb_agent: 'kb-sw-agent' };
        for (var k in map) {
            if (!map.hasOwnProperty(k)) continue;
            var el = document.getElementById(map[k]);
            if (el) el.checked = getSwitch(k);
        }
    }

    // ==================== 启动后自动载入索引（v3.74）====================
    // 用户诉求：「重启后不该还要手动点『载入索引』」。页面就绪后延后 1.2s，在空闲时**逐个源**
    // 做"仅恢复"尝试：有可用缓存 → 秒级载入（🟡→🟢）；无缓存或数据已变更 → 保持未载入，
    // 留给首次检索时按需重建（绝不在开机时白跑 CPU）。每源之间让出事件循环，不阻塞界面。
    // 开关 kb_autoload：'0' 关闭（低配手机想省内存时可关，面板上有勾选框）。
    function autoLoadEnabled() {
        var on = true;
        try { on = localStorage.getItem('kb_autoload') !== '0'; } catch (e) {}
        return on;
    }
    function setAutoLoad(on) {
        try { localStorage.setItem('kb_autoload', on ? '1' : '0'); } catch (e) {}
        if (on) autoLoadCaches();
        return !!on;
    }
    function autoLoadCaches() {
        if (!autoLoadEnabled() || !cacheCapable()) return Promise.resolve(0);
        // 【启动优化 2026-09-18】顺序调整：轻的源在前（规章/手册/电话 → 资料/报告），
        // **最重的检查信息放最后**。这样用户在这批恢复进行到一半时就开始用系统，
        // 先有的也是"千条级小源"，4 万条的大源（缓存 33MB 级）在最后单独跑，不挡前面的。
        // 【2026-10-06】`cases` 补入本名单。它是 2026-09-22 从 rules 拆出的"汇编文档"源
        //   （见下方 SOURCES 定义：从 getRulesData 里按标题挑 CASE_DOC_RE），拆出时**漏配**了这两处预载/预热名单，
        //   于是它永远只能等首次检索被懒建 ⇒ 实测 `cases:0/1`（其余有数据的源都 1/xxx），
        //   首次检索还要现付一次 chunkRules。放在 rules 之后：两者同源、语义相邻。
        var keys = ['rules', 'cases', 'handbook', 'phone', 'diary', 'materials', 'reports', 'issues'];
        var i = 0, loaded = 0;
        function step() {
            if (i >= keys.length) {
                if (loaded) {
                    if (typeof document !== 'undefined' && document.getElementById('kb-source-list')) try { refreshPanelIfNeeded(); } catch (e) {}
                    if (typeof console !== 'undefined') console.log('[KB] 启动自动载入完成，已从本机缓存恢复 ' + loaded + ' 个源的索引');
                }
                return Promise.resolve(loaded);
            }
            var key = keys[i++];
            return ensureOne(key, null, false, false, true).then(function () {
                if (STATE[key] && STATE[key].chunks) loaded++;
            }).catch(function () { /* 单源失败不影响其它 */ }).then(function () {
                return new Promise(function (r) { setTimeout(r, 0); });
            }).then(step);
        }
        return step();
    }

    // ==================== 空闲预热（v3.75）====================
    // 用户诉求：「页面空闲时预热索引，这样点发送时通常已就绪」。
    // 与 autoLoadCaches 的分工：autoLoad 只做"**仅恢复**"（绝不重建，避免开机白跑 CPU）；
    // 本函数在它之后接手，对**常用业务源**做"恢复 or 按需建立"，把首次发送要付的代价提前到空闲时段消化。
    //   调度：requestIdleCallback（不支持则退化为 setTimeout 300ms），**逐源串行**、每源之间再次让出；
    //   门槛：受同一个「启动后自动载入」（kb_autoload）开关控制 —— 低配手机/想省内存时关掉即可；
    //   范围：只预热同步业务源（检查信息/规章/手册/电话/日志）。资料库/历史报告是 async 源、
    //        块数与内存占用大得多，仍保持"首次真正用到时才载入"，不在这里预热。
    function _idleRun(cb) {
        // 【2026-09-23 折叠平滑】隐藏（合盖/切后台）时**不继续跑预热**。
        //   预热是重活（建索引/分词），在合盖瞬间跑会与系统折叠动画抢主线程；更重要的是
        //   页面"正在重活 + 内存高"时更可能被系统回收 ⇒ 展开后就变成"重新加载"，用户感知为卡顿。
        //   隐藏期间每 1.5s 探一次，可见后立刻继续，只是把重活挪到用户看得到的时候（不影响最终就绪）。
        try {
            if (typeof document !== 'undefined' && document.hidden) {
                setTimeout(function () { _idleRun(cb); }, 1500);
                return;
            }
        } catch (e) {}
        if (typeof requestIdleCallback === 'function') {
            try { requestIdleCallback(cb, { timeout: 4000 }); return; } catch (e) {}
        }
        setTimeout(cb, 300);
    }
    function warmCommonSources() {
        if (!autoLoadEnabled() || !cacheCapable()) return;
        if (typeof document !== 'undefined' && document.hidden) return;    // 页面在后台先不做
        // 【2026-10-06】`cases` 同补入（原因见 autoLoadCaches 同处注释：拆源时漏配预热名单）。
        var keys = ['issues', 'rules', 'cases', 'handbook', 'accidents', 'phone', 'diary'];
        var i = 0;
        function step() {
            // 【2026-10-06 用户口径："真正改善体验"】所有源就绪后，接着做**惰性 df 空闲预热** ——
            //   把"首次长句查询"里最贵的那部分（每个新查询词全库扫一遍算 df，rules 13.9 万块 ≈ 100-200ms/词）
            //   提前到空闲时段消化，用户第一次提问就不用等那一两秒。详见 warmLazyDf 的注释。
            if (i >= keys.length) { warmLazyDf(); return; }
            var key = keys[i++];
            var st = STATE[key];
            if (st && st.chunks && st.bm) return _idleRun(step);           // 已就绪 → 下一个
            var t0 = Date.now();
            ensure([key]).then(function () {
                var st2 = STATE[key];
                if (typeof console !== 'undefined' && st2 && st2.chunks) {
                    console.log('[KB] 空闲预热完成：' + key + '（' + st2.chunks.length + ' 块，'
                        + (st2.restored ? '缓存恢复' : '本次建立') + '，' + Math.max(0, Date.now() - t0) + 'ms）');
                }
                if (typeof document !== 'undefined' && document.getElementById('kb-source-list')) try { refreshPanelIfNeeded(); } catch (e) {}
            }).catch(function () { /* 单源失败不影响其它；也不影响功能（首次检索还会再试） */ })
              .then(function () { _idleRun(step); });
        }
        _idleRun(step);
    }

    /* ==================== 【2026-10-06】惰性 df 空闲预热（用户口径："真正改善体验"）====================
     * 为什么做：长句查询的**首会话**慢在"每个新查询词都要全库扫一遍算 df"（rules 13.9 万块，~100-200ms/词；
     *   真机实测长句 P50 1824ms，而同一台机器**二次会话只要 139ms**）。用户体感 = "第一次问要等一两秒"。
     * 做法：把"下次大概会查到的词"的 df **提前在空闲时段算好**，首次提问不再付这笔钱。
     * ⚠️ **零召回风险**：df 是 `_dfOfLazy(term)` 的确定性函数（同一个词永远同一个数，只进 idf 权重），
     *   预热与查询走的是**同一条代码路径 + 同一个缓存 Map** ⇒ 打分结果与不预热时**完全一致**，只是代价挪早。
     * 词从哪来（去重后每源最多 300 个，总预算 8s，每 5 词让出主线程）：
     *   ① **本机历史提问**（对话记录 / 聊天历史里的用户消息）—— 最贴近"你下次会问什么"；
     *   ② 本机没有历史（全新设备）⇒ 从**该源自己的数据里抽样**提领域高频词（标题 + 块首片段）。
     * 受同一个「启动后自动载入」开关控制；页面隐藏时不跑；单源失败静默（纯优化，绝不影响功能）。
     * 诊断：`window.__kbDfWarm`（本次预热词数/耗时/来源）、`window.__kbDfWarmMs`（可覆盖预算）、
     *       `window.KB.warmDf()`（手动触发）。
     * ---------------------------------------------------------------------
     * ⚠️【2026-10-06 实测结论·务必先读，别被上面的设想带偏】
     *   真机（89.5MB 备份 / rules 13.9 万块）实测：预热 300 词只花 **5360ms ≈ 18ms/词**，
     *   而检索 P50 **没有改善**（1862ms，预热前后 1824/1840/1862 属同一噪声带）。
     *   ⇒ 结论：**df 计算不是"首会话长句"的瓶颈**（旧注释里"100-200ms/词"的估计偏高，
     *     且词一旦算过就命中缓存）。1.8s 的主体是**打分阶段"每个查询词各扫一遍全库"**
     *     （`BM25_SCAN` 的快筛正则按词逐个跑，长句十几个词 ⇒ 线性累加 ≈ 1.5s），与 df 无关。
     *   ⇒ 因此本预热**不承诺**改善"连问多个互不相同的新问题"这种极限场景；它的真实价值是：
     *     ① 跨会话把更多词的 df 缓存补齐（重复问同类问题时更省）；
     *     ② 零召回风险（只提前算，不改任何打分结果），空闲时段跑、有预算上限。
     *   ⇒ 若要让"首查长句"真正变快，方向应是**减少按词全库扫描的次数**（例如只保留区分度最高的
     *     前 N 个词参与扫描、或把"含该词的文档清单"在预热时就存下来供打分复用），
     *     属架构级取舍，改动需配 kb-recall-bench 回归 —— 不要在这里悄悄改。
     * ===================================================================== */
    var _dfWarmBusy = false;
    function _dfWarmBudget() {
        return (typeof window.__kbDfWarmMs === 'number' && window.__kbDfWarmMs > 0) ? window.__kbDfWarmMs : 8000;
    }
    /** 取本机历史提问的文本（最贴近真实问法） */
    function _dfWarmTextsFromHistory() {
        var texts = [];
        function push(arr) {
            (Array.isArray(arr) ? arr : []).slice(-60).forEach(function (m) {
                if (m && m.role === 'user') texts.push(String(m.displayText || m.content || ''));
            });
        }
        try {
            (JSON.parse(localStorage.getItem('ds_conversations_v1') || '[]') || []).slice(0, 40).forEach(function (c) {
                push((c && c.messages) || []);
            });
        } catch (e) {}
        try { push(JSON.parse(localStorage.getItem('ds_chat_history_v1') || '[]')); } catch (e) {}
        return texts.filter(function (t) { return t.length > 1; });
    }
    /** 从某源的数据里抽样取文本（没有历史提问时的兜底：领域高频词） */
    function _dfWarmTextsFromSource(st) {
        var texts = [], chunks = (st && st.chunks) || [];
        var stepN = Math.max(1, Math.floor(chunks.length / 120));
        for (var i = 0; i < chunks.length && texts.length < 160; i += stepN) {
            var c = chunks[i] || {};
            texts.push(String(c.title || ''));                        // 标题多是条款头/项点名，命中率高
            texts.push(String(c.content || '').slice(0, 80));
        }
        return texts;
    }
    /** 切词：优先用该源自己的分词器（与检索口径完全一致），否则退化为 2/3 字滑窗 */
    function _dfWarmTokens(st, texts) {
        var toks = [];
        try {
            if (st && st.bm && typeof st.bm._tokenize === 'function') {
                texts.forEach(function (t) { toks = toks.concat(st.bm._tokenize(String(t || '')) || []); });
            }
        } catch (e) {}
        if (!toks.length) {
            texts.forEach(function (t) {
                var s = String(t || '').replace(/[^0-9A-Za-z\u4e00-\u9fa5]+/g, '');
                for (var L = 2; L <= 3; L++) {
                    for (var i = 0; i + L <= s.length; i++) toks.push(s.slice(i, i + L));
                }
            });
        }
        return toks;
    }
    /* ==================== 【2026-10-06】检索耗时分解（纯诊断，给优化定方向）====================
     * 为什么需要：本轮先怀疑"惰性 df 贵"，实测发现 300 词只要 5.4s（≈18ms/词），**方向错了**。
     *   教训：别再靠代码注释里的量级估计猜瓶颈（那是不同数据规模下的旧数字），**要在这台机器、这份数据上量**。
     * 用法：`KB.profileSearch('一段长句查询', 'rules')` —— 返回各阶段耗时，不参与任何业务逻辑。
     *   · textOfMs  ：全库取文本（`_textOf`）的耗时 —— 退化模式的第一道代价
     *   · scanMs    ：合并正则快筛全库的耗时（含 textOf）
     *   · candidates：快筛后剩下多少块要精算（长句词多时这个数决定后面的成本）
     *   · dfMs      ：对本次查询词逐个惰性算 df 的总耗时
     *   · searchMs  ：完整一次 search 的耗时（用于验证"分项之和 ≈ 总耗时"）
     * 只读内部状态，不写任何缓存、不改任何结果。
     * ===================================================================== */
    function profileSearch(query, key) {
        key = key || 'rules';
        var st = STATE[key];
        if (!st || !st.bm) return { error: 'no-bm:' + key };
        var bm = st.bm, docs = bm.docs || [];
        var out = { key: key, docs: docs.length, mode: bm.postings ? 'postings' : 'scan', query: String(query || '').slice(0, 60) };
        var t0 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
        for (var i = 0; i < docs.length; i++) { try { bm._textOf(docs[i]); } catch (e) {} }
        out.textOfMs = Math.round((typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0);
        var toks = [];
        try { toks = bm._tokenize(String(query || '')) || []; } catch (e) {}
        out.tokens = toks.length;
        var re = null;
        try { re = new RegExp(toks.map(function (t) { return t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }).join('|'), 'i'); } catch (e) {}
        t0 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
        var cand = 0;
        for (var j = 0; j < docs.length; j++) {
            var text = bm._textOf(docs[j]);
            if (text && re && re.test(text)) cand++;
        }
        out.scanMs = Math.round((typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0);
        out.candidates = cand;
        t0 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
        toks.slice(0, 30).forEach(function (t) { try { bm._dfOfLazy(t); } catch (e) {} });
        out.dfMs = Math.round((typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0);
        t0 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
        try { bm.search(String(query || ''), 5); } catch (e) {}
        out.searchMs = Math.round((typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0);
        return out;
    }

    function warmLazyDf() {
        if (_dfWarmBusy) return;
        if (!autoLoadEnabled() || !cacheCapable()) return;
        if (typeof document !== 'undefined' && document.hidden) return;
        // 只预热"惰性 df 模式"且已就绪的源。rules 最贵、查询也主要打它 ⇒ 排最前，保证预算优先给它。
        var keys = ['rules', 'handbook', 'accidents', 'cases', 'phone', 'diary', 'issues'].filter(function (k) {
            var st = STATE[k];
            return !!(st && st.chunks && st.chunks.length && st.bm && st.bm._lazyDf);
        });
        if (!keys.length) return;
        _dfWarmBusy = true;
        var T0 = Date.now(), budget = _dfWarmBudget(), MAX_TERMS = 300;
        var histTexts = _dfWarmTextsFromHistory();
        var stat = window.__kbDfWarm = {
            at: new Date().toISOString(), sources: keys.slice(), terms: 0, byKey: {},
            ms: 0, done: false, from: histTexts.length ? 'history' : 'data', budget: budget
        };
        var ki = 0;
        function finish() {
            stat.ms = Date.now() - T0; stat.done = true; _dfWarmBusy = false;
            // 预热得到的词同样标记回写 df 缓存（本次会话立即受益，跨会话复用）
            try {
                var dirty = false;
                keys.forEach(function (key) {
                    var s2 = STATE[key];
                    if (s2 && s2.bm && s2.bm._lazyDf && s2.bm._lazyDf.size > 0 && s2.dfSig) { _dfDirty[key] = 1; dirty = true; }
                });
                if (dirty) scheduleDfFlush();
            } catch (e) {}
            try {
                console.log('[KB] 惰性 df 空闲预热完成：' + stat.terms + ' 词 / ' + stat.ms + 'ms（词来源：'
                    + (stat.from === 'history' ? '本机历史提问' : '数据抽样高频词') + '；源：' + keys.join(',') + '）');
            } catch (e) {}
        }
        function nextSource() {
            if (ki >= keys.length || Date.now() - T0 > budget) return finish();
            var key = keys[ki++], st = STATE[key];
            var texts = histTexts.length ? histTexts : _dfWarmTextsFromSource(st);
            var toks = _dfWarmTokens(st, texts);
            var freq = {};
            toks.forEach(function (w) { if (w && w.length >= 2) freq[w] = (freq[w] || 0) + 1; });
            // 高频词 = 最可能出现在查询里的词
            var list = Object.keys(freq).sort(function (a, b) { return freq[b] - freq[a]; }).slice(0, MAX_TERMS);
            var i2 = 0, n = 0;
            function stepTerm() {
                if (i2 >= list.length || Date.now() - T0 > budget) {
                    stat.byKey[key] = n; stat.terms += n;
                    return _idleRun(nextSource);
                }
                for (var burst = 0; burst < 5 && i2 < list.length; burst++) {     // 每片 5 词，让出主线程
                    try { st.bm._dfOfLazy(list[i2++]); n++; } catch (e) { i2++; }
                }
                _idleRun(stepTerm);
            }
            stepTerm();
        }
        _idleRun(nextSource);
    }

    // 清空本机索引缓存（设置页按钮）：只删缓存，不动业务数据；下次检索会重新建立
    function clearCache() {
        return cacheClear().then(function () {
            if (typeof console !== 'undefined') console.log('[KB] 已清空本机索引缓存');
            return true;
        }).catch(function () { return false; });
    }
    // 「载入索引」：把各源索引准备好（有缓存就是秒级恢复，无缓存才真正建立）。
    // 给"重启后想立刻看到索引就位"的场景用；不点也不影响功能（首次用到该源时会自动载入）。
    function panelWarm() {
        if (typeof document === 'undefined') return;
        var sum = document.getElementById('kb-summary');
        var t0 = (typeof performance !== 'undefined') ? performance.now() : Date.now();
        if (sum) sum.textContent = '正在载入索引（优先使用本机缓存）…';
        return ensure(null).then(function () {
            var ms = Math.round(((typeof performance !== 'undefined') ? performance.now() : Date.now()) - t0);
            panelRender('索引已载入，耗时 ' + ms + 'ms');
        }).catch(function (e) {
            panelRender('载入失败：' + (e && e.message ? e.message : e));
        });
    }

    function panelClearCache() {
        if (typeof document === 'undefined') return;
        var sum = document.getElementById('kb-summary');
        if (sum) sum.textContent = '正在清空索引缓存…';
        clearCache().then(function (ok) {
            invalidate();          // 内存里的索引也一并丢弃，面板状态才诚实
            panelRender(ok ? '已清空索引缓存（下次检索会重新建立）' : '清空失败（可能是浏览器限制）');
        });
    }
    // 缓存清单（自检/诊断用）：返回每个源缓存的大小与指纹
    function cacheInfo() {
        return cacheTx('readonly', function (s) { return s.getAllKeys(); }).then(function (keys) {
            var out = [];
            return (keys || []).reduce(function (p, k) {
                return p.then(function () {
                    return cacheGet(k).then(function (rec) {
                        if (!rec) return;
                        out.push({
                            key: k, ver: rec.ver, sig: rec.sig,
                            chunks: rec.chunks ? rec.chunks.length : 0,
                            at: rec.at,
                            bytes: (rec.bm && rec.bm.flat ? rec.bm.flat.byteLength : 0)
                                 + (rec.bm && rec.bm.termsBlob ? rec.bm.termsBlob.length : 0)
                                 + (rec.chunks ? rec.chunks.length * 200 : 0)
                        });
                    });
                });
            }, Promise.resolve()).then(function () { return out; });
        }).catch(function () { return []; });
    }

    // 打开设置面板「数据」分区时才刷新面板（自包含：不改 app.js 的设置面板逻辑）
    // 【启动优化 2026-09-18】原先这里在 defer 阶段就无条件执行 panelRender()，代价是：
    //   读 7 个源的索引缓存（检查信息源 7~33MB 级的结构化克隆）+ 逐源算数据指纹 + 读写作库两个 store，
    //   全部压在"首屏渲染前"的主线程上，实测是一段 300ms 级长任务。面板只有「设置 → 数据」才可见，
    //   因此改为"什么时候看得见、什么时候才渲染"：由下面的统一入口触发（点导航 / 打开设置面板都会经过）。
    function refreshPanelIfNeeded() {
        if (typeof document === 'undefined') return;
        var sec = document.querySelector('.st-sec[data-sec="data"]');
        if (!sec || !sec.classList.contains('is-active')) return;              // 没停在「数据」分区
        var panel = document.getElementById('settings-panel');
        if (!panel || !panel.style.display || panel.style.display === 'none') return;  // 面板没打开
        panelRender();
    }
    if (typeof document !== 'undefined') {
        // 「数据」分区被激活的统一入口：app.js 的 stGoSection/toggleSettingsPanel、index.html 的兜底版
        // 最终都会调 window.updateDataManagementStats()。挂它上面（原实现照常执行，之后补一次渲染）。
        (function hookDataSectionEntry() {
            var orig = window.updateDataManagementStats;
            window.updateDataManagementStats = function () {
                if (typeof orig === 'function') { try { orig.apply(this, arguments); } catch (e) {} }
                try { refreshPanelIfNeeded(); } catch (e) {}
            };
        })();
        document.addEventListener('click', function (e) {
            var t = e.target;
            if (!t || !t.closest) return;
            if (t.closest('.st-nav-item[data-sec="data"]')) setTimeout(refreshPanelIfNeeded, 0);
        });
        // 兜底：启动时若面板已打开且正停在「数据」分区（例如被 page-state 还原），补渲染一次
        setTimeout(refreshPanelIfNeeded, 0);

        // 启动后自动从本机缓存载入索引
        // 【v3.75】载入结束后接着进入「空闲预热」：把常用源彻底准备好（有缓存=秒级恢复，
        //   无缓存=趁空闲把索引建好），用户点发送时通常已是 🟢，不必再等。
        // 【启动优化 2026-09-18】调度改为"等主线程真正空闲"：原先是 load+1.2s 定时器，
        //   正好撞在用户刚打开、开始点按的时间点上（实测两段 320ms 级长任务卡在这里）。
        //   requestIdleCallback 会挑浏览器空闲帧跑；timeout 只作为"最晚也要跑"的兜底。
        function _autoLoadLater() {
            var kick = function () {
                // 再等一个空闲帧：此时首屏已画完、台账已就绪，恢复索引不会与它们抢主线程
                if (typeof requestIdleCallback === 'function') requestIdleCallback(function () {
                    autoLoadCaches().then(function () { warmCommonSources(); });
                }, { timeout: 2000 });
                else setTimeout(function () { autoLoadCaches().then(function () { warmCommonSources(); }); }, 300);
            };
            // 【启动优化续 2026-09-18】必须等「检查信息」数据就绪后再生效：
            //   ① 检查信息是 KB 最大的一个源（4 万条 / 缓存几十 MB），数据还没进内存时，
            //      KB 取到的是**空数组** —— 该源既恢复不了（指纹对不上）也建不出来，白跑一趟；
            //   ② 更重要的是别和 issue 的全量读取抢主线程（实测提前跑会把「台账就绪」从 ~420ms 拖到 ~600ms）。
            //   等不到（3s 超时 / issue 模块异常）就照常继续，不影响其它源。
            (function waitIssueData(then) {
                if (window.__issueDataReady) { then(); return; }
                var t0 = Date.now();
                var timer = setInterval(function () {
                    if (window.__issueDataReady || (Date.now() - t0) > 3000) { clearInterval(timer); then(); }
                }, 100);
            })(kick);
        }
        if (document.readyState === 'complete') _autoLoadLater();
        else window.addEventListener('load', _autoLoadLater, { once: true });
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
        chunkAccidents: chunkAccidents,
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
        getIssueLimit: issueLimit,
        clearCache: clearCache,
        panelWarm: panelWarm,
        panelClearCache: panelClearCache,
        autoLoad: autoLoadCaches,
        warmCommon: warmCommonSources,      // v3.75 空闲预热（诊断/手动触发用）
        setAutoLoad: setAutoLoad,
        getAutoLoad: autoLoadEnabled,
        setSwitch: setSwitch,
        SYNONYM_MAP: SYNONYM_MAP,   // 【2026-09-30】同义词表对外暴露（单一来源）：smart-check 等模块可复用，避免两处维护
        getSwitch: getSwitch,
        cacheInfo: cacheInfo,
        diag: diag,
        panelDiag: panelDiag,
        cacheCapable: cacheCapable,
        // 【2026-10-06】惰性 df 空闲预热：手动触发 + 本次预热统计（诊断与验证用）
        warmDf: function () { try { warmLazyDf(); return true; } catch (e) { return false; } },
        dfWarmStats: function () { return window.__kbDfWarm || null; },
        // 【2026-10-06】检索耗时分解（诊断用，给优化定方向；不参与业务逻辑）
        profileSearch: profileSearch,
        CACHE_VER: KB_INDEX_VER,
        BUILD: 'v3.74'   // 运行期版本标记：用于确认页面加载的是哪一版 knowledge.js（排查缓存旧脚本）
    };
    window.KB = KB;

    // ==================================================================================
    // 【2026-10-09 建议①·查询改写】检索前用一次小 LLM 调用抽出「核心检索要素」。
    //
    // 为什么对**本仓库**有效：LightBM25 用的是**字符级 2/3-gram**（无词典），
    //   长问句里的"帮我查一下/有没有/关于…的情况"会产生大量低信息 gram —— 它们 df 高（idf 低）
    //   却占据查询长度，把真正的实体（单位名/设备名/专业/条号）挤到次要位置。
    //   改写后查询更短、实体更集中 ⇒ BM25 打分更聚焦。
    //
    // 工程约束（都来自既有事实，别踩）：
    //   · `KB.search` 是**同步**函数，且内部会同步建索引（超时后照常调用会整段卡死）
    //     ⇒ **不能**在 search 内部 await。故改写成独立异步步骤：
    //       调用方 `var q2 = await KB.rewriteQuery(q)` 之后再 `KB.search(q2, ...)`；
    //       失败/超时/无 Key 一律**返回原查询**，调用方无需写分支（"如实降级"口径）。
    //   · 走 `window.dsCallOnce`（关思考 + 4s 超时 + 小 max_tokens）——它是全项目"小请求"的统一入口，
    //     契约是"绝不抛异常、失败返回 {ok:false}"；4s 是刻意的小值：检索前的改写不值得让用户久等。
    //   · 同查询结果缓存（最多 60 条）：避免同一问题反复花额度。
    //   · 诊断 `window.__kbLastRewrite` / `KB.rewriteStats()`。
    //
    // ★★ 2026-10-09 实测结论 → **默认关闭**（`kb_rewrite` 只有显式设为 '1' 才启用）★★
    //   用真数据 A/B（scripts/kb-recall-bench.js，KB_REWRITE=both，30 条真实"检查信息→引用规章"样本，
    //   本机 43526 条检查信息 / 685 篇规章）测得改写是**负收益**：
    //       Recall@1  33.3% → 16.7%（-16.7pp）
    //       Recall@5  70.0% → 56.7%（-13.3pp）
    //       Recall@10 86.7% → 70.0%（-16.7pp）  ← 决策指标
    //       MRR       0.477 → 0.327（-0.150）
    //   为什么（这是"机制"而非偶然）：本库的召回目标是"该问题引用的那篇**规章**"，而匹配证据恰恰是
    //   **检查描述原文与规章正文的用词重合**；LightBM25 是**字符 2/3-gram**（无词典），长句里那些
    //   "看似啰嗦"的词本身就是有效检索证据 —— 改写成"实体词表"反而**删掉了证据**。
    //   ⇒ 所以代码与开关都保留（换数据域/换成短条款检索时可能有用），但**默认不启用**，
    //     避免"看起来聪明、实测更差"的默认行为白花额度。
    // ==================================================================================
    var _rwCache = Object.create(null), _rwCacheN = 0;
    KB.rewriteQuery = async function (query, opts) {
        opts = opts || {};
        var src = String(query == null ? '' : query).trim();
        var out = { on: false, ok: false, cached: false, ms: 0, src: src.slice(0, 80), out: src.slice(0, 80), err: '' };
        window.__kbLastRewrite = out;
        try {
            if (localStorage.getItem('kb_rewrite') !== '1') { out.err = 'off'; return src; }
            out.on = true;
            if (src.length < 6) { out.err = 'too-short'; return src; }        // 短查询没有可压缩的噪声
            if (typeof window.dsCallOnce !== 'function') { out.err = 'no-llm'; return src; }
            if (_rwCache[src]) { out.cached = true; out.ok = true; out.out = _rwCache[src]; return _rwCache[src]; }
            var _t0 = Date.now();
            var _sys = '你是检索查询改写器。把用户问题改写成**检索关键词**：只保留实体与主题词'
                + '（单位/设备/部件/专业/问题性质/时间等），去掉"帮我/查一下/有没有/关于/的情况/怎么样"这类无检索价值的词。'
                + '只输出关键词，用空格分隔，不要标点、不要解释、不要引号，最多 12 个词。';
            var r = await window.dsCallOnce(_sys, src, {
                temperature: 0.1, maxTokens: 120, timeoutMs: opts.timeoutMs || 4000, thinking: false
            });
            out.ms = Date.now() - _t0;
            if (!r || !r.ok || !r.text) { out.err = (r && r.error) || 'empty'; return src; }
            // 归一：去引号/标点/换行，压空格（只留中日韩、字母、数字、空格）
            var core = String(r.text).replace(/[\n\r]+/g, ' ')
                .replace(/["'“”‘’`、，。,.;；:：!！?？()（）【】\[\]{}<>《》/\\|~@#$%^&*+=]/g, ' ')
                .replace(/\s+/g, ' ').trim();
            if (core) {
                var seen = Object.create(null), arr = [];
                core.split(' ').forEach(function (w) {
                    if (!w) return;
                    var k = w.toLowerCase();
                    if (seen[k]) return;
                    seen[k] = 1; arr.push(w);
                });
                core = arr.slice(0, 12).join(' ');
            }
            // 无效改写（空/过短/与原查询等价）⇒ 如实退回原查询
            if (core.replace(/\s/g, '').length < 4 || core === src) { out.err = 'invalid'; return src; }
            out.ok = true; out.out = core.slice(0, 80);
            if (_rwCacheN < 60) { _rwCache[src] = core; _rwCacheN++; }
            return core;
        } catch (e) {
            out.err = String((e && e.message) || e);
            return src;
        }
    };
    KB.rewriteStats = function () { return window.__kbLastRewrite || null; };
})();
