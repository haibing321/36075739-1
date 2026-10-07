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
    var RE_HEAD_TAIL = /(方面|情况|问题|要求|措施|建议|做法|安排|部署|小结)$/;
    /**
     * 【2026-10-07 用户报「标题与正文未换行」】判断**上一行本身**是否"独占一行的标题 / 小标题"。
     *
     * 真机实证（兰州局通报 OFD，4 页）：`一、作业标准执行方面`（10 字、无句末标点）与其下一行
     *   `9月16日22时25分，兰州车站进站口4号安检查危仪处…` 的行距**完全正常**（10.202，与其它行一致）、
     *   x 也一致（都缩进 2 字，"indent" 判据失效）⇒ 原有的四个换段判据（上一行句末标点 / 大行距 /
     *   下一行是条款头 / 下一行缩进）**全不成立** ⇒ 标题被当成正文续行合并
     *   ⇒ 转换结果成了"一、作业标准执行方面9月16日22时25分，…"（用户报的"未换行"）。
     *   修法：把"上一行是标题式短行"也作为换段信号（标题行天然应独占一段）。
     *
     * 判据保守（宁可少断，不可把正文行误判成标题 —— 正文的中间续行同样常不以标点结尾）：
     *   · 短（≤24 字）且**不以句末标点结尾**（后者由 prevEnded 处理，不重复）；
     *   · **去掉行首编号后不含逗号/顿号/分号**（"一、加强领导，各单位要…"这类是正文，不断开）；
     *   · 形态确属标题：编号式（一、/（一）/1./第X条…）—— 或**很短（≤14 字）**且以"…方面/情况/要求"
     *     等小标题词结尾（覆盖不带编号的小标题）。
     */
    function isHeadOnly(t) {
        var s = String(t == null ? '' : t).trim();
        if (!s || s.length > 24) return false;
        if (SENT_END.test(s)) return false;
        var body = s.replace(CLAUSE_HEAD, '');
        // ① 强形态：编号式短行 + 去编号后**无任何分隔标点**（"一、加强领导，各单位要…"这类正文会被挡掉）
        if (!/[，,、；;]/.test(body) && CLAUSE_HEAD.test(s)) return true;
        // ② 弱形态：编号式短行 + 以"…方面/情况/要求"等小标题词结尾（**容忍顿号**）。
        //   真机实证：`四、防溜、消防和劳动安全措施管控方面` 的**标题词本身就含顿号**，被 ① 的
        //   "无分隔标点"条件排除 ⇒ 没独立成行（用户当场发现"应该是四个小标题"，只有三个生效）。
        //   仍挡逗号 / 分号：正文行"一、加强领导，各单位要严格落实要求"含逗号 ⇒ 不会被误判（它有逗号）。
        if (!/[，,；;]/.test(body) && CLAUSE_HEAD.test(s) && RE_HEAD_TAIL.test(s)) return true;
        // ③ 未带编号的小标题："作业标准执行方面"（≤14 字且以标题词结尾）
        return s.length <= 14 && RE_HEAD_TAIL.test(s);
    }

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
                var prevHead = isHeadOnly(prev);                            // 上一行本身是"独占式标题/小标题"（见 isHeadOnly 注释·真机实证）
                isNew = prevEnded || gapBig || clause || indent || prevHead;
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
     * 【2026-10-07 新增】"**两列版式**"识别 —— 技术作业程序图（流程图）这类。
     *
     * 真机实证（《铁路车号员作业标准》PDF 第 3-5 页）：程序图在 PDF 里是**二维**的 ——
     *   左列 x≈105 是阶段名（"一、收取确报""二、核对现车及票据"…），右列 x≈277~344 是步骤名
     *   （"1.准备作业""2.接收票据"…），二者**不同行**（左列顶格在阶段的起始行、右列每步一行）。
     *   按行线性化后必然"交错乱序"：`1.分放票据 / 一、票据管理 / 2.管理现车`（用户报的现象），
     *   而且同一文字在图上出现两次（阶段名与方框名）⇒ 还会出现"一、准备作业准备作业"这类**重复**。
     *
     * 判据（保守，专防"缩进段落被误判"）：
     *   · 连续行，每行**最多 2 格**、文本**短（≤10 字）**且**不以标点收尾**（流程图文字不带句号）；
     *   · 遇到小节标题（"2.2 始发列车技术作业程序图"）或 ≥3 格行（那是表格的地盘）**立即结束区域**；
     *   · 区域 ≥4 行，且格子的 x 能分成**左右两簇**（间距 ≥40pt —— 缩进段落的 11pt 差会被挡掉），
     *     两簇**各自覆盖 ≥3 行**，并**至少 1 行同时含左右两列**（并列版式的特征）。
     * @returns {{rows:Array<Array<string>>, end:number}|null}
     */
    function twoColRegion(arr, rowsCells, i, opts) {
        var j = i, cand = [];
        while (j < arr.length) {
            var r = rowsCells[j];
            if (!r.length || r.length > 2) break;                       // 3 格以上 ⇒ 交给表格识别
            var t = String(arr[j].text || '').trim();
            if (!t || t.length > 10) break;                             // 偏长（标题/正文）⇒ 结束
            if (/[。；，,、：]$/.test(t)) break;                          // 以标点收尾 ⇒ 正文
            if (/程序图/.test(t)) break;                                 // 小节标题（"2.2 始发列车技术作业程序图"）
            cand.push({ cells: r, y: arr[j].y });
            j++;
        }
        if (cand.length < 4) return null;
        var xs = [];
        cand.forEach(function (c) { c.cells.forEach(function (cc) { if (cc.length) xs.push(cc[0].x); }); });
        xs.sort(function (a, b) { return a - b; });
        var lo = xs[0], hi = xs[xs.length - 1];
        if (!(hi - lo >= 40)) return null;                              // 两列间距不足（缩进段落）⇒ 不判
        var mid = (lo + hi) / 2, left = 0, right = 0, both = 0, rows = [];
        cand.forEach(function (c) {
            var L = '', R = '';
            c.cells.forEach(function (cc) {
                if (!cc.length) return;
                var t2 = cellText(cc);
                if (cc[0].x < mid) L = L ? (L + t2) : t2; else R = R ? (R + t2) : t2;
            });
            if (L && R) both++;
            if (L) left++;
            if (R) right++;
            rows.push([L, R]);
        });
        if (left < 3 || right < 3 || both < 1) return null;
        return { rows: rows, end: j };
    }
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
                // 往后找"表格区域"：以多列行为主体，**允许单列行夹在中间**（跨行合并单元格 / 竖排字）。
                //   【2026-10-07 真机实证】《铁路车号员作业标准》PDF 的作业程序表里，"一收取确报"是**竖排**的
                //   （每个字各自成行、每行只有 1 格）⇒ 旧实现（`while (rowsCells[j].length >= 2)`）遇到它
                //   当场把表格切断，切出来的碎片被打平成段落 —— 用户 DOCX 里那句
                //   "作业程序作业人员岗位作业技术要求说明事项程序项目一收取确报车号员…" 就是这么来的。
                //   准入条件严格：单列行的 x 必须**命中区域已有的列种子**（±colTol），否则视为区域结束。
                var j = i, region = [], seeds = [];
                var _seed = function (r2) { r2.forEach(function (c) { if (c.length) seeds.push(c[0].x); }); };
                while (j < arr.length) {
                    var rj = rowsCells[j];
                    if (rj.length >= 2) {
                        // ⚠️【2026-10-07 失败尝试·已回退，勿重蹈】曾想在这里加"表格结束判定"——按
                        //   "该行落在已知列上的格子占比 <60% 即视为跑偏、连续跑偏则结束区域"来阻止
                        //   region 吞进表后正文（动机：打勾表后方紧跟 2 格正文行，把锚点数撑爆）。
                        //   **实测立刻翻车**：`seeds` 是**渐进积累**的，表格头几行的"新列"天然命中率低
                        //   ⇒ 被判成"连续跑偏"⇒ region 只剩 1 行 ⇒ 表格全部消失
                        //   （套件 A⑱/A⑳/A⑮ + pdf⑤ 齐挂；接触网 PDF 表格 14 张 → 6 张且只剩两列表）。
                        //   ⇒ 要保持"≥2 格行无条件接受"这一简单规则；表格边界的事交给下面的体检判据。
                        region.push(rj); _seed(rj); j++; continue;
                    }
                    if (rj.length === 1 && rj[0].length && seeds.length) {
                        // ⚠️ 单格行 = 竖排字 / **跨列合并格**（表头常见）。准入必须严，否则区域会一路吞掉
                        //   表后的正文行（正文里大量行本身就是 1 格），把体检拖垮 ⇒ 整张表反而识别不出来
                        //   （套件 A⑮/A⑯/A⑰ + pdf⑤ 抓到的那个回归：表数=0）。
                        //   三次迭代后的判据（2026-10-07）：
                        //     ① 短（≤12 字）且无标点 —— 正文单格行普遍更长或带标点；
                        //     ② x **命中已有列**，或**落在表格列跨度内**（= 跨列合并格：真机实证"技术资料名称"
                        //        在 x=169，而列在 75/317/… ⇒ 命中判定会失败，整表打平）；
                        //     ③ 紧邻行里**还有表格行**（≥2 格）—— 专挡"表后正文行"（它旁边通常是纯正文行）。
                        var _t1 = String(cellText(rj[0]) || '').trim();
                        if (_t1.length <= 12 && !/[。；！？：，,、]/.test(_t1)) {
                            var sx = rj[0][0].x, onCol = false, _lo = Infinity, _hi = -Infinity;
                            for (var s3 = 0; s3 < seeds.length; s3++) {
                                if (Math.abs(seeds[s3] - sx) <= (opts.colTol || 6)) onCol = true;
                                if (seeds[s3] < _lo) _lo = seeds[s3];
                                if (seeds[s3] > _hi) _hi = seeds[s3];
                            }
                            if (!onCol && sx > _lo && sx < _hi) onCol = true;      // 跨列合并格
                            if (onCol) {
                                var _pv = rowsCells[j - 1], _nx = rowsCells[j + 1];
                                if ((_pv && _pv.length >= 2) || (_nx && _nx.length >= 2)) { region.push(rj); j++; continue; }
                            }
                        }
                    }
                    break;
                }
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
                    // 【2026-10-07 最终判据·两次迭代的结论】表格识别的真实难点是"**1 格行**"（竖排字 / 合并单元格），
                    //   而"**2 格行**"恰恰是"正文被误切"的典型特征 ⇒ 因此：
                    //     · 单格行**豁免**（它在区域扫描阶段已被严格准入：≤4 字、无标点、x 命中列种子）；
                    //     · 2 格及以上行**仍必须 ≥3 格**（保持原有防误判强度）。
                    //   —— 上一版把这条放宽成"≥3 格的行占 60% 即可"，结果第 2 页整段正文（分散对齐被切成
                    //      一堆碎片格）通过体检，被判成 8×23 的"表格"，正文散成一地碎片 ☠️。
                    // 【2026-10-07 判据重做·三次迭代的结论】用"**行内格数**"判断表格行行不通 ——
                    //   真实表格里**合并单元格 / 空列 / 竖排字**会让同一张表出现 1~3 格的杂行（真机实证：
                    //   作业程序表既有 5 格行，也有 2 格行「取 | 容通知）相关岗位。」和 1 格竖排行「确」「报」）
                    //   ⇒ 旧判据"每行都必须 ≥3 格"必然把整张表否掉。
                    //   改为**按列锚点判断**（先聚类列，再看行）：
                    //     · 少格行（<3 格）的每个格子必须**命中已有列锚点**（±colTol）——
                    //       被"分散对齐"切出来的正文碎片，其 x 与表格列不对齐 ⇒ 在这里被挡掉；
                    //     · **列数上限 12** —— 正文碎片化往往产生几十列（上一版就是 8×23 的假表格）；
                    //     · 每行首格仍要短（不像句子）。
                    var offCol = region.some(function (r) {
                        if (!r.length || r.length >= 3) return false;
                        return r.some(function (c) {
                            if (!c.length) return false;
                            var x = c[0].x;
                            for (var k4 = 0; k4 < anchors.length; k4++) {
                                if (Math.abs(anchors[k4].x - x) <= (opts.colTol || 6)) return false;
                            }
                            return true;                            // 存在"落不到任何列"的格子 ⇒ 这行不是表行
                        });
                    });
                    // ⚠️⚠️【2026-10-07 判据取舍·三次尝试的最终结论 —— **不要再放宽这条**】
                    //   本想救"**列位置漂移**"的真表格（第 9 页 3.4 途中摘挂列车表：同一列文字块 x 漂移
                    //   243/249/254/259 ⇒ anchors 高达 33 ⇒ 被下面的 ≤12 挡掉、整表打成长串）。
                    //   三次尝试**全部失败并回退**，每次都救回那张表、但代价都是**误伤别的文档**：
                    //     ① 按"有效列"（count ≥ 2）计数 ⇒ 第 2 页整段正文被表格化（8×23 假表、maxCols=24）；
                    //     ② 锚点漂移合并（count=1 的孤立锚点并入最近主列）⇒ 正文同样被放行；
                    //     ③ 换"逐页实测"特征：每行格数中位数 ≤4 + "格数 ≥8 的行占比" ≤20%
                    //        （数据确有区分力：第 9 页表 4 / 3.7%，第 10 页正文 7 / 36%）
                    //        ⇒ 但**套件里的 8 列台账表被误杀**（宽表每行天然就是 8 格）⇒ A⑮/A⑯/A⑰ + pdf⑤ 齐红。
                    //   ⇒ 最终结论：**宁可少数一张表，也不能误判正文、也不能误杀其它表格**。
                    //     第 9 页那类表按段落输出（内容不丢，只是不是表格形态），列为**已知限制**。
                    // 【2026-10-07 旁路·"打勾表"】内容列是 √ / × / ○ 这类**单字符**的表格（技术资料对照表），
                    //   真机实证（《高速铁路接触网运行维修规则》第 10 页"技术资料名称"表）：7 列 × 26 行、
                    //   列位置有漂移（75/78、317/325、353/361…）⇒ anchors 15+、且"跨行名称续行"的 x 落不到锚点上
                    //   ⇒ 被"列数上限 12 + offCol"两道闸门挡住、整表打平成长串
                    //   （"技术资料名称号车间工区车间工区车间工区1供电分段示意图√ √ √ √ √ √…"）。
                    //   判据：区域内"单字符打勾格"≥5 个 —— **正文里几乎不可能出现这种形态** ⇒ 放宽是安全的
                    //   （正文/条文里不会有整片 √）。
                    var _marks = 0;
                    region.forEach(function (r) {
                        r.forEach(function (c) {
                            if (!c || !c.length) return;
                            var _mt = String(cellText(c) || '').trim();
                            if (_mt.length === 1 && /[\u221a\u2713\u00d7\u2717\u25cb\u25cf\u25b3\u25b2\u2014\uff0d\-]/.test(_mt)) _marks++;
                        });
                    });
                    //   ⚠️ 现状（2026-10-07）：这条旁路**尚未完全生效** —— 打勾表后面紧跟的多格正文行
                    //     会把 region 一路延伸、锚点暴增（远超上限），所以那张表目前**仍按段落输出**。
                    //     已试过"表格结束判定（按命中率）"⇒ 立刻翻车（seeds 渐进积累 ⇒ 表头前几行被判跑偏、
                    //     表格全消失，套件 A⑱/A⑳/A⑮ + pdf⑤ 齐挂）⇒ 已回退。彻底解决需要重构表格**边界检测**，
                    //     属较大改动。这里先把判据保留（对正文零影响：正文的"单字符打勾格"恒为 0）。
                    var _maxAnchors = _marks >= 5 ? 40 : 12;
                    var _offColOk = _marks >= 5 ? true : !offCol;   // 打勾表：跨行名称的续行位置漂移属常态
                    var looksTable = region.length > 0 && anchors.length <= _maxAnchors && _offColOk
                        && region.every(function (r) {
                            if (!r.length) return false;
                            if (String(cellText(r[0]) || '').length > 16) return false;     // 首格像句子 ⇒ 不是表格
                            return true;
                        });
                    var lens = [];
                    region.forEach(function (r) { r.forEach(function (c) { lens.push(String(cellText(c) || '').length); }); });
                    lens.sort(function (a, b) { return a - b; });
                    var medLen = lens.length ? lens[Math.floor(lens.length / 2)] : 0;
                    // 【2026-10-05 用户报「OFD 导入后标题被卷进表格」】正文小标题（"三、施工维修管理方面"这类）
                    //   **绝不能进表格**：用户真实 OFD 里它被当成表头，标题与后面整段正文一起被表格化
                    //   （正文里被插满 "|" 分隔符）。这里加一道闸门——区域里只要有**标题行**就整区不成表，
                    //   这些行继续按段落处理（保守优先：宁可少识别一张表，也不破坏正文结构）。
                    var hasHeadLine = region.some(function (r) {
                        if (!r || !r.length) return false;
                        var _t = r.map(cellText).join('').replace(/\s+/g, '');
                        // ⚠️ 这里**不能**用 classifyParagraph：实测它把真表格的表头
                        //   （"序号线名行别侧别起点里程…"）也判成 'title' ⇒ 整张表被否决、
                        //   套件 4 条表格断言一起挂（38/42）。只用**公文式小标题**的正则：
                        //   "一、xxx / 三、施工维修管理方面" 这类（这类才绝不能进表格）。
                        return /^[一二三四五六七八九十百]+[、.．]/.test(_t)
                            || /^（[一二三四五六七八九十]+）/.test(_t);
                    });
                    if (aligned >= 3 && looksTable && medLen <= 12 && !hasHeadLine) {
                        flushPending();
                        var cols = Math.max(anchors.length, 1);
                        var grid = [];
                        region.forEach(function (r) {
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
                            // 【2026-10-07】"单格且很短"的行 = 竖排字的续行 ⇒ 回溯接进该列**最近一次有内容**的
                            //   单元格，不再单独占一行（否则表里会多出"确""报"这类碎片行）。
                            //   限 ≤4 字 ⇒ 不会把成段的正文行误并进上一格。
                            if (r.length === 1 && grid.length) {
                                var _k = -1;
                                for (var c3 = 0; c3 < cols; c3++) if (line[c3]) { _k = c3; break; }
                                if (_k >= 0 && String(line[_k]).length <= 4) {
                                    for (var g3 = grid.length - 1; g3 >= 0; g3--) {
                                        if (grid[g3][_k]) {
                                            var _a = String(grid[g3][_k]), _b = String(line[_k]);
                                            var _sp = (/[\u4e00-\u9fff]$/.test(_a) && /^[\u4e00-\u9fff]/.test(_b)) ? '' : ' ';
                                            grid[g3][_k] = _a + _sp + _b;
                                            return;                       // 已并入，不新增行
                                        }
                                    }
                                }
                            }
                            grid.push(line);
                        });
                        blocks.push({ type: 'table', rows: grid, cols: cols });
                        i = j;
                        continue;
                    }
                }
            }
            // 【2026-10-07 新增】两列版式（技术作业程序图）：放在"表格识别"之后 ——
            //   3 格以上的行归表格；1~2 格的**短行**且左右成簇的，才归这里（见 twoColRegion 判据）。
            if (rc.length <= 2) {
                var _tc = twoColRegion(arr, rowsCells, i, opts);
                if (_tc) {
                    flushPending();
                    blocks.push({ type: 'table', rows: _tc.rows, cols: 2 });
                    i = _tc.end;
                    continue;
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
    /**
     * 【2026-10-03 第二轮，用户贴出 OFD 导入结果】解析层坐标修好后，正文已连贯，但还剩两类"整篇级"问题：
     *   ① 每页都打的 IP+账号水印戳（如 lanzhl-zhaohaibing 50312910.208.60.183）被**缝进正文行中间** ✗
     *      —— stripRunning 只按整行比对，戳与正文同行就抓不到 ✗；
     *   ② 整篇被压成 1~2 行 ⇒ 段落全丢、栏目小标题夹在句中 ✗。
     * 对策（都在**行级**做 ⇒ 块/段落/文本/HTML 四条下游自动一致）：
     *   · findStampTokens + 删除：统计"长英文/数字串"在全文出现次数，≥3 次 ⇒ 判为重复素材删掉
     *     （正文里的编号不会重复三次；实测 9月16日22时25分、T6601、HZ2-24、YZ25G 等都<3 次或长度不够 ⇒ 不动）；
     *   · splitDegenerateLines：**只在整页 1~2 行时**按明显分段点重新切行（时间点、条款头），
     *     避免误切正常段落（正常文档这条不生效）；
     *   · 标题归位：把"XXX关于…的通报/通知…"从夹缝里**摘出来**放到最前（公文标题常被排在正文之后）。
     */
    function findStampTokens(flatText) {
        var s = String(flatText == null ? '' : flatText);
        var re = /[A-Za-z0-9][A-Za-z0-9._@\-]{5,}/g;
        var cnt = {}, order = [], m;
        while ((m = re.exec(s))) { var k = m[0]; if (!cnt[k]) { cnt[k] = 0; order.push(k); } cnt[k]++; }
        // 判据：长串（≥6 位，字母/数字类）在全文出现 ≥3 次 ⇒ 判为"每页重复的素材"。
    //   ⚠️ 原来还要求"串里必须含数字"✗ —— 用户那份水印的账号名 "lanzhl-zhaohaibing" 不含数字，
    //     于是只有 IP 被删、账号名留下（套件 A㉕ 当场抓到）。规则改为：**出现 ≥3 次的长串一律删**
    //     （中文正文里的编号/型号不会重复三次；即便偶发，重复三次的长串也已是噪声）。
    return order.filter(function (k) { return cnt[k] >= 3; });
    }
    function reEsc(t) { return String(t).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

    function splitDegenerateLines(lines) {
        if (!lines || lines.length > 2) return lines;      // 正常文档：不动
        var out = [];
        (lines || []).forEach(function (l) {
            var t = String((l && l.text) || '');
            if (!t.trim()) return;
            t = t.replace(/([。；！？：])\s*(?=\d{1,2}月\d{1,2}日\d{1,2}时)/g, '$1\u0001');               // 每件问题另起段
            t = t.replace(/(方面)\s*(?=\d{1,2}月\d{1,2}日\d{1,2}时)/g, '$1\u0001');                        // 小标题后紧跟问题 ⇒ 也断开
            t = t.replace(/([。；！？])\s*(?=[一二三四五六七八九十]{1,3}、[^\u0001]{2,14}方面)/g, '$1\u0001'); // 栏目小标题另起段
            t = t.replace(/([^\u0001]{2,8}方面)\s*(?=[一二三四五六七八九十]{1,3}、[^\u0001]{2,14}方面)/g, '$1\u0001'); // 小标题连续出现 ⇒ 逐个断开
            t = t.replace(/([一二三四五六七八九十]{1,3}、[^\u0001]{2,14}方面)(?=[^\u0001])/g, '$1\u0001');    // 小标题自身成段
            t.split('\u0001').filter(function (x) { return x.trim() !== ''; }).forEach(function (x, i) {
                out.push({
                    text: x.trim(),
                    x: (l && typeof l.x === 'number') ? l.x : null,
                    y: (l && typeof l.y === 'number') ? (l.y + i * 0.002) : null,
                    size: (l && l.size) || null, angle: 0, rotated: false
                });
            });
        });
        return out;
    }

    function buildFromPageLines(pageLines, opts) {
        opts = opts || {};
        // ① 片段级水印戳剥离：先统计全文重复的长串，再从各行删掉（删完变空的行直接丢弃）
        var _flat = (pageLines || []).map(function (ls) {
            return (ls || []).map(function (l) { return String((l && l.text) || ''); }).join(' ');
        }).join(' ');
        //   ⚠️ 要**多轮**删：几段水印相邻时，"503129"+"lanzhl-zhaohaibing"会粘成一个**新长串**（只删一轮会留下残渣，
        //     套件 A㉕ 里 503129 残留 1 次就是这么来的）。每轮删完重新统计，最多 3 轮。
        var _junkTotal = 0, _junkAll = [];
        for (var _pass = 0; _pass < 3; _pass++) {
            var _flat2 = (pageLines || []).map(function (ls) {
                return (ls || []).map(function (l) { return String((l && l.text) || ''); }).join(' ');
            }).join(' ');
            var _jk = findStampTokens(_flat2);
            if (!_jk.length) break;
            _junkTotal += _jk.length;
            _jk.forEach(function (k) { if (_junkAll.indexOf(k) === -1) _junkAll.push(k); });
            var _re2 = new RegExp(_jk.map(reEsc).join('|'), 'g');
            pageLines = (pageLines || []).map(function (ls) {
                return (ls || []).map(function (l) {
                    // 删掉后**重新做一次中文空格折叠**：戳夹在"未｜使用"之间时才会正确接成"未使用"
                    l.text = collapseSpaces(String((l && l.text) || '').replace(_re2, ' ').replace(/[ \t]{2,}/g, ' ')).replace(/^\s+|\s+$/g, '');
                    return l;
                }).filter(function (l) { return String((l && l.text) || '').trim() !== ''; });
            });
        }
        //   ⚠️ 收尾一刀：被判定为水印的长串，其**前 6 位**也要清掉 —— 因为长串的尾部/前部片段可能因为
        //     与相邻水印粘贴（"…503129lanzhl-zhaohaibing…"）而**自成新串、次数不够阈值**，
        //     于是只剩它没删（套件 A㉕ 最后残留的那 1 次 503129 就是这么来的）。判据来自**已确认的水印串**，
        //     不是随便清短串 ⇒ 不会误伤正文。
        var _pk = [];
        (_junkAll || []).forEach(function (k) { if (k.length > 6) _pk.push(k.slice(0, 6)); });
        if (_pk.length) {
            var _re3 = new RegExp(_pk.map(reEsc).join('|'), 'g');
            pageLines = (pageLines || []).map(function (ls) {
                return (ls || []).map(function (l) {
                    l.text = collapseSpaces(String((l && l.text) || '').replace(_re3, ' ').replace(/[ \t]{2,}/g, ' ')).replace(/^\s+|\s+$/g, '');
                    return l;
                }).filter(function (l) { return String((l && l.text) || '').trim() !== ''; });
            });
        }
        if (_junkTotal) { opts = opts || {}; opts._stampRemoved = _junkTotal; }
        // ② 退化输入（整篇压成 1~2 行）⇒ 按明显分段点重新切行
        pageLines = (pageLines || []).map(splitDegenerateLines);
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
        // ③ 公文标题归位：标题常被排在正文之后/夹在两栏之间 ⇒ 从块里**摘出来**放到最前（只在标题不在开头时动手）
        var RE_TITLE = /[\u4e00-\u9fa5A-Za-z0-9（）()]{2,30}关于[\u4e00-\u9fa5A-Za-z0-9、，（）()]{2,60}的(通报|通知|决定|意见|报告|批复|函|公示)/;
        for (var _bi = 1; _bi < blocks.length; _bi++) {
            if (blocks[_bi].type !== 'para') continue;
            var _tm = RE_TITLE.exec(blocks[_bi].text || '');
            if (!_tm) continue;
            var _txt = String(blocks[_bi].text);
            // 前缀原样留在原处（"内部一、作业标准执行方面"这类残字是**多栏排版**造成的，需原 OFD 才能彻底归位）；
            // 而**标题自身**若被贪婪前缀沾上了小标题尾巴（"…方面安监系统关于…的通报"），把"…方面"之前的摘掉
            var _before = _txt.slice(0, _tm.index).trim();
            var _after = _txt.slice(_tm.index + _tm[0].length).trim();
            var _title = _tm[0];
            var _pi = _title.lastIndexOf('方面');
            if (_pi >= 0 && _pi <= 14) {
                // ⚠️ 剪掉的"…方面"必须**接回前缀**（原来直接丢弃 ⇒ 栏目小标题凭空少一段，套件 A㉘ 抓到）
                _before = (_before ? _before : '') + _title.slice(0, _pi + 2);
                _title = _title.slice(_pi + 2);
            }
            var _ins = [{ type: 'para', text: _title, kind: 'chapter', lines: 1, rotated: false }];
            if (_after) _ins.push({ type: 'para', text: _after, kind: 'body', lines: 1, rotated: false });
            blocks.splice.apply(blocks, [_bi, 1].concat(_ins));
            if (_before) blocks.splice(_bi, 0, { type: 'para', text: _before, kind: 'body', lines: 1, rotated: false });
            // 把标题块移到最前
            var _titleIdx = _bi + (_before ? 1 : 0);
            var _tb = blocks.splice(_titleIdx, 1)[0];
            blocks.unshift(_tb);
            break;
        }
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

    /* =======================================================================
     * 十三、水印文字清洗（2026-10-05 用户需求）
     *   用户原话："导入规章时自动去掉各种水印和『内部资料 不得外传』字样"。
     *   为什么抽到共用层：原来只有 OFD 有水印判据（注释水印 / 图层名 / 版式特征），
     *   PDF 只丢"倾斜行"、DOCX 完全没有 ⇒ **同一份文件换个格式导进来水印残留都不一样**。
     *   现在 PDF / OFD / DOCX 三条规章导入路径共用这一把尺子。
     *   口径（沿用本模块"宁可记录清楚，也不悄悄删"的作风）：
     *     ① **整行**命中水印特征 ⇒ 删整行，并记入 removed（导入完成提示里如实告知用户删了什么）；
     *     ② 水印字样只出现在**长行内部**（正文里顺带提到的）⇒ **只记录不删**，避免误伤正文；
     *     ③ 特征词表**只在这里维护一份**，`ofd-import.js` 引用同一份（见其 WATERMARK_HINT）。
     * ===================================================================== */
    // 注：比 ofd-import.js 原词表多了「不得外传 / 不得传播 / 不得复制 / 禁止复制 / 内部使用 / 仅限 / 传阅 / 交流 / 注意保密」
    // ⚠️ 本表是**合并词表**，只用于**元素级**匹配（OFD 注释 Type/ID、图层名 —— 那些不是正文，删掉不算删原文）。
    //    文本级判定请用下面的 watermarkKind / shouldDropLine（那里区分了"全文水印"与"只头尾的保密字样"）。
    var WATERMARK_HINT = /水印|watermark|内部资料|内部文件|内部使用|仅供|仅限|样张|副本|传阅|交流|严禁|禁止外传|不得外传|不得传播|不得复制|禁止复制|注意保密|机密|秘密|绝密|confidential|internal\s*use|specimen|copy\s*only|do\s*not\s*copy/i;

    // 【2026-10-05 用户口径·第三轮，把两类水印分开】
    //   用户原话："水印在全文都有，但『内部资料 不得外传』只在开头和结尾，大部分在开头"。
    //   ⇒ **A 类 水印本体**（文中带"水印"标记的）全文都该清；
    //     **B 类 保密/限制字样**（内部资料、不得外传、严禁、机密…）**只在开头/结尾窗口内**清 —— 
    //     因为很多规程正文里真的会写"内部资料不得外传"这类条款，删了就是破坏原文。
    var SECRET_HINT = /内部资料|内部文件|内部使用|仅供|仅限|样张|副本|传阅|交流|严禁|禁止外传|不得外传|不得传播|不得复制|禁止复制|注意保密|机密|秘密|绝密|confidential|internal\s*use|specimen|copy\s*only|do\s*not\s*copy/i;

    /**
     * 文本行归类。
     * @returns {number} 0=不是水印；1=A 类水印本体（**全文**可删）；2=B 类保密字样（**只头尾窗口**可删）
     */
    function watermarkKind(line) {
        var t = String(line == null ? '' : line).replace(/[\s　]/g, '');
        if (!t) return 0;
        if (t.length <= 40 && WATERMARK_HINT.test(t) && /水印|watermark/i.test(t)) return 1;   // A 类：带"水印"标记
        if (!SECRET_HINT.test(t)) return 0;
        var hit = (t.match(new RegExp(SECRET_HINT.source, 'gi')) || []).join('').length;
        return (t.length <= 60 && hit / t.length >= 0.3) ? 2 : 0;                              // B 类：短行 + 占比够高
    }

    /**
     * 最终判定：这一行该不该删。
     * @param {string} line 行/段文本
     * @param {boolean} atEdge 是否落在「开头 5 行 / 结尾 5 行」窗口内
     * @returns {boolean} A 类全文删；B 类只有落在窗口内才删
     */
    function shouldDropLine(line, atEdge) {
        var k = watermarkKind(line);
        return k === 1 || (k === 2 && !!atEdge);
    }

    /**
     * 判定"整行像水印"（A 或 B 类都算，**不含窗口判断**）。
     * ⚠️ 窗口判断在 stripWatermarkText / stripWatermarkBlocks 内部做，调用方一般不需要它。
     */
    function isWatermarkLine(line) {
        return watermarkKind(line) > 0;
    }

    // 【2026-10-05 用户口径·第三轮】**"水印"本体全文清；"内部资料 不得外传"这类保密字样只清开头/结尾 5 行**
    //   （用户说这类字样"大部分在开头"⇒ 开头窗口给足 5 行；连续水印块超过 5 行时宁可留着，也不误伤正文）。
    //   注意：这条只管**文字**；OFD 的注释/图层/旋转水印、PDF 的倾斜行与打印戳都是**非正文元素**，不受窗口限制。
    var WATERMARK_EDGE = 5;
    function _inEdgeWindow(i, n) {
        return i < WATERMARK_EDGE || i >= n - WATERMARK_EDGE;
    }

    /**
     * 纯文本清洗：A 类水印**全文删**；B 类保密字样**只在开头/结尾窗口内删**（窗口外只记录，一个字都不动）。
     * @returns {{text:string, removed:string[], noted:string[]}}
     */
    function stripWatermarkText(text) {
        var lines = String(text == null ? '' : text).split(/\r?\n/);
        var n = lines.length, kept = [], removed = [], noted = [];
        for (var i = 0; i < n; i++) {
            var ln = lines[i];
            if (shouldDropLine(ln, _inEdgeWindow(i, n))) { removed.push(String(ln).trim()); continue; }
            if (watermarkKind(ln)) { noted.push(String(ln).trim().slice(0, 60)); kept.push(ln); continue; }
            kept.push(ln);
        }
        return { text: kept.join('\n'), removed: removed, noted: noted };
    }

    /**
     * 块级清洗：剔掉"整段就是水印"的块（A 类全文剔；B 类只剔开头/结尾 5 块内的），表格不动，避免破坏结构。
     * 兼容两种块形状：ImportLayout 用 {type,text}，RGDocx 用 {t,runs}。
     * @returns {{blocks:Array, removed:string[]}}
     */
    function stripWatermarkBlocks(blocks) {
        var list = blocks || [], n = list.length, out = [], removed = [];
        for (var i = 0; i < n; i++) {
            var b = list[i];
            if (!b) continue;
            var isTbl = b.type === 'table' || b.t === 'table';
            var txt = b.text != null ? b.text
                : (b.runs || []).map(function (r) { return r.text || ''; }).join('');
            if (!isTbl && shouldDropLine(txt, _inEdgeWindow(i, n))) {
                removed.push(String(txt).trim().slice(0, 40));
                continue;
            }
            out.push(b);
        }
        return { blocks: out, removed: removed };
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
        findStampTokens: findStampTokens,   // 供套件直接核对"哪些片段被判为水印素材"
        splitDegenerateLines: splitDegenerateLines,
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
        // 【2026-10-05】水印清洗（PDF / OFD / DOCX 三条导入路径共用；A 类水印全文删、B 类保密字样只删头尾）
        WATERMARK_HINT: WATERMARK_HINT,     // 合并词表，**只用于元素级匹配**（OFD 注释 Type/ID、图层名）
        SECRET_HINT: SECRET_HINT,
        watermarkKind: watermarkKind,       // 0 非水印 / 1 A 类水印本体（全文可删）/ 2 B 类保密字样（只头尾可删）
        shouldDropLine: shouldDropLine,     // 最终判定：shouldDropLine(line, 是否在头尾窗口)
        isWatermarkLine: isWatermarkLine,
        stripWatermarkText: stripWatermarkText,
        stripWatermarkBlocks: stripWatermarkBlocks,
        fromPdfItems: fromPdfItems,
        toText: toText,
        joinRun: joinRun,
        needSpace: needSpace,
        SENT_END: SENT_END,
        CLAUSE_HEAD: CLAUSE_HEAD,
        version: '1.0'
    };
})();
