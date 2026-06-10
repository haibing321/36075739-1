// 来源：C:/Users/asus/Desktop/index.html 第7315-8266行 | 检查手册模块

        // ========== 第六模块：检查手册 (四级目录) ==========
        (function() {
            let handbookData = [];
            let chapters = [];
            let sectionsMap = {};
            let itemsMap = {};
            let subItemsMap = {};
            let contentMap = {};

            const chapterSelect = document.getElementById('chapterSelect');
            const sectionSelect = document.getElementById('sectionSelect');
            const itemSelect = document.getElementById('itemSelect');
            const subItemSelect = document.getElementById('subItemSelect');
            const contentDisplay = document.getElementById('contentDisplay');
            const displayChapter = document.getElementById('displayChapter');
            const displaySection = document.getElementById('displaySection');
            const displayItem = document.getElementById('displayItem');
            const displaySubItem = document.getElementById('displaySubItem');
            const displayContent = document.getElementById('displayContent');
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

            function rebuildMaps() {
                const chapterSet = new Set();
                const sectionSetByChap = {};
                const itemSetByChapSec = {};
                const subItemSetByKey = {};
                const contentByKey = {};

                handbookData.forEach(entry => {
                    const chap = entry.chapter || '';
                    const sect = entry.section || '';
                    const it   = entry.item    || '';
                    const sub  = entry.subitem || '';
                    const cont = entry.content || '';

                    if (chap) chapterSet.add(chap);
                    if (chap && sect) {
                        if (!sectionSetByChap[chap]) sectionSetByChap[chap] = new Set();
                        sectionSetByChap[chap].add(sect);
                    }
                    if (chap && sect && it) {
                        const k2 = chap + '||' + sect;
                        if (!itemSetByChapSec[k2]) itemSetByChapSec[k2] = new Set();
                        itemSetByChapSec[k2].add(it);
                    }
                    if (chap && sect && it && sub) {
                        const k3 = chap + '||' + sect + '||' + it;
                        if (!subItemSetByKey[k3]) subItemSetByKey[k3] = new Set();
                        subItemSetByKey[k3].add(sub);
                        contentByKey[k3 + '||' + sub] = cont;
                    } else if (chap && sect && it && !sub && cont) {
                        // 兼容旧三级数据：item 直接有 content，无 subitem
                        const k3 = chap + '||' + sect + '||' + it;
                        if (!subItemSetByKey[k3]) subItemSetByKey[k3] = new Set();
                        contentByKey[k3 + '||__direct__'] = cont;
                        subItemSetByKey[k3].add('__direct__');
                    }
                });

                chapters = Array.from(chapterSet).sort((a,b) => getChapterOrder(a) - getChapterOrder(b));
                sectionsMap = {};
                chapters.forEach(chap => {
                    sectionsMap[chap] = Array.from(sectionSetByChap[chap] || new Set()).sort((a,b) => getSectionOrder(a) - getSectionOrder(b));
                });
                itemsMap = {};
                Object.keys(itemSetByChapSec).forEach(k => {
                    itemsMap[k] = Array.from(itemSetByChapSec[k]).sort((a,b) => getItemOrder(a) - getItemOrder(b));
                });
                subItemsMap = {};
                Object.keys(subItemSetByKey).forEach(k => {
                    subItemsMap[k] = Array.from(subItemSetByKey[k]).sort((a,b) => getSubItemOrder(a) - getSubItemOrder(b));
                });
                contentMap = contentByKey;
                updateStats();
            }

            function updateStats() {
                const count = handbookData.length;
                totalSpan.textContent = count;
                const jsonStr = JSON.stringify(handbookData);
                const sizeKB = (new Blob([jsonStr]).size / 1024).toFixed(2);
                sizeSpan.textContent = sizeKB + ' KB';
                storageBar.style.width = Math.min((sizeKB / 5120) * 100, 100) + '%';
            }

            function hideFrom(level) {
                // level: 2=隐藏分类及以下, 3=隐藏项点及以下, 4=隐藏子项, 5=隐藏内容
                if (level <= 2) { document.getElementById('category-selector').style.display = 'none'; }
                if (level <= 3) { document.getElementById('checkpoint-selector').style.display = 'none'; }
                if (level <= 4) { document.getElementById('subitem-selector').style.display = 'none'; }
                if (level <= 5) { contentDisplay.style.display = 'none'; }
            }

            function renderChapterSelect() {
                chapterSelect.innerHTML = '<option value="">-- 请选择系统专业 --</option>';
                chapters.forEach(chap => {
                    const opt = document.createElement('option');
                    opt.value = opt.textContent = chap;
                    chapterSelect.appendChild(opt);
                });
                hideFrom(2);
            }

            window.onChapterChange = function() {
                const chap = chapterSelect.value;
                if (!chap) { hideFrom(2); return; }
                hideFrom(3);
                document.getElementById('category-selector').style.display = 'block';
                sectionSelect.innerHTML = '<option value="">-- 请选择专业分类 --</option>';
                (sectionsMap[chap] || []).forEach(sec => {
                    const opt = document.createElement('option');
                    opt.value = opt.textContent = sec;
                    sectionSelect.appendChild(opt);
                });
            };

            window.onSectionChange = function() {
                const chap = chapterSelect.value;
                const sec  = sectionSelect.value;
                if (!chap || !sec) { hideFrom(3); return; }
                hideFrom(4);
                document.getElementById('checkpoint-selector').style.display = 'block';
                itemSelect.innerHTML = '<option value="">-- 请选择检查项点 --</option>';
                (itemsMap[chap + '||' + sec] || []).forEach(it => {
                    const opt = document.createElement('option');
                    opt.value = opt.textContent = it;
                    itemSelect.appendChild(opt);
                });
            };

            window.onItemChange = function() {
                const chap = chapterSelect.value;
                const sec  = sectionSelect.value;
                const it   = itemSelect.value;
                if (!chap || !sec || !it) { hideFrom(4); return; }
                const k3 = chap + '||' + sec + '||' + it;
                const subs = subItemsMap[k3] || [];

                // 判断是否只有兼容直连内容（旧三级数据）
                if (subs.length === 1 && subs[0] === '__direct__') {
                    // 直接显示内容，隐藏子项选择框
                    hideFrom(4);
                    const content = contentMap[k3 + '||__direct__'] || '暂无内容';
                    displayChapter.textContent = chap;
                    displaySection.textContent = sec;
                    displayItem.textContent = it;
                    displaySubItem.textContent = '';
                    displaySubItem.style.display = 'none';
                    displayContent.innerHTML = typeof window.safeHtml === 'function'
                        ? window.safeHtml(content, { allowedTags: ['br','p','div','span','strong','em','b','i','u','h1','h2','h3','h4','table','tr','td','th','ul','ol','li'] })
                        : window.escapeHtml(content).replace(/\n/g, '<br>');
                    contentDisplay.style.display = 'block';
                    return;
                }

                hideFrom(5);
                document.getElementById('subitem-selector').style.display = 'block';
                subItemSelect.innerHTML = '<option value="">-- 请选择检查子项 --</option>';
                subs.forEach(sub => {
                    const opt = document.createElement('option');
                    opt.value = opt.textContent = sub;
                    subItemSelect.appendChild(opt);
                });
            };

            window.onSubItemChange = function() {
                const chap = chapterSelect.value;
                const sec  = sectionSelect.value;
                const it   = itemSelect.value;
                const sub  = subItemSelect.value;
                if (!chap || !sec || !it || !sub) { contentDisplay.style.display = 'none'; return; }
                const key = chap + '||' + sec + '||' + it + '||' + sub;
                const content = contentMap[key] || '暂无内容';
                displayChapter.textContent = chap;
                displaySection.textContent = sec;
                displayItem.textContent = it;
                displaySubItem.textContent = sub;
                displaySubItem.style.display = '';
                displayContent.innerHTML = typeof window.safeHtml === 'function'
                    ? window.safeHtml(content, { allowedTags: ['br','p','div','span','strong','em','b','i','u','h1','h2','h3','h4','table','tr','td','th','ul','ol','li'] })
                    : window.escapeHtml(content).replace(/\n/g, '<br>');
                contentDisplay.style.display = 'block';
            };

            // 四级结构示例数据
            function loadSampleData() {
                const sample = [
                    {
                        chapter: '第一章 通用及专项部分',
                        section: '第一节 安全基础管理',
                        item: '1. \u201c四会\u201d制度建立落实情况',
                        subitem: '1.1 安全会议制度',
                        content: '检查会议记录是否齐全、规范；检查安委会会议纪要、安委会部署重点工作任务清单、安全分析例会情况通报；检查是否分析突出问题，并制定了相应的整改措施；检查站段月度各车间挂网重点信息追踪覆盖情况；检查薄弱车间的确定及帮促。'
                    },
                    {
                        chapter: '第一章 通用及专项部分',
                        section: '第一节 安全基础管理',
                        item: '1. \u201c四会\u201d制度建立落实情况',
                        subitem: '1.2 重点工作推进落实',
                        content: '检查对1号文件等重点工作是否列出责任清单推进落实并督办；检查阶段性重点安全工作是否安排，车间是否上报落实情况；检查安全生产费隐患治理项目落实情况；检查每月十专项工作安排部署及落实情况。'
                    },
                    {
                        chapter: '第一章 通用及专项部分',
                        section: '第一节 安全基础管理',
                        item: '1. \u201c四会\u201d制度建立落实情况',
                        subitem: '1.3 事故故障分析整改',
                        content: '检查事故、故障分析（一事一档），安全信息闭环整改情况；检查安全监察指令书、通知书、意见书等指出问题是否件件专题分析整改及考核追责；检查上级检查指出典型问题是否分析整改。'
                    },
                    {
                        chapter: '第一章 通用及专项部分',
                        section: '第一节 安全基础管理',
                        item: '2. 安全双重预防机制落实',
                        subitem: '2.1 安全风险库建立',
                        content: '检查年初安全风险库建立，站段是否召开安全风险研判专题会议；检查站段风险库是否承接集团公司、专业部门风险库；检查安全风险是否分级管控、安全风险库是否以文件公布。'
                    },
                    {
                        chapter: '第一章 通用及专项部分',
                        section: '第一节 安全基础管理',
                        item: '2. 安全双重预防机制落实',
                        subitem: '2.2 安全风险公告与预警',
                        content: '检查安全风险公告、每季安全风险管控效果自评情况；检查安全风险动态研判、专项辨识开展情况；检查安全风险预警落实，是否对车间精准预警。'
                    },
                    {
                        chapter: '第一章 通用及专项部分',
                        section: '第一节 安全基础管理',
                        item: '2. 安全双重预防机制落实',
                        subitem: '2.3 隐患排查治理',
                        content: '检查隐患库建立、常态化隐患排查开展、重大安全隐患专题立案管理情况，安全隐患是否有效整治。'
                    },
                    {
                        chapter: '第二章 车务系统检查清单',
                        section: '第一节 接发列车',
                        item: '1. 车站值班员',
                        subitem: '1.1 岗位基本要求',
                        content: '岗位人员精神状态是否良好、是否按规定着装、佩戴臂章。岗位责任制是否按规定揭挂。'
                    },
                    {
                        chapter: '第二章 车务系统检查清单',
                        section: '第一节 接发列车',
                        item: "1. 车站值班员",
                        subitem: "1.2 行车岗位簿册填记",
                        content: "行车岗位有关簿册是否规范填记：《一班工作日志及交接班簿》交接内容是否清楚；《行车设备检查登记簿》、《行车设备施工登记簿》是否按填记样板的格式要求进行填记；日班计划、阶段计划、调度命令接收及时，认真核对、签收、转交及存档；《行车日志》需人工输入的内容是否规范填记。"
                    },
                    {
                        chapter: "第二章 车务系统检查清单",
                        section: "第一节 接发列车",
                        item: "1. 车站值班员",
                        subitem: "1.3 非正常情况处置",
                        content: "非正常情况下是否执行接发列车作业标准，盯控干部是否到岗盯控，有关行车凭证是否规范填记及确认、核对、转交、联控。"
                    },
                    {
                        chapter: "第二章 车务系统检查清单",
                        section: "第一节 接发列车",
                        item: "1. 车站值班员",
                        subitem: "1.4 超限列车及上道联控",
                        content: "是否熟知站内线路限制、清楚掌握接发超长、各级超限列车的线路；涉及设备管理单位站内、区间人员上道作业，是否按规定与司机及相关人员提示、联控。"
                    }
                ];
                handbookData = sample;
                rebuildMaps();
                renderChapterSelect();
                saveToStorage();
            }

            function saveToStorage() {
                try { localStorage.setItem('handbook_fourlevel_v1', JSON.stringify(handbookData)); } catch (e) {}
            }
            function loadFromStorage() {
                try {
                    // 优先读取新四级存储，若没有则尝试迁移旧三级数据
                    const stored4 = localStorage.getItem('handbook_fourlevel_v1');
                    if (stored4) {
                        const raw4 = JSON.parse(stored4);
                        // 自动修复：清除之前错误迁移强补的 "xxx - 详细内容" 格式 subitem
                        handbookData = raw4.map(entry => {
                            const rec = Object.assign({}, entry);
                            if (rec.subitem && typeof rec.subitem === 'string' &&
                                rec.item && rec.subitem === rec.item + ' - 详细内容') {
                                delete rec.subitem; // 还原为三级数据
                            }
                            return rec;
                        });

                        // 自动清理：移除之前通过"导入规章制度"功能导入的数据（section === '规章制度'）
                        // 现在规章制度已改为直接浏览模式，不再需要导入到检查手册
                        const beforeLen = handbookData.length;
                        handbookData = handbookData.filter(d => d.section !== '规章制度');
                        if (handbookData.length < beforeLen) {
                            try { localStorage.setItem('handbook_fourlevel_v1', JSON.stringify(handbookData)); } catch(e) {}
                        }

                        // 若修复了数据，回写修正后的版本
                        try {
                            if (raw4.some((e, i) => (e.subitem !== undefined) !== (handbookData[i] && handbookData[i].subitem !== undefined))) {
                                localStorage.setItem('handbook_fourlevel_v1', JSON.stringify(handbookData));
                            }
                        } catch(e) {}
                    } else {
                        const stored3 = localStorage.getItem('handbook_threelevel_v2');
                        if (stored3) {
                            // 迁移旧三级数据：为每条记录补充 subitem 字段
                            const old = JSON.parse(stored3);
                            // 迁移时保留原始字段，不强补 subitem
                            // rebuildMaps 会自动识别无 subitem 的三级数据
                            handbookData = old.map(entry => {
                                const rec = {
                                    chapter: entry.chapter || '',
                                    section: entry.section || '',
                                    item: entry.item || '',
                                    content: entry.content || ''
                                };
                                // 只有原始数据本身有 subitem 才保留
                                if (entry.subitem) rec.subitem = entry.subitem;
                                return rec;
                            });
                        } else {
                            loadSampleData();
                            return;
                        }
                    }
                } catch (e) { loadSampleData(); return; }
                rebuildMaps();
                renderChapterSelect();
            }

            window.clearHandbookData = function() {
                if (confirm('确定清空所有手册数据吗？')) {
                    handbookData = [];
                    rebuildMaps();
                    renderChapterSelect();
                    hideFrom(2);
                    saveToStorage();
                }
            };

            window.resetHandbookData = function() {
                if (confirm('确定恢复初始示例数据吗？当前数据将被覆盖。')) {
                    loadSampleData();
                    alert('已恢复初始状态');
                }
            };

            window.exportHandbook = function() {
                if (handbookData.length === 0) { alert('没有数据可导出'); return; }
                const dataStr = JSON.stringify(handbookData, null, 2);
                const blob = new Blob([dataStr], { type: 'application/json' });
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = '安全检查手册_' + new Date().toISOString().slice(0,10) + '.json';
                a.click();
                URL.revokeObjectURL(url);
            };

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
                        rebuildMaps();
                        renderChapterSelect();
                        hideFrom(2);
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
                        rebuildMaps();
                        renderChapterSelect();
                        hideFrom(2);
                        saveToStorage();
                        closeModal('handbook-importModal');
                    } catch(e) {
                        console.error('手册覆盖失败:', e);
                        closeModal('handbook-importModal');
                        alert('导入失败: ' + e.message);
                    }
                };
            }

            document.getElementById('handbook-importBtn').addEventListener('click', function() {
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

            // 切换浏览模式
            loadFromStorage();

            // 暴露 handbook 数据供其他模块调用（如智能助手联动）
            window.getHandbookData = function() { return handbookData; };
        })();
