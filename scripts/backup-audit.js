#!/usr/bin/env node
/**
 * 审计套件 · 备份导出与恢复往返（覆盖此前**无人看守**的盲区）
 * ------------------------------------------------------------------
 * 曾真实发生过的缺陷都固化在这里：
 *   ① 媒体附件改为 ZIP 内独立条目 media/<id>.<ext>，JSON 不再内嵌 base64（体积 +33% / 手机端易失败）
 *   ② 恢复必须**不中断**：历史上因 `writeIndexedDB` 无条件删 id 再 add()，遇到非自增主键 store
 *      （DiaryMediaDB/media）会抛 "key path did not yield a value" → 整次恢复失败
 *   ③ 恢复往返要**按原字节数**还原附件（[1500, 2500]）
 *   ④ 恢复完成后自动 reload，必须能正常回到页面（无未捕获异常）
 * 退出码：0 全通过 / 1 有失败。用法：node scripts/backup-audit.js
 */
'use strict';
const path = require('path');
const fs = require('fs');
const H = require('./audit-harness');

(async () => {
  const h = await H.start({ port: 8162, cdpPort: 9372, view: 'backup' });
  console.log('==== 备份 / 恢复审计 ====');
  try {
    await h.nav('index.html?v=backup');
    await h.ev(`(() => { window.confirm = () => true; window.showChoiceModal = async () => 'overwrite'; return 1; })()`);

    // ---------- 种两个附件（写入 DiaryMediaDB.media）----------
    const seeded = await h.ev(`(async () => new Promise(function (res) {
      var rq = indexedDB.open('DiaryMediaDB', 1);
      rq.onupgradeneeded = function () { var d = rq.result; if (!d.objectStoreNames.contains('media')) d.createObjectStore('media', { keyPath: 'id' }); };
      rq.onsuccess = function () {
        var tx = rq.result.transaction('media', 'readwrite'); var os = tx.objectStore('media');
        os.put({ id: 9001, type: 'image/jpeg', captureTime: '2026-09-21 10:00', blob: new Uint8Array(1500).fill(7).buffer });
        os.put({ id: 9002, type: 'image/png', captureTime: '2026-09-21 10:05', blob: new Uint8Array(2500).fill(9).buffer });
        tx.oncomplete = function () { res('ok'); }; tx.onerror = function () { res('ERR'); };
      }; rq.onerror = function () { res('ERR'); };
    }))()`);
    h.F(seeded === 'ok', '① 种入 2 个日志附件（1500B / 2500B）');

    // ---------- 导出备份 ----------
    const zipName = await h.grab(`oneClickBackup()`, 60000);
    h.F(!!zipName && /\.zip$/.test(zipName), '② 备份 ZIP 真实落盘 → ' + (zipName || '(未生成)'));

    let mediaPaths = [], base64Len = -1;
    if (zipName) {
      const JSZip = require(path.join(h.ROOT, 'src/js/vendor/jszip.min.js'));
      const z = await JSZip.loadAsync(fs.readFileSync(path.join(h.DL, zipName)));
      mediaPaths = Object.keys(z.files).filter((n) => /^media\/.+\.(jpg|png|webp|gif|mp4|webm|mp3|wav|mov)$/.test(n));
      const j = JSON.parse(await z.file('full_backup.json').async('string'));
      base64Len = ((j.modules || {}).diaryMedia || []).reduce((a, m) => a + String(m.blobBase64 || '').length, 0);
    }
    h.F(mediaPaths.length === 2, '③ 媒体以独立条目入 ZIP（' + mediaPaths.length + ' 个：' + mediaPaths.join(', ') + '）');
    h.F(base64Len === 0, '④ full_backup.json 不再内嵌 base64（实测长度 ' + base64Len + '）');

    // ---------- 清空附件库 → 从该 ZIP 恢复 ----------
    await h.ev(`(async () => new Promise(function (res) { var rq = indexedDB.open('DiaryMediaDB', 1);
      rq.onsuccess = function () { var tx = rq.result.transaction('media', 'readwrite'); tx.objectStore('media').clear(); tx.oncomplete = function () { res('cleared'); }; }; }))()`);
    const zipB64 = zipName ? fs.readFileSync(path.join(h.DL, zipName)).toString('base64') : '';
    await h.nav('index.html?v=backup-restore');
    await h.ev(`window.__zipB64 = ${JSON.stringify(zipB64)}; window.confirm = () => true;
      try { var _st = window.showToast; window.showToast = function (m) { try { localStorage.setItem('__bklog', String(m).slice(0, 200)); } catch (e) {} return _st.apply(null, arguments); }; } catch (e) {}
      'ok'`);
    // oneClickRestore 内部用模块私有 triggerFileInput → 捕获它创建的 input 再喂文件
    const started = await h.ev(`(() => {
      var captured = null; var oc = document.createElement.bind(document);
      document.createElement = function (t) { var el = oc(t); if (String(t).toLowerCase() === 'input' && !captured) captured = el; return el; };
      try { oneClickRestore(); } catch (e) { try { localStorage.setItem('__bklog', 'driver:' + e.message); } catch (e2) {} }
      document.createElement = oc;
      if (!captured) return 'no-input';
      captured.click = function () {};
      (async () => {
        try {
          var bin = atob(window.__zipB64); var u8 = new Uint8Array(bin.length);
          for (var i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
          var dt = new DataTransfer(); dt.items.add(new File([u8], 'backup.zip', { type: 'application/zip' }));
          captured.files = dt.files;
          captured.dispatchEvent(new Event('change', { bubbles: true }));
          var w = 0;
          while (w < 120) { var ok = document.querySelector('.modal.active [data-act="ok"]'); if (ok) { ok.click(); break; } await new Promise(r => setTimeout(r, 150)); w++; }
        } catch (e) { try { localStorage.setItem('__bklog', 'drive:' + e.message); } catch (e2) {} }
      })();
      return 'started';
    })()`);
    h.F(started === 'started', '⑤ 恢复流程已启动（预览确认弹窗自动确认）');

    // ---------- 等恢复 + 自动 reload 完成后校验附件 ----------
    let media = [];
    for (let i = 0; i < 60; i++) {
      await h.sleep(500);
      media = await h.ev(`(async () => (await new Promise(function(res){ var rq=indexedDB.open('DiaryMediaDB',1);
        rq.onsuccess=function(){ var out=[]; var c=rq.result.transaction('media','readonly').objectStore('media').openCursor();
          c.onsuccess=function(e){ var cur=e.target.result; if(cur){ out.push({id:cur.value.id, bytes:(cur.value.blob&&cur.value.blob.byteLength)||0}); cur.continue(); } else res(out); }; }; })))()`).catch(() => []);
      if (media && media.length) break;
    }
    const sizes = (media || []).map((m) => m.bytes).sort((a, b) => a - b);
    const log = await h.ev(`localStorage.getItem('__bklog')`).catch(() => '(未读到)');
    h.F(sizes.length === 2 && sizes[0] === 1500 && sizes[1] === 2500,
      '⑥ 恢复往返成功：2 个附件按原字节数还原（' + JSON.stringify(sizes) + '，最近提示=' + JSON.stringify(log) + '）');
    h.F(!/恢复失败/.test(String(log)), '⑦ 恢复过程未报「恢复失败」（历史缺陷：非自增主键导致整次恢复中断）');
    h.F(h.dialogs.length === 0, '全程无阻塞式 alert/confirm');
  } catch (e) {
    h.F(false, '套件执行异常：' + (e && e.message));
  }
  h.done();
})();
