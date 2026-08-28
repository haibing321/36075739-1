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

    // 当前所在模块：优先取激活面板（资料中心等面板没有对应导航按钮，
    // 只认 .nav-btn.active 会导致切进去后侧滑永久失效）
    function _currentTab() {
        var panel = document.querySelector('.panel.active');
        if (panel && panel.id) {
            var pm = panel.id.match(/^panel-(.+)$/);
            if (pm) return pm[1];
        }
        var btn = document.querySelector('.nav-btn.active');
        if (btn && btn.id) {
            var bm = btn.id.match(/^tab-(.+)$/);
            if (bm) return bm[1];
        }
        return null;
    }

    // 用 capture 模式确保最先收到事件，不被子元素吞掉
    document.addEventListener('touchstart', function(e) {
        // 输入框内触摸不启动侧滑判定
        if (_isInputTarget(e.target)) { _tValid = false; return; }
        if (e.touches.length !== 1) { _tValid = false; return; }
        _tx0 = e.touches[0].clientX;
        _ty0 = e.touches[0].clientY;
        _tValid = true;
    }, true);   // ← capture = true

    // 手势被系统取消（来电、多任务等）时必须复位，否则下次 touchend 会误触发切换
    document.addEventListener('touchcancel', function() { _tValid = false; }, true);

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

        // 水平位移不足屏幕1/3 → 忽略
        var minSwipe = Math.max(window.innerWidth * 0.33, 60);
        if (adx < minSwipe) return;
        if (ady > adx) return;

        // 模态框打开时不处理
        if (document.querySelector('.modal.active')) return;
        // 导航菜单展开时不处理
        var nav = document.getElementById('mainNav');
        if (nav && nav.classList.contains('nav-open')) return;

        // 中间区域滑动 → 模块切换（无限循环）
        // 注意：侧滑顺序不包含「资料中心」(material)，左右滑屏不出现资料中心；
        // 资料中心仅能通过底部导航/菜单进入，避免滑动经过一个「无主 Tab」造成跳变。
        var SWIPE_ORDER = (typeof TAB_ORDER !== 'undefined' ? TAB_ORDER : [])
            .filter(function(t) { return t !== 'material'; });
        var curTab = _currentTab();
        if (!curTab) return;
        var curIdx = SWIPE_ORDER.indexOf(curTab);
        if (curIdx < 0) {
            // 当前在资料中心（经导航进入）时，以其在完整顺序中最接近的侧滑邻模块为基准，
            // 让左右滑仍能退出资料中心，而不是卡住。
            var fullIdx = (typeof TAB_ORDER !== 'undefined') ? TAB_ORDER.indexOf(curTab) : -1;
            if (fullIdx < 0) return;
            var before = -1, after = -1;
            for (var k = fullIdx - 1; k >= 0; k--) { var bi = SWIPE_ORDER.indexOf(TAB_ORDER[k]); if (bi >= 0) { before = bi; break; } }
            for (var j = fullIdx + 1; j < TAB_ORDER.length; j++) { var ai = SWIPE_ORDER.indexOf(TAB_ORDER[j]); if (ai >= 0) { after = ai; break; } }
            if (before >= 0) curIdx = before;
            else if (after >= 0) curIdx = after;
            else return;
        }

        // dx<0 左滑→下一模块；dx>0 右滑→上一模块（循环切换）
        var nextIdx = dx < 0 ? curIdx + 1 : curIdx - 1;
        if (nextIdx < 0) nextIdx = SWIPE_ORDER.length - 1;
        if (nextIdx >= SWIPE_ORDER.length) nextIdx = 0;

        // 切换模块时隐藏退出提示条
        if (window._hideExitBar) window._hideExitBar();

        switchTab(SWIPE_ORDER[nextIdx], true);
    }, true);   // ← capture = true

})();
