/* 知识库基准/验证台
 * ============================================================================
 * 两部分：
 *   A) 规章 A/B：旧「整篇匹配 + 截前 300 字」 vs 新「条款级分块」，用**已知正确条款**客观打分。
 *   B) 多源冒烟：为 6 类源造少量样本，验证 KB.search / buildRefText / stats 全链路可用。
 *
 * 用法：
 *   node scripts/kb-ab-bench.js                          A 部分（默认 500 部 × 40 条）+ B 部分
 *   node scripts/kb-ab-bench.js 200 30                   自定义规模
 *   node scripts/kb-ab-bench.js --rules=我的规章.json     真实数据（无 gold，并排打印供人工判读）
 * 说明：scripts/ 不进部署；本文件只供本机验证，用完可留作回归工具。
 */
const fs = require('fs');

// ---------- 取真实代码：LightBM25（doubao.js） + KB（knowledge.js） ----------
const doubao = fs.readFileSync('src/js/modules/doubao.js', 'utf8');
const s1 = doubao.indexOf('// ---------- 4. 轻量级 BM25 检索器 ----------');
const e1 = doubao.indexOf('let bm25Rules', s1);
if (s1 < 0 || e1 < 0) { console.error('未定位到 LightBM25'); process.exit(1); }
var window = {};
eval(doubao.slice(s1, e1) + '\nwindow.LightBM25 = LightBM25;');
eval(fs.readFileSync('src/js/modules/knowledge.js', 'utf8'));
const KB = window.KB;
if (!KB) { console.error('未取到 KB'); process.exit(1); }

// ============================================================================
// 通用：合成语料
// ============================================================================
const BASE = ('接触网 牵引变电所 轨道电路 信号机 道岔 转辙机 接触线 承力索 隔离开关 避雷器 电缆 接地 检修 作业 安全 措施 隐患 整改 违章 防护 限界 高空 停电 验电 挂地线 天窗 施工作业 行车 调度 值班 巡检 巡视 台账 记录 写实 通报 考核 责任 落实 制度 规章 条款 铁路 工务 电务 供电 车务 机务 车辆 通信 房建 客运 货运 站台 线路 桥梁 隧道 涵洞 路基 边坡 挡墙 排水 限速 封锁 恢复 开通 验收 交底 盯控 把关 联控 互控 应急预案 演练 培训 教育 考试 持证 上岗 疲劳 饮酒 着装 防护服 安全帽 安全带 绝缘 手套 作业车 轨道车 起重机 吊装 焊接 切割 打磨 除锈 涂装 支柱 腕臂 吊弦 定位器 补偿装置 张力 弛度 磨耗 绝缘子 断路器 变压器 互感器 翻浆冒泥 轨道几何尺寸 无缝线路 钢轨伤损 道床 扣件 轨枕 尖轨 基本轨 导曲线 密贴 表示杆 外锁闭 转极 极性交叉 分路不良 轨道绝缘节 扼流变压器 电码化 应答器 计轴 道口 信号显示 联锁 闭塞 区间 站内 调车 溜放 防溜 铁鞋 车辆溜逸 装载加固 超限货物 危险货物 押运 篷布 施封锁 手制动机 制动软管 车钩 缓冲器 旁承 转向架 轮对 轴承 轴温 探伤 超声波 磁粉 涡流 拉伤 剥离 掉块 擦伤 燃轴 热轴').split(/\s+/);
const WORDS = BASE.slice();
for (let i = 0; WORDS.length < 40000; i++) {
  const a = BASE[i % BASE.length], b = BASE[(i * 7 + 5) % BASE.length], c = BASE[(i * 11 + 3) % BASE.length];
  WORDS.push(a + b);
  if (c !== a && c !== b) WORDS.push(b + c);
}
const CN = '零一二三四五六七八九十';
function cnNum(n) { if (n <= 10) return CN[n]; if (n < 20) return '十' + (n % 10 ? CN[n % 10] : ''); return CN[Math.floor(n / 10)] + '十' + (n % 10 ? CN[n % 10] : ''); }
function rnd(seed) { let x = seed; return function () { x = (x * 1103515245 + 12345) % 2147483648; return x / 2147483648; }; }
const R = rnd(20260915);
const zipf = () => Math.min(WORDS.length - 1, Math.floor(Math.pow(R(), 3.0) * WORDS.length));
const baseWord = () => BASE[Math.min(BASE.length - 1, Math.floor(Math.pow(R(), 2.0) * BASE.length))];

function makeCorpus(nRules, clausesPer) {
  const rules = [], golds = [], df = new Map(), usedTerms = new Set();
  for (let i = 0; i < nRules; i++) {
    const trade = baseWord().slice(0, 2);
    const topic = [];
    for (let t = 0, tn = 3 + Math.floor(R() * 4); t < tn; t++) { const w = baseWord(); if (topic.indexOf(w) < 0) topic.push(w); }
    const title = topic[0] + ['作业安全管理办法', '检修实施细则', '安全管理规定', '防护办法', '技术管理规则'][Math.floor(R() * 5)] + '（' + (i + 1) + '号）';
    const head = '第' + cnNum(1) + '条 为加强' + topic[0] + '管理，防止' + topic[topic.length - 1] + '事故，保障人身与设备安全，根据铁路有关规程制定本办法。';
    const parts = [head], spans = [];
    let pos = head.length + 1;
    const goldK = 2 + Math.floor(R() * (clausesPer - 1));       // gold 位置在正文里均匀分布
    let planted = '';
    do { planted = baseWord() + baseWord(); } while (usedTerms.has(planted) || planted.length < 4);
    usedTerms.add(planted);
    for (let k = 2; k <= clausesPer; k++) {
      if (k % 12 === 2) { const h = '\n第' + cnNum(Math.ceil(k / 12)) + '章 ' + topic[Math.floor(R() * topic.length)] + '管理'; parts.push(h); pos += h.length + 1; }
      const target = 140 + Math.floor(R() * 130);
      let body = '';
      while (body.length < target) {
        const w = R() < 0.7 ? topic[Math.floor(R() * topic.length)] : WORDS[zipf()];
        body += w + (R() < 0.3 ? '。' : (R() < 0.5 ? '；' : '，'));
      }
      let clause = '第' + cnNum(k) + '条 ' + body.slice(0, target) + '。';
      if (k === goldK) { const at = Math.floor(clause.length / 2); clause = clause.slice(0, at) + planted + '，' + clause.slice(at); }
      spans.push({ idx: pos, text: clause });
      parts.push(clause);
      pos += clause.length + 1;
    }
    const content = parts.join('\n');
    const rule = { id: i, title: title, trade: trade, content: content };
    rules.push(rule);
    BASE.forEach(w => { if (content.indexOf(w) >= 0) df.set(w, (df.get(w) || 0) + 1); });
    golds.push({ ruleIdx: i, gold: spans[goldK - 2], topic: topic, planted: planted });
  }
  golds.forEach(g => {
    const cand = [...new Set(g.topic)].sort((a, b) => (df.get(a) || 0) - (df.get(b) || 0));
    g.query = [g.planted].concat(cand.slice(0, 2)).join(' ');
  });
  return { rules, golds, df };
}

// ============================================================================
// A) 规章 A/B
// ============================================================================
function oldRefText(rules, query, bm) {
  const hits = bm.search(query, 4);
  let text = '';
  hits.forEach((r, i) => {
    const c = String(r.content || '');
    text += (i + 1) + '. 《' + r.title + '》（' + (r.trade || '通用') + '）\n   ' + c.slice(0, 300) + (c.length > 300 ? '…' : '') + '\n';
  });
  return { text, hits };
}
function goldCharsOld(gold, hit) {
  if (!hit) return 0;
  return Math.max(0, Math.min(300, gold.idx + gold.text.length) - gold.idx);
}
function goldCharsNew(hits, rule, gold) {
  const merged = hits.filter(h => h.doc === rule).map(h => h.text).join('\n');
  if (!merged) return 0;
  if (merged.indexOf(gold.text) >= 0) return gold.text.length;
  for (let L = gold.text.length - 10; L >= 10; L -= 10) if (merged.indexOf(gold.text.slice(0, L)) >= 0) return L;
  return 0;
}

function runRulesAB(N_RULES, CLAUSES) {
  const { rules, golds } = makeCorpus(N_RULES, CLAUSES);
  const totalChars = rules.reduce((a, r) => a + r.content.length, 0);
  KB.invalidate();
  window.getRulesData = function () { return rules; };
  // 两条路径的语料都含标题（用 searchText 携带，content 保持原值）—— 与修复后的真实代码一致
  const bm = new window.LightBM25(rules.map(r => ({ ...r, searchText: (r.title + ' ' + r.content) })));

  const M = golds.length, rows = [];
  let oFull = 0, oPart = 0, oNone = 0, oRuleOk = 0, nFull = 0, nPart = 0, nNone = 0, nRuleOk = 0;
  let oChars = 0, nChars = 0, goldLenSum = 0, oCtx = 0, nCtx = 0;
  let cN = 0, cOldFull = 0, cNewFull = 0, cOldChars = 0, cNewChars = 0, cGoldLen = 0;

  golds.forEach(g => {
    const rule = rules[g.ruleIdx], goldLen = g.gold.text.length;
    goldLenSum += goldLen;

    const o = oldRefText(rules, g.query, bm);
    const oHit = o.hits.find(h => h.title === rule.title);
    const oc = goldCharsOld(g.gold, oHit);
    oCtx += o.text.length; oChars += oc;
    if (!oHit) oNone++; else if (oc >= goldLen) oFull++; else if (oc > 0) oPart++; else oNone++;
    if (oHit) oRuleOk++;

    const nHits = KB.searchRules(g.query, 4);
    const nText = KB.buildRefText([{ key: 'rules', label: '规章制度', grain: '条款', total: rules.length, hits: nHits }]);
    const nc = goldCharsNew(nHits, rule, g.gold);
    const nHit = nHits.some(h => h.doc === rule);
    nCtx += nText.length; nChars += nc;
    if (!nHit) nNone++; else if (nc >= goldLen) nFull++; else if (nc > 0) nPart++; else nNone++;
    if (nHit) nRuleOk++;

    if (oHit && nHit) {
      cN++; cGoldLen += goldLen;
      if (oc >= goldLen) cOldFull++;
      if (nc >= goldLen) cNewFull++;
      cOldChars += oc; cNewChars += nc;
    }
    rows.push({ depth: g.gold.idx, oFull: oc >= goldLen, nFull: nc >= goldLen });
  });

  const pct = (x, base) => base ? ((x / base) * 100).toFixed(0) + '%' : '—';
  const stR = KB.stats().filter(s => s.key === 'rules')[0];
  console.log(`\n════ A) 规章 A/B ════`);
  console.log(`语料：${N_RULES} 部 × ${CLAUSES} 条 = ${(totalChars / 10000).toFixed(1)} 万字 → 分块 ${stR ? stR.chunks : '?'} 块`);
  console.log(`查询：${M} 个（每个都指向一条已知的正确条款；正确条款平均 ${(goldLenSum / M).toFixed(0)} 字，平均位于正文第 ${(golds.reduce((a, g) => a + g.gold.idx, 0) / M).toFixed(0)} 字处）\n`);
  console.log('  ┌──────────────────────────────┬────────────────┬────────────────┐');
  console.log('  │ 指标                          │ 旧：整篇截300字 │ 新：条款分块   │');
  console.log('  ├──────────────────────────────┼────────────────┼────────────────┤');
  console.log(`  │ 正确条款**完整**进上下文       │ ${pct(oFull, M).padStart(14)} │ ${pct(nFull, M).padStart(14)} │`);
  console.log(`  │ 正确条款**部分**进上下文       │ ${pct(oPart, M).padStart(14)} │ ${pct(nPart, M).padStart(14)} │`);
  console.log(`  │ 正确条款**完全没进**上下文     │ ${pct(oNone, M).padStart(14)} │ ${pct(nNone, M).padStart(14)} │`);
  console.log(`  │ 命中正确规章                  │ ${pct(oRuleOk, M).padStart(14)} │ ${pct(nRuleOk, M).padStart(14)} │`);
  console.log(`  │ 平均送入的正确条款字数        │ ${(oChars / M).toFixed(0).padStart(14)} │ ${(nChars / M).toFixed(0).padStart(14)} │`);
  console.log(`  │ 平均上下文总字数              │ ${(oCtx / M).toFixed(0).padStart(14)} │ ${(nCtx / M).toFixed(0).padStart(14)} │`);
  console.log('  └──────────────────────────────┴────────────────┴────────────────┘');
  console.log('\n  按正确条款深度分档（完整进上下文的比例）：');
  [[0, 300, '正文前 300 字内'], [300, 1000, '第 300~1000 字'], [1000, Infinity, '第 1000 字之后']].forEach(b => {
    const sel = rows.filter(r => r.depth >= b[0] && r.depth < b[1]);
    if (!sel.length) return;
    console.log(`    ${b[2].padEnd(16)} 样本 ${String(sel.length).padStart(3)} →  旧 ${pct(sel.filter(r => r.oFull).length, sel.length).padStart(5)}   新 ${pct(sel.filter(r => r.nFull).length, sel.length).padStart(5)}`);
  });
  console.log(`\n  条件化（两条路径都命中正确规章的 ${cN} 个查询）：完整进上下文 旧 ${pct(cOldFull, cN)} → 新 ${pct(cNewFull, cN)}；送入字数 旧 ${cN ? (cOldChars / cN).toFixed(0) : '—'} → 新 ${cN ? (cNewChars / cN).toFixed(0) : '—'}`);
  const t0 = performance.now();
  for (let i = 0; i < 30; i++) KB.searchRules(golds[i % M].query, 4);
  console.log(`  检索耗时：${((performance.now() - t0) / 30).toFixed(2)}ms/次\n`);
}

// ============================================================================
// B) 多源冒烟（6 类源全链路）
// ============================================================================
function runMultiSourceSmoke() {
  const rules = [
    { id: 'r1', trade: '供电', title: '接触网检修作业安全管理办法', content: '第一章 一般规定\n第一条 为加强接触网检修作业安全管理，制定本办法。\n第二条 接触网停电作业必须先验电、后挂地线，挂地线位置应与作业地点可见。' },
    { id: 'r2', trade: '工务', title: '线路巡检实施细则', content: '第一条 为规范线路巡检，制定本细则。\n第二条 巡检发现道岔尖轨密贴不良时，应立即通知车站并登记隐患台账。' }
  ];
  const issues = [
    { content: '现场检查发现接触网停电作业未按规定挂设地线', category: '设备管理', '性质': 'A', datetime: '2026-09-10', unit: '某供电段' },
    { content: '接触网承力索张力超标，未及时整改', category: '设备管理', '性质': 'B', datetime: '2026-08-02', unit: '某供电段' },
    { content: '线路巡检未按规定登记隐患台账', category: '规章制度', '性质': 'C', datetime: '2025-12-20', unit: '某工务段' }
  ];
  const handbook = [
    { chapter: '第二章 供电专业', section: '第一节 接触网', item: '项点 2.1 停电作业', subitem: '', content: '检查是否执行停电、验电、挂地线三项措施；地线数量与位置是否符合规定。' },
    { chapter: '第三章 工务专业', section: '第一节 线路', item: '项点 3.4 道岔检查', subitem: '', content: '检查尖轨密贴、排障器、连接杆状态。' }
  ];
  const materials = [
    { id: 'm1', title: '接触网停电作业整改通知（范例）', matType: '通报文电', content: '一、问题描述\n某工区接触网停电作业未挂设地线。\n二、整改要求\n立即停止作业，补齐地线并组织全员学习相关条款。' },
    { id: 'm2', title: '安全检查写作模板', matType: 'template', content: '一、检查概况\n{{概况}}\n二、发现问题\n{{问题}}\n三、整改要求\n{{要求}}' }
  ];
  const reports = [{ id: 'p1', title: '2026年8月安全检查月度报告', date: '2026-08-31', content: '本月共检查发现各类问题26件。\n其中A类2件，涉及接触网停电作业防护不到位。' }];
  const phone = [
    { 单位: '某供电段调度', 站名: '某牵引变电所', 线名: '京沪线', 路电: '1234', 市电: '0311-88888888' },
    { 单位: '某工务段值班室', 站名: '某站', 线名: '京广线', 路电: '5678', 市电: '' }
  ];
  const diary = [
    { date: '2026-09-12', work: '跟班检查接触网停电作业现场', issues: ['发现未挂地线1处'] },
    { date: '2026-09-13', work: '整理检查资料', issues: [] }
  ];

  window.getRulesData = () => rules;
  window.getIssueData = () => issues;
  window.getHandbookData = () => handbook;
  window.getPhoneData = () => phone;
  window.getDiaryData = () => diary;
  window._wrGetAllMaterials = () => Promise.resolve(materials);
  window._wrGetAllReports = () => Promise.resolve(reports);
  KB.invalidate();

  return KB.ensure(['materials', 'reports']).then(function () {
    console.log('════ B) 多源冒烟（6 类源全链路）════\n');
    const st = KB.stats();
    st.forEach(s => console.log(`  ${s.chunks ? '🟢' : '⚪'} ${s.label.padEnd(6)} ${String(s.total).padStart(2)} 条 → ${String(s.chunks).padStart(2)} 块（按${s.grain}）${s.async ? ' [异步源]' : ''}`));

    const q = '接触网停电作业未挂地线';
    const res = KB.search(q, { sources: ['rules', 'issues', 'handbook', 'materials', 'reports', 'phone', 'diary'], topK: 2 });
    console.log(`\n  查询「${q}」命中 ${res.length} 个源：`);
    res.forEach(r => console.log(`    · ${r.label}：命中 ${r.hits.length} 块 → ${r.hits[0].path}`));

    // 近一个月过滤（智能写作口径）
    const recent = KB.search('接触网', { sources: ['issues'], topK: 5, recentMonth: true });
    console.log(`\n  recentMonth 过滤（issues）命中 ${recent.length ? recent[0].hits.length : 0} 块（应只剩 2026-09-10 那条，2025-12-20 被滤掉）`);

    console.log('\n  组装出的引用文本（前 700 字，即真正喂给模型的内容）：');
    console.log('  ' + KB.buildRefText(res).slice(0, 700).replace(/\n/g, '\n  '));

    // 空库/无命中不应抛错
    KB.invalidate();
    window.getIssueData = () => [];
    const empty = KB.search('接触网', { sources: ['issues', 'handbook'], topK: 2 });
    console.log(`\n  空数据源检索：返回 ${empty.length} 个源（应为 0，且不抛错）✓`);
  });
}

// ============================================================================
// C) 真实规模压测（--scale）：按用户实际条数/字数估算索引开销与耗时
// ============================================================================
function makeText(len) { let s = ''; while (s.length < len) s += WORDS[zipf()] + (R() < 0.2 ? '，' : ''); return s.slice(0, len) + '。'; }

function makeScaleData(cfg) {
  const corpus = makeCorpus(cfg.rules.n, Math.max(2, Math.round(cfg.rules.len / 180)));
  return {
    rules: corpus.rules,
    issues: Array.from({ length: cfg.issues.n }, (_, i) => ({ content: makeText(cfg.issues.len), category: WORDS[zipf()], '性质': ['A', 'B', 'C'][i % 3], datetime: '2026-0' + (1 + i % 9) + '-1' + (i % 9), unit: WORDS[zipf()] })),
    handbook: Array.from({ length: cfg.handbook.n }, (_, i) => ({ chapter: '第' + cnNum(1 + i % 8) + '章 ' + baseWord(), section: '第' + cnNum(1 + i % 6) + '节 ' + baseWord(), item: '项点 ' + (i % 40) + ' ' + baseWord(), subitem: '', content: makeText(cfg.handbook.len) })),
    phone: Array.from({ length: cfg.phone.n }, (_, i) => ({ 单位: baseWord() + '段', 站名: baseWord() + '站', 线名: ['京沪线', '京广线', '陇海线'][i % 3], 路电: String(1000 + i), 市电: '0' + (300 + i % 99) + '-' + String(1000000 + i * 7) })),
    diary: Array.from({ length: cfg.diary.n }, (_, i) => ({ date: '2026-0' + (1 + i % 9) + '-' + String(1 + i % 27).padStart(2, '0'), work: makeText(Math.round(cfg.diary.len * 0.6)), issues: [makeText(40)] })),
    materials: Array.from({ length: cfg.materials.n }, (_, i) => ({ id: 'm' + i, title: baseWord() + '资料' + i, matType: ['参考材料', 'template', '通报文电'][i % 3], content: makeText(cfg.materials.len) })),
    reports: Array.from({ length: cfg.reports.n }, (_, i) => ({ id: 'p' + i, title: baseWord() + '检查报告' + i, date: '2026-0' + (1 + i % 9) + '-28', content: makeText(cfg.reports.len) }))
  };
}

function runScale() {
  // 默认按用户实际规模（可在命令行覆盖：--scale=rules:687:2000,issues:40166:150 …）
  const cfg = {
    rules: { n: 687, len: 2000 }, issues: { n: 40166, len: 150 }, handbook: { n: 1305, len: 230 },
    phone: { n: 839, len: 40 }, diary: { n: 42, len: 300 }, materials: { n: 73, len: 2000 }, reports: { n: 52, len: 3000 }
  };
  const arg = (process.argv.find(a => a.startsWith('--scale=')) || '').split('=')[1];
  if (arg) arg.split(',').forEach(x => { const [k, n, len] = x.split(':'); if (cfg[k] && n) { cfg[k].n = +n; if (len) cfg[k].len = +len; } });

  const d = makeScaleData(cfg);
  const totalChars = d.rules.reduce((a, r) => a + r.content.length, 0) + d.issues.reduce((a, i) => a + i.content.length, 0)
    + d.handbook.reduce((a, h) => a + h.content.length, 0) + d.materials.reduce((a, m) => a + m.content.length, 0)
    + d.reports.reduce((a, r) => a + r.content.length, 0) + d.diary.reduce((a, x) => a + x.work.length, 0) + d.phone.length * 40;

  window.getRulesData = () => d.rules;
  window.getIssueData = () => d.issues;
  window.getHandbookData = () => d.handbook;
  window.getPhoneData = () => d.phone;
  window.getDiaryData = () => d.diary;
  window._wrGetAllMaterials = () => Promise.resolve(d.materials);
  window._wrGetAllReports = () => Promise.resolve(d.reports);
  KB.invalidate();

  const gc2 = () => { if (global.gc) { global.gc(); global.gc(); } };
  const heap = () => Math.round(process.memoryUsage().heapUsed / 1048576 * 10) / 10;

  console.log('\n════ C) 真实规模压测 ════');
  console.log(`总计约 ${(totalChars / 10000).toFixed(0)} 万字（规章 ${cfg.rules.n} 条 / 检查信息 ${cfg.issues.n} 条 / 手册 ${cfg.handbook.n} 条 / 电话 ${cfg.phone.n} 条 / 日志 ${cfg.diary.n} 条 / 资料 ${cfg.materials.n} 条 / 报告 ${cfg.reports.n} 条）\n`);

  return KB.ensure(['materials', 'reports']).then(function () {
    gc2(); const h0 = heap();
    const keys = ['rules', 'issues', 'handbook', 'materials', 'reports', 'phone', 'diary'];
    keys.forEach(function (k) {
      const t0 = performance.now();
      KB.search('接触网 检修 作业 安全 措施', { sources: [k], topK: 4 });   // 首次：含建索引
      const buildMs = Math.round(performance.now() - t0);
      gc2(); const h = Math.round((heap() - h0) * 10) / 10;
      const s = KB.stats().filter(x => x.key === k)[0];
      const t1 = performance.now();
      KB.search('道岔 隐患 整改 要求', { sources: [k], topK: 4 });          // 后续：索引已建
      const qMs = Math.round((performance.now() - t1) * 10) / 10;
      console.log(`  ${s.label.padEnd(6)} ${String(s.total).padStart(6)} 条 → ${String(s.chunks).padStart(6)} 块 │ 建索引+首检 ${String(buildMs).padStart(5)}ms │ 后续检索 ${String(qMs).padStart(6)}ms │ 常驻 +${h}MB`);
    });
    gc2();
    console.log(`\n  全部建好后常驻内存合计：+${Math.round((heap() - h0) * 10) / 10}MB`);
    const t2 = performance.now();
    const all = KB.search('接触网停电作业未挂地线如何定性', { sources: keys, topK: 4 });
    console.log(`  跨全部 7 源单次检索：${Math.round((performance.now() - t2) * 10) / 10}ms，命中 ${all.length} 个源（各 ${all.map(r => r.hits.length).join('/')} 块）`);
    console.log(`  ⚠️ 上面"建索引+首检"是**同步**路径（消费方若忘记 ensure 就是这种阻塞）；下面是真实调用路径（分片异步）\n`);

    // 分片异步建索引（真实调用路径）：测总耗时与"最大单次阻塞"
    KB.invalidate();
    const t3 = performance.now();
    const gaps = {};
    return KB.ensure(keys, {
      onProgress: function (key, done, total) {
        const now = performance.now();
        const g = gaps[key] || (gaps[key] = { last: now, max: 0 });
        g.max = Math.max(g.max, now - g.last);
        g.last = now;
        if (done === total) g.total = now - (g.start || now);
      }
    }).then(function () {
      const totalMs = Math.round(performance.now() - t3);
      let worst = 0, worstKey = '';
      Object.keys(gaps).forEach(function (k) { if (gaps[k].max > worst) { worst = gaps[k].max; worstKey = k; } });
      console.log(`  分片异步建索引：全部 7 源总耗时 ${totalMs}ms，**最大单次阻塞 ${Math.round(worst)}ms**（${worstKey}）—— 界面在此期间仍可响应，且会显示进度条`);
      const after = KB.search('接触网停电作业未挂地线如何定性', { sources: keys, topK: 4 });
      console.log(`  索引就绪后跨 7 源检索：命中 ${after.length} 个源（各 ${after.map(r => r.hits.length).join('/')} 块）`);

      // 等价性：同一份分块语料，「同步建索引」与「分片异步建索引」的检索结果必须完全一致
      const q = '接触网 检修 作业 安全 措施';
      const pathOf = r => (r.length ? r[0].hits.map(h => h.path).join(' | ') : '(无)');
      KB.invalidate('rules');
      const syncRes = window.KB.searchRules(q, 4);                 // 未 ensure → 走同步建索引
      const syncText = pathOf([{ hits: syncRes }]);
      KB.invalidate('rules');
      return KB.ensure(['rules']).then(function () {
        const asyncText = pathOf(KB.search(q, { sources: ['rules'], topK: 4 }));
        console.log(`\n  等价性（同步建 vs 分片异步建 · 规章 top-4）：${syncText === asyncText ? '一致 ✓' : '不一致 ✗\n    同步: ' + syncText + '\n    异步: ' + asyncText}\n`);
      });
    });
  });
}

// ============================================================================
// 真实数据模式
// ============================================================================
const argRules = (process.argv.find(a => a.startsWith('--rules=')) || '').split('=')[1];
if (process.argv.some(a => a.startsWith('--scale'))) {
  runScale().catch(function (e) { console.error('压测失败：', e); process.exit(1); });
} else if (argRules) {
  let rules;
  try { rules = JSON.parse(fs.readFileSync(argRules, 'utf8')); } catch (e) { console.error('读取失败：' + e.message); process.exit(1); }
  if (!Array.isArray(rules)) rules = rules.data || rules.rules || [];
  KB.invalidate();
  window.getRulesData = () => rules;
  const bm = new window.LightBM25(rules.map(r => ({ ...r, searchText: (r.title + ' ' + r.content) })));
  const t0 = performance.now();
  KB.searchRules('接触网 检修 安全 措施', 4);
  const stR = KB.stats().filter(s => s.key === 'rules')[0];
  console.log(`\n真实数据：${rules.length} 部规章 / ${rules.reduce((a, r) => a + String(r.content || '').length, 0)} 字`);
  console.log(`分块：${stR.chunks} 块（平均 ${(stR.chunks / Math.max(1, rules.length)).toFixed(1)} 块/部）｜首次建索引 ${(performance.now() - t0).toFixed(0)}ms\n`);
  ['接触网 检修 作业 安全 措施', '道岔 隐患 整改 要求', '未设置防护 盯控', '信号 电缆 接地 试验'].forEach(q => {
    console.log(`\n══ 查询：${q}`);
    console.log('【旧｜整篇截 300 字】');
    console.log('  ' + oldRefText(rules, q, bm).text.replace(/\n/g, '\n  ').slice(0, 600));
    console.log('【新｜条款分块】');
    KB.searchRules(q, 4).forEach(h => console.log('  · ' + h.path + '\n    ' + h.text.slice(0, 260)));
  });
} else {
  runRulesAB(+(process.argv[2] || 500), +(process.argv[3] || 40));
  runMultiSourceSmoke().catch(e => { console.error('多源冒烟失败：', e); process.exit(1); });
}
