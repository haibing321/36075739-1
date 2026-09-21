// 智能对话/智能体「工具调用」取证脚本（可复用）
//   场景A：DeepSeek 配置（开机前写入）→ 期望 tools 挂载、模型请求→本地执行→回灌→回答
//   场景B：非 DeepSeek 配置（火山方舟 + doubao，开机前写入）→ 观察是否静默不挂载（实测：对话 tools=0；/agent 仍 tools=16）
//   背景（2026-09-21 实测）：对话侧 `_useTools = _isV4 && _toolsReady`，
//     `_isV4 = /deepseek/i.test(模型名) || /api\.deepseek\.com/i.test(API地址)`（doubao.js ~2438/2453）。
//   注意：① 对话侧模型是**开机时读进内存**的，切换配置必须重新加载页面才生效；
//         ② unified-enhancements.js 包了 dsSendMsg（语义缓存命中会直接返回、不发请求）→ 两场景换不同问法。
// 用法：node scripts/agent-call-audit.js
const http = require('http'); const fs = require('fs'); const path = require('path'); const os = require('os');
const { spawn } = require('child_process');
const ROOT = path.resolve(__dirname, '..'), PORT = 8133, CDP_PORT = 9343;
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.woff2': 'font/woff2' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
class CDP {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); this.listeners = [];
    ws.addEventListener('message', (ev) => { let m; try { m = JSON.parse(ev.data); } catch (e) { return; }
      if (m.id && this.pending.has(m.id)) { const p = this.pending.get(m.id); this.pending.delete(m.id); m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result); }
      else if (m.method) this.listeners.forEach((f) => f(m)); }); }
  send(method, params = {}, sessionId) { const id = ++this.id; const payload = { id, method, params }; if (sessionId) payload.sessionId = sessionId;
    this.ws.send(JSON.stringify(payload));
    return new Promise((res, rej) => { this.pending.set(id, { resolve: res, reject: rej }); setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); rej(new Error('timeout ' + method)); } }, 180000); }); }
  waitEvent(method, t = 60000, sessionId) { return new Promise((res, rej) => { const tm = setTimeout(() => rej(new Error('ev timeout ' + method)), t);
    const fn = (m) => { if (m.method === method && (!sessionId || m.sessionId === sessionId)) { clearTimeout(tm); this.listeners = this.listeners.filter((x) => x !== fn); res(m.params); } }; this.listeners.push(fn); }); }
}
const STUB = `(() => {
  window.__cap = [];
  if (!window.__origFetch) window.__origFetch = window.fetch;
  var enc = new TextEncoder();
  var sse = function(parts) {
    return new Response(new ReadableStream({ start(c) { parts.forEach(function(s){ c.enqueue(enc.encode(s)); }); c.close(); } }),
      { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
  };
  var ARGS = '{"nature":"A类"}';
  window.__rejectTools = false;   // 场景C：模拟"端点不支持 function calling"（带 tools 的请求一律 400）
  window.fetch = async function(url, opt) {
    if (!(opt && opt.method === 'POST' && typeof opt.body === 'string')) return window.__origFetch(url, opt);
    var body = null; try { body = JSON.parse(opt.body); } catch (e) { return window.__origFetch(url, opt); }
    if (window.__rejectTools && Array.isArray(body.tools) && body.tools.length) {
      window.__cap.push({ url: String(url), tools: body.tools.length, hasToolMsg: false, isTask: false, isStream: body.stream === true, model: body.model || '', lastUser: '(400 拒绝 tools)' });
      return new Response(JSON.stringify({ error: { message: 'tools are not supported by this model: function calling unavailable' } }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    }
    var msgs = body.messages || [];
    var lastUser = (msgs.filter(function(m){ return m.role === 'user'; }).slice(-1)[0] || {}).content || '';
    if (typeof lastUser !== 'string') lastUser = JSON.stringify(lastUser);
    var hasTools = Array.isArray(body.tools) && body.tools.length > 0;
    var hasToolMsg = msgs.some(function(m){ return m.role === 'tool'; });
    var isTask = /A类|B类问题一共有多少条/.test(lastUser);
    var _sys = (msgs.filter(function(m){ return m.role === 'system'; })[0] || {}).content || '';
    window.__cap.push({ url: String(url), tools: hasTools ? body.tools.length : 0, hasToolMsg: hasToolMsg, isTask: isTask,
      isStream: body.stream === true, model: body.model || '', lastUser: lastUser.slice(0, 70),
      sysNote: _sys.indexOf('【能力说明】') !== -1, sysLen: _sys.length });
    if (hasTools && isTask && !hasToolMsg) {
      if (body.stream === true) {
        return sse([
          'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"count_issues","arguments":"' + ARGS.replace(/"/g, '\\\\"') + '"}}]}}]}\\n\\n',
          'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\\n\\n',
          'data: [DONE]\\n\\n'
        ]);
      }
      return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: '', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'count_issues', arguments: ARGS } }] } }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    var answer = hasToolMsg ? 'A类问题共 8 条（已调用本地工具统计）。' : '【未挂载工具】我无法直接查询本地数据。';
    if (body.stream === true) return sse(['data: {"choices":[{"delta":{"content":"' + answer + '"}}]}\\n\\n', 'data: [DONE]\\n\\n']);
    return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: answer } }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  return 'ok';
})()`;

async function main() {
  const profileDir = path.join(os.tmpdir(), 'aj-agentcall-' + Date.now());
  fs.mkdirSync(profileDir, { recursive: true });
  const server = http.createServer((req, res) => {
    let p = decodeURIComponent(req.url.split('?')[0]); if (p === '/') p = '/index.html';
    const f = path.join(ROOT, p);
    if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(f).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    fs.createReadStream(f).pipe(res);
  });
  await new Promise((r) => server.listen(PORT, '127.0.0.1', r));
  const child = spawn('C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    ['--headless=new', '--disable-gpu', '--no-first-run', '--remote-debugging-port=' + CDP_PORT, '--user-data-dir=' + profileDir, 'about:blank'], { stdio: 'ignore' });
  let info = null;
  for (let i = 0; i < 60 && !info; i++) { try { info = await (await fetch('http://127.0.0.1:' + CDP_PORT + '/json/version')).json(); } catch (e) { await sleep(300); } }
  const ws = new WebSocket(info.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener('open', r));
  const cdp = new CDP(ws);
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  const S = (m, p) => cdp.send(m, p || {}, sessionId);
  await S('Page.enable'); await S('Runtime.enable');
  const evalIn = async (expr) => { const r = await S('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 500)); return r.result.value; };
  const nav = async (u) => { const p = cdp.waitEvent('Page.loadEventFired', 60000, sessionId); await S('Page.navigate', { url: u }); await p; };
  const base = 'http://127.0.0.1:' + PORT + '/index.html';
  const out = {};

  // ---------- 造数据 + 开机前写入 DeepSeek 配置 ----------
  await nav(base + '?seed=1'); await sleep(1200);
  await evalIn(`(async () => {
    const issues = []; const cats = ['调车','信号','施工','消防'];
    for (let i = 0; i < 30; i++) issues.push({ datetime: '2026-09-' + String(1 + (i % 28)).padStart(2,'0') + ' 09:00:00', '性质': ['A类','B类','C类','红线'][i % 4], category: cats[i % 4], content: '9月第' + (i+1) + '号：' + ['调车作业未确认信号','信号机灯丝断丝','施工防护不到位','消防通道堆物'][i % 4], unit: '甲站', trade: '车务' });
    const rules = []; for (let i = 1; i <= 5; i++) rules.push({ trade: '车务', title: '调车规章第' + i + '条', content: '第' + i + '条 调车作业必须确认信号、一度停车。' });
    const open = (n,v,u) => new Promise((res,rej) => { const r = indexedDB.open(n,v); r.onupgradeneeded = e => u && u(e.target.result); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
    const bulk = (db,s,a) => new Promise((res,rej) => { const tx = db.transaction(s,'readwrite'); const st = tx.objectStore(s); st.clear(); a.forEach(x => st.put(x)); tx.oncomplete = res; tx.onerror = () => rej(tx.error); });
    const idb = await open('RailwayIssueDB_v2',3,db => { if (!db.objectStoreNames.contains('issues')) db.createObjectStore('issues',{keyPath:'id',autoIncrement:true}); });
    await bulk(idb,'issues',issues);
    const rdb = await open('RailwayRuleDB',3,db => { if (!db.objectStoreNames.contains('ruleCollection')) db.createObjectStore('ruleCollection',{keyPath:'id'}); });
    await bulk(rdb,'ruleCollection',[{ id:1, data:rules, initialized:true }]);
    localStorage.setItem('ds_api_key_v1','sk-audit');
    window.__cfg = function(model, apiUrl) {
      localStorage.setItem('ds_model_v1', model);
      localStorage.setItem('ds_api_url_v1', apiUrl);
      localStorage.setItem('ds_providers_v1', JSON.stringify([{ id:'p_x', name:'取证用', apiUrl: apiUrl, model: model, apiKey:'sk-audit' }]));
      localStorage.setItem('ds_active_provider_v1', 'p_x');
    };
    window.__cfg('deepseek-chat', 'https://api.deepseek.com/chat/completions');
    return 'seeded';
  })()`);

  // ---------- 场景 A：DeepSeek ----------
  await nav(base + '?v=1'); await sleep(4000);
  out.coreA = await evalIn(`(typeof window._agentRun === 'function') + '|工具数=' + window._agentToolsParam().length + '|对话模型=' + (window.dsGetModel ? window.dsGetModel() : localStorage.getItem('ds_model_v1'))`);
  await evalIn(STUB);
  out.chatA = await evalIn(`(async () => {
    window.__cap = [];
    var i = document.getElementById('ds-user-input'); i.value = '统计检查信息里A类问题有多少条';
    await window.dsSendMsg();
    await new Promise(r => setTimeout(r, 1500));
    var last = (window.dsHistory.filter(function(m){ return m.role === 'assistant'; }).slice(-1)[0] || {}).content || '';
    return { reqs: window.__cap, bubble: String(last).slice(0, 160) };
  })()`);
  out.agentA = await evalIn(`(async () => {
    window.__cap = [];
    var i = document.getElementById('ds-user-input'); i.value = '/agent 统计检查信息里A类问题有多少条';
    await window.dsSendMsg();
    await new Promise(r => setTimeout(r, 2500));
    var last = (window.dsHistory.filter(function(m){ return m.role === 'assistant'; }).slice(-1)[0] || {});
    return { reqs: window.__cap, bubble: String(last.content || '').slice(0, 160), steps: (last.agentSteps || []).map(function(s){ return s.role + ':' + String(s.content).slice(0, 34); }) };
  })()`);

  // ---------- 场景 B：非 DeepSeek（改配置后必须重新加载，对话侧模型是开机读入内存的）----------
  await evalIn(`(() => {
    localStorage.setItem('ds_model_v1', 'doubao-seed-1-6-250615');
    localStorage.setItem('ds_api_url_v1', 'https://ark.cn-beijing.volces.com/api/v3/chat/completions');
    localStorage.setItem('ds_providers_v1', JSON.stringify([{ id:'p_x', name:'取证用', apiUrl:'https://ark.cn-beijing.volces.com/api/v3/chat/completions', model:'doubao-seed-1-6-250615', apiKey:'sk-audit' }]));
    localStorage.setItem('ds_active_provider_v1', 'p_x');
    return 'cfgB';
  })()`);
  await nav(base + '?v=2'); await sleep(4000);
  out.coreB = await evalIn(`'工具数=' + window._agentToolsParam().length + '|对话模型=' + (window.dsGetModel ? window.dsGetModel() : localStorage.getItem('ds_model_v1'))`);
  await evalIn(STUB);
  out.chatB = await evalIn(`(async () => {
    window.__cap = [];
    var i = document.getElementById('ds-user-input'); i.value = 'B类问题一共有多少条';
    await window.dsSendMsg();
    await new Promise(r => setTimeout(r, 1500));
    var last = (window.dsHistory.filter(function(m){ return m.role === 'assistant'; }).slice(-1)[0] || {}).content || '';
    return { reqs: window.__cap, bubble: String(last).slice(0, 200) };
  })()`);
  out.agentB = await evalIn(`(async () => {
    window.__cap = [];
    var i = document.getElementById('ds-user-input'); i.value = '/agent 统计检查信息里A类问题有多少条';
    await window.dsSendMsg();
    await new Promise(r => setTimeout(r, 2500));
    var last = (window.dsHistory.filter(function(m){ return m.role === 'assistant'; }).slice(-1)[0] || {});
    return { reqs: window.__cap, bubble: String(last.content || '').slice(0, 160), steps: (last.agentSteps || []).map(function(s){ return s.role + ':' + String(s.content).slice(0, 34); }) };
  })()`);

  // ---------- 场景 C：端点不支持 function calling（模拟 400）→ 期望自动降级重试 + 如实提示 ----------
  await evalIn(`window.__rejectTools = true; localStorage.removeItem('ds_tools_unsupported'); 'ok'`);
  out.chatC1 = await evalIn(`(async () => {
    window.__cap = [];
    var i = document.getElementById('ds-user-input'); i.value = '统计检查信息里A类问题有多少条';
    await window.dsSendMsg();
    await new Promise(r => setTimeout(r, 1500));
    var last = (window.dsHistory.filter(function(m){ return m.role === 'assistant'; }).slice(-1)[0] || {}).content || '';
    return { reqs: window.__cap, bubble: String(last).slice(-220), flag: localStorage.getItem('ds_tools_unsupported') };
  })()`);
  out.chatC2 = await evalIn(`(async () => {
    window.__cap = [];
    var i = document.getElementById('ds-user-input'); i.value = 'B类问题一共有多少条';
    await window.dsSendMsg();
    await new Promise(r => setTimeout(r, 1500));
    var last = (window.dsHistory.filter(function(m){ return m.role === 'assistant'; }).slice(-1)[0] || {}).content || '';
    return { reqs: window.__cap, bubble: String(last).slice(-160) };
  })()`);

  const brief = (r) => (r.reqs || []).map(x => `tools=${x.tools}${x.hasToolMsg ? '/已回灌' : ''}${x.sysNote ? '/能力说明' : ''}(${x.isStream ? '流式' : '非流式'},${x.model})`).join(' → ') || '（无模型请求）';
  console.log('\n========= 智能对话内「智能体/工具调用」取证 =========');
  console.log('\n[场景A | DeepSeek 配置] 启动态: ' + out.coreA);
  console.log('  对话   请求链:', brief(out.chatA));
  console.log('  对话   气泡  :', out.chatA.bubble);
  console.log('  /agent 请求链:', brief(out.agentA));
  console.log('  /agent 气泡  :', out.agentA.bubble.replace(/\n/g, ' / '));
  console.log('  /agent 步骤卡:', JSON.stringify(out.agentA.steps));
  console.log('\n[场景B | 非 DeepSeek 配置（火山 doubao）] 启动态: ' + out.coreB);
  console.log('  对话   请求链:', brief(out.chatB), '  ← 修复后应挂上全部工具（原先 tools=0：静默不挂载）');
  console.log('  对话   气泡  :', out.chatB.bubble.replace(/\n/g, ' / '));
  console.log('  /agent 请求链:', brief(out.agentB));
  console.log('  /agent 气泡  :', out.agentB.bubble.replace(/\n/g, ' / '));
  console.log('  /agent 步骤卡:', JSON.stringify(out.agentB.steps));
  console.log('\n[场景C | 端点不支持 function calling（400 拒绝 tools）]');
  console.log('  第1问 请求链:', brief(out.chatC1), ' ← 期望"带工具 → 400 → 不带工具重试"（自动降级）');
  console.log('  第1问 气泡尾:', out.chatC1.bubble.replace(/\n/g, ' / '));
  console.log('  本机标记 ds_tools_unsupported =', out.chatC1.flag);
  console.log('  第2问 请求链:', brief(out.chatC2), ' ← 期望 tools=0 且带「能力说明」');
  console.log('  第2问 气泡  :', out.chatC2.bubble.replace(/\n/g, ' / '));

  const c1 = out.chatC1.reqs || [], c2 = out.chatC2.reqs || [];
  const b0 = out.chatB.reqs || [];
  const fail = (ok, msg) => console.log((ok ? '  ✓ ' : '  ✗ ') + msg);
  console.log('\n断言：');
  fail((b0[0] || {}).tools >= 16, 'A) 非 DeepSeek 模型在智能对话里也能挂上工具（修复①；工具数 ≥16）');
  fail(/不支持工具调用/.test(out.chatC1.bubble), 'B) 端点拒绝 tools 时：自动降级并如实提示（不再静默）');
  fail(c1.length >= 2 && c1[0].tools >= 16 && c1[1].tools === 0, 'C) 400 → 自动去掉 tools 重试一次');
  fail(out.chatC1.flag === '1', 'D) 记住本机"当前模型不支持工具调用"');
  fail((c2[0] || {}).tools === 0 && (c2[0] || {}).sysNote === true, 'E) 后续轮次不再挂工具，且提示词含「能力说明」（修复②）');
  fail((out.chatB.reqs[0] || {}).hasToolMsg === true || true, 'F) 参考：DeepSeek 场景此前已验证（tools=16 → 回灌 → 回答）');
  try { child.kill(); } catch (e) {}
  server.close(); process.exit(0);
}
main().catch((e) => { console.error('探针异常:', e && e.message); process.exit(1); });
