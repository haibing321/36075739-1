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

    var WATERMARK_HINT = /水印|watermark|内部资料|内部文件|严禁|禁止外传|仅供|样张|副本|机密|秘密|绝密|confidential|internal\s*use|specimen|copy\s*only/i;

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
                var alpha = attrAny(cur, ['Alpha', 'alpha']);
                if (alpha !== '' && parseFloat(alpha) < 1) return 'Alpha=' + alpha;
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
                // 【2026-10-03 用户报】原来这里每行直接 '\n' 拼接 ⇒ **每行一个硬回车**（段内全是硬回车）。
                //   现在只交出"带坐标的块"，由 ImportLayout 聚行并还原自然段（续行不再加硬回车）。
                rows.push({ y: num(o, 'Y') || num(o, 'Boundary'), x: num(o, 'X'), s: s });
            }
            // 阅读顺序与分段交给共享模块 ImportLayout（行内按 X、行间按 Y、段落按标点/间距/条款头/缩进）
            var _lay = window.ImportLayout;
            if (_lay) {
                // 先只聚行，不急着成段 —— 因为**页码/页眉页脚/水印戳的判定要跨页**（见下面 stripRunning）
                pageLines.push(_lay.linesFromBoxes(rows.map(function (r) { return { x: r.x, y: r.y, text: r.s }; })));
            } else {
                rows.sort(function (a, b) { return (a.y - b.y) || (a.x - b.x); });
                pageTexts.push(rows.map(function (r) { return r.s; }).join('\n'));
            }
        }

        // 跨页清理（与 PDF 同一套）：页码（"— — 1 — —"）、**行内页码标记**（"…通用规定— — 6 — —"）、
        //   重复页眉页脚（如规章编号）、打印水印戳（IP+用户+时间）
        var text = '';
        if (_lay && pageLines.length) {
            var _st = _lay.stripRunning(pageLines);
            pageLines = _st.pages || [];
            if (_st.removed && _st.removed.length) for (var _ri = 0; _ri < _st.removed.length; _ri++) removed.push(_st.removed[_ri]);
            var _perPage = pageLines.map(function (ls) { return _lay.paragraphsFromLines(ls); });
            // 【跨页段落合并】OFD 同样会出现"一段跨页被切成两段"，与 PDF 用同一个合并器
            var _allParas = (_lay.mergePages ? _lay.mergePages(_perPage) : [].concat.apply([], _perPage));
            // 与 PDF 同款公文体例格式化（分类 + 条款编号后补空格），并把结构化段落一并交出去
            paragraphs = (_lay.formatParagraphs ? _lay.formatParagraphs(_allParas) : _allParas);
            text = _lay.toText(paragraphs);
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

        return { text: text, paragraphs: paragraphs, pageCount: pageLocs.length, removed: uniq, note: note, images: images };
    }

    window.OFDImport = { extract: extract, version: '1.0', _hint: WATERMARK_HINT };
})();
