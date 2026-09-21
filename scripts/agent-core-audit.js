// 智能体核心回归审计（A~S，共 34 项）—— 无需真实模型与真实数据
// 背景：2026-09-21 八维审计后的三批优化，本脚本用合成数据 + stub 模型逐项断言：
//   A/A2 工具结果预算裁剪 · B~B4 参数口径（日期归一/性质首字母/month 分组/groupBy 白名单）
//   C/C2 反思契约（配对不违反）· D 停止令牌 · E~E5 记忆（失败样本/统计口径/上限/统计/清空）
//   F 上下文预算（历史工具结果压缩）· G/G2 能力（批量取全文 / CSV 导出）
//   H 工具通用超时 · I/I2 对话内 /agent 传图与资源释放 · J/J2 目标提醒冷却与删除入口 · K 语义缓存指纹与清空
//   L/L2 盯控类型扩到 规章制度/工作日志 · M~M3 失败重试策略（只读重试一次 / 写库不重试 / 可覆盖）
//   N 语义缓存 TTL（15 分钟，可配置）· O 盯控扩到 应急电话/待办备忘 · P 慢工具分段进度（每秒心跳+阶段文案）
//   Q 工具执行总预算（超预算不执行新工具）· R 盯控比较方式（阈值/增量/默认）· S 只读工具结果 60s 短缓存
// 用法：node scripts/agent-core-audit.js（零依赖：内置 http + Edge 无头 CDP）
// 改完 agent-core.js / app.js 工具层 / agent-memory.js / agent-goals.js / unified-enhancements.js 后跑一次即可回归。
//  A. 工具结果预算裁剪 _agentTrimToolResult
//  B. count_issues 参数口径：月粒度/斜杠/首字母性质/groupBy 白名单/month 分组
//  C. 反思路径契约（重复调用 → 跳过执行且保持 tool_calls 配对 → 仍能给出最终回答）
//  D. 停止令牌（__agentRunToken 递增 → dsAgentStop 作废当前 run）
// 用法：node scripts/_tmp-fix-check.js
const http = require('http'); const fs = require('fs'); const path = require('path'); const os = require('os');
const { spawn } = require('child_process');
const ROOT = path.resolve(__dirname, '..'), PORT = 8136, CDP_PORT = 9346;
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
async function main() {
  const profileDir = path.join(os.tmpdir(), 'aj-fixchk-' + Date.now());
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

  // 数据：9 月 15 条（其中 A类 4）+ 8 月 10 条（用 '/' 分格，验证跨格式）
  await nav(base + '?seed=1'); await sleep(800);
  console.log('seed:', await evalIn(`(async () => {
    const issues = [];
    for (let i = 0; i < 15; i++) issues.push({ datetime: '2026-09-' + String(1 + i).padStart(2,'0') + ' 09:00:00', '性质': ['A类','B类','C类'][i % 3], category: '调车', content: '9月第' + (i+1) + '号问题', unit: '兰州电务段', trade: '车务' });
    for (let i = 0; i < 10; i++) issues.push({ datetime: '2026/08/' + String(1 + i).padStart(2,'0') + ' 09:00:00', '性质': ['A类','红线'][i % 2], category: '信号', content: '8月第' + (i+1) + '号问题', unit: '甲站', trade: '电务' });
    const open = (n,v,u) => new Promise((res,rej) => { const r = indexedDB.open(n,v); r.onupgradeneeded = e => u && u(e.target.result); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
    const bulk = (db,s,a) => new Promise((res,rej) => { const tx = db.transaction(s,'readwrite'); const st = tx.objectStore(s); st.clear(); a.forEach(x => st.put(x)); tx.oncomplete = res; tx.onerror = () => rej(tx.error); });
    const idb = await open('RailwayIssueDB_v2',3,db => { if (!db.objectStoreNames.contains('issues')) db.createObjectStore('issues',{keyPath:'id',autoIncrement:true}); });
    await bulk(idb,'issues',issues);
    localStorage.setItem('ds_api_key_v1','sk-audit');
    localStorage.setItem('ds_model_v1','deepseek-chat');
    localStorage.setItem('ds_api_url_v1','https://api.deepseek.com/chat/completions');
    return 'issues=' + issues.length;
  })()`));

  await nav(base + '?v=1'); await sleep(2500);
  out.live = await evalIn(`'issues=' + (window.getIssueData ? window.getIssueData().length : -1)`);

  // ---------- A. 结果预算裁剪 ----------
  out.trim = await evalIn(`(() => {
    var big = { total: 100, items: [] };
    for (var i = 0; i < 100; i++) big.items.push({ 标题: 'T' + i, 摘要: new Array(500).join('字') });
    var t = window._agentTrimToolResult(big);
    var longStr = window._agentTrimToolResult({ total: 9, items: [{ x: new Array(50000).join('大') }] });
    return { items: (t.items || []).length, hasNote: !!t.截断提示, totalKeep: t.total,
             strLen: String(((longStr.items || [])[0] || {}).x || '').length };
  })()`);

  // ---------- B. count_issues 参数口径 ----------
  out.count = await evalIn(`(() => {
    var c = window._agentCountIssues;
    return {
      sept:      c('', '', '', '2026-09', '', '', '').total,                 // 期望 15（月粒度）
      septSlash: c('', '', '', '2026/9/1', '', '', '').total,                // 期望 15（斜杠+未补零）
      septAll:   c('', '', '', '2026-09-01', '2026-09-30', '', '').total,    // 期望 15
      natA:      c('', '', '', '2026-09', '', 'A', '').total,                // 期望 5（A类出现 5 次：i%3==0 → 0,3,6,9,12）
      nat红:     c('', '', '', '', '', '红线', '').total,                     // 期望 5（8月 i%2==1）
      monthGrp:  c('', '', '', '', '', '', 'month').groups,                  // 期望 {2026-09:15, 2026-08:10}
      badGrp:    c('', '', '', '', '', '', '月份').参数错误 || ''             // 期望有参数错误
    };
  })()`);

  // ---------- C. 反思路径契约（重复调用 → 跳过并保持配对）----------
  await evalIn(`(() => {
    window.__cap = [];
    if (!window.__origFetch) window.__origFetch = window.fetch;
    var ARGS = '{"nature":"A类"}';
    var json = function(obj) { return new Response(JSON.stringify(obj), { status: 200, headers: { 'Content-Type': 'application/json' } }); };
    window.fetch = async function(url, opt) {
      if (!(opt && opt.method === 'POST' && typeof opt.body === 'string')) return window.__origFetch(url, opt);
      var body = null; try { body = JSON.parse(opt.body); } catch (e) { return window.__origFetch(url, opt); }
      var msgs = body.messages || [];
      var toolMsgs = msgs.filter(function(m){ return m.role === 'tool'; }).length;
      // 契约校验：每条带 tool_calls 的 assistant 后面，tool 响应数量必须 >= tool_calls 数量
      var pending = 0, breach = false;
      msgs.forEach(function(m) {
        if (m.role === 'assistant' && m.tool_calls) pending += m.tool_calls.length;
        else if (m.role === 'tool') pending = Math.max(0, pending - 1);
      });
      if (pending > 0 && msgs[msgs.length - 1].role === 'assistant' && msgs[msgs.length - 1].tool_calls) breach = true;   // 允许"刚发出、等响应"的形态
      var _um = msgs.filter(function(m){ return m.role === 'user'; })[0] || {};
      var _uArr = Array.isArray(_um.content);
      var _uImg = _uArr && _um.content.some(function(b){ return b && b.type === 'image_url'; });
      window.__cap.push({ toolMsgs: toolMsgs, tools: (body.tools || []).length, breach: breach, uArr: _uArr, uImg: _uImg });
      if (toolMsgs <= 1) {   // 前两轮：请求完全相同的工具调用（触发重复检测）
        return json({ choices: [{ message: { role: 'assistant', content: '', tool_calls: [{ id: 'c' + toolMsgs, type: 'function', function: { name: 'count_issues', arguments: ARGS } }] } }] });
      }
      return json({ choices: [{ message: { role: 'assistant', content: '已基于已有信息作答：A类 5 条。' } }] });
    };
    return 'ok';
  })()`);
  out.reflect = await evalIn(`(async () => {
    var res = await window._agentRun('统计A类问题有多少条');
    var msgs = (res && res.messages) || [];
    var finalTxt = '';
    msgs.forEach(function(m) { if (m && m.role === 'assistant') finalTxt = m.content || ''; });
    return {
      reqs: window.__cap,
      cards: msgs.map(function(m){ return m.role + ':' + String(m.content).slice(0, 26); }),
      final: finalTxt.slice(0, 80),
      interrupted: finalTxt.indexOf('执行中断') !== -1,
      reflected: msgs.some(function(m){ return /反思/.test(m.content || ''); })
    };
  })()`);

  // ---------- D. 停止令牌 ----------
  out.token = await evalIn(`(() => {
    var before = window.__agentRunToken || 0;
    if (typeof window.dsAgentStop === 'function') window.dsAgentStop();
    var after = window.__agentRunToken || 0;
    return { before: before, after: after, increased: after > before };
  })()`);

  // ---------- E. 记忆：失败样本可见 + 统计口径学习 + 上限 + 画像清理 ----------
  out.mem = await evalIn(`(async () => {
    // 1) 注入历史：失败/0命中必须保留，且有长度上限
    await window.saveAgentTask({ id: 'audit_mem_1', timestamp: new Date().toISOString(), userIntent: new Array(200).join('长'), plan: ['先统计'],
      steps: [{ tool: 'count_issues', ok: false, summary: 'count_issues: ❌ 执行失败' }, { tool: 'kb_search', ok: true, summary: 'kb_search: ✅ 共0条' }],
      finalOutput: '❌ 执行中断', durationMs: 4321 });
    var ctx = await window.getRecentAgentContext();
    // 2) 学习统计口径（count_issues 的 unit/nature/dateFrom）
    window.clearAgentPreferences && window.clearAgentPreferences();
    window.learnFromConversation('统计', { steps: [{ tool: 'count_issues', ok: true, params: { unit: '兰州电务段', nature: 'A类', dateFrom: '2026-09-01' } }] });
    var view1 = window.getAgentProfileView();
    // 3) 上限：灌 20 个不同单位 → 单位项应 ≤12
    for (var i = 0; i < 20; i++) window.learnFromConversation('x', { steps: [{ tool: 'count_issues', ok: true, params: { unit: 'U' + i } }] });
    var view2 = window.getAgentProfileView();
    var pref = window.getPreferencePrompt();
    // 4) 统计与清理
    var stats = await window.getAgentToolStats();
    window.clearAgentPreferences();
    var view3 = window.getAgentProfileView();
    return { ctx: ctx, ctxLen: ctx.length, view1: view1, unitCount: Object.keys(view2.单位 || {}).length, pref: pref,
             stats: stats, cleared: Object.keys(view3.单位 || {}).length === 0 };
  })()`);

  // ---------- F. 上下文预算：历史工具结果被压缩为一行 ----------
  out.ctx = await evalIn(`(() => {
    var msgs = [{ role: 'system', content: 's' }, { role: 'user', content: 'u' }];
    for (var i = 0; i < 10; i++) {
      msgs.push({ role: 'assistant', content: '', tool_calls: [{ id: 'c' + i, type: 'function', function: { name: 'count_issues', arguments: '{}' } }] });
      msgs.push({ role: 'tool', tool_call_id: 'c' + i, name: 'count_issues', content: JSON.stringify({ total: i, items: [{ x: 'y'.repeat(200) }] }) });
    }
    var before = JSON.stringify(msgs).length;
    window._agentCompactMessages(msgs);
    var toolMsgs = msgs.filter(function(m) { return m.role === 'tool'; });
    var compacted = toolMsgs.filter(function(m) { return String(m.content).indexOf('（历史工具结果已省略') === 0; }).length;
    var keptFull = toolMsgs.filter(function(m) { return String(m.content).indexOf('（历史工具结果已省略') !== 0; }).length;
    return { before: before, after: JSON.stringify(msgs).length, compacted: compacted, keptFull: keptFull, firstKeptTotal: /total=9/.test(toolMsgs[0].content) };
  })()`);

  // ---------- G. 能力：批量取全文 + CSV 导出 ----------
  out.cap = await evalIn(`(async () => {
    var dl = null;
    var origDl = window.downloadBlob;
    window.downloadBlob = function(blob, name) { dl = { name: name, size: blob && blob.size }; };
    var details = await window._agentRunTool('get_issue_details', { ids: [0, 1, 2] });
    var exp = await window._agentRunTool('export_issues', { dateFrom: '2026-09' });
    window.downloadBlob = origDl;
    return { detailCount: (details && details.result && details.result.total) || 0,
             exportTotal: (exp && exp.result && exp.result.条数) || 0,
             fileName: (exp && exp.result && exp.result.文件名) || '',
             dl: dl };
  })()`);

  // ---------- H. 工具通用超时（把 kb_search 换成永不 resolve，超时应按失败返回） ----------
  out.timeout = await evalIn(`(async () => {
    // 用 export_issues 验证（它的依赖就是 window._agentExportIssues，替换成"永不 resolve"最可靠）
    var orig = window._agentExportIssues;
    window.__agentToolTimeoutMs = { default: 300, export_issues: 300 };
    try {
      window._agentExportIssues = function () { return new Promise(function () {}); };
      var t0 = performance.now();
      var r = await window._agentRunTool('export_issues', { unit: 'X' });
      return { ok: r.ok, err: String(r.error || '').slice(0, 70), ms: Math.round(performance.now() - t0) };
    } finally {
      window._agentExportIssues = orig;
      try { delete window.__agentToolTimeoutMs; } catch (e) {}
    }
  })()`);

  // ---------- I. /agent 传图片（对话内入口）----------
  out.vision = await evalIn(`(async () => {
    window.__cap = [];
    localStorage.setItem('ds_model_v1', 'deepseek-flash');   // 支持视觉的模型
    window._dsAttachments = [{ name: '现场照片.jpg', isImage: true, dataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==' }];
    var i = document.getElementById('ds-user-input');
    i.value = '/agent 看这张图有什么问题';
    await window.dsSendMsg();
    await new Promise(function (r) { setTimeout(r, 900); });
    var first = window.__cap[0] || {};
    var isArray = !!first.uArr;
    var hasImg = !!first.uImg;
    var lastUser = '';
    window.dsHistory.slice(-3).forEach(function (m) { if (m.role === 'user') lastUser = String(m.content || '').slice(0, 50); });
    var lastAsst = String(((window.dsHistory.filter(function (m) { return m.role === 'assistant'; }).slice(-1)[0] || {}).content) || '').slice(0, 80);
    return { hasRequest: window.__cap.length > 0, capLen: window.__cap.length, model: localStorage.getItem('ds_model_v1'),
             isArray: isArray, hasImg: !!hasImg,
             attachCleared: (window._dsAttachments || []).length === 0,
             visionCleared: window.__agentVisionContent === null,
             lastUser: lastUser, lastAsst: lastAsst };
  })()`);

  // ---------- J. 目标提醒：冷却 / 去重 / 删除入口 ----------
  out.goals = await evalIn(`(async () => {
    window.__issueDataReady = true;
    window.clearGoals && window.clearGoals();
    var r1 = window.handleAgentCommand('/goal 调车');
    var gs = window.getGoals();
    gs[0].baselined = true; gs[0].lastMatched = 0; gs[0].lastTriggered = new Date().toISOString();   // 刚提醒过
    localStorage.setItem('agent_active_goals', JSON.stringify(gs));
    var host = function () { var h = document.getElementById('agent-goal-toasts'); return h ? h.children.length : 0; };
    var n0 = host();
    window.checkGoals();
    var nCool = host();
    var gs2 = window.getGoals()[0];
    gs2.lastTriggered = new Date(Date.now() - 7 * 3600 * 1000).toISOString();                        // 冷却已过
    gs2.lastMatched = 0;                                                                             // 造出"新增"（否则 n === base 不会触发）
    localStorage.setItem('agent_active_goals', JSON.stringify([gs2]));
    window.checkGoals();
    var nExpire = host();
    var notified = (window.getGoals()[0] || {}).lastNotifiedCount || 0;
    window.checkGoals();                                                                             // 同计数再查
    var nAgain = host();
    var list = window.handleAgentCommand('/goals');
    var rm = window.handleAgentCommand('/goal-remove 1');
    var listAfter = window.handleAgentCommand('/goals');
    return { add: String(r1).slice(0, 26), n0: n0, nCool: nCool, nExpire: nExpire, nAgain: nAgain,
             notified: notified, listHasHint: /删除：\\/goal-remove/.test(list), rm: String(rm).slice(0, 22),
             listAfter: String(listAfter).slice(0, 30) };
  })()`);

  // ---------- K. 语义缓存：可清空 + 命中行为 ----------
  out.cache = await evalIn(`(async () => {
    // 普通对话走**流式**：这里换成支持 SSE 的 stub（否则 _dsStreamChat 读不到内容，回答恒为空）
    if (!window.__origFetch) window.__origFetch = window.fetch;
    var enc = new TextEncoder();
    window.fetch = async function (url, opt) {
      if (!(opt && opt.method === 'POST' && typeof opt.body === 'string')) return window.__origFetch(url, opt);
      var body = {}; try { body = JSON.parse(opt.body); } catch (e) {}
      if (body.stream === true) {
        var sse = 'data: {"choices":[{"delta":{"content":"（审调合成的普通回答）"}}]}\\n\\ndata: [DONE]\\n\\n';
        return new Response(new ReadableStream({ start: function (c) { c.enqueue(enc.encode(sse)); c.close(); } }), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
      }
      return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'ok' } }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    };
    var out = { hasClear: typeof window.__dsSemCacheClear === 'function', hooked: !!(window.dsInvalidateRagCache && window.dsInvalidateRagCache.__semHooked) };
    // 轮询等待"本轮新出现的 assistant 消息内容非空"（首次提问要等 KB 注入，冷建时可能 1~3s）
    var waitAnswer = async function (prevCount) {
      for (var i = 0; i < 40; i++) {
        await new Promise(function (r) { setTimeout(r, 200); });
        var m = window.dsHistory.filter(function (x) { return x.role === 'assistant'; });
        if (m.length > prevCount && String(m[m.length - 1].content || '').length > 0) return String(m[m.length - 1].content);
      }
      return '';
    };
    var ask = async function (q) {
      var before = window.dsHistory.filter(function (x) { return x.role === 'assistant'; }).length;
      var i = document.getElementById('ds-user-input'); i.value = q;
      await window.dsSendMsg();
      return await waitAnswer(before);
    };
    out.enableUnified = !!window.ENABLE_UNIFIED;
    var q = '介绍一下兰州西站的概况';
    var a1 = await ask(q);
    out.a1 = String(a1).slice(0, 60);
    var a2 = await ask(q);
    out.a2 = String(a2).slice(0, 60);
    out.secondFromCache = a2.indexOf('来自缓存') !== -1;
    window.__dsSemCacheClear();
    var a3 = await ask(q);
    out.afterClearFromCache = a3.indexOf('来自缓存') !== -1;
    out.usedToolsFlag = window.__dsLastTurnUsedTools;
    return out;
  })()`);

  // ---------- L. 盯控目标支持"规章制度 / 工作日志"类型 ----------
  out.goals2 = await evalIn(`(async () => {
    window.__issueDataReady = true;
    window.clearGoals();
    var r1 = window.handleAgentCommand('/goal 规章 调车');
    var r2 = window.handleAgentCommand('/goal 日志 防洪');
    try { await window._agentWriteDiary('防洪检查：站场排水沟清理完毕', '', '', []); } catch (e) {}
    window.checkGoals();                                  // 首次：只建基线
    var base = window.getGoals().map(function (g) { return { t: (g.condition || {}).type, base: g.lastMatched, based: !!g.baselined }; });
    // 造增量：规章 +3 条、日志 +1 条，并把冷却/基线放开
    for (var i = 0; i < 3; i++) { try { window.getRulesData().push({ trade: '车务', title: '新增调车规章' + i, content: '调车作业新增要求' + i }); } catch (e) {} }
    try { await window._agentWriteDiary('防洪巡查：新增一处隐患已整改', '', '', []); } catch (e) {}
    var gs2 = window.getGoals();
    gs2.forEach(function (g) { g.lastMatched = 0; g.lastTriggered = new Date(Date.now() - 7 * 3600 * 1000).toISOString(); });
    localStorage.setItem('agent_active_goals', JSON.stringify(gs2));
    window.checkGoals();
    var after = window.getGoals().map(function (g) { return { t: (g.condition || {}).type, n: g.lastMatched, notified: g.lastNotifiedCount || 0 }; });
    var list = window.handleAgentCommand('/goals');
    window.clearGoals();
    return { r1: String(r1).slice(0, 44), r2: String(r2).slice(0, 44), base: base, after: after,
             listHasRule: /\\[规章制度\\]/.test(list), listHasDiary: /\\[工作日志\\]/.test(list) };
  })()`);

  // ---------- M. 失败重试策略（只读重试一次；写库不重试；可覆盖）----------
  out.retry = await evalIn(`(async () => {
    var orig = window._agentGetIssues, calls = 0;
    window._agentGetIssues = function () { calls++; if (calls === 1) throw new Error('模拟瞬时失败'); return orig.apply(this, arguments); };
    var r1 = await window._agentRunTool('search_issues', { keyword: '调车' });
    window._agentGetIssues = orig;
    var worig = window._agentWriteDiary, wcalls = 0;
    window._agentWriteDiary = function () { wcalls++; throw new Error('模拟写库失败'); };
    var r2 = await window._agentRunTool('write_diary', { content: 'x' });
    window._agentWriteDiary = worig;
    window.__agentToolRetry = { search_issues: 0 };        // 覆盖：只读工具也不重试
    var c2 = 0, o2 = window._agentGetIssues;
    window._agentGetIssues = function () { c2++; throw new Error('必失败'); };
    var r3 = await window._agentRunTool('search_issues', { keyword: 'x' });
    window._agentGetIssues = o2;
    try { delete window.__agentToolRetry; } catch (e) {}
    return { ok1: r1.ok, note1: r1.重试说明 || '', callsReadOnly: calls,
             ok2: r2.ok, wcalls: wcalls, err2: String(r2.error || '').slice(0, 26),
             ok3: r3.ok, callsOverride: c2, err3: String(r3.error || '').slice(0, 30) };
  })()`);

  // ---------- N. 语义缓存 TTL（默认 15 分钟；覆盖为 0 = 关闭缓存）----------
  await evalIn(`localStorage.setItem('ds_sem_cache_ttl_min', '0'); 'ok'`);
  await nav(base + '?v=ttl'); await sleep(2500);
  out.ttl = await evalIn(`(async () => {
    if (!window.__origFetch) window.__origFetch = window.fetch;
    var enc = new TextEncoder();
    window.fetch = async function (url, opt) {
      if (!(opt && opt.method === 'POST' && typeof opt.body === 'string')) return window.__origFetch(url, opt);
      var body = {}; try { body = JSON.parse(opt.body); } catch (e) {}
      if (body.stream === true) {
        var sse = 'data: {"choices":[{"delta":{"content":"（TTL 测试回答）"}}]}\\n\\ndata: [DONE]\\n\\n';
        return new Response(new ReadableStream({ start: function (c) { c.enqueue(enc.encode(sse)); c.close(); } }), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
      }
      return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'ok' } }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    };
    var ask = async function (q) {
      var before = window.dsHistory.filter(function (x) { return x.role === 'assistant'; }).length;
      var i = document.getElementById('ds-user-input'); i.value = q;
      await window.dsSendMsg();
      for (var k = 0; k < 40; k++) {
        await new Promise(function (r) { setTimeout(r, 200); });
        var m = window.dsHistory.filter(function (x) { return x.role === 'assistant'; });
        if (m.length > before && String(m[m.length - 1].content || '').length > 0) return String(m[m.length - 1].content);
      }
      return '';
    };
    var q = 'TTL 覆盖测试问题：站场情况如何';
    var a1 = await ask(q);
    var a2 = await ask(q);
    return { a1: String(a1).slice(0, 34), fromCache: a2.indexOf('来自缓存') !== -1 };
  })()`);
  await evalIn(`localStorage.removeItem('ds_sem_cache_ttl_min'); 'ok'`);

  // ---------- O. 盯控扩到 应急电话 / 待办备忘 ----------
  out.goals3 = await evalIn(`(async () => {
    window.__issueDataReady = true;
    var oPhone = window.getPhoneData, oMemo = window.getMemoData;
    var hasAccessor = typeof oMemo === 'function';
    try {
      window.getPhoneData = function () { return [{ 站名: '兰州西', 单位: '兰州电务段', 线名: '兰新线', 路电: '011-12345', 市电: '0931-12345' }]; };
      window.getMemoData = function () { return [{ datetime: '2026-09-22 09:00', content: '防洪物资清点' }]; };
      window.clearGoals();
      var r1 = window.handleAgentCommand('/goal 电话 兰州西');
      var r2 = window.handleAgentCommand('/goal 待办 防洪');
      window.checkGoals();
      var base = window.getGoals().map(function (g) { return (g.condition || {}).type; });
      window.getPhoneData = function () { return [{ 站名: '兰州西', 单位: '兰州电务段', 线名: '兰新线', 路电: '011-12345', 市电: '0931-12345' }, { 站名: '兰州西客场', 单位: '兰州电务段', 线名: '兰新线', 路电: 'x', 市电: 'y' }]; };
      window.getMemoData = function () { return [{ datetime: '2026-09-22 09:00', content: '防洪物资清点' }, { datetime: '2026-09-23 10:00', content: '防洪演练安排' }]; };
      var gs = window.getGoals();
      gs.forEach(function (g) { g.lastMatched = 0; g.lastTriggered = new Date(Date.now() - 7 * 3600 * 1000).toISOString(); });
      localStorage.setItem('agent_active_goals', JSON.stringify(gs));
      window.checkGoals();
      var after = window.getGoals().map(function (g) { return { t: (g.condition || {}).type, n: g.lastMatched, notified: g.lastNotifiedCount || 0 }; });
      var list = window.handleAgentCommand('/goals');
      window.clearGoals();
      return { r1: String(r1).slice(0, 40), r2: String(r2).slice(0, 40), base: base, after: after,
               listHasPhone: /\\[应急电话\\]/.test(list), listHasMemo: /\\[待办备忘\\]/.test(list), hasAccessor: hasAccessor };
    } finally {
      window.getPhoneData = oPhone; window.getMemoData = oMemo;
    }
  })()`);

  // ---------- P. 工具分段进度（慢工具每秒心跳 + 阶段文案）----------
  out.progress = await evalIn(`(async () => {
    var orig = window._agentExportIssues, origFetch = window.fetch, events = [];
    window.fetch = async function (url, opt) {
      if (!(opt && opt.method === 'POST' && typeof opt.body === 'string')) return origFetch(url, opt);
      var body = {}; try { body = JSON.parse(opt.body); } catch (e) {}
      var msgs = body.messages || [];
      var hasTool = msgs.some(function (m) { return m.role === 'tool'; });
      if (!hasTool) return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: '', tool_calls: [{ id: 'p1', type: 'function', function: { name: 'export_issues', arguments: '{"unit":"X"}' } }] } }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: '导出完成' } }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    };
    window._agentExportIssues = function () { return new Promise(function (r) { setTimeout(function () { r({ 条数: 1, 文件名: 'x.csv' }); }, 2500); }); };
    try {
      await window._agentRun('导出一下', null, { onStep: function (ev) { if (ev && ev.phase === 'tool-progress') events.push({ tool: ev.tool, ms: ev.ms, text: ev.text }); } });
    } finally {
      window._agentExportIssues = orig; window.fetch = origFetch;
    }
    return { n: events.length, first: events[0] || null, last: events[events.length - 1] || null, cleared: window.__agentProgress === null };
  })()`);

  // ---------- Q. 工具执行总预算（超出后不再执行新工具，按"未执行"回灌）----------
  out.budget = await evalIn(`(async () => {
    var exportCalls = 0, searchCalls = 0;
    var oExp = window._agentExportIssues, oIss = window._agentGetIssues, oFetch = window.fetch;
    window.__agentToolBudgetMs = 50;                      // 极小预算：第一轮慢工具跑完后就该触发
    window._agentExportIssues = function () { exportCalls++; return new Promise(function (r) { setTimeout(function () { r({ 条数: 1, 文件名: 'x.csv' }); }, 300); }); };
    window._agentGetIssues = function () { searchCalls++; return oIss.apply(this, arguments); };
    var skippedMsg = '';
    window.fetch = async function (url, opt) {
      if (!(opt && opt.method === 'POST' && typeof opt.body === 'string')) return oFetch(url, opt);
      var body = {}; try { body = JSON.parse(opt.body); } catch (e) {}
      var msgs = body.messages || [];
      (msgs.filter(function (m) { return m.role === 'tool'; })).forEach(function (m) { if (String(m.content || '').indexOf('总预算') !== -1) skippedMsg = String(m.content).slice(0, 60); });
      var hasTool = msgs.some(function (m) { return m.role === 'tool'; });
      if (!hasTool) return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: '', tool_calls: [{ id: 'b1', type: 'function', function: { name: 'export_issues', arguments: '{"unit":"X"}' } }] } }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      if (!skippedMsg) return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: '', tool_calls: [{ id: 'b2', type: 'function', function: { name: 'search_issues', arguments: '{"keyword":"调车"}' } }] } }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: '（预算内作答）' } }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    };
    var finalTxt = '';
    try {
      var res = await window._agentRun('先导出再检索一下');
      ((res && res.messages) || []).forEach(function (m) { if (m.role === 'assistant') finalTxt = String(m.content || ''); });
    } finally {
      window._agentExportIssues = oExp; window._agentGetIssues = oIss; window.fetch = oFetch;
      try { delete window.__agentToolBudgetMs; } catch (e) {}
    }
    return { exportCalls: exportCalls, searchCalls: searchCalls, skippedMsg: skippedMsg, final: finalTxt.slice(0, 30) };
  })()`);

  // ---------- R. 盯控比较方式（阈值 / 增量 / 默认）----------
  out.modes = await evalIn(`(async () => {
    window.__issueDataReady = true;
    var oPhone = window.getPhoneData;
    var rows = [{ 站名: '甲', 单位: 'A', 线名: 'L', 路电: '1', 市电: '2' }];
    var hostCount = function () { var h = document.getElementById('agent-goal-toasts'); return h ? h.children.length : 0; };
    try {
      window.getPhoneData = function () { return rows.slice(); };
      window.clearGoals();
      window.handleAgentCommand('/goal 电话 A >=2');        // 阈值：≥2 条即提醒（关键词要用"值"，不能用字段名）
      window.handleAgentCommand('/goal 电话 A +2');         // 增量：本次新增 ≥2 才提醒
      window.checkGoals();                                  // 建基线（当前 1 条）
      var base = window.getGoals().map(function (g) { return { mode: (g.condition || {}).mode || 'increase', n: g.lastMatched }; });
      var n0 = hostCount();
      window.checkGoals();                                  // 无变化 → 都不应提醒
      var n1 = hostCount();
      rows.push({ 站名: '乙', 单位: 'A', 线名: 'L', 路电: '3', 市电: '4' });
      var gs = window.getGoals(); gs.forEach(function (g) { g.lastTriggered = new Date(Date.now() - 7 * 3600 * 1000).toISOString(); });
      localStorage.setItem('agent_active_goals', JSON.stringify(gs));
      window.checkGoals();                                  // 到 2 条：阈值触发；增量只 +1 < 2 不触发
      var n2 = hostCount();
      var notified = window.getGoals().map(function (g) { return { mode: (g.condition || {}).mode || 'increase', notified: g.lastNotifiedCount || 0 }; });
      var list = window.handleAgentCommand('/goals');
      window.clearGoals();
      return { base: base, d0: n1 - n0, d1: n2 - n1, notified: notified, listHasCond: /条件：/.test(list) };
    } finally { window.getPhoneData = oPhone; }
  })()`);

  // ---------- S. 工具结果短缓存（只读命中 / 可关闭）----------
  out.toolCache = await evalIn(`(async () => {
    var calls = 0, orig = window._agentGetIssues;
    window._agentGetIssues = function () { calls++; return orig.apply(this, arguments); };
    window.__agentToolCacheClear();
    var r1 = await window._agentRunTool('search_issues', { keyword: '调车', unit: '' });
    var c1 = calls;
    var r2 = await window._agentRunTool('search_issues', { keyword: '调车', unit: '' });
    var c2 = calls;
    window.__agentToolCacheTtlMs = 0;                      // 关闭缓存
    await window._agentRunTool('search_issues', { keyword: '调车', unit: '' });
    var c3 = calls;
    try { delete window.__agentToolCacheTtlMs; } catch (e) {}
    window._agentGetIssues = orig;
    return { c1: c1, c2: c2, c3: c3, note: (r2 && r2.缓存说明) || '', ok1: !!r1.ok, ok2: !!r2.ok };
  })()`);

  const R = out.reflect, C = out.count, T = out.trim;
  const fail = (ok, msg) => console.log((ok ? '  ✓ ' : '  ✗ ') + msg);
  console.log('\n========= 智能体审计优化 · 关键改动验证 =========');
  console.log('[A 结果预算] 100 条大列表 → items=' + T.items + '（≤50，结构保留）｜截断提示=' + T.hasNote + '｜total 保留=' + T.totalKeep + '｜超长单字段长度=' + T.strLen + '（≤~310）');
  console.log('[B 参数口径] 9月(月粒度)=' + C.sept + '｜9月(斜杠未补零)=' + C.septSlash + '｜9月(全日期)=' + C.septAll
    + '｜A类=' + C.natA + '｜红线=' + C.nat红 + '｜month分组=' + JSON.stringify(C.monthGrp) + '｜非法groupBy=' + (C.badGrp ? '已报错' : '未报错'));
  console.log('[C 反思契约] 请求轮次=' + JSON.stringify(R.reqs) + '｜最终回答=' + JSON.stringify(R.final) + '｜有反思卡=' + R.reflected + '｜执行中断=' + R.interrupted);
  console.log('[D 停止令牌] ' + JSON.stringify(out.token));
  console.log('\n断言：');
  fail(T.items > 0 && T.items <= 50 && T.hasNote && T.totalKeep === 100, 'A) 大列表保留结构并收缩 items（≤50）+ 口径字段 total 保留');
  fail(T.strLen <= 320, 'A2) 超长单字段被逐串截断（不把整包变成残缺字符串）');
  fail(C.sept === 15 && C.septSlash === 15 && C.septAll === 15, 'B) 日期归一：月粒度/斜杠/未补零 三种写法结果一致（原来会静默归零）');
  fail(C.natA === 5 && C.nat红 === 5, 'B2) 性质首字母/中文名匹配正确（A / 红线）');
  fail(C.monthGrp && C.monthGrp['2026-09'] === 15 && C.monthGrp['2026-08'] === 10, 'B3) month 分组=按月趋势一次拿到（新能力）');
  fail(!!C.badGrp, 'B4) 非法 groupBy 返回参数错误（原来静默全丢进 (未分类)）');
  fail(R.reflected && !R.interrupted && /A类 5 条/.test(R.final), 'C) 反思路径不再打断整轮：跳过重复调用后仍给出最终回答（原契约违反会 400）');
  fail(!R.reqs.some(x => x.breach), 'C2) 每轮请求的 tool_calls 与 tool 响应始终配对（无契约违反）');
  fail(out.token.increased, 'D) dsAgentStop 作废当前 run 令牌（停止对工具执行期也生效）');
  const M = out.mem, X = out.ctx, P = out.cap;
  console.log('\n[E 记忆] 历史注入含失败=' + /⚠️/.test(M.ctx) + '｜长度=' + M.ctxLen + '（≤600）｜学到的口径='
    + JSON.stringify({ 单位: Object.keys(M.view1.单位 || {}), 性质: Object.keys(M.view1.性质 || {}), 月份: Object.keys(M.view1.月份 || {}) })
    + '｜20 个单位后仍保留=' + M.unitCount + '（≤12）｜画像注入=' + JSON.stringify(M.pref.slice(0, 60)) + '｜统计=' + JSON.stringify(M.stats).slice(0, 140) + '｜清空生效=' + M.cleared);
  console.log('[F 上下文] 10 轮工具结果：' + X.before + ' → ' + X.after + ' 字符｜压缩=' + X.compacted + ' 条｜保留完整=' + X.keptFull + ' 条');
  console.log('[G 能力] 批量取全文=' + P.detailCount + ' 条｜导出=' + P.exportTotal + ' 条 / ' + P.fileName + ' / ' + JSON.stringify(P.dl));
  fail(/⚠️/.test(M.ctx) && M.ctxLen <= 600, 'E) 历史注入保留"失败/0命中"且有长度上限（原来丢失且无上限）');
  fail(Object.keys(M.view1.性质 || {}).length > 0 && Object.keys(M.view1.月份 || {}).length > 0, 'E2) 学到 count_issues 的统计口径（性质/月份）');
  fail(M.unitCount <= 12 && M.unitCount > 0, 'E3) 画像各维度有上限（20 → ≤12）');
  fail(M.stats && M.stats.任务数 >= 1 && Array.isArray(M.stats.失败最多的工具), 'E4) 任务统计可读（成功率/失败最多工具）');
  fail(M.cleared, 'E5) 偏好画像可清空（新增入口）');
  fail(X.compacted > 0 && X.keptFull === 6 && X.after < X.before, 'F) 上下文预算：更早的工具结果压缩为一行、最近 6 条保留完整');
  fail(P.detailCount === 3, 'G) 批量取全文工具可用（一次 3 条）');
  fail(P.exportTotal > 0 && /\.csv$/.test(P.fileName) && P.dl && P.dl.size > 0, 'G2) CSV 导出工具可用（文件已生成并交给下载器）');
  const O = out.timeout, V = out.vision, G = out.goals, K = out.cache;
  console.log('\n[H 工具超时] ' + JSON.stringify(O) + '（上限设 300ms 验证）');
  console.log('[I /agent 图片] 有请求=' + V.hasRequest + '｜请求数=' + V.capLen + '｜模型=' + V.model + '｜多模态数组=' + V.isArray + '｜含 image_url=' + V.hasImg
    + '｜附件已清空=' + V.attachCleared + '｜vision 已释放=' + V.visionCleared + '｜末条用户=' + JSON.stringify(V.lastUser) + '｜末条回答=' + JSON.stringify(V.lastAsst));
  console.log('[J 目标提醒] 加目标=' + JSON.stringify(G.add) + '｜冷却中弹窗=' + (G.nCool - G.n0) + '（应 0）｜冷却后弹窗=' + (G.nExpire - G.nCool)
    + '（应 1）｜同计数再查=' + (G.nAgain - G.nExpire) + '（应 0）｜已记录条数=' + G.notified
    + '｜列表含删除提示=' + G.listHasHint + '｜删除=' + JSON.stringify(G.rm) + '｜删后列表=' + JSON.stringify(G.listAfter));
  console.log('[K 语义缓存] 清空入口=' + K.hasClear + '｜已挂到数据变更钩子=' + K.hooked + '｜ENABLE_UNIFIED=' + K.enableUnified
    + '｜第2次命中缓存=' + K.secondFromCache + '｜清空后仍命中=' + K.afterClearFromCache
    + '\n    a1=' + JSON.stringify(K.a1) + '\n    a2=' + JSON.stringify(K.a2) + '｜本轮用过工具=' + K.usedToolsFlag);
  fail(O.ok === false && /超时/.test(O.err) && O.ms < 2000, 'H) 工具通用超时生效（挂住的工具按失败返回，不再卡死整轮）');
  fail(V.hasRequest && V.isArray && V.hasImg, 'I) 对话内 /agent 会把附件图片一并交给智能体（原为 null → 看不到图）');
  fail(V.attachCleared && V.visionCleared, 'I2) 附件用后即清、vision 内容 run 结束释放（原来常驻内存）');
  fail((G.nCool - G.n0) === 0 && (G.nExpire - G.nCool) >= 1 && (G.nAgain - G.nExpire) === 0 && G.notified > 0,
    'J) 目标提醒：冷却内不弹 / 冷却后弹一次 / 同计数不重复弹');
  fail(G.listHasHint && /已删除/.test(G.rm), 'J2) /goal-remove 入口可用（+列表带删除提示；原来只能清空全部）');
  fail(K.hasClear && K.hooked && K.secondFromCache && !K.afterClearFromCache,
    'K) 语义缓存可清空且已挂到数据变更钩子（清空后不再命中）');
  const L = out.goals2, MR = out.retry;
  console.log('\n[L 多类型盯控] 加目标(规章)=' + JSON.stringify(L.r1) + '｜加目标(日志)=' + JSON.stringify(L.r2)
    + '\n    基线=' + JSON.stringify(L.base) + '\n    增量后=' + JSON.stringify(L.after)
    + '｜列表含类型标签=' + L.listHasRule + '/' + L.listHasDiary);
  console.log('[M 重试策略] 只读首次失败→' + JSON.stringify({ ok: MR.ok1, note: MR.note1, 调用次数: MR.callsReadOnly })
    + '｜写库失败→' + JSON.stringify({ ok: MR.ok2, 调用次数: MR.wcalls, err: MR.err2 })
    + '｜覆盖为 0 →' + JSON.stringify({ ok: MR.ok3, 调用次数: MR.callsOverride, err: MR.err3 }));
  fail(L.listHasRule && L.listHasDiary && L.base.length === 2 && L.base.every(function (b) { return b.based; }),
    'L) 盯控支持 规章制度/工作日志 类型（列表带类型标签，首轮只建基线）');
  fail(L.after.length === 2 && L.after.every(function (a) { return a.n > 0 && a.notified > 0; }) && /已添加盯控目标/.test(L.r1),
    'L2) 两类型都能匹配到增量并触发提醒（原来只有检查信息类型）');
  fail(MR.ok1 === true && MR.callsReadOnly === 2 && /重试/.test(MR.note1), 'M) 只读工具瞬时失败会自动重试一次并成功');
  fail(MR.ok2 === false && MR.wcalls === 1, 'M2) 写库类工具失败**不重试**（避免重复写入）');
  fail(MR.ok3 === false && MR.callsOverride === 1, 'M3) 重试次数可用 __agentToolRetry 覆盖（设 0 → 只调用 1 次，不重试）');
  const NT = out.ttl, O3 = out.goals3, PR = out.progress;
  console.log('\n[N 缓存 TTL] 覆盖 ds_sem_cache_ttl_min=0（关闭缓存）→ 第2次仍命中缓存=' + NT.fromCache + '（应 false）｜首答=' + JSON.stringify(NT.a1));
  console.log('[O 电话/待办盯控] 加目标=' + JSON.stringify(O3.r1) + ' / ' + JSON.stringify(O3.r2)
    + '\n    基线=' + JSON.stringify(O3.base) + ' → 增量后=' + JSON.stringify(O3.after)
    + '｜列表标签=' + O3.listHasPhone + '/' + O3.listHasMemo + '｜memo 接口可用=' + O3.hasAccessor);
  console.log('[P 工具进度] 心跳事件=' + PR.n + ' 次｜首次=' + JSON.stringify(PR.first) + '｜末次=' + JSON.stringify(PR.last) + '｜run 后已清理=' + PR.cleared);
  fail(NT.fromCache === false, 'N) 缓存 TTL 可配置且生效（覆盖为 0 → 不复用缓存）');
  fail(O3.hasAccessor && JSON.stringify(O3.base) === '["phone","memo"]' && O3.after.length === 2
    && O3.after.every(function (a) { return a.n > 0 && a.notified > 0; }) && O3.listHasPhone && O3.listHasMemo,
    'O) 盯控扩到 应急电话 / 待办备忘（含 memo 只读接口、列表标签、两类均触发）');
  fail(PR.n >= 2 && PR.first && PR.first.tool === 'export_issues' && /CSV/.test(PR.first.text || '') && PR.cleared,
    'P) 慢工具有分段进度（≥2 次心跳 + 阶段文案 + run 结束清理）');
  const BD = out.budget, MD = out.modes, TC = out.toolCache;
  console.log('\n[Q 工具总预算] 慢工具调用=' + BD.exportCalls + ' 次｜被预算拦下的检索调用=' + BD.searchCalls + ' 次（应 0）'
    + '\n    回灌文案=' + JSON.stringify(BD.skippedMsg) + '｜最终回答=' + JSON.stringify(BD.final));
  console.log('[R 比较方式] 基线=' + JSON.stringify(MD.base) + '｜无变化新增提醒=' + MD.d0 + '（应 0）｜到 2 条时新增提醒=' + MD.d1
    + '（应 1：仅阈值触发）｜各目标已提醒值=' + JSON.stringify(MD.notified) + '｜列表含条件=' + MD.listHasCond);
  console.log('[S 工具结果缓存] 第1次调用=' + TC.c1 + ' / 第2次累计=' + TC.c2 + '（应仍 1：命中缓存） / 关闭缓存后累计=' + TC.c3
    + '（应 2）｜缓存说明=' + JSON.stringify(TC.note));
  fail(BD.exportCalls === 1 && BD.searchCalls === 0 && /总预算/.test(BD.skippedMsg) && /预算内作答/.test(BD.final),
    'Q) 工具总预算生效：超预算后不再执行新工具，按"未执行"回灌并让模型作答');
  fail(MD.d0 === 0 && MD.d1 === 1 && MD.listHasCond
    && MD.notified.some(function (x) { return x.mode === 'threshold' && x.notified === 2; })
    && MD.notified.some(function (x) { return x.mode === 'delta' && !x.notified; }),
    'R) 盯控比较方式：阈值≥2 触发、增量+2 未达不触发、列表显示条件');
  fail(TC.ok1 && TC.ok2 && TC.c1 === 1 && TC.c2 === 1 && TC.c3 === 2 && /缓存/.test(TC.note),
    'S) 只读工具结果短缓存：同参第二次命中缓存、可用 __agentToolCacheTtlMs=0 关闭');
  try { child.kill(); } catch (e) {}
  server.close(); process.exit(0);
}
main().catch((e) => { console.error('探针异常:', e && e.message); process.exit(1); });
