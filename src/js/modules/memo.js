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

    // 【2026-09-21】只读访问接口：此前 memo 数据完全无法被其它模块读到（智能体盯控/检索都用不上）
    window.getMemoData = function() {
        try { if (!memos || !memos.length) loadMemos(); } catch (e) {}
        return memos || [];
    };

    // ==================== 【2026-09-21】备忘录独立导入 / 导出 / 清空 ====================
    //  背景：备忘录此前**只能靠全局备份**（railway_memo_v1 一起打包），没有独立的导入导出入口 ——
    //   用户想单独备份待办、或把待办迁到另一台机器时无从下手；导出/导入/清空三件套与其它模块对齐。
    function _memoRefreshStats() {
        try { if (typeof window.updateDataManagementStats === 'function') window.updateDataManagementStats(); } catch (e) {}
    }
    /** 导出为 JSON（与全局备份里的 memos 数组同构，可互相导入） */
    window.exportMemo = function() {
        var list = window.getMemoData();
        if (!list || !list.length) {
            var _m0 = '暂无备忘可导出';
            if (window.showToast) window.showToast(_m0, true, 5000); else alert(_m0);
            return;
        }
        var name = '备忘录_' + (window.localDateStr ? window.localDateStr() : new Date().toISOString().slice(0, 10)) + '.json';
        var payload = { type: 'memo_export', version: 1, exportDate: new Date().toISOString(), count: list.length, memos: list };
        window.downloadBlob(new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' }), name);
        var _m1 = '✅ 已导出 ' + list.length + ' 条备忘（' + name + '）';
        if (window.showToast) window.showToast(_m1, false, 6000); else alert(_m1);
    };
    /** 导入 JSON：追加（按 时间+内容 去重）/ 覆盖 / 取消 三选一，失败不改内存 */
    window.importMemo = function() {
        var input = document.createElement('input');
        input.type = 'file';
        input.accept = '.json';
        input.style.display = 'none';
        input.addEventListener('cancel', function() { try { input.remove(); } catch (e) {} });
        input.onchange = async function(e) {
            var file = e.target.files && e.target.files[0];
            if (!file) { input.remove(); return; }
            var incoming = [];
            try {
                var data = JSON.parse(await file.text());
                var raw = Array.isArray(data) ? data : (data && Array.isArray(data.memos) ? data.memos : []);
                // 字段归一：本模块用 {datetime, content, done, id}；兼容 time/remindAt/text/title 等写法
                incoming = raw.filter(function(m) { return m && (m.content || m.text || m.title); }).map(function(m) {
                    var dt = String(m.datetime || m.time || m.remindAt || '').trim();
                    return {
                        datetime: dt ? dt.replace(' ', 'T').slice(0, 16) : '',
                        content: String(m.content || m.text || m.title || '').slice(0, 500),
                        done: !!(m.done || m.confirmed),
                        id: (typeof m.id === 'number' || /^\d+$/.test(String(m.id || ''))) ? Number(m.id) : Date.now() + Math.floor(Math.random() * 1000)
                    };
                });
            } catch (err) {
                var _me = '备忘录导入失败：' + ((err && err.message) || '不是有效的 JSON 文件');
                if (window.showToast) window.showToast(_me, true, 9000); else alert(_me);
                input.remove(); return;
            }
            if (!incoming.length) {
                var _m2 = '文件中没有可用的备忘条目（每条需含 datetime + content）';
                if (window.showToast) window.showToast(_m2, true, 8000); else alert(_m2);
                input.remove(); return;
            }
            loadMemos();
            var cur = memos.slice();
            var act = 'append';
            if (cur.length > 0) {
                act = await window.showChoiceModal({
                    title: '导入备忘录（JSON）',
                    body: '当前已有 ' + cur.length + ' 条，本次解析 ' + incoming.length + ' 条。请选择处理方式：',
                    actions: [
                        { label: '追加（时间+内容 去重）', value: 'append', primary: true },
                        { label: '覆盖现有', value: 'overwrite', danger: true },
                        { label: '取消', value: 'cancel' }
                    ]
                });
                if (act === 'cancel' || act == null) { input.remove(); return; }   // 真正取消：不写库
            }
            var merged, dup = 0;
            if (act === 'overwrite') merged = incoming;
            else {
                var seen = {};
                cur.forEach(function(m) { seen[String(m.datetime || '') + '|' + String(m.content || '')] = 1; });
                merged = cur.slice();
                incoming.forEach(function(m) {
                    var k = String(m.datetime || '') + '|' + String(m.content || '');
                    if (seen[k]) { dup++; return; }
                    seen[k] = 1; merged.push(m);
                });
            }
            // 先落盘成功再改内存（与其它模块一致：写失败不留半成品）
            var backup = memos;
            memos = merged;
            try {
                localStorage.setItem(MEMO_KEY, JSON.stringify(memos));
            } catch (eQ) {
                memos = backup;
                var _mq = '⚠️ 备忘录写入失败（可能存储空间不足）：' + ((eQ && eQ.message) || '未知错误') + '；本次导入未生效。';
                if (window.showToast) window.showToast(_mq, true, 10000); else alert(_mq);
                input.remove(); return;
            }
            try { renderMemoList(); } catch (e2) {}
            _memoRefreshStats();
            input.remove();
            var msg = '✅ 已导入备忘录：' + (act === 'overwrite' ? '覆盖为 ' : '新增 ') + (act === 'overwrite' ? incoming.length : (merged.length - cur.length))
                + ' 条' + (dup ? '（跳过重复 ' + dup + ' 条）' : '') + '，当前共 ' + memos.length + ' 条';
            if (window.showToast) window.showToast(msg, false, 7000); else alert(msg);
        };
        document.body.appendChild(input);
        input.click();   // 同步点击：延时会让 iOS/国产浏览器丢失用户手势（选择器不弹）
    };
    /** 清空全部备忘（带确认；建议先导出） */
    window.memoShowClear = function() {
        loadMemos();
        if (!memos.length) {
            var _m3 = '备忘录已为空';
            if (window.showToast) window.showToast(_m3, false, 4000); else alert(_m3);
            return;
        }
        if (!confirm('确定清空全部 ' + memos.length + ' 条备忘吗？\n此操作不可撤销（建议先点「导出」备份）。')) return;
        memos = [];
        try { localStorage.setItem(MEMO_KEY, JSON.stringify(memos)); } catch (e) {}
        try { renderMemoList(); } catch (e2) {}
        _memoRefreshStats();
        var _m4 = '🗑️ 备忘录已清空（0 条）';
        if (window.showToast) window.showToast(_m4, false, 5000); else alert(_m4);
    };

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
