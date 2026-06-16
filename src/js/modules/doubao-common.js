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
                    text = await window.dsReadTextFile(file);
                } else if (ext === 'doc' || ext === 'docx') {
                    text = await window.dsReadWordFile(file);
                } else if (ext === 'xls' || ext === 'xlsx') {
                    text = await window.dsReadExcelFile(file);
                } else if (ext === 'pdf') {
                    text = await window.dsReadPdfFile(file);
                } else {
                    text = '暂不支持该文件格式：' + ext;
                }

                const maxLen = 8000;
                const truncated = text.length > maxLen ? text.slice(0, maxLen) + '\n...[内容过长，已截取前' + maxLen + '字]' : text;
                window._dsAttachments.push({ name: file.name, text: truncated });

                const icon = ext === 'pdf' ? '📕' : ext === 'docx' || ext === 'doc' ? '📘' : ext === 'xlsx' || ext === 'xls' ? '📊' : '📎';
                const tagText = ' [' + icon + ' ' + file.name + '] ';
                if (inputEl.value) { inputEl.value += tagText; } else { inputEl.value = tagText; }
                inputEl.style.height = 'auto';
                inputEl.style.height = inputEl.scrollHeight + 'px';
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
        menu.style.display = menu.style.display === 'none' ? 'block' : 'none';
    };
    document.addEventListener('click', function(e) {
        var menu = document.getElementById('ds-attach-menu');
        if (menu && menu.style.display === 'block' && !e.target.closest('#ds-attach-menu') && !e.target.closest('[onclick*="dsToggleAttachMenu"]')) {
            menu.style.display = 'none';
        }
    });

    // ---- 写作资料库附件选择 ----
    window._dsMaterialCache = [];

    window.dsOpenMaterialPicker = async function() {
        var modal = document.getElementById('ds-material-modal');
        if (!modal) return;
        modal.style.display = 'flex';
        var list = document.getElementById('ds-material-list');
        list.innerHTML = '<div style="text-align:center;padding:20px;color:#888;">加载中…</div>';
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
            db.close();
            window._dsMaterialCache = materials || [];
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
            list.innerHTML = '<div style="text-align:center;padding:20px;color:#888;">没有匹配的资料</div>';
            return;
        }
        var typeMap = {report:'📄 报告',inspect:'🔍 检查信息',template:'📋 模版',fault:'⚠️ 故障',notice:'📢 通报',other:'📎 其它'};
        var html = '';
        items.slice(0, 50).forEach(function(m, i) {
            var typeLabel = typeMap[m.type] || '📎 资料';
            var title = (m.title || '无标题').slice(0, 60);
            html += '<label style="display:flex;align-items:flex-start;gap:8px;padding:10px;background:#f8fafc;border-radius:8px;cursor:pointer;border:1px solid #e2e8f0;" onmouseover="this.style.background=\'#eff6ff\'" onmouseout="this.style.background=\'#f8fafc\'">'
                + '<input type="checkbox" value="'+i+'" class="ds-mat-cb" style="margin-top:2px;flex-shrink:0;">'
                + '<div style="flex:1;min-width:0;"><div style="font-size:0.82rem;font-weight:500;">'+typeLabel+' ' + (title||'无标题') + '</div>'
                + '<div style="font-size:0.72rem;color:#888;margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + ((m.content||'').slice(0,80)) + '</div></div>'
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
        if (window._dsAttachments[idx]) window._dsAttachments[idx] = null;
        if (tagEl) tagEl.remove();
        var tagsEl = document.getElementById('ds-attach-tags');
        if (tagsEl && !tagsEl.children.length) tagsEl.style.display = 'none';
    };

    console.log('✅ doubao-common.js 已加载');
})();
