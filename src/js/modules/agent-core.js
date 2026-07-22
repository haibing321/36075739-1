/**
 * Agent Core（智能体核心）——规划器 + 工具注册（DeepSeek 官方 function-calling）
 * 只暴露 window._agentRun(userMessage) 一个入口
 */
(function() {
  // ========== 工具注册表（标准 OpenAI/DeepSeek tools 格式）==========
  var TOOLS = [
    {
      name: 'search_issues',
      description: '搜索检查信息数据库，按关键词模糊查找问题记录（支持单位/类别筛选）。返回精简列表(id+性质+时间+单位+摘要)，需要全文请用 get_issue_detail(id)',
      parameters: {
        type: 'object',
        properties: {
          keyword: { type: 'string', description: '搜索关键词，可多词用空格分隔' },
          unit: { type: 'string', description: '责任单位筛选(可选)' },
          category: { type: 'string', description: '类别筛选，如 消防安全/规章制度/设备管理等(可选)' },
          limit: { type: 'integer', description: '返回条数上限，默认30' }
        },
        required: []
      },
      handler: async function(args) {
        var all = window._agentGetIssues(args.keyword || '', args.unit || '', args.category || '', args.limit || 30);
        return { total: all.length, items: all.map(function(i, idx) {
          return { id: idx, 性质: i['性质']||'', 时间: i.datetime||'', 类别: i.category||'', 单位: i.unit||'', 摘要: (i.content||'').slice(0,60) };
        })};
      }
    },
    {
      name: 'get_issue_detail',
      description: '根据 search_issues 返回的 id 获取单条检查信息完整内容(含问题描述全文、规章依据)',
      parameters: { type:'object', properties:{ id:{type:'integer',description:'search_issues 返回的 id'} }, required:['id'] },
      handler: async function(args) {
        var r = window._agentGetIssueDetail(args.id);
        return r ? { 性质:r['性质']||'', 时间:r.datetime||'', 类别:r.category||'', 单位:r.unit||'', 问题描述:r.content||'', 规章依据:r.regulation||'' } : { error:'未找到 id=' + args.id };
      }
    },
    {
      name: 'search_rules',
      description: '搜索规章制度数据库，查找与关键词匹配的规章条款。返回精简列表(id+标题+专业+摘要)，需要全文请用 get_rule_detail(id)',
      parameters: { type:'object', properties:{ keyword:{type:'string',description:'搜索关键词'}, limit:{type:'integer',description:'返回条数上限，默认10'} }, required:['keyword'] },
      handler: async function(args) {
        var results = window._agentGetRules(args.keyword || '', args.limit || 10);
        return { total: results.length, items: results.map(function(r, idx) {
          return { id: idx, 标题: r.title||'', 专业: r.trade||'', 摘要: (r.content||'').replace(/<[^>]+>/g,'').slice(0,80) };
        })};
      }
    },
    {
      name: 'get_rule_detail',
      description: '根据 search_rules 返回的 id 获取单条规章完整条款内容',
      parameters: { type:'object', properties:{ id:{type:'integer',description:'search_rules 返回的 id'} }, required:['id'] },
      handler: async function(args) {
        var r = window._agentGetRuleDetail(args.id);
        return r ? { 标题:r.title||'', 专业:r.trade||'', 全文:(r.content||'').replace(/<[^>]+>/g,'') } : { error:'未找到 id=' + args.id };
      }
    },
    {
      name: 'search_handbook',
      description: '查询检查手册，按关键词模糊搜索检查项点。返回精简列表(id+标题+摘要)，需要全文请用 get_handbook_detail(id)',
      parameters: { type:'object', properties:{ keyword:{type:'string',description:'搜索关键词'}, limit:{type:'integer',description:'返回条数上限，默认10'} }, required:['keyword'] },
      handler: async function(args) {
        var results = window._agentGetHandbook(args.keyword || '', args.limit || 10);
        return { total: results.length, items: results.map(function(h, idx) {
          return { id: idx, 标题: (h.chapter||'')+(h.section?(' / '+h.section):'')+(h.item?(' / '+h.item):''), 摘要: ((h.content||h.rules||'')).slice(0,60) };
        })};
      }
    },
    {
      name: 'get_handbook_detail',
      description: '根据 search_handbook 返回的 id 获取单条手册项点完整内容',
      parameters: { type:'object', properties:{ id:{type:'integer',description:'search_handbook 返回的 id'} }, required:['id'] },
      handler: async function(args) {
        var r = window._agentGetHandbookDetail(args.id);
        return r ? { 章节:(r.chapter||'')+(r.section?('/'+r.section):'')+(r.item?('/'+r.item):''), 内容:(r.content||r.rules||'') } : { error:'未找到 id=' + args.id };
      }
    },
    {
      name: 'write_diary',
      description: '在工作日志模块新增一条记录，可指定日期(默认今天)',
      parameters: { type:'object', properties:{ content:{type:'string',description:'日志内容'}, issues:{type:'string',description:'检查发现的问题(可选)'}, date:{type:'string',description:'日期 YYYY-MM-DD，留空默认今天(可选)'} }, required:['content'] },
      handler: async function(args) { return window._agentWriteDiary(args.content || '', args.issues || '', args.date || ''); }
    },
    {
      name: 'save_report',
      description: '将分析报告保存到写作资料库',
      parameters: { type:'object', properties:{ title:{type:'string',description:'报告标题'}, content:{type:'string',description:'报告全文内容'} }, required:['title','content'] },
      handler: async function(args) { return window._agentSaveReport(args.title || 'Agent报告', args.content || ''); }
    },
    {
      name: 'get_weather',
      description: '获取指定车站的实时天气',
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
        if (!station) return { ok: false, error: '未找到车站' + stationName };
        if (!station.纬度 && typeof window.phoneGeocode === 'function') {
          try {
            var geo = await window.phoneGeocode(stationName, station.线名 || station.线路 || '');
            if (geo) { station.纬度 = geo.lat; station.经度 = geo.lon; }
          } catch (_) {}
        }
        if (!station.纬度) return { ok: false, error: '车站无坐标，无法定位（可能不在兰州局辖区或网络受限）' };
        try {
          var r = await fetch('https://api.open-meteo.com/v1/forecast?latitude=' + station.纬度 + '&longitude=' + station.经度 + '&current=temperature_2m,weather_code,wind_speed_10m&timezone=Asia/Shanghai');
          if (!r.ok) throw new Error('weather http ' + r.status);
          var w = await r.json();
          var wmo = { 0:'晴',1:'少云',2:'多云',3:'阴',45:'雾',48:'雾凇',51:'毛毛雨',53:'小雨',55:'中雨',56:'冻毛雨',57:'冻雨',61:'小雨',63:'中雨',65:'大雨',66:'冻小雨',67:'冻中雨',71:'小雪',73:'中雪',75:'大雪',77:'雪粒',80:'阵雨',81:'强阵雨',82:'暴雨',85:'阵雪',86:'强阵雪',95:'雷暴',96:'雷暴伴冰雹',99:'强雷暴伴冰雹' };
          return { ok: true, station: stationName, temp: w.current.temperature_2m + '°C', weather: wmo[w.current.weather_code] || ('代码' + w.current.weather_code), wind: w.current.wind_speed_10m + 'km/h' };
        } catch(e) { return { ok: false, error: '天气查询失败：' + (e.message || '') }; }
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

  // ========== 解析文本 JSON 兜底（仅当模型未用标准 tool_calls 时）==========
  function _parseToolCall(content) {
    if (!content) return null;
    var m2 = content.match(/```json\s*([\s\S]*?)```/);
    if (m2) { try { var p = JSON.parse(m2[1]); if (p && p.tool) return p; } catch(e) {} }
    var start = content.indexOf('{');
    if (start === -1) return null;
    var depth = 0, inStr = false, esc = false, end = -1;
    for (var i = start; i < content.length; i++) {
      var ch = content[i];
      if (inStr) { if (esc) esc = false; else if (ch === '\\') esc = true; else if (ch === '"') inStr = false; }
      else { if (ch === '"') inStr = true; else if (ch === '{') depth++; else if (ch === '}') { depth--; if (depth === 0) { end = i; break; } } }
    }
    if (end !== -1) { try { var p2 = JSON.parse(content.slice(start, end + 1)); if (p2 && p2.tool) return p2; } catch(e) {} }
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
    try {
      resp = await fetch(apiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + apiKey },
        body: JSON.stringify(body),
        signal: controller.signal
      });
    } catch(e) {
      if (e.name === 'AbortError') throw new Error('已手动停止');
      throw new Error('网络错误，无法连接 API：' + (e.message || ''));
    }
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
    system += '规则：\n';
    system += '1. 先用一句话说明计划（如："我将先查数据再生成报告"）\n';
    system += '2. 需要真实数据时，调用对应 function（每次可调用一个或多个）\n';
    system += '3. 列表结果较精简，需要全文时调用对应的 get_*_detail(id)\n';
    system += '4. 拿到结果后继续推理，直到能给出「最终自然语言回答」，此时不要调用 function\n';
    system += '5. 不需要工具时直接回答\n';

    try {
      var ctx = await window.getRecentAgentContext();
      if (ctx) system += '\n\n历史任务记录：\n' + ctx;
    } catch(e) {}

    var messages = [
      { role: 'system', content: system },
      { role: 'user', content: userMessage }
    ];
    var renderMsgs = [{ role: 'agent-plan', content: '🧠 智能体·启动', plan: [] }];
    var maxLoops = 8; // B#6: 上限 8，复杂任务更从容
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
        // B#6: 连续两次相同调用即提前终止，避免无效循环浪费 token
        var keys = toolCalls.map(function(tc) { return tc.function.name + '|' + tc.function.arguments; });
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
      taskRecord.finalOutput = '任务执行步骤过多，请简化需求后重试。';
      renderMsgs.push({ role: 'assistant', content: taskRecord.finalOutput });
    }

    try { await window.saveAgentTask(taskRecord); } catch(e) {}
    return { messages: renderMsgs, taskId: taskId };
  };
})();
