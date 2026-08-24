/**
 * page-state.js · 折叠屏/旋转 会话状态快照与恢复
 * ===================================================
 * 解决：折叠屏展开/折叠时 Android WebView（尤其 PWA standalone）会销毁并重建
 *       DOM 文档，导致当前模块的滚动位置、未提交草稿、打开的弹窗、以及已渲染的
 *       列表/数据全部丢失，表现为「页面被重置 / 重启 / 空白」。
 *
 * v3.13 升级：在「易失状态快照」(v3.11) 与「编辑态保持」(v3.12) 基础上，
 *   新增【整页 DOM 快照】——把每个 panel 已渲染好的 innerHTML（含数据）一并序列化，
 *   文档重建后直接还原，使「数据和界面」都保持；仅由 CSS 响应式按新尺寸自动重排，
 *   不再依赖 onShow_ 重新拉取 IndexedDB（避免重建后出现空白/无数据）。
 *
 * 策略：pagehide / visibilitychange→隐藏 / resize / visualViewport.resize 时
 *       序列化易失状态 + 各 panel innerHTML 到 sessionStorage；
 *       DOMContentLoaded 后直接还原 DOM（不触发 onShow_ 重拉），再还原滚动/弹窗/编辑态。
 *
 * 纯新增模块，不修改任何现有业务逻辑的 reload/存储行为。
 * ===================================================
 */
(function () {
  'use strict';

  var KEY = 'page_state_snapshot_v1';

  // 各模块「未提交草稿」输入框的稳定 id（仅抓取值，不干扰业务）
  // 仅收集「明显的草稿类输入」，避免误存密码/已提交内容
  var DRAFT_INPUT_IDS = [
    'ds-input',            // 智能对话输入框
    'ds-agent-input',      // 智能体输入框
    'wr-topic-input',      // 智能写作主题
    'wr-outline-input',    // 智能写作大纲
    'wr-modify-instruction', // 智能写作修改指令
    'issue-search',        // 检查信息搜索框
    'rule-search',         // 规章搜索框
    'phone-search',        // 应急电话搜索
    'handbook-search',     // 手册搜索
    'diary-title',         // 日志标题
    'memo-input'           // 备忘输入
  ];

  // 主滚动容器：各 panel 内部的可滚动区域（结构为 .panel.active 内的 .module-scroll 或 panel 自身）
  function _activePanelScroll() {
    var panel = document.querySelector('.panel.active');
    if (!panel) return null;
    // 优先取模块内声明的滚动容器
    var sc = panel.querySelector('.module-scroll') || panel.querySelector('.scroll-area');
    var el = sc || panel;
    return { top: el.scrollTop || 0, left: el.scrollLeft || 0 };
  }

  function _currentModule() {
    try { return localStorage.getItem('current_module') || 'issue'; } catch (e) { return 'issue'; }
  }

  function _openModals() {
    var ids = [];
    document.querySelectorAll('.modal.active, .panel-modal.active').forEach(function (m) {
      if (m.id) ids.push(m.id);
    });
    return ids;
  }

  // 抓取草稿（仅非空的、且不在「已提交/已发送」态的）
  function _collectDrafts() {
    var drafts = {};
    DRAFT_INPUT_IDS.forEach(function (id) {
      var el = document.getElementById(id);
      if (!el) return;
      // textarea / input
      var val = (el.value !== undefined) ? el.value : (el.textContent || '');
      if (val && val.trim && val.trim().length > 0) {
        drafts[id] = val;
      }
    });
    return drafts;
  }

  // ===== 整页 DOM 快照（v3.13）：序列化每个 panel 已渲染的 innerHTML（含数据）=====
  // 仅当总序列化体积 < 阈值时才保存，避免撑爆 sessionStorage 配额（约 5MB）而抛错。
  var _MAX_PANEL_HTML_BYTES = 3.5 * 1024 * 1024; // 3.5MB 安全线
  function _collectPanelHTML() {
    var map = {};
    var total = 0;
    var ids = ['handbook', 'issue', 'rule', 'phone', 'doubao', 'diary', 'material'];
    for (var i = 0; i < ids.length; i++) {
      var p = document.getElementById('panel-' + ids[i]);
      if (!p) continue;
      var html = '';
      try { html = p.innerHTML; } catch (e) { continue; }
      // 粗略字节估算（UTF-16 → 按 2 字节计，留余量）
      var approx = html.length * 2;
      if (total + approx > _MAX_PANEL_HTML_BYTES) {
        // 超出配额：放弃整页快照，降级为 v3.12 行为（不存 panelHTML）
        return null;
      }
      total += approx;
      map[ids[i]] = html;
    }
    return map;
  }

  function savePageState() {
    try {
      var snap = {
        t: Date.now(),
        module: _currentModule(),
        scroll: _activePanelScroll(),
        modals: _openModals(),
        drafts: _collectDrafts(),
        editSession: _editSession,
        // v3.13：整页 DOM（含已渲染数据）。为 null 表示超配额降级。
        panelHTML: _collectPanelHTML()
      };
      sessionStorage.setItem(KEY, JSON.stringify(snap));
    } catch (e) { /* sessionStorage 不可用（隐私模式/配额）时静默跳过 */ }
  }

  // 直接还原整页 DOM（不触发 onShow_ 重拉，避免重建后空白）
  function _restorePanelDOM(snap) {
    if (!snap.panelHTML) return false; // 无快照：降级
    var ok = false;
    Object.keys(snap.panelHTML).forEach(function (mod) {
      var p = document.getElementById('panel-' + mod);
      if (!p) return;
      try {
        p.innerHTML = snap.panelHTML[mod];
        ok = true;
      } catch (e) {}
    });
    if (!ok) return false;
    // 激活目标模块（仅改 class，不调用 switchTab，避免 onShow_ 重拉清空刚还原的 DOM）
    try {
      document.querySelectorAll('.nav-btn').forEach(function (t) { t.classList.remove('active'); });
      document.querySelectorAll('.panel').forEach(function (p) { p.classList.remove('active'); });
      var btn = document.getElementById('tab-' + snap.module);
      if (btn) btn.classList.add('active');
      var ap = document.getElementById('panel-' + snap.module);
      if (ap) ap.classList.add('active');
      // 同步移动端当前 Tab 标签（避免折叠后顶部标签仍显示旧模块）
      var labelEl = document.getElementById('navCurrentLabel');
      if (labelEl) {
        var labels = { handbook: '检查手册', issue: '检查信息', rule: '规章制度', phone: '应急电话', doubao: '智能助手', diary: '工作日志', material: '资料中心' };
        labelEl.textContent = labels[snap.module] || '';
      }
    } catch (e) {}
    return true;
  }

  function restorePageState() {
    var raw;
    try { raw = sessionStorage.getItem(KEY); } catch (e) { return; }
    if (!raw) return;
    var snap;
    try { snap = JSON.parse(raw); } catch (e) { return; }
    if (!snap || !snap.module) return;

    // 1) 先还原整页 DOM（含数据），确保「数据和界面都保持」，不触发重拉
    var domRestored = false;
    try { domRestored = _restorePanelDOM(snap); } catch (e) { domRestored = false; }

    // 2) 降级分支：若整页快照不可用，退回到 v3.12 的 switchTab 行为
    if (!domRestored) {
      try {
        if (typeof window.switchTab === 'function') window.switchTab(snap.module);
        else {
          var btn = document.getElementById('tab-' + snap.module);
          if (btn) btn.click();
        }
      } catch (e) {}
    }

    // 3) 等一帧让面板渲染完成再还原滚动/草稿/弹窗/编辑态
    requestAnimationFrame(function () {
      requestAnimationFrame(function () {
        // 滚动位置
        if (snap.scroll) {
          var panel = document.querySelector('.panel.active');
          if (panel) {
            var el = panel.querySelector('.module-scroll') || panel.querySelector('.scroll-area') || panel;
            try { el.scrollTop = snap.scroll.top || 0; el.scrollLeft = snap.scroll.left || 0; } catch (e) {}
          }
        }
        // 草稿回填（仅当输入框当前为空，避免覆盖用户已输入的新内容）
        if (snap.drafts) {
          Object.keys(snap.drafts).forEach(function (id) {
            var el = document.getElementById(id);
            if (!el) return;
            var cur = (el.value !== undefined) ? el.value : (el.textContent || '');
            if (!cur || !cur.trim || cur.trim().length === 0) {
              try {
                if (el.value !== undefined) { el.value = snap.drafts[id]; if (el.dispatchEvent) el.dispatchEvent(new Event('input', { bubbles: true })); }
                else { el.textContent = snap.drafts[id]; }
                if (typeof window.autoResize === 'function') window.autoResize(el);
              } catch (e) {}
            }
          });
        }
        // 弹窗恢复
        if (snap.modals && snap.modals.length) {
          snap.modals.forEach(function (id) {
            var m = document.getElementById(id);
            if (m && typeof m.classList !== 'undefined') m.classList.add('active');
          });
        }
      });
    });

    // 4) 编辑态恢复（多帧，避免被后续渲染覆盖）
    if (snap.editSession && snap.editSession.module) {
      var ctx = snap.editSession;
      requestAnimationFrame(function () {
        requestAnimationFrame(function () {
          requestAnimationFrame(function () {
            var hook = window['restoreEdit_' + ctx.module];
            if (typeof hook === 'function') {
              try { hook(ctx); } catch (e) { console.warn('restoreEdit_' + ctx.module + ' 失败', e); }
            }
          });
        });
      });
    }

    // 5) 派发「快照已还原」事件，通知各模块按还原后的 DOM 重新同步内部状态
    //    （如规章制度/检查信息的关键词计数器，init 时容器为空已加 1 行，此处按还原后的 N 行纠正，避免多一个框）
    requestAnimationFrame(function () {
      requestAnimationFrame(function () {
        try { window.dispatchEvent(new Event('pageSnapshotRestored')); } catch (e) {}
      });
    });
  }

  // ===== 挂监听：页面即将被系统销毁时保存（折叠屏重建必经此路）=====
  // pagehide 在页面卸载/销毁前必触发（比 beforeunload 更可靠，且不阻塞）
  window.addEventListener('pagehide', savePageState);
  // visibilitychange→隐藏：折叠屏合上时先触发隐藏，提前存一份
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'hidden') savePageState();
  });
  // 兜底：页面 resize 结束（折叠/旋转完成）也存一次，确保最新滚动位置不丢
  var _rsTimer = null;
  window.addEventListener('resize', function () {
    if (_rsTimer) clearTimeout(_rsTimer);
    _rsTimer = setTimeout(savePageState, 300);
  });

  // 折叠屏专用：visualViewport 尺寸变化（折叠/展开动作本身）防抖处理。
  // 仅做轻量布局重算 + 存快照，不触发任何业务重渲染，避免折叠抖动导致页面重构。
  if (window.visualViewport) {
    var _vvTimer = null;
    window.visualViewport.addEventListener('resize', function () {
      if (_vvTimer) clearTimeout(_vvTimer);
      _vvTimer = setTimeout(function () {
        // 仅重算当前激活面板的滚动边界（不改变内容/不重载）
        try {
          var panel = document.querySelector('.panel.active');
          if (panel) {
            var el = panel.querySelector('.module-scroll') || panel.querySelector('.scroll-area') || panel;
            if (el && el.scrollHeight < el.scrollTop) el.scrollTop = el.scrollHeight;
          }
        } catch (e) {}
        savePageState();
      }, 250);
    });
  }

  // ===== 通用「编辑会话」快照协议 =====
  // 问题：折叠屏重建文档后，动态生成的编辑态（如 diary.editDiary 打开的编辑页、
  //       资料库编辑弹窗、写作编辑区）会因 onShow_ 重渲染而丢失，固定 id 的草稿
  //       快照无法覆盖。解决方案：让各编辑入口把「编辑会话」序列化到 _editSession，
  //       重建后由对应模块的 restoreEdit_<module>(ctx) 钩子重开编辑态并回填。
  var _editSession = null;       // { module, recordId, content, ts }
  function _setEditSession(ctx) {
    try {
      _editSession = ctx || null;
      // 与页面快照一起落盘，确保 fold 重建前最后一刻也能拿到
      var raw = sessionStorage.getItem(KEY);
      var snap = raw ? JSON.parse(raw) : {};
      snap.editSession = _editSession;
      snap.t = Date.now();
      sessionStorage.setItem(KEY, JSON.stringify(snap));
    } catch (e) {}
  }
  function _getEditSession() { return _editSession; }
  function _clearEditSession() { _setEditSession(null); }

  // v3.13：savePageState / restorePageState 主函数已统一处理 panelHTML + editSession，
  //   此处不再覆盖重写（覆盖会丢失 panelHTML 字段），仅保留 _editSession 协议暴露。
  //   _setEditSession 已通过合并写入 sessionStorage 确保 fold 重建前最后一刻 editSession 不丢。

  // 暴露协议接口
  window._editSession = {
    set: _setEditSession,
    get: _getEditSession,
    clear: _clearEditSession
  };
  // 暴露给 app.js 在 DOMContentLoaded 后调用
  window._restorePageState = restorePageState;
  window._savePageState = savePageState;
})();
