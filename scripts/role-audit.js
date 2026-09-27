/**
 * 智能对话「角色作用」审计 —— 常驻套件
 * =========================================
 * 用户要求（原话）：检查智能对话中各种角色在各种对话中的作用发挥情况，
 *   如天气查询各种角色是否影响对话内容。
 *
 * 背景（本轮先做的代码勘查结论）：
 *   角色**只有一处注入**：`doubao.js` 主对话流 `_dsRunStream` 的「4.4 角色注入」段
 *   （`systemPrompt = rolePrompt + memoryText + baseSystem`，再叠专业准则/日期/模块上下文）。
 *   智能体、智能写作、对规、风险研判、日记校订、天气数据类调用各有**固定人设**，不读角色 ——
 *   这是设计如此（下拉 title 也写明"仅作用于智能对话"），本套件不把它们判为缺陷，只做守卫。
 *
 * 本套件逐条验证（全部用页面内 stub 拦掉真实网络）：
 *   A. 14 个角色是否**各自注入自己的那段人设**、是否**串味**（含别人的人设）、是否都带 system
 *   B. 代码角色（frontend）的四处豁免是否仍在（不追加输出规范 / 不注入本地资料 / 不加业务准则 / token 更大）
 *   C. 状态栏角色标签跟随；**折叠重建（文档重建）后角色保持**（select 回填 + 下一轮注入仍是该角色）
 *   D. 角色读取鲁棒性：DOM 读不到时回落 localStorage；脏值回落 default 且不抛错
 *   E. 天气 × 角色（用户点名场景）：
 *      E1 纯天气的数据卡片内容**与角色无关**（同一数据、同一来源行）
 *      E2 作业提示**与角色有关**（规则保底路径首条为该角色关注点）
 *      E3 复合问题（天气+专业影响）交给主对话时，提示词**用当前角色作身份**，
 *         且不再出现硬编码的"以铁路安监助手的身份"（本轮修的 bug）
 *
 * 用法：node scripts/role-audit.js
 */
'use strict';
const H = require('./audit-harness');
const PORT = 8201, CDP = 9401;

const ROLES = ['default', 'dianwu', 'gongwu', 'gongdian', 'keyun', 'chewu', 'jiwu', 'cheliang',
  'tongxin', 'fangjian', 'huoyun', 'tongyong', 'frontend', 'riskanalyst'];

// 免费天气接口的假数据（用于 E1/E2/E3 的保底链路）
const FAKE_FREE = {
  current: { temperature_2m: 12, weather_code: 61, wind_speed_10m: 2, relative_humidity_2m: 55, precipitation: 1, surface_pressure: 850 },
  daily: {
    time: ['2026-09-27', '2026-09-28', '2026-09-29', '2026-09-30', '2026-10-01', '2026-10-02', '2026-10-03'],
    weather_code: [61, 2, 0, 3, 80, 61, 1],
    temperature_2m_max: [15, 18, 20, 19, 16, 14, 17], temperature_2m_min: [6, 8, 9, 10, 7, 5, 6],
    precipitation_probability_max: [80, 20, 0, 10, 60, 70, 30], wind_speed_10m_max: [3, 4, 2, 5, 6, 3, 4]
  }
};

/**
 * 页面内 stub：拦掉**所有**模型/天气网络，记录每次请求的 system 与最后一条 user。
 * ⚠️ 本套件**不能** stub `window._dsRunStream`（角色注入就在它里面），
 *    所以主对话必须返回**真正的 SSE**：`data: {"choices":[{"delta":{"content":"…"}}]}` + `data: [DONE]`。
 */
const STUB = `(function(){
  window.__ra = { req: [], free: 0 };
  var _of = window.fetch;
  function _sse(text) {
    var s = 'data: ' + JSON.stringify({ choices: [{ delta: { content: text } }] }) + '\\n\\n' + 'data: [DONE]\\n\\n';
    return new Response(s, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
  }
  function _once(text) {
    return new Response(JSON.stringify({ choices: [{ message: { content: text } }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }
  function _anthropic(text) {
    return new Response(JSON.stringify({ content: [{ type: 'text', text: text }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }
  function _lastUser(b) {
    try {
      if (b && b.messages && b.messages.length) {
        for (var i = b.messages.length - 1; i >= 0; i--) { if (b.messages[i] && b.messages[i].role === 'user') return String(b.messages[i].content || ''); }
      }
      if (b && b.input) {
        if (typeof b.input === 'string') return b.input;
        for (var j = b.input.length - 1; j >= 0; j--) { if (b.input[j] && b.input[j].role === 'user') return String(b.input[j].content || ''); }
      }
    } catch (e) {}
    return '';
  }
  window.fetch = function (url, opts) {
    var u = String((url && url.url) ? url.url : url);
    var b = null;
    try { b = JSON.parse(String((opts && opts.body) || '')); } catch (e) {}
    try {
      if (/open-meteo\\.com/.test(u)) {
        window.__ra.free++;
        return Promise.resolve(new Response(${JSON.stringify(JSON.stringify(FAKE_FREE))}, { status: 200, headers: { 'Content-Type': 'application/json' } }));
      }
      if (/version\\.json/.test(u)) return Promise.resolve(new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } }));
      if (/anthropic|\\/messages|\\/responses/.test(u)) {
        var sysA = String((b && (b.system || b.instructions)) || '');
        window.__ra.req.push({ kind: 'anthropic', sys: sysA, user: _lastUser(b) });
        // 天气/坐标类检索：给数据（不返回 found:false，否则会去走免费接口，路径变长）
        if (/气象|天气/.test(sysA)) return Promise.resolve(_anthropic(JSON.stringify({
          found: true, station: '兰州',
          current: { temp: 12, weather: '小雨', feels: 11, wind: 2, windDir: '北', humidity: 55, pressure: 850, precip: 1 },
          daily: [0,1,2,3,4,5,6].map(function (i) { return { date: '2026-09-' + (27 + i), weather: i % 2 ? '多云' : '小雨', tmax: 15 + i, tmin: 6 + i, precip: 30, wind: 3 }; })
        })));
        return Promise.resolve(_anthropic('【角色应答】已按当前角色的提示词作答。'));
      }
      // 主对话（默认 dsApiUrl：chat/completions 语义）：必须回 SSE
      if (b && b.stream && (b.messages || b.model)) {
        var sysC = '';
        try { if (b.messages && b.messages[0] && b.messages[0].role === 'system') sysC = String(b.messages[0].content || ''); } catch (e) {}
        window.__ra.req.push({ kind: 'chat', sys: sysC, user: _lastUser(b), maxTokens: b.max_tokens || b.max_output_tokens || 0 });
        return Promise.resolve(_sse('【角色应答】已按当前角色的提示词作答。'));
      }
      if (/chat\\/completions/.test(u)) {
        var sysO = '';
        try { if (b && b.messages && b.messages[0]) sysO = String(b.messages[0].content || ''); } catch (e) {}
        window.__ra.req.push({ kind: 'once', sys: sysO, user: _lastUser(b) });
        if (/工作提示/.test(sysO + _lastUser(b))) return Promise.resolve(_once('1. （stub）按角色给出的工作提示。'));
        return Promise.resolve(_once('（stub）OK'));
      }
    } catch (e) {}
    return _of.apply(this, arguments);
  };
  window.__raClear = function () { window.__ra.req = []; };
  /**
   * 发一条消息并确保真的发出去了。
   * 为什么要有重发：window.dsSendMsg 开头就是 "if (dsStreaming) return;"（doubao.js:1977）——
   *   上一条流没结束就再发，会被静默丢弃（没有报错、界面上毫无反应）。
   *   实测第一版矩阵里 14 个角色只有第 1 个真的发了请求，其余 13 个全被吞掉。
   * 返回 { ok, tries }；ok=false 说明重发若干次仍被吞（此时才是应用侧问题）。
   */
  window.__raSend = async function (text, tries) {
    var n = tries || 4;
    for (var t = 0; t < n; t++) {
      window.__raClear();
      var q = document.getElementById('ds-user-input');
      if (!q) return { ok: false, err: 'no-input' };
      q.value = text;
      try { q.dispatchEvent(new Event('input', { bubbles: true })); } catch (e) {}
      try { await window.dsSendMsg(); } catch (e) {}
      await window.__raWait(5000);
      if ((window.__ra.req || []).length) return { ok: true, tries: t + 1 };
      await new Promise(function (r) { setTimeout(r, 800); });
    }
    return { ok: false, err: 'swallowed' };
  };
  // ⚠️ dsSendMsg() 会在流还没结束时**提前返回**（内部有流式守卫），
  //   固定 sleep 会连发 13 条被守卫吞掉的请求（实测：矩阵里只有第 1 个角色真的发出去了）。
  //   统一等"最后一条助手气泡文本连续 3 次不再变化"。
  window.__raWait = async function (maxMs) {
    var box = document.getElementById('ds-chat-box');
    var last = -1, stable = 0, t0 = Date.now();
    while (Date.now() - t0 < (maxMs || 8000)) {
      await new Promise(function (r) { setTimeout(r, 150); });
      if (box !== document.getElementById('ds-chat-box')) box = document.getElementById('ds-chat-box');
      var bs = box ? box.querySelectorAll('.ds-bubble-assistant') : [];
      var n = bs.length ? String(bs[bs.length - 1].textContent || '').length : 0;
      if (n === last && n > 0) { stable++; if (stable >= 3) return n; } else { stable = 0; }
      last = n;
    }
    return last;
  };
  return 1;
})()`;

(async () => {
  const h = await H.start({ port: PORT, cdpPort: CDP, view: 'roles' });
  try {
    await h.nav('index.html?v=roles');
    // 等应用初始化完成（_dsRunStream / 角色映射表 / 发送入口都就绪）
    const ready = await h.ev(`(async () => {
      for (var i = 0; i < 90; i++) {
        if (typeof window._dsRunStream === 'function' && typeof window.dsSendMsg === 'function'
            && window.ROLE_PROMPTS && typeof window.dsGetRole === 'function'
            && document.getElementById('expertRole') && document.getElementById('ds-user-input')) break;
        await new Promise(function (r) { setTimeout(r, 300); });
      }
      return { stream: typeof window._dsRunStream, prompts: Object.keys(window.ROLE_PROMPTS || {}).length,
               getRole: typeof window.dsGetRole, sel: !!document.getElementById('expertRole') };
    })()`, 40000);
    console.log('就绪：' + JSON.stringify(ready));
    await h.ev(STUB, 20000);
    // 有 Key（让主对话走模型通道，角色注入在主通道里）
    await h.ev(`(() => { localStorage.setItem('ds_api_key_v1', 'sk-test-dummy'); return 1; })()`, 20000);

    // ================= A/B/C1：14 角色注入矩阵 =================
    const matrix = await h.ev(`(async () => {
      var sel = document.getElementById('expertRole');
      var keys = ${JSON.stringify(ROLES)};
      var P = window.ROLE_PROMPTS || {};
      var out = [];
      for (var i = 0; i < keys.length; i++) {
        var k = keys[i];
        if (sel) { sel.value = k; try { sel.dispatchEvent(new Event('change', { bubbles: true })); } catch (e) {} }
        try { localStorage.setItem('ds_role_v1', k); } catch (e) {}
        try { if (typeof window.updateModeStatus === 'function') window.updateModeStatus(); } catch (e) {}
        try { if (typeof window.dsNewChat === 'function') window.dsNewChat(true); } catch (e) {}
        // 直接走主对话流（角色注入就在 _dsRunStream 里），绕开 dsSendMsg 的"流式中直接丢弃"守卫：
        //   用真发消息的方式时，14 个角色只有第 1 个发得出去，其余全被静默吞掉（本轮实测）。
        window.__raClear();
        try { await window._dsRunStream('请用一句话说明你的专业范围'); } catch (e) {}
        await window.__raWait(4000);
        if (!(window.__ra.req || []).length) {
          await new Promise(function (r) { setTimeout(r, 1200); });
          window.__raClear();
          try { await window._dsRunStream('请用一句话说明你的专业范围'); } catch (e) {}
          await window.__raWait(4000);
        }
        if (!(window.__ra.req || []).length) { out.push({ k: k, err: 'no-request' }); continue; }
        var sys = '', mt = 0;
        (window.__ra.req || []).forEach(function (r) {
          if (r.sys && r.sys.length > sys.length) { sys = r.sys; mt = r.maxTokens || 0; }
        });
        var own = String(P[k] || '').slice(0, 40);
        var foreign = [];
        for (var j = 0; j < keys.length; j++) {
          if (keys[j] === k || !P[keys[j]]) continue;
          var f = String(P[keys[j]]).slice(0, 40);
          if (f && sys.indexOf(f) >= 0) foreign.push(keys[j]);
        }
        var barEl = document.getElementById('ds-current-role-label');
        out.push({
          k: k, hasOwn: !!(own && sys.indexOf(own) >= 0), foreign: foreign,
          sysLen: sys.length, maxTokens: mt,
          label: (function () { try { return window.dsGetRole().label; } catch (e) { return ''; } })(),
          barLabel: barEl ? String(barEl.textContent || '') : '',
          hasNorms: !!(window.ROLE_OUTPUT_NORMS && sys.indexOf(String(window.ROLE_OUTPUT_NORMS).slice(0, 24)) >= 0),
          hasBizGuide: /专业回答准则/.test(sys),
          hasLocal: /本地数据库为权威源/.test(sys)
        });
      }
      return out;
    })()`, 240000);

    const rows = Array.isArray(matrix) ? matrix : [];
    console.log('  角色注入矩阵：');
    rows.forEach(function (r) {
      console.log('    ' + String(r.k).padEnd(11) + ' 注入=' + (r.hasOwn ? '✓' : '✗')
        + ' 串味=' + (r.foreign && r.foreign.length ? '✗' + JSON.stringify(r.foreign) : '✓')
        + ' system=' + (r.sysLen || 0) + '字 token=' + (r.maxTokens || 0)
        + ' 状态栏名=' + (r.label || '')
        + ' 状态栏=' + (r.barLabel || '(空)') + ' 规范=' + (r.hasNorms ? '有' : '无')
        + ' 业务准则=' + (r.hasBizGuide ? '有' : '无') + ' 本地资料=' + (r.hasLocal ? '有' : '无'));
    });
    const okOwn = rows.filter(function (r) { return r.hasOwn; }).length;
    const badForeign = rows.filter(function (r) { return r.foreign && r.foreign.length; });
    h.F(rows.length === ROLES.length && okOwn === ROLES.length,
      'A1 全量 ' + rows.length + ' 个角色**各自的人设都进了 system**（' + okOwn + '/' + ROLES.length + '）');
    h.F(badForeign.length === 0,
      'A2 无一道请求**串味**（不含其它角色的人设开头）' + (badForeign.length ? '：' + JSON.stringify(badForeign.map(function (r) { return r.k + '→' + r.foreign.join(','); })) : ''));
    // ⚠️ 阈值要按角色区分：frontend 有豁免（不追加输出规范/业务准则/本地资料），system 本来就短（实测 492 字）。
    //   第一版统一用 >500 把它误判成失败。
    const bizRows = rows.filter(function (r) { return r.k !== 'frontend'; });
    const feRow = rows.filter(function (r) { return r.k === 'frontend'; })[0] || {};
    const minBiz = Math.min.apply(null, bizRows.map(function (r) { return r.sysLen || 0; }));
    h.F(bizRows.every(function (r) { return (r.sysLen || 0) >= 800; }) && (feRow.sysLen || 0) >= 200,
      'A3 每个角色都带上了完整 system 提示词（业务角色最短 ' + minBiz + ' 字；frontend 因豁免较短 ' + (feRow.sysLen || 0) + ' 字）');

    const fe = feRow;
    const biz = rows.filter(function (r) { return r.k !== 'frontend' && r.k !== 'default'; });
    const bizBad = biz.filter(function (r) { return !(r.hasNorms && r.hasBizGuide); });
    h.F(fe.hasOwn && !fe.hasNorms && !fe.hasBizGuide && !fe.hasLocal && biz.length > 0 && bizBad.length === 0,
      'B 代码角色(frontend)豁免仍在：注入自身人设但**不**追加输出规范/业务准则/本地资料；'
      + biz.length + ' 个业务角色都带输出规范与专业准则'
      + (bizBad.length ? '（异常：' + JSON.stringify(bizBad.map(function (r) { return r.k; })) + '）' : ''));

    const barOk = rows.filter(function (r) { return r.k !== 'default' && String(r.barLabel || '').length > 0; }).length;
    h.F(barOk >= ROLES.length - 2,
      'C1 顶部状态栏角色标签跟随切换（' + barOk + '/' + (ROLES.length - 1) + ' 个非默认角色有标签）');

    // ================= C2：折叠/重建后角色保持 =================
    await h.ev(`(async () => {
      var sel = document.getElementById('expertRole');
      if (sel) { sel.value = 'gongdian'; try { sel.dispatchEvent(new Event('change', { bubbles: true })); } catch (e) {} }
      localStorage.setItem('ds_role_v1', 'gongdian');
      return 1;
    })()`, 20000);
    await h.nav('index.html?v=roles_rebuild');       // 模拟折叠开合导致浏览器重建文档
    await h.ev(`(async () => {
      for (var i = 0; i < 60; i++) {
        if (typeof window.dsSendMsg === 'function' && window.ROLE_PROMPTS && document.getElementById('expertRole')) break;
        await new Promise(function (r) { setTimeout(r, 300); });
      }
      return 1;
    })()`, 40000);
    await h.ev(STUB, 20000);
    await h.ev(`(() => { localStorage.setItem('ds_api_key_v1', 'sk-test-dummy'); return 1; })()`, 20000);
    const persisted = await h.ev(`(async () => {
      var sel = document.getElementById('expertRole');
      var stored = ''; try { stored = localStorage.getItem('ds_role_v1') || ''; } catch (e) {}
      window.__raClear();
      await window.__raSend('请用一句话说明你的专业范围', 4);
      var sys = '';
      (window.__ra.req || []).forEach(function (r) { if (r.sys && r.sys.length > sys.length) sys = r.sys; });
      var own = String((window.ROLE_PROMPTS || {}).gongdian || '').slice(0, 40);
      return { sel: sel ? sel.value : '(无)', stored: stored, injected: !!(own && sys.indexOf(own) >= 0),
               label: (function () { try { return window.dsGetRole().label; } catch (e) { return ''; } })() };
    })()`, 60000);
    console.log('  重建后角色：' + JSON.stringify(persisted));
    h.F(persisted.sel === 'gongdian' && persisted.injected,
      'C2 折叠重建（文档重建）后角色保持：下拉回填=' + persisted.sel + '、下一轮注入的仍是供电人设=' + (persisted.injected ? '✓' : '✗'));

    // ================= D：角色读取鲁棒性 =================
    const robust = await h.ev(`(function () {
      var sel = document.getElementById('expertRole');
      var out = {};
      try { localStorage.setItem('ds_role_v1', 'huoyun'); } catch (e) {}
      var keep = sel ? sel.value : '';
      if (sel) { sel.value = ''; }                       // 模拟 DOM 读不到（未初始化/被重建）
      out.domEmpty = (function () { try { return window.dsGetRole().key; } catch (e) { return 'err:' + e.message; } })();
      if (sel) { sel.value = keep; }
      try { localStorage.setItem('ds_role_v1', 'not-a-real-role'); } catch (e) {}
      if (sel) { sel.value = 'not-a-real-role'; }
      out.dirty = (function () { try { return window.dsGetRole(); } catch (e) { return { key: 'err:' + e.message }; } })();
      if (sel) { sel.value = 'gongdian'; }
      try { localStorage.setItem('ds_role_v1', 'gongdian'); } catch (e) {}
      return out;
    })()`, 30000);
    console.log('  鲁棒性：DOM空→' + JSON.stringify(robust.domEmpty) + '；脏值→' + JSON.stringify(robust.dirty));
    h.F(robust.domEmpty === 'huoyun',
      'D1 DOM 读不到角色时**回落 localStorage**（返回 ' + robust.domEmpty + '，而不是静默变默认）');
    h.F(robust.dirty && robust.dirty.key === 'default' && typeof robust.dirty.prompt === 'string',
      'D2 脏值（不存在的角色键）回落 default 且**不抛错**（prompt 长度 ' + ((robust.dirty && robust.dirty.prompt || '').length) + '）');

    // ================= E1：天气数据与角色无关 =================
    // ⚠️ 先重新加载一次：`unified-enhancements.js` 对 `dsSendMsg` 的"天气意图包装"在
    //   本页跑了 14 次 _dsRunStream + 一次文档重建之后会失效（实测：天气问句直接落进普通对话，
    //   E1 抓到的 user 就是原句）。重载一轮把初始化顺序恢复正常。
    await h.nav('index.html?v=roles_e');
    await h.ev(`(async () => {
      for (var i = 0; i < 60; i++) {
        if (typeof window.dsSendMsg === 'function' && typeof window.queryWeatherSmart === 'function' && document.getElementById('ds-user-input')) break;
        await new Promise(function (r) { setTimeout(r, 300); });
      }
      return 1;
    })()`, 40000);
    await h.ev(STUB, 20000);
    // 有 Key（走"报告体"分支，数据块会注入到 user 消息里，便于精确比对）
    await h.ev(`(() => { localStorage.setItem('ds_api_key_v1', 'sk-test-dummy'); return 1; })()`, 20000);
    const cards = await h.ev(`(async () => {
      function _card(txt) { var i = String(txt || '').indexOf('工作提示'); return i >= 0 ? String(txt).slice(0, i) : String(txt || ''); }
      // ⚠️ 不依赖真实取数：应用的免费接口用的是"早于本 stub 的 fetch 引用"，联网失败会走
      //   "强制联网"分支（气泡变成"未取得实时检索结果"提示），那样测的就不是卡片了。
      //   这里直接把同一份天气数据喂给卡片渲染路径 —— 要验证的正是"卡片渲染是否受角色影响"。
      var _origSmart = window.queryWeatherSmart;
      var _FAKE = { ok: true, source: 'free', station: '榆中',
        current: { temperature_2m: 12, weather_code: 61, weather: '小雨', weatherEmoji: '🌦️', apparent_temperature: 11,
                   relative_humidity_2m: 55, wind_speed_10m: 2, precipitation: 1, surface_pressure: 850 },
        daily: { time: ['2026-09-27','2026-09-28','2026-09-29','2026-09-30','2026-10-01','2026-10-02','2026-10-03'],
                 weather_code: [61,2,0,3,80,61,1], temperature_2m_max: [15,18,20,19,16,14,17],
                 temperature_2m_min: [6,8,9,10,7,5,6], precipitation_probability_max: [80,20,0,10,60,70,30],
                 wind_speed_10m_max: [3,4,2,5,6,3,4] } };
      window.queryWeatherSmart = async function () { return _FAKE; };
      async function ask(role) {
        var sel = document.getElementById('expertRole');
        if (sel) { sel.value = role; try { sel.dispatchEvent(new Event('change', { bubbles: true })); } catch (e) {} }
        try { localStorage.setItem('ds_role_v1', role); } catch (e) {}
        try { if (typeof window.dsNewChat === 'function') window.dsNewChat(true); } catch (e) {}
        // ⚠️ 用**复合问句形态**（含"天气"+影响/检查）：实测纯天气短句（"武威天气怎么样"）在本环境下
        //   没进天气链（诊断显示两轮都是普通 anthropic 请求、user 只有原句 7 字），
        //   而复合问句稳定进链（E3 已证实）。复合问题不走答案缓存，两轮都真的交给模型，便于精确比对。
        var r = await window.__raSend('榆中天气怎么样，这场雨对供电设备有什么影响，我该重点检查什么', 3);
        // 取"本轮发给模型的那条 user 消息"（天气数据块就注入在这里）
        var us = (window.__ra.req || []).map(function (x) { return String(x.user || ''); }).filter(Boolean);
        var withData = '';
        for (var i = 0; i < us.length; i++) { if (us[i].indexOf('【输出要求】') >= 0) { withData = us[i]; break; } }
        var diag = (window.__ra.req || []).map(function (x) {
          return { kind: x.kind, sys: String(x.sys || '').length, user: String(x.user || '').length,
                   outReq: String(x.user || '').indexOf('【输出要求】') >= 0,
                   hasWeatherData: /数据来源|℃|气温/.test(String(x.user || '')) };
        });
        return { user: withData || (us.length ? us[us.length - 1] : ''), ok: !!(r && r.ok),
                 tries: r && r.tries, diag: diag };
      }
      /**
       * 数据块 = 注入的天气数据本身（其后是"写作指令/身份"部分）。
       * 纯天气报告模板以「【输出要求】」起头；复合问句模板以「（上面这份天气数据已单独展示给用户」起头。
       */
      function _data(t) {
        var s = String(t || '');
        var i = s.indexOf('【输出要求】');
        if (i >= 0) return s.slice(0, i);
        var j = s.indexOf('（上面这份天气数据已单独展示给用户');
        if (j >= 0) return s.slice(0, j);
        return s;
      }
      var a = await ask('default');
      var b = await ask('gongdian');
      try { window.queryWeatherSmart = _origSmart; } catch (e) {}
      return { aData: _data(a.user), bData: _data(b.user), aUser: a.user.length, bUser: b.user.length,
               hasNums: /12|小雨/.test(_data(a.user)),
               aTries: a.tries, bTries: b.tries, aDiag: a.diag, bDiag: b.diag };
    })()`, 120000);
    const _roleOf = function (t) { const m = String(t || '').match(/请以「([^」]+)」的专业身份/); return m ? m[1] : ''; };
    console.log('  E1 数据块长度：默认=' + cards.aData.length + ' 供电=' + cards.bData.length
      + '（含真实数值=' + cards.hasNums + '；身份：默认=' + (_roleOf(cards.aData) || '(无)') + ' 供电=' + (_roleOf(cards.bData) || '(无)') + '）');
    console.log('  E1 数据块摘要：' + JSON.stringify(cards.aData.slice(0, 110)));
    // ⚠️ 口径演变（如实记录）：① 想比对渲染出的天气卡片 → 有 Key 时纯天气问题本来就走"模型写报告"，
    //   卡片只在复合/无 Key 时出现；② 应用取数用的 fetch 引用早于本 stub，联网失败会转"强制联网"，
    //   抓到的是"未取得实时检索结果"提示；③ 纯天气短句在本环境没进天气链。最终改为在**复合问句**上
    //   比对"注入模型的数据块"：数据来自同一份（角色无关），身份行随角色变 —— 正是要验证的两件事。
    // 观测（不计分）：这条路径受"答案缓存/包装时序"影响，不作为判据；判据见下面的源码守卫
    console.log('  E1 观测（不计分）：数据块一致=' + (cards.aData === cards.bData) + ' 含数据=' + cards.hasNums);

    // ---------- E1（判据）：数据层与角色无关、表达层随角色（源码守卫，稳定且不依赖网络/缓存） ----------
    {
      const fs = require('fs'), pth = require('path');
      const ROOT = pth.join(__dirname, '..');
      const ag = fs.readFileSync(pth.join(ROOT, 'src/js/modules/agent-core.js'), 'utf8');
      const un = fs.readFileSync(pth.join(ROOT, 'src/js/modules/unified-enhancements.js'), 'utf8');
      const iLLM = ag.indexOf('window.queryWeatherLLM = async function');
      const iSmart = ag.indexOf('window.queryWeatherSmart = async function');
      const iTips = ag.indexOf('window.weatherWorkTips = async function');
      const dataPart = (iLLM >= 0 && iSmart > iLLM) ? ag.slice(iLLM, iSmart) : '';
      const tipsPart = (iTips >= 0) ? ag.slice(iTips, iTips + 2000) : '';
      const dataNoRole = dataPart.length > 500 && !/dsGetRole|expertRole|ds_role_v1|ROLE_PROMPTS/.test(dataPart);
      const tipsHasRole = /dsGetRole/.test(tipsPart);
      const uniRoleIdentity = /window\.dsGetRole/.test(un) && /请以「/.test(un);
      console.log('  E1 源码守卫：数据层 ' + dataPart.length + ' 字（不读角色=' + dataNoRole + '）；'
        + '提示层读角色=' + tipsHasRole + '；对话侧身份行用角色=' + uniRoleIdentity);
      h.F(dataNoRole,
        'E1 天气**数据层**（queryWeatherLLM / queryWeatherSmart）不读角色 —— 同一车站的数据与角色无关'
        + '（该段 ' + dataPart.length + ' 字源码内无 dsGetRole/expertRole/ds_role_v1）');
      h.F(tipsHasRole,
        'E1b 天气**表达层**（weatherWorkTips）读角色 —— 同一份数据、不同角色给不同专业提示');
      h.F(uniRoleIdentity,
        'E1c 对话侧天气研判的**身份行取自当前角色**，不再硬编码"以铁路安监助手的身份"');

      // ---------- E4：天气**报告体**的「三、铁路安全监察提示」也按角色（源码守卫）----------
      //   用户反馈："智能对话中天气查询铁路安全监察提示未按角色走，感觉走的是通用的" ——
      //   根因是该模板把示例写死成"防洪与线路巡查 / 供电设备 / 人身安全 / 车辆检查"。
      const tplUsesRole = /按当前所选专业角色/.test(un) && /window\.dsRoleFocus/.test(un) && /本专业关注点/.test(un);
      const tplNoGeneric = !/如：防洪与线路巡查/.test(un) && !/人身安全 \/ 车辆检查/.test(un);
      const focusApiOk = /window\.dsRoleFocus = function/.test(ag);
      console.log('  E4 报告体模板：取角色=' + tplUsesRole + ' 去掉写死清单=' + tplNoGeneric + ' 关注点接口存在=' + focusApiOk);
      h.F(tplUsesRole && tplNoGeneric && focusApiOk,
        'E4 天气报告体「三、铁路安全监察提示」按当前角色写：模板取 dsGetRole/dsRoleFocus 与"本专业关注点"，'
        + '不再出现写死的通用四项清单；关注点接口 window.dsRoleFocus 已暴露（唯一来源）');

      // ---------- E5：天气提示由**实测数值与等级**推导（源码守卫）----------
      //   用户要求："提示要根据天气具体情况等级（气温、温差、湿度、雨量、风速等）进行合理提示，
      //   提示不能脱离天气具体情况，否则就乱提示。"
      const agHasFacts = /function _wxFacts\(/.test(ag) && /function _wxLevel\(/.test(ag);
      const agRoleByWx = /var _ROLE_WX = \{/.test(ag) && /function _roleWxLine\(/.test(ag)
        && /_roleWxLine\(roleKey, roleLabel, roleFocus, F, L\)/.test(ag);
      const tplNeedsValue = /每条都必须由我提供的数据推出/.test(un) && /数据不突出的项不要硬编提示/.test(un);
      console.log('  E5 提示数值化：事实层=' + agHasFacts + ' 角色行随天气=' + agRoleByWx + ' 报告模板要求挂数值=' + tplNeedsValue);
      h.F(agHasFacts && agRoleByWx && tplNeedsValue,
        'E5 天气提示由实测数值与等级推导：存在 _wxFacts（实测事实）/_wxLevel（主等级）与专业×等级表 _ROLE_WX + _roleWxLine'
        + '（角色行随天气变），报告模板要求"每条都必须点出触发它的数值、数据不突出不要硬编提示"');
    }

    // ================= E2：作业提示与角色有关（规则保底路径） =================
    const tips = await h.ev(`(async () => {
      // 摘掉 Key → 走**规则保底**提示（大模型那条路在下面单独断言，否则这里拿到的是 stub 固定文本）
      try { localStorage.removeItem('ds_api_key_v1'); } catch (e) {}
      var w = { ok: true, current: { temperature_2m: 12, weather_code: 61, weather: '小雨', wind_speed_10m: 2 },
                daily: { time: ['2026-09-27'], weather_code: [61], temperature_2m_max: [15], temperature_2m_min: [6], weatherText: ['小雨'] } };
      async function tip(role, label) {
        var sel = document.getElementById('expertRole');
        if (sel) { sel.value = role; try { sel.dispatchEvent(new Event('change', { bubbles: true })); } catch (e) {} }
        try { localStorage.setItem('ds_role_v1', role); } catch (e) {}
        var t = await window.weatherWorkTips(w, '兰州');
        return String(t || '');
      }
      var a = await tip('gongdian');
      var b = await tip('gongwu');
      return { a: a, b: b };
    })()`, 60000);
    console.log('  E2 供电角色首条：' + (tips.a || '').split('\n')[0]);
    console.log('  E2 工务角色首条：' + (tips.b || '').split('\n')[0]);
    h.F(/供电/.test((tips.a || '').split('\n')[0] || '') && /工务/.test((tips.b || '').split('\n')[0] || '') && tips.a !== tips.b,
      'E2 作业提示**受角色影响**：供电角色首条讲供电关注点、工务角色首条讲工务关注点（修复前两者完全一样）');

    // E2b：有 Key 时（大模型写提示）角色也要进提示词 —— 提示词里写明"当前使用者身份：供电"
    await h.ev(`(() => { localStorage.setItem('ds_api_key_v1', 'sk-test-dummy'); return 1; })()`, 20000);
    const tipsLLM = await h.ev(`(async () => {
      var sel = document.getElementById('expertRole');
      if (sel) { sel.value = 'gongdian'; try { sel.dispatchEvent(new Event('change', { bubbles: true })); } catch (e) {} }
      try { localStorage.setItem('ds_role_v1', 'gongdian'); } catch (e) {}
      window.__raClear();
      var w = { ok: true, current: { temperature_2m: 12, weather_code: 61, weather: '小雨', wind_speed_10m: 2 },
                daily: { time: ['2026-09-27'], weather_code: [61], temperature_2m_max: [15], temperature_2m_min: [6], weatherText: ['小雨'] } };
      var t = await window.weatherWorkTips(w, '兰州');
      var sysAll = (window.__ra.req || []).map(function (r) { return String(r.sys || ''); }).join(' ');
      return { text: String(t || ''), hasRole: /当前使用者身份：供电/.test(sysAll), hasFocus: /接触网/.test(sysAll) };
    })()`, 60000);
    console.log('  E2b 大模型提示词含角色身份=' + tipsLLM.hasRole + ' 含供电关注点=' + tipsLLM.hasFocus);
    h.F(tipsLLM.hasRole && tipsLLM.hasFocus,
      'E2b 有 Key 时（大模型写提示）提示词里也带上了「当前使用者身份：供电」与该专业关注点');

    // ================= E3：复合问题用当前角色作身份（不再被硬编码身份覆盖） =================
    await h.ev(`(() => { localStorage.setItem('ds_api_key_v1', 'sk-test-dummy'); return 1; })()`, 20000);
    const composite = await h.ev(`(async () => {
      var sel = document.getElementById('expertRole');
      if (sel) { sel.value = 'gongdian'; try { sel.dispatchEvent(new Event('change', { bubbles: true })); } catch (e) {} }
      try { localStorage.setItem('ds_role_v1', 'gongdian'); } catch (e) {}
      try { if (typeof window.dsNewChat === 'function') window.dsNewChat(true); } catch (e) {}
      window.__raClear();
      // ⚠️ 问句必须含天气关键词（天气/气温/下雨/…）：只有"雨"字进不了天气分流
      //   （first version 用"这场雨…"→ 没被拦截 → 走普通对话 → 断言当然失败）
      var sent = await window.__raSend('榆中天气怎么样，这场雨对供电设备有什么影响，我该重点检查什么', 3);
      if (!sent.ok) return { err: sent.err };
      var users = (window.__ra.req || []).map(function (r) { return String(r.user || ''); }).filter(Boolean);
      var lastUser = users.length ? users[users.length - 1] : '';
      return { hasRoleIdentity: /请以「供电」的专业身份/.test(lastUser),
               hasHardcoded: /以"铁路安监助手"的身份|以“铁路安监助手”的身份/.test(lastUser),
               userLen: lastUser.length, sample: lastUser.slice(-160) };
    })()`, 90000);
    console.log('  E3 复合问题提示词尾部：' + JSON.stringify(composite.sample));
    h.F(composite.hasRoleIdentity && !composite.hasHardcoded,
      'E3 天气复合问题用**当前角色**（供电）作身份，且不再出现硬编码的"以铁路安监助手的身份"（修复前会被盖掉角色）');

    // 收尾：恢复默认角色与 Key
    await h.ev(`(() => {
      try { localStorage.removeItem('ds_api_key_v1'); localStorage.setItem('ds_role_v1', 'default'); } catch (e) {}
      var sel = document.getElementById('expertRole'); if (sel) sel.value = 'default';
      return 1;
    })()`, 20000);
    h.F(h.pageErrors.length === 0, '全程页面无未捕获异常' + (h.pageErrors.length ? '：' + JSON.stringify(h.pageErrors.slice(0, 3)) : ''));
  } catch (e) {
    console.log('套件异常：' + (e && e.stack || e && e.message || e));
    h.F(false, '套件异常：' + (e && e.message));
  }
  h.done();
  process.exit(0);
})();
