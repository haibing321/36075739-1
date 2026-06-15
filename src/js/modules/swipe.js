/**
 * Swipe（侧滑手势切换）模块
 * ===================================================
 * 功能：
 *   - 左右滑动屏幕切换功能模块
 *   - 自动循环切换（左滑→下一模块，右滑→上一模块）
 *   - 输入框内触摸不触发
 *   - 模态框/导航菜单展开时不处理
 *
 * 依赖:
 *   - TAB_ORDER (来自 utils.js)
 *   - switchTab() (来自 utils.js)
 *   - _hideExitBar() (来自退出提示内联脚本)
 */

(function() {
    'use strict';

    // ---- Toast 显示（保留接口，暂不使用）----
    var _toastTimer = null;
    window._showSwipeToast = function(newTab) {
        // 可扩展：显示切换历史提示
    };

    // ---- 判断目标是否为输入类元素 ----
    function _isInputTarget(el) {
        if (!el) return false;
        var tag = (el.tagName || '').toLowerCase();
        if (tag === 'input' || tag === 'textarea' || tag === 'select') return true;
        if (el.isContentEditable) return true;
        if (el.closest && el.closest('input, textarea, select, [contenteditable="true"]')) return true;
        return false;
    }

    // ---- 触摸变量 ----
    var _tx0 = 0, _ty0 = 0, _tValid = false;

    // 用 capture 模式确保最先收到事件，不被子元素吞掉
    document.addEventListener('touchstart', function(e) {
        // 输入框内触摸不启动侧滑判定
        if (_isInputTarget(e.target)) { _tValid = false; return; }
        if (e.touches.length !== 1) { _tValid = false; return; }
        _tx0 = e.touches[0].clientX;
        _ty0 = e.touches[0].clientY;
        _tValid = true;
    }, true);   // ← capture = true

    document.addEventListener('touchend', function(e) {
        if (!_tValid) return;
        _tValid = false;

        // 再次检查 touchend 的目标是否为输入框（防止中途聚焦到输入框）
        if (_isInputTarget(e.target)) return;

        if (e.changedTouches.length < 1) return;

        var tx1 = e.changedTouches[0].clientX;
        var ty1 = e.changedTouches[0].clientY;
        var dx = tx1 - _tx0;
        var dy = ty1 - _ty0;
        var adx = Math.abs(dx);
        var ady = Math.abs(dy);

        // 水平位移不足屏幕40% → 忽略
        var minSwipe = Math.max(window.innerWidth * 0.4, 80);
        if (adx < minSwipe) return;
        if (ady > adx) return;

        // 模态框打开时不处理
        if (document.querySelector('.modal.active')) return;
        // 导航菜单展开时不处理
        var nav = document.getElementById('mainNav');
        if (nav && nav.classList.contains('nav-open')) return;

        // 中间区域滑动 → 模块切换（无限循环）
        // 当前激活 tab
        var activeBtn = document.querySelector('.nav-btn.active');
        if (!activeBtn) return;
        var m = activeBtn.id.match(/^tab-(.+)$/);
        if (!m) return;
        var curTab = m[1];
        var curIdx = TAB_ORDER.indexOf(curTab);
        if (curIdx < 0) return;

        // dx<0 左滑→下一模块；dx>0 右滑→上一模块（循环切换）
        var nextIdx = dx < 0 ? curIdx + 1 : curIdx - 1;
        if (nextIdx < 0) nextIdx = TAB_ORDER.length - 1;
        if (nextIdx >= TAB_ORDER.length) nextIdx = 0;

        // 切换模块时隐藏退出提示条
        if (window._hideExitBar) window._hideExitBar();

        switchTab(TAB_ORDER[nextIdx], true);
    }, true);   // ← capture = true

})();
