/**
 * 事故案例（与检查手册平行的第二份四级目录数据）审计 —— 常驻套件
 * =================================================================
 * 用户需求（2026-09-22）：
 *   ① 检查手册旁增加「事故案例」；
 *   ② **导入原理完全与检查手册一致**：同一套解析（docx/json/txt/md → 章/节/条/款）、
 *      多文件可同时存在、追加合并互不覆盖；
 *   ③ 大纲浏览栏可以在「检查手册 / 事故案例 / 规章制度」之间选择。
 * 本套件钉住这些行为 + 数据隔离（两份互不串数据）+ 备份/刷新持久化。
 *
 * 用法：node scripts/accident-import-audit.js
 */
'use strict';
const H = require('./audit-harness');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const HB_JSON = JSON.stringify([
  { chapter: '第一章 安全基础', section: '一、管理', item: '项点A', subitem: '', content: '手册正文甲：安全管理基本要求。' },
  { chapter: '第一章 安全基础', section: '一、管理', item: '项点B', subitem: '', content: '手册正文乙：台账与记录。' }
]);
const CASE_JSON = JSON.stringify([
  { chapter: '事故案例·行车', section: '一、典型案例', item: '案例1', subitem: '', content: '某年某月，某站未按规定设置防护，造成险情。' },
  { chapter: '事故案例·行车', section: '一、典型案例', item: '案例1', subitem: '补充', content: '经调查系防护人员擅离岗位。' }
]);
const CASE_MD = [
  '# 事故案例汇编',
  '## 第一章 行车事故',
  '### 一、典型案例',
  '#### 案例2 未按规定瞭望',
  '司机未按规定瞭望，越过关闭信号。',
  ''
].join('\n');
const CASE_JSON_MORE = JSON.stringify([
  { chapter: '事故案例·行车', section: '二、安全防护', item: '案例3', subitem: '', content: '作业人员未系安全带，属严重违章。' }
]);

/** 在页面里模拟"选文件 → 等确认弹窗 → 点追加合并" */
const IMPORT_FN = `window.__imp = function (inputId, files, waitMs) {
  return new Promise(function (resolve) {
    var inp = document.getElementById(inputId);
    if (!inp) { resolve('no-input:' + inputId); return; }
    var dt = new DataTransfer();
    files.forEach(function (f) { dt.items.add(f); });
    inp.files = dt.files;
    inp.dispatchEvent(new Event('change', { bubbles: true }));
    var t0 = Date.now();
    (function poll() {
      var modal = document.getElementById('handbook-importModal');
      var open = modal && modal.classList.contains('active');
      if (open) {
        var btn = document.getElementById('handbook-confirmImport');
        if (btn) { btn.click(); }
        setTimeout(function () {
          var stillOpen = modal.classList.contains('active');
          resolve(stillOpen ? 'modal-stuck' : 'ok');
        }, 400);
        return;
      }
      if (Date.now() - t0 > (waitMs || 15000)) { resolve('timeout'); return; }
      setTimeout(poll, 120);
    })();
  });
};`;

/** 用 PowerShell 读 zip 里的条目（与 realdata-e2e.js 同一套做法） */
function extractZipEntry(zipPath, name, out) {
  const ps = `Add-Type -AssemblyName System.IO.Compression.FileSystem; $z=[System.IO.Compression.ZipFile]::OpenRead('${zipPath}'); $e=$z.Entries | Where-Object { $_.FullName -eq '${name}' }; if($e){[System.IO.Compression.ZipFileExtensions]::ExtractToFile($e,'${out}',$true); 'OK'}else{'MISS'}; $z.Dispose()`;
  try { return execSync('powershell -NoProfile -Command "' + ps + '"', { encoding: 'utf8' }).trim(); } catch (e) { return 'ERR:' + e.message; }
}

(async () => {
  const h = await H.start({ port: 8190, cdpPort: 9390, view: 'accident' });
  try {
    await h.nav('index.html?v=accident');
    // 清干净起点（localStorage 可能残留）
    await h.ev(`(() => {
      try { localStorage.removeItem('handbook_fourlevel_v1'); localStorage.removeItem('accident_fourlevel_v1'); } catch (e) {}
      if (window.KB && KB.clearCache) { try { KB.clearCache(); } catch (e) {} }
      return 1;
    })()`, 30000);
    await h.nav('index.html?v=accident2');
    await h.ev(IMPORT_FN, 30000);

    // ---------- ① 导入「检查手册」两批 ----------
    const i1 = await h.ev(`window.__imp('handbook-jsonFile', [new File([${JSON.stringify(HB_JSON)}], 'hb1.json', { type: 'application/json' })], 15000)`, 60000);
    const i2 = await h.ev(`window.__imp('handbook-jsonFile', [new File([${JSON.stringify(HB_JSON)}], 'hb1-again.json', { type: 'application/json' })], 15000)`, 60000);
    const s1 = await h.ev(`(async () => {
      if (window.KB && KB.ensure) { try { await KB.ensure(['handbook', 'accidents']); } catch (e) {} }
      var st = (window.KB && KB.stats ? KB.stats() : []).filter(function (r) { return r.key === 'handbook' || r.key === 'accidents'; });
      return {
        handbook: (window.getHandbookData() || []).length,
        accident: (window.getAccidentData() || []).length,
        ls: [!!localStorage.getItem('handbook_fourlevel_v1'), !!localStorage.getItem('accident_fourlevel_v1')],
        kb: st.map(function (r) { return r.key + ':' + r.total + '篇/' + r.chunks + '块'; })
      };
    })()`, 90000);
    h.F(i1 === 'ok' && i2 === 'ok' && s1.handbook === 2 && s1.accident === 0,
      '① 手册导入（含重复文件去重）只落手册：手册 ' + s1.handbook + ' 条、事故案例 ' + s1.accident + ' 条（两次导入返回 ' + i1 + '/' + i2 + '）');
    h.F(s1.ls[0] === true && s1.ls[1] === false, '② 两份数据各占一个 localStorage 键（手册有、案例还没有 → 互不写入）');

    // ---------- ③ 事故案例：一次多选两个文件（json + md） ----------
    const i3 = await h.ev(`window.__imp('accident-jsonFile', [
      new File([${JSON.stringify(CASE_JSON)}], 'case1.json', { type: 'application/json' }),
      new File([${JSON.stringify(CASE_MD)}], 'case2.md', { type: 'text/markdown' })
    ], 15000)`, 60000);
    const s2 = await h.ev(`({ handbook: (window.getHandbookData() || []).length, accident: (window.getAccidentData() || []).length })`, 30000);
    h.F(i3 === 'ok' && s2.accident >= 3 && s2.handbook === 2,
      '③ 事故案例一次导入 2 个文件（JSON+MD）且**不影响手册**：案例 ' + s2.accident + ' 条 / 手册 ' + s2.handbook + ' 条');

    // ---------- ④ 追加不覆盖 + 去重 ----------
    const i4 = await h.ev(`window.__imp('accident-jsonFile', [new File([${JSON.stringify(CASE_JSON)}], 'case1-again.json', { type: 'application/json' })], 15000)`, 60000);
    const s3 = await h.ev(`({ accident: (window.getAccidentData() || []).length })`, 30000);
    const i5 = await h.ev(`window.__imp('accident-jsonFile', [new File([${JSON.stringify(CASE_JSON_MORE)}], 'case3.json', { type: 'application/json' })], 15000)`, 60000);
    const s4 = await h.ev(`({ handbook: (window.getHandbookData() || []).length, accident: (window.getAccidentData() || []).length })`, 30000);
    h.F(s3.accident === s2.accident, '④ 同一份案例再导入 → 去重不翻倍（' + s2.accident + ' → ' + s3.accident + '，返回 ' + i4 + '）');
    h.F(s4.accident === s2.accident + 1 && s4.handbook === 2,
      '⑤ 导入新案例 → 追加不覆盖（' + s2.accident + ' → ' + s4.accident + '），手册仍 ' + s4.handbook + ' 条');

    // ---------- ⑥ 大纲浏览栏三视图切换 ----------
    const view = await h.ev(`(async () => {
      var out = {};
      window.hbSwitchView('outline');
      await new Promise(r => setTimeout(r, 400));
      var t = document.getElementById('hb-outlineTree').textContent || '';
      out.handbookHasHb = /项点A|项点B|安全基础/.test(t);
      out.handbookHasCase = /案例1|事故案例·行车/.test(t);
      window.hbSwitchView('cases');
      await new Promise(r => setTimeout(r, 400));
      var t2 = document.getElementById('hb-outlineTree').textContent || '';
      out.caseHasCase = /案例1|事故案例/.test(t2);
      out.caseHasHb = /项点A|项点B/.test(t2);
      out.caseBtnActive = document.getElementById('hb-toggleCases').classList.contains('active');
      window.hbSwitchView('rules');
      await new Promise(r => setTimeout(r, 500));
      out.rulesBtnActive = document.getElementById('hb-toggleRules').classList.contains('active');
      window.hbSwitchView('cases');
      await new Promise(r => setTimeout(r, 300));
      return out;
    })()`, 60000);
    h.F(view.handbookHasHb && !view.handbookHasCase, '⑥ 大纲视图显示手册且不含案例（数据隔离）');
    h.F(view.caseHasCase && !view.caseHasHb && view.caseBtnActive, '⑦ 事故案例视图显示案例且不含手册（按钮高亮正确）');
    h.F(view.rulesBtnActive, '⑧ 规章制度视图仍可切换');

    // ---------- ⑨ 搜索按当前数据集 ----------
    const search = await h.ev(`(async () => {
      var inp = document.getElementById('hb-searchInput');
      inp.value = '项点A';                       // 只在手册里有的词
      window.hbSearch('项点A');
      await new Promise(r => setTimeout(r, 500));
      var inCase = (document.getElementById('hb-searchInfo') || {}).textContent || '';
      window.hbSwitchView('outline');
      await new Promise(r => setTimeout(r, 300));
      window.hbSearch('项点A');
      await new Promise(r => setTimeout(r, 500));
      var inHb = (document.getElementById('hb-searchInfo') || {}).textContent || '';
      window.hbSwitchView('cases');
      await new Promise(r => setTimeout(r, 300));
      window.hbSearch('未系安全带');
      await new Promise(r => setTimeout(r, 500));
      var caseHit = (document.getElementById('hb-searchInfo') || {}).textContent || '';
      return { inCase: inCase, inHb: inHb, caseHit: caseHit };
    })()`, 60000);
    h.F(/事故案例命中 0 条/.test(search.inCase) && /检查手册命中 1 条/.test(search.inHb),
      '⑨ 搜索按当前数据集生效（案例视图搜手册词 = ' + JSON.stringify(search.inCase) + '；手册视图 = ' + JSON.stringify(search.inHb) + '）');
    h.F(/事故案例命中 1 条/.test(search.caseHit), '⑩ 案例视图能搜到案例（' + JSON.stringify(search.caseHit) + '）');

    // ---------- ⑪ 刷新后仍在（loadFromStorage） ----------
    await h.nav('index.html?v=accident3');
    await h.ev(IMPORT_FN, 30000);
    const after = await h.ev(`({ handbook: (window.getHandbookData() || []).length, accident: (window.getAccidentData() || []).length })`, 30000);
    h.F(after.handbook === 2 && after.accident === s4.accident, '⑪ 刷新后两份数据都在（手册 ' + after.handbook + ' / 案例 ' + after.accident + '）');

    // ---------- ⑫ 备份包含 accident ----------
    const bk = await h.ev(`(async () => {
      try { window.oneClickBackup(); } catch (e) { return 'err:' + e.message; }
      await new Promise(r => setTimeout(r, 3000));
      return 'started';
    })()`, 60000);
    await h.sleep(12000);
    let bkOk = false, bkInfo = '';
    try {
      const files = fs.readdirSync(h.DL).filter((f) => /\.zip$/i.test(f)).sort();
      const last = files[files.length - 1];
      if (last) {
        const outJson = path.join(h.DL, '_bk_probe.json');
        const r = extractZipEntry(path.join(h.DL, last), 'full_backup.json', outJson);
        if (r === 'OK') {
          const obj = JSON.parse(fs.readFileSync(outJson, 'utf8'));
          const acc = (obj.modules && obj.modules.accident) || null;
          bkOk = Array.isArray(acc) && acc.length === s4.accident;
          bkInfo = last + ' → accident ' + (Array.isArray(acc) ? acc.length + ' 条' : '缺失');
        } else { bkInfo = '解压失败 ' + r; }
        try { fs.unlinkSync(outJson); } catch (e) {}
      } else { bkInfo = '未生成备份 zip（' + bk + '）'; }
    } catch (e) { bkInfo = 'err:' + e.message; }
    h.F(bkOk, '⑫ 备份里带上事故案例（' + bkInfo + '）');

    // ---------- ⑬ 导出 / 清空（各管各的） ----------
    const exp = await h.ev(`window.exportAccident()`, 60000);
    await h.sleep(1500);
    const dl = fs.readdirSync(h.DL).filter((f) => /事故案例.*\.json$/.test(f));
    let expOk = false, expN = 0;
    let expFile = '';
    if (dl.length) {
      expFile = dl.slice().sort().pop();
      try { expN = JSON.parse(fs.readFileSync(path.join(h.DL, expFile), 'utf8')).length; } catch (e) {}
      expOk = expN === s4.accident;
    }
    h.F(expOk, '⑬ 事故案例导出 JSON（' + (expFile ? expFile + ' 共 ' + expN + ' 条' : '未生成') + '）');

    const clr = await h.ev(`(async () => {
      window.confirm = () => true;
      window.clearAccidentData();
      await new Promise(r => setTimeout(r, 600));
      return { handbook: (window.getHandbookData() || []).length, accident: (window.getAccidentData() || []).length,
               lsCase: !!localStorage.getItem('accident_fourlevel_v1') };
    })()`, 60000);
    h.F(clr.accident === 0 && clr.handbook === 2, '⑭ 清空事故案例**不影响手册**（案例 ' + clr.accident + ' / 手册 ' + clr.handbook + '）');

    // ---------- ⑮ 设置面板计数 ----------
    const cnt = await h.ev(`(async () => {
      if (window.updateDataManagementStats) await window.updateDataManagementStats();
      for (var i = 0; i < 20; i++) {
        var a = document.getElementById('set-accident-count'), b = document.getElementById('set-handbook-count');
        if (a && b && a.textContent !== '—' && b.textContent !== '—') break;
        await new Promise(r => setTimeout(r, 200));
        if (window.updateDataManagementStats) await window.updateDataManagementStats();
      }
      var a2 = document.getElementById('set-accident-count'), b2 = document.getElementById('set-handbook-count');
      return { accident: a2 ? a2.textContent : '(无元素)', handbook: b2 ? b2.textContent : '(无元素)' };
    })()`, 60000);
    h.F(/^0条/.test(cnt.accident) && /^2条/.test(cnt.handbook),
      '⑮ 设置面板分别显示条数（事故案例 ' + cnt.accident + ' / 检查手册 ' + cnt.handbook + '）');

    // ---------- ⑯ 知识库也把事故案例作为独立源建索引 ----------
    const kbsrc = await h.ev(`(async () => {
      // 重新导入一份案例用于验证索引（上面刚清空）；导入是异步的 —— 必须等它真正落库+失效完成
      await window.__imp('accident-jsonFile', [new File([${JSON.stringify(CASE_JSON)}], 'case-kb.json', { type: 'application/json' })], 15000);
      for (var _w = 0; _w < 40; _w++) {
        if ((window.getAccidentData() || []).length >= 2) break;
        await new Promise(r => setTimeout(r, 250));
      }
      if (window.KB && KB.ensure) { try { await KB.ensure('accidents'); } catch (e) {} }
      // 先检索（ensureSource 会按数据指纹自动重建索引），再读 stats —— 否则读到的是"数据还是空的时候"的旧状态
      var hits = 0;
      try { var r = window.KB.search('未按规定设置防护', { sources: ['accidents'], topK: 3 }).filter(function (x) { return x.key === 'accidents'; })[0]; hits = (r && r.hits && r.hits.length) || 0; } catch (e) {}
      var st = (window.KB && KB.stats ? KB.stats() : []).filter(function (r) { return r.key === 'accidents'; })[0];
      return { total: st ? st.total : -1, chunks: st ? st.chunks : -1, built: !!(st && st.built), hits: hits };
    })()`, 120000);
    h.F(kbsrc.built && kbsrc.total >= 2 && kbsrc.hits >= 1,
      '⑯ 知识库独立源 accidents（' + kbsrc.total + ' 篇 / ' + kbsrc.chunks + ' 块；检索命中 ' + kbsrc.hits + ' 条）');

    // 收尾清理
    await h.ev(`(() => { try { localStorage.removeItem('handbook_fourlevel_v1'); localStorage.removeItem('accident_fourlevel_v1'); } catch (e) {} return 1; })()`, 30000);
  } catch (e) {
    h.F(false, '套件异常：' + (e && e.message));
  }
  h.done();
  process.exit(0);
})();
