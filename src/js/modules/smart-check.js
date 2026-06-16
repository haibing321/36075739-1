/**
 * 安监智能辅助系统 - 智能对规模块
 * ===================================================
 * 从 doubao.js 拆分，包含：
 *   - 两阶段AI对规（BM25召回 → AI筛选 → 本地拼装）
 *   - 铁路专业术语库（PATCH_TERM_LIBRARY）
 *   - 关键词选择器（候选词+自定义词+词库管理）
 *   - 对规反馈收集
 * 加载顺序：在 doubao-common.js 之后，doubao.js 之前
 */

(function() {
    'use strict';

    var _globalCandidatesMap = {};
    var _acAbortController = null;
            // ========== 自动对规子模块 ==========
            // ========== 结构化术语库（带专业标签） ==========
            let PATCH_TERM_LIBRARY = [];
            let PATCH_TERM_MAP = new Map();

            function rebuildTermMap() {
                PATCH_TERM_MAP.clear();
                PATCH_TERM_LIBRARY.forEach(item => {
                    if (item && item.term) PATCH_TERM_MAP.set(item.term.toLowerCase(), item.trade || '通用');
                });
            }

            // 默认词库（原有术语 + 专业标签）
                        const DEFAULT_TERMS = [
                { term: "列车", trade: "车务" }, { term: "信号员", trade: "车务" }, { term: "内勤助理值班员", trade: "车务" }, 
                { term: "列车调度员", trade: "车务" }, { term: "外勤助理值班员", trade: "车务" }, { term: "扳道员", trade: "车务" }, 
                { term: "调车长", trade: "车务" }, { term: "车号员", trade: "车务" }, { term: "车站值班员", trade: "车务" }, { term: "连接员", trade: "车务" }, 
                { term: "到发线", trade: "车务" }, { term: "区间", trade: "车务" }, { term: "单线", trade: "车务" }, { term: "双线", trade: "车务" }, 
                { term: "岔线", trade: "车务" }, { term: "机待线", trade: "车务" }, { term: "机走线", trade: "车务" }, { term: "正线", trade: "车务" }, 
                { term: "段管线", trade: "车务" }, { term: "牵出线", trade: "车务" }, { term: "站间", trade: "车务" }, { term: "联络线", trade: "车务" }, 
                { term: "红色许可证", trade: "车务" }, { term: "绿色许可证", trade: "车务" }, { term: "行车凭证", trade: "车务" }, 
                { term: "调度命令", trade: "车务" }, { term: "路牌", trade: "车务" }, { term: "路票", trade: "车务" }, { term: "路签", trade: "车务" }, 
                { term: "一度停车", trade: "车务" }, { term: "三盯", trade: "车务" }, { term: "会让", trade: "车务" }, { term: "分界点", trade: "车务" }, 
                { term: "列车运行图", trade: "车务" }, { term: "区间占用", trade: "车务" }, { term: "发车", trade: "车务" }, { term: "呼唤应答", trade: "车务" }, 
                { term: "始发", trade: "车务" }, { term: "引导接车", trade: "车务" }, { term: "接发列车", trade: "车务" }, { term: "接车", trade: "车务" }, 
                { term: "终到", trade: "车务" }, { term: "编组", trade: "车务" }, { term: "自动闭塞", trade: "车务" }, { term: "越行", trade: "车务" }, 
                { term: "车机联控", trade: "车务" }, { term: "运行揭示", trade: "车务" }, { term: "退行", trade: "车务" }, { term: "途中折返", trade: "车务" }, 
                { term: "人力制动机", trade: "车务" }, { term: "取送车", trade: "车务" }, { term: "峰顶", trade: "车务" }, { term: "平面调车", trade: "车务" }, 
                { term: "推进", trade: "车务" }, { term: "推送调车", trade: "车务" }, { term: "止轮器", trade: "车务" }, { term: "溜放", trade: "车务" }, 
                { term: "站内调车", trade: "车务" }, { term: "解体", trade: "车务" }, { term: "解编", trade: "车务" }, { term: "试拉", trade: "车务" }, 
                { term: "调车作业", trade: "车务" }, { term: "越区调车", trade: "车务" }, { term: "车列", trade: "车务" }, { term: "铁鞋", trade: "车务" }, 
                { term: "防溜", trade: "车务" }, { term: "驼峰", trade: "车务" }, { term: "保压", trade: "机务" }, { term: "减压", trade: "机务" }, 
                { term: "分段缓解", trade: "机务" }, { term: "快充", trade: "机务" }, { term: "慢充", trade: "机务" }, { term: "拉风", trade: "机务" }, 
                { term: "持续保压", trade: "机务" }, { term: "排风", trade: "机务" }, { term: "缓解", trade: "机务" }, { term: "自然制动", trade: "机务" }, 
                { term: "自然缓解", trade: "机务" }, { term: "过充", trade: "机务" }, { term: "追加减压", trade: "机务" }, { term: "追加制动", trade: "机务" }, 
                { term: "阶段性制动", trade: "机务" }, { term: "再制动", trade: "机务" }, { term: "再生制动", trade: "机务" }, { term: "动力制动", trade: "机务" }, 
                { term: "常用制动", trade: "机务" }, { term: "撒砂", trade: "机务" }, { term: "液力制动", trade: "机务" }, { term: "电阻制动", trade: "机务" }, 
                { term: "盘形制动", trade: "机务" }, { term: "磁轨制动", trade: "机务" }, { term: "空气制动", trade: "机务" }, { term: "紧急制动", trade: "机务" }, 
                { term: "停放制动", trade: "机务" }, { term: "制动机", trade: "机务" }, { term: "制动缸", trade: "机务" }, { term: "单独制动机", trade: "机务" }, 
                { term: "弹簧停车制动", trade: "机务" }, { term: "总风缸", trade: "机务" }, { term: "电空制动", trade: "机务" }, 
                { term: "自动制动机", trade: "机务" }, { term: "防滑器", trade: "机务" }, { term: "全部试验", trade: "机务" }, { term: "安定试验", trade: "机务" }, 
                { term: "感度保压", trade: "机务" }, { term: "感度试验", trade: "机务" }, { term: "简略试验", trade: "机务" }, { term: "紧急试验", trade: "机务" }, 
                { term: "试风", trade: "机务" }, { term: "过球试验", trade: "机务" }, { term: "司机长", trade: "机务" }, { term: "学习司机", trade: "机务" }, 
                { term: "指导司机", trade: "机务" }, { term: "机车司机", trade: "机务" }, { term: "添乘人员", trade: "机务" }, { term: "制动", trade: "机务" }, 
                { term: "接管", trade: "机务" }, { term: "机车", trade: "机务" }, { term: "手柄", trade: "机务" }, { term: "换向手柄", trade: "机务" }, 
                { term: "调速手柄", trade: "机务" }, { term: "东风型机车", trade: "机务" }, { term: "内燃机车", trade: "机务" }, { term: "动车组", trade: "机务" }, 
                { term: "动车组列车", trade: "机务" }, { term: "双机牵引", trade: "机务" }, { term: "和谐型机车", trade: "机务" }, 
                { term: "本务机车", trade: "机务" }, { term: "电力机车", trade: "机务" }, { term: "蒸汽机车", trade: "机务" }, { term: "补机", trade: "机务" }, 
                { term: "调车机车", trade: "机务" }, { term: "重联机车", trade: "机务" }, { term: "韶山型机车", trade: "机务" }, { term: "包乘", trade: "机务" }, 
                { term: "换班", trade: "机务" }, { term: "机车交路", trade: "机务" }, { term: "机车周转图", trade: "机务" }, { term: "牵引", trade: "机务" }, 
                { term: "继乘", trade: "机务" }, { term: "轮乘", trade: "机务" }, { term: "主变压器", trade: "机务" }, { term: "主断路器", trade: "机务" }, 
                { term: "励磁", trade: "机务" }, { term: "整流", trade: "机务" }, { term: "牵引变流器", trade: "机务" }, { term: "牵引电动机", trade: "机务" }, 
                { term: "辅助逆变器", trade: "机务" }, { term: "逆变", trade: "机务" }, { term: "冷却器", trade: "机务" }, { term: "司机室", trade: "机务" }, 
                { term: "操纵台", trade: "机务" }, { term: "散热器", trade: "机务" }, { term: "水泵", trade: "机务" }, { term: "油水分离器", trade: "机务" }, 
                { term: "油泵", trade: "机务" }, { term: "燃泵", trade: "机务" }, { term: "轮缘润滑", trade: "机务" }, { term: "通风机", trade: "机务" }, 
                { term: "预热锅炉", trade: "机务" }, { term: "走停走", trade: "机务" }, { term: "出入段模式", trade: "机务" }, { term: "定标", trade: "机务" }, 
                { term: "常用制动模式", trade: "机务" }, { term: "监控模式", trade: "机务" }, { term: "监控装置", trade: "机务" }, 
                { term: "目视行车模式", trade: "机务" }, { term: "紧急制动模式", trade: "机务" }, { term: "警惕", trade: "机务" }, 
                { term: "调整状态", trade: "机务" }, { term: "调车模式", trade: "机务" }, { term: "车上信号", trade: "机务" }, { term: "运行监控", trade: "机务" }, 
                { term: "降级状态", trade: "机务" }, { term: "作用管", trade: "机务" }, { term: "储风缸", trade: "机务" }, { term: "列车管", trade: "机务" }, 
                { term: "制动管", trade: "机务" }, { term: "副风缸", trade: "机务" }, { term: "压力表", trade: "机务" }, { term: "容积风缸", trade: "机务" }, 
                { term: "工作风缸", trade: "机务" }, { term: "干燥器", trade: "机务" }, { term: "平均管", trade: "机务" }, { term: "总风缸管", trade: "机务" }, 
                { term: "截断塞门", trade: "机务" }, { term: "折角塞门", trade: "机务" }, { term: "接风管", trade: "机务" }, { term: "摘管", trade: "机务" }, 
                { term: "漏泄", trade: "机务" }, { term: "空压机", trade: "机务" }, { term: "空压机组", trade: "机务" }, { term: "紧急放风阀", trade: "机务" }, 
                { term: "风压", trade: "机务" }, { term: "风表", trade: "机务" }, { term: "三通阀", trade: "车辆" }, { term: "分配阀", trade: "车辆" }, 
                { term: "制动梁", trade: "车辆" }, { term: "差压阀", trade: "车辆" }, { term: "空重阀", trade: "车辆" }, { term: "缓解阀", trade: "车辆" }, 
                { term: "闸片", trade: "车辆" }, { term: "闸瓦", trade: "车辆" }, { term: "闸瓦托", trade: "车辆" }, { term: "高度阀", trade: "车辆" }, 
                { term: "侧架", trade: "车辆" }, { term: "减振器", trade: "车辆" }, { term: "弹簧组", trade: "车辆" }, { term: "摇枕", trade: "车辆" }, 
                { term: "踏面", trade: "车辆" }, { term: "车轮", trade: "车辆" }, { term: "车轴", trade: "车辆" }, { term: "转向架", trade: "车辆" }, 
                { term: "轮对", trade: "车辆" }, { term: "轮缘", trade: "车辆" }, { term: "轴承", trade: "车辆" }, { term: "轴温", trade: "车辆" }, 
                { term: "轴箱", trade: "车辆" }, { term: "侧墙", trade: "车辆" }, { term: "底架", trade: "车辆" }, { term: "枕梁", trade: "车辆" }, 
                { term: "牵引梁", trade: "车辆" }, { term: "端墙", trade: "车辆" }, { term: "车体", trade: "车辆" }, { term: "冷藏车", trade: "车辆" }, 
                { term: "卧铺车", trade: "车辆" }, { term: "双层客车", trade: "车辆" }, { term: "发电车", trade: "车辆" }, { term: "客车", trade: "车辆" }, 
                { term: "平车", trade: "车辆" }, { term: "敞车", trade: "车辆" }, { term: "棚车", trade: "车辆" }, { term: "硬座车", trade: "车辆" }, 
                { term: "罐车", trade: "车辆" }, { term: "行李车", trade: "车辆" }, { term: "货车", trade: "车辆" }, { term: "软座车", trade: "车辆" }, 
                { term: "邮政车", trade: "车辆" }, { term: "集装箱车", trade: "车辆" }, { term: "餐车", trade: "车辆" }, { term: "密接式车钩", trade: "车辆" }, 
                { term: "挂车", trade: "车辆" }, { term: "摘车", trade: "车辆" }, { term: "缓冲器", trade: "车辆" }, { term: "车钩", trade: "车辆" }, 
                { term: "软管", trade: "车辆" }, { term: "连挂", trade: "车辆" }, { term: "钩尾框", trade: "车辆" }, { term: "钩舌", trade: "车辆" }, 
                { term: "防跳装置", trade: "车辆" }, { term: "列车管系", trade: "车辆" }, { term: "车组", trade: "车辆" }, { term: "上道作业", trade: "工务" }, 
                { term: "巡道", trade: "工务" }, { term: "打磨", trade: "工务" }, { term: "换轨", trade: "工务" }, { term: "捣固", trade: "工务" }, 
                { term: "探伤", trade: "工务" }, { term: "清筛", trade: "工务" }, { term: "焊轨", trade: "工务" }, { term: "线路封锁", trade: "工务" }, 
                { term: "钢轨伤损", trade: "工务" }, { term: "四轮", trade: "工务" }, { term: "小车", trade: "工务" }, { term: "捣固机", trade: "工务" }, 
                { term: "探伤仪", trade: "工务" }, { term: "轨道车", trade: "工务" }, { term: "轻型车辆", trade: "工务" }, { term: "专用线", trade: "工务" }, 
                { term: "咽喉", trade: "工务" }, { term: "安全线", trade: "工务" }, { term: "尽头线", trade: "工务" }, { term: "护坡", trade: "工务" }, 
                { term: "挡墙", trade: "工务" }, { term: "排水沟", trade: "工务" }, { term: "桥台", trade: "工务" }, { term: "桥墩", trade: "工务" }, 
                { term: "桥梁", trade: "工务" }, { term: "涵洞", trade: "工务" }, { term: "站台", trade: "工务" }, { term: "股道", trade: "工务" }, 
                { term: "路基", trade: "工务" }, { term: "道口", trade: "工务" }, { term: "避难线", trade: "工务" }, { term: "隧道", trade: "工务" }, 
                { term: "雨棚", trade: "工务" }, { term: "圆曲线", trade: "工务" }, { term: "扣件", trade: "工务" }, { term: "无砟轨道", trade: "工务" }, 
                { term: "无缝线路", trade: "工务" }, { term: "曲线", trade: "工务" }, { term: "有砟轨道", trade: "工务" }, { term: "机械节", trade: "工务" }, 
                { term: "焊缝", trade: "工务" }, { term: "缓和曲线", trade: "工务" }, { term: "超高", trade: "工务" }, { term: "轨底坡", trade: "工务" }, 
                { term: "轨枕", trade: "工务" }, { term: "轨距", trade: "工务" }, { term: "道床", trade: "工务" }, { term: "钢轨", trade: "工务" }, 
                { term: "长钢轨", trade: "工务" }, { term: "交叉渡线", trade: "工务" }, { term: "基本轨", trade: "工务" }, { term: "复式交分", trade: "工务" }, 
                { term: "尖轨", trade: "工务" }, { term: "岔区", trade: "工务" }, { term: "心轨", trade: "工务" }, { term: "护轨", trade: "工务" }, 
                { term: "翼轨", trade: "工务" }, { term: "菱形交叉", trade: "工务" }, { term: "转辙器", trade: "工务" }, { term: "辙叉", trade: "工务" }, 
                { term: "道岔", trade: "工务" }, { term: "道岔号码", trade: "工务" }, { term: "脱轨器", trade: "工务" }, { term: "防护栅栏", trade: "工务" }, 
                { term: "主体信号", trade: "电务" }, { term: "从属信号", trade: "电务" }, { term: "减速信号", trade: "电务" }, { term: "出站信号", trade: "电务" }, 
                { term: "加速信号", trade: "电务" }, { term: "地面信号", trade: "电务" }, { term: "复示信号", trade: "电务" }, { term: "容许信号", trade: "电务" }, 
                { term: "引导信号", trade: "电务" }, { term: "接近信号", trade: "电务" }, { term: "机车信号", trade: "电务" }, { term: "调车信号", trade: "电务" }, 
                { term: "进站信号", trade: "电务" }, { term: "进路表示器", trade: "电务" }, { term: "通过信号", trade: "电务" }, 
                { term: "道岔表示器", trade: "电务" }, { term: "遮断信号", trade: "电务" }, { term: "预告信号", trade: "电务" }, 
                { term: "驼峰信号", trade: "电务" }, { term: "信号机", trade: "电务" }, { term: "固定信号", trade: "电务" }, 
                { term: "总出站信号机", trade: "电务" }, { term: "方向继电器", trade: "电务" }, { term: "灯丝继电器", trade: "电务" }, 
                { term: "继电器", trade: "电务" }, { term: "臂板信号", trade: "电务" }, { term: "色灯信号", trade: "电务" }, { term: "轨道继电器", trade: "电务" }, 
                { term: "进路信号机", trade: "电务" }, { term: "道口信号", trade: "电务" }, { term: "遮断信号机", trade: "电务" }, 
                { term: "ATP", trade: "电务" }, { term: "BTM", trade: "电务" }, { term: "CBTC", trade: "电务" }, { term: "DMI", trade: "电务" }, 
                { term: "GSM-R", trade: "电务" }, { term: "ITCS", trade: "电务" }, { term: "LEU", trade: "电务" }, { term: "LKJ", trade: "电务" }, 
                { term: "LKJ2000", trade: "电务" }, { term: "LKJ2000A", trade: "电务" }, { term: "RBC", trade: "电务" }, 
                { term: "STM", trade: "电务" }, { term: "TCC", trade: "电务" }, { term: "TCR", trade: "电务" }, { term: "列控", trade: "电务" }, 
                { term: "列控车载设备", trade: "电务" }, { term: "应答器", trade: "电务" }, { term: "无线闭塞中心", trade: "电务" }, 
                { term: "码序", trade: "电务" }, { term: "轨道读取器", trade: "电务" }, { term: "故障状态", trade: "电务" }, { term: "区段锁闭", trade: "电务" }, 
                { term: "半自动闭塞", trade: "电务" }, { term: "单独锁闭", trade: "电务" }, { term: "抵触进路", trade: "电务" }, 
                { term: "敌对进路", trade: "电务" }, { term: "电气集中联锁", trade: "电务" }, { term: "电话闭塞", trade: "电务" }, 
                { term: "继电器联锁", trade: "电务" }, { term: "联锁", trade: "电务" }, { term: "自动站间闭塞", trade: "电务" }, { term: "解锁", trade: "电务" }, 
                { term: "计算机联锁", trade: "电务" }, { term: "道岔锁闭", trade: "电务" }, { term: "闭塞", trade: "电务" }, { term: "CTC", trade: "电务" }, 
                { term: "TDCS", trade: "电务" }, { term: "发码", trade: "电务" }, { term: "发码电路", trade: "电务" }, { term: "极性交叉", trade: "电务" }, 
                { term: "死区段", trade: "电务" }, { term: "电化区段", trade: "电务" }, { term: "电气节", trade: "电务" }, { term: "相邻区段", trade: "电务" }, 
                { term: "绝缘接头", trade: "电务" }, { term: "绝缘节", trade: "电务" }, { term: "轨道区段", trade: "电务" }, { term: "轨道电路", trade: "电务" }, 
                { term: "轨道电路信息", trade: "电务" }, { term: "非电化区段", trade: "电务" }, { term: "发车进路", trade: "电务" }, 
                { term: "引导进路", trade: "电务" }, { term: "接车进路", trade: "电务" }, { term: "调车进路", trade: "电务" }, { term: "进路解锁", trade: "电务" }, 
                { term: "进路锁闭", trade: "电务" }, { term: "通过进路", trade: "电务" }, { term: "光纤通信", trade: "电务" }, { term: "同轴电缆", trade: "电务" }, 
                { term: "数字调度", trade: "电务" }, { term: "区间电话", trade: "电务" }, { term: "有线列调", trade: "电务" }, 
                { term: "站间行车电话", trade: "电务" }, { term: "调度电话", trade: "电务" }, { term: "CIR", trade: "电务" }, 
                { term: "GSM-R手持台", trade: "电务" }, { term: "无线列调", trade: "电务" }, { term: "光缆", trade: "电务" }, 
                { term: "漏泄电缆", trade: "电务" }, { term: "电缆", trade: "电务" }, { term: "对讲机", trade: "电务" }, { term: "录音设备", trade: "电务" }, 
                { term: "语音记录仪", trade: "电务" }, { term: "中继站", trade: "电务" }, { term: "基站", trade: "电务" }, { term: "通信机房", trade: "电务" }, 
                { term: "通信铁塔", trade: "电务" }, { term: "电话防护", trade: "电务" }, { term: "倒闸", trade: "供电" }, { term: "停电命令", trade: "供电" }, 
                { term: "分闸", trade: "供电" }, { term: "合闸", trade: "供电" }, { term: "送电命令", trade: "供电" }, { term: "销令", trade: "供电" }, 
                { term: "受电弓", trade: "供电" }, { term: "受电弓滑板", trade: "供电" }, { term: "碳滑板", trade: "供电" }, { term: "集电头", trade: "供电" }, 
                { term: "保护线", trade: "供电" }, { term: "分区所", trade: "供电" }, { term: "变电所", trade: "供电" }, { term: "回流线", trade: "供电" }, 
                { term: "开闭所", trade: "供电" }, { term: "断路器", trade: "供电" }, { term: "架空地线", trade: "供电" }, { term: "牵引变压器", trade: "供电" }, 
                { term: "自耦变压器", trade: "供电" }, { term: "隔离开关", trade: "供电" }, { term: "馈线", trade: "供电" }, { term: "电气化", trade: "供电" }, 
                { term: "接触网工", trade: "供电" }, { term: "电力工", trade: "供电" }, { term: "中性区", trade: "供电" }, { term: "分相", trade: "供电" }, 
                { term: "张力补偿", trade: "供电" }, { term: "接触悬挂", trade: "供电" }, { term: "接触网", trade: "供电" }, { term: "支柱", trade: "供电" }, 
                { term: "无电区", trade: "供电" }, { term: "电分段", trade: "供电" }, { term: "电分相", trade: "供电" }, { term: "硬横梁", trade: "供电" }, 
                { term: "简单悬挂", trade: "供电" }, { term: "软横跨", trade: "供电" }, { term: "链形悬挂", trade: "供电" }, { term: "锚段", trade: "供电" }, 
                { term: "锚段关节", trade: "供电" }, { term: "中心锚结", trade: "供电" }, { term: "分段绝缘器", trade: "供电" }, { term: "分相器", trade: "供电" }, 
                { term: "吊弦", trade: "供电" }, { term: "定位器", trade: "供电" }, { term: "定位线夹", trade: "供电" }, { term: "弹簧补偿器", trade: "供电" }, 
                { term: "承力索", trade: "供电" }, { term: "拉杆", trade: "供电" }, { term: "接触线", trade: "供电" }, { term: "滑轮补偿", trade: "供电" }, 
                { term: "线岔", trade: "供电" }, { term: "绝缘子", trade: "供电" }, { term: "腕臂", trade: "供电" }, { term: "避雷器", trade: "供电" }, 
                { term: "弓网故障", trade: "供电" }, { term: "V形作业", trade: "供电" }, { term: "停电作业", trade: "供电" }, { term: "动态检测", trade: "供电" }, 
                { term: "步行巡视", trade: "供电" }, { term: "添乘检查", trade: "供电" }, { term: "直接带电作业", trade: "供电" }, 
                { term: "远离作业", trade: "供电" }, { term: "间接带电作业", trade: "供电" }, { term: "静态测量", trade: "供电" }, 
                { term: "高空作业", trade: "供电" }, { term: "上水", trade: "客运" }, { term: "列车保洁", trade: "客运" }, { term: "列车整备", trade: "客运" }, 
                { term: "排污", trade: "客运" }, { term: "临客列车", trade: "客运" }, { term: "快速列车", trade: "客运" }, { term: "旅客列车", trade: "客运" }, 
                { term: "旅游列车", trade: "客运" }, { term: "普速列车", trade: "客运" }, { term: "特快列车", trade: "客运" }, { term: "直达特快", trade: "客运" }, 
                { term: "通勤列车", trade: "客运" }, { term: "列车编组", trade: "客运" }, { term: "加挂", trade: "客运" }, { term: "欠编", trade: "客运" }, 
                { term: "满编", trade: "客运" }, { term: "甩挂", trade: "客运" }, { term: "编组表", trade: "客运" }, { term: "客运规章", trade: "客运" }, 
                { term: "客运记录", trade: "客运" }, { term: "广播通告", trade: "客运" }, { term: "投诉处理", trade: "客运" }, { term: "遗失物品", trade: "客运" }, 
                { term: "重点旅客", trade: "客运" }, { term: "候车室", trade: "客运" }, { term: "出站口", trade: "客运" }, { term: "动车所", trade: "客运" }, 
                { term: "售票厅", trade: "客运" }, { term: "售票窗口", trade: "客运" }, { term: "地道", trade: "客运" }, { term: "天桥", trade: "客运" }, 
                { term: "客整所", trade: "客运" }, { term: "检票口", trade: "客运" }, { term: "行李房", trade: "客运" }, { term: "进站口", trade: "客运" }, 
                { term: "问讯处", trade: "客运" }, { term: "上水工", trade: "客运" }, { term: "列车员", trade: "客运" }, { term: "列车长", trade: "客运" }, 
                { term: "售票员", trade: "客运" }, { term: "客运值班员", trade: "客运" }, { term: "广播员", trade: "客运" }, { term: "检票员", trade: "客运" }, 
                { term: "乘车证", trade: "客运" }, { term: "实名制验证", trade: "客运" }, { term: "改签", trade: "客运" }, { term: "电子客票", trade: "客运" }, 
                { term: "票务系统", trade: "客运" }, { term: "纸质车票", trade: "客运" }, { term: "退票", trade: "客运" }, { term: "包裹运输", trade: "客运" }, 
                { term: "行包", trade: "客运" }, { term: "行包房", trade: "客运" }, { term: "行李托运", trade: "客运" }, { term: "停运", trade: "客运" }, 
                { term: "客流高峰", trade: "客运" }, { term: "旅客乘降", trade: "客运" }, { term: "春运", trade: "客运" }, { term: "晚点", trade: "客运" }, 
                { term: "暑运", trade: "客运" }, { term: "正点", trade: "客运" }, { term: "站车交接", trade: "客运" }, { term: "节假日运输", trade: "客运" }, 
                { term: "运行图调整", trade: "客运" }, { term: "装载机司机", trade: "货运" }, { term: "货检员", trade: "货运" }, 
                { term: "货运值班员", trade: "货运" }, { term: "货运员", trade: "货运" }, { term: "门吊司机", trade: "货运" }, { term: "冷链货物", trade: "货运" }, 
                { term: "危险品货物", trade: "货运" }, { term: "危险货物", trade: "货运" }, { term: "成件包装货物", trade: "货运" }, 
                { term: "散堆装货物", trade: "货运" }, { term: "整车货物", trade: "货运" }, { term: "笨重货物", trade: "货运" }, { term: "篷布", trade: "货运" }, 
                { term: "装载加固", trade: "货运" }, { term: "货物装载方案", trade: "货运" }, { term: "超限货物", trade: "货运" }, 
                { term: "阔大货物", trade: "货运" }, { term: "集装箱", trade: "货运" }, { term: "集装箱货物", trade: "货运" }, { term: "集重货物", trade: "货运" }, 
                { term: "零担货物", trade: "货运" }, { term: "鲜活货物", trade: "货运" }, { term: "人力装卸", trade: "货运" }, { term: "捆绑加固", trade: "货运" }, 
                { term: "散货装卸", trade: "货运" }, { term: "机械装卸", trade: "货运" }, { term: "蓬布苫盖", trade: "货运" }, { term: "装载方案", trade: "货运" }, 
                { term: "货物换装", trade: "货运" }, { term: "危险品检测", trade: "货运" }, { term: "押运", trade: "货运" }, { term: "货物异状", trade: "货运" }, 
                { term: "货物撒漏", trade: "货运" }, { term: "货运事故", trade: "货运" }, { term: "超偏载检测", trade: "货运" }, 
                { term: "超限检测", trade: "货运" }, { term: "仓库", trade: "货运" }, { term: "地磅", trade: "货运" }, { term: "装卸线", trade: "货运" }, 
                { term: "货位", trade: "货运" }, { term: "货场", trade: "货运" }, { term: "货物站台", trade: "货运" }, { term: "轨道衡", trade: "货运" }, 
                { term: "集装箱场", trade: "货运" }, { term: "计费重量", trade: "货运" }, { term: "货物交付", trade: "货运" }, { term: "货物运价", trade: "货运" }, 
                { term: "货物运单", trade: "货运" }, { term: "货票", trade: "货运" }, { term: "运价里程", trade: "货运" }, { term: "到达预报", trade: "货运" }, 
                { term: "卸车", trade: "货运" }, { term: "待卸车", trade: "货运" }, { term: "排空", trade: "货运" }, { term: "日班计划", trade: "货运" }, 
                { term: "空车", trade: "货运" }, { term: "装车", trade: "货运" }, { term: "货运计划", trade: "货运" }, { term: "重车", trade: "货运" }, 
                { term: "供暖管网", trade: "房建" }, { term: "换热站", trade: "房建" }, { term: "空调机房", trade: "房建" }, { term: "通风系统", trade: "房建" }, 
                { term: "锅炉房", trade: "房建" }, { term: "信号楼", trade: "房建" }, { term: "列检所", trade: "房建" }, { term: "工区", trade: "房建" }, 
                { term: "调度楼", trade: "房建" }, { term: "车间", trade: "房建" }, { term: "运转室", trade: "房建" }, { term: "公寓", trade: "房建" }, 
                { term: "单身宿舍", trade: "房建" }, { term: "食堂", trade: "房建" }, { term: "应急照明", trade: "房建" }, { term: "照明系统", trade: "房建" }, 
                { term: "站台照明", trade: "房建" }, { term: "配电室", trade: "房建" }, { term: "候车大厅", trade: "房建" }, { term: "无柱雨棚", trade: "房建" }, 
                { term: "站前广场", trade: "房建" }, { term: "站台雨棚", trade: "房建" }, { term: "站房", trade: "房建" }, { term: "站房结构", trade: "房建" }, 
                { term: "站房面积", trade: "房建" }, { term: "风雨棚", trade: "房建" }, { term: "化粪池", trade: "房建" }, { term: "客车上水栓", trade: "房建" }, 
                { term: "排水管网", trade: "房建" }, { term: "水塔", trade: "房建" }, { term: "水泵房", trade: "房建" }, { term: "消防水池", trade: "房建" }, 
                { term: "给水所", trade: "房建" }, { term: "地面维修", trade: "房建" }, { term: "外墙粉刷", trade: "房建" }, { term: "大修", trade: "房建" }, 
                { term: "屋面防水", trade: "房建" }, { term: "巡检", trade: "房建" }, { term: "房屋维修", trade: "房建" }, { term: "暖通维修", trade: "房建" }, 
                { term: "管道疏通", trade: "房建" }, { term: "配电维修", trade: "房建" }, { term: "限界检查", trade: "房建" }, { term: "围墙", trade: "房建" }, 
                { term: "大门", trade: "房建" }, { term: "硬化面", trade: "房建" }, { term: "绿化", trade: "房建" }, { term: "道路", trade: "房建" }, 
                { term: "侵限", trade: "房建" }, { term: "站台限界", trade: "房建" }, { term: "风雨棚限界", trade: "房建" }, 
                { term: "标准化作业", trade: "综合管理" }, { term: "安全教育", trade: "综合管理" }, { term: "安全考试", trade: "综合管理" }, 
                { term: "安全评估", trade: "综合管理" }, { term: "岗前培训", trade: "综合管理" }, { term: "持证上岗", trade: "综合管理" }, 
                { term: "隐患整改", trade: "综合管理" }, { term: "风险研判", trade: "综合管理" }, { term: "作业门", trade: "综合管理" }, 
                { term: "安全作业区", trade: "综合管理" }, { term: "安全区", trade: "综合管理" }, { term: "下道避车", trade: "综合管理" }, 
                { term: "安全预想", trade: "综合管理" }, { term: "班前点名", trade: "综合管理" }, { term: "班后总结", trade: "综合管理" }, 
                { term: "瞭望", trade: "综合管理" }, { term: "邻线来车", trade: "综合管理" }, { term: "鸣笛", trade: "综合管理" }, 
                { term: "劳动安全", trade: "综合管理" }, { term: "安全红线", trade: "综合管理" }, { term: "安全联控", trade: "综合管理" }, 
                { term: "供电安全距离", trade: "综合管理" }, { term: "建筑限界", trade: "综合管理" }, { term: "机车车辆限界", trade: "综合管理" }, 
                { term: "限界", trade: "综合管理" }, { term: "中间防护员", trade: "综合管理" }, { term: "现场防护员", trade: "综合管理" }, 
                { term: "远端防护员", trade: "综合管理" }, { term: "防护员", trade: "综合管理" }, { term: "驻站联络员", trade: "综合管理" }, 
                { term: "信号旗", trade: "综合管理" }, { term: "停车信号", trade: "综合管理" }, { term: "好了信号", trade: "综合管理" }, 
                { term: "手信号", trade: "综合管理" }, { term: "移动信号", trade: "综合管理" }, { term: "红牌", trade: "综合管理" }, 
                { term: "蓝牌", trade: "综合管理" }, { term: "防护信号", trade: "综合管理" }, { term: "三位一体防护", trade: "综合管理" }, 
                { term: "临时限速", trade: "综合管理" }, { term: "事故调查", trade: "综合管理" }, { term: "应急响应", trade: "综合管理" }, 
                { term: "应急处置", trade: "综合管理" }, { term: "应急演练", trade: "综合管理" }, { term: "应急预案", trade: "综合管理" }, 
                { term: "救援列车", trade: "综合管理" }, { term: "救援起复", trade: "综合管理" }, { term: "行车事故", trade: "综合管理" }, 
                { term: "非正常行车", trade: "综合管理" }, { term: "作业命令", trade: "综合管理" }, { term: "施工作业", trade: "综合管理" }, 
                { term: "施工把关", trade: "综合管理" }, { term: "施工负责人", trade: "综合管理" }, { term: "电气化施工", trade: "综合管理" }, 
                { term: "碰撞试验", trade: "综合管理" }, { term: "维修作业", trade: "综合管理" }, { term: "天窗", trade: "综合管理" }, 
                { term: "天窗点", trade: "综合管理" }, { term: "天窗点外", trade: "综合管理" }, { term: "区间封锁", trade: "综合管理" }, 
                { term: "封锁区间", trade: "综合管理" }, { term: "开通区间", trade: "综合管理" }, { term: "施工封锁", trade: "综合管理" }, 
                { term: "确认车", trade: "综合管理" }, { term: "检查作业", trade: "综合管理" }, { term: "施工计划", trade: "综合管理" }, 
                { term: "维修计划", trade: "综合管理" }, { term: "慢行", trade: "综合管理" }, { term: "慢行地点", trade: "综合管理" }, 
                { term: "慢行处所", trade: "综合管理" }, { term: "撤除限速", trade: "综合管理" }, { term: "邻线限速", trade: "综合管理" }, 
                { term: "阶梯限速", trade: "综合管理" }, { term: "限速", trade: "综合管理" }, { term: "动火作业", trade: "综合管理" }, 
                { term: "动火审批", trade: "综合管理" }, { term: "应急广播", trade: "综合管理" }, { term: "手动报警按钮", trade: "综合管理" }, 
                { term: "消火栓", trade: "综合管理" }, { term: "消防制度", trade: "综合管理" }, { term: "消防报警", trade: "综合管理" }, 
                { term: "消防控制室", trade: "综合管理" }, { term: "消防检查", trade: "综合管理" }, { term: "消防水带", trade: "综合管理" }, 
                { term: "消防水泵", trade: "综合管理" }, { term: "消防演练", trade: "综合管理" }, { term: "消防设施", trade: "综合管理" }, 
                { term: "消防责任人", trade: "综合管理" }, { term: "消防通道", trade: "综合管理" }, { term: "消防隐患", trade: "综合管理" }, 
                { term: "温感探测器", trade: "综合管理" }, { term: "火灾应急", trade: "综合管理" }, { term: "灭火器", trade: "综合管理" }, 
                { term: "烟感探测器", trade: "综合管理" }, { term: "疏散指示", trade: "综合管理" }, { term: "疏散通道", trade: "综合管理" }, 
                { term: "禁烟管理", trade: "综合管理" }, { term: "防火分区", trade: "综合管理" }, { term: "防火门", trade: "综合管理" }, 
                { term: "岗位职责", trade: "综合管理" }, { term: "技术规章", trade: "综合管理" }, 
            ];

            // 加载并迁移词库（旧版纯字符串 → 新版结构化）
            (function loadAndMigrateTerms() {
                let oldTerms = [];
                try {
                    const rawOld = localStorage.getItem('railway_terms_custom');
                    if (rawOld) { oldTerms = JSON.parse(rawOld); if (!Array.isArray(oldTerms)) oldTerms = []; }
                } catch(e) { oldTerms = []; }

                let savedTerms = [];
                try {
                    const rawNew = localStorage.getItem('patch_term_library_v2');
                    if (rawNew) { savedTerms = JSON.parse(rawNew); if (!Array.isArray(savedTerms)) savedTerms = []; }
                } catch(e) { savedTerms = []; }

                const migrated = oldTerms.filter(t => typeof t === 'string' && t.length >= 2).map(term => ({ term, trade: '通用' }));
                const map = new Map();
                DEFAULT_TERMS.forEach(item => map.set(item.term.toLowerCase(), item));
                migrated.forEach(item => map.set(item.term.toLowerCase(), item));
                savedTerms.forEach(item => { if (item && item.term) map.set(item.term.toLowerCase(), item); });
                PATCH_TERM_LIBRARY = Array.from(map.values());
                rebuildTermMap();
                if (oldTerms.length > 0) localStorage.removeItem('railway_terms_custom');
                localStorage.setItem('patch_term_library_v2', JSON.stringify(PATCH_TERM_LIBRARY));
                console.log('[词库] 结构化词库加载完成，共 ' + PATCH_TERM_LIBRARY.length + ' 个术语');
            })();

            // 兼容旧代码（保持全局 RAILWAY_TERMS Set 可用）
            let RAILWAY_TERMS = new Set(PATCH_TERM_LIBRARY.map(i => i.term));
            function syncTermSet() { RAILWAY_TERMS = new Set(PATCH_TERM_LIBRARY.map(i => i.term)); }


            const PATCH_TRADE_KEYWORDS = {
                '车务': ['接发列车', '调车', '进路', '行车凭证', '闭塞', '联控', '防溜', '调度命令',
                        '车机联控', '一度停车', '退行', '推进', '溜放', '司机', '运转', '行车日志',
                        '信号员', '值班员', '助理值班员', '电子运统', '施工登销记', '错办进路',
                        '分路不良', '超限列车', '专特运'],
                '工务': ['线路', '道岔', '钢轨', '轨枕', '道床', '限界', '防护栅栏', '上道作业',
                        '胀轨', '无缝线路', '巡道', '探伤', '轨道几何', '道口', '栅栏', '护网',
                        '路基', '桥隧', '护坡', '排水', '轨距', '水平', '高低', '轨向', '三角坑',
                        '捣固', '清筛', '打磨'],
                '电务': ['信号机', '转辙机', '轨道电路', '联锁', 'CTC', 'LKJ', '机车信号', '电缆',
                        '继电器', '应答器', '列控', '闭塞', '发码', '电源屏', 'TDCS', 'ITCS',
                        '道岔缺口', '密贴力', '表示杆', 'ZPW-2000', '红光带'],
                '供电': ['接触网', '受电弓', '分相', '锚段', '承力索', '隔离开关', 'V停', '停电作业',
                        '验电接地', '绝缘子', '供电线', '分区所', '开闭所', '牵引变', '接触线',
                        '回流线', '架空地线', '保护线', '弓网', '拉出值', '导高', '硬点', '燃弧'],
                '机务': ['机车', '动车组', '制动', '司机', '添乘', 'LKJ', '牵引', '制动机',
                        '走行部', '轮对', '受电弓', '动车', '驾驶', '送车', '接车', '整备',
                        '待乘', '试风', '监控关机', '违章解锁', '冒进', '冒出', '超速'],
                '车辆': ['客车', '货车', '轮对', '闸瓦', '转向架', '轴温', '5T', '列检', '防溜',
                        '制动梁', '车钩', '风管', '缓解阀', '制动机试验', 'TFDS', 'THDS',
                        'TPDS', '切轴', '热轴', '关门车'],
                '货运': ['装载', '加固', '超限', '偏载', '集重', '危险品', '集装箱', '篷布',
                        '轮重测定仪', '货物', '装卸', '货检', '超长货物', '混运', '匿报品名'],
                '通信': ['无线列调', 'CIR', 'GSM-R', '光纤', '漏缆', '直放站', '电源屏', '传输',
                        '数调', '录音', '广播', '综合网管', '纤芯劣化', '误码率'],
                '房建': ['站台', '雨棚', '房屋', '给排水', '围墙', '站房', '天桥', '地道', '限界',
                        '防雷', '侵限', '轻飘物'],
                '通用': []
            };

            function patchInferTrade(query) {
                if (!query) return null;
                const lowerQ = query.toLowerCase();
                const scores = {};
                for (const [trade, keywords] of Object.entries(PATCH_TRADE_KEYWORDS)) {
                    let score = 0;
                    for (const kw of keywords) {
                        if (lowerQ.includes(kw)) {
                            score += Math.min(kw.length, 6);
                        }
                    }
                    if (score > 0) scores[trade] = score;
                }
                const sorted = Object.entries(scores).sort((a, b) => b[1] - a[1]);
                return sorted.length > 0 ? sorted[0][0] : null;
            }

            // HTML转义函数
            function acEscHtml(s) {
                return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#039;');
            }

            // 铁路安监领域违规行为关键词（用于增强关键词提取，捕捉违规描述）
            const VIOLATION_ACTION_WORDS = new Set([
                '违规', '违章', '违反', '不符合', '未按规定', '未按', '擅自',
                '未设置', '未设', '未配备', '未安装', '缺少', '缺失',
                '未确认', '未核实', '未检查', '未核对', '未通知',
                '未经允许', '未经批准', '未经许可', '私自', '无证',
                '超速', '超限', '越区', '越站', '错办',
                '漏办', '误办', '迟办', '未办', '错发', '漏发',
                '未及时', '未按规定时间', '延误', '滞后',
                '未佩戴', '未穿戴', '未使用', '未携带',
                '未下达', '未传达', '未执行', '未落实',
                '未锁闭', '未确认', '未试验', '未检测',
                '未设置防护', '未设防护', '未派人防护', '无人防护',
                '天窗点外', '点外作业', '点外上道',
                '无命令', '无计划', '无防护', '无调度命令',
                '违规上道', '擅自进入', '擅自作业',
                '未消记', '未销令', '未开通',
                '关闭', '短路', '断开', '拆除',
                '未接地', '未断电', '未验电',
                '超载', '超重', '偏载', '集重',
                '分离', '脱轨', '挤岔', '冲突', '追尾',
                '冒进', '冒出', '溜逸', '放飏',
                '未换端', '未换位', '未换室',
                '中断', '错误', '丢失', '遗忘',
            ]);

            // 铁路安监领域扩展停用词表
            const AUTOCHECK_STOP_WORDS = new Set([
                // 通用停用词
                '的', '了', '和', '与', '或', '对', '在', '被', '把', '让', '给', '向', '从', '到',
                '上', '下', '内', '外', '中', '里', '等', '及', '以及', '并且', '而且', '但是',
                '如果', '那么', '因为', '所以', '是', '有', '不', '也', '都', '还', '要', '会',
                '可以', '能', '可能', '应该', '必须', '需要', '这个', '那个', '这些', '那些',
                // 常见连接词
                '进行', '开展', '情况', '相关', '工作', '发现', '存在', '问题',
                '单位', '部门', '领导', '负责', '组织', '实施', '执行',
                // 铁路安监领域无实际检索价值的词
                '第一', '预防', '为主', '综合', '治理', '强化', '落实', '确保', '保障',
                '提高', '加强', '完善', '建立', '健全', '推动', '促进', '实现',
                '车间', '工区', '班组', '职工', '干部', '督查', '巡视',
                '养护', '制度', '措施', '方案', '流程',
                '按照', '根据', '依照', '参照', '依据', '对于', '关于', '针对', '鉴于',
                '操作', '使用', '维护', '保养', '报告', '通知', '办法',
                '细则', '规程', '规则', '条例', '文件', '函', '电报',
                '严重', '一般', '较大', '重大', '特别', '主要', '次要'
            ]);

            // ---- 单位名称判定：匹配以"段"、"站"等结尾，或包含"车间"等词的模式 ----
            function isOrgName(term) {
                if (!term || term.length > 12) return false; // 过长的词可能是描述，保留
                // 明确的单位后缀
                const orgSuffix = term.match(/(段|站|中心|车间|工区|班组|分公司|子公司|处|室)$/);
                if (orgSuffix) return true;
                // 特定模式：高铁基础设施段、车务段、工务段、电务段、供电段、车辆段、机务段、通信段、房建段、货运中心等
                if (/基础设施段|车务段|工务段|电务段|供电段|车辆段|机务段|通信段|房建段|货运中心|高铁基础设施段/.test(term)) return true;
                // 模式："XX站" 且不是专有名词（排除 "会让站" "编组站" "技术站" 这种通用术语）
                if (/站$/.test(term) && !['会让站','编组站','中间站','区段站','越行站'].includes(term)) return true;
                return false;
            }

            // ---- 关键词提取（从结构化词库+违规行为词中筛选，按专业加权） ----
            function acExtractKeywords(text, inferredTrade) {
                const kwSet = new Set();
                const lowerText = text.toLowerCase();

                // 第一类：术语词（结构化词库，按专业+长度加权排序），并过滤掉单位名称
                const scored = [];
                PATCH_TERM_LIBRARY.forEach(function(item) {
                    if (lowerText.includes(item.term.toLowerCase())) {
                        // 跳过单位名称
                        if (isOrgName(item.term)) return;
                        
                        let weight = item.term.length;
                        if (inferredTrade && item.trade === inferredTrade) {
                            weight += 100; // 同专业加权
                        }
                        scored.push({ term: item.term, weight });
                    }
                });
                scored.sort(function(a, b) { return b.weight - a.weight; });
                scored.forEach(function(s) { kwSet.add(s.term); });

                // 第二类：违规行为词
                VIOLATION_ACTION_WORDS.forEach(function(word) {
                    if (lowerText.includes(word.toLowerCase())) {
                        kwSet.add(word);
                    }
                });
                
                // 第三类：同义词扩展
                Object.entries(SYNONYM_MAP).forEach(function([key, syns]) {
                    const keyIncluded = lowerText.includes(key.toLowerCase());
                    if (keyIncluded) {
                        syns.forEach(function(s) { if (lowerText.includes(s.toLowerCase())) kwSet.add(s); });
                    } else {
                        syns.forEach(function(s) {
                            if (lowerText.includes(s.toLowerCase())) { kwSet.add(key); kwSet.add(s); }
                        });
                    }
                });
                
                // 按长度降序，过滤被更长词包含的短词（<=3字）
                const allTokens = Array.from(kwSet).sort(function(a, b) { return b.length - a.length; });
                return allTokens.filter(function(w, i) {
                    if (w.length <= 3) {
                        return !allTokens.slice(0, i).some(function(lg) { return lg.length >= 4 && lg.includes(w); });
                    }
                    return true;
                }).slice(0, 50);
            }

            // ---- 纯词库关键词提取（仅专业术语，不含违规词和同义词）----
            function acExtractLibraryKeywords(text) {
                var lowerText = text.toLowerCase();
                var scored = [];
                PATCH_TERM_LIBRARY.forEach(function(item) {
                    if (lowerText.includes(item.term.toLowerCase())) {
                        if (isOrgName(item.term)) return;
                        scored.push({ term: item.term, weight: item.term.length });
                    }
                });
                scored.sort(function(a, b) { return b.weight - a.weight; });
                // 去重：短词被长词包含则剔除
                var all = scored.map(function(s) { return s.term; });
                return all.filter(function(w, i) {
                    if (w.length <= 3) {
                        return !all.slice(0, i).some(function(lg) { return lg.length >= 4 && lg.includes(w); });
                    }
                    return true;
                });
            }

            // ---- 纯关键词提取（不依赖词库建议，用于检索，严格过滤单位名称） ----
            function acExtractPureKeywords(text) {
                const kwSet = new Set();

                // 1. 提取违规行为关键词
                VIOLATION_ACTION_WORDS.forEach(function(word) {
                    // 确保关键词前后有边界，避免 "未设" 匹配到 "设计" 等
                    const boundaryRegex = new RegExp('(?:^|[^\\w\\d\u4e00-\u9fa5])(' + word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ')(?=[^\\w\\d\u4e00-\u9fa5]|$)', 'i');
                    if (boundaryRegex.test(text)) {
                        kwSet.add(word);
                    }
                });

                // 2. 从词库中提取专业术语，但精确过滤掉单位名称
                PATCH_TERM_LIBRARY.forEach(function(item) {
                    if (text.includes(item.term)) {
                        // 严格过滤单位名称：只保留非单位名称的专业术语
                        if (!isOrgName(item.term)) {
                            kwSet.add(item.term);
                        }
                    }
                });

                // 3. 提取长度大于等于3且不包含在词库中的词组（自然语言关键词）
                // 简单按标点、空格分词，提取有意义的较长词组
                const segments = text.split(/[，。！？、；：""''（）\s]+/);
                segments.forEach(seg => {
                    if (seg.length >= 3 && seg.length <= 12) { // 限制长度，避免长句
                        // 排除纯数字、纯标点
                        if (/^[\d\.\-\+\/]+$/.test(seg)) return;
                        // 作为文本固有词提取
                        kwSet.add(seg);
                    }
                });

                // 最后过滤一遍，确保结果中没有单位名称
                return Array.from(kwSet).filter(kw => !isOrgName(kw));
            }


            // ---- 文本片段高亮关键词命中位置 ----
            function acGetSnippet(content, keywords, maxLen) {
                maxLen = maxLen || 200;
                let bestPos = -1, bestKw = '';
                for (const kw of keywords) {
                    const pos = content.toLowerCase().indexOf(kw);
                    if (pos !== -1 && (bestPos === -1 || kw.length > bestKw.length)) { bestPos = pos; bestKw = kw; }
                }
                if (bestPos === -1) return content.length > maxLen ? content.slice(0, maxLen) + '…' : content;
                const half = Math.floor(maxLen / 2);
                const start = Math.max(0, bestPos - half);
                const end = Math.min(content.length, bestPos + half);
                return (start > 0 ? '…' : '') + content.slice(start, end) + (end < content.length ? '…' : '');
            }

            // ---- 计算文本与关键词的匹配得分 ----
            function acScore(text, titleText, keywords) {
                let score = 0;
                const lc = text.toLowerCase(), tlc = (titleText || '').toLowerCase();
                for (const kw of keywords) {
                    if (lc.includes(kw) || tlc.includes(kw)) {
                        let s = Math.min(3, 1 + kw.length / 3);
                        if (tlc.includes(kw)) s += 2; // 标题命中奖励
                        score += s;
                    }
                }
                return keywords.length ? score / (keywords.length * 4) : 0;
            }

            // ============================================================
            // 核心：两阶段本地匹配
            // 第一阶段：在检查信息中找相似历史案例
            // 第二阶段：基于案例 + 关键词，在规章制度中找对应条款判定违规
            // ============================================================
            
            // 关键词选择状态
            let acSelectedKeywords = new Set();
            let acCandidateKeywords = [];
            let _acInputTimer = null;  // 防抖定时器
            
            // textarea 输入时自动提取候选词
            window.acOnInputChange = function(value) {
                clearTimeout(_acInputTimer);
                const query = value.trim();
                if (!query) {
                    // 输入为空，隐藏候选区并重置
                    const selectArea = document.getElementById('keyword-select-area');
                    if (selectArea) selectArea.style.display = 'none';
                    acCandidateKeywords = [];
                    acSelectedKeywords = new Set();
                    return;
                }
                // 防抖 300ms 后提取
                _acInputTimer = setTimeout(function() {
                    const newCandidates = acExtractKeywords(query, patchInferTrade(query));
                    // 仅当候选词集合变化时才重置选中状态
                    const newSet = new Set(newCandidates);
                    const changed = newCandidates.length !== acCandidateKeywords.length ||
                        newCandidates.some(k => !acCandidateKeywords.includes(k));
                    acCandidateKeywords = newCandidates;
                    if (changed) {
                        // 保留仍在候选列表中的已选词，移除已不在候选中的词
                        const keeping = new Set(Array.from(acSelectedKeywords).filter(k => newSet.has(k)));
                        acSelectedKeywords = keeping;
                    }
                    acShowKeywordSelector(query);
                }, 300);
            };
            
            window.autoCheckLocal = function() {
                const input = document.getElementById('autoCheck-input');
                const query = input.value.trim();
                if (!query) { alert('请输入检查问题描述'); return; }
                
                // 若还没提取过候选词，先提取一次
                if (acCandidateKeywords.length === 0) {
                    acCandidateKeywords = acExtractKeywords(query, patchInferTrade(query));
                }
                
                // 若有已选关键词则用已选的，否则用全部候选词；若候选词也为空则提示
                let keywords = Array.from(acSelectedKeywords);
                if (keywords.length === 0) {
                    keywords = [...acCandidateKeywords];
                }
                if (keywords.length === 0) {
                    alert('未匹配到词库关键词，请手动添加关键词后再匹配');
                    return;
                }
                
                // 将关键词加入词库
                acAddKeywordsToLibrary(keywords);
                // 执行匹配
                acDoLocalMatch(keywords);
                // 标记本地匹配已完成，锁定按钮为AI对规
                _acHasLocalResult = true;
            };
            
            // 显示关键词选择界面
            function acShowKeywordSelector(query) {
                const selectArea = document.getElementById('keyword-select-area');
                const countEl = document.getElementById('keyword-select-count');
                
                if (!selectArea) return;
                
                // 渲染候选关键词
                acRenderCandidateList();
                
                // 渲染已选关键词
                acRenderSelectedList();
                
                // 显示选择区域
                selectArea.style.display = 'block';
                
                // 更新计数
                countEl.textContent = '已选: ' + acSelectedKeywords.size + '/4';
                
                // 隐藏结果区域
                document.getElementById('autoCheck-results').style.display = 'none';
            }
            
            // 渲染候选关键词列表（上栏，点击选中/取消）
            function acRenderCandidateList() {
                const list = document.getElementById('keyword-candidate-list');
                if (!list) return;
                
                let html = '';
                acCandidateKeywords.forEach((kw) => {
                    const isSelected = acSelectedKeywords.has(kw);
                    if (isSelected) {
                        // 已选中状态：蓝色高亮，点击取消
                        html += '<span class="keyword-candidate-tag" data-keyword="' + acEscHtml(kw) + '" ' +
                            'style="' +
                            'display:inline-flex;align-items:center;padding:6px 10px;border-radius:16px;font-size:0.85rem;' +
                            'cursor:pointer;transition:all 0.15s;user-select:none;' +
                            'background:var(--primary);color:#fff;border:2px solid var(--primary);' +
                            '" ' +
                            'onclick="acToggleCandidateKeyword(\'' + acEscHtml(kw) + '\')" ' +
                            'title="点击取消选中" ' +
                            '>' + acEscHtml(kw) + ' <span style="margin-left:4px;font-size:0.75rem;">✓</span></span>';
                    } else {
                        // 未选中状态：灰色，点击选中
                        html += '<span class="keyword-candidate-tag" data-keyword="' + acEscHtml(kw) + '" ' +
                            'style="' +
                            'display:inline-flex;align-items:center;padding:6px 10px;border-radius:16px;font-size:0.85rem;' +
                            'cursor:pointer;transition:all 0.15s;user-select:none;' +
                            'background:#f1f5f9;color:var(--text);border:2px solid #e2e8f0;' +
                            '" ' +
                            'onclick="acToggleCandidateKeyword(\'' + acEscHtml(kw) + '\')" ' +
                            'title="点击选中" ' +
                            'onmouseover="if(!this.dataset.selected){this.style.background=\'#e2e8f0\';this.style.borderColor=\'var(--primary)\';}" ' +
                            'onmouseout="if(!this.dataset.selected){this.style.background=\'#f1f5f9\';this.style.borderColor=\'#e2e8f0\';}" ' +
                            '>' + acEscHtml(kw) + ' <span style="margin-left:4px;font-size:0.75rem;opacity:0.5;">+</span></span>';
                    }
                });
                
                if (acCandidateKeywords.length === 0) {
                    html = '<span style="color:var(--text-secondary);font-size:0.8rem;padding:4px;">输入文本未匹配到词库中的术语，请手动添加或导入词库</span>';
                }
                
                list.innerHTML = html;
            }
            
            // 切换候选词选中状态
            window.acToggleCandidateKeyword = function(kw) {
                if (acSelectedKeywords.has(kw)) {
                    acSelectedKeywords.delete(kw);
                } else {
                    if (acSelectedKeywords.size >= 4) {
                        alert('最多选择4个关键词');
                        return;
                    }
                    acSelectedKeywords.add(kw);
                    acAddKeywordsToLibrary([kw]);
                }
                acRenderCandidateList();
                acRenderSelectedList();
                document.getElementById('keyword-select-count').textContent = '已选: ' + acSelectedKeywords.size + '/4';
            };
            
            // 渲染已选关键词列表（下栏，点击取消）
            function acRenderSelectedList() {
                const list = document.getElementById('keyword-selected-list');
                if (!list) return;
                
                let html = '';
                acSelectedKeywords.forEach((kw) => {
                    html += '<span class="keyword-selected-tag" data-keyword="' + acEscHtml(kw) + '" ' +
                        'style="' +
                        'display:inline-flex;align-items:center;padding:6px 10px;border-radius:16px;font-size:0.85rem;' +
                        'cursor:pointer;transition:all 0.15s;user-select:none;' +
                        'background:var(--primary);color:#fff;border:2px solid var(--primary);' +
                        '" ' +
                        'onclick="acRemoveSelectedKeyword(\'' + acEscHtml(kw) + '\')" ' +
                        'title="点击移除" ' +
                        'onmouseover="this.style.opacity=\'0.8\'" ' +
                        'onmouseout="this.style.opacity=\'1\'" ' +
                        '>' + acEscHtml(kw) + ' <span style="margin-left:4px;font-size:0.75rem;">✕</span></span>';
                });
                
                list.innerHTML = html || '<span style="color:var(--text-secondary);font-size:0.8rem;padding:4px;">点击上方候选词选中...</span>';
            }
            
            // 添加自定义关键词
            window.acAddCustomKeyword = function() {
                const input = document.getElementById('keyword-custom-input');
                const kw = input.value.trim();
                if (!kw) return;
                if (kw.length < 2) {
                    alert('关键词至少需要2个字符');
                    return;
                }
                if (acSelectedKeywords.size >= 4) {
                    alert('最多选择4个关键词');
                    return;
                }
                
                // 添加到已选，如果不在候选里也追加到候选
                acSelectedKeywords.add(kw);
                if (!acCandidateKeywords.includes(kw)) {
                    acCandidateKeywords.push(kw);
                }
                
                // 清空输入
                input.value = '';
                
                // 重新渲染两栏
                acRenderCandidateList();
                acRenderSelectedList();
                document.getElementById('keyword-select-count').textContent = '已选: ' + acSelectedKeywords.size + '/4';
                
                // 自动添加到词库
                acAddKeywordsToLibrary([kw]);
            };
            
            // 移除已选关键词（同步刷新候选词选中状态）
            window.acRemoveSelectedKeyword = function(keyword) {
                acSelectedKeywords.delete(keyword);
                acRenderCandidateList();
                acRenderSelectedList();
                document.getElementById('keyword-select-count').textContent = '已选: ' + acSelectedKeywords.size + '/4';
            };
            
            // 清空已选关键词
            window.acClearSelectedKeywords = function() {
                acSelectedKeywords.clear();
                acRenderCandidateList();
                acRenderSelectedList();
                document.getElementById('keyword-select-count').textContent = '已选: 0/4';
            };
            
            // 确认关键词并开始匹配
            window.acConfirmKeywords = function() {
                if (acSelectedKeywords.size === 0) {
                    alert('请至少选择1个关键词');
                    return;
                }
                // 将选中的关键词添加到词库
                acAddKeywordsToLibrary(Array.from(acSelectedKeywords));
                // 执行匹配
                acDoLocalMatch(Array.from(acSelectedKeywords));
            };
            
            // 将关键词添加到词库
            function acAddKeywordsToLibrary(keywords) {
                let addedCount = 0;
                keywords.forEach(kw => {
                    if (!RAILWAY_TERMS.has(kw)) {
                        RAILWAY_TERMS.add(kw);
                        const item = { term: kw, trade: '通用' };
                        if (!PATCH_TERM_LIBRARY.some(i => i.term === kw)) {
                            PATCH_TERM_LIBRARY.push(item);
                        }
                        addedCount++;
                    }
                });
                
                if (addedCount > 0) {
                    localStorage.setItem('patch_term_library_v2', JSON.stringify(PATCH_TERM_LIBRARY));
                    syncTermSet();
                    console.log('已自动添加 ' + addedCount + ' 个关键词到词库:', keywords);
                }
            }
            
            // 执行本地匹配（使用选中的关键词）
            function acDoLocalMatch(keywords) {
                // 显示加载中
                const container = document.getElementById('autoCheck-results');
                container.innerHTML = '<div style="display:flex;align-items:center;gap:12px;padding:20px;color:var(--text-secondary);"><div class="spinner" style="width:20px;height:20px;border:2px solid var(--border);border-top-color:var(--primary);border-radius:50%;animation:spin 0.8s linear infinite;flex-shrink:0;"></div><span>正在使用关键词 [' + keywords.join(', ') + '] 进行匹配...</span></div>';
                container.style.display = 'block';
                
                // 延迟执行，让UI更新
                setTimeout(() => {
                    acPerformMatching(keywords);
                }, 100);
            }
            
            // 实际执行匹配逻辑（调用各模块关键词搜索逻辑）
            function acPerformMatching(keywords) {
                const container = document.getElementById('autoCheck-results');

                // ---------- 检查数据源是否为空 ----------
                const issues = typeof window.getIssueData === 'function' ? window.getIssueData() : [];
                let rules = typeof window.getRulesData === 'function' ? window.getRulesData() : [];
                const handbooks = typeof window.getHandbookData === 'function' ? window.getHandbookData() : [];
                if (issues.length === 0 && rules.length === 0 && handbooks.length === 0) {
                    container.innerHTML = '<div style="text-align:center;padding:24px;color:var(--text-secondary);"><div style="font-size:2rem;margin-bottom:8px;">📭</div><p>检查信息、规章制度、检查手册均为空</p><p style="font-size:0.85rem;margin-top:8px;">请先在对应模块导入数据后再使用自动对规功能</p></div>';
                    container.style.display = 'block'; return;
                }

                // ── 专业推断：同专业规章优先排序（直接用 r.trade 字段） ──
                const _pmQuery = document.getElementById('autoCheck-input') ? document.getElementById('autoCheck-input').value.trim() : '';
                const _pmTrade = patchInferTrade(_pmQuery);
                if (_pmTrade && rules.length > 0) {
                    const sameTrade = rules.filter(function(r) { return r.trade === _pmTrade; });
                    const otherTrade = rules.filter(function(r) { return r.trade !== _pmTrade || !r.trade; });  // 缺失 trade 归入"其他"
                    rules = sameTrade.concat(otherTrade);
                    console.log('[专业过滤] 推断专业:', _pmTrade, '同专业规章数:', sameTrade.length, '其他:', otherTrade.length);
                }

                const lowerKws = keywords.map(function(k) { return k.toLowerCase(); });
                const kwTotal = lowerKws.length;

                // ---------- 匹配检查信息（OR模式 + 权重评分）----------
                // 改进：OR模式（至少命中1个词即可），按命中数量和权重综合排序
                const matchedIssues = issues.map(function(iss) {
                    var text = ((iss.content || '') + ' ' + (iss.category || '') + ' ' + (iss['性质'] || '')).toLowerCase();
                    var matchedKws = lowerKws.filter(function(k) { return text.includes(k); });
                    var matchCount = matchedKws.length;
                    if (matchCount === 0) return null;
                    // 权重评分：术语词命中权重高于行为词
                    var score = 0;
                    matchedKws.forEach(function(k) {
                        var origKw = keywords[lowerKws.indexOf(k)] || k;
                        if (VIOLATION_ACTION_WORDS.has(origKw)) {
                            score += 1.5; // 行为词权重
                        } else if (RAILWAY_TERMS.has(origKw)) {
                            score += 2;   // 术语词权重更高
                        } else {
                            score += 1;   // 其他词
                        }
                    });
                    // 标题/类别命中额外加分
                    var titleText = (iss.category || '').toLowerCase();
                    matchedKws.forEach(function(k) {
                        if (titleText.includes(k)) score += 1;
                    });
                    return { iss: iss, matchCount: matchCount, matchRate: Math.round((matchCount / kwTotal) * 100), score: score };
                }).filter(function(x) { return x !== null; })
                  .sort(function(a, b) { return b.score - a.score || b.matchCount - a.matchCount || b.matchRate - a.matchRate; })
                  .slice(0, 10);

                // ---------- 匹配规章制度（OR模式 + BM25加权）----------
                // 改进：OR模式（段落命中任意关键词即可参与评分），使用BM25加权
                const matchedRules = [];
                rules.forEach(function(r) {
                    if (typeof generateRuleSnippet === 'function') {
                        // 先尝试 AND 模式精确匹配
                        var snippetHtml = generateRuleSnippet(r, keywords, -1, 'and');
                        if (snippetHtml) {
                            var matchScore = typeof calculateMatchScore === 'function' 
                                ? calculateMatchScore(r, keywords, 'and') : 1;
                            matchedRules.push({ rule: r, snippetHtml: snippetHtml, matchScore: matchScore * 3, mode: 'and' });
                        } else {
                            // AND 匹配失败后，尝试 OR 模式宽松匹配
                            snippetHtml = generateRuleSnippet(r, keywords, -1, 'or');
                            if (snippetHtml) {
                                var orScore = typeof calculateMatchScore === 'function' 
                                    ? calculateMatchScore(r, keywords, 'or') : 0.5;
                                // OR 模式按命中关键词比例计算得分
                                var ruleText = (r.content || '').toLowerCase();
                                var hitKws = lowerKws.filter(function(k) { return ruleText.includes(k); });
                                var orWeight = hitKws.length / kwTotal;
                                matchedRules.push({ rule: r, snippetHtml: snippetHtml, matchScore: orScore * orWeight, mode: 'or' });
                            }
                        }
                    } else {
                        // 回退：OR匹配 + 关键词覆盖率评分
                        var text = (r.content || '').toLowerCase();
                        var titleLc = (r.title || '').toLowerCase();
                        var hitCount = 0;
                        lowerKws.forEach(function(k) {
                            if (text.includes(k) || titleLc.includes(k)) hitCount++;
                        });
                        if (hitCount > 0) {
                            matchedRules.push({ rule: r, snippetHtml: null, matchScore: hitCount / kwTotal, mode: 'or' });
                        }
                    }
                });
                // 排序：AND模式优先，同模式按得分排序
                matchedRules.sort(function(a, b) {
                    if (a.mode !== b.mode) return a.mode === 'and' ? 1 : -1; // and 优先
                    return b.matchScore - a.matchScore;
                });
                var scoredRules = matchedRules.slice(0, 10);

                // ---------- 匹配检查手册（分级匹配：核心词AND + 行为词OR）----------
                // 改进：区分术语词（要求AND）和行为词（OR加分）
                var termKws = lowerKws.filter(function(k) {
                    var orig = keywords[lowerKws.indexOf(k)] || k;
                    return RAILWAY_TERMS.has(orig) || orig.length >= 4;
                });
                var actionKws = lowerKws.filter(function(k) {
                    var orig = keywords[lowerKws.indexOf(k)] || k;
                    return VIOLATION_ACTION_WORDS.has(orig);
                });

                var matchedHb = handbooks.map(function(h) {
                    var text = ([h.chapter, h.section, h.item, h.subitem, h.content].filter(Boolean).join(' ')).toLowerCase();
                    // 术语词：AND模式（全部命中为佳）
                    var termHits = termKws.length > 0 ? termKws.filter(function(k) { return text.includes(k); }).length : 0;
                    // 行为词：OR模式（命中任一即加分）
                    var actionHits = actionKws.length > 0 ? actionKws.filter(function(k) { return text.includes(k); }).length : 0;
                    // 总命中
                    var totalHits = lowerKws.filter(function(k) { return text.includes(k); }).length;
                    if (totalHits === 0) return null;

                    // 综合评分：术语覆盖率 * 60% + 行为词命中 * 30% + 总覆盖率 * 10%
                    var termCoverage = termKws.length > 0 ? termHits / termKws.length : 0;
                    var actionBonus = actionKws.length > 0 ? Math.min(1, actionHits / Math.max(1, actionKws.length)) : 0;
                    var overallCoverage = totalHits / kwTotal;
                    var compositeScore = termCoverage * 0.6 + actionBonus * 0.3 + overallCoverage * 0.1;

                    return {
                        hb: h, matchCount: totalHits, matchRate: Math.round(overallCoverage * 100),
                        score: compositeScore,
                        title: [h.chapter, h.section, h.item, h.subitem].filter(Boolean).join(' > ')
                    };
                }).filter(function(x) { return x !== null; })
                  .sort(function(a, b) { return b.score - a.score || b.matchCount - a.matchCount; })
                  .slice(0, 8);

                // ---------- 渲染结果 ----------
                const hasAny = matchedIssues.length || scoredRules.length || matchedHb.length;
                if (!hasAny) {
                    container.innerHTML = '<div style="text-align:center;padding:24px;color:var(--text-secondary);"><div style="font-size:2rem;margin-bottom:8px;">🔍</div><p>未找到匹配内容，建议调整关键词或换用「AI 对规」</p></div>';
                    container.style.display = 'block'; return;
                }

                let html = '';
                const kwsUsed = keywords.map(function(k) {
                    var isAction = VIOLATION_ACTION_WORDS.has(k);
                    var bg = isAction ? '#fecaca;color:#991b1b' : '#fde68a;color:#92400e';
                    var tag = isAction ? '行为' : '术语';
                    return '<span style="background:' + bg + ';padding:1px 6px;border-radius:10px;font-size:0.78rem;" title="' + tag + '">' + acEscHtml(k) + '</span>';
                }).join(' ');
                html += '<div style="margin-bottom:12px;font-size:0.8rem;color:var(--text-secondary);">关键词：' + kwsUsed + '</div>';

                // —— 检查信息匹配结果（检查信息卡片风格）——
                if (matchedIssues.length) {
                    html += '<div style="margin-bottom:6px;">'
                        + '<span style="font-size:0.8rem;font-weight:700;color:#b45309;background:#fef3c7;padding:3px 10px;border-radius:20px;">📂 相似历史案例（' + matchedIssues.length + '条）</span>'
                        + '</div>';
                    html += '<div style="display:flex;flex-direction:column;gap:6px;margin-bottom:14px;">';
                    matchedIssues.forEach(function(x, idx) {
                        const iss = x.iss;
                        const xz = String(iss['性质'] || '').trim();
                        let levelBorderColor = '#718096', xzBg = '#718096';
                        if (xz === 'A类' || xz.includes('A')) { levelBorderColor = '#e53e3e'; xzBg = '#e53e3e'; }
                        else if (xz === '红线' || xz.includes('红线')) { levelBorderColor = '#e53e3e'; xzBg = '#c53030'; }
                        else if (xz === 'B类' || xz.includes('B')) { levelBorderColor = '#d97706'; xzBg = '#d97706'; }
                        else if (xz === 'C类' || xz.includes('C')) { levelBorderColor = '#059669'; xzBg = '#059669'; }
                        // 高亮关键词
                        let contentHtml = acEscHtml(iss.content || '');
                        lowerKws.forEach(function(k) {
                            const reg = new RegExp('(' + k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ')', 'gi');
                            contentHtml = contentHtml.replace(reg, '<span class="highlight">$1</span>');
                        });
                        // OR 模式描述
                        var modeDesc = x.matchCount + '/' + kwTotal + '词命中';
                        html += '<div class="result-card" style="border-left:4px solid ' + levelBorderColor + ';background:#fffbeb;">'
                            + '<div class="match-badge">' + modeDesc + ' 综合分' + Math.round(x.score * 10) / 10 + '</div>'
                            + '<div class="result-header">'
                            + '<span class="tag tag-xingzhi" style="background:' + xzBg + ';color:#fff;">' + acEscHtml(xz || '空白') + '</span>'
                            + '<span class="tag tag-category">' + acEscHtml(iss.category || '其他') + '</span>'
                            + (iss.datetime ? '<span class="tag tag-time">📅 ' + acEscHtml(iss.datetime) + '</span>' : '')
                            + '</div>'
                            + '<div class="result-content"><div class="result-content-header"><button class="btn-copy" onclick="acIssueDetailModal(' + idx + ')">📄 全文</button></div>'
                            + '<div class="result-text">' + contentHtml + '</div></div>'
                            + '</div>';
                    });
                    html += '</div>';
                }

                // —— 规章制度匹配结果 ——
                if (scoredRules.length) {
                    html += '<div style="margin-bottom:6px;">'
                        + '<span style="font-size:0.8rem;font-weight:700;color:#1d4ed8;background:#dbeafe;padding:3px 10px;border-radius:20px;">⚖️ 相关规章条款（' + scoredRules.length + '条）</span>'
                        + '</div>';
                    html += '<div class="result-list" style="margin-bottom:14px;">';
                    // 搜索条件提示
                    var modeLabel = scoredRules.some(function(x) { return x.mode === 'and'; }) ? '优先精确匹配' : '宽松匹配';
                    html += '<div style="margin-bottom:10px;padding:10px 14px;background:#f0f9ff;border:1px solid #bae6fd;border-radius:8px;font-size:0.88rem;color:#0369a1;">'
                        + '<strong>🔍 匹配模式：</strong>'
                        + '<span style="margin-left:6px;padding:3px 8px;background:#fff;border-radius:4px;border:1px solid #7dd3fc;">' + modeLabel + '</span>'
                        + '<span style="margin-left:8px;">' + keywords.map(function(k) { return '<span style="padding:2px 7px;background:#e0f2fe;border-radius:4px;margin-right:3px;">' + acEscHtml(k) + '</span>'; }).join('') + '</span>'
                        + '</div>';
                    scoredRules.forEach(function(x, idx) {
                        const r = x.rule;
                        const rData = typeof window.getRulesData === 'function' ? window.getRulesData() : [];
                        const absIdx = rData.findIndex(function(rr) { return rr === r; });
                        const matchCount = (x.snippetHtml && x.snippetHtml.match(/<p>/g) || []).length;
                        var modeTag = x.mode === 'and' 
                            ? '<span style="color:#059669;font-weight:600;">✓ 精确匹配</span>'
                            : '<span style="color:#d97706;font-weight:600;">◈ 部分匹配</span>';
                        html += '<div class="rule-card-item">';
                        html += '<div class="rule-title" style="cursor:pointer;display:flex;align-items:center;justify-content:space-between;gap:8px;" onclick="' + (absIdx !== -1 ? 'ruleViewFullText(' + absIdx + ')' : 'acRuleDetailModal(' + idx + ')') + '">';
                        html += '<span style="flex:1;word-break:break-all;white-space:normal;color:var(--info);text-decoration:underline;text-underline-offset:3px;" title="' + acEscHtml(r.title || '') + '">' + acEscHtml(r.title || '') + '</span>';
                        html += '<button class="btn btn-info btn-small" style="flex-shrink:0;" onclick="event.stopPropagation();' + (absIdx !== -1 ? 'ruleViewFullText(' + absIdx + ')' : 'acRuleDetailModal(' + idx + ')') + '">📄 查看全文</button>';
                        html += '</div>';
                        if (r.trade) html += '<span class="rule-trade">' + acEscHtml(r.trade) + '</span>';
                        html += '<div class="rule-match-info" style="font-size:0.8rem;color:#64748b;margin-bottom:8px;padding:4px 8px;background:#f1f5f9;border-radius:4px;display:inline-block;">✓ 匹配 ' + matchCount + ' 个段落 &nbsp;' + modeTag + '</div>';
                        html += '<div class="rule-snippet">' + (x.snippetHtml || acEscHtml((r.content || '').slice(0, 200)) + '…') + '</div>';
                        html += '</div>';
                    });
                    html += '</div>';
                }

                // —— 检查手册匹配结果 ——
                if (matchedHb.length) {
                    html += '<div style="margin-bottom:6px;">'
                        + '<span style="font-size:0.8rem;font-weight:700;color:#065f46;background:#d1fae5;padding:3px 10px;border-radius:20px;">📋 检查手册条目（' + matchedHb.length + '条）</span>'
                        + '</div>';
                    html += '<div style="display:flex;flex-direction:column;gap:6px;">';
                    matchedHb.forEach(function(x) {
                        let contentHtml = acEscHtml(x.hb.content || '');
                        lowerKws.forEach(function(k) {
                            const reg = new RegExp('(' + k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ')', 'gi');
                            contentHtml = contentHtml.replace(reg, '<span class="highlight">$1</span>');
                        });
                        var scoreDesc = Math.round(x.score * 100) + '%相关';
                        html += '<div class="result-card" style="border-left:4px solid var(--success);background:#f0fdf4;">'
                            + '<div class="result-header">'
                            + '<span class="tag" style="background:var(--success);color:#fff;">📋 手册</span>'
                            + '<span class="tag" style="color:#065f46;background:#a7f3d0;">' + acEscHtml(x.hb.chapter || '') + '</span>'
                            + '<span style="font-size:0.72rem;color:#065f46;background:#dcfce7;padding:1px 6px;border-radius:10px;">' + scoreDesc + '</span>'
                            + '</div>'
                            + '<div style="font-size:0.8rem;color:#065f46;margin-bottom:4px;font-weight:600;">' + acEscHtml(x.title) + '</div>'
                            + '<div class="result-content"><div class="result-text">' + contentHtml + '</div></div>'
                            + '</div>';
                    });
                    html += '</div>';
                }

                // ── 结果置信度说明 ──
                html += '<div style="margin-top:12px;padding:10px 14px;background:#f8fafc;border-radius:8px;font-size:0.78rem;color:var(--text-secondary);border:1px solid #e2e8f0;">';
                html += '💡 <strong>结果说明：</strong>本地匹配基于关键词检索，仅展示与输入描述相关的内容供参考，不代表最终对规结论。如需精准对规，请使用「AI 对规」功能。';
                html += '</div>';

                container.innerHTML = html;
                container.style.display = 'block';
                window._lastACIssues = matchedIssues;
                window._lastACRules = scoredRules;
            };

            window.acIssueDetailModal = function(idx) {
                const list = window._lastACIssues;
                if (!list || !list[idx]) return;
                const iss = list[idx].iss;
                alert('【检查信息】\n性质：' + (iss['性质'] || '') + '\n类别：' + (iss.category || '') + '\n时间：' + (iss.datetime || '') + '\n\n' + (iss.content || ''));
            };

            window.acRuleDetailModal = function(idx) {
                const list = window._lastACRules;
                if (!list || !list[idx]) return;
                const r = list[idx].rule;
                if (typeof window.ruleViewFullText === 'function') {
                    const rData = typeof window.getRulesData === 'function' ? window.getRulesData() : [];
                    const rIdx = rData.findIndex(function(x) { return x === r; });
                    if (rIdx !== -1) { window.ruleViewFullText(rIdx); return; }
                }
                alert('【规章制度】' + (r.trade ? '（' + r.trade + '）' : '') + '\n' + (r.title || '') + '\n\n' + (r.content || '').replace(/<[^>]+>/g, ''));
            };

            // 向后兼容旧名称
            window.acViewIssueDetail = window.acIssueDetailModal;
            window.acViewRuleDetail = window.acRuleDetailModal;

            // ============================================================
            // BM25 倒排索引与评分
            // ============================================================
            const BM25_K1 = 1.5, BM25_B = 0.75;
            let _bm25Index = null; // 延迟构建

            function bm25Tokenize(text) {
                const tokens = new Set();
                // 第一步：术语感知分词（优先匹配完整术语，避免拆散）
                const lowerText = text.toLowerCase();
                const sortedTerms = Array.from(RAILWAY_TERMS).sort(function(a, b) { return b.length - a.length; });
                var usedRanges = []; // 记录已匹配的字符范围
                sortedTerms.forEach(function(term) {
                    var pos = 0;
                    while (true) {
                        var idx = lowerText.indexOf(term.toLowerCase(), pos);
                        if (idx === -1) break;
                        var end = idx + term.length;
                        // 检查是否与已匹配范围重叠
                        var overlap = usedRanges.some(function(r) { return idx < r[1] && end > r[0]; });
                        if (!overlap) {
                            tokens.add(term.toLowerCase());
                            usedRanges.push([idx, end]);
                        }
                        pos = idx + 1;
                        if (usedRanges.length > 200) break; // 安全限制
                    }
                });
                // 第二步：对未覆盖的文本部分做 N-gram 分词
                // 标记所有已覆盖的位置
                var covered = new Array(text.length).fill(false);
                usedRanges.forEach(function(r) { for (var i = r[0]; i < r[1]; i++) covered[i] = true; });
                // 提取未覆盖的连续中文段落
                var uncovered = '';
                for (var i = 0; i < text.length; i++) {
                    if (!covered[i]) {
                        var ch = text[i];
                        if (/[\u4e00-\u9fa5]/.test(ch)) uncovered += ch;
                        else {
                            // 非中文字符：如果前面有积累的中文，做分词
                            if (uncovered.length >= 2) {
                                for (var len = 2; len <= Math.min(4, uncovered.length); len++) {
                                    for (var j = 0; j <= uncovered.length - len; j++) {
                                        tokens.add(uncovered.slice(j, j + len));
                                    }
                                }
                            }
                            uncovered = '';
                            // 英文/数字 token
                            if (/[a-zA-Z0-9]/.test(ch)) tokens.add(ch.toLowerCase());
                        }
                    } else {
                        if (uncovered.length >= 2) {
                            for (var len = 2; len <= Math.min(4, uncovered.length); len++) {
                                for (var j = 0; j <= uncovered.length - len; j++) {
                                    tokens.add(uncovered.slice(j, j + len));
                                }
                            }
                        }
                        uncovered = '';
                    }
                }
                if (uncovered.length >= 2) {
                    for (var len = 2; len <= Math.min(4, uncovered.length); len++) {
                        for (var j = 0; j <= uncovered.length - len; j++) {
                            tokens.add(uncovered.slice(j, j + len));
                        }
                    }
                }
                // 去停用词
                return Array.from(tokens).filter(function(t) { return !AUTOCHECK_STOP_WORDS.has(t); });
            }

            // 建索引专用极简分词：纯2-gram，不遍历术语集，速度快10倍
            function bm25TokenizeFast(text) {
                const tokens = new Set();
                const t = text.toLowerCase();
                for (let i = 0; i < t.length - 1; i++) {
                    const ch = t[i];
                    if (/[\u4e00-\u9fa5]/.test(ch)) {
                        tokens.add(t.slice(i, i + 2));
                        if (i + 2 < t.length && /[\u4e00-\u9fa5]/.test(t[i+1])) {
                            // 3-gram可选，跳过以保证速度
                        }
                    } else if (/[a-z0-9]/.test(ch)) {
                        tokens.add(ch);
                    }
                }
                return tokens;
            }

            function buildBM25Index(docs) {
                const df = {}, idf = {}, docLens = [], avgLen = { v: 0 };
                const N = docs.length;
                docs.forEach((doc, i) => {
                    // 建索引用快速分词，不遍历术语集，避免大规章库卡顿
                    const tokens = bm25TokenizeFast(doc._text || '');
                    docLens[i] = tokens.size;
                    tokens.forEach(t => { df[t] = (df[t] || 0) + 1; });
                });
                avgLen.v = docLens.reduce((s, l) => s + l, 0) / Math.max(N, 1);
                Object.keys(df).forEach(t => {
                    idf[t] = Math.log((N - df[t] + 0.5) / (df[t] + 0.5) + 1);
                });
                return { docs, df, idf, docLens, avgLen, N };
            }

            function bm25Score(idx, queryTokens, docI) {
                // queryTokens: 预分好的token数组，避免每条规章重复分词
                const qTokens = queryTokens;
                const doc = idx.docs[docI];
                const docText = doc._text || '';
                const dl = idx.docLens[docI];
                const avgDl = idx.avgLen.v;
                let score = 0;
                qTokens.forEach(t => {
                    if (!t) return;
                    const idf = idx.idf[t] || 0;
                    if (idf === 0 && !docText.includes(t)) return; // 快速跳过不可能匹配的token
                    // TF 用出现次数近似
                    let tf = 0;
                    let pos = 0;
                    while ((pos = docText.indexOf(t, pos)) !== -1) { tf++; pos += t.length; }
                    if (tf === 0) return; // 该token未出现，跳过
                    const tfN = (tf * (BM25_K1 + 1)) / (tf + BM25_K1 * (1 - BM25_B + BM25_B * dl / Math.max(avgDl, 1)));
                    score += idf * tfN;
                });
                return score;
            }

            function localBM25Recall(query, topK) {
                topK = topK || 6;
                const rules = typeof window.getRulesData === 'function' ? window.getRulesData() : [];
                if (!rules.length) return [];

                // 【性能优化】彻底放弃BM25索引，改用简单关键词匹配，速度等同本地匹配
                // 提取查询关键词（2字以上中文词）
                const kwSet = new Set();
                const qLower = query.toLowerCase();
                // 提取2-4字中文词组
                for (let i = 0; i < qLower.length - 1; i++) {
                    if (/[\u4e00-\u9fa5]/.test(qLower[i])) {
                        for (let len = 2; len <= Math.min(4, qLower.length - i); len++) {
                            kwSet.add(qLower.slice(i, i + len));
                        }
                    }
                }
                const kws = Array.from(kwSet);
                if (!kws.length) return [];

                const scored = [];
                for (let i = 0; i < rules.length; i++) {
                    const r = rules[i];
                    const text = ((r.title || '') + ' ' + (r.content || '').replace(/<[^>]+>/g, '')).slice(0, 1000).toLowerCase();
                    let s = 0;
                    kws.forEach(k => { if (text.includes(k)) s++; });
                    if (s > 0) scored.push({ i, s });
                }
                const scores = scored.sort((a, b) => b.s - a.s).slice(0, topK);
                return scores.map(x => {
                    const r = rules[x.i];
                    const rawText = (r.content || '').replace(/<[^>]+>/g, '');
                    return {
                        title: r.title || '',
                        trade: r.trade || '',
                        snippet: rawText.slice(0, 220) + (rawText.length > 220 ? '…' : ''),
                        fullText: rawText,
                        score: x.s,
                        ruleRef: r,
                        ruleIdx: x.i
                    };
                });
            }

            // 支持自定义规则库的 BM25 召回（专业优先检索用）
            function localBM25RecallWithRules(query, topK, ruleSubset) {
                if (!ruleSubset || ruleSubset.length === 0) return [];
                topK = topK || 6;
                var kwSet = new Set();
                var qLower = query.toLowerCase();
                for (var i = 0; i < qLower.length - 1; i++) {
                    if (/[\u4e00-\u9fa5]/.test(qLower[i])) {
                        for (var len = 2; len <= Math.min(4, qLower.length - i); len++) {
                            kwSet.add(qLower.slice(i, i + len));
                        }
                    }
                }
                var kws = Array.from(kwSet);
                if (!kws.length) return ruleSubset.slice(0, topK).map(function(r){ return { title: r.title||'', trade: r.trade||'', snippet: (r.content||'').replace(/<[^>]+>/g,'').slice(0,220), fullText: (r.content||'').replace(/<[^>]+>/g,''), score: 0, ruleRef: r, ruleIdx: -1 }; });
                var scored = [];
                for (var j = 0; j < ruleSubset.length; j++) {
                    var r = ruleSubset[j];
                    var text = ((r.title || '') + ' ' + (r.content || '').replace(/<[^>]+>/g, '')).slice(0, 1000).toLowerCase();
                    var s = 0;
                    kws.forEach(function(k){ if (text.indexOf(k) !== -1) s++; });
                    if (s > 0) scored.push({ i: j, s: s });
                }
                var scores = scored.sort(function(a,b){ return b.s - a.s; }).slice(0, topK);
                return scores.map(function(x){
                    var rr = ruleSubset[x.i];
                    var rawText = (rr.content || '').replace(/<[^>]+>/g, '');
                    return { title: rr.title||'', trade: rr.trade||'', snippet: rawText.slice(0,220)+(rawText.length>220?'…':''), fullText: rawText, score: x.s, ruleRef: rr, ruleIdx: -1 };
                });
            }

            // ============================================================
            // 同义词映射表（可通过 importSynonyms 扩展）
            // ============================================================
            const SYNONYM_MAP = {
                '天窗': ['封闭时间', '施工时间', '施工窗口'],
                '防护': ['防护员', '安全防护', '设防护', '防护措施'],
                '上道': ['上轨道', '进入线路', '进线作业', '上线路'],
                '违规': ['违章', '违反规定', '不符合规定', '不按规定', '违章作业', '违章行为'],
                '超限': ['超出限界', '限界超限'],
                '信号机': ['信号灯', '信号设备'],
                '道岔': ['转辙器', '岔道'],
                '行车': ['行驶', '运行', '列车运行'],
                '防溜': ['防止溜逸', '止溜', '防溜措施'],
                '闭塞': ['闭塞区间', '区间闭塞'],
                '限速': ['限制速度', '降速'],
                '接触网': ['供电线路', '架空线'],
                '作业人员': ['工作人员', '施工人员', '作业者', '现场人员'],
                '检查': ['巡查', '巡检', '查看', '核查'],
                '列车': ['火车', '机车', '车列'],
                '铁路': ['铁道', '轨道线路'],
                '违章': ['违规', '违反规定', '违章作业'],
                '未设置': ['未设', '未配备', '未安装', '缺少'],
                '擅自': ['未经允许', '未经批准', '私自', '未经许可'],
                '未确认': ['未核实', '未检查', '未核对'],
                '制动': ['刹车', '制动系统'],
                '瞭望': ['观察', '了望', '眺望'],
                '调车': ['编组调车', '调车作业'],
                '施工': ['施工作业', '维修作业', '作业施工'],
                '封锁': ['线路封锁', '区间封锁', '施工封锁'],
                '命令': ['调度命令', '行车命令', '作业命令'],
                '进路': ['行车进路', '列车进路'],
                '联控': ['车机联控', '呼唤应答'],
            };

            function expandQueryWithSynonyms(query) {
                let expanded = query;
                Object.entries(SYNONYM_MAP).forEach(([key, syns]) => {
                    if (query.includes(key)) {
                        syns.forEach(s => { if (!expanded.includes(s)) expanded += ' ' + s; });
                    }
                    syns.forEach(s => {
                        if (query.includes(s) && !expanded.includes(key)) expanded += ' ' + key;
                    });
                });
                return expanded;
            }

            // ============================================================
            // 从历史案例中提取已有的对规条款引用（案例派生候选库）
            // 【2026-04-27优化】正则提取 + 降级策略（原文兜底）
            // ============================================================
            function extractCandidatesFromIssues(query, topK) {
                topK = topK || 4;
                const startTime = Date.now();
                
                console.log(`【历史案例召回】开始处理，查询: "${query}", topK: ${topK}`);
                
                const cachedIssues = window._lastACIssues;
                if (!cachedIssues || !cachedIssues.length) {
                    console.warn('【历史案例召回】无本地匹配缓存，返回空');
                    return [];
                }
                
                console.log('【历史案例召回】使用本地匹配缓存结果，共', cachedIssues.length, '条');
                
                const issuesToProcess = cachedIssues.slice(0, topK);
                const result = [];
                
                for (let index = 0; index < issuesToProcess.length; index++) {
                    const { iss, score } = issuesToProcess[index];
                    
                    let fullText = iss.content || '';
                    if (fullText.length > 2000) fullText = fullText.slice(0, 2000);
                    
                    // ── 策略1：正则提取标准格式条款 ──
                    // 格式：不符合《XXX》（文件编号）第X条第X款"内容"的规定
                    let extracted = false;
                    try {
                        const pattern = /《([^》]{2,60})》（[^）]{5,40}号）第([\d一二三四五六七八九十百千]+条(?:第[\d一二三四五六七八九十]+款)?)[\u0022\u201C\u201D]([^\u0022\u201C\u201D]{15,300})[\u0022\u201C\u201D]/g;
                        let m;
                        while ((m = pattern.exec(fullText)) !== null) {
                            const title = (m[1] || '').trim();
                            const article = (m[3] || '').trim();
                            const clause = (m[4] || '').trim();
                            if (!title || !article || !clause) continue;
                            
                            result.push({
                                title: title,
                                fileNumber: (m[2] || '').trim(),
                                article: article,
                                snippet: '"' + clause + '"',
                                fullText: clause,
                                score: score,
                                source: 'issue',
                                issueCount: 1,
                                issueRefs: [{
                                    category: iss.category || '',
                                    nature: iss['性质'] || '',
                                    snippet: fullText.slice(0, 120),
                                    matchScore: score
                                }],
                                ruleRef: null
                            });
                            extracted = true;
                            console.log(`【历史案例召回】正则提取: 《${title}》第${article}`);
                            break; // 每条案例最多取1个
                        }
                    } catch(e) {
                        console.warn(`【历史案例召回】正则处理案例${index+1}出错:`, e.message);
                    }
                    
                    // ── 策略2（降级）：正则没匹配到，直接取案例原文作为参考 ──
                    if (!extracted) {
                        const category = iss.category || iss['类别'] || '';
                        const nature = iss['性质'] || '';
                        // 取原文前500字作为摘要
                        const summary = fullText.slice(0, 500);
                        
                        result.push({
                            title: '历史案例参考',
                            fileNumber: '',
                            article: '',
                            snippet: (category ? '[' + category + '] ' : '') + (nature ? '[' + nature + '] ' : '') + summary,
                            fullText: summary,
                            score: score,
                            source: 'issue',
                            issueCount: 1,
                            issueRefs: [{
                                category: category,
                                nature: nature,
                                snippet: fullText.slice(0, 120),
                                matchScore: score
                            }],
                            ruleRef: null
                        });
                        console.log(`【历史案例召回】降级取原文: 案例${index+1}, 匹配度${Math.round(score*100)}%, ${category||nature||'无类别'}`);
                    }
                    
                    if (result.length >= topK) break;
                }
                
                console.log(`【历史案例召回】完成，耗时: ${Date.now() - startTime}ms，提取到 ${result.length} 条`);
                return result;
            }

            // ============================================================
            // 本地验证 AI 输出条款（支持案例来源）
            // ============================================================
            function validateAIOutput(aiText, ruleCandidates, issueCandidates) {
                issueCandidates = issueCandidates || [];
                // 【关键修改】不再合并规章库候选，只验证案例库
                // const allCandidates = (ruleCandidates || []).concat(issueCandidates);

                const titlePattern = /《([^》]+)》/g;
                // 【修复】使用 Unicode 转义匹配中英文引号
                const clausePattern = /[\u0022\u201C\u201D]([^\u0022\u201C\u201D]{10,})[\u0022\u201C\u201D]/g;

                const aiTitles = [];
                let m;
                while ((m = titlePattern.exec(aiText)) !== null) aiTitles.push(m[1]);
                const aiClauses = [];
                while ((m = clausePattern.exec(aiText)) !== null) aiClauses.push(m[1]);

                if (aiTitles.length === 0) {
                    return { confidence: 'low', details: [], summary: '未提取到规章引用' };
                }

                const details = [];
                
                // 【增强】提取AI输出中的条款编号（第X条第X款）
                const articlePattern = /第([\d一二三四五六七八九十百千\.]+条(?:第[\d一二三四五六七八九十]+款)?)/g;
                const aiArticles = [];
                let m2;
                while ((m2 = articlePattern.exec(aiText)) !== null) aiArticles.push(m2[1]);
                
                aiTitles.forEach((title, i) => {
                    const clause = aiClauses[i] || '';
                    const article = aiArticles[i] || ''; // 对应的条款编号
                    
                    // 【加强】更宽松的标题清洗：移除所有标点、空格、特殊字符，同时移除文件编号（括号内容）
                    const cleanTitle = t => t.replace(/（[^）]+）/g, '').replace(/[《》\s。，、；：""''（）()\[\]【】]/g, '').toLowerCase();
                    
                    // 【增强】标准化条款编号（统一转换为阿拉伯数字）
                    const normalizeArticle = art => {
                        if (!art) return '';
                        const cnNums = { '一':1, '二':2, '三':3, '四':4, '五':5, '六':6, '七':7, '八':8, '九':9, '十':10, '百':100, '千':1000 };
                        let normalized = art.replace(/[第条款]/g, '');
                        // 将中文数字转换为阿拉伯数字（简化处理）
                        normalized = normalized.replace(/[一二三四五六七八九十百千]+/g, match => {
                            // 简单转换：直接返回原字符串，主要用于比较
                            return match;
                        });
                        return normalized.toLowerCase();
                    };
                    const aiArticleNorm = normalizeArticle(article);

                    // 【关键修改】优先在案例候选中找（不再验证规章库）
                    // 【加强】使用更宽松的匹配策略
                    let issueMatched = issueCandidates.find(c => {
                        const ct = cleanTitle(c.title), at = cleanTitle(title);
                        // 完全匹配或包含匹配
                        return ct === at || ct.includes(at) || at.includes(ct);
                    });
                    
                    // 【增强】如果标题匹配，进一步验证条款编号是否一致
                    if (issueMatched && article) {
                        const caseArticleNorm = normalizeArticle(issueMatched.article);
                        // 如果AI有条款编号但案例中没有，或者编号不一致，记录警告
                        if (caseArticleNorm && aiArticleNorm !== caseArticleNorm) {
                            console.log('【验证警告】标题匹配但条款编号不一致：', 
                                'AI:', title, article, 
                                '案例:', issueMatched.title, issueMatched.article);
                        }
                    }
                    
                    // 如果没找到，尝试更宽松的匹配（前6个字符相同）
                    if (!issueMatched) {
                        issueMatched = issueCandidates.find(c => {
                            const ct = cleanTitle(c.title), at = cleanTitle(title);
                            // 前6个字符相同（对于长标题）
                            return ct.length >= 6 && at.length >= 6 && ct.slice(0, 6) === at.slice(0, 6);
                        });
                    }
                    
                    // 【终极容错】提取核心关键词进行匹配（至少3个关键词匹配）
                    if (!issueMatched) {
                        const extractKeywords = t => {
                            // 提取有意义的词（长度>=2的中文词）
                            const words = [];
                            for (let i = 0; i < t.length - 1; i++) {
                                const twoChar = t.slice(i, i + 2);
                                if (/[\u4e00-\u9fa5]{2}/.test(twoChar)) {
                                    words.push(twoChar);
                                }
                            }
                            return words;
                        };
                        const aiWords = extractKeywords(cleanTitle(title));
                        issueMatched = issueCandidates.find(c => {
                            const ct = cleanTitle(c.title);
                            const caseWords = extractKeywords(ct);
                            // 计算共同词的数量
                            const commonWords = aiWords.filter(w => caseWords.includes(w));
                            // 如果共同词数量>=3，或者共同词占AI词的一半以上
                            return commonWords.length >= 3 || (aiWords.length > 0 && commonWords.length / aiWords.length >= 0.5);
                        });
                    }
                    
                    // 调试日志
                    if (!issueMatched) {
                        console.log('【验证失败】AI标题:', title, '清洗后:', cleanTitle(title));
                        console.log('【验证失败】可用案例标题:', issueCandidates.map(c => ({title: c.title, clean: cleanTitle(c.title)})));
                    } else {
                        console.log('【验证成功】AI标题:', title, '匹配到案例:', issueMatched.title);
                    }

                    // 案例库命中 → 高置信度
                    if (issueMatched) {
                        details.push({
                            title, clause: clause.slice(0, 60),
                            status: 'matched',  // 案例匹配视为 matched
                            source: 'issue',
                            matchedRule: issueMatched.title,
                            issueCount: issueMatched.issueCount || 1,
                            issueRefs: issueMatched.issueRefs || [],
                            label: '✅ 案例已核实（' + (issueMatched.issueCount || 1) + '次引用）'
                        });
                    } else {
                        // 未在匹配案例中找到
                        details.push({ 
                            title, 
                            clause: clause.slice(0, 60), 
                            status: 'unmatched', 
                            source: 'none', 
                            matchedRule: '', 
                            label: '❌ 未在匹配案例中找到，建议人工核查' 
                        });
                    }
                });

                // 【关键修改】置信度评级：案例匹配 = 高置信度
                const issueMatched = details.filter(d => d.source === 'issue').length;
                const unmatched   = details.filter(d => d.source === 'none').length;
                const total = details.length;

                let confidence = 'low';
                // 全部来自案例匹配 → 高置信度
                if (total > 0 && unmatched === 0) confidence = 'high';
                // 部分匹配 → 中置信度
                else if (total > 0 && issueMatched / total >= 0.5) confidence = 'medium';

                const summary = `验证${total}条：案例核实${issueMatched}条，未找到${unmatched}条`;
                return { confidence, details, summary };
            }

            // ============================================================
            // AI 对规：BM25召回 + AI精排 + 本地验证
            // ============================================================
            // ── 计算历史案例匹配相似度（0-100） ──
            function calcIssueMaxSimilarity(query) {
                const issues = typeof window.getIssueData === 'function' ? window.getIssueData() : [];
                if (!issues.length) return 0;
                const qWords = bm25Tokenize(query);
                if (!qWords.length) return 0;
                let maxScore = 0;
                issues.forEach(iss => {
                    const text = ((iss.content || '') + ' ' + (iss.category || '')).toLowerCase();
                    const hitCount = qWords.filter(w => text.includes(w)).length;
                    const score = Math.round((hitCount / qWords.length) * 100);
                    if (score > maxScore) maxScore = score;
                });
                return maxScore;
            }

            // ── 使用指定关键词计算历史案例匹配相似度（与本地匹配一致） ──
            function calcIssueMaxSimilarityWithKeywords(query, keywords) {
                const issues = typeof window.getIssueData === 'function' ? window.getIssueData() : [];
                if (!issues.length || !keywords.length) return 0;
                const lowerKws = keywords.map(k => k.toLowerCase());
                let maxScore = 0;
                issues.forEach(iss => {
                    const text = ((iss.content || '') + ' ' + (iss.category || '') + ' ' + (iss['性质'] || '')).toLowerCase();
                    const matchCount = lowerKws.filter(k => text.includes(k)).length;
                    const score = Math.round((matchCount / lowerKws.length) * 100);
                    if (score > maxScore) maxScore = score;
                });
                return maxScore;
            }

            window.autoCheckAI = async function() {
                const input = document.getElementById('autoCheck-input');
                const query = input.value.trim();
                if (!query) { alert('请输入检查问题描述'); return; }
                var apiKey = localStorage.getItem('ds_api_key_v1') || '';
                if (!apiKey) {
                    const ok = confirm('未配置 DeepSeek API Key，是否打开 API 配置？\n点击确定打开配置弹窗，点击取消则改用本地匹配。');
                    if (ok) window.showApiConfigModal();
                    else window.autoCheckLocal();
                    return;
                }

                const container = document.getElementById('autoCheck-results');
                container.style.display = 'block';

                // ══ 第一步：先核对本地匹配相似历史案例 ══
                // 使用与本地匹配一致的关键词计算相似度
                const keywords = Array.from(acSelectedKeywords).length > 0
                    ? Array.from(acSelectedKeywords)
                    : acExtractKeywords(query, patchInferTrade(query));
                const maxSimilarity = calcIssueMaxSimilarityWithKeywords(query, keywords);

                // ── 相似度低于35，提示重新调整关键词 ──
                if (maxSimilarity < 35) {
                    const kwsHtml = keywords.map(k =>
                        '<span style="background:#fde68a;color:#92400e;padding:2px 8px;border-radius:10px;font-size:0.82rem;cursor:pointer;border:1px solid #f59e0b;" onclick="acToggleCandidateKeyword(\'' + acEscHtml(k) + '\')">' + acEscHtml(k) + ' ✕</span>'
                    ).join('');
                    container.innerHTML = '<div style="padding:16px;background:#fffbeb;border-radius:10px;border-left:4px solid #f59e0b;">'
                        + '<div style="font-weight:700;color:#b45309;font-size:0.95rem;margin-bottom:8px;">⚠️ 本地历史案例匹配相似度较低（' + maxSimilarity + '%，低于35%）</div>'
                        + '<div style="font-size:0.85rem;color:#92400e;margin-bottom:10px;">当前关键词可能不够准确，请核查是否合理，可点击关键词移除：</div>'
                        + '<div style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:12px;">' + (kwsHtml || '<span style="color:#999;">未识别到关键词</span>') + '</div>'
                        + '<div style="font-size:0.82rem;color:#78350f;margin-bottom:12px;">👆 请在上方输入框修改问题描述或手动调整关键词后，再次执行本地匹配；<br>如确认关键词无误，可点击"继续AI对规"直接由AI从规章库自动查找。</div>'
                        + '<div style="display:flex;gap:8px;flex-wrap:wrap;">'
                        + '<button class="btn btn-primary btn-small" onclick="window.autoCheckLocal();document.getElementById(\'autoCheck-smartBtn\').dataset.state=\'ai\';">🔍 重新本地匹配</button>'
                        + '<button class="btn btn-warning btn-small" onclick="window.autoCheckAI_force();">🤖 继续AI对规（跳过相似度检查）</button>'
                        + '</div>'
                        + '</div>';
                    return;
                }

                // ── 相似度达标，继续AI对规流程 ──
                await window.autoCheckAI_force();
            };

            window.autoCheckAI_force = async function() {
                const input = document.getElementById('autoCheck-input');
                const query = input.value.trim();
                if (!query) { alert('请输入检查问题描述'); return; }
                var apiKey = localStorage.getItem('ds_api_key_v1') || '';
                const apiUrl = localStorage.getItem(DS_API_URL_STORAGE) || DS_DEFAULT_API_URL;
                const model  = localStorage.getItem(DS_MODEL_STORAGE) || DS_DEFAULT_MODEL;


                const container = document.getElementById('autoCheck-results');
                container.innerHTML = '<div style="display:flex;align-items:center;gap:12px;padding:20px;color:var(--text-secondary);"><div class="spinner" style="width:20px;height:20px;border:2px solid var(--border);border-top-color:var(--primary);border-radius:50%;animation:spin 0.8s linear infinite;flex-shrink:0;"></div><span>⏳ 正在召回候选条款…</span></div>';
                container.style.display = 'block';

                // ── 阶段0：检查本地匹配缓存，如果没有则提示用户先执行本地匹配 ──
                if (!window._lastACIssues || !window._lastACIssues.length) {
                    console.warn('[AI对规] _lastACIssues 为空，需要先执行本地匹配');
                    container.innerHTML = '<div style="padding:16px;color:var(--warning);background:#fffbeb;border-radius:10px;border-left:4px solid #f59e0b;">'
                        + '<div style="font-weight:700;color:#b45309;font-size:0.95rem;margin-bottom:8px;">⚠️ 历史案例缓存为空</div>'
                        + '<div style="font-size:0.85rem;color:#92400e;margin-bottom:10px;">系统包含3万+历史案例数据，直接扫描会导致时间过长。请先执行以下步骤：</div>'
                        + '<div style="font-size:0.85rem;color:#92400e;margin-bottom:12px;">'
                        + '1. 在输入框中填写检查问题描述<br>'
                        + '2. 点击「🔍 本地匹配」按钮<br>'
                        + '3. 系统会根据关键词筛选相关案例<br>'
                        + '4. 成功匹配后，再点击「🤖 AI 对规」按钮'
                        + '</div>'
                        + '<div style="display:flex;gap:8px;flex-wrap:wrap;">'
                        + '<button class="btn btn-primary btn-small" onclick="window.autoCheckLocal();document.getElementById(\'autoCheck-smartBtn\').dataset.state=\'ai\';">🔍 执行本地匹配</button>'
                        + '<button class="btn btn-secondary btn-small" onclick="window.clearAutoCheck();">🔄 重置</button>'
                        + '</div>'
                        + '</div>';
                    return; // 直接返回，不再继续执行
                }

                // ── 阶段1：双路召回 (BM25 + 历史案例) ──
                // 每步 await setTimeout(0) 让浏览器先渲染提示，再执行同步计算
                let expandedQuery, ruleCandidates, issueCandidates;
                try {
                    container.innerHTML = '<div style="padding:16px;color:var(--text-secondary);">⏳ 正在扩展查询同义词…</div>';
                    await new Promise(r => setTimeout(r, 0));
                    expandedQuery = expandQueryWithSynonyms(query);
                    console.log('[AI对规] 扩展后查询:', expandedQuery);

                    container.innerHTML = '<div style="padding:16px;color:var(--text-secondary);">⏳ 正在从规章库召回候选条款…</div>';
                    await new Promise(r => setTimeout(r, 0));

                    // ----- 专业优先检索 -----
                    var allRules = typeof window.getRulesData === 'function' ? window.getRulesData() : [];
                    ruleCandidates = [];
                    var inferredTrade = patchInferTrade(query);

                    if (inferredTrade && allRules.length > 0) {
                        // 1. 过滤出同专业规章
                        var sameTradeRules = allRules.filter(function(r){ return r.trade === inferredTrade; });
                        console.log('[专业优先] 推断专业: ' + inferredTrade + ', 同专业规章数: ' + sameTradeRules.length);

                        if (sameTradeRules.length > 0) {
                            var sameTradeCandidates = localBM25RecallWithRules(expandedQuery, 6, sameTradeRules);
                            ruleCandidates.push.apply(ruleCandidates, sameTradeCandidates);
                            console.log('[专业优先] 同专业召回 ' + sameTradeCandidates.length + ' 条');
                        }

                        // 2. 如果同专业召回不足 6 条，再从其他专业补充
                        if (ruleCandidates.length < 6) {
                            var otherRules = allRules.filter(function(r){ return r.trade !== inferredTrade; });
                            if (otherRules.length > 0) {
                                var otherCandidates = localBM25RecallWithRules(expandedQuery, 6 - ruleCandidates.length, otherRules);
                                ruleCandidates.push.apply(ruleCandidates, otherCandidates);
                                console.log('[补充召回] 其他专业补充 ' + otherCandidates.length + ' 条');
                            }
                        }
                    } else {
                        // 未推断出专业，走原逻辑
                        ruleCandidates = localBM25Recall(expandedQuery, 6);
                    }

                    console.log('[AI对规] 最终规章库召回', ruleCandidates.length, '条');

                    container.innerHTML = '<div style="padding:16px;color:var(--text-secondary);">⏳ 正在从历史案例召回候选条款…</div>';
                    await new Promise(r => setTimeout(r, 0));
                    issueCandidates = extractCandidatesFromIssues(query, 4);
                    console.log('[AI对规] 历史案例召回', issueCandidates.length, '条');
                } catch (e) {
                    console.error('[AI对规] 召回候选条款异常:', e);
                    var _escErr = typeof window.escapeHtml === 'function' ? window.escapeHtml : function(s){return String(s).replace(/</g,'&lt;');};
                    container.innerHTML = '<div style="padding:16px;color:#dc2626;background:#fef2f2;border-radius:8px;border-left:4px solid #ef4444;"><strong>❌ 召回候选条款失败：' + _escErr(e.message) + '</strong><br><span style="font-size:0.82rem;color:#991b1b;">' + _escErr((e.stack||'').slice(0,500)) + '</span></div>';
                    return;
                }

                if (!ruleCandidates.length && !issueCandidates.length) {
                    container.innerHTML = '<div style="padding:16px;color:#d97706;background:#fffbeb;border-radius:8px;border-left:4px solid #fcd34d;"><strong>⚠️ 规章库与历史案例均为空</strong><br>请先导入数据，已切换为本地匹配模式。</div>';
                    setTimeout(() => window.autoCheckLocal(), 800);
                    return;
                }

                console.log('[AI对规] 阶段2：构建候选映射表，规章', ruleCandidates.length, '条，案例', issueCandidates.length, '条');

                // ── 阶段2：构建全局候选映射表（ID → 完整条款） ──
                _globalCandidatesMap = {};
                let idCounter = 0;
                const allCandidates = [];

                // ── 从案例全文中提取规章引用部分 ──
                function extractRegulationQuote(text) {
                    if (!text) return '';
                    // 匹配"不符合/违反《...》...的要求/的规定/的约束"格式
                    var m = text.match(/(?:不符合|违反)《[^》]*》[^。]*?(?:的要求|的规定|的约束)/);
                    if (m) return m[0];
                    // 降级：匹配"不符合/违反《...》...。"整句
                    m = text.match(/(?:不符合|违反)《[^》]*》[^。]*。/);
                    if (m) return m[0];
                    // 再降级：匹配"《...》...的要求/的规定"
                    m = text.match(/《[^》]*》[^。]*?(?:的要求|的规定|的约束)/);
                    if (m) return m[0];
                    // 兜底：截取前200字
                    return text.length > 200 ? text.slice(0, 200) + '…' : text;
                }

                issueCandidates.forEach(c => {
                    const id = 'cand_' + (idCounter++);
                    const rawClause = c.snippet || c.fullText || '';
                    _globalCandidatesMap[id] = {
                        id, source: 'issue',
                        title: c.title || '',
                        fileNumber: c.fileNumber || '',
                        article: c.article || '',
                        clause: extractRegulationQuote(rawClause),
                        rawClause: rawClause,  // 保留原文供参考
                        issueCount: c.issueCount || 1,
                        score: c.score || 0
                    };
                    allCandidates.push(id);
                });
                ruleCandidates.forEach(c => {
                    const id = 'cand_' + (idCounter++);
                    _globalCandidatesMap[id] = {
                        id, source: 'rule',
                        title: c.title || '',
                        fileNumber: c.fileNumber || '',
                        article: c.article || '',
                        clause: c.snippet || c.content || ''
                    };
                    allCandidates.push(id);
                });

                // ── 阶段3：专业推断 + 重排候选 + AI挑选ID ──
                const _aiTrade = patchInferTrade(query);
                // 同专业的规章库候选排到前面（直接用 trade 字段）
                if (_aiTrade) {
                    ruleCandidates.sort(function(a, b) {
                        const aMatch = a.trade === _aiTrade;
                        const bMatch = b.trade === _aiTrade;
                        if (aMatch && !bMatch) return -1;
                        if (!aMatch && bMatch) return 1;
                        return 0;
                    });
                    console.log('[专业指引] 推断专业:', _aiTrade, '已对规章库候选按 trade 字段重排');
                }

                const sysPrompt = [
                    '你是铁路安监对规专家。请从以下候选条款列表中，挑选与检查问题最相关的1-3个条款ID。',
                    '【输出要求】只输出一个合法JSON对象，禁止使用代码块（```），禁止任何说明文字。',
                    '【correctedQuery】输出完整的问题描述原文（不要省略）。',
                    _aiTrade ? '【专业指引】本次问题推断涉及"' + _aiTrade + '"专业，请优先选用该专业规章条款。' : '',
                    '示例：{"correctedQuery":"机车备品管理问题","selectedIds":["cand_0","cand_2"],"reason":"备品不符"}',
                    '',
                    '候选条款列表：',
                    allCandidates.map(id => {
                        const c = _globalCandidatesMap[id];
                        const src = c.source === 'issue' ? '[案例]' : '[规章库]';
                        let line = '[' + id + '] ' + src;
                        if (c.title) line += '《' + c.title + '》';
                        if (c.fileNumber) line += '（' + c.fileNumber + '）';
                        if (c.article)  line += ' 第' + c.article + '条';
                        if (c.clause)   line += ' "' + c.clause.slice(0, 200) + '"';
                        return line;
                    }).join('\n'),
                    '',
                    '如果所有候选均不相关，selectedIds 返回空数组 []。'
                ].join('\n');

                container.innerHTML = '<div style="display:flex;align-items:center;gap:12px;padding:20px;color:var(--text-secondary);"><div class="spinner" style="width:20px;height:20px;border:2px solid var(--border);border-top-color:var(--primary);border-radius:50%;animation:spin 0.8s linear infinite;flex-shrink:0;"></div><span>🤖 AI 正在筛选最佳条款（强约束模式）…</span></div>';

                console.log('[AI对规] 阶段3：发送AI请求，候选', allCandidates.length, '个，模型:', model);

                try {
                    window._dsAbortController = new AbortController();
                    console.log('[AI对规] fetch 开始...', apiUrl);
                    const resp = await fetch(apiUrl, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + apiKey },
                        body: JSON.stringify({
                            model: model,
                            messages: [
                                { role: 'system', content: sysPrompt },
                                { role: 'user', content: '检查问题：' + query }
                            ],
                            temperature: 0.0,
                            max_tokens: 1024,
                            stream: false
                        }),
                        signal: window._dsAbortController.signal
                    });

                    console.log('[AI对规] fetch 响应:', resp.status, resp.ok);

                    if (!resp.ok) {
                        const hints = { 401:'API Key 无效', 402:'账户余额不足', 403:'无访问权限', 429:'请求过于频繁' };
                        throw new Error(hints[resp.status] || 'HTTP ' + resp.status);
                    }

                    const data = await resp.json();
                    const rawText = (data.choices[0].message.content || '').trim();

                    // 提取JSON（多重容错）
                    let aiJson;
                    let parseErr = '';
                    (function tryParse() {
                        // 1. ```json ... ``` 包裹
                        const m1 = rawText.match(/```json\s*([\s\S]*?)\s*```/);
                        if (m1) { try { aiJson = JSON.parse(m1[1]); return; } catch(e) { parseErr = e.message; } }
                        // 2. ``` ... ``` 包裹（无 json 标识）
                        const m2 = rawText.match(/```\s*([\s\S]*?)\s*```/);
                        if (m2) { try { aiJson = JSON.parse(m2[1]); return; } catch(e) { parseErr = e.message; } }
                        // 3. 裸 JSON 提取
                        const start = rawText.indexOf('{');
                        const end   = rawText.lastIndexOf('}');
                        if (start !== -1 && end > start) {
                            let jsonStr = rawText.slice(start, end + 1);
                            try { aiJson = JSON.parse(jsonStr); return; } catch(e) { parseErr = e.message; }
                            // 4. 末尾逗号容错
                            const fixed = jsonStr.replace(/,(\s*[}\]])/g, '$1');
                            try { aiJson = JSON.parse(fixed); return; } catch(e) { parseErr = e.message; }
                            // 5. 截断补全（含未闭合字符串修复）
                            let r = fixed;
                            // 5a. 检测并修复未闭合的字符串（最常见截断场景）
                            const quotes = r.match(/"/g) || [];
                            if (quotes.length % 2 !== 0) {
                                // 奇数个引号 → 最后一个字符串未闭合，补上闭合引号
                                r += '"';
                            }
                            // 5b. 补全括号
                            const oB = (r.match(/\{/g)||[]).length;
                            const cB = (r.match(/\}/g)||[]).length;
                            const oS = (r.match(/\[/g)||[]).length;
                            const cS = (r.match(/\]/g)||[]).length;
                            for(let i=0;i<oS-cS;i++) r += ']';
                            for(let i=0;i<oB-cB-1;i++) r += '}';
                            r += '}';
                            try { aiJson = JSON.parse(r); return; } catch(e) { parseErr='截断修复: '+e.message; }
                        }
                        // 6. 直接解析整段
                        try { aiJson = JSON.parse(rawText); } catch(e) { parseErr = e.message; }
                    })();
                    if (!aiJson || typeof aiJson !== 'object') {
                        console.warn('[autoCheckAI] 解析失败，原始返回：', rawText, '  错误：', parseErr);
                        throw new Error('AI返回格式异常（' + parseErr + '），已切换本地匹配');
                    }
                    // selectedIds 容错：允许字符串"cand_0,cand_1"或数组
                    if (typeof aiJson.selectedIds === 'string') {
                        aiJson.selectedIds = aiJson.selectedIds.split(/[,，\s]+/).map(s => s.trim()).filter(Boolean);
                    }

                    const { correctedQuery, selectedIds, reason } = aiJson;
                    const validIds = (selectedIds || []).filter(id => _globalCandidatesMap[id]);

                    // ── 本地拼装结论（100%来自映射表，不依赖AI原文）──
                    const issueSelected = validIds.filter(id => _globalCandidatesMap[id].source === 'issue');
                    const ruleSelected  = validIds.filter(id => _globalCandidatesMap[id].source === 'rule');
                    const hasIssueSel = issueSelected.length > 0;
                    const hasRuleSel  = ruleSelected.length > 0;

                    // ── 来源提示（区分三种情况） ──
                    let sourceTipHtml = '';
                    if (hasIssueSel && hasRuleSel) {
                        sourceTipHtml = '<div style="display:flex;align-items:center;gap:8px;padding:8px 12px;background:#f0fdf4;border-radius:8px;border:1px solid #86efac;margin-bottom:10px;font-size:0.82rem;color:#15803d;"><span>📋</span><span>本次对规参考了 <strong>' + issueCandidates.length + ' 条历史案例</strong> 和 <strong>' + ruleCandidates.length + ' 条规章库条款</strong>，AI从中选取了最相关的条款。</span></div>';
                    } else if (hasIssueSel) {
                        sourceTipHtml = '<div style="display:flex;align-items:center;gap:8px;padding:8px 12px;background:#f0fdf4;border-radius:8px;border:1px solid #86efac;margin-bottom:10px;font-size:0.82rem;color:#15803d;"><span>📋</span><span>本次对规参考了 <strong>' + issueCandidates.length + ' 条匹配历史案例</strong>，条款来源已验证。</span></div>';
                    } else {
                        sourceTipHtml = '<div style="display:flex;align-items:center;gap:8px;padding:8px 12px;background:#fef3c7;border-radius:8px;border:1px solid #fcd34d;margin-bottom:10px;font-size:0.82rem;color:#92400e;"><span>⚠️</span><span>未找到历史案例，已从规章库检索，请人工核实。</span></div>';
                    }

                    // ── 对规结论（分区展示：案例条款 + 规章库条款） ──
                    let conclusionHtml = '';
                    if (validIds.length === 0) {
                        conclusionHtml = '<p style="color:#d97706;padding:8px 0;">⚠️ 所有候选条款均不相关，建议人工核查或调整描述。</p>';
                    } else {
                        // 案例条款区域（绿色）
                        if (issueSelected.length > 0) {
                            conclusionHtml += '<div style="margin-bottom:6px;"><span style="font-size:0.78rem;font-weight:700;color:#15803d;background:#dcfce7;padding:3px 10px;border-radius:20px;">📋 历史案例中的规章引用</span></div>';
                            issueSelected.forEach((id, idx) => {
                                const c = _globalCandidatesMap[id];
                                conclusionHtml += '<div style="margin-bottom:10px;padding:12px;background:#f0fdf4;border-radius:8px;border-left:3px solid #16a34a;">'
                                    + '<div style="font-weight:700;color:#166534;margin-bottom:6px;">'
                                    + (idx+1) + '. 不符合/违反《' + acEscHtml(c.title) + '》'
                                    + (c.fileNumber ? '（' + acEscHtml(c.fileNumber) + '）' : '')
                                    + (c.article ? ' 第' + acEscHtml(c.article) + '条' : '')
                                    + '<span style="font-size:0.68rem;background:#dcfce7;color:#166534;padding:1px 6px;border-radius:8px;margin-left:4px;">案例核实' + (c.issueCount > 1 ? c.issueCount + '次' : '') + '</span>'
                                    + '</div>'
                                    + '<div style="background:#e8f5e9;padding:10px;border-radius:6px;font-size:0.88rem;line-height:1.7;color:#1b5e20;">'
                                    + '"' + acEscHtml(c.clause) + '"'
                                    + '</div>'
                                    + '</div>';
                            });
                        }
                        // 规章库条款区域（蓝色）
                        if (ruleSelected.length > 0) {
                            conclusionHtml += '<div style="margin-bottom:6px;margin-top:' + (issueSelected.length > 0 ? '10' : '0') + 'px;"><span style="font-size:0.78rem;font-weight:700;color:#1e40af;background:#dbeafe;padding:3px 10px;border-radius:20px;">⚖️ 规章库匹配条款</span></div>';
                            ruleSelected.forEach((id, idx) => {
                                const c = _globalCandidatesMap[id];
                                conclusionHtml += '<div style="margin-bottom:10px;padding:12px;background:#eff6ff;border-radius:8px;border-left:3px solid #2563eb;">'
                                    + '<div style="font-weight:700;color:#1e40af;margin-bottom:6px;">'
                                    + (idx+1) + '. 不符合/违反《' + acEscHtml(c.title) + '》'
                                    + (c.fileNumber ? '（' + acEscHtml(c.fileNumber) + '）' : '')
                                    + (c.article ? ' 第' + acEscHtml(c.article) + '条' : '')
                                    + '<span style="font-size:0.68rem;background:#dbeafe;color:#1e40af;padding:1px 6px;border-radius:8px;margin-left:4px;">规章库</span>'
                                    + '</div>'
                                    + '<div style="background:#e0f2fe;padding:10px;border-radius:6px;font-size:0.88rem;line-height:1.7;color:#0c4a6e;">'
                                    + '"' + acEscHtml(c.clause) + '"'
                                    + '</div>'
                                    + '</div>';
                            });
                        }
                    }

                    // ── 条款来源案例标识（只显示[性质·类别]标签） ──
                    let caseSourceHtml = '';
                    if (hasIssueSel) {
                        caseSourceHtml = '<div style="margin-top:12px;">'
                            + '<div style="margin-bottom:6px;"><span style="font-size:0.78rem;font-weight:700;color:#b45309;background:#fef3c7;padding:3px 10px;border-radius:20px;">📂 条款来源案例标识</span></div>'
                            + '<div style="display:flex;flex-direction:column;gap:4px;">';
                        issueSelected.forEach((id, idx) => {
                            const c = _globalCandidatesMap[id];
                            // 从原始issueCandidates中查找案例引用信息
                            const matchIssue = issueCandidates.find(ic =>
                                ic.title === c.title && ic.article === c.article
                            );
                            const issueRefs = (matchIssue && matchIssue.issueRefs) ? matchIssue.issueRefs : [];
                            caseSourceHtml += '<div style="background:#fffbeb;border:1px solid #fde68a;border-radius:8px;padding:8px 12px;">'
                                + '<div style="font-size:0.85rem;font-weight:600;color:#92400e;">'
                                + '[' + (idx+1) + '] 《' + acEscHtml(c.title) + '》'
                                + (c.article ? ' 第' + acEscHtml(c.article) + '条' : '')
                                + '</div>';
                            if (issueRefs.length > 0) {
                                caseSourceHtml += '<div style="margin-top:4px;display:flex;flex-wrap:wrap;gap:4px;">';
                                issueRefs.forEach(r => {
                                    const tag = (r.nature || '') + (r.category ? '·' + r.category : '');
                                    caseSourceHtml += '<span style="font-size:0.7rem;background:#fde68a;color:#78350f;padding:2px 8px;border-radius:10px;">[' + acEscHtml(tag || '案例') + ']</span>';
                                });
                                caseSourceHtml += '</div>';
                            }
                            caseSourceHtml += '</div>';
                        });
                        caseSourceHtml += '</div></div>';
                    }

                    // ── 历史案例规章参考（展示所有召回的案例候选，不限于AI选中） ──
                    let issueRefHtml = '';
                    if (issueCandidates.length > 0) {
                        issueRefHtml = '<div style="margin-top:12px;">'
                            + '<div style="margin-bottom:6px;"><span style="font-size:0.78rem;font-weight:700;color:#15803d;background:#dcfce7;padding:3px 10px;border-radius:20px;">📋 匹配案例条款参考</span></div>'
                            + '<div style="display:flex;flex-direction:column;gap:6px;">';
                        issueCandidates.slice(0, 5).forEach((c, i) => {
                            var refQuote = extractRegulationQuote(c.snippet || c.fullText || '');
                            issueRefHtml += '<div class="rule-card-item" style="padding:12px 16px;background:#f0fdf4;border-radius:8px;">'
                                + '<div class="rule-title" style="display:flex;align-items:center;justify-content:space-between;gap:8px;">'
                                + '<span style="flex:1;word-break:break-all;color:#166534;font-weight:600;">[' + (i+1) + '] 《' + acEscHtml(c.title) + '》' + (c.fileNumber ? '（' + acEscHtml(c.fileNumber) + '）' : '') + (c.article ? ' 第' + acEscHtml(c.article) + '条' : '') + '</span>'
                                + '<span style="font-size:0.7rem;color:#15803d;background:#dcfce7;padding:2px 8px;border-radius:12px;">' + (c.issueCount || 1) + '个案例引用</span>'
                                + '</div>'
                                + (refQuote ? '<div style="margin-top:6px;font-size:0.8rem;color:#374151;line-height:1.5;">' + acEscHtml(refQuote) + '</div>' : '')
                                + '</div>';
                        });
                        issueRefHtml += '</div></div>';
                    }

                    // ── 规章库匹配参考（展示所有召回的规章库候选） ──
                    let ruleRefHtml = '';
                    if (ruleCandidates.length > 0) {
                        ruleRefHtml = '<div style="margin-top:12px;">'
                            + '<div style="margin-bottom:6px;"><span style="font-size:0.78rem;font-weight:700;color:#1e40af;background:#dbeafe;padding:3px 10px;border-radius:20px;">⚖️ 规章库匹配参考</span></div>'
                            + '<div style="display:flex;flex-direction:column;gap:6px;">';
                        ruleCandidates.slice(0, 5).forEach((c, i) => {
                            const tradeTag = c.trade ? ('【' + acEscHtml(c.trade) + '】') : '';
                            ruleRefHtml += '<div class="rule-card-item" style="padding:12px 16px;background:#eff6ff;border-radius:8px;">'
                                + '<div class="rule-title" style="display:flex;align-items:center;justify-content:space-between;gap:8px;">'
                                + '<span style="flex:1;word-break:break-all;color:#1e40af;font-weight:600;">[' + (i+1) + '] 《' + acEscHtml(c.title) + '》' + (c.fileNumber ? '（' + acEscHtml(c.fileNumber) + '）' : '') + (c.article ? ' 第' + acEscHtml(c.article) + '条' : '') + '</span>'
                                + '<span style="font-size:0.7rem;color:#1e40af;background:#dbeafe;padding:2px 8px;border-radius:12px;">' + tradeTag + ' 规章库</span>'
                                + '</div>'
                                + (c.snippet || c.content ? '<div style="margin-top:6px;font-size:0.8rem;color:#374151;line-height:1.5;">' + acEscHtml(c.snippet || c.content) + '</div>' : '')
                                + '</div>';
                        });
                        ruleRefHtml += '</div></div>';
                    }

                    const issueCount = issueSelected.length;
                    const ruleCount  = ruleSelected.length;

                    // ── 生成反馈ID（用于DOM定位） ──
                    const feedbackId = 'ac-fb-' + Date.now();

                    container.innerHTML = '<div style="background:#f0f9ff;padding:16px;border-radius:12px;border-left:5px solid #2563eb;">'
                        + '<h3 style="color:#1e3a5f;margin-bottom:12px;">⚖️ 对规结论 <span style="font-size:0.75rem;font-weight:400;color:#64748b;">（强约束模式·条款来自本地库）</span></h3>'
                        + '<p style="margin-bottom:12px;"><strong>📌 校核后问题：</strong>' + acEscHtml(correctedQuery || query) + '</p>'
                        + sourceTipHtml
                        + conclusionHtml
                        + caseSourceHtml
                        + (validIds.length > 0 ? '<p style="color:#16a34a;font-size:0.82rem;margin-top:8px;">✅ 条款来源：案例库 ' + issueCount + ' 条，规章库 ' + ruleCount + ' 条 | 选择理由：' + acEscHtml(reason || '') + '</p>' : '')
                        // ── 参考区域（结论卡片外部）──
                        + issueRefHtml
                        + ruleRefHtml
                        // ── 对规反馈区域 ──
                        + '<div id="' + feedbackId + '" style="margin-top:14px;padding:12px 14px;background:#fff;border-radius:8px;border:1px solid #e2e8f0;">'
                        + '<div style="font-size:0.85rem;font-weight:600;color:#475569;margin-bottom:8px;">📝 本次对规结果是否正确？</div>'
                        + '<div style="display:flex;gap:8px;flex-wrap:wrap;">'
                        + '<button class="btn btn-small" style="background:#dcfce7;color:#166534;border:1px solid #86efac;padding:6px 16px;border-radius:20px;font-size:0.82rem;cursor:pointer;" onclick="window.acFeedback(\'' + feedbackId + '\',\'correct\',this)">✅ 正确</button>'
                        + '<button class="btn btn-small" style="background:#fef3c7;color:#92400e;border:1px solid #fcd34d;padding:6px 16px;border-radius:20px;font-size:0.82rem;cursor:pointer;" onclick="window.acFeedback(\'' + feedbackId + '\',\'partial\',this)">⚠️ 部分正确</button>'
                        + '<button class="btn btn-small" style="background:#fef2f2;color:#991b1b;border:1px solid #fca5a5;padding:6px 16px;border-radius:20px;font-size:0.82rem;cursor:pointer;" onclick="window.acFeedback(\'' + feedbackId + '\',\'wrong\',this)">❌ 不正确</button>'
                        + '</div>'
                        + '</div>'
                        + '</div>';

                    // 保存供后续使用
                    window._lastACRules = validIds.map(id => {
                        const c = _globalCandidatesMap[id];
                        return { title: c.title, fileNumber: c.fileNumber, article: c.article, snippet: c.clause };
                    });

                } catch(err) {
                    if (err.name === 'AbortError') {
                        container.innerHTML = '<div style="color:#e53e3e;padding:12px;">⏹️ 已停止AI对规</div>';
                    } else {
                        container.innerHTML = '<div style="padding:16px;color:#e53e3e;">❌ AI对规失败：' + acEscHtml(err.message) + '<br><button class="btn btn-secondary btn-small" style="margin-top:8px;" onclick="autoCheckLocal()">改用本地匹配</button></div>';
                    }
                } finally {
                    window._dsAbortController = null;
                }
            };

            // ── 对规反馈记录 ──
            window.acFeedback = function(feedbackId, verdict, btnEl) {
                // verdict: 'correct' | 'partial' | 'wrong'
                const container = document.getElementById(feedbackId);
                if (!container) return;

                // 读取当前对规信息
                const query = document.getElementById('autoCheck-input') ? document.getElementById('autoCheck-input').value.trim() : '';
                const selectedIds = window._lastACRules || [];

                // 构建反馈记录
                const record = {
                    id: Date.now(),
                    time: new Date().toISOString(),
                    query: query,
                    verdict: verdict,
                    selectedRules: selectedIds.map(r => ({
                        title: r.title || '',
                        fileNumber: r.fileNumber || '',
                        article: r.article || ''
                    }))
                };

                // 保存到 localStorage
                const STORAGE_KEY = 'ac_feedback_records';
                let records = [];
                try {
                    records = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
                } catch(e) { records = []; }
                records.push(record);
                // 只保留最近500条
                if (records.length > 500) records = records.slice(-500);
                localStorage.setItem(STORAGE_KEY, JSON.stringify(records));

                // 更新UI：隐藏按钮，显示已反馈状态
                const labels = { correct: '✅ 正确', partial: '⚠️ 部分正确', wrong: '❌ 不正确' };
                const colors = { correct: '#166534', partial: '#92400e', wrong: '#991b1b' };

                container.innerHTML = '<div style="display:flex;align-items:center;gap:8px;">'
                    + '<span style="font-size:0.88rem;font-weight:600;color:' + colors[verdict] + ';">' + labels[verdict] + '，已记录</span>'
                    + (verdict === 'wrong' || verdict === 'partial'
                        ? '<button class="btn btn-small" style="background:#eff6ff;color:#1e40af;border:1px solid #93c5fd;padding:4px 12px;border-radius:16px;font-size:0.78rem;cursor:pointer;" onclick="window.acFeedbackCorrection(\'' + record.id + '\')">✏️ 补充正确条款</button>'
                        : '')
                    + '<span style="font-size:0.75rem;color:#94a3b8;">累计 ' + records.length + ' 条反馈</span>'
                    + '</div>';

                console.log('[对规反馈]', verdict, '查询:', query.slice(0, 40), '...', '累计', records.length, '条');
            };

            // ── 补充正确条款（反馈修正） ──
            window.acFeedbackCorrection = function(recordId) {
                const correction = prompt('请输入正确的规章条款，格式如：\n《规章名称》文号 第X条');
                if (!correction || !correction.trim()) return;

                const STORAGE_KEY = 'ac_feedback_records';
                let records = [];
                try {
                    records = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
                } catch(e) { records = []; }

                const rec = records.find(r => r.id === recordId);
                if (rec) {
                    rec.correction = correction.trim();
                    rec.correctionTime = new Date().toISOString();
                    localStorage.setItem(STORAGE_KEY, JSON.stringify(records));
                    alert('已记录修正：' + correction.trim());
                    console.log('[对规反馈修正]', rec.query.slice(0, 30), '→', correction.trim());
                }
            };

            // 停止AI对规生成
            window.stopACGeneration = function() {
                if (_acAbortController) _acAbortController.abort();
            };


            window.clearAutoCheck = function() {
                document.getElementById('autoCheck-input').value = '';
                const c = document.getElementById('autoCheck-results');
                c.style.display = 'none';
                c.innerHTML = '';
                // 隐藏关键词选择区域
                const selectArea = document.getElementById('keyword-select-area');
                if (selectArea) selectArea.style.display = 'none';
                // 重置选择状态
                acSelectedKeywords = new Set();
                acCandidateKeywords = [];
                // 重置两态按钮状态
                _acHasLocalResult = false;
                const smartBtn = document.getElementById('autoCheck-smartBtn');
                if (smartBtn) {
                    smartBtn.dataset.state = 'local';
                    smartBtn.className = 'btn btn-primary';
                    smartBtn.style.flex = '1';
                    smartBtn.style.minWidth = '';
                    smartBtn.style.fontWeight = '600';
                    smartBtn.disabled = false;
                    smartBtn.style.opacity = '1';
                    smartBtn.textContent = '🔍 本地匹配';
                    smartBtn.classList.remove('state-ai');
                }
                // 隐藏AI对规提示
                const hint = document.getElementById('autoCheck-ai-hint');
                if (hint) hint.style.display = 'none';
                // 清除缓存
                window._lastACIssues = [];
                window._lastACRules = [];
                _bm25Index = null;
            };

            // ===== 两态合并按钮绑定（本地匹配后锁定AI对规）=====
            var _acHasLocalResult = false; // 标记本地匹配是否已完成

            (function bindAutoCheckEvents() {
                function bind() {
                    const smartBtn = document.getElementById('autoCheck-smartBtn');
                    const clearBtn = document.getElementById('autoCheck-clearBtn');

                    if (smartBtn) {
                        // 初始化状态
                        smartBtn.dataset.state = 'local';

                        smartBtn.onclick = function() {
                            // 如果本地匹配已完成但还没AI对规，强制引导走AI对规
                            if (_acHasLocalResult && (smartBtn.dataset.state === 'local')) {
                                smartBtn.dataset.state = 'ai';
                                smartBtn.className = 'btn btn-info state-ai';
                                smartBtn.style.flex = '1';
                                smartBtn.style.minWidth = '';
                                smartBtn.style.fontWeight = '600';
                                smartBtn.textContent = '🤖 AI 对规';
                                // 显示提示
                                const hint = document.getElementById('autoCheck-ai-hint');
                                if (hint) hint.style.display = 'block';
                                return;
                            }

                            const state = smartBtn.dataset.state || 'local';
                            if (state === 'local') {
                                // 第一次点击：本地匹配
                                window.autoCheckLocal();
                                // 切换到AI对规状态
                                smartBtn.dataset.state = 'ai';
                                smartBtn.className = 'btn btn-info state-ai';
                                smartBtn.style.flex = '1';
                                smartBtn.style.minWidth = '';
                                smartBtn.style.fontWeight = '600';
                                smartBtn.textContent = '🤖 AI 对规';
                                // 显示提示
                                const hint = document.getElementById('autoCheck-ai-hint');
                                if (hint) hint.style.display = 'block';
                            } else {
                                // 第二次点击：AI 对规（带相似度检查）
                                _acHasLocalResult = false; // 解除锁定
                                window.autoCheckAI();
                                // 完成后恢复到本地匹配
                                smartBtn.dataset.state = 'local';
                                smartBtn.className = 'btn btn-primary';
                                smartBtn.style.flex = '1';
                                smartBtn.style.minWidth = '';
                                smartBtn.style.fontWeight = '600';
                                smartBtn.textContent = '🔍 本地匹配';
                                smartBtn.classList.remove('state-ai');
                                // 隐藏提示
                                const hint = document.getElementById('autoCheck-ai-hint');
                                if (hint) hint.style.display = 'none';
                            }
                        };
                    }
                    if (clearBtn) clearBtn.onclick = function() { window.clearAutoCheck(); };
                }
                if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bind);
                else bind();
            })();
            window.importRailwayTerms = function() {
                const input = document.createElement('input');
                input.type = 'file';
                input.accept = '.json,.txt,.csv';
                input.style.display = 'none';

                input.onchange = function(e) {
                    const file = e.target.files[0];
                    if (!file) return;

                    const reader = new FileReader();
                    reader.onload = function(event) {
                        try {
                            let content = event.target.result;
                            // 解析为结构化条目 [{term, trade}]
                            let items = [];

                            if (file.name.endsWith('.json')) {
                                // 去除 JSON 中的注释，兼容带 // 行注释和 /* */ 块注释的文件
                                const cleaned = content.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
                                const data = JSON.parse(cleaned);
                                const raw = Array.isArray(data) ? data : (data.terms || []);
                                raw.forEach(function(r) {
                                    if (typeof r === 'string' && r.trim().length >= 2) {
                                        items.push({ term: r.trim(), trade: '通用' });
                                    } else if (r && typeof r.term === 'string' && r.term.trim().length >= 2) {
                                        items.push({ term: r.term.trim(), trade: r.trade || '通用' });
                                    }
                                });
                            } else {
                                // TXT/CSV：每行/每逗号一个术语，统一归入"通用"
                                content.split(/[\r\n,，;；]+/).forEach(function(t) {
                                    const s = t.trim();
                                    if (s.length >= 2) items.push({ term: s, trade: '通用' });
                                });
                            }

                            if (items.length === 0) {
                                alert('未找到有效的术语，请检查文件格式');
                                return;
                            }

                            // 合并去重（以 term 为主键）
                            const existingMap = new Map(PATCH_TERM_LIBRARY.map(function(i) { return [i.term, i]; }));
                            let addedCount = 0;
                            items.forEach(function(item) {
                                if (!existingMap.has(item.term)) {
                                    PATCH_TERM_LIBRARY.push(item);
                                    existingMap.set(item.term, item);
                                    addedCount++;
                                }
                            });

                            // 持久化 + 同步 Set
                            localStorage.setItem('patch_term_library_v2', JSON.stringify(PATCH_TERM_LIBRARY));
                            syncTermSet();

                            const container = document.getElementById('autoCheck-results');
                            container.innerHTML = '<div style="padding:16px;color:var(--success);background:#f0fdf4;border-radius:8px;border-left:4px solid var(--success);">' +
                                '<strong>✅ 词库导入成功</strong><br>' +
                                '新增 <strong>' + addedCount + '</strong> 个专业术语（跳过重复 ' + (items.length - addedCount) + ' 个）<br>' +
                                '<span style="font-size:0.85rem;color:var(--text-secondary);">总词库容量：' + RAILWAY_TERMS.size + ' 个术语</span><br><br>' +
                                '<button class="btn btn-primary btn-small" onclick="document.getElementById(\'autoCheck-results\').style.display=\'none\';">关闭</button>' +
                                '</div>';
                            container.style.display = 'block';
                            console.log('词库导入：新增 ' + addedCount + ' 个，当前共 ' + RAILWAY_TERMS.size + ' 个');
                        } catch (err) {
                            alert('文件解析失败：' + err.message + '\n请确保文件格式正确（JSON/TXT/CSV）');
                        }
                    };
                    reader.readAsText(file);
                    input.remove();
                };
                document.body.appendChild(input);
                input.click();
            };

            // 导出词库（结构化格式，含 term + trade）
            window.exportRailwayTerms = function() {
                const sorted = PATCH_TERM_LIBRARY.slice().sort(function(a, b) {
                    return (a.trade || '').localeCompare(b.trade || '') || a.term.localeCompare(b.term);
                });
                const payload = { terms: sorted, count: sorted.length, exportDate: new Date().toISOString(), version: 2 };
                const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = '铁路专业词库_' + new Date().toISOString().slice(0, 10) + '.json';
                a.click();
                URL.revokeObjectURL(url);
            };

            // 暴露给全局，供智能助手使用
            window.acExtractKeywords = acExtractKeywords;
            window.acExtractLibraryKeywords = acExtractLibraryKeywords;
            window.patchInferTrade = patchInferTrade;
            window.PATCH_TERM_LIBRARY = PATCH_TERM_LIBRARY;
            window.PATCH_TRADE_KEYWORDS = PATCH_TRADE_KEYWORDS;
            window.VIOLATION_ACTION_WORDS = VIOLATION_ACTION_WORDS;

            // ========== 自动对规子模块 END ==========
    window.patchInferTrade = patchInferTrade;

    console.log("✅ smart-check.js 已加载");
})();
