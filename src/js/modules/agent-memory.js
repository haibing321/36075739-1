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
          cursorReq.onsuccess = function(e2) {
            var cursor = e2.target.result;
            if (cursor && deleted < overflow) {
              cursor.delete();
              deleted++;
              cursor.continue();
            }
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
    return tasks.map(function(t) {
      // 从步骤中提取工具调用结果的关键信息
      var toolResults = [];
      (t.steps || []).forEach(function(s) {
        if (s.ok && s.summary) {
          var m = s.summary.match(/共(\d+)条/);
          if (m) toolResults.push((m[1] === '0' ? '无' : m[1] + '条') + '(' + s.tool + ')');
        }
      });
      return '上次任务：' + t.userIntent + (toolResults.length > 0 ? ' [' + toolResults.join(', ') + ']' : '') + ' (' + t.timestamp + ')';
    }).join('\n');
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
      });
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
      return parts.join('');
    } catch (e) { return ''; }
  };
})();
