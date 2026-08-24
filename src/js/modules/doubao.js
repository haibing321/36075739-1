/**
 * Doubao（智能助手）模块
 * ===================================================
 * 包含两部分：
 *   Part A: 核心功能 IIFE（对话/对规/写作/历史记录/API配置/附件处理）
 *   Part B: 增强功能 IIFE（角色切换/长期记忆/统计面板/反馈收集）
 * 
 * 依赖：
 *   - 外部库: JSZip, pdf.js, mammoth.js, XLSX, pinyin
 *   - 模块: utils.js (TAB_LABELS, switchTab, etc.)
 *   - 模块: backup.js 中的 getLocal, writeIndexedDB 等可通过 backup 入口调用
 *   - 需要访问 DOM 元素 ID: panel-doubao, ds-sidebar, ds-chat-box 等
 */

// ============================================================
// Part A: 核心功能 IIFE（原始代码 8350-14798 行）
// ============================================================
        // ========== DeepSeek 智能助手模块 ==========
        (function() {
            'use strict';

            // ---- 常量 ----
            const DS_API_KEY_STORAGE = 'ds_api_key_v1';
            const DS_API_URL_STORAGE = 'ds_api_url_v1';
            const DS_MODEL_STORAGE   = 'ds_model_v1';
            const DS_CHAT_STORAGE    = 'ds_chat_history_v1';
            const DS_CONVERSATIONS_STORAGE = 'ds_conversations_v1'; // 多对话历史存储
            const DS_CURRENT_CONV_ID = 'ds_current_conv_id_v1';     // 当前对话ID
            const DS_DEFAULT_API_URL = 'https://api.deepseek.com/chat/completions';
            const DS_DEFAULT_MODEL   = 'deepseek-v4-flash';
            const DS_MAX_CTX_CHARS   = 6000;  // 单类别最多携带的字符数
            const DS_PLACEHOLDER_KEY = 'YOUR_API_KEY_HERE';

            let dsHistory = [];   // [{role:'user'|'assistant', content:'...'}]
            // 暴露给外部（反馈按钮下载对话用）
            Object.defineProperty(window, 'dsHistory', { get: function(){ return dsHistory; }, configurable: true });
            let dsApiKey  = '';
            let dsApiUrl  = DS_DEFAULT_API_URL;
            let dsModel   = DS_DEFAULT_MODEL;
            let dsStreaming = false;
            window.__dsStreaming = false;
            let dsConversations = []; // 所有对话列表 [{id, title, messages, timestamp, pinned}]
            let dsCurrentConvId = null; // 当前对话ID

            // 全局候选映射表，用于"本地组装对规结论"（三阶段强约束）
            let _globalCandidatesMap = {}; // 已移至 smart-check.js
            window._dsAbortController = null; // 智能对话流式终止控制器

            /**
             * 获取 API Key（统一入口）
             * @returns {Promise<string>} 明文 API Key（空字符串表示无 Key）
             */
            async function _getApiKey() {
                if (dsApiKey) return dsApiKey;
                var raw = localStorage.getItem(DS_API_KEY_STORAGE) || '';
                if (raw) {
                    // 检测旧版加密格式（系统已移除加密，但用户可能留存旧数据）
                    if (raw.charAt(0) === '{' && (raw.indexOf('"e"') !== -1 || raw.indexOf('"iv"') !== -1)) {
                        console.warn('[doubao] 检测到旧版加密的 API Key，系统已不再支持加密。请重新在 API 配置中保存 Key。');
                        return '';
                    }
                    dsApiKey = raw; return raw;
                }
                return '';
            }

            // ===== 多模型（多 API Key）管理 =====
            const DS_PROVIDERS_STORAGE       = 'ds_providers_v1';
            const DS_ACTIVE_PROVIDER_STORAGE = 'ds_active_provider_v1';
            function _genPid() { return 'p_' + Date.now().toString(36) + Math.random().toString(36).slice(2,6); }
            function getProviders() {
                try {
                    var arr = JSON.parse(localStorage.getItem(DS_PROVIDERS_STORAGE) || '[]');
                    return Array.isArray(arr) ? arr : [];
                } catch(e) { return []; }
            }
            function saveProviders(arr) { localStorage.setItem(DS_PROVIDERS_STORAGE, JSON.stringify(arr || [])); }
            function getActiveId() { return localStorage.getItem(DS_ACTIVE_PROVIDER_STORAGE) || ''; }
            function getActiveProvider() {
                var arr = getProviders(), id = getActiveId();
                return arr.filter(function(p){ return p.id === id; })[0] || arr[0] || null;
            }
            // 同步回旧版单配置键，供 agent-core / smart-check / smart-writer / risk 等读取点自动生效
            function syncLegacyKeys(p) {
                if (!p) return;
                localStorage.setItem(DS_API_KEY_STORAGE, p.apiKey || '');
                localStorage.setItem(DS_API_URL_STORAGE, p.apiUrl || DS_DEFAULT_API_URL);
                localStorage.setItem(DS_MODEL_STORAGE, p.model || DS_DEFAULT_MODEL);
                dsApiKey = p.apiKey || ''; dsApiUrl = p.apiUrl || DS_DEFAULT_API_URL; dsModel = p.model || DS_DEFAULT_MODEL;
            }
            function setActiveProvider(id) {
                var arr = getProviders();
                if (!arr.some(function(p){ return p.id === id; })) return;
                localStorage.setItem(DS_ACTIVE_PROVIDER_STORAGE, id);
                syncLegacyKeys(getActiveProvider());
                updateApiStatusBadge();
                if (typeof renderChatModelSelect === 'function') renderChatModelSelect();
            }
            // 兼容旧版：仅存在 ds_api_key_v1 等单配置时，构造一个默认模型条目
            function migrateLegacyApiConfig() {
                if (getProviders().length) return;
                var oldKey = localStorage.getItem(DS_API_KEY_STORAGE) || '';
                if (!oldKey) return; // 无 Key 视为未配置，不迁移
                var oldUrl = localStorage.getItem(DS_API_URL_STORAGE) || DS_DEFAULT_API_URL;
                var oldModel = localStorage.getItem(DS_MODEL_STORAGE) || DS_DEFAULT_MODEL;
                var p = { id: _genPid(), name: '默认模型 (' + oldModel + ')', apiUrl: oldUrl, model: oldModel, apiKey: oldKey };
                saveProviders([p]);
                localStorage.setItem(DS_ACTIVE_PROVIDER_STORAGE, p.id);
            }
            function addOrUpdateProvider(p) {
                var arr = getProviders();
                if (p.id) {
                    var idx = -1;
                    arr.forEach(function(x, i){ if (x.id === p.id) idx = i; });
                    if (idx >= 0) { arr[idx] = Object.assign({}, arr[idx], p); }
                    else arr.push(p);
                } else {
                    p.id = _genPid();
                    arr.push(p);
                }
                saveProviders(arr);
                if (!getActiveId() || !arr.some(function(x){ return x.id === getActiveId(); })) {
                    localStorage.setItem(DS_ACTIVE_PROVIDER_STORAGE, p.id);
                }
                syncLegacyKeys(getActiveProvider());
                updateApiStatusBadge();
                if (typeof renderChatModelSelect === 'function') renderChatModelSelect();
                if (typeof renderModelManager === 'function') renderModelManager();
            }
            function deleteProvider(id) {
                var arr = getProviders().filter(function(p){ return p.id !== id; });
                saveProviders(arr);
                if (getActiveId() === id) {
                    localStorage.setItem(DS_ACTIVE_PROVIDER_STORAGE, arr.length ? arr[0].id : '');
                }
                syncLegacyKeys(getActiveProvider());
                updateApiStatusBadge();
                if (typeof renderChatModelSelect === 'function') renderChatModelSelect();
                if (typeof renderModelManager === 'function') renderModelManager();
            }
            // chat 工具栏模型选择下拉
            function renderChatModelSelect() {
                var sel = document.getElementById('ds-model-select');
                if (!sel) return;
                var arr = getProviders();
                var activeId = getActiveId();
                var html = '';
                arr.forEach(function(p){
                    html += '<option value="' + p.id + '"' + (p.id === activeId ? ' selected' : '') + '>' + dsEsc(p.name || p.model) + '</option>';
                });
                if (!arr.length) html += '<option value="">（未配置模型）</option>';
                sel.innerHTML = html;
                sel.onchange = function(){ setActiveProvider(sel.value); if (window.updateModeStatus) window.updateModeStatus(); };
                if (window.updateModeStatus) window.updateModeStatus();
                // 通知下拉菜单重建（模型列表可能变化）
                try { sel.dispatchEvent(new Event('ds-rebuild')); } catch(e){}
            }

            // ---- 初始化 ----
            function dsInit() {
                migrateLegacyApiConfig();
                var ap = getActiveProvider();
                if (ap) { dsApiKey = ap.apiKey || ''; dsApiUrl = ap.apiUrl || DS_DEFAULT_API_URL; dsModel = ap.model || DS_DEFAULT_MODEL; }
                else { dsApiKey = ''; dsApiUrl = DS_DEFAULT_API_URL; dsModel = DS_DEFAULT_MODEL; }
                
                updateApiStatusBadge();
                // 加载多对话历史
                dsLoadConversations();
                // 默认显示新对话（但复用已有的空对话，避免重复创建）
                const existingEmpty = dsConversations.find(c => !c.messages || c.messages.length === 0);
                if (existingEmpty) {
                    dsCurrentConvId = existingEmpty.id;
                    dsHistory = [];
                } else {
                    dsCurrentConvId = dsGenerateId();
                    dsHistory = [];
                    dsConversations.unshift({
                        id: dsCurrentConvId,
                        title: '新对话',
                        messages: [],
                        timestamp: Date.now(),
                        pinned: false
                    });
                    dsSaveConversations();
                }
                localStorage.setItem(DS_CURRENT_CONV_ID, dsCurrentConvId);
                dsRenderAll();
                dsScrollBottom();
                dsRenderHistoryList();
                // 初始化侧边栏隐藏位置（适配手机端vw宽度）
                (function() {
                    var sb = document.getElementById('ds-sidebar');
                    if (sb) sb.style.left = '-' + (sb.offsetWidth + 20) + 'px';
                })();
                // DeepSeek 习惯：Enter 发送，Shift+Enter 换行（兼容 Ctrl+Enter）
                document.getElementById('ds-user-input').addEventListener('keydown', function(e) {
                    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); dsSendMsg(); }
                    else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); dsSendMsg(); }
                });
                // 根据 API Key 状态切换豆包网页版/本地模块
                toggleDoubaoMode();
                // 渲染 chat 工具栏模型选择下拉
                renderChatModelSelect();
                // 角色/模型圆形图标按钮下拉初始化（与附件/发送同款）
                dsInitDropdowns();
            }

            // ---- 多对话管理 ----
            function dsLoadConversations() {
                try {
                    const saved = localStorage.getItem(DS_CONVERSATIONS_STORAGE);
                    if (saved) {
                        dsConversations = JSON.parse(saved);
                    } else {
                        // 兼容旧版本：从单对话迁移
                        const oldHistory = localStorage.getItem(DS_CHAT_STORAGE);
                        if (oldHistory) {
                            const messages = JSON.parse(oldHistory);
                            if (messages.length > 0) {
                                const firstUserMsg = messages.find(m => m.role === 'user');
                                const title = firstUserMsg ? firstUserMsg.content.slice(0, 20) : '历史对话';
                                dsConversations = [{
                                    id: Date.now().toString(),
                                    title: title,
                                    messages: messages,
                                    timestamp: Date.now(),
                                    pinned: false
                                }];
                                dsSaveConversations();
                            }
                        }
                    }
                } catch(e) { dsConversations = []; }
            }

            function dsSaveConversations() {
                try {
                    localStorage.setItem(DS_CONVERSATIONS_STORAGE, JSON.stringify(dsConversations));
                } catch(e) {
                    // P3 修复：localStorage 写入超限（多为图片 base64 过大）时，降级移除对话中的图片块后重试，
                    // 避免静默丢失全部对话历史。仍失败则提示用户。
                    try {
                        var slim = (dsConversations || []).map(function(c) {
                            if (!c || !Array.isArray(c.messages)) return c;
                            c.messages = c.messages.map(function(m) {
                                if (m && m.visionContent) {
                                    // 移除图片块，仅保留纯文本（已是 content 字符串），丢弃视觉数组
                                    delete m.visionContent;
                                }
                                // 防止 content 本身为数组（异常残留）写入失败
                                if (m && Array.isArray(m.content)) {
                                    m.content = (m.displayText || '[图片对话]');
                                }
                                return m;
                            });
                            return c;
                        });
                        localStorage.setItem(DS_CONVERSATIONS_STORAGE, JSON.stringify(slim));
                        if (window.Toast && window.Toast.warn) window.Toast.warn('对话包含图片体积过大，已精简图片后保存（图片不再本地留存）。');
                    } catch (e2) {
                        if (window.Toast && window.Toast.error) window.Toast.error('对话历史保存失败：存储空间不足，请清理部分旧对话。');
                    }
                }
            }

            // 生成唯一ID
            function dsGenerateId() {
                return Date.now().toString(36) + Math.random().toString(36).substr(2);
            }

            // 获取对话标题（从第一条用户消息）
            function dsGetConvTitle(messages) {
                const firstUserMsg = messages.find(m => m.role === 'user');
                if (firstUserMsg) {
                    // P2 修复：content 可能为数组（含图片块多模态消息），优先用 displayText 字符串；
                    // 否则对数组取文本块拼接，避免 [object Object] 损坏标题。
                    var _c = firstUserMsg.displayText || firstUserMsg.content;
                    if (Array.isArray(_c)) {
                        _c = _c.filter(function(b) { return b && b.type === 'text'; })
                                 .map(function(b) { return b.text || ''; })
                                 .join('') || '[图片对话]';
                    }
                    _c = String(_c || '');
                    return _c.slice(0, 25) + (_c.length > 25 ? '...' : '');
                }
                return '新对话';
            }

            // 新建对话
            window.dsNewChat = function(saveCurrent = true) {
                // 保存当前对话（如果有内容）
                if (saveCurrent && dsCurrentConvId && dsHistory.length > 0) {
                    const currentConv = dsConversations.find(c => c.id === dsCurrentConvId);
                    if (currentConv) {
                        currentConv.messages = dsHistory.slice(-50);
                        currentConv.title = dsGetConvTitle(currentConv.messages);
                        currentConv.timestamp = Date.now();
                    }
                }
                
                // 创建新对话
                dsCurrentConvId = dsGenerateId();
                dsHistory = [];
                dsConversations.unshift({
                    id: dsCurrentConvId,
                    title: '新对话',
                    messages: [],
                    timestamp: Date.now(),
                    pinned: false
                });
                
                dsSaveConversations();
                localStorage.setItem(DS_CURRENT_CONV_ID, dsCurrentConvId);
                dsRenderAll();
                dsRenderHistoryList();
            };

            // 切换对话
            window.dsSwitchConv = function(convId) {
                if (convId === dsCurrentConvId) return;
                if (dsStreaming) {
                    alert('请等待当前回复完成后再切换对话');
                    return;
                }
                
                // 保存当前对话
                if (dsCurrentConvId && dsHistory.length > 0) {
                    const currentConv = dsConversations.find(c => c.id === dsCurrentConvId);
                    if (currentConv) {
                        currentConv.messages = dsHistory.slice(-50);
                        currentConv.title = dsGetConvTitle(currentConv.messages);
                        currentConv.timestamp = Date.now();
                    }
                }
                
                // 切换到目标对话
                dsCurrentConvId = convId;
                const targetConv = dsConversations.find(c => c.id === convId);
                if (targetConv) {
                    dsHistory = targetConv.messages || [];
                } else {
                    dsHistory = [];
                }
                
                localStorage.setItem(DS_CURRENT_CONV_ID, dsCurrentConvId);
                dsSaveConversations();
                dsRenderAll();
                dsScrollBottom();
                dsRenderHistoryList();
                // 切换对话后自动收起抽屉
                if (_dsSidebarOpen) dsToggleSidebar();
            };

            // 置顶/取消置顶对话
            window.dsTogglePin = function(convId, event) {
                event.stopPropagation();
                const conv = dsConversations.find(c => c.id === convId);
                if (conv) {
                    conv.pinned = !conv.pinned;
                    // 重新排序：置顶的在前，按时间倒序
                    dsConversations.sort((a, b) => {
                        if (a.pinned && !b.pinned) return -1;
                        if (!a.pinned && b.pinned) return 1;
                        return b.timestamp - a.timestamp;
                    });
                    dsSaveConversations();
                    dsRenderHistoryList();
                }
            };

            // 删除对话
            window.dsDeleteConv = function(convId, event) {
                event.stopPropagation();
                if (!confirm('确定删除此对话？')) return;
                
                dsConversations = dsConversations.filter(c => c.id !== convId);
                
                // 如果删除的是当前对话
                if (convId === dsCurrentConvId) {
                    if (dsConversations.length > 0) {
                        // 切换到第一个对话
                        dsCurrentConvId = dsConversations[0].id;
                        dsHistory = dsConversations[0].messages || [];
                    } else {
                        // 没有对话了，创建新对话
                        dsCurrentConvId = dsGenerateId();
                        dsHistory = [];
                        dsConversations.unshift({
                            id: dsCurrentConvId,
                            title: '新对话',
                            messages: [],
                            timestamp: Date.now(),
                            pinned: false
                        });
                    }
                    localStorage.setItem(DS_CURRENT_CONV_ID, dsCurrentConvId);
                }
                
                dsSaveConversations();
                dsRenderAll();
                dsRenderHistoryList();
            };

            // 子模块切换：智能对规 / 智能对话 / 智能写作
            let _dsCurrentSub = 'chat'; // 默认显示智能对话
            window.dsSwitchSub = function(tab) {
                var panels = {
                    check:  document.getElementById('ds-sub-check'),
                    chat:   document.getElementById('ds-sub-chat'),
                    writer: document.getElementById('ds-sub-writer'),
                    risk:   document.getElementById('ds-sub-risk'),
                    agent:  document.getElementById('ds-sub-agent'),
                    doubao: document.getElementById('ds-sub-doubao')
                };
                Object.values(panels).forEach(function(p) { if (p) p.style.display = 'none'; });
                // 防智能体运行锁死（通过 window 函数跨 IIFE 通信）
                if (_dsCurrentSub === 'agent' && tab !== 'agent' && typeof window.clearAgentRunning === 'function') {
                    window.clearAgentRunning();
                }
                if (tab === 'agent' && typeof window.clearAgentRunning === 'function') {
                    window.clearAgentRunning();
                }
                var panel = panels[tab];
                if (panel) panel.style.display = 'flex';
                _dsCurrentSub = tab;
                if (tab === 'writer' && typeof wrInit === 'function') wrInit();
                var sel = document.getElementById('ds-sub-select');
                if (sel) sel.value = tab;
                if (typeof updateModeStatus === 'function') updateModeStatus();
            };
            function updateModeStatus() {
                var sub = _dsCurrentSub || 'chat';
                var labelMap = { chat: '💬 智能对话', check: '⚖️ 智能对规', writer: '✍️ 智能写作', agent: '🧠 智能体', risk: '📊 风险研判', doubao: '🤖 豆包网页版' };
                var modeLabel = document.getElementById('ds-current-mode-label');
                if (modeLabel) modeLabel.textContent = labelMap[sub] || '智能对话';
                var roleSelect = document.getElementById('expertRole');
                var role = roleSelect ? roleSelect.value : 'default';
                var roleMap = { default:'通用', dianwu:'⚡ 电务', gongwu:'🛤️ 工务', gongdian:'🔌 供电', keyun:'🚌 客运', chewu:'🚂 车务', jiwu:'🚄 机务', cheliang:'🚃 车辆', tongxin:'📡 通信', fangjian:'🏗️ 房建', huoyun:'📦 货运', tongyong:'🛡️ 综合', frontend:'💻 前端', riskanalyst:'🔍 风险分析' };
                var roleLabel = document.getElementById('ds-current-role-label');
                if (roleLabel) roleLabel.textContent = roleMap[role] || '通用';
                // 当前模型名（角色/模型已改为输入条圆形图标按钮，选中态在此显示）
                var modelSel = document.getElementById('ds-model-select');
                var modelLabel = document.getElementById('ds-current-model-label');
                if (modelLabel && modelSel) {
                    var mi = modelSel.selectedIndex;
                    var mName = (mi >= 0 && modelSel.options[mi]) ? modelSel.options[mi].text : '';
                    // 简化默认模型展示：去掉「默认模型 (xxx)」前缀，仅保留模型标识
                    mName = mName.replace(/^默认模型\s*[（(](.+?)[）)]\s*$/, '$1');
                    modelLabel.textContent = mName || '未配置模型';
                }
            }
            // 暴露给全局，使 index.html initPage 的首屏角色/模式状态刷新生效（此前因未挂 window 而成为死调用）
            window.updateModeStatus = updateModeStatus;

            // 角色/模型：圆形图标按钮 + 下拉菜单（与附件/发送同款风格）
            function dsInitDropdowns() {
                function setup(kind) {
                    var selId = kind === 'role' ? 'expertRole' : 'ds-model-select';
                    var btnId = kind === 'role' ? 'ds-role-btn' : 'ds-model-btn';
                    var menuId = kind === 'role' ? 'ds-role-menu' : 'ds-model-menu';
                    var sel = document.getElementById(selId);
                    var btn = document.getElementById(btnId);
                    var menu = document.getElementById(menuId);
                    if (!sel || !btn || !menu) return;
                    function build() {
                        var opts = Array.prototype.slice.call(sel.options);
                        menu.innerHTML = opts.map(function(o) {
                            return '<div class="ds-dropdown-item' + (o.selected ? ' active' : '') + '" data-val="' + dsEsc(o.value) + '">' + dsEsc(o.text) + '</div>';
                        }).join('');
                    }
                    build();
                    sel.addEventListener('ds-rebuild', build);
                    btn.addEventListener('click', function(e) {
                        e.stopPropagation();
                        var willOpen = !menu.classList.contains('open');
                        document.querySelectorAll('.ds-dropdown-menu.open').forEach(function(m){ if (m !== menu) m.classList.remove('open'); });
                        menu.classList.toggle('open', willOpen);
                    });
                    menu.addEventListener('click', function(e) {
                        var item = e.target.closest ? e.target.closest('.ds-dropdown-item') : null;
                        if (!item) return;
                        var val = item.getAttribute('data-val');
                        if (sel.value !== val) {
                            sel.value = val;
                            var ev = document.createEvent('HTMLEvents');
                            ev.initEvent('change', true, true);
                            sel.dispatchEvent(ev);
                        }
                        Array.prototype.forEach.call(menu.children, function(c){ c.classList.toggle('active', c === item); });
                        menu.classList.remove('open');
                        if (typeof updateModeStatus === 'function') updateModeStatus();
                    });
                }
                setup('role');
                setup('model');
                document.addEventListener('click', function(e){
                    if (!e.target.closest || !e.target.closest('.ds-dropdown')) {
                        document.querySelectorAll('.ds-dropdown-menu.open').forEach(function(m){ m.classList.remove('open'); });
                    }
                });
            }
            window.dsInitDropdowns = dsInitDropdowns;

            // 历史侧边栏抽屉开关
            let _dsSidebarOpen = false;
            let _dsHistoryFilter = '';
            window.dsToggleSidebar = function() {
                const sidebar = document.getElementById('ds-sidebar');
                const overlay = document.getElementById('ds-sidebar-overlay');
                const icon = document.getElementById('ds-sidebar-toggle-icon');
                const text = document.getElementById('ds-sidebar-toggle-text');
                if (!sidebar) return;
                _dsSidebarOpen = !_dsSidebarOpen;
                // 动态计算隐藏偏移量（适配手机端vw单位）
                const sidebarWidth = sidebar.offsetWidth || 260;
                const btn = document.getElementById('ds-sidebar-toggle-btn');
                if (_dsSidebarOpen) {
                    sidebar.style.left = '0';
                    if (overlay) overlay.style.display = 'block';
                    if (btn) { btn.classList.add('on'); btn.title = '收起侧边栏'; }
                    if (text) text.textContent = '收起';
                    // 打开时自动聚焦搜索框（DeepSeek 习惯）
                    const searchEl = document.getElementById('ds-history-search');
                    if (searchEl) setTimeout(function(){ try { searchEl.focus(); } catch (e) {} }, 300);
                } else {
                    sidebar.style.left = '-' + (sidebarWidth + 20) + 'px';
                    if (overlay) overlay.style.display = 'none';
                    if (btn) { btn.classList.remove('on'); btn.title = '打开历史对话'; }
                    if (text) text.textContent = '历史记录';
                }
            };

            // 渲染历史记录列表（DeepSeek 风格：搜索过滤 + 按日期分组 + 置顶优先）
            function dsRenderHistoryList() {
                const listEl = document.getElementById('ds-history-list');
                if (!listEl) return;

                const kw = (_dsHistoryFilter || '').trim().toLowerCase();
                let list = dsConversations.slice();
                if (kw) list = list.filter(function(c) {
                    // P10 增强：标题或最近消息内容命中即匹配
                    var _titleHit = (c.title || '新对话').toLowerCase().indexOf(kw) !== -1;
                    if (_titleHit) return true;
                    var _msgs = c.messages || [];
                    return _msgs.some(function(m) {
                        var _ct = m.displayText || m.content;
                        if (Array.isArray(_ct)) _ct = _ct.map(function(b){ return b.text || ''; }).join('');
                        return String(_ct || '').toLowerCase().indexOf(kw) !== -1;
                    });
                });

                if (list.length === 0) {
                    listEl.innerHTML = '<div class="ds-history-empty">' + (kw ? '未找到匹配的对话' : '暂无历史记录') + '</div>';
                    return;
                }

                const now = new Date();
                const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
                const DAY = 86400000;
                const groups = [
                    { key: 'pin',    name: '置顶',     items: [] },
                    { key: 'today',  name: '今天',     items: [] },
                    { key: 'yester', name: '昨天',     items: [] },
                    { key: 'week',   name: '七天内',   items: [] },
                    { key: 'month',  name: '三十天内', items: [] },
                    { key: 'older',  name: '更早',     items: [] }
                ];
                list.forEach(conv => {
                    const t = conv.timestamp || 0;
                    if (conv.pinned) { groups[0].items.push(conv); return; }
                    if (t >= startOfToday) groups[1].items.push(conv);
                    else if (t >= startOfToday - DAY) groups[2].items.push(conv);
                    else if (t >= startOfToday - 7 * DAY) groups[3].items.push(conv);
                    else if (t >= startOfToday - 30 * DAY) groups[4].items.push(conv);
                    else groups[5].items.push(conv);
                });

                // 线条图标（照搬 DeepSeek 的线性图标风格，取代 emoji）
                const SVG_PIN = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" width="14" height="14"><path d="M12 17v5"/><path d="M9 4h6l-.6 5.4L17 13H7l2.6-3.6L9 4Z"/></svg>';
                const SVG_DEL = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" width="14" height="14"><path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6l-1 14H6L5 6"/></svg>';

                let html = '';
                groups.forEach(g => {
                    if (g.items.length === 0) return;
                    g.items.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
                    html += '<div class="ds-history-group-title">' + g.name + '</div>';
                    g.items.forEach(conv => {
                        const isActive = conv.id === dsCurrentConvId;
                        html += '<div class="ds-history-item' + (isActive ? ' active' : '') + '" onclick="dsSwitchConv(\'' + conv.id + '\')">' +
                            '<span class="ds-history-title">' + dsEsc(conv.title || '新对话') + '</span>' +
                            '<span class="ds-history-actions">' +
                                '<button class="pin-btn' + (conv.pinned ? ' on' : '') + '" onclick="dsTogglePin(\'' + conv.id + '\', event)" title="' + (conv.pinned ? '取消置顶' : '置顶') + '">' + SVG_PIN + '</button>' +
                                '<button class="del-btn" onclick="dsDeleteConv(\'' + conv.id + '\', event)" title="删除">' + SVG_DEL + '</button>' +
                            '</span>' +
                        '</div>';
                    });
                });

                listEl.innerHTML = html;
            }

            // 历史搜索（由侧边栏搜索框调用）
            window.dsHistorySearch = function(v) {
                _dsHistoryFilter = v || '';
                dsRenderHistoryList();
            };

            // 显示清空选项
            window.dsShowClearOptions = function() {
                if (dsStreaming) return;
                
                const options = [
                    '1. 清空当前对话',
                    '2. 清空所有历史记录',
                    '3. 取消'
                ];
                const choice = prompt('请选择操作：\n\n' + options.join('\n') + '\n\n请输入数字 (1-3)：');
                
                if (choice === '1') {
                    dsClearCurrentChat();
                } else if (choice === '2') {
                    dsClearAllHistory();
                }
                // 选择3或取消则不执行任何操作
            };

            // 清空当前对话
            function dsClearCurrentChat() {
                if (!confirm('确定清空当前对话记录？')) return;
                dsHistory = [];
                
                // 更新当前对话
                const currentConv = dsConversations.find(c => c.id === dsCurrentConvId);
                if (currentConv) {
                    currentConv.messages = [];
                    currentConv.title = '新对话';
                    currentConv.timestamp = Date.now();
                }
                
                dsSaveConversations();
                dsRenderAll();
                dsRenderHistoryList();
            }

            // 清空所有历史
            function dsClearAllHistory() {
                if (!confirm('⚠️ 确定清空所有对话历史？此操作不可恢复！')) return;
                dsConversations = [];
                dsCurrentConvId = null;
                dsHistory = [];
                localStorage.removeItem(DS_CONVERSATIONS_STORAGE);
                localStorage.removeItem(DS_CURRENT_CONV_ID);
                localStorage.removeItem(DS_CHAT_STORAGE);
                dsNewChat(false);
            }

            // ---- 豆包网页版 / 本地模块切换 ----
            function toggleDoubaoMode() {
                var hasApiKey = !!dsApiKey && dsApiKey !== DS_PLACEHOLDER_KEY;
                var webview   = document.getElementById('doubao-webview');
                var subTabs   = document.getElementById('ds-sub-select');
                var subCheck  = document.getElementById('ds-sub-check');
                var subChat   = document.getElementById('ds-sub-chat');
                var subWriter = document.getElementById('ds-sub-writer');
                var agentToolbar = document.getElementById('agent-toolbar');

                // 豆包网页版：未配置 API 时显示
                if (webview) webview.style.display = hasApiKey ? 'none' : 'flex';
                // 子模块 Tab 栏：配置 API 后显示
                if (subTabs) subTabs.style.display = hasApiKey ? 'flex' : 'none';
                // 工具栏：配置 API 后显示
                if (agentToolbar) agentToolbar.style.display = hasApiKey ? 'flex' : 'none';

                if (hasApiKey) {
                    // 已配置 → 显示三个智能子模块，默认激活「智能对话」
                    if (subChat) subChat.style.display = 'flex';
                    if (subCheck) subCheck.style.display = 'none';
                    if (subWriter) subWriter.style.display = 'none';

                    // 确保对话 Tab 高亮
                    var btnChat  = document.getElementById('ds-sub-btn-chat');
                    var btnCheck = document.getElementById('ds-sub-btn-check');
                    var btnWriter= document.getElementById('ds-sub-btn-writer');
                    dsSwitchSub('chat');
                } else {
                    // 未配置 → 隐藏所有子模块，只保留豆包网页版
                    if (subChat) subChat.style.display = 'none';
                    if (subCheck) subCheck.style.display = 'none';
                    if (subWriter) subWriter.style.display = 'none';
                }
            }

            // ---------- API 配置模态框及状态 ----------
            function updateApiStatusBadge() {
                var hasKey = dsApiKey && dsApiKey !== DS_PLACEHOLDER_KEY;
                var icon = document.getElementById('ds-api-status-icon');
                var text = document.getElementById('ds-api-status-text');
                if (icon && text) {
                    if (hasKey) {
                        icon.innerHTML = '✅'; icon.style.color = '#10b981';
                        text.innerHTML = '已配置（' + (dsModel || DS_DEFAULT_MODEL) + '）';
                    } else {
                        icon.innerHTML = '⚪'; icon.style.color = '#94a3b8';
                        text.innerHTML = '未配置 API';
                    }
                }
            }

            // ---- 多模型管理 UI ----
            function renderModelManager() {
                var box = document.getElementById('ds-model-manager');
                if (!box) return;
                var arr = getProviders();
                var activeId = getActiveId();
                var html = '';
                // 当前模型下拉
                html += '<div style="margin-bottom:12px;">';
                html += '<label style="font-weight:600;display:block;margin-bottom:6px;">当前使用模型</label>';
                html += '<select id="ds-active-model-select" style="width:100%;padding:8px 12px;border:1px solid var(--border);border-radius:6px;font-size:0.9rem;">';
                arr.forEach(function(p){
                    html += '<option value="' + p.id + '"' + (p.id === activeId ? ' selected' : '') + '>' + dsEsc(p.name || p.model) + '</option>';
                });
                if (!arr.length) html += '<option value="">（暂无模型，请新增）</option>';
                html += '</select></div>';
                html += '<div style="background:#eff6ff;border:1px solid #93c5fd;border-radius:8px;padding:8px 12px;margin-bottom:12px;font-size:0.76rem;color:#1e40af;line-height:1.6;">智能助手（对话 / 对规 / 写作 / 风险 / 智能体）统一使用「当前使用模型」，切换后立即对所有模块生效。</div>';
                // 模型列表
                html += '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;"><span style="font-weight:600;">已配置模型（' + arr.length + '）</span><button onclick="dsNewProvider()" style="padding:5px 12px;border:1px solid var(--primary);border-radius:8px;background:#eff6ff;color:var(--primary-dark);font-size:0.8rem;cursor:pointer;">＋ 新增模型</button></div>';
                html += '<div id="ds-provider-list" style="display:flex;flex-direction:column;gap:8px;margin-bottom:12px;">';
                arr.forEach(function(p){
                    var isActive = p.id === activeId;
                    html += '<div style="border:1px solid ' + (isActive ? 'var(--primary)' : '#e2e8f0') + ';border-radius:8px;padding:8px 10px;background:' + (isActive ? '#eff6ff' : '#fff') + ';">';
                    html += '<div style="display:flex;justify-content:space-between;align-items:center;gap:8px;">';
                    html += '<div style="min-width:0;"><div style="font-weight:600;font-size:0.85rem;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + dsEsc(p.name || p.model) + (isActive ? ' <span style="color:#1d4ed8;">●当前</span>' : '') + '</div>';
                    html += '<div style="font-size:0.72rem;color:#718096;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + dsEsc(p.model) + ' · ' + dsEsc(p.apiUrl) + '</div></div>';
                    html += '<div style="display:flex;gap:6px;flex-shrink:0;">';
                    if (!isActive) html += '<button onclick="dsSetActiveProvider(\'' + p.id + '\')" style="padding:4px 8px;border:1px solid #86efac;border-radius:6px;background:#f0fdf4;color:#166534;font-size:0.72rem;cursor:pointer;">设为当前</button>';
                    html += '<button class="ds-edit-mini-btn" onclick="dsEditProvider(\'' + p.id + '\')" style="padding:4px 8px;border:1px solid #cbd5e1;border-radius:6px;background:#f8fafc;color:#475569;font-size:0.72rem;cursor:pointer;">编辑</button>';
                    html += '<button onclick="dsDeleteProvider(\'' + p.id + '\')" style="padding:4px 8px;border:1px solid #fca5a5;border-radius:6px;background:#fef2f2;color:#dc2626;font-size:0.72rem;cursor:pointer;">删除</button>';
                    html += '</div></div></div>';
                });
                if (!arr.length) html += '<div style="font-size:0.78rem;color:#94a3b8;padding:8px 0;">尚未配置任何模型，点击右上「＋ 新增模型」</div>';
                html += '</div>';
                // 编辑表单（默认隐藏）
                html += '<div id="ds-provider-edit" style="display:none;border:1px solid #e2e8f0;border-radius:8px;padding:12px;background:#f8fafc;">';
                html += '<div style="font-weight:600;margin-bottom:8px;" id="ds-provider-edit-title">编辑模型</div>';
                html += '<div style="display:flex;flex-direction:column;gap:10px;">';
                html += '<div><label style="font-weight:600;display:block;margin-bottom:4px;">名称（显示用）</label><input id="ds-pe-name" style="width:100%;padding:8px 10px;border:1px solid var(--border);border-radius:6px;font-size:0.88rem;" placeholder="如：DeepSeek V4"></div>';
                html += '<div><label style="font-weight:600;display:block;margin-bottom:4px;">API 地址</label><input id="ds-pe-url" list="api-url-list" onchange="if(window.dsAutoDetectModel)dsAutoDetectModel()" style="width:100%;padding:8px 10px;border:1px solid var(--border);border-radius:6px;font-size:0.88rem;" placeholder="https://api.deepseek.com/chat/completions"></div>';
                html += '<div><label style="font-weight:600;display:block;margin-bottom:4px;">模型名称</label><input id="ds-pe-model" list="api-model-list" style="width:100%;padding:8px 10px;border:1px solid var(--border);border-radius:6px;font-size:0.88rem;" placeholder="deepseek-v4-flash"></div>';
                html += '<div><label style="font-weight:600;display:block;margin-bottom:4px;">API Key</label><input id="ds-pe-key" type="password" style="width:100%;padding:8px 10px;border:1px solid var(--border);border-radius:6px;font-size:0.88rem;" placeholder="sk-..."></div>';
                // 联网搜索（Web Search）开关：经 DeepSeek Responses API 的 web_search 工具（视觉模型亦可用，会跟随当前模型）
                html += '<label style="display:flex;align-items:center;gap:8px;font-size:0.82rem;cursor:pointer;user-select:none;margin-top:4px;color:var(--text-secondary);"><input type="checkbox" id="ds-pe-websearch"' + (localStorage.getItem('ds_web_search') === '1' ? ' checked' : '') + '> 🌐 联网搜索 (Web Search) — 调用 DeepSeek 联网搜索（经 Responses API，跟随当前模型，视觉模型可用）</label>';
                // 【视觉模型快捷预设】一键填好名称/URL/模型名，免手敲（纯新增，不影响默认文本模型）
                html += '<div style="display:flex;gap:8px;margin-top:6px;flex-wrap:wrap;"><button type="button" class="ds-vision-btn" onclick="dsFillVisionModel()" style="padding:5px 10px;border:1px solid #c7d2fe;background:#eef2ff;color:#4338ca;border-radius:8px;font-size:0.78rem;cursor:pointer;">📷 快捷填入视觉模型</button><span style="font-size:0.72rem;color:#94a3b8;align-self:center;">填入 DeepSeek-V4-Flash-Vision-Exp（看图/识别照片）</span></div>';
                html += '</div>';
                html += '<div style="display:flex;gap:8px;margin-top:10px;justify-content:flex-end;"><button class="ds-cancel-btn" onclick="dsCancelEditProvider()" style="padding:6px 14px;border:1px solid #cbd5e1;border-radius:8px;background:#fff;color:#475569;font-size:0.82rem;cursor:pointer;">取消</button><button onclick="dsSaveProviderFromForm()" class="btn-primary-sm">保存模型</button></div>';
                html += '</div>';
                box.innerHTML = html;
                var sel = document.getElementById('ds-active-model-select');
                if (sel) sel.onchange = function(){ setActiveProvider(sel.value); renderModelManager(); };
            }
            function dsNewProvider() {
                var f = document.getElementById('ds-provider-edit');
                if (!f) return;
                f.style.display = 'block';
                document.getElementById('ds-pe-name').value = '';
                document.getElementById('ds-pe-url').value = DS_DEFAULT_API_URL;
                document.getElementById('ds-pe-model').value = DS_DEFAULT_MODEL;
                document.getElementById('ds-pe-key').value = '';
                document.getElementById('ds-provider-edit-title').textContent = '新增模型';
                f.dataset.pid = '';
            }
            // 【视觉模型快捷预设】一键填入 DeepSeek V4 Flash Vision Exp 配置（纯新增，不改动默认模型）
            window.dsFillVisionModel = function() {
                var f = document.getElementById('ds-provider-edit');
                if (!f) return;
                f.style.display = 'block';
                if (document.getElementById('ds-pe-name')) document.getElementById('ds-pe-name').value = 'DeepSeek 视觉模型';
                if (document.getElementById('ds-pe-url')) document.getElementById('ds-pe-url').value = 'https://api.deepseek.com/chat/completions';
                if (document.getElementById('ds-pe-model')) document.getElementById('ds-pe-model').value = 'deepseek-v4-flash-vision-exp';
                if (document.getElementById('ds-provider-edit-title')) document.getElementById('ds-provider-edit-title').textContent = '新增视觉模型';
                f.dataset.pid = '';
            };
            function dsEditProvider(id) {
                var arr = getProviders(), p = arr.filter(function(x){ return x.id === id; })[0];
                if (!p) return;
                var f = document.getElementById('ds-provider-edit');
                f.style.display = 'block';
                document.getElementById('ds-pe-name').value = p.name || '';
                document.getElementById('ds-pe-url').value = p.apiUrl || '';
                document.getElementById('ds-pe-model').value = p.model || '';
                document.getElementById('ds-pe-key').value = p.apiKey ? '****************' : '';
                document.getElementById('ds-provider-edit-title').textContent = '编辑模型：' + (p.name || p.model);
                f.dataset.pid = id;
            }
            function dsCancelEditProvider() {
                var f = document.getElementById('ds-provider-edit');
                if (f) { f.style.display = 'none'; f.dataset.pid = ''; }
            }
            function dsSaveProviderFromForm() {
                var f = document.getElementById('ds-provider-edit');
                var name = document.getElementById('ds-pe-name').value.trim();
                var url = document.getElementById('ds-pe-url').value.trim();
                var model = document.getElementById('ds-pe-model').value.trim();
                var key = document.getElementById('ds-pe-key').value.trim();
                if (!url) { alert('请输入 API 地址'); return; }
                if (!model) { alert('请输入模型名称'); return; }
                var pid = f ? f.dataset.pid : '';
                var existing = pid ? getProviders().filter(function(p){ return p.id === pid; })[0] : null;
                if (!key) {
                    if (existing && existing.apiKey) key = existing.apiKey;
                    else { alert('请输入 API Key'); return; }
                } else if (key === '****************') {
                    key = existing ? existing.apiKey : '';
                }
                if (!name) name = model;
                addOrUpdateProvider({ id: pid || undefined, name: name, apiUrl: url, model: model, apiKey: key });
                // 持久化联网搜索开关（全局行为，与具体模型配置无关）
                var _wsChk = document.getElementById('ds-pe-websearch');
                localStorage.setItem('ds_web_search', (_wsChk && _wsChk.checked) ? '1' : '0');
                // 同步输入栏地球按钮高亮（两处 UI 共用同一开关）
                try { if (typeof window.dsSyncWebSearchBtn === 'function') window.dsSyncWebSearchBtn(); } catch (e) {}
                if (f) { f.style.display = 'none'; f.dataset.pid = ''; }
                renderModelManager();
            }
            function dsSetActiveProvider(id) { setActiveProvider(id); }
            function dsDeleteProvider(id) {
                if (!confirm('确定删除该模型配置？')) return;
                deleteProvider(id);
            }

            function showApiConfigModal() {
                renderModelManager();
                document.getElementById('api-config-modal').style.display = 'block';
            }

            // API 地址变更时自动建议模型名称
            function _autoDetectModel() {
                var url = document.getElementById('modal-apiurl').value;
                var modelInput = document.getElementById('modal-model');
                // 只有用户清空了或还是默认值时才自动填写
                if (modelInput.value && modelInput.value !== DS_DEFAULT_MODEL && modelInput.value !== 'glm-4' && modelInput.value !== 'qwen-turbo' && modelInput.value !== 'gpt-3.5-turbo') return;
                var models = {
                    'bigmodel.cn': 'glm-4',
                    'aliyuncs.com': 'qwen-turbo',
                    'deepseek.com': 'deepseek-v4-flash',
                    'openai.com': 'gpt-3.5-turbo'
                };
                for (var domain in models) {
                    if (url.indexOf(domain) !== -1) {
                        modelInput.value = models[domain];
                        modelInput.style.borderColor = '#86efac';
                        setTimeout(function() { modelInput.style.borderColor = ''; }, 1500);
                        return;
                    }
                }
            }

            function saveApiConfigFromModal() {
                // 多模型模式下保存入口已改为 dsSaveProviderFromForm（模型管理弹窗内编辑表单）
                if (typeof dsSaveProviderFromForm === 'function') dsSaveProviderFromForm();
            }

            function clearApiConfig() {
                // 清除当前模型的 Key（其余配置保留）
                var ap = getActiveProvider();
                if (ap) { ap.apiKey = ''; addOrUpdateProvider(ap); }
                updateApiStatusBadge();
                alert('已清除当前模型的 API Key');
            }

            function resetDefaultApiConfig() {
                document.getElementById('api-config-modal').style.display = 'none';
            }

            function bindApiModalEvents() {
                var cfgBtn = document.getElementById('ds-api-config-btn');
                if (cfgBtn) cfgBtn.onclick = showApiConfigModal;
                var saveBtn = document.getElementById('modal-save-config');
                if (saveBtn) saveBtn.onclick = dsSaveProviderFromForm;
                var clearBtn = document.getElementById('modal-clear-key');
                if (clearBtn) clearBtn.onclick = clearApiConfig;
                var resetBtn = document.getElementById('modal-reset-default');
                if (resetBtn) resetBtn.onclick = resetDefaultApiConfig;
                var quickBtn = document.getElementById('quick-config-btn');
                if (quickBtn) quickBtn.onclick = showApiConfigModal;
            }
            bindApiModalEvents();

            // ---- 关联数据：与角色/模型/联网一致的下拉面板（点击展开、再次点击收起）----
            // 注意：_sessionDataSource 声明在 Part A IIFE 作用域，供 dsSendMsg（_dsRunStream）读取当前数据源
            var _sessionDataSource = (function(){
                try { var s = localStorage.getItem('ds_datasource_v1'); return s ? JSON.parse(s) : null; } catch(e){ return null; }
            })();
            (function initDataSourceDropdown() {
                var btn = document.getElementById('ds-reset-datasource-btn');
                var menu = document.getElementById('ds-datasource-menu');
                if (!btn || !menu) return;

                function getDsCfg() {
                    return {
                        rules: document.getElementById('ds-dialog-rules').checked,
                        issue: document.getElementById('ds-dialog-issue').checked,
                        handbook: document.getElementById('ds-dialog-handbook').checked,
                        wrAll: document.getElementById('ds-dialog-wr-all').checked,
                        phone: document.getElementById('ds-dialog-phone').checked,
                        diary: document.getElementById('ds-dialog-diary').checked,
                        remember: document.getElementById('ds-dialog-remember').checked
                    };
                }
                function syncAllBox() {
                    var all = document.getElementById('ds-dialog-all');
                    if (all) all.checked = ['rules','issue','handbook','wr-all','phone','diary'].every(function(k){
                        var el = document.getElementById('ds-dialog-' + k); return el && el.checked;
                    });
                }
                function loadDsCfg() {
                    var def = _sessionDataSource || { rules: true, issue: true, handbook: false, wrAll: false, phone: false, diary: false, remember: true };
                    ['rules','issue','handbook','wr-all','phone','diary','remember'].forEach(function(k){
                        var el = document.getElementById('ds-dialog-' + k); if (el) el.checked = def[k];
                    });
                    syncAllBox();
                }

                // 按钮：点击切换下拉（与角色/模型/联网一致）
                btn.addEventListener('click', function(e) {
                    e.stopPropagation();
                    var willOpen = !menu.classList.contains('open');
                    document.querySelectorAll('.ds-dropdown-menu.open').forEach(function(m){ if (m !== menu) m.classList.remove('open'); });
                    if (willOpen) loadDsCfg();
                    menu.classList.toggle('open', willOpen);
                });

                // 全选 / 单项同步
                var allBox = document.getElementById('ds-dialog-all');
                if (allBox) allBox.addEventListener('change', function(){
                    var v = allBox.checked;
                    ['rules','issue','handbook','wr-all','phone','diary'].forEach(function(k){
                        var el = document.getElementById('ds-dialog-' + k); if (el) el.checked = v;
                    });
                });
                ['rules','issue','handbook','wr-all','phone','diary'].forEach(function(k){
                    var el = document.getElementById('ds-dialog-' + k);
                    if (el) el.addEventListener('change', syncAllBox);
                });

                // 取消：仅收起
                var cancelBtn = menu.querySelector('.ds-ds-btn--cancel');
                if (cancelBtn) cancelBtn.addEventListener('click', function(e){ e.stopPropagation(); menu.classList.remove('open'); });

                // 确认使用：应用选择 + 有输入则发送
                var confirmBtn = menu.querySelector('.ds-ds-btn--confirm');
                if (confirmBtn) confirmBtn.addEventListener('click', function(e){
                    e.stopPropagation();
                    var cfg = getDsCfg();
                    if (cfg.remember) {
                        _sessionDataSource = cfg;
                        try { localStorage.setItem('ds_datasource_v1', JSON.stringify(cfg)); } catch(e){}
                    } else {
                        try { localStorage.removeItem('ds_datasource_v1'); } catch(e){}
                        _sessionDataSource = cfg;
                    }
                    window._tempDataSrc = cfg;
                    menu.classList.remove('open');
                    var inputEl = document.getElementById('ds-user-input');
                    if (inputEl && inputEl.value.trim() && typeof window.dsSendMsg === 'function') {
                        window.dsSendMsg();
                    }
                });
            })();

            // ---- dsUpdateCtxInfo 已删除（由弹窗替代） ----

            // ---- 构建系统提示词（含业务数据） ----
            async function dsBuildSystemPrompt(userQuery, dataSource) {
                if (!dataSource) dataSource = { rules: true, issue: true, handbook: false, wrAll: false, phone: false, diary: false };
                var useRules = dataSource.rules, useIssue = dataSource.issue, useHandbook = dataSource.handbook;
                var useWrAll = dataSource.wrAll, usePhone = dataSource.phone, useDiary = dataSource.diary;

                let sysParts = [
                    '你是一名铁路安全监察智能助手，专注于铁路安全规章、检查信息的查询与分析。',
                    '回答请使用中文，条理清晰，引用数据时注明来源（如"规章制度：XXX"、"检查信息：XXX"）。',
                    '若业务数据中未找到相关内容，如实告知，不得捏造。'
                ];

                // 关键词提取（复用专业词库增强版） + 专业推断
                const kws = smartExtractKeywords(userQuery, 5, false);
                const inferredTrade = window.patchInferTrade ? window.patchInferTrade(userQuery) : null;

                // 规章制度：专业优先 + 关键词评分 → top 5
                if (useRules && typeof window.getRulesData === 'function') {
                    let rules = window.getRulesData();
                    if (rules.length > 0) {
                        // 【性能优化】超过300条时采样，避免主线程卡死（每次发送都遍历全量300ms+）
                        if (rules.length > 300) {
                            var _sampledR = [], _stepR = Math.floor(rules.length / 300);
                            for (var _i = 0; _i < rules.length; _i += _stepR) _sampledR.push(rules[_i]);
                            rules = _sampledR;
                        }
                        const ruleKeywords = smartExtractKeywords(userQuery, 2, true);
                        let scored = rules.map(function(rule){
                            var text = ((rule.title||'') + ' ' + (rule.content||'')).toLowerCase();
                            var score = ruleKeywords.reduce(function(s,kw){ return s + (text.indexOf(kw.toLowerCase())!==-1 ? 1 : 0); }, 0);
                            if (inferredTrade && rule.trade === inferredTrade) score += 5;
                            return { rule: rule, score: score };
                        });
                        scored.sort(function(a,b){ return b.score - a.score; });
                        var topRules = scored.slice(0, 5).map(function(x){ return x.rule; });
                        var txt = '【规章制度数据（共' + rules.length + '条，仅展示最相关的5条）】\n';
                        if (inferredTrade) txt += '推断专业：' + inferredTrade + ' | 关键词：' + ruleKeywords.join('、') + '\n';
                        topRules.forEach(function(r, i){
                            var preview = (r.content || '').replace(/<[^>]+>/g, '').slice(0, 300);
                            txt += (i+1) + '. [' + (r.trade||'未分类') + '] ' + (r.title||'无标题') + '：' + preview + (preview.length >= 300 ? '...' : '') + '\n';
                        });
                        if (txt.length > DS_MAX_CTX_CHARS) txt = txt.slice(0, DS_MAX_CTX_CHARS);
                        sysParts.push(txt);
                    }
                }

                // 检查信息：关键词评分 + 近期加权 → top 5
                if (useIssue && typeof window.getIssueData === 'function') {
                    let issues = window.getIssueData();
                    if (issues.length > 0) {
                        // 【性能优化】超过300条时采样，避免主线程卡死
                        if (issues.length > 300) {
                            var _sampledI = [], _stepI = Math.floor(issues.length / 300);
                            for (var _j = 0; _j < issues.length; _j += _stepI) _sampledI.push(issues[_j]);
                            issues = _sampledI;
                        }
                        var issueKeywords = smartExtractKeywords(userQuery, 3, false);
                        var scoredIssues = issues.map(function(item){
                            var text = ((item.content||'') + ' ' + (item.category||'') + ' ' + (item['性质']||'')).toLowerCase();
                            var score = issueKeywords.reduce(function(s,kw){ return s + (text.indexOf(kw.toLowerCase())!==-1 ? 1 : 0); }, 0);
                            if (item.datetime) {
                                var daysDiff = (Date.now() - new Date(item.datetime)) / (1000*3600*24);
                                if (daysDiff < 30) score += 2;
                            }
                            return { item: item, score: score };
                        });
                        scoredIssues.sort(function(a,b){ return b.score - a.score; });
                        var topIssues = scoredIssues.slice(0, 5).map(function(x){ return x.item; });
                        var txt = '【检查信息数据（共' + issues.length + '条，仅展示最相关的5条）】\n';
                        topIssues.forEach(function(r, i){
                            txt += (i+1) + '. [' + (r['性质']||'') + '][' + (r.category||'') + '] ' + (r.datetime||'') + '：' + (r.content||'').slice(0, 200) + '\n';
                        });
                        if (txt.length > DS_MAX_CTX_CHARS) txt = txt.slice(0, DS_MAX_CTX_CHARS);
                        sysParts.push(txt);
                    }
                }

                // 检查手册：关键词评分 → top 5
                if (useHandbook && typeof window.getHandbookData === 'function') {
                    var hb = window.getHandbookData();
                    if (hb.length > 0) {
                        var topHb = rankAndSlice(hb, userQuery, function(r){ return (r.content||'') + ' ' + [r.chapter,r.section,r.item,r.subitem].filter(Boolean).join(' '); }, 5);
                        var txt = '【检查手册数据（共' + hb.length + '条，仅展示最相关的5条）】\n';
                        topHb.forEach(function(r, i){
                            var path = [r.chapter, r.section, r.item, r.subitem].filter(Boolean).join(' > ');
                            txt += (i+1) + '. [' + path + ']：' + (r.content||'').slice(0, 200) + '\n';
                        });
                        if (txt.length > DS_MAX_CTX_CHARS) txt = txt.slice(0, DS_MAX_CTX_CHARS);
                        sysParts.push(txt);
                    }
                }

                // 智能写作联动资料（保持原有逻辑，已是 top 5）
                if (useWrAll) {
                    if (typeof window._wrGetAllMaterials === 'function') {
                        try {
                            var mats = await window._wrGetAllMaterials();
                            if (mats && mats.length > 0) {
                                var relevant = mats;
                                if (kws.length > 0) {
                                    var scoredMats = mats.map(function(m){
                                        var text = ((m.title||'') + ' ' + String(m.content||'').slice(0,400)).toLowerCase();
                                        var score = kws.reduce(function(s,k){ return s + (text.indexOf(k.toLowerCase())!==-1 ? 1 : 0); }, 0);
                                        return { m: m, score: score };
                                    }).filter(function(x){ return x.score > 0; }).sort(function(a,b){ return b.score - a.score; });
                                    relevant = scoredMats.length > 0 ? scoredMats.map(function(x){ return x.m; }) : mats;
                                }
                                var wrSlice = relevant.slice(0, 5);
                                var txt = '【智能写作资料库（共' + mats.length + '份，本次关联' + wrSlice.length + '份）】\n';
                                wrSlice.forEach(function(m, i){
                                    txt += (i+1) + '. [' + (m.matType||'其它') + ']《' + (m.title||m.fileName) + '》：\n' + String(m.content||'').slice(0, 500) + (String(m.content||'').length > 500 ? '…' : '') + '\n';
                                });
                                if (txt.length > DS_MAX_CTX_CHARS) txt = txt.slice(0, DS_MAX_CTX_CHARS) + '\n（内容已截断）';
                                sysParts.push(txt);
                            }
                        } catch(e) { sysParts.push('【说明】写作资料加载失败。'); }
                    }
                    if (typeof window._wrGetAllReports === 'function') {
                        try {
                            var rpts = await window._wrGetAllReports();
                            if (rpts && rpts.length > 0) {
                                var rptSlice = rpts.sort(function(a,b){
                                var ta = a.date ? new Date(a.date).getTime() : 0;
                                var tb = b.date ? new Date(b.date).getTime() : 0;
                                if (isNaN(ta)) ta = 0;
                                if (isNaN(tb)) tb = 0;
                                return tb - ta;
                            }).slice(0, 3);
                                var txt = '【历史报告（最近' + rptSlice.length + '篇，共' + rpts.length + '篇）—仅供文风参考】\n';
                                rptSlice.forEach(function(r, i){
                                    var rDateStr = '';
                                    if (r.date) { var rd = new Date(r.date); if (!isNaN(rd.getTime())) rDateStr = rd.toLocaleDateString('zh-CN'); }
                                    txt += (i+1) + '. 《' + (r.title||'未命名') + '》' + (rDateStr ? '（' + rDateStr + '）' : '') + '：\n' + String(r.content||'').slice(0, 300) + '…\n';
                                });
                                if (txt.length > DS_MAX_CTX_CHARS) txt = txt.slice(0, DS_MAX_CTX_CHARS) + '\n（内容已截断）';
                                sysParts.push(txt);
                            }
                        } catch(e) { sysParts.push('【说明】历史报告加载失败。'); }
                    }
                    if (!sysParts.some(function(p){ return p.indexOf('智能写作资料库')!==-1 || p.indexOf('历史报告')!==-1; })) {
                        sysParts.push('【智能写作】暂无资料和历史报告。');
                    }
                }

                // 应急电话：关键词评分 → top 5
                if (usePhone && typeof window.getPhoneData === 'function') {
                    var phones = window.getPhoneData();
                    if (phones.length > 0) {
                        var topPhones = rankAndSlice(phones, userQuery, function(r){ return (r.单位||'')+' '+(r.站名||'')+' '+(r.线名||''); }, 5);
                        var txt = '【应急电话数据（共' + phones.length + '条，仅展示最相关的5条）】\n';
                        topPhones.forEach(function(r, i){
                            txt += (i+1) + '. ' + (r.单位||'') + ' - ' + (r.站名||'') + '（' + (r.线名||'') + '）：路电 ' + (r.路电||'无') + ' / 市电 ' + (r.市电||'无') + '\n';
                        });
                        if (txt.length > DS_MAX_CTX_CHARS) txt = txt.slice(0, DS_MAX_CTX_CHARS);
                        sysParts.push(txt);
                    }
                }

                // 工作日志：关键词评分 → top 5
                if (useDiary && typeof window.getDiaryData === 'function') {
                    var diaries = window.getDiaryData();
                    if (diaries.length > 0) {
                        var topDiaries = rankAndSlice(diaries, userQuery, function(r){ return (r.work||'')+' '+((r.issues||[]).join(' ')); }, 5);
                        var txt = '【工作日志数据（共' + diaries.length + '条，仅展示最相关的5条）】\n';
                        topDiaries.forEach(function(r, i){
                            var issues = (r.issues || []).filter(Boolean).join('；');
                            txt += (i+1) + '. [' + (r.date||'') + '] ' + (r.work||'无工作内容').slice(0, 50) + '：' + (issues||'无问题记录').slice(0, 100) + '\n';
                        });
                        if (txt.length > DS_MAX_CTX_CHARS) txt = txt.slice(0, DS_MAX_CTX_CHARS);
                        sysParts.push(txt);
                    }
                }

                return sysParts.join('\n\n');
            }

            // 简单关键词提取
            // 智能助手专用的关键词提取（可指定最大数量，复用专业词库）
            function smartExtractKeywords(text, maxKeywords, forRule) {
                maxKeywords = maxKeywords || 5;
                if (!text) return [];
                var candidates = [];
                if (typeof window.acExtractLibraryKeywords === 'function') {
                    candidates = window.acExtractLibraryKeywords(text);
                } else {
                    candidates = text.split(/[\s,，。！？；：""''、]+/).filter(function(w){ return w.length >= 2; });
                }
                return candidates.slice(0, maxKeywords);
            }

            // 公共评分排序函数：对数据项做关键词匹配 → 排序 → 取 topN
            function rankAndSlice(items, query, getTextFunc, topN) {
                topN = topN || 5;
                var keywords = smartExtractKeywords(query, 3, false);
                if (!keywords.length) return items.slice(0, topN);
                var scored = items.map(function(item){
                    var text = getTextFunc(item).toLowerCase();
                    var score = 0;
                    keywords.forEach(function(kw){ if (text.indexOf(kw.toLowerCase()) !== -1) score += 1; });
                    return { item: item, score: score };
                });
                scored.sort(function(a,b){ return b.score - a.score; });
                return scored.slice(0, topN).map(function(x){ return x.item; });
            }

            function extractKeywords(text) {
                return text.replace(/[，。？！、；：""''【】\s]/g, ' ')
                    .split(' ')
                    .map(s => s.trim())
                    .filter(s => s.length >= 2);
            }


            // ---- 发送消息 ----
            // 附件处理、文件读取、资料选择器 已移至 doubao-common.js

            window.dsSendMsg = async function() {
                if (dsStreaming) return;
                const input = document.getElementById('ds-user-input');
                let userText = input.value.trim();
                // P6 修复：仅发图（无文字但带附件）也应允许发送，不再被空输入拦截
                const hasAttachOnly = !userText && (window._dsAttachments || []).filter(Boolean).length > 0;
                if (!userText && !hasAttachOnly) return;
                // 仅发图且无文字时，给一个占位文本，便于后续路由/标题生成
                if (!userText && hasAttachOnly) userText = '（见附件）';

                const rawUserText = userText;

                // ════════════════════════════════════════════
                // 1. 强制命令路由（最高优先级）
                // ════════════════════════════════════════════
                if (rawUserText.startsWith('/check ')) {
                    const query = rawUserText.replace('/check ', '').trim();
                    if (!query) { alert('请输入对规内容'); return; }
                    dsSwitchSub('check');
                    const acInput = document.getElementById('autoCheck-input');
                    if (acInput) { acInput.value = query; setTimeout(function() { if (typeof window.autoCheckLocal === 'function') window.autoCheckLocal(); }, 200); }
                    input.value = ''; return;
                }
                if (rawUserText.startsWith('/write ')) {
                    const query = rawUserText.replace('/write ', '').trim();
                    if (!query) { alert('请输入写作需求'); return; }
                    dsSwitchSub('writer');
                    const wrInput = document.getElementById('wr-query-input');
                    if (wrInput) { wrInput.value = query; setTimeout(function() { if (typeof window.wrWrite === 'function') window.wrWrite(); }, 300); }
                    input.value = ''; return;
                }
                if (rawUserText.startsWith('/risk ')) {
                    const query = rawUserText.replace('/risk ', '').trim();
                    if (!query) { alert('请输入研判重点'); return; }
                    dsSwitchSub('risk');
                    const focusInput = document.getElementById('risk-focus');
                    if (focusInput) { focusInput.value = query; setTimeout(function() { if (typeof window.runRiskAnalysis === 'function') window.runRiskAnalysis(); }, 300); }
                    input.value = ''; return;
                }

                // ════════════════════════════════════════════
                // 2. 当前激活子模块锁定（次高优先级）
                // ════════════════════════════════════════════
                const currentSub = _dsCurrentSub || 'chat';
                if (currentSub === 'check') {
                    dsSwitchSub('check');
                    const acInput = document.getElementById('autoCheck-input');
                    if (acInput) { acInput.value = rawUserText; setTimeout(function() { if (typeof window.autoCheckLocal === 'function') window.autoCheckLocal(); }, 200); }
                    input.value = ''; return;
                }
                if (currentSub === 'writer') {
                    dsSwitchSub('writer');
                    const wrInput = document.getElementById('wr-query-input');
                    if (wrInput) { wrInput.value = rawUserText; setTimeout(function() { if (typeof window.wrWrite === 'function') window.wrWrite(); }, 300); }
                    input.value = ''; return;
                }
                if (currentSub === 'risk') {
                    dsSwitchSub('risk');
                    const focusInput = document.getElementById('risk-focus');
                    if (focusInput) { focusInput.value = rawUserText; setTimeout(function() { if (typeof window.runRiskAnalysis === 'function') window.runRiskAnalysis(); }, 300); }
                    input.value = ''; return;
                }

                // ════════════════════════════════════════════
                // 3. 自然语言意图识别（仅 chat 模式）
                // ════════════════════════════════════════════
                if (currentSub === 'chat') {
                    const lower = rawUserText.toLowerCase();
                    if (/对规|违反|违章|不符合|哪条规章|匹配条款/.test(lower)) {
                        dsSwitchSub('check');
                        const acInput = document.getElementById('autoCheck-input');
                        if (acInput) { acInput.value = rawUserText; setTimeout(function() { if (typeof window.autoCheckLocal === 'function') window.autoCheckLocal(); }, 200); }
                        input.value = ''; return;
                    }
                    if (/写报告|生成.*报告|起草|撰写|月度总结|整改通知书/.test(lower)) {
                        dsSwitchSub('writer');
                        const wrInput = document.getElementById('wr-query-input');
                        if (wrInput) { wrInput.value = rawUserText; setTimeout(function() { if (typeof window.wrWrite === 'function') window.wrWrite(); }, 300); }
                        input.value = ''; return;
                    }
                    if (/风险|趋势|研判|预警/.test(lower)) {
                        dsSwitchSub('risk');
                        const focusInput = document.getElementById('risk-focus');
                        if (focusInput) { focusInput.value = rawUserText; setTimeout(function() { if (typeof window.runRiskAnalysis === 'function') window.runRiskAnalysis(); }, 300); }
                        input.value = ''; return;
                    }
                }

                // ════════════════════════════════════════════
                // 4.2 附件处理
                // ════════════════════════════════════════════
                const validAttach = (window._dsAttachments || []).filter(Boolean);
                let finalText = userText;
                let attachNames = [];
                let visionUserContent = null; // 真实送审内容（含 image_url 块时非字符串）
                if (validAttach.length > 0) {
                    attachNames = validAttach.map(function(a) { return a.name; });
                    // 用统一助手构建：图片转 image_url 块，文本保持纯文本；无图则退化为纯文本 finalText
                    var _vm = (typeof window.buildVisionMessages === 'function')
                        ? window.buildVisionMessages(userText, validAttach)
                        : null;
                    // P5 守卫：仅当当前模型具备图像理解能力时才保留 image_url 块；
                    // 纯文本模型若直接送 image_url 会被 API 以 400 拒绝。此时退化为纯文本描述（图片元信息仍写入 finalText）。
                    var _visionOk = (typeof window.dsModelSupportsVision === 'function')
                        ? window.dsModelSupportsVision(dsModel || (localStorage.getItem('ds_model_v1') || ''))
                        : false;
                    if (_vm && typeof _vm.content !== 'string' && _visionOk) {
                        visionUserContent = _vm.content; // content 为数组（OpenAI 多模态格式）
                        // 历史/重渲染仍用纯文本（含图片元信息），保证渲染与重新生成兼容
                        finalText += '\n\n【附件内容】\n' + validAttach.map(function(a) {
                            return '--- 文件：' + a.name + ' ---\n' + (a.isImage ? (a.text || '[图片]') : a.text);
                        }).join('\n\n');
                    } else {
                        // 纯文本模型 / 无图：统一退化为纯文本（图片以文字说明形式附带）
                        finalText += '\n\n【附件内容】\n' + validAttach.map(function(a) {
                            return '--- 文件：' + a.name + ' ---\n' + (a.isImage ? (a.text || '[图片]') : a.text);
                        }).join('\n\n');
                        if (_vm && typeof _vm.content !== 'string' && !_visionOk) {
                            // 提示用户图片不会被识别（避免误以为已看图）
                            finalText += '\n\n（提示：当前模型为纯文本模型，图片无法被识别，仅作为附件说明提交。如需识别图片，请在设置中切换到 deepseek-v4-flash-vision-exp）';
                        }
                    }
                    window._dsAttachments = [];
                    document.getElementById('ds-attach-file') && (document.getElementById('ds-attach-file').value = '');
                }
                input.value = '';
                input.style.height = '';

                const displayText = attachNames.length > 0
                    ? userText + '\n📎 ' + attachNames.join('、')
                    : userText;

                // ════════════════════════════════════════════
                // 4.3 对话历史
                // ════════════════════════════════════════════
                if (!dsCurrentConvId) {
                    dsCurrentConvId = dsGenerateId();
                    dsHistory = [];
                    dsConversations.unshift({ id: dsCurrentConvId, title: '新对话', messages: [], timestamp: Date.now(), pinned: false });
                    localStorage.setItem(DS_CURRENT_CONV_ID, dsCurrentConvId);
                    dsRenderHistoryList();
                }
                dsHistory.push({ role: 'user', content: finalText, displayText: displayText, visionContent: visionUserContent || undefined });
                dsRenderAll();

                // 进入流式生成核心（重新生成复用）
                await window._dsRunStream(finalText, visionUserContent);
            };

            // 流式生成核心：普通对话与「重新生成」共用
            // visionUserContent：本次发送附带的真实多模态内容（image_url 数组），无图时为 undefined
            window._dsRunStream = async function(finalText, visionUserContent) {
                if (dsStreaming) return;
                // ---- 4.1 API Key ----
                const key = dsApiKey || await _getApiKey();
                if (!key || key === DS_PLACEHOLDER_KEY) {
                    dsAppendMsg('system', '⚠️ 请先配置 DeepSeek API Key（在上方输入框中输入并点击「保存」）。\n\n如需申请 API Key，请访问：https://platform.deepseek.com/');
                    return;
                }

                // ---- 4.4 角色注入 ----
                var roleSelect = document.getElementById('expertRole');
                var selectedRole = roleSelect ? roleSelect.value : 'default';
                var rolePrompt = '';
                if (window.ROLE_PROMPTS && window.ROLE_PROMPTS[selectedRole]) {
                    rolePrompt = window.ROLE_PROMPTS[selectedRole] + '\n\n';
                }

                // ---- 4.5 长期记忆 ----
                var memoryText = '';
                if (typeof extractFacts === 'function' && typeof addMemory === 'function' && typeof getRelevantMemories === 'function') {
                    try {
                        var newFacts = extractFacts(finalText);
                        newFacts.forEach(function(f) { addMemory(f); });
                        var memories = getRelevantMemories(finalText);
                        if (memories.length) {
                            memoryText = '【长期记忆】\n' + memories.map(function(m) { return '• ' + m.fact; }).join('\n') + '\n\n';
                        }
                    } catch(e) {}
                }

                // ---- 4.6 系统提示 ----
                var _tempSrc = window._tempDataSrc || null;
                var _dataSrc = _tempSrc || _sessionDataSource || { rules: true, issue: true, handbook: false, wrAll: false, phone: false, diary: false, remember: false };
                var hasAnySource = _dataSrc.rules || _dataSrc.issue || _dataSrc.handbook || _dataSrc.wrAll || _dataSrc.phone || _dataSrc.diary;
                var baseSystem = hasAnySource
                    ? await dsBuildSystemPrompt(finalText, _dataSrc)
                    : '你是一名铁路安全监察智能助手，回答请使用中文，条理清晰。';
                var systemPrompt = rolePrompt + memoryText + baseSystem;
                // 通用专业准则与知识更新指引：对所有角色/默认生效，强化专业深度、准确性与时效
                var proRoleGuidelines = '\n\n【专业回答准则】\n' +
                  '1. 知识分层：①铁路业务规章/检查信息/手册以本地数据库为权威源，必须优先检索并引用真实条款与案例；②涉及最新政策、标准修订、外部新闻、天气行情等时效信息，联网时直接引用检索结果并标注日期与来源；③本地未覆盖且未联网时，明确告知“需联网核实”，严禁臆造。\n' +
                  '2. 准确性：区分【已确认·基于本地数据】【推断】【待核实】；引用规章须注明名称与条款出处，禁止编造编号、数据或案例。\n' +
                  '3. 专业性：使用铁路行业规范术语；多专业问题从“人、机、环、管”与风险分级（高/中/低）视角结构化作答。';
                systemPrompt += proRoleGuidelines;
                // 注入当前日期：避免模型把「今天/本月/8月12日」当成年份不明而拒答
                try {
                    var _nowD = new Date();
                    var _wd = ['日','一','二','三','四','五','六'][_nowD.getDay()];
                    systemPrompt += '\n\n当前日期：' + _nowD.getFullYear() + '年' + (_nowD.getMonth() + 1) + '月' + _nowD.getDate() + '日（星期' + _wd + '）。'
                        + '用户提到「今天/昨天/本月/近期」等相对时间，以及未标注年份的日期（如「8月12日」），均按当前日期所在年份理解，不要反问年份。';
                } catch (e) {}
                // 全域统一升级：注入当前模块上下文（unified-enhancements.js 设置，未定义则无影响）
                if (window.UNIFIED_TAB_CONTEXT) systemPrompt += '\n\n' + window.UNIFIED_TAB_CONTEXT;
                if (_tempSrc) { window._tempDataSrc = null; }

                var messages = [
                    { role: 'system', content: systemPrompt },
                    ...dsHistory.slice(-10)
                ];
                // 多模态：若本次发送含图片块，将最后一条 user 消息的 content 替换为 image_url 数组
                if (visionUserContent && messages.length) {
                    for (var _mi = messages.length - 1; _mi >= 0; _mi--) {
                        if (messages[_mi].role === 'user') {
                            messages[_mi] = { role: 'user', content: visionUserContent };
                            break;
                        }
                    }
                }

                // ---- 4.7 流式对话 ----
                dsHistory.push({ role: 'assistant', content: '' });
                var assistantIdx = dsHistory.length - 1;
                dsRenderAll();
                dsScrollBottom();

                try {
                    // 生成中：发送按钮变「停止」（DeepSeek 同款：深色圆钮 + 方块停止图标）
                    // 置于 try 内 + 守卫，确保设置阶段任何异常都能被 finally 复位，避免 dsStreaming 永久为 true 冻结聊天
                    dsStreaming = true;
                    window.__dsStreaming = true;
                    var sendBtn = document.getElementById('ds-send-btn');
                    if (sendBtn) {
                        sendBtn.disabled = false;
                        sendBtn.classList.add('on', 'stopping');
                        sendBtn.title = '点击停止生成';
                        sendBtn.onclick = function() { if (window._dsAbortController) window._dsAbortController.abort(); };
                        sendBtn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2.4"/></svg>';
                    }
                    window._dsAbortController = new AbortController();
                    // P8 修复：整体请求超时（默认 120s），超时主动 abort 并提示，避免无限挂起
                    var _reqTimeoutMs = 120000;
                    var _reqTimer = setTimeout(function() {
                        if (window._dsAbortController) {
                            try { window._dsAbortController.abort(new DOMException('请求超时', 'TimeoutError')); } catch (e) {}
                        }
                    }, _reqTimeoutMs);
                    var isFrontendRole = selectedRole === 'frontend';
                    var isCodeRequest = /代码|html|css|js|javascript|网页|前端|组件|页面|布局|写一个|生成一个|帮我写/.test(finalText);
                    var maxTokens = (isFrontendRole || isCodeRequest) ? 8192 : 4096;
                    // 联网搜索开关：开启则走 DeepSeek Responses API（web_search 工具），否则维持原 chat/completions
                    // 天气等本地查询失败时由调用方置 window._dsForceWebSearch=true 强制联网（读取后立即清除，仅本次生效）
                    var forceWs = !!window._dsForceWebSearch;
                    window._dsForceWebSearch = false;
                    // 自动判定：开关未开时，若问题明显属于「外部实时信息」也自动联网，避免答"我无法联网"
                    // 业务域问题（检查信息/规章/日志等）一律不自动联网，保证仍走本地数据源
                    var autoWs = (function(_q) {
                        var q = String(_q || '');
                        // 时效性标准类问题：用户明确问最新/新修订/现行有效等，应自动联网核实最新内容
                        var freshness = /最新(版|标准|修订|办法|规定|规程|规则)|新(规|标准|办法|规程|修订)|修订(后|版|的)?|现行有效|已(废止|失效)|替代标准|政策(新|更新|出台)|近期(发布|施行)|202[4-9]年(新)?.*(规|标准|办法|规则|条例|规程|令)/;
                        var explicitWeb = /联网|上网|网上|搜一下|搜一搜|搜索一下|查一下网|最新消息|实时/;
                        var bizDomain = /检查信息|规章|条款|隐患|典型问题|安监|监察|工务|电务|供电|车务|机务|车辆|通信|房建|客运|货运|日志|写实|报告|手册|项点|台账|考勤|通讯录|资料库|模板|问题库/;
                        var realtime = /新闻|头条|时事|热点|大事|舆情|股价|股票|汇率|油价|金价|比特币|涨跌|发布会|上映|比分|比赛结果|夺冠|地震|台风|天气|气温/;
                        // 输入含 URL/链接：自动联网检索该网页内容（还原 备份后缺失的"含 URL 自动联网"能力）
                        var hasUrl = /https?:\/\/[^\s]+|www\.[^\s]+\.[a-z]{2,}|[a-z\u4e00-\u9fa5\u3000-\u9fff0-9-]+\.(com|cn|net|org|gov|edu|io|ai|co|info)([\/?#]\S*)?/i;
                        if (bizDomain.test(q)) return false;       // 业务域问题一律走本地数据源，不自动联网
                        if (hasUrl.test(q)) return true;            // 含链接/网址：自动联网读取网页内容
                        if (freshness.test(q)) return true;
                        if (explicitWeb.test(q)) return true;
                        return realtime.test(q);
                    })(finalText);
                    var useWebSearch = (localStorage.getItem('ds_web_search') === '1') || forceWs || autoWs;
                    // 告知模型自身联网状态：联网时禁止自称"无法联网"；未联网时引导用户开启，而不是空口拒答
                    if (useWebSearch) {
                        systemPrompt += '\n\n【联网搜索已启用】你本次具备实时联网检索能力，可获取最新的新闻、行情、天气等外部信息。'
                            + '请直接基于检索到的最新事实作答，并标注信息对应的日期；严禁声称"我没有实时联网能力""无法获取当日新闻"。';
                    } else {
                        try {
                            if (messages[0] && messages[0].role === 'system') {
                                messages[0].content += '\n\n【提示】本次未启用联网搜索。若用户询问需要实时联网才能回答的信息，请简要说明并告知：点击输入框左下方的 🌐 地球按钮即可开启联网搜索，然后重新提问。';
                            }
                        } catch (e) {}
                    }
                    // 告知模型自身视觉能力状态：避免模型在被问「能否识别图片」时凭通用认知谎称不能
                    try {
                        if (messages[0] && messages[0].role === 'system') {
                            if (window.dsModelSupportsVision && window.dsModelSupportsVision(dsModel)) {
                                messages[0].content += '\n\n【图像理解已启用】你当前使用的模型具备图像理解（多模态）能力，用户通过「上传附件」传入的图片你可以直接查看、识别并分析。'
                                    + '当用户上传图片（如现场设备照片、仪表读数、隐患照片、图纸等）并提问时，请基于图片内容作答；严禁声称"我无法识别图像""看不了图片"。';
                            } else {
                                messages[0].content += '\n\n【图像理解未启用】你当前使用的模型为纯文本模型，不具备图像识别能力。若用户上传图片或询问能否识别图片，请如实说明当前模型无法看图，并引导：在「设置 → API 配置 → ＋新增模型」中将模型切换为 deepseek-v4-flash-vision-exp（视觉实验模型）后即可看图。';
                            }
                        }
                    } catch (e) {}
                    // DeepSeek V4 能力开关：思考模式 / JSON 输出（仅对 DeepSeek V4 模型生效，其余供应商忽略以免报错）
                    var _isV4 = /deepseek/i.test(dsModel) || /api\.deepseek\.com/i.test(dsApiUrl);
                    var thinkingOn = _isV4 && localStorage.getItem('ds_thinking') !== '0';
                    var jsonOn = localStorage.getItem('ds_json_mode') === '1';
                    // P2 对话前缀续写（Beta，默认关）：锁死助手开场白（本系统固定 OpenAI 风格，故恒可用）
                    var _prefixOn = localStorage.getItem('ds_prefix') === '1';
                    // P1 Tool Calls：仅 DeepSeek V4 模型 + 开关开启 + 工具 schema/执行器均可用时生效；与 JSON 模式互斥（避免 tools 与 response_format 冲突）
                    // D1：增加 _agentToolsParam/_agentExecuteTool 可用性守卫——agent-core 未加载时降级为普通对话，避免向 API 发送 tools:null 导致 400 或工具静默失效
                    var _toolsReady = (typeof window._agentToolsParam === 'function') && (typeof window._agentExecuteTool === 'function');
                    var _useTools = _isV4 && localStorage.getItem('ds_tool_calls') === '1' && !jsonOn && _toolsReady;
                    // 前缀续写开启：强制关闭思考（Beta 仅非思考）+ 工具 + JSON，避免组合复杂化
                    if (_prefixOn) { thinkingOn = false; _useTools = false; jsonOn = false; }
                    var _toolsParamArr = (_useTools && typeof window._agentToolsParam === 'function') ? window._agentToolsParam() : null;
                    var _toolExec = (typeof window._agentExecuteTool === 'function') ? window._agentExecuteTool : null;
                    // 思考模式会消耗推理 token，适当抬高 max_tokens 避免回答被截断
                    if (thinkingOn) maxTokens = (isFrontendRole || isCodeRequest) ? 24576 : 16384;

                    var responsesUrl = (dsApiUrl || '').replace(/\/chat\/completions\/?$/i, '/responses') || 'https://api.deepseek.com/responses';
                    var inputItems = dsHistory.slice(-10)
                        .map(function(m) { return { role: m.role, content: (m.content || '') }; })
                        .filter(function(m) { return !!m.content || m.role === 'system'; });
                    // 联网搜索同样支持多模态：最后一条 user 若有图片块则替换为 image_url 数组
                    if (visionUserContent && inputItems.length) {
                        for (var _ii = inputItems.length - 1; _ii >= 0; _ii--) {
                            if (inputItems[_ii].role === 'user') {
                                inputItems[_ii] = { role: 'user', content: visionUserContent };
                                break;
                            }
                        }
                    }
                    var resp;
                    if (useWebSearch) {
                        resp = await fetch(responsesUrl, {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + key },
                            body: JSON.stringify({
                                model: dsModel,
                                instructions: systemPrompt,
                                input: inputItems,
                                tools: [{ type: 'web_search' }],
                                reasoning: { effort: thinkingOn ? 'high' : 'none' },
                                stream: true,
                                temperature: 0.7,
                                max_output_tokens: maxTokens
                            }),
                            signal: window._dsAbortController.signal
                        });
                    } else {
                    // JSON 输出模式：在系统提示后追加「必须输出合法 JSON」约束（仅未启用工具调用时，避免与 tools 冲突）
                    if (jsonOn && !_useTools && messages[0] && messages[0].role === 'system') {
                        messages[0].content += '\n\n【输出格式】你必须且只能输出合法的 JSON 对象（不要使用 markdown 代码块、不要附加任何解释文字）。';
                    }
                    // P2 对话前缀续写：末尾追加 assistant 前缀（prefix:true），并预填气泡以完整展示
                    if (_prefixOn) {
                        var _prefixText = '根据铁路安全监察相关规定，';
                        messages.push({ role: 'assistant', content: _prefixText, prefix: true });
                        dsHistory[assistantIdx].content = _prefixText;
                    }
                    // DeepSeek V4 思考模式 + JSON 模式参数
                    var _chatBody = { model: dsModel, messages: messages, stream: true, temperature: 0.7, max_tokens: maxTokens };
                    if (thinkingOn) { _chatBody.thinking = { type: 'enabled' }; _chatBody.reasoning_effort = 'high'; }
                    else { _chatBody.thinking = { type: 'disabled' }; }
                    if (_useTools) { _chatBody.tools = _toolsParamArr; }   // P1 Tool Calls：注入本地工具 schema
                    else if (jsonOn) { _chatBody.response_format = { type: 'json_object' }; }
                    resp = await fetch(dsApiUrl, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + key },
                        body: JSON.stringify(_chatBody),
                        signal: window._dsAbortController.signal
                    });
                    }

                    if (!resp.ok) {
                        var errText = await resp.text();
                        var errMsg = '请求失败（HTTP ' + resp.status + '）';
                        var statusHints = {
                            401: '⚠️ API Key 无效或未填写，请确认已填入正确的 Key',
                            402: '⚠️ 账户余额不足，请前往对应平台充值后重试',
                            403: '⚠️ API Key 无访问权限，请检查 Key 是否正确',
                            404: '⚠️ 模型名称不存在或 API 地址错误，请检查模型名称是否与平台匹配',
                            429: '⚠️ 请求过于频繁，请稍后再试',
                            500: '⚠️ 服务端异常，请稍后重试',
                        };
                        if (statusHints[resp.status]) {
                            errMsg = statusHints[resp.status];
                        } else {
                            try { var errJson = JSON.parse(errText); errMsg += '：' + (errJson.error?.message || errText.slice(0, 200)); }
                            catch(e) { errMsg += '：' + errText.slice(0, 200); }
                        }
                        dsHistory[assistantIdx].content = '❌ ' + errMsg;
                        dsRenderAll();
                        return;
                    }

                    if (useWebSearch) {
                        // ── Responses API 语义化 SSE 流式（web_search 黑盒注入，客户端拿不到完整 URL 列表）──
                        var reader = resp.body.getReader();
                        var decoder = new TextDecoder();
                        var buffer = '';
                        var _renderTick = 0;
                        var _wsText = '';
                        var _wsSearching = false;
                        while (true) {
                            var resp2 = await reader.read();
                            if (resp2.done) break;
                            buffer += decoder.decode(resp2.value, { stream: true });
                            var segs = buffer.split('\n\n');
                            buffer = segs.pop() || '';
                            for (var _si = 0; _si < segs.length; _si++) {
                                var _segLines = segs[_si].split('\n');
                                var _dataLine = null;
                                for (var _li = 0; _li < _segLines.length; _li++) { if (_segLines[_li].indexOf('data:') === 0) { _dataLine = _segLines[_li]; break; } }
                                if (!_dataLine) continue;
                                var _payload = _dataLine.slice(5).trim();
                                if (!_payload) continue;
                                var _j; try { _j = JSON.parse(_payload); } catch(e) { continue; }
                                var _t = _j.type;
                                if (_t === 'response.output_text.delta') { _wsText += (_j.delta || ''); }
                                else if (_t === 'response.web_search_call.in_progress' || _t === 'response.web_search_call.searching') { _wsSearching = true; }
                                else if (_t === 'response.failed') { var _em = (_j.error && (_j.error.message || _j.error.code)) || '联网搜索失败'; dsHistory[assistantIdx].content = '❌ ' + _em; dsRenderAll(); return; }
                            }
                            _renderTick++;
                            if (_renderTick % 3 === 0) {
                                var _chatBox = document.getElementById('ds-chat-box');
                                var _bubbles = _chatBox.querySelectorAll('.ds-bubble-assistant');
                                var _lastBubble = _bubbles[_bubbles.length - 1];
                                var _shown = (_wsSearching && !_wsText) ? '🌐 正在联网搜索…' : (_wsText ? dsMarkdown(_wsText) : '');
                                if (_lastBubble) _lastBubble.innerHTML = _shown + '<span class="ds-cursor">▌</span>';
                                dsScrollBottom();
                            }
                        }
                        dsHistory[assistantIdx].content = _wsText;
                    } else {
                        // ── chat/completions 流式（支持 P1 Tool Calls 多轮 + P2 前缀续写）──
                        var _pendingToolCalls = [];
                        await _dsStreamChat(resp, assistantIdx, _pendingToolCalls);
                        // 若模型请求调用工具：本地执行后回灌结果，再请求一轮让其总结（最多 4 轮，避免无限循环）
                        var _tcRound = 1;
                        var _maxTcRounds = 4;
                        while (_useTools && _toolExec && _pendingToolCalls.length && _tcRound < _maxTcRounds) {
                            _tcRound++;
                            _pendingToolCalls = _pendingToolCalls.filter(Boolean);
                            // D2：回灌前规范化 arguments——模型未生成参数时为空串，必须补为 '{}' 合法 JSON，否则 API 报 400
                            _pendingToolCalls.forEach(function(_c) {
                                if (!_c.function) _c.function = { name: '', arguments: '{}' };
                                if (typeof _c.function.arguments !== 'string' || _c.function.arguments.trim() === '') _c.function.arguments = '{}';
                            });
                            messages.push({ role: 'assistant', content: null, tool_calls: _pendingToolCalls });
                            for (var _k = 0; _k < _pendingToolCalls.length; _k++) {
                                var _call = _pendingToolCalls[_k];
                                var _args = {};
                                try { _args = _call.function.arguments ? JSON.parse(_call.function.arguments) : {}; } catch (e) { _args = {}; }
                                dsHistory[assistantIdx].content = '🔧 正在调用工具：' + _call.function.name + ' …';
                                (function() { var _cb = document.getElementById('ds-chat-box'); if (_cb) { var _bs = _cb.querySelectorAll('.ds-bubble-assistant'); var _lb = _bs[_bs.length - 1]; if (_lb) _lb.innerHTML = dsBubbleInner(assistantIdx) + '<span class="ds-cursor">▌</span>'; dsScrollBottom(); } })();
                                var _exec = await _toolExec(_call.function.name, _args);
                                // D3：工具结果可视化——在气泡中追加简短摘要（✅ 共N条 / ❌ 错误），提升调用过程可观测性，与智能体透明卡片对齐
                                var _summary = '';
                                if (_exec && _exec.ok) {
                                    if (_exec.result && typeof _exec.result.total === 'number') _summary = '✅ ' + _call.function.name + '：共 ' + _exec.result.total + ' 条';
                                    else _summary = '✅ ' + _call.function.name + '：执行成功';
                                } else {
                                    _summary = '❌ ' + _call.function.name + '：' + ((_exec && _exec.error) || '执行失败');
                                }
                                dsHistory[assistantIdx].content = '🔧 ' + _summary;
                                (function() { var _cb = document.getElementById('ds-chat-box'); if (_cb) { var _bs = _cb.querySelectorAll('.ds-bubble-assistant'); var _lb = _bs[_bs.length - 1]; if (_lb) _lb.innerHTML = dsBubbleInner(assistantIdx) + '<span class="ds-cursor">▌</span>'; dsScrollBottom(); } })();
                                var _tcContent = JSON.stringify(_exec && _exec.result !== undefined ? _exec.result : _exec, null, 2);
                                messages.push({ role: 'tool', tool_call_id: _call.id, content: _tcContent });
                            }
                            // 清空气泡，准备下一轮最终回答
                            dsHistory[assistantIdx].content = '';
                            dsHistory[assistantIdx].reasoning = '';
                            (function() { var _cb = document.getElementById('ds-chat-box'); if (_cb) { var _bs = _cb.querySelectorAll('.ds-bubble-assistant'); var _lb = _bs[_bs.length - 1]; if (_lb) _lb.innerHTML = dsBubbleInner(assistantIdx) + '<span class="ds-cursor">▌</span>'; dsScrollBottom(); } })();
                            // 后续轮次：回灌工具结果（仍带 tools，允许模型继续调用或总结）
                            var _bodyN = { model: dsModel, messages: messages, stream: true, temperature: 0.7, max_tokens: maxTokens };
                            if (thinkingOn) { _bodyN.thinking = { type: 'enabled' }; _bodyN.reasoning_effort = 'high'; } else { _bodyN.thinking = { type: 'disabled' }; }
                            if (_useTools) { _bodyN.tools = _toolsParamArr; }
                            var _respN = await fetch(dsApiUrl, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + key }, body: JSON.stringify(_bodyN), signal: window._dsAbortController.signal });
                            if (!_respN.ok) { var _et = await _respN.text(); dsHistory[assistantIdx].content = '❌ 工具结果回灌后请求失败（HTTP ' + _respN.status + '）：' + _et.slice(0, 200); dsRenderAll(); return; }
                            _pendingToolCalls = [];
                            await _dsStreamChat(_respN, assistantIdx, _pendingToolCalls);
                        }
                    }

                    var _finalChatBox = document.getElementById('ds-chat-box');
                    var _finalBubbles = _finalChatBox.querySelectorAll('.ds-bubble-assistant');
                    var _finalBubble = _finalBubbles[_finalBubbles.length - 1];
                    if (_finalBubble) _finalBubble.innerHTML = dsBubbleInner(assistantIdx);
                    dsSaveHistory();
                    dsRenderHistoryList();
                    // 统一重渲染，确保每条 AI 回复下方都带上操作按钮（复制/下载/有用/无用/重生成/朗读）
                    dsRenderAll();

                    // ---- 主动建议 ----
                    var aiContent = dsHistory[assistantIdx].content;
                    var suggestions = [];
                    if (/违章|违反|不符合|对规/.test(aiContent)) suggestions.push('📝 生成整改通知书');
                    if (/风险|趋势|研判|预警/.test(aiContent)) suggestions.push('📊 生成风险研判报告');
                    if (/检查|问题|隐患/.test(aiContent)) suggestions.push('📋 查询相关规章');
                    if (suggestions.length > 0 && _finalChatBox) {
                        var lastMsgDiv = _finalChatBox.querySelector('.ds-row-assistant:last-of-type');
                        if (lastMsgDiv) {
                            var suggestDiv = document.createElement('div');
                            suggestDiv.className = 'ds-suggest-row';
                            suggestDiv.style.cssText = 'display:flex; gap:8px; margin-top:10px; flex-wrap:wrap;';
                            suggestions.forEach(function(text) {
                                var btn = document.createElement('button');
                                btn.textContent = text;
                                btn.className = 'btn btn-secondary btn-small ds-suggestion';
                                btn.onclick = function() {
                                    var ib = document.getElementById('ds-user-input');
                                    if (ib) ib.value = text.replace(/^[^\s]+\s/, '');
                                    setTimeout(function() { dsSendMsg(); }, 100);
                                };
                                suggestDiv.appendChild(btn);
                            });
                            lastMsgDiv.appendChild(suggestDiv);
                        }
                    }

                } catch(err) {
                    if (err.name === 'TimeoutError') {
                        // P8：请求超时（非用户主动停止）
                        dsHistory[assistantIdx].content = '❌ 请求超时（' + (_reqTimeoutMs / 1000) + 's）：模型响应时间过长，请稍后重试，或检查网络/API 状态。';
                        var _tBox = document.getElementById('ds-chat-box');
                        if (_tBox) { var _lb = _tBox.querySelector('.ds-bubble-assistant:last-of-type'); if (_lb) _lb.innerHTML = dsBubbleInner(assistantIdx); }
                        dsRenderAll();
                    } else if (err.name === 'AbortError') {
                        var chatBox2 = document.getElementById('ds-chat-box');
                        if (chatBox2) {
                            var cursors2 = chatBox2.querySelectorAll('.ds-cursor');
                            cursors2.forEach(function(c) { c.remove(); });
                            // 统一重渲染，恢复操作按钮
                            dsRenderAll();
                            setTimeout(function(){
                                var lastBubble2 = chatBox2.querySelector('.ds-bubble-assistant:last-of-type');
                                if (lastBubble2 && !lastBubble2.querySelector('.feedback-good') && typeof window._addFeedbackButtons === 'function') {
                                    window._addFeedbackButtons(lastBubble2, lastBubble2.innerText);
                                }
                            }, 50);
                        }
                    } else {
                        if (err.message && (err.message.indexOf('Failed to fetch') !== -1)) {
                            dsHistory[assistantIdx].content = '❌ 网络错误：CORS 跨域限制\n\n当前 API（' + dsApiUrl.split('/api/')[0] + '）不允许浏览器直接访问。\n\n解决方案：\n1. 切换使用 DeepSeek API（推荐，支持浏览器调用）\n2. 或等待后续版本支持 CORS 代理';
                        } else {
                            dsHistory[assistantIdx].content = '❌ 网络错误：' + err.message + '\n请检查网络连接或 API Key 是否正确。';
                        }
                        dsRenderAll();
                    }
                } finally {
                    if (_reqTimer) { clearTimeout(_reqTimer); _reqTimer = null; }
                    window._dsAbortController = null;
                    dsStreaming = false;
                    window.__dsStreaming = false;
                    var sendBtn2 = document.getElementById('ds-send-btn');
                    if (sendBtn2) {
                        sendBtn2.disabled = false;
                        sendBtn2.classList.remove('stopping');
                        sendBtn2.style.opacity = '';
                        sendBtn2.style.background = '';
                        sendBtn2.title = '发送';
                        sendBtn2.onclick = function() { dsSendMsg(); };
                        sendBtn2.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" style="display:block;"><path d="M12 19V6"/><path d="M6 12l6-6 6 6"/></svg>';
                        // 输入已被清空 → 恢复置灰态（DeepSeek 行为）
                        if (typeof window.dsSyncSendState === 'function') window.dsSyncSendState();
                    }
                }
            };

            // 暴露统一的「发送消息到 DeepSeek」入口（供统一增强模块/外部智能体调用）
            window.sendToDeepSeek = window._dsRunStream;

            // 重新生成：移除末尾助手消息，复用最后一条用户问题重发
            window.dsRegenerate = function() {
                if (dsStreaming) return;
                if (!dsHistory.length) return;
                while (dsHistory.length && dsHistory[dsHistory.length - 1].role === 'assistant') {
                    dsHistory.pop();
                }
                const lastUser = dsHistory[dsHistory.length - 1];
                if (!lastUser || lastUser.role !== 'user') return;
                window._dsRunStream(lastUser.content, lastUser.visionContent);
            };

            window.dsQuick = function(text) {
                document.getElementById('ds-user-input').value = text;
                dsSendMsg();
            };

            // ---- 清空对话（兼容旧调用，实际调用新选项） ----
            window.dsClearChat = function() {
                dsShowClearOptions();
            };

            // ---- 渲染所有消息 ----
            function dsRenderAll() {
                const box = document.getElementById('ds-chat-box');
                if (!box) return;
                if (dsHistory.length === 0) {
                    // 空对话时显示欢迎引导页
                    box.style.display = 'flex';
                    box.innerHTML = '<div class="ds-welcome">' +
                        '<div class="ds-welcome-logo">' +
                            '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" width="26" height="26">' +
                                '<path d="M12 2 4 5.5v6c0 4.6 3.2 8.9 8 10.5 4.8-1.6 8-5.9 8-10.5v-6L12 2Z"/>' +
                                '<path d="m9 12 2 2 4-4"/>' +
                            '</svg>' +
                        '</div>' +
                        '<h3 class="ds-welcome-title">我是安监助手，很高兴见到你！</h3>' +
                        '<p class="ds-welcome-sub">可以帮你查规章、析隐患、写文书，也能聊任何话题～</p>' +
                        '</div>';
                    return;
                }
                // 有内容时显示对话区
                box.style.display = 'flex';
                let html = '';
                dsHistory.forEach((msg, i) => {
                    if (msg.role === 'user') {
                        const showText = msg.displayText || msg.content;
                        html += '<div class="ds-row-user"><div class="ds-bubble-user">' + dsEsc(showText) + '</div></div>';
                    } else if (msg.role === 'assistant') {
                        if (!msg.content) {
                            html += '<div class="ds-row-assistant"><div class="ds-bubble-assistant"><span class="ds-typing">思考中<span class="ds-dot">.</span><span class="ds-dot">.</span><span class="ds-dot">.</span></span></div></div>';
                        } else {
                            html += '<div class="ds-row-assistant"><div class="ds-bubble-assistant" data-ds-idx="' + i + '">' + dsBubbleInner(i) + '</div></div>';
                        }
                    } else {
                        html += '<div class="ds-row-system"><div class="ds-bubble-system">' + dsEsc(msg.content) + '</div></div>';
                    }
                });
                box.innerHTML = html;
                // 给每个 AI 回复气泡追加操作按钮（复制/下载/有用/无用/重生成/朗读），
                // 使按钮成为消息渲染的固有部分，任何 dsRenderAll 重渲染后都稳定保留。
                if (typeof window._addFeedbackButtons === 'function') {
                    box.querySelectorAll('.ds-bubble-assistant').forEach(function(bubble){
                        if (bubble.querySelector('.ds-typing')) return; // 跳过"思考中"占位气泡
                        var _idx = parseInt(bubble.getAttribute('data-ds-idx'), 10);
                        var _content = (dsHistory[_idx] && dsHistory[_idx].content) ? dsHistory[_idx].content : bubble.innerText;
                        window._addFeedbackButtons(bubble, _content);
                    });
                }
                dsScrollBottom();
            }

            // 系统消息（非历史，仅显示）
            function dsAppendMsg(role, content) {
                const box = document.getElementById('ds-chat-box');
                if (!box) return;
                const div = document.createElement('div');
                div.className = 'ds-row-system';
                div.innerHTML = '<div class="ds-bubble-system">' + dsEsc(content) + '</div>';
                box.appendChild(div);
                dsScrollBottom();
            }

            function dsScrollBottom() {
                const box = document.getElementById('ds-chat-box');
                if (box) box.scrollTop = box.scrollHeight;
            }

            // ---- 代码块下载 ----
            window.dsDownloadCode = function(btn) {
                var pre = btn.parentElement.querySelector('pre');
                if (!pre) return;
                var code = pre.textContent;
                var ext = btn.getAttribute('data-ext') || 'txt';
                var mimeMap = { html:'text/html', css:'text/css', js:'application/javascript', json:'application/json', xml:'application/xml', svg:'image/svg+xml' };
                var mime = mimeMap[ext] || 'text/plain';
                var blob = new Blob([code], {type: mime + ';charset=utf-8'});
                window.downloadBlob(blob, 'code.' + ext);
            };

            // ---- 气泡内容组装（含思考过程折叠块） ----
            // ---- P1 Tool Calls：通用 chat/completions 流式解析 ----
            // 将 resp 流式写入 dsHistory[idx]，并把增量 tool_calls 累积进 toolCallsOut（按 index 存放，调用方需 filter(Boolean)）
            async function _dsStreamChat(resp, idx, toolCallsOut) {
                var reader = resp.body.getReader();
                var decoder = new TextDecoder();
                var buffer = '';
                var _renderTick = 0;
                while (true) {
                    var _chunk = await reader.read();
                    if (_chunk.done) break;
                    buffer += decoder.decode(_chunk.value, { stream: true });
                    var _lines = buffer.split('\n');
                    buffer = _lines.pop() || '';
                    for (var _li = 0; _li < _lines.length; _li++) {
                        var _trimmed = _lines[_li].trim();
                        if (!_trimmed || _trimmed === 'data: [DONE]') continue;
                        if (_trimmed.indexOf('data: ') === 0) {
                            try {
                                var _json = JSON.parse(_trimmed.slice(6));
                                var _delta = _json.choices?.[0]?.delta?.content || '';
                                var _rc = _json.choices?.[0]?.delta?.reasoning_content || '';
                                if (_rc) { dsHistory[idx].reasoning = (dsHistory[idx].reasoning || '') + _rc; }
                                // 累积 tool_calls（delta 中以 index 碎片化下发）
                                var _dtc = _json.choices?.[0]?.delta?.tool_calls;
                                if (Array.isArray(_dtc)) {
                                    for (var _ti = 0; _ti < _dtc.length; _ti++) {
                                        var _tc = _dtc[_ti];
                                        var _ix = (_tc.index !== undefined) ? _tc.index : 0;
                                        if (!toolCallsOut[_ix]) toolCallsOut[_ix] = { id: '', type: 'function', function: { name: '', arguments: '' } };
                                        if (_tc.id) toolCallsOut[_ix].id = _tc.id;
                                        if (_tc.type) toolCallsOut[_ix].type = _tc.type;
                                        if (_tc.function) {
                                            if (_tc.function.name) toolCallsOut[_ix].function.name += _tc.function.name;
                                            if (_tc.function.arguments) toolCallsOut[_ix].function.arguments += _tc.function.arguments;
                                            if (_tc.function.type) toolCallsOut[_ix].type = _tc.function.type;
                                        }
                                    }
                                }
                                if (_delta) {
                                    dsHistory[idx].content += _delta;
                                    _renderTick++;
                                    if (_renderTick % 3 === 0) {
                                        var _cb = document.getElementById('ds-chat-box');
                                        if (_cb) {
                                            var _bs = _cb.querySelectorAll('.ds-bubble-assistant');
                                            var _lb = _bs[_bs.length - 1];
                                            if (_lb) _lb.innerHTML = dsBubbleInner(idx) + '<span class="ds-cursor">▌</span>';
                                            dsScrollBottom();
                                        }
                                    }
                                }
                            } catch (e) {}
                        }
                    }
                }
            }

            // ---- P2 FIM 中间补全（Beta，独立入口，仅非思考） ----
            window.dsOpenFim = function() {
                // 守卫：视觉/非 DeepSeek 等不支持 FIM 的模型禁止打开（避免 404/报错）
                var _cur = dsModel || (localStorage.getItem('ds_model_v1') || DS_DEFAULT_MODEL);
                if (typeof window.dsModelSupportsFim === 'function' && !window.dsModelSupportsFim(_cur)) {
                    alert('当前模型「' + _cur + '」不支持 FIM 中间补全（视觉/实验模型等）。\n请切换到 DeepSeek 文本模型（如 deepseek-v4-flash）后再使用此功能。');
                    return;
                }
                var m = document.getElementById('ds-fim-modal'); if (m) m.style.display = 'flex';
            };
            window.dsCloseFim = function() { var m = document.getElementById('ds-fim-modal'); if (m) m.style.display = 'none'; };
            window.dsRunFim = async function() {
                var _p = document.getElementById('ds-fim-prefix');
                var _s = document.getElementById('ds-fim-suffix');
                var _mo = document.getElementById('ds-fim-model');
                var _mt = document.getElementById('ds-fim-maxtok');
                var _r = document.getElementById('ds-fim-result');
                if (!_r) return;
                var _key = dsApiKey || (typeof _getApiKey === 'function' ? await _getApiKey() : '');
                if (!_key) { _r.innerHTML = '⚠️ 请先在「设置 → API 配置」中填写 Key'; return; }
                var _prompt = _p ? _p.value : '';
                var _suffix = _s ? _s.value : '';
                if (!_prompt.trim() && !_suffix.trim()) { _r.innerHTML = '⚠️ 请填写前缀或后缀'; return; }
                var _model = _mo ? _mo.value : 'deepseek-v4-flash';
                var _max = parseInt((_mt ? _mt.value : '1024') || '1024', 10); if (!( _max > 0)) _max = 1024; if (_max > 4096) _max = 4096;
                var _fimUrl = (function() { try { var _u = new URL(dsApiUrl); return _u.origin + '/beta/completions'; } catch (e) { return 'https://api.deepseek.com/beta/completions'; } })();
                var _body = { model: _model, prompt: _prompt, max_tokens: _max, temperature: 0.7 };
                if (_suffix.trim()) _body.suffix = _suffix;
                _r.innerHTML = '⏳ 补全中…';
                var _ac = new AbortController();
                // P8 修复：FIM 请求超时（60s）
                var _fimTimer = setTimeout(function() {
                    try { _ac.abort(new DOMException('请求超时', 'TimeoutError')); } catch (e) {}
                }, 60000);
                try {
                    var _resp = await fetch(_fimUrl, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + _key }, body: JSON.stringify(_body), signal: _ac.signal });
                    if (!_resp.ok) {
                        var _et = await _resp.text(); var _em = 'HTTP ' + _resp.status;
                        try { var _ej = JSON.parse(_et); _em += '：' + ((_ej.error && (_ej.error.message || _ej.error.type)) || _et.slice(0, 200)); } catch (e) { _em += '：' + _et.slice(0, 200); }
                        _r.innerHTML = '❌ ' + _em; return;
                    }
                    var _jj = await _resp.json();
                    var _text = (_jj.choices && _jj.choices[0] && _jj.choices[0].text) || '';
                    _r.innerHTML = '<pre class="ds-fim-pre">' + (typeof dsEsc === 'function' ? dsEsc(_text) : _text) + '</pre>';
                } catch (e) {
                    if (e && e.name === 'TimeoutError') _r.innerHTML = '❌ 请求超时（60s），请稍后重试。';
                    else _r.innerHTML = '❌ ' + (e && e.message ? e.message : String(e));
                } finally {
                    if (_fimTimer) { clearTimeout(_fimTimer); _fimTimer = null; }
                }
            };

            function dsBubbleInner(idx) {
                var m = dsHistory[idx];
                if (!m) return '';
                var reasoningHtml = '';
                if (m.reasoning) {
                    reasoningHtml = '<details class="ds-reasoning" open><summary>💭 思考过程</summary><div class="ds-reasoning-body">' + dsEsc(m.reasoning) + '</div></details>';
                }
                return reasoningHtml + dsMarkdown(m.content || '');
            }

            // ---- 增强 Markdown 渲染 ----
            function dsMarkdown(text) {
                if (!text) return '';
                // 1. 抽取围栏代码块，避免后续行内替换污染其内部内容
                const codeBlocks = [];
                const CODE_SENTINEL = '@@DSCODEBLOCK@@';
                let src = String(text).replace(/```(\w*)\n?([\s\S]*?)```/g, function(match, lang, code) {
                    codeBlocks.push({ lang: (lang || 'txt'), code: code });
                    return CODE_SENTINEL + (codeBlocks.length - 1) + '@@';
                });

                // 2. 行级内联转换（先转义再替换）
                function inline(str) {
                    let s = dsEsc(str);
                    s = s.replace(/`([^`]+)`/g, '<code class="ds-md-code">$1</code>');
                    s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
                    s = s.replace(/\*([^*]+)\*/g, '<em>$1</em>');
                    s = s.replace(/~~([^~]+)~~/g, '<del>$1</del>');
                    s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
                    return s;
                }

                // 3. 代码块渲染
                function renderCodeBlock(item) {
                    const ext = (item.lang || 'txt').toLowerCase();
                    const fileExts = { html:'html', css:'css', js:'js', javascript:'js', ts:'ts', typescript:'ts', json:'json', py:'py', python:'py', sh:'sh', bash:'sh', sql:'sql', md:'md', xml:'xml', svg:'svg', txt:'txt' };
                    const fileExt = fileExts[ext] || ext;
                    return '<div class="ds-code-wrap"><button class="ds-code-dl" onclick="window.dsDownloadCode(this)" data-ext="' + fileExt + '" title="下载代码文件">📥 下载 ' + ext.toUpperCase() + '</button><pre class="ds-code"><code>' + dsEsc(item.code) + '</code></pre></div>';
                }

                // 4. 表格解析（| 表头 | / | --- | / 数据行）
                function parseTable(lines, start) {
                    const splitRow = function(row) { return row.split('|').slice(1, -1).map(function(c) { return c.trim(); }); };
                    const header = splitRow(lines[start]);
                    let next = start + 2; // 跳过分隔行
                    const rows = [];
                    while (next < lines.length && /^\|.*\|\s*$/.test(lines[next])) { rows.push(splitRow(lines[next])); next++; }
                    let html = '<table class="ds-md-table"><thead><tr>' + header.map(function(h) { return '<th>' + inline(h) + '</th>'; }).join('') + '</tr></thead><tbody>';
                    html += rows.map(function(r) { return '<tr>' + r.map(function(c) { return '<td>' + inline(c) + '</td>'; }).join('') + '</tr>'; }).join('') + '</tbody></table>';
                    return { html: html, next: next };
                }

                // 5. 逐行块级解析
                const lines = src.split('\n');
                const out = [];
                let listType = null; // 'ul' | 'ol'
                function closeList() { if (listType) { out.push('</' + listType + '>'); listType = null; } }

                let i = 0;
                while (i < lines.length) {
                    const line = lines[i];

                    // 代码块占位
                    const cb = line.match(/^@@DSCODEBLOCK@@(\d+)@@$/);
                    if (cb) {
                        closeList();
                        out.push(renderCodeBlock(codeBlocks[+cb[1]]));
                        i++; continue;
                    }
                    // 表格
                    if (/^\|.*\|\s*$/.test(line) && i + 1 < lines.length && /^\|[\s:|-]+\|\s*$/.test(lines[i + 1])) {
                        closeList();
                        const tbl = parseTable(lines, i);
                        out.push(tbl.html);
                        i = tbl.next; continue;
                    }
                    // 标题
                    const h = line.match(/^(#{1,4})\s+(.+)$/);
                    if (h) {
                        closeList();
                        const lv = h[1].length;
                        out.push('<h' + lv + ' class="ds-md-h">' + inline(h[2]) + '</h' + lv + '>');
                        i++; continue;
                    }
                    // 引用块
                    if (/^>\s?/.test(line)) {
                        closeList();
                        const q = [];
                        while (i < lines.length && /^>\s?/.test(lines[i])) { q.push(lines[i].replace(/^>\s?/, '')); i++; }
                        out.push('<blockquote class="ds-md-quote">' + inline(q.join('\n')) + '</blockquote>');
                        continue;
                    }
                    // 分隔线
                    if (/^(\s*[-*_]){3,}\s*$/.test(line)) {
                        closeList();
                        out.push('<hr class="ds-md-hr">');
                        i++; continue;
                    }
                    // 无序列表
                    if (/^[*\-]\s+/.test(line)) {
                        if (listType !== 'ul') { closeList(); out.push('<ul class="ds-md-ul">'); listType = 'ul'; }
                        out.push('<li>' + inline(line.replace(/^[*\-]\s+/, '')) + '</li>');
                        i++; continue;
                    }
                    // 有序列表
                    if (/^\d+\.\s+/.test(line)) {
                        if (listType !== 'ol') { closeList(); out.push('<ol class="ds-md-ol">'); listType = 'ol'; }
                        out.push('<li>' + inline(line.replace(/^\d+\.\s+/, '')) + '</li>');
                        i++; continue;
                    }
                    // 空行
                    if (line.trim() === '') { closeList(); i++; continue; }
                    // 普通段落
                    closeList();
                    out.push('<p class="ds-md-p">' + inline(line) + '</p>');
                    i++;
                }
                closeList();
                return out.join('');
            }
            function dsEsc(s) {
                return String(s || '')
                    .replace(/&/g, '&amp;')
                    .replace(/</g, '&lt;')
                    .replace(/>/g, '&gt;')
                    .replace(/"/g, '&quot;');
            }

            function dsSaveHistory() {
                try {
                    // P11 修复：本地仅保留最近 50 条，超出部分被丢弃（纯前端无后端存储）
                    var _trimmed = dsHistory.length > 50;
                    localStorage.setItem(DS_CHAT_STORAGE, JSON.stringify(dsHistory.slice(-50)));
                    if (dsCurrentConvId) {
                        const currentConv = dsConversations.find(c => c.id === dsCurrentConvId);
                        if (currentConv) {
                            currentConv.messages = dsHistory.slice(-50);
                            currentConv.title = dsGetConvTitle(currentConv.messages);
                            currentConv.timestamp = Date.now();
                            dsSaveConversations();
                            // 【性能优化】sidebar 重建移至流结束后单独触发
                        }
                    }
                    if (_trimmed && !window.__dsTrimWarnShown) {
                        window.__dsTrimWarnShown = true; // 仅提示一次，避免刷屏
                        if (window.Toast && window.Toast.info) window.Toast.info('当前对话已超过 50 条，较早的消息不再本地留存（仅保留最近 50 条）。');
                    }
                } catch(e) {
                    // P3 修复：写入失败时降级（丢弃图片块）重试，避免静默丢对话
                    try {
                        var slim = (dsHistory || []).map(function(m) {
                            if (m && m.visionContent) delete m.visionContent;
                            if (m && Array.isArray(m.content)) m.content = (m.displayText || '[图片对话]');
                            return m;
                        });
                        localStorage.setItem(DS_CHAT_STORAGE, JSON.stringify(slim.slice(-50)));
                    } catch (e2) {
                        if (window.Toast && window.Toast.error) window.Toast.error('对话历史保存失败：存储空间不足。');
                    }
                }
            }

            // 等待 DOM 就绪后初始化
            if (document.readyState === 'loading') {
                document.addEventListener('DOMContentLoaded', dsInit);
            } else {
                setTimeout(dsInit, 100);
            }



            // ========== 智能对规 已移至 smart-check.js ==========

            // ========== 智能写作 已移至 smart-writer.js ==========
        

        window.toggleDoubaoMode      = typeof toggleDoubaoMode !== 'undefined' ? toggleDoubaoMode : function(){ console.warn('[doubao] toggleDoubaoMode 未定义'); };
        window.showApiConfigModal     = typeof showApiConfigModal !== 'undefined' ? showApiConfigModal : function(){};
        window.saveApiConfigFromModal = typeof saveApiConfigFromModal !== 'undefined' ? saveApiConfigFromModal : function(){ console.warn('[doubao] saveApiConfigFromModal 未定义'); };
        window.bindApiModalEvents     = typeof bindApiModalEvents !== 'undefined' ? bindApiModalEvents : function(){};
        // 多模型管理（供弹窗内联 onclick 调用）
        window.dsNewProvider            = typeof dsNewProvider !== 'undefined' ? dsNewProvider : function(){};
        window.dsEditProvider           = typeof dsEditProvider !== 'undefined' ? dsEditProvider : function(){};
        window.dsDeleteProvider         = typeof dsDeleteProvider !== 'undefined' ? dsDeleteProvider : function(){};
        window.dsSetActiveProvider      = typeof dsSetActiveProvider !== 'undefined' ? dsSetActiveProvider : function(){};
        window.dsCancelEditProvider     = typeof dsCancelEditProvider !== 'undefined' ? dsCancelEditProvider : function(){};
        window.dsSaveProviderFromForm   = typeof dsSaveProviderFromForm !== 'undefined' ? dsSaveProviderFromForm : function(){};
        window.renderModelManager       = typeof renderModelManager !== 'undefined' ? renderModelManager : function(){};
        window.renderChatModelSelect    = typeof renderChatModelSelect !== 'undefined' ? renderChatModelSelect : function(){};
        window.dsAutoDetectModel        = typeof _autoDetectModel !== 'undefined' ? _autoDetectModel : function(){};
        // dsInit 在 IIFE 开头定义，也需暴露
        window.dsInit                 = typeof dsInit !== 'undefined' ? dsInit : function(){};
        // Part B 增强功能（agent 等）依赖的 Part A 内部函数
        window.dsEsc                  = typeof dsEsc !== 'undefined' ? dsEsc : function(s){ return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); };
        window.dsMarkdown             = typeof dsMarkdown !== 'undefined' ? dsMarkdown : function(t){ return t||''; };
        // 全域统一升级：暴露内部渲染/历史函数，供 unified-enhancements.js 安全钩接（不破坏现有逻辑）
        window.dsRenderAll            = typeof dsRenderAll !== 'undefined' ? dsRenderAll : function(){};
        window.dsAppendMsg            = typeof dsAppendMsg !== 'undefined' ? dsAppendMsg : function(){};
        window.getDsHistory           = (typeof dsHistory !== 'undefined') ? function(){ return dsHistory; } : function(){ return []; };

    })();


// ============================================================
// Part B: 增强功能 IIFE（原始代码 15255-15809 行）
// ============================================================
    (function() {
      'use strict';

      // ---------- 0. 跨 IIFE 依赖兜底（Part A 的 dsEsc / dsMarkdown） ----------
      var dsEsc = typeof window.dsEsc === 'function' ? window.dsEsc
        : function(s){ return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); };
      var dsMarkdown = typeof window.dsMarkdown === 'function' ? window.dsMarkdown
        : function(t){ return t||''; };

      // ---------- 1. 依赖检查 ----------
      const hasGetRules = typeof window.getRulesData === 'function';
      const hasGetIssue = typeof window.getIssueData === 'function';
      if (!hasGetRules && !hasGetIssue) console.warn('[增强] 未找到规章/检查数据，部分功能受限');

      // ---------- 2. 角色提示词 ----------
      const ROLE_PROMPTS = {
        'default':
          '你是铁路安全监察综合智能助手，同时具备通用知识问答能力。\n' +
          '【身份】你既精通铁路安全监察业务（规章、检查信息、风险研判、事故案例），也能回答管理、技术、生活等通用问题。\n' +
          '【业务职责】用户问铁路安全相关问题时，先判断所属专业（工务/电务/供电/车务/机务/车辆/通信/房建/客运/货运），优先引用本地数据库（规章制度、检查信息、安全手册）中的真实条款与案例作答；跨专业问题从综合监察视角统筹分析。\n' +
          '【通用问答】非铁路问题时，以准确、有条理的方式直接回答，必要时联网获取最新信息。\n' +
          '【纪律】引用业务数据必须注明来源与出处，不得编造规章编号或案例；不确定处明确"待核实"。',
        'dianwu':
          '你是电务（信号）安全监察专家。\n' +
          '【专业领域】信号联锁、CTC/TDCS 调度集中、列控系统（CTCS）、轨道电路（ZPW-2000）、微机监测、区间闭塞、应答器、信号机、电源屏、光电缆。\n' +
          '【应熟悉规章】《铁路技术管理规程》（信号部分）、《铁路信号维护规则》、《信号设备故障处理规则》、《铁路营业线施工安全管理办法》、《铁路交通事故应急救援和调查处理条例》。\n' +
          '【典型风险】联锁关系失效、轨道电路分路不良、CTC 错办进路、微机监测漏报警、施工联锁试验不彻底、列控数据错误、电源屏故障、光电缆中断。\n' +
          '【分析框架】从"设备状态→联锁逻辑→作业流程→施工管控"四维度核查，引用本地规章与历史检查问题，按风险分级给出整改建议。',
        'gongwu':
          '你是工务安全监察专家。\n' +
          '【专业领域】线路、桥隧、路基、道岔、钢轨及无缝线路、钢轨探伤、防洪、防胀、防断、周边环境。\n' +
          '【应熟悉规章】《铁路技术管理规程》（工务）、《铁路线路修理规则》、《铁路桥隧建筑物修理规则》、《铁路路基大维修规则》、《防洪工作管理办法》、《铁路营业线施工安全管理办法》。\n' +
          '【典型风险】线路几何尺寸超限、钢轨伤损/折断、道岔尖轨病害、桥隧衬砌劣化渗漏水、防洪重点处所水害、胀轨跑道、施工开挖破坏路基、周边违建/采砂侵限。\n' +
          '【分析框架】结合季节性风险（防洪/防胀/防断），从"设备状态→季节性风险→施工作业→周边环境"四维度分析，引用本地数据与规章。',
        'gongdian':
          '你是供电安全监察专家。\n' +
          '【专业领域】接触网、牵引变电所、电力线路、SCADA 远动、分段绝缘器、补偿装置、接地与过电压。\n' +
          '【应熟悉规章】《铁路技术管理规程》（供电）、《接触网运行检修规程》、《牵引变电所运行检修规程》、《铁路电力管理规则》、《电气化铁道接触网安全工作规程》。\n' +
          '【典型风险】接触网断线/塌网、工作票漏签或漏拆接地线、误送电、感应电触电、接触网覆冰、鸟害/危树、外部施工碰线。\n' +
          '【分析框架】从"设备状态→停送电作业（工作票/倒闸）→外部环境（危树/污染源/跨越）→天气（覆冰/大风/雷害）"四维度分析，严格落实"停电、验电、接地"纪律。',
        'chewu':
          '你是车务安全监察专家。\n' +
          '【专业领域】接发列车、调车作业、施工登销记、非正常行车、CTC 操作、车机联控、防溜、行车室管理。\n' +
          '【应熟悉规章】《铁路技术管理规程》（行车组织）、《接发列车作业标准》、《调车作业标准》、《铁路营业线施工安全管理办法》、《车机联控标准》。\n' +
          '【典型风险】错办进路、抢钩/抢点作业、调车作业冲突/脱轨、施工登销记错误、进路未准备好接发列车、防溜措施失效、联控漏呼。\n' +
          '【分析框架】从"作业标准→进路安全（敌对/分路不良）→施工登销记管控→联控互控"四维度核查，强调标准化作业与互控。',
        'keyun':
          '你是客运安全监察专家。\n' +
          '【专业领域】客运组织、乘降安全、安检查危、实名验证、站车秩序、突发客流、站台与电梯安全、重点旅客服务。\n' +
          '【应熟悉规章】《铁路旅客运输规程》、《铁路旅客车站客运设施管理办法》、《铁路旅客运输安全检查管理规程》、《铁路旅客列车消防安全管理规定》、《铁路交通事故应急救援和调查处理条例》。\n' +
          '【典型风险】站台坠落、电梯/自动扶梯伤害、安检查危漏检（危险品进站）、客流拥挤踩踏、重点旅客服务缺失、站台端部入侵。\n' +
          '【分析框架】从"乘降组织→安检防爆→设备设施（电梯/站台/消防）→应急处置"四维度分析，突出人防+物防+技防。',
        'jiwu':
          '你是机务安全监察专家。\n' +
          '【专业领域】机车运用、乘务管理、LKJ/CIR 装备、机车检修、调车作业（调小车）安全、机车防火。\n' +
          '【应熟悉规章】《铁路机车运用管理规则》、《机务行车安全管理规则》、《LKJ 数据管理规程》、《铁路机车操作规则》、《防止机车车辆溜逸管理办法》。\n' +
          '【典型风险】乘务员超劳/待乘不足、LKJ 数据错误、退勤漏鉴、调车作业冒进信号、行安装备（CIR/LKJ）故障、超速运行、机车防火。\n' +
          '【分析框架】从"人（乘务超劳/待乘）→机（LKJ/CIR 装备）→环境（运行图/施工）→管理（超劳/退勤）"四维度，强调防滑坡/防超速/防冒进。',
        'cheliang':
          '你是车辆安全监察专家。\n' +
          '【专业领域】货车/客车/动车组运用维修、5T 系统（THDS/TPDS/TADS/TFDS/TCDS）、轮轴、制动、转向架、防火、配件脱落。\n' +
          '【应熟悉规章】《铁路货车运用维修规程》、《铁路客车运用维修规程》、《动车组运用维修规程》、《铁路车辆运行安全监控系统（5T）运用管理细则》。\n' +
          '【典型风险】热轴（THDS 预报）、轮对裂纹/剥离、制动失灵、配件脱落、客车/动车防火隐患、5T 预报处置不及时或漏拦。\n' +
          '【分析框架】从"检测监测（5T 预报）→走行部（轮轴/转向架）→制动系统→防火"四维度，强调监测预报闭环处置。',
        'tongxin':
          '你是通信安全监察专家。\n' +
          '【专业领域】GSM-R 无线列调、光纤传输、数调、漏泄电缆、应急通信、网管监测。\n' +
          '【应熟悉规章】《铁路技术管理规程》（通信）、《铁路通信维护规则》、《铁路数字移动通信系统（GSM-R）维护管理办法》、《铁路营业线施工安全管理办法》。\n' +
          '【典型风险】GSM-R 覆盖盲区/掉话、光纤中断、无线列调失效、传输网告警、应急通信不畅、基站/铁塔安全。\n' +
          '【分析框架】从"传输网→无线（GSM-R 覆盖/列调）→应急通信→网管监测"四维度，强调行车通信不间断。',
        'fangjian':
          '你是房建安全监察专家。\n' +
          '【专业领域】站台限界、雨棚/站房屋面、地下空间、风雨棚钢结构、幕墙、客运流线设施。\n' +
          '【应熟悉规章】《铁路技术管理规程》（建筑限界）、《铁路房屋建筑大修维修规则》、《铁路建筑限界管理办法》、《铁路旅客车站客运设施管理办法》。\n' +
          '【典型风险】站台/雨棚侵限、雨棚钢结构锈蚀或构件脱落、建筑限界变化未报批、站房屋面渗漏、幕墙脱落、地下空间积水。\n' +
          '【分析框架】从"限界管理→结构安全（雨棚/站房）→屋面防水→客运流线"四维度，突出侵限零容忍。',
        'huoyun':
          '你是货运安全监察专家。\n' +
          '【专业领域】装载加固、超限超重运输、危险货物运输、篷布管理、货运计量安全检测、货运交接。\n' +
          '【应熟悉规章】《铁路货物装载加固规则》、《铁路超限超重货物运输规则》、《铁路危险货物运输规则》、《货运计量安全检测监控管理办法》。\n' +
          '【典型风险】超载/偏载、加固材料失效、超限超重未办理、危险货物匿报/错报、撒漏污染、货物位移。\n' +
          '【分析框架】从"装载加固（方案/材料）→超限超重（批示/监护）→危险货物（品类/包装）→计量检测（超偏载仪）"四维度。',
        'tongyong':
          '你是铁路综合安全监察专家，擅长跨专业综合分析、体系化安全管理和风险研判。\n' +
          '【职责】统筹工务、电务、供电、车务、机务、车辆、通信、房建、客运、货运等全专业安全问题；运用双重预防机制（风险分级管控+隐患排查治理）、安全红线、标准化管理开展研判。\n' +
          '【方法】识别系统性风险，按"人、机、环、管"与"高/中/低"风险分级结构化输出，给出可执行的预警与整改措施，引用本地检查信息与规章数据支撑结论。',
        'frontend':
          '你是一位资深前端工程师。请根据用户需求编写干净的 HTML/CSS/JS 代码。要求：代码自包含，可直接运行；使用现代浏览器特性；输出完整 HTML 代码块。',
        'riskanalyst':
          '你是铁路安全风险分析专家。你的任务是：\n' +
          '1. 基于本地检查信息和规章制度（优先引用真实数据），识别当前最突出的安全风险领域\n' +
          '2. 按时间趋势、专业分布、问题性质三个维度分析\n' +
          '3. 针对高危领域给出具体的预警措施和整改建议\n' +
          '4. 输出格式要求：先概述总体情况，再分点列出风险等级（高/中/低），最后给出3-5条可执行的预警措施\n' +
          '5. 引用数据时标注来源和时间范围，建议要具体可操作；若本地数据不足，说明需补充或联网核实的方向。',
      };

      // ---------- 3. 长期记忆管理 ----------
      const MEMORY_KEY = 'assistant_memory_v1';
      let userMemories = [];
      let memoryEnabled = true;

      function loadMemories() {
        try { userMemories = JSON.parse(localStorage.getItem(MEMORY_KEY) || '[]'); } catch(e) { userMemories = []; }
      }
      function saveMemories() { localStorage.setItem(MEMORY_KEY, JSON.stringify(userMemories)); }

      function extractFacts(text) {
        // 无条件自动记忆：截取用户输入前100字作为记忆
        var cleaned = text.replace(/\s+/g, ' ').trim();
        return cleaned ? [cleaned.slice(0, 100)] : [];
      }

      function addMemory(fact) {
        if (!fact) return;
        // 去重：完全相同的记忆不重复存储
        if (userMemories.some(function(m) { return m.fact === fact; })) return;
        userMemories.push({ fact: fact, timestamp: Date.now() });
        // 只保留最近66条记忆
        if (userMemories.length > 66) userMemories = userMemories.slice(-66);
        saveMemories();
      }

      function getRelevantMemories(query) {
        if (!memoryEnabled) return [];
        // 无条件返回最近记忆，按时间倒序取最新66条（注入上限由调用方控制）
        return userMemories.slice(-66).reverse();
      }

      // 清空全部长期记忆（设置面板"清空"按钮调用）
      function clearLongTermMemory() {
        if (!confirm('确定清空所有长期记忆？此操作不可恢复。')) return;
        try {
          localStorage.removeItem(MEMORY_KEY);
          userMemories = [];
          alert('长期记忆已清空');
        } catch (e) {
          alert('清空失败：' + e.message);
        }
      }
      window.clearLongTermMemory = clearLongTermMemory;

      // ---------- 4. 轻量级 BM25 检索器 ----------
      class LightBM25 {
        constructor(docs, k1 = 1.2, b = 0.75) {
          this.docs = docs;
          this.k1 = k1;
          this.b = b;
          this.avgLen = 0;
          this.idf = new Map();
          if (docs.length) this._build();
        }
        _build() {
          const docCount = this.docs.length;
          this.avgLen = this.docs.reduce((sum, d) => sum + (d.content || '').length, 0) / docCount;
          const termDocs = new Map();
          this.docs.forEach((doc, idx) => {
            const tokens = this._tokenize(doc.content || '');
            const uniq = new Set(tokens);
            for (let t of uniq) {
              if (!termDocs.has(t)) termDocs.set(t, []);
              termDocs.get(t).push(idx);
            }
          });
          for (let [term, docsArr] of termDocs.entries()) {
            const freq = docsArr.length;
            this.idf.set(term, Math.log((docCount - freq + 0.5) / (freq + 0.5) + 1));
          }
        }
        _tokenize(str) {
          if (!str) return [];
          const tokens = [];
          const s = str.toLowerCase();
          for (let i = 0; i < s.length; i++) {
            if (/[\u4e00-\u9fa5]/.test(s[i])) {
              if (i+1 < s.length) tokens.push(s.slice(i, i+2));
              if (i+2 < s.length && /[\u4e00-\u9fa5]/.test(s[i+2])) tokens.push(s.slice(i, i+3));
            } else if (/[a-z0-9]/.test(s[i])) {
              let j = i;
              while (j < s.length && /[a-z0-9]/.test(s[j])) j++;
              tokens.push(s.slice(i, j));
              i = j - 1;
            }
          }
          return tokens;
        }
        _score(query, doc) {
          const qTokens = this._tokenize(query);
          if (!qTokens.length) return 0;
          const docTokens = this._tokenize(doc.content || '');
          const tfMap = new Map();
          for (let t of docTokens) tfMap.set(t, (tfMap.get(t) || 0) + 1);
          let score = 0;
          for (let t of qTokens) {
            const tf = tfMap.get(t) || 0;
            if (tf === 0) continue;
            const idf = this.idf.get(t) || 0;
            const lenNorm = doc.content.length / this.avgLen;
            score += idf * (tf * (this.k1 + 1)) / (tf + this.k1 * (1 - this.b + this.b * lenNorm));
          }
          return score;
        }
        search(query, topN = 5) {
          if (!this.docs.length) return [];
          const scores = this.docs.map(doc => ({ doc, score: this._score(query, doc) }));
          return scores.filter(s => s.score > 0).sort((a,b) => b.score - a.score).slice(0, topN).map(s => s.doc);
        }
      }

      let bm25Rules = null, bm25Issues = null;
      function getBM25Rules() {
        if (!hasGetRules) return null;
        const rules = window.getRulesData();
        if (!bm25Rules) {
          bm25Rules = new LightBM25(rules.map(r => ({ content: (r.title + ' ' + r.content), ...r })));
        }
        return bm25Rules;
      }
      function getBM25Issues() {
        if (!hasGetIssue) return null;
        const issues = window.getIssueData();
        if (!bm25Issues) {
          bm25Issues = new LightBM25(issues.map(i => ({ content: (i.content + ' ' + (i.category||'') + ' ' + (i['性质']||'')), ...i })));
        }
        return bm25Issues;
      }

      // 【性能优化调整 v3.15】移除首屏 BM25 预构建：
      // 原先在 idle/3s 后对 8000+ 条规章+检查信息全量建索引，导致打开/刷新界面后
      // 停留几秒出现 3-4 秒主线程卡滞（用户感知「在加载数据」，但界面/数据已通过
      // 整页快照恢复）。改为首次搜索时懒建（getBM25Rules/Issues 已有 !bm25Rules 守卫，
      // 幂等复用，不重复构建），首屏不再卡顿，首次查询的 200-500ms 建索引在主动操作
      // 语境下可接受。

      // ---------- 5. 本地检索 RAG ----------
      async function retrieveLocalData(query, options) {
        // 智能写作已选模版+资料时跳过 BM25 检索，避免卡死
        if (window._wrSkipLocalSearch) {
          console.log('[retrieveLocalData] 跳过检索：_wrSkipLocalSearch=' + window._wrSkipLocalSearch);
          return { rules: [], issues: [], skipped: true };
        }
        options = options || { topNRules: 3, topNIssues: 3, recentMonth: false };
        var rules = [], issues = [];
        
        // BM25 关键词检索
        try { var r = getBM25Rules(); if (r) rules = r.search(query, options.topNRules); } catch(e) {}
        try {
            var i = getBM25Issues();
            if (i) {
              var raw = i.search(query, options.topNIssues * 3);
              if (options.recentMonth) {
                var oneMonthAgo = new Date();
                oneMonthAgo.setMonth(oneMonthAgo.getMonth() - 1);
                raw = raw.filter(function(item) {
                  var t = item.datetime || item['时间'] || '';
                  if (!t) return false;
                  var d = new Date(t.replace(/\//g, '-'));
                  return d >= oneMonthAgo;
                });
              }
              issues = raw.slice(0, options.topNIssues);
            }
        } catch(e) {}
        
        return { rules: rules, issues: issues };
      }

      function buildReferenceText(rules, issues) {
        let ref = '';
        if (rules.length) {
          ref += '【相关规章条款（来自本地数据库）】\n';
          rules.forEach(function(r, i) {
            ref += (i+1) + '. 《' + r.title + '》（' + (r.trade||'通用') + '）\n   ' + (r.content||'').slice(0, 300) + ((r.content||'').length>300?'…':'') + '\n';
          });
          ref += '\n';
        }
        if (issues.length) {
          ref += '【相似历史检查问题（来自本地台账）】\n';
          issues.forEach(function(iss, i) {
            ref += (i+1) + '. [' + (iss['性质']||'其他') + '][' + (iss.category||'') + '] ' + (iss.content||'').slice(0, 200) + ((iss.content||'').length>200?'…':'') + '\n';
          });
          ref += '\n';
        }
        return ref;
      }

      // ---------- 7. 一键对规 ----------
      window.enhancedAutoCheck = async function(problemText) {
        if (!problemText) {
          const input = document.getElementById('autoCheck-input');
          if (input) problemText = input.value.trim();
        }
        if (!problemText) return alert('请输入检查问题描述');
        const container = document.getElementById('autoCheck-results');
        if (container) {
          container.innerHTML = '<div style="padding:20px;color:var(--text-secondary)">🔍 正在匹配本地案例和规章...</div>';
          container.style.display = 'block';
        }
        const { rules, issues } = await retrieveLocalData(problemText, { topNRules: 4, topNIssues: 4 });
        const refText = buildReferenceText(rules, issues);
        const apiKey = await (typeof _getApiKey === 'function' ? _getApiKey() : Promise.resolve(localStorage.getItem('ds_api_key_v1') || ''));
        const apiUrl = localStorage.getItem('ds_api_url_v1') || 'https://api.deepseek.com/chat/completions';
        const model = localStorage.getItem('ds_model_v1') || 'deepseek-v4-flash';
        if (!apiKey) {
          if (container) container.innerHTML = '<div style="color:var(--warning)">请先配置 API Key</div>';
          return;
        }
        const systemPrompt = '你是铁路安全对规专家。请基于以下【参考资料】中的真实历史案例和规章条款，分析用户输入的检查问题。\n' + refText +
          '【输出要求】\n1. 明确指出问题违反的具体条款（必须引用上述规章中的编号和内容，如果没有明确条款则说明「参考资料中无直接对应条款」）。\n2. 对比历史案例，指出相似点和特殊性。\n3. 给出具体整改建议（可借鉴案例中的有效做法）。\n4. 不得编造任何条款或数据。';
        if (container) container.innerHTML = '<div style="padding:20px">🤖 AI 正在分析，请稍候...</div>';
        try {
          const resp = await fetch(apiUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + apiKey },
            body: JSON.stringify({
              model: model,
              messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: '检查问题：' + problemText }
              ],
              temperature: 0.3, max_tokens: 1500, stream: false
            })
          });
          const data = await resp.json();
          const conclusion = data.choices && data.choices[0] && data.choices[0].message ? data.choices[0].message.content : '无响应';
          // 使用 safeHtml 防止 AI 返回内容中的 XSS（如恶意 <script> / <img onerror> 等）
          var _safeConclusion = typeof window.safeHtml === 'function'
            ? window.safeHtml(conclusion, { allowedTags: ['br','div','h3','p','strong','em','b','i','span','ul','ol','li','pre','code','blockquote'] })
            : window.escapeHtml(conclusion).replace(/\n/g, '<br>');
          const html = '<div style="background:#f0f9ff;padding:16px;border-radius:12px;border-left:5px solid #2563eb;">' +
            '<h3>⚖️ 对规结论</h3>' +
            '<div style="margin:10px 0;white-space:pre-wrap;">' + _safeConclusion + '</div>' +
            '<div style="font-size:0.8rem;color:#059669;">✅ 引用规章 ' + rules.length + ' 条，历史案例 ' + issues.length + ' 条</div>' +
            '</div>';
          if (container) container.innerHTML = html;
        } catch(e) {
          if (container) container.innerHTML = '<div style="color:red">对规失败：' + (typeof window.escapeHtml === 'function' ? window.escapeHtml(e.message) : String(e.message).replace(/</g,'&lt;')) + '</div>';
        }
      };

      // ---------- 8. 增强智能写作 ----------
      var originalWrGenerate = window.wrGenerate;
      if (typeof originalWrGenerate === 'function') {
        window.wrGenerate = async function() {
          const q = document.getElementById('wr-query-input') ? document.getElementById('wr-query-input').value : '';
          if (!q) return originalWrGenerate();

          // 判断是否需要跳过本地检索
          // 新规则：只要选了资料就停止本地搜索（资料已给足，不卡死）
          //       没选资料时 → 做本地检索（仅最近1个月检查信息）
          //       用户明确要求搜索时 → 不受资料限制，仍做本地检索
          var hasMaterials = !!(window._wrSelectedMaterialIds && window._wrSelectedMaterialIds.length > 0);
          var askForSearch = /检索|搜索|查找|查询.*规章|查询.*检查|关联.*资料|本地.*数据|补充.*资料/.test(q);
          var shouldSkipSearch = hasMaterials && !askForSearch;

          console.log('[wrGenerate] hasMaterials=' + hasMaterials + ' askForSearch=' + askForSearch + ' shouldSkipSearch=' + shouldSkipSearch);

          if (shouldSkipSearch) {
            // 跳过本地检索，直接生成
            window._wrSkipLocalSearch = true;
            try {
              await originalWrGenerate();
            } finally {
              window._wrSkipLocalSearch = false;
            }
            return;
          }

          // 需要本地检索：仅搜索最近1个月检查信息（recentMonth: true）
          const { issues } = await retrieveLocalData(q, { topNIssues: 8, recentMonth: true });
          let statsText = '';
          if (issues.length) {
            const total = issues.length;
            const na = issues.filter(function(i){ return (i['性质']||'').includes('A'); }).length;
            const nb = issues.filter(function(i){ return (i['性质']||'').includes('B'); }).length;
            const nc = issues.filter(function(i){ return (i['性质']||'').includes('C'); }).length;
            const typicals = issues.slice(0,5).map(function(i,idx){ return (idx+1)+'. '+i.content.slice(0,150); }).join('\n');
            statsText = '【台账真实数据（最近1个月）】\n- 匹配问题总数：'+total+'条（A类'+na+'，B类'+nb+'，C类'+nc+'）\n- 典型问题：\n'+typicals+'\n\n';
          }
          const originalInput = document.getElementById('wr-query-input');
          if (originalInput && statsText) {
            const originalVal = originalInput.value;
            originalInput.value = statsText + '用户需求：' + originalVal;
            await originalWrGenerate();
            originalInput.value = originalVal;
          } else {
            await originalWrGenerate();
          }
        };
      }

      // ---------- 风险研判：一键汇总本地数据 → AI分析 ----------
      window._riskCtx = null; // 存储上下文供追问
      window._lastRiskReportId = null; // 最近一次保存的风险报告 id（追问时更新同一条）
      var RISK_CONFIG_KEY = 'risk_config_v1';

      function saveRiskConfig() {
        var conf = {
          dateStart: document.getElementById('risk-date-start')?.value || '',
          dateEnd: document.getElementById('risk-date-end')?.value || '',
          unit: document.getElementById('risk-unit')?.value || '',
          focus: document.getElementById('risk-focus')?.value || '',
          format: (document.querySelector('input[name="risk-format"]:checked') || {}).value || 'full'
        };
        localStorage.setItem(RISK_CONFIG_KEY, JSON.stringify(conf));
      }

      function loadRiskConfig() {
        try {
          var conf = JSON.parse(localStorage.getItem(RISK_CONFIG_KEY) || '{}');
          var el;
          if (conf.dateStart && (el = document.getElementById('risk-date-start'))) el.value = conf.dateStart;
          if (conf.dateEnd && (el = document.getElementById('risk-date-end'))) el.value = conf.dateEnd;
          if (conf.unit && (el = document.getElementById('risk-unit'))) el.value = conf.unit;
          if (conf.focus && (el = document.getElementById('risk-focus'))) el.value = conf.focus;
          if (conf.format) {
            var radio = document.querySelector('input[name="risk-format"][value="' + conf.format + '"]');
            if (radio) radio.checked = true;
          }
          // 恢复配置后触一次预览，拉取实际DB数据
          updateRiskPreview();
        } catch(e) {}
      }

      async function saveRiskReportToWriter(title, markdown, isFollowUp) {
        try {
          var now = new Date();
          var report = {
            title: title || ('风险研判 ' + now.toLocaleString('zh-CN').replace(/\//g, '-')),
            category: '风险研判',
            content: markdown,
            date: now.toISOString(),
            createdAt: now.getTime()
          };
          var dbReq = indexedDB.open('railway_writer_db', 2);
          await new Promise(function(resolve, reject) {
            dbReq.onupgradeneeded = function(e) {
              var db = e.target.result;
              if (!db.objectStoreNames.contains('writing_reports')) {
                db.createObjectStore('writing_reports', { keyPath: 'id', autoIncrement: true });
              }
            };
            dbReq.onsuccess = function() {
              var db = dbReq.result;
              var tx = db.transaction('writing_reports', 'readwrite');
              var store = tx.objectStore('writing_reports');
              var op;
              if (isFollowUp && window._lastRiskReportId != null) {
                // 追问：更新同一条记录，避免报告堆积
                report.id = window._lastRiskReportId;
                op = store.put(report);
              } else {
                op = store.add(report);
              }
              op.onsuccess = function(e2) {
                if (!isFollowUp) window._lastRiskReportId = e2.target.result;
                db.close(); resolve();
              };
              tx.onerror = function() { db.close(); reject(tx.error); };
            };
            dbReq.onerror = function() { reject(dbReq.error); };
          });
          console.log('风险报告已存入写作历史');
          // 仅首次生成同步到 writing_materials（供附件选择器读取），追问不再重复新增
          if (!isFollowUp) {
            try {
              var dbReq2 = indexedDB.open('railway_writer_db', 2);
              await new Promise(function(resolve, reject) {
                dbReq2.onsuccess = function() {
                  var db = dbReq2.result;
                  if (!db.objectStoreNames.contains('writing_materials')) { db.close(); resolve(); return; }
                  var tx = db.transaction('writing_materials', 'readwrite');
                  tx.objectStore('writing_materials').add({
                    title: report.title,
                    content: markdown,
                    type: 'report',
                    date: report.date,
                    createdAt: report.createdAt,
                    source: '风险研判'
                  });
                  tx.oncomplete = function() { db.close(); resolve(); };
                  tx.onerror = function() { resolve(); };
                };
                dbReq2.onerror = function() { resolve(); };
              });
            } catch(e2) { console.warn('同步到写作资料库失败:', e2); }
          }
        } catch(e) {
          console.warn('保存风险报告到写作历史失败:', e);
        }
      }

      // 实时更新数据预览计数 + 动态填充专业/单位选项
      var _riskPreviewTimer = null;
      function updateRiskPreview() {
        if (_riskPreviewTimer) { clearTimeout(_riskPreviewTimer); _riskPreviewTimer = null; }
        _riskPreviewTimer = setTimeout(_doRiskPreview, 300); // 防抖300ms
      }
      function _doRiskPreview() {
        var preview = document.getElementById('risk-data-preview');
        if (!preview) return;
        var dateStart = document.getElementById('risk-date-start')?.value || '';
        var dateEnd = document.getElementById('risk-date-end')?.value || '';
        var unit = document.getElementById('risk-unit')?.value.trim() || '';

        try {
          var dbReq = indexedDB.open('RailwayIssueDB_v2', 2);
          dbReq.onsuccess = function() {
            var db = dbReq.result;
            if (!db.objectStoreNames.contains('issues')) { db.close(); return; }
            var tx = db.transaction('issues', 'readonly');
            var s = tx.objectStore('issues');
            s.getAll().onsuccess = function(e) {
              var all = e.target.result || [];
              var units = new Set();
              for (var i = 0; i < all.length; i++) {
                var d = all[i];
                if (d.unit) units.add(d.unit);
                if (d.department) units.add(d.department);
              }

              // 更新单位数据列表
              var unitInput = document.getElementById('risk-unit');
              if (unitInput && units.size > 0) {
                var datalistId = 'risk-unit-list';
                var dl = document.getElementById(datalistId);
                if (!dl) {
                  dl = document.createElement('datalist');
                  dl.id = datalistId;
                  document.body.appendChild(dl);
                }
                dl.innerHTML = '';
                Array.from(units).sort().forEach(function(u) {
                  dl.innerHTML += '<option value="'+u.replace(/"/g,'&quot;')+'">';
                });
                if (!unitInput.getAttribute('list')) {
                  unitInput.setAttribute('list', datalistId);
                }
              }

              // 更新计数
              var totalEl = document.getElementById('risk-preview-total');
              var filteredEl = document.getElementById('risk-preview-filtered');
              if (totalEl) totalEl.textContent = all.length + ' 条';
              var filtered = all;
              if (dateStart) {
                var sd = new Date(dateStart + 'T00:00:00');
                filtered = filtered.filter(function(d) {
                  try { return new Date(d.datetime || '') >= sd; } catch(e) { return false; }
                });
              }
              if (dateEnd) {
                var ed = new Date(dateEnd + 'T23:59:59');
                filtered = filtered.filter(function(d) {
                  try { return new Date(d.datetime || '') <= ed; } catch(e) { return false; }
                });
              }
              if (unit) {
                filtered = filtered.filter(function(d) {
                  return (d.unit || '').indexOf(unit) !== -1 || (d.department || '').indexOf(unit) !== -1;
                });
              }
              if (filteredEl) filteredEl.textContent = filtered.length + ' 条';
              if (dateStart || dateEnd || unit) {
                preview.style.display = 'flex';
              }
              db.close();
            };
          };
        } catch(e) {}
      }

      // ---------- 风险报告：操作按钮辅助函数 ----------
      function _riskBtn(label, color, onclick) {
        var b = document.createElement('button');
        b.textContent = label;
        b.style.cssText = 'background:none;border:1px solid #d1d5db;border-radius:14px;padding:3px 10px;font-size:0.75rem;cursor:pointer;color:#6b7280;transition:all 0.15s;';
        b.onmouseover = function(){ this.style.borderColor = color; this.style.color = color; };
        b.onmouseout = function(){ this.style.borderColor = '#d1d5db'; this.style.color = '#6b7280'; };
        b.onclick = onclick;
        return b;
      }
      function _riskFallbackCopy(txt) {
        var ta = document.createElement('textarea'); ta.value = txt; ta.style.position = 'fixed'; ta.style.left = '-9999px';
        document.body.appendChild(ta); ta.select(); document.execCommand('copy'); document.body.removeChild(ta);
        if (typeof window.Toast !== 'undefined') window.Toast.success('已复制到剪贴板');
      }
      function riskCopyReport(txt) {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(txt).then(function(){ if (typeof window.Toast !== 'undefined') window.Toast.success('已复制到剪贴板'); }).catch(function(){ _riskFallbackCopy(txt); });
        } else { _riskFallbackCopy(txt); }
      }
      function riskDownloadReport(txt) {
        var blob = new Blob([txt], { type: 'text/plain;charset=utf-8' });
        window.downloadBlob(blob, '风险研判_' + new Date().toISOString().slice(0,10) + '.txt');
      }
      function riskSpeak(btn) {
        if (typeof window.speechSynthesis === 'undefined') return;
        var text = window._riskLastReportText || '';
        if (window._riskSpeaking) {
          window.speechSynthesis.cancel(); window._riskSpeaking = false;
          if (btn) btn.textContent = '🔊 朗读';
          return;
        }
        if (!text) return;
        var u = new SpeechSynthesisUtterance(text);
        u.lang = 'zh-CN'; u.rate = 1.0;
        try {
          var rvoices = window.speechSynthesis.getVoices();
          var rzh = (rvoices || []).filter(function(v){ return /zh|cmn|Chinese|中文|普通话/i.test((v.lang||'') + (v.name||'')); })[0];
          if (rzh) u.voice = rzh;
        } catch (_) {}
        u.onend = function(){ window._riskSpeaking = false; if (btn) btn.textContent = '🔊 朗读'; };
        u.onerror = u.onend;
        window.speechSynthesis.speak(u);
        window._riskSpeaking = true;
        if (btn) btn.textContent = '⏹ 停止';
      }

      window.runRiskAnalysis = async function(followUp) {
        var container = document.getElementById('risk-results');
        var refineArea = document.getElementById('risk-refine');
        if (!container) return;
        container.style.display = 'block';
        container.innerHTML = '<div style="padding:20px;color:var(--text-secondary);text-align:center;">'
          + '<div style="display:inline-block;width:20px;height:20px;border:2px solid var(--border);border-top-color:var(--primary);border-radius:50%;animation:spin 0.6s linear infinite;margin-bottom:8px;"></div>'
          + '<p>📊 ' + (followUp ? '正在重新分析…' : '正在汇总本地数据并分析风险…') + '</p></div>';

        try {
          var apiKey = localStorage.getItem('ds_api_key_v1') || '';
          if (!apiKey) { container.innerHTML = '<div style="color:#dc2626;padding:20px;">请先配置 API Key</div>'; return; }
          var apiUrl = localStorage.getItem('ds_api_url_v1') || 'https://api.deepseek.com/chat/completions';
          var model   = localStorage.getItem('ds_model_v1') || 'deepseek-v4-flash';

          var messages = [];
          var noIssueData = false;
          if (!followUp) {
            // 读取研判条件
            var dateStart = document.getElementById('risk-date-start')?.value || '';
            var dateEnd = document.getElementById('risk-date-end')?.value || '';
            var unit = document.getElementById('risk-unit')?.value.trim() || '';
            var focus = document.getElementById('risk-focus')?.value.trim() || '';
            var formatEl = document.querySelector('input[name="risk-format"]:checked');
            var format = formatEl ? formatEl.value : 'full';
            var formatDesc = { full: '完整报告：总体概况 + 风险分级 + 预警措施', brief: '简要摘要：只输出关键风险点和数量统计', actions: '整改措施清单：仅列出3-5条可执行的整改措施' }[format] || '完整报告';

            var summary = await _buildRiskDataSummary(dateStart, dateEnd, unit);
            noIssueData = summary.indexOf('【检查信息】总计') === -1;
            var userMsg = '请基于以下铁路安全检查数据进行风险研判：\n\n' + summary + '\n\n';
            userMsg += '研判要求：\n';
            if (dateStart || dateEnd) userMsg += '- 时间范围：' + (dateStart||'不限') + ' 至 ' + (dateEnd||'不限') + '\n';
            if (unit) userMsg += '- 限定责任单位：' + unit + '\n';
            userMsg += '- 重点关注：' + (focus || '通用安全风险') + '\n';
            userMsg += '- 输出格式：' + formatDesc + '\n';
            userMsg += '- 可参考下方【事故专业案例】中的真实事故案例，结合检查信息开展研判，使结论更具针对性。\n';
            userMsg += '\n请开始分析。';

            messages = [
              { role: 'system', content: '你是铁路安全风险分析专家。请严格按照用户要求的时间范围、专业限定、分析重点和输出格式进行分析。\n【重要约束】你只能引用下方【检查信息】真实汇总数据中的统计数字、案例与日期，严禁虚构任何统计数字、事故案例或时间；若某方面数据不足，必须如实说明"数据不足"，不得编造或推测具体数字。' },
              { role: 'user', content: userMsg }
            ];
            // 【视觉模型接入】若当前附件含图片且模型支持视觉，把首条 user 消息 content 改为多模态数组
            (function() {
              try {
                var _rModel = localStorage.getItem('ds_model_v1') || 'deepseek-v4-flash';
                var _visionOk = (typeof window.dsModelSupportsVision === 'function') ? window.dsModelSupportsVision(_rModel) : false;
                if (!_visionOk) return;
                var _imgs = (window._dsAttachments || []).filter(Boolean).filter(function(a){ return a && a.isImage && a.dataUrl; }).map(function(a){ return a.dataUrl; });
                if (!_imgs.length) return;
                messages[1] = { role: 'user', content: [
                  { type: 'text', text: userMsg + '\n\n（附图片：' + _imgs.length + ' 张，请结合图片中的现场照片/图表/仪表等视觉信息一并研判）' },
                  ..._imgs.map(function(u){ return { type: 'image_url', image_url: { url: u } }; })
                ] };
              } catch (_e) {}
            })();
          } else {
            messages = (window._riskCtx || []);
            var refineInput = document.getElementById('risk-refine-input');
            var refineText = refineInput ? refineInput.value.trim() : '';
            if (!refineText) refineText = '请进一步分析';
            messages.push({ role: 'user', content: refineText });
            if (refineInput) refineInput.value = '';
          }

          // Y1：增加整体超时（180s），避免长报告（max_tokens 6000）假死、不可中断
          var _riskAbort = new AbortController();
          var _riskTimeout = setTimeout(function() {
            try { _riskAbort.abort(new Error('TimeoutError')); } catch (e) {}
          }, 180000);
          var resp;
          try {
            resp = await fetch(apiUrl, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + apiKey },
              body: JSON.stringify({ model: model, messages: messages, temperature: 0.3, max_tokens: 6000, stream: false }),
              signal: _riskAbort.signal
            });
          } finally {
            clearTimeout(_riskTimeout);
          }

          if (!resp.ok) {
            var _statusHints = { 401:'API Key 无效', 402:'账户余额不足', 403:'无访问权限', 404:'模型不存在(请检查当前模型)', 429:'请求过于频繁' };
            var _hintMsg = _statusHints[resp.status] || ('HTTP ' + resp.status);
            // 404 多为模型名错误；CORS 由 catch 的 Failed to fetch 捕获
            throw new Error(_hintMsg);
          }
          var data = await resp.json();
          var report = (data.choices && data.choices[0] && data.choices[0].message) ? data.choices[0].message.content : '无响应';

          // 保存上下文供追问（截断：保留 system + 首条汇总 + 最近 6 条对话，避免无限累积）
          window._riskCtx = messages;
          window._riskCtx.push({ role: 'assistant', content: report });
          if (window._riskCtx.length > 8) {
            window._riskCtx = window._riskCtx.slice(0, 2).concat(window._riskCtx.slice(-6));
          }

          // 渲染结果（统一使用 dsMarkdown：支持表格/引用/列表/链接，并修复 ## 前缀 bug）
          var html = (typeof window.dsMarkdown === 'function')
            ? window.dsMarkdown(report)
            : '<pre style="white-space:pre-wrap;">' + report.replace(/</g, '&lt;') + '</pre>';
          container.innerHTML = html;
          window._riskLastReportText = report;
          container.scrollTop = 0;

          // 无本地检查信息时提示横幅
          if (noIssueData) {
            var warn = document.createElement('div');
            warn.style.cssText = 'padding:8px 12px;background:#fffbeb;border:1px solid #fde68a;color:#92400e;border-radius:8px;font-size:0.8rem;margin-bottom:10px;';
            warn.textContent = '⚠️ 本地暂无检查信息数据，本次分析缺乏实际数据支撑，结论仅供参考。';
            container.insertBefore(warn, container.firstChild);
          }

          // 操作按钮栏：复制 / 下载 / 🔊朗读 / 🔄重生成
          var bar = document.createElement('div');
          bar.style.cssText = 'display:flex;gap:8px;flex-wrap:wrap;margin-top:14px;padding-top:10px;border-top:1px solid #e2e8f0;';
          bar.appendChild(_riskBtn('📋 复制', '#64748b', function(){ riskCopyReport(report); }));
          bar.appendChild(_riskBtn('📥 下载', 'var(--primary)', function(){ riskDownloadReport(report); }));
          if (typeof window.speechSynthesis !== 'undefined') {
            bar.appendChild(_riskBtn('🔊 朗读', '#64748b', function(){ riskSpeak(this); }));
          }
          bar.appendChild(_riskBtn('🔄 重生成', 'var(--primary)', function(){ window.runRiskAnalysis(false); }));
          container.appendChild(bar);

          // 保存配置，并将报告存入智能写作资料库（追问时更新同一条记录，避免堆积）
          saveRiskConfig();
          saveRiskReportToWriter(null, report, !!followUp);

          if (refineArea) {
            refineArea.style.display = 'flex';
            refineArea.style.flexDirection = 'column';
          }
        } catch(e) {
          var _errMsg = e && e.message ? e.message : '分析失败';
          if (e && e.name === 'TimeoutError') {
            _errMsg = '请求超时（180s）：模型响应时间过长。请稍后重试，或检查网络/API 状态；也可缩短时间范围、减少数据量后重试。';
          } else if (_errMsg.indexOf('Failed to fetch') !== -1 || _errMsg.indexOf('NetworkError') !== -1) {
            _errMsg = '网络错误（CORS 跨域限制）：当前 API 端点不允许浏览器直接访问。建议切换为 DeepSeek 官方端点（https://api.deepseek.com/chat/completions）。';
          }
          container.innerHTML = '<div style="color:#dc2626;padding:20px;">❌ ' + _errMsg + '</div>';
        }
      };

      window.refineRiskAnalysis = function() {
        window.runRiskAnalysis(true);
      };

      async function _buildRiskDataSummary(dateStart, dateEnd, unitFilter) {
        var parts = [];
        var startDate = dateStart ? new Date(dateStart + 'T00:00:00') : null;
        var endDate = dateEnd ? new Date(dateEnd + 'T23:59:59') : null;
        var all = [];
        try {
          // 优先用 dbManager，失败则直接打开
          var db;
          try {
            db = await window.dbManager.getDB('RailwayIssueDB_v2');
          } catch(e) {
            console.warn('[风险] dbManager 失败，尝试直接打开:', e.message);
            db = await new Promise(function(res, rej) {
              var r = indexedDB.open('RailwayIssueDB_v2', 2);
              r.onerror = function(){ rej(r.error); };
              r.onsuccess = function(){ res(r.result); };
            });
          }
          all = await new Promise(function(res) {
            var tx = db.transaction('issues','readonly');
            var s = tx.objectStore('issues');
            s.getAll().onsuccess = function(e) { res(e.target.result || []); };
          });
          // 非 dbManager 连接用完关闭
          if (!window.dbManager || typeof window.dbManager.getDB !== 'function') {
            try { db.close(); } catch(e) {}
          }
          if (all.length) {
            var filtered = all;
            if (startDate) {
              filtered = filtered.filter(function(d) {
                try { return new Date(d.datetime||'') >= startDate; } catch(e) { return false; }
              });
            }
            if (endDate) {
              filtered = filtered.filter(function(d) {
                try { return new Date(d.datetime||'') <= endDate; } catch(e) { return false; }
              });
            }
            if (unitFilter) {
              filtered = filtered.filter(function(d) {
                return (d.unit||'').indexOf(unitFilter) !== -1 || (d.department||'').indexOf(unitFilter) !== -1;
              });
            }
            var dateLabel = [dateStart ? '从'+dateStart : '', dateEnd ? '至'+dateEnd : ''].filter(Boolean).join(' ') || '全部时间';
            var cats = {}; filtered.forEach(function(d){ cats[d.category]=(cats[d.category]||0)+1; });
            var nats = {}; filtered.forEach(function(d){ nats[d['性质']]=(nats[d['性质']]||0)+1; });
            var units = {}; filtered.forEach(function(d){ if(d.unit) units[d.unit]=(units[d.unit]||0)+1; });
            parts.push('【检查信息】总计'+all.length+'条, 本次筛选'+filtered.length+'条('+dateLabel+(unitFilter?'/单位:'+unitFilter:'')+')');
            parts.push('类别TOP5: '+Object.entries(cats).sort(function(a,b){return b[1]-a[1]}).slice(0,5).map(function(e){return e[0]+'('+e[1]+')'}).join(', '));
            parts.push('性质分布: '+Object.entries(nats).sort(function(a,b){return b[1]-a[1]}).slice(0,5).map(function(e){return e[0]+'('+e[1]+')'}).join(', '));
            if (Object.keys(units).length > 0) parts.push('涉及单位: '+Object.entries(units).sort(function(a,b){return b[1]-a[1]}).slice(0,10).map(function(e){return e[0]+'('+e[1]+')'}).join(', '));
            // 按类别归类问题，每个类别列举几方面典型问题
            var categoryGroups = {};
            filtered.forEach(function(d) {
              var cat = d.category || '其他';
              if (!categoryGroups[cat]) categoryGroups[cat] = [];
              var text = (d.content||'').trim();
              if (text && text.length >= 5) categoryGroups[cat].push(text);
            });
            parts.push('\n【问题分类归集】');
            Object.keys(categoryGroups).sort(function(a,b){return categoryGroups[b].length-categoryGroups[a].length;}).forEach(function(cat) {
              var items = categoryGroups[cat];
              parts.push('\n■ ' + cat + '（共' + items.length + '条）：');
              // 去重归类：按前15个字符归类
              var typGroups = {};
              items.forEach(function(t) {
                var key = t.slice(0, 15);
                if (!typGroups[key]) typGroups[key] = { count: 0, samples: [] };
                typGroups[key].count++;
                if (typGroups[key].samples.length < 2) typGroups[key].samples.push(t.length > 80 ? t.slice(0, 80) + '…' : t);
              });
              var topTypes = Object.entries(typGroups).sort(function(a,b){return b[1].count-a[1].count;}).slice(0, 5);
              topTypes.forEach(function(entry, i) {
                parts.push('  ' + (i+1) + '. 此类问题出现' + entry[1].count + '次，例如：' + entry[1].samples[0]);
              });
            });
            parts.push('\n请先对以上各类问题分别分析症结，再进行综合风险研判。');
          }
        } catch(e) { parts.push('【检查信息】读取失败'); console.error('风险研判: 检查信息读取异常', e); }

        // 读取检查手册数据供 AI 参考
        try {
          var hbData = typeof window.getHandbookData === 'function' ? window.getHandbookData() : [];
          if (hbData.length) {
            var hbFocus = (riskFocus || '').trim();
            // Y2：若用户填写了研判重点，优先筛选与重点相关的手册条目并展示实质内容，
            // 而非仅展示前 10 条目录（避免手册内容被浪费）
            var hbSampled;
            if (hbFocus) {
              var hbRel = hbData.filter(function(r) {
                var t = [r.chapter, r.section, r.item, r.subitem, r.content, r.title].filter(Boolean).join(' ');
                return t.indexOf(hbFocus) !== -1;
              });
              hbSampled = hbRel.length ? hbRel : hbData.slice(0, 10);
            } else {
              hbSampled = hbData.length > 10 ? hbData.slice(0, 10) : hbData;
            }
            parts.push('【检查手册】总计'+hbData.length+'条，' + (hbFocus ? ('与重点「'+hbFocus+'」相关 '+hbSampled.length+' 条') : '展示前'+hbSampled.length+'条') + '：');
            hbSampled.forEach(function(r, i) {
              var path = [r.chapter, r.section, r.item, r.subitem].filter(Boolean).join(' > ');
              var c = (r.content || '').replace(/\s+/g, ' ').trim();
              var cSnippet = c.length > 150 ? c.slice(0, 150) + '…' : c;
              parts.push((i+1)+'. ['+path+']' + (cSnippet ? ' ' + cSnippet : ''));
            });
          }
        } catch(e) {}

        // ---------- 读取规章制度库中的事故专业案例（按专业归类） ----------
        try {
          var riskFocus = (document.getElementById('risk-focus') ? document.getElementById('risk-focus').value : '') || '';
          var ruleDb;
          try { ruleDb = await window.dbManager.getDB('RailwayRuleDB'); }
          catch(e) { ruleDb = await new Promise(function(res, rej) { var r = indexedDB.open('RailwayRuleDB', 3); r.onerror = function(){ rej(r.error); }; r.onsuccess = function(){ res(r.result); }; }); }
          var allRules = await new Promise(function(res) {
            var tx = ruleDb.transaction('ruleCollection', 'readonly');
            var s = tx.objectStore('ruleCollection');
            s.getAll().onsuccess = function(e){ res(e.target.result || []); };
          });
          if (!window.dbManager || typeof window.dbManager.getDB !== 'function') { try { ruleDb.close(); } catch(e){} }
          if (allRules.length) {
            var caseKw = /事故|案例|事件|通报|险情|故障|险性/;
            var matched = allRules.filter(function(r){
              return caseKw.test((r.title || '') + '\n' + (r.content || ''));
            });
            if (matched.length) {
              var rf = (riskFocus || '').trim();
              matched.sort(function(a, b){
                var sa = ((a.title||'')+'\n'+(a.content||'')).indexOf(rf) >= 0 ? 1 : 0;
                var sb = ((b.title||'')+'\n'+(b.content||'')).indexOf(rf) >= 0 ? 1 : 0;
                return sb - sa;
              });
              var topCases = matched.slice(0, 10);
              parts.push('\n【事故专业案例（来自规章制度库，按专业归类）】共匹配 ' + matched.length + ' 条，展示前 ' + topCases.length + ' 条：');
              var byTrade = {};
              topCases.forEach(function(r){ var tr = r.trade || '通用'; (byTrade[tr] = byTrade[tr] || []).push(r); });
              Object.keys(byTrade).forEach(function(tr){
                parts.push('\n▪ 专业：' + tr);
                byTrade[tr].forEach(function(r){
                  var c = (r.content || '').replace(/\s+/g, ' ').trim();
                  var snippet = c.length > 200 ? c.slice(0, 200) + '…' : c;
                  parts.push('  - 《' + (r.title || '未命名') + '》' + (snippet ? '：' + snippet : ''));
                });
              });
            } else {
              parts.push('\n【事故专业案例】规章制度库中未匹配到事故/案例类资料（可导入事故通报、事故案例后使用）。');
            }
          }
        } catch(e) { parts.push('\n【事故专业案例】读取失败'); console.error('风险研判: 规章库读取异常', e); }

        return parts.join('\n');
      }

      // ---------- 9. 增强 dsSendMsg（角色提示词 + 记忆）----------
      window.ROLE_PROMPTS = ROLE_PROMPTS;
      window._originalSendMsg = window.dsSendMsg;

      // 角色注入和长期记忆已内置到 dsSendMsg 中，此处保留暴露 ROLE_PROMPTS
      window.dsSendMsg._roleInjectionEnabled = true;

      // ---------- 10. 反馈收集 ----------
      function addFeedbackButtons(messageDiv, assistantContent) {
        var fbDiv = document.createElement('div');
        fbDiv.className = 'ds-feedback-bar';
        fbDiv.style.cssText = 'display:flex; gap:8px; justify-content:flex-end; margin-top:6px; flex-wrap:wrap;';
        fbDiv.innerHTML = '<button class="feedback-copy" style="background:none; border:1px solid #d1d5db; border-radius:14px; padding:3px 10px; font-size:0.75rem; cursor:pointer; color:#6b7280; transition:all 0.15s;" onmouseover="this.style.borderColor=\'#64748b\';this.style.color=\'#64748b\'" onmouseout="this.style.borderColor=\'#d1d5db\';this.style.color=\'#6b7280\'" title="复制本条回复">📋 复制</button>' +
                          '<button class="feedback-download" style="background:none; border:1px solid #d1d5db; border-radius:14px; padding:3px 10px; font-size:0.75rem; cursor:pointer; color:#6b7280; transition:all 0.15s;" onmouseover="this.style.borderColor=\'var(--primary)\';this.style.color=\'var(--primary)\'" onmouseout="this.style.borderColor=\'#d1d5db\';this.style.color=\'#6b7280\'" title="下载本条回复">📥 下载</button>' +
                          '<button class="feedback-good" style="background:none; border:1px solid #d1d5db; border-radius:14px; padding:3px 10px; font-size:0.75rem; cursor:pointer; color:#6b7280; transition:all 0.15s;" onmouseover="this.style.borderColor=\'var(--success)\';this.style.color=\'var(--success)\'" onmouseout="this.style.borderColor=\'#d1d5db\';this.style.color=\'#6b7280\'">👍 有用</button>' +
                          '<button class="feedback-bad" style="background:none; border:1px solid #d1d5db; border-radius:14px; padding:3px 10px; font-size:0.75rem; cursor:pointer; color:#6b7280; transition:all 0.15s;" onmouseover="this.style.borderColor=\'var(--accent)\';this.style.color=\'var(--accent)\'" onmouseout="this.style.borderColor=\'#d1d5db\';this.style.color=\'#6b7280\'">👎 无用</button>' +
                          '<button class="feedback-regen" onclick="window.dsRegenerate()" style="background:none; border:1px solid #d1d5db; border-radius:14px; padding:3px 10px; font-size:0.75rem; cursor:pointer; color:#6b7280; transition:all 0.15s;" onmouseover="this.style.borderColor=\'var(--primary)\';this.style.color=\'var(--primary)\'" onmouseout="this.style.borderColor=\'#d1d5db\';this.style.color=\'#6b7280\'" title="重新生成本条回复">🔄 重生成</button>';
        // 语音朗读按钮（仅支持 Web Speech API 的浏览器显示）
        if (typeof window.speechSynthesis !== 'undefined') {
          var readBtn = document.createElement('button');
          readBtn.textContent = '🔊 朗读';
          readBtn.style.cssText = 'background:none;border:1px solid #d1d5db;border-radius:14px;padding:3px 10px;font-size:0.75rem;cursor:pointer;color:#6b7280;transition:all 0.15s;';
          readBtn.onmouseover = function(){ this.style.borderColor='var(--warning)'; this.style.color='var(--warning)'; };
          readBtn.onmouseout = function(){ this.style.borderColor='#d1d5db'; this.style.color='#6b7280'; };
          readBtn.onclick = function(){ dsSpeak(this); };
          fbDiv.appendChild(readBtn);
        }
        messageDiv.appendChild(fbDiv);
        // 复制本消息
        fbDiv.querySelector('.feedback-copy').onclick = function(){
          var txt = assistantContent;
          if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(txt).then(function(){
              if (typeof window.Toast !== 'undefined') window.Toast.success('已复制到剪贴板');
            }).catch(function(){ fallbackCopy(txt); });
          } else { fallbackCopy(txt); }
        };
        function fallbackCopy(txt) {
          var ta = document.createElement('textarea');
          ta.value = txt; ta.style.position = 'fixed'; ta.style.left = '-9999px';
          document.body.appendChild(ta); ta.select();
          document.execCommand('copy'); document.body.removeChild(ta);
          if (typeof window.Toast !== 'undefined') window.Toast.success('已复制到剪贴板');
        }
        // 下载本消息（导出为 Markdown，保留格式）
        fbDiv.querySelector('.feedback-download').onclick = function(){
          var blob = new Blob([assistantContent], {type: 'text/markdown;charset=utf-8'});
          window.downloadBlob(blob, '智能对话_' + new Date().toISOString().slice(0,10) + '.md');
        };
        fbDiv.querySelector('.feedback-good').onclick = function(){ saveFeedback('good', assistantContent); };
        fbDiv.querySelector('.feedback-bad').onclick = function(){ saveFeedback('bad', assistantContent); };
      }
      window._addFeedbackButtons = addFeedbackButtons;

      // ========== 语音朗读 ==========
      window.dsSpeak = function(btn) {
        if (typeof window.speechSynthesis === 'undefined') {
          // 鸿蒙/华为浏览器等无 Web Speech API：静默 return 会让用户误以为失效，改为友好提示。
          // 仅首次提示一次，避免反复打扰；按钮文字保持原样。
          if (!window.__dsSpeakUnsupportedWarned) {
            window.__dsSpeakUnsupportedWarned = true;
            try {
              var t = document.createElement('div');
              t.textContent = '当前浏览器（如鸿蒙/华为浏览器）不支持语音朗读';
              t.style.cssText = 'position:fixed;left:50%;bottom:calc(20px + env(safe-area-inset-bottom,0px));transform:translateX(-50%);background:rgba(15,23,42,.92);color:#fff;padding:10px 16px;border-radius:10px;font-size:.85rem;z-index:99999;max-width:90vw;text-align:center;box-shadow:0 4px 20px rgba(0,0,0,.25);';
              document.body.appendChild(t);
              setTimeout(function(){ t.style.opacity='0'; t.style.transition='opacity .3s'; setTimeout(function(){ if(t.parentNode) t.parentNode.removeChild(t); }, 320); }, 2600);
            } catch (_) {}
          }
          return;
        }
        if (window.speechSynthesis.speaking) {
          window.speechSynthesis.cancel();
          btn.textContent = '🔊 朗读';
          return;
        }
        var bubble = btn.closest('.ds-bubble-assistant') || (btn.parentElement && btn.parentElement.closest('.ds-bubble-assistant'));
        if (!bubble) bubble = btn.parentElement;
        if (!bubble) return;
        // 仅朗读「回答正文」：克隆气泡并剔除底部操作按钮栏（📋复制/📥下载/👍有用/👎无用/🔄重生成/🔊朗读），避免把按钮文字也读出来
        var clone = bubble.cloneNode(true);
        var bar = clone.querySelector('.ds-feedback-bar');
        if (bar && bar.parentNode) bar.parentNode.removeChild(bar);
        var text = (clone.innerText || clone.textContent || '').replace(/\s+/g, ' ').trim();
        if (!text) return;
        var utter = new SpeechSynthesisUtterance(text);
        utter.lang = 'zh-CN'; utter.rate = 1.0;
        try {
          var voices = window.speechSynthesis.getVoices();
          var zh = (voices || []).filter(function(v){ return /zh|cmn|Chinese|中文|普通话/i.test((v.lang||'') + (v.name||'')); })[0];
          if (zh) utter.voice = zh;
        } catch (_) {}
        utter.onend = function(){ btn.textContent = '🔊 朗读'; };
        utter.onerror = function(){ btn.textContent = '🔊 朗读'; };
        btn.textContent = '⏹ 停止';
        window.speechSynthesis.speak(utter);
      };

      // ========== 输入框自适应高度 + 发送按钮启用态（DeepSeek：空输入时发送按钮置灰）==========
      (function initInputHeightSync() {
        var ta = document.getElementById('ds-user-input');
        if (!ta) return;
        var sendBtn = document.getElementById('ds-send-btn');
        function syncSendState() {
          if (!sendBtn) return;
          // 有文字 或 有附件 → 激活；否则置灰（DeepSeek 行为）
          var hasText = !!(ta.value && ta.value.trim());
          var hasAttach = !!((window._dsAttachments || []).filter(Boolean).length);
          if (hasText || hasAttach) sendBtn.classList.add('on');
          else sendBtn.classList.remove('on');
        }
        function sync() {
          if (typeof autoResize === 'function') autoResize(ta);
          syncSendState();
        }
        window.dsSyncInputHeight = sync;
        window.dsSyncSendState = syncSendState;
        ta.addEventListener('input', syncSendState);
        sync();
        // 面板从隐藏变为可见 / 窗口缩放时重新计算
        window.addEventListener('resize', sync);
      })();

      // ========== 联网搜索开关（输入栏按钮：带文字说明菜单，与「模型管理」面板复选框共用 ds_web_search）==========
      (function initWebSearchToggle() {
        var btn = document.getElementById('ds-websearch-btn');
        var menu = document.getElementById('ds-websearch-menu');
        if (!btn) return;
        function syncMenuActive() {
          if (!menu) return;
          var on = localStorage.getItem('ds_web_search') === '1';
          menu.querySelectorAll('.ds-dropdown-item').forEach(function(it) {
            it.classList.toggle('active', (it.getAttribute('data-ws') === '1') === on);
          });
        }
        // 同步按钮视觉与提示；供模型管理面板保存后回调，保持两处 UI 一致
        window.dsSyncWebSearchBtn = function() {
          var on = localStorage.getItem('ds_web_search') === '1';
          var b = document.getElementById('ds-websearch-btn');
          if (!b) return;
          if (on) b.classList.add('ds-ws-on'); else b.classList.remove('ds-ws-on');
          b.title = on
            ? '联网搜索：已开启（点击查看选项）'
            : '联网搜索：已关闭（点击查看选项）';
          syncMenuActive();
        };
        function closeMenu() { if (menu) menu.classList.remove('open'); }
        function openMenu() { if (menu) menu.classList.add('open'); }
        function setWs(on) {
          localStorage.setItem('ds_web_search', on ? '1' : '0');
          window.dsSyncWebSearchBtn();
          // 同步「模型管理」面板里的复选框（若正打开）
          var chk = document.getElementById('ds-pe-websearch');
          if (chk) chk.checked = on;
          if (window.Toast && window.Toast.success)
            window.Toast.success(on ? '🌐 已开启联网搜索' : '已关闭联网搜索（实时问题仍自动联网）');
          closeMenu();
        }
        // 供模型管理面板复选框变更时调用（保持两处一致）
        window.dsToggleWebSearch = function() {
          var on = localStorage.getItem('ds_web_search') === '1';
          setWs(!on);
        };
        // 点击按钮：先关闭其它已展开的菜单，再 toggle 自身（与角色/模型/关联数据一致，保证一次只开一个）
        btn.addEventListener('click', function(e) {
          e.stopPropagation();
          var willOpen = !(menu && menu.classList.contains('open'));
          document.querySelectorAll('.ds-dropdown-menu.open').forEach(function(m){ if (m !== menu) m.classList.remove('open'); });
          if (menu) menu.classList.toggle('open', willOpen);
        });
        // 菜单项：选择开启 / 关闭
        if (menu) {
          menu.querySelectorAll('.ds-dropdown-item').forEach(function(it) {
            it.addEventListener('click', function(e) {
              e.stopPropagation();
              setWs(it.getAttribute('data-ws') === '1');
            });
          });
        }
        // 点击页面其它位置收起菜单
        document.addEventListener('click', function() { closeMenu(); });
        window.dsSyncWebSearchBtn();
      })();

      function saveFeedback(type, content) {
        var logs = JSON.parse(localStorage.getItem('feedback_logs') || '[]');
        logs.push({ type: type, content: content.slice(0,200), timestamp: Date.now() });
        if (logs.length > 200) logs = logs.slice(-200);
        localStorage.setItem('feedback_logs', JSON.stringify(logs));
        if (typeof window.Toast !== 'undefined') window.Toast.success('感谢反馈！');
        else alert('感谢反馈！');
      }

      function observeAssistantBubbles() {
        var chatBox = document.getElementById('ds-chat-box');
        if (!chatBox) return;
        var observer = new MutationObserver(function(mutations) {
          mutations.forEach(function(m) {
            if (m.addedNodes.length) {
              m.addedNodes.forEach(function(node) {
                if (node.nodeType === 1 && node.classList && node.classList.contains('ds-row-assistant')) {
                  var bubble = node.querySelector('.ds-bubble-assistant');
                  if (bubble && !bubble.querySelector('.feedback-good')) {
                    addFeedbackButtons(bubble, bubble.innerText);
                  }
                }
              });
            }
          });
        });
        observer.observe(chatBox, { childList: true, subtree: true });
      }

      // ---------- 12. 统计面板 ----------
      function updateStatsPanel() {
        var convCount = localStorage.getItem('conv_count') || 0;
        var feedbacks = JSON.parse(localStorage.getItem('feedback_logs') || '[]');
        var panel = document.getElementById('statsPanel');
        if (panel) {
          panel.innerHTML = '<div>对话次数: ' + convCount + '</div><div>反馈收集: ' + feedbacks.length + '条</div><div>记忆条目: ' + userMemories.length + '</div>';
        }
      }
      var statsBtn = document.getElementById('statsBtn');
      if (statsBtn) {
        statsBtn.onclick = function(e) {
          e.stopPropagation();
          var panel = document.getElementById('statsPanel');
          if (panel) {
            updateStatsPanel();
            panel.style.display = panel.style.display === 'none' ? 'block' : 'none';
          }
        };
        document.addEventListener('click', function() {
          var panel = document.getElementById('statsPanel');
          if (panel) panel.style.display = 'none';
        });
      }

      // ---------- 13. 初始化 ----------
      loadMemories();
      loadRiskConfig(); // 恢复上次风险研判配置和报告
      // 绑定风险研判筛选条件实时预览
      ['risk-date-start','risk-date-end','risk-unit'].forEach(function(id) {
        var el = document.getElementById(id);
        if (el) { el.addEventListener('change', updateRiskPreview); el.addEventListener('input', updateRiskPreview); }
      });
      var memoryCheck = document.getElementById('memoryEnable');
      if (memoryCheck) {
        // 恢复持久化的开关状态（默认开启）
        var savedMem = localStorage.getItem('memory_enabled');
        if (savedMem !== null) {
          memoryCheck.checked = (savedMem === '1');
        }
        memoryEnabled = memoryCheck.checked;
        memoryCheck.addEventListener('change', function(e){
          memoryEnabled = e.target.checked;
          try { localStorage.setItem('memory_enabled', e.target.checked ? '1' : '0'); } catch(err){}
        });
      }
      // 角色切换时立即更新状态栏（不再需要切模块才能看到）
      var roleSelect = document.getElementById('expertRole');
      if (roleSelect && typeof updateModeStatus === 'function') {
        roleSelect.addEventListener('change', updateModeStatus);
      }
      observeAssistantBubbles();

      // ========== 智能体 Agent 发送消息 ==========
      var _agentRunning = false;
      window.dsAgentSend = async function() {
        if (_agentRunning) return;
        var input = document.getElementById('ds-agent-input');
        var historyEl = document.getElementById('ds-agent-history');
        if (!input || !historyEl) return;
        var msg = input.value.trim();
        if (!msg) return;
        // A1-P3：/goal 系列命令本地处理，不调用 LLM
        if (typeof window.handleAgentCommand === 'function') {
          var _cmdResp = window.handleAgentCommand(msg);
          if (_cmdResp !== null && _cmdResp !== undefined) {
            historyEl.innerHTML += '<div style="margin-bottom:8px;color:var(--primary);font-weight:600;">🧑 ' + dsEsc(msg) + '</div>';
            historyEl.innerHTML += '<div style="margin-bottom:10px;padding:10px 12px;background:#f0fdf4;border-radius:8px;line-height:1.7;font-size:0.9rem;white-space:pre-wrap;">' + dsEsc(_cmdResp) + '</div>';
            input.value = '';
            historyEl.scrollTop = historyEl.scrollHeight;
            return;
          }
        }
        if (typeof window._agentRun !== 'function') { historyEl.innerHTML += '<div style="color:#dc2626">⚠️ 智能体模块未加载</div>'; return; }

        _agentRunning = true;
        input.value = '';
        input.disabled = true;
        var stopBtn = document.getElementById('ds-agent-stop');
        var runBtn = document.getElementById('ds-agent-run');
        if (stopBtn) stopBtn.style.display = '';
        if (runBtn) runBtn.style.display = 'none';
        historyEl.innerHTML += '<div style="margin-bottom:8px;color:var(--primary);font-weight:600;">🧑 ' + dsEsc(msg) + '</div>';
        // 加载提示（LLM 请求耗时较长时给用户反馈）
        var loadingId = 'ds-loading-' + Date.now();
        historyEl.innerHTML += '<div id="' + loadingId + '" style="color:#6b7280;font-size:0.85rem;margin:4px 0;">⏳ 思考中…</div>';

        try {
          // 【视觉模型接入】收集当前附件中的图片，传给智能体（纯新增；无图时传空数组，向后兼容）
          var _agentImgs = [];
          try {
            var _atts = (window._dsAttachments || []).filter(Boolean);
            _agentImgs = _atts.filter(function(a) { return a && a.isImage && a.dataUrl; }).map(function(a) { return a.dataUrl; });
          } catch (_e) { _agentImgs = []; }
          var result = await window._agentRun(msg, _agentImgs);
          // 移除加载提示
          var ld = document.getElementById(loadingId);
          if (ld) ld.remove();
          if (result && result.messages) {
            result.messages.forEach(function(m) {
              if (m.role === 'agent-plan') {
                historyEl.innerHTML += '<div style="margin-bottom:6px;background:#fffbeb;border-left:3px solid #f59e0b;color:#b45309;border-radius:6px;padding:5px 10px;font-size:0.82rem;line-height:1.5;">' + dsEsc(m.content) + '</div>';
              } else if (m.role === 'agent-tool') {
                if (m.toolMeta) {
                  // A2 透明卡片：用途 / 证据样例
                  var _ev = m.toolMeta.evidence ? '<div style="color:#047857;margin-top:2px;white-space:pre-wrap;">证据：' + dsEsc(m.toolMeta.evidence) + '</div>' : '';
                  historyEl.innerHTML += '<div style="margin-bottom:6px;background:#f0fdf4;border-left:3px solid #10b981;color:#047857;border-radius:6px;padding:6px 10px;font-size:0.82rem;line-height:1.5;">'
                    + '<div style="font-weight:600;">🔧 ' + dsEsc(String(m.content).replace(/^🔧\s*/, '')) + '</div>'
                    + '<div style="color:#065f46;margin-top:2px;">用途：' + dsEsc(m.toolMeta.purpose || '') + '</div>'
                    + _ev + '</div>';
                } else {
                  historyEl.innerHTML += '<div style="margin-bottom:6px;background:#f0fdf4;border-left:3px solid #10b981;color:#047857;border-radius:6px;padding:5px 10px;font-size:0.82rem;line-height:1.5;">' + dsEsc(m.content) + '</div>';
                }
              } else if (m.role === 'assistant') {
                // B#8: 最终回答渲染 Markdown，与普通对话体验一致
                historyEl.innerHTML += '<div style="margin-bottom:10px;padding:10px 12px;background:#f0fdf4;border-radius:8px;line-height:1.7;font-size:0.9rem;">' + dsMarkdown(m.content) + '</div>';
              }
            });
          }
        } catch(e) {
          // 移除加载提示
          var ld = document.getElementById(loadingId);
          if (ld) ld.remove();
          historyEl.innerHTML += '<div style="color:#dc2626">❌ 执行错误: ' + dsEsc(e.message || '未知') + '</div>';
        }

        _agentRunning = false;
        input.disabled = false;
        input.focus();
        if (stopBtn) stopBtn.style.display = 'none';
        if (runBtn) runBtn.style.display = '';
        historyEl.scrollTop = historyEl.scrollHeight;
      };

      // B#7: 停止智能体（中断在途请求 + 终止后续循环）
      window.dsAgentStop = function() {
        _agentRunning = false;
        if (window.__agentAbort && typeof window.__agentAbort.abort === 'function') {
          try { window.__agentAbort.abort(); } catch (_) {}
        }
        var stopBtn = document.getElementById('ds-agent-stop');
        var runBtn = document.getElementById('ds-agent-run');
        if (stopBtn) stopBtn.style.display = 'none';
        if (runBtn) runBtn.style.display = '';
        var historyEl = document.getElementById('ds-agent-history');
        if (historyEl) historyEl.innerHTML += '<div style="color:#dc2626;font-size:0.85rem;margin:6px 0;">⏹️ 已手动停止</div>';
      };

      // 供 Part A dsSwitchSub 调用：切换子模块时重置智能体状态（不含 UI 提示）
      window.clearAgentRunning = function() {
        _agentRunning = false;
        if (window.__agentAbort && typeof window.__agentAbort.abort === 'function') {
          try { window.__agentAbort.abort(); } catch (_) {}
        }
        var stopBtn = document.getElementById('ds-agent-stop');
        var runBtn = document.getElementById('ds-agent-run');
        if (stopBtn) stopBtn.style.display = 'none';
        if (runBtn) runBtn.style.display = '';
        // 切换子模块时收起历史面板
        var panel = document.getElementById('ds-agent-history-panel');
        if (panel) { panel.style.display = 'none'; panel.dataset.open = '0'; }
      };

      // A#2: 查看历史任务记录（解决"只写不读"）
      window.dsAgentShowHistory = async function() {
        var panel = document.getElementById('ds-agent-history-panel');
        if (!panel) return;
        // toggle：已打开则关闭，不重新渲染（修复「关闭不了」）
        if (panel.style.display !== 'none' && panel.dataset.open === '1') {
          panel.style.display = 'none';
          panel.dataset.open = '0';
          return;
        }
        panel.style.display = 'block';
        panel.dataset.open = '1';
        panel.innerHTML = '<div style="color:#64748b;font-size:0.85rem;padding:8px;">⏳ 加载中…</div>';
        try {
          var tasks = await window.getAgentTasks(20);
          if (!tasks || !tasks.length) {
            panel.innerHTML = '<div style="color:#64748b;font-size:0.85rem;padding:8px;">暂无历史任务记录</div>';
            return;
          }
          var html = '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">'
            + '<span style="font-weight:600;font-size:0.85rem;">📜 历史任务（共 ' + tasks.length + ' 条）</span>'
            + '<button onclick="dsAgentClearHistory()" style="font-size:0.74rem;border:none;background:#fee2e2;color:#dc2626;border-radius:8px;padding:4px 10px;cursor:pointer;">🗑 清空</button>'
            + '</div>';
          tasks.forEach(function(t) {
            var steps = (t.steps || []).map(function(s) { return s.tool + (s.ok ? ' ✅' : ' ❌'); }).join(' · ');
            var time = (t.timestamp || '').replace('T', ' ').slice(0, 16);
            html += '<div style="border:1px solid #e2e8f0;border-radius:8px;padding:8px 10px;margin-bottom:8px;">'
              + '<div style="font-weight:600;font-size:0.85rem;color:#0f172a;">' + dsEsc(t.userIntent || '(无目标)') + '</div>'
              + '<div style="font-size:0.78rem;color:#64748b;margin:2px 0;">' + dsEsc(time) + '</div>'
              + '<div style="font-size:0.8rem;color:#059669;">' + dsEsc(steps) + '</div>'
              + '</div>';
          });
          panel.innerHTML = html;
        } catch(e) {
          panel.innerHTML = '<div style="color:#dc2626;font-size:0.85rem;">加载历史失败：' + dsEsc(e.message || '') + '</div>';
        }
      };

      // A#2: 清空历史任务记录
      window.dsAgentClearHistory = async function() {
        if (!confirm('⚠️ 将清空所有智能体历史任务记录，确定？')) return;
        try {
          var db = await new Promise(function(res, rej) {
            var r = indexedDB.open('AgentTaskDB', 1);
            r.onsuccess = function() { res(r.result); };
            r.onerror = function() { rej(r.error); };
          });
          await new Promise(function(res, rej) {
            var tx = db.transaction('agent_tasks', 'readwrite');
            tx.objectStore('agent_tasks').clear();
            tx.oncomplete = function() { res(); };
            tx.onerror = function() { rej(tx.error); };
          });
          var panel = document.getElementById('ds-agent-history-panel');
          if (panel) panel.innerHTML = '<div style="color:#64748b;font-size:0.85rem;padding:8px;">历史已清空</div>';
        } catch(e) { alert('清空失败：' + (e.message || '')); }
      };

      console.log('%c✅ 智能助手已启动 | 角色切换 · 长期记忆 · 反馈收集 · 智能体', 'color:#059669;font-weight:bold;');
    })();
