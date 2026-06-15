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
            const DS_DEFAULT_MODEL   = 'deepseek-chat';
            const DS_MAX_CTX_CHARS   = 6000;  // 单类别最多携带的字符数
            const DS_PLACEHOLDER_KEY = 'YOUR_API_KEY_HERE';

            let dsHistory = [];   // [{role:'user'|'assistant', content:'...'}]
            // 暴露给外部（反馈按钮下载对话用）
            Object.defineProperty(window, 'dsHistory', { get: function(){ return dsHistory; }, configurable: true });
            let dsApiKey  = '';
            let dsApiUrl  = DS_DEFAULT_API_URL;
            let dsModel   = DS_DEFAULT_MODEL;
            let dsStreaming = false;
            let dsConversations = []; // 所有对话列表 [{id, title, messages, timestamp, pinned}]
            let dsCurrentConvId = null; // 当前对话ID

            // 全局候选映射表，用于"本地组装对规结论"（三阶段强约束）
            let _globalCandidatesMap = {};
            let _acAbortController = null; // 用于停止AI对规生成

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

            // ---- 初始化 ----
            function dsInit() {
                dsApiKey = localStorage.getItem(DS_API_KEY_STORAGE) || '';
                dsApiUrl = localStorage.getItem(DS_API_URL_STORAGE) || DS_DEFAULT_API_URL;
                dsModel  = localStorage.getItem(DS_MODEL_STORAGE) || DS_DEFAULT_MODEL;
                
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
                // 绑定 Ctrl+Enter
                document.getElementById('ds-user-input').addEventListener('keydown', function(e) {
                    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); dsSendMsg(); }
                });
                // 根据 API Key 状态切换豆包网页版/本地模块
                toggleDoubaoMode();
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
                } catch(e) {}
            }

            // 生成唯一ID
            function dsGenerateId() {
                return Date.now().toString(36) + Math.random().toString(36).substr(2);
            }

            // 获取对话标题（从第一条用户消息）
            function dsGetConvTitle(messages) {
                const firstUserMsg = messages.find(m => m.role === 'user');
                if (firstUserMsg) {
                    return firstUserMsg.content.slice(0, 25) + (firstUserMsg.content.length > 25 ? '...' : '');
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
                var btnCheck  = document.getElementById('ds-sub-btn-check');
                var btnChat   = document.getElementById('ds-sub-btn-chat');
                var btnWriter = document.getElementById('ds-sub-btn-writer');
                var btnRisk   = document.getElementById('ds-sub-btn-risk');
                var btnDoubao = document.getElementById('ds-sub-btn-doubao');
                var panelCheck  = document.getElementById('ds-sub-check');
                var panelChat   = document.getElementById('ds-sub-chat');
                var panelWriter = document.getElementById('ds-sub-writer');
                var panelRisk   = document.getElementById('ds-sub-risk');
                var panelDoubao = document.getElementById('ds-sub-doubao');
                if (!btnCheck || !btnChat || !panelCheck || !panelChat) return;

                // 重置所有按钮样式
                [btnCheck, btnChat, btnWriter, btnRisk, btnDoubao].forEach(function(b) {
                    if (!b) return;
                    b.style.background = '#f8fafc'; b.style.color = 'var(--text)'; b.style.borderColor = 'var(--border)';
                });
                [panelCheck, panelChat, panelWriter, panelRisk, panelDoubao].forEach(function(p) { if (p) p.style.display = 'none'; });

                _dsCurrentSub = tab;
                if (tab === 'check') {
                    btnCheck.style.background = '#3b82f6'; btnCheck.style.color = '#fff'; btnCheck.style.borderColor = '#3b82f6';
                    panelCheck.style.display = 'flex';
                    return;
                } else if (tab === 'writer') {
                    if (btnWriter) { btnWriter.style.background = '#3b82f6'; btnWriter.style.color = '#fff'; btnWriter.style.borderColor = '#3b82f6'; }
                    if (panelWriter) panelWriter.style.display = 'flex';
                    wrInit();
                    return;
                } else if (tab === 'risk') {
                    if (btnRisk) { btnRisk.style.background = '#3b82f6'; btnRisk.style.color = '#fff'; btnRisk.style.borderColor = '#3b82f6'; }
                    if (panelRisk) panelRisk.style.display = 'flex';
                    return;
                } else if (tab === 'doubao') {
                    if (btnDoubao) { btnDoubao.style.background = '#3b82f6'; btnDoubao.style.color = '#fff'; btnDoubao.style.borderColor = '#3b82f6'; }
                    if (panelDoubao) panelDoubao.style.display = 'flex';
                    return;
                } else {
                    // chat
                    btnChat.style.background = '#3b82f6'; btnChat.style.color = '#fff'; btnChat.style.borderColor = '#3b82f6';
                    panelChat.style.display = 'flex';
                    return;
                }
            };

            // 历史侧边栏抽屉开关
            let _dsSidebarOpen = false;
            window.dsToggleSidebar = function() {
                const sidebar = document.getElementById('ds-sidebar');
                const overlay = document.getElementById('ds-sidebar-overlay');
                const icon = document.getElementById('ds-sidebar-toggle-icon');
                const text = document.getElementById('ds-sidebar-toggle-text');
                if (!sidebar) return;
                _dsSidebarOpen = !_dsSidebarOpen;
                // 动态计算隐藏偏移量（适配手机端vw单位）
                const sidebarWidth = sidebar.offsetWidth || 260;
                if (_dsSidebarOpen) {
                    sidebar.style.left = '0';
                    if (overlay) overlay.style.display = 'block';
                    if (icon) icon.textContent = '✕';
                    if (text) text.textContent = '收起';
                } else {
                    sidebar.style.left = '-' + (sidebarWidth + 20) + 'px';
                    if (overlay) overlay.style.display = 'none';
                    if (icon) icon.textContent = '☰';
                    if (text) text.textContent = '📋 历史记录';
                }
            };

            // 渲染历史记录列表（DeepSeek风格紧凑布局）
            function dsRenderHistoryList() {
                const listEl = document.getElementById('ds-history-list');
                if (!listEl) return;
                
                if (dsConversations.length === 0) {
                    listEl.innerHTML = '<div style="text-align:center;color:var(--text-secondary);padding:16px 10px;font-size:0.82rem;">暂无历史记录</div>';
                    return;
                }
                
                let html = '';
                dsConversations.forEach(conv => {
                    const isActive = conv.id === dsCurrentConvId;
                    const dateStr = new Date(conv.timestamp).toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' });
                    
                    // DeepSeek风格：紧凑行，圆角背景，小间距
                    const bgColor = isActive ? 'var(--primary)' : 'transparent';
                    const textColor = isActive ? '#ffffff' : '#1e293b';
                    const dateColor = isActive ? 'rgba(255,255,255,0.7)' : '#94a3b8';
                    
                    html += '<div onclick="dsSwitchConv(\'' + conv.id + '\')" style="' +
                        'padding:7px 10px;border-radius:6px;cursor:pointer;' +
                        'background:' + bgColor + ';' +
                        'transition:background 0.15s;display:flex;align-items:center;gap:6px;' +
                        'margin-bottom:2px;' +
                        '" onmouseover="if(this.dataset.active!==\'1\'){this.style.background=\'#e0f2fe\';}" ' +
                        'onmouseout="if(this.dataset.active!==\'1\'){this.style.background=\'transparent\';}" ' +
                        'data-active="' + (isActive ? '1' : '0') + '">' +
                        '<span style="font-size:0.72rem;color:' + dateColor + ';flex-shrink:0;">' + dateStr + '</span>' +
                        '<span style="font-size:0.82rem;line-height:1.3;color:' + textColor + ';overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;min-width:0;font-weight:' + (isActive ? '500' : '400') + ';">' +
                        dsEsc(conv.title || '新对话') +
                        '</span>' +
                        '<div style="display:flex;gap:2px;flex-shrink:0;opacity:0;transition:opacity 0.15s;" ' +
                        'onmouseover="this.style.opacity=\'1\'" onmouseout="this.style.opacity=\'\'">' +
                        '<button onclick="dsTogglePin(\'' + conv.id + '\', event)" style="' +
                        'background:none;border:none;cursor:pointer;padding:2px;font-size:0.8rem;line-height:1;' +
                        'opacity:' + (conv.pinned ? '1' : '0.4') + ';' +
                        '" title="' + (conv.pinned ? '取消置顶' : '置顶') + '">' + (conv.pinned ? '📌' : '<span style="opacity:0.3">📌</span>') + '</button>' +
                        '<button onclick="dsDeleteConv(\'' + conv.id + '\', event)" style="' +
                        'background:none;border:none;cursor:pointer;padding:2px;font-size:0.8rem;color:var(--danger);opacity:0.5;' +
                        '" title="删除" onmouseover="this.style.opacity=\'1\'" onmouseout="this.style.opacity=\'0.5\'">🗑️</button>' +
                        '</div>' +
                        '</div>';
                });
                
                listEl.innerHTML = html;
            }

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
                var subTabs   = document.getElementById('ds-sub-tabs');
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

            function showApiConfigModal() {
                document.getElementById('modal-apiurl').value = dsApiUrl;
                document.getElementById('modal-model').value = dsModel;
                // 已有 Key 时用星号掩码显示，避免泄露
                var currentKey = dsApiKey || '';
                document.getElementById('modal-apikey').value = currentKey ? '****************' : '';
                document.getElementById('modal-apikey').type = 'password';
                document.getElementById('modal-apikey').placeholder = currentKey ? '已配置（如需修改请重新输入）' : 'sk-...';
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
                    'deepseek.com': 'deepseek-chat',
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

            async function saveApiConfigFromModal() {
                var url = document.getElementById('modal-apiurl').value.trim();
                var model = document.getElementById('modal-model').value.trim();
                var key = document.getElementById('modal-apikey').value.trim();
                // 星号掩码表示用户未修改，保留原 Key
                if (key === '****************') key = dsApiKey;
                if (!url) { alert('请输入 API 地址'); return; }
                if (!model) { alert('请输入模型名称'); return; }
                if (key) {
                    localStorage.setItem(DS_API_KEY_STORAGE, key);
                    dsApiKey = key;
                } else if (!dsApiKey) {
                    alert('请输入 API Key');
                    return;
                }
                dsApiUrl = url; dsModel = model;
                localStorage.setItem(DS_API_URL_STORAGE, url);
                localStorage.setItem(DS_MODEL_STORAGE, model);
                updateApiStatusBadge();
                document.getElementById('api-config-modal').style.display = 'none';
                toggleDoubaoMode();
            }

            function clearApiConfig() {
                dsApiKey = ''; dsApiUrl = DS_DEFAULT_API_URL; dsModel = DS_DEFAULT_MODEL;
                localStorage.removeItem(DS_API_KEY_STORAGE);
                localStorage.removeItem(DS_API_URL_STORAGE);
                localStorage.removeItem(DS_MODEL_STORAGE);
                document.getElementById('modal-apiurl').value = DS_DEFAULT_API_URL;
                document.getElementById('modal-model').value = DS_DEFAULT_MODEL;
                document.getElementById('modal-apikey').value = '';
                updateApiStatusBadge();
                document.getElementById('api-config-modal').style.display = 'none';
                if (typeof toggleDoubaoMode === 'function') toggleDoubaoMode();
            }

            function resetDefaultApiConfig() {
                document.getElementById('modal-apiurl').value = DS_DEFAULT_API_URL;
                document.getElementById('modal-model').value = DS_DEFAULT_MODEL;
            }

            function bindApiModalEvents() {
                var cfgBtn = document.getElementById('ds-api-config-btn');
                if (cfgBtn) cfgBtn.onclick = showApiConfigModal;
                var saveBtn = document.getElementById('modal-save-config');
                if (saveBtn) saveBtn.onclick = saveApiConfigFromModal;
                var clearBtn = document.getElementById('modal-clear-key');
                if (clearBtn) clearBtn.onclick = clearApiConfig;
                var resetBtn = document.getElementById('modal-reset-default');
                if (resetBtn) resetBtn.onclick = resetDefaultApiConfig;
                var quickBtn = document.getElementById('quick-config-btn');
                if (quickBtn) quickBtn.onclick = showApiConfigModal;
                // API 地址变更时自动建议模型名称
                var urlInput = document.getElementById('modal-apiurl');
                if (urlInput) urlInput.onchange = _autoDetectModel;
            }
            bindApiModalEvents();

            // ---- 数据源选择模块 ----
            var _sessionDataSource = null;
            function showDataSourceSelector() {
                return new Promise(function(resolve) {
                    if (_sessionDataSource && _sessionDataSource.remember) {
                        resolve(_sessionDataSource);
                        return;
                    }
                    var modal = document.getElementById('ds-datasource-modal');
                    if (!modal) { resolve({ rules: true, issue: true, handbook: false, wrAll: false, phone: false, diary: false }); return; }
                    var defCfg = _sessionDataSource || { rules: true, issue: true, handbook: false, wrAll: false, phone: false, diary: false, remember: false };
                    document.getElementById('ds-dialog-rules').checked = defCfg.rules;
                    document.getElementById('ds-dialog-issue').checked = defCfg.issue;
                    document.getElementById('ds-dialog-handbook').checked = defCfg.handbook;
                    document.getElementById('ds-dialog-wr-all').checked = defCfg.wrAll;
                    document.getElementById('ds-dialog-phone').checked = defCfg.phone;
                    document.getElementById('ds-dialog-diary').checked = defCfg.diary;
                    document.getElementById('ds-dialog-remember').checked = defCfg.remember;
                    modal.style.display = 'flex';
                    var confirmBtn = document.getElementById('ds-dialog-confirm');
                    var reject = null;
                    confirmBtn._reject = function() { if (reject) { reject(); reject = null; } };
                    var handleConfirm = function() {
                        var config = {
                            rules: document.getElementById('ds-dialog-rules').checked,
                            issue: document.getElementById('ds-dialog-issue').checked,
                            handbook: document.getElementById('ds-dialog-handbook').checked,
                            wrAll: document.getElementById('ds-dialog-wr-all').checked,
                            phone: document.getElementById('ds-dialog-phone').checked,
                            diary: document.getElementById('ds-dialog-diary').checked,
                            remember: document.getElementById('ds-dialog-remember').checked
                        };
                        if (config.remember) _sessionDataSource = config;
                        modal.style.display = 'none';
                        confirmBtn.removeEventListener('click', handleConfirm);
                        resolve(config);
                    };
                    reject = function() { modal.style.display = 'none'; resolve(null); };
                    confirmBtn.addEventListener('click', handleConfirm, { once: true });
                });
            }

            // 数据源按钮：点击弹出选择对话框，选择后用当前输入内容发送
            setTimeout(function() {
                var resetBtn = document.getElementById('ds-reset-datasource');
                if (resetBtn) resetBtn.onclick = async function() {
                    var inputEl = document.getElementById('ds-user-input');
                    var currentText = inputEl ? inputEl.value.trim() : '';
                    var result = await showDataSourceSelector();
                    if (!result) return;
                    // 设置临时数据源，让 dsSendMsg 内部使用用户选择的配置
                    window._tempDataSrc = result;
                    try {
                        if (currentText && inputEl) {
                            inputEl.value = currentText;
                            if (typeof window.dsSendMsg === 'function') await window.dsSendMsg();
                        }
                    } finally {
                        window._tempDataSrc = null;
                        if (!result.remember) _sessionDataSource = null;
                    }
                };
            }, 300);

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
                                var rptSlice = rpts.sort(function(a,b){ return b.date - a.date; }).slice(0, 3);
                                var txt = '【历史报告（最近' + rptSlice.length + '篇，共' + rpts.length + '篇）—仅供文风参考】\n';
                                rptSlice.forEach(function(r, i){
                                    txt += (i+1) + '. 《' + (r.title||'未命名') + '》（' + new Date(r.date).toLocaleDateString('zh-CN') + '）：\n' + String(r.content||'').slice(0, 300) + '…\n';
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

                // 车站电话：关键词评分 → top 5
                if (usePhone && typeof window.getPhoneData === 'function') {
                    var phones = window.getPhoneData();
                    if (phones.length > 0) {
                        var topPhones = rankAndSlice(phones, userQuery, function(r){ return (r.单位||'')+' '+(r.站名||'')+' '+(r.线名||''); }, 5);
                        var txt = '【车站电话数据（共' + phones.length + '条，仅展示最相关的5条）】\n';
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
            // ---- 附件处理（回形针按钮） ----
            window._dsAttachments = []; // [{name, text}]

            window.dsHandleAttach = async function(input) {
                const files = Array.from(input.files || []);
                if (!files.length) return;
                const inputEl = document.getElementById('ds-user-input');

                for (const file of files) {
                    let text = '';
                    const ext = file.name.split('.').pop().toLowerCase();

                    try {
                        // 根据文件扩展名选择解析方式
                        if (ext === 'txt' || ext === 'md' || ext === 'json' || ext === 'csv') {
                            text = await dsReadTextFile(file);
                        } else if (ext === 'doc' || ext === 'docx') {
                            text = await dsReadWordFile(file);
                        } else if (ext === 'xls' || ext === 'xlsx') {
                            text = await dsReadExcelFile(file);
                        } else if (ext === 'pdf') {
                            text = await dsReadPdfFile(file);
                        } else {
                            text = '暂不支持该文件格式：' + ext;
                        }

                        // 限制文件内容长度（防止过大）
                        const maxLen = 8000;
                        const truncated = text.length > maxLen ? text.slice(0, maxLen) + '\n...[内容过长，已截取前' + maxLen + '字]' : text;

                        // 存储到附件数组
                        window._dsAttachments.push({ name: file.name, text: truncated });

                        // 在输入框中显示文件标签（不显示内容）
                        const icon = ext === 'pdf' ? '📕' : ext === 'docx' || ext === 'doc' ? '📘' : ext === 'xlsx' || ext === 'xls' ? '📊' : '📎';
                        const tagText = ' [' + icon + ' ' + file.name + '] ';
                        if (inputEl.value) {
                            inputEl.value += tagText;
                        } else {
                            inputEl.value = tagText;
                        }

                        // 调整输入框高度
                        inputEl.style.height = 'auto';
                        inputEl.style.height = inputEl.scrollHeight + 'px';

                    } catch (err) {
                        console.error('文件解析失败:', file.name, err);
                        alert('文件 "' + file.name + '" 解析失败：' + err.message);
                    }
                }
                input.value = ''; // 允许重复选同一文件
            };

            // 读取纯文本文件
            window.dsReadTextFile = function(file) {
                return new Promise((resolve, reject) => {
                    const reader = new FileReader();
                    reader.onload = e => resolve(e.target.result || '');
                    reader.onerror = () => reject(new Error('文件读取失败'));
                    reader.readAsText(file, 'UTF-8');
                });
            };

            // 读取Word文件（使用mammoth.js，保留表格结构）
            window.dsReadWordFile = function(file) {
                return new Promise((resolve, reject) => {
                    const reader = new FileReader();
                    reader.onload = function(e) {
                        try {
                            const arrayBuffer = e.target.result;
                            // 使用 convertToHtml 保留表格结构
                            mammoth.convertToHtml({ arrayBuffer: arrayBuffer })
                                .then(function(result) {
                                    const text = window._htmlToTextPreserveTables(result.value || '');
                                    if (!text) {
                                        resolve('[Word文件] ' + file.name + '\n\n未能提取到文本内容，可能是图片为主的文档。\n\n文件大小：' + (file.size / 1024).toFixed(2) + ' KB');
                                    } else {
                                        resolve('[Word文件] ' + file.name + '\n\n' + text);
                                    }
                                })
                                .catch(function(err) {
                                    reject(new Error('Word文件解析失败：' + (err.message || '未知错误')));
                                });
                        } catch (err) {
                            reject(new Error('Word文件解析失败'));
                        }
                    };
                    reader.onerror = () => reject(new Error('文件读取失败'));
                    reader.readAsArrayBuffer(file);
                });
            };

            // 读取Excel文件（使用xlsx.js）
            window.dsReadExcelFile = function(file) {
                return new Promise((resolve, reject) => {
                    const reader = new FileReader();
                    reader.onload = function(e) {
                        try {
                            const data = new Uint8Array(e.target.result);
                            const workbook = XLSX.read(data, { type: 'array' });
                            
                            let result = '[Excel文件] ' + file.name + '\n\n';
                            
                            // 遍历所有工作表
                            workbook.SheetNames.forEach(function(sheetName, index) {
                                const worksheet = workbook.Sheets[sheetName];
                                const jsonData = XLSX.utils.sheet_to_json(worksheet, { header: 1 });
                                
                                if (jsonData.length > 0) {
                                    result += '--- 工作表 ' + (index + 1) + '：' + sheetName + ' ---\n';
                                    
                                    // 限制每个工作表最多显示100行
                                    const maxRows = 100;
                                    const displayData = jsonData.slice(0, maxRows);
                                    
                                    displayData.forEach(function(row, rowIndex) {
                                        // 将每行转换为文本，保留主要数据
                                        const rowText = row.map(function(cell) {
                                            if (cell === null || cell === undefined) return '';
                                            return String(cell).substring(0, 200); // 限制每个单元格200字符
                                        }).join(' | ');
                                        result += rowText + '\n';
                                    });
                                    
                                    if (jsonData.length > maxRows) {
                                        result += '\n...[数据过多，仅显示前' + maxRows + '行]\n';
                                    }
                                    result += '\n';
                                }
                            });
                            
                            if (workbook.SheetNames.length === 0) {
                                result += '该文件没有可读取的工作表。\n';
                            }
                            
                            resolve(result);
                        } catch (err) {
                            reject(new Error('Excel文件解析失败：' + (err.message || '未知错误')));
                        }
                    };
                    reader.onerror = () => reject(new Error('文件读取失败'));
                    reader.readAsArrayBuffer(file);
                });
            };

            // 读取PDF文件（使用pdf.js）
            window.dsReadPdfFile = function(file) {
                return new Promise((resolve, reject) => {
                    const reader = new FileReader();
                    reader.onload = async function(e) {
                        try {
                            const typedarray = new Uint8Array(e.target.result);
                            
                            // 初始化PDF.js worker
                            pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/2.16.105/pdf.worker.min.js';
                            
                            // 加载PDF文档
                            const pdf = await pdfjsLib.getDocument(typedarray).promise;
                            let result = '[PDF文件] ' + file.name + '\n\n总页数：' + pdf.numPages + '\n\n';
                            
                            // 限制最多读取前10页
                            const maxPages = Math.min(pdf.numPages, 10);
                            
                            for (let i = 1; i <= maxPages; i++) {
                                const page = await pdf.getPage(i);
                                const textContent = await page.getTextContent();
                                
                                // 提取文本并保持一定顺序
                                let pageText = '';
                                const lastY = { value: -Infinity };
                                
                                textContent.items.forEach(function(item) {
                                    if (item.str) {
                                        // 简单的段落分隔逻辑
                                        if (lastY.value !== -Infinity && Math.abs(lastY.value - item.transform[5]) > 5) {
                                            pageText += '\n';
                                        }
                                        pageText += item.str;
                                        lastY.value = item.transform[5];
                                    }
                                });
                                
                                result += '--- 第 ' + i + ' 页 ---\n' + pageText + '\n\n';
                            }
                            
                            if (pdf.numPages > maxPages) {
                                result += '...[页数过多，仅显示前' + maxPages + '页]\n';
                            }
                            
                            resolve(result);
                        } catch (err) {
                            reject(new Error('PDF文件解析失败：' + (err.message || '未知错误')));
                        }
                    };
                    reader.onerror = () => reject(new Error('文件读取失败'));
                    reader.readAsArrayBuffer(file);
                });
            };

            window.dsRemoveAttach = function(idx, tagEl) {
                if (window._dsAttachments[idx]) window._dsAttachments[idx] = null;
                if (tagEl) tagEl.remove();
                const tagsEl = document.getElementById('ds-attach-tags');
                if (tagsEl && !tagsEl.children.length) tagsEl.style.display = 'none';
            };

            window.dsSendMsg = async function() {
                if (dsStreaming) return;
                const input = document.getElementById('ds-user-input');
                const userText = input.value.trim();
                if (!userText) return;

                // ── 意图路由：自动切换子模块（已关闭，避免误跳转）──
                // var _skipRouting = window._skipIntentRouting_inner === true;
                // window._skipIntentRouting_inner = false;
                // const _lowerText = userText;
                // const _isCheckIntent = /对规|违反了?哪|不符合|哪条|违章|超限|应对应|依据什么规|检查问题/.test(_lowerText);
                // const _isWriteIntent = /写报告|生成报告|起草|撰写|安全分析|月度总结|专项报告/.test(_lowerText);
                // if (!_skipRouting && _isCheckIntent && typeof dsSwitchSub === 'function') {
                //     input.value = '';
                //     dsSwitchSub('check');
                //     const acInput = document.getElementById('autoCheck-input');
                //     if (acInput) {
                //         acInput.value = userText;
                //         window.autoCheckAI_force();
                //     }
                //     return;
                // }
                // if (!_skipRouting && _isWriteIntent && typeof dsSwitchSub === 'function') {
                //     input.value = '';
                //     dsSwitchSub('write');
                //     const wrInput = document.getElementById('wr-query-input');
                //     if (wrInput) wrInput.value = userText;
                //     return;
                // }

                const key = dsApiKey || await _getApiKey();
                if (!key || key === DS_PLACEHOLDER_KEY) {
                    dsAppendMsg('system', '⚠️ 请先配置 DeepSeek API Key（在上方输入框中输入并点击「保存」）。\n\n如需申请 API Key，请访问：https://platform.deepseek.com/');
                    return;
                }

                // 拼接附件内容到问题末尾（AI 读取用）
                const validAttach = (window._dsAttachments || []).filter(Boolean);
                let finalText = userText;
                let attachNames = [];
                if (validAttach.length > 0) {
                    attachNames = validAttach.map(a => a.name);
                    finalText += '\n\n【附件内容】\n' + validAttach.map(a =>
                        '--- 文件：' + a.name + ' ---\n' + a.text
                    ).join('\n\n');
                    // 清空附件
                    window._dsAttachments = [];
                    document.getElementById('ds-attach-file') && (document.getElementById('ds-attach-file').value = '');
                }

                input.value = '';
                input.style.height = '';

                // 存储用户消息（displayText 用于显示，content 用于 AI）
                const displayText = attachNames.length > 0
                    ? userText + '\n📎 ' + attachNames.join('、')
                    : userText;

                // 若无当前会话，自动新建一个（保证保存路径有效）
                if (!dsCurrentConvId) {
                    dsCurrentConvId = dsGenerateId();
                    dsHistory = [];
                    dsConversations.unshift({
                        id: dsCurrentConvId,
                        title: '新对话',
                        messages: [],
                        timestamp: Date.now(),
                        pinned: false
                    });
                    localStorage.setItem(DS_CURRENT_CONV_ID, dsCurrentConvId);
                    dsRenderHistoryList();
                }

                dsHistory.push({ role: 'user', content: finalText, displayText: displayText });
                dsRenderAll();
                // 【性能优化】不在此时写 localStorage，等流式结束后统一保存

                // 不再自动弹出数据源选择，使用会话记忆或默认全部关闭
                // 支持临时数据源覆盖（数据源按钮选择不记住时使用）
                var _tempSrc = window._tempDataSrc || null;
                var _dataSrc = _tempSrc || _sessionDataSource || { rules: false, issue: false, handbook: false, wrAll: false, phone: false, diary: false, remember: false };
                // 【性能优化】所有数据源都关闭时，跳过 dsBuildSystemPrompt 的全遍历评分
                const hasAnySource = _dataSrc.rules || _dataSrc.issue || _dataSrc.handbook || _dataSrc.wrAll || _dataSrc.phone || _dataSrc.diary;
                const systemPrompt = hasAnySource
                    ? await dsBuildSystemPrompt(finalText, _dataSrc)
                    : '你是一名铁路安全监察智能助手，回答请使用中文，条理清晰。';
                // 临时数据源（不记住）使用完后清除；会话数据源不记住时也清除
                if (_tempSrc) { window._tempDataSrc = null; }

                const messages = [
                    { role: 'system', content: systemPrompt },
                    ...dsHistory.slice(-10)   // 携带最近 10 条上下文
                ];

                // 占位助手消息（流式输出用）
                dsHistory.push({ role: 'assistant', content: '' });
                const assistantIdx = dsHistory.length - 1;
                dsRenderAll();
                dsScrollBottom();

                dsStreaming = true;
                const sendBtn = document.getElementById('ds-send-btn');
                sendBtn.disabled = false;
                sendBtn.style.opacity = '1';
                sendBtn.style.background = '#e53e3e';
                sendBtn.title = '点击停止生成';
                sendBtn.onclick = function() { if (_acAbortController) _acAbortController.abort(); };
                sendBtn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>';

                try {
                    _acAbortController = new AbortController();
                    // 前端工程师角色需要更大 token 配额，避免代码截断
                    const roleSelect = document.getElementById('expertRole');
                    const isFrontendRole = roleSelect && roleSelect.value === 'frontend';
                    const isCodeRequest = /代码|html|css|js|javascript|网页|前端|组件|页面|布局|写一个|生成一个|帮我写/.test(finalText);
                    const maxTokens = (isFrontendRole || isCodeRequest) ? 8192 : 4096;
                    const resp = await fetch(dsApiUrl, {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                            'Authorization': 'Bearer ' + key
                        },
                        body: JSON.stringify({
                            model: dsModel,
                            messages: messages,
                            stream: true,
                            temperature: 0.7,
                            max_tokens: maxTokens
                        }),
                        signal: _acAbortController.signal
                    });

                    if (!resp.ok) {
                        const errText = await resp.text();
                        let errMsg = '请求失败（HTTP ' + resp.status + '）';
                        const statusHints = {
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
                            try {
                                const errJson = JSON.parse(errText);
                                errMsg += '：' + (errJson.error?.message || errText.slice(0, 200));
                            } catch(e) { errMsg += '：' + errText.slice(0, 200); }
                        }
                        dsHistory[assistantIdx].content = '❌ ' + errMsg;
                        dsRenderAll(); /* 仅渲染错误提示，不写 localStorage */
                        return;
                    }

                    // SSE 流式读取
                    const reader = resp.body.getReader();
                    const decoder = new TextDecoder();
                    let buffer = '';
                    let _renderTick = 0; // 渲染节流计数器

                    while (true) {
                        const { done, value } = await reader.read();
                        if (done) break;
                        buffer += decoder.decode(value, { stream: true });
                        const lines = buffer.split('\n');
                        buffer = lines.pop(); // 保留未完成行
                        for (const line of lines) {
                            const trimmed = line.trim();
                            if (!trimmed || trimmed === 'data: [DONE]') continue;
                            if (trimmed.startsWith('data: ')) {
                                try {
                                    const json = JSON.parse(trimmed.slice(6));
                                    const delta = json.choices?.[0]?.delta?.content || '';
                                    if (delta) {
                                        dsHistory[assistantIdx].content += delta;
                                        // 【性能优化】节流渲染：每3个chunk刷新一次DOM
                                        _renderTick++;
                                        if (_renderTick % 3 === 0) {
                                            const chatBox = document.getElementById('ds-chat-box');
                                            const bubbles = chatBox.querySelectorAll('.ds-bubble-assistant');
                                            const lastBubble = bubbles[bubbles.length - 1];
                                            if (lastBubble) lastBubble.innerHTML = dsMarkdown(dsHistory[assistantIdx].content) + '<span class="ds-cursor">▌</span>';
                                            dsScrollBottom();
                                        }
                                    }
                                } catch(e) { /* 跳过解析失败的行 */ }
                            }
                        }
                    }
                    // 流结束：强制最后一次渲染
                    var _finalChatBox = document.getElementById('ds-chat-box');
                    var _finalBubbles = _finalChatBox.querySelectorAll('.ds-bubble-assistant');
                    var _finalBubble = _finalBubbles[_finalBubbles.length - 1];
                    if (_finalBubble) _finalBubble.innerHTML = dsMarkdown(dsHistory[assistantIdx].content);
                    dsSaveHistory();
                    dsRenderHistoryList();
                    // 流式结束后注入反馈按钮
                    setTimeout(function(){
                        var lastBubble = _finalChatBox.querySelector('.ds-bubble-assistant:last-of-type');
                        if (lastBubble && !lastBubble.querySelector('.feedback-good') && typeof window._addFeedbackButtons === 'function') {
                            window._addFeedbackButtons(lastBubble, lastBubble.innerText);
                        }
                    }, 50);

                } catch(err) {
                    if (err.name === 'AbortError') {
                        // 用户手动停止，保留已生成内容
                        const chatBox2 = document.getElementById('ds-chat-box');
                        if (chatBox2) {
                            const cursors2 = chatBox2.querySelectorAll('.ds-cursor');
                            cursors2.forEach(c => c.remove());
                            setTimeout(function(){
                                var lastBubble = chatBox2.querySelector('.ds-bubble-assistant:last-of-type');
                                if (lastBubble && !lastBubble.querySelector('.feedback-good') && typeof window._addFeedbackButtons === 'function') {
                                    window._addFeedbackButtons(lastBubble, lastBubble.innerText);
                                }
                            }, 50);
                        }
                        /* 用户手动停止时不写 localStorage，流结束才保存 */
                    } else {
                        // 检测 CORS 错误，提示具体原因
                        if (err.message && (err.message.indexOf('Failed to fetch') !== -1)) {
                            dsHistory[assistantIdx].content = '❌ 网络错误：CORS 跨域限制\n\n'
                                + '当前 API（' + dsApiUrl.split('/api/')[0] + '）不允许浏览器直接访问。\n\n'
                                + '解决方案：\n'
                                + '1. 切换使用 DeepSeek API（推荐，支持浏览器调用）\n'
                                + '2. 或等待后续版本支持 CORS 代理';
                        } else {
                            dsHistory[assistantIdx].content = '❌ 网络错误：' + err.message + '\n请检查网络连接或 API Key 是否正确。';
                        }
                        dsRenderAll();
                        /* 网络错误不写 localStorage */
                    }
                } finally {
                    _acAbortController = null;
                    dsStreaming = false;
                    const sendBtn2 = document.getElementById('ds-send-btn');
                    if (sendBtn2) {
                        sendBtn2.disabled = false;
                        sendBtn2.style.opacity = '1';
                        sendBtn2.style.background = '';
                        sendBtn2.title = '发送（Ctrl+Enter）';
                        sendBtn2.onclick = function() { dsSendMsg(); };
                        sendBtn2.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="display:block;"><path d="M12 19V5"/><path d="M5 12l7-7 7 7"/></svg>';
                    }
                }
            };

            // ---- 快捷提问 ----
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
                    // 空对话时隐藏对话区，只显示输入框
                    box.style.display = 'none';
                    box.innerHTML = '';
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
                            html += '<div class="ds-row-assistant"><div class="ds-bubble-assistant">' + dsMarkdown(msg.content) + '</div></div>';
                        }
                    } else {
                        html += '<div class="ds-row-system"><div class="ds-bubble-system">' + dsEsc(msg.content) + '</div></div>';
                    }
                });
                box.innerHTML = html;
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
                var a = document.createElement('a');
                a.href = URL.createObjectURL(blob);
                a.download = 'code.' + ext;
                a.click();
                setTimeout(function() { URL.revokeObjectURL(a.href); }, 100);
            };

            // ---- 简易 Markdown 渲染 ----
            function dsMarkdown(text) {
                if (!text) return '';
                let s = dsEsc(text);
                // 代码块（含下载按钮）
                s = s.replace(/```(\w*)\n?([\s\S]*?)```/g, function(match, lang, code) {
                    var ext = (lang || 'txt').toLowerCase();
                    var fileExts = { html:'html', css:'css', js:'js', javascript:'js', ts:'ts', typescript:'ts', json:'json', py:'py', python:'py', sh:'sh', bash:'sh', sql:'sql', md:'md', xml:'xml', svg:'svg', txt:'txt' };
                    var fileExt = fileExts[ext] || ext;
                    return '<div style="position:relative;margin:6px 0;">' +
                        '<button onclick="window.dsDownloadCode(this)" data-ext="' + fileExt + '" ' +
                        'style="position:absolute;top:6px;right:6px;background:#3b82f6;color:#fff;border:none;border-radius:4px;padding:3px 10px;font-size:0.75rem;cursor:pointer;z-index:2;transition:all 0.2s;box-shadow:0 1px 3px rgba(0,0,0,0.3);" ' +
                        'onmouseover="this.style.background=\'#2563eb\'" onmouseout="this.style.background=\'#3b82f6\'" title="下载代码文件">📥 下载 ' + ext.toUpperCase() + '</button>' +
                        '<pre style="background:#1e293b;color:#e2e8f0;padding:32px 10px 10px 10px;border-radius:6px;overflow-x:auto;font-size:0.85em;margin:0;white-space:pre-wrap;">' + code + '</pre></div>';
                });
                // 行内代码
                s = s.replace(/`([^`]+)`/g, '<code style="background:#e8ecf3;color:#c7254e;padding:1px 4px;border-radius:3px;font-size:0.9em;">$1</code>');
                // 粗体
                s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
                // 斜体
                s = s.replace(/\*([^*]+)\*/g, '<em>$1</em>');
                // 标题
                s = s.replace(/^### (.+)$/gm, '<h4 style="color:var(--primary);margin:8px 0 4px;">$1</h4>');
                s = s.replace(/^## (.+)$/gm, '<h3 style="color:var(--primary);margin:10px 0 4px;">$1</h3>');
                s = s.replace(/^# (.+)$/gm, '<h2 style="color:var(--primary);margin:12px 0 4px;">$1</h2>');
                // 无序列表
                s = s.replace(/^[*\-] (.+)$/gm, '<li style="margin-left:16px;list-style:disc;">$1</li>');
                // 有序列表
                s = s.replace(/^\d+\. (.+)$/gm, '<li style="margin-left:16px;list-style:decimal;">$1</li>');
                // 换行
                s = s.replace(/\n/g, '<br>');
                return s;
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
                } catch(e) {}
            }

            // 等待 DOM 就绪后初始化
            if (document.readyState === 'loading') {
                document.addEventListener('DOMContentLoaded', dsInit);
            } else {
                setTimeout(dsInit, 100);
            }

            // ========== 自动对规子模块 ==========
            // ========== 结构化术语库（带专业标签） ==========
            let PATCH_TERM_LIBRARY = [];
            let PATCH_TERM_MAP = new Map();

            function rebuildTermMap() {
                PATCH_TERM_MAP.clear();
                PATCH_TERM_LIBRARY.forEach(item => {
                    if (item && item.term) PATCH_TERM_MAP.set(item.term.toLowerCase(), item.trade || '通用');
                });
            }

            // 默认词库（原有术语 + 专业标签）
                        const DEFAULT_TERMS = [
                { term: "列车", trade: "车务" }, { term: "信号员", trade: "车务" }, { term: "内勤助理值班员", trade: "车务" }, 
                { term: "列车调度员", trade: "车务" }, { term: "外勤助理值班员", trade: "车务" }, { term: "扳道员", trade: "车务" }, 
                { term: "调车长", trade: "车务" }, { term: "车号员", trade: "车务" }, { term: "车站值班员", trade: "车务" }, { term: "连接员", trade: "车务" }, 
                { term: "到发线", trade: "车务" }, { term: "区间", trade: "车务" }, { term: "单线", trade: "车务" }, { term: "双线", trade: "车务" }, 
                { term: "岔线", trade: "车务" }, { term: "机待线", trade: "车务" }, { term: "机走线", trade: "车务" }, { term: "正线", trade: "车务" }, 
                { term: "段管线", trade: "车务" }, { term: "牵出线", trade: "车务" }, { term: "站间", trade: "车务" }, { term: "联络线", trade: "车务" }, 
                { term: "红色许可证", trade: "车务" }, { term: "绿色许可证", trade: "车务" }, { term: "行车凭证", trade: "车务" }, 
                { term: "调度命令", trade: "车务" }, { term: "路牌", trade: "车务" }, { term: "路票", trade: "车务" }, { term: "路签", trade: "车务" }, 
                { term: "一度停车", trade: "车务" }, { term: "三盯", trade: "车务" }, { term: "会让", trade: "车务" }, { term: "分界点", trade: "车务" }, 
                { term: "列车运行图", trade: "车务" }, { term: "区间占用", trade: "车务" }, { term: "发车", trade: "车务" }, { term: "呼唤应答", trade: "车务" }, 
                { term: "始发", trade: "车务" }, { term: "引导接车", trade: "车务" }, { term: "接发列车", trade: "车务" }, { term: "接车", trade: "车务" }, 
                { term: "终到", trade: "车务" }, { term: "编组", trade: "车务" }, { term: "自动闭塞", trade: "车务" }, { term: "越行", trade: "车务" }, 
                { term: "车机联控", trade: "车务" }, { term: "运行揭示", trade: "车务" }, { term: "退行", trade: "车务" }, { term: "途中折返", trade: "车务" }, 
                { term: "人力制动机", trade: "车务" }, { term: "取送车", trade: "车务" }, { term: "峰顶", trade: "车务" }, { term: "平面调车", trade: "车务" }, 
                { term: "推进", trade: "车务" }, { term: "推送调车", trade: "车务" }, { term: "止轮器", trade: "车务" }, { term: "溜放", trade: "车务" }, 
                { term: "站内调车", trade: "车务" }, { term: "解体", trade: "车务" }, { term: "解编", trade: "车务" }, { term: "试拉", trade: "车务" }, 
                { term: "调车作业", trade: "车务" }, { term: "越区调车", trade: "车务" }, { term: "车列", trade: "车务" }, { term: "铁鞋", trade: "车务" }, 
                { term: "防溜", trade: "车务" }, { term: "驼峰", trade: "车务" }, { term: "保压", trade: "机务" }, { term: "减压", trade: "机务" }, 
                { term: "分段缓解", trade: "机务" }, { term: "快充", trade: "机务" }, { term: "慢充", trade: "机务" }, { term: "拉风", trade: "机务" }, 
                { term: "持续保压", trade: "机务" }, { term: "排风", trade: "机务" }, { term: "缓解", trade: "机务" }, { term: "自然制动", trade: "机务" }, 
                { term: "自然缓解", trade: "机务" }, { term: "过充", trade: "机务" }, { term: "追加减压", trade: "机务" }, { term: "追加制动", trade: "机务" }, 
                { term: "阶段性制动", trade: "机务" }, { term: "再制动", trade: "机务" }, { term: "再生制动", trade: "机务" }, { term: "动力制动", trade: "机务" }, 
                { term: "常用制动", trade: "机务" }, { term: "撒砂", trade: "机务" }, { term: "液力制动", trade: "机务" }, { term: "电阻制动", trade: "机务" }, 
                { term: "盘形制动", trade: "机务" }, { term: "磁轨制动", trade: "机务" }, { term: "空气制动", trade: "机务" }, { term: "紧急制动", trade: "机务" }, 
                { term: "停放制动", trade: "机务" }, { term: "制动机", trade: "机务" }, { term: "制动缸", trade: "机务" }, { term: "单独制动机", trade: "机务" }, 
                { term: "弹簧停车制动", trade: "机务" }, { term: "总风缸", trade: "机务" }, { term: "电空制动", trade: "机务" }, 
                { term: "自动制动机", trade: "机务" }, { term: "防滑器", trade: "机务" }, { term: "全部试验", trade: "机务" }, { term: "安定试验", trade: "机务" }, 
                { term: "感度保压", trade: "机务" }, { term: "感度试验", trade: "机务" }, { term: "简略试验", trade: "机务" }, { term: "紧急试验", trade: "机务" }, 
                { term: "试风", trade: "机务" }, { term: "过球试验", trade: "机务" }, { term: "司机长", trade: "机务" }, { term: "学习司机", trade: "机务" }, 
                { term: "指导司机", trade: "机务" }, { term: "机车司机", trade: "机务" }, { term: "添乘人员", trade: "机务" }, { term: "制动", trade: "机务" }, 
                { term: "接管", trade: "机务" }, { term: "机车", trade: "机务" }, { term: "手柄", trade: "机务" }, { term: "换向手柄", trade: "机务" }, 
                { term: "调速手柄", trade: "机务" }, { term: "东风型机车", trade: "机务" }, { term: "内燃机车", trade: "机务" }, { term: "动车组", trade: "机务" }, 
                { term: "动车组列车", trade: "机务" }, { term: "双机牵引", trade: "机务" }, { term: "和谐型机车", trade: "机务" }, 
                { term: "本务机车", trade: "机务" }, { term: "电力机车", trade: "机务" }, { term: "蒸汽机车", trade: "机务" }, { term: "补机", trade: "机务" }, 
                { term: "调车机车", trade: "机务" }, { term: "重联机车", trade: "机务" }, { term: "韶山型机车", trade: "机务" }, { term: "包乘", trade: "机务" }, 
                { term: "换班", trade: "机务" }, { term: "机车交路", trade: "机务" }, { term: "机车周转图", trade: "机务" }, { term: "牵引", trade: "机务" }, 
                { term: "继乘", trade: "机务" }, { term: "轮乘", trade: "机务" }, { term: "主变压器", trade: "机务" }, { term: "主断路器", trade: "机务" }, 
                { term: "励磁", trade: "机务" }, { term: "整流", trade: "机务" }, { term: "牵引变流器", trade: "机务" }, { term: "牵引电动机", trade: "机务" }, 
                { term: "辅助逆变器", trade: "机务" }, { term: "逆变", trade: "机务" }, { term: "冷却器", trade: "机务" }, { term: "司机室", trade: "机务" }, 
                { term: "操纵台", trade: "机务" }, { term: "散热器", trade: "机务" }, { term: "水泵", trade: "机务" }, { term: "油水分离器", trade: "机务" }, 
                { term: "油泵", trade: "机务" }, { term: "燃泵", trade: "机务" }, { term: "轮缘润滑", trade: "机务" }, { term: "通风机", trade: "机务" }, 
                { term: "预热锅炉", trade: "机务" }, { term: "走停走", trade: "机务" }, { term: "出入段模式", trade: "机务" }, { term: "定标", trade: "机务" }, 
                { term: "常用制动模式", trade: "机务" }, { term: "监控模式", trade: "机务" }, { term: "监控装置", trade: "机务" }, 
                { term: "目视行车模式", trade: "机务" }, { term: "紧急制动模式", trade: "机务" }, { term: "警惕", trade: "机务" }, 
                { term: "调整状态", trade: "机务" }, { term: "调车模式", trade: "机务" }, { term: "车上信号", trade: "机务" }, { term: "运行监控", trade: "机务" }, 
                { term: "降级状态", trade: "机务" }, { term: "作用管", trade: "机务" }, { term: "储风缸", trade: "机务" }, { term: "列车管", trade: "机务" }, 
                { term: "制动管", trade: "机务" }, { term: "副风缸", trade: "机务" }, { term: "压力表", trade: "机务" }, { term: "容积风缸", trade: "机务" }, 
                { term: "工作风缸", trade: "机务" }, { term: "干燥器", trade: "机务" }, { term: "平均管", trade: "机务" }, { term: "总风缸管", trade: "机务" }, 
                { term: "截断塞门", trade: "机务" }, { term: "折角塞门", trade: "机务" }, { term: "接风管", trade: "机务" }, { term: "摘管", trade: "机务" }, 
                { term: "漏泄", trade: "机务" }, { term: "空压机", trade: "机务" }, { term: "空压机组", trade: "机务" }, { term: "紧急放风阀", trade: "机务" }, 
                { term: "风压", trade: "机务" }, { term: "风表", trade: "机务" }, { term: "三通阀", trade: "车辆" }, { term: "分配阀", trade: "车辆" }, 
                { term: "制动梁", trade: "车辆" }, { term: "差压阀", trade: "车辆" }, { term: "空重阀", trade: "车辆" }, { term: "缓解阀", trade: "车辆" }, 
                { term: "闸片", trade: "车辆" }, { term: "闸瓦", trade: "车辆" }, { term: "闸瓦托", trade: "车辆" }, { term: "高度阀", trade: "车辆" }, 
                { term: "侧架", trade: "车辆" }, { term: "减振器", trade: "车辆" }, { term: "弹簧组", trade: "车辆" }, { term: "摇枕", trade: "车辆" }, 
                { term: "踏面", trade: "车辆" }, { term: "车轮", trade: "车辆" }, { term: "车轴", trade: "车辆" }, { term: "转向架", trade: "车辆" }, 
                { term: "轮对", trade: "车辆" }, { term: "轮缘", trade: "车辆" }, { term: "轴承", trade: "车辆" }, { term: "轴温", trade: "车辆" }, 
                { term: "轴箱", trade: "车辆" }, { term: "侧墙", trade: "车辆" }, { term: "底架", trade: "车辆" }, { term: "枕梁", trade: "车辆" }, 
                { term: "牵引梁", trade: "车辆" }, { term: "端墙", trade: "车辆" }, { term: "车体", trade: "车辆" }, { term: "冷藏车", trade: "车辆" }, 
                { term: "卧铺车", trade: "车辆" }, { term: "双层客车", trade: "车辆" }, { term: "发电车", trade: "车辆" }, { term: "客车", trade: "车辆" }, 
                { term: "平车", trade: "车辆" }, { term: "敞车", trade: "车辆" }, { term: "棚车", trade: "车辆" }, { term: "硬座车", trade: "车辆" }, 
                { term: "罐车", trade: "车辆" }, { term: "行李车", trade: "车辆" }, { term: "货车", trade: "车辆" }, { term: "软座车", trade: "车辆" }, 
                { term: "邮政车", trade: "车辆" }, { term: "集装箱车", trade: "车辆" }, { term: "餐车", trade: "车辆" }, { term: "密接式车钩", trade: "车辆" }, 
                { term: "挂车", trade: "车辆" }, { term: "摘车", trade: "车辆" }, { term: "缓冲器", trade: "车辆" }, { term: "车钩", trade: "车辆" }, 
                { term: "软管", trade: "车辆" }, { term: "连挂", trade: "车辆" }, { term: "钩尾框", trade: "车辆" }, { term: "钩舌", trade: "车辆" }, 
                { term: "防跳装置", trade: "车辆" }, { term: "列车管系", trade: "车辆" }, { term: "车组", trade: "车辆" }, { term: "上道作业", trade: "工务" }, 
                { term: "巡道", trade: "工务" }, { term: "打磨", trade: "工务" }, { term: "换轨", trade: "工务" }, { term: "捣固", trade: "工务" }, 
                { term: "探伤", trade: "工务" }, { term: "清筛", trade: "工务" }, { term: "焊轨", trade: "工务" }, { term: "线路封锁", trade: "工务" }, 
                { term: "钢轨伤损", trade: "工务" }, { term: "四轮", trade: "工务" }, { term: "小车", trade: "工务" }, { term: "捣固机", trade: "工务" }, 
                { term: "探伤仪", trade: "工务" }, { term: "轨道车", trade: "工务" }, { term: "轻型车辆", trade: "工务" }, { term: "专用线", trade: "工务" }, 
                { term: "咽喉", trade: "工务" }, { term: "安全线", trade: "工务" }, { term: "尽头线", trade: "工务" }, { term: "护坡", trade: "工务" }, 
                { term: "挡墙", trade: "工务" }, { term: "排水沟", trade: "工务" }, { term: "桥台", trade: "工务" }, { term: "桥墩", trade: "工务" }, 
                { term: "桥梁", trade: "工务" }, { term: "涵洞", trade: "工务" }, { term: "站台", trade: "工务" }, { term: "股道", trade: "工务" }, 
                { term: "路基", trade: "工务" }, { term: "道口", trade: "工务" }, { term: "避难线", trade: "工务" }, { term: "隧道", trade: "工务" }, 
                { term: "雨棚", trade: "工务" }, { term: "圆曲线", trade: "工务" }, { term: "扣件", trade: "工务" }, { term: "无砟轨道", trade: "工务" }, 
                { term: "无缝线路", trade: "工务" }, { term: "曲线", trade: "工务" }, { term: "有砟轨道", trade: "工务" }, { term: "机械节", trade: "工务" }, 
                { term: "焊缝", trade: "工务" }, { term: "缓和曲线", trade: "工务" }, { term: "超高", trade: "工务" }, { term: "轨底坡", trade: "工务" }, 
                { term: "轨枕", trade: "工务" }, { term: "轨距", trade: "工务" }, { term: "道床", trade: "工务" }, { term: "钢轨", trade: "工务" }, 
                { term: "长钢轨", trade: "工务" }, { term: "交叉渡线", trade: "工务" }, { term: "基本轨", trade: "工务" }, { term: "复式交分", trade: "工务" }, 
                { term: "尖轨", trade: "工务" }, { term: "岔区", trade: "工务" }, { term: "心轨", trade: "工务" }, { term: "护轨", trade: "工务" }, 
                { term: "翼轨", trade: "工务" }, { term: "菱形交叉", trade: "工务" }, { term: "转辙器", trade: "工务" }, { term: "辙叉", trade: "工务" }, 
                { term: "道岔", trade: "工务" }, { term: "道岔号码", trade: "工务" }, { term: "脱轨器", trade: "工务" }, { term: "防护栅栏", trade: "工务" }, 
                { term: "主体信号", trade: "电务" }, { term: "从属信号", trade: "电务" }, { term: "减速信号", trade: "电务" }, { term: "出站信号", trade: "电务" }, 
                { term: "加速信号", trade: "电务" }, { term: "地面信号", trade: "电务" }, { term: "复示信号", trade: "电务" }, { term: "容许信号", trade: "电务" }, 
                { term: "引导信号", trade: "电务" }, { term: "接近信号", trade: "电务" }, { term: "机车信号", trade: "电务" }, { term: "调车信号", trade: "电务" }, 
                { term: "进站信号", trade: "电务" }, { term: "进路表示器", trade: "电务" }, { term: "通过信号", trade: "电务" }, 
                { term: "道岔表示器", trade: "电务" }, { term: "遮断信号", trade: "电务" }, { term: "预告信号", trade: "电务" }, 
                { term: "驼峰信号", trade: "电务" }, { term: "信号机", trade: "电务" }, { term: "固定信号", trade: "电务" }, 
                { term: "总出站信号机", trade: "电务" }, { term: "方向继电器", trade: "电务" }, { term: "灯丝继电器", trade: "电务" }, 
                { term: "继电器", trade: "电务" }, { term: "臂板信号", trade: "电务" }, { term: "色灯信号", trade: "电务" }, { term: "轨道继电器", trade: "电务" }, 
                { term: "进路信号机", trade: "电务" }, { term: "道口信号", trade: "电务" }, { term: "遮断信号机", trade: "电务" }, 
                { term: "ATP", trade: "电务" }, { term: "BTM", trade: "电务" }, { term: "CBTC", trade: "电务" }, { term: "DMI", trade: "电务" }, 
                { term: "GSM-R", trade: "电务" }, { term: "ITCS", trade: "电务" }, { term: "LEU", trade: "电务" }, { term: "LKJ", trade: "电务" }, 
                { term: "LKJ2000", trade: "电务" }, { term: "LKJ2000A", trade: "电务" }, { term: "RBC", trade: "电务" }, 
                { term: "STM", trade: "电务" }, { term: "TCC", trade: "电务" }, { term: "TCR", trade: "电务" }, { term: "列控", trade: "电务" }, 
                { term: "列控车载设备", trade: "电务" }, { term: "应答器", trade: "电务" }, { term: "无线闭塞中心", trade: "电务" }, 
                { term: "码序", trade: "电务" }, { term: "轨道读取器", trade: "电务" }, { term: "故障状态", trade: "电务" }, { term: "区段锁闭", trade: "电务" }, 
                { term: "半自动闭塞", trade: "电务" }, { term: "单独锁闭", trade: "电务" }, { term: "抵触进路", trade: "电务" }, 
                { term: "敌对进路", trade: "电务" }, { term: "电气集中联锁", trade: "电务" }, { term: "电话闭塞", trade: "电务" }, 
                { term: "继电器联锁", trade: "电务" }, { term: "联锁", trade: "电务" }, { term: "自动站间闭塞", trade: "电务" }, { term: "解锁", trade: "电务" }, 
                { term: "计算机联锁", trade: "电务" }, { term: "道岔锁闭", trade: "电务" }, { term: "闭塞", trade: "电务" }, { term: "CTC", trade: "电务" }, 
                { term: "TDCS", trade: "电务" }, { term: "发码", trade: "电务" }, { term: "发码电路", trade: "电务" }, { term: "极性交叉", trade: "电务" }, 
                { term: "死区段", trade: "电务" }, { term: "电化区段", trade: "电务" }, { term: "电气节", trade: "电务" }, { term: "相邻区段", trade: "电务" }, 
                { term: "绝缘接头", trade: "电务" }, { term: "绝缘节", trade: "电务" }, { term: "轨道区段", trade: "电务" }, { term: "轨道电路", trade: "电务" }, 
                { term: "轨道电路信息", trade: "电务" }, { term: "非电化区段", trade: "电务" }, { term: "发车进路", trade: "电务" }, 
                { term: "引导进路", trade: "电务" }, { term: "接车进路", trade: "电务" }, { term: "调车进路", trade: "电务" }, { term: "进路解锁", trade: "电务" }, 
                { term: "进路锁闭", trade: "电务" }, { term: "通过进路", trade: "电务" }, { term: "光纤通信", trade: "电务" }, { term: "同轴电缆", trade: "电务" }, 
                { term: "数字调度", trade: "电务" }, { term: "区间电话", trade: "电务" }, { term: "有线列调", trade: "电务" }, 
                { term: "站间行车电话", trade: "电务" }, { term: "调度电话", trade: "电务" }, { term: "CIR", trade: "电务" }, 
                { term: "GSM-R手持台", trade: "电务" }, { term: "无线列调", trade: "电务" }, { term: "光缆", trade: "电务" }, 
                { term: "漏泄电缆", trade: "电务" }, { term: "电缆", trade: "电务" }, { term: "对讲机", trade: "电务" }, { term: "录音设备", trade: "电务" }, 
                { term: "语音记录仪", trade: "电务" }, { term: "中继站", trade: "电务" }, { term: "基站", trade: "电务" }, { term: "通信机房", trade: "电务" }, 
                { term: "通信铁塔", trade: "电务" }, { term: "电话防护", trade: "电务" }, { term: "倒闸", trade: "供电" }, { term: "停电命令", trade: "供电" }, 
                { term: "分闸", trade: "供电" }, { term: "合闸", trade: "供电" }, { term: "送电命令", trade: "供电" }, { term: "销令", trade: "供电" }, 
                { term: "受电弓", trade: "供电" }, { term: "受电弓滑板", trade: "供电" }, { term: "碳滑板", trade: "供电" }, { term: "集电头", trade: "供电" }, 
                { term: "保护线", trade: "供电" }, { term: "分区所", trade: "供电" }, { term: "变电所", trade: "供电" }, { term: "回流线", trade: "供电" }, 
                { term: "开闭所", trade: "供电" }, { term: "断路器", trade: "供电" }, { term: "架空地线", trade: "供电" }, { term: "牵引变压器", trade: "供电" }, 
                { term: "自耦变压器", trade: "供电" }, { term: "隔离开关", trade: "供电" }, { term: "馈线", trade: "供电" }, { term: "电气化", trade: "供电" }, 
                { term: "接触网工", trade: "供电" }, { term: "电力工", trade: "供电" }, { term: "中性区", trade: "供电" }, { term: "分相", trade: "供电" }, 
                { term: "张力补偿", trade: "供电" }, { term: "接触悬挂", trade: "供电" }, { term: "接触网", trade: "供电" }, { term: "支柱", trade: "供电" }, 
                { term: "无电区", trade: "供电" }, { term: "电分段", trade: "供电" }, { term: "电分相", trade: "供电" }, { term: "硬横梁", trade: "供电" }, 
                { term: "简单悬挂", trade: "供电" }, { term: "软横跨", trade: "供电" }, { term: "链形悬挂", trade: "供电" }, { term: "锚段", trade: "供电" }, 
                { term: "锚段关节", trade: "供电" }, { term: "中心锚结", trade: "供电" }, { term: "分段绝缘器", trade: "供电" }, { term: "分相器", trade: "供电" }, 
                { term: "吊弦", trade: "供电" }, { term: "定位器", trade: "供电" }, { term: "定位线夹", trade: "供电" }, { term: "弹簧补偿器", trade: "供电" }, 
                { term: "承力索", trade: "供电" }, { term: "拉杆", trade: "供电" }, { term: "接触线", trade: "供电" }, { term: "滑轮补偿", trade: "供电" }, 
                { term: "线岔", trade: "供电" }, { term: "绝缘子", trade: "供电" }, { term: "腕臂", trade: "供电" }, { term: "避雷器", trade: "供电" }, 
                { term: "弓网故障", trade: "供电" }, { term: "V形作业", trade: "供电" }, { term: "停电作业", trade: "供电" }, { term: "动态检测", trade: "供电" }, 
                { term: "步行巡视", trade: "供电" }, { term: "添乘检查", trade: "供电" }, { term: "直接带电作业", trade: "供电" }, 
                { term: "远离作业", trade: "供电" }, { term: "间接带电作业", trade: "供电" }, { term: "静态测量", trade: "供电" }, 
                { term: "高空作业", trade: "供电" }, { term: "上水", trade: "客运" }, { term: "列车保洁", trade: "客运" }, { term: "列车整备", trade: "客运" }, 
                { term: "排污", trade: "客运" }, { term: "临客列车", trade: "客运" }, { term: "快速列车", trade: "客运" }, { term: "旅客列车", trade: "客运" }, 
                { term: "旅游列车", trade: "客运" }, { term: "普速列车", trade: "客运" }, { term: "特快列车", trade: "客运" }, { term: "直达特快", trade: "客运" }, 
                { term: "通勤列车", trade: "客运" }, { term: "列车编组", trade: "客运" }, { term: "加挂", trade: "客运" }, { term: "欠编", trade: "客运" }, 
                { term: "满编", trade: "客运" }, { term: "甩挂", trade: "客运" }, { term: "编组表", trade: "客运" }, { term: "客运规章", trade: "客运" }, 
                { term: "客运记录", trade: "客运" }, { term: "广播通告", trade: "客运" }, { term: "投诉处理", trade: "客运" }, { term: "遗失物品", trade: "客运" }, 
                { term: "重点旅客", trade: "客运" }, { term: "候车室", trade: "客运" }, { term: "出站口", trade: "客运" }, { term: "动车所", trade: "客运" }, 
                { term: "售票厅", trade: "客运" }, { term: "售票窗口", trade: "客运" }, { term: "地道", trade: "客运" }, { term: "天桥", trade: "客运" }, 
                { term: "客整所", trade: "客运" }, { term: "检票口", trade: "客运" }, { term: "行李房", trade: "客运" }, { term: "进站口", trade: "客运" }, 
                { term: "问讯处", trade: "客运" }, { term: "上水工", trade: "客运" }, { term: "列车员", trade: "客运" }, { term: "列车长", trade: "客运" }, 
                { term: "售票员", trade: "客运" }, { term: "客运值班员", trade: "客运" }, { term: "广播员", trade: "客运" }, { term: "检票员", trade: "客运" }, 
                { term: "乘车证", trade: "客运" }, { term: "实名制验证", trade: "客运" }, { term: "改签", trade: "客运" }, { term: "电子客票", trade: "客运" }, 
                { term: "票务系统", trade: "客运" }, { term: "纸质车票", trade: "客运" }, { term: "退票", trade: "客运" }, { term: "包裹运输", trade: "客运" }, 
                { term: "行包", trade: "客运" }, { term: "行包房", trade: "客运" }, { term: "行李托运", trade: "客运" }, { term: "停运", trade: "客运" }, 
                { term: "客流高峰", trade: "客运" }, { term: "旅客乘降", trade: "客运" }, { term: "春运", trade: "客运" }, { term: "晚点", trade: "客运" }, 
                { term: "暑运", trade: "客运" }, { term: "正点", trade: "客运" }, { term: "站车交接", trade: "客运" }, { term: "节假日运输", trade: "客运" }, 
                { term: "运行图调整", trade: "客运" }, { term: "装载机司机", trade: "货运" }, { term: "货检员", trade: "货运" }, 
                { term: "货运值班员", trade: "货运" }, { term: "货运员", trade: "货运" }, { term: "门吊司机", trade: "货运" }, { term: "冷链货物", trade: "货运" }, 
                { term: "危险品货物", trade: "货运" }, { term: "危险货物", trade: "货运" }, { term: "成件包装货物", trade: "货运" }, 
                { term: "散堆装货物", trade: "货运" }, { term: "整车货物", trade: "货运" }, { term: "笨重货物", trade: "货运" }, { term: "篷布", trade: "货运" }, 
                { term: "装载加固", trade: "货运" }, { term: "货物装载方案", trade: "货运" }, { term: "超限货物", trade: "货运" }, 
                { term: "阔大货物", trade: "货运" }, { term: "集装箱", trade: "货运" }, { term: "集装箱货物", trade: "货运" }, { term: "集重货物", trade: "货运" }, 
                { term: "零担货物", trade: "货运" }, { term: "鲜活货物", trade: "货运" }, { term: "人力装卸", trade: "货运" }, { term: "捆绑加固", trade: "货运" }, 
                { term: "散货装卸", trade: "货运" }, { term: "机械装卸", trade: "货运" }, { term: "蓬布苫盖", trade: "货运" }, { term: "装载方案", trade: "货运" }, 
                { term: "货物换装", trade: "货运" }, { term: "危险品检测", trade: "货运" }, { term: "押运", trade: "货运" }, { term: "货物异状", trade: "货运" }, 
                { term: "货物撒漏", trade: "货运" }, { term: "货运事故", trade: "货运" }, { term: "超偏载检测", trade: "货运" }, 
                { term: "超限检测", trade: "货运" }, { term: "仓库", trade: "货运" }, { term: "地磅", trade: "货运" }, { term: "装卸线", trade: "货运" }, 
                { term: "货位", trade: "货运" }, { term: "货场", trade: "货运" }, { term: "货物站台", trade: "货运" }, { term: "轨道衡", trade: "货运" }, 
                { term: "集装箱场", trade: "货运" }, { term: "计费重量", trade: "货运" }, { term: "货物交付", trade: "货运" }, { term: "货物运价", trade: "货运" }, 
                { term: "货物运单", trade: "货运" }, { term: "货票", trade: "货运" }, { term: "运价里程", trade: "货运" }, { term: "到达预报", trade: "货运" }, 
                { term: "卸车", trade: "货运" }, { term: "待卸车", trade: "货运" }, { term: "排空", trade: "货运" }, { term: "日班计划", trade: "货运" }, 
                { term: "空车", trade: "货运" }, { term: "装车", trade: "货运" }, { term: "货运计划", trade: "货运" }, { term: "重车", trade: "货运" }, 
                { term: "供暖管网", trade: "房建" }, { term: "换热站", trade: "房建" }, { term: "空调机房", trade: "房建" }, { term: "通风系统", trade: "房建" }, 
                { term: "锅炉房", trade: "房建" }, { term: "信号楼", trade: "房建" }, { term: "列检所", trade: "房建" }, { term: "工区", trade: "房建" }, 
                { term: "调度楼", trade: "房建" }, { term: "车间", trade: "房建" }, { term: "运转室", trade: "房建" }, { term: "公寓", trade: "房建" }, 
                { term: "单身宿舍", trade: "房建" }, { term: "食堂", trade: "房建" }, { term: "应急照明", trade: "房建" }, { term: "照明系统", trade: "房建" }, 
                { term: "站台照明", trade: "房建" }, { term: "配电室", trade: "房建" }, { term: "候车大厅", trade: "房建" }, { term: "无柱雨棚", trade: "房建" }, 
                { term: "站前广场", trade: "房建" }, { term: "站台雨棚", trade: "房建" }, { term: "站房", trade: "房建" }, { term: "站房结构", trade: "房建" }, 
                { term: "站房面积", trade: "房建" }, { term: "风雨棚", trade: "房建" }, { term: "化粪池", trade: "房建" }, { term: "客车上水栓", trade: "房建" }, 
                { term: "排水管网", trade: "房建" }, { term: "水塔", trade: "房建" }, { term: "水泵房", trade: "房建" }, { term: "消防水池", trade: "房建" }, 
                { term: "给水所", trade: "房建" }, { term: "地面维修", trade: "房建" }, { term: "外墙粉刷", trade: "房建" }, { term: "大修", trade: "房建" }, 
                { term: "屋面防水", trade: "房建" }, { term: "巡检", trade: "房建" }, { term: "房屋维修", trade: "房建" }, { term: "暖通维修", trade: "房建" }, 
                { term: "管道疏通", trade: "房建" }, { term: "配电维修", trade: "房建" }, { term: "限界检查", trade: "房建" }, { term: "围墙", trade: "房建" }, 
                { term: "大门", trade: "房建" }, { term: "硬化面", trade: "房建" }, { term: "绿化", trade: "房建" }, { term: "道路", trade: "房建" }, 
                { term: "侵限", trade: "房建" }, { term: "站台限界", trade: "房建" }, { term: "风雨棚限界", trade: "房建" }, 
                { term: "标准化作业", trade: "综合管理" }, { term: "安全教育", trade: "综合管理" }, { term: "安全考试", trade: "综合管理" }, 
                { term: "安全评估", trade: "综合管理" }, { term: "岗前培训", trade: "综合管理" }, { term: "持证上岗", trade: "综合管理" }, 
                { term: "隐患整改", trade: "综合管理" }, { term: "风险研判", trade: "综合管理" }, { term: "作业门", trade: "综合管理" }, 
                { term: "安全作业区", trade: "综合管理" }, { term: "安全区", trade: "综合管理" }, { term: "下道避车", trade: "综合管理" }, 
                { term: "安全预想", trade: "综合管理" }, { term: "班前点名", trade: "综合管理" }, { term: "班后总结", trade: "综合管理" }, 
                { term: "瞭望", trade: "综合管理" }, { term: "邻线来车", trade: "综合管理" }, { term: "鸣笛", trade: "综合管理" }, 
                { term: "劳动安全", trade: "综合管理" }, { term: "安全红线", trade: "综合管理" }, { term: "安全联控", trade: "综合管理" }, 
                { term: "供电安全距离", trade: "综合管理" }, { term: "建筑限界", trade: "综合管理" }, { term: "机车车辆限界", trade: "综合管理" }, 
                { term: "限界", trade: "综合管理" }, { term: "中间防护员", trade: "综合管理" }, { term: "现场防护员", trade: "综合管理" }, 
                { term: "远端防护员", trade: "综合管理" }, { term: "防护员", trade: "综合管理" }, { term: "驻站联络员", trade: "综合管理" }, 
                { term: "信号旗", trade: "综合管理" }, { term: "停车信号", trade: "综合管理" }, { term: "好了信号", trade: "综合管理" }, 
                { term: "手信号", trade: "综合管理" }, { term: "移动信号", trade: "综合管理" }, { term: "红牌", trade: "综合管理" }, 
                { term: "蓝牌", trade: "综合管理" }, { term: "防护信号", trade: "综合管理" }, { term: "三位一体防护", trade: "综合管理" }, 
                { term: "临时限速", trade: "综合管理" }, { term: "事故调查", trade: "综合管理" }, { term: "应急响应", trade: "综合管理" }, 
                { term: "应急处置", trade: "综合管理" }, { term: "应急演练", trade: "综合管理" }, { term: "应急预案", trade: "综合管理" }, 
                { term: "救援列车", trade: "综合管理" }, { term: "救援起复", trade: "综合管理" }, { term: "行车事故", trade: "综合管理" }, 
                { term: "非正常行车", trade: "综合管理" }, { term: "作业命令", trade: "综合管理" }, { term: "施工作业", trade: "综合管理" }, 
                { term: "施工把关", trade: "综合管理" }, { term: "施工负责人", trade: "综合管理" }, { term: "电气化施工", trade: "综合管理" }, 
                { term: "碰撞试验", trade: "综合管理" }, { term: "维修作业", trade: "综合管理" }, { term: "天窗", trade: "综合管理" }, 
                { term: "天窗点", trade: "综合管理" }, { term: "天窗点外", trade: "综合管理" }, { term: "区间封锁", trade: "综合管理" }, 
                { term: "封锁区间", trade: "综合管理" }, { term: "开通区间", trade: "综合管理" }, { term: "施工封锁", trade: "综合管理" }, 
                { term: "确认车", trade: "综合管理" }, { term: "检查作业", trade: "综合管理" }, { term: "施工计划", trade: "综合管理" }, 
                { term: "维修计划", trade: "综合管理" }, { term: "慢行", trade: "综合管理" }, { term: "慢行地点", trade: "综合管理" }, 
                { term: "慢行处所", trade: "综合管理" }, { term: "撤除限速", trade: "综合管理" }, { term: "邻线限速", trade: "综合管理" }, 
                { term: "阶梯限速", trade: "综合管理" }, { term: "限速", trade: "综合管理" }, { term: "动火作业", trade: "综合管理" }, 
                { term: "动火审批", trade: "综合管理" }, { term: "应急广播", trade: "综合管理" }, { term: "手动报警按钮", trade: "综合管理" }, 
                { term: "消火栓", trade: "综合管理" }, { term: "消防制度", trade: "综合管理" }, { term: "消防报警", trade: "综合管理" }, 
                { term: "消防控制室", trade: "综合管理" }, { term: "消防检查", trade: "综合管理" }, { term: "消防水带", trade: "综合管理" }, 
                { term: "消防水泵", trade: "综合管理" }, { term: "消防演练", trade: "综合管理" }, { term: "消防设施", trade: "综合管理" }, 
                { term: "消防责任人", trade: "综合管理" }, { term: "消防通道", trade: "综合管理" }, { term: "消防隐患", trade: "综合管理" }, 
                { term: "温感探测器", trade: "综合管理" }, { term: "火灾应急", trade: "综合管理" }, { term: "灭火器", trade: "综合管理" }, 
                { term: "烟感探测器", trade: "综合管理" }, { term: "疏散指示", trade: "综合管理" }, { term: "疏散通道", trade: "综合管理" }, 
                { term: "禁烟管理", trade: "综合管理" }, { term: "防火分区", trade: "综合管理" }, { term: "防火门", trade: "综合管理" }, 
                { term: "岗位职责", trade: "综合管理" }, { term: "技术规章", trade: "综合管理" }, 
            ];

            // 加载并迁移词库（旧版纯字符串 → 新版结构化）
            (function loadAndMigrateTerms() {
                let oldTerms = [];
                try {
                    const rawOld = localStorage.getItem('railway_terms_custom');
                    if (rawOld) { oldTerms = JSON.parse(rawOld); if (!Array.isArray(oldTerms)) oldTerms = []; }
                } catch(e) { oldTerms = []; }

                let savedTerms = [];
                try {
                    const rawNew = localStorage.getItem('patch_term_library_v2');
                    if (rawNew) { savedTerms = JSON.parse(rawNew); if (!Array.isArray(savedTerms)) savedTerms = []; }
                } catch(e) { savedTerms = []; }

                const migrated = oldTerms.filter(t => typeof t === 'string' && t.length >= 2).map(term => ({ term, trade: '通用' }));
                const map = new Map();
                DEFAULT_TERMS.forEach(item => map.set(item.term.toLowerCase(), item));
                migrated.forEach(item => map.set(item.term.toLowerCase(), item));
                savedTerms.forEach(item => { if (item && item.term) map.set(item.term.toLowerCase(), item); });
                PATCH_TERM_LIBRARY = Array.from(map.values());
                rebuildTermMap();
                if (oldTerms.length > 0) localStorage.removeItem('railway_terms_custom');
                localStorage.setItem('patch_term_library_v2', JSON.stringify(PATCH_TERM_LIBRARY));
                console.log('[词库] 结构化词库加载完成，共 ' + PATCH_TERM_LIBRARY.length + ' 个术语');
            })();

            // 兼容旧代码（保持全局 RAILWAY_TERMS Set 可用）
            let RAILWAY_TERMS = new Set(PATCH_TERM_LIBRARY.map(i => i.term));
            function syncTermSet() { RAILWAY_TERMS = new Set(PATCH_TERM_LIBRARY.map(i => i.term)); }


            const PATCH_TRADE_KEYWORDS = {
                '车务': ['接发列车', '调车', '进路', '行车凭证', '闭塞', '联控', '防溜', '调度命令',
                        '车机联控', '一度停车', '退行', '推进', '溜放', '司机', '运转', '行车日志',
                        '信号员', '值班员', '助理值班员', '电子运统', '施工登销记', '错办进路',
                        '分路不良', '超限列车', '专特运'],
                '工务': ['线路', '道岔', '钢轨', '轨枕', '道床', '限界', '防护栅栏', '上道作业',
                        '胀轨', '无缝线路', '巡道', '探伤', '轨道几何', '道口', '栅栏', '护网',
                        '路基', '桥隧', '护坡', '排水', '轨距', '水平', '高低', '轨向', '三角坑',
                        '捣固', '清筛', '打磨'],
                '电务': ['信号机', '转辙机', '轨道电路', '联锁', 'CTC', 'LKJ', '机车信号', '电缆',
                        '继电器', '应答器', '列控', '闭塞', '发码', '电源屏', 'TDCS', 'ITCS',
                        '道岔缺口', '密贴力', '表示杆', 'ZPW-2000', '红光带'],
                '供电': ['接触网', '受电弓', '分相', '锚段', '承力索', '隔离开关', 'V停', '停电作业',
                        '验电接地', '绝缘子', '供电线', '分区所', '开闭所', '牵引变', '接触线',
                        '回流线', '架空地线', '保护线', '弓网', '拉出值', '导高', '硬点', '燃弧'],
                '机务': ['机车', '动车组', '制动', '司机', '添乘', 'LKJ', '牵引', '制动机',
                        '走行部', '轮对', '受电弓', '动车', '驾驶', '送车', '接车', '整备',
                        '待乘', '试风', '监控关机', '违章解锁', '冒进', '冒出', '超速'],
                '车辆': ['客车', '货车', '轮对', '闸瓦', '转向架', '轴温', '5T', '列检', '防溜',
                        '制动梁', '车钩', '风管', '缓解阀', '制动机试验', 'TFDS', 'THDS',
                        'TPDS', '切轴', '热轴', '关门车'],
                '货运': ['装载', '加固', '超限', '偏载', '集重', '危险品', '集装箱', '篷布',
                        '轮重测定仪', '货物', '装卸', '货检', '超长货物', '混运', '匿报品名'],
                '通信': ['无线列调', 'CIR', 'GSM-R', '光纤', '漏缆', '直放站', '电源屏', '传输',
                        '数调', '录音', '广播', '综合网管', '纤芯劣化', '误码率'],
                '房建': ['站台', '雨棚', '房屋', '给排水', '围墙', '站房', '天桥', '地道', '限界',
                        '防雷', '侵限', '轻飘物'],
                '通用': []
            };

            function patchInferTrade(query) {
                if (!query) return null;
                const lowerQ = query.toLowerCase();
                const scores = {};
                for (const [trade, keywords] of Object.entries(PATCH_TRADE_KEYWORDS)) {
                    let score = 0;
                    for (const kw of keywords) {
                        if (lowerQ.includes(kw)) {
                            score += Math.min(kw.length, 6);
                        }
                    }
                    if (score > 0) scores[trade] = score;
                }
                const sorted = Object.entries(scores).sort((a, b) => b[1] - a[1]);
                return sorted.length > 0 ? sorted[0][0] : null;
            }

            // HTML转义函数
            function acEscHtml(s) {
                return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#039;');
            }

            // 铁路安监领域违规行为关键词（用于增强关键词提取，捕捉违规描述）
            const VIOLATION_ACTION_WORDS = new Set([
                '违规', '违章', '违反', '不符合', '未按规定', '未按', '擅自',
                '未设置', '未设', '未配备', '未安装', '缺少', '缺失',
                '未确认', '未核实', '未检查', '未核对', '未通知',
                '未经允许', '未经批准', '未经许可', '私自', '无证',
                '超速', '超限', '越区', '越站', '错办',
                '漏办', '误办', '迟办', '未办', '错发', '漏发',
                '未及时', '未按规定时间', '延误', '滞后',
                '未佩戴', '未穿戴', '未使用', '未携带',
                '未下达', '未传达', '未执行', '未落实',
                '未锁闭', '未确认', '未试验', '未检测',
                '未设置防护', '未设防护', '未派人防护', '无人防护',
                '天窗点外', '点外作业', '点外上道',
                '无命令', '无计划', '无防护', '无调度命令',
                '违规上道', '擅自进入', '擅自作业',
                '未消记', '未销令', '未开通',
                '关闭', '短路', '断开', '拆除',
                '未接地', '未断电', '未验电',
                '超载', '超重', '偏载', '集重',
                '分离', '脱轨', '挤岔', '冲突', '追尾',
                '冒进', '冒出', '溜逸', '放飏',
                '未换端', '未换位', '未换室',
                '中断', '错误', '丢失', '遗忘',
            ]);

            // 铁路安监领域扩展停用词表
            const AUTOCHECK_STOP_WORDS = new Set([
                // 通用停用词
                '的', '了', '和', '与', '或', '对', '在', '被', '把', '让', '给', '向', '从', '到',
                '上', '下', '内', '外', '中', '里', '等', '及', '以及', '并且', '而且', '但是',
                '如果', '那么', '因为', '所以', '是', '有', '不', '也', '都', '还', '要', '会',
                '可以', '能', '可能', '应该', '必须', '需要', '这个', '那个', '这些', '那些',
                // 常见连接词
                '进行', '开展', '情况', '相关', '工作', '发现', '存在', '问题',
                '单位', '部门', '领导', '负责', '组织', '实施', '执行',
                // 铁路安监领域无实际检索价值的词
                '第一', '预防', '为主', '综合', '治理', '强化', '落实', '确保', '保障',
                '提高', '加强', '完善', '建立', '健全', '推动', '促进', '实现',
                '车间', '工区', '班组', '职工', '干部', '督查', '巡视',
                '养护', '制度', '措施', '方案', '流程',
                '按照', '根据', '依照', '参照', '依据', '对于', '关于', '针对', '鉴于',
                '操作', '使用', '维护', '保养', '报告', '通知', '办法',
                '细则', '规程', '规则', '条例', '文件', '函', '电报',
                '严重', '一般', '较大', '重大', '特别', '主要', '次要'
            ]);

            // ---- 单位名称判定：匹配以"段"、"站"等结尾，或包含"车间"等词的模式 ----
            function isOrgName(term) {
                if (!term || term.length > 12) return false; // 过长的词可能是描述，保留
                // 明确的单位后缀
                const orgSuffix = term.match(/(段|站|中心|车间|工区|班组|分公司|子公司|处|室)$/);
                if (orgSuffix) return true;
                // 特定模式：高铁基础设施段、车务段、工务段、电务段、供电段、车辆段、机务段、通信段、房建段、货运中心等
                if (/基础设施段|车务段|工务段|电务段|供电段|车辆段|机务段|通信段|房建段|货运中心|高铁基础设施段/.test(term)) return true;
                // 模式："XX站" 且不是专有名词（排除 "会让站" "编组站" "技术站" 这种通用术语）
                if (/站$/.test(term) && !['会让站','编组站','中间站','区段站','越行站'].includes(term)) return true;
                return false;
            }

            // ---- 关键词提取（从结构化词库+违规行为词中筛选，按专业加权） ----
            function acExtractKeywords(text, inferredTrade) {
                const kwSet = new Set();
                const lowerText = text.toLowerCase();

                // 第一类：术语词（结构化词库，按专业+长度加权排序），并过滤掉单位名称
                const scored = [];
                PATCH_TERM_LIBRARY.forEach(function(item) {
                    if (lowerText.includes(item.term.toLowerCase())) {
                        // 跳过单位名称
                        if (isOrgName(item.term)) return;
                        
                        let weight = item.term.length;
                        if (inferredTrade && item.trade === inferredTrade) {
                            weight += 100; // 同专业加权
                        }
                        scored.push({ term: item.term, weight });
                    }
                });
                scored.sort(function(a, b) { return b.weight - a.weight; });
                scored.forEach(function(s) { kwSet.add(s.term); });

                // 第二类：违规行为词
                VIOLATION_ACTION_WORDS.forEach(function(word) {
                    if (lowerText.includes(word.toLowerCase())) {
                        kwSet.add(word);
                    }
                });
                
                // 第三类：同义词扩展
                Object.entries(SYNONYM_MAP).forEach(function([key, syns]) {
                    const keyIncluded = lowerText.includes(key.toLowerCase());
                    if (keyIncluded) {
                        syns.forEach(function(s) { if (lowerText.includes(s.toLowerCase())) kwSet.add(s); });
                    } else {
                        syns.forEach(function(s) {
                            if (lowerText.includes(s.toLowerCase())) { kwSet.add(key); kwSet.add(s); }
                        });
                    }
                });
                
                // 按长度降序，过滤被更长词包含的短词（<=3字）
                const allTokens = Array.from(kwSet).sort(function(a, b) { return b.length - a.length; });
                return allTokens.filter(function(w, i) {
                    if (w.length <= 3) {
                        return !allTokens.slice(0, i).some(function(lg) { return lg.length >= 4 && lg.includes(w); });
                    }
                    return true;
                }).slice(0, 50);
            }

            // ---- 纯词库关键词提取（仅专业术语，不含违规词和同义词）----
            function acExtractLibraryKeywords(text) {
                var lowerText = text.toLowerCase();
                var scored = [];
                PATCH_TERM_LIBRARY.forEach(function(item) {
                    if (lowerText.includes(item.term.toLowerCase())) {
                        if (isOrgName(item.term)) return;
                        scored.push({ term: item.term, weight: item.term.length });
                    }
                });
                scored.sort(function(a, b) { return b.weight - a.weight; });
                // 去重：短词被长词包含则剔除
                var all = scored.map(function(s) { return s.term; });
                return all.filter(function(w, i) {
                    if (w.length <= 3) {
                        return !all.slice(0, i).some(function(lg) { return lg.length >= 4 && lg.includes(w); });
                    }
                    return true;
                });
            }

            // ---- 纯关键词提取（不依赖词库建议，用于检索，严格过滤单位名称） ----
            function acExtractPureKeywords(text) {
                const kwSet = new Set();

                // 1. 提取违规行为关键词
                VIOLATION_ACTION_WORDS.forEach(function(word) {
                    // 确保关键词前后有边界，避免 "未设" 匹配到 "设计" 等
                    const boundaryRegex = new RegExp('(?:^|[^\\w\\d\u4e00-\u9fa5])(' + word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ')(?=[^\\w\\d\u4e00-\u9fa5]|$)', 'i');
                    if (boundaryRegex.test(text)) {
                        kwSet.add(word);
                    }
                });

                // 2. 从词库中提取专业术语，但精确过滤掉单位名称
                PATCH_TERM_LIBRARY.forEach(function(item) {
                    if (text.includes(item.term)) {
                        // 严格过滤单位名称：只保留非单位名称的专业术语
                        if (!isOrgName(item.term)) {
                            kwSet.add(item.term);
                        }
                    }
                });

                // 3. 提取长度大于等于3且不包含在词库中的词组（自然语言关键词）
                // 简单按标点、空格分词，提取有意义的较长词组
                const segments = text.split(/[，。！？、；：""''（）\s]+/);
                segments.forEach(seg => {
                    if (seg.length >= 3 && seg.length <= 12) { // 限制长度，避免长句
                        // 排除纯数字、纯标点
                        if (/^[\d\.\-\+\/]+$/.test(seg)) return;
                        // 作为文本固有词提取
                        kwSet.add(seg);
                    }
                });

                // 最后过滤一遍，确保结果中没有单位名称
                return Array.from(kwSet).filter(kw => !isOrgName(kw));
            }


            // ---- 文本片段高亮关键词命中位置 ----
            function acGetSnippet(content, keywords, maxLen) {
                maxLen = maxLen || 200;
                let bestPos = -1, bestKw = '';
                for (const kw of keywords) {
                    const pos = content.toLowerCase().indexOf(kw);
                    if (pos !== -1 && (bestPos === -1 || kw.length > bestKw.length)) { bestPos = pos; bestKw = kw; }
                }
                if (bestPos === -1) return content.length > maxLen ? content.slice(0, maxLen) + '…' : content;
                const half = Math.floor(maxLen / 2);
                const start = Math.max(0, bestPos - half);
                const end = Math.min(content.length, bestPos + half);
                return (start > 0 ? '…' : '') + content.slice(start, end) + (end < content.length ? '…' : '');
            }

            // ---- 计算文本与关键词的匹配得分 ----
            function acScore(text, titleText, keywords) {
                let score = 0;
                const lc = text.toLowerCase(), tlc = (titleText || '').toLowerCase();
                for (const kw of keywords) {
                    if (lc.includes(kw) || tlc.includes(kw)) {
                        let s = Math.min(3, 1 + kw.length / 3);
                        if (tlc.includes(kw)) s += 2; // 标题命中奖励
                        score += s;
                    }
                }
                return keywords.length ? score / (keywords.length * 4) : 0;
            }

            // ============================================================
            // 核心：两阶段本地匹配
            // 第一阶段：在检查信息中找相似历史案例
            // 第二阶段：基于案例 + 关键词，在规章制度中找对应条款判定违规
            // ============================================================
            
            // 关键词选择状态
            let acSelectedKeywords = new Set();
            let acCandidateKeywords = [];
            let _acInputTimer = null;  // 防抖定时器
            
            // textarea 输入时自动提取候选词
            window.acOnInputChange = function(value) {
                clearTimeout(_acInputTimer);
                const query = value.trim();
                if (!query) {
                    // 输入为空，隐藏候选区并重置
                    const selectArea = document.getElementById('keyword-select-area');
                    if (selectArea) selectArea.style.display = 'none';
                    acCandidateKeywords = [];
                    acSelectedKeywords = new Set();
                    return;
                }
                // 防抖 300ms 后提取
                _acInputTimer = setTimeout(function() {
                    const newCandidates = acExtractKeywords(query, patchInferTrade(query));
                    // 仅当候选词集合变化时才重置选中状态
                    const newSet = new Set(newCandidates);
                    const changed = newCandidates.length !== acCandidateKeywords.length ||
                        newCandidates.some(k => !acCandidateKeywords.includes(k));
                    acCandidateKeywords = newCandidates;
                    if (changed) {
                        // 保留仍在候选列表中的已选词，移除已不在候选中的词
                        const keeping = new Set(Array.from(acSelectedKeywords).filter(k => newSet.has(k)));
                        acSelectedKeywords = keeping;
                    }
                    acShowKeywordSelector(query);
                }, 300);
            };
            
            window.autoCheckLocal = function() {
                const input = document.getElementById('autoCheck-input');
                const query = input.value.trim();
                if (!query) { alert('请输入检查问题描述'); return; }
                
                // 若还没提取过候选词，先提取一次
                if (acCandidateKeywords.length === 0) {
                    acCandidateKeywords = acExtractKeywords(query, patchInferTrade(query));
                }
                
                // 若有已选关键词则用已选的，否则用全部候选词；若候选词也为空则提示
                let keywords = Array.from(acSelectedKeywords);
                if (keywords.length === 0) {
                    keywords = [...acCandidateKeywords];
                }
                if (keywords.length === 0) {
                    alert('未匹配到词库关键词，请手动添加关键词后再匹配');
                    return;
                }
                
                // 将关键词加入词库
                acAddKeywordsToLibrary(keywords);
                // 执行匹配
                acDoLocalMatch(keywords);
                // 标记本地匹配已完成，锁定按钮为AI对规
                _acHasLocalResult = true;
            };
            
            // 显示关键词选择界面
            function acShowKeywordSelector(query) {
                const selectArea = document.getElementById('keyword-select-area');
                const countEl = document.getElementById('keyword-select-count');
                
                if (!selectArea) return;
                
                // 渲染候选关键词
                acRenderCandidateList();
                
                // 渲染已选关键词
                acRenderSelectedList();
                
                // 显示选择区域
                selectArea.style.display = 'block';
                
                // 更新计数
                countEl.textContent = '已选: ' + acSelectedKeywords.size + '/4';
                
                // 隐藏结果区域
                document.getElementById('autoCheck-results').style.display = 'none';
            }
            
            // 渲染候选关键词列表（上栏，点击选中/取消）
            function acRenderCandidateList() {
                const list = document.getElementById('keyword-candidate-list');
                if (!list) return;
                
                let html = '';
                acCandidateKeywords.forEach((kw) => {
                    const isSelected = acSelectedKeywords.has(kw);
                    if (isSelected) {
                        // 已选中状态：蓝色高亮，点击取消
                        html += '<span class="keyword-candidate-tag" data-keyword="' + acEscHtml(kw) + '" ' +
                            'style="' +
                            'display:inline-flex;align-items:center;padding:6px 10px;border-radius:16px;font-size:0.85rem;' +
                            'cursor:pointer;transition:all 0.15s;user-select:none;' +
                            'background:var(--primary);color:#fff;border:2px solid var(--primary);' +
                            '" ' +
                            'onclick="acToggleCandidateKeyword(\'' + acEscHtml(kw) + '\')" ' +
                            'title="点击取消选中" ' +
                            '>' + acEscHtml(kw) + ' <span style="margin-left:4px;font-size:0.75rem;">✓</span></span>';
                    } else {
                        // 未选中状态：灰色，点击选中
                        html += '<span class="keyword-candidate-tag" data-keyword="' + acEscHtml(kw) + '" ' +
                            'style="' +
                            'display:inline-flex;align-items:center;padding:6px 10px;border-radius:16px;font-size:0.85rem;' +
                            'cursor:pointer;transition:all 0.15s;user-select:none;' +
                            'background:#f1f5f9;color:var(--text);border:2px solid #e2e8f0;' +
                            '" ' +
                            'onclick="acToggleCandidateKeyword(\'' + acEscHtml(kw) + '\')" ' +
                            'title="点击选中" ' +
                            'onmouseover="if(!this.dataset.selected){this.style.background=\'#e2e8f0\';this.style.borderColor=\'var(--primary)\';}" ' +
                            'onmouseout="if(!this.dataset.selected){this.style.background=\'#f1f5f9\';this.style.borderColor=\'#e2e8f0\';}" ' +
                            '>' + acEscHtml(kw) + ' <span style="margin-left:4px;font-size:0.75rem;opacity:0.5;">+</span></span>';
                    }
                });
                
                if (acCandidateKeywords.length === 0) {
                    html = '<span style="color:var(--text-secondary);font-size:0.8rem;padding:4px;">输入文本未匹配到词库中的术语，请手动添加或导入词库</span>';
                }
                
                list.innerHTML = html;
            }
            
            // 切换候选词选中状态
            window.acToggleCandidateKeyword = function(kw) {
                if (acSelectedKeywords.has(kw)) {
                    acSelectedKeywords.delete(kw);
                } else {
                    if (acSelectedKeywords.size >= 4) {
                        alert('最多选择4个关键词');
                        return;
                    }
                    acSelectedKeywords.add(kw);
                    acAddKeywordsToLibrary([kw]);
                }
                acRenderCandidateList();
                acRenderSelectedList();
                document.getElementById('keyword-select-count').textContent = '已选: ' + acSelectedKeywords.size + '/4';
            };
            
            // 渲染已选关键词列表（下栏，点击取消）
            function acRenderSelectedList() {
                const list = document.getElementById('keyword-selected-list');
                if (!list) return;
                
                let html = '';
                acSelectedKeywords.forEach((kw) => {
                    html += '<span class="keyword-selected-tag" data-keyword="' + acEscHtml(kw) + '" ' +
                        'style="' +
                        'display:inline-flex;align-items:center;padding:6px 10px;border-radius:16px;font-size:0.85rem;' +
                        'cursor:pointer;transition:all 0.15s;user-select:none;' +
                        'background:var(--primary);color:#fff;border:2px solid var(--primary);' +
                        '" ' +
                        'onclick="acRemoveSelectedKeyword(\'' + acEscHtml(kw) + '\')" ' +
                        'title="点击移除" ' +
                        'onmouseover="this.style.opacity=\'0.8\'" ' +
                        'onmouseout="this.style.opacity=\'1\'" ' +
                        '>' + acEscHtml(kw) + ' <span style="margin-left:4px;font-size:0.75rem;">✕</span></span>';
                });
                
                list.innerHTML = html || '<span style="color:var(--text-secondary);font-size:0.8rem;padding:4px;">点击上方候选词选中...</span>';
            }
            
            // 添加自定义关键词
            window.acAddCustomKeyword = function() {
                const input = document.getElementById('keyword-custom-input');
                const kw = input.value.trim();
                if (!kw) return;
                if (kw.length < 2) {
                    alert('关键词至少需要2个字符');
                    return;
                }
                if (acSelectedKeywords.size >= 4) {
                    alert('最多选择4个关键词');
                    return;
                }
                
                // 添加到已选，如果不在候选里也追加到候选
                acSelectedKeywords.add(kw);
                if (!acCandidateKeywords.includes(kw)) {
                    acCandidateKeywords.push(kw);
                }
                
                // 清空输入
                input.value = '';
                
                // 重新渲染两栏
                acRenderCandidateList();
                acRenderSelectedList();
                document.getElementById('keyword-select-count').textContent = '已选: ' + acSelectedKeywords.size + '/4';
                
                // 自动添加到词库
                acAddKeywordsToLibrary([kw]);
            };
            
            // 移除已选关键词（同步刷新候选词选中状态）
            window.acRemoveSelectedKeyword = function(keyword) {
                acSelectedKeywords.delete(keyword);
                acRenderCandidateList();
                acRenderSelectedList();
                document.getElementById('keyword-select-count').textContent = '已选: ' + acSelectedKeywords.size + '/4';
            };
            
            // 清空已选关键词
            window.acClearSelectedKeywords = function() {
                acSelectedKeywords.clear();
                acRenderCandidateList();
                acRenderSelectedList();
                document.getElementById('keyword-select-count').textContent = '已选: 0/4';
            };
            
            // 确认关键词并开始匹配
            window.acConfirmKeywords = function() {
                if (acSelectedKeywords.size === 0) {
                    alert('请至少选择1个关键词');
                    return;
                }
                // 将选中的关键词添加到词库
                acAddKeywordsToLibrary(Array.from(acSelectedKeywords));
                // 执行匹配
                acDoLocalMatch(Array.from(acSelectedKeywords));
            };
            
            // 将关键词添加到词库
            function acAddKeywordsToLibrary(keywords) {
                let addedCount = 0;
                keywords.forEach(kw => {
                    if (!RAILWAY_TERMS.has(kw)) {
                        RAILWAY_TERMS.add(kw);
                        const item = { term: kw, trade: '通用' };
                        if (!PATCH_TERM_LIBRARY.some(i => i.term === kw)) {
                            PATCH_TERM_LIBRARY.push(item);
                        }
                        addedCount++;
                    }
                });
                
                if (addedCount > 0) {
                    localStorage.setItem('patch_term_library_v2', JSON.stringify(PATCH_TERM_LIBRARY));
                    syncTermSet();
                    console.log('已自动添加 ' + addedCount + ' 个关键词到词库:', keywords);
                }
            }
            
            // 执行本地匹配（使用选中的关键词）
            function acDoLocalMatch(keywords) {
                // 显示加载中
                const container = document.getElementById('autoCheck-results');
                container.innerHTML = '<div style="display:flex;align-items:center;gap:12px;padding:20px;color:var(--text-secondary);"><div class="spinner" style="width:20px;height:20px;border:2px solid var(--border);border-top-color:var(--primary);border-radius:50%;animation:spin 0.8s linear infinite;flex-shrink:0;"></div><span>正在使用关键词 [' + keywords.join(', ') + '] 进行匹配...</span></div>';
                container.style.display = 'block';
                
                // 延迟执行，让UI更新
                setTimeout(() => {
                    acPerformMatching(keywords);
                }, 100);
            }
            
            // 实际执行匹配逻辑（调用各模块关键词搜索逻辑）
            function acPerformMatching(keywords) {
                const container = document.getElementById('autoCheck-results');

                // ---------- 检查数据源是否为空 ----------
                const issues = typeof window.getIssueData === 'function' ? window.getIssueData() : [];
                let rules = typeof window.getRulesData === 'function' ? window.getRulesData() : [];
                const handbooks = typeof window.getHandbookData === 'function' ? window.getHandbookData() : [];
                if (issues.length === 0 && rules.length === 0 && handbooks.length === 0) {
                    container.innerHTML = '<div style="text-align:center;padding:24px;color:var(--text-secondary);"><div style="font-size:2rem;margin-bottom:8px;">📭</div><p>检查信息、规章制度、检查手册均为空</p><p style="font-size:0.85rem;margin-top:8px;">请先在对应模块导入数据后再使用自动对规功能</p></div>';
                    container.style.display = 'block'; return;
                }

                // ── 专业推断：同专业规章优先排序（直接用 r.trade 字段） ──
                const _pmQuery = document.getElementById('autoCheck-input') ? document.getElementById('autoCheck-input').value.trim() : '';
                const _pmTrade = patchInferTrade(_pmQuery);
                if (_pmTrade && rules.length > 0) {
                    const sameTrade = rules.filter(function(r) { return r.trade === _pmTrade; });
                    const otherTrade = rules.filter(function(r) { return r.trade !== _pmTrade || !r.trade; });  // 缺失 trade 归入"其他"
                    rules = sameTrade.concat(otherTrade);
                    console.log('[专业过滤] 推断专业:', _pmTrade, '同专业规章数:', sameTrade.length, '其他:', otherTrade.length);
                }

                const lowerKws = keywords.map(function(k) { return k.toLowerCase(); });
                const kwTotal = lowerKws.length;

                // ---------- 匹配检查信息（OR模式 + 权重评分）----------
                // 改进：OR模式（至少命中1个词即可），按命中数量和权重综合排序
                const matchedIssues = issues.map(function(iss) {
                    var text = ((iss.content || '') + ' ' + (iss.category || '') + ' ' + (iss['性质'] || '')).toLowerCase();
                    var matchedKws = lowerKws.filter(function(k) { return text.includes(k); });
                    var matchCount = matchedKws.length;
                    if (matchCount === 0) return null;
                    // 权重评分：术语词命中权重高于行为词
                    var score = 0;
                    matchedKws.forEach(function(k) {
                        var origKw = keywords[lowerKws.indexOf(k)] || k;
                        if (VIOLATION_ACTION_WORDS.has(origKw)) {
                            score += 1.5; // 行为词权重
                        } else if (RAILWAY_TERMS.has(origKw)) {
                            score += 2;   // 术语词权重更高
                        } else {
                            score += 1;   // 其他词
                        }
                    });
                    // 标题/类别命中额外加分
                    var titleText = (iss.category || '').toLowerCase();
                    matchedKws.forEach(function(k) {
                        if (titleText.includes(k)) score += 1;
                    });
                    return { iss: iss, matchCount: matchCount, matchRate: Math.round((matchCount / kwTotal) * 100), score: score };
                }).filter(function(x) { return x !== null; })
                  .sort(function(a, b) { return b.score - a.score || b.matchCount - a.matchCount || b.matchRate - a.matchRate; })
                  .slice(0, 10);

                // ---------- 匹配规章制度（OR模式 + BM25加权）----------
                // 改进：OR模式（段落命中任意关键词即可参与评分），使用BM25加权
                const matchedRules = [];
                rules.forEach(function(r) {
                    if (typeof generateRuleSnippet === 'function') {
                        // 先尝试 AND 模式精确匹配
                        var snippetHtml = generateRuleSnippet(r, keywords, -1, 'and');
                        if (snippetHtml) {
                            var matchScore = typeof calculateMatchScore === 'function' 
                                ? calculateMatchScore(r, keywords, 'and') : 1;
                            matchedRules.push({ rule: r, snippetHtml: snippetHtml, matchScore: matchScore * 3, mode: 'and' });
                        } else {
                            // AND 匹配失败后，尝试 OR 模式宽松匹配
                            snippetHtml = generateRuleSnippet(r, keywords, -1, 'or');
                            if (snippetHtml) {
                                var orScore = typeof calculateMatchScore === 'function' 
                                    ? calculateMatchScore(r, keywords, 'or') : 0.5;
                                // OR 模式按命中关键词比例计算得分
                                var ruleText = (r.content || '').toLowerCase();
                                var hitKws = lowerKws.filter(function(k) { return ruleText.includes(k); });
                                var orWeight = hitKws.length / kwTotal;
                                matchedRules.push({ rule: r, snippetHtml: snippetHtml, matchScore: orScore * orWeight, mode: 'or' });
                            }
                        }
                    } else {
                        // 回退：OR匹配 + 关键词覆盖率评分
                        var text = (r.content || '').toLowerCase();
                        var titleLc = (r.title || '').toLowerCase();
                        var hitCount = 0;
                        lowerKws.forEach(function(k) {
                            if (text.includes(k) || titleLc.includes(k)) hitCount++;
                        });
                        if (hitCount > 0) {
                            matchedRules.push({ rule: r, snippetHtml: null, matchScore: hitCount / kwTotal, mode: 'or' });
                        }
                    }
                });
                // 排序：AND模式优先，同模式按得分排序
                matchedRules.sort(function(a, b) {
                    if (a.mode !== b.mode) return a.mode === 'and' ? 1 : -1; // and 优先
                    return b.matchScore - a.matchScore;
                });
                var scoredRules = matchedRules.slice(0, 10);

                // ---------- 匹配检查手册（分级匹配：核心词AND + 行为词OR）----------
                // 改进：区分术语词（要求AND）和行为词（OR加分）
                var termKws = lowerKws.filter(function(k) {
                    var orig = keywords[lowerKws.indexOf(k)] || k;
                    return RAILWAY_TERMS.has(orig) || orig.length >= 4;
                });
                var actionKws = lowerKws.filter(function(k) {
                    var orig = keywords[lowerKws.indexOf(k)] || k;
                    return VIOLATION_ACTION_WORDS.has(orig);
                });

                var matchedHb = handbooks.map(function(h) {
                    var text = ([h.chapter, h.section, h.item, h.subitem, h.content].filter(Boolean).join(' ')).toLowerCase();
                    // 术语词：AND模式（全部命中为佳）
                    var termHits = termKws.length > 0 ? termKws.filter(function(k) { return text.includes(k); }).length : 0;
                    // 行为词：OR模式（命中任一即加分）
                    var actionHits = actionKws.length > 0 ? actionKws.filter(function(k) { return text.includes(k); }).length : 0;
                    // 总命中
                    var totalHits = lowerKws.filter(function(k) { return text.includes(k); }).length;
                    if (totalHits === 0) return null;

                    // 综合评分：术语覆盖率 * 60% + 行为词命中 * 30% + 总覆盖率 * 10%
                    var termCoverage = termKws.length > 0 ? termHits / termKws.length : 0;
                    var actionBonus = actionKws.length > 0 ? Math.min(1, actionHits / Math.max(1, actionKws.length)) : 0;
                    var overallCoverage = totalHits / kwTotal;
                    var compositeScore = termCoverage * 0.6 + actionBonus * 0.3 + overallCoverage * 0.1;

                    return {
                        hb: h, matchCount: totalHits, matchRate: Math.round(overallCoverage * 100),
                        score: compositeScore,
                        title: [h.chapter, h.section, h.item, h.subitem].filter(Boolean).join(' > ')
                    };
                }).filter(function(x) { return x !== null; })
                  .sort(function(a, b) { return b.score - a.score || b.matchCount - a.matchCount; })
                  .slice(0, 8);

                // ---------- 渲染结果 ----------
                const hasAny = matchedIssues.length || scoredRules.length || matchedHb.length;
                if (!hasAny) {
                    container.innerHTML = '<div style="text-align:center;padding:24px;color:var(--text-secondary);"><div style="font-size:2rem;margin-bottom:8px;">🔍</div><p>未找到匹配内容，建议调整关键词或换用「AI 对规」</p></div>';
                    container.style.display = 'block'; return;
                }

                let html = '';
                const kwsUsed = keywords.map(function(k) {
                    var isAction = VIOLATION_ACTION_WORDS.has(k);
                    var bg = isAction ? '#fecaca;color:#991b1b' : '#fde68a;color:#92400e';
                    var tag = isAction ? '行为' : '术语';
                    return '<span style="background:' + bg + ';padding:1px 6px;border-radius:10px;font-size:0.78rem;" title="' + tag + '">' + acEscHtml(k) + '</span>';
                }).join(' ');
                html += '<div style="margin-bottom:12px;font-size:0.8rem;color:var(--text-secondary);">关键词：' + kwsUsed + '</div>';

                // —— 检查信息匹配结果（检查信息卡片风格）——
                if (matchedIssues.length) {
                    html += '<div style="margin-bottom:6px;">'
                        + '<span style="font-size:0.8rem;font-weight:700;color:#b45309;background:#fef3c7;padding:3px 10px;border-radius:20px;">📂 相似历史案例（' + matchedIssues.length + '条）</span>'
                        + '</div>';
                    html += '<div style="display:flex;flex-direction:column;gap:6px;margin-bottom:14px;">';
                    matchedIssues.forEach(function(x, idx) {
                        const iss = x.iss;
                        const xz = String(iss['性质'] || '').trim();
                        let levelBorderColor = '#718096', xzBg = '#718096';
                        if (xz === 'A类' || xz.includes('A')) { levelBorderColor = '#e53e3e'; xzBg = '#e53e3e'; }
                        else if (xz === '红线' || xz.includes('红线')) { levelBorderColor = '#e53e3e'; xzBg = '#c53030'; }
                        else if (xz === 'B类' || xz.includes('B')) { levelBorderColor = '#d97706'; xzBg = '#d97706'; }
                        else if (xz === 'C类' || xz.includes('C')) { levelBorderColor = '#059669'; xzBg = '#059669'; }
                        // 高亮关键词
                        let contentHtml = acEscHtml(iss.content || '');
                        lowerKws.forEach(function(k) {
                            const reg = new RegExp('(' + k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ')', 'gi');
                            contentHtml = contentHtml.replace(reg, '<span class="highlight">$1</span>');
                        });
                        // OR 模式描述
                        var modeDesc = x.matchCount + '/' + kwTotal + '词命中';
                        html += '<div class="result-card" style="border-left:4px solid ' + levelBorderColor + ';background:#fffbeb;">'
                            + '<div class="match-badge">' + modeDesc + ' 综合分' + Math.round(x.score * 10) / 10 + '</div>'
                            + '<div class="result-header">'
                            + '<span class="tag tag-xingzhi" style="background:' + xzBg + ';color:#fff;">' + acEscHtml(xz || '空白') + '</span>'
                            + '<span class="tag tag-category">' + acEscHtml(iss.category || '其他') + '</span>'
                            + (iss.datetime ? '<span class="tag tag-time">📅 ' + acEscHtml(iss.datetime) + '</span>' : '')
                            + '</div>'
                            + '<div class="result-content"><div class="result-content-header"><button class="btn-copy" onclick="acIssueDetailModal(' + idx + ')">📄 全文</button></div>'
                            + '<div class="result-text">' + contentHtml + '</div></div>'
                            + '</div>';
                    });
                    html += '</div>';
                }

                // —— 规章制度匹配结果 ——
                if (scoredRules.length) {
                    html += '<div style="margin-bottom:6px;">'
                        + '<span style="font-size:0.8rem;font-weight:700;color:#1d4ed8;background:#dbeafe;padding:3px 10px;border-radius:20px;">⚖️ 相关规章条款（' + scoredRules.length + '条）</span>'
                        + '</div>';
                    html += '<div class="result-list" style="margin-bottom:14px;">';
                    // 搜索条件提示
                    var modeLabel = scoredRules.some(function(x) { return x.mode === 'and'; }) ? '优先精确匹配' : '宽松匹配';
                    html += '<div style="margin-bottom:10px;padding:10px 14px;background:#f0f9ff;border:1px solid #bae6fd;border-radius:8px;font-size:0.88rem;color:#0369a1;">'
                        + '<strong>🔍 匹配模式：</strong>'
                        + '<span style="margin-left:6px;padding:3px 8px;background:#fff;border-radius:4px;border:1px solid #7dd3fc;">' + modeLabel + '</span>'
                        + '<span style="margin-left:8px;">' + keywords.map(function(k) { return '<span style="padding:2px 7px;background:#e0f2fe;border-radius:4px;margin-right:3px;">' + acEscHtml(k) + '</span>'; }).join('') + '</span>'
                        + '</div>';
                    scoredRules.forEach(function(x, idx) {
                        const r = x.rule;
                        const rData = typeof window.getRulesData === 'function' ? window.getRulesData() : [];
                        const absIdx = rData.findIndex(function(rr) { return rr === r; });
                        const matchCount = (x.snippetHtml && x.snippetHtml.match(/<p>/g) || []).length;
                        var modeTag = x.mode === 'and' 
                            ? '<span style="color:#059669;font-weight:600;">✓ 精确匹配</span>'
                            : '<span style="color:#d97706;font-weight:600;">◈ 部分匹配</span>';
                        html += '<div class="rule-card-item">';
                        html += '<div class="rule-title" style="cursor:pointer;display:flex;align-items:center;justify-content:space-between;gap:8px;" onclick="' + (absIdx !== -1 ? 'ruleViewFullText(' + absIdx + ')' : 'acRuleDetailModal(' + idx + ')') + '">';
                        html += '<span style="flex:1;word-break:break-all;white-space:normal;color:var(--info);text-decoration:underline;text-underline-offset:3px;" title="' + acEscHtml(r.title || '') + '">' + acEscHtml(r.title || '') + '</span>';
                        html += '<button class="btn btn-info btn-small" style="flex-shrink:0;" onclick="event.stopPropagation();' + (absIdx !== -1 ? 'ruleViewFullText(' + absIdx + ')' : 'acRuleDetailModal(' + idx + ')') + '">📄 查看全文</button>';
                        html += '</div>';
                        if (r.trade) html += '<span class="rule-trade">' + acEscHtml(r.trade) + '</span>';
                        html += '<div class="rule-match-info" style="font-size:0.8rem;color:#64748b;margin-bottom:8px;padding:4px 8px;background:#f1f5f9;border-radius:4px;display:inline-block;">✓ 匹配 ' + matchCount + ' 个段落 &nbsp;' + modeTag + '</div>';
                        html += '<div class="rule-snippet">' + (x.snippetHtml || acEscHtml((r.content || '').slice(0, 200)) + '…') + '</div>';
                        html += '</div>';
                    });
                    html += '</div>';
                }

                // —— 检查手册匹配结果 ——
                if (matchedHb.length) {
                    html += '<div style="margin-bottom:6px;">'
                        + '<span style="font-size:0.8rem;font-weight:700;color:#065f46;background:#d1fae5;padding:3px 10px;border-radius:20px;">📋 检查手册条目（' + matchedHb.length + '条）</span>'
                        + '</div>';
                    html += '<div style="display:flex;flex-direction:column;gap:6px;">';
                    matchedHb.forEach(function(x) {
                        let contentHtml = acEscHtml(x.hb.content || '');
                        lowerKws.forEach(function(k) {
                            const reg = new RegExp('(' + k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ')', 'gi');
                            contentHtml = contentHtml.replace(reg, '<span class="highlight">$1</span>');
                        });
                        var scoreDesc = Math.round(x.score * 100) + '%相关';
                        html += '<div class="result-card" style="border-left:4px solid var(--success);background:#f0fdf4;">'
                            + '<div class="result-header">'
                            + '<span class="tag" style="background:var(--success);color:#fff;">📋 手册</span>'
                            + '<span class="tag" style="color:#065f46;background:#a7f3d0;">' + acEscHtml(x.hb.chapter || '') + '</span>'
                            + '<span style="font-size:0.72rem;color:#065f46;background:#dcfce7;padding:1px 6px;border-radius:10px;">' + scoreDesc + '</span>'
                            + '</div>'
                            + '<div style="font-size:0.8rem;color:#065f46;margin-bottom:4px;font-weight:600;">' + acEscHtml(x.title) + '</div>'
                            + '<div class="result-content"><div class="result-text">' + contentHtml + '</div></div>'
                            + '</div>';
                    });
                    html += '</div>';
                }

                // ── 结果置信度说明 ──
                html += '<div style="margin-top:12px;padding:10px 14px;background:#f8fafc;border-radius:8px;font-size:0.78rem;color:var(--text-secondary);border:1px solid #e2e8f0;">';
                html += '💡 <strong>结果说明：</strong>本地匹配基于关键词检索，仅展示与输入描述相关的内容供参考，不代表最终对规结论。如需精准对规，请使用「AI 对规」功能。';
                html += '</div>';

                container.innerHTML = html;
                container.style.display = 'block';
                window._lastACIssues = matchedIssues;
                window._lastACRules = scoredRules;
            };

            window.acIssueDetailModal = function(idx) {
                const list = window._lastACIssues;
                if (!list || !list[idx]) return;
                const iss = list[idx].iss;
                alert('【检查信息】\n性质：' + (iss['性质'] || '') + '\n类别：' + (iss.category || '') + '\n时间：' + (iss.datetime || '') + '\n\n' + (iss.content || ''));
            };

            window.acRuleDetailModal = function(idx) {
                const list = window._lastACRules;
                if (!list || !list[idx]) return;
                const r = list[idx].rule;
                if (typeof window.ruleViewFullText === 'function') {
                    const rData = typeof window.getRulesData === 'function' ? window.getRulesData() : [];
                    const rIdx = rData.findIndex(function(x) { return x === r; });
                    if (rIdx !== -1) { window.ruleViewFullText(rIdx); return; }
                }
                alert('【规章制度】' + (r.trade ? '（' + r.trade + '）' : '') + '\n' + (r.title || '') + '\n\n' + (r.content || '').replace(/<[^>]+>/g, ''));
            };

            // 向后兼容旧名称
            window.acViewIssueDetail = window.acIssueDetailModal;
            window.acViewRuleDetail = window.acRuleDetailModal;

            // ============================================================
            // BM25 倒排索引与评分
            // ============================================================
            const BM25_K1 = 1.5, BM25_B = 0.75;
            let _bm25Index = null; // 延迟构建

            function bm25Tokenize(text) {
                const tokens = new Set();
                // 第一步：术语感知分词（优先匹配完整术语，避免拆散）
                const lowerText = text.toLowerCase();
                const sortedTerms = Array.from(RAILWAY_TERMS).sort(function(a, b) { return b.length - a.length; });
                var usedRanges = []; // 记录已匹配的字符范围
                sortedTerms.forEach(function(term) {
                    var pos = 0;
                    while (true) {
                        var idx = lowerText.indexOf(term.toLowerCase(), pos);
                        if (idx === -1) break;
                        var end = idx + term.length;
                        // 检查是否与已匹配范围重叠
                        var overlap = usedRanges.some(function(r) { return idx < r[1] && end > r[0]; });
                        if (!overlap) {
                            tokens.add(term.toLowerCase());
                            usedRanges.push([idx, end]);
                        }
                        pos = idx + 1;
                        if (usedRanges.length > 200) break; // 安全限制
                    }
                });
                // 第二步：对未覆盖的文本部分做 N-gram 分词
                // 标记所有已覆盖的位置
                var covered = new Array(text.length).fill(false);
                usedRanges.forEach(function(r) { for (var i = r[0]; i < r[1]; i++) covered[i] = true; });
                // 提取未覆盖的连续中文段落
                var uncovered = '';
                for (var i = 0; i < text.length; i++) {
                    if (!covered[i]) {
                        var ch = text[i];
                        if (/[\u4e00-\u9fa5]/.test(ch)) uncovered += ch;
                        else {
                            // 非中文字符：如果前面有积累的中文，做分词
                            if (uncovered.length >= 2) {
                                for (var len = 2; len <= Math.min(4, uncovered.length); len++) {
                                    for (var j = 0; j <= uncovered.length - len; j++) {
                                        tokens.add(uncovered.slice(j, j + len));
                                    }
                                }
                            }
                            uncovered = '';
                            // 英文/数字 token
                            if (/[a-zA-Z0-9]/.test(ch)) tokens.add(ch.toLowerCase());
                        }
                    } else {
                        if (uncovered.length >= 2) {
                            for (var len = 2; len <= Math.min(4, uncovered.length); len++) {
                                for (var j = 0; j <= uncovered.length - len; j++) {
                                    tokens.add(uncovered.slice(j, j + len));
                                }
                            }
                        }
                        uncovered = '';
                    }
                }
                if (uncovered.length >= 2) {
                    for (var len = 2; len <= Math.min(4, uncovered.length); len++) {
                        for (var j = 0; j <= uncovered.length - len; j++) {
                            tokens.add(uncovered.slice(j, j + len));
                        }
                    }
                }
                // 去停用词
                return Array.from(tokens).filter(function(t) { return !AUTOCHECK_STOP_WORDS.has(t); });
            }

            // 建索引专用极简分词：纯2-gram，不遍历术语集，速度快10倍
            function bm25TokenizeFast(text) {
                const tokens = new Set();
                const t = text.toLowerCase();
                for (let i = 0; i < t.length - 1; i++) {
                    const ch = t[i];
                    if (/[\u4e00-\u9fa5]/.test(ch)) {
                        tokens.add(t.slice(i, i + 2));
                        if (i + 2 < t.length && /[\u4e00-\u9fa5]/.test(t[i+1])) {
                            // 3-gram可选，跳过以保证速度
                        }
                    } else if (/[a-z0-9]/.test(ch)) {
                        tokens.add(ch);
                    }
                }
                return tokens;
            }

            function buildBM25Index(docs) {
                const df = {}, idf = {}, docLens = [], avgLen = { v: 0 };
                const N = docs.length;
                docs.forEach((doc, i) => {
                    // 建索引用快速分词，不遍历术语集，避免大规章库卡顿
                    const tokens = bm25TokenizeFast(doc._text || '');
                    docLens[i] = tokens.size;
                    tokens.forEach(t => { df[t] = (df[t] || 0) + 1; });
                });
                avgLen.v = docLens.reduce((s, l) => s + l, 0) / Math.max(N, 1);
                Object.keys(df).forEach(t => {
                    idf[t] = Math.log((N - df[t] + 0.5) / (df[t] + 0.5) + 1);
                });
                return { docs, df, idf, docLens, avgLen, N };
            }

            function bm25Score(idx, queryTokens, docI) {
                // queryTokens: 预分好的token数组，避免每条规章重复分词
                const qTokens = queryTokens;
                const doc = idx.docs[docI];
                const docText = doc._text || '';
                const dl = idx.docLens[docI];
                const avgDl = idx.avgLen.v;
                let score = 0;
                qTokens.forEach(t => {
                    if (!t) return;
                    const idf = idx.idf[t] || 0;
                    if (idf === 0 && !docText.includes(t)) return; // 快速跳过不可能匹配的token
                    // TF 用出现次数近似
                    let tf = 0;
                    let pos = 0;
                    while ((pos = docText.indexOf(t, pos)) !== -1) { tf++; pos += t.length; }
                    if (tf === 0) return; // 该token未出现，跳过
                    const tfN = (tf * (BM25_K1 + 1)) / (tf + BM25_K1 * (1 - BM25_B + BM25_B * dl / Math.max(avgDl, 1)));
                    score += idf * tfN;
                });
                return score;
            }

            function localBM25Recall(query, topK) {
                topK = topK || 6;
                const rules = typeof window.getRulesData === 'function' ? window.getRulesData() : [];
                if (!rules.length) return [];

                // 【性能优化】彻底放弃BM25索引，改用简单关键词匹配，速度等同本地匹配
                // 提取查询关键词（2字以上中文词）
                const kwSet = new Set();
                const qLower = query.toLowerCase();
                // 提取2-4字中文词组
                for (let i = 0; i < qLower.length - 1; i++) {
                    if (/[\u4e00-\u9fa5]/.test(qLower[i])) {
                        for (let len = 2; len <= Math.min(4, qLower.length - i); len++) {
                            kwSet.add(qLower.slice(i, i + len));
                        }
                    }
                }
                const kws = Array.from(kwSet);
                if (!kws.length) return [];

                const scored = [];
                for (let i = 0; i < rules.length; i++) {
                    const r = rules[i];
                    const text = ((r.title || '') + ' ' + (r.content || '').replace(/<[^>]+>/g, '')).slice(0, 1000).toLowerCase();
                    let s = 0;
                    kws.forEach(k => { if (text.includes(k)) s++; });
                    if (s > 0) scored.push({ i, s });
                }
                const scores = scored.sort((a, b) => b.s - a.s).slice(0, topK);
                return scores.map(x => {
                    const r = rules[x.i];
                    const rawText = (r.content || '').replace(/<[^>]+>/g, '');
                    return {
                        title: r.title || '',
                        trade: r.trade || '',
                        snippet: rawText.slice(0, 220) + (rawText.length > 220 ? '…' : ''),
                        fullText: rawText,
                        score: x.s,
                        ruleRef: r,
                        ruleIdx: x.i
                    };
                });
            }

            // 支持自定义规则库的 BM25 召回（专业优先检索用）
            function localBM25RecallWithRules(query, topK, ruleSubset) {
                if (!ruleSubset || ruleSubset.length === 0) return [];
                topK = topK || 6;
                var kwSet = new Set();
                var qLower = query.toLowerCase();
                for (var i = 0; i < qLower.length - 1; i++) {
                    if (/[\u4e00-\u9fa5]/.test(qLower[i])) {
                        for (var len = 2; len <= Math.min(4, qLower.length - i); len++) {
                            kwSet.add(qLower.slice(i, i + len));
                        }
                    }
                }
                var kws = Array.from(kwSet);
                if (!kws.length) return ruleSubset.slice(0, topK).map(function(r){ return { title: r.title||'', trade: r.trade||'', snippet: (r.content||'').replace(/<[^>]+>/g,'').slice(0,220), fullText: (r.content||'').replace(/<[^>]+>/g,''), score: 0, ruleRef: r, ruleIdx: -1 }; });
                var scored = [];
                for (var j = 0; j < ruleSubset.length; j++) {
                    var r = ruleSubset[j];
                    var text = ((r.title || '') + ' ' + (r.content || '').replace(/<[^>]+>/g, '')).slice(0, 1000).toLowerCase();
                    var s = 0;
                    kws.forEach(function(k){ if (text.indexOf(k) !== -1) s++; });
                    if (s > 0) scored.push({ i: j, s: s });
                }
                var scores = scored.sort(function(a,b){ return b.s - a.s; }).slice(0, topK);
                return scores.map(function(x){
                    var rr = ruleSubset[x.i];
                    var rawText = (rr.content || '').replace(/<[^>]+>/g, '');
                    return { title: rr.title||'', trade: rr.trade||'', snippet: rawText.slice(0,220)+(rawText.length>220?'…':''), fullText: rawText, score: x.s, ruleRef: rr, ruleIdx: -1 };
                });
            }

            // ============================================================
            // 同义词映射表（可通过 importSynonyms 扩展）
            // ============================================================
            const SYNONYM_MAP = {
                '天窗': ['封闭时间', '施工时间', '施工窗口'],
                '防护': ['防护员', '安全防护', '设防护', '防护措施'],
                '上道': ['上轨道', '进入线路', '进线作业', '上线路'],
                '违规': ['违章', '违反规定', '不符合规定', '不按规定', '违章作业', '违章行为'],
                '超限': ['超出限界', '限界超限'],
                '信号机': ['信号灯', '信号设备'],
                '道岔': ['转辙器', '岔道'],
                '行车': ['行驶', '运行', '列车运行'],
                '防溜': ['防止溜逸', '止溜', '防溜措施'],
                '闭塞': ['闭塞区间', '区间闭塞'],
                '限速': ['限制速度', '降速'],
                '接触网': ['供电线路', '架空线'],
                '作业人员': ['工作人员', '施工人员', '作业者', '现场人员'],
                '检查': ['巡查', '巡检', '查看', '核查'],
                '列车': ['火车', '机车', '车列'],
                '铁路': ['铁道', '轨道线路'],
                '违章': ['违规', '违反规定', '违章作业'],
                '未设置': ['未设', '未配备', '未安装', '缺少'],
                '擅自': ['未经允许', '未经批准', '私自', '未经许可'],
                '未确认': ['未核实', '未检查', '未核对'],
                '制动': ['刹车', '制动系统'],
                '瞭望': ['观察', '了望', '眺望'],
                '调车': ['编组调车', '调车作业'],
                '施工': ['施工作业', '维修作业', '作业施工'],
                '封锁': ['线路封锁', '区间封锁', '施工封锁'],
                '命令': ['调度命令', '行车命令', '作业命令'],
                '进路': ['行车进路', '列车进路'],
                '联控': ['车机联控', '呼唤应答'],
            };

            function expandQueryWithSynonyms(query) {
                let expanded = query;
                Object.entries(SYNONYM_MAP).forEach(([key, syns]) => {
                    if (query.includes(key)) {
                        syns.forEach(s => { if (!expanded.includes(s)) expanded += ' ' + s; });
                    }
                    syns.forEach(s => {
                        if (query.includes(s) && !expanded.includes(key)) expanded += ' ' + key;
                    });
                });
                return expanded;
            }

            // ============================================================
            // 从历史案例中提取已有的对规条款引用（案例派生候选库）
            // 【2026-04-27优化】正则提取 + 降级策略（原文兜底）
            // ============================================================
            function extractCandidatesFromIssues(query, topK) {
                topK = topK || 4;
                const startTime = Date.now();
                
                console.log(`【历史案例召回】开始处理，查询: "${query}", topK: ${topK}`);
                
                const cachedIssues = window._lastACIssues;
                if (!cachedIssues || !cachedIssues.length) {
                    console.warn('【历史案例召回】无本地匹配缓存，返回空');
                    return [];
                }
                
                console.log('【历史案例召回】使用本地匹配缓存结果，共', cachedIssues.length, '条');
                
                const issuesToProcess = cachedIssues.slice(0, topK);
                const result = [];
                
                for (let index = 0; index < issuesToProcess.length; index++) {
                    const { iss, score } = issuesToProcess[index];
                    
                    let fullText = iss.content || '';
                    if (fullText.length > 2000) fullText = fullText.slice(0, 2000);
                    
                    // ── 策略1：正则提取标准格式条款 ──
                    // 格式：不符合《XXX》（文件编号）第X条第X款"内容"的规定
                    let extracted = false;
                    try {
                        const pattern = /《([^》]{2,60})》（[^）]{5,40}号）第([\d一二三四五六七八九十百千]+条(?:第[\d一二三四五六七八九十]+款)?)[\u0022\u201C\u201D]([^\u0022\u201C\u201D]{15,300})[\u0022\u201C\u201D]/g;
                        let m;
                        while ((m = pattern.exec(fullText)) !== null) {
                            const title = (m[1] || '').trim();
                            const article = (m[3] || '').trim();
                            const clause = (m[4] || '').trim();
                            if (!title || !article || !clause) continue;
                            
                            result.push({
                                title: title,
                                fileNumber: (m[2] || '').trim(),
                                article: article,
                                snippet: '"' + clause + '"',
                                fullText: clause,
                                score: score,
                                source: 'issue',
                                issueCount: 1,
                                issueRefs: [{
                                    category: iss.category || '',
                                    nature: iss['性质'] || '',
                                    snippet: fullText.slice(0, 120),
                                    matchScore: score
                                }],
                                ruleRef: null
                            });
                            extracted = true;
                            console.log(`【历史案例召回】正则提取: 《${title}》第${article}`);
                            break; // 每条案例最多取1个
                        }
                    } catch(e) {
                        console.warn(`【历史案例召回】正则处理案例${index+1}出错:`, e.message);
                    }
                    
                    // ── 策略2（降级）：正则没匹配到，直接取案例原文作为参考 ──
                    if (!extracted) {
                        const category = iss.category || iss['类别'] || '';
                        const nature = iss['性质'] || '';
                        // 取原文前500字作为摘要
                        const summary = fullText.slice(0, 500);
                        
                        result.push({
                            title: '历史案例参考',
                            fileNumber: '',
                            article: '',
                            snippet: (category ? '[' + category + '] ' : '') + (nature ? '[' + nature + '] ' : '') + summary,
                            fullText: summary,
                            score: score,
                            source: 'issue',
                            issueCount: 1,
                            issueRefs: [{
                                category: category,
                                nature: nature,
                                snippet: fullText.slice(0, 120),
                                matchScore: score
                            }],
                            ruleRef: null
                        });
                        console.log(`【历史案例召回】降级取原文: 案例${index+1}, 匹配度${Math.round(score*100)}%, ${category||nature||'无类别'}`);
                    }
                    
                    if (result.length >= topK) break;
                }
                
                console.log(`【历史案例召回】完成，耗时: ${Date.now() - startTime}ms，提取到 ${result.length} 条`);
                return result;
            }

            // ============================================================
            // 本地验证 AI 输出条款（支持案例来源）
            // ============================================================
            function validateAIOutput(aiText, ruleCandidates, issueCandidates) {
                issueCandidates = issueCandidates || [];
                // 【关键修改】不再合并规章库候选，只验证案例库
                // const allCandidates = (ruleCandidates || []).concat(issueCandidates);

                const titlePattern = /《([^》]+)》/g;
                // 【修复】使用 Unicode 转义匹配中英文引号
                const clausePattern = /[\u0022\u201C\u201D]([^\u0022\u201C\u201D]{10,})[\u0022\u201C\u201D]/g;

                const aiTitles = [];
                let m;
                while ((m = titlePattern.exec(aiText)) !== null) aiTitles.push(m[1]);
                const aiClauses = [];
                while ((m = clausePattern.exec(aiText)) !== null) aiClauses.push(m[1]);

                if (aiTitles.length === 0) {
                    return { confidence: 'low', details: [], summary: '未提取到规章引用' };
                }

                const details = [];
                
                // 【增强】提取AI输出中的条款编号（第X条第X款）
                const articlePattern = /第([\d一二三四五六七八九十百千\.]+条(?:第[\d一二三四五六七八九十]+款)?)/g;
                const aiArticles = [];
                let m2;
                while ((m2 = articlePattern.exec(aiText)) !== null) aiArticles.push(m2[1]);
                
                aiTitles.forEach((title, i) => {
                    const clause = aiClauses[i] || '';
                    const article = aiArticles[i] || ''; // 对应的条款编号
                    
                    // 【加强】更宽松的标题清洗：移除所有标点、空格、特殊字符，同时移除文件编号（括号内容）
                    const cleanTitle = t => t.replace(/（[^）]+）/g, '').replace(/[《》\s。，、；：""''（）()\[\]【】]/g, '').toLowerCase();
                    
                    // 【增强】标准化条款编号（统一转换为阿拉伯数字）
                    const normalizeArticle = art => {
                        if (!art) return '';
                        const cnNums = { '一':1, '二':2, '三':3, '四':4, '五':5, '六':6, '七':7, '八':8, '九':9, '十':10, '百':100, '千':1000 };
                        let normalized = art.replace(/[第条款]/g, '');
                        // 将中文数字转换为阿拉伯数字（简化处理）
                        normalized = normalized.replace(/[一二三四五六七八九十百千]+/g, match => {
                            // 简单转换：直接返回原字符串，主要用于比较
                            return match;
                        });
                        return normalized.toLowerCase();
                    };
                    const aiArticleNorm = normalizeArticle(article);

                    // 【关键修改】优先在案例候选中找（不再验证规章库）
                    // 【加强】使用更宽松的匹配策略
                    let issueMatched = issueCandidates.find(c => {
                        const ct = cleanTitle(c.title), at = cleanTitle(title);
                        // 完全匹配或包含匹配
                        return ct === at || ct.includes(at) || at.includes(ct);
                    });
                    
                    // 【增强】如果标题匹配，进一步验证条款编号是否一致
                    if (issueMatched && article) {
                        const caseArticleNorm = normalizeArticle(issueMatched.article);
                        // 如果AI有条款编号但案例中没有，或者编号不一致，记录警告
                        if (caseArticleNorm && aiArticleNorm !== caseArticleNorm) {
                            console.log('【验证警告】标题匹配但条款编号不一致：', 
                                'AI:', title, article, 
                                '案例:', issueMatched.title, issueMatched.article);
                        }
                    }
                    
                    // 如果没找到，尝试更宽松的匹配（前6个字符相同）
                    if (!issueMatched) {
                        issueMatched = issueCandidates.find(c => {
                            const ct = cleanTitle(c.title), at = cleanTitle(title);
                            // 前6个字符相同（对于长标题）
                            return ct.length >= 6 && at.length >= 6 && ct.slice(0, 6) === at.slice(0, 6);
                        });
                    }
                    
                    // 【终极容错】提取核心关键词进行匹配（至少3个关键词匹配）
                    if (!issueMatched) {
                        const extractKeywords = t => {
                            // 提取有意义的词（长度>=2的中文词）
                            const words = [];
                            for (let i = 0; i < t.length - 1; i++) {
                                const twoChar = t.slice(i, i + 2);
                                if (/[\u4e00-\u9fa5]{2}/.test(twoChar)) {
                                    words.push(twoChar);
                                }
                            }
                            return words;
                        };
                        const aiWords = extractKeywords(cleanTitle(title));
                        issueMatched = issueCandidates.find(c => {
                            const ct = cleanTitle(c.title);
                            const caseWords = extractKeywords(ct);
                            // 计算共同词的数量
                            const commonWords = aiWords.filter(w => caseWords.includes(w));
                            // 如果共同词数量>=3，或者共同词占AI词的一半以上
                            return commonWords.length >= 3 || (aiWords.length > 0 && commonWords.length / aiWords.length >= 0.5);
                        });
                    }
                    
                    // 调试日志
                    if (!issueMatched) {
                        console.log('【验证失败】AI标题:', title, '清洗后:', cleanTitle(title));
                        console.log('【验证失败】可用案例标题:', issueCandidates.map(c => ({title: c.title, clean: cleanTitle(c.title)})));
                    } else {
                        console.log('【验证成功】AI标题:', title, '匹配到案例:', issueMatched.title);
                    }

                    // 案例库命中 → 高置信度
                    if (issueMatched) {
                        details.push({
                            title, clause: clause.slice(0, 60),
                            status: 'matched',  // 案例匹配视为 matched
                            source: 'issue',
                            matchedRule: issueMatched.title,
                            issueCount: issueMatched.issueCount || 1,
                            issueRefs: issueMatched.issueRefs || [],
                            label: '✅ 案例已核实（' + (issueMatched.issueCount || 1) + '次引用）'
                        });
                    } else {
                        // 未在匹配案例中找到
                        details.push({ 
                            title, 
                            clause: clause.slice(0, 60), 
                            status: 'unmatched', 
                            source: 'none', 
                            matchedRule: '', 
                            label: '❌ 未在匹配案例中找到，建议人工核查' 
                        });
                    }
                });

                // 【关键修改】置信度评级：案例匹配 = 高置信度
                const issueMatched = details.filter(d => d.source === 'issue').length;
                const unmatched   = details.filter(d => d.source === 'none').length;
                const total = details.length;

                let confidence = 'low';
                // 全部来自案例匹配 → 高置信度
                if (total > 0 && unmatched === 0) confidence = 'high';
                // 部分匹配 → 中置信度
                else if (total > 0 && issueMatched / total >= 0.5) confidence = 'medium';

                const summary = `验证${total}条：案例核实${issueMatched}条，未找到${unmatched}条`;
                return { confidence, details, summary };
            }

            // ============================================================
            // AI 对规：BM25召回 + AI精排 + 本地验证
            // ============================================================
            // ── 计算历史案例匹配相似度（0-100） ──
            function calcIssueMaxSimilarity(query) {
                const issues = typeof window.getIssueData === 'function' ? window.getIssueData() : [];
                if (!issues.length) return 0;
                const qWords = bm25Tokenize(query);
                if (!qWords.length) return 0;
                let maxScore = 0;
                issues.forEach(iss => {
                    const text = ((iss.content || '') + ' ' + (iss.category || '')).toLowerCase();
                    const hitCount = qWords.filter(w => text.includes(w)).length;
                    const score = Math.round((hitCount / qWords.length) * 100);
                    if (score > maxScore) maxScore = score;
                });
                return maxScore;
            }

            // ── 使用指定关键词计算历史案例匹配相似度（与本地匹配一致） ──
            function calcIssueMaxSimilarityWithKeywords(query, keywords) {
                const issues = typeof window.getIssueData === 'function' ? window.getIssueData() : [];
                if (!issues.length || !keywords.length) return 0;
                const lowerKws = keywords.map(k => k.toLowerCase());
                let maxScore = 0;
                issues.forEach(iss => {
                    const text = ((iss.content || '') + ' ' + (iss.category || '') + ' ' + (iss['性质'] || '')).toLowerCase();
                    const matchCount = lowerKws.filter(k => text.includes(k)).length;
                    const score = Math.round((matchCount / lowerKws.length) * 100);
                    if (score > maxScore) maxScore = score;
                });
                return maxScore;
            }

            window.autoCheckAI = async function() {
                const input = document.getElementById('autoCheck-input');
                const query = input.value.trim();
                if (!query) { alert('请输入检查问题描述'); return; }
                var apiKey = localStorage.getItem('ds_api_key_v1') || '';
                if (!apiKey) {
                    const ok = confirm('未配置 DeepSeek API Key，是否打开 API 配置？\n点击确定打开配置弹窗，点击取消则改用本地匹配。');
                    if (ok) showApiConfigModal();
                    else window.autoCheckLocal();
                    return;
                }

                const container = document.getElementById('autoCheck-results');
                container.style.display = 'block';

                // ══ 第一步：先核对本地匹配相似历史案例 ══
                // 使用与本地匹配一致的关键词计算相似度
                const keywords = Array.from(acSelectedKeywords).length > 0
                    ? Array.from(acSelectedKeywords)
                    : acExtractKeywords(query, patchInferTrade(query));
                const maxSimilarity = calcIssueMaxSimilarityWithKeywords(query, keywords);

                // ── 相似度低于35，提示重新调整关键词 ──
                if (maxSimilarity < 35) {
                    const kwsHtml = keywords.map(k =>
                        '<span style="background:#fde68a;color:#92400e;padding:2px 8px;border-radius:10px;font-size:0.82rem;cursor:pointer;border:1px solid #f59e0b;" onclick="acToggleCandidateKeyword(\'' + acEscHtml(k) + '\')">' + acEscHtml(k) + ' ✕</span>'
                    ).join('');
                    container.innerHTML = '<div style="padding:16px;background:#fffbeb;border-radius:10px;border-left:4px solid #f59e0b;">'
                        + '<div style="font-weight:700;color:#b45309;font-size:0.95rem;margin-bottom:8px;">⚠️ 本地历史案例匹配相似度较低（' + maxSimilarity + '%，低于35%）</div>'
                        + '<div style="font-size:0.85rem;color:#92400e;margin-bottom:10px;">当前关键词可能不够准确，请核查是否合理，可点击关键词移除：</div>'
                        + '<div style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:12px;">' + (kwsHtml || '<span style="color:#999;">未识别到关键词</span>') + '</div>'
                        + '<div style="font-size:0.82rem;color:#78350f;margin-bottom:12px;">👆 请在上方输入框修改问题描述或手动调整关键词后，再次执行本地匹配；<br>如确认关键词无误，可点击"继续AI对规"直接由AI从规章库自动查找。</div>'
                        + '<div style="display:flex;gap:8px;flex-wrap:wrap;">'
                        + '<button class="btn btn-primary btn-small" onclick="window.autoCheckLocal();document.getElementById(\'autoCheck-smartBtn\').dataset.state=\'ai\';">🔍 重新本地匹配</button>'
                        + '<button class="btn btn-warning btn-small" onclick="window.autoCheckAI_force();">🤖 继续AI对规（跳过相似度检查）</button>'
                        + '</div>'
                        + '</div>';
                    return;
                }

                // ── 相似度达标，继续AI对规流程 ──
                await window.autoCheckAI_force();
            };

            window.autoCheckAI_force = async function() {
                const input = document.getElementById('autoCheck-input');
                const query = input.value.trim();
                if (!query) { alert('请输入检查问题描述'); return; }
                var apiKey = localStorage.getItem('ds_api_key_v1') || '';
                const apiUrl = localStorage.getItem(DS_API_URL_STORAGE) || DS_DEFAULT_API_URL;
                const model  = localStorage.getItem(DS_MODEL_STORAGE) || DS_DEFAULT_MODEL;


                const container = document.getElementById('autoCheck-results');
                container.innerHTML = '<div style="display:flex;align-items:center;gap:12px;padding:20px;color:var(--text-secondary);"><div class="spinner" style="width:20px;height:20px;border:2px solid var(--border);border-top-color:var(--primary);border-radius:50%;animation:spin 0.8s linear infinite;flex-shrink:0;"></div><span>⏳ 正在召回候选条款…</span></div>';
                container.style.display = 'block';

                // ── 阶段0：检查本地匹配缓存，如果没有则提示用户先执行本地匹配 ──
                if (!window._lastACIssues || !window._lastACIssues.length) {
                    console.warn('[AI对规] _lastACIssues 为空，需要先执行本地匹配');
                    container.innerHTML = '<div style="padding:16px;color:var(--warning);background:#fffbeb;border-radius:10px;border-left:4px solid #f59e0b;">'
                        + '<div style="font-weight:700;color:#b45309;font-size:0.95rem;margin-bottom:8px;">⚠️ 历史案例缓存为空</div>'
                        + '<div style="font-size:0.85rem;color:#92400e;margin-bottom:10px;">系统包含3万+历史案例数据，直接扫描会导致时间过长。请先执行以下步骤：</div>'
                        + '<div style="font-size:0.85rem;color:#92400e;margin-bottom:12px;">'
                        + '1. 在输入框中填写检查问题描述<br>'
                        + '2. 点击「🔍 本地匹配」按钮<br>'
                        + '3. 系统会根据关键词筛选相关案例<br>'
                        + '4. 成功匹配后，再点击「🤖 AI 对规」按钮'
                        + '</div>'
                        + '<div style="display:flex;gap:8px;flex-wrap:wrap;">'
                        + '<button class="btn btn-primary btn-small" onclick="window.autoCheckLocal();document.getElementById(\'autoCheck-smartBtn\').dataset.state=\'ai\';">🔍 执行本地匹配</button>'
                        + '<button class="btn btn-secondary btn-small" onclick="window.clearAutoCheck();">🔄 重置</button>'
                        + '</div>'
                        + '</div>';
                    return; // 直接返回，不再继续执行
                }

                // ── 阶段1：双路召回 (BM25 + 历史案例) ──
                // 每步 await setTimeout(0) 让浏览器先渲染提示，再执行同步计算
                let expandedQuery, ruleCandidates, issueCandidates;
                try {
                    container.innerHTML = '<div style="padding:16px;color:var(--text-secondary);">⏳ 正在扩展查询同义词…</div>';
                    await new Promise(r => setTimeout(r, 0));
                    expandedQuery = expandQueryWithSynonyms(query);
                    console.log('[AI对规] 扩展后查询:', expandedQuery);

                    container.innerHTML = '<div style="padding:16px;color:var(--text-secondary);">⏳ 正在从规章库召回候选条款…</div>';
                    await new Promise(r => setTimeout(r, 0));

                    // ----- 专业优先检索 -----
                    var allRules = typeof window.getRulesData === 'function' ? window.getRulesData() : [];
                    ruleCandidates = [];
                    var inferredTrade = patchInferTrade(query);

                    if (inferredTrade && allRules.length > 0) {
                        // 1. 过滤出同专业规章
                        var sameTradeRules = allRules.filter(function(r){ return r.trade === inferredTrade; });
                        console.log('[专业优先] 推断专业: ' + inferredTrade + ', 同专业规章数: ' + sameTradeRules.length);

                        if (sameTradeRules.length > 0) {
                            var sameTradeCandidates = localBM25RecallWithRules(expandedQuery, 6, sameTradeRules);
                            ruleCandidates.push.apply(ruleCandidates, sameTradeCandidates);
                            console.log('[专业优先] 同专业召回 ' + sameTradeCandidates.length + ' 条');
                        }

                        // 2. 如果同专业召回不足 6 条，再从其他专业补充
                        if (ruleCandidates.length < 6) {
                            var otherRules = allRules.filter(function(r){ return r.trade !== inferredTrade; });
                            if (otherRules.length > 0) {
                                var otherCandidates = localBM25RecallWithRules(expandedQuery, 6 - ruleCandidates.length, otherRules);
                                ruleCandidates.push.apply(ruleCandidates, otherCandidates);
                                console.log('[补充召回] 其他专业补充 ' + otherCandidates.length + ' 条');
                            }
                        }
                    } else {
                        // 未推断出专业，走原逻辑
                        ruleCandidates = localBM25Recall(expandedQuery, 6);
                    }

                    console.log('[AI对规] 最终规章库召回', ruleCandidates.length, '条');

                    container.innerHTML = '<div style="padding:16px;color:var(--text-secondary);">⏳ 正在从历史案例召回候选条款…</div>';
                    await new Promise(r => setTimeout(r, 0));
                    issueCandidates = extractCandidatesFromIssues(query, 4);
                    console.log('[AI对规] 历史案例召回', issueCandidates.length, '条');
                } catch (e) {
                    console.error('[AI对规] 召回候选条款异常:', e);
                    var _escErr = typeof window.escapeHtml === 'function' ? window.escapeHtml : function(s){return String(s).replace(/</g,'&lt;');};
                    container.innerHTML = '<div style="padding:16px;color:#dc2626;background:#fef2f2;border-radius:8px;border-left:4px solid #ef4444;"><strong>❌ 召回候选条款失败：' + _escErr(e.message) + '</strong><br><span style="font-size:0.82rem;color:#991b1b;">' + _escErr((e.stack||'').slice(0,500)) + '</span></div>';
                    return;
                }

                if (!ruleCandidates.length && !issueCandidates.length) {
                    container.innerHTML = '<div style="padding:16px;color:#d97706;background:#fffbeb;border-radius:8px;border-left:4px solid #fcd34d;"><strong>⚠️ 规章库与历史案例均为空</strong><br>请先导入数据，已切换为本地匹配模式。</div>';
                    setTimeout(() => window.autoCheckLocal(), 800);
                    return;
                }

                console.log('[AI对规] 阶段2：构建候选映射表，规章', ruleCandidates.length, '条，案例', issueCandidates.length, '条');

                // ── 阶段2：构建全局候选映射表（ID → 完整条款） ──
                _globalCandidatesMap = {};
                let idCounter = 0;
                const allCandidates = [];

                // ── 从案例全文中提取规章引用部分 ──
                function extractRegulationQuote(text) {
                    if (!text) return '';
                    // 匹配"不符合/违反《...》...的要求/的规定/的约束"格式
                    var m = text.match(/(?:不符合|违反)《[^》]*》[^。]*?(?:的要求|的规定|的约束)/);
                    if (m) return m[0];
                    // 降级：匹配"不符合/违反《...》...。"整句
                    m = text.match(/(?:不符合|违反)《[^》]*》[^。]*。/);
                    if (m) return m[0];
                    // 再降级：匹配"《...》...的要求/的规定"
                    m = text.match(/《[^》]*》[^。]*?(?:的要求|的规定|的约束)/);
                    if (m) return m[0];
                    // 兜底：截取前200字
                    return text.length > 200 ? text.slice(0, 200) + '…' : text;
                }

                issueCandidates.forEach(c => {
                    const id = 'cand_' + (idCounter++);
                    const rawClause = c.snippet || c.fullText || '';
                    _globalCandidatesMap[id] = {
                        id, source: 'issue',
                        title: c.title || '',
                        fileNumber: c.fileNumber || '',
                        article: c.article || '',
                        clause: extractRegulationQuote(rawClause),
                        rawClause: rawClause,  // 保留原文供参考
                        issueCount: c.issueCount || 1,
                        score: c.score || 0
                    };
                    allCandidates.push(id);
                });
                ruleCandidates.forEach(c => {
                    const id = 'cand_' + (idCounter++);
                    _globalCandidatesMap[id] = {
                        id, source: 'rule',
                        title: c.title || '',
                        fileNumber: c.fileNumber || '',
                        article: c.article || '',
                        clause: c.snippet || c.content || ''
                    };
                    allCandidates.push(id);
                });

                // ── 阶段3：专业推断 + 重排候选 + AI挑选ID ──
                const _aiTrade = patchInferTrade(query);
                // 同专业的规章库候选排到前面（直接用 trade 字段）
                if (_aiTrade) {
                    ruleCandidates.sort(function(a, b) {
                        const aMatch = a.trade === _aiTrade;
                        const bMatch = b.trade === _aiTrade;
                        if (aMatch && !bMatch) return -1;
                        if (!aMatch && bMatch) return 1;
                        return 0;
                    });
                    console.log('[专业指引] 推断专业:', _aiTrade, '已对规章库候选按 trade 字段重排');
                }

                const sysPrompt = [
                    '你是铁路安监对规专家。请从以下候选条款列表中，挑选与检查问题最相关的1-3个条款ID。',
                    '【输出要求】只输出一个合法JSON对象，禁止使用代码块（```），禁止任何说明文字。',
                    '【correctedQuery】输出完整的问题描述原文（不要省略）。',
                    _aiTrade ? '【专业指引】本次问题推断涉及"' + _aiTrade + '"专业，请优先选用该专业规章条款。' : '',
                    '示例：{"correctedQuery":"机车备品管理问题","selectedIds":["cand_0","cand_2"],"reason":"备品不符"}',
                    '',
                    '候选条款列表：',
                    allCandidates.map(id => {
                        const c = _globalCandidatesMap[id];
                        const src = c.source === 'issue' ? '[案例]' : '[规章库]';
                        let line = '[' + id + '] ' + src;
                        if (c.title) line += '《' + c.title + '》';
                        if (c.fileNumber) line += '（' + c.fileNumber + '）';
                        if (c.article)  line += ' 第' + c.article + '条';
                        if (c.clause)   line += ' "' + c.clause.slice(0, 200) + '"';
                        return line;
                    }).join('\n'),
                    '',
                    '如果所有候选均不相关，selectedIds 返回空数组 []。'
                ].join('\n');

                container.innerHTML = '<div style="display:flex;align-items:center;gap:12px;padding:20px;color:var(--text-secondary);"><div class="spinner" style="width:20px;height:20px;border:2px solid var(--border);border-top-color:var(--primary);border-radius:50%;animation:spin 0.8s linear infinite;flex-shrink:0;"></div><span>🤖 AI 正在筛选最佳条款（强约束模式）…</span></div>';

                console.log('[AI对规] 阶段3：发送AI请求，候选', allCandidates.length, '个，模型:', model);

                try {
                    _acAbortController = new AbortController();
                    console.log('[AI对规] fetch 开始...', apiUrl);
                    const resp = await fetch(apiUrl, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + apiKey },
                        body: JSON.stringify({
                            model: model,
                            messages: [
                                { role: 'system', content: sysPrompt },
                                { role: 'user', content: '检查问题：' + query }
                            ],
                            temperature: 0.0,
                            max_tokens: 1024,
                            stream: false
                        }),
                        signal: _acAbortController.signal
                    });

                    console.log('[AI对规] fetch 响应:', resp.status, resp.ok);

                    if (!resp.ok) {
                        const hints = { 401:'API Key 无效', 402:'账户余额不足', 403:'无访问权限', 429:'请求过于频繁' };
                        throw new Error(hints[resp.status] || 'HTTP ' + resp.status);
                    }

                    const data = await resp.json();
                    const rawText = (data.choices[0].message.content || '').trim();

                    // 提取JSON（多重容错）
                    let aiJson;
                    let parseErr = '';
                    (function tryParse() {
                        // 1. ```json ... ``` 包裹
                        const m1 = rawText.match(/```json\s*([\s\S]*?)\s*```/);
                        if (m1) { try { aiJson = JSON.parse(m1[1]); return; } catch(e) { parseErr = e.message; } }
                        // 2. ``` ... ``` 包裹（无 json 标识）
                        const m2 = rawText.match(/```\s*([\s\S]*?)\s*```/);
                        if (m2) { try { aiJson = JSON.parse(m2[1]); return; } catch(e) { parseErr = e.message; } }
                        // 3. 裸 JSON 提取
                        const start = rawText.indexOf('{');
                        const end   = rawText.lastIndexOf('}');
                        if (start !== -1 && end > start) {
                            let jsonStr = rawText.slice(start, end + 1);
                            try { aiJson = JSON.parse(jsonStr); return; } catch(e) { parseErr = e.message; }
                            // 4. 末尾逗号容错
                            const fixed = jsonStr.replace(/,(\s*[}\]])/g, '$1');
                            try { aiJson = JSON.parse(fixed); return; } catch(e) { parseErr = e.message; }
                            // 5. 截断补全（含未闭合字符串修复）
                            let r = fixed;
                            // 5a. 检测并修复未闭合的字符串（最常见截断场景）
                            const quotes = r.match(/"/g) || [];
                            if (quotes.length % 2 !== 0) {
                                // 奇数个引号 → 最后一个字符串未闭合，补上闭合引号
                                r += '"';
                            }
                            // 5b. 补全括号
                            const oB = (r.match(/\{/g)||[]).length;
                            const cB = (r.match(/\}/g)||[]).length;
                            const oS = (r.match(/\[/g)||[]).length;
                            const cS = (r.match(/\]/g)||[]).length;
                            for(let i=0;i<oS-cS;i++) r += ']';
                            for(let i=0;i<oB-cB-1;i++) r += '}';
                            r += '}';
                            try { aiJson = JSON.parse(r); return; } catch(e) { parseErr='截断修复: '+e.message; }
                        }
                        // 6. 直接解析整段
                        try { aiJson = JSON.parse(rawText); } catch(e) { parseErr = e.message; }
                    })();
                    if (!aiJson || typeof aiJson !== 'object') {
                        console.warn('[autoCheckAI] 解析失败，原始返回：', rawText, '  错误：', parseErr);
                        throw new Error('AI返回格式异常（' + parseErr + '），已切换本地匹配');
                    }
                    // selectedIds 容错：允许字符串"cand_0,cand_1"或数组
                    if (typeof aiJson.selectedIds === 'string') {
                        aiJson.selectedIds = aiJson.selectedIds.split(/[,，\s]+/).map(s => s.trim()).filter(Boolean);
                    }

                    const { correctedQuery, selectedIds, reason } = aiJson;
                    const validIds = (selectedIds || []).filter(id => _globalCandidatesMap[id]);

                    // ── 本地拼装结论（100%来自映射表，不依赖AI原文）──
                    const issueSelected = validIds.filter(id => _globalCandidatesMap[id].source === 'issue');
                    const ruleSelected  = validIds.filter(id => _globalCandidatesMap[id].source === 'rule');
                    const hasIssueSel = issueSelected.length > 0;
                    const hasRuleSel  = ruleSelected.length > 0;

                    // ── 来源提示（区分三种情况） ──
                    let sourceTipHtml = '';
                    if (hasIssueSel && hasRuleSel) {
                        sourceTipHtml = '<div style="display:flex;align-items:center;gap:8px;padding:8px 12px;background:#f0fdf4;border-radius:8px;border:1px solid #86efac;margin-bottom:10px;font-size:0.82rem;color:#15803d;"><span>📋</span><span>本次对规参考了 <strong>' + issueCandidates.length + ' 条历史案例</strong> 和 <strong>' + ruleCandidates.length + ' 条规章库条款</strong>，AI从中选取了最相关的条款。</span></div>';
                    } else if (hasIssueSel) {
                        sourceTipHtml = '<div style="display:flex;align-items:center;gap:8px;padding:8px 12px;background:#f0fdf4;border-radius:8px;border:1px solid #86efac;margin-bottom:10px;font-size:0.82rem;color:#15803d;"><span>📋</span><span>本次对规参考了 <strong>' + issueCandidates.length + ' 条匹配历史案例</strong>，条款来源已验证。</span></div>';
                    } else {
                        sourceTipHtml = '<div style="display:flex;align-items:center;gap:8px;padding:8px 12px;background:#fef3c7;border-radius:8px;border:1px solid #fcd34d;margin-bottom:10px;font-size:0.82rem;color:#92400e;"><span>⚠️</span><span>未找到历史案例，已从规章库检索，请人工核实。</span></div>';
                    }

                    // ── 对规结论（分区展示：案例条款 + 规章库条款） ──
                    let conclusionHtml = '';
                    if (validIds.length === 0) {
                        conclusionHtml = '<p style="color:#d97706;padding:8px 0;">⚠️ 所有候选条款均不相关，建议人工核查或调整描述。</p>';
                    } else {
                        // 案例条款区域（绿色）
                        if (issueSelected.length > 0) {
                            conclusionHtml += '<div style="margin-bottom:6px;"><span style="font-size:0.78rem;font-weight:700;color:#15803d;background:#dcfce7;padding:3px 10px;border-radius:20px;">📋 历史案例中的规章引用</span></div>';
                            issueSelected.forEach((id, idx) => {
                                const c = _globalCandidatesMap[id];
                                conclusionHtml += '<div style="margin-bottom:10px;padding:12px;background:#f0fdf4;border-radius:8px;border-left:3px solid #16a34a;">'
                                    + '<div style="font-weight:700;color:#166534;margin-bottom:6px;">'
                                    + (idx+1) + '. 不符合/违反《' + acEscHtml(c.title) + '》'
                                    + (c.fileNumber ? '（' + acEscHtml(c.fileNumber) + '）' : '')
                                    + (c.article ? ' 第' + acEscHtml(c.article) + '条' : '')
                                    + '<span style="font-size:0.68rem;background:#dcfce7;color:#166534;padding:1px 6px;border-radius:8px;margin-left:4px;">案例核实' + (c.issueCount > 1 ? c.issueCount + '次' : '') + '</span>'
                                    + '</div>'
                                    + '<div style="background:#e8f5e9;padding:10px;border-radius:6px;font-size:0.88rem;line-height:1.7;color:#1b5e20;">'
                                    + '"' + acEscHtml(c.clause) + '"'
                                    + '</div>'
                                    + '</div>';
                            });
                        }
                        // 规章库条款区域（蓝色）
                        if (ruleSelected.length > 0) {
                            conclusionHtml += '<div style="margin-bottom:6px;margin-top:' + (issueSelected.length > 0 ? '10' : '0') + 'px;"><span style="font-size:0.78rem;font-weight:700;color:#1e40af;background:#dbeafe;padding:3px 10px;border-radius:20px;">⚖️ 规章库匹配条款</span></div>';
                            ruleSelected.forEach((id, idx) => {
                                const c = _globalCandidatesMap[id];
                                conclusionHtml += '<div style="margin-bottom:10px;padding:12px;background:#eff6ff;border-radius:8px;border-left:3px solid #2563eb;">'
                                    + '<div style="font-weight:700;color:#1e40af;margin-bottom:6px;">'
                                    + (idx+1) + '. 不符合/违反《' + acEscHtml(c.title) + '》'
                                    + (c.fileNumber ? '（' + acEscHtml(c.fileNumber) + '）' : '')
                                    + (c.article ? ' 第' + acEscHtml(c.article) + '条' : '')
                                    + '<span style="font-size:0.68rem;background:#dbeafe;color:#1e40af;padding:1px 6px;border-radius:8px;margin-left:4px;">规章库</span>'
                                    + '</div>'
                                    + '<div style="background:#e0f2fe;padding:10px;border-radius:6px;font-size:0.88rem;line-height:1.7;color:#0c4a6e;">'
                                    + '"' + acEscHtml(c.clause) + '"'
                                    + '</div>'
                                    + '</div>';
                            });
                        }
                    }

                    // ── 条款来源案例标识（只显示[性质·类别]标签） ──
                    let caseSourceHtml = '';
                    if (hasIssueSel) {
                        caseSourceHtml = '<div style="margin-top:12px;">'
                            + '<div style="margin-bottom:6px;"><span style="font-size:0.78rem;font-weight:700;color:#b45309;background:#fef3c7;padding:3px 10px;border-radius:20px;">📂 条款来源案例标识</span></div>'
                            + '<div style="display:flex;flex-direction:column;gap:4px;">';
                        issueSelected.forEach((id, idx) => {
                            const c = _globalCandidatesMap[id];
                            // 从原始issueCandidates中查找案例引用信息
                            const matchIssue = issueCandidates.find(ic =>
                                ic.title === c.title && ic.article === c.article
                            );
                            const issueRefs = (matchIssue && matchIssue.issueRefs) ? matchIssue.issueRefs : [];
                            caseSourceHtml += '<div style="background:#fffbeb;border:1px solid #fde68a;border-radius:8px;padding:8px 12px;">'
                                + '<div style="font-size:0.85rem;font-weight:600;color:#92400e;">'
                                + '[' + (idx+1) + '] 《' + acEscHtml(c.title) + '》'
                                + (c.article ? ' 第' + acEscHtml(c.article) + '条' : '')
                                + '</div>';
                            if (issueRefs.length > 0) {
                                caseSourceHtml += '<div style="margin-top:4px;display:flex;flex-wrap:wrap;gap:4px;">';
                                issueRefs.forEach(r => {
                                    const tag = (r.nature || '') + (r.category ? '·' + r.category : '');
                                    caseSourceHtml += '<span style="font-size:0.7rem;background:#fde68a;color:#78350f;padding:2px 8px;border-radius:10px;">[' + acEscHtml(tag || '案例') + ']</span>';
                                });
                                caseSourceHtml += '</div>';
                            }
                            caseSourceHtml += '</div>';
                        });
                        caseSourceHtml += '</div></div>';
                    }

                    // ── 历史案例规章参考（展示所有召回的案例候选，不限于AI选中） ──
                    let issueRefHtml = '';
                    if (issueCandidates.length > 0) {
                        issueRefHtml = '<div style="margin-top:12px;">'
                            + '<div style="margin-bottom:6px;"><span style="font-size:0.78rem;font-weight:700;color:#15803d;background:#dcfce7;padding:3px 10px;border-radius:20px;">📋 匹配案例条款参考</span></div>'
                            + '<div style="display:flex;flex-direction:column;gap:6px;">';
                        issueCandidates.slice(0, 5).forEach((c, i) => {
                            var refQuote = extractRegulationQuote(c.snippet || c.fullText || '');
                            issueRefHtml += '<div class="rule-card-item" style="padding:12px 16px;background:#f0fdf4;border-radius:8px;">'
                                + '<div class="rule-title" style="display:flex;align-items:center;justify-content:space-between;gap:8px;">'
                                + '<span style="flex:1;word-break:break-all;color:#166534;font-weight:600;">[' + (i+1) + '] 《' + acEscHtml(c.title) + '》' + (c.fileNumber ? '（' + acEscHtml(c.fileNumber) + '）' : '') + (c.article ? ' 第' + acEscHtml(c.article) + '条' : '') + '</span>'
                                + '<span style="font-size:0.7rem;color:#15803d;background:#dcfce7;padding:2px 8px;border-radius:12px;">' + (c.issueCount || 1) + '个案例引用</span>'
                                + '</div>'
                                + (refQuote ? '<div style="margin-top:6px;font-size:0.8rem;color:#374151;line-height:1.5;">' + acEscHtml(refQuote) + '</div>' : '')
                                + '</div>';
                        });
                        issueRefHtml += '</div></div>';
                    }

                    // ── 规章库匹配参考（展示所有召回的规章库候选） ──
                    let ruleRefHtml = '';
                    if (ruleCandidates.length > 0) {
                        ruleRefHtml = '<div style="margin-top:12px;">'
                            + '<div style="margin-bottom:6px;"><span style="font-size:0.78rem;font-weight:700;color:#1e40af;background:#dbeafe;padding:3px 10px;border-radius:20px;">⚖️ 规章库匹配参考</span></div>'
                            + '<div style="display:flex;flex-direction:column;gap:6px;">';
                        ruleCandidates.slice(0, 5).forEach((c, i) => {
                            const tradeTag = c.trade ? ('【' + acEscHtml(c.trade) + '】') : '';
                            ruleRefHtml += '<div class="rule-card-item" style="padding:12px 16px;background:#eff6ff;border-radius:8px;">'
                                + '<div class="rule-title" style="display:flex;align-items:center;justify-content:space-between;gap:8px;">'
                                + '<span style="flex:1;word-break:break-all;color:#1e40af;font-weight:600;">[' + (i+1) + '] 《' + acEscHtml(c.title) + '》' + (c.fileNumber ? '（' + acEscHtml(c.fileNumber) + '）' : '') + (c.article ? ' 第' + acEscHtml(c.article) + '条' : '') + '</span>'
                                + '<span style="font-size:0.7rem;color:#1e40af;background:#dbeafe;padding:2px 8px;border-radius:12px;">' + tradeTag + ' 规章库</span>'
                                + '</div>'
                                + (c.snippet || c.content ? '<div style="margin-top:6px;font-size:0.8rem;color:#374151;line-height:1.5;">' + acEscHtml(c.snippet || c.content) + '</div>' : '')
                                + '</div>';
                        });
                        ruleRefHtml += '</div></div>';
                    }

                    const issueCount = issueSelected.length;
                    const ruleCount  = ruleSelected.length;

                    // ── 生成反馈ID（用于DOM定位） ──
                    const feedbackId = 'ac-fb-' + Date.now();

                    container.innerHTML = '<div style="background:#f0f9ff;padding:16px;border-radius:12px;border-left:5px solid #2563eb;">'
                        + '<h3 style="color:#1e3a5f;margin-bottom:12px;">⚖️ 对规结论 <span style="font-size:0.75rem;font-weight:400;color:#64748b;">（强约束模式·条款来自本地库）</span></h3>'
                        + '<p style="margin-bottom:12px;"><strong>📌 校核后问题：</strong>' + acEscHtml(correctedQuery || query) + '</p>'
                        + sourceTipHtml
                        + conclusionHtml
                        + caseSourceHtml
                        + (validIds.length > 0 ? '<p style="color:#16a34a;font-size:0.82rem;margin-top:8px;">✅ 条款来源：案例库 ' + issueCount + ' 条，规章库 ' + ruleCount + ' 条 | 选择理由：' + acEscHtml(reason || '') + '</p>' : '')
                        // ── 参考区域（结论卡片外部）──
                        + issueRefHtml
                        + ruleRefHtml
                        // ── 对规反馈区域 ──
                        + '<div id="' + feedbackId + '" style="margin-top:14px;padding:12px 14px;background:#fff;border-radius:8px;border:1px solid #e2e8f0;">'
                        + '<div style="font-size:0.85rem;font-weight:600;color:#475569;margin-bottom:8px;">📝 本次对规结果是否正确？</div>'
                        + '<div style="display:flex;gap:8px;flex-wrap:wrap;">'
                        + '<button class="btn btn-small" style="background:#dcfce7;color:#166534;border:1px solid #86efac;padding:6px 16px;border-radius:20px;font-size:0.82rem;cursor:pointer;" onclick="window.acFeedback(\'' + feedbackId + '\',\'correct\',this)">✅ 正确</button>'
                        + '<button class="btn btn-small" style="background:#fef3c7;color:#92400e;border:1px solid #fcd34d;padding:6px 16px;border-radius:20px;font-size:0.82rem;cursor:pointer;" onclick="window.acFeedback(\'' + feedbackId + '\',\'partial\',this)">⚠️ 部分正确</button>'
                        + '<button class="btn btn-small" style="background:#fef2f2;color:#991b1b;border:1px solid #fca5a5;padding:6px 16px;border-radius:20px;font-size:0.82rem;cursor:pointer;" onclick="window.acFeedback(\'' + feedbackId + '\',\'wrong\',this)">❌ 不正确</button>'
                        + '</div>'
                        + '</div>'
                        + '</div>';

                    // 保存供后续使用
                    window._lastACRules = validIds.map(id => {
                        const c = _globalCandidatesMap[id];
                        return { title: c.title, fileNumber: c.fileNumber, article: c.article, snippet: c.clause };
                    });

                } catch(err) {
                    if (err.name === 'AbortError') {
                        container.innerHTML = '<div style="color:#e53e3e;padding:12px;">⏹️ 已停止AI对规</div>';
                    } else {
                        container.innerHTML = '<div style="padding:16px;color:#e53e3e;">❌ AI对规失败：' + acEscHtml(err.message) + '<br><button class="btn btn-secondary btn-small" style="margin-top:8px;" onclick="autoCheckLocal()">改用本地匹配</button></div>';
                    }
                } finally {
                    _acAbortController = null;
                }
            };

            // ── 对规反馈记录 ──
            window.acFeedback = function(feedbackId, verdict, btnEl) {
                // verdict: 'correct' | 'partial' | 'wrong'
                const container = document.getElementById(feedbackId);
                if (!container) return;

                // 读取当前对规信息
                const query = document.getElementById('autoCheck-input') ? document.getElementById('autoCheck-input').value.trim() : '';
                const selectedIds = window._lastACRules || [];

                // 构建反馈记录
                const record = {
                    id: Date.now(),
                    time: new Date().toISOString(),
                    query: query,
                    verdict: verdict,
                    selectedRules: selectedIds.map(r => ({
                        title: r.title || '',
                        fileNumber: r.fileNumber || '',
                        article: r.article || ''
                    }))
                };

                // 保存到 localStorage
                const STORAGE_KEY = 'ac_feedback_records';
                let records = [];
                try {
                    records = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
                } catch(e) { records = []; }
                records.push(record);
                // 只保留最近500条
                if (records.length > 500) records = records.slice(-500);
                localStorage.setItem(STORAGE_KEY, JSON.stringify(records));

                // 更新UI：隐藏按钮，显示已反馈状态
                const labels = { correct: '✅ 正确', partial: '⚠️ 部分正确', wrong: '❌ 不正确' };
                const colors = { correct: '#166534', partial: '#92400e', wrong: '#991b1b' };

                container.innerHTML = '<div style="display:flex;align-items:center;gap:8px;">'
                    + '<span style="font-size:0.88rem;font-weight:600;color:' + colors[verdict] + ';">' + labels[verdict] + '，已记录</span>'
                    + (verdict === 'wrong' || verdict === 'partial'
                        ? '<button class="btn btn-small" style="background:#eff6ff;color:#1e40af;border:1px solid #93c5fd;padding:4px 12px;border-radius:16px;font-size:0.78rem;cursor:pointer;" onclick="window.acFeedbackCorrection(\'' + record.id + '\')">✏️ 补充正确条款</button>'
                        : '')
                    + '<span style="font-size:0.75rem;color:#94a3b8;">累计 ' + records.length + ' 条反馈</span>'
                    + '</div>';

                console.log('[对规反馈]', verdict, '查询:', query.slice(0, 40), '...', '累计', records.length, '条');
            };

            // ── 补充正确条款（反馈修正） ──
            window.acFeedbackCorrection = function(recordId) {
                const correction = prompt('请输入正确的规章条款，格式如：\n《规章名称》文号 第X条');
                if (!correction || !correction.trim()) return;

                const STORAGE_KEY = 'ac_feedback_records';
                let records = [];
                try {
                    records = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
                } catch(e) { records = []; }

                const rec = records.find(r => r.id === recordId);
                if (rec) {
                    rec.correction = correction.trim();
                    rec.correctionTime = new Date().toISOString();
                    localStorage.setItem(STORAGE_KEY, JSON.stringify(records));
                    alert('已记录修正：' + correction.trim());
                    console.log('[对规反馈修正]', rec.query.slice(0, 30), '→', correction.trim());
                }
            };

            // 停止AI对规生成
            window.stopACGeneration = function() {
                if (_acAbortController) _acAbortController.abort();
            };


            window.clearAutoCheck = function() {
                document.getElementById('autoCheck-input').value = '';
                const c = document.getElementById('autoCheck-results');
                c.style.display = 'none';
                c.innerHTML = '';
                // 隐藏关键词选择区域
                const selectArea = document.getElementById('keyword-select-area');
                if (selectArea) selectArea.style.display = 'none';
                // 重置选择状态
                acSelectedKeywords = new Set();
                acCandidateKeywords = [];
                // 重置两态按钮状态
                _acHasLocalResult = false;
                const smartBtn = document.getElementById('autoCheck-smartBtn');
                if (smartBtn) {
                    smartBtn.dataset.state = 'local';
                    smartBtn.className = 'btn btn-primary';
                    smartBtn.style.flex = '1';
                    smartBtn.style.minWidth = '';
                    smartBtn.style.fontWeight = '600';
                    smartBtn.disabled = false;
                    smartBtn.style.opacity = '1';
                    smartBtn.textContent = '🔍 本地匹配';
                    smartBtn.classList.remove('state-ai');
                }
                // 隐藏AI对规提示
                const hint = document.getElementById('autoCheck-ai-hint');
                if (hint) hint.style.display = 'none';
                // 清除缓存
                window._lastACIssues = [];
                window._lastACRules = [];
                _bm25Index = null;
            };

            // ===== 两态合并按钮绑定（本地匹配后锁定AI对规）=====
            var _acHasLocalResult = false; // 标记本地匹配是否已完成

            (function bindAutoCheckEvents() {
                function bind() {
                    const smartBtn = document.getElementById('autoCheck-smartBtn');
                    const clearBtn = document.getElementById('autoCheck-clearBtn');

                    if (smartBtn) {
                        // 初始化状态
                        smartBtn.dataset.state = 'local';

                        smartBtn.onclick = function() {
                            // 如果本地匹配已完成但还没AI对规，强制引导走AI对规
                            if (_acHasLocalResult && (smartBtn.dataset.state === 'local')) {
                                smartBtn.dataset.state = 'ai';
                                smartBtn.className = 'btn btn-info state-ai';
                                smartBtn.style.flex = '1';
                                smartBtn.style.minWidth = '';
                                smartBtn.style.fontWeight = '600';
                                smartBtn.textContent = '🤖 AI 对规';
                                // 显示提示
                                const hint = document.getElementById('autoCheck-ai-hint');
                                if (hint) hint.style.display = 'block';
                                return;
                            }

                            const state = smartBtn.dataset.state || 'local';
                            if (state === 'local') {
                                // 第一次点击：本地匹配
                                window.autoCheckLocal();
                                // 切换到AI对规状态
                                smartBtn.dataset.state = 'ai';
                                smartBtn.className = 'btn btn-info state-ai';
                                smartBtn.style.flex = '1';
                                smartBtn.style.minWidth = '';
                                smartBtn.style.fontWeight = '600';
                                smartBtn.textContent = '🤖 AI 对规';
                                // 显示提示
                                const hint = document.getElementById('autoCheck-ai-hint');
                                if (hint) hint.style.display = 'block';
                            } else {
                                // 第二次点击：AI 对规（带相似度检查）
                                _acHasLocalResult = false; // 解除锁定
                                window.autoCheckAI();
                                // 完成后恢复到本地匹配
                                smartBtn.dataset.state = 'local';
                                smartBtn.className = 'btn btn-primary';
                                smartBtn.style.flex = '1';
                                smartBtn.style.minWidth = '';
                                smartBtn.style.fontWeight = '600';
                                smartBtn.textContent = '🔍 本地匹配';
                                smartBtn.classList.remove('state-ai');
                                // 隐藏提示
                                const hint = document.getElementById('autoCheck-ai-hint');
                                if (hint) hint.style.display = 'none';
                            }
                        };
                    }
                    if (clearBtn) clearBtn.onclick = function() { window.clearAutoCheck(); };
                }
                if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bind);
                else bind();
            })();
            window.importRailwayTerms = function() {
                const input = document.createElement('input');
                input.type = 'file';
                input.accept = '.json,.txt,.csv';
                input.style.display = 'none';

                input.onchange = function(e) {
                    const file = e.target.files[0];
                    if (!file) return;

                    const reader = new FileReader();
                    reader.onload = function(event) {
                        try {
                            let content = event.target.result;
                            // 解析为结构化条目 [{term, trade}]
                            let items = [];

                            if (file.name.endsWith('.json')) {
                                // 去除 JSON 中的注释，兼容带 // 行注释和 /* */ 块注释的文件
                                const cleaned = content.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
                                const data = JSON.parse(cleaned);
                                const raw = Array.isArray(data) ? data : (data.terms || []);
                                raw.forEach(function(r) {
                                    if (typeof r === 'string' && r.trim().length >= 2) {
                                        items.push({ term: r.trim(), trade: '通用' });
                                    } else if (r && typeof r.term === 'string' && r.term.trim().length >= 2) {
                                        items.push({ term: r.term.trim(), trade: r.trade || '通用' });
                                    }
                                });
                            } else {
                                // TXT/CSV：每行/每逗号一个术语，统一归入"通用"
                                content.split(/[\r\n,，;；]+/).forEach(function(t) {
                                    const s = t.trim();
                                    if (s.length >= 2) items.push({ term: s, trade: '通用' });
                                });
                            }

                            if (items.length === 0) {
                                alert('未找到有效的术语，请检查文件格式');
                                return;
                            }

                            // 合并去重（以 term 为主键）
                            const existingMap = new Map(PATCH_TERM_LIBRARY.map(function(i) { return [i.term, i]; }));
                            let addedCount = 0;
                            items.forEach(function(item) {
                                if (!existingMap.has(item.term)) {
                                    PATCH_TERM_LIBRARY.push(item);
                                    existingMap.set(item.term, item);
                                    addedCount++;
                                }
                            });

                            // 持久化 + 同步 Set
                            localStorage.setItem('patch_term_library_v2', JSON.stringify(PATCH_TERM_LIBRARY));
                            syncTermSet();

                            const container = document.getElementById('autoCheck-results');
                            container.innerHTML = '<div style="padding:16px;color:var(--success);background:#f0fdf4;border-radius:8px;border-left:4px solid var(--success);">' +
                                '<strong>✅ 词库导入成功</strong><br>' +
                                '新增 <strong>' + addedCount + '</strong> 个专业术语（跳过重复 ' + (items.length - addedCount) + ' 个）<br>' +
                                '<span style="font-size:0.85rem;color:var(--text-secondary);">总词库容量：' + RAILWAY_TERMS.size + ' 个术语</span><br><br>' +
                                '<button class="btn btn-primary btn-small" onclick="document.getElementById(\'autoCheck-results\').style.display=\'none\';">关闭</button>' +
                                '</div>';
                            container.style.display = 'block';
                            console.log('词库导入：新增 ' + addedCount + ' 个，当前共 ' + RAILWAY_TERMS.size + ' 个');
                        } catch (err) {
                            alert('文件解析失败：' + err.message + '\n请确保文件格式正确（JSON/TXT/CSV）');
                        }
                    };
                    reader.readAsText(file);
                    input.remove();
                };
                document.body.appendChild(input);
                input.click();
            };

            // 导出词库（结构化格式，含 term + trade）
            window.exportRailwayTerms = function() {
                const sorted = PATCH_TERM_LIBRARY.slice().sort(function(a, b) {
                    return (a.trade || '').localeCompare(b.trade || '') || a.term.localeCompare(b.term);
                });
                const payload = { terms: sorted, count: sorted.length, exportDate: new Date().toISOString(), version: 2 };
                const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = '铁路专业词库_' + new Date().toISOString().slice(0, 10) + '.json';
                a.click();
                URL.revokeObjectURL(url);
            };

            // 暴露给全局，供智能助手使用
            window.acExtractKeywords = acExtractKeywords;
            window.acExtractLibraryKeywords = acExtractLibraryKeywords;
            window.patchInferTrade = patchInferTrade;
            window.PATCH_TERM_LIBRARY = PATCH_TERM_LIBRARY;
            window.PATCH_TRADE_KEYWORDS = PATCH_TRADE_KEYWORDS;
            window.VIOLATION_ACTION_WORDS = VIOLATION_ACTION_WORDS;

            // ========== 自动对规子模块 END ==========
        })();

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
                    if (err && err.name === 'InvalidStateError' || String(err.message).includes('closing')) {
                        console.log('[DB] 事务失败(连接关闭)，重试...');
                        _wrDB = null;
                        _wrDBOpening = null;
                        return fn();
                    }
                    throw err;
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
                    const req = tx.objectStore(store).getAll();
                    req.onsuccess = e => res(e.target.result);
                    req.onerror   = e => rej(e.target.error);
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
                        '<button onclick="(window.dsDownloadCode||function(b){var p=b.parentElement.querySelector(\'pre\');if(!p)return;var a=document.createElement(\'a\');a.href=URL.createObjectURL(new Blob([p.textContent],{type:\'text/plain;charset=utf-8\'}));a.download=\'code.' + fileExt + '\';a.click();setTimeout(function(){URL.revokeObjectURL(a.href)},100)})(this)" data-ext="' + fileExt + '" ' +
                        'style="position:absolute;top:6px;right:6px;background:#3b82f6;color:#fff;border:none;border-radius:4px;padding:3px 10px;font-size:0.75rem;cursor:pointer;z-index:2;transition:all 0.2s;box-shadow:0 1px 3px rgba(0,0,0,0.3);" ' +
                        'onmouseover="this.style.background=\'#2563eb\'" onmouseout="this.style.background=\'#3b82f6\'" title="下载代码文件">📥 下载 ' + ext.toUpperCase() + '</button>' +
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
                    meeting:'会议纪要', other:'其它'
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
                const tabs = ['gen', 'materials'];
                tabs.forEach(t => {
                    const btn = document.getElementById('wr-tab-btn-' + t);
                    const panel = document.getElementById('wr-panel-' + t);
                    if (!panel) return; // 按钮可能不存在，继续处理面板
                    if (t === tab) {
                        if (btn) {
                            btn.style.background = 'var(--primary)';
                            btn.style.color = '#fff';
                            btn.style.borderColor = 'var(--primary)';
                        }
                        panel.style.display = 'flex';
                    } else {
                        if (btn) {
                            btn.style.background = '#f8fafc';
                            btn.style.color = 'var(--text)';
                            btn.style.borderColor = 'var(--border)';
                        }
                        panel.style.display = 'none';
                    }
                });
                if (tab === 'materials') {
                    // 默认显示普通资料列表，恢复上次 filter
                    const histZone = document.getElementById('wr-mat-history-zone');
                    const matList  = document.getElementById('wr-mat-list');
                    if (histZone) histZone.style.display = 'none';
                    if (matList)  matList.style.display = 'flex';
                    wrRenderMaterials();
                }
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
                        if (ext === 'txt' || ext === 'md' || ext === 'json' || ext === 'csv') {
                            content = await wrReadTextFile(file);
                        } else if (ext === 'doc' || ext === 'docx') {
                            content = await wrReadWordFile(file);
                        } else if (ext === 'xls' || ext === 'xlsx') {
                            content = await wrReadExcelFile(file);
                        } else if (ext === 'pdf') {
                            content = await wrReadPdfFile(file);
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
                            <span>${fileName}</span>
                        </div>
                        <div style="font-size:0.85rem;opacity:0.95;white-space:pre-wrap;max-height:200px;overflow-y:auto;border-top:1px solid rgba(255,255,255,0.2);padding-top:6px;margin-top:4px;">${content.slice(0, 500)}${content.length > 500 ? '\n\n...[内容预览已截取]' : ''}</div>
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

                if (_wrConvHistory.length > 0) {
                    wrGenerate();
                    return;
                }

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
                wrDbGetAll(WR_MAT_STORE).then(function(mats) {
                    window._wrAllMats = mats; // 缓存供wrConfirmSelection使用
                    var templates = mats.filter(function(m) { return m.matType === 'template'; });
                    var otherMats = mats.filter(function(m) { return m.matType !== 'template'; });
                    // 更新已显示的对话框（仅更新select和列表内容）
                    var tplSelect = document.getElementById('wr-step-template');
                    if (tplSelect) {
                        tplSelect.innerHTML = '<option value="">-- 不使用模板 --</option>'
                            + templates.map(function(t){ return '<option value="'+t.id+'">'+wrEsc(t.title)+'</option>'; }).join('');
                    }
                    var matDiv = document.querySelector('.wr-step-modal > div > div:nth-child(4) > div');
                    if (matDiv) {
                        matDiv.innerHTML = otherMats.length === 0 ? '<div style="text-align:center;color:gray;padding:16px;">暂无可用资料</div>'
                            : otherMats.map(function(m){ return '<label style="display:block;margin-bottom:5px;"><input type="checkbox" class="wr-step-mat" value="'+m.id+'"> '+wrEsc(m.title||m.fileName)+'</label>'; }).join('');
                    }
                }).catch(function(e) {
                    console.warn('资料库异步加载失败:', e);
                    window._wrAllMats = [];
                });
            };

            window.wrConfirmSelection = function() {
                var templateSelect = document.getElementById('wr-step-template');
                var selectedTemplateId = templateSelect ? templateSelect.value : '';
                var selectedMatIds = Array.from(document.querySelectorAll('.wr-step-mat:checked')).map(function(cb){ return parseInt(cb.value); });
                
                // 使用缓存的资料数据，不再重复读DB
                var mats = window._wrAllMats || [];
                window._wrSelectedTemplate = selectedTemplateId ? (mats.find(function(m){ return m.id == selectedTemplateId; }) || null) : null;
                window._wrSelectedMaterialIds = selectedMatIds;
                var modal = document.querySelector('.wr-step-modal');
                if (modal) modal.remove();
                // 跳转到写作面板并触发生成
                if (typeof dsSwitchSub === 'function') dsSwitchSub('writer');
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
                                    
                                    // 检测是否为导出备份格式（含 materials 数组）
                                    let jsonItems = null;
                                    if (data.materials && Array.isArray(data.materials)) {
                                        jsonItems = data.materials; // 导出备份格式，拆分存储
                                    } else if (Array.isArray(data)) {
                                        jsonItems = data; // 纯数组格式，拆分存储
                                    }
                                    
                                    if (jsonItems && jsonItems.length > 0) {
                                        // 拆分存储：每条记录独立存入数据库
                                        console.log('[导入] JSON检测到' + jsonItems.length + '条记录，拆分存储');
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
                                            successCount++;
                                        }
                                        processed++;
                                        continue; // 跳过下面的单条保存逻辑
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
                        if (iss.date) {
                            const ts = new Date(iss.date).getTime();
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
             * 检索最相关的模板（从资料库中获取 matType === 'template' 的资料）
             */
            async function wrGetTemplate(parsedQuery) {
                const allMats = await wrDbGetAll(WR_MAT_STORE);
                const templates = allMats.filter(m => m.matType === 'template');
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
                // 兜底：最新导入的一条
                return templates.sort((a,b) => b.importAt - a.importAt)[0];
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
                // 1. 如果有关键词匹配(score>0)的资料，优先返回这些
                // 2. 如果没有匹配关键词的资料，返回最新的8条资料（确保导入的资料可见）
                const hasMatches = scored.some(x => x.score > 0);
                const filtered = hasMatches 
                    ? scored.filter(x => x.score > 0)  // 只返回有匹配的资料
                    : scored;  // 无匹配时返回所有资料（按时间排序）

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

            function wrBuildPrompt(query, materials) {
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
                    } else {
                        sysLines.push('【输出要求】');
                        sysLines.push('- 直接输出最终文档内容，无需解释说明。');
                        sysLines.push('- 按模板章节结构输出，不随意增减章节。');
                        sysLines.push('- 【关键】必须输出模板中所有章节，不得在中途停止或只输出部分内容，直到全部章节完成为止。');
                        sysLines.push('- 统计数字、日期等关键信息必须与台账数据一致。');
                        sysLines.push('- 【重要】报告中的问题描述、案例分析必须基于提供的本地资料，不得编造。');
                    }
                } else {
                    sysLines.push('【输出要求】');
                    sysLines.push('- 直接输出最终文档内容，无需解释说明。');
                    sysLines.push('- 按模板章节结构输出，不随意增减章节。');
                    sysLines.push('- 【关键】必须输出模板中所有章节，不得在中途停止或只输出部分内容，直到全部章节完成为止。');
                    sysLines.push('- 统计数字、日期等关键信息必须与台账数据一致。');
                    sysLines.push('- 【重要】报告中的问题描述、案例分析必须基于提供的本地资料，不得编造。');
                }

                const userLines = ['【用户需求】', query, ''];

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
                    tags.push('<span style="background:#fff7ed;color:#9a3412;padding:3px 10px;border-radius:20px;font-size:0.78rem;">📁 已选' + window._wrSelectedMaterialIds.length + '份资料</span>');
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
                    + '<span style="color:#d97706;">不自动检索，请手动选择资料</span></div>';

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

                html += '<div style="margin-bottom:8px;"><strong>📂 历史参考：</strong><span style="color:#d97706;">不自动检索</span></div>';

                html += '<div><strong>⚖️ 规章条款：</strong><span style="color:#d97706;">不自动检索</span></div>';

                html += '</div>';

                const resultEl = document.getElementById('wr-gen-result');
                if (resultEl) { resultEl.innerHTML = html; resultEl.style.display = 'block'; }
            };

            let _wrAbortController = null; // 用于停止写作生成

            window.wrGenerate = async function() {
                const q = (document.getElementById('wr-query-input') || {}).value || '';
                if (!q.trim()) { alert('请输入写作需求'); return; }
                var apiKey = localStorage.getItem('ds_api_key_v1') || '';
                const apiUrl = localStorage.getItem(WR_API_URL_K) || 'https://api.deepseek.com/chat/completions';
                const model  = localStorage.getItem(WR_MODEL_K) || 'deepseek-chat';
                if (!apiKey) { alert('请先在智能助手模块中配置 API Key。'); return; }

                const writeBtn = document.getElementById('wr-write-btn');
                const stopBtn = document.getElementById('wr-stop-btn');
                // 显示停止按钮
                if (stopBtn) stopBtn.style.display = 'inline-block';

                // 合并上传的文件内容
                let enhancedQuery = q;
                const uploadedFiles = (window._wrUploadedFiles || []).filter(Boolean);
                if (uploadedFiles.length) {
                    enhancedQuery += '\n\n【上传的文件内容】\n';
                    uploadedFiles.forEach(f => { enhancedQuery += `\n--- 文件：${f.name} ---\n${f.content}\n`; });
                }

                wrAppendChatBubble('user', q);
                _wrConvHistory.push({ role: 'user', content: enhancedQuery, timestamp: Date.now() });
                document.getElementById('wr-query-input').value = '';
                wrUpdateConvBtn();

                const aiBubble = wrAppendChatBubble('assistant', '', true);
                const streamBubbleContent = document.getElementById('wr-stream-bubble-content');
                if (writeBtn) writeBtn.disabled = true;

                // 隐藏旧结果区
                const resultEl = document.getElementById('wr-gen-result');
                if (resultEl) { resultEl.innerHTML = ''; resultEl.style.display = 'none'; }

                try {
                    // 获取用户选择的模板和资料
                    let template = window._wrSelectedTemplate;
                    let localMaterials = [];
                    if (window._wrSelectedMaterialIds && window._wrSelectedMaterialIds.length) {
                        const allMats = await wrDbGetAll(WR_MAT_STORE);
                        localMaterials = allMats.filter(m => window._wrSelectedMaterialIds.includes(m.id) && m.matType !== 'template');
                    }
                    const parsed = wrParseQuery(q);
                    const materials = { parsed, template, issues: [], stats: null, similarReports: [], ruleCandidates: [], localMaterials };

                    // 构建提示词
                    const { sysPrompt, userPrompt } = wrBuildPrompt(enhancedQuery, materials);

                    // 构建消息序列（保留最近4轮对话上下文）
                    const messages = [{ role: 'system', content: sysPrompt }];
                    const histSlice = _wrConvHistory.slice(-8);
                    histSlice.forEach(h => {
                        if (h.role === 'user' && h.content !== enhancedQuery) messages.push({ role: 'user', content: h.content });
                        else if (h.role === 'assistant') messages.push({ role: 'assistant', content: h.content.slice(0, 1500) });
                    });
                    messages.push({ role: 'user', content: userPrompt });

                    _wrAbortController = new AbortController();
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
                                        streamBubbleContent.innerHTML = wrStreamFormat(fullText);
                                        const histEl = document.getElementById('wr-chat-history');
                                        if (histEl) histEl.scrollTop = histEl.scrollHeight;
                                        lastRender = now;
                                    }
                                }
                            } catch(e) {}
                        }
                    }
                    // 最后一次渲染
                    if (streamBubbleContent) streamBubbleContent.innerHTML = wrStreamFormat(fullText);
                    
                    // 去掉流式气泡 id
                    if (aiBubble) aiBubble.id = '';
                    if (streamBubbleContent) streamBubbleContent.id = '';

                    // 清理数据标记
                    fullText = fullText.replace(/【数据:典型问题\n([\s\S]*?)\n】/g, '$1');
                    fullText = fullText.replace(/【数据:([^\】]*?)】/g, '$1');

                    // ★ 关键改进：如果使用了模板，真正应用占位符替换 ★
                    if (template && template.content) {
                        const mapping = wrParseMapping(fullText);
                        if (mapping && typeof mapping === 'object') {
                            fullText = applyTemplatePlaceholders(template.content, mapping);
                            // 重新渲染气泡：模板替换后内容已是 HTML，不能用 wrStreamFormat（会二次转义）
                            if (streamBubbleContent) streamBubbleContent.innerHTML = fullText;
                            const histEl = document.getElementById('wr-chat-history');
                            if (histEl) histEl.scrollTop = histEl.scrollHeight;
                        } else {
                            console.warn('未解析到有效映射，保留 AI 原始输出');
                        }
                    }

                    // 记录到对话历史
                    _wrConvHistory.push({ role: 'assistant', content: fullText, timestamp: Date.now() });

                    // 保存当前报告内容
                    window._wrCurrentReportContent = fullText;
                    window._wrCurrentReportQuery   = enhancedQuery;
                    window._wrCurrentReportParsed  = parsed;

                    // 保存到历史
                    const savedId = await wrSaveReport({
                        title: q.slice(0, 30) + (q.length > 30 ? '…' : ''),
                        category: parsed.reportType,
                        query: enhancedQuery,
                        content: fullText,
                        materialCount: { issues: 0, rules: 0, reports: 0 },
                        date: Date.now(),
                        templateId: template ? template.id : null
                    });
                    window._wrCurrentReportId = savedId;

                    // 在气泡下方追加操作按钮
                    if (aiBubble) {
                        const actionsDiv = document.createElement('div');
                        actionsDiv.style.cssText = 'display:flex;gap:6px;flex-wrap:wrap;margin-top:4px;';
                        actionsDiv.innerHTML = `
                            <button onclick="wrCopyText('${savedId}')" style="padding:5px 10px;border:1px solid var(--border);border-radius:var(--radius-sm);background:#fff;font-size:0.78rem;cursor:pointer;">📋 复制</button>
                            <button onclick="wrDownloadText('${savedId}')" style="padding:5px 10px;background:var(--primary);color:#fff;border:none;border-radius:var(--radius-sm);font-size:0.78rem;cursor:pointer;">📥 下载</button>
                            ${template && template.templateBuffer ? `<button onclick="wrDownloadDocxFromTemplate()" style="padding:5px 10px;background:#2b6cb0;color:#fff;border:none;border-radius:var(--radius-sm);font-size:0.78rem;cursor:pointer;">📄 导出DOCX</button>` : ''}
                            <span style="font-size:0.72rem;color:#059669;align-self:center;">✅ 已保存</span>
                        `;
                        aiBubble.appendChild(actionsDiv);
                    }

                    document.getElementById('wr-query-input').placeholder = '继续提出修改需求…';
                    wrUpdateConvBtn();
                } catch(err) {
                    if (err.name === 'AbortError') {
                        if (streamBubbleContent) {
                            streamBubbleContent.style.background = '#fff7ed';
                            streamBubbleContent.textContent = '⏹️ 已停止生成';
                        }
                    } else {
                        let msg = err.message || '未知错误';
                        if (msg.includes('Failed to fetch')) msg = 'CORS跨域限制：当前API不支持浏览器直接访问，建议切换DeepSeek';
                        if (streamBubbleContent) {
                            streamBubbleContent.style.background = '#fff5f5';
                            streamBubbleContent.style.color = '#e53e3e';
                            streamBubbleContent.textContent = '❌ 生成失败：' + msg;
                        }
                    }
                } finally {
                    if (writeBtn) { writeBtn.disabled = false; writeBtn.textContent = '✍️ 开始写作'; }
                    if (stopBtn) stopBtn.style.display = 'none';
                    _wrAbortController = null;
                }
            };

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
                        + '<button onclick="wrConfirmModify()" style="flex:1;padding:10px;background:linear-gradient(135deg,#3d7d65,#2d6b52);color:#fff;border:none;border-radius:8px;font-size:0.9rem;font-weight:600;cursor:pointer;">✅ 确认完成报告</button>'
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
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url; a.download = ((r && r.title) || '报告') + '.txt'; a.click();
                URL.revokeObjectURL(url);
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
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url; a.download = '写作模板备份_' + new Date().toISOString().slice(0,10) + '.json'; a.click();
                URL.revokeObjectURL(url);
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
                const regex = /\{\{(\w+)\}\}/g;
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

            // ---- 真正应用占位符替换 ----
            function applyTemplatePlaceholders(templateContent, mapping) {
                if (!templateContent || !mapping) return templateContent;
                let result = templateContent;
                for (const [key, value] of Object.entries(mapping)) {
                    const placeholder = `{{${key}}}`;
                    result = result.split(placeholder).join(String(value));
                }
                // 清理未替换的占位符
                result = result.replace(/\{\{\w+\}\}/g, '（待补充）');
                return result;
            }

            // ---- 导出 DOCX（使用 html-docx-js） ----
            window.wrDownloadDocxFromTemplate = async function() {
                const modal = document.getElementById('wr-report-modal');
                const report = modal._currentReport;
                if (!report) {
                    // 如果没有打开模态框，尝试使用当前生成的报告
                    if (!window._wrCurrentReportContent) {
                        alert('没有可导出的报告');
                        return;
                    }
                    await exportDocxFromHtml(window._wrCurrentReportContent, '报告');
                    return;
                }
                await exportDocxFromHtml(report.content, report.title);
            };

            async function exportDocxFromHtml(htmlContent, fileName) {
                if (!htmlContent || htmlContent.trim() === '') {
                    alert('报告内容为空，无法导出');
                    return;
                }
                if (typeof window.htmlDocx === 'undefined') {
                    await new Promise((resolve, reject) => {
                        const script = document.createElement('script');
                        script.src = 'https://cdn.jsdelivr.net/npm/html-docx-js@0.3.1/dist/html-docx.js';
                        script.onload = resolve;
                        script.onerror = () => reject(new Error('加载 html-docx-js 失败'));
                        document.head.appendChild(script);
                    });
                }
                const isMobile = /Mobi|Android/i.test(navigator.userAgent);
                let cleanHtml = htmlContent || '';
                // 手机端：极简 HTML，零样式，确保 mobile Word 兼容
                if (isMobile) {
                    // 先保留换行结构，再剥 HTML
                    var textOnly = cleanHtml.replace(/<br\s*\/?>/gi, '\n').replace(/<p[^>]*>/gi, '\n').replace(/<\/p>/gi, '').replace(/<[^>]+>/g, '');
                    var lines = textOnly.split(/\n+/);
                    var simpleBody = '';
                    for (var i = 0; i < lines.length; i++) {
                        var line = lines[i].trim();
                        if (line) simpleBody += '<p>' + _exportEsc(line) + '</p>';
                    }
                    // 保留表格
                    if (cleanHtml.indexOf('<table') !== -1) {
                        var tableMatch = cleanHtml.match(/<table[\s\S]*?<\/table>/gi);
                        if (tableMatch) simpleBody += tableMatch.join('');
                    }
                    cleanHtml = simpleBody || '<p>（无内容）</p>';
                } else {
                    // 电脑端：规范 HTML 化
                    if (!/<[ph][>\s]|<h[1-6]/.test(cleanHtml)) {
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
                        'body{margin:20pt;padding:0;background:#fff;color:#000;font-family:"Times New Roman",SimSun,"宋体",serif;font-size:12pt;line-height:1.5;}\n' +
                        'table{border-collapse:collapse;width:100%;margin:8pt 0;}td,th{border:1px solid #aaa;padding:4pt 6pt;vertical-align:top;}\n' +
                        'h3{font-size:16pt;margin:12pt 0 6pt;}p{margin:0 0 8pt 0;}\n</style>\n</head>\n<body>\n' + cleanHtml + '\n</body>\n</html>';
                }
                const blob = window.htmlDocx.asBlob(fullHtml);
                if (typeof downloadBlob === 'function') {
                    downloadBlob(blob, fileName + '.docx');
                } else {
                    const url = URL.createObjectURL(blob);
                    const a = document.createElement('a');
                    a.href = url;
                    a.download = fileName + '.docx';
                    a.click();
                    setTimeout(function(){ URL.revokeObjectURL(url); }, 1000);
                }
                if (typeof Toast !== 'undefined') Toast.success('DOCX 已生成');
                else alert('DOCX 已生成，请根据提示保存文件');
            }
            function _exportEsc(s) { return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

            window.wrRenderHistory = async function() {
                const reports = await wrDbGetAll(WR_RPT_STORE);
                const listEl  = document.getElementById('wr-history-list');
                const countEl = document.getElementById('wr-hist-count');
                if (!listEl) return;

                const q = ((document.getElementById('wr-hist-search') || {}).value || '').toLowerCase();
                const filtered = reports.filter(r =>
                    !q || (r.title||'').toLowerCase().includes(q) || (r.content||'').slice(0,200).toLowerCase().includes(q)
                ).sort((a,b) => b.date - a.date);

                if (countEl) countEl.textContent = filtered.length + '/' + reports.length + ' 篇';

                if (!filtered.length) {
                    listEl.innerHTML = '<div style="text-align:center;padding:30px;color:var(--text-secondary);font-size:0.85rem;">' + (q ? '无匹配结果' : '暂无历史报告') + '</div>';
                    return;
                }

                listEl.innerHTML = filtered.map(r => `
                    <div style="background:#fff;border:1px solid var(--border);border-radius:10px;padding:12px 14px;display:flex;align-items:flex-start;gap:10px;">
                        <div style="flex:1;min-width:0;cursor:pointer;" onclick="wrViewReport(${r.id})">
                            <div style="font-weight:700;font-size:0.9rem;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--primary);">${wrEsc(r.title||'未命名报告')}</div>
                            <div style="font-size:0.75rem;color:var(--text-secondary);margin:3px 0;">
                                <span style="background:#f0fdf4;color:#15803d;padding:1px 8px;border-radius:10px;margin-right:6px;">${wrEsc(wrCatName(r.category))}</span>
                                ${wrFmtDate(r.date)}
                                <span style="margin-left:6px;">约${Math.round((r.content||'').length/2)}字</span>
                            </div>
                            <div style="font-size:0.78rem;color:#64748b;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${wrEsc((r.content||'').replace(/\n/g,' ').slice(0,80))}…</div>
                        </div>
                        <div style="display:flex;flex-direction:column;gap:4px;flex-shrink:0;">
                            <button onclick="wrViewReport(${r.id})" style="padding:4px 10px;border:1px solid var(--border);border-radius:var(--radius-sm);background:#f8fafc;font-size:0.75rem;cursor:pointer;">查看</button>
                            <button onclick="wrModifyHistoryReport(${r.id})" style="padding:4px 10px;border:1px solid #bfdbfe;border-radius:var(--radius-sm);background:#eff6ff;color:#1d4ed8;font-size:0.75rem;cursor:pointer;">✏️ 修改</button>
                            <button onclick="wrDeleteReport(${r.id})" style="padding:4px 10px;border:1px solid #fca5a5;border-radius:var(--radius-sm);background:#fff1f2;color:#b91c1c;font-size:0.75rem;cursor:pointer;">删除</button>
                        </div>
                    </div>`).join('');
            };

            window.wrViewReport = async function(id) {
                const reports = await wrDbGetAll(WR_RPT_STORE);
                const r = reports.find(x => x.id === id);
                if (!r) return;
                const modal = document.getElementById('wr-report-modal');
                document.getElementById('wr-report-modal-title').textContent = r.title || '未命名报告';
                document.getElementById('wr-report-modal-meta').textContent =
                    '类型：' + wrCatName(r.category) + '　生成时间：' + wrFmtDate(r.date)
                    + (r.materialCount ? '　引用台账：' + r.materialCount.issues + '条，规章：' + r.materialCount.rules + '条' : '');
                document.getElementById('wr-report-modal-content').textContent = r.content || '';
                modal._currentReport = r;
                modal.style.display = 'flex';
            };

            window.wrCopyReport = async function() {
                const modal = document.getElementById('wr-report-modal');
                const r = modal._currentReport;
                if (!r) return;
                try { await navigator.clipboard.writeText(r.content); alert('已复制到剪贴板！'); }
                catch(e) { alert('复制失败，请手动选中内容复制。'); }
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
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a'); a.href = url; a.download = (r.title||'报告') + '.txt'; a.click();
                URL.revokeObjectURL(url);
            };

            window.wrDeleteReport = async function(id) {
                if (!confirm('确定删除该历史报告吗？')) return;
                await wrDbDelete(WR_RPT_STORE, id);
                const modal = document.getElementById('wr-report-modal');
                if (modal._currentReport && modal._currentReport.id === id) modal.style.display = 'none';
                wrRenderHistory();
            };

            // 修改历史报告
            window.wrModifyHistoryReport = async function(id) {
                const reports = await wrDbGetAll(WR_RPT_STORE);
                const r = reports.find(x => x.id === id);
                if (!r) { alert('报告未找到'); return; }
                // 弹窗输入修改要求
                const modal = document.createElement('div');
                modal.id = 'wr-modify-history-modal';
                modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.45);z-index:10100;display:flex;align-items:center;justify-content:center;';
                modal.innerHTML = '<div style="background:#fff;border-radius:14px;padding:20px;width:min(480px,95vw);max-height:85vh;display:flex;flex-direction:column;gap:12px;">'
                    + '<div style="display:flex;align-items:center;justify-content:space-between;">'
                    + '<span style="font-weight:700;font-size:0.97rem;color:var(--primary);">✏️ 修改报告：' + wrEsc((r.title||'未命名报告').slice(0,20)) + '</span>'
                    + '<button onclick="document.getElementById(\'wr-modify-history-modal\').remove()" style="background:none;border:none;cursor:pointer;font-size:1.2rem;color:#888;">✕</button>'
                    + '</div>'
                    + '<div style="font-size:0.8rem;color:var(--text-secondary);">请输入修改要求，AI 将基于原报告进行调整。</div>'
                    + '<textarea id="wr-modify-instruction" placeholder="例如：增加安全检查项点、补充数据分析段落、调整报告结构..." style="width:100%;min-height:80px;padding:10px;border:1px solid var(--border);border-radius:8px;font-size:0.85rem;resize:vertical;font-family:inherit;"></textarea>'
                    + '<div style="display:flex;gap:10px;">'
                    + '<button id="wr-modify-confirm-btn" style="flex:1;padding:10px;background:linear-gradient(135deg,#2563eb,#1d4ed8);color:#fff;border:none;border-radius:8px;font-size:0.9rem;font-weight:600;cursor:pointer;">✅ 开始修改</button>'
                    + '<button onclick="document.getElementById(\'wr-modify-history-modal\').remove()" style="padding:10px 16px;border:1px solid var(--border);border-radius:8px;background:#f8fafc;font-size:0.9rem;cursor:pointer;">取消</button>'
                    + '</div></div>';
                document.body.appendChild(modal);
                document.getElementById('wr-modify-confirm-btn').onclick = async function() {
                    var instruction = document.getElementById('wr-modify-instruction').value.trim();
                    modal.remove();
                    if (!instruction) { alert('请输入修改要求'); return; }
                    // 将原报告内容和修改要求写入输入框
                    var input = document.getElementById('wr-query-input');
                    var oldVal = input ? input.value : '';
                    var fullPrompt = '【原报告】\n' + (r.content || '') + '\n\n【修改要求】\n' + instruction + '\n\n请基于原报告内容，按修改要求进行调整。保持原有结构和大部分文字，仅修改要求的部分。';
                    if (input) input.value = fullPrompt;
                    window._wrSkipLocalSearch = true; // 跳过本地资料检索
                    await wrGenerate();
                    if (input) input.value = oldVal;
                    window._wrSkipLocalSearch = false;
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
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url; a.download = '历史报告备份_' + new Date().toISOString().slice(0,10) + '.json'; a.click();
                URL.revokeObjectURL(url);
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
                // 更新按钮样式（合并后6种：all/template/history/inspect/fault/dispatch/other）
                ['all','template','history','inspect','fault','dispatch','other'].forEach(t => {
                    const btn = document.getElementById('wr-mat-filter-' + t);
                    if (!btn) return;
                    if (t === type) {
                        btn.style.background = 'var(--primary)'; btn.style.color = '#fff'; btn.style.borderColor = 'var(--primary)';
                    } else {
                        btn.style.background = '#f8fafc'; btn.style.color = 'var(--text)'; btn.style.borderColor = 'var(--border)';
                    }
                });
                // 故障报告同时包含故障统计（stats），通报文电同时包含会议纪要（meeting）
                const histZone = document.getElementById('wr-mat-history-zone');
                const matList  = document.getElementById('wr-mat-list');
                if (histZone) histZone.style.display = 'none';
                if (matList)  matList.style.display = 'flex';
                wrRenderMaterials();
            };

            // 历史报告 Tab 点击：显示历史报告子区域，隐藏普通资料列表
            window.wrMatFilterHistory = function() {
                // 高亮历史报告按钮
                ['all','template','history','inspect','fault','dispatch','other'].forEach(t => {
                    const btn = document.getElementById('wr-mat-filter-' + t);
                    if (!btn) return;
                    if (t === 'history') {
                        btn.style.background = 'var(--primary)'; btn.style.color = '#fff'; btn.style.borderColor = 'var(--primary)';
                    } else {
                        btn.style.background = '#f8fafc'; btn.style.color = 'var(--text)'; btn.style.borderColor = 'var(--border)';
                    }
                });
                const histZone = document.getElementById('wr-mat-history-zone');
                const matList  = document.getElementById('wr-mat-list');
                if (matList)  matList.style.display = 'none';
                if (histZone) { histZone.style.display = 'flex'; histZone.style.flexDirection = 'column'; }
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
                    <div style="background:#fff;border:1px solid var(--border);border-radius:10px;padding:11px 13px;display:flex;align-items:flex-start;gap:10px;">
                        <div style="font-size:1.4rem;flex-shrink:0;margin-top:1px;">${extIcon}</div>
                        <div style="flex:1;min-width:0;">
                            <div style="font-weight:700;font-size:0.88rem;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${wrEsc(m.title||m.fileName)}</div>
                            <div style="font-size:0.73rem;color:var(--text-secondary);margin:2px 0;display:flex;flex-wrap:wrap;gap:5px;align-items:center;">
                                <span style="background:${typeInfo.badge};color:${typeInfo.text};padding:1px 8px;border-radius:10px;">${typeInfo.label}</span>
                                <span>${wrFmtDate(m.importAt).slice(0,10)}</span>
                                ${sizeStr ? '<span>'+sizeStr+'</span>' : ''}
                                ${rowStr ? '<span>'+rowStr+'</span>' : ''}
                            </div>
                            <div style="font-size:0.77rem;color:#64748b;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${wrEsc(preview)}…</div>
                        </div>
                        <div style="display:flex;flex-direction:column;gap:4px;flex-shrink:0;">
                            <button onclick="wrViewMaterial(${m.id})" style="padding:4px 10px;border:1px solid var(--border);border-radius:var(--radius-sm);background:#f8fafc;font-size:0.73rem;cursor:pointer;">查看</button>
                            ${!isTemplate ? `<button onclick="wrSetAsTemplate(${m.id})" style="padding:4px 10px;border:1px solid #bfdbfe;border-radius:var(--radius-sm);background:#eff6ff;color:#1e40af;font-size:0.73rem;cursor:pointer;" title="设为写作模版">⭐ 设模版</button>` : '<button disabled style="padding:4px 10px;border:1px solid #e2e8f0;border-radius:var(--radius-sm);background:#f1f5f9;color:#94a3b8;font-size:0.73rem;cursor:not-allowed;">✓ 已是模版</button>'}
                            <select onchange="wrChangeMaterialType(${m.id},this.value)" style="padding:3px 5px;border:1px solid var(--border);border-radius:var(--radius-sm);font-size:0.7rem;cursor:pointer;background:#f8fafc;" title="修改类型">
                                ${Object.entries(WR_MAT_TYPES).map(([k,v])=>'<option value="'+k+'"'+(k===m.matType?' selected':'')+'>'+v.label+'</option>').join('')}
                            </select>
                            <button onclick="wrDeleteMaterial(${m.id})" style="padding:4px 10px;border:1px solid #fca5a5;border-radius:var(--radius-sm);background:#fff1f2;color:#b91c1c;font-size:0.73rem;cursor:pointer;">删除</button>
                        </div>
                    </div>`;
                }).join('');
            };

            /**
             * 查看资料详情（弹窗）
             */
            window.wrViewMaterial = async function(id) {
                const all = await wrDbGetAll(WR_MAT_STORE);
                const m = all.find(x => x.id === id);
                if (!m) return;
                const typeInfo = WR_MAT_TYPES[m.matType] || WR_MAT_TYPES.other;

                // 复用报告弹窗，或创建独立弹窗
                let modal = document.getElementById('wr-mat-view-modal');
                if (!modal) {
                    modal = document.createElement('div');
                    modal.id = 'wr-mat-view-modal';
                    modal.style.cssText = 'display:none;position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:10000;align-items:center;justify-content:center;';
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
                                <button onclick="document.getElementById('wr-mat-view-modal').style.display='none'" style="padding:7px 14px;background:var(--primary);color:#fff;border:none;border-radius:var(--radius-sm);font-size:0.82rem;cursor:pointer;">关闭</button>
                            </div>
                        </div>`;
                    document.body.appendChild(modal);
                }
                document.getElementById('wr-mat-view-title').textContent = m.title || m.fileName;
                document.getElementById('wr-mat-view-meta').textContent =
                    '类型：' + typeInfo.label + '　文件：' + (m.fileName||'') + '　导入：' + wrFmtDate(m.importAt)
                    + (m.rowCount ? '　' + m.rowCount + '条记录' : '') + (m.fileSize ? '　' + Math.round(m.fileSize/1024) + 'KB' : '');
                document.getElementById('wr-mat-view-content').textContent = String(m.content || '（内容为空）');
                modal._content = String(m.content || '');
                modal.style.display = 'flex';
            };

            window.wrCopyMaterialContent = async function() {
                const modal = document.getElementById('wr-mat-view-modal');
                if (!modal || !modal._content) return;
                try { await navigator.clipboard.writeText(modal._content); alert('已复制到剪贴板！'); }
                catch(e) { alert('复制失败，请手动选中内容复制。'); }
            };

            /**
             * 修改资料类型
             */
            window.wrChangeMaterialType = async function(id, newType) {
                const all = await wrDbGetAll(WR_MAT_STORE);
                const m = all.find(x => x.id === id);
                if (!m) return;
                m.matType = newType;
                await wrDbPut(WR_MAT_STORE, m);
                wrRenderMaterials();
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
                const all = await wrDbGetAll(WR_MAT_STORE);
                const m = all.find(x => x.id === id);
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
            };

            /**
             * 导出资料库为JSON
             */
            window.wrMaterialExportAll = async function() {
                const all = await wrDbGetAll(WR_MAT_STORE);
                if (!all.length) { alert('资料库为空，无法导出'); return; }
                // 导出时去掉sheets（可能很大），只保留content
                const exportData = all.map(m => ({ ...m, sheets: undefined }));
                const blob = new Blob([JSON.stringify({ materials: exportData, exportDate: new Date().toISOString() }, null, 2)], { type: 'application/json' });
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url; a.download = '资料库备份_' + new Date().toISOString().slice(0,10) + '.json'; a.click();
                URL.revokeObjectURL(url);
            };

        // ---- 将内部函数暴露到全局（供 HTML onclick 调用）----
        window.toggleDoubaoMode      = typeof toggleDoubaoMode !== 'undefined' ? toggleDoubaoMode : function(){ console.warn('[doubao] toggleDoubaoMode 未定义'); };
        window.showApiConfigModal     = typeof showApiConfigModal !== 'undefined' ? showApiConfigModal : function(){};
        window.saveApiConfigFromModal = typeof saveApiConfigFromModal !== 'undefined' ? saveApiConfigFromModal : function(){ console.warn('[doubao] saveApiConfigFromModal 未定义'); };
        window.bindApiModalEvents     = typeof bindApiModalEvents !== 'undefined' ? bindApiModalEvents : function(){};
        // dsInit 在 IIFE 开头定义，也需暴露
        window.dsInit                 = typeof dsInit !== 'undefined' ? dsInit : function(){};

    })();

// ============================================================
// Part B: 增强功能 IIFE（原始代码 15255-15809 行）
// ============================================================
    (function() {
      'use strict';

      // ---------- 1. 依赖检查 ----------
      const hasGetRules = typeof window.getRulesData === 'function';
      const hasGetIssue = typeof window.getIssueData === 'function';
      if (!hasGetRules && !hasGetIssue) console.warn('[增强] 未找到规章/检查数据，部分功能受限');

      // ---------- 2. 角色提示词 ----------
      const ROLE_PROMPTS = {
        'default':  '你是一个全能的智能助手，请根据用户需求提供准确、有用的回答。你可以回答铁路安全专业问题，也可以回答任何其他领域的通用知识问题。',
        'dianwu':   '你现在作为一名电务安全监察专家进行工作，精通信号、联锁、CTC、轨道电路等规章，请从电务专业视角分析问题。',
        'gongwu':   '你现在作为一名工务安全监察专家进行工作，精通线路、桥隧、防洪等规章，请从工务专业视角分析问题。',
        'gongdian': '你现在作为一名供电安全监察专家进行工作，精通接触网、变电、电力等规章，请从供电专业视角分析问题。',
        'chewu':    '你现在作为一名车务安全监察专家进行工作，精通接发列车、调车、施工登销记等规章，请从车务专业视角分析问题。',
        'keyun':    '你现在作为一名客运安全监察专家进行工作，精通客运组织、乘降安全、站车秩序等规章，请从客运专业视角分析问题。',
        'jiwu':     '你现在作为一名机务安全监察专家进行工作，精通机车运用、乘务管理、LKJ分析等规章，请从机务专业视角分析问题。',
        'cheliang': '你现在作为一名车辆安全监察专家进行工作，精通5T系统、轮轴、制动等规章，请从车辆专业视角分析问题。',
        'tongxin':  '你现在作为一名通信安全监察专家进行工作，精通GSM-R、光纤、数调等规章，请从通信专业视角分析问题。',
        'fangjian': '你现在作为一名房建安全监察专家进行工作，精通站台限界、雨棚、房屋等规章，请从房建专业视角分析问题。',
        'huoyun':   '你现在作为一名货运安全监察专家进行工作，精通装载加固、超限货物等规章，请从货运专业视角分析问题。',
        'tongyong': '你现在作为一名铁路综合安全监察专家，能够进行跨专业的综合分析、风险研判。',
        'frontend': '你是一位资深前端工程师。请根据用户需求编写干净的 HTML/CSS/JS 代码。要求：代码自包含，可直接运行；使用现代浏览器特性；输出完整 HTML 代码块。',
        'riskanalyst': '你是铁路安全风险分析专家。你的任务是：\n1. 基于检查数据和规章制度，识别当前最突出的安全风险领域\n2. 按时间趋势、专业分布、问题性质三个维度分析\n3. 针对高危领域给出具体的预警措施和整改建议\n4. 输出格式要求：先概述总体情况，再分点列出风险等级（高/中/低），最后给出3-5条可执行的预警措施。\n5. 引用数据时标注来源和时间范围，建议要具体可操作。',
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
        // 无条件返回最近记忆，按时间倒序取最新10条
        return userMemories.slice(-66).reverse();
      }

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

      // 【性能优化】页面空闲时预构建 BM25 索引，避免首次查询时 200-500ms 同步卡顿
      if (typeof requestIdleCallback === 'function') {
        requestIdleCallback(function() { getBM25Rules(); getBM25Issues(); }, { timeout: 5000 });
      } else {
        setTimeout(function() { getBM25Rules(); getBM25Issues(); }, 3000);
      }

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
        const model = localStorage.getItem('ds_model_v1') || 'deepseek-chat';
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
      var RISK_CONFIG_KEY = 'risk_config_v1';

      function saveRiskConfig() {
        var conf = {
          dateStart: document.getElementById('risk-date-start')?.value || '',
          dateEnd: document.getElementById('risk-date-end')?.value || '',
          trade: document.getElementById('risk-trade')?.value || '',
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
          if (conf.trade && (el = document.getElementById('risk-trade'))) el.value = conf.trade;
          if (conf.unit && (el = document.getElementById('risk-unit'))) el.value = conf.unit;
          if (conf.focus && (el = document.getElementById('risk-focus'))) el.value = conf.focus;
          if (conf.format) {
            var radio = document.querySelector('input[name="risk-format"][value="' + conf.format + '"]');
            if (radio) radio.checked = true;
          }
        } catch(e) {}
      }

      async function saveRiskReportToWriter(title, html) {
        try {
          var now = new Date();
          var plainText = html.replace(/<[^>]+>/g, '').replace(/\n{3,}/g, '\n\n').trim();
          var report = {
            title: title || ('风险研判 ' + now.toLocaleString('zh-CN').replace(/\//g, '-')),
            category: '风险研判',
            content: plainText.slice(0, 500),
            rawHtml: html,
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
              tx.objectStore('writing_reports').add(report);
              tx.oncomplete = function() { db.close(); resolve(); };
              tx.onerror = function() { reject(tx.error); };
            };
            dbReq.onerror = function() { reject(dbReq.error); };
          });
          console.log('风险报告已存入写作历史');
        } catch(e) {
          console.warn('保存风险报告到写作历史失败:', e);
        }
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
          var model   = localStorage.getItem('ds_model_v1') || 'deepseek-chat';

          var messages = [];
          if (!followUp) {
            // 读取研判条件
            var dateStart = document.getElementById('risk-date-start')?.value || '';
            var dateEnd = document.getElementById('risk-date-end')?.value || '';
            var trade = document.getElementById('risk-trade')?.value || '';
            var unit = document.getElementById('risk-unit')?.value.trim() || '';
            var focus = document.getElementById('risk-focus')?.value.trim() || '';
            var formatEl = document.querySelector('input[name="risk-format"]:checked');
            var format = formatEl ? formatEl.value : 'full';
            var formatDesc = { full: '完整报告：总体概况 + 风险分级 + 预警措施', brief: '简要摘要：只输出关键风险点和数量统计', actions: '整改措施清单：仅列出3-5条可执行的整改措施' }[format] || '完整报告';

            var summary = await _buildRiskDataSummary(dateStart, dateEnd, trade, unit);
            var userMsg = '请基于以下铁路安全检查数据进行风险研判：\n\n' + summary + '\n\n';
            userMsg += '研判要求：\n';
            if (dateStart || dateEnd) userMsg += '- 时间范围：' + (dateStart||'不限') + ' 至 ' + (dateEnd||'不限') + '\n';
            if (trade) userMsg += '- 限定专业：' + trade + '\n';
            if (unit) userMsg += '- 限定单位：' + unit + '\n';
            userMsg += '- 重点关注：' + (focus || '通用安全风险') + '\n';
            userMsg += '- 输出格式：' + formatDesc + '\n';
            userMsg += '\n请开始分析。';

            messages = [
              { role: 'system', content: '你是铁路安全风险分析专家。请严格按照用户要求的时间范围、专业限定、分析重点和输出格式进行分析。' },
              { role: 'user', content: userMsg }
            ];
          } else {
            messages = (window._riskCtx || []);
            var refineInput = document.getElementById('risk-refine-input');
            var refineText = refineInput ? refineInput.value.trim() : '';
            if (!refineText) refineText = '请进一步分析';
            messages.push({ role: 'user', content: refineText });
            if (refineInput) refineInput.value = '';
          }

          var resp = await fetch(apiUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + apiKey },
            body: JSON.stringify({ model: model, messages: messages, temperature: 0.3, max_tokens: 3000, stream: false })
          });

          if (!resp.ok) throw new Error('HTTP ' + resp.status);
          var data = await resp.json();
          var report = (data.choices && data.choices[0] && data.choices[0].message) ? data.choices[0].message.content : '无响应';

          // 保存上下文供追问
          window._riskCtx = messages;
          window._riskCtx.push({ role: 'assistant', content: report });

          // 渲染结果（简单markdown → HTML，保证换行）
          var html = report
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/## (.*)/g, '<h3 style="margin:14px 0 8px;color:var(--primary);font-size:1.05rem;">## $1</h3>')
            .replace(/### (.*)/g, '<h4 style="margin:10px 0 6px;color:#1e40af;">$1</h4>')
            .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
            .replace(/\n- /g, '\n<li>').replace(/\n\d+\. /g, '\n<li>')
            .replace(/\n/g, '<br>')
            .replace(/<li>/g, '<li style="margin:4px 0 4px 20px;">');

          container.innerHTML = html;
          container.scrollTop = 0;
          // 保存配置，并将报告存入智能写作资料库
          saveRiskConfig();
          saveRiskReportToWriter(null, html);

          if (refineArea) {
            refineArea.style.display = 'flex';
            refineArea.style.flexDirection = 'column';
          }
        } catch(e) {
          container.innerHTML = '<div style="color:#dc2626;padding:20px;">❌ ' + (e.message || '分析失败') + '</div>';
        }
      };

      window.refineRiskAnalysis = function() {
        window.runRiskAnalysis(true);
      };

      async function _buildRiskDataSummary(dateStart, dateEnd, tradeFilter, unitFilter) {
        var parts = [];
        var startDate = dateStart ? new Date(dateStart) : null;
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
              var r = indexedDB.open('RailwayIssueDB_v2', 1);
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
            if (tradeFilter) {
              filtered = filtered.filter(function(d) { return d.category === tradeFilter; });
            }
            if (unitFilter) {
              filtered = filtered.filter(function(d) {
                return (d.unit||'').indexOf(unitFilter) !== -1 || (d.department||'').indexOf(unitFilter) !== -1;
              });
            }
            var dateLabel = [dateStart ? '从'+dateStart : '', dateEnd ? '至'+dateEnd : ''].filter(Boolean).join(' ') || '全部时间';
            var cats = {}; filtered.forEach(function(d){ cats[d.category]=(cats[d.category]||0)+1; });
            var nats = {}; filtered.forEach(function(d){ nats[d['性质']]=(nats[d['性质']]||0)+1; });
            var dateLabel = cutoffDate
              ? (dateRangeDays <= 90 ? '近'+Math.round(dateRangeDays/30)+'月' : dateRangeDays <= 365 ? '近'+Math.round(dateRangeDays/30)+'月' : '全部')
              : '全部时间';
            parts.push('【检查信息】总计'+all.length+'条, 本次筛选'+filtered.length+'条('+dateLabel+(tradeFilter?'/'+tradeFilter:'')+')');
            parts.push('专业TOP5: '+Object.entries(cats).sort(function(a,b){return b[1]-a[1]}).slice(0,5).map(function(e){return e[0]+'('+e[1]+')'}).join(', '));
            parts.push('性质: '+Object.entries(nats).sort(function(a,b){return b[1]-a[1]}).slice(0,5).map(function(e){return e[0]+'('+e[1]+')'}).join(', '));
            parts.push('样本: '+filtered.slice(0,5).map(function(d){return (d.datetime||'')+' '+(d.category||'')+' '+(d.content||'').slice(0,60)}).join(' | '));
          }
        } catch(e) { parts.push('【检查信息】读取失败'); console.error('风险研判: 检查信息读取异常', e); }

        // 读取检查手册数据供 AI 参考
        try {
          var hbData = typeof window.getHandbookData === 'function' ? window.getHandbookData() : [];
          if (hbData.length) {
            // 抽样：手册条目可能很多，展示前10条格式
            var sampled = hbData.length > 10 ? hbData.slice(0, 10) : hbData;
            parts.push('【检查手册】总计'+hbData.length+'条，展示前10条目录：');
            sampled.forEach(function(r, i) {
              var path = [r.chapter, r.section, r.item, r.subitem].filter(Boolean).join(' > ');
              parts.push((i+1)+'. ['+path+']');
            });
          }
        } catch(e) {}

        return parts.join('\n');
      }

      // ---------- 9. 增强 dsSendMsg（角色提示词 + 记忆）----------
      var originalDsSendMsg = window.dsSendMsg;
      window.ROLE_PROMPTS = ROLE_PROMPTS;
      window._originalSendMsg = originalDsSendMsg;

      if (typeof originalDsSendMsg === 'function') {
        window.dsSendMsg = async function() {
          const inputEl = document.getElementById('ds-user-input');
          let userText = inputEl ? inputEl.value.trim() : '';
          if (!userText) return;

          const roleSelect = document.getElementById('expertRole');
          const selectedRole = roleSelect ? roleSelect.value : '';
          const isProfessional = selectedRole !== '' && selectedRole !== 'tongyong' && selectedRole !== 'frontend';
          const writingMode = document.getElementById('writing-mode') && document.getElementById('writing-mode').checked;

          // 写作模式路由
          if (writingMode && typeof window.wrWrite === 'function') {
            inputEl.value = '';
            var wrInputEl = document.getElementById('wr-query-input');
            if (wrInputEl) wrInputEl.value = userText;
            var chatBox = document.getElementById('ds-chat-box');
            if (chatBox) { chatBox.style.display = 'flex'; }
            try { await window.wrWrite(); } catch(e) {}
            var reportText = window._wrCurrentReportContent;
            if (reportText && chatBox) {
              var asstDiv = document.createElement('div');
              asstDiv.className = 'ds-row-assistant';
              asstDiv.innerHTML = '<div class="ds-bubble-assistant">' + (typeof wrStreamFormat === 'function' ? wrStreamFormat(reportText.slice(0, 800)) : reportText.slice(0, 800).replace(/\n/g, '<br>')) + '</div>';
              chatBox.appendChild(asstDiv);
            }
            if (wrInputEl) wrInputEl.value = '';
            return;
          }

          // 1. 角色设定
          var rolePrompt = '';
          var key = selectedRole || 'default';
          if (ROLE_PROMPTS[key]) {
            rolePrompt = '【角色设定】\n' + ROLE_PROMPTS[key] + '\n\n';
          }

          // 2. 长期记忆
          const newFacts = extractFacts(userText);
          newFacts.forEach(f => addMemory(f));
          var memories = getRelevantMemories(userText);
          var memoryText = memories.length ? '【长期记忆】\n' + memories.map(function(m) { return '• ' + m.fact; }).join('\n') + '\n\n' : '';

          // 3. 组装并发送
          var finalMessage = rolePrompt + memoryText + '用户问题：' + userText;
          inputEl.value = finalMessage;
          await originalDsSendMsg();
          inputEl.value = '';

          let convCount = parseInt(localStorage.getItem('conv_count') || '0') + 1;
          localStorage.setItem('conv_count', convCount);
        };
      }

      // ---------- 10. 反馈收集 ----------
      function addFeedbackButtons(messageDiv, assistantContent) {
        var fbDiv = document.createElement('div');
        fbDiv.style.cssText = 'display:flex; gap:8px; justify-content:flex-end; margin-top:6px; flex-wrap:wrap;';
        fbDiv.innerHTML = '<button class="feedback-copy" style="background:none; border:1px solid #d1d5db; border-radius:14px; padding:3px 10px; font-size:0.75rem; cursor:pointer; color:#6b7280; transition:all 0.15s;" onmouseover="this.style.borderColor=\'#10b981\';this.style.color=\'#10b981\'" onmouseout="this.style.borderColor=\'#d1d5db\';this.style.color=\'#6b7280\'" title="复制本条回复">📋 复制</button>' +
                          '<button class="feedback-download" style="background:none; border:1px solid #d1d5db; border-radius:14px; padding:3px 10px; font-size:0.75rem; cursor:pointer; color:#6b7280; transition:all 0.15s;" onmouseover="this.style.borderColor=\'#8b5cf6\';this.style.color=\'#8b5cf6\'" onmouseout="this.style.borderColor=\'#d1d5db\';this.style.color=\'#6b7280\'" title="下载本条回复">📥 下载</button>' +
                          '<button class="feedback-good" style="background:none; border:1px solid #d1d5db; border-radius:14px; padding:3px 10px; font-size:0.75rem; cursor:pointer; color:#6b7280; transition:all 0.15s;" onmouseover="this.style.borderColor=\'#3b82f6\';this.style.color=\'#3b82f6\'" onmouseout="this.style.borderColor=\'#d1d5db\';this.style.color=\'#6b7280\'">👍 有用</button>' +
                          '<button class="feedback-bad" style="background:none; border:1px solid #d1d5db; border-radius:14px; padding:3px 10px; font-size:0.75rem; cursor:pointer; color:#6b7280; transition:all 0.15s;" onmouseover="this.style.borderColor=\'#ef4444\';this.style.color=\'#ef4444\'" onmouseout="this.style.borderColor=\'#d1d5db\';this.style.color=\'#6b7280\'">👎 无用</button>';
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
        // 下载本消息
        fbDiv.querySelector('.feedback-download').onclick = function(){
          var blob = new Blob([assistantContent], {type: 'text/plain;charset=utf-8'});
          var a = document.createElement('a');
          a.href = URL.createObjectURL(blob);
          a.download = '智能对话_' + new Date().toISOString().slice(0,10) + '.txt';
          a.click();
          setTimeout(function(){ URL.revokeObjectURL(a.href); }, 100);
        };
        fbDiv.querySelector('.feedback-good').onclick = function(){ saveFeedback('good', assistantContent); };
        fbDiv.querySelector('.feedback-bad').onclick = function(){ saveFeedback('bad', assistantContent); };
      }
      window._addFeedbackButtons = addFeedbackButtons;

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
      var memoryCheck = document.getElementById('memoryEnable');
      if (memoryCheck) {
        memoryEnabled = memoryCheck.checked;
        memoryCheck.addEventListener('change', function(e){ memoryEnabled = e.target.checked; });
      }
      observeAssistantBubbles();

      console.log('%c✅ 智能助手已启动 | 角色切换 · 长期记忆 · 反馈收集', 'color:#059669;font-weight:bold;');
    })();
