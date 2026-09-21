// 智能写作「提示词取证」脚本（可复用）：拦截 fetch，抓取真实发给模型的提示词，并模拟模型输出走完后处理
// 用途：改写作提示词/模板/资料逻辑后跑一次，检查 5 个典型场景里模型到底看到了什么、产出是否被校验。
// 用法：node scripts/writer-prompt-audit.js
const http = require('http'); const fs = require('fs'); const path = require('path'); const os = require('os');
const { spawn } = require('child_process');
const ROOT = path.resolve(__dirname, '..'), PORT = 8126, CDP_PORT = 9336;
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
  const profileDir = path.join(os.tmpdir(), 'aj-audit-wr-' + Date.now());
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
    if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 400)); return r.result.value; };
  const nav = async (u) => { const p = cdp.waitEvent('Page.loadEventFired', 60000, sessionId); await S('Page.navigate', { url: u }); await p; };
  const base = 'http://127.0.0.1:' + PORT + '/index.html';

  // ---------- 造数据 ----------
  await nav(base + '?seed=1'); await sleep(1200);
  console.log('seed:', await evalIn(`(async () => {
    const pad=(n,w)=>String(n).padStart(w,'0');
    // 台账：2026-03 共 120 条；其它月份 180 条
    const issues=[];
    const cats=['信号','调车','施工','消防'];
    for(let i=0;i<120;i++){const d='2026-03-'+pad(1+(i%28),2);issues.push({datetime:d+' 0'+(i%9)+':30:00','性质':['A类','B类','C类','红线'][i%4],category:cats[i%4],content:'3月第'+(i+1)+'号：'+cats[i%4]+'作业发现问题，已要求整改',regulation:'《铁路技术管理规程》第'+(i+1)+'条',unit:'甲站',trade:cats[i%4]});}
    for(let i=0;i<180;i++){issues.push({datetime:'2026-0'+(1+i%2)+'-'+pad(1+i%28,2)+' 10:00:00','性质':['A类','B类'][i%2],category:cats[i%4],content:'非本期记录'+(i+1),regulation:'x',unit:'乙站',trade:cats[i%4]});}
    // 规章
    const rules=[]; for(let i=0;i<200;i++) rules.push({title:'规章第'+(i+1)+'条',trade:cats[i%4],content:'第'+(i+1)+'条 关于'+cats[i%4]+'作业的安全要求：必须严格执行作业标准。'});
    // 模板：T1 安全检查月度报告（较旧）、T2 事故调查报告（最新=干扰项）、Tpc 带占位符、Tlong 超 6000 字
    const longBody = Array.from({length: 90}, (_,i)=>'第'+(i+1)+'节 检查内容与要求：'+'本节约三百字的检查要点与判定标准说明，用于测试长模板截断与骨架补全逻辑。'.repeat(6)).join('\\n');
    // 【用户真实场景】模板把"问题类型"枚举成章节（只列 4 类），而资料归纳出 6 类不同的问题 →
    //   按用户口径：必须"以资料为主"按 6 类写，骨架章节照旧，且不得把这 4 个枚举章节判成"缺失"。
    const t6 = { id: 1006, title: '检查情况报告（问题分类枚举到章节）', category: 'check', matType: 'template',
      content: '检查情况报告\\n一、总体情况\\n本期间检查工作的基本情况与数据汇总。\\n二、信号设备类问题\\n（本类问题的表现、处理与依据）\\n三、调车作业类问题\\n四、施工防护类问题\\n五、消防安全问题\\n六、原因分析\\n七、整改要求\\n八、下步工作',
      updatedAt: Date.now()-1800000 };
    const t1 = { id: 1001, title: '安全检查月度报告模板', category: 'monthly', matType: 'template', content: '安全检查月度报告\\n一、总体情况\\n本月共检查发现各类问题X件。\\n二、主要问题\\n（一）信号方面\\n（二）调车方面\\n三、原因分析\\n四、整改要求\\n五、下步工作', updatedAt: Date.now()-86400000 };
    const t2 = { id: 1002, title: '事故调查报告模板', category: 'accident', matType: 'template', content: '事故调查报告\\n一、事故概况\\n二、事故经过\\n三、原因分析\\n四、责任认定\\n五、防范措施', updatedAt: Date.now() };
    const tpc = { id: 1003, title: '月度报告（占位符版）模板', category: 'monthly', matType: 'template', content: '【检查信息月度报告】\\n一、总体情况\\n本期间共发现各类问题 {{问题总数}} 件，其中A类 {{A类数量}} 件、B类 {{B类数量}} 件、C类 {{C类数量}} 件、红线 {{红线数量}} 件。\\n二、典型问题\\n{{典型问题列表}}\\n三、整改要求\\n四、下步工作\\n统计期间：{{日期}}', updatedAt: Date.now()-3600000 };
    const tlong = { id: 1004, title: '长模板（无占位符）', category: 'check', matType: 'template', content: '长模板标题\\n一、总体情况\\n'+longBody+'\\n九、下步工作安排\\n', updatedAt: Date.now()-7200000 };
    // 资料：M1 故障报告、M2 文电、M3 超 5000 字长报告
    const m1 = { id: 2001, matType: 'fault', fileName: 'm1.txt', title: '3月信号设备故障报告', importAt: Date.now()-86400000, content: '2026年3月信号设备故障报告：甲站信号机发生红灯断丝故障2次，处理时长平均35分钟；原因多为灯泡老化与接触不良。' };
    const m2 = { id: 2002, matType: 'doc', fileName: 'm2.txt', title: '调车作业安全文电', importAt: Date.now()-172800000, content: '文电要求：调车作业必须确认信号，一度停车制度必须执行，严禁溜放作业。' };
    const m3 = { id: 2003, matType: 'fault', fileName: 'm3.txt', title: '3月综合故障分析报告（长）', importAt: Date.now()-3600000, content: '2026年3月综合故障分析报告正文：'+'甲站信号机故障处理过程、原因分析与整改措施说明。'.repeat(120)+'\\n【报告末尾关键结论】本期间共发生信号类故障5起，主要原因为设备老化与维护不到位，须在4月完成专项整治。' };
    // 再补 3 份不同类型资料 → 资料合计 6 类问题（与模板枚举的 4 类不同，用于验证"以资料为主"）
    const m4 = { id: 2004, matType: 'doc', fileName: 'm4.txt', title: '劳动安全专项检查通报', importAt: Date.now()-7200000, content: '通报：部分作业人员未按规定穿戴防护用品，个别班组班前会流于形式，需加强劳动安全教育与考核。' };
    const m5 = { id: 2005, matType: 'inspect', fileName: 'm5.txt', title: '路外安全隐患排查情况', importAt: Date.now()-10800000, content: '路外安全隐患排查：防护栅栏破损3处、道口警示标志缺失2处，已通知工务部门限期整改。' };
    const m6 = { id: 2006, matType: 'stats', fileName: 'm6.txt', title: '防洪防汛准备情况统计', importAt: Date.now()-21600000, content: '防洪物资储备尚缺编织袋200条；雨量警戒响应演练未按期开展，建议4月前完成补做。' };
    const open=(n,v,u)=>new Promise((res,rej)=>{const r=indexedDB.open(n,v);r.onupgradeneeded=e=>u&&u(e.target.result);r.onsuccess=()=>res(r.result);r.onerror=()=>rej(r.error);});
    const bulk=(db,s,a)=>new Promise((res,rej)=>{const tx=db.transaction(s,'readwrite');const st=tx.objectStore(s);st.clear();a.forEach(x=>st.put(x));tx.oncomplete=res;tx.onerror=()=>rej(tx.error);});
    const idb=await open('RailwayIssueDB_v2',3,db=>{if(!db.objectStoreNames.contains('issues'))db.createObjectStore('issues',{keyPath:'id',autoIncrement:true});});
    await bulk(idb,'issues',issues);
    const rdb=await open('RailwayRuleDB',3,db=>{if(!db.objectStoreNames.contains('ruleCollection'))db.createObjectStore('ruleCollection',{keyPath:'id',autoIncrement:true});});
    await bulk(rdb,'ruleCollection',[{id:1,data:rules}]);
    const wdb=await open('railway_writer_db',2,db=>{['writing_materials','writing_reports','writing_templates'].forEach(s=>{if(!db.objectStoreNames.contains(s))db.createObjectStore(s,{keyPath:'id',autoIncrement:true});});});
    await bulk(wdb,'writing_materials',[t1,t2,tpc,tlong,t6,m1,m2,m3,m4,m5,m6]);
    await bulk(wdb,'writing_reports',[
      {id:3101,title:'2月安全检查月度报告',category:'monthly',date:Date.now()-2592000000,content:'2月报告正文：共发现问题98件……（文风参考）'},
      {id:3102,title:'1月安全情况报告',category:'monthly',date:Date.now()-5184000000,content:'1月报告正文：……'}
    ]);
    localStorage.setItem('ds_api_key_v1','sk-audit');
    localStorage.setItem('current_module','doubao');
    localStorage.setItem('ds_providers_v1',JSON.stringify([{id:'p_a',name:'审计用',apiUrl:'https://api.deepseek.com/chat/completions',model:'deepseek-flash',apiKey:'sk-audit'}]));
    localStorage.setItem('ds_active_provider_v1','p_a');
    window.__ids = { t1:1001, t2:1002, tpc:1003, tlong:1004, m1:2001, m2:2002, m3:2003 };
    return 'ok';
  })()`));

  await nav(base + '?v=1'); await sleep(4000);

  // 安装 fetch 拦截 + 场景执行器
  console.log('install:', await evalIn(`(() => {
    window.__cap = [];       // 流式（正文）请求
    window.__capPlan = [];   // 非流式（归类表 / 补写章节）请求
    if (!window.__origFetch) window.__origFetch = window.fetch;
    window.fetch = async function(url, opt) {
      try {
        if (opt && opt.method === 'POST' && typeof opt.body === 'string') {
          const body = JSON.parse(opt.body);
          const sys = (body.messages.filter(m => m.role === 'system')[0] || {}).content || '';
          const usr = (body.messages.filter(m => m.role === 'user').slice(-1)[0] || {}).content || '';
          if (body.stream === false) {
            // 非流式：按"提示词内容"合成应答（归类表 / 补写章节），使审调能覆盖真实链路
            window.__capPlan.push({ url: String(url), body: body, kind: /归类/.test(sys) ? 'plan' : (/补写/.test(sys) ? 'continue' : 'other') });
            let content = '{"sections":[]}';
            if (/归纳/.test(sys) && usr.indexOf('模板骨架章节') !== -1) {
              const seg = usr.split('【模板骨架章节（sections.label 只能用这些）】')[1] || '';
              const labels = seg.split('\\n').slice(1).map(l => l.trim()).filter(l => l && l[0] !== '【');
              // 资料份数 → 合成"资料归纳出的问题类型"（审调：故意用与模板不同的类型/数量）
              const matSeg = usr.split('【资料清单（编号即引用号，正文将用【资料N】标注出处）】')[1] || '';
              const matCount = (matSeg.match(/^资料\\d+【/gm) || []).length || 3;
              const names = ['信号设备类','调车作业类','施工防护类','消防管理类','劳动安全类','路外环境类','防洪防汛类','应急处置类'];
              const problemTypes = [];
              for (let i = 0; i < matCount; i++) {
                problemTypes.push({ name: names[i % names.length], section: labels[1] ? labels[1].split('：')[0].trim() : '', materials: [i + 1], points: ['资料' + (i + 1) + ' 的要点（审调合成）'] });
              }
              content = JSON.stringify({
                problemTypes: problemTypes,
                sections: labels.map(l => ({ label: l.split('：')[0].trim(), uses: [1], points: ['来自资料的要点（审调合成）'] })),
                unused: []
              });
            } else if (/补写/.test(sys) && usr.indexOf('【需补写的章节（按此顺序输出）】') !== -1) {
              const seg = (usr.split('【需补写的章节（按此顺序输出）】')[1] || '').split('【已生成正文')[0];
              // 只取"像章节标题"的行，避免把提示词脚手架（"请开始补写："等）抄进正文
              const labels = seg.split('\\n').map(s => s.trim())
                .filter(s => /^(?:[一二三四五六七八九十]+[、.．]|[（(][一二三四五六七八九十\\d]+[)）]|\\d+[、.．]|#{1,6}\\s)/.test(s))
                .map(s => s.split('：')[0].trim());
              content = labels.map(l => l + '\\n本节为自动补写内容（审调占位），数据沿用台账口径。').join('\\n\\n');
            }
            return new Response(JSON.stringify({ choices: [{ message: { content: content } }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
          }
          window.__cap.push({ url: String(url), body: body });
          const out = window.__fakeOut || '（空）';
          return new Response(new ReadableStream({ start(c) {
            const enc = new TextEncoder();
            c.enqueue(enc.encode('data: ' + JSON.stringify({ choices: [{ delta: { content: out } }] }) + '\\n\\n'));
            c.enqueue(enc.encode('data: [DONE]\\n\\n'));
            c.close();
          } }), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
        }
      } catch (e) { console.warn('cap err', e); }
      return window.__origFetch.apply(this, arguments);
    };
    window.__runScenario = async function(cfg) {
      // 默认假输出：只写 1 个章节 + 编造数字 —— 用来检测"是否有章节/数字校验"
      window.__fakeOut = cfg.fakeOut || '# 报告\\n一、总体情况\\n经检查，共发现问题 9999 条（编造数字，用于检测是否有校验）。\\n';
      window._wrSelectedTemplate = cfg.template || null;
      window._wrSelectedMaterialIds = cfg.matIds || [];
      window._wrSkipLocalSearch = false;
      // 补充/修改轮：模拟弹窗把「底稿 + 新增资料」交给生成流程（与 wrConfirmModify / wrModifyHistoryReport 一致）
      window._wrModifyMode = !!cfg.modify;
      window._wrModifyBaseContent = cfg.modify ? cfg.modify.base : null;
      window._wrModifyBaseTitle = cfg.modify ? '审计底稿' : null;
      window._wrModifyCategory = cfg.modify ? 'other' : null;
      window._wrModifySuppMats = cfg.modify ? cfg.modify.supp : null;
      const inp = document.getElementById('wr-query-input');
      inp.value = cfg.query;
      window.__cap = []; window.__capPlan = [];
      try { await window.wrGenerate(); } catch (e) { window.__scenarioErr = String(e && e.message || e); }
      const cap = window.__cap[window.__cap.length - 1] || null;
      const sys = cap ? (cap.body.messages.filter(m => m.role === 'system')[0] || {}).content || '' : '';
      const usr = cap ? (cap.body.messages.filter(m => m.role === 'user').slice(-1)[0] || {}).content || '' : '';
      const all = sys + '\\n' + (typeof usr === 'string' ? usr : JSON.stringify(usr));
      let saved = null;
      try { const rs = await window._wrGetAllReports(); saved = rs[rs.length - 1] || null; } catch (e) {}
      const bubble = document.getElementById('wr-chat-history');
      return {
        captured: !!cap,
        model: cap ? cap.body.model : '',
        sysChars: sys.length, userChars: (typeof usr === 'string' ? usr : '').length,
        planCalls: window.__capPlan.length,
        ledger: window.__wrLedger || null,
        p: {
          tplBlock: /【写作模板|【模板章节结构/.test(all),
          tplSectionTree: /【模板章节结构（硬约束/.test(all),
          tplSkeleton: /【模板章节标题骨架/.test(all),
          tplHasDataMarks: (all.match(/【数据:/g) || []).length,
          ledgerStats: /【台账统计数据/.test(all),
          ledgerEmpty: /暂无匹配台账数据/.test(all),
          matBlock: /【本地资料（共(\\d+)份/.test(all) ? (all.match(/【本地资料（共(\\d+)份/) || [])[1] : '0',
          matTruncatedCount: (all.match(/已截断/g) || []).length,
          rulesBlock: /【参考规章条款/.test(all),
          reportsBlock: /【历史报告参考/.test(all),
          planBlock: /【资料归类表/.test(all),
          citationRule: /【引用规范】/.test(all),
          skeletonMarked: /【骨架】/.test(all),
          enumMarked: /【枚举\\/参照】/.test(all),
          problemTypeCount: (all.match(/【资料归纳出的问题类型（共\\s*(\\d+)\\s*类）/) || [])[1] || '0',
          materialFirstRule: /以资料为准/.test(sys),
          jsonTaskMode: /【任务要求】/.test(sys) && /纯 JSON/.test(sys),
          hardConstraint: /【硬约束】|（硬约束/.test(sys + all),
          searchNeeded: /【搜索或关联本地数据的要求】/.test(all),
          casesBlock: /【匹配到的历史案例/.test(all),
          // ---- 补充/修改轮专属检查 ----
          modBaseBlock: /【当前报告（底稿）/.test(all),
          modAskBlock: /【补充\\/修改要求】/.test(all),
          modSuppBlock: /【新增资料（共\\d+份）/.test(all),
          modSuppNumbered: /── 补充资料1/.test(all),
          modFullOutput: /完整报告全文/.test(all),
          modRewriteRule: /再加工/.test(all),
          // "再加工"是直接写与继续写**共同**要求，故单独标记（常规轮也必须为 true）
          reworkRule: /再加工/.test(all),
          reworkClause4: /【引用资料：先"归位"、再"再加工"/.test(all),
          rulesExcerpt: (sys.match(/【写作规范】[\\s\\S]{0,1500}/) || [''])[0],
          modNoTplNoLedger: !/【模板章节结构|【台账统计数据|【本地资料（共/.test(all)
        },
        outChars: (window._wrCurrentReportContent || '').length,
        outHead: (window._wrCurrentReportContent || '').slice(0, 200),
        outHasFakeNumber: /9999/.test(window._wrCurrentReportContent || ''),
        outHasAutoContinued: /自动补写内容（审调占位）/.test(window._wrCurrentReportContent || ''),
        savedTitle: saved ? saved.title : null,
        savedContentLen: saved ? (saved.content || '').length : 0,
        savedHasFakeNumber: saved ? /9999/.test(saved.content || '') : null,
        savedMaterialCount: saved ? JSON.stringify(saved.materialCount) : null,
        savedSectionCheck: saved && saved.sectionCheck ? JSON.stringify(saved.sectionCheck) : null,
        savedQc: saved && saved.qc ? JSON.stringify(saved.qc) : null,
        numChecked: saved && saved.qc && saved.qc.numbers ? saved.qc.numbers.checked : null,
        numUntraced: saved && saved.qc && saved.qc.numbers ? saved.qc.numbers.untraced.map(function (x) { return x.value + 'x' + x.count; }).join(',') : null,
        numSamples: saved && saved.qc && saved.qc.numbers ? saved.qc.numbers.untraced.slice(0, 3).map(function (x) { return x.value + ' @「' + x.sample + '」'; }).join(' | ') : null,
        reportTail: (window._wrCurrentReportContent || '').slice(-120),
        bubbleHasNumberCheck: /数字溯源/.test((document.getElementById('wr-chat-history') || {}).textContent || ''),
        bubbleHasSectionCheck: /架构校验/.test((document.getElementById('wr-chat-history') || {}).textContent || ''),
        bubbleTail: (((document.getElementById('wr-chat-history') || {}).textContent) || '').slice(-260),
        bubbleHasQc: /产出回执/.test((document.getElementById('wr-chat-history') || {}).textContent || ''),
        err: window.__scenarioErr || null
      };
    };
    return 'ready';
  })()`));

  const scenarios = [
    { key: 'S1 自然语(无分隔)', query: '写一份2026年3月安全检查月度报告', matIds: [], template: null },
    { key: 'S2 带分隔关键词', query: '2026年3月 安全检查 月度报告', matIds: [], template: null },
    { key: 'S3 手选资料+手选模板(占位符)', query: '写一份2026年3月安全检查月度报告', matIds: [2001, 2003], template: null, usePc: true, fakeOut: '{"问题总数":"9999","A类数量":"1","B类数量":"2","C类数量":"3","红线数量":"4","典型问题列表":"甲站信号机故障\\\\n乙站调车未确认信号","日期":"2026年3月"}' },
    { key: 'S4 手选资料+要求检索', query: '检索本地数据，写一份2026年3月安全检查月度报告', matIds: [2001], template: null },
    { key: 'S5 超长模板(无占位符)', query: '2026年3月 安全检查 报告', matIds: [], template: { id: 1004, title: '长模板（无占位符）', content: '' } },
    { key: 'S6 模板枚举4类问题/资料6类(以资料为准)', query: '2026年3月 安全检查 报告', matIds: [2001, 2002, 2003, 2004, 2005, 2006], template: null, templateRefId: 1006,
      fakeOut: '检查情况报告\n一、总体情况\n本期间共检查发现问题 120 条（来自台账）。\n二、信号设备类问题\n表现与处理（【资料1】）。\n三、调车作业类问题\n表现与处理（【资料2】）。\n四、施工防护类问题\n表现与处理。\n五、消防管理类问题\n表现与处理。\n六、劳动安全类问题\n表现与处理（【资料4】）。\n七、路外环境类问题\n表现与处理（【资料5】）。\n八、原因分析\n原因说明。\n九、整改要求\n整改说明。\n十、下步工作\n下步安排。' },
    { key: 'S7 有资料但明确要求用台账(特殊说明)', query: '2026年3月 按台账统计 撰写安全检查报告', matIds: [2001, 2002], template: null, templateRefId: 1006 },
    { key: 'S8 无相关资料(纯台账梳理总结)', query: '2026年3月 锅炉压力容器 检验报告', matIds: [], template: null, templateRefId: 1006, noMaterials: true },
    // S9：补充/修改轮（"继续修改 = 补充"）——底稿里 120/30/40 与新增资料的 28 应算"有出处"，
    //     模型新编的 8888 必须被点名；fakeOut 故意漏掉"五、下步工作"以验证"对照底稿的章节校验 + 自动补写"。
    { key: 'S9 补充轮(继续修改=补充)', query: '把新增的信号机故障案例补进"主要问题"，语句更书面化',
      modify: {
        base: '安全检查月度报告\n一、总体情况\n2026年3月共发现问题 120 条，其中A类 30 条、B类 40 条。\n二、主要问题\n（一）信号方面：甲站信号机发生红灯断丝故障 2 次（【资料1】）。\n三、原因分析\n设备老化与维护不到位。\n四、整改要求\n4月完成专项整治。\n五、下步工作\n加强日常巡检与考核。',
        supp: [{ title: '4月信号机故障补充通报', content: '补充：乙站信号机发生红灯断丝故障3次，平均处理时长28分钟，主要原因为灯丝老化；建议纳入专项整治。', matType: 'fault' }]
      },
      fakeOut: '安全检查月度报告\n一、总体情况\n2026年3月共发现问题 120 条，其中A类 30 条、B类 40 条。\n二、主要问题\n（一）信号方面：甲站信号机发生红灯断丝故障 2 次；新增乙站信号机红灯断丝故障 3 次，平均处理时长 28 分钟，暴露灯丝老化问题（【补充资料1】）。\n三、原因分析\n设备老化与维护不到位，累计排查出 8888 处隐患。\n四、整改要求\n4月完成专项整治并加强巡检。' }
  ];

  for (const sc of scenarios) {
    const payload = { query: sc.query, matIds: sc.matIds, template: sc.template, fakeOut: sc.fakeOut };
    if (sc.modify) payload.modify = sc.modify;
    if (sc.usePc) payload.templateRefId = 1003;
    if (sc.templateRefId) payload.templateRefId = sc.templateRefId;
    const expr = `(async () => {
      const cfg = ${JSON.stringify(payload)};
      if (cfg.templateRefId) {
        const all = await window._wrGetAllMaterials();
        cfg.template = all.filter(m => m.id === cfg.templateRefId)[0];
      }
      if (cfg.template && cfg.template.id === 1004) {
        const all = await window._wrGetAllMaterials();
        cfg.template = all.filter(m => m.id === 1004)[0];
      }
      return window.__runScenario(cfg);
    })()`;
    let res;
    try { res = await evalIn(expr); } catch (e) { res = { err: String(e.message).slice(0, 300) }; }
    console.log('\n======== ' + sc.key + ' ========');
    console.log(JSON.stringify(res, null, 1));
    // 速览行：一眼看完"再加工规则是否下发 / 数字是否被点 / 台账口径 / 章节校验"
    if (res && res.p) {
      const sec = res.savedSectionCheck ? JSON.parse(res.savedSectionCheck) : null;
      console.log('---- 速览：再加工规则=' + (res.p.reworkRule ? '✅' : '❌')
        + ' | 归位规则=' + (res.p.reworkClause4 || res.p.modRewriteRule ? '✅' : '❌')
        + ' | 数字无出处=' + (res.numUntraced === '' ? '（无）' : String(res.numUntraced))
        + ' | 台账=' + (res.ledger ? res.ledger.reason : '-')
        + ' | 章节=' + (sec ? sec.found + '/' + sec.total + (sec.continued ? '(补写)' : '') : '-')
        + ' | err=' + res.err);
    }
  }

  try { await cdp.send('Browser.close'); } catch (e) {}
  ws.close(); child.kill(); server.close();
  try { fs.rmSync(profileDir, { recursive: true, force: true }); } catch (e) {}
  process.exit(0);
}
main().catch((e) => { console.error('失败:', e); process.exit(1); });
