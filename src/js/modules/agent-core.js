/**
 * Agent Core（自主模式核心）——规划器 + 工具注册 + ReAct 执行循环
 * 只暴露 window._agentRun(userMessage) 一个入口
 */
(function() {
  // ========== 工具注册表 ==========
  var TOOLS = [
    {
      name: 'search_issues',
      description: '搜索检查信息数据库，按关键词查找问题记录',
      parameters: { keyword: '搜索关键词(可选)', unit: '责任单位(可选)', category: '类别(可选)' },
      handler: async function(args) {
        var all = window._agentGetIssues(args.keyword || '', args.unit || '', args.category || '', 30);
        return { total: all.length, items: all.map(function(i) {
          return { 性质: i['性质']||'', 时间: i.datetime||'', 类别: i.category||'', 描述: (i.content||'').slice(0,100), 单位: i.unit||'' };
        })};
      }
    },
    {
      name: 'search_rules',
      description: '搜索规章制度数据库，查找与关键词匹配的规章条款',
      parameters: { keyword: '搜索关键词' },
      handler: async function(args) {
        var results = window._agentGetRules(args.keyword || '', 10);
        return { total: results.length, items: results.map(function(r) {
          return { 标题: r.title||'', 条款: (r.content||'').replace(/<[^>]+>/g,'').slice(0,120), 专业: r.trade||'' };
        })};
      }
    },
    {
      name: 'write_diary',
      description: '在工作日志模块新增一条记录',
      parameters: { content: '日志内容', issues: '检查发现的问题(可选)' },
      handler: async function(args) {
        return window._agentWriteDiary(args.content || '', args.issues || '');
      }
    },
    {
      name: 'save_report',
      description: '将分析报告保存到写作资料库',
      parameters: { title: '报告标题', content: '报告全文内容' },
      handler: async function(args) {
        return window._agentSaveReport(args.title || 'Agent报告', args.content || '');
      }
    },
    {
      name: 'get_weather',
      description: '获取指定车站的实时天气',
      parameters: { stationName: '车站名称' },
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
        if (!station.纬度) return { ok: false, error: '车站无坐标，请先在应急电话中手动查询天气' };
        try {
          var r = await fetch('https://api.open-meteo.com/v1/forecast?latitude=' + station.纬度 + '&longitude=' + station.经度 + '&current=temperature_2m,weather_code,wind_speed_10m&timezone=Asia/Shanghai');
          var w = await r.json();
          var wmo = {0:'晴',1:'少云',2:'多云',3:'阴',45:'雾',51:'毛毛雨',61:'小雨',63:'中雨',65:'大雨',71:'小雪',73:'中雪',75:'大雪',95:'雷暴'};
          return { ok: true, station: stationName, temp: w.current.temperature_2m + '°C', weather: wmo[w.current.weather_code]||'', wind: w.current.wind_speed_10m + 'km/h' };
        } catch(e) { return { ok: false, error: '天气查询失败' }; }
      }
    },
    {
      name: 'search_handbook',
      description: '查询检查手册，按关键词搜索检查项点',
      parameters: { keyword: '搜索关键词' },
      handler: async function(args) {
        var results = window._agentGetHandbook(args.keyword || '', 10);
        return { total: results.length, items: results.map(function(h) {
          return { 标题: h.title||'', 内容: (h.content||h.rules||'').slice(0,100) };
        })};
      }
    }
  ];

  // ========== 工具描述文本（注入AI的提示词） ==========
  function _toolsPrompt() {
    var lines = ['## 可用工具（每次只调一个，格式：{"tool":"工具名","params":{...}}）'];
    TOOLS.forEach(function(t) {
      lines.push('- **' + t.name + '**: ' + t.description + ' → 参数: ' + JSON.stringify(t.parameters));
    });
    return lines.join('\n');
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

  // ========== 解析 AI 返回的工具调用 ==========
  function _parseToolCall(content) {
    var m = content.match(/\{[^{}]*"tool"\s*:\s*"[^"]+"\s*,\s*"params"\s*:\s*\{[^{}]*\}[^{}]*\}/);
    if (!m) {
      var m2 = content.match(/```json\s*([\s\S]*?)```/);
      if (m2) { try { return JSON.parse(m2[1]); } catch(e) {} }
      return null;
    }
    try { return JSON.parse(m[0]); } catch(e) { return null; }
  }

  // ========== 调用 LLM API ==========
  async function _callLLM(messages) {
    var apiKey = localStorage.getItem('ds_api_key_v1') || '';
    var apiUrl = localStorage.getItem('ds_api_url_v1') || 'https://api.deepseek.com/chat/completions';
    var model = localStorage.getItem('ds_model_v1') || 'deepseek-chat';
    if (!apiKey) throw new Error('请先配置 API Key');
    var resp = await fetch(apiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + apiKey },
      body: JSON.stringify({ model: model, messages: messages, temperature: 0.3, max_tokens: 2000 })
    });
    if (!resp.ok) throw new Error('API 错误: ' + resp.status);
    var data = await resp.json();
    return data.choices[0].message.content;
  }

  // ========== ReAct 执行循环 ==========
  window._agentRun = async function(userMessage) {
    var taskId = 'agent_' + Date.now().toString(36);
    var taskRecord = {
      id: taskId,
      timestamp: new Date().toISOString(),
      userIntent: userMessage,
      plan: [],
      steps: [],
      finalOutput: ''
    };

    var system = '你是铁路安监智能体，可调用工具操作本地数据。\n\n' + _toolsPrompt() + '\n\n';
    system += '规则：\n';
    system += '1. 先分析意图，用一句话说明计划（如："我将先查数据再生成报告"）\n';
    system += '2. 需要数据时用 {"tool":"xxx","params":{...}} 调工具\n';
    system += '3. 拿到结果后继续，直到可以「最终回答」\n';
    system += '4. 最终回答用自然语言，不要带工具调用。不需要工具时直接回答\n';

    try {
      var ctx = await window.getRecentAgentContext();
      if (ctx) system += '\n\n历史任务记录：\n' + ctx;
    } catch(e) {}

    var messages = [
      { role: 'system', content: system },
      { role: 'user', content: userMessage }
    ];
    var renderMsgs = [{ role: 'agent-plan', content: '🤖 自主模式·启动', plan: [] }];
    var maxLoops = 6;

    for (var loop = 1; loop <= maxLoops; loop++) {
      var content = await _callLLM(messages);
      if (!content) break;

      var toolCall = _parseToolCall(content);
      if (toolCall && toolCall.tool) {
        var execResult = await _executeTool(toolCall.tool, toolCall.params);
        var summary = toolCall.tool + ': ' + (execResult.ok ? (execResult.result && execResult.result.total !== undefined ? '✅ 共' + execResult.result.total + '条' : '✅') : '❌');

        taskRecord.steps.push({ tool: toolCall.tool, params: toolCall.params, ok: execResult.ok, summary: summary });
        renderMsgs.push({ role: 'agent-tool', content: '🔧 ' + summary, tool: toolCall.tool });
        messages.push({ role: 'assistant', content: content });
        messages.push({ role: 'user', content: '工具「' + toolCall.tool + '」结果：\n' + JSON.stringify(execResult) + '\n\n请继续推理给出最终回答或调下一个工具。' });
      } else {
        taskRecord.finalOutput = content;
        renderMsgs.push({ role: 'assistant', content: content });
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
