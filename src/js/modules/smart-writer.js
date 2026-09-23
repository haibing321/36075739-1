/**
 * 安监智能辅助系统 - 智能写作模块
 * ===================================================
 * 从 doubao.js 拆分，包含：智能写作/资料管理/风险研判/历史报告
 * 加载顺序：在 doubao-common.js + smart-check.js 之后，doubao.js 之前
 */
        // ========================================
        // ✍️ 智能写作模块 (Writer Assistant)
        // ========================================
        (function() {
            'use strict';

            // ---- 常量 ----
            const WR_DB_NAME    = 'railway_writer_db';
            const WR_DB_VER     = 2;   // 升级版本以添加 writing_materials store
            const WR_TPL_STORE  = 'writing_templates';
            const WR_RPT_STORE  = 'writing_reports';
            const WR_MAT_STORE  = 'writing_materials';  // 新增：资料库
            // 智能写作复用智能助手的 API 配置
            const WR_API_KEY_K  = 'ds_api_key_v1';   // 复用同一API Key
            const WR_API_URL_K  = 'ds_api_url_v1';   // 复用 API URL 配置
            const WR_MODEL_K    = 'ds_model_v1';     // 复用模型配置

            // 资料类型映射（扩展为9种）
            const WR_MAT_TYPES = {
                template: { label: '写作模版', color: '#eff6ff', text: '#1e40af', badge: '#bfdbfe' },
                history:  { label: '历史报告', color: '#f0fdf4', text: '#166534', badge: '#bbf7d0' },
                inspect:  { label: '检查信息', color: '#fdf4ff', text: '#6b21a8', badge: '#e9d5ff' },
                fault:    { label: '故障报告', color: '#fef2f2', text: '#991b1b', badge: '#fecaca' },
                stats:    { label: '故障统计', color: '#fff7ed', text: '#9a3412', badge: '#fed7aa' },
                dispatch: { label: '通报文电', color: '#eff6ff', text: '#1e40af', badge: '#bfdbfe' },
                bulletin: { label: '通报',     color: '#fdf4ff', text: '#6b21a8', badge: '#e9d5ff' },
                meeting:  { label: '会议纪要', color: '#f0fdf4', text: '#166534', badge: '#bbf7d0' },
                other:    { label: '其它资料', color: '#f8fafc', text: '#475569', badge: '#e2e8f0' }
            };

            // ---- IndexedDB 操作 ----
            let _wrDB = null;
            let _wrDBOpening = null;

            // 建库 schema 集中到一处并对外暴露：项目里还有两处（doubao.js 风险报告、
            // doubao-common.js 资料选择器）会裸开同一个库且只建部分 store，
            // 一旦它们先跑，库就停留在 v2 且缺 store，后续 open(2) 不再触发升级 → 功能整体失效。
            window.__wrEnsureSchema = function(db) {
                try {
                    if (!db.objectStoreNames.contains(WR_TPL_STORE)) {
                        var ts = db.createObjectStore(WR_TPL_STORE, { keyPath: 'id', autoIncrement: true });
                        ts.createIndex('category', 'category', { unique: false });
                    }
                    if (!db.objectStoreNames.contains(WR_RPT_STORE)) {
                        var rs = db.createObjectStore(WR_RPT_STORE, { keyPath: 'id', autoIncrement: true });
                        rs.createIndex('date', 'date', { unique: false });
                        rs.createIndex('category', 'category', { unique: false });
                    }
                    if (!db.objectStoreNames.contains(WR_MAT_STORE)) {
                        var ms = db.createObjectStore(WR_MAT_STORE, { keyPath: 'id', autoIncrement: true });
                        ms.createIndex('matType',  'matType',  { unique: false });
                        ms.createIndex('fileName', 'fileName', { unique: false });
                        ms.createIndex('importAt', 'importAt', { unique: false });
                    }
                } catch (upErr) {
                    console.error('[writer] upgrade失败:', upErr);
                }
            };

            function wrOpenDB() {
                // 如果正在打开中，复用同一个 Promise
                if (_wrDBOpening) return _wrDBOpening;

                // 命中缓存必须在这里返回：Promise 的 executor 是同步执行的，
                // 若把「缓存命中分支」留在 executor 内部，它会先于 `return _wrDBOpening` 执行并把
                // _wrDBOpening 置为 null，导致第二次起 wrOpenDB() 恒返回 null，
                // 所有 wrOpenDB().then(...) 直接同步抛 TypeError。
                if (_wrDB) {
                    try {
                        // 快速有效性检测：数据库关闭后 objectStoreNames 不可访问
                        void _wrDB.objectStoreNames;
                        return Promise.resolve(_wrDB);
                    } catch(e) {
                        console.log('[DB] 缓存连接已失效，重新打开');
                        _wrDB = null;
                    }
                }

                _wrDBOpening = new Promise((resolve, reject) => {
                    var req = indexedDB.open(WR_DB_NAME, WR_DB_VER);
                    req.onupgradeneeded = function(e) {
                        window.__wrEnsureSchema(e.target.result);
                    };
                    req.onsuccess = e => {
                        _wrDB = e.target.result;
                        // 监听连接关闭，自动清除缓存
                        _wrDB.onclose = () => {
                            console.log('[DB] 连接已关闭，清除缓存');
                            _wrDB = null;
                            _wrDBOpening = null;
                        };
                        _wrDBOpening = null;
                        resolve(_wrDB);
                    };
                    req.onerror = e => { _wrDBOpening = null; reject(e.target.error); };
                    req.onblocked = () => {
                        console.warn('[DB] 数据库被阻塞，关闭旧连接');
                        if (_wrDB) { _wrDB.close(); _wrDB = null; }
                    };
                });

                return _wrDBOpening;
            }

            // 事务重试包装：连接关闭时自动重连重试一次
            function _wrRetry(fn) {
                return fn().catch(err => {
                    if (err && (err.name === 'InvalidStateError' || (err.message && String(err.message).includes('closing')))) {
                        console.log('[DB] 事务失败(连接关闭)，重试...');
                        _wrDB = null;
                        _wrDBOpening = null;
                        return fn();
                    }
                    throw (err || new Error('数据库事务失败（未提供错误对象）'));
                });
            }

            function wrDbPut(store, item) {
                return _wrRetry(() => wrOpenDB().then(db => new Promise((res, rej) => {
                    const tx = db.transaction(store, 'readwrite');
                    const req = tx.objectStore(store).put(item);
                    req.onsuccess = e => res(e.target.result);
                    req.onerror   = e => rej(e.target.error);
                    tx.oncomplete = () => console.log('[DB] 事务完成:', store);
                    tx.onerror    = () => rej(tx.error);
                })));
            }

            /**
             * 【2026-09-21】批量写入（**单事务**）。
             *   导入 JSON 备份时原来是"每条一个事务 + await"，2000 条 = 2000 次事务提交
             *   （IndexedDB 最贵的部分就在事务/提交），大备份导入慢到用户以为卡死。
             *   改为一次事务写完整批：事务数 2000 → 1。
             */
            function wrDbPutMany(store, items) {
                items = (items || []).filter(function(x) { return x != null; });
                if (!items.length) return Promise.resolve(0);
                return _wrRetry(() => wrOpenDB().then(db => new Promise((res, rej) => {
                    const tx = db.transaction(store, 'readwrite');
                    const os = tx.objectStore(store);
                    items.forEach(it => os.put(it));
                    tx.oncomplete = () => res(items.length);
                    tx.onerror    = () => rej(tx.error);
                    tx.onabort    = () => rej(tx.error || new Error('事务被中止'));
                })));
            }

            // 按主键取单条（供「朗读/查看」等按 id 定位的场景使用，避免整表读取）
            function wrDbGet(store, id) {
                return _wrRetry(() => wrOpenDB().then(db => new Promise((res, rej) => {
                    const tx = db.transaction(store, 'readonly');
                    const req = tx.objectStore(store).get(id);
                    req.onsuccess = e => res(e.target.result || null);
                    req.onerror   = e => rej(e.target.error);
                })));
            }

            function wrDbGetAll(store) {
                return _wrRetry(() => wrOpenDB().then(db => new Promise((res, rej) => {
                    const tx = db.transaction(store, 'readonly');
                    const os = tx.objectStore(store);
                    // 用游标遍历：把真实主键(keyPath=id)挂回对象，
                    // 兼容部分浏览器(如华为) getAll() 不返回 keyPath 导致 m.id 为 undefined 的问题
                    const req = os.openCursor();
                    const out = [];
                    req.onsuccess = e => {
                        const cursor = e.target.result;
                        if (cursor) {
                            const v = cursor.value;
                            if (v && v.id == null) v.id = cursor.key;
                            out.push(v);
                            cursor.continue();
                        } else {
                            res(out);
                        }
                    };
                    req.onerror = e => rej(e.target.error);
                })));
            }

            function wrDbDelete(store, id) {
                return _wrRetry(() => wrOpenDB().then(db => new Promise((res, rej) => {
                    const tx = db.transaction(store, 'readwrite');
                    const req = tx.objectStore(store).delete(id);
                    req.onsuccess = () => res();
                    req.onerror   = e => rej(e.target.error);
                })));
            }

            function wrDbClear(store) {
                return _wrRetry(() => wrOpenDB().then(db => new Promise((res, rej) => {
                    const tx = db.transaction(store, 'readwrite');
                    const req = tx.objectStore(store).clear();
                    req.onsuccess = () => res();
                    req.onerror   = e => rej(e.target.error);
                })));
            }

            // ---- 内置模板库 ----
            const WR_BUILTIN_TEMPLATES = {
                monthly: {
                    title: '月度安全监察报告',
                    category: 'monthly',
                    content: `{{部门}}安全监察月报（{{年月}}）

一、本月安全监察工作概况

本月，{{部门}}共开展安全监察{{次数}}次，检查人员{{检查人数}}人次，覆盖{{覆盖范围}}等区域。共发现各类问题{{问题总数}}条，其中A类（重大）{{A类数量}}条，B类（较大）{{B类数量}}条，C类（一般）{{C类数量}}条。与上月相比，问题总量{{环比变化}}。

二、主要问题情况

{{典型问题列表}}

三、问题整改情况

截至本月底，上月遗留问题{{上月遗留数量}}条，本月已整改完成{{本月整改数量}}条，整改率{{整改率}}%。

四、下月重点工作安排

1. 继续跟踪督促未完成整改项目；
2. 重点开展{{下月重点领域}}专项检查；
3. {{其他重点工作}}。

                    `
                },
                check: {
                    title: '安全监察检查报告',
                    category: 'check',
                    content: `安全监察检查报告

检查时间：{{检查日期}}
检查单位：{{被检查单位}}
检查人员：{{检查人员}}
检查类型：{{检查类型}}

一、检查基本情况

按照{{检查依据}}，对{{被检查单位}}开展了安全监察检查。本次检查历时{{检查历时}}，重点对{{检查重点内容}}进行了检查。

二、检查发现的主要问题

{{问题详细列表}}

三、处理意见

针对上述问题，依据相关规章制度，提出如下处理意见：

1. {{问题1}}：限于{{整改期限1}}前完成整改，责任人：{{责任人1}}；
2. {{其余整改意见}}

四、要求

请{{被检查单位}}认真落实上述整改要求，于{{汇报期限}}前将整改情况书面报告至{{报告单位}}。

                    `
                },
                accident: {
                    title: '事故（事件）分析报告',
                    category: 'accident',
                    content: `{{事故名称}}分析报告

一、事故基本情况

事故时间：{{事故时间}}
事故地点：{{事故地点}}
涉及单位：{{涉及单位}}
事故类型：{{事故类型}}

简要经过：{{事故经过}}

造成后果：{{事故后果}}

二、事故原因分析

（一）直接原因

{{直接原因}}

（二）间接原因

{{间接原因}}

（三）管理原因

{{管理原因}}

三、违反规章情况

本次事故违反了以下规章制度：
{{违反规章列表}}

四、整改与防范措施

针对本次事故暴露的问题，提出如下整改和防范措施：

{{整改防范措施}}

五、责任认定与处理建议

{{责任认定内容}}

                    `
                },
                rectify: {
                    title: '安全问题整改通知书',
                    category: 'rectify',
                    content: `整改通知书

{{被通知单位}}：

根据{{检查依据}}，经检查，发现贵单位存在以下安全问题：

{{问题列表}}

以上问题违反了{{违反规章条款}}的相关规定，存在安全风险隐患，必须认真整改。现要求：

一、限于{{整改期限}}前完成上述问题整改；
二、整改完成后，将整改情况以书面形式报告至{{报告单位}}；
三、如逾期未完成整改，将按相关规定追究责任。

望认真落实，确保安全生产。

{{发文单位}}
{{日期}}

                    `
                },
                summary: {
                    title: '年度安全监察工作总结',
                    category: 'summary',
                    content: `{{年度}}年度安全监察工作总结

一、年度工作基本情况

{{年度}}年，{{部门}}紧紧围绕安全生产目标，共开展安全监察{{年度总次数}}次，发现各类问题{{年度问题总数}}条，完成整改{{年度整改数量}}条，整改率达{{年度整改率}}%。

二、主要工作成效

（一）专项整治开展情况

{{专项整治情况}}

（二）安全隐患排查情况

{{安全隐患排查情况}}

（三）典型问题及处置情况

{{典型问题处置}}

三、存在的主要问题与不足

{{存在问题不足}}

四、下年度工作计划

（一）重点工作部署
{{下年度重点工作}}

（二）专项检查计划
{{专项检查计划}}

                    `
                }
            };

            // ---- 工具函数 ----
            function wrEsc(s) { return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

            // 流式输出格式化：转义HTML + 保留换行 + 基础Markdown
            function wrStreamFormat(text) {
                if (!text) return '';
                let s = wrEsc(text);
                // 代码块（含下载按钮）
                s = s.replace(/```(\w*)\n?([\s\S]*?)```/g, function(match, lang, code) {
                    var ext = (lang || 'txt').toLowerCase();
                    var fileExts = { html:'html', css:'css', js:'js', javascript:'js', ts:'ts', typescript:'ts', json:'json', py:'py', python:'py', sh:'sh', bash:'sh', sql:'sql', md:'md', xml:'xml', svg:'svg', txt:'txt' };
                    var fileExt = fileExts[ext] || ext;
                    return '<div style="position:relative;margin:6px 0;">' +
                        '<button onclick="(window.dsDownloadCode||function(b){var p=b.parentElement.querySelector(\'pre\');if(!p)return;window.downloadBlob(new Blob([p.textContent],{type:\'text/plain;charset=utf-8\'}),\'code.' + fileExt + '\')})(this)" data-ext="' + fileExt + '" ' +
                        'style="position:absolute;top:6px;right:6px;background:var(--primary);color:#fff;border:none;border-radius:4px;padding:3px 10px;font-size:0.75rem;cursor:pointer;z-index:2;transition:all 0.2s;box-shadow:0 1px 3px rgba(0,0,0,0.3);" ' +
                        'onmouseover="this.style.background=\'var(--primary-dark)\'" onmouseout="this.style.background=\'var(--primary)\'" title="下载代码文件">📥 下载 ' + ext.toUpperCase() + '</button>' +
                        '<pre style="background:#1d1d1d;color:#e2e8f0;padding:32px 10px 10px 10px;border-radius:6px;overflow-x:auto;font-size:0.85em;margin:0;white-space:pre-wrap;">' + code + '</pre></div>';
                });
                // 粗体
                s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
                // 斜体
                s = s.replace(/\*([^*]+)\*/g, '<em>$1</em>');
                // 换行符转为 <br>
                s = s.replace(/\n/g, '<br>');
                return s;
            }

            // 格式化日期
            function wrFmtDate(ts) {
                const d = new Date(ts || Date.now());
                return d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0')
                     + ' ' + String(d.getHours()).padStart(2,'0') + ':' + String(d.getMinutes()).padStart(2,'0');
            }

            // 获取类型中文名（更新版含资料管理类型）
            function wrCatName(c) {
                const m = {
                    monthly:'月度安全报告', check:'安全检查报告', accident:'事故分析报告',
                    rectify:'整改通知书', summary:'年度总结', custom:'自定义',
                    template:'写作模版', history:'历史报告', inspect:'检查信息',
                    fault:'故障报告', stats:'故障统计', dispatch:'通报文电',
                    meeting:'会议纪要', other:'其它', agent:'智能体报告'
                };
                return m[c] || c || '未分类';
            }

            // 对外暴露资料库访问接口（供联动数据使用）
            window._wrGetAllMaterials = function() { return wrDbGetAll(WR_MAT_STORE); };
            window._wrGetAllReports   = function() { return wrDbGetAll(WR_RPT_STORE); };

            // ---- 写作对话历史（连续对话模式） ----
            let _wrConvHistory = []; // [{role:'user'|'assistant', content, timestamp}]

            // 追加写作对话气泡
            function wrAppendChatBubble(role, content, isStreaming) {
                const histEl = document.getElementById('wr-chat-history');
                if (!histEl) return;
                histEl.style.display = 'flex';
                const bubble = document.createElement('div');
                const isUser = role === 'user';
                bubble.id = isStreaming ? 'wr-stream-bubble' : '';
                // 使用与智能对话一致的样式类
                bubble.className = isUser ? 'ds-row-user' : 'ds-row-assistant';
                const bubbleDiv = document.createElement('div');
                bubbleDiv.className = isUser ? 'ds-bubble-user' : 'ds-bubble-assistant';
                const time = new Date().toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit'});
                if (isUser) {
                    bubbleDiv.innerHTML = wrEsc(content);
                } else {
                    bubbleDiv.id = isStreaming ? 'wr-stream-bubble-content' : '';
                    bubbleDiv.innerHTML = isStreaming ? '' : wrStreamFormat(content);
                }
                bubble.appendChild(bubbleDiv);
                histEl.appendChild(bubble);
                histEl.scrollTop = histEl.scrollHeight;
                return bubble;
            }

            // 显示/更新写作对话框中的「新建对话」按钮
            function wrUpdateConvBtn() {
                const btn = document.getElementById('wr-clear-conv-btn');
                if (btn) btn.style.display = _wrConvHistory.length > 0 ? 'block' : 'none';
                const labelEl = document.getElementById('wr-input-label');
                if (labelEl) labelEl.textContent = _wrConvHistory.length > 0 ? '继续修改' : '写作需求';
            }

            // 清空写作对话
            window.wrClearConversation = function() {
                _wrConvHistory = [];
                window._wrCurrentReportContent = null;
                window._wrCurrentReportQuery = null;
                window._wrCurrentReportParsed = null;
                window._wrCurrentReportId = null;
                window._wrSelectedMaterialIds = [];
                window._wrSelectedTemplate = null;
                const histEl = document.getElementById('wr-chat-history');
                if (histEl) { histEl.innerHTML = ''; histEl.style.display = 'none'; }
                const resultEl = document.getElementById('wr-gen-result');
                if (resultEl) { resultEl.innerHTML = ''; resultEl.style.display = 'none'; }
                const qEl = document.getElementById('wr-query-input');
                if (qEl) { qEl.value = ''; qEl.style.height = ''; }
                wrUpdateConvBtn();
            };

            // ---- 初始化 ----
            let _wrInited = false;
            window.wrInit = function() {
                if (_wrInited) return;
                _wrInited = true;
                try { wrSyncTwoStepChk(); } catch (e) {}   // 两步生成开关：与 localStorage 同步（P1-7）
                wrOpenDB().then(() => {
                    wrSwitchTab('gen');
                    wrRenderMaterials();
                }).catch(e => console.error('智能写作DB初始化失败', e));
            };

            // ---- 子面板切换（gen/materials两个tab）----
            window.wrSwitchTab = function(tab) {
                // 资料管理已提升为顶级「资料中心」标签，点此直接跳转
                if (tab === 'materials') { if (window.switchTab) window.switchTab('material'); return; }
                // 仅剩「生成报告」视图留在智能写作内
                const gen = document.getElementById('wr-panel-gen');
                if (gen) gen.style.display = 'flex';
            };

            // 资料中心标签被打开时刷新列表（由 utils.js 中 switchTab 的 onShow 钩子调用）
            window.onShow_material = function() {
                try { wrMaterialFilter('all'); } catch (e) {}
                try { wrRenderHistory(); } catch (e) {}
            };

            // ========== 资料中心：多源只读聚合（方案C）==========
            // 把「写作资料 / 检查信息 / 规章制度 / 工作日志 / 报告」统一在资料中心一处查阅、一处搜索。
            // 只读聚合：不改各模块落库逻辑，编辑仍跳回原模块，零数据迁移风险。
            var _wrCenterGroup = 'all';
            var _wrCenterItems = [];

            // 通用：经 dbManager 共享连接读取任意 IndexedDB store 全部记录
            async function wrReadStore(dbName, storeName) {
                try {
                    var db = await window.dbManager.getDB(dbName);
                    return await new Promise(function(resolve) {
                        var tx = db.transaction([storeName], 'readonly');
                        var req = tx.objectStore(storeName).getAll();
                        req.onsuccess = function() { resolve(req.result || []); };
                        req.onerror = function() { resolve([]); };
                    });
                } catch (e) { console.warn('[writer] 读取 ' + dbName + '.' + storeName + ' 失败:', e); return []; }
            }

            // 工作日志聚合：localStorage 文本日志 + IndexedDB 多媒体附件
            async function wrLoadDiaryCenter() {
                var items = [];
                try {
                    var diaries = (typeof window.getDiaryData === 'function') ? window.getDiaryData() : [];
                    (diaries || []).forEach(function(d) {
                        var work = d.work || d.content || '';
                        items.push({ kind: 'text', date: d.date, title: (d.date ? ('工作日志 ' + d.date) : '工作日志'),
                            work: work, issueCount: (d.issues || []).length });
                    });
                } catch (e) {}
                try {
                    var media = await wrReadStore('DiaryMediaDB', 'media');
                    (media || []).forEach(function(m) {
                        var t = m.type || '';
                        var label = t.indexOf('image') >= 0 ? '图片' : (t.indexOf('video') >= 0 ? '视频' : (t.indexOf('audio') >= 0 ? '音频' : '附件'));
                        items.push({ kind: 'media', id: m.id, name: m.name || label, timestamp: m.timestamp, typeLabel: label });
                    });
                } catch (e) {}
                return items;
            }

            /**
             * 【2026-09-22】资料统一"时间"取值。
             *
             * 为什么需要它：资料库列表原来只按 `importAt` 排序，而
             *   · 由模块生成的资料（检查信息→资料、故障报告、通报文电、会议纪要…）带的是 `createdAt`/`date`；
             *   · 迁移过来的旧记录同样没有 `importAt`。
             * 这些记录的排序键是 `undefined`，`undefined - undefined = NaN`，而 `Array.sort` 遇到 NaN 比较结果
             * **会保持原顺序** → 表现就是"没排序、顺序乱七八糟"。
             * 这里按一套优先级取时间，字符串统一转时间戳；取不到就是 0（排到最后）。
             */
            function wrItemTime(o) {
                if (!o) return 0;
                var v = o.importAt || o.createdAt || o.date || o.datetime || o.timestamp || o.ts || o.updatedAt;
                if (typeof v === 'string') { var t = Date.parse(v); return isNaN(t) ? 0 : t; }
                return (typeof v === 'number' && isFinite(v)) ? v : 0;
            }
            /**
             * 【2026-09-22】资料排序：**按生成/导入时间倒序，最近的在最上面**。
             * 时间相同再按 id 倒序兜底 —— 保证同一批数据每次渲染顺序稳定（不然看起来会"自己跳"）。
             */
            function wrByTimeDesc(a, b) {
                var d = wrItemTime(b) - wrItemTime(a);
                if (d) return d;
                return String((b && b.id) == null ? '' : b.id).localeCompare(String((a && a.id) == null ? '' : a.id));
            }
            // 供「智能对话」的资料弹窗（doubao-common.js）等外部模块复用同一套时间口径
            window.wrItemTime = wrItemTime;
            window.wrByTimeDesc = wrByTimeDesc;

            /** 分块顺序：与资料库分类按钮一致（模板 → 检查信息 → 故障 → 通报 → 会议 → 其它） */
            var WR_MAT_GROUP_ORDER = ['template', 'inspect', 'fault', 'stats', 'dispatch', 'bulletin', 'meeting', 'history', 'other'];
            /**
             * 【2026-09-22 按用户要求】把同一批资料**按类型分块**，块内保持"时间倒序、最近在最上"。
             * 说明：调用前请先 sort(wrByTimeDesc)（各渲染点都已如此），分块只做分组不改组内顺序。
             * 未登记的类型统一归到「其它资料」，但**不丢条目**（排到已知类型之后）。
             */
            function wrGroupByType(items) {
                var by = {};
                (items || []).forEach(function (m) {
                    var k = (m && m.matType) || 'other';
                    if (!WR_MAT_TYPES[k]) k = 'other';
                    if (!by[k]) by[k] = [];
                    by[k].push(m);
                });
                var order = WR_MAT_GROUP_ORDER.filter(function (k) { return by[k] && by[k].length; });
                Object.keys(by).forEach(function (k) { if (order.indexOf(k) === -1) order.push(k); });
                return order.map(function (k) {
                    return { key: k, label: (WR_MAT_TYPES[k] || { label: '其它资料' }).label, items: by[k] };
                });
            }
            /** 组头：箭头 + 类型名 + 条数 + 分隔线（可点击折叠；块内条数多时默认只展开前 N 条） */
            function wrGroupHeaderHtml(label, count, key, collapsed) {
                var k = String(key == null ? '' : key).replace(/[^A-Za-z0-9_-]/g, '');
                return '<div class="wr-mat-group-head" data-wr-group="' + k + '"'
                    + ' onclick="wrToggleGroup(\'' + k + '\')" title="点击' + (collapsed ? '展开' : '收起') + '这一类"'
                    + ' style="display:flex;align-items:center;gap:8px;margin:8px 2px 2px;cursor:pointer;user-select:none;">'
                    + '<span style="font-size:0.7rem;color:var(--text-secondary);width:9px;">' + (collapsed ? '▸' : '▾') + '</span>'
                    + '<span style="font-size:0.78rem;font-weight:700;color:var(--primary);">' + wrEsc(label) + '</span>'
                    + '<span style="font-size:0.72rem;color:var(--text-secondary);">' + count + ' 条</span>'
                    + '<span style="flex:1;height:1px;background:var(--border);"></span></div>';
            }
            /** 每块默认只展开最新 N 条（点击「展开全部」看其余） */
            var WR_LIST_PREVIEW_N = 10;
            /** 「展开全部」按钮（data 属性供审计脚本定位） */
            function wrGroupMoreHtml(key, more) {
                var k = String(key == null ? '' : key).replace(/[^A-Za-z0-9_-]/g, '');
                return '<div style="text-align:center;padding:2px 0 4px;">'
                    + '<button class="wr-mat-btn" data-wr-expand="' + k + '" onclick="wrExpandGroup(\'' + k + '\')">'
                    + '▼ 展开全部（还有 ' + more + ' 条）</button></div>';
            }
            /**
             * 【2026-09-22】资料列表视图状态：
             *   · `_wrListMode`      'type'=按类型分块（默认，块内时间倒序） | 'time'=纯时间倒序不分块
             *   · `_wrListCollapsed` 各块的折叠状态（按类型键，落 localStorage，刷新后保持）
             *   · `_wrListExpanded`  本次会话内"展开全部"的块（不落盘，避免下次打开一屏几百条）
             */
            window._wrListMode = (function () {
                try { return localStorage.getItem('wr_list_mode') === 'time' ? 'time' : 'type'; } catch (e) { return 'type'; }
            })();
            window._wrListCollapsed = (function () {
                try { return JSON.parse(localStorage.getItem('wr_list_collapsed') || '{}') || {}; } catch (e) { return {}; }
            })();
            window._wrListExpanded = {};
            window.wrSyncListModeChips = function () {
                [['wr-list-mode-type', 'type'], ['wr-list-mode-time', 'time']].forEach(function (p) {
                    var el = document.getElementById(p[0]);
                    if (!el) return;
                    var on = window._wrListMode === p[1];
                    el.style.background = on ? 'var(--primary)' : 'transparent';
                    el.style.color = on ? '#fff' : 'var(--text-secondary)';
                    el.style.fontWeight = on ? '700' : '500';
                });
            };
            /** 刷新当前资料列表（两种模式共用） */
            window.wrRefreshMatList = function () {
                try {
                    if (_wrMatFilter === 'allmodule') { window.wrRenderMaterialCenter(_wrCenterGroup || 'all'); }
                    else { window.wrRenderMaterials(); }
                } catch (e) { console.warn('[wr] 刷新资料列表失败：', e); }
            };
            window.wrSetListMode = function (mode) {
                window._wrListMode = (mode === 'time') ? 'time' : 'type';
                try { localStorage.setItem('wr_list_mode', window._wrListMode); } catch (e) {}
                window.wrSyncListModeChips();
                window.wrRefreshMatList();
            };
            /** 折叠 / 展开某个块（状态落盘，切换页面回来仍保持） */
            window.wrToggleGroup = function (key) {
                var k = String(key || '');
                var c = window._wrListCollapsed || (window._wrListCollapsed = {});
                if (c[k]) { delete c[k]; } else { c[k] = 1; window._wrListExpanded[k] = 1; }   // 展开时顺带显示全部，用户点开就是想看
                try { localStorage.setItem('wr_list_collapsed', JSON.stringify(c)); } catch (e) {}
                window.wrRefreshMatList();
            };
            /** 块内「展开全部」 */
            window.wrExpandGroup = function (key) {
                window._wrListExpanded[String(key || '')] = 1;
                window.wrRefreshMatList();
            };

            // 各来源 adapter：load() 取原始数组，norm() 映射为统一卡片项
            var WR_CENTER_SOURCES = {
                material: {
                    label: '写作资料', icon: '📄',
                    load: function() { return wrDbGetAll(WR_MAT_STORE); },
                    norm: function(m) {
                        return {
                            source: 'material', id: m.id,
                            title: m.title || m.fileName || '未命名资料',
                            sub: [ (WR_MAT_TYPES[m.matType] || {}).label, wrFmtDate(m.importAt).slice(0, 10),
                                   (m.fileSize ? Math.round(m.fileSize / 1024) + 'KB' : '') ].filter(Boolean).join(' · '),
                            summary: String(m.content || '').replace(/\n/g, ' ').slice(0, 90),
                            badge: (WR_MAT_TYPES[m.matType] || {}).label || '资料',
                            ts: wrItemTime(m),
                            open: function() { wrViewMaterial(m.id); }
                        };
                    }
                },
                issue: {
                    label: '检查信息', icon: '📊',
                    load: function() { return wrReadStore('RailwayIssueDB_v2', 'issues'); },
                    norm: function(it) {
                        return {
                            source: 'issue', id: it.id,
                            title: (String(it.content || '检查记录').replace(/\n/g, ' ').trim()).slice(0, 42) || '检查记录',
                            sub: [ it['性质'], it.category, it.unit, it.datetime ].filter(Boolean).join(' · '),
                            summary: String(it.content || '').replace(/\n/g, ' ').slice(0, 90),
                            badge: it['性质'] || '检查',
                            ts: wrItemTime(it),
                            open: function() { if (window.switchTab) window.switchTab('issue'); }
                        };
                    }
                },
                rule: {
                    label: '规章制度', icon: '📋',
                    load: function() {
                        return wrReadStore('RailwayRuleDB', 'ruleCollection').then(function(arr) {
                            if (arr.length === 1 && arr[0] && arr[0].id === 1 && Array.isArray(arr[0].data)) return arr[0].data;
                            return arr;
                        });
                    },
                    norm: function(r) {
                        return {
                            source: 'rule', id: r.id,
                            title: r.title || '未命名规章',
                            sub: [ r.trade, r.category, r.source ].filter(Boolean).join(' · '),
                            summary: String(r.content || '').replace(/<[^>]+>/g, '').replace(/\n/g, ' ').slice(0, 90),
                            badge: r.trade || '规章',
                            ts: wrItemTime(r),
                            open: function() { if (window.switchTab) window.switchTab('rule'); }
                        };
                    }
                },
                diary: {
                    label: '工作日志', icon: '📝',
                    load: function() { return wrLoadDiaryCenter(); },
                    norm: function(d) {
                        if (d.kind === 'media') {
                            return {
                                source: 'diary', id: d.id, media: true,
                                title: d.name,
                                sub: [ d.typeLabel, d.timestamp ? wrFmtDate(d.timestamp).slice(0, 10) : '' ].filter(Boolean).join(' · '),
                                summary: '工作日志多媒体附件',
                                badge: d.typeLabel,
                                ts: wrItemTime(d),
                                open: function() { if (window.switchTab) window.switchTab('diary'); }
                            };
                        }
                        return {
                            source: 'diary', id: d.date,
                            title: d.title,
                            sub: [ '日志', d.issueCount ? (d.issueCount + '条问题') : '' ].filter(Boolean).join(' · '),
                            summary: String(d.work || '').replace(/\n/g, ' ').slice(0, 90),
                            badge: '日志',
                            ts: wrItemTime(d),
                            open: function() { if (window.switchTab) window.switchTab('diary'); }
                        };
                    }
                },
                report: {
                    label: '报告', icon: '📑',
                    load: function() { return wrDbGetAll(WR_RPT_STORE); },
                    norm: function(r) {
                        return {
                            source: 'report', id: r.id,
                            title: r.title || '未命名报告',
                            sub: [ r.source, wrCatName(r.category), wrFmtDate(r.date).slice(0, 10) ].filter(Boolean).join(' · '),
                            summary: String(r.content || '').replace(/\n/g, ' ').slice(0, 90),
                            badge: wrCatName(r.category),
                            ts: wrItemTime(r),
                            open: function() { wrViewReport(r.id); }
                        };
                    }
                }
            };
            var WR_CENTER_ORDER = ['material', 'issue', 'rule', 'diary', 'report'];

            // 资料中心统一渲染（聚合全部来源 + 跨源搜索 + 来源分组）
            window.wrRenderMaterialCenter = async function(group) {
                if (group) _wrCenterGroup = group;
                ['all'].concat(WR_CENTER_ORDER).forEach(function(g) {
                    var b = document.getElementById('wr-center-tab-' + g);
                    if (b) b.classList.toggle('active', g === _wrCenterGroup);
                });
                var listEl = document.getElementById('wr-mat-list');
                if (!listEl) return;
                var q = ((document.getElementById('wr-mat-search') || {}).value || '').toLowerCase().trim();
                listEl.innerHTML = '<div style="text-align:center;padding:30px;color:var(--text-secondary);font-size:0.85rem;">加载中…</div>';
                try {
                    var groups = _wrCenterGroup === 'all' ? WR_CENTER_ORDER.slice() : [_wrCenterGroup];
                    var tasks = groups.map(function(g) {
                        return Promise.resolve(WR_CENTER_SOURCES[g].load())
                            .then(function(arr) {
                                return (arr || []).map(function(it) { try { return WR_CENTER_SOURCES[g].norm(it); } catch (e) { return null; } }).filter(Boolean);
                            })
                            .catch(function() { return []; });
                    });
                    var results = await Promise.all(tasks);
                    var items = [];
                    results.forEach(function(arr) { items = items.concat(arr); });
                    if (q) items = items.filter(function(it) {
                        return (it.title || '').toLowerCase().includes(q) || (it.summary || '').toLowerCase().includes(q)
                            || (it.sub || '').toLowerCase().includes(q) || (it.badge || '').toLowerCase().includes(q);
                    });
                    // 【2026-09-22】跨源统一按时间倒序（最近的在最上面）：原来完全没排序，只是把各来源数组
                    //   首尾相接 → 看起来毫无规律；顺带让下面"只显示前 400 条"截到的是**最新**的 400 条。
                    items.sort(wrByTimeDesc);
                    var total = items.length;
                    if (items.length > 400) items = items.slice(0, 400);
                    var countEl = document.getElementById('wr-mat-count');
                    if (countEl) countEl.textContent = (total > 400 ? '显示前400/' : '') + total + ' 条';
                    if (!items.length) {
                        listEl.innerHTML = '<div style="text-align:center;padding:30px;color:var(--text-secondary);font-size:0.85rem;">' + (q ? '无匹配结果' : '暂无可查看的数据') + '</div>';
                        return;
                    }
                    _wrCenterItems = items;
                    var _centerCardOf = function(it, i) {
                        var icon = (WR_CENTER_SOURCES[it.source] || {}).icon || '📄';
                        return '<div class="wr-mat-card">'
                            + '<div style="font-size:1.4rem;flex-shrink:0;margin-top:1px;">' + icon + '</div>'
                            + '<div style="flex:1;min-width:0;cursor:pointer;" onclick="wrCenterOpen(' + i + ')">'
                            +   '<div style="font-weight:700;font-size:0.88rem;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--primary);">' + wrEsc(it.title) + '</div>'
                            +   '<div style="font-size:0.73rem;color:var(--text-secondary);margin:2px 0;display:flex;flex-wrap:wrap;gap:5px;align-items:center;">'
                            +     '<span style="background:#eff6ff;color:#1d4ed8;padding:1px 8px;border-radius:10px;">' + wrEsc(it.badge || '') + '</span>'
                            +     (it.sub ? '<span>' + wrEsc(it.sub) + '</span>' : '')
                            +   '</div>'
                            +   '<div style="font-size:0.77rem;color:#64748b;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + wrEsc(it.summary || '') + (it.summary ? '…' : '') + '</div>'
                            + '</div>'
                            + '<div style="display:flex;flex-direction:column;gap:4px;flex-shrink:0;">'
                            +   '<button onclick="wrCenterOpen(' + i + ')" class="wr-mat-btn wr-mat-btn-view">打开</button>'
                            + '</div></div>';
                    };
                    window.wrSyncListModeChips();
                    // 【2026-09-22】按时间：纯时间倒序不分块；按类型：按来源分块（块内时间倒序，可折叠、默认只展开最新 10 条）。
                    // _wrCenterItems 必须与屏幕上卡片的顺序一致（wrCenterOpen 用下标取项），所以分块模式下按块顺序重建。
                    if (window._wrListMode === 'time') {
                        _wrCenterItems = items;
                        listEl.innerHTML = items.map(_centerCardOf).join('');
                    } else {
                        var _bucket = {};
                        items.forEach(function(it) { var k = it.source || 'material'; (_bucket[k] = _bucket[k] || []).push(it); });
                        var _ordered = [], _parts = [];
                        var _showHead = groups.length > 1;
                        groups.forEach(function(g) {
                            var arr = _bucket[g] || [];
                            if (!arr.length) return;
                            var src = WR_CENTER_SOURCES[g] || {};
                            var label = (src.icon ? src.icon + ' ' : '') + (src.label || g);
                            var collapsed = !!window._wrListCollapsed[g];
                            if (_showHead) _parts.push(wrGroupHeaderHtml(label, arr.length, g, collapsed));
                            if (collapsed && _showHead) return;
                            var showAll = !!window._wrListExpanded[g];
                            var shown = (showAll || arr.length <= WR_LIST_PREVIEW_N) ? arr : arr.slice(0, WR_LIST_PREVIEW_N);
                            shown.forEach(function(it) {
                                var i = _ordered.length;
                                _ordered.push(it);
                                _parts.push(_centerCardOf(it, i));
                            });
                            var more = arr.length - shown.length;
                            if (more > 0) _parts.push(wrGroupMoreHtml(g, more));
                        });
                        _wrCenterItems = _ordered;
                        listEl.innerHTML = _parts.join('');
                    }
                } catch (e) {
                    listEl.innerHTML = '<div style="text-align:center;padding:30px;color:#b91c1c;font-size:0.85rem;">加载失败：' + wrEsc(e && e.message ? e.message : String(e)) + '</div>';
                }
            };
            window.wrCenterOpen = function(i) {
                var it = _wrCenterItems && _wrCenterItems[i];
                if (it && it.open) { try { it.open(); } catch (e) { console.warn('[center] 打开失败', e); } }
            };

            // ---- 撰写报告（三步流程：选择模板→选择资料→确认形成报告）----
            // ====== 智能写作文件上传和解析 ======
            window._wrUploadedFiles = []; // [{name, content, type}]

            // 文件上传处理（保留以兼容可能的其他用途）
            window.wrHandleFileUpload = async function(input) {
                const files = Array.from(input.files || []);
                if (!files.length) return;

                const tagsEl = document.getElementById('wr-file-tags');

                for (const file of files) {
                    try {
                        let content = '';
                        const ext = file.name.split('.').pop().toLowerCase();

                        // 根据文件扩展名选择解析方式
                        // 【修复 F1】复用与「资料库导入」一致的真实解析能力（mammoth/XLSX/pdf.js），
                        // 不再使用占位文本函数，确保上传文件正文能被 AI 读取。
                        if (ext === 'txt' || ext === 'md' || ext === 'json' || ext === 'csv') {
                            content = await wrReadTextFile(file);
                        } else if (ext === 'docx') {
                            try {
                                const parsed = await wrParseDocx(file);
                                content = parsed.content || parsed.title || '';
                            } catch (e) { content = '[DOCX解析失败：' + (e.message || '未知错误') + ']'; }
                        } else if (ext === 'doc') {
                            content = '[暂不支持 .doc 旧版格式，请另存为 .docx 后上传]';
                        } else if (ext === 'xlsx' || ext === 'xls') {
                            try {
                                const parsed = await wrParseExcel(file);
                                content = parsed.content || '';
                            } catch (e) { content = '[Excel解析失败：' + (e.message || '未知错误') + ']'; }
                        } else if (ext === 'pdf') {
                            if (typeof pdfjsLib !== 'undefined') {
                                try {
                                    const arrayBuffer = await file.arrayBuffer();
                                    const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
                                    let fullText = '';
                                    const maxPages = Math.min(pdf.numPages, 50);
                                    for (let p = 1; p <= maxPages; p++) {
                                        const page = await pdf.getPage(p);
                                        const tc = await page.getTextContent();
                                        fullText += tc.items.map(it => it.str).join(' ') + '\n';
                                    }
                                    content = fullText.trim();
                                } catch (e) { content = '[PDF解析失败：' + (e.message || '未知错误') + ']'; }
                            } else {
                                content = '[PDF解析需要 pdf.js 库，请先在「资料库导入」中触发加载后再上传，或直接用「资料库导入」]';
                            }
                        } else if (/^image\//.test(file.type) || /^(png|jpe?g|gif|webp|bmp)$/.test(ext)) {
                            // 【视觉模型接入】图片附件：复用 doubao-common 的压缩读取，得到 dataUrl 供视觉模型理解
                            if (typeof window.dsReadImageFile === 'function') {
                                await window.dsReadImageFile(file); // 内部把压缩后的 dataUrl 挂到 file.attachDataUrl
                                const dataUrl = file.attachDataUrl || null;
                                const sizeKB = (file.size / 1024).toFixed(0);
                                window._wrUploadedFiles.push({
                                    name: file.name,
                                    content: '[图片附件] ' + file.name + '（' + sizeKB + 'KB）\n图片已作为视觉内容附上，请结合图片理解用户写作需求。',
                                    type: ext,
                                    isImage: true,
                                    dataUrl: dataUrl
                                });
                                // 显示图片标签（缩略图）
                                if (tagsEl) {
                                    tagsEl.style.display = 'flex';
                                    const tag = document.createElement('span');
                                    tag.style.cssText = 'display:inline-flex;align-items:center;gap:6px;padding:4px 10px;background:#eef2ff;border:1px solid #c7d2fe;border-radius:16px;font-size:0.78rem;color:#4338ca;';
                                    const idx = window._wrUploadedFiles.length - 1;
                                    if (dataUrl) {
                                        const thumb = document.createElement('img');
                                        thumb.src = dataUrl;
                                        thumb.style.cssText = 'width:20px;height:20px;object-fit:cover;border-radius:4px;flex-shrink:0;';
                                        tag.appendChild(thumb);
                                    }
                                    tag.appendChild(document.createTextNode('🖼️ ' + file.name));
                                    const x = document.createElement('button');
                                    x.textContent = '×';
                                    x.style.cssText = 'background:none;border:none;cursor:pointer;color:#999;font-size:0.95rem;padding:0;line-height:1;margin-left:2px;';
                                    x.onclick = function() { wrRemoveUploadedFile(idx, tag); };
                                    tag.appendChild(x);
                                    tagsEl.appendChild(tag);
                                }
                                // 显示到对话框（写作历史区域）
                                wrShowUploadedFileInChat(file.name, '[图片附件] ' + file.name);
                                continue; // 图片不入 content 文本，交予视觉块处理
                            } else {
                                content = '[图片上传需要 doubao-common.js 加载]';
                            }
                        } else {
                            content = '暂不支持该文件格式：' + ext;
                        }

                        // 限制文件内容长度（防止过大）
                        const maxLen = 20000;
                        const truncated = content.length > maxLen ? content.slice(0, maxLen) + '\n...[内容过长，已截取前' + maxLen + '字]' : content;

                        window._wrUploadedFiles.push({
                            name: file.name,
                            content: truncated,
                            type: ext
                        });

                        // 显示文件标签
                        if (tagsEl) {
                            tagsEl.style.display = 'flex';
                            const tag = document.createElement('span');
                            tag.style.cssText = 'display:inline-flex;align-items:center;gap:6px;padding:4px 10px;background:#e6f7ff;border:1px solid #91d5ff;border-radius:16px;font-size:0.78rem;color:#0050b3;';
                            const idx = window._wrUploadedFiles.length - 1;
                            const icon = ext === 'pdf' ? '📕' : ext === 'docx' || ext === 'doc' ? '📘' : ext === 'xlsx' || ext === 'xls' ? '📊' : '📄';
                            tag.innerHTML = icon + ' ' + (typeof window.escapeHtml === 'function' ? window.escapeHtml(file.name) : String(file.name).replace(/</g,'&lt;'))
                                + ' <button onclick="wrRemoveUploadedFile(' + idx + ',this.parentElement)" style="background:none;border:none;cursor:pointer;color:#999;font-size:0.95rem;padding:0;line-height:1;margin-left:2px;">×</button>';
                            tagsEl.appendChild(tag);
                        }

                        // 显示到对话框内（写作历史区域）
                        wrShowUploadedFileInChat(file.name, truncated);

                    } catch (err) {
                        console.error('文件解析失败:', file.name, err);
                        alert('文件 "' + file.name + '" 解析失败：' + err.message);
                    }
                }

                input.value = ''; // 允许重复选同一文件
            };

            window.wrRemoveUploadedFile = function(idx, tagEl) {
                if (window._wrUploadedFiles[idx]) window._wrUploadedFiles[idx] = null;
                if (tagEl) tagEl.remove();
                const tagsEl = document.getElementById('wr-file-tags');
                if (tagsEl && !tagsEl.children.length) tagsEl.style.display = 'none';
            };

            // 读取纯文本文件
            window.wrReadTextFile = function(file) {
                return new Promise((resolve, reject) => {
                    const reader = new FileReader();
                    reader.onload = e => resolve(e.target.result || '');
                    reader.onerror = () => reject(new Error('文件读取失败'));
                    reader.readAsText(file, 'UTF-8');
                });
            };

            // 读取Word文件
            window.wrReadWordFile = function(file) {
                return new Promise((resolve, reject) => {
                    const reader = new FileReader();
                    reader.onload = function(e) {
                        try {
                            // 尝试解析docx（简化版：提取文本）
                            const arrayBuffer = e.target.result;
                            // 注意：纯JS无法完美解析docx，这里使用简化方案
                            // 如果需要完整解析，需要引入mammoth.js等库
                            resolve('[Word文件] ' + file.name + '\n\n注意：当前环境仅支持提取文本内容，完整格式需要引入专业库。\n\n文件大小：' + (file.size / 1024).toFixed(2) + ' KB');
                        } catch (err) {
                            reject(new Error('Word文件解析失败'));
                        }
                    };
                    reader.onerror = () => reject(new Error('文件读取失败'));
                    reader.readAsArrayBuffer(file);
                });
            };

            // 读取Excel文件
            window.wrReadExcelFile = function(file) {
                return new Promise((resolve, reject) => {
                    const reader = new FileReader();
                    reader.onload = function(e) {
                        try {
                            const data = new Uint8Array(e.target.result);
                            // 注意：纯JS无法完美解析xlsx，这里使用简化方案
                            // 如果需要完整解析，需要引入xlsx.js等库
                            resolve('[Excel文件] ' + file.name + '\n\n注意：当前环境仅支持显示文件信息，完整数据需要引入专业库。\n\n文件大小：' + (file.size / 1024).toFixed(2) + ' KB');
                        } catch (err) {
                            reject(new Error('Excel文件解析失败'));
                        }
                    };
                    reader.onerror = () => reject(new Error('文件读取失败'));
                    reader.readAsArrayBuffer(file);
                });
            };

            // 读取PDF文件
            window.wrReadPdfFile = function(file) {
                return new Promise((resolve, reject) => {
                    const reader = new FileReader();
                    reader.onload = function(e) {
                        try {
                            // 注意：纯JS无法完美解析PDF，这里使用简化方案
                            // 如果需要完整解析，需要引入pdf.js等库
                            resolve('[PDF文件] ' + file.name + '\n\n注意：当前环境仅支持显示文件信息，完整内容需要引入专业库。\n\n文件大小：' + (file.size / 1024).toFixed(2) + ' KB');
                        } catch (err) {
                            reject(new Error('PDF文件解析失败'));
                        }
                    };
                    reader.onerror = () => reject(new Error('文件读取失败'));
                    reader.readAsArrayBuffer(file);
                });
            };

            // 显示上传的文件到对话框内
            window.wrShowUploadedFileInChat = function(fileName, content) {
                const chatHistory = document.getElementById('wr-chat-history');
                if (!chatHistory) return;

                // 确保对话历史区域可见
                chatHistory.style.display = 'flex';

                // 添加文件消息气泡
                const msgDiv = document.createElement('div');
                msgDiv.style.cssText = 'display:flex;flex-direction:column;gap:4px;align-items:flex-end;max-width:100%;';
                msgDiv.innerHTML = `
                    <div style="font-size:0.7rem;color:var(--text-secondary);padding:0 4px;">用户</div>
                    <div style="background:linear-gradient(135deg,#5a9d82,#3d7d65);color:#fff;padding:8px 14px;border-radius:12px 12px 4px 12px;max-width:85%;font-size:0.9rem;line-height:1.5;word-break:break-word;">
                        <div style="display:flex;align-items:center;gap:6px;margin-bottom:4px;font-weight:600;">
                            <span>📎</span>
                            <span>${wrEsc(fileName)}</span>
                        </div>
                        <div style="font-size:0.85rem;opacity:0.95;white-space:pre-wrap;max-height:200px;overflow-y:auto;border-top:1px solid rgba(255,255,255,0.2);padding-top:6px;margin-top:4px;">${wrEsc(content.slice(0, 500))}${content.length > 500 ? '\n\n...[内容预览已截取]' : ''}</div>
                    </div>
                `;
                chatHistory.appendChild(msgDiv);
                chatHistory.scrollTop = chatHistory.scrollHeight;
            };

            // ====== 智能写作核心功能 ======
            window.wrWrite = function() {
                const query = (document.getElementById('wr-query-input') || {}).value || '';
                if (!query.trim()) {
                    alert('请先在上方"写作需求"中输入您要撰写的内容。');
                    return;
                }

                // 修复C：无论是否有对话历史，始终弹出模板/资料选择，允许用户每次重选（弹窗会预填上次选择）

                // 展示对话框（无论DB是否可用）
                var showDialog = function(templates, otherMats) {
                    // 【v3.76 二改·只走两路菜单】用户反馈：原先"资料库内容常显 + 菜单里又有📚资料库"= 重复。
                    //   现在弹窗里**不再常显资料库下拉/清单**，只显示"已选结果"；想看资料库就点按钮 →
                    //   菜单(💻 本地文件 / 📚 资料库) → 资料库才弹出选择层（不重复、不占版面）。
                    //   模板区直接显示当前选中项（本地模板也在这里可见）。
                    var _addBtnCss = 'padding:5px 10px;border:1px solid var(--primary);background:#fff;color:var(--primary);border-radius:16px;font-size:0.78rem;cursor:pointer;white-space:nowrap;';
                    var modalHtml = '<div class="wr-step-panel" style="background:#fff;border-radius:14px;padding:20px;width:min(560px,95vw);max-height:85vh;display:flex;flex-direction:column;gap:12px;">'
                        + '<div style="display:flex;align-items:center;justify-content:space-between;"><span style="font-weight:700;font-size:0.97rem;color:var(--primary);">✍️ 选择模板和参考资料</span><button onclick="this.closest(\'.wr-step-modal\').remove()" style="background:none;border:none;cursor:pointer;font-size:1.2rem;">✕</button></div>'
                        + '<div style="font-size:0.8rem;color:var(--text-secondary);">两个来源任选：<b>💻 本地文件</b>（本机直选，<b>会保存进资料库</b>，与「资料中心 → 导入」同一套解析）或 <b>📚 资料库</b>（点按钮才弹出，不占版面）</div>'
                        + '<div><div style="display:flex;align-items:center;justify-content:space-between;gap:8px;"><label style="font-weight:600;">📄 写作模板（可选）</label>'
                        + '<button type="button" class="wr-step-addbtn" onclick="wrStepAddMenu(\'template\', this)" style="' + _addBtnCss + '">选择模板 ▾</button></div>'
                        + '<div id="wr-step-tpl-line" class="wr-step-line" style="margin-top:6px;padding:8px 10px;border:1px dashed var(--border);border-radius:8px;background:#f8fafc;min-height:38px;display:flex;align-items:center;flex-wrap:wrap;gap:6px;"></div></div>'
                        + '<div><div style="display:flex;align-items:center;justify-content:space-between;gap:8px;"><label style="font-weight:600;">📚 参考资料（可多选）</label>'
                        + '<button type="button" class="wr-step-addbtn" onclick="wrStepAddMenu(\'reference\', this)" style="' + _addBtnCss + '">＋ 添加 ▾</button></div>'
                        + '<div id="wr-step-ref-line" class="wr-step-line" style="margin-top:6px;padding:8px 10px;border:1px dashed var(--border);border-radius:8px;background:#f8fafc;min-height:38px;display:flex;align-items:center;flex-wrap:wrap;gap:6px;"></div></div>'
                        // 【2026-09-23 用户反馈"模板/资料用不用的逻辑有点乱"】常显一块"将如何生成"说明：
                        //   不同选择（有/无模板 × 有/无资料）会走哪条链路、以什么为准，全部写清楚，并显示本次写作需求
                        + '<div id="wr-step-hint" style="font-size:0.78rem;line-height:1.7;color:#475569;background:#f8fafc;border:1px solid var(--border);border-radius:8px;padding:8px 10px;"></div>'
                        + '<div style="display:flex;gap:8px;justify-content:flex-end;"><button onclick="wrConfirmSelection()" style="padding:8px 16px;background:var(--primary);color:#fff;border:none;border-radius:6px;">确认并生成</button><button onclick="this.closest(\'.wr-step-modal\').remove()" style="padding:8px 16px;">取消</button></div></div>';
                    var modal = document.createElement('div');
                    modal.className = 'wr-step-modal';
                    modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:10100;display:flex;align-items:center;justify-content:center;';
                    modal.innerHTML = modalHtml;
                    document.body.appendChild(modal);
                    wrStepRenderChips();   // 【v3.76】打开即回填本地来源的已选项
                };

                // 先立即显示对话框，再异步加载数据更新
                showDialog([], []);
                Promise.all([ wrGetAllTemplates().catch(function(){ return []; }), wrDbGetAll(WR_MAT_STORE).catch(function(){ return []; }) ])
                .then(function(res) {
                    var allTpls = res[0] || [];
                    var mats = res[1] || [];
                    window._wrAllMats = mats.slice().sort(wrByTimeDesc);   // 【2026-09-22】最近的在最前；选择层直接用这个顺序
                    window._wrAllTpls = allTpls; // 缓存：资料库模板（含 WR_TPL_STORE + WR_MAT_STORE 里的模板）
                    // 修复C：预填上次选择的模板（本地模板也有 _src='local'，同一套状态即可）
                    if (!window._wrStepTplSel && window._wrSelectedTemplate) {
                        var _st = window._wrSelectedTemplate;
                        window._wrStepTplSel = { src: (_st._src === 'local' ? 'local' : 'lib'), id: _st.id, title: _st.title };
                    }
                    wrStepRenderChips();   // 渲染"当前模板 + 已选参考资料"（两个来源合并显示）
                }).catch(function(e) {
                    console.warn('资料库异步加载失败:', e);
                    window._wrAllMats = [];
                    window._wrAllTpls = [];
                });
            };

            // ==================== 【v3.76】模板 / 参考资料「两路输入」====================
            // 设计（二改后定稿）：
            //   · 弹窗里**只显示"已选结果"**（当前模板一行 + 已选参考资料芯片），不再常显资料库下拉/清单
            //     —— 避免"资料库内容既常显、菜单里又能点进去"的重复（用户反馈）。
            //   · 想看资料库 → 点按钮 → 两路菜单（💻 本地文件 / 📚 资料库） → 点「📚 资料库」才弹出选择层。
            //   · 落点（与既有生成链路天然对齐，无需改生成逻辑）：
            //       当前模板   → `window._wrStepTplSel`（{src:'lib'|'local', id, title}）→ 确认时写进 `_wrSelectedTemplate`
            //       资料库资料 → `window._wrSelectedMaterialIds`（原有）
            //       本地文件   → 本地模板进 `_wrLocalTpls`；本地参考资料进 `_wrUploadedFiles`（生成时拼进「上传的文件内容」块）
            window._wrLocalTpls = window._wrLocalTpls || [];
            window._wrStepTplSel = window._wrStepTplSel || null;

            // 两路来源菜单（点「选择模板 ▾」/「＋ 添加 ▾」弹出）
            window.wrStepAddMenu = function(kind, anchor) {
                var old = document.getElementById('wr-step-add-menu');
                if (old) old.remove();
                var menu = document.createElement('div');
                menu.id = 'wr-step-add-menu';
                menu.className = 'wr-step-menu';
                menu.style.cssText = 'position:fixed;z-index:10200;background:#fff;border:1px solid var(--border);border-radius:10px;box-shadow:0 8px 24px rgba(0,0,0,0.14);padding:4px;min-width:152px;font-size:0.84rem;';
                var r = (anchor && anchor.getBoundingClientRect) ? anchor.getBoundingClientRect() : null;
                menu.style.top = (r ? r.bottom + 6 : 120) + 'px';
                menu.style.left = Math.max(8, (r ? r.right : 300) - 152) + 'px';
                var itemCss = 'padding:8px 10px;border-radius:8px;cursor:pointer;display:flex;align-items:center;gap:6px;';
                menu.innerHTML = '<div class="wr-step-menu-item" data-src="local" style="' + itemCss + '">💻 本地文件</div>'
                    + '<div class="wr-step-menu-item" data-src="lib" style="' + itemCss + '">📚 资料库</div>';
                Array.prototype.forEach.call(menu.children, function(el) {
                    el.onmouseover = function() { el.style.background = '#eff6ff'; };
                    el.onmouseout = function() { el.style.background = ''; };
                    el.onclick = function() {
                        menu.remove();
                        if (el.getAttribute('data-src') === 'local') wrStepPickLocal(kind);
                        else wrStepOpenLibrary(kind);      // 【二改】不再"聚焦常显控件"，改为弹出资料库选择层
                    };
                });
                document.body.appendChild(menu);
                setTimeout(function() {
                    document.addEventListener('click', function _close(ev) {
                        if (!menu.contains(ev.target) && ev.target !== anchor) { menu.remove(); document.removeEventListener('click', _close); }
                    });
                }, 0);
            };

            // 「📚 资料库」选择层：只有点进来才展开资料库内容（模板=单选；参考资料=多选）
            function wrStepOpenLibrary(kind) {
                var old = document.getElementById('wr-step-lib');
                if (old) old.remove();
                var libTpls = window._wrAllTpls || [];
                var localTpls = window._wrLocalTpls || [];
                var libMats = (window._wrAllMats || []).filter(function(m) { return m.matType !== 'template'; });
                var selIds = window._wrSelectedMaterialIds || [];
                var cur = window._wrStepTplSel;
                var rowCss = 'display:flex;align-items:center;gap:8px;padding:7px 9px;border:1px solid var(--border);border-radius:7px;background:#fff;cursor:pointer;font-size:0.85rem;';
                var rowCls = 'wr-step-lib-row';
                var body = '';
                if (kind === 'template') {
                    body += '<label class="' + rowCls + '" style="' + rowCss + '"><input type="radio" name="wr-step-lib-tpl" value=""' + (!cur ? ' checked' : '') + '> <span>不使用模板</span></label>';
                    libTpls.forEach(function(t) {
                        var on = (cur && cur.src !== 'local' && String(cur.id) === String(t.id));
                        body += '<label class="' + rowCls + '" style="' + rowCss + '"><input type="radio" name="wr-step-lib-tpl" value="lib:' + wrEsc(String(t.id)) + '"' + (on ? ' checked' : '') + '> <span>📄 ' + wrEsc(t.title) + '</span></label>';
                    });
                    localTpls.forEach(function(t) {
                        var on = (cur && cur.src === 'local' && String(cur.id) === String(t.id));
                        body += '<label class="' + rowCls + '" style="' + rowCss + '"><input type="radio" name="wr-step-lib-tpl" value="local:' + wrEsc(String(t.id)) + '"' + (on ? ' checked' : '') + '> <span>💻 ' + wrEsc(t.title) + '（本地）</span></label>';
                    });
                    if (!libTpls.length && !localTpls.length) body += '<div style="padding:16px;text-align:center;color:var(--text-secondary);font-size:0.85rem;">资料库里还没有模板</div>';
                } else {
                    if (!libMats.length) body += '<div style="padding:16px;text-align:center;color:var(--text-secondary);font-size:0.85rem;">资料库里还没有参考资料</div>';
                    // 【2026-09-22】按类型分块（块内时间倒序：libMats 来自 _wrAllMats，已按时间排好）；
                    //   只有一种类型时不加组头，避免多余噪音
                    var _matGroups = wrGroupByType(libMats);
                    _matGroups.forEach(function(g) {
                        if (_matGroups.length > 1) {
                            body += '<div style="padding:7px 2px 2px;font-size:0.75rem;font-weight:700;color:var(--primary);">'
                                + wrEsc(g.label) + ' · ' + g.items.length + ' 条</div>';
                        }
                        g.items.forEach(function(m) {
                            var on = selIds.indexOf(m.id) !== -1;
                            var t = (WR_MAT_TYPES[m.matType] || {}).label || m.matType || '其它';
                            body += '<label class="' + rowCls + '" style="' + rowCss + '"><input type="checkbox" class="wr-step-lib-mat" value="' + m.id + '"' + (on ? ' checked' : '') + '> <span style="flex:1;">' + wrEsc(m.title || m.fileName) + '</span><span style="font-size:0.72rem;color:var(--text-secondary);">' + wrEsc(t) + '</span></label>';
                        });
                    });
                }
                var overlay = document.createElement('div');
                overlay.id = 'wr-step-lib';
                overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.45);z-index:10250;display:flex;align-items:center;justify-content:center;';
                overlay.innerHTML = '<div class="wr-step-panel" style="background:#fff;border-radius:14px;padding:18px;width:min(520px,94vw);max-height:80vh;display:flex;flex-direction:column;gap:10px;">'
                    + '<div style="display:flex;align-items:center;justify-content:space-between;"><span style="font-weight:700;font-size:0.94rem;color:var(--primary);">📚 资料库中选' + (kind === 'template' ? '模板' : '参考资料') + '</span><button onclick="document.getElementById(\'wr-step-lib\').remove()" style="background:none;border:none;cursor:pointer;font-size:1.15rem;">✕</button></div>'
                    + '<div style="font-size:0.78rem;color:var(--text-secondary);">' + (kind === 'template' ? '单选；本地模板与资料库模板都在这里，可随时切换。' : '可多选；与「💻 本地文件」添加的参考资料会一起交给 AI。') + '</div>'
                    + '<div style="display:flex;flex-direction:column;gap:5px;overflow-y:auto;max-height:52vh;">' + body + '</div>'
                    + '<div style="display:flex;gap:8px;justify-content:flex-end;"><button onclick="wrStepLibConfirm(\'' + kind + '\')" style="padding:8px 16px;background:var(--primary);color:#fff;border:none;border-radius:6px;font-size:0.88rem;font-weight:600;cursor:pointer;">确定</button>'
                    + '<button class="wr-step-btn-plain" onclick="document.getElementById(\'wr-step-lib\').remove()" style="padding:8px 16px;border:1px solid var(--border);border-radius:6px;background:#f8fafc;font-size:0.88rem;cursor:pointer;">取消</button></div></div>';
                document.body.appendChild(overlay);
            }

            // 资料库选择层：确定
            window.wrStepLibConfirm = function(kind) {
                var box = document.getElementById('wr-step-lib');
                if (kind === 'template') {
                    var picked = null;
                    Array.prototype.forEach.call(box.querySelectorAll('input[name="wr-step-lib-tpl"]:checked'), function(r) { picked = r; });
                    var v = picked ? picked.value : '';
                    if (!v) {
                        window._wrStepTplSel = null;                       // 不使用模板
                    } else {
                        var parts = v.split(':');
                        var src = parts[0], tid = parts.slice(1).join(':');
                        var list = src === 'local' ? (window._wrLocalTpls || []) : (window._wrAllTpls || []);
                        var hit = list.filter(function(t) { return String(t.id) === tid; })[0];
                        window._wrStepTplSel = hit ? { src: src, id: hit.id, title: hit.title } : null;
                    }
                } else {
                    var ids = [];
                    Array.prototype.forEach.call(box.querySelectorAll('input.wr-step-lib-mat:checked'), function(cb) { ids.push(parseInt(cb.value, 10)); });
                    window._wrSelectedMaterialIds = ids;
                }
                box.remove();
                wrStepRenderChips();
            };

            // 注：【v3.76】原先这里有一份"本地文件专用"的解析实现，已删除 ——
            //   本地选择现在与「资料中心导入」共用 `wrImportFiles` + `wrParseIntoItem`（同一套解析、同一张表），
            //   保留第二份解析正是"同一文件两处解析结果不一致"的来源。

            // 「💻 本地文件」这条路：**导入资料库**（与资料中心导入同一套解析/同一张表），导入后自动选中
            //   · 模板：直接以 matType='template' 入库 → 自动选中（"本地模板"随即变成资料库模板）
            //   · 参考资料：先让用户选资料类型（与资料中心一致）→ 入库 → 自动加入已选
            function wrStepPickLocal(kind) {
                if (kind !== 'template') { wrStepAskMatType(function(matType) { wrStepLocalFileInput(kind, matType); }); return; }
                wrStepLocalFileInput(kind, 'template');
            }

            // 资料类型选择（与「资料中心 → 导入」的分类保持一致：模板/报告/检查信息/故障/文电/其它）
            function wrStepAskMatType(cb) {
                var old = document.getElementById('wr-step-mattype');
                if (old) old.remove();
                var keys = ['template', 'history', 'inspect', 'fault', 'dispatch', 'other'];
                var iconOf = { template: '📄', history: '📊', inspect: '🧾', fault: '🛠️', dispatch: '📢', other: '📁' };
                var btnCss = 'padding:9px 12px;border:1px solid var(--border);border-radius:8px;background:#f8fafc;font-size:0.85rem;cursor:pointer;text-align:left;';
                var body = keys.map(function(k) {
                    var t = WR_MAT_TYPES[k] || { label: k };
                    return '<button type="button" class="wr-step-type-btn" data-k="' + k + '" style="' + btnCss + '">' + (iconOf[k] || '📄') + ' ' + wrEsc(t.label || k) + '</button>';
                }).join('');
                var ov = document.createElement('div');
                ov.id = 'wr-step-mattype';
                ov.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.45);z-index:10250;display:flex;align-items:center;justify-content:center;';
                ov.innerHTML = '<div class="wr-step-panel" style="background:#fff;border-radius:14px;padding:18px;width:min(460px,94vw);display:flex;flex-direction:column;gap:10px;">'
                    + '<div style="font-weight:700;font-size:0.94rem;color:var(--primary);">📚 存到资料库的哪个分类？</div>'
                    + '<div style="font-size:0.78rem;color:var(--text-secondary);">与「资料中心 → 导入」一致：文件会保存进资料库，之后也能在资料库里复用。</div>'
                    + '<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;">' + body + '</div>'
                    + '<div style="display:flex;justify-content:flex-end;"><button type="button" class="wr-step-btn-plain" data-k="__cancel" style="padding:8px 16px;border:1px solid var(--border);border-radius:6px;background:#f8fafc;font-size:0.88rem;cursor:pointer;">取消</button></div></div>';
                document.body.appendChild(ov);
                Array.prototype.forEach.call(ov.querySelectorAll('button[data-k]'), function(b) {
                    b.onclick = function() {
                        var k = b.getAttribute('data-k');
                        ov.remove();
                        if (k === '__cancel') return;
                        cb(k);
                    };
                });
            }

            // 选文件 → 走统一导入 → 入库并自动选中
            function wrStepLocalFileInput(kind, matType) {
                var inp = document.createElement('input');
                inp.type = 'file';
                inp.accept = '.txt,.md,.docx,.pdf,.xlsx,.xls,.csv,.json';
                inp.multiple = (kind !== 'template');     // 模板用一个；参考资料可多选
                inp.style.display = 'none';
                inp.onchange = async function() {
                    var files = Array.from(inp.files || []);
                    inp.remove();
                    if (!files.length) return;
                    if (kind === 'template') files = files.slice(0, 1);
                    var toast = document.createElement('div');
                    toast.style.cssText = 'position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);background:rgba(0,0,0,0.8);color:white;padding:18px 26px;border-radius:10px;z-index:11000;font-size:14px;';
                    toast.textContent = '⏳ 正在导入到资料库…';
                    document.body.appendChild(toast);
                    try {
                        var res = await window.wrImportFiles(files, matType);
                        if (res.libFail) { alert('导入失败：\n· ' + (res.errors || []).join('\n· ')); return; }
                        // 刷新弹窗用的缓存（资料库列表/模板列表），保证新导入的立刻可选、可见
                        try { window._wrAllMats = (await wrDbGetAll(WR_MAT_STORE)).sort(wrByTimeDesc); } catch (e) {}
                        try { window._wrAllTpls = await wrGetAllTemplates(); } catch (e) {}
                        if (kind === 'template' && res.saved.length) {
                            var it = res.saved[0];
                            window._wrLocalTpls = [];                 // 已入资料库 → 不再作为"本地临时模板"
                            window._wrStepTplSel = { src: 'lib', id: it.id, title: it.title };
                        } else if (res.saved.length) {
                            var ids = (window._wrSelectedMaterialIds || []).filter(Boolean);
                            res.saved.forEach(function(it) { if (ids.indexOf(it.id) === -1) ids.push(it.id); });
                            window._wrSelectedMaterialIds = ids;
                        }
                        wrStepRenderChips();
                        var okN = res.saved.length, failN = (res.errors || []).length;
                        if (window.showToast) window.showToast('已保存到资料库并选中 ' + okN + ' 份' + (failN ? '（' + failN + ' 份失败）' : ''), false, 3000);
                        if (failN) alert('以下文件未能导入：\n· ' + res.errors.join('\n· '));
                    } catch (e) {
                        alert('导入失败：' + (e && e.message ? e.message : e));
                    } finally {
                        toast.remove();
                    }
                };
                document.body.appendChild(inp);
                inp.click();
            }

            // 画"已选结果"：模板一行（本地模板也在这一行可见）+ 参考资料芯片（资料库与本地合并显示），× 可移除
            function wrStepRenderChips() {
                var chipCss = 'display:inline-flex;align-items:center;gap:6px;padding:3px 10px;border-radius:16px;font-size:0.78rem;background:#eef2ff;border:1px solid #c7d2fe;color:#4338ca;';
                var libChipCss = 'display:inline-flex;align-items:center;gap:6px;padding:3px 10px;border-radius:16px;font-size:0.78rem;background:#eff6ff;border:1px solid #bfdbfe;color:#1d4ed8;';
                var tplChipCss = 'display:inline-flex;align-items:center;gap:6px;padding:4px 12px;border-radius:16px;font-size:0.82rem;background:#dbeafe;border:1px solid #93c5fd;color:#1e40af;font-weight:600;';
                var xCss = 'background:none;border:none;cursor:pointer;color:#818cf8;font-size:0.95rem;padding:0;line-height:1;';
                var emptyCss = 'color:#94a3b8;font-size:0.8rem;';

                // ① 写作模板：显示当前选中的模板（💻 本地 / 📄 资料库），未选则提示"可选"
                var tplHost = document.getElementById('wr-step-tpl-line');
                if (tplHost) {
                    var cur = window._wrStepTplSel;
                    if (!cur) {
                        tplHost.innerHTML = '<span class="wr-step-empty" style="' + emptyCss + '">暂未选择 · 不使用模板（按规范结构成文：总体情况 → 主要问题 → 原因分析 → 整改要求）</span>';
                    } else {
                        var localTpl = (cur.src === 'local');
                        var tplObj = ((localTpl ? (window._wrLocalTpls || []) : (window._wrAllTpls || [])).filter(function(t) { return String(t.id) === String(cur.id); })[0]);
                        tplHost.innerHTML = '<span class="wr-step-chip is-tpl" style="' + tplChipCss + '">' + (localTpl ? '💻' : '📄') + ' ' + wrEsc(cur.title || (tplObj && tplObj.title) || '模板')
                            + '<button type="button" style="' + xCss + '" data-k="tpl-clear">×</button></span>'
                            + '<span class="wr-step-src" style="font-size:0.72rem;color:#64748b;">' + (localTpl ? '本地文件' : '资料库') + '</span>';
                    }
                }

                // ② 参考资料：资料库勾选的 + 本地文件，合并成一行芯片
                var refHost = document.getElementById('wr-step-ref-line');
                if (refHost) {
                    var libIds = (window._wrSelectedMaterialIds || []).filter(Boolean);
                    var libMats = (window._wrAllMats || []);
                    var html = libIds.map(function(id) {
                        var m = libMats.filter(function(x) { return x.id === id; })[0];
                        var title = m ? (m.title || m.fileName) : ('资料 #' + id);
                        return '<span class="wr-step-chip is-lib" style="' + libChipCss + '">📁 ' + wrEsc(title)
                            + '<button type="button" style="' + xCss + '" data-k="lib-ref" data-i="' + id + '">×</button></span>';
                    }).join('');
                    var up = window._wrUploadedFiles || [];
                    html += up.map(function(f, i) {
                        if (!f) return '';
                        return '<span class="wr-step-chip is-local" style="' + chipCss + '">💻 ' + wrEsc(f.name)
                            + '<button type="button" style="' + xCss + '" data-k="local-ref" data-i="' + i + '">×</button></span>';
                    }).join('');
                    refHost.innerHTML = html || '<span class="wr-step-empty" style="' + emptyCss + '">暂未选择 · 不使用资料（仅按写作需求 + 台账统计成文；选了资料则问题分类以资料为准）</span>';
                }

                // ③ 【2026-09-23】同步"将如何生成"说明（有/无模板 × 有/无资料 四种链路讲清楚）
                try { if (typeof window.wrStepUpdateHint === 'function') window.wrStepUpdateHint(); } catch (e) {}

                // 绑定 × 移除
                ['wr-step-tpl-line', 'wr-step-ref-line'].forEach(function(hostId) {
                    var host = document.getElementById(hostId);
                    if (!host) return;
                    Array.prototype.forEach.call(host.querySelectorAll('button[data-k]'), function(btn) {
                        btn.onclick = function() {
                            var k = btn.getAttribute('data-k'), i = btn.getAttribute('data-i');
                            if (k === 'tpl-clear') {
                                window._wrStepTplSel = null;
                            } else if (k === 'lib-ref') {
                                window._wrSelectedMaterialIds = (window._wrSelectedMaterialIds || []).filter(function(x) { return String(x) !== String(i); });
                            } else if (k === 'local-ref') {
                                var idx = parseInt(i, 10);
                                if (window._wrUploadedFiles && window._wrUploadedFiles[idx]) window._wrUploadedFiles[idx] = null;   // 置空：生成时会 filter(Boolean)
                            }
                            wrStepRenderChips();
                        };
                    });
                });
            }
            window.wrStepRenderChips = wrStepRenderChips;

            /**
             * 【2026-09-23】弹窗内的"将如何生成"说明（随选择实时更新）。
             *   规则（与「两步生成」开关文案一致）：
             *     · 有模板 + 有资料 + 两步开 → 先按资料归纳问题类型并归入模板骨架章节 → 再按章节成文；
             *       **问题分类以资料为准，模板只给骨架与写法**
             *     · 有模板 + 有资料 + 两步关 → 单步：模板骨架 + 资料要点一次成文
             *     · 有模板 + 无资料 → 按模板骨架逐节成文，事实来自台账统计
             *     · 无模板（"+ 有/无资料"）→ 按规范结构成文；**不使用模板时不做归类表那一步**
             */
            window.wrStepUpdateHint = function() {
                var host = document.getElementById('wr-step-hint');
                if (!host) return;
                var hasTpl = !!window._wrStepTplSel;
                var hasMat = ((window._wrSelectedMaterialIds || []).filter(Boolean).length > 0)
                    || ((window._wrUploadedFiles || []).filter(Boolean).length > 0);
                var twoStep = (typeof wrTwoStepEnabled === 'function') ? wrTwoStepEnabled() : true;
                var q = ((document.getElementById('wr-query-input') || {}).value || '').trim();
                var qShow = q.length > 40 ? q.slice(0, 40) + '…' : q;
                var lines = [];
                if (hasTpl && hasMat && twoStep) {
                    lines.push('🧭 <b>两步生成</b>：先按资料归纳问题类型并归入模板骨架章节 → 再按章节成文（<b>问题分类以资料为准，模板只给骨架与写法</b>）。');
                } else if (hasTpl && hasMat) {
                    lines.push('⚡ <b>单步生成</b>：按模板骨架 + 资料要点一次性成文（两步开关已关；<b>问题分类仍以资料为准</b>）。');
                } else if (hasTpl) {
                    lines.push('📋 <b>有模板、无资料</b>：按模板骨架逐节成文，数据与事实来自台账统计（不做资料归类那一步）。');
                } else if (hasMat) {
                    lines.push('⚠️ <b>未使用模板</b>：将按规范结构（总体情况 → 主要问题 → 原因分析 → 整改要求）成文，问题类型以<b>资料归纳</b>为准；若需固定章节与写法，请点「选择模板 ▾」。');
                } else {
                    lines.push('⚠️ <b>未使用模板、也未选资料</b>：将只按下面的「写作需求」+ 台账统计成文，结构与事实依据由模型自行组织。建议至少选一个 —— <b>模板给骨架与写法，资料给问题分类与事实</b>。');
                }
                if (qShow) lines.push('📝 本次写作需求：' + wrEsc(qShow));
                host.innerHTML = lines.map(function(t) { return '<div>' + t + '</div>'; }).join('');
            };

            window.wrConfirmSelection = function() {
                // 【二改】不再从下拉读值：模板来源＝弹窗里的"当前模板"状态（📄 资料库 or 💻 本地），
                //   参考资料＝状态里的资料库勾选（本地参考资料另存 _wrUploadedFiles，生成时走"上传文件"块）。
                var cur = window._wrStepTplSel;
                var selTpl = null;
                if (cur) {
                    var pool = (cur.src === 'local') ? (window._wrLocalTpls || []) : (window._wrAllTpls || []);
                    selTpl = pool.filter(function(t){ return String(t.id) === String(cur.id); })[0] || null;
                }
                window._wrSelectedTemplate = selTpl;
                window._wrSelectedMaterialIds = (window._wrSelectedMaterialIds || []).filter(Boolean);
                // 修复：确认选择后立即刷新预览区，使已选模板/资料即时显示，不再残留"尚未选择"
                var _q = (document.getElementById('wr-query-input') || {}).value || '';
                try { wrUpdateMaterialPreview(_q); } catch (e) { console.warn('刷新资料预览失败', e); }
                var modal = document.querySelector('.wr-step-modal');
                if (modal) modal.remove();
                // 跳转到写作面板并触发生成
                if (typeof window.dsSwitchSub === 'function') window.dsSwitchSub('writer');
                if (typeof wrInit === 'function') wrInit();
                // 延时确保面板渲染后再调用 wrGenerate
                setTimeout(function() { wrGenerate(); }, 100);
            };

            // ---- 统一导入入口（弹出类型选择弹窗）----
            window.wrMaterialImportUnified = function() {
                const modal = document.getElementById('wr-import-type-modal');
                if (modal) modal.style.display = 'flex';
            };

            // ---- 【v3.76】统一导入实现：资料中心导入 与 智能写作「本地文件」共用同一套解析 + 入库逻辑 ----
            //   为什么抽出来：用户要求"本地上传的资料要和资料中心导入的一样能存进资料库，文本解析要一致"。
            //   两条路若各写一份解析，日后必然出现"同一个文件两处解析结果不同"。此函数是唯一实现。
            //   files: File[]；matType: WR_MAT_TYPES 的 key（template/history/inspect/fault/dispatch/other）
            //   返回 { saved:[已入库记录(含 id)], errors:['文件名：原因'], processed, libFail }
            //   ⚠️ 解析分支与原「资料中心导入」逐字一致：JSON 备份拆分（materials/reports 分流）、
            //      docx→mammoth(htmlToTextPreserveTables)、xlsx→XLSX、pdf→pdf.js、.doc 提示、其它按文本兜底。
            window.wrImportFiles = async function(files, matType) {
                var saved = [], errors = [];
                files = Array.from(files || []);
                if (!files.length) return { saved: saved, errors: errors, processed: 0, libFail: false };
                // 确保数据库已打开（失败时用 libFail 让调用方统一按"中止 + 提示"处理，不留半成品/不吞异常）
                try {
                    await wrOpenDB();
                    console.log('[导入] 数据库已打开');
                } catch (dbErr) {
                    console.error('[导入] 数据库打开失败:', dbErr);
                    return { saved: saved, errors: ['数据库打开失败：' + (dbErr && dbErr.message ? dbErr.message : '未知错误')], processed: 0, libFail: true };
                }
                // 按需加载解析库（只在这批文件真的需要时才联网加载，失败则明确报错，不留半成品）
                var needXlsx = files.some(function(f) { return /\.(xlsx|xls)$/i.test(f.name); });
                var needDocx = files.some(function(f) { return /\.docx$/i.test(f.name); });
                if (needXlsx && !(await window.requireLib('src/js/vendor/xlsx.full.min.js', { feature: '资料导入', silent: true }))) {
                    return { saved: saved, errors: ['解析组件（Excel）未能联网加载，请联网后重试'], processed: 0, libFail: true };
                }
                if (needDocx && !(await window.requireLib('src/js/vendor/mammoth.browser.min.js', { feature: '资料导入', silent: true }))) {
                    return { saved: saved, errors: ['解析组件（Word）未能联网加载，请联网后重试'], processed: 0, libFail: true };
                }
                // 【2026-09-21】已入库的「文件名|大小」集合：同一份文件重复导入直接跳过
                //   （原来一律 append、id 自增 → 同一备份导两次就产生整批重复条目）
                var _existKeys = {};
                try {
                    var _exist = await wrDbGetAll(WR_MAT_STORE);
                    (_exist || []).forEach(function (m) { if (m && m.fileName) _existKeys[String(m.fileName) + '|' + (m.fileSize || 0)] = 1; });
                } catch (e) {}
                var skipped = [];
                for (const file of files) {
                    console.log('[导入] 开始处理文件:', file.name, '类型:', matType);
                    try {
                        // JSON 备份可能含增量记录，不参与"同名跳过"；普通文档按 文件名+大小 去重
                        if (!/\.json$/i.test(file.name)) {
                            var _fk = String(file.name) + '|' + (file.size || 0);
                            if (_existKeys[_fk]) { skipped.push(file.name); continue; }
                            _existKeys[_fk] = 1;
                        }
                        const item = {
                            matType: matType,
                            fileName: file.name,
                            title: file.name.replace(/\.[^.]+$/, ''), // 去掉扩展名作为标题
                            fileSize: file.size,
                            importAt: Date.now(),
                            content: '',
                            rawText: ''
                        };
                        await wrParseIntoItem(item, file, matType);   // ← 解析（与资料中心完全同一套）
                        if (item.__jsonSplit) continue;   // JSON 备份：内容已按记录拆分入库，不再存"文件级"记录
                        console.log('[导入] 准备保存到数据库:', item.title);
                        const savedId = await wrDbPut(WR_MAT_STORE, item);
                        console.log('[导入] 保存成功, ID:', savedId);
                        item.id = savedId;
                        saved.push(item);
                    } catch (err) {
                        console.error('导入失败：' + file.name, err);
                        errors.push(file.name + ': ' + (err.message || '未知错误'));
                    }
                }
                // 【2026-09-21】入库后立即失效检索索引：knowledge.js 的 materials/reports 是**异步源**，
                //   其列表被缓存，原来导完资料不改索引 → 新资料可能检索不到（智能写作/智能体都用不上）
                try { if (typeof window.dsInvalidateRagCache === 'function') window.dsInvalidateRagCache('materials'); } catch (e) {}
                return { saved: saved, errors: errors, processed: files.length, libFail: false, skipped: skipped };
            };

            // 单文件解析 → 填充 item（原「资料中心导入」的解析主体，逐字搬移，勿改语义）
            async function wrParseIntoItem(item, file, matType) {
                {
                    // 根据文件类型解析内容
                    if (file.name.endsWith('.json')) {
                        const text = await file.text();
                        try {
                            const data = JSON.parse(text);
                            // 检测是否为导出备份格式（含 materials / reports 数组）
                            let jsonItems = null;
                            let jsonReports = null;
                            if (data.materials && Array.isArray(data.materials)) jsonItems = data.materials;
                            if (data.reports && Array.isArray(data.reports)) jsonReports = data.reports;
                            if (!jsonItems && Array.isArray(data)) jsonItems = data;
                            if (jsonItems && jsonItems.length > 0) {
                                console.log('[导入] JSON检测到' + jsonItems.length + '条资料记录，拆分存储');
                                // 【2026-09-21】批量单事务写入（原来逐条 await wrDbPut）
                                const _matBatch = jsonItems.map(function(ji, _ix) {
                                    const jiTitle = ji.title || ji.name || ji.fileName || file.name + '_' + _ix;
                                    const jiContent = ji.content || '';
                                    return {
                                        matType:   ji.matType || ji.type || matType, // 优先用自带分类，否则用用户选的
                                        fileName:  ji.fileName || file.name,
                                        title:     String(jiTitle).slice(0, 200),
                                        fileSize:  ji.fileSize || file.size,
                                        importAt:  ji.importAt || Date.now(),
                                        content:   String(jiContent).slice(0, 20000),
                                        sheets:    ji.sheets || null,
                                        rowCount:  ji.rowCount || null,
                                        rawText:   String(jiContent).slice(0, 5000)
                                    };
                                });
                                await wrDbPutMany(WR_MAT_STORE, _matBatch);
                            }
                            // 同时导入历史报告
                            if (jsonReports && jsonReports.length > 0) {
                                console.log('[导入] JSON检测到' + jsonReports.length + '篇历史报告，写入数据库');
                                // ⚠️ 字段名必须与 wrSaveReport 的 schema 对齐（query/date/category/source/templateId）；
                                //    也不能沿用备份里的 id（本机自增 id 命中即静默覆盖本地报告）。
                                let rptImported = 0;
                                const _rptBatch = [];   // 【2026-09-21】同上：批量单事务写入
                                for (const r of jsonReports) {
                                    if (!r || typeof r !== 'object') continue;
                                    _rptBatch.push({
                                        title:     r.title || '导入的报告',
                                        content:   r.content || '',
                                        query:     r.query || r.prompt || '',
                                        category:  r.category || 'other',
                                        date:      r.date || r.createdAt || Date.now(),
                                        templateId: r.templateId != null ? r.templateId : null,
                                        source:    r.source || 'import',
                                        materialCount: r.materialCount || { issues: 0, rules: 0, reports: 0 }
                                    });
                                    rptImported++;
                                }
                                await wrDbPutMany(WR_RPT_STORE, _rptBatch);
                                console.log('[导入] 历史报告已写入 ' + rptImported + ' 篇（不沿用备份 id，避免覆盖本机同 id 报告）');
                            }
                            if (jsonItems || jsonReports) {
                                // 备份文件：内容已按记录拆分入库，本条"文件级"记录不再单独存
                                item.__jsonSplit = true;
                                return;
                            }
                            // 非数组格式（单条JSON对象），作为整体存储
                            item.content = JSON.stringify(data);
                            item.rawText = typeof data === 'object' ? JSON.stringify(data, null, 2).slice(0, 5000) : String(data);
                        } catch (err) {
                            item.rawText = text.slice(0, 5000);
                            item.content = text;
                        }
                    } else if (file.name.endsWith('.txt') || file.name.endsWith('.md') || file.name.endsWith('.csv')) {
                        const text = await file.text();
                        item.rawText = text.slice(0, 10000);
                        item.content = text;
                    } else if (file.name.endsWith('.docx')) {
                        // 使用mammoth解析DOCX
                        if (typeof mammoth === 'undefined') {
                            console.warn('[导入] mammoth 库未加载，尝试直接读取文件信息');
                            item.rawText = '[DOCX文件 - 需要mammoth库解析内容]';
                            item.content = '[DOCX文件内容暂无法解析]';
                        } else {
                            try {
                                const arrayBuffer = await file.arrayBuffer();
                                const result = await mammoth.convertToHtml({ arrayBuffer: arrayBuffer });
                                const text = window._htmlToTextPreserveTables(result.value || '');
                                item.content = text;
                                item.rawText = text.slice(0, 10000);
                                // 如果是模板类型，保存原始 ArrayBuffer 用于后续 DOCX 导出
                                if (matType === 'template') item.templateBuffer = arrayBuffer;
                            } catch (err) {
                                console.error('[导入] DOCX解析失败:', err);
                                item.rawText = '[DOCX解析失败: ' + (err.message || '未知错误') + ']';
                                item.content = item.rawText;
                            }
                        }
                    } else if (file.name.endsWith('.xlsx') || file.name.endsWith('.xls')) {
                        // 使用xlsx解析Excel
                        if (typeof XLSX === 'undefined') {
                            console.warn('[导入] XLSX 库未加载，尝试直接读取文件信息');
                            item.rawText = '[Excel文件 - 需要XLSX库解析内容]';
                            item.content = '[Excel文件内容暂无法解析]';
                        } else {
                            try {
                                const arrayBuffer = await file.arrayBuffer();
                                const workbook = XLSX.read(arrayBuffer, { type: 'array' });
                                let allText = '';
                                const sheets = [];
                                workbook.SheetNames.forEach(sheetName => {
                                    const worksheet = workbook.Sheets[sheetName];
                                    const jsonData = XLSX.utils.sheet_to_json(worksheet, { header: 1 });
                                    sheets.push({ name: sheetName, rows: jsonData.length });
                                    allText += '【' + sheetName + '】\n';
                                    jsonData.slice(0, 50).forEach(row => {
                                        allText += row.join('\t') + '\n';
                                    });
                                    allText += '\n';
                                });
                                item.content = allText.slice(0, 20000);
                                item.rawText = allText.slice(0, 10000);
                                item.sheets = JSON.stringify(sheets);
                                item.rowCount = sheets.reduce((sum, s) => sum + s.rows, 0);
                            } catch (err) {
                                console.error('[导入] Excel解析失败:', err);
                                item.rawText = '[Excel解析失败: ' + (err.message || '未知错误') + ']';
                                item.content = item.rawText;
                            }
                        }
                    } else if (file.name.endsWith('.pdf')) {
                        // 使用 pdf.js 提取 PDF 文字内容
                        if (typeof pdfjsLib === 'undefined') {
                            console.warn('[导入] pdf.js 库未加载');
                            item.rawText = '[PDF文件 - 需要 pdf.js 库解析内容]';
                            item.content = '[PDF文件内容暂无法解析]';
                        } else {
                            try {
                                const arrayBuffer = await file.arrayBuffer();
                                const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
                                let fullText = '';
                                const maxPages = Math.min(pdf.numPages, 50);
                                for (let p = 1; p <= maxPages; p++) {
                                    const page = await pdf.getPage(p);
                                    const tc = await page.getTextContent();
                                    fullText += tc.items.map(it => it.str).join(' ') + '\n';
                                }
                                item.content = fullText.trim();
                                item.rawText = fullText.trim().slice(0, 10000);
                            } catch (err) {
                                console.error('[导入] PDF解析失败:', err);
                                item.rawText = '[PDF解析失败]';
                                item.content = item.rawText;
                            }
                        }
                    } else if (file.name.endsWith('.doc') && !file.name.endsWith('.docx')) {
                        item.content = '[暂不支持 .doc 格式（旧版Word二进制格式）。请将文件另存为 .docx 格式后重新导入。]';
                        item.rawText = '[不支持的文档格式: .doc，请转换为 .docx]';
                    } else {
                        // 其他类型，尝试读取为文本
                        try {
                            const text = await file.text();
                            item.rawText = text.slice(0, 5000);
                            item.content = text;
                        } catch (err) {
                            item.rawText = '[' + file.name + '] 文件内容无法读取';
                            item.content = item.rawText;
                        }
                    }
                }
            }

            // ---- 按类型导入文件 ----
            window.wrImportWithType = async function(matType) {
                // 关闭类型选择弹窗
                const modal = document.getElementById('wr-import-type-modal');
                if (modal) modal.style.display = 'none';

                // 创建文件选择input
                const fileInput = document.createElement('input');
                fileInput.type = 'file';
                fileInput.accept = '.docx,.pdf,.xlsx,.xls,.json,.txt,.md,.csv';
                fileInput.multiple = true;
                fileInput.style.display = 'none';
                
                fileInput.onchange = async function(e) {
                    const files = Array.from(e.target.files);
                    if (!files.length) {
                        alert('未选择任何文件');
                        fileInput.remove();
                        return;
                    }
                    
                    // 显示导入中提示
                    const loadingToast = document.createElement('div');
                    loadingToast.style.cssText = 'position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);background:rgba(0,0,0,0.8);color:white;padding:20px 30px;border-radius:10px;z-index:9999;font-size:14px;';
                    loadingToast.innerHTML = '<div style="text-align:center;"><div style="margin-bottom:10px;">⏳ 正在导入文件...</div><div style="font-size:12px;opacity:0.8;">请稍候</div></div>';
                    document.body.appendChild(loadingToast);
                    
                    // 【v3.76 统一导入】与「智能写作 · 本地文件」共用同一条链路：
                    //   同一套解析（wrParseIntoItem） + 同一张 writing_materials 表，两条路结果必然一致。
                    const _imp = await window.wrImportFiles(files, matType);
                    const successCount = _imp.saved.length;
                    const errorMessages = _imp.errors.slice();
                    if (_imp.libFail) {
                        loadingToast.remove();
                        fileInput.remove();
                        window.showToast(errorMessages[0] || '解析组件加载失败', true, 8000);
                        return;
                    }
                    // 移除加载提示
                    loadingToast.remove();
                    
                    // 刷新资料列表
                    console.log('[导入] 开始刷新资料列表...');
                    try {
                        // 强制切换到资料管理标签页以显示新导入的文件
                        const materialsPanel = document.getElementById('wr-panel-materials');
                        if (materialsPanel && materialsPanel.style.display !== 'none') {
                            // 已经在资料管理页面，直接刷新
                            await wrRenderMaterials();
                            console.log('[导入] 资料列表已刷新');
                        } else {
                            console.log('[导入] 当前不在资料管理页面，跳过刷新UI');
                        }
                        
                        // 验证数据是否已保存
                        const allMats = await wrDbGetAll(WR_MAT_STORE);
                        console.log('[导入] 数据库中共有资料:', allMats.length, '条');
                        if (allMats.length > 0) {
                            console.log('[导入] 最新一条:', allMats[allMats.length-1].title);
                        }
                    } catch(err) {
                        console.error('[导入] 刷新资料列表失败:', err);
                    }
                    
                    const typeLabel = wrCatName(matType);
                    const tip = matType === 'history'
                        ? '\n\n💡 历史报告已导入，您可以在资料管理中选中它并点击"设为模板"来创建自定义模板。'
                        : '';
                    
                    let msg = '✅ 已成功导入 ' + successCount + '/' + files.length + ' 个文件到「' + typeLabel + '」分类。';
                    if (_imp.skipped && _imp.skipped.length) msg += '（跳过同名重复 ' + _imp.skipped.length + ' 个）';
                    if (errorMessages.length > 0) {
                        msg += '\n\n❌ 导入失败 ' + errorMessages.length + ' 个：\n' + errorMessages.join('\n');
                    }
                    if (tip) msg += '\n' + tip;
                    // 【2026-09-21】结果提示从阻塞 alert 改为 toast（失败清单仍完整展示，并用错误色 + 延长显示）
                    if (window.showToast) window.showToast(msg, errorMessages.length > 0, errorMessages.length > 0 ? 12000 : 7000);
                    else alert(msg);
                    
                    fileInput.remove();
                };
                
                // 处理用户取消选择文件的情况
                fileInput.addEventListener('cancel', function() {
                    console.log('用户取消了文件选择');
                    fileInput.remove();
                });
                
                document.body.appendChild(fileInput);
                
                // 【2026-09-21】改为**同步** click：iOS Safari 与部分国产浏览器要求 file input 的 click()
                //   处于用户手势调用栈内，延时 100ms 后手势失效 → **文件选择器根本不弹**且无任何提示
                //   （对比备份恢复 / 日志导入，它们都是同步 click）。
                fileInput.click();
            };

            /**
             * 【2026-09-21 修复】「历史报告 → 导入」写对库（WR_RPT_STORE）。
             *   原先设置里该按钮调 wrImportWithType('history')，而它最终把**文档**存进
             *   writing_materials(matType=history)；可同一行的计数（getWrRptCount）、导出
             *   （wrExportAllReports）、清空（wrClearAllReports）以及资料中心「历史报告」标签
             *   读的都是 writing_reports → 导入 docx/pdf 后"条数不变、标签里找不到、导出为空"。
             *   现在：文档解析后按**报告 schema** 落 writing_reports；JSON 备份仍走原有分流。
             */
            window.wrImportReports = async function() {
                const picker = document.createElement('input');
                picker.type = 'file';
                picker.accept = '.docx,.pdf,.xlsx,.xls,.txt,.md,.csv,.json';
                picker.multiple = true;
                picker.style.display = 'none';
                picker.onchange = async function(e) {
                    const files = Array.from(e.target.files || []);
                    if (!files.length) { picker.remove(); return; }
                    const tip = document.createElement('div');
                    tip.style.cssText = 'position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);background:rgba(0,0,0,0.8);color:#fff;padding:18px 26px;border-radius:10px;z-index:11500;font-size:14px;';
                    tip.textContent = '⏳ 正在导入历史报告…';
                    document.body.appendChild(tip);
                    let ok = 0; const fails = [];
                    try {
                        await wrOpenDB();
                        const needXlsx = files.some(f => /\.(xlsx|xls)$/i.test(f.name));
                        const needDocx = files.some(f => /\.docx$/i.test(f.name));
                        if (needXlsx && !(await window.requireLib('src/js/vendor/xlsx.full.min.js', { feature: '报告导入', silent: true }))) throw new Error('解析组件（Excel）未能联网加载，请联网后重试');
                        if (needDocx && !(await window.requireLib('src/js/vendor/mammoth.browser.min.js', { feature: '报告导入', silent: true }))) throw new Error('解析组件（Word）未能联网加载，请联网后重试');
                        for (const file of files) {
                            try {
                                const item = { matType: 'history', fileName: file.name, title: file.name.replace(/\.[^.]+$/, ''), fileSize: file.size, importAt: Date.now(), content: '', rawText: '' };
                                await wrParseIntoItem(item, file, 'history');
                                if (item.__jsonSplit) { ok++; continue; }   // JSON 备份：已按记录拆分入库（含报告分流）
                                const body = String(item.content || item.rawText || '').trim();
                                if (!body) { fails.push(file.name + '：未解析出正文'); continue; }
                                await wrDbPut(WR_RPT_STORE, {
                                    title: String(item.title || '导入的报告').slice(0, 200),
                                    content: body.slice(0, 60000),
                                    query: '',
                                    category: 'other',
                                    date: Date.now(),
                                    templateId: null,
                                    source: '导入'
                                });
                                ok++;
                            } catch (err) { fails.push(file.name + '：' + ((err && err.message) || '未知错误')); }
                        }
                    } catch (e) {
                        tip.remove(); picker.remove();
                        if (window.showToast) window.showToast('导入失败：' + ((e && e.message) || '未知错误'), true, 8000);
                        else alert('导入失败：' + ((e && e.message) || '未知错误'));
                        return;
                    }
                    tip.remove(); picker.remove();
                    try { if (typeof window.dsInvalidateRagCache === 'function') window.dsInvalidateRagCache('reports'); } catch (e) {}
                    try { if (typeof window.wrRenderHistory === 'function') await window.wrRenderHistory(); } catch (e) {}
                    try { if (typeof window.updateDataManagementStats === 'function') window.updateDataManagementStats(); } catch (e) {}
                    const msg = '✅ 已导入历史报告 ' + ok + '/' + files.length + ' 个'
                        + (fails.length ? '；失败 ' + fails.length + ' 个：' + fails.join('；') : '')
                        + (ok ? '（可在「资料中心 → 历史报告」查看）' : '');
                    if (window.showToast) window.showToast(msg, fails.length > 0, 9000); else alert(msg);
                };
                picker.addEventListener('cancel', function() { picker.remove(); });
                document.body.appendChild(picker);
                picker.click();   // 同步 click：延时会让 iOS/国产浏览器丢失用户手势（选择器不弹）
            };



            // ================================================================
            // ── 资料检索核心逻辑 ──
            // ================================================================

            /**
             * 解析用户查询：提取报告类型、日期范围、关键词
             */
            function wrParseQuery(query) {
                const result = { reportType: 'custom', dateRange: null, dateLabel: '', keywords: [], rawQuery: query };

                // 识别报告类型
                if (/月度|月报|月份|每月/.test(query)) result.reportType = 'monthly';
                else if (/事故|事件|原因|分析/.test(query)) result.reportType = 'accident';
                else if (/整改|通知|整改书/.test(query)) result.reportType = 'rectify';
                else if (/年度|全年|年报|年终/.test(query)) result.reportType = 'summary';
                else if (/检查|巡查|督查|抽查/.test(query)) result.reportType = 'check';

                // 提取年月
                const yearMonthM = query.match(/(\d{4})\s*年\s*(\d{1,2})\s*月/);
                const yearM      = query.match(/(\d{4})\s*年/);
                const monthM     = query.match(/(\d{1,2})\s*月/);
                if (yearMonthM) {
                    const y = parseInt(yearMonthM[1]), mo = parseInt(yearMonthM[2]);
                    result.dateRange = {
                        start: new Date(y, mo-1, 1).getTime(),
                        end:   new Date(y, mo, 0, 23, 59, 59).getTime()
                    };
                    result.dateLabel = y + '年' + mo + '月';
                } else if (yearM) {
                    const y = parseInt(yearM[1]);
                    result.dateRange = { start: new Date(y, 0, 1).getTime(), end: new Date(y, 11, 31, 23, 59, 59).getTime() };
                    result.dateLabel = y + '年';
                } else if (monthM) {
                    const now = new Date(), y = now.getFullYear(), mo = parseInt(monthM[1]);
                    result.dateRange = {
                        start: new Date(y, mo-1, 1).getTime(),
                        end:   new Date(y, mo, 0, 23, 59, 59).getTime()
                    };
                    result.dateLabel = mo + '月';
                }

                // 提取关键词（去停用词）
                // 【P1-5 匹配修复 2026-09-18】原先只按空格/标点切分：用户连着写
                //   「写一份2026年3月安全检查月度报告」时整句成了**一个关键词**，于是
                //   模板 includes 匹配必然落空（兜底成"最近更新的一条"）、规章候选与台账候选被清零。
                //   现在改为「日期 → 业务词典（长词优先）→ 残余片段」三级抽取。
                result.keywords = wrExtractKeywords(query);

                return result;
            }

            // ---- 关键词抽取（P1-5）：日期 + 业务词典长词优先 + 残余片段兜底 ----
            var WR_KW_DICT = [
                // 长词在前：命中即整体保留并从待处理串中剔除，避免被拆成"安全"+"检查"这类碎片
                '安全检查报告','月度安全报告','月度报告','事故分析报告','事故调查报告','整改通知书','隐患整改',
                '年度总结','隐患排查','安全隐患排查','安全隐患','安全检查','安全问题','检查信息','检查台账',
                '典型问题','问题统计','问题分析','原因分析','整改要求','整改措施','防范措施','管控措施','设备故障',
                '作业标准','劳动安全','风险研判','规章制度','专业管理','应急','消防','调车','信号','施工','防洪','防断','防寒',
                '春运','暑运','接发列车','一线作业','现场检查'
            ];
            var WR_KW_STOP = /^(写|请|帮|我|要|做|生成|制作|一份|一个|关于|针对|包括|包含|以及|同时|和|与|的|给|把|按|根据|进行|一个|要求|内容|报告|文档)+$/;
            function wrExtractKeywords(query) {
                var q = String(query || '');
                var out = [], seen = {};
                function push(w) {
                    w = String(w || '').trim();
                    if (w.length < 2 || seen[w]) return;
                    seen[w] = 1; out.push(w);
                }
                // 1) 日期：2026年3月 → 同时给「2026年3月」「2026年」「3月」，让日期类关键词也能命中正文
                var ym = q.match(/(\d{4})\s*年\s*(\d{1,2})\s*月/);
                if (ym) { push(ym[1] + '年' + ym[2] + '月'); push(ym[1] + '年'); push(ym[2] + '月'); }
                else {
                    var y = q.match(/(\d{4})\s*年/); if (y) push(y[1] + '年');
                    var mo = q.match(/(\d{1,2})\s*月/); if (mo) push(mo[1] + '月');
                }
                // 2) 业务词典（长词优先，命中即从残余串中剔除）
                var rest = q;
                WR_KW_DICT.forEach(function (w) {
                    if (rest.indexOf(w) !== -1) { push(w); rest = rest.split(w).join(' '); }
                });
                // 3) 残余片段（去停用词与纯日期残渣）
                rest.replace(/[，。、！？；：（）""''《》【】\s]+/g, ' ').split(' ').forEach(function (seg) {
                    seg = seg.trim();
                    if (!seg || WR_KW_STOP.test(seg)) return;
                    if (/^\d{2,4}\s*年?(\s*\d{1,2}\s*月?)?$/.test(seg)) return;
                    if (seg.length >= 2 && seg.length <= 14) push(seg);
                });
                return out.slice(0, 14);
            }

            /**
             * 从 IndexedDB 读取检查信息（通过 dbManager 共享连接）
             * 不再独立 open RailwayIssueDB_v2，直接复用 issue.js 已建立的连接
             */
            async function wrLoadIssuesFromDB() {
                try {
                    var db = await window.dbManager.getDB('RailwayIssueDB_v2');
                    return new Promise(function(resolve) {
                        const tx = db.transaction(['issues'], 'readonly');
                        const store = tx.objectStore('issues');
                        const getAll = store.getAll();
                        getAll.onsuccess = () => resolve(getAll.result || []);
                        getAll.onerror = () => resolve([]);
                    });
                } catch(err) {
                    console.warn('[writer] 获取 IssueDB 失败:', err);
                    return [];
                }
            }

            /**
             * 从 IndexedDB 读取规章制度（通过 dbManager 共享连接）
             * 不再独立 open RailwayRuleDB，直接复用 rule.js 已建立的连接
             */
            async function wrLoadRulesFromDB() {
                try {
                    var db = await window.dbManager.getDB('RailwayRuleDB');
                    return new Promise(function(resolve) {
                        const tx = db.transaction(['ruleCollection'], 'readonly');
                        const store = tx.objectStore('ruleCollection');
                        const getAll = store.getAll();
                        getAll.onsuccess = () => resolve(getAll.result || []);
                        getAll.onerror = () => resolve([]);
                    });
                } catch(err) {
                    console.warn('[writer] 获取 RuleDB 失败:', err);
                    return [];
                }
            }

            /**
             * 从检查信息（issue）中按日期和关键词检索
             */
            async function wrGetIssueData(parsedQuery) {
                // 优先尝试从 window.getIssueData 获取（如果已加载）
                let issues = typeof window.getIssueData === 'function' ? window.getIssueData() : [];
                // 如果为空，直接从 IndexedDB 读取
                if (!issues.length) {
                    issues = await wrLoadIssuesFromDB();
                }
                if (!issues.length) return [];
                let filtered = issues;

                // 日期过滤（检查issue有date字段或可从content中推断）
                // 【P0-1 修复 2026-09-18】原实现：日期筛完**又用关键词筛一遍**，而关键词是
                //   「安全检查」「月度报告」这类整串词，台账正文（"3月第5号：调车作业发现问题"）根本不含，
                //   于是 filtered 被清零 → stats=null → 提示词写「暂无匹配台账数据」，
                //   而同一份提示词里模板占位符却已被另一条路径填上真实数字（自相矛盾，实测 5/5 场景复现）。
                //   现在：**日期命中即以日期为准**，关键词只用于"排序/优先后取"，绝不把结果清零。
                var dateHit = false;
                if (parsedQuery.dateRange) {
                    const { start, end } = parsedQuery.dateRange;
                    const byDate = filtered.filter(iss => {
                        if (iss.datetime || iss.date) {
                            const ts = new Date(iss.datetime || iss.date).getTime();
                            if (!isNaN(ts)) return ts >= start && ts <= end;
                        }
                        // 从content中提取日期
                        const m = (iss.content||'').match(/(\d{4})[年/\-](\d{1,2})[月/\-](\d{1,2})/);
                        if (m) {
                            const ts2 = new Date(parseInt(m[1]), parseInt(m[2])-1, parseInt(m[3])).getTime();
                            return ts2 >= start && ts2 <= end;
                        }
                        return false;
                    });
                    if (byDate.length) { filtered = byDate; dateHit = true; }
                }

                // 关键词只用于排序（相关度高的排前面，供"典型问题"取前 N 条），不再做过滤
                if (parsedQuery.keywords.length > 0 && filtered.length > 1) {
                    const kws = parsedQuery.keywords.map(k => k.toLowerCase());
                    const scored = filtered.map(iss => {
                        const text = ((iss.content||'')+(iss.category||'')+(iss['性质']||'')+(iss.unit||'')).toLowerCase();
                        let score = 0;
                        for (var i = 0; i < kws.length; i++) { if (text.indexOf(kws[i]) !== -1) score++; }
                        return { iss: iss, score: score, ts: Date.parse(iss.datetime || iss.date || '') || 0 };
                    });
                    // 有相关度命中 → 相关度优先、同分按时间倒序；零命中且非日期命中 → 按时间倒序
                    scored.sort(function (a, b) { return (b.score - a.score) || (b.ts - a.ts); });
                    filtered = scored.map(x => x.iss);
                    if (!dateHit && parsedQuery.keywords.length) {
                        // 既无日期也无相关度 → 仍返回（调用方按总量判断），仅在日志里留痕便于排查
                        if (typeof console !== 'undefined' && !scored.some(x => x.score > 0)) {
                            console.log('[writer] 台账按关键词零命中，已回退为全量/日期结果（不再清零）');
                        }
                    }
                }

                // ⚠️ 不再 slice(0,50)：统计口径必须是**全量**（典型问题由调用方取前 5 条）。
                //    原先截 50 会让提示词里的"问题总数"与模板占位符数字不一致。
                return filtered;
            }

            /**
             * 汇总所有可用模板：合并「资料库模板型资料」(WR_MAT_STORE, matType='template')
             * 与「模板设置」自定义模板 (WR_TPL_STORE)，统一用于写作流程。
             * 每条模板带 _src 标记（'mat' 或 'tpl'），便于下拉/检索后定位原始来源。
             */
            async function wrGetAllTemplates() {
                let matTpls = [], tplTpls = [];
                try {
                    const allMats = await wrDbGetAll(WR_MAT_STORE);
                    matTpls = allMats.filter(m => m.matType === 'template').map(t => Object.assign({}, t, { _src: 'mat' }));
                } catch (e) { matTpls = []; }
                try {
                    const store = await wrDbGetAll(WR_TPL_STORE);
                    tplTpls = store.map(t => Object.assign({}, t, { _src: 'tpl', matType: 'template' }));
                } catch (e) { tplTpls = []; }
                return matTpls.concat(tplTpls);
            }

            /**
             * 检索最相关的模板（合并 资料库模板 + 模板设置 两套来源）
             */
            async function wrGetTemplate(parsedQuery) {
                const templates = await wrGetAllTemplates();
                if (!templates.length) return null;
                const rt = parsedQuery.reportType;
                // 关键词匹配 + 报告类型加权（【P1-6】类型一致比"碰巧含某个词"更能代表同一类文种）
                if (parsedQuery.keywords.length > 0 || (rt && rt !== 'custom')) {
                    const scored = templates.map(t => {
                        const text = ((t.title||'') + (t.content||'').slice(0, 2000)).toLowerCase();
                        let score = parsedQuery.keywords.reduce((s,k) => s + (text.includes(k.toLowerCase()) ? 1 : 0), 0);
                        if (rt && rt !== 'custom') {
                            if (t.category === rt) score += 5;
                            else if (t.category && t.category !== rt) score -= 2;   // 别的文种（如事故调查）不该抢月度报告
                        }
                        return { t: t, score: score };
                    }).filter(x => x.score > 0).sort((a,b) => b.score - a.score);
                    if (scored.length) return scored[0].t;
                }
                // 兜底：优先同文种（类型一致）里最近更新的一条；再无则最近更新的一条
                const sorted = templates.slice().sort((a,b) => (b.importAt || b.updatedAt || b.createdAt || 0) - (a.importAt || a.updatedAt || a.createdAt || 0));
                if (rt && rt !== 'custom') {
                    const sameType = sorted.filter(t => t.category === rt);
                    if (sameType.length) return sameType[0];
                }
                return sorted[0];
            }

            /**
             * 检索相似历史报告（作为Few-shot参考）
             */
            async function wrGetSimilarReports(parsedQuery, limit) {
                limit = limit || 2;
                const reports = await wrDbGetAll(WR_RPT_STORE);
                if (!reports.length) return [];
                // 按类型+关键词打分
                const scored = reports.map(r => {
                    let score = (r.category === parsedQuery.reportType) ? 3 : 0;
                    const text = ((r.title||'')+(r.content||'').slice(0, 4000)).toLowerCase();   // P1-9：原 500 字太窄
                    score += parsedQuery.keywords.reduce((s,k) => s + (text.includes(k.toLowerCase()) ? 1 : 0), 0);
                    return { r, score };
                }).sort((a,b) => b.score - a.score || b.r.date - a.r.date);
                return scored.slice(0, limit).map(x => x.r);
            }

            /**
             * 从规章库中检索相关条款
             */
            async function wrGetRuleCandidates(parsedQuery) {
                // 优先尝试从 window.getRulesData 获取（如果已加载）
                let rules = typeof window.getRulesData === 'function' ? window.getRulesData() : [];
                // 如果为空，直接从 IndexedDB 读取
                if (!rules.length) {
                    rules = await wrLoadRulesFromDB();
                }
                if (!rules.length) return [];
                const kws = parsedQuery.keywords;
                if (!kws.length) return rules.slice(0, 5);
                const scored = rules.map(r => {
                    const text = ((r.title||'')+(r.content||'').slice(0, 1200)).toLowerCase();   // P1-9：原 300 字太窄
                    const score = kws.reduce((s,k) => s + (text.includes(k.toLowerCase()) ? 1 : 0), 0);
                    return { r, score };
                }).filter(x => x.score > 0).sort((a,b) => b.score - a.score);
                if (scored.length) return scored.slice(0, 8).map(x => x.r);
                // 【P0-3 修复 2026-09-18】关键词零命中时不再直接返回空 —— 否则报告永远没有"规章依据"
                //   （实测 5/5 场景【参考规章条款】块为空）。改为两级兜底：
                //   ① 2 字滑窗弱相关（处理"安全检查"这类整串词与条款正文用词不完全一致的情况）；
                //   ② 仍无命中则取前 5 条，作为"可引用范围"交给模型（提示词已声明"如需引用只用这些"）。
                const grams = wrBigrams(parsedQuery.rawQuery || '');
                if (grams.length) {
                    const weak = rules.map(r => {
                        const text = ((r.title||'')+(r.content||'').slice(0, 1200)).toLowerCase();
                        let s = 0;
                        for (let i = 0; i < grams.length; i++) { if (text.indexOf(grams[i]) !== -1) s++; }
                        return { r: r, s: s };
                    }).filter(x => x.s > 0).sort((a,b) => b.s - a.s);
                    if (weak.length) return weak.slice(0, 5).map(x => x.r);
                }
                return rules.slice(0, 5);
            }

            // 2 字滑窗（用于关键词全部落空时的"弱相关"兜底打分）
            function wrBigrams(text) {
                const s = String(text || '').replace(/[^\u4e00-\u9fa5A-Za-z0-9]+/g, '');
                const out = [], seen = {};
                for (let i = 0; i + 2 <= s.length && out.length < 80; i++) {
                    const g = s.slice(i, i + 2);
                    if (!seen[g]) { seen[g] = 1; out.push(g); }
                }
                return out;
            }

            /**
             * 汇总台账统计数据（用于填充占位符）
             */
            function wrSummarizeIssues(issues) {
                if (!issues.length) return null;
                const total = issues.length;
                const natCount = {};
                const catMap = { 'A': 0, 'B': 0, 'C': 0, '红线': 0, '其他': 0 };
                issues.forEach(iss => {
                    const n = iss['性质'] || iss.nature || '其他';
                    natCount[n] = (natCount[n] || 0) + 1;
                    // 归一桶（与 wrExtractStatsFromIssues / 风险研判同一套 includes 规则）
                    const xz = String(n).trim();
                    if (xz.includes('A')) catMap['A']++;
                    else if (xz.includes('B')) catMap['B']++;
                    else if (xz.includes('C')) catMap['C']++;
                    else if (xz.includes('红线')) catMap['红线']++;
                    else catMap['其他']++;
                });
                const natSummary = Object.entries(natCount).map(([k,v]) => k + v + '条').join('、');
                // 提取典型问题（取前5条）
                const typicals = issues.slice(0, 5).map((iss, i) =>
                    (i+1) + '. [' + (iss['性质']||'') + '][' + (iss.category||'') + '] ' + (iss.content||'').slice(0, 100)
                ).join('\n');
                return { total, natSummary, typicals, catMap };
            }

            /**
             * 统一统计口径（P0-4）：提示词里只允许出现**一套数字**。
             *   · 全量口径：wrSummarizeIssues（wrGetIssueData 已不再截断）
             *   · 与风险研判同口径：wrExtractStatsFromIssues（日期范围 + dsIssueFilter/dsIssueAggregate）
             *   两者日期边界一致，正常情况下 total 相同；不一致时以"与研判同口径"的值为准。
             */
            function wrUnifiedStats(parsed, issues) {
                const full = wrSummarizeIssues(issues || []);
                const real = wrExtractStatsFromIssues(parsed);
                if (!full && !real) return null;
                const total = real ? real.total : full.total;
                const catMap = (real && real.catMap) ? real.catMap : (full ? full.catMap : null);
                const typicals = (real && real.typicals) ? real.typicals : (full ? full.typicals : '');
                let natSummary = full ? full.natSummary : '';
                if (!natSummary && catMap) natSummary = 'A类' + catMap['A'] + '条、B类' + catMap['B'] + '条、C类' + catMap['C'] + '条、红线' + catMap['红线'] + '条';
                return { total: total, catMap: catMap, typicals: typicals, natSummary: natSummary, dateLabel: (parsed && parsed.dateLabel) || '' };
            }

            /**
             * 综合检索入口
             */
            async function wrRetrieveMaterials(query) {
                const parsed = wrParseQuery(query);
                const [template, similarReports, localMaterials, issues, ruleCandidates] = await Promise.all([
                    wrGetTemplate(parsed),
                    wrGetSimilarReports(parsed, 2),
                    wrGetLocalMaterials(parsed),
                    wrGetIssueData(parsed),
                    wrGetRuleCandidates(parsed)
                ]);
                const stats = wrUnifiedStats(parsed, issues);   // P0-4：提示词里只允许一套数字
                return { parsed, template, issues, stats, similarReports, ruleCandidates, localMaterials };
            }

            /**
             * 从资料库中检索相关资料（故障报告、文电、通报等）
             */
            async function wrGetLocalMaterials(parsedQuery) {
                const all = await wrDbGetAll(WR_MAT_STORE);
                if (!all.length) return [];
                const kws = parsedQuery.keywords;

                // 打分：关键词命中 + 日期范围匹配 + 类型优先级
                const scored = all.map(m => {
                    // 【P1-9】原实现只扫正文前 800 字 → 长资料后半段的关键词永远匹配不到
                    //   （"库里明明有、却检索不到/不入选"的隐性来源）。资料已在内存、数量有限，
                    //   这里放宽到 12000 字（覆盖绝大多数公文），扫描成本可忽略。
                    const text = ((m.title||'') + ' ' + String(m.content||'').slice(0, 12000)).toLowerCase();
                    let score = 0;
                    // 关键词命中（每个命中词+3分，提高权重）
                    if (kws.length > 0) {
                        score += kws.reduce((s,k) => s + (text.includes(k.toLowerCase()) ? 3 : 0), 0);
                    }
                    // 日期匹配
                    if (parsedQuery.dateRange) {
                        const { start, end } = parsedQuery.dateRange;
                        if (m.importAt >= start && m.importAt <= end) score += 3;
                        // 尝试从内容中提取日期
                        const dateM = String(m.content||'').match(/(\d{4})[年\/\-](\d{1,2})[月\/\-](\d{1,2})/);
                        if (dateM) {
                            const ts = new Date(parseInt(dateM[1]), parseInt(dateM[2])-1, parseInt(dateM[3])).getTime();
                            if (ts >= start && ts <= end) score += 3;
                        }
                    }
                    // 故障报告/统计/检查信息优先（这些类型包含结构化数据，对报告生成更有价值）
                    if (m.matType === 'fault' || m.matType === 'stats') score += 2;
                    return { m, score };
                });

                // 排序：高分在前
                scored.sort((a, b) => b.score - a.score);

                // 返回策略：
                // 1. 有关键词匹配(score>0)的资料，优先返回这些（强相关，噪声可控）
                // 2. 【修复 C1】无关键词匹配时，不再无脑返回全部资料（会引入无关案例噪声、跑题）。
                //    改为：仅返回与 parsed.reportType 强相关的资料类型，且数量收紧到 Top-4，
                //    并提示「仅供参考」，避免稀释主题。
                const hasMatches = scored.some(x => x.score > 0);
                let filtered;
                if (hasMatches) {
                    filtered = scored.filter(x => x.score > 0);
                } else {
                    // ⚠️ 原为 materials（本函数形参是 parsedQuery，作用域内无该变量）→
                    // 关键词一个都没命中时必然 ReferenceError，导致 wrRetrieveMaterials 整体 reject，
                    // 被 wrGenerate 静默降级为空资料（模板/台账/历史报告/规章全部丢失）。
                    const rt = (parsedQuery && parsedQuery.reportType) || '';
                    const relatedTypes = ({
                        monthly: ['stats', 'check', 'fault', 'inspect'],
                        check:   ['check', 'fault', 'stats', 'inspect'],
                        accident:['fault', 'stats', 'bulletin'],
                        rectify: ['check', 'fault', 'bulletin'],
                        summary: ['stats', 'check', 'fault'],
                        report:  ['report', 'stats', 'fault'],
                        inspect: ['inspect', 'check', 'stats'],
                        notice:  ['notice', 'check', 'fault']
                    })[rt] || ['stats', 'fault', 'check'];
                    filtered = scored.filter(x => relatedTypes.includes(x.m.matType));
                    if (filtered.length === 0) filtered = scored.slice(0, 4); // 兜底：仍无则取最新4条
                }

                // 返回Top-8，但每种类型至多3条（避免单一类型淹没，同时保证足够的数据量）
                const result = [];
                const typeCounts = {};
                for (const { m } of filtered) {
                    if (result.length >= 8) break;
                    const tc = typeCounts[m.matType] || 0;
                    if (tc >= 3) continue;
                    typeCounts[m.matType] = tc + 1;
                    result.push(m);
                }
                return result;
            }

            // ================================================================
            // ── Prompt 构造器 ──
            // ================================================================
            /**
             * 从检查信息台账中提取实际统计数据（防止AI编造数字）
             */
            function wrExtractStatsFromIssues(parsedQuery) {
                const issues = typeof window.getIssueData === 'function' ? window.getIssueData() : [];
                if (!issues.length || !parsedQuery.dateRange) return null;
                const { start, end } = parsedQuery.dateRange;
                // 【v3.76 口径统一】筛选/统计改用 utils.js 的共用实现（与风险研判同一口径，避免两处数字打架）：
                //   · 性质仍按 A/B/C/红线/其他 归类，且归一优先级与本文原实现完全一致 → 写作侧数字不变；
                //   · 日期边界改为本地日：原 `new Date('YYYY-MM-DD')` 是 UTC 零点（= 本地 08:00），
                //     会把起始日 00:00–08:00 的记录漏掉、又把结束日次日 00:00–08:00 的多算进来（本次修掉）；
                //   · 共用实现缺失（浏览器还跑着旧缓存脚本）时退回原实现，功能不受影响。
                const _shared = (typeof window.dsIssueFilter === 'function' && typeof window.dsIssueAggregate === 'function');
                let filtered, agg = null;
                if (_shared) {
                    filtered = window.dsIssueFilter(issues, { start: start, end: end });
                    agg = window.dsIssueAggregate(filtered, { topN: 5 });
                } else {
                    filtered = issues.filter(iss => {
                        if (!iss.datetime) return false;
                        const d = new Date(iss.datetime);
                        return d >= new Date(start) && d <= new Date(end);
                    });
                }
                if (filtered.length === 0) return null;
                const total = filtered.length;
                const catMap = { 'A': 0, 'B': 0, 'C': 0, '红线': 0, '其他': 0 };
                if (agg) {
                    Object.keys(catMap).forEach(k => { catMap[k] = agg.quality[k] || 0; });
                } else {
                    filtered.forEach(iss => {
                        const xz = (iss['性质'] || '').trim();
                        if (xz.includes('A')) catMap['A']++;
                        else if (xz.includes('B')) catMap['B']++;
                        else if (xz.includes('C')) catMap['C']++;
                        else if (xz.includes('红线')) catMap['红线']++;
                        else catMap['其他']++;
                    });
                }
                const typicals = agg ? agg.typicals.join('\n') : filtered.slice(0, 5).map((iss, idx) =>
                    (idx + 1) + '. [' + (iss['性质'] || '') + '][' + (iss.category || '') + '] ' + String(iss.content || '').slice(0, 100)
                ).join('\n');
                return { total, catMap, typicals, dateLabel: parsedQuery.dateLabel || '' };
            }

            // ================================================================
            // ── P1-6 / P1-7：模板章节结构 · 资料归类 · 产出校验（2026-09-18） ──
            // ================================================================
            /**
             * 「骨架类」章节判定（2026-09-18 用户口径）：
             *   用户明确：**以资料为主**，模板的"问题类型清单"不能硬套——
             *   资料归纳出 6 类问题、模板只列 4 类（且类型不同）时，必须按资料的 6 类写，否则就成了"硬板、脱离实际"。
             *   因此把模板章节分两层：
             *     · 骨架层（总体情况/主要问题/原因分析/整改要求/下步工作…）：文种架构，顺序与标题沿用模板；
             *     · 枚举层（问题类型、具体子项，如「（一）信号方面」「1. 调车问题」）：**以资料归纳的类型为准**，
             *       模板里的枚举项只作"层次与写法"的参照，数量/名称允许不同。
             *   这里的正则只认"通用文种骨架词"，认不出的（如「信号设备问题」）就归入枚举层，不做硬性校验。
             */
            var WR_SKELETON_RE = /(总体情况|基本情况|概况|主要问题|存在问题|问题分析|原因分析|原因|整改要求|整改措施|整改|措施|下步工作|下一步|工作安排|工作打算|总结|建议|防范措施|责任认定|事故经过|事故概况|概述|结语|附录|附件|情况报告|工作要点)/;
            function wrIsSkeletonLabel(label) {
                return WR_SKELETON_RE.test(String(label || ''));
            }
            /** 标签规范化：消除空白与顿号/点号差异，用于"章节标题是否一致"的比较 */
            function wrNormLabel(s) {
                return String(s || '')
                    .replace(/[\s、.．，,；;：:]/g, '')
                    .replace(/[（(]/g, '(').replace(/[）)]/g, ')')
                    .replace(/^#+/, '');
            }
            /** 去掉标题前的编号（一、／（一）／1.／##），得到"标题核心" */
            function wrLabelCore(label) {
                return wrNormLabel(String(label || '')
                    .replace(/^[#\s]*((?:[一二三四五六七八九十]+|[（(][一二三四五六七八九十\d]+[)）]|\d+)\s*[、.．)）]?)\s*/, ''));
            }
            /** 识别一行是否为章节标题 */
            function wrMatchHeading(t) {
                if (!t || t.length > 42) return null;
                if (/^#{1,6}\s*\S/.test(t)) return { level: (t.match(/^#+/) || ['#'])[0].length, label: t };
                if (/^[一二三四五六七八九十]+\s*[、.．]/.test(t)) return { level: 1, label: t.replace(/\s+/g, '') };
                if (/^第\s*[一二三四五六七八九十\d]+\s*[章节部]\s*[、.．:：]?\s*\S/.test(t)) return { level: 1, label: t.replace(/\s+/g, '') };
                if (/^[（(][一二三四五六七八九十]+[)）]/.test(t)) return { level: 2, label: t.replace(/\s+/g, '') };
                if (/^\d{1,2}\s*[、.．]/.test(t)) return { level: 3, label: t.replace(/\s+/g, '') };
                if (/^[（(]\d{1,2}[)）]/.test(t)) return { level: 4, label: t.replace(/\s+/g, '') };
                return null;
            }
            /**
             * 把模板正文解析成「章节树」：[{level,label,hint}]
             *   label = 该章节标题（编号+标题，原样保留）
             *   hint  = 该标题到下一个标题之间的模板正文（截 300 字），作为"这一节该写什么"的提示
             */
            function wrParseTemplateSections(text) {
                const out = [];
                const lines = String(text || '').split(/\r?\n/);
                let cur = null;
                for (let i = 0; i < lines.length; i++) {
                    const t = lines[i].trim();
                    const h = wrMatchHeading(t);
                    if (h) {
                        if (cur) out.push(cur);
                        cur = { level: h.level, label: h.label, hint: '' };
                    } else if (cur && t) {
                        if (cur.hint.length < 300) cur.hint += (cur.hint ? ' ' : '') + t;
                    }
                }
                if (cur) out.push(cur);
                return out;
            }
            /**
             * 产出校验（**只校验骨架层**）：
             *   用户口径："以资料为主"——资料归纳出的问题类型与模板枚举项不一致时**必须按资料走**，
             *   所以「（一）信号方面」这类枚举项不参与"齐全性"判定（否则 6 类 vs 4 类会被误判为缺章、
             *   触发无意义的补写，反而把资料内容硬塞进模板的旧分类里）。
             *   只校验骨架章节（总体情况/主要问题/原因分析/整改要求…）是否齐、顺序是否照旧。
             */
            function wrValidateSections(outputText, sections) {
                const normOut = wrNormLabel(outputText);
                const skel = (sections || []).filter(function (s) {
                    // 骨架层 = 一级标题且命中骨架词；二级子项一律视为"枚举项"，不校验
                    return s.level <= 1 && wrIsSkeletonLabel(s.label);
                });
                const missing = [];
                skel.forEach(function (s) {
                    const key = wrNormLabel(s.label);
                    const core = wrLabelCore(s.label);
                    const hit = (key && normOut.indexOf(key) !== -1) || (core && core.length >= 2 && normOut.indexOf(core) !== -1);
                    if (!hit) missing.push(s.label);
                });
                const enumerated = (sections || []).filter(function (s) { return !(s.level <= 1 && wrIsSkeletonLabel(s.label)); });
                return {
                    missing: missing,
                    total: skel.length,
                    found: skel.length - missing.length,
                    skelTotal: skel.length,
                    enumTotal: enumerated.length,      // 枚举层数量（仅供回执展示，不作硬校验）
                    scope: 'skeleton'
                };
            }
            /**
             * 数字溯源校验（P2，2026-09-18 用户确认）：报告里的数字逐个回到"本次实际提供的材料"里找出处。
             *   为什么需要：materials-first（有资料以资料为准）时不再用台账真值覆盖占位符，
             *   数字改由模型依据资料填写 —— 必须让"编造数字"可见（实测模型曾伪造"问题总数 9999"）。
             *   找不到出处 ≠ 一定错（也可能是合理的概括/换算），所以**只提示、不阻断保存**，写进产出回执。
             *   降噪规则：剔除引用标注与内部标记；先剥离日期/时间/条款号/序号（这些本来就不是统计数字）；
             *   只判定 ≥2 位的数字（1 位数在中文里处处可见，没有判别力）。
             */
            function wrCheckNumberProvenance(text, sources) {
                var t = String(text || '')
                    .replace(/【资料\s*\d+[^】]*】/g, ' ')
                    .replace(/【数据:[^】]*】/g, ' ')
                    .replace(/\d{4}\s*[-/年.]\s*\d{1,2}\s*[-/月.]\s*\d{1,2}\s*日?/g, ' ')   // 2026-03-05 / 2026年3月5日
                    .replace(/\d{4}\s*年\s*\d{1,2}\s*月/g, ' ')                              // 2026年3月
                    .replace(/\d{1,2}\s*[:：]\s*\d{1,2}/g, ' ')                              // 12:30
                    .replace(/第\s*\d+\s*[条章节号款项次]/g, ' ')                             // 第12条
                    .replace(/[（(]\s*\d+\s*[)）]/g, ' ')                                     // （1）
                    .replace(/^[ \t>*#-]*\d+\s*[、.．)）]/gm, ' ');                           // 行首 1. / - 1.
                var src = String(sources || '');
                var seen = {}, untraced = [], checked = 0;
                var re = /\d+(?:\.\d+)?/g, m;
                while ((m = re.exec(t)) !== null) {
                    var v = m[0];
                    if (v.replace(/[^\d]/g, '').length < 2) continue;                         // 1 位数不做判定
                    checked++;
                    if (src.indexOf(v) !== -1) continue;                                      // 材料里出现过 → 有出处
                    if (v.indexOf('.') !== -1 && src.indexOf(v.replace(/0+$/, '')) !== -1) continue;  // 3.50 → 3.5
                    if (!seen[v]) {
                        seen[v] = {
                            value: v, count: 0,
                            sample: t.slice(Math.max(0, m.index - 10), m.index + v.length + 6).replace(/\s+/g, ' ').trim()
                        };
                        untraced.push(seen[v]);
                    }
                    seen[v].count++;
                }
                untraced.sort(function (a, b) { return parseFloat(b.value) - parseFloat(a.value); });   // 大数优先看
                return { checked: checked, untraced: untraced };
            }
            /** 资料总预算（P1-8）：原来是"每份固定截 5000 字、份数不限"——少份时浪费、多份时爆炸，
             *  且长报告尾部（整改要求/结论）常被静默截掉。改为总额 ≈2.4 万字按份数分配（单份 2500–9000）。 */
            var WR_MAT_TOTAL_BUDGET = 24000;
            function wrMatPerBudget(n) {
                n = Math.max(1, n || 1);
                return Math.max(2500, Math.min(9000, Math.round(WR_MAT_TOTAL_BUDGET / n)));
            }
            // 两步生成开关（P1-7）：默认开（先出资料归类表 → 再按模板章节成文）。
            // 关掉即回到单步生成（少一次请求，适合网络差/资料少时）。
            function wrTwoStepEnabled() {
                try { return localStorage.getItem('wr_two_step') !== '0'; } catch (e) { return true; }
            }
            window.wrSetTwoStep = function (on) {
                try { localStorage.setItem('wr_two_step', on ? '1' : '0'); } catch (e) {}
                try { if (typeof window.wrStepUpdateHint === 'function') window.wrStepUpdateHint(); } catch (e) {}   // 【2026-09-23】切换后立刻更新"将如何生成"说明
            };
            function wrSyncTwoStepChk() {
                var chk = document.getElementById('wr-two-step-chk');
                if (chk) chk.checked = wrTwoStepEnabled();
            }
            window.wrSyncTwoStepChk = wrSyncTwoStepChk;
            if (typeof document !== 'undefined') {
                if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wrSyncTwoStepChk);
                else setTimeout(wrSyncTwoStepChk, 0);
            }
            /**
             * 归类表提示词（两步生成的第一步）：只做"资料 → 模板章节"的归类与要点提炼，不写正文。
             */
            function wrBuildPlanPrompt(query, sections, localMaterials, stats, opts) {
                opts = opts || {};
                const sys = [
                    '你是铁路安全监察领域的资料归纳与归类助手。任务分两步，只输出 JSON：',
                    '第一步【归纳】读完所有资料，把它们反映的问题归纳成若干类型。**这是报告正文的问题分类依据，务必以资料为准**：资料里有几类就归纳几类，不要受模板里已列类型的限制，也不要为了对齐模板而合并或拆分。',
                    '第二步【归类】把资料与归纳出的类型归到模板的**骨架章节**（如"总体情况/主要问题/原因分析/整改要求"）。模板里"（一）（二）"这类具体问题子项只作写法参照，不作为分类依据。',
                    '要求：',
                    '1. 只做归纳与归类，不写正文；要点必须来自资料或台账数据，不得编造。',
                    '2. sections 的 label 必须取自「模板骨架章节」清单；模板原有的问题分类不要出现在 sections 里。',
                    '3. 每份资料都要落到某个问题类型或骨架章节；确实无关的放进 unused。',
                    '4. 输出 JSON（不要代码块、不要解释）：{"problemTypes":[{"name":"信号设备类","section":"二、主要问题","materials":[1,3],"points":["3月信号机断丝故障2起","平均处理时长35分钟"]}],"sections":[{"label":"一、总体情况","uses":[1,2],"points":["要点"]}],"unused":[4]}'
                ].join('\n');
                const u = [];
                const skel = (sections || []).filter(function (s) { return s.level <= 1 && wrIsSkeletonLabel(s.label); });
                const enumS = (sections || []).filter(function (s) { return !(s.level <= 1 && wrIsSkeletonLabel(s.label)); });
                u.push('【模板骨架章节（sections.label 只能用这些）】');
                (skel.length ? skel : (sections || [])).forEach(function (s) {
                    u.push(s.label + (s.hint ? '：' + String(s.hint).slice(0, 100) : ''));
                });
                if (enumS.length) {
                    u.push('');
                    u.push('【模板中原有的问题分类（仅作写法与层次参照，**不是**分类依据）】');
                    u.push(enumS.map(function (s) { return s.label; }).join('、'));
                }
                u.push('');
                u.push('【用户需求】' + (query || ''));
                if (stats && stats.total && opts.ledgerAllowed !== false) {
                    u.push('');
                    u.push('【台账概况（仅供理解背景，不要写进归类结果）】共 ' + stats.total + ' 条' + (stats.dateLabel ? '（' + stats.dateLabel + '）' : ''));
                }
                u.push('');
                u.push('【资料清单（编号即引用号，正文将用【资料N】标注出处）】');
                (localMaterials || []).forEach(function (m, i) {
                    const label = (typeof WR_MAT_TYPES !== 'undefined' && WR_MAT_TYPES[m.matType]) ? WR_MAT_TYPES[m.matType].label : (m.matType || '资料');
                    const c = String(m.content || '');
                    u.push('资料' + (i + 1) + '【' + label + '】《' + (m.title || m.fileName) + '》');
                    u.push(c.slice(0, 900) + (c.length > 900 ? '…' : ''));
                    u.push('');
                });
                u.push('请输出 JSON：');
                return { sysPrompt: sys, userPrompt: u.join('\n') };
            }
            /** 解析归类表（容忍代码块/尾注；字段名做了兼容） */
            function wrParsePlan(text) {
                if (!text) return null;
                let obj = null;
                try { obj = wrParseMapping(text); } catch (e) {}
                if (!obj) { try { obj = _wrExtractJson(text); } catch (e) {} }
                if (!obj || !Array.isArray(obj.sections)) return null;
                const out = { sections: [], unused: [] };
                obj.sections.forEach(function (s) {
                    if (!s) return;
                    const label = String(s.label || s.title || '').trim();
                    if (!label) return;
                    const rawUses = Array.isArray(s.uses) ? s.uses : (Array.isArray(s.materials) ? s.materials : []);
                    const rawPts = Array.isArray(s.points) ? s.points : (Array.isArray(s.notes) ? s.notes : []);
                    out.sections.push({
                        label: label,
                        uses: rawUses.map(function (n) { return parseInt(n, 10); }).filter(function (n) { return n > 0; }),
                        points: rawPts.map(function (p) { return String(p == null ? '' : p); }).filter(Boolean)
                    });
                });
                const rawUnused = Array.isArray(obj.unused) ? obj.unused : [];
                out.unused = rawUnused.map(function (n) { return parseInt(n, 10); }).filter(function (n) { return n > 0; });
                // 资料归纳出的问题类型（"以资料为主"的分类依据）
                const rawTypes = Array.isArray(obj.problemTypes) ? obj.problemTypes : (Array.isArray(obj.types) ? obj.types : []);
                out.problemTypes = rawTypes.map(function (p) {
                    if (!p) return null;
                    const name = String(p.name || p.title || p.label || '').trim();
                    if (!name) return null;
                    const rawM = Array.isArray(p.materials) ? p.materials : (Array.isArray(p.uses) ? p.uses : []);
                    const rawP = Array.isArray(p.points) ? p.points : [];
                    return {
                        name: name,
                        section: String(p.section || '').trim(),
                        materials: rawM.map(function (n) { return parseInt(n, 10); }).filter(function (n) { return n > 0; }),
                        points: rawP.map(function (x) { return String(x == null ? '' : x); }).filter(Boolean)
                    };
                }).filter(Boolean);
                return (out.sections.length || out.problemTypes.length) ? out : null;
            }
            /**
             * 非流式一次性调用（归类表 / 补写章节共用）。失败返回 null，由调用方降级。
             */
            async function wrCallOnce(sysPrompt, userPrompt, opts) {
                // 【2026-09-18】实现上移为共享 `window.dsCallOnce`（写实"一键 AI 修改"等模块复用同一套
                //   Key/模型/超时/关思考逻辑，避免各处裸 fetch）。此处保留原签名与"失败返回 null"语义，
                //   调用方（归类表/补写章节）无需改动。
                if (typeof window.dsCallOnce !== 'function') {
                    console.warn('[writer] dsCallOnce 未加载（doubao-common.js），本次调用按失败处理');
                    return null;
                }
                const r = await window.dsCallOnce(sysPrompt, userPrompt, opts);
                if (!r || !r.ok) { console.warn('[writer] 一次性调用失败：', (r && r.error) || 'unknown'); return null; }
                return r.text || null;
            }
            /**
             * 补写缺失章节（P1-6）：只请求缺失的那几节，避免整篇重生成。
             */
            async function wrContinueMissingSections(missing, sections, ctx) {
                const miss = (sections || []).filter(function (s) { return missing.indexOf(s.label) !== -1; });
                if (!miss.length) return null;
                const sys = [
                    '你是铁路安全监察领域的专业智能写作。用户此前生成的一份报告缺失了模板中的若干章节，请只补写这些章节。',
                    '要求：',
                    '1. 只输出缺失章节的正文，每节以「编号+标题」开头（标题逐字照抄给定标题）；不要重复其它章节，不要写总结或说明。',
                    (window._wrModifyMode
                        ? '2. 数字与事实只能来自给定资料（底稿中已有的数字保留），新增资料在句末标注【补充资料N】。'
                        : '2. 数字只能使用给定的台账统计数据；资料事实必须来自给定资料，并在句末标注【资料N】。'),
                    '3. 资料原文要"再加工"：按本节该写的层次位置融入，转写为通顺、具体、逻辑合理、书面、不啰嗦的报告文体，不得整段照抄原文。',
                    '4. 体例、语气、详略与已生成正文保持一致，直接续写即可。'
                ].join('\n');
                const u = [];
                u.push('【用户需求】' + (ctx.query || ''));
                u.push('');
                if (ctx.statsLine) { u.push('【台账统计数据（必须照搬）】'); u.push(ctx.statsLine); u.push(''); }
                if (ctx.materialLines && ctx.materialLines.length) {
                    u.push('【本地资料（编号即引用号）】');
                    ctx.materialLines.forEach(function (l) { u.push(l); });
                    u.push('');
                }
                if (ctx.problemTypes && ctx.problemTypes.length) {
                    u.push('【问题分类（以资料为准，不要套用模板旧分类）】');
                    ctx.problemTypes.forEach(function (t, i) {
                        const ms = (t.materials || []);
                        u.push((i + 1) + '. ' + t.name + (ms.length ? '（资料' + ms.join('、') + '）' : ''));
                    });
                    u.push('');
                }
                u.push('【需补写的章节（按此顺序输出）】');
                miss.forEach(function (s) { u.push(s.label + (s.hint ? '：' + String(s.hint).slice(0, 150) : '')); });
                u.push('');
                u.push('【已生成正文（仅作上下文，勿重复输出）】');
                u.push(String(ctx.tailText || '').slice(-2500));
                u.push('');
                u.push('请开始补写：');
                const out = await wrCallOnce(sys, u.join('\n'), { maxTokens: 4000, temperature: 0.25, timeoutMs: 120000 });
                const txt = String(out || '').trim();
                if (!txt) return null;
                return txt.replace(/^```[a-zA-Z]*\s*/, '').replace(/```\s*$/, '');
            }

            function wrBuildPrompt(query, materials, uploadedContent) {
                const { parsed, template, issues, stats, similarReports, ruleCandidates, localMaterials } = materials;
                const today = new Date();
                const todayStr = today.getFullYear() + '年' + (today.getMonth()+1) + '月' + today.getDate() + '日';
                // P1-6：把模板解析成章节树（结构硬约束 + 每节提示），P1-7：归类表（两步生成第一步产物）
                const tplSections = template ? wrParseTemplateSections(template.content || '') : [];
                const plan = materials.plan || null;

                // 【数据来源优先级（2026-09-18 用户口径）】
                //   有资料 → **完全从资料走**：不注入「台账统计数据/典型问题」，报告事实与数量一律取自资料；
                //   没有资料（或资料与需求不相关）→ 才用台账，按写作要求的范围梳理总结；
                //   需求里明确提到"台账/检查信息/统计/条数"等 → 视为特殊说明，照常提供台账数据。
                const ledgerOff = (materials.ledgerAllowed === false);
                const dataSourceRule = (materials.ledgerReason === 'modify')
                    // 【补充/修改轮】用户口径（2026-09-18）：继续修改 = 补充；原模板/原资料都不需要，
                    //   只带「当前报告底稿 + 本轮新增资料 + 补充/修改要求」，把新内容按底稿对应位置再加工融入。
                    ? '0. 【任务性质：在既有报告上"补充/修改"，不是重写一篇】输入只有三样：①【当前报告（底稿）】②【新增资料】③【补充/修改要求】。'
                      + '要求：① 输出**完整报告全文**（不是只输出改动片段，也不要写"以下为修改部分""其余不变"这类说明）；'
                      + '② 骨架章节的编号、标题、顺序沿用底稿，已稳妥的段落保持原样，只做必要的增补与调整，不整篇重写、不改变体裁；'
                      + '③ 新增资料按【写作规范】4 的"归位 + 再加工"处理（按底稿对应章节/段落的层次位置融入，转写为报告文体：通顺/具体/逻辑合理/书面化/不啰嗦，**不得整段照抄原文，也不得另起一节堆砌**）—— 与"直接写"同一要求；'
                      + '④ 底稿中原有的【资料N】标注保留原样，本轮新增资料的引用标注用【补充资料N】。'
                    : (materials.ledgerReason === 'no-materials')
                    ? '0. 【数据来源】本次没有与需求相关的本地资料，请基于「台账统计数据」按写作要求的范围（时间/单位/专业）**梳理总结**后成文：先归纳问题类型与集中领域，再按模板骨架逐节展开；数量与占比必须与台账统计一致；下方若附有资料，仅作背景参考。'
                    : (ledgerOff
                        ? '0. 【数据来源】本次**以「本地资料」为唯一依据**（事实、案例、数量都取自资料）；不要引用台账统计口径，资料未给出的数字写（待补充），不得编造。'
                        : '0. 【数据来源】用户已明确要求使用台账数据：报告以资料为主体，台账统计数字可用于总体情况/数量表述（必须照搬台账数字），两者不得互相矛盾。');

                const sysLines = [
                    '你是铁路安全监察领域的专业智能写作。请根据用户提供的模板、台账数据、本地资料与历史报告，生成符合规范的铁路安监文档。',
                    '',
                    '【写作规范】',
                    dataSourceRule,
                    // 结构规则按轮次给（补充轮没有模板，结构以底稿为准，否则规则 1 会与之矛盾）
                    window._wrModifyMode
                        ? '1. 【结构分两层】① **骨架章节**沿用【当前报告（底稿）】：编号与标题照抄、顺序不变；② 章节内部的问题类型/子项以资料为准（资料几类就几类，不为凑数而合并、拆分或改名）。'
                        : '1. 【结构分两层】① **骨架章节**（总体情况/主要问题/原因分析/整改要求/下步工作 这类）沿用模板：编号与标题照抄、顺序不变；② 骨架章节**内部的问题类型/子项以资料为准** —— 资料归纳出几类就写几类，模板里原有的问题分类**只作写法与层次参照**，不得为了对齐模板而合并、拆分或改名（资料 6 类就写 6 类，不必凑模板的 4 类）。',
                    window._wrModifyMode
                        ? '2. 不得虚构数字或案例：底稿中已有的数字保留（用户在要求里明确要改的除外），新增资料中的数字照实引用，两者不得互相矛盾。'
                        // ⚠️ 必须随数据来源口径自适应：ledgerOff（有资料→完全从资料走）时**不能**再说"只能用台账统计数字"，
                        //    否则与规则 0「资料未给出的写（待补充）」直接打架，会把模型推回台账数字（用户明确反对）。
                        : (ledgerOff
                            ? '2. 数字只能来自「本地资料」：不得虚构数字或案例；凡涉及数量/占比/趋势，一律用资料中的原始数字；资料没给出的数量写（待补充），不要改用台账统计口径。'
                            : '2. 台账数据必须真实引用，不得虚构数字或案例；凡涉及数量/占比/趋势，只能用「台账统计数据」中的数字；如台账不足以支撑某章节，用[待补充]标记。'),
                    '3. 涉及规章时，只能引用"参考规章条款"中的规章，不得编造，引用时写明条款序号。',
                    // 【2026-09-18 用户口径】"再加工"是**直接写与继续写共同**的要求，故写在通用规范里（不在补充轮分支里）
                    '4. 【引用资料：先"归位"、再"再加工"（直接写与继续写要求完全相同）】资料中的事实与数据必须充分引用，不得忽略：'
                    + '① **归位**：常规生成按「模板章节结构」（有「资料归类表」就按表）、补充/修改按【当前报告（底稿）】的对应章节位置写入 —— 不得把资料堆到无关章节，也不得把资料另起一节堆砌；'
                    + '② **再加工**：资料原文多为口语、电报式短句或公文流水句，必须转写为报告文体 —— 语句更通顺（消灭生硬拼接、"的"字叠加与重复）、'
                    + '描述更具体（保留时间/地点/设备/数量/单位/责任主体等细节，不要泛化成"存在一些问题"）、'
                    + '逻辑更合理（按"现象→原因→隐患→整改要求/依据"展开，前后因果对得上）、'
                    + '语言更书面化、不啰嗦（同一事实只说一次，删除空话套话与"进一步/切实/狠抓"式无信息量堆叠）；'
                    + '③ **不得整段照抄资料原文**：连续 20 字以上与原文相同的片段必须改写（确需引用公文原话时加引号并注明出处）；'
                    + '④ 资料之间互相矛盾时以最新日期的为准并在正文中体现；资料没给出的数量不要猜，写（待补充）。',
                    '5. 引用资料事实时在句末标注来源编号：常规生成写【资料1】（同一句引用多份写【资料1、资料3】）；补充/修改轮的新增资料写【补充资料1】（底稿原有的【资料N】保持原样）。',
                    '6. 语言风格：严谨、规范、简洁、书面化，使用铁路安监专业术语；不用口语与网络语，不重复表述，删除没有信息量的套话（"高度重视""进一步加强"这类必须有具体措施才写）。',
                    '7. 今天日期：' + todayStr + '。',
                    '',
                ];

                // 根据是否有模板，修改输出要求
                if (template) {
                    const placeholders = extractPlaceholders(template.content || '');
                    if (placeholders.length > 0) {
                        sysLines.push('【任务要求】');
                        sysLines.push('请根据以下占位符列表，生成一个纯 JSON 对象（不要包裹在 ```json 代码块中），键为占位符名称（不含大括号），值为替换后的具体内容。');
                        sysLines.push('占位符列表：' + placeholders.join(', '));
                        sysLines.push('输出格式示例：{"问题总数":"12","A类数量":"3","典型问题列表":"1. 信号机故障\\n2. 轨道电路异常"}');
                        sysLines.push('重要：JSON 中的多行文本值必须使用 \\\\n 表示换行，不能包含实际换行符。整个 JSON 必须在一行或严格符合 JSON 语法。');
                        sysLines.push('只输出 JSON 对象，不要输出任何其他内容。');
                        sysLines.push('【重要】若用户需求中包含【上传的文件内容】或本地资料，请在映射值（尤其问题描述、典型案例、整改要求类字段）中充分引用其中的具体事实与数据，不得忽略或编造；并按【写作规范】4 再加工（转写为通顺、具体、书面、不啰嗦的报告文体，不得照抄原文）。');
                    } else {
                        sysLines.push('【输出要求】');
                        sysLines.push('- 直接输出最终文档内容，无需解释说明。');
                        sysLines.push('- 【硬约束】骨架章节必须齐全、顺序与标题沿用模板；其内部的问题类型按「资料归纳出的问题类型」写（模板原有分类只作写法参照）。');
                        sysLines.push('- 【关键】必须输出全部骨架章节，不得在中途停止或只输出部分内容。');
                        sysLines.push('- 若提供了「资料归类表」，必须按表把资料要点写入对应章节，不得把资料堆到无关章节；资料原文按【写作规范】4 再加工（不得整段照抄）。');
                        sysLines.push(ledgerOff ? '- 统计数字、日期等关键信息必须与资料一致；资料没给出的数量写（待补充）。' : '- 统计数字、日期等关键信息必须与台账数据一致。');
                        sysLines.push('- 【重要】报告中的问题描述、案例分析必须基于提供的本地资料，不得编造。');
                    }
                } else if (window._wrModifyMode) {
                    // 【补充/修改轮】结构沿用"底稿"（既不是"自行拟定"，也不是"模板骨架"）
                    sysLines.push('【输出要求】');
                    sysLines.push('- 输出**修改后的完整报告全文**（从第一行标题写到最后一节），不得只输出改动片段、不得输出"其余不变"之类说明。');
                    sysLines.push('- 章节编号、标题、顺序沿用底稿；已稳妥的段落保持原样，只做必要的增补与调整。');
                    sysLines.push('- 【关键】必须输出全部章节，不得在中途停止或只输出部分内容。');
                    sysLines.push('- 底稿中原有的【资料N】标注保留原样；本轮新增资料的引用标注用【补充资料N】。');
                } else {
                    sysLines.push('【输出要求】');
                    sysLines.push('- 直接输出最终文档内容，无需解释说明。');
                    sysLines.push('- 自行拟定合理的章节结构并一次性输出全部章节，不得中途停止。');
                    sysLines.push(ledgerOff ? '- 统计数字、日期等关键信息必须与资料一致；资料没给出的数量写（待补充）。' : '- 统计数字、日期等关键信息必须与台账数据一致。');
                    sysLines.push('- 【重要】报告中的问题描述、案例分析必须基于提供的本地资料，不得编造；引用资料处标注【资料N】；并按【写作规范】4 再加工（不得整段照抄原文）。');
                }

                // 【补充/修改轮（2026-09-18 用户口径）】"继续修改 = 补充"：
                //   系统只带三样 —— ① 当前报告底稿（结构与被采纳的内容都在里面，故**不再需要原模板/原资料**）；
                //   ② 用户本轮写下的补充/修改要求；③ 用户新勾选的资料（作为【新增资料】）。
                const userLines = window._wrModifyMode
                    ? ['【当前报告（底稿）—— 在此基础上补充/修改，输出时须完整带出全部章节】',
                       String(window._wrModifyBaseContent || ''),
                       '',
                       '【补充/修改要求】',
                       (query || '（未写文字要求：请仅把新增资料按底稿对应章节位置有机补充进去）'),
                       '']
                    : ['【用户需求】', query, ''];

                // 【修复 A2】上传文件内容独立成段，明确为"待引用素材"，提升 AI 引用率
                if (uploadedContent && uploadedContent.trim()) {
                    userLines.push('【上传的文件内容（重要素材，请在报告中充分引用其中的具体事实、数据、案例，不得忽略或编造）】');
                    userLines.push(uploadedContent.trim());
                    userLines.push('');
                }

                // 模板：① 章节结构（硬约束，来自解析，**不截断**）② 模板正文样例（仅供文风，可截断）
                if (template) {
                    const tplType = template.matType || template.category || 'template';
                    let tplContent = template.content || '';
                    // 占位符预填真实数字（防止 AI 编造）——统一取 stats（全量口径，与「台账统计数据」块同一套数字）
                    // ⚠️ 有资料时（ledgerOff）**不预填**：本次以资料为准，占位符交由模型依据资料填写，
                    //    资料没给出的写（待补充），避免报告里出现"资料 + 台账"两套来源的数字。
                    if (stats && !ledgerOff) {
                        const cm = stats.catMap || {};
                        const _n = function (v) { return (v === 0 || v) ? v : '—'; };
                        tplContent = tplContent
                            .replace(/{{问题总数}}/g, '【数据:' + _n(stats.total) + '】')
                            .replace(/{{A类数量}}/g,  '【数据:' + _n(cm['A']) + '】')
                            .replace(/{{B类数量}}/g,  '【数据:' + _n(cm['B']) + '】')
                            .replace(/{{C类数量}}/g,  '【数据:' + _n(cm['C']) + '】')
                            .replace(/{{红线数量}}/g, '【数据:' + _n(cm['红线']) + '】')
                            .replace(/{{典型问题列表}}/g, '【数据:典型问题\n' + (stats.typicals || '') + '\n】')
                            .replace(/{{日期}}/g, '【数据:' + (stats.dateLabel || parsed.dateLabel || '') + '】');
                    }
                    if (tplSections.length >= 2) {
                        // 【P1-6】章节结构单独成块、逐行列出（含缩进与"本节要点"），
                        //   让"模板架构不能变"从"整段文字里的软要求"变成可逐条比对的硬清单；
                        //   长模板也不再因为 6000 字截断而丢掉后半段章节。
                        userLines.push('【模板章节结构｜模板：' + wrCatName(tplType) + '】');
                        userLines.push('用法：【骨架】章节编号与标题照抄、顺序不变；【枚举/参照】条目是模板原有的问题分类，**仅作写法与层次参照**，其类型与数量一律以资料归纳为准（资料几类就几类，不必与模板一致）。');
                        tplSections.forEach(function (s) {
                            const indent = s.level >= 3 ? '　　' : (s.level === 2 ? '　' : '');
                            const isSkel = (s.level <= 1 && wrIsSkeletonLabel(s.label));
                            userLines.push(indent + (isSkel ? '【骨架】' : '【枚举/参照】') + s.label + (s.hint ? '　← 写法参照：' + String(s.hint).slice(0, 160) : ''));
                        });
                        userLines.push('');
                        userLines.push('【模板正文样例（仅参考语气、详略与专业表述；结构以上面章节结构为准）】');
                        userLines.push(tplContent.slice(0, 4000) + (tplContent.length > 4000 ? '\n（样例已截断）' : ''));
                    } else {
                        userLines.push('【写作模板（' + wrCatName(tplType) + '）】');
                        userLines.push(tplContent.slice(0, 6000) + (tplContent.length > 6000 ? '\n（模板内容过长，已截取前6000字，请严格按模板章节结构输出全部内容）' : ''));
                        if (tplContent.length > 6000) {
                            const skeleton = tplContent
                                .split('\n')
                                .filter(l => /^#{1,6}\s|^\s*[一二三四五六七八九十]+[、.．]|^\s*[（(][一二三四五六七八九十]+[)）]|^\s*\d+[、.．]/.test(l))
                                .map(l => l.trim())
                                .filter(Boolean)
                                .join('\n');
                            if (skeleton) {
                                userLines.push('【模板章节标题骨架（务必按以下全部章节标题补全，不得遗漏）】');
                                userLines.push(skeleton);
                            }
                            userLines.push('');
                        }
                    }
                    userLines.push('');
                } else if (!window._wrModifyMode) {
                    userLines.push('【写作模板】');
                    userLines.push('（无指定模板，请按照铁路安监文档规范自行拟定章节结构）');
                    userLines.push('');
                }
                // 补充/修改轮不注入"模板"（结构以底稿为准），也不参与台账：

                // 台账统计（P0-4：统一口径，只给一套数字；典型问题给 5 条供"主要问题"章节引用）
                // 【数据来源优先级】有资料时**整块不注入**（用户口径："不要其它台账统计典型问题，完全从资料中走"）
                if (window._wrModifyMode) {
                    userLines.push('【数据来源说明】本轮为**补充/修改**：底稿中已有的数字与结论**保留不变**（除非用户在要求里明确要改）；新增资料中的数字按【补充资料N】标注；两者不得互相矛盾；不要引用台账统计口径。');
                    userLines.push('');
                } else if (ledgerOff) {
                    userLines.push('【数据来源说明】本次报告**仅以「本地资料」为准**（见下）：事实、案例、数量一律取自资料；不要引用台账统计口径，资料未给出的数量写（待补充）。');
                    if (template && /\{\{[^}]+\}\}/.test(template.content || '')) {
                        userLines.push('（模板中的占位符请依据本地资料填写；资料未给出的写"（待补充）"，不得编造。）');
                    }
                    userLines.push('');
                } else if (stats && stats.total > 0) {
                    userLines.push('【台账统计数据（' + (stats.dateLabel || parsed.dateLabel || '') + '，共' + stats.total + '条）—— 这些数字已由系统统计，报告中必须完全照搬，不得修改】');
                    userLines.push('- 问题总数：' + stats.total + '条');
                    if (stats.natSummary) userLines.push('- 问题性质分布：' + stats.natSummary);
                    if (stats.catMap) {
                        userLines.push('- A类：' + stats.catMap['A'] + '条，B类：' + stats.catMap['B'] + '条，C类：' + stats.catMap['C'] + '条，红线：' + stats.catMap['红线'] + '条');
                    }
                    if (stats.typicals) {
                        userLines.push('- 典型问题（前5条，必须完整引用，并写入"主要问题/典型问题"类章节）：');
                        userLines.push(stats.typicals);
                    }
                    userLines.push('');
                } else {
                    userLines.push('【台账数据】');
                    userLines.push('（' + (parsed.dateLabel ? parsed.dateLabel + '期间' : '') + '暂无匹配台账数据，请在正文中使用[待补充]标记）');
                    userLines.push('');
                }

                // 本地资料库（故障报告、文电、通报等）：编号即引用号；预算按份数分配（P1-8）
                const matLinesForReuse = [];
                if (localMaterials && localMaterials.length > 0) {
                    const perBudget = wrMatPerBudget(localMaterials.length);
                    // 补充轮：这批是"新增资料"，编号用【补充资料N】以区别底稿里已存在的【资料N】
                    const _isSupp = !!window._wrModifyMode;
                    userLines.push(_isSupp
                        ? '【新增资料（共' + localMaterials.length + '份）—— 按底稿中对应章节/段落的层次位置有机融入；融入前必须再加工：语句通顺、描述具体、逻辑合理、书面化、不啰嗦；**不得整段照抄原文，也不得另起一节堆砌**；引用时标注【补充资料N】】'
                        : '【本地资料（共' + localMaterials.length + '份，必须充分引用其中的具体案例和数据；引用时标注【资料N】）—— 按【写作规范】4"归位 + 再加工"处理，不得整段照抄原文】');
                    localMaterials.forEach((m, i) => {
                        const typeInfo = (typeof WR_MAT_TYPES !== 'undefined' ? WR_MAT_TYPES : {})[m.matType] || { label: m.matType };
                        const content = String(m.content || '');
                        const head = '── ' + (_isSupp ? '补充资料' : '资料') + (i+1) + '【' + typeInfo.label + '】《' + (m.title||m.fileName) + '》';
                        const body = content.slice(0, perBudget) + (content.length > perBudget ? '…（共' + content.length + '字，已截断）' : '');
                        userLines.push(head);
                        userLines.push(body);
                        userLines.push('');
                        matLinesForReuse.push(head, body);
                    });
                }

                // 【以资料为主】资料归纳出的问题类型 —— 问题分类的唯一依据（模板原有分类只作写法参照）
                const pTypes = (plan && plan.problemTypes) ? plan.problemTypes : [];
                if (pTypes.length && localMaterials && localMaterials.length) {
                    userLines.push('【资料归纳出的问题类型（共 ' + pTypes.length + ' 类）—— 问题分类的**唯一依据**（模板原有分类只作写法参照，不得硬套）】');
                    pTypes.forEach(function (t, i) {
                        const uses = (t.materials || []).filter(function (n) { return n >= 1 && n <= localMaterials.length; });
                        userLines.push((i + 1) + '. ' + t.name + (t.section ? '（写入：' + t.section + '）' : '')
                            + (uses.length ? '　← ' + uses.map(function (n) { return '资料' + n; }).join('、') : ''));
                        (t.points || []).slice(0, 5).forEach(function (p) { userLines.push('    - ' + String(p).slice(0, 120)); });
                    });
                    userLines.push('写法要求：每一类按模板同一位置的**句段逻辑**展开（先概括现象 → 再列举具体表现/案例 → 再写依据或整改要求）；'
                        + '并按【写作规范】4 对资料原文做"再加工"（通顺/具体/逻辑合理/书面化/不啰嗦，不得整段照抄）；分类的数量与名称以本表为准。');
                    userLines.push('');
                }

                // 【P1-7】资料归类表：两步生成第一步的产物，明确"哪份资料进哪一节"
                if (plan && plan.sections && plan.sections.length && localMaterials && localMaterials.length) {
                    const byNorm = {};
                    tplSections.forEach(function (s) { byNorm[wrNormLabel(s.label)] = s.label; });
                    userLines.push('【资料归类表（已把资料分配到各章节；正文必须按此表成文，不得把资料堆到无关章节）】');
                    plan.sections.forEach(function (ps) {
                        const label = byNorm[wrNormLabel(ps.label || '')] || String(ps.label || '');
                        const uses = (ps.uses || []).filter(function (n) { return n >= 1 && n <= localMaterials.length; });
                        userLines.push('· ' + label + '　← ' + (uses.length ? uses.map(function (n) { return '资料' + n; }).join('、') : '（无对应资料：依据台账数据与常规要求撰写）'));
                        (ps.points || []).slice(0, 4).forEach(function (p) { userLines.push('    - ' + String(p).slice(0, 120)); });
                    });
                    const unused = (plan.unused || []).filter(function (n) { return n >= 1 && n <= localMaterials.length; });
                    if (unused.length) {
                        userLines.push('· 未归类资料：' + unused.map(function (n) { return '资料' + n; }).join('、') + '（若其内容确实相关，可并入最接近的章节并标注引用号）');
                    }
                    userLines.push('');
                    userLines.push('【引用规范】正文中引用资料事实时必须在句末标注【资料N】（N 为上面的引用号）；同一句引用多份写【资料1、资料3】。');
                    userLines.push('');
                }

                // 历史报告参考
                if (similarReports && similarReports.length > 0) {
                    userLines.push('【历史报告参考（仅供文风参考，勿直接抄用数据）】');
                    similarReports.forEach((r, i) => {
                        userLines.push('参考' + (i+1) + '（' + wrFmtDate(r.date).slice(0,7) + '）：');
                        userLines.push(r.content.slice(0, 500) + (r.content.length > 500 ? '…' : ''));
                        userLines.push('');
                    });
                }

                // 规章条款参考
                if (ruleCandidates && ruleCandidates.length > 0) {
                    userLines.push('【参考规章条款（' + ruleCandidates.length + '条，如需引用只用这些）】');
                    ruleCandidates.slice(0, 5).forEach((r, i) => {
                        userLines.push((i+1) + '. 《' + r.title + '》：' + (r.content||'').slice(0, 100));
                    });
                    userLines.push('');
                }

                userLines.push('请开始生成：');

                return { sysPrompt: sysLines.join('\n'), userPrompt: userLines.join('\n') };
            }

            // ================================================================
            // ── 生成报告主流程 ──
            // ================================================================

            // 输入变化时自动更新资料预览标签
            window.wrOnQueryChange = function() {
                const q = (document.getElementById('wr-query-input') || {}).value || '';
                if (q.trim().length < 5) {
                    const p = document.getElementById('wr-material-preview');
                    if (p) p.style.display = 'none';
                    return;
                }
                // 异步更新预览（防抖）
                clearTimeout(window._wrPreviewTimer);
                window._wrPreviewTimer = setTimeout(() => wrUpdateMaterialPreview(q), 400);
            };

            async function wrUpdateMaterialPreview(query) {
                const tags = [];
                // 【v3.76】本地来源也要在预览里可见（本地模板 / 本地参考资料）
                const _localRefs = (window._wrUploadedFiles || []).filter(Boolean);
                if (window._wrSelectedTemplate) {
                    var _isLocalTpl = window._wrSelectedTemplate._src === 'local';
                    tags.push('<span style="background:#dbeafe;color:#1e40af;padding:3px 10px;border-radius:20px;font-size:0.78rem;">' + (_isLocalTpl ? '💻' : '📄') + ' ' + wrEsc(window._wrSelectedTemplate.title) + '</span>');
                }
                if (window._wrSelectedMaterialIds && window._wrSelectedMaterialIds.length > 0) {
                    tags.push('<span style="background:#eff6ff;color:#1d4ed8;padding:3px 10px;border-radius:20px;font-size:0.78rem;">📁 已选' + window._wrSelectedMaterialIds.length + '份资料</span>');
                }
                if (_localRefs.length > 0) {
                    tags.push('<span style="background:#eef2ff;color:#4338ca;padding:3px 10px;border-radius:20px;font-size:0.78rem;">💻 本地文件 ' + _localRefs.length + ' 份</span>');
                }
                if (!window._wrSelectedTemplate && (!window._wrSelectedMaterialIds || window._wrSelectedMaterialIds.length === 0) && _localRefs.length === 0) {
                    tags.push('<span style="color:#d97706;font-size:0.78rem;">⚠️ 尚未选择模板和资料，请点击「开始写作」选择</span>');
                }

                const preview = document.getElementById('wr-material-preview');
                const tagsEl  = document.getElementById('wr-material-tags');
                if (preview && tagsEl) {
                    tagsEl.innerHTML = tags.join('');
                    preview.style.display = 'block';
                }
            }

            window.wrPreviewMaterials = async function() {
                const q = (document.getElementById('wr-query-input') || {}).value || '';
                if (!q.trim()) { alert('请先输入写作需求'); return; }
                const parsed = wrParseQuery(q);
                let template = window._wrSelectedTemplate || null;
                let localMaterials = [];
                if (window._wrSelectedMaterialIds && window._wrSelectedMaterialIds.length > 0) {
                    const allMats = await wrDbGetAll(WR_MAT_STORE);
                    localMaterials = allMats.filter(m => window._wrSelectedMaterialIds.includes(m.id));
                }
                const materials = { parsed, template, issues: [], stats: null, similarReports: [], ruleCandidates: [], localMaterials: localMaterials };

                let html = '<div style="padding:14px;background:#f8fafc;border-radius:10px;border:1px solid var(--border);font-size:0.85rem;line-height:1.7;">';
                html += '<div style="font-weight:700;color:var(--primary);margin-bottom:10px;">🔍 已选资料预览（未选择的将不会发送给AI）</div>';

                html += '<div style="margin-bottom:8px;"><strong>📋 解析结果：</strong><br>'
                    + '类型：' + wrCatName(parsed.reportType) + '　'
                    + (parsed.dateLabel ? '时段：' + parsed.dateLabel + '　' : '')
                    + '关键词：' + (parsed.keywords.join('、')||'无') + '</div>';

                html += '<div style="margin-bottom:8px;"><strong>📄 匹配模板：</strong>'
                    + (template ? '<span style="color:#059669;">《' + wrEsc(template.title) + '》</span>' : '<span style="color:#d97706;">无，将使用默认结构</span>') + '</div>';

                // 数据来源提示：有资料 → 以资料为准（不注入台账统计）；无资料 → 用台账按需求范围梳理总结
                if (localMaterials && localMaterials.length > 0) {
                    html += '<div style="margin-bottom:8px;"><strong>📊 数据来源：</strong>'
                        + '<span style="color:#059669;">以资料为准（不使用台账统计/典型问题）</span>'
                        + '<span style="color:#94a3b8;"> — 如需台账数据，请在本行需求中写明「按台账统计…」</span></div>';
                } else {
                    html += '<div style="margin-bottom:8px;"><strong>📊 数据来源：</strong>'
                        + '<span style="color:#059669;">无资料 → 按需求范围从检查信息台账梳理总结（数字真实）</span></div>';
                }

                // 本地资料库
                if (localMaterials && localMaterials.length > 0) {
                    html += '<div style="margin-bottom:8px;"><strong>📁 本地资料：</strong><span style="color:#059669;">'
                        + localMaterials.map(m => {
                            const t = (typeof WR_MAT_TYPES !== 'undefined' ? WR_MAT_TYPES : {})[m.matType] || {};
                            return '【' + (t.label||m.matType) + '】《' + wrEsc(m.title||m.fileName) + '》';
                        }).join('、')
                        + '</span></div>';
                } else {
                    html += '<div style="margin-bottom:8px;"><strong>📁 本地资料：</strong><span style="color:#d97706;">无匹配资料（可到「资料库」导入文件）</span></div>';
                }

                html += '<div style="margin-bottom:8px;"><strong>📂 历史参考：</strong><span style="color:#059669;">生成时将自动检索相似历史报告</span></div>';

                html += '<div><strong>⚖️ 规章条款：</strong><span style="color:#059669;">生成时将自动检索相关规章条款</span></div>';

                html += '</div>';

                const resultEl = document.getElementById('wr-gen-result');
                if (resultEl) { resultEl.innerHTML = html; resultEl.style.display = 'block'; }
            };

            let _wrAbortController = null; // 用于停止写作生成

            window.wrGenerate = async function(isRegenerate) {
                const q = (document.getElementById('wr-query-input') || {}).value || '';
                // 补充/修改轮允许"不写文字要求、只勾新增资料"（2026-09-18 用户口径），故该轮不做空校验
                if (!q.trim() && !window._wrModifyMode) { alert('请输入写作需求'); return; }
                var apiKey = localStorage.getItem('ds_api_key_v1') || '';
                const apiUrl = window.dsGetApiUrl(); // v3.70：归一化（缺 https:// 时 fetch 会按相对路径打到本站 → 404）
                const model  = localStorage.getItem(WR_MODEL_K) || 'deepseek-flash';
                if (!apiKey) { alert('请先在智能助手模块中配置 API Key。'); return; }

                const writeBtn = document.getElementById('wr-write-btn');
                const stopBtn = document.getElementById('wr-stop-btn');
                // 显示停止按钮
                if (stopBtn) stopBtn.style.display = 'inline-block';

                // 合并上传的文件内容
                let enhancedQuery = q;
                let uploadedContent = '';
                const uploadedFiles = (window._wrUploadedFiles || []).filter(Boolean);
                if (uploadedFiles.length) {
                    const uploadedBlock = uploadedFiles.map(f => `--- 文件：${f.name} ---\n${f.content}`).join('\n\n');
                    enhancedQuery += '\n\n【上传的文件内容】\n' + uploadedBlock;
                    uploadedContent = uploadedBlock;
                }

                    if (!isRegenerate && !window._wrModifyMode) {
                        wrAppendChatBubble('user', q);
                        _wrConvHistory.push({ role: 'user', content: enhancedQuery, timestamp: Date.now() });
                        document.getElementById('wr-query-input').value = '';
                    } else if (!isRegenerate && window._wrModifyMode) {
                        // 补充/修改轮：把"用户要求 + 新增资料份数"记进会话，便于回看这轮改了什么
                        const _supN = (Array.isArray(window._wrModifySuppMats) ? window._wrModifySuppMats.length : 0);
                        const _modifyLabel = '【补充/修改】' + (q ? q : '（未写文字要求，仅补充新增资料）') + (_supN ? '（新增资料 ' + _supN + ' 份）' : '');
                        wrAppendChatBubble('user', _modifyLabel);
                        // 只入栈"真实要求"（与 enhancedQuery 相同会被拼消息时的过滤条件挡掉，避免同一段要求发两次）
                        if (enhancedQuery) _wrConvHistory.push({ role: 'user', content: enhancedQuery, timestamp: Date.now() });
                    }
                wrUpdateConvBtn();

                const aiBubble = wrAppendChatBubble('assistant', '', true);
                const streamBubbleContent = document.getElementById('wr-stream-bubble-content');
                if (writeBtn) writeBtn.disabled = true;

                // 结果容器（检索加载态复用）
                const resultEl = document.getElementById('wr-gen-result');

                try {
                    // 显示检索加载态
                    if (resultEl) { resultEl.style.display = 'block'; resultEl.innerHTML = '<div style="padding:14px;color:#64748b;font-size:0.85rem;">🔍 正在检索本地资料与台账数据…</div>'; }

                    // 自动检索 vs 手动选择逻辑（P0-2 修复 2026-09-18）：
                    //   旧实现：只要"选了资料"就置 _wrSkipLocalSearch，把台账/规章/历史报告**全部置空**
                    //   —— 用户选了资料反而拿不到真实数字与规章依据（实测 materialCount={issues:0,rules:0,reports:0}）。
                    //   现在：手选资料只"替换资料来源"，台账统计/规章候选/历史报告**照常检索**；
                    //   只有「修改报告」流程（窗口级 _wrModifyMode）才跳过检索（原报告已含全部内容）。
                    const manualMatIds = (window._wrSelectedMaterialIds || []).filter(Boolean);
                    const useManual = manualMatIds.length > 0;
                    const modifyMode = !!window._wrModifyMode;
                    let materials;
                    if (modifyMode) {
                        // 【补充/修改轮（2026-09-18 用户口径）】"继续修改 = 补充"：只注入**本轮新增资料**，
                        //   不再重新检索原模板/原资料/台账 —— 那些内容已经在底稿（当前报告）里了。
                        const _supp = Array.isArray(window._wrModifySuppMats) ? window._wrModifySuppMats : [];
                        materials = {
                            parsed: wrParseQuery(q) || { dateLabel: '' },
                            template: null, issues: [], stats: null, similarReports: [], ruleCandidates: [],
                            localMaterials: _supp.map(function (x, i) {
                                return {
                                    id: 'supp' + i,
                                    title: x.title || ('新增资料' + (i + 1)),
                                    content: x.content || '',
                                    matType: x.matType || 'report',
                                    fileName: x.fileName || ''
                                };
                            })
                        };
                    } else {
                        try { materials = await wrRetrieveMaterials(q); }
                        catch (e) {
                            console.warn('自动检索失败，回退空资料', e);
                            materials = { parsed: wrParseQuery(q), template: null, issues: [], stats: null, similarReports: [], ruleCandidates: [], localMaterials: [] };
                        }
                    }
                    // 手选资料：只替换"资料"这一路（不动台账/规章/历史报告）—— 补充轮的资料来源已在上面单独装配
                    if (useManual && !modifyMode) {
                        try {
                            const allMats = await wrDbGetAll(WR_MAT_STORE);
                            materials.localMaterials = allMats.filter(m => manualMatIds.includes(m.id) && m.matType !== 'template');
                        } catch (e) { console.warn('[writer] 读取手选资料失败：', e && e.message); }
                    }
                    // 手选模板优先于自动匹配（只选模板未勾资料时同样生效）；补充轮不用模板（结构以底稿为准）
                    if (!modifyMode && window._wrSelectedTemplate) materials.template = window._wrSelectedTemplate;
                    const parsed = materials.parsed;
                    const template = materials.template;

                    // ---- 数据来源优先级（2026-09-18 用户口径）----
                    //   有模板 + 有资料 → **完全从资料走**（不注入台账统计/典型问题）；
                    //   没有资料（或自动检索到的资料与需求完全不相关）→ 才用台账，按写作要求范围梳理总结；
                    //   需求里明确要求（"按台账统计/检查信息/条数…"）→ 视为特殊说明，照常给台账数据。
                    const _matList = materials.localMaterials || [];
                    // ⚠️ 纯日期类关键词（"3月""2026年"）几乎能命中一切，不能用来判定"资料是否与需求相关"，
                    //    判相关性时必须排除，否则随便一份带"3月"的旧资料就会把台账数据挤掉。
                    const _kws = (((parsed && parsed.keywords) || [])).filter(function (k) {
                        return !/^\d{4}年\d{1,2}月$/.test(String(k).trim())
                            && !/^\d{4}年$/.test(String(k).trim())
                            && !/^\d{1,2}月$/.test(String(k).trim());
                    });
                    const _strongCount = _matList.filter(function (m) {
                        const t = ((m.title || '') + (m.fileName || '') + ' ' + String(m.content || '').slice(0, 4000)).toLowerCase();
                        return _kws.some(function (k) { return t.indexOf(String(k).toLowerCase()) !== -1; });
                    }).length;
                    const hasReliableMaterials = useManual || _strongCount > 0;
                    const _explicitLedger = /台账|检查信息|问题总数|问题数|问题条数|条数|统计口径|按统计|数据统计|汇总数据|总量/.test(q);
                    materials.ledgerAllowed = (!hasReliableMaterials) || _explicitLedger;
                    materials.ledgerReason = !hasReliableMaterials ? 'no-materials' : (_explicitLedger ? 'user-asked' : 'materials-first');
                    // 补充轮不参与台账（底稿已定稿，本轮只把新资料补进去）
                    if (modifyMode) { materials.ledgerAllowed = false; materials.ledgerReason = 'modify'; }
                    if (typeof console !== 'undefined') {
                        console.log('[writer] 数据来源：' + (materials.ledgerAllowed ? '台账可用（' + materials.ledgerReason + '）' : '以资料为准（不注入台账统计）')
                            + '；手选=' + useManual + '，相关资料=' + _strongCount + '/' + _matList.length);
                    }
                    // 诊断钩子（排查"为什么这次没用台账/没用资料"时看它）
                    window.__wrLedger = {
                        allowed: materials.ledgerAllowed, reason: materials.ledgerReason,
                        manual: useManual, strong: _strongCount, matTotal: _matList.length,
                        strongKeywords: _kws, explicitLedger: _explicitLedger
                    };

                    // ---- P1-7：两步生成第一步「资料归类表」----
                    // 仅在有模板 + 有资料的场景做：把资料归类到模板章节，产出"哪份资料进哪一节"的映射，
                    // 再把它作为硬约束写进正文提示词（避免模型把资料堆到无关章节、或整段照抄）。
                    const tplSectionsForPlan = template ? wrParseTemplateSections(template.content || '') : [];
                    const _twoStepOn = wrTwoStepEnabled();
                    if (_twoStepOn && tplSectionsForPlan.length >= 2 && (materials.localMaterials || []).length > 0) {
                        if (streamBubbleContent) streamBubbleContent.innerHTML = '<div style="color:#64748b;font-size:0.85rem;">🧭 正在归类资料到模板章节…</div>';
                        try {
                            const planReq = wrBuildPlanPrompt(q, tplSectionsForPlan, materials.localMaterials, materials.stats, { ledgerAllowed: materials.ledgerAllowed });
                            const planText = await wrCallOnce(planReq.sysPrompt, planReq.userPrompt, { maxTokens: 1500, temperature: 0.2, noThinking: true, timeoutMs: 60000 });
                            const plan = wrParsePlan(planText);
                            if (plan) {
                                materials.plan = plan;
                                const usedN = {}; plan.sections.forEach(function (s) { (s.uses || []).forEach(function (n) { usedN[n] = 1; }); });
                                const covered = Object.keys(usedN).length;
                                console.log('[writer] 资料归类表已生成：' + plan.sections.length + ' 节，覆盖资料 ' + covered + '/' + materials.localMaterials.length);
                                if (streamBubbleContent) streamBubbleContent.innerHTML = '<div style="color:#64748b;font-size:0.85rem;">🧭 已归类 ' + covered + '/' + materials.localMaterials.length + ' 份资料，正在按模板章节成文…</div>';
                            } else {
                                console.warn('[writer] 归类表解析失败，转为单步生成');
                            }
                        } catch (e) { console.warn('[writer] 归类步骤失败（转单步生成）：', e && e.message); }
                    }

                    // 隐藏检索加载态，开始流式生成
                    if (resultEl) { resultEl.innerHTML = ''; resultEl.style.display = 'none'; }

                    // 构建提示词
                    const { sysPrompt, userPrompt } = wrBuildPrompt(q, materials, uploadedContent);

                    // 构建消息序列（保留最近4轮对话上下文）
                    const messages = [{ role: 'system', content: sysPrompt }];
                    const histSlice = _wrConvHistory.slice(-8);
                    histSlice.forEach(h => {
                        if (h.role === 'user' && h.content !== enhancedQuery) messages.push({ role: 'user', content: h.content });
                        else if (h.role === 'assistant') messages.push({ role: 'assistant', content: h.content.slice(0, 1500) });
                    });
                    // 【视觉模型接入】若上传文件含图片且当前模型支持视觉，则把末条 user 改为多模态 content 数组
                    const _wrVisionOk = (typeof window.dsModelSupportsVision === 'function')
                        ? window.dsModelSupportsVision(model) : false;
                    const _wrImgAttach = (uploadedFiles || []).filter(f => f && f.isImage && f.dataUrl);
                    let _wrFinalUser = userPrompt;
                    if (_wrImgAttach.length && _wrVisionOk && typeof window.buildVisionMessages === 'function') {
                        const _vm = window.buildVisionMessages(userPrompt, _wrImgAttach);
                        if (_vm && typeof _vm.content !== 'string') _wrFinalUser = _vm.content; // 多模态数组（OpenAI 格式）
                    }
                    messages.push({ role: 'user', content: _wrFinalUser });

                    _wrAbortController = new AbortController();
                    // 【修复 E1】整体生成超时（180s），避免 API 假死导致"停止"按钮常显、writeBtn 一直禁用
                    // ⚠️ 必须用 var 而非 const：这两个变量会在下面的 catch / finally 中使用，
                    // 而 const/let 声明在 try 块内时，catch / finally 属于**另一个块**、根本看不到它们，
                    // 会在收尾时抛「ReferenceError: _wrTimeout is not defined」，导致 finally 里的
                    // 清理（恢复「开始写作」按钮、隐藏停止按钮、清空 _wrAbortController、复位 _wrTimedOut）
                    // 全部不执行 —— 表现为生成完成后按钮永久禁用、停止按钮常显。
                    var _wrTimeoutMs = 180000;
                    var _wrTimeout = setTimeout(() => {
                        if (_wrAbortController) {
                            window._wrTimedOut = true;
                            try { _wrAbortController.abort(new Error('TimeoutError')); } catch (e) {}
                        }
                    }, _wrTimeoutMs);
                    // 思考模式：跟随设置页开关（默认开）。开启时 temperature 不生效（官方行为），
                    // 长文写作受益于思维链，故保留；max_tokens 16384 已远低于模型 384K 上限，无需调整。
                    const _wrBody = { model, messages, stream: true, temperature: 0.3, max_tokens: 16384 };
                    if (typeof window.dsThinkingParam === 'function') {
                        Object.assign(_wrBody, window.dsThinkingParam({ apiUrl: apiUrl, model: model }));
                    }
                    const resp = await fetch(apiUrl, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + apiKey },
                        body: JSON.stringify(_wrBody),
                        signal: _wrAbortController.signal
                    });

                    if (!resp.ok) {
                        let _wrErr = '';
                        try { _wrErr = await resp.text(); } catch (_e) {}
                        let _wrMsg = '';
                        try { _wrMsg = ((JSON.parse(_wrErr) || {}).error || {}).message || ''; } catch (_e) { _wrMsg = String(_wrErr).slice(0, 200); }
                        throw new Error(typeof window.dsAiHttpError === 'function'
                            ? window.dsAiHttpError(resp.status, _wrMsg)
                            : ('HTTP ' + resp.status + (_wrMsg ? '：' + _wrMsg : '')));
                    }

                    let fullText = '';
                    const reader = resp.body.getReader();
                    const decoder = new TextDecoder();
                    let buffer = '';
                    let lastRender = 0;
                    const RENDER_INTERVAL = 100; // 限制渲染频率

                    while (true) {
                        const { done, value } = await reader.read();
                        if (done) break;
                        buffer += decoder.decode(value, { stream: true });
                        const lines = buffer.split('\n');
                        buffer = lines.pop();
                        for (const line of lines) {
                            if (!line.startsWith('data: ')) continue;
                            const data = line.slice(6).trim();
                            if (data === '[DONE]') break;
                            try {
                                const obj = JSON.parse(data);
                                const delta = obj.choices?.[0]?.delta?.content || '';
                                if (delta) {
                                    fullText += delta;
                                    const now = Date.now();
                                    if (now - lastRender > RENDER_INTERVAL && streamBubbleContent) {
                                        streamBubbleContent.innerHTML = (window.dsMarkdown ? window.dsMarkdown(fullText) : wrStreamFormat(fullText));
                                        const histEl = document.getElementById('wr-chat-history');
                                        if (histEl) histEl.scrollTop = histEl.scrollHeight;
                                        lastRender = now;
                                    }
                                }
                            } catch(e) {}
                        }
                    }
                    // 最后一次渲染
                    if (streamBubbleContent) streamBubbleContent.innerHTML = (window.dsMarkdown ? window.dsMarkdown(fullText) : wrStreamFormat(fullText));
                    
                    // 去掉流式气泡 id
                    if (aiBubble) aiBubble.id = '';
                    if (streamBubbleContent) streamBubbleContent.id = '';

                    // 清理数据标记
                    fullText = fullText.replace(/【数据:典型问题\n([\s\S]*?)\n】/g, '$1');
                    fullText = fullText.replace(/【数据:([^\】]*?)】/g, '$1');

                    // ★ 模板应用：占位符模板优先用 AI 返回的映射填充；解析失败则保留 AI 正文并清理残留占位符
                    let _wrMappingApplied = false;
                    if (template && template.content) {
                        // 尝试从模型输出提取映射（模型被要求输出 JSON 映射，可能夹带尾注/解释）
                        let mapping = wrParseMapping(fullText);
                        if (!mapping) { try { mapping = _wrExtractJson(fullText); } catch (e) {} }
                        if (mapping && typeof mapping === 'object' && Object.keys(mapping).length) {
                            // 【数字兜底】系统本来就掌握真值的占位符，一律用真实统计覆盖模型返回值：
                            //   实测模型伪造「问题总数=9999」照样被原样回填 —— 这些键没有理由交给模型定。
                            // ⚠️ 但**必须跟着数据来源开关走**：materials-first（有资料以资料为准）时不得用台账数字
                            //    覆盖模型依据资料填出的值，否则又变成"台账混进资料报告"，且溯源会把台账数字判成无出处。
                            if (materials.stats && materials.ledgerAllowed !== false) {
                                const phs = extractPlaceholders(template.content || '').map(function (s) { return String(s).trim(); });
                                const cm = materials.stats.catMap || {};
                                const known = {};
                                const setIf = function (k, v) {
                                    if (phs.indexOf(k) !== -1 && v !== undefined && v !== null && v !== '') known[k] = String(v);
                                };
                                setIf('问题总数', materials.stats.total);
                                setIf('A类数量', cm['A']);
                                setIf('B类数量', cm['B']);
                                setIf('C类数量', cm['C']);
                                setIf('红线数量', cm['红线']);
                                setIf('日期', materials.stats.dateLabel || parsed.dateLabel);
                                if (phs.indexOf('典型问题列表') !== -1 && materials.stats.typicals) known['典型问题列表'] = materials.stats.typicals;
                                // 归一化模型返回的键（可能带空格），再整体覆盖，避免 "" 与 " " 两套键共存
                                const merged = {};
                                Object.keys(mapping).forEach(function (k) { merged[String(k).trim()] = mapping[k]; });
                                const overridden = Object.keys(known).filter(function (k) { return String(merged[k] || '') !== known[k]; });
                                if (overridden.length && typeof console !== 'undefined') {
                                    console.warn('[writer] 占位符数字已用台账真值覆盖模型返回值：' + overridden.join('、'));
                                }
                                mapping = Object.assign(merged, known);
                            }
                            fullText = applyTemplatePlaceholders(template.content, mapping);
                            _wrMappingApplied = true;
                        } else if (/\{\{[^}]+\}\}/.test(fullText)) {
                            // 模型已直接撰写正文但残留占位符：保留正文，仅把残留占位符标记待补充（绝不丢弃模板/正文）
                            fullText = fullText.replace(/\{\{([^}]+)\}\}/g, '（待补充：$1）');
                        }
                        // 否则：模型已直接输出完整文档（占位符已内联填充），原样保留
                        // 重新渲染气泡：模板替换后内容已是 HTML，不能用 wrStreamFormat（会二次转义）。
                        // 但 fullText 仍是模型原文（模型输入含用户上传的文件正文，存在注入面），
                        // 直灌 innerHTML 会执行其中的 <img onerror> 等脚本 —— 必须先净化。
                        if (streamBubbleContent) streamBubbleContent.innerHTML = wrSafeBubbleHtml(fullText);
                        const histEl = document.getElementById('wr-chat-history');
                        if (histEl) histEl.scrollTop = histEl.scrollHeight;
                    }

                    // ---- P1-6：产出后校验「模板章节是否齐全」，缺失则自动补写一次 ----
                    //   占位符映射路径不回填正文（结构本身来自模板原文）→ 无需校验；
                    //   其余路径做一次逐章比对：缺失章节自动补写（一次），仍缺则在文末明确标注。
                    let _wrSectionCheck = null;
                    let _wrQc = null;
                    let _wrNumCheck = null;
                    // 校验用骨架来源：常规轮 = 模板原文；**补充/修改轮 = 当前报告底稿**
                    //   —— "补充"同样不许丢章节（模型被要求输出全文，实测有整节丢失的风险）。
                    const _secSrc = (template && template.content && !_wrMappingApplied)
                        ? String(template.content)
                        : (window._wrModifyMode ? String(window._wrModifyBaseContent || '') : '');
                    if (_secSrc) {
                        const secs = wrParseTemplateSections(_secSrc);
                        if (secs.length >= 2) {   // 只要模板有 2 个以上章节就校验（"架构不能变"是硬要求）
                            _wrSectionCheck = wrValidateSections(fullText, secs);
                            if (_wrSectionCheck.missing.length) {
                                console.warn('[writer] 章节校验：缺失 ' + _wrSectionCheck.missing.length + ' 节 → ' + _wrSectionCheck.missing.join('、'));
                                const statLine = (materials.stats && materials.stats.total)
                                    ? ('共 ' + materials.stats.total + ' 条（' + (materials.stats.dateLabel || parsed.dateLabel || '') + '）'
                                       + (materials.stats.catMap ? '；A类' + materials.stats.catMap['A'] + '、B类' + materials.stats.catMap['B'] + '、C类' + materials.stats.catMap['C'] + '、红线' + materials.stats.catMap['红线'] : '')
                                       + (materials.stats.typicals ? '\n典型问题：\n' + materials.stats.typicals : ''))
                                    : '';
                                const matLines = [];
                                (materials.localMaterials || []).forEach(function (m, i) {
                                    const c = String(m.content || '');
                                    matLines.push('资料' + (i + 1) + '《' + (m.title || m.fileName) + '》' + c.slice(0, 1200) + (c.length > 1200 ? '…' : ''));
                                });
                                if (streamBubbleContent) {
                                    streamBubbleContent.innerHTML = wrSafeBubbleHtml(fullText)
                                        + '<div style="margin-top:6px;font-size:0.78rem;color:#d97706;">🧩 检测到' + (window._wrModifyMode ? '底稿' : '模板') + '章节缺失（' + _wrSectionCheck.missing.join('、') + '），正在自动补写…</div>';
                                }
                                try {
                                    const more = await wrContinueMissingSections(_wrSectionCheck.missing, secs, {
                                        query: q, statsLine: statLine, materialLines: matLines, tailText: fullText,
                                        problemTypes: (materials.plan && materials.plan.problemTypes) ? materials.plan.problemTypes : null
                                    });
                                    if (more) {
                                        fullText = fullText.replace(/\s*$/, '') + '\n\n' + more;
                                        const recheck = wrValidateSections(fullText, secs);
                                        _wrSectionCheck = { missing: recheck.missing, total: recheck.total, found: recheck.found, continued: true };
                                        if (typeof console !== 'undefined') console.log('[writer] 自动补写完成，仍缺：' + (recheck.missing.join('、') || '无'));
                                    }
                                } catch (e) { console.warn('[writer] 自动补写失败：', e && e.message); }
                            }
                            // 仍缺失 → 文末如实标注（生成"看似成功"的残篇比失败更危险）
                            if (_wrSectionCheck && _wrSectionCheck.missing.length) {
                                fullText += '\n\n> ⚠️ ' + (window._wrModifyMode ? '原报告（底稿）' : '模板骨架') + '中的以下章节未能生成，请手动补充或重新生成：' + _wrSectionCheck.missing.join('、');
                            }
                        }
                        // ---- 产出回执（P2）：资料与台账是否真的被写进报告（否则"漏用"永远不可观测）----
                        const _matCount = (materials.localMaterials || []).length;
                        const _cited = (fullText.match(/【(?:补充)?资料\s*\d+/g) || []).length;
                        let _issuesCited = null;
                        if (materials.ledgerAllowed !== false && materials.stats && materials.stats.typicals) {
                            const firstTyp = String(materials.stats.typicals).split('\n')[0].replace(/^\d+\.\s*/, '').slice(0, 12);
                            if (firstTyp) _issuesCited = fullText.indexOf(firstTyp) !== -1;
                        }
                        _wrQc = { matCount: _matCount, cited: _cited, issuesCited: _issuesCited };
                        const _qcWarn = [];
                        if (_matCount > 0 && _cited === 0) _qcWarn.push('未检测到资料引用标注（期望形如【资料1】/【补充资料1】）');
                        if (_issuesCited === false) _qcWarn.push('未检测到台账典型问题被写入正文');
                        // ⚠️ 回执只在界面与报告元数据里体现，**不写进正文**（正文会被导出成 DOCX，塞提示语不合适）
                        if (typeof console !== 'undefined') {
                            console.log('[writer] 产出回执：资料引用标注 ' + _cited + ' 处 / 提供 ' + _matCount + ' 份；台账典型问题引用=' + _issuesCited);
                        }
                        if (streamBubbleContent) {
                            const _enumTxt = (materials.plan && materials.plan.problemTypes && materials.plan.problemTypes.length)
                                ? '；问题分类按资料归纳为 ' + materials.plan.problemTypes.length + ' 类'
                                : '';
                            const secLine = !_wrSectionCheck ? '' : (_wrSectionCheck.missing.length
                                ? '<div style="margin-top:6px;font-size:0.76rem;color:#d97706;">⚠️ 架构校验：骨架章节 ' + _wrSectionCheck.found + '/' + _wrSectionCheck.total + ' 已生成，缺失已标注在文末' + wrEsc(_enumTxt) + '</div>'
                                : '<div style="margin-top:6px;font-size:0.76rem;color:#059669;">✅ 架构校验：骨架章节 ' + _wrSectionCheck.total + '/' + _wrSectionCheck.total + ' 齐全' + (_wrSectionCheck.continued ? '（含自动补写）' : '') + wrEsc(_enumTxt) + '</div>');
                            const qcLine = (_qcWarn.length)
                                ? '<div style="margin-top:4px;font-size:0.76rem;color:#d97706;">⚠️ 产出回执：' + wrEsc(_qcWarn.join('；')) + '</div>'
                                : '<div style="margin-top:4px;font-size:0.76rem;color:#64748b;">🧾 产出回执：资料引用标注 ' + _cited + ' 处 / ' + (window._wrModifyMode ? '新增资料 ' : '提供 ') + _matCount + ' 份</div>';
                            streamBubbleContent.innerHTML = wrSafeBubbleHtml(fullText) + secLine + qcLine;
                        }
                    }

                    // ---- 数字溯源校验（对"有无模板/是否占位符模式"的所有生成都适用）----
                    // 背景：materials-first 时不再用台账真值覆盖占位符，数字改由模型依据资料填写 →
                    //   必须让"编造数字"可见。做法：把本次**实际提供的全部材料**拼成可溯源文本，
                    //   报告里出现的数字逐个回查；查不到出处的列进产出回执（只提示、不阻断保存）。
                    {
                        const _numSources = [
                            (materials.localMaterials || []).map(function (m) { return (m.title || '') + ' ' + String(m.content || ''); }).join('\n'),
                            uploadedContent || '',
                            q,
                            // 补充轮：底稿里沿用下来的数字本来就有出处（上一轮已校验过），否则会把整篇旧报告的数字全报一遍
                            (window._wrModifyMode ? String(window._wrModifyBaseContent || '') : ''),
                            (materials.ruleCandidates || []).map(function (r) { return (r.title || '') + ' ' + String(r.content || ''); }).join('\n'),
                            // ⚠️ **历史报告不作为出处**：提示词已声明它"仅供文风参考、勿直接抄用数据"，
                            //    若把它算作出处，前一篇编造的数字会被后一篇"继承"后判为合规（互相洗白）——实测踩过。
                            template ? String(template.content || '') : '',
                            (materials.ledgerAllowed !== false && materials.stats)
                                ? (String(materials.stats.total == null ? '' : materials.stats.total) + ' '
                                   + String(materials.stats.typicals || '') + ' ' + String(materials.stats.natSummary || '')
                                   // ⚠️ A/B/C/红线 分项数字也要算出处（占位符替换与"典型问题"里都会用到它们）
                                   + (materials.stats.catMap
                                        ? ' ' + ['A', 'B', 'C', '红线', '其他'].map(function (k) { return materials.stats.catMap[k]; }).join(' ')
                                        : ''))
                                : ''
                        ].join('\n');
                        _wrNumCheck = wrCheckNumberProvenance(fullText, _numSources);
                        _wrQc = _wrQc || {};
                        _wrQc.matCount = (materials.localMaterials || []).length;
                        _wrQc.cited = (fullText.match(/【(?:补充)?资料\s*\d+/g) || []).length;
                        _wrQc.numbers = { checked: _wrNumCheck.checked, untraced: _wrNumCheck.untraced.slice(0, 20) };
                        if (typeof console !== 'undefined') {
                            console.log('[writer] 数字溯源：检查 ' + _wrNumCheck.checked + ' 个数字，无出处 ' + _wrNumCheck.untraced.length + ' 个'
                                + (_wrNumCheck.untraced.length ? '：' + _wrNumCheck.untraced.slice(0, 8).map(function (x) { return x.value + '×' + x.count; }).join('、') : ''));
                        }
                        if (streamBubbleContent) {
                            const numLine = _wrNumCheck.untraced.length
                                ? '<div style="margin-top:4px;font-size:0.76rem;color:#d97706;">🔍 数字溯源：'
                                    + _wrNumCheck.untraced.length + ' 个数字未在本次材料中找到出处（'
                                    + wrEsc(_wrNumCheck.untraced.slice(0, 5).map(function (x) { return x.value + (x.count > 1 ? '×' + x.count : ''); }).join('、'))
                                    + '）— 请核对是否编造</div>'
                                : '<div style="margin-top:4px;font-size:0.76rem;color:#059669;">🔍 数字溯源：'
                                    + (_wrNumCheck.checked >= 2
                                        ? '全文 ' + _wrNumCheck.checked + ' 个数字均可在本次材料中找到出处'
                                        : '未发现无出处的数字') + '</div>';
                            streamBubbleContent.innerHTML = streamBubbleContent.innerHTML + numLine;
                        }
                    }

                    // 记录到对话历史
                    _wrConvHistory.push({ role: 'assistant', content: fullText, timestamp: Date.now() });

                    // 保存当前报告内容
                    window._wrCurrentReportContent = fullText;
                    window._wrCurrentReportQuery   = enhancedQuery;
                    window._wrCurrentReportOrigQuery = q;
                    window._wrCurrentReportParsed  = parsed;

                    // 保存到历史
                    const isModify = !!window._wrModifyMode;
                    let savedId = null;
                    try {
                        savedId = await wrSaveReport({
                            title: isModify ? ((window._wrModifyBaseTitle || '报告') + '（修改版）') : (q.slice(0, 30) + (q.length > 30 ? '…' : '')),
                            category: isModify ? (window._wrModifyCategory || 'other') : (template && template.category ? template.category : parsed.reportType),
                            query: enhancedQuery,
                            content: fullText,
                            materialCount: {
                                issues:  (materials.issues || []).length,
                                rules:   (materials.ruleCandidates || []).length,
                                reports: (materials.similarReports || []).length,
                                // 【质量回执】把"用户手选的资料份数 / 归类表覆盖情况 / 章节校验结果"一并落库，
                                // 否则漏用与缺章永远不可观测（用户只能人工比对）
                                local:   (materials.localMaterials || []).length,
                                planCovered: (materials.plan && materials.plan.sections)
                                    ? (function () { var s = {}; materials.plan.sections.forEach(function (x) { (x.uses || []).forEach(function (n) { s[n] = 1; }); }); return Object.keys(s).length; })()
                                    : 0,
                                sections: _wrSectionCheck ? (_wrSectionCheck.found + '/' + _wrSectionCheck.total) : ''
                            },
                            date: Date.now(),
                            templateId: template ? template.id : null,
                            sectionCheck: _wrSectionCheck ? {
                                scope: _wrSectionCheck.scope || 'skeleton',
                                missing: _wrSectionCheck.missing, found: _wrSectionCheck.found, total: _wrSectionCheck.total,
                                enumTotal: _wrSectionCheck.enumTotal || 0,
                                problemTypes: (materials.plan && materials.plan.problemTypes) ? materials.plan.problemTypes.map(function (t) { return t.name; }) : null
                            } : null,
                            qc: _wrQc || null,
                            source: 'smart-writer'
                        });
                    } catch (saveErr) {
                        // 【修复 D4】保存失败不应静默：内容已在内存，提示用户可复制
                        console.error('报告保存失败:', saveErr);
                        if (streamBubbleContent) {
                            const tip = document.createElement('div');
                            tip.style.cssText = 'margin-top:6px;font-size:0.75rem;color:#d97706;';
                            tip.textContent = '⚠️ 自动保存失败（内容仍可复制）：' + (saveErr && saveErr.message ? saveErr.message : '存储异常');
                            streamBubbleContent.appendChild(tip);
                        }
                    }
                    window._wrCurrentReportId = savedId;

                    // 在气泡下方追加操作按钮
                    if (aiBubble) {
                        const actionsDiv = document.createElement('div');
                        actionsDiv.style.cssText = 'display:flex;gap:6px;flex-wrap:wrap;margin-top:4px;';
                        actionsDiv.innerHTML = `
                            <button onclick="${(savedId ? "wrCopyText('" + savedId + "')" : "wrCopyFromMemory()")}" style="padding:5px 10px;border:1px solid var(--border);border-radius:var(--radius-sm);background:#fff;font-size:0.78rem;cursor:pointer;">📋 复制</button>
                            <button onclick="${(savedId ? "wrDownloadText('" + savedId + "')" : "wrDownloadFromMemory()")}" style="padding:5px 10px;background:var(--primary);color:#fff;border:none;border-radius:var(--radius-sm);font-size:0.78rem;cursor:pointer;">📥 下载</button>
                            ${template && template.templateBuffer ? `<button onclick="wrDownloadDocxFromTemplate()" style="padding:5px 10px;background:var(--primary);color:#fff;border:none;border-radius:var(--radius-sm);font-size:0.78rem;cursor:pointer;">📄 导出DOCX</button>` : ''}
                            <button onclick="wrSpeak('${savedId}')" style="padding:5px 10px;border:1px solid #cbd5e1;border-radius:var(--radius-sm);background:#fff;font-size:0.78rem;cursor:pointer;">🔊 朗读</button>

                            <button onclick="wrRegenerate()" style="padding:5px 10px;border:1px solid #cbd5e1;border-radius:var(--radius-sm);background:#fff;font-size:0.78rem;cursor:pointer;">🔄 重新生成</button>

                            <span style="font-size:0.72rem;color:#059669;align-self:center;">✅ 已保存</span>
                        `;
                        aiBubble.appendChild(actionsDiv);
                    }

                    document.getElementById('wr-query-input').placeholder = '继续提出修改需求…';
                    wrUpdateConvBtn();
                } catch(err) {
                    if (err.name === 'AbortError') {
                        if (window._wrTimedOut) {
                            // 【修复 E1】生成超时（非用户主动停止）
                            if (streamBubbleContent) {
                                streamBubbleContent.style.background = '#fff5f5';
                                streamBubbleContent.style.color = '#e53e3e';
                                streamBubbleContent.textContent = '⏱️ 生成超时（' + (_wrTimeoutMs / 1000) + 's）：模型响应时间过长，请稍后重试，或检查网络/API 状态。';
                            }
                        } else {
                            if (streamBubbleContent) {
                                streamBubbleContent.style.background = '#eff6ff';
                                streamBubbleContent.textContent = '⏹️ 已停止生成';
                            }
                        }
                        if (aiBubble) wrAppendRetryBtn(aiBubble);
                    } else {
                        let msg = err.message || '未知错误';
                        if (msg.includes('Failed to fetch')) msg = 'CORS跨域限制：当前API不支持浏览器直接访问，建议切换DeepSeek';
                        if (streamBubbleContent) {
                            streamBubbleContent.style.background = '#fff5f5';
                            streamBubbleContent.style.color = '#e53e3e';
                            streamBubbleContent.textContent = '❌ 生成失败：' + msg;
                        }
                        if (aiBubble) wrAppendRetryBtn(aiBubble);
                    }
                } finally {
                    clearTimeout(_wrTimeout);
                    if (writeBtn) { writeBtn.disabled = false; writeBtn.textContent = '✍️ 开始写作'; }
                    if (stopBtn) stopBtn.style.display = 'none';
                    _wrAbortController = null;
                    window._wrTimedOut = false;
                }
            };


            // 语音朗读：reportId 由气泡上的按钮传入。
            // 原实现无形参、只读全局 _wrCurrentReportContent，导致连续生成多篇后
            // 点早期气泡的「朗读」播放的是最新一篇的正文。
            window.wrSpeak = async function(reportId) {
                let text = window._wrCurrentReportContent || '';
                if (reportId != null && reportId !== '' && String(reportId) !== String(window._wrCurrentReportId)) {
                    try {
                        const rec = await wrDbGet(WR_RPT_STORE, reportId);
                        if (rec && rec.content) text = rec.content;
                    } catch (e) { /* 查库失败则退回当前内容 */ }
                }
                text = (text || '').replace(/【数据[^\]】]*】/g, '');
                if (!text.trim()) return;
                try {
                    if (window.speechSynthesis) {
                        window.speechSynthesis.cancel();
                        const u = new SpeechSynthesisUtterance(text);
                        u.lang = 'zh-CN'; u.rate = 1; u.pitch = 1;
                        window.speechSynthesis.speak(u);
                    }
                } catch (e) {}
            };

            // 重新生成（移除末轮对话，复用原 query 重发）
            window.wrRegenerate = function() {
                let q = window._wrCurrentReportQuery;
                if (!q || !q.trim()) q = (document.getElementById('wr-query-input') || {}).value || '';
                if (!q.trim()) { alert('没有可重新生成的内容'); return; }
                const histEl = document.getElementById('wr-chat-history');
                if (histEl) {
                    const rows = histEl.querySelectorAll('.ds-row-assistant');
                    if (rows.length) rows[rows.length - 1].remove();
                }
                while (_wrConvHistory.length && _wrConvHistory[_wrConvHistory.length - 1].role === 'assistant') _wrConvHistory.pop();
                while (_wrConvHistory.length && _wrConvHistory[_wrConvHistory.length - 1].role === 'user') _wrConvHistory.pop();
                document.getElementById('wr-query-input').value = (window._wrCurrentReportOrigQuery != null ? window._wrCurrentReportOrigQuery : q);
                wrGenerate(true);
            };

            // 在气泡下追加「重新生成」按钮（停止/失败时使用）
            function wrAppendRetryBtn(bubble) {
                if (!bubble) return;
                const d = document.createElement('div');
                d.style.cssText = 'display:flex;gap:6px;flex-wrap:wrap;margin-top:4px;';
                d.innerHTML = '<button onclick="wrRegenerate()" style="padding:5px 10px;border:1px solid #cbd5e1;border-radius:var(--radius-sm);background:#fff;font-size:0.78rem;cursor:pointer;">🔄 重新生成</button>';
                bubble.appendChild(d);
            }

            // 停止写作生成
            window.stopWrGeneration = function() {
                if (_wrAbortController) _wrAbortController.abort();
            };

            // ---- 修改报告功能：选择增加资料后确认完成 ----
            window.wrModifyReport = function() {
                // 检查是否有当前报告
                if (!window._wrCurrentReportContent) {
                    alert('请先生成报告，然后再进行修改。');
                    return;
                }
                
                // 获取所有可用资料
                wrDbGetAll(WR_MAT_STORE).then(mats => {
                    // 过滤出非模板的资料
                    const materials = mats.filter(m => m.matType !== 'template');
                    
                    // 按类型分组
                    const groups = {};
                    materials.forEach(m => {
                        const typeLabel = (WR_MAT_TYPES[m.matType] || {}).label || m.matType || '其它';
                        if (!groups[typeLabel]) groups[typeLabel] = [];
                        groups[typeLabel].push(m);
                    });

                    let matHtml = '<div style="display:flex;flex-direction:column;gap:10px;max-height:50vh;overflow-y:auto;">';
                    
                    if (materials.length === 0) {
                        matHtml += '<div style="padding:20px;text-align:center;color:var(--text-secondary);font-size:0.85rem;">暂无可用资料</div>';
                    } else {
                        Object.keys(groups).forEach(typeLabel => {
                            matHtml += '<div style="margin-bottom:8px;">';
                            matHtml += '<div style="font-size:0.8rem;font-weight:600;color:var(--primary);margin-bottom:4px;padding:4px 8px;background:#f0f7ff;border-radius:4px;">' + typeLabel + '</div>';
                            matHtml += '<div style="display:flex;flex-direction:column;gap:4px;">';
                            groups[typeLabel].forEach(m => {
                                // 检查是否已选中
                                const isChecked = window._wrSelectedMaterialIds && window._wrSelectedMaterialIds.includes(m.id) ? 'checked' : '';
                                matHtml += '<label style="display:flex;align-items:center;gap:8px;padding:8px 10px;border:1px solid var(--border);border-radius:6px;background:var(--card-bg);cursor:pointer;font-size:0.85rem;" onmouseover="this.style.background=\'#eff6ff\'" onmouseout="this.style.background=\'#f8fafc\'">'
                                    + '<input type="checkbox" class="wr-modify-mat-checkbox" value="' + m.id + '" ' + isChecked + ' style="cursor:pointer;">'
                                    + '<span style="flex:1;">' + wrEsc(m.title || m.fileName) + '</span>'
                                    + '<span style="font-size:0.75rem;color:var(--text-secondary);">' + wrFmtDate(m.importAt).slice(0,10) + '</span>'
                                    + '</label>';
                            });
                            matHtml += '</div></div>';
                        });
                    }
                    matHtml += '</div>';

                    const modal = document.createElement('div');
                    modal.id = 'wr-modify-modal';
                    modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.45);z-index:10100;display:flex;align-items:center;justify-content:center;';
                    modal.innerHTML = '<div style="background:#fff;border-radius:14px;padding:20px;width:min(480px,95vw);max-height:85vh;display:flex;flex-direction:column;gap:12px;">'
                        + '<div style="display:flex;align-items:center;justify-content:space-between;">'
                        + '<span style="font-weight:700;font-size:0.97rem;color:var(--primary);">📝 补充 / 修改报告 - 增加资料</span>'
                        + '<button onclick="this.closest(\'[style*=position\\:fixed]\').remove()" style="background:none;border:none;cursor:pointer;font-size:1.2rem;color:#888;">✕</button>'
                        + '</div>'
                        + '<div style="font-size:0.8rem;color:var(--text-secondary);">① 勾选要补充的资料（可多选）；② 补充/修改要求写在下方的写作需求输入框。<br>两者至少填一项 —— 确认后 AI 会在当前报告上按对应章节位置补充完善（不需要原模板/原资料）。</div>'
                        + matHtml
                        + '<div style="display:flex;gap:10px;margin-top:8px;">'
                        + '<button onclick="wrConfirmModify()" style="flex:1;padding:10px;background:var(--primary);color:#fff;border:none;border-radius:8px;font-size:0.9rem;font-weight:600;cursor:pointer;">✅ 确认完成报告</button>'
                        + '<button onclick="document.getElementById(\'wr-modify-modal\').remove()" style="padding:10px 16px;border:1px solid var(--border);border-radius:8px;background:#f8fafc;font-size:0.9rem;cursor:pointer;">取消</button>'
                        + '</div>'
                        + '</div>';
                    document.body.appendChild(modal);
                });
            };

            // 确认修改报告（"继续修改 = 补充"，2026-09-18 用户口径）
            //   ① 不再重新检索，也不带入原模板/原资料/台账（底稿里已含结构与被采纳内容）；
            //   ② 输入框只留"补充/修改要求"，整篇底稿由系统注入（不再拼进输入框让用户编辑）；
            //   ③ 只勾资料、或只写要求，都能继续（原来不勾资料直接 return）。
            window.wrConfirmModify = async function() {
                const checkboxes = document.querySelectorAll('#wr-modify-modal .wr-modify-mat-checkbox:checked');
                const selectedIds = Array.from(checkboxes).map(cb => parseInt(cb.value));
                window._wrSelectedMaterialIds = selectedIds;
                document.getElementById('wr-modify-modal')?.remove();

                // 上一轮报告作为底稿
                const previousReport = window._wrCurrentReportContent;
                if (!previousReport) { alert('没有可修改的报告'); return; }

                const input = document.getElementById('wr-query-input');
                const ask = input ? String(input.value || '').trim() : '';
                if (!selectedIds.length && !ask) {
                    alert('请勾选要补充的资料，或在输入框写下补充/修改要求（二者至少填一项）。');
                    return;
                }

                // 取勾选资料的正文，作为本轮【新增资料】
                let suppMats = [];
                if (selectedIds.length) {
                    try {
                        const allMats = await wrDbGetAll(WR_MAT_STORE);
                        suppMats = allMats
                            .filter(m => selectedIds.includes(m.id) && m.matType !== 'template')
                            .map(m => ({ title: m.title || m.fileName || '资料', content: m.content || '', matType: m.matType, fileName: m.fileName }));
                    } catch (e) { console.warn('[writer] 读取新增资料失败：', e && e.message); }
                }

                window._wrModifyMode = true;
                window._wrModifyBaseContent = previousReport;
                window._wrModifyBaseTitle = String(window._wrCurrentReportQuery || '报告').slice(0, 30);
                window._wrModifyCategory = 'other';
                window._wrModifySuppMats = suppMats;
                try {
                    await wrGenerate();
                } finally {
                    window._wrModifyMode = false;
                    window._wrModifyBaseContent = null;
                    window._wrModifyBaseTitle = null;
                    window._wrModifyCategory = null;
                    window._wrModifySuppMats = null;
                }
            };

            window.wrClearResult = function() {
                wrClearConversation();
            };

            // 复制报告全文
            // 【修复 D4】保存失败时的内存兜底复制（不依赖数据库）
            window.wrCopyFromMemory = async function() {
                try {
                    const text = window._wrCurrentReportContent || '';
                    if (!text) return alert('暂无可复制内容');
                    await navigator.clipboard.writeText(text);
                    alert('已复制到剪贴板！（当前内容来自本次生成，未存入资料库）');
                } catch(e) { alert('复制失败，请手动选中内容复制。'); }
            };
            window.wrDownloadFromMemory = function() {
                const text = window._wrCurrentReportContent || '';
                if (!text) return alert('暂无可下载内容');
                const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
                window.downloadBlob(blob, ((window._wrCurrentReportOrigQuery || '报告').slice(0, 20)) + '.txt');
            };
            window.wrCopyText = async function(id) {
                try {
                    const reports = await wrDbGetAll(WR_RPT_STORE);
                    const r = id ? reports.find(x => x.id == id) : null;
                    const text = r ? r.content : (document.getElementById('wr-stream-content') || {}).textContent || '';
                    await navigator.clipboard.writeText(text);
                    alert('已复制到剪贴板！');
                } catch(e) { alert('复制失败，请手动选中内容复制。'); }
            };

            // 下载报告TXT
            window.wrDownloadText = async function(id) {
                const reports = await wrDbGetAll(WR_RPT_STORE);
                const r = id ? reports.find(x => x.id == id) : null;
                const text = r ? r.content : '';
                if (!text) return alert('内容为空');
                const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
                window.downloadBlob(blob, ((r && r.title) || '报告') + '.txt');
            };

            // ================================================================
            // ── 模板管理 ──
            // ================================================================
            window.wrRenderTplList = async function() {
                const templates = await wrDbGetAll(WR_TPL_STORE);
                const listEl = document.getElementById('wr-tpl-list');
                const countEl = document.getElementById('wr-tpl-count');
                if (!listEl) return;
                if (countEl) countEl.textContent = '共 ' + templates.length + ' 个模板';

                if (!templates.length) {
                    listEl.innerHTML = '<div style="text-align:center;padding:30px;color:var(--text-secondary);font-size:0.85rem;">暂无模板，点击「新建模板」或添加内置模板</div>';
                    return;
                }

                listEl.innerHTML = templates.map(t => `
                    <div style="background:#fff;border:1px solid var(--border);border-radius:10px;padding:12px 14px;display:flex;align-items:center;gap:10px;">
                        <div style="flex:1;min-width:0;">
                            <div style="font-weight:700;font-size:0.9rem;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${wrEsc(t.title)}</div>
                            <div style="font-size:0.75rem;color:var(--text-secondary);margin-top:2px;">
                                <span style="background:#eff6ff;color:#1d4ed8;padding:1px 8px;border-radius:10px;margin-right:6px;">${wrEsc(wrCatName(t.category))}</span>
                                ${wrFmtDate(t.updatedAt || t.createdAt)}
                                <span style="margin-left:6px;">约${Math.round((t.content||'').length/2)}字</span>
                            </div>
                        </div>
                        <div style="display:flex;gap:4px;flex-shrink:0;">
                            <button onclick="wrEditTemplate(${t.id})" style="padding:5px 10px;border:1px solid var(--border);border-radius:var(--radius-sm);background:#f8fafc;font-size:0.78rem;cursor:pointer;">编辑</button>
                            <button onclick="wrDeleteTemplate(${t.id})" style="padding:5px 10px;border:1px solid #fca5a5;border-radius:var(--radius-sm);background:#fff1f2;color:#b91c1c;font-size:0.78rem;cursor:pointer;">删除</button>
                        </div>
                    </div>`).join('');
            };

            window.wrShowAddTemplate = function() {
                document.getElementById('wr-tpl-modal-title').textContent = '📝 新建模板';
                document.getElementById('wr-tpl-name').value = '';
                document.getElementById('wr-tpl-category').value = 'custom';
                document.getElementById('wr-tpl-content').value = '';
                delete document.getElementById('wr-tpl-modal')._editId;
                document.getElementById('wr-tpl-modal').style.display = 'flex';
                // 打开即刷新已有模板列表，否则新建表单下方永远是空的
                if (typeof window.wrRenderTplList === 'function') {
                    try { window.wrRenderTplList(); } catch (e) {}
                }
                setTimeout(() => document.getElementById('wr-tpl-name').focus(), 50);
            };

            window.wrEditTemplate = async function(id) {
                const templates = await wrDbGetAll(WR_TPL_STORE);
                const t = templates.find(x => x.id === id);
                if (!t) return;
                document.getElementById('wr-tpl-modal-title').textContent = '✏️ 编辑模板';
                document.getElementById('wr-tpl-name').value = t.title || '';
                document.getElementById('wr-tpl-category').value = t.category || 'custom';
                document.getElementById('wr-tpl-content').value = t.content || '';
                document.getElementById('wr-tpl-modal')._editId = id;
                document.getElementById('wr-tpl-modal').style.display = 'flex';
                // 登记编辑会话（折叠屏重建后自动重开此模板编辑弹窗）
                if (window._editSession) window._editSession.set({ module: 'writer', recordId: id, kind: 'template' });
            };
            // 折叠屏/旋转重建后，自动重开写作模板编辑弹窗
            window.restoreEdit_writer = function(ctx) {
                if (!ctx || !ctx.recordId) return;
                if (typeof window.wrEditTemplate === 'function') {
                    try { window.wrEditTemplate(ctx.recordId); } catch (e) { console.warn('restoreEdit_writer 失败', e); }
                }
            };

            window.wrCloseTemplateModal = function() {
                const modal = document.getElementById('wr-tpl-modal');
                if (modal) { modal.style.display = 'none'; modal._editId = null; }
                if (window._editSession) window._editSession.clear();
            };

            window.wrSaveTemplate = async function() {
                const modal = document.getElementById('wr-tpl-modal');
                const title = (document.getElementById('wr-tpl-name').value || '').trim();
                const category = document.getElementById('wr-tpl-category').value || 'custom';
                const content = (document.getElementById('wr-tpl-content').value || '').trim();
                if (!title) { alert('请输入模板名称'); return; }
                if (!content) { alert('请输入模板内容'); return; }
                const now = Date.now();
                const item = { title, category, content, updatedAt: now };
                if (modal._editId) {
                    item.id = modal._editId;
                    // 编辑时不要覆盖 createdAt：原实现写死 now，会把模板的创建时间
                    // 每次编辑都刷成当前时间，列表里「约X字 / 日期」失去参考价值
                    const _old = await wrDbGet(WR_TPL_STORE, modal._editId);
                    item.createdAt = (_old && _old.createdAt) ? _old.createdAt : now;
                } else {
                    item.createdAt = now;
                }
                // 写库失败时必须收尾：原实现未包裹 try/catch，异常会直接抛出，
                // 导致弹窗不关、_editId 不清、_editSession 不清理 ——
                // 用户卡在编辑弹窗，且折叠屏重建后会再次弹出同一个编辑框。
                try {
                    await wrDbPut(WR_TPL_STORE, item);
                } catch (e) {
                    alert('模板保存失败：' + ((e && e.message) || '未知错误'));
                    return;
                }
                modal.style.display = 'none';
                modal._editId = null;
                if (window._editSession) window._editSession.clear();
                wrRenderTplList();
                alert('模板保存成功！');
            };

            window.wrDeleteTemplate = async function(id) {
                if (!confirm('确定要删除该模板吗？')) return;
                await wrDbDelete(WR_TPL_STORE, id);
                wrRenderTplList();
            };

            window.wrAddBuiltinTemplate = async function(type) {
                const tpl = WR_BUILTIN_TEMPLATES[type];
                if (!tpl) return;
                const existing = await wrDbGetAll(WR_TPL_STORE);
                const dup = existing.find(t => t.title === tpl.title);
                if (dup) { alert('已存在同名模板《' + tpl.title + '》，请先删除或编辑旧模板。'); return; }
                const now = Date.now();
                await wrDbPut(WR_TPL_STORE, { title: tpl.title, category: tpl.category, content: tpl.content.trim(), createdAt: now, updatedAt: now });
                wrRenderTplList();
                alert('内置模板《' + tpl.title + '》已添加！');
            };

            window.wrImportTemplates = function() {
                const inp = document.createElement('input');
                inp.type = 'file'; inp.accept = '.json'; inp.style.display = 'none';
                // 【2026-09-21】取消选择也要回收隐藏 input（原来只在 onchange 里 remove，取消一次在 body 里留一个）
                inp.addEventListener('cancel', function() { try { inp.remove(); } catch (e) {} });
                inp.onchange = async function(e) {
                    const file = e.target.files[0]; if (!file) return;
                    // 【2026-09-21】`file.text()` 原来在 try **之外**：读取失败（文件被占用/权限）会变成未捕获异常，
                    //   用户看不到任何提示；另外"全部无效"（count=0）原来也报"成功导入 0 个"。
                    try {
                        const text = await file.text();
                        const data = JSON.parse(text);
                        const arr = Array.isArray(data) ? data : (data.templates || []);
                        let count = 0;
                        const now = Date.now();
                        for (const t of arr) {
                            if (t.title && t.content) {
                                await wrDbPut(WR_TPL_STORE, { title: t.title, category: t.category||'custom', content: t.content, createdAt: now, updatedAt: now });
                                count++;
                            }
                        }
                        wrRenderTplList();
                        var _tm = count > 0 ? '✅ 成功导入 ' + count + ' 个模板' : '⚠️ 文件中没有可用模板（每条需含 title 与 content）';
                        if (window.showToast) window.showToast(_tm, count === 0, 8000); else alert(_tm);
                    } catch(err) {
                        var _te = '模板导入失败：' + ((err && err.message) || '未知错误');
                        if (window.showToast) window.showToast(_te, true, 9000); else alert(_te);
                    }
                    inp.remove();
                };
                document.body.appendChild(inp); inp.click();
            };

            window.wrExportTemplates = async function() {
                const templates = await wrDbGetAll(WR_TPL_STORE);
                if (!templates.length) { alert('暂无模板可导出'); return; }
                const blob = new Blob([JSON.stringify({ templates, exportDate: new Date().toISOString() }, null, 2)], { type: 'application/json' });
                window.downloadBlob(blob, '写作模板备份_' + window.localDateStr() + '.json');
            };

            // ================================================================
            // ── 历史报告管理 ──
            // ================================================================
            async function wrSaveReport(report) {
                const saved = await wrDbPut(WR_RPT_STORE, report);
                return saved;
            }

            // ---- 占位符提取函数 ----
            function extractPlaceholders(text) {
                const regex = /\{\{([^}]+)\}\}/g;
                const matches = new Set();
                let m;
                while ((m = regex.exec(text)) !== null) {
                    matches.add(m[1]);
                }
                return Array.from(matches);
            }

            // ---- 解析 AI 返回的 JSON 映射 ----
            function wrParseMapping(text) {
                try {
                    const trimmed = text.trim();
                    // 尝试直接解析 JSON
                    if (trimmed.startsWith('{')) {
                        const parsed = JSON.parse(trimmed);
                        if (typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
                    }
                } catch(e) {
                    console.log('[wrParseMapping] 直接解析失败:', e.message);
                }
                try {
                    // 尝试从 markdown 代码块中提取
                    let jsonStr = null;
                    const mdMatch = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
                    if (mdMatch) {
                        jsonStr = mdMatch[1].trim();
                    } else {
                        // 使用贪婪匹配找到最后一个完整的 JSON 对象
                        const braceMatch = text.match(/(\{[\s\S]*\})/);
                        if (braceMatch) jsonStr = braceMatch[1].trim();
                    }
                    if (jsonStr) {
                        const parsed = JSON.parse(jsonStr);
                        if (typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
                    }
                } catch(e) {
                    console.log('[wrParseMapping] 提取解析失败:', e.message);
                }
                return null;
            }

            // 稳健抽取首个「平衡」JSON 对象（容忍尾注/解释文本），用于占位符映射兜底
            function _wrExtractJson(text) {
                const start = text.indexOf('{');
                if (start < 0) return null;
                let depth = 0, inStr = false, esc = false;
                for (let i = start; i < text.length; i++) {
                    const c = text[i];
                    if (esc) { esc = false; continue; }
                    if (c === '\\') { esc = true; continue; }
                    if (c === '"') { inStr = !inStr; continue; }
                    if (inStr) continue;
                    if (c === '{') depth++;
                    else if (c === '}') { depth--; if (depth === 0) { try { return JSON.parse(text.slice(start, i + 1)); } catch (e) { return null; } } }
                }
                return null;
            }

            // ---- 真正应用占位符替换 ----
            // 气泡 HTML 白名单净化：可用 DOMPurify 时净化（保留标题/表格等排版），
            // 否则退化为全转义（宁可排版变纯文本，也不能执行注入脚本）
            function wrSafeBubbleHtml(html) {
                var raw = String(html == null ? '' : html);
                if (!raw) return '';
                if (typeof DOMPurify !== 'undefined' && DOMPurify.sanitize) {
                    try { return DOMPurify.sanitize(raw); } catch (e) {}
                }
                return wrEsc(raw).replace(/\n/g, '<br>');
            }

            function applyTemplatePlaceholders(templateContent, mapping) {
                if (!templateContent || !mapping) return templateContent;
                let result = templateContent;
                for (const [key, value] of Object.entries(mapping)) {
                    const placeholder = `{{${key}}}`;
                    // 替换值来自 AI 输出，先转义再拼接，防止模板渲染路径 XSS（模板自身 HTML 结构保留）
                    result = result.split(placeholder).join(wrEsc(String(value)));
                }
                // 清理未替换的占位符
                result = result.replace(/\{\{([^}]+)\}\}/g, '（待补充）');
                return result;
            }

            // ---- 导出 DOCX（使用 html-docx-js） ----
            // 把 Markdown 渲染为带语义标签的 HTML，确保标题/表格/列表/粗体/引用在 Word 中正确呈现
            function wrMdToDocxHtml(md) {
                md = String(md || '');
                // 若已是结构化 HTML（理论上 content 均存 Markdown，此处兜底防重复转义）
                if (/<(p|h[1-6]|ul|ol|table|blockquote)\b/i.test(md)) return md;
                return (typeof window.dsMarkdown === 'function') ? window.dsMarkdown(md) : md;
            }
            // 解析报告关联的「上传模板」原始字节（.docx），用于「按模板导出」。
            // 报告在保存时记录 templateId；模板字节存在资料库条目的 templateBuffer 上（导入时写入）。
            async function wrResolveTemplateBytes(report) {
                try {
                    if (report && report.templateId != null) {
                        let tpl = null;
                        try { tpl = await wrDbGet(WR_MAT_STORE, report.templateId); } catch (e) {}
                        if (!tpl || !tpl.templateBuffer) {
                            try {
                                const t = await wrDbGet(WR_TPL_STORE, report.templateId);
                                if (t && t.templateBuffer) tpl = t;
                            } catch (e) {}
                        }
                        if (tpl && tpl.templateBuffer) return tpl.templateBuffer;
                    }
                    // 兜底：资料库里恰好只有一个带原始字节的模板时直接使用它
                    const all = await wrDbGetAll(WR_MAT_STORE);
                    const withBuf = (all || []).filter(m => m && m.templateBuffer);
                    if (withBuf.length === 1) return withBuf[0].templateBuffer;
                } catch (e) {
                    console.warn('[wr] 读取模板字节失败：', e && e.message ? e.message : e);
                }
                return null;
            }

            window.wrDownloadDocxFromTemplate = async function() {
                const modal = document.getElementById('wr-report-modal');
                const report = modal && modal._currentReport;
                let content = null, title = '报告', tplBytes = null;
                if (report) {
                    content = report.content;
                    title = report.title || '报告';
                    tplBytes = await wrResolveTemplateBytes(report);
                } else if (window._wrCurrentReportContent) {
                    content = window._wrCurrentReportContent;
                } else {
                    alert('没有可导出的报告');
                    return;
                }
                await exportDocxFromHtml(wrMdToDocxHtml(content), title, { templateBytes: tplBytes });
            };

            // 导出排版偏好（公文格式 / 通用排版）：写入 localStorage，下次沿用
            window.wrSetDocxStyle = function(v) {
                if (!window.RGDocx) return;
                window.RGDocx.setStyle(v);
                if (typeof Toast !== 'undefined' && Toast.success) {
                    Toast.success('导出排版已切换为「' + (v === 'plain' ? '通用排版' : '公文格式') + '」');
                }
            };

            // 载入时把下拉框同步为上次选择
            (function syncDocxStyleSelect() {
                try {
                    const sel = document.getElementById('wr-docx-style');
                    if (sel && window.RGDocx) sel.value = window.RGDocx.getStyle();
                } catch (e) {}
            })();
            // 资料库查看弹窗：导出当前资料/报告为 DOCX
            window.wrDownloadDocxFromMaterial = async function() {
                const modal = document.getElementById('wr-mat-view-modal');
                if (!modal || !modal._content) { alert('没有可导出的内容'); return; }
                const title = (document.getElementById('wr-mat-view-title') && document.getElementById('wr-mat-view-title').textContent) || '资料';
                await exportDocxFromHtml(wrMdToDocxHtml(modal._content), title);
            };

            // 【v3.74】对外通用入口：任意 Markdown → DOCX（复用历史报告那套导出链路）
            //   智能对话气泡上的「📤 导出」按钮走这里：
            //   · 同一套 RGDocx 真·OOXML 引擎、同一份排版偏好（localStorage `wr_docx_style`：公文格式 / 通用排版）；
            //   · 失败时自动走 exportDocxFromHtml 内置的 html-docx-js / HTML .doc 兜底通道。
            window.wrExportMdToDocx = function(md, name) {
                if (!md || !String(md).trim()) { alert('没有可导出的内容'); return Promise.resolve(false); }
                return exportDocxFromHtml(wrMdToDocxHtml(String(md)), name || '智能对话');
            };

            // ---- 导出 DOCX ----
            // 通道优先级（v3.69 起）：
            //   A1 真·OOXML 引擎 + 上传模板填充（保住模板原版式，模板内无 {{占位符}} 时自动跳过）
            //   A2 真·OOXML 引擎独立生成（公文格式 GB/T 9704-2012 / 通用排版）
            //   B  html-docx-js（altChunk）—— 历史通道，仅当 A 失败时兜底
            //   C  HTML 版 .doc —— 完全离线兜底，Word/WPS 均可打开
            const WR_DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

            async function exportDocxFromHtml(htmlContent, fileName, opts) {
                opts = opts || {};
                if (!htmlContent || htmlContent.trim() === '') {
                    alert('报告内容为空，无法导出');
                    return;
                }
                // 去除 dsMarkdown 代码块内的「下载」按钮（Word 中无意义）
                let cleanHtml = String(htmlContent || '').replace(/<button\b[^>]*>[\s\S]*?<\/button>/gi, '');

                // ================= 通道 A：真·OOXML 引擎 =================
                if (window.RGDocx) {
                    const style = window.RGDocx.getStyle();
                    const notify = function(msg) {
                        if (typeof Toast !== 'undefined' && Toast.success) Toast.success(msg);
                        else alert(msg);
                    };
                    try {
                        // A1：模板填充
                        if (opts.templateBytes) {
                            const filled = await window.RGDocx.fillTemplate(
                                opts.templateBytes,
                                { title: fileName || '报告', html: cleanHtml },
                                { style: style }
                            );
                            if (filled && filled.bytes && filled.bytes.length > 1000) {
                                window.downloadBlob(new Blob([filled.bytes], { type: WR_DOCX_MIME }), (fileName || '报告') + '.docx');
                                notify('DOCX 已生成（套用上传模板' + (filled.stat && filled.stat.bodyInjected ? '·正文已注入' : '') + '）');
                                return;
                            }
                            console.log('[wr] 模板内未发现 {{正文}} 等占位符，改用标准排版独立生成');
                        }
                        // A2：独立生成（公文格式 / 通用排版）
                        const bytes = await window.RGDocx.fromHtml(cleanHtml, {
                            title: fileName || '报告',
                            style: style,
                            images: true
                        });
                        if (bytes && bytes.length > 1000) {
                            window.downloadBlob(new Blob([bytes], { type: WR_DOCX_MIME }), (fileName || '报告') + '.docx');
                            notify('DOCX 已生成（' + (style === 'plain' ? '通用排版' : '公文格式') + '）');
                            return;
                        }
                    } catch (e) {
                        console.warn('[wr] 真·OOXML 导出失败，回退 html-docx-js：', e && e.message ? e.message : e);
                    }
                }

                // ================= 通道 B/C：历史链路兜底 =================
                // 尝试加载 html-docx-js（国内手机网络可能失败，故用 try/catch 兜底，不抛出）
                if (typeof window.htmlDocx === 'undefined') {
                    try { await window.loadScript('src/js/vendor/html-docx.js'); }
                    catch (e) { /* 忽略，走下方离线兜底 */ }
                }
                if (typeof window.htmlDocx === 'undefined') {
                    try {
                        await new Promise((resolve) => {
                            const script = document.createElement('script');
                            script.src = 'src/js/vendor/html-docx.js';
                            script.onload = resolve;
                            script.onerror = resolve; // 失败也继续，走兜底
                            document.head.appendChild(script);
                        });
                    } catch (e) {}
                }
                const isMobile = /Mobi|Android/i.test(navigator.userAgent);
                // cleanHtml 已在函数开头生成（含代码块「下载」按钮剥离），此处不再重复处理
                var hasBlockHtml = /<(p|h[1-6]|ul|ol|li|table|thead|tbody|tr|td|th|blockquote|strong|em)\b/i.test(cleanHtml);
                // 手机端：若已是结构化 HTML（来自 dsMarkdown），原样保留；否则极简纯文本化
                if (isMobile) {
                    if (hasBlockHtml) {
                        // 已是结构化 HTML，原样使用，确保手机 Word 能显示标题/表格/列表
                        cleanHtml = cleanHtml;
                    } else {
                        var textOnly = cleanHtml.replace(/<br\s*\/?>/gi, '\n').replace(/<p[^>]*>/gi, '\n').replace(/<\/p>/gi, '').replace(/<[^>]+>/g, '');
                        var lines = textOnly.split(/\n+/);
                        var simpleBody = '';
                        for (var i = 0; i < lines.length; i++) {
                            var line = lines[i].trim();
                            if (line) simpleBody += '<p>' + _exportEsc(line) + '</p>';
                        }
                        if (cleanHtml.indexOf('<table') !== -1) {
                            var tableMatch = cleanHtml.match(/<table[\s\S]*?<\/table>/gi);
                            if (tableMatch) simpleBody += tableMatch.join('');
                        }
                        cleanHtml = simpleBody || '<p>（无内容）</p>';
                    }
                } else {
                    // 电脑端：若已是结构化 HTML（来自 dsMarkdown），原样使用；否则用基础 Markdown 转换器兜底
                    if (!hasBlockHtml) {
                        cleanHtml = cleanHtml.replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '');
                        const blocks = cleanHtml.split(/\n\n+/);
                        cleanHtml = blocks.map(function(b) {
                            b = b.trim(); if (!b) return '';
                            if (/^#{1,3}\s/.test(b)) return '<h3>' + b.replace(/^#{1,3}\s+/, '') + '</h3>';
                            if (/^[一二三四五六七八九十]、|^第[一二三四五六七八九十]章|^\d+[\.\、]/.test(b) && b.length < 80) return '<h3>' + b + '</h3>';
                            if (/\|.*\|/.test(b)) {
                                const rows = b.split('\n').filter(function(r){ return r.trim() && !/^[\|\s\-:]+$/.test(r.trim()); });
                                if (rows.length) return '<table border="1" cellpadding="4" cellspacing="0" style="border-collapse:collapse;width:100%;margin:8px 0;">' +
                                    rows.map(function(r){ return '<tr>' + r.split('|').filter(function(c){ return c.trim(); }).map(function(c){ return '<td style="padding:4px 8px;">' + c.trim() + '</td>'; }).join('') + '</tr>'; }).join('') + '</table>';
                            }
                            return '<p style="margin:0 0 8pt 0;line-height:1.5;">' + b.replace(/\n/g, '<br>') + '</p>';
                        }).filter(Boolean).join('\n');
                    }
                }
                // 最终统一包裹文档
                var fullHtml;
                if (isMobile) {
                    // 手机端：零 CSS，最小 HTML，确保 mobile Word 兼容
                    fullHtml = '<!DOCTYPE html>\n<html>\n<head>\n<meta charset="UTF-8">\n<title>' + _exportEsc(fileName) + '</title>\n</head>\n<body>\n' + cleanHtml + '\n</body>\n</html>';
                } else {
                    fullHtml = '<!DOCTYPE html>\n<html>\n<head>\n<meta charset="UTF-8">\n<title>' + _exportEsc(fileName) + '</title>\n<style>\n' +
                        'body{margin:20pt;padding:0;background:#fff;color:#000;font-family:"Times New Roman",SimSun,"宋体",serif;font-size:12pt;line-height:1.6;}\n' +
                        'h1{font-size:22pt;margin:16pt 0 6pt;}h2{font-size:18pt;margin:14pt 0 6pt;}h3{font-size:16pt;margin:12pt 0 6pt;}h4{font-size:14pt;margin:10pt 0 4pt;}\n' +
                        'p{margin:0 0 8pt 0;}\n' +
                        'table{border-collapse:collapse;width:100%;margin:8pt 0;}td,th{border:1px solid #aaa;padding:4pt 6pt;vertical-align:top;}\n' +
                        'ul,ol{margin:0 0 8pt 0;padding-left:22pt;}li{margin:2pt 0;}\n' +
                        'blockquote{margin:0 0 8pt 0;padding:6pt 10pt;border-left:3pt solid #ccc;color:#555;}\n' +
                        'strong{font-weight:bold;}em{font-style:italic;}a{color:#2563eb;}\n</style>\n</head>\n<body>\n' + cleanHtml + '\n</body>\n</html>';
                }
                // 优先生成 .docx；若 html-docx-js 不可用/异常，则离线兜底生成 .doc（Word/WPS 均可打开）
                var isFallbackDoc = false;
                var blob = null;
                if (typeof window.htmlDocx !== 'undefined') {
                    try { blob = window.htmlDocx.asBlob(fullHtml); } catch (e) { blob = null; }
                }
                if (!blob) {
                    isFallbackDoc = true;
                    blob = _buildWordHtmlBlob(cleanHtml, fileName);
                }
                window.downloadBlob(blob, (fileName || '报告') + (isFallbackDoc ? '.doc' : '.docx'));
                if (isFallbackDoc) {
                    if (typeof Toast !== 'undefined') Toast.success('已生成 Word 文档(.doc)，可离线打开');
                    else alert('已生成 Word 文档(.doc)，可离线打开；如需 .docx 请在电脑端导出。');
                } else {
                    if (typeof Toast !== 'undefined') Toast.success('DOCX 已生成');
                    else alert('DOCX 已生成，请根据提示保存文件');
                }
            }
            function _buildWordHtmlBlob(htmlBody, fileName) {
                // 离线兜底：生成 Word/WPS 均可打开的 HTML 文档(.doc)，无需外部库，手机端兼容
                var doc = '<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word" xmlns="http://www.w3.org/TR/REC-html40">'
                    + '<head><meta charset="utf-8"><title>' + _exportEsc(fileName || '报告') + '</title>'
                    + '<style>body{font-family:"Microsoft YaHei",SimSun,"宋体",serif;font-size:12pt;line-height:1.6;margin:20pt;}'
                    + 'h1{font-size:20pt;margin:16pt 0 6pt;}h2{font-size:17pt;margin:14pt 0 6pt;}h3{font-size:15pt;margin:12pt 0 6pt;}'
                    + 'p{margin:0 0 8pt 0;}table{border-collapse:collapse;width:100%;}td,th{border:1px solid #999;padding:4pt 6pt;vertical-align:top;}'
                    + 'ul,ol{margin:0 0 8pt 0;padding-left:22pt;}li{margin:2pt 0;}blockquote{margin:0 0 8pt 0;padding:6pt 10pt;border-left:3pt solid #ccc;color:#555;}</style>'
                    + '</head><body>' + (htmlBody || '<p>（无内容）</p>') + '</body></html>';
                return new Blob(['﻿' + doc], { type: 'application/msword' });
            }
            function _exportEsc(s) { return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

            // 一次性迁移：旧版报告缺 date 字段，wrFmtDate 会回退到 Date.now()，
            // 导致每次查看都显示“当前日期”。这里为缺失 date 的报告补齐一个稳定日期
            // （优先 createdAt/timestamp，否则取本次迁移时刻）并写回，之后即可稳定显示。
            let _wrDateMigrated = false;
            async function wrMigrateReportDates(reports) {
                if (_wrDateMigrated) return;
                _wrDateMigrated = true;
                const need = (reports || []).filter(r => r && r.date == null);
                if (!need.length) return;
                for (const r of need) {
                    r.date = r.createdAt || r.timestamp || Date.now();
                    try { await wrDbPut(WR_RPT_STORE, r); } catch (e) { console.warn('[wr] 迁移报告日期失败', e); }
                }
            }

            window.wrRenderHistory = async function() {
                const reports = await wrDbGetAll(WR_RPT_STORE);
                await wrMigrateReportDates(reports);
                const listEl  = document.getElementById('wr-history-list');
                const countEl = document.getElementById('wr-hist-count');
                if (!listEl) return;

                const q = ((document.getElementById('wr-hist-search') || {}).value || '').toLowerCase();
                const filtered = reports.filter(r =>
                    !q || (r.title||'').toLowerCase().includes(q) || (r.content||'').slice(0,200).toLowerCase().includes(q)
                ).sort(wrByTimeDesc);   // 【2026-09-22】统一倒序口径（时间相同按 id 兜底，顺序稳定不跳）

                if (countEl) countEl.textContent = filtered.length + '/' + reports.length + ' 篇';
                var setCount = document.getElementById('set-wrhist-count');
                if (setCount) setCount.textContent = reports.length + '篇';

                if (!filtered.length) {
                    listEl.innerHTML = '<div style="text-align:center;padding:30px;color:var(--text-secondary);font-size:0.85rem;">' + (q ? '无匹配结果' : '暂无历史报告') + '</div>';
                    return;
                }

                listEl.innerHTML = filtered.map(r => `
                    <div class="wr-mat-card">
                        <div style="flex:1;min-width:0;cursor:pointer;" onclick="wrViewReport(${JSON.stringify(r.id)})">
                            <div style="font-weight:700;font-size:0.9rem;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--primary);">${wrEsc(r.title||'未命名报告')}</div>
                            <div style="font-size:0.75rem;color:var(--text-secondary);margin:3px 0;">
                                ${r.source ? '<span style="background:#e0e7ff;color:#3730a3;padding:1px 8px;border-radius:10px;margin-right:6px;">📍 ' + wrEsc(r.source) + '</span>' : ''}<span style="background:#f0fdf4;color:#15803d;padding:1px 8px;border-radius:10px;margin-right:6px;">${wrEsc(wrCatName(r.category))}</span>
                                ${wrFmtDate(r.date)}
                                <span style="margin-left:6px;">约${Math.round((r.content||'').length/2)}字</span>
                            </div>
                            <div style="font-size:0.78rem;color:#64748b;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${wrEsc((r.content||'').replace(/\n/g,' ').slice(0,80))}…</div>
                        </div>
                        <div style="display:flex;flex-direction:row;flex-wrap:wrap;gap:6px;flex-basis:100%;flex-shrink:0;margin-top:4px;">
                            <button onclick="wrViewReport(${JSON.stringify(r.id)})" class="wr-mat-btn wr-mat-btn-view">查看</button>
                            <button onclick="wrModifyHistoryReport(${JSON.stringify(r.id)})" class="wr-mat-btn wr-mat-btn-template">✏️ 修改</button>
                            <button onclick="wrDeleteReport(${JSON.stringify(r.id)})" class="wr-mat-btn wr-mat-btn-delete">删除</button>
                        </div>
                    </div>`).join('');
            };

            window.wrViewReport = async function(id) {
                const reports = await wrDbGetAll(WR_RPT_STORE);
                let r = reports.filter(x => x && x.id === id)[0];
                // 兜底：直接按主键取（兼容 getAll 不返回 keyPath 的浏览器）
                if (!r) {
                    try {
                        var db = await wrOpenDB();
                        r = await new Promise(function(resolve) {
                            var tx = db.transaction(WR_RPT_STORE, 'readonly');
                            var req = tx.objectStore(WR_RPT_STORE).get(id);
                            req.onsuccess = function(e) { resolve(e.target.result); };
                            req.onerror = function() { resolve(null); };
                        });
                    } catch(e) {}
                }
                if (!r) {
                    console.warn('[wr] 未找到报告 id=', id);
                    alert('未找到该报告，可能已被删除或数据异常。');
                    return;
                }
                const modal = document.getElementById('wr-report-modal');
                document.getElementById('wr-report-modal-title').textContent = r.title || '未命名报告';
                document.getElementById('wr-report-modal-meta').textContent =
                    '类型：' + wrCatName(r.category) + '　生成时间：' + wrFmtDate(r.date)
                    + (r.materialCount && (r.materialCount.issues + r.materialCount.rules + r.materialCount.reports) > 0
                        ? '　引用台账：' + r.materialCount.issues + '条，规章：' + r.materialCount.rules + '条，历史报告：' + r.materialCount.reports + '篇' : '');
                document.getElementById('wr-report-modal-content').innerHTML = (window.dsMarkdown ? window.dsMarkdown(r.content || '') : (r.content || ''));
                modal._currentReport = r;
                modal.style.display = 'flex';
            };

            window.wrCopyReport = async function() {
                const modal = document.getElementById('wr-report-modal');
                const r = modal._currentReport;
                if (!r) return;
                const ok = await window.copyTextToClipboard(r.content);
                alert(ok ? '已复制到剪贴板！' : '复制失败，请长按报告内容手动选中复制。');
            };

            // 从查看弹窗进入修改
            window.wrModifyReportFromView = function() {
                const modal = document.getElementById('wr-report-modal');
                const r = modal._currentReport;
                if (!r || !r.id) return;
                modal.style.display = 'none';
                wrModifyHistoryReport(r.id);
            };

            window.wrDownloadReport = function() {
                const modal = document.getElementById('wr-report-modal');
                const r = modal._currentReport;
                if (!r) return;
                // 【2026-09-21】补空内容判断：原来空报告也照样下载一个 0 字节 txt，用户以为导出失败
                if (!String(r.content || '').trim()) {
                    if (window.showToast) window.showToast('该报告内容为空，无法下载', true, 6000); else alert('报告内容为空');
                    return;
                }
                const blob = new Blob([r.content], { type: 'text/plain;charset=utf-8' });
                window.downloadBlob(blob, (r.title || '报告') + '.txt');
            };

            window.wrDeleteReport = async function(id) {
                if (!confirm('确定删除该历史报告吗？')) return;
                await wrDbDelete(WR_RPT_STORE, id);
                const modal = document.getElementById('wr-report-modal');
                if (modal._currentReport && modal._currentReport.id === id) modal.style.display = 'none';
                wrRenderHistory();
            };

            // 修改历史报告（支持补充资料）
            window.wrModifyHistoryReport = async function(id) {
                const reports = await wrDbGetAll(WR_RPT_STORE);
                const r = reports.find(x => x.id === id);
                if (!r) { alert('报告未找到'); return; }

                // 载入资料库（非模板）与历史报告，供「补充资料」勾选（可从其它报告中抽取部分内容补充）
                let mats = [];
                try { mats = (await wrDbGetAll(WR_MAT_STORE)).filter(m => m.matType !== 'template'); } catch(e) { mats = []; }
                let otherReports = [];
                try { otherReports = (await wrDbGetAll(WR_RPT_STORE)).filter(x => x.id !== r.id); } catch(e) { otherReports = []; }
                // 统一补充来源（资料 + 其它历史报告），checkbox value 为 suppList 索引
                const suppList = [];
                mats.forEach(m => suppList.push({ kind: 'mat', id: m.id, title: (m.title || m.fileName || '资料'), label: (WR_MAT_TYPES[m.matType] || {}).label || m.matType || '其它', content: m.content || '' }));
                otherReports.forEach(rp => suppList.push({ kind: 'report', id: rp.id, title: (rp.title || '未命名报告'), label: '历史报告', content: rp.content || '' }));
                let matHtml = '<div style="display:flex;flex-direction:column;gap:6px;max-height:200px;overflow-y:auto;border:1px solid var(--border);border-radius:8px;padding:8px;background:var(--bg);">';
                if (!suppList.length) {
                    matHtml += '<div style="padding:10px;text-align:center;color:var(--text-secondary);font-size:0.82rem;">暂无可用资料或其它报告（可在「资料中心」导入）</div>';
                } else {
                    const matGroups = {};
                    suppList.forEach((s, idx) => { if (s.kind === 'mat') { const t = s.label; (matGroups[t] = matGroups[t] || []).push(idx); } });
                    Object.keys(matGroups).forEach(t => {
                        matHtml += '<div style="font-size:0.76rem;font-weight:600;color:var(--primary);margin:4px 0 2px;">' + wrEsc(t) + '</div>';
                        matGroups[t].forEach(idx => {
                            const s = suppList[idx];
                            matHtml += '<label style="display:flex;align-items:center;gap:8px;padding:6px 8px;border:1px solid var(--border);border-radius:6px;background:var(--card-bg);cursor:pointer;font-size:0.82rem;">'
                                + '<input type="checkbox" class="wr-modify-hist-mat" value="' + idx + '" style="cursor:pointer;">'
                                + '<span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + wrEsc(s.title) + '</span></label>';
                        });
                    });
                    const reportIdxs = suppList.map((s, idx) => s.kind === 'report' ? idx : -1).filter(i => i >= 0);
                    if (reportIdxs.length) {
                        matHtml += '<div style="font-size:0.76rem;font-weight:600;color:var(--primary);margin:6px 0 2px;">📄 历史报告（勾选后从中抽取相关内容补充）</div>';
                        reportIdxs.forEach(idx => {
                            const s = suppList[idx];
                            matHtml += '<label style="display:flex;align-items:center;gap:8px;padding:6px 8px;border:1px solid var(--border);border-radius:6px;background:var(--card-bg);cursor:pointer;font-size:0.82rem;">'
                                + '<input type="checkbox" class="wr-modify-hist-mat" value="' + idx + '" style="cursor:pointer;">'
                                + '<span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + wrEsc(s.title) + '</span></label>';
                        });
                    }
                }
                matHtml += '</div>';

                const modal = document.createElement('div');
                modal.id = 'wr-modify-history-modal';
                modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.45);z-index:10100;display:flex;align-items:center;justify-content:center;';
                modal.innerHTML = '<div style="background:var(--card-bg);border-radius:14px;padding:20px;width:min(480px,95vw);max-height:85vh;display:flex;flex-direction:column;gap:12px;overflow-y:auto;">'
                    + '<div style="display:flex;align-items:center;justify-content:space-between;">'
                    + '<span style="font-weight:700;font-size:0.97rem;color:var(--primary);">✏️ 修改报告：' + wrEsc((r.title||'未命名报告').slice(0,20)) + '</span>'
                    + '<button onclick="document.getElementById(\'wr-modify-history-modal\').remove()" style="background:none;border:none;cursor:pointer;font-size:1.2rem;color:var(--text-secondary);">✕</button>'
                    + '</div>'
                    + '<div style="font-size:0.8rem;color:var(--text-secondary);">请输入修改要求，AI 将基于原报告进行调整。</div>'
                    + '<textarea id="wr-modify-instruction" placeholder="例如：增加安全检查项点、补充数据分析段落、调整报告结构..." style="width:100%;min-height:80px;padding:10px;border:1px solid var(--border);border-radius:8px;font-size:0.85rem;resize:vertical;font-family:inherit;"></textarea>'
                    + '<div style="font-size:0.82rem;font-weight:600;color:var(--text);">📎 补充资料（可选，勾选后随修改要求一并提交给 AI）</div>'
                    + matHtml
                    + '<div style="display:flex;gap:10px;margin-top:4px;">'
                    + '<button id="wr-modify-confirm-btn" style="flex:1;padding:10px;background:var(--ds-blue);color:#fff;border:none;border-radius:8px;font-size:0.9rem;font-weight:600;cursor:pointer;">✅ 开始修改</button>'
                    + '<button onclick="document.getElementById(\'wr-modify-history-modal\').remove()" style="padding:10px 16px;border:1px solid var(--border);border-radius:8px;background:var(--bg);font-size:0.9rem;cursor:pointer;">取消</button>'
                    + '</div></div>';
                document.body.appendChild(modal);
                document.getElementById('wr-modify-confirm-btn').onclick = async function() {
                    var instruction = document.getElementById('wr-modify-instruction').value.trim();
                    // 收集勾选的补充来源（资料/其它历史报告）→ 作为本轮【新增资料】（直接用对象，不拼字符串）
                    var cbs = Array.prototype.slice.call(document.querySelectorAll('#wr-modify-history-modal .wr-modify-hist-mat:checked'));
                    var suppMats = cbs.map(function (cb) {
                        var s = suppList[parseInt(cb.value, 10)];
                        if (!s) return null;
                        return { title: s.title, content: s.content || '', matType: (s.kind === 'report' ? 'report' : 'other') };
                    }).filter(Boolean);
                    if (!instruction && !suppMats.length) { alert('请输入修改要求或勾选补充资料'); return; }
                    modal.remove();
                    // 【2026-09-18 用户口径】"继续修改 = 补充"：① 底稿由系统注入，**输入框只放修改/补充要求**
                    //   （旧实现把整篇原报告拼进输入框，用户得在巨长文本里编辑）；② 不再重新检索原模板/原资料；
                    //   ③ 旧实现这里用 wrEsc 转义正文，喂给模型会出现 &quot;/&amp; 之类的 HTML 实体，一并修掉。
                    var input = document.getElementById('wr-query-input');
                    var oldVal = input ? input.value : '';
                    window._wrModifyBaseTitle = r.title || '未命名报告';
                    window._wrModifyCategory = r.category || 'other';
                    window._wrModifyBaseContent = r.content || '';
                    window._wrModifySuppMats = suppMats;
                    if (input) input.value = instruction || '';
                    // 修改模式：跳过本地检索（底稿已含全部内容，新增资料另行注入）。
                    // ⚠️ 用独立开关 _wrModifyMode —— 原先借用 _wrSkipLocalSearch，导致"选了资料直接生成"
                    //    也被当成修改模式（落库标题变成"报告（修改版）"），这是实测发现的副作用。
                    window._wrModifyMode = true;
                    try {
                        await wrGenerate();
                    } finally {
                        if (input) input.value = oldVal;
                        window._wrModifyMode = false;
                        window._wrModifyBaseTitle = null;
                        window._wrModifyCategory = null;
                        window._wrModifyBaseContent = null;
                        window._wrModifySuppMats = null;
                    }
                };
            };

            window.wrClearAllReports = async function() {
                const reports = await wrDbGetAll(WR_RPT_STORE);
                if (!reports.length) { alert('暂无历史报告'); return; }
                if (!confirm('确定清空全部 ' + reports.length + ' 篇历史报告？此操作不可恢复！')) return;
                await wrDbClear(WR_RPT_STORE);
                wrRenderHistory();
                alert('已清空全部历史报告。');
            };

            window.wrExportAllReports = async function() {
                const reports = await wrDbGetAll(WR_RPT_STORE);
                if (!reports.length) { alert('暂无报告可导出'); return; }
                const blob = new Blob([JSON.stringify({ reports, exportDate: new Date().toISOString() }, null, 2)], { type: 'application/json' });
                window.downloadBlob(blob, '历史报告备份_' + window.localDateStr() + '.json');
            };

            // ================================================================
            // ── 资料库管理模块 ──
            // ================================================================

            // 当前筛选类型
            let _wrMatFilter = 'all';

            /**
             * 根据文件名和内容自动推断资料类型
             */
            function wrGuessMatType(fileName, content) {
                const text = (fileName + ' ' + (content || '')).toLowerCase();
                if (/故障|缺陷|障碍|设备故障|故障报告|故障统计/.test(text)) {
                    // 区分故障报告和统计
                    if (/统计|汇总|分析|台账|数量|次数/.test(text)) return 'stats';
                    return 'fault';
                }
                // 检查信息/检查问题 - 作为stats类型处理，便于报告生成时引用
                if (/检查.*信息|检查.*问题|监察.*问题|安全.*检查|问题.*清单|整改.*通知/.test(text)) return 'stats';
                if (/通报|安全通报|情况通报|事故通报|违规通报/.test(text)) return 'bulletin';
                if (/通知|批复|请示|函|电报|文电|电文|转发|印发/.test(text)) return 'dispatch';
                if (/纪要|会议|研讨|座谈|讨论/.test(text)) return 'meeting';
                return 'other';
            }

            /**
             * HTML → 纯文本，保留表格结构为 pipe 行格式
             * 表格每行输出为 | cell1 | cell2 | ... |，非表格块级元素每行一个
             */
            function _htmlToTextPreserveTables(html) {
                const parser = new DOMParser();
                const doc = parser.parseFromString(html || '', 'text/html');
                const lines = [];

                function _walk(node) {
                    if (!node) return;
                    const tag = (node.tagName || '').toLowerCase();

                    // 表格：每行输出 pipe 格式
                    if (tag === 'table') {
                        const rows = node.querySelectorAll('tr');
                        if (rows.length > 0) {
                            rows.forEach(tr => {
                                const cells = tr.querySelectorAll('td, th');
                                if (cells.length > 0) {
                                    const rowText = '| ' + Array.from(cells).map(c => c.textContent.trim()).join(' | ') + ' |';
                                    lines.push(rowText);
                                }
                            });
                            lines.push(''); // 表格后空行分隔
                        }
                        return;
                    }

                    // 段落/标题/列表项 → 一行
                    if (tag === 'p' || /^h[1-6]$/.test(tag) || tag === 'li' || tag === 'div') {
                        const text = node.textContent.trim();
                        if (text) lines.push(text);
                        return;
                    }

                    // 文本节点
                    if (node.nodeType === 3) {
                        const text = node.textContent.trim();
                        if (text) lines.push(text);
                        return;
                    }

                    // 其他元素：递归子节点
                    if (node.childNodes) {
                        node.childNodes.forEach(_walk);
                    }
                }

                _walk(doc.body);
                return lines.join('\n').trim();
            }
            window._htmlToTextPreserveTables = _htmlToTextPreserveTables;

            /**
             * 解析DOCX文件 → { title, content, sheets:null }
             * 使用 convertToHtml 保留表格结构
             */
            async function wrParseDocx(file) {
                if (typeof mammoth === 'undefined') throw new Error('mammoth 库未加载，请检查网络');
                const arrayBuffer = await file.arrayBuffer();
                const result = await mammoth.convertToHtml({ arrayBuffer });
                const content = _htmlToTextPreserveTables(result.value || '');
                // 尝试从正文首行提取标题
                const firstLine = content.split('\n').find(l => l.trim().length > 2) || file.name.replace(/\.docx?$/i, '');
                return {
                    title:   firstLine.slice(0, 80).trim(),
                    content: content,
                    sheets:  null
                };
            }

            /**
             * 解析Excel文件 → { title, content(JSON文本), sheets(JSON), summary }
             * Excel支持多sheet，每个sheet转为JSON数组；同时生成可读摘要文本
             */
            function wrParseExcel(file) {
                return new Promise((resolve, reject) => {
                    if (typeof XLSX === 'undefined') { reject(new Error('XLSX 库未加载')); return; }
                    const reader = new FileReader();
                    reader.onload = function(e) {
                        try {
                            const workbook = XLSX.read(e.target.result, { type: 'array' });
                            const sheets = {};
                            const summaryLines = [];
                            workbook.SheetNames.forEach(name => {
                                const ws = workbook.Sheets[name];
                                const json = XLSX.utils.sheet_to_json(ws, { defval: '' });
                                sheets[name] = json;
                                // 生成可读摘要：取前20行
                                if (json.length > 0) {
                                    summaryLines.push('【' + name + '】共' + json.length + '条记录');
                                    const keys = Object.keys(json[0]);
                                    summaryLines.push('字段：' + keys.join('、'));
                                    json.slice(0, 15).forEach((row, i) => {
                                        const vals = keys.map(k => k + ':' + (row[k] !== undefined ? String(row[k]).slice(0, 30) : '')).join(' | ');
                                        summaryLines.push('  ' + (i+1) + '. ' + vals);
                                    });
                                    if (json.length > 15) summaryLines.push('  …（共' + json.length + '条）');
                                }
                            });
                            const content = summaryLines.join('\n');
                            resolve({
                                title:   file.name.replace(/\.(xlsx?|xls)$/i, ''),
                                content: content,
                                sheets:  sheets,
                                rowCount: Object.values(sheets).reduce((s, a) => s + a.length, 0)
                            });
                        } catch(err) { reject(err); }
                    };
                    reader.onerror = () => reject(new Error('文件读取失败'));
                    reader.readAsArrayBuffer(file);
                });
            }

            /**
             * 导入多文件（DOCX/Excel/JSON），统一存入资料库
             */
            window.wrMaterialImport = function() {
                const inp = document.createElement('input');
                inp.type = 'file';
                // 【2026-09-21】去掉 .doc：解析走的是 mammoth（不支持老 .doc），accept 里写着却必失败
                inp.accept = '.docx,.xlsx,.xls,.json';
                inp.multiple = true;
                inp.style.display = 'none';
                // 【2026-09-21】取消选择回收隐藏 input（原来只在 onchange 里 remove，取消一次就留一个在 body）
                inp.addEventListener('cancel', function() { try { inp.remove(); } catch (e) {} });
                inp.onchange = async function(e) {
                    const files = Array.from(e.target.files);
                    if (!files.length) return;
                    let ok = 0, fail = 0;
                    const statusEl = document.getElementById('wr-mat-list');
                    if (statusEl) statusEl.innerHTML = '<div style="text-align:center;padding:20px;color:var(--text-secondary);">⏳ 正在解析并导入 ' + files.length + ' 个文件…</div>';

                    for (const file of files) {
                        try {
                            const ext = file.name.split('.').pop().toLowerCase();
                            if (ext === 'docx' || ext === 'doc') {
                                const parsed = await wrParseDocx(file);
                                const matType = wrGuessMatType(file.name, parsed.content);
                                await wrDbPut(WR_MAT_STORE, {
                                    fileName:  file.name,
                                    title:     parsed.title || file.name,
                                    matType:   matType,
                                    content:   (parsed.content || '').slice(0, 20000),
                                    sheets:    parsed.sheets ? JSON.stringify(parsed.sheets) : null,
                                    rowCount:  parsed.rowCount || null,
                                    fileSize:  file.size,
                                    importAt:  Date.now()
                                });
                                ok++;
                            } else if (ext === 'xlsx' || ext === 'xls') {
                                const parsed = await wrParseExcel(file);
                                let matType = wrGuessMatType(file.name, parsed.content);
                                if (matType === 'other') matType = 'stats';
                                await wrDbPut(WR_MAT_STORE, {
                                    fileName:  file.name,
                                    title:     parsed.title,
                                    matType:   matType,
                                    content:   parsed.content.slice(0, 20000),
                                    sheets:    parsed.sheets ? JSON.stringify(parsed.sheets) : null,
                                    rowCount:  parsed.rowCount || null,
                                    fileSize:  file.size,
                                    importAt:  Date.now()
                                });
                                ok++;
                            } else if (ext === 'json') {
                                // JSON导入：按条拆分存储，每条记录独立分类
                                const text = await file.text();
                                const data = JSON.parse(text);
                                
                                console.log('[智能写作-导入] 原始JSON顶级keys:', Object.keys(data));
                                console.log('[智能写作-导入] 是否数组:', Array.isArray(data));
                                if (data.materials) console.log('[智能写作-导入] materials数量:', data.materials.length);
                                
                                let items;
                                // 兼容多种导出格式
                                if (Array.isArray(data)) {
                                    items = data;
                                    console.log('[智能写作-导入] 走Array分支, 数量:', items.length);
                                } else if (data.materials && Array.isArray(data.materials)) {
                                    // 导出备份格式 { materials: [...], exportDate: "..." }
                                    items = data.materials;
                                    console.log('[智能写作-导入] 走materials分支, 数量:', items.length);
                                    // 打印前3条的matType便于确认
                                    items.slice(0, 3).forEach((it, i) => console.log('  ['+i+'] matType:', it.matType, 'title:', it.title));
                                } else if (data.items && Array.isArray(data.items)) {
                                    items = data.items;
                                    console.log('[智能写作-导入] 走items分支, 数量:', items.length);
                                } else if (data.data && Array.isArray(data.data)) {
                                    items = data.data;
                                    console.log('[智能写作-导入] 走data分支, 数量:', items.length);
                                } else {
                                    items = [data]; // 单条对象也包装为数组
                                    console.log('[智能写作-导入] 走单条兜底分支, keys:', Object.keys(data));
                                }

                                let importedCount = 0;
                                for (const item of items) {
                                    // 每条记录提取标题和内容
                                    const itemTitle = item.title || item.name || item.fileName || item.chapter
                                                  || (item.section ? (item.chapter || '') + '-' + item.section : '')
                                                  || file.name.replace(/\.json$/i, '') + '_' + importedCount;

                                    // 提取内容：优先用content字段
                                    let itemContent = '';
                                    if (item.content && typeof item.content === 'string') {
                                        itemContent = item.content;
                                    } else if (item.contentHtml && typeof item.contentHtml === 'string') {
                                        itemContent = item.contentHtml; // 手册格式兼容
                                    } else {
                                        // 去掉元数据字段后，序列化剩余部分作为内容
                                        const { id: _id, title: _t, name: _n, fileName: _fn, chapter: _c, section: _s, matType: _m, type: _type, importAt: _ia, fileSize: _fs, rowCount: _rc, sheets: _sh, jsonIndex: _ji, ...rest } = item;
                                        itemContent = Object.keys(rest).length > 0
                                            ? JSON.stringify(rest, null, 2)
                                            : (item.content || '');
                                    }

                                    // 判断资料类型：优先用记录自带的 matType/type 字段（保留原始分类）
                                    let matType = item.matType || item.type || '';
                                    if (!matType || !WR_MAT_TYPES[matType]) {
                                        matType = wrGuessMatType(itemTitle, itemContent);
                                    }

                                    console.log('[智能写作-导入] 存入第' + importedCount + '条:', itemTitle, '| 类型:', matType, '| 内容长度:', itemContent.length);

                                    await wrDbPut(WR_MAT_STORE, {
                                        fileName:  item.fileName || file.name,
                                        title:     String(itemTitle).slice(0, 200),
                                        matType:   matType,
                                        content:   String(itemContent).slice(0, 20000),
                                        sheets:    item.sheets || null,
                                        rowCount:  item.rowCount || null,
                                        fileSize:  item.fileSize || file.size,
                                        importAt:  item.importAt || Date.now(),
                                        jsonIndex: importedCount
                                    });
                                    importedCount++;
                                    ok++;
                                }
                                console.log('[智能写作] JSON导入 "' + file.name + '"：共 ' + importedCount + ' 条记录');
                            } else {
                                fail++; continue;
                            }
                        } catch(err) {
                            console.error('导入失败：' + file.name, err);
                            fail++;
                        }
                    }
                    wrRenderMaterials();
                    alert('导入完成：成功 ' + ok + ' 个' + (fail ? '，失败 ' + fail + ' 个（请检查文件格式）' : '') + '。');
                    inp.remove();
                };
                document.body.appendChild(inp); inp.click();
            };

            /**
             * 专门导入Excel（支持批量多Sheet，含列名映射引导）
             */
            window.wrMaterialImportExcel = function() {
                const inp = document.createElement('input');
                inp.type = 'file';
                inp.accept = '.xlsx,.xls';
                inp.multiple = true;
                inp.style.display = 'none';
                inp.addEventListener('cancel', function() { try { inp.remove(); } catch (e) {} });   // 同上：取消回收
                inp.onchange = async function(e) {
                    const files = Array.from(e.target.files);
                    if (!files.length) return;
                    let ok = 0;
                    for (const file of files) {
                        try {
                            const parsed = await wrParseExcel(file);
                            // Excel优先判断为故障统计或故障报告
                            let matType = wrGuessMatType(file.name, parsed.content);
                            if (matType === 'other') matType = 'stats'; // Excel默认归为故障统计
                            await wrDbPut(WR_MAT_STORE, {
                                fileName:  file.name,
                                title:     parsed.title,
                                matType:   matType,
                                content:   parsed.content.slice(0, 20000),
                                sheets:    parsed.sheets ? JSON.stringify(parsed.sheets) : null,
                                rowCount:  parsed.rowCount || null,
                                fileSize:  file.size,
                                importAt:  Date.now()
                            });
                            ok++;
                        } catch(err) { console.error('Excel导入失败：' + file.name, err); }
                    }
                    wrRenderMaterials();
                    alert('Excel导入完成：' + ok + ' 个文件。');
                    inp.remove();
                };
                document.body.appendChild(inp); inp.click();
            };

            // 分类胶囊高亮：必须同时处理 active 与 wr-mat-tab-active 两个类。
            // 「全部」按钮在 index.html 里被硬编码了 wr-mat-tab-active 作为初始高亮，
            // 而原实现只增删 active、从不移除 wr-mat-tab-active ——
            // 于是「全部」永远高亮，点其它分类时会出现两个胶囊同时亮起，用户分不清当前分类。
            function _wrSyncFilterChip(type) {
                ['all','template','history','inspect','fault','dispatch','other','allmodule'].forEach(t => {
                    const btn = document.getElementById('wr-mat-filter-' + t);
                    if (!btn) return;
                    if (t === type) {
                        btn.classList.add('active');
                        btn.classList.add('wr-mat-tab-active');
                    } else {
                        btn.classList.remove('active');
                        btn.classList.remove('wr-mat-tab-active');
                    }
                });
            }

            /**
             * 筛选资料类型
             */
            window.wrMaterialFilter = function(type) {
                _wrMatFilter = type;
                _wrSyncFilterChip(type);
                const histZone = document.getElementById('wr-mat-history-zone');
                const matList  = document.getElementById('wr-mat-list');
                const matSearch = document.getElementById('wr-mat-search');
                // 全模块聚合只读视图（检查信息/规章/日志/写作/报告）
                if (type === 'allmodule') {
                    if (histZone) histZone.style.display = 'none';
                    if (matList)  matList.style.display = 'flex';
                    if (matSearch) { matSearch.style.display = ''; matSearch.placeholder = '🔍 搜索全部来源...'; }
                    wrRenderMaterialCenter('all');
                    return;
                }
                // 故障报告同时包含故障统计（stats），通报文电同时包含会议纪要（meeting）
                if (histZone) histZone.style.display = 'none';
                if (matList)  matList.style.display = 'flex';
                if (matSearch) { matSearch.style.display = ''; matSearch.placeholder = '🔍 搜索...'; }
                wrRenderMaterials();
            };

            // 搜索框统一调度：根据当前分类决定刷新哪类列表
            window.wrMaterialSearch = function() {
                if (_wrMatFilter === 'allmodule') { wrRenderMaterialCenter(_wrCenterGroup || 'all'); }
                else if (_wrMatFilter === 'history') { wrRenderHistory(); }
                else { wrRenderMaterials(); }
            };

            // 历史报告 Tab 点击：显示历史报告子区域，隐藏普通资料列表
            window.wrMatFilterHistory = function() {
                _wrSyncFilterChip('history');
                // 必须同步筛选状态：否则 wrMaterialSearch() 在历史报告页会走进
                // else 分支去刷新一个被隐藏的资料列表，表现为「搜索没反应」
                _wrMatFilter = 'history';
                const histZone = document.getElementById('wr-mat-history-zone');
                const matList  = document.getElementById('wr-mat-list');
                const matSearch = document.getElementById('wr-mat-search');
                if (matList)  matList.style.display = 'none';
                if (histZone) { histZone.style.display = 'flex'; histZone.style.flexDirection = 'column'; }
                // 隐藏主搜索框，避免与历史报告搜索框重复
                if (matSearch) matSearch.style.display = 'none';
                wrRenderHistory();
            };

            /**
             * 渲染资料库列表
             */
            window.wrRenderMaterials = async function() {
                const all = await wrDbGetAll(WR_MAT_STORE);
                const listEl  = document.getElementById('wr-mat-list');
                const countEl = document.getElementById('wr-mat-count');
                if (!listEl) return;

                const q = ((document.getElementById('wr-mat-search') || {}).value || '').toLowerCase();
                let filtered = all;
                if (_wrMatFilter !== 'all') {
                    // 故障报告（fault）同时包含故障统计（stats）；通报文电（dispatch）同时包含会议纪要（meeting）
                    if (_wrMatFilter === 'fault') {
                        filtered = filtered.filter(m => m.matType === 'fault' || m.matType === 'stats');
                    } else if (_wrMatFilter === 'dispatch') {
                        filtered = filtered.filter(m => m.matType === 'dispatch' || m.matType === 'meeting');
                    } else {
                        filtered = filtered.filter(m => m.matType === _wrMatFilter);
                    }
                }
                if (q) filtered = filtered.filter(m =>
                    (m.title||'').toLowerCase().includes(q) ||
                    (m.fileName||'').toLowerCase().includes(q) ||
                    String(m.content||'').slice(0,500).toLowerCase().includes(q)
                );
                // 【2026-09-22】按"生成/导入时间"倒序（最近的在最上面）。原来只按 importAt：
                //   模块生成、迁移来的旧资料没有该字段 → 比较得 NaN → sort 保持原顺序（等于没排序）。
                filtered.sort(wrByTimeDesc);

                if (countEl) countEl.textContent = filtered.length + '/' + all.length + ' 条资料';
                var setCount = document.getElementById('set-wr-count');
                if (setCount) setCount.textContent = all.length + '条';

                if (!filtered.length) {
                    listEl.innerHTML = '<div style="text-align:center;padding:30px;color:var(--text-secondary);font-size:0.85rem;">'
                        + (q || _wrMatFilter !== 'all' ? '无匹配资料' : '暂无资料，点击「导入文件」上传 DOCX 或 Excel') + '</div>';
                    return;
                }

                var wrMatCardOf = function(m) {
                    const typeInfo = WR_MAT_TYPES[m.matType] || WR_MAT_TYPES.other;
                    const ext = (m.fileName || '').split('.').pop().toLowerCase();
                    const extIcon = ext === 'docx' || ext === 'doc' ? '📝' : (ext === 'xlsx' || ext === 'xls' ? '📊' : '📄');
                    const sizeStr = m.fileSize ? (m.fileSize > 1024*1024 ? (m.fileSize/1024/1024).toFixed(1)+'MB' : Math.round(m.fileSize/1024)+'KB') : '';
                    const rowStr  = m.rowCount ? '·' + m.rowCount + '条' : '';
                    const preview = (typeof m.content === 'string' ? m.content : String(m.content || '')).replace(/\n/g, ' ').slice(0, 80);
                    const isTemplate = m.matType === 'template';
                    return `
                    <div class="wr-mat-card">
                        <div style="font-size:1.4rem;flex-shrink:0;margin-top:1px;">${extIcon}</div>
                        <div style="flex:1;min-width:0;">
                            <div style="font-weight:700;font-size:0.88rem;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${wrEsc(m.title||m.fileName)}</div>
                            <div style="font-size:0.73rem;color:var(--text-secondary);margin:2px 0;display:flex;flex-wrap:wrap;gap:5px;align-items:center;">
                                <span style="background:${typeInfo.badge};color:${typeInfo.text};padding:1px 8px;border-radius:10px;">${typeInfo.label}</span>
                                ${m.source ? '<span style="background:#e0e7ff;color:#3730a3;padding:1px 8px;border-radius:10px;">📍 ' + wrEsc(m.source) + '</span>' : ''}
                                ${wrItemTime(m) ? '<span>' + wrFmtDate(wrItemTime(m)).slice(0,10) + '</span>' : ''}
                                ${sizeStr ? '<span>'+sizeStr+'</span>' : ''}
                                ${rowStr ? '<span>'+rowStr+'</span>' : ''}
                            </div>
                            <div style="font-size:0.77rem;color:#64748b;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${wrEsc(preview)}…</div>
                        </div>
                        <div style="display:flex;flex-direction:row;flex-wrap:wrap;gap:6px;flex-basis:100%;flex-shrink:0;margin-top:4px;">
                            <button onclick="wrViewMaterial(${JSON.stringify(m.id)})" class="wr-mat-btn wr-mat-btn-view">查看</button>
                            ${!isTemplate ? `<button onclick="wrSetAsTemplate(${JSON.stringify(m.id)})" class="wr-mat-btn wr-mat-btn-template" title="设为写作模版">⭐ 设模版</button>` : '<button disabled class="wr-mat-btn" style="background:#f1f5f9;color:#94a3b8;cursor:not-allowed;border:1px solid #e2e8f0;">✓ 已是模版</button>'}
                            <select onchange="wrChangeMaterialType(${JSON.stringify(m.id)},this.value)" class="wr-mat-select" title="修改类型">
                                ${Object.entries(WR_MAT_TYPES).map(([k,v])=>'<option value="'+k+'"'+(k===m.matType?' selected':'')+'>'+v.label+'</option>').join('')}
                            </select>
                            <button onclick="wrDeleteMaterial(${JSON.stringify(m.id)})" class="wr-mat-btn wr-mat-btn-delete">删除</button>
                        </div>
                    </div>`;
                };
                // 【2026-09-22】两种视图（顶部「按类型 / 按时间」切换）：
                //   · 按类型（默认）：分块 + 块内时间倒序；组头可点击折叠，块内默认只展开最新 10 条
                //   · 按时间：纯时间倒序、不分块
                window.wrSyncListModeChips();
                if (window._wrListMode === 'time') {
                    listEl.innerHTML = filtered.map(wrMatCardOf).join('');
                } else {
                    listEl.innerHTML = wrGroupByType(filtered).map(function(g) {
                        var collapsed = !!window._wrListCollapsed[g.key];
                        var head = wrGroupHeaderHtml(g.label, g.items.length, g.key, collapsed);
                        if (collapsed) return head;
                        var showAll = !!window._wrListExpanded[g.key];
                        var shown = (showAll || g.items.length <= WR_LIST_PREVIEW_N) ? g.items : g.items.slice(0, WR_LIST_PREVIEW_N);
                        var more = g.items.length - shown.length;
                        return head + shown.map(wrMatCardOf).join('') + (more > 0 ? wrGroupMoreHtml(g.key, more) : '');
                    }).join('');
                }
            };

            /**
             * 查看资料详情（弹窗）
             */
            window.wrViewMaterial = async function(id) {
                try {
                    var db = await wrOpenDB();
                    var m = await new Promise(function(resolve) {
                        var tx = db.transaction(WR_MAT_STORE, 'readonly');
                        var req = tx.objectStore(WR_MAT_STORE).get(id);
                        req.onsuccess = function(e) { resolve(e.target.result); };
                        req.onerror = function() { resolve(null); };
                    });
                    // 兜底：get 未命中时再用 getAll + 主键匹配（兼容极端情况）
                    if (!m) {
                        const all = await wrDbGetAll(WR_MAT_STORE);
                        m = (all || []).filter(function(x){ return x && x.id === id; })[0];
                    }
                    if (!m) {
                        console.warn('[wr] 未找到资料 id=', id);
                        alert('未找到该资料，可能已被删除或数据异常。');
                        return;
                    }
                } catch(e) {
                    console.warn('[wr] viewMaterial failed:', e && e.message);
                    alert('打开资料失败：' + (e && e.message ? e.message : e));
                    return;
                }
                const typeInfo = WR_MAT_TYPES[m.matType] || WR_MAT_TYPES.other;

                // 复用报告弹窗，或创建独立弹窗
                let modal = document.getElementById('wr-mat-view-modal');
                if (!modal) {
                    modal = document.createElement('div');
                    modal.id = 'wr-mat-view-modal';
                    modal.style.cssText = 'display:none;position:fixed;top:0;right:0;bottom:0;left:0;background:rgba(0,0,0,0.5);z-index:10000;align-items:center;justify-content:center;';
                    modal.innerHTML = `
                        <div style="background:#fff;border-radius:14px;padding:18px;width:min(700px,96vw);max-height:88vh;display:flex;flex-direction:column;gap:10px;overflow:hidden;">
                            <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:8px;">
                                <div>
                                    <div id="wr-mat-view-title" style="font-weight:700;font-size:1rem;color:var(--primary);"></div>
                                    <div id="wr-mat-view-meta" style="font-size:0.75rem;color:var(--text-secondary);margin-top:3px;"></div>
                                </div>
                                <button onclick="document.getElementById('wr-mat-view-modal').style.display='none'" style="background:none;border:none;cursor:pointer;font-size:1.2rem;color:var(--text-secondary);flex-shrink:0;">✕</button>
                            </div>
                            <div id="wr-mat-view-content" style="flex:1;overflow-y:auto;font-size:0.83rem;line-height:1.75;white-space:pre-wrap;background:#f8fafc;border-radius:8px;padding:12px;border:1px solid var(--border);min-height:200px;max-height:65vh;word-break:break-word;"></div>
                            <div style="display:flex;gap:8px;justify-content:flex-end;flex-wrap:wrap;">
                                <button onclick="wrCopyMaterialContent()" style="padding:7px 14px;border:1px solid var(--border);border-radius:var(--radius-sm);background:#fff;font-size:0.82rem;cursor:pointer;">📋 复制内容</button>
                                <button onclick="wrDownloadDocxFromMaterial()" style="padding:7px 14px;border:1px solid #2b6cb0;color:#2b6cb0;border-radius:var(--radius-sm);background:#fff;font-size:0.82rem;cursor:pointer;">📄 导出DOCX</button>
                                <button onclick="document.getElementById('wr-mat-view-modal').style.display='none'" style="padding:7px 14px;background:var(--primary);color:#fff;border:none;border-radius:var(--radius-sm);font-size:0.82rem;cursor:pointer;">关闭</button>
                            </div>
                        </div>`;
                    document.body.appendChild(modal);
                }
                document.getElementById('wr-mat-view-title').textContent = m.title || m.fileName;
                document.getElementById('wr-mat-view-meta').textContent =
                    '类型：' + typeInfo.label + '　文件：' + (m.fileName||'') + '　导入：' + wrFmtDate(m.importAt)
                    + (m.rowCount ? '　' + m.rowCount + '条记录' : '') + (m.fileSize ? '　' + Math.round(m.fileSize/1024) + 'KB' : '');
                document.getElementById('wr-mat-view-content').innerHTML = (window.dsMarkdown ? window.dsMarkdown(String(m.content || '')) : String(m.content || '（内容为空）'));
                modal._content = String(m.content || '');
                modal.style.display = 'flex';
            };

            window.wrCopyMaterialContent = async function() {
                const modal = document.getElementById('wr-mat-view-modal');
                if (!modal || !modal._content) return;
                const ok = await window.copyTextToClipboard(modal._content);
                alert(ok ? '已复制到剪贴板！' : '复制失败，请长按内容手动选中复制。');
            };

            /**
             * 修改资料类型
             */
            window.wrChangeMaterialType = async function(id, newType) {
                try {
                    var db = await wrOpenDB();
                    var m = await new Promise(function(resolve) {
                        var tx = db.transaction(WR_MAT_STORE, 'readonly');
                        var req = tx.objectStore(WR_MAT_STORE).get(id);
                        req.onsuccess = function(e) { resolve(e.target.result); };
                        req.onerror = function() { resolve(null); };
                    });
                    if (!m) return;
                    m.matType = newType;
                    await wrDbPut(WR_MAT_STORE, m);
                    wrRenderMaterials();
                } catch(e) { console.warn('[wr] changeMaterialType failed:', e.message); }
            };

            /**
             * 删除单条资料
             */
            window.wrDeleteMaterial = async function(id) {
                if (!confirm('确定删除该资料吗？')) return;
                await wrDbDelete(WR_MAT_STORE, id);
                wrRenderMaterials();
            };

            /**
             * 清空资料库
             */
            window.wrMaterialClearAll = async function() {
                const all = await wrDbGetAll(WR_MAT_STORE);
                if (!all.length) { alert('资料库已为空'); return; }
                if (!confirm('确定清空全部 ' + all.length + ' 条资料？此操作不可恢复！')) return;
                await wrDbClear(WR_MAT_STORE);
                wrRenderMaterials();
                alert('资料库已清空。');
            };

            /**
             * 调试：检查资料库状态
             */
            window.wrDebugMaterials = async function() {
                try {
                    var db = await wrOpenDB();
                    var all = await wrDbGetAll(WR_MAT_STORE);
                    
                    // 按类型统计
                    var typeCount = {};
                    all.forEach(function(m) {
                        typeCount[m.matType] = (typeCount[m.matType] || 0) + 1;
                    });
                    
                    // 显示详细信息
                    let details = all.slice(0, 5).map(m => 
                        `ID:${m.id} | ${m.title || m.fileName} | 类型:${m.matType} | 时间:${new Date(m.importAt).toLocaleString()}`
                    ).join('\n');
                    
                    if (all.length > 5) {
                        details += '\n... 还有 ' + (all.length - 5) + ' 条资料';
                    }
                    
                    const msg = `📊 资料库状态报告

数据库: ${db.name} (v${db.version})
存储对象: ${Array.from(db.objectStoreNames).join(', ')}

资料总数: ${all.length} 条
按类型统计:
${Object.entries(typeCount).map(([k,v]) => `  • ${wrCatName(k)}: ${v} 条`).join('\n')}

最新5条资料:
${details || '(无)'}

💡 提示: 按F12打开控制台查看详细日志`;
                    
                    alert(msg);
                    
                } catch(err) {
                    alert('调试检查失败: ' + (err.message || '未知错误'))
                }
            };

            /**
             * 将资料设为写作模板
             */
            window.wrSetAsTemplate = async function(id) {
                try {
                    var db = await wrOpenDB();
                    var m = await new Promise(function(resolve) {
                        var tx = db.transaction(WR_MAT_STORE, 'readonly');
                        var req = tx.objectStore(WR_MAT_STORE).get(id);
                        req.onsuccess = function(e) { resolve(e.target.result); };
                        req.onerror = function() { resolve(null); };
                    });
                    if (!m) return;

                    // 如果已经是模板类型，提示用户
                    if (m.matType === 'template') {
                        alert('该资料已经是写作模版类型');
                        return;
                    }

                    // 确认对话框
                    const typeInfo = WR_MAT_TYPES[m.matType] || WR_MAT_TYPES.other;
                    if (!confirm('确定将【' + typeInfo.label + '】《' + (m.title || m.fileName) + '》设为写作模版吗？')) return;

                    // 更新类型为template
                    m.matType = 'template';
                    await wrDbPut(WR_MAT_STORE, m);
                    wrRenderMaterials();
                    alert('已成功设为写作模版！您可以在「撰写报告」时选择此模版使用。');
                } catch(e) { console.warn('[wr] setAsTemplate failed:', e.message); }
            };

            /**
             * 导出资料库 + 历史报告为JSON
             */
            window.wrMaterialExportAll = async function() {
                const all = await wrDbGetAll(WR_MAT_STORE);
                const reports = await wrDbGetAll(WR_RPT_STORE);
                if (!all.length && !reports.length) { alert('资料库和历史报告均为空，无法导出'); return; }
                // 导出时去掉sheets（可能很大），只保留content
                const exportMaterials = all.map(m => ({ ...m, sheets: undefined }));
                const exportData = { materials: exportMaterials, reports: reports, exportDate: new Date().toISOString() };
                const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: 'application/json' });
                window.downloadBlob(blob, '智能写作备份_' + window.localDateStr() + '.json');
            };

        // ---- 将内部函数暴露到全局（供 HTML onclick 调用）----
        // 注：toggleDoubaoMode / saveApiConfigFromModal 由 doubao.js 暴露，此处不再重复（避免覆盖为 warn 桩）
        window.showApiConfigModal     = typeof showApiConfigModal !== 'undefined' ? showApiConfigModal : function(){};
        window.bindApiModalEvents     = typeof bindApiModalEvents !== 'undefined' ? bindApiModalEvents : function(){};
        // dsInit 在 IIFE 开头定义，也需暴露
        window.dsInit                 = typeof dsInit !== 'undefined' ? dsInit : function(){};

        // 导出用于设置面板计数的函数
        window.getWrMatCount = async function() { try { var all = await wrDbGetAll(WR_MAT_STORE); return all.length; } catch(e) { return 0; } };
        window.getWrRptCount = async function() { try { var all = await wrDbGetAll(WR_RPT_STORE); return all.length; } catch(e) { return 0; } };

        // Agent 桥接：保存报告到写作资料库
        // 智能体报告统一存到「报告库」(WR_RPT_STORE, 数字自增 id)，与其它模块报告走同一通路，
        // 用已验证可正常打开的 wrViewReport 查看（此前存资料库且用字符串 id，部分浏览器打不开）
        window.wrAgentSaveMaterial = async function(title, content) {
            try {
                await wrOpenDB();
                var item = {
                    title: title,
                    content: content,
                    category: 'agent',
                    source: '智能体',
                    date: Date.now(),
                    materialCount: { issues: 0, rules: 0, reports: 0 }
                };
                var savedId = await wrDbPut(WR_RPT_STORE, item);
                return savedId || true;
            } catch(e) { console.warn('[writer] agent save failed:', e.message); return false; }
        };

        // 数据迁移：将旧版存于「资料库」(WR_MAT_STORE, 字符串 id) 的智能体报告迁到「报告库」(WR_RPT_STORE)，
        // 使它们与其它模块报告一样可正常打开。一次性、幂等：迁移成功后即从资料库删除。
        window.wrMigrateAgentMaterials = async function() {
            try {
                await wrOpenDB();
                var all = await wrDbGetAll(WR_MAT_STORE);
                var agents = (all || []).filter(function(m){ return m && m.source === '智能体'; });
                for (var i = 0; i < agents.length; i++) {
                    var m = agents[i];
                    var rep = {
                        title: m.title || '智能体报告',
                        content: m.content || '',
                        category: 'agent',
                        source: '智能体',
                        date: (m.importAt || m.createdAt || Date.now()),
                        materialCount: { issues: 0, rules: 0, reports: 0 }
                    };
                    var savedId = await wrDbPut(WR_RPT_STORE, rep);
                    if (savedId != null) {
                        try { await wrDbDelete(WR_MAT_STORE, m.id); } catch(e) {}
                    }
                }
                if (agents.length) console.log('[writer] 已迁移 ' + agents.length + ' 条旧智能体报告到报告库');
            } catch(e) { console.warn('[writer] 迁移智能体报告失败:', e.message); }
        };
        // 模块加载即触发一次迁移（fire-and-forget，不阻塞）
        // 【启动优化 2026-09-18】原实现：defer 阶段就 `wrOpenDB()` + **全量 getAll 资料库**来筛
        //   「来源=智能体」的记录，属于首屏前的 IndexedDB 重活，而绝大多数启动根本没有可迁移项。
        //   改为：① 迁移成功过就落标记，之后启动直接跳过（零开销）；
        //       ② 没迁移过也不在启动期跑，等页面空闲（或最晚 5s 后）再跑，失败不留标记、下次重试。
        (function scheduleAgentMigration() {
            var DONE_KEY = 'wr_agent_migrated_v1';
            try { if (localStorage.getItem(DONE_KEY) === '1') return; } catch (e) {}
            var run = function () {
                var p = wrMigrateAgentMaterials();
                if (p && typeof p.then === 'function') {
                    p.then(function () { try { localStorage.setItem(DONE_KEY, '1'); } catch (e) {} });
                }
            };
            if (typeof requestIdleCallback === 'function') requestIdleCallback(run, { timeout: 5000 });
            else setTimeout(run, 2500);
        })();

        // 资料中心统一渲染后，原有「资料库列表 / 历史报告」刷新函数改为委托到统一渲染器，
        // 保留函数名以兼容所有旧调用点（导入 / 删除 / 设模版 / 改类型 / 报告增删改），避免重复渲染冲突。
        // 注：wrRenderMaterials / wrRenderHistory 的原始实现（含查看/修改/删除/设模版按钮）定义在上方，
        // 此处不再委托到多源聚合，避免覆盖导致资料中心丢失查看/修改/删除功能。
    })();
