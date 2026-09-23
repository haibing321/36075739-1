// ============================================================
// src/js/modules/unified-enhancements.js
// 全域统一升级 – Tier 1 + Tier 2（适配本项目真实 API 的增量版本）
// 功能：上下文注入 / 电话AI工具 / 卡片渲染 / 语义缓存 / 预聚合 / 通话日志联动
// 设计原则：纯增量、自带降级开关、不破坏现有逻辑、XSS 安全（DOMPurify + 事件委托）
// ============================================================
(function () {
  'use strict';

  // ---------- 全局开关（紧急降级） ----------
  window.ENABLE_UNIFIED = true; // 设为 false 可瞬间关闭所有新功能（控制台执行 window.ENABLE_UNIFIED=false）

  const log = (m, d) => { if (window.ENABLE_UNIFIED && window.console) try { console.log('[Unified]', m, d || ''); } catch (e) {} };

  // ---------- 1. 数据总线（注册模块查询函数，使用本项目真实字段） ----------
  window.AppRegistry = window.AppRegistry || {};

  // 电话：真实字段为 站名/单位/线名/路电/市电（非模板假设的 station/phone）
  window.AppRegistry.phone = {
    search: (kw) => {
      const data = (typeof window.getPhoneData === 'function') ? window.getPhoneData() : [];
      if (!kw) return [];
      const q = String(kw).toLowerCase();
      return data.filter(it =>
        (it.站名 && it.站名.toLowerCase().indexOf(q) !== -1) ||
        (it.单位 && it.单位.toLowerCase().indexOf(q) !== -1) ||
        (it.线名 && it.线名.toLowerCase().indexOf(q) !== -1)
      );
    }
  };
  // 【v3.74 清理】原 AppRegistry.rule / AppRegistry.issue 已删除：整表 indexOf 的第三套检索实现，
  // 全仓无调用点（仅 AppRegistry.phone.search 在用）。规章/检查信息统一走 KB（knowledge.js）。

  // ---------- 2. 智能上下文注入（自动感知当前 Tab，使用真实 API） ----------
  function getTabContext() {
    if (!window.ENABLE_UNIFIED) return '';
    let active = null;
    try { active = document.querySelector('.panel.active'); } catch (e) { active = null; }
    if (!active) return '';
    const id = active.id;
    const parts = [];
    // 每个模块独立 try-catch：单个模块未加载/抛错只跳过该模块，不拖垮整个上下文注入
    function safePart(label, fn) {
      try {
        const s = fn();
        if (s) parts.push(s);
      } catch (e) {
        log('tab context [' + label + '] 构建失败，已跳过', (e && e.message) || e);
      }
    }
    switch (id) {
      case 'panel-issue':
        safePart('issue', () => {
          const data = (typeof window.getIssueData === 'function') ? window.getIssueData() : [];
          const recent = data.slice(-3).map(i => `${i.datetime || ''} ${i.category || ''} ${(i.content || '').slice(0, 40)}`).join('；');
          return `当前在【检查信息】模块，共 ${data.length} 条记录，最近：${recent}`;
        });
        break;
      case 'panel-rule':
        safePart('rule', () => {
          const data = (typeof window.getRulesData === 'function') ? window.getRulesData() : [];
          const trades = [...new Set(data.map(r => r.trade).filter(Boolean))];
          return `当前在【规章制度】模块，共 ${data.length} 条，专业：${trades.join('、')}`;
        });
        break;
      case 'panel-handbook':
        safePart('handbook', () => {
          // 原实现从 #handbook-total 读，但该元素已随改版移除，取到的恒为 '0'，
          // 导致智能体在手册模块时始终认为「共 0 条目」。改为直接读数据源。
          const data = (typeof window.getHandbookData === 'function') ? window.getHandbookData() : [];
          return `当前在【检查手册】模块，共 ${data.length} 条目`;
        });
        break;
      case 'panel-diary':
        safePart('diary', () => {
          // 同上：#diary-count 不存在，恒为 '0'
          const diary = (typeof window.getDiaryData === 'function') ? window.getDiaryData() : [];
          return `当前在【工作日志】模块，已有 ${diary.length} 条日志`;
        });
        break;
      case 'panel-phone':
        safePart('phone', () => {
          // 同上：#phone-recordCount 不存在，恒为 '0'
          const phones = (typeof window.getPhoneData === 'function') ? window.getPhoneData() : [];
          return `当前在【应急电话】模块，共 ${phones.length} 条通讯录`;
        });
        break;
    }
    const summary = parts.join('｜');
    return summary ? `【当前模块上下文】${summary}` : '';
  }
  function refreshTabContext() {
    window.UNIFIED_TAB_CONTEXT = getTabContext();
    log('context updated', window.UNIFIED_TAB_CONTEXT);
  }

  // 包装 switchTab 以触发上下文更新 + 派发 tabChanged 事件（补丁，不破坏原逻辑）
  const _origSwitchTab = window.switchTab;
  if (typeof _origSwitchTab === 'function') {
    window.switchTab = function (tab, fromSwipe) {
      const r = _origSwitchTab(tab, fromSwipe);
      try { refreshTabContext(); } catch (e) {}
      try { document.dispatchEvent(new CustomEvent('tabChanged', { detail: { tab: tab } })); } catch (e) {}
      return r;
    };
  }
  document.addEventListener('tabChanged', (e) => { log('tab switched', e.detail && e.detail.tab); });
  if (document.readyState !== 'loading') refreshTabContext();
  else document.addEventListener('DOMContentLoaded', refreshTabContext);

  // ---------- 3. 语义缓存（基于问题+上下文指纹，1 小时 TTL，持久化到 localStorage） ----------
  const _cache = new Map();
  // 【2026-09-21】TTL 1 小时 → **15 分钟**：数据指纹只能感知"条数变化"，而**就地编辑**
  //   （改一条规章内容、改一条台账性质）条数不变 → 键不变，旧结论仍会命中。缩短 TTL 兜住这类场景。
  //   可用 localStorage：`ds_sem_cache_ttl_min`（分钟，0 = 关闭缓存）覆盖。
  const CACHE_TTL = (function () {
    try {
      const v = localStorage.getItem('ds_sem_cache_ttl_min');
      if (v !== null) {
        const n = parseInt(v, 10);
        if (!isNaN(n) && n >= 0) return n * 60000;
      }
    } catch (e) {}
    return 15 * 60000;
  })();
  const _CACHE_KEY = 'unified_semantic_cache_v1';
  const _CACHE_MAX = 80;
  function _hash(s) { let h = 0; for (let i = 0; i < s.length; i++) { h = ((h << 5) - h) + s.charCodeAt(i); h |= 0; } return 'u_' + h; }
  // 【2026-09-21】缓存键加入「数据指纹 + 当前模型」，并提供全局失效入口：
  //   原键只有 `hash(问题 + 上下文前 50 字)` → ① 导入/删除数据后 1 小时内仍复读旧结论；
  //   ② 换模型或改数据源后仍命中旧答案（用户会以为"没生效"）。现在数据条数或模型一变，键就变，
  //   旧条目自然不再命中；同时暴露 window.__dsSemCacheClear 供"数据导入/清空"时主动清空。
  function _dataSig() {
    try {
      const n = function (f) { try { return (typeof window[f] === 'function' ? (window[f]() || []).length : 0); } catch (e) { return 0; } };
      return n('getIssueData') + '-' + n('getRulesData') + '-' + n('getHandbookData') + '-' + n('getPhoneData') + '-' + n('getDiaryData')
        + '-' + (localStorage.getItem('ds_model_v1') || '');
    } catch (e) { return 'na'; }
  }
  function _cacheKey(q, ctx) { return _hash(q + '|' + (ctx || '').slice(0, 50) + '|' + _dataSig()); }
  // 启动时从 localStorage 载入未过期项（并回写裁剪，清除已过期项避免存储膨胀）
  function _loadCache() {
    try {
      const raw = localStorage.getItem(_CACHE_KEY);
      if (!raw) return;
      const obj = JSON.parse(raw);
      const now = Date.now();
      for (const k in obj) {
        if (obj[k] && (now - obj[k].t) < CACHE_TTL) _cache.set(k, obj[k]);
      }
      _saveCache();
      log('cache loaded', _cache.size);
    } catch (e) {}
  }
  // 将内存缓存落盘（裁剪超量项）
  function _saveCache() {
    try {
      if (_cache.size > _CACHE_MAX) {
        const arr = Array.from(_cache.entries()).sort((a, b) => a[1].t - b[1].t);
        arr.slice(0, _cache.size - _CACHE_MAX).forEach(e => _cache.delete(e[0]));
      }
      const now = Date.now();
      const obj = {};
      _cache.forEach(function (v, k) { if ((now - v.t) < CACHE_TTL) obj[k] = v; });
      localStorage.setItem(_CACHE_KEY, JSON.stringify(obj));
    } catch (e) {}
  }
  function getCachedAnswer(q, ctx) {
    if (!window.ENABLE_UNIFIED) return null;
    const e = _cache.get(_cacheKey(q, ctx));
    if (e && (Date.now() - e.t) < CACHE_TTL) { log('cache hit'); return e.a; }
    return null;
  }
  function setCachedAnswer(q, ctx, a) {
    if (!window.ENABLE_UNIFIED || !a) return;
    _cache.set(_cacheKey(q, ctx), { a: a, t: Date.now() });
    _saveCache();
  }
  /** 主动清空语义缓存（数据导入/清空/编辑后调用；也可在控制台手动执行） */
  window.__dsSemCacheClear = function () {
    try { _cache.clear(); localStorage.removeItem(_CACHE_KEY); log('cache cleared'); return true; } catch (e) { return false; }
  };
  // 【2026-09-21】把"数据变更"与"缓存失效"接起来：各模块导入/编辑/清空数据时都会调
  //   window.dsInvalidateRagCache(key)（统一收口点）→ 顺手清掉语义缓存，避免复读旧结论。
  (function () {
    var orig = window.dsInvalidateRagCache;
    if (typeof orig === 'function' && !orig.__semHooked) {
      var wrapped = function () {
        try { window.__dsSemCacheClear(); } catch (e) {}
        try { if (typeof window.__agentToolCacheClear === 'function') window.__agentToolCacheClear(); } catch (e) {}
        return orig.apply(this, arguments);
      };
      wrapped.__semHooked = true;
      window.dsInvalidateRagCache = wrapped;
    }
  })();
  _loadCache();

  // ---------- 4. 输出卡片化渲染（XSS 安全：先 DOMPurify，再安全增强；用 data-* + 事件委托避免内联 onclick） ----------
  function renderCard(html) {
    if (!window.ENABLE_UNIFIED) return html;
    if (!html) return html;

    // 0a) 先抽离媒体块（ds-media-*）—— **绕开 DOMPurify 的解析触发二次 fetch**
    // (2026-09-12 实测定位：DOMPurify.sanitize 内部 setAttribute('src', …) 会让同 URL 被请求 2 次)
    // 媒体块的 src 已在 dsMediaBlock 里做过协议白名单（dsSafeUrl），再次净化收益有限、代价是双倍下载。
    // 用 DOMParser 抽取顶层 .ds-media 元素，留在占位符位，还原时按位置插回。
    var _mediaArr = [];
    if (/<(?:figure|div)\s+[^>]*class=["'][^"']*\bds-media\b/.test(html)) {
      try {
        var _doc = new DOMParser().parseFromString('<div id="__root__">' + html + '</div>', 'text/html');
        var _root = _doc.getElementById('__root__');
        var _nodes = _root ? _root.querySelectorAll('.ds-media') : [];
        // 反向遍历（先处理深层后处理浅层），避免 replaceChild 让 querySelectorAll 索引漂移
        for (var _i = _nodes.length - 1; _i >= 0; _i--) {
          var _el = _nodes[_i];
          var _ph = _doc.createElement('span');
          // ⚠️ 占位符编号必须用「文档顺序下标 _i」，不能写 _mediaArr.length：
          // 本循环是倒序遍历 + unshift，mediaArr 要到循环结束才排成文档顺序，
          // 边遍历边取长度得到的是**反序下标**，还原时媒体块整体颠倒
          //（实测：回复里 clip_a 在前，渲染成 clip_b 在前，播放器落到错误的段落下面）。
          _ph.setAttribute('data-ds-media', String(_i));
          _mediaArr.unshift(_el.outerHTML);
          _el.parentNode.replaceChild(_ph, _el);
        }
        html = _root.innerHTML;
      } catch (e) { /* DOMParser 失败就退回原路径 —— 安全仍由下方 DOMPurify 兜底 */ }
    }

    // 0b) 再保护媒体/链接 URL：URL 中可能含 11 位连续数字，会被下方"电话自动拨号"规则误伤
    var _urls = [];
    html = html.replace(/(https?:\/\/[^\s"'`<]+)/g, function (u) {
      _urls.push(u);
      return '@@DSURL@@' + (_urls.length - 1) + '@@';
    });
    // 1) 规章引用《xxx》转为可点击卡片
    // 注意顺序：净化必须放在【所有字符串拼接之后】。data-rule / data-phone 的值直接来自
    // 正则捕获组（未转义），若先净化再拼接，值里的引号会提前闭合属性，
    // 例如 《"><img src=x onerror=alert(1)》 会注入可执行标签，净化形同虚设。
    html = html.replace(/《([^》]+)》/g, '<span class="rule-ref" data-rule="$1">《$1》</span>');
    // 3) 风险等级加图标
    const riskMap = { '高风险': '🔴', '中风险': '🟡', '低风险': '🟢', '橙色': '🔴', '黄色': '🟡', '蓝色': '🟢' };
    for (const k in riskMap) {
      if (!Object.prototype.hasOwnProperty.call(riskMap, k)) continue;
      const repl = riskMap[k] + ' ' + k;
      let idx = html.indexOf(k);
      while (idx !== -1) { html = html.slice(0, idx) + repl + html.slice(idx + k.length); idx = html.indexOf(k, idx + repl.length); }
    }
    // 4) 电话号码自动加拨号按钮（不使用内联 onclick，改用事件委托）
    html = html.replace(/(\d{3,4}-\d{7,8}|\d{11})/g,
      '<span class="phone-number" data-phone="$1">$1 <button type="button" class="btn-call" data-phone="$1">📞 拨号</button></span>');
    // 6) 还原被保护的 URL
    html = html.replace(/@@DSURL@@(\d+)@@/g, function (m, i) { return (_urls[+i] != null) ? _urls[+i] : ''; });
    // 5) 最后统一净化 AI 产出（媒体块已抽走，无需放行 media 标签）
    if (typeof DOMPurify !== 'undefined' && DOMPurify.sanitize) {
      try {
        html = DOMPurify.sanitize(html);
      } catch (e) {}
    }
    // 7) 还原媒体块到原位置
    if (_mediaArr.length) {
      html = html.replace(/<span\s+[^>]*data-ds-media=["'](\d+)["'][^>]*>\s*<\/span>/g, function (m, i) {
        var n = parseInt(i, 10);
        return (n >= 0 && n < _mediaArr.length) ? _mediaArr[n] : '';
      });
    }
    return html;
  }

  // 卡片渲染通过 MutationObserver 应用到 #ds-chat-box 中的每条助手气泡，
  // 从 dsHistory 原始 markdown 重渲染（流式/重渲染均幂等），并保留反馈按钮。
  let _enhancing = false;
  function enhanceBubbles() {
    if (!window.ENABLE_UNIFIED) return;
    const box = document.getElementById('ds-chat-box');
    if (!box) return;
    const md = (typeof window.dsMarkdown === 'function') ? window.dsMarkdown : null;
    const hist = (typeof window.getDsHistory === 'function') ? window.getDsHistory() : [];
    if (!md) return;
    const bubbles = box.querySelectorAll('.ds-bubble-assistant[data-ds-idx]');
    bubbles.forEach((bubble) => {
      const idx = parseInt(bubble.getAttribute('data-ds-idx'), 10);
      const entry = (idx >= 0 && hist[idx]) ? hist[idx] : null;
      if (!entry || !entry.content) return;
      // 跳过判定必须把「联网检索证据」和「智能体执行步骤」也算进去：
      //   否则同一段正文在检索状态/步骤变化时不会重绘（v3.76 新增 agentSteps）
      const _enhKey = entry.content + '||' + (entry.web ? JSON.stringify(entry.web) : '') + '||' + ((entry.agentSteps && entry.agentSteps.length) || 0);
      if (bubble._enhContent === _enhKey) return; // 内容未变，跳过（防循环）
      _enhancing = true;
      try {
        // 思考过程（reasoning_content）折叠块：保留 DeepSeek V4 思考模式产出，
        // 避免卡片化重渲染只取 entry.content 而把思考过程丢弃。
        var reasoningHtml = '';
        if (entry.reasoning) {
          var _esc = (typeof window.dsEsc === 'function') ? window.dsEsc : function(s){ return String(s).replace(/</g, '&lt;'); };
          reasoningHtml = '<details class="ds-reasoning" open><summary>💭 思考过程</summary><div class="ds-reasoning-body">' + _esc(entry.reasoning) + '</div></details>';
        }
        // 联网检索证据条（是否真的联网/检索了几次）：同样必须在这里重建，
        // 否则本函数会把 dsBubbleInner 刚渲染好的证据条覆盖掉。
        var webHtml = '';
        try { if (typeof window.dsWebChip === 'function') webHtml = window.dsWebChip(entry) || ''; } catch (e) {}
        // 【v3.76】智能体执行步骤（计划/工具卡片）：与 reasoning、webHtml 同理 —— 本函数是从
        //   entry.content 重新建 HTML 的，凡 dsBubbleInner 会渲染的字段这里都必须一并还原，
        //   否则 /agent 的执行过程卡片会被这里覆盖掉（本函数正是"卡片存消息对象上"之外的第二道关）。
        var agentHtml = '';
        try { if (typeof window.dsAgentStepsHtml === 'function') agentHtml = window.dsAgentStepsHtml(entry.agentSteps) || ''; } catch (e) {}
        // 关键：写入用媒体块复用（doubao.js 的 dsSetHtmlKeepMedia）—— 否则此处的 innerHTML
        // 覆盖会把流式渲染好的播放器/图片销毁，导致浏览器重新发起请求（同 URL 重复下载）。
        // 老 PWA 里没有媒体时直接 innerHTML 即可，性能也最快；这里只在有媒体时多走一次遍历。
        var _dsSet = (typeof window.dsSetHtmlKeepMedia === 'function') ? window.dsSetHtmlKeepMedia : null;
        var _nextHtml = reasoningHtml + agentHtml + webHtml + renderCard(md(entry.content));
        if (_dsSet) _dsSet(bubble, _nextHtml);
        else bubble.innerHTML = _nextHtml;
        bubble._enhContent = _enhKey;
        // 重新挂载反馈按钮（复制/下载/有用/无用/重生成/朗读）
        // 必须带上本轮下标，否则「重生成」会退化成重生成最后一轮
        if (typeof window._addFeedbackButtons === 'function') {
          try { window._addFeedbackButtons(bubble, entry.content, idx); } catch (e) {}
        }
      } catch (e) {}
      _enhancing = false;
    });
  }
  let _enhTimer = null;
  function scheduleEnhance() {
    if (_enhTimer) clearTimeout(_enhTimer);
    _enhTimer = setTimeout(enhanceBubbles, 200);
  }
  function initObserver() {
    const box = document.getElementById('ds-chat-box');
    if (!box) { document.addEventListener('DOMContentLoaded', initObserver); return; }
    const obs = new MutationObserver(function () {
      if (_enhancing) return; // 自身重渲染期间不递归
      scheduleEnhance();
    });
    obs.observe(box, { childList: true, subtree: true, characterData: true });
    enhanceBubbles();
  }
  initObserver();

  // 事件委托：拨号按钮（避免内联 onclick — 项目铁律，且防止 JSON 引号提前闭合属性）
  document.addEventListener('click', function (ev) {
    const t = ev.target;
    if (!t || !t.closest) return;
    const callBtn = t.closest('.btn-call[data-phone]');
    if (callBtn) { ev.preventDefault(); window.dialPhone(callBtn.getAttribute('data-phone')); }
  }, true);

  // ---------- 4.x 拨号工具（同时联动工作日志） ----------
  window.dialPhone = function (number) {
    if (!number) return;
    number = String(number).trim();
    if (!number) return;
    // 原生拨号
    try { window.location.href = 'tel:' + number; } catch (e) {}
    // 联动日志：弹出询问
    if (window.ENABLE_UNIFIED && window.confirm('是否将本次通话记录到工作日志？')) {
      try {
        const now = new Date().toLocaleString();
        const ta = document.getElementById('diary-work');
        if (ta) {
          ta.value = (ta.value ? ta.value + '\n' : '') + `[${now}] 拨打 ${number}`;
          ta.dispatchEvent(new Event('input'));
          window.alert('已记录到工作日志');
        }
      } catch (e) {}
    }
  };

  // 【v3.74 清理】原 preAggregateIssueData / enrichRiskPrompt 已删除：全仓无调用点，
  // 且其统计口径与风险研判自身的 _buildRiskDataSummary（doubao.js）重复。

  // ---------- 5.x 自然语言站台提取（最长子串匹配，规避"删字抠词"失效） ----------
  function _matchLongest(q, fields) {
    const ql = String(q || '').toLowerCase();
    const seen = {};
    const uniq = (fields || []).filter(f => f).map(String).filter(f => {
      if (seen[f]) return false; seen[f] = 1; return true;
    }).sort((a, b) => b.length - a.length);
    for (const c of uniq) { if (ql.indexOf(c.toLowerCase()) !== -1) return c; }
    return null;
  }
  function extractPhoneKeyword(q) {
    const data = (typeof window.getPhoneData === 'function') ? window.getPhoneData() : [];
    const fields = [];
    data.forEach(it => { [it.站名, it.单位, it.线名].forEach(f => { if (f) fields.push(f); }); });
    return _matchLongest(q, fields);
  }
  function extractWeatherStation(q) {
    const fields = [];
    const data = (typeof window.getPhoneData === 'function') ? window.getPhoneData() : [];
    data.forEach(it => { [it.站名, it.单位, it.线名].forEach(f => { if (f) fields.push(f); }); });
    if (Array.isArray(window.queryWeatherStations)) fields.push.apply(fields, window.queryWeatherStations);
    return _matchLongest(q, fields);
  }

  // 将 get_weather 返回的 7 天预报格式化为 Markdown 卡片（dsMarkdown 渲染为表格）
  const _WMO_TEXT = { 0:'晴',1:'少云',2:'多云',3:'阴',45:'雾',48:'雾凇',51:'毛毛雨',53:'小雨',55:'中雨',56:'冻毛雨',57:'冻雨',61:'小雨',63:'中雨',65:'大雨',66:'冻小雨',67:'冻中雨',71:'小雪',73:'中雪',75:'大雪',77:'雪粒',80:'阵雨',81:'强阵雨',82:'暴雨',85:'阵雪',86:'强阵雪',95:'雷暴',96:'雷暴伴冰雹',99:'强雷暴伴冰雹' };
  const _WMO_EMOJI = { 0:'☀️',1:'🌤️',2:'⛅',3:'☁️',45:'🌫️',48:'🌫️',51:'🌦️',53:'🌦️',55:'🌧️',56:'🌧️',57:'🌧️',61:'🌦️',63:'🌧️',65:'🌧️',66:'🌧️',67:'🌧️',71:'🌨️',73:'🌨️',75:'❄️',77:'🌨️',80:'🌦️',81:'🌧️',82:'⛈️',85:'🌨️',86:'🌨️',95:'⛈️',96:'⛈️',99:'⛈️' };
  // 【2026-09-23】降级原因文案（大模型联网不可用时，如实告诉用户为什么退到免费接口）
  const _WS_DEGRADE = {
    'no-key': '未接 API', 'no-websearch-api': '当前配置不可用', 'timeout': '超时',
    'llm-not-found': '未查到该车站', 'llm-unparsed': '返回无法解析', 'llm-empty': '返回为空',
    'network': '网络不可达', 'llm-skipped': '已关闭'
  };
  /** 数值兜底：null/NaN 一律 '—'（大模型路径个别字段可能没给） */
  const _numOr = (v, suf) => (v == null || v === '' || !isFinite(Number(v))) ? '—' : (Math.round(Number(v)) + (suf || ''));
  function formatWeather(w, st) {
    const name = w.station || st;
    let md = '🌤️ **' + name + ' 天气**';
    if (w.current) {
      md += '\n\n当前：' + (w.current.weatherEmoji || '') + ' ' + (w.current.weather || '')
          + (w.current.temp ? ('，' + w.current.temp) : '')
          + (w.current.wind ? ('，风力 ' + w.current.wind) : '');
    }
    if (w.daily && w.daily.time && w.daily.time.length) {
      md += '\n\n**未来 7 天预报**\n\n';
      md += '| 日期 | 天气 | 最高 | 最低 | 降水 | 风力 |\n| --- | --- | --- | --- | --- | --- |\n';
      const weekday = ['周日','周一','周二','周三','周四','周五','周六'];
      for (let i = 0; i < w.daily.time.length; i++) {
        const d = w.daily.time[i] || '';
        const mmdd = d.slice(5);
        let dow = '';
        try { dow = weekday[new Date(d + 'T00:00:00').getDay()] || ''; } catch (_) {}
        const code = w.daily.weather_code[i];
        // 大模型路径带的是天气原文/表情，优先用原文（更贴近检索到的实况）
        const wtxt = (w.daily.weatherText && w.daily.weatherText[i]) || _WMO_TEXT[code] || ('代码' + code);
        const emo = (w.daily.emoji && w.daily.emoji[i]) || _WMO_EMOJI[code] || '🌡️';
        const hi = _numOr(w.daily.tmax[i], '');
        const lo = _numOr(w.daily.tmin[i], '');
        const pr = _numOr(w.daily.precip[i], '');
        const wd = _numOr(w.daily.wind[i], '');
        md += '| ' + mmdd + ' ' + dow + ' | ' + emo + ' ' + wtxt + ' | ' + hi + '° | ' + lo + '° | ' + pr + '% | ' + wd + 'km/h |\n';
      }
    }
    // 数据来源必须写明：用户要的是"优先大模型联网，兜底免费"，那就得看得出这一条到底走了哪条路
    if (w.source === 'llm') {
      md += '\n\n_🌐 数据来源：大模型联网检索_';
    } else if (w.source === 'free') {
      md += '\n\n_🛰 数据来源：免费公开天气接口（Open-Meteo）'
          + (w.degraded ? '；大模型联网' + (_WS_DEGRADE[w.degraded] || '不可用') + '，已自动保底' : '') + '_';
    } else {
      md += '\n\n_数据来源：Open-Meteo 公开天气 API_';
    }
    return md;
  }

  // ---------- 6. 包装 dsSendMsg：集成上下文注入 / 电话工具 / 语义缓存（不破坏原逻辑） ----------
  const _origSend = window.dsSendMsg;
  if (typeof _origSend === 'function') {
    window.dsSendMsg = async function () {
      if (!window.ENABLE_UNIFIED) return _origSend.apply(this, arguments);

      const input = document.getElementById('ds-user-input');
      const question = input ? input.value.trim() : '';
      if (!question) return;

      // 发送前刷新当前模块上下文（供 doubao.js 注入系统提示）
      refreshTabContext();
      const ctx = window.UNIFIED_TAB_CONTEXT || '';

      // 电话意图：直接调用工具并返回（跳过 AI）
      // 用最长子串匹配站名/单位/线名，支持口语化问法（"查一下兰州站的电话"）
      if (/电话|号码|联系方式|拨打/.test(question)) {
        const kw = extractPhoneKeyword(question);
        if (kw) {
          const results = window.AppRegistry.phone.search(kw);
          if (results.length) {
            let ans = `找到 ${results.length} 个相关联系电话：`;
            results.slice(0, 5).forEach(it => {
              ans += `\n• ${it.站名 || ''} ${it.单位 || ''} 路电:${it.路电 || '-'} 市电:${it.市电 || '-'}`;
            });
            // 必须同时补上用户这条消息：否则聊天区只冒出 AI 回答，
            // 用户刚问的话没有气泡，与同一函数内复合天气分支的行为也不一致
            _pushUser(question);
            _pushAssistant(ans);
            input.value = '';
            if (input.style) input.style.height = '';
            return;
          }
        }
      }

      // 天气意图处理（修复：复合问题中只回天气、忽略其它内容的痛点）
      //   纯天气询问（无其它任务意图）→ 直接返回天气卡片（保留快速体验）
      //   复合问题（含分析/总结/说明/安排等）→ 将天气作为上下文注入，交给 AI 综合回答，不再忽略其它内容
      //   强任务（写报告/对规/风险等）→ 不拦截，交给原路由（不打断用户对这些功能的预期）
      if (/天气|气温|温度|气象|多少度|下雨|下雪|风力|湿度/.test(question)) {
        if (typeof window.queryWeather === 'function') {
          const st = extractWeatherStation(question);
          if (st) {
            const STRONG_TASK = /写报告|生成.*报告|起草|撰写|月度总结|整改通知书|对规|违反|违章|不符合|哪条规章|风险|趋势|研判|预警/;
            const COMPOSITE_HINT = /分析|总结|说明|影响|安排|计划|方案|措施|建议|给我|帮我|评估|预测|制定|规划|梳理|整理|对比|检查|报告|通知|通报|安全|作业|施工|防洪|排查|注意|根据|结合|考虑|处理|应对|防范/;
            // 强任务（写报告/对规/风险/班组安排…）：完全交给原路由，**不预查天气**
            //   （原来会先查一次天气再丢弃，纯浪费一次大模型联网）
            if (!STRONG_TASK.test(question)) {
              let ph = null;
              try {
                // 【2026-09-23 修复用户反馈"发送后半天没反应"】
                //   先出用户气泡 + 一条"正在联网检索"占位，再去查天气；查到后把占位**原地替换**成卡片。
                //   原来顺序反了（先 await 5~20s，界面上什么都不动）。
                _pushUser(question);
                input.value = '';
                if (input.style) input.style.height = '';
                ph = _pushProgressBubble('🌐 正在联网检索「' + st + '」的天气…\n\n_（优先大模型联网；未接 API 或检索不到会自动改用免费数据源，一般 5~20 秒）_');
                // 联网上限收窄到 15s：超时立刻走保底，不让用户干等
                const w = (typeof window.queryWeatherSmart === 'function')
                  ? await window.queryWeatherSmart(st, { timeoutMs: 15000 })
                  : await window.queryWeather({ stationName: st });
                if (w && w.ok) {
                  const card = formatWeather(w, st);
                  if (!COMPOSITE_HINT.test(question)) {
                    _updateBubble(ph, card);                       // 占位先变卡片：天气数据先给出来
                    // 【2026-09-23 用户反馈"以前查完天气还会根据天气进行工作提示，现在没了"】
                    //   那段提示原本是"天气问题落到模型手里时模型自己附上的"，取值链变可靠后就消失了。
                    //   现在显式补上：大模型基于天气生成（不带联网，快），未接 API 用规则化保底。
                    try {
                      if (typeof window.weatherWorkTips === 'function') {
                        const tips = await window.weatherWorkTips(w, st);
                        if (tips) _updateBubble(ph, card + '\n\n**🛡️ 工作提示**\n\n' + tips);
                      }
                    } catch (e) {}
                    return;
                  }
                  // 复合问题：把天气并进最后一条用户消息，交给 AI 流综合回答（气泡仍只显示用户原话）
                  let finalText = question + '\n\n[参考天气信息·' + st + ']\n' + card;
                  const validAttach = (window._dsAttachments || []).filter(Boolean);
                  if (validAttach.length) {
                    finalText += '\n\n【附件内容】\n' + validAttach.map(function(a) { return '--- 文件：' + a.name + ' ---\n' + a.text; }).join('\n\n');
                    window._dsAttachments = [];
                  }
                  _dropBubble(ph);
                  if (_injectIntoLastUser(finalText) && typeof window._dsRunStream === 'function') {
                    if (typeof window.dsRenderAll === 'function') window.dsRenderAll();
                    await window._dsRunStream(finalText);
                  } else {
                    _pushAssistant(finalText);                     // 极端降级：至少把结果给出来
                  }
                  return;
                }
                // 查不到（不在字典/电话簿，或大模型与免费接口都失败）→ 撤销占位与预推气泡、复位输入框，
                // 再用原路由强制联网搜索（行为与改造前一致，且不会出现重复气泡）
                _dropBubble(ph); ph = null;
                _dropLastUser();
                input.value = question;
                window._dsForceWebSearch = true;
                await _origSend.apply(this, arguments);
                input.value = '';
                if (input.style) input.style.height = '';
                return;
              } catch (e) {
                // 出异常也要把界面复位，再落到下面的原路由（不能让占位气泡挂在那儿）
                _dropBubble(ph);
                _dropLastUser();
                input.value = question;
                try { if (typeof window.dsRenderAll === 'function') window.dsRenderAll(); } catch (e2) {}
              }
            }
          }
        }
      }

      // 语义缓存命中
      // 【2026-09-21】两类输入**一律不走缓存**：
      //   ① `/` 开头的命令（/agent /check /write /risk …）—— 它们自身不产出 assistant 消息，
      //      写缓存会取到"上一轮的无关回答"挂到命令上，之后执行同一命令直接返回旧答案、模块不再触发；
      //   ② 本轮用工具查过数据的回答 —— 数据可能已变，缓存旧结论还会让用户误以为"没调用工具"。
      const _noCacheIn = /^\s*\//.test(String(question || ''));
      const cached = _noCacheIn ? null : getCachedAnswer(question, ctx);
      if (cached) {
        _pushUser(question);
        _pushAssistant(cached + '\n\n📌 来自缓存（如需最新可重新提问）');
        input.value = '';
        if (input.style) input.style.height = '';
        return;
      }

      // 否则走原有逻辑（含命令路由/子模块/意图识别/流式生成）
      window.__dsLastTurnUsedTools = false;   // 由 doubao 侧在真正执行工具调用时置 true
      await _origSend.apply(this, arguments);

      // 生成完成后缓存答案（跳过错误提示 / 命令 / 用过工具的轮次，避免缓存无效或过期结论）
      try {
        if (!_noCacheIn && !window.__dsLastTurnUsedTools) {
          const hist = (typeof window.getDsHistory === 'function') ? window.getDsHistory() : [];
          const last = [].concat(hist).reverse().find(m => m.role === 'assistant');
          if (last && last.content && !last.content.startsWith('❌')) {
            setCachedAnswer(question, ctx, last.content);
          }
        }
      } catch (e) {}
    };
  }

  // 将用户消息推入历史（不渲染，由随后的 _pushAssistant 统一触发 dsRenderAll）
  // displayText：气泡只显示这句话（content 里可以塞进天气上下文/附件等长内容）
  function _pushUser(text, displayText) {
    if (typeof window.getDsHistory === 'function') {
      var hist = window.getDsHistory();
      if (hist) hist.push({ role: 'user', content: text, displayText: displayText || text });
    }
  }

  // ---------- 【2026-09-23 用户反馈"发送后半天没反应"】等待期的可见反馈 ----------
  // 原来天气分支是「先 await 查天气（大模型联网 5~20s）→ 才推用户气泡」，
  // 点击后界面上什么都不动，用户以为卡住了。现在改为：先出用户气泡 + 一条占位提示，
  // 查到结果再把占位**原地替换**成天气卡片（对象引用直接改 content 重渲染）。
  function _pushProgressBubble(text) {
    if (typeof window.getDsHistory !== 'function' || typeof window.dsRenderAll !== 'function') return null;
    var hist = window.getDsHistory();
    if (!hist) return null;
    var msg = { role: 'assistant', content: text };
    hist.push(msg);
    try { window.dsRenderAll(); } catch (e) {}
    return msg;
  }
  function _updateBubble(msg, text) {
    if (!msg) return;
    msg.content = text;
    try { if (typeof window.dsRenderAll === 'function') window.dsRenderAll(); } catch (e) {}
  }
  function _dropBubble(msg) {
    try {
      var hist = (typeof window.getDsHistory === 'function') ? window.getDsHistory() : null;
      if (hist && msg) { var i = hist.indexOf(msg); if (i >= 0) hist.splice(i, 1); }
      if (typeof window.dsRenderAll === 'function') window.dsRenderAll();
    } catch (e) {}
  }
  /** 撤销刚推入的那条用户消息（用于"改走原路由"前复位，避免气泡重复） */
  function _dropLastUser() {
    try {
      var hist = (typeof window.getDsHistory === 'function') ? window.getDsHistory() : null;
      if (!hist || !hist.length) return;
      var last = hist[hist.length - 1];
      if (last && last.role === 'user') hist.pop();
    } catch (e) {}
  }
  /** 复合问题：把天气上下文并进"最后一条用户消息"的 content（气泡仍只显示用户原话） */
  function _injectIntoLastUser(finalText) {
    try {
      var hist = (typeof window.getDsHistory === 'function') ? window.getDsHistory() : null;
      if (!hist) return false;
      for (var i = hist.length - 1; i >= 0; i--) {
        if (hist[i] && hist[i].role === 'user') {
          if (!hist[i].displayText) hist[i].displayText = hist[i].content;
          hist[i].content = finalText;
          return true;
        }
      }
    } catch (e) {}
    return false;
  }

  // 将一条助手消息推入历史并触发渲染（复用已暴露的 dsRenderAll）
  function _pushAssistant(text) {
    if (typeof window.getDsHistory === 'function' && typeof window.dsRenderAll === 'function') {
      window.getDsHistory().push({ role: 'assistant', content: text });
      window.dsRenderAll();
    } else if (typeof window.dsAppendMsg === 'function') {
      window.dsAppendMsg('assistant', text);
    }
  }

  log('Unified enhancements loaded (adapted to real APIs)');
})();
