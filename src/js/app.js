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
 *     app.js               - 入口文件 (本文件)
 *     modules/
 *       utils.js           - 公共工具函数 (TAB_LABELS, switchTab, pinyinMatch等)
 *       issue.js           - 检查信息模块 (IndexedDB + 关键词搜索)
 *       rule.js            - 规章制度模块 (IndexedDB + 全文检索)
 *       diary.js           - 工作日志模块 (写实记录)
 *       memo.js            - 备忘提醒模块
 *       phone.js           - 车站电话模块
 *       handbook.js        - 检查手册模块 (四级目录大纲)
 *       swipe.js           - 侧滑手势切换模块
 *       doubao.js          - 智能助手模块 (DeepSeek API 对话/对规/写作)
 *       backup.js          - 全局备份与恢复模块 (ZIP 打包)
 *       engine.js          - 前端增强引擎 (Toast/Ripple/懒加载/性能优化)
 *       pwa.js             - PWA 安装提示
 *       anti-kimi.js       - 屏蔽 Kimi 扩展悬浮按钮
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
 *   1. utils.js       - 公共工具 (最先加载，其他模块依赖)
 *   2. issue.js       - 检查信息
 *   3. rule.js        - 规章制度
 *   4. diary.js       - 工作日志
 *   5. memo.js        - 备忘提醒
 *   6. phone.js       - 车站电话
 *   7. handbook.js    - 检查手册
 *   8. swipe.js       - 侧滑手势
 *   9. doubao.js      - 智能助手 (Part A + Part B)
 *  10. backup.js      - 备份恢复 (最后加载，依赖所有其他模块)
 *  11. engine.js      - 前端增强引擎
 *  12. pwa.js         - PWA 安装
 *  13. anti-kimi.js   - 屏蔽 Kimi 扩展
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

    navigator.serviceWorker.register('sw.js').then(function(reg) {
        console.log('[PWA] SW 注册成功');

        // 检测新版本更新
        reg.addEventListener('updatefound', function() {
            var sw = reg.installing;
            sw.addEventListener('statechange', function() {
                if (sw.state === 'installed' && navigator.controller) {
                    // 新 SW 已安装完毕，提示用户刷新
                    showUpdateToast();
                }
            });
        });
    }).catch(function(err) {
        console.warn('[PWA] SW 注册失败:', err);
    });

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
            // 通知 SW skipWaiting 并刷新页面
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
    // 清除 SW 缓存
    if ('caches' in window) {
        caches.keys().then(function(names) {
            for (var i = 0; i < names.length; i++) caches.delete(names[i]);
        });
    }
    // 清除 SW 注册
    if ('serviceWorker' in navigator) {
        navigator.serviceWorker.getRegistrations().then(function(regs) {
            for (var i = 0; i < regs.length; i++) regs[i].unregister();
        });
    }
    // 刷新页面
    setTimeout(function(){ location.reload(true); }, 300);
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
