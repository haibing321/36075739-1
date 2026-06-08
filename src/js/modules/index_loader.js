/**
 * 语义搜索知识库加载器（IndexedDB 缓存版）
 * ===========================================
 * 功能：按需加载知识库数据，首次从 JSON 文件拉取并缓存到 IndexedDB，后续直接读缓存。
 *
 * 工作流程：
 *   1. 检查 IndexedDB 是否有缓存数据（按版本号判断）
 *   2. 有缓存 -> 直接从 IndexedDB 加载到 window.__SEMANTIC_INDEX__
 *   3. 无缓存 -> fetch(src/js/knowledge_base_data.json)
 *              -> 解析 JSON -> 存入 IndexedDB -> 加载到 window.__SEMANTIC_INDEX__
 *
 * 数据量：4260 条 x 384 维 = ~6 MB（float32 二进制存储）
 * 版本：更新数据后修改 DATA_VERSION 即自动刷新缓存
 */

var _semanticLoader = (function() {
    'use strict';

    var DB_NAME = 'SemanticIndexDB';
    var DB_VERSION = 1;
    var DATA_URL = 'src/js/knowledge_base_data.json';
    var DATA_VERSION = '2026-06-08-19:38';

    function _openDB() {
        return new Promise(function(resolve, reject) {
            var request = indexedDB.open(DB_NAME, DB_VERSION);
            request.onupgradeneeded = function(e) {
                var db = e.target.result;
                if (!db.objectStoreNames.contains('records')) {
                    db.createObjectStore('records', { keyPath: 'id' });
                }
                if (!db.objectStoreNames.contains('meta')) {
                    db.createObjectStore('meta', { keyPath: 'key' });
                }
            };
            request.onsuccess = function(e) { resolve(e.target.result); };
            request.onerror = function(e) { reject(new Error('IndexedDB 打开失败')); };
        });
    }

    function _importToDB(db, dataArray) {
        return new Promise(function(resolve, reject) {
            var tx = db.transaction(['records', 'meta'], 'readwrite');
            var recordStore = tx.objectStore('records');
            var metaStore = tx.objectStore('meta');
            var dim = (dataArray[0] && dataArray[0].e) ? dataArray[0].e.length : 384;

            for (var i = 0; i < dataArray.length; i++) {
                var item = dataArray[i];
                var floatArr = new Float32Array(item.e.length);
                for (var j = 0; j < item.e.length; j++) { floatArr[j] = item.e[j]; }
                recordStore.put({
                    id: i,
                    e: floatArr.buffer,
                    t: item.t || '',
                    s: item.s || '',
                    f: item.f || '',
                    r: item.r || null
                });
            }

            metaStore.put({ key: 'version', value: DATA_VERSION });
            metaStore.put({ key: 'count', value: dataArray.length });
            metaStore.put({ key: 'dim', value: dim });

            tx.oncomplete = function() {
                console.log('[知识库] IndexedDB 导入完成: ' + dataArray.length + ' 条');
                resolve(dataArray.length);
            };
            tx.onerror = function(e) { reject(new Error('IndexedDB 写入失败')); };
        });
    }

    function _loadFromDB(db) {
        return new Promise(function(resolve, reject) {
            var tx = db.transaction(['records', 'meta'], 'readonly');
            var recordStore = tx.objectStore('records');
            var metaStore = tx.objectStore('meta');
            var results = [];

            metaStore.get('version').onsuccess = function(e) {
                var cachedVersion = (e.target.result && e.target.result.value) ? e.target.result.value : '';
                if (cachedVersion !== DATA_VERSION) {
                    console.log('[知识库] 版本过期，清除旧缓存 (cached=' + cachedVersion + ', current=' + DATA_VERSION + ')');
                    var clearTx = db.transaction(['records', 'meta'], 'readwrite');
                    clearTx.objectStore('records').clear();
                    clearTx.objectStore('meta').clear();
                    clearTx.oncomplete = function() { resolve(null); };
                    return;
                }

                recordStore.openCursor().onsuccess = function(ev) {
                    var cursor = ev.target.result;
                    if (cursor) {
                        var rec = cursor.value;
                        var floatArr = new Float32Array(rec.e);
                        var eArray = new Array(floatArr.length);
                        for (var i = 0; i < floatArr.length; i++) { eArray[i] = floatArr[i]; }
                        results.push({ e: eArray, t: rec.t, s: rec.s, f: rec.f, r: rec.r });
                        cursor.continue();
                    } else {
                        console.log('[知识库] IndexedDB 加载完成: ' + results.length + ' 条');
                        resolve(results);
                    }
                };
            };
            tx.onerror = function() { reject(new Error('IndexedDB 读取失败')); };
        });
    }

    function _fetchJSON(url) {
        return new Promise(function(resolve, reject) {
            console.log('[知识库] 下载知识库数据中...');
            var t0 = performance.now();
            fetch(url).then(function(resp) {
                if (!resp.ok) {
                    reject(new Error('HTTP ' + resp.status));
                    return;
                }
                return resp.json();
            }).then(function(data) {
                var t = ((performance.now() - t0) / 1000).toFixed(1);
                console.log('[知识库] 下载+解析完成: ' + (data && data.length) + ' 条, 耗时 ' + t + 's');
                resolve(data);
            }).catch(function(err) { reject(err); });
        });
    }

    var _initPromise = null;

    function _init() {
        if (window.__SEMANTIC_INDEX__ && window.__SEMANTIC_INDEX__.length > 0) return Promise.resolve();
        if (_initPromise) return _initPromise;

        _initPromise = _openDB().then(function(db) {
            return _loadFromDB(db).then(function(cached) {
                if (cached && cached.length > 0) {
                    window.__SEMANTIC_INDEX__ = cached;
                    console.log('[知识库] 从 IndexedDB 缓存加载 ✓');
                    return;
                }
                return _fetchJSON(DATA_URL).then(function(data) {
                    if (!data || !data.length) {
                        window.__SEMANTIC_INDEX__ = [];
                        return;
                    }
                    return _importToDB(db, data).then(function() {
                        window.__SEMANTIC_INDEX__ = data;
                        console.log('[知识库] 首次加载完成 ✓');
                    });
                });
            });
        }).catch(function(e) {
            console.error('[知识库] 加载失败:', e.message);
            window.__SEMANTIC_INDEX__ = [];
        });

        return _initPromise;
    }

    return { init: _init };
})();

// 导出
window.initSemanticIndex = _semanticLoader.init;

// 自动初始化
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', _semanticLoader.init);
} else {
    _semanticLoader.init();
}
