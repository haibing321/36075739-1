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
  var CFG_KEY  = 'wb_weekly_brief_cfg';      // {enabled, lines:{线名:'ALL'|站名[]}}
  var BUREAU   = '兰州局';                    // 系统内置默认管辖范围
  var DEFAULT_STATIONS = ['兰州', '天水', '武威', '张掖', '嘉峪关', '银川', '中卫', '西宁', '格尔木', '陇南', '平凉'];
  var MAX_STATIONS = 12;

  // 从单位名推导专业（与 issue.js extractTradeFromUnit 保持一致；此处独立实现，不依赖外部模块）
  function extractTrade(unitName) {
    if (!unitName) return '';
    var name = String(unitName).trim();
    var unitTradeMap = [
      { keywords: ['天水车站', '兰州车站', '迎水桥车站', '兰州北车站', '调度所', '银川车站'], trade: '车务' },
      { keywords: ['物流中心'], trade: '货运' },
      { keywords: ['天平', '华澳', '工程管理所', '工程建设指挥部', '甘肃信达', '宁夏城际'], trade: '建设' },
      { keywords: ['宁夏铁路多远', '宁夏铁路多元', '国际旅行', '疾病预防控制所', '后勤保障', '职工培训中心', '金轮实业'], trade: '辅业' },
      { keywords: ['综合维修'], trade: '高铁基础设施' }
    ];
    for (var mi = 0; mi < unitTradeMap.length; mi++) {
      for (var ki = 0; ki < unitTradeMap[mi].keywords.length; ki++) {
        if (name.indexOf(unitTradeMap[mi].keywords[ki]) !== -1) return unitTradeMap[mi].trade;
      }
    }
    var tradeKeys = ['高铁基础设施', '综合维修', '基础设施', '客运', '货运', '车务', '机务', '工务', '电务', '供电', '车辆', '房建', '给水'];
    for (var i = 0; i < tradeKeys.length; i++) {
      if (name.indexOf(tradeKeys[i]) !== -1) return tradeKeys[i];
    }
    if (name.indexOf('通信') !== -1 || name.indexOf('信号') !== -1) return '电务';
    return name; // 未匹配返回单位名本身（便于排查未归类单位）
  }

  // 可选专业清单：默认常见专业 + 检查信息中实际出现的专业
  var DEFAULT_TRADES = ['车务', '货运', '建设', '辅业', '工务', '电务', '供电', '车辆', '机务', '房建', '客运', '高铁基础设施'];
  function getTrades() {
    var set = {};
    DEFAULT_TRADES.forEach(function (t) { set[t] = true; });
    var issues = (typeof window.getIssueData === 'function') ? window.getIssueData() : [];
    (issues || []).forEach(function (it) {
      if (it.unit) { var t = extractTrade(it.unit); if (t) set[t] = true; }
    });
    return Object.keys(set).sort(function (a, b) { return a.localeCompare(b, 'zh'); });
  }
  function tradesLabel(trades) {
    if (!trades || !trades.length) return '全部专业';
    return trades.join('/');
  }

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

  // 当前所选「管辖范围」站名：无电话数据兜底兰州局；多选线别 + 长线可只选部分站
  function getStations() {
    var c = loadCfg();
    var info = getPhoneLines();
    if (!info.hasData) return DEFAULT_STATIONS.slice(0, MAX_STATIONS);
    var sel = c.lines || {};
    var keys = Object.keys(sel);
    if (!keys.length) return info.allStations.slice(0, MAX_STATIONS); // 未勾选则默认全部已导入
    var set = {};
    keys.forEach(function (line) {
      var v = sel[line];
      if (v === 'ALL') {
        var ln = null;
        for (var i = 0; i < info.lines.length; i++) if (info.lines[i].line === line) { ln = info.lines[i]; break; }
        if (ln) ln.stations.forEach(function (s) { set[s] = true; });
      } else if (Array.isArray(v)) {
        v.forEach(function (s) { set[s] = true; });
      }
    });
    return Object.keys(set).slice(0, MAX_STATIONS);
  }

  // 简报标题里的管辖范围标签
  function computeScopeLabel() {
    var c = loadCfg();
    var info = getPhoneLines();
    if (!info.hasData) return BUREAU;
    var sel = c.lines || {};
    var keys = Object.keys(sel);
    if (!keys.length) return '已导入管辖范围';
    if (keys.length === 1) return keys[0];
    return '已选 ' + keys.length + ' 条线';
  }

  /* ---------------- 配置 ---------------- */
  function loadCfg() {
    try {
      var c = JSON.parse(localStorage.getItem(CFG_KEY) || 'null');
      if (c && typeof c === 'object') {
        if (typeof c.enabled === 'undefined') c.enabled = true;
        if (typeof c.trades === 'undefined' || !Array.isArray(c.trades)) c.trades = []; // 空=全部专业
        // 旧版 {line:'xxx'} 迁移为 {lines:{线名:'ALL'}}
        if (typeof c.lines === 'undefined') {
          c.lines = {};
          if (c.line && c.line !== '__all__') {
            var info = getPhoneLines();
            var ln = null;
            for (var i = 0; i < info.lines.length; i++) if (info.lines[i].line === c.line) { ln = info.lines[i]; break; }
            if (ln) c.lines[c.line] = 'ALL';
          }
          delete c.line;
        }
        return c;
      }
    } catch (e) {}
    return { enabled: true, lines: {}, trades: [] };
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
  // opts.trades：选定的专业范围（空数组=全部专业）；统计时按专业过滤并给出各专业分布
  function matchIssues(keywords, opts) {
    opts = opts || {};
    var trades = opts.trades || [];                   // 选定专业；空=不限
    var issues = (typeof window.getIssueData === 'function') ? window.getIssueData() : [];
    issues = issues || [];
    var now = Date.now();
    var DAY = 864e5;
    var recentStart = now - 14 * DAY;                 // 最近两周起点
    var ly = now - 364 * DAY;                         // 去年同期同周（约 52 周前）
    var sameStart = ly - 7 * DAY;                     // 同期两周起点
    var sameEnd = ly + 7 * DAY;                       // 同期两周终点
    var recent = { total: 0, redline: 0, major: 0, byTrade: {} };
    var same = { total: 0, redline: 0, major: 0, byTrade: {} };
    function tally(bucket, it, trade) {
      bucket.total++;
      var nature = (it.性质 || it.nature || '');
      if (/红线/.test(nature)) bucket.redline++;
      else if (/重大/.test(nature)) bucket.major++;
      if (trade) bucket.byTrade[trade] = (bucket.byTrade[trade] || 0) + 1;
    }
    for (var i = 0; i < issues.length; i++) {
      var it = issues[i] || {};
      var text = ((it.category || '') + ' ' + (it.content || '') + ' ' + (it.regulation || '') + ' ' + (it.unit || '')).toLowerCase();
      var hit = keywords.some(function (k) { return text.indexOf(k.toLowerCase()) !== -1; });
      if (!hit) continue;
      var trade = extractTrade(it.unit);
      if (trades.length && trades.indexOf(trade) === -1) continue;   // 专业范围过滤
      var ts = new Date(it.datetime || 0).getTime();
      if (isNaN(ts)) continue;                        // 无日期不参与时间窗统计
      if (ts >= recentStart && ts <= now) tally(recent, it, trade);
      else if (ts >= sameStart && ts <= sameEnd) tally(same, it, trade);
    }
  return { recent: recent, same: same };
}

  // 隐患是否命中用户所选专业（h.trade 形如 '工务/供电'；含'通用'视为对所有专业相关）
  function hazardTradeHits(h, selTrades) {
    if (!selTrades || !selTrades.length) return true; // 空=全部专业
    var parts = String(h.trade || '').split('/');
    for (var i = 0; i < parts.length; i++) {
      var p = parts[i].trim();
      if (!p) continue;
      if (p === '通用') return true;
      if (selTrades.indexOf(p) !== -1) return true;
    }
    return false;
  }

  // 综合风险等级：天气频次(aggCount) 与 检查信息(m.recent) 共同研判
  //   高：存在红线问题，或(天气频次≥5 且 近两周有同类问题)
  //   中：存在重大问题，或(天气频次≥3 且 有近两周问题)，或 天气频次≥7
  //   低：其余（仅关注）
  function computeRiskLevel(aggCount, m) {
    m = m || { recent: { total: 0, redline: 0, major: 0 } };
    var insp = m.recent.total, red = m.recent.redline, maj = m.recent.major;
    if (red > 0) return '高';
    if (aggCount >= 5 && insp > 0) return '高';
    if (maj > 0 || (aggCount >= 3 && insp > 0) || aggCount >= 7) return '中';
    if (insp > 0 || aggCount >= 2) return '中';
    return '低';
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
  // selTrades：用户选定的专业范围（空=全部）；用于过滤并展示专业分布
  function buildSeasonBlock(agg, stations, usedFallback, scopeLabel, selTrades) {
    var lines = [];
    var tradeScope = tradesLabel(selTrades);
    lines.push('【天气研判】管辖范围：' + (scopeLabel || BUREAU) + ' · 共 ' + stations.length + ' 站 · 研判专业：' + tradeScope +
               (usedFallback ? '（天气接口暂不可用，按季节研判）' : ''));
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
    // 按所选专业聚焦：仅保留与该专业相关的隐患（空=全部专业，则不过滤）
    var focusKeys = keys.filter(function (k) {
      var h = HAZARDS[k]; if (!h) return false;
      return hazardTradeHits(h, selTrades);
    });
    if (!focusKeys.length) {
      lines.push('研判重点隐患（近两周，按' + tradeScope + '分析）：所选专业范围内本周暂未匹配到对应天气类重点隐患，按季节常规防控即可。');
    } else {
      lines.push('研判重点隐患（近两周，并对比去年同期同周，按' + tradeScope + '分析）：');
      var levels = [];
      focusKeys.slice(0, 5).forEach(function (k, idx) {
        var h = HAZARDS[k]; if (!h) return;
        var m = matchIssues(h.keywords, { trades: selTrades });
        var rec = m.recent, sam = m.same;
        var lvl = computeRiskLevel(agg.tally[k], m);   // 天气频次 + 检查信息 共同定级
        levels.push({ h: h, lvl: lvl, m: m });
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
        // 专业分布（仅当分布超过 1 个专业时展示，便于从专业角度透视风险）
        var bdKeys = Object.keys(rec.byTrade).sort(function (a, b) { return rec.byTrade[b] - rec.byTrade[a]; });
        var bdStr = '';
        if (bdKeys.length > 1) bdStr = '；专业分布 ' + bdKeys.slice(0, 4).map(function (t) { return t + rec.byTrade[t]; }).join('·');
        lines.push((idx + 1) + '. ' + h.label + '（' + h.trade + '，天气频次' + agg.tally[k] + '）：' + recTxt + samTxt + trend + bdStr +
          '。综合风险：' + lvl + '。建议：' + h.advice);
      });
      // 综合风险研判：天气（频次/强度）叠加管内检查信息（红线/重大/条数）交叉定论
      var high = levels.filter(function (x) { return x.lvl === '高'; });
      var mid = levels.filter(function (x) { return x.lvl === '中'; });
      if (high.length || mid.length) {
        var parts = [];
        if (high.length) parts.push('高风险 ' + high.length + ' 项（' + high.map(function (x) { return x.h.label; }).join('、') + '）');
        if (mid.length) parts.push('中风险 ' + mid.length + ' 项（' + mid.map(function (x) { return x.h.label; }).join('、') + '）');
        var inspTotal = levels.reduce(function (s, x) { return s + x.m.recent.total; }, 0);
        var redTotal = levels.reduce(function (s, x) { return s + x.m.recent.redline; }, 0);
        var majTotal = levels.reduce(function (s, x) { return s + x.m.recent.major; }, 0);
        lines.push('【综合风险研判】本周以天气（' + (scopeLabel || BUREAU) + '，共 ' + stations.length + ' 站）叠加管内检查信息共同研判：' +
          parts.join('，') + '；管内近两周相关同类问题 ' + inspTotal + ' 条' +
          (redTotal ? '（红线 ' + redTotal + '）' : '') + (majTotal ? '（重大 ' + majTotal + '）' : '') +
          '。整体风险' + (high.length ? '偏高' : '可控') + '，请对' + (high.length ? '高风险' : '中风险') + '项重点防控并跟踪闭环。');
      }
    }
  }
    return lines.join('\n');
  }

  // 联网技术检索：复用 DeepSeek Responses API 的 web_search 工具（与智能对话一致），
  // 需用户已配置 API Key（ds_api_key_v1）。返回检索到的铁路安全技术要点文本，失败返回 ''。
  async function webSearchTech() {
    try {
      var key = localStorage.getItem('ds_api_key_v1');
      var url = localStorage.getItem('ds_api_url_v1') || 'https://api.deepseek.com/chat/completions';
      if (!key) return '';
      var responsesUrl = (url || '').replace(/\/chat\/completions\/?$/i, '/responses') || 'https://api.deepseek.com/responses';
      var ctrl = new AbortController();
      var timer = setTimeout(function () { ctrl.abort(); }, 20000);
      var resp = await fetch(responsesUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + key },
        body: JSON.stringify({
          model: 'deepseek-v4-flash',
          instructions: '你是铁路安全监察技术情报助手。基于联网检索到的最新公开信息，输出 3-4 条近期铁路（工务、供电、信号、车务、机务等专业）安全技术应用、设备升级与风险防控的发展趋势要点，聚焦可落地的技术方向与典型应用。每条不超过 55 字，不要编造具体新闻事件，可标注信息时间。',
          input: '请联网检索并输出本周铁路安全技术应用与发展要点（聚焦防洪、防胀轨、防雷、防断、防风、智能巡检、AI 辅助研判等方向）。',
          tools: [{ type: 'web_search' }],
          stream: false,
          temperature: 0.7,
          max_output_tokens: 1200
        }),
        signal: ctrl.signal
      });
      clearTimeout(timer);
      if (!resp.ok) return '';
      var j = await resp.json();
      var text = '';
      if (j && j.output_text) text = j.output_text;
      else if (j && j.output && Array.isArray(j.output)) {
        j.output.forEach(function (o) {
          if (o && o.content && Array.isArray(o.content)) o.content.forEach(function (c) { if (c && c.text) text += c.text; });
        });
      }
      return text ? String(text).trim() : '';
    } catch (e) { return ''; }
  }

  // 技术动态：优先「联网检索」(DeepSeek web_search)，其次资料库素材，均无则明确提示（不显示空内容）
  async function buildTechBlock() {
    var ws = await webSearchTech();
    if (ws) return '【技术动态·联网检索】\n' + ws;
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
    return '【技术动态】本周暂无可联网检索的铁路安全技术动态（未配置 API Key 或网络不可用）；可在资料库补充「铁路技术应用/发展」类资料，系统将每周自动汇总推送。';
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
    var cfg = loadCfg();
    var selTrades = cfg.trades || [];                 // 选定的专业范围（空=全部）
    var agg, usedFallback = false;
    if (navigator.onLine !== false) {
      var wl = await fetchJurisdictionWeather(stations);
      if (wl.length) agg = aggregateWeather(wl);
    }
    if (!agg) { agg = seasonFallback(); usedFallback = true; }
    var season = buildSeasonBlock(agg, stations, usedFallback, scopeLabel, selTrades);
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
    var wrap = document.getElementById('wb-brief-lines');
    var previewEl = document.getElementById('wb-brief-stations-preview');
    var previewBtn = document.getElementById('wb-brief-preview');

    function refreshPreview() {
      if (!previewEl) return;
      var info = getPhoneLines();
      var linesSum = document.getElementById('wb-brief-lines-summary');
      if (!info.hasData) {
        previewEl.textContent = '（未导入应急电话，使用默认兰州局范围）';
        if (linesSum) linesSum.textContent = '默认兰州局';
        return;
      }
      var cfg = loadCfg();
      var keys = Object.keys(cfg.lines || {});
      previewEl.textContent = '已选 ' + getStations().length + ' 站' +
        (keys.length ? '（' + keys.join('、') + '）' : '（全部已导入）');
      if (linesSum) linesSum.textContent = keys.length ? ('已选 ' + keys.length + ' 条线') : ('全部已导入 ' + info.allStations.length + ' 站');
    }

    function lineStationsChecked(wrap, line) {
      var scbs = wrap.querySelectorAll('.wb-station-cb[data-line="' + line + '"]');
      var arr = [];
      scbs.forEach(function (sc) { if (sc.checked) arr.push(sc.dataset.station); });
      return arr;
    }

    function syncCfg(wrap, info) {
      var cfg = loadCfg();
      cfg.lines = {};
      info.lines.forEach(function (x) {
        var lcb = wrap.querySelector('.wb-line-cb[data-line="' + x.line + '"]');
        if (!lcb || !lcb.checked) return;
        var checked = lineStationsChecked(wrap, x.line);
        if (checked.length === x.stations.length) cfg.lines[x.line] = 'ALL';
        else if (checked.length) cfg.lines[x.line] = checked;
        // 0 站选中：不写入
      });
      saveCfg(cfg);
    }

    function buildChecklist() {
      if (!wrap) return;
      var info = getPhoneLines();
      wrap.innerHTML = '';
      if (!info.hasData) {
        var tip = document.createElement('div');
        tip.style.cssText = 'font-size:0.78rem;color:#94a3b8;padding:4px 2px;';
        tip.textContent = '（请先在「数据管理」导入应急电话；未导入时使用默认兰州局范围）';
        wrap.appendChild(tip);
        refreshPreview();
        return;
      }
      var cfg = loadCfg();
      info.lines.forEach(function (x) {
        var line = x.line, stations = x.stations;
        var cur = cfg.lines ? cfg.lines[line] : undefined;
        var lineOn = !!cur;
        var curSet = (cur === 'ALL') ? null : (Array.isArray(cur) ? cur : []);

        var row = document.createElement('div');
        row.style.cssText = 'border:1px solid var(--border);border-radius:8px;padding:6px 8px;background:var(--card-bg);';

        var head = document.createElement('div');
        head.style.cssText = 'display:flex;align-items:center;gap:8px;';
        var cb = document.createElement('input');
        cb.type = 'checkbox'; cb.className = 'wb-line-cb'; cb.dataset.line = line; cb.checked = lineOn;
        var lbl = document.createElement('span');
        lbl.textContent = line + '（' + stations.length + ' 站）';
        lbl.style.cssText = 'flex:1;font-size:0.82rem;cursor:pointer;color:var(--text);';
        var exp = document.createElement('span');
        exp.textContent = '▾'; exp.style.cssText = 'color:#94a3b8;font-size:0.7rem;cursor:pointer;padding:0 4px;';
        head.appendChild(cb); head.appendChild(lbl); head.appendChild(exp);
        row.appendChild(head);

        var stBox = document.createElement('div');
        stBox.style.cssText = 'display:none;flex-direction:column;gap:2px;margin:6px 0 2px 24px;';
        stations.forEach(function (st) {
          var srow = document.createElement('label');
          srow.style.cssText = 'display:flex;align-items:center;gap:6px;font-size:0.78rem;color:var(--text-secondary);cursor:pointer;';
          var scb = document.createElement('input');
          scb.type = 'checkbox'; scb.className = 'wb-station-cb';
          scb.dataset.line = line; scb.dataset.station = st;
          scb.checked = lineOn ? true : (curSet ? curSet.indexOf(st) !== -1 : false);
          var slbl = document.createElement('span'); slbl.textContent = st;
          srow.appendChild(scb); srow.appendChild(slbl);
          stBox.appendChild(srow);
        });
        row.appendChild(stBox);
        wrap.appendChild(row);

        // 勾选线名 → 全选/取消该线所有站
        lbl.addEventListener('click', function () { cb.checked = !cb.checked; cb.dispatchEvent(new Event('change')); });
        cb.addEventListener('change', function () {
          stBox.querySelectorAll('.wb-station-cb').forEach(function (sc) { sc.checked = cb.checked; });
          syncCfg(wrap, info); refreshPreview();
        });
        // 展开/收起站点列表（不改动勾选）
        exp.addEventListener('click', function (e) {
          e.stopPropagation();
          stBox.style.display = (stBox.style.display === 'none') ? 'flex' : 'none';
        });
        // 勾选某个站 → 重新计算该线选择
        stBox.addEventListener('change', function () { syncCfg(wrap, info); refreshPreview(); });
      });
      refreshPreview();
    }

    /* ---- 专业多选（研判专业范围，持久化，默认全部） ---- */
    var tradesWrap = document.getElementById('wb-brief-trades');
    var tradesPreviewEl = document.getElementById('wb-brief-trades-preview');
    function refreshTradePreview() {
      if (!tradesPreviewEl) return;
      var c = loadCfg();
      var sel = c.trades || [];
      var total = getTrades().length;
      if (!sel.length) tradesPreviewEl.textContent = '全部专业（' + total + ' 个）';
      else tradesPreviewEl.textContent = '已选 ' + sel.length + ' 个：' + sel.join('、');
      var tradesSum = document.getElementById('wb-brief-trades-summary');
      if (tradesSum) tradesSum.textContent = sel.length ? ('已选 ' + sel.length + ' 个') : ('全部 ' + total + ' 个');
    }
    function buildTradesChecklist() {
      if (!tradesWrap) return;
      var trades = getTrades();
      tradesWrap.innerHTML = '';
      var cfg = loadCfg();
      var sel = cfg.trades || [];
      var allChecked = sel.length === 0; // 空 = 全部专业
      trades.forEach(function (t) {
        var row = document.createElement('label');
        row.style.cssText = 'display:flex;align-items:center;gap:6px;font-size:0.78rem;color:var(--text-secondary);cursor:pointer;';
        var cb = document.createElement('input');
        cb.type = 'checkbox'; cb.className = 'wb-trade-cb'; cb.value = t;
        cb.checked = allChecked ? true : (sel.indexOf(t) !== -1);
        var sp = document.createElement('span'); sp.textContent = t;
        row.appendChild(cb); row.appendChild(sp);
        tradesWrap.appendChild(row);
      });
      tradesWrap.addEventListener('change', function () {
        var checked = [].slice.call(tradesWrap.querySelectorAll('.wb-trade-cb'))
          .filter(function (c) { return c.checked; }).map(function (c) { return c.value; });
        var c = loadCfg();
        // 全选等价于“全部专业” → 存空数组（表示不限）
        c.trades = (checked.length === trades.length) ? [] : checked;
        saveCfg(c);
        refreshTradePreview();
      });
      refreshTradePreview();
    }

    if (toggle) {
      toggle.checked = isEnabled();
      toggle.addEventListener('change', function () {
        var cfg = loadCfg(); cfg.enabled = toggle.checked; saveCfg(cfg);
      });
    }
    buildChecklist();
    buildTradesChecklist();
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

  // 设置面板内「线路/专业」折叠块的通用展开/收起（点击头切换，箭头旋转）
  function toggleBlock(blockId) {
    var b = document.getElementById(blockId);
    if (!b) return;
    var show = b.style.display === 'none';
    b.style.display = show ? 'block' : 'none';
    var ch = document.getElementById(blockId.replace('-body', '-chevron'));
    if (ch) ch.style.transform = show ? 'rotate(180deg)' : 'rotate(0deg)';
  }

  window.WeeklyBrief = {
    init: init,
    preview: function () { return generate({ skipMark: true }); },
    generate: generate,
    _toggleBlock: toggleBlock,
    // 测试/调试用内部函数
    _matchIssues: matchIssues,
    _extractTrade: extractTrade,
    _getTrades: getTrades,
    _loadCfg: loadCfg,
    _saveCfg: saveCfg
  };
})();
