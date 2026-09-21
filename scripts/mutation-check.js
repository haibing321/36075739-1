#!/usr/bin/env node
/**
 * 测试敏感度自检（mutation check）—— 回答"套件真的能找到问题吗？"
 * ------------------------------------------------------------------
 * 业界共识（LLM/Agent 评测）：**不敏感的全绿等于没测**。做法是主动注入已知缺陷，
 * 断言对应用例集**确实失败**；若注入缺陷后依然全绿，说明用例/断言本身失效（比缺陷本身更危险）。
 *
 * 本脚本对每一条 mutation：
 *   1) 读原文件字节 → 先备份到 .codebuddy/iteration/mutation-backup/
 *   2) 注入缺陷（字符串替换）→ 跑指定套件 → 记录退出码
 *   3) **在 finally 里按原始字节还原**，并用 sha1 校验还原一致
 *   4) 断言：套件必须失败（退出码 ≠ 0）
 * 若本脚本被强杀导致源码残留变异，**下次运行会先自动还原**（见 restoreLeftovers）。
 *
 * 用法：node scripts/mutation-check.js
 * 退出码：0 = 全部 mutation 都被捕获且源码已还原；1 = 有敏感度不足/还原异常。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const BK = path.join(ROOT, '.codebuddy', 'iteration', 'mutation-backup');

/** 注入清单：from 必须在源码中唯一；suite 是被验证敏感度的套件 */
const MUTATIONS = [
  {
    name: '去重口径失效（丢掉"日期"维度）',
    file: 'src/js/modules/issue.js',
    from: "+ '|' + issueDateKey(item);",
    to: "+ '';",
    suite: 'scripts/data-io-audit.js',
    why: 'data-io-audit 的 ④ 断言（换日期应保留新条）必须失败'
  },
  {
    name: 'CSV 编码自适应失效（按 UTF-8 硬读 GBK）',
    file: 'src/js/modules/issue.js',
    from: 'await window.dsReadTextFileAutoEnc(file)',
    to: 'await file.text()',
    suite: 'scripts/data-io-audit.js',
    why: 'data-io-audit 的 ② 断言（GBK 中文不乱码）必须失败'
  },
  {
    name: '备份媒体不再独立成条目（退回内嵌/丢失）',
    file: 'src/js/modules/backup.js',
    from: "copy.path = 'media/' + rec.id + '.' + _ext;",
    to: "copy.path = '';",
    suite: 'scripts/backup-audit.js',
    why: 'backup-audit 的 ③ 断言（media/* 独立条目）必须失败'
  }
];

const sha = (b) => crypto.createHash('sha1').update(b).digest('hex');
const bkName = (f) => f.replace(/[\\/]/g, '__');
let pass = 0, fail = 0;
const F = (ok, msg) => { console.log((ok ? '  ✓ ' : '  ✗ ') + msg); ok ? pass++ : fail++; };

/** 上次被强杀可能留下变异源码：先按备份还原 */
function restoreLeftovers() {
  if (!fs.existsSync(BK)) return 0;
  let n = 0;
  fs.readdirSync(BK).forEach((bf) => {
    const target = path.join(ROOT, bf.replace(/__/g, path.sep));
    try {
      fs.copyFileSync(path.join(BK, bf), target);
      fs.unlinkSync(path.join(BK, bf));
      n++;
      console.warn('[mutation-check] 已还原上次残留的变异源码：' + bf.replace(/__/g, '/'));
    } catch (e) {}
  });
  if (n === 0) { try { fs.rmdirSync(BK); } catch (e) {} }
  return n;
}

console.log('==== 测试敏感度自检（mutation check）====');
const restored = restoreLeftovers();
if (restored) console.log('（注意：本次运行前发现并还原了 ' + restored + ' 个残留变异文件）');

for (const m of MUTATIONS) {
  const abs = path.join(ROOT, m.file);
  if (!fs.existsSync(abs)) { F(false, m.name + '：源文件不存在 ' + m.file); continue; }
  const orig = fs.readFileSync(abs);
  const origText = orig.toString('utf8');
  let backupWritten = false, suiteStatus = null, caught = '';
  try {
    if (origText.indexOf(m.from) === -1) {
      F(false, m.name + '：注入点未找到（源码已变更，请更新 MUTATIONS 定义）');
      continue;
    }
    fs.mkdirSync(BK, { recursive: true });
    fs.writeFileSync(path.join(BK, bkName(m.file)), orig);
    backupWritten = true;

    // 注入缺陷
    fs.writeFileSync(abs, origText.replace(m.from, m.to), 'utf8');
    const r = spawnSync(process.execPath, [path.join(ROOT, m.suite)], { cwd: ROOT, encoding: 'utf8', timeout: 420000, maxBuffer: 32 * 1024 * 1024 });
    suiteStatus = r.status;
    caught = String(r.stdout || '').split(/\r?\n/).filter((l) => /^\s*✗/.test(l)).slice(0, 2).map((l) => l.trim()).join(' ｜ ');
  } catch (e) {
    F(false, m.name + '：注入/执行异常 ' + (e && e.message));
  } finally {
    // ★ 字节级还原 + 哈希校验
    try {
      fs.writeFileSync(abs, orig);
      const back = fs.readFileSync(abs);
      F(sha(back) === sha(orig), m.name + '：源码已字节级还原（sha1 一致）');
      if (backupWritten) { try { fs.unlinkSync(path.join(BK, bkName(m.file))); } catch (e) {} }
    } catch (e) {
      F(false, m.name + '：还原失败！请手动用 .codebuddy/iteration/mutation-backup/ 恢复 ' + m.file + '（' + (e && e.message) + '）');
    }
  }
  F(suiteStatus !== 0 && suiteStatus !== null,
    m.name + '：注入缺陷后套件**确实失败**（退出码 ' + suiteStatus + '）→ 敏感度合格' + (caught ? '｜捕获：' + caught : ''));
  if (suiteStatus === 0) console.log('     ↳ 说明：' + m.why + '，若仍全绿则用例/断言已失效，需补强');
  console.log('     ↳ ' + m.file + ' 注入：' + JSON.stringify(m.from.slice(0, 46)) + ' → ' + JSON.stringify(m.to.slice(0, 46)));
}

try { const rest = fs.readdirSync(BK); if (rest.length === 0) fs.rmdirSync(BK); } catch (e) {}
console.log('\n==== 汇总：' + pass + '/' + (pass + fail) + ' 通过 ====');
process.exit(fail === 0 ? 0 : 1);
