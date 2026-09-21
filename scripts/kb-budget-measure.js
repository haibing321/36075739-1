/* C 批评估测量台（临时）：量化「上下文预算 / topK 不统一」与「索引窗口 vs 全量口径」的真实代价
 * 数据规模对齐用户真实库：规章制度 687 / 检查信息 40166 / 检查手册 1305 / 电话 839 / 日志 43 / 资料 71 / 报告 53
 * 用法：node _tmp_c_batch.js
 */
const fs = require('fs');

// ---------- 加载真实代码：LightBM25（doubao.js）+ KB（knowledge.js）----------
const doubao = fs.readFileSync('src/js/modules/doubao.js', 'utf8');
const s1 = doubao.indexOf('// ---------- 4. 轻量级 BM25 检索器 ----------');
const e1 = doubao.indexOf('let bm25Rules', s1);
if (s1 < 0 || e1 < 0) { console.error('未定位到 LightBM25'); process.exit(1); }
var window = {};
eval(doubao.slice(s1, e1) + '\nwindow.LightBM25 = LightBM25;');
global.window = window;
global.localStorage = { _m: {}, getItem(k) { return this._m[k] === undefined ? null : this._m[k]; }, setItem(k, v) { this._m[k] = String(v); }, removeItem(k) { delete this._m[k]; } };
window.localStorage = global.localStorage;
eval(fs.readFileSync('src/js/modules/knowledge.js', 'utf8'));
const KB = window.KB;
if (!KB) { console.error('未取到 KB'); process.exit(1); }

// ---------- 合成语料 ----------
const BASE = ('接触网 牵引变电所 轨道电路 信号机 道岔 转辙机 接触线 承力索 隔离开关 避雷器 电缆 接地 检修 作业 安全 措施 隐患 整改 违章 防护 限界 高空 停电 验电 挂地线 天窗 施工 机具 材料 绝缘 手套 安全帽 安全带 带电 作业车 梯车 防护员 驻站 联络 限速 封锁 调度 命令 登记 清点 恢复 送电 短路 接地线 短路铜线 停电范围 作业票 工作票 监护 交底 班前会 标准化 专项整治 检查 通报 考核 问责 单位 供电段 工务段 电务段 车辆段 车间 工区 班组 台账 记录 整改通知 复查 验收 隐患库 风险 分级 管控 应急 预案 演练');
const WORDS = BASE.split(' ');
const CN = '零一二三四五六七八九十';
const cnNum = n => n <= 10 ? CN[n] : (n < 20 ? '十' + (n % 10 ? CN[n % 10] : '') : CN[Math.floor(n / 10)] + '十' + (n % 10 ? CN[n % 10] : ''));
function rnd(seed) { let x = seed; return () => { x = (x * 1103515245 + 12345) % 2147483648; return x / 2147483648; }; }
const R = rnd(20260915);
const pick = a => a[Math.floor(R() * a.length)];
const w = () => pick(WORDS);
function sentence(minLen) { let s = ''; while (s.length < minLen) s += w() + (R() < 0.15 ? '、' : ''); return s; }
// 唯一术语（保证 gold 可判定）
const TERMS = [];
for (let i = 0; i < 60000; i++) TERMS.push(w() + w() + w() + i);

const TRADES = ['供电', '工务', '电务', '车辆', '机务', '运输'];
const UNITS = ['某供电段', '某工务段', '某电务段', '某车辆段', '某机务段'];

// 规章制度：687 篇，每篇 ~6000 字，含章/条
const rules = [];
for (let i = 0; i < 687; i++) {
  let body = `第一章 总则\n第一条 为加强${w()}管理，防止${w()}事故，根据有关规定制定本办法。\n`;
  const nClause = 14 + Math.floor(R() * 22);
  for (let k = 2; k <= nClause; k++) {
    if (k % 10 === 2) body += `第${cnNum(Math.ceil(k / 10))}章 管理要求\n`;
    body += `第${cnNum(k)}条 ` + sentence(90 + Math.floor(R() * 150)) + '。' + (R() < 0.5 ? sentence(60 + Math.floor(R() * 120)) + '。' : '') + '\n';
  }
  rules.push({ trade: pick(TRADES), title: `${w()}作业安全管理${pick(['办法', '规定', '细则', '标准'])}（${i + 1}号）`, fileNumber: `铁安〔2026〕${i + 1}号`, content: body });
}
// 检查信息：40166 条；最近 12000 条在窗口内（近半年），其余 28166 条为更早
const NOW = new Date('2026-09-15').getTime();
const DAY = 86400000;
const issues = [];
for (let i = 0; i < 40166; i++) {
  const inWindow = i < 12000;
  const days = inWindow ? Math.floor(R() * 180) : 180 + Math.floor(R() * 900);   // 窗口内 <180 天；窗口外 180~1080 天
  const dt = new Date(NOW - days * DAY).toISOString().slice(0, 10);
  const term = TERMS[i];
  issues.push({
    content: `${sentence(40 + Math.floor(R() * 60))}${term}${sentence(40 + Math.floor(R() * 80))}。`,
    category: pick(['设备管理', '作业纪律', '台账管理', '防护措施', '材料管理']),
    '性质': pick(['A', 'B', 'C']),
    unit: pick(UNITS),
    datetime: dt,
    _old: !inWindow, _term: term
  });
}
// 检查手册 1305 项点 / 电话 839 / 日志 43 / 资料 71 / 报告 53
const handbook = [];
for (let i = 0; i < 1305; i++) handbook.push({ chapter: w() + '检查', section: w() + '部分', item: w() + '项点', subitem: '', content: sentence(80 + Math.floor(R() * 200)) });
const phone = [];
for (let i = 0; i < 839; i++) phone.push({ 单位: pick(UNITS), 站名: w() + '变电所', 线名: w() + '线', 路电: '0' + (1000000 + Math.floor(R() * 8999999)), 市电: '138' + Math.floor(10000000 + R() * 89999999) });
const diary = [];
for (let i = 0; i < 43; i++) diary.push({ date: new Date(NOW - i * DAY).toISOString().slice(0, 10), content: sentence(150 + Math.floor(R() * 300)) });
const materials = [];
for (let i = 0; i < 71; i++) materials.push({ title: w() + '资料' + i, matType: pick(['模板', '报告', '办法']), content: Array.from({ length: 4 + Math.floor(R() * 6) }, () => sentence(120 + Math.floor(R() * 200))).join('\n\n') });
const reports = [];
for (let i = 0; i < 53; i++) reports.push({ title: w() + '检查情况报告' + i, date: new Date(NOW - i * 20 * DAY).toISOString().slice(0, 10), content: Array.from({ length: 5 + Math.floor(R() * 6) }, () => sentence(150 + Math.floor(R() * 250))).join('\n\n') });

window.getRulesData = () => rules;
window.getIssueData = () => issues;
window.getHandbookData = () => handbook;
window.getPhoneData = () => phone;
window.getDiaryData = () => diary;
window._wrGetAllMaterials = () => Promise.resolve(materials);
window._wrGetAllReports = () => Promise.resolve(reports);

const QUERIES = [
  '接触网停电作业未挂地线', '天窗作业未设置防护', '验电挂牌制度执行不到位', '高处作业未系安全带',
  '施工机具侵入限界', '电缆沟积水未整改', '避雷器试验超期', '防护员脱岗'
];
const cnt = s => s.length;

(async () => {
  const t = {};
  let t0 = Date.now();
  await KB.ensure(['rules', 'issues', 'handbook', 'materials', 'reports', 'phone', 'diary']);
  const st = KB.stats();
  console.log('=== 索引规模（窗口=默认）===');
  st.forEach(r => console.log(`  ${r.label}\t${r.total} 条 → ${r.chunks} 块`));
  console.log('  全源构建耗时: ' + (Date.now() - t0) + 'ms\n');

  // ---------- M1：各消费方真实注入量（用与生产代码一致的 search+buildRefText） ----------
  const FULL6 = ['rules', 'issues', 'handbook', 'materials', 'reports', 'phone', 'diary'];
  const cons = {
    '对话(6源 分档2/5 + 总预算4500)': q => KB.buildRefText(KB.search(q, { sources: FULL6, topK: 5, topKByKey: { materials: 2, reports: 2 } }), { totalBudget: 4500 }),
    '对话(6源 topK5，旧口径)': q => KB.buildRefText(KB.search(q, { sources: FULL6, topK: 5 })),
    '对规(rules+issues topK8)': q => KB.buildRefText(KB.search(q, { sources: ['rules', 'issues'], topK: 8 })),
    '写作(issues topK8)': q => KB.buildRefText(KB.search(q, { sources: ['issues'], topK: 8, recentMonth: true })),
    '风险(rules topK10)': q => KB.buildRefText(KB.search(q, { sources: ['rules'], topK: 10 })),
    '智能体(rules topK8)': q => KB.buildRefText(KB.search(q, { sources: ['rules'], topK: 8 }))
  };
  console.log('=== M1 各消费方「单次请求」KB 注入量（8 条真实式查询，字 / 估 token=字÷1.5）===');
  const rows = {};
  Object.keys(cons).forEach(k => { rows[k] = []; });
  const perSrcDetail = {};
  QUERIES.forEach(q => {
    Object.keys(cons).forEach(k => { rows[k].push(cnt(cons[k](q))); });
    const g = KB.search(q, { sources: FULL6, topK: 5 });
    perSrcDetail[q] = g.map(x => `${x.label}:${x.hits.length}块/${x.hits.reduce((a, h) => a + cnt(h.text), 0)}字`);
  });
  Object.keys(rows).forEach(k => {
    const a = rows[k], avg = Math.round(a.reduce((x, y) => x + y, 0) / a.length);
    console.log(`  ${k.padEnd(28)} 平均 ${String(avg).padStart(6)} 字 (≈${String(Math.round(avg / 1.5)).padStart(5)} tok)  最大 ${String(Math.max(...a)).padStart(6)} 字  最小 ${Math.min(...a)}`);
  });
  console.log('\n  单条查询的源级明细（对话配置，前 3 条）：');
  QUERIES.slice(0, 3).forEach(q => console.log(`    "${q}" → ${perSrcDetail[q].join(' | ')}`));

  // ---------- M2：单块成本 + 单源预算 6000 是否触顶 ----------
  console.log('\n=== M2 命中块长度分布（决定"每源 topK×块长"的真实成本）===');
  ['rules', 'issues', 'handbook', 'reports'].forEach(k => {
    const g = KB.search(QUERIES.join(' '), { sources: [k], topK: 5 })[0];
    if (!g || !g.hits.length) return;
    const L = g.hits.map(h => cnt(h.text)).sort((a, b) => a - b);
    const avgL = Math.round(L.reduce((x, y) => x + y, 0) / L.length);
    const full = g.hits.reduce((a, h) => a + cnt(h.text), 0);
    console.log(`  ${g.label.padEnd(8)} 命中块 ${L.length} 个，块长 ${L[0]}~${L[L.length - 1]}（均值 ${avgL}）→ 5 块合计 ${full} 字（单源预算 6000 字${full > 6000 ? ' → 会截断' : ' → 未触顶'}）`);
  });

  // ---------- M3：窗口 vs 全量（口径一致性）+ C2-a 兜底效果 ----------
  console.log('\n=== M3 索引窗口 + C2-a「空命中全量兜底」效果（老记录=窗口外）===');
  // 用「窗口外」的老记录内容做查询，看 KB 能否召回该条
  function recallOf(query, key, target, topK) {
    const g = KB.search(query, { sources: [key], topK: topK })[0];
    if (!g) return { hit: false, rank: -1, fb: false };
    for (let i = 0; i < g.hits.length; i++) if (g.hits[i].doc === target) return { hit: true, rank: i + 1, fb: !!g.fallback };
    return { hit: false, rank: -1, fb: !!g.fallback };
  }
  const PICK_N = 30;
  for (const cfg of [{ fb: true, windowed: true, name: '窗口=最近 12000 + 兜底开（C2-a 生效后）' }, { fb: false, windowed: true, name: '窗口=最近 12000 + 兜底关（C2-a 之前）  ' }, { fb: true, windowed: false, name: '窗口=全量 40166 + 兜底开（对照）       ' }]) {
    if (cfg.fb) localStorage.removeItem('kb_fallback'); else localStorage.setItem('kb_fallback', '0');
    KB.setIssueLimit(cfg.windowed ? 12000 : 0);
    KB.invalidate('issues');
    const t1 = Date.now();
    await KB.ensure(['issues']);
    const buildMs = Date.now() - t1;
    const stI = KB.stats().filter(r => r.key === 'issues')[0];
    let old_hit = 0, new_hit = 0, fbUsed = 0;
    const t3 = Date.now();
    for (let i = 0; i < PICK_N; i++) {
      const oldT = issues[13000 + i * 900];        // 窗口外
      const newT = issues[Math.floor(R() * 11999)]; // 窗口内
      const ro = recallOf(oldT._term, 'issues', oldT, 4);
      if (ro.hit) old_hit++;
      if (ro.fb) fbUsed++;
      if (recallOf(newT._term, 'issues', newT, 4).hit) new_hit++;
    }
    const searchMs = ((Date.now() - t3) / PICK_N).toFixed(1);
    console.log(`  ${cfg.name}  索引 ${stI.chunks} 块，构建 ${String(buildMs).padStart(5)}ms  老记录召回 ${old_hit}/${PICK_N}${fbUsed ? '（全走兜底）' : ''}  新记录召回 ${new_hit}/${PICK_N}  平均检索 ${searchMs}ms/次`);
  }
  localStorage.removeItem('kb_fallback');
  KB.setIssueLimit(12000); KB.invalidate('issues'); await KB.ensure(['issues']);
  // 口径标注是否真的进了引用文本
  const noteTxt = KB.buildRefText(KB.search(QUERIES[0], { sources: ['issues'], topK: 3 }));
  console.log(`  引用文本里的口径标注：${noteTxt.split('\n')[0].slice(0, 120)}`);

  // ---------- M4：统一预算 vs 按源分档 topK 的真实节省 ----------
  await KB.ensure(FULL6);        // ⚠️ M3 的 setIssueLimit 会连带失效其它源，测量前必须重新确保
  console.log('\n=== M4 对话单轮注入：现状 vs「按源分档 topK」===');
  const styleSrc = ['materials', 'reports'];     // 仅"文风/格式参考"用途的源
  const bizSrc = ['rules', 'issues', 'handbook', 'phone', 'diary'];
  const variants = [
    { name: '现状（每源 topK5，无总量预算）', style: 5, biz: 5, budget: 0 },
    { name: '文风源 topK2 / 业务源 topK5', style: 2, biz: 5, budget: 0 },
    { name: 'C1 实施后（分档 + 总量 4500）', style: 2, biz: 5, budget: 4500 },
    { name: '文风源 topK1 / 业务源 topK5', style: 1, biz: 5, budget: 0 },
    { name: '文风源 topK2 / 业务源 topK8', style: 2, biz: 8, budget: 0 }
  ];
  const base = [];
  variants.forEach(v => {
    const chars = [], detail = [];
    QUERIES.forEach(q => {
      const gs = KB.search(q, { sources: FULL6, topK: Math.max(v.style, v.biz) });
      // 按源裁剪到各自 topK（模拟分档）
      gs.forEach(g => { const cap = styleSrc.indexOf(g.key) >= 0 ? v.style : v.biz; g.hits = g.hits.slice(0, cap); });
      chars.push(cnt(KB.buildRefText(gs, { totalBudget: v.budget })));
      if (detail.length < 1) detail.push(gs.map(g => `${g.label}:${g.hits.length}`).join(','));
    });
    const avg = Math.round(chars.reduce((a, b) => a + b, 0) / chars.length);
    if (!base.length) base.push(avg);
    const save = Math.round((1 - avg / base[0]) * 100);
    console.log(`  ${v.name.padEnd(30)} 平均 ${String(avg).padStart(5)} 字 (≈${String(Math.round(avg / 1.5)).padStart(4)} tok)  相对现状 ${save >= 0 ? '-' + save : '+' + (-save)}%   [${detail[0]}]`);
  });
  // 现状构成拆解（业务源 vs 文风源）
  let bizSum = 0, styleSum = 0;
  QUERIES.forEach(q => {
    KB.search(q, { sources: FULL6, topK: 5 }).forEach(g => {
      const c = g.hits.reduce((a, h) => a + cnt(h.path) + cnt(h.text) + 6, 0) + 40;
      (styleSrc.indexOf(g.key) >= 0 ? (styleSum += c) : (bizSum += c));
    });
  });
  console.log(`  构成拆解（8 条查询合计）：业务源 ${bizSum} 字 vs 文风源 ${styleSum} 字（文风占 ${Math.round(styleSum / (bizSum + styleSum) * 100)}%）`);

  // ---------- M5：全表扫描代价（评估"窗口外老数据用全量检索兜底"是否可行） ----------
  console.log('\n=== M5 全量台账扫描代价（40166 条）===');
  const kw = ['接触网', '挂地线'];
  let t2 = Date.now();
  for (let r = 0; r < 5; r++) issues.filter(it => kw.every(k => it.content.indexOf(k) !== -1)).length;
  const scanMs = ((Date.now() - t2) / 5).toFixed(1);
  t2 = Date.now();
  for (let r = 0; r < 5; r++) { const lower = QUERIES[r].split(' '); issues.filter(it => lower.some(k => it.content.indexOf(k) !== -1)).length; }
  const scanMs2 = ((Date.now() - t2) / 5).toFixed(1);
  console.log(`  纯 indexOf 全表筛一遍：${scanMs}ms / ${scanMs2}ms（一次，未建索引） → 作为"空命中兜底"完全可接受`);
  console.log(`  窗口覆盖率：默认窗口 12000/40166 = ${Math.round(12000 / 40166 * 100)}% 的台账可被 KB 检索到，${100 - Math.round(12000 / 40166 * 100)}% 的老数据 KB 完全查不到（须靠全量工具）`);

  // ---------- M6：兜底对"正常新数据查询"的噪声与耗时（防止为救老数据污染常规结果） ----------
  console.log('\n=== M6 兜底对常规查询的影响（源=检查信息，topK5）===');
  const probe = QUERIES.concat(['接触网 作业 安全', '验电', '检查']);
  [false, true].forEach(on => {
    if (on) localStorage.removeItem('kb_fallback'); else localStorage.setItem('kb_fallback', '0');
    const stats6 = [];
    probe.forEach(q => {
      const t = Date.now();
      const g = KB.search(q, { sources: ['issues'], topK: 5 })[0];
      const ms = Date.now() - t;
      const fb = g ? g.hits.filter(h => h.fallback).length : 0;
      stats6.push({ q, n: g ? g.hits.length : 0, fb, ms });
    });
    const avgMs = (stats6.reduce((a, s) => a + s.ms, 0) / stats6.length).toFixed(1);
    const avgFb = (stats6.reduce((a, s) => a + s.fb, 0) / stats6.length).toFixed(1);
    const totalFb = stats6.reduce((a, s) => a + s.fb, 0);
    console.log(`  兜底${on ? '开' : '关'}：平均 ${avgMs}ms/次，平均注入窗口外命中 ${avgFb} 条（合计 ${totalFb} 条），明细：${stats6.map(s => `${s.q.slice(0, 6)}=${s.n}块/${s.fb}兜底/${s.ms}ms`).join(' , ')}`);
  });
  localStorage.removeItem('kb_fallback');
})().catch(e => { console.error('测量失败：', e); process.exit(1); });
