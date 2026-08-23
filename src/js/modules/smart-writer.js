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

            function wrOpenDB() {
                // 如果正在打开中，复用同一个 Promise
                if (_wrDBOpening) return _wrDBOpening;

                _wrDBOpening = new Promise((resolve, reject) => {
                    // 检查缓存连接是否仍然有效
                    if (_wrDB) {
                        try {
                            // 快速有效性检测：数据库关闭后 objectStoreNames 不可访问
                            void _wrDB.objectStoreNames;
                            _wrDBOpening = null;
                            return resolve(_wrDB);
                        } catch(e) {
                            console.log('[DB] 缓存连接已失效，重新打开');
                            _wrDB = null;
                        }
                    }

                    var req = indexedDB.open(WR_DB_NAME, WR_DB_VER);
                    req.onblocked = function() {
                        console.warn('[writer] DB升级被阻塞');
                    };
                    req.onupgradeneeded = function(e) {
                        var db = e.target.result;
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
                        } catch(upErr) {
                            console.error('[writer] upgrade失败:', upErr);
                        }
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
                        '<pre style="background:#1e293b;color:#e2e8f0;padding:32px 10px 10px 10px;border-radius:6px;overflow-x:auto;font-size:0.85em;margin:0;white-space:pre-wrap;">' + code + '</pre></div>';
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
                                open: function() { if (window.switchTab) window.switchTab('diary'); }
                            };
                        }
                        return {
                            source: 'diary', id: d.date,
                            title: d.title,
                            sub: [ '日志', d.issueCount ? (d.issueCount + '条问题') : '' ].filter(Boolean).join(' · '),
                            summary: String(d.work || '').replace(/\n/g, ' ').slice(0, 90),
                            badge: '日志',
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
                    var total = items.length;
                    if (items.length > 400) items = items.slice(0, 400);
                    var countEl = document.getElementById('wr-mat-count');
                    if (countEl) countEl.textContent = (total > 400 ? '显示前400/' : '') + total + ' 条';
                    if (!items.length) {
                        listEl.innerHTML = '<div style="text-align:center;padding:30px;color:var(--text-secondary);font-size:0.85rem;">' + (q ? '无匹配结果' : '暂无可查看的数据') + '</div>';
                        return;
                    }
                    _wrCenterItems = items;
                    listEl.innerHTML = items.map(function(it, i) {
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
                    }).join('');
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
                    var modalHtml = '<div style="background:#fff;border-radius:14px;padding:20px;width:min(560px,95vw);max-height:85vh;display:flex;flex-direction:column;gap:12px;">'
                        + '<div style="display:flex;align-items:center;justify-content:space-between;"><span style="font-weight:700;font-size:0.97rem;color:var(--primary);">✍️ 选择模板和参考资料</span><button onclick="this.closest(\'.wr-step-modal\').remove()" style="background:none;border:none;cursor:pointer;font-size:1.2rem;">✕</button></div>'
                        + '<div style="font-size:0.8rem;color:var(--text-secondary);">模板为可选，资料可多选（故障报告、检查信息等）</div>'
                        + '<div><label style="font-weight:600;">📄 写作模板</label><select id="wr-step-template" style="width:100%;padding:8px;border:1px solid var(--border);border-radius:6px;">'
                        + '<option value="">-- 不使用模板 --</option>'
                        + (templates||[]).map(function(t){ return '<option value="'+t.id+'">'+wrEsc(t.title)+'</option>'; }).join('')
                        + '</select></div>'
                        + '<div><label style="font-weight:600;">📚 参考资料（多选）</label><div style="max-height:40vh;overflow-y:auto;border:1px solid var(--border);border-radius:8px;padding:8px;">'
                        + ((otherMats||[]).length === 0 ? '<div style="text-align:center;color:gray;padding:16px;">暂无可用资料</div>' : (otherMats||[]).map(function(m){ return '<label style="display:block;margin-bottom:5px;"><input type="checkbox" class="wr-step-mat" value="'+m.id+'"> '+wrEsc(m.title||m.fileName)+' <span style="font-size:0.7rem;color:gray;">('+((WR_MAT_TYPES[m.matType]&&WR_MAT_TYPES[m.matType].label)||m.matType)+')</span></label>'; }).join(''))
                        + '</div></div>'
                        + '<div style="display:flex;gap:8px;justify-content:flex-end;"><button onclick="wrConfirmSelection()" style="padding:8px 16px;background:var(--primary);color:#fff;border:none;border-radius:6px;">确认并生成</button><button onclick="this.closest(\'.wr-step-modal\').remove()" style="padding:8px 16px;">取消</button></div></div>';
                    var modal = document.createElement('div');
                    modal.className = 'wr-step-modal';
                    modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:10100;display:flex;align-items:center;justify-content:center;';
                    modal.innerHTML = modalHtml;
                    document.body.appendChild(modal);
                };

                // 先立即显示对话框，再异步加载数据更新
                showDialog([], []);
                Promise.all([ wrGetAllTemplates().catch(function(){ return []; }), wrDbGetAll(WR_MAT_STORE).catch(function(){ return []; }) ])
                .then(function(res) {
                    var allTpls = res[0] || [];
                    var mats = res[1] || [];
                    window._wrAllMats = mats;   // 缓存供 wrConfirmSelection 查找参考资料
                    window._wrAllTpls = allTpls; // 缓存供 wrConfirmSelection 查找模板（含 WR_TPL_STORE + WR_MAT_STORE 模板）
                    var otherMats = mats.filter(function(m) { return m.matType !== 'template'; });
                    // 更新已显示的对话框（仅更新select和列表内容）
                    var tplSelect = document.getElementById('wr-step-template');
                    if (tplSelect) {
                        tplSelect.innerHTML = '<option value="">-- 不使用模板 --</option>'
                            + allTpls.map(function(t){ return '<option value="tpl:'+t._src+':'+t.id+'">'+wrEsc(t.title)+'</option>'; }).join('');
                    }
                    var matDiv = document.querySelector('.wr-step-modal > div > div:nth-child(4) > div');
                    if (matDiv) {
                        matDiv.innerHTML = otherMats.length === 0 ? '<div style="text-align:center;color:gray;padding:16px;">暂无可用资料</div>'
                            : otherMats.map(function(m){ return '<label style="display:block;margin-bottom:5px;"><input type="checkbox" class="wr-step-mat" value="'+m.id+'"> '+wrEsc(m.title||m.fileName)+'</label>'; }).join('');
                    }
                    // 修复C：预填上次选择的模板与资料
                    if (window._wrSelectedTemplate && tplSelect) {
                        var _st = window._wrSelectedTemplate;
                        tplSelect.value = 'tpl:' + _st._src + ':' + _st.id;
                    }
                    if ((window._wrSelectedMaterialIds || []).length) {
                        document.querySelectorAll('.wr-step-mat').forEach(function(cb) {
                            if (window._wrSelectedMaterialIds.indexOf(parseInt(cb.value)) !== -1) cb.checked = true;
                        });
                    }
                }).catch(function(e) {
                    console.warn('资料库异步加载失败:', e);
                    window._wrAllMats = [];
                    window._wrAllTpls = [];
                });
            };

            window.wrConfirmSelection = function() {
                var templateSelect = document.getElementById('wr-step-template');
                var selectedVal = templateSelect ? templateSelect.value : '';
                var selectedMatIds = Array.from(document.querySelectorAll('.wr-step-mat:checked')).map(function(cb){ return parseInt(cb.value); });

                // 使用缓存的数据，不再重复读DB（模板来自 _wrAllTpls，参考资料来自 _wrAllMats）
                var mats = window._wrAllMats || [];
                var tpls = window._wrAllTpls || [];
                var selTpl = null;
                if (selectedVal) {
                    // value 形如 tpl:mat:123 / tpl:tpl:5，解析来源与原始 id
                    var parts = selectedVal.split(':');
                    var src = parts[1]; var tid = parseInt(parts[2], 10);
                    selTpl = tpls.find(function(t){ return t._src === src && t.id == tid; }) || null;
                }
                window._wrSelectedTemplate = selTpl;
                window._wrSelectedMaterialIds = selectedMatIds;
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

            // ---- 按类型导入文件 ----
            window.wrImportWithType = async function(matType) {
                // 关闭类型选择弹窗
                const modal = document.getElementById('wr-import-type-modal');
                if (modal) modal.style.display = 'none';

                // 创建文件选择input
                const fileInput = document.createElement('input');
                fileInput.type = 'file';
                fileInput.accept = '.docx,.pdf,.xlsx,.xls,.json,.txt';
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
                    
                    let processed = 0;
                    let successCount = 0;
                    let errorMessages = [];
                    
                    // 确保数据库已打开
                    try {
                        await wrOpenDB();
                        console.log('[导入] 数据库已打开');
                    } catch(dbErr) {
                        console.error('[导入] 数据库打开失败:', dbErr);
                        loadingToast.remove();
                        alert('数据库打开失败: ' + (dbErr.message || '未知错误'));
                        fileInput.remove();
                        return;
                    }
                    
                    // 按需加载解析库
                    await Promise.all([
                        loadScript('https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js'),
                        loadScript('https://cdnjs.cloudflare.com/ajax/libs/mammoth/1.4.2/mammoth.browser.min.js')
                    ]);
                    
                    for (const file of files) {
                        console.log('[导入] 开始处理文件:', file.name, '类型:', matType);
                        try {
                            const item = {
                                matType: matType,
                                fileName: file.name,
                                title: file.name.replace(/\.[^.]+$/, ''), // 去掉扩展名作为标题
                                fileSize: file.size,
                                importAt: Date.now(),
                                content: '',
                                rawText: ''
                            };
                            
                            // 根据文件类型解析内容
                            if (file.name.endsWith('.json')) {
                                const text = await file.text();
                                try {
                                    const data = JSON.parse(text);
                                    
                                    // 检测是否为导出备份格式（含 materials / reports 数组）
                                    let jsonItems = null;
                                    let jsonReports = null;
                                    if (data.materials && Array.isArray(data.materials)) {
                                        jsonItems = data.materials; // 导出备份格式，拆分存储
                                    }
                                    if (data.reports && Array.isArray(data.reports)) {
                                        jsonReports = data.reports;
                                    }
                                    if (!jsonItems && Array.isArray(data)) {
                                        jsonItems = data; // 纯数组格式，拆分存储
                                    }

                                    if (jsonItems && jsonItems.length > 0) {
                                        // 拆分存储：每条记录独立存入数据库
                                        console.log('[导入] JSON检测到' + jsonItems.length + '条资料记录，拆分存储');
                                        for (const ji of jsonItems) {
                                            const jiTitle = ji.title || ji.name || ji.fileName || file.name + '_' + jsonItems.indexOf(ji);
                                            const jiContent = ji.content || '';
                                            const jiMatType = ji.matType || ji.type || matType; // 优先用自带分类，否则用用户选的
                                            
                                            await wrDbPut(WR_MAT_STORE, {
                                                matType:   jiMatType,
                                                fileName:  ji.fileName || file.name,
                                                title:     String(jiTitle).slice(0, 200),
                                                fileSize:  ji.fileSize || file.size,
                                                importAt:  ji.importAt || Date.now(),
                                                content:   String(jiContent).slice(0, 20000),
                                                sheets:    ji.sheets || null,
                                                rowCount:  ji.rowCount || null,
                                                rawText:   String(jiContent).slice(0, 5000)
                                            });
                                        }
                                    }

                                    // 同时导入历史报告
                                    if (jsonReports && jsonReports.length > 0) {
                                        console.log('[导入] JSON检测到' + jsonReports.length + '篇历史报告，写入数据库');
                                        for (const r of jsonReports) {
                                            await wrDbPut(WR_RPT_STORE, {
                                                id:        r.id || undefined,
                                                title:     r.title || '',
                                                content:   r.content || '',
                                                prompt:    r.prompt || '',
                                                createdAt: r.createdAt || Date.now(),
                                                materialCount: r.materialCount || { issues: 0, rules: 0, reports: 0 }
                                            });
                                        }
                                    }

                                    if (jsonItems || jsonReports) {
                                        processed++;
                                        // 文件级成功计数（与分母 files.length 一致）：仅当确有记录/报告写入才计 1
                                        if ((jsonItems && jsonItems.length > 0) || (jsonReports && jsonReports.length > 0)) successCount++;
                                        continue;
                                    }
                                    
                                    // 非数组格式（单条JSON对象），作为整体存储
                                    item.content = JSON.stringify(data);
                                    item.rawText = typeof data === 'object' ? JSON.stringify(data, null, 2).slice(0, 5000) : String(data);
                                } catch(err) {
                                    item.rawText = text.slice(0, 5000);
                                    item.content = text;
                                }
                            } else if (file.name.endsWith('.txt')) {
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
                                        if (matType === 'template') {
                                            item.templateBuffer = arrayBuffer;
                                        }
                                    } catch(err) {
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
                                    } catch(err) {
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
                                    } catch(err) {
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
                                } catch(err) {
                                    item.rawText = '[' + file.name + '] 文件内容无法读取';
                                    item.content = item.rawText;
                                }
                            }
                            
                            console.log('[导入] 准备保存到数据库:', item.title);
                            const savedId = await wrDbPut(WR_MAT_STORE, item);
                            console.log('[导入] 保存成功, ID:', savedId);
                            successCount++;
                        } catch(err) {
                            console.error('导入失败：' + file.name, err);
                            errorMessages.push(file.name + ': ' + (err.message || '未知错误'));
                        }
                        processed++;
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
                    if (errorMessages.length > 0) {
                        msg += '\n\n❌ 导入失败 ' + errorMessages.length + ' 个：\n' + errorMessages.join('\n');
                    }
                    if (tip) msg += '\n' + tip;
                    alert(msg);
                    
                    fileInput.remove();
                };
                
                // 处理用户取消选择文件的情况
                fileInput.addEventListener('cancel', function() {
                    console.log('用户取消了文件选择');
                    fileInput.remove();
                });
                
                document.body.appendChild(fileInput);
                
                // 延迟触发点击，确保DOM已更新
                setTimeout(() => {
                    fileInput.click();
                }, 100);
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
                const stops = new Set(['的','了','和','与','帮','我','写','一份','一个','关于','针对','请','生成','制作']);
                result.keywords = query.replace(/[，。、！？（）""''《》\s]+/g,' ').split(' ')
                    .map(w => w.trim()).filter(w => w.length >= 2 && !stops.has(w)).slice(0, 10);

                return result;
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
                if (parsedQuery.dateRange) {
                    const { start, end } = parsedQuery.dateRange;
                    filtered = filtered.filter(iss => {
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
                }

                // 关键词过滤（如果日期过滤后还有内容，就用关键词再过滤；否则直接用关键词）
                if (filtered.length === 0 && parsedQuery.dateRange) filtered = issues;
                if (parsedQuery.keywords.length > 0) {
                    const scored = filtered.map(iss => {
                        const text = ((iss.content||'')+(iss.category||'')+(iss['性质']||'')).toLowerCase();
                        const score = parsedQuery.keywords.reduce((s,k) => s + (text.includes(k.toLowerCase()) ? 1 : 0), 0);
                        return { iss, score };
                    }).filter(x => x.score > 0).sort((a,b) => b.score - a.score);
                    filtered = scored.map(x => x.iss);
                }

                return filtered.slice(0, 50); // 最多50条
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
                // 关键词匹配
                if (parsedQuery.keywords.length > 0) {
                    const scored = templates.map(t => {
                        const text = ((t.title||'')+(t.content||'')).toLowerCase();
                        const score = parsedQuery.keywords.reduce((s,k) => s + (text.includes(k.toLowerCase()) ? 1 : 0), 0);
                        return { t, score };
                    }).filter(x => x.score > 0).sort((a,b) => b.score - a.score);
                    if (scored.length) return scored[0].t;
                }
                // 兜底：最近更新/导入的一条
                return templates.sort((a,b) => (b.importAt || b.updatedAt || b.createdAt || 0) - (a.importAt || a.updatedAt || a.createdAt || 0))[0];
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
                    const text = ((r.title||'')+(r.content||'').slice(0,500)).toLowerCase();
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
                    const text = ((r.title||'')+(r.content||'').slice(0,300)).toLowerCase();
                    const score = kws.reduce((s,k) => s + (text.includes(k.toLowerCase()) ? 1 : 0), 0);
                    return { r, score };
                }).filter(x => x.score > 0).sort((a,b) => b.score - a.score);
                return scored.slice(0, 8).map(x => x.r);
            }

            /**
             * 汇总台账统计数据（用于填充占位符）
             */
            function wrSummarizeIssues(issues) {
                if (!issues.length) return null;
                const total = issues.length;
                const natCount = {};
                issues.forEach(iss => {
                    const n = iss['性质'] || iss.nature || '其他';
                    natCount[n] = (natCount[n] || 0) + 1;
                });
                const natSummary = Object.entries(natCount).map(([k,v]) => k + v + '条').join('、');
                // 提取典型问题（取前5条）
                const typicals = issues.slice(0, 5).map((iss, i) =>
                    (i+1) + '. [' + (iss['性质']||'') + '][' + (iss.category||'') + '] ' + (iss.content||'').slice(0, 100)
                ).join('\n');
                return { total, natSummary, typicals };
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
                const stats = wrSummarizeIssues(issues);
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
                    const text = ((m.title||'') + ' ' + String(m.content||'').slice(0, 800)).toLowerCase();
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
                    const rt = (materials && materials.parsed && materials.parsed.reportType) || '';
                    const relatedTypes = ({
                        monthly: ['stats', 'check', 'fault', 'inspect'],
                        check:   ['check', 'fault', 'stats', 'inspect'],
                        accident:['fault', 'stats', 'notice'],
                        rectify: ['check', 'fault', 'notice'],
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
                const filtered = issues.filter(iss => {
                    if (!iss.datetime) return false;
                    const d = new Date(iss.datetime);
                    return d >= new Date(start) && d <= new Date(end);
                });
                if (filtered.length === 0) return null;
                const total = filtered.length;
                const catMap = { 'A': 0, 'B': 0, 'C': 0, '红线': 0, '其他': 0 };
                filtered.forEach(iss => {
                    const xz = (iss['性质'] || '').trim();
                    if (xz.includes('A')) catMap['A']++;
                    else if (xz.includes('B')) catMap['B']++;
                    else if (xz.includes('C')) catMap['C']++;
                    else if (xz.includes('红线')) catMap['红线']++;
                    else catMap['其他']++;
                });
                const typicals = filtered.slice(0, 5).map((iss, idx) =>
                    (idx + 1) + '. [' + (iss['性质'] || '') + '][' + (iss.category || '') + '] ' + String(iss.content || '').slice(0, 100)
                ).join('\n');
                return { total, catMap, typicals, dateLabel: parsedQuery.dateLabel || '' };
            }

            function wrBuildPrompt(query, materials, uploadedContent) {
                const { parsed, template, issues, stats, similarReports, ruleCandidates, localMaterials } = materials;
                const today = new Date();
                const todayStr = today.getFullYear() + '年' + (today.getMonth()+1) + '月' + today.getDate() + '日';

                // 从台账提取真实统计（防止 AI 编造数字）
                const realStats = wrExtractStatsFromIssues(parsed);

                const sysLines = [
                    '你是铁路安全监察领域的专业智能写作。请根据用户提供的模板、台账数据、历史报告，生成符合规范的铁路安监文档。',
                    '',
                    '【写作规范】',
                    '1. 严格遵守模板中的章节结构，将占位符（如{{问题总数}}）替换为台账统计数据中的实际数值。',
                    '2. 台账数据必须真实引用，不得虚构数字或案例；如台账数据不足以支撑某章节，用[待补充]标记。',
                    '3. 涉及规章时，只能引用"参考规章条款"中的规章，不得编造。',
                    '4. 【重要】本地资料（故障报告、文电、通报、检查信息等）中的事实和数据必须充分引用，不得忽略。具体案例、问题描述、整改要求等细节应从资料中提取并融入报告正文。',
                    '5. 语言风格：严谨、规范、简洁，使用铁路安监专业术语。',
                    '6. 今天日期：' + todayStr + '。',
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
                        sysLines.push('【重要】若用户需求中包含【上传的文件内容】或本地资料，请在映射值（尤其问题描述、典型案例、整改要求类字段）中充分引用其中的具体事实与数据，不得忽略或编造。');
                    } else {
                        sysLines.push('【输出要求】');
                        sysLines.push('- 直接输出最终文档内容，无需解释说明。');
                        sysLines.push('- 按模板章节结构输出，不随意增减章节。');
                        sysLines.push('- 【关键】必须输出模板中所有章节，不得在中途停止或只输出部分内容，直到全部章节完成为止。');
                        sysLines.push('- 统计数字、日期等关键信息必须与台账数据一致。');
                        sysLines.push('- 【重要】报告中的问题描述、案例分析必须基于提供的本地资料与【上传的文件内容】，不得编造。');
                    }
                } else {
                    sysLines.push('【输出要求】');
                    sysLines.push('- 直接输出最终文档内容，无需解释说明。');
                    sysLines.push('- 按模板章节结构输出，不随意增减章节。');
                    sysLines.push('- 【关键】必须输出模板中所有章节，不得在中途停止或只输出部分内容，直到全部章节完成为止。');
                    sysLines.push('- 统计数字、日期等关键信息必须与台账数据一致。');
                    sysLines.push('- 【重要】报告中的问题描述、案例分析必须基于提供的本地资料与【上传的文件内容】，不得编造。');
                }

                const userLines = ['【用户需求】', query, ''];

                // 【修复 A2】上传文件内容独立成段，明确为"待引用素材"，提升 AI 引用率
                if (uploadedContent && uploadedContent.trim()) {
                    userLines.push('【上传的文件内容（重要素材，请在报告中充分引用其中的具体事实、数据、案例，不得忽略或编造）】');
                    userLines.push(uploadedContent.trim());
                    userLines.push('');
                }

                // 模板（从资料库中获取的模板使用 matType 字段）
                if (template) {
                    const tplType = template.matType || template.category || 'template';
                    userLines.push('【写作模板（' + wrCatName(tplType) + '）】');
                    let tplContent = template.content || '';
                    // 用真实统计数据替换模板占位符（防止 AI 编造数字）
                    if (realStats) {
                        tplContent = tplContent
                            .replace(/{{问题总数}}/g, '【数据:' + realStats.total + '】')
                            .replace(/{{A类数量}}/g,  '【数据:' + realStats.catMap['A'] + '】')
                            .replace(/{{B类数量}}/g,  '【数据:' + realStats.catMap['B'] + '】')
                            .replace(/{{C类数量}}/g,  '【数据:' + realStats.catMap['C'] + '】')
                            .replace(/{{红线数量}}/g, '【数据:' + realStats.catMap['红线'] + '】')
                            .replace(/{{典型问题列表}}/g, '【数据:典型问题\n' + realStats.typicals + '\n】')
                            .replace(/{{日期}}/g, '【数据:' + realStats.dateLabel + '】');
                    }
                    userLines.push(tplContent.slice(0, 6000) + (tplContent.length > 6000 ? '\n（模板内容过长，已截取前6000字，请严格按模板章节结构输出全部内容）' : ''));
                    // 【修复 A1】长模板截断会丢失后半段章节，导致 AI 看不到完整结构却被告知"必须输出全部章节"。
                    // 始终额外注入「章节标题骨架」，确保 AI 能看到全部章节标题，按骨架补全被截断的正文。
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
                    userLines.push('');
                } else {
                    userLines.push('【写作模板】');
                    userLines.push('（无指定模板，请按照铁路安监文档规范自行拟定章节结构）');
                    userLines.push('');
                }

                // 台账统计
                if (stats && issues.length > 0) {
                    userLines.push('【台账统计数据（' + parsed.dateLabel + '，共' + stats.total + '条）—— 这些数字已由系统统计，报告中必须完全照搬，不得修改】');
                    userLines.push('- 问题总数：' + stats.total + '条');
                    userLines.push('- 问题性质分布：' + stats.natSummary);
                    if (realStats) {
                        userLines.push('- A类：' + realStats.catMap['A'] + '条，B类：' + realStats.catMap['B'] + '条，C类：' + realStats.catMap['C'] + '条，红线：' + realStats.catMap['红线'] + '条');
                        userLines.push('- 典型问题（前5条，必须完整引用）：');
                        userLines.push(realStats.typicals);
                    } else {
                        userLines.push('- 典型问题（前5条）：');
                        userLines.push(stats.typicals);
                    }
                    userLines.push('');
                } else {
                    userLines.push('【台账数据】');
                    userLines.push('（' + (parsed.dateLabel ? parsed.dateLabel + '期间' : '') + '暂无匹配台账数据，请在正文中使用[待补充]标记）');
                    userLines.push('');
                }

                // 本地资料库（故障报告、文电、通报等）
                if (localMaterials && localMaterials.length > 0) {
                    userLines.push('【本地资料（共' + localMaterials.length + '份，必须充分引用其中的具体案例和数据）】');
                    localMaterials.forEach((m, i) => {
                        const typeInfo = (typeof WR_MAT_TYPES !== 'undefined' ? WR_MAT_TYPES : {})[m.matType] || { label: m.matType };
                        userLines.push('── 资料' + (i+1) + '【' + typeInfo.label + '】《' + (m.title||m.fileName) + '》');
                        // 内容长度扩展到5000字，让AI能看到更多细节
                        const content = String(m.content || '');
                        userLines.push(content.slice(0, 5000) + (content.length > 5000 ? '…（共' + content.length + '字，已截断）' : ''));
                        userLines.push('');
                    });
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
                if (window._wrSelectedTemplate) {
                    tags.push('<span style="background:#dbeafe;color:#1e40af;padding:3px 10px;border-radius:20px;font-size:0.78rem;">📄 ' + wrEsc(window._wrSelectedTemplate.title) + '</span>');
                }
                if (window._wrSelectedMaterialIds && window._wrSelectedMaterialIds.length > 0) {
                    tags.push('<span style="background:#eff6ff;color:#1d4ed8;padding:3px 10px;border-radius:20px;font-size:0.78rem;">📁 已选' + window._wrSelectedMaterialIds.length + '份资料</span>');
                }
                if (!window._wrSelectedTemplate && (!window._wrSelectedMaterialIds || window._wrSelectedMaterialIds.length === 0)) {
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

                html += '<div style="margin-bottom:8px;"><strong>📊 台账数据：</strong>'
                    + '<span style="color:#059669;">生成时将自动检索检查信息台账（确保数字真实）</span></div>';

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
                if (!q.trim()) { alert('请输入写作需求'); return; }
                var apiKey = localStorage.getItem('ds_api_key_v1') || '';
                const apiUrl = localStorage.getItem(WR_API_URL_K) || 'https://api.deepseek.com/chat/completions';
                const model  = localStorage.getItem(WR_MODEL_K) || 'deepseek-v4-flash';
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

                    if (!isRegenerate && !window._wrSkipLocalSearch) {
                        wrAppendChatBubble('user', q);
                        _wrConvHistory.push({ role: 'user', content: enhancedQuery, timestamp: Date.now() });
                        document.getElementById('wr-query-input').value = '';
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

                    // 自动检索 vs 手动选择逻辑：
                    // 未手动选择资料库资料 → 全自动检索（台账/模板/本地资料/历史报告/规则）
                    // 已手动选择资料库资料 → 用手选资料，仍自动检索台账/规则/相似报告（保证数字真实、不编造）
                    //
                    // ⚠️ 关键修正：_wrSkipLocalSearch 仅表示「跳过台账/规则自动检索」（修改模式或包装层为性能考虑设置），
                    //    绝不能因此丢弃用户手选的模板与资料。模板与手选资料始终按用户选择保留。
                    const manualMatIds = (window._wrSelectedMaterialIds || []).filter(Boolean);
                    const useManual = manualMatIds.length > 0;
                    const skipAuto = !!window._wrSkipLocalSearch; // 仅跳过台账/规则/相似报告的自动检索
                    let materials;
                    if (useManual) {
                        // 手选资料：合并所选资料；是否跳过台账自动检索由 skipAuto 决定（性能），但模板与资料始终保留
                        const allMats = await wrDbGetAll(WR_MAT_STORE);
                        const chosenLocal = allMats.filter(m => manualMatIds.includes(m.id) && m.matType !== 'template');
                        let auto = null;
                        if (!skipAuto) { try { auto = await wrRetrieveMaterials(q); } catch (e) { auto = null; } }
                        materials = {
                            parsed: (auto && auto.parsed) || wrParseQuery(q),
                            template: window._wrSelectedTemplate || (auto && auto.template) || null,
                            issues: (auto && auto.issues) || [],
                            stats: (auto && auto.stats) || null,
                            similarReports: (auto && auto.similarReports) || [],
                            ruleCandidates: (auto && auto.ruleCandidates) || [],
                            localMaterials: chosenLocal
                        };
                    } else if (skipAuto) {
                        // 修改模式（未手选资料）：原报告已含全部内容，跳过本地检索，避免无关资料噪声
                        materials = { parsed: wrParseQuery(q) || { dateLabel: '' }, template: null, issues: [], stats: null, similarReports: [], ruleCandidates: [], localMaterials: [] };
                    } else {
                        try { materials = await wrRetrieveMaterials(q); }
                        catch (e) { console.warn('自动检索失败，回退空资料', e); materials = { parsed: wrParseQuery(q), template: null, issues: [], stats: null, similarReports: [], ruleCandidates: [], localMaterials: [] }; }
                        // 修复A：弹窗中手选模板优先于自动匹配（只选模板未勾资料时仍应生效）
                        if (window._wrSelectedTemplate) materials.template = window._wrSelectedTemplate;
                    }
                    const parsed = materials.parsed;
                    const template = materials.template;

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
                    const _wrTimeoutMs = 180000;
                    const _wrTimeout = setTimeout(() => {
                        if (_wrAbortController) {
                            window._wrTimedOut = true;
                            try { _wrAbortController.abort(new Error('TimeoutError')); } catch (e) {}
                        }
                    }, _wrTimeoutMs);
                    const resp = await fetch(apiUrl, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + apiKey },
                        body: JSON.stringify({
                            model, messages, stream: true, temperature: 0.3, max_tokens: 16384
                        }),
                        signal: _wrAbortController.signal
                    });

                    if (!resp.ok) {
                        const hints = { 401:'API Key 无效', 402:'账户余额不足', 403:'无访问权限', 429:'请求过于频繁' };
                        throw new Error(hints[resp.status] || 'HTTP ' + resp.status);
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
                    if (template && template.content) {
                        // 尝试从模型输出提取映射（模型被要求输出 JSON 映射，可能夹带尾注/解释）
                        let mapping = wrParseMapping(fullText);
                        if (!mapping) { try { mapping = _wrExtractJson(fullText); } catch (e) {} }
                        if (mapping && typeof mapping === 'object' && Object.keys(mapping).length) {
                            fullText = applyTemplatePlaceholders(template.content, mapping);
                        } else if (/\{\{[^}]+\}\}/.test(fullText)) {
                            // 模型已直接撰写正文但残留占位符：保留正文，仅把残留占位符标记待补充（绝不丢弃模板/正文）
                            fullText = fullText.replace(/\{\{([^}]+)\}\}/g, '（待补充：$1）');
                        }
                        // 否则：模型已直接输出完整文档（占位符已内联填充），原样保留
                        // 重新渲染气泡：模板替换后内容已是 HTML，不能用 wrStreamFormat（会二次转义）
                        if (streamBubbleContent) streamBubbleContent.innerHTML = fullText;
                        const histEl = document.getElementById('wr-chat-history');
                        if (histEl) histEl.scrollTop = histEl.scrollHeight;
                    }

                    // 记录到对话历史
                    _wrConvHistory.push({ role: 'assistant', content: fullText, timestamp: Date.now() });

                    // 保存当前报告内容
                    window._wrCurrentReportContent = fullText;
                    window._wrCurrentReportQuery   = enhancedQuery;
                    window._wrCurrentReportOrigQuery = q;
                    window._wrCurrentReportParsed  = parsed;

                    // 保存到历史
                    const isModify = !!window._wrSkipLocalSearch;
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
                                reports: (materials.similarReports || []).length
                            },
                            date: Date.now(),
                            templateId: template ? template.id : null,
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


            // 语音朗读当前报告
            window.wrSpeak = function() {
                const text = (window._wrCurrentReportContent || '').replace(/【数据[^\]】]*】/g, '');
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
                                matHtml += '<label style="display:flex;align-items:center;gap:8px;padding:8px 10px;border:1px solid var(--border);border-radius:6px;background:#f8fafc;cursor:pointer;font-size:0.85rem;" onmouseover="this.style.background=\'#eff6ff\'" onmouseout="this.style.background=\'#f8fafc\'">'
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
                        + '<span style="font-weight:700;font-size:0.97rem;color:var(--primary);">📝 修改报告 - 增加资料</span>'
                        + '<button onclick="this.closest(\'[style*=position\\:fixed]\').remove()" style="background:none;border:none;cursor:pointer;font-size:1.2rem;color:#888;">✕</button>'
                        + '</div>'
                        + '<div style="font-size:0.8rem;color:var(--text-secondary);">勾选需要补充的资料（可多选），然后点击确认完成报告</div>'
                        + matHtml
                        + '<div style="display:flex;gap:10px;margin-top:8px;">'
                        + '<button onclick="wrConfirmModify()" style="flex:1;padding:10px;background:var(--primary);color:#fff;border:none;border-radius:8px;font-size:0.9rem;font-weight:600;cursor:pointer;">✅ 确认完成报告</button>'
                        + '<button onclick="document.getElementById(\'wr-modify-modal\').remove()" style="padding:10px 16px;border:1px solid var(--border);border-radius:8px;background:#f8fafc;font-size:0.9rem;cursor:pointer;">取消</button>'
                        + '</div>'
                        + '</div>';
                    document.body.appendChild(modal);
                });
            };

            // 确认修改报告
            window.wrConfirmModify = async function() {
                const checkboxes = document.querySelectorAll('#wr-modify-modal .wr-modify-mat-checkbox:checked');
                const selectedIds = Array.from(checkboxes).map(cb => parseInt(cb.value));
                window._wrSelectedMaterialIds = selectedIds;
                document.getElementById('wr-modify-modal')?.remove();

                if (!selectedIds.length) {
                    alert('未选择新增资料，报告保持不变。');
                    return;
                }

                // 获取上一轮报告内容
                const previousReport = window._wrCurrentReportContent;
                if (!previousReport) {
                    alert('没有可修改的报告');
                    return;
                }

                const modifyInstruction = `请基于以下【当前报告】内容，并根据新增资料进行补充和完善。不要从头生成，尽量保持原有结构和大部分文字，仅在必要时修改或增加段落。\n\n【当前报告】\n${previousReport}\n\n`;
                const originalInput = document.getElementById('wr-query-input');
                const originalVal = originalInput ? originalInput.value : '';
                if (originalInput) originalInput.value = modifyInstruction + (originalVal || '用户要求：根据新增资料完善报告');
                
                // 复用生成流程
                await wrGenerate();
                
                if (originalInput) originalInput.value = originalVal;
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
                    item.createdAt = now; // 保留（如有旧值以后可恢复，此处简化）
                } else {
                    item.createdAt = now;
                }
                await wrDbPut(WR_TPL_STORE, item);
                modal.style.display = 'none';
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
                inp.onchange = async function(e) {
                    const file = e.target.files[0]; if (!file) return;
                    const text = await file.text();
                    try {
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
                        alert('成功导入 ' + count + ' 个模板！');
                    } catch(err) { alert('解析失败：' + err.message); }
                    inp.remove();
                };
                document.body.appendChild(inp); inp.click();
            };

            window.wrExportTemplates = async function() {
                const templates = await wrDbGetAll(WR_TPL_STORE);
                if (!templates.length) { alert('暂无模板可导出'); return; }
                const blob = new Blob([JSON.stringify({ templates, exportDate: new Date().toISOString() }, null, 2)], { type: 'application/json' });
                window.downloadBlob(blob, '写作模板备份_' + new Date().toISOString().slice(0,10) + '.json');
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
            window.wrDownloadDocxFromTemplate = async function() {
                const modal = document.getElementById('wr-report-modal');
                const report = modal && modal._currentReport;
                if (report) {
                    await exportDocxFromHtml(wrMdToDocxHtml(report.content), report.title || '报告');
                    return;
                }
                if (window._wrCurrentReportContent) {
                    await exportDocxFromHtml(wrMdToDocxHtml(window._wrCurrentReportContent), '报告');
                    return;
                }
                alert('没有可导出的报告');
            };
            // 资料库查看弹窗：导出当前资料/报告为 DOCX
            window.wrDownloadDocxFromMaterial = async function() {
                const modal = document.getElementById('wr-mat-view-modal');
                if (!modal || !modal._content) { alert('没有可导出的内容'); return; }
                const title = (document.getElementById('wr-mat-view-title') && document.getElementById('wr-mat-view-title').textContent) || '资料';
                await exportDocxFromHtml(wrMdToDocxHtml(modal._content), title);
            };

            async function exportDocxFromHtml(htmlContent, fileName) {
                if (!htmlContent || htmlContent.trim() === '') {
                    alert('报告内容为空，无法导出');
                    return;
                }
                // 尝试加载 html-docx-js（国内手机网络可能失败，故用 try/catch 兜底，不抛出）
                if (typeof window.htmlDocx === 'undefined') {
                    try { await window.loadScript('https://cdn.jsdelivr.net/npm/html-docx-js@0.3.1/dist/html-docx.js'); }
                    catch (e) { /* 忽略，走下方离线兜底 */ }
                }
                if (typeof window.htmlDocx === 'undefined') {
                    try {
                        await new Promise((resolve) => {
                            const script = document.createElement('script');
                            script.src = 'https://cdn.jsdelivr.net/npm/html-docx-js@0.3.1/dist/html-docx.js';
                            script.onload = resolve;
                            script.onerror = resolve; // 失败也继续，走兜底
                            document.head.appendChild(script);
                        });
                    } catch (e) {}
                }
                const isMobile = /Mobi|Android/i.test(navigator.userAgent);
                // 去除 dsMarkdown 代码块内的「下载」按钮（Word 中无意义）
                let cleanHtml = String(htmlContent || '').replace(/<button\b[^>]*>[\s\S]*?<\/button>/gi, '');
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
                ).sort((a,b) => b.date - a.date);

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
                        <div style="display:flex;flex-direction:column;gap:4px;flex-shrink:0;">
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
                let matHtml = '<div style="display:flex;flex-direction:column;gap:6px;max-height:200px;overflow-y:auto;border:1px solid var(--border);border-radius:8px;padding:8px;background:#f8fafc;">';
                if (!suppList.length) {
                    matHtml += '<div style="padding:10px;text-align:center;color:var(--text-secondary);font-size:0.82rem;">暂无可用资料或其它报告（可在「资料中心」导入）</div>';
                } else {
                    const matGroups = {};
                    suppList.forEach((s, idx) => { if (s.kind === 'mat') { const t = s.label; (matGroups[t] = matGroups[t] || []).push(idx); } });
                    Object.keys(matGroups).forEach(t => {
                        matHtml += '<div style="font-size:0.76rem;font-weight:600;color:var(--primary);margin:4px 0 2px;">' + wrEsc(t) + '</div>';
                        matGroups[t].forEach(idx => {
                            const s = suppList[idx];
                            matHtml += '<label style="display:flex;align-items:center;gap:8px;padding:6px 8px;border:1px solid var(--border);border-radius:6px;background:#fff;cursor:pointer;font-size:0.82rem;">'
                                + '<input type="checkbox" class="wr-modify-hist-mat" value="' + idx + '" style="cursor:pointer;">'
                                + '<span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + wrEsc(s.title) + '</span></label>';
                        });
                    });
                    const reportIdxs = suppList.map((s, idx) => s.kind === 'report' ? idx : -1).filter(i => i >= 0);
                    if (reportIdxs.length) {
                        matHtml += '<div style="font-size:0.76rem;font-weight:600;color:var(--primary);margin:6px 0 2px;">📄 历史报告（勾选后从中抽取相关内容补充）</div>';
                        reportIdxs.forEach(idx => {
                            const s = suppList[idx];
                            matHtml += '<label style="display:flex;align-items:center;gap:8px;padding:6px 8px;border:1px solid var(--border);border-radius:6px;background:#fff;cursor:pointer;font-size:0.82rem;">'
                                + '<input type="checkbox" class="wr-modify-hist-mat" value="' + idx + '" style="cursor:pointer;">'
                                + '<span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + wrEsc(s.title) + '</span></label>';
                        });
                    }
                }
                matHtml += '</div>';

                const modal = document.createElement('div');
                modal.id = 'wr-modify-history-modal';
                modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.45);z-index:10100;display:flex;align-items:center;justify-content:center;';
                modal.innerHTML = '<div style="background:#fff;border-radius:14px;padding:20px;width:min(480px,95vw);max-height:85vh;display:flex;flex-direction:column;gap:12px;overflow-y:auto;">'
                    + '<div style="display:flex;align-items:center;justify-content:space-between;">'
                    + '<span style="font-weight:700;font-size:0.97rem;color:var(--primary);">✏️ 修改报告：' + wrEsc((r.title||'未命名报告').slice(0,20)) + '</span>'
                    + '<button onclick="document.getElementById(\'wr-modify-history-modal\').remove()" style="background:none;border:none;cursor:pointer;font-size:1.2rem;color:#888;">✕</button>'
                    + '</div>'
                    + '<div style="font-size:0.8rem;color:var(--text-secondary);">请输入修改要求，AI 将基于原报告进行调整。</div>'
                    + '<textarea id="wr-modify-instruction" placeholder="例如：增加安全检查项点、补充数据分析段落、调整报告结构..." style="width:100%;min-height:80px;padding:10px;border:1px solid var(--border);border-radius:8px;font-size:0.85rem;resize:vertical;font-family:inherit;"></textarea>'
                    + '<div style="font-size:0.82rem;font-weight:600;color:var(--text);">📎 补充资料（可选，勾选后随修改要求一并提交给 AI）</div>'
                    + matHtml
                    + '<div style="display:flex;gap:10px;margin-top:4px;">'
                    + '<button id="wr-modify-confirm-btn" style="flex:1;padding:10px;background:var(--ds-blue);color:#fff;border:none;border-radius:8px;font-size:0.9rem;font-weight:600;cursor:pointer;">✅ 开始修改</button>'
                    + '<button onclick="document.getElementById(\'wr-modify-history-modal\').remove()" style="padding:10px 16px;border:1px solid var(--border);border-radius:8px;background:#f8fafc;font-size:0.9rem;cursor:pointer;">取消</button>'
                    + '</div></div>';
                document.body.appendChild(modal);
                document.getElementById('wr-modify-confirm-btn').onclick = async function() {
                    var instruction = document.getElementById('wr-modify-instruction').value.trim();
                    // 收集勾选的补充资料
                    var cbs = Array.prototype.slice.call(document.querySelectorAll('#wr-modify-history-modal .wr-modify-hist-mat:checked'));
                    var suppText = '';
                    if (cbs.length) {
                        suppText = cbs.map(function(cb){
                            var s = suppList[parseInt(cb.value, 10)];
                            if (!s) return '';
                            return '【' + s.label + '】' + wrEsc(s.title) + '\n' + (s.content || '').slice(0, 4000);
                        }).filter(Boolean).join('\n\n');
                    }
                    if (!instruction && !suppText) { alert('请输入修改要求或勾选补充资料'); return; }
                    modal.remove();
                    // 将原报告内容、修改要求与补充资料写入输入框
                    var input = document.getElementById('wr-query-input');
                    var oldVal = input ? input.value : '';
                    var fullPrompt = '【原报告】\n' + (r.content || '') + '\n\n【修改要求】\n' + (instruction || '（无文字要求，请依据补充资料完善报告）')
                        + (suppText ? ('\n\n【补充资料】\n' + suppText) : '')
                        + '\n\n请基于原报告内容，按上述修改要求进行补充和完善。对于【补充资料】，仅摘录与修改要求相关的片段有机融入原报告，保持原报告的整体结构、格式与文风，不要整体照搬或替换原报告内容。';
                    window._wrModifyBaseTitle = r.title || '未命名报告';
                    window._wrModifyCategory = r.category || 'other';
                    if (input) input.value = fullPrompt;
                    window._wrSkipLocalSearch = true; // 修改模式跳过自动检索，避免无关噪声（补充资料已显式注入）
                    try {
                        await wrGenerate();
                    } finally {
                        if (input) input.value = oldVal;
                        window._wrSkipLocalSearch = false;
                        window._wrModifyBaseTitle = null;
                        window._wrModifyCategory = null;
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
                window.downloadBlob(blob, '历史报告备份_' + new Date().toISOString().slice(0,10) + '.json');
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
                inp.accept = '.docx,.doc,.xlsx,.xls,.json';
                inp.multiple = true;
                inp.style.display = 'none';
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

            /**
             * 筛选资料类型
             */
            window.wrMaterialFilter = function(type) {
                _wrMatFilter = type;
                // 更新按钮样式（含「全模块数据」聚合入口）
                ['all','template','history','inspect','fault','dispatch','other','allmodule'].forEach(t => {
                    const btn = document.getElementById('wr-mat-filter-' + t);
                    if (!btn) return;
                    if (t === type) {
                        btn.classList.add('active');
                    } else {
                        btn.classList.remove('active');
                    }
                });
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
                // 高亮历史报告按钮
                ['all','template','history','inspect','fault','dispatch','other','allmodule'].forEach(t => {
                    const btn = document.getElementById('wr-mat-filter-' + t);
                    if (!btn) return;
                    if (t === 'history') {
                        btn.classList.add('active');
                    } else {
                        btn.classList.remove('active');
                    }
                });
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
                filtered.sort((a,b) => b.importAt - a.importAt);

                if (countEl) countEl.textContent = filtered.length + '/' + all.length + ' 条资料';
                var setCount = document.getElementById('set-wr-count');
                if (setCount) setCount.textContent = all.length + '条';

                if (!filtered.length) {
                    listEl.innerHTML = '<div style="text-align:center;padding:30px;color:var(--text-secondary);font-size:0.85rem;">'
                        + (q || _wrMatFilter !== 'all' ? '无匹配资料' : '暂无资料，点击「导入文件」上传 DOCX 或 Excel') + '</div>';
                    return;
                }

                listEl.innerHTML = filtered.map(m => {
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
                                <span>${wrFmtDate(m.importAt).slice(0,10)}</span>
                                ${sizeStr ? '<span>'+sizeStr+'</span>' : ''}
                                ${rowStr ? '<span>'+rowStr+'</span>' : ''}
                            </div>
                            <div style="font-size:0.77rem;color:#64748b;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${wrEsc(preview)}…</div>
                        </div>
                        <div style="display:flex;flex-direction:column;gap:4px;flex-shrink:0;">
                            <button onclick="wrViewMaterial(${JSON.stringify(m.id)})" class="wr-mat-btn wr-mat-btn-view">查看</button>
                            ${!isTemplate ? `<button onclick="wrSetAsTemplate(${JSON.stringify(m.id)})" class="wr-mat-btn wr-mat-btn-template" title="设为写作模版">⭐ 设模版</button>` : '<button disabled class="wr-mat-btn" style="background:#f1f5f9;color:#94a3b8;cursor:not-allowed;border:1px solid #e2e8f0;">✓ 已是模版</button>'}
                            <select onchange="wrChangeMaterialType(${JSON.stringify(m.id)},this.value)" class="wr-mat-select" title="修改类型">
                                ${Object.entries(WR_MAT_TYPES).map(([k,v])=>'<option value="'+k+'"'+(k===m.matType?' selected':'')+'>'+v.label+'</option>').join('')}
                            </select>
                            <button onclick="wrDeleteMaterial(${JSON.stringify(m.id)})" class="wr-mat-btn wr-mat-btn-delete">删除</button>
                        </div>
                    </div>`;
                }).join('');
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
                window.downloadBlob(blob, '智能写作备份_' + new Date().toISOString().slice(0,10) + '.json');
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
        wrMigrateAgentMaterials();

        // 资料中心统一渲染后，原有「资料库列表 / 历史报告」刷新函数改为委托到统一渲染器，
        // 保留函数名以兼容所有旧调用点（导入 / 删除 / 设模版 / 改类型 / 报告增删改），避免重复渲染冲突。
        // 注：wrRenderMaterials / wrRenderHistory 的原始实现（含查看/修改/删除/设模版按钮）定义在上方，
        // 此处不再委托到多源聚合，避免覆盖导致资料中心丢失查看/修改/删除功能。
    })();