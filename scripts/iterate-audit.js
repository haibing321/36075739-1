#!/usr/bin/env node
/**
 * 智能迭代 · 统一回归入口（月度/夜间自动迭代的执行器）
 * ------------------------------------------------------------------
 * 把散落在 scripts/ 下的各模块审计/基准脚本串成"一次跑完 + 统一判定 + 留档"，
 * 并且支持**断点续跑**：每个套件跑完立即落盘状态，被关机/超时打断后下次接着跑未完成的。
 *
 * 用法：
 *   node scripts/iterate-audit.js                    # 跑全部（不复用状态）
 *   node scripts/iterate-audit.js --quick            # 只跑快速组（audit，跳过 bench）
 *   node scripts/iterate-audit.js --only a,b         # 只跑指定套件
 *   node scripts/iterate-audit.js --resume           # 【夜间自动用】按队列状态续跑，直到全部完成或超预算
 *   node scripts/iterate-audit.js --resume --budget-ms 16200000   # 限时 4.5h，超时留待下次
 *   node scripts/iterate-audit.js --status           # 查看队列状态（周期/各套件/待部署计数）
 *   node scripts/iterate-audit.js --bump-improvements 1   # 记一次"新增/优化项"，返回是否需要部署
 *   node scripts/iterate-audit.js --mark-deployed <url>   # 标记已部署（计数清零，写入 deploys）
 *   node scripts/iterate-audit.js --list             # 套件清单
 *
 * 产出：
 *   .codebuddy/iteration/queue.json      —— 队列状态（周期进度 / 各套件状态 / 待部署计数），**每套件跑完即写**
 *   .codebuddy/iteration/last-run.json   —— 机器可读结果（增量覆盖，随时可读）
 *   .codebuddy/iteration/<YYYY-MM-DD>.md —— 人类可读报告（同日追加）
 * 退出码：0 = 本轮全部通过 / 1 = 有失败（周期保持未完成，下次续跑）/ 2 = 无可运行套件
 *
 * 约定：
 *   · 套件脚本自身输出 "✓/✗" 明细；本文件只做汇总判定（**只统计行首** ✓/✗，避免文案误判）。
 *   · 需要 Edge 无头 + 本地服务的套件，环境缺失时记 SKIP（SKIP 不算通过，仍需下次补跑）。
 *   · 新增审计脚本后，只需在 SUITES 里补一行。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const OUT_DIR = path.join(ROOT, '.codebuddy', 'iteration');
const STATE_FILE = path.join(OUT_DIR, 'queue.json');
const LAST_RUN = path.join(OUT_DIR, 'last-run.json');
const DEPLOY_THRESHOLD = 10;   // 每累计 10 个"新增/优化项"就自动部署一次

/** 套件注册表：新增审计脚本只改这里 */
const SUITES = [
  { name: 'agent-call-audit',      file: 'scripts/agent-call-audit.js',      kind: 'audit', desc: '智能对话/agent 的工具挂载与降级',           timeout: 600000 },
  { name: 'agent-core-audit',      file: 'scripts/agent-core-audit.js',      kind: 'audit', desc: '智能体核心：裁剪/参数口径/反思契约/预算/缓存', timeout: 900000 },
  { name: 'agent-tool-audit',      file: 'scripts/agent-tool-audit.js',      kind: 'audit', desc: '工具清单与参数 schema 一致性',              timeout: 600000 },
  { name: 'autocheck-audit',       file: 'scripts/autocheck-audit.js',       kind: 'audit', desc: '智能对规链路（召回/AI 精排/保底）',          timeout: 900000 },
  { name: 'writer-prompt-audit',   file: 'scripts/writer-prompt-audit.js',   kind: 'audit', desc: '智能写作提示词与取数口径',                  timeout: 600000 },
  { name: 'diary-ai-fix-audit',    file: 'scripts/diary-ai-fix-audit.js',    kind: 'audit', desc: '日志 AI 修改链路',                          timeout: 900000 },
  { name: 'data-io-audit',         file: 'scripts/data-io-audit.js',         kind: 'audit', desc: '数据导入导出：CSV/GBK/边界/去重口径/真实落盘', timeout: 600000 },
  { name: 'backup-audit',          file: 'scripts/backup-audit.js',          kind: 'audit', desc: '备份结构 + 恢复往返（含媒体附件）',           timeout: 600000 },
  { name: 'realdata-e2e',          file: 'scripts/realdata-e2e.js',          kind: 'audit', desc: '真实数据端到端：90MB 备份恢复→条数/媒体→再导出往返（含 4 万检查信息）', timeout: 1200000 },
  { name: 'writer-list-audit',     file: 'scripts/writer-list-audit.js',     kind: 'audit', desc: '写作资料列表：按类型分块 + 块内时间倒序（4 个列表全覆盖）', timeout: 600000 },
  { name: 'accident-import-audit', file: 'scripts/accident-import-audit.js', kind: 'audit', desc: '事故案例：与检查手册平行的第二份四级数据（导入/共存/三视图切换/搜索/备份/清空）', timeout: 900000 },
  { name: 'chat-fixes-audit',      file: 'scripts/chat-fixes-audit.js',      kind: 'audit', desc: '对话/写作反馈：附件按钮可唤起+即时反馈、风险误跳、设置项合并、写作"用不用模板/资料"提示', timeout: 900000 },
  { name: 'fold-state-audit',      file: 'scripts/fold-state-audit.js',      kind: 'audit', desc: '折叠屏开合界面保持：不重载路径 + 文档重建路径（模块/滚动/阅读位置/草稿/弹窗/子视图/分类筛选）', timeout: 900000 },
  { name: 'kb-recall-bench',       file: 'scripts/kb-recall-bench.js',       kind: 'audit', desc: '知识库召回基线：真实"检查描述→其引用规章"ground truth，Recall@K/MRR + 归因消融（缺数据自动 SKIP）', timeout: 1800000 },
  { name: 'mutation-check',        file: 'scripts/mutation-check.js',        kind: 'audit', desc: '测试敏感度自检：注入已知缺陷验证套件确实会失败', timeout: 900000 },
  { name: 'boot-bench',            file: 'scripts/boot-bench.js',            kind: 'bench', desc: '冷启动性能基线',                            timeout: 900000 },
  { name: 'kb-ab-bench',           file: 'scripts/kb-ab-bench.js',           kind: 'bench', desc: '知识库检索 A/B',                            timeout: 900000 },
  { name: 'kb-budget-measure',     file: 'scripts/kb-budget-measure.js',     kind: 'bench', desc: 'KB 注入预算测量',                           timeout: 900000 },
  { name: 'realdata-bench',        file: 'scripts/realdata-bench.js',        kind: 'bench', desc: '真数据基准：冷启动(43585条)/检索P50-P95/4万条Excel往返', timeout: 1800000 },
];

// ---------------- 参数 ----------------
function parseArgs(argv) {
  const args = { quick: false, list: false, only: null, timeout: null, resume: false, budgetMs: 0, status: false, bump: null, markDeployed: null, retry: 1, maxRegress: 30 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--quick') args.quick = true;
    else if (a === '--list') args.list = true;
    else if (a === '--resume') args.resume = true;
    else if (a === '--status') args.status = true;
    else if (a === '--only') args.only = (argv[++i] || '').split(',').map(s => s.trim()).filter(Boolean);
    else if (a === '--timeout') args.timeout = parseInt(argv[++i], 10) || null;
    else if (a === '--budget-ms') args.budgetMs = parseInt(argv[++i], 10) || 0;
    else if (a === '--bump-improvements') args.bump = parseInt(argv[++i], 10);
    else if (a === '--mark-deployed') args.markDeployed = argv[++i] || '';
    else if (a === '--retry') args.retry = parseInt(argv[++i], 10) || 0;              // 失败重跑次数（Flaky 隔离）
    else if (a === '--max-regress') args.maxRegress = parseInt(argv[++i], 10);        // 耗时回归门禁（%）
  }
  return args;
}

/** 版本指纹：把代码版本与评测结果绑定（业界要求"Golden Set / 模型 / Prompt / 提交一起保存"） */
function versionFingerprint() {
  const out = { gitCommit: null, appVersion: null };
  try {
    const r = spawnSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: ROOT, encoding: 'utf8' });
    if (r.status === 0) out.gitCommit = String(r.stdout || '').trim();
  } catch (e) {}
  try {
    const vj = JSON.parse(fs.readFileSync(path.join(ROOT, 'version.json'), 'utf8'));
    out.appVersion = vj.version || null;
    out.swBuild = vj.sw || null;
  } catch (e) {}
  return out;
}

// ---------------- 状态（队列） ----------------
function emptyState() {
  return { version: 1, updatedAt: null, cycle: null, suites: {}, pendingImprovements: 0, deploys: [] };
}
function loadState() {
  try { const s = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); return Object.assign(emptyState(), s); }
  catch (e) { return emptyState(); }
}
function saveState(s) {
  try { fs.mkdirSync(OUT_DIR, { recursive: true }); s.updatedAt = new Date().toISOString(); fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2), 'utf8'); } catch (e) {}
}
function startCycle(state, mode, names) {
  state.cycle = { id: 'c' + Date.now(), mode, startedAt: new Date().toISOString(), completedAt: null, total: names.length, done: 0 };
  state.suites = {};
  state.version = versionFingerprint();   // 版本绑定：评测结果与代码提交/SW 构建号一起保存
  names.forEach(n => { state.suites[n] = { status: 'PENDING' }; });
  return state;
}
/** 本轮待跑：周期未完成 → 只跑非 PASS 的；周期已完成 → 开新周期跑全部 */
function planSuites(state, all, args) {
  let list = all;
  if (args.only && args.only.length) list = all.filter(s => args.only.includes(s.name));
  else if (args.quick) list = all.filter(s => s.kind === 'audit');
  if (!args.resume) return { list, freshCycle: true };
  const done = state.cycle && state.cycle.completedAt;
  if (!state.cycle || done) return { list, freshCycle: true };
  const todo = list.filter(s => (state.suites[s.name] || {}).status !== 'PASS');
  return { list: todo, freshCycle: false };
}

// ---------------- 跑套件 ----------------
function summarize(stdout, stderr) {
  const text = String(stdout || '') + '\n' + String(stderr || '');
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  let ok = 0, bad = 0;
  lines.forEach(l => { if (/^✗/.test(l)) bad++; else if (/^✓/.test(l)) ok++; });
  const tail = lines.filter(l => /通过|失败|断言|PASS|FAIL|结果|Summary|汇总/.test(l)).slice(-3);
  return { ok, bad, tail: tail.length ? tail : lines.slice(-3) };
}
function runSuite(s, args, prevMs) {
  const abs = path.join(ROOT, s.file);
  const started = Date.now();
  if (!fs.existsSync(abs)) return { name: s.name, kind: s.kind, desc: s.desc, status: 'SKIP', reason: '脚本不存在：' + s.file, ms: 0, ok: 0, bad: 0, tail: [] };
  const timeout = args.timeout || s.timeout || 600000;
  const r = spawnSync(process.execPath, [abs], { cwd: ROOT, timeout, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const ms = Date.now() - started;
  const out = summarize(r.stdout, r.stderr);
  const combined = String(r.stdout || '') + String(r.stderr || '');
  let status;
  if (r.error && r.error.code === 'ETIMEDOUT') status = 'FAIL';
  // 套件自报跳过（例如 realdata-e2e 在本地缺真实测试数据时打印 ⏭ SKIP）：记 SKIP 而不是 PASS，
  // 避免"没跑也算过"，也避免"数据没在就红一片"
  else if (/^\s*⏭\s*SKIP/m.test(combined) || /SKIP[:：]未找到/.test(combined)) status = 'SKIP';
  else if (/Edge.*(未找到|not found)|ENOENT.*msedge|无法启动浏览器/i.test(combined)) status = 'SKIP';
  else if (r.status === 0 && out.bad === 0) status = 'PASS';
  else status = 'FAIL';
  // 【性能回归门禁】绝对阈值之外加"相对基线"：仅当上次 PASS、且两边都 ≥3s（避开抖动）才判定
  let reason = r.error ? (r.error.code || r.error.message) : (r.status ? 'exit=' + r.status : '');
  if (status === 'PASS' && prevMs && prevMs >= 3000 && ms > prevMs * (1 + ((args.maxRegress == null ? 30 : args.maxRegress) / 100))) {
    const pct = Math.round((ms / prevMs - 1) * 100);
    status = 'FAIL';
    reason = '性能回归 ' + pct + '%（上次 ' + (prevMs / 1000).toFixed(1) + 's → 本次 ' + (ms / 1000).toFixed(1) + 's，阈值 +' + (args.maxRegress == null ? 30 : args.maxRegress) + '%）';
  }
  return { name: s.name, kind: s.kind, desc: s.desc, status, ms, ok: out.ok, bad: out.bad, tail: out.tail, reason };
}

// ---------------- 留档（增量） ----------------
function writeReports(results, meta, state) {
  const pass = results.filter(r => r.status === 'PASS').length;
  const fail = results.filter(r => r.status === 'FAIL').length;
  const skip = results.filter(r => r.status === 'SKIP').length;
  const flaky = results.filter(r => r.status === 'FLAKY').length;
  try {
    fs.mkdirSync(OUT_DIR, { recursive: true });
    fs.writeFileSync(LAST_RUN, JSON.stringify({
      date: new Date().toISOString(), mode: meta.mode,
      version: state.version || versionFingerprint(),
      cycle: state.cycle ? { id: state.cycle.id, startedAt: state.cycle.startedAt, completedAt: state.cycle.completedAt } : null,
      totals: { pass, fail, skip, flaky, all: results.length },
      pendingImprovements: state.pendingImprovements, results
    }, null, 2), 'utf8');
  } catch (e) {}

  const d = new Date();
  const p2 = n => (n < 10 ? '0' : '') + n;
  const day = d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate());
  const time = p2(d.getHours()) + ':' + p2(d.getMinutes());
  const rows = results.map(r => '| ' + r.name + ' | ' + r.desc + ' | ' + r.status + ' | ' + (r.ms / 1000).toFixed(1) + 's | '
    + (r.status === 'PASS' ? ('✓ ' + r.ok + (r.bad ? ' / ✗ ' + r.bad : '')) : (r.reason || '')) + ' |').join('\n');
  const md = '\n## ' + day + ' ' + time + ' · ' + meta.mode + (meta.partial ? '（增量）' : '') + '\n\n'
    + '版本：' + JSON.stringify(state.version || versionFingerprint()) + '\n\n'
    + '合计：**通过 ' + pass + ' / 失败 ' + fail + ' / 跳过 ' + skip + (flaky ? ' / Flaky ' + flaky : '') + '**（本轮 ' + results.length + ' 套件）'
    + '｜周期：' + (state.cycle ? (state.cycle.completedAt ? '已完成' : '进行中 ' + state.cycle.done + '/' + state.cycle.total) : '—')
    + '｜待部署项：' + state.pendingImprovements + '\n\n'
    + '| 套件 | 覆盖 | 状态 | 耗时 | 明细 |\n| --- | --- | --- | --- | --- |\n' + rows + '\n';
  try { fs.appendFileSync(path.join(OUT_DIR, day + '.md'), md, 'utf8'); } catch (e) {}
  return { pass, fail, skip };
}

function statusText(state) {
  const c = state.cycle;
  const lines = [];
  lines.push('周期：' + (c ? (c.id + '｜' + (c.completedAt ? '✅ 已完成 ' + c.completedAt : '⏳ 进行中 ' + c.done + '/' + c.total) + '｜开始 ' + c.startedAt + '｜模式 ' + c.mode) : '（无，下次 --resume 会新建）'));
  lines.push('套件状态：');
  SUITES.forEach(s => { const st = state.suites[s.name]; lines.push('  ' + (st ? st.status : 'PENDING').padEnd(9) + s.name + (st && st.ms ? '（' + (st.ms / 1000).toFixed(1) + 's）' : '')); });
  lines.push('待部署项：' + state.pendingImprovements + ' / 阈值 ' + DEPLOY_THRESHOLD + (state.pendingImprovements >= DEPLOY_THRESHOLD ? '  → ⚠️ 需要部署' : ''));
  if ((state.deploys || []).length) {
    lines.push('最近部署：');
    state.deploys.slice(-3).forEach(d => lines.push('  ' + d.at + '｜' + d.count + ' 项｜' + (d.url || '')));
  }
  return lines.join('\n');
}

// ---------------- 主流程 ----------------
function main() {
  const args = parseArgs(process.argv.slice(2));
  const state = loadState();

  // --list
  if (args.list) {
    console.log('可用套件（' + SUITES.length + '）：');
    SUITES.forEach(s => console.log('  ' + (s.kind === 'bench' ? '[基准] ' : '[审计] ') + s.name.padEnd(20) + s.desc + '   → ' + s.file));
    console.log('\n夜间自动：node scripts/iterate-audit.js --resume --budget-ms 16200000');
    return 0;
  }
  // --status
  if (args.status) { console.log(statusText(state)); return 0; }
  // --bump-improvements N
  if (args.bump != null && !isNaN(args.bump)) {
    state.pendingImprovements = Math.max(0, (state.pendingImprovements || 0) + args.bump);
    saveState(state);
    const need = state.pendingImprovements >= DEPLOY_THRESHOLD;
    console.log('累计新增/优化项：' + state.pendingImprovements + ' 项（阈值 ' + DEPLOY_THRESHOLD + '）'
      + (need ? ' → deployNeeded=true：请部署后执行 --mark-deployed <url>' : ' → deployNeeded=false'));
    return 0;
  }
  // --mark-deployed URL
  if (args.markDeployed != null) {
    const n = state.pendingImprovements || 0;
    state.deploys = (state.deploys || []).concat([{ at: new Date().toISOString(), count: n, url: args.markDeployed || '', cycle: state.cycle ? state.cycle.id : null }]);
    state.pendingImprovements = Math.max(0, n - DEPLOY_THRESHOLD);
    saveState(state);
    console.log('已记录部署：' + args.markDeployed + '（本次提交 ' + Math.min(n, DEPLOY_THRESHOLD) + ' 项，剩余待部署 ' + state.pendingImprovements + ' 项）');
    return 0;
  }

  // 运行模式
  const mode = args.only ? ('only=' + args.only.join(',')) : (args.quick ? 'quick' : (args.resume ? 'nightly(续跑)' : 'full'));
  const plan = planSuites(state, SUITES, args);
  if (!plan.list.length) {
    console.log('没有待跑套件' + (args.resume ? '（本周期已全部 PASS，下次 --resume 会开新周期）' : ''));
    if (args.resume && state.cycle && !state.cycle.completedAt) { state.cycle.completedAt = new Date().toISOString(); saveState(state); }
    console.log(statusText(loadState()));
    return 0;
  }
  if (plan.freshCycle) startCycle(state, mode, plan.list.map(s => s.name));
  else if (!state.cycle) startCycle(state, mode, plan.list.map(s => s.name));

  console.log('=========== 智能迭代 · 统一回归 ===========');
  console.log('模式：' + mode + '｜本轮套件：' + plan.list.length + '（总 ' + SUITES.length + '）｜时间：' + new Date().toLocaleString());
  if (args.budgetMs) console.log('时间预算：' + (args.budgetMs / 60000).toFixed(0) + ' 分钟（超时留待下次续跑）');
  const cycleStart = Date.now();

  const results = [];
  let stoppedByBudget = false, interrupted = false;
  for (const s of plan.list) {
    if (args.budgetMs && (Date.now() - cycleStart) > args.budgetMs) {
      stoppedByBudget = true;
      console.log('\n⏸ 已达时间预算，剩余 ' + (plan.list.length - results.length) + ' 个套件留待下次 --resume 续跑');
      break;
    }
    process.stdout.write('\n▶ ' + s.name + '（' + s.desc + '）… ');
    const prevMs = (state.suites[s.name] || {}).ms || 0;
    let r;
    try { r = runSuite(s, args, prevMs); }
    catch (e) { r = { name: s.name, kind: s.kind, desc: s.desc, status: 'FAIL', ms: 0, ok: 0, bad: 0, tail: [], reason: 'runner:' + (e && e.message) }; interrupted = true; }
    // 【Flaky 隔离】失败先重跑一次：重跑通过 → 记 FLAKY（**不算 PASS**，下次仍会跑；报告中与真失败分开）
    if (r.status === 'FAIL' && (args.retry || 0) > 0) {
      process.stdout.write('（重跑以隔离 Flaky…）');
      const r2 = runSuite(s, args, prevMs);
      if (r2.status === 'PASS') { r2.status = 'FLAKY'; r2.reason = '首次失败（' + (r.reason || '断言失败') + '），重跑通过 → 疑似不稳定，已隔离'; r = r2; }
      else { r = r2; r.reason = (r.reason || '') + '（重跑仍失败）'; }
    }
    results.push(r);
    // ★ 每跑完一个套件立刻落盘（断点续跑的关键）
    state.suites[s.name] = { status: r.status, ms: r.ms, ok: r.ok, bad: r.bad, at: new Date().toISOString(), reason: r.reason || '' };
    if (state.cycle) state.cycle.done = Object.keys(state.suites).filter(k => state.suites[k].status === 'PASS').length;
    saveState(state);
    console.log(r.status + (r.ms ? '（' + (r.ms / 1000).toFixed(1) + 's）' : '')
      + (r.status !== 'PASS' ? '\n   ✗ ' + (r.tail || []).slice(-1)[0] + (r.reason ? '（' + r.reason + '）' : '') : ''));
  }

  // 判定周期是否完成：**本周期内的套件**都 PASS（用 state.suites 而非全部注册表，--only 复现时也自洽）
  const namesInCycle = Object.keys(state.suites || {});
  const allPass = namesInCycle.length > 0 && namesInCycle.every(n => (state.suites[n] || {}).status === 'PASS');
  if (allPass && !stoppedByBudget) state.cycle && (state.cycle.completedAt = new Date().toISOString());
  saveState(state);
  const totals = writeReports(results, { mode, partial: !plan.freshCycle }, state);

  console.log('\n------------ 汇总 ------------');
  console.log('本轮：通过 ' + totals.pass + '｜失败 ' + totals.fail + '｜跳过 ' + totals.skip);
  console.log('周期：' + (state.cycle ? (state.cycle.completedAt ? '✅ 全部套件完成' : '⏳ 进行中 ' + state.cycle.done + '/' + state.cycle.total + '（下次 --resume 续跑）') : '—'));
  console.log('待部署项：' + state.pendingImprovements + ' / ' + DEPLOY_THRESHOLD + (state.pendingImprovements >= DEPLOY_THRESHOLD ? '  → ⚠️ 达到阈值，请部署后 --mark-deployed <url>' : ''));
  console.log('状态文件：.codebuddy/iteration/queue.json（--status 查看）');
  if (interrupted) return 1;
  return totals.fail > 0 ? 1 : 0;
}

process.exit(main());
