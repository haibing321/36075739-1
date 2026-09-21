// 智能体工具取证脚本（可复用）：**不调模型**，直接跑单个工具并断言返回
//   用途：改 agent-core.js 的工具（尤其 autocheck 对规工具）后跑一次
//   用法：node scripts/agent-tool-audit.js
// 设计说明（踩过的坑）：
//   ⚠️ 本应用**内置示例数据**（issue.js / rule.js 里就带），且 KB 索引在页面加载时就建好了，
//      外部往 IndexedDB 里 seed 的记录**进不了已建的索引**。所以断言分两段：
//      · T1 桩替 window.acRecallCandidates → 完全确定性地验工具的映射/过滤/结论式；
//      · T2 真实召回 → 只验"与具体数据无关"的不变量（不改数据结构、不出伪依据）。
// 覆盖：
//   T1 autocheck 映射：案例占位标题兜底、正文剥前缀、条号从正文补、手册剔除、正文空壳剔除、limit
//   T2 真实召回不变量：字段齐全、结论式句式、正文可用、手册/占位名不进候选
//   T3 参数校验（缺 query / limit 上限）与未知工具
const http = require('http'); const fs = require('fs'); const path = require('path'); const os = require('os');
const { spawn } = require('child_process');
const ROOT = path.resolve(__dirname, '..'), PORT = 8142, CDP_PORT = 9352;
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
  const profileDir = path.join(os.tmpdir(), 'aj-audit-agent-' + Date.now());
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
    if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 600)); return r.result.value; };
  const nav = async (u) => { const p = cdp.waitEvent('Page.loadEventFired', 60000, sessionId); await S('Page.navigate', { url: u }); await p; };
  const base = 'http://127.0.0.1:' + PORT + '/index.html';
  const results = [];
  const check = (name, ok, extra) => { results.push({ name, ok: !!ok, extra: extra === undefined ? '' : String(extra) }); console.log((ok ? '  ✅ ' : '  ❌ ') + name + (extra !== undefined && extra !== '' ? '  «' + extra + '»' : '')); };

  await nav(base + '?audit=agent'); await sleep(1200);

  // ---------- T1 桩数据：映射 / 过滤 / 结论式（确定性） ----------
  console.log('\n==== T1 autocheck 映射与过滤（桩替对规召回，确定性） ====');
  {
    const boot = await evalIn(`(() => ({ hasRecall: typeof window.acRecallCandidates === 'function', hasTool: typeof window._agentRunTool === 'function' }))()`);
    check('对规召回与智能体工具均已就绪', boot.hasRecall && boot.hasTool, JSON.stringify(boot));

    const tool = await evalIn(`(async () => {
      var real = window.acRecallCandidates;
      window.acRecallCandidates = async function () {
        return { recallSrc: '桩：统一检索层', items: [
          // ① 案例「策略2 降级」占位标题，但引用句里有《法规》→ 兜底出真名 + 正文剥前缀 + 条号从正文补 9
          { source:'issue', title:'历史案例参考', article:'', clause:'违反《铁路技术管理规程》第9条：调车作业必须确认信号。' },
          // ② 案例占位且正文无《》→ 丢弃
          { source:'issue', title:'历史案例参考', article:'', clause:'[调车] [B类] 调车作业中未确认信号，存在安全隐患' },
          // ③ 手册 → 剔除并计数
          { source:'rule', title:'安全检查手册3', article:'4.1', clause:'4.1 调车作业检查项点：确认信号', kbPath:'规章/手册' },
          // ④ 正常规章：阿拉伯条号 → 第4.3.4条
          { source:'rule', title:'高速铁路信号维护规则技术标准', article:'4.3.4', clause:'4.3.4 轨道电路送、受端电缆应按照调整表要求补偿到规定长度。', body:'轨道电路送、受端电缆应按照调整表要求补偿到规定长度', articleNo:'4.3.4' },
          // ⑤ 正常规章：中文条号 → 第12条
          { source:'rule', title:'铁路信号维护规则', article:'第十二条', clause:'第十二条 信号机灯丝断丝时应立即更换，并登记故障处理情况。', body:'信号机灯丝断丝时应立即更换，并登记故障处理情况', articleNo:'12' },
          // ⑥ 正文空壳（只剩条号）→ 丢弃，否则会写出「不符合《空壳规章》“第XX条”的规定。」
          { source:'rule', title:'空壳规章', article:'', clause:'不符合《空壳规章》第XX条的规定。', body:'第XX条', articleNo:'' }
        ] };
      };
      var out;
      try { out = await window._agentRunTool('autocheck', { query: '桩' }); } finally { window.acRecallCandidates = real; }
      return out;
    })()`);
    const t = (tool && tool.result) || {};
    const ti = t.items || [];
    check('桩数据：仅 3 条有效（1 案例兜底 + 2 规章）；占位/手册/空壳各被剔除',
      tool && tool.ok === true && ti.length === 3, '实际 ' + ti.length + '：' + ti.map((x) => x.法规名称).join(' | '));
    check('案例占位标题兜底成真名 + 来源标注正确',
      !!ti[0] && ti[0].法规名称 === '铁路技术管理规程' && ti[0].来源 === '历史案例已引用',
      ti[0] ? (ti[0].法规名称 + ' / ' + ti[0].来源) : '无候选');
    check('案例正文剥掉"违反《X》第9条："前缀', !!ti[0] && ti[0].条款原文 === '调车作业必须确认信号', ti[0] ? ti[0].条款原文 : '');
    check('条号从正文补出并归一为「第9条」', !!ti[0] && ti[0].条号 === '第9条', ti[0] ? ti[0].条号 : '');
    check('结论式 = 不符合《X》第9条“原文”的规定。',
      !!ti[0] && ti[0].结论式 === '不符合《铁路技术管理规程》第9条“调车作业必须确认信号”的规定。', ti[0] ? ti[0].结论式 : '');
    check('阿拉伯/中文条号分别归一为 第4.3.4条 / 第12条',
      ti.some((x) => x.条号 === '第4.3.4条') && ti.some((x) => x.条号 === '第12条'), ti.map((x) => x.条号).join(','));
    check('手册被剔除并给出统计提醒', /已剔除 1 条检查手册/.test(t['口径提醒'] || ''), t['口径提醒'] || '(无提醒)');
    check('空壳正文（第XX条）未成文', JSON.stringify(ti).indexOf('第XX条') === -1);

    const lim = await evalIn(`(async () => {
      var real2 = window.acRecallCandidates;
      window.acRecallCandidates = async function () {
        return { items: [1,2,3,4].map(function (i) { return { source:'rule', title:'T' + i, article:'第' + i + '条', clause:'条款内容' + i + '不得改写', body:'条款内容' + i + '不得改写', articleNo:String(i) }; }) };
      };
      var o; try { o = await window._agentRunTool('autocheck', { query:'桩', limit: 2 }); } finally { window.acRecallCandidates = real2; }
      return (o.result || {}).items || [];
    })()`);
    check('limit 生效（4 条候选只取 2）', lim.length === 2, '实际 ' + lim.length);
  }

  // ---------- T2 真实召回：只验不变量（与具体数据无关） ----------
  console.log('\n==== T2 autocheck 真实召回（不变量：字段/句式/无伪依据） ====');
  {
    const r = await evalIn(`(async () => {
      var rec = await window.acRecallCandidates('调车作业中未确认信号，存在安全隐患', {});
      var tool = await window._agentRunTool('autocheck', { query: '调车作业中未确认信号，存在安全隐患' });
      var toolHb = await window._agentRunTool('autocheck', { query: '调车作业检查项点 确认信号 一度停车' });
      return { n: (rec.items || []).length, items: rec.items || [], src: rec.recallSrc || '', tool: tool, toolHb: toolHb };
    })()`);
    check('对规召回有候选（走 KB 统一检索层）', r.n > 0, '共 ' + r.n + ' 条 / 来源 ' + r.src);
    check('items 每条都带可用正文+条号字段，且正文不是空壳（只剩余条号）',
      r.n > 0 && r.items.every((i) => !!i.body && i.body.replace(/\s/g, '').length >= 4 && !/^第?[0-9Xx×〇零一二三四五六七八九十百.]{1,10}条?$/.test(i.body.replace(/\s/g, ''))),
      r.items.slice(0, 3).map((i) => String(i.body).slice(0, 14)).join(' | '));

    const t = (r.tool && r.tool.result) || {};
    const ti = t.items || [];
    check('工具返回候选且字段齐全', r.tool && r.tool.ok === true && ti.length > 0 && ti.every((x) => x.法规名称 && x.条款原文 && x.结论式 && x.来源), ti.length + ' 条');
    check('结论式句式正确（条号可缺省：不符合《X》[第N条]“原文”的规定。）',
      ti.length > 0 && ti.every((x) => /^不符合《[^》]+》(第[0-9.]+条)?“[^”]+”的规定。$/.test(x.结论式)), (ti[0] || {}).结论式 || '');
    check('条号一律归一化形态（第N条 / 空）', ti.every((x) => !x.条号 || /^第[0-9.]+条$/.test(x.条号)), ti.map((x) => x.条号).join(','));
    check('正文已剥前缀（无"违反《…》第N条："、不是纯条号）',
      ti.every((x) => x.条款原文.indexOf('违反') === -1 && !/^第[0-9.]+条$/.test(x.条款原文)),
      ti.map((x) => String(x.条款原文).slice(0, 14)).join(' | '));
    check('手册不进候选、无占位名', ti.every((x) => !/手册/.test(x.法规名称)) && JSON.stringify(ti).indexOf('历史案例参考') === -1);
    const t2 = (r.toolHb && r.toolHb.result) || {};
    check('专查手册项点的 query 同样不出手册候选', (t2.items || []).every((x) => !/手册/.test(x.法规名称)), '命中 ' + ((t2.items || []).length) + ' 条');
  }

  // ---------- T3 参数校验 ----------
  console.log('\n==== T3 参数校验与未知工具 ====');
  {
    const r = await evalIn(`(async () => {
      var a = await window._agentRunTool('autocheck', {});
      var b = await window._agentRunTool('autocheck', { query: '信号机灯丝断丝', limit: 99 });
      var c = await window._agentRunTool('nope_tool', {});
      return { noQuery: a.result || {}, many: (b.result || {}).items || [], unknown: c };
    })()`);
    check('缺 query 时明确报错', /缺少 query/.test(r.noQuery.error || ''), r.noQuery.error);
    check('limit 超上限被夹到 8 以内', r.many.length <= 8, '实际 ' + r.many.length);
    check('未知工具仍走原错误分支', r.unknown && r.unknown.ok === false && /未知工具/.test(r.unknown.error || ''), r.unknown.error);
  }

  console.log('\n==== 汇总：' + results.filter((r) => r.ok).length + '/' + results.length + ' 通过 ====');
  const failed = results.filter((r) => !r.ok);
  if (failed.length) failed.forEach((f) => console.log('  ❌ ' + f.name + '  «' + f.extra + '»'));

  try { await cdp.send('Browser.close'); } catch (e) {}
  ws.close(); child.kill(); server.close();
  try { fs.rmSync(profileDir, { recursive: true, force: true }); } catch (e) {}
}
main().catch((e) => { console.error('audit error:', e); process.exit(1); });
