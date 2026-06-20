// 替换 issue.js 中的 issueShowStats 函数为升级版仪表盘
var fs = require('fs');
var path = 'C:/Users/asus/Desktop/安监系统重构/src/js/modules/issue.js';
var content = fs.readFileSync(path, 'utf-8');

var newFn = [
'            window.issueShowStats = function() {',
'                var panel = document.getElementById(\'issue-statsPanel\');',
'                var content = document.getElementById(\'issue-statsContent\');',
'                if (!panel || !content) return;',
'                if (panel.style.display === \'block\') { panel.style.display = \'none\'; return; }',
'                var data = dataCache;',
'                if (!data.length) { alert(\'暂无数据\'); return; }',
'                var nats = {}; data.forEach(function(d) { var v = getXingzhi(d) || \'空白\'; nats[v] = (nats[v]||0)+1; });',
'                var cats = {}; data.forEach(function(d) { var v = d.category || \'待分类\'; cats[v] = (cats[v]||0)+1; });',
'                var units = {}; data.forEach(function(d) { if (d.unit) { var u = String(d.unit).trim(); units[u] = (units[u]||0)+1; } });',
'                var topUnits = Object.entries(units).sort(function(a,b){return b[1]-a[1]}).slice(0,10);',
'                var times = data.map(function(d){return d.datetime||\'\'}).filter(Boolean).sort();',
'                var timeRange = times.length ? times[0].slice(0,10) + \' ~ \' + times[times.length-1].slice(0,10) : \'无数据\';',
'                var aCount = nats[\'A类\'] || 0, redlineCount = nats[\'红线\'] || 0, unitCount = Object.keys(units).length;',
'                var html = \'<style>#issue-statsContent .stats-bar-fill{transition:width 0.7s cubic-bezier(0.4,0,0.2,1)}#issue-statsContent .stats-card{transition:all 0.2s ease}#issue-statsContent .stats-card:hover{transform:translateY(-2px);box-shadow:0 4px 12px rgba(0,0,0,.1)}</style>\';',
'                html += \'<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:12px;margin-bottom:16px">\';',
'                [{l:\'总检查记录\',v:data.length,u:\'条\',c:\'#2563eb\',b1:\'#eff6ff\',b2:\'#dbeafe\'},{l:\'A类严重问题\',v:aCount,u:\'条(\'+Math.round(aCount/Math.max(data.length,1)*100)+\'%)\',c:\'#dc2626\',b1:\'#fef2f2\',b2:\'#fee2e2\'},{l:\'安全红线\',v:redlineCount,u:\'条(\'+Math.round(redlineCount/Math.max(data.length,1)*100)+\'%)\',c:\'#7c3aed\',b1:\'#f5f3ff\',b2:\'#ede9fe\'},{l:\'涉及单位\',v:unitCount,u:\'个\',c:\'#059669\',b1:\'#ecfdf5\',b2:\'#d1fae5\'}].forEach(function(x){html+=\'<div class="stats-card" style="background:linear-gradient(135deg,\'+x.b1+\',\'+x.b2+\');border-radius:12px;padding:16px;border:1px solid \'+x.b2+\'"><div style="font-size:0.73rem;color:\'+x.c+\';font-weight:600;margin-bottom:6px">\'+x.l+\'</div><div style="font-size:1.8rem;font-weight:700;color:\'+x.c+\'">\'+x.v+\'</div><div style="font-size:0.7rem;color:#64748b">\'+x.u+\'</div></div>\';});',
'                html += \'</div><div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:12px;margin-bottom:16px">\';',
'                html += \'<div style="background:#fff;border:1px solid #e2e8f0;border-radius:12px;padding:16px"><div style="font-weight:700;font-size:0.85rem;color:#1e293b;margin-bottom:14px">📊 性质分布</div>\';',
'                var nc={\'A类\':[\'#dc2626\',\'#fca5a5\'],\'B类\':[\'#f59e0b\',\'#fde68a\'],\'C类\':[\'#3b82f6\',\'#93c5fd\'],\'红线\':[\'#991b1b\',\'#e53e3e\']};',
'                var mx=Math.max(1,Math.max.apply(null,Object.values(nats)));',
'                [\'A类\',\'B类\',\'C类\',\'红线\'].forEach(function(k){var v=nats[k]||0,p=Math.round(v/Math.max(data.length,1)*100),w=Math.max(2,Math.round(v/mx*100)),c=nc[k]||[\'#64748b\',\'#94a3b8\'];html+=\'<div style="margin-bottom:10px"><div style="display:flex;justify-content:space-between;margin-bottom:3px;font-size:0.75rem"><span style="font-weight:600;color:\'+c[0]+\'">\'+k+\'</span><span style="color:#64748b">\'+v+\'条(\'+p+\'%)</span></div><div style="background:#f1f5f9;border-radius:6px;height:18px;overflow:hidden"><div class="stats-bar-fill" style="width:0;height:100%;background:linear-gradient(90deg,\'+c[0]+\',\'+c[1]+\');border-radius:6px" data-w="\'+w+\'%"></div></div></div>\';});',
'                html += \'<div style="font-size:0.7rem;color:#94a3b8;margin-top:8px;text-align:center">⏱ \'+timeRange+\'</div></div>\';',
'                html += \'<div style="background:#fff;border:1px solid #e2e8f0;border-radius:12px;padding:16px"><div style="font-weight:700;font-size:0.85rem;color:#1e293b;margin-bottom:14px">📂 类别排行</div>\';',
'                var sc=Object.entries(cats).sort(function(a,b){return b[1]-a[1]}).slice(0,8);',
'                var mc=Math.max(1,sc.length?sc[0][1]:1);',
'                var cg=[[\'#8b5cf6\',\'#a78bfa\'],[\'#6366f1\',\'#818cf8\'],[\'#3b82f6\',\'#60a5fa\'],[\'#06b6d4\',\'#22d3ee\'],[\'#10b981\',\'#34d399\'],[\'#f59e0b\',\'#fbbf24\'],[\'#ef4444\',\'#f87171\'],[\'#ec4899\',\'#f472b6\']];',
'                sc.forEach(function(e,i){var n=e[0],v=e[1],p=Math.round(v/Math.max(data.length,1)*100),w=Math.max(2,Math.round(v/mc*100)),g=cg[i]||[\'#64748b\',\'#94a3b8\'];html+=\'<div style="margin-bottom:10px"><div style="display:flex;justify-content:space-between;margin-bottom:3px;font-size:0.75rem"><span style="font-weight:600;color:#334155">\'+n+\'</span><span style="color:#64748b">\'+v+\'(\'+p+\'%)</span></div><div style="background:#f1f5f9;border-radius:6px;height:18px;overflow:hidden"><div class="stats-bar-fill" style="width:0;height:100%;background:linear-gradient(90deg,\'+g[0]+\',\'+g[1]+\');border-radius:6px" data-w="\'+w+\'%"></div></div></div>\';});',
'                html += \'</div></div>\';',
'                if(topUnits.length){html+=\'<div style="background:#fff;border:1px solid #e2e8f0;border-radius:12px;padding:16px"><div style="font-weight:700;font-size:0.85rem;color:#1e293b;margin-bottom:14px">🏆 单位违规TOP\'+Math.min(10,topUnits.length)+\'</div>\';',
'                var mu=topUnits[0][1];topUnits.forEach(function(e,i){var n=e[0],v=e[1],w=Math.max(2,Math.round(v/mu*100));var r=i===0?[\'#dc2626\',\'#fecaca\',\'#fef2f2\']:i===1?[\'#d97706\',\'#fde68a\',\'#fffbeb\']:i===2?[\'#2563eb\',\'#bfdbfe\',\'#eff6ff\']:[\'#64748b\',\'#e2e8f0\',\'#f8fafc\'];html+=\'<div style="margin-bottom:8px;padding:8px 10px;background:\'+r[2]+\';border-radius:8px;border:1px solid \'+r[1]+\'"><div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px"><div style="display:flex;align-items:center;gap:8px"><span style="width:22px;height:22px;display:inline-flex;align-items:center;justify-content:center;background:\'+r[0]+\';color:#fff;border-radius:50%;font-size:0.7rem;font-weight:700">\'+(i+1)+\'</span><span style="font-weight:600;font-size:0.8rem;color:\'+r[0]+\'">\'+n+\'</span></div><span style="font-weight:700;font-size:0.85rem;color:\'+r[0]+\'">\'+v+\'<span style="font-weight:400;font-size:0.7rem">条</span></span></div><div style="background:#fff;border-radius:4px;height:12px;overflow:hidden"><div class="stats-bar-fill" style="width:0;height:100%;background:linear-gradient(90deg,\'+r[0]+\',\'+r[1]+\');border-radius:4px" data-w="\'+w+\'%"></div></div></div>\';});',
'                html+=\'</div>\';}',
'                content.innerHTML = html; panel.style.display = \'block\';',
'                setTimeout(function(){content.querySelectorAll(\'.stats-bar-fill\').forEach(function(b,i){var w=b.getAttribute(\'data-w\');if(w)setTimeout(function(){b.style.width=w},i*30);});},80);',
'                panel.scrollIntoView({ behavior: \'smooth\' });',
'            };'
].join('\n');

// 找到旧函数并替换
var oldStart = content.indexOf('            window.issueShowStats = function() {');
var oldEnd = content.indexOf('            window.issueAddKeyword = function() {');
if (oldStart === -1 || oldEnd === -1) { console.log('ERROR: 未找到替换位置'); process.exit(1); }
var newContent = content.slice(0, oldStart) + newFn + '\n' + content.slice(oldEnd);
fs.writeFileSync(path, newContent, 'utf-8');
console.log('OK: issueShowStats 已替换为升级版仪表盘');
