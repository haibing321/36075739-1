// 来源：C:/Users/asus/Desktop/index.html 第6964-7313行 | 电话模块

        // ========== 电话模块 ==========

        (function() {
            const STORAGE_KEY = 'railway_phone_db_v1';
            let phoneData = [];
            let phoneSuggestions = [];
            let phoneLastResults = [];

            function loadFromStorage() {
                try { const data = localStorage.getItem(STORAGE_KEY); if (data) phoneData = JSON.parse(data); } catch (e) { phoneData = []; }
                updateStats();
                document.getElementById('phone-results').style.display = 'none';
                updatePhoneSuggestions();
            }
            /**
             * 【2026-09-21】返回"是否保存成功"（原实现失败只 alert 一次，**内存已被改写却不回滚**：
             *   界面显示导入成功、刷新后数据丢失）。失败时统一 toast，调用方据此回滚内存。
             */
            function saveToStorage() {
                try {
                    localStorage.setItem(STORAGE_KEY, JSON.stringify(phoneData));
                    updateStats(); updatePhoneSuggestions();
                    return true;
                } catch (e) {
                    var msg = '⚠️ 电话数据保存失败（可能存储空间不足）：' + ((e && e.message) || '未知错误');
                    if (window.showToast) window.showToast(msg, true, 9000); else alert(msg);
                    return false;
                }
            }
            // 储存/数量展示已移除（统一在设置面板显示「总储存量」）
            function updateStats() {
                // 原逻辑渲染 phone-recordCount / phone-storageText / phone-storageBar，已移除
            }
            function updatePhoneSuggestions() {
                const keywords = new Set();
                phoneData.forEach(item => { if (item.站名) keywords.add(item.站名); if (item.单位) keywords.add(item.单位); if (item.线名) keywords.add(item.线名); });
                phoneSuggestions = Array.from(keywords).slice(0, 20);
            }

            function showPhoneSuggestions(input) {
                let container = document.getElementById('phone-suggestions');
                if (!container) {
                    container = document.createElement('div');
                    container.id = 'phone-suggestions';
                    container.className = 'search-suggestions';
                    input.parentNode.appendChild(container);
                }
                const val = input.value.toLowerCase();
                const filtered = phoneSuggestions.filter(s => s.toLowerCase().includes(val)).slice(0, 10);
                if (filtered.length === 0 || val === '') { container.style.display = 'none'; return; }
                // 用 DOM 节点 + textContent，而不是把站名拼进内联 onclick：
                // 站名来自导入的 Excel/JSON，escapeHtml 的 &#039; 会在属性解析后被还原成 '，
                // 仍能提前闭合 JS 字符串造成注入。
                container.innerHTML = '';
                filtered.forEach(function(s) {
                    const item = document.createElement('div');
                    item.textContent = s;
                    item.addEventListener('click', function() { window.selectPhoneSuggestion(s); });
                    container.appendChild(item);
                });
                container.style.display = 'block';
            }
            window.selectPhoneSuggestion = function(s) {
                document.getElementById('phone-searchInput').value = s;
                document.getElementById('phone-suggestions').style.display = 'none';
                phoneDoSearch();
            };

            // 只接受有限数字：Excel 里经纬度列可能是文本/空值，直接拼接会生成非法 JS 语法
            function _numOrEmpty(v) {
                const n = parseFloat(v);
                return isFinite(n) ? String(n) : '';
            }

            // 天气按钮改用 data-* + 事件委托（详见 phoneDoSearch 中的渲染处）
            function _bindWeatherDelegation(container) {
                if (!container || container._weatherDelegated) return;
                container._weatherDelegated = true;
                container.addEventListener('click', function(e) {
                    const btn = (e.target && e.target.closest) ? e.target.closest('.phone-weather-btn') : null;
                    if (!btn || !window.phoneGetWeather) return;
                    const lat = parseFloat(btn.getAttribute('data-lat'));
                    const lon = parseFloat(btn.getAttribute('data-lon'));
                    window.phoneGetWeather(
                        btn.getAttribute('data-station') || '',
                        isFinite(lat) ? lat : null,
                        isFinite(lon) ? lon : null,
                        btn.getAttribute('data-box') || '',
                        btn.getAttribute('data-line') || ''
                    );
                });
            }

            var LIB_XLSX_PHONE = 'src/js/vendor/xlsx.full.min.js';

            window.phoneDoSearch = function() {
                const keyword = document.getElementById('phone-searchInput').value.trim();
                const resultsContainer = document.getElementById('phone-results');
                resultsContainer.style.display = 'block';
                if (phoneData.length === 0) {
                    resultsContainer.innerHTML = '<div class="empty-state"><div class="empty-state-icon">📞</div><p>暂无电话数据，请导入Excel</p></div>';
                    document.getElementById('phone-resultCount').textContent = '0 条';
                    return;
                }
                let filtered = phoneData;
                if (keyword) {
                    const lowerKeyword = keyword.toLowerCase();
                    const digitsKeyword = extractDigits(keyword);
                    filtered = phoneData.filter(item => {
                        const fields = [item.单位, item.线名, item.站名, item.备注].map(s => (s || '').toLowerCase());
                        if (fields.some(f => f.includes(lowerKeyword))) return true;
                        if (pinyinMatch(item.站名, keyword)) return true;
                        if (pinyinMatch(item.单位, keyword)) return true;
                        const phoneFields = [item.路电, item.市电].map(s => extractDigits(s));
                        if (digitsKeyword && phoneFields.some(p => p.includes(digitsKeyword))) return true;
                        return false;
                    });
                }
                document.getElementById('phone-resultCount').textContent = filtered.length + ' 条';
                phoneLastResults = filtered;
                if (filtered.length === 0) {
                    resultsContainer.innerHTML = '<div class="empty-state"><div class="empty-state-icon">📞</div><p>没有找到匹配的电话</p></div>';
                    return;
                }
                let html = '';
                // 多号码拆分函数
                function phoneLinks(text) {
                    if (!text) return '<span style="color:var(--text-secondary)">—</span>';
                    return text.split('\n').map((n, i) => {
                        n = n.trim();
                        const d = n.replace(/\D/g, '');
                        return d ? `<a href="tel:${d}" class="phone-link" title="点击拨号${i>0?' '+ (i+1):''}">${escapeHtml(n)}</a>` : escapeHtml(n);
                    }).join('<br>');
                }
                filtered.forEach((item, idx) => {
                    const weatherId = 'pw' + idx;
                    html += `
                        <div class="result-card" style="position:relative;">
                            <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:10px;">
                                <h3 style="font-size:1.1rem; color:var(--primary);">${escapeHtml(item.站名 || '')}</h3>
                                <span style="display:flex; align-items:center; gap:6px;">
                                    <button class="btn-copy" onclick="phoneCopyEntry(${idx})" title="复制整条">📋 复制</button>
                                    <span class="tag tag-category">${escapeHtml(item.单位 || '')}</span>
                                </span>
                            </div>
                            <div style="display:grid; grid-template-columns:auto 1fr; gap:8px 12px; margin-bottom:8px;">
                                <span style="color:var(--text-secondary);">线名：</span><span>${escapeHtml(item.线名 || '')}</span>
                                <span style="color:var(--text-secondary);">路电：</span><span>${phoneLinks(item.路电)}</span>
                                <span style="color:var(--text-secondary);">市电：</span>
                                <span>${phoneLinks(item.市电)}</span>
                                ${item.备注 ? `<span style="color:var(--text-secondary);">备注：</span><span>${escapeHtml(item.备注)}</span>` : ''}
                                ${(item.站名) ? `
                                <span style="color:var(--text-secondary);">天气：</span>
                                <span><button class="phone-weather-btn" data-station="${escapeHtml(item.站名||'')}" data-lat="${_numOrEmpty(item.纬度)}" data-lon="${_numOrEmpty(item.经度)}" data-box="${weatherId}" data-line="${escapeHtml(item.线名||'')}">☀️ 查看天气</button></span>
                                ` : ''}
                            </div>
                            <div class="phone-weather-box" id="${weatherId}"></div>
                        </div>
                    `;
                });
                resultsContainer.innerHTML = html;
                _bindWeatherDelegation(resultsContainer);
            };

            // 复制整条电话记录（站名/单位/线名/路电/市电/备注）
            window.phoneCopyEntry = function(idx) {
                const item = phoneLastResults[idx];
                if (!item) return;
                const lines = [
                    '站名：' + (item.站名 || ''),
                    '单位：' + (item.单位 || ''),
                    '线名：' + (item.线名 || ''),
                    '路电：' + (item.路电 || ''),
                    '市电：' + (item.市电 || ''),
                ];
                if (item.备注) lines.push('备注：' + item.备注);
                const text = lines.join('\n');
                if (navigator.clipboard && navigator.clipboard.writeText) {
                    navigator.clipboard.writeText(text).then(function(){ phoneFlashCopied(idx); }, function(){ _legacyCopy(text); });
                } else { _legacyCopy(text); }
            };
            function _legacyCopy(text) {
                const ta = document.createElement('textarea');
                ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
                document.body.appendChild(ta); ta.select();
                try { document.execCommand('copy'); } catch (e) {}
                document.body.removeChild(ta);
            }
            function phoneFlashCopied(idx) {
                const btn = document.querySelector('.result-card .btn-copy[onclick="phoneCopyEntry(' + idx + ')"]');
                if (!btn) return;
                const old = btn.textContent; btn.textContent = '✅ 已复制';
                setTimeout(function(){ btn.textContent = old; }, 1200);
            }

            window.phoneClearSearch = function() {
                document.getElementById('phone-searchInput').value = '';
                // 恢复初始状态：隐藏结果区，显示提示文字
                var rc = document.getElementById('phone-results');
                if (rc) {
                    rc.style.display = 'none';
                    rc.innerHTML = '<div class="empty-state"><div class="empty-state-icon">📞</div><p>请输入关键词搜索或导入应急电话数据</p></div>';
                }
                var rcs = document.getElementById('phone-resultCount');
                if (rcs) rcs.textContent = '';
            };

            // escapeHtml 已统一到 utils.js (window.escapeHtml)，此处不再重复定义

            /**
             * 【2026-09-21 真实数据修复】记录级去重键：站名 + 单位 + 线名 + 路电 + 市电（全部 trim 后比较）。
             *
             * 用真实备份（安监系统测试数据.zip，839 条电话）实测「导出 → 追加导入」，原「按站名去重」得到
             * **839 → 1293**，暴露两个反向缺陷：
             *   ① **无站名记录完全不参与去重**：839 条里 **475 条站名为空**（单位/线名级联系人），
             *      原实现把它们原样 push → 同一份文件再导入一次这部分几乎原样翻倍；
             *   ② **同名站名的多条记录被合并成 1 条**：真数据里「安全生产指挥中心」11 条、「兰州西」3 条
             *      （同名站、不同单位/线名/号码）→ 静默丢 20 条。
             * 键长是拿真数据量出来的，不看直觉：
             *   · 3 字段（站名+单位+线名）→ 839 只落到 **833** 组，被吞掉的 5 组 6 条**号码各不相同**
             *     （同一站的多个号码，属正常业务数据，必须各自保留）；
             *   · 5 字段（再含 路电+市电）→ **839 组、0 吞并**，而完全相同的记录仍会被去重／覆盖。
             * 返回 null 表示"五项全空、完全无法辨识"→ 调用方不参与去重，避免被合并吞掉。
             */
            function phoneRecordKey(r) {
                var t = function(v) { return String(v == null ? '' : v).trim(); };
                var k = t(r.站名) + '\u0001' + t(r.单位) + '\u0001' + t(r.线名) + '\u0001' + t(r.路电) + '\u0001' + t(r.市电);
                // 五项全空 → 无法辨识，返回 null（调用方不参与去重，避免被合并吞掉）
                return k === '\u0001\u0001\u0001\u0001' ? null : k;
            }
            window.phoneRecordKey = phoneRecordKey;   // 供审计脚本/排查使用

            // 按 phoneRecordKey（站名+单位+线名+路电+市电）去重合并：同键以导入数据覆盖，新键追加
            // （函数名保留 phoneMergeByStation，历史调用点不变）
            function phoneMergeByStation(incoming) {
                const map = new Map();
                const rest = [];   // 无法辨识的记录：参与合并但不参与去重（既不被吞掉、也不重复计数）
                phoneData.forEach(function(it) {
                    if (!it) return;
                    var k = phoneRecordKey(it);
                    if (k) map.set(k, it); else rest.push(it);
                });
                let replaced = 0;
                incoming.forEach(function(it) {
                    if (!it) return;
                    var k = phoneRecordKey(it);
                    if (!k) { rest.push(it); return; }
                    if (map.has(k)) replaced++;
                    map.set(k, it);
                });
                return { data: Array.from(map.values()).concat(rest), replaced: replaced };
            }

            window.phoneHandleFile = async function(e) {
                const file = e.target.files[0];
                if (!file) return;
                const name = file.name.toLowerCase();
                if (name.endsWith('.json')) {
                    try {
                        const text = await file.text();
                        const imported = JSON.parse(text);
                        if (!Array.isArray(imported)) throw new Error('JSON 数据必须是数组');
                        if (imported.length === 0) throw new Error('JSON 文件无有效数据');
                        // 【2026-09-21】原为 confirm("确定=覆盖 / 取消=按站名去重追加")：取消=写入，反直觉；
                        //   且保存失败不回滚（界面显示成功、刷新后丢失）。现在：三按钮 + 失败回滚 + 成功 toast。
                        const _prev = phoneData;
                        let _act = 'overwrite';
                        if (phoneData.length > 0) {
                            _act = await window.showChoiceModal({
                                title: '导入应急电话（JSON）',
                                body: '当前已有 ' + phoneData.length + ' 条，本次解析 ' + imported.length + ' 条。请选择处理方式：',
                                actions: [
                                    { label: '按 站名+单位+线名 去重追加', value: 'append', primary: true },
                                    { label: '覆盖现有', value: 'overwrite', danger: true },
                                    { label: '取消', value: 'cancel' }
                                ]
                            });
                            if (_act === 'cancel' || _act == null) { e.target.value = ''; return; }
                        }
                        phoneData = (_act === 'append') ? phoneMergeByStation(imported).data : imported;
                        if (!saveToStorage()) { phoneData = _prev; updateStats(); updatePhoneSuggestions(); e.target.value = ''; return; }   // 写失败回滚
                        phoneDoSearch();
                        if (window.showToast) window.showToast('✅ 已导入 ' + imported.length + ' 条应急电话（当前共 ' + phoneData.length + ' 条）', false, 6000);
                        try { if (typeof window.updateDataManagementStats === 'function') window.updateDataManagementStats(); } catch (e2) {}
                    } catch (err) { if (window.showToast) window.showToast('JSON 导入失败：' + err.message, true, 9000); else alert('JSON导入失败: ' + err.message); }
                } else {
                    await phoneHandleExcel({ target: { files: [file] } });
                }
                e.target.value = '';
            };

            window.phoneHandleExcel = async function(e) {
                const file = e.target.files[0];
                if (!file) return;
                // 先取文件再加载库：失败时也能在 finally 里复位 input（见下方 catch）
                if (!(await window.requireLib(LIB_XLSX_PHONE, { feature: 'Excel 导入' }))) { e.target.value = ''; return; }
                try {
                    // 【2026-09-21】CSV 同检查信息：文本读取 + 自动择码（Excel 另存 CSV 默认 GBK）
                    let workbook;
                    if (/\.csv$/i.test(file.name)) {
                        const _t = (typeof window.dsReadTextFileAutoEnc === 'function') ? await window.dsReadTextFileAutoEnc(file) : await file.text();
                        workbook = XLSX.read(_t, { type: 'string' });
                    } else {
                        const data = await file.arrayBuffer();
                        workbook = XLSX.read(data, { type: 'array', dense: true });   // 同检查信息：大表更省内存（只用 sheet_to_json 消费）
                    }
                    const firstSheet = workbook.Sheets[workbook.SheetNames[0]];
                    const jsonData = XLSX.utils.sheet_to_json(firstSheet, { header: 1 });
                    if (jsonData.length < 2) throw new Error('Excel文件数据不足');
                    const headers = jsonData[0].map(h => String(h).trim());
                    const colIndex = {
                        序号: headers.findIndex(h => h.includes('序号') || h.includes('序')),
                        单位: headers.findIndex(h => h.includes('单位')),
                        线名: headers.findIndex(h => h.includes('线名') || h.includes('线')),
                        站名: headers.findIndex(h => h.includes('站名') || h.includes('站')),
                        路电: headers.findIndex(h => h.includes('路电')),
                        市电: headers.findIndex(h => h.includes('市电')),
                        备注: headers.findIndex(h => h.includes('备注'))
                    };
                    if (colIndex.单位 === -1 || colIndex.站名 === -1) throw new Error('Excel中缺少必要的"单位"或"站名"列');
                    const newData = [];
                    for (let i = 1; i < jsonData.length; i++) {
                        const row = jsonData[i];
                        if (!row || row.length === 0) continue;
                        const item = {
                            序号: colIndex.序号 !== -1 ? row[colIndex.序号] : '',
                            单位: colIndex.单位 !== -1 ? String(row[colIndex.单位] || '').trim() : '',
                            线名: colIndex.线名 !== -1 ? String(row[colIndex.线名] || '').trim() : '',
                            站名: colIndex.站名 !== -1 ? String(row[colIndex.站名] || '').trim() : '',
                            路电: colIndex.路电 !== -1 ? String(row[colIndex.路电] || '').trim() : '',
                            市电: colIndex.市电 !== -1 ? String(row[colIndex.市电] || '').trim() : '',
                            备注: colIndex.备注 !== -1 ? String(row[colIndex.备注] || '').trim() : ''
                        };
                        if (item.单位 || item.站名) newData.push(item);
                    }
                    if (newData.length === 0) throw new Error('未找到有效数据');
                    // 【2026-09-21】同 JSON 路径：三按钮替代"确定=覆盖 / 取消=追加"，失败回滚 + 成功 toast
                    const _prevX = phoneData;
                    let _actX = 'overwrite';
                    if (phoneData.length > 0) {
                        _actX = await window.showChoiceModal({
                            title: '导入应急电话（Excel）',
                            body: '当前已有 ' + phoneData.length + ' 条，本次解析 ' + newData.length + ' 条。请选择处理方式：',
                            actions: [
                                { label: '按 站名+单位+线名 去重追加', value: 'append', primary: true },
                                { label: '覆盖现有', value: 'overwrite', danger: true },
                                { label: '取消', value: 'cancel' }
                            ]
                        });
                        if (_actX === 'cancel' || _actX == null) { try { e.target.value = ''; } catch (e3) {} return; }
                    }
                    phoneData = (_actX === 'append') ? phoneMergeByStation(newData).data : newData;
                    if (!saveToStorage()) { phoneData = _prevX; updateStats(); updatePhoneSuggestions(); try { e.target.value = ''; } catch (e4) {} return; }
                    phoneDoSearch();
                    if (window.showToast) window.showToast('✅ 已导入 ' + newData.length + ' 条应急电话（当前共 ' + phoneData.length + ' 条）', false, 6000);
                    try { if (typeof window.updateDataManagementStats === 'function') window.updateDataManagementStats(); } catch (e5) {}
                } catch (err) {
                    if (window.showToast) window.showToast('导入失败：' + err.message, true, 9000); else alert('导入失败: ' + err.message);
                    // 必须复位 input：否则同一文件再次选中不会触发 change，用户无法重试
                    try { e.target.value = ''; } catch (e2) {}
                }
            };

            window.phoneExportJSON = function() {
                if (phoneData.length === 0) { alert('没有数据可导出'); return; }
                window.showProgress(50, '正在导出应急电话…');
                const blob = new Blob([JSON.stringify(phoneData, null, 2)], { type: 'application/json' });
                window.downloadBlob(blob, '应急电话_' + window.localDateStr() + '.json');
                window.finishProgress('✅ 应急电话导出成功');
            };
            window.phoneDownloadTemplate = async function() {
                if (!(await window.requireLib(LIB_XLSX_PHONE, { feature: '模板下载' }))) return;
                if (typeof XLSX === 'undefined') { alert('XLSX 库未加载，请检查网络连接后重试'); return; }
                const template = [ { '序号': 1, '单位': '天水车站', '线名': '徐兰高速', '站名': '东岔站', '路电': '072631455', '市电': '09384931455', '备注': '' }, { '序号': 2, '单位': '天水车站', '线名': '徐兰高速', '站名': '天水南站', '路电': '072631456', '市电': '09384931456', '备注': '' } ];
                const ws = XLSX.utils.json_to_sheet(template);
                const wb = XLSX.utils.book_new();
                XLSX.utils.book_append_sheet(wb, ws, '模板');
                const tplOut = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
                window.downloadBlob(new Blob([tplOut], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), '电话导入模板.xlsx');
            };
            window.phoneShowClear = function() {
                if (phoneData.length === 0) { alert('没有数据可清空'); return; }
                if (confirm('确定清空所有电话数据吗？此操作不可恢复！')) { phoneData = []; saveToStorage(); phoneDoSearch(); }
            };

            const input = document.getElementById('phone-searchInput');
            if (input) {
                input.addEventListener('input', debounce(function() { showPhoneSuggestions(input); }, 300));
                input.addEventListener('blur', function() { setTimeout(() => { const sugg = document.getElementById('phone-suggestions'); if (sugg) sugg.style.display = 'none'; }, 200); });
            }
            document.getElementById('phone-fileInput').addEventListener('change', phoneHandleFile);
            // 暴露数据获取接口（供联动数据使用）
            window.getPhoneData = function() { return phoneData; };

            // 模块对象暴露（供智能体/统一增强模块调用，避免外部直接依赖内部变量 phoneData）
            if (!window.PhoneModule) {
                window.PhoneModule = {
                    getData: function() { return (typeof window.getPhoneData === 'function') ? window.getPhoneData() : []; },
                    search: function(kw) {
                        kw = String(kw || '').trim().toLowerCase();
                        var all = (typeof window.getPhoneData === 'function') ? window.getPhoneData() : [];
                        if (!kw) return all;
                        return all.filter(function(p) {
                            return ((p.站名 || '') + ' ' + (p.单位 || '') + ' ' + (p.线名 || '') + ' ' + (p.路电 || '') + ' ' + (p.市电 || '')).toLowerCase().indexOf(kw) !== -1;
                        });
                    }
                };
            }

            // ── 纯坐标反查（供智能体 Agent 调用，不操作 DOM）──
            // 复用与新版 weather 查询一致的省份两级过滤逻辑
            window.phoneGeocode = async function(stationName, lineName) {
                var geoName = String(stationName || '').replace(/站$/, '').replace(/[东西南北](南|北|东|西)?$/, '');
                if (!geoName || geoName.length < 2) geoName = String(stationName || '').replace(/[东西南北](南|北|东|西)?站?$/, '');
                if (!geoName || geoName.length < 2) geoName = stationName;
                function inProvince(r, list) {
                    if (r.country_code !== 'CN' && r.country !== '中国') return false;
                    var admin = (r.admin1 || '').replace(/省|市|自治区|回族|维吾尔|壮族|特别行政区/g, '');
                    return list.some(function(p) { return admin.indexOf(p) !== -1; });
                }
                function pickResult(results) {
                    if (!results || !results.length) return null;
                    // 兰州局及周边优先，其次全国兜底：
                    // 原来只认 甘肃/宁夏 + 陕西/四川 两级，内蒙古 / 新疆 / 青海 等站点会
                    // 全部落空并被 return null 丢弃，永远查不到坐标。
                    var tiers = [
                        ['甘肃', '宁夏'],
                        ['陕西', '四川', '青海', '内蒙古', '新疆'],
                        ['西藏', '重庆', '贵州', '云南', '山西', '河南', '湖北']
                    ];
                    for (var t = 0; t < tiers.length; t++) {
                        for (var i = 0; i < results.length; i++) {
                            if (inProvince(results[i], tiers[t])) return results[i];
                        }
                    }
                    // 省内匹配不上时，优先取中国境内第一条，而不是直接判空
                    for (var k = 0; k < results.length; k++) {
                        if (results[k].country_code === 'CN' || results[k].country === '中国') return results[k];
                    }
                    return results[0] || null;
                }
                async function searchOnce(q) {
                    try {
                        var url = 'https://geocoding-api.open-meteo.com/v1/search?name=' + encodeURIComponent(q) + '&count=8&language=zh&format=json';
                        var gr = await fetch(url);
                        var gd = await gr.json();
                        return pickResult(gd.results);
                    } catch (_) { return null; }
                }
                // 直接用站名查询：拼上线路名（"徐兰高速 东岔"）这种组合名在做前缀匹配的
                // geocoding 接口上几乎必然返回空，等于每次固定白跑一个请求。
                var chosen = await searchOnce(geoName);
                if (chosen) return { lat: chosen.latitude, lon: chosen.longitude };
                return null;
            };

            // ── 连接配置（本地 file:// 走代理，网站部署直接调 API）──
            const isLocal = document.location.protocol === 'file:';
            const PROXY = isLocal ? 'http://127.0.0.1:5188' : null;
            function weatherUrl(lat, lon) {
                const p = new URLSearchParams({
                    latitude:lat, longitude:lon,
                    current:'temperature_2m,relative_humidity_2m,apparent_temperature,precipitation,weather_code,wind_speed_10m,wind_direction_10m,surface_pressure',
                    daily:'weather_code,temperature_2m_max,temperature_2m_min,precipitation_sum,wind_speed_10m_max',
                    forecast_days:7, timezone:'Asia/Shanghai', wind_speed_unit:'ms',
                });
                return 'https://api.open-meteo.com/v1/forecast?' + p;
            }

            // ── 天气查询（美化版 + 联网查坐标 & 自动保存到本地）──
            window.phoneGetWeather = async function(stationName, lat, lon, boxId, lineName) {
                const box = document.getElementById(boxId);
                if (!box) return;
                box.style.display = 'block';
                box.innerHTML = '<span style="color:var(--text-secondary)">⏳ 查询中…</span>';
                const btn = box.previousElementSibling?.querySelector?.('.phone-weather-btn');
                if (btn) btn.disabled = true;

                try {
                    const _why = (k) => ({ 'no-key': '未接 API', 'no-websearch-api': '不可用', 'timeout': '超时', 'llm-not-found': '未查到该车站', 'llm-unparsed': '返回无法解析', 'llm-empty': '返回为空', 'network': '网络不可达', 'llm-failed': '调用失败' })[k] || '';
                    let w = null, srcLabel = '', srcNote = '', llmWhy = '';

                    // ① 【第一优先】大模型联网检索 —— **不需要坐标**。
                    //    用户反馈："榆中天气对话里能查到，应急电话却报'未找到坐标'"：
                    //    榆中不在内置字典、Open-Meteo 地名接口也匹配不到，而原实现在坐标解析失败时**直接放弃**，
                    //    连这条不需要坐标的路都没走。
                    try {
                        const llm = await window.queryWeatherSmart(stationName, { skipFree: true });
                        if (llm && llm.ok && llm.current) {
                            w = llm;
                            srcLabel = '🌐 数据来源：大模型联网检索' + (w.sourceName ? '（' + w.sourceName + '）' : '');
                            srcNote = '';   // 不再挂常驻提示（只有真降级时才写原因）
                        } else {
                            llmWhy = (llm && (llm.llmError || llm.error)) || 'llm-failed';
                        }
                    } catch (e) { llmWhy = (e && e.message) || 'llm-error'; }

                    // ② 只有需要免费公开接口时才解析坐标：
                    //    已存经纬度(缓存) > 内置车站字典 / 大模型联网查坐标 > Open-Meteo 地名接口
                    if (!w && (!lat || !lon)) {
                        if (!lat && typeof window.queryStationCoord === 'function') {
                            try {
                                const c = await window.queryStationCoord(stationName);
                                if (c && c.ok) { lat = c.lat; lon = c.lon; }
                            } catch (_) {}
                        }
                        if (!lat) {
                            try {
                                const coords = await window.phoneGeocode(stationName, lineName);
                                if (coords) { lat = coords.lat; lon = coords.lon; }
                            } catch (_) {}
                        }
                    }
                    // 把解析到的坐标补回电话簿：下次（含离线）可直接查
                    if (lat) {
                        for (let i = 0; i < phoneData.length; i++) {
                            if (phoneData[i].站名 === stationName) {
                                phoneData[i].纬度 = lat;
                                phoneData[i].经度 = lon;
                                break;
                            }
                        }
                        saveToStorage();
                    }

                    // ③ 免费直连 —— 字段最全（湿度/气压/风向/降水），file:// 开发态走本地代理 PROXY
                    if (!w && lat) {
                        try {
                            const r = await fetch(PROXY ? `${PROXY}/weather?lat=${lat}&lon=${lon}` : weatherUrl(lat, lon));
                            if (!r.ok) throw new Error('服务暂时不可用');
                            const raw = await r.json();
                            if (raw && raw.current) {
                                w = raw;
                                srcLabel = '🛰 数据来源：免费公开接口（Open-Meteo）';
                                srcNote = llmWhy ? '（大模型联网' + (_why(llmWhy) || '不可用') + '，已保底）' : '';
                            }
                        } catch (_) {}
                    }
                    // ④ 共享保底（**不再重试大模型**：上面刚试过；preferLLM:false 只走免费层，带 10 分钟缓存）
                    if (!w) {
                        const smart = await window.queryWeatherSmart(stationName, { preferLLM: false });
                        if (smart && smart.ok && smart.current) {
                            w = smart;
                            srcLabel = '🛰 数据来源：免费公开接口（Open-Meteo）';
                            srcNote = '（大模型联网' + (_why(smart.degraded || llmWhy) || '不可用') + '，已保底）';
                        }
                    }
                    // ⑤ 全失败 → 给出**可操作**的提示（别再只说"未找到坐标"）
                    if (!w) {
                        box.innerHTML = '<div style="background:#450a0a;border-radius:8px;padding:10px;color:#fca5a5;font-size:.82rem;text-align:center;">⚠️ 天气查询失败<br>'
                            + '<span style="opacity:.7;font-size:.78rem">'
                            + (lat ? ('大模型联网与免费接口都拿不到数据（' + (_why(llmWhy) || '网络受限') + '），请检查网络后重试')
                                   : '该站既没有坐标、联网也没查到：请在电话簿中为该站补充经纬度，或检查网络后重试')
                            + '</span></div>';
                        return;
                    }
                    const cur = w.current;
                    const daily = w.daily || { time: [] };   // 兜底路径可能只有实况，没有 7 天
                    const wmo = {
                        0:['☀️','晴','sunny'],1:['🌤️','少云','sunny'],2:['⛅','多云','cloudy'],3:['☁️','阴','cloudy'],
                        45:['🌫️','雾','foggy'],48:['🌫️','雾凇','foggy'],
                        51:['🌦️','毛毛雨','rainy'],53:['🌦️','毛毛雨','rainy'],55:['🌦️','强毛毛雨','rainy'],
                        56:['🌨️','冻毛毛雨','snowy'],57:['🌨️','强冻毛毛雨','snowy'],
                        61:['🌧️','小雨','rainy'],63:['🌧️','中雨','rainy'],65:['🌧️','大雨','rainy'],
                        66:['🌨️','冻雨','snowy'],67:['🌨️','强冻雨','snowy'],
                        71:['❄️','小雪','snowy'],73:['❄️','中雪','snowy'],75:['❄️','大雪','snowy'],77:['❄️','米雪','snowy'],
                        80:['🌦️','阵雨','rainy'],81:['🌧️','中阵雨','rainy'],82:['🌧️','强阵雨','rainy'],
                        85:['🌨️','阵雪','snowy'],86:['🌨️','强阵雪','snowy'],
                        95:['⛈️','雷暴','stormy'],96:['⛈️','雷暴伴冰雹','stormy'],99:['⛈️','强雷暴伴冰雹','stormy'],
                    };
                    // LLM 路径下个别数值可能为 null（模型没给）→ 统一显示 "—"，绝不能出现 0 / NaN
                    const fmt = (v, suf) => (v == null || v === '' || !isFinite(Number(v))) ? '—' : (Math.round(Number(v)) + (suf || ''));
                    const [icon0, desc0] = wmo[cur.weather_code] || ['🌡️','未知天气'];
                    const icon = cur.weatherEmoji || icon0;
                    const desc = cur.weather || desc0;                 // 大模型给的是文字，优先用原文
                    const dirs = ['北','东北','东','东南','南','西南','西','西北'];
                    const windDir = cur.windDir || (isFinite(Number(cur.wind_direction_10m)) ? dirs[Math.round(Number(cur.wind_direction_10m) / 45) % 8] : '—');

                    const now = new Date();
                    const timeStr = now.toLocaleString('zh-CN',{hour:'2-digit',minute:'2-digit'});
                    // 'YYYY-MM-DD' 必须按本地时间解析：new Date('2026-08-28') 按 UTC 午夜解析，
                    // 在 UTC 负偏移时区取 getDay() 会整体错一天（本文件已为此提供 getLocalDate 思路）
                    const _localDay = (s) => {
                        const p = String(s).split('-');
                        return new Date(+p[0], (+p[1]) - 1, +p[2]).getDay();
                    };
                    const wd = (s,i) => i===0?'今天':i===1?'明天':'周'+['日','一','二','三','四','五','六'][_localDay(s)];

                    let forecastHtml = '';
                    for (let i = 0; i < daily.time.length; i++) {
                        const fi = (daily.emoji && daily.emoji[i]) || (wmo[daily.weather_code[i]] || ['🌡️'])[0];
                        const dayLabel = daily.time[i] ? wd(daily.time[i], i) : ('第' + (i + 1) + '天');
                        forecastHtml += `<span style="display:inline-flex;flex-direction:column;align-items:center;gap:3px;min-width:40px;font-size:.78rem;color:#e2e8f0">
                            <span style="color:#94a3b8;font-weight:500">${dayLabel}</span>
                            <span style="font-size:1.2rem">${fi}</span>
                            <span><span style="color:#f87171;font-weight:600">${fmt(daily.temperature_2m_max[i],'°')}</span> <span style="color:#93c5fd">${fmt(daily.temperature_2m_min[i],'°')}</span></span>
                        </span>`;
                    }

                    box.innerHTML = `
                        <div style="background:linear-gradient(135deg,#262626,#1d1d1d);border-radius:10px;padding:14px;margin:-2px;">
                            <div style="display:flex;align-items:center;gap:16px;">
                                <div style="font-size:4rem;line-height:1;animation:weatherFloat 3s ease-in-out infinite;">${icon}</div>
                                <div style="flex:1">
                                    <div style="display:flex;align-items:baseline;gap:6px;">
                                        <span style="font-size:2.2rem;font-weight:700;color:#fff">${fmt(cur.temperature_2m,'°C')}</span>
                                        <span style="font-size:.85rem;color:#94a3b8">${desc}</span>
                                    </div>
                                    <div style="font-size:.78rem;color:#94a3b8;margin-top:2px;">🤚 体感 ${fmt(cur.apparent_temperature,'°C')} · ⏱ ${timeStr}</div>
                                </div>
                            </div>
                            <div style="display:flex;flex-wrap:wrap;gap:4px 16px;margin-top:8px;font-size:.82rem;color:#cbd5e1;border-top:1px solid #475569;padding-top:8px;">
                                <span>💧 湿度 ${fmt(cur.relative_humidity_2m,'%')}</span>
                                <span>🌬️ ${windDir} ${fmt(cur.wind_speed_10m,'m/s')}</span>
                                <span>🌧️ 降水 ${fmt(cur.precipitation,'mm')}</span>
                                <span>📊 气压 ${fmt(cur.surface_pressure,'hPa')}</span>
                            </div>
                            <div style="display:flex;gap:6px;margin-top:8px;padding-top:8px;border-top:1px solid #475569;flex-wrap:wrap;justify-content:space-between;">
                                ${forecastHtml}
                            </div>
                            <div class="phone-weather-src" style="margin-top:8px;padding-top:6px;border-top:1px solid #475569;font-size:.7rem;color:#94a3b8;display:flex;justify-content:space-between;gap:8px;">
                                <span>${srcLabel}</span><span style="opacity:.8">${srcNote}</span>
                            </div>
                        </div>
                    `;
                } catch(e) {
                    box.innerHTML = `<span class="err">⚠️ 查询失败${e.message.includes('fetch')?(PROXY?'：请确认天气代理已启动':'：网络请求失败，请检查站点能否访问 Open-Meteo'):''}</span>`;
                } finally {
                    if (btn) btn.disabled = false;
                }
            };

            loadFromStorage();
        })();
