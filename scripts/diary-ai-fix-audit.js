// 工作写实「✨ 一键 AI 修改」取证脚本（可复用）：拦 fetch 造 AI 响应，逐条断言
//   用途：改 diary.js 的 AI 修改 / 守卫 / 撤销 / 缺规章召回逻辑后跑一次
//   用法：node scripts/diary-ai-fix-audit.js
// 覆盖：
//   C1 正常修改（错别字/标点/口语、规章回库校对）
//   C2 越界回退（数字被改、规章被改写 → 必须回退原文并计入"拦下"）
//   C3 缺规章 → 对规召回候选 → 采纳写入
//   C4 等待期间用户改了同一天 → 跳过且不覆盖用户新输入
//   C5 撤销 → 恢复运行前状态
//   C8 对规召回（历史案例 + 规章库）/ 手册过滤 / 降级占位不得成文
//   C11 点击即刻反馈（同 tick，已按用户口径去掉悬浮气泡） / C14 点击延迟量化（同步出现 + 首个请求耗时）
//   C15 未配置 API 接口 → 不显示「✨ 一键修改」按钮（占位符 Key 同判；配置变更可自动跟随）
const http = require('http'); const fs = require('fs'); const path = require('path'); const os = require('os');
const { spawn } = require('child_process');
const ROOT = path.resolve(__dirname, '..'), PORT = 8131, CDP_PORT = 9341;
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

const D1 = {
  date: '2026-03-05',
  work: '上午检查了甲站信号设备，看了一下设备情况。设备运行正常，已径按规定进行了巡视。共检查了3处信号机，发现2处问题。',
  issues: ['信号机灯丝断了，弄了一下就好了，已径处理'],
  regulations: ['《铁路技术管理规程（电务）》第十二条 信号机发生断丝故章时，电务人员应当立即处理。']
};
const D2 = { date: '2026-03-06', work: '检查乙站调车作业，发现了1个问题。', issues: ['信号机显示不良，存在安全隐患'], regulations: [''] };
const D3 = { date: '2026-03-07', work: '整理资料', issues: [], regulations: [] };

// AI 假响应
const FAKE_OK = JSON.stringify({
  work: { text: '上午对甲站信号设备进行检查，设备运行正常，已按规定完成巡视；共检查信号机 3 处，发现 2 处问题。', changes: [{ type: '错别字', from: '已径', to: '已经' }, { type: '标点', from: '。设备', to: '；设备' }] },
  issues: [{ i: 0, text: '信号机灯丝断丝，已当场处理完毕。', changes: [{ type: '口语', from: '断了，弄了一下就好了', to: '断丝，已当场处理完毕' }] }],
  regulations: [{ i: 0, text: '《铁路技术管理规程（电务）》第十二条 信号机发生断丝故障时，电务人员应当立即处理。', changes: [{ type: '错别字', from: '故章', to: '故障' }] }],
  ruleSuggest: []
});
const FAKE_BAD = JSON.stringify({   // 越界：数字被改 + 规章被改写（书名号也换了）
  work: { text: '上午对甲站信号设备进行检查，共检查信号机 5 处，发现 2 处问题。', changes: [{ type: '修改', from: '3 处', to: '5 处' }] },
  issues: [{ i: 0, text: '信号机灯丝断丝，共发现 3 处问题，已处理。', changes: [{ type: '修改', from: '1 个问题', to: '3 处问题' }] }],
  regulations: [{ i: 0, text: '违反《信号维护规则》第五十条，作业人员未按规定执行相关要求。', changes: [] }],
  ruleSuggest: []
});
const FAKE_SUGGEST = JSON.stringify({
  work: { text: '检查乙站调车作业，发现 1 个问题。', changes: [] },
  issues: [{ i: 0, text: '信号机显示不良，存在安全隐患。', changes: [{ type: '标点', from: '隐患', to: '隐患。' }] }],
  regulations: [],
  // 故意给 6 条：前 3 条应保留，第 4 条重复（去重）、第 5 条超量（截断）、第 6 条 i 越界（丢弃）
  ruleSuggest: [
    { i: 0, rule: '不符合《铁路技术管理规程（电务）》第13条“轨道电路异常应当及时登记”的规定。', ref: '第13条', title: '铁路技术管理规程（电务）', why: '同为电务条款' },
    { i: 0, rule: '不符合《铁路调车作业标准》第5条“调车作业必须确认信号”的规定。', ref: '第5条', title: '铁路调车作业标准', why: '直接对应确认信号' },
    { i: 0, rule: '不符合《铁路技术管理规程》第12条“信号机发生断丝故障时，电务人员应当立即处理”的规定。', ref: '第12条', title: '铁路技术管理规程', why: '涉及信号故障处置' },
    { i: 0, rule: '不符合《铁路调车作业标准》第5条“调车作业必须确认信号”的规定。', ref: '第5条', title: '铁路调车作业标准', why: '本项为重复候选' },
    { i: 0, rule: '不符合《超量条款》第99条“第四条之后应被截断”的规定。', ref: '第99条', title: '超量条款', why: '应被丢弃' },
    { i: 7, rule: '不符合《越界条款》第1条“i 越界应被丢弃”的规定。', ref: '第1条', title: '越界条款', why: '应被丢弃' }
  ]
});
const FAKE_D3 = JSON.stringify({
  work: { text: '整理资料并归档。', changes: [{ type: '标点', from: '资料', to: '资料并归档' }] },
  issues: [], regulations: [], ruleSuggest: []
});

async function main() {
  const profileDir = path.join(os.tmpdir(), 'aj-audit-diary-' + Date.now());
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
    await bulk(rdb,'ruleCollection',[{id:1,initialized:true,data:[
      {trade:'电务',title:'铁路技术管理规程（电务）',content:'第十二条 信号机发生断丝故障时，电务人员应当立即处理。\\n第十三条 轨道电路异常应当及时登记并要求复查。'},
      // 故意把"检查手册"放进规章库：它**不能**被当作规章依据（用于验证过滤）
      {trade:'通用',title:'安全检查手册3',content:'4.1 调车作业检查项点：确认信号、一度停车、禁止溜放。4.2 信号设备检查项点：灯丝、轨道电路。'},
      // 4 条同主题规章（每条 = 1 个索引块）：用于验证"候选池 >3 条时只给 3 条"（C12）
      // ⚠️ 必须拆成 4 条独立规章 —— chunkRules 按"条规章"切块，把 5 条条款写进一条规章只算 1 块（实测池=2）
      {trade:'电务',title:'高速铁路信号维护规则技术标准',content:'4.3.1 信号机显示不良时，应及时检查灯丝与点灯电路。'},
      {trade:'电务',title:'信号设备电气特性测试管理办法',content:'测试数据应与实际电缆长度的环阻换算值核对，测试记录及时填写。'},
      {trade:'电务',title:'铁路信号维护规则',content:'信号机灯丝断丝时应立即更换，并登记故障处理情况；测试数据应真实准确。'},
      {trade:'电务',title:'轨道电路维护细则',content:'轨道电路送、受端电缆应按照调整表要求补偿到规定长度，实际电缆长度通过电缆环阻测试计算。'}
    ]}]);
    // 检查信息台账（供"对规优先搬用台账引用"用）：9001/9004 带规章；9003 的"规章"是手册（应被忽略）
    const idb=await open('RailwayIssueDB_v2',3,db=>{if(!db.objectStoreNames.contains('issues'))db.createObjectStore('issues',{keyPath:'id',autoIncrement:true});});
    await bulk(idb,'issues',[
      {id:9001,'性质':'B类',category:'调车',content:'调车作业中未确认信号，存在安全隐患',regulation:'违反《铁路技术管理规程》第9条：调车作业必须确认信号。',unit:'乙站',datetime:'2026-03-06 09:10:00'},
      {id:9002,'性质':'A类',category:'调车',content:'调车作业中未确认信号，存在安全隐患情况',regulation:'违反《铁路调车作业标准》第5条：调车作业必须确认信号。',unit:'丙站',datetime:'2026-03-05 08:00:00'},
      {id:9003,'性质':'B类',category:'调车',content:'调车作业未确认信号',regulation:'《安全检查手册3》4.1：检查项点，不是规章依据',unit:'丁站',datetime:'2026-03-04 08:00:00'},
      {id:9004,'性质':'B类',category:'调车',content:'调车作业未确认信号，已要求整改',regulation:'违反《铁路技术管理规程》第8条：调车作业必须确认信号，不得溜放。',unit:'戊站',datetime:'2026-03-03 08:00:00'}
    ]);
    localStorage.setItem('railway_work_diary_v2', JSON.stringify(${JSON.stringify([D1, D2, D3])}));
    localStorage.setItem('ds_api_key_v1','sk-audit');
    localStorage.setItem('ds_api_url_v1','https://api.deepseek.com/chat/completions');
    localStorage.setItem('ds_model_v1','deepseek-flash');
    localStorage.setItem('ds_thinking','auto');
    localStorage.setItem('current_module','doubao');
    return 'ok';
  })()`));

  await nav(base + '?run=1'); await sleep(3500);

  // ---------- 安装 fetch 拦截 + 测试辅助 ----------
  console.log('install:', await evalIn(`(() => {
    window.__cap = [];
    window.__fakeReply = ${JSON.stringify(FAKE_OK)};
    window.__fakeDelay = 0;
    window.__origFetch = window.__origFetch || window.fetch;
    window.fetch = async function(url, opt) {
      try {
        if (opt && opt.method === 'POST' && typeof opt.body === 'string') {
          const body = JSON.parse(opt.body);
          const sys = (body.messages.filter(m => m.role === 'system')[0] || {}).content || '';
          if (/文字校订专家/.test(sys)) {
            window.__cap.push({ body: body, sys: sys, usr: (body.messages.filter(m => m.role === 'user')[0] || {}).content || '' });
            const out = window.__fakeReply;
            const delay = window.__fakeDelay || 0;
            // 忠实模拟真实 fetch：abort 时立刻以 AbortError 拒绝（否则"超时"路径永远测不到）
            if (delay) await new Promise(function (res, rej) {
              var t = setTimeout(res, delay);
              if (opt.signal) {
                if (opt.signal.aborted) { clearTimeout(t); var e0 = new Error('aborted'); e0.name = 'AbortError'; rej(e0); return; }
                opt.signal.addEventListener('abort', function () {
                  clearTimeout(t); var e1 = new Error('aborted'); e1.name = 'AbortError'; rej(e1);
                });
              }
            });
            return new Response(JSON.stringify({ choices: [{ message: { content: out } }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
          }
        }
      } catch (e) { console.warn('cap err', e); }
      return window.__origFetch.apply(this, arguments);
    };
    // 无头环境下 alert/confirm 会阻塞求值，统一打桩（真实浏览器行为不受影响）
    window.alert = function () {};
    window.confirm = function () { return true; };
    window.__diaries = function() { try { return JSON.parse(localStorage.getItem('railway_work_diary_v2') || '[]'); } catch (e) { return null; } };
    window.__rec = function(date) { var a = window.__diaries() || []; return a.filter(function(d){ return d.date === date; })[0] || null; };
    window.__panel = function() { var el = document.getElementById('diary-ai-fix-panel'); return el ? el.textContent : ''; };
    window.__undoVisible = function() { var b = document.getElementById('diary-ai-undo-btn'); return !!(b && b.style.display !== 'none'); };
    window.__adoptFirst = function() { return window.__adoptNth(0); };
    window.__adoptNth = function(n) {
      var btns = Array.prototype.slice.call(document.querySelectorAll('#diary-ai-fix-panel button')).filter(function(x){ return /采纳/.test(x.textContent); });
      if (!btns[n]) return false;
      btns[n].click();
      return true;
    };
    window.__setSearch = function(kw) { var el = document.getElementById('diary-search-input'); el.value = kw; window.diarySearch(kw); };
    window.__confirmTrue = function() { window.confirm = function() { return true; }; };
    window.__lastCap = function() { return window.__cap[window.__cap.length - 1] || null; };
    window.__capN = function() { return window.__cap.length; };
    return 'ready';
  })()`));

  // ---------- C0 默认范围：当前界面正在编辑/查看的那天 ----------
  console.log('\n==== C0 默认范围：当前界面/当日（新增口径） ====');
  {
    // C0-a：输入视图正在编辑 2026-03-05 → 点「✨ 一键修改」应直接开跑（不等范围选择）
    const a = await evalIn(`(async () => {
      window.__cap = []; window.__fakeReply = ${JSON.stringify(FAKE_OK)}; window.__fakeDelay = 900;   // 留出观察"进行中气泡"的时间
      window.__setSearch('');
      window.editDiary('2026-03-05');                 // 真实路径：把该日记录载入编辑界面
      await new Promise(r => setTimeout(r, 300));
      var btn = document.getElementById('diary-ai-fix-btn');
      var panelEl = document.getElementById('diary-ai-fix-panel');
      var inInputView = !!(btn && btn.closest('#diary-input-view'));
      var panelDetached = !!(panelEl && !panelEl.closest('#diary-history-view') && !panelEl.closest('#diary-input-view'));
      btn.click();                                    // 点编辑界面里的「✨ 一键修改」
      await new Promise(r => setTimeout(r, 400));     // 请求飞行期间
      var toastEl = document.getElementById('diary-ai-toast');
      var toastDuring = toastEl ? toastEl.textContent : '';
      var toastOpacity = toastEl ? getComputedStyle(toastEl).opacity : '';
      var toastTop = toastEl ? getComputedStyle(toastEl).top : '';
      var inlineDuring = (document.getElementById('diary-ai-fix-inline') || {}).textContent || '';
      var panelDuring = window.__panel();
      await new Promise(r => setTimeout(r, 1600));
      var toastAfter = (document.getElementById('diary-ai-toast') || {}).textContent || '';
      var rec = window.__rec('2026-03-05') || {};
      return { capN: window.__capN(), panel: window.__panel(), work: rec.work, issues: rec.issues, regs: rec.regulations,
               inInputView: inInputView, panelDetached: panelDetached,
               toastDuring: toastDuring, toastOpacity: toastOpacity, toastTop: toastTop,
               toastAfter: toastAfter, panelDuring: panelDuring,
               inlineDuring: inlineDuring, inlineAfter: (document.getElementById('diary-ai-fix-inline') || {}).textContent || '' };
    })()`);
    check('「✨ 一键修改」按钮在编辑界面内', a.inInputView);
    check('回执面板在两视图之外（编辑界面也能看到）', a.panelDetached);
    check('点按钮 → 一键直达改当天（恰好 1 次请求）', a.capN === 1, 'capN=' + a.capN);
    check('不弹"选择范围"面板', !/选择范围/.test(a.panel || ''), (a.panel || '').slice(0, 40));
    // 点击后立刻有反馈（用户反馈"点了半天没反应"）：按钮旁进度文字 + 回执面板计时
    // 【2026-09-19 用户口径】悬浮气泡已整套去掉 → 这里反向锁定：元素根本不该存在
    check('已去掉悬浮气泡（#diary-ai-toast 不再创建）', !a.toastDuring && !a.toastTop,
      'toast 文本=' + JSON.stringify(a.toastDuring || '') + ' top=' + JSON.stringify(a.toastTop || ''));
    check('按钮旁进度文字立即出现（✨ 修改中 Ns…）', /修改中\s*\d+s/.test(a.inlineDuring || ''), (a.inlineDuring || '').slice(0, 30));
    check('完成后按钮旁进度清空', (a.inlineAfter || '') === '', JSON.stringify(a.inlineAfter));
    check('面板进度含计时（⏱ Ns）', /⏱\s*\d+s/.test(a.panelDuring || ''), (a.panelDuring || '').replace(/\s+/g, ' ').slice(0, 50));
    // 用户口径（2026-09-18）：回执里那段"已自动保存…数字/日期…引擎 v…"是废话，已删除（版本号只看控制台）
    check('回执不再塞无意义说明文字（已自动保存/引擎版本号等）',
      !/已自动保存/.test(a.panel || '') && !/引擎 v2026-09-18/.test(a.panel || '') && !/检查手册不作为规章依据/.test(a.panel || ''), (a.panel || '').slice(0, 60));
    check('完成后结果摘要只在回执框里（不再弹气泡）',
      /一键修改完成/.test(a.panel || '') && /改动\s*\d+\s*处/.test(a.panel || '') && !a.toastAfter,
      (a.panel || '').replace(/\s+/g, ' ').slice(0, 70));
    check('当天写实已被修改', /已按规定/.test(a.work || ''), (a.work || '').slice(0, 30));
    check('该日问题/规章未被误清空', (a.issues || []).length === 1 && !!(a.issues || [])[0] && (a.regs || []).length === 1 && !!(a.regs || [])[0],
      JSON.stringify(a.issues) + ' / ' + JSON.stringify((a.regs || []).slice(0, 1)));
    // 大幅改写只提示不阻断：应单独计入"待复核"，不混进"拦下"（这里的问题描述是整句重写）
    check('大幅改写计入"待复核"而非"拦下"', /待复核\s*[1-9]/.test(a.panel) && /请过一眼/.test(a.panel) && !/拦下\s*[1-9]/.test(a.panel), (a.panel || '').slice(0, 70));

    // C0-b：那天没有写实 → 弹范围面板并提示（不发起请求）
    const b = await evalIn(`(async () => {
      window.__cap = [];
      document.getElementById('diary-date').value = '2020-01-01';
      document.getElementById('diary-work').value = '';
      window.diaryAiFix();
      await new Promise(r => setTimeout(r, 400));
      const p = window.__panel();
      return { capN: window.__capN(), panel: p, hasRangeBtns: /全部\\s*3\\s*条/.test(p), hasNotice: /还没有可修改的内容/.test(p) };
    })()`);
    check('当天无内容 → 只给提示、不弹范围面板、不发请求', b.capN === 0 && b.hasNotice && !b.hasRangeBtns, (b.panel || '').slice(0, 70));

    // C0-c：范围选择 UI 已按要求**整体删除**（按钮 / 函数 / 面板都不再存在）
    const c = await evalIn(`(() => ({
      hasMoreBtn: !!document.getElementById('diary-ai-fix-more'),
      typeFixMore: typeof window.diaryAiFixMore,
      typePlan: typeof window.diaryAiPlan,
      arity: window.diaryAiFix.length,
      typeRun: typeof window.diaryAiRun
    }))()`);
    check('「▾」按钮已删除', c.hasMoreBtn === false);
    check('范围选择函数已删除（diaryAiFixMore / diaryAiPlan）', c.typeFixMore === 'undefined' && c.typePlan === 'undefined');
    check('diaryAiFix 不再接受范围参数', c.arity === 0, 'arity=' + c.arity);
    check('执行器 diaryAiRun 仍可用（内部保留）', c.typeRun === 'function');
    // 复位：把输入视图恢复成干净状态，避免影响后续场景
    await evalIn(`(() => { document.getElementById('diary-work').value = ''; document.getElementById('diary-date').value = '2026-03-05'; document.getElementById('diary-input-view').style.display = 'none'; document.getElementById('diary-history-view').style.display = 'block'; return true; })()`);
  }

  // ---------- C1 正常修改 ----------
  console.log('\n==== C1 正常修改（错别字/口语/规章回库校对） ====');
  await evalIn(`(async () => { window.__cap = []; window.__fakeReply = ${JSON.stringify(FAKE_OK)}; window.__fakeDelay = 0; window.__setSearch('信号机'); await window.diaryAiRun('match'); return true; })()`);
  {
    const r = await evalIn(`(() => {
      var rec = window.__rec('2026-03-05') || {};
      var cap = window.__lastCap() || {};
      return {
        work: rec.work, issue: (rec.issues||[])[0], reg: (rec.regulations||[])[0],
        panel: window.__panel().slice(0, 3000), undo: window.__undoVisible(),
        backup: !!localStorage.getItem('diary_ai_fix_backup_v1'),
        promptHasLib: /规章库原文/.test(cap.usr || ''),
        promptHasConstraint: /引文正文/.test(cap.sys || '') && /外壳按/.test(cap.sys || ''),
        streamFalse: cap.body && cap.body.stream === false,
        temp: cap.body && cap.body.temperature,
        thinkingOff: !!(cap.body && cap.body.thinking && cap.body.thinking.type === 'disabled')
      };
    })()`);
    check('工作写实已改写（含"已按规定"）', /已按规定/.test(r.work || ''), (r.work || '').slice(0, 40));
    check('保留数字 3 处 / 2 处', /3\s*处/.test(r.work || '') && /2\s*处/.test(r.work || ''));
    check('问题已改写（断丝，已当场处理完毕）', /已当场处理完毕/.test(r.issue || ''), (r.issue || '').slice(0, 30));
    check('规章错别字已修（故章→故障）', /故章/.test(r.reg || '') === false && /故障/.test(r.reg || ''), (r.reg || '').slice(0, 30));
    check('回执含"一键修改完成"', /一键修改完成/.test(r.panel || ''), (r.panel || '').slice(0, 60));
    check('撤销按钮已出现', r.undo);
    check('已写入备份', r.backup);
    check('提示词含硬约束（外壳规范化 + 引文正文不许改）', r.promptHasConstraint);
    check('提示词含"规章库原文"（回库校对参照）', r.promptHasLib);
    check('非流式 + 温度 0.1 + 思考关闭', r.streamFalse && r.temp === 0.1 && r.thinkingOff, 'temp=' + r.temp + ' thinkingOff=' + r.thinkingOff);
    // "改动较大"只提示不阻断：应单独计入"待复核"，不混进"拦下"
  }

  // ---------- C2 越界回退 ----------
  console.log('\n==== C2 越界回退（改数字 / 改写规章 → 必须回退） ====');
  const beforeBad = await evalIn(`JSON.stringify(window.__rec('2026-03-05'))`);
  await evalIn(`(async () => { window.__cap = []; window.__fakeReply = ${JSON.stringify(FAKE_BAD)}; window.__fakeDelay = 0; window.__setSearch('信号机'); await window.diaryAiRun('match'); return true; })()`);
  {
    const r = await evalIn(`(() => {
      var rec = window.__rec('2026-03-05') || {};
      return { work: rec.work, issue: (rec.issues||[])[0], reg: (rec.regulations||[])[0], panel: window.__panel() };
    })()`);
    const before = JSON.parse(beforeBad);
    check('工作写实回退（未被改成 5 处）', r.work === before.work && !/5\s*处/.test(r.work || ''), (r.work || '').slice(0, 30));
    check('问题回退（未被改成 3 处问题）', r.issue === before.issues[0] && !/3\s*处问题/.test(r.issue || ''));
    check('规章回退（改写被拦）', r.reg === before.regulations[0] && !/信号维护规则/.test(r.reg || ''));
    check('回执出现"拦下"计数', /拦下\s*[1-9]/.test(r.panel || ''), (r.panel || '').slice(0, 80));
    check('回执列出"已保留原文"', /已保留原文/.test(r.panel || ''));
  }

  // ---------- C3 候选只认候选池：编造的被丢弃、不足按池补齐（用户口径：条数=min(3,池)） ----------
  console.log('\n==== C3 缺规章依据 → 只认候选池（丢弃编造 + 按池补齐）→ 采纳所选 ====');
  await evalIn(`(async () => { window.__cap = []; window.__fakeReply = ${JSON.stringify(FAKE_SUGGEST)}; window.__setSearch('调车'); await window.diaryAiRun('match'); return true; })()`);
  {
    const r = await evalIn(`(() => {
      var rec = window.__rec('2026-03-06') || {};
      var cap = window.__lastCap() || {};
      var p = window.__diaryAiLastPool || { cands: [] };
      var poolN = (p.cands || []).filter(function (c) { return c.issue === 0; }).length;     // 该问题的候选池条数
      var btns = Array.prototype.slice.call(document.querySelectorAll('#diary-ai-fix-panel button')).filter(function(x){ return /采纳/.test(x.textContent); });
      return { issue: (rec.issues||[])[0], reg: (rec.regulations||[])[0] || '', panel: window.__panel(), adoptBtns: btns.length, poolN: poolN,
               promptHasCands: /候选条款/.test(cap.usr || ''), cands: (cap.usr || '').match(/\\[c\\d+\\]/g),
               sysRule: /有几条给几条、最多 3 条/.test(cap.sys || ''), usrRule: /池 ≤3 条有几条给几条/.test(cap.usr || ''),
               jsonEx2: /"cid":"c1"/.test(cap.sys || '') };
    })()`);
    check('问题已改写（补句号）', /信号机显示不良，存在安全隐患。/.test(r.issue || ''), (r.issue || '').slice(0, 30));
    check('提示词注入了候选条款（KB 召回）', r.promptHasCands, '召回候选数 ' + ((r.cands || []).length));
    // 用户实测"候选每次只有一条"的三处根因（提示词只说最多 3 条、示例只给 1 条、"挑 1 条"字样）已全部改掉
    check('系统提示写明条数规则"有几条给几条、最多 3 条"', r.sysRule);
    check('用户提示也写明"池 ≤3 条有几条给几条"', r.usrRule);
    check('JSON 示例给 2 条候选（模型会照示例的条数给）', r.jsonEx2);
    check('回执交代候选池构成（历史案例 N · 规章库 M → 选中 K）', /候选池 \d+ 条（历史案例 \d+ · 规章库 \d+）→ 选中 \d+ 条/.test(r.panel || ''),
      (r.panel || '').match(/候选池[^；]{0,40}/) || '');
    check('回执给出候选条款', /建议补的规章依据/.test(r.panel || ''));
    // 池里没有的条款（"超量条款/越界条款"）必须被丢弃；与池中引文正文一致的会被认回（允许模型抄错 cid）
    check('编造的条款被丢弃（超量/越界条目不再出现）', !/超量条款/.test(r.panel || '') && !/越界条款/.test(r.panel || ''));
    check('条数 = min(3, 池)：本例池 ' + r.poolN + ' 条 → 候选 ' + Math.min(3, r.poolN) + ' 条', r.adoptBtns === Math.min(3, r.poolN), '采纳按钮数=' + r.adoptBtns);
    check('补齐的候选标注来源"按池补齐"', /按池补齐/.test(r.panel || ''));
    check('补出来的文本是结论式"不符合《…》…的规定。"', /不符合《[^》]+》\s*第?[\d.]+条?[“"][^”"]+[”"]的规定。/.test(r.panel || ''));

    const pick = Math.min(3, r.poolN) >= 2 ? 1 : 0;          // 有第 2 条就选它，否则选第 1 条
    const adopt = await evalIn(`(async () => {
      window.__confirmTrue();
      var ok = window.__adoptNth(${pick});
      await new Promise(r => setTimeout(r, 400));
      var rec = window.__rec('2026-03-06') || {};
      var left = Array.prototype.slice.call(document.querySelectorAll('#diary-ai-fix-panel button')).filter(function(x){ return /采纳/.test(x.textContent); }).length;
      return { ok: ok, reg: (rec.regulations||[])[0] || '', panel: window.__panel(), left: left };
    })()`);
    check('采纳第 ' + (pick + 1) + ' 个候选 → 写入的正是回执列出的那条', adopt.ok && !!adopt.reg && r.panel.indexOf(adopt.reg.slice(0, 24)) !== -1,
      '写入=' + (adopt.reg || '').slice(0, 40));
    check('采纳后该组标记「已采纳」且同组按钮消失', /已采纳/.test(adopt.panel || '') && adopt.left === 0, '剩余采纳按钮=' + adopt.left);
  }

  // ---------- C4 等待期间用户改动 → 跳过 ----------
  console.log('\n==== C4 等待期间用户改了同一天 → 跳过、不覆盖 ====');
  {
    const r = await evalIn(`(async () => {
      window.__cap = []; window.__fakeReply = ${JSON.stringify(FAKE_D3)}; window.__fakeDelay = 900;
      window.__setSearch('整理');
      // 模拟"正在编辑 2026-03-07 这一天"
      document.getElementById('diary-date').value = '2026-03-07';
      document.getElementById('diary-work').value = '整理资料';
      document.getElementById('diary-input-view').style.display = 'block';
      setTimeout(function(){ document.getElementById('diary-work').value += '（用户新输入）'; }, 200);
      await window.diaryAiRun('match');
      return { panel: window.__panel(), rec: (window.__rec('2026-03-07')||{}).work, dom: document.getElementById('diary-work').value };
    })()`);
    check('该条被跳过并在回执写明', /跳过/.test(r.panel || '') && /等待期间/.test(r.panel || ''));
    check('落库内容未被 AI 覆盖', r.rec === '整理资料', String(r.rec));
    check('用户新输入保留在输入框', /用户新输入/.test(r.dom || ''), String(r.dom));

    // C4-b：请求期间"记录本身"被改（模拟自动保存落盘）→ 同样必须跳过
    const b2 = await evalIn(`(async () => {
      window.__cap = []; window.__fakeReply = ${JSON.stringify(FAKE_SUGGEST)}; window.__fakeDelay = 700;
      window.__setSearch('调车');
      setTimeout(function () {                        // 请求飞行期间改动"记录本身"（等价于自动保存落盘）
        var m = window.getDiaryData().filter(function (x) { return x.date === '2026-03-06'; })[0];
        if (m) m.work = '检查乙站调车作业，发现了1个问题。（自动保存刚落盘）';
      }, 250);
      await window.diaryAiRun('match');               // 等整批跑完
      await new Promise(r => setTimeout(r, 300));
      var mem = window.getDiaryData().filter(function (x) { return x.date === '2026-03-06'; })[0] || {};
      return { panel: window.__panel(), mem: mem.work, store: (window.__rec('2026-03-06') || {}).work };
    })()`);
    check('记录期间被改 → 跳过', /跳过/.test(b2.panel || ''), (b2.panel || '').slice(0, 60));
    check('未用 AI 结果覆盖该条（保留改动后的原文）', /自动保存刚落盘/.test(b2.mem || '') && !/发现 1 个问题。$/.test(b2.mem || ''), String(b2.mem).slice(0, 40));
  }

  // ---------- C5 撤销 ----------
  console.log('\n==== C5 撤销：本次运行前状态可字节级还原 ====');
  {
    const FAKE_OK3 = JSON.stringify({
      work: { text: '上午对甲站信号设备开展巡视检查，设备状态正常，已按规定执行；共检查信号机 3 处，发现 2 处问题。', changes: [{ type: '改写', from: '进行了检查', to: '开展巡视检查' }] },
      issues: [{ i: 0, text: '信号机灯丝断丝，已当场处理完毕。', changes: [] }],
      regulations: [{ i: 0, text: '《铁路技术管理规程（电务）》第十二条 信号机发生断丝故障时，电务人员应当立即处理。', changes: [] }],
      ruleSuggest: []
    });
    const before = await evalIn(`JSON.stringify(window.__rec('2026-03-05'))`);
    const r = await evalIn(`(async () => {
      window.__cap = []; window.__fakeReply = ${JSON.stringify(FAKE_OK3)}; window.__fakeDelay = 0;
      window.__setSearch('信号机');
      await window.diaryAiRun('match');
      var mid = window.__rec('2026-03-05') || {};
      var bk = JSON.parse(localStorage.getItem('diary_ai_fix_backup_v1') || '{}');
      window.__confirmTrue();
      window.diaryAiUndoAiFix();
      await new Promise(r => setTimeout(r, 300));
      return {
        midWork: mid.work,
        after: JSON.stringify(window.__rec('2026-03-05')),
        backupItems: (bk.items || []).length,
        backupCleared: !localStorage.getItem('diary_ai_fix_backup_v1'),
        undoHidden: !window.__undoVisible(),
        panel: window.__panel().slice(0, 80)
      };
    })()`);
    check('撤销前确实被改过（保证撤销有意义）', !!r.midWork && r.midWork !== JSON.parse(before).work, (r.midWork || '').slice(0, 26));
    check('撤销后与运行前一致（字节级）', r.after === before, 'backupItems=' + r.backupItems);
    check('备份已清除', r.backupCleared);
    check('撤销按钮已隐藏', r.undoHidden);
    check('回执提示已撤销', /已撤销/.test(r.panel || ''));
  }

  // ---------- C6 规章依据：对规结论规范化（外壳可改、引文正文不可改） ----------
  console.log('\n==== C6 规章依据规范化：不符合《X》第X条“原文”的规定 ====');
  {
    // C6-a：外壳规范化（第十二条→第12条、加中文引号、结尾加"的规定。"）→ 必须**接受**
    const a = await evalIn(`(async () => {
      window.__cap = []; window.__fakeDelay = 0;
      var cur = window.__rec('2026-03-05') || {};
      window.__fakeReply = JSON.stringify({
        work: { text: cur.work, changes: [] },
        issues: [],
        regulations: [{ i: 0, text: '不符合《铁路技术管理规程（电务）》第12条“信号机发生断丝故障时，电务人员应当立即处理”的规定。', changes: [{ type: '规范', from: '违反…：', to: '不符合…的规定' }] }],
        ruleSuggest: []
      });
      await window.diaryAiRun('day:2026-03-05');
      await new Promise(r => setTimeout(r, 300));
      var rec = window.__rec('2026-03-05') || {};
      return { reg: (rec.regulations || [])[0], panel: window.__panel().slice(0, 300) };
    })()`);
    check('规范化被接受（不符合 + 第12条 + 中文引号 + 的规定。）',
      /不符合/.test(a.reg || '') && /第12条/.test(a.reg || '') && /[“"]信号机发生断丝故障时/.test(a.reg || '') && /的规定。\s*$/.test(a.reg || ''),
      (a.reg || '').slice(0, 60));
    check('未误判为"拦下"', !/拦下\s*[1-9]/.test(a.panel || ''), (a.panel || '').slice(0, 60));

    // C6-b：引文正文被改写（"信号机断丝时应立即处理"）→ 必须**拦下回退**
    const b = await evalIn(`(async () => {
      window.__cap = [];
      var cur = window.__rec('2026-03-05') || {};
      var before = (cur.regulations || [])[0];
      window.__fakeReply = JSON.stringify({
        work: { text: cur.work, changes: [] },
        issues: [],
        regulations: [{ i: 0, text: '不符合《铁路技术管理规程（电务）》第12条“信号机断丝时应立即处理”的规定。', changes: [] }],
        ruleSuggest: []
      });
      await window.diaryAiRun('day:2026-03-05');
      await new Promise(r => setTimeout(r, 300));
      var after = ((window.__rec('2026-03-05') || {}).regulations || [])[0];
      return { same: before === after, panel: window.__panel().slice(0, 400) };
    })()`);
    check('引文正文被改写 → 回退原文', b.same);
    check('回执写明"引文正文被改写"', /引文正文被改写/.test(b.panel || ''), (b.panel || '').slice(0, 90));

    // C6-c：条号被改（第12条 → 第13条）→ 必须拦下
    const c2 = await evalIn(`(async () => {
      window.__cap = [];
      var cur = window.__rec('2026-03-05') || {};
      var before = (cur.regulations || [])[0];
      window.__fakeReply = JSON.stringify({
        work: { text: cur.work, changes: [] },
        issues: [],
        regulations: [{ i: 0, text: '不符合《铁路技术管理规程（电务）》第13条“信号机发生断丝故障时，电务人员应当立即处理”的规定。', changes: [] }],
        ruleSuggest: []
      });
      await window.diaryAiRun('day:2026-03-05');
      await new Promise(r => setTimeout(r, 300));
      var after = ((window.__rec('2026-03-05') || {}).regulations || [])[0];
      return { same: before === after, panel: window.__panel().slice(0, 400) };
    })()`);
    check('条号被改（12→13）→ 回退原文', c2.same);
    check('回执写明"条款编号被改动"', /条款编号被改动/.test(c2.panel || ''), (c2.panel || '').slice(0, 90));
  }

  // ---------- C7 用户实例定点验证（对规结论规范化） ----------
  console.log('\n==== C7 用户实例：违反《…》4.3.4：正文。 → 不符合《…》第4.3.4条“正文”的规定。 ====');
  {
    const r = await evalIn(`(() => {
      var D = window.__diaryAiDiag;
      var before = '违反《高速铁路信号维护规则技术标准》4.3.4：轨道电路送、受端电缆应按照调整表要求补偿到规定长度，实际电缆长度通过电缆环阻测试计算：L=环阻/45 (km)。';
      var after  = '不符合《高速铁路信号维护规则技术标准》第4.3.4条“轨道电路送、受端电缆应按照调整表要求补偿到规定长度，实际电缆长度通过电缆环阻测试计算：L=环阻/45 (km)”的规定。';
      var ok = D.guard('reg', before, after);
      // 保留数字 45 与条号 4.3.4，只把引文正文"润色/压缩" → 必须由"引文正文被改写"这条拦下
      var badBody = D.guard('reg', before, '不符合《高速铁路信号维护规则技术标准》第4.3.4条“轨道电路送受端电缆应按调整表补偿到规定长度，电缆长度由环阻测试折算：L=环阻/45 (km)”的规定。');
      var badArt  = D.guard('reg', before, '不符合《高速铁路信号维护规则技术标准》第4.3.5条“轨道电路送、受端电缆应按照调整表要求补偿到规定长度，实际电缆长度通过电缆环阻测试计算：L=环阻/45 (km)”的规定。');
      var badNum  = D.guard('reg', before, '不符合《高速铁路信号维护规则技术标准》第4.3.4条“轨道电路送、受端电缆应按照调整表要求补偿到规定长度，实际电缆长度通过电缆环阻测试计算：L=环阻/60 (km)”的规定。');
      return {
        okReg: ok.ok, okWarn: ok.warn || '',
        art: D.articleNo(before) + '→' + D.articleNo(after),
        badBody: badBody.ok, badBodyWarn: badBody.warn || '',
        badArt: badArt.ok, badArtWarn: badArt.warn || '',
        badNum: badNum.ok, badNumWarn: badNum.warn || ''
      };
    })()`);
    check('原→规范（4.3.4 → 第4.3.4条“…”的规定）被接受', r.okReg === true, r.okWarn);
    check('条号识别一致（4.3.4 → 4.3.4）', r.art === '4.3.4→4.3.4', r.art);
    check('引文正文被压缩改写 → 拦下', r.badBody === false, r.badBodyWarn);
    check('条号被改（4.3.4→4.3.5）→ 拦下', r.badArt === false, r.badArtWarn);
    check('条款里的数字被改（45→60）→ 拦下', r.badNum === false, r.badNumWarn);
  }

  // ---------- C8 对规召回（历史案例 + 规章库）/ 手册不得当规章 / 降级占位不得成文 ----------
  console.log('\n==== C8 对规召回：案例候选成文 / 手册过滤 / 降级占位不得当依据 ====');
  {
    const r = await evalIn(`(async () => {
      window.__cap = []; window.__fakeDelay = 0;
      // 新增写实：问题1 与检查信息 9001 完全一致；问题2 与 9004 相似。
      // 【2026-09-19 用户口径】候选**完全走智能对规的召回**（历史案例 + 规章库）—— 台账源已删除；
      //   候选同样只进候选、不得自动写入。
      var a = window.getDiaryData();
      a.push({ date: '2026-03-08', work: '检查丙站调车作业。', issues: ['调车作业中未确认信号，存在安全隐患。', '调车作业未确认信号'], regulations: ['', ''] });
      localStorage.setItem('railway_work_diary_v2', JSON.stringify(a));
      window.__fakeReply = JSON.stringify({
        work: null, issues: [], regulations: [],
        // 模型把"台账已引用"的候选（c0）列为候选第 1 条 —— 仍需用户点采纳
        ruleSuggest: [{ i: 0, rule: '不符合《铁路技术管理规程》第9条“调车作业必须确认信号”的规定。', ref: '第9条', title: '铁路技术管理规程', why: '台账里同一条问题已引用', cid: 'c0' }]
      });
      await window.diaryAiRun('day:2026-03-08');
      await new Promise(r => setTimeout(r, 300));
      var rec = window.__rec('2026-03-08') || {};
      var cap = window.__lastCap() || {};
      return {
        reg0: (rec.regulations || [])[0] || '', reg1: (rec.regulations || [])[1] || '',
        panel: window.__panel(), usr: cap.usr || ''
      };
    })()`);
    check('【不做自动引用】运行后两条规章依据仍为空（只进候选）', (r.reg0 || '') === '' && (r.reg1 || '') === '', JSON.stringify([r.reg0, r.reg1]));
    check('案例候选以「[历史案例]」标签进候选（旧台账标签已按用户口径移除）', /\[c\d+\]\[历史案例\]/.test(r.usr || '') && !/台账已引用/.test(r.usr || ''), (r.usr || '').match(/\[c\d+\]\[[^\]]+\]/) || '无');
    check('相似的那条案例引用（第8条）也进了候选', /第8条/.test(r.usr || ''));
    check('手册（《安全检查手册3》）不作为候选进入提示词', !/手册/.test(r.usr || ''), (r.usr || '').match(/手册[^\\n]{0,20}/) || '无');
    // 【回归·2026-09-19】对规案例召回有「策略2 降级」：提不出《法规》时 title='历史案例参考'、正文是案例原文。
    //   这种一旦进池就会写出「不符合《历史案例参考》"调车作业未确认信号…"的规定。」的伪依据 → 必须被拦掉。
    check('案例「策略2 降级」占位候选（历史案例参考）不得进池、不得成文',
      !/历史案例参考/.test((r.usr || '') + (r.panel || '') + (r.reg0 || '') + (r.reg1 || '')));
    check('回执里候选标注来源徽标（历史案例·已引用 / 规章库，且不再有台账相似度）',
      /历史案例·已引用/.test(r.panel || '') && !/台账相似度/.test(r.panel || ''), (r.panel || '').replace(/\s+/g, ' ').slice(0, 120));
    // 条数由"候选池硬规则"决定（min(3,池) 且按池补齐），所以这里只断言"确有历史案例来源的候选被列出"
    check('回执候选池行里体现历史案例来源（≥1 条）', /候选池\s*\d+\s*条（历史案例\s*[1-9]\d*\s*·/.test(r.panel || ''), (r.panel || '').match(/候选池[^；]{0,40}/) || '');
    check('回执写明候选需点「采纳」才写入', /点「采纳」写入该条问题/.test(r.panel || ''));
    const adopt = await evalIn(`(async () => {
      window.__confirmTrue();
      var ok = window.__adoptNth(0);
      await new Promise(r => setTimeout(r, 300));
      var rec = window.__rec('2026-03-08') || {};
      return { ok: ok, reg0: (rec.regulations || [])[0] || '', reg1: (rec.regulations || [])[1] || '', panel: window.__panel() };
    })()`);
    check('点采纳后 → 才写入结论式依据（第9条）', adopt.ok && /第9条/.test(adopt.reg0) && /^不符合/.test(adopt.reg0), (adopt.reg0 || '').slice(0, 42));
    check('采纳写入的依据是真实法规名（非占位名）', /^不符合《(?!历史案例参考)[^》]+》/.test(adopt.reg0 || ''), (adopt.reg0 || '').slice(0, 30));
    check('未被采纳的那条保持为空', (adopt.reg1 || '') === '', JSON.stringify(adopt.reg1));
    // 注意：回执说明里本身有"检查手册不作为规章依据"这句话，所以只查"《安全检查手册》"这种引用形态
    check('台账里"引用的是手册"的那条被跳过（没有把它写成依据）', !/《安全检查手册/.test(adopt.reg0 + adopt.reg1 + (adopt.panel || '')));
  }

  // ---------- C9 超时：可配 / 可定位 / 可重试 / 少发少收 ----------
  console.log('\n==== C9 超时：可配、可定位、可重试 ====');
  {
    const r = await evalIn(`(async () => {
      window.__cap = []; window.__fakeDelay = 9000;                 // 假"慢模型"：9 秒才返回
      localStorage.setItem('diary_ai_fix_timeout_v1', '5');          // 把等待上限压到 5 秒（默认为 180 秒）
      var cur = window.__rec('2026-03-05') || {};
      window.__fakeReply = JSON.stringify({ work: { text: '不应写入这次超时的结果', changes: [] }, issues: [], regulations: [], ruleSuggest: [] });
      await window.diaryAiRun('day:2026-03-05');
      var rec = window.__rec('2026-03-05') || {};
      var btns = Array.prototype.slice.call(document.querySelectorAll('#diary-ai-fix-panel button')).filter(function (b) { return /重试失败的/.test(b.textContent); });
      return {
        workUnchanged: rec.work === cur.work,
        panel: window.__panel(),
        hasRetryBtn: !!btns[0],
        capN: window.__capN(),
        timeoutKey: localStorage.getItem('diary_ai_fix_timeout_v1'),
        promptSaysOmit: /只返回有改动的内容/.test((window.__lastCap() || {}).sys || '')
      };
    })()`);
    check('超时可配置（5s 上限 → 慢模型被判超时）', /失败：等待 5s 模型未返回/.test(r.panel || ''),
      'capN=' + r.capN + ' timeoutKey=' + r.timeoutKey + ' panel=' + (r.panel || '').replace(/\s+/g, ' ').slice(0, 200));
    check('超时未写入任何内容（字段保持原样）', r.workUnchanged);
    check('失败提示可定位（含模型名与 prompt 字数）', /模型\s*\S+/.test(r.panel || '') && /prompt\s*\d+\s*字/.test(r.panel || ''));
    check('回执给出「🔁 重试失败的 N 条」按钮', r.hasRetryBtn);
    check('提示词要求"只返回有改动的内容"（少收少发、降低超时概率）', r.promptSaysOmit);

    const r2 = await evalIn(`(async () => {
      window.__cap = []; window.__fakeDelay = 0;
      localStorage.setItem('diary_ai_fix_timeout_v1', '180');
      window.__fakeReply = JSON.stringify({ work: { text: '上午对甲站信号设备开展巡视检查，共检查信号机 3 处，发现 2 处问题（重试成功）。', changes: [{ type: '改写', from: '原文', to: '重试成功版' }] }, issues: [], regulations: [], ruleSuggest: [] });
      var btn = Array.prototype.slice.call(document.querySelectorAll('#diary-ai-fix-panel button')).filter(function (b) { return /重试失败的/.test(b.textContent); })[0];
      btn.click();
      await new Promise(r => setTimeout(r, 1500));
      var rec = window.__rec('2026-03-05') || {};
      return { work: rec.work, capN: window.__capN() };
    })()`);
    check('点「重试失败的 1 条」→ 只重跑失败那条且成功', r2.capN === 1 && /重试成功/.test(r2.work || ''), (r2.work || '').slice(0, 34));
  }

  // ---------- C10 回执"改动 N 处"必须与明细一致（用户实测：0 处却列了 2 条明细） ----------
  console.log('\n==== C10 计数=明细：模型自述改动 vs 真实改动 ====');
  {
    const r = await evalIn(`(async () => {
      window.getDiaryData().push({ date: '2026-03-10', work: '上午检查信号设备，一切正常。', issues: ['设备检查记录填写不规范'], regulations: [''] });
      // ① 模型"报告"了 1 处改动，但文本与底稿逐字一致 → 不能算改动、不能出明细（要如实说明）
      window.__cap = []; window.__fakeDelay = 0;
      window.__fakeReply = JSON.stringify({ issues: [{ i: 0, text: '设备检查记录填写不规范', changes: [{ type: '标点', from: '不规范', to: '不规范。' }] }], regulations: [], ruleSuggest: [] });
      await window.diaryAiRun('day:2026-03-10');
      var p1 = window.__panel();
      // ② 模型没报改动、但文本真的变了（沉默改动）→ 必须出现在明细里，且计数一致
      window.__cap = [];
      window.__fakeReply = JSON.stringify({ issues: [{ i: 0, text: '检查发现设备检查记录填写不规范，已当场指出。' }], regulations: [], ruleSuggest: [] });
      await window.diaryAiRun('day:2026-03-10');
      var rec = window.__rec('2026-03-10') || {};
      var p2 = window.__panel();
      var i = window.getDiaryData().map(function (x) { return x.date; }).indexOf('2026-03-10');
      if (i >= 0) window.getDiaryData().splice(i, 1);                          // 收尾：不留假数据
      localStorage.setItem('railway_work_diary_v2', JSON.stringify(window.getDiaryData()));
      return {
        p1Head: (p1.match(/✏️ 改动 \\d+ 处/) || [''])[0].replace(/\\s/g, ''),
        p1HasNote: /但与底稿逐字一致/.test(p1 || ''),
        p1Detail: /✏️ 改动明细/.test(p1 || ''),
        p2Head: (p2.match(/✏️ 改动 \\d+ 处/) || [''])[0].replace(/\\s/g, ''),
        p2DetailN: (p2.match(/· 修改：/g) || []).length,
        issue: (rec.issues || [])[0] || ''
      };
    })()`);
    check('模型报改动但文本一致 → 改动 0 处、不出明细', r.p1Head === '✏️改动0处' && !r.p1Detail, r.p1Head);
    check('并如实说明"与底稿逐字一致，未产生实际改动"', r.p1HasNote);
    check('模型漏报改动 → 明细显示真实 diff 且计数=1', r.p2Head === '✏️改动1处' && r.p2DetailN === 1 && /已当场指出/.test(r.issue), r.p2Head + ' / 明细行=' + r.p2DetailN);
  }

  // ---------- C11 点击即刻反馈（用户实测："气泡未立即启动"）----------
  console.log('\n==== C11 点击即刻反馈：按钮旁进度 + 回执框同 tick 生效（已无悬浮气泡） ====');
  {
    const r = await evalIn(`(async () => {
      // 走**真实点击路径**：把界面切到已种数据的日期，再调按钮的 onclick
      document.getElementById('diary-date').value = '2026-03-05';
      document.getElementById('diary-input-view').style.display = 'block';
      window.__cap = []; window.__fakeDelay = 0;
      window.__fakeReply = JSON.stringify({ issues: [], regulations: [], ruleSuggest: [] });
      window.diaryAiFix();                       // 故意不 await：下面读到的就是"点击那一瞬间"
      var first = {
        hasToastEl: !!document.getElementById('diary-ai-toast'),
        toast: (document.getElementById('diary-ai-toast') || {}).textContent || '',
        inline: (document.getElementById('diary-ai-fix-inline') || {}).textContent || '',
        panel: window.__panel().slice(0, 320),
        btnDisabled: !!(document.getElementById('diary-ai-fix-btn') || {}).disabled
      };
      await new Promise(r => setTimeout(r, 2500));       // 等它跑完（假模型即时返回）
      var after = {
        btnDisabled: !!(document.getElementById('diary-ai-fix-btn') || {}).disabled,
        hasToastEl: !!document.getElementById('diary-ai-toast'),
        toast: (document.getElementById('diary-ai-toast') || {}).textContent || '',
        panel: window.__panel()
      };
      document.getElementById('diary-input-view').style.display = 'none';
      return { first: first, after: after };
    })()`);
    check('已去掉悬浮气泡（#diary-ai-toast 不再创建）', r.first.hasToastEl === false && (r.first.toast || '') === '',
      'toast 元素存在=' + r.first.hasToastEl);
    check('点击瞬间按钮旁出现进度文字', /准备中|修改中/.test(r.first.inline || ''), r.first.inline);
    check('点击瞬间回执框已弹出（含进行中状态与两个区块）',
      /正在修改/.test(r.first.panel || '') && /建议补的规章依据/.test(r.first.panel || '') && /改动明细/.test(r.first.panel || ''), r.first.panel);
    check('运行期间按钮置灰（挡连点）', r.first.btnDisabled === true);
    check('跑完按钮恢复可用，结果只进回执框（不再弹完成气泡）',
      r.after.btnDisabled === false && r.after.hasToastEl === false && (r.after.toast || '') === '' && /一键修改完成/.test(r.after.panel || ''),
      'toast 元素存在=' + r.after.hasToastEl + ' / 回执含完成=' + /一键修改完成/.test(r.after.panel || ''));
  }

  // ---------- C12 条数硬规则：池 >3 → 3 条；池 ≤3 → 按实际条数（用户口径 2026-09-18） ----------
  console.log('\n==== C12 候选条数 = min(3, 池)：多于 3 给 3、≤3 按实际 ====');
  {
    const r = await evalIn(`(async () => {
      window.getDiaryData().push({ date: '2026-03-11', work: '对信号设备开展电气特性测试。',
        // 问题文本刻意覆盖 4 条新增规章的关键词（信号机/电气特性测试/环阻换算/轨道电路电缆），让候选池 >3
        issues: ['信号机显示不良，电气特性测试数据未与实际电缆长度的环阻换算值核对，轨道电路电缆补偿长度不符', '消防安全出口标识褪色'],
        regulations: ['', ''] });
      window.__cap = []; window.__fakeDelay = 0;
      // 模型这轮故意"只给 1 条"（实测它的常态）→ 条数必须由本地按池补齐保证
      window.__fakeReply = JSON.stringify({ issues: [], regulations: [], ruleSuggest: [
        { i: 0, rule: '不符合《铁路信号维护规则》第1条“测试数据应核对”的规定。', ref: '第1条', title: '铁路信号维护规则', why: '模型只给了一条' }
      ] });
      await window.diaryAiRun('day:2026-03-11');
      var p = window.__diaryAiLastPool || { cands: [] };
      var per = {};
      (p.cands || []).forEach(function (c) { per[c.issue] = (per[c.issue] || 0) + 1; });
      var btns = Array.prototype.slice.call(document.querySelectorAll('#diary-ai-fix-panel button')).filter(function (x) { return /采纳/.test(x.textContent); }).length;
      // 问题1 那一组自己的采纳按钮数（按"问题N"分块切 HTML）——条数规则必须**按问题**各自成立
      var _html = (document.getElementById('diary-ai-fix-panel') || {}).innerHTML || '';
      var _g1 = (_html.split(/问题\\d+/)[1] || '');
      var g1Btns = _g1.split(/>采纳<\\/button>/).length - 1;
      var out = { pool0: per[0] || 0, pool1: per[1] || 0, btns: btns, g1Btns: g1Btns, panel: window.__panel(),
                  hint: /共 3 个候选|共 \\d+ 个候选/.test(window.__panel() || '') };
      var i = window.getDiaryData().map(function (x) { return x.date; }).indexOf('2026-03-11');
      if (i >= 0) window.getDiaryData().splice(i, 1);                 // 收尾：不留假数据
      localStorage.setItem('railway_work_diary_v2', JSON.stringify(window.getDiaryData()));
      return out;
    })()`);
    check('池 >3 条的问题 → 恰好给 3 条（模型只给 1 条也会补齐）', r.pool0 >= 4 && r.g1Btns === 3, '池=' + r.pool0 + ' 问题1采纳按钮=' + r.g1Btns);
    check('条数=min(3,池) 覆盖两个问题（池 ' + r.pool0 + '→3，池 ' + r.pool1 + '→' + Math.min(3, r.pool1) + '）',
      r.btns === Math.min(3, r.pool0) + Math.min(3, r.pool1), '采纳按钮=' + r.btns);
    check('多候选的组仍提示"共 N 个候选"', r.hint);
    check('池里一条都没匹配到的那条问题被明确说明（不静默漏掉）',
      r.pool1 > 0 || /历史案例与规章库都没有匹配到可引用的条款/.test(r.panel || ''), '池1=' + r.pool1);
  }

  // ---------- C12b 每条问题各自最多 3 条候选（不是整篇合计，互不吃光） ----------
  console.log('\n==== C12b 多问题：每条问题独立给候选（互不吃光） ====');
  {
    const r = await evalIn(`(async () => {
      window.getDiaryData().push({ date: '2026-03-12', work: '开展信号设备检查与测试。',
        issues: ['信号机显示不良，未及时检查灯丝与点灯电路',
                 '电气特性测试数据未与实际电缆长度的环阻换算值核对',
                 '轨道电路电缆补偿长度不符合调整表要求',
                 '信号机灯丝断丝未立即更换并登记',
                 '调车作业未确认信号，存在安全隐患'],
        regulations: ['', '', '', '', ''] });
      window.__cap = []; window.__fakeDelay = 0;
      window.__fakeReply = JSON.stringify({ issues: [], regulations: [], ruleSuggest: [] });   // 模型一条候选都不给
      await window.diaryAiRun('day:2026-03-12');
      var p = window.__diaryAiLastPool || { cands: [] };
      var per = {};
      (p.cands || []).forEach(function (c) { per[c.issue] = (per[c.issue] || 0) + 1; });
      var expect = 0, pools = [];
      for (var i = 0; i < 5; i++) { pools.push(per[i] || 0); expect += Math.min(3, per[i] || 0); }
      var btns = Array.prototype.slice.call(document.querySelectorAll('#diary-ai-fix-panel button')).filter(function (x) { return /采纳/.test(x.textContent); }).length;
      var out = { pools: pools.join(','), btns: btns, expect: expect, panel: window.__panel(), nIssues: (window.__panel().match(/问题\\d/g) || []).length };
      var j = window.getDiaryData().map(function (x) { return x.date; }).indexOf('2026-03-12');
      if (j >= 0) window.getDiaryData().splice(j, 1);
      localStorage.setItem('railway_work_diary_v2', JSON.stringify(window.getDiaryData()));
      return out;
    })()`);
    const pools = (r.pools || '').split(',').map(Number);
    check('5 条问题各自都有候选池（互不吃光）', pools.filter(n => n > 0).length >= 4, '各问题池=' + r.pools);
    check('每条问题各给 min(3, 自己的池)：合计 ' + r.expect + ' 个采纳按钮', r.btns === r.expect, '实际=' + r.btns);
    check('回执按问题分组列出', r.nIssues >= 3, '问题分组数=' + r.nIssues);
  }

  // ---------- C13 引文以库内原文为准（用户实测：模型漏字 + 丢条号） ----------
  console.log('\n==== C13 引文逐字校正：模型漏字/缺条号 → 按库内原文修回 ====');
  {
    const r = await evalIn(`(async () => {
      // 用"信号机"这类问题：池里那条规章带条号（第十二条），才能检验"缺条号 → 按池补第X条"
      window.getDiaryData().push({ date: '2026-03-13', work: '开展信号设备检查。',
        issues: ['信号机显示不良，存在安全隐患'], regulations: [''] });
      // ① 先让系统给池（模型不给候选），拿到池里那条的原文
      window.__cap = []; window.__fakeDelay = 0;
      window.__fakeReply = JSON.stringify({ issues: [], regulations: [], ruleSuggest: [] });
      await window.diaryAiRun('day:2026-03-13');
      var p = window.__diaryAiLastPool || { cands: [] };
      var all = (p.cands || []).filter(function (c) { return c.issue === 0; });
      // 优先挑"能取到条号"的候选，这样"缺条号 → 补第X条"这条断言才有实际检验力
      var cand = all.filter(function (c) { return c.ref || window.__diaryAiDiag.articleNo(c.text || ''); })[0] || all[0];
      if (!cand) return { noCand: true };
      var m = String(cand.text || '').match(/《([^》]{1,60})》/);
      var pick = {
        cid: cand.cid,
        name: (cand.from === 'ledger') ? (m ? m[1] : '') : String(cand.title || ''),
        // 与 diaryAiFixRegSentence / diaryAiRegSentence 一致：引文正文会剥掉结尾的句号
        body: (window.__diaryAiDiag.regBody(cand.text) || '').replace(/[。.]\s*$/, ''),
        // 条号要用**归一化后的数字**（第十二条 → 12），与 diaryAiFixRegSentence 补进去的形态一致
        refNo: String(window.__diaryAiDiag.articleNo(cand.ref || '') || window.__diaryAiDiag.articleNo(cand.text) || '')
      };
      pick.mutated = pick.body.length > 6 ? (pick.body.slice(0, 3) + pick.body.slice(4)) : pick.body;   // 删掉第 4 个字：模拟漏字
      // ② 模型按池里那条来，但漏了一个字、且没写条号
      window.__cap = [];
      window.__fakeReply = JSON.stringify({ issues: [], regulations: [], ruleSuggest: [
        { i: 0, rule: '不符合《' + pick.name + '》“' + pick.mutated + '”的规定。', ref: '', title: pick.name, why: '模型改写版', cid: pick.cid }
      ] });
      await window.diaryAiRun('day:2026-03-13');
      var panel = window.__panel();
      var out = { name: pick.name, refNo: pick.refNo, bodyLen: pick.body.length,
                  mutGone: panel.indexOf(pick.mutated) === -1, bodyIn: panel.indexOf(pick.body) !== -1,
                  fixedNote: /引文与库内原文不一致/.test(panel),
                  refIn: pick.refNo ? panel.indexOf('第' + pick.refNo + '条') !== -1 : null };
      var j = window.getDiaryData().map(function (x) { return x.date; }).indexOf('2026-03-13');
      if (j >= 0) window.getDiaryData().splice(j, 1);
      localStorage.setItem('railway_work_diary_v2', JSON.stringify(window.getDiaryData()));
      return out;
    })()`);
    if (r.noCand) {
      check('C13 前提：该问题有候选池', false, '池中无候选，无法验证引文校正');
    } else {
      check('漏字的引文被按库内原文修回（原文出现、漏字版消失）', r.bodyLen > 0 && r.bodyIn && r.mutGone, '原文长度=' + r.bodyLen);
      check('缺条号时按池补上"第X条"', r.refIn === null || r.refIn === true, '池条号(归一化)=' + r.refNo + ' 命中=' + r.refIn);
      check('回执说明"已按库内原文逐字校正"', r.fixedNote);
    }
  }

  // ---------- C14 点击延迟：点一下要等多久（用户关切：加载快慢） ----------
  console.log('\n==== C14 点击延迟：回执框同步出现 / 首个请求耗时 ====');
  {
    const r = await evalIn(`(async () => {
      document.getElementById('diary-date').value = '2026-03-05';
      document.getElementById('diary-input-view').style.display = 'block';
      window.__cap = []; window.__fakeDelay = 0;
      window.__fakeReply = JSON.stringify({ issues: [], regulations: [], ruleSuggest: [] });
      var t0 = performance.now();
      window.diaryAiFix();                                  // 真实点击路径；故意不 await
      var t1 = performance.now();
      var panel = document.getElementById('diary-ai-fix-panel');
      var html = (panel || {}).innerHTML || '';
      var visible = !!panel && panel.style.display !== 'none' && html.length > 50;
      var waited = 0;
      while (waited < 20000 && !window.__capN()) { await new Promise(r => setTimeout(r, 20)); waited += 20; }
      var t2 = performance.now();
      await new Promise(r => setTimeout(r, 1200));           // 收尾：等它跑完
      document.getElementById('diary-input-view').style.display = 'none';
      return { syncMs: Math.round((t1 - t0) * 10) / 10, visible: visible, firstReqMs: Math.round(t2 - t0), capN: window.__capN() };
    })()`);
    check('点击后回执框同一 tick 出现（同步路径 <100ms）', r.visible === true && r.syncMs < 100, 'sync=' + r.syncMs + 'ms');
    check('点击→首个请求发出（含备份 + 对规召回预热）< 3s', r.capN > 0 && r.firstReqMs < 3000, 'firstReq=' + r.firstReqMs + 'ms');
  }

  // ---------- C15 未配置 API 接口 → 不显示「✨ 一键修改」按钮（用户口径 2026-09-19） ----------
  console.log('\n==== C15 未配置 API → 不显示一键修改按钮（配置变更可自动跟随） ====');
  {
    const r = await evalIn(`(async () => {
      var b = document.getElementById('diary-ai-fix-btn');
      window.diaryAiSyncBtn();                                  // seed 已写入 key（sk-audit）→ 应恢复显示
      var shown = b.style.display;
      // ① 未配置：隐藏
      localStorage.removeItem('ds_api_key_v1');
      window.diaryAiSyncBtn();
      var hidden = b.style.display;
      // ② 未配置时即便被调用（绕过隐藏）也必须拦下，且不发任何请求
      window.__cap = []; window.__fakeDelay = 0;
      window.__fakeReply = JSON.stringify({ issues: [], regulations: [], ruleSuggest: [] });
      var alerted = ''; var _al = window.alert; window.alert = function (m) { alerted = String(m || ''); };
      window.diaryAiFix();
      await new Promise(r => setTimeout(r, 250));
      window.alert = _al;
      var capAfterClick = window.__capN();
      // ③ 占位符 Key 也算未配置（与智能对话同口径）
      localStorage.setItem('ds_api_key_v1', 'YOUR_API_KEY_HERE');
      window.diaryAiSyncBtn();
      var placeholderHidden = b.style.display;
      // ④ 恢复真实 Key → 按钮回来
      localStorage.setItem('ds_api_key_v1', 'sk-audit');
      window.diaryAiSyncBtn();
      var shownAgain = b.style.display;
      return { shown: shown, hidden: hidden, capAfterClick: capAfterClick, alerted: alerted,
               placeholderHidden: placeholderHidden, shownAgain: shownAgain };
    })()`);
    check('已配置 Key → 按钮显示（配置变更可自动跟随）', r.shown === '' || r.shown === undefined, 'display=' + String(r.shown));
    check('未配置 → 按钮隐藏（display:none）', r.hidden === 'none', 'display=' + r.hidden);
    check('未配置时点按钮被拦下（提示填 Key）且不发请求', /API Key/.test(r.alerted || '') && r.capAfterClick === 0,
      'alert=' + (r.alerted || '无') + ' 请求数=' + r.capAfterClick);
    check('占位符 Key（YOUR_API_KEY_HERE）同样视为未配置', r.placeholderHidden === 'none', 'display=' + r.placeholderHidden);
    check('重新配置 Key → 按钮恢复显示', r.shownAgain === '' || r.shownAgain === undefined, 'display=' + String(r.shownAgain));
  }

  console.log('\n==== 汇总：' + results.filter(r => r.ok).length + '/' + results.length + ' 通过 ====');
  const failed = results.filter(r => !r.ok);
  if (failed.length) failed.forEach(f => console.log('  ❌ ' + f.name + '  «' + f.extra + '»'));

  try { await cdp.send('Browser.close'); } catch (e) {}
  ws.close(); child.kill(); server.close();
  try { fs.rmSync(profileDir, { recursive: true, force: true }); } catch (e) {}
  process.exit(failed.length ? 1 : 0);
}
main().catch((e) => { console.error('失败:', e); process.exit(1); });
