#!/usr/bin/env node
/**
 * boot-bench.js — 安监系统「启动耗时」基准测试（零依赖）
 * ===================================================
 * 做三件事：
 *   1) 起一个本地静态服务器（托管项目根目录，HTTP 缓存 no-store，避免旧文件干扰）
 *   2) 用系统 Edge（无头 + CDP）打开站点，**造一份接近真实的仿真数据**
 *      （检查信息 4 万条 / 规章 / 手册 / 电话 / 日志 / 写作资料与报告），并让 KB 写好索引缓存
 *   3) 连续冷启动 N 次，采集启动各阶段时间点、长任务、堆占用，打印中位数
 *
 * 用法：
 *   node scripts/boot-bench.js                      # 默认 3 次
 *   node scripts/boot-bench.js --runs 5 --fresh     # 5 次 + 重新造数据
 *   node scripts/boot-bench.js --label before       # 结果里带上标签
 *   node scripts/boot-bench.js --issue-limit all    # 仿真用户「索引范围=全部」的配置
 *
 * 说明：每次运行使用**全新的浏览器 profile**（清空 SW/HTTP/IDB 缓存），
 *       因此"改前 / 改后"两次运行条件完全一致，差值即为代码改动的影响。
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const EDGE_CANDIDATES = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  path.join(process.env.LOCALAPPDATA || '', 'Google\\Chrome\\Application\\chrome.exe')
];

// ---------------- 参数 ----------------
const argv = process.argv.slice(2);
function arg(name, def) {
  const i = argv.indexOf('--' + name);
  return i >= 0 && argv[i + 1] && argv[i + 1][0] !== '-' ? argv[i + 1] : def;
}
const RUNS = parseInt(arg('runs', '3'), 10);
const LABEL = arg('label', '');
const ISSUE_LIMIT = arg('issue-limit', '12000');
// 启动时停留的模块（对应 localStorage.current_module）：默认 issue
// 传 doubao 可量「用户上次就停在智能助手」的对照场景
const START_MODULE = arg('start-module', 'issue');
const FRESH = argv.includes('--fresh');
const KEEP_PROFILE = argv.includes('--keep-profile');
const PORT = parseInt(arg('port', '8123'), 10);
const CDP_PORT = parseInt(arg('cdp-port', '9333'), 10);

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.webm': 'video/webm', '.wav': 'audio/wav', '.woff2': 'font/woff2'
};

// ---------------- 静态服务器 ----------------
function startServer() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      try {
        let p = decodeURIComponent(req.url.split('?')[0]);
        if (p === '/' || p === '') p = '/index.html';
        const file = path.join(ROOT, p);
        if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
          res.writeHead(404); res.end('not found'); return;
        }
        res.writeHead(200, {
          'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
          'Cache-Control': 'no-store',
          'Service-Worker-Allowed': '/'
        });
        fs.createReadStream(file).pipe(res);
      } catch (e) { res.writeHead(500); res.end(String(e)); }
    });
    server.listen(PORT, '127.0.0.1', () => resolve(server));
  });
}

// ---------------- 极简 CDP 客户端 ----------------
class CDP {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map(); this.listeners = [];
    ws.addEventListener('message', (ev) => {
      let msg; try { msg = JSON.parse(ev.data); } catch (e) { return; }
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
      } else if (msg.method) {
        this.listeners.forEach((f) => f(msg));
      }
    });
  }
  send(method, params = {}, sessionId) {
    const id = ++this.id;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    this.ws.send(JSON.stringify(payload));
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error('CDP timeout: ' + method)); } }, 120000);
    });
  }
  waitEvent(method, timeoutMs = 30000, sessionId) {
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('waitEvent timeout: ' + method)), timeoutMs);
      const fn = (msg) => {
        if (msg.method === method && (!sessionId || msg.sessionId === sessionId)) {
          clearTimeout(t); this.listeners = this.listeners.filter((x) => x !== fn); resolve(msg.params);
        }
      };
      this.listeners.push(fn);
    });
  }
}

function findBrowser() {
  for (const p of EDGE_CANDIDATES) { try { if (p && fs.existsSync(p)) return p; } catch (e) {} }
  throw new Error('未找到 Edge/Chrome');
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------- 注入到页面的采集脚本（在任何页面脚本之前执行） ----------------
const HARNESS = `
(() => {
  const B = window.__bench = { t0: 0, marks: {}, lt: [], errs: [] };
  const now = () => Math.round(performance.now());
  B.marks.nav = 0;
  document.addEventListener('DOMContentLoaded', () => { B.marks.dcl = now(); });
  window.addEventListener('load', () => { B.marks.load = now(); });
  window.addEventListener('error', (e) => { try { B.errs.push(String(e.message || e.target && e.target.src || '').slice(0,120)); } catch (_) {} }, true);
  try {
    new PerformanceObserver((list) => {
      list.getEntries().forEach((en) => { B.lt.push({ s: Math.round(en.startTime), d: Math.round(en.duration) }); });
    }).observe({ type: 'longtask', buffered: true });
  } catch (e) {}
  // 启动遮罩消失（= 用户看到界面）
  (function pollOverlay() {
    if (B.marks.overlayGone != null) return;
    if (document.getElementById('app-boot-overlay') === null && document.body) { B.marks.overlayGone = now(); return; }
    requestAnimationFrame(pollOverlay);
  })();
  // 轮询：台账数据就绪 / KB 索引就绪
  (function poll() {
    if (B.marks.issueReady == null && window.__issueDataReady) B.marks.issueReady = now();
    if (B.marks.kbReady == null && window.KB && typeof KB.stats === 'function') {
      try {
        const rows = KB.stats();
        const built = rows.filter((r) => r.built).length;
        if (built >= 5) B.marks.kbBuilt = B.marks.kbBuilt || { n: built, t: now() };
        if (built >= rows.length) B.marks.kbReady = now();
      } catch (e) {}
    }
    setTimeout(poll, 100);
  })();
  B.report = () => {
    const lt = B.lt;
    const win = lt.filter((x) => x.s <= 12000);
    const heap = (performance.memory && performance.memory.usedJSHeapSize) || 0;
    return JSON.stringify({
      marks: B.marks,
      longtask: {
        n: win.length,
        total: win.reduce((s, x) => s + x.d, 0),
        max: win.reduce((m, x) => Math.max(m, x.d), 0),
        list: win.map((x) => x.s + '+' + x.d).slice(0, 30)
      },
      heapMB: +(heap / 1048576).toFixed(1),
      kb: (window.KB && KB.stats) ? KB.stats().map((r) => r.key + ':' + (r.built ? '1' : '0') + '/' + r.total) : [],
      errs: B.errs
    });
  };
})();
`;

// ---------------- 造数据 + 建立索引缓存 ----------------
function seedScript(issueLimit, startModule) {
  return `(async () => {
  const log = [];
  localStorage.setItem('current_module', ${JSON.stringify(startModule)});
  localStorage.setItem('kb_issue_limit', ${JSON.stringify(issueLimit)});
  localStorage.setItem('kb_autoload', '1');
  // ---- 生成仿真数据 ----
  const units = ['甲站','乙站','丙站','丁站','戊站','己站','庚站','辛站'];
  const cats  = ['接发列车','调车作业','施工维修','劳动安全','设备管理','消防管理','防洪防汛','路外安全'];
  const natures = ['A类','B类','C类','红线'];
  const mats = ['安全带未按规定佩戴','作业人员未穿防护服','道岔密贴调整不当','施工登销记不规范','行车凭证填写错误',
                '调车作业未确认信号','防护栅栏破损未修复','消防器材过期未更换','值班记录填写不规范','设备巡检漏项',
                '作业前未召开班前会','雨量警戒未及时响应'];
  const regs = ['《铁路技术管理规程》第{1}条','《行车组织规则》第{1}条','《铁路劳动安全规则》第{1}条','《铁路调车作业标准》第{1}条'];
  const pad = (n, w) => String(n).padStart(w, '0');
  const dt = (i) => { const y = 2019 + (i % 7), mo = 1 + (i % 12), d = 1 + (i % 28), h = i % 24, mi = i % 60;
    return y + '-' + pad(mo,2) + '-' + pad(d,2) + ' ' + pad(h,2) + ':' + pad(mi,2) + ':' + pad(i % 60, 2); };
  const rid = (i) => String(1 + (i % 600)).padStart(3, '0');
  const issues = new Array(40000);
  for (let i = 0; i < issues.length; i++) {
    const m = mats[i % mats.length];
    issues[i] = {
      datetime: dt(i), '性质': natures[i % natures.length], category: cats[i % cats.length],
      content: m + '（第' + (i + 1) + '号记录，' + units[i % units.length] + '现场检查发现该问题，' + '已要求立即整改并复查确认）',
      regulation: regs[i % regs.length].replace('{1}', rid(i)),
      unit: units[i % units.length], trade: cats[i % cats.length], source: 'bench'
    };
  }
  const rules = [];
  for (let i = 0; i < 687; i++) {
    rules.push({ title: '规章第' + (i + 1) + '条 作业安全要求', trade: cats[i % cats.length],
      content: '第' + (i + 1) + '条 各单位应当严格执行' + cats[i % cats.length] + '相关作业标准，落实安全卡控措施，'
        + '对' + mats[i % mats.length] + '等情形应当立即制止并整改。' + '（规章正文占位内容，用于仿真检索规模）'.repeat(3) });
  }
  const handbook = [];
  for (let i = 0; i < 1305; i++) {
    handbook.push({ chapter: '第' + (1 + i % 6) + '章', section: '第' + (1 + i % 9) + '节',
      item: '项点' + (i + 1), subitem: '子项' + (i % 4 + 1),
      content: '检查' + cats[i % cats.length] + '时应当核对' + mats[i % mats.length] + '，并做好记录。'.repeat(2) });
  }
  const phone = [];
  for (let i = 0; i < 839; i++) {
    phone.push({ '站名': units[i % units.length] + (i + 1), '单位': units[i % units.length] + '车间',
      '线名': ['京广线','京沪线','陇海线','京哈线'][i % 4], '姓名': '值班员' + (i + 1),
      '电话': '138' + pad(i, 8), '职务': ['值班员','调度员','工长'][i % 3] });
  }
  const diary = [];
  for (let i = 0; i < 42; i++) {
    diary.push({ date: '2026-0' + (1 + i % 9) + '-' + pad(1 + i % 28, 2),
      weather: ['晴','多云','小雨'][i % 3],
      content: '今日现场检查' + units[i % units.length] + '，检查' + cats[i % cats.length] + '作业，发现问题已录入台账。' });
  }
  const materials = [], reports = [];
  for (let i = 0; i < 73; i++) {
    materials.push({ title: '写作资料' + (i + 1), type: 'text', source: 'bench', createdAt: Date.now() - i * 86400000,
      content: '铁路安全检查资料内容占位。'.repeat(40) });
  }
  for (let i = 0; i < 52; i++) {
    reports.push({ title: '历史报告' + (i + 1), type: 'text', source: 'bench', createdAt: Date.now() - i * 86400000,
      content: '月度安全检查情况报告正文占位。'.repeat(60) });
  }
  localStorage.setItem('railway_work_diary_v2', JSON.stringify(diary));
  localStorage.setItem('railway_phone_db_v1', JSON.stringify(phone));
  localStorage.setItem('handbook_fourlevel_v1', JSON.stringify(handbook));

  // 对话历史（量"智能助手首次渲染"的成本：24 会话 × 30 条消息 ≈ 数百 KB）
  const convs = [];
  for (let i = 0; i < 24; i++) {
    const msgs = [];
    for (let j = 0; j < 30; j++) {
      msgs.push({ role: (j % 2) ? 'assistant' : 'user',
        content: '第 ' + (i * 30 + j + 1) + ' 轮：检查发现问题与整改要求说明。'.repeat(10) });
    }
    convs.push({ id: 'bench_c' + i, title: '仿真会话 ' + (i + 1), messages: msgs, timestamp: Date.now() - i * 86400000, pinned: i < 2 });
  }
  localStorage.setItem('ds_conversations_v1', JSON.stringify(convs));
  localStorage.setItem('ds_api_key_v1', 'sk-bench');   // 让"已配置 API"分支生效（与真实使用一致）
  log.push('conversations ' + convs.length + '×30');

  // ---- 写 IndexedDB ----
  const openDB = (name, ver, upgrade) => new Promise((res, rej) => {
    const req = ver ? indexedDB.open(name, ver) : indexedDB.open(name);
    req.onupgradeneeded = (e) => { if (upgrade) upgrade(e.target.result); };
    req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error);
  });
  const bulk = (db, store, arr, batch) => new Promise((res, rej) => {
    const tx = db.transaction(store, 'readwrite');
    const st = tx.objectStore(store);
    st.clear();
    arr.forEach((it) => st.put(it));
    tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error);
  });

  const issueDB = await openDB('RailwayIssueDB_v2', 3, (db) => {
    if (!db.objectStoreNames.contains('issues')) db.createObjectStore('issues', { keyPath: 'id', autoIncrement: true });
  });
  await bulk(issueDB, 'issues', issues);
  log.push('issues ' + issues.length);

  const ruleDB = await openDB('RailwayRuleDB', 3, (db) => {
    if (!db.objectStoreNames.contains('ruleCollection')) db.createObjectStore('ruleCollection', { keyPath: 'id', autoIncrement: true });
    if (!db.objectStoreNames.contains('rule_images')) db.createObjectStore('rule_images', { keyPath: 'id' });
  });
  await bulk(ruleDB, 'ruleCollection', [{ id: 1, data: rules }]);
  log.push('rules ' + rules.length);

  const wrDB = await openDB('railway_writer_db', 2, (db) => {
    ['writing_materials','writing_reports','writing_templates'].forEach((s) => {
      if (!db.objectStoreNames.contains(s)) db.createObjectStore(s, { keyPath: 'id', autoIncrement: true });
    });
  });
  await bulk(wrDB, 'writing_materials', materials);
  await bulk(wrDB, 'writing_reports', reports);
  log.push('materials ' + materials.length + ' reports ' + reports.length);

  window.__seeded = log.join(' | ');
  return window.__seeded;
})()`;
}

// ---------------- 主流程 ----------------
async function main() {
  const profileDir = path.join(os.tmpdir(), 'aj-bench-' + Date.now());
  fs.mkdirSync(profileDir, { recursive: true });
  const server = await startServer();
  const base = 'http://127.0.0.1:' + PORT + '/';

  const browserPath = findBrowser();
  const child = spawn(browserPath, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--disable-features=Translate,OptimizationHints', '--remote-debugging-port=' + CDP_PORT,
    '--user-data-dir=' + profileDir, 'about:blank'
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  let browserLog = '';
  child.stderr.on('data', (d) => { browserLog += d.toString(); });

  let versionInfo = null;
  for (let i = 0; i < 60; i++) {
    try { versionInfo = await (await fetch('http://127.0.0.1:' + CDP_PORT + '/json/version')).json(); break; }
    catch (e) { await sleep(300); }
  }
  if (!versionInfo) { console.error('浏览器未能启动：\n' + browserLog); process.exit(1); }

  const ws = new WebSocket(versionInfo.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
  const cdp = new CDP(ws);

  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  const S = (m, p) => cdp.send(m, p || {}, sessionId);
  await S('Page.enable'); await S('Runtime.enable');
  await S('Page.addScriptToEvaluateOnNewDocument', { source: HARNESS });

  const evalIn = async (expr) => {
    const r = await S('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 400));
    return r.result && r.result.value;
  };
  const nav = async (url, waitLoad = true) => {
    const p = waitLoad ? cdp.waitEvent('Page.loadEventFired', 60000, sessionId) : null;
    await S('Page.navigate', { url });
    if (p) await p;
  };

  console.log('[' + (LABEL || 'run') + '] 浏览器: ' + path.basename(browserPath) + '  profile: ' + profileDir);
  console.log('[' + (LABEL || 'run') + '] 造数据中（检查信息 4 万条 / 规章 687 / 手册 1305 / 电话 839 / 日志 42 / 资料 73 / 报告 52）…');
  await nav(base + 'index.html?seed=1');
  await sleep(1500);
  const seedOut = await evalIn(seedScript(ISSUE_LIMIT, START_MODULE));
  console.log('[' + (LABEL || 'run') + '] ' + seedOut);

  // 重新打开一次，让各模块把新数据读进内存，然后建立并落盘 KB 索引缓存
  await nav(base + 'index.html?warm=1');
  await sleep(3000);
  const buildOut = await evalIn(`(async () => {
    if (!window.KB || !KB.rebuild) return 'KB 不可用';
    const t0 = performance.now();
    await KB.rebuild(null, () => {});
    const ms = Math.round(performance.now() - t0);
    return 'KB 索引已建立 ' + ms + 'ms || ' + KB.stats().map((r) => r.key + ':' + (r.built ? '1' : '0') + '/' + r.total).join(', ');
  })()`);
  console.log('[' + (LABEL || 'run') + '] ' + buildOut);

  const runs = [];
  for (let i = 1; i <= RUNS; i++) {
    await nav(base + 'index.html?run=' + i + '&t=' + Date.now());
    await sleep(13000);              // 覆盖到 load+1.2s 的 KB 自动载入 + 空闲预热
    const raw = await evalIn('window.__bench.report()');
    const r = JSON.parse(raw);
    runs.push(r);
    const m = r.marks;
    console.log('  run' + i + ': DCL ' + m.dcl + 'ms | load ' + m.load + 'ms | 遮罩消失 ' + m.overlayGone +
      'ms | 台账就绪 ' + (m.issueReady || '-') + 'ms | KB就绪 ' + (m.kbReady || '-') + 'ms' +
      ' | 长任务 ' + r.longtask.n + '个/' + r.longtask.total + 'ms(最长' + r.longtask.max + ') | 堆 ' + r.heapMB + 'MB');
  }

  const med = (arr) => { const a = arr.filter((x) => typeof x === 'number' && x >= 0).sort((x, y) => x - y); return a.length ? a[Math.floor(a.length / 2)] : null; };
  const summary = {
    label: LABEL || 'run',
    issueLimit: ISSUE_LIMIT,
    startModule: START_MODULE,
    dcl: med(runs.map((r) => r.marks.dcl)),
    load: med(runs.map((r) => r.marks.load)),
    overlayGone: med(runs.map((r) => r.marks.overlayGone)),
    issueReady: med(runs.map((r) => r.marks.issueReady)),
    kbReady: med(runs.map((r) => r.marks.kbReady)),
    longtaskTotal: med(runs.map((r) => r.longtask.total)),
    longtaskMax: med(runs.map((r) => r.longtask.max)),
    longtaskN: med(runs.map((r) => r.longtask.n)),
    heapMB: med(runs.map((r) => r.heapMB)),
    detail: runs
  };
  console.log('\n===== 汇总（中位数，' + RUNS + ' 次）=====');
  console.log(JSON.stringify(Object.assign({}, summary, { detail: undefined }), null, 2));
  fs.writeFileSync(path.join(ROOT, 'scripts', '.boot-bench-' + (LABEL || 'run') + '.json'), JSON.stringify(summary, null, 2));

  try { await cdp.send('Browser.close'); } catch (e) {}
  ws.close(); child.kill();
  server.close();
  if (!KEEP_PROFILE) { try { fs.rmSync(profileDir, { recursive: true, force: true }); } catch (e) {} }
  process.exit(0);
}

main().catch((e) => { console.error('bench 失败:', e); process.exit(1); });
