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
            function saveToStorage() {
                try { localStorage.setItem(STORAGE_KEY, JSON.stringify(phoneData)); updateStats(); updatePhoneSuggestions(); } catch (e) { alert('保存失败：' + e.message); }
            }
            function updateStats() {
                const count = phoneData.length;
                document.getElementById('phone-recordCount').textContent = count + ' 条';
                let sizeMB = 0;
                if (count > 0) { const jsonStr = JSON.stringify(phoneData); sizeMB = (new Blob([jsonStr]).size / 1024 / 1024).toFixed(2); }
                document.getElementById('phone-storageText').textContent = sizeMB + ' MB';
                const percent = Math.min((sizeMB / 10) * 100, 100);
                const bar = document.getElementById('phone-storageBar');
                bar.style.width = percent + '%';
                if (percent > 80) bar.className = 'storage-fill danger';
                else if (percent > 60) bar.className = 'storage-fill warning';
                else bar.className = 'storage-fill';
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
                container.innerHTML = filtered.map(s => `<div onclick="selectPhoneSuggestion('${s}')">${escapeHtml(s)}</div>`).join('');
                container.style.display = 'block';
            }
            window.selectPhoneSuggestion = function(s) {
                document.getElementById('phone-searchInput').value = s;
                document.getElementById('phone-suggestions').style.display = 'none';
                phoneDoSearch();
            };

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
                                <span><button class="phone-weather-btn" onclick="phoneGetWeather('${escapeHtml(item.站名||'')}',${item.纬度},${item.经度},'${weatherId}','${escapeHtml(item.线名||'')}')">☀️ 查看天气</button></span>
                                ` : ''}
                            </div>
                            <div class="phone-weather-box" id="${weatherId}"></div>
                        </div>
                    `;
                });
                resultsContainer.innerHTML = html;
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

            // 按站名去重合并：同名站点以导入数据覆盖，新站点追加
            function phoneMergeByStation(incoming) {
                const map = new Map();
                phoneData.forEach(function(it) { if (it.站名) map.set(it.站名, it); });
                let replaced = 0;
                incoming.forEach(function(it) {
                    if (it.站名 && map.has(it.站名)) replaced++;
                    if (it.站名) map.set(it.站名, it);
                });
                return { data: Array.from(map.values()), replaced: replaced };
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
                        if (phoneData.length > 0) {
                            const action = confirm(`成功解析 ${imported.length} 条JSON记录。\n当前已有 ${phoneData.length} 条。\n点击"确定"覆盖，点击"取消"按站名去重追加。`);
                            if (action) phoneData = imported;
                            else { const m = phoneMergeByStation(imported); phoneData = m.data; }
                        } else phoneData = imported;
                        saveToStorage();
                        phoneDoSearch();
                    } catch (err) { alert('JSON导入失败: ' + err.message); }
                } else {
                    await phoneHandleExcel({ target: { files: [file] } });
                }
                e.target.value = '';
            };

            window.phoneHandleExcel = async function(e) {
                await loadScript('https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js');
                const file = e.target.files[0];
                if (!file) return;
                try {
                    const data = await file.arrayBuffer();
                    const workbook = XLSX.read(data, { type: 'array' });
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
                    if (phoneData.length > 0) {
                        const action = confirm(`成功解析 ${newData.length} 条记录。\n当前已有 ${phoneData.length} 条。\n点击"确定"覆盖，点击"取消"按站名去重追加。`);
                        if (action) phoneData = newData;
                        else { const m = phoneMergeByStation(newData); phoneData = m.data; }
                    } else phoneData = newData;
                    saveToStorage();
                    phoneDoSearch();
                } catch (err) { alert('导入失败: ' + err.message); }
            };

            window.phoneExportJSON = function() {
                if (phoneData.length === 0) { alert('没有数据可导出'); return; }
                window.showProgress(50, '正在导出应急电话…');
                const blob = new Blob([JSON.stringify(phoneData, null, 2)], { type: 'application/json' });
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = '应急电话_' + new Date().toISOString().slice(0,10) + '.json';
                a.click();
                URL.revokeObjectURL(url);
                window.finishProgress('✅ 应急电话导出成功');
            };
            window.phoneDownloadTemplate = async function() {
                await loadScript('https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js');
                if (typeof XLSX === 'undefined') { alert('XLSX 库未加载，请检查网络连接后重试'); return; }
                const template = [ { '序号': 1, '单位': '天水车站', '线名': '徐兰高速', '站名': '东岔站', '路电': '072631455', '市电': '09384931455', '备注': '' }, { '序号': 2, '单位': '天水车站', '线名': '徐兰高速', '站名': '天水南站', '路电': '072631456', '市电': '09384931456', '备注': '' } ];
                const ws = XLSX.utils.json_to_sheet(template);
                const wb = XLSX.utils.book_new();
                XLSX.utils.book_append_sheet(wb, ws, '模板');
                XLSX.writeFile(wb, '电话导入模板.xlsx');
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

            // ── 纯坐标反查（供智能体 Agent 调用，不操作 DOM）──
            // 复用与新版 weather 查询一致的省份两级过滤逻辑
            window.phoneGeocode = async function(stationName, lineName) {
                var geoName = String(stationName || '').replace(/站$/, '').replace(/[东西南北](南|北|东|西)?$/, '');
                if (!geoName || geoName.length < 2) geoName = String(stationName || '').replace(/[东西南北](南|北|东|西)?站?$/, '');
                if (!geoName || geoName.length < 2) geoName = stationName;
                function inProvince(r, list) {
                    if (r.country_code !== 'CN' && r.country !== '中国') return false;
                    var admin = (r.admin1 || '').replace(/省|自治区|回族|维吾尔/g, '');
                    return list.some(function(p) { return admin.indexOf(p) !== -1; });
                }
                function pickResult(results) {
                    if (!results || !results.length) return null;
                    for (var i = 0; i < results.length; i++) if (inProvince(results[i], ['甘肃', '宁夏'])) return results[i];
                    for (var j = 0; j < results.length; j++) if (inProvince(results[j], ['陕西', '四川'])) return results[j];
                    return null;
                }
                async function searchOnce(q) {
                    try {
                        var url = 'https://geocoding-api.open-meteo.com/v1/search?name=' + encodeURIComponent(q) + '&count=8&language=zh&format=json';
                        var gr = await fetch(url);
                        var gd = await gr.json();
                        return pickResult(gd.results);
                    } catch (_) { return null; }
                }
                var chosen = await searchOnce(lineName ? lineName + ' ' + geoName : geoName);
                if (!chosen) chosen = await searchOnce(geoName);
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
                    // 坐标优先级：已存经纬度(缓存命中) > 联网 geocode
                    // 这样离线/file:// 无代理时也能查已存坐标的天气，且避免每次多余请求
                    if (!lat || !lon) {
                        try {
                            const coords = await window.phoneGeocode(stationName, lineName);
                            if (coords) { lat = coords.lat; lon = coords.lon; }
                        } catch (_) {}
                    }
                    // 把（geocode 得到的）坐标补回数据，便于下次离线直接查
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

                    if (!lat) {
                        box.innerHTML = `<div style="background:#450a0a;border-radius:8px;padding:10px;color:#fca5a5;font-size:.82rem;text-align:center;">⚠️ 未找到坐标，暂无法查天气。<br><span style="opacity:.7;font-size:.78rem">联网搜索不可用时请手动补充</span></div>`;
                        return;
                    }

                    const r = await fetch(PROXY ? `${PROXY}/weather?lat=${lat}&lon=${lon}` : weatherUrl(lat, lon));
                    if (!r.ok) throw new Error('服务暂时不可用');
                    const w = await r.json();
                    const cur = w.current;
                    const daily = w.daily;
                    const wmo = {
                        0:['☀️','晴','sunny'],1:['🌤️','少云','sunny'],2:['⛅','多云','cloudy'],3:['☁️','阴','cloudy'],
                        45:['🌫️','雾','foggy'],51:['🌦️','毛毛雨','rainy'],61:['🌧️','小雨','rainy'],
                        63:['🌧️','中雨','rainy'],65:['🌧️','大雨','rainy'],71:['❄️','小雪','snowy'],
                        73:['❄️','中雪','snowy'],75:['❄️','大雪','snowy'],95:['⛈️','雷暴','stormy'],
                    };
                    const [icon, desc] = wmo[cur.weather_code] || ['🌡️',`码${cur.weather_code}`];
                    const dirs = ['北','东北','东','东南','南','西南','西','西北'];
                    const windDir = dirs[Math.round(cur.wind_direction_10m / 45) % 8];

                    const now = new Date();
                    const timeStr = now.toLocaleString('zh-CN',{hour:'2-digit',minute:'2-digit'});
                    const wd = (s,i) => i===0?'今天':i===1?'明天':'周'+['日','一','二','三','四','五','六'][new Date(s).getDay()];

                    let forecastHtml = '';
                    for (let i = 0; i < daily.time.length; i++) {
                        const [fi] = wmo[daily.weather_code[i]] || ['🌡️',''];
                        const dayLabel = wd(daily.time[i], i);
                        forecastHtml += `<span style="display:inline-flex;flex-direction:column;align-items:center;gap:3px;min-width:40px;font-size:.78rem;color:#e2e8f0">
                            <span style="color:#94a3b8;font-weight:500">${dayLabel}</span>
                            <span style="font-size:1.2rem">${fi}</span>
                            <span><span style="color:#f87171;font-weight:600">${Math.round(daily.temperature_2m_max[i])}°</span> <span style="color:#93c5fd">${Math.round(daily.temperature_2m_min[i])}°</span></span>
                        </span>`;
                    }

                    box.innerHTML = `
                        <div style="background:linear-gradient(135deg,#1e3a5f,#1e293b);border-radius:10px;padding:14px;margin:-2px;">
                            <div style="display:flex;align-items:center;gap:16px;">
                                <div style="font-size:4rem;line-height:1;animation:weatherFloat 3s ease-in-out infinite;">${icon}</div>
                                <div style="flex:1">
                                    <div style="display:flex;align-items:baseline;gap:6px;">
                                        <span style="font-size:2.2rem;font-weight:700;color:#fff">${Math.round(cur.temperature_2m)}°C</span>
                                        <span style="font-size:.85rem;color:#94a3b8">${desc}</span>
                                    </div>
                                    <div style="font-size:.78rem;color:#94a3b8;margin-top:2px;">🤚 体感 ${Math.round(cur.apparent_temperature)}°C · ⏱ ${timeStr}</div>
                                </div>
                            </div>
                            <div style="display:flex;flex-wrap:wrap;gap:4px 16px;margin-top:8px;font-size:.82rem;color:#cbd5e1;border-top:1px solid #475569;padding-top:8px;">
                                <span>💧 湿度 ${cur.relative_humidity_2m}%</span>
                                <span>🌬️ ${windDir} ${cur.wind_speed_10m}m/s</span>
                                <span>🌧️ 降水 ${cur.precipitation}mm</span>
                                <span>📊 气压 ${Math.round(cur.surface_pressure)}hPa</span>
                            </div>
                            <div style="display:flex;gap:6px;margin-top:8px;padding-top:8px;border-top:1px solid #475569;flex-wrap:wrap;justify-content:space-between;">
                                ${forecastHtml}
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
