/**
 * Agent Memory（任务记忆）模块
 * ===================================================
 * IndexedDB 存储 agent 任务执行全过程
 *   store: agent_tasks @ AgentTaskDB v1
 * 导出到 window:
 *   - window.saveAgentTask
 *   - window.getAgentTasks
 *   - window.getRecentAgentContext (最近3条摘要用于提示词)
 */
(function() {
  var DB_NAME = 'AgentTaskDB', STORE = 'agent_tasks', DB_VERSION = 1;
  var db = null;

  async function _openDB() {
    if (db) return db;
    return new Promise(function(resolve, reject) {
      var req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = function(e) {
        var database = e.target.result;
        if (!database.objectStoreNames.contains(STORE)) {
          var store = database.createObjectStore(STORE, { keyPath: 'id' });
          store.createIndex('timestamp', 'timestamp', { unique: false });
        }
      };
      req.onsuccess = function() { db = req.result; resolve(db); };
      req.onerror = function() { reject(req.error); };
    });
  }

  /** 保存任务记录 */
  window.saveAgentTask = async function(task) {
    var database = await _openDB();
    return new Promise(function(resolve, reject) {
      var tx = database.transaction(STORE, 'readwrite');
      var store = tx.objectStore(STORE);
      // 保留最近 30 条：仅删除超出部分，且删完立即 break，避免误删全部记录
      var countReq = store.count();
      countReq.onsuccess = function() {
        var total = countReq.result;
        var MAX = 30, overflow = total - (MAX - 1);
        if (overflow > 0) {
          var deleted = 0;
          var cursorReq = store.index('timestamp').openCursor(); // 升序，最旧的在前
          // 【2026-09-21】除"超出 30 条"外，再加 **30 天 TTL**：长期不用的记录自动过期，
          //   避免"任务很少但都是半年前的"这种陈旧上下文被反复注入。
          var cutoff = Date.now() - 30 * 24 * 3600 * 1000;
          cursorReq.onsuccess = function(e2) {
            var cursor = e2.target.result;
            if (!cursor) return;
            var ts = new Date((cursor.value && cursor.value.timestamp) || 0).getTime();
            if (deleted < overflow || (ts && ts < cutoff)) { cursor.delete(); deleted++; }
            cursor.continue();
          };
        }
      };
      var req = store.put(task);
      req.onsuccess = function() { resolve(); };
      req.onerror = function() { reject(req.error); };
    });
  };

  /** 获取全部任务记录（用于回顾） */
  window.getAgentTasks = async function(limit) {
    var database = await _openDB();
    return new Promise(function(resolve) {
      var tx = database.transaction(STORE, 'readonly');
      var store = tx.objectStore(STORE);
      var index = store.index('timestamp');
      var results = [];
      var count = 0;
      var max = limit || 20;
      var cursorReq = index.openCursor(null, 'prev');
      cursorReq.onsuccess = function(e) {
        var cursor = e.target.result;
        if (cursor && count < max) {
          results.push(cursor.value);
          count++;
          cursor.continue();
        } else {
          resolve(results);
        }
      };
      cursorReq.onerror = function() { resolve([]); };
    });
  };

  /** 取最近 3 条任务摘要（含实际数据，非原始工具调用链） */
  window.getRecentAgentContext = async function() {
    var tasks = await window.getAgentTasks(3);
    if (!tasks || !tasks.length) return '';
    // 【2026-09-21】两处修正：
    //   ① 原实现只挑「成功且带『共N条』」的步骤 → **失败与 0 命中这类"踩过的坑"全部丢失**，
    //      模型下次可能照样踩；现在失败/0命中显式保留（模型据此换策略）。
    //   ② userIntent 全文进提示词且无长度上限 → 现在按 60 字截断、整体 ≤600 字。
    return tasks.map(function(t) {
      var hits = [], warns = [];
      (t.steps || []).forEach(function(s) {
        if (!s.ok) { warns.push(String(s.tool || '?') + '失败'); return; }
        var m = s.summary && String(s.summary).match(/共(\d+)条/);
        if (m) hits.push((m[1] === '0' ? '0命中' : m[1] + '条') + '(' + s.tool + ')');
      });
      var line = '上次任务：' + String(t.userIntent || '').slice(0, 60);
      if (hits.length) line += ' [' + hits.slice(0, 4).join(', ') + ']';
      if (warns.length) line += ' ⚠️' + warns.slice(0, 3).join('/') + '（可换关键词或放宽条件重试）';
      if (t.durationMs) line += ' 耗时' + Math.round(t.durationMs / 1000) + 's';
      return line;
    }).join('\n').slice(0, 600);
  };
})();

// ========== A1-P1 用户偏好画像（轻量，存 localStorage） ==========
(function() {
  var PROFILE_KEY = 'agent_user_profile';
  function _read() {
    try { return JSON.parse(localStorage.getItem(PROFILE_KEY) || '{}'); } catch (e) { return {}; }
  }
  function _write(p) {
    try { localStorage.setItem(PROFILE_KEY, JSON.stringify(p)); } catch (e) {}
  }
  /** 按计数保留 TopN（画像各维度的统一上限/衰减实现） */
  function _capTop(obj, max) {
    if (!obj) return;
    var ks = Object.keys(obj);
    if (ks.length <= max) return;
    ks.sort(function(a, b) { return obj[b] - obj[a]; });
    ks.slice(max).forEach(function(k) { delete obj[k]; });
  }
  // 从历史任务累积用户关注单位 / 常用检索词
  window.learnFromConversation = function(userIntent, taskRecord) {
    try {
      var p = _read();
      p.units = p.units || {};
      p.keywords = p.keywords || {};
      (taskRecord.steps || []).forEach(function(s) {
        if (s.tool === 'search_issues' && s.params && s.params.unit) {
          p.units[s.params.unit] = (p.units[s.params.unit] || 0) + 1;
        }
        if (s.tool === 'search_rules' && s.params && s.params.keyword) {
          var k = String(s.params.keyword).trim(); if (k) p.keywords[k] = (p.keywords[k] || 0) + 1;
        }
        // 【v3.74】kb_search 也要沉淀偏好：它正成为主检索入口，此前只记 search_rules/search_issues，
        // 导致"改用统一检索层后画像学不到东西"。这里从检索式里抽关键词（抽不到就取前 12 字）。
        if (s.tool === 'kb_search' && s.params && s.params.query) {
          var q = String(s.params.query).trim();
          var kws = [];
          try { if (typeof window.smartExtractKeywords === 'function') kws = window.smartExtractKeywords(q, 3, false) || []; } catch (e) { kws = []; }
          if (!kws.length && q) kws = [q.replace(/\s+/g, '').slice(0, 8)];   // 抽不出词时取前 8 字，避免把整句检索式当成"常用检索词"
          kws.forEach(function(kw) {
            kw = String(kw || '').trim();
            if (kw) p.keywords[kw] = (p.keywords[kw] || 0) + 1;
          });
        }
        // 【2026-09-21】统计主力工具 count_issues 的参数也要沉淀：此前只学 search_issues.unit /
        //   search_rules.keyword，用户最常用的"按单位/性质/月份统计"这一口径完全学不到。
        if (s.tool === 'count_issues' && s.params) {
          var cu = String(s.params.unit || '').trim();
          if (cu) p.units[cu] = (p.units[cu] || 0) + 1;
          var cn = String(s.params.nature || '').trim();
          if (cn) { p.natures = p.natures || {}; p.natures[cn] = (p.natures[cn] || 0) + 1; }
          var cd = String(s.params.dateFrom || '').trim();
          if (cd) { p.ranges = p.ranges || {}; p.ranges[cd.slice(0, 7)] = (p.ranges[cd.slice(0, 7)] || 0) + 1; }
        }
      });
      // 【2026-09-21】上限 + 衰减：画像原先只增不减（长期使用会无限膨胀且旧偏好永久霸榜）。
      //   每个维度按计数保留 TopN，超出直接淘汰 —— 简单、可预测，不需要复杂的时间衰减模型。
      _capTop(p.units, 12);
      _capTop(p.keywords, 20);
      _capTop(p.natures, 6);
      _capTop(p.ranges, 12);
      p.lastSeen = new Date().toISOString();
      _write(p);
    } catch (e) {}
  };
  // 生成注入提示词的偏好片段
  window.getPreferencePrompt = function() {
    try {
      var p = _read();
      var parts = [];
      var units = Object.keys(p.units || {}).sort(function(a, b) { return p.units[b] - p.units[a]; });
      if (units.length) parts.push('该用户常关注单位：' + units.slice(0, 5).join('、') + '。');
      var kws = Object.keys(p.keywords || {}).sort(function(a, b) { return p.keywords[b] - p.keywords[a]; });
      if (kws.length) parts.push('常用检索词：' + kws.slice(0, 5).join('、') + '。');
      // 【2026-09-21】补统计口径（性质/月份）：模型可直接沿用用户惯用口径，少一轮澄清
      var nats = Object.keys(p.natures || {}).sort(function(a, b) { return p.natures[b] - p.natures[a]; });
      if (nats.length) parts.push('常统计性质：' + nats.slice(0, 3).join('、') + '。');
      var rgs = Object.keys(p.ranges || {}).sort(function(a, b) { return p.ranges[b] - p.ranges[a]; });
      if (rgs.length) parts.push('常查月份：' + rgs.slice(0, 3).join('、') + '。');
      return parts.join('');
    } catch (e) { return ''; }
  };
  // 【2026-09-21】偏好画像的"查看 / 清空"入口：此前画像只写不读、更没有任何清理方式
  //   （本地数据治理缺口）。面板与排查都通过这两个函数。
  window.getAgentProfileView = function() {
    try {
      var p = _read();
      return { 单位: p.units || {}, 检索词: p.keywords || {}, 性质: p.natures || {}, 月份: p.ranges || {}, 最近更新: p.lastSeen || '' };
    } catch (e) { return {}; }
  };
  window.clearAgentPreferences = function() {
    try { localStorage.removeItem(PROFILE_KEY); return true; } catch (e) { return false; }
  };
})();

// ========== A1-P2 进化：任务统计（从历史任务聚合，供面板展示与排查用）==========
//   为什么：原来只存任务、从不汇总 —— 看不到"哪个工具老失败、平均多久、成功率多少"，
//   也就无从据此改工具描述/参数口径。这里给出一个只读聚合入口（面板展示 + 排查取证）。
(function() {
  window.getAgentToolStats = async function() {
    var tasks = [];
    try { tasks = await window.getAgentTasks(30); } catch (e) { tasks = []; }
    var st = { 任务数: tasks.length, 成功率: '—', 平均耗时s: 0, 失败最多的工具: [], 工具: {} };
    var done = 0, okAll = 0, dur = 0, durN = 0, failCount = {};
    tasks.forEach(function(t) {
      if (t.durationMs) { dur += t.durationMs; durN++; }
      var bad = 0;
      (t.steps || []).forEach(function(s) {
        var k = s.tool || '?';
        st.工具[k] = st.工具[k] || { 成功: 0, 失败: 0 };
        if (s.ok) st.工具[k].成功++;
        else { st.工具[k].失败++; bad++; failCount[k] = (failCount[k] || 0) + 1; }
      });
      if (String(t.finalOutput || '').indexOf('已手动停止') === -1) {
        done++;
        if (!bad && String(t.finalOutput || '').indexOf('❌') !== 0 && t.finalOutput) okAll++;
      }
    });
    st.成功率 = done ? Math.round(okAll / done * 100) + '%' : '—';
    st.平均耗时s = durN ? Math.round(dur / durN / 1000) : 0;
    st.失败最多的工具 = Object.keys(failCount).sort(function(a, b) { return failCount[b] - failCount[a]; })
      .slice(0, 3).map(function(k) { return k + '×' + failCount[k]; });
    return st;
  };
})();
