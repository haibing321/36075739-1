        // ========== Issue System ==========
        (function() {
            const DB_NAME = 'RailwayIssueDB_v2', STORE_NAME = 'issues', DB_VERSION = 2;
            let db = null, dataCache = [], keywordNum = 0, MAX_KEYWORDS = 4;
            let showLowMatch = false, currentResults = [], currentKeywords = [];
            const MATCH_THRESHOLD = 75;
            const searchMode = 'OR';
            const searchFields = ['性质', 'category', 'content', 'regulation', 'unit'];
            let currentPage = 1, pageSize = 20, totalPages = 1, allFilteredResults = [];

            async function initDB() {
                if (!window._issueDBRegistered) {
                    window.dbManager.register('RailwayIssueDB_v2', 2, function(database, e) {
                        if (!database.objectStoreNames.contains(STORE_NAME)) {
                            const store = database.createObjectStore(STORE_NAME, { keyPath: 'id', autoIncrement: true });
                            store.createIndex('性质', '性质', { unique: false });
                            store.createIndex('datetime', 'datetime', { unique: false });
                            store.createIndex('category', 'category', { unique: false });
                            store.createIndex('unit', 'unit', { unique: false });
                        }
                    });
                    window._issueDBRegistered = true;
                }
                db = await window.dbManager.getDB('RailwayIssueDB_v2');
                return db;
            }

            async function saveData(dataArray) {
                if (!db) await initDB();
                await clearAllData();
                const batchSize = 500;
                for (let i = 0; i < dataArray.length; i += batchSize) {
                    await insertBatch(dataArray.slice(i, i + batchSize));
                }
                dataCache = dataArray;
            }

            function insertBatch(batch) {
                return new Promise((resolve, reject) => {
                    const transaction = db.transaction([STORE_NAME], 'readwrite');
                    const store = transaction.objectStore(STORE_NAME);
                    let count = 0;
                    batch.forEach(item => {
                        const request = store.put(item);
                        request.onsuccess = () => { count++; if (count === batch.length) resolve(); };
                        request.onerror = () => reject(request.error);
                    });
                });
            }

            async function loadData() {
                if (!db) await initDB();
                return new Promise((resolve, reject) => {
                    const transaction = db.transaction([STORE_NAME], 'readonly');
                    const store = transaction.objectStore(STORE_NAME);
                    const request = store.getAll();
                    request.onsuccess = () => { dataCache = request.result; resolve(dataCache); };
                    request.onerror = () => reject(request.error);
                });
            }

            async function clearAllData() {
                if (!db) await initDB();
                return new Promise((resolve, reject) => {
                    const transaction = db.transaction([STORE_NAME], 'readwrite');
                    const store = transaction.objectStore(STORE_NAME);
                    const request = store.clear();
                    request.onsuccess = () => resolve();
                    request.onerror = () => reject(request.error);
                });
            }

            async function updateStorage() {
                try {
                    const data = await loadData(), count = data.length;
                    let sizeMB = 0;
                    if (count > 0) {
                        const jsonStr = JSON.stringify(data);
                        sizeMB = (jsonStr.length / 1024 / 1024).toFixed(2);
                    }
                    document.getElementById('issue-recordCount').textContent = count + ' 条';
                    if (window.storageManager) {
                        try {
                            var quotaInfo = await window.storageManager.checkQuota();
                            document.getElementById('issue-storageText').textContent = parseFloat(sizeMB) + ' / ' + quotaInfo.quotaMB + ' MB';
                            const percent = Math.min((parseFloat(sizeMB) / Math.max(quotaInfo.quotaMB, 1)) * 100, 100);
                            var bar = document.getElementById('issue-storageBar');
                            bar.style.width = percent + '%';
                            if (percent > 80) bar.className = 'storage-fill danger';
                            else if (percent > 60) bar.className = 'storage-fill warning';
                            else bar.className = 'storage-fill';
                        } catch(qe) {
                            document.getElementById('issue-storageText').textContent = sizeMB + ' MB';
                            const percent = Math.min((sizeMB / 50) * 100, 100);
                            var bar2 = document.getElementById('issue-storageBar');
                            bar2.style.width = percent + '%';
                            if (percent > 80) bar2.className = 'storage-fill danger';
                            else if (percent > 60) bar2.className = 'storage-fill warning';
                            else bar2.className = 'storage-fill';
                        }
                    } else {
                        document.getElementById('issue-storageText').textContent = sizeMB + ' MB';
                        const percent = Math.min((sizeMB / 50) * 100, 100);
                        var bar3 = document.getElementById('issue-storageBar');
                        bar3.style.width = percent + '%';
                        if (percent > 80) bar3.className = 'storage-fill danger';
                        else if (percent > 60) bar3.className = 'storage-fill warning';
                        else bar3.className = 'storage-fill';
                    }
                } catch (e) {}
                issueRefreshCategorySelect();
            }

            function extractTradeFromUnit(unitName) {
                if (!unitName) return '';
                var name = String(unitName).trim();
                var tradeKeys = ['高铁基础设施','综合维修','基础设施','客运','货运','车务','机务','工务','电务','供电','车辆','通信','信号','房建','给水','供电'];
                for (var i = 0; i < tradeKeys.length; i++) {
                    if (name.indexOf(tradeKeys[i]) !== -1) return tradeKeys[i];
                }
                return name;
            }

            function issueRefreshCategorySelect() {
                var select = document.getElementById('issue-categorySelect');
                if (!select) return;
                var currentValue = select.value;
                var trades = new Set();
                dataCache.forEach(function(item) {
                    if (item.unit) { var trade = extractTradeFromUnit(item.unit); if (trade) trades.add(trade); }
                });
                var sorted = Array.from(trades).sort(function(a, b) { return a.localeCompare(b, 'zh'); });
                select.innerHTML = '<option value="">全部专业</option>';
                sorted.forEach(function(trade) {
                    var opt = document.createElement('option');
                    opt.value = trade; opt.textContent = trade; select.appendChild(opt);
                });
                if (currentValue && sorted.indexOf(currentValue) !== -1) select.value = currentValue;
            }