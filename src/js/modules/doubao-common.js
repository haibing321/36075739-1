/**
 * 安监智能辅助系统 - 智能助手共享工具层
 * ===================================================
 * 从 doubao.js 提取的共享工具函数：
 *   - 附件处理（本地文件上传 + 资料库选择）
 *   - 文件读取（TXT/MD/DOC/DOCX/XLS/XLSX/PDF）
 * 加载顺序：在 doubao.js 之前加载
 */

(function() {
    'use strict';

    // ---- 附件处理 ----
    window._dsAttachments = []; // [{name, text}]

    window.dsHandleAttach = async function(input) {
        const files = Array.from(input.files || []);
        if (!files.length) return;
        const inputEl = document.getElementById('ds-user-input');

        for (const file of files) {
            let text = '';
            const ext = file.name.split('.').pop().toLowerCase();

            try {
                if (ext === 'txt' || ext === 'md' || ext === 'json' || ext === 'csv') {
                    text = await window.dsReadTextFileAutoEnc(file);
                } else if (ext === 'doc' || ext === 'docx') {
                    if (ext === 'doc') {
                        // 老版 Word 二进制格式(.doc) mammoth 不支持，明确提示并跳过
                        alert('文件「' + file.name + '」为旧版 Word(.doc) 格式，暂不支持。\n请另存为 .docx 后重新上传。');
                        continue;
                    }
                    if (typeof mammoth === 'undefined') {
                        try { await window.loadScript('https://cdnjs.cloudflare.com/ajax/libs/mammoth/1.4.2/mammoth.browser.min.js'); }
                        catch (e) { /* 交给下面判空 */ }
                    }
                    if (typeof mammoth === 'undefined') {
                        text = 'Word 解析库(mammoth)加载失败，请检查网络后重试。';
                    } else {
                        text = await window.dsReadWordFile(file);
                    }
                } else if (ext === 'xls' || ext === 'xlsx') {
                    if (typeof XLSX === 'undefined') {
                        try { await window.loadScript('https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js'); }
                        catch (e) { /* 交给下面判空 */ }
                    }
                    if (typeof XLSX === 'undefined') {
                        text = 'Excel 解析库(XLSX)加载失败，请检查网络后重试。';
                    } else {
                        text = await window.dsReadExcelFile(file);
                    }
                } else if (ext === 'pdf') {
                    if (typeof pdfjsLib === 'undefined') {
                        try { await window.loadScript('https://cdnjs.cloudflare.com/ajax/libs/pdf.js/2.16.105/pdf.min.js'); }
                        catch (e) { /* 交给下面判空 */ }
                    }
                    if (typeof pdfjsLib === 'undefined') {
                        text = 'PDF 解析库(pdf.js)加载失败，请检查网络后重试。';
                    } else {
                        text = await window.dsReadPdfFile(file);
                    }
                } else if (/^image\//.test(file.type) || /^(png|jpe?g|gif|webp|bmp)$/.test(ext)) {
                    // 图片附件：读取为 dataURL 并获取尺寸，供预览与（支持多模态时）送审
                    text = await window.dsReadImageFile(file);
                } else {
                    text = '暂不支持该文件格式：' + ext;
                }

                const maxLen = 8000;
                const truncated = text.length > maxLen ? text.slice(0, maxLen) + '\n...[内容过长，已截取前' + maxLen + '字]' : text;
                const isImage = !!((/^image\//.test(file.type) || /^(png|jpe?g|gif|webp|bmp)$/.test(ext)) && (file.attachDataUrl));
                window._dsAttachments.push({ name: file.name, text: truncated, dataUrl: file.attachDataUrl || null, isImage: isImage });

                const icon = ext === 'pdf' ? '📕' : ext === 'docx' || ext === 'doc' ? '📘' : ext === 'xlsx' || ext === 'xls' ? '📊' : isImage ? '🖼️' : '📎';
                const tagText = ' [' + icon + ' ' + file.name + '] ';
                if (inputEl.value) { inputEl.value += tagText; } else { inputEl.value = tagText; }
                inputEl.style.height = 'auto';
                inputEl.style.height = inputEl.scrollHeight + 'px';
                dsRenderAttachPreview();
            } catch (err) {
                console.error('文件解析失败:', file.name, err);
                alert('文件 "' + file.name + '" 解析失败：' + err.message);
            }
        }
        input.value = '';
    };

    // ---- +号附件菜单 ----
    window.dsToggleAttachMenu = function() {
        var menu = document.getElementById('ds-attach-menu');
        if (!menu) return;
        // 用 computed style 判断：菜单默认隐藏由 CSS 提供（内联 style.display 初始为空串）
        var shown = getComputedStyle(menu).display !== 'none';
        menu.style.display = shown ? 'none' : 'block';
    };
    document.addEventListener('click', function(e) {
        var menu = document.getElementById('ds-attach-menu');
        if (!menu) return;
        if (getComputedStyle(menu).display !== 'none' && !e.target.closest('#ds-attach-menu') && !e.target.closest('[onclick*="dsToggleAttachMenu"]')) {
            menu.style.display = 'none';
        }
    });

    // ---- 写作资料库附件选择（含历史报告） ----
    window._dsMaterialCache = [];

    window.dsOpenMaterialPicker = async function() {
        var modal = document.getElementById('ds-material-modal');
        if (!modal) return;
        modal.style.display = 'flex';
        var list = document.getElementById('ds-material-list');
        list.innerHTML = '<div style="text-align:center;padding:20px;color:var(--text-secondary);">加载中…</div>';
        document.getElementById('ds-material-search').value = '';
        document.getElementById('ds-material-type-filter').value = '';
        try {
            var db = await new Promise(function(res, rej) {
                var r = indexedDB.open('railway_writer_db', 2);
                r.onerror = function(){ rej(r.error); };
                r.onsuccess = function(){ res(r.result); };
            });
            var materials = await new Promise(function(res) {
                var tx = db.transaction('writing_materials', 'readonly');
                var store = tx.objectStore('writing_materials');
                store.getAll().onsuccess = function(e) { res(e.target.result || []); };
            });
            // 同时载入「智能写作历史报告」，作为可附加的上下文
            var reports = [];
            try {
                reports = await new Promise(function(res) {
                    var tx = db.transaction('writing_reports', 'readonly');
                    var store = tx.objectStore('writing_reports');
                    store.getAll().onsuccess = function(e) { res(e.target.result || []); };
                });
            } catch(e) { reports = []; }
            db.close();
            // 合并：资料库条目保留原 type；历史报告统一标记为 report 类型
            var reportItems = (reports || []).map(function(r) {
                return { title: r.title || '未命名报告', content: r.content || '', type: 'report', source: 'report', id: 'rpt-' + (r.id != null ? r.id : '') };
            });
            window._dsMaterialCache = (materials || []).concat(reportItems);
            dsRenderMaterialList(window._dsMaterialCache);
        } catch(e) {
            list.innerHTML = '<div style="text-align:center;padding:20px;color:#dc2626;">加载失败：' + (e.message||'资料库为空') + '</div>';
        }
    };

    window.dsFilterMaterials = function() {
        var keyword = (document.getElementById('ds-material-search')?.value || '').trim().toLowerCase();
        var type = document.getElementById('ds-material-type-filter')?.value || '';
        var filtered = window._dsMaterialCache.filter(function(m) {
            var matchKw = !keyword || (m.title||'').toLowerCase().indexOf(keyword) !== -1 || (m.content||'').toLowerCase().indexOf(keyword) !== -1;
            var matchType = !type || (m.type||'') === type;
            return matchKw && matchType;
        });
        dsRenderMaterialList(filtered);
    };

    function dsRenderMaterialList(items) {
        var list = document.getElementById('ds-material-list');
        if (!items.length) {
            list.innerHTML = '<div style="text-align:center;padding:20px;color:var(--text-secondary);">没有匹配的资料</div>';
            return;
        }
        var typeMap = {report:'📄 历史报告',inspect:'🔍 检查信息',template:'📋 模版',fault:'⚠️ 故障',notice:'📢 通报',other:'📎 其它'};
        var html = '';
        items.slice(0, 50).forEach(function(m, i) {
            var typeLabel = typeMap[m.type] || '📎 资料';
            var title = (m.title || '无标题').slice(0, 60);
            html += '<label style="display:flex;align-items:flex-start;gap:8px;padding:10px;background:var(--card-bg);border-radius:8px;cursor:pointer;border:1px solid var(--border);" onmouseover="this.style.background=\'var(--primary-light)\'" onmouseout="this.style.background=\'var(--card-bg)\'">'
                + '<input type="checkbox" value="'+i+'" class="ds-mat-cb" style="margin-top:2px;flex-shrink:0;">'
                + '<div style="flex:1;min-width:0;"><div style="font-size:0.82rem;font-weight:500;">'+typeLabel+' ' + (title||'无标题') + '</div>'
                + '<div style="font-size:0.72rem;color:var(--text-secondary);margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + ((m.content||'').slice(0,80)) + '</div></div>'
                + '</label>';
        });
        list.innerHTML = html;
        document.getElementById('ds-material-confirm').onclick = function() {
            var cbs = document.querySelectorAll('.ds-mat-cb:checked');
            var selected = [];
            cbs.forEach(function(cb) { selected.push(items[parseInt(cb.value)]); });
            if (!selected.length) { alert('请至少选择一项资料'); return; }
            selected.forEach(function(m) {
                var text = (m.content || '').slice(0, 4000);
                window._dsAttachments = window._dsAttachments || [];
                window._dsAttachments.push({ name: m.title || '写作资料', text: text, source: 'material' });
                var inputEl = document.getElementById('ds-user-input');
                if (inputEl) { inputEl.value = (inputEl.value||'') + ' [📚 ' + (m.title||'资料') + '] '; }
            });
            document.getElementById('ds-material-modal').style.display = 'none';
        };
    }

    // ---- 文件读取器 ----
    window.dsReadTextFile = function(file) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = e => resolve(e.target.result || '');
            reader.onerror = () => reject(new Error('文件读取失败'));
            reader.readAsText(file, 'UTF-8');
        });
    };

    // 文本文件读取：自动识别 UTF-8 / GBK(GB2312)，避免中文 Windows 导出的 .txt/.csv 读成乱码
    window.dsReadTextFileAutoEnc = function(file) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = function(e) {
                const buf = new Uint8Array(e.target.result);
                let utf8;
                try { utf8 = new TextDecoder('utf-8', { fatal: false }).decode(buf); }
                catch (e) { utf8 = ''; }
                // 若 UTF-8 解码出现大量替换字符(乱码特征)，尝试 GBK 回退
                const utf8Bad = (utf8.match(/�/g) || []).length;
                if (utf8Bad > 0) {
                    try {
                        const gbk = new TextDecoder('gbk').decode(buf);
                        const gbkBad = (gbk.match(/�/g) || []).length;
                        if (gbkBad < utf8Bad) { resolve(gbk); return; }
                    } catch (e) { /* 忽略，使用 utf8 */ }
                }
                resolve(utf8);
            };
            reader.onerror = () => reject(new Error('文件读取失败'));
            reader.readAsArrayBuffer(file);
        });
    };

    window.dsReadWordFile = function(file) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = function(e) {
                try {
                    const arrayBuffer = e.target.result;
                    mammoth.convertToHtml({ arrayBuffer: arrayBuffer })
                        .then(function(result) {
                            const text = window._htmlToTextPreserveTables ? window._htmlToTextPreserveTables(result.value || '') : (result.value || '').replace(/<[^>]+>/g, '\n').trim();
                            if (!text) {
                                resolve('[Word文件] ' + file.name + '\n\n未能提取到文本内容。\n文件大小：' + (file.size / 1024).toFixed(2) + ' KB');
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

    window.dsReadExcelFile = function(file) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = function(e) {
                try {
                    const data = new Uint8Array(e.target.result);
                    const workbook = XLSX.read(data, { type: 'array' });
                    let result = '[Excel文件] ' + file.name + '\n\n';
                    workbook.SheetNames.forEach(function(sheetName, index) {
                        const worksheet = workbook.Sheets[sheetName];
                        const jsonData = XLSX.utils.sheet_to_json(worksheet, { header: 1 });
                        if (jsonData.length > 0) {
                            result += '--- 工作表 ' + (index + 1) + '：' + sheetName + ' ---\n';
                            const maxRows = 100;
                            const displayData = jsonData.slice(0, maxRows);
                            displayData.forEach(function(row) {
                                const rowText = row.map(function(cell) {
                                    if (cell === null || cell === undefined) return '';
                                    return String(cell).substring(0, 200);
                                }).join(' | ');
                                result += rowText + '\n';
                            });
                            if (jsonData.length > maxRows) result += '\n...[仅显示前' + maxRows + '行]\n';
                            result += '\n';
                        }
                    });
                    if (workbook.SheetNames.length === 0) result += '该文件没有可读取的工作表。\n';
                    resolve(result);
                } catch (err) {
                    reject(new Error('Excel文件解析失败：' + (err.message || '未知错误')));
                }
            };
            reader.onerror = () => reject(new Error('文件读取失败'));
            reader.readAsArrayBuffer(file);
        });
    };

    // 图片附件：读取为 dataURL，获取尺寸，返回描述文本（供 AI 提示词引用；多模态模型可直接消费 dataUrl）
    window.dsReadImageFile = function(file) {
        return new Promise((resolve) => {
            const reader = new FileReader();
            reader.onload = function(e) {
                const dataUrl = e.target.result;
                file.attachDataUrl = dataUrl;
                const img = new Image();
                img.onload = function() {
                    const sizeKB = (file.size / 1024).toFixed(0);
                    const desc = '[图片附件] ' + file.name + '（' + img.width + '×' + img.height + '，' + sizeKB + 'KB）\n'
                        + '图片已作为视觉内容附上，请结合图片理解用户问题。';
                    resolve(desc);
                };
                img.onerror = function() {
                    resolve('[图片附件] ' + file.name + '（尺寸未知）');
                };
                img.src = dataUrl;
            };
            reader.onerror = function() { resolve('[图片附件] ' + file.name + '（读取失败）'); };
            reader.readAsDataURL(file);
        });
    };

    // 渲染已附加文件的预览（图片缩略图 + 文件标签），点击可移除
    window.dsRenderAttachPreview = function() {
        var box = document.getElementById('ds-attach-preview');
        if (!box) return;
        var items = window._dsAttachments || [];
        box.innerHTML = '';
        var has = false;
        items.forEach(function(a, idx) {
            if (!a) return;
            has = true;
            var tag = document.createElement('div');
            tag.style.cssText = 'display:flex;align-items:center;gap:4px;background:#f1f5f9;border:1px solid #e2e8f0;border-radius:8px;padding:3px 6px;font-size:0.72rem;color:#475569;max-width:160px;';
            if (a.isImage && a.dataUrl) {
                var thumb = document.createElement('img');
                thumb.src = a.dataUrl;
                thumb.style.cssText = 'width:22px;height:22px;object-fit:cover;border-radius:4px;flex-shrink:0;';
                tag.appendChild(thumb);
            }
            var label = document.createElement('span');
            label.textContent = (a.isImage ? '🖼️ ' : '📎 ') + (a.name || '附件');
            label.style.cssText = 'overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
            tag.appendChild(label);
            var x = document.createElement('span');
            x.textContent = '✕';
            x.style.cssText = 'cursor:pointer;color:#94a3b8;flex-shrink:0;padding:0 2px;';
            x.onclick = function() { window.dsRemoveAttach(idx); };
            tag.appendChild(x);
            box.appendChild(tag);
        });
        box.style.display = has ? 'flex' : 'none';
        // 附件增删后同步发送按钮启用态（DeepSeek：仅有附件也可发送）
        if (typeof window.dsSyncSendState === 'function') window.dsSyncSendState();
    };

    window.dsReadPdfFile = function(file) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = async function(e) {
                try {
                    const typedarray = new Uint8Array(e.target.result);
                    pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/2.16.105/pdf.worker.min.js';
                    const pdf = await pdfjsLib.getDocument(typedarray).promise;
                    let result = '[PDF文件] ' + file.name + '\n\n总页数：' + pdf.numPages + '\n\n';
                    const maxPages = Math.min(pdf.numPages, 10);
                    for (let i = 1; i <= maxPages; i++) {
                        const page = await pdf.getPage(i);
                        const textContent = await page.getTextContent();
                        let pageText = '';
                        const lastY = { value: -Infinity };
                        textContent.items.forEach(function(item) {
                            if (item.str) {
                                if (lastY.value !== -Infinity && Math.abs(lastY.value - item.transform[5]) > 5) pageText += '\n';
                                pageText += item.str;
                                lastY.value = item.transform[5];
                            }
                        });
                        result += '--- 第 ' + i + ' 页 ---\n' + pageText + '\n\n';
                    }
                    if (pdf.numPages > maxPages) result += '...[仅显示前' + maxPages + '页]\n';
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
        var removed = window._dsAttachments[idx];
        if (removed) {
            // 同步从输入框移除对应的 [图标 文件名] 标签文本
            var inputEl = document.getElementById('ds-user-input');
            if (inputEl && removed.name) {
                inputEl.value = inputEl.value.replace(new RegExp('\\[[^\\]]*' + removed.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\]', 'g'), '').trim();
            }
        }
        if (window._dsAttachments[idx]) window._dsAttachments[idx] = null;
        if (tagEl) tagEl.remove();
        dsRenderAttachPreview();
    };

    /**
     * 构建「多模态消息」：把附件中的图片转为真正的 image_url 内容块，文本附件保留为纯文本。
     * 集中处理视觉模型的图文输入，避免各模块重复拼装。
     * @param {string} text 用户文本（可为空）
     * @param {Array} attachments window._dsAttachments 过滤后的有效附件
     * @returns {{role:'user', content: (string|Array)}} 可直接塞进 messages 的 user 消息
     *   - 无图片：content 为字符串（兼容现有纯文本逻辑）
     *   - 有图片：content 为 [{type:'text',text},{type:'image_url',image_url:{url:dataUrl}}]
     */
    window.buildVisionMessages = function(text, attachments) {
        var attach = (attachments || []).filter(Boolean);
        var images = attach.filter(function(a) { return a.isImage && a.dataUrl; });
        var texts = attach.filter(function(a) { return !(a.isImage && a.dataUrl); });
        // 无图片：维持原纯文本拼装（与历史/重新生成逻辑兼容）
        if (!images.length) {
            var plain = text || '';
            if (texts.length) {
                plain += '\n\n【附件内容】\n' + texts.map(function(a) { return '--- 文件：' + a.name + ' ---\n' + a.text; }).join('\n\n');
            }
            return { role: 'user', content: plain };
        }
        // 有图片：构造 content 数组（OpenAI 多模态格式）
        var blocks = [];
        var imgDesc = images.map(function(a) { return a.name; }).join('、');
        var lead = (text || '') + (texts.length ? '\n\n【附件文本】\n' + texts.map(function(a){ return '--- 文件：' + a.name + ' ---\n' + a.text; }).join('\n\n') : '');
        if (lead.trim()) blocks.push({ type: 'text', text: lead + (lead.trim() ? '\n\n（附图片：' + imgDesc + '，请结合图片内容理解）' : '') });
        else blocks.push({ type: 'text', text: '（附图片：' + imgDesc + '，请结合图片内容理解）' });
        images.forEach(function(a) {
            blocks.push({ type: 'image_url', image_url: { url: a.dataUrl } });
        });
        return { role: 'user', content: blocks };
    };

    // 当前模型是否支持 FIM（中间补全）。视觉/非 DeepSeek 等实验模型不支持。
    window.dsModelSupportsFim = function(modelName) {
        var m = String(modelName || '');
        if (/vision|exp|exp$/i.test(m)) return false;       // 视觉实验模型明确不支持
        if (/deepseek/i.test(m)) return true;                // DeepSeek 文本模型支持
        return false;                                        // 其他供应商保守关闭
    };

    console.log('✅ doubao-common.js 已加载');
})();
