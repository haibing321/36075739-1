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

    /** 把一行里的若干块按 X 排序拼起来（中文不加空格、拉丁补空格） */
    function joinRun(parts) {
        var s = '';
        for (var i = 0; i < parts.length; i++) {
            var t = String(parts[i] || '');
            if (!t) continue;
            if (!s) { s = t; continue; }
            s += (needSpace(s.charAt(s.length - 1), t.charAt(0)) ? ' ' : '') + t;
        }
        return s;
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
        var list = (boxes || []).map(function (b, i) {
            var ang = (typeof b.angle === 'number') ? b.angle : (typeof b.rotate === 'number' ? b.rotate : 0);
            return {
                x: (typeof b.x === 'number' && isFinite(b.x)) ? b.x : 0,
                y: (typeof b.y === 'number' && isFinite(b.y)) ? b.y : (i * 1000),   // 缺坐标：按原顺序逐块成行
                text: String(b.text == null ? '' : b.text),
                angle: ang,
                rotated: (b.rotated === true) || (Math.abs(ang) > 0.5)
            };
        }).filter(function (b) { return b.text.trim() !== ''; });

        if (!list.length) return [];
        var tol = (typeof opts.lineTol === 'number' && opts.lineTol > 0) ? opts.lineTol : autoLineTol(list.map(function (b) { return b.y; }));

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
            ln.text = joinRun(ln.items.map(function (t) { return t.text; }));
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
        var normalGap = sorted.length ? sorted[0] : 0;
        var bigGap = normalGap > 0 ? Math.max(normalGap * 1.7, normalGap + 3) : Infinity;

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
                return { x: tr[4], y: tr[5], text: it.str, angle: ang };
            });
        // PDF 的 Y 轴朝上 ⇒ 阅读顺序取 Y 从大到小（flipY）
        var pdfOpts = {};
        for (var k in opts) if (Object.prototype.hasOwnProperty.call(opts, k)) pdfOpts[k] = opts[k];
        pdfOpts.flipY = true;
        var lines = linesFromBoxes(boxes, pdfOpts);
        return { lines: lines, paragraphs: paragraphsFromLines(lines, pdfOpts) };
    }

    /** 把段落数组拼成最终正文（段间 **一个** 硬回车；段内没有硬回车） */
    function toText(paras) {
        return (paras || []).map(function (p) { return String(p.text || '').trim(); })
            .filter(function (t) { return t !== ''; }).join('\n');
    }

    window.ImportLayout = {
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
