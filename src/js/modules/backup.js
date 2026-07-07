/**
 * Backup（备份恢复）模块
 * ===================================================
 * 功能：全局数据打包备份与恢复
 *   - oneClickBackup(): ZIP 打包所有模块数据并下载
 *   - oneClickRestore(): 从 ZIP 文件恢复数据到各模块
 * 
 * 依赖：
 *   - 外部库: JSZip
 *   - IndexedDB: IssueDB, RuleDB, DiaryDB, MemoDB, PhoneDB, HandbookDB
 *   - localStorage: 各模块的配置数据
 *   - Toast 系统（如果可用）
 * 
 * 导出到 window:
 *   - window.oneClickBackup
 *   - window.oneClickRestore
 */

// ============================================================
// 全局数据备份与恢复 IIFE
// ========== 全局数据备份与恢复 ==========
(function() {
    function readIndexedDB(dbName, storeName, version) {
        return new Promise(function(resolve) {
            try {
                // 优先用 dbManager 获取共享连接，避免版本冲突
                if (window.dbManager && typeof window.dbManager.getDB === 'function') {
                    window.dbManager.getDB(dbName).then(function(db) {
                        if (!db.objectStoreNames.contains(storeName)) { return resolve([]); }
                        var tx = db.transaction(storeName, 'readonly');
                        var store = tx.objectStore(storeName);
                        var getAll = store.getAll();
                        getAll.onsuccess = function(){ resolve(getAll.result || []); };
                        getAll.onerror = function(){ resolve([]); };
                    }).catch(function(){ resolve([]); });
                    return;
                }
            } catch(e) { /* fallback */ }
            
            // 回退：直接打开
            var req = indexedDB.open(dbName, version || 1);
            req.onerror = function(){ resolve([]); };
            req.onsuccess = function(){
                var db = req.result;
                if (!db.objectStoreNames.contains(storeName)) { db.close(); return resolve([]); }
                var tx = db.transaction(storeName, 'readonly');
                var store = tx.objectStore(storeName);
                var getAll = store.getAll();
                getAll.onsuccess = function(){ resolve(getAll.result || []); };
                getAll.onerror = function(){ resolve([]); };
                tx.oncomplete = function(){ db.close(); };
            };
        });
    }

    function writeIndexedDB(dbName, storeName, version, data, clearFirst) {
        if (clearFirst === undefined) clearFirst = true;
        return new Promise(function(resolve, reject) {
            var p;
            var isOwnDB = false;
            if (window.dbManager && typeof window.dbManager.getDB === 'function') {
                p = window.dbManager.getDB(dbName).then(function(db) {
                    if (!db.objectStoreNames.contains(storeName)) {
                        console.warn('[writeIndexedDB] ' + dbName + ' 缺少 ' + storeName + '，回退独立连接');
                        try { db.close(); } catch(e) {}
                        if (window.dbManager && typeof window.dbManager.closeDB === 'function') {
                            window.dbManager.closeDB(dbName);
                        }
                        throw new Error('_FALLBACK_');
                    }
                    return db;
                }).catch(function(err) {
                    // dbManager 失败（store 缺失 / 版本冲突 / 连接断开等）→ 统一回退独立连接
                    console.warn('[writeIndexedDB] dbManager 失败(' + dbName + '):', err.message, '→ 回退独立连接');
                    // 清理 dbManager 缓存，避免连接冲突
                    if (window.dbManager && typeof window.dbManager.closeDB === 'function') {
                        window.dbManager.closeDB(dbName);
                    }
                    isOwnDB = true;
                    return new Promise(function(res, rej) {
                        // 先探测当前版本，再以 >= 当前版本的方式打开（避免 "requested version less than existing" 报错）
                        var fallbackVer = version || 1;
                        var rawReq = indexedDB.open(dbName);
                        rawReq.onsuccess = function() {
                            var existingVer = rawReq.result.version;
                            rawReq.result.close();
                            var targetVer = Math.max(fallbackVer, existingVer + 1);
                            var req = indexedDB.open(dbName, targetVer);
                            req.onupgradeneeded = function(e) {
                                var db2 = e.target.result;
                                if (!db2.objectStoreNames.contains(storeName)) {
                                    db2.createObjectStore(storeName, { keyPath: 'id', autoIncrement: true });
                                }
                            };
                            req.onsuccess = function() { res(req.result); };
                            req.onerror = function() { rej(req.error); };
                        };
                        rawReq.onerror = function() {
                            // 无法探测 → 用原版本直接开（可能会失败）
                            var req = indexedDB.open(dbName, fallbackVer);
                            req.onupgradeneeded = function(e) {
                                var db2 = e.target.result;
                                if (!db2.objectStoreNames.contains(storeName)) {
                                    db2.createObjectStore(storeName, { keyPath: 'id', autoIncrement: true });
                                }
                            };
                            req.onsuccess = function() { res(req.result); };
                            req.onerror = function() { rej(req.error); };
                        };
                    });
                });
            } else {
                isOwnDB = true;
                p = new Promise(function(res, rej) {
                    var req = indexedDB.open(dbName, version || 1);
                    req.onupgradeneeded = function(e) {
                        var db = e.target.result;
                        if (!db.objectStoreNames.contains(storeName)) {
                            db.createObjectStore(storeName, { keyPath: 'id', autoIncrement: true });
                        }
                    };
                    req.onsuccess = function() { res(req.result); };
                    req.onerror = function() { rej(req.error); };
                });
            }
            p.then(function(db) {
                var tx = db.transaction(storeName, 'readwrite');
                var store = tx.objectStore(storeName);
                if (clearFirst) {
                    store.clear();
                }
                var completed = 0;
                var hasError = false;
                for (var i = 0; i < data.length; i++) {
                    var item = data[i];
                    // 移除原有的 id 字段，让数据库自动生成新 ID，避免冲突
                    var cleanItem = {};
                    for (var k in item) {
                        if (item.hasOwnProperty(k) && k !== 'id') cleanItem[k] = item[k];
                    }
                    var addReq = store.add(cleanItem);
                    addReq.onerror = function(ev) {
                        console.error('写入 ' + dbName + '.' + storeName + ' 失败:', ev.target.error);
                        hasError = true;
                        reject(ev.target.error);
                    };
                    addReq.onsuccess = function() {
                        completed++;
                        if (completed === data.length && !hasError) {
                            resolve();
                        }
                    };
                }
                if (data.length === 0) resolve();
                tx.oncomplete = function() {
                    // 只有自己打开的连接才关闭，dbManager 共享连接不关
                    if (isOwnDB) { try { db.close(); } catch(e) {} }
                    resolve();
                };
                tx.onerror = function() {
                    if (!hasError) {
                        console.error('事务错误 ' + dbName + '.' + storeName + ':', tx.error);
                        reject(tx.error);
                    }
                };
            }).catch(function(err) { reject(err); });
        });
    }

    function getLocal(key, def) {
        try { var v = localStorage.getItem(key); return v ? JSON.parse(v) : def; } catch(e) { return def; }
    }

    function _toast(msg, isErr) {
        try { if (typeof Toast !== 'undefined') { isErr ? Toast.error(msg) : Toast.success(msg); return; } } catch(e) {}
        alert(msg);
    }

    /**
     * 通用文件下载函数，兼容所有浏览器（含华为浏览器 / Edge / Safari / 微信 / iOS 等）
     * 解决华为浏览器以下问题：
     *   - 不支持程序化 a.click() 下载
     *   - ZIP 文件必须设置正确 MIME type
     *   - 手机端手势丢失后下载失效
     *   - 需要回退到可见的下载按钮
     */
    function downloadBlob(blob, filename) {
        // 确保ZIP文件有正确的MIME类型（华为等浏览器对此更严格）
        if (filename.endsWith('.zip') && (!blob.type || blob.type === '' || blob.type === 'application/octet-stream')) {
            blob = new Blob([blob], { type: 'application/zip' });
        }

        // 方案1: msSaveOrOpenBlob（EdgeHTML / 新版Edge部分版本 / 华为部分旧版内核）
        if (window.navigator && window.navigator.msSaveOrOpenBlob) {
            try { window.navigator.msSaveOrOpenBlob(blob, filename); return; } catch(e) {}
        }
        // 方案2: msSaveBlob（IE / 旧Edge）
        if (window.navigator && window.navigator.msSaveBlob) {
            try { window.navigator.msSaveBlob(blob, filename); return; } catch(e) {}
        }

        var url = URL.createObjectURL(blob);
        var isMobile = /Mobi|Android|HuaweiBrowser|HMS/i.test(navigator.userAgent);
        var isComplex = filename.endsWith('.zip') || filename.endsWith('.docx') || filename.endsWith('.xlsx');

        if (isMobile && isComplex) {
            // === 华为手机端 + ZIP/DOCX/XLSX：显示手动点击的下载按钮 ===
            showMobileDownloadBtn(url, filename);
        } else {
            // === 桌面端 / 手机端简单格式（JSON/TXT）：标准 a.click() ===
            var a = document.createElement('a');
            a.href = url;
            a.download = filename;
            a.style.display = 'none';
            document.body.appendChild(a);   // 必须：华为浏览器要求元素在DOM树中才能触发下载
            a.click();
            setTimeout(function() {
                if (a.parentNode) document.body.removeChild(a);
                setTimeout(function() { URL.revokeObjectURL(url); }, 60000);
            }, isMobile ? 2000 : 500);
        }
    }

    /**
     * 显示移动端下载按钮（当 a.click() 在手机上不可靠时使用）
     */
    function showMobileDownloadBtn(url, filename) {
        // 移除旧按钮
        var old = document.getElementById('_mobile_dl_btn');
        if (old && old.parentNode) old.parentNode.removeChild(old);

        var displayName = filename.length > 30 ? filename.slice(0, 27) + '...' : filename;

        var btn = document.createElement('a');
        btn.id = '_mobile_dl_btn';
        btn.href = url;
        btn.download = filename;
        btn.innerHTML = '<span style="font-size:1.3rem;vertical-align:middle;">📥</span> 下载: ' + displayName;
        btn.style.cssText = [
            'display:block;position:fixed;bottom:80px;left:50%;',
            'transform:translateX(-50%);',
            'background:linear-gradient(135deg,#059669,#10b981);',
            'color:#fff;padding:14px 28px;border-radius:25px;',
            'text-decoration:none;font-size:0.95rem;font-weight:600;',
            'z-index:99999;box-shadow:0 4px 20px rgba(5,150,105,0.4);',
            'white-space:nowrap;animation:_mbdlFadeIn .3s ease;'
        ].join('');

        // 注入动画样式（仅一次）
        if (!document.getElementById('_mbdl_style')) {
            var s = document.createElement('style');
            s.id = '_mbdl_style';
            s.textContent = '@keyframes _mbdlFadeIn{from{opacity:0;transform:translateX(-50%) translateY(20px);}to{opacity:1;transform:translateX(-50%) translateY(0);}}';
            document.head.appendChild(s);
        }

        document.body.appendChild(btn);

        // 15秒后自动移除（比 rule.js 更长，给用户足够时间点击）
        setTimeout(function() {
            if (btn.parentNode) btn.parentNode.removeChild(btn);
            setTimeout(function() { URL.revokeObjectURL(url); }, 30000);
        }, 15000);
    }

    /**
     * 安全触发文件选择器（兼容华为浏览器等移动端）
     * 关键修复：input 必须在 DOM 树中才能在华为浏览器正常弹出选择对话框
     */
    // ⚠️ 重要：input.click() 必须在同步用户手势上下文中执行
    // requestAnimationFrame 会丢失用户手势，导致文件选择器被浏览器拦截
    function triggerFileInput(accept, callback) {
        var input = document.createElement('input');
        input.type = 'file';
        input.accept = accept || '*/*';
        input.style.cssText = 'position:fixed;left:-9999px;top:-9999px;opacity:0;width:0;height:0;';

        // 必须添加到 DOM —— 华为浏览器不在此 DOM 中则 click() 无效
        document.body.appendChild(input);

        input.onchange = function(e) {
            callback(e);
            setTimeout(function() {
                if (input.parentNode) document.body.removeChild(input);
            }, 100);
        };

        input.addEventListener('cancel', function() {
            setTimeout(function() {
                if (input.parentNode) document.body.removeChild(input);
            }, 100);
        }, { once: true });

        // 同步 click，保留用户手势上下文
        try { input.click(); } catch(err) {
            console.warn('[backup] input.click() 失败:', err.message);
        }
    }

    window.oneClickBackup = async function() {
        await loadScript('https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js');
        if (typeof JSZip === 'undefined') { _toast('JSZip 未加载，请检查网络后刷新重试', true); return; }
        window.showProgress(5, '正在收集检查信息…');
        var backup = { version: 3, exportDate: new Date().toISOString(), modules: {} };
        var errors = [];
        try {
            try { backup.modules.issues = await readIndexedDB('RailwayIssueDB_v2', 'issues', 2); } catch(e) { errors.push('检查信息: '+e.message); backup.modules.issues = []; }
            window.showProgress(15, '正在收集规章制度…');
            try { backup.modules.rules = await readIndexedDB('RailwayRuleDB', 'ruleCollection', 3); } catch(e) { errors.push('规章制度: '+e.message); backup.modules.rules = []; }
            window.showProgress(25, '正在收集工作日志…');
            backup.modules.diary = getLocal('railway_work_diary_v2', []);
            window.showProgress(30, '正在收集车站电话…');
            backup.modules.phone = getLocal('railway_phone_db_v1', []);
            window.showProgress(35, '正在收集检查手册…');
            backup.modules.handbook = getLocal('handbook_fourlevel_v1', []);
            window.showProgress(40, '正在收集写作资料…');
            try { backup.modules.writingMaterials = await readIndexedDB('railway_writer_db', 'writing_materials', 2); } catch(e) { errors.push('写作资料: '+e.message); backup.modules.writingMaterials = []; }
            window.showProgress(45, '正在收集历史报告…');
            try { backup.modules.writingReports = await readIndexedDB('railway_writer_db', 'writing_reports', 2); } catch(e) { errors.push('写作报告: '+e.message); backup.modules.writingReports = []; }
            window.showProgress(50, '正在收集对话记录…');
            backup.modules.dsConversations = getLocal('ds_conversations_v1', []);
            backup.modules.dsChatHistory = getLocal('ds_chat_history_v1', []);
            window.showProgress(55, '正在收集术语库…');
            backup.modules.termLibrary = getLocal('patch_term_library_v2', []);
            backup.modules.memos = getLocal('railway_memo_v1', []);
            window.showProgress(60, '正在收集多媒体文件…');
            backup.modules.diaryMedia = await readIndexedDB('DiaryMediaDB', 'media', 1);
            // 将 diaryMedia 中的 blob (ArrayBuffer) 异步转为 base64，避免手机端主线程卡死
            var mediaFileCount = 0, mediaTotalBytes = 0;
            if (backup.modules.diaryMedia && backup.modules.diaryMedia.length > 0) {
                _toast('正在处理多媒体文件(' + backup.modules.diaryMedia.length + '个)…');
                var converted = [];
                for (var i = 0; i < backup.modules.diaryMedia.length; i++) {
                    var rec = backup.modules.diaryMedia[i];
                    var copy = { id: rec.id, type: rec.type || 'image/jpeg', captureTime: rec.captureTime || '' };
                    if (rec.blob) {
                        // 兼容不同浏览器返回格式（ArrayBuffer 或 Blob）
                        var rawBlob = rec.blob instanceof Blob ? rec.blob : new Blob([rec.blob], { type: rec.type || 'application/octet-stream' });
                        var rawSize = rec.blob.byteLength || rec.blob.size || rawBlob.size || 0;
                        // 使用 FileReader 异步编码，不阻塞主线程（华为/手机端不会卡死）
                        copy.blobBase64 = await new Promise(function(resolve) {
                            var reader = new FileReader();
                            reader.onload = function() { resolve(reader.result.split(',')[1] || ''); };
                            reader.onerror = function() { resolve(''); };
                            reader.readAsDataURL(rawBlob);
                        });
                        copy.blobSize = rawSize;
                        mediaFileCount++;
                        mediaTotalBytes += rawSize;
                        // 每处理5个文件让出主线程，给 UI 刷新的机会
                        if (i % 5 === 4) { await new Promise(function(r) { setTimeout(r, 10); }); }
                    }
                    converted.push(copy);
                }
                backup.modules.diaryMedia = converted;
            }

            window.showProgress(70, '正在压缩打包…');
            var zip = new JSZip();
            zip.file('full_backup.json', JSON.stringify(backup, null, 2));
            var blob = await zip.generateAsync({ type: 'blob' });
            window.showProgress(90, '正在下载…');
            var fileName = '安监系统备份_' + new Date().toISOString().slice(0,19).replace(/:/g,'-') + '.zip';

            // 使用兼容性下载函数（替代原来的简单 a.click()）
            downloadBlob(blob, fileName);

            window.finishProgress('✅ 备份完成' + (mediaFileCount > 0 ? ' · 含' + mediaFileCount + '个附件' : '') +
                   (errors.length > 0 ? ' ⚠️ 部分模块失败' : ''));
        } catch(e) { window.hideProgress(); _toast('备份失败：' + e.message, true); }
    };

    // ---- 全局导入进度条（使用全局 showProgress） ----
    function _showRestoreProgress(show) { if (!show) window.hideProgress(); }
    function _setRestoreProgress(pct, status) { window.showProgress(pct, status); }

    window.oneClickRestore = function() {
        // 先用同步手势打开文件选择器（避免 await 丢失用户手势）
        triggerFileInput('.zip', async function(e) {
            await loadScript('https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js');
            if (typeof JSZip === 'undefined') { _toast('JSZip 未加载，请检查网络后刷新重试', true); return; }
            var file = e.target.files[0]; if (!file) return;
            try {
                _setRestoreProgress(5, '正在解析备份文件…');
                var zip = await JSZip.loadAsync(file);
                var backupFile = zip.file('full_backup.json');
                if (!backupFile) throw new Error('缺少 full_backup.json，可能不是有效的安系统备份文件');
                var backup = JSON.parse(await backupFile.async('string'));
                // 兼容旧版本备份：v1/v2 自动升级到 v3
                if (!backup.version || backup.version < 1 || backup.version > 3) {
                    throw new Error('无法识别的备份文件版本（当前文件v' + (backup.version||'未知') + '，仅支持v1~v3）');
                }
                if (backup.version < 3) {
                    console.warn('[backup] 旧版本备份 v' + backup.version + '，自动升级到 v3');
                    backup.version = 3;
                    if (!backup.modules.writingMaterials) backup.modules.writingMaterials = [];
                    if (!backup.modules.writingReports) backup.modules.writingReports = [];
                    if (!backup.modules.termLibrary) backup.modules.termLibrary = [];
                    if (!backup.modules.memos) backup.modules.memos = [];
                    if (!backup.modules.diaryMedia) backup.modules.diaryMedia = [];
                }

                _showRestoreProgress(true);
                _setRestoreProgress(10, '正在恢复检查信息…');
                var bm = backup.modules;
                _setRestoreProgress(15, '正在恢复检查信息…');
                if (bm.issues && Array.isArray(bm.issues) && bm.issues.length) {
                    await writeIndexedDB('RailwayIssueDB_v2', 'issues', 2, bm.issues);
                    console.log('已恢复 ' + bm.issues.length + ' 条检查信息');
                } else {
                    console.warn('备份中无检查信息数据');
                }
                _setRestoreProgress(25, '正在恢复规章制度…');
                if (bm.rules && Array.isArray(bm.rules) && bm.rules.length) {
                    // 兼容备份格式：规章数据可能是 {id:1, data:[...]} 或直接的数组
                    var standardRules = bm.rules;
                    if (!(bm.rules.length === 1 && bm.rules[0].id === 1 && bm.rules[0].data)) {
                        standardRules = [{ id: 1, data: bm.rules }];
                    }
                    var rulesRestored = await new Promise(function(resolve, reject) {
                        window.dbManager.getDB('RailwayRuleDB').then(function(db) {
                            var tx = db.transaction('ruleCollection', 'readwrite');
                            var store = tx.objectStore('ruleCollection');
                            store.clear();
                            for (var i = 0; i < standardRules.length; i++) {
                                store.put(standardRules[i]);
                            }
                            tx.oncomplete = function() { resolve(standardRules[0].data.length); };
                            tx.onerror = function() { reject(tx.error); };
                        }).catch(function(err) {
                            // dbManager 失败 → 回退独立连接（自动探测版本+创建 store）
                            console.warn('[backup] RailwayRuleDB 连接失败，回退独立连接:', err.message);
                            if (window.dbManager && typeof window.dbManager.closeDB === 'function') {
                                window.dbManager.closeDB('RailwayRuleDB');
                            }
                            var rawReq = indexedDB.open('RailwayRuleDB');
                            rawReq.onsuccess = function() {
                                var existingVer = rawReq.result.version;
                                rawReq.result.close();
                                var targetVer = Math.max(3, existingVer + 1);
                                var req = indexedDB.open('RailwayRuleDB', targetVer);
                                req.onupgradeneeded = function(e) {
                                    var db2 = e.target.result;
                                    if (!db2.objectStoreNames.contains('ruleCollection')) {
                                        var store = db2.createObjectStore('ruleCollection', { keyPath: 'id', autoIncrement: true });
                                        store.createIndex('trade', 'trade', { unique: false });
                                    }
                                    if (!db2.objectStoreNames.contains('rule_images')) {
                                        db2.createObjectStore('rule_images', { keyPath: 'id', autoIncrement: true });
                                    }
                                };
                                req.onsuccess = function() {
                                    var db = req.result;
                                    var tx = db.transaction('ruleCollection', 'readwrite');
                                    var store = tx.objectStore('ruleCollection');
                                    store.clear();
                                    for (var j = 0; j < standardRules.length; j++) {
                                        store.put(standardRules[j]);
                                    }
                                    tx.oncomplete = function() { resolve(standardRules[0].data.length); };
                                    tx.onerror = function() { reject(tx.error); };
                                };
                                req.onerror = function() { reject(req.error); };
                            };
                            rawReq.onerror = function() { reject(rawReq.error); };
                        });
                    });
                    console.log('已恢复 ' + rulesRestored + ' 条规章制度');
                } else {
                    console.warn('备份中无规章制度数据');
                }
                _setRestoreProgress(35, '正在恢复工作日志…');
                if (bm.diary) localStorage.setItem('railway_work_diary_v2', JSON.stringify(bm.diary));
                _setRestoreProgress(40, '正在恢复车站电话…');
                if (bm.phone) localStorage.setItem('railway_phone_db_v1', JSON.stringify(bm.phone));
                _setRestoreProgress(45, '正在恢复检查手册…');
                if (bm.handbook && Array.isArray(bm.handbook) && bm.handbook.length) {
                    localStorage.setItem('handbook_fourlevel_v1', JSON.stringify(bm.handbook));
                }
                _setRestoreProgress(55, '正在恢复写作资料库…');
                if (bm.writingMaterials && Array.isArray(bm.writingMaterials) && bm.writingMaterials.length) {
                    await writeIndexedDB('railway_writer_db', 'writing_materials', 2, bm.writingMaterials);
                }
                _setRestoreProgress(60, '正在恢复历史报告…');
                if (bm.writingReports && Array.isArray(bm.writingReports) && bm.writingReports.length) {
                    await writeIndexedDB('railway_writer_db', 'writing_reports', 2, bm.writingReports);
                }
                _setRestoreProgress(65, '正在恢复对话记录…');
                if (bm.dsConversations) localStorage.setItem('ds_conversations_v1', JSON.stringify(bm.dsConversations));
                if (bm.dsChatHistory) localStorage.setItem('ds_chat_history_v1', JSON.stringify(bm.dsChatHistory));
                _setRestoreProgress(70, '正在恢复术语库…');
                if (bm.termLibrary) localStorage.setItem('patch_term_library_v2', JSON.stringify(bm.termLibrary));
                if (bm.memos) localStorage.setItem('railway_memo_v1', JSON.stringify(bm.memos));
                _setRestoreProgress(75, '正在还原多媒体文件…');
                if (bm.diaryMedia) {
                    for (var i = 0; i < bm.diaryMedia.length; i++) {
                        var rec = bm.diaryMedia[i];
                        if (rec.blobBase64) {
                            rec.blob = await new Promise(function(resolve) {
                                var binary = atob(rec.blobBase64);
                                var bytes = new Uint8Array(binary.length);
                                var chunkSize = 65536;
                                var offset = 0;
                                function processChunk() {
                                    var end = Math.min(offset + chunkSize, binary.length);
                                    for (var b = offset; b < end; b++) { bytes[b] = binary.charCodeAt(b); }
                                    offset = end;
                                    if (offset < binary.length) {
                                        setTimeout(processChunk, 0);
                                    } else {
                                        resolve(bytes.buffer);
                                    }
                                }
                                processChunk();
                            });
                            delete rec.blobBase64;
                            delete rec.blobSize;
                            if (typeof rec.id === 'string') rec.id = parseInt(rec.id, 10);
                        }
                    }
                    await writeIndexedDB('DiaryMediaDB', 'media', 1, bm.diaryMedia);
                }

                _setRestoreProgress(100, '✅ 恢复完成，即将刷新…');
                setTimeout(function() {
                    setTimeout(function(){ location.reload(); }, 2000);
                }, 1000);
            } catch(err) { window.showProgress(0, '❌ 恢复失败：' + err.message); _toast('恢复失败：' + err.message, true); }
        });
    };

    function bind() {
        var b1 = document.getElementById('global-backup-btn');
        var b2 = document.getElementById('global-restore-btn');
        if (b1) b1.onclick = window.oneClickBackup;
        if (b2) b2.onclick = window.oneClickRestore;
    }
    if (document.readyState === 'loading') { document.addEventListener('DOMContentLoaded', bind); }
    else { bind(); }
})();

window.clearAllGlobalData = function() {
    if (!confirm('⚠️ 确定清空所有数据？\\n此操作将清除：检查信息、规章制度、工作日志、备忘录、车站电话、检查手册、写作资料、对话记录等全部本地数据，且不可恢复！')) return;
    if (!confirm('⚠️ 再次确认：清空后所有数据将永久丢失，确定继续？')) return;
    window.showProgress(10, '正在清空 localStorage 数据…');
    // 清空 localStorage 模块数据
    var lsKeys = [
        'railway_work_diary_v2', 'railway_phone_db_v1', 'handbook_fourlevel_v1',
        'railway_memo_v1', 'patch_term_library_v2', 'ds_conversations_v1',
        'ds_chat_history_v1', 'railway_rules_v1', 'railway_terms_custom',
        'patch_term_library_v1'
    ];
    lsKeys.forEach(function(k) { try { localStorage.removeItem(k); } catch(e) {} });
    window.showProgress(30, '正在清空 IndexedDB 数据…');
    // 清空 IndexedDB
    var dbNames = ['RailwayIssueDB_v2', 'RailwayRuleDB', 'DiaryMediaDB', 'railway_writer_db', 'RailwayMemoDB', 'RailwayPhoneDB', 'HandbookDB'];
    Promise.all(dbNames.map(function(name) {
        return new Promise(function(res) {
            try {
                var req = indexedDB.deleteDatabase(name);
                req.onsuccess = res;
                req.onerror = res;
                req.onblocked = res;
            } catch(e) { res(); }
        });
    })).then(function() {
        window.finishProgress('✅ 已清空全部数据');
        setTimeout(function() { location.reload(); }, 1500);
    });
};
