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
    function collapseSpaces(s) {
        var t = String(s == null ? '' : s);
        for (var i = 0; i < 4; i++) {
            var n = t
                .replace(/([\u3400-\u9fff\uf900-\ufaff])[ \t\u00a0\u3000]+([\u3400-\u9fff\uf900-\ufaff])/g, '$1$2')
                .replace(/([0-9])[ \t\u00a0\u3000]+([0-9])/g, '$1$2')
                .replace(/[ \t\u00a0]{2,}/g, ' ');
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
        return (paras || []).map(function (p) {
            var t = String((p && p.text) || '').trim();
            var kind = classifyParagraph(t);
            if (kind === 'chapter' || kind === 'section' || kind === 'clause') t = clauseHeadSpace(t);
            return { text: t, kind: kind, lines: (p && p.lines) || 1, rotated: !!(p && p.rotated) };
        }).filter(function (p) { return p.text !== ''; });
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
    // 行内页码标记（2026-10-03 用户语料）："第十九条防护栅栏设置通用规定— — 6 — —"
    //   ⇒ 页码标记和正文**粘在同一行**，原来只删"整行都是页码"的情况，残留的 "— — 6 — —" 会留在正文里，
    //   还会把段落撑断（下一页接不上）。这里把它从行内剔除。
    // ⚠️ 只认"两侧带破折号"的**无歧义**形式："— — 6 — —" / "– 12 –"。
    //   千万不要顺手把「第 N 页」也删掉 —— 正文里"本条为第1页专有正文…"会被误抠成"本条为专有正文…"
    //   （套件 A⑩ 当场抓到）。
    var INLINE_PAGEMARK = /[\u2014\u2013]{1,2}\s*[\u2014\u2013]{0,2}\s*[0-9０-９]{1,4}\s*[\u2014\u2013]{1,2}\s*[\u2014\u2013]{0,2}/g;
    function stripInlinePageMarks(text) {
        var t = String(text == null ? '' : text);
        var before = collapseSpaces(t);
        t = collapseSpaces(t.replace(INLINE_PAGEMARK, ' '));
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
                if (isStampLine(t)) { removed.push('水印戳「' + tt.slice(0, 40) + '」'); return; }
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
        var perPageParas = st.pages.map(function (lines) { return paragraphsFromLines(lines, opts); });
        // 【跨页段落合并】必须在"每页成段之后、拼全文之前"做：否则页尾没写完的段落会被页边界切成两段；
        // 合并后再做**公文体例格式化**（分类 + 条款编号后补空格），渲染层按 kind 套样式。
        var paras = formatParagraphs(mergePages(perPageParas, opts));
        return {
            text: toText(paras),
            paragraphs: paras, rotatedDropped: rotatedDropped,
            removed: st.removed, pageCount: st.pages.length
        };
    }

    window.ImportLayout = {
        buildDocument: buildDocument,
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
