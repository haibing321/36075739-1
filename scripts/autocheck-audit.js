// 「智能对规」取证脚本（可复用）：拦 fetch 造 AI 响应，逐条固化"关键词 / 专业 / 召回 / 排序 / 兜底"的行为
//   用途：改 smart-check.js 的对规链路、或改 rule.js 的 generateRuleSnippet / calculateMatchScore 后跑一次
//   用法：node scripts/autocheck-audit.js
// 覆盖（2026-09-18 A~D 修复）：
//   S1 A：本地保底「相关规章制度」——多关键词跨段时 OR 必须能命中（修复前恒为 0 条）
//   S2 A：OR 评分——命中关键词多的条款排在命中少的之前（修复前 OR 分数恒为 0，排序失效）
//   S3 B：词库零命中不再 alert 拦截，AI 主链路照常发起
//   S4 C：AI 返回"都不相关"时改走本地保底（修复前直接结束、没有任何参考）
//   S5 D：检查手册不得当规章依据（AI 候选里被剔除 + 回执说明）
//   S6 加载耗时：点击→本地召回→发出请求→结论渲染 分段计时；并打印请求体里的思考/预算参数（判断真实等待的杠杆）
const http = require('http'); const fs = require('fs'); const path = require('path'); const os = require('os');
const { spawn } = require('child_process');
const ROOT = path.resolve(__dirname, '..'), PORT = 8132, CDP_PORT = 9342;
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.woff2': 'font/woff2' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
class CDP {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); this.listeners = [];
    ws.addEventListener('message', (ev) => { let m; try { m = JSON.parse(ev.data); } catch (e) { return; }
      if (m.id && this.pending.has(m.id)) { const p = this.pending.get(this.id && m.id); this.pending.delete(m.id); m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result); }
      else if (m.method) this.listeners.forEach((f) => f(m)); }); }
  send(method, params = {}, sessionId) { const id = ++this.id; const payload = { id, method, params }; if (sessionId) payload.sessionId = sessionId;
    this.ws.send(JSON.stringify(payload));
    return new Promise((res, rej) => { this.pending.set(id, { resolve: res, reject: rej }); setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); rej(new Error('timeout ' + method)); } }, 180000); }); }
  waitEvent(method, t = 60000, sessionId) { return new Promise((res, rej) => { const tm = setTimeout(() => rej(new Error('ev timeout ' + method)), t);
    const fn = (m) => { if (m.method === method && (!sessionId || m.sessionId === sessionId)) { clearTimeout(tm); this.listeners = this.listeners.filter((x) => x !== fn); res(m.params); } }; this.listeners.push(fn); }); }
}

// 规章种子：① 电务测试规章A（信号机在一段、电缆在另一段 → 只有 OR 能命中）
//          ② 电务单命中规章C（只含"信号机"）③ 电务双命中规章D（两个词在同一段 → AND）
//          ④ 工务规章B（一个词都不含）⑤ 安全检查手册3（被误导入规章表，应被剔除）
const RULES = [
  { trade: '电务', title: '电务测试规章A', content: '第一条 信号机显示不良时，应及时检查灯丝与点灯电路。\n第二条 轨道电路送、受端电缆应按照调整表要求补偿到规定长度。' },
  { trade: '电务', title: '电务单命中规章C', content: '第三条 信号机灯丝断丝时应立即更换并登记。' },
  { trade: '电务', title: '电务双命中规章D', content: '第四条 信号机与电缆环阻测试应按周期开展，测试数据应真实准确。' },
  { trade: '工务', title: '工务规章B', content: '第五条 线路几何尺寸超限时应立即整修。' },
  { trade: '通用', title: '安全检查手册3', content: '4.1 信号机与电缆检查项点：灯丝、电缆环阻、测试数据。' }
];
const ISSUES = [
  { id: 9501, '性质': 'B类', category: '电务', content: '信号机显示不良，电缆环阻测试数据未核对', regulation: '不符合《电务测试规章A》第1条“信号机显示不良时，应及时检查灯丝与点灯电路”的规定。', unit: '甲站', datetime: '2026-03-05 09:10:00' }
];

const FAKE_SEL = JSON.stringify({ correctedQuery: '信号机与电缆环阻测试数据未核对', selectedIds: ['cand_0'], reason: '直接对应' });
const FAKE_NONE = JSON.stringify({ correctedQuery: '信号机与电缆环阻测试数据未核对', selectedIds: [], reason: '无相关条款' });

async function main() {
  const profileDir = path.join(os.tmpdir(), 'aj-audit-ac-' + Date.now());
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
  const results = [];
  const check = (name, ok, extra) => { results.push({ name, ok: !!ok, extra: extra === undefined ? '' : String(extra) }); console.log((ok ? '  ✅ ' : '  ❌ ') + name + (extra !== undefined && extra !== '' ? '  «' + extra + '»' : '')); };

  // ---------- 造数据 ----------
  await nav(base + '?seed=1'); await sleep(1200);
  console.log('seed:', await evalIn(`(async () => {
    const open=(n,v,u)=>new Promise((res,rej)=>{const r=indexedDB.open(n,v);r.onupgradeneeded=e=>u&&u(e.target.result);r.onsuccess=()=>res(r.result);r.onerror=()=>rej(r.error);});
    const bulk=(db,s,a)=>new Promise((res,rej)=>{const tx=db.transaction(s,'readwrite');const st=tx.objectStore(s);st.clear();a.forEach(x=>st.put(x));tx.oncomplete=res;tx.onerror=()=>rej(tx.error);});
    const rdb=await open('RailwayRuleDB',3,db=>{if(!db.objectStoreNames.contains('ruleCollection'))db.createObjectStore('ruleCollection',{keyPath:'id',autoIncrement:true});});
    await bulk(rdb,'ruleCollection',[{id:1,initialized:true,data:${JSON.stringify(RULES)}}]);
    const idb=await open('RailwayIssueDB_v2',3,db=>{if(!db.objectStoreNames.contains('issues'))db.createObjectStore('issues',{keyPath:'id',autoIncrement:true});});
    await bulk(idb,'issues',${JSON.stringify(ISSUES)});
    localStorage.setItem('ds_api_key_v1','sk-audit');
    localStorage.setItem('ds_api_url_v1','https://api.deepseek.com/chat/completions');
    localStorage.setItem('ds_model_v1','deepseek-flash');
    return 'ok';
  })()`));

  await nav(base + '?run=1'); await sleep(3000);

  // ---------- 安装 fetch 拦截 + 辅助 ----------
  console.log('install:', await evalIn(`(() => {
    window.__cap = []; window.__fakeReply = ${JSON.stringify(FAKE_SEL)}; window.__alerts = [];
    window.__origFetch = window.__origFetch || window.fetch;
    window.fetch = async function(url, opt) {
      try {
        if (opt && opt.method === 'POST' && typeof opt.body === 'string') {
          const body = JSON.parse(opt.body);
          const sys = (body.messages.filter(m => m.role === 'system')[0] || {}).content || '';
          if (/铁路安监对规专家/.test(sys)) {
            window.__cap.push({
              sys: sys, usr: (body.messages.filter(m => m.role === 'user')[0] || {}).content || '',
              // 【S6 耗时取证用】请求发出时刻（与页面 performance.now() 同一时基）+ 影响延迟的请求参数
              t: performance.now(), thinking: body.thinking || null, effort: body.reasoning_effort || null,
              maxTokens: body.max_tokens || 0, stream: !!body.stream, model: body.model || ''
            });
            // __fakeDelay：模拟"慢模型"，用于在 AI 等待期抓界面状态（S6 的 B 断言）
            if (window.__fakeDelay) await new Promise(r => setTimeout(r, window.__fakeDelay));
            return new Response(JSON.stringify({ choices: [{ message: { content: window.__fakeReply } }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
          }
        }
      } catch (e) { console.warn('cap err', e); }
      return window.__origFetch.apply(this, arguments);
    };
    window.alert = function (m) { window.__alerts.push(String(m || '')); };
    window.confirm = function () { return true; };
    window.__capN = function () { return window.__cap.length; };
    window.__lastCap = function () { return window.__cap[window.__cap.length - 1] || {}; };
    window.__res = function () { var el = document.getElementById('autoCheck-results'); return el ? el.textContent : ''; };
    window.__resHtml = function () { var el = document.getElementById('autoCheck-results'); return el ? el.innerHTML : ''; };
    window.__setQuery = function (t) { var el = document.getElementById('autoCheck-input'); if (el) el.value = t; };
    window.__addKw = function (k) { var el = document.getElementById('keyword-custom-input'); if (el) el.value = k; window.acAddCustomKeyword(); };
    window.__clearKw = function () { window.acClearSelectedKeywords(); };
    return 'ok';
  })()`));

  console.log('rules loaded:', await evalIn(`(typeof window.getRulesData === 'function') ? window.getRulesData().length : -1`));

  // ---------- S1+S2 A：本地保底 OR 匹配与 OR 评分 ----------
  console.log('\n==== S1/S2 A：本地保底「相关规章制度」OR 匹配 + 命中数排序 ====');
  {
    const r = await evalIn(`(async () => {
      window.__clearKw();
      window.__setQuery('信号机显示不良，电缆环阻测试数据未核对');
      window.__addKw('信号机'); window.__addKw('电缆');
      window.autoCheckLocal();
      await new Promise(r => setTimeout(r, 1200));
      var html = window.__resHtml();
      // ⚠️ 只取「⚖️ 相关规章条款」区块：案例卡片里也会出现《电务测试规章A》（它是案例引用的规章），
      //    整页 indexOf 会把案例区的命中当成规章区的命中，排序断言就失真了
      var rs = html.indexOf('⚖️ 相关规章条款');
      var sec = rs >= 0 ? html.slice(rs) : '';
      return {
        hasSec: rs >= 0,
        hasA: sec.indexOf('电务测试规章A') !== -1,
        hasC: sec.indexOf('电务单命中规章C') !== -1,
        hasD: sec.indexOf('电务双命中规章D') !== -1,
        hasB: sec.indexOf('工务规章B') !== -1,
        hasHb: html.indexOf('安全检查手册3') !== -1,
        // 短段落走的是"裸 <p> + 高亮"分支（rule-match-para 只在长/中段落出现），故直接看命中段落正文
        snippet: /信号机显示不良时|信号机与电缆环阻/.test(sec),
        iA: sec.indexOf('电务测试规章A'), iC: sec.indexOf('电务单命中规章C'), iD: sec.indexOf('电务双命中规章D'),
        // ⚠️ 证据：保底走的是"关键词覆盖率兜底"分支（generateRuleSnippet 是 rule.js 的私有函数，
        //    smart-check 里 typeof 守卫为 false），所以 mode 全是 or、分数 = 命中词数/总词数
        dbg: (window._lastACRules || []).map(function (x) { return (x.rule && x.rule.title) + '/' + x.mode + '/' + (Math.round((x.matchScore || 0) * 100) / 100); })
      };
    })()`);
    // 修复前：AND 恒为真 → A（两词跨段）与 C（只一个词）都进不了榜，规章区块恒空
    check('「相关规章条款」区块存在', r.hasSec);
    check('关键词跨段的规章能进结果（覆盖率兜底分支）', r.hasA, 'A=' + r.hasA + ' C=' + r.hasC + ' D=' + r.hasD);
    check('两个关键词都命中的规章也在结果里', r.hasD);
    // 如实固化当前实现：generateRuleSnippet 是 rule.js 的私有函数 → smart-check 的 typeof 守卫为 false
    // → 保底一律走"覆盖率兜底"（mode 全 or）。若哪天把它暴露出来，这条会红，正好提醒重估。
    check('【实况固化】保底模式全为 or（generateRuleSnippet 未暴露给 smart-check）',
      (r.dbg || []).length > 0 && (r.dbg || []).every(function (s) { return /\/or\//.test(s); }), (r.dbg || []).join(' , '));
    check('完全无关的规章不进结果', !r.hasB);
    check('结果卡片带出规章内容', r.snippet);
    check('覆盖率排序：命中 2 词的排在命中 1 词的之前', r.iA >= 0 && r.iC >= 0 && r.iA < r.iC, 'A@' + r.iA + ' C@' + r.iC + ' D@' + r.iD);
    console.log('    [证据] 保底模式/分数 = ' + (r.dbg || []).join(' , '));
    // 手册在保底路径同样不能被当规章列出来
    check('保底路径也不把检查手册当规章（D）', !r.hasHb);
  }

  // ---------- S3 B：词库零命中不再拦截 ----------
  console.log('\n==== S3 B：词库零命中 → 不 alert 拦截，AI 主链路照常发起 ====');
  {
    const r = await evalIn(`(async () => {
      window.__clearKw(); window.__cap = []; window.__alerts = [];
      window.__setQuery('猩猩面包沙发');                 // 词库不会有这些词
      window.__fakeReply = ${JSON.stringify(FAKE_SEL)};
      await window.autoCheckSmart();
      await new Promise(r => setTimeout(r, 800));
      return { capN: window.__capN(), alerts: window.__alerts.slice(), res: window.__res().slice(0, 120) };
    })()`);
    check('未提取到关键词时不再弹 alert 拦截（修复前会 alert 并 return）', r.alerts.length === 0, JSON.stringify(r.alerts));
    check('AI 主链路照常发起（关键词本来就不参与主链路）', r.capN >= 1, '请求数=' + r.capN);
  }

  // ---------- S4 C：AI 说"都不相关" → 本地保底 ----------
  console.log('\n==== S4 C：AI 返回空 selectedIds → 自动改走本地保底 ====');
  {
    const r = await evalIn(`(async () => {
      window.__clearKw(); window.__cap = [];
      window.__setQuery('信号机显示不良，电缆环阻测试数据未核对');
      window.__addKw('信号机'); window.__addKw('电缆');
      window.__fakeReply = ${JSON.stringify(FAKE_NONE)};   // AI：都不相关
      await window.autoCheckSmart();
      await new Promise(r => setTimeout(r, 1500));
      var t = window.__res();
      return { fallback: /已自动改用「本地对规」保底/.test(t), reason: /AI 认为候选条款均不相关/.test(t),
               hasRule: t.indexOf('电务测试规章A') !== -1, res: t.slice(0, 140) };
    })()`);
    check('AI 说都不相关时触发本地保底（修复前直接结束）', r.fallback);
    check('保底原因写明"AI 认为候选条款均不相关"', r.reason);
    check('保底真的给出了规章结果（不是空壳）', r.hasRule, (r.res || '').replace(/\\s+/g, ' ').slice(0, 100));
  }

  // ---------- S5 D：手册不得当规章依据（AI 候选） ----------
  console.log('\n==== S5 D：检查手册不得进 AI 候选（并在回执说明） ====');
  {
    const r = await evalIn(`(async () => {
      window.__clearKw(); window.__cap = [];
      window.__setQuery('信号机与电缆环阻测试数据未核对');
      window.__fakeReply = ${JSON.stringify(FAKE_SEL)};
      await window.autoCheckSmart();
      await new Promise(r => setTimeout(r, 1200));
      var cap = window.__lastCap() || {};
      var t = window.__res();
      return { sysHasHb: /手册/.test(cap.sys || ''), sysHasRule: /电务测试规章A|电务双命中规章D/.test(cap.sys || ''),
               notice: /已排除 \\d+ 条检查手册/.test(t), capN: window.__capN(), res: t.slice(0, 120) };
    })()`);
    check('AI 候选里没有检查手册（修复前会作为 [规章库] 候选）', !r.sysHasHb);
    check('AI 候选里仍有真正的规章条款', r.sysHasRule);
    check('回执说明"已排除 N 条检查手册"', r.notice, (r.res || '').replace(/\\s+/g, ' ').slice(0, 100));
  }

  // ---------- S6 加载过程耗时：本地召回段 / 渲染段 拆解（AI 用假响应，故 AI 时间为 0） ----------
  console.log('\n==== S6 加载过程耗时：点击 → 本地召回 → 发出请求 → 结论渲染 ====');
  {
    const r = await evalIn(`(async () => {
      async function runOnce(tag) {
        window.__clearKw(); window.__setQuery('信号机显示不良，电缆环阻测试数据未核对');
        window.__addKw('信号机'); window.__addKw('电缆');
        window.__cap = [];
        var c = document.getElementById('autoCheck-results'); if (c) c.innerHTML = '';
        var t0 = performance.now();
        var p = window.autoCheckSmart();                       // 故意不 await：按时间点采样
        var w1 = 0; while (w1 < 30000 && !window.__capN()) { await new Promise(r => setTimeout(r, 10)); w1 += 10; }
        var tReq = performance.now();
        var w2 = 0; while (w2 < 30000 && !document.getElementById('ac-conclusion-card')) { await new Promise(r => setTimeout(r, 10)); w2 += 10; }
        var tDone = performance.now();
        try { await p; } catch (e) {}
        var cap = window.__lastCap() || {};
        return { tag: tag, localMs: Math.round(tReq - t0), renderMs: Math.round(tDone - tReq), totalMs: Math.round(tDone - t0),
                 capN: window.__capN(), hasCard: !!document.getElementById('ac-conclusion-card'),
                 thinking: cap.thinking, effort: cap.effort, maxTokens: cap.maxTokens, stream: cap.stream, model: cap.model };
      }
      var stats = (typeof window.KB.stats === 'function') ? window.KB.stats() : null;
      var warm = await runOnce('热');
      // 冷路径：关自动载入 + 让两源失效 → 下次点击必须现场建索引（本地段耗时会体现建索引代价）
      try { if (window.KB.setAutoLoad) window.KB.setAutoLoad(false); } catch (e) {}
      try { if (window.KB.invalidate) { window.KB.invalidate('rules'); window.KB.invalidate('issues'); } } catch (e) {}
      var cold = await runOnce('冷');
      try { if (window.KB.setAutoLoad) window.KB.setAutoLoad(true); } catch (e) {}
      // 等待期进度（B）：给假响应加延迟，抓"AI 计算中"那一刻的界面文字
      var waitProbe = '';
      window.__clearKw(); window.__setQuery('信号机显示不良，电缆环阻测试数据未核对');
      window.__addKw('信号机'); window.__addKw('电缆');
      window.__cap = []; window.__fakeDelay = 700;
      var c2 = document.getElementById('autoCheck-results'); if (c2) c2.innerHTML = '';
      var p2 = window.autoCheckSmart();
      await new Promise(r => setTimeout(r, 350));
      var waitEl = document.getElementById('ac-ai-wait');
      waitProbe = waitEl ? waitEl.textContent : '';
      try { await p2; } catch (e) {}
      window.__fakeDelay = 0;
      return { stats: stats, warm: warm, cold: cold, waitProbe: waitProbe };
    })()`);
    const w = r.warm || {}, c = r.cold || {};
    console.log('  热：本地召回 ' + w.localMs + 'ms ／ 渲染+收尾 ' + w.renderMs + 'ms ／ 合计 ' + w.totalMs + 'ms');
    console.log('  冷：本地召回 ' + c.localMs + 'ms ／ 渲染+收尾 ' + c.renderMs + 'ms ／ 合计 ' + c.totalMs + 'ms（索引失效后现场重建）');
    console.log('  AI 请求参数（决定真实等待时长）：' + JSON.stringify({
      model: w.model, thinking: w.thinking, effort: w.effort, maxTokens: w.maxTokens, stream: w.stream
    }));
    console.log('  KB 各源状态：' + JSON.stringify(r.stats).slice(0, 420));
    check('热路径：点击→发出请求（本地召回段，不含 AI）在 2s 内', w.localMs > 0 && w.localMs < 2000, w.localMs + 'ms');
    check('热路径：请求→结论渲染完成在 1.5s 内', w.renderMs >= 0 && w.renderMs < 1500, w.renderMs + 'ms');
    check('一次点击只发 1 次 AI 请求（非流式）', w.capN === 1 && w.stream === false, 'capN=' + w.capN + ' stream=' + w.stream);
    check('冷路径（索引重建）也能跑通并渲染结论', c.hasCard === true && c.capN === 1, '冷合计 ' + c.totalMs + 'ms');
    check('两轮都渲染出结论卡片', w.hasCard === true && c.hasCard === true);
    check('A：请求体已关思考（thinking.type=disabled，且不再带 reasoning_effort）',
      !!(w.thinking && w.thinking.type === 'disabled') && !w.effort, JSON.stringify({ thinking: w.thinking, effort: w.effort }));
    check('B：AI 等待期显示「已等 Ns + 已召回 N 条候选」',
      /已等\s*\d+s/.test(r.waitProbe || '') && /已召回\s*\d+\s*条候选/.test(r.waitProbe || ''), (r.waitProbe || '').slice(0, 90));
  }

  const pass = results.filter(r => r.ok).length;
  console.log('\n==== 汇总：' + pass + '/' + results.length + ' 通过 ====');
  results.filter(r => !r.ok).forEach(r => console.log('  ❌ ' + r.name + '  «' + r.extra + '»'));
  ws.close(); child.kill(); server.close();
  process.exit(pass === results.length ? 0 : 1);
}
main().catch(e => { console.log('失败:', e && e.message ? e.message : e); process.exit(1); });
