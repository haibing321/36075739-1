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
  window.AppRegistry.rule = {
    search: (kw) => (typeof window.getRulesData === 'function')
      ? window.getRulesData().filter(r => ((r.title || '') + ' ' + (r.content || '')).toLowerCase().indexOf(String(kw || '').toLowerCase()) !== -1)
      : []
  };
  window.AppRegistry.issue = {
    search: (kw) => (typeof window.getIssueData === 'function')
      ? window.getIssueData().filter(i => ((i.content || '') + ' ' + (i.category || '') + ' ' + (i['性质'] || '') + ' ' + (i.unit || '')).toLowerCase().indexOf(String(kw || '').toLowerCase()) !== -1)
      : []
  };

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
          const total = (document.getElementById('handbook-total') || {}).textContent || '0';
          return `当前在【检查手册】模块，共 ${total} 条目`;
        });
        break;
      case 'panel-diary':
        safePart('diary', () => {
          const count = (document.getElementById('diary-count') || {}).textContent || '0';
          return `当前在【工作日志】模块，已有 ${count} 条日志`;
        });
        break;
      case 'panel-phone':
        safePart('phone', () => {
          const raw = (document.getElementById('phone-recordCount') || {}).textContent || '0';
          const count = String(raw).replace(/条/g, '').trim() || '0';
          return `当前在【应急电话】模块，共 ${count} 条通讯录`;
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
  const CACHE_TTL = 3600000; // 1 小时
  const _CACHE_KEY = 'unified_semantic_cache_v1';
  const _CACHE_MAX = 80;
  function _hash(s) { let h = 0; for (let i = 0; i < s.length; i++) { h = ((h << 5) - h) + s.charCodeAt(i); h |= 0; } return 'u_' + h; }
  function _cacheKey(q, ctx) { return _hash(q + '|' + (ctx || '').slice(0, 50)); }
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
  _loadCache();

  // ---------- 4. 输出卡片化渲染（XSS 安全：先 DOMPurify，再安全增强；用 data-* + 事件委托避免内联 onclick） ----------
  function renderCard(html) {
    if (!window.ENABLE_UNIFIED) return html;
    if (!html) return html;
    // 1) 先净化 AI 产出（原本 dsMarkdown 不净化，这里补一层安全防护）
    if (typeof DOMPurify !== 'undefined' && DOMPurify.sanitize) {
      try { html = DOMPurify.sanitize(html, { ADD_ATTR: ['target', 'data-rule', 'data-phone'] }); } catch (e) {}
    }
    // 2) 规章引用《xxx》转为可点击卡片
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
      if (bubble._enhContent === entry.content) return; // 内容未变，跳过（防循环）
      _enhancing = true;
      try {
        // 思考过程（reasoning_content）折叠块：保留 DeepSeek V4 思考模式产出，
        // 避免卡片化重渲染只取 entry.content 而把思考过程丢弃。
        var reasoningHtml = '';
        if (entry.reasoning) {
          var _esc = (typeof window.dsEsc === 'function') ? window.dsEsc : function(s){ return String(s).replace(/</g, '&lt;'); };
          reasoningHtml = '<details class="ds-reasoning" open><summary>💭 思考过程</summary><div class="ds-reasoning-body">' + _esc(entry.reasoning) + '</div></details>';
        }
        bubble.innerHTML = reasoningHtml + renderCard(md(entry.content));
        bubble._enhContent = entry.content;
        // 重新挂载反馈按钮（复制/下载/有用/无用/重生成/朗读）
        if (typeof window._addFeedbackButtons === 'function') {
          try { window._addFeedbackButtons(bubble, entry.content); } catch (e) {}
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

  // ---------- 5. 前端预聚合（风险研判专用，作为独立工具暴露） ----------
  function preAggregateIssueData(records) {
    if (!records || records.length === 0) return null;
    const catCount = {}, unitCount = {};
    records.forEach(r => {
      const cat = r.category || '其他';
      catCount[cat] = (catCount[cat] || 0) + 1;
      const unit = r.unit || '未知';
      unitCount[unit] = (unitCount[unit] || 0) + 1;
    });
    const topCats = Object.entries(catCount).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([k, v]) => `${k}(${v}次)`);
    const topUnits = Object.entries(unitCount).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, v]) => `${k}(${v}次)`);
    return { total: records.length, topCats: topCats, topUnits: topUnits, catCount: catCount, unitCount: unitCount };
  }
  function enrichRiskPrompt(basePrompt, records) {
    const agg = preAggregateIssueData(records);
    if (!agg) return basePrompt;
    return basePrompt + `\n【数据预聚合统计】\n总记录数：${agg.total}\n问题分布：${agg.topCats.join('、')}\n责任单位分布：${agg.topUnits.join('、')}\n请基于上述统计进行风险研判，不得编造不存在的数据。`;
  }
  window.preAggregateIssueData = preAggregateIssueData;
  window.enrichRiskPrompt = enrichRiskPrompt;

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
  function formatWeather(w, st) {
    const name = w.station || st;
    let md = '🌤️ **' + name + ' 天气**';
    if (w.current) {
      md += '\n\n当前：' + (w.current.weatherEmoji || '') + ' ' + w.current.weather + '，' + w.current.temp + (w.current.wind ? '，风力 ' + w.current.wind : '');
    }
    if (w.daily && w.daily.time && w.daily.time.length) {
      md += '\n\n**未来 7 天预报**\n\n';
      md += '| 日期 | 天气 | 最高 | 最低 | 降水 | 风力 |\n| --- | --- | --- | --- | --- | --- |\n';
      const weekday = ['周日','周一','周二','周三','周四','周五','周六'];
      for (let i = 0; i < w.daily.time.length; i++) {
        const d = w.daily.time[i];
        const mmdd = d.slice(5);
        let dow = '';
        try { dow = weekday[new Date(d + 'T00:00:00').getDay()]; } catch (_) {}
        const code = w.daily.weather_code[i];
        const wtxt = _WMO_TEXT[code] || ('代码' + code);
        const emo = _WMO_EMOJI[code] || '🌡️';
        const hi = Math.round(w.daily.tmax[i]);
        const lo = Math.round(w.daily.tmin[i]);
        const pr = (w.daily.precip[i] != null ? w.daily.precip[i] : 0);
        const wd = (w.daily.wind[i] != null ? Math.round(w.daily.wind[i]) : '-');
        md += '| ' + mmdd + ' ' + dow + ' | ' + emo + ' ' + wtxt + ' | ' + hi + '° | ' + lo + '° | ' + pr + '% | ' + wd + 'km/h |\n';
      }
    }
    md += '\n\n_数据来源：Open-Meteo 公开天气 API_';
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
            _pushAssistant(ans);
            input.value = '';
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
            try {
              const w = await window.queryWeather({ stationName: st });
              if (w && w.ok) {
                if (STRONG_TASK.test(question)) {
                  // 强任务：交给原路由（天气站名已随 question 带入任务文本，不抢答）
                } else if (!COMPOSITE_HINT.test(question)) {
                  // 纯天气询问：直接返回卡片
                  _pushAssistant(formatWeather(w, st));
                  input.value = '';
                  return;
                } else {
                  // 复合问题：注入天气上下文，直接走 AI 流综合回答（气泡仍显示用户原话）
                  let finalText = question + '\n\n[参考天气信息·' + st + ']\n' + formatWeather(w, st);
                  const validAttach = (window._dsAttachments || []).filter(Boolean);
                  if (validAttach.length) {
                    finalText += '\n\n【附件内容】\n' + validAttach.map(function(a) { return '--- 文件：' + a.name + ' ---\n' + a.text; }).join('\n\n');
                    window._dsAttachments = [];
                  }
                  const hist = (typeof window.getDsHistory === 'function') ? window.getDsHistory() : null;
                  if (hist && typeof window.dsRenderAll === 'function') {
                    hist.push({ role: 'user', content: finalText, displayText: question });
                    window.dsRenderAll();
                    await window._dsRunStream(finalText);
                  } else {
                    input.value = finalText;
                    await _origSend.apply(this, arguments);
                  }
                  input.value = '';
                  if (input.style) input.style.height = '';
                  return;
                }
              } else {
                // 本地未查到该车站天气（不在电话簿/内置字典，或查询失败）→ 自动联网搜索，不返回"未找到"
                // 流式阶段会显示「🌐 正在联网搜索…」作为降级提示
                window._dsForceWebSearch = true;
                await _origSend.apply(this, arguments);
                input.value = '';
                if (input.style) input.style.height = '';
                return;
              }
              // 天气查询失败 / 未找到车站 / 强任务 → 退化为普通对话或原路由（交给 AI，不再抢答天气）
            } catch (e) {}
          }
        }
      }

      // 语义缓存命中
      const cached = getCachedAnswer(question, ctx);
      if (cached) {
        _pushAssistant(cached + '\n\n📌 来自缓存（如需最新可重新提问）');
        input.value = '';
        return;
      }

      // 否则走原有逻辑（含命令路由/子模块/意图识别/流式生成）
      await _origSend.apply(this, arguments);

      // 生成完成后缓存答案（跳过错误提示，避免缓存无效回复）
      try {
        const hist = (typeof window.getDsHistory === 'function') ? window.getDsHistory() : [];
        const last = [].concat(hist).reverse().find(m => m.role === 'assistant');
        if (last && last.content && !last.content.startsWith('❌')) {
          setCachedAnswer(question, ctx, last.content);
        }
      } catch (e) {}
    };
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
