#!/usr/bin/env node
/**
 * 真实数据基准（本地真实备份）
 * ------------------------------------------------------------------
 * 用仓库根的 `安监系统测试数据.zip`（≈90MB 全量备份，issues 43585 / handbook 1305 /
 * phone 839 / termLibrary 2047 / diary 50+2图 / 资料 66 / 报告 60 / 对话 92）测三件事：
 *   A) **带真数据的冷启动**：恢复 → 自动刷新 → 采集 DCL/load/遮罩消失/台账就绪/KB就绪/长任务/堆
 *      （与 boot-bench 的合成 4 万条基线同口径，便于对照）
 *   B) **真数据检索**：用真实检查信息内容 + 真实术语各 25 条作查询，测 KB.search 的 P50/P95/空结果率/来源分布
 *   C) **4 万条 Excel 导出 + 覆盖导入**：应用自带 XLSX 生成 43585 行 → 落盘 → 走真实入口导入，测耗时与峰值堆
 *
 * 说明：基准只报数字，**只对结构性事实断言**（数据已恢复 / 索引就绪 / 条数一致），
 *      不对耗时设绝对阈值（机器差异大），避免把"慢"误判成"错"。
 * 用法：node scripts/realdata-bench.js ｜ 缺测试数据时打印 ⏭ SKIP 并退出 0
 */
'use strict';
const H = require('./audit-harness');
const fs = require('fs');
const path = require('path');

const ZIPNAME = '安监系统测试数据.zip';
const ZIP = path.join(H.ROOT, ZIPNAME);
const EXPECT_ISSUES = 43585;
const TMPDL = path.join(H.ROOT, 'scripts', '_tmp_dl');
const T0 = Date.now();
const mark = (s) => console.log('  · [' + String(Date.now() - T0).padStart(6) + 'ms] ' + s);

// 与 boot-bench 同口径的采集脚本（无反引号，避免破坏外层模板串）
const HARNESS = `
(() => {
  const B = window.__bench = { marks: {}, lt: [], errs: [] };
  const now = () => Math.round(performance.now());
  B.marks.nav = 0;
  document.addEventListener('DOMContentLoaded', () => { B.marks.dcl = now(); });
  window.addEventListener('load', () => { B.marks.load = now(); });
  window.addEventListener('error', (e) => { try { B.errs.push(String(e.message || (e.target && e.target.src) || '').slice(0, 120)); } catch (_) {} }, true);
  try {
    new PerformanceObserver((list) => {
      list.getEntries().forEach((en) => { B.lt.push({ s: Math.round(en.startTime), d: Math.round(en.duration) }); });
    }).observe({ type: 'longtask', buffered: true });
  } catch (e) {}
  (function pollOverlay() {
    if (B.marks.overlayGone != null) return;
    if (document.getElementById('app-boot-overlay') === null && document.body) { B.marks.overlayGone = now(); return; }
    requestAnimationFrame(pollOverlay);
  })();
  (function poll() {
    if (B.marks.issueReady == null && window.__issueDataReady) B.marks.issueReady = now();
    if (B.marks.kbReady == null && window.KB && typeof KB.stats === 'function') {
      try {
        const rows = KB.stats();
        const built = rows.filter((r) => r.built).length;
        if (built >= 5) B.marks.kbBuilt = B.marks.kbBuilt || { n: built, t: now() };
        if (built >= rows.length) B.marks.kbReady = now();
      } catch (e) {}
    }
    setTimeout(poll, 100);
  })();
  B.report = () => {
    const lt = B.lt, win = lt.filter((x) => x.s <= 15000);
    const heap = (performance.memory && performance.memory.usedJSHeapSize) || 0;
    return JSON.stringify({
      marks: B.marks,
      longtask: { n: win.length, total: win.reduce((s, x) => s + x.d, 0), max: win.reduce((m, x) => Math.max(m, x.d), 0) },
      heapMB: +(heap / 1048576).toFixed(1),
      kb: (window.KB && KB.stats) ? KB.stats().map((r) => r.key + ':' + (r.built ? '1' : '0') + '/' + r.total) : [],
      errs: B.errs
    });
  };
})();
`;

async function main() {
  if (!fs.existsSync(ZIP)) {
    console.log('  ⏭ SKIP：未找到 ' + ZIPNAME + '（真实数据基准需要本地保留该备份）');
    process.exit(0);
  }
  const sizeMB = Math.round(fs.statSync(ZIP).size / 1048576 * 10) / 10;
  const h = await H.start({ port: 8177, cdpPort: 9387, view: 'rdbench' });
  fs.mkdirSync(TMPDL, { recursive: true });
  let restoreMs = 0;
  try {
    // 采集脚本在任何页面脚本之前注入（切页/刷新后仍然生效）
    await h.cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: HARNESS }, h.sessionId);
    await h.nav('index.html?v=rdbench');
    mark('首次加载（用于执行恢复）');
    await h.ev(`(() => { window.confirm = () => true; return 1; })()`);

    // ==================== 恢复真实备份 ====================
    const got = await h.ev(`(async () => {
      var r = await fetch('/' + encodeURIComponent('${ZIPNAME}'));
      if (!r.ok) return { err: 'HTTP ' + r.status };
      var b = await r.blob();
      window.__bkFile = new File([b], '${ZIPNAME}', { type: 'application/zip' });
      return { mb: Math.round(b.size / 1048576 * 10) / 10 };
    })()`, 300000);
    const tl = await h.ev(`(async () => {
      window.__benchGen = 1;   // 标记"旧文档"：刷新后新文档没有这个字段
      var captured = null, oc = document.createElement.bind(document);
      document.createElement = function (t) { var el = oc(t); if (String(t).toLowerCase() === 'input' && !captured) captured = el; return el; };
      try { window.oneClickRestore(); } catch (e) { document.createElement = oc; return { err: 'call:' + e.message }; }
      document.createElement = oc;
      if (!captured) return { err: '未捕获 input' };
      captured.click = function () {};
      captured.onchange({ target: { files: [window.__bkFile], value: '' } });
      var mask = null, t0 = Date.now();
      for (var i = 0; i < 800; i++) {
        mask = Array.prototype.find.call(document.querySelectorAll('.modal.active'), function (m) { return /确认恢复本机数据/.test(m.textContent || ''); });
        if (mask) break;
        await new Promise(r => setTimeout(r, 250));
      }
      if (!mask) return { err: '预览弹窗未出现' };
      var ok = mask.querySelector('[data-act="ok"]');
      if (!ok) return { err: '无确认按钮' };
      var t1 = Date.now();
      ok.click();
      var last = '';
      for (var j = 0; j < 2000; j++) {
        var lab = document.getElementById('global-progress-label');
        var s = lab ? lab.textContent : '';
        last = s;
        if (/恢复完成/.test(s) || /失败/.test(s)) break;
        await new Promise(r => setTimeout(r, 250));
      }
      return { ms: Date.now() - t1, done: /恢复完成/.test(last), label: last };
    })()`, 660000);
    restoreMs = tl.ms || 0;
    mark('恢复结束 ' + (tl.done ? '（' + Math.round(restoreMs / 1000) + 's）' : '失败：' + tl.label));
    h.F(!!got && got.mb > 80 && tl.done, '① 真实备份已恢复（' + got.mb + ' MB，恢复 ' + Math.round(restoreMs / 1000) + 's）' + (tl.err ? ' ← ' + tl.err : ''));

    // ==================== A) 带真数据的冷启动 ====================
    // 恢复流程会在 ~3s 后 location.reload()：新文档里 __benchGen 为空 → 用它区分"刷新后的启动"
    let boot = null;
    for (let i = 0; i < 240 && !boot; i++) {
      try {
        const raw = await h.ev(`(function () {
          if (window.__benchGen) return null;
          if (!window.__bench || window.__bench.marks.load == null) return null;
          return window.__bench.report();
        })()`, 15000);
        if (raw) boot = JSON.parse(raw);
      } catch (e) {}
      if (!boot) await h.sleep(500);
    }
    if (!boot) throw new Error('未能采集到刷新后的启动指标');
    mark('刷新后启动指标已采集，再等 13s 覆盖 KB 自动载入 + 空闲预热');
    await h.sleep(13000);
    const boot2 = JSON.parse(await h.ev(`window.__bench.report()`, 30000));
    const m = boot2.marks;
    console.log('  ┌─ A) 带真数据冷启动 ───────────────────────────────');
    console.log('  │ DCL ' + (m.dcl || '-') + 'ms ｜ load ' + (m.load || '-') + 'ms ｜ 启动遮罩消失 ' + (m.overlayGone || '-') + 'ms');
    console.log('  │ 台账就绪 ' + (m.issueReady || '-') + 'ms ｜ KB 索引就绪 ' + (m.kbReady || '-') + 'ms ｜ 长任务 ' + boot2.longtask.n + ' 个 / ' + boot2.longtask.total + 'ms（最长 ' + boot2.longtask.max + 'ms）');
    console.log('  │ 堆占用 ' + boot2.heapMB + 'MB ｜ KB 源 ' + boot2.kb.join(', '));
    console.log('  └────────────────────────────────────────────────');
    h.F(m.dcl > 0 && m.load > 0 && m.overlayGone > 0 && boot2.errs.length === 0,
      '② 带真数据冷启动可采集且无页面异常（遮罩消失 ' + m.overlayGone + 'ms / 台账就绪 ' + (m.issueReady || '-') + 'ms / 堆 ' + boot2.heapMB + 'MB）');

    const cnt = await h.ev(`(async () => {
      var out = { issues: (window.getIssueData() || []).length, phone: (window.getPhoneData() || []).length, handbook: (window.getHandbookData() || []).length, term: (window.PATCH_TERM_LIBRARY || []).length };
      try { out.wmat = await window.getWrMatCount(); } catch (e) {}
      return out;
    })()`, 120000);
    h.F(cnt.issues === EXPECT_ISSUES, '③ 刷新后数据完整（检查信息 ' + cnt.issues + '/' + EXPECT_ISSUES + '，电话 ' + cnt.phone + '，手册 ' + cnt.handbook + '，术语 ' + cnt.term + '）');

    // ==================== B) 真数据检索 ====================
    // 等 KB 自动载入完成（启动后空闲预热），最多 90s
    const kbState = await h.ev(`(async () => {
      var t0 = Date.now();
      while (Date.now() - t0 < 90000) {
        try { if (KB.stats().every(function (r) { return r.built; })) break; } catch (e) {}
        await new Promise(r => setTimeout(r, 1000));
      }
      return KB.stats().map(function (r) { return r.key + ':' + (r.built ? '1' : '0') + '/' + r.total; });
    })()`, 180000);
    mark('KB 状态 ' + kbState.join(', '));
    // 只要求"有数据的源"就绪：materials/reports 是**按需/异步**源，空闲预热不建它们（stats 显示 0/0）
    const builtMain = (kbState || []).filter((s) => { const mm = /:(\d+)\/(\d+)$/.exec(s); return mm && Number(mm[2]) > 0; }).every((s) => /:1\//.test(s));
    h.F(builtMain && kbState.length > 0, '④ 真数据 KB 主源索引就绪（有数据的源全部 built；按需源不计）→ ' + kbState.join(', '));

    const ret = await h.ev(`(async () => {
      var issues = window.getIssueData() || [];
      var terms = window.PATCH_TERM_LIBRARY || [];
      var qs = [];
      for (var i = 0; i < issues.length && qs.length < 25; i += 137) {
        var c = issues[i] && issues[i].content;
        if (c && String(c).trim().length > 10) qs.push({ kind: '真实问题', q: String(c).trim().slice(0, 40) });
      }
      var step = Math.max(1, Math.floor(terms.length / 25));
      for (var j = 0; j < terms.length && qs.length < 50; j += step) { if (terms[j] && terms[j].term) qs.push({ kind: '术语', q: terms[j].term }); }
      var lat = [], empty = 0, hitsTotal = 0, src = {}, rows = [], err = 0;
      var budgetMs = 90000;   // 总预算：超了就停（保证本次求值一定返回，不因个别慢查询丢掉整批数据）
      var spent = 0, stopped = false;
      for (var k = 0; k < qs.length; k++) {
        if (spent > budgetMs) { stopped = true; break; }
        var t = performance.now(), hits = [];
        try { hits = KB.search(qs[k].q, {}) || []; } catch (e) { err++; hits = []; }
        var ms = performance.now() - t;
        spent += ms;
        lat.push(ms);
        if (!hits.length) empty++; else hitsTotal += hits.length;
        hits.forEach(function (hit) { var key = hit.key || hit.source || '?'; src[key] = (src[key] || 0) + 1; });
        rows.push({ kind: qs[k].kind, q: qs[k].q.slice(0, 20), ms: Math.round(ms), hits: hits.length, top: hits[0] ? String(hits[0].key || hits[0].source || '?') : '-' });
        window.__retProg = { i: k + 1, n: qs.length, spentMs: Math.round(spent), lastMs: Math.round(ms), lastHits: hits.length };
      }
      var sorted = lat.slice().sort(function (a, b) { return a - b; });
      var P = function (x) { return Math.round(sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * x))] || 0); };
      // 对规路径（searchRules）单独测 10 次
      var rlat = [];
      for (var r2 = 0; r2 < 10 && r2 < qs.length; r2++) {
        var tr = performance.now();
        try { KB.searchRules(qs[r2].q, 4); } catch (e) {}
        rlat.push(performance.now() - tr);
      }
      rlat.sort(function (a, b) { return a - b; });
      return { n: qs.length, done: lat.length, stopped: stopped, spentMs: Math.round(spent), err: err, p50: P(0.5), p95: P(0.95), max: Math.round(sorted[sorted.length - 1] || 0),
        emptyRate: Math.round(empty / Math.max(1, lat.length) * 100), avgHits: (hitsTotal / Math.max(1, lat.length)).toFixed(1),
        src: src, rows: rows, rulesP50: Math.round(rlat[Math.floor(rlat.length / 2)] || 0), rulesMax: Math.round(rlat[rlat.length - 1] || 0) };
    })()`, 150000);
    console.log('  ┌─ B) 真数据检索（' + ret.n + ' 次查询：真实问题描述 + 真实术语）─────');
    console.log('  │ 延迟 P50 ' + ret.p50 + 'ms ｜ P95 ' + ret.p95 + 'ms ｜ 最长 ' + ret.max + 'ms ｜ 异常 ' + ret.err + ' 次');
    console.log('  │ 空结果 ' + ret.emptyRate + '% ｜ 平均命中 ' + ret.avgHits + ' 条 ｜ 来源分布 ' + JSON.stringify(ret.src));
    console.log('  │ 对规 searchRules：P50 ' + ret.rulesP50 + 'ms ｜ 最长 ' + ret.rulesMax + 'ms');
    ret.rows.forEach((r) => console.log('  │   [' + r.kind + '] "' + r.q + '" → ' + r.hits + ' 命中 / ' + r.ms + 'ms / top=' + r.top));
    console.log('  └────────────────────────────────────────────────');
    h.F(ret.err === 0 && ret.done >= 10, '⑤ 真数据检索全部正常返回（完成 ' + ret.done + '/' + ret.n + ' 次' + (ret.stopped ? '，超过 ' + Math.round(ret.spentMs / 1000) + 's 预算提前收尾' : '') + '，异常 ' + ret.err + '，P95 ' + ret.p95 + 'ms，空结果 ' + ret.emptyRate + '%）');
    // 【性能回归门禁·检索】修复前实测：规则源（13.9 万块）走"退化全量扫描"→ 每次 5.9s、对规 6.6s；
    //   改成"合并正则快筛 + indexOf 计频"后 → 113ms / 104ms（46~63 倍）。这里卡住阈值防止退化回去。
    h.F(ret.p50 < 800 && ret.done === ret.n, '⑥ 检索性能门禁：P50 ' + ret.p50 + 'ms < 800ms 且 50 次全部跑完（修复前 5909ms/次，退化即失败）');
    h.F(ret.max < 25000, '⑦ 首次检索的按需预热不失控（最长 ' + ret.max + 'ms < 25s；资料/报告源首次加载 ~12s 属一次性）');

    // ==================== C) 4 万条 Excel 导出 + 覆盖导入 ====================
    const gen = await h.ev(`(async () => {
      if (!(await window.requireLib('src/js/vendor/xlsx.full.min.js', { feature: '基准导出', silent: true }))) return { err: 'XLSX 未加载' };
      var rows = (window.getIssueData() || []).map(function (r) {
        return { '序号': r.id || '', '性质': r.性质 || '', '时间': r.datetime || '', '类别': r.category || '', '问题描述': r.content || '', '规章依据': r.regulation || '', '单位': r.unit || '' };
      });
      if (!rows.length) return { err: '无可导出的检查信息' };
      var t0 = performance.now();
      var ws = XLSX.utils.json_to_sheet(rows);
      var wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, '检查信息');
      var out = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
      var ms = Math.round(performance.now() - t0);
      var blob = new Blob([out], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
      window.downloadBlob(blob, '基准_检查信息_' + rows.length + '条.xlsx');
      return { rows: rows.length, ms: ms, mb: +(blob.size / 1048576).toFixed(1) };
    })()`, 420000);
    mark('XLSX 生成 ' + JSON.stringify(gen));
    let xf = null;
    for (let i = 0; i < 200 && !xf; i++) { await h.sleep(500); const f = h.listDL().filter((x) => /^基准_检查信息_/.test(x)); if (f.length) xf = f[f.length - 1]; }
    h.F(!!xf && gen.rows === EXPECT_ISSUES, '⑥ 4 万条 Excel 导出成功（' + (xf || '未生成') + '，' + gen.rows + ' 行 / ' + gen.mb + ' MB / 生成 ' + Math.round((gen.ms || 0) / 1000) + 's）');

    let imp = null;
    if (xf) {
      fs.copyFileSync(path.join(h.DL, xf), path.join(TMPDL, 'bench_issues.xlsx'));
      imp = await h.ev(`(async () => {
        window.showChoiceModal = async () => 'overwrite';   // 用同一份数据覆盖，避免翻倍
        var txt = await (await fetch('/scripts/_tmp_dl/bench_issues.xlsx')).arrayBuffer();
        window.__xlsxFile = new File([txt], 'bench_issues.xlsx', { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
        window.__heapPeak = 0;
        var timer = setInterval(function () { var m = (performance.memory && performance.memory.usedJSHeapSize) || 0; if (m > window.__heapPeak) window.__heapPeak = m; }, 200);
        var before = (window.getIssueData() || []).length;
        var inp = document.getElementById('issue-fileInput');
        var dt = new DataTransfer();
        dt.items.add(window.__xlsxFile);
        inp.files = dt.files;
        var t0 = performance.now();
        inp.dispatchEvent(new Event('change', { bubbles: true }));
        var after = before;
        for (var i = 0; i < 1200; i++) {                    // 最多 5 分钟
          await new Promise(function (r) { setTimeout(r, 250); });
          after = (window.getIssueData() || []).length;
          var lab = document.getElementById('global-progress-label');
          var done = lab && /完成|成功/.test(lab.textContent || '');
          if (after !== before && done) break;
        }
        clearInterval(timer);
        return { ms: Math.round(performance.now() - t0), before: before, after: after, peakMB: +(window.__heapPeak / 1048576).toFixed(1) };
      })()`, 420000);
      console.log('  ┌─ C) 4 万条 Excel 覆盖导入 ────────────────────────');
      console.log('  │ 文件 ' + (xf || '-') + '（' + gen.mb + 'MB，生成 ' + Math.round((gen.ms || 0) / 1000) + 's）');
      console.log('  │ 导入 ' + Math.round((imp.ms || 0) / 1000) + 's ｜ 条数 ' + imp.before + ' → ' + imp.after + ' ｜ 峰值堆 ' + imp.peakMB + 'MB');
      console.log('  └────────────────────────────────────────────────');
      h.F(imp.after === EXPECT_ISSUES, '⑧ 4 万条 Excel 覆盖导入正确（' + imp.before + ' → ' + imp.after + '，耗时 ' + Math.round((imp.ms || 0) / 1000) + 's，峰值堆 ' + imp.peakMB + 'MB）');
    } else {
      h.F(false, '⑧ 4 万条 Excel 覆盖导入未执行（导出文件缺失）');
    }

    console.log('\n  汇总数字：备份 ' + sizeMB + 'MB ｜ 恢复 ' + Math.round(restoreMs / 1000) + 's ｜ 冷启动 台账就绪 ' + (m.issueReady || '-') + 'ms / 堆 ' + boot2.heapMB + 'MB'
      + ' ｜ 检索 P50 ' + ret.p50 + 'ms / P95 ' + ret.p95 + 'ms ｜ 4 万条 Excel 生成 ' + Math.round((gen.ms || 0) / 1000) + 's / 导入 ' + (imp ? Math.round(imp.ms / 1000) : '-') + 's');
  } catch (e) {
    h.F(false, '真实数据基准异常：' + (e && e.message));
    console.log(e && e.stack);
  }
  try { fs.rmSync(TMPDL, { recursive: true, force: true }); } catch (e) {}
  h.done();
}

main();
