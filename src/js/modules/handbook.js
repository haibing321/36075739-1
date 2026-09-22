// 来源：C:/Users/asus/Desktop/index.html 第7315-8266行 | 检查手册模块

        // ========== 第六模块：检查手册 (四级目录) ==========
        (function() {
            let handbookData = [];
            let chapters = [];
            let sectionsMap = {};
            let itemsMap = {};
            let subItemsMap = {};
            let contentMap = {};

            /**
             * 【2026-09-22 用户需求】「事故案例」= 与检查手册**平行**的第二份数据。
             *   导入原理与手册完全一致：同一套解析（docx/json/txt/md → 章/节/条/款四级路径）、
             *   同一套去重键（四级路径 + 正文前 50 字）、多文件**追加合并互不覆盖**。
             *   两份数据**完全隔离**（各占一个 localStorage 键、各自的大纲与检索），互不影响。
             * 大纲浏览栏由此多出第三个视图：检查手册 / 事故案例 / 规章制度。
             */
            let accidentData = [];
            var HB_SETS = {
                handbook: { key: 'handbook_fourlevel_v1', label: '检查手册', kb: 'handbook', btn: 'hb-toggleOutline',
                            get: function () { return handbookData; }, set: function (v) { handbookData = v; } },
                cases:    { key: 'accident_fourlevel_v1', label: '事故案例', kb: 'accidents', btn: 'hb-toggleCases',
                            get: function () { return accidentData; }, set: function (v) { accidentData = v; } }
            };
            var _hbActive = 'handbook';      // 当前数据集（导入目标 + 大纲/检索视图共用）
            function _hbCur() { return HB_SETS[_hbActive] || HB_SETS.handbook; }
            function _hbGet() { try { return _hbCur().get() || []; } catch (e) { return []; } }
            function _hbPut(v) { _hbCur().set(v); }

            // 注：handbook-total / handbook-size / handbook-storageBar 三个元素已随
            // 「储存量统一在设置面板展示」的改版从 index.html 移除（updateStats 也已清空逻辑）。
            // 原先在模块顶部无条件 getElementById 并保留引用，取到的恒为 null 且从未使用，属死代码，已删除。

            // 本模块用的 HTML 转义
            function _esc(text) { if (!text) return ''; return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }

            // ========== 导入确认通用函数 ==========
            // 手册记录去重键（按章节路径 + 内容前50字）
            function _hbKeyOf(d) {
                return [d.chapter, d.section, d.item, d.subitem, (d.content || '').slice(0, 50)].join('||');
            }

            /**
             * 【2026-09-22】解析结果归一化：每条都补非空 chapter（其余字段补空串）。
             *   为什么必须做："有节/条但没章"的数据会让大纲树拿不到章节点
             *   （`tree[undefined].children` 抛异常 → **整个大纲视图空白**）。只补空值、不改已有内容。
             */
            function _hbNormalize(rows) {
                (rows || []).forEach(function (r) {
                    if (!r) return;
                    if (!r.chapter) r.chapter = '未分类';
                    ['section', 'item', 'subitem', 'content'].forEach(function (k) { if (r[k] == null) r[k] = ''; });
                });
                return rows;
            }

            function _showImportConfirm(count, importedData) {
                const modal = document.getElementById('handbook-importModal');
                const _setName = _hbCur().label;
                document.getElementById('handbook-importMessage').innerText =
                    `${_setName}：成功解析 ${count} 条记录。\n当前已有 ${_hbGet().length} 条。\n可选择「追加合并」或「覆盖现有」。`;
                modal.classList.add('active');

                // 追加合并
                document.getElementById('handbook-confirmImport').onclick = () => {
                    const prev = _hbGet();                           // 【2026-09-21】写失败回滚基线
                    try {
                        const seen = new Set(_hbGet().map(_hbKeyOf));
                        const fresh = importedData.filter(d => { const k = _hbKeyOf(d); if (seen.has(k)) return false; seen.add(k); return true; });
                        _hbPut(_hbGet().concat(fresh));
                        updateStats();
                        if (!saveToStorage()) { _hbPut(prev); updateStats(); return; }   // 写失败：回滚 + 保留弹窗（已 toast 说明）
                        closeModal('handbook-importModal');
                        if (fresh.length < importedData.length) console.log('[' + _setName + '导入] 已跳过 ' + (importedData.length - fresh.length) + ' 条重复记录');
                        hbAfterImport(fresh.length, importedData.length);
                    } catch(e) {
                        console.error('手册追加失败:', e);
                        _hbPut(prev); updateStats();
                        closeModal('handbook-importModal');
                        alert('导入失败: ' + e.message);
                    }
                };
                // 覆盖现有
                document.getElementById('handbook-confirmOverwrite').onclick = () => {
                    const prev = _hbGet();                           // 同上
                    try {
                        _hbPut(importedData);
                        updateStats();
                        if (!saveToStorage()) { _hbPut(prev); updateStats(); return; }
                        closeModal('handbook-importModal');
                        hbAfterImport(importedData.length, importedData.length);
                    } catch(e) {
                        console.error('手册覆盖失败:', e);
                        _hbPut(prev); updateStats();
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

            var _hbParsing = false;   // 【2026-09-21】解析互斥：解析中再次点导入会被拒，避免两批文件交叉写库（两个数据集共用一把锁）
            /**
             * 【2026-09-22】检查手册 / 事故案例 **共用同一条导入管线**（用户要求"导入原理完全一致"）：
             *   解析（docx/json/txt/md → 四级路径）、进度、互斥、追加/覆盖确认、收尾刷新全都走这里，
             *   唯一不同是"落到哪个数据集"—— 绑定入口时把 `_hbActive` 切过去即可。
             */
            function _hbBindImport(inputId, setName) {
            document.getElementById(inputId).addEventListener('change', async function(e) {
                if (HB_SETS[setName]) _hbActive = setName;   // 本次导入落到该数据集（大纲视图也一并切过去）
                const files = Array.from(e.target.files);
                if (files.length === 0) { e.target.value = ''; return; }
                if (_hbParsing) {
                    e.target.value = '';
                    if (typeof window.showToast === 'function') window.showToast('上一批' + _hbCur().label + '还在解析中，请稍候…', true, 5000); else alert('正在解析中');
                    return;
                }
                _hbParsing = true;

                // 【2026-09-21】原来 `if (allImported.length === 0) return;` 在 `e.target.value=''` **之前**：
                //   任何解析失败（.doc 不受支持 / mammoth 未加载 / JSON 结构不符）都会让 input 保留旧值 →
                //   用户再选**同一个文件**不会触发 change，表现是"点了导入毫无反应"。
                const allImported = [];
                const skipped = [];
                try { window.showProgress(5, '正在解析' + _hbCur().label + '文件…'); } catch (e0) {}
                for (let _fi = 0; _fi < files.length; _fi++) {
                    const file = files[_fi];
                    // 【2026-09-21】手册解析此前**完全没有进度**：几百页 docx 解析时界面像死机（用户以为点了没反应）
                    try { window.showProgress(5 + Math.round((_fi / files.length) * 90), '正在解析 ' + (_fi + 1) + '/' + files.length + '：' + file.name); } catch (e0b) {}
                    const fileName = file.name.toLowerCase();
                    try {
                        if (fileName.endsWith('.docx')) {
                            const parsed = await _parseDocxFile(file);
                            if (parsed && parsed.length) { _hbNormalize(parsed); allImported.push(...parsed); }
                            else skipped.push(file.name + '：未识别到四级标题结构（或解析组件未加载）');
                        } else if (fileName.endsWith('.doc')) {
                            skipped.push(file.name + '：不支持老版 .doc，请另存为 .docx');
                        } else if (fileName.endsWith('.json')) {
                            const parsed = await _parseJsonFile(file);
                            if (parsed && parsed.length) { _hbNormalize(parsed); allImported.push(...parsed); }
                            else skipped.push(file.name + '：JSON 结构不符（每条记录需含 chapter 字段）');
                        } else if (/\.(txt|md|markdown)$/.test(fileName)) {
                            // 【2026-09-21 新增】纯文本 / Markdown 手册（GBK 也能读），按四级标题识别
                            const parsed = await _parseTextFile(file);
                            if (parsed && parsed.length) { _hbNormalize(parsed); allImported.push(...parsed); }
                            else skipped.push(file.name + '：未识别到任何内容（空文件？）');
                        } else {
                            skipped.push(file.name + '：不支持的格式（支持 .docx / .json / .txt / .md）');
                        }
                    } catch (fe) { skipped.push(file.name + '：' + ((fe && fe.message) || '解析异常')); }
                }
                try { window.hideProgress(); } catch (e1) {}
                e.target.value = '';   // 无论成功/失败都复位，保证同一文件可重试
                _hbParsing = false;    // 解析结束即解锁（后面的"追加/覆盖"确认不再持锁）

                if (allImported.length === 0) {
                    var msg = '❌ 未解析到任何' + _hbCur().label + '内容：\n' + (skipped.length ? skipped.join('\n') : '（文件为空）');
                    if (typeof window.showToast === 'function') window.showToast(msg, true, 11000); else alert(msg);
                    return;
                }
                if (skipped.length) {
                    try { if (typeof window.showToast === 'function') window.showToast('⚠️ 部分文件未导入：\n' + skipped.join('\n'), true, 10000); } catch (e2) {}
                }
                _showImportConfirm(allImported.length, allImported);
            });
            }
            // 两个入口：设置面板的「检查手册 导入」与「事故案例 导入」，走同一条管线
            _hbBindImport('handbook-jsonFile', 'handbook');
            _hbBindImport('accident-jsonFile', 'cases');

            // 解析单个DOCX文件
            var LIB_MAMMOTH_HB = 'src/js/vendor/mammoth.browser.min.js';

            async function _parseDocxFile(file) {
                // 用 requireLib：直接 await loadScript 在离线时抛错，
                // 调用方若无 catch 会导致整个导入流程中断且 input 未复位（同一文件无法再次选择）
                if (!(await window.requireLib(LIB_MAMMOTH_HB, { feature: 'Word 导入' }))) return null;
                if (typeof mammoth === 'undefined') {
                    alert('mammoth 库未加载，请检查网络连接');
                    return null;
                }
                try {
                    const arrayBuffer = await file.arrayBuffer();
                    const result = await mammoth.convertToHtml({ arrayBuffer });
                                        const parsedData = parseHandbookHtml(result.value);

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
            // 【2026-09-21】「标题级别识别」提到模块作用域：DOCX / HTML 与新增的**纯文本 / Markdown** 手册共用同一套规则
            const LEVEL_PATTERNS = [
                // 第1级：第X章 / 一、/ 1. / 1、/ 第一章 / Part I
                { level: 1, re: /^第[一二三四五六七八九十百千\d]+[章节部分篇]\s*/, maxLen: 60 },
                { level: 1, re: /^[一二三四五六七八九十]+、/, maxLen: 60 },
                // 末尾加 (?!\d)：否则 "1.1 安全责任" 会被这条先吃掉判成一级，
                // 四级目录（章/节/条/款）整体塌成两级
                { level: 1, re: /^\d+[、.．](?!\d)\s*/, maxLen: 50 },
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

            /**
             * 【2026-09-21 新增】纯文本 / Markdown 手册解析。
             *   复用 docx 那套 `LEVEL_PATTERNS`（章/节/条/款）：
             *   - Markdown：`#`/`##`/`###`/`####` 直接当 1~4 级（比正则更明确）；
             *   - 纯文本：按行用 LEVEL_PATTERNS 猜级别，非标题行累积进 content；
             *   - 编码：走 `dsReadTextFileAutoEnc` 自动择码（Windows 记事本另存常是 GBK）。
             */
            async function _parseTextFile(file) {
                const raw = (typeof window.dsReadTextFileAutoEnc === 'function')
                    ? await window.dsReadTextFileAutoEnc(file)
                    : await file.text();
                const lines = String(raw || '').replace(/\r\n?/g, '\n').split('\n');
                const data = [];
                let cur = { chapter: '', section: '', item: '', subitem: '', content: '' };
                function push() {
                    const content = String(cur.content || '').trim();
                    if (cur.chapter || cur.section || cur.item || cur.subitem) {
                        data.push({ chapter: cur.chapter, section: cur.section, item: cur.item, subitem: cur.subitem, content: content });
                    } else if (content) {
                        data.push({ chapter: '未分类', section: '', item: '', subitem: '', content: content });
                    }
                    cur = { chapter: '', section: '', item: '', subitem: '', content: '' };
                }
                for (const line of lines) {
                    const t = String(line).trim();
                    if (!t) continue;
                    const md = t.match(/^(#{1,6})\s+(.*)$/);
                    let lv = 0, title = t;
                    if (md) { lv = Math.min(md[1].length, 4); title = md[2].trim(); }
                    else lv = detectLevelByPattern(t);
                    if (lv >= 1 && lv <= 4) {
                        push();
                        if (lv === 1) cur.chapter = title;
                        else if (lv === 2) cur.section = title;
                        else if (lv === 3) cur.item = title;
                        else cur.subitem = title;
                    } else {
                        cur.content = cur.content ? (cur.content + '\n' + t) : t;
                    }
                }
                push();
                return data;
            }

            function parseHandbookHtml(html) {
                const parser = new DOMParser();
                const doc = parser.parseFromString(html, 'text/html');
                const data = [];

                // 当前层级状态
                let cur = { chapter: '', section: '', item: '', subitem: '', content: '' };

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
            // 内容 Markdown 渲染（复用对话模块的解析器，带兜底）
            function _hbMd(text) {
                if (typeof window.dsMarkdown === 'function') return window.dsMarkdown(text || '');
                return _esc(text || '').replace(/\n/g, '<br>');
            }

            // 显示某节点内容（大纲点击与搜索复用）
            function _hbShowContent(chapter, section, item, subitem) {
                const contentEl = document.getElementById('hb-outlineContent');
                let contents = [];
                // 【2026-09-22】按**当前数据集**取正文（检查手册 / 事故案例共用本函数）
                var _src = _hbGet();
                if (subitem) {
                    contents = _src.filter(d => d.chapter === chapter && d.section === section && d.item === item && d.subitem === subitem);
                } else if (item) {
                    contents = _src.filter(d => d.chapter === chapter && d.section === section && d.item === item);
                } else if (section) {
                    contents = _src.filter(d => d.chapter === chapter && d.section === section);
                } else if (chapter || chapter === '未分类') {
                    // 【2026-09-22】'未分类' 是大纲树对"没有章"的记录用的兜底标签 —— 这里要按"章为空"来过滤
                    contents = _src.filter(d => d.chapter === chapter || (chapter === '未分类' && !d.chapter));
                }

                let pathHtml = '';
                if (chapter) pathHtml += '<span class="path-chapter">' + _esc(chapter) + '</span>';
                if (section) pathHtml += '<span class="path-section">' + _esc(section) + '</span>';
                if (item) pathHtml += '<span class="path-item">' + _esc(item) + '</span>';
                if (subitem) pathHtml += '<span class="path-subitem">' + _esc(subitem) + '</span>';

                let bodyHtml = '';
                contents.forEach(d => {
                    if (d.subitem && d.content) {
                        bodyHtml += '<div style="margin-bottom:12px;"><strong style="color:var(--primary);">' + _esc(d.subitem) + '</strong><br>' + _hbMd(d.content) + '</div>';
                    } else if (d.content) {
                        bodyHtml += '<div style="margin-bottom:8px;">' + _hbMd(d.content) + '</div>';
                    }
                });

                if (!bodyHtml) bodyHtml = '<span style="color:#94a3b8;">（无详细内容，请展开子项查看）</span>';
                contentEl.innerHTML = '<div class="hb-content-path">' + pathHtml + '</div><div class="hb-content-text">' + bodyHtml + '</div>';
            }

            // 站内搜索：根据当前视图检索对应数据（大纲视图搜手册 / 规章制度视图搜规章）
            window.hbSearch = function(keyword) {
                const treeEl = document.getElementById('hb-outlineTree');
                const contentEl = document.getElementById('hb-outlineContent');
                const infoEl = document.getElementById('hb-searchInfo');
                const kw = (keyword || '').trim().toLowerCase();
                // 【2026-09-22】大纲 / 事故案例都是"数据集视图"（区别只在 _hbActive 指向谁）；
                //   原来只判断 hb-toggleOutline 是否 active → 在事故案例视图里搜索会错走"规章速查"分支
                const isOutline = !document.getElementById('hb-toggleRules').classList.contains('active');
                if (!kw) {
                    if (infoEl) infoEl.style.display = 'none';
                    if (isOutline) hbBuildOutlineTree(); else hbBuildRulesTree();
                    return;
                }

                if (isOutline) {
                    // ===== 数据集视图（检查手册 / 事故案例）：检索当前数据集 =====
                    var _ds = _hbGet(), _dsLabel = _hbCur().label;
                    if (!_ds.length) {
                        if (infoEl) { infoEl.style.display = 'block'; infoEl.textContent = _dsLabel + '数据为空'; }
                        treeEl.innerHTML = '<div class="hb-content-placeholder" style="padding:30px 10px;">📭 尚未导入' + _esc(_dsLabel) + '数据，请先在「设置」面板中导入 DOCX / JSON 文档</div>';
                        contentEl.innerHTML = '<div class="hb-content-placeholder">← 点击上方结果查看内容</div>';
                        return;
                    }
                    const matched = _ds.filter(d => [d.chapter, d.section, d.item, d.subitem, d.content].filter(Boolean).join(' ').toLowerCase().indexOf(kw) !== -1);
                    if (infoEl) { infoEl.style.display = 'block'; infoEl.textContent = _dsLabel + '命中 ' + matched.length + ' 条'; }
                    if (matched.length === 0) {
                        treeEl.innerHTML = '<div class="hb-content-placeholder" style="padding:30px 10px;">未找到与「' + _esc(keyword) + '」相关的' + _esc(_dsLabel) + '内容</div>';
                        contentEl.innerHTML = '<div class="hb-content-placeholder">← 点击上方结果查看内容</div>';
                        return;
                    }
                    let html = '';
                    matched.slice(0, 50).forEach(function(d) {
                        const path = [d.chapter, d.section, d.item, d.subitem].filter(Boolean).join(' › ');
                        html += '<div class="hb-search-item" data-chapter="' + _esc(d.chapter) + '" data-section="' + _esc(d.section) + '" data-item="' + _esc(d.item) + '" data-subitem="' + _esc(d.subitem) + '" style="padding:10px 12px;border-bottom:1px solid #eef2f7;cursor:pointer;">'
                            + '<div style="font-size:0.8rem;color:#64748b;">' + _esc(path) + '</div>'
                            + '<div style="font-size:0.85rem;color:#1e293b;margin-top:2px;">' + _esc((d.content || '').slice(0, 80)) + '</div>'
                            + '</div>';
                    });
                    if (matched.length > 50) html += '<div style="padding:10px;color:#94a3b8;font-size:0.8rem;">仅显示前50条，请缩小关键词</div>';
                    treeEl.innerHTML = html;
                    contentEl.innerHTML = '<div class="hb-content-placeholder">← 点击上方结果查看内容</div>';
                    treeEl.querySelectorAll('.hb-search-item').forEach(function(it) {
                        it.addEventListener('click', function() {
                            treeEl.querySelectorAll('.hb-search-item.selected').forEach(x => x.classList.remove('selected'));
                            this.classList.add('selected');
                            _hbShowContent(this.dataset.chapter, this.dataset.section, this.dataset.item, this.dataset.subitem);
                            if (window.innerWidth <= 600) contentEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
                        });
                    });
                    return;
                }

                // ===== 规章制度视图：检索规章制度数据 =====
                const rules = (typeof window.getRulesData === 'function') ? window.getRulesData() : [];
                if (!rules.length) {
                    if (infoEl) { infoEl.style.display = 'block'; infoEl.textContent = '规章制度数据为空'; }
                    treeEl.innerHTML = '<div class="hb-content-placeholder" style="padding:30px 10px;">📭 规章制度模块暂无数据，请先在「规章制度」模块导入文件</div>';
                    contentEl.innerHTML = '<div class="hb-content-placeholder">← 点击上方结果查看内容</div>';
                    return;
                }
                const matched = rules.filter(r => [r.trade, r.title, r.content, r.fileNumber, r.article].filter(Boolean).join(' ').toLowerCase().indexOf(kw) !== -1);
                if (infoEl) { infoEl.style.display = 'block'; infoEl.textContent = '命中 ' + matched.length + ' 条'; }
                if (matched.length === 0) {
                    treeEl.innerHTML = '<div class="hb-content-placeholder" style="padding:30px 10px;">未找到与「' + _esc(keyword) + '」相关的规章制度</div>';
                    contentEl.innerHTML = '<div class="hb-content-placeholder">← 点击上方结果查看内容</div>';
                    return;
                }
                let html = '';
                matched.slice(0, 50).forEach(function(r) {
                    const origIdx = rules.indexOf(r);
                    const path = [r.trade, r.title].filter(Boolean).join(' › ');
                    html += '<div class="hb-search-item" data-rule-idx="' + origIdx + '" style="padding:10px 12px;border-bottom:1px solid #eef2f7;cursor:pointer;">'
                        + '<div style="font-size:0.8rem;color:#64748b;">' + _esc(path) + '</div>'
                        + '<div style="font-size:0.85rem;color:#1e293b;margin-top:2px;">' + _esc((r.content || '').slice(0, 80)) + '</div>'
                        + '</div>';
                });
                if (matched.length > 50) html += '<div style="padding:10px;color:#94a3b8;font-size:0.8rem;">仅显示前50条，请缩小关键词</div>';
                treeEl.innerHTML = html;
                contentEl.innerHTML = '<div class="hb-content-placeholder">← 点击上方结果查看内容</div>';
                treeEl.querySelectorAll('.hb-search-item').forEach(function(it) {
                    it.addEventListener('click', function() {
                        treeEl.querySelectorAll('.hb-search-item.selected').forEach(x => x.classList.remove('selected'));
                        this.classList.add('selected');
                        const ri = parseInt(this.dataset.ruleIdx, 10);
                        if (typeof window.ruleViewFullText === 'function') window.ruleViewFullText(ri);
                        if (window.innerWidth <= 600) contentEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
                    });
                });
            };

            window.hbClearSearch = function() {
                const el = document.getElementById('hb-searchInput');
                if (el) el.value = '';
                window.hbSearch('');
            };


            // 数据持久化（手册每个数据集一个键：handbook_fourlevel_v1 / accident_fourlevel_v1）
            var STORAGE_KEY = 'handbook_fourlevel_v1';
            /**
             * 【2026-09-21】返回"是否写入成功"。原实现空 catch 静默吞错：
             *   localStorage 配额满时弹窗照常关闭、界面显示已导入，**刷新后数据全丢**，用户完全无感。
             * 【2026-09-22】按**当前数据集**写入（检查手册 / 事故案例各写各的键，互不影响）。
             */
            function saveToStorage() {
                var cur = _hbCur();
                try {
                    localStorage.setItem(cur.key, JSON.stringify(cur.get() || []));
                    return true;
                } catch (e) {
                    console.error('[' + cur.label + '] 写入失败：', e);
                    try {
                        var msg = '⚠️ ' + cur.label + '数据写入失败（可能存储空间不足）：' + ((e && e.message) || '未知错误') + '；本次导入未生效，请清理空间后重试。';
                        if (typeof window.showToast === 'function') window.showToast(msg, true, 10000); else alert(msg);
                    } catch (e2) {}
                    return false;
                }
            }

            /** 【2026-09-21】导入成功后的统一收尾：重建视图 + 失效检索索引 + 非阻塞成功提示 */
            function hbAfterImport(added, parsedTotal) {
                var cur = _hbCur();
                try {
                    // 导入后把大纲视图切到该数据集（三个 tab：检查手册 / 事故案例 / 规章制度）
                    var btn = document.getElementById(cur.btn);
                    if (btn && typeof window.hbSwitchView === 'function') window.hbSwitchView(cur === HB_SETS.cases ? 'cases' : 'outline');
                    // 原实现导入后不重建视图 → 大纲仍显示"暂无数据，请先导入DOCX文档"
                    else hbBuildOutlineTree();
                } catch (e) { console.warn('[' + cur.label + '] 重建视图失败：', e && e.message); }
                try { if (typeof window.dsInvalidateRagCache === 'function') window.dsInvalidateRagCache(cur.kb); } catch (e) {}
                try { if (typeof window.updateDataManagementStats === 'function') window.updateDataManagementStats(); } catch (e) {}
                var skipped = Math.max(0, (parsedTotal || 0) - (added || 0));
                var msg = '✅ ' + cur.label + '已导入 ' + added + ' 条' + (skipped ? '（跳过重复 ' + skipped + ' 条）' : '') + '，当前共 ' + (cur.get() || []).length + ' 条';
                if (typeof window.showToast === 'function') window.showToast(msg, false, 6000); else alert(msg);
            }
            /** 两个数据集都读（启动时各读各的键） */
            function loadFromStorage() {
                Object.keys(HB_SETS).forEach(function (name) {
                    var s = HB_SETS[name];
                    try {
                        var stored = localStorage.getItem(s.key);
                        s.set(stored ? (JSON.parse(stored) || []) : []);
                    } catch (e) { s.set([]); }
                });
            }

            // 储存/数量展示已移除（统一在设置面板显示「总储存量」）
            function updateStats() {
                // 原逻辑渲染 handbook-total / handbook-size，已移除
            }

            /** 【2026-09-22】清空某一个数据集（手册 / 事故案例各清各的，互不牵连） */
            function _hbClearSet(setName) {
                var s = HB_SETS[setName] || HB_SETS.handbook;
                if (!confirm('确定清空所有' + s.label + '数据？')) return;
                _hbActive = setName;
                s.set([]);
                updateStats();
                saveToStorage();
                try {
                    if (document.getElementById(s.btn) && typeof window.hbSwitchView === 'function') {
                        window.hbSwitchView(setName === 'cases' ? 'cases' : 'outline');
                    } else { hbBuildOutlineTree(); }
                } catch (e) { hbBuildOutlineTree(); }
                const infoEl = document.getElementById('hb-searchInfo'); if (infoEl) infoEl.style.display = 'none';
            }
            window.clearHandbookData = function() { _hbClearSet('handbook'); };
            window.clearAccidentData = function() { _hbClearSet('cases'); };

            // 切换浏览模式（三个视图：检查手册 / 事故案例 / 规章制度）
            window.hbSwitchView = function(view) {
                if (view === 'cases') _hbActive = 'cases';
                else if (view === 'outline') _hbActive = 'handbook';
                var ob = document.getElementById('hb-toggleOutline');
                var cb = document.getElementById('hb-toggleCases');
                var rb = document.getElementById('hb-toggleRules');
                if (ob) ob.classList.toggle('active', view === 'outline');
                if (cb) cb.classList.toggle('active', view === 'cases');
                if (rb) rb.classList.toggle('active', view === 'rules');
                var outlineWrap = document.getElementById('hb-outlineWrap');
                if (outlineWrap) outlineWrap.classList.toggle('active', view === 'outline' || view === 'cases' || view === 'rules');
                if (view === 'outline' || view === 'cases') hbBuildOutlineTree();
                if (view === 'rules') hbBuildRulesTree();
            };

                        // 构建大纲树
            function hbBuildOutlineTree() {
                const treeEl = document.getElementById('hb-outlineTree');
                const contentEl = document.getElementById('hb-outlineContent');
                var _data = _hbGet();          // 【2026-09-22】当前数据集（检查手册 / 事故案例）
                if (_data.length === 0) {
                    treeEl.innerHTML = '<div class="hb-content-placeholder" style="padding:30px 10px;">' + _esc(_hbCur().label) + '暂无数据，请先在「设置」面板导入 DOCX / JSON 文档</div>';
                    contentEl.innerHTML = '<div class="hb-content-placeholder">← 点击左侧目录查看内容</div>';
                    return;
                }

                // 构建树形结构
                const tree = [];
                const chapMap = {};   // chapter -> node index in tree
                const secMap = {};    // chapter||section -> node index
                const itemMap = {};   // chapter||section||item -> node index

                _data.forEach(entry => {
                    // 【2026-09-22】chapter 为空（有"节/条"没有"章"的数据）时的兜底：原来 chapIdx 会是 undefined，
                    //   走到 tree[chapIdx].children 直接抛异常 → **整个大纲视图空白**（历史数据里这种记录并不罕见）。
                    const cRaw = entry.chapter || '';
                    const c = cRaw || '未分类';
                    const s = entry.section || '';
                    const it = entry.item || '', sub = entry.subitem || '';
                    const cont = entry.content || '';

                    // 确保chapter节点存在
                    if (chapMap[c] === undefined) {
                        chapMap[c] = tree.length;
                        tree.push({ level: 0, label: c, children: [], chapter: cRaw, section: '', item: '', subitem: '' });
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

                        _hbShowContent(chapter, section, item, subitem);


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
                treeEl.innerHTML = '<div style="padding:8px 12px;background:#fffbeb;color:#92400e;font-size:0.8rem;border-radius:8px;margin-bottom:8px;">ⓘ 此视图只读参照规章制度模块数据，编辑请到「规章制度」模块</div>' + (treeHtml || '<div class="hb-content-placeholder">暂无数据</div>');
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
            /** 【2026-09-22】事故案例（与手册平行的第二份数据，四级结构完全一致） */
            window.getAccidentData = function() { return accidentData; };

            /** 【2026-09-22】导出某个数据集（手册 / 事故案例共用） */
            function _hbExportSet(setName) {
                var s = HB_SETS[setName] || HB_SETS.handbook;
                var arr = s.get() || [];
                if (arr.length === 0) { alert('没有' + s.label + '数据可导出'); return; }
                window.showProgress(50, '正在导出' + s.label + '…');
                var dataStr = JSON.stringify(arr, null, 2);
                var blob = new Blob([dataStr], { type: 'application/json' });
                window.downloadBlob(blob, s.label + '_' + window.localDateStr() + '.json');
                window.finishProgress('✅ ' + s.label + '导出成功');
            }
            window.exportHandbook = function() { _hbExportSet('handbook'); };
            window.exportAccident = function() { _hbExportSet('cases'); };
        })();
