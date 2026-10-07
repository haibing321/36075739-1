/**
 * OFD 导入（2026-10-03 用户需求：OFD 格式文件是否能导入，并把文件中的水印去掉）
 * ============================================================================
 * OFD 是国产版式文档标准，本质是 **ZIP 容器**（与 docx/odt 同族）：
 *   OFD.xml                        → 入口，指向 DocBody/DocRoot
 *   Doc_0/Document.xml             → 文档结构，列出 ofd:Page（BaseLoc 指向每页 Content.xml）
 *   Doc_0/Pages/Page_N/Content.xml → 页内容（ofd:TextObject / ofd:PathObject / ofd:ImageObject …）
 *   Doc_0/Annots/*.xml             → 页面注释；**水印通常就是 Type="Watermark" 的注释**
 * 所以：用本地 JSZip 解包 + DOMParser 解析即可，**无需任何联网库**（严格离线）。
 *
 * 抽取什么：`ofd:TextCode` 的文本（按页、按 Y→X 阅读顺序排列），即"正文可读文字"。
 * 不抽取：矢量 `PathObject`、图片 `ImageObject`（会记为提示：如含图片/扫描件则正文可能不全）。
 *
 * **去水印**（用户明确要求）三条判据，全部**只删水印、不动正文**：
 *   ① 注释水印：Annotations 里 Type/(Name/ID) 命中水印特征的 `ofd:Annot` → 其中出现的文字串全部剔除；
 *   ② 图层水印：TextObject 自身或其祖先 `ofd:Layer` 的 ID/名称含"水印/watermark" → 整段丢弃；
 *   ③ 版式水印：TextObject（或祖先 Layer）带 `Rotate`≠0 或 `Alpha`<1（倾斜/半透明是水印的典型画法）→ 整段丢弃。
 *   另外把 ① 学到的水印文字串从**整篇正文**里逐条剔除（水印文字有时也被画进正文流里）。
 * 说明：判据 ③ 有极小概率误伤"正文里故意旋转/半透明的文字"（版式文档里极少见）；被删的东西全部记录在
 *   `removed` 里并在控制台打印，可随时核对（宁可记录清楚，也不做悄悄删）。
 */
(function () {
    'use strict';

    // 【2026-10-05】水印词表**统一到 ImportLayout**（同一把尺子，比原表多了"不得外传/不得传播/不得复制/禁止复制/内部使用"等）。
    //   ⚠️ 注意分工：本文件只用它匹配**元素属性**（注释 Type/ID、图层名）与**整条注释里的文字**，
    //   不作用于正文文本流 ⇒ 因此**不受** ImportLayout 里"只删开头/结尾 1-5 行"的窗口限制
    //   （那三个图形/版式判据命中的本来就不是正文，是非正文元素）。
    //   落空（ImportLayout 未加载，套件单跑时）回退到自带表，功能不丢。
    var _WM_FALLBACK = /水印|watermark|内部资料|内部文件|严禁|禁止外传|不得外传|不得传播|不得复制|禁止复制|仅供|样张|副本|机密|秘密|绝密|confidential|internal\s*use|specimen|copy\s*only/i;
    var WATERMARK_HINT = (typeof window !== 'undefined' && window.ImportLayout && window.ImportLayout.WATERMARK_HINT) || _WM_FALLBACK;

    function ensureJSZip() {
        return new Promise(function (resolve) {
            if (typeof JSZip !== 'undefined' || typeof window.JSZip !== 'undefined') return resolve(true);
            var done = function () { resolve((typeof JSZip !== 'undefined') || (typeof window.JSZip !== 'undefined')); };
            try {
                if (typeof window.loadScript === 'function') { window.loadScript('src/js/vendor/jszip.min.js').then(done, done); return; }
            } catch (e) {}
            var s = document.createElement('script');
            s.src = 'src/js/vendor/jszip.min.js';
            s.onload = done; s.onerror = done;
            document.head.appendChild(s);
        });
    }

    /** 取某个 zip 路径的文本（不存在返回 ''） */
    async function readZipText(zip, path) {
        try {
            var f = zip.file(path);
            if (!f) return '';
            return await f.async('string');
        } catch (e) { return ''; }
    }

    function parseXml(text) {
        try {
            var doc = new DOMParser().parseFromString(text, 'application/xml');
            return doc && doc.documentElement ? doc : null;
        } catch (e) { return null; }
    }

    /** 命名空间无关地取所有指定 localName 的元素（OFD 前缀各家不同，必须按 localName 匹配） */
    function byLocal(root, name) {
        var out = [];
        if (!root) return out;
        var all = root.getElementsByTagName('*');
        for (var i = 0; i < all.length; i++) if (all[i].localName === name) out.push(all[i]);
        return out;
    }

    /**
     * 【2026-10-05 用户报「OFD 导入后水印处内容丢失」→ 真根因在此，**不是**删斜体、也不是水印判据】
     *   OFD 规范：**TextCode.X/Y 是相对该 TextObject 的偏移**，绝对位置 = TextObject.Boundary 的起点 + 偏移
     *   （横向还要乘 CTM 的 a、纵向乘 d）。实测本项目样本：每个 TextCode 都是 `X="0" Y="2.8399"`（同一偏移），
     *   真实位置在 Boundary（如"内"=27.0669 60.2578、"部"=35.5336 60.2578，y 相同、x 递增 ⇒ 应聚成一行）。
     *   ⚠️ 2026-10-03 那次"坐标改从 ofd:TextCode 取"把**偏移当成了绝对坐标** ⇒ 全篇字块坐标雷同
     *      ⇒ 聚行/阅读顺序失效 ⇒ 一行被拆成多行 ⇒ 段落碎裂 + 半句被当页眉页脚清掉 ⇒ 用户看到"内容丢失"；
     *      逐字水印（"内部资料 不得外传"被拆成"内""部"…）也聚不成行 ⇒ 残留在正文中间。
     *   现在按规范合成绝对坐标；只有取不到 Boundary 时才退回 TextCode / TextObject 的 X/Y。
     */
    function xySizeOf(obj, codes) {
        var bnd = attrAny(obj, ['Boundary', 'boundary']);
        var bp = bnd ? bnd.split(/\s+/).map(parseFloat) : [];
        var c0 = (codes && codes.length) ? codes[0] : null;
        // CTM="a b c d e f"：横向缩放 a、纵向缩放 d（缺省 1）
        var sx = 1, sy = 1;
        var ctm = attrAny(obj, ['CTM', 'ctm']);
        if (ctm) {
            var cp = ctm.split(/\s+/).map(parseFloat);
            if (cp.length >= 4 && isFinite(cp[0]) && cp[0] !== 0) sx = cp[0];
            if (cp.length >= 4 && isFinite(cp[3]) && cp[3] !== 0) sy = cp[3];
        }
        var ox = c0 ? parseFloat(attrAny(c0, ['X', 'x'])) : NaN;   // 相对偏移
        var oy = c0 ? parseFloat(attrAny(c0, ['Y', 'y'])) : NaN;
        var x = NaN, y = NaN;
        if (bp.length >= 2 && isFinite(bp[0]) && isFinite(bp[1])) {
            x = bp[0] + (isFinite(ox) ? ox * sx : 0);
            y = bp[1] + (isFinite(oy) ? oy * sy : 0);
        } else {
            if (isFinite(ox)) x = ox;
            if (isFinite(oy)) y = oy;
            if (!isFinite(x) || !isFinite(y)) {
                var tx = parseFloat(attrAny(obj, ['X', 'x'])); var ty = parseFloat(attrAny(obj, ['Y', 'y']));
                if (isFinite(tx)) x = tx; if (isFinite(ty)) y = ty;
            }
        }
        var size = parseFloat(attrAny(obj, ['Size', 'size']));
        if (!(size > 0) && bp.length >= 4 && bp[3] > 0) size = bp[3];
        return { x: isFinite(x) ? x : null, y: isFinite(y) ? y : null, size: (size > 0) ? size : null };
    }

    function attrAny(el, names) {
        for (var i = 0; i < names.length; i++) {
            var v = el.getAttribute && el.getAttribute(names[i]);
            if (v) return v;
        }
        return '';
    }

    /** 元素自身或祖先（最多 4 层）是否命中水印特征/版式特征 */
    function layerMark(el, kind) {
        var cur = el, hop = 0;
        while (cur && hop < 4) {
            var id = attrAny(cur, ['ID', 'id', 'Name', 'name', 'LayerID']) || '';
            if (kind === 'hint' && id && WATERMARK_HINT.test(id)) return id;
            if (kind === 'layout') {
                var rot = attrAny(cur, ['Rotate', 'rotate']);
                if (rot && parseFloat(rot) !== 0 && !isNaN(parseFloat(rot))) return 'Rotate=' + rot;
                // 【2026-10-07 用户实测修复·真根因】OFD 的旋转**常写在 CTM 矩阵里**，而不是 Rotate 属性 ——
                //   实测样本（兰州局通报 OFD）：TextObject 带 `CTM="0.8660 -0.5000 0.5 0.8660 0 99.0000"`
                //   （即旋转 -30° 的倾斜水印），而旧判据只认 Rotate 属性 ⇒ **完全看不到它** ⇒
                //   打印审计水印（"用户名 + 编号 + 时间戳"，每页编号递增 5031291/2/3/4）整段落进正文。
                //   判据：CTM="a b c d e f" 中 **b 或 c 非 0** ⇒ 存在旋转/斜切（纯缩放平移时 b=c=0）。
                var ctm = attrAny(cur, ['CTM', 'ctm']);
                if (ctm) {
                    var cp = ctm.split(/\s+/).map(parseFloat);
                    if (cp.length >= 4 && (Math.abs(cp[1]) > 0.01 || Math.abs(cp[2]) > 0.01)) {
                        return 'CTM 旋转(' + ctm + ')';
                    }
                }
                var alpha = attrAny(cur, ['Alpha', 'alpha']);
                if (alpha !== '' && parseFloat(alpha) < 1) return 'Alpha=' + alpha;
                // 【2026-10-07 同上】Alpha 判据也漏两处：① OFD 标准取值是 **0~255**（也见 0~100 写法），
                //   不是 0~1 ⇒ `parseFloat('40') < 1` 恒假；② 它通常写在**子元素 `<ofd:FillColor Alpha="40">`** 上，
                //   而本函数只查"自身与祖先"的属性、不向下看子元素 ⇒ 同样落空。
                //   这里补：向下找 FillColor，Alpha < 100 视为半透明（正文极少半透明，且命中都会记入 removed 可核对）。
                try {
                    var fcs = (cur.getElementsByTagName && cur.getElementsByTagName('*')) || [];
                    for (var _fi = 0; _fi < fcs.length; _fi++) {
                        var _fc = fcs[_fi];
                        if (!_fc.localName || String(_fc.localName).toLowerCase() !== 'fillcolor') continue;
                        var _a = attrAny(_fc, ['Alpha', 'alpha']);
                        if (_a !== '' && isFinite(parseFloat(_a)) && parseFloat(_a) < 100) return 'FillColor Alpha=' + _a;
                    }
                } catch (eFC) {}
            }
            cur = cur.parentElement; hop++;
        }
        return '';
    }

    /** 数字属性（用于阅读顺序排序） */
    function num(el, name) {
        var v = attrAny(el, [name]);
        var n = parseFloat(v);
        return isNaN(n) ? 0 : n;
    }

    /**
     * 解析 OFD。
     * @param {File|Blob} file
     * @returns {Promise<{text:string, pageCount:number, removed:string[], note:string, images:number}>}
     */
    async function extract(file) {
        var ok = await ensureJSZip();
        if (!ok) return { text: '', pageCount: 0, removed: [], images: 0, note: 'JSZip 未加载，无法解包 OFD' };

        var buf = null;
        try { buf = await file.arrayBuffer(); } catch (e) { try { buf = await new Response(file).arrayBuffer(); } catch (e2) {} }
        if (!buf) return { text: '', pageCount: 0, removed: [], images: 0, note: '无法读取文件内容' };

        var zip;
        try { zip = await window.JSZip.loadAsync(buf); }
        catch (e) { return { text: '', pageCount: 0, removed: [], images: 0, note: '不是有效的 OFD（ZIP 解包失败）' }; }

        // ---------- ① 注释水印：水印字符串 + 需要整段丢弃的对象 ID ----------
        var wmTexts = [], wmIds = [], removed = [];
        var annotPaths = [];
        zip.forEach(function (p) { if (/Annots\/.*\.xml$/i.test(p)) annotPaths.push(p); });
        for (var ap = 0; ap < annotPaths.length; ap++) {
            var ax = parseXml(await readZipText(zip, annotPaths[ap]));
            if (!ax) continue;
            var annots = byLocal(ax, 'Annot');
            for (var ai = 0; ai < annots.length; ai++) {
                var a = annots[ai];
                var id = attrAny(a, ['ID', 'id', 'Name', 'name']);
                var type = attrAny(a, ['Type', 'type']);
                if (!(WATERMARK_HINT.test(type) || WATERMARK_HINT.test(id))) continue;
                wmIds.push(id);
                // 注释里的文字（含 Appearance 内嵌的 TextCode）全部视为水印文字
                var tcs = byLocal(a, 'TextCode');
                for (var ti = 0; ti < tcs.length; ti++) {
                    var t = (tcs[ti].textContent || '').trim();
                    if (t && wmTexts.indexOf(t) === -1) wmTexts.push(t);
                }
                var refs = byLocal(a, 'ObjectRef');
                for (var ri = 0; ri < refs.length; ri++) {
                    var rid = attrAny(refs[ri], ['ObjectID', 'ResourceID', 'ID']);
                    if (rid && wmIds.indexOf(rid) === -1) wmIds.push(rid);
                }
                removed.push('注释水印「' + (id || type) + '」' + (wmTexts.length ? '：' + wmTexts.join(' / ') : ''));
            }
        }

        // ---------- ② 页面顺序：来自 Document.xml 的 ofd:Page/BaseLoc（取不到就扫 Pages/*/Content.xml） ----------
        var pageLocs = [];
        var docXml = parseXml(await readZipText(zip, 'Doc_0/Document.xml')) || parseXml(await readZipText(zip, 'Document.xml'));
        if (docXml) {
            var pages = byLocal(docXml, 'Page');
            for (var pi = 0; pi < pages.length; pi++) {
                var baseLoc = attrAny(pages[pi], ['BaseLoc', 'baseloc']);
                if (baseLoc) pageLocs.push('Doc_0/' + baseLoc.replace(/^\.?\//, ''));
            }
        }
        if (!pageLocs.length) {
            var found = [];
            zip.forEach(function (p) { if (/Pages\/[^/]+\/Content\.xml$/i.test(p)) found.push(p); });
            pageLocs = found.sort();
        }

        // ---------- ③ 逐页抽正文 + 去水印 ----------
        var pageTexts = [], images = 0, pageLines = [], paragraphs = [];
        for (var pg = 0; pg < pageLocs.length; pg++) {
            var cx = parseXml(await readZipText(zip, pageLocs[pg]));
            if (!cx) { pageTexts.push(''); continue; }
            images += byLocal(cx, 'ImageObject').length;
            var objs = byLocal(cx, 'TextObject');
            var rows = [];
            for (var oi = 0; oi < objs.length; oi++) {
                var o = objs[oi];
                var oid = attrAny(o, ['ID', 'id']);
                if (oid && wmIds.indexOf(oid) !== -1) { removed.push('对象 ' + oid + '（注释指向的水印对象）'); continue; }
                var hintId = layerMark(o, 'hint');
                if (hintId) { removed.push('图层/对象「' + hintId + '」（名称命中水印特征）'); continue; }
                var lay = layerMark(o, 'layout');
                if (lay) { removed.push('对象 ' + (oid || '#') + '（版式特征 ' + lay + '，按水印丢弃）'); continue; }
                var codes = byLocal(o, 'TextCode');
                var s = '';
                for (var ci = 0; ci < codes.length; ci++) s += (codes[ci].textContent || '');
                s = s.replace(/\s+$/,'');
                if (!s.trim()) continue;
                // 【2026-10-03 用户报「OFD 导入后太乱」】坐标取值原来只读 TextObject 的 Y/整串 Boundary ✗，
                //   而 OFD 标准里字块坐标（X/Y）通常挂在 **ofd:TextCode** 上、TextObject 只带 Boundary="x y w h" ✗
                //   ⇒ 大量块坐标取成 0 ⇒ 全篇被挤成一行/乱序（用户截图就是这个样子）。
                //   现在按优先级取值：TextCode 的 X/Y → TextObject 的 Boundary(x y w h) → TextObject 的 X/Y；
                //   并顺带取字号（TextObject 的 Size 或 Boundary 的第 4 个数），供"按字号聚行"使用。
                var _xy = xySizeOf(o, codes);
                // 【2026-10-07 用户实测修复·真根因】页码对象必须在**聚行之前**剔除。
                //   实测该 OFD（兰州局通报）每页第一个对象就是页码：Size≈3.18pt 的纯数字"1"/"2"/"3"/"4"，
                //   而正文 Size≈5.63pt。若放它进聚行，会与**同 Y 的页眉文字粘成一行**
                //   （变成"1兰州局集团公司安全监察大队"）⇒ 下游 stripRunning 的 `isPageNumberLine` 判据
                //   只认"整行是页码"，粘连后自然失效 ⇒ 页码残留并粘进正文。
                //   实测后果：转换出的 DOCX 里出现 "5031291使用手电观察…" 这类怪串（水印编号+页码+正文三段粘连）。
                //   判据保守、零误伤：**字号 ≤4pt 且纯 1~4 位数字** —— 正文永远不会用这么小的字号。
                var _ptxt = String(s == null ? '' : s).trim();
                if (_xy.size > 0 && _xy.size <= 4 && /^\d{1,4}$/.test(_ptxt)) {
                    removed.push('页码对象「' + _ptxt + '」');
                    continue;
                }
                rows.push({ y: _xy.y, x: _xy.x, size: _xy.size, s: s });
            }
            // 阅读顺序与分段交给共享模块 ImportLayout（行内按 X、行间按 Y、段落按标点/间距/条款头/缩进）
            var _lay = window.ImportLayout;
            if (_lay) {
                // 先只聚行，不急着成段 —— 因为**页码/页眉页脚/水印戳的判定要跨页**（见下面 stripRunning）
                pageLines.push(_lay.linesFromBoxes(rows.map(function (r) { return { x: r.x, y: r.y, size: r.size, text: r.s }; })));
            } else {
                rows.sort(function (a, b) { return (a.y - b.y) || (a.x - b.x); });
                pageTexts.push(rows.map(function (r) { return r.s; }).join('\n'));
            }
        }

        // 跨页清理（与 PDF 同一套）：页码（"— — 1 — —"）、**行内页码标记**（"…通用规定— — 6 — —"）、
        //   重复页眉页脚（如规章编号）、打印水印戳（IP+用户+时间）
        var text = '', blocks = [];
        if (_lay && pageLines.length) {
            var _st = _lay.stripRunning(pageLines);
            pageLines = _st.pages || [];
            if (_st.removed && _st.removed.length) for (var _ri = 0; _ri < _st.removed.length; _ri++) removed.push(_st.removed[_ri]);
            if (_lay.buildFromPageLines) {
                // PDF 的全套处理（跨页段落合并 + 公文体例 + 表格还原）走**同一个**入口，避免两套实现漂移
                var _built = _lay.buildFromPageLines(pageLines);
                text = _built.text;
                blocks = _built.blocks || [];
                paragraphs = _built.paragraphs || [];
            } else {
                var _perPage = pageLines.map(function (ls) { return _lay.paragraphsFromLines(ls); });
                paragraphs = (_lay.mergePages ? _lay.mergePages(_perPage) : [].concat.apply([], _perPage));
                text = _lay.toText(paragraphs);
            }
        } else {
            text = pageTexts.filter(function (t) { return t.trim() !== ''; }).join('\n');
        }

        // ---------- ④ 把注释水印文字串从整篇正文里剔除 ----------
        var hit = 0;
        for (var wi = 0; wi < wmTexts.length; wi++) {
            var w = wmTexts[wi];
            if (!w) continue;
            var before = text;
            while (text.indexOf(w) !== -1) { text = text.split(w).join(''); hit++; if (hit > 200) break; }
            if (before !== text) removed.push('正文中剔除水印文字「' + w + '」');
        }
        text = text.split('\n').map(function (l) { return l.replace(/[ \t]+$/,''); }).filter(function (l) { return l.trim() !== ''; }).join('\n');

        // 去重提示（同一原因反复出现时只报一次，避免日志刷屏）
        var uniq = [];
        for (var ri2 = 0; ri2 < removed.length; ri2++) if (uniq.indexOf(removed[ri2]) === -1) uniq.push(removed[ri2]);

        var note = '';
        if (!text.trim()) note = '未解析出文字（可能是扫描件/纯图片版 OFD，或文本被画成了矢量路径）';
        if (images > 0) note += (note ? '；' : '') + '文档含 ' + images + ' 张图片，未提取图片内文字';

        return { text: text, paragraphs: paragraphs, blocks: blocks, pageCount: pageLocs.length, removed: uniq, note: note, images: images };
    }

    window.OFDImport = { extract: extract, version: '1.0', _hint: WATERMARK_HINT };
})();
