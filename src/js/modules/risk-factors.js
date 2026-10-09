/**
 * 重点时段因子库 + 研判数据源面板（2026-10-09 用户要求）
 * ============================================================
 * 背景（实测结论）：智能风险研判只引用 检查信息/检查手册/事故案例/规章条款 4 源；
 *   **天气**（代码层 0 处）与**重点时段**（春运/暑运/汛期/节假日…）完全缺失 ——
 *   用户不在"研判重点"里手写"节日/汛期"，研判就完全不会考虑它们。
 * 而铁路安全的时段因子是**可直接按日期推算**的（零数据依赖、零成本），属于性价比最高的一环。
 *
 * 本文件提供两件事：
 *   ① `window.RiskFactors.match(start,end)` —— 命中"研判期内"与"未来 30 天内即将进入"的重点时段因子；
 *   ② `window.RiskPanel.render()` —— 研判条件区的「数据源面板」：6 类源可勾选 + 显示各源命中数 +
 *      时段因子提示行 + 天气站名输入（把原来的"黑箱注入"变成可见可控）。
 * ⚠️ 勾选状态存 localStorage `risk_src_off`；天气站名存 `risk_weather_station`。
 *   风险研判侧读取这两项（见 doubao.js 的 runRiskAnalysis）。
 */
(function () {
  'use strict';

  // ---------- ① 时段因子库（月/日区间；跨年用 from > to 表示） ----------
  //   level：对研判的影响权重提示；note：写给模型的"为什么这和铁路安全有关"（避免只报个名字）
  var FACTORS = [
    { key: 'chunyun',  label: '春运',   from: [1, 20],  to: [3, 5],   level: '高', note: '旅客运输高峰、设备高负荷、抢修时间窗口受限；春运期间设备故障影响面大' },
    { key: 'lianghui', label: '全国两会', from: [3, 1],  to: [3, 15],  level: '高', note: '安全生产与治安要求提升，重点区段设备与作业标准须从严卡控' },
    { key: 'xunqi',    label: '汛期（防洪）', from: [6, 1], to: [9, 30], level: '高', note: '强降雨易致接触网支柱基础冲刷、杆塔倾斜、路基塌陷、变配电所进水，防洪巡查与料具是关键' },
    { key: 'shuyun',   label: '暑运',   from: [7, 1],  to: [8, 31],  level: '高', note: '高温+客流高峰叠加，设备过热与作业人员中暑风险上升' },
    { key: 'gaowen',   label: '高温期', from: [6, 15], to: [8, 31],  level: '中', note: '接触网线索驰度变化、导线接头过热，作业需避开高温时段' },
    { key: 'hanchao',  label: '防寒期', from: [11, 15], to: [3, 15], level: '中', note: '低温易致线索收缩断线、绝缘子覆冰闪络、设备卡滞，防寒与除冰作业风险高' },
    { key: 'shigong',  label: '施工旺季', from: [4, 1], to: [6, 30],  level: '中', note: '天窗集中、施工配合多，作业交叉与防护缺失风险显著上升（每年 4~6 月为高峰，9~10 月次之）' },
    { key: 'shigong2', label: '施工旺季（秋季）', from: [9, 1], to: [10, 31], level: '中', note: '秋季天窗集中，施工配合与临近带电作业增多' },
    { key: 'yuandan',  label: '元旦假期', from: [1, 1],  to: [1, 3],   level: '中', note: '节假日客流上升，值班值守与应急抢修力量需保障' },
    { key: 'qingming', label: '清明假期', from: [4, 3],  to: [4, 6],   level: '中', note: '祭扫用火+客流上升，需关注沿线环境与火灾隐患' },
    { key: 'wuyi',     label: '劳动节假期', from: [5, 1], to: [5, 5],  level: '中', note: '客流上升、临时施工多，作业计划与防护需从严' },
    { key: 'duanwu',   label: '端午假期', from: [5, 28], to: [6, 5],   level: '中', note: '强对流天气多发+客流上升' },
    { key: 'zhongqiu', label: '中秋假期', from: [9, 10], to: [9, 22],  level: '中', note: '客流上升，秋汛与大风风险叠加' },
    { key: 'guoqing',  label: '国庆假期', from: [10, 1], to: [10, 7],  level: '高', note: '7 天长假客流高峰，安全保障与应急值守压力最大' }
  ];

  /** 把因子区间在候选年份展开成**绝对日期区间**（跨年如 11/15→3/15 自动跨到下一年） */
  function absRange(f, year) {
    var a = new Date(year, f.from[0] - 1, f.from[1]);
    var b0 = new Date(year, f.to[0] - 1, f.to[1]);
    var b = (b0 < a) ? new Date(year + 1, f.to[0] - 1, f.to[1]) : b0;
    return [a, b];
  }
  /** 与研判期 [s,e] 是否有交集
   *  ⚠️ 第一版用"月日数值大小"比较 ⇒ **跨年区间必错**（12 月与 1 月之间无法用数值比较）：
   *     实测 12/20~1/10 判不出"防寒期（11/15~3/15）"，只返回了春运。
   *     现改为**绝对日期**比较（按年份展开候选区间），跨年因子才准。 */
  function overlaps(f, s, e) {
    for (var y = s.getFullYear() - 1; y <= e.getFullYear() + 1; y++) {
      var r = absRange(f, y);
      if (r[0] <= e && r[1] >= s) return true;
    }
    return false;
  }
  /** 未来 within 天内是否进入该因子（同样用绝对日期，跨年因子才准） */
  function upcoming(f, e, within) {
    var limit = new Date(e.getFullYear(), e.getMonth(), e.getDate() + (within || 30));
    for (var y = e.getFullYear(); y <= limit.getFullYear() + 1; y++) {
      var a = absRange(f, y)[0];
      if (a > e && a <= limit) return true;
    }
    return false;
  }

  window.RiskFactors = {
    all: FACTORS,
    /** @returns [{key,label,level,note,inPeriod,upcomingOff}] */
    match: function (startStr, endStr) {
      var now = new Date();
      var s = startStr ? new Date(String(startStr) + 'T00:00:00') : new Date(now.getTime() - 30 * 86400000);
      var e = endStr ? new Date(String(endStr) + 'T00:00:00') : now;
      if (isNaN(s.getTime())) s = new Date(now.getTime() - 30 * 86400000);
      if (isNaN(e.getTime())) e = now;
      var out = [];
      FACTORS.forEach(function (f) {
        var inP = overlaps(f, s, e);
        var up = !inP && upcoming(f, e, 30);
        if (inP || up) out.push({ key: f.key, label: f.label, level: f.level, note: f.note, inPeriod: inP, upcoming: up });
      });
      // 高影响优先、期内优先
      out.sort(function (a, b) {
        var w = function (x) { return (x.inPeriod ? 2 : 0) + (x.level === '高' ? 1 : 0); };
        return w(b) - w(a);
      });
      return out;
    },
    /** 供提示词用的纯文本（研判期内 / 即将进入 分开写） */
    toText: function (startStr, endStr) {
      var list = this.match(startStr, endStr);
      if (!list.length) return '（研判期内无明显重点时段因子）';
      var inP = list.filter(function (x) { return x.inPeriod; });
      var up = list.filter(function (x) { return x.upcoming; });
      var out = [];
      if (inP.length) {
        out.push('研判期内命中重点时段：' + inP.map(function (x) { return x.label + '（影响：' + x.level + '）'; }).join('、'));
        inP.forEach(function (x) { out.push('  · ' + x.label + '：' + x.note); });
      }
      if (up.length) {
        out.push('未来 30 天内即将进入：' + up.map(function (x) { return x.label; }).join('、')
          + '（研判中应作为"前瞻风险"提示，并给出进入前的准备措施）');
      }
      return out.join('\n');
    }
  };

  // ---------- ② 研判数据源面板 ----------
  var SRC = [
    { key: 'issues',   label: '检查信息台账' },
    { key: 'handbook', label: '检查手册' },
    { key: 'cases',    label: '事故案例' },
    { key: 'rules',    label: '规章条款' },
    { key: 'weather',  label: '天气' },
    { key: 'period',   label: '重点时段因子' }
  ];
  function offList() {
    var a = [];
    try { a = JSON.parse(localStorage.getItem('risk_src_off') || '[]') || []; } catch (e) { a = []; }
    return a;
  }
  function setOff(a) { try { localStorage.setItem('risk_src_off', JSON.stringify(a)); } catch (e) {} }

  /** 各源命中情况（本地即时估算，不打网络） */
  function probe() {
    var o = {};
    try { o.issues = (typeof window.getIssueData === 'function') ? (window.getIssueData() || []).length : 0; } catch (e) { o.issues = 0; }
    try { o.handbook = (typeof window.getHandbookData === 'function') ? (window.getHandbookData() || []).length : 0; } catch (e) { o.handbook = 0; }
    try { o.cases = (typeof window.getAccidentData === 'function') ? (window.getAccidentData() || []).length : 0; } catch (e) { o.cases = 0; }
    try { o.rules = (typeof window.getRulesData === 'function') ? (window.getRulesData() || []).length : 0; } catch (e) { o.rules = 0; }
    var st = '';
    try { var el = document.getElementById('risk-weather-station'); st = el ? String(el.value || '') : ''; } catch (e) {}
    o.weather = st ? '待查询：' + st : '未设站名（不接入）';
    o.period = '按研判日期自动匹配';
    return o;
  }

  window.RiskPanel = {
    probe: probe,
    offList: offList,
    render: function () {
      var host = document.getElementById('risk-source-list');
      if (!host) return;
      var off = offList(), p = probe();
      var html = '';
      SRC.forEach(function (s) {
        var on = off.indexOf(s.key) === -1;
        var hit = p[s.key];
        var hitTxt = (typeof hit === 'number') ? (hit + ' 条') : String(hit || '');
        html += '<label style="display:inline-flex;align-items:center;gap:4px;cursor:pointer;padding:3px 8px;'
          + 'border-radius:12px;border:1px solid ' + (on ? '#93c5fd' : '#e2e8f0') + ';background:' + (on ? '#eff6ff' : '#f8fafc') + ';">'
          + '<input type="checkbox" data-risk-src="' + s.key + '"' + (on ? ' checked' : '') + ' style="margin:0;">'
          + '<span style="color:' + (on ? '#1e40af' : '#94a3b8') + ';">' + s.label + '</span>'
          + '<span style="color:#94a3b8;font-size:0.68rem;">' + hitTxt + '</span></label>';
      });
      html += '<label style="display:inline-flex;align-items:center;gap:4px;padding:3px 8px;border-radius:12px;border:1px dashed #cbd5e1;">'
        + '<span style="color:#64748b;">天气站名</span>'
        + '<input id="risk-weather-station" type="text" placeholder="如：金昌" style="width:76px;padding:2px 4px;border:1px solid #cbd5e1;border-radius:6px;font-size:0.7rem;">'
        + '</label>';
      host.innerHTML = html;
      // 站名回填 + 事件
      try {
        var st = localStorage.getItem('risk_weather_station') || '';
        var el = document.getElementById('risk-weather-station');
        if (el && st) el.value = st;
        if (el) el.addEventListener('change', function () { try { localStorage.setItem('risk_weather_station', String(el.value || '').trim()); } catch (e) {} });
      } catch (e) {}
      host.querySelectorAll('input[data-risk-src]').forEach(function (cb) {
        cb.addEventListener('change', function () {
          var k = cb.getAttribute('data-risk-src'), cur = offList(), i = cur.indexOf(k);
          if (cb.checked) { if (i !== -1) cur.splice(i, 1); } else { if (i === -1) cur.push(k); }
          setOff(cur);
          window.RiskPanel.render();
        });
      });
      // 重点时段因子提示行（按当前条件即时算，用户改日期即可看到变化）
      var line = document.getElementById('risk-factor-line');
      if (line) {
        var ds = (document.getElementById('risk-date-start') || {}).value || '';
        var de = (document.getElementById('risk-date-end') || {}).value || '';
        var list = window.RiskFactors.match(ds, de);
        line.innerHTML = list.length
          ? '⏱ 重点时段：' + list.map(function (x) {
              return '<b>' + x.label + '</b>' + (x.inPeriod ? '（期内）' : '（未来30天进入）');
            }).join(' · ')
          : '⏱ 重点时段：研判期内没有命中内置因子（元旦/春运/两会/清明/五一/汛期/暑运/中秋/国庆/防寒/施工旺季）';
      }
      // 条件变化（日期/单位/重点）时即时刷新：因子行与各源命中数跟着变（避免"改了日期提示不更新"）
      ['risk-date-start', 'risk-date-end', 'risk-unit', 'risk-focus'].forEach(function (id) {
        var el = document.getElementById(id);
        if (el && !el.__riskBound) {
          el.__riskBound = true;
          ['change', 'input'].forEach(function (ev) {
            el.addEventListener(ev, function () { try { window.RiskPanel.render(); } catch (e) {} });
          });
        }
      });
    }
  };

  // 面板可用时渲染一次；切到风险视图时由 doubao.js 再触发
  try {
    if (document.readyState === 'complete' || document.readyState === 'interactive') setTimeout(function () { try { window.RiskPanel.render(); } catch (e) {} }, 500);
    else document.addEventListener('DOMContentLoaded', function () { setTimeout(function () { try { window.RiskPanel.render(); } catch (e) {} }, 500); });
  } catch (e) {}
})();
