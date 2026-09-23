/**
 * 车站天气数据来源优先级审计 —— 常驻套件
 * =========================================
 * 用户要求（原话）：**优先以大模型联网搜索为主，如果未接 API 或未查到，再进行保底免费查询**；
 *   应急电话里的车站天气 与 智能对话里问天气 **共用同一逻辑**。
 *
 * 本套件逐条验证优先级与降级：
 *   ① 无 API Key            → 走免费公开接口（Open-Meteo）
 *   ② 有 Key + 大模型正常    → 用大模型结果，且**不发**免费接口请求（不重复烧）
 *   ③ 有 Key + 通道报错      → 自动降级免费
 *   ④ 有 Key + 返回无法解析  → 自动降级免费
 *   ⑤ 同站重复查询           → 命中缓存，不再调大模型
 *   ⑥/⑦ 对话侧两种来源的标注（大模型联网 / 免费公开接口）
 *   ⑧ 应急电话卡片两种来源的标注
 *
 * 用法：node scripts/weather-audit.js
 */
'use strict';
const H = require('./audit-harness');
const PORT = 8194, CDP = 9394;

// 假的大模型联网答案（Anthropic 通道 content[].text 里塞 JSON）
const LLM_JSON = JSON.stringify({
  found: true, station: '兰州',
  source: '中央气象台', updated: '2026-09-23 20:00',
  current: { temp: 18, weather: '多云', feels: 17, wind: 3, windDir: '北', humidity: 45, pressure: 850, precip: 0 },
  daily: [0, 1, 2, 3, 4, 5, 6].map(function (i) {
    return { date: '2026-09-' + (23 + i), weather: i % 3 === 0 ? '小雨' : (i % 3 === 1 ? '多云' : '晴'), tmax: 20 + i, tmin: 10 + i, precip: 10 + i, wind: 3 };
  })
});

// 假的"工作提示"（大模型基于天气给出的作业安全提示）
const TIPS_TEXT = '1. 降雨天气：加强线路与路基巡视，作业防滑防触电。\n2. 大风时停止高空作业并清理轻飘物。\n3. 关注设备温度与防护用品佩戴。';

/** 页面内：拦掉真实网络（免费接口 + 大模型通道），并记录各自的调用次数与请求体 */
const STUB = `(function(){
  window.__wx = { free: 0, llm: 0, repair: 0, tips: 0, coord: 0, llmBodies: [], llmMode: 'ok' };
  var _of = window.fetch;
  window.fetch = function (url, opts) {
    var u = String((url && url.url) ? url.url : url);
    try {
      if (/open-meteo\\.com/.test(u)) {
        window.__wx.free++;
        return Promise.resolve(new Response(JSON.stringify({
          current: { temperature_2m: 12, weather_code: 61, wind_speed_10m: 2 },
          daily: { time: ['2026-09-23','2026-09-24','2026-09-25','2026-09-26','2026-09-27','2026-09-28','2026-09-29'],
                   weather_code: [61,2,0,3,80,61,1],
                   temperature_2m_max: [15,18,20,19,16,14,17], temperature_2m_min: [6,8,9,10,7,5,6],
                   precipitation_probability_max: [80,20,0,10,60,70,30], wind_speed_10m_max: [3,4,2,5,6,3,4] }
        }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
      }
      if (/anthropic|\\/responses|\\/messages/.test(u)) {
        // 坐标检索（queryStationCoord 走联网通道）：按请求体里的"经纬度"区分，
        //   并支持 __wx.coordFail 模拟"联网也查不到坐标"
        var _ab = String((opts && opts.body) || '');
        if (/经纬度/.test(_ab)) {
          window.__wx.coord++;
          if (window.__wx.coordFail) {
            return Promise.resolve(new Response('{"error":"not found"}', { status: 400, headers: { 'Content-Type': 'application/json' } }));
          }
          return Promise.resolve(new Response(JSON.stringify({ content: [{ type: 'text', text: JSON.stringify({ found: true, name: '榆中', admin: '甘肃省兰州市榆中县', lat: 36.05, lon: 104.15 }) }] }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
        }
        window.__wx.llm++;
        try { window.__wx.llmBodies.push(String(opts && opts.body || '')); } catch (e) {}
        if (window.__wx.llmMode === 'http400') {
          return Promise.resolve(new Response('{"error":"unsupported"}', { status: 400, headers: { 'Content-Type': 'application/json' } }));
        }
        if (window.__wx.llmMode === 'garbage') {
          return Promise.resolve(new Response(JSON.stringify({ content: [{ type: 'text', text: '抱歉，我查不到这个车站的天气。' }] }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
        }
        // 联网后把 JSON 混在说明里的真实常见形态（无 JSON 块 → 触发结构化修补）
        if (window.__wx.llmMode === 'prose') {
          return Promise.resolve(new Response(JSON.stringify({ content: [{ type: 'text', text: '根据联网检索，兰州今天多云，气温 18℃，体感 17℃，北风 3m/s；未来一周以多云到晴为主，周中有小雨。来源：中国天气网。' }] }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
        }
        if (window.__wx.llmMode === 'slow') {
          return new Promise(function (res) { setTimeout(function () { res(new Response(JSON.stringify({ content: [{ type: 'text', text: ${JSON.stringify(LLM_JSON)} }] }), { status: 200, headers: { 'Content-Type': 'application/json' } })); }, 2500); });
        }
        return Promise.resolve(new Response(JSON.stringify({ content: [{ type: 'text', text: ${JSON.stringify(LLM_JSON)} }] }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
      }
      // dsCallOnce 走 chat/completions（不带联网）：既用于"结构化修补"，也用于"工作提示"
      if (/chat\\/completions/.test(u)) {
        var _b = String((opts && opts.body) || '');
        // 坐标检索（queryStationCoord）：按提问内容区分
        if (/经纬度/.test(_b)) {
          window.__wx.coord++;
          return Promise.resolve(new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ found: true, name: '榆中', admin: '甘肃省兰州市榆中县', lat: 36.05, lon: 104.15 }) } }] }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
        }
        if (/安全提示/.test(_b)) {
          window.__wx.tips++;
          return Promise.resolve(new Response(JSON.stringify({ choices: [{ message: { content: ${JSON.stringify(TIPS_TEXT)} } }] }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
        }
        window.__wx.repair++;
        return Promise.resolve(new Response(JSON.stringify({ choices: [{ message: { content: ${JSON.stringify(LLM_JSON)} } }] }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
      }
    } catch (e) {}
    return _of.apply(this, arguments);
  };
  return 1;
})()`;

(async () => {
  const h = await H.start({ port: PORT, cdpPort: CDP, view: 'weather' });
  try {
    await h.nav('index.html?v=weather');
    await h.ev(STUB, 20000);
    // 对话流统一 stub（记录被注入的文本，避免测试去打真流式接口）：改动接线时能直接看出注入了什么
    await h.ev(`(() => { window.__wx.streams = []; window.__wx.origStream = window._dsRunStream;
      window._dsRunStream = async function (t) { window.__wx.streams.push(String(t || '')); }; return 1; })()`, 20000);
    await h.ev(`(() => { try { sessionStorage.clear(); } catch (e) {} return 1; })()`, 20000);

    // ---------- ① 未接 API：直接走免费 ----------
    const noKey = await h.ev(`(async () => {
      localStorage.removeItem('ds_api_key_v1');
      window.__wx.free = 0; window.__wx.llm = 0;
      var r = await window.queryWeatherSmart('兰州', { ttlMs: 0 });
      return { ok: r.ok, source: r.source, degraded: r.degraded, free: window.__wx.free, llm: window.__wx.llm,
               temp: r.current && r.current.temperature_2m, days: r.daily && r.daily.time.length };
    })()`, 60000);
    console.log('  ① 无 Key：' + JSON.stringify(noKey));
    h.F(noKey.ok && noKey.source === 'free' && noKey.degraded === 'no-key' && noKey.free >= 1 && noKey.llm === 0,
      '① 未接 API → 走免费公开接口（免费请求 ' + noKey.free + ' 次、大模型 ' + noKey.llm + ' 次，degraded=' + noKey.degraded + '）');

    // ---------- ② 有 Key + 大模型正常：用大模型，且不再请求免费接口 ----------
    const llmOk = await h.ev(`(async () => {
      localStorage.setItem('ds_api_key_v1', 'sk-test-dummy');
      window.__wx.free = 0; window.__wx.llm = 0; window.__wx.llmMode = 'ok';
      var r = await window.queryWeatherSmart('兰州', { ttlMs: 0 });
      var body = window.__wx.llmBodies[0] || '';
      return { ok: r.ok, source: r.source, channel: r.channel, free: window.__wx.free, llm: window.__wx.llm,
               temp: r.current && r.current.temperature_2m, tempAlias: r.current && r.current.temp,
               days: r.daily && r.daily.time.length, tmax: r.daily && r.daily.tmax && r.daily.tmax[0],
               hasWebTool: body.indexOf('web_search_20250305') >= 0 };
    })()`, 60000);
    console.log('  ② 有 Key+联网正常：' + JSON.stringify(llmOk));
    h.F(llmOk.ok && llmOk.source === 'llm' && llmOk.hasWebTool && llmOk.llm >= 1 && llmOk.free === 0,
      '② 大模型联网优先：走 ' + llmOk.channel + ' 通道且请求体含 web_search 工具、**不再请求免费接口**（免费 ' + llmOk.free + ' 次）');
    h.F(llmOk.temp === 18 && llmOk.tempAlias === '18°C' && llmOk.days === 7 && llmOk.tmax === 20,
      '③ 大模型结果已归一化为渲染器认得的形状（实况 18°C / 7 天 / tmax 别名 ' + llmOk.tmax + '）');

    // ---------- ④ 通道报错 → 降级免费 ----------
    const http400 = await h.ev(`(async () => {
      window.__wx.free = 0; window.__wx.llm = 0; window.__wx.llmMode = 'http400';
      var r = await window.queryWeatherSmart('西宁', { ttlMs: 0 });
      return { ok: r.ok, source: r.source, degraded: r.degraded, free: window.__wx.free, llm: window.__wx.llm };
    })()`, 60000);
    console.log('  ④ 通道报错：' + JSON.stringify(http400));
    h.F(http400.ok && http400.source === 'free' && http400.llm >= 1 && http400.free >= 1,
      '④ 大模型通道报错 → 自动降级免费（大模型尝试 ' + http400.llm + ' 次、免费 ' + http400.free + ' 次）');

    // ---------- ⑤ 返回无法解析 → 降级免费 ----------
    const garbage = await h.ev(`(async () => {
      window.__wx.free = 0; window.__wx.llm = 0; window.__wx.llmMode = 'garbage';
      var r = await window.queryWeatherSmart('银川', { ttlMs: 0 });
      return { ok: r.ok, source: r.source, degraded: r.degraded, free: window.__wx.free };
    })()`, 60000);
    console.log('  ⑤ 返回无法解析：' + JSON.stringify(garbage));
    h.F(garbage.ok && garbage.source === 'free' && garbage.degraded === 'llm-unparsed',
      '⑤ 大模型没给结构化结果（llm-unparsed）→ 自动降级免费');

    // ---------- ⑥ 缓存：同站再问不再烧联网检索 ----------
    const cache = await h.ev(`(async () => {
      window.__wx.free = 0; window.__wx.llm = 0; window.__wx.llmMode = 'ok';
      var a = await window.queryWeatherSmart('天水', {});
      var after1 = { free: window.__wx.free, llm: window.__wx.llm };
      var b = await window.queryWeatherSmart('天水', {});
      return { a: a.source, b: b.source, cached: !!b.cached, after1: after1, llm2: window.__wx.llm, free2: window.__wx.free };
    })()`, 90000);
    console.log('  ⑥ 缓存：' + JSON.stringify(cache));
    h.F(cache.cached && cache.llm2 === cache.after1.llm && cache.free2 === cache.after1.free,
      '⑥ 同站 10 分钟内重复查询命中缓存（第二次未再调大模型/免费接口）');

    // ---------- ⑦⑧ 对话侧：两种来源的标注 ----------
    const chat = await h.ev(`(async () => {
      var q = document.getElementById('ds-user-input');
      var box = document.getElementById('ds-chat-box');
      var last = function () { var kids = box ? box.children : []; return kids.length ? (kids[kids.length-1].textContent || '') : ''; };
      // ⑦ 大模型正常：**改为单条报告**（不再单独渲染卡片，数据来源行由报告承载）
      window.__wx.llmMode = 'ok'; window.__wx.streams = [];
      var hist1 = (typeof window.getDsHistory === 'function') ? window.getDsHistory() : [];
      if (hist1) { hist1.length = 0; if (typeof window.dsRenderAll === 'function') window.dsRenderAll(); }
      if (q) { q.value = '兰州今天天气怎么样'; if (q.dispatchEvent) q.dispatchEvent(new Event('input', { bubbles: true })); }
      await window.dsSendMsg();
      await new Promise(function (r) { setTimeout(r, 1500); });
      var whole1 = (box ? box.textContent : '') || '';
      var noCard = !/数据来源：大模型联网检索/.test(whole1);   // 卡片不再单独出现
      var streamed = window.__wx.streams.length === 1;         // 报告交给对话流
      var has1 = noCard && streamed;
      // ⑧ 摘掉 Key → 免费
      localStorage.removeItem('ds_api_key_v1');
      window.__wx.free = 0;
      if (q) { q.value = '武威的天气情况如何'; if (q.dispatchEvent) q.dispatchEvent(new Event('input', { bubbles: true })); }
      await window.dsSendMsg();
      await new Promise(function (r) { setTimeout(r, 1500); });
      var t2 = last();
      return { has1: has1, has2: /免费公开天气接口/.test(t2), len1: whole1.length, len2: t2.length,
               tail1: whole1.slice(-90), tail2: t2.slice(-90), free2: window.__wx.free };
    })()`, 90000);
    console.log('  ⑦ 对话(大模型)：' + JSON.stringify(chat.tail1));
    console.log('  ⑧ 对话(免费)：' + JSON.stringify(chat.tail2));
    h.F(chat.has1, '⑦ 有 Key 的纯天气问题 → 单条报告（不再单独渲染卡片；数据来源由报告首行承载）');
    h.F(chat.has2 && chat.free2 >= 1, '⑧ 对话问天气（无 Key）→ 标注「🛰 数据来源：免费公开天气接口」，且免费接口被调用 ' + chat.free2 + ' 次');

    // ---------- ⑨⑩ 应急电话卡片：两种来源的标注 ----------
    const phone = await h.ev(`(async () => {
      var mk = function (id) { var d = document.createElement('div'); d.id = id; d.innerHTML = '<button class="phone-weather-btn"></button><div id="' + id + '-box"></div>'; document.body.appendChild(d); return id + '-box'; };
      // ⑨ 大模型正常
      localStorage.setItem('ds_api_key_v1', 'sk-test-dummy');
      window.__wx.llmMode = 'ok'; window.__wx.free = 0;
      var b1 = mk('wxbox1');
      await window.phoneGetWeather('测试站A', 36.05, 103.83, b1, '');
      await new Promise(function (r) { setTimeout(r, 600); });
      var t1 = (document.getElementById(b1) || {}).textContent || '';
      // ⑩ 无 Key → 免费
      localStorage.removeItem('ds_api_key_v1');
      window.__wx.free = 0;
      var b2 = mk('wxbox2');
      await window.phoneGetWeather('测试站B', 36.06, 103.84, b2, '');
      await new Promise(function (r) { setTimeout(r, 600); });
      var t2 = (document.getElementById(b2) || {}).textContent || '';
      return { t1: t1.replace(/\\s+/g, ' ').slice(0, 200), t2: t2.replace(/\\s+/g, ' ').slice(0, 200), free2: window.__wx.free };
    })()`, 90000);
    console.log('  ⑨ 电话(大模型)：' + JSON.stringify(phone.t1));
    console.log('  ⑩ 电话(免费)：' + JSON.stringify(phone.t2));
    h.F(/大模型联网检索/.test(phone.t1) && /18°C/.test(phone.t1), '⑨ 应急电话卡片（有 Key）→ 用大模型结果并标注「🌐 大模型联网检索」（18°C 显示正确）');
    h.F(/免费公开接口/.test(phone.t2) && phone.free2 >= 1, '⑩ 应急电话卡片（无 Key）→ 保底免费并标注「🛰 免费公开接口（Open-Meteo）」');

    // ---------- ⑪ 慢速联网时"点完立刻有反应"（用户反馈：发送按钮点完半天没反应）----------
    const instant = await h.ev(`(async () => {
      localStorage.setItem('ds_api_key_v1', 'sk-test-dummy');
      window.__wx.llmMode = 'slow';            // 大模型 2.5s 才回
      var q = document.getElementById('ds-user-input');
      var box = document.getElementById('ds-chat-box');
      if (q) { q.value = '张掖现在的天气怎么样'; if (q.dispatchEvent) q.dispatchEvent(new Event('input', { bubbles: true })); }
      var t0 = Date.now();
      var p = window.dsSendMsg();               // 不 await：先看界面有没有反应
      await new Promise(function (r) { setTimeout(r, 800); });
      var txt = (box ? box.textContent : '') || '';
      var snap = { ms: Date.now() - t0, hasUser: /张掖/.test(txt), hasHint: /正在联网检索/.test(txt) };
      await p;
      await new Promise(function (r) { setTimeout(r, 500); });
      var after = (box ? box.textContent : '') || '';
      snap.finalCard = /数据来源/.test(after);
      return snap;
    })()`, 90000);
    console.log('  ⑪ 慢速联网即时反馈：' + JSON.stringify(instant));
    h.F(instant.hasUser && instant.hasHint && instant.ms < 1500,
      '⑪ 大模型联网 2.5s 期间，用户气泡与「🌐 正在联网检索…」占位在 ' + instant.ms + 'ms 内就已出现（原来要干等到查完）');

    // ---------- ⑫ 联网返回散文（无 JSON）→ 结构化修补后仍用大模型结果 ----------
    const repair = await h.ev(`(async () => {
      window.__wx.llmMode = 'prose'; window.__wx.repair = 0; window.__wx.free = 0;
      var r = await window.queryWeatherSmart('嘉峪关', { ttlMs: 0 });
      return { ok: r.ok, source: r.source, channel: r.channel, repair: window.__wx.repair, free: window.__wx.free,
               temp: r.current && r.current.temperature_2m };
    })()`, 90000);
    console.log('  ⑫ 散文→结构化修补：' + JSON.stringify(repair));
    h.F(repair.ok && repair.source === 'llm' && /repair/.test(String(repair.channel)) && repair.repair >= 1 && repair.free === 0,
      '⑫ 大模型返回散文（无 JSON）→ 自动做一次结构化修补，仍用大模型结果（不再轻易报"无法解析"）');

    // ---------- ⑬ 大模型成功时，电话卡片不再挂那句"会自动改用免费数据源"的误导提示 ----------
    const noMisleading = await h.ev(`(async () => {
      localStorage.setItem('ds_api_key_v1', 'sk-test-dummy');
      window.__wx.llmMode = 'ok';
      var d = document.createElement('div');
      d.innerHTML = '<button class="phone-weather-btn"></button><div id="wxbox3"></div>';
      document.body.appendChild(d);
      await window.phoneGetWeather('测试站C', 36.07, 103.85, 'wxbox3', '');
      await new Promise(function (r) { setTimeout(r, 600); });
      var t = (document.getElementById('wxbox3') || {}).textContent || '';
      return { hasSrc: /大模型联网检索/.test(t), misleading: /自动改用免费数据源/.test(t) || /已保底/.test(t) };
    })()`, 60000);
    console.log('  ⑬ 电话卡片提示：' + JSON.stringify(noMisleading));
    h.F(noMisleading.hasSrc && !noMisleading.misleading,
      '⑬ 大模型成功的卡片只标「🌐 数据来源：大模型联网检索」，不再挂"会自动改用免费数据源/已保底"的误导提示');

    // ---------- ⑭ 纯天气问题（有 Key）：单条"报告体"由对话流产出（用户明确说"以前这种提示比较好"）----------
    const roleAns = await h.ev(`(async () => {
      localStorage.setItem('ds_api_key_v1', 'sk-test-dummy');
      window.__wx.llmMode = 'ok'; window.__wx.streams = [];   // 对话流用全局 stub（见开头）
      var q = document.getElementById('ds-user-input');
      var box = document.getElementById('ds-chat-box');
      window.__wx.box = box;
      // ⚠️ 隔离：清空历史再测，否则前面用例的气泡会让"卡片/气泡数"之类断言失真（本轮踩过）
      var hist0 = (typeof window.getDsHistory === 'function') ? window.getDsHistory() : [];
      if (hist0) { hist0.length = 0; if (typeof window.dsRenderAll === 'function') window.dsRenderAll(); }
      if (q) { q.value = '白银今天天气怎么样'; if (q.dispatchEvent) q.dispatchEvent(new Event('input', { bubbles: true })); }
      await window.dsSendMsg();
      await new Promise(function (r) { setTimeout(r, 1500); });
      var hist = (typeof window.getDsHistory === 'function') ? window.getDsHistory() : [];
      var lastUser = null, assistantCount = 0;
      for (var i = hist.length - 1; i >= 0; i--) { if (hist[i] && hist[i].role === 'user') { lastUser = hist[i]; break; } }
      for (var j = 0; j < hist.length; j++) { if (hist[j] && hist[j].role === 'assistant') assistantCount++; }
      var s0 = window.__wx.streams[0] || '';
      return { streams: window.__wx.streams.length, assistantBubbles: assistantCount, head: s0.slice(0, 60),
               userBubbleShort: !!(lastUser && lastUser.displayText === '白银今天天气怎么样'),
               injData: /\\[参考天气数据（请以此为准，数值不得改写）·白银\\]/.test(s0) && /18/.test(s0),
               injTemplate: /一、今日实况与预报/.test(s0) && /二、未来一周趋势/.test(s0) && /三、铁路安全监察提示/.test(s0),
               injTable: /用\\*\\*表格\\*\\*列出/.test(s0) && /空气质量/.test(s0) && /日出日落/.test(s0),
               injNoFabricate: /严禁编造条款/.test(s0),
               injLocal: /规章制度 \\/ 检查信息 \\/ 检查手册/.test(s0),
               injTail: /我可辅助研判/.test(s0) && /逐小时预报/.test(s0) };
    })()`, 90000);
    console.log('  ⑭ 报告体接线：' + JSON.stringify(roleAns));
    h.F(roleAns.streams === 1 && roleAns.assistantBubbles === 0 && roleAns.userBubbleShort
        && roleAns.injData && roleAns.injTemplate && roleAns.injTable && roleAns.injNoFabricate && roleAns.injLocal && roleAns.injTail,
      '⑭ 有 Key 的纯天气问题 → 交给对话流产出**报告体**（单条回答、无多余卡片）：注入数据块（数值不得改写）+ 模板骨架（一、实况表格 / 二、一周趋势 / 三、监察提示）+ 本地检索要求 + 严禁编造 + 「我可辅助研判」结尾');

    // ---------- ⑮ 未接 API 时：不走对话流，退回"卡片 + 规则化保底提示" ----------
    const tipsRule = await h.ev(`(async () => {
      localStorage.removeItem('ds_api_key_v1');
      window.__wx.tips = 0; window.__wx.streams = [];
      var q = document.getElementById('ds-user-input');
      var box = document.getElementById('ds-chat-box');
      if (q) { q.value = '定西的天气情况怎么样'; if (q.dispatchEvent) q.dispatchEvent(new Event('input', { bubbles: true })); }
      await window.dsSendMsg();
      await new Promise(function (r) { setTimeout(r, 1800); });
      var t = (box ? box.children[box.children.length - 1].textContent : '') || '';
      return { hasTips: /工作提示/.test(t), tipsCalled: window.__wx.tips, streams: window.__wx.streams.length,
               ruleLike: /(降雨|大风|防滑|作业|巡视|防护)/.test(t) };
    })()`, 90000);
    console.log('  ⑮ 对话(无 Key)规则保底：' + JSON.stringify(tipsRule));
    h.F(tipsRule.hasTips && tipsRule.tipsCalled === 0 && tipsRule.streams === 0,
      '⑮ 未接 API：不调用模型（大模型 0 次、对话流 0 次），退回**规则化保底提示**，提示照旧给出');

    // ---------- ⑰ 数据出处与时效：卡片要写清"哪个来源、什么时候" ----------
    const srcInfo = await h.ev(`(async () => {
      localStorage.setItem('ds_api_key_v1', 'sk-test-dummy');
      window.__wx.llmMode = 'ok';
      var r = await window.queryWeatherSmart('武威', { ttlMs: 0 });
      var md = (typeof window.formatWeather === 'function') ? window.formatWeather(r, '武威') : '';
      return { sourceName: r.sourceName, updated: r.updated, inCard: /中央气象台/.test(md), hasTime: /更新于 2026-09-23 20:00/.test(md) };
    })()`, 60000);
    console.log('  ⑰ 数据出处：' + JSON.stringify(srcInfo));
    h.F(srcInfo.sourceName === '中央气象台' && srcInfo.inCard && srcInfo.hasTime,
      '⑰ 天气卡片写明**具体数据出处与时效**（大模型联网检索（中央气象台，更新于 2026-09-23 20:00）），不再是笼统的"大模型联网检索"');

    // ---------- ⑯ 规则保底本身能按天气给对提示 ----------
    const rule = await h.ev(`(async () => {
      localStorage.removeItem('ds_api_key_v1');
      var w = { current: { weather: '雷阵雨', weather_code: 95, temperature_2m: 36, wind_speed_10m: 12 },
                daily: { time: ['2026-09-23','2026-09-24'], weather_code: [95, 63], weatherText: ['雷阵雨','中雨'], temperature_2m_max: [36, 30], temperature_2m_min: [22, 19] } };
      var t = await window.weatherWorkTips(w, '测试站');
      // 高温单列一组：上组 雷暴+降雨+大风 已占满 3 条（优先级正确），高温会被挤掉，所以分开测
      var w2 = { current: { weather: '晴', weather_code: 0, temperature_2m: 38, wind_speed_10m: 3 },
                 daily: { time: ['2026-09-23','2026-09-24'], weather_code: [0, 1], weatherText: ['晴','少云'], temperature_2m_max: [38, 37], temperature_2m_min: [27, 26] } };
      var t2 = await window.weatherWorkTips(w2, '测试站');
      return { text: t.replace(/\\n/g, ' | '), lines: t.split('\\n').filter(Boolean).length,
               hasThunder: /雷/.test(t), hasWind: /大风|高空/.test(t),
               heatText: t2.replace(/\\n/g, ' | '), hasHeat: /高温|防暑|避开/.test(t2) };
    })()`, 60000);
    console.log('  ⑯ 规则保底：' + JSON.stringify(rule));
    h.F(rule.lines >= 1 && rule.lines <= 3 && rule.hasThunder && rule.hasWind && rule.hasHeat,
      '⑯ 规则化保底按天气给提示：雷暴+降雨+大风 → 命中雷暴/大风 共 ' + rule.lines + ' 条（≤3）；晴 38℃ → ' + (rule.hasHeat ? '命中高温防暑' : '未命中高温'));

    // ---------- ⑱ 复合问题（"…要注意什么"）：卡片先出 + 让模型围绕具体问题研判 ----------
    const compo = await h.ev(`(async () => {
      localStorage.setItem('ds_api_key_v1', 'sk-test-dummy');
      window.__wx.llmMode = 'ok'; window.__wx.streams = [];
      var q = document.getElementById('ds-user-input');
      var box = document.getElementById('ds-chat-box');
      // 同样先清空历史，避免复用上一条用例遗留的气泡（卡片判定必须只看本轮）
      var hist0 = (typeof window.getDsHistory === 'function') ? window.getDsHistory() : [];
      if (hist0) { hist0.length = 0; if (typeof window.dsRenderAll === 'function') window.dsRenderAll(); }
      if (q) { q.value = '白银明天有雨吗？现场作业要注意什么'; if (q.dispatchEvent) q.dispatchEvent(new Event('input', { bubbles: true })); }
      await window.dsSendMsg();
      await new Promise(function (r) { setTimeout(r, 1500); });
      var all = (box ? box.textContent : '') || '';
      var s0 = window.__wx.streams[0] || '';
      return { streams: window.__wx.streams.length, cardKept: /数据来源/.test(all), head: s0.slice(0, 60),
               injAnswer: /回答用户的具体问题/.test(s0), injLocal: /规章制度\\/检查信息\\/检查手册/.test(s0),
               notReport: !/一、今日实况与预报/.test(s0) };
    })()`, 90000);
    console.log('  ⑱ 复合问题：' + JSON.stringify(compo));
    h.F(compo.streams === 1 && compo.cardKept && compo.injAnswer && compo.injLocal && compo.notReport,
      '⑱ 复合问题（含"要注意什么"）→ 保留天气卡片 + 交给对话流**围绕用户的具体问题**研判（不套报告模板）');

    // ---------- ⑲ 应急电话 · 无坐标站（用户反馈的"榆中"场景）----------
    //   "榆中"不在内置字典、Open-Meteo 地名接口也匹配不到 ⇒ 原实现直接报"未找到坐标"，
    //   而大模型联网那条路**不需要坐标**。这里断言：不再出现"未找到坐标"，且天气正常渲染。
    const noCoordPhone = await h.ev(`(async () => {
      localStorage.setItem('ds_api_key_v1', 'sk-test-dummy');
      window.__wx.llmMode = 'ok';
      var d = document.createElement('div');
      d.innerHTML = '<button class="phone-weather-btn"></button><div id="wxbox4"></div>';
      document.body.appendChild(d);
      await window.phoneGetWeather('榆中', null, null, 'wxbox4', '');
      await new Promise(function (r) { setTimeout(r, 600); });
      var t = (document.getElementById('wxbox4') || {}).textContent || '';
      return { noCoordError: /未找到坐标/.test(t), hasWeather: /数据来源/.test(t),
               tempShown: /18/.test(t), src: (/🌐[^（]*/.exec(t) || [''])[0].replace(/\\s+/g, '') };
    })()`, 90000);
    console.log('  ⑲ 电话·无坐标站：' + JSON.stringify(noCoordPhone));
    h.F(!noCoordPhone.noCoordError && noCoordPhone.hasWeather && noCoordPhone.tempShown,
      '⑲ 应急电话查"榆中"（不在字典、地名接口也查不到）→ 走**不需要坐标**的大模型联网，不再报"未找到坐标"');

    // ---------- ⑳ 坐标解析：字典优先，字典没有才联网 ----------
    const coord = await h.ev(`(async () => {
      localStorage.setItem('ds_api_key_v1', 'sk-test-dummy');
      window.__wx.coord = 0;
      var a = await window.queryStationCoord('兰州');
      var b = await window.queryStationCoord('榆中');
      return { dictSrc: a.source, dictLat: a.lat, llmSrc: b.source, llmLat: b.lat, llmAdmin: b.admin, coordCalls: window.__wx.coord };
    })()`, 60000);
    console.log('  ⑳ 坐标解析：' + JSON.stringify(coord));
    h.F(coord.dictSrc === 'dict' && Math.abs(coord.dictLat - 36.06) < 0.05 && coord.llmSrc === 'llm'
        && Math.abs(coord.llmLat - 36.05) < 0.05 && /榆中/.test(String(coord.llmAdmin)) && coord.coordCalls >= 1,
      '⑳ 坐标解析顺序：字典命中（兰州 36.06）零成本 → 字典没有才联网查（榆中 36.05，' + coord.llmAdmin + '）');

    // ---------- ㉑ 完全查不到时：提示要可操作（不再只说"未找到坐标"）----------
    const noWay = await h.ev(`(async () => {
      localStorage.removeItem('ds_api_key_v1');           // 没 API
      window.__wx.llmMode = 'http400';
      window.__wx.coordFail = true;                        // 且联网也查不到坐标
      var d = document.createElement('div');
      d.innerHTML = '<button class="phone-weather-btn"></button><div id="wxbox5"></div>';
      document.body.appendChild(d);
      await window.phoneGetWeather('某未收录测试站', null, null, 'wxbox5', '');
      await new Promise(function (r) { setTimeout(r, 800); });
      window.__wx.coordFail = false;
      var t = (document.getElementById('wxbox5') || {}).textContent || '';
      return { text: t.replace(/\\s+/g, ' ').slice(0, 120), actionable: /补充经纬度/.test(t), hasSrc: /数据来源/.test(t) };
    })()`, 90000);
    console.log('  ㉑ 全失败提示：' + JSON.stringify(noWay));
    h.F(noWay.actionable && !noWay.hasSrc,
      '㉑ 无 API 且无坐标时：提示"请在电话簿中为该站补充经纬度，或检查网络后重试"（可操作，不再只说"未找到坐标"）');

    await h.ev(`(() => { try { localStorage.removeItem('ds_api_key_v1'); sessionStorage.clear(); } catch (e) {} return 1; })()`, 20000);
  } catch (e) {
    h.F(false, '套件异常：' + (e && e.message));
  }
  h.done();
  process.exit(0);
})();
