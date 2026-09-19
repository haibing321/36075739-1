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
                if (tab === 'doubao' && typeof window.loadDoubaoWebview === 'function') window.loadDoubaoWebview(panel);
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
                // 还原后若豆包网页版是当前视图，确保联网加载（防御快照保存瞬间 iframe 尚未注入真实 src 的极端情况）
                try {
                    if (_dsCurrentSub === 'doubao' && typeof window.loadDoubaoWebview === 'function') {
                        window.loadDoubaoWebview(document.getElementById('ds-sub-doubao'));
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

                // 豆包网页版：未配置 API 时显示（并懒加载 iframe）；已配置则隐藏并卸载（停止联网）
                if (webview) {
                    webview.style.display = hasApiKey ? 'none' : 'flex';
                    if (typeof window.unloadDoubaoWebview === 'function') {
                        if (hasApiKey) window.unloadDoubaoWebview(webview);
                        else window.loadDoubaoWebview(webview);
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
            var DS_DEFAULT_CFG = { rules: true, issue: true, handbook: false, wrAll: false, phone: false, diary: false, remember: true };
            (function initDataSourceDropdown() {
                var btn = document.getElementById('ds-datasource-btn');
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
                    var def = _sessionDataSource || DS_DEFAULT_CFG;
                    // 【v3.76】确认按钮文案随场景：输入框有内容 → 点它会「应用并发送」，如实标注，避免"只想保存却被发出去"的误解
                    var _cf = document.querySelector('.ds-ds-btn--confirm');
                    if (_cf) {
                        var _iv = (document.getElementById('ds-user-input') || {}).value || '';
                        _cf.textContent = _iv.trim() ? '应用并发送' : '应用';
                    }
                    // ⚠️ DOM 后缀是 wr-all，而持久化字段名是 wrAll：
                    // 原先 def['wr-all'] 恒为 undefined，等于每次打开「关联数据」面板都把这一项强制取消勾选，
                    // 用户勾选并「记住此次选择」后刷新即静默失效（会话内因 _sessionDataSource 仍带 wrAll 而看不出来）。
                    var _DS_CFG_KEYMAP = { 'wr-all': 'wrAll' };
                    ['rules','issue','handbook','wr-all','phone','diary','remember'].forEach(function(k){
                        var el = document.getElementById('ds-dialog-' + k);
                        if (el) el.checked = !!(def[_DS_CFG_KEYMAP[k] || k]);
                    });
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

            // ---- 构建系统提示词（含业务数据） ----
            async function dsBuildSystemPrompt(userQuery, dataSource) {
                if (!dataSource) dataSource = DS_DEFAULT_CFG;   // v3.76：默认值统一（原处与面板/会话兜底各写一份）
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

                // 【v3.73】本地资料统一走「统一检索层」（knowledge.js）：按自然粒度分块
                // （规章按条、手册按项点、资料按段落、问题库/电话/日志按条），命中块**完整**进上下文
                // 并带出处路径，取代下面各源"各自采样 + 截前 200/300/500 字"的旧逻辑。
                // 开关 kb_prompt：默认开；置 '0' 立即回退旧逻辑（便于对照与应急）。
                var _kbOnP = true;
                try { _kbOnP = localStorage.getItem('kb_prompt') !== '0'; } catch (e) {}
                if (_kbOnP && window.KB && typeof window.KB.search === 'function') {
                    var _kbSrcs = [];
                    if (useRules) _kbSrcs.push('rules');
                    if (useIssue) _kbSrcs.push('issues');
                    if (useHandbook) _kbSrcs.push('handbook');
                    if (useWrAll) _kbSrcs.push('materials', 'reports');
                    if (usePhone) _kbSrcs.push('phone');
                    if (useDiary) _kbSrcs.push('diary');
                    if (_kbSrcs.length) {
                        try {
                            // 先确保索引就绪：资料库/历史报告需从 IndexedDB 预载；大源（检查信息）分片异步建索引
                            if (typeof window.KB.ensure === 'function') await window.KB.ensure(_kbSrcs);
                            // 【C1/v3.74】按用途分档 topK：写作资料库/历史报告只是"文风/结构参考"，
                            //   实测它们占单轮注入量的 44%（业务源 28099 字 vs 文风源 21912 字），给 2 块足够；
                            //   业务源（规章/检查信息/手册/电话/日志）保持 5。
                            var _kbR = window.KB.search(userQuery, { sources: _kbSrcs, topK: 5, topKByKey: { materials: 2, reports: 2 } });
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
                        } catch (e) {
                            console.warn('[dsBuildSystemPrompt] 统一检索层失败，回退旧逻辑：', e && e.message);
                            _kbOnP = false;
                        }
                    }
                }
                if (!_kbOnP) {

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
                        { label: '📖 让 AI 读', primary: true, onClick: dsReadLinkWithAI }
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
                // 【v3.76 智能体并入对话】/agent <任务>：就地执行任务（规划 + 多步工具调用），
                //   执行过程以卡片形式留在本轮回答上方，不再需要切到独立「智能体」标签页。
                //   与独立入口共用同一个 agent-core（同一批工具、同一套 Key/模型），因此能力完全一致。
                if (rawUserText === '/agent' || rawUserText.startsWith('/agent ') || rawUserText.startsWith('/agent　')) {
                    const task = rawUserText.replace(/^\/agent[ \u3000]*/, '').trim();
                    if (!task) { alert('用法：/agent <任务>\n例如：/agent 统计上月供电专业 A 类问题并生成简报'); return; }
                    if (typeof window._agentRun !== 'function') { alert('智能体内核未加载，无法执行任务。'); return; }
                    input.value = '';
                    if (typeof window.dsSyncSendState === 'function') window.dsSyncSendState();
                    dsHistory.push({ role: 'user', content: rawUserText });
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
                                return window._agentRun(task, null, {
                                    onStep: function (ev) {
                                        if (!ev) return;
                                        if (ev.phase === 'plan' || ev.phase === 'tool-done') {
                                            if (ev.step && _cur) _cur.agentSteps.push(ev.step);
                                        } else if (ev.phase === 'thinking') {
                                            _live = '🧠 正在思考（第 ' + (ev.round || 1) + ' 轮）';
                                        } else if (ev.phase === 'tool-start') {
                                            _live = '🔧 正在调用：' + ((ev.tools || []).join('、') || '工具');
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
                var _reqHist = dsHistory.slice(-10);   // 请求用历史快照：此刻只含历史 + 本轮 user，不含下面这条空助手气泡
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
                var roleSelect = document.getElementById('expertRole');
                var selectedRole = roleSelect ? roleSelect.value : 'default';
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
                var _dataSrc = _tempSrc || _sessionDataSource || DS_DEFAULT_CFG;   // v3.76：默认值统一到 DS_DEFAULT_CFG
                // 【v3.76】代码角色（frontend）**不再注入铁路本地资料**：写代码时把规章/台账塞进提示词
                //   既无用又费 token（此前只排除了准则，资料仍会进 —— 本次审计发现的遗留）。
                //   等价于该角色下"关联数据全不选"，不影响其它角色。
                var hasAnySource = (_dataSrc.rules || _dataSrc.issue || _dataSrc.handbook || _dataSrc.wrAll || _dataSrc.phone || _dataSrc.diary) && !_isCodeRole;
                // 【v3.74 卡滞修复】本地资料准备失败**不再中断对话**：降级为"无资料模式"继续回答。
                //   这样资料侧的任何异常都不会把 dsStreaming 卡在 true（原先异常会跳过 finally 复位）。
                var baseSystem;
                try {
                    baseSystem = hasAnySource
                        ? await dsBuildSystemPrompt(finalText, _dataSrc)
                        : '你是一名铁路安全监察智能助手，回答请使用中文，条理清晰。';
                } catch (_prepErr) {
                    console.warn('[dsRunStream] 本地资料准备失败，降级为无资料模式：', _prepErr && _prepErr.message);
                    baseSystem = '你是一名铁路安全监察智能助手，回答请使用中文，条理清晰。';
                }
                clearTimeout(_prepHintTimer);   // 准备结束：撤掉"正在准备本地资料"的延时提示
                var systemPrompt = rolePrompt + memoryText + baseSystem;
                // 通用专业准则与知识更新指引：对所有角色/默认生效，强化专业深度、准确性与时效
                var proRoleGuidelines = '\n\n【专业回答准则】\n' +
                  '1. 知识分层：①铁路业务规章/检查信息/手册以本地数据库为权威源，必须优先检索并引用真实条款与案例；②涉及最新政策、标准修订、外部新闻、天气行情等时效信息，联网时直接引用检索结果并标注日期与来源；③本地未覆盖且未联网时，明确告知“需联网核实”，严禁臆造。\n' +
                  '2. 准确性：区分【已确认·基于本地数据】【推断】【待核实】；引用规章须注明名称与条款出处，禁止编造编号、数据或案例。\n' +
                  '3. 专业性：使用铁路行业规范术语；多专业问题从“人、机、环、管”与风险分级（高/中/低）视角结构化作答。';
                // 【v3.76】代码角色（frontend）不追加铁路业务准则（同上：避免业务框架污染代码任务）
                if (!_isCodeRole) systemPrompt += proRoleGuidelines;
                // 媒体输出规范：用户问图片/视频/音乐时，引导模型给出可内嵌显示的直链（而非仅给网页地址）
                try {
                    if (/图片|照片|配图|插图|图库|海报|视频|MV|音乐|歌曲|音频|听歌|铃声|封面|素材/i.test(finalText)) {
                        systemPrompt += '\n\n【图片/音视频输出规范】\n' +
                            '当用户要图片、视频或音乐时，除给出页面地址外，还必须给出可直接显示/播放的媒体直链：\n' +
                            '· 图片直链：以 .jpg/.jpeg/.png/.webp/.gif 结尾（如 https://images.unsplash.com/photo-xxx?w=800），单独占一行；\n' +
                            '· 视频直链：以 .mp4/.webm/.mov 结尾，单独占一行；音频直链：以 .mp3/.m4a/.wav/.flac 结尾，单独占一行。\n' +
                            '· 直链必须写完整（带 https:// 前缀）且真实可用；不确定时不要编造，如实说明「该站点不提供直链，已给出页面链接，点击可在浏览器打开」。\n' +
                            '· 只有直链才能在对话里自动渲染成图片或播放器；仅给网页链接时前端只能显示可点击的链接卡片。';
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
                if (_tempSrc) { window._tempDataSrc = null; }

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
                        // ⚠️ 顺序敏感：hasUrl 必须排在 bizDomain 之前判定。
                        // 反例（v3.64 及以前的实际缺陷）：「这个网页里的规章帮我看看 www.xxx.com」同时命中
                        // bizDomain 的「规章」→ 先判 bizDomain 直接 return false → **链接根本没被读取，
                        // 但 AI 照常作答**，用户以为它读过了。含链接时必须联网，与话题是否属业务域无关。
                        if (hasUrl.test(q)) return true;            // 含链接/网址：最高优先级，强制联网读取网页内容
                        if (bizDomain.test(q)) return false;       // 业务域问题一律走本地数据源，不自动联网
                        if (freshness.test(q)) return true;
                        if (explicitWeb.test(q)) return true;
                        return realtime.test(q);
                    })(finalText);
                    var useWebSearch = (localStorage.getItem('ds_web_search') === '1') || forceWs || autoWs;
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
                    })(finalText);
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
                            + '（如「什么是安全帽」「三级安全教育指什么」）。这类问题检索只会拖慢响应、浪费额度，对答案没有帮助；\n'
                            + '3) 一次提问检索 0～2 次足够，不要反复检索凑次数；确认已掌握所需信息后立即作答。\n'
                            + '二、时效纪律（无论是否检索，必须逐条遵守）：\n'
                            + '4) 只有当你确实看到了检索结果时，才可以标注「据联网检索」并给出真实来源；\n'
                            + '5) 若你判断无需检索、或未取得检索结果，禁止使用「今日/今天/刚刚/最新/近期」等时效词去描述内部知识；\n'
                            + '6) 若问题确实需要实时信息但未取得检索结果，必须明确说明「本次未取得实时检索结果」，'
                            + '并把内容标注为「模型内部知识（可能已过时）」；\n'
                            + '7) 严禁把内部知识或旧信息包装成「今日热点 / 最新消息」——这是最严重的错误，会导致用户误判；\n'
                            + '8) 严禁声称「我没有实时联网能力」：你已具备该能力，需要时直接调用即可。';
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
                        _thinkEffort = window.dsAutoThinkingEffort(finalText);
                        if (_thinkEffort === 'off') thinkingOn = false;   // 问候/寒暄类：连思考都不开，最快
                    }
                    // Tool Calls：工具 schema/执行器就绪即默认挂载，不再依赖设置开关——
                    // 是否真正调用由模型自行判断（它完全可以不调）；前端再多一层开关只会造成
                    // 「智能体能查天气、智能对话查不了」的能力割裂。
                    // D1：保留可用性守卫——agent-core 未加载时降级为普通对话，避免发送 tools:null 导致 400 或工具静默失效
                    var _toolsReady = (typeof window._agentToolsParam === 'function') && (typeof window._agentExecuteTool === 'function');
                    var _useTools = _isV4 && _toolsReady;
                    var _toolsParamArr = _useTools ? window._agentToolsParam() : null;
                    // 【v3.76 审计】联网与「本地检索工具」目前**互斥**：联网走 Responses/Anthropic 通道，
                    //   请求体里 tools 只放服务端 web_search；工具需要"模型调用→前端执行→回灌"的闭环，
                    //   而联网通道的流解析器只处理 server_tool_use/web_search 结果，不处理本地工具调用。
                    //   → 因此联网时本地工具不参与（本地资料仍通过 system/instructions 注入，能力不丢）。
                    //   这里打印一条诊断日志，避免"静默降级"难以排查；界面上也有对应说明（联网菜单）。
                    if (useWebSearch && _useTools && typeof console !== 'undefined') {
                        console.warn('[ds] 联网已开启：本轮只带服务端 web_search，本地检索工具（search_issues/search_rules 等）不参与；需要精确查台账明细请先关闭联网。');
                    }
                    var _toolExec = (typeof window._agentExecuteTool === 'function') ? window._agentExecuteTool : null;
                    // 思考模式会消耗推理 token，适当抬高 max_tokens 避免回答被截断
                    if (thinkingOn) maxTokens = (isFrontendRole || isCodeRequest) ? 24576 : 16384;

                    var _respEndpoints = dsResponsesUrlCandidates(dsApiUrl);
                    var responsesUrl = _respEndpoints[0];
                    var inputItems = dsHistory.slice(-10)
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
                                messages: dsBuildAnthropicMessages(dsHistory.slice(-10), visionUserContent),
                                tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 5 }],
                                stream: true,
                                temperature: 0.7
                            };
                        } else {
                            b = {
                                model: dsModel,
                                instructions: systemPrompt,
                                input: inputItems,
                                tools: [{ type: 'web_search' }],
                                reasoning: { effort: thinkingOn ? _thinkEffort : 'none' },
                                stream: true,
                                temperature: 0.7,
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
                    var _chatBody = { model: dsModel, messages: messages, stream: true, temperature: 0.7, max_tokens: maxTokens };
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
                        await _dsStreamChat(resp, assistantIdx, _pendingToolCalls);
                        // 若模型请求调用工具：本地执行后回灌结果，再请求一轮让其总结（最多 4 轮，避免无限循环）
                        var _tcRound = 1;
                        var _maxTcRounds = 4;
                        while (_useTools && _toolExec && _pendingToolCalls.length && _tcRound < _maxTcRounds) {
                            _tcRound++;
                            _pendingToolCalls = _pendingToolCalls.filter(Boolean);
                            // 官方硬性要求：携带 tools 的请求，后续轮次必须**完整回传 reasoning_content**，
                            // 即使该轮未真正产生工具调用；缺失会被 API 判 400。
                            // 本轮思维链已由 _dsStreamChat 累积进 dsHistory[assistantIdx].reasoning，先取出再回传。
                            var _tcReasoning = dsHistory[assistantIdx].reasoning || '';
                            // D2：回灌前规范化 arguments——模型未生成参数时为空串，必须补为 '{}' 合法 JSON，否则 API 报 400
                            _pendingToolCalls.forEach(function(_c) {
                                if (!_c.function) _c.function = { name: '', arguments: '{}' };
                                if (typeof _c.function.arguments !== 'string' || _c.function.arguments.trim() === '') _c.function.arguments = '{}';
                            });
                            var _tcAssistant = { role: 'assistant', content: null, tool_calls: _pendingToolCalls };
                            // 思考模式下必须把本轮 reasoning_content 一并回传，否则下一轮请求 400。
                            // 非思考模式（thinking disabled）不会产出该字段，此处自然为空、不影响请求。
                            if (_tcReasoning) _tcAssistant.reasoning_content = _tcReasoning;
                            messages.push(_tcAssistant);
                            for (var _k = 0; _k < _pendingToolCalls.length; _k++) {
                                var _call = _pendingToolCalls[_k];
                                var _args = {};
                                try { _args = _call.function.arguments ? JSON.parse(_call.function.arguments) : {}; } catch (e) { _args = {}; }
                                dsHistory[assistantIdx].content = '🔧 正在调用工具：' + _call.function.name + ' …';
                                (function() { var _cb = document.getElementById('ds-chat-box'); if (_cb) { var _bs = _cb.querySelectorAll('.ds-bubble-assistant'); var _lb = _bs[_bs.length - 1]; if (_lb) dsSetHtmlKeepMedia(_lb, dsBubbleInner(assistantIdx) + '<span class="ds-cursor">▌</span>'); dsScrollBottom(); } })();
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
                                (function() { var _cb = document.getElementById('ds-chat-box'); if (_cb) { var _bs = _cb.querySelectorAll('.ds-bubble-assistant'); var _lb = _bs[_bs.length - 1]; if (_lb) dsSetHtmlKeepMedia(_lb, dsBubbleInner(assistantIdx) + '<span class="ds-cursor">▌</span>'); dsScrollBottom(); } })();
                                var _tcContent = JSON.stringify(_exec && _exec.result !== undefined ? _exec.result : _exec, null, 2);
                                messages.push({ role: 'tool', tool_call_id: _call.id, content: _tcContent });
                            }
                            // 清空气泡，准备下一轮最终回答
                            dsHistory[assistantIdx].content = '';
                            dsHistory[assistantIdx].reasoning = '';
                            (function() { var _cb = document.getElementById('ds-chat-box'); if (_cb) { var _bs = _cb.querySelectorAll('.ds-bubble-assistant'); var _lb = _bs[_bs.length - 1]; if (_lb) dsSetHtmlKeepMedia(_lb, dsBubbleInner(assistantIdx) + '<span class="ds-cursor">▌</span>'); dsScrollBottom(); } })();
                            // 后续轮次：回灌工具结果（仍带 tools，允许模型继续调用或总结）
                            var _bodyN = { model: dsModel, messages: messages, stream: true, temperature: 0.7, max_tokens: maxTokens };
                            if (thinkingOn) { _bodyN.thinking = { type: 'enabled' }; _bodyN.reasoning_effort = _thinkEffort; } else { _bodyN.thinking = { type: 'disabled' }; }
                            if (_useTools) { _bodyN.tools = _toolsParamArr; }
                            var _respN = await fetch(dsApiUrl, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + key }, body: JSON.stringify(_bodyN), signal: window._dsAbortController.signal });
                            if (!_respN.ok) { _dsStreaming = false; var _et = await _respN.text(); dsHistory[assistantIdx].content = '❌ 工具结果回灌后请求失败（HTTP ' + _respN.status + '）：' + _et.slice(0, 200); dsRenderAll(); return; }
                            _pendingToolCalls = [];
                            await _dsStreamChat(_respN, assistantIdx, _pendingToolCalls);
                        }
                    }

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
            async function _dsStreamChat(resp, idx, toolCallsOut) {
                _dsStreaming = true; // 流式期间媒体降级为占位卡片，避免逐帧重建反复加载
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
            function dsWebChip(m) {
                var w = m && m.web;
                if (!w) return '';
                var base = 'display:flex;width:fit-content;align-items:center;gap:5px;margin-bottom:8px;padding:3px 9px;border-radius:999px;font-size:0.74rem;line-height:1.5;border:1px solid ';
                var txt, style;
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
                return '<div style="' + style + '">' + dsEsc(txt) + '</div>';
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
          '【应熟悉规章】《安全生产法》《铁路安全管理条例》《铁路技术管理规程》（综合及各专业分册）《铁路营业线施工安全管理办法》《铁路交通事故应急救援和调查处理条例》，以及双重预防机制、安全红线与标准化管理的相关文件。\n' +
          '【方法】识别系统性风险，按"人、机、环、管"与"高/中/低"风险分级结构化输出，给出可执行的预警与整改措施，引用本地检查信息与规章数据支撑结论。\n' +
          '【多专业协同】同一问题涉及多个专业时，指出主责专业与协同专业，并分别给出各自的管控要点，避免只从一个专业角度下结论。',
        'frontend':
          '你是一位资深前端工程师（Web/小程序方向）。\n' +
          '【交付标准】① 代码自包含、可直接运行：单文件 HTML 时把 CSS/JS 内联，除非用户要求拆分；② 优先零依赖（不引外部 CDN），确需库时说明用途与替代方案；③ 使用现代浏览器特性（ES2020+、Flex/Grid、CSS 变量），并保证移动端可用。\n' +
          '【输出格式】给完整代码块（标注语言），关键实现点用简短注释说明；最后附 3 行以内的使用说明或注意事项。\n' +
          '【质量底线】不留 TODO 占位；不臆造不存在的 API；用户给的现有代码要保留其结构与命名风格，只改必要部分。',
        'riskanalyst':
          '你是铁路安全风险分析专家。你的任务是：\n' +
          '1. 基于本地检查信息和规章制度（优先引用真实数据），识别当前最突出的安全风险领域\n' +
          '2. 按时间趋势、专业分布、问题性质三个维度分析\n' +
          '3. 针对高危领域给出具体的预警措施和整改建议\n' +
          '4. 输出格式要求：先概述总体情况，再分点列出风险等级（高/中/低），最后给出3-5条可执行的预警措施\n' +
          '5. 引用数据时标注来源和时间范围，建议要具体可操作；若本地数据不足，说明需补充或联网核实的方向。',
      };

      // 【v3.76】角色「输出规范」（所有**专业角色**统一追加；frontend 代码角色除外）
      //   为什么需要：13 个角色写清了「专业领域 / 应熟悉规章 / 典型风险 / 分析框架」，
      //   但**输出侧没有统一契约** —— 没规定结构、引用要细到什么程度、统计口径、建议要可执行、篇幅。
      //   而通用「专业回答准则」只覆盖了"知识分层 / 准确性分级 / 术语与风险分级"，
      //   所以这里只补它没覆盖的部分，不重复（避免提示词互相稀释）。
      const ROLE_OUTPUT_NORMS =
        '【输出规范】\n' +
        '1. 结构：先给结论与判断 → 再列依据（条款 / 台账 / 案例）→ 最后给可执行的整改或管控建议；条目多时用分点或表格，避免长段落堆砌。\n' +
        '2. 引用格式：「名称 + 条款号」的总要求见后文【专业回答准则】；本条补充格式细节 —— 检查信息与案例要带单位、日期（或时段）与问题性质，每条尽量标出来源（如「规章制度：XX办法 第N条」「检查信息：某供电段 2026-03」）。\n' +
        '3. 数据口径：问题性质按 A / B / C / 红线 四类；统计数字必须与本地台账一致，不得改变口径，也不得把估算值写成台账值。\n' +
        '4. 建议要可执行：写清「谁、在什么时机、做什么、达到什么标准」，避免「加强管理、提高认识」这类空话；一条建议只解决一个问题。\n' +
        '5. 跨专业问题：先答本职专业，再点明需协同的专业与协同要点（如供电作业涉及车务登销记、电务联锁试验）。\n' +
        '6. 篇幅：默认紧凑、先给关键结论；用户要求「详细 / 展开」时再逐条深入。';

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
          if (totalLen > BM25_POSTINGS_MAX_CHARS) { this._buildScan(); return; }
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
          if (totalLen > BM25_POSTINGS_MAX_CHARS) {
            // 超大语料退化模式：同样分片，避免一次阻塞
            const termDocs = new Map();
            let i = 0;
            return new Promise(function (resolve) {
              function step() {
                const end = Math.min(i + sliceSize, docCount);
                for (; i < end; i++) {
                  const tokens = self._tokenize(self._textOf(docs[i]));
                  const uniq = new Set(tokens);
                  uniq.forEach(function (t) {
                    if (!termDocs.has(t)) termDocs.set(t, []);
                    termDocs.get(t).push(i);
                  });
                }
                if (onProgress) onProgress(i, docCount);
                if (i < docCount) setTimeout(step, 0);
                else {
                  termDocs.forEach(function (docsArr, term) {
                    const freq = docsArr.length;
                    self.idf.set(term, Math.log((docCount - freq + 0.5) / (freq + 0.5) + 1));
                  });
                  resolve(true);
                }
              }
              step();
            });
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
        // 超大语料的退化路径：只保留 idf 表，不常驻倒排（与 v3.71 及以前完全一致的实现）
        _buildScan() {
          const docs = this.docs;
          const docCount = docs.length;
          const termDocs = new Map();
          docs.forEach((doc, idx) => {
            const tokens = this._tokenize(this._textOf(doc));
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
        // 与旧版正则写法逐字符等价（仅用 charCode 判定，省掉每字符一次正则）——已用全量语料 +
        // 边界串（空串 / 纯英文数字 / 全角 / 标点 / 表情符号）核对分词结果完全一致。
        _tokenize(str) {
          if (!str) return [];
          const tokens = [];
          const s = str.toLowerCase();
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
            // 退化模式：全量扫描（v3.71 及以前的行为）
            const scores = docs.map(doc => ({ doc, score: this._score(query, doc) }));
            return scores.filter(s => s.score > 0).sort((a, b) => b.score - a.score).slice(0, topN).map(s => s.doc);
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
          if (typeof window.KB === 'object' && window.KB && typeof window.KB.invalidate === 'function') window.KB.invalidate();
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
            title: title || ('风险研判 ' + now.toLocaleString('zh-CN').replace(/\//g, '-')),
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
        var t = new Date(s || '').getTime();
        if (isNaN(t)) return false;
        if (!isNaN(sd) && t < sd) return false;
        if (!isNaN(ed) && t > ed) return false;
        return true;
      }
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
              if (filteredEl) filteredEl.textContent = hasFilter ? ((capped ? '≥' : '') + filtered + ' 条') : totalTxt;
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
                if (d.unit) units[d.unit] = 1;
                if (d.department) units[d.department] = 1;
                var ok = true;
                if (dateStart || dateEnd) {
                  if (!_riskDateInRange(d.datetime, dateStart, dateEnd, sd, ed)) ok = false;
                }
                if (ok && uLower) {
                  if (((d.unit || '') + ' ' + (d.department || '')).toLowerCase().indexOf(uLower) === -1) ok = false;
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
            messages.push({ role: 'user', content: refineText });
            if (refineInput) refineInput.value = '';
          }

          // 思考模式：跟随设置页开关（默认开）。开启时思维链会占用输出预算，
          // 故把 max_tokens 由 6000 抬到 8192，避免「完整报告」在结尾被截断。
          var _riskBody = { model: model, messages: messages, temperature: 0.3, max_tokens: 6000, stream: false };
          var _riskThinking = false;
          if (typeof window.dsThinkingParam === 'function') {
            var _tp = window.dsThinkingParam({ apiUrl: apiUrl, model: model });
            Object.assign(_riskBody, _tp);
            _riskThinking = !!(_tp.thinking && _tp.thinking.type === 'enabled');
            if (_riskThinking) _riskBody.max_tokens = 8192;
          }
          // Y1：增加整体超时，避免长报告假死、不可中断（思考模式耗时更长，放宽到 240s）
          var _riskAbort = new AbortController();
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
            throw new Error(typeof window.dsAiHttpError === 'function'
              ? window.dsAiHttpError(resp.status, _edet)
              : ('请求失败（HTTP ' + resp.status + '）' + (_edet ? '：' + _edet : '')));
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

        // ---------- 读取规章制度库中的事故专业案例（按专业归类） ----------
        try {
          var riskFocus = (document.getElementById('risk-focus') ? document.getElementById('risk-focus').value : '') || '';
          // 【v3.74】优先走统一检索层：按「研判重点」检索规章条款/事故案例（条款级命中 + 出处）。
          //   取代原先"全表 getAll + 正则筛 事故|案例|事件|通报|险情|故障 + 按重点排前 10"——
          //   那次全表扫描是研判耗时的大头，且正则命中无排序、摘要只截前 200 字。
          //   未命中 / 开关 kb_agent 关闭 / KB 未加载 → 原逻辑作为兜底（下面 if (!_kbCaseDone) 段）。
          var _kbCaseDone = false;
          try {
            var _kbOnRisk = (typeof window.KB.getSwitch === 'function') ? window.KB.getSwitch('kb_agent') : true;
            if (window.KB && typeof window.KB.search === 'function' && _kbOnRisk) {
              // 没填研判重点时，用"事故/案例"类词兜底检索（保持旧逻辑的意图）
              var _kbQuery = ((riskFocus || '').trim()) || '事故 案例 事件 通报 险情 故障 险性事件';
              if (typeof window.KB.ensure === 'function') await window.KB.ensure(['rules']);
              var _kbRr = window.KB.search(_kbQuery, { sources: ['rules'], topK: 10 });
              var _kbHitsRisk = (_kbRr && _kbRr.length) ? _kbRr[0].hits : null;
              if (_kbHitsRisk && _kbHitsRisk.length) {
                parts.push('\n【事故专业案例（统一检索层 · 条款级命中，带出处）】命中 ' + _kbHitsRisk.length + ' 条，按专业归类：');
                var _byTradeRisk = {};
                _kbHitsRisk.forEach(function(h2) {
                  var _doc2 = h2.doc || {};
                  var _tr2 = _doc2.trade || '通用';
                  (_byTradeRisk[_tr2] = _byTradeRisk[_tr2] || []).push({ title: _doc2.title || '未命名', path: h2.path || '', text: h2.text || '' });
                });
                Object.keys(_byTradeRisk).forEach(function(tr3) {
                  parts.push('\n▪ 专业：' + tr3);
                  _byTradeRisk[tr3].forEach(function(c3) {
                    var t3 = String(c3.text).replace(/\s+/g, ' ').trim();
                    parts.push('  - 《' + c3.title + '》' + (c3.path ? '（' + c3.path + '）' : '') + (t3 ? '：' + (t3.length > 200 ? t3.slice(0, 200) + '…' : t3) : ''));
                  });
                });
                _kbCaseDone = true;
              }
            }
          } catch (eKbRisk) { _kbCaseDone = false; }

          if (!_kbCaseDone) {
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
          }   // ← if (!_kbCaseDone) 结束：KB 已给出案例时跳过全表扫描
        } catch(e) { parts.push('\n【事故专业案例】读取失败'); console.error('风险研判: 规章库读取异常', e); }

        return parts.join('\n');
      }

      // ---------- 9. 增强 dsSendMsg（角色提示词 + 记忆）----------
      window.ROLE_PROMPTS = ROLE_PROMPTS;
      window.ROLE_OUTPUT_NORMS = ROLE_OUTPUT_NORMS;   // v3.76：专业角色统一输出规范（frontend 不追加）
      window._originalSendMsg = window.dsSendMsg;

      // 角色注入和长期记忆已内置到 dsSendMsg 中，此处保留暴露 ROLE_PROMPTS
      window.dsSendMsg._roleInjectionEnabled = true;

      // ---------- 10. 反馈收集 ----------
      // msgIdx: 该气泡在 dsHistory 中的下标，用于「重生成」定位到具体这一轮
      function addFeedbackButtons(messageDiv, assistantContent, msgIdx) {
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
          var name = '智能对话_' + (firstLine ? firstLine + '_' : '') + new Date().toISOString().slice(0, 10);
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
