/*!
 * docx-export.js — 铁路安监智能辅助系统 · DOCX 导出引擎
 * ---------------------------------------------------------------------------
 * 设计目标（替代原 html-docx-js 的 altChunk 方案）：
 *   ① 真·OOXML（WordprocessingML）生成 —— 直接写 document.xml / styles.xml /
 *      sectPr 页边距 / 页码页脚 / 表格 / 内嵌图片，不再依赖 Word 的 HTML 导入引擎。
 *      好处：WPS / Word 桌面版 / Word 网页版 / Word for Mac / LibreOffice / Google Docs
 *      全平台可开（altChunk 方案只有桌面版 MS Word 认）。
 *   ② 内置「党政机关公文格式」（GB/T 9704-2012）排版：A4、上37/下35/左28/右26mm 版心、
 *      正文仿宋_GB2312三号、行距固定值28pt、首行缩进2字、标题方正小标宋二号居中、
 *      一/二/三级层次（黑体/楷体/仿宋）、页码宋体四号奇右偶左。
 *   ③ 上传的 .docx 模板填充：保住模板原有版式（styles/页眉页脚/页面设置全部保留），
 *      只把 {{正文}} / {{标题}} / {{日期}} 等占位符换成生成内容。
 *
 * 依赖：JSZip（项目既有依赖，SW 已预热 CDN，离线可用）。无其他依赖。
 * 入口：window.RGDocx
 * ---------------------------------------------------------------------------
 * 作者：haibing  ·  许可：随本项目
 */
(function (global) {
    'use strict';

    var LIB_JSZIP = 'src/js/vendor/jszip.min.js';
    var STYLE_KEY = 'wr_docx_style';    // localStorage：导出排版偏好

    /* =======================================================================
     * 一、命名空间常量
     * ===================================================================== */
    var XML_HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n';
    var NS_W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
    var NS_R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
    var NS_WP = 'http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing';
    var NS_A = 'http://schemas.openxmlformats.org/drawingml/2006/main';
    var NS_PIC = 'http://schemas.openxmlformats.org/drawingml/2006/picture';
    var NS_CT = 'http://schemas.openxmlformats.org/package/2006/content-types';
    var NS_REL = 'http://schemas.openxmlformats.org/package/2006/relationships';
    var NS_CP = 'http://schemas.openxmlformats.org/package/2006/metadata/core-properties';
    var NS_DC = 'http://purl.org/dc/elements/1.1/';
    var NS_DCTERMS = 'http://purl.org/dc/terms/';
    var NS_XSI = 'http://www.w3.org/2001/XMLSchema-instance';

    var REL_OFFICE_DOC = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument';
    var REL_CORE = 'http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties';
    var REL_APP = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties';
    var REL_STYLES = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles';
    var REL_SETTINGS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/settings';
    var REL_FONT_TABLE = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/fontTable';
    var REL_FOOTER = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer';
    var REL_IMAGE = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/image';

    /* =======================================================================
     * 二、排版规范表
     *   size : 半磅（half-point），三号16pt=32、小四12pt=24
     *   line : w:spacing/@w:line，exact 规则下单位为 1/20 磅，560=28pt
     *   indent: 首行缩进字符数
     * ===================================================================== */

    /** 党政机关公文格式 GB/T 9704-2012 */
    var GONGWEN = {
        id: 'gongwen',
        label: '公文格式',
        page: { w: 11906, h: 16838 },                            // A4 210×297mm
        margin: { top: 37, right: 26, bottom: 35, left: 28 },    // 版心 156×225mm
        header: 851, footer: 1440,
        latin: 'Times New Roman',
        pageNum: { font: '宋体', size: 28 },                      // 四号
        // 正文：仿宋_GB2312 三号，固定行距 28pt，首行缩进 2 字
        body: { font: '仿宋_GB2312', size: 32, line: 560, lineRule: 'exact', indent: 2 },
        // 标题：方正小标宋简体 二号，居中，行距固定 32pt
        title: { font: '方正小标宋简体', size: 44, line: 640, lineRule: 'exact', align: 'center', indent: 0, before: 0, after: 240 },
        h1: { font: '黑体', size: 32, line: 560, lineRule: 'exact', indent: 2, keepNext: true },        // 一、
        h2: { font: '楷体_GB2312', size: 32, line: 560, lineRule: 'exact', indent: 2, keepNext: true }, // （一）
        h3: { font: '仿宋_GB2312', size: 32, line: 560, lineRule: 'exact', indent: 2, keepNext: true }, // 1.
        quote: { font: '楷体_GB2312', size: 32, line: 560, lineRule: 'exact', indent: 2 },
        cell: { font: '仿宋_GB2312', size: 28, line: 340, lineRule: 'exact', indent: 0 },      // 表内四号
        cellHead: { font: '黑体', size: 28, line: 340, lineRule: 'exact', indent: 0 },
        code: { font: '仿宋_GB2312', size: 28, line: 320, lineRule: 'exact', indent: 0, align: 'left' },
        caption: { font: '楷体_GB2312', size: 28, line: 340, lineRule: 'exact', align: 'center', indent: 0 },
        date: { font: '仿宋_GB2312', size: 32, line: 560, lineRule: 'exact', align: 'right', indent: 0 }
    };

    /** 通用排版：桌面 Word 常见观感（标题黑体、正文宋体小四、1.5 倍行距、四边 2.54cm） */
    var PLAIN = {
        id: 'plain',
        label: '通用排版',
        page: { w: 11906, h: 16838 },
        margin: { top: 25.4, right: 25.4, bottom: 25.4, left: 25.4 },
        header: 851, footer: 992,
        latin: 'Times New Roman',
        pageNum: null,                                           // 通用排版不加页码
        body: { font: '宋体', size: 24, line: 360, lineRule: 'auto', indent: 2 },
        title: { font: '黑体', size: 36, line: 480, lineRule: 'auto', align: 'center', indent: 0, bold: true, after: 240 },
        h1: { font: '黑体', size: 30, line: 400, lineRule: 'auto', indent: 0, bold: true, keepNext: true, before: 240, after: 120 },
        h2: { font: '黑体', size: 28, line: 400, lineRule: 'auto', indent: 0, bold: true, keepNext: true, before: 200, after: 100 },
        h3: { font: '黑体', size: 26, line: 380, lineRule: 'auto', indent: 0, bold: true, keepNext: true, before: 160, after: 80 },
        quote: { font: '楷体', size: 24, line: 360, lineRule: 'auto', indent: 2 },
        cell: { font: '宋体', size: 21, line: 300, lineRule: 'auto', indent: 0 },
        cellHead: { font: '黑体', size: 21, line: 300, lineRule: 'auto', indent: 0, bold: true },
        code: { font: '宋体', size: 21, line: 300, lineRule: 'auto', indent: 0 },
        caption: { font: '楷体', size: 21, line: 300, lineRule: 'auto', align: 'center', indent: 0 },
        date: { font: '宋体', size: 24, line: 360, lineRule: 'auto', align: 'right', indent: 0 }
    };

    var STYLES = { gongwen: GONGWEN, plain: PLAIN };

    /* =======================================================================
     * 三、基础工具
     * ===================================================================== */

    var TWIP_PER_MM = 56.6929;
    var EMU_PER_PX = 9525;          // 96 DPI

    function mm2twip(mm) { return Math.round(Number(mm || 0) * TWIP_PER_MM); }

    /** XML 文本节点转义（同时剔除 XML 1.0 非法控制字符，否则 Word 判定文件损坏） */
    function escText(s) {
        return String(s == null ? '' : s)
            .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g, '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;');
    }
    /** XML 属性值转义 */
    function escAttr(s) { return escText(s).replace(/"/g, '&quot;').replace(/'/g, '&apos;'); }

    var ENTITY_MAP = {
        amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0',
        ldquo: '\u201c', rdquo: '\u201d', lsquo: '\u2018', rsquo: '\u2019',
        mdash: '\u2014', ndash: '\u2013', hellip: '\u2026', middot: '\u00b7',
        times: '\u00d7', divide: '\u00f7', deg: '\u00b0', prime: '\u2032',
        permil: '\u2030', laquo: '\u00ab', raquo: '\u00bb', bull: '\u2022',
        sect: '\u00a7', para: '\u00b6', yen: '\u00a5', copy: '\u00a9',
        reg: '\u00ae', trade: '\u2122', ensp: '\u2002', emsp: '\u2003', shy: '\u00ad'
    };

    function decodeEntities(s) {
        return String(s == null ? '' : s).replace(/&(#[xX]?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, function (all, body) {
            if (body.charAt(0) === '#') {
                var cp = (body.charAt(1) === 'x' || body.charAt(1) === 'X')
                    ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
                if (!isFinite(cp) || cp <= 0) return all;
                try { return String.fromCodePoint(cp); } catch (e) { return all; }
            }
            var v = ENTITY_MAP[body.toLowerCase()];
            return v != null ? v : all;
        });
    }

    function b64ToU8(b64) {
        var clean = String(b64 || '').replace(/[^A-Za-z0-9+/=]/g, '');
        if (typeof global.atob === 'function') {
            try {
                var bin = global.atob(clean);
                var u = new Uint8Array(bin.length);
                for (var i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
                return u;
            } catch (e) { /* 落到 Buffer */ }
        }
        if (typeof Buffer !== 'undefined') return new Uint8Array(Buffer.from(clean, 'base64'));
        return new Uint8Array(0);
    }

    /** 取 JSZip 构造器：浏览器端按需加载 CDN（已由 SW 预热），Node 端 require */
    function getZipLib() {
        if (global.JSZip) return Promise.resolve(global.JSZip);
        if (typeof global.requireLib === 'function') {
            return global.requireLib(LIB_JSZIP, { feature: '报告导出', silent: true })
                .then(function () { return global.JSZip || null; })
                .catch(function () { return null; });
        }
        if (typeof global.loadScript === 'function') {
            return global.loadScript(LIB_JSZIP).then(function () { return global.JSZip || null; })
                .catch(function () { return null; });
        }
        if (typeof require === 'function') {
            try { return Promise.resolve(require('jszip')); } catch (e) { return Promise.resolve(null); }
        }
        return Promise.resolve(null);
    }

    /* =======================================================================
     * 四、极简 HTML 解析器（只服务 dsMarkdown / AI 产出的结构化片段）
     * ===================================================================== */
    var VOID_TAGS = {
        area: 1, base: 1, br: 1, col: 1, embed: 1, hr: 1, img: 1, input: 1,
        link: 1, meta: 1, param: 1, source: 1, track: 1, wbr: 1
    };
    var RAW_TAGS = { script: 1, style: 1, title: 1 };

    function parseAttrs(s) {
        var out = {}, re = /([\w:.-]+)(?:\s*=\s*("[^"]*"|'[^']*'|[^\s"'>]+))?/g, m;
        while ((m = re.exec(s))) {
            var v = m[2] == null ? '' : m[2];
            if (v && (v.charAt(0) === '"' || v.charAt(0) === "'")) v = v.slice(1, -1);
            out[m[1].toLowerCase()] = decodeEntities(v);
        }
        return out;
    }

    function parseHtml(html) {
        var root = { tag: '#root', attrs: {}, children: [] };
        var stack = [root];
        var src = String(html == null ? '' : html);
        var re = /<!--[\s\S]*?-->|<!\[CDATA\[([\s\S]*?)\]\]>|<!DOCTYPE[^>]*>|<\/([a-zA-Z][\w:.-]*)\s*>|<([a-zA-Z][\w:.-]*)((?:"[^"]*"|'[^']*'|[^>"'])*)>/g;
        var last = 0, m;

        function pushText(t) {
            if (!t) return;
            stack[stack.length - 1].children.push({ text: decodeEntities(t) });
        }

        while ((m = re.exec(src))) {
            if (m.index > last) pushText(src.slice(last, m.index));
            last = re.lastIndex;

            if (m[2] !== undefined) {                       // 闭合标签
                var name = m[2].toLowerCase();
                for (var i = stack.length - 1; i > 0; i--) {
                    if (stack[i].tag === name) { stack.length = i; break; }
                }
                continue;
            }
            if (m[3] !== undefined) {                       // 开始标签
                var tag = m[3].toLowerCase();
                var rawAttrs = m[4] || '';
                var selfClose = /\/\s*$/.test(rawAttrs);
                var node = { tag: tag, attrs: parseAttrs(rawAttrs.replace(/\/\s*$/, '')), children: [] };
                stack[stack.length - 1].children.push(node);
                if (VOID_TAGS[tag] || selfClose) continue;
                if (RAW_TAGS[tag]) {                        // script/style 内容整段丢弃
                    var endRe = new RegExp('</' + tag + '\\s*>', 'i');
                    var em = endRe.exec(src.slice(re.lastIndex));
                    if (em) re.lastIndex = re.lastIndex + em.index + em[0].length;
                    continue;
                }
                stack.push(node);
            }
            // 注释 / DOCTYPE：忽略
        }
        if (last < src.length) pushText(src.slice(last));
        return root;
    }

    /* =======================================================================
     * 五、HTML → blocks（扁平块模型，便于 Node 侧单测）
     * ===================================================================== */
    var BLOCK_TAGS = {
        p: 1, div: 1, section: 1, article: 1, main: 1, header: 1, footer: 1, aside: 1,
        h1: 1, h2: 1, h3: 1, h4: 1, h5: 1, h6: 1, ul: 1, ol: 1, li: 1, dl: 1, dt: 1, dd: 1,
        table: 1, thead: 1, tbody: 1, tfoot: 1, tr: 1, blockquote: 1, pre: 1,
        figure: 1, figcaption: 1, hr: 1, form: 1, fieldset: 1
    };

    function inlineRuns(node, style, out, imgs) {
        var st = style || {};
        var kids = node.children || [];
        for (var i = 0; i < kids.length; i++) {
            var c = kids[i];
            if (c.text !== undefined) {
                if (!c.text) continue;
                var r = { text: c.text };
                if (st.bold) r.bold = true;
                if (st.italic) r.italic = true;
                if (st.underline) r.underline = true;
                if (st.strike) r.strike = true;
                if (st.mono) r.mono = true;
                out.push(r);
                continue;
            }
            var t = c.tag;
            if (t === 'br') { out.push({ br: true }); continue; }
            if (t === 'img' || t === 'video' || t === 'audio' || t === 'iframe' || t === 'source' || t === 'embed') {
                if (imgs) imgs.push({ src: c.attrs.src || '', alt: c.attrs.alt || c.attrs.title || '', kind: t });
                continue;
            }
            if (BLOCK_TAGS[t] && out.length) out.push({ br: true });     // 单元格内嵌段落 → 断行
            inlineRuns(c, {
                bold: st.bold || t === 'strong' || t === 'b',
                italic: st.italic || t === 'em' || t === 'i',
                underline: st.underline || t === 'u' || t === 'ins',
                strike: st.strike || t === 'del' || t === 's' || t === 'strike',
                mono: st.mono || t === 'code' || t === 'kbd' || t === 'samp' || t === 'tt'
            }, out, imgs);
        }
        return out;
    }

    function inlineOf(el) { return inlineRuns(el, {}, [], []); }

    function runsText(runs) {
        var s = '';
        for (var i = 0; i < (runs || []).length; i++) {
            if (runs[i].br) { s += '\n'; continue; }
            s += runs[i].text || '';
        }
        return s;
    }

    /** 去掉首尾空白 run（避免 Word 里出现「空行 + 缩进」） */
    function trimRuns(runs) {
        var arr = (runs || []).filter(function (r) { return r.br || (r.text && r.text !== ''); });
        if (!arr.length) return [];
        if (arr[0].text !== undefined) arr[0] = Object.assign({}, arr[0], { text: arr[0].text.replace(/^[\s\u00a0]+/, '') });
        var lastIdx = arr.length - 1;
        if (arr[lastIdx].text !== undefined) arr[lastIdx] = Object.assign({}, arr[lastIdx], { text: arr[lastIdx].text.replace(/[\s\u00a0]+$/, '') });
        return arr.filter(function (r) { return r.br || (r.text && r.text !== ''); });
    }

    function textOfDeep(el) {
        var s = '';
        (el.children || []).forEach(function (c) {
            if (c.text !== undefined) s += c.text;
            else if (c.tag === 'br') s += '\n';
            else s += textOfDeep(c);
        });
        return s;
    }

    function tableBlockOf(el) {
        var head = null, rows = [];
        function collect(container, inHead) {
            (container.children || []).forEach(function (ch) {
                if (ch.tag === 'tr') {
                    var cells = [];
                    (ch.children || []).forEach(function (td) {
                        if (td.tag !== 'td' && td.tag !== 'th') return;
                        cells.push({ runs: trimRuns(inlineOf(td)), head: td.tag === 'th' || !!inHead });
                    });
                    if (!cells.length) return;
                    if (inHead) head = cells; else rows.push(cells);
                } else if (ch.tag === 'thead' || ch.tag === 'tbody' || ch.tag === 'tfoot') {
                    collect(ch, inHead || ch.tag === 'thead');
                }
            });
        }
        collect(el, false);
        if (!head && rows.length && rows[0].every(function (c) { return c.head; })) head = rows.shift();
        var cols = 0;
        if (head) cols = Math.max(cols, head.length);
        rows.forEach(function (r) { cols = Math.max(cols, r.length); });
        return { t: 'table', head: head, rows: rows, cols: cols || 1 };
    }

    function kindNote(kind) {
        if (kind === 'iframe') return '网页';
        if (kind === 'video') return '视频';
        if (kind === 'audio') return '音频';
        return '媒体';
    }

    /** 判断元素是否含「块级」子元素（含则需下钻遍历，而非当作纯行内段落） */
    var CONTENT_BLOCK_TAGS = {
        figure: 1, table: 1, ul: 1, ol: 1, div: 1, blockquote: 1, pre: 1,
        h1: 1, h2: 1, h3: 1, h4: 1, h5: 1, h6: 1, hr: 1, section: 1, article: 1
    };
    function hasBlockChild(el) {
        var kids = el.children || [];
        for (var i = 0; i < kids.length; i++) {
            if (kids[i].tag && CONTENT_BLOCK_TAGS[kids[i].tag]) return true;
        }
        return false;
    }

    function walkBlocks(container, blocks) {
        var buf = [], bufImgs = [];

        function flush() {
            var txt = runsText(buf).trim();
            if (txt) blocks.push({ t: 'p', runs: trimRuns(buf) });
            for (var k = 0; k < bufImgs.length; k++) {
                var im = bufImgs[k];
                if (im.kind === 'img') blocks.push({ t: 'img', src: im.src, alt: im.alt });
                else blocks.push({ t: 'p', runs: [{ text: '［' + kindNote(im.kind) + '］' + (im.alt ? im.alt + ' ' : '') + (im.src || '') }] });
            }
            buf = []; bufImgs = [];
        }

        (container.children || []).forEach(function (el) {
            var t = el.tag;
            // 裸文本（如 <blockquote>纯文字</blockquote>、<div>前后文字</div>）计入待冲刷段落
            if (t === undefined) {
                if (el.text) buf.push({ text: el.text });
                return;
            }

            // —— 标题
            if (/^h[1-6]$/.test(t)) {
                flush();
                var hr = trimRuns(inlineOf(el));
                if (runsText(hr).trim()) blocks.push({ t: 'h', tagLevel: parseInt(t.charAt(1), 10), runs: hr });
                return;
            }
            // —— 段落（内含 figure/div 等块级子元素时下钻，保证图注与图片的先后顺序）
            if (t === 'p' || t === 'dd' || t === 'dt' || t === 'caption') {
                if (hasBlockChild(el)) { flush(); walkBlocks(el, blocks); return; }
                flush();
                var runs = [], imgs = [];
                inlineRuns(el, {}, runs, imgs);
                runs = trimRuns(runs);
                if (runsText(runs).trim()) blocks.push({ t: 'p', runs: runs });
                for (var k = 0; k < imgs.length; k++) {
                    var im = imgs[k];
                    if (im.kind === 'img') blocks.push({ t: 'img', src: im.src, alt: im.alt });
                    else blocks.push({ t: 'p', runs: [{ text: '［' + kindNote(im.kind) + '］' + (im.alt ? im.alt + ' ' : '') + (im.src || '') }] });
                }
                return;
            }
            // —— 列表
            if (t === 'ul' || t === 'ol') {
                flush();
                var items = [];
                (el.children || []).forEach(function (li) {
                    if (li.tag !== 'li') return;
                    var ir = [], ii = [];
                    inlineRuns(li, {}, ir, ii);
                    ir = trimRuns(ir);
                    if (runsText(ir).trim()) items.push({ runs: ir });
                    ii.forEach(function (x) {
                        if (x.kind === 'img') blocks.push({ t: 'img', src: x.src, alt: x.alt });
                    });
                });
                if (items.length) blocks.push({ t: 'list', ordered: t === 'ol', items: items });
                return;
            }
            // —— 表格
            if (t === 'table') { flush(); blocks.push(tableBlockOf(el)); return; }
            // —— 代码块
            if (t === 'pre') { flush(); blocks.push({ t: 'code', text: textOfDeep(el).replace(/\u00a0/g, ' ') }); return; }
            // —— 引用
            if (t === 'blockquote') {
                flush();
                var sub = [];
                walkBlocks(el, sub);
                sub.forEach(function (b) { b.quote = true; });
                blocks.push.apply(blocks, sub);
                return;
            }
            // —— 图片 / 图注
            if (t === 'figure') {
                flush();
                var caps = [];
                (el.children || []).forEach(function (ch) {
                    if (ch.tag === 'img') blocks.push({ t: 'img', src: ch.attrs.src || '', alt: ch.attrs.alt || '' });
                    else if (ch.tag === 'video' || ch.tag === 'iframe' || ch.tag === 'audio') {
                        blocks.push({ t: 'p', runs: [{ text: '［' + kindNote(ch.tag) + '］' + (ch.attrs.src || '') }] });
                    } else if (ch.tag === 'figcaption') caps.push(runsText(inlineOf(ch)).trim());
                    else if (ch.tag === 'p' || ch.tag === 'div') {
                        blocks.push({ t: 'caption', runs: trimRuns(inlineOf(ch)) });
                    }
                });
                caps.forEach(function (c) { if (c) blocks.push({ t: 'caption', runs: [{ text: c }] }); });
                return;
            }
            if (t === 'img') { bufImgs.push({ src: el.attrs.src || '', alt: el.attrs.alt || '', kind: 'img' }); return; }
            if (t === 'video' || t === 'audio' || t === 'iframe' || t === 'embed') {
                bufImgs.push({ src: el.attrs.src || '', alt: el.attrs.alt || el.attrs.title || '', kind: t });
                return;
            }
            if (t === 'hr') {
                flush();
                blocks.push({ t: 'hr' });
                return;
            }
            // —— 容器：递归
            if (t === 'div' || t === 'section' || t === 'article' || t === 'main' || t === 'header' ||
                t === 'footer' || t === 'aside' || t === 'li' || t === 'dl' || t === 'form' || t === 'fieldset' ||
                t === 'thead' || t === 'tbody' || t === 'tr') {
                flush();
                walkBlocks(el, blocks);
                return;
            }
            // —— 行内元素：并入缓冲
            inlineRuns(el, {}, buf, bufImgs);
        });

        flush();
    }

    /** HTML 字符串 → blocks 数组 */
    function htmlToBlocks(html) {
        var blocks = [];
        walkBlocks(parseHtml(html), blocks);
        return blocks;
    }

    /* =======================================================================
     * 六、层次判定（公文「一、/（一）/1.」）
     * ===================================================================== */
    var RE_L1A = /^[一二三四五六七八九十百]+[、．.](?!\d)/;
    var RE_L1B = /^第[一二三四五六七八九十百]+[章部分篇]/;
    var RE_L2 = /^[（(][一二三四五六七八九十百]+[）)]/;
    var RE_L3 = /^\d{1,2}\s*[、．.]/;

    function classifyText(txt) {
        if (!txt) return 0;
        if (RE_L1A.test(txt) || RE_L1B.test(txt)) return 1;
        if (RE_L2.test(txt)) return 2;
        if (RE_L3.test(txt)) return 3;
        return 0;
    }

    /** 段落「晋升」为标题的条件：短、无句末标点 */
    function classifyParagraph(txt) {
        if (!txt || txt.length > 40) return 0;
        if (/[。；！？]$/.test(txt)) return 0;
        return classifyText(txt);
    }

    function classifyHeadingLevel(runs, tagLevel) {
        var t = runsText(runs).replace(/\s+/g, ' ').trim();
        var byText = classifyText(t);
        if (byText) return byText;
        var lv = tagLevel || 1;
        if (lv <= 2) return 1;
        if (lv === 3) return 2;
        return 3;
    }

    function blockText(b) {
        if (!b || !b.runs) return '';
        return runsText(b.runs).replace(/\s+/g, ' ').trim();
    }

    /** 归一化：抽标题、统一层次、段落晋升 */
    function normalizeBlocks(blocks, opts) {
        opts = opts || {};
        var titleText = '', consumed = -1;
        // 只有「真·一级标题 <h1>」才可能被抽为公文标题：
        // ① 独立生成时需要标题；② 模板填充时（takeFirstHeadingAsTitle:false）一律不抽，
        //    否则内容首个小标题（如「一、检查基本情况」）会被当成标题吞掉 —— 模板自带标题区。
        if (opts.takeFirstHeadingAsTitle !== false) {
            var limit = Math.min(blocks.length, 2);
            for (var i = 0; i < limit; i++) {
                var b = blocks[i];
                if (b.t !== 'h') continue;
                var txt = blockText(b);
                if (!txt) continue;
                if ((b.tagLevel || 1) === 1) { titleText = txt; consumed = i; }
                break;
            }
        }
        if (!titleText) titleText = String(opts.title || '').trim();

        var out = [];
        for (var j = 0; j < blocks.length; j++) {
            if (j === consumed) continue;
            var blk = blocks[j];
            if (blk.t === 'h') {
                out.push({ t: 'h', level: classifyHeadingLevel(blk.runs, blk.tagLevel), runs: blk.runs, quote: blk.quote });
                continue;
            }
            if (blk.t === 'p' && !blk.quote) {
                var lv = classifyParagraph(blockText(blk));
                if (lv) {
                    out.push({ t: 'h', level: lv, runs: trimRuns(blk.runs), promoted: true });
                    continue;
                }
            }
            out.push(blk);
        }
        return { titleText: titleText, blocks: out };
    }

    /* =======================================================================
     * 七、OOXML 片段生成
     * ===================================================================== */
    function rprXml(c) {
        c = c || {};
        var latin = c.latin || 'Times New Roman';
        var s = '<w:rPr>';
        s += '<w:rFonts w:ascii="' + escAttr(latin) + '" w:hAnsi="' + escAttr(latin) +
            '" w:eastAsia="' + escAttr(c.font || '宋体') + '" w:cs="' + escAttr(latin) + '" w:hint="eastAsia"/>';
        if (c.bold) s += '<w:b/><w:bCs/>';
        if (c.italic) s += '<w:i/><w:iCs/>';
        if (c.strike) s += '<w:strike/>';
        if (c.color) s += '<w:color w:val="' + escAttr(c.color) + '"/>';
        if (c.size) s += '<w:sz w:val="' + c.size + '"/><w:szCs w:val="' + c.size + '"/>';
        // ⚠️ CT_RPr 的元素顺序被 Word 严格校验：w:u 必须排在 sz/szCs 之后
        if (c.underline) s += '<w:u w:val="single"/>';
        s += '</w:rPr>';
        return s;
    }

    function runsXml(runs, st) {
        st = st || {};
        var out = '';
        for (var i = 0; i < (runs || []).length; i++) {
            var r = runs[i];
            var rc = {
                font: st.font, latin: st.latin, size: st.size,
                bold: !!(r.bold || st.bold),
                italic: !!r.italic, underline: !!r.underline, strike: !!r.strike
            };
            if (r.br) { out += '<w:r>' + rprXml(rc) + '<w:br/></w:r>'; continue; }
            if (r.text == null || r.text === '') continue;
            if (r.mono) { rc.font = 'Consolas'; rc.latin = 'Consolas'; }
            var parts = String(r.text).split('\n');
            out += '<w:r>' + rprXml(rc);
            for (var j = 0; j < parts.length; j++) {
                if (j) out += '<w:br/>';
                if (parts[j]) out += '<w:t xml:space="preserve">' + escText(parts[j]) + '</w:t>';
            }
            out += '</w:r>';
        }
        return out;
    }

    /**
     * 生成一个段落。
     * @param {Array}  runs  行内 run 数组
     * @param {Object} st    样式（font/size/line/lineRule/indent/align/bold/before/after/keepNext）
     * @param {Object} extra {pStyle, pageBreakBefore, inheritPPr, inheritRPr, noIndent}
     */
    function paraXml(runs, st, extra) {
        st = st || {}; extra = extra || {};
        var sizeHalfPt = st.size || 24;
        var p = '<w:p><w:pPr>';

        if (extra.inheritPPr) {
            // 模板填充：直接沿用模板段落属性，只按需剥掉首行缩进、追加段前段后
            var ppr = extra.inheritPPr;
            if (extra.noIndent) ppr = stripIndent(ppr);
            p += ppr;
        } else {
            // ⚠️ CT_PPr 元素顺序被 Word 严格校验：
            // pStyle → keepNext/keepLines → pageBreakBefore → spacing → ind → jc → rPr
            if (extra.pStyle) p += '<w:pStyle w:val="' + escAttr(extra.pStyle) + '"/>';
            if (st.keepNext) p += '<w:keepNext/><w:keepLines/>';
            if (extra.pageBreakBefore) p += '<w:pageBreakBefore/>';
            var sp = '<w:spacing w:line="' + (st.line || 240) + '" w:lineRule="' + (st.lineRule || 'auto') + '"';
            if (st.before) sp += ' w:before="' + st.before + '"';
            if (st.after) sp += ' w:after="' + st.after + '"';
            sp += '/>';
            p += sp;
            var ind = '';
            var indCh = st.indent == null ? 0 : st.indent;
            if (indCh > 0) {
                ind += ' w:firstLineChars="' + (indCh * 100) + '" w:firstLine="' + (indCh * sizeHalfPt * 10) + '"';
            }
            if (st.indLeftChars > 0) {
                ind += ' w:leftChars="' + (st.indLeftChars * 100) + '" w:left="' + (st.indLeftChars * sizeHalfPt * 10) + '"';
            }
            if (ind) p += '<w:ind' + ind + '/>';
            if (st.align) p += '<w:jc w:val="' + st.align + '"/>';
            p += rprXml(st);
        }
        p += '</w:pPr>';

        if (extra.inheritRPr) {
            p += runsXmlWithBase(runs, extra.inheritRPr, st);
        } else {
            p += runsXml(runs || [], st);
        }
        p += '</w:p>';
        return p;
    }

    /** 模板填充专用：以模板的 rPr 为底，套用行内加粗/斜体 */
    function runsXmlWithBase(runs, baseRPr, st) {
        var out = '';
        for (var i = 0; i < (runs || []).length; i++) {
            var r = runs[i];
            if (r.br) { out += '<w:r>' + baseRPr + '<w:br/></w:r>'; continue; }
            if (r.text == null || r.text === '') continue;
            var rpr = baseRPr;
            if (r.bold) rpr = addBoldToRPr(rpr);
            if (r.italic) rpr = addTagToRPr(rpr, '<w:i/><w:iCs/>');
            var parts = String(r.text).split('\n');
            out += '<w:r>' + rpr;
            for (var j = 0; j < parts.length; j++) {
                if (j) out += '<w:br/>';
                if (parts[j]) out += '<w:t xml:space="preserve">' + escText(parts[j]) + '</w:t>';
            }
            out += '</w:r>';
        }
        return out;
    }

    function addTagToRPr(rpr, tag) {
        if (!rpr || rpr.indexOf('<w:rPr>') === -1) return '<w:rPr>' + tag + '</w:rPr>';
        // ⚠️ CT_RPr 子序：rFonts 必须最前，新标签要插在 rFonts（或 rStyle）之后
        var m = /<w:rFonts\b[^>]*\/>/.exec(rpr) || /<w:rStyle\b[^>]*\/>/.exec(rpr);
        if (m) {
            var at = m.index + m[0].length;
            return rpr.slice(0, at) + tag + rpr.slice(at);
        }
        return rpr.replace('<w:rPr>', '<w:rPr>' + tag);
    }
    function addBoldToRPr(rpr) {
        if (!rpr) return '<w:rPr><w:b/><w:bCs/></w:rPr>';
        if (/<w:b\b/.test(rpr)) return rpr;
        return addTagToRPr(rpr, '<w:b/><w:bCs/>');
    }
    function stripIndent(ppr) {
        if (!ppr) return ppr;
        return ppr.replace(/<w:ind\b[^>]*\/>/g, function (tag) {
            var kept = tag.replace(/\sw:firstLineChars="[^"]*"/g, '').replace(/\sw:firstLine="[^"]*"/g, '');
            return /w:(left|right|start|end|hanging)/.test(kept) ? kept : '';
        });
    }

    function hrXml() {
        return '<w:p><w:pPr><w:pBdr><w:bottom w:val="single" w:sz="6" w:space="1" w:color="808080"/></w:pBdr>' +
            '<w:spacing w:before="80" w:after="80" w:line="240" w:lineRule="auto"/>' +
            '<w:ind w:firstLineChars="0" w:firstLine="0"/></w:pPr></w:p>';
    }

    function codeXml(b, S) {
        var st = S.code || S.body;
        var lines = String(b.text || '').replace(/\r\n?/g, '\n').split('\n');
        var out = '';
        for (var i = 0; i < lines.length; i++) {
            out += paraXml([{ text: lines[i], mono: true }], st, {});
        }
        return out || paraXml([], st, {});
    }

    function tableXml(b, S, ctx, inherit) {
        inherit = inherit || null;
        var cols = Math.max(1, b.cols || 1);
        var total = ctx.contentWidth;
        var base = Math.floor(total / cols);
        var grid = '';
        for (var i = 0; i < cols; i++) {
            var w = (i === cols - 1) ? (total - base * (cols - 1)) : base;
            grid += '<w:gridCol w:w="' + w + '"/>';
        }
        var borderKeys = ['top', 'left', 'bottom', 'right', 'insideH', 'insideV'];
        var borders = '<w:tblBorders>' + borderKeys.map(function (k) {
            return '<w:' + k + ' w:val="single" w:sz="4" w:space="0" w:color="000000"/>';
        }).join('') + '</w:tblBorders>';

        var x = '<w:tbl><w:tblPr><w:tblW w:w="' + total + '" w:type="dxa"/><w:jc w:val="center"/>' + borders +
            '<w:tblLayout w:type="fixed"/><w:tblCellMar>' +
            '<w:top w:w="28" w:type="dxa"/><w:left w:w="57" w:type="dxa"/>' +
            '<w:bottom w:w="28" w:type="dxa"/><w:right w:w="57" w:type="dxa"/>' +
            '</w:tblCellMar></w:tblPr><w:tblGrid>' + grid + '</w:tblGrid>';

        function rowXml(cells, isHead) {
            var r = '<w:tr>';
            if (isHead) r += '<w:trPr><w:cantSplit/><w:tblHeader/></w:trPr>';
            for (var c = 0; c < cols; c++) {
                var cell = cells[c] || { runs: [] };
                var cw = (c === cols - 1) ? (total - base * (cols - 1)) : base;
                r += '<w:tc><w:tcPr><w:tcW w:w="' + cw + '" w:type="dxa"/><w:vAlign w:val="center"/></w:tcPr>' +
                    paraXml(cell.runs || [], isHead ? (S.cellHead || S.cell) : S.cell,
                        inherit ? { inheritPPr: inherit.pPr, inheritRPr: inherit.rPr, noIndent: true } : {}) + '</w:tc>';
            }
            return r + '</w:tr>';
        }

        if (b.head) x += rowXml(b.head, true);
        (b.rows || []).forEach(function (r) { x += rowXml(r, false); });
        x += '</w:tbl>';
        // Word 建议表格后跟一个空段，避免表格贴到节末
        x += '<w:p><w:pPr><w:spacing w:line="240" w:lineRule="auto"/></w:pPr></w:p>';
        return x;
    }

    function imageXml(b, ctx) {
        var img = b._img;
        var cx = Math.round(img.w * EMU_PER_PX), cy = Math.round(img.h * EMU_PER_PX);
        var s = Math.min(1, ctx.contentWidthEmu / cx, ctx.contentHeightEmu / cy);
        cx = Math.max(1, Math.round(cx * s)); cy = Math.max(1, Math.round(cy * s));
        var id = ctx.docPrId++;
        return '<w:p><w:pPr>' +
            '<w:spacing w:before="120" w:after="120" w:line="240" w:lineRule="auto"/>' +
            '<w:ind w:firstLineChars="0" w:firstLine="0"/><w:jc w:val="center"/></w:pPr>' +
            '<w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0">' +
            '<wp:extent cx="' + cx + '" cy="' + cy + '"/><wp:effectExtent l="0" t="0" r="0" b="0"/>' +
            '<wp:docPr id="' + id + '" name="图片' + id + '" descr="' + escAttr(b.alt || '') + '"/>' +
            '<wp:cNvGraphicFramePr><a:graphicFrameLocks xmlns:a="' + NS_A + '" noChangeAspect="1"/></wp:cNvGraphicFramePr>' +
            '<a:graphic xmlns:a="' + NS_A + '"><a:graphicData uri="' + NS_PIC + '">' +
            '<pic:pic xmlns:pic="' + NS_PIC + '"><pic:nvPicPr><pic:cNvPr id="' + id + '" name="image' + id + '"/>' +
            '<pic:cNvPicPr/></pic:nvPicPr>' +
            '<pic:blipFill><a:blip r:embed="' + b._rid + '"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>' +
            '<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="' + cx + '" cy="' + cy + '"/></a:xfrm>' +
            '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr>' +
            '</pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>';
    }

    function styleFor(S, b) {
        switch (b.t) {
            case 'title': return S.title;
            case 'caption': return S.caption || S.body;
            case 'h':
                return b.level === 1 ? S.h1 : (b.level === 2 ? S.h2 : S.h3);
            case 'code': return S.code || S.body;
            case 'date': return S.date;
            default: return b.quote ? S.quote : S.body;
        }
    }

    function pStyleFor(b) {
        if (b.t !== 'h') return '';
        return b.level === 1 ? '1' : (b.level === 2 ? '2' : '3');
    }

    function blocksToXml(blocks, S, ctx, titleText) {
        var out = [];
        if (titleText) out.push(paraXml([{ text: titleText }], S.title, { pStyle: 'Title' }));
        var prevWasTable = false;
        for (var i = 0; i < blocks.length; i++) {
            var b = blocks[i];
            if (b.t === 'h') {
                out.push(paraXml(b.runs, styleFor(S, b), { pStyle: pStyleFor(b) }));
            } else if (b.t === 'table') {
                out.push(tableXml(b, S, ctx));
                prevWasTable = true;
                continue;
            } else if (b.t === 'img') {
                if (b._img && b._rid) out.push(imageXml(b, ctx));
                else out.push(paraXml([{ text: '［图片' + (b.alt ? '：' + b.alt : '') + (b._imgFail ? '（原图无法获取，可能受跨域限制）' : '') + '］' }], S.caption || S.body, {}));
            } else if (b.t === 'hr') {
                out.push(hrXml());
            } else if (b.t === 'code') {
                out.push(codeXml(b, S));
            } else if (b.t === 'list') {
                for (var li = 0; li < b.items.length; li++) {
                    var item = b.items[li];
                    var runs = item.runs;
                    if (b.ordered) {
                        var t0 = runsText(runs).trim();
                        if (!/^\d{1,3}\s*[、．.]/.test(t0)) {
                            runs = [{ text: (li + 1) + '. ' }].concat(runs);
                        }
                    }
                    out.push(paraXml(runs, styleFor(S, b), {}));
                }
            } else {
                out.push(paraXml(b.runs, styleFor(S, b), {}));
            }
            prevWasTable = false;
        }
        if (!out.length) out.push(paraXml([{ text: '（无内容）' }], S.body, {}));
        return out.join('');
    }

    /* =======================================================================
     * 八、部件 XML（ContentTypes / rels / styles / settings / 页脚 …）
     * ===================================================================== */
    function contentTypesXml(imageExts) {
        var defs = [
            ['rels', 'application/vnd.openxmlformats-package.relationships+xml'],
            ['xml', 'application/xml']
        ];
        var extMap = { png: 'image/png', jpeg: 'image/jpeg', jpg: 'image/jpeg', gif: 'image/gif', bmp: 'image/bmp', webp: 'image/webp' };
        (imageExts || []).forEach(function (e) {
            var mime = extMap[e];
            if (mime) defs.push([e, mime]);
        });
        var overrides = [
            ['/word/document.xml', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml'],
            ['/word/styles.xml', 'application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml'],
            ['/word/settings.xml', 'application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml'],
            ['/word/fontTable.xml', 'application/vnd.openxmlformats-officedocument.wordprocessingml.fontTable+xml'],
            ['/word/footer1.xml', 'application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml'],
            ['/word/footer2.xml', 'application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml'],
            ['/docProps/core.xml', 'application/vnd.openxmlformats-package.core-properties+xml'],
            ['/docProps/app.xml', 'application/vnd.openxmlformats-officedocument.extended-properties+xml']
        ];
        var x = XML_HEAD + '<Types xmlns="' + NS_CT + '">';
        var seen = {};
        defs.forEach(function (d) {
            if (seen['d:' + d[0]]) return;
            seen['d:' + d[0]] = 1;
            x += '<Default Extension="' + escAttr(d[0]) + '" ContentType="' + escAttr(d[1]) + '"/>';
        });
        overrides.forEach(function (o) {
            x += '<Override PartName="' + escAttr(o[0]) + '" ContentType="' + escAttr(o[1]) + '"/>';
        });
        return x + '</Types>';
    }

    function relsXml(items) {
        var x = XML_HEAD + '<Relationships xmlns="' + NS_REL + '">';
        items.forEach(function (it) {
            x += '<Relationship Id="' + escAttr(it.id) + '" Type="' + escAttr(it.type) + '" Target="' + escAttr(it.target) + '"' +
                (it.mode ? ' TargetMode="' + escAttr(it.mode) + '"' : '') + '/>';
        });
        return x + '</Relationships>';
    }

    function rootRelsXml() {
        return relsXml([
            { id: 'rId1', type: REL_OFFICE_DOC, target: 'word/document.xml' },
            { id: 'rId2', type: REL_CORE, target: 'docProps/core.xml' },
            { id: 'rId3', type: REL_APP, target: 'docProps/app.xml' }
        ]);
    }

    function docRelsXml(ctx, S) {
        var items = [
            { id: 'rIdStyles', type: REL_STYLES, target: 'styles.xml' },
            { id: 'rIdSettings', type: REL_SETTINGS, target: 'settings.xml' },
            { id: 'rIdFontTable', type: REL_FONT_TABLE, target: 'fontTable.xml' }
        ];
        if (S.pageNum) {
            items.push({ id: 'rIdFooterOdd', type: REL_FOOTER, target: 'footer1.xml' });
            items.push({ id: 'rIdFooterEven', type: REL_FOOTER, target: 'footer2.xml' });
        }
        (ctx.images || []).forEach(function (img, i) {
            items.push({ id: 'rIdImg' + (i + 1), type: REL_IMAGE, target: 'media/image' + (i + 1) + '.' + img.ext });
        });
        return relsXml(items);
    }

    function docDefaultsXml(S) {
        return '<w:docDefaults><w:rPrDefault>' + rprXml({ font: S.body.font, latin: S.latin, size: S.body.size }) +
            '</w:rPrDefault><w:pPrDefault><w:pPr>' +
            '<w:spacing w:line="' + S.body.line + '" w:lineRule="' + S.body.lineRule + '"/>' +
            '</w:pPr></w:pPrDefault></w:docDefaults>';
    }

    function headingStyleXml(id, name, outline, st, S) {
        return '<w:style w:type="paragraph" w:styleId="' + id + '">' +
            '<w:name w:val="' + escAttr(name) + '"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/>' +
            '<w:qFormat/><w:pPr>' +
            '<w:spacing w:line="' + st.line + '" w:lineRule="' + st.lineRule + '"/>' +
            (st.indent ? '<w:ind w:firstLineChars="' + st.indent * 100 + '" w:firstLine="' + st.indent * st.size * 10 + '"/>' : '') +
            '<w:outlineLvl w:val="' + outline + '"/>' +
            '</w:pPr>' + rprXml(st) + '</w:style>';
    }

    function stylesXml(S) {
        var x = XML_HEAD + '<w:styles xmlns:w="' + NS_W + '">';
        x += docDefaultsXml(S);
        x += '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/>' +
            '<w:pPr><w:spacing w:line="' + S.body.line + '" w:lineRule="' + S.body.lineRule + '"/>' +
            '<w:ind w:firstLineChars="' + (S.body.indent * 100) + '" w:firstLine="' + (S.body.indent * S.body.size * 10) + '"/>' +
            '</w:pPr>' + rprXml(S.body) + '</w:style>';
        x += '<w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/>' +
            '<w:pPr><w:spacing w:before="240" w:after="240" w:line="' + S.title.line + '" w:lineRule="' + S.title.lineRule + '"/>' +
            '<w:ind w:firstLineChars="0" w:firstLine="0"/><w:jc w:val="center"/></w:pPr>' + rprXml(S.title) + '</w:style>';
        x += headingStyleXml('1', 'heading 1', 0, S.h1, S);
        x += headingStyleXml('2', 'heading 2', 1, S.h2, S);
        x += headingStyleXml('3', 'heading 3', 2, S.h3, S);
        x += '<w:style w:type="table" w:default="1" w:styleId="TableNormal"><w:name w:val="Normal Table"/>' +
            '<w:tblPr><w:tblCellMar><w:top w:w="28" w:type="dxa"/><w:left w:w="57" w:type="dxa"/>' +
            '<w:bottom w:w="28" w:type="dxa"/><w:right w:w="57" w:type="dxa"/></w:tblCellMar></w:tblPr></w:style>';
        return x + '</w:styles>';
    }

    function settingsXml() {
        return XML_HEAD + '<w:settings xmlns:w="' + NS_W + '">' +
            '<w:zoom w:percent="100"/>' +
            '<w:defaultTabStop w:val="420"/>' +
            '<w:evenAndOddHeaders/>' +
            '<w:characterSpacingControl w:val="compressPunctuation"/>' +
            '<w:compat><w:compatSetting w:name="compatibilityMode" w:uri="http://schemas.microsoft.com/office/word" w:val="15"/></w:compat>' +
            '</w:settings>';
    }

    function fontTableXml() {
        function f(name, alt, charset, family, pitch) {
            return '<w:font w:name="' + escAttr(name) + '">' +
                (alt ? '<w:altName w:val="' + escAttr(alt) + '"/>' : '') +
                '<w:charset w:val="' + (charset || '86') + '"/>' +
                '<w:family w:val="' + (family || 'modern') + '"/>' +
                '<w:pitch w:val="' + (pitch || 'fixed') + '"/>' +
                '</w:font>';
        }
        return XML_HEAD + '<w:fonts xmlns:w="' + NS_W + '">' +
            f('仿宋_GB2312', '仿宋', '86', 'modern', 'fixed') +
            f('楷体_GB2312', '楷体', '86', 'modern', 'fixed') +
            f('方正小标宋简体', '宋体', '86', 'modern', 'variable') +
            f('黑体', '', '86', 'modern', 'fixed') +
            f('宋体', '', '86', 'roman', 'fixed') +
            f('Consolas', 'Courier New', '00', 'modern', 'fixed') +
            '<w:font w:name="Times New Roman"><w:charset w:val="00"/><w:family w:val="roman"/><w:pitch w:val="variable"/></w:font>' +
            '</w:fonts>';
    }

    /** 页码：宋体四号，「— N —」；奇数页右、偶数页左 */
    function footerXml(S, align) {
        var st = S.pageNum || { font: '宋体', size: 28 };
        var rpr = rprXml({ font: st.font, latin: 'Times New Roman', size: st.size });
        return XML_HEAD + '<w:ftr xmlns:w="' + NS_W + '" xmlns:r="' + NS_R + '">' +
            '<w:p><w:pPr>' +
            '<w:spacing w:before="0" w:after="0" w:line="240" w:lineRule="auto"/>' +
            '<w:ind w:firstLineChars="0" w:firstLine="0"/>' +
            '<w:jc w:val="' + align + '"/></w:pPr>' +
            '<w:r>' + rpr + '<w:t xml:space="preserve">— </w:t></w:r>' +
            '<w:fldSimple w:instr=" PAGE "><w:r>' + rpr + '<w:t>1</w:t></w:r></w:fldSimple>' +
            '<w:r>' + rpr + '<w:t xml:space="preserve"> —</w:t></w:r>' +
            '</w:p></w:ftr>';
    }

    function coreXml(title) {
        var now = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
        return XML_HEAD + '<cp:coreProperties xmlns:cp="' + NS_CP + '" xmlns:dc="' + NS_DC +
            '" xmlns:dcterms="' + NS_DCTERMS + '" xmlns:xsi="' + NS_XSI + '">' +
            '<dc:title>' + escText(title || '报告') + '</dc:title>' +
            '<dc:creator>铁路安监智能辅助系统</dc:creator>' +
            '<cp:lastModifiedBy>铁路安监智能辅助系统</cp:lastModifiedBy>' +
            '<dcterms:created xsi:type="dcterms:W3CDTF">' + now + '</dcterms:created>' +
            '<dcterms:modified xsi:type="dcterms:W3CDTF">' + now + '</dcterms:modified>' +
            '</cp:coreProperties>';
    }

    function appXml() {
        return XML_HEAD + '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" ' +
            'xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">' +
            '<Application>铁路安监智能辅助系统</Application>' +
            '<AppVersion>16.0000</AppVersion>' +
            '<DocSecurity>0</DocSecurity><ScaleCrop>false</ScaleCrop>' +
            '<Company></Company><LinksUpToDate>false</LinksUpToDate>' +
            '</Properties>';
    }

    function sectPrXml(S, ctx) {
        var m = S.margin;
        var x = '<w:sectPr>';
        if (S.pageNum) {
            x += '<w:footerReference w:type="default" r:id="rIdFooterOdd"/>';
            x += '<w:footerReference w:type="even" r:id="rIdFooterEven"/>';
        }
        x += '<w:pgSz w:w="' + S.page.w + '" w:h="' + S.page.h + '"/>';
        x += '<w:pgMar w:top="' + mm2twip(m.top) + '" w:right="' + mm2twip(m.right) +
            '" w:bottom="' + mm2twip(m.bottom) + '" w:left="' + mm2twip(m.left) +
            '" w:header="' + S.header + '" w:footer="' + S.footer + '" w:gutter="0"/>';
        x += '<w:cols w:space="425"/>';
        x += '<w:docGrid w:type="default" w:linePitch="312"/>';
        x += '</w:sectPr>';
        return x;
    }

    function documentXml(S, bodyXml, ctx) {
        return XML_HEAD + '<w:document xmlns:w="' + NS_W + '" xmlns:r="' + NS_R +
            '" xmlns:wp="' + NS_WP + '" xmlns:a="' + NS_A + '" xmlns:pic="' + NS_PIC + '">' +
            '<w:body>' + bodyXml + sectPrXml(S, ctx) + '</w:body></w:document>';
    }

    /* =======================================================================
     * 九、图片抓取（data:URL 直读 / http(s) 走 fetch，失败优雅降级为文字占位）
     * ===================================================================== */
    function be32(b, o) { return ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0; }

    function pngSize(b) {
        if (b.length < 24) return null;
        if (b[0] !== 0x89 || b[1] !== 0x50 || b[2] !== 0x4E || b[3] !== 0x47) return null;
        return { w: be32(b, 16), h: be32(b, 20) };
    }
    function gifSize(b) {
        if (b.length < 10) return null;
        if (b[0] !== 0x47 || b[1] !== 0x49 || b[2] !== 0x46) return null;
        return { w: b[6] | (b[7] << 8), h: b[8] | (b[9] << 8) };
    }
    function jpegSize(b) {
        if (b.length < 4 || b[0] !== 0xFF || b[1] !== 0xD8) return null;
        var i = 2;
        while (i < b.length - 9) {
            if (b[i] !== 0xFF) { i++; continue; }
            var mk = b[i + 1];
            if (mk === 0xFF || mk === 0x00) { i++; continue; }
            if (mk >= 0xD0 && mk <= 0xD9) { i += 2; continue; }
            var len = (b[i + 2] << 8) | b[i + 3];
            if (len < 2) return null;
            if (mk >= 0xC0 && mk <= 0xCF && mk !== 0xC4 && mk !== 0xC8 && mk !== 0xCC) {
                return { h: (b[i + 5] << 8) | b[i + 6], w: (b[i + 7] << 8) | b[i + 8] };
            }
            i += 2 + len;
        }
        return null;
    }
    function bmpSize(b) {
        if (b.length < 26 || b[0] !== 0x42 || b[1] !== 0x4D) return null;
        var w = b[18] | (b[19] << 8) | (b[20] << 16) | (b[21] << 24);
        var h = b[22] | (b[23] << 8) | (b[24] << 16) | (b[25] << 24);
        return { w: w, h: Math.abs(h) };
    }

    function detectImage(b) {
        var s = pngSize(b); if (s) return { ext: 'png', w: s.w, h: s.h };
        s = jpegSize(b); if (s) return { ext: 'jpeg', w: s.w, h: s.h };
        s = gifSize(b); if (s) return { ext: 'gif', w: s.w, h: s.h };
        s = bmpSize(b); if (s) return { ext: 'bmp', w: s.w, h: s.h };
        return null;
    }

    function extFromMime(mime) {
        mime = String(mime || '').toLowerCase();
        if (mime.indexOf('png') >= 0) return 'png';
        if (mime.indexOf('jpeg') >= 0 || mime.indexOf('jpg') >= 0) return 'jpeg';
        if (mime.indexOf('gif') >= 0) return 'gif';
        if (mime.indexOf('bmp') >= 0) return 'bmp';
        return '';
    }

    function loadImageInfo(src) {
        src = String(src || '').trim();
        if (!src) return Promise.resolve(null);

        if (/^data:/i.test(src)) {
            var mm = src.match(/^data:(image\/[a-z0-9.+-]+);base64,([\s\S]*)$/i);
            if (!mm) return Promise.resolve(null);
            var bin = b64ToU8(mm[2]);
            var det = detectImage(bin) || { ext: extFromMime(mm[1]), w: 0, h: 0 };
            if (!det.ext || !det.w || !det.h) return Promise.resolve(null);
            return Promise.resolve({ data: bin, ext: det.ext, w: det.w, h: det.h });
        }
        if (!/^https?:/i.test(src)) return Promise.resolve(null);
        if (typeof global.fetch !== 'function') return Promise.resolve(null);

        return global.fetch(src, { mode: 'cors', credentials: 'omit' })
            .then(function (res) {
                if (!res || !res.ok) return null;
                return res.arrayBuffer().then(function (ab) {
                    var u8 = new Uint8Array(ab);
                    if (u8.length > 8 * 1024 * 1024) return null;
                    var det = detectImage(u8);
                    if (!det) return null;
                    return { data: u8, ext: det.ext, w: det.w, h: det.h };
                });
            })
            .catch(function () { return null; });
    }

    /**
     * 按文档顺序为图片分配 rId 与关系目标。
     * 单次最多嵌入 20 张（防止报告里几十张图把 docx 撑爆）；
     * 取不到的图不静默丢弃，由 blocksToXml 落成文字占位。
     */
    function assignImages(blocks, ctx) {
        var MAX_IMAGES = 20;
        var seen = 0;
        blocks.forEach(function (b) {
            if (b.t !== 'img') return;
            if (!b._info) { b._imgFail = true; return; }
            if (seen >= MAX_IMAGES) { b._imgFail = true; return; }
            seen++;
            ctx.images.push(b._info);
            b._img = b._info;
            b._rid = 'rIdImg' + ctx.images.length;
            delete b._info;
        });
    }

    /* =======================================================================
     * 十、打包
     * ===================================================================== */
    function assembleZip(JSZipLib, S, bodyXml, ctx, opts) {
        var files = [];
        var imageExts = [];
        ctx.images.forEach(function (im) { if (imageExts.indexOf(im.ext) === -1) imageExts.push(im.ext); });

        files.push(['[Content_Types].xml', contentTypesXml(imageExts)]);
        files.push(['_rels/.rels', rootRelsXml()]);
        files.push(['word/document.xml', documentXml(S, bodyXml, ctx)]);
        files.push(['word/_rels/document.xml.rels', docRelsXml(ctx, S)]);
        files.push(['word/styles.xml', stylesXml(S)]);
        files.push(['word/settings.xml', settingsXml()]);
        files.push(['word/fontTable.xml', fontTableXml()]);
        if (S.pageNum) {
            files.push(['word/footer1.xml', footerXml(S, 'right')]);   // 奇数页居右
            files.push(['word/footer2.xml', footerXml(S, 'left')]);    // 偶数页居左
        }
        ctx.images.forEach(function (im, i) {
            files.push(['word/media/image' + (i + 1) + '.' + im.ext, im.data]);
        });
        files.push(['docProps/core.xml', coreXml(opts && opts.title)]);
        files.push(['docProps/app.xml', appXml()]);

        var zip = new JSZipLib();
        files.forEach(function (f) { zip.file(f[0], f[1]); });
        return zip.generateAsync({
            type: 'uint8array',
            compression: 'DEFLATE',
            compressionOptions: { level: 6 },
            mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
        });
    }

    function styleTableOf(opts) {
        var key = (opts && opts.style) || getStyle();
        return STYLES[key] || STYLES.gongwen;
    }

    /* =======================================================================
     * 十一、对外：blocks / HTML → docx
     * ===================================================================== */
    function buildFromBlocks(blocks, opts) {
        opts = opts || {};
        return getZipLib().then(function (JSZipLib) {
            if (!JSZipLib) throw new Error('JSZip 未加载，无法生成 DOCX');
            var S = styleTableOf(opts);
            var norm = normalizeBlocks(blocks || [], opts);
            var ctx = {
                contentWidth: S.page.w - mm2twip(S.margin.left) - mm2twip(S.margin.right),
                contentHeight: S.page.h - mm2twip(S.margin.top) - mm2twip(S.margin.bottom),
                images: [],
                docPrId: 1
            };
            ctx.contentWidthEmu = Math.round(ctx.contentWidth / 20 * 12700);
            ctx.contentHeightEmu = Math.round(ctx.contentHeight / 20 * 12700);

            var jobs = [];
            if (opts.images !== false) {
                (norm.blocks || []).filter(function (b) { return b.t === 'img'; }).forEach(function (b) {
                    jobs.push(loadImageInfo(b.src).then(function (info) { b._info = info; }));
                });
            }
            return Promise.all(jobs).then(function () {
                assignImages(norm.blocks || [], ctx);
                var bodyXml = blocksToXml(norm.blocks, S, ctx, norm.titleText);
                return assembleZip(JSZipLib, S, bodyXml, ctx, { title: norm.titleText });
            });
        });
    }

    function buildFromHtml(html, opts) {
        return buildFromBlocks(htmlToBlocks(html), opts);
    }

    /* =======================================================================
     * 十二、模板填充（保住上传 docx 的原版式）
     * ===================================================================== */

    /** 从段落 XML 里抽出全部 <w:t> 文本并按序拼接 */
    function paraText(pXml) {
        var re = /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g, m, s = '';
        while ((m = re.exec(pXml))) s += decodeEntities(m[1]);
        return s;
    }

    /** 提取段落里首个 run 的 rPr（模板字体/字号来源） */
    function firstRunRPr(pXml) {
        var m = /<w:rPr>[\s\S]*?<\/w:rPr>/.exec(pXml);
        return m ? m[0] : '';
    }

    /** 提取段落的 pPr（不含 rPr，段落级属性） */
    /** 提取段落的 pPr 正文（剥掉 rPr：字符属性改由模板 run 级 rPr 提供，避免重复声明） */
    function paraPPr(pXml) {
        var m = /<w:pPr>([\s\S]*?)<\/w:pPr>/.exec(pXml);
        if (!m) return '';
        return m[1].replace(/<w:rPr>[\s\S]*?<\/w:rPr>/, '');
    }

    /** 段落内行内占位符替换：合并该段全部 <w:t> 后统一回填到首个 run */
    function replaceInlinePlaceholders(pXml, map, stat) {
        var re = /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g;
        var hits = [], m;
        while ((m = re.exec(pXml))) hits.push({ text: decodeEntities(m[1]), index: m.index, len: m[0].length });
        if (!hits.length) return pXml;

        var joined = hits.map(function (h) { return h.text; }).join('');
        if (joined.indexOf('{{') === -1) return pXml;

        var filled = 0;
        var replaced = joined.replace(/\{\{\s*([^{}]{1,40}?)\s*\}\}/g, function (all, key) {
            var k = String(key).trim();
            if (Object.prototype.hasOwnProperty.call(map, k) && map[k] != null) {
                filled++;
                return String(map[k]);
            }
            if (stat) stat.missing.push(k);
            return '';
        });
        if (!filled) return pXml;
        if (stat) stat.filled += filled;

        var out = pXml;
        for (var i = hits.length - 1; i >= 0; i--) {
            var h = hits[i];
            var next = (i === 0) ? '<w:t xml:space="preserve">' + escText(replaced) + '</w:t>' : '';
            out = out.slice(0, h.index) + next + out.slice(h.index + h.len);
        }
        return out;
    }

    var BODY_KEYS = ['正文', '报告正文', '正文内容', '内容', 'content', 'Content', 'CONTENT', 'body', 'Body', 'BODY'];

    /** 读模板自身的页面设置，让注入内容的行宽与模板一致（而非套用我们的默认版心） */
    function templateContentWidth(xml, S) {
        var szTag = /<w:pgSz\b[^>]*>/.exec(xml);
        var marTag = /<w:pgMar\b[^>]*>/.exec(xml);
        function attr(tag, name) {
            if (!tag) return null;
            var m = new RegExp('w:' + name + '="(-?\\d+)"').exec(tag[0]);
            return m ? parseInt(m[1], 10) : null;
        }
        var pageW = attr(szTag, 'w') || S.page.w;
        var left = attr(marTag, 'left'); if (left == null) left = mm2twip(S.margin.left);
        var right = attr(marTag, 'right'); if (right == null) right = mm2twip(S.margin.right);
        return Math.max(1200, pageW - left - right);
    }

    function blockToPlainText(b) {
        if (b.t === 'img') return '［图片' + (b.alt ? '：' + b.alt : '') + '］';
        if (b.t === 'code') return String(b.text || '');
        if (b.t === 'hr') return '';
        if (b.t === 'caption') return runsText(b.runs || []);
        if (b.t === 'table') {
            var lines = [];
            if (b.head) lines.push(b.head.map(function (c) { return runsText(c.runs).trim(); }).join('｜'));
            (b.rows || []).forEach(function (r) { lines.push(r.map(function (c) { return runsText(c.runs).trim(); }).join('｜')); });
            return lines.filter(Boolean).join('\n');
        }
        return runsText(b.runs || []);
    }

    /**
     * 模板模式渲染：段落属性（字体/字号/行距/缩进）全部沿用模板占位段落，
     * 标题只剥掉首行缩进并补粗体；表格用同一套属性渲染成真表格。
     */
    function blocksToXmlTemplate(blocks, S, basePPr, baseRPr, ctx) {
        var boldRPr = addBoldToRPr(baseRPr);
        var out = [];
        for (var i = 0; i < blocks.length; i++) {
            var b = blocks[i];
            if (b.t === 'h') {
                out.push(paraXml(b.runs, S.body, { inheritPPr: basePPr, inheritRPr: boldRPr, noIndent: true }));
            } else if (b.t === 'list') {
                for (var li = 0; li < b.items.length; li++) {
                    var runs = b.items[li].runs;
                    if (b.ordered) {
                        var t0 = runsText(runs).trim();
                        if (!/^\d{1,3}\s*[、．.]/.test(t0)) runs = [{ text: (li + 1) + '. ' }].concat(runs);
                    }
                    out.push(paraXml(runs, S.body, { inheritPPr: basePPr, inheritRPr: baseRPr }));
                }
            } else if (b.t === 'table') {
                out.push(tableXml(b, S, ctx, { pPr: basePPr, rPr: baseRPr }));
            } else if (b.t === 'img' || b.t === 'code' || b.t === 'hr') {
                var txt = blockToPlainText(b);
                if (txt) {
                    String(txt).split('\n').forEach(function (line) {
                        out.push(paraXml([{ text: line }], S.body, { inheritPPr: basePPr, inheritRPr: baseRPr }));
                    });
                }
            } else {
                out.push(paraXml(b.runs, S.body, { inheritPPr: basePPr, inheritRPr: baseRPr }));
            }
        }
        return out.join('');
    }

    /**
     * 用上传的 .docx 模板填充内容 —— 模板原版式（styles/页眉页脚/页面设置）全部保留。
     * 占位符约定：
     *   {{正文}} / {{content}} / {{body}}   → 整段替换为生成正文（含标题层级、表格）
     *   {{标题}} {{日期}} {{单位}} 及任意自定义 key → 行内文本替换
     * 模板内找不到任何可用占位符时返回 null，由调用方回退到「公文格式」独立生成。
     * @returns {Promise<{bytes:Uint8Array, stat:Object}|null>}
     */
    function fillTemplate(templateBytes, data, opts) {
        data = data || {}; opts = opts || {};
        return getZipLib().then(function (JSZipLib) {
            if (!JSZipLib) return null;
            return JSZipLib.loadAsync(templateBytes).then(function (zip) {
                var entry = zip.file('word/document.xml');
                if (!entry) return null;
                return entry.async('string').then(function (xml) {
                    var S = styleTableOf(opts);
                    var blocks = data.blocks || (data.html != null ? htmlToBlocks(data.html) : []);
                    var norm = normalizeBlocks(blocks, {
                        title: data.title || opts.title || '',
                        takeFirstHeadingAsTitle: false      // 模板自带标题区，不吞内容首个小标题
                    });
                    var stat = { filled: 0, missing: [], bodyInjected: 0 };

                    var map = {};
                    Object.keys(data.fields || {}).forEach(function (k) { map[k] = data.fields[k]; });
                    if (data.title != null) {
                        ['标题', 'title', 'Title', 'TITLE', '报告标题'].forEach(function (k) { map[k] = data.title; });
                    }
                    if (data.dateText) { map['日期'] = data.dateText; map['date'] = data.dateText; map['成文日期'] = data.dateText; }
                    if (data.unit) { map['单位'] = data.unit; map['unit'] = data.unit; }

                    var ctx = {
                        contentWidth: templateContentWidth(xml, S),
                        contentHeight: S.page.h - mm2twip(S.margin.top) - mm2twip(S.margin.bottom),
                        images: [],
                        docPrId: 1
                    };
                    ctx.contentWidthEmu = Math.round(ctx.contentWidth / 20 * 12700);
                    ctx.contentHeightEmu = Math.round(ctx.contentHeight / 20 * 12700);

                    var pRe = /<w:p\b[^>]*\/>|<w:p\b[^>]*>[\s\S]*?<\/w:p>/g;
                    var edits = [], m;
                    while ((m = pRe.exec(xml))) {
                        var pXml = m[0];
                        var text = paraText(pXml);
                        if (!text || text.indexOf('{{') === -1) continue;

                        var isBody = false;
                        for (var k = 0; k < BODY_KEYS.length; k++) {
                            if (text.indexOf('{{' + BODY_KEYS[k] + '}}') !== -1) { isBody = true; break; }
                        }
                        if (isBody && norm.blocks.length) {
                            var basePPr = paraPPr(pXml);
                            var baseRPr = firstRunRPr(pXml) || rprXml({ font: S.body.font, latin: S.latin, size: S.body.size });
                            edits.push([m.index, m.index + pXml.length, blocksToXmlTemplate(norm.blocks, S, basePPr, baseRPr, ctx)]);
                            stat.bodyInjected++;
                            continue;
                        }
                        var np = replaceInlinePlaceholders(pXml, map, stat);
                        if (np !== pXml) edits.push([m.index, m.index + pXml.length, np]);
                    }

                    if (!stat.bodyInjected && !stat.filled) return null;   // 该模板里没有可用占位符

                    var out = xml;
                    for (var i = edits.length - 1; i >= 0; i--) {
                        out = out.slice(0, edits[i][0]) + edits[i][2] + out.slice(edits[i][1]);
                    }
                    zip.file('word/document.xml', out);
                    return zip.generateAsync({
                        type: 'uint8array',
                        compression: 'DEFLATE',
                        compressionOptions: { level: 6 },
                        mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
                    }).then(function (bytes) { return { bytes: bytes, stat: stat }; });
                });
            }).catch(function (e) {
                console.warn('[RGDocx] 模板填充失败：', e && e.message ? e.message : e);
                return null;
            });
        });
    }

    /* =======================================================================
     * 十三、排版偏好 & 对外 API
     * ===================================================================== */
    function getStyle() {
        try {
            var v = global.localStorage && global.localStorage.getItem(STYLE_KEY);
            if (v && STYLES[v]) return v;
        } catch (e) { /* 隐私模式等 */ }
        return 'gongwen';
    }
    function setStyle(v) {
        if (!STYLES[v]) v = 'gongwen';
        try { global.localStorage && global.localStorage.setItem(STYLE_KEY, v); } catch (e) {}
        return v;
    }

    var API = {
        version: '1.0.0',
        GONGWEN: GONGWEN,
        PLAIN: PLAIN,
        parseHtml: parseHtml,
        htmlToBlocks: htmlToBlocks,
        normalizeBlocks: normalizeBlocks,
        fromBlocks: buildFromBlocks,
        fromHtml: buildFromHtml,
        fillTemplate: fillTemplate,
        loadLib: getZipLib,
        getStyle: getStyle,
        setStyle: setStyle,
        /** 调试用：把 blocks 结构打成人可读文本 */
        describe: function (blocks) {
            return (blocks || []).map(function (b) {
                if (b.t === 'h') return '  H' + (b.level == null ? b.tagLevel : b.level) + '  ' + blockText(b);
                if (b.t === 'p') return (b.quote ? '  >   ' : '  P   ') + blockText(b);
                if (b.t === 'table') return '  TBL ' + ((b.rows || []).length + (b.head ? 1 : 0)) + '行 × ' + (b.cols || 0) + '列';
                if (b.t === 'img') return '  IMG ' + String(b.src || '').slice(0, 60);
                if (b.t === 'code') return '  CODE ' + String(b.text || '').slice(0, 40);
                if (b.t === 'list') return '  LIST ' + (b.items || []).length + '项' + (b.ordered ? '(有序)' : '');
                if (b.t === 'caption') return '  CAP  ' + blockText(b);
                if (b.t === 'hr') return '  HR';
                return '  ?    ' + b.t;
            }).join('\n');
        }
    };

    if (typeof module !== 'undefined' && module.exports) module.exports = API;
    global.RGDocx = API;
})(typeof window !== 'undefined' ? window : globalThis);