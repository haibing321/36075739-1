/**
 * Agent Core（智能体核心）——规划器 + 工具注册（DeepSeek 官方 function-calling）
 * 只暴露 window._agentRun(userMessage) 一个入口
 */
(function() {
  // ========== 工具注册表（标准 OpenAI/DeepSeek tools 格式）==========
  var TOOLS = [
    {
      name: 'search_issues',
      description: '搜索检查信息数据库，按关键词模糊查找问题记录（支持单位/类别/日期/性质筛选）。返回精简列表(id=全量数据中的下标+性质+时间+单位+摘要)，需要全文请用 get_issue_detail(id)',
      parameters: {
        type: 'object',
        properties: {
          keyword: { type: 'string', description: '搜索关键词，可多词用空格分隔' },
          unit: { type: 'string', description: '责任单位筛选(可选)' },
          category: { type: 'string', description: '类别筛选，如 消防安全/规章制度/设备管理等(可选)' },
          dateFrom: { type: 'string', description: '起始日期 YYYY-MM-DD(可选)' },
          dateTo: { type: 'string', description: '截止日期 YYYY-MM-DD(可选)' },
          nature: { type: 'string', description: '问题性质筛选：A类/B类/C类/红线/空白(可选)' },
          limit: { type: 'integer', description: '返回条数上限，默认30' }
        },
        required: ['keyword']
      },
      handler: async function(args) {
        var all = window._agentGetIssues(args.keyword || '', args.unit || '', args.category || '', args.limit || 30, args.dateFrom || '', args.dateTo || '', args.nature || '');
        var full = [];
        try { if (typeof window.getIssueData === 'function') full = window.getIssueData(); } catch(e) {}
        return { total: all.length, items: all.map(function(i) {
          var realIdx = full.indexOf(i);
          return { id: (realIdx >= 0 ? realIdx : -1), 性质: i['性质']||'', 时间: i.datetime||'', 类别: i.category||'', 单位: i.unit||'', 摘要: (i.content||'').slice(0,120) };
        })};
      }
    },
    {
      name: 'get_issue_detail',
      description: '根据 search_issues 返回的 id 获取单条检查信息完整内容(含问题描述全文、规章依据)。id 已经是全量数据中的真实下标，可直接索引',
      parameters: { type:'object', properties:{ id:{type:'integer',description:'search_issues 返回的 id(全量下标)'} }, required:['id'] },
      handler: async function(args) {
        var r = window._agentGetIssueDetail(args.id);
        return r ? { 性质:r['性质']||'', 时间:r.datetime||'', 类别:r.category||'', 单位:r.unit||'', 问题描述:r.content||'', 规章依据:r.regulation||'' } : { error:'未找到 id=' + args.id };
      }
    },
    {
      name: 'search_rules',
      description: '搜索规章制度数据库，按关键词查找规章条款。keyword 可选(不传则返回最近条目)。返回精简列表(id=全量下标+标题+专业+摘要)，需要全文请用 get_rule_detail(id)',
      parameters: { type:'object', properties:{ keyword:{type:'string',description:'搜索关键词(可选，不传返回最近条目)'}, limit:{type:'integer',description:'返回条数上限，默认10'} }, required:[] },
      handler: async function(args) {
        var results = window._agentGetRules(args.keyword || '', args.limit || 10);
        var full = [];
        try { if (typeof window.getRulesData === 'function') full = window.getRulesData(); } catch(e) {}
        return { total: results.length, items: results.map(function(r) {
          var realIdx = full.indexOf(r);
          return { id: (realIdx >= 0 ? realIdx : -1), 标题: r.title||'', 专业: r.trade||'', 摘要: (r.content||'').replace(/<[^>]+>/g,'').slice(0,150) };
        })};
      }
    },
    {
      name: 'get_rule_detail',
      description: '根据 search_rules 返回的 id(全量下标) 获取单条规章完整条款内容',
      parameters: { type:'object', properties:{ id:{type:'integer',description:'search_rules 返回的 id(全量下标)'} }, required:['id'] },
      handler: async function(args) {
        var r = window._agentGetRuleDetail(args.id);
        return r ? { 标题:r.title||'', 专业:r.trade||'', 全文:(r.content||'').replace(/<[^>]+>/g,'') } : { error:'未找到 id=' + args.id };
      }
    },
    {
      name: 'search_handbook',
      description: '查询检查手册，按关键词模糊搜索检查项点。返回精简列表(id=全量下标+标题+摘要)，需要全文请用 get_handbook_detail(id)',
      parameters: { type:'object', properties:{ keyword:{type:'string',description:'搜索关键词'}, limit:{type:'integer',description:'返回条数上限，默认10'} }, required:['keyword'] },
      handler: async function(args) {
        var results = window._agentGetHandbook(args.keyword || '', args.limit || 10);
        var full = [];
        try { if (typeof window.getHandbookData === 'function') full = window.getHandbookData(); } catch(e) {}
        return { total: results.length, items: results.map(function(h) {
          var realIdx = full.indexOf(h);
          return { id: (realIdx >= 0 ? realIdx : -1), 标题: (h.chapter||'')+(h.section?(' / '+h.section):'')+(h.item?(' / '+h.item):''), 摘要: ((h.content||h.rules||'')).slice(0,120) };
        })};
      }
    },
    {
      name: 'get_handbook_detail',
      description: '根据 search_handbook 返回的 id(全量下标) 获取单条手册项点完整内容',
      parameters: { type:'object', properties:{ id:{type:'integer',description:'search_handbook 返回的 id(全量下标)'} }, required:['id'] },
      handler: async function(args) {
        var r = window._agentGetHandbookDetail(args.id);
        return r ? { 章节:(r.chapter||'')+(r.section?('/'+r.section):'')+(r.item?('/'+r.item):''), 内容:(r.content||r.rules||'') } : { error:'未找到 id=' + args.id };
      }
    },
    {
      name: 'write_diary',
      description: '在工作日志模块新增一条记录。issueIds 接收 search_issues 返回的 id 数组，自动提取性质/摘要/单位并结构化写入',
      parameters: { type:'object', properties:{ content:{type:'string',description:'日志正文内容'}, issues:{type:'string',description:'检查发现的问题描述(可选，自由文本)'}, date:{type:'string',description:'日期 YYYY-MM-DD，留空默认今天(可选)'}, issueIds:{type:'array',items:{type:'integer'},description:'关联的检查信息 id 数组(可选，search_issues 返回的 id)'} }, required:['content'] },
      handler: async function(args) { return window._agentWriteDiary(args.content || '', args.issues || '', args.date || '', args.issueIds || []); }
    },
    {
      name: 'save_report',
      description: '将分析报告保存到写作资料库。若已存在同名报告，自动追加版本号(v2/v3...)，不会覆盖旧版',
      parameters: { type:'object', properties:{ title:{type:'string',description:'报告标题'}, content:{type:'string',description:'报告全文内容(Markdown)'} }, required:['title','content'] },
      handler: async function(args) { return window._agentSaveReport(args.title || 'Agent报告', args.content || ''); }
    },
    {
      name: 'get_weather',
      description: '获取指定车站的实时天气(优先在线查询，超时5s；离线时使用内置兰州局主要车站坐标)',
      parameters: { type:'object', properties:{ stationName:{type:'string',description:'车站名称'} }, required:['stationName'] },
      handler: async function(args) {
        var stationName = args.stationName || '';
        var phoneData = window.getPhoneData ? window.getPhoneData() : [];
        var station = null;
        for (var i = 0; i < phoneData.length; i++) {
          if (phoneData[i].站名 === stationName || (phoneData[i].站名||'').indexOf(stationName) !== -1) {
            station = phoneData[i]; break;
          }
        }
        // 内置兰州局主要车站经纬度字典（离线/反查失败时的兜底）
        // 兰州局主要车站经纬度字典（100+站，县级精度 ≈0.01°，天气查询足够）
        var staticCoords = {
          // === 甘肃·兰州地区 ===
          '兰州':[36.06,103.83],'兰州西':[36.07,103.75],'兰州东':[36.05,103.88],'陈官营':[36.09,103.63],
          '西固城':[36.10,103.60],'河口南':[36.16,103.43],'坡底下':[36.12,103.53],'兰州新区':[36.52,103.64],
          '中川机场':[36.51,103.62],'皋兰':[36.34,103.95],'永登':[36.74,103.27],'中堡':[36.82,103.22],
          '龙泉寺':[36.51,103.13],'大路':[36.28,103.40],'红城':[36.74,103.15],
          // === 甘肃·天水/定西/陇西 ===
          '天水':[34.58,105.72],'甘谷':[34.74,105.33],'武山':[34.72,104.89],'陇西':[35.00,104.65],
          '定西':[35.58,104.62],'通安驿':[35.10,104.65],'李家坪':[35.60,104.60],'渭南镇':[34.57,105.82],
          '鸳鸯镇':[34.80,104.80],'洛门':[34.72,104.85],
          // === 甘肃·白银/景泰/靖远 ===
          '白银':[36.54,104.17],'白银西':[36.56,104.15],'景泰':[37.18,104.06],'靖远':[36.56,104.69],
          '平川':[36.72,104.82],'吴家川':[36.56,104.50],'红会':[36.65,105.05],'长征':[36.60,105.00],
          // === 甘肃·武威/金昌 ===
          '武威':[37.93,102.64],'武威南':[37.91,102.68],'古浪':[37.47,102.89],'天祝':[36.97,103.14],
          '打柴沟':[37.07,103.03],'黄羊镇':[37.77,102.72],'金昌':[38.50,102.19],'河西堡':[38.37,102.08],
          '芨岭':[38.60,101.88],
          // === 甘肃·张掖 ===
          '张掖':[38.93,100.45],'山丹':[38.79,101.09],'临泽':[39.15,100.17],'高台':[39.38,99.82],
          '民乐':[38.43,100.81],'东乐':[38.85,100.80],'平原堡':[39.02,100.37],'新华庄':[39.20,100.12],
          // === 甘肃·酒泉/嘉峪关/敦煌 ===
          '酒泉':[39.74,98.52],'嘉峪关':[39.77,98.29],'玉门':[39.82,97.58],'玉门东':[39.81,97.95],
          '玉门镇':[40.28,97.03],'低窝铺':[40.25,97.20],'疏勒河':[40.40,96.78],'柳园':[41.12,95.49],
          '敦煌':[40.14,94.66],'瓜州':[40.52,95.78],'清水':[39.38,99.12],'上河清':[39.50,98.90],
          '桥湾':[40.58,96.80],'五华山':[40.20,97.50],
          // === 甘肃·平凉/庆阳 ===
          '平凉':[35.54,106.67],'安口窑':[35.22,106.80],'崇信':[35.30,107.04],'平凉南':[35.50,106.70],
          '华亭':[35.22,106.65],'泾川':[35.33,107.36],'泾明':[35.36,107.46],'长庆桥':[35.33,107.70],
          // === 甘肃·陇南 ===
          '陇南':[33.39,104.93],'哈达铺':[34.05,104.21],'岷县':[34.43,104.04],'漳县':[34.85,104.47],
          // === 宁夏·银川/石嘴山 ===
          '银川':[38.47,106.27],'银川南':[38.45,106.28],'石嘴山':[39.02,106.38],'惠农':[39.22,106.72],
          '大武口':[39.02,106.37],'平罗':[38.91,106.54],
          // === 宁夏·吴忠/中卫 ===
          '吴忠':[37.98,106.20],'青铜峡':[37.98,105.98],'灵武':[38.10,106.34],'中卫':[37.51,105.19],
          '中宁':[37.49,105.67],'中宁东':[37.42,105.72],'红寺堡':[37.42,106.06],'盐池':[37.78,107.41],
          // === 宁夏·固原 ===
          '固原':[36.01,106.28],'同心':[36.98,105.91],'海原':[36.56,105.64],'彭阳':[35.85,106.64],
          '三营':[36.28,106.16],'泾源':[35.50,106.33],'六盘山':[35.67,106.22],
          // === 青海·西宁/海东 ===
          '西宁':[36.62,101.78],'西宁西':[36.62,101.69],'海石湾':[36.35,102.87],'乐都':[36.49,102.41],
          '平安驿':[36.50,102.12],'民和':[36.30,102.80],'互助':[36.83,101.95],'大通':[36.95,101.68],
          '湟源':[36.69,101.26],'海晏':[36.89,100.99],
          // === 青海·海西 ===
          '德令哈':[37.37,97.36],'格尔木':[36.41,94.90],'乌兰':[36.93,98.48],'天峻':[37.30,99.02],
          '哈尔盖':[37.20,100.41],'察尔汗':[36.80,95.30],'锡铁山':[37.02,95.56],
          // === 内蒙古西部(临哈线) ===
          '额济纳':[41.96,101.07],'策克':[42.58,101.10],
          // === 兰新客专(高铁)补充 ===
          '海东西':[36.55,102.10],'乐都南':[36.48,102.43],'大通西':[36.94,101.68],'门源':[37.37,101.61],
          '张掖西':[38.94,100.43],'临泽南':[39.15,100.16],'高台南':[39.38,99.82],'酒泉南':[39.73,98.50],
          '嘉峪关南':[39.76,98.28],
          // === 银兰/银西高铁补充 ===
          '惠安堡':[37.12,106.67],'太阳山':[37.28,106.45],'宁东':[38.10,106.55],
          // === 太中银线 ===
          '定边':[37.59,107.60],
          // === 干武线 ===
          '干塘':[37.30,104.68],
          // === 包兰线补充 ===
          '水源':[36.12,103.90],'邵家堂':[36.22,103.98],'甘草店':[35.88,104.27],
          // === 陇海线补充 ===
          '磐安镇':[34.75,105.11],'南河川':[34.59,105.75],
          // === 兰渝线补充 ===
          '岷县':[34.43,104.04],'渭源':[35.14,104.22],
          // === 甘肃其他支线 ===
          '桑园子':[36.04,103.95],
          // === 宁夏补充 ===
          '石嘴山南':[39.00,106.38],'石空':[37.48,105.68],'迎水桥':[37.50,105.15],
          // === 青海补充 ===
          '西宁北':[36.66,101.77],'陶家寨':[36.70,101.80],'柯柯':[36.98,98.28],
          '饮马峡':[37.26,95.86],'鱼卡':[38.03,95.00],'马海':[38.18,94.57]
        };
        if (!station) {
          // 直接从字典取坐标
          var match = staticCoords[stationName] || (function() {
            for (var k in staticCoords) { if (k.indexOf(stationName) !== -1) return staticCoords[k]; }
            return null;
          })();
          if (match) station = { 站名:stationName, 纬度:match[0], 经度:match[1] };
        }
        if (!station) return { ok: false, error: '未找到车站 ' + stationName + '（不在电话簿或内置字典中）' };
        if (!station.纬度 && typeof window.phoneGeocode === 'function') {
          try {
            var geo = await window.phoneGeocode(stationName, station.线名 || station.线路 || '');
            if (geo) { station.纬度 = geo.lat; station.经度 = geo.lon; }
          } catch (_) {}
        }
        if (!station.纬度) return { ok: false, error: '车站无坐标，无法定位' };
        try {
          var ctrl = new AbortController();
          var timer = setTimeout(function() { ctrl.abort(); }, 5000);
          var r = await fetch('https://api.open-meteo.com/v1/forecast?latitude=' + station.纬度 + '&longitude=' + station.经度 + '&current=temperature_2m,weather_code,wind_speed_10m&timezone=Asia/Shanghai', { signal: ctrl.signal });
          clearTimeout(timer);
          if (!r.ok) throw new Error('http ' + r.status);
          var w = await r.json();
          var wmo = { 0:'晴',1:'少云',2:'多云',3:'阴',45:'雾',48:'雾凇',51:'毛毛雨',53:'小雨',55:'中雨',56:'冻毛雨',57:'冻雨',61:'小雨',63:'中雨',65:'大雨',66:'冻小雨',67:'冻中雨',71:'小雪',73:'中雪',75:'大雪',77:'雪粒',80:'阵雨',81:'强阵雨',82:'暴雨',85:'阵雪',86:'强阵雪',95:'雷暴',96:'雷暴伴冰雹',99:'强雷暴伴冰雹' };
          return { ok: true, station: stationName, temp: w.current.temperature_2m + '°C', weather: wmo[w.current.weather_code] || ('代码' + w.current.weather_code), wind: w.current.wind_speed_10m + 'km/h' };
        } catch(e) {
          if (e.name === 'AbortError') return { ok: false, error: '天气查询超时（5s），请稍后重试或检查网络' };
          return { ok: false, error: '天气查询失败：' + (e.message || '') };
        }
      }
    }
  ];

  // ========== 转换为 DeepSeek tools 参数 ==========
  function _toolsParam() {
    return TOOLS.map(function(t) {
      return { type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } };
    });
  }

  // ========== 执行工具 ==========
  async function _executeTool(toolName, params) {
    var tool = TOOLS.find(function(t) { return t.name === toolName; });
    if (!tool) return { ok: false, error: '未知工具: ' + toolName };
    try {
      var result = await tool.handler(params || {});
      return { ok: true, tool: toolName, result: result };
    } catch(e) {
      return { ok: false, tool: toolName, error: e.message };
    }
  }

  // ========== 解析文本 JSON 兜底（仅当模型未用标准 tool_calls 且内容顶格为 JSON 块时）==========
  function _parseToolCall(content) {
    if (!content) return null;
    // 严格约束：仅匹配独立成块的 ```json``` 代码块，不匹配内联 JSON
    var m2 = content.match(/^\s*```json\s*\n([\s\S]*?)\n```\s*$/m);
    if (!m2) m2 = content.match(/\n```json\s*\n([\s\S]*?)\n```/);
    if (m2) { try { var p = JSON.parse(m2[1]); if (p && p.tool && typeof p.tool==='string') return p; } catch(e) {} }
    // 仅解析顶格或独立行出现的 JSON（避免匹配代码示例中的内联 JSON）
    var start = -1;
    var lines = content.split('\n');
    for (var l = 0; l < lines.length; l++) {
      var stripped = lines[l].trim();
      if (stripped === '{' || (stripped.indexOf('{"tool"') === 0)) { start = content.indexOf(lines[l]); break; }
    }
    if (start === -1) return null;
    var depth = 0, inStr = false, esc = false, end = -1;
    for (var i = start; i < content.length; i++) {
      var ch = content[i];
      if (inStr) { if (esc) esc = false; else if (ch === '\\') esc = true; else if (ch === '"') inStr = false; }
      else { if (ch === '"') inStr = true; else if (ch === '{') depth++; else if (ch === '}') { depth--; if (depth === 0) { end = i; break; } } }
    }
    if (end !== -1) { try { var p2 = JSON.parse(content.slice(start, end + 1)); if (p2 && p2.tool && typeof p2.tool==='string') return p2; } catch(e) {} }
    return null;
  }

  // ========== 调用 LLM（官方 function-calling）==========
  async function _callLLM(messages, withTools) {
    var apiKey = localStorage.getItem('ds_api_key_v1') || '';
    var apiUrl = localStorage.getItem('ds_api_url_v1') || 'https://api.deepseek.com/chat/completions';
    var model = localStorage.getItem('ds_model_v1') || 'deepseek-chat';
    if (!apiKey) throw new Error('请先在设置中配置 API Key');
    var controller = new AbortController();
    window.__agentAbort = controller; // 供停止按钮中断当前请求
    var body = { model: model, messages: messages, temperature: 0.3, max_tokens: 4000 };
    if (withTools) body.tools = _toolsParam();
    var resp;
    var timeoutTimer;
    try {
      // 60s 超时：自动中断长时间无响应的请求
      var timeoutPromise = new Promise(function(_, reject) {
        timeoutTimer = setTimeout(function() { controller.abort(); reject(new Error('请求超时（60s），请稍后重试')); }, 60000);
      });
      var fetchPromise = fetch(apiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + apiKey },
        body: JSON.stringify(body),
        signal: controller.signal
      });
      resp = await Promise.race([fetchPromise, timeoutPromise]);
    } catch(e) {
      clearTimeout(timeoutTimer);
      if (e.name === 'AbortError') throw new Error('已手动停止');
      throw e;
    }
    clearTimeout(timeoutTimer);
    if (!resp.ok) {
      var detail = '';
      try { var ed = await resp.json(); detail = (ed.error && ed.error.message) || ''; } catch(_) {}
      if (resp.status === 401) throw new Error('API Key 无效或未授权（401）' + (detail ? '：' + detail : ''));
      if (resp.status === 429) throw new Error('请求过于频繁，请稍后再试（429）');
      if (resp.status === 400) throw new Error('请求参数错误（400）' + (detail ? '：' + detail : '') + '｜若当前 API 不支持 function calling，请在设置中更换为 deepseek-chat');
      throw new Error('API 错误 ' + resp.status + (detail ? '：' + detail : ''));
    }
    var data = await resp.json();
    if (!data.choices || !data.choices[0] || !data.choices[0].message) throw new Error('API 返回格式异常');
    return data.choices[0].message;
  }

  // ========== ReAct 执行循环 ==========
  window._agentRun = async function(userMessage) {
    // B#9: 密钥预检，未配置直接返回友好提示，避免白跑 ReAct 循环
    if (!localStorage.getItem('ds_api_key_v1')) {
      return { messages: [{ role: 'assistant', content: '⚠️ 尚未配置 API Key，请先在「设置 → 智能助手」中填写 DeepSeek API Key，再使用智能体。' }], taskId: null };
    }
    var taskId = 'agent_' + Date.now().toString(36);
    var taskRecord = {
      id: taskId,
      timestamp: new Date().toISOString(),
      userIntent: userMessage,
      plan: [],
      steps: [],
      finalOutput: ''
    };

    var system = '你是铁路安监智能体，可调用下方 functions 操作本地数据（检查信息/规章制度/检查手册/工作日志/天气）。\n';
    // P1-9: 注入当前数据概览，减少盲搜轮次
    try {
      var issCount = window.getIssueData ? window.getIssueData().length : 0;
      var ruleCount = window.getRulesData ? window.getRulesData().length : 0;
      var hbCount = window.getHandbookData ? window.getHandbookData().length : 0;
      var phoneCount = window.getPhoneData ? window.getPhoneData().length : 0;
      var issDates = '';
      if (issCount > 0 && window.getIssueData) {
        var all = window.getIssueData(); all.sort(function(a,b){ return (a.datetime||'').localeCompare(b.datetime||''); });
        issDates = '，日期范围 ' + (all[0] ? (all[0].datetime||'').slice(0,10) : '?') + ' ~ ' + (all[all.length-1] ? (all[all.length-1].datetime||'').slice(0,10) : '?');
      }
      system += '当前数据：检查信息 ' + issCount + '条' + issDates + '，规章制度 ' + ruleCount + '条，检查手册 ' + hbCount + '条，应急电话 ' + phoneCount + '个。\n';
      if (issCount > 0) {
        var uniqUnits = {}; var issues = window.getIssueData();
        issues.forEach(function(i){ if(i.unit) uniqUnits[i.unit]=1; });
        var unitList = Object.keys(uniqUnits);
        if (unitList.length > 0 && unitList.length <= 20) system += '涉及单位：' + unitList.join('、') + '。\n';
      }
    } catch(e) { system += '数据量获取失败，请自行搜索。\n'; }
    system += '规则：\n';
    system += '1. 先用一句话说明计划（如："我将先查数据再生成报告"）\n';
    system += '2. 需要真实数据时，调用对应 function（每次可调用一个或多个）\n';
    system += '3. 搜索结果较精简（含摘要），通常可直接用于回答；仅当确实需要看完整细节时才调用 get_*_detail(id)\n';
    system += '4. 一轮搜索后如已获取足够数据，直接总结回答，不要逐条 detail（浪费轮次）\n';
    system += '5. 拿到结果后继续推理，直到能给出「最终自然语言回答」，此时不要调用 function\n';
    system += '6. 不需要工具时直接回答\n';
    system += '7. 整个任务控制在 5 轮以内完成\n';

    try {
      var ctx = await window.getRecentAgentContext();
      if (ctx) system += '\n\n历史任务记录：\n' + ctx;
    } catch(e) {}

    var messages = [
      { role: 'system', content: system },
      { role: 'user', content: userMessage }
    ];
    var renderMsgs = [{ role: 'agent-plan', content: '🧠 智能体·启动', plan: [] }];
    var maxLoops = 15; // B#6: 上限 15，复杂任务更从容（含搜索+detail+分析+report）
    var planShown = false;
    var lastCallKey = '', repeatCount = 0;

    for (var loop = 1; loop <= maxLoops; loop++) {
      var assistantMsg = await _callLLM(messages, true);
      var toolCalls = assistantMsg.tool_calls;

      // 兜底：模型未用标准 tool_calls 但文本里含 {"tool":...}
      if ((!toolCalls || !toolCalls.length) && assistantMsg.content) {
        var legacy = _parseToolCall(assistantMsg.content);
        if (legacy && legacy.tool) {
          toolCalls = [{ id: 'legacy_' + loop, type: 'function', function: { name: legacy.tool, arguments: JSON.stringify(legacy.params || {}) } }];
        }
      }

      if (toolCalls && toolCalls.length) {
        // C#12: 渲染工具调用前的计划说明（仅首次）
        if (!planShown) {
          var preText = (assistantMsg.content || '').replace(/```json[\s\S]*?```/gi, '').trim();
          if (preText) { renderMsgs.push({ role: 'agent-plan', content: '📋 ' + preText }); planShown = true; }
        }
        // 把 assistant 消息原样加入（含 tool_calls），供 API 配对
        messages.push(assistantMsg);
        // B#6: 连续两次相同调用即提前终止；对 detail 工具只看 id
        var keys = toolCalls.map(function(tc) {
          var args = {}; try { args = tc.function.arguments ? JSON.parse(tc.function.arguments) : {}; } catch(e) {}
          if (/^get_/.test(tc.function.name)) return tc.function.name + '|id=' + (args.id || '');
          return tc.function.name + '|' + tc.function.arguments;
        });
        var callKey = keys.join('@@');
        if (callKey === lastCallKey) {
          repeatCount++;
          if (repeatCount >= 2) {
            renderMsgs.push({ role: 'agent-tool', content: '⚠️ 检测到重复调用，已提前终止' });
            break;
          }
        } else { lastCallKey = callKey; repeatCount = 0; }

        for (var t = 0; t < toolCalls.length; t++) {
          var tc = toolCalls[t];
          var args = {};
          try { args = tc.function.arguments ? JSON.parse(tc.function.arguments) : {}; } catch(e) { args = {}; }
          var execResult = await _executeTool(tc.function.name, args);
          var summary = tc.function.name + ': ' + (execResult.ok ? (execResult.result && execResult.result.total !== undefined ? '✅ 共' + execResult.result.total + '条' : '✅') : '❌ ' + (execResult.error || ''));
          taskRecord.steps.push({ tool: tc.function.name, params: args, ok: execResult.ok, summary: summary });
          renderMsgs.push({ role: 'agent-tool', content: '🔧 ' + summary, tool: tc.function.name });
          messages.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify(execResult) });
        }
      } else {
        taskRecord.finalOutput = assistantMsg.content || '';
        renderMsgs.push({ role: 'assistant', content: assistantMsg.content || '' });
        break;
      }
    }

    if (!taskRecord.finalOutput) {
      taskRecord.finalOutput = '任务执行步骤过多（超' + maxLoops + '轮），请简化需求后重试。提示：尝试指定具体范围，如「查兰州西站消防问题」而非「分析全部数据」。';
      renderMsgs.push({ role: 'assistant', content: taskRecord.finalOutput });
    }

    try { await window.saveAgentTask(taskRecord); } catch(e) {}
    return { messages: renderMsgs, taskId: taskId };
  };
})();
