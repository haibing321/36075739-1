#!/usr/bin/env node
/**
 * 智能迭代 · 统一回归入口（月度迭代闭环的执行器）
 * ------------------------------------------------------------------
 * 把散落在 scripts/ 下的各模块审计/基准脚本串成"一次跑完 + 统一判定 + 留档"，
 * 供「月度自动迭代」调用，也可人工随时执行。
 *
 * 用法：
 *   node scripts/iterate-audit.js                 # 跑全部（默认）
 *   node scripts/iterate-audit.js --quick         # 只跑快速组（audit，跳过 bench）
 *   node scripts/iterate-audit.js --only agent-core-audit,boot-bench
 *   node scripts/iterate-audit.js --list          # 只列出套件
 *   node scripts/iterate-audit.js --timeout 900000
 *
 * 产出：
 *   .codebuddy/iteration/last-run.json   —— 机器可读结果（每次覆盖）
 *   .codebuddy/iteration/<YYYY-MM-DD>.md —— 人类可读报告（同日追加一节）
 * 退出码：0 = 全部通过；1 = 有失败；2 = 无可运行套件
 *
 * 约定（重要）：
 *   · 套件脚本自身负责输出 "✓/✗" 明细，本文件只做**汇总判定**，不解释业务。
 *   · 需要 Edge 无头 + 本地 http 服务的套件请在本文件声明 requiresEdge，缺失时记为 SKIP 而不是 FAIL。
 *   · 新增审计脚本后，只需在 SUITES 里补一行。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const OUT_DIR = path.join(ROOT, '.codebuddy', 'iteration');

/** 套件注册表：新增审计脚本只改这里 */
const SUITES = [
  { name: 'agent-call-audit',      file: 'scripts/agent-call-audit.js',      kind: 'audit', desc: '智能对话/agent 的工具挂载与降级',           timeout: 600000 },
  { name: 'agent-core-audit',      file: 'scripts/agent-core-audit.js',      kind: 'audit', desc: '智能体核心：裁剪/参数口径/反思契约/预算/缓存', timeout: 900000 },
  { name: 'agent-tool-audit',      file: 'scripts/agent-tool-audit.js',      kind: 'audit', desc: '工具清单与参数 schema 一致性',              timeout: 600000 },
  { name: 'autocheck-audit',       file: 'scripts/autocheck-audit.js',       kind: 'audit', desc: '智能对规链路（召回/AI 精排/保底）',          timeout: 900000 },
  { name: 'writer-prompt-audit',   file: 'scripts/writer-prompt-audit.js',   kind: 'audit', desc: '智能写作提示词与取数口径',                  timeout: 600000 },
  { name: 'diary-ai-fix-audit',    file: 'scripts/diary-ai-fix-audit.js',    kind: 'audit', desc: '日志 AI 修改链路',                          timeout: 900000 },
  { name: 'boot-bench',            file: 'scripts/boot-bench.js',            kind: 'bench', desc: '冷启动性能基线',                            timeout: 900000 },
  { name: 'kb-ab-bench',           file: 'scripts/kb-ab-bench.js',           kind: 'bench', desc: '知识库检索 A/B',                            timeout: 900000 },
  { name: 'kb-budget-measure',     file: 'scripts/kb-budget-measure.js',     kind: 'bench', desc: 'KB 注入预算测量',                           timeout: 900000 },
];

function parseArgs(argv) {
  const args = { quick: false, list: false, only: null, timeout: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--quick') args.quick = true;
    else if (a === '--list') args.list = true;
    else if (a === '--only') args.only = (argv[++i] || '').split(',').map(s => s.trim()).filter(Boolean);
    else if (a === '--timeout') args.timeout = parseInt(argv[++i], 10) || null;
  }
  return args;
}

/** 从套件输出里提取统计：✓/✗ 计数 + 结论行
 *  ⚠️ 只统计**行首为 ✓/✗ 的断言行**（本仓库审计脚本的统一约定：`('  ✓ ' : '  ✗ ') + 说明`）。
 *  不能全文字符计数：套件文案里一旦出现"✗"字样（例如断言"输出里没有 ✗"、或打印参考用的反例），
 *  会被误判为失败 —— 这个坑在写本文件时实测踩到过。
 */
function summarize(stdout, stderr) {
  const text = String(stdout || '') + '\n' + String(stderr || '');
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  let ok = 0, bad = 0;
  lines.forEach(l => {
    if (/^✗/.test(l)) bad++;
    else if (/^✓/.test(l)) ok++;
  });
  // 结论行：优先含"通过/失败/断言/结果"的最后一行
  const tail = lines.filter(l => /通过|失败|断言|PASS|FAIL|结果|Summary|汇总/.test(l)).slice(-3);
  return { ok, bad, tail: tail.length ? tail : lines.slice(-3) };
}

function runSuite(s, args) {
  const abs = path.join(ROOT, s.file);
  const started = Date.now();
  if (!fs.existsSync(abs)) {
    return { name: s.name, kind: s.kind, desc: s.desc, status: 'SKIP', reason: '脚本不存在：' + s.file, ms: 0, ok: 0, bad: 0, tail: [] };
  }
  const timeout = args.timeout || s.timeout || 600000;
  const r = spawnSync(process.execPath, [abs], { cwd: ROOT, timeout, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const ms = Date.now() - started;
  const out = summarize(r.stdout, r.stderr);
  let status;
  const combined = String(r.stdout || '') + String(r.stderr || '');
  if (r.error && r.error.code === 'ETIMEDOUT') status = 'FAIL';
  else if (/Edge.*(未找到|not found)|ENOENT.*msedge|无法启动浏览器/i.test(combined)) status = 'SKIP';
  else if (r.status === 0 && out.bad === 0) status = 'PASS';
  else if (out.bad > 0 || r.status !== 0) status = 'FAIL';
  else status = 'PASS';
  return {
    name: s.name, kind: s.kind, desc: s.desc, status, ms,
    ok: out.ok, bad: out.bad, tail: out.tail,
    reason: r.error ? (r.error.code || r.error.message) : (r.status ? 'exit=' + r.status : '')
  };
}

function writeReports(results, meta) {
  try { fs.mkdirSync(OUT_DIR, { recursive: true }); } catch (e) {}
  const pass = results.filter(r => r.status === 'PASS').length;
  const fail = results.filter(r => r.status === 'FAIL').length;
  const skip = results.filter(r => r.status === 'SKIP').length;
  const payload = {
    date: new Date().toISOString(),
    mode: meta.mode,
    totals: { pass, fail, skip, all: results.length },
    results
  };
  try { fs.writeFileSync(path.join(OUT_DIR, 'last-run.json'), JSON.stringify(payload, null, 2), 'utf8'); } catch (e) {}

  const d = new Date();
  const p2 = n => (n < 10 ? '0' : '') + n;
  const day = d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate());
  const time = p2(d.getHours()) + ':' + p2(d.getMinutes());
  const rows = results.map(r => '| ' + r.name + ' | ' + r.desc + ' | ' + r.status + ' | ' + (r.ms / 1000).toFixed(1) + 's | '
    + (r.status === 'PASS' ? ('✓ ' + r.ok + (r.bad ? ' / ✗ ' + r.bad : '')) : (r.reason || '')) + ' |').join('\n');
  const md = '\n## ' + day + ' ' + time + ' · 迭代回归（' + meta.mode + '）\n\n'
    + '合计：**通过 ' + pass + ' / 失败 ' + fail + ' / 跳过 ' + skip + '**（共 ' + results.length + ' 套件）\n\n'
    + '| 套件 | 覆盖 | 状态 | 耗时 | 明细 |\n| --- | --- | --- | --- | --- |\n' + rows + '\n';
  const reportFile = path.join(OUT_DIR, day + '.md');
  try { fs.appendFileSync(reportFile, md, 'utf8'); } catch (e) {}
  return { pass, fail, skip, reportFile };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  let suites = SUITES;
  if (args.only && args.only.length) suites = SUITES.filter(s => args.only.includes(s.name));
  else if (args.quick) suites = SUITES.filter(s => s.kind === 'audit');

  if (args.list) {
    console.log('可用套件（' + SUITES.length + '）：');
    SUITES.forEach(s => console.log('  ' + (s.kind === 'bench' ? '[基准] ' : '[审计] ') + s.name.padEnd(20) + ' ' + s.desc + '   → ' + s.file));
    console.log('\n示例：node scripts/iterate-audit.js --quick');
    return 0;
  }
  if (!suites.length) { console.error('没有匹配的套件（用 --list 查看）。'); return 2; }

  const mode = args.only ? ('only=' + args.only.join(',')) : (args.quick ? 'quick' : 'full');
  console.log('=========== 智能迭代 · 统一回归 ===========');
  console.log('模式：' + mode + '｜套件：' + suites.length + '｜时间：' + new Date().toLocaleString());
  const results = [];
  for (const s of suites) {
    process.stdout.write('\n▶ ' + s.name + '（' + s.desc + '）… ');
    const r = runSuite(s, args);
    results.push(r);
    console.log(r.status + (r.ms ? '（' + (r.ms / 1000).toFixed(1) + 's）' : '')
      + (r.status === 'FAIL' ? '\n   ✗ 明细：' + (r.tail || []).join(' ｜ ') + (r.reason ? '（' + r.reason + '）' : '') : ''));
  }
  const { pass, fail, skip, reportFile } = writeReports(results, { mode });
  console.log('\n------------ 汇总 ------------');
  console.log('通过 ' + pass + '｜失败 ' + fail + '｜跳过 ' + skip + '｜共 ' + results.length);
  results.filter(r => r.status !== 'PASS').forEach(r => console.log('  · ' + r.status + ' ' + r.name + '：' + (r.reason || '') + ' ' + (r.tail || []).slice(-1)[0] || ''));
  console.log('报告：' + path.relative(ROOT, reportFile) + '（机器可读：.codebuddy/iteration/last-run.json）');
  return fail > 0 ? 1 : 0;
}

process.exit(main());
