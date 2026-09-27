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
  window.__wx = { free: 0, llm: 0, repair: 0, tips: 0, coord: 0, llmBodies: [], llmMode: 'ok', freeFail: false };
  var _of = window.fetch;
  window.fetch = function (url, opts) {
    var u = String((url && url.url) ? url.url : url);
    try {
      if (/open-meteo\\.com/.test(u)) {
        window.__wx.free++;
        // 免费接口失败开关：用于验证"免费拿不到 → 才联网用大模型"
        if (window.__wx.freeFail) {
          return Promise.resolve(new Response('{"error":"upstream down"}', { status: 503, headers: { 'Content-Type': 'application/json' } }));
        }
        return Promise.resolve(new Response(JSON.stringify({
          // 【2026-09-27】字段与真实免费层一致（本地/免费优先后它就是主力数据源）：
          //   体感/湿度/风向/降水/气压都要有，卡片才不会满屏"—"
          current: { temperature_2m: 12, apparent_temperature: 11, relative_humidity_2m: 55,
                     weather_code: 61, wind_speed_10m: 2, wind_direction_10m: 20,
                     precipitation: 1, surface_pressure: 850 },
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
    // 对话流统一 stub。⚠️ 必须**等应用初始化完成后再装**：doubao.js 是异步初始化的，
    //   `window._dsRunStream` 会在初始化里被赋值一次，抢在它之前装会被覆盖 ——
    //   症状极隐蔽：历史里出现一条**空白助手气泡**、而 stub 一次都没被调到（本轮排查了很久）。
    //   所以这里等就绪 → 装 → 并把安装动作暴露成 `__wxStubStream()`，每个对话用例开跑前重申一次。
    const ready = await h.ev(`(async () => {
      for (var i = 0; i < 60; i++) {
        if (typeof window._dsRunStream === 'function' && typeof window.dsSendMsg === 'function'
            && typeof window.getDsHistory === 'function' && typeof window.dsRenderAll === 'function') break;
        await new Promise(function (r) { setTimeout(r, 250); });
      }
      window.__wx = window.__wx || {};
      window.__wx.origStream = window._dsRunStream;
      window.__wxStubStream = function () {
        window.__wx.streams = window.__wx.streams || [];
        window._dsRunStream = async function (t) {
          window.__wx.streams.push(String(t || ''));
          var hh = window.getDsHistory ? window.getDsHistory() : null;
          if (hh) {
            hh.push({ role: 'assistant', content: '（模拟报告）某站天气情况\\n数据来源：中央气象台\\n一、今日实况与预报\\n二、未来一周趋势\\n三、铁路安全监察提示' });
            if (window.dsRenderAll) window.dsRenderAll();
          }
        };
      };
      window.__wxStubStream();
      // 再等 1 秒确认没被应用覆盖（覆盖就重装）
      await new Promise(function (r) { setTimeout(r, 1000); });
      if (window._dsRunStream !== window.__wx.origStream && !/streams/.test(String(window._dsRunStream))) window.__wxStubStream();
      return typeof window._dsRunStream;
    })()`, 40000);
    console.log('  对话流 stub 就绪检查：' + ready);
    await h.ev(`(() => { try { sessionStorage.clear(); } catch (e) {} return 1; })()`, 20000);

    // ---------- ① 未接 API：直接走免费（本地优先） ----------
    const noKey = await h.ev(`(async () => {
      localStorage.removeItem('ds_api_key_v1');
      window.__wx.freeFail = false;
      window.__wx.free = 0; window.__wx.llm = 0;
      var r = await window.queryWeatherSmart('兰州', { ttlMs: 0 });
      return { ok: r.ok, source: r.source, degraded: r.degraded, free: window.__wx.free, llm: window.__wx.llm,
               temp: r.current && r.current.temperature_2m, days: r.daily && r.daily.time.length };
    })()`, 60000);
    console.log('  ① 无 Key：' + JSON.stringify(noKey));
    h.F(noKey.ok && noKey.source === 'free' && noKey.free >= 1 && noKey.llm === 0 && !noKey.degraded,
      '① 未接 API → **先走本地/免费**：免费 ' + noKey.free + ' 次、大模型 ' + noKey.llm + ' 次、无降级标记');

    // ---------- ② 有 Key + 免费可用：仍然先用免费，**不烧大模型**（新顺序的核心约束）----------
    const llmOk = await h.ev(`(async () => {
      localStorage.setItem('ds_api_key_v1', 'sk-test-dummy');
      window.__wx.freeFail = false;
      window.__wx.free = 0; window.__wx.llm = 0; window.__wx.llmMode = 'ok';
      var r = await window.queryWeatherSmart('兰州', { ttlMs: 0 });
      return { ok: r.ok, source: r.source, channel: r.channel, free: window.__wx.free, llm: window.__wx.llm,
               temp: r.current && r.current.temperature_2m, rh: r.current && r.current.relative_humidity_2m,
               feel: r.current && r.current.apparent_temperature, press: r.current && r.current.surface_pressure,
               wdir: r.current && r.current.wind_direction_10m,
               days: r.daily && r.daily.time.length, tmax: r.daily && r.daily.tmax && r.daily.tmax[0] };
    })()`, 60000);
    console.log('  ② 有 Key + 免费可用：' + JSON.stringify(llmOk));
    h.F(llmOk.ok && llmOk.source === 'free' && llmOk.free >= 1 && llmOk.llm === 0,
      '② **先本地/免费**：即便配了 API Key，也先用免费公开接口（免费 ' + llmOk.free + ' 次、大模型 ' + llmOk.llm
      + ' 次 —— 不再一上来就烧联网检索）');
    h.F(llmOk.temp === 12 && llmOk.days === 7 && llmOk.tmax === 15
        && llmOk.rh === 55 && llmOk.feel === 11 && llmOk.press === 850 && llmOk.wdir === 20,
      '③ 免费层字段已补齐到与大模型同等丰富（温度 ' + llmOk.temp + '°C / 湿度 ' + llmOk.rh + '% / 体感 ' + llmOk.feel
      + ' / 气压 ' + llmOk.press + ' / 风向 ' + llmOk.wdir + '° / 7 天）—— 本地优先也不会让卡片变简陋');

    // ---------- ④ 免费拿不到 + 有 Key → **才**联网用大模型（"后走联网"）----------
    const esc = await h.ev(`(async () => {
      window.__wx.freeFail = true;                       // 免费接口 503
      window.__wx.free = 0; window.__wx.llm = 0; window.__wx.llmMode = 'ok';
      var r = await window.queryWeatherSmart('西宁', { ttlMs: 0 });
      var body = window.__wx.llmBodies[0] || '';
      return { ok: r.ok, source: r.source, escalated: r.escalated, free: window.__wx.free, llm: window.__wx.llm,
               temp: r.current && r.current.temperature_2m, channel: r.channel,
               hasWebTool: body.indexOf('web_search_20250305') >= 0 };
    })()`, 60000);
    console.log('  ④ 免费失败→联网：' + JSON.stringify(esc));
    h.F(esc.ok && esc.source === 'llm' && esc.escalated === 'free-failed' && esc.free >= 1 && esc.llm >= 1 && esc.hasWebTool,
      '④ 免费接口取不到（且配了 Key）→ **才**联网调大模型（免费 ' + esc.free + ' 次失败 → 大模型 ' + esc.llm
      + ' 次，通道 ' + esc.channel + '、带 web_search 工具，escalated=' + esc.escalated + '）');

    // ---------- ⑤ 免费拿不到 + 大模型也给不出结构化结果 → 如实失败（不拿旧数据充数）----------
    const garbage = await h.ev(`(async () => {
      window.__wx.freeFail = true;
      window.__wx.free = 0; window.__wx.llm = 0; window.__wx.llmMode = 'garbage';
      var r = await window.queryWeatherSmart('银川', { ttlMs: 0 });
      return { ok: r.ok, source: r.source, error: r.error, llmError: r.llmError, free: window.__wx.free, llm: window.__wx.llm };
    })()`, 60000);
    console.log('  ⑤ 免费失败+大模型不可解析：' + JSON.stringify(garbage));
    h.F(!garbage.ok && garbage.free >= 1 && garbage.llm >= 1 && !!garbage.error,
      '⑤ 免费取不到、大模型又给不出结构化结果 → 如实失败并报错（免费 ' + garbage.free + ' 次、大模型 '
      + garbage.llm + ' 次，error=' + garbage.error + '）');

    // ---------- ⑤b 旧口径仍可用：opts.preferLLM=true → 先联网（保留能力，默认关闭）----------
    const prefer = await h.ev(`(async () => {
      window.__wx.freeFail = false;
      window.__wx.free = 0; window.__wx.llm = 0; window.__wx.llmMode = 'ok';
      var r = await window.queryWeatherSmart('嘉峪关', { ttlMs: 0, preferLLM: true });
      return { ok: r.ok, source: r.source, free: window.__wx.free, llm: window.__wx.llm };
    })()`, 60000);
    console.log('  ⑤b preferLLM：' + JSON.stringify(prefer));
    h.F(prefer.ok && prefer.source === 'llm' && prefer.llm >= 1 && prefer.free === 0,
      '⑤b 显式 opts.preferLLM=true 时仍可"先联网"（大模型 ' + prefer.llm + ' 次、免费 ' + prefer.free + ' 次）—— 保留上一轮口径，默认不用');

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
      window.__wx.llmMode = 'ok'; window.__wxStubStream(); window.__wx.streams = [];
      var hist1 = (typeof window.getDsHistory === 'function') ? window.getDsHistory() : [];
      if (hist1) { hist1.length = 0; if (typeof window.dsRenderAll === 'function') window.dsRenderAll(); }
      // 诊断：记录本轮 queryWeatherSmart 是否被调用、返回什么（失败时便于定位）
      window.__wx.diag = [];
      var _ow = window.queryWeatherSmart;
      window.queryWeatherSmart = async function () {
        try { var _r = await _ow.apply(this, arguments); window.__wx.diag.push('call→' + JSON.stringify({ ok: _r && _r.ok, source: _r && _r.source, err: _r && (_r.error || _r.llmError) })); return _r; }
        catch (e) { window.__wx.diag.push('call→throw:' + (e && e.message)); throw e; }
      };
      if (q) { q.value = '兰州今天天气怎么样'; if (q.dispatchEvent) q.dispatchEvent(new Event('input', { bubbles: true })); }
      await window.dsSendMsg();
      await new Promise(function (r) { setTimeout(r, 1500); });
      window.queryWeatherSmart = _ow;
      var whole1 = (box ? box.textContent : '') || '';
      var noCard = !/数据来源：大模型联网检索/.test(whole1);   // 卡片不再单独出现
      var streamed = window.__wx.streams.length === 1;         // 报告交给对话流
      var has1 = noCard && streamed;
      var diag1 = 'diag=' + JSON.stringify(window.__wx.diag || []) + ' streams=' + window.__wx.streams.length
                + ' key=' + (localStorage.getItem('ds_api_key_v1') || '(空)')
                + ' hist=' + (function () { try { return JSON.stringify([].concat(hist1 || []).map(function (m) { return (m && m.role) + ':' + String((m && m.content) || '').slice(0, 30); })); } catch (e) { return 'dump失败:' + e.message; } })();
      // ⑧ 摘掉 Key → 免费
      localStorage.removeItem('ds_api_key_v1');
      window.__wx.free = 0;
      if (q) { q.value = '武威的天气情况如何'; if (q.dispatchEvent) q.dispatchEvent(new Event('input', { bubbles: true })); }
      await window.dsSendMsg();
      await new Promise(function (r) { setTimeout(r, 1500); });
      var t2 = last();
      return { has1: has1, has2: /免费公开天气接口/.test(t2), len1: whole1.length, len2: t2.length,
               tail1: whole1.slice(-90), tail2: t2.slice(-90), free2: window.__wx.free, diag1: diag1 };
    })()`, 90000);
    console.log('  ⑦ 对话(有 Key)：' + JSON.stringify(chat.tail1));
    console.log('  ⑦ 诊断：' + chat.diag1);
    console.log('  ⑧ 对话(免费)：' + JSON.stringify(chat.tail2));
    h.F(chat.has1, '⑦ 有 Key 的纯天气问题 → 单条报告（不再单独渲染卡片；数据来源由报告首行承载）');
    h.F(chat.has2 && chat.free2 >= 1, '⑧ 对话问天气（无 Key）→ 标注「🛰 数据来源：免费公开天气接口」，且免费接口被调用 ' + chat.free2 + ' 次');

    // ---------- ⑨⑨b⑩ 应急电话卡片：先本地/免费，拿不到才联网 ----------
    const phone = await h.ev(`(async () => {
      var mk = function (id) { var d = document.createElement('div'); d.id = id; d.innerHTML = '<button class="phone-weather-btn"></button><div id="' + id + '-box"></div>'; document.body.appendChild(d); return id + '-box'; };
      // ⑨ 有 Key + 免费可用 → **仍用免费**（不再自动升级为大模型）
      localStorage.setItem('ds_api_key_v1', 'sk-test-dummy');
      window.__wx.freeFail = false; window.__wx.llmMode = 'ok';
      window.__wx.free = 0; window.__wx.llm = 0;
      var b1 = mk('wxbox1');
      await window.phoneGetWeather('测试站A', 36.05, 103.83, b1, '');
      await new Promise(function (r) { setTimeout(r, 800); });
      var t1 = (document.getElementById(b1) || {}).textContent || '';
      var llm1 = window.__wx.llm;
      // ⑨b 有 Key + 免费失败 → **才**联网用大模型
      window.__wx.freeFail = true;
      window.__wx.free = 0; window.__wx.llm = 0;
      var b3 = mk('wxbox3');
      await window.phoneGetWeather('测试站C', 36.07, 103.85, b3, '');
      await new Promise(function (r) { setTimeout(r, 800); });
      var t3 = (document.getElementById(b3) || {}).textContent || '';
      // ⑩ 无 Key + 免费可用 → 免费
      localStorage.removeItem('ds_api_key_v1');
      window.__wx.freeFail = false;
      window.__wx.free = 0;
      var b2 = mk('wxbox2');
      await window.phoneGetWeather('测试站B', 36.06, 103.84, b2, '');
      await new Promise(function (r) { setTimeout(r, 800); });
      var t2 = (document.getElementById(b2) || {}).textContent || '';
      return { t1: t1.replace(/\\s+/g, ' ').slice(0, 200), t2: t2.replace(/\\s+/g, ' ').slice(0, 200),
               t3: t3.replace(/\\s+/g, ' ').slice(0, 200), free2: window.__wx.free, llm1: llm1 };
    })()`, 90000);
    console.log('  ⑨ 电话(有 Key，免费可用)：' + JSON.stringify(phone.t1));
    console.log('  ⑨b 电话(有 Key，免费失败)：' + JSON.stringify(phone.t3));
    console.log('  ⑩ 电话(无 Key)：' + JSON.stringify(phone.t2));
    h.F(/免费公开接口/.test(phone.t1) && !/大模型联网检索/.test(phone.t1) && phone.llm1 === 0,
      '⑨ 应急电话卡片（有 Key，免费可用）→ **仍用免费公开接口**、不再自动升级为大模型（大模型调用 ' + phone.llm1 + ' 次）');
    h.F(/大模型联网检索/.test(phone.t3),
      '⑨b 应急电话卡片（有 Key，免费接口失败）→ **才**联网用大模型并如实标注「🌐 大模型联网检索」');
    h.F(/免费公开接口/.test(phone.t2) && phone.free2 >= 1, '⑩ 应急电话卡片（无 Key）→ 免费公开接口并标注「🛰 免费公开接口（Open-Meteo）」');

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
      // ⚠️ 口径更新（2026-09-27）：改成"先本地/免费"后取数极快，800ms 内占位常已被结果替换，
      //   所以判据改为"用户气泡 + （占位提示 或 首段回答）" —— 要验证的是"点完立刻有反应"，不是占位本身还在。
      var snap = { ms: Date.now() - t0, hasUser: /张掖/.test(txt),
                   hasHint: /正在获取|正在联网检索|数据来源|天气情况|一、/.test(txt) };
      await p;
      await new Promise(function (r) { setTimeout(r, 500); });
      var after = (box ? box.textContent : '') || '';
      snap.finalCard = /数据来源/.test(after);
      return snap;
    })()`, 90000);
    console.log('  ⑪ 慢速联网即时反馈：' + JSON.stringify(instant));
    h.F(instant.hasUser && instant.hasHint && instant.ms < 1500,
      '⑪ 点完发送在 ' + instant.ms + 'ms 内就有反馈（用户气泡 + 占位提示/首段回答），不干等（写报告那一步仍在跑）');

    // ---------- ⑫ 联网返回散文（无 JSON）→ 结构化修补后仍用大模型结果 ----------
    const repair = await h.ev(`(async () => {
      // 新顺序下要走到大模型，必须先让免费层拿不到；否则直接返回免费结果
      window.__wx.freeFail = true;
      window.__wx.llmMode = 'prose'; window.__wx.repair = 0; window.__wx.free = 0; window.__wx.llm = 0;
      var r = await window.queryWeatherSmart('嘉峪关', { ttlMs: 0 });
      return { ok: r.ok, source: r.source, channel: r.channel, repair: window.__wx.repair,
               free: window.__wx.free, llm: window.__wx.llm, escalated: r.escalated,
               temp: r.current && r.current.temperature_2m };
    })()`, 90000);
    console.log('  ⑫ 散文→结构化修补：' + JSON.stringify(repair));
    h.F(repair.ok && repair.source === 'llm' && /repair/.test(String(repair.channel)) && repair.repair >= 1
        && repair.free >= 1 && repair.llm >= 1 && repair.escalated === 'free-failed',
      '⑫ 免费拿不到 → 联网大模型返回散文（无 JSON）→ 自动做一次结构化修补，仍用大模型结果（不再轻易报"无法解析"）');

    // ---------- ⑬ 走到"联网大模型"时，卡片如实写明原因，不挂误导性常驻提示 ----------
    const noMisleading = await h.ev(`(async () => {
      localStorage.setItem('ds_api_key_v1', 'sk-test-dummy');
      window.__wx.freeFail = true;              // 让免费层失败 → 才轮到联网大模型
      window.__wx.llmMode = 'ok';
      var d = document.createElement('div');
      d.innerHTML = '<button class="phone-weather-btn"></button><div id="wxbox4"></div>';
      document.body.appendChild(d);
      await window.phoneGetWeather('测试站D', 36.07, 103.85, 'wxbox4', '');
      await new Promise(function (r) { setTimeout(r, 800); });
      var t = (document.getElementById('wxbox4') || {}).textContent || '';
      return { hasSrc: /大模型联网检索/.test(t), hasWhy: /免费接口没取到/.test(t),
               misleading: /自动改用免费数据源|已保底/.test(t) };
    })()`, 60000);
    console.log('  ⑬ 电话卡片提示：' + JSON.stringify(noMisleading));
    h.F(noMisleading.hasSrc && noMisleading.hasWhy && !noMisleading.misleading,
      '⑬ 走到联网大模型的卡片写明原因（"免费接口没取到，已联网补取"），不挂"会自动改用免费数据源/已保底"的误导提示');

    // ---------- ⑭ 纯天气问题（有 Key）：单条"报告体"由对话流产出（用户明确说"以前这种提示比较好"）----------
    const roleAns = await h.ev(`(async () => {
      localStorage.setItem('ds_api_key_v1', 'sk-test-dummy');
      window.__wx.llmMode = 'ok'; window.__wxStubStream(); window.__wx.streams = [];   // 对话流用全局 stub（见开头）
      var q = document.getElementById('ds-user-input');
      var box = document.getElementById('ds-chat-box');
      window.__wx.box = box;
      // ⚠️ 隔离：清空历史再测，否则前面用例的气泡会让"卡片/气泡数"之类断言失真（本轮踩过）
      var hist0 = (typeof window.getDsHistory === 'function') ? window.getDsHistory() : [];
      if (hist0) { hist0.length = 0; if (typeof window.dsRenderAll === 'function') window.dsRenderAll(); }
      // 【2026-09-27】模拟用户在下拉里选了「供电」：报告体的"三、监察提示"必须按角色走
      var sel = document.getElementById('expertRole');
      if (sel) { sel.value = 'gongdian'; try { sel.dispatchEvent(new Event('change', { bubbles: true })); } catch (e) {} }
      try { localStorage.setItem('ds_role_v1', 'gongdian'); } catch (e) {}
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
               injTail: /我可辅助研判/.test(s0) && /逐小时预报/.test(s0),
               // 角色口径：提示要写"按当前所选专业角色"，且带上供电的关注点；不得再出现写死的通用四项清单
               injRole: /按当前所选专业角色/.test(s0) && /我是「供电」/.test(s0),
               injRoleFocus: /接触网与牵引变电/.test(s0) && /绝缘与防雷接地/.test(s0),
               noGenericList: !/如：防洪与线路巡查/.test(s0) && !/人身安全 \\/ 车辆检查/.test(s0),
               // 可见回答必须是"报告"（stub 写的模拟报告含"一、今日实况与预报"），而不是我们的天气卡片
               reportOnly: /一、今日实况与预报/.test((box ? box.textContent : '') || '')
                           && !/未来 7 天预报/.test((box ? box.textContent : '') || '') };
    })()`, 90000);
    console.log('  ⑭ 报告体接线：' + JSON.stringify(roleAns));
    h.F(roleAns.streams === 1 && roleAns.assistantBubbles === 1 && roleAns.reportOnly && roleAns.userBubbleShort
        && roleAns.injData && roleAns.injTemplate && roleAns.injTable && roleAns.injNoFabricate && roleAns.injLocal && roleAns.injTail,
      '⑭ 有 Key 的纯天气问题 → 交给对话流产出**报告体**（单条回答、无多余卡片）：注入数据块（数值不得改写）+ 模板骨架（一、实况表格 / 二、一周趋势 / 三、监察提示）+ 本地检索要求 + 严禁编造 + 「我可辅助研判」结尾');
    h.F(roleAns.injRole && roleAns.injRoleFocus && roleAns.noGenericList,
      '⑭b 「三、铁路安全监察提示」**按当前所选角色走**：提示词写明"按当前所选专业角色 / 我是「供电」"并带上供电关注点'
      + '（接触网与牵引变电、绝缘与防雷接地），且不再出现写死的通用清单（如"防洪与线路巡查…人身安全/车辆检查"）');

    // ---------- ⑮ 未接 API 时：不走对话流，退回"卡片 + 规则化保底提示" ----------
    const tipsRule = await h.ev(`(async () => {
      localStorage.removeItem('ds_api_key_v1');
      // ⚠️ 必须复位：⑫/⑬ 为了走到大模型把免费层设成失败（freeFail），不复位会泄漏到本条
      //   —— 免费层 503 → 对话走"查不到→强制联网"，表现为"无 Key 却跑了对话流"（本轮踩过）
      window.__wx.freeFail = false;
      window.__wx.tips = 0; window.__wxStubStream(); window.__wx.streams = [];
      window.__wx.diag15 = [];
      var _ow15 = window.queryWeatherSmart;
      window.queryWeatherSmart = async function () {
        try { var _r = await _ow15.apply(this, arguments);
          window.__wx.diag15.push('call→' + JSON.stringify({ ok: _r && _r.ok, source: _r && _r.source, err: _r && (_r.error || _r.llmError) }));
          return _r;
        } catch (e) { window.__wx.diag15.push('call→throw:' + (e && e.message)); throw e; }
      };
      var q = document.getElementById('ds-user-input');
      var box = document.getElementById('ds-chat-box');
      if (q) { q.value = '定西的天气情况怎么样'; if (q.dispatchEvent) q.dispatchEvent(new Event('input', { bubbles: true })); }
      await window.dsSendMsg();
      await new Promise(function (r) { setTimeout(r, 1800); });
      window.queryWeatherSmart = _ow15;
      var t = (box ? box.children[box.children.length - 1].textContent : '') || '';
      return { hasTips: /工作提示/.test(t), tipsCalled: window.__wx.tips, streams: window.__wx.streams.length,
               ruleLike: /(降雨|大风|防滑|作业|巡视|防护)/.test(t),
               diag: window.__wx.diag15, keyNow: localStorage.getItem('ds_api_key_v1') || '(空)',
               head: String(t).replace(/\\s+/g, ' ').slice(0, 120) };
    })()`, 90000);
    console.log('  ⑮ 对话(无 Key)规则保底：' + JSON.stringify(tipsRule));
    h.F(tipsRule.hasTips && tipsRule.tipsCalled === 0 && tipsRule.streams === 0,
      '⑮ 未接 API：不调用模型（大模型 0 次、对话流 0 次），退回**规则化保底提示**，提示照旧给出'
      + '（diag=' + JSON.stringify(tipsRule.diag) + ' key=' + tipsRule.keyNow + ' 首段=' + JSON.stringify(tipsRule.head) + '）');

    // ---------- ⑰ 数据出处与时效：卡片要写清"哪个来源、什么时候" ----------
    const srcInfo = await h.ev(`(async () => {
      localStorage.setItem('ds_api_key_v1', 'sk-test-dummy');
      window.__wx.freeFail = true;      // 走到联网大模型（"出处与时效"来自检索结果）才拿得到这些字段
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
    // 上限 4：第 1 行是"当前角色关注点"（额外一条，不占天气条数），其后最多 3 条天气提示
    h.F(rule.lines >= 1 && rule.lines <= 4 && rule.hasThunder && rule.hasWind && rule.hasHeat,
      '⑯ 规则化保底按天气给提示：雷暴+降雨+大风 → 命中雷暴/大风 共 ' + rule.lines
      + ' 行（1 条角色关注点 + 最多 3 条天气，≤4）；晴 38℃ → ' + (rule.hasHeat ? '命中高温防暑' : '未命中高温'));

    // ---------- ⑯c/⑯d 提示必须由实测数值与等级推出（用户："不能脱离天气具体情况，否则就乱提示"）----------
    const tipsByWx = await h.ev(`(async () => {
      try { localStorage.removeItem('ds_api_key_v1'); } catch (e) {}   // 走规则保底（大模型路径另有断言）
      var sel = document.getElementById('expertRole');
      if (sel) { sel.value = 'gongdian'; try { sel.dispatchEvent(new Event('change', { bubbles: true })); } catch (e) {} }
      try { localStorage.setItem('ds_role_v1', 'gongdian'); } catch (e) {}
      var calm = { ok: true,
        current: { temperature_2m: 20, weather_code: 2, weather: '多云', wind_speed_10m: 3, relative_humidity_2m: 50 },
        daily: { time: ['2026-09-27'], weather_code: [2], temperature_2m_max: [20], temperature_2m_min: [14],
                 precipitation_probability_max: [10], wind_speed_10m_max: [4], weatherText: ['多云'] } };
      var ext = { ok: true,
        current: { temperature_2m: 38, weather_code: 95, weather: '雷暴', wind_speed_10m: 18,
                   relative_humidity_2m: 95, precipitation: 12 },
        daily: { time: ['2026-09-27'], weather_code: [95], temperature_2m_max: [38], temperature_2m_min: [23],
                 precipitation_probability_max: [90], wind_speed_10m_max: [20], weatherText: ['雷暴'] } };
      // 只突出"高温 + 潮湿"的天气：验证这两个等级也能独立命中（上面那条被更严重的等级占满了名额）
      var hotWet = { ok: true,
        current: { temperature_2m: 38, weather_code: 1, weather: '晴', wind_speed_10m: 3, relative_humidity_2m: 95 },
        daily: { time: ['2026-09-27'], weather_code: [1], temperature_2m_max: [38], temperature_2m_min: [30],
                 precipitation_probability_max: [10], wind_speed_10m_max: [4], weatherText: ['晴'] } };
      var tCalm = String(await window.weatherWorkTips(calm, '兰州') || '');
      var tExt = String(await window.weatherWorkTips(ext, '兰州') || '');
      var tHotWet = String(await window.weatherWorkTips(hotWet, '兰州') || '');
      var firstLine = function (t) { return String(t).split('\\n')[0] || ''; };
      return { calm: tCalm, ext: tExt, hotWet: tHotWet, calmRole: firstLine(tCalm), extRole: firstLine(tExt) };
    })()`, 90000);
    console.log('  ⑯c 平稳天气提示：' + JSON.stringify(tipsByWx.calm.replace(/\n/g, ' | ').slice(0, 220)));
    console.log('  ⑯d 极端天气提示：' + JSON.stringify(tipsByWx.ext.replace(/\n/g, ' | ').slice(0, 260)));
    const calmTxt = tipsByWx.calm || '';
    const _badCalm = ['高温', '大风', '强风', '雷暴', '严寒', '防冻', '防洪', '潮湿', '干燥'].filter(function (k) { return calmTxt.indexOf(k) >= 0; });
    h.F(calmTxt.indexOf('平稳') >= 0 && /20/.test(calmTxt) && _badCalm.length === 0,
      '⑯c **平稳天气不乱提示**（多云 20℃、温差 6℃、湿度 50%、风 3m/s、降水概率 10%）→ 只出"天气平稳"且带上数值，'
      + '不含高温/大风/雷暴/防冻/防洪/潮湿等与实况不符的提示'
      + (_badCalm.length ? '（**误报：' + _badCalm.join('、') + '**）' : ''));

    const extTxt = tipsByWx.ext || '';
    // 用 indexOf 判定（避免正则转义坑；提示里应当出现"触发它的数值"）
    const _has = function (t, arr) { return arr.some(function (s) { return t.indexOf(s) >= 0; }); };
    const _hitExt = [
      ['雷暴', _has(extTxt, ['雷暴'])],
      ['大风/强风 18m/s', _has(extTxt, ['强风 18', '大风 18', '18m/s', '18 m/s'])],
      ['高温 38℃', _has(extTxt, ['38'])],
      ['降水概率 90%', _has(extTxt, ['降水概率 90'])],
      ['潮湿 95%', _has(extTxt, ['95'])]
    ].filter(function (x) { return x[1]; }).map(function (x) { return x[0]; });
    // ⚠️ 口径：提示最多 4 行（1 条角色 + 3 条天气）且按严重程度排序 —— 所以"最严重的 3 项"必须命中；
    //   高温/潮湿在雷暴+强降水+强风的场景里被挤出名额是**正确**的排序行为，不能据此判失败（第一版断言就是这样误报的）。
    h.F(_hitExt.length >= 3,
      '⑯d **极端天气按数值命中并写清触发数值**（雷暴、风 18m/s、降水概率 90% 必须进前 3 条）→ 命中 '
      + _hitExt.length + ' 项：' + _hitExt.join('、'));

    const hotTxt = tipsByWx.hotWet || '';
    const _hitHot = [['高温 38℃', _has(hotTxt, ['38'])], ['潮湿 95%', _has(hotTxt, ['95'])]]
      .filter(function (x) { return x[1]; }).map(function (x) { return x[0]; });
    console.log('  ⑯d2 高温+潮湿：' + JSON.stringify(hotTxt.replace(/\n/g, ' | ').slice(0, 200)));
    h.F(_hitHot.length === 2,
      '⑯d2 只突出"高温 + 潮湿"的天气（38℃、湿度 95%、无风无雨）→ 这两项等级独立命中且带数值：'
      + _hitHot.join('、'));
    h.F(tipsByWx.calmRole !== tipsByWx.extRole && /雷暴/.test(tipsByWx.extRole) && /平稳/.test(tipsByWx.calmRole),
      '⑯e **角色提示行也随天气变**（同一「供电」角色）：平稳天气 → ' + tipsByWx.calmRole.slice(0, 42)
      + ' ／ 雷暴天 → ' + tipsByWx.extRole.slice(0, 42) + ' —— 不再是与本日天气无关的固定一句');

    // ---------- ⑱ 复合问题（"…要注意什么"）：卡片先出 + 让模型围绕具体问题研判 ----------
    const compo = await h.ev(`(async () => {
      localStorage.setItem('ds_api_key_v1', 'sk-test-dummy');
      window.__wx.freeFail = false;     // 复位：本条要验证"本地/免费先出卡片"
      window.__wx.llmMode = 'ok'; window.__wxStubStream(); window.__wx.streams = [];
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
        && Math.abs(coord.llmLat - 36.05) < 0.05 && /榆中/.test(String(coord.llmAdmin)),
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

    // ---------- ㉖ 站名不在电话簿/字典里（如"陇南"）也要能进天气链 ----------
    const unknownStation = await h.ev(`(async () => {
      localStorage.setItem('ds_api_key_v1', 'sk-test-dummy');
      window.__wx.llmMode = 'ok'; window.__wxStubStream(); window.__wx.streams = [];
      var calls = [];
      var _ow = window.queryWeatherSmart;
      window.queryWeatherSmart = async function (st) { calls.push(String(st)); return _ow.apply(this, arguments); };
      var q = document.getElementById('ds-user-input');
      var hist = window.getDsHistory ? window.getDsHistory() : null;
      if (hist) { hist.length = 0; if (window.dsRenderAll) window.dsRenderAll(); }
      if (q) { q.value = '陇南今天天气'; if (q.dispatchEvent) q.dispatchEvent(new Event('input', { bubbles: true })); }
      await window.dsSendMsg();
      await new Promise(function (r) { setTimeout(r, 1200); });
      window.queryWeatherSmart = _ow;
      return { calls: calls, streams: window.__wx.streams.length,
               s0head: String(window.__wx.streams[0] || '').slice(0, 46) };
    })()`, 90000);
    console.log('  ㉖ 未收录站名：' + JSON.stringify(unknownStation));
    h.F(unknownStation.calls.length === 1 && unknownStation.calls[0] === '陇南' && unknownStation.streams === 1
        && /陇南/.test(unknownStation.s0head),
      '㉖ 站名不在电话簿/内置字典（"陇南今天天气"）→ 启发式抽取站名成功、进入天气链（取数+报告各 1 次）—— 修复前这类问法只走普通对话');

    // ---------- ㉒㉓ 提速：模型调用次数（取数 1 + 报告 1）与"再问秒回"（答案缓存）----------
    const speed1 = await h.ev(`(async () => {
      localStorage.setItem('ds_api_key_v1', 'sk-test-dummy');
      window.__wx.llmMode = 'ok'; window.__wxStubStream(); window.__wx.streams = []; window.__wx.llm = 0;
      var hh = window.getDsHistory ? window.getDsHistory() : null;
      if (hh) { hh.length = 0; if (window.dsRenderAll) window.dsRenderAll(); }
      var q = document.getElementById('ds-user-input');
      var box = document.getElementById('ds-chat-box');
      // 站名必须**没在前面查过**：天气数据有 10 分钟缓存，撞上就测不到"取数 1 次"了（本轮踩过）
      if (q) { q.value = '金昌今天的天气'; if (q.dispatchEvent) q.dispatchEvent(new Event('input', { bubbles: true })); }
      var t0 = Date.now();
      await window.dsSendMsg();
      await new Promise(function (r) { setTimeout(r, 1200); });
      // 口径：llm 计数会把"写报告"那一趟也算进去（报告请求走 anthropic 通道），
      //   所以"取数是否联网"要看 **free 计数 ≥1**（数据来自免费层）而不是看 llm 是否为 0。
      var first = { ms: Date.now() - t0, llm: window.__wx.llm, free: window.__wx.free, streams: window.__wx.streams.length };
      // 同样的站再问一次
      window.__wx.llm = 0; window.__wxStubStream(); window.__wx.streams = [];
      var t1 = Date.now();
      if (q) { q.value = '金昌天气'; if (q.dispatchEvent) q.dispatchEvent(new Event('input', { bubbles: true })); }
      await window.dsSendMsg();
      await new Promise(function (r) { setTimeout(r, 800); });
      var whole = (box ? box.textContent : '') || '';
      return { first: first, second: { ms: Date.now() - t1, llm: window.__wx.llm, streams: window.__wx.streams.length,
               cached: /来自缓存/.test(whole) } };
    })()`, 90000);
    console.log('  ㉒㉓ 提速：' + JSON.stringify(speed1));
    h.F(speed1.first.free >= 1 && speed1.first.streams === 1,
      '㉒ 纯天气首次提问：取数走**本地/免费**（免费 ' + speed1.first.free + ' 次）+ 写报告 1 趟（streams '
      + speed1.first.streams + '，共 ' + speed1.first.llm + ' 次联网），耗时 ' + speed1.first.ms
      + 'ms —— 新顺序下取数不再单独烧一趟联网检索');
    h.F(speed1.second.llm === 0 && speed1.second.streams === 0 && speed1.second.cached,
      '㉓ 同一车站 10 分钟内再问 → **0 趟模型**、' + speed1.second.ms + 'ms 命中「答案缓存」秒回');

    // ---------- ㉔ 电话：本地/免费优先，**不再自动升级**为大模型 ----------
    //   用户 2026-09-27 要求："天气查询还是先走本地，后走联网" —— 原来"免费先出 + 大模型回来原地升级"被取消。
    const progressive = await h.ev(`(async () => {
      localStorage.setItem('ds_api_key_v1', 'sk-test-dummy');
      window.__wx.freeFail = false;
      window.__wx.llmMode = 'slow';      // 大模型 2.5s 才回（若被调用，最终会升级）
      window.__wx.free = 0; window.__wx.llm = 0;
      var d = document.createElement('div');
      d.innerHTML = '<button class="phone-weather-btn"></button><div id="wxbox6"></div>';
      document.body.appendChild(d);
      var p = window.phoneGetWeather('兰州西', null, null, 'wxbox6', '');
      await new Promise(function (r) { setTimeout(r, 700); });
      var mid = (document.getElementById('wxbox6') || {}).textContent || '';
      await p;
      await new Promise(function (r) { setTimeout(r, 2600); });   // 等超过大模型的 2.5s，确认没有被升级
      var end = (document.getElementById('wxbox6') || {}).textContent || '';
      return { at700ms: { hasData: /数据来源/.test(mid), src: (/🛰|🌐/.exec(mid) || [''])[0] },
               final: { src: (/🛰|🌐/.exec(end) || [''])[0], llmCalls: window.__wx.llm, freeCalls: window.__wx.free } };
    })()`, 90000);
    console.log('  ㉔ 电话（本地优先）：' + JSON.stringify(progressive));
    h.F(progressive.at700ms.hasData && progressive.at700ms.src === '🛰'
        && progressive.final.src === '🛰' && progressive.final.llmCalls === 0 && progressive.final.freeCalls >= 1,
      '㉔ 应急电话（字典坐标）：700ms 内即出**免费公开接口**数据，且**全程不再自动升级**为大模型'
      + '（免费 ' + progressive.final.freeCalls + ' 次、大模型 ' + progressive.final.llmCalls + ' 次）—— 先本地后联网');

    // ---------- ㉕ 坐标字典快查（dictOnly）：毫秒级、绝不联网 ----------
    const dictFast = await h.ev(`(async () => {
      window.__wx.coord = 0;
      var t0 = Date.now();
      var a = await window.queryStationCoord('兰州', { dictOnly: true });
      var t1 = Date.now();
      // ⚠️ 必须用"没被解析过"的站名：坐标结果有运行期缓存，前面用例查过"榆中"，
      //    再查会直接命中缓存而返回 ok —— 那样测的就不是"字典未命中"了（本轮踩过）。
      var b = await window.queryStationCoord('某字典外站名', { dictOnly: true });
      var t2 = Date.now();
      return { dictOk: a.ok, dictMs: t1 - t0, notOk: !b.ok, notMs: t2 - t1, netCalls: window.__wx.coord };
    })()`, 30000);
    console.log('  ㉕ dictOnly：' + JSON.stringify(dictFast));
    h.F(dictFast.dictOk && dictFast.notOk && dictFast.netCalls === 0 && dictFast.dictMs < 100,
      '㉕ 坐标字典快查：命中毫秒级（' + dictFast.dictMs + 'ms）、未命中立刻返回（' + dictFast.notMs + 'ms）、全程零联网');

    await h.ev(`(() => { try { localStorage.removeItem('ds_api_key_v1'); sessionStorage.clear(); } catch (e) {} return 1; })()`, 20000);
  } catch (e) {
    h.F(false, '套件异常：' + (e && e.message));
  }
  h.done();
  process.exit(0);
})();
