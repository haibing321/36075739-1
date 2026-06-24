        // ========== Issue System ==========
        (function() {
            const DB_NAME = 'RailwayIssueDB_v2', STORE_NAME = 'issues', DB_VERSION = 2;
            let db = null, dataCache = [], keywordNum = 0, MAX_KEYWORDS = 4;
            let showLowMatch = false, currentResults = [], currentKeywords = [];
            const MATCH_THRESHOLD = 75;
            const searchMode = 'OR';
            const searchFields = ['性质', 'category', 'content', 'regulation', 'unit'];
            let currentPage = 1, pageSize = 20, totalPages = 1, allFilteredResults = [];

            // 立即注册 DB schema（模块加载时，确保 backup.js writeIndexedDB 调用前 schema 已就绪）
            window.dbManager.register('RailwayIssueDB_v2', 2, function(database, e) {
                if (!database.objectStoreNames.contains(STORE_NAME)) {
                    const store = database.createObjectStore(STORE_NAME, { keyPath: 'id', autoIncrement: true });
                    store.createIndex('性质', '性质', { unique: false });
                    store.createIndex('datetime', 'datetime', { unique: false });
                    store.createIndex('category', 'category', { unique: false });
                    store.createIndex('unit', 'unit', { unique: false });
                }
            });

            async function initDB() {
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
                        // 使用 JSON.stringify 精确计算当前模块数据大小
                        const jsonStr = JSON.stringify(data);
                        sizeMB = (jsonStr.length / 1024 / 1024).toFixed(2);
                    }
                    document.getElementById('issue-recordCount').textContent = count + ' 条';

                    // 尝试使用 storageManager 获取真实配额
                    if (window.storageManager) {
                        try {
                            var quotaInfo = await window.storageManager.checkQuota();
                            document.getElementById('issue-storageText').textContent =
                                parseFloat(sizeMB) + ' / ' + quotaInfo.quotaMB + ' MB';
                            const percent = Math.min((parseFloat(sizeMB) / Math.max(quotaInfo.quotaMB, 1)) * 100, 100);
                            var bar = document.getElementById('issue-storageBar');
                            bar.style.width = percent + '%';
                            if (percent > 80) bar.className = 'storage-fill danger';
                            else if (percent > 60) bar.className = 'storage-fill warning';
                            else bar.className = 'storage-fill';
                        } catch(qe) {
                            // 降级为原来的 50MB 硬编码显示
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
                // 铁路单位常见专业关键词（按长度降序，优先匹配更具体的）
                var tradeKeys = ['高铁基础设施','综合维修','基础设施','客运','货运','车务','机务','工务','电务','供电','车辆','通信','信号','房建','给水','供电'];
                // 显式单位名 → 专业映射（优先于关键词匹配）
                var unitTradeMap = {
                    '天水车站':'车务','兰州车站':'车务','迎水桥车站':'车务','兰州北车站':'车务','调度所':'车务',
                    '物流中心':'货运',
                    '天平公司':'建设','华澳公司':'建设','工程管理所':'建设','工程建设指挥部':'建设',
                    '疾病预防控制所':'辅业','后勤保障':'辅业','职工培训中心':'辅业','金轮实业':'辅业'
                };
                if (unitTradeMap[name]) return unitTradeMap[name];
                for (var i = 0; i < tradeKeys.length; i++) {
                    if (name.indexOf(tradeKeys[i]) !== -1) return tradeKeys[i];
                }
                // 无匹配时返回单位名本身
                return name;
            }

            function issueRefreshCategorySelect() {
                var select = document.getElementById('issue-categorySelect');
                if (!select) return;
                var currentValue = select.value;
                // 从 dataCache 的 单位 字段提取专业
                var trades = new Set();
                dataCache.forEach(function(item) {
                    if (item.unit) {
                        var trade = extractTradeFromUnit(item.unit);
                        if (trade) trades.add(trade);
                    }
                });
                var sorted = Array.from(trades).sort(function(a, b) { return a.localeCompare(b, 'zh'); });
                select.innerHTML = '<option value="">全部专业</option>';
                sorted.forEach(function(trade) {
                    var opt = document.createElement('option');
                    opt.value = trade;
                    opt.textContent = trade;
                    select.appendChild(opt);
                });
                // 恢复之前选中的值（如果还存在）
                if (currentValue && sorted.indexOf(currentValue) !== -1) {
                    select.value = currentValue;
                }
            }

            window.issueShowStats = function() {
                var panel = document.getElementById('issue-statsPanel');
                var content = document.getElementById('issue-statsContent');
                if (!panel || !content) return;
                if (panel.style.display === 'block') { panel.style.display = 'none'; return; }
                var data = dataCache;
                if (!data.length) { alert('暂无数据'); return; }
                var nats = {}; data.forEach(function(d) { var v = getXingzhi(d) || '空白'; nats[v] = (nats[v]||0)+1; });
                var cats = {}; data.forEach(function(d) { var v = d.category || '待分类'; cats[v] = (cats[v]||0)+1; });
                var units = {}; data.forEach(function(d) { if (d.unit) { var u = String(d.unit).trim(); units[u] = (units[u]||0)+1; } });
                var topUnits = Object.entries(units).sort(function(a,b){return b[1]-a[1]}).slice(0,10);
                var times = data.map(function(d){return d.datetime||''}).filter(Boolean).sort();
                var timeRange = times.length ? times[0].slice(0,10) + ' ~ ' + times[times.length-1].slice(0,10) : '无数据';
                var aCount = nats['A类'] || 0, redlineCount = nats['红线'] || 0, unitCount = Object.keys(units).length;
                var html = '<style>#issue-statsContent .stats-bar-fill{transition:width 0.7s cubic-bezier(0.4,0,0.2,1)}#issue-statsContent .stats-card{transition:all 0.2s ease}#issue-statsContent .stats-card:hover{transform:translateY(-2px);box-shadow:0 4px 12px rgba(0,0,0,.1)}</style>';
                html += '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:12px;margin-bottom:16px">';
                [{l:'总检查记录',v:data.length,u:'条',c:'#2563eb',b1:'#eff6ff',b2:'#dbeafe'},{l:'A类严重问题',v:aCount,u:'条('+Math.round(aCount/Math.max(data.length,1)*100)+'%)',c:'#dc2626',b1:'#fef2f2',b2:'#fee2e2'},{l:'安全红线',v:redlineCount,u:'条('+Math.round(redlineCount/Math.max(data.length,1)*100)+'%)',c:'#7c3aed',b1:'#f5f3ff',b2:'#ede9fe'},{l:'涉及单位',v:unitCount,u:'个',c:'#059669',b1:'#ecfdf5',b2:'#d1fae5'}].forEach(function(x){html+='<div class="stats-card" style="background:linear-gradient(135deg,'+x.b1+','+x.b2+');border-radius:12px;padding:16px;border:1px solid '+x.b2+'"><div style="font-size:0.73rem;color:'+x.c+';font-weight:600;margin-bottom:6px">'+x.l+'</div><div style="font-size:1.8rem;font-weight:700;color:'+x.c+'">'+x.v+'</div><div style="font-size:0.7rem;color:#64748b">'+x.u+'</div></div>';});
                html += '</div><div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:12px;margin-bottom:16px">';
                html += '<div style="background:#fff;border:1px solid #e2e8f0;border-radius:12px;padding:16px"><div style="font-weight:700;font-size:0.85rem;color:#1e293b;margin-bottom:14px">📊 性质分布</div>';
                var nc={'A类':['#dc2626','#fca5a5'],'B类':['#f59e0b','#fde68a'],'C类':['#3b82f6','#93c5fd'],'红线':['#991b1b','#e53e3e']};
                var mx=Math.max(1,Math.max.apply(null,Object.values(nats)));
                ['A类','B类','C类','红线'].forEach(function(k){var v=nats[k]||0,p=Math.round(v/Math.max(data.length,1)*100),w=Math.max(2,Math.round(v/mx*100)),c=nc[k]||['#64748b','#94a3b8'];html+='<div style="margin-bottom:10px"><div style="display:flex;justify-content:space-between;margin-bottom:3px;font-size:0.75rem"><span style="font-weight:600;color:'+c[0]+'">'+k+'</span><span style="color:#64748b">'+v+'条('+p+'%)</span></div><div style="background:#f1f5f9;border-radius:6px;height:18px;overflow:hidden"><div class="stats-bar-fill" style="width:0;height:100%;background:linear-gradient(90deg,'+c[0]+','+c[1]+');border-radius:6px" data-w="'+w+'%"></div></div></div>';});
                html += '<div style="font-size:0.7rem;color:#94a3b8;margin-top:8px;text-align:center">⏱ '+timeRange+'</div></div>';
                html += '<div style="background:#fff;border:1px solid #e2e8f0;border-radius:12px;padding:16px"><div style="font-weight:700;font-size:0.85rem;color:#1e293b;margin-bottom:14px">📂 类别排行</div>';
                var sc=Object.entries(cats).sort(function(a,b){return b[1]-a[1]}).slice(0,8);
                var mc=Math.max(1,sc.length?sc[0][1]:1);
                var cg=[['#8b5cf6','#a78bfa'],['#6366f1','#818cf8'],['#3b82f6','#60a5fa'],['#06b6d4','#22d3ee'],['#10b981','#34d399'],['#f59e0b','#fbbf24'],['#ef4444','#f87171'],['#ec4899','#f472b6']];
                sc.forEach(function(e,i){var n=e[0],v=e[1],p=Math.round(v/Math.max(data.length,1)*100),w=Math.max(2,Math.round(v/mc*100)),g=cg[i]||['#64748b','#94a3b8'];html+='<div style="margin-bottom:10px"><div style="display:flex;justify-content:space-between;margin-bottom:3px;font-size:0.75rem"><span style="font-weight:600;color:#334155">'+n+'</span><span style="color:#64748b">'+v+'('+p+'%)</span></div><div style="background:#f1f5f9;border-radius:6px;height:18px;overflow:hidden"><div class="stats-bar-fill" style="width:0;height:100%;background:linear-gradient(90deg,'+g[0]+','+g[1]+');border-radius:6px" data-w="'+w+'%"></div></div></div>';});
                html += '</div></div>';
                if(topUnits.length){html+='<div style="background:#fff;border:1px solid #e2e8f0;border-radius:12px;padding:16px"><div style="font-weight:700;font-size:0.85rem;color:#1e293b;margin-bottom:14px">🏆 单位违规TOP'+Math.min(10,topUnits.length)+'</div>';
                var mu=topUnits[0][1];topUnits.forEach(function(e,i){var n=e[0],v=e[1],w=Math.max(2,Math.round(v/mu*100));var r=i===0?['#dc2626','#fecaca','#fef2f2']:i===1?['#d97706','#fde68a','#fffbeb']:i===2?['#2563eb','#bfdbfe','#eff6ff']:['#64748b','#e2e8f0','#f8fafc'];html+='<div style="margin-bottom:8px;padding:8px 10px;background:'+r[2]+';border-radius:8px;border:1px solid '+r[1]+'"><div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px"><div style="display:flex;align-items:center;gap:8px"><span style="width:22px;height:22px;display:inline-flex;align-items:center;justify-content:center;background:'+r[0]+';color:#fff;border-radius:50%;font-size:0.7rem;font-weight:700">'+(i+1)+'</span><span style="font-weight:600;font-size:0.8rem;color:'+r[0]+'">'+n+'</span></div><span style="font-weight:700;font-size:0.85rem;color:'+r[0]+'">'+v+'<span style="font-weight:400;font-size:0.7rem">条</span></span></div><div style="background:#fff;border-radius:4px;height:12px;overflow:hidden"><div class="stats-bar-fill" style="width:0;height:100%;background:linear-gradient(90deg,'+r[0]+','+r[1]+');border-radius:4px" data-w="'+w+'%"></div></div></div>';});
                html+='</div>';}
                content.innerHTML = html; panel.style.display = 'block';
                setTimeout(function(){content.querySelectorAll('.stats-bar-fill').forEach(function(b,i){var w=b.getAttribute('data-w');if(w)setTimeout(function(){b.style.width=w},i*30);});},80);
                panel.scrollIntoView({ behavior: 'smooth' });
            };
            window.issueAddKeyword = function() {
                if (keywordNum >= MAX_KEYWORDS) return;
                keywordNum++;
                const container = document.getElementById('issue-keywordContainer');
                const div = document.createElement('div');
                div.className = 'keyword-row';
                div.id = 'issue-kw_' + keywordNum;
                div.innerHTML = '<label>关键词' + keywordNum + '</label><input type="text" id="issue-input_' + keywordNum + '" placeholder="输入关键词' + keywordNum + '">' + (keywordNum > 1 ? '<button class="btn-remove" onclick="issueRemoveKeyword(' + keywordNum + ')">×</button>' : '');
                container.appendChild(div);
                const input = document.getElementById('issue-input_' + keywordNum);
                if (input) {
                    input.addEventListener('input', debounce(function() {
                        issueDoSearch();
                    }, 500));
                    setTimeout(() => input.focus(), 100);
                }
                issueUpdateAddBtn();
            };

            window.issueRemoveKeyword = function(n) {
                const el = document.getElementById('issue-kw_' + n);
                if (el) el.remove();
                const items = document.querySelectorAll('#issue-keywordContainer .keyword-row');
                keywordNum = 0;
                items.forEach((item) => {
                    keywordNum++;
                    item.id = 'issue-kw_' + keywordNum;
                    item.querySelector('label').textContent = '关键词' + keywordNum;
                    const input = item.querySelector('input');
                    input.id = 'issue-input_' + keywordNum;
                    input.placeholder = '输入关键词' + keywordNum;
                    input.setAttribute('onkeypress', 'issueHandleKeyPress(event,' + keywordNum + ')');
                    const btn = item.querySelector('.btn-remove');
                    if (btn) {
                        if (keywordNum === 1) btn.remove();
                        else btn.setAttribute('onclick', 'issueRemoveKeyword(' + keywordNum + ')');
                    }
                });
                issueUpdateAddBtn();
            };

            function issueUpdateAddBtn() {
                const btn = document.getElementById('issue-btnAdd');
                if (keywordNum >= MAX_KEYWORDS) {
                    btn.disabled = true;
                    btn.textContent = '已达到最大关键词数量(4个)';
                } else {
                    btn.disabled = false;
                    btn.textContent = '+ 添加关键词 (还可添加' + (MAX_KEYWORDS - keywordNum) + '个)';
                }
            }

            window.issueHandleKeyPress = function(event, currentIndex) {
                if (event.key === 'Enter') {
                    event.preventDefault();
                    if (currentIndex < MAX_KEYWORDS && currentIndex === keywordNum) issueAddKeyword();
                    else if (currentIndex < keywordNum) document.getElementById('issue-input_' + (currentIndex + 1)).focus();
                    else issueDoSearch();
                }
            };

            window.issueClearSearch = function() {
                document.getElementById('issue-keywordContainer').innerHTML = '';
                keywordNum = 0;
                issueAddKeyword();
                document.getElementById('issue-results').innerHTML = '';
                document.getElementById('issue-lowMatchResults').innerHTML = '';
                document.getElementById('issue-statsBar').style.display = 'none';
                showLowMatch = false;
                var catSelect = document.getElementById('issue-categorySelect');
                if (catSelect) catSelect.value = '';
            };

            function getXingzhi(item) {
                if (item['性质'] !== undefined && item['性质'] !== null && item['性质'] !== '') return String(item['性质']).trim();
                const fields = ['xingzhi', '问题库性质', '等级', '级别', 'level', '类型', '分类'];
                for (let field of fields) {
                    if (item[field] !== undefined && item[field] !== null && item[field] !== '') return String(item[field]).trim();
                }
                return '空白';
            }

            // ========== Fuse.js 模糊搜索引擎 ==========
            // 替代原来的 O(n) 线性 includes() 扫描
            // 支持模糊匹配、加权评分、容错输入
            var _fuseInstance = null;   // Fuse 实例缓存
            var _fuseDataVersion = 0;   // 数据版本号（变化时重建索引）

            /**
             * 获取/创建 Fuse 实例（懒初始化 + 缓存）
             * @param {Array} data - 检查信息数据数组
             * @returns {Object|null} Fuse 实例，不可用时返回 null
             */
            function getFuseInstance(data) {
                if (typeof Fuse === 'undefined') return null;
                if (_fuseInstance && _fuseDataVersion === data.length) return _fuseInstance;

                try {
                    _fuseInstance = new Fuse(data, {
                        keys: [
                            { name: '性质', weight: 0.3 },
                            { name: 'category', weight: 0.2 },
                            { name: 'content', weight: 0.3 },
                            { name: 'regulation', weight: 0.1 },
                            { name: 'unit', weight: 0.1 }
                        ],
                        threshold: 0.35,           // 低阈值=更宽松的模糊匹配（适合中文）
                        includeScore: true,
                        includeMatches: true,
                        minMatchCharLength: 1,     // 最少匹配字符数
                        useExtendedSearch: true,   // 支持高级查询语法
                        ignoreLocation: true,      // 忽略词位置（短文本场景更适合）
                        findAllMatches: true       // 找所有匹配项而非仅最佳匹配
                    });
                    _fuseDataVersion = data.length;
                    console.log('[search] Fuse.js 索引已创建 (' + data.length + ' 条)');
                    return _fuseInstance;
                } catch(e) {
                    console.warn('[search] Fuse.js 初始化失败:', e.message);
                    return null;
                }
            }

            /**
             * 使用 Fuse.js 执行模糊搜索（多关键词 OR 合并）
             * @param {Array} data - 数据集
             * @param {string[]} keywords - 关键词数组
             * @returns {{ results: Array, method: string }}
             */
            function fuseSearch(data, keywords) {
                var fuse = getFuseInstance(data);
                if (!fuse) return null; // 信号给调用方使用 fallback

                var resultMap = {};  // { itemIndex: { item, scores: [], maxScore: number } }

                keywords.forEach(function(kw) {
                    if (!kw || kw.trim().length === 0) return;
                    try {
                        var hits = fuse.search(kw.trim());
                        hits.forEach(function(hit) {
                            var idx = data.indexOf(hit.item);
                            if (idx === -1) return;
                            if (!resultMap[idx]) {
                                resultMap[idx] = { item: hit.item, scores: [], maxScore: 0 };
                            }
                            // Fuse score: 0=完美匹配, 1=不匹配 → 转换为正分
                            var scorePercent = Math.round((1 - (hit.score || 0)) * 100);
                            resultMap[idx].scores.push(scorePercent);
                            if (scorePercent > resultMap[idx].maxScore) {
                                resultMap[idx].maxScore = scorePercent;
                            }
                        });
                    } catch(e) {
                        console.warn('[search] 关键词 "' + kw + '" 搜索出错:', e.message);
                    }
                });

                // 转换为数组并计算综合匹配率
                var results = [];
                Object.keys(resultMap).forEach(function(idx) {
                    var entry = resultMap[idx];
                    var matchedCount = entry.scores.length;
                    var avgScore = entry.scores.reduce(function(a, b) { return a + b; }, 0) / matchedCount;
                    var matchRate = Math.round((matchedCount / keywords.length) * 100);

                    results.push({
                        ...entry.item,
                        matchCount: matchedCount,
                        totalKw: keywords.length,
                        matchRate: matchRate,
                        fuseScore: Math.round(avgScore),
                        xingzhi: getXingzhi(entry.item)
                    });
                });

                // 排序：先按匹配率，再按 Fuse 评分，最后按时间倒序
                results.sort(function(a, b) {
                    if (b.matchRate !== a.matchRate) return b.matchRate - a.matchRate;
                    if ((b.fuseScore || 0) !== (a.fuseScore || 0)) return (b.fuseScore || 0) - (a.fuseScore || 0);
                    return new Date(b.datetime || 0) - new Date(a.datetime || 0);
                });

                return { results: results, method: 'fuse' };
            }

            window.issueDoSearch = async function() {
                await loadScript('https://cdnjs.cloudflare.com/ajax/libs/fuse.js/6.6.2/fuse.min.js');
                if (window.perfMonitor) perfMonitor.start('search_issue');
                const keywords = [];
                for (let i = 1; i <= keywordNum; i++) {
                    const val = document.getElementById('issue-input_' + i)?.value.trim();
                    if (val) keywords.push(val);
                }
                if (keywords.length === 0) { alert('请输入至少一个关键词'); return; }

                document.getElementById('issue-results').innerHTML = '<div class="loading"><div class="spinner"></div><p>正在搜索...</p></div>';
                var data = dataCache.length > 0 ? dataCache : await loadData();

                // 按选中专业过滤（从单位名称匹配）
                var tradeFilter = document.getElementById('issue-categorySelect')?.value || '';
                if (tradeFilter) {
                    data = data.filter(function(d) { return extractTradeFromUnit(d.unit) === tradeFilter; });
                }

                setTimeout(() => {
                    // ===== 优先使用 Fuse.js 模糊搜索 =====
                    var fuseResult = fuseSearch(data, keywords);

                    if (fuseResult && fuseResult.results) {
                        // Fuse.js 搜索成功
                        results = fuseResult.results;
                        console.log('[search] Fuse.js 模糊搜索: ' + results.length + ' 条结果');
                    } else {
                        // Fallback: 原有线性 includes() 扫描
                        results = [];
                        data.forEach(item => {
                            const xingzhi = getXingzhi(item);
                            let text = '';
                            if (searchFields.includes('性质')) text += xingzhi + ' ';
                            if (searchFields.includes('category')) text += (item.category || '') + ' ';
                            if (searchFields.includes('content')) text += (item.content || '') + ' ';
                            if (item.regulation) text += (item.regulation || '') + ' ';
                            text = text.toLowerCase();

                            let match = 0;
                            keywords.forEach(k => {
                                if (text.includes(k.toLowerCase())) match++;
                            });

                            let matched = (searchMode === 'AND') ? (match === keywords.length) : (match > 0);
                            if (matched) {
                                const matchRate = Math.round((match / keywords.length) * 100);
                                results.push({ ...item, matchCount: match, totalKw: keywords.length, matchRate: matchRate, xingzhi: xingzhi });
                            }
                        });

                        results.sort((a, b) => {
                            if (b.matchRate !== a.matchRate) return b.matchRate - a.matchRate;
                            return new Date(b.datetime || 0) - new Date(a.datetime || 0);
                        });
                    }

                    allFilteredResults = results;
                    currentKeywords = keywords;
                    const highMatch = results.filter(r => r.matchRate >= MATCH_THRESHOLD);
                    const lowMatch = results.filter(r => r.matchRate < MATCH_THRESHOLD);
                    totalPages = Math.ceil(highMatch.length / pageSize) || 1;
                    currentPage = 1;
                    issueDisplayResults(highMatch, lowMatch, keywords);
                    if (window.perfMonitor) perfMonitor.end('search_issue', { resultCount: results.length });
                }, 50);
            };

            function issueDisplayResults(highMatch, lowMatch, keywords) {
                const container = document.getElementById('issue-results');
                const stats = document.getElementById('issue-statsBar');
                const lowContainer = document.getElementById('issue-lowMatchResults');

                const start = (currentPage - 1) * pageSize;
                const paginatedHigh = highMatch.slice(start, start + pageSize);

                stats.style.display = 'flex';
                document.getElementById('issue-highMatchCount').textContent = highMatch.length;
                const lowMatchInfo = document.getElementById('issue-lowMatchInfo');
                const toggleBtn = document.getElementById('issue-toggleLowMatchBtn');
                if (lowMatch.length > 0) {
                    lowMatchInfo.style.display = 'inline';
                    document.getElementById('issue-lowMatchCount').textContent = lowMatch.length;
                    toggleBtn.style.display = 'inline-block';
                    toggleBtn.textContent = showLowMatch ? '🔼 隐藏低匹配' : '👁️ 显示低匹配';
                } else {
                    lowMatchInfo.style.display = 'none';
                    toggleBtn.style.display = 'none';
                }

                if (paginatedHigh.length === 0) {
                    container.innerHTML = '<div class="empty-state"><div class="empty-state-icon">🔍</div><p>未找到高匹配度结果（≥' + MATCH_THRESHOLD + '%）</p></div>';
                } else {
                    let html = '<div class="result-list">' + paginatedHigh.map(item => issueCreateResultCard(item, keywords)).join('') + '</div>';
                    html += `<div class="pagination" style="margin-top:16px; display:flex; gap:12px; justify-content:center; align-items:center;">
                        <button class="btn btn-secondary" ${currentPage === 1 ? 'disabled' : ''} onclick="changeIssuePage(${currentPage - 1})">上一页</button>
                        <span>第 ${currentPage} 页 / 共 ${totalPages} 页</span>
                        <button class="btn btn-secondary" ${currentPage === totalPages ? 'disabled' : ''} onclick="changeIssuePage(${currentPage + 1})">下一页</button>
                    </div>`;
                    container.innerHTML = html;
                }

                if (showLowMatch && lowMatch.length > 0) {
                    lowContainer.style.display = 'block';
                    lowContainer.innerHTML = '<div class="low-match-section"><div class="low-match-header"><span class="low-match-title">📝 低匹配度结果（<' + MATCH_THRESHOLD + '%匹配，' + lowMatch.length + '条）</span></div><div class="result-list">' + lowMatch.map(item => issueCreateResultCard(item, keywords)).join('') + '</div></div>';
                } else {
                    lowContainer.style.display = 'none';
                    lowContainer.innerHTML = '';
                }
            }

            function issueCreateResultCard(item, keywords) {
                let xingzhi = item.xingzhi || getXingzhi(item), levelClass = 'level-kongbai', xingzhiClass = 'tag-xz-kongbai', xz = String(xingzhi).trim();
                if (xz === 'A类' || xz.includes('A')) { levelClass = 'level-a'; xingzhiClass = 'tag-xz-a'; }
                else if (xz === 'B类' || xz.includes('B')) { levelClass = 'level-b'; xingzhiClass = 'tag-xz-b'; }
                else if (xz === 'C类' || xz.includes('C')) { levelClass = 'level-c'; xingzhiClass = 'tag-xz-c'; }
                else if (xz === '红线' || xz.includes('红线')) { levelClass = 'level-hongxian'; xingzhiClass = 'tag-xz-hongxian'; }
                else if (xz === '空白' || xz === '' || xz.includes('空白')) { levelClass = 'level-kongbai'; xingzhiClass = 'tag-xz-kongbai'; xingzhi = '空白'; }
                else { levelClass = 'level-kongbai'; xingzhiClass = 'tag-xz-kongbai'; }
                let content = item.content || '';
                keywords.forEach(k => {
                    const reg = new RegExp('(' + k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ')', 'gi');
                    content = content.replace(reg, '<span class="highlight">$1</span>');
                });
                // 规章依据单独展示
                var regulationHtml = '';
                if (item.regulation) {
                    var regText = item.regulation.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
                    keywords.forEach(function(k){
                        var re = new RegExp('(' + k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ')', 'gi');
                        regText = regText.replace(re, '<span class="highlight">$1</span>');
                    });
                    regulationHtml = '<div style="margin-top:8px;padding:8px;background:#f8fafc;border-left:3px solid #3b82f6;font-size:0.85rem;border-radius:0 4px 4px 0;"><strong>📜 规章依据：</strong>' + regText + '</div>';
                }
                return '<div class="result-card ' + levelClass + '" data-raw-content="' + encodeURIComponent(item.content||'') + '" data-raw-regulation="' + encodeURIComponent(item.regulation||'') + '"><div class="match-badge">' + item.matchCount + '/' + item.totalKw + ' 匹配 ' + item.matchRate + '%</div><div class="result-header"><span class="tag tag-xingzhi ' + xingzhiClass + '">' + xingzhi + '</span><span class="tag tag-category">' + (item.category || '待分类') + '</span><span class="tag tag-time">📅 ' + (item.datetime || '无日期') + '</span>' + (item.unit ? '<span class="tag tag-unit">🏢 ' + escapeHtml(String(item.unit)) + '</span>' : '') + '</div><div class="result-content"><div class="result-content-header"><button class="btn-copy" onclick="issueCopyContent(this)">📋 复制</button><button class="btn-copy" onclick="addIssueToDiaryFromCard(this)" style="background:#3b82f6;margin-left:6px;">📝 记入日志</button></div><div class="result-text" data-content="' + encodeURIComponent(content.replace(/"/g, '&quot;')) + '">' + content + '</div>' + regulationHtml + '</div></div>';
            }

            window.issueCopyContent = function(btn) {
                const contentDiv = btn.closest('.result-content').querySelector('.result-text'), encodedContent = contentDiv.getAttribute('data-content'), htmlContent = decodeURIComponent(encodedContent), tempDiv = document.createElement('div');
                tempDiv.innerHTML = htmlContent; const plainText = tempDiv.textContent || tempDiv.innerText || '';
                navigator.clipboard.writeText(plainText).then(() => {
                    btn.classList.add('copied'); btn.textContent = '✅ 已复制';
                    setTimeout(() => { btn.classList.remove('copied'); btn.textContent = '📋 复制'; }, 2000);
                }).catch(() => {
                    const textarea = document.createElement('textarea'); textarea.value = plainText; textarea.style.position = 'fixed'; textarea.style.opacity = '0'; document.body.appendChild(textarea); textarea.select();
                    try { document.execCommand('copy'); btn.classList.add('copied'); btn.textContent = '✅ 已复制'; setTimeout(() => { btn.classList.remove('copied'); btn.textContent = '📋 复制'; }, 2000); } catch (e) { alert('复制失败'); }
                    document.body.removeChild(textarea);
                });
            };
            // 从检查信息结果卡记入工作日志
            window.addIssueToDiaryFromCard = function(btn) {
                const card = btn.closest('.result-card');
                if (!card) return;
                const content = decodeURIComponent(card.dataset.rawContent || '');
                const regulation = decodeURIComponent(card.dataset.rawRegulation || '');
                if (!content.trim()) return;
                if (window.addIssueToDiary) {
                    window.addIssueToDiary(content, regulation);
                    btn.textContent = '✅ 已记入';
                    btn.disabled = true;
                    setTimeout(function() { btn.textContent = '📝 记入日志'; btn.disabled = false; }, 2000);
                } else {
                    alert('工作日志模块未加载');
                }
            };

            window.issueToggleLowMatch = function() { showLowMatch = !showLowMatch; if (allFilteredResults.length > 0) { const high = allFilteredResults.filter(r => r.matchRate >= MATCH_THRESHOLD); const low = allFilteredResults.filter(r => r.matchRate < MATCH_THRESHOLD); issueDisplayResults(high, low, currentKeywords); } };
            window.changeIssuePage = function(page) {
                if (page < 1 || page > totalPages) return;
                currentPage = page;
                const high = allFilteredResults.filter(r => r.matchRate >= MATCH_THRESHOLD);
                const low = allFilteredResults.filter(r => r.matchRate < MATCH_THRESHOLD);
                issueDisplayResults(high, low, currentKeywords);
            };

            window.issueImportFile = function() { document.getElementById('issue-fileInput').click(); };
            // 统一导入入口：根据文件后缀分派 Excel 或 JSON
            window.issueHandleFile = async function(e) {
                const file = e.target.files[0]; if (!file) return;
                const name = file.name.toLowerCase();
                if (name.endsWith('.json')) {
                    await issueHandleJSON(file);
                } else {
                    await issueHandleExcel({ target: { files: [file] } });
                }
                e.target.value = '';
            };
            // JSON 导入
            async function issueHandleJSON(file) {
                try {
                    const text = await file.text();
                    const imported = JSON.parse(text);
                    if (!Array.isArray(imported)) throw new Error('JSON 数据必须是数组');
                    if (imported.length === 0) throw new Error('JSON 文件无有效数据');
                    // 规范化字段（兼容不同命名）—— 6列标准: 性质 | 时间 | 类别 | 问题描述 | 规章依据 | 单位
                    const normalized = imported.map(function(item){
                        var norm = {
                            '性质': item['性质'] || item.xingzhi || item['问题库性质'] || item['等级'] || item['级别'] || item.level || '',
                            datetime: item.datetime || item['时间'] || item['日期'] || item.date || new Date().toLocaleString('zh-CN'),
                            category: item.category || item['类别'] || item['专业'] || item['项目'] || '待分类',
                            content: item.content || item['问题描述'] || item['问题'] || item['描述'] || '',
                            regulation: item.regulation || item['规章依据'] || item['违反规章'] || item['法规依据'] || item['条款'] || '',
                            unit: item.unit || item['单位'] || item['责任单位'] || item.danwei || item['部门'] || item.department || ''
                        };
                        // 如果 regulation 为空，尝试从 content 中提取完整引用句子
                        if (!norm.regulation && norm.content) {
                            norm.regulation = extractFullViolationSentence(norm.content);
                        }
                        return norm;
                    });
                    const existingCount = dataCache.length;
                    let finalData = normalized;
                    if (existingCount > 0) {
                        const action = confirm(`当前已有 ${existingCount} 条记录。\n点击"确定"覆盖，点击"取消"追加`);
                        if (!action) finalData = [...dataCache, ...normalized];
                    }
                    await saveData(finalData); await updateStorage();
                    alert(`成功导入 ${imported.length} 条JSON记录`);
                } catch (err) { alert('JSON导入失败: ' + err.message); }
            }
            window.issueHandleExcel = async function(e) {
                await loadScript('https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js');
                const file = e.target.files[0]; if (!file) return;
                openModal('issue-importModal');
                try {
                    const data = await file.arrayBuffer(), workbook = XLSX.read(data, { type: 'array' }), firstSheet = workbook.Sheets[workbook.SheetNames[0]], jsonData = XLSX.utils.sheet_to_json(firstSheet, { header: 1 });
                    if (jsonData.length < 2) throw new Error('Excel文件数据不足');
                    const headers = jsonData[0].map(h => String(h).trim());
                    const findCol = (names) => { for (let i = 0; i < headers.length; i++) { const header = headers[i].toLowerCase().replace(/\s/g, ''); for (let name of names) { if (header === name.toLowerCase() || header.includes(name.toLowerCase())) return i; } } return -1; };
                    const cols = {
                        xingzhi: findCol(['性质', '问题库性质', '等级', '级别', 'level']),
                        datetime: findCol(['时间', '日期', 'datetime', 'date']),
                        category: findCol(['类别', '专业', 'category', '项目']),
                        content: findCol(['问题描述', '内容', '描述', 'content', '问题']),
                        regulation: findCol(['规章依据', '违反规章', '法规依据', '条款', 'regulation']),
                        unit: findCol(['单位', '责任单位', '单位名称', 'unit', '部门', 'department'])
                    };
                    if (cols.content === -1) throw new Error('未找到"内容"列');
                    const newData = []; let skipCount = 0;
                    for (let i = 1; i < jsonData.length; i++) {
                        const row = jsonData[i]; if (!row || row.length === 0) { skipCount++; continue; }
                        const content = cols.content !== -1 ? String(row[cols.content] || '').trim() : ''; if (!content) { skipCount++; continue; }
                        let xz = '空白'; if (cols.xingzhi !== -1 && row[cols.xingzhi] !== undefined && row[cols.xingzhi] !== null) { xz = String(row[cols.xingzhi]).trim(); if (xz === '') xz = '空白'; }
                        // 先取 Excel 中的 regulation 列
                        let regulation = cols.regulation !== -1 ? String(row[cols.regulation] || '').trim() : '';
                        // 如果 regulation 为空，尝试从 content 中提取完整引用句子
                        if (!regulation && content) {
                            regulation = extractFullViolationSentence(content);
                        }
                        newData.push({
                            id: Date.now() + i,
                            '性质': xz,
                            datetime: cols.datetime !== -1 ? formatExcelDate(row[cols.datetime]) : new Date().toLocaleString('zh-CN'),
                            category: cols.category !== -1 ? String(row[cols.category] || '待分类').trim() : '待分类',
                            content: content,
                            regulation: regulation,
                            unit: cols.unit !== -1 ? String(row[cols.unit] || '').trim() : ''
                        });
                    }
                    if (newData.length === 0) throw new Error('未找到有效数据');
                    const existingCount = dataCache.length; let finalData = newData;
                    if (existingCount > 0) {
                        const action = confirm('当前已有 ' + existingCount + ' 条记录。\n点击"确定"覆盖，点击"取消"追加');
                        if (!action) finalData = [...dataCache, ...newData];
                    }
                    document.getElementById('issue-importStatus').textContent = '正在保存...';
                    await saveData(finalData); await updateStorage(); closeModal('issue-importModal');
                } catch (err) { closeModal('issue-importModal'); alert('导入失败: ' + err.message); }
                e.target.value = '';
            };

            function formatExcelDate(cell) {
                if (!cell) return new Date().toLocaleString('zh-CN');
                if (typeof cell === 'number') { const date = XLSX.SSF.parse_date_code(cell); if (date) return date.y + '-' + String(date.m).padStart(2, '0') + '-' + String(date.d).padStart(2, '0') + ' ' + String(date.H).padStart(2, '0') + ':' + String(date.M).padStart(2, '0'); }
                return String(cell);
            }

            window.issueExportJSON = function() {
                if (dataCache.length === 0) { alert('没有数据可导出'); return; }
                const exportData = dataCache.map(item => ({
                    '性质': getXingzhi(item),
                    '时间': item.datetime || '',
                    '类别': item.category || '待分类',
                    '问题描述': item.content || '',
                    '规章依据': item.regulation || '',
                    '单位': item.unit || ''
                }));
                const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: 'application/json' });
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = '铁路检查信息_' + new Date().toISOString().slice(0, 10) + '_' + dataCache.length + '条.json';
                a.click();
                URL.revokeObjectURL(url);
            };

            window.issueDownloadTemplate = function() {
                const template = [{ '性质': 'A类', '时间': '2025-12-29 17:09', '类别': '消防安全', '问题描述': '示例：A类问题描述...', '规章依据': '《消防法》第XX条', '单位': 'XX站段' }, { '性质': 'B类', '时间': '2025-12-29 16:32', '类别': '规章制度', '问题描述': '示例：B类问题描述...', '规章依据': '《铁路安全管理条例》第XX条', '单位': 'XX站段' }, { '性质': 'C类', '时间': '2025-12-29 10:00', '类别': '设备管理', '问题描述': '示例：C类问题描述...', '单位': 'XX站段' }, { '性质': '红线', '时间': '2025-12-29 09:00', '类别': '安全红线', '问题描述': '示例：红线问题描述...', '规章依据': '《安全红线管理办法》第XX条', '单位': 'XX站段' }, { '性质': '空白', '时间': '2025-12-29 08:00', '类别': '待分类', '问题描述': '示例：空白性质问题描述...', '单位': 'XX站段' }];
                const ws = XLSX.utils.json_to_sheet(template), wb = XLSX.utils.book_new();
                XLSX.utils.book_append_sheet(wb, ws, '导入模板'); ws['!cols'] = [{ wch: 10 }, { wch: 20 }, { wch: 15 }, { wch: 100 }, { wch: 60 }, { wch: 12 }];
                XLSX.writeFile(wb, '问题库导入模板.xlsx');
            };

            async function issueLoadDemoData() {
                const demo = [
                    { id: 1, '性质': 'A类', datetime: '2025-12-29 17:09', category: '消防安全', content: '兰州高铁基础设施段动车所信号工区遗漏机械室门口的七氟丙烷消防柜柜门无法打开。', regulation: '《消防法》第16条', unit: '兰州高铁基础设施段' },
                    { id: 2, '性质': 'B类', datetime: '2025-12-29 16:32', category: '规章制度', content: '检查兰州高铁基础设施段注浆施工，4号道口南侧汽车吊吊装作业时支腿下未放垫木。', regulation: '《铁路安全管理条例》第XX条', unit: '兰州高铁基础设施段' },
                    { id: 3, '性质': 'C类', datetime: '2025-12-29 10:00', category: '设备管理', content: '检查发现设备标识不清，台账记录不完整。', unit: 'XX电务段' },
                    { id: 4, '性质': '红线', datetime: '2025-12-29 09:00', category: '安全红线', content: '触碰安全红线：未设置防护上道作业。', regulation: '《安全红线管理办法》第XX条', unit: 'XX工务段' },
                    { id: 5, '性质': '空白', datetime: '2025-12-29 08:00', category: '待分类', content: '问题描述暂未完成性质判定。', unit: 'XX站段' }
                ];
                await saveData(demo); await updateStorage();
            }

            window.issueShowClear = function() { document.getElementById('issue-clearCount').textContent = dataCache.length; openModal('issue-clearModal'); };
            window.issueHideModal = function(id) { closeModal(id); };
            window.issueConfirmClear = async function() {
                try { await clearAllData(); dataCache = []; await updateStorage(); closeModal('issue-clearModal'); document.getElementById('issue-results').innerHTML = ''; document.getElementById('issue-lowMatchResults').innerHTML = ''; document.getElementById('issue-statsBar').style.display = 'none'; alert('所有数据已清空'); } catch (e) { alert('清空失败: ' + e.message); }
            };

            window.addEventListener('load', async function() {
                // 始终绑定文件导入事件（不依赖 IndexedDB 初始化成功）
                document.getElementById('issue-fileInput').addEventListener('change', issueHandleFile);
                try {
                    await initDB();
                    await updateStorage();
                    issueAddKeyword();
                    const data = await loadData();
                    if (data.length === 0) await issueLoadDemoData();
                } catch (e) {
                    console.error('[issue] 初始化失败:', e.message);
                    // IndexedDB 版本冲突通常是临时的，刷新可恢复
                    if (e.message.indexOf('abort') !== -1 || e.message.indexOf('block') !== -1) {
                        console.warn('[issue] 可能是浏览器IndexedDB冲突，请关闭其他标签页后刷新');
                    }
                }
            });

            // 暴露 issue 数据供其他模块调用（如智能助手联动）
            window.getIssueData = function() { return dataCache; };
        })();
