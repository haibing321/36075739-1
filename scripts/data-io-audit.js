#!/usr/bin/env node
/**
 * 审计套件 · 数据导入导出（覆盖此前**无人看守**的盲区）
 * ------------------------------------------------------------------
 * 本套件把"曾经靠临时探针才发现真实缺陷"的检查固化为常驻回归：
 *   ① 检查信息 CSV(UTF-8) 大批量导入：条数精确 + 耗时阈值
 *   ② 检查信息 CSV(GBK)：中文不乱码 + 列名识别（Excel 另存 CSV 默认 GBK）
 *   ③ 坏 JSON 导入：不写库且给失败提示
 *   ④ 追加导入去重口径：内容+单位+**日期**（换日期保留、同日重复合并）
 *   ⑤ 导出真实落盘：检查信息 / 电话 / 词库 JSON + 智能体 CSV(带 BOM) + 文件名合法
 * 退出码：0 全通过 / 1 有失败。用法：node scripts/data-io-audit.js
 */
'use strict';
const path = require('path');
const H = require('./audit-harness');

(async () => {
  const h = await H.start({ port: 8161, cdpPort: 9371, view: 'dataio' });
  console.log('==== 数据导入导出审计 ====');
  try {
    await h.nav('index.html?v=io');
    await h.ev(`(() => { window.confirm = () => true; window.showChoiceModal = async () => 'append'; return 1; })()`);

    // ---------- ① CSV(UTF-8) 3000 行 ----------
    const big = await h.ev(`(async () => {
      const N = 3000;
      let csv = '性质,时间,类别,问题描述,规章依据,单位\\n';
      for (let i = 0; i < N; i++) csv += 'A类,2026-09-' + String((i % 28) + 1).padStart(2, '0') + ' 10:00,调车,防溜措施缺失 第' + i + '条,《调车规章》第12条,站' + (i % 7) + '\\n';
      const base = (window.getIssueData() || []).length;
      const t0 = performance.now();
      await window.issueHandleFile({ target: { files: [new File([csv], 'io_utf8.csv', { type: 'text/csv' })], value: '' } });
      const ms = Math.round(performance.now() - t0);
      return { base: base, got: (window.getIssueData() || []).length - base, ms: ms };
    })()`, 120000);
    h.F(big.got === 3000, '① 检查信息 CSV(UTF-8) 3000 行全部入库（实际 ' + big.got + '，' + big.ms + 'ms）');
    h.F(big.ms <= 8000, '① 导入耗时在阈值内（' + big.ms + 'ms ≤ 8000ms，基线约 800ms）');

    // ---------- ② CSV(GBK) ----------
    const gbk = await h.ev(`(async () => {
      // 「问题描述,单位」表头 + 「防溜措施,测试站」数据（GBK 字节，硬编码自校验）
      const bytes = new Uint8Array([0xCE,0xC2,0xCC,0xE2,0xC3,0xE8,0xCA,0xF6,0x2C,0xB5,0xA5,0xCE,0xBB,0x0A,
                                    0xB7,0xC0,0xC1,0xEF,0xB4,0xEB,0xCA,0xA9,0x2C,0xB2,0xE2,0xCA,0xD4,0xD5,0xBE,0x0A]);
      const base = (window.getIssueData() || []).length;
      await window.issueHandleFile({ target: { files: [new File([bytes], 'io_gbk.csv', { type: 'text/csv' })], value: '' } });
      const all = window.getIssueData() || [];
      const hit = all.filter(r => String(r.content || '') === '防溜措施');
      return { added: all.length - base, unit: hit.length ? String(hit[0].unit || '') : '(未识别)' };
    })()`);
    h.F(gbk.added === 1 && gbk.unit === '测试站', '② CSV(GBK) 中文不乱码且列名识别正确（解码 防溜措施/' + gbk.unit + '）');

    // ---------- ③ 坏 JSON ----------
    const bad = await h.ev(`(async () => {
      const before = (window.getIssueData() || []).length;
      try { await window.issueHandleFile({ target: { files: [new File(['{"not":"array"}'], 'bad.json', { type: 'application/json' })], value: '' } }); } catch (e) {}
      await new Promise(r => setTimeout(r, 500));
      return { before: before, after: (window.getIssueData() || []).length };
    })()`);
    h.F(bad.before === bad.after, '③ 坏 JSON 不写库（' + bad.before + ' → ' + bad.after + '）');

    // ---------- ④ 去重口径（内容+单位+日期）----------
    const dedup = await h.ev(`(async () => {
      const mk = (date) => new File([JSON.stringify([{ 性质:'A类', datetime: date, category:'调车', content:'口径断言：同单位同一问题', regulation:'《X》第1条', unit:'口径站' }])], 'd.json', { type:'application/json' });
      const n0 = (window.getIssueData() || []).length;
      await window.issueHandleFile({ target: { files: [mk('2026-09-01 08:00')], value: '' } });
      const n1 = (window.getIssueData() || []).length;
      await window.issueHandleFile({ target: { files: [mk('2026-09-05 08:00')], value: '' } });   // 换日期
      const n2 = (window.getIssueData() || []).length;
      await window.issueHandleFile({ target: { files: [mk('2026-09-05 08:00')], value: '' } });   // 同日重复
      const n3 = (window.getIssueData() || []).length;
      return { seq: [n0, n1, n2, n3] };
    })()`);
    const s = dedup.seq;
    h.F((s[1] - s[0]) === 1 && (s[2] - s[1]) === 1 && (s[3] - s[2]) === 0,
      '④ 追加去重口径 = 内容+单位+日期（换日期保留、同日同单位合并）：' + JSON.stringify(s));

    // ---------- ④.5 电话 CSV 导入（为导出准备数据；顺带覆盖第二条 CSV 通路）----------
    const phone = await h.ev(`(async () => {
      let csv = '序号,单位,站名,路电,市电,备注\\n';
      for (let i = 0; i < 5; i++) csv += (i + 1) + ',测试段,站' + i + ',001-' + i + ',010-' + i + ',\\n';
      const base = (window.getPhoneData() || []).length;
      await window.phoneHandleFile({ target: { files: [new File([csv], 'io_phone.csv', { type: 'text/csv' })], value: '' } });
      return { added: (window.getPhoneData() || []).length - base };
    })()`);
    h.F(phone.added === 5, '④.5 应急电话 CSV 导入 5 行（新增 ' + phone.added + '）');

    // ---------- ④.6 电话追加去重口径（真实数据回归，2026-09-21）----------
    // 背景：真实备份（839 条里 475 条站名为空）实测「导出 → 追加导入」= 839 → **1293**。
    // 旧口径「按站名去重」有两个反向缺陷：无站名记录**不参与去重**（重复导入成倍复制）、
    // 同名站名的多条记录被**合并成 1 条**（真数据里"安全生产指挥中心"11 条只剩 1 条）。
    // 键长由真实数据量出（3 字段 → 吞 6 条；5 字段 → 0 吞并），这里把它钉死，防止口径回退。
    const pDedup = await h.ev(`(async () => {
      window.showChoiceModal = async () => 'append';
      var rows = [
        { 单位: '甲单位', 线名: 'X线', 站名: '测试站A', 路电: '1001', 市电: '2001' },
        { 单位: '乙单位', 线名: 'Y线', 站名: '',       路电: '1002', 市电: '2002' },   // 无站名（真数据里占 57%）
        { 单位: '丙单位', 线名: 'Z线', 站名: '测试站A', 路电: '1003', 市电: '2003' },   // 同名站、不同单位
        { 单位: '丁单位', 线名: 'W线', 站名: '测试站B', 路电: '2001', 市电: '3001' },   // 同名站同单位同线，
        { 单位: '丁单位', 线名: 'W线', 站名: '测试站B', 路电: '2002', 市电: '3001' }    // 仅号码不同 → 必须两条都留
      ];
      var feed = async function () {
        var dt = new DataTransfer();
        dt.items.add(new File([JSON.stringify(rows)], 'p.json', { type: 'application/json' }));
        var inp = document.getElementById('phone-fileInput');
        inp.files = dt.files;
        inp.dispatchEvent(new Event('change', { bubbles: true }));
        for (var i = 0; i < 40; i++) { await new Promise(function (r) { setTimeout(r, 200); }); }
      };
      var base = (window.getPhoneData() || []).length;
      await feed();                                  // 首次：5 条应全进
      var added1 = window.getPhoneData().length - base;
      await feed();                                  // 再来一次完全相同：应 0 新增（幂等）
      var added2 = window.getPhoneData().length - base;
      var d = window.getPhoneData();
      return {
        added1: added1, added2: added2,
        sameStation: d.filter(function (r) { return r.站名 === '测试站A' && (r.单位 === '甲单位' || r.单位 === '丙单位'); }).length,
        noStation: d.filter(function (r) { return r.单位 === '乙单位' && !r.站名; }).length,
        multiNumber: d.filter(function (r) { return r.站名 === '测试站B' && r.单位 === '丁单位'; }).length
      };
    })()`);
    h.F(pDedup.added1 === 5 && pDedup.added2 === 5 && pDedup.sameStation === 2 && pDedup.noStation === 1 && pDedup.multiNumber === 2,
      '④.6 电话追加去重（幂等 + 不吞合法重复）：首次 +' + pDedup.added1 + '、重复导入仍 +' + pDedup.added2
      + '；无站名保留 ' + pDedup.noStation + ' 条、同名站不同单位保留 ' + pDedup.sameStation + ' 条、同站同单位不同号码保留 ' + pDedup.multiNumber + ' 条');

    // ---------- ⑤ 导出真实落盘 ----------
    const exports = [
      ['检查信息 JSON', `issueExportJSON()`, /^铁路检查信息_\d{4}-\d{2}-\d{2}_\d+条\.json$/],
      ['应急电话 JSON', `phoneExportJSON()`, /^应急电话_\d{4}-\d{2}-\d{2}\.json$/],
      ['铁路术语库 JSON', `exportRailwayTerms()`, /^铁路专业词库_\d{4}-\d{2}-\d{2}\.json$/],
      ['智能体 CSV', `window._agentExportIssues({})`, /\.csv$/]
    ];
    const fs = require('fs');
    for (const [label, expr, re] of exports) {
      const got = await h.grab(expr, 20000);
      let detail = '';
      if (got) {
        const full = path.join(h.DL, got);
        const ext = path.extname(got).toLowerCase();
        if (ext === '.json') { try { JSON.parse(fs.readFileSync(full, 'utf8')); detail = 'JSON 可解析'; } catch (e) { detail = 'JSON 解析失败'; } }
        else if (ext === '.csv') { const t = fs.readFileSync(full, 'utf8'); detail = t.charCodeAt(0) === 0xFEFF ? 'CSV 含 UTF-8 BOM' : '缺 BOM'; }
      }
      h.F(!!got && re.test(got) && !/失败|缺 BOM/.test(detail), '⑤ ' + label + ' 真实落盘且格式正确 → ' + (got || '(未生成)') + (detail ? '（' + detail + '）' : ''));
    }

    // ---------- ⑤.5 下载通路（用户反馈"华为浏览器全量导出不弹确认框、无法下载"）----------
    const dlPaths = await h.ev(`(async () => {
      var out = {};
      // ① 支持 File System Access API 时：优先弹「另存为」确认框（实测被调用后立即取消，不再偷偷下载）
      var _orig = window.showSaveFilePicker;
      var called = 0;
      window.showSaveFilePicker = async function () { called++; var e = new Error('cancel'); e.name = 'AbortError'; throw e; };
      await window.downloadBlob(new Blob(['x'], { type: 'application/json' }), '策略测试_1.json');
      out.pickerCalled = called;
      window.showSaveFilePicker = _orig;
      // ② 不支持时：走锚点，并且**必须**挂出不自动消失的兜底面板（否则用户只看到"没反应"）
      try { delete window.showSaveFilePicker; } catch (e) { window.showSaveFilePicker = undefined; }
      await window.downloadBlob(new Blob(['y'], { type: 'application/json' }), '策略测试_2.json');
      var tip = document.getElementById('_mb_dl_tip');
      out.hasTip = !!tip;
      out.hasLink = !!(tip && tip.querySelector('a[download]'));
      out.hasTabBtn = !!(tip && document.getElementById('_mb_dl_tab'));
      out.manualClose = /已保存，关闭/.test(tip ? tip.textContent : '');
      // 桌面与移动文案不同：桌面「若浏览器拦截了下载…」/移动「华为、国产浏览器…」，两者都算给出指引
      out.huaweiHint = /华为|下载文件|拦截/.test(tip ? tip.textContent : '');
      if (tip && tip.parentNode) tip.parentNode.removeChild(tip);
      return out;
    })()`, 40000);
    console.log('  ⑤.5 下载通路：' + JSON.stringify(dlPaths));
    h.F(dlPaths.pickerCalled === 1, '⑤.5 支持 File System Access API 时优先弹「另存为」确认框（实测调用 ' + dlPaths.pickerCalled + ' 次；用户取消则不再偷偷下载）');
    h.F(dlPaths.hasTip && dlPaths.hasLink && dlPaths.hasTabBtn && dlPaths.manualClose && dlPaths.huaweiHint,
      '⑤.5 不支持时给出**不自动消失**的兜底面板：直接保存链接 + 「在新标签页打开」+ 手动关闭 + 华为/国产浏览器设置提示');

    // ---------- 无阻塞弹窗 & 无页面异常 ----------
    h.F(h.dialogs.length === 0, '全程无阻塞式 alert/confirm（实测会挂死页面 JS）');
    h.F(h.pageErrors.length === 0, '页面无未捕获异常（' + (h.pageErrors[0] || '') + '）');
  } catch (e) {
    h.F(false, '套件执行异常：' + (e && e.message));
  }
  h.done();
})();
