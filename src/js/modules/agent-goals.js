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
      if (cond.type === 'issue') {
        var kw = String(cond.keyword || '').trim();
        // 空关键词必须跳过：indexOf('') 恒为 0，会把整库当成命中并立刻触发告警
        if (!kw) return;
        var matched = issues.filter(function (item) {
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
        if (n > base) {
          // 匹配数增加且达到阈值时提醒
          if (n >= (cond.minCount || 1)) {
            showNotification('📢 目标“' + (goal.description || kw) + '”触发！发现 ' + n + ' 条相关记录。');
            goal.lastTriggered = new Date().toISOString();
          }
          goal.lastMatched = n;
          changed = true;
        } else if (n < base) {
          // 数据被删/重导后匹配数回落：基线必须跟着下调，
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
      el.style.cssText = 'background:#1e293b;color:#e2e8f0;padding:10px 14px;border-radius:10px;font-size:13px;line-height:1.5;box-shadow:0 4px 16px rgba(0,0,0,.25);border:1px solid #334155;pointer-events:auto;';
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
          return (i + 1) + '. ' + (g.description || (g.condition && g.condition.keyword) || '') + '（已匹配 ' + (g.lastMatched || 0) + ' 条）';
        }).join('\n');
      }
      if (msg === '/goal-clear') { clearGoals(); return '🗑️ 已清除全部盯控目标'; }
      if (msg.indexOf('/goal ') === 0) {
        var desc = msg.slice(6).trim();
        if (!desc) return '⚠️ 用法：/goal <关键词>，如 /goal 信号机故障';
        addGoal(desc);
        // 用户主动添加目标属于明确手势，此时申请通知权限才可能被浏览器接受
        requestNotificationPermission();
        return '✅ 已添加盯控目标：' + desc + '（后台每 5 分钟检查，首次仅记录基线，不弹通知）';
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
