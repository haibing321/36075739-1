/**
 * 安监智能辅助系统 - 智能助手共享工具层
 * ===================================================
 * 从 doubao.js 提取的共享工具函数：
 *   - 附件处理（本地文件上传 + 资料库选择）
 *   - 文件读取（TXT/MD/DOC/DOCX/XLS/XLSX/PDF）
 * 加载顺序：在 doubao.js 之前加载
 */

(function() {
    'use strict';

    // ==================== API 地址归一化 + 自愈（v3.70）====================
    // 为什么必须有：API 地址是「按设备」存在各浏览器 localStorage 的 ds_api_url_v1 键里，
    //   而保存时只做了 trim。手机端与电脑端各存各的，一个手输/误粘贴的地址在手机上是常态。
    // 关键机理：这类"地址不对"会以两种常见形态出现，且都不会报"配置错误"，而是直接给一个 404：
    //   a) 缺 scheme（如 api.deepseek.com/chat/completions）—— fetch 不报错，把它当【相对路径】
    //      按页面同源解析，请求打到本站自己的静态服务器，换回本站的 404；
    //   b) 绝对地址但路径写错（真实案例：手机上手输 https://api.deepseek.com/chat/completion，
    //      少结尾的 s）—— 服务器上不存在该路径，官方返回 404。
    //   两种都会让四个 AI 功能（对话/对规/写作/风险研判）同时失效，因为它们共享本配置键。
    //   （注：官方对业务错误——模型名无效、参数不对——一律用 400 返回，所以「404」本身
    //     就是"地址不对"的强信号。）
    // 归一化规则（只修"客观错误"，绝不猜第三方网关）：
    //   ① 去掉误粘贴的引号/尖括号/首尾空白；
    //   ② 缺 scheme 且不是以 / 开头的绝对路径 → 补 https://（以 / 开头的是有意为之的同源路径，不动）；
    //   ③ 只对「已知供应商域名」补全/纠正 chat 路径：
    //      · 路径为空、等于该供应商文档里的「基址」、或仅 /v1（且该域名无基址前缀）→ 补全；
    //      · 路径里出现 completion 但不是规范写法（少结尾的 s、多末尾斜杠、大小写不同、
    //        v1/completion 之类）→ 纠正为规范路径。真实案例：手机上手输
    //        https://api.deepseek.com/chat/completion（少一个 s）→ 该路径在官方服务器上
    //        不存在 → 404，且四个 AI 功能会同时失效。
    //      ⚠️ v3.71 修复两处（均为"补全规则本身"的缺陷，不动其它语义）：
    //        ① 旧规则对"基址非 /v1"的域名（如 dashscope 的 /compatible-mode/v1）也会拼 /v1 前缀，
    //           产出 /v1/compatible-mode/v1/chat/completions 这种任何服务器都不存在的怪路径；
    //        ② 旧规则只认"空路径"和"/v1"，用户在手机上填供应商文档里的**基址**
    //           （dashscope /compatible-mode/v1、智谱 /api/paas/v4）时不补全，仍是 404。
    //      未知域名一律原样返回 —— 第三方网关/根路径代理可能是故意配的，改了反而弄坏；
    //      /responses、/messages、/anthropic 等其它合法通道也一律不动。
    window.dsNormalizeApiUrl = function(raw) {
        var u = String(raw == null ? '' : raw).trim().replace(/^[<"'\s]+|[>"'\s]+$/g, '');
        if (!u) return '';
        if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(u) && u.charAt(0) !== '/') u = 'https://' + u;
        try {
            var url = new URL(u);
            var host = url.host.toLowerCase();
            var path = url.pathname.replace(/\/+$/, '');
            var lower = path.toLowerCase();
            // tail = 规范 chat 路径；base = 该供应商文档里给的「基址」（用户常直接照抄基址）
            var KNOWN = {
                'api.deepseek.com':       { tail: '/chat/completions',                    base: '' },
                'api.openai.com':         { tail: '/v1/chat/completions',                 base: '/v1' },
                'dashscope.aliyuncs.com': { tail: '/compatible-mode/v1/chat/completions', base: '/compatible-mode/v1' },
                'open.bigmodel.cn':       { tail: '/api/paas/v4/chat/completions',        base: '/api/paas/v4' },
                'api.moonshot.cn':        { tail: '/v1/chat/completions',                 base: '/v1' },
                'api.baichuan-ai.com':    { tail: '/v1/chat/completions',                 base: '/v1' },
                'api.minimax.chat':       { tail: '/v1/text/chatcompletion_v2',           base: '/v1' },
                'api.stepfun.com':        { tail: '/v1/chat/completions',                 base: '/v1' }
            };
            var meta = KNOWN[host];
            if (meta) {
                var tail = meta.tail;
                var tl = tail.toLowerCase();
                var want = null;                       // 期望的 pathname（null = 不动）
                if (path === '' || path === meta.base) {
                    // 只填了域名（含结尾斜杠），或只填了供应商文档里的基址 → 补上 chat 路径
                    want = tail;
                } else if (path === '/v1' && !meta.base) {
                    // DeepSeek 官方同时支持 /v1 作为 OpenAI 兼容基址。仅当该域名自身没有基址前缀时
                    // 才这样补 —— 否则（如 dashscope 的 /compatible-mode/v1）会拼出
                    // /v1/compatible-mode/v1/... 这种任何服务器都不存在的路径（v3.71 修复）
                    want = '/v1' + tail;
                } else if (lower.indexOf('completion') !== -1) {
                    // 与规范路径"忽略大小写相同"（含 /v1、/beta 前缀）→ 只统一大小写与末尾斜杠
                    var isExact = (lower === tl) || (('/v1' + tl) === lower) || (('/beta' + tl) === lower);
                    if (isExact) {
                        want = lower;
                    } else {
                        // 明显是"想写 chat/completions 但写错了"（少结尾的 s、多一段 chat、
                        // v1/completion 等）→ 纠正为规范路径，保留合法的 /v1、/beta 前缀
                        var prefix = '';
                        if (lower.indexOf('/v1/') === 0 && tl.indexOf('/v1') !== 0) prefix = '/v1';
                        else if (lower.indexOf('/beta/') === 0 && tl.indexOf('/beta') !== 0) prefix = '/beta';
                        want = prefix + tail;
                    }
                }
                if (want && url.pathname !== want) {
                    // 只在"语义被纠正"时告警；纯大小写/末尾斜杠归一不吵人
                    if (want !== lower) console.warn('[api url] 地址路径疑似写错，已纠正：' + raw + ' → ' + url.origin + want);
                    url.pathname = want;
                    return url.toString();
                }
            }
        } catch (e) {}
        return u;
    };
    // 读配置的统一入口：读取时即归一化，这样即使库里的值已被写坏也能自愈（无需用户重输）
    window.dsGetApiUrl = function(def) {
        var raw = '';
        try { raw = localStorage.getItem('ds_api_url_v1') || ''; } catch (e) {}
        var fixed = window.dsNormalizeApiUrl(raw);
        return fixed || def || 'https://api.deepseek.com/chat/completions';
    };

    // ---- 附件处理 ----
    window._dsAttachments = []; // [{name, text}]

    var _dsAttaching = false;   // 【2026-09-23】解析互斥：解析中再选同一批文件不再叠加处理
    window.dsHandleAttach = async function(input) {
        const files = Array.from(input.files || []);
        // 【2026-09-23】选完立刻复位 input.value：否则**再次选择同一个文件**不会触发 change
        //   （用户感知就是"点了没反应、时好时坏"）。files 已复制成数组，复位不影响本次处理。
        try { input.value = ''; } catch (e) {}
        if (!files.length) return;
        if (_dsAttaching) { if (window.showToast) window.showToast('上一批附件还在解析中，请稍候…', true, 4000); return; }
        _dsAttaching = true;
        const inputEl = document.getElementById('ds-user-input');
        // 【2026-09-23】解析期立刻给反馈：pdf/docx 解析要几秒，此前界面**毫无变化**，看起来像没反应
        const prevHost = document.getElementById('ds-attach-preview');
        if (prevHost) {
            prevHost.innerHTML = '<span class="ds-attach-chip" style="display:inline-flex;align-items:center;gap:6px;padding:4px 10px;border:1px dashed var(--border,#e2e8f0);border-radius:14px;font-size:0.78rem;color:#64748b;">⏳ 正在解析附件 ' + files.length + ' 个…</span>';
        }
        try {

        for (const file of files) {
            let text = '';
            const ext = file.name.split('.').pop().toLowerCase();

            try {
                if (ext === 'txt' || ext === 'md' || ext === 'json' || ext === 'csv') {
                    text = await window.dsReadTextFileAutoEnc(file);
                } else if (ext === 'doc' || ext === 'docx') {
                    if (ext === 'doc') {
                        // 老版 Word 二进制格式(.doc) mammoth 不支持，明确提示并跳过
                        alert('文件「' + file.name + '」为旧版 Word(.doc) 格式，暂不支持。\n请另存为 .docx 后重新上传。');
                        continue;
                    }
                    if (typeof mammoth === 'undefined') {
                        try { await window.loadScript('src/js/vendor/mammoth.browser.min.js'); }
                        catch (e) { /* 交给下面判空 */ }
                    }
                    if (typeof mammoth === 'undefined') {
                        text = 'Word 解析库(mammoth)加载失败，请检查网络后重试。';
                    } else {
                        text = await window.dsReadWordFile(file);
                    }
                } else if (ext === 'xls' || ext === 'xlsx') {
                    if (typeof XLSX === 'undefined') {
                        try { await window.loadScript('src/js/vendor/xlsx.full.min.js'); }
                        catch (e) { /* 交给下面判空 */ }
                    }
                    if (typeof XLSX === 'undefined') {
                        text = 'Excel 解析库(XLSX)加载失败，请检查网络后重试。';
                    } else {
                        text = await window.dsReadExcelFile(file);
                    }
                } else if (ext === 'pdf') {
                    if (typeof pdfjsLib === 'undefined') {
                        try { await window.loadScript('src/js/vendor/pdf.min.js'); }
                        catch (e) { /* 交给下面判空 */ }
                    }
                    if (typeof pdfjsLib === 'undefined') {
                        text = 'PDF 解析库(pdf.js)加载失败，请检查网络后重试。';
                    } else {
                        text = await window.dsReadPdfFile(file);
                    }
                } else if (ext === 'ofd') {
                    // 【2026-10-03 用户需求】OFD（国产版式文档）导入：本地 JSZip 解包 → 抽正文 → **去水印**。
                    //   全程离线（只用 src/js/vendor/jszip.min.js），水印判据见 ofd-import.js 文件头。
                    if (!window.OFDImport) {
                        try { await window.loadScript('src/js/modules/ofd-import.js'); } catch (e) {}
                    }
                    if (!window.OFDImport) {
                        text = 'OFD 解析模块加载失败（src/js/modules/ofd-import.js）';
                    } else {
                        var _ofd = await window.OFDImport.extract(file);
                        text = _ofd.text || '';
                        if (_ofd.removed && _ofd.removed.length) {
                            try { console.info('[OFD] 已去除水印 ' + _ofd.removed.length + ' 处：' + _ofd.removed.join('；')); } catch (e) {}
                        }
                        if (!text) text = '（未解析出正文' + (_ofd.note ? '：' + _ofd.note : '') + '）';
                        else if (_ofd.note) text += '\n\n[提示] ' + _ofd.note;
                    }
                } else if (/^image\//.test(file.type) || /^(png|jpe?g|gif|webp|bmp)$/.test(ext)) {
                    // 图片附件：读取为 dataURL 并获取尺寸，供预览与（支持多模态时）送审
                    text = await window.dsReadImageFile(file);
                } else {
                    text = '暂不支持该文件格式：' + ext;
                }

                const maxLen = 8000;
                const truncated = text.length > maxLen ? text.slice(0, maxLen) + '\n...[内容过长，已截取前' + maxLen + '字]' : text;
                const isImage = !!((/^image\//.test(file.type) || /^(png|jpe?g|gif|webp|bmp)$/.test(ext)) && (file.attachDataUrl));
                // 【2026-10-07 用户需求】额外保留**原始 File 引用**（`_file`）：附件原本只留 name/text，
                //   而"格式转换"（PDF/OFD/TXT → DOCX）必须拿到原始文件重新走解析 ⇒ 没有它就做不了。
                //   附件是临时对象、发送后立即清空（见 _dsRunStream 的 `_dsAttachments = []`），
                //   保留引用不构成内存负担；图片仍走 dataUrl，行为不变。
                window._dsAttachments.push({ name: file.name, text: truncated, dataUrl: file.attachDataUrl || null, isImage: isImage, _file: file });

                const icon = ext === 'pdf' ? '📕' : ext === 'docx' || ext === 'doc' ? '📘' : ext === 'xlsx' || ext === 'xls' ? '📊' : isImage ? '🖼️' : '📎';
                const tagText = ' [' + icon + ' ' + file.name + '] ';
                if (inputEl.value) { inputEl.value += tagText; } else { inputEl.value = tagText; }
                inputEl.style.height = 'auto';
                inputEl.style.height = inputEl.scrollHeight + 'px';
                dsRenderAttachPreview();
            } catch (err) {
                console.error('文件解析失败:', file.name, err);
                alert('文件 "' + file.name + '" 解析失败：' + err.message);
            }
        }
        } finally {
            // 【2026-09-23】无论成功/失败都解锁；若"解析中…"占位还在（没有任何文件成功）就清掉
            _dsAttaching = false;
            var _hp = document.getElementById('ds-attach-preview');
            if (_hp && /正在解析附件/.test(_hp.textContent || '')) _hp.innerHTML = '';
        }
    };

    // ---- +号附件菜单 ----
    // v3.25：智能助手底部七个按钮「点开一个、关闭其它」互斥——打开任一弹出前先关闭
    // 所有其它弹出（四个下拉菜单 / 附件弹层 / FIM 弹窗）。exceptEl 为当前要打开的元素，
    // 不会被误关。全部动态查询节点，折叠屏整页还原后依然有效。
    window.dsCloseAllChatPopups = function(exceptEl) {
        // 四个下拉菜单（角色/模型/关联数据/联网搜索，.ds-dropdown-menu.open）
        document.querySelectorAll('.ds-dropdown-menu.open').forEach(function(m) {
            if (m !== exceptEl) m.classList.remove('open');
        });
        // 附件弹层
        var am = document.getElementById('ds-attach-menu');
        if (am && am !== exceptEl && getComputedStyle(am).display !== 'none') am.style.display = 'none';
        // FIM 弹窗
        var fim = document.getElementById('ds-fim-modal');
        if (fim && fim !== exceptEl && getComputedStyle(fim).display !== 'none') fim.style.display = 'none';
    };

    window.dsToggleAttachMenu = function() {
        var menu = document.getElementById('ds-attach-menu');
        if (!menu) return;
        // 用 computed style 判断：菜单默认隐藏由 CSS 提供（内联 style.display 初始为空串）
        var shown = getComputedStyle(menu).display !== 'none';
        // v3.25 互斥：本次是「打开」时，先关闭其它所有弹出
        if (!shown && typeof window.dsCloseAllChatPopups === 'function') window.dsCloseAllChatPopups(menu);
        menu.style.display = shown ? 'none' : 'block';
    };
    document.addEventListener('click', function(e) {
        var menu = document.getElementById('ds-attach-menu');
        if (!menu) return;
        if (getComputedStyle(menu).display !== 'none' && !e.target.closest('#ds-attach-menu') && !e.target.closest('[onclick*="dsToggleAttachMenu"]')) {
            menu.style.display = 'none';
        }
    });

    // ---- 写作资料库附件选择（含历史报告） ----
    window._dsMaterialCache = [];

    window.dsOpenMaterialPicker = async function() {
        var modal = document.getElementById('ds-material-modal');
        if (!modal) return;
        modal.style.display = 'flex';
        var list = document.getElementById('ds-material-list');
        list.innerHTML = '<div style="text-align:center;padding:20px;color:var(--text-secondary);">加载中…</div>';
        document.getElementById('ds-material-search').value = '';
        document.getElementById('ds-material-type-filter').value = '';
        try {
            var db = await new Promise(function(res, rej) {
                var r = indexedDB.open('railway_writer_db', 2);
                r.onerror = function(){ rej(r.error); };
                r.onblocked = function(){ console.warn('[material] 数据库被阻塞'); };
                // 必须建全三个 store：此处若先于智能写作模块执行，库会被固定在 v2 且只含部分 store，
                // 之后 wrOpenDB() 再 open(2) 不会再触发升级，资料库/历史报告永久报错。
                r.onupgradeneeded = function(e){
                    if (typeof window.__wrEnsureSchema === 'function') { window.__wrEnsureSchema(e.target.result); return; }
                    var d = e.target.result;
                    ['writing_templates','writing_reports','writing_materials'].forEach(function(name){
                        if (!d.objectStoreNames.contains(name)) d.createObjectStore(name, { keyPath: 'id', autoIncrement: true });
                    });
                };
                r.onsuccess = function(){ res(r.result); };
            });
            var materials = await new Promise(function(res) {
                var tx = db.transaction('writing_materials', 'readonly');
                var store = tx.objectStore('writing_materials');
                store.getAll().onsuccess = function(e) { res(e.target.result || []); };
            });
            // 同时载入「智能写作历史报告」，作为可附加的上下文
            var reports = [];
            try {
                reports = await new Promise(function(res) {
                    var tx = db.transaction('writing_reports', 'readonly');
                    var store = tx.objectStore('writing_reports');
                    store.getAll().onsuccess = function(e) { res(e.target.result || []); };
                });
            } catch(e) { reports = []; }
            db.close();
            // 合并：资料库条目保留原 type；历史报告统一标记为 report 类型
            var reportItems = (reports || []).map(function(r) {
                return { title: r.title || '未命名报告', content: r.content || '', type: 'report', source: 'report',
                         date: r.date, createdAt: r.createdAt, id: 'rpt-' + (r.id != null ? r.id : '') };   // 【2026-09-22】带上时间，供列表排序
            });
            window._dsMaterialCache = (materials || []).concat(reportItems);
            dsRenderMaterialList(window._dsMaterialCache);
        } catch(e) {
            list.innerHTML = '<div style="text-align:center;padding:20px;color:#dc2626;">加载失败：' + (e.message||'资料库为空') + '</div>';
        }
    };

    // ==================== 【2026-09-22】「写作资料库」弹窗：统一时间口径 + 按类型分块 ====================
    //  背景：这个弹窗（对话里附加参考资料用）列表既不排序，也不分块；而且
    //   ① 类型标签只看 `m.type`，而资料库条目用的是 `matType` → 所有资料都显示成"📎 资料"；
    //   ② 类型筛选同样只比 `m.type` → 选任何类型都筛不出资料；
    //   ③ 排序键缺失（旧记录/模块生成的资料没有 importAt）→ `NaN` 比较 → 顺序随机。
    //  这里把口径与「智能写作」模块对齐（`window.wrByTimeDesc`），并保留本地兜底 ——
    //  对话模块不应硬依赖写作模块的加载。
    function dsItemTime(o) {
        if (!o) return 0;
        var v = o.importAt || o.createdAt || o.date || o.datetime || o.timestamp || o.ts || o.updatedAt;
        if (typeof v === 'string') { var t = Date.parse(v); return isNaN(t) ? 0 : t; }
        return (typeof v === 'number' && isFinite(v)) ? v : 0;
    }
    function dsByTimeDesc(a, b) {
        if (typeof window.wrByTimeDesc === 'function') return window.wrByTimeDesc(a, b);
        var d = dsItemTime(b) - dsItemTime(a);
        if (d) return d;
        return String((b && b.id) == null ? '' : b.id).localeCompare(String((a && a.id) == null ? '' : a.id));
    }

    window.dsFilterMaterials = function() {
        var keyword = (document.getElementById('ds-material-search')?.value || '').trim().toLowerCase();
        var type = document.getElementById('ds-material-type-filter')?.value || '';
        var filtered = window._dsMaterialCache.filter(function(m) {
            var matchKw = !keyword || (m.title||'').toLowerCase().indexOf(keyword) !== -1 || (m.content||'').toLowerCase().indexOf(keyword) !== -1;
            var matchType = !type || (m.matType || m.type || '') === type;   // 资料库条目是 matType，历史报告是 type
            return matchKw && matchType;
        });
        // 【2026-09-22】时间倒序（最近在最上）——排序放在渲染前，渲染里的复选框按"下标"取项，必须同序
        filtered.sort(dsByTimeDesc);
        dsRenderMaterialList(filtered);
    };

    function dsMaterialEsc(s) {
        if (typeof window.escapeHtml === 'function') return window.escapeHtml(s);
        return String(s == null ? '' : s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
    }

    function dsRenderMaterialList(items) {
        var list = document.getElementById('ds-material-list');
        if (!list) return;
        // 【2026-09-22】就地按时间倒序：下面的复选框用"下标"取项（items[cb.value]），
        //   所以必须让渲染顺序与 items 顺序一致（初次进入列表没走 dsFilterMaterials，也要排到）
        items.sort(dsByTimeDesc);
        if (!items.length) {
            list.innerHTML = '<div style="text-align:center;padding:20px;color:var(--text-secondary);">没有匹配的资料</div>';
            return;
        }
        var typeMap = { report:'📄 写作报告', history:'📄 历史报告', inspect:'🔍 检查信息', fault:'⚠️ 故障报告',
                        stats:'📊 故障统计', dispatch:'📢 通报文电', bulletin:'📢 通报', meeting:'🗒️ 会议纪要',
                        template:'📋 模版', notice:'📢 通报', other:'📎 其它' };
        var ORDER = ['report', 'history', 'inspect', 'fault', 'stats', 'dispatch', 'bulletin', 'meeting', 'template', 'notice', 'other'];
        // 取前 50 条（已是最新的 50 条），按类型归块；保留原下标用于回填选中项
        var buckets = {}, keys = [];
        items.slice(0, 50).forEach(function(m, i) {
            var k = m.matType || m.type || 'other';
            if (!typeMap[k]) k = 'other';
            if (!buckets[k]) { buckets[k] = []; keys.push(k); }
            buckets[k].push({ m: m, i: i });
        });
        keys.sort(function(a, b) {
            var ia = ORDER.indexOf(a), ib = ORDER.indexOf(b);
            return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
        });
        var html = '';
        keys.forEach(function(k) {
            // 只有一种类型时不加组头，避免多余噪音
            if (keys.length > 1) {
                html += '<div style="padding:7px 2px 2px;font-size:0.75rem;font-weight:700;color:var(--primary);">'
                    + typeMap[k] + ' · ' + buckets[k].length + ' 条</div>';
            }
            buckets[k].forEach(function(row) {
                var m = row.m, i = row.i;
                var typeLabel = typeMap[k] || '📎 资料';
                // 资料正文来自用户导入的 txt/docx/xlsx/pdf，标题也可能来自文件名，必须转义
                var title = dsMaterialEsc((m.title || '无标题').slice(0, 60));
                html += '<label style="display:flex;align-items:flex-start;gap:8px;padding:10px;background:var(--card-bg);border-radius:8px;cursor:pointer;border:1px solid var(--border);" onmouseover="this.style.background=\'var(--primary-light)\'" onmouseout="this.style.background=\'var(--card-bg)\'">'
                    + '<input type="checkbox" value="'+i+'" class="ds-mat-cb" style="margin-top:2px;flex-shrink:0;">'
                    + '<div style="flex:1;min-width:0;"><div style="font-size:0.82rem;font-weight:500;">'+typeLabel+' ' + (title||'无标题') + '</div>'
                    + '<div style="font-size:0.72rem;color:var(--text-secondary);margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + dsMaterialEsc((m.content||'').slice(0,80)) + '</div></div>'
                    + '</label>';
            });
        });
        list.innerHTML = html;
        document.getElementById('ds-material-confirm').onclick = function() {
            var cbs = document.querySelectorAll('.ds-mat-cb:checked');
            var selected = [];
            cbs.forEach(function(cb) { selected.push(items[parseInt(cb.value)]); });
            if (!selected.length) { alert('请至少选择一项资料'); return; }
            selected.forEach(function(m) {
                var text = (m.content || '').slice(0, 4000);
                window._dsAttachments = window._dsAttachments || [];
                window._dsAttachments.push({ name: m.title || '写作资料', text: text, source: 'material' });
                var inputEl = document.getElementById('ds-user-input');
                if (inputEl) { inputEl.value = (inputEl.value||'') + ' [📚 ' + (m.title||'资料') + '] '; }
            });
            document.getElementById('ds-material-modal').style.display = 'none';
        };
    }

    // ---- 文件读取器 ----
    window.dsReadTextFile = function(file) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = e => resolve(e.target.result || '');
            reader.onerror = () => reject(new Error('文件读取失败'));
            reader.readAsText(file, 'UTF-8');
        });
    };

    // 文本文件读取：自动识别 UTF-8 / GBK(GB2312)，避免中文 Windows 导出的 .txt/.csv 读成乱码
    window.dsReadTextFileAutoEnc = function(file) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = function(e) {
                const buf = new Uint8Array(e.target.result);
                let utf8;
                try { utf8 = new TextDecoder('utf-8', { fatal: false }).decode(buf); }
                catch (e) { utf8 = ''; }
                // 若 UTF-8 解码出现大量替换字符(乱码特征)，尝试 GBK 回退
                const utf8Bad = (utf8.match(/�/g) || []).length;
                if (utf8Bad > 0) {
                    try {
                        const gbk = new TextDecoder('gbk').decode(buf);
                        const gbkBad = (gbk.match(/�/g) || []).length;
                        if (gbkBad < utf8Bad) { resolve(gbk); return; }
                    } catch (e) { /* 忽略，使用 utf8 */ }
                }
                resolve(utf8);
            };
            reader.onerror = () => reject(new Error('文件读取失败'));
            reader.readAsArrayBuffer(file);
        });
    };

    window.dsReadWordFile = function(file) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = function(e) {
                try {
                    const arrayBuffer = e.target.result;
                    mammoth.convertToHtml({ arrayBuffer: arrayBuffer })
                        .then(function(result) {
                            const text = window._htmlToTextPreserveTables ? window._htmlToTextPreserveTables(result.value || '') : (result.value || '').replace(/<[^>]+>/g, '\n').trim();
                            if (!text) {
                                resolve('[Word文件] ' + file.name + '\n\n未能提取到文本内容。\n文件大小：' + (file.size / 1024).toFixed(2) + ' KB');
                            } else {
                                resolve('[Word文件] ' + file.name + '\n\n' + text);
                            }
                        })
                        .catch(function(err) {
                            reject(new Error('Word文件解析失败：' + (err.message || '未知错误')));
                        });
                } catch (err) {
                    reject(new Error('Word文件解析失败'));
                }
            };
            reader.onerror = () => reject(new Error('文件读取失败'));
            reader.readAsArrayBuffer(file);
        });
    };

    window.dsReadExcelFile = function(file) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = function(e) {
                try {
                    const data = new Uint8Array(e.target.result);
                    const workbook = XLSX.read(data, { type: 'array' });
                    let result = '[Excel文件] ' + file.name + '\n\n';
                    workbook.SheetNames.forEach(function(sheetName, index) {
                        const worksheet = workbook.Sheets[sheetName];
                        const jsonData = XLSX.utils.sheet_to_json(worksheet, { header: 1 });
                        if (jsonData.length > 0) {
                            result += '--- 工作表 ' + (index + 1) + '：' + sheetName + ' ---\n';
                            const maxRows = 100;
                            const displayData = jsonData.slice(0, maxRows);
                            displayData.forEach(function(row) {
                                const rowText = row.map(function(cell) {
                                    if (cell === null || cell === undefined) return '';
                                    return String(cell).substring(0, 200);
                                }).join(' | ');
                                result += rowText + '\n';
                            });
                            if (jsonData.length > maxRows) result += '\n...[仅显示前' + maxRows + '行]\n';
                            result += '\n';
                        }
                    });
                    if (workbook.SheetNames.length === 0) result += '该文件没有可读取的工作表。\n';
                    resolve(result);
                } catch (err) {
                    reject(new Error('Excel文件解析失败：' + (err.message || '未知错误')));
                }
            };
            reader.onerror = () => reject(new Error('文件读取失败'));
            reader.readAsArrayBuffer(file);
        });
    };

    // 图片附件：读取为 dataURL，按比例压缩（P7 修复：避免原图 base64 过大导致存储/接口超限），获取尺寸
    window.dsReadImageFile = function(file) {
        return new Promise((resolve) => {
            const reader = new FileReader();
            reader.onload = function(e) {
                const dataUrl = e.target.result;
                const img = new Image();
                img.onload = function() {
                    try {
                        // 压缩：最长边限制为 1280，输出 JPEG（质量 0.82），显著降低体积
                        const MAX_EDGE = 1280;
                        let { width, height } = img;
                        if (width > MAX_EDGE || height > MAX_EDGE) {
                            const scale = Math.min(MAX_EDGE / width, MAX_EDGE / height);
                            width = Math.round(width * scale);
                            height = Math.round(height * scale);
                        }
                        const canvas = document.createElement('canvas');
                        canvas.width = width; canvas.height = height;
                        const ctx = canvas.getContext('2d');
                        ctx.drawImage(img, 0, 0, width, height);
                        const compressed = canvas.toDataURL('image/jpeg', 0.82);
                        file.attachDataUrl = compressed;
                        const sizeKB = (file.size / 1024).toFixed(0);
                        const compKB = Math.round((compressed.length * 3) / 4 / 1024);
                        const desc = '[图片附件] ' + file.name + '（原 ' + img.width + '×' + img.height + '，' + sizeKB + 'KB；处理后 ' + width + '×' + height + '，约 ' + compKB + 'KB）\n'
                            + '图片已作为视觉内容附上，请结合图片理解用户问题。';
                        resolve(desc);
                    } catch (err) {
                        // 压缩失败（如 canvas 受限）则回退原始 dataURL
                        file.attachDataUrl = dataUrl;
                        const sizeKB = (file.size / 1024).toFixed(0);
                        resolve('[图片附件] ' + file.name + '（' + img.width + '×' + img.height + '，' + sizeKB + 'KB）\n图片已作为视觉内容附上，请结合图片理解用户问题。');
                    }
                };
                img.onerror = function() {
                    resolve('[图片附件] ' + file.name + '（尺寸未知）');
                };
                img.src = dataUrl;
            };
            reader.onerror = function() { resolve('[图片附件] ' + file.name + '（读取失败）'); };
            reader.readAsDataURL(file);
        });
    };

    // 渲染已附加文件的预览（图片缩略图 + 文件标签），点击可移除
    window.dsRenderAttachPreview = function() {
        var box = document.getElementById('ds-attach-preview');
        if (!box) return;
        var items = window._dsAttachments || [];
        box.innerHTML = '';
        var has = false;
        items.forEach(function(a, idx) {
            if (!a) return;
            has = true;
            var tag = document.createElement('div');
            tag.style.cssText = 'display:flex;align-items:center;gap:4px;background:var(--card-bg);border:1px solid var(--border);border-radius:8px;padding:3px 6px;font-size:0.72rem;color:var(--text-secondary);max-width:160px;';
            if (a.isImage && a.dataUrl) {
                var thumb = document.createElement('img');
                thumb.src = a.dataUrl;
                thumb.style.cssText = 'width:22px;height:22px;object-fit:cover;border-radius:4px;flex-shrink:0;';
                tag.appendChild(thumb);
            }
            var label = document.createElement('span');
            label.textContent = (a.isImage ? '🖼️ ' : '📎 ') + (a.name || '附件');
            label.style.cssText = 'overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
            tag.appendChild(label);
            // 【2026-10-07 用户需求】把"上传文件转成规范格式"做成**对话内可达的出口** ——
            //   用户口径："转化的文件主要 PDF、OFD、TXT，一般都是转换成 DOCX/Excel"，且要"能在智能对话中调用"。
            //   设计：① 只对**确实可转换的文档**显示（图片不显示，避免点了没用）；
            //        ② 两个出口各司其职 —— 📥 规范 DOCX（公文格式，PDF/OFD/TXT 都行）；
            //           📊 Excel（**仅当文档有表格结构**；没有表格会如实说明，绝不产出没意义的表）；
            //        ③ 转换走共用件 FmtConv（用 _file 原始引用），全程本地、不上传；
            //           失败**如实报原因**（含"未识别到表格"这类），不留哑按钮。
            try {
                if (a._file && window.FmtConv && typeof window.FmtConv.isSupported === 'function' && window.FmtConv.isSupported(a.name)) {
                    var _mkConvBtn = function (icon, title, target) {
                        var b = document.createElement('span');
                        b.textContent = icon;
                        b.title = title;
                        b.style.cssText = 'cursor:pointer;flex-shrink:0;padding:0 2px;';
                        b.onclick = async function() {
                            if (b.dataset.busy === '1') return;
                            b.dataset.busy = '1';
                            var _old = b.textContent;
                            b.textContent = '⏳';
                            try {
                                var r = await window.FmtConv.convertAndSave(a._file, {
                                    title: String(a.name || '').replace(/\.[^/.]+$/, ''),
                                    target: target
                                });
                                var _ok = !!(r && r.ok);
                                var _m = _ok
                                    ? ('✅ 已转成 ' + (target === 'xlsx' ? 'Excel' : 'DOCX') + '：' + r.name + (r.note ? '（' + r.note + '）' : ''))
                                    : ('未转换：' + ((r && r.note) || '未知原因'));
                                if (window.showToast) window.showToast(_m, !_ok, _ok ? 6000 : 9000); else alert(_m);
                            } catch (e) {
                                var _m2 = '转换异常：' + ((e && e.message) || e);
                                if (window.showToast) window.showToast(_m2, true, 8000); else alert(_m2);
                            } finally {
                                b.dataset.busy = '0';
                                b.textContent = _old;
                            }
                        };
                        return b;
                    };
                    tag.appendChild(_mkConvBtn('📥', '转成规范 DOCX（本地转换，不上传）', 'docx'));
                    tag.appendChild(_mkConvBtn('📊', '转成 Excel（仅当文档含表格；本地转换，不上传）', 'xlsx'));
                }
            } catch (e) {}
            var x = document.createElement('span');
            x.textContent = '✕';
            x.style.cssText = 'cursor:pointer;color:#94a3b8;flex-shrink:0;padding:0 2px;';
            x.onclick = function() { window.dsRemoveAttach(idx); };
            tag.appendChild(x);
            box.appendChild(tag);
        });
        box.style.display = has ? 'flex' : 'none';
        // 附件增删后同步发送按钮启用态（DeepSeek：仅有附件也可发送）
        if (typeof window.dsSyncSendState === 'function') window.dsSyncSendState();
    };

    window.dsReadPdfFile = function(file) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = async function(e) {
                try {
                    const typedarray = new Uint8Array(e.target.result);
                    pdfjsLib.GlobalWorkerOptions.workerSrc = 'src/js/vendor/pdf.worker.min.js';
                    const pdf = await pdfjsLib.getDocument(typedarray).promise;
                    let result = '[PDF文件] ' + file.name + '\n\n总页数：' + pdf.numPages + '\n\n';
                    const maxPages = Math.min(pdf.numPages, 10);
                    let _rotatedDropped = 0;
                    // 【2026-10-03 用户报】原实现：① 直接拼 item.str（拉丁词之间**不加空格**会粘成一个词）；
                    //   ② 每换一行就 '\n' ⇒ **段内全是硬回车**（甚至一个字也算一段）；
                    //   ③ 倾斜文字（水印常见画法）照收不误。
                    //   现在统一交给 ImportLayout：行内按 X 拼（中文不加空格/拉丁补空格）、按 Y 聚行、
                    //   再按标点/行距/条款头/缩进还原自然段；**倾斜行按水印丢弃并计数**。
                    const _lay = window.ImportLayout;
                    if (_lay && _lay.buildDocument) {
                        // 先收集全部页的 items，再一次性 buildDocument：
                        //   行内清空格 + 聚行 + 段落还原 + 丢弃倾斜水印 + **跨页**去页码/页眉页脚/打印水印戳
                        //   （跨页判定必须拿到所有页才能做，逐页处理是判不出来的）
                        const _allItems = [];
                        for (let i = 1; i <= maxPages; i++) {
                            const _p = await pdf.getPage(i);
                            const _tc = await _p.getTextContent();
                            _allItems.push(_tc.items);
                        }
                        const _doc = _lay.buildDocument(_allItems);
                        _rotatedDropped = _doc.rotatedDropped || 0;
                        result += '正文（已还原排版）：\n\n' + _doc.text + '\n';
                        if (_doc.removed && _doc.removed.length) {
                            result += '\n[已清理 ' + _doc.removed.length + ' 处页眉页脚/页码/水印戳]\n';
                        }
                    } else {
                        for (let i = 1; i <= maxPages; i++) {
                            const page = await pdf.getPage(i);
                            const textContent = await page.getTextContent();
                            let pageText = '';
                            const lastY = { value: -Infinity };
                            textContent.items.forEach(function (item) {
                                if (item.str) {
                                    if (lastY.value !== -Infinity && Math.abs(lastY.value - item.transform[5]) > 5) pageText += '\n';
                                    pageText += item.str;
                                    lastY.value = item.transform[5];
                                }
                            });
                            result += '--- 第 ' + i + ' 页 ---\n' + pageText + '\n\n';
                        }
                    }
                    if (_rotatedDropped > 0) result += '[已忽略 ' + _rotatedDropped + ' 行倾斜文字（通常为水印）]\n';
                    if (pdf.numPages > maxPages) result += '...[仅显示前' + maxPages + '页]\n';
                    resolve(result);
                } catch (err) {
                    reject(new Error('PDF文件解析失败：' + (err.message || '未知错误')));
                }
            };
            reader.onerror = () => reject(new Error('文件读取失败'));
            reader.readAsArrayBuffer(file);
        });
    };

    window.dsRemoveAttach = function(idx, tagEl) {
        var removed = window._dsAttachments[idx];
        if (removed) {
            // 同步从输入框移除对应的 [图标 文件名] 标签文本
            var inputEl = document.getElementById('ds-user-input');
            if (inputEl && removed.name) {
                inputEl.value = inputEl.value.replace(new RegExp('\\[[^\\]]*' + removed.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\]', 'g'), '').trim();
            }
        }
        if (window._dsAttachments[idx]) window._dsAttachments[idx] = null;
        if (tagEl) tagEl.remove();
        dsRenderAttachPreview();
    };

    /**
     * 构建「多模态消息」：把附件中的图片转为真正的 image_url 内容块，文本附件保留为纯文本。
     * 集中处理视觉模型的图文输入，避免各模块重复拼装。
     * @param {string} text 用户文本（可为空）
     * @param {Array} attachments window._dsAttachments 过滤后的有效附件
     * @returns {{role:'user', content: (string|Array)}} 可直接塞进 messages 的 user 消息
     *   - 无图片：content 为字符串（兼容现有纯文本逻辑）
     *   - 有图片：content 为 [{type:'text',text},{type:'image_url',image_url:{url:dataUrl}}]
     */
    window.buildVisionMessages = function(text, attachments) {
        var attach = (attachments || []).filter(Boolean);
        var images = attach.filter(function(a) { return a.isImage && a.dataUrl; });
        var texts = attach.filter(function(a) { return !(a.isImage && a.dataUrl); });
        // 无图片：维持原纯文本拼装（与历史/重新生成逻辑兼容）
        if (!images.length) {
            var plain = text || '';
            if (texts.length) {
                plain += '\n\n【附件内容】\n' + texts.map(function(a) { return '--- 文件：' + a.name + ' ---\n' + a.text; }).join('\n\n');
            }
            return { role: 'user', content: plain };
        }
        // 有图片：构造 content 数组（OpenAI 多模态格式）
        var blocks = [];
        var imgDesc = images.map(function(a) { return a.name; }).join('、');
        var lead = (text || '') + (texts.length ? '\n\n【附件文本】\n' + texts.map(function(a){ return '--- 文件：' + a.name + ' ---\n' + a.text; }).join('\n\n') : '');
        if (lead.trim()) blocks.push({ type: 'text', text: lead + (lead.trim() ? '\n\n（附图片：' + imgDesc + '，请结合图片内容理解）' : '') });
        else blocks.push({ type: 'text', text: '（附图片：' + imgDesc + '，请结合图片内容理解）' });
        images.forEach(function(a) {
            blocks.push({ type: 'image_url', image_url: { url: a.dataUrl } });
        });
        return { role: 'user', content: blocks };
    };

    // 当前模型是否支持 FIM（中间补全）。视觉/非 DeepSeek 等实验模型不支持。
    window.dsModelSupportsFim = function(modelName) {
        var m = String(modelName || '');
        if (/vision|exp|exp$/i.test(m)) return false;       // 视觉实验模型明确不支持
        if (/deepseek/i.test(m)) return true;                // DeepSeek 文本模型支持
        return false;                                        // 其他供应商保守关闭
    };

    // 当前模型是否具备图像理解（视觉）能力。
    // 1) 模型名含明确视觉/多模态标识 → 支持看图
    // 2) 主流已知视觉模型（Gemini / Claude / 4o / 4v / vl / vision 等）→ 支持看图
    // 3) DeepSeek：自 V4.1 Flash 起原生支持多模态，故 flash 系支持看图；
    //    deepseek-v4-pro 等纯文本模型仍不支持（送 image_url 会被 400 拒绝）
    // 4) 其他未知模型 → 乐观按支持处理：发现图片后自动以多模态送审
    //    （若接口不支持会返回明确错误，而非静默丢图——解决「有时不识别图片」）
    window.dsModelSupportsVision = function(modelName) {
        var m = String(modelName || '').toLowerCase();
        if (!m) return false;
        if (/vision|visual|multimodal|vlm|\bvl\b|omni|4o|4v|gpt-4v|qwen-vl|internvl|glm-4v|minicpm|llava|step-1v|yi-vl|kimi.*vision/i.test(m)) return true;
        if (/gemini|claude/i.test(m)) return true;           // Gemini / Claude 全系支持看图
        if (/deepseek/i.test(m)) {
            // V4.1 Flash（规范名 deepseek-flash）原生多模态，可直接看图；
            // 旧名 deepseek-v4-flash / deepseek-v4-flash-vision-exp 已被官方路由到 V4.1 Flash，同样具备视觉能力，
            // 这里一并放行，避免老配置（未迁移）用户的图片被静默降级为纯文本。
            // deepseek-v4-pro 等纯文本模型仍不支持；（deepseek-chat / deepseek-reasoner 已于 2026-07-24 退役）
            // 兼容写法：除规范名 deepseek-flash 外，用户/网关也可能填 deepseek-v4.1、deepseek-v4.1-flash、
            // deepseek-4.1 之类变体，一律按支持看图处理（宁可多送图由接口报明确错误，也不要静默降级为纯文本）。
            return /flash|4\.1/i.test(m);
        }
        return true;                                         // 其他供应商：自动识别图片（乐观）
    };

    // ============ 跨模块共享：思考模式参数 / API 错误提示 ============
    // DeepSeek V4 起「思考模式默认开启（effort=high）」，且**思考模式下 temperature 不生效**。
    // 这带来两个跨模块影响：
    //   1) 结构化任务（对规 JSON / FIM 补全）必须显式关闭，否则思维链会吃掉输出预算甚至被拒；
    //   2) 该参数只有 DeepSeek 端点认识，其它供应商（OpenAI 等）收到未知参数会直接 400。
    // 故所有智能模块统一经此函数取参，避免各自硬编码。
    //   opts.mode   'auto'（默认，跟随设置页档位）| 'on' | 'off'
    //   opts.effort 显式指定思考强度 low/high/max（传了就优先用，跳过自动判定）
    //   opts.text   本轮用户问题原文。**仅智能对话传入**：传入时按问题复杂度自动分级；
    //               对规/写作/研判/智能体等本就是深度任务的调用方不传，恒定 high，行为与改造前完全一致。
    //   opts.apiUrl / opts.model 可显式覆盖（默认读 localStorage）
    // 返回可直接 Object.assign 进请求体的片段；非 DeepSeek 端点返回 {}。
    //
    // 设置页「思考模式」三档（localStorage ds_thinking，v3.62 起）：
    //   'auto'（默认）按问题自动分级 | 'on' 始终开启（high）| 'off' 始终关闭
    // 兼容 v3.61 及以前的布尔存储：'1' → on，'0' → off，老用户配置自动延续、无需迁移。
    window.dsThinkingLevel = function() {
        var raw = null;
        try { raw = localStorage.getItem('ds_thinking'); } catch (e) {}
        if (raw === 'off' || raw === 'on' || raw === 'auto') return raw;
        if (raw === '1') return 'on';
        if (raw === '0') return 'off';
        return 'auto';
    };

    // 按问题复杂度自动分级思考强度（仅智能对话调用）。
    // 设计原则与 v3.58「联网按需检索」一致：**能力可用 ≠ 每次都跑满**。
    // 闲聊/润色/常识类问题开 high 思考，只会拖慢响应、白烧推理 token，对答案质量毫无帮助。
    // 返回 'off'（连思考都不必开，最快）| 'low' | 'high'
    window.dsAutoThinkingEffort = function(text) {
        var q = String(text == null ? '' : text).trim();
        if (!q) return 'high';                              // 无文本：保守给 high，避免误降级
        // 1) 纯问候/寒暄/致谢（整句锚定，避免「你好，帮我分析下」被误伤）：连思考都不必开
        if (/^(你好|您好|hi|hello|hey|在吗|在么|在不在|早|早上好|中午好|下午好|晚上好|晚安|谢谢|感谢|多谢|辛苦|好的|收到|明白|ok|okay|测试|你是谁|你叫什么|你能做什么|你会做什么|介绍一下你)[\s,，.。!！?？~～、]*$/i.test(q)) return 'off';
        // 2) 需要多步推理 / 交叉核对 / 逐条比对：这类才是 high 思考真正产生价值的场景
        if (/分析|研判|评估|诊断|定级|对比|比较|核实|排查|推理|论证|对规|合规|依据|条款|引用|出处|根因|原因|为什么|怎么会|整改|措施|建议|方案|报告|总结|汇总|梳理|归纳|深度|详细|全面|系统|风险|隐患|趋势|预测|判断|审核|审查|逐条|逐项|复核|佐证|矛盾|是否构成|违反了|对应哪|怎么定性/.test(q)) return 'high';
        // 3) 明确的轻量任务：直接作答即可，low 强度足够
        if (/翻译|润色|改写|缩写|扩写|纠错|改错|排版|格式|转换|是什么|什么意思|定义|解释一下|介绍一下|列举|列出|怎么读|怎么念|拼写|算一下|计算一下/.test(q)) return 'low';
        // 4) 兜底：长文本通常是复杂任务给 high，短问题给 low
        return q.length >= 80 ? 'high' : 'low';
    };

    window.dsThinkingParam = function(opts) {
        opts = opts || {};
        var apiUrl = opts.apiUrl ? window.dsNormalizeApiUrl(opts.apiUrl) : window.dsGetApiUrl();
        var model  = opts.model  || localStorage.getItem('ds_model_v1') || 'deepseek-flash';
        var isDeepSeek = /deepseek/i.test(String(model)) || /(^|\.)deepseek\.com$/i.test((function() {
            try { return new URL(apiUrl).host; } catch (e) { return ''; }
        })());
        if (!isDeepSeek) return {};                        // 其它供应商：不发送该参数，避免 400
        if (opts.mode === 'off') return { thinking: { type: 'disabled' } };
        var level = window.dsThinkingLevel();
        if (opts.mode !== 'on' && level === 'off') {
            return { thinking: { type: 'disabled' } };      // 设置页「始终关闭」
        }
        var effort = opts.effort;
        if (!effort) {
            if (level === 'auto' && opts.text) {
                // 自动档：按问题复杂度分级；判定为 off 时连思考都不开启
                var auto = window.dsAutoThinkingEffort(opts.text);
                if (auto === 'off') return { thinking: { type: 'disabled' } };
                effort = auto;
            } else {
                effort = 'high';                           // 始终开启 / 深度任务模块（未传 text）
            }
        }
        if (['low', 'medium', 'high', 'max'].indexOf(effort) < 0) effort = 'high';
        if (effort === 'medium') effort = 'high';           // 官方映射：medium → high
        return { thinking: { type: 'enabled' }, reasoning_effort: effort };
    };

    // 统一的 API 错误提示。官方错误码只有 400/401/402/422/429/500/503（**没有 404**，
    // 「模型不存在」也是以 400 返回的），此前各模块只映射了 401/402/403/429，导致
    // 400/422（最常见：模型名退役、参数不被接受）只显示裸「HTTP 400」，难以定位。
    window.dsAiHttpError = function(status, detail) {
        var tips = {
            400: '请求被拒绝（400）：多数是模型名无效或参数不被接受',
            401: 'API Key 无效或未授权（401）',
            402: '账户余额不足（402）',
            403: '无访问权限（403）',
            404: '地址不存在（404）：说明请求的【路径】在服务器上不存在 —— 绝大多数是 API 地址写错或不完整。'
               + '官方 API 对业务错误（模型名无效、参数不对）一律用 400 返回，所以出现 404 时基本可以断定'
               + '地址本身不对：少了结尾的 s（/chat/completion）、少了 /chat/completions 路径、'
               + '或漏写 https:// 被当成相对路径打到本站。请在「设置 → API 配置」核对地址，'
               + 'DeepSeek 应为 https://api.deepseek.com/chat/completions',
            405: '请求方式不被接受（405）：地址可能指向了非对话接口',
            422: '请求参数错误（422）',
            429: '请求过于频繁，请稍后再试（429）',
            500: 'DeepSeek 服务端故障（500），请稍后重试',
            503: '服务繁忙（503），请稍后重试'
        };
        var base = tips[status] || ('请求失败（HTTP ' + status + '）');
        var d = (detail === undefined || detail === null) ? '' : String(detail).trim();
        if (d) { d = d.replace(/\s+/g, ' ').slice(0, 200); base += '：' + d; }
        if (status === 400) base += '（当前模型 ' + (localStorage.getItem('ds_model_v1') || '未设置') + '，可在「设置 → API 配置」中切换为 deepseek-flash）';
        // 404/405 直接把「实际用的地址」摊开给用户看 —— 这类故障几乎都是地址问题，
        // 而地址是分设备存的，报错里不带地址时用户与开发者都无从判断。
        // 若库里存的值与归一化后的值不同，两个都显示（用户一眼能看出是自己少写了 https:// 还是少写了路径）。
        if (status === 404 || status === 405) {
            var _raw = '';
            try { _raw = (localStorage.getItem('ds_api_url_v1') || '').trim(); } catch (e) {}
            var _fixed = window.dsNormalizeApiUrl(_raw);
            base += '（当前 API 地址：' + (_raw || '未设置（用默认 https://api.deepseek.com/chat/completions）');
            if (_fixed && _raw && _fixed !== _raw) base += '；已自动按 ' + _fixed + ' 请求';
            else if (_fixed && _raw) base += '；请求地址 ' + _fixed;
            base += '）';
        }
        return base;
    };

    // ============ 跨模块共享：非流式「一次性」AI 调用（2026-09-18） ============
    // 为什么要有它：写作模块的 wrCallOnce 是最好的一次性调用实现（超时 + 降级 + 关思考），
    // 但它藏在 IIFE 里没挂 window，别的模块（如智能对规）只能各自裸 fetch（且没有超时）。
    // 现在统一到这里：所有"短任务"（改写/纠错/挑条款/归类表）共用同一套 Key/模型/超时/错误文案。
    // 约定：**不抛异常**，失败返回 { ok:false, error }，由调用方降级；不要再在别处读 ds_api_key_v1。
    //   opts.temperature 默认 0.2 | opts.maxTokens 默认 2000 | opts.timeoutMs 默认 90000
    //   opts.thinking=true → 走设置页思考档位（默认关闭思考：短任务开思维链只会白烧预算、拖慢响应）
    window.dsCallOnce = async function (sysPrompt, userPrompt, opts) {
        opts = opts || {};
        var apiKey = '';
        try { apiKey = localStorage.getItem('ds_api_key_v1') || ''; } catch (e) {}
        if (!apiKey) return { ok: false, error: 'no-key' };
        var apiUrl = window.dsGetApiUrl ? window.dsGetApiUrl() : '';
        var model = localStorage.getItem('ds_model_v1') || 'deepseek-flash';
        var body = {
            model: model,
            messages: [
                { role: 'system', content: String(sysPrompt == null ? '' : sysPrompt) },
                { role: 'user', content: String(userPrompt == null ? '' : userPrompt) }
            ],
            stream: false,
            temperature: (opts.temperature != null ? opts.temperature : 0.2),
            max_tokens: opts.maxTokens || 2000
        };
        // 思考模式：默认关闭；opts.thinking=true 时按设置页档位（auto 档可传 opts.text 自动分级）。
        // 非 DeepSeek 端点由 dsThinkingParam 返回 {} —— 绝不硬塞未知参数（会被 400 拒绝）。
        Object.assign(body, opts.thinking
            ? window.dsThinkingParam({ apiUrl: apiUrl, model: model, mode: opts.thinkingMode || 'auto', text: opts.text })
            : window.dsThinkingParam({ apiUrl: apiUrl, model: model, mode: 'off' }));
        // 支持调用方传入 opts.signal（如写实"一键修改"的整批停止按钮）：外部 abort 会传导到本次请求
        var ctrl = (typeof AbortController !== 'undefined') ? new AbortController() : null;
        var ext = opts.signal || null;
        if (ext && ext.aborted) return { ok: false, error: 'aborted' };
        if (ext && ctrl && typeof ext.addEventListener === 'function') {
            try { ext.addEventListener('abort', function () { try { ctrl.abort(); } catch (e) {} }); } catch (e) {}
        }
        var timedOut = false;
        var to = ctrl ? setTimeout(function () { timedOut = true; try { ctrl.abort(); } catch (e) {} }, opts.timeoutMs || 90000) : null;
        try {
            var resp = await fetch(apiUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + apiKey },
                body: JSON.stringify(body),
                signal: ctrl ? ctrl.signal : (ext || undefined)
            });
            if (!resp.ok) {
                var detail = '';
                try { detail = await resp.text(); } catch (e) {}
                return { ok: false, status: resp.status, error: (window.dsAiHttpError ? window.dsAiHttpError(resp.status, detail) : ('HTTP ' + resp.status)) };
            }
            // 超时已经触发却仍拿到响应（个别环境 abort 不生效）→ 严格按超时处理，别让调用方以为成功
            if (timedOut || (ctrl && ctrl.signal && ctrl.signal.aborted) || (ext && ext.aborted)) return { ok: false, error: 'timeout' };
            var j = await resp.json();
            var c = j && j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
            if (!c) return { ok: false, error: 'empty' };
            return { ok: true, text: String(c) };
        } catch (e) {
            var msg = (e && e.name === 'AbortError') ? 'timeout' : ((e && e.message) || 'network');
            return { ok: false, error: msg };
        } finally { if (to) clearTimeout(to); }
    };

    // 宽松 JSON 解析（模型常见毛病：```json 包裹 / 前后带解释 / 尾逗号 / 只给了片段）
    // 与智能对规的容错思路一致，供"要求模型输出 JSON 结构"的模块共用；解析不出来返回 null。
    window.dsParseJsonLoose = function (text) {
        var s = String(text == null ? '' : text).trim();
        if (!s) return null;
        s = s.replace(/^```[a-zA-Z]*\s*/, '').replace(/```\s*$/, '').trim();
        try { return JSON.parse(s); } catch (e) {}
        var a = s.indexOf('{'), b = s.lastIndexOf('}');
        if (a >= 0 && b > a) {
            var core = s.slice(a, b + 1);
            try { return JSON.parse(core); } catch (e) {}
            try { return JSON.parse(core.replace(/,\s*([}\]])/g, '$1')); } catch (e) {}   // 尾逗号
        }
        return null;
    };

    // ============ 跨模块共享：非流式「联网搜索一次性调用」(2026-09-23) ============
    // 为什么要有它：联网检索此前只存在于「智能对话」的流式链路里（doubao.js 内联实现），
    //   别的模块（应急电话·车站天气）想"先问一次联网"只能自己裸写 fetch + 自己处理鉴权/通道。
    //   这里抽出最小可用版本：无 UI、非流式、**绝不抛异常**，失败一律返回 { ok:false, error } 由调用方降级。
    // 通道顺序与对话侧保持一致（见 doubao.js「Anthropic 兼容层才是真正执行服务端检索的通道」注释）：
    //   ① Anthropic 兼容层 POST /messages + tools:[{type:'web_search_20250305'}] —— DeepSeek 唯一真正联网的通道；
    //   ② Responses API + tools:[{type:'web_search'}] —— 其它供应商（OpenAI 等）用，DeepSeek 下官方会忽略检索。
    // 约定：**没有 Key / 通道不可用 / 未检索到内容 → 都返回 ok:false**，由调用方走保底。
    /**
     * 【2026-09-29 第 2 层·真抓取】阅读器代理通道：把任意网页取回为**干净 Markdown**。
     * 为什么用 r.jina.ai：① 浏览器端可直连（返回 `Access-Control-Allow-Origin: *`，故已加入 CSP connect-src）；
     *   ② 它自己做过正文抽取，输出 Markdown（标题/段落/列表/表格保留），比"去标签"干净得多；
     *   ③ 不消耗模型额度、结果可缓存。
     * 降级：离线 / 超时 / 限流 / 非 https → 返回 ok:false，由调用方退回"用模型定向读"（第 1 层）。
     * 返回 { ok, text, title, url, channel:'reader', bytes }
     */
    window.dsFetchPage = async function (url, opts) {
        opts = opts || {};
        var u = String(url || '').trim();
        if (!/^https?:\/\//i.test(u)) return { ok: false, error: 'bad-url' };
        if (navigator.onLine === false) return { ok: false, error: 'offline' };
        // 【熔断】阅读器在部分网络（如国内直连 r.jina.ai）会超时/被限流 ⇒ 不能每次都白等一轮超时：
        //   连续失败 2 次即"熔断"10 分钟，期间直接返回 reader-blocked，由调用方立刻走第 1 层（模型定向读）。
        var BK = '_ds_reader_breaker_v1';
        var bk = {};
        try { bk = JSON.parse(localStorage.getItem(BK) || '{}') || {}; } catch (e) { bk = {}; }
        if (bk.until && Date.now() < bk.until) return { ok: false, error: 'reader-blocked', url: u, until: bk.until };
        /** 记一次失败：连续 2 次即熔断 10 分钟（期间不再尝试阅读器，直接走第 1 层） */
        var _brkFail = function () {
            try {
                var f = (parseInt(bk.fails || '0', 10) || 0) + 1;
                var o = { fails: f };
                // 【2026-10-01】熔断窗口 10 → 30 分钟：实测该通道在部分网络"必失败"，
                //   10 分钟一过就再付两次超时的代价，收益为零；拉长到 30 分钟。
                if (f >= 2) { o.until = Date.now() + 30 * 60 * 1000; o.fails = 0; }
                localStorage.setItem(BK, JSON.stringify(o));
            } catch (e) {}
        };
        // 【2026-10-01 实测优化】默认超时 9000 → 6000：本机/国内网络实测直连 r.jina.ai 一律 12s 超时
        //   （两次 sample 都是 timeout，随后熔断），每次白等越短越好；能连通的网络 6s 也足够返回首页正文。
        var to = opts.timeoutMs || 6000;
        var cap = opts.maxChars || 20000;          // 单页正文上限（防止超长页把 system 撑爆）
        var ctrl = (typeof AbortController !== 'undefined') ? new AbortController() : null;
        var timer = ctrl ? setTimeout(function () { try { ctrl.abort(); } catch (e) {} }, to) : null;
        var endpoint = 'https://r.jina.ai/' + u;
        try {
            var r = await fetch(endpoint, {
                method: 'GET',
                headers: { 'Accept': 'text/plain, text/markdown;q=0.9, */*;q=0.5', 'X-Return-Format': 'markdown' },
                signal: ctrl ? ctrl.signal : undefined,
                credentials: 'omit'
            });
            if (!r.ok) { _brkFail(); return { ok: false, error: 'HTTP ' + r.status, url: u }; }
            var txt = await r.text();
            if (timer) clearTimeout(timer);
            if (!txt || txt.length < 80) { _brkFail(); return { ok: false, error: 'empty', url: u }; }
            // r.jina.ai 会在开头给出 `Title: …` / `URL Source: …` / `Markdown Content:` 元信息 —— 抽出来当标题，正文从 Markdown Content 起
            var title = '';
            var mt = txt.match(/^\s*Title:\s*(.+)$/m);
            if (mt) title = String(mt[1]).trim().slice(0, 120);
            var mc = txt.indexOf('Markdown Content:');
            if (mc > -1) txt = txt.slice(mc + 'Markdown Content:'.length);
            txt = txt.trim();
            var truncated = false;
            if (txt.length > cap) { txt = txt.slice(0, cap) + '\n\n（正文过长，已截断）'; truncated = true; }
            try { localStorage.setItem(BK, '{}'); } catch (e0) {}      // 成功即解除熔断
            return { ok: true, text: txt, title: title, url: u, channel: 'reader', bytes: txt.length, truncated: truncated };
        } catch (e) {
            if (timer) clearTimeout(timer);
            var msg = (e && e.name === 'AbortError') ? 'timeout' : String((e && e.message) || e);
            if (typeof _brkFail === 'function') _brkFail();
            return { ok: false, error: msg, url: u };
        }
    };

    /**
     * 【2026-09-29】链接**预读**：把用户给的网址真正读一次，产出可注入 system 的摘录。
     * 为什么要它：此前"读链接"完全外包给服务端的**按关键词检索** —— 检索 ≠ 读该页；
     *   模型检索不到时就容易"顺着域名猜内容"（比承认读不到更糟）。这里改为：
     *   用现有联网通道做一次「以该网址为目标」的定向读取，把真正的正文摘录并入本轮 system。
     * 为什么不前端抓取：CSP 的 connect-src 是白名单（index.html:63-73），直连 CORS 代理会被硬拦；
     *   iframe 也不行（跨域读不到 contentDocument）。本层**零新依赖、零新域名**。
     * 缓存：同一网址 30 分钟内不重复读（省时间与额度）；最多读 2 个链接（余下在摘录里列名说明）。
     * 返回 { ok, digest, links:[{url,ok,chars}], fromCache, reason }
     */
    window.dsLinkPreRead = async function (links, question, opts) {
        opts = opts || {};
        var urls = (Array.isArray(links) ? links : []).filter(Boolean).map(String);
        var seen = {}, uniq = [];
        urls.forEach(function (u) { var k = u.toLowerCase(); if (!seen[k]) { seen[k] = 1; uniq.push(u); } });
        if (!uniq.length) return { ok: false, reason: 'no-link' };
        var MAX = opts.maxLinks || 4;                 // 【第 3 层】默认最多读 4 个链接（超出者在摘录里列名说明；有总预算兜底）
        var todo = uniq.slice(0, MAX);
        var restOf = uniq.slice(MAX);
        if (typeof window.dsWebSearchOnce !== 'function') return { ok: false, reason: 'no-websearch-api' };
        var KEY = '_ds_link_read_cache_v1';
        var TTL = 30 * 60 * 1000;
        var cache = {};
        try { cache = JSON.parse(localStorage.getItem(KEY) || '{}') || {}; } catch (e) { cache = {}; }
        var parts = [], linksOut = [], fromCache = true, anyOk = false;
        var t0 = Date.now();   // 总时间预算起点（多链接时防止无限等待）
        // 【2026-10-08 业界对齐 · 受控并发池（concurrency pool）+ deadline 预算】
        //   改动前是 `for + await` **逐个串行** ⇒ 4 个链接最坏 = 4×单链超时(15s) + 模型兜底(25s)
        //   ⇒ 真机表现"带链接的提问首字要等十几到几十秒"。
        //   业界通行做法（抓取/检索系统的标准模式，也是浏览器并发的推荐姿势）：
        //     ① **并发池**：固定 N 个 worker 从**共享游标**取任务；刻意不用一次性 `Promise.all(todo.map(...))`
        //        —— 那会同时打开全部连接（链接多时反而更慢、也更容易被目标站限流）；
        //     ② **deadline 预算**：每个 worker 取任务前先查总预算，超预算的链接标 `skipped`（保留原语义）；
        //     ③ **确定性输出**：结果按**原索引**落入 `_slots`，最后按序拼接 ⇒ 并发**不改变**"〔来源 N〕"
        //        的编号与顺序（与并行工具调用"按原序回灌"同一原则，避免回答里引用编号错乱）。
        //     ④ **缓存限长统一**（CACHE_CAP）：原来未命中可注入 20000 字、写缓存却被截到 8000
        //        ⇒ 同一链接"第一次读得全、第二次反而读得少"，属静默降级；现注入与缓存用**同一上限**。
        var CONC = Math.max(1, Math.min(opts.concurrency || 3, todo.length));
        var CACHE_CAP = opts.maxChars || 20000;
        var CACHE_N = Math.max(4, opts.cacheKeep || 4);   // 与"最多读 4 个链接"对齐，同时控制 localStorage 体积（4×20KB）
        var _slots = new Array(todo.length);
        var _cursor = 0;
        var _worker = async function () {
            for (;;) {
                var i = _cursor++;
                if (i >= todo.length) return;
                var u = todo[i], hit = cache[u];
                if (hit && hit.ts && (Date.now() - hit.ts) < TTL && hit.text) {
                    _slots[i] = { cached: true, url: u, text: hit.text, title: hit.title || '', channel: hit.channel || '' };
                    continue;
                }
                fromCache = false;
                // 总时间预算：多链接时不要无限等（超预算的链接改为"列出未读"，避免首字延迟过长）
                if (Date.now() - t0 > (opts.totalBudgetMs || 45000)) {
                    _slots[i] = { url: u, ok: false, error: 'budget', skipped: true };
                    continue;
                }
                var _txt = '', _ch = '', _title = '', _err = '';
                // ① 第 2 层：阅读器代理直取 Markdown（质量最高、不耗额度）
                if (typeof window.dsFetchPage === 'function') {
                    try {
                        var _pr = await window.dsFetchPage(u, { timeoutMs: opts.readerTimeoutMs || 15000, maxChars: CACHE_CAP });
                        if (_pr && _pr.ok && _pr.text) { _txt = _pr.text; _ch = 'reader'; _title = _pr.title || ''; }
                        else { _err = (_pr && _pr.error) || 'reader-failed'; }
                    } catch (e) { _err = String((e && e.message) || e); }
                } else { _err = 'no-reader'; }
                // ② 第 1 层兜底：用联网通道"以该网址为目标"定向读（reader 不可用时仍能读到）
                if (!_txt) {
                    var sys = '你是网页正文读取器。请**打开并阅读**用户给出的这个网址，逐段摘录其正文要点，'
                        + '保留关键数字、条款号与原文表述；若该页是列表/导航页，摘录其可见条目标题。'
                        + '只输出摘录本身，不要评价、不要客套、不要解释你做了什么。'
                        + '如果确实无法打开该网址，只回一行：READ_FAILED（不要编造内容）。';
                    var usr = '要读取的网址：' + u + (question ? ('\n（用户就这个链接提的问题是：' + String(question).slice(0, 200) + '）') : '')
                        + '\n\n请优先用检索工具打开该网址本身（检索词可直接用该网址或其标题），然后摘录正文。';
                    var r = null;
                    try {
                        r = await window.dsWebSearchOnce(sys, usr, {
                            maxUses: opts.maxUses || 2, maxTokens: opts.maxTokens || 1600, timeoutMs: opts.modelTimeoutMs || 25000
                        });
                    } catch (e) { r = { ok: false, error: String((e && e.message) || e) }; }
                    var mtxt = (r && r.ok && r.text) ? String(r.text).trim() : '';
                    if (mtxt && /^READ_FAILED\b/i.test(mtxt)) mtxt = '';
                    if (mtxt) { _txt = mtxt; _ch = 'model'; }
                    else if (!_err) _err = (r && (r.error || r.status)) || 'read-failed';
                }
                _slots[i] = _txt
                    ? { ok: true, url: u, text: _txt, title: _title, channel: _ch }
                    : { url: u, ok: false, error: _err || 'read-failed' };
            }
        };
        await Promise.all(Array.from({ length: CONC }, function () { return _worker(); }));
        // 按原索引顺序汇总（保证"〔来源 N〕"编号、顺序与串行版本完全一致）
        for (var _ri = 0; _ri < _slots.length; _ri++) {
            var _s = _slots[_ri] || {};
            if (_s.cached) {
                parts.push('〔来源 ' + (_ri + 1) + '〕' + _s.url + '\n' + _s.text);
                linksOut.push({ url: _s.url, ok: true, chars: _s.text.length, cached: true });
                anyOk = true;
            } else if (_s.ok) {
                anyOk = true;
                parts.push('〔来源 ' + (_ri + 1) + '〕' + _s.url + (_s.title ? ('　标题：' + _s.title) : '') + '\n' + _s.text);
                linksOut.push({ url: _s.url, ok: true, chars: _s.text.length, channel: _s.channel, title: _s.title });
                cache[_s.url] = { ts: Date.now(), text: String(_s.text).slice(0, CACHE_CAP), channel: _s.channel, title: _s.title };
            } else {
                linksOut.push({ url: _s.url, ok: false, error: _s.error, skipped: !!_s.skipped });
            }
        }
        // 修剪缓存（最多 CACHE_N 条，保留最新的）—— 条数与"最多读 4 个链接"对齐，避免 localStorage 被大文本撑满
        try {
            var ks = Object.keys(cache);
            if (ks.length > CACHE_N) {
                ks.sort(function (a, b) { return (cache[b].ts || 0) - (cache[a].ts || 0); });
                var keep = {};
                ks.slice(0, CACHE_N).forEach(function (k) { keep[k] = cache[k]; });
                cache = keep;
            }
            localStorage.setItem(KEY, JSON.stringify(cache));
        } catch (e) {}
        if (!anyOk) return { ok: false, links: linksOut, reason: 'read-failed', digest: '' };
        var digest = parts.join('\n\n');
        if (restOf.length) {
            digest += '\n\n（用户还给了其它链接，本轮未预读：' + restOf.join('、') + ' —— 如需其内容请说明。）';
        }
        var failed = linksOut.filter(function (x) { return !x.ok; });
        if (failed.length) {
            digest += '\n\n（以下链接本次未能读取，请如实说明读不到，不要猜测其内容：'
                + failed.map(function (x) { return x.url; }).join('、') + '）';
        }
        return { ok: true, digest: digest, links: linksOut, fromCache: fromCache };
    };

    window.dsWebSearchOnce = async function (sysPrompt, userPrompt, opts) {
        opts = opts || {};
        var apiKey = '';
        try { apiKey = localStorage.getItem('ds_api_key_v1') || ''; } catch (e) {}
        if (!apiKey) return { ok: false, error: 'no-key' };
        var base = '';
        try { base = window.dsGetApiUrl ? window.dsGetApiUrl() : (localStorage.getItem('ds_api_url_v1') || ''); } catch (e) {}
        var model = localStorage.getItem('ds_model_v1') || 'deepseek-flash';
        var maxTokens = opts.maxTokens || 1200;
        var ctrl = (typeof AbortController !== 'undefined') ? new AbortController() : null;
        var timedOut = false;
        var to = ctrl ? setTimeout(function () { timedOut = true; try { ctrl.abort(); } catch (e) {} }, opts.timeoutMs || 20000) : null;
        /** 从两种通道的响应里取正文（Anthropic: content[].text；Responses: output_text / output[].content[].text） */
        function pickText(j, kind) {
            try {
                if (kind === 'anthropic') {
                    var out = [];
                    ((j && j.content) || []).forEach(function (b) { if (b && b.type === 'text' && b.text) out.push(String(b.text)); });
                    return out.join('\n').trim();
                }
                if (j && j.output_text) return String(j.output_text).trim();
                var res = [];
                ((j && j.output) || []).forEach(function (it) {
                    (((it || {}).content) || []).forEach(function (c) {
                        if (c && (c.type === 'output_text' || c.type === 'text') && c.text) res.push(String(c.text));
                    });
                });
                return res.join('\n').trim();
            } catch (e) { return ''; }
        }
        try {
            var channels = [];
            try {
                (window.dsAnthropicUrlCandidates ? window.dsAnthropicUrlCandidates(base) : []).forEach(function (u) { if (u) channels.push({ kind: 'anthropic', url: u }); });
            } catch (e) {}
            try {
                (window.dsResponsesUrlCandidates ? window.dsResponsesUrlCandidates(base) : []).forEach(function (u) { if (u) channels.push({ kind: 'responses', url: u }); });
            } catch (e) {}
            if (!channels.length) return { ok: false, error: 'no-channel' };
            var lastErr = 'no-channel';
            for (var i = 0; i < channels.length; i++) {
                var ch = channels[i];
                var body = (ch.kind === 'anthropic')
                    ? {
                        model: model, max_tokens: maxTokens,
                        system: String(sysPrompt == null ? '' : sysPrompt),
                        messages: [{ role: 'user', content: String(userPrompt == null ? '' : userPrompt) }],
                        // 【2026-09-23 提速】max_uses 3→1：服务端检索是"每多搜一次多等几秒"，
                        //   问单个车站的天气一次检索足够（实测 3 次会把响应拖到十几秒）。
                        tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: opts.maxUses || 1 }],
                        stream: false, temperature: 0.3
                    }
                    : {
                        model: model,
                        instructions: String(sysPrompt == null ? '' : sysPrompt),
                        input: String(userPrompt == null ? '' : userPrompt),
                        tools: [{ type: 'web_search' }],
                        stream: false, temperature: 0.3, max_output_tokens: maxTokens
                    };
                var hdrs = { 'Content-Type': 'application/json' };
                if (ch.kind === 'anthropic') { hdrs['x-api-key'] = apiKey; hdrs['anthropic-version'] = '2023-06-01'; }
                else hdrs['Authorization'] = 'Bearer ' + apiKey;
                var r = null;
                try {
                    r = await fetch(ch.url, { method: 'POST', headers: hdrs, body: JSON.stringify(body), signal: ctrl ? ctrl.signal : undefined });
                } catch (e) {
                    return { ok: false, error: (e && e.name === 'AbortError') ? 'timeout' : ((e && e.message) || 'network') };
                }
                if (!r.ok) {
                    var det = '';
                    try { det = await r.text(); } catch (e2) {}
                    lastErr = (window.dsAiHttpError ? window.dsAiHttpError(r.status, det) : ('HTTP ' + r.status + (det ? '：' + String(det).slice(0, 160) : '')));
                    // 只有"端点/请求不被接受"才换下一个通道；鉴权(401)/余额(402)/限流(429)/5xx 换通道无意义
                    if (r.status === 400 || r.status === 404 || r.status === 405) continue;
                    return { ok: false, status: r.status, error: lastErr };
                }
                var j = null;
                try { j = await r.json(); } catch (e3) { lastErr = 'bad-json'; continue; }
                if (timedOut) return { ok: false, error: 'timeout' };
                var txt = pickText(j, ch.kind);
                if (txt) return { ok: true, text: txt, channel: ch.kind };
                lastErr = 'empty';
            }
            return { ok: false, error: lastErr };
        } catch (e) {
            return { ok: false, error: (e && e.name === 'AbortError') ? 'timeout' : ((e && e.message) || 'network') };
        } finally { if (to) clearTimeout(to); }
    };

    // ==================== AI 运行指标（P1：让优化可度量）====================
    // 为什么需要：此前 finish_reason / usage / 首字延迟**一个都没记录**，
    //   于是"提示词改了有没有变快、缓存有没有命中、回答是不是被截断"全靠感觉。
    //   DeepSeek 流式的最后一个块默认就带 usage（含 prompt_cache_hit_tokens / prompt_cache_miss_tokens）
    //   且 finish_reason 非空（官方文档：统计信息附加在最后一个内容块上，无需 stream_options），
    //   所以不需要新增请求参数即可采集。
    // 存储：localStorage 环形缓冲（最近 60 轮），单条约 200 字节，对配额无压力。
    var AI_METRICS_KEY = 'ds_ai_metrics_v1';
    var AI_METRICS_MAX = 60;

    window.dsRecordAiMetrics = function (rec) {
        try {
            if (!rec) return;
            var arr = [];
            try {
                var raw = JSON.parse(localStorage.getItem(AI_METRICS_KEY) || '[]');
                arr = Array.isArray(raw) ? raw : [];
            } catch (e) { arr = []; }
            arr.push(rec);
            if (arr.length > AI_METRICS_MAX) arr = arr.slice(-AI_METRICS_MAX);
            localStorage.setItem(AI_METRICS_KEY, JSON.stringify(arr));
        } catch (e) {}
    };

    window.dsAiMetrics = function () {
        try {
            var raw = JSON.parse(localStorage.getItem(AI_METRICS_KEY) || '[]');
            return Array.isArray(raw) ? raw : [];
        } catch (e) { return []; }
    };
    window.dsClearAiMetrics = function () { try { localStorage.removeItem(AI_METRICS_KEY); } catch (e) {} };

    // 汇总最近 N 轮：首字延迟 / 缓存命中率 / 回答被截断次数 —— 供「关于 → 离线状态」一行显示，
    // 也供后续优化做前后对比（改前跑几轮、改后再跑几轮即可看到差异）。
    window.dsAiMetricsSummary = function (n) {
        var arr = window.dsAiMetrics();
        if (!arr.length) return '';
        var last = arr.slice(-(n || 20));
        var withFirst = last.filter(function (r) { return r && r.firstDeltaMs > 0; });
        var avgFirst = withFirst.length
            ? Math.round(withFirst.reduce(function (a, r) { return a + r.firstDeltaMs; }, 0) / withFirst.length)
            : 0;
        var hit = last.reduce(function (a, r) { return a + ((r && r.cacheHit) || 0); }, 0);
        var miss = last.reduce(function (a, r) { return a + ((r && r.cacheMiss) || 0); }, 0);
        var cacheRate = (hit + miss) > 0 ? Math.round(hit / (hit + miss) * 100) : null;
        var cut = last.filter(function (r) {
            return r && (r.finishReason === 'length' || r.finishReason === 'insufficient_system_resource');
        }).length;
        var failed = last.filter(function (r) { return r && r.err; }).length;
        var usageSeen = (hit + miss) > 0;
        var parts = ['近 ' + last.length + ' 轮'];
        if (avgFirst) parts.push('首字均值 ' + (avgFirst / 1000).toFixed(1) + 's');
        if (cacheRate !== null) parts.push('缓存命中 ' + cacheRate + '%');
        if (cut) parts.push('回答不完整 ' + cut + ' 次');
        if (failed) parts.push('失败 ' + failed + ' 次');
        // 【P2】KB 注入与过滤的可视化：证明"低分块前移过滤 + 按源保底配额"确实在生效，
        //   也便于调 kb_min_score_ratio（比例太高会只剩极少块，太低等于没过滤）。
        var kbRounds = last.filter(function (r) { return r && r.kbInjected > 0; });
        if (kbRounds.length) {
            var kbAvg = Math.round(kbRounds.reduce(function (a, r) { return a + r.kbInjected; }, 0) / kbRounds.length);
            parts.push('KB 注入均值 ' + kbAvg + ' 字');
        }
        var kbDrop = last.reduce(function (a, r) { return a + ((r && r.kbDropped) || 0); }, 0);
        if (kbDrop) parts.push('过滤弱相关 ' + kbDrop + ' 块');
        var anchor = last.filter(function (r) { return r && r.hasOlderSummary; }).length;
        if (anchor) parts.push('摘要锚点 ' + anchor + ' 轮');
        // 明确说明"为什么这一行看起来没数据"，避免用户看到一个空值不知所云。
        // 已知口径：usage 仅从 chat/completions 流式末块采集；联网走 Responses/Anthropic 通道时不带，
        // 失败轮也可能根本没能拿到 usage。
        if (!usageSeen && !failed) parts.push('usage 未采集（联网通道或非流式响应）');
        return parts.join(' · ');
    };

    console.log('✅ doubao-common.js 已加载');
})();
