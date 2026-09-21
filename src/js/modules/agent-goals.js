// ============================================================
// src/js/modules/agent-goals.js
// P3：自主目标管理（主动盯控）
//   用户可通过对话 /goal <关键词> 添加"长期目标"（如"盯住信号机故障"），
//   模块后台每 5 分钟检查检查信息数据，匹配数量较上次增加且达到阈值时主动提醒。
// 设计要点：
//   - 经典脚本（defer），不用 ES module import（本项目为纯静态经典脚本架构）
//   - 数据字段用真实模型 content/category（不是模板里的 description）
//   - 首次观测静默记录基线，避免"页面一刷新就弹通知"刷屏
//   - 通知：浏览器 Notification（若已授权）+ 应用内 toast（不依赖不存在的元素 id）
// ============================================================
(function () {
  'use strict';

  var GOALS_KEY = 'agent_active_goals';
  var CHECK_INTERVAL = 5 * 60 * 1000; // 5 分钟
  // 【2026-09-21】同一目标的通知冷却：6 小时（原来没有冷却，连续几轮新增会反复弹同一条）
  var NOTIFY_COOLDOWN = 6 * 60 * 60 * 1000;

  function getGoals() {
    try {
      var v = JSON.parse(localStorage.getItem(GOALS_KEY));
      // 只判真假不够：存进去的是 {} 或字符串时会通过，后续 .filter/.push 直接抛错
      return Array.isArray(v) ? v : [];
    } catch (e) { return []; }
  }
  function saveGoals(goals) {
    try { localStorage.setItem(GOALS_KEY, JSON.stringify(goals)); } catch (e) {}
  }

  // 添加目标（对话 /goal 命令或直接调用）
  // condition: { type:'issue', keyword:'信号机', minCount:1 }
  function addGoal(description, condition, callback) {
    var goals = getGoals();
    var cond = condition || {};
    if (!cond.type) cond.type = 'issue';
    if (cond.keyword == null) cond.keyword = String(description || '').trim();
    if (!cond.minCount) cond.minCount = 1;
    var gid = Date.now().toString(36);
    // 同一毫秒内连续添加（脚本批量/快速回车）会撞 id，导致 removeGoal 一次删掉多个
    while (goals.some(function (g) { return g && g.id === gid; })) {
      gid = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    }
    var goal = {
      id: gid,
      description: description || '',
      condition: cond,
      active: true,
      created: new Date().toISOString(),
      lastTriggered: null,
      lastMatched: 0,
      baselined: false
    };
    goals.push(goal);
    saveGoals(goals);
    if (typeof callback === 'function') { try { callback(); } catch (e) {} }
    return goal;
  }

  function removeGoal(id) {
    saveGoals(getGoals().filter(function (g) { return g.id !== id; }));
  }
  function clearGoals() { saveGoals([]); }

  // 后台检查：进页面立即一次 + 每 5 分钟一次
  function checkGoals() {
    // 必须读写【完整列表】：原先先 filter(active) 再 saveGoals(过滤后的数组)，
    // 一旦有目标被标记 inactive（或缺少 active 字段），它会被静默永久删除。
    var goals = getGoals();
    if (!goals.length) return;
    // 数据尚未从 IndexedDB 载入时 getIssueData() 返回 []：
    // 此刻记录基线或判定「新增」，都会把整库数据当成新增，5 分钟后误弹告警
    if (!window.__issueDataReady) return;
    var issues = [];
    try { if (typeof window.getIssueData === 'function') issues = window.getIssueData(); } catch (e) {}
    var changed = false;
    goals.forEach(function (goal) {
      if (!goal || !goal.active) return;
      var cond = goal.condition || {};
      var _type = cond.type || 'issue';
      // 【2026-09-21】盯控类型从"只有检查信息"扩到 检查信息 / 规章制度 / 工作日志
      //   （原来 else 分支只有一句 TODO，/goal 只能盯问题库）。取不到数据源时跳过并**不记录基线**，
      //   避免"数据还没加载完就把 0 当基线"，之后永远触发不了。
      if (_type === 'issue' || _type === 'rule' || _type === 'diary' || _type === 'phone' || _type === 'memo') {
        var kw = String(cond.keyword || '').trim();
        // 空关键词必须跳过：indexOf('') 恒为 0，会把整库当成命中并立刻触发告警
        if (!kw) return;
        var pool = issues;
        if (_type === 'rule') {
          try { pool = (typeof window.getRulesData === 'function') ? (window.getRulesData() || []) : []; } catch (e) { pool = []; }
        } else if (_type === 'diary') {
          try { pool = (typeof window.getDiaryData === 'function') ? (window.getDiaryData() || []) : []; } catch (e) { pool = []; }
        } else if (_type === 'phone') {
          try { pool = (typeof window.getPhoneData === 'function') ? (window.getPhoneData() || []) : []; } catch (e) { pool = []; }
        } else if (_type === 'memo') {
          try { pool = (typeof window.getMemoData === 'function') ? (window.getMemoData() || []) : []; } catch (e) { pool = []; }
        }
        if (!pool.length) return;      // 数据源为空（尚未加载/确实无数据）→ 跳过，不污染基线
        var matched = pool.filter(function (item) {
          if (_type === 'rule') {
            return (item.title || '').indexOf(kw) !== -1 || (item.content || '').indexOf(kw) !== -1 || (item.trade || '').indexOf(kw) !== -1;
          }
          if (_type === 'diary') {
            var hay = (item.work || '') + ' ' + (item.issues || []).join(' ') + ' ' + (item.regulations || []).join(' ');
            return hay.indexOf(kw) !== -1;
          }
          if (_type === 'phone') {
            return ((item.站名 || '') + ' ' + (item.单位 || '') + ' ' + (item.线名 || '') + ' ' + (item.路电 || '') + ' ' + (item.市电 || '')).indexOf(kw) !== -1;
          }
          if (_type === 'memo') {
            return (String(item.content || '') + ' ' + String(item.datetime || '')).indexOf(kw) !== -1;
          }
          return (item.content || '').indexOf(kw) !== -1 || (item.category || '').indexOf(kw) !== -1;
        });
        // 首次观测：静默记录基线，不提醒（避免每次刷新页面都弹通知）
        if (!goal.baselined) {
          goal.baselined = true;
          goal.lastMatched = matched.length;
          changed = true;
          return;
        }
        var n = matched.length;
        var base = goal.lastMatched || 0;
        // 【2026-09-21】比较方式（原来只有"计数增加"）：increase（默认）/ threshold / delta
        var _mode = cond.mode || 'increase';
        var _minC = cond.minCount || 1;
        var _minD = cond.minDelta || 1;
        var _fire = false, _reason = '';
        if (_mode === 'threshold') {
          _fire = n >= _minC;                                 // 达到阈值即提醒（不看增量）
          _reason = '当前命中 ' + n + ' 条（阈值 ' + _minC + ' 条）';
        } else if (_mode === 'delta') {
          _fire = (n - base) >= _minD;                        // 本次新增 ≥ 阈值才提醒
          _reason = '较上次新增 ' + (n - base) + ' 条（阈值 ' + _minD + ' 条）';
        } else {
          _fire = n > base && n >= _minC;                     // 默认：有新增且总数达阈值
          _reason = '较上次新增 ' + (n - base) + ' 条，共 ' + n + ' 条';
        }
        if (_fire) {
          // 通知冷却 + 数值去重：① 距上次提醒 ≥ 6 小时；② 数值与"上次提醒时"不同
          //   （threshold 模式下数字没变就不再重复提醒；increase/delta 下即"又有新增"）
          var _lastTs = goal.lastTriggered ? new Date(goal.lastTriggered).getTime() : 0;
          var _cooled = !_lastTs || (Date.now() - _lastTs >= NOTIFY_COOLDOWN);
          var _changedVal = n !== (goal.lastNotifiedCount || -1);
          if (_cooled && _changedVal) {
            var _label = { issue: '检查信息', rule: '规章制度', diary: '工作日志', phone: '应急电话', memo: '待办备忘' }[_type] || '检查信息';
            showNotification('📢 目标“' + (goal.description || kw) + '”触发！' + _label + '：' + _reason + '。'
              + (_mode === 'increase' && _minC <= 1 ? '（6 小时内同一目标只提醒一次）' : ''));
            goal.lastTriggered = new Date().toISOString();
            goal.lastNotifiedCount = n;
          }
        }
        if (n !== base) {
          // 计数变化（增加或回落）都更新基线：数据被删/重导后回落必须跟着下调，
          // 否则 lastMatched 卡在历史峰值，之后新增的记录永远触发不了告警
          goal.lastMatched = n;
          changed = true;
        }
      }
      // 其它类型（规章更新、日志新增等）可后续扩展
    });
    if (changed) saveGoals(goals);
  }

  // 通知：优先浏览器 Notification（已授权时），同时应用内 toast
  // 注意：不要在 5 分钟定时检查里申请权限 —— 没有用户手势，浏览器会直接忽略/静默拒绝，
  // 反而可能把权限状态打成 denied。授权统一放到用户主动执行 /goal 时申请。
  function showNotification(message) {
    try {
      if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
        new Notification('安监智能体', { body: message });
      }
    } catch (e) {}
    _toast(message);
  }

  // 在用户手势中申请通知权限（供 /goal 添加流程调用）
  function requestNotificationPermission() {
    try {
      if (typeof Notification === 'undefined') return;
      if (Notification.permission !== 'default') return;
      if (typeof Notification.requestPermission !== 'function') return;
      var p = Notification.requestPermission();
      if (p && typeof p.then === 'function') p.then(function() {}, function() {});
    } catch (e) {}
  }

  // 应用内轻量 toast（自建容器，不依赖特定元素 id；暗黑风格跟随全局深色）
  function _toast(message) {
    try {
      var host = document.getElementById('agent-goal-toasts');
      if (!host) {
        host = document.createElement('div');
        host.id = 'agent-goal-toasts';
        host.style.cssText = 'position:fixed;top:12px;right:12px;z-index:3000;display:flex;flex-direction:column;gap:8px;max-width:320px;pointer-events:none;';
        (document.body || document.documentElement).appendChild(host);
      }
      var el = document.createElement('div');
      el.textContent = message;
      el.style.cssText = 'background:#1d1d1d;color:#e2e8f0;padding:10px 14px;border-radius:10px;font-size:13px;line-height:1.5;box-shadow:0 4px 16px rgba(0,0,0,.25);border:1px solid #333333;pointer-events:auto;';
      host.appendChild(el);
      setTimeout(function () { if (el.parentNode) el.parentNode.removeChild(el); }, 8000);
    } catch (e) {}
  }

  function start() {
    try {
      // A1 总开关：关闭增强时不启动后台盯控
      if (window._agentEnhanceOn && !window._agentEnhanceOn()) return;
      checkGoals(); // 进页面立即检查一次（首次仅建立基线）
      setInterval(checkGoals, CHECK_INTERVAL);
    } catch (e) {}
  }

  // A1-P3：/goal 系列命令的本地处理（不调用 LLM），返回响应字符串或 null（非命令）
  window.handleAgentCommand = function(msg) {
    if (!msg) return null;
    try {
      if (msg === '/goals' || msg === '/goal-list') {
        var gs = getGoals();
        if (!gs.length) return '📋 当前没有盯控目标。用 /goal <关键词> 添加，例如 /goal 信号机故障';
        return '📋 盯控目标：\n' + gs.map(function(g, i) {
          var c = g.condition || {};
          var lt = g.lastTriggered ? ('，上次提醒 ' + String(g.lastTriggered).replace('T', ' ').slice(0, 16)) : '，尚未提醒过';
          var tp = { issue: '检查信息', rule: '规章制度', diary: '工作日志', phone: '应急电话', memo: '待办备忘' }[c.type || 'issue'] || '检查信息';
          var md = c.mode === 'threshold' ? ('≥' + (c.minCount || 1) + '条')
            : (c.mode === 'delta' ? ('新增≥' + (c.minDelta || 1) + '条') : '有新增');
          return (i + 1) + '. [' + tp + ']' + (g.description || c.keyword || '') + '（已匹配 ' + (g.lastMatched || 0) + ' 条'
            + '，条件：' + md + lt + '）';
        }).join('\n') + '\n\n删除：/goal-remove <序号或id>；清空：/goal-clear';
      }
      if (msg === '/goal-clear') { clearGoals(); return '🗑️ 已清除全部盯控目标'; }
      // 【2026-09-21】补齐删除入口：removeGoal 早已导出却一直没有命令入口（用户只能清空全部）
      if (msg.indexOf('/goal-remove ') === 0) {
        var rid = msg.slice(13).trim();
        var gs2 = getGoals();
        var target = null;
        if (/^\d+$/.test(rid)) target = gs2[parseInt(rid, 10) - 1] || null;
        else target = gs2.filter(function(g) { return g.id === rid; })[0] || null;
        if (!target) return '⚠️ 未找到该目标（用 /goals 查看序号与 id）：' + rid;
        removeGoal(target.id);
        return '🗑️ 已删除盯控目标：' + (target.description || (target.condition && target.condition.keyword) || target.id);
      }
      if (msg.indexOf('/goal ') === 0) {
        var spec = msg.slice(6).trim();
        if (!spec) return '⚠️ 用法：/goal <关键词>（盯检查信息）｜/goal 规章|日志|电话|待办 <关键词>｜也可在末尾加比较方式：`>=5`（达阈值）或 `+3`（新增≥3）';
        // 【2026-09-21】支持指定盯控类型：`/goal 规章 信号机` / `/goal 日志 防洪` / `/goal 电话 兰州西`
        //   / `/goal 待办 防洪`（也认 `rule:` / `diary:` / `phone:` / `memo:` 前缀）
        var _type = 'issue', _kw = spec, _m = null;
        if ((_m = spec.match(/^(?:规章|制度|rule)\s*[:：]?\s*(.+)$/i))) { _type = 'rule'; _kw = _m[1].trim(); }
        else if ((_m = spec.match(/^(?:日志|写实|diary)\s*[:：]?\s*(.+)$/i))) { _type = 'diary'; _kw = _m[1].trim(); }
        else if ((_m = spec.match(/^(?:电话|通讯录|phone)\s*[:：]?\s*(.+)$/i))) { _type = 'phone'; _kw = _m[1].trim(); }
        else if ((_m = spec.match(/^(?:待办|备忘|memo)\s*[:：]?\s*(.+)$/i))) { _type = 'memo'; _kw = _m[1].trim(); }
        // 【2026-09-21】比较方式修饰（写在末尾）：`>=5` / `阈值 5`（达到阈值即提醒）、`+3` / `增量 3`（本次新增≥3）
        var _mode = 'increase', _min = 0;
        if ((_m = _kw.match(/(?:>=|≥|阈值|不少于)\s*[:：]?\s*(\d+)\s*$/))) {
          _mode = 'threshold'; _min = parseInt(_m[1], 10) || 1; _kw = _kw.replace(_m[0], '').trim();
        } else if ((_m = _kw.match(/(?:\+|增量)\s*[:：]?\s*(\d+)\s*$/))) {
          _mode = 'delta'; _min = parseInt(_m[1], 10) || 1; _kw = _kw.replace(_m[0], '').trim();
        }
        if (!_kw) return '⚠️ 缺少关键词，例如：/goal 规章 信号机';
        var _cond = { type: _type, keyword: _kw };
        if (_mode === 'threshold') _cond.minCount = _min;
        if (_mode === 'delta') _cond.minDelta = _min;
        if (_mode !== 'increase') _cond.mode = _mode;
        addGoal(_kw, _cond);
        // 用户主动添加目标属于明确手势，此时申请通知权限才可能被浏览器接受
        requestNotificationPermission();
        var _tpName = { issue: '检查信息', rule: '规章制度', diary: '工作日志', phone: '应急电话', memo: '待办备忘' }[_type];
        var _modeTxt = _mode === 'threshold' ? ('达到 ' + _min + ' 条即提醒')
          : (_mode === 'delta' ? ('本次新增 ≥' + _min + ' 条才提醒') : '有新增即提醒');
        return '✅ 已添加盯控目标：' + _kw + '（盯控范围：' + _tpName + '；触发条件：' + _modeTxt
          + '；后台每 5 分钟检查，首次仅记录基线，不弹通知）';
      }
    } catch (e) { return null; }
    return null;
  };

  window.addGoal = addGoal;
  window.removeGoal = removeGoal;
  window.clearGoals = clearGoals;
  window.getGoals = getGoals;
  window.checkGoals = checkGoals;

  if (document.readyState !== 'loading') start();
  else document.addEventListener('DOMContentLoaded', start);
})();
