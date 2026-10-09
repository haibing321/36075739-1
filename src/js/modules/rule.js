        // ========== Rule System (完整保留) ==========
        (function() {
            if (typeof pdfjsLib !== 'undefined') {
                pdfjsLib.GlobalWorkerOptions.workerSrc = 'src/js/vendor/pdf.worker.min.js';
            }

            let rules = [];
            const MAX_STORAGE_SIZE = 500 * 1024 * 1024; // 500MB
            const sampleRules = [
                { trade: '车务', title: '接发列车作业标准', content: '接发列车时，必须办理行车凭证。\n列车进站应确认信号开放。\n接发列车人员应严格执行眼看、手指、口述制度。' },
                { trade: '车务', title: '调车作业细则', content: '调车作业前必须排风摘管，核对计划。\n驼峰调车严格控制推送速度。\n铁鞋制动时，严禁使用不符合标准的铁鞋。' },
                { trade: '机务', title: '机车牵引操作规', content: '机车起动前确认制动缸压力，鸣笛动车。\n牵引运行中注意接触网电压，通过分相区断电降弓。' },
                { trade: '工务', title: '线路维修安全规则', content: '天窗点内方可上道作业。\n作业前后清点工机具。\n无缝线路作业必须测量轨温，防止胀轨跑道。' },
                { trade: '电务', title: '信号设备检修规程', content: '信号机显示距离应符合标准。\n轨道电路电压调整在规定范围。\n电缆绝缘测试每月一次。' },
                { trade: '供电', title: '接触网安全工作规程', content: 'V停作业必须穿戴绝缘靴手套。\n地线接设位置正确，验电接地。\n作业车平台升降严禁侵入邻线。' }
            ];
            // 使用window挂载keywordCount，避免IIFE闭包作用域问题
            if (typeof window.ruleKeywordCount === 'undefined') {
                window.ruleKeywordCount = 0;
            }
            const MAX_KEYWORDS = 4;
            let pendingFiles = [], isProcessing = false, currentEditIndex = null;
            let _procStartAt = 0;   // 【2026-09-21】导入锁的起始时间：用于自动解除"卡死"的锁（见下方守卫）
            const ruleSearchMode = 'paragraph'; // 固定段落模式
            let rulePage = 1, rulePageSize = 10, ruleTotalPages = 1, ruleAllResults = [];

            // IndexedDB 封装
            const DB_NAME = 'RailwayRuleDB', STORE_NAME = 'ruleCollection', IMAGE_STORE_NAME = 'rule_images', DB_VERSION = 3;
            let db = null;
            function initRuleDB() {
                // 首次注册 schema 到 dbManager（仅注册一次）
                if (!window._ruleDBRegistered) {
                    window.dbManager.register('RailwayRuleDB', DB_VERSION, function(database, e) {
                        // 无论什么版本升级，确保两个 store 都存在即可
                        if (!database.objectStoreNames.contains(STORE_NAME)) {
                            const store = database.createObjectStore(STORE_NAME, { keyPath: 'id' });
                            store.put({ id: 1, data: [] });
                        }
                        if (!database.objectStoreNames.contains(IMAGE_STORE_NAME)) {
                            database.createObjectStore(IMAGE_STORE_NAME, { keyPath: 'id' });
                        }
                    });
                    window._ruleDBRegistered = true;
                }
                return window.dbManager.getDB('RailwayRuleDB').then(function(database) {
                    db = database;
                    return db;
                });
            }

            // 图片存储辅助函数
            async function saveImageToDB(id, blob) {
                const database = await initRuleDB();
                return new Promise((resolve, reject) => {
                    const tx = database.transaction([IMAGE_STORE_NAME], 'readwrite');
                    const store = tx.objectStore(IMAGE_STORE_NAME);
                    const request = store.put({ id, blob });
                    request.onsuccess = () => resolve(id);
                    request.onerror = () => reject(request.error);
                });
            }

            async function getImageFromDB(id) {
                const database = await initRuleDB();
                return new Promise((resolve, reject) => {
                    const tx = database.transaction([IMAGE_STORE_NAME], 'readonly');
                    const store = tx.objectStore(IMAGE_STORE_NAME);
                    const request = store.get(id);
                    request.onsuccess = () => resolve(request.result?.blob);
                    request.onerror = () => reject(request.error);
                });
            }

            async function deleteImagesFromDB(ids) {
                if (!ids || ids.length === 0) return;
                const database = await initRuleDB();
                return new Promise((resolve, reject) => {
                    const tx = database.transaction([IMAGE_STORE_NAME], 'readwrite');
                    const store = tx.objectStore(IMAGE_STORE_NAME);
                    let count = 0;
                    ids.forEach(id => {
                        const request = store.delete(id);
                        request.onsuccess = () => {
                            count++;
                            if (count === ids.length) resolve();
                        };
                        request.onerror = () => reject(request.error);
                    });
                });
            }

            // ========== 规章正文安全净化（v3.70）==========
            // 背景：rule.js 一直把库里的 contentHtml 直接 innerHTML 渲染，而写入库里的那条链路上
            //   唯一的"清洗"是 cleanHtml —— 它只规整空白与排版（空段落/连续 br/表格内空格），
            //   **不做任何安全净化**：不删 script、不剥 on* 属性、没有标签白名单。
            //   风险来源也不止"历史遗留数据"：JSON / ZIP 备份导入会把外部 HTML 原样落库
            //   （别人给的备份文件 = 不可信输入），粘贴编辑同理。
            // 两道独立防线：
            //   ① 落库前净化（_ruleSanitizeForStore）：只在内容出现可疑特征时才动用 DOMPurify，
            //      正常 docx 转换产物（可能上千条正文）不付这份开销；净化失败时【原样保留】，
            //      绝不转义写入 —— 否则会把 HTML 永久写成文本，属数据损坏。
            //   ② 渲染前净化（renderRuleHtml 内调用）：失败时转义为纯文本（安全方向）。
            //   两条都失败也不会渲染出可执行内容。
            // 白名单必须包含 docx 常见的排版属性（colspan/rowspan/width/align…），
            //   否则表格会散架（这些属性在 safeHtml 的默认白名单里是没有的）。
            var RULE_CONTENT_TAGS = ['b','i','em','strong','u','s','sub','sup','p','br','span','div',
                'h1','h2','h3','h4','h5','h6','ul','ol','li','blockquote','pre','code',
                'table','thead','tbody','tfoot','tr','th','td','caption','colgroup','col',
                'img','a','hr','mark'];
            var RULE_CONTENT_ATTRS = ['href','src','alt','title','class','id','style','target','rel',
                'data-img-id','colspan','rowspan','width','height','align','valign','border',
                'cellpadding','cellspacing','bgcolor','scope','headers','start','type'];
            // 可疑特征探测：命中才走 DOMPurify（落库路径的快路径）
            var RULE_RISKY_RE = /<\s*(script|iframe|object|embed|link|meta|base|form|svg|math|style)\b|on[a-z]+\s*=|javascript\s*:|vbscript\s*:|data\s*:\s*text\/html/i;

            function _rulePurify(html, forStore) {
                if (!html) return html || '';
                var s = String(html);
                if (forStore && !RULE_RISKY_RE.test(s)) return s; // 正常正文：零开销直通
                if (typeof DOMPurify === 'undefined' || !DOMPurify.sanitize) {
                    if (forStore) return s; // 落库：原样保留，交由渲染期防线兜底
                    try { return window.escapeHtml ? window.escapeHtml(s) : ''; } catch (e) { return ''; }
                }
                try {
                    return DOMPurify.sanitize(s, {
                        ALLOWED_TAGS: RULE_CONTENT_TAGS,
                        ALLOWED_ATTR: RULE_CONTENT_ATTRS,
                        FORCE_BODY: false
                    });
                } catch (e) {
                    console.warn('[rule] 正文净化失败:', e && e.message);
                    if (forStore) return s;
                    try { return window.escapeHtml ? window.escapeHtml(s) : ''; } catch (e2) { return ''; }
                }
            }
            // 落库前净化（导入路径用）
            function _ruleSanitizeForStore(html) { return _rulePurify(html, true); }

            // 渲染规章 HTML（兼容旧格式__IMG_ID__占位符 + 新格式 data-img-id 属性）
            function renderRuleHtml(html) {
                if (!html) return html;
                // 兼容旧格式：把 src="__IMG_ID__xxx__" 形式的 img 标签转为 data-img-id 属性
                html = html.replace(/<img([^>]*?)src="__IMG_ID__([a-zA-Z0-9_-]+)__"([^>]*?)>/gi, (match, pre, id, post) => {
                    return `<img${pre}${post} class="rule-lazy-img" data-img-id="${id}" src="">`;
                });
                // 兼容旧文本占位符（__IMG_ID__xxx__ 出现在文本节点里而非属性里）
                html = html.replace(/__IMG_ID__([a-zA-Z0-9_-]+)__/g, (match, id) => {
                    return `<img class="rule-lazy-img" data-img-id="${id}" src="">`;
                });
                // ★ 安全净化放在最后：保证真正进入 innerHTML 的这串 HTML 一定过了一趟白名单。
                //   本函数是全部 4 个渲染点（全文查看 / 编辑预览 / 两处高亮预览）的唯一漏斗，
                //   单条规章、仅用户点开时执行 —— 不进列表渲染（687 条）也不进启动路径。
                return _rulePurify(html, false);
            }


            // 真正的懒加载：IntersectionObserver 按需加载图片（解决含大量图片时手机端卡顿）
            async function loadImageFromDB(img) {
                if (img._loaded) return;
                img._loaded = true;
                const imgId = img.getAttribute('data-img-id');
                if (!imgId) return;
                try {
                    const blob = await getImageFromDB(imgId);
                    if (blob) {
                        img.src = URL.createObjectURL(blob);
                        img.classList.remove('rule-lazy-img');
                        img.style.opacity = '1';
                    } else {
                        img.alt = '[图片未找到]';
                        img.style.display = 'none';
                    }
                } catch (e) {
                    img.alt = '[图片加载失败]';
                    img.style.display = 'none';
                }
            }

            function setupLazyImageObserver(container) {
                if (!('IntersectionObserver' in window)) {
                    // 降级：直接加载全部图片
                    container.querySelectorAll('img[data-img-id]').forEach(img => loadImageFromDB(img));
                    return;
                }
                const observer = new IntersectionObserver((entries) => {
                    entries.forEach(entry => {
                        if (entry.isIntersecting) {
                            loadImageFromDB(entry.target);
                            observer.unobserve(entry.target);
                        }
                    });
                }, {
                    root: container,
                    rootMargin: '200px', // 提前 200px 开始加载，滚动时无缝衔接
                    threshold: 0.01
                });
                container.querySelectorAll('img[data-img-id]').forEach(img => observer.observe(img));
            }

            // v3.30：折叠/刷新整页还原后，规章图片懒加载 observer 不会随 DOM 重建——
            //   ① 已加载的图片 src 是 blob: URL（仅当前文档会话有效），还原后失效空白；
            //   ② 未加载的 img[data-img-id]（src 为空）因 observer 丢失而永不触发加载。
            //   还原后重建：把失效 blob URL 的 img 重置回懒加载占位态，再重新挂 observer，
            //   由 IntersectionObserver 从 IndexedDB 重新读取图片。用于查看全文正文与搜索结果列表。
            window.ruleFvRebuildImages = function(container) {
                if (!container) return;
                container.querySelectorAll('img[data-img-id][src^="blob:"]').forEach(function(img) {
                    img._loaded = false;
                    img.removeAttribute('src');
                    img.classList.add('rule-lazy-img');
                    img.style.opacity = '';
                });
                try { setupLazyImageObserver(container); } catch (e) {}
            };
            // 还原完成后（page-state 派发，与草稿回填同帧）：查看全文弹窗若打开、搜索结果若可见，
            // 重建其中的规章图片懒加载，避免「只保留空表/图片全空白」。
            window.addEventListener('pageSnapshotRestored', function() {
                try {
                    var fv = document.getElementById('rule-fullViewModal');
                    if (fv && fv.classList.contains('active')) {
                        var body = document.getElementById('rule-fullContentBody');
                        if (body) window.ruleFvRebuildImages(body);
                    }
                    var rl = document.getElementById('rule-resultsList');
                    if (rl && getComputedStyle(rl).display !== 'none') {
                        window.ruleFvRebuildImages(rl);
                    }
                } catch (e) {}
            });

            // v3.30：还原「全文查看会话」兜底 —— 折叠/刷新后若弹窗 active 但正文为空
            //   （modalHTML 快照超限等极端情况），从 IndexedDB 重新渲染规章正文。
            //   由 page-state 在还原后调用 restoreEdit_<module> 钩子（rAF×3，晚于 modalHTML 回填）。
            window.restoreEdit_rule = function(ctx) {
                if (!ctx || ctx.type !== 'fullview') return;
                // 折叠前弹窗必须处于打开态（还原后 active 已恢复）
                var m = document.getElementById('rule-fullViewModal');
                if (!m || !m.classList.contains('active')) return;
                // 正文已有内容（modalHTML 快照成功）→ 无需重建
                var body = document.getElementById('rule-fullContentBody');
                if (body && body.innerHTML.trim().length > 50) return;
                try {
                    if (typeof ctx.paraIdx !== 'undefined' && typeof window.ruleViewFullTextAndScroll === 'function') {
                        window.ruleViewFullTextAndScroll(ctx.idx, ctx.paraIdx);
                    } else if (typeof window.ruleViewFullText === 'function') {
                        window.ruleViewFullText(ctx.idx);
                    }
                } catch (e) { console.warn('[rule] 全文查看会话还原失败', e); }
            };

            // 通用文件下载函数，兼容所有浏览器（含华为/Edge/Safari/微信/iOS等）
            // 统一走全局移动端兼容下载（utils.js: window.downloadBlob），避免多套实现
            function downloadBlob(blob, filename) {
                if (filename.endsWith('.zip') && (!blob.type || blob.type === '' || blob.type === 'application/octet-stream')) {
                    blob = new Blob([blob], { type: 'application/zip' });
                }
                window.downloadBlob(blob, filename);
            }
            
            // 从 HTML 提取纯文本，保留段落换行
            function stripHtml(html) {
                if (!html) return '';
                // 先将段落、div、标题等块级元素替换为带换行的版本
                let processed = html
                    .replace(/<\/p>/gi, '\n')
                    .replace(/<\/div>/gi, '\n')
                    .replace(/<br\s*\/?>/gi, '\n')
                    .replace(/<\/h[1-6]>/gi, '\n')
                    .replace(/<\/li>/gi, '\n');
                const tmp = document.createElement('div');
                tmp.innerHTML = processed;
                let text = tmp.textContent || tmp.innerText || '';
                // 压缩连续换行，最多保留2个
                text = text.replace(/\n{3,}/g, '\n\n');
                return text.trim();
            }
            
            // 清洗HTML：移除空段落、多余换行和空格
            function cleanHtml(html) {
                if (!html) return '';
                let cleaned = html.trim();
                
                // 1. 移除空段落：<p></p> 或 <p> </p> 或 <p>&nbsp;</p>
                cleaned = cleaned.replace(/<p[^>]*>\s*(?:&nbsp;|\s)*\s*<\/p>/gi, '');
                
                // 2. 移除连续两个以上的空段落
                cleaned = cleaned.replace(/(<p[^>]*>\s*<\/p>\s*){2,}/gi, '');
                
                // 3. 限制连续换行符（<br>）最多保留2个
                cleaned = cleaned.replace(/(<br\s*\/?>\s*){3,}/gi, '<br><br>');
                
                // 4. 压缩段落内连续空格为单个空格（保留有意义的空格）
                cleaned = cleaned.replace(/([^<>\s])\s{2,}/g, '$1 ');
                
                // 5. 移除标签之间的多余空白，但保留段落之间的换行（用于可读性）
                // 先保护 </p> 和 <p> 之间的空白
                cleaned = cleaned.replace(/<\/p>\s*<p/gi, '</p>\n<p');
                // 再处理其他标签之间的空白
                cleaned = cleaned.replace(/>(\s+)</g, (match, spaces) => {
                    // 如果包含换行，保留一个换行用于可读性
                    if (spaces.includes('\n')) return '>\n<';
                    return '><';
                });
                
                // 6. 压缩表格单元格内的空格
                cleaned = cleaned.replace(/<td([^>]*)>([\s\S]*?)<\/td>/gi, (match, attrs, content) => {
                    const trimmed = content.replace(/\s+/g, ' ').trim();
                    return `<td${attrs}>${trimmed}</td>`;
                });
                
                // 7. 最终trim
                return cleaned.trim();
            }
            
            // 规范化搜索文本：压缩所有空白为单个空格（用于搜索框输入）
            function normalizeSearchText(text) {
                if (!text) return '';
                return text
                    .replace(/\s+/g, ' ')          // 所有空白压缩为单个空格
                    .replace(/[^\w\u4e00-\u9fa5]/g, ' ') // 保留中文和字母数字
                    .trim();
            }

            // 规范化文本用于搜索匹配：压缩空白、去除标点、统一为小写
            function normalizeText(text) {
                if (!text) return '';
                return text
                    .replace(/\s+/g, ' ')                          // 压缩空白
                    .replace(/[^\w\u4e00-\u9fa5\u3400-\u4dbf]/g, '') // 移除非文字字符（保留中文、字母、数字、下划线）
                    .toLowerCase()
                    .trim();
            }
            async function loadRulesFromDB() {
                try {
                    await initRuleDB();
                    return new Promise((resolve, reject) => {
                        const transaction = db.transaction([STORE_NAME], 'readonly');
                        const store = transaction.objectStore(STORE_NAME);
                        const request = store.get(1);
                        request.onsuccess = () => {
                            const result = request.result;
                            // ⚠️ 必须区分「用户主动清空」与「首次使用」：
                            //   · 建库时的 schema 回调会预写一条 {id:1, data:[]}，
                            //     所以"有记录"并不等于"用户已初始化"，不能用 Array.isArray 判定；
                            //   · 用户清空/导入/编辑都会经 saveRulesToDB 写入 initialized:true。
                            // 因此：data 非空 或 带 initialized 标记 → 如实使用（清空后就该是空列表）；
                            // 否则（首次使用）才注入示例规章 —— 少了这个判定，用户清空后一刷新示例就会自己回来。
                            if (result && Array.isArray(result.data) && (result.data.length > 0 || result.initialized === true)) {
                                rules = result.data;
                                console.log('[loadRulesFromDB] 加载成功，共 ' + rules.length + ' 条规章');
                            } else {
                                rules = sampleRules.map(r => ({ ...r }));
                                console.log('[loadRulesFromDB] 首次使用（未初始化标记），注入 ' + rules.length + ' 条示例规章');
                            }
                            resolve(rules);
                        };
                        request.onerror = () => reject(request.error);
                    });
                } catch (e) {
                    console.warn('[loadRulesFromDB] IndexedDB加载失败，使用示例数据', e);
                    rules = sampleRules.map(r => ({ ...r }));
                    return rules;
                }
            }
            async function saveRulesToDB(rulesArray) {
                // 若 db 连接已失效（如 versionchange），重置后重新初始化
                if (db) {
                    try { db.transaction([STORE_NAME], 'readonly').abort(); }
                    catch(e) { db = null; }
                }
                await initRuleDB();
                return new Promise((resolve, reject) => {
                    let transaction;
                    try {
                        transaction = db.transaction([STORE_NAME], 'readwrite');
                    } catch(e) {
                        // 事务创建失败：重置连接，下次重试
                        db = null;
                        return reject(e);
                    }
                    transaction.onerror = () => reject(transaction.error);
                    transaction.onabort = () => reject(new Error('IndexedDB 事务中断'));
                    const store = transaction.objectStore(STORE_NAME);
                    // initialized:true 是「用户已初始化」标记：用于区分"用户主动清空(data:[])"与"首次使用"。
                    // 所有写入路径（导入/编辑/删除/清空）都经由此函数，故一处打标即可覆盖全部。
                    const request = store.put({ id: 1, data: rulesArray, initialized: true });
                    request.onsuccess = () => resolve();
                    request.onerror = () => reject(request.error);
                });
            }
            async function saveToStorage(opts) {
                try {
                    await saveRulesToDB(rules);
                    // v3.72：规章数据已变更 → 丢弃智能检索（BM25）索引，导完资料即可被「一键对规/
                    // 智能写作」检索到，无需刷新页面。所有写入路径（导入/编辑/删除/清空）都收口于此。
                    if (typeof window.dsInvalidateRagCache === 'function') window.dsInvalidateRagCache('rules');
                    updateStorageInfo();
                    return true;
                } catch (e) {
                    // opts.silent：由调用方负责提示时（例如导入流程要给出可操作的回滚说明），
                    // 避免连续弹两个 alert。
                    if (!(opts && opts.silent)) alert('保存失败：' + e.message);
                    console.warn('[rule] 保存失败:', e && e.message);
                    return false;
                }
            }
            // 储存/数量展示已移除（统一在设置面板显示「总储存量」）
            function updateStorageInfo() {
                // 原逻辑渲染 rule-storageBar / rule-storageText，已移至设置面板
            }
            function updateTotalBadge() {
                // rule-totalBadge（模块数据条数）展示已移除
                const count = document.getElementById('rule-resultCount');
                if (count) count.textContent = rules.length + ' 项';
            }

            function refreshTradeSelect() {
                const select = document.getElementById('rule-tradeSelect');
                if (!select) return;
                const currentValue = select.value;
                const tradesSet = new Set(); rules.forEach(rule => tradesSet.add(rule.trade));
                const sortedTrades = Array.from(tradesSet).sort((a, b) => a.localeCompare(b, 'zh'));
                select.innerHTML = '<option value="">全部专业</option>';
                sortedTrades.forEach(trade => { const option = document.createElement('option'); option.value = trade; option.textContent = trade; select.appendChild(option); });
                if (currentValue && sortedTrades.includes(currentValue)) select.value = currentValue; else select.value = '';

                const importSelect = document.getElementById('rule-importTrade');
                if (importSelect) {
                    importSelect.innerHTML = '<option value="">-- 选择专业 --</option>';
                    sortedTrades.forEach(trade => { const option = document.createElement('option'); option.value = trade; option.textContent = trade; importSelect.appendChild(option); });
                }
                const exportSelect = document.getElementById('rule-exportTrade');
                if (exportSelect) {
                    exportSelect.innerHTML = '<option value="">所有专业 (全部导出)</option>';
                    sortedTrades.forEach(trade => { const option = document.createElement('option'); option.value = trade; option.textContent = trade; exportSelect.appendChild(option); });
                }
                const editSelect = document.getElementById('rule-editTrade');
                if (editSelect) {
                    editSelect.innerHTML = '<option value="">-- 选择专业 --</option>';
                    sortedTrades.forEach(trade => { const option = document.createElement('option'); option.value = trade; option.textContent = trade; editSelect.appendChild(option); });
                }
                const catalogFilter = document.getElementById('rule-catalogTradeFilter');
                if (catalogFilter) {
                    const catalogValue = catalogFilter.value;
                    catalogFilter.innerHTML = '<option value="">全部专业</option>';
                    sortedTrades.forEach(trade => { const option = document.createElement('option'); option.value = trade; option.textContent = trade; catalogFilter.appendChild(option); });
                    if (catalogValue && sortedTrades.includes(catalogValue)) catalogFilter.value = catalogValue;
                }
            }

            // escapeHtml 已统一到 utils.js (window.escapeHtml)，此处不再重复定义
            function escapeRegExp(string) { return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
            function highlightKeywords(text, keywords) {
                if (!keywords || keywords.length === 0) return escapeHtml(text);
                let result = escapeHtml(text);
                keywords.forEach(kw => {
                    if (!kw.trim()) return;
                    const regex = new RegExp('(' + escapeRegExp(kw) + ')', 'gi');
                    result = result.replace(regex, '<span class="rule-highlight">$1</span>');
                });
                return result;
            }

            // 智能段落切分：先按换行分割，再对超长行按句号等标点二次分割
            function smartSplitParagraphs(text) {
                if (!text) return [];
                let rawParagraphs = text.split(/\r?\n/).filter(p => p.trim() !== '');
                const paragraphs = [];
                // 条目编号模式匹配（用于在长段落中识别独立条目）
                const itemPatterns = [
                    /^(?:附表\s*\d+|附件\s*\d+)/,
                    /^第[一二三四五六七八九十百千\d]+[章节条款款项]/,
                    /^(?:^|\s)\d+[\.、]/,
                    /^[（(]\d+[)）]/
                ];
                const MAX_PARA_LEN = 300; // 每段最大字符数
                rawParagraphs.forEach(para => {
                    if (para.length <= MAX_PARA_LEN) {
                        paragraphs.push(para);
                        return;
                    }
                    // 对长段落按句号等标点分割成句子
                    const sentences = para.split(/(?<=[。；！？])/).filter(s => s.trim() !== '');
                    let currentPart = '';
                    sentences.forEach(sentence => {
                        const trimmed = sentence.trim();
                        if (!trimmed) return;
                        // 如果当前句子以条目编号开头，且当前已有内容，先断开
                        if (currentPart && itemPatterns.some(p => p.test(trimmed))) {
                            paragraphs.push(currentPart.trim());
                            currentPart = trimmed;
                        } else if (currentPart.length + trimmed.length > MAX_PARA_LEN) {
                            // 超过最大长度，断开
                            if (currentPart) paragraphs.push(currentPart.trim());
                            currentPart = trimmed;
                        } else {
                            // 合并到当前段落
                            currentPart += trimmed;
                        }
                    });
                    if (currentPart.trim()) paragraphs.push(currentPart.trim());
                });
                return paragraphs.length > 0 ? paragraphs : rawParagraphs;
            }

            /**
             * 归一化文本，同时记录「归一化下标 → 原始下标」映射。
             * normalizeText() 会把标点等非文字字符整段删除，归一化串显著短于原始串；
             * 若在归一化串上算位置、却拿该位置去 substring 原始串，截取位置会系统性左移，
             * 切出来的片段里根本没有关键词。保留映射即可把位置换算回原始串。
             */
            function normalizeTextWithMap(text) {
                var out = '', map = [];
                if (!text) return { text: out, map: map };
                var src = String(text);
                var wordRe = /[\w\u4e00-\u9fa5\u3400-\u4dbf]/;
                var pendingSpace = -1;
                for (var i = 0; i < src.length; i++) {
                    var ch = src.charAt(i);
                    if (/\s/.test(ch)) {
                        if (pendingSpace < 0) pendingSpace = i; // 连续空白折叠为一个空格
                        continue;
                    }
                    if (!wordRe.test(ch)) continue;             // 标点等非文字字符：丢弃
                    if (pendingSpace >= 0 && out.length > 0) {
                        out += ' ';
                        map.push(pendingSpace);
                    }
                    pendingSpace = -1;
                    out += ch.toLowerCase();
                    map.push(i);
                }
                // 与 normalizeText() 的 trim 对齐
                while (out.length && out.charAt(out.length - 1) === ' ') { out = out.slice(0, -1); map.pop(); }
                while (out.length && out.charAt(0) === ' ') { out = out.slice(1); map.shift(); }
                return { text: out, map: map };
            }

            function splitLongParagraphWithAllKeywords(paragraph, keywords, matchMode = 'and', maxLen = 380) {
                // 使用规范化后的文本进行匹配（并保留下标映射，便于换算回原始文本）
                const normPara = normalizeTextWithMap(paragraph);
                const normalizedPara = normPara.text;
                const normMap = normPara.map;
                // 关键词必须用同一套归一化规则，否则两边 token 对不上。
                // 必须过滤空串：indexOf('', n) 在 n 超过长度时仍返回 length（永不返回 -1），
                // 任意一个空关键词都会让下面的 while 变成死循环，直接卡死搜索。
                const normalizedKws = keywords
                    .map(kw => normalizeTextWithMap(kw).text)
                    .filter(t => t.length > 0);
                
                // 定义所有标点符号（用于边界扩展）
                const punctuations = ['\u3002', '\uff01', '\uff1f', '.', '!', '?', '\uff0c', ',', '\uff1b', ';', '\u3001', '\uff1a', ':', '\uff08', '(', '\uff09', ')', '\u201c', '\u201d', '\u2018', '\u2019', '"', "'", '\u300a', '\u300b', '\u3008', '\u3009', '[', ']', '\u3010', '\u3011'];
                
                // 收集每个关键词的所有位置（基于规范化文本）
                const kwAllPositions = [];
                normalizedKws.forEach((kw, kwIdx) => {
                    let pos = -1;
                    while ((pos = normalizedPara.indexOf(kw, pos + 1)) !== -1) {
                        kwAllPositions.push({ kwIdx, start: pos, end: pos + kw.length });
                    }
                });
                
                if (kwAllPositions.length === 0) return [];
                
                // 按起始位置排序
                kwAllPositions.sort((a, b) => a.start - b.start);
                
                let allWindows = [];
                
                // AND模式：找到包含所有关键词的窗口
                const kwCount = normalizedKws.length;

                for (let i = 0; i < kwAllPositions.length; i++) {
                    const windowKws = new Set();
                    let windowStart = kwAllPositions[i].start;
                    let windowEnd = kwAllPositions[i].end;

                    for (let j = i; j < kwAllPositions.length; j++) {
                        windowKws.add(kwAllPositions[j].kwIdx);
                        windowEnd = Math.max(windowEnd, kwAllPositions[j].end);

                        if (windowKws.size === kwCount) {
                            // 找到包含所有关键词的窗口
                            allWindows.push({ start: windowStart, end: windowEnd, matchedKwCount: kwCount });
                            break;
                        }
                    }
                }
                
                if (allWindows.length === 0) return [];
                
                // 按起始位置排序
                allWindows.sort((a, b) => a.start - b.start);
                
                // 合并重叠的窗口
                const mergedWindows = [];
                let currentWindow = { ...allWindows[0] };
                
                for (let i = 1; i < allWindows.length; i++) {
                    const nextWindow = allWindows[i];
                    // 合并重叠或距离很近的窗口（小于50字符）
                    if (nextWindow.start <= currentWindow.end + 50) {
                        currentWindow.end = Math.max(currentWindow.end, nextWindow.end);
                        currentWindow.matchedKwCount = Math.max(currentWindow.matchedKwCount, nextWindow.matchedKwCount);
                    } else {
                        mergedWindows.push(currentWindow);
                        currentWindow = { ...nextWindow };
                    }
                }
                mergedWindows.push(currentWindow);
                
                // 按匹配关键词数量降序排序，优先显示匹配更多的片段
                mergedWindows.sort((a, b) => b.matchedKwCount - a.matchedKwCount);
                
                // 限制最多返回3个片段，避免结果过长
                const limitedWindows = mergedWindows.slice(0, 3);
                
                // 处理每个窗口，扩展到标点符号边界
                // 归一化下标 → 原始下标（end 为开区间，取最后一个字符的下标再 +1）
                const toOrigStart = function(nStart) {
                    return normMap[nStart] !== undefined ? normMap[nStart] : 0;
                };
                const toOrigEnd = function(nEnd) {
                    var lastIdx = normMap[nEnd - 1];
                    return lastIdx !== undefined ? lastIdx + 1 : paragraph.length;
                };

                const fragments = [];
                limitedWindows.forEach((window, idx) => {
                    // 换算回原始文本下标后再做标点边界扩展与截取
                    const origStart = toOrigStart(window.start);
                    const origEnd = toOrigEnd(window.end);
                    // 向前扩展到标点符号后
                    let snippetStart = origStart;
                    const beforeText = paragraph.substring(0, origStart);
                    let lastPuncPos = -1;
                    for (const punc of punctuations) {
                        const pos = beforeText.lastIndexOf(punc);
                        if (pos > lastPuncPos) lastPuncPos = pos;
                    }
                    if (lastPuncPos >= 0) {
                        snippetStart = lastPuncPos + 1;
                    }
                    
                    // 向后扩展到标点符号前
                    let snippetEnd = origEnd;
                    const afterText = paragraph.substring(origEnd);
                    let nextPuncPos = Infinity;
                    for (const punc of punctuations) {
                        const pos = afterText.indexOf(punc);
                        if (pos >= 0 && pos < nextPuncPos) nextPuncPos = pos;
                    }
                    if (nextPuncPos !== Infinity) {
                        snippetEnd = origEnd + nextPuncPos;
                    }
                    
                    // 截取片段
                    let snippet = paragraph.substring(snippetStart, snippetEnd).trim();
                    
                    // 添加省略号
                    if (snippetStart > 0) snippet = '\u2026' + snippet;
                    if (snippetEnd < paragraph.length) snippet = snippet + '\u2026';
                    
                    fragments.push({ text: snippet, start: snippetStart, end: snippetEnd, matchedKwCount: window.matchedKwCount });
                });
                
                return fragments;
            }

            function collectPrevParagraphs(paragraphs, startIdx, targetLen = 150, maxCount = 6) {
                let collected = []; let totalLen = 0; let count = 0;
                for (let i = startIdx - 1; i >= 0 && count < maxCount; i--) {
                    const para = paragraphs[i];
                    if (!para.trim()) continue;
                    collected.unshift(para);
                    totalLen += para.length;
                    count++;
                    if (totalLen >= targetLen) break;
                }
                return collected;
            }

            function processParagraph(paragraph, index, allParagraphs, keywords, ruleIdx, matchMode = 'and', absIdx = -1, ctx = null) {
                const len = paragraph.length;
                const SHORT_THRESHOLD = 50, LONG_THRESHOLD = 400, PREV_TARGET = 150, NEXT_TARGET = 190, MAX_PREV_PARAS = 6;
                
                // 匹配模式标记固定为AND
                const modeAttr = 'data-match-mode="and"';
                
                // 【2026-10-01 用户报「截取段落重复」】两条去重判据（只影响显示，不改命中/排序）：
                //   · covered(s,e)：区间是否已输出过（≥80% 覆盖算重复）—— 治"大段落多窗口扩展后互相重叠"
                //     与"小段延伸与相邻命中段重叠"（两者都用原始正文区间，故能跨机制判重）；
                //   · shownTexts：按**段落文本**判重 —— 上下文段落来自 collectPrevParagraphs（只有文本、
                //     没有下标），治"上一段的『下一段』正好是本段"这类重复。
                const covered = (s, e) => {
                    if (!ctx || !ctx.shownRanges.length || typeof s !== 'number' || typeof e !== 'number' || e <= s) return false;
                    let hit = 0;
                    ctx.shownRanges.forEach(r => { const a = Math.max(s, r[0]), b = Math.min(e, r[1]); if (b > a) hit += (b - a); });
                    return hit / (e - s) >= 0.8;
                };
                const markRange = (s, e) => { if (ctx && typeof s === 'number' && typeof e === 'number' && e > s) ctx.shownRanges.push([s, e]); };
                // 【2026-10-01】部分重叠的**裁剪**：只跳过"≥80% 已输出"的片段还不够 —— 实测（案例2）两个窗口
                //   向标点扩展后常是**部分重叠**（重叠比例不到 80%），于是同一段中段文字仍出现两遍。
                //   这里把"已被输出过"的前缀裁掉：返回新的起点（若整段都在里面，调用方会跳过）。
                const trimStart = (s, e) => {
                    if (!ctx || typeof s !== 'number' || typeof e !== 'number') return s;
                    let ns = s;
                    ctx.shownRanges.forEach(r => { if (r[0] <= ns && r[1] > ns) ns = Math.min(r[1], e); });
                    return ns;
                };
                // 【2026-10-01】关键词位置账本的两把尺子（见 generateRuleSnippet 顶部的"去重总原则"）：
                //   kwUnshown(s,e) = 该区间内**还没露过面**的关键词出现个数；
                //   markKw(s,e)    = 把该区间内的关键词位置登记为"已露面"（已输出的文本里它们会被 highlightKeywords 高亮）。
                const kwUnshown = (s, e) => {
                    if (!ctx || typeof s !== 'number' || typeof e !== 'number' || e <= s) return 0;
                    let n = 0;
                    ctx.kwPositions.forEach(p => { if (p >= s && p < e && !ctx.kwShown.has(p)) n++; });
                    return n;
                };
                const markKw = (s, e) => {
                    if (!ctx || typeof s !== 'number' || typeof e !== 'number') return;
                    ctx.kwPositions.forEach(p => { if (p >= s && p < e) ctx.kwShown.add(p); });
                };
                const spanOf = i => (ctx && ctx.paraSpans && ctx.paraSpans[i]) ? ctx.paraSpans[i] : null;
                const txtShown = t => !!(ctx && ctx.shownTexts.has(t));
                const markTxt = t => { if (ctx) ctx.shownTexts.add(t); };
                
                if (len > LONG_THRESHOLD) {
                    const fragments = splitLongParagraphWithAllKeywords(paragraph, keywords, matchMode);
                    let html = '';
                    // 【2026-10-01】先按起点排序再判重：窗口向标点扩展后，先后顺序可能被打乱，
                    //   而"裁掉已输出前缀"依赖"先输出的那个在前"，所以排序是必须的（边界本身不变）。
                    const ordered = fragments.slice().sort((a, b) => (a.start - b.start));
                    ordered.forEach(f => {
                        // 【2026-10-01】窗口先合并、再各自向标点扩展 ⇒ 扩展后可能互相重叠：
                        //   ① 整段基本已输出（≥80%）⇒ 跳过；② 只是**部分**重叠 ⇒ 裁掉已被输出的前缀再输出。
                        //   裁前缀时用**区间重建文本**，不能按 f.text 做偏移（它带首尾省略号，长度对不上）。
                        const fs0 = (typeof f.start === 'number') ? f.start : -1;
                        const fe0 = (typeof f.end === 'number') ? f.end : -1;
                        // 整段覆盖：里面的关键词位置要么已经随前一块高亮过，要么本来就不在正文可输出范围内 ⇒ 只记账
                        if (covered(fs0, fe0)) { markKw(fs0, fe0); return; }
                        let fs = trimStart(fs0, fe0);
                        if (fe0 > 0 && fs >= fe0) { markKw(fs0, fe0); return; }
                        // 裁完后若"没露过面"的关键词位置一个都不剩 ⇒ 纯尾巴（无新信息、也没高亮）⇒ 不再开块。
                        //   注意：前一块的正文里这些关键词会被 highlightKeywords 高亮，所以"不输出"不等于"丢了"。
                        if (fs > fs0 && kwUnshown(fs, fe0) === 0) { markKw(fs0, fe0); return; }
                        markRange(fs, fe0); markKw(fs, fe0);
                        let ftext = f.text;
                        if (fs > fs0) {
                            ftext = String(paragraph).substring(fs, fe0);
                            if (fs > 0) ftext = '\u2026' + ftext;
                            if (fe0 < String(paragraph).length) ftext = ftext + '\u2026';
                        }
                        html += `<p class="rule-match-para" ${modeAttr} data-para-index="${index}" data-rule-idx="${ruleIdx}" style="cursor:pointer;" onclick="ruleViewFullTextAndScroll(${absIdx}, ${index})">${highlightKeywords(ftext, keywords)}</p>`;
                    });
                    return html;
                } else if (len >= SHORT_THRESHOLD && len <= LONG_THRESHOLD) {
                    const sp = spanOf(index);
                    if (txtShown(paragraph) || covered(sp && sp[0], sp && sp[1])) return '';   // 本段已由其它块输出过 ⇒ 不重复
                    markTxt(paragraph); if (sp) { markRange(sp[0], sp[1]); markKw(sp[0], sp[1]); }
                    return `<p class="rule-match-para" ${modeAttr} data-para-index="${index}" data-rule-idx="${ruleIdx}" style="cursor:pointer;" onclick="ruleViewFullTextAndScroll(${absIdx}, ${index})">${highlightKeywords(paragraph, keywords)}</p>`;
                } else {
                    // 短段：本段若已输出过（例如作为上一段的"下一段"出现过）就不再重复整块
                    const spShort = spanOf(index);
                    if (txtShown(paragraph) || covered(spShort && spShort[0], spShort && spShort[1])) return '';
                    const prevParas = collectPrevParagraphs(allParagraphs, index, PREV_TARGET, MAX_PREV_PARAS);
                    let nextPara = '';
                    if (index < allParagraphs.length - 1) {
                        const next = allParagraphs[index + 1];
                        nextPara = next.length > NEXT_TARGET ? next.substring(0, NEXT_TARGET) + '…' : next;
                    }
                    let html = '';
                    // 【2026-10-01】关键词位置账本：本块实际输出的区间（前若干段 → 命中段 → 下一段）
                    let kwS = null, kwE = null;
                    const track = (s, e) => {
                        if (typeof s !== 'number' || typeof e !== 'number') return;
                        kwS = (kwS === null) ? s : Math.min(kwS, s);
                        kwE = (kwE === null) ? e : Math.max(kwE, e);
                    };
                    // 【2026-10-01】上下文只输出"尚未出现过"的段落（原来是原样全输出 ⇒ 同一段可能出现两遍）
                    prevParas.forEach(p => {
                        if (txtShown(p)) return;
                        markTxt(p);
                        const pi = allParagraphs.indexOf(p);
                        const spPrev = pi >= 0 ? spanOf(pi) : null;
                        if (spPrev) track(spPrev[0], spPrev[1]);
                        html += `<span class="rule-context">${escapeHtml(p)}</span> `;
                    });
                    markTxt(paragraph);
                    if (spShort) { markRange(spShort[0], spShort[1]); track(spShort[0], spShort[1]); }
                    html += `<span class="rule-matched-paragraph rule-match-para" ${modeAttr} data-para-index="${index}" data-rule-idx="${ruleIdx}" style="cursor:pointer;" onclick="ruleViewFullTextAndScroll(${absIdx}, ${index})">${highlightKeywords(paragraph, keywords)}</span>`;
                    if (nextPara) {
                        const nextFull = allParagraphs[index + 1];
                        if (!txtShown(nextFull)) {
                            // 完整展示的下一段才登记文本（被截断的只登记区间，避免它自己命中时丢掉后半段）
                            if (nextFull.length <= NEXT_TARGET) markTxt(nextFull);
                            const spNext = spanOf(index + 1);
                            if (spNext) {
                                const ne = spNext[0] + Math.min(NEXT_TARGET, nextFull.length);
                                markRange(spNext[0], ne);
                                track(spNext[0], ne);
                            }
                            html += ` <span class="rule-context">${escapeHtml(nextPara)}</span>`;
                        }
                    }
                    if (kwS !== null) markKw(kwS, kwE);   // 本块已把这些关键词位置"露过面"
                    return `<p>${html}</p>`;
                }
            }

            function generateRuleSnippet(rule, keywords, ruleIdx, matchMode = 'and') {
                // 修复：从原始规章数组获取绝对索引（不受专业过滤影响）
                const allRules = typeof window.getRulesData === 'function' ? window.getRulesData() : rules;
                const absIdx = allRules.indexOf(rule);
                const paragraphs = smartSplitParagraphs(rule.content);
                if (paragraphs.length === 0) return '';
                const lowerKeywords = keywords.map(k => k.toLowerCase());
                const matchedIndices = [];
                paragraphs.forEach((para, idx) => {
                    const lowerPara = para.toLowerCase();
                    let matched;
                    // AND模式：必须包含所有关键词
                    matched = lowerKeywords.every(kw => lowerPara.includes(kw));
                    if (matched) matchedIndices.push(idx);
                });
                if (matchedIndices.length === 0) return '';
                // 【2026-10-01 用户报「截取段落重复」】同一个规章的渲染上下文：记录"已输出过的正文区间/段落文本"，
                //   供 processParagraph 去重。重复来源有三处：
                //     ① 小段落延伸（前若干段 + 下一段）与相邻命中段会**同一段出现两次**；
                //     ② 大段落按关键词截多个窗口时，窗口先合并、再各自向标点扩展 ⇒ 扩展后仍会互相重叠；
                //     ③ 小段落延伸的"下一段"正好是大段落并命中 ⇒ 两条机制交叉重复。
                //   注意：只影响**显示**，不改命中判定与排序（用户口径：段内 AND / 排序不动）。
                //   ★ 去重的总原则（2026-10-01 用户点明）：截取**边界由关键词位置与标点决定、且不能改**，
                //     所以不能靠"挪边界"去重 —— 而是把**截取范围**与**输出范围**分开：
                //       提取照旧（边界一个字不改）→ 输出时按正文坐标做「候选区间 − 已输出区间」；
                //       再配一本「关键词出现位置账本」：候选片段里还有"没露过面"的关键词位置 ⇒ 必须输出；
                //       一个都不剩 ⇒ 纯重复 ⇒ 去掉（这样既不去重掉信息，也不出现两遍）。
                const ctx = {
                    shownRanges: [], shownTexts: new Set(), paraSpans: buildParaSpans(rule.content, paragraphs),
                    kwPositions: findKeywordPositions(rule.content, keywords), kwShown: new Set()
                };
                let html = '';
                matchedIndices.forEach(idx => {
                    html += processParagraph(paragraphs[idx], idx, paragraphs, keywords, ruleIdx, matchMode, absIdx, ctx);
                });
                return html;
            }

            /**
             * 【2026-10-01】计算每个段落片段在**原始正文**里的字符区间（顺序扫描，容忍重复文本）。
             * 用途：判断"这一段是否已经被输出过"——按区间比按文本可靠（大段落窗口是子串，无法用文本判重）。
             */
            function buildParaSpans(content, paragraphs) {
                const text = String(content == null ? '' : content);
                const spans = [];
                let cursor = 0;
                for (let i = 0; i < paragraphs.length; i++) {
                    const p = paragraphs[i];
                    let at = text.indexOf(p, cursor);
                    if (at < 0) at = text.indexOf(p);        // 兜底：段落被 trim/合并过，顺序与原文不完全一致
                    if (at < 0) { spans.push(null); continue; }
                    spans.push([at, at + p.length]);
                    cursor = at + p.length;
                }
                return spans;
            }

            /**
             * 【2026-10-01】「关键词出现位置账本」：正文里每个关键词出现的**字符下标**。
             * 这是"不动截取边界也能去重"的关键 —— 判断某个候选片段该不该输出，不再只看区间重叠，
             * 而是看它里面**还有没有"从没露过面"的关键词位置**：
             *   · 有 ⇒ 必须输出（否则这个关键词出现的位置就丢了，用户会觉得"明明命中却没标出来"）；
             *   · 都没有 ⇒ 内容一定已出现过 ⇒ 去掉（这就是"关键词位置小于截取边界"造成重复的解法）。
             */
            function findKeywordPositions(content, keywords) {
                const text = String(content == null ? '' : content).toLowerCase();
                const out = [];
                (keywords || []).forEach(kw => {
                    const k = String(kw || '').toLowerCase();
                    if (!k) return;
                    let at = text.indexOf(k);
                    while (at !== -1) { out.push(at); at = text.indexOf(k, at + k.length); }
                });
                return out.sort((a, b) => a - b);
            }

            function getKeywords() {
                const keywords = [];
                for (let i = 1; i <= window.ruleKeywordCount; i++) {
                    const kw = document.getElementById('rule-input_' + i)?.value.trim();
                    if (kw) keywords.push(kw);
                }
                return keywords;
            }

            // 获取用户输入的原始关键词（用于搜索条件提示显示）
            function getRawKeywords() {
                return getKeywords();
            }

            function addKeywordInput() {
                if (window.ruleKeywordCount >= MAX_KEYWORDS) return;
                window.ruleKeywordCount++;
                const container = document.getElementById('rule-keywordContainer');
                if (!container) return;
                const div = document.createElement('div');
                div.className = 'keyword-row';
                div.id = 'rule-kw_' + window.ruleKeywordCount;
                div.innerHTML = '<label>关键词' + window.ruleKeywordCount + '</label><input type="text" id="rule-input_' + window.ruleKeywordCount + '" placeholder="输入关键词' + window.ruleKeywordCount + '">' + (window.ruleKeywordCount > 1 ? '<button class="btn-remove" onclick="removeRuleKeyword(' + window.ruleKeywordCount + ')">×</button>' : '');
                container.appendChild(div);
                const input = document.getElementById('rule-input_' + window.ruleKeywordCount);
                if (input) {
                    setTimeout(() => input.focus(), 100);
                }
                updateAddBtn();
            }

            // v3.13：折叠屏恢复后，page-state 已将 panel-rule 的 innerHTML 还原（含 N 个关键词行）。
            // 此处根据当前 DOM 重新同步计数器并规范 id/标签/按钮，避免与 addKeywordInput 叠加导致「多一个框」。
            function syncRuleKeywordFromDOM() {
                var c = document.getElementById('rule-keywordContainer');
                if (!c) return;
                var rows = c.querySelectorAll('.keyword-row');
                window.ruleKeywordCount = 0;
                rows.forEach(function (item) {
                    window.ruleKeywordCount++;
                    item.id = 'rule-kw_' + window.ruleKeywordCount;
                    var label = item.querySelector('label');
                    if (label) label.textContent = '关键词' + window.ruleKeywordCount;
                    var input = item.querySelector('input');
                    if (input) { input.id = 'rule-input_' + window.ruleKeywordCount; input.placeholder = '输入关键词' + window.ruleKeywordCount; }
                    var btn = item.querySelector('.btn-remove');
                    if (btn) {
                        if (window.ruleKeywordCount === 1) btn.remove();
                        else btn.setAttribute('onclick', 'removeRuleKeyword(' + window.ruleKeywordCount + ')');
                    }
                });
                updateAddBtn();
            }
            // 折叠屏恢复完成后，由 page-state 派发此事件，重新同步关键词计数
            window.addEventListener('pageSnapshotRestored', function () { syncRuleKeywordFromDOM(); });

            // v3.27：暴露「添加关键词框」供 page-state 草稿回填补齐数量（与 issue.js 的 issueAddKeyword 对称）
            window.ruleAddKeyword = addKeywordInput;

            window.removeRuleKeyword = function(n) {
                const el = document.getElementById('rule-kw_' + n);
                if (el) el.remove();
                const items = document.querySelectorAll('#rule-keywordContainer .keyword-row');
                window.ruleKeywordCount = 0;
                items.forEach((item) => {
                    window.ruleKeywordCount++;
                    item.id = 'rule-kw_' + window.ruleKeywordCount;
                    const label = item.querySelector('label');
                    if (label) label.textContent = '关键词' + window.ruleKeywordCount;
                    const input = item.querySelector('input');
                    if (input) {
                        input.id = 'rule-input_' + window.ruleKeywordCount;
                        input.placeholder = '输入关键词' + window.ruleKeywordCount;
                    }
                    const btn = item.querySelector('.btn-remove');
                    if (btn) {
                        if (window.ruleKeywordCount === 1) btn.remove();
                        else btn.setAttribute('onclick', 'removeRuleKeyword(' + window.ruleKeywordCount + ')');
                    }
                });
                updateAddBtn();
            };

            function updateAddBtn() {
                const btn = document.getElementById('rule-btnAdd');
                if (!btn) return;
                if (window.ruleKeywordCount >= MAX_KEYWORDS) { btn.disabled = true; btn.textContent = '已达到最大关键词数量(4个)'; }
                else { btn.disabled = false; btn.textContent = '+ 添加关键词 (还可添加' + (MAX_KEYWORDS - window.ruleKeywordCount) + '个)'; }
            }

            function clearSearch() {
                const container = document.getElementById('rule-keywordContainer');
                if (container) container.innerHTML = '';
                window.ruleKeywordCount = 0;
                addKeywordInput();
                const tradeSelect = document.getElementById('rule-tradeSelect');
                if (tradeSelect) tradeSelect.value = '';
                document.getElementById('rule-resultsList').style.display = 'none';
                document.querySelector('#panel-rule .results-header').style.display = 'none';
            }

            function handleImportClick() {
                // 【2026-09-21】原实现只判 isProcessing，而它仅在正常路径复位（下方 1105/1113）：
                //   一旦异常逃逸（refreshTradeSelect/renderResults 抛错等）→ 之后**所有导入都被"正在处理中"拒绝，只能刷新页面**。
                //   改为带时间戳的锁：超过 3 分钟视为失效，自动放行并留日志。
                if (isProcessing && (Date.now() - _procStartAt) < 180000) { alert('正在处理中，请稍候…'); return; }
                if (isProcessing) { console.warn('[规章导入] 上一次处理已超过 3 分钟未结束，自动解除锁定（疑似异常未复位）'); }
                const input = document.getElementById('rule-fileInput');
                if (!input) return;
                input.click();
            }

            // 在 init 时绑定 onchange（设置面板直接 click input 时也会触发此 handler）
            (function bindRuleFileInput() {
                var _inp = document.getElementById('rule-fileInput');
                if (_inp) {
                    _inp.onchange = async (e) => {
                        const files = e.target.files;
                        if (!files || files.length === 0) return;
                        // 【2026-09-21】原实现只判 isProcessing，而它仅在正常路径复位（下方 1105/1113）：
                //   一旦异常逃逸（refreshTradeSelect/renderResults 抛错等）→ 之后**所有导入都被"正在处理中"拒绝，只能刷新页面**。
                //   改为带时间戳的锁：超过 3 分钟视为失效，自动放行并留日志。
                if (isProcessing && (Date.now() - _procStartAt) < 180000) { alert('正在处理中，请稍候…'); return; }
                if (isProcessing) { console.warn('[规章导入] 上一次处理已超过 3 分钟未结束，自动解除锁定（疑似异常未复位）'); }

                        const zipFile = Array.from(files).find(f => f.name.toLowerCase().endsWith('.zip'));
                        if (zipFile) {
                            await importFromZip(zipFile);
                        } else {
                            window.pendingImportFiles = Array.from(files);
                            openModal('rule-importModal');
                        }
                        e.target.value = '';
                    };
                }
            })();
            
            // 将DOCX转换为单个section（保留图片、表格、排版）
            // 不再按章节拆分——一个文件对应一条规章
            async function organizeDocxToSections(arrayBuffer, filename) {
                const sections = [];
                
                try {
                    if (typeof mammoth === 'undefined') throw new Error('mammoth 库未加载');
                    
                    // 用mammoth完整转换HTML（保留图片、表格、排版）
                    const imageIds = [];
                    const options = {
                        convertImage: mammoth.images.imgElement(function(image) {
                            return image.read("base64").then(async function(imageBuffer) {
                                const imgId = 'img_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
                                const contentType = image.contentType;
                                const byteCharacters = atob(imageBuffer);
                                const byteNumbers = new Array(byteCharacters.length);
                                for (let i = 0; i < byteCharacters.length; i++) {
                                    byteNumbers[i] = byteCharacters.charCodeAt(i);
                                }
                                const byteArray = new Uint8Array(byteNumbers);
                                const blob = new Blob([byteArray], { type: contentType });
                                await saveImageToDB(imgId, blob);
                                imageIds.push(imgId);
                                // 用 data-img-id 属性存储 ID，src 留空，避免占位符写入 src 值导致渲染损坏
                                return { src: '', 'data-img-id': imgId, class: 'rule-lazy-img' };
                            });
                        })
                    };
                    
                    const result = await mammoth.convertToHtml({ arrayBuffer }, options);
                    const fullHtml = cleanHtml(result.value);
                    
                    if (!fullHtml || !fullHtml.trim()) {
                        console.warn('mammoth转换结果为空');
                        return sections;
                    }
                    
                    // 整个文档作为1个section，文件名作为标题
                    sections.push({
                        title: filename.replace(/\.[^/.]+$/, ''),
                        content: stripHtml(fullHtml),
                        contentHtml: fullHtml,
                        imageIds: imageIds.slice()
                    });
                    
                } catch (err) {
                    console.error('整理DOCX失败:', err);
                }
                
                return sections;
            }
            
            window.closeImportModal = function() { 
                closeModal('rule-importModal'); 
                window.pendingImportFiles = []; 
                document.getElementById('rule-importTitle').textContent = '📥 导入规章';
            }
            window.confirmImportTrade = async function() {
                let trade = document.getElementById('rule-importTrade')?.value;
                const newTrade = document.getElementById('rule-importNewTrade')?.value.trim();
                if (newTrade) trade = newTrade;
                if (!trade) { alert('请选择或输入专业'); return; }
                window.pendingImportTrade = trade;
                closeModal('rule-importModal');
                await processFiles(window.pendingImportFiles, trade);
            }
            var LIB_MAMMOTH = 'src/js/vendor/mammoth.browser.min.js';
            var LIB_PDFJS   = 'src/js/vendor/pdf.min.js';
            var LIB_PDFJS_WORKER = 'src/js/vendor/pdf.worker.min.js';
            var LIB_XLSX    = 'src/js/vendor/xlsx.full.min.js';
            var LIB_JSZIP   = 'src/js/vendor/jszip.min.js';

            async function processFiles(files, trade) {
                // 三个库分别加载、互不影响：原来用 Promise.all 包裸 loadScript，
                // 任一失败（离线时几乎必然）就整体 reject，导致「只导入 docx
                // 却因 pdf.js 拉不下来而整批失败」，且界面停在导入中无任何提示。
                // 改为记录可用性，具体文件缺哪个库由下面的 try/catch 单独跳过。
                var libs = await Promise.all([
                    window.requireLib(LIB_MAMMOTH, { silent: true }),
                    window.requireLib(LIB_PDFJS, { silent: true }),
                    window.requireLib(LIB_XLSX, { silent: true })
                ]);
                var missingLibs = [];
                if (!libs[0]) missingLibs.push('Word(.docx)');
                if (!libs[1]) missingLibs.push('PDF(.pdf)');
                if (!libs[2]) missingLibs.push('Excel(.xlsx)');
                // 【2026-09-19 自托管修复】pdf.js 的 worker 路径必须在**解析前**指定：
                //   本文件顶部那句 `if (typeof pdfjsLib !== 'undefined') workerSrc = ...` 是在模块
                //   加载时执行的，而 pdfjsLib 是**按需加载**的（那一刻永远是 undefined）→ 从来没生效过，
                //   workerSrc 一直是空串（只能靠 pdf.js 自身兜底，行为不确定）。这里在库加载成功后补上。
                if (typeof pdfjsLib !== 'undefined' && pdfjsLib.GlobalWorkerOptions) {
                    pdfjsLib.GlobalWorkerOptions.workerSrc = LIB_PDFJS_WORKER;
                }
                isProcessing = true; _procStartAt = Date.now();
                const btn = document.getElementById('rule-importBtn');
                let successCount = 0, skipCount = 0;
                // 【2026-09-21】逐文件跳过原因：原来只累计 skipCount → 用户只看到"跳过 2 个"，
                //   完全不知道是被什么拦下的（后缀不支持？.doc 老格式？解析失败？）
                const skipNotes = [];
                // 【2026-10-03 用户报「提示前后矛盾」】原来"成功文件的处理说明"（已清理页眉页脚 / 识别到表格 /
                //   已去除水印）和"真的没导入"混在 skipNotes 一个数组里 ⇒ 弹窗出现"导入完成：成功 1 个，跳过 0 个"
                //   紧接着又列在「未导入的文件及原因」下的自相矛盾文案。现在分成两个账：
                //   · successNotes：**已导入成功**文件的处理说明（信息性，不是失败原因）；
                //   · skipNotes：真正被跳过/失败的文件与原因。
                const successNotes = [];
                for (let i = 0; i < files.length; i++) {
                    const file = files[i];
                    const ext = file.name.split('.').pop().toLowerCase();
                    if (btn) btn.innerHTML = '<span class="spinner" style="width:14px;height:14px;display:inline-block;vertical-align:middle;margin-right:4px;"></span> ' + (i + 1) + '/' + files.length;
                    // 【2026-09-21】进度同时走**全局进度条**：从「设置 → 数据」入口导入时
                    //   `#rule-importBtn` 根本不存在（按钮已迁到设置面板）→ 原来等于**零进度**，用户不知道在跑。
                    try { window.showProgress(Math.round(i / files.length * 100), '正在导入规章 ' + (i + 1) + '/' + files.length + '：' + file.name); } catch (e) {}
                    try {
                        let contentHtml = '';
                        let searchText = '';
                        let plainText = '';  // 保留换行的纯文本，用于段落搜索
                        let imageIds = [];
                        
                        if (ext === 'pdf') {
                            if (typeof pdfjsLib === 'undefined') throw new Error('pdf.js 库未加载');
                            const arrayBuffer = await file.arrayBuffer();
                            const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
                            // 【2026-10-03 用户报】原来 `items.map(str).join(' ')` ✗：①句子中间被塞空格（打断句子）
                            //   ②整页并成一行 ⇒ 只能被 smartSplitParagraphs 按 300 字硬切（"随意打断"）。
                            //   现在用 ImportLayout 还原排版：行内按 X 拼（中文不加空格/拉丁补空格）、按 Y 聚行、
                            //   按标点/行距/条款头/缩进还原自然段；**倾斜文字（水印）丢弃并计数**。
                            if (!window.ImportLayout) {
                                try { await window.loadScript('src/js/modules/import-layout.js'); } catch (e) {}
                            }
                            const _lay = window.ImportLayout;
                            // ⚠️ _pdfDoc 必须声明在 **if 之外**：块级 const 在 if 里声明、块外引用会抛
                            //   "ReferenceError: _doc is not defined"（用户实测导入直接失败、整份文件被跳过）。
                            let _pdfDoc = null;
                            const _items = [];
                            for (let p = 1; p <= pdf.numPages; p++) {
                                const page = await pdf.getPage(p);
                                const content = await page.getTextContent();
                                _items.push(content.items);
                            }
                            if (_lay) {
                                // 【2026-10-03 用户给的实测语料】一次解决四件事：
                                //   ① 行内清空格（"铁 路 按 照 普 速 铁 路" ⇒ "铁路按照普速铁路"）；
                                //   ② 段落还原（段内不加硬回车、按标点/行距/条款头分段）；
                                //   ③ 丢弃倾斜水印行；
                                //   ④ 跨页剔除页码（"—— 1 ——"）、重复页眉页脚（"LZG/GW213 - 2026"）、
                                //      打印水印戳（"10.211.6.89 lanzhl-dujianchun 610219 2026-07-10 02:13:41"）。
                                // 【2026-10-09 用户决策·"遇到表格就跳过，只导出文字"】PDF 导入时开启跳过开关
                                //   （表格内容不进正文；结果提示里如实报告跳过了多少张表）
                                try { window.__pdfSkipTables = true; window.__pdfSkippedTables = 0; } catch (e) {}
                                _pdfDoc = _lay.buildDocument(_items);
                                try { window.__pdfSkipTables = false; } catch (e) {}
                                try {
                                    if (window.__pdfSkippedTables) {
                                        successNotes.push(file.name + '：已按设置**跳过 ' + window.__pdfSkippedTables
                                            + ' 张表格**（当前口径为"只导文字"，PDF/OFD 的表格内容不导入；'
                                            + '如需表格本身，请改用 DOCX 格式导入）');
                                    }
                                } catch (e) {}
                                // 【2026-10-05 用户需求】导入时自动去掉各种水印与"内部资料 不得外传"字样。
                                //   与 OFD / DOCX 共用 ImportLayout 的水印清洗（整行水印删掉、长行内水印只记录不删）。
                                if (_lay.stripWatermarkBlocks) {
                                    var _rb = _lay.stripWatermarkBlocks(_pdfDoc.blocks || []);
                                    var _wmAll = _rb.removed.slice();
                                    if (_rb.removed.length) {
                                        _pdfDoc.blocks = _rb.blocks;
                                        // ⚠️ 两点讲究：
                                        //   ① 不用 blocksToText 重算正文 —— _pdfDoc.text 是**跨页合并**后的高质量结果，重算会丢合并效果；
                                        //   ② 也不用 split(w).join('') 全局抹除同一串 —— 那会连**正文中间**的同名字样一起删掉，
                                        //      与用户口径（"其余的就是原文，不要删"）冲突。正文里的清理交给下面的行级窗口判断。
                                    }
                                    if (_lay.stripWatermarkText) {
                                        var _rt = _lay.stripWatermarkText(plainText);
                                        if (_rt.removed.length) { plainText = _rt.text; _wmAll = _wmAll.concat(_rt.removed); }
                                    }
                                    if (_wmAll.length) {
                                        _pdfDoc.text = plainText;
                                        successNotes.push(file.name + '：已自动清除 ' + _wmAll.length + ' 处水印/“内部资料 不得外传”类字样');
                                        try { console.info('[PDF] 已清除水印：' + _wmAll.slice(0, 8).join('；')); } catch (e) {}
                                    }
                                }
                                plainText = _pdfDoc.text;
                                if (_pdfDoc.rotatedDropped > 0) {
                                    successNotes.push(file.name + '：已忽略 ' + _pdfDoc.rotatedDropped + ' 行倾斜文字（通常为水印）');
                                }
                                if (_pdfDoc.removed && _pdfDoc.removed.length) {
                                    successNotes.push(file.name + '：已清理 ' + _pdfDoc.removed.length + ' 处页眉页脚/页码/水印戳');
                                    try { console.info('[PDF] 已清理：' + _pdfDoc.removed.slice(0, 8).join('；')); } catch (e) {}
                                }
                            } else {
                                plainText = _items.map(function (its) {
                                    return its.map(function (i2) { return i2.str; }).join('');
                                }).join('\n');
                            }
                            searchText = normalizeSearchText(plainText);
                            // 逐段呈现 + **公文体例**（首行缩进 2 字、条款编号加粗、附件/标题居中、列表项缩进）：
                            //   原来是整篇一个 <pre>（段落感全无）⇒ 用户看到的"PDF 格式不正常"。
                            contentHtml = (_lay && _lay.blocksToHtml && _pdfDoc && _pdfDoc.blocks && _pdfDoc.blocks.length)
                                ? _lay.blocksToHtml(_pdfDoc.blocks)
                                : plainText.split('\n').map(function (p) { return '<p class="imp-p">' + escapeHtml(p) + '</p>'; }).join('');
                            if (_pdfDoc && _pdfDoc.blocks) {
                                var _tc = _pdfDoc.blocks.filter(function (b) { return b.type === 'table'; }).length;
                                if (_tc > 0) successNotes.push(file.name + '：识别到 ' + _tc + ' 张表格（已按行列还原）');
                            }
                        } else if (ext === 'ofd') {
                            // 【2026-10-03 用户需求】OFD（国产版式文档）导入：本地 JSZip 解包 → 抽正文 → **去水印**。
                            //   全程离线；水印判据（注释水印 / 图层名 / 版式特征）见 src/js/modules/ofd-import.js 文件头。
                            if (!window.OFDImport) {
                                try { await window.loadScript('src/js/modules/ofd-import.js'); } catch (e) {}
                            }
                            if (!window.OFDImport) throw new Error('OFD 解析模块未加载');
                            const _ofdRes = await window.OFDImport.extract(file);
                            const _ofdTxt = (_ofdRes && _ofdRes.text) || '';
                            if (!_ofdTxt.trim()) throw new Error((_ofdRes && _ofdRes.note) || '未解析出正文（可能是扫描件/纯图片版 OFD）');
                            plainText = _ofdTxt;
                            searchText = normalizeSearchText(_ofdTxt);
                            // 【2026-10-05】OFD 也接上共用水印清洗（此前只接了 PDF/DOCX，OFD 漏了）。
                            //   坐标修复后"内部资料 不得外传"已能聚成整行 ⇒ 这里才真正删得掉（之前逐字散着，判据抓不到）。
                            try {
                                var _ol = window.ImportLayout;
                                if (_ol && _ol.stripWatermarkText) {
                                    var _owm = _ol.stripWatermarkText(_ofdTxt);
                                    if (_owm.removed.length) {
                                        if (_ol.stripWatermarkBlocks && _ofdRes.blocks && _ofdRes.blocks.length) {
                                            _ofdRes.blocks = _ol.stripWatermarkBlocks(_ofdRes.blocks).blocks;
                                        }
                                        successNotes.push(file.name + '：已自动清除 ' + _owm.removed.length + ' 处水印/“内部资料 不得外传”类字样');
                                    }
                                    plainText = _owm.text;
                                    searchText = normalizeSearchText(plainText);
                                }
                            } catch (e) {}
                            // 与 PDF 同款公文体例渲染（首行缩进 2 字、条款编号加粗、附件/标题居中、列表项缩进）
                            contentHtml = (window.ImportLayout && window.ImportLayout.blocksToHtml && _ofdRes.blocks && _ofdRes.blocks.length)
                                ? window.ImportLayout.blocksToHtml(_ofdRes.blocks)
                                : plainText.split(/\n+/).map(function (p) { return '<p class="imp-p">' + escapeHtml(p) + '</p>'; }).join('');
                            if (_ofdRes.blocks) {
                                var _tco = _ofdRes.blocks.filter(function (b) { return b.type === 'table'; }).length;
                                if (_tco > 0) successNotes.push(file.name + '：识别到 ' + _tco + ' 张表格（已按行列还原）');
                            }
                            if (_ofdRes.removed && _ofdRes.removed.length) {
                                try { console.info('[OFD] 已去除水印 ' + _ofdRes.removed.length + ' 处：' + _ofdRes.removed.join('；')); } catch (e) {}
                                successNotes.push(file.name + '：已去除水印 ' + _ofdRes.removed.length + ' 处');
                            }
                            if (_ofdRes.note) successNotes.push(file.name + '：' + _ofdRes.note);
                        } else if (ext === 'docx' || ext === 'doc') {
                            if (typeof mammoth === 'undefined') throw new Error('mammoth 库未加载');
                            const arrayBuffer = await file.arrayBuffer();
                            
                            // 先尝试按章节整理（新版本已用mammoth转换，保留图片/表格/排版）
                            const organizedSections = await organizeDocxToSections(arrayBuffer, file.name);
                            if (organizedSections.length > 0) {
                                // 成功拆分为章节（或整个文档作为1个section），逐个导入
                                for (const section of organizedSections) {
                                    const dupIdx = rules.findIndex(r => 
                                        r.title.toLowerCase().trim() === section.title.toLowerCase().trim() && 
                                        r.trade === trade
                                    );
                                    // 【2026-10-05 用户需求】DOCX 导入同样去水印：与 PDF / OFD 共用 ImportLayout 的清洗，
                                    //   口径 = 只删**开头/结尾 1~5 行**里"内部资料 不得外传"这类整行，**正文中间的一律当原文保留**。
                                    var _wmL = window.ImportLayout;
                                    var _wmC = (_wmL && _wmL.stripWatermarkText) ? _wmL.stripWatermarkText(section.content) : null;
                                    var _wmH = _ruleSanitizeForStore(section.contentHtml);
                                    if (_wmL && _wmL.isWatermarkLine) {
                                        var _ps = _wmH.match(/<p[^>]*>[\s\S]*?<\/p>/g) || [];
                                        if (_ps.length) {
                                            // 只丢"整段就是水印"且落在**开头/结尾 5 段**内的段落；其余原样保留（不做重建，零格式风险）
                                            // ⚠️【2026-10-07 修复·DOCX 套件实测暴露】原实现把结果存成**字符串数组**再用
                                            //   `_keep.indexOf(m)` 反查 —— 两段 HTML 完全相同时会**互相顶替**：
                                            //   实测用例（首部与中部都写"内部资料 不得外传"，首部该删、中部该留）结果为
                                            //   **纯文本层剩 1 处（正确）而 HTML 层剩 3 处（首/尾两处全漏删）**。
                                            //   隐蔽之处：纯文本已由 stripWatermarkText 清掉，检索/导出正文看不出问题，
                                            //   但**界面渲染用的正是 contentHtml** ⇒ 用户仍会看到水印。
                                            //   改为按**段落序号**判定：语义精确，且与段落文本是否重复无关。
                                            var _keepIdx = {};
                                            _ps.forEach(function (p, i) {
                                                var _pl = String(p).replace(/<[^>]+>/g, '').trim();
                                                if (!_wmL.shouldDropLine(_pl, i < 5 || i >= _ps.length - 5)) _keepIdx[i] = 1;
                                            });
                                            var _pIdx = -1;
                                            _wmH = _wmH.replace(/<p[^>]*>[\s\S]*?<\/p>/g, function (m) { _pIdx++; return _keepIdx[_pIdx] ? m : ''; });
                                        }
                                    }
                                    if (_wmC && _wmC.removed.length) {
                                        successNotes.push(file.name + '：已自动清除 ' + _wmC.removed.length + ' 处水印/“内部资料 不得外传”类字样');
                                    }
                                    const ruleData = {
                                        trade,
                                        title: section.title,
                                        content: _wmC ? _wmC.text : section.content,  // 保留换行的纯文本（stripHtml结果）
                                        contentHtml: _wmH,
                                        imageIds: section.imageIds || []
                                    };
                                    if (dupIdx !== -1) rules[dupIdx] = ruleData;
                                    else rules.push(ruleData);
                                    successCount++;
                                }
                                continue; // 跳过下面的单文件处理
                            }
                            
                            // 无法拆分章节，直接按单文件处理（含图片）
                            const options = {
                                convertImage: mammoth.images.imgElement(function(image) {
                                    return image.read("base64").then(async function(imageBuffer) {
                                        const imgId = 'img_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
                                        const contentType = image.contentType;
                                        const byteCharacters = atob(imageBuffer);
                                        const byteNumbers = new Array(byteCharacters.length);
                                        for (let i = 0; i < byteCharacters.length; i++) {
                                            byteNumbers[i] = byteCharacters.charCodeAt(i);
                                        }
                                        const byteArray = new Uint8Array(byteNumbers);
                                        const blob = new Blob([byteArray], { type: contentType });
                                        await saveImageToDB(imgId, blob);
                                        imageIds.push(imgId);
                                        return { src: '', 'data-img-id': imgId, class: 'rule-lazy-img' };
                                    });
                                })
                            };
                            
                            const result = await mammoth.convertToHtml({ arrayBuffer }, options);
                            contentHtml = cleanHtml(result.value);
                            // 注意：此处必须用外层已声明的 plainText，不能再写 const，
                            // 否则块级作用域遮蔽会导致下面 content 取到外层空串（换行全丢，
                            // smartSplitParagraphs 按 \n 分段失效，整篇规章退化成一整段）
                            plainText = stripHtml(contentHtml);  // 保留换行的纯文本
                            searchText = normalizeSearchText(plainText);  // 无换行，用于分数计算
                            // 【2026-10-05 用户需求】单文件兜底路径也要去水印（口径同章节分支：只删开头/结尾 1~5 行）
                            if (window.ImportLayout && window.ImportLayout.stripWatermarkText) {
                                var _wm2 = window.ImportLayout.stripWatermarkText(plainText);
                                if (_wm2.removed.length) {
                                    var _ps2 = contentHtml.match(/<p[^>]*>[\s\S]*?<\/p>/g) || [];
                                    if (_ps2.length) {
                                        // 同章节分支：按**段落序号**判定（原因见上方注释 —— _k2.indexOf(m) 在段落重复时会互相顶替）
                                        var _keepIdx2 = {};
                                        _ps2.forEach(function (p, i) {
                                            var _pl2 = String(p).replace(/<[^>]+>/g, '').trim();
                                            if (!window.ImportLayout.shouldDropLine(_pl2, i < 5 || i >= _ps2.length - 5)) _keepIdx2[i] = 1;
                                        });
                                        var _pIdx2 = -1;
                                        contentHtml = contentHtml.replace(/<p[^>]*>[\s\S]*?<\/p>/g, function (m) { _pIdx2++; return _keepIdx2[_pIdx2] ? m : ''; });
                                    }
                                    successNotes.push(file.name + '：已自动清除 ' + _wm2.removed.length + ' 处水印/“内部资料 不得外传”类字样');
                                }
                                plainText = _wm2.text;
                                searchText = normalizeSearchText(plainText);
                            }
                        } else if (ext === 'json') {
                            const textContent = await file.text();
                            const data = JSON.parse(textContent);
                            if (Array.isArray(data)) {
                                for (const item of data) {
                                    if (item.title && (item.content || item.contentHtml)) {
                                        const itemTrade = item.trade || trade;
                                        // 处理导入的图片（如果是ZIP导出格式）
                                        if (item.imageIds && item.imageIds.length > 0) {
                                            imageIds = item.imageIds;
                                        }
                                        const dupIdx = rules.findIndex(r => r.title.toLowerCase().trim() === item.title.toLowerCase().trim() && r.trade === itemTrade);
                                        // 判断是否有真正的HTML内容（包含HTML标签）
                                        const hasRealHtml = item.contentHtml && /<[a-z][\s\S]*>/i.test(item.contentHtml);
                                        const ruleData = { 
                                            trade: itemTrade, 
                                            title: item.title, 
                                            content: item.content || stripHtml(item.contentHtml),
                                            contentHtml: hasRealHtml ? _ruleSanitizeForStore(item.contentHtml) : '',
                                            imageIds: item.imageIds || []
                                        };
                                        if (dupIdx !== -1) rules[dupIdx] = ruleData;
                                        else rules.push(ruleData);
                                        successCount++;
                                    }
                                }
                                continue;
                            }
                        } else {
                            skipCount++;
                            if (ext === 'doc') skipNotes.push(file.name + '：不支持老版 .doc，请在 Word 里「另存为 .docx」后再导入');
                            else skipNotes.push(file.name + '：不支持的格式 .' + ext + '（支持 pdf / ofd / docx / json / zip）');
                            continue;
                        }

                        if (!searchText.trim() && !contentHtml.trim()) { skipCount++; skipNotes.push(file.name + '：未解析出正文（可能为扫描件/图片版 PDF）'); continue; }
                        const title = file.name.replace(/\.[^/.]+$/, '');
                        // 去重必须带上专业：同名文件导入到不同专业时属于两条不同规章，
                        // 只按 title 判定会把第二次导入覆盖掉第一次（与 DOCX / JSON 分支不一致）
                        const dupIdx = rules.findIndex(r => r.title.toLowerCase().trim() === title.toLowerCase().trim() && r.trade === trade);
                        const ruleData = { 
                            trade, 
                            title, 
                            content: plainText || searchText,  // 保留换行的纯文本（DOCX用plainText，PDF等用searchText）
                            contentHtml: _ruleSanitizeForStore(contentHtml),
                            imageIds: imageIds
                        };
                        if (dupIdx !== -1) rules[dupIdx] = ruleData;
                        else rules.push(ruleData);
                        successCount++;
                    } catch (err) {
                        console.error(err); skipCount++;
                        // .doc（老二进制 Word）走的是 docx 解析分支 → mammoth 必抛，这里给出可操作的说明
                        if (ext === 'doc') skipNotes.push(file.name + '：不支持老版 .doc，请在 Word 里「另存为 .docx」后再导入');
                        else skipNotes.push(file.name + '：' + ((err && err.message) || '解析异常'));
                    }
                }
                // B4：保存失败必须让用户知道，并把内存回滚到库里的真实状态 ——
                // 否则界面显示"导入成功"，刷新后数据全部消失。
                if (!(await saveToStorage({ silent: true }))) {
                    if (btn) btn.innerHTML = '📥 导入';
                    isProcessing = false;
                    try { await loadRulesFromDB(); } catch (e) { console.warn('[rule] 回滚失败:', e && e.message); }
                    refreshTradeSelect(); updateTotalBadge(); renderResults();
                    alert('导入内容未能写入本地存储（通常是存储空间不足或数据库被其它标签页占用），已回滚本次导入。\n原有规章不受影响；建议先删除部分含图规章或清理图片后重试。');
                    return;
                }
                refreshTradeSelect(); updateTotalBadge(); renderResults();
                if (btn) btn.innerHTML = '📥 导入';
                isProcessing = false;
                var _doneMsg = '导入完成：成功 ' + successCount + ' 个，跳过 ' + skipCount + ' 个' + (skipNotes.length ? '（原因见下）' : '');
                try { window.finishProgress('✅ ' + _doneMsg); } catch (e) {}
                // 【2026-10-05 逻辑统一】导入成功后走统一收尾：**让知识库索引失效** + 刷条数统计。
                //   这条路径此前**只刷了统计、漏了索引失效** ⇒ 导入成功的规章在智能检索/对规里搜不到（旧索引）。
                try { window.afterDataWrite({ kb: 'rules' }); } catch (e) { try { if (typeof window.updateDataManagementStats === 'function') window.updateDataManagementStats(); } catch (e2) {} }
                var _sum = buildRuleImportSummary({
                    successCount: successCount, skipCount: skipCount,
                    successNotes: successNotes, skipNotes: skipNotes, missingLibs: missingLibs
                });
                if (window.showToast) window.showToast(_sum.msg, _sum.isError, _sum.duration);
                else alert(_sum.msg);
            }
            /**
             * 【2026-10-03 用户报「提示前后矛盾 + 停留太长」】导入完成提示的拼装（**纯函数**，模块作用域便于套件断言）：
             *   · 「已导入文件的处理说明」单列一节（已清理页眉页脚 / 识别到表格 / 已去水印 —— 这些是**成功**
             *     文件的处理记录），**不再**混进「未导入的文件及原因」（原来两者混用一个数组 ⇒ 弹窗出现
             *     "导入完成：成功 1 个，跳过 0 个"却又把该文件列在「未导入的文件及原因」下的自相矛盾）；
             *   · 停留时长：正常完成 **2 秒**（用户要求），只有**真跳过/失败/组件缺库**时才延长到 8 秒。
             */
            function buildRuleImportSummary(opt) {
                opt = opt || {};
                var sc = opt.successCount || 0, kc = opt.skipCount || 0;
                var sN = opt.successNotes || [], kN = opt.skipNotes || [], mL = opt.missingLibs || [];
                var sect = function (arr, head, unit) {
                    if (!arr.length) return '';
                    return '\n\n' + head + '\n· ' + arr.slice(0, 6).join('\n· ') +
                        (arr.length > 6 ? '\n· …等共 ' + arr.length + ' ' + unit : '');
                };
                var msg = (kc === 0 ? '✅ ' : '⚠️ ')
                    + '导入完成：成功 ' + sc + ' 个，跳过 ' + kc + ' 个' + (kN.length ? '（原因见下）' : '')
                    + sect(sN, '已导入文件的处理说明：', '条')
                    + sect(kN, '未导入的文件及原因：', '个')
                    + (mL.length ? '\n\n以下类型的解析组件未能联网加载，相关文件已跳过：' + mL.join('、') +
                        '\n（联网成功加载一次后会自动缓存，之后可离线使用）' : '');
                var bad = (mL.length > 0) || (kc > 0) || (kN.length > 0);
                return { msg: msg, isError: bad, duration: bad ? 8000 : 2000 };
            }
            window.__ruleImportSummary = buildRuleImportSummary;   // 供套件断言

            window.doExport = async function(format, forceAll) {
                // 用 requireLib：直接 await loadScript 会在离线时抛错，
                // 使下面 1054 行写好的「自动降级为 JSON 导出」兜底永远走不到
                await window.requireLib(LIB_JSZIP, { feature: 'ZIP 导出', silent: true });
                // 【2026-09-21】forceAll：从「设置 → 数据」导出时必须**导出全部** ——
                //   该下拉框在隐藏的 rule-exportModal 里，用户看不见却会沿用上一次模块内的筛选，
                //   出现"我在设置里点了导出，结果只导出了某个专业"的困惑。
                const selectedTrade = forceAll ? '' : (document.getElementById('rule-exportTrade')?.value);
                let exportRules = rules;
                if (selectedTrade && selectedTrade !== '') exportRules = rules.filter(r => r.trade === selectedTrade);
                if (exportRules.length === 0) { alert('所选专业暂无规章'); return; }
                
                if (format === 'zip') {
                    // 检查JSZip是否可用
                    if (typeof JSZip === 'undefined') {
                        alert('JSZip 库未加载（可能网络问题），将自动使用 JSON 格式导出。\n\n提示：如需包含图片的完整备份，请确保网络正常后重试。');
                        format = 'json';
                    } else {
                        // ZIP导出（包含图片）
                        await exportToZipWithSelection(selectedTrade, exportRules);
                        closeModal('rule-exportModal');
                        return;
                    }
                }
                // JSON导出：只保留必要字段（searchText导入时重算，不导出）
                const exportData = exportRules.map(r => ({
                    trade: r.trade,
                    title: r.title,
                    content: r.content,
                    contentHtml: r.contentHtml || '',
                    imageIds: r.imageIds || []
                }));
                const dataStr = JSON.stringify(exportData, null, 2);
                const blob = new Blob([dataStr], { type: 'application/json' });
                const filename = selectedTrade ? '铁路规章_' + selectedTrade + '_' + window.localDateStr() + '.json' : '铁路规章_全部_' + window.localDateStr() + '.json';
                downloadBlob(blob, filename);
                closeModal('rule-exportModal');
            }

            // 根据选择导出ZIP（支持按专业筛选）
            window.exportToZipWithSelection = async function(selectedTrade, exportRules) {
                if (!(await window.requireLib(LIB_JSZIP, { feature: 'ZIP 导出' }))) return;
                if (exportRules.length === 0) { alert('暂无规章可导出'); return; }
                if (typeof JSZip === 'undefined') { alert('JSZip 库未加载，请检查网络连接'); return; }
                
                try {
                    const zip = new JSZip();
                    const exportData = [];
                    
                    // 收集所有图片ID
                    const allImageIds = new Set();
                    exportRules.forEach(rule => {
                        if (rule.imageIds && rule.imageIds.length > 0) {
                            rule.imageIds.forEach(id => allImageIds.add(id));
                        }
                    });
                    
                    // 导出图片到ZIP
                    if (allImageIds.size > 0) {
                        const database = await initRuleDB();
                        const tx = database.transaction([IMAGE_STORE_NAME], 'readonly');
                        const store = tx.objectStore(IMAGE_STORE_NAME);
                        
                        for (const imgId of allImageIds) {
                            try {
                                const blob = await getImageFromDB(imgId);
                                if (blob) {
                                    const ext = blob.type === 'image/png' ? 'png' : 
                                               blob.type === 'image/gif' ? 'gif' : 'jpg';
                                    zip.file(`images/${imgId}.${ext}`, blob);
                                }
                            } catch (e) {
                                console.error('导出图片失败:', imgId, e);
                            }
                        }
                    }
                    
                    // 准备导出数据（searchText导入时重算，不导出）
                    exportRules.forEach(rule => {
                        exportData.push({
                            trade: rule.trade,
                            title: rule.title,
                            content: rule.content,
                            contentHtml: rule.contentHtml || '',
                            imageIds: rule.imageIds || []
                        });
                    });
                    
                    // 添加数据文件
                    zip.file('rules.json', JSON.stringify(exportData, null, 2));
                    zip.file('manifest.json', JSON.stringify({
                        version: 2,
                        exportDate: new Date().toISOString(),
                        count: exportRules.length,
                        hasImages: allImageIds.size > 0
                    }, null, 2));
                    
                    // 生成ZIP文件（显式设置MIME类型，兼容华为等浏览器）
                    const zipBlob = await zip.generateAsync({ type: 'blob' });
                    const typedZipBlob = new Blob([zipBlob], { type: 'application/zip' });
                    const tradeSuffix = selectedTrade ? '_' + selectedTrade : '_全部';
                    downloadBlob(typedZipBlob, '铁路规章' + tradeSuffix + '_' + window.localDateStr() + '.zip');
                    
                    // 【2026-09-21】成功提示从**阻塞 alert** 改为进度条收尾 + toast：
                    //   实测中这条 alert 会把页面 JS 挂住（无头/自动化下后续操作全部超时；手机上也会打断用户操作）。
                    var okMsg = '导出成功！共 ' + exportRules.length + ' 条规章' + (allImageIds.size > 0 ? '，包含 ' + allImageIds.size + ' 张图片' : '')
                        + (/Mobi|Android/i.test(navigator.userAgent) ? '（手机端请点屏幕底部「📥 下载」完成保存）' : '');
                    try { window.finishProgress('✅ ' + okMsg); } catch (e) {}
                    if (window.showToast) window.showToast('✅ ' + okMsg, false, 6000); else alert(okMsg);
                } catch (err) {
                    console.error('ZIP导出失败:', err);
                    try { window.hideProgress(); } catch (e) {}
                    if (window.showToast) window.showToast('导出失败：' + err.message, true, 9000); else alert('导出失败: ' + err.message);
                }
            };

            // 【2026-10-04 用户口径】单条规章导出：由「HTML 单文件（含图片）」改为 **DOCX（含图片）**。
            //   复用资料库 / 历史报告那套导出链路（用户指定）：
            //     window.wrExportHtmlToDocx(html, name)  →  smart-writer.js 的 exportDocxFromHtml
            //       → ① RGDocx 真·OOXML（同一排版偏好 `wr_docx_style`：公文格式/通用排版；images:true 内嵌图片）
            //       → ② html-docx-js（altChunk）→ ③ HTML 版 .doc 离线兜底
            //   提示、"另存为"行为、失败降级都与资料库导出一致（不再自己拼 HTML 文件、不再额外 alert）。
            //   图片：依旧逐张从 IndexedDB 取原图 → base64 内联（<img src="data:...">），走 A 通道时会真正嵌进 docx；
            //   若降级到 ②/③ 通道，Word 对 data: 图片支持有限（已知局限，与资料库导出的行为相同）。
            window.ruleExportSingleDocx = async function(idx) {
                var rule = rules[idx];
                if (!rule) { alert('未找到该规章'); return; }
                try {
                    if (typeof window.wrExportHtmlToDocx !== 'function') {
                        alert('DOCX 导出组件未就绪（写作模块未加载），请刷新页面后重试');
                        return;
                    }
                    // 【2026-10-07 修复·与 DOCX 套件联动发现】先把图片读成 data: URI 存表（不直接拼 HTML）：
                    //   原实现把真图 base64 **统一追加到文末**，导致两个用户可见问题 ——
                    //   ① contentHtml 里的占位是 `<img src="" data-img-id="img_x">`，导出引擎
                    //      loadImageInfo('') 返回 null ⇒ 落成文字「［图片（原图无法获取，可能受跨域限制）］」，
                    //      用户导出的 Word 里**每张图位置凭空多出这行**；
                    //   ② 图片与正文的相对位置全部丢失（全跑到文末）。
                    //   现在改为**就地替换**：把 html 里的 data-img-id 换成 data: URI（下文），
                    //   未能就地替换的才兜底追加，保证既不丢图也不留噪声。
                    var _imgMap = {};
                    if (rule.imageIds && rule.imageIds.length) {
                        for (var i = 0; i < rule.imageIds.length; i++) {
                            try {
                                var blob = await getImageFromDB(rule.imageIds[i]);
                                if (blob) {
                                    var b64 = await new Promise(function(res) {
                                        var r = new FileReader();
                                        r.onload = function() { res(r.result); };
                                        r.onerror = function() { res(''); };
                                        r.readAsDataURL(blob);
                                    });
                                    if (b64) _imgMap[rule.imageIds[i]] = b64;
                                }
                            } catch (e) {}
                        }
                    }
                    var title = rule.title || '规章';
                    var safeTitle = title.replace(/[\\/:*?"<>|]/g, '_');
                    // 【2026-10-05 修正·规范性】**优先用导入时还原好的 contentHtml**：
                    //   它带 imp-title / imp-clause（粗体条款）/ imp-table（表格）等层级信息，而引擎
                    //   （docx-export.js 的 classHeadingLevel）已能识别这些 class ⇒ "一、""（一）"能拿到
                    //   GB/T 9704 要求的**黑体 / 楷体_GB2312**，表格也原样带出。
                    //   原来这里自己按字段拼 h1+p，等于把层级全压平成正文 ⇒ 导出不符合规范文格式。
                    //   没有 contentHtml 的旧数据/手工新增条目，才回退到按字段拼装。
                    var _hasHtml = !!(rule.contentHtml && /<[a-z][^>]*>/i.test(String(rule.contentHtml)));
                    var html;
                    if (_hasHtml) {
                        html = String(rule.contentHtml);
                        if (rule.trade) html += '<p>（专业：' + escapeHtml(rule.trade) + '）</p>';
                    } else {
                        html = '<h1>' + escapeHtml(title) + '</h1>'
                            + '<p>专业：' + escapeHtml(rule.trade || '') + '</p>'
                            + '<p>' + escapeHtml(rule.content || '').replace(/\r?\n/g, '<br>') + '</p>';
                    }
                    // 图片：**原地还原**（把占位 <img src="" data-img-id="X"> 换成真 data: URI），
                    //   这样导出件里图片就在它原本的位置上，不再统一堆到文末、也不再留"原图无法获取"文字。
                    var _used = {};
                    var _esc = function (s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); };
                    Object.keys(_imgMap).forEach(function (id) {
                        var _pat = 'data-img-id="' + _esc(id) + '"';
                        if (html.indexOf(_pat) === -1) return;   // 正文里没有这张图的占位（老数据）⇒ 走下方兜底
                        html = html.replace(new RegExp('<img[^>]*' + _pat + '[^>]*>', 'g'),
                            '<img src="' + _imgMap[id] + '" alt="规章附图">');
                        _used[id] = 1;
                    });
                    // 兜底：没能在正文里找到占位的图片（老数据 / contentHtml 缺失）仍追加到文末，保证不丢图
                    Object.keys(_imgMap).forEach(function (id) {
                        if (!_used[id]) html += '<p><img src="' + _imgMap[id] + '" alt="规章附图"></p>';
                    });
                    await window.wrExportHtmlToDocx(html, safeTitle);
                } catch (e) { alert('导出失败：' + e.message); }
            };
            // 旧名兼容（历史调用点/外部脚本仍可能用旧名；行为已按用户口径改为导出 DOCX）
            window.ruleExportSingleHtml = window.ruleExportSingleDocx;

            // ========== ZIP 导出/导入功能 ==========
            window.exportToZip = async function() {
                if (rules.length === 0) { alert('暂无规章可导出'); return; }
                // 【2026-09-21】ZIP 路径必须**按需加载** JSZip：本仓库 vendor 库一律懒加载，
                //   旧代码只判 `typeof JSZip === 'undefined'` 就报"库未加载" →
                //   **本次会话没跑过 ZIP 导出时，ZIP 导出 100% 失败**（与用户操作、文件都无关）。
                if (!(await window.requireLib(LIB_JSZIP, { feature: '规章 ZIP 导出', silent: true })) || typeof JSZip === 'undefined') {
                    if (window.showToast) window.showToast('ZIP 组件需联网加载一次，本次可改用 JSON 导出', true, 9000); else alert('JSZip 库未加载，请检查网络连接');
                    return;
                }
                
                try {
                    const zip = new JSZip();
                    const exportData = [];
                    
                    // 收集所有图片ID
                    const allImageIds = new Set();
                    rules.forEach(rule => {
                        if (rule.imageIds && rule.imageIds.length > 0) {
                            rule.imageIds.forEach(id => allImageIds.add(id));
                        }
                    });
                    
                    // 导出图片到ZIP
                    if (allImageIds.size > 0) {
                        const database = await initRuleDB();
                        const tx = database.transaction([IMAGE_STORE_NAME], 'readonly');
                        const store = tx.objectStore(IMAGE_STORE_NAME);
                        
                        for (const imgId of allImageIds) {
                            try {
                                const blob = await getImageFromDB(imgId);
                                if (blob) {
                                    // 获取文件扩展名
                                    const ext = blob.type === 'image/png' ? 'png' : 
                                               blob.type === 'image/gif' ? 'gif' : 'jpg';
                                    zip.file(`images/${imgId}.${ext}`, blob);
                                }
                            } catch (e) {
                                console.error('导出图片失败:', imgId, e);
                            }
                        }
                    }
                    
                    // 准备导出数据（移除Blob，保留imageIds引用；searchText导入时重算，不导出）
                    rules.forEach(rule => {
                        exportData.push({
                            trade: rule.trade,
                            title: rule.title,
                            content: rule.content,
                            contentHtml: rule.contentHtml || '',
                            imageIds: rule.imageIds || []
                        });
                    });
                    
                    // 添加数据文件
                    zip.file('rules.json', JSON.stringify(exportData, null, 2));
                    zip.file('manifest.json', JSON.stringify({
                        version: 2,
                        exportDate: new Date().toISOString(),
                        count: rules.length,
                        hasImages: allImageIds.size > 0
                    }, null, 2));
                    
                    // 生成ZIP文件（显式设置MIME类型，兼容华为等浏览器）
                    const zipBlob = await zip.generateAsync({ type: 'blob' });
                    const typedZipBlob = new Blob([zipBlob], { type: 'application/zip' });
                    downloadBlob(typedZipBlob, '铁路规章备份_' + window.localDateStr() + '.zip');
                    
                    var mobileMsg = /Mobi|Android/i.test(navigator.userAgent) ? '（手机端请点屏幕底部「📥 下载」完成保存）' : '';
                    // 【2026-09-21】同前：阻塞 alert → toast
                    var okMsg2 = '导出成功！共 ' + rules.length + ' 条规章' + (allImageIds.size > 0 ? '，包含 ' + allImageIds.size + ' 张图片' : '') + mobileMsg;
                    try { window.finishProgress('✅ ' + okMsg2); } catch (e) {}
                    if (window.showToast) window.showToast('✅ ' + okMsg2, false, 6000); else alert(okMsg2);
                } catch (err) {
                    console.error('ZIP导出失败:', err);
                    try { window.hideProgress(); } catch (e) {}
                    if (window.showToast) window.showToast('导出失败：' + err.message, true, 9000); else alert('导出失败: ' + err.message);
                }
            };

            window.importFromZip = async function(file) {
                if (!file) return;
                // 【2026-09-21】原实现只判空 JSZip 就报"库未加载" → 从「设置 → 规章制度 → 导入」选 .zip 时，
                //   只要本会话还没加载过 JSZip 就**必然失败**（实测复现）。改为懒加载。
                if (!(await window.requireLib(LIB_JSZIP, { feature: '规章 ZIP 导入', silent: true })) || typeof JSZip === 'undefined') {
                    if (window.showToast) window.showToast('ZIP 组件需联网加载一次，请联网后重试（或改用 JSON 导入）', true, 9000); else alert('JSZip 库未加载，请检查网络连接');
                    return;
                }
                
                try {
                    const zip = await JSZip.loadAsync(file);
                    
                    // 读取manifest
                    let manifest = { version: 1 };
                    if (zip.file('manifest.json')) {
                        const manifestContent = await zip.file('manifest.json').async('string');
                        manifest = JSON.parse(manifestContent);
                    }
                    
                    // 读取rules.json
                    if (!zip.file('rules.json')) {
                        throw new Error('ZIP文件中缺少 rules.json');
                    }
                    
                    const rulesContent = await zip.file('rules.json').async('string');
                    const importRules = JSON.parse(rulesContent);
                    
                    if (!Array.isArray(importRules)) {
                        throw new Error('导入的数据格式不正确');
                    }
                    
                    let successCount = 0;
                    let skipCount = 0;
                    let imageCount = 0;
                    
                    // 导入图片
                    const imageFiles = Object.keys(zip.files).filter(name => name.startsWith('images/'));
                    for (const imgPath of imageFiles) {
                        try {
                            const imgId = imgPath.replace('images/', '').replace(/\.(jpg|jpeg|png|gif)$/i, '');
                            const blob = await zip.file(imgPath).async('blob');
                            await saveImageToDB(imgId, blob);
                            imageCount++;
                        } catch (e) {
                            console.error('导入图片失败:', imgPath, e);
                        }
                    }
                    
                    // 导入规章
                    // 【2026-09-21】进度 + 互斥：含图 ZIP 的写库可能十几秒（原实现既无进度也无 isProcessing 保护，可重复触发）
                    isProcessing = true; _procStartAt = Date.now();
                    for (let _zi = 0; _zi < importRules.length; _zi++) {
                        const item = importRules[_zi];
                        if (_zi % 10 === 0) { try { window.showProgress(Math.round(_zi / Math.max(1, importRules.length) * 80), '正在写入规章 ' + (_zi + 1) + '/' + importRules.length + '…'); } catch (e) {} }
                        if (item.title && (item.content || item.contentHtml)) {
                            const dupIdx = rules.findIndex(r => 
                                r.title.toLowerCase().trim() === item.title.toLowerCase().trim() && 
                                r.trade === (item.trade || '通用')
                            );
                            const hasRealHtml = item.contentHtml && /<[a-z][\s\S]*>/i.test(item.contentHtml);
                            const ruleData = {
                                trade: item.trade || '通用',
                                title: item.title,
                                content: item.content || stripHtml(item.contentHtml),
                                contentHtml: hasRealHtml ? _ruleSanitizeForStore(item.contentHtml) : '',
                                imageIds: item.imageIds || []
                            };
                            if (dupIdx !== -1) {
                                // 删除旧图片
                                const oldRule = rules[dupIdx];
                                if (oldRule.imageIds && oldRule.imageIds.length > 0) {
                                    await deleteImagesFromDB(oldRule.imageIds);
                                }
                                rules[dupIdx] = ruleData;
                            } else {
                                rules.push(ruleData);
                            }
                            successCount++;
                        } else {
                            skipCount++;
                        }
                    }
                    
                    isProcessing = false;   // ZIP 导入循环结束：释放互斥锁（异常路径由 3 分钟自动解锁兜底）
                    if (!(await saveToStorage({ silent: true }))) {
                        try { await loadRulesFromDB(); } catch (e) { console.warn('[rule] 回滚失败:', e && e.message); }
                        refreshTradeSelect();
                        updateTotalBadge();
                        renderResults();
                        try { window.hideProgress(); } catch (e) {}
                        var _zr = '备份内容未能写入本地存储（通常是存储空间不足），已回滚本次导入。\n原有规章不受影响，请清理后再试。';
                        if (window.showToast) window.showToast(_zr, true, 12000); else alert(_zr);
                        return;
                    }
                    refreshTradeSelect();
                    updateTotalBadge();
                    renderResults();
                    // 【2026-10-05 逻辑统一】ZIP 导入同样要走统一收尾（此前这条路径**既没失效索引、也没刷统计**）
                    try { window.afterDataWrite({ kb: 'rules' }); } catch (e) {}

                    // 【2026-09-21】ZIP 导入原为**全无进度 + 阻塞 alert**（含图备份可能要几秒~十几秒，用户以为卡死）
                    var _zipMsg = '导入完成：成功 ' + successCount + ' 条' +
                          (imageCount > 0 ? '，图片 ' + imageCount + ' 张' : '') +
                          (skipCount > 0 ? '，跳过 ' + skipCount + ' 条' : '');
                    try { window.finishProgress('✅ ' + _zipMsg); } catch (e) {}
                    if (window.showToast) window.showToast('✅ ' + _zipMsg, false, 6000); else alert(_zipMsg);
                } catch (err) {
                    console.error('ZIP导入失败:', err);
                    try { window.hideProgress(); } catch (e) {}
                    if (window.showToast) window.showToast('ZIP 导入失败：' + err.message, true, 9000); else alert('导入失败: ' + err.message);
                }
            };
            window.showCatalog = function() {
                renderCatalog();
                openModal('rule-catalogModal');
            };
            function renderCatalog() {
                const filterText = document.getElementById('rule-catalogFilter')?.value.toLowerCase() || '';
                const filterTrade = document.getElementById('rule-catalogTradeFilter')?.value || '';
                let filtered = rules;
                if (filterText) filtered = filtered.filter(r => r.title.toLowerCase().includes(filterText));
                if (filterTrade) filtered = filtered.filter(r => r.trade === filterTrade);
                const stats = document.getElementById('rule-catalogStats');
                if (stats) stats.textContent = '共 ' + filtered.length + ' 条 / 总计 ' + rules.length + ' 条';
                const list = document.getElementById('rule-catalogList');
                if (!list) return;
                if (filtered.length === 0) { list.innerHTML = '<div class="empty-state">暂无规章</div>'; return; }
                let html = '';
                filtered.forEach((rule, idx) => {
                    const originalIdx = rules.indexOf(rule);
                    html += '<div class="catalog-item"><div class="catalog-info"><div class="catalog-title" title="' + escapeHtml(rule.title) + '">' + escapeHtml(rule.title) + '</div><div class="catalog-meta"><span class="catalog-trade">' + escapeHtml(rule.trade) + '</span><span>' + rule.content.length + '字</span></div></div><div class="catalog-actions"><button class="btn btn-info btn-small" onclick="ruleViewFullText(' + originalIdx + ')">查看</button><button class="btn btn-success btn-small" onclick="editRule(' + originalIdx + ')">编辑</button><button class="btn btn-danger btn-small" onclick="deleteRule(' + originalIdx + ')">删除</button></div></div>';
                });
                list.innerHTML = html;
            }
            window.editRule = function(idx) {
                const rule = rules[idx];
                currentEditIndex = idx;
                document.getElementById('rule-editTitle').value = rule.title;
                const editSelect = document.getElementById('rule-editTrade');
                editSelect.innerHTML = '<option value="">-- 选择专业 --</option>';
                const tradesSet = new Set(); rules.forEach(r => tradesSet.add(r.trade));
                Array.from(tradesSet).sort((a, b) => a.localeCompare(b, 'zh')).forEach(trade => {
                    const option = document.createElement('option'); option.value = trade; option.textContent = trade; editSelect.appendChild(option);
                });
                if (tradesSet.has(rule.trade)) editSelect.value = rule.trade; else editSelect.value = '';
                document.getElementById('rule-editNewTrade').value = '';
                openModal('rule-editModal');
            };
            window.saveRuleEdit = async function() {
                const title = document.getElementById('rule-editTitle')?.value.trim();
                let trade = document.getElementById('rule-editTrade')?.value;
                const newTrade = document.getElementById('rule-editNewTrade')?.value.trim();
                if (newTrade) trade = newTrade;
                if (!title) { alert('请输入规章标题'); return; }
                if (!trade) { alert('请选择或输入专业'); return; }
                const dupIdx = rules.findIndex((r, i) => r.title.toLowerCase().trim() === title.toLowerCase() && i !== currentEditIndex);
                if (dupIdx !== -1) { alert('已存在相同标题的规章'); return; }
                rules[currentEditIndex].title = title;
                rules[currentEditIndex].trade = trade;
                await saveToStorage(); refreshTradeSelect(); updateTotalBadge(); renderCatalog(); renderResults(); closeModal('rule-editModal'); alert('修改保存成功！');
            };
            window.deleteRule = async function(idx) {
                if (confirm('确定要删除规章"' + rules[idx].title + '"吗？')) {
                    const rule = rules[idx];
                    // 清理关联的图片
                    if (rule.imageIds && rule.imageIds.length > 0) {
                        try {
                            await deleteImagesFromDB(rule.imageIds);
                        } catch (e) {
                            console.error('删除图片失败:', e);
                        }
                    }
                    rules.splice(idx, 1);
                    await saveToStorage(); refreshTradeSelect(); updateTotalBadge(); renderCatalog(); renderResults();
                }
            };
            window.clearAllRules = async function() {
                if (confirm('确定要清空所有规章吗？此操作不可恢复！')) {
                    rules = []; await saveToStorage(); refreshTradeSelect(); updateTotalBadge(); renderResults(); closeModal('rule-catalogModal');
                }
            };

            // 暴露 rules 给其他模块调用（如检查手册导入）
            window.getRulesData = function() { return rules; };

            // 模块对象暴露（供智能体/统一增强模块调用，避免外部直接依赖内部变量 rules）
            if (!window.RuleModule) {
                window.RuleModule = {
                    getData: function() { return (typeof window.getRulesData === 'function') ? window.getRulesData() : []; },
                    search: function(kw) {
                        kw = String(kw || '').trim().toLowerCase();
                        var all = (typeof window.getRulesData === 'function') ? window.getRulesData() : [];
                        if (!kw) return all;
                        return all.filter(function(r) {
                            return ((r.title || '') + ' ' + (r.trade || '') + ' ' + (r.content || '')).toLowerCase().indexOf(kw) !== -1;
                        });
                    }
                };
            }

            // 匹配模式固定为AND（全部包含）
            function getMatchMode() {
                return 'and';
            }

            window.renderResults = function() {
                try {
                const trade = document.getElementById('rule-tradeSelect')?.value || '';
                const keywords = getKeywords();
                const matchMode = getMatchMode();
                const resultsList = document.getElementById('rule-resultsList');
                const resultCount = document.getElementById('rule-resultCount');
                const header = document.querySelector('#panel-rule .results-header');
                if (!resultsList) return;

                // 如果没有任何规章数据，显示提示
                if (rules.length === 0) {
                    resultsList.innerHTML = '<div class="empty-state"><div class="empty-state-icon">📋</div><p>暂无规章数据，请先导入规章</p></div>';
                    resultsList.style.display = 'block';
                    if (resultCount) resultCount.textContent = '0 项';
                    if (header) header.style.display = 'flex';
                    return;
                }

                if (keywords.length === 0) {
                    resultsList.style.display = 'none';
                    resultsList.innerHTML = '';
                    if (header) header.style.display = 'none';
                    if (resultCount) resultCount.textContent = '0 项';
                    return;
                }

                resultsList.style.display = 'block';
                if (header) header.style.display = 'flex';

                let filtered = rules;
                if (trade !== '') filtered = filtered.filter(r => r.trade === trade);

                let results = [];
                if (keywords.length > 0) {
                    filtered.forEach((rule, ruleIdx) => {
                        const content = rule.content;
                        if (ruleSearchMode === 'full') {
                            const lowerContent = content.toLowerCase();
                            
                            // AND模式：必须包含所有关键词
                            const isMatch = keywords.every(k => lowerContent.includes(k.toLowerCase()));
                            const matchScore = isMatch ? keywords.length : 0;
                            
                            if (isMatch) {
                                const snippet = content.length > 200 ? content.substring(0, 200) + '…' : content;
                                results.push({ rule, snippetHtml: `<p>${escapeHtml(snippet)}</p>`, matchCount: matchScore, matchScore });
                            }
                        } else {
                            try {
                                const snippetHtml = generateRuleSnippet(rule, keywords, ruleIdx, matchMode);
                                if (snippetHtml) {
                                    // 统计「命中段落」而不是裸 <p>：只有短段落分支输出裸 <p>，
                                    // 长/中等段落输出的是 <p class="rule-match-para" ...>，
                                    // 用 /<p>/g 统计会让绝大多数规章恒为 0 段，连带排序次级键失效。
                                    const matchCount = (snippetHtml.match(/class="rule-match-para"/g) || []).length;
                                    // 计算匹配分数（AND模式下按命中关键词数量排序）
                                    const matchScore = calculateMatchScore(rule, keywords, matchMode);
                                    results.push({ rule, snippetHtml, matchCount, matchScore });
                                }
                            } catch(snippetErr) {
                                console.error('[renderResults] generateRuleSnippet报错:', rule.title, snippetErr);
                            }
                        }
                    });
                }

                // 排序：先按匹配分数降序，再按匹配段落数降序
                results.sort((a, b) => {
                    if (b.matchScore !== a.matchScore) return b.matchScore - a.matchScore;
                    return b.matchCount - a.matchCount;
                });
                ruleAllResults = results;
                ruleTotalPages = Math.ceil(results.length / rulePageSize) || 1;
                rulePage = 1;
                displayRulePage();
                if (resultCount) resultCount.textContent = results.length + ' 项';
                } catch(renderErr) {
                    console.error('[renderResults] 整体报错:', renderErr);
                    const resultsList = document.getElementById('rule-resultsList');
                    if (resultsList) resultsList.innerHTML = '<div style="color:red;padding:16px;">搜索出错: ' + escapeHtml(renderErr.message) + '</div>';
                }
            };

            // 计算匹配分数
            function calculateMatchScore(rule, keywords, matchMode) {
                const text = rule.searchText || rule.content || '';
                // 使用规范化后的文本进行匹配
                const normalizedText = normalizeText(text).toLowerCase();
                const normalizedKeywords = keywords.map(k => normalizeText(k).toLowerCase());
                
                // AND模式：全部匹配得满分
                const allMatch = normalizedKeywords.every(k => normalizedText.includes(k));
                return allMatch ? keywords.length : 0;
            }

            function displayRulePage() {
                const resultsList = document.getElementById('rule-resultsList');
                if (!resultsList) return;
                const start = (rulePage - 1) * rulePageSize;
                const pageResults = ruleAllResults.slice(start, start + rulePageSize);

                if (pageResults.length === 0) {
                    resultsList.innerHTML = '<div class="empty-state"><div class="empty-state-icon">📋</div><p>未找到匹配结果</p></div>';
                    return;
                }

                // 获取当前搜索状态
                const keywords = getKeywords();
                const matchMode = getMatchMode();
                const hasKeywords = keywords.length > 0;

                // 获取原始关键词用于显示
                const rawKeywords = getRawKeywords();
                
                let html = '<div class="result-list">';
                
                // 添加搜索提示
                if (hasKeywords) {
                    html += `<div style="margin-bottom:16px;padding:12px 16px;background:#f0f9ff;border:1px solid #bae6fd;border-radius:8px;font-size:0.9rem;color:#0369a1;">
                        <strong>🔍 搜索条件：</strong>
                        <span style="margin-left:8px;padding:4px 10px;background:#fff;border-radius:4px;border:1px solid #7dd3fc;">全部包含</span>
                        <span style="margin-left:8px;">关键词：${rawKeywords.map(kw => `<span style="padding:2px 8px;background:#e0f2fe;border-radius:4px;margin-right:4px;">${escapeHtml(kw)}</span>`).join('')}</span>
                    </div>`;
                }
                
                pageResults.forEach(item => {
                    // ===== 修改点：从原始规章数组获取绝对索引（不受专业过滤影响）=====
                    const allRules = typeof window.getRulesData === 'function' ? window.getRulesData() : [];
                    const absIdx = allRules.indexOf(item.rule);
                    
                    const firstParaText = _getRuleFirstMatchPara(item.rule);
                    if (firstParaText !== null && absIdx !== -1) {
                        _ruleFirstMatchPara[absIdx] = firstParaText;
                    } else if (absIdx !== -1) {
                        delete _ruleFirstMatchPara[absIdx];
                    }
                    html += '<div class="rule-card-item">';
                    // 文件名改为可点击链接
                    html += '<div class="rule-title" style="cursor:pointer;display:flex;align-items:center;justify-content:space-between;gap:8px;" onclick="ruleViewFullText(' + absIdx + ')">';
                    html += '<span style="flex:1;word-break:break-all;white-space:normal;color:var(--info);text-decoration:underline;text-underline-offset:3px;" title="' + escapeHtml(item.rule.title) + '">' + escapeHtml(item.rule.title) + '</span>';
                    html += '<button class="btn btn-info btn-small" style="flex-shrink:0;" onclick="event.stopPropagation();ruleViewFullText(' + absIdx + ')">📄 查看全文</button>';
                    html += '</div>';
                    html += '<span class="rule-trade">' + escapeHtml(item.rule.trade) + '</span>';
                    
                    // 添加匹配信息提示
                    if (hasKeywords) {
                        const matchInfoText = `✓ 匹配 ${item.matchCount} 个段落`;
                        html += `<div class="rule-match-info" style="font-size:0.8rem;color:#64748b;margin-bottom:8px;padding:4px 8px;background:#f1f5f9;border-radius:4px;display:inline-block;">${matchInfoText}</div>`;
                    }
                    
                    html += '<div class="rule-snippet">' + item.snippetHtml + '</div>';
                    html += '</div>';
                });
                html += '</div>';

                html += `<div class="pagination" style="margin-top:16px; display:flex; gap:12px; justify-content:center; align-items:center;">
                    <button class="btn btn-secondary" ${rulePage === 1 ? 'disabled' : ''} onclick="changeRulePage(${rulePage - 1})">上一页</button>
                    <span>第 ${rulePage} 页 / 共 ${ruleTotalPages} 页</span>
                    <button class="btn btn-secondary" ${rulePage === ruleTotalPages ? 'disabled' : ''} onclick="changeRulePage(${rulePage + 1})">下一页</button>
                </div>`;

                resultsList.innerHTML = html;
            }

            window.changeRulePage = function(page) {
                if (page < 1 || page > ruleTotalPages) return;
                rulePage = page;
                displayRulePage();
            };

            // 存储每条搜索结果对应的首个命中段落文本（key: rule绝对索引）
            const _ruleFirstMatchPara = {};

            // 根据当前关键词，找规章中第一个命中的段落原文
            function _getRuleFirstMatchPara(rule) {
                const keywords = getKeywords().filter(k => k.trim() !== '');
                if (keywords.length === 0) return null;
                const matchMode = getMatchMode();
                const paragraphs = smartSplitParagraphs(rule.content);
                const lowerKws = keywords.map(k => k.toLowerCase());
                
                for (let i = 0; i < paragraphs.length; i++) {
                    const lp = paragraphs[i].toLowerCase();
                    // AND模式：第一个包含所有关键词的段落
                    if (lowerKws.every(kw => lp.includes(kw))) return paragraphs[i];
                }
                return null;
            }

            // ===== 规章全文查看（带关键词高亮 & 上下跳转） =====
            let _fvHighlights = []; // 所有高亮 mark 元素
            let _fvCurHl = -1;      // 当前聚焦索引

            // 关键词颜色组（背景/文字），用于顶部标签
            const KW_COLORS = [
                { bg: '#fef3c7', text: '#c05621', border: '#f6e05e' },
                { bg: '#e6f6ff', text: '#1a6eb5', border: '#90cdf4' },
                { bg: '#f0fff4', text: '#276749', border: '#9ae6b4' },
                { bg: '#fde8f8', text: '#805ad5', border: '#d6bcfa' }
            ];

            window.ruleViewFullText = async function(idx) {
                const rule = rules[idx];
                window.__ruleFvIdx = idx;
                if (!rule) return;
                const keywords = getKeywords().filter(k => k.trim() !== '');

                // 填入标题与专业
                document.getElementById('rule-fullViewTitle').textContent = rule.title;
                document.getElementById('rule-fullViewTrade').textContent = rule.trade;
                const contentLength = (rule.searchText || rule.content || '').length;
                document.getElementById('rule-fullViewLength').textContent = contentLength + ' 字';

                const bodyEl = document.getElementById('rule-fullContentBody');
                _fvHighlights = [];
                _fvCurHl = -1;

                // 获取要显示的内容：优先使用 contentHtml，否则使用 content
                // 判断是否有真正的HTML内容（排除纯文本被误存为contentHtml的情况）
                const hasHtml = rule.contentHtml && /<[a-z][\s\S]*>/i.test(rule.contentHtml);
                const contentToShow = hasHtml ? rule.contentHtml : (rule.content || '');

                if (keywords.length > 0) {
                    // ---------- 富文本模式（有 contentHtml）----------
                    if (hasHtml) {
                        // 1. 渲染 HTML 并替换图片占位符
                        let html = renderRuleHtml(contentToShow);
                        
                        // 2. 注入关键词高亮（在文本节点中）
                        const tempDiv = document.createElement('div');
                        tempDiv.innerHTML = html;
                        
                        function highlightNode(node, kwIdx) {
                            if (node.nodeType === Node.TEXT_NODE) {
                                const text = node.textContent;
                                const kw = keywords[kwIdx];
                                // 与同文件「纯文本模式」路径统一的约定：关键词与文本都先转义，再在转义后的文本上匹配
                                const kwEsc = escapeHtml(kw);
                                const escaped = escapeHtml(text);
                                const regex = new RegExp('(' + escapeRegExp(kwEsc) + ')', 'gi');
                                if (regex.test(escaped)) {
                                    // ★ 安全且快：文本先转义 → 正文里的 &lt;img onerror=…&gt; 不会被二次解析成真标签
                                    //   （此处原先是把 node.textContent 直接回写 innerHTML，构成存储型 XSS）；
                                    //   高亮用【一次 innerHTML】完成，不逐个 createElement —— 后者在关键词命中多时
                                    //   要创建上万个元素并逐次解析 CSS，慢一个量级。
                                    const color = KW_COLORS[kwIdx % KW_COLORS.length];
                                    const span = document.createElement('span');
                                    span.innerHTML = escaped.replace(
                                        regex,
                                        '<mark class="rule-fv-hl" data-kw-idx="' + kwIdx + '" style="background:' + color.bg + ';color:' + color.text + ';font-weight:600;padding:1px 3px;border-radius:3px;border:1px solid ' + color.border + ';">$1</mark>'
                                    );
                                    return span;
                                }
                            } else if (node.nodeType === Node.ELEMENT_NODE && node.childNodes) {
                                const children = Array.from(node.childNodes);
                                children.forEach((child, i) => {
                                    const replaced = highlightNode(child, kwIdx);
                                    if (replaced !== child) {
                                        node.replaceChild(replaced, child);
                                    }
                                });
                            }
                            return node;
                        }
                        
                        // 对每个关键词进行高亮
                        keywords.forEach((kw, kwIdx) => {
                            if (!kw) return;
                            highlightNode(tempDiv, kwIdx);
                        });
                        
                        bodyEl.innerHTML = tempDiv.innerHTML;
                        setupLazyImageObserver(bodyEl);
                        // 富文本模式使用normal，让HTML标签（如<p>）控制换行
                        bodyEl.style.whiteSpace = 'normal';
                        
                        // 收集高亮元素
                        _fvHighlights = Array.from(bodyEl.querySelectorAll('.rule-fv-hl'));
                        _fvCurHl = _fvHighlights.length > 0 ? 0 : -1;
                    } else {
                        // ---------- 纯文本模式（无 contentHtml，使用旧 content）----------
                        // 使用 smartSplitParagraphs 智能分段，兼容旧数据无换行的情况
                        const paragraphs = smartSplitParagraphs(contentToShow);
                        const hlParts = paragraphs.map((para, lineIdx) => {
                            if (!para.trim()) return '<span data-para-index="' + lineIdx + '" data-line="' + lineIdx + '"></span>';
                            let escaped = escapeHtml(para);
                            keywords.forEach((kw, kwIdx) => {
                                if (!kw) return;
                                const color = KW_COLORS[kwIdx % KW_COLORS.length];
                                const regex = new RegExp('(' + escapeRegExp(escapeHtml(kw)) + ')', 'gi');
                                escaped = escaped.replace(regex,
                                    `<mark class="rule-fv-hl" data-kw-idx="${kwIdx}" data-line="${lineIdx}" style="background:${color.bg};color:${color.text};font-weight:600;padding:1px 3px;border-radius:3px;border:1px solid ${color.border};">$1</mark>`
                                );
                            });
                            return '<span data-para-index="' + lineIdx + '" data-line="' + lineIdx + '">' + escaped + '</span>';
                        });
                        bodyEl.innerHTML = hlParts.join('<br>');
                        bodyEl.style.whiteSpace = 'pre-wrap';
                        
                        _fvHighlights = Array.from(bodyEl.querySelectorAll('.rule-fv-hl'));
                        _fvCurHl = _fvHighlights.length > 0 ? 0 : -1;
                    }

                    // ---------- 统计各关键词命中数 ----------
                    const kwHitCount = new Array(keywords.length).fill(0);
                    _fvHighlights.forEach(el => {
                        const ki = parseInt(el.getAttribute('data-kw-idx'));
                        if (!isNaN(ki)) kwHitCount[ki] = (kwHitCount[ki] || 0) + 1;
                    });
                    const totalHits = _fvHighlights.length;

                    // ---------- 顶部提示栏 ----------
                    const hlBar    = document.getElementById('rule-fullViewHlBar');
                    const hlTotal  = document.getElementById('rule-fullViewHlTotal');
                    const hlKwTags = document.getElementById('rule-fullViewHlKwTags');
                    const hlBarText = document.getElementById('rule-fullViewHlBarText');
                    const hlPosText = document.getElementById('rule-fullViewHlPosText');

                    if (totalHits > 0) {
                        hlBar.style.display = 'flex';
                        hlBarText.textContent = '已找到';
                        hlTotal.textContent = totalHits;

                        // 渲染关键词标签（带各自颜色和命中数）
                        let tagsHtml = '';
                        keywords.forEach((kw, ki) => {
                            const c = KW_COLORS[ki % KW_COLORS.length];
                            tagsHtml += `<span class="fv-kw-tag" style="background:${c.bg};color:${c.text};border:1px solid ${c.border};">"${escapeHtml(kw)}" ${kwHitCount[ki]} 处</span>`;
                        });
                        hlKwTags.innerHTML = tagsHtml;
                        hlPosText.textContent = '';
                    } else {
                        hlBar.style.display = 'none';
                        hlKwTags.innerHTML = '';
                        hlPosText.textContent = '';
                    }

                    // ---------- 确定初始定位目标 ----------
                    const anchorPara = _ruleFirstMatchPara[idx] || null;
                    let anchorHlIdx = 0;
                    if (anchorPara && _fvHighlights.length > 0) {
                        // 用关键词上下文匹配法：关键词左右各3个字
                        const lowerAnchorPara = anchorPara.toLowerCase();
                        let bestIdx = -1;
                        
                        for (let i = 0; i < _fvHighlights.length; i++) {
                            const markEl = _fvHighlights[i];
                            const parentEl = markEl.closest('p, div, span[data-line], td, li') || markEl.parentElement;
                            if (!parentEl) continue;
                            const parentText = parentEl.textContent.toLowerCase();
                            const markText = markEl.textContent.toLowerCase();
                            const markOffset = parentText.indexOf(markText);
                            
                            if (markOffset >= 0) {
                                const ctxStart = Math.max(0, markOffset - 3);
                                const ctxEnd = Math.min(parentText.length, markOffset + markText.length + 3);
                                const context = parentText.substring(ctxStart, ctxEnd);
                                
                                const kwInAnchor = lowerAnchorPara.indexOf(markText);
                                if (kwInAnchor >= 0) {
                                    const tCtxStart = Math.max(0, kwInAnchor - 3);
                                    const tCtxEnd = Math.min(lowerAnchorPara.length, kwInAnchor + markText.length + 3);
                                    const anchorContext = lowerAnchorPara.substring(tCtxStart, tCtxEnd);
                                    
                                    if (context === anchorContext) {
                                        bestIdx = i;
                                        break;
                                    }
                                }
                            }
                        }
                        
                        // 回退：用段落前20个字匹配
                        if (bestIdx === -1) {
                            for (let i = 0; i < _fvHighlights.length; i++) {
                                const markEl = _fvHighlights[i];
                                const container = markEl.closest('p, div, span[data-line], td, li') || markEl.parentElement;
                                if (!container) continue;
                                const containerText = container.textContent;
                                if (anchorPara.length > 0 && containerText.includes(anchorPara.substring(0, Math.min(10, anchorPara.length)))) {
                                    bestIdx = i;
                                    break;
                                }
                            }
                        }
                        
                        if (bestIdx >= 0) anchorHlIdx = bestIdx;
                    }
                    _fvCurHl = anchorHlIdx;

                } else {
                    // ---------- 无关键词模式 ----------
                    if (hasHtml) {
                        // 富文本模式
                        const html = renderRuleHtml(contentToShow);
                        bodyEl.innerHTML = html;
                        bodyEl.style.whiteSpace = 'normal';
                        setupLazyImageObserver(bodyEl);
                    } else {
                        // 纯文本模式：使用 content，通过 smartSplitParagraphs 智能分段（兼容旧数据无换行）
                        const plainText = rule.content || contentToShow || '';
                        const paragraphs = smartSplitParagraphs(plainText);
                        // 【2026-10-01 用户报「关键词全文定位有时不准」】这里原来**不带任何段落下标**：
                        //   于是无关键词模式下 `querySelector('[data-line="N"]')` 永远找不到元素 ⇒ 点了命中段
                        //   根本不会滚动（"定位不准"的一种就是"没动"）。补上 data-para-index / data-line，
                        //   与 smartSplitParagraphs 的段落序列完全同源，可按下标精确命中。
                        bodyEl.innerHTML = paragraphs.map((para, i) =>
                            '<p data-para-index="' + i + '" data-line="' + i + '" style="margin:4px 0;line-height:1.6;">' + escapeHtml(para) + '</p>'
                        ).join('');
                        bodyEl.style.whiteSpace = 'normal';
                    }
                    _fvHighlights = [];
                    _fvCurHl = -1;
                    document.getElementById('rule-fullViewHlBar').style.display = 'none';
                    document.getElementById('rule-fullViewHlKwTags').innerHTML = '';
                    bodyEl.scrollTop = 0;
                }

                openModal('rule-fullViewModal');
                // v3.30：登记「全文查看会话」——还原时若正文为空（modalHTML 超限等）由
                //   restoreEdit_rule 从 IndexedDB 重建，保证大正文规章折叠/刷新后不丢内容。
                try {
                    if (window._editSession) window._editSession.set({ module: 'rule', type: 'fullview', idx: idx, keywords: keywords, ts: Date.now() });
                } catch (e) {}
                if (typeof _fvScrollbarReset === 'function') _fvScrollbarReset();
                // 模态框打开后滚动到目标位置（延迟确保DOM渲染完成）
                if (_fvHighlights.length > 0) {
                    setTimeout(() => ruleFvScrollToHl(_fvCurHl), 150);
                }
                
                // 图片点击放大：事件委托，无需遍历绑定（新增图片也自动生效）
                if (!bodyEl._imgClickDelegated) {
                    bodyEl._imgClickDelegated = true;
                    bodyEl.addEventListener('click', function(e) {
                        if (e.target.tagName === 'IMG') {
                            e.target.classList.toggle('zoomed');
                        }
                    });
                }
            };

            // 点击搜索结果段落时打开全文并滚动到对应位置
            window.ruleViewFullTextAndScroll = async function(ruleIdx, paraIdx) {
                const rule = rules[ruleIdx];
                if (!rule) return;
                const keywords = getKeywords().filter(k => k.trim() !== '');

                // 填入标题与专业
                document.getElementById('rule-fullViewTitle').textContent = rule.title;
                document.getElementById('rule-fullViewTrade').textContent = rule.trade;
                const contentLength = (rule.searchText || rule.content || '').length;
                document.getElementById('rule-fullViewLength').textContent = contentLength + ' 字';

                const bodyEl = document.getElementById('rule-fullContentBody');
                // 清除之前的局部声明，使用全局变量
                _fvHighlights = [];
                _fvCurHl = -1;

                // 使用与搜索时相同的智能段落切分逻辑
                const allParagraphs = smartSplitParagraphs(rule.content);
                
                // paraIdx 是过滤后的索引，直接使用
                const targetPara = allParagraphs[paraIdx] || '';
                const targetLineIdx = paraIdx;

                // 优先使用 contentHtml（富文本模式），检测是否含真正的HTML标签
                const hasHtml = rule.contentHtml && /<[a-z][\s\S]*>/i.test(rule.contentHtml);
                const contentToShow = hasHtml ? rule.contentHtml : (rule.content || '');

                if (keywords.length > 0) {
                    if (hasHtml) {
                        // ---------- 富文本模式（有 contentHtml）----------
                        let html = renderRuleHtml(contentToShow);
                        
                        // 注入关键词高亮（在文本节点中）
                        const tempDiv = document.createElement('div');
                        tempDiv.innerHTML = html;
                        
                        function highlightNode(node, kwIdx) {
                            if (node.nodeType === Node.TEXT_NODE) {
                                const text = node.textContent;
                                const kw = keywords[kwIdx];
                                // 与同文件「纯文本模式」路径统一的约定：关键词与文本都先转义，再在转义后的文本上匹配
                                const kwEsc = escapeHtml(kw);
                                const escaped = escapeHtml(text);
                                const regex = new RegExp('(' + escapeRegExp(kwEsc) + ')', 'gi');
                                if (regex.test(escaped)) {
                                    // ★ 安全且快：文本先转义 → 正文里的 &lt;img onerror=…&gt; 不会被二次解析成真标签
                                    //   （此处原先是把 node.textContent 直接回写 innerHTML，构成存储型 XSS）；
                                    //   高亮用【一次 innerHTML】完成，不逐个 createElement —— 后者在关键词命中多时
                                    //   要创建上万个元素并逐次解析 CSS，慢一个量级。
                                    const color = KW_COLORS[kwIdx % KW_COLORS.length];
                                    const span = document.createElement('span');
                                    span.innerHTML = escaped.replace(
                                        regex,
                                        '<mark class="rule-fv-hl" data-kw-idx="' + kwIdx + '" style="background:' + color.bg + ';color:' + color.text + ';font-weight:600;padding:1px 3px;border-radius:3px;border:1px solid ' + color.border + ';">$1</mark>'
                                    );
                                    return span;
                                }
                            } else if (node.nodeType === Node.ELEMENT_NODE && node.childNodes) {
                                const children = Array.from(node.childNodes);
                                children.forEach((child, i) => {
                                    const replaced = highlightNode(child, kwIdx);
                                    if (replaced !== child) {
                                        node.replaceChild(replaced, child);
                                    }
                                });
                            }
                            return node;
                        }
                        
                        // 对每个关键词进行高亮
                        keywords.forEach((kw, kwIdx) => {
                            if (!kw) return;
                            highlightNode(tempDiv, kwIdx);
                        });
                        
                        bodyEl.innerHTML = tempDiv.innerHTML;
                        bodyEl.style.whiteSpace = 'pre-wrap';
                        setupLazyImageObserver(bodyEl);
                        
                        // 收集高亮元素
                        _fvHighlights = Array.from(bodyEl.querySelectorAll('.rule-fv-hl'));
                        _fvCurHl = _fvHighlights.length > 0 ? 0 : -1;
                    } else {
                        // ---------- 纯文本模式（无 contentHtml，使用旧 content）----------
                        // 使用 smartSplitParagraphs 智能分段，兼容旧数据无换行的情况
                        const paragraphs = smartSplitParagraphs(contentToShow);
                        const hlParts = paragraphs.map((para, lineIdx) => {
                            if (!para.trim()) return '<span data-para-index="' + lineIdx + '" data-line="' + lineIdx + '"></span>';
                            let escaped = escapeHtml(para);
                            keywords.forEach((kw, kwIdx) => {
                                if (!kw) return;
                                const color = KW_COLORS[kwIdx % KW_COLORS.length];
                                const regex = new RegExp('(' + escapeRegExp(escapeHtml(kw)) + ')', 'gi');
                                escaped = escaped.replace(regex,
                                    `<mark class="rule-fv-hl" data-kw-idx="${kwIdx}" data-line="${lineIdx}" style="background:${color.bg};color:${color.text};font-weight:600;padding:1px 3px;border-radius:3px;border:1px solid ${color.border};">$1</mark>`
                                );
                            });
                            return '<span data-para-index="' + lineIdx + '" data-line="' + lineIdx + '">' + escaped + '</span>';
                        });
                        bodyEl.innerHTML = hlParts.join('<br>');
                        bodyEl.style.whiteSpace = 'pre-wrap';
                        
                        _fvHighlights = Array.from(bodyEl.querySelectorAll('.rule-fv-hl'));
                        _fvCurHl = _fvHighlights.length > 0 ? 0 : -1;
                    }

                    // 统计关键词命中数
                    const kwHitCount = new Array(keywords.length).fill(0);
                    _fvHighlights.forEach(el => {
                        const ki = parseInt(el.getAttribute('data-kw-idx'));
                        if (!isNaN(ki)) kwHitCount[ki] = (kwHitCount[ki] || 0) + 1;
                    });
                    const totalHits = _fvHighlights.length;

                    // 顶部提示栏
                    const hlBar = document.getElementById('rule-fullViewHlBar');
                    const hlTotal = document.getElementById('rule-fullViewHlTotal');
                    const hlKwTags = document.getElementById('rule-fullViewHlKwTags');
                    const hlBarText = document.getElementById('rule-fullViewHlBarText');

                    if (totalHits > 0) {
                        hlBar.style.display = 'flex';
                        hlBarText.textContent = '已找到';
                        hlTotal.textContent = totalHits;
                        let tagsHtml = '';
                        keywords.forEach((kw, ki) => {
                            const c = KW_COLORS[ki % KW_COLORS.length];
                            tagsHtml += `<span class="fv-kw-tag" style="background:${c.bg};color:${c.text};border:1px solid ${c.border};">"${escapeHtml(kw)}" ${kwHitCount[ki]} 处</span>`;
                        });
                        hlKwTags.innerHTML = tagsHtml;
                    } else {
                        hlBar.style.display = 'none';
                        hlKwTags.innerHTML = '';
                    }
                } else {
                    // ---------- 无关键词模式 ----------
                    if (hasHtml) {
                        // 富文本模式
                        const html = renderRuleHtml(contentToShow);
                        bodyEl.innerHTML = html;
                        bodyEl.style.whiteSpace = 'normal';
                        setupLazyImageObserver(bodyEl);
                    } else {
                        // 纯文本模式：使用 content，通过 smartSplitParagraphs 智能分段（兼容旧数据无换行）
                        const plainText = rule.content || contentToShow || '';
                        const paragraphs = smartSplitParagraphs(plainText);
                        // 【2026-10-01 用户报「关键词全文定位有时不准」】这里原来**不带任何段落下标**：
                        //   于是无关键词模式下 `querySelector('[data-line="N"]')` 永远找不到元素 ⇒ 点了命中段
                        //   根本不会滚动（"定位不准"的一种就是"没动"）。补上 data-para-index / data-line，
                        //   与 smartSplitParagraphs 的段落序列完全同源，可按下标精确命中。
                        bodyEl.innerHTML = paragraphs.map((para, i) =>
                            '<p data-para-index="' + i + '" data-line="' + i + '" style="margin:4px 0;line-height:1.6;">' + escapeHtml(para) + '</p>'
                        ).join('');
                        bodyEl.style.whiteSpace = 'normal';
                    }
                    _fvHighlights = [];
                    _fvCurHl = -1;
                    document.getElementById('rule-fullViewHlBar').style.display = 'none';
                    document.getElementById('rule-fullViewHlKwTags').innerHTML = '';
                    bodyEl.scrollTop = 0;
                }

                openModal('rule-fullViewModal');
                // v3.30：登记「全文查看会话」（含目标段落索引，供还原后重建并定位）
                try {
                    if (window._editSession) window._editSession.set({ module: 'rule', type: 'fullview', idx: ruleIdx, paraIdx: paraIdx, keywords: keywords, ts: Date.now() });
                } catch (e) {}
                if (typeof _fvScrollbarReset === 'function') _fvScrollbarReset();
                
                // 延迟滚动到目标段落
                setTimeout(() => {
                    if (_fvHighlights.length > 0) {
                        // 精确定位：在全文高亮中找到与目标段落匹配的高亮元素
                        let targetHlIdx = 0;
                        // 【2026-10-01 用户报「关键词全文定位有时不准」】原来**只按"关键词左右各 3 个字"猜**目标高亮
                        //   （同一段里有多个相同关键词、或富文本路径下父元素文本不同 ⇒ 猜错 ⇒ 定位到别处）。
                        //   现在先用**段落下标**精确命中：纯文本路径的 <span>/<mark> 都带 data-para-index /
                        //   data-line，且与 smartSplitParagraphs 同源 ⇒ 下标可比；命中就取该段内第一个高亮。
                        //   富文本路径下标不可比 ⇒ 自然落空 ⇒ 仍走下面的上下文匹配（行为不变）。
                        let _exactHlIdx = -1;
                        if (Number.isInteger(paraIdx) && paraIdx >= 0) {
                            for (let i = 0; i < _fvHighlights.length; i++) {
                                const m = _fvHighlights[i];
                                const own = String(m.getAttribute('data-line') || '');
                                const holder = (m.closest ? m.closest('[data-para-index="' + paraIdx + '"]') : null);
                                if (own === String(paraIdx) || holder) { _exactHlIdx = i; break; }
                            }
                        }
                        if (_exactHlIdx >= 0) {
                            targetHlIdx = _exactHlIdx;
                        } else if (targetPara) {
                            // 从目标段落中提取关键词周围的上下文（左右各延伸3个字）作为匹配锚点
                            const lowerTargetPara = targetPara.toLowerCase();
                            let bestIdx = -1;
                            let bestPos = Infinity;
                            
                            for (let i = 0; i < _fvHighlights.length; i++) {
                                const markEl = _fvHighlights[i];
                                // 获取高亮元素在全文中的位置（通过向上遍历找包含的文本段落）
                                const parentEl = markEl.closest('p, div, span[data-line], td, li') || markEl.parentElement;
                                if (!parentEl) continue;
                                
                                // 取父元素的一段文本用于匹配
                                const parentText = parentEl.textContent.toLowerCase();
                                // 检查该高亮是否属于目标段落：从高亮位置向左右各取3个字
                                const markText = markEl.textContent.toLowerCase();
                                const markOffset = parentText.indexOf(markText);
                                
                                if (markOffset >= 0) {
                                    // 取关键词左右各3个字作为上下文
                                    const ctxStart = Math.max(0, markOffset - 3);
                                    const ctxEnd = Math.min(parentText.length, markOffset + markText.length + 3);
                                    const context = parentText.substring(ctxStart, ctxEnd);
                                    
                                    // 在目标段落中也找相同关键词的上下文
                                    const kwInTarget = lowerTargetPara.indexOf(markText);
                                    if (kwInTarget >= 0) {
                                        const tCtxStart = Math.max(0, kwInTarget - 3);
                                        const tCtxEnd = Math.min(lowerTargetPara.length, kwInTarget + markText.length + 3);
                                        const targetContext = lowerTargetPara.substring(tCtxStart, tCtxEnd);
                                        
                                        if (context === targetContext && i < bestPos) {
                                            bestPos = i;
                                            bestIdx = i;
                                            break; // 找到最靠前的匹配就停止
                                        }
                                    }
                                }
                            }
                            
                            // 如果通过上下文没找到匹配，回退到直接文本匹配
                            if (bestIdx === -1) {
                                for (let i = 0; i < _fvHighlights.length; i++) {
                                    const markEl = _fvHighlights[i];
                                    const container = markEl.closest('p, div, span[data-line], td, li') || markEl.parentElement;
                                    if (!container) continue;
                                    const containerText = container.textContent;
                                    // 检查容器文本是否包含目标段落的前20个字
                                    if (targetPara.length > 0 && containerText.includes(targetPara.substring(0, Math.min(10, targetPara.length)))) {
                                        bestIdx = i;
                                        break;
                                    }
                                }
                            }
                            
                            if (bestIdx >= 0) targetHlIdx = bestIdx;
                        }
                        _fvCurHl = targetHlIdx;
                        ruleFvScrollToHl(_fvCurHl);
                    } else if (targetLineIdx >= 0) {
                        // 【2026-10-01】无高亮时定位目标行：原来用 scrollIntoView（会把**整个页面**也滚走，
                        //   且不会避开弹窗内的粘性提示栏）⇒ 改为与高亮路径同一个"容器内定位 + 复核"函数。
                        const targetEl = bodyEl.querySelector('[data-para-index="' + targetLineIdx + '"]')
                            || bodyEl.querySelector('[data-line="' + targetLineIdx + '"]');
                        if (targetEl) ruleFvEnsureVisible(targetEl);
                    }
                }, 120);   // 原来 300ms 单次：长文档/小屏排版更慢，300ms 时元素还没落位 ⇒ 用旧坐标算偏移
                
                // 图片点击放大：事件委托（与 ruleViewFullText 共用同一个委托监听，不重复绑定）
                if (!bodyEl._imgClickDelegated) {
                    bodyEl._imgClickDelegated = true;
                    bodyEl.addEventListener('click', function(e) {
                        if (e.target.tagName === 'IMG') {
                            e.target.classList.toggle('zoomed');
                        }
                    });
                }
            };

            /**
             * 【2026-10-01 用户报「关键词全文定位有时不准，可能与屏幕大小有关」】
             * 原实现三个"跟屏幕/布局有关"的隐患：
             *   ① 300ms 单次 setTimeout + smooth：长文档、小屏（手机）排版更慢，测坐标时元素还没落位 ⇒ 偏移算错；
             *   ② 弹窗顶部有**粘性提示栏**（"已找到 N 处" + 关键词标签会换行）⇒ 高度随关键词个数/屏宽变化，
             *      按"容器居中"滚动时目标容易被它盖住（屏越小越容易）；
             *   ③ 无高亮路径用 scrollIntoView ⇒ 会把整个页面也滚走，定位结果随页面滚动位置漂移。
             * 现在统一为：**只在容器内滚动**、现场量粘性栏高度并避开、先把目标放到可视区上 1/3 处，
             * 再在 rAF / +120ms / +300ms 复核三次（布局晚到也能自动纠正，幂等）；只有用户点"上一处/下一处"才用平滑动画。
             */
            function _fvStickyH() {
                const bar = document.getElementById('rule-fullViewHlBar');
                const container = document.getElementById('rule-fullContentBody');
                if (!bar || !container) return 0;
                const cs = getComputedStyle(bar);
                if (cs.display === 'none' || cs.visibility === 'hidden') return 0;
                // ⚠️ 提示栏在布局上其实位于滚动容器**之外**（不遮挡内容）—— 只有当它真的与容器**重叠**
                //   （例如将来做成 sticky 或容器本身可滚动时）才需要避让，否则一律按 0 处理，
                //   免得把目标白白往下推一段（第一版就是这么把 rel 推成 51、恰好压着 53 的栏高的）。
                const br = bar.getBoundingClientRect();
                const cr = container.getBoundingClientRect();
                const overlap = Math.min(br.bottom, cr.bottom) - Math.max(br.top, cr.top);
                return overlap > 1 ? Math.round(overlap) : 0;
            }

            function ruleFvPlaceEl(el, smooth) {
                const container = document.getElementById('rule-fullContentBody');
                if (!container || !el || !el.isConnected) return;
                const cr = container.getBoundingClientRect();
                const er = el.getBoundingClientRect();
                const sticky = _fvStickyH();
                const topLimit = cr.top + sticky + 10;                  // 粘性提示栏之下 10px
                // 放在可视区（扣掉粘性栏）的上 1/3 处：比"居中"更稳 —— 小屏上居中会把上下文都挤出视野
                const inner = Math.max(60, cr.height - sticky - 20);
                const wantTop = topLimit + Math.max(0, (inner - Math.max(er.height, 18)) / 3);
                const delta = er.top - wantTop;
                if (Math.abs(delta) < 2) return;                        // 已在位：不动，避免抖动
                container.scrollTo({ top: Math.max(0, container.scrollTop + delta), behavior: smooth ? 'smooth' : 'auto' });
            }

            function ruleFvEnsureVisible(el, smooth) {
                if (!el) return;
                ruleFvPlaceEl(el, smooth === true);
                ruleFvFollow(el);                     // 布局还会变（见下）⇒ 有界跟随重定位
                try {
                    // 字体晚到会改变换行 ⇒ 字体就绪后再落位一次
                    if (document.fonts && document.fonts.ready && document.fonts.ready.then) {
                        document.fonts.ready.then(function () { if (el.isConnected && _fvFollowEl === el) ruleFvPlaceEl(el, false); });
                    }
                } catch (e) {}
                let tries = 0;
                const verify = () => {
                    tries++;
                    if (!el.isConnected) return;
                    const container = document.getElementById('rule-fullContentBody');
                    if (!container) return;
                    const cr = container.getBoundingClientRect();
                    const er = el.getBoundingClientRect();
                    const topLimit = cr.top + _fvStickyH() + 4;
                    const bottomLimit = cr.bottom - 4;
                    const ok = (er.top >= topLimit && er.top <= bottomLimit);
                    if (!ok) ruleFvPlaceEl(el, false);                  // 布局晚到 ⇒ 用新坐标再放一次（幂等）
                    if (tries < 3) setTimeout(verify, tries === 1 ? 120 : 300);
                };
                requestAnimationFrame(verify);
            }

            /**
             * 【2026-10-01 用户补充：屏幕大小会影响关键词所在的**视觉行数**】
             *   窄屏一行放不下 ⇒ 同一段在小屏上占**更多行** ⇒ 内容整体高度、目标所处的纵向位置都会变。
             *   所以：① 定位必须**锚住 DOM 元素**（每次都用 getBoundingClientRect 现场量，绝不按行数/固定像素折算）；
             *        ② 在"布局还会变"的时间窗内自动跟随重定位 —— 容器尺寸变化（窄屏/横竖屏切换）、
             *           字体晚到（document.fonts.ready）、懒加载图片撑高，任一发生都不会让目标漂走。
             *   跟随是有界的：最长约 2.5s，且用户一主动滚动/触摸/点击就立刻停止（不跟用户抢滚动条）。
             */
            let _fvFollowEl = null, _fvFollowUntil = 0, _fvFollowTimer = null;
            function ruleFvStopFollow() {
                _fvFollowEl = null;
                if (_fvFollowTimer) { clearTimeout(_fvFollowTimer); _fvFollowTimer = null; }
            }
            function ruleFvFollow(el) {
                _fvFollowEl = el;
                _fvFollowUntil = Date.now() + 2500;
                const container = document.getElementById('rule-fullContentBody');
                if (container && !container._fvFollowBound) {
                    container._fvFollowBound = true;
                    ['wheel', 'touchstart', 'mousedown', 'keydown'].forEach(ev =>
                        container.addEventListener(ev, ruleFvStopFollow, { passive: true }));
                }
                if (_fvFollowTimer) return;
                const tick = () => {
                    _fvFollowTimer = null;
                    if (!_fvFollowEl || !_fvFollowEl.isConnected || Date.now() > _fvFollowUntil) { _fvFollowEl = null; return; }
                    ruleFvPlaceEl(_fvFollowEl, false);   // 用现场坐标重新落位（幂等；已在位时不动）
                    _fvFollowTimer = setTimeout(tick, 250);
                };
                _fvFollowTimer = setTimeout(tick, 150);
            }

            function ruleFvScrollToHl(idx, smooth) {
                if (_fvHighlights.length === 0) return;
                // 移除旧的激活态
                _fvHighlights.forEach(el => el.classList.remove('fv-active'));
                _fvCurHl = ((idx % _fvHighlights.length) + _fvHighlights.length) % _fvHighlights.length;
                const el = _fvHighlights[_fvCurHl];
                el.classList.add('fv-active');
                ruleFvEnsureVisible(el, smooth === true);
                // 更新位置提示
                const posEl = document.getElementById('rule-fullViewHlPosText');
                if (posEl) posEl.textContent = '（第 ' + (_fvCurHl + 1) + ' / ' + _fvHighlights.length + ' 处）';
            }

            window.ruleFvNextHl = function() { ruleFvScrollToHl(_fvCurHl + 1, true); };
            window.ruleFvPrevHl = function() { ruleFvScrollToHl(_fvCurHl - 1, true); };

            document.addEventListener('DOMContentLoaded', async function() {
                await loadRulesFromDB();
                refreshTradeSelect();
                updateTotalBadge();
                updateStorageInfo();
                // v3.29：折叠/刷新后 page-state 已在 DOMContentLoaded 同步整页还原
                //   （含折叠前搜索结果的显示状态）。本 init 是 async，await 之后才执行到此处，
                //   晚于还原，若无条件隐藏会把「搜索结果」重新藏掉（用户反馈：刷新/折叠后
                //   搜索结果不保留）。仅当无快照还原时才隐藏，还原过则保留当前显示状态。
                var _snapRestored = false;
                try {
                    var _raw = sessionStorage.getItem('page_state_snapshot_v1');
                    if (_raw) {
                        var _snap = JSON.parse(_raw);
                        // 注意 key 的变化：page-state 的 panelHTML 现在按「动态内容容器 id」
                        // 存储（见 DYNAMIC_SNAPSHOT_IDS），不再是模块名。
                        // 沿用旧的 .rule 会恒为 false，导致每次刷新都把搜索结果区藏掉。
                        _snapRestored = !!( _snap && _snap.panelHTML &&
                            (_snap.panelHTML['rule-resultsList'] || _snap.panelHTML.rule));
                    }
                } catch (e) {}
                if (!_snapRestored) {
                    document.getElementById('rule-resultsList').style.display = 'none';
                    document.querySelector('#panel-rule .results-header').style.display = 'none';
                }
                // v3.13 兼容：初始化时对容器做幂等处理（空则加 1 行，已有行则同步计数器）。
                // 折叠屏恢复时 page-state 会在本模块 init 之后覆盖 panel innerHTML，
                // 故另监听 pageSnapshotRestored 事件，在还原完成后再同步一次（见下方定义）。
                (function ruleKeywordInit() {
                    var c = document.getElementById('rule-keywordContainer');
                    if (!c) { addKeywordInput(); return; }
                    if (c.querySelectorAll('.keyword-row').length > 0) syncRuleKeywordFromDOM();
                    else addKeywordInput();
                })();

                document.getElementById('rule-searchBtn').addEventListener('click', renderResults);
                document.getElementById('rule-clearSearchBtn').addEventListener('click', clearSearch);
                document.getElementById('rule-btnAdd').addEventListener('click', addKeywordInput);
                // 以下按钮已迁移至设置面板，做空值保护
                var _el;
                _el = document.getElementById('rule-importBtn'); if (_el) _el.addEventListener('click', handleImportClick);
                _el = document.getElementById('rule-exportBtn'); if (_el) _el.addEventListener('click', function() { openModal('rule-exportModal'); });
                _el = document.getElementById('rule-catalogBtn'); if (_el) _el.addEventListener('click', showCatalog);
                // 【2026-09-21 删除】此处原有 `#rule-clearBtn` 的 handler，其 else 分支是"取消 = 恢复示例数据并保存"。
                //   该按钮已从 index.html 移除（死代码），但危险默认值留着迟早出事（谁把按钮加回来 =
                //   "点取消把真实规章换成示例"）。需要清空规章请走「设置 → 数据 → 规章制度 → 清空」。
                _el = null;
                document.getElementById('rule-tradeSelect').addEventListener('change', renderResults);
                document.getElementById('rule-catalogFilter')?.addEventListener('input', renderCatalog);
                document.getElementById('rule-catalogTradeFilter')?.addEventListener('change', renderCatalog);
            });
        })();
