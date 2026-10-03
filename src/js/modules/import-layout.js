/**
 * 导入排版还原（2026-10-03 用户要求：OFD/PDF 导入后排版要正常、段落句子不得随意打断、
 *   段内不得是硬回车、倾斜水印要清掉）
 * ============================================================================
 * 为什么需要它：PDF / OFD 里**没有"段落"概念**，只有一堆带坐标的文字块：
 *   · PDF：`getTextContent().items` 每个 item 是一小段文字 + 变换矩阵（含位置/旋转角）；
 *   · OFD：每页 Content.xml 里若干 `TextObject`（含 X/Y/Rotate/Alpha），**通常一行就是一个对象**。
 * 之前两个提取器都是"直接拼接"：
 *   · PDF 用 `items.map(str).join(' ')` ⇒ ①句子中间被塞空格（打断句子）②整页并成一行（没有段）；
 *   · OFD 用 `'\n'.join(...)` ⇒ **每行一个硬回车**（段内全是硬回车）。
 *   然后只能靠 smartSplitParagraphs 按 300 字硬切 ⇒ 段落/句子被随意打断。这就是用户看到的现象。
 *
 * 本模块把"坐标"还原成"排版"：
 *   ① 行内：同 Y 的块按 X 排序拼接；**中文之间不加空格**，涉及拉丁字母/数字时才补空格；
 *   ② 行：按 Y 聚成"视觉行"（容差自适应，避免上下标/轻微基线差被拆成两行）；
 *   ③ 段：把"视觉行"合并成自然段 —— 只有满足下列条件才另起一段（其余一律**续行拼接，不加硬回车**）：
 *        · 上一行以句末/收尾标点结束（。！？；：… 以及紧随其后的 ”』）】 等引号括号）；
 *        · 两行垂直间距明显大于正常行距（≥ 1.7 倍中位行距）；
 *        · 本行以条款/编号/标题开头（第X条|章|节|款|项、一、二、…、（一）、1.、1.1、(1)、附则/附件…）；
 *        · 本行相对上行的左缩进明显（首行缩进/居中标题、且上一行已结束）；
 *   ④ 旋转文字识别：变换矩阵含明显旋转角（PDF）/ Rotate≠0（OFD）——倾斜排版＝水印的典型画法，
 *      由调用方决定丢弃；这里只**如实标记** rotated/angle，不替调用方做取舍。
 *
 * 全程纯计算（无 DOM、无网络），可在套件里用合成数据直接单测。
 */
(function () {
    'use strict';

    var CJK = /[\u3000-\u303f\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff00-\uffef]/;
    var SENT_END = /[。！？；：…!?;:]["'”’』」）)\]】]*$/;
    var CLAUSE_HEAD = /^\s*(第[一二三四五六七八九十百千0-9]+[章节条款项目]|[一二三四五六七八九十]+[、.．]|[（(][一二三四五六七八九十0-9]+[）)]|[0-9]+([.．、][0-9]+)*[、.．]?\s|附\s*(则|件|录|表)|表\s*[0-9]|图\s*[0-9])/;

    function isSpace(ch) { return ch === ' ' || ch === '\t' || ch === '\u3000'; }
    function needSpace(prev, next) {
        if (!prev || !next) return false;
        if (isSpace(prev) || isSpace(next)) return false;
        if (CJK.test(prev) || CJK.test(next)) return false;   // 中文之间不插空格（PDF 里这是最常见的"打断句子"来源）
        return true;                                          // 拉丁/数字之间保一个空格，避免粘成一个词
    }

    /**
     * 行内清理：把 PDF「分散对齐 / 逐字定位」留下的多余空格去掉。
     * 实测语料（兰州局规章 PDF）："铁 路 按 照 普 速 铁 路 防 护 栅 栏" —— 每个汉字后面一个空格。
     *   这类空格有时在**块之间**（由 joinRun 决定不插空格即可），但更常见是**块内部就是 '铁 路'**，
     *   所以必须对每个块自己的文本也做一次清理，否则永远修不掉。
     * 规则（只做**无歧义**的合并，不做激进的整句重排）：
     *   · 汉字 + 空白 + 汉字 ⇒ 合并（中文正文里汉字之间不该有空格）；
     *   · 数字 + 空白 + 数字 ⇒ 合并（"1 20km/h" ⇒ "120km/h"、"3 ≥3 0 分" 里的数字也归位）；
     *   · 连续多个空白 ⇒ 一个空格。
     * 不动：字母与字母之间的空格（"the words" 不能被粘成 "thewords"）。
     */
    // 空白字符必须认全：半角/不换行/全角之外，PDF 里还常见窄空格、发宽空格、零宽空格、制表符、BOM …
    //   （用户语料里 "第三\t\t十三条"、"手机\t\t\t\tAPP" 就是这类 —— 只认 [ \t\u00a0\u3000] 会漏）
    var WS = '[\\s\\u00a0\\u1680\\u2000-\\u200a\\u202f\\u205f\\u3000\\u200b\\ufeff]';
    var CJKc = '[\\u3400-\\u9fff\\uf900-\\ufaff\\u3000-\\u303f\\uff00-\\uffef]';
    var RE_CJK_WS_CJK = new RegExp(CJKc + '{1,}' + WS + '{1,}(?=' + CJKc + ')', 'g');
    var RE_CJK_WS_ALNUM = new RegExp(CJKc + '{1,}' + WS + '{1,}(?=[0-9A-Za-z])', 'g');
    var RE_ALNUM_WS_CJK = new RegExp('([0-9A-Za-z])' + WS + '{1,}(?=' + CJKc + ')', 'g');
    var RE_WS_RUN = new RegExp(WS + '{2,}', 'g');
    function collapseSpaces(s) {
        var t = String(s == null ? '' : s);
        for (var i = 0; i < 5; i++) {
            var n = t
                // 汉字 ↔ 汉字：直接合并（"第三 十三条" ⇒ "第三十三条"）
                .replace(RE_CJK_WS_CJK, function (m) { return m.replace(new RegExp(WS + '+', 'g'), ''); })
                // 汉字 ↔ 数字/字母：也合并（"附件 1" ⇒ "附件1"、"第三 3 条"；
                //   中文正文里汉字与紧随的数字/字母之间留空格多为定位残留，不是排版意图）
                .replace(RE_CJK_WS_ALNUM, function (m) { return m.replace(new RegExp(WS + '+', 'g'), ''); })
                .replace(RE_ALNUM_WS_CJK, function (m) { return m.replace(new RegExp(WS + '+', 'g'), ''); })
                // 数字 ↔ 数字："1 20km/h" ⇒ "120km/h"
                .replace(/([0-9])[ \t\u00a0\u3000]+(?=[0-9])/g, '$1')
                // 其余连续空白：压成一个空格（避免 "APP\t\t\t进行" 这种大空洞）
                .replace(RE_WS_RUN, ' ');
            if (n === t) break;
            t = n;
        }
        return t;
    }

    /** 把一行里的若干块按 X 排序拼起来（中文不加空格、拉丁补空格） */
    function joinRun(parts) {
        var s = '';
        for (var i = 0; i < parts.length; i++) {
            var t = collapseSpaces(String(parts[i] || ''));   // 块内部先清一次（分散对齐的空格常在这里）
            if (!t) continue;
            if (!s) { s = t; continue; }
            s += (needSpace(s.charAt(s.length - 1), t.charAt(0)) ? ' ' : '') + t;
        }
        return collapseSpaces(s);
    }

    /**
     * 自适应行容差：取所有 Y 之间最小正间距的一小部分（一般就是行高）。
     * 避免上下标（±1）被并进同一行、或轻微基线差（±0.5）被拆成两行。
     */
    function autoLineTol(ys, fallback) {
        var u = [], seen = {};
        ys.forEach(function (y) { var k = Math.round(y * 100) / 100; if (!seen[k]) { seen[k] = 1; u.push(y); } });
        u.sort(function (a, b) { return a - b; });
        var min = Infinity;
        for (var i = 1; i < u.length; i++) { var d = u[i] - u[i - 1]; if (d > 0.01 && d < min) min = d; }
        if (!isFinite(min)) return (fallback || 3);
        return Math.max(min * 0.45, Math.min(min * 0.45 + (fallback ? 0 : 0), min * 0.9) || min * 0.45);
    }

    /**
     * 把"带坐标的文字块"聚成视觉行。
     * @param {Array<{x?:number,y?:number,text?:string,rotate?:number,angle?:number,rotated?:boolean}>} boxes
     * @param {{lineTol?:number}} opts
     * @returns {Array<{y:number, text:string, x:number, rotated:boolean, angle:number, n:number}>}
     */
    function linesFromBoxes(boxes, opts) {
        opts = opts || {};
        var _lastY = 0;
        var list = (boxes || []).map(function (b, i) {
            var ang = (typeof b.angle === 'number') ? b.angle : (typeof b.rotate === 'number' ? b.rotate : 0);
            // 【2026-10-03 用户报「OFD 导入后太乱」】**缺坐标的块必须继承上一块的 Y**（原来给 i*1000 ⇒
            //   每块自成一"行"，同行的字被打散到不同行；OFD 里部分块确实没带坐标）。
            var hasY = (typeof b.y === 'number' && isFinite(b.y));
            var y = hasY ? b.y : _lastY;
            _lastY = y;
            return {
                x: (typeof b.x === 'number' && isFinite(b.x)) ? b.x : null,
                y: y,
                size: (typeof b.size === 'number' && b.size > 0) ? b.size : null,
                text: String(b.text == null ? '' : b.text),
                angle: ang,
                rotated: (b.rotated === true) || (Math.abs(ang) > 0.5)
            };
        }).filter(function (b) { return b.text.trim() !== ''; });

        if (!list.length) return [];
        // 【2026-10-03】行容差优先用**字号**（同行的字属于同一字号，|ΔY| < 0.6×字号 即同一行）——
        //   比"最小 Y 间距×0.45"稳得多：逐字块时同行 Y 有细微差、最小间距极小 ⇒ 老算法会把一行拆成多行。
        var _sizes = list.map(function (b) { return b.size; }).filter(function (v) { return typeof v === 'number' && v > 0; })
            .sort(function (a, b) { return a - b; });
        var _sizeMed = _sizes.length ? _sizes[Math.floor(_sizes.length / 2)] : 0;
        var tol = (typeof opts.lineTol === 'number' && opts.lineTol > 0) ? opts.lineTol
            : (_sizeMed > 0 ? Math.max(_sizeMed * 0.6, 0.6) : autoLineTol(list.map(function (b) { return b.y; })));

        // 以 Y 为基准聚行（允许先乱序）。
        // ⚠️ 坐标方向必须区分：**PDF 的 Y 轴朝上**（数值越大越靠上 ⇒ 阅读顺序 = Y 从大到小），
        //   而 OFD 的 Y 轴朝下（从上到下 = 升序）。首版这里一律升序 ⇒ PDF 段落整体**倒序**
        //   （套件 A 组就是这么抓出来的）。由调用方用 flipY 指定。
        var flip = opts.flipY === true;
        list.sort(function (a, b) { return (flip ? (b.y - a.y) : (a.y - b.y)) || (a.x - b.x); });
        var lines = [], cur = null;
        for (var i = 0; i < list.length; i++) {
            var b = list[i];
            if (!cur || Math.abs(b.y - cur.y) > tol) {
                cur = { y: b.y, items: [], rotated: false, angle: 0 };
                lines.push(cur);
            }
            cur.items.push(b);
            if (b.rotated) cur.rotated = true;
            if (Math.abs(b.angle) > Math.abs(cur.angle)) cur.angle = b.angle;
        }
        lines.forEach(function (ln) {
            ln.items.sort(function (a, b) { return a.x - b.x; });
            ln.x = ln.items.length ? ln.items[0].x : 0;
            ln.n = ln.items.length;
            var _joined = joinRun(ln.items.map(function (t) { return t.text; }));
            // 行内页码标记（"…通用规定— — 6 — —"）在**聚行阶段**就清掉：这样 buildDocument、
            // stripRunning、以及任何直接调 paragraphsFromLines 的路径都会生效，不会漏。
            ln.text = stripInlinePageMarks(_joined).text;
        });
        return lines.filter(function (ln) { return ln.text.trim() !== ''; });
    }

    /**
     * 视觉行 ⇒ 自然段（**只在真该换段时**加硬回车；续行一律不加）
     * @returns {Array<{text:string, lines:number, rotated:boolean}>}
     */
    function paragraphsFromLines(lines, opts) {
        opts = opts || {};
        var arr = (lines || []).filter(function (l) { return l && String(l.text || '').trim() !== ''; });
        if (!arr.length) return [];

        // 正常行距 = 相邻行 Y 差里的**最小正间距**（比中位数/平均稳：行数少、或多段间距混在一起时，
        //   中位数会被"段间距"稀释 ⇒ 大间隔判不出来，分段失效 —— 套件 A⑤ 就是这么抓到的）。
        //   再给一个 +3 的绝对下限，避免上下标造成的小间距把阈值压得过低 ⇒ 过度分段。
        var gaps = [];
        for (var i = 1; i < arr.length; i++) {
            var g = Math.abs(arr[i].y - arr[i - 1].y);
            if (g > 0.01) gaps.push(g);
        }
        var sorted = gaps.slice().sort(function (a, b) { return a - b; });
        // 【2026-10-03 用户报「OFD 导入后太乱」】行距估计改用**众数**（出现最频繁的间距）：
        //   碎片化输入（逐字/逐词块）里"最小间距"会极小 ⇒ 阈值过小 ⇒ 每行都成段（正文全被打散）；
        //   "中位数"又会被段间大间距抬高 ⇒ 该分段的不分。只有众数最接近真实的逐行行距。
        var _bucket = {}, _best = 0, _bestN = 0;
        gaps.forEach(function (g) { var k = Math.round(g * 2) / 2; _bucket[k] = (_bucket[k] || 0) + 1; });
        Object.keys(_bucket).forEach(function (k) { if (_bucket[k] > _bestN) { _bestN = _bucket[k]; _best = parseFloat(k); } });
        var normalGap = _best > 0 ? _best : (sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0);
        var bigGap = normalGap > 0 ? Math.max(normalGap * 1.7, normalGap + 2) : Infinity;

        var paras = [], cur = null;
        for (var j = 0; j < arr.length; j++) {
            var ln = arr[j], t = String(ln.text);
            var isNew = true;
            if (cur) {
                var prev = cur.lastText;
                var prevEnded = SENT_END.test(prev);                       // 上一行句子已结束
                var gapBig = Math.abs(ln.y - cur.lastY) >= bigGap;          // 明显大间隔（空行/新段）
                var clause = CLAUSE_HEAD.test(t);                           // 条款/编号/标题开头
                var indent = (ln.x - cur.leftX) > (opts.indentTol || 8);    // 首行缩进
                isNew = prevEnded || gapBig || clause || indent;
            }
            if (isNew) {
                cur = { text: t, lines: 1, rotated: !!ln.rotated, lastText: t, lastY: ln.y, leftX: ln.x, angle: ln.angle || 0 };
                paras.push(cur);
            } else {
                // 续行：**不加硬回车**，直接接上（必要时补一个空格，避免"断词"）
                cur.text += (needSpace(cur.text.charAt(cur.text.length - 1), t.charAt(0)) ? ' ' : '') + t;
                cur.lines++;
                cur.lastText = t; cur.lastY = ln.y;
                if (ln.rotated) cur.rotated = true;
            }
        }
        return paras;
    }

    /**
     * 从 pdf.js 的 items 还原排版。
     * items[i] = { str, transform:[a,b,c,d,e,f], width, height }
     *   · 旋转角 = atan2(b, a)；倾斜文字（如水印）通常就是这里非 0；
     *   · 位置 = (transform[4] 横向, transform[5] 纵向)。
     */
    function fromPdfItems(items, opts) {
        opts = opts || {};
        var boxes = (items || []).filter(function (it) { return it && typeof it.str === 'string' && it.str.trim() !== ''; })
            .map(function (it) {
                var tr = it.transform || [];
                var a = (typeof tr[0] === 'number') ? tr[0] : 1;
                var b = (typeof tr[1] === 'number') ? tr[1] : 0;
                var ang = (a === 0 && b === 0) ? 0 : (Math.atan2(b, a) * 180 / Math.PI);
                if (Math.abs(ang) > 90) ang = ang - (ang > 0 ? 180 : -180);   // 归一化到 -90..90（PDF 里 y 轴朝上，正角常见）
                // 带上字号（pdf.js 的 item.height 即字号）：供"按字号聚行"，比按间距估稳得多
                return { x: tr[4], y: tr[5], text: it.str, angle: ang, size: (typeof it.height === 'number' ? it.height : null) };
            });
        // PDF 的 Y 轴朝上 ⇒ 阅读顺序取 Y 从大到小（flipY）
        var pdfOpts = {};
        for (var k in opts) if (Object.prototype.hasOwnProperty.call(opts, k)) pdfOpts[k] = opts[k];
        pdfOpts.flipY = true;
        var lines = linesFromBoxes(boxes, pdfOpts);
        return { lines: lines, paragraphs: paragraphsFromLines(lines, pdfOpts) };
    }

    // ============ 公文体例：段落分类 + 条款编号后补空格 ============
    var RE_CHAPTER = /^第[一二三四五六七八九十百千0-9]+章/;
    var RE_SECTION = /^第[一二三四五六七八九十百千0-9]+节/;
    var RE_CLAUSE = /^第[一二三四五六七八九十百千0-9]+条/;
    var RE_ITEM = /^[（(][一二三四五六七八九十0-9]+[）)]/;
    var RE_ATTACH = /^(附件\s*[0-9]+|附\s*则|附表|附图)/;
    /**
     * 条款编号后补一个空格："第一条为加强…" ⇒ "第一条 为加强…"。
     * 为什么要补：清空格逻辑会把 PDF 分散对齐留下的"第 一 条"合并（正确），但也会把公文里
     * "第一条 为加强…"本来该有的那一个空格一起吃掉 ⇒ 版式上就成了"第一条为加强"（用户看到的"格式不正常"）。
     * 这里只在**条/章/节/款编号之后紧跟非空白**时补一个空格，不动其它位置。
     */
    function clauseHeadSpace(text) {
        var m = /^(第[一二三四五六七八九十百千0-9]+[章节条款])(?=[^\s])/.exec(text);
        return m ? (m[1] + ' ' + text.slice(m[1].length)) : text;
    }
    /** 段落分类：chapter/section/clause/attach/item/title/body（供渲染层套公文体例样式） */
    function classifyParagraph(text) {
        var t = String(text || '').trim();
        if (!t) return 'body';
        if (RE_CHAPTER.test(t)) return 'chapter';
        if (RE_SECTION.test(t)) return 'section';
        if (RE_CLAUSE.test(t)) return 'clause';
        if (RE_ATTACH.test(t)) return 'attach';
        if (RE_ITEM.test(t)) return 'item';
        // 标题：偏短、且不含句末标点与逗号（正文段落几乎不可能同时满足）
        if (t.length <= 30 && !/[。；：！？]/.test(t) && !/[，,]/.test(t)) return 'title';
        return 'body';
    }
    function formatParagraphs(paras) {
        var out = (paras || []).map(function (p) {
            var t = String((p && p.text) || '').trim();
            var kind = classifyParagraph(t);
            if (kind === 'chapter' || kind === 'section' || kind === 'clause') t = clauseHeadSpace(t);
            // ⚠️ 必须保留 type（块类型）：格式化会把段落块**替换**成这里的返回值，若丢掉 type，
            //   下游 blocksToText/blocksToHtml 就认不出"段落"块了（套件里块序列一度变成 ",table," ＝
            //   两个空类型 + 一个表格，段落全被当成"非表格块"兜底渲染）。
            return { type: 'para', text: t, kind: kind, lines: (p && p.lines) || 1, rotated: !!(p && p.rotated) };
        }).filter(function (p) { return p.text !== ''; });
        // 【2026-10-03 用户报「OFD 导入后太乱」】把"纯标点/极短"的段并回**前一段**：
        //   碎片化输入（逐字块、独立标点框）会产生只有"。"\"部"\"“要求"的独立段，单列成段会让正文
        //   看起来全被打散（用户截图里就是这样）。合并只在"几乎没有正文内容"时发生，不会吃掉信息。
        var NO_TEXT = /[^\s。，、；：！？…—·（）()《》【】“”‘’"'.,;:!?\-\[\]{}<>\/\\|％%＋+＝=、0-9０-９]/;
        var merged = [];
        out.forEach(function (p) {
            var core = p.text.replace(/[\s。，、；：！？…—·（）()《》【】“”‘’"'.,;:!?\-\[\]{}<>\/\\|％%＋+＝=]/g, '');
            var tiny = (core.length <= 2 && p.text.length <= 8);
            if (tiny && merged.length) {
                var prev = merged[merged.length - 1];
                prev.text = (prev.text + p.text).replace(/\s+/g, '');
                prev.kind = classifyParagraph(prev.text);
                return;
            }
            merged.push(p);
        });
        // 若第一段本身就是碎片（前面没有可并入的段落）⇒ 并到后一段开头
        while (merged.length > 1 && merged[0].text.replace(NO_TEXT, '').length === 0 && merged[0].text.length <= 8) {
            merged[1].text = (merged[0].text + merged[1].text).replace(/\s+/g, '');
            merged[1].kind = classifyParagraph(merged[1].text);
            merged.shift();
        }
        return merged;
    }

    // ============ 表格还原（2026-10-04） ============
    // 用户语料里的附件台账（附件2/3/4）导进来是一团文字："1兰新下左58.450 58.800 350砼柱金属网2.3刺丝滚笼堤2021年改造兰州西示例"
    //   原因是表格在 PDF/OFD 里只是"一堆带坐标的文字块"，行内拼接把列都粘在了一起。
    // 这里按**坐标**把文字块聚成"行 × 列"：
    //   ① 判断一行里有哪些"单元格"：相邻文字块的起点间距 > 平均字宽 × 2.2 ⇒ 认为跨了列；
    //      （平均字宽用 (最右-最左)/总字数 现场估，不依赖单位 —— PDF 用点、OFD 用毫米都能算）
    //   ② 连续 ≥3 行且每行都有 ≥3 个单元格 ⇒ 认定是表格区域；
    //   ③ 列位置聚类得到列边界，单元格各归其列，空单元格留空 —— 输出可读的表格骨架。
    function estAvgAdv(items) {
        if (!items || items.length < 2) return 0;
        var minX = Infinity, maxX = -Infinity, chars = 0;
        items.forEach(function (b) {
            if (b.x < minX) minX = b.x;
            if (b.x > maxX) maxX = b.x;
            chars += Math.max(1, String(b.text || '').length);
        });
        return (maxX - minX) / Math.max(1, chars);
    }
    /** 一行 ⇒ 单元格数组（每个单元格是若干文字块） */
    function cellsOfLine(line, opts) {
        opts = opts || {};                 // ⚠️ 必须兜底：下面要读 opts.colGapChars，不兜底会在无参调用时直接抛错
        var raw = ((line && line.items) || []).slice().sort(function (a, b) { return a.x - b.x; });
        if (!raw.length) return [];
        var adv0 = estAvgAdv(raw);
        // 【必须先处理"块内部的列分隔"】用户的附件台账常常整行只有**一个**文字块，
        //   列与列之间是块文本里的制表符/大段空白（"1兰新\t\t\t\t下左\t\t58.450…"）。
        //   只在块与块之间找间距 ⇒ 一个块 ⇒ 一个格子 ⇒ 表格永远识别不出来（"有些表格未转化"就是这个）。
        var items = [];
        var RE_INNER = new RegExp(WS + '{2,}|' + WS + '*\\t' + WS + '*');
        for (var ii = 0; ii < raw.length; ii++) {
            var it = raw[ii], txt = String(it.text || '');
            var parts = txt.split(RE_INNER);
            if (parts.length <= 1) { items.push(it); continue; }
            var consumed = 0, advUse = adv0 || 1;
            for (var pi = 0; pi < parts.length; pi++) {
                var p2 = parts[pi];
                if (p2) items.push({ x: it.x + consumed * advUse, text: p2 });
                consumed += p2.length + 1;           // +1 近似表示被吞掉的分隔空白
            }
        }
        items.sort(function (a, b) { return a.x - b.x; });
        var adv = estAvgAdv(items) || adv0;
        // 【兜底】若上面没能切出 2 格以上，但**整行文本里**本来就有制表符/连续空白（整行只有一个文字块的情形），
        //   就按这些空白再切一次。用户的附件台账正是这种："1兰新\t\t左\t\t58.450\t\t砼柱金属网" 是一个块。
        if ((function () {
            var n = 0, last = -Infinity;
            for (var q = 0; q < items.length; q++) {
                if (Math.abs(items[q].x - last) > (adv ? adv * 2.2 : 1) && q > 0) n++;
                last = items[q].x;
            }
            return n < 1;                     // 切点不足 ⇒ 需要兜底
        })()) {
            var rawText = raw.map(function (i3) { return String(i3.text || ''); }).join('');
            var partsFb = rawText.split(RE_INNER).filter(function (s) { return s !== ''; });
            if (partsFb.length >= 2) {
                var advFb = adv0 || 1, acc = 0, x0 = raw[0] ? raw[0].x : 0;
                return partsFb.map(function (p3) {
                    var cell = [{ x: x0 + acc * advFb, text: p3 }];
                    acc += p3.length + 1;
                    return cell;
                });
            }
        }
        var thr = (typeof opts.colGapChars === 'number' ? opts.colGapChars : 2.2) * (adv || 1);
        var cells = [[items[0]]];
        for (var i = 1; i < items.length; i++) {
            var gap = items[i].x - items[i - 1].x;
            if (adv > 0 && gap > thr) cells.push([]);
            cells[cells.length - 1].push(items[i]);
        }
        // 【兜底·最终】按"文本里的制表符/连续空白"再切一遍，**取格子更多的那个方案**。
        //   为什么放在最后：用户台账常见"整行就是一个文字块、列间是 \t 或大段空白"，
        //   只按坐标找列会得到 1 格；只按文本切又可能把"正文里两个空格"误当列。
        //   两个方案都算一遍、取格子多的，规则简单、可解释，且不会让原本正确的情况变差。
        var _rawText = raw.map(function (i9) { return String(i9.text || ''); }).join('');
        var _partsFb = _rawText.split(RE_INNER).filter(function (s) { return s !== ''; });
        if (_partsFb.length > cells.length) {
            var _acc = 0, _x0 = raw[0] ? raw[0].x : 0, _adv = adv0 || 1;
            return _partsFb.map(function (p9) {
                var c9 = [{ x: _x0 + _acc * _adv, text: p9 }];
                _acc += p9.length + 1;
                return c9;
            });
        }
        return cells;
    }
    function cellText(cell) { return joinRun((cell || []).map(function (b) { return b.text; })); }
    /**
     * 逐行扫描 ⇒ 有序块序列：[{type:'para', text}...] 与 [{type:'table', rows:[[..]], cols:n}]
     * 表格区域前后的文字行照常按段落还原；表格本身保持原样插在中间。
     */
    function linesToBlocks(lines, opts) {
        opts = opts || {};
        // 行数门槛=3：用户附件2 是"表头 + 2 行数据"= 3 行，正好够；两行"碰巧对齐"不足以判定为表。
        //   另有两道体检（≥3 列对齐 / 首格要短 / 单元格普遍偏短），见下 —— 防止把段落误判成表格。
        var minRows = (typeof opts.minTableRows === 'number') ? opts.minTableRows : 3;
        var minCells = (typeof opts.minTableCells === 'number') ? opts.minTableCells : 3;
        var arr = (lines || []).filter(function (l) { return l && String(l.text || '').trim() !== ''; });
        var rowsCells = arr.map(function (l) { return cellsOfLine(l, opts); });
        var blocks = [], pending = [], i = 0;
        function flushPending() {
            if (!pending.length) return;
            var paras = paragraphsFromLines(pending, opts);
            paras.forEach(function (p) { blocks.push({ type: 'para', text: p.text, kind: p.kind || 'body', lines: p.lines }); });
            pending = [];
        }
        while (i < arr.length) {
            var rc = rowsCells[i];
            if (rc.length >= minCells) {
                // 往后找连续的"多列行"，看长度是否够成表
                var j = i, region = [];
                while (j < arr.length && rowsCells[j].length >= 2) { region.push(rowsCells[j]); j++; }
                var wide = region.filter(function (r) { return r.length >= minCells; }).length;
                if (region.length >= minRows && wide >= minRows) {
                    // 列位置聚类（用每个单元格首块的 x），并统计每列被多少行命中
                    var anchors = [];
                    region.forEach(function (r) {
                        var seen = {};
                        r.forEach(function (c) {
                            if (!c.length) return;
                            var x = c[0].x, hit = -1;
                            for (var k = 0; k < anchors.length; k++) {
                                if (Math.abs(anchors[k].x - x) <= (opts.colTol || 6)) { hit = k; break; }
                            }
                            if (hit < 0) {
                                anchors.push({ x: x, count: 0 });
                                anchors.sort(function (a, b) { return a.x - b.x; });
                                hit = anchors.findIndex(function (a) { return a.x === x; });
                            }
                            if (!seen[hit]) { seen[hit] = 1; anchors[hit].count++; }   // 同一行同一列只算一次
                        });
                    });
                    // 【判据收紧】至少 **3 列**跨行对齐才算表格。
                    //   ⚠️ 上一版只要求 2 列 ⇒ 段落因为**左缩进相同**天然满足第一列，很容易被误判成表格
                    //   （用户报："（三）桥梁应急疏散通道兼作作业门时，……" 被改成了表格）。
                    var aligned = anchors.filter(function (a) { return a.count >= minRows; }).length;
                    // 再加一道"像表格而不是像句子"的体检：每行首格要短、整行格数要多、单元格普遍偏短。
                    var looksTable = region.every(function (r) {
                        if (r.length < 3) return false;
                        if (String(cellText(r[0]) || '').length > 16) return false;     // 首格像句子 ⇒ 不是表格
                        return true;
                    });
                    var lens = [];
                    region.forEach(function (r) { r.forEach(function (c) { lens.push(String(cellText(c) || '').length); }); });
                    lens.sort(function (a, b) { return a - b; });
                    var medLen = lens.length ? lens[Math.floor(lens.length / 2)] : 0;
                    if (aligned >= 3 && looksTable && medLen <= 12) {
                        flushPending();
                        var cols = Math.max(anchors.length, 1);
                        var grid = region.map(function (r) {
                            var line = [];
                            for (var c2 = 0; c2 < cols; c2++) line.push('');
                            r.forEach(function (c) {
                                if (!c.length) return;
                                var x = c[0].x, best = 0, bestD = Infinity;
                                for (var k2 = 0; k2 < anchors.length; k2++) {
                                    var d = Math.abs(anchors[k2].x - x);
                                    if (d < bestD) { bestD = d; best = k2; }
                                }
                                var t = cellText(c);
                                line[best] = line[best] ? (line[best] + ' ' + t) : t;
                            });
                            return line;
                        });
                        blocks.push({ type: 'table', rows: grid, cols: cols });
                        i = j;
                        continue;
                    }
                }
            }
            pending.push(arr[i]);
            i++;
        }
        flushPending();
        return blocks;
    }
    function blocksToText(blocks, opts) {
        opts = opts || {};
        return (blocks || []).map(function (b) {
            if (b.type === 'table') {
                return b.rows.map(function (r) { return r.join(' | ').replace(/\s+\|\s*$/, ''); }).join('\n');
            }
            return String(b.text || '');
        }).filter(function (t) { return String(t).trim() !== ''; }).join('\n');
    }
    /**
     * 多页（已清理过的）行 ⇒ 文档块：段落按公文体例格式化 + **跨页段落合并** + 表格识别。
     * PDF 与 OFD 共用这一条（用户要求"PDF 的修改一并应用到 OFD"）。
     * @returns {{text:string, blocks:Array, paragraphs:Array, tableCount:number}}
     */
    function buildFromPageLines(pageLines, opts) {
        opts = opts || {};
        var pageBlocks = (pageLines || []).map(function (lines) { return linesToBlocks(lines, opts); });
        // 段落公文体例格式化（表格块原样保留）
        pageBlocks = pageBlocks.map(function (bs) {
            return bs.map(function (b) {
                if (b.type !== 'para') return b;
                var f = formatParagraphs([b])[0];
                return f || b;
            });
        });
        // 跨页段落合并：只处理"上一页最后一块/下一页第一块都是段落"的情形（表格不参与）
        for (var p = 0; p + 1 < pageBlocks.length; p++) {
            var last = pageBlocks[p][pageBlocks[p].length - 1];
            var first = pageBlocks[p + 1][0];
            if (!last || !first || last.type !== 'para' || first.type !== 'para') continue;
            var lt = String(last.text || '').replace(/\s+$/, '');
            var ft = String(first.text || '');
            if (SENT_END.test(lt) || CLAUSE_HEAD.test(ft)) continue;
            last.text = lt + (needSpace(lt.charAt(lt.length - 1), ft.charAt(0)) ? ' ' : '') + ft;
            last.lines = (last.lines || 1) + (first.lines || 1);
            if (last.kind === 'body' && first.kind && first.kind !== 'body') last.kind = first.kind;
            pageBlocks[p + 1].shift();
        }
        var blocks = [];
        pageBlocks.forEach(function (bs) { blocks = blocks.concat(bs); });
        var paragraphs = blocks.filter(function (b) { return b.type === 'para'; });
        return {
            text: blocksToText(blocks), blocks: blocks, paragraphs: paragraphs,
            tableCount: blocks.filter(function (b) { return b.type === 'table'; }).length
        };
    }

    /** 块序列 ⇒ HTML：段落走公文体例，表格输出真正的 <table>（可横向滚动、不撑破版面） */
    function blocksToHtml(blocks, opts) {
        return (blocks || []).map(function (b) {
            if (b.type === 'table') {
                var head = b.rows[0] || [];
                var body = b.rows.slice(1);
                var h = head.map(function (c) { return '<th>' + esc(c) + '</th>'; }).join('');
                var bd = body.map(function (r) {
                    return '<tr>' + r.map(function (c) { return '<td>' + esc(c) + '</td>'; }).join('') + '</tr>';
                }).join('');
                return '<div class="imp-table-wrap"><table class="imp-table"><thead><tr>' + h + '</tr></thead><tbody>' + bd + '</tbody></table></div>';
            }
            var kind = b.kind || 'body';
            var inner = esc(b.text || '');
            if (kind === 'chapter' || kind === 'section' || kind === 'clause') {
                var m = /^(第[一二三四五六七八九十百千0-9]+[章节条款])/.exec(b.text || '');
                if (m) inner = '<b>' + esc(m[1]) + '</b>' + esc(String(b.text || '').slice(m[1].length));
            }
            return '<p class="imp-p imp-' + kind + '">' + inner + '</p>';
        }).join('');
    }

    function esc(s) {
        return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
            .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }
    /**
     * 段落数组 ⇒ HTML（带公文体例 class）：
     *   .imp-p 通用（首行缩进 2 字、两端对齐、1.8 倍行距）
     *   .imp-chapter/.imp-section/.imp-clause 条款标题（不缩进、编号加粗）
     *   .imp-title 居中标题；.imp-attach 附件标题；.imp-item 列表项（悬挂缩进）
     * 样式在 index.html 的内联 <style>（.imp-* 段）里，随主页面一起离线缓存。
     */
    function paragraphsToHtml(paras) {
        return (paras || []).map(function (p) {
            var t = String((p && p.text) || ''), kind = (p && p.kind) || 'body';
            var inner = esc(t);
            if (kind === 'chapter' || kind === 'section' || kind === 'clause') {
                var m = /^(第[一二三四五六七八九十百千0-9]+[章节条款])/.exec(t);
                if (m) inner = '<b>' + esc(m[1]) + '</b>' + esc(t.slice(m[1].length));
            }
            return '<p class="imp-p imp-' + kind + '">' + inner + '</p>';
        }).join('');
    }

    /** 把段落数组拼成最终正文（段间 **一个** 硬回车；段内没有硬回车） */
    function toText(paras) {
        return (paras || []).map(function (p) { return String(p.text || '').trim(); })
            .filter(function (t) { return t !== ''; }).join('\n');
    }

    /**
     * 跨页清理：剔除**页码 / 页眉 / 页脚 / 水印戳**（2026-10-03 用户给的实测语料就是这么露出来的）
     * 语料证据：
     *   · 每页都夹着页码行 "— — 1 — —"；
     *   · 页脚/末尾有打印水印戳 "10.211.6.89 lanzhl-dujianchun 610219 2026-07-10 02:13:41"
     *     （IP + 用户名 + 机器码 + 时间 ⇒ 属"倾斜排版的水印"那一类，用户要求清掉）；
     *   · 页眉还有规章编号 "LZG/GW213 - 2026"。
     * 判据：
     *   ① 纯页码行（"—— 1 ——"、"第 1 页"、"1/3"）⇒ 直接删；
     *   ② 水印戳行（含 IPv4 或 "YYYY-MM-DD HH:MM(:SS)"，且短、且不含句末标点）⇒ 直接删；
     *   ③ **跨页重复**：每页顶部/底部各取 2 行，归一化（数字与分隔符抹掉）后计数，
     *      出现在 ≥ max(2, 页数×0.6) 页的 ⇒ 判定为页眉/页脚，逐页删掉。
     */
    function normRunning(text) {
        return collapseSpaces(text)
            .replace(/[0-9０-９]+/g, '#')
            .replace(/[\s—–\-·．.、,，|│]+/g, '')
            .slice(0, 40);
    }
    function isPageNumberLine(text) {
        var t = collapseSpaces(text).trim();
        if (!t) return false;
        return /^[—\-–\s]*[0-9０-９]{1,4}[—\-–\s]*$/.test(t)
            || /^第\s*[0-9０-９]{1,4}\s*页(\s*共\s*[0-9０-９]{1,4}\s*页)?$/.test(t)
            || /^[—\-–]?\s*[0-9０-９]{1,4}\s*\/\s*[0-9０-９]{1,4}\s*[—\-–]?$/.test(t);
    }
    function isStampLine(text) {
        var t = collapseSpaces(text).trim();
        if (!t || t.length > 80) return false;
        var hasIp = /\b[0-9]{1,3}(\.[0-9]{1,3}){3}\b/.test(t);
        var hasStamp = /[0-9]{4}-[0-9]{2}-[0-9]{2}\s+[0-9]{2}:[0-9]{2}(:[0-9]{2})?/.test(t);
        if (!hasIp && !hasStamp) return false;
        return !/[。；！？]/.test(t);          // 不含句末标点 ⇒ 不是正文句子
    }
    /** 整行只要"几乎只剩水印戳/页码"（去掉数字与空白后长度很短）也判为水印戳行 */
    function isAlmostStampOnly(text) {
        var t = collapseSpaces(text);
        if (!/\b[0-9]{1,3}(\.[0-9]{1,3}){3}\b|[0-9]{4}-[0-9]{2}-[0-9]{2}/.test(t)) return false;
        var left = t.replace(WM_TOKEN, '').replace(/[\s0-9:.\-—–]/g, '');
        return left.length <= 4;               // 剩下的基本都是符号/极短 ⇒ 当水印戳整行丢弃
    }
    // 行内页码标记（2026-10-03 用户语料）："第十九条防护栅栏设置通用规定— — 6 — —"
    //   ⇒ 页码标记和正文**粘在同一行**，原来只删"整行都是页码"的情况，残留的 "— — 6 — —" 会留在正文里，
    //   还会把段落撑断（下一页接不上）。这里把它从行内剔除。
    // ⚠️ 只认"两侧带破折号"的**无歧义**形式："— — 6 — —" / "– 12 –"。
    //   千万不要顺手把「第 N 页」也删掉 —— 正文里"本条为第1页专有正文…"会被误抠成"本条为专有正文…"
    //   （套件 A⑩ 当场抓到）。
    var INLINE_PAGEMARK = /[\u2014\u2013]{1,2}\s*[\u2014\u2013]{0,2}\s*[0-9０-９]{1,4}\s*[\u2014\u2013]{1,2}\s*[\u2014\u2013]{0,2}/g;
    // 水印戳标记（打印系统盖的 IP/用户名/机器码/时间戳）：**行内任意位置**都剔掉 —— 用户语料末尾就残留了
    //   "2026-07-1002:13:41"（日期与时间**之间没有空格**，原来的整行判定要求 \s+ 所以没命中）。
    var WM_TOKEN = /(\b[0-9]{1,3}(\.[0-9]{1,3}){3}\b)|([0-9]{4}-[0-9]{2}-[0-9]{2}[T\s]?[0-9]{2}:[0-9]{2}(:[0-9]{2})?)/g;
    function stripInlinePageMarks(text) {
        var t = String(text == null ? '' : text);
        var before = collapseSpaces(t);
        t = collapseSpaces(t.replace(INLINE_PAGEMARK, ' ').replace(WM_TOKEN, ' '));
        return { text: t, changed: t !== before };
    }

    /**
     * 【跨页段落合并】上一页最后一段若不是"句子已结束"，且下一页第一段不是条款/标题开头
     *   ⇒ 说明这一段**跨页被切成两段**，合并回一段（用户 2026-10-03 报的问题）。
     * 判据与段内续行一致：只在句末标点/条款头处断开；页眉页脚与页码此时已被剔除，所以拼接是干净的。
     * @param {Array<Array<{text:string,lines:number}>>} pagesParagraphs 每页的段落数组
     */
    function mergePages(pagesParagraphs, opts) {
        opts = opts || {};
        var out = [];
        (pagesParagraphs || []).forEach(function (paras) {
            paras = (paras || []).slice();
            if (!paras.length) return;
            // 与上一页末尾相接：没结束就并进去
            if (out.length) {
                var prev = out[out.length - 1];
                var first = paras[0];
                var prevText = String(prev.text || '').replace(/\s+$/, '');
                var firstText = String(first.text || '');
                var prevEnded = SENT_END.test(prevText);
                var newClause = CLAUSE_HEAD.test(firstText);
                if (!prevEnded && !newClause) {
                    prev.text = prevText + (needSpace(prevText.charAt(prevText.length - 1), firstText.charAt(0)) ? ' ' : '') + firstText;
                    prev.lines = (prev.lines || 1) + (first.lines || 1);
                    paras = paras.slice(1);
                }
            }
            for (var i = 0; i < paras.length; i++) out.push(paras[i]);
        });
        return out;
    }

    /** @param {Array<Array<{text:string,y:number,x:number}>>} pages 每页的行 */
    function stripRunning(pages, opts) {
        opts = opts || {};
        var zone = (typeof opts.zone === 'number') ? opts.zone : 2;
        var nPages = (pages || []).length;
        var counts = {}, exactCounts = {}, removed = [];
        (pages || []).forEach(function (lines) {
            // ⚠️ 必须按**行下标去重**：页面行数 ≤ 2·zone 时，"顶部 zone 行"和"底部 zone 行"会重叠，
            //   直接拼接会把同一行数两次 ⇒ 正文行被误判成"多页都出现的页眉"删掉
            //   （ofd 套件里 2 页、每页 1~3 行的语料当场就把 BODY2 删没了）。
            var idx = {}, cand = [];
            (lines || []).forEach(function (l, i) {
                var isEdge = (i < zone) || (i >= lines.length - zone);
                if (isEdge && !idx[i]) { idx[i] = 1; cand.push(l); }
            });
            cand.forEach(function (l) {
                var t = collapseSpaces((l && l.text) || '').trim();
                var k = normRunning(t);
                if (k && k.length >= 2) counts[k] = (counts[k] || 0) + 1;
                if (t) exactCounts[t] = (exactCounts[t] || 0) + 1;
            });
        });
        var need = Math.max(2, Math.ceil(nPages * 0.6));
        var clean = (pages || []).map(function (lines) {
            var out = [];
            (lines || []).forEach(function (l, i) {
                var t = String((l && l.text) || '');
                var tt = collapseSpaces(t).trim();
                if (isPageNumberLine(t)) { removed.push('页码行「' + tt.slice(0, 20) + '」'); return; }
                if (isStampLine(t) || isAlmostStampOnly(t)) { removed.push('水印戳「' + tt.slice(0, 40) + '」'); return; }
                // 行内页码标记已在"聚行阶段"（linesFromBoxes）统一清掉，这里不再重复处理；
                var isEdge = (i < zone) || (i >= lines.length - zone);
                var k = normRunning(t);
                // 【判别要收紧】原先把"普通行只差数字"也算重复 ⇒ 像"本条为第1页专有正文…"这种
                //   每页只差页码的**正文**会被误删（套件 A⑩ 抓到的真 bug）。现在：
                //   ① 原文**逐字相同**且出现在 ≥need 页 ⇒ 页眉页脚（无数字的页眉靠这条）；
                //   ② 归一化（数字→#）相同且出现在 ≥need 页、**且归一化后很短（≤12 字）** ⇒ 才是
                //      页码/单位名之类的页眉页脚；长行不算（正文里带个数字很常见）。
                var dup = (exactCounts[tt] >= need) || (counts[k] >= need && k.length <= 12);
                if (isEdge && dup) {
                    removed.push('页眉/页脚重复行「' + tt.slice(0, 24) + '」（' + Math.max(exactCounts[tt] || 0, counts[k] || 0) + '/' + nPages + ' 页）');
                    return;
                }
                out.push(l);
            });
            return out;
        });
        return { pages: clean, removed: removed };
    }

    /**
     * 一站式：多页 items ⇒ 正文
     *   = 行内清空格（分散对齐）+ 聚行 + 段落还原 + 丢弃倾斜水印 + 跨页去页眉页脚/页码/水印戳
     */
    function buildDocument(pagesItems, opts) {
        opts = opts || {};
        var perPage = [], rotatedDropped = 0;
        (pagesItems || []).forEach(function (items) {
            var r = fromPdfItems(items, opts);
            var good = [];
            r.lines.forEach(function (l) { if (l.rotated) rotatedDropped++; else good.push(l); });
            perPage.push(good);
        });
        var st = stripRunning(perPage, opts);
        var built = buildFromPageLines(st.pages, opts);
        return {
            text: built.text,
            blocks: built.blocks,
            paragraphs: built.paragraphs,
            rotatedDropped: rotatedDropped,
            removed: st.removed, pageCount: st.pages.length
        };
    }

    window.ImportLayout = {
        buildDocument: buildDocument,
        buildFromPageLines: buildFromPageLines,
        linesToBlocks: linesToBlocks,
        cellsOfLine: cellsOfLine,          // 供套件直接量"一行被切成几个格子"
        blocksToText: blocksToText,
        blocksToHtml: blocksToHtml,
        stripRunning: stripRunning,
        stripInlinePageMarks: stripInlinePageMarks,
        mergePages: mergePages,
        formatParagraphs: formatParagraphs,
        paragraphsToHtml: paragraphsToHtml,
        classifyParagraph: classifyParagraph,
        clauseHeadSpace: clauseHeadSpace,
        collapseSpaces: collapseSpaces,
        isPageNumberLine: isPageNumberLine,
        isStampLine: isStampLine,
        linesFromBoxes: linesFromBoxes,
        paragraphsFromLines: paragraphsFromLines,
        fromPdfItems: fromPdfItems,
        toText: toText,
        joinRun: joinRun,
        needSpace: needSpace,
        SENT_END: SENT_END,
        CLAUSE_HEAD: CLAUSE_HEAD,
        version: '1.0'
    };
})();
