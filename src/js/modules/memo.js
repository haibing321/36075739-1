// 备忘提醒模块
// 从原单文件提取，支持定时提醒、确认、删除

(function() {
    'use strict';

    var MEMO_KEY = 'railway_memo_v1';
    var memos = [];
    var memoCheckTimer = null;

    function loadMemos() {
        try { memos = JSON.parse(localStorage.getItem(MEMO_KEY) || '[]'); } catch(e) { memos = []; }
    }
    function saveMemos() {
        try { localStorage.setItem(MEMO_KEY, JSON.stringify(memos)); } catch(e) {}
    }

    // 页面内提醒条（alert 会阻塞主线程，且 PWA 在后台/锁屏时根本不会显示）
    function _toast(text) {
        try {
            var box = document.createElement('div');
            box.style.cssText = 'position:fixed;top:12px;left:50%;transform:translateX(-50%);z-index:100001;' +
                'background:#b45309;color:#fff;padding:10px 16px;border-radius:8px;font-size:0.86rem;' +
                'font-weight:600;box-shadow:0 4px 16px rgba(180,83,9,.4);max-width:90vw;white-space:pre-wrap;';
            box.textContent = '📅 ' + text;
            document.body.appendChild(box);
            setTimeout(function() {
                box.style.transition = 'opacity .5s ease';
                box.style.opacity = '0';
                setTimeout(function() { if (box.parentNode) box.parentNode.removeChild(box); }, 520);
            }, 12000);
        } catch (e) {}
    }

    function sendNotification(title, body) {
        var text = title + '\n' + body;
        // 优先用系统通知（后台/锁屏也能收到），不可用时退回页面内提醒条
        if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
            try { new Notification(title, { body: body, tag: 'railway-memo' }); return; } catch (e) {}
        }
        _toast(text);
    }

    // 到点即触发：原实现用 |now - 提醒时间| < 30 秒 的窗口判断，
    // 后台标签页定时器被节流（≥1 分钟）时会整段跳过窗口，提醒永久丢失。
    function _fireDue() {
        var now = Date.now();
        var fired = 0;
        memos.forEach(function(m) {
            if (m.done) return;
            var t = new Date(m.datetime).getTime();
            if (!t || isNaN(t)) return;
            if (t <= now) {
                m.done = true;
                fired++;
                sendNotification('🔔 工作提醒', m.content);
            }
        });
        if (fired) { saveMemos(); renderMemoList(); }
        return fired;
    }

    function startMemoCheck() {
        if (memoCheckTimer) clearInterval(memoCheckTimer);
        memoCheckTimer = setInterval(_fireDue, 15000);
    }

    function escapeHtmlMemo(str) {
        return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
    }

    function renderMemoList() {
        var el = document.getElementById('memo-list');
        if (!el) return;
        loadMemos();
        if (memos.length === 0) {
            el.innerHTML = '<div class="memo-empty">暂无备忘，点击右上角新建</div>';
            return;
        }
        var sorted = [].concat(memos).sort(function(a, b) {
            if (a.done !== b.done) return a.done ? 1 : -1;
            return new Date(a.datetime) - new Date(b.datetime);
        });
        el.innerHTML = sorted.map(function(m) {
            var dt = new Date(m.datetime);
            var dtStr = dt.getFullYear() + '-' + String(dt.getMonth()+1).padStart(2,'0') + '-' + String(dt.getDate()).padStart(2,'0') + ' ' + String(dt.getHours()).padStart(2,'0') + ':' + String(dt.getMinutes()).padStart(2,'0');
            var realIdx = memos.indexOf(m);
            var confirmBtn = m.confirmed
                ? '<span class="memo-confirmed-tag">✅ 已确认</span>'
                : '<button class="memo-item-confirm" onclick="confirmMemo(' + realIdx + ')" title="确认">✓ 确认</button>';
            return '<div class="memo-item ' + (m.done ? 'memo-done' : '') + '">'
                + '<div class="memo-item-info">'
                + '<div class="memo-item-time">⏰ ' + dtStr + (m.done ? '（已提醒）' : '') + '</div>'
                + '<div class="memo-item-text">' + escapeHtmlMemo(m.content) + '</div>'
                + '</div>'
                + '<div style="display:flex;flex-direction:column;gap:4px;align-items:center;flex-shrink:0;">'
                + confirmBtn
                + '<button class="memo-item-del" onclick="deleteMemo(' + realIdx + ')" title="删除">×</button>'
                + '</div></div>';
        }).join('');
    }

    // 对外接口
    window.openMemoModal = function() {
        loadMemos();
        renderMemoList();
        showMemoList();
        document.getElementById('memo-modal').classList.add('active');
    };
    window.closeMemoModal = function() {
        document.getElementById('memo-modal').classList.remove('active');
    };
    window.showMemoForm = function() {
        var d = new Date(Date.now() + 3600000);
        var pad = function(n) { return String(n).padStart(2,'0'); };
        var local = d.getFullYear()+'-'+pad(d.getMonth()+1)+'-'+pad(d.getDate())+'T'+pad(d.getHours())+':'+pad(d.getMinutes());
        document.getElementById('memo-datetime').value = local;
        document.getElementById('memo-content').value = '';
        document.getElementById('memo-list-section').style.display = 'none';
        document.getElementById('memo-form-section').style.display = 'block';
    };
    window.showMemoList = function() {
        document.getElementById('memo-list-section').style.display = 'block';
        document.getElementById('memo-form-section').style.display = 'none';
    };
    window.saveMemo = function() {
        var dt = document.getElementById('memo-datetime').value;
        var content = document.getElementById('memo-content').value.trim();
        if (!dt) { alert('请选择提醒时间'); return; }
        if (!content) { alert('请输入提醒内容'); return; }
        var memoTime = new Date(dt);
        if (memoTime <= new Date()) { alert('提醒时间必须晚于当前时间'); return; }
        loadMemos();
        memos.push({ datetime: dt, content: content, done: false, id: Date.now() });
        saveMemos();
        renderMemoList();
        showMemoList();
        alert('备忘已保存，将在 ' + dt.replace('T',' ') + ' 提醒您');
    };
    window.deleteMemo = function(idx) {
        if (!confirm('确定删除该备忘？')) return;
        loadMemos();
        memos.splice(idx, 1);
        saveMemos();
        renderMemoList();
    };
    window.confirmMemo = function(idx) {
        loadMemos();
        if (memos[idx]) {
            memos[idx].confirmed = true;
            saveMemos();
            renderMemoList();
        }
    };

    // 检查过期备忘：页面关闭期间到期的备忘（隔夜、关掉 PWA 再打开）不能静默吞掉，
    // 必须至少补发一次提示再标记为已提醒，否则用户永远收不到通知。
    function checkOverdue() {
        var now = Date.now();
        var missed = [];
        memos.forEach(function(m) {
            if (m.done) return;
            var t = new Date(m.datetime).getTime();
            if (!t || isNaN(t)) return;
            if (t <= now) { m.done = true; missed.push(m.content); }
        });
        if (missed.length === 0) return;
        saveMemos();
        renderMemoList();
        sendNotification(
            '🔔 您有 ' + missed.length + ' 条备忘已过期',
            missed.map(function(c, i) { return (i + 1) + '. ' + c; }).join('\n')
        );
    }

    // 初始化
    loadMemos();
    startMemoCheck();
    setTimeout(checkOverdue, 1000);

})();
