// 来源：C:/Users/asus/Desktop/index.html 第7315-8266行 | 检查手册模块

        // ========== 第六模块：检查手册 (四级目录) ==========
        (function() {
            let handbookData = [];
            let chapters = [];
            let sectionsMap = {};
            let itemsMap = {};
            let subItemsMap = {};
            let contentMap = {};

            const totalSpan = document.getElementById('handbook-total');
            const sizeSpan = document.getElementById('handbook-size');
            const storageBar = document.getElementById('handbook-storageBar');

            const chineseNumMap = { '一':1,'二':2,'三':3,'四':4,'五':5,'六':6,'七':7,'八':8,'九':9,'十':10,
                '十一':11,'十二':12,'十三':13,'十四':14,'十五':15,'十六':16,'十七':17,'十八':18,'十九':19,'二十':20 };

            function getChapterOrder(s) { const m = s.match(/第([一二三四五六七八九十]+)章/); return m ? (chineseNumMap[m[1]] || 999) : 999; }
            function getSectionOrder(s) {
                let m = s.match(/第([一二三四五六七八九十]+)节/); if (m) return chineseNumMap[m[1]] || 999;
                m = s.match(/^(\d+)\./); if (m) return parseInt(m[1], 10); return 999;
            }
            function getItemOrder(s) { const m = s.match(/^(\d+)[\.、]/); return m ? parseInt(m[1], 10) : 999; }
            function getSubItemOrder(s) { const m = s.match(/^(\d+)[\.、\)）]/); return m ? parseInt(m[1], 10) : 999; }

            // 本模块用的 HTML 转义
            function _esc(text) { if (!text) return ''; return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }

            // ========== 导入确认通用函数 ==========
            function _showImportConfirm(count, importedData) {
                const modal = document.getElementById('handbook-importModal');
                document.getElementById('handbook-importMessage').innerText =
                    `成功解析 ${count} 条记录。\n当前已有 ${handbookData.length} 条。\n可选择「追加合并」或「覆盖现有」。`;
                modal.classList.add('active');

                // 追加合并
                document.getElementById('handbook-confirmImport').onclick = () => {
                    try {
                        handbookData = handbookData.concat(importedData);
                        updateStats();
                        saveToStorage();
                        closeModal('handbook-importModal');
                    } catch(e) {
                        console.error('手册追加失败:', e);
                        closeModal('handbook-importModal');
                        alert('导入失败: ' + e.message);
                    }
                };
                // 覆盖现有
                document.getElementById('handbook-confirmOverwrite').onclick = () => {
                    try {
                        handbookData = importedData;
                        updateStats();
                        saveToStorage();
                        closeModal('handbook-importModal');
                    } catch(e) {
                        console.error('手册覆盖失败:', e);
                        closeModal('handbook-importModal');
                        alert('导入失败: ' + e.message);
                    }
                };
            }

            // 按钮点击 → 打开文件选择器（按钮已迁移至设置面板，做空值保护）
            var _hbBtn = document.getElementById("handbook-importBtn");
            if (_hbBtn) _hbBtn.addEventListener('click', function() {
                document.getElementById('handbook-jsonFile').click();
            });

            document.getElementById('handbook-jsonFile').addEventListener('change', async function(e) {
                const files = Array.from(e.target.files);
                if (files.length === 0) return;

                const allImported = [];
                for (const file of files) {
                    const fileName = file.name.toLowerCase();
                    if (fileName.endsWith('.docx') || fileName.endsWith('.doc')) {
                        const parsed = await _parseDocxFile(file);
                        if (parsed) allImported.push(...parsed);
                    } else if (fileName.endsWith('.json')) {
                        const parsed = await _parseJsonFile(file);
                        if (parsed) allImported.push(...parsed);
                    }
                }

                if (allImported.length === 0) return;

                _showImportConfirm(allImported.length, allImported);
                e.target.value = '';
            });

            // 解析单个DOCX文件
            async function _parseDocxFile(file) {
                await loadScript('https://cdnjs.cloudflare.com/ajax/libs/mammoth/1.4.2/mammoth.browser.min.js');
                if (typeof mammoth === 'undefined') {
                    alert('mammoth 库未加载，请检查网络连接');
                    return null;
                }
                try {
                    const arrayBuffer = await file.arrayBuffer();
                    const result = await mammoth.convertToHtml({ arrayBuffer });
                    // 调试：输出mammoth转换的原始HTML（截取前3000字符）
                    console.log('[手册导入] mammoth原始HTML长度:', result.value.length);
                    console.log('[手册导入] mammoth HTML前2000字符:', result.value.substring(0, 2000));
                    console.log('[手册导入] mammoth HTML后1000字符:', result.value.slice(-1000));
                    const parsedData = parseHandbookHtml(result.value);
                    // 调试：输出解析结果
                    console.log('[手册导入] 解析出', parsedData.length, '条记录');
                    parsedData.forEach((d, i) => {
                        console.log(`[${i}] ch="${d.chapter}" | sec="${d.section}" | item="${d.item}" | sub="${d.subitem}" | content="${d.content ? d.content.substring(0,80) : ''}"`);
                    });
                    if (parsedData.length === 0) {
                        alert(`文件 "${file.name}" 未能解析出有效数据，已跳过`);
                        return null;
                    }
                    return parsedData;
                } catch (err) {
                    console.error('DOCX解析失败:', file.name, err);
                    alert(`文件 "${file.name}" 解析失败: ${err.message}`);
                    return null;
                }
            }

            // 解析单个JSON文件
            function _parseJsonFile(file) {
                return new Promise(resolve => {
                    const reader = new FileReader();
                    reader.onload = function(ev) {
                        try {
                            const imported = JSON.parse(ev.target.result);
                            if (!Array.isArray(imported)) throw new Error('数据必须是JSON数组');
                            if (imported.length > 0 && !imported[0].chapter) throw new Error('缺少必要字段 chapter');
                            resolve(imported);
                        } catch (err) {
                            alert(`文件 "${file.name}" 解析失败: ${err.message}`);
                            resolve(null);
                        }
                    };
                    reader.onerror = () => { alert(`读取文件 "${file.name}" 失败`); resolve(null); };
                    reader.readAsText(file);
                });
            }

            // 解析检查手册HTML为多级结构数据（增强版，支持任意DOCX标题格式 + 表格）
            function parseHandbookHtml(html) {
                const parser = new DOMParser();
                const doc = parser.parseFromString(html, 'text/html');
                const data = [];

                // 当前层级状态
                let cur = { chapter: '', section: '', item: '', subitem: '', content: '' };

                // 检测文本标题级别的正则（按优先级排列）
                const LEVEL_PATTERNS = [
                    // 第1级：第X章 / 一、/ 1. / 1、/ 第一章 / Part I
                    { level: 1, re: /^第[一二三四五六七八九十百千\d]+[章节部分篇]\s*/, maxLen: 60 },
                    { level: 1, re: /^[一二三四五六七八九十]+、/, maxLen: 60 },
                    { level: 1, re: /^\d+[、.．]\s*/, maxLen: 50 },
                    // 第2级：第X节 / (一) / 1.1 / 1.1.1
                    { level: 2, re: /^第[一二三四五六七八九十百千\d]+节\s*/, maxLen: 80 },
                    { level: 2, re: /^[（(][一二三四五六七八九十]+[)）]/, maxLen: 80 },
                    { level: 2, re: /^\d+\.\d+[\s.、]/, maxLen: 80 },
                    // 第3级：(一) / 1) / （1）
                    { level: 3, re: /^\d+[)）]\s*/, maxLen: 100 },
                    // 第4级：(1) / ① / a. / A.
                    { level: 4, re: /^[（(]\d+[)）]/, maxLen: 120 },
                    { level: 4, re: /^[①②③④⑤⑥⑦⑧⑨⑩]/, maxLen: 120 },
                    { level: 4, re: /^[a-zA-Z][.、．)\）]\s*/, maxLen: 120 },
                ];

                function detectLevelByPattern(text) {
                    for (const p of LEVEL_PATTERNS) {
                        if (p.re.test(text) && text.length <= p.maxLen) return p.level;
                    }
                    return 0; // 普通内容
                }

                function detectLevel(el, text) {
                    const tag = el.tagName.toLowerCase();
                    const cls = el.className || '';
                    
                    if (tag === 'h1' || /\bstyle3\b|\bMsoTitle\b/i.test(cls)) return 1;
                    if (tag === 'h2' || /\bstyle4\b|\bMsoHeading1\b/i.test(cls)) return 2;
                    if (tag === 'h3' || /\bstyle5\b|\bMsoHeading2\b/i.test(cls)) return 3;
                    if (tag === 'h4' || /\bstyle6\b|\bMsoHeading3\b/i.test(cls)) return 4;
                    if (tag === 'h5' || tag === 'h6' || /\bstyle7\b|\bMsoHeading4\b/i.test(cls)) return 5;

                    return detectLevelByPattern(text);
                }

                function saveRecord() {
                    if (cur.chapter) {
                        data.push({
                            chapter: cur.chapter,
                            section: cur.section || '',
                            item: cur.item || '',
                            subitem: cur.subitem,
                            content: cur.content.trim()
                        });
                    }
                }

                function resetBelow(level) {
                    if (level <= 1) { cur.section = ''; cur.item = ''; cur.subitem = ''; cur.content = ''; }
                    if (level <= 2) { cur.item = ''; cur.subitem = ''; cur.content = ''; }
                    if (level <= 3) { cur.subitem = ''; cur.content = ''; }
                    if (level <= 4) { cur.content = ''; }
                }

                // 策略：遍历所有块级容器，对每个容器的直接文本内容进行级别判断
                // 使用更广泛的选择器确保不遗漏任何内容
                const BLOCK_TAGS = 'h1,h2,h3,h4,h5,h6,p,div,li,td,th,table';
                const allElements = Array.from(doc.body.querySelectorAll(BLOCK_TAGS));

                // 用已处理集合避免 td 和其父 table 的文本重复
                const processedTexts = new Set();

                allElements.forEach(el => {
                    const tag = el.tagName.toLowerCase();

                    // table 本身不处理文本，只作为结构标记
                    if (tag === 'table') return;

                    // 如果父元素已经被处理过（如 td 的文本已经取过），跳过
                    // 但 h/p/div/li 这些独立块不需要跳过
                    let parentProcessed = false;
                    if (tag === 'td' || tag === 'th') {
                        let p = el.parentElement;
                        while (p && p !== doc.body) {
                            if (processedTexts.has(p)) { parentProcessed = true; break; }
                            p = p.parentElement;
                        }
                    }
                    if (parentProcessed) return;

                    const text = el.textContent.trim();
                    if (!text) return;

                    processedTexts.add(el);

                    const level = detectLevel(el, text);

                    if (level >= 1 && level <= 4) {
                        saveRecord();
                        resetBelow(level);
                        if (level === 1) cur.chapter = text;
                        else if (level === 2) cur.section = text;
                        else if (level === 3) cur.item = text;
                        else if (level === 4) cur.subitem = text;
                    } else {
                        // 普通内容追加到当前记录
                        cur.content += (cur.content ? '\n' : '') + text;
                    }
                });

                saveRecord();

                // 后处理：清理无效记录（chapter存在但section/item/content都为空的）
                // 这些通常是因为标题后紧跟另一个标题产生的空记录
                const cleaned = data.filter(d => {
                    if (!d.chapter) return false;
                    // 有实际内容（section非空、或item非空、或content非空）
                    return d.section || d.item || d.content;
                });

                // 如果清理后为空但有原始数据，保留原始数据（至少有chapter）
                const finalData = cleaned.length > 0 ? cleaned : data;

                // 最终兜底：如果完全没有解析出有效数据
                if (finalData.length === 0) {
                    const paragraphs = doc.body.querySelectorAll('p');
                    let tempChapter = '未分类文档';

                    paragraphs.forEach((p, idx) => {
                        const text = p.textContent.trim();
                        if (text) {
                            finalData.push({
                                chapter: tempChapter,
                                section: '',
                                item: `段落 ${idx + 1}`,
                                subitem: '',
                                content: text
                            });
                        }
                    });
                }

                return finalData;
            }

            // ========== 大纲浏览模式 ==========

            // 数据持久化
            var STORAGE_KEY = 'handbook_fourlevel_v1';
            function saveToStorage() {
                try { localStorage.setItem(STORAGE_KEY, JSON.stringify(handbookData)); } catch(e) {}
            }
            function loadFromStorage() {
                try {
                    var stored = localStorage.getItem(STORAGE_KEY);
                    if (stored) handbookData = JSON.parse(stored);
                } catch(e) { handbookData = []; }
            }

            function updateStats() {
                var t = document.getElementById('handbook-total');
                var s = document.getElementById('handbook-size');
                if (t) t.textContent = handbookData.length;
                if (s) s.textContent = (JSON.stringify(handbookData).length / 1024).toFixed(1) + ' KB';
            }

            window.clearHandbookData = function() {
                if (confirm('确定清空所有手册数据？')) {
                    handbookData = [];
                    updateStats();
                    saveToStorage();
                }
            };

            // 切换浏览模式
            window.hbSwitchView = function(view) {
                document.getElementById("hb-toggleOutline").classList.toggle("active", view === "outline");
                document.getElementById("hb-toggleRules").classList.toggle("active", view === "rules");
                var outlineWrap = document.getElementById("hb-outlineWrap");
                outlineWrap.classList.toggle("active", view === "outline" || view === "rules");
                if (view === "outline") hbBuildOutlineTree();
                if (view === "rules") hbBuildRulesTree();
            };

                        // 构建大纲树
            function hbBuildOutlineTree() {
                const treeEl = document.getElementById('hb-outlineTree');
                const contentEl = document.getElementById('hb-outlineContent');
                if (handbookData.length === 0) {
                    treeEl.innerHTML = '<div class="hb-content-placeholder" style="padding:30px 10px;">暂无数据，请先导入DOCX文档</div>';
                    contentEl.innerHTML = '<div class="hb-content-placeholder">← 点击左侧目录查看内容</div>';
                    return;
                }

                // 构建树形结构
                const tree = [];
                const chapMap = {};   // chapter -> node index in tree
                const secMap = {};    // chapter||section -> node index
                const itemMap = {};   // chapter||section||item -> node index

                handbookData.forEach(entry => {
                    const c = entry.chapter || '', s = entry.section || '';
                    const it = entry.item || '', sub = entry.subitem || '';
                    const cont = entry.content || '';

                    // 确保chapter节点存在
                    if (c && chapMap[c] === undefined) {
                        chapMap[c] = tree.length;
                        tree.push({ level: 0, label: c, children: [], chapter: c, section: '', item: '', subitem: '' });
                    }
                    const chapIdx = chapMap[c];
                    if (!s) {
                        // 无section，内容挂在chapter下
                        if (cont) tree[chapIdx].children.push({ level: 3, label: it || '内容', children: [], chapter: c, section: s, item: it, subitem: sub, content: cont });
                        return;
                    }

                    const k1 = c + '||' + s;
                    if (secMap[k1] === undefined) {
                        secMap[k1] = tree[chapIdx].children.length;
                        tree[chapIdx].children.push({ level: 1, label: s, children: [], chapter: c, section: s, item: '', subitem: '' });
                    }
                    const secIdx = secMap[k1];
                    const secNode = tree[chapIdx].children[secIdx];

                    if (!it) return;

                    const k2 = k1 + '||' + it;
                    if (itemMap[k2] === undefined) {
                        itemMap[k2] = secNode.children.length;
                        secNode.children.push({ level: 2, label: it, children: [], chapter: c, section: s, item: it, subitem: '' });
                    }
                    const itemIdx = itemMap[k2];
                    const itemNode = secNode.children[itemIdx];

                    if (sub) {
                        itemNode.children.push({ level: 3, label: sub, children: [], chapter: c, section: s, item: it, subitem: sub, content: cont });
                    } else if (cont) {
                        itemNode.content = itemNode.content ? itemNode.content + '\n' + cont : cont;
                    }
                });

                // 渲染树
                function countLeaves(node) {
                    if (node.children.length === 0) return 1;
                    return node.children.reduce((sum, c) => sum + countLeaves(c), 0);
                }

                function renderNode(node) {
                    const hasChildren = node.children.length > 0;
                    const leafCount = countLeaves(node);
                    let html = '<div class="hb-tree-node hb-tree-level-' + node.level + '">';

                    html += '<div class="hb-tree-header" data-chapter="' + _esc(node.chapter) + '" data-section="' + _esc(node.section) + '" data-item="' + _esc(node.item) + '" data-subitem="' + _esc(node.subitem) + '">';
                    html += '<span class="hb-tree-arrow ' + (hasChildren ? '' : 'hidden') + '">▶</span>';
                    html += '<span class="hb-tree-label" title="' + _esc(node.label) + '">' + _esc(node.label) + '</span>';
                    if (hasChildren) html += '<span class="hb-tree-count">' + leafCount + '</span>';
                    html += '</div>';

                    if (hasChildren) {
                        html += '<div class="hb-tree-children">';
                        node.children.forEach(child => { html += renderNode(child); });
                        html += '</div>';
                    }
                    html += '</div>';
                    return html;
                }

                let treeHtml = '';
                tree.forEach(node => { treeHtml += renderNode(node); });
                treeEl.innerHTML = treeHtml || '<div class="hb-content-placeholder">暂无数据</div>';
                contentEl.innerHTML = '<div class="hb-content-placeholder">← 点击左侧目录查看内容</div>';

                // 绑定点击事件
                treeEl.querySelectorAll('.hb-tree-header').forEach(header => {
                    header.addEventListener('click', function(e) {
                        e.stopPropagation();
                        const node = this.closest('.hb-tree-node');

                        // 折叠/展开
                        const arrow = this.querySelector('.hb-tree-arrow');
                        const children = node.querySelector('.hb-tree-children');
                        if (children) {
                            const isExpanded = children.classList.contains('expanded');
                            children.classList.toggle('expanded');
                            if (arrow) arrow.classList.toggle('expanded');
                        }

                        // 显示内容
                        const chapter = this.dataset.chapter;
                        const section = this.dataset.section;
                        const item = this.dataset.item;
                        const subitem = this.dataset.subitem;

                        // 高亮选中
                        treeEl.querySelectorAll('.hb-tree-header.selected').forEach(h => h.classList.remove('selected'));
                        this.classList.add('selected');

                        // 查找该节点对应的所有内容
                        let contents = [];
                        if (subitem) {
                            contents = handbookData.filter(d => d.chapter === chapter && d.section === section && d.item === item && d.subitem === subitem);
                        } else if (item) {
                            contents = handbookData.filter(d => d.chapter === chapter && d.section === section && d.item === item);
                        } else if (section) {
                            contents = handbookData.filter(d => d.chapter === chapter && d.section === section);
                        } else if (chapter) {
                            contents = handbookData.filter(d => d.chapter === chapter);
                        }

                        // 渲染内容
                        let pathHtml = '';
                        if (chapter) pathHtml += '<span class="path-chapter">' + _esc(chapter) + '</span>';
                        if (section) pathHtml += '<span class="path-section">' + _esc(section) + '</span>';
                        if (item) pathHtml += '<span class="path-item">' + _esc(item) + '</span>';
                        if (subitem) pathHtml += '<span class="path-subitem">' + _esc(subitem) + '</span>';

                        let bodyHtml = '';
                        contents.forEach(d => {
                            if (d.subitem && d.content) {
                                bodyHtml += '<div style="margin-bottom:12px;"><strong style="color:var(--primary);">' + _esc(d.subitem) + '</strong>\n' + _esc(d.content).replace(/\n/g, '<br>') + '</div>';
                            } else if (d.content) {
                                bodyHtml += '<div style="margin-bottom:8px;">' + _esc(d.content).replace(/\n/g, '<br>') + '</div>';
                            }
                        });

                        if (!bodyHtml) bodyHtml = '<span style="color:#94a3b8;">（无详细内容，请展开子项查看）</span>';

                        contentEl.innerHTML = '<div class="hb-content-path">' + pathHtml + '</div><div class="hb-content-text">' + bodyHtml + '</div>';

                        // 手机端：点击后自动滚动到内容区
                        if (window.innerWidth <= 600) {
                            contentEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
                        }
                    });
                });

                // 默认全部折叠

            }

            // 构建规章制度树（直接读取规章制度模块数据，不导入到检查手册）
            function hbBuildRulesTree() {
                const treeEl = document.getElementById('hb-outlineTree');
                const contentEl = document.getElementById('hb-outlineContent');

                // 从规章制度模块获取实时数据
                const rulesData = (typeof window.getRulesData === 'function') ? window.getRulesData() : [];
                if (!rulesData || rulesData.length === 0) {
                    treeEl.innerHTML = '<div class="hb-content-placeholder" style="padding:30px 10px;">规章制度模块中暂无数据，请先在规章制度模块导入文件</div>';
                    contentEl.innerHTML = '<div class="hb-content-placeholder">← 点击左侧目录查看内容</div>';
                    return;
                }

                // 构建树形结构：按 trade 分组，每个 trade 下面是 title 列表
                const tree = [];
                const tradeMap = {}; // trade -> node index in tree

                rulesData.forEach((rule, idx) => {
                    const trade = rule.trade || '未分类';
                    const title = rule.title || '无标题';

                    if (tradeMap[trade] === undefined) {
                        tradeMap[trade] = tree.length;
                        tree.push({ level: 0, label: trade, children: [], trade: trade, ruleIdx: -1 });
                    }
                    const tradeIdx = tradeMap[trade];
                    tree[tradeIdx].children.push({ level: 1, label: title, children: [], trade: trade, ruleIdx: idx, title: title });
                });

                // 渲染树
                function countLeaves(node) {
                    if (node.children.length === 0) return 1;
                    return node.children.reduce((sum, c) => sum + countLeaves(c), 0);
                }

                function renderNode(node) {
                    const hasChildren = node.children.length > 0;
                    const leafCount = countLeaves(node);
                    let html = '<div class="hb-tree-node hb-tree-level-' + node.level + '">';
                    html += '<div class="hb-tree-header" data-trade="' + _esc(node.trade) + '" data-rule-idx="' + node.ruleIdx + '" data-title="' + _esc(node.title || '') + '">';
                    html += '<span class="hb-tree-arrow ' + (hasChildren ? '' : 'hidden') + '">▶</span>';
                    html += '<span class="hb-tree-label" title="' + _esc(node.label) + '">' + _esc(node.label) + '</span>';
                    if (hasChildren) html += '<span class="hb-tree-count">' + leafCount + '</span>';
                    html += '</div>';

                    if (hasChildren) {
                        html += '<div class="hb-tree-children">';
                        node.children.forEach(child => { html += renderNode(child); });
                        html += '</div>';
                    }
                    html += '</div>';
                    return html;
                }

                let treeHtml = '';
                tree.forEach(node => { treeHtml += renderNode(node); });
                treeEl.innerHTML = treeHtml || '<div class="hb-content-placeholder">暂无数据</div>';
                contentEl.innerHTML = '<div class="hb-content-placeholder">← 点击左侧目录查看全文</div>';

                // 绑定点击事件
                treeEl.querySelectorAll('.hb-tree-header').forEach(header => {
                    header.addEventListener('click', function(e) {
                        e.stopPropagation();

                        // 折叠/展开
                        const arrow = this.querySelector('.hb-tree-arrow');
                        const children = this.parentElement.querySelector('.hb-tree-children');
                        if (children) {
                            children.classList.toggle('expanded');
                            if (arrow) arrow.classList.toggle('expanded');
                        }

                        // 高亮选中
                        treeEl.querySelectorAll('.hb-tree-header.selected').forEach(h => h.classList.remove('selected'));
                        this.classList.add('selected');

                        const ruleIdx = parseInt(this.dataset.ruleIdx);
                        const trade = this.dataset.trade;
                        const title = this.dataset.title;

                        // 叶子节点（具体规章）→ 全文查看
                        if (!isNaN(ruleIdx) && ruleIdx >= 0 && typeof window.ruleViewFullText === 'function') {
                            // 显示路径
                            let pathHtml = '<span class="path-chapter">📖 规章制度</span>';
                            pathHtml += '<span class="path-section">' + _esc(trade) + '</span>';
                            if (title) pathHtml += '<span class="path-item">' + _esc(title) + '</span>';
                            contentEl.innerHTML = '<div class="hb-content-path">' + pathHtml + '</div>' +
                                '<div class="hb-content-text" style="text-align:center;padding:20px;">' +
                                '<button class="btn btn-info" onclick="ruleViewFullText(' + ruleIdx + ')">📄 查看全文</button>' +
                                '</div>';
                        } else {
                            // 分支节点（trade）→ 显示该专业下所有规章概要
                            let pathHtml = '<span class="path-chapter">📖 规章制度</span>';
                            pathHtml += '<span class="path-section">' + _esc(trade) + '</span>';

                            const latestData = (typeof window.getRulesData === 'function') ? window.getRulesData() : [];
                            const tradeRules = latestData.filter(r => (r.trade || '未分类') === trade);

                            let bodyHtml = '';
                            tradeRules.forEach((r, i) => {
                                const origIdx = latestData.indexOf(r);
                                bodyHtml += '<div style="margin-bottom:10px;display:flex;align-items:center;gap:8px;">';
                                bodyHtml += '<span style="flex:1;color:var(--info);cursor:pointer;text-decoration:underline;" onclick="ruleViewFullText(' + origIdx + ')">' + _esc(r.title || '无标题') + '</span>';
                                bodyHtml += '<span style="color:#94a3b8;font-size:0.85em;">' + (r.content || '').length + '字</span>';
                                bodyHtml += '<button class="btn btn-info btn-small" onclick="ruleViewFullText(' + origIdx + ')">📄 查看</button>';
                                bodyHtml += '</div>';
                            });

                            if (!bodyHtml) bodyHtml = '<span style="color:#94a3b8;">（无内容）</span>';
                            contentEl.innerHTML = '<div class="hb-content-path">' + pathHtml + '</div><div class="hb-content-text">' + bodyHtml + '</div>';
                        }

                        // 手机端：点击后自动滚动到内容区
                        if (window.innerWidth <= 600) {
                            contentEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
                        }
                    });
                });
            }

            loadFromStorage();
            updateStats();

            // 暴露 handbook 数据供其他模块调用（如智能助手联动）
            window.getHandbookData = function() { return handbookData; };

            window.exportHandbook = function() {
                if (handbookData.length === 0) { alert('没有数据可导出'); return; }
                window.showProgress(50, '正在导出检查手册…');
                var dataStr = JSON.stringify(handbookData, null, 2);
                var blob = new Blob([dataStr], { type: 'application/json' });
                var url = URL.createObjectURL(blob);
                var a = document.createElement('a');
                a.href = url;
                a.download = '安全检查手册_' + new Date().toISOString().slice(0,10) + '.json';
                a.click();
                URL.revokeObjectURL(url);
                window.finishProgress('✅ 检查手册导出成功');
            };
        })();
