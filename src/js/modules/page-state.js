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

  // v2（2026-09-19）：v1 快照里的内联 onclick 是**被旧实现剥掉的**（恢复后按钮全是死的：
  //   记入日志/复制点了没反应）。换 key → 旧快照直接作废，用户第一次刷新就用上新规则，
  //   否则"死快照"会被反复恢复/回写、问题看起来"没修好"。
  var KEY = 'page_state_snapshot_v2';

  // 各模块「未提交草稿」输入框的稳定 id（仅抓取值，不干扰业务）
  // 仅收集「明显的草稿类输入」，避免误存密码/已提交内容
  // v3.27 修正：原列表大量 id 已过时（ds-input/wr-topic-input/issue-search/rule-search/
  //   phone-search/handbook-search/diary-title/memo-input 均不存在），导致折叠/刷新后
  //   用户输入不保留。现按各模块真实 id 校正；textarea 内容随整页 innerHTML 快照已保留，
  //   此处重点保障 input 类（value 不进 innerHTML）的草稿。
  var DRAFT_INPUT_IDS = [
    'ds-user-input',           // 智能对话输入框
    'ds-agent-input',          // 智能体输入框
    'ds-history-search',       // 智能助手历史对话搜索
    'wr-query-input',          // 智能写作查询输入
    'wr-modify-instruction',   // 智能写作修改指令
    'risk-refine-input',       // 风险研判细化输入
    'risk-date-start',         // 风险研判起止日期（input[date]，value 不进 innerHTML，v3.29 补）
    'risk-date-end',           // 风险研判结束日期
    'risk-unit',               // 风险研判责任单位筛选
    'risk-focus',              // 风险研判重点
    'hb-searchInput',          // 检查手册搜索
    'phone-searchInput',       // 应急电话搜索
    'diary-search-input',      // 工作日志搜索
    'diary-work',              // 工作日志正文
    'memo-datetime',           // 备忘提醒时间(input[datetime-local]，value 不进 innerHTML)
    'memo-content'             // 备忘内容(textarea，随 innerHTML 保留，这里再加一道单值兜底)
  ];
  // 注意：原列表中的 #memo-title（index.html:1200）是「🔔 新建备忘提醒」弹窗标题 div，
  //   并非输入框，永远无 value，已从列表移除；备忘真实草稿仅 datetime + content。
  // v3.27：动态关键词容器（规章制度 rule-input_N / 检查信息 issue-input_N），
  // 输入框 id 随数量动态编号，按容器收集整个数组。
  var DRAFT_KEYWORD_BOXES = ['rule-keywordContainer', 'issue-keywordContainer'];

  // 主滚动容器：优先取模块内声明的滚动容器；没有则向上找「真正可滚动的祖先」。
  // 注意：.module-scroll / .scroll-area 这两个类在本项目里其实从未使用过，
  // 原实现永远退化成 panel 自身，而 panel 只是普通容器并不滚动 ——
  // 结果 snapshot.scroll 恒为 {top:0,left:0}，折叠/刷新后滚动位置永远恢复不了。
  function _findScroller(node) {
    var el = node;
    while (el && el !== document.body && el !== document.documentElement) {
      try {
        var oy = getComputedStyle(el).overflowY;
        if ((oy === 'auto' || oy === 'scroll') &&
            (el.scrollHeight > el.clientHeight + 1 || el.scrollWidth > el.clientWidth + 1)) {
          return el;
        }
      } catch (e) {}
      el = el.parentElement;
    }
    return document.scrollingElement || document.documentElement;
  }

  function _activePanelScroll() {
    var panel = document.querySelector('.panel.active');
    if (!panel) return null;
    // 优先取模块内声明的滚动容器
    var el = panel.querySelector('.module-scroll') || panel.querySelector('.scroll-area');
    if (!el) el = _findScroller(panel);
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
    // v3.27：动态关键词容器（rule-input_N / issue-input_N）按数组收集
    DRAFT_KEYWORD_BOXES.forEach(function (cid) {
      var box = document.getElementById(cid);
      if (!box) return;
      var vals = [];
      box.querySelectorAll('input[type="text"]').forEach(function (inp) {
        vals.push(inp.value || '');
      });
      // 去掉尾随空串（用户未填的空框不算草稿），保留中间空值以维持索引对齐
      while (vals.length > 0 && (!vals[vals.length - 1] || !vals[vals.length - 1].trim())) vals.pop();
      var has = vals.some(function (v) { return v && v.trim().length > 0; });
      if (has) drafts[cid] = vals;
    });
    return drafts;
  }

  // ===== 动态内容区快照 =====
  //
  // 【重要变更】原先这里保存的是「当前激活 panel 的整个 innerHTML」，恢复时再整块写回。
  // 这是「资料中心刷新后打不开」的直接原因：
  //   1. 资料中心的按钮（导入资料 / 模板设置 / 8 个分类 Tab / 关闭 / 返回）全部是
  //      写在 index.html 里的【内联 onclick】，属于静态结构；
  //   2. 恢复时用 panel.innerHTML = 快照 会整体替换面板子树，静态按钮被快照版本覆盖；
  //   3. 为防 XSS 又统一剥掉了快照里的 on* 属性，于是这些按钮的 onclick 全部丢失；
  //   4. 而模块的 onShow_ 钩子只重新渲染【列表内容】，不会给静态按钮重绑事件 ——
  //      结果就是：面板能显示，但所有按钮点了都没反应。
  //
  // 正确做法是：只快照「由 JS 动态渲染的内容区」，绝不触碰静态结构。
  // 这些容器里的内容都是模块自己生成的，随后 onShow_ 会用最新数据重新渲染一遍，
  // 交互自然恢复；而静态按钮的 onclick 从头到尾没被动过。
  var DYNAMIC_SNAPSHOT_IDS = [
    'rule-resultsList',   // 规章制度 · 搜索结果
    'issue-results',      // 检查信息 · 搜索结果
    'phone-results',      // 应急电话 · 查询结果
    'wr-mat-list',        // 资料中心 · 资料列表
    'wr-history-list',    // 资料中心 · 历史报告列表
    'memo-list',          // 备忘提醒 · 列表
    'hb-content-text',    // 检查手册 · 正文
    'diary-history-view', // 工作日志 · 历史视图
    'ds-chat-box'         // 智能助手 · 对话区
  ];
  var _MAX_SNAPSHOT_BYTES = 1.5 * 1024 * 1024; // 单个容器上限
  function _collectPanelHTML() {
    var map = {};
    for (var i = 0; i < DYNAMIC_SNAPSHOT_IDS.length; i++) {
      var id = DYNAMIC_SNAPSHOT_IDS[i];
      var el = document.getElementById(id);
      if (!el) continue;
      var html = '';
      try { html = el.innerHTML; } catch (e) { continue; }
      if (!html || !html.trim()) continue;                 // 空的没必要存
      if (html.length * 2 > _MAX_SNAPSHOT_BYTES) continue; // 超限时交由模块重新渲染
      map[id] = html;
    }
    return map;
  }

  // v3.29：弹窗内容快照 —— 查看全文等独立 modal（rule-fullViewModal 等）不在 panel 内，
  // 其 innerHTML 不随 panel 快照保存，折叠/刷新还原后只剩空壳。这里把「当前打开的 modal」
  // 的内容一并序列化，还原时回填。仅快照 active 的 modal（体积可控）。
  // v3.30：上限 512KB→1.5MB —— 真实规章正文（文本/表格）可能超 512KB，超限跳过导致
  //   「弹窗打开但正文空白」；超 1.5MB 的极端情况由 rule.js 的 restoreEdit_rule 兜底重建。
  var _MAX_MODAL_HTML_BYTES = 1.5 * 1024 * 1024;
  function _collectModalHTML() {
    var map = {};
    var total = 0;
    document.querySelectorAll('.modal.active, .panel-modal.active').forEach(function (m) {
      if (!m.id) return;
      try {
        var html = m.innerHTML;
        var approx = html.length * 2;
        if (total + approx > _MAX_MODAL_HTML_BYTES) return;
        total += approx;
        map[m.id] = html;
      } catch (e) {}
    });
    return map;
  }

  // ===== 【2026-09-23 折叠屏界面保持】内层阅读位置 =====
  //   原来只存「当前面板的主滚动容器」：折叠/重建后，用户**正在读的地方**（弹窗正文第 30 行、
  //   聊天记录、列表第 200 条）会回到顶部 —— 这是"界面没保持住"里体感最强的一条。
  //   这里额外记录：① 若干常驻容器的滚动位置；② 打开中的弹窗内部所有可滚动元素的位置
  //     （按 DOM 顺序对齐 —— 弹窗内容会用同一份 innerHTML 还原，顺序稳定）。
  var SNAPSHOT_SCROLLER_IDS = [
    'ds-chat-box',        // 智能助手 · 对话区
    'wr-mat-list',        // 资料中心 · 资料列表
    'wr-history-list',    // 资料中心 · 历史报告
    'rule-resultsList',   // 规章制度 · 搜索结果
    'issue-results',      // 检查信息 · 搜索结果
    'phone-results',      // 应急电话 · 查询结果
    'memo-list',          // 备忘提醒 · 列表
    'hb-content-text',    // 检查手册 · 正文
    'diary-history-view'  // 工作日志 · 历史视图
  ];
  /** 容器内所有「可滚动」元素（按 DOM 顺序，不做"是否已滚动"的过滤 —— 否则存/取两侧下标会错位） */
  function _scrollablesIn(root) {
    var out = [], all;
    try { all = root.querySelectorAll('*'); } catch (e) { return out; }
    for (var i = 0; i < all.length; i++) {
      var el = all[i];
      try {
        var cs = getComputedStyle(el);
        if (/(auto|scroll)/.test(cs.overflowY) && el.scrollHeight > el.clientHeight + 4) out.push(el);
      } catch (e) {}
    }
    return out;
  }
  function _collectScrollers() {
    var ids = {}, modals = {};
    SNAPSHOT_SCROLLER_IDS.forEach(function (id) {
      var el = document.getElementById(id);
      if (el && (el.scrollTop || el.scrollLeft)) ids[id] = [el.scrollTop, el.scrollLeft];
    });
    document.querySelectorAll('.modal.active, .panel-modal.active').forEach(function (m) {
      if (!m.id) return;
      var arr = _scrollablesIn(m).map(function (el) { return [el.scrollTop, el.scrollLeft]; });
      if (arr.length) modals[m.id] = arr;
    });
    return (Object.keys(ids).length || Object.keys(modals).length) ? { ids: ids, modals: modals } : null;
  }
  /** 回填内层滚动位置；仅在元素还停在顶部时写（不跟用户刚做的滚动打架） */
  function _restoreScrollers(snap) {
    var sc = snap && snap.scrollers;
    if (!sc) return;
    try {
      if (sc.ids) {
        Object.keys(sc.ids).forEach(function (id) {
          var el = document.getElementById(id);
          if (!el) return;
          if (!el.scrollTop) el.scrollTop = sc.ids[id][0] || 0;
          if (!el.scrollLeft) el.scrollLeft = sc.ids[id][1] || 0;
        });
      }
      if (sc.modals) {
        Object.keys(sc.modals).forEach(function (mid) {
          var m = document.getElementById(mid);
          if (!m) return;
          var els = _scrollablesIn(m), saved = sc.modals[mid] || [];
          for (var i = 0; i < els.length && i < saved.length; i++) {
            if (!els[i].scrollTop) els[i].scrollTop = saved[i][0] || 0;
            if (!els[i].scrollLeft) els[i].scrollLeft = saved[i][1] || 0;
          }
        });
      }
    } catch (e) {}
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
        // v3.32：内层阅读位置（弹窗正文/聊天区/列表容器）
        scrollers: _collectScrollers(),
        // v3.32：根滚动位置 —— 多数机型上"页面"其实滚在 documentElement 上（内层容器 overflow 可见），
        //   而 _findScroller 明确跳过 documentElement ⇒ 这类布局下阅读位置从来没被保存过。
        rootScroll: (function () {
          try { return { top: window.scrollY || window.pageYOffset || 0, left: window.scrollX || window.pageXOffset || 0 }; }
          catch (e) { return null; }
        })(),
        // v3.13：整页 DOM（含已渲染数据）。为 null 表示超配额降级。
        panelHTML: _collectPanelHTML(),
        // v3.29：打开的弹窗内容（查看全文正文等，不随 panel 快照保存）
        modalHTML: _collectModalHTML()
      };
      sessionStorage.setItem(KEY, JSON.stringify(snap));
    } catch (e) { /* sessionStorage 不可用（隐私模式/配额）时静默跳过 */ }
  }

  // 安全的内联 onclick 判据（单个函数调用，参数仅限 标识符/this/数字/受限字符集的引号串）。
  //   为什么要有它：见 _scrubOnAttrs 的说明 —— 一律剥掉会让"没有 onShow_ 钩子"的模块
  //   （检查信息/规章制度/应急电话）刷新后按钮全部失效。
  //   拦不住的示例：含 ; = ` < > / 反斜杠、嵌套括号、字符串拼接 → 一律按不安全处理。
  var _SAFE_ONCLICK = /^[A-Za-z_$][\w$.]*\((?:[^"'<>;=`\\/()]|'[^'<>;=`\\/()]*'|"[^"<>;=`\\/()]*")*\)$/;
  /**
   * 【2026-09-19 修复用户报的 bug】恢复快照时「on* 一律剥掉」导致按钮点了没反应。
   *   原实现：`el.innerHTML = snapshot.replace(/\son[a-z]+=.../g,' ')` —— 全剥，然后指望
   *   "这些容器随后会由模块的 onShow_ 用最新数据重新渲染"把交互补回来。
   *   但 `switchTab` 只会回调**存在**的 `window['onShow_'+tab]`：检查信息 / 规章制度 / 应急电话
   *   **都没有**这个钩子 → 刷新（或折叠屏重建文档）后恢复出来的卡片按钮全是死的 ——
   *   用户报的「记入日志按钮点击后无反应」就是这个（`onclick="addIssueToDiaryFromCard(this)"`
   *   被剥掉了）。
   *   现在：**onclick 只放行安全调用式**（我们自己渲染的那些：addIssueToDiaryFromCard(this)、
   *   issueCopyContent(this)、editDiary('2026-09-19')…），其余 on* 事件（onerror/onload/…）
   *   与不安全表达式继续剥离 —— 防 XSS 的初衷不变，交互不再丢。
   */
  function _scrubOnAttrs(html) {
    // ⚠️ 必须**单趟**处理：先前写成"先挑出安全 onclick 保留、再跑一遍通配 on* 剥离"，
    //   结果第二遍把刚保留的 onclick 又剥掉了（Node 单测 6 例全挂）。
    // ⚠️ 捕获组必须带上 `on`：写成 \son([a-z]+) 时捕获到的是 "click"，与 'onclick' 比较永远不等
    //   （Node 单测 6 例全挂就是这么来的）。
    return String(html).replace(/\s(on[a-z]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/gi, function (m, name, dq, sq) {
      var val = (dq !== undefined) ? dq : sq;
      var quote = (dq !== undefined) ? '"' : "'";
      if (String(name).toLowerCase() === 'onclick' && _SAFE_ONCLICK.test(String(val).trim())) {
        return ' onclick=' + quote + val + quote;   // 我们自己渲染的安全调用式 → 保留（按钮才活着）
      }
      return ' ';                                   // 其余 on* / 不安全的 onclick → 剥离
    });
  }

  // 还原「动态内容区」+ 激活目标模块
  // 注意：只写回 DYNAMIC_SNAPSHOT_IDS 里的容器，绝不覆盖 panel 整体 ——
  // 覆盖整体会毁掉静态按钮的内联 onclick（详见上方 DYNAMIC_SNAPSHOT_IDS 的说明）。
  function _restorePanelDOM(snap) {
    if (!snap || !snap.panelHTML) return false; // 无快照：降级
    var ok = false;
    Object.keys(snap.panelHTML).forEach(function (id) {
      // 只接受白名单内的 id：旧版本快照里存的是模块名（如 "material"），
      // 那些必须忽略，否则会退回「整块替换 panel」的老行为。
      if (DYNAMIC_SNAPSHOT_IDS.indexOf(id) === -1) return;
      var el = document.getElementById(id);
      if (!el) return;
      try {
        // 快照内容混有规章名、检查信息字段等用户输入。任一渲染路径存在转义遗漏时，
        // 内联 onclick 就可能被原样还原 → DOM XSS。用 _scrubOnAttrs 过滤（安全调用式保留）。
        el.innerHTML = _scrubOnAttrs(snap.panelHTML[id]);
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

    // 把编辑会话回填到模块级变量：快照里的 editSession 只在下面第 4 步用于调钩子，
    // 不回填的话 _getEditSession() 在还原后仍返回 null，模块拿不到「我正在编辑哪条」。
    try { if (snap.editSession && snap.editSession.module) _editSession = snap.editSession; } catch (e) {}

    // 1) 先用快照回填「动态内容区」（快速显示上次内容，避免闪烁）
    var domRestored = false;
    try { domRestored = _restorePanelDOM(snap); } catch (e) { domRestored = false; }

    // 2) 无论快照是否生效，都再触发一次模块的 onShow_ 钩子：
    //    - 快照不可用时：这是原本的降级路径（switchTab 完整渲染）；
    //    - 快照生效时：必须用最新数据重新渲染一遍。因为快照内容为了防 XSS
    //      已剥掉 on* 内联事件，列表项上的按钮（查看/删除/复制等）此时是死的，
    //      只有模块重新渲染才能把交互补回来 —— 资料中心刷新后按钮点不动就是缺了这一步。
    try {
      if (typeof window.switchTab === 'function') window.switchTab(snap.module);
      else {
        var btn = document.getElementById('tab-' + snap.module);
        if (btn) btn.click();
      }
    } catch (e) {}

    // 3) 下一帧还原滚动/草稿/弹窗/编辑态（v3.28 优化：由 rAF×2 提前为 rAF×1，
    //    整页 innerHTML 替换在 DOMContentLoaded 同步完成，单帧后 DOM 已稳定可写，
    //    滚动位置/草稿更早恢复到位，用户感知还原更即时）
    requestAnimationFrame(function () {
      // 滚动位置（定位逻辑必须与保存端 _activePanelScroll 完全一致，否则存 A 恢复 B）
      if (snap.scroll) {
        var panel = document.querySelector('.panel.active');
        var scEl = panel ? (panel.querySelector('.module-scroll') || panel.querySelector('.scroll-area')) : null;
        if (!scEl) scEl = _findScroller(panel || document.body);
        try { scEl.scrollTop = snap.scroll.top || 0; scEl.scrollLeft = snap.scroll.left || 0; } catch (e) {}
      }
      // 草稿回填（仅当输入框当前为空，避免覆盖用户已输入的新内容）
      if (snap.drafts) {
        Object.keys(snap.drafts).forEach(function (id) {
          var val = snap.drafts[id];
          // v3.27：动态关键词容器（rule-input_N / issue-input_N）数组回填
          if (Array.isArray(val)) {
            var box = document.getElementById(id);
            if (!box) return;
            var inputs = box.querySelectorAll('input[type="text"]');
            // 若还原后容器 input 数量少于快照（理论不应发生，innerHTML 已还原行），
            // 通过各模块暴露的 add 函数补齐，保证按索引回填不落空。
            if (inputs.length < val.length) {
              var addFn = id === 'rule-keywordContainer' ? window.ruleAddKeyword : window.issueAddKeyword;
              if (typeof addFn === 'function') {
                for (var k = inputs.length; k < val.length; k++) { try { addFn(); } catch (e) { break; } }
                inputs = box.querySelectorAll('input[type="text"]');
              }
            }
            val.forEach(function (v, i) {
              if (inputs[i] && v && !inputs[i].value) {
                inputs[i].value = v;
                if (inputs[i].dispatchEvent) inputs[i].dispatchEvent(new Event('input', { bubbles: true }));
              }
            });
            return;
          }
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
      // 弹窗内容回填（v3.29：查看全文等独立 modal 的内容，还原后不为空壳）
      // 注：这里【不】剥离 on* 内联事件 —— 弹窗（如规章全文）里有复制/关闭等按钮，
      // 剥掉会让它们失效（与资料中心那次是同一类问题）。
      // 弹窗内容是本应用自己渲染的，且刷新后用户可关闭重开，权衡后保留交互。
      if (snap.modalHTML) {
        Object.keys(snap.modalHTML).forEach(function (mid) {
          var m = document.getElementById(mid);
          if (!m) return;
          try { m.innerHTML = snap.modalHTML[mid]; } catch (e) {}
        });
      }
      // 弹窗恢复（active 类）
      if (snap.modals && snap.modals.length) {
        snap.modals.forEach(function (id) {
          var m = document.getElementById(id);
          if (m && typeof m.classList !== 'undefined') m.classList.add('active');
        });
      }
      // v3.32：内层阅读位置回填 —— 必须放在**弹窗内容回填之后**（_scrollablesIn 依赖已还原的 DOM）
      _restoreScrollers(snap);
      // v3.32：根滚动回填（内层容器不滚动时，阅读位置落在这里）
      if (snap.rootScroll && (snap.rootScroll.top || snap.rootScroll.left)) {
        try { window.scrollTo(snap.rootScroll.left || 0, snap.rootScroll.top || 0); } catch (e) {}
      }

      // 派发「快照已还原」事件（v3.28 优化：与滚动/草稿同帧，关键词计数同步更早完成）
      // 通知各模块按还原后的 DOM 重新同步内部状态
      //    （如规章制度/检查信息的关键词计数器，init 时容器为空已加 1 行，此处按还原后的 N 行纠正，避免多一个框）
      try { window.dispatchEvent(new Event('pageSnapshotRestored')); } catch (e) {}

      // 再补一次模块渲染：
      // 步骤 2 里的 switchTab 发生在 DOMContentLoaded 早期，此时模块数据
      // （大多来自 IndexedDB，异步加载）往往还没就绪，onShow 会渲染失败或渲染出空列表；
      // 而快照内容为了防 XSS 已剥掉 on*，列表项上的按钮是死的。
      // 这里稍等片刻再触发一次，让模块用真实数据重新渲染，把交互补回来。
      // 延迟不宜太长，否则用户会看到明显的「旧内容 → 新内容」跳变。
      setTimeout(function () {
        try {
          var hook = window['onShow_' + snap.module];
          if (typeof hook === 'function') hook();
        } catch (e) {}
        // v3.32：模块重渲染会重置列表滚动 → 这里再补一次阅读位置
        _restoreScrollers(snap);
        if (snap.rootScroll && (snap.rootScroll.top || snap.rootScroll.left)) {
          try { window.scrollTo(snap.rootScroll.left || 0, snap.rootScroll.top || 0); } catch (e) {}
        }
      }, 300);
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
  }

  // ===== 保存调度（v3.28 优化）：高频事件防抖合并，页面销毁前立即 flush =====
  // 折叠瞬间 pagehide/visibilitychange/resize/visualViewport 会连续触发多次保存，
  // 每次都要序列化全部 panel innerHTML(~60KB) + 写 sessionStorage。低端手机折叠瞬间
  // 主线程繁忙会加剧卡顿。统一为单一调度：resize/visualViewport 只防抖调度一次；
  // pagehide/visibilitychange(hidden) 视为「页面即将销毁」，立即 flush 最新状态。
  var _saveTimer = null;
  function _scheduleSave(delay) {
    if (_saveTimer) clearTimeout(_saveTimer);
    _saveTimer = setTimeout(function () {
      _saveTimer = null;
      savePageState();
    }, delay || 250);
  }
  function _flushSave() {
    if (_saveTimer) { clearTimeout(_saveTimer); _saveTimer = null; }
    // 无论是否有 pending 都保存一次：确保销毁前最后一刻状态（草稿/滚动/弹窗）不丢
    savePageState();
  }

  // pagehide 在页面卸载/销毁前必触发（比 beforeunload 更可靠，且不阻塞）
  window.addEventListener('pagehide', _flushSave);
  // visibilitychange→隐藏：折叠屏合上时先触发隐藏，立即存一份
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'hidden') _flushSave();
  });
  // 兜底：页面 resize 结束（折叠/旋转完成）防抖存一次，确保最新滚动位置不丢
  window.addEventListener('resize', function () { _scheduleSave(300); });

  // 折叠屏专用：visualViewport 尺寸变化（折叠/展开动作本身）防抖处理。
  // 仅做轻量布局重算 + 防抖存快照，不触发任何业务重渲染，避免折叠抖动导致页面重构。
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
        _scheduleSave(250);
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
