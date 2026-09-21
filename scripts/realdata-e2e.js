#!/usr/bin/env node
/**
 * 真实数据端到端回归（本地真实备份）
 * ------------------------------------------------------------------
 * 用仓库根目录的 `安监系统测试数据.zip`（约 90MB 的全量备份，用户真实使用数据）跑一遍：
 *   取备份 → 恢复预览条数 → 恢复落库 → 自动刷新 → 条数/多媒体校验 → 再导出 → 往返一致 → 单模块往返 → 4 万条导出
 *
 * 为什么值得单列一个套件：
 *   · 合成的小样本（3~5 条）测不出**体量与真实脏数据**引发的问题。本套件上线当天就抓到两个真缺陷：
 *     ① 「电话 导出 → 追加导入」839 → **1293**：839 条里有 475 条**站名为空**（单位/线名级联系人），
 *        旧「按站名去重」对无站名记录不去重（成倍复制）、还把同名站名的 11 条合并成 1 条（丢数据）；
 *     ② `_confirmRestore` 预览必须能正确读出 43585/1305/839/2047 这种真实量级。
 *   · 数据集本地保留、不进仓库（.gitignore）；缺失时本套件打印 ⏭ SKIP 并退出 0，其它机器也能跑全量回归。
 *
 * 数据规模（实测锚点，改动恢复/导出逻辑时应保持一致）：
 *   issues 43585 · handbook 1305 · phone 839 · termLibrary 2047 · diary 50（含 2 张媒体、3 条引用）
 *   writingMaterials 66 · writingReports 60 · dsConversations 92 · ruleImages 3
 *
 * 用法：node scripts/realdata-e2e.js
 */
'use strict';
const H = require('./audit-harness');
const fs = require('fs');
const path = require('path');
const cp = require('child_process');

const ZIPNAME = '安监系统测试数据.zip';
const ZIP = path.join(H.ROOT, ZIPNAME);
const EXPECT = { issues: 43585, handbook: 1305, phone: 839, term: 2047, diary: 50, wmat: 66, wrrpt: 60, media: 2 };
const TMPDL = path.join(H.ROOT, 'scripts', '_tmp_dl');   // 导出文件复制回来给页面 fetch（HTTP 服务只暴露仓库根）
const T0 = Date.now();
const mark = (s) => console.log('  · [' + String(Date.now() - T0).padStart(6) + 'ms] ' + s);

/** 用 PowerShell 读 ZIP 条目（node 无内置 zip） */
function zipEntries(zipPath) {
  const ps = `Add-Type -AssemblyName System.IO.Compression.FileSystem; $z=[System.IO.Compression.ZipFile]::OpenRead('${zipPath.replace(/'/g, "''")}'); $z.Entries | ForEach-Object { $_.FullName + '|' + $_.Length }; $z.Dispose();`;
  return cp.execFileSync('powershell', ['-NoProfile', '-Command', ps], { encoding: 'utf8' }).trim().split(/\r?\n/).filter(Boolean)
    .map((l) => { const i = l.lastIndexOf('|'); return { name: l.slice(0, i), size: Number(l.slice(i + 1)) }; });
}
function extractZipEntry(zipPath, name, out) {
  const ps = `Add-Type -AssemblyName System.IO.Compression.FileSystem; $z=[System.IO.Compression.ZipFile]::OpenRead('${zipPath.replace(/'/g, "''")}'); $e=$z.Entries | Where-Object { $_.FullName -eq '${name}' }; [System.IO.Compression.ZipFileExtensions]::ExtractToFile($e, '${out.replace(/'/g, "''")}', $true); $z.Dispose();`;
  cp.execFileSync('powershell', ['-NoProfile', '-Command', ps], { stdio: 'ignore' });
}
function cleanup() {
  try { fs.rmSync(TMPDL, { recursive: true, force: true }); } catch (e) {}
  try { fs.rmSync(path.join(H.ROOT, 'scripts', '_tmp_zipdata'), { recursive: true, force: true }); } catch (e) {}
}

(async () => {
  if (!fs.existsSync(ZIP)) {
    console.log('  ⏭ SKIP：未找到 ' + ZIPNAME + '（真实数据回归需要本地保留该备份；套件在缺失时不判失败）');
    process.exit(0);
  }
  const sizeMB = Math.round(fs.statSync(ZIP).size / 1048576 * 10) / 10;
  const h = await H.start({ port: 8176, cdpPort: 9386, view: 'realdata' });
  fs.mkdirSync(TMPDL, { recursive: true });
  try {
    await h.nav('index.html?v=realdata');
    mark('页面加载完成');
    await h.ev(`(() => { window.confirm = () => true; return 1; })()`);

    // ---------- ① 取真实备份（页面内 fetch 仓库根的 zip） ----------
    const got = await h.ev(`(async () => {
      var t0 = Date.now();
      var r = await fetch('/' + encodeURIComponent('${ZIPNAME}'));
      if (!r.ok) return { err: 'HTTP ' + r.status };
      var b = await r.blob();
      window.__bkFile = new File([b], '${ZIPNAME}', { type: 'application/zip' });
      return { ms: Date.now() - t0, mb: Math.round(b.size / 1048576 * 10) / 10 };
    })()`, 300000);
    mark('备份文件就绪 ' + JSON.stringify(got));
    h.F(!!got && got.mb > 80, '① 真实备份可取到并构造成 File（' + (got && got.mb) + ' MB / ' + (got && got.ms) + ' ms）' + (got && got.err ? ' ← ' + got.err : ''));

    // ---------- ② 触发恢复 → 预览确认弹窗应显示真实条数 ----------
    const preview = await h.ev(`(async () => {
      var captured = null, oc = document.createElement.bind(document);
      document.createElement = function (t) { var el = oc(t); if (String(t).toLowerCase() === 'input' && !captured) captured = el; return el; };
      try { window.oneClickRestore(); } catch (e) { document.createElement = oc; return { err: 'call:' + e.message }; }
      document.createElement = oc;
      if (!captured) return { err: '未捕获 input' };
      captured.click = function () {};
      captured.onchange({ target: { files: [window.__bkFile], value: '' } });   // 不 await：恢复在后台跑
      for (var i = 0; i < 800; i++) {          // 最多 200 秒（含 88MB JSON 解析）
        var mask = Array.prototype.find.call(document.querySelectorAll('.modal.active'), function (m) { return /确认恢复本机数据/.test(m.textContent || ''); });
        if (mask) return { text: (mask.textContent || '').replace(/\\s+/g, ' ').slice(0, 700) };
        var lab = document.getElementById('global-progress-label');
        if (lab && /失败/.test(lab.textContent || '')) return { err: '恢复提前失败：' + lab.textContent };
        await new Promise(r => setTimeout(r, 250));
      }
      return { err: '预览弹窗未出现', toast: (document.getElementById('global-toast-host') || {}).textContent || '' };
    })()`, 300000);
    mark('恢复预览弹窗出现');
    const pv = String(preview.text || '');
    h.F(/43585/.test(pv) && /1305/.test(pv) && /839/.test(pv) && /2047/.test(pv),
      '② 恢复预览准确显示真实条数（检查信息 43585 / 手册 1305 / 电话 839 / 术语 2047）' + (preview.err ? ' ← ' + preview.err : ''));

    // ---------- ③ 确认恢复 → 采集进度时间线 ----------
    const tl = await h.ev(`(async () => {
      var mask = Array.prototype.find.call(document.querySelectorAll('.modal.active'), function (m) { return /确认恢复本机数据/.test(m.textContent || ''); });
      if (!mask) return { err: '无确认弹窗' };
      var ok = mask.querySelector('[data-act="ok"]'); if (!ok) return { err: '无「确认恢复」按钮' };
      var logs = [], t0 = Date.now(), last = '';
      ok.click();
      for (var i = 0; i < 2000; i++) {          // 最多 500 秒
        var lab = document.getElementById('global-progress-label');
        var fill = document.getElementById('global-progress-fill');
        var s = (lab ? lab.textContent : '') + ' | ' + (fill ? fill.style.width : '');
        if (s !== last) { if (logs.length) logs[logs.length - 1].dur = Date.now() - t0 - logs[logs.length - 1].t; logs.push({ t: Date.now() - t0, s: s }); last = s; }
        if (/恢复完成/.test(s) || /失败/.test(s)) break;
        await new Promise(r => setTimeout(r, 250));
      }
      return { logs: logs.map(function (l) { return (l.t / 1000).toFixed(1) + 's ' + l.s + (l.dur ? '  (耗时 ' + (l.dur / 1000).toFixed(1) + 's)' : ''); }), total: Date.now() - t0, done: /恢复完成/.test(last), fail: /失败/.test(last) };
    })()`, 660000);
    mark('恢复结束');
    console.log('    恢复进度时间线（关键节点）：');
    (tl.logs || []).forEach((l) => console.log('      ' + l));
    h.F(tl.done && !tl.fail, '③ 恢复跑到 100% 无失败（总耗时 ' + Math.round((tl.total || 0) / 1000) + 's）' + (tl.err ? ' ← ' + tl.err : ''));

    // ---------- ④ 页面自动刷新 → 数据持久化校验 ----------
    await h.sleep(5000);   // 恢复里 1s + 2s 后 reload
    let ready = false;
    for (let i = 0; i < 150 && !ready; i++) {   // 最多 120s（4 万条从 SQLite 载入）
      try { const r = await h.ev(`(document.readyState === 'complete' && typeof window.getIssueData === 'function') ? 1 : 0`, 10000); if (r === 1) ready = true; } catch (e) {}
      if (!ready) await h.sleep(800);
    }
    mark('刷新后页面就绪');
    const after = await h.ev(`(async () => {
      var arr = function (f) { try { return (typeof window[f] === 'function' ? window[f]() : []) || []; } catch (e) { return []; } };
      var out = {};
      out.phone = arr('getPhoneData').length;
      out.handbook = arr('getHandbookData').length;
      out.diary = arr('getDiaryData').length;
      out.issue = arr('getIssueData').length;
      out.term = (window.PATCH_TERM_LIBRARY || []).length;
      out.diaryMediaRefs = arr('getDiaryData').filter(function (d) { return d && d.mediaIds && d.mediaIds.length; }).length;
      try { out.wmat = await window.getWrMatCount(); } catch (e) { out.wmat = -1; }
      try { out.wrrpt = await window.getWrRptCount(); } catch (e) { out.wrrpt = -1; }
      // 多媒体：数 IndexedDB 里恢复出来的附件（引用条数 ≠ 文件数），并按 diary.js:1113 的口径
      // 「new Blob([record.blob])」量实际字节 + 校验 JPEG 魔数（0xFFD8）—— 只数条数看不出"空壳附件"。
      out.mediaCount = await new Promise(function (res) {
        var rq = indexedDB.open('DiaryMediaDB');
        rq.onsuccess = function () {
          var db = rq.result;
          if (!db.objectStoreNames.contains('media')) { res('no-store'); return; }
          var all = db.transaction('media', 'readonly').objectStore('media').getAll();
          all.onsuccess = function () {
            var rows = all.result || [];
            var bytes = 0, jpeg = 0;
            Promise.all(rows.map(function (r) {
              var b = new Blob([r.blob || new ArrayBuffer(0)], { type: r.type || 'image/jpeg' });
              bytes += b.size;
              return b.slice(0, 2).arrayBuffer().then(function (ab) {
                var u = new Uint8Array(ab);
                if (u[0] === 0xFF && u[1] === 0xD8) jpeg++;
              }).catch(function () {});
            })).then(function () {
              res(rows.length + '/' + Math.round(bytes / 1024) + 'KB/' + jpeg + 'jpg');
            });
          };
          all.onerror = function () { res('err'); };
        };
        rq.onerror = function () { res('open-err'); };
      });
      out.lsKeys = ['railway_phone_db_v1', 'handbook_fourlevel_v1', 'patch_term_library_v2', 'railway_work_diary_v2', 'ds_conversations_v1'].filter(function (k) { return !!localStorage.getItem(k); });
      return out;
    })()`, 180000);
    mark('落库条数读取 ' + JSON.stringify(after));
    h.F(ready, '④ 恢复后页面自动刷新并恢复就绪');
    h.F(after.issue === EXPECT.issues && after.handbook === EXPECT.handbook && after.phone === EXPECT.phone && after.term >= EXPECT.term && after.diary === EXPECT.diary,
      '⑤ 恢复落库条数与备份一致（检查信息 ' + after.issue + '/' + EXPECT.issues + '，手册 ' + after.handbook + '，电话 ' + after.phone + '，术语 ' + after.term + '，日志 ' + after.diary + '）');
    h.F(after.wmat === EXPECT.wmat && after.wrrpt === EXPECT.wrrpt, '⑥ 写作资料/历史报告恢复正确（资料 ' + after.wmat + '/' + EXPECT.wmat + '，报告 ' + after.wrrpt + '/' + EXPECT.wrrpt + '）');
    const mediaKb = Number(String(after.mediaCount).split('/')[1].replace('KB', ''));
    h.F(String(after.mediaCount).startsWith(EXPECT.media + '/') && mediaKb > 1500 && /\/2jpg$/.test(String(after.mediaCount)) && after.lsKeys.length === 5,
      '⑦ 多媒体附件真实还原且非空壳（媒体库 ' + after.mediaCount + ' 应 2 张 / >1.5MB / 2 张 JPEG，键 ' + after.lsKeys.length + ' 个）');

    // ---------- ⑧ 用真实数据再导出（往返一致） ----------
    const b1 = Date.now();
    const bkFile = await h.grab(`window.oneClickBackup()`, 420000);
    const bkMs = Date.now() - b1;
    mark('备份导出落盘 ' + bkFile);
    let bkEntries = [], bkCounts = null;
    if (bkFile) {
      bkEntries = zipEntries(path.join(h.DL, bkFile));
      extractZipEntry(path.join(h.DL, bkFile), 'full_backup.json', path.join(TMPDL, '_out_backup.json'));
      const b = JSON.parse(fs.readFileSync(path.join(TMPDL, '_out_backup.json'), 'utf8'));
      bkCounts = { issues: (b.modules.issues || []).length, handbook: (b.modules.handbook || []).length, phone: (b.modules.phone || []).length, term: (b.modules.termLibrary || []).length,
        wmat: (b.modules.writingMaterials || []).length, wrrpt: (b.modules.writingReports || []).length, conv: (b.modules.dsConversations || []).length };
    }
    h.F(!!bkFile && bkEntries.some((e) => e.name === 'full_backup.json') && bkEntries.filter((e) => /^media\//.test(e.name) && e.size > 0).length === EXPECT.media,
      '⑧ 全量备份导出成功（' + (bkFile || '未生成') + '，含 full_backup.json + ' + EXPECT.media + ' 张媒体，耗时 ' + Math.round((Date.now() - b1) / 1000) + 's）');
    h.F(!!bkCounts && bkCounts.issues === EXPECT.issues && bkCounts.handbook === EXPECT.handbook && bkCounts.phone === EXPECT.phone && bkCounts.term === EXPECT.term,
      '⑨ 往返一致：导出的备份条量与恢复前完全相同 → ' + JSON.stringify(bkCounts));

    // ---------- ⑩ 单模块真实往返：电话导出 → 追加导入（组合键去重，条数不涨也不掉） ----------
    await h.ev(`(() => { window.showChoiceModal = async () => 'append'; return 1; })()`);
    const pf = await h.grab(`phoneExportJSON()`, 60000);
    let back = null;
    if (pf) {
      fs.copyFileSync(path.join(h.DL, pf), path.join(TMPDL, 'phone_back.json'));
      back = await h.ev(`(async () => {
        var before = window.getPhoneData().length;
        var txt = await (await fetch('/scripts/_tmp_dl/phone_back.json')).text();
        var inp = document.getElementById('phone-fileInput');   // 真实入口（隐藏 input + change 事件）
        var dt = new DataTransfer();
        dt.items.add(new File([txt], 'phone_back.json', { type: 'application/json' }));
        inp.files = dt.files;
        inp.dispatchEvent(new Event('change', { bubbles: true }));
        for (var i = 0; i < 120; i++) { await new Promise(function (r2) { setTimeout(r2, 250); }); if (window.getPhoneData().length !== before) break; }
        return { before: before, after: window.getPhoneData().length };
      })()`, 120000);
    }
    h.F(!!back && back.after === back.before && back.after === EXPECT.phone,
      '⑩ 电话「导出 → 追加导入」往返条数不变（' + (back ? back.before + ' → ' + back.after : '未执行') + '，应仍为 ' + EXPECT.phone + '；含 ' + '无站名记录不翻倍 + 同名站记录不合并' + '）');

    // ---------- ⑪ 4 万条检查信息导出（真实体量下不失败） ----------
    const i1 = Date.now();
    const ifile = await h.grab(`issueExportJSON()`, 300000);
    const iMB = ifile ? Math.round(fs.statSync(path.join(h.DL, ifile)).size / 1048576 * 10) / 10 : -1;
    let iOk = false;
    if (ifile) { try { const j = JSON.parse(fs.readFileSync(path.join(h.DL, ifile), 'utf8')); iOk = (Array.isArray(j) ? j.length : (j.data || j.issues || []).length) === EXPECT.issues; } catch (e) {} }
    h.F(!!ifile && iMB > 0 && iOk, '⑪ 4 万条检查信息导出成功且条数正确（' + (ifile || '未生成') + '，' + iMB + ' MB，' + Math.round((Date.now() - i1) / 1000) + 's）');

    h.F(h.pageErrors.length === 0, '⑫ 真实数据全流程无未捕获页面异常' + (h.pageErrors[0] ? ' ← ' + h.pageErrors[0] : ''));
    h.F(h.dialogs.length === 0, '⑬ 真实数据全流程无阻塞式弹窗（手机端最怕这类"点完没反应"）' + (h.dialogs.length ? ' ← ' + h.dialogs.slice(0, 2).join(' / ') : ''));
    console.log('    数据规模：' + sizeMB + ' MB 备份 / 恢复 ' + Math.round((tl.total || 0) / 1000) + 's / 再导出 ' + Math.round(bkMs / 1000) + 's');
  } catch (e) {
    h.F(false, '真实数据回归异常：' + (e && e.message));
    console.log(e && e.stack);
  }
  cleanup();
  h.done();
})();
