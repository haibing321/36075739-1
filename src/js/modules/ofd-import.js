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

    // ==================== 【2026-10-22】表格线与图片：转成 ImportLayout 既有通道 ====================
    // 背景：OFD 此前 `skipTables: true` + 不取图片 ⇒ 表格只剩散落的文字、图片完全丢失。
    //   ImportLayout 早已支持 `pageSegments`（逐页矢量框线 → 网格还原表格）与 `pageImages`
    //   （逐页图片 → 按位置插入块流），PDF 侧用的就是这两条通道。OFD 只是没把数据喂进去。
    //   OFD 的表格线是独立 `ofd:PathObject`：`Boundary="x y w h"` 给起点，`AbbreviatedData` 里的
    //   M/L 是**相对该起点的局部坐标**（实测 `M 0.0847 0.0847 L 246.0872 0.0847`）。
    //   这里把它们换算成与 PDF 完全相同的线段格式 `{k:'h'|'v', x1,y1,x2,y2}`，直接复用同一套网格算法。
    function ofdPathSegments(cx) {
        var out = [];
        var addSeg = function (x1, y1, x2, y2) {
            if (Math.abs(y1 - y2) < 0.6 && Math.abs(x2 - x1) > 4) out.push({ k: 'h', x1: x1, y1: y1, x2: x2, y2: y2 });
            else if (Math.abs(x1 - x2) < 0.6 && Math.abs(y2 - y1) > 4) out.push({ k: 'v', x1: x1, y1: y1, x2: x2, y2: y2 });
        };
        var paths = byLocal(cx, 'PathObject');
        for (var pi = 0; pi < paths.length; pi++) {
            var p = paths[pi];
            var bnd = attrAny(p, ['Boundary', 'boundary']);
            var bp = bnd ? bnd.split(/\s+/).map(parseFloat) : [];
            if (bp.length < 2 || !isFinite(bp[0]) || !isFinite(bp[1])) continue;
            var bx = bp[0], by = bp[1];
            var sx = 1, sy = 1;
            var ctm = attrAny(p, ['CTM', 'ctm']);
            if (ctm) {
                var cp = ctm.split(/\s+/).map(parseFloat);
                if (cp.length >= 4 && isFinite(cp[0]) && cp[0] !== 0) sx = cp[0];
                if (cp.length >= 4 && isFinite(cp[3]) && cp[3] !== 0) sy = cp[3];
            }
            var ad = byLocal(p, 'AbbreviatedData')[0];
            var s = ad ? String(ad.textContent || '') : '';
            if (!s) continue;
            var toks = s.replace(/,/g, ' ').split(/\s+/);
            var px = null, py = null;
            for (var i = 0; i < toks.length; i++) {
                var t = toks[i];
                if (t === 'M' || t === 'L') {
                    var nx = parseFloat(toks[++i]), ny = parseFloat(toks[++i]);
                    if (!isFinite(nx) || !isFinite(ny)) break;
                    var ax = bx + nx * sx, ay = by + ny * sy;
                    if (px != null) addSeg(px, py, ax, ay);
                    px = ax; py = ay;
                } else if (t === 'C' || t === 'c') { i += 6; px = py = null; }   // 贝塞尔：表格线用不到，跳过参数
                else if (t === 'Q' || t === 'q') { i += 4; px = py = null; }
                else if (t === 'Z' || t === 'z') { px = py = null; }
                else if (/^[A-Za-z]$/.test(t)) { break; }                        // 弧等复杂命令：本对象放弃
            }
        }
        return out;
    }

    /** 图片：ImageObject → {src(dataURI), w, h, top}；资源来自 PublicRes/DocumentRes 的 MultiMedia */
    function ofdImageBoxes(cx, resMap) {
        var out = [];
        var imgs = byLocal(cx, 'ImageObject');
        for (var i = 0; i < imgs.length; i++) {
            var im = imgs[i];
            var rid = attrAny(im, ['ResourceID', 'resourceid']);
            var bnd = attrAny(im, ['Boundary', 'boundary']);
            var bp = bnd ? bnd.split(/\s+/).map(parseFloat) : [];
            var ent = (rid && resMap) ? resMap[rid] : null;
            out.push({
                src: (ent && ent.dataUri) ? ent.dataUri : '',
                w: (bp.length >= 4 && bp[2] > 0) ? bp[2] : 0,
                h: (bp.length >= 4 && bp[3] > 0) ? bp[3] : 0,
                top: (bp.length >= 2 && isFinite(bp[1])) ? bp[1] : 0,
                alt: '图片'
            });
        }
        return out;
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
                // ⚠️⚠️【2026-10-07 二次修复·回归教训，务必保留这段注释】判定必须严格区分
                //   「**元素自身**」与「**祖先层**」——上一版把"向下扫 FillColor"直接写进了这个**逐层向上**的
                //   while 里，于是当 `cur` 升到 Layer/Page（页内所有对象的父容器）时，
                //   `cur.getElementsByTagName('*')` 扫到了**同层水印对象**的 `<ofd:FillColor Alpha="40">`
                //   ⇒ 于是**每一个正文 TextObject** 都被判成"版式水印"整段丢弃 ⇒ 用户实测：
                //   整篇 OFD 转换后"识别 0 个块 / 未解析出文字"，而页数/图片数仍显示正常（正是本函数的特征）。
                //   原则：**自身特征只查自身（含直系子元素）；祖先只认"层被明确标成水印"的原文证据（Rotate / 层名含 hint）**。
                var _self = (cur === el);
                if (_self) {
                    // ① 旋转写在 CTM 矩阵里（实测水印：`CTM="0.8660 -0.5000 0.5 0.8660 0 99.0000"` = 旋转 -30°）。
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
                    // ② 半透明写在**直系子元素** `<ofd:FillColor Alpha="40"/>`（OFD 的 Alpha 是 0~255，不是 0~1）。
                    //   ⚠️ 只查**直系子元素**（children），绝不 `getElementsByTagName('*')` 递归向下 —— 见上方回归教训。
                    var kids = cur.children || [];
                    for (var _ki = 0; _ki < kids.length; _ki++) {
                        var _k = kids[_ki];
                        if (!_k.localName || String(_k.localName).toLowerCase() !== 'fillcolor') continue;
                        var _a2 = attrAny(_k, ['Alpha', 'alpha']);
                        if (_a2 !== '' && isFinite(parseFloat(_a2)) && parseFloat(_a2) < 100) return 'FillColor Alpha=' + _a2;
                    }
                }
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

        // 【2026-10-22 保真度】页高（mm）：来自 Document.xml 的 ofd:PageArea/ofd:PhysicalBox（如 "0 0 210 297"）。
        //   用途：给"页码对象"判据加一条**位置**约束 —— 页码只会出现在页面上下边缘带，
        //   而表格里的数字在页面中部（实测该通知：表格数字 y=72~156、页高 297）。
        var _pageH = 0;
        try {
            var _pb = byLocal(docXml, 'PhysicalBox')[0];
            if (_pb) {
                var _pv = String(_pb.textContent || '').split(/\s+/).map(parseFloat);
                if (_pv.length >= 4 && _pv[3] > 0) _pageH = _pv[3];
            }
        } catch (ePH) {}

        // 资源映射（图片）：PublicRes.xml/DocumentRes.xml 里的 ofd:MultiMedia ID → MediaFile。
        //   读出图片字节后转 data URI（本项目 DOCX 规章路径也是把图片转成可渲染形式再入库）。
        var _resMap = {};
        try {
            var _resXml = parseXml(await readZipText(zip, 'Doc_0/PublicRes.xml'))
                || parseXml(await readZipText(zip, 'PublicRes.xml'))
                || parseXml(await readZipText(zip, 'Doc_0/DocumentRes.xml'));
            if (_resXml) {
                var _resBase = attrAny(_resXml.documentElement || {}, ['BaseLoc', 'baseloc']) || 'Res';
                var _base = 'Doc_0/' + String(_resBase).replace(/^\.?\/?/, '').replace(/\/?$/, '') + '/';
                var _mms = byLocal(_resXml, 'MultiMedia');
                for (var _mi = 0; _mi < _mms.length; _mi++) {
                    var _mid = attrAny(_mms[_mi], ['ID', 'id']);
                    // OFD 规范里 MediaFile 通常写成**子元素** `<ofd:MediaFile>Res/logo.png</ofd:MediaFile>`，
                    //   而不是属性；只读属性会得到空串 ⇒ 图片 src 为空（实测正是这个原因）。
                    var _mf = attrAny(_mms[_mi], ['MediaFile', 'mediafile']);
                    if (!_mf) {
                        var _mfe = byLocal(_mms[_mi], 'MediaFile')[0];
                        if (_mfe) _mf = String(_mfe.textContent || '').trim();
                    }
                    if (!_mid || !_mf) continue;
                    // MediaFile 可能已带目录（"Res/logo.png"）：带了就直接用，避免拼成 Doc_0/Res/Res/...
                    var _path = _mf.indexOf('/') !== -1
                        ? 'Doc_0/' + _mf.replace(/^\.?\//, '')
                        : _base + _mf.replace(/^\.?\//, '');
                    var _bf = zip.file(_path) || zip.file('Doc_0/Res/' + _mf.replace(/^\.?\/?(Res\/)?/, ''));
                    if (!_bf) continue;
                    var _ext = (_mf.split('.').pop() || '').toLowerCase();
                    var _mime = _ext === 'jpg' || _ext === 'jpeg' ? 'image/jpeg'
                        : _ext === 'gif' ? 'image/gif'
                        : _ext === 'bmp' ? 'image/bmp'
                        : _ext === 'svg' ? 'image/svg+xml' : 'image/png';
                    try {
                        var _b64 = await _bf.async('base64');
                        _resMap[_mid] = { dataUri: 'data:' + _mime + ';base64,' + _b64 };
                    } catch (eB64) {}
                }
            }
        } catch (eRes) {}

        // ---------- ③ 逐页抽正文 + 去水印 ----------
        var pageTexts = [], images = 0, pageLines = [], paragraphs = [];
        var _pageSegs = [], _pageImgs = [];   // 逐页矢量框线（表格）+ 图片，交给 ImportLayout
        for (var pg = 0; pg < pageLocs.length; pg++) {
            var cx = parseXml(await readZipText(zip, pageLocs[pg]));
            if (!cx) { pageTexts.push(''); _pageSegs.push([]); _pageImgs.push([]); continue; }
            images += byLocal(cx, 'ImageObject').length;
            // 【2026-10-22】把 OFD 的表格线与图片喂给 ImportLayout（PDF 用的是同两条通道）
            var _segsNow = [];
            try { _segsNow = ofdPathSegments(cx); } catch (eSg) { _segsNow = []; }
            _pageSegs.push(_segsNow);
            try { _pageImgs.push(ofdImageBoxes(cx, _resMap)); } catch (eIm) { _pageImgs.push([]); }
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
                //   判据保守、零误伤：**对象自身标注的小字号（Size ≤4pt）+ 纯 1~4 位数字**。
                //   ⚠️ 只认 **Size 属性**，不用 `_xy.size` —— 后者在对象没有 Size 属性时会回退取
                //   `Boundary` 的第 4 个数，那是**毫米高度**（正文行高约 2mm）⇒ `≤4` 会把正文里的
                //   纯数字小对象（如"25768""0083"）误判成页码删掉。实测该文件页码对象带 `Size="3.175"`，
                //   正文带 `Size="5.6268"` ⇒ 用 Size 属性判定两者区分得很干净。
                var _ptxt = String(s == null ? '' : s).trim();
                var _sizeAttr = parseFloat(attrAny(o, ['Size', 'size']));
                if (isFinite(_sizeAttr) && _sizeAttr > 0 && _sizeAttr <= 4 && /^\d{1,4}$/.test(_ptxt)) {
                    // 【2026-10-22 保真度·误删修复】原判据只有"小字号 + 纯数字"，实测把**表格里的数字**
                    //   全部当页码删掉：该通知 24 页里有 78 个被删，其中 54 个数值大于总页数
                    //   （2026 / 412 / 2835 / 4190 …显然不是页码），而 116 个表格数字的 Size 统一是 3.8806、
                    //   坐标都在页面中部（y≈72~156，页高 297）。丢掉这些数字后，表格只剩标签没有值。
                    //   现补两条必需条件：
                    //     ① 页码值不可能大于总页数；
                    //     ② 页码位于页面**上下边缘带**（各 13%，与常见页眉页脚位置相符）。
                    //   两条都不满足时一律保留（宁可留噪声，不能删正文）。
                    var _pnNum = parseInt(_ptxt, 10);
                    var _edgeOk = true;
                    if (_pageH > 0 && _xy.y != null) {
                        _edgeOk = (_xy.y <= _pageH * 0.13) || (_xy.y >= _pageH * 0.87);
                    }
                    if (_pnNum <= pageLocs.length && _edgeOk) {
                        removed.push('页码对象「' + _ptxt + '」');
                        continue;
                    }
                }
                rows.push({ y: _xy.y, x: _xy.x, size: _xy.size, s: s });
            }
            // 【预筛】这一页的框线到底能不能表达列结构？
            //   判据：网格列数够（≥3 列）+ 落在网格 y 范围内的文字**x 聚类数**没有远超列数。
            //   实测：合成 3×3 样本 → 3 簇 vs 3 列 ⇒ 可信（交给网格建表）；
            //         兰州局通知第 12 页 → 40 簇 vs 5 列 ⇒ 线不够（走下面的行级拼行，不硬造表）。
            var _gridOk = false;
            try {
                var _layPre = window.ImportLayout;     // 注意：下面才声明 _lay，这里必须直接取 window
                if (_segsNow.length && _layPre && _layPre.gridFromSegments) {
                    var _gPre = _layPre.gridFromSegments(_segsNow, {});
                    if (_gPre && _gPre.xs.length >= 4 && _gPre.ys.length >= 3) {
                        var _gy0 = Math.min.apply(null, _gPre.ys), _gy1 = Math.max.apply(null, _gPre.ys);
                        var _xsIn = rows.filter(function (r) { return r.y != null && r.y >= _gy0 - 2 && r.y <= _gy1 + 2; })
                            .map(function (r) { return r.x || 0; }).sort(function (a, b) { return a - b; });
                        var _cl = 0, _lastX = -1e9;
                        _xsIn.forEach(function (x) { if (x - _lastX > 3) { _cl++; _lastX = x; } });
                        _gridOk = !(_cl > Math.max(6, (_gPre.xs.length - 1) * 2));
                    }
                }
            } catch (eGO) {}
            // 【2026-10-22 行级还原】横线是该文件里**最可靠的**结构证据（实测每页 9 条，
            //   而竖线只有 6 条、中间列的分隔线在文件里根本不存在 ⇒ 列结构无法确定）。
            //   这里只做"行"这一级：把落在同一横线带（相邻两条横线之间）的文字块按 x 拼成一行。
            //   不声称列结构（不会假装还原成表格），但保证**同一表格行的内容在同一行文本里** ——
            //   对 AI 阅读（"序号 1 的供电分段示意图，6 个工区都是 √"）和人工核对都有实益。
            //   ⚠️ 只在"网格不可信"时启用：网格可信的页要留给表格还原（否则会把行拼成一条、
            //      破坏网格所需的逐格文字块 —— 合成 3×3 样本实测会退化成 1 个段落）。
            var _hs = [];
            if (!_gridOk) {
                for (var _si = 0; _si < _segsNow.length; _si++) {
                    if (_segsNow[_si].k === 'h') _hs.push((_segsNow[_si].y1 + _segsNow[_si].y2) / 2);
                }
            }
            if (_hs.length >= 3 && rows.length >= _hs.length * 2) {
                try {
                    _hs.sort(function (a, b) { return a - b; });
                    var _bands = [];
                    for (var _rj = 0; _rj < rows.length; _rj++) {
                        var _r = rows[_rj];
                        if (_r.y == null) continue;
                        var _bi = 0;
                        for (var _hi = 0; _hi < _hs.length; _hi++) { if (_r.y >= _hs[_hi]) _bi = _hi; }
                        (_bands[_bi] = _bands[_bi] || []).push(_r);
                    }
                    var _merged = 0, _outRows = [];
                    _bands.forEach(function (arr) {
                        if (!arr || !arr.length) return;
                        arr.sort(function (a, b) { return (a.x || 0) - (b.x || 0); });
                        var _txt = arr.map(function (a) { return a.s; }).join(' | ');
                        // 【长度门禁】真正的表格行都很短；一旦拼接后超过 200 字，说明这一"带"里
                        //   混进了整段正文（横线可能是标题下的分隔线），**不拼**、保持原样，
                        //   否则会把正文压成一条 300+ 字的怪行（实测出现过 9 条）。
                        if (arr.length > 1 && _txt.length <= 200) {
                            _merged++;
                            var _midY = arr.reduce(function (acc, a) { return acc + (a.y || 0); }, 0) / arr.length;
                            _outRows.push({ x: arr[0].x, y: _midY, size: arr[0].size, s: _txt });
                        } else {
                            arr.forEach(function (a) { _outRows.push(a); });
                        }
                    });
                    // 至少 2 个"多块行"才认为确实是逐行排列的表格；否则维持原样（避免误合并段落）
                    if (_merged >= 2 && _outRows.length >= 3) {
                        rows = _outRows;
                        try { window.__ofdRowBands = (window.__ofdRowBands || 0) + 1; } catch (eRb) {}
                    }
                } catch (eBand) {}
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
                // 【2026-10-09 用户决策】OFD 与 PDF 同链路 ⇒ 同样"跳过表格、只导文字"（见 import-layout 的 skipTables）
                // 【2026-10-22】不再一刀切 `skipTables:true`：把逐页框线与图片交给共用布局层 ——
                //   · pageSegments：该页框线能聚出网格（xs≥3 且 ys≥2）⇒ 确定性还原表格；否则该页仍按"只导文字"兜底；
                //   · pageImages：图片按"顶边落在第几行之前"插回块流（src 为 data URI，可直接渲染）；
                //   · flipY:false —— OFD 的 Y 轴朝下（PDF 朝上），方向错了段落会整体倒序。
                // ⚠️ 先克隆一份：buildFromPageLines 会**就地改写** pageLines（网格建表时把表格文字从行里摘走），
                //   回退重建必须用"没被摘过"的原始行，否则表格里的文字会被二次构建丢掉（实测正文从 11.5k 掉到 5.8k）。
                var _linesBackup = null;
                try { _linesBackup = JSON.parse(JSON.stringify(pageLines)); } catch (eBk) { _linesBackup = null; }
                var _built = _lay.buildFromPageLines(pageLines, {
                    pageSegments: _pageSegs,
                    pageImages: _pageImgs,
                    flipY: false
                });
                // ⚠️【质量门禁·必须有】OFD 的框线常不足以表达列结构（实测兰州局通知第 12 页：
                //   只聚出 6 条竖线 / 5 列，而文字块是跨格短语 ⇒ 整段正文被吞进一个单元格，
                //   重建出的表像"二、查管理 | 否存在7成量化指标…"这种串行垃圾）。
                //   错表比无表更糟（正文被切碎，且看起来像"还原成功了"）⇒ 建完先体检：
                //   任一单元格文字超过 OFD_TABLE_CELL_MAX 字 ⇒ 判定"线不够"，**回退为纯文本**重建。
                try {
                    var OFD_TABLE_CELL_MAX = 60;
                    var _dirty = false, _tblN = 0;
                    (_built.blocks || []).forEach(function (b) {
                        if (!b || b.type !== 'table') return;
                        _tblN++;
                        var rows = b.rows || [];
                        for (var _ri2 = 0; _ri2 < rows.length && !_dirty; _ri2++) {
                            var row = rows[_ri2] || [];
                            for (var _ci2 = 0; _ci2 < row.length; _ci2++) {
                                if (String(row[_ci2] == null ? '' : row[_ci2]).length > OFD_TABLE_CELL_MAX) { _dirty = true; break; }
                            }
                        }
                    });
                    if (_tblN && _dirty) {
                        _built = _lay.buildFromPageLines(_linesBackup || pageLines, {
                            pageImages: _pageImgs,
                            skipTables: true,        // 显式回到"只导文字"，且不带框线
                            flipY: false
                        });
                        try { window.__ofdDirtyTables = _tblN; } catch (eD1) {}
                        removed.push('表格重建质量不足（单元格吞入正文），已回退为纯文本');
                    }
                } catch (eGate) {}
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
        if (images > 0) {
            // 【2026-10-22】图片现在会按原位置**插入**（src 为 data URI），只是不做 OCR ⇒ 提示要准确，
            //   否则用户以为图片又丢了（旧文案"未提取"会让人以为整张图都没了）。
            var _emb = 0;
            (_pageImgs || []).forEach(function (arr) {
                (arr || []).forEach(function (im) { if (im && im.src) _emb++; });
            });
            note += (note ? '；' : '') + '文档含 ' + images + ' 张图片，'
                + (_emb > 0 ? ('已按原位置插入 ' + _emb + ' 张') : '未能取到图片资源')
                + '（图片内文字未识别）';
        }

        return { text: text, paragraphs: paragraphs, blocks: blocks, pageCount: pageLocs.length, removed: uniq, note: note, images: images };
    }

    window.OFDImport = { extract: extract, version: '1.0', _hint: WATERMARK_HINT };
})();
