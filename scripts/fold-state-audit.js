/**
 * 折叠屏开合 · 界面保持审计 —— 常驻套件
 * ======================================
 * 用户诉求：折叠屏开合时界面要"保持住"（别回到默认态、别丢正在写的内容、别丢阅读位置）。
 *
 * 两条真实路径都要测：
 *   路径 A｜**不重载的开合**（多数折叠屏）：窗口尺寸/方向突变 → 界面原样保持，且不产生任何网络请求。
 *   路径 B｜**浏览器重建文档**（部分折叠屏/内存回收会重新加载页面）：
 *         依赖 page-state 的 sessionStorage 快照还原（module / 主滚动 / 内层阅读位置 / 草稿 / 弹窗 / 子视图 / 分类筛选）。
 *
 * 用法：node scripts/fold-state-audit.js
 */
'use strict';
const H = require('./audit-harness');
const PORT = 8193, CDP = 9393;

const SEED = `(async () => {
  var db = await new Promise(function (res, rej) { var r = indexedDB.open('railway_writer_db'); r.onsuccess = function(){ res(r.result); }; r.onerror = function(){ rej(r.error); }; });
  var put = function (store, obj) { return new Promise(function (res) { var t = db.transaction(store, 'readwrite'); t.objectStore(store).put(obj); t.oncomplete = function(){ res(); }; }); };
  var D = function (s) { return Date.parse(s); };
  var rows = [];
  for (var i = 0; i < 40; i++) rows.push({ id: 300 + i, title: 'F' + (i < 10 ? '0' + i : i) + '_故障报告', matType: 'fault', content: '故障内容' + i, createdAt: D('2026-09-0' + (i % 9 + 1) + 'T08:00:00') });
  for (var j = 0; j < rows.length; j++) await put('writing_materials', rows[j]);
  return rows.length;
})()`;

/** 页面内工具：滚动容器查找（与 page-state._findScroller 同口径：先向上找，再退化为向下找） */
const HELP = `(function(){
  window.__pickScroller = function (root) {
    if (!root) return null;
    var list = [root].concat(Array.prototype.slice.call(root.querySelectorAll('*')));
    for (var i = 0; i < list.length; i++) {
      var el = list[i];
      try { var cs = getComputedStyle(el); if (/(auto|scroll)/.test(cs.overflowY) && el.scrollHeight > el.clientHeight + 20) return el; } catch (e) {}
    }
    return null;
  };
  window.__findScroller = function (node) {
    var el = node;
    while (el && el !== document.body && el !== document.documentElement) {
      try { var cs = getComputedStyle(el); if (/(auto|scroll)/.test(cs.overflowY) && el.scrollHeight > el.clientHeight + 20) return el; } catch (e) {}
      el = el.parentElement;
    }
    return window.__pickScroller(node);
  };
  window.__probe = function () {
    var chip = document.getElementById('wr-mat-filter-fault');
    var modal = document.getElementById('rule-fullViewModal');
    var sc = window.__findScroller(document.getElementById('panel-material'));
    var rootTop = 0;
    try { rootTop = window.scrollY || (document.scrollingElement && document.scrollingElement.scrollTop) || 0; } catch (e) {}
    var innerTop = sc ? sc.scrollTop : 0;
    return {
      panelActive: (document.querySelector('.panel.active') || {}).id || '',
      chipFault: !!(chip && chip.classList.contains('wr-mat-tab-active')),
      chipAll: !!((document.getElementById('wr-mat-filter-all') || {}).classList || {}).contains('wr-mat-tab-active'),
      draft: (document.getElementById('wr-query-input') || {}).value || '',
      modalOpen: !!(modal && modal.classList.contains('active')),
      modalLen: modal ? modal.innerHTML.length : 0,
      modalScroll: (document.getElementById('probe-modal-body') || {}).scrollTop || 0,
      listCount: document.querySelectorAll('#wr-mat-list .wr-mat-card').length,
      subView: (function () { try { return localStorage.getItem('ds_sub_view') || ''; } catch (e) { return ''; } })(),
      innerScroll: innerTop,
      rootScroll: rootTop,
      readPos: innerTop > 0 ? innerTop : rootTop,                    // 统一口径：内层优先，否则算根滚动
      readKind: innerTop > 0 ? ('内层 ' + (sc && (sc.id || sc.className) || '')) : (rootTop > 0 ? '根滚动' : '(未滚动)')
    };
  };
  /** 把"阅读位置"滚到指定位置：内层容器优先，没有就让根滚动 */
  window.__setReadPos = function (y) {
    var sc = window.__findScroller(document.getElementById('panel-material'));
    if (sc) { sc.scrollTop = y; if (sc.scrollTop > 0) return 'inner'; }
    try { window.scrollTo(0, y); } catch (e) {}
    return (window.scrollY > 0) ? 'root' : 'none';
  };
  return 1;
})()`;

(async () => {
  const h = await H.start({ port: PORT, cdpPort: CDP, view: 'foldstate' });
  try {
    await h.nav('index.html?v=foldstate');
    await h.ev(HELP, 20000);
    await h.ev(`(() => {
      try { sessionStorage.removeItem('page_state_snapshot_v2'); sessionStorage.removeItem('page_state_snapshot_v1');
            localStorage.removeItem('ds_sub_view'); localStorage.removeItem('wr_mat_filter'); } catch (e) {}
      return 1;
    })()`, 20000);
    const seeded = await h.ev(SEED, 60000);
    h.F(seeded >= 40, '① 造数据：' + seeded + ' 条故障报告（超过"块内 10 条"预览阈值，可展开成长列表）');

    // ---------- 建立"丰富的界面状态" ----------
    const setup = await h.ev(`(async () => {
      if (window.switchTab) window.switchTab('material');
      await new Promise(function (r) { setTimeout(r, 700); });
      window.wrMaterialFilter('fault');
      await new Promise(function (r) { setTimeout(r, 600); });
      var more = document.querySelector('[data-wr-expand="fault"]');   // 展开全部 → 列表变长、可滚动
      if (more) { more.click(); await new Promise(function (r) { setTimeout(r, 500); }); }
      window.__readKind = window.__setReadPos(150);                    // 内层容器优先，否则根滚动
      var q = document.getElementById('wr-query-input');
      if (q) { q.value = '折叠屏保持测试草稿'; if (q.dispatchEvent) q.dispatchEvent(new Event('input', { bubbles: true })); }
      var m = document.getElementById('rule-fullViewModal');
      if (m) {
        var body = '';
        for (var i = 0; i < 120; i++) body += '<p>第 ' + (i + 1) + ' 行 正文内容用于撑高弹窗</p>';
        m.innerHTML = '<div class="modal-card"><div id="probe-modal-body" class="modal-body" style="overflow-y:auto;max-height:300px;">' + body + '</div></div>';
        m.classList.add('active');
        var ms = document.getElementById('probe-modal-body');
        if (ms) ms.scrollTop = 260;
      }
      await new Promise(function (r) { setTimeout(r, 400); });
      return window.__probe();
    })()`, 60000);
    console.log('  初始态：' + JSON.stringify(setup));
    h.F(setup.panelActive === 'panel-material' && setup.chipFault && setup.modalOpen && setup.readPos > 0 && setup.modalScroll > 0,
      '② 初始态就位（资料中心 + ⚡故障分类 + 列表展开到 ' + setup.listCount + ' 条、阅读位置 ' + setup.readPos + 'px [' + setup.readKind + '] + 弹窗滚到 ' + setup.modalScroll + 'px + 草稿已填）');

    // ---------- 路径 A：不重载的开合 ----------
    // 先等资源计数稳定：否则"折叠期间多了 1 个资源"可能是上一批模块还在加载（曾偶发过一次）
    await h.ev(`(async () => {
      var last = -1;
      for (var i = 0; i < 40; i++) {
        var n = performance.getEntriesByType('resource').length;
        if (n === last) break;
        last = n;
        await new Promise(function (r) { setTimeout(r, 150); });
      }
      return last;
    })()`, 30000);
    await h.ev(`(() => { window.__boot = Date.now(); window.__net = [];
      var of = window.fetch; window.fetch = function () { try { window.__net.push(1); } catch (e) {} return of.apply(this, arguments); };
      window.__res0 = performance.getEntriesByType('resource').length; return 1; })()`, 20000);
    await h.cdp.send('Emulation.setDeviceMetricsOverride', { width: 380, height: 760, deviceScaleFactor: 2, mobile: true }, h.sessionId);
    await h.sleep(900);
    await h.cdp.send('Emulation.setDeviceMetricsOverride', { width: 900, height: 1380, deviceScaleFactor: 2, mobile: true, screenOrientation: { type: 'landscapePrimary', angle: 90 } }, h.sessionId);
    await h.sleep(1200);
    await h.cdp.send('Emulation.clearDeviceMetricsOverride', {}, h.sessionId);
    await h.sleep(800);
    const afterA = await h.ev(`(function () {
      var p = window.__probe();
      p.sameDoc = !!window.__boot; p.net = (window.__net || []).length;
      p.res0 = window.__res0;
      var res = performance.getEntriesByType('resource');
      p.resNow = res.length;
      p.newRes = res.slice(p.res0).map(function (x) { return String(x.name).split('/').pop() + '|' + x.initiatorType; });
      return p;
    })()`, 30000);
    console.log('  开合后：' + JSON.stringify(afterA));
    h.F(afterA.sameDoc && afterA.panelActive === 'panel-material' && afterA.chipFault && afterA.draft === '折叠屏保持测试草稿' && afterA.modalOpen,
      '③ 开合（不重载）后界面保持：同一文档 + 仍在资料中心 + ⚡故障分类 + 草稿在 + 弹窗还开着');
    h.F(afterA.readPos > 0 && afterA.modalScroll > 0,
      '④ 开合后**阅读位置**保持（列表 ' + afterA.readPos + 'px [' + afterA.readKind + '] / 弹窗 ' + afterA.modalScroll + 'px）');
    // 口径：只数**真实网络资源**。空名（about:blank/内嵌空框架）、blob:/data: 不算 ——
    //   实测折叠期间偶发多出一个 `|iframe`（about:blank，应用里豆包内嵌页的占位框架），
    //   它不产生任何服务器往返，不能算"连接远程刷新"。
    const newReal = (afterA.newRes || []).filter((x) => !/^(|\s*)\|/.test(x) && !/^about:|^blob:|^data:/.test(x));
    h.F(afterA.net === 0 && newReal.length === 0,
      '⑤ 开合本身不产生任何真实网络请求（fetch ' + afterA.net + ' 次，资源 ' + afterA.res0 + '→' + afterA.resNow
      + (afterA.newRes && afterA.newRes.length ? '，新增条目：' + JSON.stringify(afterA.newRes) : '') + '）');

    // ---------- 路径 B：浏览器重建文档 ----------
    const before = await h.ev(`(function () { try { window._savePageState(); } catch (e) {} return window.__probe(); })()`, 30000);
    console.log('  重建前：' + JSON.stringify(before));
    await h.nav('index.html?v=foldstate2');
    await h.ev(HELP, 20000);
    await h.sleep(2000);
    const afterB = await h.ev(`(function () { return window.__probe(); })()`, 40000);
    console.log('  重建后：' + JSON.stringify(afterB));
    h.F(afterB.panelActive === 'panel-material', '⑥ 重建后回到原来的模块（' + afterB.panelActive + '）');
    h.F(afterB.draft === '折叠屏保持测试草稿', '⑦ 重建后草稿仍在（"' + afterB.draft + '"）');
    h.F(afterB.modalOpen && afterB.modalLen > 100, '⑧ 重建后弹窗还原且有内容（' + afterB.modalLen + ' 字节）');
    h.F(afterB.chipFault && !afterB.chipAll, '⑨ 重建后**资料中心分类筛选**保持（⚡ 故障报告）；修复前会打回「全部」');
    h.F(afterB.readPos > 0, '⑩ 重建后列表**滚动位置**还原（' + afterB.readPos + 'px [' + afterB.readKind + ']）；修复前根滚动从不保存、归 0');
    h.F(afterB.modalScroll > 0, '⑪ 重建后弹窗**阅读位置**还原（' + afterB.modalScroll + 'px）；修复前归 0');

    // ---------- ⑭ 重建后**不得有跨域资源加载**（用户要求：折叠开合不要远程加载，要用本地数据）----------
    const afterRebuild = await h.ev(`(function () {
      var res = performance.getEntriesByType('resource') || [];
      var remote = res.filter(function (r) { try { return new URL(r.name, location.href).origin !== location.origin; } catch (e) { return false; } });
      return { total: res.length, remote: remote.length,
               remoteList: remote.slice(0, 5).map(function (r) { return r.name.slice(0, 60); }),
               overlayGone: !document.getElementById('app-boot-overlay') };
    })()`, 30000);
    console.log('  ⑭ 重建后的资源：' + JSON.stringify(afterRebuild));
    h.F(afterRebuild.remote === 0 && afterRebuild.overlayGone,
      '⑭ 重建（折叠开合形态）后**零跨域资源**（本地 ' + afterRebuild.total + ' 项全部来自缓存），启动遮罩已清除'
      + (afterRebuild.remote ? '；发现远程：' + JSON.stringify(afterRebuild.remoteList) : ''));

    // ---------- ⑮ 豆包网页版：默认**不自动联网**，点击才加载 ----------
    const webview = await h.ev(`(async () => {
      if (window.switchTab) window.switchTab('doubao');
      await new Promise(function (r) { setTimeout(r, 400); });
      if (window.dsSwitchSub) window.dsSwitchSub('doubao');
      await new Promise(function (r) { setTimeout(r, 500); });
      var box = document.getElementById('ds-sub-doubao');
      var iframe = box ? box.querySelector('iframe') : null;
      var hold = box ? box.querySelector('.ds-webview-hold') : null;
      var res = performance.getEntriesByType('resource') || [];
      var doubaoReq = res.filter(function (r) { return /doubao\\.com/.test(r.name); }).length;
      return { hasHold: !!hold, holdBtn: !!(hold && hold.querySelector('button')),
               iframeSrc: iframe ? String(iframe.getAttribute('src') || '') : '(无iframe)',
               iframeHidden: iframe ? iframe.style.display === 'none' : null,
               doubaoRequests: doubaoReq };
    })()`, 40000);
    console.log('  ⑮ 豆包网页版占位：' + JSON.stringify(webview));
    h.F(webview.hasHold && webview.holdBtn && webview.iframeSrc === 'about:blank' && webview.doubaoRequests === 0,
      '⑮ 豆包网页版默认**不联网**：显示占位卡片 + 「点击加载豆包网页版」按钮，iframe 仍为 about:blank、全程零 doubao.com 请求'
      + (webview.doubaoRequests ? '（实测有 ' + webview.doubaoRequests + ' 次）' : ''));

    // ---------- 智能助手：子视图保持（重建后回到智能写作而非智能对话）----------
    await h.ev(`(async () => {
      if (window.switchTab) window.switchTab('doubao');
      await new Promise(function (r) { setTimeout(r, 500); });
      if (window.dsSwitchSub) window.dsSwitchSub('writer');
      await new Promise(function (r) { setTimeout(r, 300); });
      try { window._savePageState(); } catch (e) {}
      return 1;
    })()`, 40000);
    await h.nav('index.html?v=foldstate3');
    await h.ev(HELP, 20000);
    await h.sleep(1800);
    const subAfter = await h.ev(`(function () {
      var p = window.__probe();
      return { sub: p.subView,
               writerShown: (function () { var el = document.getElementById('ds-sub-writer'); return !!(el && el.style.display !== 'none'); })() };
    })()`, 40000);
    console.log('  子视图：' + JSON.stringify(subAfter));
    h.F(subAfter.sub === 'writer' && subAfter.writerShown, '⑫ 重建后智能助手**子视图**保持（智能写作，而非回退到智能对话）');

    // ---------- ⑬ 连续两轮开合：状态不累积错乱 ----------
    await h.ev(`(async () => {
      if (window.switchTab) window.switchTab('material');
      await new Promise(function (r) { setTimeout(r, 600); });
      var more = document.querySelector('[data-wr-expand="fault"]');
      if (more) { more.click(); await new Promise(function (r) { setTimeout(r, 400); }); }
      window.__setReadPos(160);
      return 1;
    })()`, 40000);
    for (let i = 0; i < 2; i++) {
      await h.cdp.send('Emulation.setDeviceMetricsOverride', { width: 380, height: 760, deviceScaleFactor: 2, mobile: true }, h.sessionId);
      await h.sleep(600);
      await h.cdp.send('Emulation.setDeviceMetricsOverride', { width: 900, height: 1380, deviceScaleFactor: 2, mobile: true, screenOrientation: { type: 'landscapePrimary', angle: 90 } }, h.sessionId);
      await h.sleep(700);
    }
    await h.cdp.send('Emulation.clearDeviceMetricsOverride', {}, h.sessionId);
    await h.sleep(700);
    const afterC = await h.ev(`(function () { return window.__probe(); })()`, 30000);
    console.log('  两轮开合后：' + JSON.stringify(afterC));
    h.F(afterC.panelActive === 'panel-material' && afterC.chipFault && afterC.readPos > 0,
      '⑬ 连续两轮开合后状态不累积错乱（仍在资料中心 + ⚡故障分类 + 阅读位置 ' + afterC.readPos + 'px [' + afterC.readKind + ']）');

    await h.ev(`(() => { try { sessionStorage.clear(); localStorage.removeItem('wr_mat_filter'); } catch (e) {} return 1; })()`, 20000);
  } catch (e) {
    h.F(false, '套件异常：' + (e && e.message));
  }
  h.done();
  process.exit(0);
})();
