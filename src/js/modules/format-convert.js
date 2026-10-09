/**
 * 格式转换共用件（2026-10-07）
 * =====================================================
 * 用户口径："转化的文件主要 PDF、OFD、TXT，一般都是转换成 DOCX/Excel"，
 *   并要求"能在智能对话中调用"。
 *
 * 设计原则：**只做编排，不重写解析** —— 每一环都复用项目既有能力：
 *   PDF  → pdfjsLib 取文字层 → ImportLayout.buildDocument（版式还原 + 跨页去页眉页脚 + 表格识别）
 *   OFD  → OFDImport.extract（已产出 blocks）
 *   TXT/MD → dsReadTextFileAutoEnc（自动择码，兼容 GBK）+ detectLevelByPattern（章/节/条/款分级）
 *   统一 → ImportLayout.stripWatermarkBlocks（与水印清洗同一把尺子）
 *        → ImportLayout.blocksToHtml（imp-* 公文体例，界面样式与 DOCX 导出都已识别）
 *        → RGDocx.fromHtml → Uint8Array（**直接拿字节，不触发下载** —— 这样调用方可以自己决定：
 *           下载 / 交给智能体 / 作为附件 / 后续再转 Excel）
 *
 * 为什么不用 `wrExportHtmlToDocx`：它会**自己弹 alert 并强制下载**，调用方拿不到文件，
 *   不适合做"转换"这种要先拿到结果再决定去向的场景。
 *
 * 支持的源：pdf / ofd / txt / md(markdown)（DOCX 源在后续步骤接入）
 * 支持的目标：docx（本步）；Excel 出口在下一步（仅表格类文档适用）
 *
 * 诊断：`__fmtConv('文件对象')` 或 `FmtConv.toDocx(file)` 后看 note
 */
(function () {
  'use strict';

  var DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  var XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  var PDF_LIB = 'src/js/vendor/pdf.min.js';
  var PDF_WORKER = 'src/js/vendor/pdf.worker.min.js';
  var SUPPORTED_EXT = ['pdf', 'ofd', 'txt', 'md', 'markdown'];

  function extOf(name) { return String(name || '').toLowerCase().replace(/^.*\./, ''); }
  function isSupported(name) { return SUPPORTED_EXT.indexOf(extOf(name)) !== -1; }

  function _ensureLayout() {
    if (window.ImportLayout && typeof window.ImportLayout.blocksToHtml === 'function') return Promise.resolve(true);
    return new Promise(function (res) {
      try {
        if (typeof window.loadScript === 'function') { window.loadScript('src/js/modules/import-layout.js').then(function () { res(!!window.ImportLayout); }).catch(function () { res(false); }); }
        else res(!!window.ImportLayout);
      } catch (e) { res(false); }
    });
  }

  /** ① PDF → blocks（编排抄自 rule.js 的 PDF 分支：那段在模块闭包里，无法直接复用，故在此重写约 30 行） */
  async function pdfToBlocks(file) {
    if (typeof window.requireLib === 'function') {
      await window.requireLib(PDF_LIB, { silent: true, feature: '格式转换' });
    }
    if (typeof pdfjsLib === 'undefined') return { ok: false, note: 'PDF 解析库未就绪（离线首次需联网拉取）' };
    try { if (pdfjsLib.GlobalWorkerOptions) pdfjsLib.GlobalWorkerOptions.workerSrc = PDF_WORKER; } catch (e) {}
    var pages = [], numPages = 0;
    try {
      var buf = await file.arrayBuffer();
      var doc = await pdfjsLib.getDocument({ data: buf }).promise;
      numPages = doc.numPages || 0;
      for (var p = 1; p <= numPages; p++) {
        var pg = await doc.getPage(p);
        var tc = await pg.getTextContent();
        pages.push((tc && tc.items) || []);
      }
    } catch (e) {
      return { ok: false, note: 'PDF 读取失败：' + ((e && e.message) || e) };
    }
    var okL = await _ensureLayout();
    var L = window.ImportLayout;
    if (!okL || !L || typeof L.buildDocument !== 'function') return { ok: false, note: '版式还原组件未就绪' };
    var r = null;
    // 【2026-10-09 正解落地】与 rule.js 同口径：**单页且能取到矢量表格线 ⇒ 按网格确定性还原**；
    //   多页或取不到线段（扫描件）⇒ 保持"跳过表格、只导文字"兜底，绝不静默丢内容。
    try {
      window.__pdfSkipTables = true;
      window.__pdfGridSegments = null;
      if (doc && doc.numPages === 1 && L.segmentsFromOperatorList) {
        try {
          var _pg1 = await doc.getPage(1);
          var _ol1 = await _pg1.getOperatorList();
          var _sgs = L.segmentsFromOperatorList(_ol1, (typeof window !== 'undefined' && window.pdfjsLib && window.pdfjsLib.OPS) || {});
          if (_sgs && _sgs.length) { window.__pdfGridSegments = _sgs; window.__pdfSkipTables = false; }
        } catch (eG) {}
      }
    } catch (eS) {}
    try {
      r = L.buildDocument(pages);
    } catch (e) {
      return { ok: false, note: '版式还原失败：' + ((e && e.message) || e) };
    } finally {
      try { window.__pdfSkipTables = false; window.__pdfGridSegments = null; } catch (e) {}
    }
    var blocks = (r && r.blocks) || [], removed = 0;
    try {
      if (typeof L.stripWatermarkBlocks === 'function') {
        var wb = L.stripWatermarkBlocks(blocks);
        blocks = (wb && wb.blocks) || blocks;
        removed = ((wb && wb.removed) || []).length;
      }
    } catch (e) {}
    return {
      ok: true, blocks: blocks, text: (r && r.text) || '', source: 'pdf',
      note: 'PDF ' + numPages + ' 页，识别 ' + blocks.length + ' 个块' + (removed ? '，清除水印/页眉页脚类 ' + removed + ' 处' : '')
    };
  }

  /** ② OFD → blocks（复用现有 OFD 解析，返回的就是 blocks） */
  async function ofdToBlocks(file) {
    if (!window.OFDImport || typeof window.OFDImport.extract !== 'function') {
      try { if (typeof window.loadScript === 'function') await window.loadScript('src/js/modules/ofd-import.js'); } catch (e) {}
    }
    if (!window.OFDImport || typeof window.OFDImport.extract !== 'function') return { ok: false, note: 'OFD 解析组件未就绪' };
    var r = null;
    try { r = await window.OFDImport.extract(file); } catch (e) { return { ok: false, note: 'OFD 解析失败：' + ((e && e.message) || e) }; }
    var blocks = (r && r.blocks) || [];
    // 与规章导入同口径：解析期已删一批，这里再过一次共用清洗（二次保险，失败不影响主流程）
    try {
      var L = window.ImportLayout;
      if (L && typeof L.stripWatermarkBlocks === 'function') { var wb = L.stripWatermarkBlocks(blocks); blocks = (wb && wb.blocks) || blocks; }
    } catch (e) {}
    return {
      ok: blocks.length > 0, blocks: blocks, text: (r && r.text) || '', source: 'ofd',
      note: 'OFD ' + ((r && r.pageCount) || 0) + ' 页，识别 ' + blocks.length + ' 个块' + ((r && r.note) ? '，' + r.note : '')
    };
  }

  /** ③ TXT / Markdown → blocks（编码走公共择码；分级复用手册那套 LEVEL_PATTERNS，避免第二套规则） */
  async function textToBlocks(file) {
    var raw = '';
    try {
      raw = (typeof window.dsReadTextFileAutoEnc === 'function')
        ? await window.dsReadTextFileAutoEnc(file)
        : await file.text();
    } catch (e) {
      try { raw = await file.text(); } catch (e2) { return { ok: false, note: '文件读取失败' }; }
    }
    var isMd = /^(md|markdown)$/.test(extOf(file.name));
    var detect = window.hbDetectLevel;   // handbook.js 导出的分级函数（返回 1~4，0=正文）
    var blocks = [];
    String(raw || '').split(/\r?\n/).forEach(function (line) {
      var t = String(line || '').replace(/\s+$/, '');
      if (!t.trim()) return;
      var kind = 'body';
      if (isMd) {
        var m = t.match(/^\s*(#{1,6})\s+(.*)$/);
        if (m) {
          var lv = m[1].length;
          kind = lv === 1 ? 'chapter' : (lv === 2 ? 'section' : (lv === 3 ? 'clause' : 'item'));
          t = m[2];
        }
      } else {
        var lv2 = (typeof detect === 'function') ? detect(t.trim()) : 0;
        if (lv2 === 1) kind = 'chapter';
        else if (lv2 === 2) kind = 'section';
        else if (lv2 === 3 || lv2 === 4) kind = 'clause';
      }
      blocks.push({ type: 'para', text: t.trim(), kind: kind });
    });
    return {
      ok: blocks.length > 0, blocks: blocks, text: String(raw || ''), source: isMd ? 'md' : 'txt',
      note: (isMd ? 'Markdown' : '纯文本') + ' ' + blocks.length + ' 段' + (blocks.length ? '' : '（未读到内容，文件可能为空）')
    };
  }

  async function toBlocks(file) {
    if (!file || typeof file !== 'object') return { ok: false, note: '未提供文件' };
    var e = extOf(file.name);
    if (e === 'pdf') return pdfToBlocks(file);
    if (e === 'ofd') return ofdToBlocks(file);
    if (e === 'txt' || e === 'md' || e === 'markdown') return textToBlocks(file);
    return { ok: false, note: '暂不支持该格式：.' + e + '（本步支持 PDF / OFD / TXT / Markdown）' };
  }

  async function toHtml(file) {
    var r = await toBlocks(file);
    if (!r.ok) return r;
    var okL = await _ensureLayout();
    var L = window.ImportLayout;
    if (!okL || !L || typeof L.blocksToHtml !== 'function') return { ok: false, note: '版式还原组件未就绪' };
    var html = '';
    try { html = L.blocksToHtml(r.blocks) || ''; } catch (e) { return { ok: false, note: 'HTML 生成失败：' + ((e && e.message) || e) }; }
    return { ok: !!html, html: html, text: r.text, source: r.source, note: r.note, blocks: r.blocks };
  }

  /**
   * 转成 DOCX 字节（**不下载**，交给调用方决定去向）
   * @returns { ok, bytes(Uint8Array), name, source, note, htmlLen, textLen } 或 { ok:false, note }
   */
  async function toDocx(file, opts) {
    opts = opts || {};
    if (typeof window.RGDocx === 'undefined' || typeof window.RGDocx.fromHtml !== 'function') {
      return { ok: false, note: 'DOCX 导出组件未就绪（docx-export.js 未加载）' };
    }
    var h = await toHtml(file);
    if (!h.ok) return h;
    var title = opts.title || String(file.name || '转换结果').replace(/\.[^/.]+$/, '');
    var bytes = null;
    try {
      // style 默认用项目统一的公文格式（'gongwen'）；显式传 style 可覆盖
      bytes = await window.RGDocx.fromHtml(h.html, {
        title: title,
        style: opts.style || 'gongwen',
        images: true
      });
    } catch (e) {
      return { ok: false, note: 'DOCX 生成失败：' + ((e && e.message) || e) };
    }
    if (!bytes || !bytes.length) return { ok: false, note: 'DOCX 生成失败（返回内容为空）' };
    return {
      ok: true, bytes: bytes, name: String(title).replace(/[\\/:*?"<>|]/g, '_') + '.docx',
      source: h.source, note: h.note, htmlLen: (h.html || '').length, textLen: String(h.text || '').length
    };
  }

  /* ==================== Excel 出口（2026-10-07 第 2 步）====================
   * 用户口径："一般都是转换成 DOCX/Excel"。
   * ⚠️ 边界（如实）：**只有"表格类文档"才适合转 Excel** —— 正文段落不是表格结构，
   *   硬转只能做逐行平铺（那是数据抽取，不是格式转换）。所以这里的口径是：
   *   **识别到表格才导出；没有表格就明确说明原因**，绝不产出一个没有意义的表。
   * 数据来源：ImportLayout 的 blocks 里 `{ type:'table', rows:[[单元格文本...]], cols }`。
   * ===================================================================== */
  function tableBlocksOf(blocks) {
    return (blocks || []).filter(function (b) { return b && b.type === 'table' && b.rows && b.rows.length; });
  }

  /** 由 blocks 直接导 Excel（导出给套件与内部复用；附件入口走 toExcel） */
  async function toExcelFromBlocks(blocks, title) {
    var tables = tableBlocksOf(blocks);
    if (!tables.length) {
      return { ok: false, noTable: true, note: '该文档未识别到表格结构，无法导出 Excel（正文段落不是表格；如确有表格请确认原文件是表格排版）' };
    }
    if (typeof window.requireLib === 'function') {
      await window.requireLib('src/js/vendor/xlsx.full.min.js', { silent: true, feature: '格式转换' });
    }
    if (typeof XLSX === 'undefined') return { ok: false, note: 'Excel 组件未就绪（离线首次需联网拉取）' };
    var wb = null;
    try {
      wb = XLSX.utils.book_new();
      tables.forEach(function (t, i) {
        var aoa = (t.rows || []).map(function (row) {
          return (row || []).map(function (c) { return c == null ? '' : String(c); });
        });
        if (!aoa.length) return;
        var ws = XLSX.utils.aoa_to_sheet(aoa);
        // 多表时用「表格N」分 sheet；单表也用同名，保证表头行一致好认
        XLSX.utils.book_append_sheet(wb, ws, ('表格' + (i + 1)).slice(0, 31));
      });
      if (!wb.SheetNames || !wb.SheetNames.length) return { ok: false, note: '表格内容为空，未生成任何 sheet' };
      var out = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
      if (!out) return { ok: false, note: 'Excel 生成失败（返回内容为空）' };
      return {
        ok: true, bytes: new Uint8Array(out),
        name: String(title || '转换结果').replace(/[\\/:*?"<>|]/g, '_') + '.xlsx',
        note: '识别到 ' + tables.length + ' 个表格 → ' + wb.SheetNames.length + ' 个 sheet',
        tables: tables.length
      };
    } catch (e) {
      return { ok: false, note: 'Excel 生成失败：' + ((e && e.message) || e) };
    }
  }

  /** 文件 → Excel（PDF/OFD/TXT-MD 均可；无表格时如实返回 noTable） */
  async function toExcel(file, opts) {
    opts = opts || {};
    var r = await toBlocks(file);
    if (!r.ok) return r;
    var title = opts.title || String(file.name || '转换结果').replace(/\.[^/.]+$/, '');
    var x = await toExcelFromBlocks(r.blocks, title);
    x.source = r.source;
    if (x.ok && r.note) x.note = r.note + '；' + x.note;
    return x;
  }

  /** 保存到本地（唯一会触发下载的出口，由调用方显式调用） */
  function save(bytes, name, mime) {
    try {
      var blob = new Blob([bytes], { type: mime || DOCX_MIME });
      if (typeof window.downloadBlob === 'function') { window.downloadBlob(blob, name); return true; }
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url; a.download = name;
      document.body.appendChild(a); a.click();
      setTimeout(function () { try { URL.revokeObjectURL(url); a.remove(); } catch (e) {} }, 1000);
      return true;
    } catch (e) { return false; }
  }

  /**
   * 一步到位：转换并下载（给按钮用）
   * @param opts.target 'docx'（默认）| 'xlsx'
   */
  async function convertAndSave(file, opts) {
    opts = opts || {};
    var t = String(opts.target || 'docx').toLowerCase();
    var isX = (t === 'xlsx' || t === 'excel');
    var r = isX ? await toExcel(file, opts) : await toDocx(file, opts);
    if (r.ok) save(r.bytes, r.name, isX ? XLSX_MIME : DOCX_MIME);
    return r;
  }

  window.FmtConv = {
    version: '1.1',
    DOCX_MIME: DOCX_MIME,
    XLSX_MIME: XLSX_MIME,
    SUPPORTED_EXT: SUPPORTED_EXT.slice(),
    isSupported: isSupported,
    toBlocks: toBlocks,
    toHtml: toHtml,
    toDocx: toDocx,
    toExcel: toExcel,
    toExcelFromBlocks: toExcelFromBlocks,
    save: save,
    convertAndSave: convertAndSave
  };
  try { window.__fmtConv = window.FmtConv; } catch (e) {}
})();
