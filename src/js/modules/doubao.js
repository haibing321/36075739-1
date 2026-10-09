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
            const DS_DEFAULT_MODEL   = 'deepseek-flash';
            const DS_MAX_CTX_CHARS   = 6000;  // 单类别最多携带的字符数
            // 【C1/v3.74】统一检索层「单轮总量预算」（字）：此前只有单源预算（每源 6000 字），
            //   而实测各源 5 块最多 ~2000 字 → 该预算从不触顶、形同虚设。现在按源顺序从总量里分配，
            //   用尽后后续源不再注入（实测现状单轮注入 6269 字 → 分档+总量预算后 4596 字，-27%）。
            const DS_KB_TOTAL_BUDGET = 4500;
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
            let _globalCandidatesMap = {}; // 已移至 smart-check.js
            window._dsAbortController = null; // 智能对话流式终止控制器
            // 对话历史"解析失败保护态"：为 true 时拒绝覆写 localStorage，
            // 避免把可恢复的损坏原文洗成空数组（见 dsLoadConversations / dsSaveConversations）。
            let _dsConvLoadFailed = false;

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
                var _u = window.dsNormalizeApiUrl ? window.dsNormalizeApiUrl(p.apiUrl || '') : (p.apiUrl || '');
                if (!_u) _u = DS_DEFAULT_API_URL;
                localStorage.setItem(DS_API_KEY_STORAGE, p.apiKey || '');
                localStorage.setItem(DS_API_URL_STORAGE, _u);
                localStorage.setItem(DS_MODEL_STORAGE, p.model || DS_DEFAULT_MODEL);
                dsApiKey = p.apiKey || ''; dsApiUrl = _u; dsModel = p.model || DS_DEFAULT_MODEL;
                // 【2026-09-19】配置变更收口：刷新"依赖是否已配置 API"的界面（工作写实的「✨ 一键修改」显隐）
                try { if (typeof window.diaryAiSyncBtn === 'function') window.diaryAiSyncBtn(); } catch (e) {}
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
            // 旧模型名 → V4.1 Flash 规范名迁移
            // 背景：DeepSeek 已下线 V4 Flash 与 V4 Flash Vision Exp，改由原生多模态的 V4.1 Flash 承接，
            // 规范模型名为 deepseek-flash；旧名 deepseek-v4-flash / deepseek-v4-flash-vision-exp
            // 官方只是「暂时」路由到 V4.1 Flash。若不迁移：
            //   ① 一旦官方取消兼容路由，本地历史配置会直接调用失败；
            //   ② 模型简称显示与实际不符（仍显示 v4-flash / v4-vision）；
            //   ③ 能力判定（是否支持看图）继续走旧名的分支，容易误判。
            var DS_LEGACY_MODEL_MAP = {
                'deepseek-v4-flash': 'deepseek-flash',
                'deepseek-v4-flash-vision-exp': 'deepseek-flash',
                'deepseek-v4-flash-vision': 'deepseek-flash',
                'deepseek-v4-vision': 'deepseek-flash'
            };
            // 已**彻底退役、不再路由到任何模型**的名字（2026-07-24 15:59 UTC 起）：deepseek-chat / deepseek-reasoner。
            // 它们不像 v4-flash 那样还有官方兼容路由，留着就是必报错（官方错误码里模型名错误以 400 返回）。
            // ⚠️ 但只在 DeepSeek 官方端点上改写：第三方网关/代理可能自定义了同名模型，无脑改反而会改坏。
            var DS_RETIRED_MODEL_MAP = {
                'deepseek-chat': 'deepseek-flash',
                'deepseek-reasoner': 'deepseek-flash'
            };
            function _isDsEndpoint(url) {
                var u = String(url || '').trim();
                if (!u) return true;                                   // 未配置 URL → 默认按官方端点处理
                try { return /(^|\.)deepseek\.com$/i.test(new URL(u).host); } catch (e) { return false; }
            }
            function migrateLegacyModelNames() {
                var changed = false;
                // 1) 多 Provider 配置（模型管理列表）：model 字段与显示名一并改写
                try {
                    var arr = getProviders();
                    var hit = false;
                    arr.forEach(function(p) {
                        var _map = Object.assign({}, DS_LEGACY_MODEL_MAP);
                        if (_isDsEndpoint(p.apiUrl)) Object.assign(_map, DS_RETIRED_MODEL_MAP);
                        var cur = String(p.model || '').toLowerCase();
                        if (_map[cur]) { p.model = _map[cur]; hit = true; }
                        if (p.name) {
                            Object.keys(_map).forEach(function(k) {
                                if (p.name.toLowerCase().indexOf(k) !== -1) {
                                    p.name = p.name.replace(new RegExp(k, 'gi'), _map[k]);
                                    hit = true;
                                }
                            });
                        }
                    });
                    if (hit) { saveProviders(arr); changed = true; }
                } catch (e) {}
                // 2) 兼容键 ds_model_v1：智能对规 / 智能写作(WR_MODEL_K) / 智能体均读此键
                try {
                    var lm = localStorage.getItem(DS_MODEL_STORAGE) || '';
                    var _map2 = Object.assign({}, DS_LEGACY_MODEL_MAP);
                    // 这里的地址只用于判断"是否 DeepSeek 官方端点"，同样先归一化 ——
                    // 缺 scheme 的旧值会让 new URL() 抛错、_isDsEndpoint 误判为非官方端点，
                    // 结果退役模型名不会被改写（留下必报错的配置）
                    var _urlForCheck = window.dsGetApiUrl ? window.dsGetApiUrl() : localStorage.getItem('ds_api_url_v1');
                    if (_isDsEndpoint(_urlForCheck)) Object.assign(_map2, DS_RETIRED_MODEL_MAP);
                    var mapped = _map2[lm.toLowerCase()];
                    if (mapped) { localStorage.setItem(DS_MODEL_STORAGE, mapped); changed = true; }
                } catch (e) {}
                if (changed) {
                    console.log('[doubao] 旧模型名已迁移为 deepseek-flash（DeepSeek V4.1 Flash）');
                }
                return changed;
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
                // 通知下拉菜单重建（模型列表可能变化）；bubbles:true 供 document 级动态监听（v3.24：还原后旧节点监听失效）
                try { sel.dispatchEvent(new Event('ds-rebuild', { bubbles: true })); } catch(e){}
            }

            // ==================== API 地址自愈（v3.70）====================
            // 场景：地址是按设备存的，某台设备（常见于手机）里存的地址若缺 https:// 或缺少
            //   /chat/completions 路径，请求会被 fetch 当相对路径解析 → 打到本站自己 → 404，
            //   四个 AI 功能（对话/对规/写作/风险研判）会同时失效。
            // 这里在启动时把「已存坏的值」就地修正并回写，用户无需重新输入；
            // 只修客观错误（缺 scheme、已知供应商缺路径），第三方网关的自定义地址一律不动。
            function repairApiUrlConfig() {
                var changed = false;
                try {
                    var raw = localStorage.getItem(DS_API_URL_STORAGE) || '';
                    var fixed = window.dsNormalizeApiUrl ? window.dsNormalizeApiUrl(raw) : raw;
                    if (raw && fixed && fixed !== raw) {
                        localStorage.setItem(DS_API_URL_STORAGE, fixed);
                        changed = true;
                        console.warn('[doubao] API 地址不完整，已自动修正：' + raw + ' → ' + fixed);
                    }
                } catch (e) {}
                try {
                    var arr = getProviders(), hit = false;
                    arr.forEach(function(p) {
                        if (!p.apiUrl) return;
                        var f = window.dsNormalizeApiUrl ? window.dsNormalizeApiUrl(p.apiUrl) : p.apiUrl;
                        if (f && f !== p.apiUrl) { console.warn('[doubao] 模型「' + (p.name || p.model) + '」地址已修正：' + p.apiUrl + ' → ' + f); p.apiUrl = f; hit = true; }
                    });
                    if (hit) { saveProviders(arr); changed = true; }
                } catch (e) {}
                return changed;
            }

            // ---- 首次渲染（启动优化 2026-09-18）----
            // 背景：原实现无论用户当前停在哪个模块，dsInit（defer+100ms）都要渲染整段对话气泡、
            //   重建历史列表，并读一次 `sidebar.offsetWidth`（**强制同步布局**）——实测是一段 ~50ms 长任务
            //   （对话越多越长），而绝大多数启动的当前模块是检查信息/规章/日记等，聊天面板根本不可见。
            // 现在：面板已可见（用户上次就停在智能助手）→ 立即渲染，行为与之前完全一致；
            //   否则挂到「首次切到 doubao」时再渲染（onShow_doubao + tabChanged 双保险）。
            // ⚠️ 对话数据本身（dsLoadConversations）仍在启动时加载，避免"未加载就保存"把历史覆盖掉。
            var _dsChatRendered = false;
            function dsPanelVisible() {
                try {
                    var p = document.getElementById('panel-doubao');
                    return !!(p && p.classList.contains('active'));
                } catch (e) { return true; }
            }
            function dsEnsureChatRendered() {
                if (_dsChatRendered) return;
                _dsChatRendered = true;
                // 清理历史里残留的「当前模型为纯文本模型」旧提示（否则模型会在无关话题中反复复述）
                try { migrateLegacyVisionNotices(); } catch (e) {}
                dsRenderAll();
                dsScrollBottom();
                dsRenderHistoryList();
                // 初始化侧边栏隐藏位置（适配手机端vw宽度）
                (function() {
                    var sb = document.getElementById('ds-sidebar');
                    if (sb) sb.style.left = '-' + (sb.offsetWidth + 20) + 'px';
                })();
            }
            window.dsEnsureChatRendered = dsEnsureChatRendered;

            // ---- 初始化 ----
            function dsInit() {
                migrateLegacyApiConfig();
                // 旧模型名（deepseek-v4-flash / -vision-exp 等）统一改写为 deepseek-flash
                // 必须放在 migrateLegacyApiConfig 之后：后者可能刚从 ds_model_v1 生成 Provider 条目
                migrateLegacyModelNames();
                // 修正已存的坏 API 地址（必须在读 activeProvider 之前，否则本次仍用坏地址发起请求）
                repairApiUrlConfig();
                var ap = getActiveProvider();
                if (ap) { dsApiKey = ap.apiKey || ''; dsApiUrl = ap.apiUrl || DS_DEFAULT_API_URL; dsModel = ap.model || DS_DEFAULT_MODEL; }
                else { dsApiKey = ''; dsApiUrl = DS_DEFAULT_API_URL; dsModel = DS_DEFAULT_MODEL; }
                // 旧配置键也一并归一化，供 agent-core / smart-check / smart-writer / risk 读取点自愈
                try {
                    var _liveUrl = window.dsNormalizeApiUrl ? window.dsNormalizeApiUrl(dsApiUrl) : dsApiUrl;
                    if (_liveUrl && _liveUrl !== dsApiUrl) { dsApiUrl = _liveUrl; localStorage.setItem(DS_API_URL_STORAGE, _liveUrl); }
                } catch (e) {}
                
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
                // 首次渲染：面板可见就立即渲染，否则推迟到用户真正切进智能助手时（见 dsEnsureChatRendered）
                if (dsPanelVisible()) {
                    dsEnsureChatRendered();
                } else {
                    window.onShow_doubao = function () {
                        try { dsEnsureChatRendered(); } catch (e) {}
                    };
                    // 双保险：unified-enhancements 包装过的 switchTab 会派发 tabChanged（含侧滑/程序化切换）
                    document.addEventListener('tabChanged', function (e) {
                        if (e && e.detail && e.detail.tab === 'doubao') dsEnsureChatRendered();
                    });
                }
                // DeepSeek 习惯：Enter 发送，Shift+Enter 换行（兼容 Ctrl+Enter）
                document.getElementById('ds-user-input').addEventListener('keydown', function(e) {
                    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); dsSendMsg(); }
                    else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); dsSendMsg(); }
                });
                // 根据 API Key 状态切换豆包网页版/本地模块
                toggleDoubaoMode();
                // v3.31：恢复上次使用的子视图（localStorage 持久化，折叠/刷新后即使整页
                //   快照降级也能回到折叠前的子模块，而非默认智能对话）
                try {
                    var _lastSub = localStorage.getItem('ds_sub_view');
                    if (_lastSub && _lastSub !== 'chat') {
                        var _p = { check: 'ds-sub-check', chat: 'ds-sub-chat', writer: 'ds-sub-writer', risk: 'ds-sub-risk', agent: 'ds-sub-agent', doubao: 'ds-sub-doubao' };
                        var _el = document.getElementById(_p[_lastSub]);
                        if (_el && typeof window.dsSwitchSub === 'function') window.dsSwitchSub(_lastSub);
                    }
                } catch (e) {}
                // 渲染 chat 工具栏模型选择下拉
                renderChatModelSelect();
                // 角色/模型圆形图标按钮下拉初始化（与附件/发送同款）
                dsInitDropdowns();
            }

            // ---- 多对话管理 ----
            // 历史清洗：旧版本（≤v3.57）在「模型不支持看图 + 用户带图」时，会把
            // 「（提示：当前模型为纯文本模型，图片无法被识别…）」直接拼进**用户消息正文**并随对话历史持久化。
            // 后果：该提示从此常驻上下文，模型会在无关话题（例如只说了「你好」）里也复述「我当前为纯文本模型」。
            // v3.58 起已改用「系统提示」措辞并明确禁止复述，这里把历史里已有的旧提示一并清除（含当前会话内存中的副本）。
            function migrateLegacyVisionNotices() {
                var RE = /（提示：当前模型为纯文本模型[^）]*）|（当前模型为纯文本模型[^）]*）/g;
                var changed = false;
                function clean(obj) {
                    if (!obj) return;
                    ['content', 'displayText'].forEach(function(k) {
                        var v = obj[k];
                        if (typeof v === 'string' && v.indexOf('当前模型为纯文本模型') !== -1) {
                            var nv = v.replace(RE, '').trim();
                            if (nv !== v) { obj[k] = nv; changed = true; }
                        }
                    });
                }
                try {
                    (dsConversations || []).forEach(function(c) {
                        (c.messages || []).forEach(clean);
                    });
                    (dsHistory || []).forEach(clean);
                    if (changed) dsSaveConversations();
                } catch (e) {}
                return changed;
            }
            function dsLoadConversations() {
                var _corrupt = false;
                try {
                    const saved = localStorage.getItem(DS_CONVERSATIONS_STORAGE);
                    if (saved) {
                        const parsed = JSON.parse(saved);
                        // ⚠️ 必须校验形状：解析出 {} / null 时不拦，后面 dsConversations.find 会抛错并中断整个 dsInit
                        //（模型下拉、模式切换、下拉菜单全部不初始化）。
                        if (Array.isArray(parsed)) {
                            dsConversations = parsed.filter(function (c) { return c && typeof c === 'object' && !Array.isArray(c); });
                        } else {
                            console.error('[doubao] 对话历史不是数组，按损坏处理');
                            _corrupt = true;
                        }
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
                } catch(e) {
                    console.error('[doubao] 对话历史解析失败:', e && e.message);
                    _corrupt = true;
                }
                if (_corrupt) {
                    // 关键：**不清空存储、不覆盖**。原先此处把内存置空，紧接着 dsInit 的 dsSaveConversations()
                    // 会把空数组写回同一键 —— 一次解析异常就让全部对话历史不可恢复地消失。
                    // 现在进入保护态：备份原文 + 本次会话拒绝覆写，用户仍有机会人工恢复。
                    dsConversations = [];
                    _dsConvLoadFailed = true;
                    try {
                        const raw = localStorage.getItem(DS_CONVERSATIONS_STORAGE);
                        if (raw) localStorage.setItem(DS_CONVERSATIONS_STORAGE + '_corrupt_backup', raw);
                    } catch (e2) {}
                    if (window.Toast && window.Toast.error) {
                        window.Toast.error('对话历史读取失败：已保留原始数据并暂停自动保存（避免覆盖），请先不要在此状态继续重要对话。');
                    }
                }
            }

            function dsSaveConversations() {
                // 解析失败保护态：拒绝覆写，避免把可恢复的原文洗成空数组
                if (_dsConvLoadFailed) {
                    console.warn('[doubao] 对话历史处于解析失败保护态，本次不写回存储');
                    return;
                }
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
            // ---- 豆包网页版懒加载：仅容器显示时才联网加载 iframe，隐藏时卸回 about:blank 停止联网 ----
            // 初衷：原 iframe 的 src 硬编码为 doubao.com，浏览器对 display:none 的 iframe 仍会预加载，
            //   导致「平时未切到豆包网页版也在联网」。改为初始 src=about:blank，激活时才注入真实地址。
            window.__DOUBAO_WEB_SRC = 'https://www.doubao.com/chat/';
            window.loadDoubaoWebview = function(container) {
                if (!container) return;
                try {
                    var iframe = container.querySelector('iframe');
                    if (!iframe) return;
                    var realSrc = iframe.getAttribute('data-src') || window.__DOUBAO_WEB_SRC;
                    if (iframe.getAttribute('src') !== realSrc) iframe.src = realSrc;
                    iframe.style.display = '';                       // 由占位态转正式加载时恢复显示
                    var hold = container.querySelector('.ds-webview-hold');
                    if (hold && hold.parentNode) hold.parentNode.removeChild(hold);
                } catch (e) {}
            };
            /**
             * 【2026-09-23 用户反馈"折叠开合时提示网络慢、还在远程加载"】
             * 根因：豆包网页版 iframe 会在**建页/切 Tab/恢复上次子视图**时自动加载 doubao.com，
             *   实测每次重建都会多出一次跨域请求（约 1.5s，弱网更久），把启动拖到 5s 之后
             *   → 启动画面显示"网络较慢，正在加载资源…"。
             * 现在改为**点击才加载**：默认显示占位卡片，用户主动点才注入真实地址；离线/弱网不会再有远程请求。
             */
            window.dsHoldDoubaoWebview = function(container) {
                if (!container) return;
                try {
                    var iframe = container.querySelector('iframe');
                    if (!iframe) return;
                    var cur = iframe.getAttribute('src') || 'about:blank';
                    if (cur && cur !== 'about:blank') return;                  // 已在加载或已加载，别打扰
                    if (container.querySelector('.ds-webview-hold')) return;   // 占位已在
                    var hold = document.createElement('div');
                    hold.className = 'ds-webview-hold';
                    hold.style.cssText = 'display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;'
                        + 'padding:30px 16px;text-align:center;color:var(--text-secondary);font-size:.86rem;height:82vh;';
                    hold.innerHTML = '<div style="font-size:1.7rem">🌐</div>'
                        + '<div style="font-weight:700;color:var(--text-primary);font-size:1rem">豆包网页版（需要联网）</div>'
                        + '<div style="max-width:34em;line-height:1.8">为避免折叠屏开合、刷新、重建时出现远程加载拖慢启动，这里不再自动加载。</div>'
                        + '<button class="btn-primary" style="padding:8px 18px;border-radius:8px;cursor:pointer;font-size:.9rem">点击加载豆包网页版</button>'
                        + '<div style="font-size:.78rem;opacity:.85">离线或弱网时，建议直接用本地「智能对话」——数据都在本机，无需联网。</div>';
                    var btn = hold.querySelector('button');
                    if (btn) btn.onclick = function () {
                        try { if (hold.parentNode) hold.parentNode.removeChild(hold); } catch (e) {}
                        try { window.loadDoubaoWebview(container); } catch (e) {}
                    };
                    iframe.style.display = 'none';
                    iframe.parentNode ? iframe.parentNode.insertBefore(hold, iframe) : container.appendChild(hold);
                } catch (e) {}
            };
            window.unloadDoubaoWebview = function(container) {
                if (!container) return;
                try {
                    var iframe = container.querySelector('iframe');
                    if (iframe && iframe.getAttribute('src') !== 'about:blank') iframe.src = 'about:blank';
                } catch (e) {}
            };

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
                // 切走豆包网页版子视图时卸载 iframe（停止联网）
                if (typeof window.unloadDoubaoWebview === 'function') window.unloadDoubaoWebview(panels.doubao);
                // 防智能体运行锁死（通过 window 函数跨 IIFE 通信）
                if (_dsCurrentSub === 'agent' && tab !== 'agent' && typeof window.clearAgentRunning === 'function') {
                    window.clearAgentRunning();
                }
                if (tab === 'agent' && typeof window.clearAgentRunning === 'function') {
                    window.clearAgentRunning();
                }
                var panel = panels[tab];
                if (panel) panel.style.display = 'flex';
                // 切到豆包网页版子视图时懒加载 iframe（联网）
                // 【2026-09-23】切到豆包网页版**不再自动联网加载**：先给占位卡片，用户点了才加载
                //   （折叠屏开合/重建会走这条路，自动加载 doubao.com 会把启动拖到 5s 之后）
                if (tab === 'doubao' && typeof window.dsHoldDoubaoWebview === 'function') window.dsHoldDoubaoWebview(panel);
                _dsCurrentSub = tab;
                if (tab === 'writer' && typeof wrInit === 'function') wrInit();
                // 用户切到风险研判子视图时才刷新数据预览（启动路径不碰全库遍历）
                // 注意：updateRiskPreview 定义在本文件第二个 IIFE 内，闭包取不到，必须走 window
                if (tab === 'risk' && typeof window.updateRiskPreview === 'function') {
                  try { window.updateRiskPreview(); } catch (e) {}
                }
                var sel = document.getElementById('ds-sub-select');
                if (sel) sel.value = tab;
                if (typeof updateModeStatus === 'function') updateModeStatus();
                // v3.31：把当前子视图持久化到 localStorage —— 折叠/刷新后即使整页快照
                //   降级（panelHTML 超限等）无法还原 DOM，dsInit 也能据此恢复子视图。
                try { localStorage.setItem('ds_sub_view', tab); } catch (e) {}
            };
            // v3.29：折叠/刷新整页还原后，子视图 DOM（display:flex 的内联样式随 innerHTML 快照保留）
            //   已还原为折叠前的视图，但 _dsCurrentSub 仍是 dsInit 时设置的初始值 'chat'，
            //   且下拉框 value（property，不进 innerHTML）被重置。从 DOM 推断当前显示的子视图，
            //   同步闭包变量 + 下拉框 + 模式标签，避免「界面是风险研判、标签却显示智能对话」的错乱。
            window.dsSyncSubFromDOM = function() {
                var ids = { check: 'ds-sub-check', chat: 'ds-sub-chat', writer: 'ds-sub-writer', risk: 'ds-sub-risk', agent: 'ds-sub-agent', doubao: 'ds-sub-doubao' };
                var found = null;
                Object.keys(ids).forEach(function (k) {
                    var el = document.getElementById(ids[k]);
                    if (el && getComputedStyle(el).display !== 'none') found = k;
                });
                if (!found) return;
                _dsCurrentSub = found;
                var sel = document.getElementById('ds-sub-select');
                if (sel) sel.value = found;
                if (typeof updateModeStatus === 'function') updateModeStatus();
            };
            // 整页还原完成后同步（page-state 派发，与草稿回填同帧）
            window.addEventListener('pageSnapshotRestored', function () {
                if (typeof window.dsSyncSubFromDOM === 'function') {
                    try { window.dsSyncSubFromDOM(); } catch (e) { console.warn('[doubao] 子视图同步失败', e); }
                }
                // 还原后若豆包网页版是当前视图：**只显示占位卡片**，不自动联网
                //   （这条路径正是折叠开合/重建时被走的，自动加载 doubao.com 是"远程加载"的来源）
                try {
                    if (_dsCurrentSub === 'doubao' && typeof window.dsHoldDoubaoWebview === 'function') {
                        window.dsHoldDoubaoWebview(document.getElementById('ds-sub-doubao'));
                    }
                } catch (e) {}
            });
            function updateModeStatus() {
                // 模型名简称（手机端显示，避免占位过宽）：去掉 deepseek- 前缀并映射常见变体
                function dsShortModel(n) {
                    if (!n) return n;
                    var s = String(n).replace(/^deepseek-v4-/, '').replace(/^deepseek-/, '');
                    // V4.1 Flash 为当前主力模型（原生多模态），简称统一显示 v4.1-flash；
                    // 旧名 flash-vision-exp / v4-flash-vision-exp 亦已被官方路由到 V4.1 Flash，一并归并。
                    var map = { 'flash': 'v4.1-flash', 'chat': 'chat', 'reasoner': '推理', 'v4-flash': 'v4.1-flash', 'v4-flash-vision-exp': 'v4.1-flash', 'flash-vision-exp': 'v4.1-flash' };
                    return map[s] || (s.length > 10 ? s.slice(0, 9) + '…' : s);
                }
                var sub = _dsCurrentSub || 'chat';
                var labelMap = { chat: '💬 智能对话', check: '⚖️ 智能对规', writer: '✍️ 智能写作', agent: '🧠 智能体', risk: '📊 风险研判', doubao: '🤖 豆包网页版' };
                var modeLabel = document.getElementById('ds-current-mode-label');
                if (modeLabel) modeLabel.textContent = labelMap[sub] || '智能对话';
                var roleSelect = document.getElementById('expertRole');
                var role = roleSelect ? roleSelect.value : 'default';
                var roleMap = { auto:'🤖 自动', default:'通用', dianwu:'⚡ 电务', gongwu:'🛤️ 工务', gongdian:'🔌 供电', keyun:'🚌 客运', chewu:'🚂 车务', jiwu:'🚄 机务', cheliang:'🚃 车辆', tongxin:'📡 通信', fangjian:'🏗️ 房建', huoyun:'📦 货运', tongyong:'🛡️ 综合', frontend:'💻 前端', riskanalyst:'🔍 风险分析' };
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
                    // 手机端模型名过长占位太宽 → 显示简称（全称存 title 供悬停查看）
                    var _isNarrow = window.innerWidth <= 768;
                    modelLabel.textContent = _isNarrow ? dsShortModel(mName) : (mName || '未配置模型');
                    modelLabel.title = mName || '未配置模型';
                    modelLabel.style.maxWidth = _isNarrow ? '92px' : '';
                    modelLabel.style.overflow = 'hidden';
                    modelLabel.style.textOverflow = 'ellipsis';
                    modelLabel.style.whiteSpace = 'nowrap';
                }
            }
            // 暴露给全局，使 index.html initPage 的首屏角色/模式状态刷新生效（此前因未挂 window 而成为死调用）
            window.updateModeStatus = updateModeStatus;
            // 视口变化（手机/桌面切换）时刷新模型名简称显示
            if (!window._dsModeStatusResizeBound) {
                window._dsModeStatusResizeBound = true;
                window.addEventListener('resize', function () { if (window.updateModeStatus) window.updateModeStatus(); });
            }

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
                    // 【v3.24-fix】ds-rebuild 也改为动态监听：整页还原后旧 sel 上的监听随旧节点失效，
                    //   改挂 document 并按目标 id 过滤，还原后模型配置变化时菜单仍能重建。
                    document.addEventListener('ds-rebuild', function(e) {
                        if (!e.target || e.target.id !== selId) return;
                        var _sel = document.getElementById(selId);
                        var _menu = document.getElementById(menuId);
                        if (!_sel || !_menu) return;
                        _menu.innerHTML = Array.prototype.slice.call(_sel.options).map(function(o) {
                            return '<div class="ds-dropdown-item' + (o.selected ? ' active' : '') + '" data-val="' + dsEsc(o.value) + '">' + dsEsc(o.text) + '</div>';
                        }).join('');
                    });
                    // 【v3.23-fix】事件委托：绑定挂到静态父容器 #panel-doubao（它自身不会被
                    //   page-state.js 的 p.innerHTML 还原替换，仅子节点被替换），从而折叠屏/
                    //   刷新经整页 DOM 还原后委托依然有效。v3.22 误挂 #ds-sub-chat（会被替换）。
                    var _ddRoot = document.getElementById('panel-doubao') || document;
                    _ddRoot.addEventListener('click', function(e) {
                        var t = e.target;
                        if (!t || !t.closest) return;
                        // 【v3.24-fix】每次点击动态查询节点：v3.23 委托虽挂在 #panel-doubao 上
                        //   永久有效，但回调闭包仍持有还原前的旧 menu/sel 引用（幽灵节点，已脱离
                        //   文档），classList/contains 操作无效果——必须动态查询最新节点。
                        var menu = document.getElementById(menuId);
                        var sel = document.getElementById(selId);
                        if (!menu || !sel) return;
                        // 点击角色/模型按钮：toggle 对应菜单（v3.25 互斥：点开一个关闭其它所有弹出）
                        if (t.closest('#' + btnId)) {
                            e.stopPropagation();
                            var willOpen = !menu.classList.contains('open');
                            if (typeof window.dsCloseAllChatPopups === 'function') window.dsCloseAllChatPopups(menu);
                            menu.classList.toggle('open', willOpen);
                            return;
                        }
                        // 点击菜单项：选中并应用
                        if (menu.contains(t)) {
                            var item = t.closest('.ds-dropdown-item');
                            if (!item) return;
                            e.stopPropagation();
                            var val = item.getAttribute('data-val');
                            if (sel.value !== val) {
                                sel.value = val;
                                var ev = document.createEvent('HTMLEvents');
                                ev.initEvent('change', true, true);
                                sel.dispatchEvent(ev);
                                // 【修复】切换角色：旧角色问答已污染对话上下文，若当前对话有内容则开新对话
                                //   （旧对话保留在侧栏），确保切换后「介绍一下你自己」等按新角色从零答题，
                                //   而非复述旧角色历史（表现为「秒回答且答案未变」）。
                                if (typeof window.dsNewChat === 'function' && dsHistory.length > 0) window.dsNewChat(true);
                            }
                            Array.prototype.forEach.call(menu.children, function(c){ c.classList.toggle('active', c === item); });
                            menu.classList.remove('open');
                            if (typeof updateModeStatus === 'function') updateModeStatus();
                        }
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

                // 豆包网页版：未配置 API 时显示（**占位卡片，点击才联网加载**）；已配置则隐藏并卸载（停止联网）
                if (webview) {
                    webview.style.display = hasApiKey ? 'none' : 'flex';
                    if (typeof window.unloadDoubaoWebview === 'function') {
                        if (hasApiKey) window.unloadDoubaoWebview(webview);
                        else if (typeof window.dsHoldDoubaoWebview === 'function') window.dsHoldDoubaoWebview(webview);
                    }
                }
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
                html += '<div><label style="font-weight:600;display:block;margin-bottom:4px;">模型名称</label><input id="ds-pe-model" list="api-model-list" style="width:100%;padding:8px 10px;border:1px solid var(--border);border-radius:6px;font-size:0.88rem;" placeholder="deepseek-flash"></div>';
                html += '<div><label style="font-weight:600;display:block;margin-bottom:4px;">API Key</label><input id="ds-pe-key" type="password" style="width:100%;padding:8px 10px;border:1px solid var(--border);border-radius:6px;font-size:0.88rem;" placeholder="sk-..."></div>';
                // 联网搜索（Web Search）开关：经 DeepSeek Anthropic 兼容层的服务端检索（web_search_20250305）
                html += '<label style="display:flex;align-items:center;gap:8px;font-size:0.82rem;cursor:pointer;user-select:none;margin-top:4px;color:var(--text-secondary);"><input type="checkbox" id="ds-pe-websearch"' + (localStorage.getItem('ds_web_search') === '1' ? ' checked' : '') + '> 🌐 联网搜索 (Web Search) — 经 Anthropic 联网通道（deepseek-flash 服务端检索）</label>';
                // 【多模态模型快捷预设】一键填好名称/URL/模型名，免手敲
                // V4.1 Flash 已原生支持多模态（图文通用），不再需要单独的「视觉模型」配置
                html += '<div style="display:flex;gap:8px;margin-top:6px;flex-wrap:wrap;"><button type="button" class="ds-vision-btn" onclick="dsFillVisionModel()" style="padding:5px 10px;border:1px solid #c7d2fe;background:#eef2ff;color:#4338ca;border-radius:8px;font-size:0.78rem;cursor:pointer;">📷 一键填入 DeepSeek V4.1 Flash</button><span style="font-size:0.72rem;color:#94a3b8;align-self:center;">deepseek-flash · 原生多模态，看图/识别照片与文字对话同一模型</span></div>';
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
            // 【多模态模型快捷预设】一键填入 DeepSeek V4.1 Flash 配置
            // V4.1 Flash 原生支持多模态：看图与文字对话用同一个模型，无需再单独配置「视觉模型」。
            window.dsFillVisionModel = function() {
                var f = document.getElementById('ds-provider-edit');
                if (!f) return;
                f.style.display = 'block';
                if (document.getElementById('ds-pe-name')) document.getElementById('ds-pe-name').value = 'DeepSeek V4.1 Flash';
                if (document.getElementById('ds-pe-url')) document.getElementById('ds-pe-url').value = 'https://api.deepseek.com/chat/completions';
                if (document.getElementById('ds-pe-model')) document.getElementById('ds-pe-model').value = 'deepseek-flash';
                if (document.getElementById('ds-provider-edit-title')) document.getElementById('ds-provider-edit-title').textContent = '新增多模态模型';
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
            // 模型配置发生变化后，重新判定「豆包网页版 / 本地智能模块」该显示哪一个。
            // 原实现只在页面初始化时判定一次，导致首次填入 API Key 点「保存模型」后
            // 界面仍停在豆包网页版 iframe、智能对话仍是隐藏的，看起来「什么都没发生」，
            // 必须手动刷新页面才生效。
            function _syncModeAfterProviderChange() {
                try { if (typeof toggleDoubaoMode === 'function') toggleDoubaoMode(); } catch (e) {}
            }

            function dsSaveProviderFromForm() {
                var f = document.getElementById('ds-provider-edit');
                var name = document.getElementById('ds-pe-name').value.trim();
                var url = document.getElementById('ds-pe-url').value.trim();
                var model = document.getElementById('ds-pe-model').value.trim();
                var key = document.getElementById('ds-pe-key').value.trim();
                if (!url) { alert('请输入 API 地址'); return; }
                // 地址归一化 + 明示：缺 https:// 的地址会被 fetch 当相对路径解析（请求打到本站 → 404），
                // 缺 /chat/completions 路径的已知供应商地址同样 404。这里补全并即时告知，不静默改写。
                var _fixedUrl = window.dsNormalizeApiUrl ? window.dsNormalizeApiUrl(url) : url;
                if (_fixedUrl && _fixedUrl !== url) {
                    console.warn('[doubao] API 地址已自动补全：' + url + ' → ' + _fixedUrl);
                    if (typeof Toast !== 'undefined' && Toast.success) Toast.success('API 地址已补全为：' + _fixedUrl);
                    url = _fixedUrl;
                }
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
                // ⚠️ 必须先读复选框、再保存：addOrUpdateProvider 内部会 renderModelManager() 重建整个表单，
                // 新节点的 checked 来自「保存前」的 localStorage 值；若在其后再读，读到的是旧状态的替身，
                // 结果是"在表单里改「联网搜索」开关、点保存永远不生效"。
                var _wsChk = document.getElementById('ds-pe-websearch');
                addOrUpdateProvider({ id: pid || undefined, name: name, apiUrl: url, model: model, apiKey: key });
                // 持久化联网搜索开关（全局行为，与具体模型配置无关）；元素不存在时保留原值，避免误重置为 0
                if (_wsChk) localStorage.setItem('ds_web_search', _wsChk.checked ? '1' : '0');
                // 同步输入栏地球按钮高亮（两处 UI 共用同一开关）
                try { if (typeof window.dsSyncWebSearchBtn === 'function') window.dsSyncWebSearchBtn(); } catch (e) {}
                if (f) { f.style.display = 'none'; f.dataset.pid = ''; }
                renderModelManager();
                _syncModeAfterProviderChange();
            }
            // 原实现只调 setActiveProvider，而后者不会重绘模型管理列表，
            // 表现为点「设为当前」后该条目的「●当前」标记与「设为当前」按钮纹丝不动，
            // 用户以为没点上而反复点击。
            function dsSetActiveProvider(id) {
                setActiveProvider(id);
                if (typeof renderModelManager === 'function') renderModelManager();
                _syncModeAfterProviderChange();
            }
            function dsDeleteProvider(id) {
                if (!confirm('确定删除该模型配置？')) return;
                deleteProvider(id);
                if (typeof renderModelManager === 'function') renderModelManager();
                _syncModeAfterProviderChange();
            }

            function showApiConfigModal() {
                renderModelManager();
                document.getElementById('api-config-modal').style.display = 'block';
            }

            // API 地址变更时自动建议模型名称
            // 注：旧版单输入框 #modal-apiurl / #modal-model 已随「多模型管理」改版从 HTML 中移除，
            // 函数目前无调用点，仅通过 window.dsAutoDetectModel 对外保留兼容。
            // 必须做空值保护，否则任何调用都会直接抛 TypeError。
            function _autoDetectModel() {
                var urlEl = document.getElementById('modal-apiurl');
                var modelInput = document.getElementById('modal-model');
                if (!urlEl || !modelInput) return;
                var url = (urlEl.value || '').trim();
                // 只有用户清空了或还是默认值时才自动填写
                if (modelInput.value && modelInput.value !== DS_DEFAULT_MODEL && modelInput.value !== 'glm-4' && modelInput.value !== 'qwen-turbo' && modelInput.value !== 'gpt-3.5-turbo') return;
                var models = {
                    'bigmodel.cn': 'glm-4',
                    'aliyuncs.com': 'qwen-turbo',
                    'deepseek.com': 'deepseek-flash',
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
                // 清除 Key 后必须回落到豆包网页版，否则本地模块还开着但已无法调用
                _syncModeAfterProviderChange();
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
            // 【v3.76】数据源默认值的**唯一**定义。此前 loadDsCfg()、_dsRunStream()、dsBuildSystemPrompt()
            //   各写一份，且 remember 默认值不一致（面板默认 true、会话兜底默认 false）—— 三处漂移的典型隐患。
            // 【v4.19 用户口径：关联数据类型与资料中心不一致】把原来的"隐含关系"拆成独立项后，默认值保持与老行为等价：
            //   老默认 rules=true ⇒ cases（法规/案例汇编）跟着 rules；handbook/wrAll 默认 false ⇒ 对应新项也 false。
            //   ⚠️ 老配置（localStorage 的 ds_datasource_v1 里没有新字段）由 loadDsCfg 按同样关系回填勾选状态，
            //      保证"界面上看到的"与"实际注入的"一致（不再出现看着没勾、其实带上了的静默不一致）。
            var DS_DEFAULT_CFG = {
                // 【v4.20 用户需求】auto=自动关联：按问题内容自动挑选数据源（逐项勾选变灰，交给系统）。
                //   默认**开**：用户要的就是"感觉更好"的自动模式，且有三重兜底 ——
                //    ① 问题没命中任何意图 ⇒ 全部源都用（绝不少给资料）；
                //    ② 面板明确显示**本次实际选了哪些源**（不是黑箱）；
                //    ③ 随时可关闭，关闭后回到逐项手选（行为与 v4.19 完全一致）。
                auto: true,
                rules: true, cases: true, issue: true, handbook: false, accidents: false,
                materials: false, reports: false, phone: false, diary: false, remember: true,
                wrAll: false   // 兼容字段：老代码/旧备份读取用；保存时由 getDsCfg 同步为 materials 的值
            };

            /* ==================== 【v4.20】「自动关联」按问题挑源 ====================
             * 思路与智能体的"工具按意图召回"一致：先按问题里的业务词判断意图，只挂相关源。
             * ⚠️ 不劣化红线（与工具召回同一口径）：
             *   · 命中意图 ⇒ 「核心源（规章制度 + 检查台账）+ 命中组」的并集；
             *   · **未命中任何意图 / 空问题 ⇒ 返回 null ⇒ 调用方全开**（绝不因自动挑选而少给资料）；
             *   · 结果写入 `window.__dsAutoPicked`，并显示在面板的「自动关联」提示行上（可见、可核对）。
             * 词表按**真实安监问法**写（"消防安全检查如何规定"这类不带"规章"二字的也要能命中）。
             * ===================================================================== */
            var _DS_AUTO_CORE = ['rules', 'issues'];
            var _DS_AUTO_RULES = [
                { re: /规章|制度|办法|规程|规范|标准|依据|条款|规定|要求|细则|文件|汇编|怎么规定|如何规定/, srcs: ['rules', 'cases'] },
                { re: /检查|问题|隐患|违章|台账|记录|整改|多少|几条|几次|统计|频次|高发|典型问题/, srcs: ['issues'] },
                { re: /手册|项点|作业标准|作业指导|检查项|指导/, srcs: ['handbook'] },
                { re: /事故|案例|教训|险性|伤亡/, srcs: ['accidents'] },
                { re: /电话|联系|值班|调度|号码/, srcs: ['phone'] },
                { re: /日志|记入|我今天|今天干|工作记录|写日志/, srcs: ['diary'] },
                { re: /报告|汇报|总结|月报|周报|通报|写作|材料|模板|撰写|起草/, srcs: ['materials', 'reports'] }
            ];
            /** 按问题挑源；返回源数组，**返回 null 表示"应使用全部源"**（未命中/空问题） */
            function _dsAutoPickSources(q) {
                try {
                    var t = String(q || '').trim();
                    if (!t) return null;
                    var picked = _DS_AUTO_CORE.slice(), hit = 0;
                    _DS_AUTO_RULES.forEach(function (g) {
                        if (!g.re.test(t)) return;
                        hit++;
                        g.srcs.forEach(function (s) { if (picked.indexOf(s) === -1) picked.push(s); });
                    });
                    if (!hit) { try { window.__dsAutoPicked = null; } catch (e) {} return null; }   // 未命中 ⇒ 全开兜底
                    try {
                        window.__dsAutoPicked = picked.slice();
                        window.__dsAutoPickInfo = { query: t.slice(0, 40), hitGroups: hit, picked: picked.length };
                    } catch (e) {}
                    return picked;
                } catch (e) { return null; }
            }
            /** 源 key → 面板上的中文名（提示行展示用） */
            var _DS_SRC_LABEL = { rules: '规章制度', cases: '法规/案例汇编', issues: '检查台账', handbook: '检查手册', accidents: '事故案例', materials: '写作资料库', reports: '历史报告', phone: '应急电话', diary: '工作日志' };
            /** 更新面板上的「自动关联」提示行（auto 开时显示当前问题会选什么；关时说明已交给手选） */
            function _dsUpdateAutoHint(q, autoOn) {
                var el = document.getElementById('ds-auto-hint');
                if (!el) return;
                if (!autoOn) { el.textContent = '🔮 自动关联：已关闭（手动勾选上方各项）'; return; }
                var picked = _dsAutoPickSources(q);
                if (!picked) { el.textContent = '🔮 自动关联：未识别到特定意图 → 本次使用全部数据源'; return; }
                el.textContent = '🔮 自动关联：本次将使用 ' + picked.map(function (k) { return _DS_SRC_LABEL[k] || k; }).join(' · ');
            }
            // 诊断入口（与智能体的 __agentPickTools 对称）：控制台执行 `__dsAutoPick('一句话')` 可预演自动关联结果；
            // `__dsAutoPicked` 是**最近一次实际**用到的源列表，便于核对"自动到底选了啥"。
            try { window.__dsAutoPick = _dsAutoPickSources; window.__dsSrcLabel = _DS_SRC_LABEL; } catch (e) {}
            (function initDataSourceDropdown() {
                var btn = document.getElementById('ds-datasource-btn');
                var menu = document.getElementById('ds-datasource-menu');
                if (!btn || !menu) return;

                // 【v4.19】面板项清单（DOM id；顺序与 index.html 一致）与"DOM id → 持久化字段"映射表。
                //   注意 DOM 用连字符、字段用驼峰，必须显式映射：`def['wr-all']` 恒为 undefined 是历史 bug（已修勿改回）。
                var _DS_CFG_KEYS = ['rules','cases','issue','handbook','accidents','wr-all','reports','phone','diary'];
                var _DS_CFG_KEYMAP = { 'wr-all': 'materials' };   // 面板「写作资料库」对应 KB 的 materials 源
                function getDsCfg() {
                    var cfg = {
                        auto: document.getElementById('ds-dialog-auto').checked,
                        rules: document.getElementById('ds-dialog-rules').checked,
                        cases: document.getElementById('ds-dialog-cases').checked,
                        issue: document.getElementById('ds-dialog-issue').checked,
                        handbook: document.getElementById('ds-dialog-handbook').checked,
                        accidents: document.getElementById('ds-dialog-accidents').checked,
                        materials: document.getElementById('ds-dialog-wr-all').checked,
                        reports: document.getElementById('ds-dialog-reports').checked,
                        phone: document.getElementById('ds-dialog-phone').checked,
                        diary: document.getElementById('ds-dialog-diary').checked,
                        remember: document.getElementById('ds-dialog-remember').checked
                    };
                    // 兼容字段：老代码/旧备份读的是 wrAll（当年"写作资料库"同时含 materials+reports）
                    cfg.wrAll = cfg.materials;
                    return cfg;
                }
                function syncAllBox() {
                    var all = document.getElementById('ds-dialog-all');
                    if (all) all.checked = _DS_CFG_KEYS.every(function(k){
                        var el = document.getElementById('ds-dialog-' + k); return el && el.checked;
                    });
                }
                /** 【v4.20】自动关联开关的联动：开 ⇒ 逐项（含全选）变灰不可点，提示行说明本次会选什么；关 ⇒ 恢复手选 */
                function _dsApplyAutoMode(autoOn, q) {
                    _DS_CFG_KEYS.forEach(function (k) {
                        var el = document.getElementById('ds-dialog-' + k);
                        if (!el) return;
                        el.disabled = !!autoOn;
                        var row = el.closest ? el.closest('.ds-datasource-row') : null;
                        if (row) { row.style.opacity = autoOn ? '0.45' : ''; row.style.cursor = autoOn ? 'not-allowed' : ''; }
                    });
                    var allEl = document.getElementById('ds-dialog-all');
                    if (allEl) {
                        allEl.disabled = !!autoOn;
                        var allRow = allEl.closest ? allEl.closest('.ds-datasource-row') : null;
                        if (allRow) allRow.style.opacity = autoOn ? '0.45' : '';
                    }
                    _dsUpdateAutoHint(q, autoOn);
                }
                function loadDsCfg() {
                    var def = _sessionDataSource || DS_DEFAULT_CFG;
                    // 【v3.76】确认按钮文案随场景：输入框有内容 → 点它会「应用并发送」，如实标注，避免"只想保存却被发出去"的误解
                    var _cf = document.querySelector('.ds-ds-btn--confirm');
                    var _iv = (document.getElementById('ds-user-input') || {}).value || '';
                    if (_cf) _cf.textContent = _iv.trim() ? '应用并发送' : '应用';
                    // 【v4.19 迁移】老配置里没有 cases/accidents/materials/reports 四个字段，它们原来是**隐含**的：
                    //   勾「规章制度」⇒ 附带法规/案例汇编；勾「检查手册」⇒ 附带事故案例；勾「写作资料库」⇒ 附带历史报告。
                    //   这里按同样的隐含关系回填勾选状态 ⇒ 老用户在面板上看到的就是实际会注入的内容（不再静默不一致）。
                    var def2 = Object.assign({}, def || {});
                    if (def2.cases === undefined) def2.cases = !!def2.rules;
                    if (def2.accidents === undefined) def2.accidents = !!def2.handbook;
                    if (def2.materials === undefined) def2.materials = !!def2.wrAll;   // 老字段名是 wrAll
                    if (def2.reports === undefined) def2.reports = !!def2.wrAll;
                    _DS_CFG_KEYS.concat(['remember']).forEach(function(k){
                        var el = document.getElementById('ds-dialog-' + k);
                        if (el) el.checked = !!(def2[_DS_CFG_KEYMAP[k] || k]);
                    });
                    // 【v4.20】自动关联：实现里 auto 缺省视为**开**（与 DS_DEFAULT_CFG 一致）⇒ 老设备升级后即进入自动模式，
                    //   逐项勾选变灰、由提示行说明本次会选什么；用户取消勾选即回到手选（行为与 v4.19 完全一致）。
                    var autoOn = (def2.auto !== false);
                    var autoEl = document.getElementById('ds-dialog-auto');
                    if (autoEl) {
                        autoEl.checked = autoOn;
                        // ⚠️ 用 onchange=（覆盖式）而不是 addEventListener：面板 DOM 会被折叠屏/整页 DOM 还原重建，
                        //    addEventListener 会重复叠加（点一次跳多次），覆盖式赋值天然幂等。
                        autoEl.onchange = function () {
                            var _iv2 = (document.getElementById('ds-user-input') || {}).value || '';
                            _dsApplyAutoMode(!!autoEl.checked, _iv2);
                        };
                    }
                    _dsApplyAutoMode(autoOn, _iv);
                    syncAllBox();
                }

                // 【v3.23-fix】事件委托：绑定挂到静态父容器 #panel-doubao（它自身不会被
                //   page-state.js 的 p.innerHTML 还原替换，仅子节点被替换），从而折叠屏/
                //   刷新经整页 DOM 还原后委托依然有效。v3.22 误挂 #ds-sub-chat（会被替换）。
                var _dsRoot = document.getElementById('panel-doubao') || document;
                _dsRoot.addEventListener('click', function(e) {
                    var t = e.target;
                    if (!t || !t.closest) return;
                    // 【v3.24-fix】每次点击动态查询菜单节点：v3.23 委托虽挂在 #panel-doubao 上
                    //   永久有效，但闭包 menu 仍指向还原前的旧节点（幽灵节点），classList 操作
                    //   无效果——必须动态查询最新节点。
                    var menu = document.getElementById('ds-datasource-menu');
                    if (!menu) return;
                    // 点击关联数据按钮：toggle 菜单（v3.25 互斥：点开一个关闭其它所有弹出）
                    if (t.closest('#ds-datasource-btn')) {
                        e.stopPropagation();
                        var willOpen = !menu.classList.contains('open');
                        if (typeof window.dsCloseAllChatPopups === 'function') window.dsCloseAllChatPopups(menu);
                        if (willOpen) loadDsCfg();
                        menu.classList.toggle('open', willOpen);
                        return;
                    }
                    if (!menu.contains(t)) return;
                    // 取消：仅收起
                    if (t.closest('.ds-ds-btn--cancel')) {
                        e.stopPropagation(); menu.classList.remove('open'); return;
                    }
                    // 应用：保存选择 + 若输入框有内容则立即按新数据源发送（按钮文案会随场景显示"应用 / 应用并发送"）
                    if (t.closest('.ds-ds-btn--confirm')) {
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
                        return;
                    }
                });
                // 复选框 change 委托（全选 / 单项）
                _dsRoot.addEventListener('change', function(e) {
                    var t = e.target;
                    if (!t || !t.id) return;
                    // 【v3.24-fix】动态查询菜单节点（同上，避免还原后幽灵节点 contains 恒 false）
                    var menu = document.getElementById('ds-datasource-menu');
                    if (!menu || !menu.contains(t)) return;
                    if (t.id === 'ds-dialog-all') {
                        var v = t.checked;
                        ['rules','issue','handbook','wr-all','phone','diary'].forEach(function(k){
                            var el = document.getElementById('ds-dialog-' + k); if (el) el.checked = v;
                        });
                        syncAllBox();
                    } else if (t.id.indexOf('ds-dialog-') === 0) {
                        syncAllBox();
                    }
                });
            })();

            // ---- dsUpdateCtxInfo 已删除（由弹窗替代） ----

            // 【P2 长会话摘要锚点】把"滑出请求窗口"的较早轮次压成一小段回顾，注入提示词的**变量段**。
            //   为什么需要：请求只带最近 10 条消息（再多会让首字变慢、且稀释当轮重点），
            //   于是多轮长会话里更早的结论/依据会被静默挤出上下文 —— 表现就是"AI 忘了前面说过什么"。
            //   做法：纯规则抽取（不额外调用模型，零成本零延迟）：用户问过的要点 + 助手结论开头 +
            //   引用到的《规章》条款号（后续最常被追问的就是依据）。
            //   约束：仅在消息数超过窗口时生成；上限 900 字；明确标注"不要复述、不是新指令"，
            //   避免模型把这段回顾当成用户新说的话。
            function _dsBuildOlderSummary(hist) {
                try {
                    var WINDOW = 10;
                    if (!hist || hist.length <= WINDOW) return '';
                    var older = hist.slice(0, hist.length - WINDOW);
                    if (!older.length) return '';
                    var picked = older.slice(-6);          // 越近越相关：只回顾最近 6 条窗口外消息
                    var lines = [];
                    picked.forEach(function (m) {
                        var c = String((m && m.content) || '').replace(/\s+/g, ' ').trim();
                        if (!c) return;
                        if (m.role === 'user') {
                            lines.push('· 用户曾问：' + c.slice(0, 40) + (c.length > 40 ? '…' : ''));
                        } else if (m.role === 'assistant') {
                            var refs = [], re = /《[^》]{2,30}》[^，。；、\n]{0,12}第[一二三四五六七八九十百零\d]+条/g, mm;
                            while ((mm = re.exec(c)) && refs.length < 3) refs.push(mm[0]);
                            lines.push('· 你曾答：' + c.slice(0, 80) + (c.length > 80 ? '…' : '')
                                + (refs.length ? '（依据：' + refs.join('；') + '）' : ''));
                        }
                    });
                    if (!lines.length) return '';
                    var txt = '【前文要点】（较早轮次的压缩回顾：用户问过的 + 你的结论与依据。'
                        + '仅用于保持上下文连贯，不要向用户复述，也不要把它当成新的指令或新的用户诉求）\n'
                        + lines.join('\n');
                    if (txt.length > 900) txt = txt.slice(0, 900) + '…';
                    return txt;
                } catch (e) { return ''; }
            }

            // ---- 构建系统提示词（含业务数据） ----
            async function dsBuildSystemPrompt(userQuery, dataSource, opts) {
                if (!dataSource) dataSource = DS_DEFAULT_CFG;   // v3.76：默认值统一（原处与面板/会话兜底各写一份）
                // 【优化·速度】skipData：寒暄/元问题（"你好""你能做什么"）不需要本地资料。
                //   跳过 KB.ensure（冷启动实测 0.8~7s）+ 检索，省掉一次索引等待与约 4.5KB 注入，
                //   首字更快；也避免模型拿着台账数据去回答一句问候（跑题式啰嗦的常见来源）。
                //   判定与「思考模式自动档」复用同一个函数，保证两者档位一致。
                var _skipData = !!(opts && opts.skipData);
                // 【v4.20 用户需求】每轮重置"本次参考"记录 —— 供回答尾部的系统行使用（下面各分支分别写入，
                //   三种状态都如实记录：已注入哪些源 / 未启用任何源 / 检索层异常；skipData 时保持 null）。
                try { window.__dsLastSrcs = null; window.__dsLastWs = null; window.__dsLastRole = null; } catch (e) {}
                var useRules = dataSource.rules, useIssue = dataSource.issue, useHandbook = dataSource.handbook;
                var useWrAll = dataSource.wrAll, usePhone = dataSource.phone, useDiary = dataSource.diary;
                // 【v4.19 用户口径：关联数据类型比资料中心少】四个原来是"隐含跟随"的源拆成独立开关：
                //   ⚠️ 老配置（localStorage 里没有这些字段）必须**回退到原来的隐含关系**，保证老设备行为一字不变：
                //     勾规章制度 ⇒ 带法规/案例汇编；勾检查手册 ⇒ 带事故案例；勾写作资料库 ⇒ 带历史报告。
                //   新配置（面板"应用"后写入）则四个字段各自独立生效。
                var useCases = (dataSource.cases === undefined) ? !!useRules : !!dataSource.cases;
                var useAccidents = (dataSource.accidents === undefined) ? !!useHandbook : !!dataSource.accidents;
                var useMaterials = (dataSource.materials === undefined) ? !!useWrAll : !!dataSource.materials;
                var useReports = (dataSource.reports === undefined) ? !!useWrAll : !!dataSource.reports;

                let sysParts = [
                    '你是一名铁路安全监察智能助手，专注于铁路安全规章、检查信息的查询与分析。',
                    '回答请使用中文，条理清晰，引用数据时注明来源（如"规章制度：XXX"、"检查信息：XXX"）。',
                    '若业务数据中未找到相关内容，如实告知，不得捏造。',
                    // 【2026-10-06 用户反馈修复】模型曾在回答里说"本地数据库未提供检索工具，只有 web_search" —
                    //   事实是：**本地资料由系统自动检索并注入**（见下方【本地资料】段），模型侧本来就没有
                    //   "检索本地库"的工具，这不是缺陷，也不该被当成"只能联网"的理由。
                    //   这里明确口径：不要声称"没有本地检索工具"；真缺资料就说"本地资料未检索到相关内容"。
                    // 【2026-10-08 修正"自相矛盾"】原文案说"你不需要、也没有'检索本地库'的工具调用能力"，
                    //   但**同一轮却挂着 23 个本地查询工具**（search_issues / count_issues / kb_search …，见 3111 行）
                    //   ⇒ 模型被告知"没有工具"，于是"该调工具精确统计"被改成"凭注入的资料片段猜数字"。
                    //   现改为**与"是否挂了工具"无关的准确措辞**；真正不带工具时，_dsRunStream 会追加
                    //   【能力说明】如实告知（见 3100-3108），两者不再打架。
                    '本地资料由系统自动检索后注入下方【本地资料】段，可直接引用；'
                    + '若本轮同时提供了本地查询工具（tools），需要**精确计数 / 按条件筛选 / 取明细或全文**时请优先调用它们'
                    + '（如 count_issues / search_issues / kb_search）—— 不要凭资料片段估算数字：'
                    + '资料段用于理解背景与口径，工具用于取准数与明细，两者配合使用。'
                    + '不要声称"本地没有检索能力""只能联网"；若【本地资料】未命中且本轮没有可用工具，'
                    + '如实说明"本地资料未检索到相关内容"，并提示用户可用「关联数据」勾选更多数据源。',
                    // 【优化·准确性+废话抑制】检索结果与问题无关是召回常态（关键词/向量召回尤甚）。
                    //   不写死这条，模型倾向"把检索到的东西都用上" → 硬塞条款、复述原文、答非所问。
                    '检索到的资料仅在与问题相关时使用：不相关的直接忽略，不要为"用上资料"而牵强引用或转述原文；确实未检索到相关内容时，一句话说明即可。'
                ];

                // 关键词提取（复用专业词库增强版） + 专业推断
                const kws = smartExtractKeywords(userQuery, 5, false);
                const inferredTrade = window.patchInferTrade ? window.patchInferTrade(userQuery) : null;

                // 【v3.73】本地资料统一走「统一检索层」（knowledge.js）：按自然粒度分块
                // （规章按条、手册按项点、资料按段落、问题库/电话/日志按条），命中块**完整**进上下文
                // 并带出处路径，取代下面各源"各自采样 + 截前 200/300/500 字"的旧逻辑。
                // 开关 kb_prompt：默认开；置 '0' 立即回退旧逻辑（便于对照与应急）。
                var _kbOnP = true;
                try { _kbOnP = localStorage.getItem('kb_prompt') !== '0'; } catch (e) {}
                if (!_skipData && _kbOnP && window.KB && typeof window.KB.search === 'function') {
                    var _kbSrcs = [];
                    // 【v4.20 用户需求：自动关联】开 auto 且问题**命中意图** ⇒ 用按问题挑出的源；
                    //   关掉 auto 或**未命中意图**（含空问题）⇒ 走下面的逐项手选（即 v4.19 的原行为）。
                    //   ⇒ 这样"自动"只在有把握时生效，没把握时退回用户自己的选择，绝不因自动而少给资料。
                    //   实际挑了哪些源可在 `window.__dsAutoPicked` 与面板「自动关联」提示行核对（不做黑箱）。
                    var _autoSrcs = (dataSource.auto !== false) ? _dsAutoPickSources(userQuery) : null;
                    if (_autoSrcs) {
                        _kbSrcs = _autoSrcs.slice();
                    } else {
                    // 【v4.19】逐源独立判断。原来 cases 跟着 rules、accidents 跟着 handbook、reports 跟着 wrAll，
                    //   用户在「关联数据」里**无法单独控制**、界面上也看不出它们会被带上 —— 这正是用户反馈
                    //   "关联数据项点与资料中心数据类型不一致、类型少"的根因。现在 9 个源各有独立开关。
                    if (useRules) _kbSrcs.push('rules');
                    if (useCases) _kbSrcs.push('cases');           // 法规/案例汇编（2026-09-22 从 rules 拆出的独立源）
                    if (useIssue) _kbSrcs.push('issues');
                    if (useHandbook) _kbSrcs.push('handbook');
                    if (useAccidents) _kbSrcs.push('accidents');   // 事故案例（与手册平行的第二份四级目录数据）
                    if (useMaterials) _kbSrcs.push('materials');
                    if (useReports) _kbSrcs.push('reports');
                    if (usePhone) _kbSrcs.push('phone');
                    if (useDiary) _kbSrcs.push('diary');
                    }
                    if (_kbSrcs.length) {
                        try {
                            // 先确保索引就绪：资料库/历史报告需从 IndexedDB 预载；大源（检查信息）分片异步建索引
                            if (typeof window.KB.ensure === 'function') await window.KB.ensure(_kbSrcs);
                            // 【C1/v3.74】按用途分档 topK：写作资料库/历史报告只是"文风/结构参考"，
                            //   实测它们占单轮注入量的 44%（业务源 28099 字 vs 文风源 21912 字），给 2 块足够；
                            //   业务源（规章/检查信息/手册/电话/日志）保持 5。
                            var _kbR = window.KB.search(userQuery, { sources: _kbSrcs, topK: 5, topKByKey: { materials: 2, reports: 2, cases: 2, accidents: 3 } });
                            // 保留旧逻辑的「专业优先」意图：命中块所属规章与推断专业一致时前置
                            if (inferredTrade) {
                                for (var _qi = 0; _qi < _kbR.length; _qi++) {
                                    if (_kbR[_qi].key !== 'rules') continue;
                                    var _prefR = [], _otherR = [];
                                    _kbR[_qi].hits.forEach(function (h) { (h.trade === inferredTrade ? _prefR : _otherR).push(h); });
                                    _kbR[_qi].hits = _prefR.concat(_otherR);
                                }
                            }
                            var _kbTxt = window.KB.buildRefText(_kbR, { totalBudget: DS_KB_TOTAL_BUDGET });
                            sysParts.push(_kbTxt || '【本地资料】本次未检索到相关内容（可能尚未导入资料）。');
                            // 【v4.20】记录本轮**实际注入**的源（含是否走自动关联）⇒ 回答尾部那行"本次参考"取它
                            try { window.__dsLastSrcs = { srcs: _kbSrcs.slice(), auto: !!_autoSrcs }; } catch (e2) {}
                        } catch (e) {
                            // 【2026-10-06 用户反馈修复】原先这里只 `console.warn` ⇒ **手机上根本没有控制台**，
                            //   于是静默回退旧逻辑，用户只看到回答里说"本地没有资料/工具"，完全无从判断原因。
                            //   现在把失败原因**写进 system**（模型会如实转述，用户也看得见）；旧逻辑仍照常兜底。
                            var _kbErr = (e && e.message) || String(e);
                            sysParts.push('【本地资料】本次本地检索层异常，未能使用本地资料（原因：' + _kbErr + '）。'
                                + '请如实告诉用户"本地资料本次不可用（' + _kbErr + '）"，不要声称"本地没有检索工具"，也不要编造内容。');
                            console.warn('[dsBuildSystemPrompt] 统一检索层失败，回退旧逻辑：', _kbErr);
                            try { window.__dsLastSrcs = { error: _kbErr }; } catch (e3) {}
                            _kbOnP = false;
                        }
                    } else {
                        // 【v4.20】未启用任何数据源 ⇒ 同样记入"本次参考"，回答尾部会如实告诉用户
                        try { window.__dsLastSrcs = { srcs: [] }; } catch (e4) {}
                        // 【2026-10-06】一个数据源都没启用时，原来**完全不提示** ⇒ 模型只能自己猜"本地没资料"。
                        //   明确写出来，并指出用户该去哪里开启（输入框上方的「关联数据」）。
                        sysParts.push('【本地资料】当前会话未启用任何本地数据源，本次回答不含本地库内容。'
                            + '请如实说明这一点，并提示用户可在输入框上方「关联数据」里勾选（规章制度/检查信息/检查手册等）；'
                            + '不要声称"本地没有检索工具"。'
                            // 【v4.22 用户要求】本地与联网**都**没有时，必须点明"没有外部依据"——
                            //   此函数不知道联网状态（联网判定在 _dsStreamChat 里），故用条件式表述，由模型按实际能力自行套用。
                            //   对安监业务尤其重要：不能把自己的记忆当成规章依据。
                            + '若本次同时**未启用联网**（没有检索工具可用或未检索），请明确告知用户：'
                            + '本次回答基于模型内部知识（**可能已过时**），不能作为规章依据，正式依据请以文件或原文为准。');
                    }
                }
                if (!_skipData && !_kbOnP) {

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
                } // ← if (!_kbOnP) 结束：以上为「统一检索层不可用或已关闭」时的旧逻辑

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

            // ════════════════════════════════════════════════════════════════
            // 澄清条组件 dsChoiceBar（v3.65）
            // ════════════════════════════════════════════════════════════════
            // 定位：凡是「系统能猜、但猜不准」的场景，把决定权交回用户，而不是替用户猜。
            // 三种形态共用同一个容器，区别只在动作集（actions）：
            //   ① 动作型（本期）—— 链接：直接打开 / 让 AI 读
            //   ② 方向型（阶段二）—— 意图歧义：对规 / 研判 / 写文书 / 按你的理解答
            //   ③ 答后修正条（阶段三）—— 挂在 AI 气泡下方，不阻塞
            // 三条硬约束（务必保持）：
            //   1) 默认不打扰 —— 判据拿得准就直接干，不弹。本期只在「输入真的含链接」时弹。
            //   2) 永远给出口 —— ✕ 忽略后同一批链接不再弹；直接回车发送照常走原有自动判定。
            //   3) 判定全本地 —— 纯前端正则，零延迟、离线可用（守住离线优先架构）。
            var _dsChoiceLinks = [];        // 当前澄清条关联的链接（其它场景可换语义）
            var _dsDismissedLinks = '';     // 用户 ✕ 忽略过的链接集合，避免同一批反复打扰
            var _dsLinkReCache = null;      // DS_LINK_CHUNK 惰性构建的正则实例

            function dsChoiceHide() {
                var bar = document.getElementById('ds-choice-bar');
                if (bar) bar.style.display = 'none';
                _dsChoiceLinks = [];
            }
            window.dsChoiceHide = dsChoiceHide;

            // 通用显示接口：cfg = { title, sub, actions:[{ label, primary, onClick }] }
            // 动作按钮一律 addEventListener 绑定，**不把 URL 等动态内容拼进内联 onclick**（防注入）。
            function dsChoiceShow(cfg) {
                cfg = cfg || {};
                var bar = document.getElementById('ds-choice-bar');
                var host = document.getElementById('ds-choice-acts');
                if (!bar || !host) return;
                var t = document.getElementById('ds-choice-title');
                var s = document.getElementById('ds-choice-sub');
                if (t) t.textContent = cfg.title || '';
                if (s) s.textContent = cfg.sub || '';
                host.innerHTML = '';
                (cfg.actions || []).forEach(function (a) {
                    var b = document.createElement('button');
                    b.type = 'button';
                    b.className = 'ds-choice-btn' + (a.primary ? ' ds-choice-btn--primary' : '');
                    b.textContent = a.label;
                    b.addEventListener('click', function (ev) {
                        ev.preventDefault(); ev.stopPropagation();
                        a.onClick();
                    });
                    host.appendChild(b);
                });
                bar.style.display = 'flex';
            }
            window.dsChoiceBar = { show: dsChoiceShow, hide: dsChoiceHide };

            // 从任意文本提取链接。
            // ⚠️ 口径必须与渲染层 dsAutoLink 完全一致（共用同一份 DS_LINK_CHUNK），否则会出现
            //    「气泡里已是可点链接、澄清条却说没检测到」的自相矛盾。
            // DS_LINK_CHUNK 是 var 声明且位于本文件渲染区（行号在此之后）→ 惰性构建，
            // 首次调用（用户输入时）必定已赋值，避免模块加载期的 TDZ/undefined。
            function dsExtractLinks(text) {
                var s = String(text || '');
                if (!s) return [];
                if (!_dsLinkReCache) {
                    try {
                        _dsLinkReCache = (typeof DS_LINK_CHUNK === 'string' && DS_LINK_CHUNK)
                            ? new RegExp(DS_LINK_CHUNK, 'gi')
                            : /https?:\/\/[^\s<>"']+/gi;
                    } catch (e) {
                        _dsLinkReCache = /https?:\/\/[^\s<>"']+/gi;
                    }
                }
                _dsLinkReCache.lastIndex = 0;
                var out = [], m;
                while ((m = _dsLinkReCache.exec(s)) !== null) {
                    if (m.index === _dsLinkReCache.lastIndex) _dsLinkReCache.lastIndex++;  // 防空匹配死循环
                    // 邮箱里的域名不算网页链接（mailto:a@b.com、user@example.com）。
                    // ⚠️ 这是与渲染层 dsAutoLink 的**有意差异**：渲染层会把 a@b.com 里的 b.com
                    //    也渲染成链接（既有行为，非本次引入）；但输入检测若照搬，用户粘一个邮箱
                    //    地址就会被弹「检测到链接」，属于明显误报。宁可少提示，不可乱提示。
                    if (m.index > 0 && s.charAt(m.index - 1) === '@') continue;
                    var raw = String(m[0]).replace(/[),.;:!?'"\]）】》]+$/, '');
                    if (!raw) continue;
                    var url = /^https?:/i.test(raw) ? raw : ('https://' + raw);
                    if (!dsSafeUrl(url)) continue;                 // 协议白名单（挡掉 javascript: 等）
                    if (out.indexOf(url) === -1) out.push(url);
                }
                return out;
            }
            window.dsExtractLinks = dsExtractLinks;

            // 「直接打开」的**旧行为**（跳系统浏览器新标签）：v3.66 起不再是默认动作，
            // 降级为内嵌面板里的「🌐 浏览器打开」出口与内嵌不可用时的兜底。
            // ⚠️ window.open 必须在点击事件的**同步调用栈**里直呼 —— 中间一旦 await，
            //    浏览器即判定「非用户手势」并拦截弹窗。故此处全程同步，不做任何异步校验。
            function dsOpenLinkExternal(url) {
                var safe = dsSafeUrl(url);
                if (!safe) { alert('该链接不被允许打开（仅支持 http/https）'); return; }
                // ⚠️ 不能再用 window.open(safe, '_blank', 'noopener')：按规范，windowFeatures 里带 noopener 时
                // 返回值恒为 null，"已经成功打开"也会被判成"被拦截"，于是每次都弹"浏览器拦截了新窗口"的假警报。
                // 改为先开空窗口、手动断 opener 再跳转，仅在真正被拦截时提示。
                var w = null;
                try {
                    w = window.open('', '_blank');
                    if (w) { try { w.opener = null; } catch (e) {} w.location.href = safe; }
                } catch (e) { w = null; }
                if (!w) alert('浏览器拦截了新窗口。请允许本站弹出窗口，或长按复制链接后手动打开。');
                // 用户已经作出选择 → 收起澄清条（无论是否成功打开），避免继续遮挡输入区
                dsChoiceHide();
            }

            // ════════════════════════════════════════════════════════════════
            // 内嵌网页面板（v3.66）
            // 需求：点「直接打开」不再跳系统浏览器，而是在**对话区内**渲染网页（对齐音视频的内嵌形态）。
            // ⚠️ 实测结论（务必先读，别再试图"检测失败"）：
            //   iframe 被 X-Frame-Options / CSP frame-ancestors 拒绝时，**onload 依然会触发**，
            //   contentDocument 跨域一律为 null，'securitypolicyviolation' 事件也不触发，
            //   contentWindow.length 在"被拒绝"与"正常但无子框架"两种情况下都是 0。
            //   → 纯前端**无法程序化判断**网页是否被拒绝嵌入。因此本模块不自作聪明地报"失败"，
            //     而是：① 常驻一条可关闭的诚实提示（这是网站自身策略，不是本应用故障）；
            //           ② 永远保留「🌐 浏览器打开」出口；③ 只有真·超时才提示"加载缓慢或已被拦截"。
            // 另：面板刻意做成 ds-chat-box 的兄弟节点，**不放进消息气泡** —— 消息气泡会被
            //     dsRenderAll 整段重建，内嵌的浏览上下文（滚动位置、已缓冲内容）会随之丢失。
            var _dsEmbedUrl = '';                                  // 当前内嵌地址
            var DS_EMBED_TIP_KEY = '_ds_embed_tip_hidden';         // 提示条「不再提示」的持久化键

            // 业界普遍禁止被 iframe 嵌入的站点。命中只用于**提前**给出"可能空白"的提醒，
            // 不作为判定（未命中的站点同样可能被拒绝）。
            var DS_EMBED_RISKY = /(^|\.)(baidu|zhihu|weixin|weibo|taobao|tmall|jd|xiaohongshu|douyin|bilibili|csdn|jianshu|toutiao|douban)\./i;

            function _dsEmbedEl(id) { return document.getElementById(id); }

            // 状态行：加载中 / 超时提示。传空串即隐藏。
            function dsEmbedStatus(text, isErr) {
                var el = _dsEmbedEl('ds-embed-status');
                if (!el) return;
                if (!text) { el.style.display = 'none'; el.textContent = ''; return; }
                el.textContent = text;
                el.className = 'ds-embed-status' + (isErr ? ' ds-embed-status--err' : '');
                el.style.display = 'block';
            }

            // 设置 iframe.src 并挂超时兜底。抽成函数是因为「重新加载」也要复用同一套逻辑。
            function dsEmbedLoad(safe) {
                var frame = _dsEmbedEl('ds-embed-frame');
                if (!frame) return;
                // sandbox 是这里唯一能加的安全防线：跨域本身已隔离 DOM/Cookie，
                // 但**不给 allow-top-navigation** 才能挡住内嵌页面把整个应用顶层跳转到钓鱼站。
                try {
                    frame.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms allow-popups');
                } catch (e) {}
                dsEmbedStatus('正在加载…', false);
                var settled = false;
                var timer = setTimeout(function () {
                    if (settled) return;
                    // 走到这里只有两种可能：真的慢，或已被拒绝（拒绝通常很快触发 load，故多指向"慢"）
                    dsEmbedStatus('该网页加载较慢，或已拒绝被嵌入显示。可点右上角「🌐 浏览器打开」。', true);
                }, 12000);
                frame.onload = function () {
                    settled = true;
                    clearTimeout(timer);
                    dsEmbedStatus('', false);      // onload 在"被拒绝"时也会触发，故只清状态、不报成功
                };
                frame.setAttribute('src', safe);
            }

            // 在对话区内打开网页
            function dsOpenLinkEmbed(url) {
                var safe = dsSafeUrl(url);
                if (!safe) { alert('该链接不被允许打开（仅支持 http/https）'); return; }
                var host = _dsEmbedEl('ds-embed-host');
                var frame = _dsEmbedEl('ds-embed-frame');
                if (!host || !frame) { dsOpenLinkExternal(safe); return; }   // 面板缺失（旧版 HTML）→ 退回浏览器

                _dsEmbedUrl = safe;
                var hostname = safe;
                try { hostname = new URL(safe).host.replace(/^www\./, '') || safe; } catch (e) {}
                var t = _dsEmbedEl('ds-embed-title');
                var u = _dsEmbedEl('ds-embed-url');
                if (t) t.textContent = hostname;
                if (u) u.textContent = safe;

                // 提示条：用户点过「✕」就永久不再显示（localStorage 持久化，离线可用）
                var tip = _dsEmbedEl('ds-embed-tip');
                if (tip) {
                    var hidden = false;
                    try { hidden = localStorage.getItem(DS_EMBED_TIP_KEY) === '1'; } catch (e) {}
                    tip.style.display = hidden ? 'none' : 'flex';
                }

                // 打开网页 = 用户新开了一路声音源 → 按既有互斥规则停掉对话区里正在播的音视频与朗读
                try { if (typeof dsStopOtherMedia === 'function') dsStopOtherMedia(null, null); } catch (e) {}

                host.style.display = 'flex';
                dsEmbedLoad(safe);
                // 命中常见禁嵌站点时，把提示换成更具体的版本（仅提前告知，不是判定）
                if (DS_EMBED_RISKY.test(hostname)) {
                    dsEmbedStatus('该网站通常禁止被嵌入显示，下方可能是空白 —— 请用「🌐 浏览器打开」。', true);
                }
                dsChoiceHide();
                // 把面板滚进视野，避免用户以为"点了没反应"
                try { if (host.scrollIntoView) host.scrollIntoView({ block: 'nearest' }); } catch (e) {}
                frame.focus && frame.focus();
            }
            window.dsOpenLinkEmbed = dsOpenLinkEmbed;

            // 关闭并返回对话：必须清空 src，否则被隐藏的 iframe 里音视频会继续播放
            function dsCloseLinkEmbed() {
                var host = _dsEmbedEl('ds-embed-host');
                var frame = _dsEmbedEl('ds-embed-frame');
                if (frame) {
                    try { frame.onload = null; } catch (e) {}
                    frame.removeAttribute('src');          // 摘掉 src 即销毁浏览上下文，声音随之停止
                }
                if (host) host.style.display = 'none';
                dsEmbedStatus('', false);
                _dsEmbedUrl = '';
            }
            window.dsCloseLinkEmbed = dsCloseLinkEmbed;

            // 面板按钮：委托到 document，不依赖对话面板的创建时机（与澄清条同款做法）
            document.addEventListener('click', function (e) {
                var t = e.target;
                if (!t || !t.closest) return;
                if (t.closest('#ds-embed-close')) { dsCloseLinkEmbed(); return; }
                if (t.closest('#ds-embed-reload')) { if (_dsEmbedUrl) dsEmbedLoad(_dsEmbedUrl); return; }
                if (t.closest('#ds-embed-external')) { if (_dsEmbedUrl) dsOpenLinkExternal(_dsEmbedUrl); return; }
                if (t.closest('#ds-embed-tip-close')) {
                    var tip = _dsEmbedEl('ds-embed-tip');
                    if (tip) tip.style.display = 'none';
                    try { localStorage.setItem(DS_EMBED_TIP_KEY, '1'); } catch (err) {}
                    return;
                }
                // 【2026-09-29】「📥 存为资料」：证据条来源行上的按钮。
                //   属性里直接带 url/title（不依赖渲染顺序，也不与消息 id 耦合）；点击后用 dsSaveLinkAsMaterial 取正文落库。
                var svBtn = t.closest('[data-ds-save-url]');
                if (svBtn) {
                    e.preventDefault();
                    e.stopPropagation();
                    var _su = svBtn.getAttribute('data-ds-save-url') || '';
                    var _st = svBtn.getAttribute('data-ds-save-title') || '';
                    if (_su) { try { window.dsSaveLinkAsMaterial(_su, _st); } catch (err) {} }
                    return;
                }
                // 正文里的链接（dsAutoLink 生成的 a.ds-md-link）：一律改为在对话区内嵌打开。
                // 保留标准浏览器习惯 —— Ctrl/Cmd/Shift+点击、中键（走 auxclick）仍交给系统浏览器新标签，
                // 这样"想对照两个网页"的老习惯不会被破坏。媒体卡片上的「新窗口打开 ↗」不属此类，不受影响。
                var mdLink = t.closest('a.ds-md-link');
                if (mdLink) {
                    if (e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
                    var hrefSafe = dsSafeUrl(mdLink.getAttribute('href') || '');
                    if (!hrefSafe) return;
                    e.preventDefault();
                    dsOpenLinkEmbed(hrefSafe);
                }
            });

            // 「让 AI 读」：置强制联网标记后走正常发送流程
            function dsReadLinkWithAI() {
                var links = _dsChoiceLinks.slice();
                if (!links.length) return;
                dsChoiceHide();
                // _dsForceWebSearch 由 dsSendMsg 读取后立即清除（仅本次生效）。
                // 因 useWebSearch = 开关 || forceWs || autoWs 是「或」关系，走这条路径可绕开业务域判定，
                // 保证链接一定被送去检索——这正是「含业务词的链接被静默忽略」那个缺陷的兜底。
                window._dsForceWebSearch = true;
                if (typeof window.dsSendMsg === 'function') window.dsSendMsg();
            }

            // 输入含链接时浮出澄清条（纯本地判定：无网络请求、无模型调用）
            function dsCheckInputLinks() {
                var input = document.getElementById('ds-user-input');
                if (!input) return;
                var val = input.value || '';
                if (!val.trim()) { dsChoiceHide(); return; }
                var links = dsExtractLinks(val);
                if (!links.length) { dsChoiceHide(); return; }
                if (links.join('|') === _dsDismissedLinks) { dsChoiceHide(); return; }  // 已忽略过这批
                _dsChoiceLinks = links;
                var host = links[0];
                try { host = new URL(links[0]).host.replace(/^www\./, ''); } catch (e) {}
                dsChoiceShow({
                    title: '检测到链接',
                    sub: links.length > 1 ? (host + ' 等 ' + links.length + ' 个') : host,
                    actions: [
                        { label: '🔗 直接打开', onClick: function () { dsOpenLinkEmbed(links[0]); } },
                        { label: '📖 让 AI 读', primary: true, onClick: dsReadLinkWithAI },
                        // 【2026-09-29】用户要求：智能对话里"把这页存为资料" —— 贴链接时就给一次性入口
                        { label: '📥 存为资料', onClick: function () {
                            try {
                                var _ls = (links || []).slice(0, 4);
                                dsChoiceHide();
                                try { window.Toast.info('正在读取并存入资料（' + _ls.length + ' 个）…'); } catch (e) {}
                                _ls.forEach(function (_u) { try { window.dsSaveLinkAsMaterial(_u, ''); } catch (e2) {} });
                            } catch (e) {}
                        } }
                    ]
                });
            }
            window.dsCheckInputLinks = dsCheckInputLinks;

            // 绑定：委托到 document，不依赖 dsInit 的执行时机（对话面板是按需创建的）
            document.addEventListener('input', function (e) {
                var t = e.target;
                if (t && t.id === 'ds-user-input') dsCheckInputLinks();
            });
            document.addEventListener('click', function (e) {
                var t = e.target;
                if (!t || !t.closest) return;
                // ✕ 忽略：记住这批链接，之后不再弹（用户仍可直接回车发送）
                if (t.closest('#ds-choice-close')) {
                    _dsDismissedLinks = _dsChoiceLinks.join('|');
                    dsChoiceHide();
                    return;
                }
                // 点发送：立即收起澄清条。
                // ⚠️ 清空输入框用的是 `input.value = ''`，属程序化赋值、**不会触发 input 事件**，
                //    所以不能指望上面的 input 监听自动收起，必须在发送动作上显式处理。
                if (t.closest('#ds-send-btn')) dsChoiceHide();
            });
            document.addEventListener('keydown', function (e) {
                var t = e.target;
                if (t && t.id === 'ds-user-input' && e.key === 'Enter' && !e.shiftKey) dsChoiceHide();
            }, true);

            // 【v4.22 诊断】暴露 system 构建入口：**不调模型**，只看"这一问注入了什么"（本地资料段 / 联网段 / 两者关系）。
            //   用途：核对"本地 × 联网"四种组合的实际提示词内容（本文件里联网段在 _dsStreamChat 里单独追加，
            //   与本地注入分处两地 —— 组合行为最容易在这里出问题，必须可实测）。
            try { window.__dsBuildPrompt = dsBuildSystemPrompt; } catch (e) {}

            /* ==================== 【v4.20】回答尾部「本次参考」一行 ====================
             * 为什么做：用户两轮反馈都围绕同一件事 —— **不知道本地资料到底有没有被用上**
             *   （先出现"本地数据库未提供检索工具"的误导表述，后是"关联数据看不见隐含注入"）。
             * 做法：每轮回答结束后，以**系统行**（非模型输出、不进历史、不会被重新生成带出）如实标出
             *   本轮实际注入了哪些本地源；三种状态都呈现（已注入 / 未启用任何源 / 检索层异常）。
             * 关闭方式：`localStorage.setItem('ds_kb_badge','0')`（默认开）。
             * ===================================================================== */
            /* ==================== 【2026-10-07 用户口径】回答「答所问」自检（输出后闭环）====================
             * 为什么做：用户问"内容输出前有无闭环检查？是否有判断输出与提问一致的工具？否则输出无法有效控制"。
             *   盘点结论 —— 已有的是：**智能体侧**工具失败门禁（agent-core 收口前程序化补"未成功项"）+ 提示词规则 15 自检；
             *   **对话侧**只有"本次参考"事实标注与"联网零检索"告警。**缺的正是"输出 vs 提问是否一致"这一环**。
             * 做法：规则式事后校验（确定性、零 API 成本、即时）——
             *   ① 识别请求类型（与提示词【回答风格】第 8 条**同一套关键词**，保证事前约束与事后校验口径一致）；
             *   ② 校验形态是否匹配（要清单却给散文 / 要数据却无数字与口径 / 要条文却无条号）；
             *   ③ 检测**越权章节**（用户没要建议，却出现"整改建议/管控措施/待核实"等章节）。
             * ⚠️ 安全边界：**只提示、绝不改写模型回答**（用户可能就想看那些内容，改写会丢信息）；
             *   误报容忍度优先 —— 规则保守，只报高置信问题；可用 `localStorage.ds_selfcheck='0'` 关闭。
             * 诊断入口：`__dsAnswerSelfCheck(问题, 回答)`（手动跑任意问答对，不调模型）。
             * ===================================================================== */
            var DS_REQ_LABEL = { list: '清单/表格', data: '数据统计', rule: '规章条文', doc: '材料/报告', judge: '定性判定', open: '开放问题' };
            /** 请求类型识别（与 system 提示【回答风格】第 8 条的关键词口径保持一致） */
            function dsClassifyQuery(q) {
                var t = String(q || '');
                if (/清单|检查表|项点|表格|检查项|对照表|检查内容/.test(t)) return 'list';
                if (/多少|几条|几次|几起|条数|统计|占比|排名|分布|同比|环比/.test(t)) return 'data';
                if (/原文|第.{1,6}条|怎么规定|怎么写的|依据是什么|出处是什么/.test(t)) return 'rule';
                if (/报告|材料|方案|讲话|总结|纪要|汇报|写一份|起草/.test(t)) return 'doc';
                if (/(算|属于|定为).{0,6}(A类|B类|C类|红线)|是否违反|定性|性质|等级/.test(t)) return 'judge';
                return 'open';
            }
            /**
             * 回答自检：返回 { req, label, issues[], ok }
             * issues 为**高置信**问题清单（只提示、不改写）。
             */
            window.__dsAnswerSelfCheck = function (query, answer) {
                var q = String(query || ''), a = String(answer || '');
                var req = dsClassifyQuery(q);
                var issues = [];
                try {
                    if (!a.trim()) return { req: req, label: DS_REQ_LABEL[req], issues: [], ok: true, empty: true };
                    // ① 形态匹配
                    if (req === 'list') {
                        var hasTable = /\|[^|\n]*\|/.test(a);                                   // Markdown 表格
                        var hasList = /(?:^|\n)\s*(?:\d+[.、)]|[-*·])\s*\S/.test(a);             // 分条
                        if (!hasTable && !hasList) issues.push('要的是清单/表格，但回答里没有表格或分条列表');
                    } else if (req === 'data') {
                        if (!/\d/.test(a)) issues.push('要的是数据，但回答里没有数字');
                        else if (!/(数据源|来源|检查信息|规章制度|共\s*\d|合计|总计|时间范围|以来|个月|年|截至)/.test(a)) {
                            issues.push('数据未标注口径（数据源 / 时间范围 / 总条数）');
                        }
                    } else if (req === 'rule') {
                        if (!/(第\s*[\d一二三四五六七八九十百]+\s*条|《[^》\n]{2,40}》)/.test(a)) {
                            issues.push('要的是条文，但回答里没有条款原文或名称条号');
                        }
                    }
                    // ② 越权章节：用户没要建议，却给了建议/待核实类**章节标题**
                    var _askedAdvice = /建议|措施|整改|怎么办|如何处置|方案|下一步|管控/.test(q);
                    if (!_askedAdvice && req !== 'open' && req !== 'doc') {
                        var extra = [];
                        if (/(?:^|\n)\s*(?:#{1,6}\s*)?(?:\*{0,2})[^\n]{0,6}(整改|管控|改进)[^\n]{0,4}(建议|措施)/.test(a)) extra.push('整改/管控建议');
                        if (/(?:^|\n)\s*(?:#{1,6}\s*)?(?:\*{0,2})[^\n]{0,4}待核实/.test(a)) extra.push('待核实事项');
                        if (/(?:^|\n)\s*(?:#{1,6}\s*)?(?:\*{0,2})[^\n]{0,4}(总体结论|总结评价|综合评价)/.test(a)) extra.push('总体结论');
                        if (extra.length) {
                            issues.push('含未被要求的章节：' + extra.join('、') + '（提问只要「' + DS_REQ_LABEL[req] + '」）');
                        }
                    }
                } catch (e) {
                    return { req: req, label: DS_REQ_LABEL[req], issues: [], ok: true, err: String((e && e.message) || e) };
                }
                return { req: req, label: DS_REQ_LABEL[req], issues: issues, ok: issues.length === 0 };
            };

            window.__dsAppendKbBadge = function () {
                try {
                    try { if (localStorage.getItem('ds_kb_badge') === '0') return; } catch (e) { return; }
                    // 只在本轮**正常产出回答**时追加：失败（❌ 开头）、空回答、被用户停止（无内容）都不打扰
                    var last = dsHistory[dsHistory.length - 1] || {};
                    if (last.role !== 'assistant') return;
                    var txt = String(last.content || '');
                    if (!txt || /^❌/.test(txt)) return;
                    var info = window.__dsLastSrcs || null, line;
                    var _label = function (k) { return (window.__dsSrcLabel && window.__dsSrcLabel[k]) || k; };
                    if (info && info.error) {
                        line = '📎 本次参考：本地资料不可用（' + info.error + '）';
                    } else if (info && info.srcs && info.srcs.length) {
                        line = '📎 本次参考：' + info.srcs.map(_label).join(' · ') + (info.auto ? '（自动关联）' : '');
                    } else if (info && info.srcs && !info.srcs.length) {
                        line = '📎 本次参考：未启用任何本地数据源（可在输入框上方「关联数据」勾选）';
                    } else {
                        // 【2026-10-08】按**真实原因**显示：原来一律写"寒暄/闲聊类问题不检索"，
                        //   把"未启用数据源"和"代码角色"两种情形都误报成寒暄，用户据此无法判断（也正是
                        //   本次"检测不到数据"反馈难定位的原因之一）。
                        var _rsn = (info && info.reason) || '';
                        line = '📎 本次参考：未使用本地资料' + (_rsn === 'codeRole'
                            ? '（当前为代码角色，本轮按代码任务作答）'
                            : _rsn === 'trivial'
                                ? '（寒暄/闲聊类问题不检索）'
                                : '（未启用任何本地数据源，可在输入框上方「关联数据」勾选）');
                    }
                    // 【v4.22 用户要求】补联网维度：一眼看清"本地用了什么 + 联网到底检索了没有"。
                    //   ⚠️ "联网已启用但本轮未检索"必须显式写出来 —— 这是最容易误解的情形
                    //     （用户以为查了外网，其实模型判断不需要、一次都没检索）。
                    var _ws = window.__dsLastWs || null;
                    if (_ws && _ws.on) {
                        var _sn = _ws.searches || 0;
                        line += '｜🌐 联网：' + (_sn > 0 ? ('已检索 ' + _sn + ' 次') : '已启用但本轮未检索');
                    } else if (_ws && _ws.on === false) {
                        line += '｜🌐 联网：未启用';
                    }
                    // 【2026-10-07 用户需求】自动角色透明化：只有选了「自动」才显示（手动选角色时不必重复提示）。
                    //   标出**本轮实际使用的角色 + 判定原因**，让"它凭什么这么答"可见 —— 与「本次参考」同思路：
                    //   系统的自动行为必须可追溯，否则用户会怀疑"是不是选错了角色"。
                    var _lr = window.__dsLastRole || null;
                    if (_lr && _lr.label) {
                        line += '｜🤖 自动角色：' + _lr.label + (_lr.reason ? '（' + _lr.reason + '）' : '');
                    }
                    dsAppendMsg('system', line);
                    // 【2026-10-07 用户口径】回答「答所问」自检 —— **只提示、绝不改写模型回答**。
                    //   定位本轮提问：取历史里最后一条 user 消息（displayText 是原始问句，content 可能含附件正文，
                    //   分类只看问句本身 ⇒ 优先 displayText）。
                    //   关闭方式：`localStorage.ds_selfcheck='0'`（与 ds_kb_badge 同风格）。
                    try {
                        if (localStorage.getItem('ds_selfcheck') !== '0') {
                            var _q = '';
                            for (var _hi = dsHistory.length - 1; _hi >= 0; _hi--) {
                                if (dsHistory[_hi] && dsHistory[_hi].role === 'user') {
                                    _q = String(dsHistory[_hi].displayText || dsHistory[_hi].content || '');
                                    break;
                                }
                            }
                            var _chk = window.__dsAnswerSelfCheck(_q, txt);
                            if (_chk && _chk.issues && _chk.issues.length) {
                                dsAppendMsg('system', '⚠️ 自检：' + _chk.issues.join('；')
                                    + '（由系统规则校验，非模型输出；需要关闭可设置 ds_selfcheck=0）');
                            }
                        }
                    } catch (e2) {}
                } catch (e) {}
            };

            /**
             * 【2026-10-08 体检修复】判据统一用**用户原始问句**（不含附件正文）。
             *   问题：角色判定 / 思考档 / 联网判定 / 专项规范注入 原来都跑在 `finalText` 上，而 finalText 里
             *   被拼进了**整篇附件正文**（见 2553-2560）。贴一份含 URL、"最新"、"代码"字样的文件，
             *   就会：把角色判成"前端"、强制联网、思考档拔高、注入额外规范段 —— **四处同时误触发**。
             *   修法：`dsSendMsg` 记录本轮纯问句到 `window.__dsRawUserText`，判据处统一走本函数取。
             */
            function _dsJudgeText(fallback) {
                try {
                    var t = window.__dsRawUserText;
                    if (t && String(t).trim()) return String(t);
                } catch (e) {}
                return String(fallback == null ? '' : fallback);
            }

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
                // 【2026-10-08】供 _dsRunStream 内的各类"按文本判断"的判据使用（见 _dsJudgeText）
                try { window.__dsRawUserText = rawUserText; } catch (e) {}

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
                // 【v3.76 智能体并入对话】/agent <任务>：就地执行任务（规划 + 多步工具调用），
                //   执行过程以卡片形式留在本轮回答上方，不再需要切到独立「智能体」标签页。
                //   与独立入口共用同一个 agent-core（同一批工具、同一套 Key/模型），因此能力完全一致。
                if (rawUserText === '/agent' || rawUserText.startsWith('/agent ') || rawUserText.startsWith('/agent　')) {
                    const task = rawUserText.replace(/^\/agent[ \u3000]*/, '').trim();
                    if (!task) { alert('用法：/agent <任务>\n例如：/agent 统计上月供电专业 A 类问题并生成简报'); return; }
                    if (typeof window._agentRun !== 'function') { alert('智能体内核未加载，无法执行任务。'); return; }
                    // 【2026-09-21】目标命令（/goal…）在对话内也能用：不再只限独立「智能体」标签页。
                    //   走纯本地处理（不调模型），结果直接作为一条回答落到对话里。
                    if (task.charAt(0) === '/' && typeof window.handleAgentCommand === 'function') {
                        var _cmdResp = window.handleAgentCommand(task);
                        if (_cmdResp !== null && _cmdResp !== undefined) {
                            input.value = '';
                            if (typeof window.dsSyncSendState === 'function') window.dsSyncSendState();
                            dsHistory.push({ role: 'user', content: rawUserText });
                            dsHistory.push({ role: 'assistant', content: _cmdResp });
                            dsRenderAll(); dsScrollBottom();
                            return;
                        }
                    }
                    // 【2026-09-21】把当前附件里的图片一并交给智能体（原来 /agent 恒传 null →
                    //   用户传了图却得到"看不到图片"；独立「智能体」标签页一直有这段，两边行为现已一致）
                    var _agentImgs = [], _agentAttachNames = [];
                    try {
                        var _atts = (window._dsAttachments || []).filter(Boolean);
                        _agentAttachNames = _atts.map(function(a) { return (a && a.name) || '附件'; });
                        _agentImgs = _atts.filter(function(a) { return a && a.isImage && a.dataUrl; }).map(function(a) { return a.dataUrl; });
                        if (_atts.length) {   // 附件已消费：清空预览，避免下一轮重复带上
                            window._dsAttachments = [];
                            var _af = document.getElementById('ds-attach-file');
                            if (_af) _af.value = '';
                        }
                    } catch (_e) { _agentImgs = []; }
                    input.value = '';
                    if (typeof window.dsSyncSendState === 'function') window.dsSyncSendState();
                    dsHistory.push({ role: 'user', content: rawUserText + (_agentAttachNames.length ? '\n📎 ' + _agentAttachNames.join('、') : '') });
                    dsHistory.push({ role: 'assistant', content: '', agentSteps: [] });
                    var _agentMsgIdx = dsHistory.length - 1;
                    dsRenderAll(); dsScrollBottom();
                    (function () {
                        var _t0 = Date.now();
                        var _cur = dsHistory[_agentMsgIdx];
                        var _live = '🚀 正在执行任务（可多步调用本地数据）';
                        if (_cur && !_cur.agentSteps) _cur.agentSteps = [];
                        // 【2026-09-19 实时进度】计划/工具卡片**边跑边插入**（不再等整轮跑完一次性渲染），
                        //   状态行每秒走秒。只重绘这一个气泡（_dsPaintBubble）= 不整表重绘、不抖动；
                        //   结束时再写 cur.content + dsRenderAll()，卡片挂回消息上永久保留。
                        var _paint = function () {
                            if (!_cur) return;
                            var s = Math.max(0, Math.round((Date.now() - _t0) / 1000));
                            _dsPaintBubble(_agentMsgIdx,
                                (typeof window.dsAgentStepsHtml === 'function' ? window.dsAgentStepsHtml(_cur.agentSteps) : '')
                                + '<div style="color:#64748b;font-size:0.85rem;">' + _live + '（已等 ' + s + 's）</div>', false);
                        };
                        var _timer = setInterval(_paint, 1000);
                        var _stopTick = function () { if (_timer) { clearInterval(_timer); _timer = null; } };
                        _paint();
                        Promise.resolve()
                            .then(function () {
                                return window._agentRun(task, (_agentImgs && _agentImgs.length) ? _agentImgs : null, {
                                    onStep: function (ev) {
                                        if (!ev) return;
                                        if (ev.phase === 'plan' || ev.phase === 'tool-done') {
                                            if (ev.step && _cur) _cur.agentSteps.push(ev.step);
                                        } else if (ev.phase === 'thinking') {
                                            _live = '🧠 正在思考（第 ' + (ev.round || 1) + ' 轮）';
                                        } else if (ev.phase === 'tool-start') {
                                            _live = '🔧 正在调用：' + ((ev.tools || []).join('、') || '工具');
                                        } else if (ev.phase === 'tool-progress') {
                                            // 【2026-09-21】慢工具的每秒心跳 + 阶段文案（如"正在准备知识库索引…"）
                                            _live = '🔧 正在调用：' + (ev.tool || '工具') + (ev.text ? '（' + ev.text + '）' : '')
                                                + (ev.ms ? ' 已等 ' + Math.round(ev.ms / 1000) + 's' : '');
                                        } else if (ev.phase === 'answer') {
                                            _live = '✍️ 正在整理回答';
                                        }
                                        _paint();
                                    }
                                });
                            })
                            .then(function (res) {
                                _stopTick();
                                var msgs = (res && res.messages) || [];
                                var steps = msgs.filter(function (m) { return m && (m.role === 'agent-plan' || m.role === 'agent-tool'); });
                                var finalTxt = '';
                                msgs.forEach(function (m) { if (m && m.role === 'assistant') finalTxt = m.content || ''; });
                                var cur = dsHistory[_agentMsgIdx];
                                if (cur) {
                                    cur.agentSteps = steps;
                                    // ⚠️ 不能用 <small> 之类的 HTML：dsMarkdown 是"先转义再替换"，标签会被当文本显示
                                    //   （实测气泡里出现字面 <small style="…">）。这里用纯文本。
                                    cur.content = (finalTxt || '（任务已执行，未返回文本内容）')
                                        + '\n\n（任务耗时 ' + Math.round((Date.now() - _t0) / 1000) + 's · 工具调用 ' + steps.filter(function (s) { return s.role === 'agent-tool'; }).length + ' 次）';
                                }
                                dsRenderAll(); dsScrollBottom();
                            })
                            .catch(function (e) {
                                _stopTick();
                                var cur2 = dsHistory[_agentMsgIdx];
                                if (cur2) cur2.content = '❌ 任务执行失败：' + ((e && e.message) ? e.message : String(e));
                                dsRenderAll(); dsScrollBottom();
                            });
                    })();
                    return;
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
                // 【2026-09-30 用户口径】对话里输入**任何内容都不得跳转**到「智能写作 / 智能对规 / 智能风险研判」。
                //   原先这里按关键词"抢话"（对规：对规|违反|违章|不符合|哪条规章|匹配条款；
                //   写作：写报告|生成…报告|起草|撰写|月度总结|整改通知书；研判：生成/分析…+风险/趋势/预警）——
                //   用户明确要求去掉这种自动跳转：这些内容一律**留在对话里正常回答**。
                //   仍可切模块的方式（都是"用户主动"）：
                //     · 子视图下拉 ds-sub-select（index.html）手动切换；
                //     · 显式命令 `/check …` `/write …` `/risk …`（见上方第 1 段强制命令路由）；
                //     · 回答末尾的建议按钮（点它=用户点击，走正常发送流程，不再被内容规则拽走）。
                if (currentSub === 'chat') {
                    // 自然语言不再做任何路由：不切子视图、不把输入搬给别的模块。
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
                            // 提示图片不会被识别（避免误以为已看图）。措辞用「系统提示」的第三人称视角：
                            // 若写成「当前模型为纯文本模型」，模型会把它当成自我描述，在后续无关话题里也反复声明「我看不了图」。
                            finalText += '\n\n（系统提示：本轮附件中的图片未能送入模型识别，仅以文字说明形式提交。如需识别图片，请在「设置 → API 配置 → ＋新增模型」中把模型切换为 deepseek-flash（DeepSeek V4.1 Flash，原生支持图像识别）。本提示仅说明这一次的附件处理情况，不要在无关话题中复述或据此介绍自己的图像能力。）';
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

                // ════════════════════════════════════════════
                // 【v3.74 卡滞修复】先把「生成中」反馈渲染出来，再做重活
                // ════════════════════════════════════════════
                // 症状（用户反馈）：点发送后 3~8 秒界面毫无反应，之后才按钮变红、气泡出现。
                // 原因：下面的 dsBuildSystemPrompt() 内部 `await KB.ensure()`（建索引 / 从 IndexedDB 恢复索引，
                //   大源实测 0.8~7s；浏览器实测冷启动 817ms 中 776ms 花在这里），而"按钮变红 + 助手气泡"
                //   原先排在它**之后**才执行 → 这段等待完全没有任何界面反馈。
                // 现在：立即插入空助手气泡（渲染层对空内容显示"思考中…"）+ 发送按钮切成「停止」态，
                //   再用双 rAF 让浏览器**真的把这一帧画出来**，然后才去做建索引/检索等重活。
                // 【优化·速度】请求历史瘦身：报告类回答可达上万字，会在后续每一轮被**完整重发**，
                //   既拖慢首字（首 token 延迟随 prompt 增长）又稀释当轮重点。
                //   策略：只对"较早的助手消息"截断（保留最近一条助手回答完整 —— 用户追问
                //   "把上面那条改一下"通常指它），保留头部 1800 + 尾部 600 字，中间标出省略量。
                //   仅影响发出去的请求副本，聊天区显示与存档不受影响。
                var _reqHistRaw = dsHistory.slice(-10);
                var _lastAsstIdx = -1;
                for (var _hi = _reqHistRaw.length - 1; _hi >= 0; _hi--) {
                    if (_reqHistRaw[_hi] && _reqHistRaw[_hi].role === 'assistant') { _lastAsstIdx = _hi; break; }
                }
                // 【2026-10-08 业界对齐 · Context Editing / Compaction】
                //   问题：附件正文是以**全文**写进 user 消息 content 的（见上方"【附件内容】"拼接处），
                //     而这里的历史瘦身**只截断 assistant** ⇒ 带附件的会话里，同一份附件正文会**每轮被完整重发**
                //     （大附件上万字符/轮）：既拖慢首字（首 token 延迟随 prompt 长度增长），又挤占本轮重点。
                //   业界做法（Anthropic Context Editing —— 按策略自动清理较旧的上下文；Compaction —— 把旧内容
                //     压成摘要；Claude Code 同理：旧文件内容换成"摘要 + 可重新获取的句柄"）：
                //     ① **最近一轮的附件正文完整保留** —— 用户此刻最可能就这份附件追问，细节不能丢；
                //     ② **更早轮次**的附件正文压成"头部片段 + 尾部片段 + 省略量"，并**显式告知模型**
                //        "这是历史压缩，需要细节请让用户指明片段或重新上传"（如实告知，绝不静默丢信息后靠编造补）；
                //     ③ 只在**请求副本**上做，聊天区显示与本地存档一字不动。
                //   ⚠️ 为什么不是"删掉整段"：那样模型会以为附件不存在，用户追问时答"没看到附件" —— 属静默降级。
                var _lastUserIdx = -1;
                for (var _uji = _reqHistRaw.length - 1; _uji >= 0; _uji--) {
                    if (_reqHistRaw[_uji] && _reqHistRaw[_uji].role === 'user') { _lastUserIdx = _uji; break; }
                }
                var DS_ATTACH_MARK = '【附件内容】';
                var DS_ATTACH_KEEP = 2000;   // 超过此长度才压缩（小附件保持原样，避免无谓加工）
                var _reqHist = _reqHistRaw.map(function (m, _i) {
                    // ① assistant：较早的整段回答截断（原逻辑，保持不变）
                    if (m && m.role === 'assistant' && _i !== _lastAsstIdx) {
                        var _c = String(m.content || '');
                        if (_c.length > 3000) {
                            return { role: m.role, content: _c.slice(0, 1800) + '\n\n…（此处省略 ' + (_c.length - 2400) + ' 字）\n\n' + _c.slice(-600) };
                        }
                    }
                    // ② user：历史消息（非本轮）里的附件正文压缩
                    if (m && m.role === 'user' && _i !== _lastUserIdx) {
                        var _u = String(m.content || '');
                        var _ai = _u.indexOf(DS_ATTACH_MARK);
                        if (_ai >= 0) {
                            var _uHead = _u.slice(0, _ai);
                            var _uBody = _u.slice(_ai + DS_ATTACH_MARK.length);
                            if (_uBody.length > DS_ATTACH_KEEP) {
                                return {
                                    role: 'user',
                                    content: _uHead + DS_ATTACH_MARK
                                        + _uBody.slice(0, 600)
                                        + '\n\n…（历史附件正文已压缩，省略 ' + (_uBody.length - 800) + ' 字；'
                                        + '如需其中细节，请让用户指明要看的部分或重新上传该文件，不要凭记忆编造附件内容）\n\n'
                                        + _uBody.slice(-200)
                                };
                            }
                        }
                    }
                    return m;
                });   // 请求用历史快照：此刻只含历史 + 本轮 user，不含下面这条空助手气泡
                dsHistory.push({ role: 'assistant', content: '' });
                var assistantIdx = dsHistory.length - 1;
                dsRenderAll();
                dsScrollBottom();
                dsStreaming = true;
                var sendBtn = document.getElementById('ds-send-btn');
                if (sendBtn) {
                    sendBtn.disabled = false;
                    sendBtn.classList.add('on', 'stopping');
                    sendBtn.title = '点击停止生成';
                    sendBtn.onclick = function() { if (window._dsAbortController) window._dsAbortController.abort(); };
                    sendBtn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2.4"/></svg>';
                }
                window._dsAbortController = new AbortController();
                // 准备阶段超过 400ms 才把气泡文字换成「正在准备本地资料」——暖态（0.1s 内）不会闪烁
                var _prepHintTimer = setTimeout(function () {
                    try { _dsPaintBubble(assistantIdx, '🔍 正在准备本地资料…', true); } catch (e) {}
                }, 400);
                // 让出一帧（双 rAF）：只 yield 微任务不够，必须让浏览器完成一次绘制，按钮/气泡才真的可见
                await new Promise(function (r) { requestAnimationFrame(function () { requestAnimationFrame(r); }); });

                // ---- 4.4 角色注入 ----
                // 【2026-09-27】改走 window.dsGetRole()：DOM 读不到时回落 localStorage 里记的角色，
                //   不再静默变成 default（此前"选了角色却不生效"的根因之一）。
                // 【2026-10-07 用户需求】改走 dsResolveRole：用户选「自动」时**按本轮问题**推断专业角色；
                //   手动选定的角色原样返回（绝不干预）。解析结果与判定原因记入 `__dsLastRole`，
                //   由回答尾部「本次参考」行透明展示 ⇒ 用户能看到"这次为什么以这个角色作答"。
                var _roleInfo;
                // 【2026-10-08】判据用**纯问句**（不含附件正文）—— 附件里的"代码/最新/图片"字样
                //   会把角色、思考档、联网、规范段四处同时带偏（见 _dsJudgeText）
                if (typeof window.dsResolveRole === 'function') _roleInfo = window.dsResolveRole(_dsJudgeText(finalText));
                else if (typeof window.dsGetRole === 'function') _roleInfo = window.dsGetRole();
                else _roleInfo = { key: 'default', label: '通用', prompt: '', isCode: false };
                if (!_roleInfo || !_roleInfo.key) _roleInfo = { key: 'default', label: '通用', prompt: '', isCode: false };
                var selectedRole = _roleInfo.key;
                try {
                    if (_roleInfo.auto) {
                        window.__dsLastRole = { key: _roleInfo.key, label: _roleInfo.label, reason: _roleInfo.reason || '' };
                    }
                } catch (e) {}
                // ⚠️ auto 解析后 selectedRole 可能是 'frontend'（代码类问题）⇒ 下面 _isCodeRole 判定照常生效
                // 【v3.76】代码角色标记：下面凡是"铁路业务规范"类的注入都对它跳过 ——
                //   它是写代码用的角色，注入"以本地铁路数据为权威""人机环管""问题性质 A/B/C/红线"
                //   既浪费 token，也会让模型把业务框架套进代码回答里。
                var _isCodeRole = (selectedRole === 'frontend');
                var rolePrompt = '';
                if (window.ROLE_PROMPTS && window.ROLE_PROMPTS[selectedRole]) {
                    rolePrompt = window.ROLE_PROMPTS[selectedRole] + '\n\n';
                    // 专业角色统一追加「输出规范」（结构 / 引用格式 / 数据口径 / 建议可执行 / 跨专业 / 篇幅）
                    if (!_isCodeRole && window.ROLE_OUTPUT_NORMS) {
                        rolePrompt += window.ROLE_OUTPUT_NORMS + '\n\n';
                    }
                }

                // ---- 4.5 长期记忆 ----
                // 【优化·修复失效】此前用 `typeof extractFacts === 'function'` 判断，但这三个函数定义在
                //   Part B IIFE（本文件 4394 行之后）且从未挂到 window，而本段在 Part A IIFE 内
                //   ⇒ 该判断**恒为 false** ⇒ 长期记忆从未存储、从未注入（设置面板的「长期记忆」开关
                //   与「清空」按钮因此一直是空转）。改为通过 window 调用 Part B 导出的接口。
                //   同时不再注入"最新 66 条"，只取与本轮问题相关的少量条目（见 getRelevantMemories）。
                var memoryText = '';
                try {
                    if (typeof window.dsExtractFacts === 'function' && typeof window.dsGetRelevantMemories === 'function') {
                        var newFacts = window.dsExtractFacts(finalText);
                        if (newFacts.length && typeof window.dsAddMemory === 'function') {
                            newFacts.forEach(function (f) { window.dsAddMemory(f); });
                        }
                        var memories = window.dsGetRelevantMemories(finalText, { exclude: newFacts, limit: 5 });
                        if (memories.length) {
                            memoryText = '【用户长期偏好】（仅在本轮问题相关时参考，不要主动复述或逐条罗列）\n'
                                + memories.map(function (m) { return '• ' + m.fact; }).join('\n') + '\n\n';
                        }
                    }
                } catch (e) {}

                // ---- 4.6 系统提示 ----
                var _tempSrc = window._tempDataSrc || null;
                var _dataSrc = _tempSrc || _sessionDataSource || DS_DEFAULT_CFG;   // v3.76：默认值统一到 DS_DEFAULT_CFG
                // 【v3.76】代码角色（frontend）**不再注入铁路本地资料**：写代码时把规章/台账塞进提示词
                //   既无用又费 token（此前只排除了准则，资料仍会进 —— 本次审计发现的遗留）。
                //   等价于该角色下"关联数据全不选"，不影响其它角色。
                // 【2026-10-08 用户报「智能对话无法引用本地数据 / 检测不到数据」】这里原来有两处会**静默**掐掉本地资料：
                //   ① **白名单不全**：只认 rules/issue/handbook/wrAll/phone/diary，而注入侧（dsBuildSystemPrompt 的
                //      `_kbSrcs`）还支持 cases(法规案例汇编) / accidents(事故案例) / materials(写作资料库) /
                //      reports(历史报告) ⇒ 只勾了这几项时 hasAnySource=false ⇒ **一条都不检索**（而输入框上方的提示
                //      还显示"本次将使用…"，界面承诺与实际不符）。
                //   ② **`&& !_isCodeRole` 一刀切**：自动角色只要把问题判成"前端/代码"，本地资料就整段不注入、**且不告知**
                //      —— 而旧的角色判据把"帮我写 / 写一个 / 生成一个 / 页面 / 布局"都当代码特征，像
                //      "帮我写一份整改通知书""写一个检查方案"这类**业务刚需**就会命中 ⇒ 用户感知正是"检测不到数据"。
                //   现改为：**代码角色同样允许引用本地资料**（依据本地制度/台账写材料是主要用法）。
                //   对代码角色保留 v3.76 的本意 —— 不追加"业务输出规范"（见上方 `_isCodeRole` 分支），只省那一部分。
                //   键名与注入侧对齐（含旧键 wrAll）。
                var _srcKeys = ['rules', 'issue', 'handbook', 'wrAll', 'phone', 'diary',
                                'cases', 'accidents', 'materials', 'reports'];
                var hasAnySource = _srcKeys.some(function (k) { return !!_dataSrc[k]; });
                // 【优化·速度】寒暄 / 元问题（"你好""你能做什么"）跳过本地检索：
                //   复用「思考模式自动档」的同一判定函数（dsAutoThinkingEffort 返回 'off' 的那一批），
                //   让"不必思考"与"不必检索"两个决定保持一致；省掉一次 KB.ensure 等待与约 4.5KB 注入。
                var _trivialQ = false;
                try {
                    _trivialQ = (typeof window.dsAutoThinkingEffort === 'function')
                        && window.dsAutoThinkingEffort(_dsJudgeText(finalText)) === 'off';
                } catch (e) {}
                // 【优化·准确性】对话温度：安监问答以"有据可依、口径一致"为先，0.7 偏高会带来
                //   措辞漂移与添油加醋（表现为引用不严、结论发散、废话变多）。默认 0.35；
                //   代码角色给 0.2（要确定性）；风险研判模块另有 0.3，不在本次范围内。
                var _chatTemp = _isCodeRole ? 0.2 : 0.35;
                // 【P1 指标】本轮度量的起点放在这里 —— 它把 KB 准备等待也算进去，
                //   那正是用户感知的"点发送到出字"的时间（而不只是网络往返）。
                //   记录在 finally 里落盘（见 dsRecordAiMetrics）。
                var _turnMetrics = {
                    t0: (window.performance && performance.now) ? performance.now() : Date.now(),
                    ts: Date.now(),
                    role: selectedRole,
                    model: dsModel
                };
                // 【v3.74 卡滞修复】本地资料准备失败**不再中断对话**：降级为"无资料模式"继续回答。
                //   这样资料侧的任何异常都不会把 dsStreaming 卡在 true（原先异常会跳过 finally 复位）。
                var baseSystem;
                try {
                    if (!hasAnySource) {
                        // 【2026-10-08】把"为什么没用本地资料"如实记下来，供气泡尾行显示（原来只有 null ⇒ 尾行误报成
                        //   "寒暄/闲聊类问题不检索"，把"没启用数据源"或"代码角色"都说成寒暄，用户无从判断）。
                        try { window.__dsLastSrcs = { srcs: [], reason: _isCodeRole ? 'codeRole' : 'none' }; } catch (e) {}
                        baseSystem = '你是一名铁路安全监察智能助手，回答请使用中文，条理清晰。';
                    } else {
                        baseSystem = await dsBuildSystemPrompt(finalText, _dataSrc, { skipData: _trivialQ });
                        // 寒暄类：dsBuildSystemPrompt 内部会落 __dsLastSrcs（srcs:[]），这里覆盖为准确原因
                        if (_trivialQ) { try { window.__dsLastSrcs = { srcs: [], reason: 'trivial' }; } catch (e) {} }
                    }
                } catch (_prepErr) {
                    console.warn('[dsRunStream] 本地资料准备失败，降级为无资料模式：', _prepErr && _prepErr.message);
                    baseSystem = '你是一名铁路安全监察智能助手，回答请使用中文，条理清晰。';
                }
                clearTimeout(_prepHintTimer);   // 准备结束：撤掉"正在准备本地资料"的延时提示
                // 【优化·P0 前缀稳定化】拼装顺序改为「稳定段在前、变量段在后」。
                //   依据：DeepSeek 上下文硬盘缓存默认开启，但命中要求**完整匹配缓存前缀单元**
                //   （官方文档：前缀单元 = 用户输入结束位置 / 模型输出结束位置 / 系统检测到的公共前缀）。
                //   原顺序把"长期记忆 → KB 本地资料"这两段**每轮都变**的内容排在第 2、3 位，
                //   于是两轮不同提问之间可复用的公共前缀只剩开头的角色段（≈470 字）。
                //   现改为：角色 → 输出规范 → 专业准则 → 风格约束（稳定段，≈1800 字 ≈1100 tokens）
                //          → 记忆 → KB 资料 → 媒体规范 → 日期 → 模块上下文（变量段）
                //          → 角色回扣（80 字短尾，满足"末位约束力"且不影响缓存前缀）
                //   ⇒ 每一轮都能命中稳定段：首字更快、输入更省。
                var systemPrompt = rolePrompt;   // 稳定段①：角色全文 + ROLE_OUTPUT_NORMS
                // 通用专业准则与知识更新指引：对所有角色/默认生效，强化专业深度、准确性与时效
                var proRoleGuidelines = '\n\n【专业回答准则】\n' +
                  '1. 知识分层：①铁路业务规章/检查信息/手册以本地数据库为权威源，必须优先检索并引用真实条款与案例；②涉及最新政策、标准修订、外部新闻、天气行情等时效信息，联网时直接引用检索结果并标注日期与来源；③本地未覆盖且未联网时，明确告知“需联网核实”，严禁臆造。\n' +
                  '2. 准确性：区分【已确认·基于本地数据】【推断】【待核实】；引用规章须注明名称与条款出处，禁止编造编号、数据或案例。\n' +
                  '3. 专业性：使用铁路行业规范术语；多专业问题从“人、机、环、管”与风险分级（高/中/低）视角结构化作答。';
                // 【v3.76】代码角色（frontend）不追加铁路业务准则（同上：避免业务框架污染代码任务）
                if (!_isCodeRole) systemPrompt += proRoleGuidelines;
                // 稳定段③：废话抑制硬约束。原先放在最末尾，现前移到稳定段以吃满缓存；
                //   "少废话"的末位约束力由末尾的角色回扣承担（实测风格漂移的主因是长资料稀释角色，
                //   而不是这条的位置）。
                try { if (window.CHAT_STYLE_NORMS) systemPrompt += '\n\n' + window.CHAT_STYLE_NORMS; } catch (e) {}
                // ══ 变量段开始：以下内容每轮 / 每问都可能变化，必须排在稳定段之后 ══
                //   注意必须带 '\n\n' 分隔：稳定段末尾（风格约束）没有结尾换行，
                //   直接拼接会让"不要注水。"与下一段首句粘成一行。
                if (memoryText) systemPrompt += '\n\n' + memoryText;
                systemPrompt += '\n\n' + baseSystem;
                // 【P2 长会话摘要锚点】滑出 10 条窗口的较早轮次 → 压成一段"前文要点"。
                //   只加不替换：窗口内的消息照旧完整发送，这段只是补回被挤掉的更早上下文。
                try {
                    var _older = _dsBuildOlderSummary(_reqHistRaw);
                    if (_older) { systemPrompt += '\n\n' + _older; _turnMetrics.hasOlderSummary = true; }
                } catch (e) {}
                // 媒体输出规范：用户问图片/视频/音乐时，引导模型给出可内嵌显示的直链（而非仅给网页地址）
                try {
                    if (/图片|照片|配图|插图|图库|海报|视频|MV|音乐|歌曲|音频|听歌|铃声|封面|素材/i.test(_dsJudgeText(finalText))) {
                        systemPrompt += '\n\n【图片/音视频输出规范】\n' +
                            '当用户要图片、视频或音乐时，除给出页面地址外，还必须给出可直接显示/播放的媒体直链：\n' +
                            '· 图片直链：以 .jpg/.jpeg/.png/.webp/.gif 结尾（如 https://images.unsplash.com/photo-xxx?w=800），单独占一行；\n' +
                            '· 视频直链：以 .mp4/.webm/.mov 结尾，单独占一行；音频直链：以 .mp3/.m4a/.wav/.flac 结尾，单独占一行。\n' +
                            '· 直链必须写完整（带 https:// 前缀）且真实可用；不确定时不要编造，如实说明「该站点不提供直链，已给出页面链接，点击可在浏览器打开」。\n' +
                            '· 只有直链才能在对话里自动渲染成图片或播放器；仅给网页链接时前端只能显示可点击的链接卡片。';
                    }
                } catch (e) {}
                // 【2026-10-07 用户反馈】清单 / 表格类请求的**专项密度规范**（与"媒体输出规范"同法：按请求关键词注入，不打扰其它问答）。
                //   为什么单列一条：这类回答的问题**不是"没有纪律"**，而是每格塞太多 ——
                //   实测输出的检查清单里，"合格判定"格写成了案例故事（"6月未统一安排人员、问题全部照抄日常检查→不合格"），
                //   每行重复"据联网检索/条号待核实"，依据列还夹解释。用户要的是**能拿去逐项核对的表**，不是说明文。
                try {
                    if (/清单|检查表|项点|表格|检查项|对照表|检查内容/i.test(_dsJudgeText(finalText))) {
                        systemPrompt += '\n\n【清单 / 表格输出规范】\n' +
                            '· 主体只给表：不要表前的结论大段，表后最多一行说明。\n' +
                            '· 每格**一句话、可核对**：判定标准写成能当场对照判"是/否"的判据（如"4 路门限均已设置"），' +
                            '不要把发现过程、案例细节写进格子。\n' +
                            '· 引用取**最短形式**：依据列只写「规章名 + 条号」或「单位 + 日期」，解释性文字去掉。\n' +
                            '· 同类说明**只写一次**：统一的免责或待核实提示放表格上方/下方一行' +
                            '（如"未标条号者以现行发文为准"），不要每行重复"待核实"。\n' +
                            '· 列数克制：超过 6 列时考虑合并或拆表；4~5 列能说清就不铺 7 列。';
                    }
                } catch (e) {}
                // 注入当前日期：避免模型把「今天/本月/8月12日」当成年份不明而拒答
                try {
                    var _nowD = new Date();
                    var _wd = ['日','一','二','三','四','五','六'][_nowD.getDay()];
                    systemPrompt += '\n\n当前日期：' + _nowD.getFullYear() + '年' + (_nowD.getMonth() + 1) + '月' + _nowD.getDate() + '日（星期' + _wd + '）。'
                        + '用户提到「今天/昨天/本月/近期」等相对时间，以及未标注年份的日期（如「8月12日」），均按当前日期所在年份理解，不要反问年份。';
                } catch (e) {}
                // 全域统一升级：注入当前模块上下文（unified-enhancements.js 设置，未定义则无影响）
                if (window.UNIFIED_TAB_CONTEXT) systemPrompt += '\n\n' + window.UNIFIED_TAB_CONTEXT;
                // 【优化·角色贴合】末尾只保留一句角色回扣。角色提示词在 system 最前面，
                //   中间隔着可达 4.5KB 的本地资料，越靠后的指令约束力越强，末尾回扣一句
                //   即可抵住长资料对"角色特征"的稀释。（风格硬约束已前移到稳定段以吃缓存。）
                try {
                    if (typeof window.dsRoleRecall === 'function') systemPrompt += '\n\n' + window.dsRoleRecall(_roleInfo);
                } catch (e) {}
                if (_tempSrc) { window._tempDataSrc = null; }
                // 【P1 指标】提示词体积与历史条数：用于对照"前缀稳定化"前后缓存命中率的变化
                _turnMetrics.promptChars = systemPrompt.length;
                _turnMetrics.histMsgs = _reqHist.length;
                // 【P2 指标】本轮 KB 注入统计（注入字数 / 过滤掉与截断掉的块数）。
                //   ⚠️ __kbLastStats 是全局的，上一轮的值会残留 ⇒ 必须用时间戳判定"是不是本轮产生的"，
                //   否则未走 KB 的轮次（寒暄 skipData / 无数据源）会把上一轮的数字记到自己头上。
                try {
                    var _kbs = window.__kbLastStats;
                    if (_kbs && _kbs.ts >= _turnMetrics.ts) {
                        _turnMetrics.kbInjected = _kbs.injected;
                        _turnMetrics.kbDropped = _kbs.dropped;
                        _turnMetrics.kbTruncated = _kbs.truncated;
                    }
                } catch (e) {}

                // 【v3.74 卡滞修复】历史改用插入空助手气泡**之前**的快照（_reqHist）：
                //   否则会把那条空的 assistant 也发给模型（原实现靠"先建 messages、再 push 气泡"的顺序规避）。
                var messages = [
                    { role: 'system', content: systemPrompt },
                    ..._reqHist
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
                // 注：【v3.74 卡滞修复】空助手气泡、按钮「停止」态、AbortController 已在进入本节**之前**
                //   （即 dsBuildSystemPrompt 这些重活之前）设置完毕，这里不再重复；状态复位仍由下方 finally 统一负责。
                try {
                    // P8 修复：整体请求超时（默认 120s），超时主动 abort 并提示，避免无限挂起
                    var _reqTimeoutMs = 120000;
                    var _reqTimer = setTimeout(function() {
                        if (window._dsAbortController) {
                            try { window._dsAbortController.abort(new DOMException('请求超时', 'TimeoutError')); } catch (e) {}
                        }
                    }, _reqTimeoutMs);
                    var isFrontendRole = selectedRole === 'frontend';
                    // 【2026-10-08】① 判据文本换成纯问句（附件正文会误触发）；
                    //   ② 与 dsResolveRole 的新口径保持一致：业务性"帮我写XX"不再算代码请求
                    //      （旧正则含"写一个|生成一个|帮我写"，会让 max_tokens 因为一句业务话跳到 16384）。
                    var isCodeRequest = /代码|程序|脚本|html|css|javascript|\bjs\b|网页|前端|组件|函数|接口|报错|调试|正则|数据库|\bsql\b|python|java|c\+\+|编程/i.test(_dsJudgeText(finalText));
                    // 【P1 输出完整性】平台默认输出上限：非思考 8K、思考 64K（官方 Chat Completions 文档）。
                    //   原先非思考只给 4096 —— 低于平台默认一倍，长报告（月度/专项）容易被静默截断；
                    //   按量计费只算实际输出 token，上限抬高不产生额外费用，只是不再"提前掐断"。
                    var maxTokens = (isFrontendRole || isCodeRequest) ? 16384 : 8192;
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
                        // ⚠️ 顺序敏感：hasUrl 必须排在 bizDomain 之前判定。
                        // 反例（v3.64 及以前的实际缺陷）：「这个网页里的规章帮我看看 www.xxx.com」同时命中
                        // bizDomain 的「规章」→ 先判 bizDomain 直接 return false → **链接根本没被读取，
                        // 但 AI 照常作答**，用户以为它读过了。含链接时必须联网，与话题是否属业务域无关。
                        if (hasUrl.test(q)) return true;            // 含链接/网址：最高优先级，强制联网读取网页内容
                        if (bizDomain.test(q)) return false;       // 业务域问题一律走本地数据源，不自动联网
                        if (freshness.test(q)) return true;
                        if (explicitWeb.test(q)) return true;
                        return realtime.test(q);
                    })(_dsJudgeText(finalText));   // 【2026-10-08】用纯问句判定，避免附件正文里的"最新/今日"误触发联网
                    var useWebSearch = (localStorage.getItem('ds_web_search') === '1') || forceWs || autoWs;
                    // 【v4.22】记录本轮联网状态（供回答尾部「本次参考」显示联网维度；searches 在拿到响应后补写）
                    //   来源：开关 / 天气失败强制 / 自动判定（realtime=问题被判为需要实时信息）
                    try {
                        window.__dsLastWs = useWebSearch
                            ? { on: true, via: (localStorage.getItem('ds_web_search') === '1') ? 'switch' : (forceWs ? 'force' : 'auto'), searches: 0 }
                            : { on: false };
                    } catch (e) {}
                    // 「按需检索」判定：联网能力开启 ≠ 必须联网检索。只有**问题本身需要实时信息**时才强制检索、
                    // 才在零检索时告警；问候 / 闲聊 / 写作 / 代码 / 常识 / 资料分析等问题即便联网开关开着也直接作答，
                    // 避免「你好」也被逼着搜一次（既拖慢响应，也让用户觉得莫名其妙）。
                    var _dsRealtimeQ = (function(_q) {
                        var q = String(_q || '').trim();
                        if (!q) return false;
                        // 整句即为问候/寒暄/测试时才排除（用 $ 锚定，避免「你好，帮我查下今天新闻」被误伤）
                        if (/^(你好|您好|hi|hello|hey|在吗|在么|早上好|中午好|下午好|晚上好|谢谢|感谢|多谢|好的|收到|明白|ok|okay|测试|你是谁|你叫什么|你能做什么|你会做什么)[\s,，.。!！?？~～、]*$/i.test(q)) return false;
                        // 业务域问题走本地数据源（与 autoWs 一致）；但明确问「最新/修订/现行有效」时仍要联网核实
                        if (/检查信息|规章|条款|隐患|典型问题|安监|监察|工务|电务|供电|车务|机务|车辆|通信|房建|客运|货运|日志|写实|报告|手册|项点|台账|考勤|通讯录|资料库|模板|问题库/.test(q)
                            && !/最新|修订|现行有效|废止|新规|新版/.test(q)) return false;
                        var realtime = /新闻|头条|时事|热点|舆情|股价|行情|汇率|油价|金价|涨跌|发布会|上映|比分|赛程|夺冠|地震|台风|天气|气温|预报|今日|今天|昨天|本周|本月|最新|近期|刚刚|实时|进展|动态|政策|新规|修订|现行有效|废止|上线/;
                        var explicit = /搜一下|搜一搜|搜索一下|查一下|查一查|联网|上网|网上|百度|谷歌/;
                        return realtime.test(q) || explicit.test(q);
                    })(_dsJudgeText(finalText));   // 【2026-10-08】同上：判据用纯问句
                    // ── 联网通道说明（2026-09 官方文档 + 实测）──────────────────────────────
                    // ① Anthropic 兼容层 POST /anthropic/v1/messages —— DeepSeek 唯一真正执行「服务端联网检索」的通道。
                    //    声明 tools:[{type:'web_search_20250305', name:'web_search'}]，检索在服务端完成，
                    //    响应流回吐 server_tool_use / web_search_tool_result 内容块（官方兼容表均标为「支持」）。
                    //    注意：工具类型必须写 web_search_20250305，写 server_tool 会被 400 拒绝。
                    // ② Responses API POST /responses —— 官方《Responses API 兼容性明细》的 Tools 表把
                    //    web_search / file_search / code_interpreter / computer_use / mcp 一律列为「忽略」，
                    //    即请求返回 200 但服务端根本不执行检索（create-response 页仍宣称支持，属遗留文案）。
                    //    这正是此前「联网开着却零检索」的根因，故它只作非 DeepSeek 供应商的备选通道。
                    // 两条通道均支持图片（Anthropic 走 image 内容块、Responses 走 input_image），故不再因图片放弃联网。
                    // 联网证据（检索次数 / 检索词 / 实际通道）——无检索时前端明确告警，杜绝「假成功」
                    dsHistory[assistantIdx].web = null;
                    // 告知模型自身联网状态：联网时提示其优先检索；未联网时引导用户开启，而不是空口拒答
                    if (useWebSearch) {
                        // 关键纪律：联网能力「已开启」不等于「已检索到」。若把两者混为一谈，模型会把内部旧知识
                        // 包装成「今日热点」（曾出现把一个月前的日期当作今天的事故）。故此处按「有无真实检索结果」分档约束。
                        systemPrompt += '\n\n【联网搜索已启用】本次会话你具备服务端联网检索能力（web_search 工具）。'
                            + '注意：这是「可用能力」而不是「必须动作」——**是否检索由你按问题需要自行判断**，不要为了走流程而检索。\n'
                            + '一、按需检索的判断标准：\n'
                            + '1) 需要检索：问题涉及新闻时事、天气、价格行情、政策法规最新动态、赛事结果、产品/软件最新版本、'
                            + '近期刚发生的事件等时效性信息，或用户明确要求「搜一下 / 查一下 / 最新」；\n'
                            + '2) 不需要检索（直接作答，不要调用检索）：打招呼、寒暄、感谢、闲聊，写作润色、翻译、改写，'
                            + '代码编写与解释，逻辑推理与计算，对用户已上传资料或上文对话内容的分析总结，以及稳定不变的常识性问题'
                            + '（如「什么是安全帽」「三级安全教育指什么」）；'
                            // 【v4.23 用户口径修正】区分「事实」与「理论」：本单位事实（台账/本单位案例/日志/电话/
                            //   本单位规章收录版本）外网查不到 ⇒ 不要为查这些去联网；但「规定/标准/理论依据/最新政策」
                            //   层面**可以且应该联网补充**。v4.22 曾写成"业务问题尤其不要检索"，过于绝对，现修正。
                            + '**本单位事实类内容不要检索**（检查信息/台账数据、本单位事故案例、工作日志、应急电话、'
                            + '本单位规章收录版本）—— 外网查不到本单位口径，这类内容只能来自【本地资料】；'
                            + '但「规定/标准/理论依据/最新政策」层面**可以联网补充**（分工见第三部分）；\n'
                            + '3) 一次提问检索 0～2 次足够，不要反复检索凑次数；确认已掌握所需信息后立即作答。\n'
                            + '二、时效纪律（无论是否检索，必须逐条遵守）：\n'
                            + '4) 只有当你确实看到了检索结果时，才可以标注「据联网检索」并给出真实来源；\n'
                            + '5) 若你判断无需检索、或未取得检索结果，禁止使用「今日/今天/刚刚/最新/近期」等时效词去描述内部知识；\n'
                            + '6) 若问题确实需要实时信息但未取得检索结果，必须明确说明「本次未取得实时检索结果」，'
                            + '并把内容标注为「模型内部知识（可能已过时）」；\n'
                            + '7) 严禁把内部知识或旧信息包装成「今日热点 / 最新消息」——这是最严重的错误，会导致用户误判；\n'
                            + '8) 严禁声称「我没有实时联网能力」：你已具备该能力，需要时直接调用即可。\n'
                            // 【v4.22 用户要求·本地×联网组合检查】三、与【本地资料】的配合。
                            //   补齐前这里两段提示词**互不知情**（本地段不知联网、联网段不知本地），组合时全靠模型自由发挥：
                            //   实测表现为「可能为业务问题联网」「本地旧条款与联网新规冲突时随意取舍」「来源混为一谈」。
                            //   下面四条把口径定死（分工 / 冲突 / 来源标注 / 表述顺序）。
                            + '三、与【本地资料】的配合（本地资料与联网能力同时存在时的口径）：\n'
                            // 【v4.23 用户口径】用户提出"联网只负责理论、本地数据负责举证"—— 比 v4.22 的
                            //   "业务问题不联网"准确得多：本地 = 可追溯的**证据**（本单位事实），
                            //   联网 = 外部**理论依据**（规定/标准/最新政策）。两者互补，不是二选一。
                            + '9) 角色分工（**核心原则**）：**本地资料 = 举证**（本单位事实，有出处、可追溯）；'
                            + '**联网 = 理论**（通用规范、行业标准、外部做法、最新政策动态）。\n'
                            + '   · 凡属本单位事实（台账条数、本单位案例、日志、电话、本单位规章收录版本）**只能来自本地资料**，'
                            + '不得用联网结果代替，也不要为查这些去联网；\n'
                            + '   · 凡属规定/标准/理论依据/最新要求，**可以用联网补充外部规范与政策**'
                            + '（这正是联网的价值，不要因为问题涉及业务就完全放弃联网）；\n'
                            + '   · 结论要**两者都用上**：只给理论不给本单位实际，或只给本地数据不给依据，都算不完整。\n'
                            + '10) 冲突：涉及「条款/文件的现行有效性」，**以联网最新为准**，并明确说明'
                            + '「本地库收录版本可能未更新，请以现行有效文件为准」；'
                            + '涉及本单位事实（数据、案例、日志）**以本地为准**（这些联网不可能比本地更准）。\n'
                            + '11) 来源必须分清：本地举证标注「规章制度：XXX」「检查信息：XXX（共 N 条）」等；'
                            + '理论/外部依据标注「据联网检索」或「通用规范」；严禁混成一段、让用户无法分辨依据来自哪里。\n'
                            + '12) 表述结构（推荐）：**先给理论/规定依据，再用本地数据举证本单位实际情况**。'
                            + '例如：「按规定应……（依据：XX 规范，据联网检索）。本单位近一年检查信息中此类问题共 N 条，'
                            + '典型如……（检查信息：XXX）」。';
                        // 本轮提问里带了具体链接 → 追加「必须真读该链接」的硬约束。
                        // 动机：读到内容时模型会正确引用；**读不到时若不明确禁止，模型会顺着域名猜内容**，
                        // 用户无法分辨真伪——这种「看起来读了其实没读」的危害远大于直接承认读不到。
                        // 链接提取复用渲染层同一套口径（window.dsExtractLinks ↔ DS_LINK_CHUNK），
                        // 保证「气泡里渲染成链接的」与「要求模型去读的」是同一批。
                        var _turnLinks = (typeof window.dsExtractLinks === 'function') ? window.dsExtractLinks(finalText) : [];
                        if (_turnLinks.length) {
                            systemPrompt += '\n\n【本轮用户提供了链接，必须真实读取】用户在提问中给出了以下链接：\n'
                                + _turnLinks.map(function (u, i) { return '  ' + (i + 1) + '. ' + u; }).join('\n') + '\n'
                                + '9) 必须先检索并阅读该链接的实际内容（可用链接本身、或其域名/标题/关键信息作为检索词），再作答；\n'
                                + '10) 回答要基于该链接的真实内容逐点回应，不要泛泛而谈或绕开链接谈常识；\n'
                                + '11) **若检索不到该链接的内容**，必须明确回答「未能读取到该链接的内容」，'
                                + '并给出替代办法（如请用户把网页正文粘贴过来）；'
                                + '**严禁根据域名、URL 中的关键词去猜测或编造网页内容**——这比读不到更糟；\n'
                                + '12) 引用链接内容时标注来源，方便用户核对。';
                        }
                        // 【2026-09-29 链接抓取增强·第 1 层】**链接预读**：真的把这个网址读一次，正文摘录并入 system。
                        //   治的是老毛病：服务端"按关键词检索"≠ 读该页，模型读不到时倾向顺着域名猜内容。
                        //   零新依赖、零新域名（不动 CSP）；失败如实降级为"未预读"，由上面 9~12 条纪律兜底。
                        if (_turnLinks.length && typeof window.dsLinkPreRead === 'function') {
                            window.__dsLinkRead = null;
                            try { if (typeof window.dsAppendMsg === 'function') window.dsAppendMsg('system', '🔗 正在读取链接内容…'); } catch (e) {}
                            try {
                                var _lr = await window.dsLinkPreRead(_turnLinks, finalText);
                                window.__dsLinkRead = _lr || { ok: false, reason: 'null' };
                                if (_lr && _lr.ok && _lr.digest) {
                                    systemPrompt += '\n\n【链接正文已预读（下列内容由联网通道实际读取，可直接引用）】\n' + _lr.digest
                                        + '\n（引用时请用【来源1】【来源2】……标注出处，方便用户核对；'
                                        + '与预读冲突时以预读为准；预读未覆盖的部分，不确定就说不确定，**不要编造**。）';
                                }
                                try {
                                    if (typeof window.dsAppendMsg === 'function') {
                                        window.dsAppendMsg('system', (_lr && _lr.ok)
                                            ? ('🔗 已读取链接内容（' + String((_lr && _lr.digest) || '').length + ' 字' + (_lr.fromCache ? '，命中缓存' : '') + '），已并入本轮回答依据')
                                            : '🔗 链接未能读取：已要求模型如实说明，不得猜测网页内容');
                                    }
                                } catch (e) {}
                            } catch (e2) {
                                window.__dsLinkRead = { ok: false, reason: String((e2 && e2.message) || e2) };
                            }
                        }
                    } else {
                        try {
                            if (messages[0] && messages[0].role === 'system') {
                                var _noWebTip = '\n\n【提示】本次未启用联网搜索。若用户询问需要实时联网才能回答的信息，请简要说明并告知：点击输入框左下方的 🌐 地球按钮即可开启联网搜索，然后重新提问。';
                                messages[0].content += _noWebTip;
                                systemPrompt += _noWebTip;
                            }
                        } catch (e) {}
                    }
                    // 告知模型自身视觉能力状态：避免模型在被问「能否识别图片」时凭通用认知谎称不能。
                    // ⚠️ 注入时机收敛（用户反馈修正）：只有「本轮确实带了图片」或「用户问到看图能力」时才写这段。
                    //    否则普通对话（例如只说「你好」）里模型会照着这段主动声明
                    //    「我当前为纯文本模型，不具备图像识别能力，看图请在设置里切换…」——答非所问，还让用户以为功能坏了。
                    // 注意：messages[0].content 只走 chat/completions；联网分支发的是 instructions/system(systemPrompt)，
                    // 故两处都要写，否则联网时模型看不到这段能力声明。
                    try {
                        var _hasImgThisTurn = !!visionUserContent;
                        var _asksVision = /看图|看懂图|识别图|图片|照片|截图|图像|影像|能不能看|能看吗|看得见|vision/i.test(String(finalText || ''));
                        if (_hasImgThisTurn || _asksVision) {
                            var _visionNote = '';
                            if (window.dsModelSupportsVision && window.dsModelSupportsVision(dsModel)) {
                                _visionNote = '\n\n【图像理解已启用】你当前使用的模型原生支持多模态，用户通过「上传附件」传入的图片你可以直接查看、识别并分析。'
                                    + '当用户上传图片（如现场设备照片、仪表读数、隐患照片、图纸等）并提问时，请基于图片内容作答，做到有据可依、不臆测图中不存在的细节；'
                                    + '严禁声称"我无法识别图像""看不了图片"。若图片本身模糊、遮挡或信息不足，请明确指出哪一处看不清，并说明需要补拍什么。';
                            } else {
                                // 带上实际模型名：便于用户/开发者一眼看出前端识别到的模型是什么，快速定位配置问题
                                _visionNote = '\n\n【图像理解未启用】你当前使用的模型是「' + String(dsModel || '未知') + '」，该模型不具备图像识别能力。'
                                    + '若用户上传图片或询问能否识别图片，请如实说明当前使用的模型（' + String(dsModel || '未知') + '）无法看图，'
                                    + '并引导：在「设置 → API 配置 → ＋新增模型」中把模型切换为 deepseek-flash（DeepSeek V4.1 Flash，原生支持图像识别）后即可看图。'
                                    + '注意：仅在本轮用户确实上传了图片、或明确询问看图能力时才这样说明；其他话题下不要主动提及自己的图像能力。';
                            }
                            if (_visionNote) {
                                systemPrompt += _visionNote;
                                if (messages[0] && messages[0].role === 'system') messages[0].content += _visionNote;
                            }
                        }
                    } catch (e) {}
                    // DeepSeek 能力参数（仅对 DeepSeek 端点生效，其余供应商忽略以免报错）
                    var _isV4 = /deepseek/i.test(dsModel) || /api\.deepseek\.com/i.test(dsApiUrl);
                    // 思考模式三档（v3.62 起）：auto 按问题自动分级 / on 始终开启 / off 始终关闭。
                    // 自动档复用 dsAutoThinkingEffort，与 v3.58「联网按需检索」同一套思路——能力可用 ≠ 每次跑满。
                    var _thinkLevel = (typeof window.dsThinkingLevel === 'function') ? window.dsThinkingLevel() : 'auto';
                    var thinkingOn = _isV4 && _thinkLevel !== 'off';
                    var _thinkEffort = 'high';
                    if (_isV4 && _thinkLevel === 'auto' && typeof window.dsAutoThinkingEffort === 'function') {
                        _thinkEffort = window.dsAutoThinkingEffort(_dsJudgeText(finalText));
                        if (_thinkEffort === 'off') thinkingOn = false;   // 问候/寒暄类：连思考都不开，最快
                    }
                    // Tool Calls：工具 schema/执行器就绪即默认挂载，不再依赖设置开关——
                    // 是否真正调用由模型自行判断（它完全可以不调）；前端再多一层开关只会造成
                    // 「智能体能查天气、智能对话查不了」的能力割裂。
                    // D1：保留可用性守卫——agent-core 未加载时降级为普通对话，避免发送 tools:null 导致 400 或工具静默失效
                    var _toolsReady = (typeof window._agentToolsParam === 'function') && (typeof window._agentExecuteTool === 'function');
                    // 【2026-09-21 能力修复】原先 `_useTools = _isV4 && _toolsReady` —— 只有"模型名含 deepseek 或
                    //   端点 api.deepseek.com"才挂 tools；用豆包等模型时**静默不挂**（无日志、无界面提示），
                    //   用户看到的就是"智能体/工具根本不上场"。现在任何 OpenAI 兼容端点都先挂 tools；
                    //   若端点不支持 function calling（400），下面会自动去掉 tools 重试一次并记住本机标记。
                    var _toolsUnsupported = false;
                    try { _toolsUnsupported = localStorage.getItem('ds_tools_unsupported') === '1'; } catch (e) {}
                    var _useTools = _toolsReady && !_toolsUnsupported;
                    var _toolsDegradedNote = '';
                    window.__dsLastTurnUsedTools = false;   // 供语义缓存判断"本轮用过工具 → 不缓存"
                    if (!_useTools) {
                        // 修复②：能力边界**如实告诉模型**，否则它会臆测检索机制（实测它把本地 KB 注入
                        // 说成"平台侧检索"，并给出"请触发一次新检索"这类错误操作建议）
                        try {
                            if (messages[0] && messages[0].role === 'system') {
                                messages[0].content += '\n\n【能力说明】本轮未提供本地数据查询工具（tools）。'
                                    + (_toolsUnsupported ? '（原因：本机记录当前模型不支持 function calling）' : '')
                                    + '若用户要求按条件精确统计/查询本地台账，请如实说明"这一轮我没有查询工具"，'
                                    + '并建议在输入框直接用「/agent 任务」触发本地工具精确查询（或改用支持工具调用的模型）；'
                                    + '不要猜测、不要描述检索/注入机制，也不要声称"检索由平台侧完成"。';
                            }
                        } catch (e) {}
                    }
                    // 【2026-10-08 体检修复·最大单点节省】工具清单改为**按本轮问题召回**（原来每轮全量 23 个）。
                    //   全量 schema ≈ 20~30KB（≈1~1.5 万 token），且"工具结果回灌"的后续轮也照带
                    //   ⇒ 这是"首字慢 + 烧 token"的最大固定开销。
                    //   `_agentToolsParam(文本)` 内部走 `_pickTools` 召回（智能体侧早已这么做，对话侧漏了）；
                    //   **未命中任何分组时它会返回全量**（agent-core.js:955 的全量兜底）⇒ 不会少给工具、只少给无关的。
                    //   判据文本用**用户原始问句**（不含附件正文），避免贴附件时把召回带偏（见 _dsJudgeText）。
                    // 【2026-10-09 真机实测后改进】第二个参数传**本轮角色**：代码角色(frontend)只挂最小工具集
                    //   （实测：问"帮我写一个节流函数"时角色已正确判为 frontend，却仍挂全量 23 个铁路业务工具
                    //    —— 业务意图正则全不命中 ⇒ 走"全量兜底"分支 ⇒ 白烧 token 且可能被误调用）。
                    var _toolsParamArr = _useTools ? window._agentToolsParam(_dsJudgeText(finalText), { roleKey: selectedRole }) : null;
                    // 【v3.76 审计】联网与「本地检索工具」目前**互斥**：联网走 Responses/Anthropic 通道，
                    //   请求体里 tools 只放服务端 web_search；工具需要"模型调用→前端执行→回灌"的闭环，
                    //   而联网通道的流解析器只处理 server_tool_use/web_search 结果，不处理本地工具调用。
                    //   → 因此联网时本地工具不参与（本地资料仍通过 system/instructions 注入，能力不丢）。
                    //   这里打印一条诊断日志，避免"静默降级"难以排查；界面上也有对应说明（联网菜单）。
                    if (useWebSearch && _useTools && typeof console !== 'undefined') {
                        // 【2026-10-07 用户反馈修复】级别 warn → info，并把文案改准：
                        //   ① 这是**设计取舍的说明**、不是异常 ⇒ 原来用 console.warn 在控制台显示成醒目警告，
                        //     用户误以为出错（与"静默检查更新打 warn"同类问题，一并修正）；
                        //   ② 原文案说"本地检索工具不参与"容易被读成"本地资料也不参与" —— 事实是
                        //      本地资料**仍会由系统检索后注入 system**（能力不丢），只是**不能按条件精确统计**。
                        console.info('[ds] 联网已开启：本轮只带服务端 web_search；本地资料仍会自动检索后注入（'
                            + '但不能按条件精确统计台账）。需要精确查明细：关闭联网，或用「/agent 任务」。');
                    }
                    var _toolExec = (typeof window._agentExecuteTool === 'function') ? window._agentExecuteTool : null;
                    // 思考模式会消耗推理 token，适当抬高 max_tokens 避免回答被截断
                    if (thinkingOn) maxTokens = (isFrontendRole || isCodeRequest) ? 24576 : 16384;

                    var _respEndpoints = dsResponsesUrlCandidates(dsApiUrl);
                    var responsesUrl = _respEndpoints[0];
                    var inputItems = _reqHist
                        .map(function(m) { return { role: m.role, content: (m.content || '') }; })
                        .filter(function(m) { return !!m.content; });
                    // 联网分支：系统提示词已通过 instructions 传入（服务端会插入为首条 system 消息），
                    // 此处剔除重复的 system 条目，避免同一份长提示词发送两遍（省 token，也避免指令互相干扰）。
                    if (useWebSearch) {
                        inputItems = inputItems.filter(function(m) { return m.role !== 'system'; });
                    }
                    // 联网搜索同样支持多模态：最后一条 user 若有图片块则替换为 image_url 数组
                    if (visionUserContent && inputItems.length) {
                        for (var _ii = inputItems.length - 1; _ii >= 0; _ii--) {
                            if (inputItems[_ii].role === 'user') {
                                inputItems[_ii] = { role: 'user', content: visionUserContent };
                                break;
                            }
                        }
                    }
                    // ── 通道候选编排 ──
                    // DeepSeek 官方：Anthropic 兼容层才是真正执行服务端联网检索的通道（Responses 忽略 web_search），
                    // 故官方域名下 Anthropic 优先、Responses 仅作兜底；其他供应商（OpenAI 等）则相反。
                    var _anthEndpoints = dsAnthropicUrlCandidates(dsApiUrl);
                    var _dsHost = '';
                    try { _dsHost = new URL(dsApiUrl).host.toLowerCase(); } catch (e) { _dsHost = 'api.deepseek.com'; }
                    var _isDeepSeekApi = /(^|\.)deepseek\.com$/.test(_dsHost);
                    var _wsChannels = [];
                    var _pushCh = function(kind, url) {
                        for (var _qi = 0; _qi < _wsChannels.length; _qi++) {
                            if (_wsChannels[_qi].kind === kind && _wsChannels[_qi].url === url) return;
                        }
                        _wsChannels.push({ kind: kind, url: url });
                    };
                    if (_isDeepSeekApi) {
                        _anthEndpoints.forEach(function(u) { _pushCh('anthropic', u); });
                        _respEndpoints.forEach(function(u) { _pushCh('responses', u); });
                    } else {
                        _respEndpoints.forEach(function(u) { _pushCh('responses', u); });
                        _anthEndpoints.forEach(function(u) { _pushCh('anthropic', u); });
                    }
                    // 按通道生成请求体（缓存，强制重试时复用同一份）
                    var _wsBodyCache = {};
                    var _wsBodyFor = function(kind) {
                        if (_wsBodyCache[kind]) return _wsBodyCache[kind];
                        var b;
                        if (kind === 'anthropic') {
                            // Anthropic Messages 格式：system 独立传参；messages 需 user/assistant 交替；
                            // 联网搜索用 server tool web_search_20250305（服务端执行，结果不落库、不暴露明文链接）。
                            b = {
                                model: dsModel,
                                max_tokens: maxTokens,
                                system: systemPrompt,
                                messages: dsBuildAnthropicMessages(_reqHist, visionUserContent),
                                // 【2026-10-08 体检修复·提速】max_uses 5 → 2：服务端每多检索一次就多一段往返，
                                //   而实际问答很少需要 3 次以上检索；非流式通道（dsWebSearchOnce）此前已由 3 收敛到 1，
                                //   这里与"更快回答"的目标对齐（用户仍可追问补充）。
                                tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 2 }],
                                stream: true,
                                temperature: _chatTemp
                            };
                        } else {
                            b = {
                                model: dsModel,
                                instructions: systemPrompt,
                                input: inputItems,
                                tools: [{ type: 'web_search' }],
                                reasoning: { effort: thinkingOn ? _thinkEffort : 'none' },
                                stream: true,
                                temperature: _chatTemp,
                                max_output_tokens: maxTokens
                            };
                        }
                        _wsBodyCache[kind] = b;
                        return b;
                    };
                    var resp;
                    var _respEndpointUsed = '';
                    var _wsKindUsed = '';
                    if (useWebSearch) {
                        // 依次尝试候选通道：仅当「端点/请求不被接受」（400/404/405）才换下一个；
                        // 鉴权失败(401)、余额(402)、限流(429)、5xx 换通道无意义，直接如实报错。
                        var _wsFail = null;
                        for (var _ei = 0; _ei < _wsChannels.length; _ei++) {
                            var _chTry = _wsChannels[_ei];
                            var _ep = _chTry.url;
                            var _hdrs = { 'Content-Type': 'application/json' };
                            if (_chTry.kind === 'anthropic') {
                                _hdrs['x-api-key'] = key;
                                _hdrs['anthropic-version'] = '2023-06-01';
                            } else {
                                _hdrs['Authorization'] = 'Bearer ' + key;
                            }
                            var _rTry = null;
                            try {
                                _rTry = await fetch(_ep, {
                                    method: 'POST',
                                    headers: _hdrs,
                                    body: JSON.stringify(_wsBodyFor(_chTry.kind)),
                                    signal: window._dsAbortController.signal
                                });
                            } catch (_fe) {
                                _wsFail = { status: 0, url: _ep, msg: (_fe && _fe.message) || String(_fe) };
                                continue;
                            }
                            if (_rTry.ok) { resp = _rTry; _respEndpointUsed = _ep; _wsKindUsed = _chTry.kind; _wsFail = null; break; }
                            var _btxt = '';
                            try { _btxt = await _rTry.text(); } catch (_be) {}
                            var _bmsg = '';
                            try { _bmsg = ((JSON.parse(_btxt) || {}).error || {}).message || ''; } catch (_pe) { _bmsg = String(_btxt).slice(0, 200); }
                            _wsFail = { status: _rTry.status, url: _ep, msg: _bmsg };
                            if (_rTry.status !== 404 && _rTry.status !== 405 && _rTry.status !== 400) break;
                        }
                        if (!resp) {
                            // 联网请求失败必须「响亮地失败」：绝不静默降级为普通对话，否则模型会把旧知识包装成今日热点
                            _dsStreaming = false;
                            var _failHint = (_wsFail && _wsFail.status === 404)
                                ? '（联网检索通道不被接受，已尝试：' + _wsChannels.map(function(c) { return c.url; }).join(' / ') + '）'
                                : '';
                            dsHistory[assistantIdx].content = '❌ 联网检索请求失败：HTTP ' + ((_wsFail && _wsFail.status) || '—')
                                + ' ' + ((_wsFail && _wsFail.msg) || '') + ' ' + _failHint;
                            dsHistory[assistantIdx].web = { failed: true, searches: 0, queries: [], endpoint: (_wsFail && _wsFail.url) || '', channel: '' };
                            dsRenderAll();
                            return;
                        }
                    } else {
                    // 思考模式参数：effort 由三档档位决定（自动档已按问题复杂度分级）
                    var _chatBody = { model: dsModel, messages: messages, stream: true, temperature: _chatTemp, max_tokens: maxTokens };
                    if (thinkingOn) { _chatBody.thinking = { type: 'enabled' }; _chatBody.reasoning_effort = _thinkEffort; }
                    else { _chatBody.thinking = { type: 'disabled' }; }
                    if (_useTools) { _chatBody.tools = _toolsParamArr; }   // Tool Calls：注入本地工具 schema
                    resp = await fetch(dsApiUrl, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + key },
                        body: JSON.stringify(_chatBody),
                        signal: window._dsAbortController.signal
                    });
                    }

                    if (!resp.ok) {
                        var errText = await resp.text();
                        // 【2026-09-21】端点不支持 function calling（400 且错误提到 tool/function）→ 自动降级重试一次：
                        //   去掉 tools 重新请求，并记住本机不再尝试（避免每轮都白失败一次）。降级后会在气泡里补一行说明。
                        // ⚠️ 必须限定在 chat/completions 分支（!useWebSearch）：联网走 Responses 通道，其 400 可能提到
                        //   "web_search tool"，误判会平白把请求切到另一条通道。
                        if (resp.status === 400 && !useWebSearch && _useTools && /tool|function/i.test(String(errText))) {
                            try { localStorage.setItem('ds_tools_unsupported', '1'); } catch (e) {}
                            console.warn('[ds] 当前端点不支持 function calling → 本轮自动降级重试（不带 tools）。要精确查本地台账请用 /agent：' + String(errText).slice(0, 200));
                            _useTools = false; _toolsParamArr = null;
                            _toolsDegradedNote = '（说明：当前模型不支持工具调用，本轮已降级为普通对话；要精确查本地台账请在输入框用 `/agent 任务`，或改用支持工具调用的模型）';
                            var _bodyNoTools = { model: dsModel, messages: messages, stream: true, temperature: _chatTemp, max_tokens: maxTokens };
                            if (thinkingOn) { _bodyNoTools.thinking = { type: 'enabled' }; _bodyNoTools.reasoning_effort = _thinkEffort; } else { _bodyNoTools.thinking = { type: 'disabled' }; }
                            resp = await fetch(dsApiUrl, {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + key },
                                body: JSON.stringify(_bodyNoTools),
                                signal: window._dsAbortController.signal
                            });
                            try { errText = resp.ok ? '' : await resp.text(); } catch (e) { errText = ''; }
                        }
                    }
                    if (!resp.ok) {
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
                        // ── 流式读取：按实际生效的通道选择解析器 ──
                        // Anthropic 通道：server_tool_use / web_search_tool_result 内容块；
                        // Responses 通道：web_search_call item（DeepSeek 会忽略该工具，故一般恒为 0 次检索）。
                        var _acWS = window._dsAbortController;
                        var _wsRes = (_wsKindUsed === 'anthropic')
                            ? await _dsReadAnthropicStream(resp, assistantIdx)
                            : await _dsReadResponsesStream(resp, assistantIdx);
                        // 【v4.22】本轮**真实检索次数**（供回答尾部「本次参考」展示联网维度；0 次也要显示，
                        //   因为"联网开着却一次没检索"正是用户最容易误解的情形）
                        try { if (window.__dsLastWs) window.__dsLastWs.searches = _wsRes.searches || 0; } catch (e0) {}
                        var _wsRetryFail = '';
                        // 首轮正文与思考过程留底：强制重试会先清空气泡，若重试失败必须回填，避免出现「空气泡 + 告警条」
                        var _wsTextBackup = _wsRes.text || '';
                        var _wsReasonBackup = dsHistory[assistantIdx].reasoning || '';
                        // 兜底：**仅当问题确实需要实时信息**（_dsRealtimeQ）却零检索时，才强制再检索一次。
                        // 按需检索：问候、闲聊、写作、代码、常识、资料分析等问题本就不应检索，模型没检索是正确行为，
                        // 此处不干预、也不告警；但时效性问题若零检索，则必须补搜并如实告知，绝不允许拿旧知识冒充「今日热点」。
                        if (!_wsRes.searches && !_wsRes.failed && _dsRealtimeQ && !(_acWS && _acWS.signal.aborted)) {
                            dsHistory[assistantIdx].content = '';
                            dsHistory[assistantIdx].reasoning = '';
                            _dsPaintBubble(assistantIdx, '🌐 未检测到实际检索，正在强制联网检索…');
                            try {
                                var _forceBody = JSON.parse(JSON.stringify(_wsBodyFor(_wsKindUsed)));
                                var _forceHdr = { 'Content-Type': 'application/json' };
                                if (_wsKindUsed === 'anthropic') {
                                    _forceHdr['x-api-key'] = key;
                                    _forceHdr['anthropic-version'] = '2023-06-01';
                                    // 只对「已判定需要实时信息」的问题补搜，措辞为补充说明而非硬命令（不是要求每次提问都检索）
                                    _forceBody.system = systemPrompt + '\n\n【本轮补充说明】当前这个问题涉及到时效性信息，'
                                        + '请调用 web_search 检索后再基于检索结果作答；若检索无结果或失败，请如实说明本次未取得实时信息，'
                                        + '禁止用内部知识冒充实时信息。';
                                    _forceBody.tool_choice = { type: 'tool', name: 'web_search' };
                                } else {
                                    _forceHdr['Authorization'] = 'Bearer ' + key;
                                    _forceBody.tool_choice = { type: 'web_search' };
                                }
                                var _rF = await fetch(_respEndpointUsed, {
                                    method: 'POST',
                                    headers: _forceHdr,
                                    body: JSON.stringify(_forceBody),
                                    signal: _acWS.signal
                                });
                                if (_rF.ok) {
                                    var _wsRes2 = (_wsKindUsed === 'anthropic')
                                        ? await _dsReadAnthropicStream(_rF, assistantIdx, true)
                                        : await _dsReadResponsesStream(_rF, assistantIdx, true);
                                    if (_wsRes2.searches || _wsRes2.text) _wsRes = _wsRes2;
                                } else {
                                    var _ftxt = '';
                                    try { _ftxt = await _rF.text(); } catch (_e3) {}
                                    var _fmsg = '';
                                    try { _fmsg = ((JSON.parse(_ftxt) || {}).error || {}).message || ''; } catch (_e4) { _fmsg = String(_ftxt).slice(0, 120); }
                                    _wsRetryFail = 'HTTP ' + _rF.status + ' ' + _fmsg;
                                }
                            } catch (_fe2) {
                                _wsRetryFail = (_fe2 && _fe2.message) || '请求异常';
                            }
                        }
                        // 重试失败或返回空正文时，回填首轮内容（告警条会同时说明检索未发生）
                        if (!dsHistory[assistantIdx].content) {
                            dsHistory[assistantIdx].content = _wsTextBackup;
                            if (!dsHistory[assistantIdx].reasoning) dsHistory[assistantIdx].reasoning = _wsReasonBackup;
                        }
                        dsHistory[assistantIdx].web = {
                            searches: _wsRes.searches,
                            queries: _wsRes.queries || [],
                            endpoint: _respEndpointUsed,
                            channel: _wsKindUsed,
                            // 【2026-09-29】链接预读结果（用户给了链接时才有）—— 供证据条显示"链接读到没"
                            linkRead: (window.__dsLinkRead || null),
                            failed: !!_wsRes.failed,
                            retryFailed: _wsRetryFail || '',
                            // 按需检索：问候/闲聊/写作等无需实时信息的问题即便零检索也不算异常，证据条不再打扰
                            timeSensitive: _dsRealtimeQ
                        };
                        _dsStreaming = false;
                        dsRenderAll();
                    } else {
                        // ── chat/completions 流式（支持 P1 Tool Calls 多轮 + P2 前缀续写）──
                        var _pendingToolCalls = [];
                        await _dsStreamChat(resp, assistantIdx, _pendingToolCalls, _turnMetrics);
                        if (_toolsDegradedNote) {   // 端点不支持工具 → 如实补一行说明（不再静默降级）
                            dsHistory[assistantIdx].content = (dsHistory[assistantIdx].content || '') + '\n\n' + _toolsDegradedNote;
                            _toolsDegradedNote = '';
                        }
                        // 若模型请求调用工具：本地执行后回灌结果，再请求一轮让其总结（最多 4 轮，避免无限循环）
                        var _tcRound = 1;
                        // 【2026-10-08 体检修复】4 → 6：原条件下循环体最多执行 **3** 次（1<4→2<4→3<4→4 停），
                        //   第 4 次请求若又产出 tool_calls 就**既不执行也不再请求**，而气泡内容此时已被
                        //   工具状态行（"🔧 正在调用…"）覆盖 ⇒ 用户可能看到**永久"思考中"的空气泡**。
                        //   提到 6 先降低触发概率；"到上限后如实收尾（给一行说明而非空转）"列为后续待办。
                        var _maxTcRounds = 6;
                        while (_useTools && _toolExec && _pendingToolCalls.length && _tcRound < _maxTcRounds) {
                            _tcRound++;
                            // 【2026-09-21】标记"本轮用过工具"：语义缓存据此**不缓存**这类回答
                            //   （否则数据变更后会继续复读旧答案，用户也会误以为"没调用工具"）
                            window.__dsLastTurnUsedTools = true;
                            _pendingToolCalls = _pendingToolCalls.filter(Boolean);
                            // 官方硬性要求：携带 tools 的请求，后续轮次必须**完整回传 reasoning_content**，
                            // 即使该轮未真正产生工具调用；缺失会被 API 判 400。
                            // 本轮思维链已由 _dsStreamChat 累积进 dsHistory[assistantIdx].reasoning，先取出再回传。
                            var _tcReasoning = dsHistory[assistantIdx].reasoning || '';
                            // D2：回灌前规范化 arguments——模型未生成参数时为空串，必须补为 '{}' 合法 JSON，否则 API 报 400
                            _pendingToolCalls.forEach(function(_c, _ci) {
                                if (!_c.id) _c.id = 'call_tc' + _tcRound + '_' + _ci;   // 缺 id → tool_call_id='' 会被判 400（与智能体侧 :866 对齐）
                                if (!_c.function) _c.function = { name: '', arguments: '{}' };
                                if (typeof _c.function.arguments !== 'string' || _c.function.arguments.trim() === '') _c.function.arguments = '{}';
                            });
                            var _tcAssistant = { role: 'assistant', content: null, tool_calls: _pendingToolCalls };
                            // 思考模式下必须把本轮 reasoning_content 一并回传，否则下一轮请求 400。
                            // 非思考模式（thinking disabled）不会产出该字段，此处自然为空、不影响请求。
                            if (_tcReasoning) _tcAssistant.reasoning_content = _tcReasoning;
                            messages.push(_tcAssistant);
                            // 【2026-09-21】工具执行期进度：每秒把"正在调用 X（阶段文案）已等 Ns"写进气泡
                            //   （慢工具如 kb_search 冷建索引时，用户不再只能看到静止的"正在调用…"）
                            window.__agentProgress = function (_tool, _ms, _text) {
                                try {
                                    dsHistory[assistantIdx].content = '🔧 正在调用 ' + _tool + (_text ? '（' + _text + '）' : '') + '… 已等 ' + Math.round(_ms / 1000) + 's';
                                    var _cb = document.getElementById('ds-chat-box');
                                    if (_cb) { var _bs = _cb.querySelectorAll('.ds-bubble-assistant'); var _lb = _bs[_bs.length - 1]; if (_lb) dsSetHtmlKeepMedia(_lb, dsBubbleInner(assistantIdx) + '<span class="ds-cursor">▌</span>'); dsScrollBottom(); }
                                } catch (e) {}
                            };
                            // 【2026-10-08 业界对齐 · OpenAI Parallel function calling】
                            //   规范：模型在同一轮返回的多个 tool_calls 是**相互独立**的，客户端应**并发执行**，
                            //   再把 tool 结果**按 tool_calls 的原顺序**回灌（顺序错乱会造成语义错配、甚至被判 400）。
                            //   改动前这里是逐个 `await` **串行** ⇒ N 个工具的耗时 = 各工具之和（真机体现为"多工具问句特别慢"）；
                            //   智能体侧早已是 `Promise.all`（agent-core.js 并行执行、按序回灌），本次把对话侧对齐。
                            //   ⚠️ 失败隔离用 allSettled 语义：某个工具抛错只让**它自己**记 error，不影响其余工具与队列。
                            var _tcNames = _pendingToolCalls.map(function (c) { return (c.function && c.function.name) || '?'; });
                            dsHistory[assistantIdx].content = '🔧 并行调用 ' + _tcNames.length + ' 个工具：' + _tcNames.join('、') + ' …';
                            (function() { var _cb = document.getElementById('ds-chat-box'); if (_cb) { var _bs = _cb.querySelectorAll('.ds-bubble-assistant'); var _lb = _bs[_bs.length - 1]; if (_lb) dsSetHtmlKeepMedia(_lb, dsBubbleInner(assistantIdx) + '<span class="ds-cursor">▌</span>'); dsScrollBottom(); } })();
                            var _tcResults = await Promise.all(_pendingToolCalls.map(function (_call) {
                                var _args = {};
                                try { _args = _call.function.arguments ? JSON.parse(_call.function.arguments) : {}; } catch (e) { _args = {}; }
                                return Promise.resolve()
                                    .then(function () { return _toolExec(_call.function.name, _args); })
                                    .catch(function (_e) { return { ok: false, error: String((_e && _e.message) || _e) }; });
                            }));
                            // D3：工具结果可视化——在气泡中按**原顺序**列出各工具摘要（✅ 共N条 / ❌ 错误），
                            //   提升调用过程可观测性，与智能体透明卡片对齐
                            var _tcLines = [];
                            for (var _k = 0; _k < _pendingToolCalls.length; _k++) {
                                var _call = _pendingToolCalls[_k];
                                var _exec = _tcResults[_k];
                                var _summary = '';
                                if (_exec && _exec.ok) {
                                    if (_exec.result && typeof _exec.result.total === 'number') _summary = '✅ ' + _call.function.name + '：共 ' + _exec.result.total + ' 条';
                                    else _summary = '✅ ' + _call.function.name + '：执行成功';
                                } else {
                                    _summary = '❌ ' + _call.function.name + '：' + ((_exec && _exec.error) || '执行失败');
                                }
                                _tcLines.push(_summary);
                                var _tcPayload = (_exec && _exec.result !== undefined) ? _exec.result : _exec;
                                // 统一预算裁剪（与智能体侧同一实现）：避免一次 limit 不封顶把数百 KB 灌进上下文；
                                //   同时去掉 null,2 缩进美化（纯浪费 20~30% token）
                                if (typeof window._agentTrimToolResult === 'function') _tcPayload = window._agentTrimToolResult(_tcPayload);
                                var _tcContent = JSON.stringify(_tcPayload);
                                messages.push({ role: 'tool', tool_call_id: _call.id, name: _call.function.name, content: _tcContent });
                            }
                            dsHistory[assistantIdx].content = '🔧 ' + _tcLines.join('　');
                            (function() { var _cb = document.getElementById('ds-chat-box'); if (_cb) { var _bs = _cb.querySelectorAll('.ds-bubble-assistant'); var _lb = _bs[_bs.length - 1]; if (_lb) dsSetHtmlKeepMedia(_lb, dsBubbleInner(assistantIdx) + '<span class="ds-cursor">▌</span>'); dsScrollBottom(); } })();
                            window.__agentProgress = null;   // 本轮工具跑完，撤掉进度回传
                            // 清空气泡，准备下一轮最终回答
                            dsHistory[assistantIdx].content = '';
                            dsHistory[assistantIdx].reasoning = '';
                            (function() { var _cb = document.getElementById('ds-chat-box'); if (_cb) { var _bs = _cb.querySelectorAll('.ds-bubble-assistant'); var _lb = _bs[_bs.length - 1]; if (_lb) dsSetHtmlKeepMedia(_lb, dsBubbleInner(assistantIdx) + '<span class="ds-cursor">▌</span>'); dsScrollBottom(); } })();
                            // 后续轮次：回灌工具结果（仍带 tools，允许模型继续调用或总结）
                            var _bodyN = { model: dsModel, messages: messages, stream: true, temperature: _chatTemp, max_tokens: maxTokens };
                            if (thinkingOn) { _bodyN.thinking = { type: 'enabled' }; _bodyN.reasoning_effort = _thinkEffort; } else { _bodyN.thinking = { type: 'disabled' }; }
                            if (_useTools) { _bodyN.tools = _toolsParamArr; }
                            var _respN = await fetch(dsApiUrl, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + key }, body: JSON.stringify(_bodyN), signal: window._dsAbortController.signal });
                            if (!_respN.ok) { _dsStreaming = false; var _et = await _respN.text(); dsHistory[assistantIdx].content = '❌ 工具结果回灌后请求失败（HTTP ' + _respN.status + '）：' + _et.slice(0, 200); dsRenderAll(); return; }
                            _pendingToolCalls = [];
                            await _dsStreamChat(_respN, assistantIdx, _pendingToolCalls, _turnMetrics);
                            _turnMetrics.toolRounds = (_turnMetrics.toolRounds || 0) + 1;
                        }
                        // 【2026-10-08 业界对齐 · forced final turn（工具轮次上限的"如实收尾"）】
                        //   背景：循环条件是 `_tcRound < _maxTcRounds`，一旦达上限而模型**又**产出了 tool_calls，
                        //   这些调用既不执行、也不再请求，而气泡内容此刻已被"🔧 正在调用…"占位覆盖
                        //   ⇒ 用户看到**永久"思考中"**的空气泡（真机残留风险）。
                        //   业界做法（OpenAI Function calling 指南 & 主流 Agent 框架通用）：
                        //     ① 不再执行新工具，但必须为每条 tool_call **补齐配对的 tool 消息**（缺配对会被判 400）；
                        //     ② 追加一条明确的"立即给最终回答、不要再调工具"指令；
                        //     ③ 请求层用 `tool_choice:'none'` **硬性禁止**再调工具 —— 即 forced final turn；
                        //   ④ 用户拿到的是"基于已有信息的结论 + 一句如实说明"，而不是空转。
                        //   智能体侧早就有等价收尾（agent-core.js：预算耗尽后回灌"未执行"并催最终回答），本次两端对齐。
                        if (_useTools && _pendingToolCalls.length && _toolExec) {
                            var _limCalls = _pendingToolCalls.filter(Boolean);
                            var _limReason = '工具调用轮次已达上限（' + _maxTcRounds + ' 轮），本条未执行';
                            messages.push({ role: 'assistant', content: null, tool_calls: _limCalls });
                            _limCalls.forEach(function (_c) {
                                messages.push({
                                    role: 'tool', tool_call_id: _c.id, name: (_c.function && _c.function.name) || '',
                                    content: JSON.stringify({ ok: false, error: _limReason })
                                });
                            });
                            messages.push({
                                role: 'user',
                                content: '（系统提示）本轮工具调用次数已达上限。请**立即基于已经获得的工具结果与本地资料给出最终回答**，'
                                    + '不要再调用任何工具；若确有未查到的部分，用一句话如实说明"因调用次数上限未继续查询"。'
                            });
                            dsHistory[assistantIdx].content = '';
                            (function() { var _cb = document.getElementById('ds-chat-box'); if (_cb) { var _bs = _cb.querySelectorAll('.ds-bubble-assistant'); var _lb = _bs[_bs.length - 1]; if (_lb) dsSetHtmlKeepMedia(_lb, dsBubbleInner(assistantIdx) + '<span class="ds-cursor">▌</span>'); dsScrollBottom(); } })();
                            try {
                                var _bodyL = { model: dsModel, messages: messages, stream: true, temperature: _chatTemp, max_tokens: maxTokens, tool_choice: 'none' };
                                if (thinkingOn) { _bodyL.thinking = { type: 'enabled' }; _bodyL.reasoning_effort = _thinkEffort; } else { _bodyL.thinking = { type: 'disabled' }; }
                                if (_useTools) { _bodyL.tools = _toolsParamArr; }
                                var _respL = await fetch(dsApiUrl, {
                                    method: 'POST',
                                    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + key },
                                    body: JSON.stringify(_bodyL), signal: window._dsAbortController.signal
                                });
                                if (_respL && _respL.ok) {
                                    _pendingToolCalls = [];
                                    await _dsStreamChat(_respL, assistantIdx, _pendingToolCalls, _turnMetrics);
                                    try { window.__dsLastTurnToolLimit = true; } catch (eL2) {}   // 供诊断/断言核对"确实走到过上限收尾"
                                }
                            } catch (eL) { /* 收尾请求失败不阻塞：下方统一渲染会把已累积内容呈现给用户 */ }
                            _pendingToolCalls = [];
                        }
                    }

                    // 【P1 输出完整性】平台有且仅有两种"内容不完整"的结束原因，此前完全不检查 ⇒
                    //   回答静默断掉、用户以为答完了：
                    //     · length：达到 max_tokens（本文件已把非思考上限由 4096 提到平台默认 8192，减少发生）
                    //     · insufficient_system_resource：服务端推理资源不足被打断（与用户无关，不该被误判成 App 问题）
                    try {
                        var _frEnd = _turnMetrics.finishReason;
                        if (_frEnd === 'length' || _frEnd === 'insufficient_system_resource') {
                            var _frNote = (_frEnd === 'length')
                                ? '⚠️ 本次回复已达单次输出上限，内容可能不完整。'
                                : '⚠️ 本次回复因服务端资源不足被中断，内容可能不完整。';
                            dsHistory[assistantIdx].content = (dsHistory[assistantIdx].content || '')
                                + '\n\n' + _frNote + '点下方「▶️ 继续生成」可从断点接着写。';
                        }
                    } catch (e) {}
                    _dsStreaming = false; // 收尾：确保最终渲染出真实播放器
                    var _finalChatBox = document.getElementById('ds-chat-box');
                    var _finalBubbles = _finalChatBox.querySelectorAll('.ds-bubble-assistant');
                    var _finalBubble = _finalBubbles[_finalBubbles.length - 1];
                    if (_finalBubble) dsSetHtmlKeepMedia(_finalBubble, dsBubbleInner(assistantIdx));
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
                    // 【P1 输出完整性】被截断 / 被服务端中断时，把「继续生成」放到第一位
                    if (_turnMetrics.finishReason === 'length' || _turnMetrics.finishReason === 'insufficient_system_resource') {
                        suggestions.unshift('▶️ 继续生成');
                    }
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
                                    if (ib) {
                                        // 「继续生成」需要明确的续写口径：历史里已有半截回答，
                                        // 若只发"继续生成"模型容易从头重写，这里换成可执行指令。
                                        ib.value = (text === '▶️ 继续生成')
                                            ? '继续（从上次中断处接着写，不要重复已写过的内容）'
                                            : text.replace(/^[^\s]+\s/, '');
                                    }
                                    setTimeout(function() { dsSendMsg(); }, 100);
                                };
                                suggestDiv.appendChild(btn);
                            });
                            lastMsgDiv.appendChild(suggestDiv);
                        }
                    }

                } catch(err) {
                    try { _turnMetrics.err = (err && err.name) || 'error'; } catch (e) {}
                    if (err.name === 'TimeoutError') {
                        // P8：请求超时（非用户主动停止）
                        dsHistory[assistantIdx].content = '❌ 请求超时（' + (_reqTimeoutMs / 1000) + 's）：模型响应时间过长，请稍后重试，或检查网络/API 状态。';
                        var _tBox = document.getElementById('ds-chat-box');
                        if (_tBox) { var _lb = _tBox.querySelector('.ds-bubble-assistant:last-of-type'); if (_lb) dsSetHtmlKeepMedia(_lb, dsBubbleInner(assistantIdx)); }
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
                                    var _li = parseInt(lastBubble2.getAttribute('data-ds-idx'), 10);
                                    window._addFeedbackButtons(lastBubble2, lastBubble2.innerText,
                                        isNaN(_li) ? (dsHistory.length - 1) : _li);
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
                    // ⚠️ 必须一并复位 _dsStreaming（渲染层真正读取的标志，见本文件 :3194）。
                    // _dsStreamChat 内部没有 try/finally，被「停止生成」或断网中止时它末尾的复位语句
                    // 不会执行；漏掉这里会让该标志永久为 true，此后整个会话的图片/音视频只会渲染成外链卡片。
                    _dsStreaming = false;
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
                    // 【P1 指标】本轮落一条记录（失败轮也落，便于区分"慢"与"错"）。
                    //   缓存命中率/首字延迟/结束原因都取自 _dsStreamChat 采集到的 usage 与 finish_reason。
                    try {
                        var _nowEnd = (window.performance && performance.now) ? performance.now() : Date.now();
                        _turnMetrics.totalMs = Math.round(_nowEnd - _turnMetrics.t0);
                        try { _turnMetrics.think = !!thinkingOn; } catch (e1) {}
                        try { _turnMetrics.web = !!useWebSearch; } catch (e2) {}
                        try { _turnMetrics.tools = !!_useTools; } catch (e3) {}
                        try { _turnMetrics.outChars = String((dsHistory[assistantIdx] || {}).content || '').length; } catch (e4) {}
                        if (typeof window.dsRecordAiMetrics === 'function') window.dsRecordAiMetrics(_turnMetrics);
                    } catch (e) {}
                    // 【v4.20 用户需求】回答结束后附一行「本次参考」（系统行、不进历史）：让用户不必开面板就知道
                    //   本轮实际用了哪些本地资料。只在本轮**正常产出回答**时追加（失败/停止/空回答不打扰）。
                    try { window.__dsAppendKbBadge && window.__dsAppendKbBadge(); } catch (e) {}
                }
            };

            // 暴露统一的「发送消息到 DeepSeek」入口（供统一增强模块/外部智能体调用）
            window.sendToDeepSeek = window._dsRunStream;

            // 重新生成：移除末尾助手消息，复用最后一条用户问题重发
            // msgIdx = 被点击的那条 assistant 在 dsHistory 中的下标（由反馈按钮传入）。
            // 原实现不接收下标，永远重生成「最后一轮」——多轮对话中点第 1 轮的「重生成」，
            // 实际重新生成的是最后一轮，前面的气泡纹丝不动，与按钮 title「重新生成本条回复」不符。
            window.dsRegenerate = function(msgIdx) {
                if (dsStreaming) return;
                if (!dsHistory.length) return;

                var target = -1;
                if (typeof msgIdx === 'number' && msgIdx >= 0 && msgIdx < dsHistory.length &&
                    dsHistory[msgIdx].role === 'assistant') {
                    target = msgIdx;
                }
                if (target < 0) {
                    // 未传下标或下标已失效（历史被改动过）→ 退回「重生成最后一轮」
                    while (dsHistory.length && dsHistory[dsHistory.length - 1].role === 'assistant') {
                        dsHistory.pop();
                    }
                } else {
                    // 重生成中间某条 = 丢弃该条及其后的全部对话。
                    // 这会连带删掉用户后续的提问，必须显式确认，避免误触丢内容。
                    var dropCount = dsHistory.length - target;
                    if (dropCount > 1) {
                        if (!confirm('重新生成该条回复会同时移除其后的 ' + (dropCount - 1) + ' 条对话，确定继续？')) return;
                    }
                    dsHistory.length = target;   // 截断到目标 assistant 之前
                    while (dsHistory.length && dsHistory[dsHistory.length - 1].role === 'assistant') {
                        dsHistory.pop();
                    }
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
                        html += '<div class="ds-row-user"><div class="ds-bubble-user">' + dsAutoLink(dsEsc(showText)) + '</div></div>';
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
                // 用媒体块复用写入：dsRenderAll 会重建全部气泡，若直接 innerHTML 覆盖，
                // 历史消息里已加载/已在播放的音视频会被销毁并重新下载
                dsSetHtmlKeepMedia(box, html);
                // 给每个 AI 回复气泡追加操作按钮（复制/下载/有用/无用/重生成/朗读），
                // 使按钮成为消息渲染的固有部分，任何 dsRenderAll 重渲染后都稳定保留。
                if (typeof window._addFeedbackButtons === 'function') {
                    box.querySelectorAll('.ds-bubble-assistant').forEach(function(bubble){
                        if (bubble.querySelector('.ds-typing')) return; // 跳过"思考中"占位气泡
                        var _idx = parseInt(bubble.getAttribute('data-ds-idx'), 10);
                        var _content = (dsHistory[_idx] && dsHistory[_idx].content) ? dsHistory[_idx].content : bubble.innerText;
                        window._addFeedbackButtons(bubble, _content, _idx);
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
            async function _dsStreamChat(resp, idx, toolCallsOut, metricsOut) {
                // 【P1 指标】metricsOut：本轮度量收集器（可缺省）。DeepSeek 流式的**最后一个块默认带 usage
                //   与 finish_reason**（官方文档：统计信息附加在最后一个内容块上，无需 stream_options），
                //   所以不新增任何请求参数就能采到缓存命中 token 与"内容是否完整"。
                if (!metricsOut) metricsOut = {};
                _dsStreaming = true; // 流式期间媒体降级为占位卡片，避免逐帧重建反复加载
                var reader = resp.body.getReader();
                var decoder = new TextDecoder();
                var buffer = '';
                // 【优化·速度】重绘节流：由"每 3 个 delta"改为"距上次重绘 ≥60ms"。
                //   原实现假设 delta 均匀到达，但真实网络下 delta 常成簇到达（一个 TCP 段带几十个），
                //   此时每 3 个就重绘 = 短时间内几十次全量 markdown 重解析 + 媒体池重建（O(n²)），
                //   手机端明显掉帧；而 delta 稀疏时反而显得迟钝。按时间节流对两种情况都更稳。
                var _lastPaint = 0;
                var _PAINT_MS = 60;
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
                                // 【P1 指标】采集用量与结束原因（末块才有值，前序块为 null）
                                if (_json.usage) {
                                    metricsOut.usage = _json.usage;
                                    metricsOut.cacheHit = _json.usage.prompt_cache_hit_tokens || 0;
                                    metricsOut.cacheMiss = _json.usage.prompt_cache_miss_tokens || 0;
                                    metricsOut.promptTokens = _json.usage.prompt_tokens || 0;
                                    metricsOut.completionTokens = _json.usage.completion_tokens || 0;
                                    var _rt = _json.usage.completion_tokens_details && _json.usage.completion_tokens_details.reasoning_tokens;
                                    if (_rt) metricsOut.reasoningTokens = _rt;
                                }
                                var _frNow = _json.choices?.[0]?.finish_reason;
                                if (_frNow) metricsOut.finishReason = _frNow;
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
                                    var _nowMs = (window.performance && performance.now) ? performance.now() : Date.now();
                                    // 【P1 指标】首字延迟：从请求发出到第一个内容 delta
                                    if (!metricsOut.firstDeltaMs && metricsOut.t0) {
                                        metricsOut.firstDeltaMs = Math.round(_nowMs - metricsOut.t0);
                                    }
                                    if (_nowMs - _lastPaint >= _PAINT_MS) {
                                        _lastPaint = _nowMs;
                                        var _cb = document.getElementById('ds-chat-box');
                                        if (_cb) {
                                            var _bs = _cb.querySelectorAll('.ds-bubble-assistant');
                                            var _lb = _bs[_bs.length - 1];
                                            if (_lb) dsSetHtmlKeepMedia(_lb, dsBubbleInner(idx) + '<span class="ds-cursor">▌</span>');
                                            dsScrollBottom();
                                        }
                                    }
                                }
                            } catch (e) {}
                        }
                    }
                }
                _dsStreaming = false;
            }

            // ---- P2 FIM 中间补全（Beta，独立入口，仅非思考） ----
            window.dsOpenFim = function() {
                // 守卫：视觉/非 DeepSeek 等不支持 FIM 的模型禁止打开（避免 404/报错）
                var _cur = dsModel || (localStorage.getItem('ds_model_v1') || DS_DEFAULT_MODEL);
                if (typeof window.dsModelSupportsFim === 'function' && !window.dsModelSupportsFim(_cur)) {
                    alert('当前模型「' + _cur + '」不支持 FIM 中间补全（非 DeepSeek 文本模型）。\n请切换到 DeepSeek 模型（如 deepseek-flash）后再使用此功能。');
                    return;
                }
                // v3.25 互斥：打开 FIM 弹窗前关闭其它所有弹出（四个下拉 + 附件弹层）
                var m = document.getElementById('ds-fim-modal');
                if (typeof window.dsCloseAllChatPopups === 'function') window.dsCloseAllChatPopups(m);
                if (m) m.style.display = 'flex';
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
                var _model = _mo ? _mo.value : 'deepseek-flash';
                var _max = parseInt((_mt ? _mt.value : '1024') || '1024', 10); if (!( _max > 0)) _max = 1024; if (_max > 4096) _max = 4096;
                var _fimUrl = (function() { try { var _u = new URL(dsApiUrl); return _u.origin + '/beta/completions'; } catch (e) { return 'https://api.deepseek.com/beta/completions'; } })();
                var _body = { model: _model, prompt: _prompt, max_tokens: _max, temperature: 0.7 };
                // ⚠️ 官方明确：FIM 补全（Beta）**仅非思考模式支持**，而 DeepSeek V4 起思考模式默认开启。
                // 不显式关闭的话，该请求会因「思考模式 + FIM」组合被拒（或返回空补全）。
                // 这里强制 mode:'off'，不受设置页开关影响；非 DeepSeek 端点下该函数返回 {}，无需额外判断。
                if (typeof window.dsThinkingParam === 'function') {
                    Object.assign(_body, window.dsThinkingParam({ mode: 'off', apiUrl: _fimUrl, model: _model }));
                }
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

            // ============ 联网检索（Anthropic 主通道 / Responses 备选）辅助 ============
            // Responses API 端点推导：官方端点为 POST https://api.deepseek.com/responses（根路径、不带 /v1）。
            // 旧实现用正则把 /chat/completions 硬换成 /responses：当用户填的是带 /v1 的地址时会打到 /v1/responses，
            // 只填域名时会直接打到根路径，二者都可能 404。这里统一归一化，并给出备用端点（部分代理/网关带 /v1）。
            function dsResponsesUrlCandidates(apiUrl) {
                var origin = 'https://api.deepseek.com';
                var path = '/responses';
                var s = String(apiUrl || '').trim();
                try {
                    if (s) {
                        var u = new URL(s);
                        origin = u.origin;
                        path = (u.pathname || '/').replace(/\/+$/, '');
                        // 必须先精确匹配 /chat/completions：若先命中 /completions，会把 /chat/completions 切成 /chat/responses
                        if (/\/chat\/completions$/i.test(path)) path = path.replace(/\/chat\/completions$/i, '/responses');
                        else if (/\/completions$/i.test(path)) path = path.replace(/\/completions$/i, '/responses');
                        else if (!/\/responses$/i.test(path)) path = path + '/responses';
                    }
                } catch (e) { origin = 'https://api.deepseek.com'; path = '/responses'; }
                var host = origin.replace(/^https?:\/\//i, '').replace(/:\d+$/, '').toLowerCase();
                var isDeepSeek = /(^|\.)deepseek\.com$/.test(host);
                if (isDeepSeek) path = path.replace(/^\/v\d+/i, '');   // 官方 Responses 端点位于根路径
                var list = [origin + path];
                if (isDeepSeek && path === '/responses') list.push(origin + '/v1/responses');
                return list;
            }

            // Anthropic Messages 端点推导：DeepSeek 的「服务端联网检索」只在这条通道上真正执行。
            // 官方端点：POST https://api.deepseek.com/anthropic/v1/messages（注意 /anthropic 前缀不可省）。
            // 浏览器可直连（已实测：预检返回 access-control-allow-headers: content-type,x-api-key,anthropic-version）。
            function dsAnthropicUrlCandidates(apiUrl) {
                var origin = 'https://api.deepseek.com';
                var forcedBase = '';
                var s = String(apiUrl || '').trim();
                try {
                    if (s) {
                        var u = new URL(s);
                        origin = u.origin;
                        // 用户已填 /anthropic 路径：沿用该前缀（先剥掉可能多写的 /v1/messages）
                        var m = (u.pathname || '').match(/^(.*\/anthropic)(?:\/v\d+\/messages)?\/?$/i);
                        if (m) forcedBase = origin + m[1];
                    }
                } catch (e) { origin = 'https://api.deepseek.com'; }
                var host = origin.replace(/^https?:\/\//i, '').replace(/:\d+$/, '').toLowerCase();
                var list = [];
                if (forcedBase) list.push(forcedBase + '/v1/messages');
                else if (/(^|\.)deepseek\.com$/.test(host)) list.push(origin + '/anthropic/v1/messages');
                return list;
            }

            // 把本系统内部的 OpenAI 风格多模态内容块转成 Anthropic 内容块
            // （data:image/...;base64,xxx → {type:'image', source:{type:'base64', media_type, data}}）
            function _dsVisionToAnthropicBlocks(blocks) {
                var out = [];
                (blocks || []).forEach(function(b) {
                    if (!b) return;
                    if (b.type === 'text') { if (b.text) out.push({ type: 'text', text: String(b.text) }); return; }
                    if (b.type === 'image_url') {
                        var url = (b.image_url && b.image_url.url) || '';
                        var m = /^data:([^;,]+);base64,(.+)$/i.exec(url);
                        if (m) out.push({ type: 'image', source: { type: 'base64', media_type: m[1], data: m[2] } });
                        else if (/^https?:\/\//i.test(url)) out.push({ type: 'image', source: { type: 'url', url: url } });
                    }
                });
                return out;
            }

            // 组装 Anthropic messages：Anthropic 要求 user/assistant 交替，故对相邻同角色消息做合并；
            // 最后一条 user 若带图片，则把该条 content 换成 [text, image...] 内容块数组。
            function dsBuildAnthropicMessages(hist, visionContent) {
                var list = (hist || []).filter(function(m) { return m && m.content; });
                var lastUserIdx = -1;
                for (var i = list.length - 1; i >= 0; i--) { if (list[i].role !== 'assistant') { lastUserIdx = i; break; } }
                var msgs = [];
                list.forEach(function(m, i) {
                    var role = (m.role === 'assistant') ? 'assistant' : 'user';
                    var content = String(m.content);
                    if (i === lastUserIdx && visionContent) {
                        var blocks = _dsVisionToAnthropicBlocks(visionContent);
                        if (blocks.length) content = blocks;
                    }
                    var last = msgs[msgs.length - 1];
                    if (last && last.role === role) {
                        if (typeof last.content === 'string' && typeof content === 'string') last.content += '\n\n' + content;
                        else {
                            var a = Array.isArray(last.content) ? last.content : [{ type: 'text', text: String(last.content) }];
                            var b = Array.isArray(content) ? content : [{ type: 'text', text: content }];
                            last.content = a.concat(b);
                        }
                    } else {
                        msgs.push({ role: role, content: content });
                    }
                });
                if (!msgs.length) msgs.push({ role: 'user', content: '（继续）' });
                if (msgs[0].role !== 'user') msgs.unshift({ role: 'user', content: '（继续）' });
                return msgs;
            }

            // 直接重绘「最后一条助手气泡」（流式逐帧用，避免整表重绘）
            function _dsPaintBubble(idx, bodyHtml, withCursor) {
                var box = document.getElementById('ds-chat-box');
                if (!box) return;
                var bubbles = box.querySelectorAll('.ds-bubble-assistant');
                var last = bubbles[bubbles.length - 1];
                if (!last) return;
                dsSetHtmlKeepMedia(last, (bodyHtml || '') + (withCursor === false ? '' : '<span class="ds-cursor">▌</span>'));
                dsScrollBottom();
            }

            // 读取 Responses API 语义化 SSE 流：累积正文与思考过程，并统计「实际发生的检索次数与检索词」。
            // 相关事件：response.output_text.delta / response.reasoning_text.delta /
            //   response.output_item.done(item.type=web_search_call) / response.web_search_call.* /
            //   response.completed|incomplete|failed（注意：Responses API 没有 data: [DONE] 结束标记）
            async function _dsReadResponsesStream(resp, idx, isRetry) {
                var out = { text: '', searches: 0, queries: [], failed: false };
                if (!resp || !resp.body) return out;
                var reader = resp.body.getReader();
                var decoder = new TextDecoder();
                var buffer = '';
                var tick = 0;
                var sawWsEvent = false;
                _dsStreaming = true;
                try {
                    while (true) {
                        var chunk = await reader.read();
                        if (chunk.done) break;
                        buffer += decoder.decode(chunk.value, { stream: true });
                        var segs = buffer.split('\n\n');
                        buffer = segs.pop() || '';
                        for (var i = 0; i < segs.length; i++) {
                            var lines = segs[i].split('\n');
                            var dataLine = null, evName = '';
                            for (var l = 0; l < lines.length; l++) {
                                if (lines[l].indexOf('event:') === 0) evName = lines[l].slice(6).trim();
                                else if (lines[l].indexOf('data:') === 0) dataLine = lines[l];
                            }
                            if (!dataLine) continue;
                            var payload = dataLine.slice(5).trim();
                            if (!payload || payload === '[DONE]') continue;
                            var j; try { j = JSON.parse(payload); } catch (e) { continue; }
                            var t = j.type || evName || '';
                            if (t === 'response.output_text.delta') {
                                out.text += (j.delta || '');
                            } else if (t === 'response.reasoning_text.delta') {
                                dsHistory[idx].reasoning = (dsHistory[idx].reasoning || '') + (j.delta || '');
                            } else if (t === 'response.output_item.done') {
                                var it = j.item || {};
                                if (it.type === 'web_search_call') {
                                    out.searches++;
                                    var q = (it.action && (it.action.query || it.action.q)) || it.query || '';
                                    if (q && out.queries.indexOf(q) < 0) out.queries.push(q);
                                }
                            } else if (t === 'response.web_search_call.in_progress' || t === 'response.web_search_call.searching' || t === 'response.web_search_call.completed') {
                                sawWsEvent = true;
                            } else if (t === 'response.failed' || t === 'error') {
                                var em = (j.error && (j.error.message || j.error.code)) || j.message || '联网检索失败';
                                out.failed = true;
                                dsHistory[idx].content = '❌ ' + em;
                                dsHistory[idx].web = { failed: true, searches: out.searches, queries: out.queries, endpoint: '' };
                                _dsStreaming = false;
                                dsRenderAll();
                                try { reader.cancel(); } catch (ce) {}
                                return out;
                            }
                        }
                        tick++;
                        dsHistory[idx].content = out.text;
                        if (tick % 3 === 0) {
                            var shown = out.text
                                ? dsMarkdown(out.text)
                                : ((sawWsEvent || out.searches) ? '🌐 正在联网检索…' : (isRetry ? '🌐 正在强制联网检索…' : '正在生成…'));
                            _dsPaintBubble(idx, shown);
                        }
                    }
                } catch (_re) { /* 读取中断（用户停止/网络断开）：保留已收到的内容 */ }
                // 部分端点只发状态事件、不发 output_item.done：退化为「至少检索过 1 次」，避免误报「未检索」
                if (!out.searches && sawWsEvent) out.searches = 1;
                dsHistory[idx].content = out.text;
                _dsStreaming = false;
                return out;
            }

            // 读取 Anthropic Messages 语义化 SSE 流（DeepSeek 的服务端联网检索走这条通道）。
            // 关键内容块：
            //   content_block_start{content_block.type='server_tool_use', name='web_search'} → 检索发起
            //   content_block_delta{delta.type='input_json_delta'}                            → 检索词碎片
            //   content_block_stop                                                            → 该次检索完成
            //   content_block_start{content_block.type='web_search_tool_result'}              → 检索结果（内容不对外暴露明文链接）
            //   content_block_delta{delta.type='text_delta'|'thinking_delta'}                 → 正文 / 思维链
            async function _dsReadAnthropicStream(resp, idx, isRetry) {
                var out = { text: '', searches: 0, queries: [], results: 0, failed: false };
                if (!resp || !resp.body) return out;
                var reader = resp.body.getReader();
                var decoder = new TextDecoder();
                var buffer = '';
                var tick = 0;
                var sawWsEvent = false;
                var pendingTool = {};   // content_block index → {name, json}
                _dsStreaming = true;
                try {
                    while (true) {
                        var chunk = await reader.read();
                        if (chunk.done) break;
                        buffer += decoder.decode(chunk.value, { stream: true });
                        var segs = buffer.split('\n\n');
                        buffer = segs.pop() || '';
                        for (var i = 0; i < segs.length; i++) {
                            var lines = segs[i].split('\n');
                            var dataLine = null;
                            for (var l = 0; l < lines.length; l++) {
                                if (lines[l].indexOf('data:') === 0) dataLine = lines[l];
                            }
                            if (!dataLine) continue;
                            var payload = dataLine.slice(5).trim();
                            if (!payload || payload === '[DONE]') continue;
                            var j; try { j = JSON.parse(payload); } catch (e) { continue; }
                            var t = j.type || '';
                            if (t === 'content_block_start') {
                                var cb = j.content_block || {};
                                if (cb.type === 'server_tool_use') {
                                    sawWsEvent = true;
                                    pendingTool[j.index] = { name: cb.name || '', json: '' };
                                } else if (cb.type === 'web_search_tool_result') {
                                    sawWsEvent = true;
                                    out.results++;
                                } else if (cb.type === 'text' && cb.text) {
                                    out.text += cb.text;
                                } else if (cb.type === 'thinking' && cb.thinking) {
                                    dsHistory[idx].reasoning = (dsHistory[idx].reasoning || '') + cb.thinking;
                                }
                            } else if (t === 'content_block_delta') {
                                var d = j.delta || {};
                                if (d.type === 'text_delta') out.text += (d.text || '');
                                else if (d.type === 'thinking_delta') dsHistory[idx].reasoning = (dsHistory[idx].reasoning || '') + (d.thinking || '');
                                else if (d.type === 'input_json_delta') {
                                    if (!pendingTool[j.index]) pendingTool[j.index] = { name: '', json: '' };
                                    pendingTool[j.index].json += (d.partial_json || '');
                                }
                            } else if (t === 'content_block_stop') {
                                var pt = pendingTool[j.index];
                                if (pt) {
                                    out.searches++;
                                    try {
                                        var args = pt.json ? JSON.parse(pt.json) : {};
                                        var q = args.query || args.q || '';
                                        if (Array.isArray(args.queries)) q = args.queries.join('｜');
                                        if (q && out.queries.indexOf(q) < 0) out.queries.push(q);
                                    } catch (e) {}
                                    delete pendingTool[j.index];
                                }
                            } else if (t === 'error' || t === 'message_stop') {
                                if (t === 'error') {
                                    var em = (j.error && (j.error.message || j.error.type)) || '联网检索失败';
                                    out.failed = true;
                                    dsHistory[idx].content = '❌ ' + em;
                                    dsHistory[idx].web = { failed: true, searches: out.searches, queries: out.queries, endpoint: '', channel: 'anthropic' };
                                    _dsStreaming = false;
                                    dsRenderAll();
                                    try { reader.cancel(); } catch (ce) {}
                                    return out;
                                }
                            }
                        }
                        tick++;
                        dsHistory[idx].content = out.text;
                        if (tick % 3 === 0) {
                            var shown = out.text
                                ? dsMarkdown(out.text)
                                : ((sawWsEvent || out.searches) ? '🌐 正在联网检索…' : (isRetry ? '🌐 正在强制联网检索…' : '正在生成…'));
                            _dsPaintBubble(idx, shown);
                        }
                    }
                } catch (_re) { /* 读取中断（用户停止/网络断开）：保留已收到的内容 */ }
                // 兜底：只收到 server_tool_use / web_search_tool_result 而流被提前截断时，仍记为「检索过」
                if (!out.searches && (sawWsEvent || out.results)) out.searches = 1;
                dsHistory[idx].content = out.text;
                _dsStreaming = false;
                return out;
            }

            // 联网检索证据条：把「本轮是否真的联网」摆在用户眼前，杜绝「说联网其实没联网」的假成功
                /**
     * 【2026-09-29】把链接正文**存为资料**（智能对话内「📥 存为资料」按钮共用）。
     * 取正文顺序（越前越省）：① 预读缓存（30 分钟内、含正文与标题）→ ② 阅读器单页直取（第 2 层）→ ③ 模型定向读（第 1 层）。
     * 落库走 smart-writer 的 wrSaveTextMaterial（同一 URL ⇒ 更新，不堆重复条目），并失效检索索引。
     */
    window.dsSaveLinkAsMaterial = async function (url, title) {
        var u = String(url || '').trim();
        if (!/^https?:\/\//i.test(u)) { try { window.Toast.warn('无效链接'); } catch (e) {} return { ok: false, error: 'bad-url' }; }
        try { window.Toast.info('正在读取并存入资料…'); } catch (e) {}
        var text = '', t = String(title || '').trim(), ch = '';
        try {
            var cache = JSON.parse(localStorage.getItem('_ds_link_read_cache_v1') || '{}') || {};
            var hit = cache[u];
            if (hit && hit.text && (Date.now() - (hit.ts || 0)) < 30 * 60 * 1000) {
                text = hit.text; t = t || hit.title || ''; ch = hit.channel || 'cache';
            }
        } catch (e) {}
        if (!text && typeof window.dsFetchPage === 'function') {
            try {
                var r = await window.dsFetchPage(u, { maxChars: 20000 });
                if (r && r.ok) { text = r.text; t = t || r.title || ''; ch = 'reader'; }
            } catch (e) {}
        }
        if (!text && typeof window.dsLinkPreRead === 'function') {
            try {
                var r2 = await window.dsLinkPreRead([u], '');
                if (r2 && r2.ok) { text = r2.digest; ch = 'model'; }
            } catch (e) {}
        }
        if (!text) { try { window.Toast.error('未能读取该页面，无法存为资料'); } catch (e) {} return { ok: false, error: 'read-failed' }; }
        if (typeof window.wrSaveTextMaterial !== 'function') {
            try { window.Toast.error('资料模块未就绪，请稍后再试'); } catch (e) {}
            return { ok: false, error: 'no-writer' };
        }
        var res = null;
        try { res = await window.wrSaveTextMaterial({ title: t, content: text, url: u }); } catch (e) { res = { ok: false, error: String((e && e.message) || e) }; }
        try {
            if (res && res.ok) window.Toast.success((res.updated ? '已更新资料：' : '已存为资料：') + (t || u) + '（' + text.length + ' 字·' + ch + '）');
            else window.Toast.error('存为资料失败：' + ((res && res.error) || ''));
        } catch (e) {}
        return res || { ok: false };
    };

function dsWebChip(m) {
                var w = m && m.web;
                if (!w) return '';
                var base = 'display:flex;width:fit-content;align-items:center;gap:5px;margin-bottom:8px;padding:3px 9px;border-radius:999px;font-size:0.74rem;line-height:1.5;border:1px solid ';
                var txt, style;
                // 【2026-09-29】先把"用户给的链接到底读到没"摆出来（链接预读结果，一眼可辨）
                var _lrLine = '';
                try {
                    var _lr = w.linkRead;
                    if (_lr) {
                        if (_lr.ok) {
                            _lrLine = '<div style="' + base + 'rgba(77,107,254,0.35);background:rgba(77,107,254,0.10);color:var(--ds-blue)">'
                                + dsEsc('🔗 已读取链接 ' + (((_lr.links || []).length) || 1) + ' 个（' + (_lr.chars || 0) + ' 字，已并入本轮依据）') + '</div>';
                            // 【第 3 层·结构化来源】逐个列出：序号 · 标题/域名 · 字数 · 通道（可点击核对原文）
                            var _srcs = (_lr.links || []).filter(function (x) { return x && x.ok; });
                            if (_srcs.length) {
                                var _rows = _srcs.map(function (x, i) {
                                    var href = (typeof dsSafeUrl === 'function') ? dsSafeUrl(x.url) : x.url;
                                    var label = (x.title && String(x.title).trim()) ? String(x.title).trim().slice(0, 46) : String(x.url).replace(/^https?:\/\//, '').slice(0, 46);
                                    var ch = (x.channel === 'reader') ? '阅读器' : (x.channel === 'model' ? '联网检索' : '');
                                    var meta = ' · ' + (x.chars || 0) + ' 字' + (ch ? ' · ' + ch : '') + (x.cached ? ' · 缓存' : '');
                                    return '<div style="display:flex;gap:6px;align-items:center;">'
                                        + '<a href="' + dsEsc(href) + '" target="_blank" rel="noopener" '
                                        + 'style="display:flex;gap:6px;align-items:baseline;color:var(--ds-blue);text-decoration:none;'
                                        + 'flex:1 1 auto;min-width:0;padding:2px 0;line-height:1.5;"><b style="flex:0 0 auto;">来源' + (i + 1) + '</b>'
                                        + '<span style="flex:1 1 auto;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + dsEsc(label) + '</span>'
                                        + '<span style="flex:0 0 auto;opacity:.75;">' + dsEsc(meta) + '</span></a>'
                                        + '<button type="button" data-ds-save-url="' + dsEsc(x.url) + '" data-ds-save-title="' + dsEsc(label) + '" '
                                        + 'title="把这页存为资料" style="flex:0 0 auto;border:1px solid rgba(77,107,254,.45);background:transparent;'
                                        + 'color:var(--ds-blue);border-radius:6px;padding:1px 6px;font-size:.72rem;cursor:pointer;line-height:1.4;">📥</button>'
                                        + '</div>';
                                }).join('');
                                _lrLine += '<div style="display:flex;flex-direction:column;gap:2px;margin:0 0 8px;padding:6px 10px;'
                                    + 'border-radius:10px;border:1px solid rgba(77,107,254,0.25);background:rgba(77,107,254,0.05);'
                                    + 'font-size:0.74rem;">' + _rows + '</div>';
                            }
                        } else {
                            var _failList = (_lr.links || []).filter(function (x) { return x && !x.ok; })
                                .map(function (x) { return String(x.url).replace(/^https?:\/\//, '').slice(0, 40); }).slice(0, 3);
                            _lrLine = '<div style="' + base + 'rgba(184,118,58,0.35);background:rgba(184,118,58,0.10);color:var(--warning)">'
                                + dsEsc('🔗 链接未能读取（' + String(_lr.reason || '') + (_failList.length ? '：' + _failList.join('、') : '')
                                    + '）—— 已要求模型如实说明，不猜测内容') + '</div>';
                        }
                    }
                } catch (e) {}
                if (w.conflict) {
                    txt = '📎 本次含图片：已切换视觉通道（联网检索接口不支持图片，本次未联网）';
                    style = base + 'rgba(184,118,58,0.35);background:rgba(184,118,58,0.10);color:var(--warning)';
                } else if (w.failed) {
                    txt = '❌ 本次联网检索失败，回答未使用任何实时数据';
                    style = base + 'rgba(220,38,38,0.35);background:rgba(220,38,38,0.10);color:#dc2626';
                } else if (w.searches > 0) {
                    var qs = (w.queries && w.queries.length) ? '：' + w.queries.slice(0, 3).join('｜') : '';
                    var via = (w.channel === 'anthropic') ? '（Anthropic 联网通道）' : (w.channel === 'responses' ? '（Responses 通道）' : '');
                    txt = '🌐 已联网检索 ' + w.searches + ' 次' + via + qs;
                    style = base + 'rgba(77,107,254,0.35);background:rgba(77,107,254,0.10);color:var(--ds-blue)';
                } else if (!w.timeSensitive) {
                    // 按需检索：问候 / 闲聊 / 写作 / 代码 / 常识 / 资料分析等问题本就不需要联网，
                    // 模型未检索属正确行为，保持界面清爽，不显示任何提示条。
                    return '';
                } else {
                    var rf = w.retryFailed ? '（补搜亦失败：' + String(w.retryFailed).slice(0, 90) + '）' : '';
                    txt = '⚠️ 本次未取得实时检索结果' + rf + '，以下内容来自模型内部知识（可能已过时），请勿当作实时信息';
                    style = base + 'rgba(184,118,58,0.35);background:rgba(184,118,58,0.10);color:var(--warning)';
                }
                return _lrLine + '<div style="' + style + '">' + dsEsc(txt) + '</div>';
            }

            function dsBubbleInner(idx) {
                var m = dsHistory[idx];
                if (!m) return '';
                var reasoningHtml = '';
                if (m.reasoning) {
                    reasoningHtml = '<details class="ds-reasoning" open><summary>💭 思考过程</summary><div class="ds-reasoning-body">' + dsEsc(m.reasoning) + '</div></details>';
                }
                return reasoningHtml + dsAgentStepsHtml(m.agentSteps) + dsWebChip(m) + dsMarkdown(m.content || '');
            }

            // 【v3.76 智能体并入对话】把「计划 / 工具调用」渲染成卡片，跟着助手气泡一起显示。
            //   为什么存在消息对象上（m.agentSteps）而不是直接写 DOM：`dsRenderAll()` 每次都会重建聊天区，
            //   直接写 DOM 的卡片会在下一次重渲染时消失；挂在消息上则永远跟着这条回答。
            //   卡片样式与「智能体」原模块保持一致（黄=计划、绿=工具+用途/证据），用户视觉无需重新学习。
            function dsAgentStepsHtml(steps) {
                if (!steps || !steps.length) return '';
                var out = '';
                for (var i = 0; i < steps.length; i++) {
                    var s = steps[i] || {};
                    if (s.role === 'agent-plan') {
                        out += '<div class="ds-agent-plan" style="margin:6px 0;background:#fffbeb;border-left:3px solid #f59e0b;color:#b45309;border-radius:6px;padding:5px 10px;font-size:0.82rem;line-height:1.5;">' + dsEsc(s.content || '') + '</div>';
                    } else if (s.role === 'agent-tool') {
                        var meta = s.toolMeta || {};
                        var purpose = meta.purpose ? '<div style="color:#065f46;margin-top:2px;">用途：' + dsEsc(meta.purpose) + '</div>' : '';
                        var evidence = meta.evidence ? '<div style="color:#047857;margin-top:2px;white-space:pre-wrap;">证据：' + dsEsc(meta.evidence) + '</div>' : '';
                        out += '<div class="ds-agent-tool" style="margin:6px 0;background:#f0fdf4;border-left:3px solid #10b981;color:#047857;border-radius:6px;padding:6px 10px;font-size:0.82rem;line-height:1.5;">'
                            + '<div style="font-weight:600;">' + dsEsc(String(s.content || '').replace(/^🔧\s*/, '🔧 ')) + '</div>'
                            + purpose + evidence + '</div>';
                    }
                }
                return out ? '<div class="ds-agent-steps">' + out + '</div>' : '';
            }

            // ============ 媒体/链接渲染（图片 · 视频 · 音频 · 外链） ============
            // AI 回复中的 URL：图片/音视频直链自动渲染为可查看/可播放卡片；
            // 视频站点（B站/YouTube/腾讯）给内嵌播放按钮；其余渲染为可点击外链卡片。
            // 安全：所有 URL 经 dsSafeUrl 白名单校验（仅 http/https/blob/data:媒体），属性再经 dsEsc。
            var _dsStreaming = false; // 流式输出中→媒体降级为占位卡片，避免逐帧重建反复加载

            var DS_MEDIA_KIND = {};
            (function () {
                var map = {
                    image: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'avif', 'ico', 'jfif', 'heic', 'heif'],
                    video: ['mp4', 'webm', 'ogv', 'mov', 'm4v', 'mkv', 'm4p'],
                    audio: ['mp3', 'wav', 'm4a', 'aac', 'flac', 'oga', 'opus', 'weba', 'aiff', 'aif', 'amr', 'mpga']
                };
                Object.keys(map).forEach(function (k) {
                    map[k].forEach(function (e) { DS_MEDIA_KIND[e] = k; });
                });
            })();

            // 仅放行安全协议，杜绝 javascript: / vbscript: 等伪协议注入
            function dsSafeUrl(u) {
                var s = String(u == null ? '' : u).trim();
                if (!s) return '';
                if (/^https?:\/\//i.test(s)) return s;
                if (/^blob:/i.test(s)) return s;
                if (/^data:(?:image|audio|video)\//i.test(s)) return s;
                return '';
            }
            // 补全协议：模型常输出裸域名（pixabay.com/…、bilibili.com/video/BV…）
            function dsNormalizeUrl(u) {
                var s = String(u == null ? '' : u).trim();
                if (!s) return '';
                if (!/^[a-z][a-z0-9+.\-]*:/i.test(s)) s = 'https://' + s.replace(/^\/+/, '');
                return dsSafeUrl(s);
            }
            function dsUrlExt(u) {
                var m = String(u || '').toLowerCase().split(/[?#]/)[0].match(/\.([a-z0-9]{2,5})$/);
                return m ? m[1] : '';
            }
            function dsMediaKindOf(u) {
                var e = dsUrlExt(u);
                if (DS_MEDIA_KIND[e]) return DS_MEDIA_KIND[e];
                // 无扩展名但明显是图片直链的情况（Unsplash / Pixabay CDN 等常无后缀）
                var s = String(u || '');
                if (/(^|\.)(images\.unsplash\.com|cdn\.pixabay\.com|images\.pexels\.com|picsum\.photos|live\.staticflickr\.com)$/i.test(dsUrlHost(s))) return 'image';
                if (/\/(?:photo|image|img|picture)[-_]/i.test(s.split(/[?#]/)[0])) return 'image';
                return '';
            }
            function dsUrlName(u) {
                try {
                    var s = decodeURIComponent(String(u).split(/[?#]/)[0]);
                    var seg = s.split('/').pop();
                    return seg && seg.indexOf('.') > 0 ? seg : '';
                } catch (e) { return ''; }
            }
            function dsUrlHost(u) {
                var m = String(u || '').match(/^https?:\/\/([^/?#]+)/i);
                return m ? m[1] : String(u || '');
            }
            // 视频站点 → 可内嵌 iframe（null 表示不支持内嵌，降级为外链卡片）
            function dsSiteEmbed(u) {
                var s = String(u || '');
                var bv = s.match(/\/(BV[0-9A-Za-z]{10})/) || s.match(/(BV[0-9A-Za-z]{10})/);
                if (bv && /bilibili\.com|b23\.tv/i.test(s)) {
                    return { name: '哔哩哔哩', src: 'https://player.bilibili.com/player.html?bvid=' + bv[1] + '&autoplay=0&high_quality=1' };
                }
                var yt = s.match(/(?:v=|youtu\.be\/|embed\/|shorts\/)([A-Za-z0-9_-]{6,})/);
                if (yt && /youtube\.com|youtu\.be/i.test(s)) {
                    return { name: 'YouTube', src: 'https://www.youtube-nocookie.com/embed/' + yt[1] };
                }
                var qq = s.match(/v\.qq\.com\/x\/(?:cover|page)\/([^/]+)\/([a-zA-Z0-9]{10,})\.html/);
                if (qq) return { name: '腾讯视频', src: 'https://v.qq.com/txp/iframe/player.html?vid=' + qq[2] };
                return null;
            }
            function dsLinkCard(u, kind) {
                var icon = kind === 'image' ? '🖼️' : kind === 'video' ? '🎬' : kind === 'audio' ? '🎵' : '🔗';
                var tip = '';
                if (!kind && /pixabay|unsplash|pexels|500px|flickr|stock\./i.test(u)) {
                    icon = '🖼️';
                    tip = '<span class="ds-media-tip">图库页面，点开查看图片</span>';
                } else if (!kind) {
                    tip = '<span class="ds-media-tip">网页链接，点击打开</span>';
                }
                return '<div class="ds-media ds-media-link-box"><span class="ds-media-icon">' + icon + '</span>' +
                    '<a href="' + dsEsc(u) + '" target="_blank" rel="noopener">' + dsEsc(dsUrlHost(u)) + '</a>' +
                    tip +
                    '<span class="ds-media-url">' + dsEsc(u) + '</span></div>';
            }
            // url 为【未转义】原始 URL（允许无协议，内部自动补 https）
            function dsMediaBlock(url, alt) {
                var u = dsNormalizeUrl(url);
                if (!u) return '';
                var a = dsEsc(u);
                var kind = dsMediaKindOf(u);
                if (_dsStreaming) return dsLinkCard(u, kind); // 流式期间只出占位，结束后再换成播放器
                if (kind === 'image') {
                    return '<figure class="ds-media ds-media-img-box">' +
                        '<img class="ds-media-img" src="' + a + '" alt="' + dsEsc(alt || dsUrlName(u) || '图片') + '" loading="lazy" referrerpolicy="no-referrer">' +
                        '<figcaption class="ds-media-cap">🖼️ <a href="' + a + '" target="_blank" rel="noopener">查看原图</a></figcaption></figure>';
                }
                if (kind === 'video') {
                    return '<div class="ds-media ds-media-video-box" data-ds-src="' + a + '">' +
                        '<video class="ds-media-video" src="' + a + '" controls preload="metadata" playsinline></video>' +
                        '<div class="ds-media-cap">🎬 <a href="' + a + '" target="_blank" rel="noopener">新窗口打开</a></div></div>';
                }
                if (kind === 'audio') {
                    return '<div class="ds-media ds-media-audio-box" data-ds-src="' + a + '">' +
                        '<span class="ds-media-icon">🎵</span>' +
                        '<div class="ds-media-audio-main">' +
                        '<div class="ds-media-audio-name">' + dsEsc(dsUrlName(u) || '音频') + '</div>' +
                        '<audio class="ds-media-audio" src="' + a + '" controls preload="metadata"></audio>' +
                        '</div><a class="ds-media-open" href="' + a + '" target="_blank" rel="noopener" title="新窗口打开">↗</a></div>';
                }
                var site = dsSiteEmbed(u);
                if (site) {
                    // 直接内嵌播放器（loading=lazy，滚动到才加载，避免一次拉起多个播放器）
                    return '<div class="ds-media ds-media-site" data-ds-embed="' + dsEsc(site.src) + '" data-ds-page="' + a + '" data-ds-name="' + dsEsc(site.name) + '">' +
                        '<iframe class="ds-media-iframe" src="' + dsEsc(site.src) + '" loading="lazy" frameborder="0" scrolling="no" ' +
                        'allowfullscreen="true" referrerpolicy="no-referrer" title="' + dsEsc(site.name) + '"></iframe>' +
                        '<div class="ds-media-cap">' + dsEsc(site.name) + ' 内嵌播放 · ' +
                        '<a href="' + a + '" target="_blank" rel="noopener">新窗口打开 ↗</a> · ' +
                        '<button type="button" class="ds-media-reload">🔄 重新加载</button></div></div>';
                }
                return dsLinkCard(u, '');
            }
            // ===== 媒体块复用：重建 innerHTML 时绝不丢掉已加载的播放器/图片 =====
            // 为什么必须这么做（2026-09-12 实测定位）：气泡内容会在「流式结束渲染」「页面增强
            // (unified-enhancements 的 enhanceBubbles)」以及每一次 dsRenderAll 时被整块 innerHTML 覆盖。
            // 元素一旦被销毁，浏览器立即丢弃它的缓冲区、readyState 与播放进度；新插入的同 src 元素会
            // **从头重新发起请求**。实测同一条回复里 <video>/<audio> 的 URL 被请求 3 次、字节重复传输 2 遍
            // ——在真实外链（视频动辄几十 MB）上，这就是「转圈很久才出画面、播放卡顿」的主因。
            // 做法：重建前按媒体块容器上的 data-ds-src / data-ds-page 收集旧块 → 写新 HTML →
            // 按出现顺序一对一，把新块原位换回旧块（保留缓冲、播放进度、以及已展开的内嵌播放器）。
            // 安全性：搬回去的是**文档中已存在的同一个节点**，不引入新的解析路径，故不削弱 XSS 防护
            //（新 HTML 仍先经 DOMPurify 净化，复用只发生在净化之后）。
            function _dsMediaKey(box) {
                if (!box || !box.getAttribute) return '';
                var k = box.getAttribute('data-ds-src') || box.getAttribute('data-ds-page') ||
                        box.getAttribute('data-ds-embed') || '';
                if (k) return k;
                // 图片块（figure）外层没有 data-ds-*，退回取内部 img 的 src 作为身份标识
                var inner = box.querySelector ? box.querySelector('img[src], video[src], audio[src], iframe[src]') : null;
                return inner ? (inner.getAttribute('src') || '') : '';
            }
            function _dsIsPlaceholder(box) {
                return !!(box && box.classList && box.classList.contains('ds-media-link-box'));
            }
            // 递归地把 root 子树里的 .ds-media（按 key 匹配）原位替换为 keepArr 里的旧元素。
            // 用 template.content 作 root 时整棵子树仍是 inert（不触发资源加载），
            // 等替换完再统一 appendChild 到 host，**保持原 DOM 嵌套结构**——这是关键：
            // 之前简单地把媒体直接 appendChild 到 host 根，会把媒体从原气泡内搬到 box 根下，
            // 看起来"找不到媒体元素"就是这个问题。
            // 全局媒体元素池：key(URL) → 已加载过的媒体块元素。
            // 为什么还需要它：光在 host 内部复用不够。dsRenderAll 会整块重建会话列表，
            // 旧气泡连同里面**已经缓冲好**的播放器一起被丢弃，新气泡里同 URL 的媒体又是从零开始
            // ——实测这条路径让 <video>/<audio> 多下一遍整段。
            // 浏览器对「已加载的媒体元素」在脱离文档后仍保留缓冲（实测 detach→attach 不会再发请求），
            // 所以把被丢弃的元素收进池里，下次渲染同 URL 直接搬回来即可。
            var _dsMediaPool = new Map();
            var _dsMediaPoolOrder = [];
            function _dsPoolPut(el) {
                var k = _dsMediaKey(el);
                if (!k) return;
                if (!_dsMediaPool.has(k)) _dsMediaPoolOrder.push(k);
                _dsMediaPool.set(k, el);
                while (_dsMediaPoolOrder.length > 40) {           // 防止无限增长
                    var old = _dsMediaPoolOrder.shift();
                    if (_dsMediaPool.get(old) === el) continue;
                    _dsMediaPool.delete(old);
                }
            }
            // 只回收「已经脱离文档」的元素；仍挂在别处（比如另一条消息也在展示它）的不能搬走
            function _dsPoolTake(key, host) {
                var el = _dsMediaPool.get(key);
                if (!el || !el.nodeType) { _dsMediaPool.delete(key); return null; }
                if (el.isConnected) return null;                  // 还在用 → 不动
                if (host && host.contains && host.contains(el)) return null;
                return el;
            }
            function _dsPoolScan(root) {
                if (!root || !root.querySelectorAll) return;
                try {
                    var list = root.querySelectorAll('.ds-media');
                    for (var i = 0; i < list.length; i++) {
                        if (_dsIsPlaceholder(list[i])) continue;
                        if (_dsMediaKey(list[i])) _dsPoolPut(list[i]);
                    }
                } catch (e) {}
            }
            function _dsSwapMedia(root, keepArr, used, host, stat) {
                if (!root || !root.childNodes || !root.childNodes.length) return;
                if (!stat) stat = { hit: 0, pool: 0, miss: 0 };
                var kids = Array.prototype.slice.call(root.childNodes);
                for (var i = 0; i < kids.length; i++) {
                    var c = kids[i];
                    if (c.nodeType !== 1) continue;
                    if (_dsIsPlaceholder(c)) continue;
                    if (c.classList && c.classList.contains('ds-media')) {
                        var key = _dsMediaKey(c);
                        if (key) {
                            var done = false;
                            for (var m = 0; m < keepArr.length; m++) {   // ① 优先用本气泡内原有的
                                if (used[m] || keepArr[m].key !== key) continue;
                                used[m] = 1;
                                if (c.parentNode) c.parentNode.replaceChild(keepArr[m].el, c);
                                done = true;
                                stat.hit++;
                                break;
                            }
                            if (!done) {                                  // ② 退回全局池（跨气泡复用）
                                var pooled = _dsPoolTake(key, host);
                                if (pooled && c.parentNode) {
                                    c.parentNode.replaceChild(pooled, c);
                                    _dsMediaPool.delete(key);
                                    stat.pool++;
                                } else {
                                    stat.miss++;
                                }
                            }
                        }
                    } else if (c.childNodes && c.childNodes.length) {
                        _dsSwapMedia(c, keepArr, used, host, stat);
                    }
                }
            }
            function dsSetHtmlKeepMedia(host, html) {
                if (!host) return;
                // 内容完全没变就别重建：流式结束后的「最终渲染 / dsRenderAll / 页面增强」会连续
                // 用同一份 HTML 写好几遍，每一步 detach→attach 都可能让媒体再取一次流。
                if (host.__dsLastHtml === html) return;
                host.__dsLastHtml = html;

                var keep = [];
                try {
                    var olds = host.querySelectorAll('.ds-media');
                    for (var i = 0; i < olds.length; i++) {
                        if (_dsIsPlaceholder(olds[i])) continue;
                        var ok = _dsMediaKey(olds[i]);
                        if (ok) keep.push({ key: ok, el: olds[i] });
                    }
                } catch (e) { keep = []; }

                // 始终先解析到 <template>（inert，不触发任何资源加载），再决定怎么落地
                var tpl = document.createElement('template');
                try { tpl.innerHTML = html; } catch (e) { host.innerHTML = html; return; }

                var used = {};
                var stat = { hit: 0, pool: 0, miss: 0 };
                _dsSwapMedia(tpl.content, keep, used, host, stat);

                host.innerHTML = '';
                host.appendChild(tpl.content);
                _dsPoolScan(host);          // 记下本次渲染出的媒体，供后续跨气泡复用
            }
            window.dsSetHtmlKeepMedia = dsSetHtmlKeepMedia;
            // 链接识别：① 带协议 URL；② 裸域名（模型常输出 pixabay.com/xxx、bilibili.com/video/BV…）
            // 中文/全角字符不参与链接，避免把紧跟 URL 的中文正文吞进链接
            var DS_TLD_STR = 'com|cn|net|org|io|co|tv|me|cc|info|biz|xyz|top|site|online|shop|gov|edu|jp|uk|de|ru|kr|hk|tw|sg|au|ca|us';
            var DS_LINK_CHUNK = '(?:https?:\\/\\/[^\\s<>"\'\\u4e00-\\u9fa5\\u3000-\\u303f\\uff00-\\uffef]+' +
                '|(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\\.)+(?:' + DS_TLD_STR + ')(?:\\/[^\\s<>"\'\\u4e00-\\u9fa5]*)?)';
            var DS_URL_RE = new RegExp(DS_LINK_CHUNK, 'gi');
            var DS_LINE_URL_RE = new RegExp('^' + DS_LINK_CHUNK + '$', 'i');
            var DS_TAIL_URL_RE = new RegExp(DS_LINK_CHUNK + '$', 'i');
            // 在【已转义】文本上把 URL / 裸域名变成可点击链接（点击即在浏览器新标签打开）
            function dsAutoLink(escaped) {
                return String(escaped).replace(DS_URL_RE, function (m) {
                    var url = m.replace(/[),.;:!?'"\]）】》]+$/, '');
                    var tail = m.slice(url.length);
                    var label = m.slice(0, m.length - tail.length);
                    if (!/^https?:/i.test(url)) {
                        // 裸域名：无路径且非 www 开头时视为普通文本，避免误伤
                        if (url.indexOf('/') === -1 && !/^www\./i.test(url)) return m;
                        url = 'https://' + url;
                    }
                    if (!dsSafeUrl(url)) return m;
                    return '<a href="' + url + '" target="_blank" rel="noopener" class="ds-md-link">' + label + '</a>' + tail;
                });
            }
            // 图片全屏预览
            function dsShowImageViewer(src) {
                var safe = dsSafeUrl(src);
                if (!safe) return;
                var old = document.getElementById('ds-image-viewer');
                if (old && old.remove) old.remove();
                var wrap = document.createElement('div');
                wrap.id = 'ds-image-viewer';
                wrap.className = 'ds-image-viewer';
                var close = function () { if (wrap.remove) wrap.remove(); document.removeEventListener('keydown', onKey); };
                var onKey = function (ev) { if (ev.key === 'Escape' || ev.key === 'Esc') close(); };
                var btn = document.createElement('button');
                btn.type = 'button';
                btn.className = 'ds-image-viewer-close';
                btn.textContent = '✕';
                btn.onclick = close;
                var img = document.createElement('img');
                img.className = 'ds-image-viewer-img';
                img.src = safe;
                img.alt = '图片预览';
                wrap.appendChild(btn);
                wrap.appendChild(img);
                wrap.addEventListener('click', function (ev) { if (ev.target === wrap) close(); });
                document.addEventListener('keydown', onKey);
                document.body.appendChild(wrap);
            }
            window.dsShowImageViewer = dsShowImageViewer;
            // 站点内嵌播放：点击后才创建 iframe，避免一次加载多个播放器
            function dsMountEmbed(host) {
                var src = dsSafeUrl(host.getAttribute('data-ds-embed'));
                var page = dsSafeUrl(host.getAttribute('data-ds-page'));
                var name = host.getAttribute('data-ds-name') || '视频';
                if (!src) return;
                // 互斥播放：拉起本站点播放器 = 用户新开了一路声音，先把其它正在播的停掉；
                // 同时标记本播放器「已激活」，之后别人开播时它才会被卸载（见 dsStopOtherMedia ②）。
                dsStopOtherMedia(null, host);
                host.setAttribute('data-ds-embed-active', '1');
                // 重建整个结构（而不只是 iframe）：原先清空 host 后只放回 iframe + 一个外链，
                // 导致 caption 行与「🔄 重新加载」按钮一起消失 —— 用户点过一次就再也无法重载。
                host.innerHTML = '';
                var f = document.createElement('iframe');
                f.className = 'ds-media-iframe';
                f.src = src;
                f.setAttribute('loading', 'lazy');
                f.setAttribute('frameborder', '0');
                f.setAttribute('allowfullscreen', 'true');
                f.setAttribute('scrolling', 'no');
                f.setAttribute('referrerpolicy', 'no-referrer');
                f.title = name;
                host.appendChild(f);
                var cap = document.createElement('div');
                cap.className = 'ds-media-cap';
                cap.appendChild(document.createTextNode(name + ' 内嵌播放 · '));
                if (page) {
                    var a = document.createElement('a');
                    a.href = page; a.target = '_blank'; a.rel = 'noopener';
                    a.textContent = '新窗口打开 ↗';
                    cap.appendChild(a);
                    cap.appendChild(document.createTextNode(' · '));
                }
                var btn = document.createElement('button');
                btn.type = 'button';
                btn.className = 'ds-media-reload';
                btn.textContent = '🔄 重新加载';
                cap.appendChild(btn);
                host.appendChild(cap);
            }
            // 媒体加载失败后重建播放器（「重试」用）：走 dsMediaBlock 生成同样的结构再取内部 HTML，
            // 保证重建出来的播放器与首次渲染完全一致（含 caption / 新窗口入口）。
            function dsRebuildMedia(host) {
                if (!host) return;
                var src = host.getAttribute('data-ds-src');
                if (!src) return;
                host.removeAttribute('data-ds-failed');
                try {
                    var tmp = document.createElement('div');
                    tmp.innerHTML = dsMediaBlock(src, '');
                    var box = tmp.firstChild;
                    host.innerHTML = box ? box.innerHTML : '';
                } catch (e) {}
            }
            // 按 MediaError.code + 扩展名给出**可操作**的诊断，而不是笼统一句「加载失败」：
            //   MEDIA_ERR_ABORTED(1) / MEDIA_ERR_NETWORK(2) → 网络中断、链接失效或源站防盗链
            //   MEDIA_ERR_DECODE(3)                          → 文件损坏或编码不受支持
            //   MEDIA_ERR_SRC_NOT_SUPPORTED(4)               → 拿到的不是媒体文件（多为网页地址），
            //                                                  或容器/编码浏览器不支持（MKV / FLV / 部分 MOV 常见）
            function dsMediaFailText(err, src, kind) {
                // 图片没有 MediaError（t.error 为 undefined），单独给更贴切的说明，避免把图片说成「媒体」
                if (kind === 'image') return '⚠️ 图片加载失败：链接已失效，或该站点禁止外部直接引用';
                var code = (err && err.code) || 0;
                var ext = dsUrlExt(src);
                var extTip = ext ? '（.' + ext + '）' : '';
                if (code === 4) {
                    if (/^(mkv|flv|rm|rmvb|wmv|avi|ts|m3u8)$/.test(ext)) {
                        return '⚠️ 浏览器无法直接播放 ' + extTip + '：多为编码/容器不受支持，请点「新窗口打开」用本地播放器观看';
                    }
                    return '⚠️ 无法播放' + extTip + '：该地址返回的不是媒体文件（可能是网页链接），或服务器拒绝了直连';
                }
                if (code === 3) return '⚠️ 无法播放' + extTip + '：文件已损坏或编码不受支持';
                if (code === 2) return '⚠️ 加载失败' + extTip + '：网络中断、链接失效，或源站限制外部直连（防盗链）';
                if (code === 1) return '⚠️ 加载被中断，可点「重试」';
                return '⚠️ 资源加载失败（链接失效、防盗链或不支持的格式）';
            }
            // ===== 音视频互斥播放（2026-09-12 用户要求）=====
            // 需求原话：「点开一个另一个就得关闭，不然同时播放多个音视频，太乱」。即同一时刻
            // 全局只允许一路音视频在播，对齐微信/豆包的做法。分三类声音源处理：
            //  ① 原生 <video>/<audio>：直接 pause()，可靠无副作用（暂停只触发 pause 事件，不会回环触发本逻辑）；
            //  ② 站点内嵌播放器（B站/YouTube/腾讯视频）：跨域 iframe 没有对外的暂停接口，
            //     唯一可行的止声手段是把 iframe 整个摘掉（销毁浏览上下文即立刻停止声音），
            //     同时还原成「▶ 继续内嵌播放」按钮 —— 入口不丢，想看再点一下即可；
            //  ③ 语音朗读（speechSynthesis）：属于另一路声音，一并停掉，避免"朗读还在念、视频又响了"。
            // ⚠️ ②不能无脑全摘：历史消息里往往挂着好几个内嵌播放器，但多数只是挂着没在播
            // （dsSiteEmbed 生成时带 autoplay=0）。把没在播的一起摘掉会让人莫名其妙。
            // 故只处理「用户真的碰过」的那些 —— 判定见 dsInitMediaDelegates 里的 data-ds-embed-active 标记。
            function dsUnmountEmbed(host) {
                if (!host) return false;
                var f = host.querySelector('iframe.ds-media-iframe');
                if (!f || !f.parentNode) return false;
                var btn = document.createElement('button');
                btn.type = 'button';
                btn.className = 'ds-media-play';
                btn.textContent = '▶ 继续内嵌播放';
                f.parentNode.replaceChild(btn, f);
                host.removeAttribute('data-ds-embed-active');
                return true;
            }
            // exceptNative：正在播放、要放行的原生播放器；exceptSite：正在播放、要放行的内嵌播放器宿主
            function dsStopOtherMedia(exceptNative, exceptSite) {
                // ① 原生播放器：暂停其余所有
                try {
                    var list = document.querySelectorAll('video.ds-media-video, audio.ds-media-audio');
                    for (var i = 0; i < list.length; i++) {
                        var m = list[i];
                        if (m === exceptNative || m.paused) continue;
                        try { m.pause(); } catch (e) {}
                    }
                } catch (e) {}
                // ② 内嵌播放器：只卸载「标记为已激活」的（用户点进去播过的）
                try {
                    var act = document.querySelectorAll('.ds-media-site[data-ds-embed-active="1"]');
                    for (var j = 0; j < act.length; j++) {
                        if (exceptSite && act[j] === exceptSite) continue;
                        dsUnmountEmbed(act[j]);
                    }
                } catch (e) {}
                // ③ 语音朗读：停掉并把按钮文字复位（cancel 不保证触发 onend，故主动复位）
                try {
                    if (window.speechSynthesis && window.speechSynthesis.speaking) {
                        window.speechSynthesis.cancel();
                        var rbs = document.querySelectorAll('.ds-read-btn');
                        for (var k = 0; k < rbs.length; k++) {
                            if (rbs[k].textContent === '⏹ 停止') rbs[k].textContent = '🔊 朗读';
                        }
                    }
                } catch (e) {}
            }
            // 全局事件委托：图片放大 / 内嵌播放 / 资源加载失败降级（DOMPurify 会剥掉内联 onerror，故用委托）
            function dsInitMediaDelegates() {
                if (window.__dsMediaDelegates) return;
                window.__dsMediaDelegates = true;
                document.addEventListener('click', function (e) {
                    var t = e.target;
                    if (!t || !t.closest) return;
                    var img = t.closest('img.ds-media-img');
                    if (img && img.getAttribute('src')) { e.preventDefault(); dsShowImageViewer(img.getAttribute('src')); return; }
                    // 「重试」：按 data-ds-src 原样重建播放器（瞬时网络抖动时不必重发问题）
                    var retry = t.closest('.ds-media-retry');
                    if (retry) {
                        e.preventDefault();
                        dsRebuildMedia(retry.closest('.ds-media'));
                        return;
                    }
                    var play = t.closest('.ds-media-play, .ds-media-reload');
                    if (play) {
                        e.preventDefault();
                        var host = play.closest('.ds-media-site');
                        if (host) dsMountEmbed(host);
                    }
                });
                // error 不冒泡，用捕获阶段
                document.addEventListener('error', function (e) {
                    var t = e.target;
                    if (!t || !t.classList) return;
                    if (!(t.classList.contains('ds-media-img') || t.classList.contains('ds-media-video') || t.classList.contains('ds-media-audio'))) return;
                    var src = t.getAttribute('src') || '';
                    var host = t.closest ? t.closest('.ds-media') : null;
                    if (!host) { // 行内图片：降级为文本链接
                        var p = t.parentNode;
                        if (!p) return;
                        var lnk = document.createElement('a');
                        lnk.href = dsSafeUrl(src) || '#'; lnk.target = '_blank'; lnk.rel = 'noopener';
                        lnk.textContent = dsUrlName(src) || src;
                        p.replaceChild(lnk, t);
                        return;
                    }
                    if (host.getAttribute('data-ds-failed')) return;
                    host.setAttribute('data-ds-failed', '1');
                    host.innerHTML = '';
                    var tip = document.createElement('div');
                    tip.className = 'ds-media-fail';
                    tip.textContent = dsMediaFailText(t.error, src, t.classList.contains('ds-media-img') ? 'image' : '');
                    host.appendChild(tip);
                    // 失败不再只给一个「新窗口打开」：瞬时网络抖动/防盗链都可能重试成功，
                    // 且「重试」不必让用户重新向 AI 发一遍问题（豆包等产品同样提供了重试入口）。
                    var row = document.createElement('div');
                    row.className = 'ds-media-fail-row';
                    var retryBtn = document.createElement('button');
                    retryBtn.type = 'button';
                    retryBtn.className = 'ds-media-retry';
                    retryBtn.textContent = '🔄 重试';
                    row.appendChild(retryBtn);
                    var a2 = document.createElement('a');
                    a2.href = dsSafeUrl(src) || '#'; a2.target = '_blank'; a2.rel = 'noopener';
                    a2.textContent = '在新窗口打开 ↗';
                    row.appendChild(a2);
                    host.appendChild(row);
                }, true);
                // 互斥播放①：某个原生播放器开始播放 → 停掉其余音视频。
                // play 事件不冒泡，只能走捕获阶段（与上面的 error 同理）。
                document.addEventListener('play', function (e) {
                    var t = e.target;
                    if (!t || !t.classList) return;
                    if (!(t.classList.contains('ds-media-video') || t.classList.contains('ds-media-audio'))) return;
                    dsStopOtherMedia(t, null);
                }, true);
                // 互斥播放②的判定：跨域 iframe 不会把用户的点击冒泡给父文档，无法直接监听"iframe 里开始播了"。
                // 但用户点击播放器时，父窗口会 blur 且 document.activeElement 变成该 iframe —— 借此标记
                // "这个内嵌播放器被用户动过"，后续互斥时才敢把它摘掉（没动过的挂着不动）。
                window.addEventListener('blur', function () {
                    setTimeout(function () {
                        try {
                            var ae = document.activeElement;
                            if (!ae || ae.tagName !== 'IFRAME' || !ae.closest) return;
                            var st = ae.closest('.ds-media-site');
                            if (st) st.setAttribute('data-ds-embed-active', '1');
                        } catch (err) {}
                    }, 0);
                }, true);
            }
            dsInitMediaDelegates();

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
                    // 整段就是一个链接（常见于表格单元格、列表项）→ 直接渲染媒体/内嵌播放卡片
                    var solo = String(str == null ? '' : str).trim();
                    if (solo && DS_LINE_URL_RE.test(solo) && !/^!\[/.test(solo)) {
                        return dsMediaBlock(solo, '');
                    }
                    // 「短前缀 + 媒体直链」的行内场景：`- 视频：https://x.mp4`、`| 音频 | 音频：https://x.mp3 |`
                    // 段落行由块级 DS_TAIL_URL_RE 分支处理，但那里**显式排除了列表项/有序列表**
                    // （见 !/^[-*]\s/ 与 !/^\d+\./ 两个条件，本意是避免列表里所有 URL 都膨胀成大卡片）。
                    // 后果：同样是「视频：https://…」，写成段落能内嵌播放，写进列表却只剩一个链接 ——
                    // 而 AI 恰恰最常用「1. 视频地址：…」这种列表形式，用户就会以为「视频播不了」。
                    // 这里只补【媒体类型】（图片/音视频直链）与【可内嵌的视频站】，普通网页链接仍保持行内 <a>。
                    var _soloTail = solo.match(DS_TAIL_URL_RE);
                    if (_soloTail && _soloTail[0] && solo.length - _soloTail[0].length <= 16 &&
                        !/^!?\[[^\]]*\]\(/.test(solo)) {
                        var _soloUrl = dsNormalizeUrl(_soloTail[0]);
                        if (_soloUrl && (dsMediaKindOf(_soloUrl) || dsSiteEmbed(_soloUrl))) {
                            // 前缀（如「现场作业视频：」）保留下来作为说明，别让它随媒体行一起消失
                            var _soloPre = solo.slice(0, solo.length - _soloTail[0].length).trim();
                            return (_soloPre ? dsEsc(_soloPre) + ' ' : '') + dsMediaBlock(_soloTail[0], '');
                        }
                    }
                    let s = dsEsc(str);
                    // 1) markdown 图片/链接先占位，避免后续裸 URL 正则污染已生成的 href
                    const links = [];
                    s = s.replace(/!?\[([^\]]*)\]\((https?:\/\/[^\s)]+|data:(?:image|audio|video)\/[^\s)]+)\)/g, function (m, txt, url) {
                        links.push({ img: m.charAt(0) === '!', txt: txt, url: url });
                        return '@@DSLINK@@' + (links.length - 1) + '@@';
                    });
                    s = s.replace(/`([^`]+)`/g, '<code class="ds-md-code">$1</code>');
                    s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
                    s = s.replace(/\*([^*]+)\*/g, '<em>$1</em>');
                    s = s.replace(/~~([^~]+)~~/g, '<del>$1</del>');
                    // 2) 裸 URL 自动变成可点击链接（新标签打开）
                    s = dsAutoLink(s);
                    // 3) 还原 markdown 图片/链接 —— 复用块级媒体渲染：
                    //    视频站点(B站/YouTube/腾讯) → 内嵌播放器；图片/音视频直链 → 内嵌播放器；普通网页 → 外链卡片
                    //    覆盖表格/列表/段落里的链接（之前只对"独立成行"生效，导致表格单元格内链接仍是普通 <a>）
                    s = s.replace(/@@DSLINK@@(\d+)@@/g, function (m, i) {
                        const l = links[+i];
                        if (!l) return '';
                        const safe = dsSafeUrl(l.url);
                        if (!safe) return m;
                        const kind = dsMediaKindOf(safe);
                        if (l.img && kind === 'image') {
                            // alt 必须转义：l.txt 是 markdown 链接文本（可含双引号），而本行是块级版本
                            // （:3197 用 dsEsc）之外唯一漏转义的插值点；其产物由 dsSetHtmlKeepMedia
                            // 直接落地、不经净化，未转义即可闭合属性注入事件处理器。
                            return '<img class="ds-media-img ds-media-img-inline" src="' + safe + '" alt="' + dsEsc(l.txt || '') + '" loading="lazy" referrerpolicy="no-referrer">';
                        }
                        // 非 ![](md 图片) 语法的行内/表格链接 → 全部走块级媒体渲染：
                        //   视频站点 → 内嵌 iframe；视频/音频直链 → 内嵌播放器；图片直链 → 内嵌图片；
                        //   普通网页 → 外链卡片。覆盖表格/列表/段落里的链接。
                        return dsMediaBlock(safe, l.txt || '');
                    });
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
                    // 独立成行的链接（含裸域名）：图片/音视频直链内嵌播放，站点链接给内嵌播放卡片，其余给外链卡片
                    var onlyLine = line.trim();
                    if (DS_LINE_URL_RE.test(onlyLine)) {
                        closeList();
                        out.push(dsMediaBlock(onlyLine, ''));
                        i++; continue;
                    }
                    var imgMd = onlyLine.match(/^!\[([^\]]*)\]\((https?:\/\/[^\s)]+|data:image\/[^\s)]+)\)$/);
                    if (imgMd) {
                        closeList();
                        out.push(dsMediaBlock(imgMd[2], imgMd[1]));
                        i++; continue;
                    }
                    // 形如「图片：https://…」「现场作业视频：https://…」的前缀行同样识别为媒体行。
                    // ⚠️ 前缀长度阈值必须放到 16：原先定的是 6，只能覆盖「视频：」「音频：」这类极短前缀，
                    //    而 AI 实际最常写的是「现场作业视频：」「隐患照片：」「检查实录：」这类 6~8 字的说明
                    //    ——超过 6 就被判成普通文本行，媒体直链退化成一行链接，用户看到的就是「视频播不了」。
                    //    阈值放宽是安全的：仍需「URL 位于行尾」且前缀不含其它内容，正文里夹带网址不会被误判。
                    // 前缀文字保留下来（作为说明），不再丢弃。
                    // ⚠️ 必须排除 markdown 链接/图片语法 `[文字](url)`：DS_LINK_CHUNK 的字符类不排除 `)`，
                    //    会把 `[看这里](https://a.com/x.png)` 的尾部当成「以 ) 结尾的 URL」抢先捕获，
                    //    结果多吞一个右括号、丢给外链卡片，图片/视频就不会渲染（且链接是坏地址）。
                    //    这类语法统一交给 inline() 处理，那里有正确的 DSLINK 还原逻辑。
                    var tailUrl = onlyLine.match(DS_TAIL_URL_RE);
                    if (tailUrl && tailUrl[0] && onlyLine.length - tailUrl[0].length <= 16 &&
                        !/^[-*]\s/.test(onlyLine) && !/^\d+\./.test(onlyLine) &&
                        !/^!?\[[^\]]*\]\(/.test(onlyLine)) {
                        closeList();
                        var prefixText = onlyLine.slice(0, onlyLine.length - tailUrl[0].length).trim();
                        if (prefixText) out.push('<p class="ds-md-p">' + dsEsc(prefixText) + '</p>');
                        out.push(dsMediaBlock(tailUrl[0], ''));
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
        // 【v3.76】智能体执行步骤卡片：暴露给 unified-enhancements.js（它按 entry.content 重渲染气泡，
        //   凡 dsBubbleInner 会渲染的字段都必须在那边一并还原，否则卡片会被覆盖 —— 与 dsWebChip 同一套路）
        window.dsAgentStepsHtml       = typeof dsAgentStepsHtml !== 'undefined' ? dsAgentStepsHtml : function(){ return ''; };
        window.dsAppendMsg            = typeof dsAppendMsg !== 'undefined' ? dsAppendMsg : function(){};
        window.getDsHistory           = (typeof dsHistory !== 'undefined') ? function(){ return dsHistory; } : function(){ return []; };
        // 联网检索证据条：供 unified-enhancements.js 卡片化重渲染时一并重建（否则会被覆盖掉）
        window.dsWebChip              = typeof dsWebChip !== 'undefined' ? dsWebChip : function(){ return ''; };
        // 联网通道辅助（自检/测试用）：Anthropic 端点推导 + 消息体转换
        window.dsAnthropicUrlCandidates = typeof dsAnthropicUrlCandidates !== 'undefined' ? dsAnthropicUrlCandidates : function(){ return []; };
// 【2026-09-23】同样暴露 Responses 候选端点：`dsWebSearchOnce`（无 UI 联网一问一答，见 doubao-common.js）
//   在 Anthropic 通道不可用时要能换到 Responses 通道（其它供应商场景）。
window.dsResponsesUrlCandidates = typeof dsResponsesUrlCandidates !== 'undefined' ? dsResponsesUrlCandidates : function(){ return []; };
        window.dsBuildAnthropicMessages = typeof dsBuildAnthropicMessages !== 'undefined' ? dsBuildAnthropicMessages : function(){ return []; };

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
          '【纪律】引用业务数据必须注明来源与出处，不得编造规章编号或案例；不确定处明确"待核实"。\n' +
          '【专业路由】专业归属不明确时，按最相关的专业框架作答并在开头一句说明依据；只有不同专业会得出相反结论时才追问，不要用"请先说明专业"代替作答。\n' +
          '【术语纪律】用行业规范术语（进路、分路不良、侵限、登销记、人机环管等），不用口语化代称；引用须到"规则名 + 条款层级"，记不准就标"条号待核实"，绝不编造编号。',
        'dianwu':
          '你是电务（信号）安全监察专家。\n' +
          '【专业领域】信号联锁、CTC/TDCS 调度集中、列控系统（CTCS）、轨道电路（ZPW-2000）、微机监测、区间闭塞、应答器、信号机、电源屏、光电缆。\n' +
          '【应熟悉规章】《铁路技术管理规程》（信号部分）、《铁路信号维护规则》、《信号设备故障处理规则》、《铁路营业线施工安全管理办法》、《铁路交通事故应急救援和调查处理条例》。\n' +
          '【典型风险】联锁关系失效、轨道电路分路不良、CTC 错办进路、微机监测漏报警、施工联锁试验不彻底、列控数据错误、电源屏故障、光电缆中断。\n' +
          '【分析框架】从"设备状态→联锁逻辑→作业流程→施工管控"四维度核查，引用本地规章与历史检查问题，按风险分级给出整改建议。\n' +
          '【术语与条款】规范术语：联锁关系、进路、区段、分路不良、轨道电路、列控（CTCS）、应答器、微机监测；引用须到"规则名 + 条款层级"，记不准就标"条号待核实"。\n' +
          '【专业边界】只对信号设备状态与联锁作业定性；进路办理与行车指挥归车务、接触网归供电、无线列调归通信，涉及多专业时点明主责与协同。\n' +
          '【必查项点】联锁关系表与联锁试验记录、轨道电路分路不良台账及处置、CTC/TDCS 命令核对、施工登销记与设备状态交接、微机监测报警闭环。',
        'gongwu':
          '你是工务安全监察专家。\n' +
          '【专业领域】线路、桥隧、路基、道岔、钢轨及无缝线路、钢轨探伤、防洪、防胀、防断、周边环境。\n' +
          '【应熟悉规章】《铁路技术管理规程》（工务）、《铁路线路修理规则》、《铁路桥隧建筑物修理规则》、《铁路路基大维修规则》、《防洪工作管理办法》、《铁路营业线施工安全管理办法》。\n' +
          '【典型风险】线路几何尺寸超限、钢轨伤损/折断、道岔尖轨病害、桥隧衬砌劣化渗漏水、防洪重点处所水害、胀轨跑道、施工开挖破坏路基、周边违建/采砂侵限。\n' +
          '【分析框架】结合季节性风险（防洪/防胀/防断），从"设备状态→季节性风险→施工作业→周边环境"四维度分析，引用本地数据与规章。\n' +
          '【术语与条款】规范术语：轨距/水平/高低/方向/三角坑、尖轨与基本轨、锁定轨温、钢轨轻伤与重伤、路基病害、限界；引用须到"规则名 + 条款层级"，记不准就标"条号待核实"。\n' +
          '【专业边界】只对线路、桥隧、路基等设备状态定性；站台/雨棚侵限归房建，施工计划与行车条件归车务，涉及多专业时点明主责与协同。\n' +
          '【必查项点】轨道几何尺寸检查记录与超限处所、探伤重伤处置闭环、道岔结构与密贴检查、防洪重点处所与看守、施工慢行与防护设置。',
        'gongdian':
          '你是供电安全监察专家。\n' +
          '【专业领域】接触网、牵引变电所、电力线路、SCADA 远动、分段绝缘器、补偿装置、接地与过电压。\n' +
          '【应熟悉规章】《铁路技术管理规程》（供电）、《接触网运行检修规程》、《牵引变电所运行检修规程》、《铁路电力管理规则》、《电气化铁道接触网安全工作规程》。\n' +
          '【典型风险】接触网断线/塌网、工作票漏签或漏拆接地线、误送电、感应电触电、接触网覆冰、鸟害/危树、外部施工碰线。\n' +
          '【分析框架】从"设备状态→停送电作业（工作票/倒闸）→外部环境（危树/污染源/跨越）→天气（覆冰/大风/雷害）"四维度分析，严格落实"停电、验电、接地"纪律。\n' +
          '【术语与条款】规范术语：承力索/接触线/吊弦/补偿装置、分段绝缘器、倒闸、工作票、验电接地、感应电、天窗；引用须到"规则名 + 条款层级"，记不准就标"条号待核实"。\n' +
          '【专业边界】只对牵引供电与电力设备及其停送电作业定性；登销记与行车条件归车务，信号电源归属按现场界定并说明依据。\n' +
          '【必查项点】工作票签发与票/图/现场"三对照"、接地线编号数量核对与拆除确认、安全距离与防护措施、危树/鸟害/跨越物排查、覆冰与雷害季节措施。',
        'chewu':
          '你是车务安全监察专家。\n' +
          '【专业领域】接发列车、调车作业、施工登销记、非正常行车、CTC 操作、车机联控、防溜、行车室管理。\n' +
          '【应熟悉规章】《铁路技术管理规程》（行车组织）、《接发列车作业标准》、《调车作业标准》、《铁路营业线施工安全管理办法》、《车机联控标准》。\n' +
          '【典型风险】错办进路、抢钩/抢点作业、调车作业冲突/脱轨、施工登销记错误、进路未准备好接发列车、防溜措施失效、联控漏呼。\n' +
          '【分析框架】从"作业标准→进路安全（敌对/分路不良）→施工登销记管控→联控互控"四维度核查，强调标准化作业与互控。\n' +
          '【术语与条款】规范术语：接发列车、进路（基本/敌对/延续）、调车（溜放/推送/取送）、登销记、车机联控、防溜（铁鞋/手闸/止轮器）、非正常行车；引用须到条款层级。\n' +
          '【专业边界】只对行车组织与作业标准定性；设备故障原因归电务/工务/车辆，不替其定性；调车机乘务问题归机务。\n' +
          '【必查项点】施工登销记与调度命令核对、进路准备与敌对进路防护、调车作业计划与防溜措施、联控用语与互控执行、非正常行车预案与演练。',
        'keyun':
          '你是客运安全监察专家。\n' +
          '【专业领域】客运组织、乘降安全、安检查危、实名验证、站车秩序、突发客流、站台与电梯安全、重点旅客服务。\n' +
          '【应熟悉规章】《铁路旅客运输规程》、《铁路旅客车站客运设施管理办法》、《铁路旅客运输安全检查管理规程》、《铁路旅客列车消防安全管理规定》、《铁路交通事故应急救援和调查处理条例》。\n' +
          '【典型风险】站台坠落、电梯/自动扶梯伤害、安检查危漏检（危险品进站）、客流拥挤踩踏、重点旅客服务缺失、站台端部入侵。\n' +
          '【分析框架】从"乘降组织→安检防爆→设备设施（电梯/站台/消防）→应急处置"四维度分析，突出人防+物防+技防。\n' +
          '【术语与条款】规范术语：乘降组织、安检查危、实名制验证、重点旅客、突发客流、站台端部、扶梯/无障碍设施；引用须到"规程名 + 条款层级"，记不准就标"条号待核实"。\n' +
          '【专业边界】只对客运组织与站车服务定性；站台限界与雨棚结构归房建，列车设备与消防设施归属按现场界定并说明依据。\n' +
          '【必查项点】进出站与检票流线、安检设备状态与危险品处置台账、站台防护与端部管控、扶梯年检与应急停梯、大客流应急预案与演练。',
        'jiwu':
          '你是机务安全监察专家。\n' +
          '【专业领域】机车运用、乘务管理、LKJ/CIR 装备、机车检修、调车作业（调小车）安全、机车防火。\n' +
          '【应熟悉规章】《铁路机车运用管理规则》、《机务行车安全管理规则》、《LKJ 数据管理规程》、《铁路机车操作规则》、《防止机车车辆溜逸管理办法》。\n' +
          '【典型风险】乘务员超劳/待乘不足、LKJ 数据错误、退勤漏鉴、调车作业冒进信号、行安装备（CIR/LKJ）故障、超速运行、机车防火。\n' +
          '【分析框架】从"人（乘务超劳/待乘）→机（LKJ/CIR 装备）→环境（运行图/施工）→管理（超劳/退勤）"四维度，强调防滑坡/防超速/防冒进。\n' +
          '【术语与条款】规范术语：乘务超劳与待乘、LKJ 数据与监控装置、CIR、机车检修（段修/中修）、调车机、防溜、机车防火；引用须到"规则名 + 条款层级"。\n' +
          '【专业边界】只对机车运用与乘务管理定性；调车作业组织归车务，车辆走行部与制动归车辆，不替其定性。\n' +
          '【必查项点】乘务员待乘与超劳台账、LKJ 数据换装与版本核对、退勤与酒测执行、调车机作业与防溜措施、机车防火与灭火装置状态。',
        'cheliang':
          '你是车辆安全监察专家。\n' +
          '【专业领域】货车/客车/动车组运用维修、5T 系统（THDS/TPDS/TADS/TFDS/TCDS）、轮轴、制动、转向架、防火、配件脱落。\n' +
          '【应熟悉规章】《铁路货车运用维修规程》、《铁路客车运用维修规程》、《动车组运用维修规程》、《铁路车辆运行安全监控系统（5T）运用管理细则》。\n' +
          '【典型风险】热轴（THDS 预报）、轮对裂纹/剥离、制动失灵、配件脱落、客车/动车防火隐患、5T 预报处置不及时或漏拦。\n' +
          '【分析框架】从"检测监测（5T 预报）→走行部（轮轴/转向架）→制动系统→防火"四维度，强调监测预报闭环处置。\n' +
          '【术语与条款】规范术语：5T 系统（THDS/TPDS/TADS/TFDS/TCDS）、热轴、轮对剥离/擦伤/裂纹、抱闸与缓解不良、转向架、配件脱落、列检；引用须到"规程名 + 条款层级"。\n' +
          '【专业边界】只对车辆运用与检修质量定性；机车部分归机务，装载加固与危险货物归货运，不替其定性。\n' +
          '【必查项点】5T 预报处置与拦停闭环、列检作业标准与交接检查、制动试验与关门车管理、配件防脱与紧固扭矩、客车/动车防火检查。',
        'tongxin':
          '你是通信安全监察专家。\n' +
          '【专业领域】GSM-R 无线列调、光纤传输、数调、漏泄电缆、应急通信、网管监测。\n' +
          '【应熟悉规章】《铁路技术管理规程》（通信）、《铁路通信维护规则》、《铁路数字移动通信系统（GSM-R）维护管理办法》、《铁路营业线施工安全管理办法》。\n' +
          '【典型风险】GSM-R 覆盖盲区/掉话、光纤中断、无线列调失效、传输网告警、应急通信不畅、基站/铁塔安全。\n' +
          '【分析框架】从"传输网→无线（GSM-R 覆盖/列调）→应急通信→网管监测"四维度，强调行车通信不间断。\n' +
          '【术语与条款】规范术语：GSM-R（覆盖/切换/掉话）、无线列调、漏泄电缆、光传输（SDH/OTN）、数字调度、应急通信、网管告警；引用须到"规则名 + 条款层级"。\n' +
          '【专业边界】只对通信网络与业务质量定性；信号联锁归电务（二者最易混淆，须明确区分是"联锁/信号"还是"传输/无线"问题）。\n' +
          '【必查项点】GSM-R 覆盖测试与弱场补强、列调通话质量与录音核查、光缆径路与施工防护、网管告警处理时限、应急通信演练。',
        'fangjian':
          '你是房建安全监察专家。\n' +
          '【专业领域】站台限界、雨棚/站房屋面、地下空间、风雨棚钢结构、幕墙、客运流线设施。\n' +
          '【应熟悉规章】《铁路技术管理规程》（建筑限界）、《铁路房屋建筑大修维修规则》、《铁路建筑限界管理办法》、《铁路旅客车站客运设施管理办法》。\n' +
          '【典型风险】站台/雨棚侵限、雨棚钢结构锈蚀或构件脱落、建筑限界变化未报批、站房屋面渗漏、幕墙脱落、地下空间积水。\n' +
          '【分析框架】从"限界管理→结构安全（雨棚/站房）→屋面防水→客运流线"四维度，突出侵限零容忍。\n' +
          '【术语与条款】规范术语：建筑限界与站台限界、雨棚钢结构与连接件、幕墙、屋面防水与排水、地下空间；引用须到"规则名 + 条款层级"，记不准就标"条号待核实"。\n' +
          '【专业边界】只对房建结构与限界定性；线路几何尺寸归工务，客运组织与服务归客运，不替其定性。\n' +
          '【必查项点】站台限界测量与侵限整治、雨棚钢结构锈蚀与高强螺栓、屋面渗漏与排水、幕墙及广告牌抗风、地下空间积水与疏散通道。',
        'huoyun':
          '你是货运安全监察专家。\n' +
          '【专业领域】装载加固、超限超重运输、危险货物运输、篷布管理、货运计量安全检测、货运交接。\n' +
          '【应熟悉规章】《铁路货物装载加固规则》、《铁路超限超重货物运输规则》、《铁路危险货物运输规则》、《货运计量安全检测监控管理办法》。\n' +
          '【典型风险】超载/偏载、加固材料失效、超限超重未办理、危险货物匿报/错报、撒漏污染、货物位移。\n' +
          '【分析框架】从"装载加固（方案/材料）→超限超重（批示/监护）→危险货物（品类/包装）→计量检测（超偏载仪）"四维度。\n' +
          '【术语与条款】规范术语：装载加固方案与加固材料、超限超重（批示/监护）、危险货物（品类/包装/匿报错报）、超偏载、篷布苫盖、货运交接；引用须到"规则名 + 条款层级"。\n' +
          '【专业边界】只对货运组织与装载安全定性；车辆技术状态归车辆，行车条件与调车作业归车务，不替其定性。\n' +
          '【必查项点】装载加固方案与现场执行一致性、超限超重批示与监护记录、危险货物运单与包装检验、超偏载检测数据处置、篷布苫盖与捆绑加固。',
        'tongyong':
          '你是铁路综合安全监察专家，擅长跨专业综合分析、体系化安全管理和风险研判。\n' +
          '【职责】统筹工务、电务、供电、车务、机务、车辆、通信、房建、客运、货运等全专业安全问题；运用双重预防机制（风险分级管控+隐患排查治理）、安全红线、标准化管理开展研判。\n' +
          '【应熟悉规章】《安全生产法》《铁路安全管理条例》《铁路技术管理规程》（综合及各专业分册）《铁路营业线施工安全管理办法》《铁路交通事故应急救援和调查处理条例》，以及双重预防机制、安全红线与标准化管理的相关文件。\n' +
          '【方法】识别系统性风险，按"人、机、环、管"与"高/中/低"风险分级结构化输出，给出可执行的预警与整改措施，引用本地检查信息与规章数据支撑结论。\n' +
          '【多专业协同】同一问题涉及多个专业时，指出主责专业与协同专业，并分别给出各自的管控要点，避免只从一个专业角度下结论。\n' +
          '【术语与条款】规范术语：双重预防机制（风险分级管控 + 隐患排查治理）、安全红线、标准化作业、人机环管、三违；引用须到"文件/规则名 + 条款层级"。\n' +
          '【专业边界】综合视角不等于替专业定性 —— 涉及具体设备或作业时，说明结论应按哪个专业框架核实，并点明需由哪个专业出具意见。\n' +
          '【必查项点】风险清单与管控措施闭环、隐患排查台账与整改验证、红线问题处置、安全生产责任制落实、应急预案与演练记录。',
        'frontend':
          '你是一位资深前端工程师（Web/小程序方向）。\n' +
          '【交付标准】① 代码自包含、可直接运行：单文件 HTML 时把 CSS/JS 内联，除非用户要求拆分；② 优先零依赖（不引外部 CDN），确需库时说明用途与替代方案；③ 使用现代浏览器特性（ES2020+、Flex/Grid、CSS 变量），并保证移动端可用。\n' +
          '【输出格式】给完整代码块（标注语言），关键实现点用简短注释说明；最后附 3 行以内的使用说明或注意事项。\n' +
          '【质量底线】不留 TODO 占位；不臆造不存在的 API；用户给的现有代码要保留其结构与命名风格，只改必要部分。\n' +
          '【项目形态】本系统是纯静态 PWA：原生 HTML/CSS/JS、**无框架无构建**、模块用 IIFE + window 全局通信、数据在 IndexedDB/localStorage、Service Worker 离线缓存、CSP 白名单（含 unsafe-eval）。方案必须贴合该形态，不要引入需要打包/框架的方案（除非用户明确要求）。\n' +
          '【交付补充】给最小 diff，不顺手重构无关代码；改动涉及数据存储或渲染时，说明对"离线可用"与"暗黑主题"的影响；改动 JS 后提醒同步 sw.js 的 CACHE_VERSION（本项目的发版铁律）。',
        'riskanalyst':
          '你是铁路安全风险分析专家。你的任务是：\n' +
          '1. 基于本地检查信息和规章制度（优先引用真实数据），识别当前最突出的安全风险领域\n' +
          '2. 按时间趋势、专业分布、问题性质三个维度分析\n' +
          '3. 针对高危领域给出具体的预警措施和整改建议\n' +
          '4. 输出格式要求：先概述总体情况，再分点列出风险等级（高/中/低），最后给出3-5条可执行的预警措施\n' +
          '5. 引用数据时标注来源和时间范围，建议要具体可操作；若本地数据不足，说明需补充或联网核实的方向。\n' +
          '6. 口径纪律：风险等级必须给出判定依据（条款 / 台账 / 案例），不得只给等级不给理由；趋势类结论要说明时间范围与样本量，样本不足时明确写"不足以判断趋势"，不要用"总体平稳"这类无信息量表述收尾。',
      };

      // 【v3.76】角色「输出规范」（所有**专业角色**统一追加；frontend 代码角色除外）
      //   为什么需要：13 个角色写清了「专业领域 / 应熟悉规章 / 典型风险 / 分析框架」，
      //   但**输出侧没有统一契约** —— 没规定结构、引用要细到什么程度、统计口径、建议要可执行、篇幅。
      //   而通用「专业回答准则」只覆盖了"知识分层 / 准确性分级 / 术语与风险分级"，
      //   所以这里只补它没覆盖的部分，不重复（避免提示词互相稀释）。
      const ROLE_OUTPUT_NORMS =
        '【输出规范】\n' +
        // 【2026-10-07 用户反馈·结构越权（真机实例）】原第 1 条**强制**"结论 → 依据 → 整改建议"三段式，
        //   于是用户只要一份"检查清单"时，模型也硬加"二、整改与管控建议""三、待核实"等章节 ——
        //   用户实测反馈："感觉有点太啰嗦，有一部分不是提问的内容"（输出 4 段，只有 1 段是所要的）。
        //   改为**结构跟随请求**（业界通行做法 "answer the question asked"）：
        //   三段式只在"分析/研判/怎么办"这类开放问题时启用；清单/数据类请求只给被要的内容。
        // 【2026-10-08 提示词去重 · 单一事实来源（Anthropic 提示工程）】原第 1 条把"结构跟随请求 / 不要
        //   追加章节 / 何时用三段式"整套写了一遍，与文末【回答风格（硬约束）】原第 8、9 条（"只答所问" +
        //   "请求类型 → 输出形态"对照表）**语义重复**。同一规则出现两次的代价：模型需在两处措辞之间做
        //   一致性推理，措辞略有差异时还会互相打架（Anthropic 明确说重复指令会稀释注意力）。
        //   现本条只保留**角色视角特有的补充**，结构总规则交给唯一权威（【回答风格】第 8 条）。
        '1. 结构：整体规则见文末【回答风格（硬约束）】第 8 条的"请求类型 → 输出形态"对照；本条只补充 —— '
        + '面向"分析 / 研判 / 怎么办 / 如何处置"这类开放问题时用'
        + '"结论与判断 → 依据（条款/台账/案例）→ 可执行的整改或管控建议"三段式；条目多时分点或用表格，不要堆长段落。\n' +
        '2. 引用格式：「名称 + 条款号」的总要求见后文【专业回答准则】；本条补充格式细节 —— 检查信息与案例要带单位、日期（或时段）与问题性质，每条尽量标出来源（如「规章制度：XX办法 第N条」「检查信息：某供电段 2026-03」）。\n' +
        '3. 数据口径：问题性质按 A / B / C / 红线 四类；统计数字必须与本地台账一致，不得改变口径，也不得把估算值写成台账值。\n' +
        '4. 建议要可执行：写清「谁、在什么时机、做什么、达到什么标准」，避免「加强管理、提高认识」这类空话；一条建议只解决一个问题。\n' +
        '5. 跨专业问题：先答本职专业，再点明需协同的专业与协同要点（如供电作业涉及车务登销记、电务联锁试验）。\n' +
        // 【2026-10-08 提示词去重】原第 6 条（篇幅）与文末【回答风格（硬约束）】第 7 条（默认精炼）
        //   是同一规则 ⇒ 收口到一处，本条只做指引，避免"两处篇幅规则"被模型读成两个要求。
        '6. 篇幅：规则见文末【回答风格（硬约束）】第 7 条（默认精炼）及其第 8 条的优先级声明（材料类该长就长）。';

      // 【优化·废话抑制】所有角色统一适用的回答风格硬约束（含 frontend 代码角色）。
      //   为什么需要：原有【专业回答准则】管"准确性分层/术语/风险分级"，【输出规范】管"结构/引用/
      //   建议可执行/篇幅"，但都**没有禁止**最常见的废话来源 —— 开场白、复述问题、客套结尾、
      //   整段转述检索到的原文、为凑篇幅同义反复、多层标题包一个结论。
      //   这一段放在 system 提示的**最末尾**（见 dsBuildSystemPrompt 调用处），位置靠后对模型约束力更强。
      const CHAT_STYLE_NORMS =
        '【回答风格（硬约束）】\n' +
        '1. 直接给答案：第一句就是结论 / 结果 / 代码，不要"好的，我来帮你分析""这是个好问题"之类开场，也不要复述我的问题或我已经给出的背景。\n' +
        '2. 不写废话结尾：不要"希望对您有帮助""如需进一步了解请告知""以上供参考"等客套，也不要在结尾再重复一遍正文要点。\n' +
        // 【2026-10-07 补·自相矛盾修正】原第 3 条一刀切"不要整段抄录"，但用户**明确要条文原文**时
        //   （"第X条怎么规定的""原文是什么"），照这条执行就变成"用户要原文却不给" —— 这是硬冲突。
        //   加例外：被明确索取原文时**照给**，仍然沿用"不主动抄"的默认。
        '3. 不转述资料原文：检索到的条款 / 台账只取用得到的结论与关键数据（条款号、数字、时间），不要整段抄录；'
        + '**例外**：用户明确要"原文 / 全条 / 怎么写的"时，照给该条原文并标注名称与条号，但只给被问到的那一条，不要顺带铺开整章。\n' +
        '4. 不确定就一句话讲清（"待核实""需联网核实""本地无此数据"），不要用大段铺垫掩盖不确定，也不要为显得完整而堆砌无关内容。\n' +
        '5. 分点 / 表格只在条目 ≥3 或需要对比时使用；只有一个结论就用一句话，不要为它铺多层小标题。禁止同义反复凑篇幅。\n' +
        '6. 不用 emoji 与装饰性符号堆砌（用户使用或明确要求时除外）。\n' +
        '7. 用户未要求"详细 / 展开 / 逐条"时，默认精炼作答；宁可少说，不要注水。\n' +
        // 【2026-10-08 提示词去重 · 单一事实来源】原第 8 条（只答所问：范围）与原第 9 条（输出形态对照：
        //   形态）说的是**同一件事的两个侧面**，分成两段各自表述 ⇒ 规则列表里有一条半是同一规则，
        //   互相稀释（用户真机反馈过"规则多了反而每条都不可靠"）。现**合并为一条**：
        //   先把"范围"一句说死（含"必须提醒时压成一行"这个出口），再给"请求类型 → 形态"对照表收口，
        //   **末尾对前面条款的优先级声明原样保留**（材料类是唯一豁免"默认精炼/只答所问"的形态）。
        //   ⚠️ 条号变化：原第 9 条并入本条（第 8 条）⇒ 全项目对"提示词第 9 条"的引用已同步更新
        //      （见 doubao.js 请求类型识别处的注释；diary.js 里的"第 9 条"是它**自己的**提示词编号，无关）。
        '8. 只答所问，且形态随请求类型（不要一律套"结论 + 依据 + 建议"）：\n'
        + '   不要主动加用户没要的章节 —— 尤其别在"要清单 / 要数据 / 要判定"时附送'
        + '"整改建议""管控措施""待核实事项""总体评价"；确有必须提醒的事项，压成结尾**一行**'
        + '（如"如需整改建议可继续"），不要另起大段。\n'
        + '   · 要数据 / 统计 → 只给数字与口径（数据源、时间范围、总条数）；不附建议；样本不足就直说；\n'
        + '   · 要规章条文 → 给条款原文 + 名称与条号（见第 3 条例外）；不改写、不附整改建议；本地未收录就说明；\n'
        + '   · 要定性 / 判定 → 先给结论（性质 / 等级），再给判定依据（条款 / 台账 / 案例），不展开成方案；\n'
        + '   · 要清单 / 表格 → 只给表，每格写可当场核对的判据（另有专项规范）；\n'
        + '   · 要材料 / 报告 / 方案 / 讲话稿 → 给**完整结构**，该长就长（本项优先于第 7 条"默认精炼"）；\n'
        + '   · 闲聊 / 寒暄 → 一句话。';

      // 【优化·角色贴合】把角色身份的一句话回扣放到提示词最末尾。
      //   原因：角色提示词位于 system 开头，其后还插入了本地资料（可达 4.5KB）与各项准则，
      //   位置越靠后对模型的"注意力"越强 ⇒ 长资料会把角色特征稀释掉（表现为"角色选了但答得一样"）。
      //   末尾回扣一句，且不再重复角色全文（省 token）。
      function buildRoleRecall(roleInfo) {
        var label = (roleInfo && roleInfo.label) || '通用';
        if (roleInfo && roleInfo.isCode) {
          return '【本轮角色】你正在以「' + label + '」身份回答：直接给出可运行代码与必要说明，'
               + '不要掺入铁路业务规章 / 台账内容，也不要写与代码无关的铺垫。';
        }
        return '【本轮角色】你正在以「' + label + '」身份回答：专业术语、分析框架与关注点必须与该角色一致；'
             + '不要退化成"加强管理、提高认识"式的通用安全套话；跨专业时先答本职专业，'
             + '再点明需协同的专业与协同要点。';
      }

      // ---------- 3. 长期记忆管理 ----------
      const MEMORY_KEY = 'assistant_memory_v1';
      let userMemories = [];
      let memoryEnabled = true;

      function loadMemories() {
        try {
          var raw = JSON.parse(localStorage.getItem(MEMORY_KEY) || '[]');
          // 解析出非数组（如 '{}'）时原实现会让后续 .some/.slice 抛错，这里统一兜底为数组
          userMemories = Array.isArray(raw)
            ? raw.filter(function (m) { return m && typeof m.fact === 'string' && m.fact; })
            : [];
        } catch(e) { userMemories = []; }
      }
      function saveMemories() { try { localStorage.setItem(MEMORY_KEY, JSON.stringify(userMemories)); } catch (e) {} }

      // 【优化·准确性】只记「稳定的偏好/背景」，不再把每一句提问都当长期记忆。
      //   原实现 = 用户输入前 100 字（无条件），于是"帮我查下3号道岔"这类一次性问题也会被
      //   存成"长期偏好"并注入后续每一轮 —— 既占 token，又让模型误判用户有该偏好，
      //   是"答非所问 + 废话"的一条隐性来源。改为只在出现偏好/身份/长期约束信号词时记录。
      function extractFacts(text) {
        var t = String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
        if (!t) return [];
        // 寒暄 / 元问题 / 纯致谢：不构成偏好
        if (/^(你好|您好|hi|hello|hey|在吗|在么|谢谢|感谢|多谢|辛苦|好的|收到|明白|ok|okay|测试|你是谁|你叫什么|你能做什么|你会做什么|介绍一下你)/i.test(t)) return [];
        // 仅当出现「稳定偏好 / 身份 / 长期约束」信号词才记录
        if (!/(我是|我在|我们单位|我们段|我们站|我们车间|本段|本人|以后|今后|下次|默认|习惯|偏好|尽量|务必|必须用|统一用|请不要|不用|别用|按照我们|按我们|格式要求|按这个格式|称呼|简称)/.test(t)) return [];
        var fact = t.slice(0, 80).trim();
        return fact ? [fact] : [];
      }

      function addMemory(fact) {
        if (!fact) return;
        if (!memoryEnabled) return;   // 关闭「长期记忆」时连存储也不做（原实现只挡读取，仍在后台写入）
        // 去重：完全相同的记忆不重复存储
        if (userMemories.some(function(m) { return m.fact === fact; })) return;
        userMemories.push({ fact: fact, timestamp: Date.now() });
        // 保留最近 40 条（原 66 条 × 100 字 ≈ 6.6KB，与"精简提示词"目标冲突）
        if (userMemories.length > 40) userMemories = userMemories.slice(-40);
        saveMemories();
      }

      // 取与本轮问题**相关**的记忆：按字符重合度排序 + 条数上限 + 排除刚写入的本轮内容。
      //   原实现忽略 query、无条件返回最新 66 条 —— 与本轮无关的内容会稀释提示词并引发跑题。
      //   宁缺毋滥：无相关记忆时返回空数组（不注入）。
      function getRelevantMemories(query, opts) {
        if (!memoryEnabled) return [];
        opts = opts || {};
        var exclude = opts.exclude || [];
        var limit = opts.limit || 5;
        var q = String(query == null ? '' : query);
        var qChars = {};
        for (var i = 0; i < q.length; i++) {
          var ch = q.charAt(i);
          if (/[\u4e00-\u9fa5A-Za-z0-9]/.test(ch)) qChars[ch] = 1;
        }
        var pool = userMemories.slice().reverse();   // 新的优先
        if (exclude.length) pool = pool.filter(function (m) { return exclude.indexOf(m.fact) === -1; });
        var scored = pool.map(function (m) {
          var hit = 0;
          for (var k in qChars) { if (m.fact.indexOf(k) !== -1) hit++; }
          return { m: m, hit: hit };
        });
        var relevant = scored.filter(function (x) { return x.hit >= 2; });   // 至少 2 个字重合才算相关
        if (!relevant.length) return [];
        relevant.sort(function (a, b) { return (b.hit - a.hit) || (b.m.timestamp - a.m.timestamp); });
        return relevant.slice(0, limit).map(function (x) { return x.m; });
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
      // 【优化·修复失效】导出记忆三函数：Part A 的对话流程需要调用。
      //   此前只导出了 clearLongTermMemory，而 Part A 用的是裸标识符 `extractFacts`，
      //   跨 IIFE 取不到 ⇒ typeof 判断恒假 ⇒ 长期记忆整体从未生效。
      window.dsExtractFacts = extractFacts;
      window.dsAddMemory = addMemory;
      window.dsGetRelevantMemories = getRelevantMemories;
      window.dsLoadMemories = loadMemories;

      // ---------- 4. 轻量级 BM25 检索器 ----------
      // 【v3.72 重构】旧实现每次检索都要对**全部文档重新分词**，而 _build 里算出来的倒排表用完即丢。
      //   这里把倒排表留下来（词频一并存入），检索时只沿查询词的倒排链累加打分。
      //   · 结果等价：已用 6 组查询 × 3 种语料规模核对，top-4 与原实现逐条一致（未命中任何查询词的
      //     文档 BM25 得分必为 0，原实现也是被 score>0 过滤掉，故「只扫倒排链」与「全量扫描」等价）。
      //   · 实测：8000 篇/250 万字 单次检索 729ms → 1.5ms（493×）；20000 篇/1213 万字 3452ms → 4.6ms（757×）。
      //     构建耗时不变（旧 1034ms / 新 947ms，构建本身仍是懒建、不在启动路径上）。
      //   · 代价：倒排表常驻 ≈ 12MB/百万字（实测 250 万字 36.5MB、1213 万字 140MB）。总字数超过
      //     BM25_POSTINGS_MAX_CHARS 时自动退化为旧「全量扫描」模式，保证任何规模下都不会把内存吃满。
      const BM25_TF_BASE = 1024;                 // 倒排项编码：docIdx * 1024 + tf（词频上限 1023）
      const BM25_TF_CAP = 1023;
      const BM25_POSTINGS_MAX_CHARS = 10000000;  // 启用倒排的字数上限（实测 ≈12MB/百万字 → 上限约 125MB）
// 【2026-09-21 真数据补充】除了字数，**文档数**也要设上限：真数据规章语料 139385 块（每块只有几十字，
//   总字数没过阈值）会走倒排模式 → 词表 Map 上百万条、常驻上百 MB（实测稳态堆 330MB 里的主要部分），
//   而它的检索并不比"scan + 惰性 df"快多少（实测短查询 114~175ms）。超过此块数直接走 scan+lazy：
//   内存只需要"块 + 查过的词"，跨会话还能靠 df 缓存复用。
const BM25_POSTINGS_MAX_DOCS = 30000;
      // 【v3.74】索引导出/恢复时词表的分隔符（用 \u0001 这类控制字符，正常语料不会出现）
      const BM25_TERM_SEP = '\u0001';
      class LightBM25 {
        constructor(docs, k1 = 1.2, b = 0.75, defer) {
          this.docs = docs;
          this.k1 = k1;
          this.b = b;
          this.avgLen = 0;
          this.idf = new Map();     // 仅退化（全量扫描）模式使用
          this.postings = null;     // 倒排：Map<term, number[]>，元素 = docIdx*1024+tf
          this.docLen = null;
          // defer=true 时不在此同步建索引，改由 buildAsync() 分片建（大语料用，避免冻结界面）
          if (docs.length && !defer) this._build();
        }
        _build() {
          const docs = this.docs;
          const docCount = docs.length;
          let totalLen = 0;
          for (let i = 0; i < docCount; i++) totalLen += this._textOf(docs[i]).length;
          this.avgLen = totalLen / docCount;
          if (totalLen > BM25_POSTINGS_MAX_CHARS || docCount > BM25_POSTINGS_MAX_DOCS) { this._buildScan(); return; }
          // ---- 倒排模式 ----
          this.postings = new Map();
          this.docLen = new Float64Array(docCount);
          for (let idx = 0; idx < docCount; idx++) this._indexOne(idx);
        }
        // 单篇入库（_build 与 _buildAsync 共用，保证两条路径行为完全一致）
        _indexOne(idx) {
          const content = this._textOf(this.docs[idx]);
          this.docLen[idx] = content.length;
          const tokens = this._tokenize(content);
          const tfMap = new Map();
          for (let i = 0; i < tokens.length; i++) {
            const t = tokens[i];
            tfMap.set(t, (tfMap.get(t) || 0) + 1);
          }
          tfMap.forEach((tf, term) => {
            let arr = this.postings.get(term);
            if (arr === undefined) { arr = []; this.postings.set(term, arr); }
            arr.push(idx * BM25_TF_BASE + (tf > BM25_TF_CAP ? BM25_TF_CAP : tf));
          });
        }
        // 【v3.73】分片异步建索引：4 万条级别语料一次性同步建会冻结界面数秒（实测检查信息 40166 条
        //   → 3.57s 主线程阻塞 + 157MB）。这里按片执行、片间让出事件循环，界面保持可响应并能报进度。
        //   注意：检索结果与同步 _build 完全一致（同一套 _indexOne，同一顺序）。
        buildAsync(opts) {
          opts = opts || {};
          const sliceSize = opts.slice || 400;
          const docs = this.docs, docCount = docs.length;
          const onProgress = opts.onProgress;
          const self = this;
          let totalLen = 0;
          for (let i = 0; i < docCount; i++) totalLen += this._textOf(docs[i]).length;
          this.avgLen = docCount ? totalLen / docCount : 0;
          if (totalLen > BM25_POSTINGS_MAX_CHARS || docCount > BM25_POSTINGS_MAX_DOCS) {
            // 【2026-09-21】超大语料（或块数太多）→ 直接用"scan + 惰性 df"：只算 avgLen，毫秒级完成。
            //   原实现在这里仍然把整库分词建 termDocs/idf（真数据 139385 块 ≈ 12s + 上百万条词表常驻），
            //   改为惰性后建索引几乎零成本，检索时只对"真正查到的词"扫一遍全库算 df。
            this._buildScan();
            return Promise.resolve(true);
          }
          this.postings = new Map();
          this.docLen = new Float64Array(docCount);
          let i = 0;
          return new Promise(function (resolve) {
            function step() {
              const end = Math.min(i + sliceSize, docCount);
              for (; i < end; i++) self._indexOne(i);
              if (onProgress) onProgress(i, docCount);
              if (i < docCount) setTimeout(step, 0);
              else resolve(true);
            }
            step();
          });
        }
        // 超大语料的退化路径 【2026-09-21 真数据优化】
        //   原实现：把**整库分词一遍**、为语料里每个词算 df/idf 存进 Map。
        //   真数据实测：规章语料 139385 块 → 建索 ~12s（每次会话首检索必付，实测首次检索 12.3s），
        //   且词表 Map 常驻（百万级词条）——这是 4 万条真数据下堆 567MB 的主要来源之一。
        //   现在：建索只累加文本长度算 avgLen（毫秒级）；**df/idf 改成按查询词惰性计算并缓存**：
        //     · 只有真正被查到的词才做一次全库扫描（原生不区分大小写正则，~100-200ms/词），随后命中缓存；
        //     · 词表从"全库词表"变成"本会话查过的词"，内存大幅下降；
        //     · 打分口径不变（tf 用出现次数、idf 用 log((N-df+0.5)/(df+0.5)+1)、lenNorm 用 avgLen）。
        _buildScan() {
          const docs = this.docs;
          const docCount = docs.length;
          let totalLen = 0;
          for (let i = 0; i < docCount; i++) totalLen += this._textOf(docs[i]).length;
          this.avgLen = docCount ? totalLen / docCount : 0;
          this._lazyDf = new Map();     // term → df（按需填充）
        }
        /** 惰性 df：全库扫一遍统计"含该词的文档数"（不区分大小写），结果缓存（打分口径与旧 idf 表一致） */
        _dfOfLazy(term) {
          const cached = this._lazyDf.get(term);
          if (cached !== undefined) return cached;
          let re = null;
          try { re = new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'); } catch (e) { re = null; }
          const docs = this.docs;
          let df = 0;
          for (let i = 0; i < docs.length; i++) {
            const text = this._textOf(docs[i]);
            if (!text) continue;
            if (re ? re.test(text) : (text.indexOf(term) !== -1)) df++;
          }
          this._lazyDf.set(term, df);
          return df;
        }
        /**
         * 【2026-09-21 实测记录·已回退】曾尝试"批量惰性 df"（一次全库遍历同时算多个查询词的 df）：
         *   长句查询切出的 2/3 字词有几十个，"逐文档 × 逐词 indexOf"变成百万级调用 → 实测**比逐词扫更慢**
         *   （50 次查询跑不完 90s 预算）。结论：逐词扫全库（`_dfOfLazy` 用正则短路，命中即返回）反而更快；
         *   真正的提速手段是"把查过的词缓存下来并跨会话复用"（见 exportDfCache / importDfCache 与 knowledge.js 的 df 缓存）。
         *   因此这里**不再做任何批量预热**：df 在打分循环里按需计算（只对查询里真正出现的词算一次）。
         */
        /**
         * 【2026-09-21】惰性 df 缓存导出/导入 —— 供 KB 索引缓存持久化，**跨会话复用**。
         * 只存"这个会话真正查过的词"，体量很小（几千词 ≈ 几十 KB），却能把二次检索里
         * "每个新词扫一遍全库"（~100-200ms/词）直接省掉。调用方负责用数据指纹校验有效性。
         */
        exportDfCache() {
          if (!this._lazyDf || !this._lazyDf.size) return null;
          var out = {};
          this._lazyDf.forEach(function (v, k) { out[k] = v; });
          return out;
        }
        importDfCache(obj, max) {
          if (!this._lazyDf || !obj) return 0;
          var cap = max || 4000, n = 0;
          for (var k in obj) {
            if (!Object.prototype.hasOwnProperty.call(obj, k)) continue;
            if (this._lazyDf.size >= cap) break;
            var v = obj[k];
            if (typeof v === 'number' && v >= 0) { this._lazyDf.set(k, v); n++; }
          }
          return n;
        }
        // 与旧版正则写法逐字符等价（仅用 charCode 判定，省掉每字符一次正则）——已用全量语料 +
        // 边界串（空串 / 纯英文数字 / 全角 / 标点 / 表情符号）核对分词结果完全一致。
        _tokenize(str) {
          if (!str) return [];
          const tokens = [];
          // 【2026-09-30 准确性修复】先做 NFKC 归一：全角数字/字母、全角标点、常见兼容字符会被规整为等价形式
          //   （原来只 toLowerCase ⇒ 全角"１２"、"（）"与半角互不命中，检索/召回直接漏）。
          let _sNorm = String(str);
          try { _sNorm = _sNorm.normalize('NFKC'); } catch (e) {}
          const s = _sNorm.toLowerCase();
          const n = s.length;
          for (let i = 0; i < n; i++) {
            const c = s.charCodeAt(i);
            if (c >= 0x4e00 && c <= 0x9fa5) {
              if (i + 1 < n) tokens.push(s.slice(i, i + 2));
              if (i + 2 < n) {
                const c2 = s.charCodeAt(i + 2);
                if (c2 >= 0x4e00 && c2 <= 0x9fa5) tokens.push(s.slice(i, i + 3));
              }
            } else if ((c >= 48 && c <= 57) || (c >= 97 && c <= 122)) {
              let j = i;
              while (j < n) {
                const cj = s.charCodeAt(j);
                if ((cj >= 48 && cj <= 57) || (cj >= 97 && cj <= 122)) j++; else break;
              }
              tokens.push(s.slice(i, j));
              i = j - 1;
            }
          }
          // 【2026-09-30 准确性修复】条号归一：把「第X条/章/节/款/项」额外产出一个规范 token
          //   （#art{数字}{单位}），解决「第12条」与「第十二条」token **完全无交集**、互相搜不到的问题。
          //   该分词器被 KB 索引 / 对规召回 / 对话 / 智能体共用，所以修一处四处受益。
          //   只**新增** token、不改动原有 token ⇒ 召回只增不减；查询侧与文档侧走同一规则，故能互相命中。
          //   注意：多级条号（如「第4.3.4条」）不在本次范围内（字符类不含小数点），与切块正则保持一致。
          if (s.indexOf('第') !== -1) {
            try {
              var _re = /第([0-9〇零一二三四五六七八九十百千两][0-9.．〇零一二三四五六七八九十百千两]{0,9})(条|章|节|款|项)/g;
              var _m;
              while ((_m = _re.exec(s)) !== null) {
                var _unit = _m[2];
                var _body = _m[1].replace(/．/g, '.');
                var _ar = '';
                if (/^[0-9.]+$/.test(_body)) {
                  _ar = _body.replace(/\.$/, '');   // 多级条号（如 4.3.4）原样保留；去掉尾随点
                } else {
                  var _d = { '〇': 0, '零': 0, '一': 1, '二': 2, '两': 2, '三': 3, '四': 4, '五': 5, '六': 6, '七': 7, '八': 8, '九': 9 };
                  var _sum = 0, _sec = 0, _ok = true, _lastUnit = false;
                  for (var _ci = 0; _ci < _body.length; _ci++) {
                    var _ch = _body.charAt(_ci);
                    if (_d[_ch] !== undefined) {
                      if (_lastUnit) { _sec += _d[_ch]; } else { _sec = _sec * 10 + _d[_ch]; }
                      _lastUnit = false;
                    } else if (_ch === '十') { _sec = (_sec || 1) * 10; _lastUnit = true; }
                    else if (_ch === '百') { _sum += (_sec || 1) * 100; _sec = 0; _lastUnit = true; }
                    else if (_ch === '千') { _sum += (_sec || 1) * 1000; _sec = 0; _lastUnit = true; }
                    else { _ok = false; break; }
                  }
                  if (_ok) _ar = String(_sum + _sec);
                }
                if (_ar) tokens.push('#art' + _ar + _unit);
              }
            } catch (e) {}
          }
          return tokens;
        }
        _idfOf(df) {
          return Math.log((this.docs.length - df + 0.5) / (df + 0.5) + 1);
        }
        // 检索正文：优先用 searchText（可携带标题/出处等"只用于检索、不用于展示"的内容），
        // 否则退回 content。【v3.73】这样 content 可以保持原始值 —— 命中结果同时被
        // 命中结果被直接拼进提示词当数据源，若把标题拼进 content 会把整串当正文塞进提示词。
        _textOf(doc) {
          if (!doc) return '';
          if (doc.searchText != null) return String(doc.searchText);
          return String(doc.content == null ? '' : doc.content);
        }
        _score(query, doc) {
          const qTokens = this._tokenize(query);
          if (!qTokens.length) return 0;
          const docText = this._textOf(doc);
          const docTokens = this._tokenize(docText);
          const tfMap = new Map();
          for (let t of docTokens) tfMap.set(t, (tfMap.get(t) || 0) + 1);
          let score = 0;
          for (let t of qTokens) {
            const tf = tfMap.get(t) || 0;
            if (tf === 0) continue;
            const idf = this.idf.get(t) || 0;
            const lenNorm = docText.length / this.avgLen;
            score += idf * (tf * (this.k1 + 1)) / (tf + this.k1 * (1 - this.b + this.b * lenNorm));
          }
          return score;
        }
        // 【v3.74】索引导出：把已建好的索引变成可结构化克隆（IndexedDB 可存）的纯数据，
        //   供「统一检索层」缓存到本机 —— 重启/刷新后直接恢复，省掉重新分词与建索引（大源 1–3 秒）。
        //   · 倒排模式：词表打成一个大字符串（避免几十万个字符串对象的克隆开销）+ 扁平 Int32Array；
        //   · 退化（全量扫描）模式：只有 idf 表，同样导出。
        //   ⚠️ 格式与内部实现绑定：改动 _indexOne / _tokenize / 打分公式必须同步提升调用方的缓存版本号。
        exportIndex() {
          const out = {
            mode: this.postings ? 'postings' : 'scan',
            n: this.docs.length,
            avgLen: this.avgLen,
            k1: this.k1,
            b: this.b
          };
          if (this.postings) {
            const size = this.postings.size;
            const terms = new Array(size);
            const offsets = new Int32Array(size + 1);
            let total = 0, i = 0;
            this.postings.forEach(function (arr, term) { terms[i] = term; offsets[i] = total; total += arr.length; i++; });
            offsets[size] = total;
            const flat = new Int32Array(total);
            i = 0;
            this.postings.forEach(function (arr) {
              for (let j = 0; j < arr.length; j++) flat[i++] = arr[j];
            });
            out.termsBlob = terms.join(BM25_TERM_SEP);
            out.offsets = offsets;
            out.flat = flat;
            out.docLen = this.docLen;
          } else {
            const keys = new Array(this.idf.size);
            const vals = new Float64Array(this.idf.size);
            let i = 0;
            this.idf.forEach(function (v, k) { keys[i] = k; vals[i] = v; i++; });
            out.idfKeysBlob = keys.join(BM25_TERM_SEP);
            out.idfVals = vals;
          }
          return out;
        }
        // 从 exportIndex() 的产物恢复实例（不重新分词、不重建倒排）
        static importIndex(payload, docs) {
          const inst = new LightBM25(docs, (payload && payload.k1) || 1.2, (payload && payload.b) || 0.75, true);
          if (!payload) return inst;
          inst.avgLen = payload.avgLen || 0;
          if (payload.mode === 'postings' && payload.flat && payload.offsets) {
            const terms = String(payload.termsBlob || '').split(BM25_TERM_SEP);
            const off = payload.offsets, flat = payload.flat;
            const map = new Map();
            for (let i = 0; i < terms.length; i++) map.set(terms[i], flat.subarray(off[i], off[i + 1]));
            inst.postings = map;
            inst.docLen = payload.docLen;
          } else {
            const keys = String(payload.idfKeysBlob || '').split(BM25_TERM_SEP);
            const vals = payload.idfVals || new Float64Array(0);
            const map = new Map();
            for (let i = 0; i < keys.length; i++) map.set(keys[i], vals[i]);
            inst.idf = map;
          }
          return inst;
        }
        search(query, topN = 5) {
          const docs = this.docs;
          if (!docs.length) return [];
          const qTokens = this._tokenize(query);
          if (!qTokens.length) return [];
          if (!this.postings) {
            // 【2026-09-21 真数据提速】退化（全量扫描）模式原先对**每个文档**调用 _score()，
            //   而 _score 会把整篇正文重新分词一遍：真数据规章语料 139385 块 × 逐块分词 ≈ **5.9s/次**
            //   （实测：仅 rules 源 5849ms；issues 源（倒排模式）只要 8ms）。这条路径对规/写作/智能体
            //   每轮检索都要走，属于"每次必付"的代价，真数据下直接毁掉体验。
            //   现在两条廉价化改造，**打分公式与 idf 来源完全不变、排序结果等价**：
            //     ① 快筛：把查询词拼成一个合并正则（原生扫描），正文一个查询词都没出现的块直接跳过；
            //     ② 候选块用 indexOf 统计查询词出现次数得到 tf（与 _tokenize 的 2/3 字滑窗计数一致，
            //        重叠位置按 at+1 继续找，保证 tf 口径不缩小）。
            //   只有"真正含查询词"的块才会进入打分，绝大多数块一次原生正则就排除了。
            const k1 = this.k1, b = this.b, avgLen = this.avgLen;
            // 【2026-10-06 提速·真机数据支撑】快筛正则**排除"含数字的词"**后再拼（排除后为空则退回全量词）。
            //   为什么：长句查询里大量滑窗是日期/时间/编号（"12月""31日""18时""05分""K686"），它们本身
            //   区分度低（同一份规章里各种编号都有），却让"任意词命中"的快筛几乎筛不掉东西 ——
            //   真机实测（rules 12.97 万块 / 该句切出 109 词）：快筛后仍有 **78619 块（60%）** 成候选，
            //   随后每块跑 109 次 indexOf ≈ **1973ms**，占单次检索 2726ms 的 **72%**（同一次分解里
            //   `_textOf` 全库只要 7ms、惰性 df 549ms ⇒ 瓶颈是"候选块数 × 词数"）。
            //   ⚠️ 本改动**只决定哪些块进入精算**；精算仍用全部 qTokens、打分公式一个字没改。
            //     被排除的块只含数字类词、得分本就极低（进不了 top-N）。权威回归：kb-recall-bench。
            let re = null;
            try {
              // 三级降级挑"快筛词"：① 长度≥3 且不含数字（最有意义的长词）→
              //   ② 不含数字的词（保住"防溜/调车"这类 2 字术语）→ ③ 全部词（极短查询兜底）。
              //   实测（本轮）：仅排除数字词时 P50 从 1929ms 降到 1570ms，但仍>1500ms，
              //   因为"非数字词"还有 60 个左右、快筛依旧偏宽 ⇒ 再收紧一级。
              const _noNum = qTokens.filter(function (t) { return !/[0-9]/.test(t); });
              const _long = _noNum.filter(function (t) { return t.length >= 3; });
              const _use = _long.length ? _long : (_noNum.length ? _noNum : qTokens);
              re = new RegExp(_use.map(t => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'i');
            } catch (e) { re = null; }
            const hits2 = [];
            for (let i = 0; i < docs.length; i++) {
              const text = this._textOf(docs[i]);
              if (!text || (re && !re.test(text))) continue;          // 快筛：不含任何查询词 → 跳过
              const lower = text.toLowerCase();
              const lenNorm = avgLen ? (text.length / avgLen) : 1;
              let score = 0;
              for (let qi = 0; qi < qTokens.length; qi++) {
                const t = qTokens[qi];
                let tf = 0, from = 0, at;
                while ((at = lower.indexOf(t, from)) !== -1) { tf++; from = at + 1; }
                if (!tf) continue;
                // 惰性 df 模式（本次会话新建的索引）：按词现算 df → idf；旧缓存恢复的索引仍走 idf 表
                let idf;
                if (this._lazyDf) {
                  const df = this._dfOfLazy(t);
                  idf = df ? this._idfOf(df) : 0;
                } else {
                  idf = this.idf.get(t) || 0;
                }
                score += idf * (tf * (k1 + 1)) / (tf + k1 * (1 - b + b * lenNorm));
              }
              if (score > 0) hits2.push({ doc: docs[i], score: score });
            }
            return hits2.sort((a, b2) => b2.score - a.score).slice(0, topN).map(s => s.doc);
          }
          const N = docs.length, k1 = this.k1, b = this.b, avgLen = this.avgLen, docLen = this.docLen;
          const scores = new Float64Array(N);
          // 与原实现一致：按 qTokens 逐项累加（同一查询词重复出现时重复计权）
          for (let qi = 0; qi < qTokens.length; qi++) {
            const arr = this.postings.get(qTokens[qi]);
            if (!arr) continue;
            const df = arr.length;
            const idf = this._idfOf(df);
            for (let i = 0; i < df; i++) {
              const packed = arr[i];
              const idx = (packed / BM25_TF_BASE) | 0;     // 1024 为 2 的幂，除法精确
              const tf = packed - idx * BM25_TF_BASE;
              const lenNorm = docLen[idx] / avgLen;
              scores[idx] += idf * (tf * (k1 + 1)) / (tf + k1 * (1 - b + b * lenNorm));
            }
          }
          const hits = [];
          for (let i = 0; i < N; i++) if (scores[i] > 0) hits.push({ doc: docs[i], score: scores[i] });
          return hits.sort((a, b2) => b2.score - a.score).slice(0, topN).map(x => x.doc);
        }
      }
      // 【v3.73】对外暴露检索器，供「统一检索层」knowledge.js 在分块语料上复用同一套打分
      // （避免两处各写一份 BM25；knowledge.js 首次检索时才取用，是懒依赖，不受脚本加载顺序影响）
      window.LightBM25 = LightBM25;

      let bm25Rules = null, bm25Issues = null;
      const _BM25_EMPTY = [];   // 数据源返回空值时的稳定占位（避免每次调用生成新数组 → 指纹恒变 → 反复重建）
      // 兜底指纹【v3.72】：即便某处写入忘了显式失效，只要数据数组的引用或条数变了就重建索引。
      // 覆盖 导入 / 删除 / 清空 / 整体替换；「原地改单条正文且总条数不变」由显式失效覆盖
      // （rule.js 的 saveToStorage 与 issue.js 的 saveData 都会调 dsInvalidateRagCache）。
      let bm25RulesRef = null, bm25RulesLen = 0;
      let bm25IssuesRef = null, bm25IssuesLen = 0;
      function getBM25Rules() {
        if (!hasGetRules) return null;
        const rules = window.getRulesData() || _BM25_EMPTY;
        if (bm25Rules && (rules !== bm25RulesRef || rules.length !== bm25RulesLen)) bm25Rules = null;
        if (!bm25Rules) {
          // ⚠️ 检索字段用 searchText，不能写进 content：
          //   ① 原写法 { content: 标题+正文, ...r } 会被展开的 r.content 覆盖，标题其实**从未进入检索语料**；
          //   ② 直接把 content 改成"标题+正文"更糟 —— hits 返回的 doc 同时被提示词构建当数据源，
          //      会把整串当正文塞进提示词。（v3.73 修正）
          bm25Rules = new LightBM25(rules.map(r => ({ ...r, searchText: ((r.title || '') + ' ' + (r.content || '')) })));
          bm25RulesRef = rules;
          bm25RulesLen = rules.length;
        }
        return bm25Rules;
      }
      function getBM25Issues() {
        if (!hasGetIssue) return null;
        const issues = window.getIssueData() || _BM25_EMPTY;
        if (bm25Issues && (issues !== bm25IssuesRef || issues.length !== bm25IssuesLen)) bm25Issues = null;
        if (!bm25Issues) {
          // 同上：类别/性质只进检索字段，content 保持原值供提示词引用（v3.73 修正，原先同样被展开覆盖）
          bm25Issues = new LightBM25(issues.map(i => ({ ...i, searchText: ((i.content || '') + ' ' + (i.category || '') + ' ' + (i['性质'] || '')) })));
          bm25IssuesRef = issues;
          bm25IssuesLen = issues.length;
        }
        return bm25Issues;
      }
      // 【v3.72】数据变更时显式丢弃索引 —— 导完资料即可检索到，不必再刷新页面。
      // kind: 'rules' | 'issues' | 'all'（省略即 all）。两个调用点都是各自模块所有写入路径的唯一收口：
      //   · rule.js  saveToStorage()（导入/编辑/删除/清空/恢复备份都经此）
      //   · issue.js saveData()（与既有 Fuse 索引失效同一处）
      function dsInvalidateRagCache(kind) {
        const k = kind || 'all';
        try {
          if (k === 'all' || k === 'rules') { bm25Rules = null; bm25RulesRef = null; bm25RulesLen = 0; }
          if (k === 'all' || k === 'issues') { bm25Issues = null; bm25IssuesRef = null; bm25IssuesLen = 0; }
          // 【v3.73】统一检索层（knowledge.js）的条款分块索引走同一套失效契约
          // 【2026-10-06 修复·真机实测定位】原实现**不透传 kind** ⇒ 调 KB.invalidate() 无参 = 清**全部 9 个源**的
          //   索引与 df 缓存（每源索引 + dfcache 两个键，实测一次检查信息导入产生 18 次缓存 delete）。
          //   后果：写一次检查信息，就把规章/手册/电话/日志等无关源的缓存一并废掉 ⇒ 下次"首会话长句"检索
          //   又要付"全库扫描 + 每个词惰性 df"的全价（真机实测 P50 1872ms；历史记录首会话长句约 900ms）。
          //   改为按类透传：knowledge.js 的 invalidate(key) 本就支持单源，'all' 时仍清全（原语义不变）。
          if (typeof window.KB === 'object' && window.KB && typeof window.KB.invalidate === 'function') {
            window.KB.invalidate(k === 'all' ? undefined : k);
          }
        } catch (e) {}
      }
      window.dsInvalidateRagCache = dsInvalidateRagCache;

      // 【性能优化调整 v3.15】移除首屏 BM25 预构建：
      // 原先在 idle/3s 后对 8000+ 条规章+检查信息全量建索引，导致打开/刷新界面后
      // 停留几秒出现 3-4 秒主线程卡滞（用户感知「在加载数据」，但界面/数据已通过
      // 整页快照恢复）。改为首次搜索时懒建（getBM25Rules/Issues 已有 !bm25Rules 守卫，
      // 幂等复用，不重复构建），首屏不再卡顿，首次查询的 200-500ms 建索引在主动操作
      // 语境下可接受。
      // 【v3.72 补充】索引仍然是懒建（不在启动路径上）；但改了数据后会自动失效重建，
      // 所以「首次检索」的构建开销会在每次导入之后重新出现一次（一次性，约 1s/250 万字），
      // 属于用户主动操作时的等待，换来的是导完资料立刻能被检索到。

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

      // 【v3.74 清理】原 `window.enhancedAutoCheck` 与 `buildReferenceText / buildIssueRefText` 已删除：
      //   全仓零调用点（界面对规入口是 smart-check.js 两态按钮 → autoCheckAI_force，已走 KB 条款级召回）。
      //   注意保留 retrieveLocalData —— 智能写作的回退路径仍在使用。

      // ---------- 8. 增强智能写作 ----------
      var originalWrGenerate = window.wrGenerate;
      if (typeof originalWrGenerate === 'function') {
        // 【2026-09-18 收敛为透传】此包装层原先做两件事，现已全部由 smart-writer 内部修复取代，且各自有害：
        //   ① 「选了资料就跳过本地检索」（_wrSkipLocalSearch=true）——会让台账统计/规章候选/历史报告
        //      整块被清空（用户选了资料反而拿不到真实数字与规章依据，实测 materialCount={issues:0,rules:0,reports:0}），
        //      而且该标志被当成"修改模式"，报告落库标题会变成"报告（修改版）"。
        //      现在：手选资料只替换"资料"这一路，台账/规章/历史报告照常检索（见 smart-writer 的 wrGenerate）。
        //   ② 用 KB 检出 5 条案例拼进输入框——台账统计口径已统一由 wrUnifiedStats 给一次，
        //      再拼一份"案例"会出现两套数字，且污染用户需求原文。
        // ⚠️ 形参必须继续透传 isRegenerate：否则「🔄 重新生成」会重复插气泡并清空输入框。
        window.wrGenerate = async function(isRegenerate) {
          return originalWrGenerate(isRegenerate);
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
          // 恢复配置后【不】触发预览：loadRiskConfig 在模块初始化时执行，
          //   放在这里等于让启动路径去遍历整个问题台账（4 万+ 条）。预览只在用户动作后触发：
          //   切换筛选条件（change/input 监听）或切到风险研判子视图（dsSwitchSub 内）。
        } catch(e) {}
      }

      async function saveRiskReportToWriter(title, markdown, isFollowUp) {
        try {
          var now = new Date();
          var report = {
            // 【2026-10-01 用户反馈"报告题目不太好"】题目带上"重点/范围"而不是纯时间戳：
            //   例：风险研判报告（施工安全·甲站）2026-10-01 —— 与智能写作的题目规则一致（都不拿提问当题目）。
            title: title || (function () {
              var _seg = [];
              try {
                var _fo = document.getElementById('risk-focus');
                var _un = document.getElementById('risk-unit');
                if (_fo && _fo.value.trim()) _seg.push(_fo.value.trim().slice(0, 20));
                if (_un && _un.value.trim()) _seg.push(_un.value.trim().slice(0, 16));
              } catch (e) {}
              var _d = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0') + '-' + String(now.getDate()).padStart(2, '0');
              return '风险研判报告' + (_seg.length ? '（' + _seg.join('·') + '）' : '') + ' ' + _d;
            })(),
            category: '风险研判',
            content: markdown,
            date: now.toISOString(),
            createdAt: now.getTime()
          };
          var dbReq = indexedDB.open('railway_writer_db', 2);
          await new Promise(function(resolve, reject) {
            // 必须建全三个 store：只建 writing_reports 会把库固定在 v2 且缺 writing_materials /
            // writing_templates，之后 wrOpenDB() 再 open(2) 不再触发升级，资料库与模板功能整体失效。
            dbReq.onupgradeneeded = function(e) {
              if (typeof window.__wrEnsureSchema === 'function') { window.__wrEnsureSchema(e.target.result); return; }
              var db = e.target.result;
              ['writing_templates','writing_reports','writing_materials'].forEach(function(name){
                if (!db.objectStoreNames.contains(name)) db.createObjectStore(name, { keyPath: 'id', autoIncrement: true });
              });
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
      // 本函数与 dsSwitchSub 分处 doubao.js 的两个 IIFE，闭包不互通，
      // 必须挂到 window 才能被「切到风险研判子视图」触发（仅依赖 typeof 判断会静默失效）
      window.updateRiskPreview = updateRiskPreview;
      // 数据预览的两道闸：任何一道触发即停止遍历，计数显示为「≥N」。
      // 初衷：本机台账可达 4 万+ 条，原实现 getAll() 一次取全量并在内存里连做 3~4 次 filter
      //   （每次都新建一个 4 万元素数组），会把主线程占满（曾造成「打开界面后点啥都不反应」）。
      // 改为：① 总数用 count() 零遍历取；② 明细用游标逐条统计；③ 只读、不升级。
      //   条数上限防病态大库，时间预算保证常见 4 万条能一次算完（约 100ms 级），拿到精确值。
      var RISK_PREVIEW_MAX_SCAN = 120000;
      var RISK_PREVIEW_MAX_MS = 400;
      function _riskNow() { try { return performance.now(); } catch (e) { return Date.now(); } }
      // 日期筛选：'YYYY-MM-DD HH:mm:ss'（含 'T' 分隔的 ISO）直接用前 10 位字符串比较，
      //   等效于原 new Date() 区间判断但快一个数量级（4 万条从 ~秒级降到 ~10ms 级），
      //   避免在游标里为每条记录做一次日期解析把时间预算吃光。
      //   非该格式的遗留数据（如 '2026/3/1 09:30:00'）自动回退到 Date 解析，语义不变。
      function _riskDateInRange(dt, ds, de, sd, ed) {
        var s = typeof dt === 'string' ? dt : (dt == null ? '' : String(dt));
        if (s.length >= 10 && s.charCodeAt(4) === 45 && s.charCodeAt(7) === 45) {
          var day = s.slice(0, 10);
          if (ds && day < ds) return false;
          if (de && day > de) return false;
          return true;
        }
        // 【2026-10-09 真机修复·"筛选后无数据（实际有）"】
        //   原实现：`new Date(s)` 解析失败 ⇒ **直接 return false**（该条被当作"不符合日期条件"丢弃）。
        //   真机台账的 datetime 形态很杂（'2026/9/3 9:00'、'2026.09.03'、'2026年9月3日'、Excel 序列号…），
        //   只要有一类解析不了，这些记录就会被**整批过滤掉** ⇒ 界面显示"筛选后 0 条"，而库里明明有数据。
        //   现改为三级：① 解析成功 ⇒ 正常比较；② 解析不了 ⇒ 返回 'unknown'，由调用方**计入结果并单独计数**
        //   （宁可多算不漏，且如实标注多少条无法判定）；③ 空值同按 'unknown' 处理（原来也会被丢弃）。
        var t = _riskParseDateTime(s);
        if (t === null) return 'unknown';
        if (!isNaN(sd) && t < sd) return false;
        if (!isNaN(ed) && t > ed) return false;
        return true;
      }
      /** 【2026-10-09 真机修复】台账 datetime 的**宽容解析**：返回毫秒时间戳；无法识别返回 null。
       *  覆盖：ISO、'YYYY/M/D'、'YYYY.M.D'、'YYYY年M月D日'（可带时间）、10/13 位时间戳、Excel 日期序列号。
       *  ⚠️ 与"解析失败就当不符合条件"是两回事 —— 调用方必须把 null 视为"无法判定"，**不能借它排除记录**。
       */
      function _riskParseDateTime(v) {
        if (v == null || v === '') return null;
        if (typeof v === 'number') {
          // 【2026-10-09 真机修复·最关键】紧凑日期 YYYYMMDD（Excel / 系统导出极常见）**必须先于时间戳判断**：
          //   20261015 同时满足"看起来像秒时间戳（>1e9）"，若按 v*1000 处理会变成 1970 年 ⇒
          //   整库记录都被"日期条件"排除，界面显示"筛选后 0 条（被日期条件排除 N 条）"，而数据明明在范围内。
          //   （真机 43526 条全被排除、且不出现"日期无法识别"提示，正是这个形态的特征。）
          if (v > 19000000 && v < 22001232) {
            var _y = Math.floor(v / 10000), _m = Math.floor((v % 10000) / 100), _d2 = v % 100;
            if (_m >= 1 && _m <= 12 && _d2 >= 1 && _d2 <= 31) return new Date(_y, _m - 1, _d2).getTime();
          }
          if (v > 1e11) return v;                                   // 毫秒时间戳
          if (v > 1e9) return v * 1000;                             // 秒时间戳
          if (v > 20000 && v < 80000) return Math.round((v - 25569) * 86400000);   // Excel 序列号（1900 基准）
          return null;
        }
        var s = String(v).trim();
        if (!s) return null;
        // 【2026-10-09 同上】字符串形态的紧凑日期：YYYYMMDD / YYYYMMDDHHmmss（必须先于时间戳判断）
        if (/^\d{8}$/.test(s)) {
          var y8 = +s.slice(0, 4), m8 = +s.slice(4, 6), d8 = +s.slice(6, 8);
          if (y8 >= 1900 && y8 <= 2200 && m8 >= 1 && m8 <= 12 && d8 >= 1 && d8 <= 31) return new Date(y8, m8 - 1, d8).getTime();
        }
        if (/^\d{14}$/.test(s)) {
          var y14 = +s.slice(0, 4), m14 = +s.slice(4, 6), d14 = +s.slice(6, 8);
          var h14 = +s.slice(8, 10), mi14 = +s.slice(10, 12), se14 = +s.slice(12, 14);
          if (y14 >= 1900 && y14 <= 2200 && m14 >= 1 && m14 <= 12 && d14 >= 1 && d14 <= 31) {
            return new Date(y14, m14 - 1, d14, h14, mi14, se14).getTime();
          }
        }
        if (/^\d{10}$/.test(s)) return parseInt(s, 10) * 1000;
        if (/^\d{13}$/.test(s)) return parseInt(s, 10);
        if (/^\d{4,5}(\.\d+)?$/.test(s)) {
          var n2 = parseFloat(s);
          if (n2 > 20000 && n2 < 80000) return Math.round((n2 - 25569) * 86400000);
        }
        // 中文 / 点 / 斜杠 统一成 'YYYY-M-D [H:M[:S]]' 再交给 Date（避免 '2026年9月3日' 之类解析失败）
        var s2 = s.replace(/[年月]/g, '-').replace(/日/g, ' ').replace(/[.\/]/g, '-').replace(/\s+/g, ' ').trim();
        var m = s2.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:\s+(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?)?/);
        if (m) {
          var dt = new Date(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0));
          return isNaN(dt.getTime()) ? null : dt.getTime();
        }
        var t = new Date(s).getTime();
        return isNaN(t) ? null : t;
      }
      try { window.__riskParseDateTime = _riskParseDateTime; } catch (e) {}

      /** 【2026-10-09 真机修复】取一条台账记录的单位名 —— 与导入映射（issue.js）保持**同一套字段**：
       *  unit ← item.unit / '单位' / '责任单位' / '单位名称' / danwei / '部门' / department，再兜底几个常见别名。
       *  ⚠️ 真机问题：预览原来只认 d.unit / d.department，字段名一对不上就"全部不匹配" ⇒ 界面显示"筛选后 0 条"
       *     而库里明明有 4 万多条。这里按导入侧同口径取值，避免"写入用一套键、筛选看另一套键"。
       */
      function _riskUnitOf(d) {
        if (!d || typeof d !== 'object') return '';
        var v = d.unit || d['单位'] || d['责任单位'] || d['单位名称'] || d.danwei || d['部门'] || d.department
          || d.unitName || d.org || d.orgName || d.dw || d.company || '';
        return String(v == null ? '' : v).trim();
      }
      try { window.__riskUnitOf = _riskUnitOf; } catch (e) {}

      function _doRiskPreview() {
        var preview = document.getElementById('risk-data-preview');
        if (!preview) return;
        var dateStartEl = document.getElementById('risk-date-start');
        var dateEndEl = document.getElementById('risk-date-end');
        var unitEl = document.getElementById('risk-unit');
        var dateStart = (dateStartEl && dateStartEl.value) || '';
        var dateEnd = (dateEndEl && dateEndEl.value) || '';
        var unit = ((unitEl && unitEl.value) || '').trim();
        var hasFilter = !!(dateStart || dateEnd || unit);

        // 时间边界/关键字只解析一次，避免在游标回调里反复 new Date()
        var sd = dateStart ? new Date(dateStart + 'T00:00:00').getTime() : NaN;
        var ed = dateEnd ? new Date(dateEnd + 'T23:59:59').getTime() : NaN;
        var uLower = unit.toLowerCase();

        function _fail() {
          var t = document.getElementById('risk-preview-total');
          var f = document.getElementById('risk-preview-filtered');
          if (t) t.textContent = '读取失败';
          if (f) f.textContent = '读取失败';
          if (hasFilter) preview.style.display = 'flex';
        }

        var dbRef = null;
        function _close() { try { if (dbRef) dbRef.close(); } catch (e) {} dbRef = null; }

        try {
          // 不带版本号打开：只读预览不需要升级，也不会因版本号不一致抛 VersionError
          var dbReq = indexedDB.open('RailwayIssueDB_v2');
          dbReq.onblocked = _fail;
          dbReq.onerror = _fail;
          dbReq.onsuccess = function() {
            var db = dbReq.result;
            dbRef = db;
            if (!db.objectStoreNames.contains('issues')) {
              // 问题台账库还不存在（首次使用、issue.js 尚未初始化）：本次 open 只会建出一个空库。
              // 按 0 条显示即可；不要 deleteDatabase —— 删除会阻塞其他模块后续的 open/upgrade。
              _close();
              var t0 = document.getElementById('risk-preview-total');
              var f0 = document.getElementById('risk-preview-filtered');
              if (t0) t0.textContent = '0 条';
              if (f0) f0.textContent = '0 条';
              if (hasFilter) preview.style.display = 'flex';
              return;
            }
            var store;
            try {
              store = db.transaction('issues', 'readonly').objectStore('issues');
            } catch (e) { _close(); _fail(); return; }

            var total = -1;      // -1 = count() 尚未返回
            var scanned = 0;
            var filtered = 0;
            var capped = false;  // 是否因达到上限/超时提前停止
            var unknownDate = 0; // 【2026-10-09】日期无法识别的条数（计入筛选结果但不排除，界面如实标注）
            var unitHits = 0;    // 【2026-10-09】台账里**实际带单位字段**的条数（=0 说明字段名不对，需提示用户）
            var dateFail = 0;    // 被日期条件排除的条数（筛成 0 时用于自证原因）
            var unitFail = 0;    // 被单位条件排除的条数
            var sampleDates = []; // 【2026-10-09】库中时间原值样例（最多 2 条）——筛成 0 条时直接展示"原值→解析结果"，
                                  //   让"格式对不对"一眼可见（真机那次反馈就是因为看不出日期到底长什么样）
            var cpuMs = 0;       // 本函数累计耗时（不含等待 IDB 回调的空闲时间）
            var units = Object.create(null);
            var done = false;

            function _render() {
              var totalEl = document.getElementById('risk-preview-total');
              var filteredEl = document.getElementById('risk-preview-filtered');
              var totalTxt = (total >= 0 ? String(total) : (capped ? '≥' : '') + scanned) + ' 条';
              if (totalEl) totalEl.textContent = totalTxt;
              // 未设筛选条件时「筛选」与「总计」必然相同，直接复用总数，
              // 否则会出现「总计 40166 条 / 筛选 ≥20000 条」这种自相矛盾的显示
              if (filteredEl) {
                var _tip = [];
                if (unknownDate) _tip.push('含 ' + unknownDate + ' 条日期无法识别、未排除');
                // 【2026-10-09 真机反馈】筛成 0 条时必须**能自证原因**（否则用户只能猜"是不是没数据"）：
                //   区分"单位字段根本不存在"与"被哪个条件排除"，并给出可核对的方向。
                if (hasFilter && filtered === 0) {
                  if (uLower && unitHits === 0) _tip.push('台账里未找到单位字段 ⇒ 单位条件把全部记录排除，请核对台账是否含"单位/责任单位"列');
                  else {
                    if (dateFail) {
                      var _ds = sampleDates.map(function (x) {
                        var t = _riskParseDateTime(x);
                        return JSON.stringify(x) + '→' + (t === null ? '无法识别' : new Date(t).toLocaleDateString('zh-CN'));
                      }).join('；');
                      _tip.push('被日期条件排除 ' + dateFail + ' 条' + (_ds ? '（库中时间样例：' + _ds + '）' : ''));
                    }
                    if (unitFail) _tip.push('被单位条件排除 ' + unitFail + ' 条');
                    if (!dateFail && !unitFail) _tip.push('库中无满足全部条件的记录');
                  }
                }
                filteredEl.textContent = hasFilter
                  ? ((capped ? '≥' : '') + filtered + ' 条' + (_tip.length ? '（' + _tip.join('；') + '）' : ''))
                  : totalTxt;
              }
              if (hasFilter) preview.style.display = 'flex';
            }

            function _finish() {
              if (done) return;
              done = true;
              // 单位下拉：只用已扫描到的记录填充（上限内足够用），不为此再多遍历一遍全库
              var unitInput = document.getElementById('risk-unit');
              var ukeys = Object.keys(units);
              if (unitInput && ukeys.length > 0) {
                var datalistId = 'risk-unit-list';
                var dl = document.getElementById(datalistId);
                if (!dl) { dl = document.createElement('datalist'); dl.id = datalistId; document.body.appendChild(dl); }
                dl.innerHTML = '';
                ukeys.sort().forEach(function(u) {
                  var opt = document.createElement('option');
                  opt.value = u;
                  dl.appendChild(opt);
                });
                if (!unitInput.getAttribute('list')) unitInput.setAttribute('list', datalistId);
              }
              _render();
              // 提前停止游标时事务虽会自动提交，但不依赖 oncomplete 一定回调，
              // 这里直接关闭连接（IDB 语义：close() 会等已开启的事务跑完，安全）
              _close();
            }

            // 总数：count() 零遍历、瞬时返回
            try {
              var cntReq = store.count();
              cntReq.onsuccess = function() { total = cntReq.result; if (done) _render(); };
              cntReq.onerror = function() { total = -1; };
            } catch (e) {}

            var curReq;
            try { curReq = store.openCursor(); } catch (e) { _finish(); _close(); return; }
            curReq.onerror = function() { _finish(); _close(); };
            curReq.onsuccess = function(e) {
              var cursor = e.target.result;
              if (!cursor || scanned >= RISK_PREVIEW_MAX_SCAN || cpuMs > RISK_PREVIEW_MAX_MS) {
                if (cursor) capped = true; // 库里还有记录没遍历 → 计数只能给下限
                _finish();
                return;
              }
              var t0 = _riskNow();
              try {
                var d = cursor.value || {};
                scanned++;
                var _uRaw = _riskUnitOf(d);       // 见上方注释：与导入映射同一套字段
                if (_uRaw) { units[_uRaw] = 1; unitHits++; }
                if (sampleDates.length < 2 && d.datetime != null && d.datetime !== '') sampleDates.push(String(d.datetime));
                var ok = true;
                if (dateStart || dateEnd) {
                  var _dr = _riskDateInRange(d.datetime, dateStart, dateEnd, sd, ed);
                  if (_dr === 'unknown') unknownDate++;   // 日期识别不了 ⇒ 计入、不排除（见 _riskDateInRange 注释）
                  else if (!_dr) { ok = false; dateFail++; }
                }
                if (ok && uLower) {
                  if (_uRaw.toLowerCase().indexOf(uLower) === -1) { ok = false; unitFail++; }
                }
                if (ok) filtered++;
              } catch (err) {}
              cpuMs += _riskNow() - t0;
              try { cursor.continue(); } catch (err) { _finish(); }
            };
            // 事务收尾统一关闭连接，避免只读连接泄漏阻塞后续版本升级
            try {
              var txn = store.transaction;
              txn.oncomplete = function() { _close(); };
              txn.onabort = function() { _finish(); _close(); };
              txn.onerror = function() { _finish(); _close(); };
            } catch (e) {}
          };
        } catch (e) { _fail(); }
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
        window.downloadBlob(blob, '风险研判_' + window.localDateStr() + '.txt');
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

      /** 「开始研判 / 停止」同一个按钮：统一维护文案与配色（id=risk-main-btn，见 index.html） */
      function _riskSetBtn(running) {
        // 【2026-10-01】复位按钮时顺手停掉等待期计时（覆盖成功/失败/超时/用户停止所有出口）
        if (!running && window._riskWaitTimer) {
          try { clearInterval(window._riskWaitTimer); } catch (e) {}
          window._riskWaitTimer = null;
        }
        var b = document.getElementById('risk-main-btn');
        if (!b) return;
        b.textContent = running ? '⏹ 停止研判' : '📊 开始研判';
        b.style.background = running ? 'linear-gradient(135deg,#dc2626,#b91c1c)' : 'var(--primary)';
        b.title = running ? '点击中止本轮研判' : '按当前条件开始研判';
      }

      /**
       * 【2026-09-30 用户口径】停止本轮研判（与「开始」同按钮）。
       * 实现方式：abort 掉进行中的请求（_riskAbortCtl，见 runRiskAnalysis 内部），
       *   置 _riskStopped 让 catch 分支区分"用户主动停止"与"真失败"，并复位按钮与结果区。
       */
      window.riskStopAnalysis = function () {
        try {
          window._riskStopped = true;
          if (window._riskAbortCtl && typeof window._riskAbortCtl.abort === 'function') {
            window._riskAbortCtl.abort(new Error('UserStop'));
          }
        } catch (e) {}
        window._riskRunning = false;
        _riskSetBtn(false);
        var c = document.getElementById('risk-results');
        if (c) {
          c.innerHTML = '<div style="padding:16px;color:var(--text-secondary);text-align:center;line-height:1.9;">'
            + '⏹ 已停止本轮研判<br><span style="font-size:0.78rem;">（可修改条件后再点「📊 开始研判」）</span></div>';
        }
      };

      window.runRiskAnalysis = async function(followUp) {
        var container = document.getElementById('risk-results');
        var refineArea = document.getElementById('risk-refine');
        if (!container) return;
        // 运行中再点同一个按钮 = 停止（不再像原来那样并发跑第二轮）
        if (window._riskRunning) { try { window.riskStopAnalysis(); } catch (e) {} return; }
        window._riskStopped = false;
        container.style.display = 'block';
        // 【2026-10-01 优化】等待期显示「已等 Ns」：单轮最长 180s（思考模式 240s），原来只有一个转圈，
        //   用户分不清"在跑"还是"卡住"（对规/智能体都有秒数，这里补齐）。计时器在按钮复位时统一清理。
        var _riskWaitT0 = Date.now();
        var _riskWaitBase = followUp ? '正在重新分析' : '正在汇总本地数据并分析风险';
        if (window._riskWaitTimer) { try { clearInterval(window._riskWaitTimer); } catch (e) {} window._riskWaitTimer = null; }
        container.innerHTML = '<div style="padding:20px;color:var(--text-secondary);text-align:center;">'
          + '<div style="display:inline-block;width:20px;height:20px;border:2px solid var(--border);border-top-color:var(--primary);border-radius:50%;animation:spin 0.6s linear infinite;margin-bottom:8px;"></div>'
          + '<p id="risk-wait-text">📊 ' + _riskWaitBase + '…</p></div>';
        window._riskWaitTimer = setInterval(function () {
            try {
                var el = document.getElementById('risk-wait-text');
                if (!el) return;
                var s = Math.round((Date.now() - _riskWaitT0) / 1000);
                el.textContent = '📊 ' + _riskWaitBase + '…已等 ' + s + 's' + (s >= 60 ? '（长报告较慢，可随时点「⏹ 停止研判」）' : '');
            } catch (e) {}
        }, 1000);

        try {
          var apiKey = localStorage.getItem('ds_api_key_v1') || '';
          if (!apiKey) { container.innerHTML = '<div style="color:#dc2626;padding:20px;">请先配置 API Key</div>'; return; }
          var apiUrl = window.dsGetApiUrl(); // v3.70：归一化（缺 https:// 时 fetch 会按相对路径打到本站 → 404）
          var model   = localStorage.getItem('ds_model_v1') || 'deepseek-flash';

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

            // 【2026-09-30 用户口径】**没有任何输入时不要强制研判**。
            //   原来：focus 为空会被降级成"通用安全风险"，并把整库数据全量跑一轮（还会往资料库落一份报告）。
            //   现在：四个条件（重点关注 / 时间范围 / 责任单位）全空 ⇒ 只提示、不发起请求、不落库。
            if (!focus && !dateStart && !dateEnd && !unit) {
              container.innerHTML = '<div style="padding:18px;color:var(--text-secondary);line-height:1.9;">'
                + '请先填写 <b>重点关注</b>，或选择 <b>时间范围</b>／<b>责任单位</b>，再点「📊 开始研判」。<br>'
                + '<span style="font-size:0.78rem;">空条件不再自动跑全库研判；确实要做整体研判时，'
                + '在「重点关注」里写明即可（例如：通用安全风险）。</span></div>';
              _riskSetBtn(false);
              return;
            }
            window._riskRunning = true;
            _riskSetBtn(true);

            var summary = await _buildRiskDataSummary(dateStart, dateEnd, unit);
            noIssueData = summary.indexOf('【检查信息】总计') === -1;
            // 【2026-10-01】留一份"数据口径"首行（如「【检查信息】总计 43526 条, 本次筛选 120 条」），
            //   供报告头部回显 —— 报告全文由模型生成，用户看不到它依据的数据范围。
            try { window.__riskLastDataLine = String(summary.split('\n')[0] || '').slice(0, 140); } catch (e) {}
            var userMsg = '请基于以下铁路安全检查数据进行风险研判：\n\n' + summary + '\n\n';
            userMsg += '研判要求：\n';
            if (dateStart || dateEnd) userMsg += '- 时间范围：' + (dateStart||'不限') + ' 至 ' + (dateEnd||'不限') + '\n';
            if (unit) userMsg += '- 限定责任单位：' + unit + '\n';
            if (focus) userMsg += '- 重点关注：' + focus + '\n';   // 不再降级为"通用安全风险"（空条件已被上面拦下）
            userMsg += '- 输出格式：' + formatDesc + '\n';
            // 【2026-10-09 用户要求·多源化】三件事：① 数据源勾选**真正生效**（不勾选则本次不使用）
            //   ② **重点时段因子**（按研判日期自动匹配：春运/两会/汛期/暑运/节假日/防寒/施工旺季）
            //   ③ **天气接入**（按站名查未来 3 天，查不到就如实说明，不编造）。
            //   依据是实测结论：原研判只引用 检查信息/手册/案例/规章 4 源，天气与重点时段**完全缺失**
            //   —— 用户不在"研判重点"里手写"节日/汛期"，研判就根本不会考虑它们。
            var _offSrcs = [];
            try { _offSrcs = JSON.parse(localStorage.getItem('risk_src_off') || '[]') || []; } catch (e) {}
            if (_offSrcs.length) {
                var _offLabel = { issues: '检查信息台账', handbook: '检查手册', cases: '事故案例', rules: '规章条款', weather: '天气', period: '重点时段' };
                userMsg += '- 数据源开关：用户已**关闭** ' + _offSrcs.map(function (k) { return _offLabel[k] || k; }).join('、')
                    + ' —— 本次研判**不得引用**这些数据（如确有必要，只提示"可在上方数据源面板开启"），其余照常。\n';
            }
            // ② 重点时段因子（纯日期推算，零数据依赖）
            if (_offSrcs.indexOf('period') === -1 && window.RiskFactors && typeof window.RiskFactors.toText === 'function') {
                var _pf = window.RiskFactors.toText(dateStart, dateEnd);
                if (_pf && _pf.indexOf('无明显重点时段因子') === -1) {
                    userMsg += '\n【重点时段因子（按研判日期自动匹配，必须纳入研判）】\n' + _pf + '\n'
                        + '要求：逐条判断这些时段因子**会放大哪些已有风险**（结合上面的检查信息），并给出针对该时段的准备与管控措施；'
                        + '"即将进入"的因子要作为前瞻风险单独提示。\n';
                }
            }
            // ③ 天气接入（有站名才查；查不到就如实标注，不阻塞、不编造）
            if (_offSrcs.indexOf('weather') === -1) {
                var _wStation = '';
                try { _wStation = String(localStorage.getItem('risk_weather_station') || '').trim(); } catch (e) {}
                if (!_wStation) {
                    try {
                        var _wu = document.getElementById('risk-unit');
                        _wStation = _wu ? String(_wu.value || '').replace(/(供电|工务|电务|车务|机务|车辆|客运|货运|房建|通信|基础设施)(段|站|所)?.*$/, '').trim() : '';
                    } catch (e) {}
                }
                if (_wStation && typeof window._agentExecuteTool === 'function') {
                    var _wTxt = '';
                    try {
                        var _wR = await window._agentExecuteTool('get_weather', { stationName: _wStation });
                        var _w = (_wR && _wR.result) || null;
                        if (_wR && _wR.ok && _w) {
                            var _cur = _w.current || {};
                            _wTxt = '站点：' + (_w.station || _wStation)
                                + '｜实时：' + (_cur.temp != null ? _cur.temp + '℃ ' : '') + String(_cur.text || _cur.weather || '').trim();
                            var _dl = Array.isArray(_w.daily) ? _w.daily.slice(0, 3) : [];
                            if (_dl.length) {
                                _wTxt += '\n未来 3 天：' + _dl.map(function (x) {
                                    return String(x.date || '') + ' ' + String(x.text || x.weather || '')
                                        + (x.tempMax != null ? (x.tempMin != null ? (' ' + x.tempMin + '~' + x.tempMax + '℃') : (' ' + x.tempMax + '℃')) : '')
                                        + (x.precip != null ? (' 降水' + x.precip + '%') : '');
                                }).join('；');
                            }
                        }
                    } catch (e) {}
                    userMsg += _wTxt
                        ? '\n【天气（本地接入 · 站点 ' + _wStation + '）】\n' + _wTxt + '\n要求：把天气作为**动态因子**纳入研判（降雨/大风/高温/低温分别对应防洪、异物侵限、线索驰度、覆冰等风险），并说明其对上述检查问题的放大作用。\n'
                        : '\n【天气】本次未能接入天气数据（站点"' + _wStation + '"查询失败）。涉及气象风险时必须**如实说明"未接入天气数据，请以气象预报为准"**，不要凭空推测天气，也不要假装已获取。\n';
                }
            }
            // 【2026-10-09 第二批·用户"继续做"】④ 结构化卡片 ⑤ 依据清单 ⑥ 与上次研判对比
            //   ④ 实测输出是"自由长文"：风险点散在段落里、等级与措施不成组、没法当清单用。给固定骨架后
            //      每个风险点自带"等级（含口径）+ 依据（逐条标来源）+ 措施四要素"，可直接照此整改。
            var _structOn = true;
            try { _structOn = window.RiskPanel ? window.RiskPanel.structOn() : true; } catch (e) {}
            if (_structOn) {
                userMsg += '\n【输出结构（结构化卡片 · 必须严格遵守）】每个风险点按此骨架成文，**不得合并、不得省略任何一行**：\n'
                    + '### 风险点 N：<一句话名称>\n'
                    + '- 风险等级：高 / 中 / 低（注明判定口径，如"可能性中 × 后果严重"）\n'
                    + '- 主要依据：① 台账：<筛选条数与典型问题> ② 事故案例：<《名称》> ③ 规章：《名称》第N条（无条号写"（条号待核实）"）'
                    + ' ④ 天气：<本场天气> ⑤ 重点时段：<因子名及如何放大风险>\n'
                    + '- 管控措施：责任人/岗位 · 完成时限 · 达到什么标准（可当场核对）· 谁验收\n'
                    + '（依据里没有的项写"本次未涉及"，**不要编造**；等级必须给判定口径。）\n';
            }
            // ⑤ 依据清单（引用透明）：数字**照抄**上方各数据段标题，禁止改写或估算
            userMsg += '\n【报告末尾必须附「本次研判依据清单」】一行一类，数字照抄上方各数据段标题里的条数，不得改写、不得估算：\n'
                + '检查信息（筛选 N 条，时间范围/单位）｜ 检查手册 N 条 ｜ 事故案例 N 条（列名称）｜ 规章条款 N 条（列名称，无条号写"条号待核实"）'
                + ' ｜ 天气（站点与时段）｜ 重点时段因子（命中项）\n';
            // ⑥ 与上次研判对比（本地留存的上次结论；没有则跳过，不编造）
            var _lastR = null;
            try { _lastR = window.RiskPanel ? window.RiskPanel.last() : null; } catch (e) {}
            if (_lastR && _lastR.text) {
                userMsg += '\n【上次研判（本地留存 · ' + String(_lastR.ts || '').slice(0, 10) + '；条件：' + String(_lastR.cond || '').slice(0, 60) + '）】\n'
                    + String(_lastR.text).slice(0, 600) + '\n\n'
                    + '要求：在「本次研判依据清单」之后加一节【与上次研判的变化】：① 新增的风险点；② 等级发生变化的项；'
                    + '③ 上次已提出但仍未见整改的问题。**若两次条件（时间/单位/重点）不同，先说明条件差异，不要强行对比**；'
                    + '上次结论里没有的信息不得臆测。\n';
            }
            userMsg += '- 可参考下方【事故案例】（来自规章制度库「事故案例」专业）与【相关规章条款】中的真实案例与条款，结合检查信息开展研判，使结论更具针对性。\n';
            // 【2026-10-09 真机反馈·硬约束】模型曾以"数据量少"为由**只回一句、不成文**
            //   （真机：筛选 16 条 ⇒ 报告区只出现"…，未形成内容"）。研判的职责是**照结构成文**，
            //   而不是判断"值不值得写" —— 条数少只影响"样本量提示"，不影响是否输出正文。
            userMsg += '\n【必须成文（硬约束）】无论筛选出多少条数据（哪怕只有几条），都必须**按上面的结构与格式完整成文**；'
                + '数据少时正常分析，并在结论中说明"样本量较小、趋势参考意义有限"，'
                + '**严禁**以"数据不足 / 未形成内容 / 无法研判"为由拒绝输出正文，也严禁只回一句话。\n';
            userMsg += '\n请开始分析。';

            messages = [
              { role: 'system', content: '你是铁路安全风险分析专家。请严格按照用户要求的时间范围、专业限定、分析重点和输出格式进行分析。\n【重要约束】统计数字与日期只能来自下方【检查信息】真实汇总数据；【事故案例】与【相关规章条款】可如实引用其名称与内容（引用时标明名称/出处），但严禁虚构任何统计数字、事故案例或时间；若某方面数据不足，必须如实说明"数据不足"，不得编造或推测具体数字。' },
              { role: 'user', content: userMsg }
            ];
            // 【视觉模型接入】若当前附件含图片且模型支持视觉，把首条 user 消息 content 改为多模态数组
            (function() {
              try {
                var _rModel = localStorage.getItem('ds_model_v1') || 'deepseek-flash';
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
            try { window.__riskLastRefine = refineText; } catch (e) {}   // 【2026-10-01】供报告头部回显追问内容
            messages.push({ role: 'user', content: refineText });
            if (refineInput) refineInput.value = '';
          }

          // 思考模式：跟随设置页开关（默认开）。开启时思维链会占用输出预算。
          // 【2026-10-09 真机实测定档】
          //   · 现象（用户真机）：跑了 30 多秒报告仍空白。协议级实测坐实机理 ——
          //     思考开 + max_tokens 700 ⇒ `finish_reason=length`、**正文 0 字**、思考 1092 字；
          //     同预算关思考 ⇒ 正文 1217 字。即**思考会把输出预算吃光 ⇒ content 为空**。
          //   · 端到端实测（真实浏览器 + 思考开 + 8192）：总 56s，其中第一次请求正文为空、
          //     靠"降级重试"救回 3680 字 ⇒ 修复生效，但**白等一次**。
          //   · 定档实测：`max_tokens=16384` **模型接受**（HTTP 200），思考开时 13s **一次成文** 1453 字。
          //   ⇒ 故研判上限提到 16384（省掉重试的那次白等）；仍保留"空正文降级重试"兜底
          //     （思考极长时仍可能吃光），并对"换模型后 16384 不被接受"做降级（见下方 400 分支）。
          var _riskBody = { model: model, messages: messages, temperature: 0.3, max_tokens: 16384, stream: false };
          var _riskThinking = false;
          if (typeof window.dsThinkingParam === 'function') {
            var _tp = window.dsThinkingParam({ apiUrl: apiUrl, model: model });
            Object.assign(_riskBody, _tp);
            _riskThinking = !!(_tp.thinking && _tp.thinking.type === 'enabled');
            if (_riskThinking) _riskBody.max_tokens = 16384;
          }
          // Y1：增加整体超时，避免长报告假死、不可中断（思考模式耗时更长，放宽到 240s）
          var _riskAbort = new AbortController();
          // 【2026-09-30 用户口径】把控制器暴露出去，让「⏹ 停止研判」能真正中止请求
          //   （原来它只在模块闭包里，用户无论如何都停不下来）。
          window._riskAbortCtl = _riskAbort;
          var _riskTimeout = setTimeout(function() {
            try { _riskAbort.abort(new Error('TimeoutError')); } catch (e) {}
          }, _riskThinking ? 240000 : 180000);
          var resp;
          try {
            resp = await fetch(apiUrl, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + apiKey },
              body: JSON.stringify(_riskBody),
              signal: _riskAbort.signal
            });
          } finally {
            clearTimeout(_riskTimeout);
          }

          if (!resp.ok) {
            // 统一错误映射：官方错误码为 400/401/402/422/429/500/503（模型名错误以 400 返回）。
            var _etxt = ''; try { _etxt = await resp.text(); } catch (_e) {}
            var _edet = ''; try { _edet = ((JSON.parse(_etxt) || {}).error || {}).message || ''; } catch (_e) { _edet = String(_etxt).slice(0, 200); }
            // 【2026-10-09 换模型兜底】研判上限 16384 是 deepseek-flash 实测接受的值；用户若换成
            //   输出上限更小的模型/provider，会以 400（max_tokens 超限）被拒 ⇒ 这里**降级到 8192 重发一次**，
            //   而不是把 400 直接抛给用户（业界通行做法：参数不被接受时按能力降级重试）。
            if (resp.status === 400 && /max_tokens/i.test(_edet) && _riskBody.max_tokens > 8192) {
              _riskBody.max_tokens = 8192;
              try {
                resp = await fetch(apiUrl, {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + apiKey },
                  body: JSON.stringify(_riskBody),
                  signal: _riskAbort.signal
                });
              } catch (_e3) { /* 落到下方统一错误提示 */ }
              if (!resp || !resp.ok) {
                try { _etxt = await resp.text(); } catch (_e) {}
                try { _edet = ((JSON.parse(_etxt) || {}).error || {}).message || ''; } catch (_e) { _edet = String(_etxt).slice(0, 200); }
              }
            }
            if (!resp || !resp.ok) {
              throw new Error(typeof window.dsAiHttpError === 'function'
                ? window.dsAiHttpError(resp ? resp.status : 0, _edet)
                : ('请求失败（HTTP ' + (resp ? resp.status : '?') + '）' + (_edet ? '：' + _edet : '')));
            }
          }
          var data = await resp.json();
          var _msg0 = (data.choices && data.choices[0] && data.choices[0].message) || {};
          var report = String(_msg0.content || '');
          var _finish = String((data.choices && data.choices[0] && data.choices[0].finish_reason) || '');
          var _rLen = String(_msg0.reasoning_content || '').length;
          // 【2026-10-09 真机修复·空正文自动降级重试】真机现象：思考型模型把输出预算全用在 reasoning 上 ⇒
          //   content 为空、finish_reason='length'，报告区空白（用户："跑了 30 多秒，报告还是无"）。
          //   处理（业界对"输出被推理吃光"的通行做法：**降级 + 明确格式**，而非直接报错）：
          //     · 关闭 thinking（重试时模型无需再推理一遍 ⇒ 预算全给正文，也不撞模型输出上限）；
          //     · 追加一条明确指令"直接输出报告正文，不要输出推理过程"；
          //     · 成功则用重试结果，失败则走下面的"如实告知 + 诊断"，绝不静默留白。
          var _retried = false;
          if (report.trim().length < 50 && _rLen > 200) {
            _retried = true;
            try {
              var _retryBody = {
                model: model,
                messages: messages.concat([{ role: 'user', content: '（系统提示）请**直接输出报告正文**，不要再输出任何推理或思考过程，结构按上面的要求。' }]),
                temperature: 0.3, max_tokens: 8192, stream: false,
                thinking: { type: 'disabled' }
              };
              var _retryCtl = new AbortController();
              window._riskAbortCtl = _retryCtl;   // 让「⏹ 停止研判」在重试阶段同样有效
              var _retryT = setTimeout(function () { try { _retryCtl.abort(new Error('TimeoutError')); } catch (e) {} }, 180000);
              var _resp2;
              try {
                _resp2 = await fetch(apiUrl, {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + apiKey },
                  body: JSON.stringify(_retryBody),
                  signal: _retryCtl.signal
                });
              } finally { clearTimeout(_retryT); }
              if (_resp2 && _resp2.ok) {
                var _d2 = await _resp2.json();
                var _m2 = (_d2.choices && _d2.choices[0] && _d2.choices[0].message) || {};
                var _c2 = String(_m2.content || '');
                if (_c2.trim().length >= 2) {
                  report = _c2;
                  _finish = String((_d2.choices && _d2.choices[0] && _d2.choices[0].finish_reason) || '');
                  _rLen = String(_m2.reasoning_content || '').length;
                }
              }
            } catch (_e2) { /* 重试失败不阻塞：下面统一给出如实提示 */ }
          }
          try { window.__riskLastDiag = { finish: _finish, contentLen: report.length, reasoningLen: _rLen, retried: _retried }; } catch (e) {}
          // 仍然为空 ⇒ **如实告知 + 带上诊断**（真机上"报告无"最容易被误以为系统坏了）
          if (report.trim().length < 2) {
            report = '⚠️ 模型本次没有返回正文（更可能是**输出预算被"思考过程"占用**，而不是没有数据）。\n\n'
              + '**诊断**：finish_reason=' + (_finish || '?') + '｜思考长度=' + _rLen + ' 字｜已自动重试=' + (_retried ? '是' : '否') + '。\n\n'
              + '**建议**：① 在设置里**关闭"思考模式"**后重试；② 或缩小时间范围（数据少、报告短，思考占用更少）；③ 仍失败可换模型再试。';
          }

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
          // 【2026-10-01 优化】报告头部回显「研判条件 · 数据口径」：
          //   报告正文完全由模型生成，条件（时间/单位/重点/格式）只写在 prompt 里、界面上看不到；
          //   补一行 chip，便于核对"这份报告是按什么条件、多大范围跑出来的"（与"走本地核验"同一透明度思路）。
          try {
            var _chipParts = [];
            if (followUp) {
              _chipParts.push('追问：' + String(window.__riskLastRefine || '进一步分析').slice(0, 60));
            } else {
              var _dsEl = document.getElementById('risk-date-start'), _deEl = document.getElementById('risk-date-end');
              var _unEl = document.getElementById('risk-unit'), _foEl = document.getElementById('risk-focus');
              var _fmtEl = document.querySelector('input[name="risk-format"]:checked');
              var _fmtTxt = { full: '完整报告', brief: '简要摘要', actions: '仅整改措施' }[(_fmtEl && _fmtEl.value) || 'full'] || '完整报告';
              _chipParts.push('时间：' + ((_dsEl && _dsEl.value) || '不限') + ' ~ ' + ((_deEl && _deEl.value) || '不限'));
              _chipParts.push('单位：' + ((_unEl && _unEl.value.trim()) || '全部'));
              _chipParts.push('重点：' + ((_foEl && _foEl.value.trim()) || '（未填）'));
              _chipParts.push('格式：' + _fmtTxt);
              if (window.__riskLastDataLine) _chipParts.push(String(window.__riskLastDataLine));
            }
            var _chip = document.createElement('div');
            _chip.id = 'risk-cond-chip';
            _chip.style.cssText = 'padding:6px 10px;background:var(--card-bg);border:1px solid var(--border);border-radius:8px;font-size:0.74rem;color:var(--text-secondary);margin-bottom:10px;line-height:1.6;word-break:break-word;';
            _chip.textContent = '🧭 研判条件 · ' + _chipParts.join(' ｜ ');
            container.insertBefore(_chip, container.firstChild);
          } catch (e) {}
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
          // 【2026-09-30】本轮结束：复位"运行中"状态与按钮（闲时回到「📊 开始研判」）
          window._riskRunning = false;
          _riskSetBtn(false);
        } catch(e) {
          // 【2026-09-30】用户点「⏹ 停止研判」造成的 abort **不是错误**：
          //   riskStopAnalysis 已经把提示与按钮状态写好了，这里静默复位即可，不报错、不落库。
          window._riskRunning = false;
          _riskSetBtn(false);
          if (window._riskStopped) return;
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

      /**
       * 事故案例「相关度排序」（风险研判内部用 · 纯内存，无索引依赖）：
       *   按研判重点分词命中打分 —— 标题命中 +3、正文命中 +1（同一词最多计 3 次），等分保持原库顺序。
       *   目的：与研判重点相关的案例排前面，同时**不丢弃**不相关案例（模型仍能看到库里有哪些案例）。
       */
      function _riskRankCases(list, focus) {
        var f = String(focus || '').trim();
        if (!f || !list || list.length < 2) return list || [];
        var terms = f.split(/[\s,，、;；/|]+/).filter(function (x) { return !!x; });
        if (!terms.length) terms = [f];
        var scored = list.map(function (r, i) {
          var t = String((r && r.title) || '').toLowerCase();
          var c = String((r && r.content) || '').toLowerCase().slice(0, 4000);
          var s = 0;
          terms.forEach(function (w) {
            w = String(w).toLowerCase();
            if (!w) return;
            if (t.indexOf(w) !== -1) s += 3;
            var hit = 0, idx = c.indexOf(w);
            while (idx !== -1 && hit < 3) { s += 1; hit++; idx = c.indexOf(w, idx + w.length); }
          });
          return { r: r, i: i, s: s };
        });
        scored.sort(function (a, b) { return (b.s - a.s) || (a.i - b.i); });
        return scored.map(function (x) { return x.r; });
      }

      async function _buildRiskDataSummary(dateStart, dateEnd, unitFilter) {
        var parts = [];
        var startDate = dateStart ? new Date(dateStart + 'T00:00:00') : null;
        var endDate = dateEnd ? new Date(dateEnd + 'T23:59:59') : null;
        var all = [];
        // 【v3.76 口径统一 · 取数同源】优先用内存缓存：issue.js 的 dataCache 本身就是整库 getAll 的结果，
        //   与「智能写作」取数完全同源（避免"刚导入未刷新 / 两边读的不是同一份"造成数字不一致），并且省掉一次全表读。
        //   内存为空（极早调用、刚清空数据）时才退回直读 IndexedDB。
        try {
          var _memIssues = (typeof window.getIssueData === 'function') ? window.getIssueData() : [];
          if (_memIssues && _memIssues.length) all = _memIssues;
        } catch (e) {}
        var _ownConn = false; // 是否由本函数自己打开的连接（自己开的才关，共享连接不能关）
        try {
          // 内存里已有整库数据就跳过直读（下方 if 块内的代码保持原缩进，便于对照历史 diff）
          if (!all.length) {
          // 优先用 dbManager，失败则直接打开
          var db;
          try {
            db = await window.dbManager.getDB('RailwayIssueDB_v2');
          } catch(e) {
            console.warn('[风险] dbManager 失败，尝试直接打开:', e.message);
            db = await new Promise(function(res, rej) {
              // 不带版本号打开：本库由 issue.js 升到 v3，这里写死 2 会抛 VersionError 让研判整体失败
              var r = indexedDB.open('RailwayIssueDB_v2');
              r.onblocked = function(){ rej(new Error('数据库被其他页面占用')); };
              r.onerror = function(){ rej(r.error); };
              r.onsuccess = function(){ res(r.result); };
            });
            _ownConn = true;
          }
          all = await new Promise(function(res) {
            var tx = db.transaction('issues','readonly');
            var s = tx.objectStore('issues');
            s.getAll().onsuccess = function(e) { res(e.target.result || []); };
          });
          // 只有本函数自己打开的连接才关闭（dbManager 返回的是共享连接，关掉会影响其他模块）
          if (_ownConn) {
            try { db.close(); } catch(e) {}
          }
          }   // ← 结束"内存无数据才直读 IndexedDB"分支（见函数开头 _memIssues）
          if (all.length) {
            // 【v3.76 口径统一】筛选/统计改用 utils.js 的共用实现（与「智能写作」同一口径）：
            //   · 性质按 A/B/C/红线/其他 归类 —— 原来按原始字符串分桶，'A' 与 'A类' 会各占一项，
            //     于是同一段时间出现"研判：A(3)、A类(2)"而"报告：A 类 5 条"两套数字；现已收敛为一套；
            //   · 日期边界统一为本地日、单位过滤语义不变（与原实现一致）；
            //   · 共用实现缺失（浏览器还跑着旧缓存脚本）时退回原实现，功能不受影响。
            var _sharedStat = (typeof window.dsIssueFilter === 'function' && typeof window.dsIssueAggregate === 'function');
            var filtered = _sharedStat
              ? window.dsIssueFilter(all, { start: dateStart, end: dateEnd, unit: unitFilter })
              : (function () {
                  var f = all;
                  if (startDate) f = f.filter(function(d) { try { return new Date(d.datetime||'') >= startDate; } catch(e) { return false; } });
                  if (endDate) f = f.filter(function(d) { try { return new Date(d.datetime||'') <= endDate; } catch(e) { return false; } });
                  if (unitFilter) f = f.filter(function(d) { return (d.unit||'').indexOf(unitFilter) !== -1 || (d.department||'').indexOf(unitFilter) !== -1; });
                  return f;
                })();
            var dateLabel = [dateStart ? '从'+dateStart : '', dateEnd ? '至'+dateEnd : ''].filter(Boolean).join(' ') || '全部时间';
            var _agg = _sharedStat ? window.dsIssueAggregate(filtered) : null;
            var cats = _agg ? _agg.category : (function(){ var m={}; filtered.forEach(function(d){ m[d.category]=(m[d.category]||0)+1; }); return m; })();
            var nats = _agg ? _agg.quality : (function(){ var m={}; filtered.forEach(function(d){ m[d['性质']]=(m[d['性质']]||0)+1; }); return m; })();
            var units = _agg ? _agg.unit : (function(){ var m={}; filtered.forEach(function(d){ if(d.unit) m[d.unit]=(m[d.unit]||0)+1; }); return m; })();
            // 仅控制台诊断：发生了"异体写法归类"（A / A类 / A级…）时提示一次，不进入界面与提示词文字
            if (_agg && typeof window.dsQualityMerged === 'function') {
              var _mergedQ = window.dsQualityMerged(_agg.qualityRaw);
              if (_mergedQ && typeof console !== 'undefined') console.log('[研判] 性质异体写法已按 A/B/C/红线/其他 归类：', _mergedQ);
            }
            var _topN = (typeof window.dsTopEntries === 'function') ? window.dsTopEntries : function(m, n) { return Object.entries(m||{}).sort(function(a,b){return b[1]-a[1];}).slice(0, n||5); };
            var _fmtTop = function(e) { return e[0] + '(' + e[1] + ')'; };
            parts.push('【检查信息】总计'+all.length+'条, 本次筛选'+filtered.length+'条('+dateLabel+(unitFilter?'/单位:'+unitFilter:'')+')');
            parts.push('类别TOP5: '+_topN(cats,5).map(_fmtTop).join(', '));
            parts.push('性质分布: '+_topN(nats,5).map(_fmtTop).join(', '));
            if (Object.keys(units).length > 0) parts.push('涉及单位: '+_topN(units,10).map(_fmtTop).join(', '));
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
            // ⚠️ 注意：riskFocus 的赋值在本函数靠后几十行；var 只提升"声明"不提升"赋值"，
            // 直接读会恒为 undefined —— "按研判重点筛选手册"这条因此永久失效。故此处先取一次值。
            var _rfEarly = (document.getElementById('risk-focus') ? document.getElementById('risk-focus').value : '') || '';
            var hbFocus = (_rfEarly || '').trim();
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

        // ---------- 读取规章制度库：「事故案例」专业（按专业归类）+ 相关规章条款 ----------
        // 【2026-09-20 修正 · 用户口径】"事故案例"在规章制度模块里就是一个**专业分类**（rule.trade），
        //   所以案例要**按专业判定**（结构化，比正则可靠），而不是"拿研判重点去检索、命中什么都算案例"。
        //   同时修掉两个既有缺陷：
        //   ① 旧 KB 路径：填了研判重点时检索词只剩重点词 → 命中的是普通条款，却标注成「事故专业案例」，
        //      并且因"有命中"而跳过兜底 → 名实不符（模型以为在看案例，其实是条款）；
        //   ② 旧兜底路径：把 ruleCollection 的 getAll() 结果（整库只有一条记录 {id:1,data:[...rules]}）
        //      当单条规章读 r.title / r.content → 永远匹配 0 条（该分支实则恒输出"未匹配到"）。
        //   现在：案例段走内存数组（getRulesData）+ 按研判重点本地排序（**不依赖 KB**，KB 关闭/未就绪也有案例）；
        //        条款段仍走统一检索层（带出处）；两段分开标注，谁都不冒充谁。
        try {
          var riskFocus = (document.getElementById('risk-focus') ? document.getElementById('risk-focus').value : '') || '';
          var _rf = String(riskFocus).trim();
          var _caseTradeOf = function (t) { return String(t == null ? '' : t).indexOf('案例') !== -1; };
          var _rulesLive = (typeof window.getRulesData === 'function') ? (window.getRulesData() || []) : [];
          var _cases = _rulesLive.filter(function (r) { return _caseTradeOf(r && r.trade); });
          var _caseByRegex = false;
          if (!_cases.length) {
            // 兼容：数据未按专业分类时才退回关键词识别（只看标题 + 正文前 400 字，避免正文偶尔提到"事故"被误判）
            var _caseKw = /事故|案例|事件|通报|险情|故障|险性/;
            _cases = _rulesLive.filter(function (r) {
              return _caseKw.test(String((r && r.title) || '') + '\n' + String((r && r.content) || '').slice(0, 400));
            });
            _caseByRegex = _cases.length > 0;
          }
          var _CASE_TOP = 10;
          if (_cases.length) {
            var _shownCases = _riskRankCases(_cases, _rf).slice(0, _CASE_TOP);
            parts.push('\n【事故案例（来自规章制度库 · 专业分类「事故案例」' + (_caseByRegex ? '，按关键词识别' : '') + '）】共 ' + _cases.length + ' 条'
              + (_rf ? '，按研判重点「' + _rf + '」相关度排序' : '') + '，展示前 ' + _shownCases.length + ' 条：');
            var _byTradeCase = {};
            _shownCases.forEach(function (r) { var tr = String((r && r.trade) || '事故案例'); (_byTradeCase[tr] = _byTradeCase[tr] || []).push(r); });
            Object.keys(_byTradeCase).forEach(function (tr) {
              parts.push('\n▪ 专业：' + tr);
              _byTradeCase[tr].forEach(function (r) {
                var c = String((r && r.content) || '').replace(/\s+/g, ' ').trim();
                parts.push('  - 《' + ((r && r.title) || '未命名') + '》' + (c ? '：' + (c.length > 200 ? c.slice(0, 200) + '…' : c) : ''));
              });
            });
          } else {
            parts.push('\n【事故案例】规章制度库中暂无案例资料：请在「规章制度」模块导入事故通报/事故案例，并把专业分类选为「事故案例」。');
          }

          // 相关规章条款（统一检索层 · 按研判重点，**剔除案例专业**，避免"标题是案例、内容是条款"）
          try {
            var _kbOnRisk = (typeof window.KB.getSwitch === 'function') ? window.KB.getSwitch('kb_agent') : true;
            if (_rf && window.KB && typeof window.KB.search === 'function' && _kbOnRisk) {
              if (typeof window.KB.ensure === 'function') await window.KB.ensure(['rules']);
              // perDoc:1 —— 同一份规章最多出 1 块（研判要的是"关联到哪些规章"，不必同一规章出多块，
              //   否则提示词里会出现多条《同一规章》第N条，挤占其它规章的额度）
              var _kbRr = window.KB.search(_rf, { sources: ['rules'], topK: 12, perDoc: 1 });
              var _kbHitsRisk = ((_kbRr && _kbRr.length) ? _kbRr[0].hits : [])
                .filter(function (h) { return !_caseTradeOf(h && h.trade); })
                // 同一规章可能被切成多块同时命中（perDoc 允许 2 块/文件）→ 同一「标题 + 条号」只取一块，
                //   否则提示词里会出现两条一模一样的《X》第N条
                .filter(function (h, i, arr) {
                  var k = String(((h.doc || {}).title) || '') + '|' + String(h.ref || '');
                  return arr.findIndex(function (x) { return String(((x.doc || {}).title) || '') + '|' + String(x.ref || '') === k; }) === i;
                });
              if (_kbHitsRisk.length) {
                parts.push('\n【相关规章条款（统一检索层 · 按研判重点「' + _rf + '」条款级命中，带出处）】命中 ' + _kbHitsRisk.length + ' 条，按专业归类：');
                var _byTradeRisk = {};
                _kbHitsRisk.forEach(function(h2) {
                  var _doc2 = h2.doc || {};
                  var _tr2 = _doc2.trade || h2.trade || '通用';
                  (_byTradeRisk[_tr2] = _byTradeRisk[_tr2] || []).push({ title: _doc2.title || '未命名', path: h2.path || '', text: h2.text || '' });
                });
                Object.keys(_byTradeRisk).forEach(function(tr3) {
                  parts.push('\n▪ 专业：' + tr3);
                  _byTradeRisk[tr3].forEach(function(c3) {
                    var t3 = String(c3.text).replace(/\s+/g, ' ').trim();
                    parts.push('  - 《' + c3.title + '》' + (c3.path ? '（' + c3.path + '）' : '') + (t3 ? '：' + (t3.length > 200 ? t3.slice(0, 200) + '…' : t3) : ''));
                  });
                });
              }
            }
          } catch (eKbRisk) { console.warn('风险研判: 相关规章条款检索失败（不影响案例段）：', eKbRisk && eKbRisk.message); }
        } catch(e) { parts.push('\n【事故案例】读取失败'); console.error('风险研判: 规章库读取异常', e); }

        return parts.join('\n');
      }

      // ---------- 9. 增强 dsSendMsg（角色提示词 + 记忆）----------
      window.ROLE_PROMPTS = ROLE_PROMPTS;
      window.ROLE_OUTPUT_NORMS = ROLE_OUTPUT_NORMS;   // v3.76：专业角色统一输出规范（frontend 不追加）
      // 【优化】废话抑制硬约束 + 角色回扣：由 Part A 在 system 提示末尾追加（Part A 跨 IIFE 需经 window）
      window.CHAT_STYLE_NORMS = CHAT_STYLE_NORMS;
      window.dsRoleRecall = buildRoleRecall;

      // 【P1 角色下沉】把「术语与条款 / 专业边界」两行按专业取出来，供其它模块复用。
      //   为什么只给两行而不是整个角色提示：智能对规是"从候选条款里挑最相关的 1-3 个"的结构化
      //   JSON 任务，塞进整段角色提示只会稀释指令；而术语口径恰好直接决定用词差异下的匹配准确率
      //   （如"分路不良" vs "轨道电路不良"），专业边界则避免选到外专业条款。
      //   同时避免各模块各维护一份专业术语表（维护面翻倍且会漂移）。
      var TRADE_KEY_MAP = {
        '工务': 'gongwu', '电务': 'dianwu', '供电': 'gongdian', '车务': 'chewu',
        '客运': 'keyun', '机务': 'jiwu', '车辆': 'cheliang', '通信': 'tongxin',
        '房建': 'fangjian', '货运': 'huoyun', '综合': 'tongyong', '通用': 'default'
      };
      window.dsTradeNorms = function (tradeNameOrKey) {
        try {
          var raw = String(tradeNameOrKey == null ? '' : tradeNameOrKey).trim();
          if (!raw) return '';
          var key = TRADE_KEY_MAP[raw] || (/^[a-z]+$/.test(raw) ? raw : '');
          var t = key && ROLE_PROMPTS[key];
          if (!t) return '';
          return t.split('\n').filter(function (l) {
            return /^【术语与条款】/.test(l) || /^【专业边界】/.test(l);
          }).join('\n');
        } catch (e) { return ''; }
      };

      /**
       * 【2026-09-27 角色作用审计】统一的「当前角色」读取口 —— 单一事实来源。
       * 为什么要有它：此前各处（对话主通道、天气报告模板…）都直接 `document.getElementById('expertRole').value`，
       *   一旦 DOM 读不到（尚未初始化、被重建、面板未渲染）就**静默回落 default** ——
       *   用户表现为"我选了电务角色，可它答得像通用助手"，却没有任何提示。
       * 顺序：① 下拉框当前值 → ② localStorage `ds_role_v1`（持久化选择）→ ③ 'default'；
       *   角色键不存在（脏值/旧版本残留）也回落 default，绝不返回空人设。
       * 返回 { key, label, prompt, isCode }。
       */
      var ROLE_LABELS = {
        auto: '自动',   // 【2026-10-07】自动角色：按问题推断专业（见 dsResolveRole）
        default: '通用', dianwu: '电务', gongwu: '工务', gongdian: '供电', keyun: '客运', chewu: '车务',
        jiwu: '机务', cheliang: '车辆', tongxin: '通信', fangjian: '房建', huoyun: '货运',
        tongyong: '综合', frontend: '前端开发', riskanalyst: '风险分析'
      };
      window.dsGetRole = function () {
        var key = '';
        try {
          var sel = document.getElementById('expertRole');
          if (sel && sel.value) key = String(sel.value);
        } catch (e) {}
        if (!key) { try { key = String(localStorage.getItem('ds_role_v1') || ''); } catch (e) {} }
        // 【2026-10-07】'auto' 是**合法值** —— 它表示"按问题自动判断专业"（每轮由 dsResolveRole 解析）。
        //   若沿用下面这行的原写法（!ROLE_PROMPTS['auto'] ⇒ 打回 default），选了"自动"也永远走通用角色。
        if (!key || (key !== 'auto' && !ROLE_PROMPTS[key])) key = 'default';
        if (key === 'auto') return { key: 'auto', label: '自动', prompt: '', isCode: false, auto: true };
        return {
          key: key,
          label: ROLE_LABELS[key] || key,
          prompt: ROLE_PROMPTS[key] || '',
          isCode: key === 'frontend'
        };
      };
      /**
       * 【2026-10-07 用户需求】解析本轮**实际角色**：选了「自动」时按问题推断专业，否则原样返回。
       *   用户原话："角色的选择是否也可以加一个自动角色选择按钮，根据具体问题进行专业角色选择，
       *   提高智能对话效果及体验"。
       *   设计要点：
       *   ① 复用 `window.patchInferTrade`（对规 / 术语 / 检索**共用**同一套专业词库）—— 不另立第二套口径，
       *      否则会出现"角色判成电务、检索却按工务"的错位；
       *   ② 代码/前端类与风险研判类**先判**（信号明确，且不属于业务专业）；
       *   ③ 判不出来回落「通用」并**说明原因**（如实，不假装识别成功）；
       *   ④ 返回值与 dsGetRole 同结构，多带 auto/reason ⇒ 回答尾部「本次参考」行会标出本轮实际角色，
       *      用户随时能看到"为什么这次这样答"。手动选定的角色**绝不干预**（picked.key !== 'auto' 直接返回）。
       *   诊断：`__dsResolveRole('分路不良怎么处理')`
       */
      var DS_TRADE_TO_ROLE = {
        '电务': 'dianwu', '工务': 'gongwu', '供电': 'gongdian', '车务': 'chewu', '机务': 'jiwu',
        '车辆': 'cheliang', '通信': 'tongxin', '房建': 'fangjian', '客运': 'keyun', '货运': 'huoyun'
      };
      window.dsResolveRole = function (query) {
        var picked = window.dsGetRole();
        if (!picked || picked.key !== 'auto') return picked;          // 手动选择：绝不干预
        var q = String(query || '');
        var key = '', reason = '';
        try {
          // 【2026-10-08 用户报"检测不到数据"，并怀疑自动角色判得不合适】旧判据把「帮我写 / 写一个 / 生成一个 /
          //   页面 / 布局」也当作代码特征 —— 它们在安监业务里极其常见（"帮我写一份整改通知书""写一个检查方案"），
          //   于是业务问题被误判成 frontend，连带本地资料被掐掉（见 _dsRunStream 的 hasAnySource，已同步放宽）。
          //   现改为**两档**：
          //     ① 强特征（技术名词，单独出现即可）：代码/程序/脚本/html/css/js/网页/前端/组件/函数/接口/报错/调试/正则/数据库/sql/python/java/C++；
          //     ② 弱特征（页面/布局/样式/界面/按钮/表单/动画）必须**与"写/生成/创建/做/改/优化/实现"同现**。
          var _codeStrong = /代码|程序|脚本|html|css|javascript|\bjs\b|网页|前端|组件|函数|接口|报错|调试|正则|数据库|\bsql\b|python|java|c\+\+|编程/i;
          var _codeTech = /页面|布局|样式|界面|按钮|表单|动画|响应式/i;
          var _codeAsk = /写|生成|创建|做一个|改|优化|实现|加个|加一个/i;
          if (_codeStrong.test(q) || (_codeTech.test(q) && _codeAsk.test(q))) {
            key = 'frontend'; reason = '代码 / 前端请求';
          } else if (/风险研判|研判|风险等级|隐患分析|预警措施|风险点/.test(q)) {
            key = 'riskanalyst'; reason = '风险研判类问题';
          } else if (typeof window.patchInferTrade === 'function') {
            var trade = window.patchInferTrade(q);
            if (trade && DS_TRADE_TO_ROLE[trade]) { key = DS_TRADE_TO_ROLE[trade]; reason = '专业推断：' + trade; }
          }
        } catch (e) {}
        if (!key || !ROLE_PROMPTS[key]) {
          return { key: 'default', label: '通用', prompt: ROLE_PROMPTS['default'] || '', isCode: false,
                   auto: true, reason: '未识别出专业，按通用作答' };
        }
        return { key: key, label: ROLE_LABELS[key] || key, prompt: ROLE_PROMPTS[key],
                 isCode: key === 'frontend', auto: true, reason: reason };
      };
      try { window.__dsResolveRole = window.dsResolveRole; } catch (e) {}
      window._originalSendMsg = window.dsSendMsg;

      // 角色注入和长期记忆已内置到 dsSendMsg 中，此处保留暴露 ROLE_PROMPTS
      window.dsSendMsg._roleInjectionEnabled = true;

      // ---------- 10. 反馈收集 ----------
      // msgIdx: 该气泡在 dsHistory 中的下标，用于「重生成」定位到具体这一轮
      function addFeedbackButtons(messageDiv, assistantContent, msgIdx) {
        // ⚠️【2026-10-07 用户反馈·真机】"回答完后操作按钮重复出现两组（刷新后正常）"的真根因：
        //   本函数原来**不幂等** —— 每次调用都 createElement + appendChild 一条新的 `.ds-feedback-bar`。
        //   它有两个调用点：
        //     ① `dsRenderAll()`（doubao.js）：流式结束后全量重渲染，给每条助手气泡挂一次；
        //     ② `enhanceBubbles()`（unified-enhancements.js）：卡片增强/联网证据条等重建后再挂一次。
        //   而 `dsSetHtmlKeepMedia` 带一条"内容没变就不重建"的优化（`host.__dsLastHtml === html` ⇒ 直接 return）
        //   ⇒ 增强那一次**跳过了重建**，① 挂的按钮条**没被清掉**，② 又 append 一条 ⇒ 用户看到两组按钮。
        //   刷新页面时走的是历史渲染路径（新气泡元素没有 __dsLastHtml ⇒ 必定重建 ⇒ 旧按钮随内容一起被替换）
        //   ⇒ 只剩一组 —— 与用户"刷新后就不重复"的观察完全吻合。
        //   这里做幂等：同一条气泡、同一轮下标已经挂过 ⇒ 直接返回；下标变了 ⇒ 先移除旧条再重建。
        //   （msgIdx 可能是 NaN：此时 `NaN === NaN` 恒假 ⇒ 走"移除旧条后重建"，仍然只会有一条。）
        if (!messageDiv) return;
        var _oldBar = messageDiv.querySelector('.ds-feedback-bar');
        if (_oldBar) {
          if (messageDiv.__dsFbIdx === msgIdx) return;
          try { _oldBar.parentNode.removeChild(_oldBar); } catch (e) {}
        }
        messageDiv.__dsFbIdx = msgIdx;

        var fbDiv = document.createElement('div');
        fbDiv.className = 'ds-feedback-bar';
        fbDiv.style.cssText = 'display:flex; gap:8px; justify-content:flex-end; margin-top:6px; flex-wrap:wrap;';
        fbDiv.innerHTML = '<button class="feedback-copy" style="background:none; border:1px solid #d1d5db; border-radius:14px; padding:3px 10px; font-size:0.75rem; cursor:pointer; color:#6b7280; transition:all 0.15s;" onmouseover="this.style.borderColor=\'#64748b\';this.style.color=\'#64748b\'" onmouseout="this.style.borderColor=\'#d1d5db\';this.style.color=\'#6b7280\'" title="复制本条回复">📋 复制</button>' +
                          '<button class="feedback-export" style="background:none; border:1px solid #d1d5db; border-radius:14px; padding:3px 10px; font-size:0.75rem; cursor:pointer; color:#6b7280; transition:all 0.15s;" onmouseover="this.style.borderColor=\'var(--primary)\';this.style.color=\'var(--primary)\'" onmouseout="this.style.borderColor=\'#d1d5db\';this.style.color=\'#6b7280\'" title="导出为 DOCX 文档（与历史报告同一套公文排版）">📤 导出</button>' +
                          '<button class="feedback-good" style="background:none; border:1px solid #d1d5db; border-radius:14px; padding:3px 10px; font-size:0.75rem; cursor:pointer; color:#6b7280; transition:all 0.15s;" onmouseover="this.style.borderColor=\'var(--success)\';this.style.color=\'var(--success)\'" onmouseout="this.style.borderColor=\'#d1d5db\';this.style.color=\'#6b7280\'">👍 有用</button>' +
                          '<button class="feedback-bad" style="background:none; border:1px solid #d1d5db; border-radius:14px; padding:3px 10px; font-size:0.75rem; cursor:pointer; color:#6b7280; transition:all 0.15s;" onmouseover="this.style.borderColor=\'var(--accent)\';this.style.color=\'var(--accent)\'" onmouseout="this.style.borderColor=\'#d1d5db\';this.style.color=\'#6b7280\'">👎 无用</button>' +
                          '<button class="feedback-regen" onclick="window.dsRegenerate()" style="background:none; border:1px solid #d1d5db; border-radius:14px; padding:3px 10px; font-size:0.75rem; cursor:pointer; color:#6b7280; transition:all 0.15s;" onmouseover="this.style.borderColor=\'var(--primary)\';this.style.color=\'var(--primary)\'" onmouseout="this.style.borderColor=\'#d1d5db\';this.style.color=\'#6b7280\'" title="重新生成本条回复">🔄 重生成</button>';
        // 语音朗读按钮（仅支持 Web Speech API 的浏览器显示）
        if (typeof window.speechSynthesis !== 'undefined') {
          var readBtn = document.createElement('button');
          readBtn.className = 'ds-read-btn';
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
        // 【v3.74】导出本消息为 DOCX（原「📥 下载」只导 .md，现复用历史报告的公文导出链路）
        //   · 排版偏好与历史报告共用（设置里的「导出排版」：公文格式 GB/T 9704-2012 / 通用排版）；
        //   · 文件名取回复首行（清理 markdown 记号后 ≤18 字）+ 日期，便于区分多份导出；
        //   · 历史报告模块未加载时退化为导出 Markdown，保证按钮永远可用。
        fbDiv.querySelector('.feedback-export').onclick = function(){
          var raw = String(assistantContent || '');
          var firstLine = '';
          var lines = raw.split('\n');
          for (var _i = 0; _i < lines.length; _i++) {
            var t = lines[_i].trim();
            if (!t || t.indexOf('|') === 0 || t.indexOf('```') === 0) continue;   // 跳过空行 / 表格 / 代码围栏
            firstLine = t.replace(/[#*`>\-\[\]()【】]/g, '').trim();
            if (firstLine) break;
          }
          firstLine = firstLine.slice(0, 18).replace(/[\\/:*?"<>|]/g, '');
          var name = '智能对话_' + (firstLine ? firstLine + '_' : '') + window.localDateStr();
          if (typeof window.wrExportMdToDocx === 'function') {
            try {
              window.wrExportMdToDocx(raw, name);
            } catch (e) {
              alert('导出失败：' + (e && e.message ? e.message : e));
            }
            return;
          }
          // 兜底：历史报告导出模块未加载 → 导出 Markdown
          var blob = new Blob([raw], {type: 'text/markdown;charset=utf-8'});
          window.downloadBlob(blob, name + '.md');
        };
        fbDiv.querySelector('.feedback-good').onclick = function(){ saveFeedback('good', assistantContent); };
        fbDiv.querySelector('.feedback-bad').onclick = function(){ saveFeedback('bad', assistantContent); };
        // 用绑定而非内联 onclick，才能把本轮下标传进去
        var regenBtn = fbDiv.querySelector('.feedback-regen');
        if (regenBtn) regenBtn.onclick = function(){ window.dsRegenerate(msgIdx); };
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
        if (!btn) return;
        // 【v3.24-fix】syncMenuActive/closeMenu/openMenu 全部动态查询菜单节点，
        //   避免整页 innerHTML 还原后闭包 menu 指向幽灵节点（已脱离文档）导致操作无效果。
        function syncMenuActive() {
          var m = document.getElementById('ds-websearch-menu');
          if (!m) return;
          var on = localStorage.getItem('ds_web_search') === '1';
          m.querySelectorAll('.ds-dropdown-item').forEach(function(it) {
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
        function closeMenu() { var m = document.getElementById('ds-websearch-menu'); if (m) m.classList.remove('open'); }
        function openMenu() { var m = document.getElementById('ds-websearch-menu'); if (m) m.classList.add('open'); }
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
        // 【v3.23-fix】事件委托：绑定挂到静态父容器 #panel-doubao（它自身不会被
        //   page-state.js 的 p.innerHTML 还原替换，仅子节点被替换），从而折叠屏/
        //   刷新经整页 DOM 还原后委托依然有效。v3.22 误挂 #ds-sub-chat（会被替换）。
        var _wsRoot = document.getElementById('panel-doubao') || document;
        _wsRoot.addEventListener('click', function(e) {
          var t = e.target;
          if (!t) return;
          // 【v3.24-fix】每次点击动态查询菜单节点：v3.23 委托虽挂在 #panel-doubao 上
          //   永久有效，但闭包 menu 仍指向还原前的旧节点（幽灵节点），classList/contains
          //   操作无效果——必须动态查询最新节点。
          var menu = document.getElementById('ds-websearch-menu');
          // 点击按钮：toggle 自身菜单（v3.25 互斥：点开一个关闭其它所有弹出）
          if (t.closest('#ds-websearch-btn')) {
            e.stopPropagation();
            var willOpen = !(menu && menu.classList.contains('open'));
            if (typeof window.dsCloseAllChatPopups === 'function') window.dsCloseAllChatPopups(menu);
            if (menu) menu.classList.toggle('open', willOpen);
            return;
          }
          // 点击菜单项：开启 / 关闭
          var item = t.closest('.ds-dropdown-item');
          if (item && menu && menu.contains(item)) {
            e.stopPropagation();
            setWs(item.getAttribute('data-ws') === '1');
          }
        });
        // 点击面板外任意处收起菜单（委托到 document，且排除自身节点）
        document.addEventListener('click', function(e) {
          if (e.target && e.target.closest && e.target.closest('#ds-websearch-btn')) return;
          closeMenu();
        });
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
        // 【2026-09-19 实时进度】卡片即时插入到"思考中"行之前（不再等整轮结束），状态行每秒走秒
        var _agentT0 = Date.now();
        var _agentLive = '⏳ 思考中';
        var _agentCardHtml = function (m) {
          m = m || {};
          if (m.role === 'agent-plan') {
            return '<div style="margin-bottom:6px;background:#fffbeb;border-left:3px solid #f59e0b;color:#b45309;border-radius:6px;padding:5px 10px;font-size:0.82rem;line-height:1.5;">' + dsEsc(m.content) + '</div>';
          }
          if (m.role === 'agent-tool') {
            if (m.toolMeta) {
              var _evi = m.toolMeta.evidence ? '<div style="color:#047857;margin-top:2px;white-space:pre-wrap;">证据：' + dsEsc(m.toolMeta.evidence) + '</div>' : '';
              return '<div style="margin-bottom:6px;background:#f0fdf4;border-left:3px solid #10b981;color:#047857;border-radius:6px;padding:6px 10px;font-size:0.82rem;line-height:1.5;">'
                + '<div style="font-weight:600;">🔧 ' + dsEsc(String(m.content).replace(/^🔧\s*/, '')) + '</div>'
                + '<div style="color:#065f46;margin-top:2px;">用途：' + dsEsc(m.toolMeta.purpose || '') + '</div>' + _evi + '</div>';
            }
            return '<div style="margin-bottom:6px;background:#f0fdf4;border-left:3px solid #10b981;color:#047857;border-radius:6px;padding:5px 10px;font-size:0.82rem;line-height:1.5;">' + dsEsc(m.content) + '</div>';
          }
          if (m.role === 'assistant') {
            // B#8: 最终回答渲染 Markdown，与普通对话体验一致
            return '<div style="margin-bottom:10px;padding:10px 12px;background:#f0fdf4;border-radius:8px;line-height:1.7;font-size:0.9rem;">' + dsMarkdown(m.content) + '</div>';
          }
          return '';
        };
        var _agentTick = setInterval(function () {
          var _l = document.getElementById(loadingId);
          if (!_l) { clearInterval(_agentTick); return; }
          _l.innerHTML = _agentLive + '（已等 ' + Math.round((Date.now() - _agentT0) / 1000) + 's）';
        }, 1000);

        try {
          // 【视觉模型接入】收集当前附件中的图片，传给智能体（纯新增；无图时传空数组，向后兼容）
          var _agentImgs = [];
          try {
            var _atts = (window._dsAttachments || []).filter(Boolean);
            _agentImgs = _atts.filter(function(a) { return a && a.isImage && a.dataUrl; }).map(function(a) { return a.dataUrl; });
          } catch (_e) { _agentImgs = []; }
          var result = await window._agentRun(msg, _agentImgs, {
            onStep: function (ev) {
              if (!ev) return;
              if (ev.phase === 'thinking') _agentLive = '🧠 正在思考（第 ' + (ev.round || 1) + ' 轮）';
              else if (ev.phase === 'tool-start') _agentLive = '🔧 正在调用：' + ((ev.tools || []).join('、') || '工具');
              else if (ev.phase === 'tool-progress') _agentLive = '🔧 正在调用：' + (ev.tool || '工具') + (ev.text ? '（' + ev.text + '）' : '') + (ev.ms ? ' 已等 ' + Math.round(ev.ms / 1000) + 's' : '');
              else if (ev.phase === 'answer') _agentLive = '✍️ 正在整理回答';
              if ((ev.phase === 'plan' || ev.phase === 'tool-done') && ev.step) {
                var _card = _agentCardHtml(ev.step);
                var _l2 = document.getElementById(loadingId);
                if (_card) {
                  if (_l2) _l2.insertAdjacentHTML('beforebegin', _card);   // 即时插到"思考中"行之前
                  else historyEl.innerHTML += _card;
                  ev.step.__rendered = true;                                // 标记：收尾时不再重复渲染
                }
              }
              var _l3 = document.getElementById(loadingId);
              if (_l3) _l3.innerHTML = _agentLive + '（已等 ' + Math.round((Date.now() - _agentT0) / 1000) + 's）';
              historyEl.scrollTop = historyEl.scrollHeight;
            }
          });
          clearInterval(_agentTick);
          // 移除加载提示
          var ld = document.getElementById(loadingId);
          if (ld) ld.remove();
          if (result && result.messages) {
            result.messages.forEach(function(m) {
              if ((m.role === 'agent-plan' || m.role === 'agent-tool') && m.__rendered) return;   // 实时进度已插入过
              var _c2 = _agentCardHtml(m);
              if (_c2) historyEl.innerHTML += _c2;
            });
          }
        } catch(e) {
          clearInterval(_agentTick);
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
        // 【2026-09-21】除了 abort 在途请求，还要**作废当前 run 的令牌** —— 否则工具执行期（天气 5s / KB 冷建）
        //   按停止无效、循环下一轮又新建 AbortController 继续跑（用户看到"停了还在动"）。
        //   agent-core 每轮开头与每个工具执行前都会校验令牌。
        try { window.__agentRunToken = (window.__agentRunToken || 0) + 1; } catch (_) {}
        if (window.__agentAbort && typeof window.__agentAbort.abort === 'function') {
          try { window.__agentAbort.abort(); } catch (_) {}
        }
        _agentRunning = false;
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
            + '<span>'
            + '<button onclick="dsAgentClearPrefs()" title="清空用户偏好画像（常用单位/检索词/统计口径；不影响历史记录）" style="font-size:0.74rem;border:none;background:#e0e7ff;color:#4338ca;border-radius:8px;padding:4px 10px;cursor:pointer;margin-right:6px;">🧠 清空画像</button>'
            + '<button onclick="dsAgentClearHistory()" style="font-size:0.74rem;border:none;background:#fee2e2;color:#dc2626;border-radius:8px;padding:4px 10px;cursor:pointer;">🗑 清空</button>'
            + '</span>'
            + '</div>'
            // 【2026-09-21】进化：面板显示成功率/平均耗时/失败最多的工具 + 当前偏好画像（原来只有任务流水）
            + '<div id="ds-agent-stats" style="font-size:0.76rem;color:#64748b;margin-bottom:8px;">⏳ 统计中…</div>';
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
          // 统计行异步填充（不阻塞列表渲染）
          (async function() {
            try {
              var st = (typeof window.getAgentToolStats === 'function') ? await window.getAgentToolStats() : null;
              var el = document.getElementById('ds-agent-stats');
              if (!el || !st) return;
              var pref = (typeof window.getPreferencePrompt === 'function') ? window.getPreferencePrompt() : '';
              el.innerHTML = '📊 成功率 ' + st.成功率 + '｜平均耗时 ' + st.平均耗时s + 's'
                + (st.失败最多的工具 && st.失败最多的工具.length ? '｜失败最多：' + dsEsc(st.失败最多的工具.join('、')) : '｜无失败记录')
                + (pref ? '<br>🧠 ' + dsEsc(pref) : '<br>🧠 暂无偏好画像（多问答几次后自动累积）');
            } catch (e) {}
          })();
        } catch(e) {
          panel.innerHTML = '<div style="color:#dc2626;font-size:0.85rem;">加载历史失败：' + dsEsc(e.message || '') + '</div>';
        }
      };

      // 【2026-09-21】清空用户偏好画像（画像此前只写不读、更无任何清理入口 = 本地数据治理缺口）
      window.dsAgentClearPrefs = function() {
        if (typeof window.clearAgentPreferences !== 'function') { alert('偏好画像模块未加载'); return; }
        if (!confirm('确定清空智能体的用户偏好画像吗？\n（常用单位 / 常用检索词 / 统计口径；清空后需重新累积，不影响历史任务记录）')) return;
        window.clearAgentPreferences();
        var el = document.getElementById('ds-agent-stats');
        if (el) el.innerHTML = '🧠 偏好画像已清空（下次任务起重新累积）。';
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
