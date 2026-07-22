/**
 * 安监智能辅助系统 · 完整六模块版
 * ===================================================
 * 应用入口文件 - 负责模块加载顺序和全局初始化协调
 * 
 * ===================================================
 * 项目结构:
 * ===================================================
 * src/
 *   css/
 *     variables.css        - CSS 变量/主题
 *     layout.css           - 布局
 *     components.css       - 组件样式
 *     modules.css          - 模块样式
 *     responsive.css       - 响应式
 *   js/
 *     app.js               - 入口文件 (本文件，含 PWA 安装提示 / 屏蔽 Kimi 扩展 逻辑，原 pwa.js/anti-kimi.js/engine.js 已内联)
 *     modules/
 *       utils.js           - 公共工具函数 (TAB_ORDER, switchTab, pinyinMatch, dbManager, storageManager, 全局进度条)
 *       errorMonitor.js    - 全局错误监控 (window error / unhandledrejection 捕获上报)
 *       perfMonitor.js     - 性能监控 (搜索耗时埋点)
 *       issue.js           - 检查信息模块 (IndexedDB + Fuse 模糊搜索)
 *       rule.js            - 规章制度模块 (IndexedDB + 全文检索)
 *       diary.js           - 工作日志模块 (写实记录)
 *       memo.js            - 备忘提醒模块
 *       phone.js           - 应急电话模块 (含天气查询)
 *       handbook.js        - 检查手册模块 (四级目录大纲)
 *       swipe.js           - 侧滑手势切换模块
 *       doubao-common.js   - 智能助手公共工具 (表格渲染/上下文拼装)
 *       smart-check.js     - 智能对规模块
 *       smart-writer.js    - 智能写作模块 (资料库/历史报告)
 *       doubao.js          - 智能助手主模块 (DeepSeek API 对话/对规/写作/BM25 检索)
 *       agent-memory.js    - 智能体任务记忆 (IndexedDB)
 *       agent-core.js      - 智能体规划器 + 工具集 (ReAct)
 *       backup.js          - 全局备份与恢复模块 (ZIP 打包)
 *
 * ===================================================
 * 外部依赖 (通过 <script> 标签在 HTML 中加载):
 * ===================================================
 *   - XLSX v0.18.5       : xlsx.full.min.js
 *   - pdf.js v2.16.105   : pdf.min.js (mammoth.js依赖)
 *   - Mammoth v1.4.2     : mammoth.browser.min.js (Word文档解析)
 *   - Fuse.js v6.6.2     : fuse.min.js (模糊搜索)
 *   - Pinyin v2.11.0     : pinyin.min.js (拼音匹配)
 *   - JSZip v3.10.1      : jszip.min.js (ZIP 打包)
 *   - xml-js v1.6.11     : xml-js.min.js (XML解析)
 *   - html-docx-js v0.3.1: html-docx.js (HTML转Word)
 *
 * ===================================================
 * 模块加载顺序:
 * ===================================================
 *   1. utils.js           - 公共工具 (最先加载，其他模块依赖)
 *   2. errorMonitor.js    - 全局错误监控
 *   3. perfMonitor.js     - 性能监控
 *   4. diary.js           - 工作日志
 *   5. issue.js           - 检查信息
 *   6. rule.js            - 规章制度
 *   7. memo.js            - 备忘提醒
 *   8. phone.js           - 应急电话
 *   9. handbook.js        - 检查手册
 *  10. swipe.js           - 侧滑手势
 *  11. doubao-common.js   - 智能助手公共工具
 *  12. smart-check.js     - 智能对规
 *  13. smart-writer.js    - 智能写作
 *  14. doubao.js          - 智能助手主模块
 *  15. agent-memory.js    - 智能体任务记忆
 *  16. agent-core.js      - 智能体规划器
 *  17. backup.js          - 备份恢复 (最后加载，依赖所有其他模块)
 *  (PWA 安装提示 / 屏蔽 Kimi 扩展逻辑已内联在本文件 app.js 中)
 *
 * ===================================================
 * HTML 结构要求:
 * ===================================================
 *   - .nav-btn[id=tab-*] : 导航按钮
 *   - .panel[id=panel-*] : 对应的面板容器
 *   - .modal[id]         : 模态框
 *   - 各模块特定 DOM 元素 (参见各模块文件注释)
 */

'use strict';

// ============================================================
// 初始化协调逻辑
// ============================================================

document.addEventListener('DOMContentLoaded', function() {
    console.log('%c安监智能辅助系统 · 初始化开始', 'color:#1a365d;font-weight:bold;');

    // 启动时检查存储配额（延迟3秒等各模块初始化完成）
    if (window.storageManager) {
        setTimeout(function() {
            window.storageManager.warnIfNearLimit(80).then(function(nearLimit) {
                if (!nearLimit) {
                    window.storageManager.checkQuota().then(function(info) {
                        console.log('[storage] 存储正常: ' + info.usageMB + '/' + info.quotaMB + ' MB (' + info.usagePercent.toFixed(1) + '%)');
                    });
                }
            });
        }, 3000);
    }

    // 各模块的初始化由各自的 IIFE 自行处理
    // 跨模块协调逻辑如下：
});

// ============================================================
// Agent 桥接函数（供 agent-core.js 工具调用）
// ============================================================
(function() {
    // ---- 智能体搜索辅助：模糊匹配(复用全局 Fuse，缓存实例) + 子串降级 ----
    var _fuseCache = {};
    function _getFuse(data, keys) {
        var cacheKey = keys.join(',');
        var entry = _fuseCache[cacheKey];
        // 缓存命中：同一数据集引用不重建 Fuse 索引（节省 3-5ms/次）
        if (entry && entry.data === data) return entry.fuse;
        var fuse = new window.Fuse(data, { keys: keys, threshold: 0.4, ignoreLocation: true, includeScore: true, minMatchCharLength: 1 });
        _fuseCache[cacheKey] = { data: data, fuse: fuse };
        return fuse;
    }
    function _fuzzyFilter(data, keyword, keys, limit) {
        limit = limit || 10;
        if (!keyword) return data.slice(0, limit);
        var kws = String(keyword).split(/[\s,，、]+/).filter(Boolean);
        if (!kws.length) return data.slice(0, limit);
        if (typeof window.Fuse !== 'undefined') {
            try {
                var fuse = _getFuse(data, keys);
                var map = {};
                kws.forEach(function(kw) {
                    fuse.search(kw).forEach(function(h) {
                        var i = data.indexOf(h.item);
                        if (i === -1) return;
                        if (!map[i]) map[i] = { item: h.item, n: 0 };
                        map[i].n++;
                    });
                });
                return Object.keys(map).map(function(k) { return map[k].item; }).slice(0, limit);
            } catch (e) {}
        }
        var lower = kws.map(function(k) { return k.toLowerCase(); });
        return data.filter(function(d) {
            return keys.some(function(k) {
                var v = (d[k] || '').toLowerCase();
                return lower.some(function(kw) { return v.indexOf(kw) !== -1; });
            });
        }).slice(0, limit);
    }
    /** 搜索检查信息（支持日期/性质筛选 + 模糊搜索） */
    window._agentGetIssues = function(keyword, unit, category, limit, dateFrom, dateTo, nature) {
        var data = [];
        try {
            if (typeof window.getIssueData === 'function') data = window.getIssueData();
        } catch(e) { return []; }
        if (!data.length) return [];
        var filtered = data;
        if (unit) filtered = filtered.filter(function(i) { return (i.unit||'').indexOf(unit) !== -1; });
        if (category) filtered = filtered.filter(function(i) { return (i.category||'').indexOf(category) !== -1; });
        // 日期范围过滤（datetime 字段，前缀匹配即可）
        if (dateFrom) filtered = filtered.filter(function(i) { return (i.datetime||'') >= dateFrom; });
        if (dateTo)   filtered = filtered.filter(function(i) { return (i.datetime||'') <= dateTo + ' 23:59:59'; });
        // 性质筛选（A类/B类/C类/红线/空白）
        if (nature) filtered = filtered.filter(function(i) { return (i['性质']||'') === nature; });
        return _fuzzyFilter(filtered, keyword, ['性质','category','content','regulation','unit'], limit || 30);
    };

    /** 搜索规章制度 */
    window._agentGetRules = function(keyword, limit) {
        var rules = [];
        try {
            if (typeof window.getRulesData === 'function') rules = window.getRulesData();
        } catch(e) { return []; }
        if (!rules.length) return [];
        return _fuzzyFilter(rules, keyword, ['title','content','trade'], limit || 10);
    };

    /** 写入工作日志（支持结构化 issueIds） */
    window._agentWriteDiary = async function(content, issues, date, issueIds) {
        try {
            if (typeof window.addIssueToDiary !== 'function') return { ok: false, error: '日志模块未就绪' };
            var fullContent = (content || '').trim();
            if (issueIds && Array.isArray(issueIds) && issueIds.length) {
                var issueData = window.getIssueData ? window.getIssueData() : [];
                issueIds.forEach(function(id) {
                    var iss = issueData[id];
                    if (!iss) return;
                    fullContent += '\n  · [' + (iss['性质']||'') + '] ' + (iss.content||'').slice(0,80) + '（' + (iss.unit||'') + '）';
                });
            } else if (issues && String(issues).trim()) {
                fullContent += (fullContent ? '｜' : '') + '发现问题：' + String(issues).trim();
            }
            var ok = window.addIssueToDiary(fullContent, '', date || '');
            return { ok: !!ok, message: ok ? '日志已写入' : '写入失败' };
        } catch(e) { return { ok: false, error: e.message }; }
    };

    /** 保存报告到写作资料库（同名自动追加 vN 防覆盖） */
    window._agentSaveReport = async function(title, content) {
        try {
            if (typeof window.wrAgentSaveMaterial !== 'function') return { ok: false, error: '写作模块未就绪' };
            // 查重：若同名已存在，自动追加版本号
            var existing = [];
            try {
                if (typeof window._wrGetAllReports === 'function') existing = await window._wrGetAllReports();
                else if (typeof window.getWrMatList === 'function') existing = await window.getWrMatList();
            } catch(e) { existing = []; }
            var sameCount = existing.filter(function(m) { return (m.title||'').trim() === (title||'').trim(); }).length;
            var finalTitle = sameCount > 0 ? (title + '（v' + (sameCount + 1) + '）') : title;
            var ok = window.wrAgentSaveMaterial(finalTitle, content);
            return { ok: !!ok, message: ok ? '报告已保存' : '保存失败', title: finalTitle };
        } catch(e) { return { ok: false, error: e.message }; }
    };

    /** 搜索手册 */
    window._agentGetHandbook = function(keyword, limit) {
        var hb = [];
        try {
            if (typeof window.getHandbookData === 'function') hb = window.getHandbookData();
        } catch(e) { return []; }
        if (!hb.length) return [];
        return _fuzzyFilter(hb, keyword, ['chapter','section','item','subitem','content'], limit || 10);
    };

    /** 按 id(数组下标) 取单条完整记录，供智能体按需获取全文 */
    window._agentGetIssueDetail = function(id) {
        try { return (window.getIssueData() || [])[id] || null; } catch(e) { return null; }
    };
    window._agentGetRuleDetail = function(id) {
        try { return (window.getRulesData() || [])[id] || null; } catch(e) { return null; }
    };
    window._agentGetHandbookDetail = function(id) {
        try { return (window.getHandbookData() || [])[id] || null; } catch(e) { return null; }
    };
})();

// ============================================================
// 全局事件处理
// ============================================================

// --- DeepSeek 气泡样式 ---
(function() {
    const style = document.createElement('style');
    style.textContent = [
        '.ds-row-user { display:flex; justify-content:flex-end; }',
        '.ds-row-assistant { display:flex; justify-content:flex-start; }',
        '.ds-row-system { display:flex; justify-content:center; }',
        '.ds-bubble-user {',
        '    background:#dbeafe;',
        '    color:#1e3a5f;',
        '    padding:10px 14px;',
        '    border-radius:14px 14px 4px 14px;',
        '    max-width:75%;',
        '    font-size:0.92rem;',
        '    line-height:1.6;',
        '    white-space:pre-wrap;',
        '    word-break:break-word;',
        '}',
        '.ds-bubble-assistant {',
        '    background:#fff;',
        '    color:var(--text);',
        '    padding:10px 14px;',
        '    border-radius:14px 14px 14px 4px;',
        '    max-width:85%;',
        '    font-size:0.92rem;',
        '    line-height:1.7;',
        '    word-break:break-word;',
        '    white-space:pre-wrap;',
        '    box-shadow:0 1px 4px rgba(0,0,0,.08);',
        '    border:1px solid var(--border);',
        '}',
        '.ds-bubble-system {',
        '    background:#fff3cd;',
        '    color:#856404;',
        '    padding:8px 14px;',
        '    border-radius:8px;',
        '    font-size:0.85rem;',
        '    max-width:90%;',
        '    white-space:pre-wrap;',
        '    word-break:break-word;',
        '    border:1px solid #ffc107;',
        '}',
        '.ds-cursor { animation:dsBlink 1s step-end infinite; }',
        '@keyframes dsBlink { 0%,100%{opacity:1;} 50%{opacity:0;} }',
        '.ds-typing {',
        '    display:inline-flex;align-items:center;gap:6px;',
        '    color:var(--text-secondary);font-size:0.85rem;',
        '}',
        '.ds-typing::before {',
        '    content:"";display:inline-block;',
        '    width:14px;height:14px;',
        '    border:2px solid var(--border);',
        '    border-top-color:var(--primary);',
        '    border-radius:50%;',
        '    animation:dsSpin 0.6s linear infinite;',
        '    flex-shrink:0;',
        '}',
        '@keyframes dsSpin { to{transform:rotate(360deg)} }',
        '.ds-typing .ds-dot { display:inline-block;animation:dsDotBounce 1.4s infinite; }',
        '.ds-typing .ds-dot:nth-child(2) { animation-delay:.2s; }',
        '.ds-typing .ds-dot:nth-child(3) { animation-delay:.4s; }',
        '@keyframes dsDotBounce { 0%,80%,100%{opacity:0;transform:translateY(0)} 40%{opacity:1;transform:translateY(-3px)} }'
    ].join('');
    document.head.appendChild(style);
})();

// 全局回车搜索
document.addEventListener('keypress', function(e) {
    if (e.key === 'Enter') {
        var activePanel = document.querySelector('.panel.active');
        if (!activePanel) return;
        if (activePanel.id === 'panel-issue') issueDoSearch();
        else if (activePanel.id === 'panel-rule') renderResults();
        else if (activePanel.id === 'panel-phone') phoneDoSearch();
    }
});

// 点击模态框外部关闭
window.onclick = function(e) {
    if (e.target.classList.contains('modal')) e.target.classList.remove('active');
};

// ============================================================
// PWA 安装提示
// ============================================================
(function() {
    if (!('serviceWorker' in navigator)) return;
    var _deferredPrompt = null;
    var _installBtn = null;
    var _installBtnAdded = false;

    var _manualUpdateCheck = false;  // 仅手动「检查更新」时才弹新版本提示
    var _pendingReload = false;      // 手动更新后，新 SW 接管即刷新

    // 离线优先策略：SW 默认直接从缓存秒开页面，打开时不联网拉取 HTML/JS/CSS，
    // 也不在打开时自动检查更新。新版本仅由用户点击「设置→检查更新」触发下载。
    console.log('[PWA] SW 注册中(离线优先)...');

    navigator.serviceWorker.register('sw.js').then(function(reg) {
        console.log('[PWA] SW 注册成功');

        // 检测新版本：仅手动检查时才提示，避免打开即打扰
        reg.addEventListener('updatefound', function() {
            var sw = reg.installing;
            sw.addEventListener('statechange', function() {
                if (sw.state === 'installed' && navigator.controller) {
                    if (_manualUpdateCheck) showUpdateToast();
                }
            });
        });
    }).catch(function(err) {
        console.warn('[PWA] SW 注册失败:', err);
    });

    // 新 SW 接管页面后，若本次为手动更新则刷新以应用新版本
    navigator.serviceWorker.addEventListener('controllerchange', function() {
        if (_pendingReload) {
            _pendingReload = false;
            window.location.reload();
        }
    });

    // 暴露给「检查更新」按钮：拉取并预备最新版本（离线优先下更新唯一入口）
    function triggerApplyUpdate() {
        _manualUpdateCheck = true;
        navigator.serviceWorker.getRegistration().then(function(reg) {
            if (!reg) { _manualUpdateCheck = false; return; }
            // 浏览器已自动检测到等待中的新 SW：直接提示应用
            if (reg.waiting) { showUpdateToast(); return; }
            var done = false;
            var onReady = function(r) { if (r && r.waiting && !done) { done = true; showUpdateToast(); } };
            reg.update().then(function() {
                // updatefound 会处理；兜底 2s 后再查一次 waiting 状态
                setTimeout(function() { navigator.serviceWorker.getRegistration().then(onReady); }, 2000);
            }).catch(function(e) {
                console.warn('[PWA] SW 更新检查失败:', e);
                _manualUpdateCheck = false;
            });
        });
    }
    window.triggerApplyUpdate = triggerApplyUpdate;

    // SW 更新提示 Toast
    function showUpdateToast() {
        if (document.getElementById('_sw_update_toast')) return;
        var toast = document.createElement('div');
        toast.id = '_sw_update_toast';
        toast.innerHTML = [
            '<span>🔄 发现新版本</span>',
            '<button id="_sw_update_btn" style="',
            '  background:#ffd700;color:#1a365d;border:none;border-radius:16px;',
            '  padding:4px 14px;font-size:0.82rem;font-weight:700;cursor:pointer;margin-left:8px;',
            '">立即更新</button>'
        ].join('');
        Object.assign(toast.style, {
            position:'fixed', top:'12px', left:'50%', transform:'translateX(-50%)',
            background:'rgba(26,54,93,0.95)', color:'#fff',
            display:'flex', alignItems:'center', gap:'6px',
            padding:'10px 20px', zIndex:'100000', borderRadius:'24px',
            fontSize:'0.88rem', fontWeight:'600', boxShadow:'0 4px 16px rgba(0,0,0,.3)',
            transition:'opacity .3s ease'
        });
        document.body.appendChild(toast);
        document.getElementById('_sw_update_btn').onclick = function() {
            // 通知 SW 立即接管并刷新以应用新版本
            _pendingReload = true;
            if (navigator.serviceWorker.controller) {
                navigator.serviceWorker.controller.postMessage({ type: 'SKIP_WAITING' });
            }
            window.location.reload();
        };
        // 30秒后自动消失
        setTimeout(function() { toast.style.opacity = '0'; setTimeout(function() { if (toast.parentNode) toast.parentNode.removeChild(toast); }, 310); }, 30000);
    }

    window.addEventListener('beforeinstallprompt', function(e) {
        if (localStorage.getItem('pwa_install_dismissed') === '1') return;
        e.preventDefault();
        _deferredPrompt = e;
        showInstallButton();
    });

    window.addEventListener('appinstalled', function() {
        console.log('[PWA] 应用已安装');
        _deferredPrompt = null;
        hideInstallButton();
    });

    function showInstallButton() {
        if (_installBtnAdded) return;
        _installBtnAdded = true;
        _installBtn = document.createElement('div');
        _installBtn.id = '_pwa_install_bar';
        _installBtn.innerHTML = [
            '<span style="font-size:1.2rem;">📲</span>',
            '<span style="flex:1;text-align:left;">安装「安监助手」到桌面</span>',
            '<button id="_pwa_install_btn" style="',
            '  background:#fff;color:#1a365d;border:none;border-radius:20px;',
            '  padding:6px 18px;font-size:0.85rem;font-weight:700;cursor:pointer;',
            '  white-space:nowrap;',
            '">安装</button>',
            '<button id="_pwa_install_close" style="',
            '  background:none;border:none;color:rgba(255,255,255,0.6);',
            '  font-size:1.1rem;cursor:pointer;padding:0 4px;margin-left:4px;',
            '">✕</button>'
        ].join('');
        Object.assign(_installBtn.style, {
            position:'fixed', bottom:'0', left:'0', right:'0',
            background:'rgba(26,54,93,0.97)', color:'#fff',
            display:'flex', alignItems:'center', gap:'8px',
            padding:'12px 16px', zIndex:'99999',
            fontSize:'0.92rem', fontWeight:'600',
            boxShadow:'0 -2px 12px rgba(0,0,0,.25)',
            transform:'translateY(100%)', transition:'transform .3s ease'
        });
        document.body.appendChild(_installBtn);
        requestAnimationFrame(function() { _installBtn.style.transform = 'translateY(0)'; });

        document.getElementById('_pwa_install_btn').onclick = function() {
            if (!_deferredPrompt) return;
            _deferredPrompt.prompt();
            _deferredPrompt.userChoice.then(function(choice) {
                console.log('[PWA] 用户选择:', choice.outcome);
                _deferredPrompt = null;
            });
        };
        document.getElementById('_pwa_install_close').onclick = function() {
            hideInstallButton();
            try { localStorage.setItem('pwa_install_dismissed', '1'); } catch(e) {}
        };
    }

    function hideInstallButton() {
        if (_installBtn) {
            _installBtn.style.transform = 'translateY(100%)';
            setTimeout(function() {
                if (_installBtn && _installBtn.parentNode) _installBtn.parentNode.removeChild(_installBtn);
                _installBtnAdded = false;
                _installBtn = null;
            }, 300);
        }
    }

    if (window.matchMedia('(display-mode: standalone)').matches) {
        console.log('[PWA] 已作为应用运行');
    }
})();

// ============================================================
// 屏蔽 Kimi 扩展悬浮按钮（JS 层兜底）
// ============================================================
(function() {
    function removeKimiElements() {
        document.querySelectorAll('[id*="kimi" i],[class*="kimi" i],[class*="kimi-extension" i]').forEach(function(el) {
            if (el.id !== '_block_kimi_fab' && el.closest('header,main,nav,section')) return;
            el.remove();
        });
        document.querySelectorAll('kimi-chat-widget,kimi-fab').forEach(function(el) { el.remove(); });
        document.querySelectorAll('body > div').forEach(function(el) {
            var s = getComputedStyle(el);
            if (s.position === 'fixed' && s.zIndex && parseInt(s.zIndex) > 100000 && !el.id && !el.className) {
                el.remove();
            }
        });
    }
    setTimeout(removeKimiElements, 500);
    setTimeout(removeKimiElements, 2000);
    var mo = new MutationObserver(function() {
        removeKimiElements();
    });
    mo.observe(document.body, { childList: true, subtree: true });
})();

window.toggleSettingsPanel = function() {
    var p = document.getElementById('settings-panel');
    if (!p) return;
    var isOpening = (p.style.display === 'none' || p.style.display === '');
    p.style.display = isOpening ? 'block' : 'none';
    if (isOpening && window.updateDataManagementStats) {
        window.updateDataManagementStats();
    }
};

window.clearAllCache = function() {
    if (!confirm('⚠️ 将清除所有缓存数据并刷新页面，确定继续？')) return;

    var pending = [];

    // 清除 SW 缓存（等待删除完成，避免竞态导致旧缓存残留）
    if ('caches' in window) {
        pending.push(
            caches.keys().then(function(names) {
                return Promise.all(names.map(function(n) { return caches.delete(n); }));
            })
        );
    }
    // 注销 SW 注册
    if ('serviceWorker' in navigator) {
        pending.push(
            navigator.serviceWorker.getRegistrations().then(function(regs) {
                return Promise.all(regs.map(function(r) { return r.unregister(); }));
            })
        );
    }

    // 等所有清理完成再刷新（不再用固定 300ms 强刷，杜绝竞态）
    Promise.all(pending).then(function() {
        location.reload(true);
    }).catch(function() {
        location.reload(true);
    });
};

window.showAboutPanel = function() {
    var p = document.getElementById('about-panel');
    if (p) p.style.display = 'flex';
};

// API 配置：根据选中的 API 地址自动推荐模型
window._updateModelList = function() {
    var urlEl = document.getElementById('modal-apiurl');
    var modelEl = document.getElementById('modal-model');
    if (!urlEl || !modelEl) return;
    var url = (urlEl.value || '').trim();
    // 常用 API 地址 → 默认模型映射
    var map = {
        'https://api.deepseek.com/chat/completions': 'deepseek-v4-flash',
        'https://api.openai.com/v1/chat/completions': 'gpt-5-mini',
        'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions': 'qwen3-turbo',
        'https://open.bigmodel.cn/api/paas/v4/chat/completions': 'GLM-5-Flash',
        'https://api.moonshot.cn/v1/chat/completions': 'kimi-k2-turbo',
        'https://api.baichuan-ai.com/v1/chat/completions': 'Baichuan4-Turbo',
        'https://api.minimax.chat/v1/text/chatcompletion_v2': 'abab7',
        'https://api.stepfun.com/v1/chat/completions': 'step-2-16k'
    };
    if (map[url]) modelEl.value = map[url];
};

console.log('%c安监智能辅助系统 · app.js 已加载', 'color:#1a365d;font-weight:bold;');

// ==================== 版本管理 ====================
const APP_VERSION = 'v2.7'; // 单一版本源：设置面板与关于面板的版本号均在 DOMContentLoaded 时从此注入；发版时只需改此处 + 同步 version.json
// 检查更新源：读取已部署在 GitHub Pages 上的 version.json（无需打 GitHub Release，适配纯 Pages 部署）
// 注意：version.json 在 SW 中走网络策略（不读缓存），可拿到最新部署版本
const UPDATE_CHECK_URL = 'https://haibing321.github.io/36075739-2/version.json';
// 12 位 SW 缓存版本号（YYYYMMDDHHMMSS），从 sw.js 提取后注入设置/关于面板
var _SW_VERSION = '';

// 页面加载时注入版本号（设置面板 + 关于面板均从 APP_VERSION 动态取，避免 HTML 写死陈旧值）
// 同时异步获取 SW 12 位缓存版本号并二次注入
document.addEventListener('DOMContentLoaded', async function() {
    var verSpan = document.getElementById('setting-current-version');
    if (verSpan) verSpan.textContent = APP_VERSION;
    var aboutVer = document.getElementById('about-app-version');
    if (aboutVer) aboutVer.textContent = APP_VERSION;
    // 异步获取 SW 缓存版本号（12位精确时间戳），追加显示到版本号后
    fetch('sw.js?v=' + Date.now(), { cache: 'no-store' })
        .then(function(r) { return r.text(); })
        .then(function(txt) {
            var m = txt.match(/CACHE_VERSION\s*=\s*'(\d{12})'/);
            if (m && m[1]) {
                _SW_VERSION = m[1];
                if (verSpan && !verSpan.textContent.includes('·')) {
                    verSpan.textContent = APP_VERSION + ' · ' + _SW_VERSION;
                }
                if (aboutVer && !aboutVer.textContent.includes('·')) {
                    aboutVer.textContent = APP_VERSION + ' · ' + _SW_VERSION;
                }
            }
        })
        .catch(function() {});
});

// 手动检查（点击设置中的检查更新按钮触发）
async function checkForUpdate() {
    const statusEl = document.getElementById('update-status');
    if (!statusEl) return;
    statusEl.textContent = '⏳ 正在检查...';
    statusEl.style.color = '#3b82f6';
    await performUpdateCheck(UPDATE_CHECK_URL, true);
    // 同时触发 SW 实际拉取并预备新版本（离线优先策略下，更新只在此时发生）
    if (window.triggerApplyUpdate) window.triggerApplyUpdate();
}

// 静默检查
async function silentCheckUpdate() {
    const lastCheck = localStorage.getItem('_last_version_check');
    if (lastCheck && (Date.now() - parseInt(lastCheck)) < 3600000) {
        return;
    }
    await performUpdateCheck(UPDATE_CHECK_URL, false);
    localStorage.setItem('_last_version_check', Date.now());
}

// 核心检测函数
async function performUpdateCheck(url, showStatus) {
    if (showStatus === undefined) showStatus = false;
    const statusEl = document.getElementById('update-status');
    try {
        const resp = await fetch(url, {
            method: 'GET',
            headers: { 'Accept': 'application/json' },
            cache: 'no-cache'
        });
        // 404 = version.json 不存在（部署配置异常）
        if (resp.status === 404) {
            if (showStatus) {
                statusEl.textContent = 'ℹ️ 未找到版本信息文件，请确认部署包含 version.json';
                statusEl.style.color = '#64748b';
            }
            return;
        }
        if (!resp.ok) throw new Error('HTTP ' + resp.status);
        const data = await resp.json();
        const remoteVersion = data.tag_name || data.version || data.latestVersion || '';
        const releaseNotes = data.body || data.releaseNotes || data.notes || '';
        const downloadUrl = data.html_url || data.downloadUrl || 'https://github.com/haibing321/36075739-2/releases';

        if (!remoteVersion) {
            if (showStatus) {
                statusEl.textContent = '❌ 远程版本信息缺失，检查接口格式';
                statusEl.style.color = '#dc2626';
            }
            return;
        }

        const isNew = compareVersions(remoteVersion, APP_VERSION) > 0;
        if (isNew) {
            document.getElementById('tab-settings')?.classList.add('has-update-badge');
            localStorage.setItem('_has_update', 'true');
            if (showStatus) {
                statusEl.innerHTML = '🆕 发现新版本 <strong>' + remoteVersion + '</strong>（当前 ' + APP_VERSION + '）<br>' + (releaseNotes ? '📝 ' + releaseNotes.slice(0, 120) + (releaseNotes.length > 120 ? '…' : '') : '') + '<br>新版已下载，点击下方「立即更新」或重新打开即可生效';
                statusEl.style.color = '#dc2626';
            }
            // 自动预备 SW 更新（离线优先策略下，更新仅在此触发）
            if (window.triggerApplyUpdate) window.triggerApplyUpdate();
        } else {
            document.getElementById('tab-settings')?.classList.remove('has-update-badge');
            localStorage.removeItem('_has_update');
            if (showStatus) {
                statusEl.textContent = '✅ 已是最新版 (' + APP_VERSION + ')';
                statusEl.style.color = '#16a34a';
            }
        }
    } catch (err) {
        if (showStatus) {
            statusEl.textContent = '❌ 检查失败：' + err.message;
            statusEl.style.color = '#dc2626';
        }
        console.warn('[Update]', err);
    }
}

// 版本号比较
function compareVersions(v1, v2) {
    function clean(v) { return v.replace(/^v/, '').split('.').map(Number); }
    var a = clean(v1), b = clean(v2);
    var len = Math.max(a.length, b.length);
    for (var i = 0; i < len; i++) {
        var n1 = a[i] || 0, n2 = b[i] || 0;
        if (n1 > n2) return 1;
        if (n1 < n2) return -1;
    }
    return 0;
}
