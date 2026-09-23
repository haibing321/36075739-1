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
  current: { temp: 18, weather: '多云', feels: 17, wind: 3, windDir: '北', humidity: 45, pressure: 850, precip: 0 },
  daily: [0, 1, 2, 3, 4, 5, 6].map(function (i) {
    return { date: '2026-09-' + (23 + i), weather: i % 3 === 0 ? '小雨' : (i % 3 === 1 ? '多云' : '晴'), tmax: 20 + i, tmin: 10 + i, precip: 10 + i, wind: 3 };
  })
});

// 假的"工作提示"（大模型基于天气给出的作业安全提示）
const TIPS_TEXT = '1. 降雨天气：加强线路与路基巡视，作业防滑防触电。\n2. 大风时停止高空作业并清理轻飘物。\n3. 关注设备温度与防护用品佩戴。';

/** 页面内：拦掉真实网络（免费接口 + 大模型通道），并记录各自的调用次数与请求体 */
const STUB = `(function(){
  window.__wx = { free: 0, llm: 0, repair: 0, tips: 0, llmBodies: [], llmMode: 'ok' };
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
      // ⑦ 大模型正常
      window.__wx.llmMode = 'ok';
      if (q) { q.value = '兰州今天天气怎么样'; if (q.dispatchEvent) q.dispatchEvent(new Event('input', { bubbles: true })); }
      await window.dsSendMsg();
      await new Promise(function (r) { setTimeout(r, 1500); });
      // ⚠️ 来源行在整张表格**之后**：必须对全文判定，不能截前 N 字（本轮曾因此误报失败）
      var t1 = last();
      var has1 = /数据来源：大模型联网检索/.test(t1);
      // ⑧ 摘掉 Key → 免费
      localStorage.removeItem('ds_api_key_v1');
      window.__wx.free = 0;
      if (q) { q.value = '武威的天气情况如何'; if (q.dispatchEvent) q.dispatchEvent(new Event('input', { bubbles: true })); }
      await window.dsSendMsg();
      await new Promise(function (r) { setTimeout(r, 1500); });
      var t2 = last();
      return { has1: has1, has2: /免费公开天气接口/.test(t2), len1: t1.length, len2: t2.length,
               tail1: t1.slice(-90), tail2: t2.slice(-90), free2: window.__wx.free };
    })()`, 90000);
    console.log('  ⑦ 对话(大模型)：' + JSON.stringify(chat.tail1));
    console.log('  ⑧ 对话(免费)：' + JSON.stringify(chat.tail2));
    h.F(chat.has1, '⑦ 对话问天气（有 Key）→ 卡片尾部标注「🌐 数据来源：大模型联网检索」');
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

    // ---------- ⑭ 纯天气问题：卡片之后要补「工作提示」（大模型生成）----------
    const tipsLlm = await h.ev(`(async () => {
      localStorage.setItem('ds_api_key_v1', 'sk-test-dummy');
      window.__wx.llmMode = 'ok'; window.__wx.tips = 0;
      var q = document.getElementById('ds-user-input');
      var box = document.getElementById('ds-chat-box');
      if (q) { q.value = '白银今天天气怎么样'; if (q.dispatchEvent) q.dispatchEvent(new Event('input', { bubbles: true })); }
      await window.dsSendMsg();
      await new Promise(function (r) { setTimeout(r, 1800); });
      var t = (box ? box.children[box.children.length - 1].textContent : '') || '';
      return { hasTips: /工作提示/.test(t), hasData: /数据来源/.test(t), tipsCalled: window.__wx.tips,
               sample: (t.match(/工作提示[\\s\\S]{0,80}/) || [''])[0].replace(/\\s+/g, ' ') };
    })()`, 90000);
    console.log('  ⑭ 对话工作提示(大模型)：' + JSON.stringify(tipsLlm));
    h.F(tipsLlm.hasData && tipsLlm.hasTips && tipsLlm.tipsCalled >= 1,
      '⑭ 纯天气问题：天气卡片之后补出「🛡️ 工作提示」（由大模型按天气生成，调用 ' + tipsLlm.tipsCalled + ' 次）');

    // ---------- ⑮ 未接 API 时：工作提示走规则化保底，仍然有 ----------
    const tipsRule = await h.ev(`(async () => {
      localStorage.removeItem('ds_api_key_v1');
      window.__wx.tips = 0;
      var q = document.getElementById('ds-user-input');
      var box = document.getElementById('ds-chat-box');
      if (q) { q.value = '定西的天气情况怎么样'; if (q.dispatchEvent) q.dispatchEvent(new Event('input', { bubbles: true })); }
      await window.dsSendMsg();
      await new Promise(function (r) { setTimeout(r, 1800); });
      var t = (box ? box.children[box.children.length - 1].textContent : '') || '';
      return { hasTips: /工作提示/.test(t), tipsCalled: window.__wx.tips,
               ruleLike: /(降雨|大风|防滑|作业|巡视|防护)/.test(t) };
    })()`, 90000);
    console.log('  ⑮ 对话工作提示(规则保底)：' + JSON.stringify(tipsRule));
    h.F(tipsRule.hasTips && tipsRule.tipsCalled === 0,
      '⑮ 未接 API：工作提示走**规则化保底**（未调大模型 ' + tipsRule.tipsCalled + ' 次），提示照旧给出');

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

    await h.ev(`(() => { try { localStorage.removeItem('ds_api_key_v1'); sessionStorage.clear(); } catch (e) {} return 1; })()`, 20000);
  } catch (e) {
    h.F(false, '套件异常：' + (e && e.message));
  }
  h.done();
  process.exit(0);
})();
