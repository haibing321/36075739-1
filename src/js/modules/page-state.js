/**
 * page-state.js · 折叠屏/旋转 会话状态快照与恢复
 * ===================================================
 * 解决：折叠屏展开/折叠时 Android WebView（尤其 PWA standalone）会销毁并重建
 *       DOM 文档，导致当前模块的滚动位置、未提交草稿、打开的弹窗全部丢失，
 *       表现为「页面被重置 / 重启」。
 *
 * 策略：在页面即将被系统销毁（pagehide / visibilitychange→隐藏）时，把易失状态
 *       快照到 sessionStorage；文档重建后 DOMContentLoaded 时还原。
 *       仅恢复「易失、未持久化」的状态，已存 localStorage/IndexedDB 的数据不重复处理。
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

  function savePageState() {
    try {
      var snap = {
        t: Date.now(),
        module: _currentModule(),
        scroll: _activePanelScroll(),
        modals: _openModals(),
        drafts: _collectDrafts()
      };
      sessionStorage.setItem(KEY, JSON.stringify(snap));
    } catch (e) { /* sessionStorage 不可用（隐私模式/配额）时静默跳过 */ }
  }

  function restorePageState() {
    var raw;
    try { raw = sessionStorage.getItem(KEY); } catch (e) { return; }
    if (!raw) return;
    var snap;
    try { snap = JSON.parse(raw); } catch (e) { return; }
    if (!snap || !snap.module) return;

    // 1) 恢复模块（用 switchTab 而非直接改 class，保证 onShow_ 钩子触发）
    try {
      if (typeof window.switchTab === 'function') window.switchTab(snap.module);
      else {
        var btn = document.getElementById('tab-' + snap.module);
        if (btn) btn.click();
      }
    } catch (e) {}

    // 2) 等一帧让面板渲染完成再还原滚动/草稿/弹窗
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

  // 在 savePageState 里把 _editSession 一并写入（完整重写，避免原始函数覆盖丢失）
  savePageState = function () {
    try {
      var snap = {
        t: Date.now(),
        module: _currentModule(),
        scroll: _activePanelScroll(),
        modals: _openModals(),
        drafts: _collectDrafts(),
        editSession: _editSession
      };
      sessionStorage.setItem(KEY, JSON.stringify(snap));
    } catch (e) { /* sessionStorage 不可用（隐私模式/配额）时静默跳过 */ }
  };

  // 恢复：模块恢复后，若有编辑会话，调用对应 restoreEdit_<module> 钩子
  var _origRestore = restorePageState;
  restorePageState = function () {
    _origRestore();
    var raw;
    try { raw = sessionStorage.getItem(KEY); } catch (e) { return; }
    if (!raw) return;
    var snap;
    try { snap = JSON.parse(raw); } catch (e) { return; }
    if (!snap || !snap.editSession || !snap.editSession.module) return;
    var ctx = snap.editSession;
    // 等模块渲染 + 编辑重开完成（多帧，避免被 onShow_ 重渲染覆盖）
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
  };

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
