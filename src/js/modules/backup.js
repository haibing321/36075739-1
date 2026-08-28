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

    // 通用「保留原 id」写入：部分 store 的 keyPath 是 'id' 且【没有】autoIncrement
    // （RailwayRuleDB.rule_images、AgentTaskDB.agent_tasks 都是这种），
    // 而 writeIndexedDB 会先剥掉 id 再用 add() 写入 —— 对这类表必然抛 DataError。
    // 这里保留原 id 并用 put 覆盖写，确保恢复后引用关系（规章正文里的图片 id）不断裂。
    function writeKeyedStore(dbName, dbVersion, storeName, data, createIndexes) {
        return new Promise(function(resolve, reject) {
            var done = function(db) {
                try {
                    var tx = db.transaction(storeName, 'readwrite');
                    var store = tx.objectStore(storeName);
                    store.clear();
                    for (var i = 0; i < data.length; i++) {
                        var it = data[i];
                        if (!it || it.id === undefined || it.id === null) continue;
                        store.put(it);
                    }
                    tx.oncomplete = function() { try { db.close(); } catch (e) {} resolve(); };
                    tx.onerror = function() { try { db.close(); } catch (e) {} reject(tx.error); };
                    tx.onabort = function() { try { db.close(); } catch (e) {} reject(tx.error || new Error('事务被中断')); };
                } catch (err) { try { db.close(); } catch (e) {} reject(err); }
            };
            // 先探测现有版本，避免因写死版本号导致 VersionError
            var probe = indexedDB.open(dbName);
            var openAt = function(ver) {
                var req = indexedDB.open(dbName, ver);
                req.onupgradeneeded = function(e) {
                    var db2 = e.target.result;
                    if (!db2.objectStoreNames.contains(storeName)) {
                        var s = db2.createObjectStore(storeName, { keyPath: 'id' });
                        if (typeof createIndexes === 'function') { try { createIndexes(s); } catch (e) {} }
                    }
                };
                req.onerror = function() { reject(req.error); };
                req.onsuccess = function() {
                    var db = req.result;
                    if (!db.objectStoreNames.contains(storeName)) {
                        db.close();
                        if (ver >= probeVer + 1) { reject(new Error('无法创建 store: ' + storeName)); return; }
                        openAt(probeVer + 1);
                        return;
                    }
                    done(db);
                };
            };
            var probeVer = dbVersion || 1;
            probe.onsuccess = function() {
                probeVer = probe.result.version || probeVer;
                try { probe.result.close(); } catch (e) {}
                openAt(Math.max(dbVersion || 1, probeVer));
            };
            probe.onerror = function() { openAt(dbVersion || 1); };
        });
    }

    function writeAgentTasks(data) {
        return writeKeyedStore('AgentTaskDB', 1, 'agent_tasks', data, function(store) {
            store.createIndex('timestamp', 'timestamp', { unique: false });
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
                            // 先按「现有版本」打开（不无谓升版）：无谓 +1 会永久抬高库版本，
                            // 导致其它模块里写死 open(db, 旧版本) 的代码直接抛 VersionError。
                            // 只有打开后仍缺 store 时，才提升到 existingVer + 1 重建一次。
                            var openAndEnsure = function(ver) {
                                var req = indexedDB.open(dbName, ver);
                                req.onupgradeneeded = function(e) {
                                    var db2 = e.target.result;
                                    if (!db2.objectStoreNames.contains(storeName)) {
                                        db2.createObjectStore(storeName, { keyPath: 'id', autoIncrement: true });
                                    }
                                };
                                req.onsuccess = function() {
                                    var db = req.result;
                                    if (!db.objectStoreNames.contains(storeName)) {
                                        db.close();
                                        if (ver > existingVer) { rej(new Error('无法创建 store: ' + storeName)); return; }
                                        openAndEnsure(existingVer + 1);
                                        return;
                                    }
                                    res(db);
                                };
                                req.onerror = function() { rej(req.error); };
                            };
                            openAndEnsure(Math.max(fallbackVer, existingVer));
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
    /**
     * 检测是否为华为/荣耀移动浏览器（对 blob URL 下载限制较严）
     */
    function _isHuaweiMobile() {
        var ua = navigator.userAgent || '';
        var isMobile = /Mobi|Android|iPhone|iPad|iPod/i.test(ua);
        var isHuawei = /Huawei|Harmony|HONOR|HMS|HuaweiBrowser|TAS-AN00|TAS-AL00|OCE-AN10|LIO-AN00|NOH-AN00|ANA-AN00|ELS-AN00/i.test(ua);
        return isMobile && isHuawei;
    }

    /**
     * 将 Blob 读取为 Base64 Data URL（用于华为等不支持 blob URL 下载的浏览器）
     */
    function _blobToDataURL(blob, callback) {
        var reader = new FileReader();
        reader.onload = function(e) { callback(null, e.target.result); };
        reader.onerror = function(e) { callback(e || new Error('FileReader failed'), null); };
        reader.readAsDataURL(blob);
    }

    /**
     * 显示移动端下载按钮（使用真实 <a download> 标签，比 div.onclick 更可靠）
     * @param {string} url - 下载链接（blob URL 或 data URL）
     * @param {string} filename - 下载文件名
     * @param {boolean} isDataUrl - 是否为 data URL（决定是否需要 revoke）
     */
    function showMobileDownloadBtn(url, filename, isDataUrl) {
        var old = document.getElementById('_mobile_dl_btn');
        if (old && old.parentNode) old.parentNode.removeChild(old);

        var displayName = filename.length > 30 ? filename.slice(0, 27) + '...' : filename;

        // 使用真实 <a> 标签，让用户直接点击 <a download>，而不是 JS 触发 click
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
            'white-space:nowrap;animation:_mbdlFadeIn .3s ease;cursor:pointer;'
        ].join('');

        // 注入动画样式（仅一次）
        if (!document.getElementById('_mobile_dl_style')) {
            var s = document.createElement('style');
            s.id = '_mobile_dl_style';
            s.textContent = '@keyframes _mbdlFadeIn{from{opacity:0;transform:translateX(-50%) translateY(20px);}to{opacity:1;transform:translateX(-50%) translateY(0);}}';
            document.head.appendChild(s);
        }

        document.body.appendChild(btn);

        // 15秒后自动移除（data URL 无需 revoke）
        setTimeout(function() {
            if (btn.parentNode) btn.parentNode.removeChild(btn);
            if (!isDataUrl) setTimeout(function() { URL.revokeObjectURL(url); }, 30000);
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
        window.showProgress(5, '正在收集检查信息…');
        var backup = { version: 3, exportDate: new Date().toISOString(), modules: {} };
        var errors = [];
        try {
            // 读取失败时【不要】写入空数组：恢复端以「模块存在」为清空依据，
            // 一次读取异常就会产出「空备份」，用户恢复后真实数据被清空。
            try { backup.modules.issues = await readIndexedDB('RailwayIssueDB_v2', 'issues', 2); } catch(e) { errors.push('检查信息: '+e.message); }
            window.showProgress(15, '正在收集规章制度…');
            try { backup.modules.rules = await readIndexedDB('RailwayRuleDB', 'ruleCollection', 3); } catch(e) { errors.push('规章制度: '+e.message); }
            window.showProgress(18, '正在收集规章图片…');
            try { backup.modules.ruleImages = await readIndexedDB('RailwayRuleDB', 'rule_images', 3); } catch(e) { errors.push('规章图片: '+e.message); }
            window.showProgress(25, '正在收集工作日志…');
            backup.modules.diary = getLocal('railway_work_diary_v2', []);
            window.showProgress(27, '正在收集考勤记录…');
            backup.modules.attendance = getLocal('attendance_v1', {});
            window.showProgress(30, '正在收集应急电话…');
            backup.modules.phone = getLocal('railway_phone_db_v1', []);
            window.showProgress(35, '正在收集检查手册…');
            backup.modules.handbook = getLocal('handbook_fourlevel_v1', []);
            window.showProgress(40, '正在收集写作资料…');
            try { backup.modules.writingMaterials = await readIndexedDB('railway_writer_db', 'writing_materials', 2); } catch(e) { errors.push('写作资料: '+e.message); }
            window.showProgress(45, '正在收集历史报告…');
            try { backup.modules.writingReports = await readIndexedDB('railway_writer_db', 'writing_reports', 2); } catch(e) { errors.push('写作报告: '+e.message); }
            window.showProgress(48, '正在收集写作模板与智能体记忆…');
            try { backup.modules.writingTemplates = await readIndexedDB('railway_writer_db', 'writing_templates', 2); } catch(e) { errors.push('写作模板: '+e.message); }
            // 先向 dbManager 登记 schema 再读取：AgentTaskDB 平时由 agent-memory 模块自己建表，
            // 若备份先跑，dbManager 会以 v1 建出一个【空库】，之后 agent-memory 再 open(v1)
            // 不会触发升级，agent_tasks 永远建不出来，智能体记忆彻底失效。
            try {
                if (window.dbManager && typeof window.dbManager.register === 'function' && !window._agentTaskDBRegistered) {
                    window.dbManager.register('AgentTaskDB', 1, function(db) {
                        if (!db.objectStoreNames.contains('agent_tasks')) {
                            var s = db.createObjectStore('agent_tasks', { keyPath: 'id' });
                            s.createIndex('timestamp', 'timestamp', { unique: false });
                        }
                    });
                    window._agentTaskDBRegistered = true;
                }
            } catch (e) {}
            try { backup.modules.agentTasks = await readIndexedDB('AgentTaskDB', 'agent_tasks', 1); } catch(e) { errors.push('智能体记忆: '+e.message); }
            window.showProgress(50, '正在收集对话记录…');
            backup.modules.dsConversations = getLocal('ds_conversations_v1', []);
            backup.modules.dsChatHistory = getLocal('ds_chat_history_v1', []);
            window.showProgress(52, '正在收集AI记忆与配置…');
            // 智能助手长期记忆 + 关联数据「记住」选择 + 记忆开关（换浏览器不丢）
            backup.modules.dsMemory = getLocal('assistant_memory_v1', []);
            backup.modules.dsDataSource = getLocal('ds_datasource_v1', null);
            backup.modules.memoryEnabled = getLocal('memory_enabled', null);
            // 多模型（多 API Key）配置：换浏览器/重装不丢
            backup.modules.dsProviders = getLocal('ds_providers_v1', null);
            backup.modules.dsActiveProvider = getLocal('ds_active_provider_v1', null);
            window.showProgress(55, '正在收集术语库…');
            backup.modules.termLibrary = getLocal('patch_term_library_v2', []);
            backup.modules.memos = getLocal('railway_memo_v1', []);
            window.showProgress(60, '正在收集多媒体文件…');
            // 与其它模块一致：读取失败只记录错误，不让整次备份直接失败
            try { backup.modules.diaryMedia = await readIndexedDB('DiaryMediaDB', 'media', 1); } catch(e) { errors.push('多媒体: '+e.message); }
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

            var fileNameBase = '安监系统备份_' + new Date().toISOString().slice(0,19).replace(/:/g,'-');
            var isMobile = /Mobi|Android|iPhone|iPad|iPod/i.test(navigator.userAgent || '');
            var shareSupported = false;
            if (isMobile && navigator.share && typeof navigator.canShare === 'function') {
                try {
                    var _probe = new File([new Blob(['x'])], 'x.txt', { type: 'text/plain' });
                    shareSupported = navigator.canShare({ files: [_probe] });
                } catch (e) { shareSupported = false; }
            }

            // 桌面端 或 移动端支持系统分享 → 优先 ZIP 打包 + 分享/下载
            if (!isMobile || shareSupported) {
                // 用 requireLib：直接 await loadScript 会在离线时抛错，
                // 使下面「HTML 单文件兜底」这条退路永远走不到（备份功能整体失效）
                await window.requireLib(LIB_JSZIP_BK, { feature: 'ZIP 备份', silent: true });
                if (typeof JSZip !== 'undefined') {
                    window.showProgress(75, '正在压缩打包…');
                    var zip = new JSZip();
                    zip.file('full_backup.json', JSON.stringify(backup, null, 2));
                    var blob = await zip.generateAsync({ type: 'blob' });
                    window.showProgress(90, '正在下载…');
                    await window.downloadBlob(blob, fileNameBase + '.zip');
                    window.finishProgress('✅ 备份完成' + (mediaFileCount > 0 ? ' · 含' + mediaFileCount + '个附件' : '') +
                           (errors.length > 0 ? ' ⚠️ 部分模块失败' : ''));
                    return;
                }
                // JSZip 加载失败（如断网）→ 落 HTML 兜底
            }

            // 移动端系统分享不可用（或 JSZip 加载失败）→ HTML 单文件兜底（不依赖 ZIP，手机直接打开看图文）
            window.showProgress(75, '正在生成 HTML 备份…');
            var html = buildBackupHtml(backup);
            var htmlBlob = new Blob([html], { type: 'text/html;charset=utf-8' });
            window.showProgress(90, '正在下载…');
            await window.downloadBlob(htmlBlob, fileNameBase + '.html');
            window.finishProgress('✅ 备份完成（HTML 格式·系统分享不可用时的兜底，浏览器直接打开可读）' +
                   (mediaFileCount > 0 ? ' · 含' + mediaFileCount + '个附件' : '') +
                   (errors.length > 0 ? ' ⚠️ 部分模块失败' : ''));
        } catch(e) { window.hideProgress(); _toast('备份失败：' + e.message, true); }
    };

    /**
     * 生成 HTML 单文件备份（不依赖 ZIP / JSZip），用于移动端系统分享不可用时的兜底。
     * 内嵌完整备份数据为 JSON，并用自包含脚本渲染为结构化、可阅读、含图片的页面。
     */
    function buildBackupHtml(backup) {
        var inner = JSON.stringify(backup);
        // 双重转义：作为 JS 字符串字面量，并防止数据中的 </script> 提前闭合标签
        var payload = JSON.stringify(inner).replace(/<\/script/gi, '<\\/script');
        var parts = [
            '<!DOCTYPE html>',
            '<html lang="zh-CN"><head><meta charset="utf-8">',
            '<meta name="viewport" content="width=device-width,initial-scale=1">',
            '<title>安监系统数据备份</title>',
            '<style>',
            'body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"PingFang SC","Microsoft YaHei",sans-serif;margin:0;padding:16px;background:#f8fafc;color:#1e293b;line-height:1.6;}',
            'h1{font-size:1.4rem;margin:0 0 4px;color:#0f172a;}',
            '.meta{color:#64748b;font-size:.85rem;margin:0 0 16px;}',
            '.sec{background:#fff;border:1px solid #e2e8f0;border-radius:10px;padding:14px;margin-bottom:14px;box-shadow:0 1px 3px rgba(0,0,0,.05);}',
            '.sec h2{font-size:1.05rem;margin:0 0 10px;color:#1d4ed8;border-bottom:2px solid #dbeafe;padding-bottom:6px;}',
            'table{width:100%;border-collapse:collapse;font-size:.82rem;}',
            'th,td{border:1px solid #e2e8f0;padding:6px 8px;text-align:left;vertical-align:top;word-break:break-word;}',
            'th{background:#f1f5f9;}',
            '.item{border:1px solid #e2e8f0;border-radius:8px;padding:10px;margin-bottom:10px;}',
            '.item .t{font-weight:600;color:#0f172a;margin-bottom:4px;}',
            '.item .m{color:#64748b;font-size:.78rem;margin-bottom:4px;}',
            'img{max-width:100%;border-radius:6px;margin-top:6px;border:1px solid #e2e8f0;}',
            'details{margin-top:8px;}summary{cursor:pointer;color:#2563eb;font-size:.82rem;}',
            'pre{white-space:pre-wrap;word-break:break-word;background:#f8fafc;border:1px solid #e2e8f0;border-radius:6px;padding:8px;font-size:.78rem;max-height:240px;overflow:auto;}',
            '.empty{color:#94a3b8;font-size:.82rem;}',
            '</style></head><body>',
            '<h1>安监智能辅助系统 · 数据备份</h1>',
            '<p class="meta">导出时间：' + (backup.exportDate||'') + ' ｜ 版本：' + (backup.version||'') + '</p>',
            '<div id="root"></div>',
            '<script>var D=JSON.parse(' + payload + ');(function(){',
            'var M=(D.modules)||{};',
            'function esc(s){return String(s==null?"":s).replace(/[&<>"]/g,function(c){return c==="&"?"&amp;":c==="<"?"&lt;":c===">"?"&gt;":c===String.fromCharCode(34)?"&quot;":c;});}',
            'function sec(title,count){var d=document.createElement("div");d.className="sec";var h=document.createElement("h2");h.textContent=title+(count!=null?"（"+count+"）":"");d.appendChild(h);return d;}',
            'function detailsJson(obj){var de=document.createElement("details");var su=document.createElement("summary");su.textContent="查看原始 JSON";de.appendChild(su);var pre=document.createElement("pre");pre.textContent=JSON.stringify(obj,null,2);de.appendChild(pre);return de;}',
            'function table(headers,rows){var t=document.createElement("table");var thead=document.createElement("thead");var tr=document.createElement("tr");headers.forEach(function(h){var th=document.createElement("th");th.textContent=h;tr.appendChild(th);});thead.appendChild(tr);t.appendChild(thead);var tb=document.createElement("tbody");rows.forEach(function(r){var tr2=document.createElement("tr");r.forEach(function(c){var td=document.createElement("td");td.innerHTML=c;tr2.appendChild(td);});tb.appendChild(tr2);});t.appendChild(tb);return t;}',
            'var root=document.getElementById("root");',
            '(function(){var a=M.issues||[];var s=sec("检查信息",a.length);if(!a.length){s.innerHTML="<p class="empty">（无数据）</p>";root.appendChild(s);return;}',
            'var rows=a.map(function(i){return [esc(i["性质"]||i.nature||""),esc(i.datetime||i["时间"]||""),esc(i.category||i["类别"]||""),esc(i.content||i["问题描述"]||""),esc(i.regulation||i["规章依据"]||""),esc(i.unit||i["单位"]||"")];});',
            's.appendChild(table(["性质","时间","类别","问题描述","规章依据","单位"],rows));root.appendChild(s);})();',
            '(function(){var a=M.rules||[];var arr=[];if(a.length===1&&a[0]&&a[0].data)arr=a[0].data;else arr=a;var s=sec("规章制度",arr.length);if(!arr.length){s.innerHTML="<p class="empty">（无数据）</p>";root.appendChild(s);return;}',
            'arr.forEach(function(r){var it=document.createElement("div");it.className="item";var t=document.createElement("div");t.className="t";t.textContent=r.title||"（无标题）";it.appendChild(t);if(r.content){var c=document.createElement("div");c.innerHTML=esc(r.content);it.appendChild(c);}',
            'if(r.images){r.images.forEach(function(im){if(im&&(im.base64||(im.data&&im.data.base64))){var img=document.createElement("img");img.src="data:image/jpeg;base64,"+(im.base64||im.data.base64);it.appendChild(img);}});}',
            'it.appendChild(detailsJson(r));s.appendChild(it);});root.appendChild(s);})();',
            '(function(){var a=M.diary||[];var s=sec("工作日志",a.length);if(!a.length){s.innerHTML="<p class="empty">（无数据）</p>";root.appendChild(s);return;}',
            'a.forEach(function(d){var it=document.createElement("div");it.className="item";var t=document.createElement("div");t.className="t";t.textContent=(d.date||"")+(d.weather?"（"+d.weather+"）":"");it.appendChild(t);var c=document.createElement("div");c.textContent=d.content||"";it.appendChild(c);s.appendChild(it);});root.appendChild(s);})();',
            '(function(){var a=(M.attendance&&typeof M.attendance==="object")?M.attendance:{};var keys=Object.keys(a);var s=sec("考勤记录",keys.length);if(!keys.length){s.innerHTML="<p class="empty">（无数据）</p>";root.appendChild(s);return;}',
            'var rows=keys.slice().sort().map(function(k){var v=a[k];if(Array.isArray(v))v=v.join(", ");return [esc(k),esc(v||"")];});s.appendChild(table(["日期","考勤码"],rows));root.appendChild(s);})();',
            '(function(){var a=M.phone||[];var s=sec("应急电话",a.length);if(!a.length){s.innerHTML="<p class="empty">（无数据）</p>";root.appendChild(s);return;}',
            'var rows=a.map(function(p){return [esc(p.name||p.contact||""),esc(p.phone||p.number||""),esc(p.dept||p.unit||"")];});s.appendChild(table(["名称","电话","单位/部门"],rows));root.appendChild(s);})();',
            '(function(){var a=M.handbook||[];var s=sec("安全检查手册",a.length);if(!a.length){s.innerHTML="<p class="empty">（无数据）</p>";root.appendChild(s);return;}',
            'a.forEach(function(h){var it=document.createElement("div");it.className="item";var t=document.createElement("div");t.className="t";t.textContent=[h.chapter,h.section,h.item,h.subitem].filter(Boolean).join(" / ");it.appendChild(t);if(h.content){var c=document.createElement("div");c.textContent=h.content;it.appendChild(c);}s.appendChild(it);});root.appendChild(s);})();',
            '(function(){var a=M.writingMaterials||[];var s=sec("写作资料库",a.length);if(!a.length){s.innerHTML="<p class="empty">（无数据）</p>";root.appendChild(s);return;}',
            'a.forEach(function(m){var it=document.createElement("div");it.className="item";var t=document.createElement("div");t.className="t";t.textContent=m.title||"（无标题）";it.appendChild(t);if(m.content){var c=document.createElement("div");c.innerHTML=esc(String(m.content||"").slice(0,500));it.appendChild(c);}it.appendChild(detailsJson(m));s.appendChild(it);});root.appendChild(s);})();',
            '(function(){var a=M.writingReports||[];var s=sec("历史报告",a.length);if(!a.length){s.innerHTML="<p class="empty">（无数据）</p>";root.appendChild(s);return;}',
            'a.forEach(function(r){var it=document.createElement("div");it.className="item";var t=document.createElement("div");t.className="t";t.textContent=r.title||"（无标题）";it.appendChild(t);if(r.content){var c=document.createElement("div");c.innerHTML=esc(String(r.content||"").slice(0,500));it.appendChild(c);}it.appendChild(detailsJson(r));s.appendChild(it);});root.appendChild(s);})();',
            '(function(){var arr=[];if(Array.isArray(M.dsConversations))arr=arr.concat(M.dsConversations);if(Array.isArray(M.dsChatHistory))arr=arr.concat(M.dsChatHistory);var s=sec("对话记录",arr.length);if(!arr.length){s.innerHTML="<p class="empty">（无数据）</p>";root.appendChild(s);return;}',
            'arr.forEach(function(cv){var it=document.createElement("div");it.className="item";var t=document.createElement("div");t.className="t";t.textContent=(cv.title||cv.name||"会话 "+(cv.id||""));it.appendChild(t);it.appendChild(detailsJson(cv));s.appendChild(it);});root.appendChild(s);})();',
            '(function(){var a=M.termLibrary||[];var s=sec("铁路专业术语库",a.length);if(!a.length){s.innerHTML="<p class="empty">（无数据）</p>";root.appendChild(s);return;}',
            'a.forEach(function(tm){var it=document.createElement("div");it.className="item";var t=document.createElement("div");t.className="t";t.textContent=(tm.term||tm.name||"")+(tm.category?"（"+tm.category+"）":"");it.appendChild(t);if(tm.definition||tm.desc){var c=document.createElement("div");c.textContent=tm.definition||tm.desc;it.appendChild(c);}s.appendChild(it);});root.appendChild(s);})();',
            '(function(){var a=M.memos||[];var s=sec("备忘录",a.length);if(!a.length){s.innerHTML="<p class="empty">（无数据）</p>";root.appendChild(s);return;}',
            'a.forEach(function(mo){var it=document.createElement("div");it.className="item";var c=document.createElement("div");c.textContent=(mo.content||mo.text||JSON.stringify(mo));it.appendChild(c);s.appendChild(it);});root.appendChild(s);})();',
            '(function(){var a=M.diaryMedia||[];var s=sec("多媒体附件",a.length);if(!a.length){s.innerHTML="<p class="empty">（无数据）</p>";root.appendChild(s);return;}',
            'a.forEach(function(m){var it=document.createElement("div");it.className="item";var t=document.createElement("div");t.className="m";t.textContent=(m.type||"")+" · "+(m.captureTime||"");it.appendChild(t);var b64=m.blobBase64||(m.blob&&m.blob.base64);if(b64){var img=document.createElement("img");img.src="data:"+(m.type||"image/jpeg")+";base64,"+b64;it.appendChild(img);}s.appendChild(it);});root.appendChild(s);})();',
            '})();',
            '<\/script>',
            '</body></html>'
        ];
        return parts.join('\n');
    }

    var LIB_JSZIP_BK = 'https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js';

    // ---- 全局导入进度条（使用全局 showProgress） ----
    function _showRestoreProgress(show) { if (!show) window.hideProgress(); }
    function _setRestoreProgress(pct, status) { window.showProgress(pct, status); }

    window.oneClickRestore = function() {
        // 先用同步手势打开文件选择器（避免 await 丢失用户手势）
        triggerFileInput('.zip', async function(e) {
            var file = e.target.files[0]; if (!file) return;
            // 原实现先 await loadScript 再取 file：离线时异常直接外泄（此处无 try 包裹），
            // 恢复流程静默中断、进度条不收起，用户以为文件没选上
            if (!(await window.requireLib(LIB_JSZIP_BK, { feature: 'ZIP 恢复' }))) return;
            if (typeof JSZip === 'undefined') { _toast('JSZip 未加载，请检查网络后刷新重试', true); return; }
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
                    if (!backup.modules.dsMemory) backup.modules.dsMemory = [];
                    if (backup.modules.dsDataSource === undefined) backup.modules.dsDataSource = null;
                    if (backup.modules.memoryEnabled === undefined) backup.modules.memoryEnabled = null;
                }

                _showRestoreProgress(true);
                _setRestoreProgress(10, '正在恢复检查信息…');
                var bm = backup.modules;
                // 以「备份里是否包含该模块」为准（Array.isArray 而非 .length）：
                // 备份时读取失败的模块不会产生键，恢复时必须跳过，不能反手把现有数据清掉；
                // 而真实为空的备份（用户确实没有数据）应当如实清库，两者必须区分开。
                _setRestoreProgress(15, '正在恢复检查信息…');
                if (Array.isArray(bm.issues)) {
                    await writeIndexedDB('RailwayIssueDB_v2', 'issues', 2, bm.issues);
                    console.log('已恢复 ' + bm.issues.length + ' 条检查信息');
                } else {
                    console.warn('备份中无检查信息数据，已跳过（保留现有数据）');
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
                // 考勤记录与工作日志同包恢复（旧备份无此字段则跳过，安全兼容）
                if (bm.attendance && typeof bm.attendance === 'object' && Object.keys(bm.attendance).length) {
                    localStorage.setItem('attendance_v1', JSON.stringify(bm.attendance));
                    console.log('已恢复 ' + Object.keys(bm.attendance).length + ' 条考勤记录');
                }
                _setRestoreProgress(40, '正在恢复应急电话…');
                if (bm.phone) localStorage.setItem('railway_phone_db_v1', JSON.stringify(bm.phone));
                _setRestoreProgress(45, '正在恢复检查手册…');
                if (bm.handbook && Array.isArray(bm.handbook) && bm.handbook.length) {
                    localStorage.setItem('handbook_fourlevel_v1', JSON.stringify(bm.handbook));
                }
                _setRestoreProgress(18, '正在恢复规章图片…');
                if (Array.isArray(bm.ruleImages)) {
                    try {
                        await writeKeyedStore('RailwayRuleDB', 3, 'rule_images', bm.ruleImages);
                        console.log('已恢复 ' + bm.ruleImages.length + ' 条规章图片');
                    } catch (e) {
                        console.warn('[backup] 规章图片恢复失败（不影响其它数据）:', e.message);
                    }
                }
                _setRestoreProgress(55, '正在恢复写作资料库…');
                if (Array.isArray(bm.writingMaterials)) {
                    await writeIndexedDB('railway_writer_db', 'writing_materials', 2, bm.writingMaterials);
                }
                _setRestoreProgress(58, '正在恢复写作模板…');
                if (Array.isArray(bm.writingTemplates)) {
                    await writeIndexedDB('railway_writer_db', 'writing_templates', 2, bm.writingTemplates);
                }
                _setRestoreProgress(60, '正在恢复历史报告…');
                if (Array.isArray(bm.writingReports)) {
                    await writeIndexedDB('railway_writer_db', 'writing_reports', 2, bm.writingReports);
                }
                _setRestoreProgress(63, '正在恢复智能体记忆…');
                if (Array.isArray(bm.agentTasks)) {
                    try {
                        await writeAgentTasks(bm.agentTasks);
                        console.log('已恢复 ' + bm.agentTasks.length + ' 条智能体任务记录');
                    } catch (e) {
                        console.warn('[backup] 智能体任务恢复失败（不影响其它数据）:', e.message);
                    }
                }
                _setRestoreProgress(65, '正在恢复对话记录…');
                if (bm.dsConversations) localStorage.setItem('ds_conversations_v1', JSON.stringify(bm.dsConversations));
                if (bm.dsChatHistory) localStorage.setItem('ds_chat_history_v1', JSON.stringify(bm.dsChatHistory));
                _setRestoreProgress(66, '正在恢复AI记忆与配置…');
                // 智能助手长期记忆 + 关联数据「记住」选择 + 记忆开关
                if (bm.dsMemory) localStorage.setItem('assistant_memory_v1', JSON.stringify(bm.dsMemory));
                if (bm.dsDataSource) localStorage.setItem('ds_datasource_v1', JSON.stringify(bm.dsDataSource));
                if (bm.memoryEnabled != null) localStorage.setItem('memory_enabled', bm.memoryEnabled);
                // 多模型配置恢复，并同步回旧版单配置键（供各模块读取点生效）
                if (bm.dsProviders != null) {
                    var provs = bm.dsProviders;
                    localStorage.setItem('ds_providers_v1', JSON.stringify(provs));
                    var aid = bm.dsActiveProvider != null ? bm.dsActiveProvider : (provs[0] && provs[0].id);
                    if (aid != null) localStorage.setItem('ds_active_provider_v1', aid);
                    var active = (provs.filter(function(p){ return p.id === aid; })[0]) || provs[0];
                    if (active) {
                        localStorage.setItem('ds_api_key_v1', active.apiKey || '');
                        localStorage.setItem('ds_api_url_v1', active.apiUrl || '');
                        localStorage.setItem('ds_model_v1', active.model || '');
                    }
                }
                _setRestoreProgress(70, '正在恢复术语库…');
                if (bm.termLibrary) localStorage.setItem('patch_term_library_v2', JSON.stringify(bm.termLibrary));
                if (bm.memos) localStorage.setItem('railway_memo_v1', JSON.stringify(bm.memos));
                _setRestoreProgress(75, '正在还原多媒体文件…');
                if (Array.isArray(bm.diaryMedia)) {
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
    if (!confirm('⚠️ 确定清空所有数据？\\n此操作将清除：检查信息、规章制度、工作日志、备忘录、应急电话、检查手册、写作资料、对话记录等全部本地数据，且不可恢复！')) return;
    if (!confirm('⚠️ 再次确认：清空后所有数据将永久丢失，确定继续？')) return;
    window.showProgress(10, '正在清空 localStorage 数据…');
    // 清空 localStorage 模块数据
    var lsKeys = [
        'railway_work_diary_v2', 'railway_phone_db_v1', 'handbook_fourlevel_v1',
        'railway_memo_v1', 'patch_term_library_v2', 'ds_conversations_v1',
        'ds_chat_history_v1', 'railway_rules_v1', 'railway_terms_custom',
        'patch_term_library_v1', 'attendance_v1'
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
