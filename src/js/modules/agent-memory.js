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

  /** 取最近 3 条任务摘要用于提示词上下文 */
  window.getRecentAgentContext = async function() {
    var tasks = await window.getAgentTasks(3);
    if (!tasks || !tasks.length) return '';
    return tasks.map(function(t) {
      var steps = (t.steps || []).map(function(s) { return s.tool + '=' + (s.ok ? '✓' : '✗'); }).join(',');
      return '[' + t.id + '] ' + t.userIntent + ' → ' + steps + ' (' + t.timestamp + ')';
    }).join('\n');
  };
})();
