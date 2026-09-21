/**
 * 审计套件共用外壳（Edge 无头 + CDP + 本地静态服务 + 真实下载目录）
 * ------------------------------------------------------------------
 * 供 scripts/*-audit.js 复用，避免每个套件重复 ~70 行样板。约定：
 *   · 被审计页面从仓库根起静态服务；下载落到系统临时目录（**不碰用户下载目录**）；
 *   · 自动应答 alert/confirm（不处理会让页面 JS 挂死、后续求值全超时）；
 *   · F(ok, msg) 输出 "  ✓ / ✗" 断言行（执行器只统计**行首** ✓/✗）；
 *   · 结束时 stop() 关闭浏览器与服务；有失败 → 进程退出码 1。
 *
 * 用法：
 *   const H = require('./audit-harness');
 *   (async () => {
 *     const h = await H.start({ port: 8160, cdpPort: 9370, view: 'dataio' });
 *     await h.nav('index.html?v=audit');
 *     const v = await h.ev(`1+1`);
 *     h.F(v === 2, '示例断言');
 *     h.done();     // 打印汇总并按结果设置退出码
 *   })();
 */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml', '.woff2': 'font/woff2' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class CDP {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); this.listeners = [];
    ws.addEventListener('message', (ev) => { let m; try { m = JSON.parse(ev.data); } catch (e) { return; }
      if (m.id && this.pending.has(m.id)) { const p = this.pending.get(m.id); this.pending.delete(m.id); m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result); }
      else if (m.method) this.listeners.forEach((f) => f(m)); }); }
  send(method, params = {}, sessionId, tmo) { const id = ++this.id; const payload = { id, method, params }; if (sessionId) payload.sessionId = sessionId;
    this.ws.send(JSON.stringify(payload));
    return new Promise((res, rej) => { this.pending.set(id, { resolve: res, reject: rej }); setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); rej(new Error('timeout ' + method)); } }, tmo || 120000); }); }
  waitEvent(method, t = 60000, sessionId) { return new Promise((res, rej) => { const tm = setTimeout(() => rej(new Error('ev timeout ' + method)), t);
    const fn = (m) => { if (m.method === method && (!sessionId || m.sessionId === sessionId)) { clearTimeout(tm); this.listeners = this.listeners.filter((x) => x !== fn); res(m.params); } }; this.listeners.push(fn); }); }
}

async function start(opts) {
  opts = opts || {};
  const PORT = opts.port || 8160, CDP_PORT = opts.cdpPort || 9370, view = opts.view || 'audit';
  const DL = path.join(os.tmpdir(), 'audit-dl-' + view + '-' + Date.now());
  fs.mkdirSync(DL, { recursive: true });
  const profileDir = path.join(os.tmpdir(), 'audit-profile-' + view + '-' + Date.now());
  fs.mkdirSync(profileDir, { recursive: true });

  // 【部署后 smoke】设置 AUDIT_BASE_URL（如 CloudStudio 预览地址）时，不再起本地服务，直接打线上环境
  const REMOTE = (process.env.AUDIT_BASE_URL || '').replace(/\/+$/, '');
  let server = null, baseUrl = REMOTE;
  if (REMOTE) {
    console.log('（远端模式）AUDIT_BASE_URL = ' + REMOTE);
  } else {
    server = http.createServer((req, res) => {
      let p = decodeURIComponent(req.url.split('?')[0]); if (p === '/') p = '/index.html';
      const f = path.join(ROOT, p);
      if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(f).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-store' });
      fs.createReadStream(f).pipe(res);
    });
    await new Promise((r) => server.listen(PORT, '127.0.0.1', r));
    baseUrl = 'http://127.0.0.1:' + PORT;
  }
  const child = spawn(EDGE, ['--headless=new', '--disable-gpu', '--no-first-run', '--remote-debugging-port=' + CDP_PORT, '--user-data-dir=' + profileDir, 'about:blank'], { stdio: 'ignore' });
  let info = null;
  for (let i = 0; i < 80 && !info; i++) { try { info = await (await fetch('http://127.0.0.1:' + CDP_PORT + '/json/version')).json(); } catch (e) { await sleep(300); } }
  if (!info) throw new Error('无法启动 Edge（未找到浏览器或端口被占用）');
  const ws = new WebSocket(info.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener('open', r));
  const cdp = new CDP(ws);
  await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: DL, eventsEnabled: true });
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  const S = (m, p) => cdp.send(m, p || {}, sessionId);
  await S('Page.enable'); await S('Runtime.enable');
  const dialogs = [], pageErrors = [];
  cdp.listeners.push((m) => {
    if (m.method === 'Page.javascriptDialogOpening') { dialogs.push(String(m.params.message || '').slice(0, 60)); cdp.send('Page.handleJavaScriptDialog', { accept: true, promptText: '' }, m.sessionId).catch(() => {}); }
    if (m.method === 'Runtime.exceptionThrown') pageErrors.push(String((m.params.exceptionDetails.exception || {}).description || m.params.exceptionDetails.text).slice(0, 200));
  });

  let pass = 0, fail = 0;
  const F = (ok, msg) => { console.log((ok ? '  ✓ ' : '  ✗ ') + msg); ok ? pass++ : fail++; };

  const api = {
    ROOT, DL, cdp, sessionId, S, sleep, dialogs, pageErrors, F,
    listDL: () => { try { return fs.readdirSync(DL).filter((f) => !f.endsWith('.crdownload')); } catch (e) { return []; } },
    ev: async (expr, tmo) => { const r = await cdp.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }, sessionId, tmo || 60000);
      if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 300)); return r.result.value; },
    nav: async (u) => { const url = /^http/.test(u) ? u : (baseUrl + '/' + u);
      const p = cdp.waitEvent('Page.loadEventFired', 60000, sessionId); await S('Page.navigate', { url }); await p; await sleep(2600); },
    baseUrl: baseUrl, remote: !!REMOTE,
    /** 触发一次导出并等待新文件落盘，返回文件名 */
    grab: async (expr, waitMs) => { const before = new Set(api.listDL()); await api.ev(expr);
      for (let i = 0; i < Math.ceil((waitMs || 20000) / 250); i++) { await sleep(250); const nw = api.listDL().filter((f) => !before.has(f)); if (nw.length) return nw[nw.length - 1]; } return null; },
    stop: () => { try { child.kill(); } catch (e) {} try { if (server) server.close(); } catch (e) {} },
    done: () => { console.log('\n==== 汇总：' + pass + '/' + (pass + fail) + ' 通过 ===='); api.stop(); process.exit(fail === 0 ? 0 : 1); }
  };
  return api;
}

module.exports = { start, sleep, ROOT };
