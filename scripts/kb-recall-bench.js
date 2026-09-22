/**
 * 知识库召回率基线（阶段 0：决定要不要做向量索引）
 * ===================================================
 * 思路：真实数据里每条"检查信息"都带 `regulation` 字段 —— **它自己引用的规章条款**
 *   （例："不符合《兰州局集团公司道岔除雪管理办法》第十一条「…」要求。"）。
 *   → 完美 ground truth，**零人工标注**：
 *       query  = 检查信息的现场描述（口语化、含时间地点人物）
 *       target = 它引用的那篇规章（规章库里有同名篇时才算有效样本）
 *     "现场描述 → 找到它引用的规章条款"正是对规主链路的真实任务。
 *
 * 指标：Recall@1/3/5/10、MRR、漏检构成（按"query 与目标正文的 2-gram 重合率"分档：
 *   高重合=语料里有近似表达→属排序问题；低重合=表达差异大→**这才是向量能补的**）。
 *
 * 用法：node scripts/kb-recall-bench.js       （缺真实测试数据时 SKIP）
 */
'use strict';
const H = require('./audit-harness');
const fs = require('fs');
const path = require('path');
const ZIPNAME = '安监系统测试数据.zip';
const PAIRS = +(process.env.PAIRS || 80);   // 取样条数（PAIRS=60 node ... 可调小，跑得快）
const MODE = process.env.MODE || 'full';    // full=生产基线+消融；abl=只跑归因消融（跳过慢的生产召回循环）
const TOPK = 10;

(async () => {
  const zip = path.join(H.ROOT, ZIPNAME);
  if (!fs.existsSync(zip)) {
    console.log('⏭ SKIP:未找到真实测试数据 ' + ZIPNAME + '（放在仓库根即可启用本套件）');
    process.exit(0);
  }
  const h = await H.start({ port: 8189, cdpPort: 9399, view: 'kbrecall' });
  try {
    // ---------- 1) 恢复真实数据 ----------
    await h.nav('index.html?v=kbrecall');
    await h.ev(`(() => { window.confirm = () => true; return 1; })()`);
    await h.ev(`(async () => { var b = await (await fetch('/' + encodeURIComponent('${ZIPNAME}'))).blob();
      window.__bkFile = new File([b], 'x.zip', { type: 'application/zip' }); return 1; })()`, 300000);
    const restored = await h.ev(`(async () => {
      var captured = null, oc = document.createElement.bind(document);
      document.createElement = function (t) { var el = oc(t); if (String(t).toLowerCase() === 'input' && !captured) captured = el; return el; };
      try { window.oneClickRestore(); } catch (e) { document.createElement = oc; return 'err:' + e.message; }
      document.createElement = oc;
      captured.click = function () {};
      captured.onchange({ target: { files: [window.__bkFile], value: '' } });
      var mask;
      for (var i = 0; i < 800; i++) {
        mask = Array.prototype.find.call(document.querySelectorAll('.modal.active'), function (m) { return /确认恢复本机数据/.test(m.textContent || ''); });
        if (mask) break;
        await new Promise(function (r) { setTimeout(r, 250); });
      }
      if (!mask) return 'no-modal';
      mask.querySelector('[data-act="ok"]').click();
      return 'started';
    })()`, 300000);
    if (restored !== 'started') { h.F(false, '真实备份恢复启动失败：' + restored); throw new Error('restore:' + restored); }

    // 等刷新 + 数据就绪
    let ready = false;
    for (let i = 0; i < 200 && !ready; i++) {
      try { ready = (await h.ev(`(window.__issueDataReady && (window.getIssueData() || []).length > 1000) ? 1 : 0`, 15000)) === 1; } catch (e) {}
      if (!ready) await h.sleep(500);
    }
    h.F(ready, '① 真实备份已恢复且数据就绪');

    // ---------- 2) 等规章源索引建好 ----------
    const kbStat = await h.ev(`(async () => {
      if (window.KB && KB.ensure) { try { await KB.ensure('rules'); } catch (e) {} }
      for (var i = 0; i < 120; i++) {
        var st = (KB.stats ? KB.stats() : []).filter(function (r) { return r.key === 'rules'; })[0];
        if (st && st.built && st.chunks > 1000) return { chunks: st.chunks, total: st.total };
        await new Promise(function (r) { setTimeout(r, 500); });
      }
      return null;
    })()`, 180000).catch(() => null);
    h.F(!!kbStat, '② 规章源索引就绪（' + (kbStat ? kbStat.chunks + ' 块 / ' + kbStat.total + ' 篇' : '超时') + '）');

    // ---------- 3) 自动生成 ground truth（在页面里算完"重合率"，只带小数据出来）----------
    const gt = await h.ev(`(() => {
      var norm = function (s) { return String(s == null ? '' : s).replace(/[《》〈〉\\s　]/g, '').trim(); };
      var bigrams = function (s) {
        var o = {};
        s = String(s || '').replace(/[\\s，。、；：（）「」《》,.;:()【】\\[\\]"'——]/g, '');
        for (var i = 0; i + 1 < s.length; i++) o[s.slice(i, i + 2)] = 1;
        return o;
      };
      var overlap = function (q, body) {   // query 用词有多少出现在目标规章正文里
        var A = bigrams(q), B = bigrams(body), ka = Object.keys(A), hit = 0;
        ka.forEach(function (k) { if (B[k]) hit++; });
        return ka.length ? hit / ka.length : 0;
      };
      var rules = (window.getRulesData ? window.getRulesData() : []) || [];
      var issues = (window.getIssueData ? window.getIssueData() : []) || [];
      var byTitle = {}, bodyOf = {};
      rules.forEach(function (r) {
        var t = norm(r && r.title);
        if (t && t.length >= 4) {
          if (!byTitle[t]) { byTitle[t] = String(r.title || '').trim(); bodyOf[t] = String(r.content || '').replace(/<[^>]+>/g, '').slice(0, 6000); }
        }
      });
      var pairs = [], noReg = 0, noRule = 0;
      issues.forEach(function (it) {
        var reg = String((it && it.regulation) || '');
        if (!reg.trim()) { noReg++; return; }
        var titles = (reg.match(/《([^》]{3,60})》/g) || []).map(function (x) { return x.replace(/[《》]/g, ''); });
        var key = null;
        titles.forEach(function (t) { if (!key && byTitle[norm(t)]) key = norm(t); });
        if (!key) { noRule++; return; }
        pairs.push({ q: String(it.content || ''), target: byTitle[key], k: key,
                     clause: (reg.match(/第[一二三四五六七八九十百零〇\\d]+条/) || [''])[0],
                     ov: +overlap(String(it.content || ''), bodyOf[key]).toFixed(3) });
      });
      var step = Math.max(1, Math.floor(pairs.length / ${PAIRS}));
      var sample = [];
      for (var i = 0; i < pairs.length && sample.length < ${PAIRS}; i += step) sample.push(pairs[i]);
      return { total: pairs.length, sampled: sample.length, noReg: noReg, noRule: noRule,
               rulesTotal: rules.length, issuesTotal: issues.length, sample: sample };
    })()`, 180000);
    console.log('ground truth：检查信息 ' + gt.issuesTotal + ' 条 → 带引用 ' + (gt.issuesTotal - gt.noReg)
      + ' 条 → 引用的规章在本库中存在 ' + gt.total + ' 条（规章库 ' + gt.rulesTotal + ' 篇）→ 取样 ' + gt.sampled + ' 对');
    h.F(gt.sampled >= 30, '③ ground truth 样本充足（取样 ' + gt.sampled + ' 对 / 可用 ' + gt.total + ' 条真实"描述→引用规章"记录）');

    // 把小样本塞进页面（只有几十条，几 KB）
    await h.ev('window.__gtSample = ' + JSON.stringify(gt.sample) + '; 1', 60000);

    // ---------- 4) 跑召回（走生产唯一入口 acRecallCandidates = 同义词扩展 → KB 召回 → 关键词兜底）----------
    const run = MODE === 'abl' ? { n: 0, expAll: [] } : await h.ev(`(async () => {
      var out = { n: 0, err: 0, ranks: [], miss: [], hitOv: [], srcs: {}, nItems: [], exp: [] };
      var metas = window.__gtSample || [];
      for (var i = 0; i < metas.length; i++) {
        var p = metas[i], items = [], meta = null;
        try {
          var res = await window.acRecallCandidates(p.q, { skipEnsure: true });
          items = (res && res.items) || [];
          meta = { src: res && res.recallSrc, kb: res && res.kbRecallUsed, exp: res && res.expandedQuery };
        } catch (e) { out.err++; }
        // 只看规章类候选的顺序（生产链里 items 已按 案例→条款 归一化；这里过滤出 rule）
        var ruleItems = items.filter(function (x) { return x && x.source === 'rule'; });
        var rank = 0;
        for (var k = 0; k < ruleItems.length; k++) {
          var ti = String(ruleItems[k].title || '');
          if (ti && (ti.indexOf(p.target) >= 0 || p.target.indexOf(ti) >= 0)) { rank = k + 1; break; }
        }
        out.n++;
        out.ranks.push(rank);
        out.nItems.push(ruleItems.length);
        out.srcs[String(meta && meta.src || '?')] = (out.srcs[String(meta && meta.src || '?')] || 0) + 1;
        if (i < 5 && meta) out.exp.push(String(meta.exp || '').slice(0, 80));
        (out.expAll = out.expAll || []).push({ target: p.target, exp: String((meta && meta.exp) || p.q) });
        if (rank > 0) out.hitOv.push(p.ov);
        else out.miss.push({ q: p.q.slice(0, 50), target: p.target, clause: p.clause, ov: p.ov,
                             n: ruleItems.length, src: (meta && meta.src) || '?',
                             top: (ruleItems[0] ? String(ruleItems[0].title || '').slice(0, 26) : '(规章候选为空)') });
        if (i % 5 === 4) await new Promise(function (r2) { setTimeout(r2, 0); });
      }
      var at = function (k) { return out.ranks.filter(function (r3) { return r3 > 0 && r3 <= k; }).length; };
      var rr = out.ranks.reduce(function (s, r3) { return s + (r3 > 0 ? 1 / r3 : 0); }, 0);
      var avg = function (a) { return a.length ? a.reduce(function (s, x) { return s + x; }, 0) / a.length : 0; };
      return { n: out.n, err: out.err, r1: at(1), r3: at(3), r5: at(5), r10: at(10),
               mrr: rr / Math.max(1, out.n), miss: out.miss.slice(0, 10), missN: out.miss.length,
               srcs: out.srcs, avgItems: +avg(out.nItems).toFixed(1), samples: out.exp, expAll: out.expAll || [],
               hitOv: +avg(out.hitOv).toFixed(3), missOv: +avg(out.miss.map(function (m) { return m.ov; })).toFixed(3) };
    })()`, 1500000);

    const pc = (x) => (100 * x / Math.max(1, run.n)).toFixed(1) + '%';
    if (MODE !== 'abl') {
    console.log('');
    console.log('=== 对规主链路召回基线（query = 真实检查信息描述 → target = 它引用的那篇规章）===');
    console.log('口径：window.acRecallCandidates()（生产唯一入口：同义词扩展 → KB 召回 → 关键词兜底 → 引用提取）');
    console.log('样本 ' + run.n + ' 条｜异常 ' + run.err + ' 次｜平均规章候选 ' + run.avgItems + ' 条｜召回来源分布 ' + JSON.stringify(run.srcs));
    console.log('  Recall@1   ' + pc(run.r1) + '   (' + run.r1 + '/' + run.n + ')');
    console.log('  Recall@3   ' + pc(run.r3) + '   (' + run.r3 + '/' + run.n + ')');
    console.log('  Recall@5   ' + pc(run.r5) + '   (' + run.r5 + '/' + run.n + ')');
    console.log('  Recall@10  ' + pc(run.r10) + '   (' + run.r10 + '/' + run.n + ')   ← **漏检率 ' + (100 - 100 * run.r10 / Math.max(1, run.n)).toFixed(1) + '%**');
    console.log('  MRR        ' + run.mrr.toFixed(3));
    console.log('');
    console.log('命中样本平均用词重合 ' + run.hitOv + ' ｜ 漏检样本平均用词重合 ' + run.missOv
      + '（越低＝表达差异越大，越接近"只有语义索引才能补"的场景）');
    if (run.samples && run.samples.length) console.log('扩展后查询样例：' + JSON.stringify(run.samples[0]));
    console.log('漏检样例（共 ' + run.missN + ' 条）：');
    run.miss.forEach((m) => console.log('  [重合 ' + m.ov + '｜规章候选 ' + m.n + '｜来源 ' + m.src + '] 「' + m.q + '…」\n        应命中：' + m.target + ' ' + m.clause + ' ｜ 实际首条：' + m.top));

    h.F(run.err === 0 && run.n >= 30, '④ 召回评测完成（' + run.n + ' 条，异常 ' + run.err + ' 次，平均规章候选 ' + run.avgItems + ' 条）');
    h.F(true, '⑤ 基线已记录：Recall@10 = ' + pc(run.r10) + '、MRR ' + run.mrr.toFixed(3) + '、漏检率 ' + (100 - 100 * run.r10 / Math.max(1, run.n)).toFixed(1) + '%（仅记录基线，不设提升门槛）');
    }

    // 把"扩展后查询 + 目标"带进页面，供消融复用
    await h.ev('window.__expAll = ' + JSON.stringify(run.expAll || []) + '; 1', 60000);

    // ---------- 5) 归因消融：漏检里有多少是"非语义"原因（便宜可解）----------
    //   V0 topK=8（≈生产）  V1 topK=20  V2 topK=20+剔除案例/汇编类文档  V3 topK=40+剔除
    //   "案例/汇编"类文档（如《全路事故案例（2006-2025）》）满是现场描述词，天然抢占"规章"候选位，
    //   挤掉真正的办法条款 —— 这是语料/排序问题，向量也救不了，得先排除掉才能看清语义鸿沟有多大。
    const abl = await h.ev(`(async () => {
      var CASE_RE = /事故案例|案例|汇编|简报|纪要|通报|分析报告/;
      // abl 模式没有生产循环产出的"扩展后查询" → 回退到 GT 样本（用原始 query 做同一套对比）
      var metas = (window.__expAll && window.__expAll.length)
        ? window.__expAll
        : (window.__gtSample || []).map(function (p) { return { q: p.q, target: p.target }; });
      var TOP = 40;
      // hitsOf：注意 KB.search 返回的行字段是 **key**（不是 source）
      var hitsOf = function (q) {
        try {
          var r = window.KB.search(q, { sources: ['rules'], topK: TOP });
          var row = (r || []).filter(function (x) { return x && x.key === 'rules'; })[0];
          return (row && row.hits) || [];
        } catch (e) { return []; }
      };
      var rankIn = function (hits, target) {
        for (var k = 0; k < hits.length; k++) if (String(hits[k].path || '').indexOf(target) >= 0) return k + 1;
        return 0;
      };
      var mk = function (arr) {
        var at = function (k) { return arr.filter(function (x) { return x > 0 && x <= k; }).length; };
        var rr2 = arr.reduce(function (s, x) { return s + (x > 0 ? 1 / x : 0); }, 0);
        return { r1: at(1), r5: at(5), r10: at(10), r20: at(20), mrr: +(rr2 / Math.max(1, arr.length)).toFixed(3) };
      };
      var raw = { w8: [], w20: [], noCase20: [], noCase40: [] };
      var exp = { w8: [], w20: [], noCase20: [], noCase40: [] };
      var pool = [], caseTop1 = 0, caseAny = 0, n = 0, empty = 0;
      for (var i = 0; i < metas.length; i++) {
        var p = metas[i];
        if (!p || !p.target) continue;
        var wideRaw = hitsOf(p.q);                                          // 原始 query（现场描述原文）
        var wideExp = (p.exp && p.exp !== p.q) ? hitsOf(p.exp) : wideRaw;   // 同义词扩展后的 query（abl 模式无扩展 → 复用，省一半检索）
        if (!wideRaw.length && !wideExp.length) empty++;
        var rawNC = wideRaw.filter(function (h) { return !CASE_RE.test(String(h.path || '')); });
        var expNC = wideExp.filter(function (h) { return !CASE_RE.test(String(h.path || '')); });
        n++;
        raw.w8.push(rankIn(wideRaw.slice(0, 8), p.target));
        raw.w20.push(rankIn(wideRaw.slice(0, 20), p.target));
        raw.noCase20.push(rankIn(rawNC.slice(0, 20), p.target));
        raw.noCase40.push(rankIn(rawNC, p.target));
        exp.w8.push(rankIn(wideExp.slice(0, 8), p.target));
        exp.w20.push(rankIn(wideExp.slice(0, 20), p.target));
        exp.noCase20.push(rankIn(expNC.slice(0, 20), p.target));
        exp.noCase40.push(rankIn(expNC, p.target));
        pool.push(wideExp.length);
        if (wideExp[0] && CASE_RE.test(String(wideExp[0].path || ''))) caseTop1++;
        if (wideExp.slice(0, 5).some(function (h) { return CASE_RE.test(String(h.path || '')); })) caseAny++;
        if (i % 3 === 2) await new Promise(function (r2) { setTimeout(r2, 0); });
      }
      return { n: n, empty: empty, caseTop1: caseTop1, caseAny: caseAny,
               pool: +(pool.reduce(function (s, x) { return s + x; }, 0) / Math.max(1, pool.length)).toFixed(1),
               raw: { w8: mk(raw.w8), w20: mk(raw.w20), nc20: mk(raw.noCase20), nc40: mk(raw.noCase40) },
               exp: { w8: mk(exp.w8), w20: mk(exp.w20), nc20: mk(exp.noCase20), nc40: mk(exp.noCase40) } };
    })()`, 1200000);

    const pf = (x) => (100 * x / Math.max(1, abl.n)).toFixed(1) + '%';
    const line = (tag, v) => '  ' + tag.padEnd(30) + 'Recall@1 ' + pf(v.r1) + '｜@5 ' + pf(v.r5) + '｜@10 ' + pf(v.r10) + '｜@20 ' + pf(v.r20) + '｜MRR ' + v.mrr;
    console.log('');
    console.log('=== 归因消融（同 ' + abl.n + ' 条样本；只变"查询词 / 取多少候选 / 是否剔除案例汇编类干扰"）===');
    console.log('  平均可用规章块 ' + abl.pool + ' 条｜规章候选完全为空的样本 ' + abl.empty + '/' + abl.n);
    console.log('  「案例/汇编类」文档抢占第 1 位 ' + abl.caseTop1 + '/' + abl.n + '，进前 5 的 ' + abl.caseAny + '/' + abl.n);
    console.log('  ── 原始 query（现场描述原文）──');
    console.log(line('topK=8（≈生产）', abl.raw.w8));
    console.log(line('topK=20', abl.raw.w20));
    console.log(line('topK=20 + 剔除案例汇编', abl.raw.nc20));
    console.log(line('topK=40 + 剔除案例汇编', abl.raw.nc40));
    console.log('  ── 同义词扩展后的 query ──');
    console.log(line('topK=8（≈生产）', abl.exp.w8));
    console.log(line('topK=20', abl.exp.w20));
    console.log(line('topK=20 + 剔除案例汇编', abl.exp.nc20));
    console.log(line('topK=40 + 剔除案例汇编', abl.exp.nc40));

    const gain = (a, b) => ((b - a) / Math.max(1, abl.n) * 100).toFixed(1);
    console.log('');
    console.log('  ⇒ 同义词扩展本身：' + (abl.exp.w8.r10 >= abl.raw.w8.r10 ? '+' : '') + gain(abl.raw.w8.r10, abl.exp.w8.r10) + 'pp');
    console.log('  ⇒ 放大候选（8→20）：' + (abl.exp.w20.r10 >= abl.exp.w8.r10 ? '+' : '') + gain(abl.exp.w8.r10, abl.exp.w20.r10) + 'pp');
    console.log('  ⇒ 剔除案例汇编干扰：' + (abl.exp.nc20.r10 >= abl.exp.w20.r10 ? '+' : '') + gain(abl.exp.w20.r10, abl.exp.nc20.r10) + 'pp');
    console.log('  ⇒ 前两项用完仍有漏检 ' + (100 - 100 * abl.exp.nc20.r10 / Math.max(1, abl.n)).toFixed(1)
      + '% ← **这才是"语义索引/向量"能争的空间**（且其中还含"目标篇本身不适合作答"的噪声）');

    h.F(abl.n >= 30, '⑥ 归因消融完成（' + abl.n + ' 条：查询词/候选数/干扰源三个变量）');
    h.F(true, '⑦ 语义空间已量化：非语义手段把 Recall@10 从 ' + pf(abl.exp.w8.r10) + ' 提到 ' + pf(abl.exp.nc20.r10)
      + '，剩余漏检 ' + (100 - 100 * abl.exp.nc20.r10 / Math.max(1, abl.n)).toFixed(1) + '%');
  } catch (e) {
    h.F(false, '套件异常：' + (e && e.message));
  }
  h.done();
  process.exit(0);
})();
