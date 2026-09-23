/**
 * 对话/写作 用户反馈修复审计 —— 常驻套件（2026-09-23）
 * =====================================================
 * 对应四条用户反馈：
 *   ① 智能对话「本地」附件按钮点了没反应、时好时坏；
 *   ② 智能对话里只要出现「风险」二字就跳去智能风险研判；
 *   ③ 设置面板数据项过多，有些该合并（写作模板 → 写作资料；诊断数据 → 知识库运维区）；
 *   ④ 智能写作里模板/资料"用不用"的逻辑乱 —— 不使用时要看得到提示与要求，
 *      并明确"问题分类以资料为准，模板只给骨架与写法"。
 *
 * 用法：node scripts/chat-fixes-audit.js
 */
'use strict';
const H = require('./audit-harness');

async function sendAndReadSub(h, text) {
  // 用字符串拼接构造页面表达式（避免模板字面量在传输链上被转义）
  const expr =
    '(async () => {' +
    'if (typeof window.switchTab === "function") { window.switchTab("doubao"); }' +
    'if (typeof window.dsSwitchSub === "function") { window.dsSwitchSub("chat"); }' +
    'await new Promise(function (r) { setTimeout(r, 400); });' +
    'window.fetch = function () { return Promise.resolve({ ok: true, json: function () { return Promise.resolve({ choices: [{ message: { content: "mock" } }] }); } }); };' +
    'var inp = document.getElementById("ds-user-input");' +
    'inp.value = ' + JSON.stringify(text) + ';' +
    'try { window.dsSendMsg(); } catch (e) { return { err: e.message }; }' +
    'await new Promise(function (r) { setTimeout(r, 900); });' +
    'var chat = document.getElementById("ds-sub-chat");' +
    'var risk = document.getElementById("ds-sub-risk");' +
    'var focus = document.getElementById("risk-focus");' +
    'return { chatShown: !!(chat && chat.style.display !== "none"),' +
    '  riskShown: !!(risk && risk.style.display !== "none"),' +
    '  riskFocus: (focus && focus.value) || "" };' +
    '})()';
  return await h.ev(expr, 60000);
}

(async () => {
  const h = await H.start({ port: 8191, cdpPort: 9391, view: 'chatfix' });
  try {
    await h.nav('index.html?v=chatfix');
    // 给个假 Key，让聊天路由（而非"未配置 Key"的早退）先跑起来；
    // ⚠️ 写完必须**重载页面**：模块在加载时把 Key 读进闭包变量，之后再写 localStorage 不生效
    //   （否则 dsSendMsg 会在意图识别之前就 return，断言会"假通过"）
    await h.ev(`(() => { try { localStorage.setItem('ds_api_key_v1', 'test-key-for-audit'); } catch (e) {} return 1; })()`, 20000);
    await h.nav('index.html?v=chatfix2');

    // ---------- ① 附件按钮 ----------
    const attach = await h.ev(`(() => {
      var el = document.getElementById('ds-attach-file');
      if (!el) return { err: 'no-input' };
      var cs = getComputedStyle(el);
      return { display: cs.display, opacity: cs.opacity, inDom: !!el.parentNode, onchange: typeof window.dsHandleAttach === 'function' };
    })()`, 30000);
    h.F(attach.display !== 'none' && attach.inDom && attach.onchange,
      '① 附件输入不再是 display:none（现为 ' + attach.display + '/opacity ' + attach.opacity + ' —— iOS 等端才能稳定唤起选择器）');

    const attachFlow = await h.ev(`(async () => {
      var inp = document.getElementById('ds-attach-file');
      var mk = function () { var dt = new DataTransfer(); dt.items.add(new File(['附件测试内容'], 't.txt', { type: 'text/plain' })); return dt.files; };
      inp.files = mk();
      window.dsHandleAttach(inp);
      // 立刻读：应已复位 + 有"正在解析"占位
      var early = { inputValue: inp.value, preview: (document.getElementById('ds-attach-preview') || {}).textContent || '' };
      await new Promise(r => setTimeout(r, 1500));
      var later = { n: (window._dsAttachments || []).length, preview: (document.getElementById('ds-attach-preview') || {}).textContent || '' };
      // 再选同一个文件（input 已复位 → 仍能触发；DataTransfer 不能复用，必须新建）
      inp.files = mk();
      window.dsHandleAttach(inp);
      await new Promise(r => setTimeout(r, 1500));
      return { early: early, later: later, n2: (window._dsAttachments || []).length };
    })()`, 60000);
    h.F(attachFlow.early.inputValue === '', '② 选完立刻复位 input.value（再次选同一文件也能触发，不再"点了没反应"）');
    h.F(/正在解析附件/.test(attachFlow.early.preview), '③ 解析期立刻给出"⏳ 正在解析附件"反馈（此前界面毫无变化）');
    h.F(attachFlow.later.n === 1 && attachFlow.n2 === 2, '④ 附件解析成功并入列（1 → ' + attachFlow.n2 + '）');

    // ---------- ② 风险误跳 ----------
    const plain = await sendAndReadSub(h, '这个风险点怎么整改？');
    h.F(plain.chatShown && !plain.riskShown, '⑤ 含"风险"的**普通提问**不再被抢走（仍留在对话：chat=' + plain.chatShown + ' risk=' + plain.riskShown + '）');
    const plain2 = await sendAndReadSub(h, '安全风险有哪些');
    h.F(plain2.chatShown && !plain2.riskShown, '⑥ "安全风险有哪些"同样留在对话');
    const asked = await sendAndReadSub(h, '生成风险分析报告');
    h.F(asked.riskShown, '⑦ 明确要求"生成风险分析报告"时才跳到风险研判（risk=' + asked.riskShown + '，输入框带上原话="' + String(asked.riskFocus || '').slice(0, 20) + '"）');
    const borderline = await sendAndReadSub(h, '请分析这份风险清单里的问题');
    h.F(borderline.chatShown && !borderline.riskShown, '⑦b 边界句"请分析这份风险清单里的问题"仍留在对话（不在话尾的"风险+清单"不触发跳转）');

    // ---------- ③ 设置面板合并 ----------
    // 先切到设置面板让 DOM 就绪
    await h.ev(`(() => { if (typeof window.toggleSettingsPanel === 'function' && !document.querySelector('#panel-settings.active')) window.toggleSettingsPanel(); return 1; })()`, 30000);
    await h.sleep(700);
    const settings = await h.ev(`(() => {
      var txt = document.body.innerText || '';
      var hasTplRow = /🧩\\s*写作模板/.test(txt);
      var hasDiagRow = /🧪\\s*诊断数据/.test(txt);
      var tplBtn = Array.prototype.some.call(document.querySelectorAll('button'), function (b) { return (b.getAttribute('onclick') || '').indexOf('wrImportTemplates()') !== -1; });
      var diagBtn = Array.prototype.some.call(document.querySelectorAll('button'), function (b) { return (b.getAttribute('onclick') || '').indexOf('exportErrorLog()') !== -1; });
      var kbBox = document.querySelector('[data-fold-key="kb"]');
      return { hasTplRow: hasTplRow, hasDiagRow: hasDiagRow, tplBtn: tplBtn, diagBtn: diagBtn,
               diagInKb: !!(kbBox && kbBox.innerText.indexOf('诊断') !== -1) };
    })()`, 30000);
    h.F(!settings.hasTplRow && settings.tplBtn, '⑧ 「🧩 写作模板」独立行已并入写作资料行（模板导入按钮仍在）');
    h.F(!settings.hasDiagRow && settings.diagBtn && settings.diagInKb, '⑨ 「🧪 诊断数据」独立行已并入🧠知识库运维区');

    // ---------- ④ 写作弹窗提示 ----------
    const hint = await h.ev(`(async () => {
      var q = document.getElementById('wr-query-input');
      if (!q) return { err: 'no-query-input' };
      q.value = '写一份 9 月安全检查情况通报';
      window._wrStepTplSel = null;
      window._wrSelectedMaterialIds = [];
      window._wrUploadedFiles = [];
      window.wrWrite();                       // 打开"选择模板和参考资料"弹窗
      await new Promise(r => setTimeout(r, 500));
      var read = function () { return ((document.getElementById('wr-step-hint') || {}).textContent || '').trim(); };
      var none = read();
      // 选模板（不选资料）
      window._wrStepTplSel = { src: 'lib', id: 'audit-tpl', title: '检查情况通报模板' };
      window.wrStepRenderChips();
      var tplOnly = read();
      // 再加资料（两步开关默认开）
      window._wrSelectedMaterialIds = ['audit-mat'];
      window.wrStepRenderChips();
      var both = read();
      // 关掉两步开关
      window.wrSetTwoStep(false);
      var single = read();
      window.wrSetTwoStep(true);
      // 只资料、不模板
      window._wrStepTplSel = null;
      window.wrStepRenderChips();
      var matOnly = read();
      var _m = document.querySelector('.wr-step-modal');
      if (_m) _m.remove();
      return { none: none, tplOnly: tplOnly, both: both, single: single, matOnly: matOnly };
    })()`, 60000);
    if (hint.err) throw new Error(hint.err);
    h.F(/未使用模板、也未选资料/.test(hint.none) && /写作需求/.test(hint.none),
      '⑩ 不选模板也不选资料 → 明确提示会怎么生成并显示本次写作需求');
    h.F(/有模板、无资料/.test(hint.tplOnly), '⑪ 只选模板 → 提示"按模板骨架逐节成文、事实来自台账统计"');
    h.F(/两步生成/.test(hint.both) && /问题分类以资料为准，模板只给骨架与写法/.test(hint.both),
      '⑫ 模板+资料（两步开）→ 提示"先按资料归纳问题类型并归入模板骨架章节 → 再按章节成文；问题分类以资料为准，模板只给骨架与写法"');
    h.F(/单步生成/.test(hint.single), '⑬ 关掉两步开关 → 提示切换为单步生成');
    h.F(/未使用模板/.test(hint.matOnly) && /资料归纳/.test(hint.matOnly), '⑭ 只选资料、不选模板 → 提示"按规范结构成文、问题类型以资料归纳为准"');
    h.F(/长度说明/.test(hint.both) && /截取/.test(hint.both), '⑮ 选资料时给出**长度预算说明**（用户问过"前面内容过长会不会截断"）');

    // ---------- ⑤ 归类表：只给代表性资料 + 只归纳典型事例 ----------
    const plan = await h.ev(`(function () {
      if (typeof window.wrBuildPlanPrompt !== 'function') return { err: 'not-exposed' };
      var mats = [];
      for (var i = 1; i <= 25; i++) mats.push({ matType: 'inspect', title: '资料' + i, content: ('内容' + i + '。').repeat(400) });
      var r = window.wrBuildPlanPrompt('写一份月度通报', [{ level: 1, label: '一、总体情况' }, { level: 1, label: '二、主要问题' }], mats, { total: 0 }, {});
      var p = r.userPrompt || '';
      var nMat = (p.match(/资料\\d+【/g) || []).length;
      return { nMat: nMat, hasTypical: /只归纳典型事例/.test(r.sysPrompt || ''), hasPointsCap: /points 最多 5 条/.test(r.sysPrompt || ''), len: p.length };
    })()`, 40000);
    h.F(!plan.err && plan.nMat <= 10, '⑯ 归类表只喂**代表性资料**（25 份输入 → ' + plan.nMat + ' 份；此前是 25 份全塞）');
    h.F(plan.hasTypical && plan.hasPointsCap, '⑰ 归类要求已改为"只归纳典型事例、相似事例合并成要点、每条 ≤40 字"');

    // ---------- ⑥ 折叠屏开合：不得整页重载/连远程 ----------
    await h.ev(`(() => {
      window.__boot = Date.now(); window.__net = [];
      var of = window.fetch;
      window.fetch = function () { try { window.__net.push(String((arguments[0] && arguments[0].url) || arguments[0]).slice(0, 60)); } catch (e) {} return of.apply(this, arguments); };
      window.__res0 = performance.getEntriesByType('resource').length;
      return 1;
    })()`, 20000);
    await h.cdp.send('Emulation.setDeviceMetricsOverride', { width: 380, height: 760, deviceScaleFactor: 2, mobile: true }, h.sessionId);
    await h.sleep(800);
    await h.cdp.send('Emulation.setDeviceMetricsOverride', { width: 900, height: 1380, deviceScaleFactor: 2, mobile: true, screenOrientation: { type: 'landscapePrimary', angle: 90 } }, h.sessionId);
    await h.sleep(1200);
    await h.cdp.send('Emulation.clearDeviceMetricsOverride', {}, h.sessionId);
    await h.sleep(700);
    const fold = await h.ev(`(() => ({
      sameDoc: !!window.__boot,
      res0: window.__res0, resNow: performance.getEntriesByType('resource').length,
      net: (window.__net || []).filter(function (u) { return !/^data:/.test(u); }).length
    }))()`, 30000);
    h.F(fold.sameDoc && fold.resNow === fold.res0 && fold.net === 0,
      '⑱ 折叠/展开不触发整页重载与远程请求（同一文档=' + fold.sameDoc + '，资源 ' + fold.res0 + '→' + fold.resNow + '，fetch ' + fold.net + ' 次）');

    // ⚠️ 不能用 fetch 读 sw.js：上面为了测风险路由已经把 window.fetch 打成 stub 了（自伤过一次）
    const swTxt = await h.ev(`(function () {
      return new Promise(function (resolve) {
        var x = new XMLHttpRequest();
        x.open('GET', 'sw.js', true);
        x.onload = function () {
          var t = x.responseText || '';
          resolve({ navIgnoreSearch: (t.match(/ignoreSearch: true/g) || []).length,
                    navCacheFirst: /离线优先\\(CacheFirst\\)/.test(t) });
        };
        x.onerror = function () { resolve({ err: 'xhr-fail' }); };
        x.send();
      });
    })()`, 30000);
    h.F(swTxt.navIgnoreSearch >= 3 && swTxt.navCacheFirst,
      '⑲ sw.js 导航缓存忽略查询串（ignoreSearch × ' + swTxt.navIgnoreSearch + '）→ 带参数入口也能吃缓存、不再连远程');
  } catch (e) {
    h.F(false, '套件异常：' + (e && e.message));
  }
  h.done();
  process.exit(0);
})();
