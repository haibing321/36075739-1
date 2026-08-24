        // ========== Rule System (完整保留) ==========
        (function() {
            if (typeof pdfjsLib !== 'undefined') {
                pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/2.16.105/pdf.worker.min.js';
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
                return html;
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

            // 通用文件下载函数，兼容所有浏览器（含华为/Edge/Safari/微信/iOS等）
            // 统一走全局移动端兼容下载（utils.js: window.downloadBlob），避免多套实现
            function downloadBlob(blob, filename) {
                if (filename.endsWith('.zip') && (!blob.type || blob.type === '' || blob.type === 'application/octet-stream')) {
                    blob = new Blob([blob], { type: 'application/zip' });
                }
                window.downloadBlob(blob, filename);
            }
            
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
                    'background:linear-gradient(135deg,#1a365d,#2c5282);',
                    'color:#fff;padding:14px 28px;border-radius:25px;',
                    'text-decoration:none;font-size:0.95rem;font-weight:600;',
                    'z-index:99999;box-shadow:0 4px 20px rgba(26,54,93,0.4);',
                    'white-space:nowrap;animation:_mbdlFadeIn .3s ease;'
                ].join('');
                
                // 注入动画
                if (!document.getElementById('_mobile_dl_style')) {
                    var s = document.createElement('style');
                    s.id = '_mobile_dl_style';
                    s.textContent = '@keyframes _mbdlFadeIn{from{opacity:0;transform:translateX(-50%) translateY(20px);}to{opacity:1;transform:translateX(-50%) translateY(0);}}';
                    document.head.appendChild(s);
                }
                
                document.body.appendChild(btn);
                
                // 10秒后自动移除
                setTimeout(function() {
                    if (btn.parentNode) btn.parentNode.removeChild(btn);
                    setTimeout(function() { URL.revokeObjectURL(url); }, 30000);
                }, 10000);
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
                            // 只有当 data 是长度>0的数组时才使用，空数组或非法数据回退到示例
                            if (result && Array.isArray(result.data) && result.data.length > 0) {
                                rules = result.data;
                                console.log('[loadRulesFromDB] 加载成功，共 ' + rules.length + ' 条规章');
                            } else {
                                rules = sampleRules.map(r => ({ ...r }));
                                console.log('[loadRulesFromDB] IndexedDB 无数据或为空，使用 ' + rules.length + ' 条示例规章');
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
                    const request = store.put({ id: 1, data: rulesArray });
                    request.onsuccess = () => resolve();
                    request.onerror = () => reject(request.error);
                });
            }
            async function saveToStorage() {
                try {
                    await saveRulesToDB(rules);
                    updateStorageInfo();
                    return true;
                } catch (e) {
                    alert('保存失败：' + e.message);
                    return false;
                }
            }
            function updateStorageInfo() {
                try {
                    const jsonStr = JSON.stringify(rules);
                    const size = new Blob([jsonStr]).size;
                    const percent = Math.min(100, (size / MAX_STORAGE_SIZE) * 100);
                    const bar = document.getElementById('rule-storageBar');
                    if (bar) bar.style.width = percent + '%';
                    const text = document.getElementById('rule-storageText');
                    if (text) text.textContent = (size / 1024 / 1024).toFixed(2) + '/500MB';
                    if (bar) {
                        bar.classList.remove('warning', 'danger');
                        if (percent > 80) bar.classList.add('danger');
                        else if (percent > 60) bar.classList.add('warning');
                    }
                } catch (e) {
                    const text = document.getElementById('rule-storageText');
                    if (text) text.textContent = '未知';
                }
            }
            function updateTotalBadge() {
                const badge = document.getElementById('rule-totalBadge');
                if (badge) badge.textContent = rules.length + ' 条';
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

            function splitLongParagraphWithAllKeywords(paragraph, keywords, matchMode = 'and', maxLen = 380) {
                // 使用规范化后的文本进行匹配
                const normalizedPara = normalizeText(paragraph).toLowerCase();
                const normalizedKws = keywords.map(kw => normalizeText(kw).toLowerCase());
                
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
                const fragments = [];
                limitedWindows.forEach((window, idx) => {
                    // 向前扩展到标点符号后
                    let snippetStart = window.start;
                    const beforeText = paragraph.substring(0, window.start);
                    let lastPuncPos = -1;
                    for (const punc of punctuations) {
                        const pos = beforeText.lastIndexOf(punc);
                        if (pos > lastPuncPos) lastPuncPos = pos;
                    }
                    if (lastPuncPos >= 0) {
                        snippetStart = lastPuncPos + 1;
                    }
                    
                    // 向后扩展到标点符号前
                    let snippetEnd = window.end;
                    const afterText = paragraph.substring(window.end);
                    let nextPuncPos = Infinity;
                    for (const punc of punctuations) {
                        const pos = afterText.indexOf(punc);
                        if (pos >= 0 && pos < nextPuncPos) nextPuncPos = pos;
                    }
                    if (nextPuncPos !== Infinity) {
                        snippetEnd = window.end + nextPuncPos;
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

            function processParagraph(paragraph, index, allParagraphs, keywords, ruleIdx, matchMode = 'and', absIdx = -1) {
                const len = paragraph.length;
                const SHORT_THRESHOLD = 50, LONG_THRESHOLD = 400, PREV_TARGET = 150, NEXT_TARGET = 190, MAX_PREV_PARAS = 6;
                
                // 匹配模式标记固定为AND
                const modeAttr = 'data-match-mode="and"';
                
                if (len > LONG_THRESHOLD) {
                    const fragments = splitLongParagraphWithAllKeywords(paragraph, keywords, matchMode);
                    let html = '';
                    fragments.forEach(f => {
                        // 函数返回的片段已经包含省略号，直接使用
                        html += `<p class="rule-match-para" ${modeAttr} data-para-index="${index}" data-rule-idx="${ruleIdx}" style="cursor:pointer;" onclick="ruleViewFullTextAndScroll(${absIdx}, ${index})">${highlightKeywords(f.text, keywords)}</p>`;
                    });
                    return html;
                } else if (len >= SHORT_THRESHOLD && len <= LONG_THRESHOLD) {
                    return `<p class="rule-match-para" ${modeAttr} data-para-index="${index}" data-rule-idx="${ruleIdx}" style="cursor:pointer;" onclick="ruleViewFullTextAndScroll(${absIdx}, ${index})">${highlightKeywords(paragraph, keywords)}</p>`;
                } else {
                    const prevParas = collectPrevParagraphs(allParagraphs, index, PREV_TARGET, MAX_PREV_PARAS);
                    let nextPara = '';
                    if (index < allParagraphs.length - 1) {
                        const next = allParagraphs[index + 1];
                        nextPara = next.length > NEXT_TARGET ? next.substring(0, NEXT_TARGET) + '…' : next;
                    }
                    let html = '';
                    prevParas.forEach(p => html += `<span class="rule-context">${escapeHtml(p)}</span> `);
                    html += `<span class="rule-matched-paragraph rule-match-para" ${modeAttr} data-para-index="${index}" data-rule-idx="${ruleIdx}" style="cursor:pointer;" onclick="ruleViewFullTextAndScroll(${absIdx}, ${index})">${highlightKeywords(paragraph, keywords)}</span>`;
                    if (nextPara) html += ` <span class="rule-context">${escapeHtml(nextPara)}</span>`;
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
                let html = '';
                matchedIndices.forEach(idx => {
                    html += processParagraph(paragraphs[idx], idx, paragraphs, keywords, ruleIdx, matchMode, absIdx);
                });
                return html;
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
                if (isProcessing) { alert('正在处理中'); return; }
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
                        if (isProcessing) { alert('正在处理中'); return; }

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
            async function processFiles(files, trade) {
                await Promise.all([
                    loadScript('https://cdnjs.cloudflare.com/ajax/libs/mammoth/1.4.2/mammoth.browser.min.js'),
                    loadScript('https://cdnjs.cloudflare.com/ajax/libs/pdf.js/2.16.105/pdf.min.js'),
                    loadScript('https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js')
                ]);
                isProcessing = true;
                const btn = document.getElementById('rule-importBtn');
                let successCount = 0, skipCount = 0;
                for (let i = 0; i < files.length; i++) {
                    const file = files[i];
                    const ext = file.name.split('.').pop().toLowerCase();
                    if (btn) btn.innerHTML = '<span class="spinner" style="width:14px;height:14px;display:inline-block;vertical-align:middle;margin-right:4px;"></span> ' + (i + 1) + '/' + files.length;
                    try {
                        let contentHtml = '';
                        let searchText = '';
                        let plainText = '';  // 保留换行的纯文本，用于段落搜索
                        let imageIds = [];
                        
                        if (ext === 'pdf') {
                            if (typeof pdfjsLib === 'undefined') throw new Error('pdf.js 库未加载');
                            const arrayBuffer = await file.arrayBuffer();
                            const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
                            for (let p = 1; p <= pdf.numPages; p++) {
                                const page = await pdf.getPage(p);
                                const content = await page.getTextContent();
                                searchText += content.items.map(item => item.str).join(' ') + '\n';
                            }
                            plainText = searchText;  // PDF文本自带换行，直接用作content
                            contentHtml = '<pre style="white-space:pre-wrap;word-break:break-word;">' + escapeHtml(searchText) + '</pre>';
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
                                    const ruleData = {
                                        trade,
                                        title: section.title,
                                        content: section.content,  // 保留换行的纯文本（stripHtml结果）
                                        contentHtml: section.contentHtml,
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
                            const plainText = stripHtml(contentHtml);  // 保留换行的纯文本
                            searchText = normalizeSearchText(plainText);  // 无换行，用于分数计算
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
                                            contentHtml: hasRealHtml ? item.contentHtml : '',
                                            imageIds: item.imageIds || []
                                        };
                                        if (dupIdx !== -1) rules[dupIdx] = ruleData;
                                        else rules.push(ruleData);
                                        successCount++;
                                    }
                                }
                                continue;
                            }
                        } else { skipCount++; continue; }
                        
                        if (!searchText.trim() && !contentHtml.trim()) { skipCount++; continue; }
                        const title = file.name.replace(/\.[^/.]+$/, '');
                        const dupIdx = rules.findIndex(r => r.title.toLowerCase().trim() === title.toLowerCase().trim());
                        const ruleData = { 
                            trade, 
                            title, 
                            content: plainText || searchText,  // 保留换行的纯文本（DOCX用plainText，PDF等用searchText）
                            contentHtml: contentHtml,
                            imageIds: imageIds
                        };
                        if (dupIdx !== -1) rules[dupIdx] = ruleData;
                        else rules.push(ruleData);
                        successCount++;
                    } catch (err) { console.error(err); skipCount++; }
                }
                await saveToStorage(); refreshTradeSelect(); updateTotalBadge(); renderResults();
                if (btn) btn.innerHTML = '📥 导入';
                isProcessing = false;
                alert('导入完成：成功 ' + successCount + ' 个，跳过 ' + skipCount + ' 个');
            }
            window.doExport = async function(format) {
                await loadScript('https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js');
                const selectedTrade = document.getElementById('rule-exportTrade')?.value;
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
                const filename = selectedTrade ? '铁路规章_' + selectedTrade + '_' + new Date().toISOString().slice(0, 10) + '.json' : '铁路规章_全部_' + new Date().toISOString().slice(0, 10) + '.json';
                downloadBlob(blob, filename);
                closeModal('rule-exportModal');
            }

            // 根据选择导出ZIP（支持按专业筛选）
            window.exportToZipWithSelection = async function(selectedTrade, exportRules) {
                await loadScript('https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js');
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
                    downloadBlob(typedZipBlob, '铁路规章' + tradeSuffix + '_' + new Date().toISOString().slice(0, 10) + '.zip');
                    
                    alert('导出成功！共 ' + exportRules.length + ' 条规章' + (allImageIds.size > 0 ? '，包含 ' + allImageIds.size + ' 张图片' : ''));
                } catch (err) {
                    console.error('ZIP导出失败:', err);
                    alert('导出失败: ' + err.message);
                }
            };

            // 单条规章导出为 HTML（含图片，base64 内联，单文件，不依赖 ZIP/JSZip，手机端直接打开即看图）
            window.ruleExportSingleHtml = async function(idx) {
                var rule = rules[idx];
                if (!rule) { alert('未找到该规章'); return; }
                try {
                    var imgHtml = '';
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
                                    imgHtml += '<p style="text-align:center;"><img src="' + b64 + '" style="max-width:100%;border:1px solid #ddd;border-radius:6px;"></p>';
                                }
                            } catch (e) {}
                        }
                    }
                    var title = rule.title || '规章';
                    var safeTitle = title.replace(/[\\/:*?"<>|]/g, '_');
                    var html = '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">'
                        + '<meta name="viewport" content="width=device-width,initial-scale=1">'
                        + '<title>' + escapeHtml(title) + '</title>'
                        + '<style>body{font-family:-apple-system,"Microsoft YaHei",sans-serif;line-height:1.9;padding:24px;color:#222;max-width:900px;margin:auto}'
                        + 'h1{font-size:1.4rem;border-bottom:3px solid #2563eb;padding-bottom:8px}'
                        + '.meta{color:#666;font-size:.85rem;margin:6px 0 16px}'
                        + '.content{white-space:pre-wrap;word-break:break-word}'
                        + 'img{max-width:100%;border:1px solid #ddd;border-radius:6px;margin:8px 0}</style></head><body>'
                        + '<h1>' + escapeHtml(title) + '</h1>'
                        + '<div class="meta">专业：' + escapeHtml(rule.trade || '') + '</div>'
                        + '<div class="content">' + escapeHtml(rule.content || '') + '</div>'
                        + imgHtml
                        + '</body></html>';
                    var outBlob = new Blob([html], { type: 'text/html;charset=utf-8' });
                    window.downloadBlob(outBlob, safeTitle + '.html');
                    if (!/Mobi|Android/i.test(navigator.userAgent)) {
                        alert('已导出：' + title + '.html（含 ' + (rule.imageIds ? rule.imageIds.length : 0) + ' 张图片）');
                    }
                } catch (e) { alert('导出失败：' + e.message); }
            };

            // ========== ZIP 导出/导入功能 ==========
            window.exportToZip = async function() {
                if (rules.length === 0) { alert('暂无规章可导出'); return; }
                if (typeof JSZip === 'undefined') { alert('JSZip 库未加载，请检查网络连接'); return; }
                
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
                    downloadBlob(typedZipBlob, '铁路规章备份_' + new Date().toISOString().slice(0, 10) + '.zip');
                    
                    var mobileMsg = /Mobi|Android/i.test(navigator.userAgent) ? '\n\n【手机端】请点击屏幕底部「📥 下载」按钮完成下载。' : '';
                    alert('导出成功！共 ' + rules.length + ' 条规章' + (allImageIds.size > 0 ? '，包含 ' + allImageIds.size + ' 张图片' : '') + mobileMsg);
                } catch (err) {
                    console.error('ZIP导出失败:', err);
                    alert('导出失败: ' + err.message);
                }
            };

            window.importFromZip = async function(file) {
                if (typeof JSZip === 'undefined') { alert('JSZip 库未加载，请检查网络连接'); return; }
                if (!file) return;
                
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
                    for (const item of importRules) {
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
                                contentHtml: hasRealHtml ? item.contentHtml : '',
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
                    
                    await saveToStorage();
                    refreshTradeSelect();
                    updateTotalBadge();
                    renderResults();
                    
                    alert('导入完成：成功 ' + successCount + ' 条' + 
                          (imageCount > 0 ? '，图片 ' + imageCount + ' 张' : '') + 
                          (skipCount > 0 ? '，跳过 ' + skipCount + ' 条' : ''));
                } catch (err) {
                    console.error('ZIP导入失败:', err);
                    alert('导入失败: ' + err.message);
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
                                    const matchCount = (snippetHtml.match(/<p>/g) || []).length;
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
                                const regex = new RegExp('(' + escapeRegExp(kw) + ')', 'gi');
                                if (regex.test(text)) {
                                    const span = document.createElement('span');
                                    span.innerHTML = text.replace(regex, (match) => {
                                        const color = KW_COLORS[kwIdx % KW_COLORS.length];
                                        return `<mark class="rule-fv-hl" data-kw-idx="${kwIdx}" style="background:${color.bg};color:${color.text};font-weight:600;padding:1px 3px;border-radius:3px;border:1px solid ${color.border};">${match}</mark>`;
                                    });
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
                            if (!para.trim()) return '<span data-line="' + lineIdx + '"></span>';
                            let escaped = escapeHtml(para);
                            keywords.forEach((kw, kwIdx) => {
                                if (!kw) return;
                                const color = KW_COLORS[kwIdx % KW_COLORS.length];
                                const regex = new RegExp('(' + escapeRegExp(escapeHtml(kw)) + ')', 'gi');
                                escaped = escaped.replace(regex,
                                    `<mark class="rule-fv-hl" data-kw-idx="${kwIdx}" data-line="${lineIdx}" style="background:${color.bg};color:${color.text};font-weight:600;padding:1px 3px;border-radius:3px;border:1px solid ${color.border};">$1</mark>`
                                );
                            });
                            return '<span data-line="' + lineIdx + '">' + escaped + '</span>';
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
                        bodyEl.innerHTML = paragraphs.map(para => '<p style="margin:4px 0;line-height:1.6;">' + escapeHtml(para) + '</p>').join('');
                        bodyEl.style.whiteSpace = 'normal';
                    }
                    _fvHighlights = [];
                    _fvCurHl = -1;
                    document.getElementById('rule-fullViewHlBar').style.display = 'none';
                    document.getElementById('rule-fullViewHlKwTags').innerHTML = '';
                    bodyEl.scrollTop = 0;
                }

                openModal('rule-fullViewModal');
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
                                const regex = new RegExp('(' + escapeRegExp(kw) + ')', 'gi');
                                if (regex.test(text)) {
                                    const span = document.createElement('span');
                                    span.innerHTML = text.replace(regex, (match) => {
                                        const color = KW_COLORS[kwIdx % KW_COLORS.length];
                                        return `<mark class="rule-fv-hl" data-kw-idx="${kwIdx}" style="background:${color.bg};color:${color.text};font-weight:600;padding:1px 3px;border-radius:3px;border:1px solid ${color.border};">${match}</mark>`;
                                    });
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
                            if (!para.trim()) return '<span data-line="' + lineIdx + '"></span>';
                            let escaped = escapeHtml(para);
                            keywords.forEach((kw, kwIdx) => {
                                if (!kw) return;
                                const color = KW_COLORS[kwIdx % KW_COLORS.length];
                                const regex = new RegExp('(' + escapeRegExp(escapeHtml(kw)) + ')', 'gi');
                                escaped = escaped.replace(regex,
                                    `<mark class="rule-fv-hl" data-kw-idx="${kwIdx}" data-line="${lineIdx}" style="background:${color.bg};color:${color.text};font-weight:600;padding:1px 3px;border-radius:3px;border:1px solid ${color.border};">$1</mark>`
                                );
                            });
                            return '<span data-line="' + lineIdx + '">' + escaped + '</span>';
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
                        bodyEl.innerHTML = paragraphs.map(para => '<p style="margin:4px 0;line-height:1.6;">' + escapeHtml(para) + '</p>').join('');
                        bodyEl.style.whiteSpace = 'normal';
                    }
                    _fvHighlights = [];
                    _fvCurHl = -1;
                    document.getElementById('rule-fullViewHlBar').style.display = 'none';
                    document.getElementById('rule-fullViewHlKwTags').innerHTML = '';
                    bodyEl.scrollTop = 0;
                }

                openModal('rule-fullViewModal');
                if (typeof _fvScrollbarReset === 'function') _fvScrollbarReset();
                
                // 延迟滚动到目标段落
                setTimeout(() => {
                    if (_fvHighlights.length > 0) {
                        // 精确定位：在全文高亮中找到与目标段落匹配的高亮元素
                        let targetHlIdx = 0;
                        if (targetPara) {
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
                        // 无高亮时直接滚动到目标行
                        const targetEl = bodyEl.querySelector('[data-line="' + targetLineIdx + '"]');
                        if (targetEl) {
                            targetEl.scrollIntoView({ behavior: 'auto', block: 'center' });
                        }
                    }
                }, 300);
                
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

            function ruleFvScrollToHl(idx) {
                if (_fvHighlights.length === 0) return;
                // 移除旧的激活态
                _fvHighlights.forEach(el => el.classList.remove('fv-active'));
                _fvCurHl = ((idx % _fvHighlights.length) + _fvHighlights.length) % _fvHighlights.length;
                const el = _fvHighlights[_fvCurHl];
                el.classList.add('fv-active');
                // 在内容容器内部精确滚动（避免 scrollIntoView 滚动整个页面）
                const container = document.getElementById('rule-fullContentBody');
                if (container) {
                    const containerRect = container.getBoundingClientRect();
                    const elRect = el.getBoundingClientRect();
                    // 计算元素在容器中的相对位置，滚到元素居中
                    const offset = elRect.top - containerRect.top + container.scrollTop - container.clientHeight / 2 + elRect.height / 2;
                    container.scrollTo({ top: offset, behavior: 'smooth' });
                } else {
                    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
                }
                // 更新位置提示
                const posEl = document.getElementById('rule-fullViewHlPosText');
                if (posEl) posEl.textContent = '（第 ' + (_fvCurHl + 1) + ' / ' + _fvHighlights.length + ' 处）';
            }

            window.ruleFvNextHl = function() { ruleFvScrollToHl(_fvCurHl + 1); };
            window.ruleFvPrevHl = function() { ruleFvScrollToHl(_fvCurHl - 1); };

            document.addEventListener('DOMContentLoaded', async function() {
                await loadRulesFromDB();
                refreshTradeSelect();
                updateTotalBadge();
                updateStorageInfo();
                document.getElementById('rule-resultsList').style.display = 'none';
                document.querySelector('#panel-rule .results-header').style.display = 'none';
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
                _el = document.getElementById('rule-clearBtn'); if (_el) _el.addEventListener('click', async function() {
                    if (confirm('确定要清空所有规章吗？\n\n点击"确定"：清空\n点击"取消"：恢复示例')) {
                        rules = [];
                        await saveToStorage();
                        refreshTradeSelect();
                        updateTotalBadge();
                        renderResults();
                    } else {
                        rules = sampleRules.map(r => ({ ...r }));
                        await saveToStorage();
                        refreshTradeSelect();
                        updateTotalBadge();
                        renderResults();
                    }
                });
                document.getElementById('rule-totalBadge').addEventListener('click', showCatalog);
                document.getElementById('rule-tradeSelect').addEventListener('change', renderResults);
                document.getElementById('rule-catalogFilter')?.addEventListener('input', renderCatalog);
                document.getElementById('rule-catalogTradeFilter')?.addEventListener('change', renderCatalog);
            });
        })();
