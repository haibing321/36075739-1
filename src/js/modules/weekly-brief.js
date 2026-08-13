/* 每周安全简报（主动智能）
 * 思路（按用户反馈修正）：不再按月份硬套关键词，而是
 *   1) 取「管辖范围」车站（线别从应急电话导入，无数据时兜底兰州局）的实际天气预报（7天，open-meteo，无需密钥）；
 *   2) 用 WMO 天气代码 + 降水概率 + 温度 + 风速，研判本周铁路专业隐患（防洪/防寒/防雷/防雾/防胀/防风…）；
 *   3) 交叉本地检查信息（getIssueData），仅取「最近两周 + 去年同期同周两周」窗口内、按天气隐患关键词命中的条目，统计条数/红线/重大并做同比；
 *   4) 技术动态：资料库「技术动态」素材优先，无则 LLM 兜底生成；
 *   5) 渲染卡片 + 浏览器通知 + 存入资料库（通报文电），并按 ISO 周去重，仅周一首次打开推送。
 * 不改动 rule.js / issue.js（铁律），仅读取 getIssueData。
 */
(function () {
  'use strict';

  var WEEK_KEY = 'wb_weekly_brief_week';     // 已推送的周标识，用于去重
  var CFG_KEY  = 'wb_weekly_brief_cfg';      // {enabled, line}
  var BUREAU   = '兰州局';                    // 系统内置默认管辖范围
  var DEFAULT_STATIONS = ['兰州', '天水', '武威', '张掖', '嘉峪关', '银川', '中卫', '西宁', '格尔木', '陇南', '平凉'];
  var MAX_STATIONS = 12;

  // 从「应急电话」聚合 线别 → 相关站（站名/线名均来自电话数据，非手工输入）
  function getPhoneLines() {
    var data = [];
    try { data = (window.PhoneModule && window.PhoneModule.getData) ? window.PhoneModule.getData() : []; } catch (e) {}
    data = data || [];
    var map = {};          // line -> {station:true}
    var allStations = {};  // station -> true
    data.forEach(function (it) {
      var line = (it.线名 || '').trim();
      var st = (it.站名 || '').trim();
      if (!st) return;
      allStations[st] = true;
      if (line) { if (!map[line]) map[line] = {}; map[line][st] = true; }
    });
    var lines = Object.keys(map).sort().map(function (l) {
      return { line: l, stations: Object.keys(map[l]).sort() };
    });
    return { lines: lines, allStations: Object.keys(allStations).sort(), hasData: data.length > 0 };
  }

  // 当前所选「管辖范围」站名：无电话数据兜底兰州局；选线别取该线相关站；否则全部已导入
  function getStations() {
    var c = loadCfg();
    var info = getPhoneLines();
    if (!info.hasData) return DEFAULT_STATIONS.slice(0, MAX_STATIONS);
    if (!c.line || c.line === '__all__') return info.allStations.slice(0, MAX_STATIONS);
    var found = null;
    for (var i = 0; i < info.lines.length; i++) if (info.lines[i].line === c.line) { found = info.lines[i]; break; }
    return found ? found.stations.slice(0, MAX_STATIONS) : info.allStations.slice(0, MAX_STATIONS);
  }

  // 简报标题里的管辖范围标签
  function computeScopeLabel() {
    var c = loadCfg();
    var info = getPhoneLines();
    if (!info.hasData) return BUREAU;
    if (!c.line || c.line === '__all__') return '已导入管辖范围';
    return c.line;
  }

  /* ---------------- 配置 ---------------- */
  function loadCfg() {
    try {
      var c = JSON.parse(localStorage.getItem(CFG_KEY) || 'null');
      if (c && typeof c === 'object') {
        if (typeof c.enabled === 'undefined') c.enabled = true;
        if (typeof c.line === 'undefined') c.line = null;
        return c;
      }
    } catch (e) {}
    return { enabled: true, line: null };
  }
  function saveCfg(c) { try { localStorage.setItem(CFG_KEY, JSON.stringify(c)); } catch (e) {} }
  function isEnabled() { return loadCfg().enabled !== false; }

  /* ---------------- 周标识（ISO 周，周一为一周始） ---------------- */
  function getWeekKey(d) {
    d = d || new Date();
    var onejan = new Date(d.getFullYear(), 0, 1);
    var week = Math.ceil((((d - onejan) / 86400000) + onejan.getDay() + 1) / 7);
    return d.getFullYear() + '-W' + (week < 10 ? '0' + week : week);
  }

  /* ---------------- 天气 → 隐患 研判 ---------------- */
  // WMO weather_code → 隐患键
  var WMO_HAZARD = {
    51: 'rain', 53: 'rain', 55: 'rain', 56: 'rain', 57: 'rain',
    61: 'rain', 63: 'rain', 65: 'rain', 66: 'rain', 67: 'rain',
    80: 'rain', 81: 'rain', 82: 'rain_heavy',
    71: 'snow', 73: 'snow', 75: 'snow', 77: 'snow', 85: 'snow', 86: 'snow',
    95: 'thunder', 96: 'thunder', 99: 'thunder',
    45: 'fog', 48: 'fog'
  };
  // 隐患定义：trade 专业 / label 名称 / keywords 交叉检查信息 / advice 建议
  var HAZARDS = {
    rain:       { trade: '工务/供电', label: '防洪防汛·水害', keywords: ['防洪', '防汛', '水害', '边坡', '溜坍', '路基', '排水', '隧道漏水', '下沉', '积水'],
                  advice: '加强雨中雨后巡查，落实边坡溜坍及低洼处所防护，核查沿线排水与防雷接地。' },
    rain_heavy: { trade: '工务/供电', label: '暴雨·强降水', keywords: ['防洪', '暴雨', '水害', '边坡', '泥石流', '倒树', '侵限', '积水'],
                  advice: '严格执行雨量警戒，必要时封锁区间；防范边坡溜坍、危树倒伏侵限。' },
    snow:       { trade: '工务/车务', label: '防寒防冻·防雪打冰', keywords: ['防寒', '防冻', '防雪', '打冰', '道岔', '融雪', '结冰', '供暖', '客车', '防溜'],
                  advice: '落实道岔融雪及除冰，关注客车供暖；寒夜防溜措施到位。' },
    thunder:    { trade: '供电/信号', label: '防雷·过电压', keywords: ['防雷', '接地', '过电压', '雷击', '雷电', '接触网', 'SCADA', '绝缘'],
                  advice: '雷雨前后核查防雷接地与过电压保护，雷暴时段停止高处作业及接触网邻近作业。' },
    fog:        { trade: '车务/信号', label: '防雾·行车瞭望', keywords: ['雾', '瞭望', '信号', '减速', '限速', '能见度'],
                  advice: '雾天行车加强瞭望、按能见度控速，信号确认到位。' },
    heat:       { trade: '工务', label: '防胀轨跑道', keywords: ['胀轨', '无缝线路', '轨温', '跑道', '高温', '防胀'],
                  advice: '高温时段监测轨温，无缝线路作业严格按轨温条件，备好防胀措施。' },
    cold:       { trade: '工务/车务', label: '防断·防寒', keywords: ['断轨', '折断', '防断', '低温', '防寒', '冻结', '裂纹'],
                  advice: '低温及剧变时段加强钢轨探伤与巡道，防范断轨。' },
    wind:       { trade: '供电/通用', label: '防风·揭掀', keywords: ['大风', '揭掀', '彩钢瓦', '广告牌', '接触网', '防风', '上跨', '轻飘物'],
                  advice: '大风预警巡查沿线轻飘物（彩钢瓦、防尘网），防范刮落侵限及接触网异物。' }
  };

  // 单日研判：返回 {隐患键: 频次}
  function classifyDay(day) {
    var hits = {};
    var code = day.weather_code;
    if (WMO_HAZARD[code]) {
      var h = WMO_HAZARD[code];
      hits[h] = (hits[h] || 0) + 1;
      if (h === 'rain_heavy') hits['rain'] = (hits['rain'] || 0) + 1;
    }
    var precip = Number(day.precip); if (isNaN(precip)) precip = 0;
    if (precip >= 60) hits['rain'] = (hits['rain'] || 0) + 1;
    if (precip >= 80) hits['rain_heavy'] = (hits['rain_heavy'] || 0) + 1;
    var tmax = Number(day.tmax); if (isNaN(tmax)) tmax = 999;
    var tmin = Number(day.tmin); if (isNaN(tmin)) tmin = 999;
    if (tmax >= 35) hits['heat'] = (hits['heat'] || 0) + 1;
    if (tmin <= -10) { hits['cold'] = (hits['cold'] || 0) + 1; hits['snow'] = (hits['snow'] || 0) + 1; }
    var wind = Number(day.wind); if (isNaN(wind)) wind = 0;
    if (wind >= 36) hits['wind'] = (hits['wind'] || 0) + 1; // 36km/h ≈ 10m/s
    return hits;
  }

  /* ---------------- 交叉本地检查信息（按时间窗：近两周 + 去年同期同周两周） ---------------- */
  // 仅统计落在「最近两周」与「去年同期同周两周」内的检查信息，并给出同比
  function matchIssues(keywords) {
    var issues = (typeof window.getIssueData === 'function') ? window.getIssueData() : [];
    issues = issues || [];
    var now = Date.now();
    var DAY = 864e5;
    var recentStart = now - 14 * DAY;                 // 最近两周起点
    var ly = now - 364 * DAY;                         // 去年同期同周（约 52 周前）
    var sameStart = ly - 7 * DAY;                     // 同期两周起点
    var sameEnd = ly + 7 * DAY;                       // 同期两周终点
    var recent = { total: 0, redline: 0, major: 0 };
    var same = { total: 0, redline: 0, major: 0 };
    function tally(bucket, it) {
      bucket.total++;
      var nature = (it.性质 || it.nature || '');
      if (/红线/.test(nature)) bucket.redline++;
      else if (/重大/.test(nature)) bucket.major++;
    }
    for (var i = 0; i < issues.length; i++) {
      var it = issues[i] || {};
      var text = ((it.category || '') + ' ' + (it.content || '') + ' ' + (it.regulation || '') + ' ' + (it.unit || '')).toLowerCase();
      var hit = keywords.some(function (k) { return text.indexOf(k.toLowerCase()) !== -1; });
      if (!hit) continue;
      var ts = new Date(it.datetime || 0).getTime();
      if (isNaN(ts)) continue;                        // 无日期不参与时间窗统计
      if (ts >= recentStart && ts <= now) tally(recent, it);
      else if (ts >= sameStart && ts <= sameEnd) tally(same, it);
    }
    return { recent: recent, same: same };
  }

  /* ---------------- 取管辖范围天气预报 ---------------- */
  async function fetchJurisdictionWeather(stations) {
    if (typeof window._agentExecuteTool !== 'function') return [];
    var results = await Promise.allSettled(stations.map(function (s) {
      return window._agentExecuteTool('get_weather', { stationName: s });
    }));
    var out = [];
    results.forEach(function (r) {
      // _agentExecuteTool 把 handler 的真实返回值包在 result 字段里
      var res = r.value && r.value.result;
      if (r.status === 'fulfilled' && res && res.ok && res.daily) {
        out.push({ station: res.station, daily: res.daily });
      } else if (r.status === 'rejected') {
        if (typeof console !== 'undefined') console.warn('[WeeklyBrief] 天气获取失败:', r.reason);
      }
    });
    return out;
  }

  // 汇总多站×7天
  function aggregateWeather(weatherList) {
    var tally = {};
    var dayNotes = [];
    var maxT = -99, minT = 99, maxWind = 0;
    weatherList.forEach(function (w) {
      var d = w.daily;
      for (var i = 0; i < d.time.length; i++) {
        var day = { weather_code: d.weather_code[i], tmax: d.tmax[i], tmin: d.tmin[i], precip: d.precip[i], wind: d.wind[i] };
        var hits = classifyDay(day);
        Object.keys(hits).forEach(function (k) { tally[k] = (tally[k] || 0) + hits[k]; });
        var tmax = Number(d.tmax[i]); if (!isNaN(tmax) && tmax > maxT) maxT = tmax;
        var tmin = Number(d.tmin[i]); if (!isNaN(tmin) && tmin < minT) minT = tmin;
        var wind = Number(d.wind[i]); if (!isNaN(wind) && wind > maxWind) maxWind = wind;
        var code = d.weather_code[i];
        if (code === 82 || code === 65 || code === 95) {
          dayNotes.push((w.station || '') + ' ' + String(d.time[i]).slice(5) + (code === 82 ? '暴雨' : code === 65 ? '大雨' : '雷暴'));
        }
      }
    });
    return { tally: tally, maxT: maxT, minT: minT, maxWind: maxWind, dayNotes: dayNotes };
  }

  // 天气不可用时按季节兜底（仅作弱化研判）
  function seasonFallback() {
    var m = new Date().getMonth() + 1;
    var tally = {};
    if (m >= 6 && m <= 8) { tally['rain'] = 7; tally['thunder'] = 3; tally['heat'] = 3; }
    else if (m >= 12 || m <= 2) { tally['snow'] = 7; tally['cold'] = 5; tally['wind'] = 2; }
    else if (m >= 3 && m <= 5) { tally['rain'] = 4; }
    else { tally['snow'] = 2; tally['wind'] = 2; }
    return { tally: tally, maxT: 99, minT: -99, maxWind: 0, dayNotes: [] };
  }

  /* ---------------- 组装简报文本 ---------------- */
  function buildSeasonBlock(agg, stations, usedFallback, scopeLabel) {
    var lines = [];
    lines.push('【天气研判】管辖范围：' + (scopeLabel || BUREAU) + ' · 共 ' + stations.length + ' 站' + (usedFallback ? '（天气接口暂不可用，按季节研判）' : ''));
    if (!usedFallback) {
      lines.push('未来7天：管内最高 ' + (agg.maxT > -99 ? agg.maxT + '°C' : '—') +
                 ' / 最低 ' + (agg.minT < 99 ? agg.minT + '°C' : '—') +
                 '，最大风速 ' + (agg.maxWind ? agg.maxWind + 'km/h' : '—') + '。');
      if (agg.dayNotes.length) lines.push('重点天气日：' + agg.dayNotes.slice(0, 6).join('；') + '。');
    }
    var keys = Object.keys(agg.tally).sort(function (a, b) { return agg.tally[b] - agg.tally[a]; });
    if (!keys.length) {
      lines.push('本周管内天气平稳，未见明显极端天气，按季节性常规防控即可。');
    } else {
      lines.push('研判重点隐患（近两周，并对比去年同期同周）：');
      keys.slice(0, 5).forEach(function (k, idx) {
        var h = HAZARDS[k]; if (!h) return;
        var m = matchIssues(h.keywords);
        var rec = m.recent, sam = m.same;
        var recTxt = rec.total
          ? ('近两周相关 ' + rec.total + ' 条' + (rec.redline ? '（红线' + rec.redline + '）' : '') + (rec.major ? '（重大' + rec.major + '）' : ''))
          : '近两周检查信息中暂未匹配到同类问题';
        var samTxt = sam.total ? ('；去年同期同周 ' + sam.total + ' 条') : '；去年同期同周无记录';
        var trend = '';
        if (rec.total && sam.total) {
          if (rec.total > sam.total) trend = '（同比增多）';
          else if (rec.total < sam.total) trend = '（同比下降）';
          else trend = '（同比持平）';
        }
        lines.push((idx + 1) + '. ' + h.label + '（' + h.trade + '，天气频次' + agg.tally[k] + '）：' + recTxt + samTxt + trend + '。建议：' + h.advice);
      });
    }
    return lines.join('\n');
  }

  // 技术动态：资料库素材优先，LLM 兜底
  async function buildTechBlock() {
    var mats = [];
    try { if (typeof window._wrGetAllMaterials === 'function') mats = await window._wrGetAllMaterials(); } catch (e) {}
    var tech = (mats || []).filter(function (m) {
      var t = (m.matType || '') + ' ' + (m.type || '') + ' ' + (m.title || '');
      return /技术|发展|应用|动态|创新|智能/.test(t);
    });
    if (tech.length) {
      tech = tech.slice(0, 3);
      return '【技术动态】（资料库素材）\n' + tech.map(function (m) { return '· ' + (m.title || '未命名'); }).join('\n');
    }
    var text = await llmTech();
    if (text) return '【技术动态】（智能生成）\n' + text;
    return '【技术动态】暂无技术动态素材；可在资料库补充「铁路技术应用/发展」类资料，系统将每周自动汇总推送。';
  }

  async function llmTech() {
    try {
      var key = localStorage.getItem('ds_api_key_v1');
      var url = localStorage.getItem('ds_api_url_v1') || 'https://api.deepseek.com/chat/completions';
      if (!key) return '';
      var ctrl = new AbortController();
      var t = setTimeout(function () { ctrl.abort(); }, 15000);
      var resp = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + key },
        body: JSON.stringify({
          model: localStorage.getItem('ds_model_v1') || 'deepseek-v4-flash',
          stream: false,
          messages: [
            { role: 'system', content: '你是铁路安全监察技术情报助手。基于通用知识，输出 2-3 条近期铁路安全技术应用与发展趋势要点，聚焦工务、供电、信号、车务等专业的可落地技术方向。不要编造具体新闻事件、不要使用不确定的人名。每条不超过 60 字。' },
            { role: 'user', content: '请输出本周铁路安全技术应用与发展要点。' }
          ]
        }),
        signal: ctrl.signal
      });
      clearTimeout(t);
      if (!resp.ok) return '';
      var j = await resp.json();
      var c = j && j.choices && j.choices[0];
      var content = c ? (c.message ? c.message.content : (c.generated_message ? c.generated_message.content : (c.delta ? c.delta.content : ''))) : '';
      return content ? String(content).trim() : '';
    } catch (e) { return ''; }
  }

  /* ---------------- 渲染 / 通知 / 存档 ---------------- */
  function renderCard(brief) {
    var main = document.querySelector('main.main') || document.body;
    var old = document.getElementById('weekly-brief-card');
    if (old) old.remove();
    var card = document.createElement('div');
    card.id = 'weekly-brief-card';
    card.style.cssText = 'margin:12px 0;padding:16px 18px;border-radius:14px;background:#f8fafc;border:1px solid #c7d2fe;border-left:4px solid var(--primary);box-shadow:0 2px 10px rgba(0,0,0,.04);';
    var head = document.createElement('div');
    head.style.cssText = 'display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;';
    var title = document.createElement('div');
    title.style.cssText = 'font-weight:700;color:var(--primary);font-size:0.98rem;';
    title.textContent = '📅 本周安全简报（' + brief.weekKey + '）';
    var close = document.createElement('button');
    close.textContent = '✕';
    close.style.cssText = 'background:none;border:none;font-size:1.1rem;cursor:pointer;color:#94a3b8;';
    close.setAttribute('aria-label', '关闭');
    close.addEventListener('click', function () { card.remove(); });
    head.appendChild(title); head.appendChild(close);
    var bodyEl = document.createElement('div');
    bodyEl.style.cssText = 'font-size:0.86rem;line-height:1.7;color:#334155;white-space:pre-wrap;';
    bodyEl.textContent = brief.season + '\n\n' + brief.tech;
    card.appendChild(head); card.appendChild(bodyEl);
    main.insertBefore(card, main.firstChild);
  }

  function notify(brief) {
    try {
      if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
        new Notification('安监每周安全简报', { body: '本周简报已生成：' + brief.weekKey });
      } else if (typeof Notification !== 'undefined' && Notification.permission === 'default') {
        Notification.requestPermission();
      }
    } catch (e) {}
    toast('📅 已生成本周安全简报（' + brief.weekKey + '）');
  }

  function toast(msg) {
    try {
      var host = document.getElementById('wb-brief-toasts');
      if (!host) {
        host = document.createElement('div');
        host.id = 'wb-brief-toasts';
        host.style.cssText = 'position:fixed;top:12px;right:12px;z-index:3000;display:flex;flex-direction:column;gap:8px;max-width:320px;pointer-events:none;';
        document.body.appendChild(host);
      }
      var el = document.createElement('div');
      el.textContent = msg;
      el.style.cssText = 'background:#1e293b;color:#e2e8f0;padding:10px 14px;border-radius:10px;font-size:13px;line-height:1.5;box-shadow:0 4px 16px rgba(0,0,0,.25);border:1px solid #334155;pointer-events:auto;';
      host.appendChild(el);
      setTimeout(function () { if (el.parentNode) el.parentNode.removeChild(el); }, 8000);
    } catch (e) {}
  }

  function archive(brief) {
    try {
      var req = indexedDB.open('railway_writer_db', 2);
      req.onsuccess = function (e) {
        var db = e.target.result;
        if (!db.objectStoreNames.contains('writing_materials')) { db.close(); return; }
        var tx = db.transaction('writing_materials', 'readwrite');
        tx.objectStore('writing_materials').add({
          matType: 'dispatch',
          title: '【每周安全简报】' + brief.weekKey,
          content: brief.season + '\n\n' + brief.tech,
          importAt: Date.now()
        });
        tx.oncomplete = function () { db.close(); };
      };
      req.onerror = function () {};
    } catch (e) {}
  }

  /* ---------------- 生成 ---------------- */
  async function generate(opts) {
    opts = opts || {};
    var weekKey = getWeekKey();
    var stations = getStations();
    var scopeLabel = computeScopeLabel();
    var agg, usedFallback = false;
    if (navigator.onLine !== false) {
      var wl = await fetchJurisdictionWeather(stations);
      if (wl.length) agg = aggregateWeather(wl);
    }
    if (!agg) { agg = seasonFallback(); usedFallback = true; }
    var season = buildSeasonBlock(agg, stations, usedFallback, scopeLabel);
    var tech = await buildTechBlock();
    var brief = { weekKey: weekKey, season: season, tech: tech };
    renderCard(brief);
    notify(brief);
    archive(brief);
    if (!opts.skipMark) { try { localStorage.setItem(WEEK_KEY, weekKey); } catch (e) {} }
    return brief;
  }

  /* ---------------- 设置绑定 ---------------- */
  function bindSettings() {
    var toggle = document.getElementById('wb-brief-enabled');
    var sel = document.getElementById('wb-brief-line');
    var previewEl = document.getElementById('wb-brief-stations-preview');
    var previewBtn = document.getElementById('wb-brief-preview');

    function refreshPreview() {
      if (!previewEl) return;
      var info = getPhoneLines();
      if (!info.hasData) { previewEl.textContent = '（未导入应急电话，使用默认兰州局范围）'; return; }
      previewEl.textContent = getStations().join('、') || '—';
    }

    if (toggle) {
      toggle.checked = isEnabled();
      toggle.addEventListener('change', function () {
        var cfg = loadCfg(); cfg.enabled = toggle.checked; saveCfg(cfg);
      });
    }
    if (sel) {
      var info = getPhoneLines();
      sel.innerHTML = '';
      if (!info.hasData) {
        var opt0 = document.createElement('option');
        opt0.textContent = '（请先在电话模块导入应急电话）';
        opt0.value = ''; opt0.disabled = true;
        sel.appendChild(opt0);
      } else {
        var allOpt = document.createElement('option');
        allOpt.value = '__all__';
        allOpt.textContent = '全部已导入（' + info.allStations.length + ' 站）';
        sel.appendChild(allOpt);
        info.lines.forEach(function (x) {
          var o = document.createElement('option');
          o.value = x.line; o.textContent = x.line + '（' + x.stations.length + ' 站）';
          sel.appendChild(o);
        });
      }
      var cfg = loadCfg();
      var pick = cfg.line || (info.lines.length ? info.lines[0].line : '__all__');
      if (pick) { try { sel.value = pick; } catch (e) {} }
      sel.addEventListener('change', function () {
        var c = loadCfg(); c.line = sel.value || null; saveCfg(c); refreshPreview();
      });
      refreshPreview();
    }
    if (previewBtn) previewBtn.addEventListener('click', function () { generate({ skipMark: true }); });
  }

  /* ---------------- 启动 ---------------- */
  function init() {
    bindSettings();
    if (!isEnabled()) return;
    var now = new Date();
    var weekKey = getWeekKey(now);
    var last = '';
    try { last = localStorage.getItem(WEEK_KEY) || ''; } catch (e) {}
    if (now.getDay() === 1 && last !== weekKey) generate();
  }

  window.WeeklyBrief = { init: init, preview: function () { return generate({ skipMark: true }); }, generate: generate };
})();
