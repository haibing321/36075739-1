/**
 * 写作资料列表审计（常驻套件）
 * ===================================================
 * 钉住**用户明确要求**的资料列表展示规则（v3.86 ~ v3.88）：
 *   1) 资料一律**按生成/导入时间倒序**，最近的在最上面（时间取不到 → 排最后）；
 *   2) 同一批资料**按类型（来源）分块**，块内仍是时间倒序；
 *   3) 顶部「按类型 / 按时间」切换：「按时间」= 纯时间倒序、不分块；
 *   4) 组头**可点击折叠**；块内超过 10 条时默认只展开最新 10 条 + 「展开全部」。
 * 覆盖四个列表（都是用户天天看的）：
 *   ① 资料库主列表 `wrRenderMaterials`
 *   ② 全模块数据视图 `wrRenderMaterialCenter`（按来源分块）
 *   ③ 写作流程的资料库选择层（真实入口：wrStepAddMenu → 「📚 资料库」）
 *   ④ 对话里的「写作资料库」弹窗 `dsRenderMaterialList`（含类型筛选）
 *
 * 用法：node scripts/writer-list-audit.js
 */
'use strict';
const H = require('./audit-harness');

const SEED = `(async () => {
  var db = await new Promise(function (res, rej) { var r = indexedDB.open('railway_writer_db'); r.onsuccess = function () { res(r.result); }; r.onerror = function () { rej(r.error); }; });
  var put = function (store, rec) { return new Promise(function (res) { var t = db.transaction(store, 'readwrite'); t.objectStore(store).put(rec); t.oncomplete = function () { res(1); }; t.onerror = function () { res(0); }; }); };
  var D = function (s) { return Date.parse(s); };
  var rows = [
    { id: 101, title: 'I旧_检查信息', matType: 'inspect',  content: 'x', createdAt: D('2026-09-01T08:00:00') },
    { id: 102, title: 'I新_检查信息', matType: 'inspect',  content: 'x', createdAt: D('2026-09-20T08:00:00') },
    { id: 103, title: 'D_通报文电',   matType: 'dispatch', content: 'x', createdAt: D('2026-09-10T08:00:00') },
    { id: 104, title: 'F_故障报告',   matType: 'fault',    content: 'x', date: '2026-08-15' },
    { id: 105, title: 'T_写作模版',   matType: 'template', content: 'x', createdAt: D('2026-09-19T08:00:00') },
    { id: 106, title: 'O旧_其它',     matType: 'other',    content: 'x', importAt: D('2026-09-02T08:00:00') },
    { id: 107, title: 'O新_其它',     matType: 'other',    content: 'x', importAt: D('2026-09-18T08:00:00') },
    { id: 108, title: 'O无时间_其它', matType: 'other',    content: 'x' }
  ];
  // 再种 12 条同类（stats），用来验证"块内默认只展开最新 10 条 + 展开全部"
  for (var j = 1; j <= 12; j++) {
    rows.push({ id: 200 + j, title: 'S' + (j < 10 ? '0' + j : j) + '_故障统计', matType: 'stats', content: 'x',
                createdAt: D('2026-07-' + (j < 10 ? '0' + j : j) + 'T08:00:00') });
  }
  for (var i = 0; i < rows.length; i++) await put('writing_materials', rows[i]);
  return rows.length;
})()`;

const CLEAN = `(async () => {
  var db = await new Promise(function (res) { var r = indexedDB.open('railway_writer_db'); r.onsuccess = function () { res(r.result); }; r.onerror = function () { res(null); }; });
  if (!db) return 0;
  var ids = [];
  for (var id = 101; id <= 108; id++) ids.push(id);
  for (var j = 1; j <= 12; j++) ids.push(200 + j);
  for (var i = 0; i < ids.length; i++) {
    await new Promise(function (res) { try { var t = db.transaction('writing_materials', 'readwrite'); t.objectStore('writing_materials').delete(ids[i]); t.oncomplete = function () { res(1); }; t.onerror = function () { res(0); }; } catch (e) { res(0); } });
  }
  return 1;
})()`;

const READ_LIST = `(function (hostId) {
  var host = document.getElementById(hostId);
  if (!host) return { heads: [], titles: [], groups: 0 };
  var heads = [], titles = [];
  Array.prototype.forEach.call(host.children, function (el) {
    if (el.classList && el.classList.contains('wr-mat-card')) {
      var d = el.querySelector('div[style*="flex:1"]');
      var ti = d && d.querySelector('div');
      titles.push(ti ? ti.textContent.trim() : '');
    } else {
      var t = (el.textContent || '').trim();
      if (/条$/.test(t) && t.length < 30) heads.push(t);
    }
  });
  return { heads: heads, titles: titles, groups: host.querySelectorAll('[data-wr-group]').length };
})`;

/** 读某个块内的卡片数 + 是否有「展开全部」 */
const READ_GROUP = `(function (key) {
  var host = document.getElementById('wr-mat-list');
  if (!host) return { err: 'no-host' };
  var head = host.querySelector('[data-wr-group="' + key + '"]');
  if (!head) return { err: 'no-head' };
  var cards = 0, more = '', el = head.nextElementSibling;
  while (el && !(el.classList && el.classList.contains('wr-mat-group-head'))) {
    if (el.classList && el.classList.contains('wr-mat-card')) cards++;
    var b = el.querySelector ? el.querySelector('[data-wr-expand]') : null;
    if (b) more = b.textContent.trim();
    el = el.nextElementSibling;
  }
  return { cards: cards, more: more };
})`;

(async () => {
  const h = await H.start({ port: 8188, cdpPort: 9398, view: 'wrlist' });
  try {
    await h.nav('index.html?v=wrlist');
    const seeded = await h.ev(SEED, 60000);
    h.F(seeded === 20, '① 已种入 20 条资料（8 种时间形态/类型 + 12 条同类用于预览）');

    // 统一初始状态：按类型 + 不折叠（否则上一轮残留的 localStorage 会影响断言）
    await h.ev(`(() => {
      try { localStorage.removeItem('wr_list_collapsed'); localStorage.setItem('wr_list_mode', 'type'); } catch (e) {}
      window._wrListMode = 'type'; window._wrListCollapsed = {}; window._wrListExpanded = {};
      return 1;
    })()`, 20000);

    // ---------- ① 资料库主列表 ----------
    const main = await h.ev(`(async () => {
      window.wrMaterialFilter('all');
      await new Promise(function (r) { setTimeout(r, 1000); });
      return ${READ_LIST}('wr-mat-list');
    })()`, 60000);
    const t = main.titles, idx = (arr, s) => arr.findIndex((x) => x.indexOf(s) >= 0);
    h.F(main.heads.length >= 4, '② 资料库主列表按类型分块（' + main.heads.length + ' 块：' + main.heads.join(' / ') + '）');
    h.F(idx(t, 'I新') >= 0 && idx(t, 'I新') < idx(t, 'I旧'), '③ 块内时间倒序（检查信息：09-20 在 09-01 之前）');
    h.F(idx(t, 'O无时间') > idx(t, 'O新') && idx(t, 'O无时间') > idx(t, 'O旧'), '④ 时间取不到的排同块最后');

    // ---------- ③ 块内预览：12 条同类默认只显示 10 条 ----------
    const g1 = await h.ev(READ_GROUP + '("stats")', 30000);
    h.F(g1.cards === 10 && /展开全部/.test(g1.more || ''), '⑤ 块内默认只展开最新 10 条（' + g1.cards + ' 条 + 「' + (g1.more || '') + '」）');
    const g2 = await h.ev(`(async () => {
      var b = document.querySelector('[data-wr-expand="stats"]');
      if (!b) return { err: 'no-button' };
      b.click();
      await new Promise(function (r) { setTimeout(r, 700); });
      return ${READ_GROUP}('stats');
    })()`, 30000);
    h.F(g2.cards === 12 && !g2.more, '⑥ 点「展开全部」后 12 条都显示（' + g2.cards + ' 条）');

    // ---------- ④ 折叠 / 展开展开 ----------
    const g3 = await h.ev(`(async () => {
      document.querySelector('[data-wr-group="inspect"]').click();
      await new Promise(function (r) { setTimeout(r, 700); });
      var a = ${READ_GROUP}('inspect');
      document.querySelector('[data-wr-group="inspect"]').click();
      await new Promise(function (r) { setTimeout(r, 700); });
      var b = ${READ_GROUP}('inspect');
      return { collapsed: a.cards, reopened: b.cards };
    })()`, 40000);
    h.F(g3.collapsed === 0 && g3.reopened === 2, '⑦ 点组头可折叠/展开（折叠后 ' + g3.collapsed + ' 条 → 再点 ' + g3.reopened + ' 条）');

    // ---------- ⑤ 「按时间」模式：不分块、纯时间倒序 ----------
    const tm = await h.ev(`(async () => {
      window.wrSetListMode('time');
      await new Promise(function (r) { setTimeout(r, 900); });
      var out = ${READ_LIST}('wr-mat-list');
      window.wrSetListMode('type');
      await new Promise(function (r) { setTimeout(r, 900); });
      var back = ${READ_LIST}('wr-mat-list');
      return { time: out, backGroups: back.groups };
    })()`, 60000);
    h.F(tm.time.groups === 0, '⑧ 「按时间」模式不分块（组头 ' + tm.time.groups + ' 个）');
    h.F((tm.time.titles[0] || '').indexOf('I新') === 0, '⑨ 「按时间」模式按时间倒序（首条 = 09-20 的最新资料）');
    h.F(tm.backGroups >= 4, '⑩ 切回「按类型」恢复分块（' + tm.backGroups + ' 块）');

    // ---------- ② 全模块数据视图 ----------
    const center = await h.ev(`(async () => {
      window.wrRenderMaterialCenter('all');
      await new Promise(function (r) { setTimeout(r, 1500); });
      return ${READ_LIST}('wr-mat-list');
    })()`, 60000);
    h.F(center.heads.some((x) => /写作资料/.test(x)), '⑪ 全模块视图按来源分块（' + center.heads.join(' / ') + '）');
    const ct = center.titles;
    h.F(idx(ct, 'I新') < idx(ct, 'I旧'), '⑫ 全模块视图块内时间倒序');

    // ---------- ③ 写作流程的资料库选择层（真实入口）----------
    const lib = await h.ev(`(async () => {
      window._wrAllMats = (await window._wrGetAllMaterials()).sort(window.wrByTimeDesc);   // 生产路径同款
      window.wrStepAddMenu('material', document.body);
      var item = document.querySelector('#wr-step-add-menu .wr-step-menu-item[data-src="lib"]');
      if (!item) return { err: '菜单里没有「资料库」项' };
      item.click();
      await new Promise(function (r) { setTimeout(r, 500); });
      var box = document.getElementById('wr-step-lib');
      if (!box) return { err: '选择层没打开' };
      var heads = [], rows = [];
      Array.prototype.forEach.call(box.querySelectorAll('div'), function (d) {
        var s = (d.textContent || '').trim();
        if (d.children.length === 0 && /条$/.test(s) && s.length < 24) heads.push(s);
      });
      Array.prototype.forEach.call(box.querySelectorAll('label.wr-step-lib-row'), function (l) {
        var sp = l.querySelector('span');
        rows.push(sp ? sp.textContent.trim() : '');
      });
      box.remove();
      return { heads: heads, rows: rows };
    })()`, 60000);
    h.F(!lib.err && (lib.heads || []).length >= 2, '⑬ 写作选择层按类型分块' + (lib.err ? '（' + lib.err + '）' : '（' + lib.heads.length + ' 块）'));
    h.F(idx(lib.rows || [], 'I新') < idx(lib.rows || [], 'I旧'), '⑭ 写作选择层块内时间倒序');

    // ---------- ④ 对话里的「写作资料库」弹窗 + 类型筛选 ----------
    const ds = await h.ev(`(async () => {
      window._dsMaterialCache = await window._wrGetAllMaterials();
      var sel = document.getElementById('ds-material-type-filter');
      if (sel) sel.value = '';
      window.dsFilterMaterials();
      await new Promise(function (r) { setTimeout(r, 400); });
      var list = document.getElementById('ds-material-list');
      var heads = [], rows = [];
      Array.prototype.forEach.call(list.children, function (el) {
        var s = (el.textContent || '').trim().replace(/\\s+/g, ' ');
        if (el.tagName === 'LABEL') rows.push(s.slice(0, 24));
        else if (/条$/.test(s)) heads.push(s);
      });
      if (sel) sel.value = 'dispatch';
      window.dsFilterMaterials();
      await new Promise(function (r) { setTimeout(r, 300); });
      var filtered = Array.prototype.map.call(document.getElementById('ds-material-list').querySelectorAll('label'), function (l) {
        return (l.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 24);
      });
      return { heads: heads, rows: rows, filtered: filtered };
    })()`, 60000);
    h.F(ds.heads.length >= 2, '⑮ 对话「写作资料库」弹窗按类型分块（' + ds.heads.length + ' 块）');
    h.F(ds.rows.length > 0 && ds.rows.every((r) => !/📎 资料 /.test(r)), '⑯ 弹窗类型标签正确（不是清一色"📎 资料"）');
    h.F(ds.filtered.length === 1 && /通报文电/.test(ds.filtered[0]), '⑰ 弹窗类型筛选可用（筛"通报文电"只剩 1 条）');
    h.F(idx(ds.rows, 'I新') < idx(ds.rows, 'I旧'), '⑱ 弹窗块内时间倒序');

    await h.ev(CLEAN, 30000);   // 收尾清理，保证可重复跑
  } catch (e) {
    h.F(false, '套件异常：' + (e && e.message));
  }
  h.done();
  process.exit(0);
})();
