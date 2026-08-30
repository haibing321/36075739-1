// 自动提升 sw.js 的 CACHE_VERSION 为 12 位时间戳（YYYYMMDDHHMMSS），保留原文件换行符
// 用法: node scripts/bump-sw.js  ->  stdout 打印新版本号（无变化或失败打印 0）
const fs = require('fs');
const p = 'sw.js';
try {
  const s = fs.readFileSync(p, 'utf8');
  const m = s.match(/var CACHE_VERSION = '(\d+)';/);
  if (!m) { console.log('0'); process.exit(0); }
  const cur = +m[1];
  const d = new Date();
  const pad = function (n) { return String(n).padStart(2, '0'); };
  // 当前 12 位时间戳：YYYYMMDDHHMMSS
  const now = +(
    String(d.getFullYear()) +
    pad(d.getMonth() + 1) +
    pad(d.getDate()) +
    pad(d.getHours()) +
    pad(d.getMinutes()) +
    pad(d.getSeconds())
  );
  // 单调递增：当前时间更大则用当前时间，否则在旧版本基础上 +1 秒，
  // 避免同一分钟内重复 push 时版本号不变化导致 SW 不重新安装
  const nw = now > cur ? now : cur + 1;
  fs.writeFileSync(p, s.replace(/var CACHE_VERSION = '\d+';/, "var CACHE_VERSION = '" + nw + "';"));
  // 同步 version.json.sw，避免「检查更新」因两者不一致而误判 SW 未变化
  try {
    const vp = 'version.json';
    const v = fs.readFileSync(vp, 'utf8');
    fs.writeFileSync(vp, v.replace(/"sw":\s*"\d+"/, '"sw": "' + nw + '"'));
  } catch (e) { /* version.json 缺失时忽略 */ }
  console.log(String(nw));
} catch (e) {
  console.log('0');
  process.exit(0);
}
