// 自动提升 sw.js 的 CACHE_VERSION 为单调版本，保留原文件换行符（CRLF/LF 均不影响）
// 用法: node scripts/bump-sw.js  ->  stdout 打印新版本号（无变化或失败打印 0）
const fs = require('fs');
const p = 'sw.js';
try {
  const s = fs.readFileSync(p, 'utf8');
  const m = s.match(/var CACHE_VERSION = '(\d+)';/);
  if (!m) { console.log('0'); process.exit(0); }
  const cur = +m[1];
  const d = new Date();
  const today = +(
    String(d.getFullYear()) +
    String(d.getMonth() + 1).padStart(2, '0') +
    String(d.getDate()).padStart(2, '0')
  );
  const nw = today > cur ? today : cur + 1;
  fs.writeFileSync(p, s.replace(/var CACHE_VERSION = '\d+';/, "var CACHE_VERSION = '" + nw + "';"));
  console.log(String(nw));
} catch (e) {
  console.log('0');
  process.exit(0);
}
