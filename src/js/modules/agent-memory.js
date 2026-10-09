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

  /**
   * 【2026-10-09 建议③·任务后反思】把"一次任务的复盘"变成"下次可直接照做的经验"。
   *
   * 为什么需要：此前跨任务只留了两种信息 ——
   *   · 「做了什么」= getRecentAgentContext（最近 3 条，含失败/0命中）；
   *   · 「关注什么」= 偏好画像（单位/关键词/性质/月份）。
   *   唯独**不留「怎么做更好、踩了什么坑」** ⇒ 同一个坑下次照踩，系统不成长（典型"一次性工具"）。
   *
   * 设计取舍（都来自本仓库既有的工程约束）：
   *   · 走 `window.dsCallOnce`：契约"绝不抛异常 + 失败返回 {ok:false}"，与项目"如实降级"口径一致；
   *     关思考、maxTokens=300、timeoutMs=20000（这是**后台任务**，宁可失败也不能拖慢用户收尾）。
   *   · 结构化输出用 `window.dsParseJsonLoose`（已有：去围栏/去尾逗号/兜底括号配平）。
   *   · **不新建 IndexedDB 表**：反思直接挂在 `taskRecord.reflection` 上，同 id 覆盖写回 ——
   *     零 schema 风险，并天然复用既有的「保留 30 条 + 30 天 TTL」容量兜底。
   *   · 每条字段截 60 字：system 超预算时中段（记忆/画像）会被优先裁剪，反思必须短。
   *   · 开关 `localStorage['agent_reflect']='0'` 可关；诊断 `window.__agentLastReflection`。
   */
  window.runAgentReflection = async function(taskRecord, userMessage) {
    try {
      if (localStorage.getItem('agent_reflect') === '0') return { ok: false, error: 'off' };
      if (!taskRecord || !taskRecord.steps || !taskRecord.steps.length) return { ok: false, error: 'no-steps' };
      if (typeof window.dsCallOnce !== 'function') return { ok: false, error: 'no-llm' };
      var _t0 = Date.now();
      var stepsTxt = taskRecord.steps.slice(-12).map(function(s) {
        return String(s.tool || '?') + (s.ok ? '✓' : '✗') + '('
          + String(s.summary || '').replace(/\s+/g, ' ').slice(0, 36) + ')';
      }).join('; ').slice(0, 700);
      var user = '下面是智能体任务执行记录，请做一次**可复用**的复盘。\n'
        + '要求：每条 ≤40 字；只写"下次能直接照着做"的经验，不复述任务内容；没有就留空字符串。\n'
        + '只输出 JSON：{"good":"...","bad":"...","tip":"..."}\n\n'
        + '任务意图：' + String(taskRecord.userIntent || userMessage || '').slice(0, 120) + '\n'
        + '工具调用：' + (stepsTxt || '（无）') + '\n'
        + '最终输出：' + String(taskRecord.finalOutput || '').replace(/\s+/g, ' ').slice(0, 240) + '\n'
        + '统计：工具 ' + (taskRecord.toolCalls || 0) + ' 次 / 失败 ' + (taskRecord.failedTools || 0)
        + ' 次 / 耗时 ' + Math.round((taskRecord.durationMs || 0) / 1000) + 's';
      var r = await window.dsCallOnce('你是任务复盘助手，只输出 JSON，不要解释。', user,
        { temperature: 0.2, maxTokens: 300, timeoutMs: 20000, thinking: false });
      if (!r || !r.ok || !r.text) {
        window.__agentLastReflection = { ok: false, error: (r && r.error) || 'empty', ms: Date.now() - _t0 };
        return { ok: false };
      }
      var j = (typeof window.dsParseJsonLoose === 'function') ? window.dsParseJsonLoose(r.text) : null;
      if (!j) {
        window.__agentLastReflection = { ok: false, error: 'parse', ms: Date.now() - _t0, raw: String(r.text).slice(0, 120) };
        return { ok: false };
      }
      var clip = function(v) { return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, 60); };
      var refl = { good: clip(j.good), bad: clip(j.bad), tip: clip(j.tip), at: Date.now() };
      if (!refl.good && !refl.bad && !refl.tip) {
        window.__agentLastReflection = { ok: false, error: 'empty-json', ms: Date.now() - _t0 };
        return { ok: false };
      }
      taskRecord.reflection = refl;
      try { await window.saveAgentTask(taskRecord); } catch (e) {}   // 同 id 覆盖写回
      window.__agentLastReflection = { ok: true, ms: Date.now() - _t0, refl: refl };
      return { ok: true, refl: refl };
    } catch (e) {
      window.__agentLastReflection = { ok: false, error: String((e && e.message) || e) };
      return { ok: false };
    }
  };

  /** 取最近几条"有反思"的经验（给下次任务的 system 注入用；只取 3 条、整体 ≤300 字，避免撑爆预算） */
  window.getRecentAgentReflections = async function() {
    try {
      var tasks = await window.getAgentTasks(6);
      var lines = [];
      (tasks || []).forEach(function(t) {
        var r = t && t.reflection;
        if (!r) return;
        var seg = [];
        if (r.bad) seg.push('上次踩坑：' + r.bad);
        if (r.tip) seg.push('建议：' + r.tip);
        if (seg.length) lines.push('· [' + String(t.userIntent || '').slice(0, 24) + '] ' + seg.join('；'));
      });
      return lines.slice(0, 3).join('\n').slice(0, 300);
    } catch (e) { return ''; }
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
    // 【v4.24 依据 Anthropic《Writing effective tools for agents》第 6 条】冗余调用统计：
    //   同一任务内"同工具 + 同参数"重复调用 ⇒ 通常说明**工具描述不清或参数设计不合理**（模型在试错），
    //   是优化工具的高信号指标（官方："大量冗余调用说明分页/截断参数需调整；大量无效参数报错说明描述不清"）。
    //   ⚠️ 参数按 JSON 序列化比较，键序不同会被判为不同调用 ⇒ 只会**少计**、不会多计（保守口径）。
    var _redunTotal = 0, _redunByTool = {};
    tasks.forEach(function (t) {
      var seen = {};
      (t.steps || []).forEach(function (s) {
        var name = s.tool || '?';
        var raw = s.args || s.params || s.input || s.arguments || {};
        var key = name + '|' + JSON.stringify(raw);
        if (seen[key]) { _redunTotal++; _redunByTool[name] = (_redunByTool[name] || 0) + 1; }
        seen[key] = 1;
      });
    });
    st.冗余调用 = _redunTotal;
    st.冗余最多的工具 = Object.keys(_redunByTool).sort(function (a, b) { return _redunByTool[b] - _redunByTool[a]; })
      .slice(0, 3).map(function (k) { return k + '×' + _redunByTool[k]; });
    return st;
  };
})();

// ========== 【2026-10-06 建议④】智能体消耗汇总（「关于系统」一行可见 + 控制台可查）==========
//   用户口径："不用开控制台也能看本机智能体累计消耗 / 平均每轮"。
//   数据来源：agent_tasks 每条记录的 usage（**本任务增量** —— 见 agent-core.js 任务起点的基准快照注释）。
//   ⚠️ 只统计**新口径**记录（带 usageSessionTotal 标记）：v4.16 之前落库的是"会话累计"，
//      直接相加会重复累加（同一会话跑得越多虚高越厉害）⇒ 跳过并如实标出条数，不糊弄。
(function() {
  function _fmt(n) {
    return n >= 1000000 ? (Math.round(n / 10000) / 100) + 'M' : (n >= 1000 ? (Math.round(n / 100) / 10) + 'k' : String(n));
  }
  window.getAgentUsageStats = async function() {
    var tasks = [];
    try { tasks = await window.getAgentTasks(200); } catch (e) { tasks = []; }
    var st = {
      任务数: 0, 旧口径未计入: 0, calls: 0,
      prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, cached_tokens: 0,
      平均每任务tokens: 0, 平均每轮tokens: 0, 缓存命中率: '—'
    };
    tasks.forEach(function(t) {
      if (!t || !t.usage) return;
      if (!t.usageSessionTotal) { st.旧口径未计入++; return; }
      st.任务数++;
      ['calls', 'prompt_tokens', 'completion_tokens', 'total_tokens', 'cached_tokens'].forEach(function(k) {
        st[k] += (t.usage[k] || 0);
      });
    });
    if (st.任务数) {
      st.平均每任务tokens = Math.round(st.total_tokens / st.任务数);
      st.平均每轮tokens = st.calls ? Math.round(st.total_tokens / st.calls) : 0;
      st.缓存命中率 = st.prompt_tokens ? Math.round(st.cached_tokens / st.prompt_tokens * 100) + '%' : '—';
    }
    return st;
  };
  /** 一行文案（「关于系统」用）。无数据时给明确引导，不留白。 */
  window.getAgentUsageLine = async function() {
    var s = await window.getAgentUsageStats();
    if (!s.任务数) {
      return s.旧口径未计入
        ? '暂无新口径记录（旧记录 ' + s.旧口径未计入 + ' 条不计入，跑一次智能体任务后开始统计）'
        : '暂无记录（跑一次智能体任务后开始统计）';
    }
    return s.任务数 + ' 次任务 · ' + s.calls + ' 轮模型调用 · 累计 ' + _fmt(s.total_tokens) + ' tokens'
      + '（平均每任务 ' + _fmt(s.平均每任务tokens) + '、每轮 ' + s.平均每轮tokens + '）'
      + (s.缓存命中率 !== '—' ? ' · 缓存命中 ' + s.缓存命中率 : '');
  };
})();
