// 来源：C:/Users/asus/Desktop/index.html 第5911-6815行 | 工作写实模块

        // ========== 工作写实模块 ==========
        (function() {
            const STORAGE_KEY = 'railway_work_diary_v2';
            let diaries = [];
            let _diaryLoadFailed = false; // 本地日志解析失败标志：为 true 时禁止任何覆写，避免把损坏当"空数据"写回
            let _diaryLoadFailedWarned = false; // 保护态提示只弹一次
            let issueCount = 0;
            const MAX_ISSUES = 20;
            let diaryFilterMode = 'today';
            let isEditMode = false; // 标记是否为编辑模式
            let currentEditDate = null; // 记录编辑时的原始日期

            // 本地日期字符串（避免 toISOString 的 UTC 时区错位：东8区凌晨会取到昨天）
            function getLocalDateStr(d) {
                return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
            }

            // 解析与归一化必须分开：原先 try 覆盖了整段 forEach，只要有一条脏记录
            // （如 issues 为字符串）就整体 catch 成 diaries=[]，随后用户敲一个字触发 2 秒防抖
            // 自动保存，就把只含当前一条的记录写回 localStorage —— 全部历史日志被永久覆盖且无提示。
            function loadDiaries() {
                let parsed = null;
                try {
                    const data = localStorage.getItem(STORAGE_KEY);
                    if (data) parsed = JSON.parse(data);
                } catch (e) {
                    // 解析失败：备份原文、置失败标志并禁止后续覆写（绝不当成"没有数据"处理）
                    console.error('[diary] 本地日志解析失败，已保留原文并进入只读保护:', e);
                    _diaryLoadFailed = true;
                    try { localStorage.setItem(STORAGE_KEY + '_corrupt_backup', localStorage.getItem(STORAGE_KEY) || ''); } catch (e2) {}
                    diaries = [];
                    return;
                }
                if (!Array.isArray(parsed)) { diaries = []; return; }
                // 逐条归一化：单条脏记录只丢它自己，不影响其它记录
                diaries = parsed.filter(d => d && typeof d === 'object' && !Array.isArray(d));
                diaries.forEach(d => {
                    if (!Array.isArray(d.issues)) d.issues = (d.issues == null || d.issues === '') ? [] : [String(d.issues)];
                    if (!Array.isArray(d.regulations)) d.regulations = [];
                    if (d.issues.length > d.regulations.length) { while (d.regulations.length < d.issues.length) d.regulations.push(''); }
                });
            }
            function saveDiaries() {
                try {
                    if (_diaryLoadFailed) {
                        // 保护态下拒绝覆写是必须的（否则损坏数据会被"空数据"覆盖），
                        // 但绝不能静默 —— 否则用户以为记上了、其实没保存。每次会话只提示一次，避免防抖反复弹窗。
                        console.error('[diary] 处于解析失败保护态，拒绝覆写本地存储');
                        if (!_diaryLoadFailedWarned) {
                            _diaryLoadFailedWarned = true;
                            alert('本地工作日志数据解析失败，已进入只读保护（原始数据已备份到 railway_work_diary_v2_corrupt_backup）。\n' +
                                  '当前填写的内容不会被保存，请先导出/清理本地数据后再重新记录，以免覆盖可恢复的原文。');
                        }
                        return;
                    }
                    localStorage.setItem(STORAGE_KEY, JSON.stringify(diaries));
                } catch (e) { alert('保存失败：' + e.message); }
            }

            // 自动保存（防抖 2 秒）
            var _autoSaveTimer = null;
            function autoSaveDiary() {
                if (_autoSaveTimer) clearTimeout(_autoSaveTimer);
                _autoSaveTimer = setTimeout(function() {
                    var date = document.getElementById('diary-date');
                    if (date && date.value && typeof window.saveDiary === 'function') {
                        window.saveDiary({ noToast: true });
                    }
                }, 2000);
            }
            // 输入框统一触发自动保存
            window.diaryAutoSave = function() { autoSaveDiary(); };

            function renderIssueFields(issues = [], regulations = []) {
                const container = document.getElementById('diary-issues-container');
                container.innerHTML = '';
                issueCount = issues.length > 0 ? issues.length : 1;
                for (let i = 0; i < issueCount; i++) {
                    addIssueFieldToDOM(issues[i] || '', i, (regulations && regulations[i]) || '');
                }
                updateAddIssueButton();
            }
            function addIssueFieldToDOM(value = '', index, regulation = '') {
                const container = document.getElementById('diary-issues-container');
                const div = document.createElement('div');
                div.className = 'diary-issue-row';
                div.id = `diary-issue-row-${index}`;
                div.innerHTML = `
                    <div style="display:flex; gap:6px; margin-bottom:6px; align-items:flex-start;">
                        <textarea class="diary-issue-input" id="diary-issue-${index}" placeholder="检查发现问题 ${index+1}" oninput="autoResize(this);diaryAutoSave()" style="flex:1; min-width:0; padding:8px 10px; border:1px solid var(--border); border-radius:6px; font-size:0.9rem; resize:vertical; font-family:inherit; min-height:38px; line-height:1.5;">${escapeHtml(value)}</textarea>
                        ${index > 0 ? '<button class="btn-remove-issue" onclick="removeIssueField(' + index + ')">×</button>' : ''}
                    </div>
                    <div style="display:flex; gap:6px; align-items:flex-start; margin-top:4px;">
                        <textarea class="diary-regulation-input" id="diary-regulation-${index}" placeholder="规章依据" rows="2" oninput="autoResize(this);diaryAutoSave()" style="flex:1; padding:6px 10px; border:1px solid var(--border); border-radius:6px; font-size:0.85rem; resize:vertical; font-family:inherit;">${escapeHtml(regulation)}</textarea>
                    </div>
                `;
                container.appendChild(div);
                const textarea = document.getElementById(`diary-issue-${index}`);
                const regTextarea = document.getElementById(`diary-regulation-${index}`);
                requestAnimationFrame(() => {
                    autoResize(textarea);
                    if (regTextarea) autoResize(regTextarea);
                });
            }
            window.copyIssueWithRegulation = function(issueIdx, btnEl) {
                const issueTextarea = document.getElementById(`diary-issue-${issueIdx}`);
                const regTextarea = document.getElementById(`diary-regulation-${issueIdx}`);
                const problemText = issueTextarea ? issueTextarea.value.trim() : '';
                const regulationText = regTextarea ? regTextarea.value.trim() : '';
                let copyContent = problemText;
                if (regulationText) copyContent += (copyContent ? '\n' : '') + regulationText;
                if (!copyContent) { alert('没有可复制的内容'); return; }
                _doCopy(copyContent, btnEl, '已复制 ✓');
            };
            window.addIssueField = function() {
                if (issueCount >= MAX_ISSUES) { alert(`最多添加 ${MAX_ISSUES} 个问题`); return; }
                addIssueFieldToDOM('', issueCount);
                issueCount++;
                updateAddIssueButton();
            };
            window.removeIssueField = function(index) {
                const row = document.getElementById(`diary-issue-row-${index}`);
                if (row) row.remove();
                const rows = document.querySelectorAll('#diary-issues-container .diary-issue-row');
                issueCount = rows.length;
                rows.forEach((row, idx) => {
                    row.id = `diary-issue-row-${idx}`;
                    const textareas = row.querySelectorAll('textarea');
                    if (textareas[0]) { textareas[0].id = `diary-issue-${idx}`; textareas[0].placeholder = `检查发现问题 ${idx+1}`; }
                    if (textareas[1]) { textareas[1].id = `diary-regulation-${idx}`; }
                    const removeBtn = row.querySelector('.btn-remove-issue');
                    if (removeBtn) removeBtn.setAttribute('onclick', `removeIssueField(${idx})`);
                    if (idx === 0 && removeBtn) removeBtn.style.display = 'none';
                    requestAnimationFrame(() => { if (textareas[0]) autoResize(textareas[0]); if (textareas[1]) autoResize(textareas[1]); });
                });
                updateAddIssueButton();
            };
            function updateAddIssueButton() {
                const btn = document.getElementById('btn-add-issue');
                if (issueCount >= MAX_ISSUES) { btn.disabled = true; btn.textContent = `已达到最大问题数量(${MAX_ISSUES}个)`; }
                else { btn.disabled = false; btn.textContent = `+ 添加问题 (还可添加 ${MAX_ISSUES - issueCount} 个)`; }
            }
            function collectIssuesAndRegulations() {
                const issues = [];
                const regulations = [];
                for (let i = 0; i < issueCount; i++) {
                    const issueTextarea = document.getElementById(`diary-issue-${i}`);
                    const regTextarea = document.getElementById(`diary-regulation-${i}`);
                    if (issueTextarea) { const val = issueTextarea.value.trim(); issues.push(val || ''); }
                    else { issues.push(''); }
                    if (regTextarea) { regulations.push(regTextarea.value.trim()); }
                    else { regulations.push(''); }
                }
                return { issues, regulations };
            }
            function collectIssues() { return collectIssuesAndRegulations().issues; }

            // 辅助函数：从文本中提取完整违规引用句子（全局可用）
            window.extractFullViolationSentence = function(text) {
                if (!text) return '';
                var regex = /(?:不符合|违反)[^。]*《[^》]+》[^。]*。(?![^。]*《)/;
                var match = text.match(regex);
                if (match) return match[0].trim();
                var fallback = text.match(/[^。]*《[^》]+》[^。]*。/);
                if (fallback) return fallback[0].trim();
                return text.slice(0, 200).trim();
            };

            // 从检查信息一键记入日志（方案 A：直接追加到今天）
            // content: 问题描述, regulation: 规章依据, date: 可选，默认今天
            // 返回 {ok, reason, message, date}：供 app.js 的智能体桥接层回报真实结果，
            // 避免"AI 向用户确认日志已写入、其实什么都没写"的假成功。
            window.addIssueToDiary = function(content, regulation, date) {
                if (!content || !content.trim()) return { ok: false, reason: 'empty', message: '内容为空，未写入' };
                const targetDate = date || (function() {
                    var d = new Date();
                    return d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0');
                })();
                loadDiaries(); // 确保最新数据
                var existing = diaries.find(function(d) { return d.date === targetDate; });
                if (existing) {
                    // 追加到已有记录
                    if (!existing.issues) existing.issues = [];
                    if (!existing.regulations) existing.regulations = [];
                    const c = content.trim();
                    // 去重：当日已存在完全相同的问题则不重复记入
                    if (existing.issues.some(function(x) { return x === c; })) {
                        return { ok: false, reason: 'duplicate', message: '当日已存在完全相同的问题，已去重未重复写入', date: targetDate };
                    }
                    existing.issues.push(c);
                    existing.regulations.push((regulation || '').trim());
                } else {
                    // 创建新记录
                    diaries.push({
                        date: targetDate,
                        work: '',
                        issues: [content.trim()],
                        regulations: [(regulation || '').trim()],
                        mediaIds: []
                    });
                }
                diaries.sort(function(a, b) { return new Date(b.date) - new Date(a.date); });
                saveDiaries();
                updateDiaryCount();
                return { ok: true, reason: 'saved', message: '已写入 ' + targetDate + ' 的工作日志', date: targetDate };
            };

            window.saveDiary = async function(opts) {
                var noToast = opts && opts.noToast;
                const date = document.getElementById('diary-date').value;
                const work = document.getElementById('diary-work').value.trim();
                // 自动保存（noToast）时内容为空只代表「还没写完」，必须静默跳过：
                // 否则用户清空正文的瞬间会弹出阻塞式 alert，且每 2 秒重复一次。
                if (!date) { if (noToast) return; alert('请选择日期'); return; }
                if (!work && collectIssues().filter(i => i).length === 0) {
                    if (noToast) return;
                    alert('请输入工作内容或问题'); return;
                }
                const { issues, regulations } = collectIssuesAndRegulations();

                // 保存媒体文件到 IndexedDB（新文件存入，旧文件复用 ID）
                const mediaIds = [];
                if (_mediaFiles && _mediaFiles.length > 0) {
                    for (let i = 0; i < _mediaFiles.length; i++) {
                        const isExisting = _existingMediaIds[i] !== undefined && _existingMediaIds[i] !== null;
                        if (isExisting) {
                            // 已有媒体，复用旧 ID
                            mediaIds.push(_existingMediaIds[i]);
                        } else {
                            // 新文件，存入 IndexedDB
                            const capTime = _mediaCaptureTimes[i] || '';
                            const id = await saveMediaToDB(_mediaFiles[i], capTime);
                            if (id !== null) mediaIds.push(id);
                        }
                    }
                    // 关键：保存后要用结果回写「已存在 ID」表。
                    // 不回写的话，刚存进去的新文件在下一次自动保存（防抖 2 秒）时
                    // 依然被当作新文件再次入库 —— 用户边打字边产生成百上千份重复副本，
                    // 旧记录变成孤儿数据，IndexedDB 体积暴涨。
                    _existingMediaIds = mediaIds.slice();
                }

                // 检查日期是否已有记录
                const existingIdx = diaries.findIndex(d => d.date === date);

                // 已有记录则覆盖（用户已在输入前加载历史内容并追加）
                if (existingIdx !== -1) {
                    diaries[existingIdx] = { date, work, issues, regulations, mediaIds };
                } else {
                    // 没有重叠，直接添加
                    diaries.push({ date, work, issues, regulations, mediaIds });
                }

                diaries.sort((a, b) => new Date(b.date) - new Date(a.date));
                saveDiaries();
                updateDiaryCount();

                // 重置编辑状态
                isEditMode = false;
                currentEditDate = null;
                if (window._editSession) window._editSession.clear(); // 折叠重建时不再重开此编辑态

                // 清空输入框（自动保存不清空，用户还在输入）
                if (noToast) {
                    // 自动保存：右下角浮动提示
                    var toast = document.getElementById('diary-save-toast');
                    if (!toast) {
                        toast = document.createElement('div');
                        toast.id = 'diary-save-toast';
                        toast.textContent = '💾 已自动保存';
                        Object.assign(toast.style, {
                            position:'fixed', bottom:'20px', right:'20px',
                            background:'#276749', color:'#fff',
                            padding:'8px 16px', borderRadius:'20px',
                            fontSize:'0.82rem', fontWeight:'600',
                            boxShadow:'0 2px 8px rgba(0,0,0,.2)',
                            zIndex:'10000', opacity:'0',
                            transition:'opacity .3s ease'
                        });
                        document.body.appendChild(toast);
                    }
                    toast.style.opacity = '1';
                    clearTimeout(toast._timer);
                    toast._timer = setTimeout(function() { toast.style.opacity = '0'; }, 2000);
                }
            };
            window.clearDiaryForm = function() {
                isEditMode = false;
                currentEditDate = null;
                // 重置为网页打开初始状态
                document.getElementById('diary-date').valueAsDate = new Date();
                document.getElementById('diary-work').value = '';
                autoResize(document.getElementById('diary-work'));
                renderIssueFields([]);
                // 切换到输入视图（跳过自动加载当日记录）
                showInputView(true);
            };
            window.editDiary = async function(date) {
                const diary = diaries.find(d => d.date === date);
                if (!diary) return;
                isEditMode = true; // 标记为编辑模式
                currentEditDate = diary.date; // 记录原始编辑日期
                // 登记编辑会话（折叠屏重建后可自动重开编辑态）
                if (window._editSession) window._editSession.set({ module: 'diary', recordId: diary.date });
                // 切换到输入视图（会清空媒体缓存和预览）
                await showInputView(true);
                // 加载目标日记的内容和媒体
                document.getElementById('diary-date').value = diary.date;
                document.getElementById('diary-work').value = diary.work;
                autoResize(document.getElementById('diary-work'));
                renderIssueFields(diary.issues || [], diary.regulations || []);
                await loadDiaryMedia(diary);
            };
            // 折叠屏/旋转重建后，自动重开 diary 编辑态（内容由 IndexedDB 自动载入）
            window.restoreEdit_diary = function(ctx) {
                if (!ctx || !ctx.recordId) return;
                if (typeof window.editDiary === 'function') {
                    try { window.editDiary(ctx.recordId); } catch (e) { console.warn('restoreEdit_diary 失败', e); }
                }
            };
            window.deleteDiary = function(date) {
                if (!confirm('确定要删除该日期的记录吗？')) return;
                diaries = diaries.filter(d => d.date !== date);
                saveDiaries();
                updateDiaryCount();
                if (diaryFilterMode === 'history') {
                    renderTodayRecords();
                    renderCalendar();
                    document.getElementById('diary-date-detail').style.display = 'none';
                }
            };
            // 自复式复制工具函数
            function _doCopy(text, btnEl, successLabel) {
                const original = btnEl ? btnEl.innerHTML : '';
                const originalBg = btnEl ? btnEl.style.background : '';
                const originalColor = btnEl ? btnEl.style.color : '';
                const doFeedback = function() {
                    if (!btnEl) return;
                    btnEl.innerHTML = successLabel || '已复制 ✓';
                    btnEl.style.background = '#276749';
                    btnEl.style.color = '#fff';
                    btnEl.disabled = true;
                    setTimeout(function() {
                        btnEl.innerHTML = original;
                        btnEl.style.background = originalBg;
                        btnEl.style.color = originalColor;
                        btnEl.disabled = false;
                    }, 2000);
                };
                if (navigator.clipboard && navigator.clipboard.writeText) {
                    navigator.clipboard.writeText(text).then(doFeedback).catch(function() {
                        const ta = document.createElement('textarea'); ta.value = text;
                        document.body.appendChild(ta); ta.select(); document.execCommand('copy'); document.body.removeChild(ta);
                        doFeedback();
                    });
                } else {
                    const ta = document.createElement('textarea'); ta.value = text;
                    document.body.appendChild(ta); ta.select(); document.execCommand('copy'); document.body.removeChild(ta);
                    doFeedback();
                }
            }
            // =====【v3.75】复制按钮统一改造 =====
            // 约定：内容由"多部分"构成的复制按钮 → 点击弹出选择（复制哪一部分）；单一字段 → 直接复制，不弹菜单。
            // 菜单是 body 级浮层（避免被卡片 overflow 裁切），配色走 CSS 变量，暗黑模式在 unify.css 有 [data-theme="dark"] 覆盖。
            var _diaryCopyMenuEl = null;
            function diaryCloseCopyMenu() {
                if (_diaryCopyMenuEl && _diaryCopyMenuEl.parentNode) _diaryCopyMenuEl.parentNode.removeChild(_diaryCopyMenuEl);
                _diaryCopyMenuEl = null;
                document.removeEventListener('click', _diaryCopyMenuOutside, true);
                document.removeEventListener('keydown', _diaryCopyMenuEsc, true);
            }
            function _diaryCopyMenuOutside(e) {
                if (_diaryCopyMenuEl && !_diaryCopyMenuEl.contains(e.target)) diaryCloseCopyMenu();
            }
            function _diaryCopyMenuEsc(e) { if (e && e.key === 'Escape') diaryCloseCopyMenu(); }
            function diaryCopyText(text, btnEl, okLabel) {
                const t = String(text == null ? '' : text).trim();
                if (!t) { alert('没有可复制的内容'); return; }
                _doCopy(t, btnEl, okLabel || '已复制 ✓');
            }
            // items: [{ label, desc, run(btnEl) }]；只剩一项时直接执行（不多要一次点击）
            // 通用浮层菜单（复制范围 / 输入方式 都用它）；diaryCopyMenu 为兼容别名
            window.diaryMenu = function(btnEl, title, items) {
                diaryCloseCopyMenu();
                items = (items || []).filter(function(it) { return it && typeof it.run === 'function'; });
                if (!items.length) { alert('没有可复制的内容'); return; }
                if (items.length === 1) { items[0].run(btnEl); return; }
                const box = document.createElement('div');
                box.className = 'diary-copy-menu';
                box.innerHTML = '<div class="diary-copy-menu-title">' + escapeHtml(title || '复制哪部分？') + '</div>'
                    + items.map(function(it, i) {
                        return '<button type="button" class="diary-copy-menu-item" data-i="' + i + '">'
                            + '<span class="diary-copy-menu-label">' + escapeHtml(it.label) + '</span>'
                            + (it.desc ? '<span class="diary-copy-menu-desc">' + escapeHtml(it.desc) + '</span>' : '')
                            + '</button>';
                    }).join('');
                document.body.appendChild(box);
                const r = (btnEl && btnEl.getBoundingClientRect) ? btnEl.getBoundingClientRect() : null;
                const w = 246;
                let left = r ? r.left : 12;
                let top = r ? (r.bottom + 6) : 80;
                left = Math.max(8, Math.min(left, (window.innerWidth || 800) - w - 8));
                top = Math.min(top, Math.max(8, (window.innerHeight || 600) - box.offsetHeight - 8));
                box.style.width = w + 'px';
                box.style.left = left + 'px';
                box.style.top = top + 'px';
                box.querySelectorAll('.diary-copy-menu-item').forEach(function(b) {
                    b.onclick = function() {
                        const it = items[+b.dataset.i];
                        diaryCloseCopyMenu();
                        try { it.run(btnEl); } catch (e) { alert('复制失败：' + (e && e.message ? e.message : e)); }
                    };
                });
                _diaryCopyMenuEl = box;
                setTimeout(function() {
                    document.addEventListener('click', _diaryCopyMenuOutside, true);
                    document.addEventListener('keydown', _diaryCopyMenuEsc, true);
                }, 0);
            };
            window.diaryCopyMenu = window.diaryMenu;

            // =====【v3.75 二改】问题复制：两级选择 =====
            // 第一级：选条数（第 1 条 / 第 2 条 / … / 全部 N 条，**按实际填写内容动态生成**）
            // 第二级：选该条复制哪部分（问题 / 规章 / 问题+规章）
            function _diaryPartText(issue, regulation, kind) {
                const i = String(issue == null ? '' : issue).trim();
                const r = String(regulation == null ? '' : regulation).trim();
                if (kind === 'issue') return i;
                if (kind === 'reg') return r;
                return i && r ? (i + '\n' + r) : (i || r);
            }
            // 第二级菜单：某一（或全部）条 复制哪部分
            function diaryAskPart(btnEl, no, issue, regulation) {
                const hasI = !!String(issue || '').trim();
                const hasR = !!String(regulation || '').trim();
                const title = no ? ('第 ' + no + ' 条：复制哪部分？') : '全部内容：复制哪部分？';
                window.diaryMenu(btnEl, title, [
                    hasI ? { label: '📋 复制问题', desc: '仅问题描述', run: function(b) { diaryCopyText(_diaryPartText(issue, regulation, 'issue'), b, '已复制问题 ✓'); } } : null,
                    hasR ? { label: '📜 复制规章', desc: '仅规章依据', run: function(b) { diaryCopyText(_diaryPartText(issue, regulation, 'reg'), b, '已复制规章 ✓'); } } : null,
                    (hasI && hasR) ? { label: '📋📜 复制全部', desc: '问题 + 规章依据', run: function(b) { diaryCopyText(_diaryPartText(issue, regulation, 'both'), b, '已复制全部 ✓'); } } : null
                ]);
            }
            // 第一级菜单：按条选（items: [{ no, issue, regulation }]，no 为显示条号）
            function diaryCopyIssuesByIndex(btnEl, items) {
                items = (items || []).filter(function(it) {
                    return it && (String(it.issue || '').trim() || String(it.regulation || '').trim());
                });
                if (!items.length) { alert('没有可复制的内容'); return; }
                const first = items.map(function(it) {
                    const i = String(it.issue || '').trim();
                    const r = String(it.regulation || '').trim();
                    const brief = i ? (i.slice(0, 14) + (i.length > 14 ? '…' : '')) : '（未填写问题，仅规章）';
                    const opts = (i && r) ? '问题 + 规章' : (r ? '仅规章' : '仅问题');
                    return {
                        label: '第 ' + it.no + ' 条',
                        desc: brief + ' · ' + opts,
                        run: function(b) { diaryAskPart(b, it.no, it.issue, it.regulation); }
                    };
                });
                // 【v3.75 四改】不再提供「📄 全部 N 条」汇总项（用户要求）：一级只列逐条，
                //   需要整段内容时用「工作内容」标题行的「复制全部」。
                window.diaryMenu(btnEl, '先选择要复制的条数（共 ' + items.length + ' 条有内容）', first);
            }
            // 输入视图：从表单收集（条号 = 输入框序号，动态）
            window.diaryCopyIssueSection = function(btnEl) {
                const { issues, regulations } = collectIssuesAndRegulations();
                diaryCopyIssuesByIndex(btnEl, issues.map(function(issue, idx) {
                    return { no: idx + 1, issue: issue, regulation: regulations[idx] || '' };
                }));
            };
            // 查看视图（卡片）：从该日记录收集
            window.diaryCopyIssuesCard = function(date, btnEl) {
                const diary = diaries.find(function(d) { return d.date === date; });
                if (!diary || !diary.issues || !diary.issues.length) { alert('没有可复制的内容'); return; }
                diaryCopyIssuesByIndex(btnEl, diary.issues.map(function(issue, idx) {
                    return { no: idx + 1, issue: issue, regulation: (diary.regulations && diary.regulations[idx]) || '' };
                }));
            };
            // 【v3.75 二改/三改】「✏️ 输入 ▾」：拍照 / 录像 / 文本输入 三选一（现挂在工具栏的「输入」按钮 ▾ 上）
            //   从查询视图点进来时先把视图切回输入（媒体标签要插到输入框里），已在输入视图则不动（避免重置表单）
            function _diaryEnsureInputView() {
                const v = document.getElementById('diary-input-view');
                if (v && v.style.display === 'none' && typeof showInputView === 'function') {
                    try { showInputView(); } catch (e) {}
                }
            }
            window.diaryInputMenu = function(btnEl) {
                window.diaryMenu(btnEl, '选择输入方式', [
                    { label: '✏️ 文本输入', desc: '光标定位到最近编辑的文本框（图片/视频会插到那里）', run: function() { _diaryEnsureInputView(); const ta = getActiveTextarea(); if (ta) { ta.focus(); } } },
                    { label: '📷 图片（拍照）', desc: '拍完自动插入到光标处的文本框', run: function() { _diaryEnsureInputView(); const el = document.getElementById('camera-input'); if (el) el.click(); } },
                    { label: '🎥 视频（录像）', desc: '录完自动插入到光标处的文本框', run: function() { _diaryEnsureInputView(); const el = document.getElementById('video-input'); if (el) el.click(); } }
                ]);
            };
            // 复制输入框中的工作内容（单一字段 → 直接复制，不弹菜单）
            window.copyWorkContent = function(btnEl) {
                const workEl = document.getElementById('diary-work');
                const work = workEl ? workEl.value.trim() : '';
                if (!work) { alert('没有工作内容可复制'); return; }
                if (!btnEl) btnEl = document.getElementById('diary-copy-work-btn');
                _doCopy(work, btnEl, '已复制 ✓');
            };
            // 复制单个问题输入框内容
            window.copyIssueInput = function(index) {
                const textarea = document.getElementById('diary-issue-' + index);
                if (!textarea) return;
                const text = textarea.value.trim();
                if (!text) { alert('没有内容可复制'); return; }
                const btnEl = textarea.parentElement.querySelector('.diary-issue-actions button');
                _doCopy(text, btnEl, '已复制 ✓');
            };
            window.copyIssue = function(text, btnEl) { _doCopy(text, btnEl, '已复制 ✓'); };
            // 【v3.75 三改】「工作内容」标题行的复制按钮 = 原「日期行全部复制」与「工作内容复制」合并：
            //   只在「复制全部（工作写实 + 检查问题 + 规章）」与「仅复制工作写实」之间选择。
            //   检查发现问题有自己的专用按钮（两级：先选条数再选 问题 / 规章），此处不再重复提供入口。
            window.copyWorkOrAll = function(btnEl) {
                const workEl = document.getElementById('diary-work');
                const work = workEl ? workEl.value.trim() : '';
                const { issues, regulations } = collectIssuesAndRegulations();
                const nIssue = issues.filter(Boolean).length;
                const nReg = regulations.filter(Boolean).length;
                if (!work && !nIssue && !nReg) { alert('没有可复制的内容'); return; }
                const allText = function() {
                    let text = '';
                    if (work) text += work;
                    issues.forEach(function(issue, idx) {
                        if (!issue) return;
                        if (text) text += '\n';
                        text += issue;
                        if (regulations[idx]) text += '\n' + regulations[idx];
                    });
                    return text;
                };
                window.diaryMenu(btnEl, '复制哪部分？', [
                    // 「复制全部」只在**除工作内容外还有内容**时出现：否则与「复制工作写实」等价，
                    //   菜单里两项内容一样会让用户白点一次（当只剩一项时 diaryMenu 会直接执行，不弹菜单）。
                    (nIssue || nReg) ? { label: '📄 复制全部', desc: (work ? '工作写实 + 检查问题 + 规章' : '检查问题 + 规章'), run: function(b) { diaryCopyText(allText(), b, '已复制全部 ✓'); } } : null,
                    work ? { label: '✍️ 复制工作写实', desc: '仅「工作内容」一栏', run: function(b) { diaryCopyText(work, b, '已复制写实 ✓'); } } : null
                ]);
            };
            // 兼容旧引用（原日期行的「📄 全部复制」按钮已并入「工作内容」标题行）
            window.copyAllToday = function(btnEl) { return window.copyWorkOrAll(btnEl); };
            window.deleteIssue = function(date, issueIndex) {
                const diary = diaries.find(d => d.date === date);
                if (!diary) return;
                if (!confirm('确定要删除该问题吗？')) return;
                diary.issues.splice(issueIndex, 1);
                if (diary.regulations) diary.regulations.splice(issueIndex, 1);
                saveDiaries();
                if (diaryFilterMode === 'history') {
                    renderCalendar();
                    renderDateDetail(date);
                } else {
                    renderDateDetail(date);
                }
            };
            // escapeHtml 已统一到 utils.js (window.escapeHtml)，此处不再重复定义

            // 记录数展示已移除（统一在设置面板显示「总储存量」）
            function updateDiaryCount() {
                // 原逻辑渲染 diary-count，已移除
            }

            // 生成单条日记卡片 HTML（供今日记录与搜索结果共用）
            function buildDiaryCardHtml(diary) {
                const dateObj = new Date(diary.date);
                const weekDay = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][dateObj.getDay()];
                const dateStr = (dateObj.getMonth() + 1) + '月' + dateObj.getDate() + '日 ' + weekDay;

                let html = '<div class="diary-card">';
                html += '<div class="diary-card-header"><div class="diary-card-date">' + dateStr + '</div><div class="diary-card-actions"><button class="btn btn-info btn-small" onclick="editDiary(\'' + diary.date + '\')">编辑</button><button class="btn btn-danger btn-small" onclick="deleteDiary(\'' + diary.date + '\')">删除</button></div></div>';
                html += '<div class="diary-work-block"><div class="diary-work-header"><span class="diary-work-title">📋 工作内容</span><button class="btn btn-small btn-secondary" onclick="copyDiaryWork(\'' + diary.date + '\', this)">📋 复制</button></div><div class="diary-work-content">' + escapeHtml(diary.work) + '</div></div>';

                if (diary.issues && diary.issues.length > 0) {
                    html += '<div class="diary-issues-block"><div class="diary-issues-header"><span class="diary-issues-title">⚠️ 发现问题 (' + diary.issues.length + '条)</span><button class="btn btn-small btn-secondary" onclick="diaryCopyIssuesCard(\'' + diary.date + '\', this)" title="先选第几条，再选 问题 / 规章">📋 复制▾</button></div>';
                    diary.issues.forEach((issue, idx) => {
                        html += '<div class="diary-issue-item"><div class="diary-issue-item-num">' + (idx + 1) + '</div><div class="diary-issue-item-content">' + escapeHtml(issue) + '</div><div class="diary-issue-item-actions"><button class="btn btn-small btn-secondary" onclick="copyDiaryIssue(\'' + diary.date + '\', ' + idx + ', this)">📋 复制</button><button class="btn btn-small btn-danger" onclick="deleteIssue(\'' + diary.date + '\', ' + idx + ')">删除</button></div></div>';
                    });
                    html += '</div>';
                }
                html += '</div>';
                return html;
            }

            // 渲染今日记录列表
            function renderTodayRecords() {
                const container = document.getElementById('diary-records-list');
                const today = getLocalDateStr(new Date());
                const todayRecords = diaries.filter(d => d.date === today);

                if (todayRecords.length === 0) {
                    container.innerHTML = '<div class="empty-state"><div class="empty-state-icon">📝</div><p>今日暂无工作记录</p></div>';
                    return;
                }

                let html = '';
                todayRecords.forEach(function(diary) {
                    html += buildDiaryCardHtml(diary);
                });
                container.innerHTML = html;
            }

            // 关键词搜索：检索工作内容 / 问题 / 规章依据全文
            // ⚠️ 过滤规则统一在 diaryFilterByKeyword（"一键 AI 修改"的"当前查询命中"也用同一套，避免两处漂移）
            window.diarySearch = function(keyword) {
                const container = document.getElementById('diary-records-list');
                const kw = (keyword || '').trim().toLowerCase();
                if (!kw) { document.getElementById('diary-records-list').innerHTML = ''; return; }
                const matched = diaryFilterByKeyword(kw);
                if (matched.length === 0) {
                    container.innerHTML = '<div class="empty-state"><div class="empty-state-icon">🔍</div><p>未找到与「' + escapeHtml(keyword) + '」相关的记录</p></div>';
                    return;
                }
                let html = '<div style="padding:6px 4px;color:#64748b;font-size:0.8rem;">搜索「' + escapeHtml(keyword) + '」命中 ' + matched.length + ' 条</div>';
                matched.forEach(function(diary) { html += buildDiaryCardHtml(diary); });
                container.innerHTML = html;
            };

            // 日历相关变量
            let _calendarYear = new Date().getFullYear();
            let _calendarMonth = new Date().getMonth();
            let _selectedDate = null;

            // 个人考勤（手动标记，localStorage 持久化）
            // 基本性质（必选，显示在日期顶端中间）：日、差、休、公、培、假
            // 附加项（仅 日/差 可选，显示在日期左右下角，最多 2 个）：室(室内)、值(值班)、添(添乘)、夜(夜查)、施(施工)
            // 存储格式：{ 'YYYY-MM-DD': { n: '日'|'差'|'休'|'公'|'培'|'假', s: ['室','值'] } }，s 仅 日/差 存在
            // 统计按基本性质（日、差、休、公、培、假）分组
            const ATT_NATURES = ['日', '差', '休', '公', '培', '假'];
            const ATT_HAS_SUB = { '日': true, '差': true };
            const ATT_SUBS = ['室', '值', '添', '夜', '施'];
            const ATT_MAX_SUB = 2;
            function getAttendance() {
                try { return JSON.parse(localStorage.getItem('attendance_v1') || '{}'); } catch (e) { return {}; }
            }
            // 旧数据（单字/复合串/旧数组）→ 新对象 {n, s}；无法识别返回 null
            function migrateOneToObj(v) {
                let arr = [];
                if (typeof v === 'string') arr = [v];
                else if (Array.isArray(v)) arr = v;
                else if (v && typeof v === 'object' && typeof v.n === 'string') return { n: v.n, s: Array.isArray(v.s) ? v.s.slice() : [] };
                let n = null, subs = [];
                const LEGACY = {
                    '值': '日·值', '添': '日·添', '夜': '日·夜', '施': '日·施', '室': '日·室',
                    '差': '差', '休': '休', '公': '公', '公休': '公', '假': '假', '培': '培', '日': '日',
                    '请假': '假', '培训': '培', '休息': '休', '出差': '差', '日勤': '日',
                    '值班': '日·值', '夜查': '日·夜', '施工': '日·施', '添乘': '日·添', '室内': '日·室'
                };
                arr.forEach(function(s) {
                    s = String(s).trim();
                    if (!s) return;
                    let m = (s.indexOf('·') !== -1) ? s : (LEGACY[s] || null);
                    if (!m) return;
                    if (m.indexOf('·') !== -1) {
                        const p = m.split('·'); const c = p[0], it = p[1];
                        if (!n) n = c;
                        if ((c === '日' || c === '差') && ATT_SUBS.indexOf(it.charAt(0)) !== -1 && subs.length < ATT_MAX_SUB) subs.push(it.charAt(0));
                    } else {
                        if (!n) n = m;
                    }
                });
                if (!n) return null;
                return subs.length ? { n: n, s: subs } : { n: n };
            }
            // 旧数据迁移（仅首次加载写回一次，统一为新对象格式）
            (function migrateAttendance() {
                const m = getAttendance();
                let changed = false;
                Object.keys(m).forEach(function(k) {
                    const obj = migrateOneToObj(m[k]);
                    if (obj === null) delete m[k]; else m[k] = obj;
                    changed = true;
                });
                if (changed) { try { localStorage.setItem('attendance_v1', JSON.stringify(m)); } catch (e) {} }
            })();
            // 读取某日考勤（归一化为 {n, s}），旧格式即时迁移
            function getAttObj(dateStr) {
                const m = getAttendance();
                const v = m[dateStr];
                if (v == null) return null;
                if (typeof v === 'object' && !Array.isArray(v) && typeof v.n === 'string') {
                    return { n: v.n, s: Array.isArray(v.s) ? v.s.slice() : [] };
                }
                return migrateOneToObj(v);
            }
            function attLabelOf(obj) {
                if (!obj) return '';
                let t = obj.n;
                if (obj.s && obj.s.length) t += ' + ' + obj.s.join('、');
                return t;
            }
            window.setAttendance = function(dateStr, n, s) {
                const m = getAttendance();
                if (n) {
                    const obj = { n: n };
                    if (s && s.length) obj.s = s.slice();
                    m[dateStr] = obj;
                } else {
                    delete m[dateStr];
                }
                localStorage.setItem('attendance_v1', JSON.stringify(m));
                if (_selectedDate === dateStr) renderDateDetail(dateStr);
                renderCalendar();
            };
            let _attModalDate = null;
            let _attModalNature = null;
            let _attModalSubs = [];
            function attToast(msg) {
                let t = document.getElementById('att-toast');
                if (!t) {
                    t = document.createElement('div');
                    t.id = 'att-toast';
                    t.style.cssText = 'position:fixed;left:50%;bottom:80px;transform:translateX(-50%);background:rgba(15,23,42,0.92);color:#fff;padding:8px 16px;border-radius:20px;font-size:0.85rem;z-index:9999;opacity:0;transition:opacity .2s;pointer-events:none;';
                    document.body.appendChild(t);
                }
                t.textContent = msg;
                t.style.opacity = '1';
                clearTimeout(t._timer);
                t._timer = setTimeout(function() { t.style.opacity = '0'; }, 1400);
            }
            function buildAttModalButtons() {
                const wrap = document.getElementById('att-modal-codes');
                if (!wrap) return;
                let h = '';
                h += '<div class="att-nature-row">';
                ATT_NATURES.forEach(function(n) {
                    h += '<button type="button" class="att-nature-btn" data-n="' + n + '" onclick="attModalPickNature(\'' + n + '\')">' + n + '</button>';
                });
                h += '</div>';
                h += '<div class="att-sub-wrap" id="att-modal-subs" style="display:none;">';
                h += '<div class="att-sub-label">附加项（日/差可选，最多' + ATT_MAX_SUB + '）</div>';
                h += '<div class="att-sub-row">';
                ATT_SUBS.forEach(function(ch) {
                    h += '<button type="button" class="att-sub-btn" data-sub="' + ch + '" onclick="attModalToggleSub(\'' + ch + '\')">' + ch + '</button>';
                });
                h += '</div></div>';
                wrap.innerHTML = h;
            }
            function _updateAttModalUI() {
                document.querySelectorAll('#attendance-modal .att-nature-btn').forEach(function(b) {
                    b.classList.toggle('att-active', b.getAttribute('data-n') === _attModalNature);
                });
                const subWrap = document.getElementById('att-modal-subs');
                if (subWrap) subWrap.style.display = (_attModalNature === '日' || _attModalNature === '差') ? 'block' : 'none';
                document.querySelectorAll('#attendance-modal .att-sub-btn').forEach(function(b) {
                    const ch = b.getAttribute('data-sub');
                    b.classList.toggle('att-active', _attModalSubs.indexOf(ch) !== -1);
                    b.disabled = (_attModalSubs.length >= ATT_MAX_SUB && _attModalSubs.indexOf(ch) === -1);
                });
                const cur = document.getElementById('att-modal-current');
                if (cur) {
                    if (_attModalNature) {
                        let txt = '考勤：' + _attModalNature;
                        if (_attModalSubs.length) txt += ' + ' + _attModalSubs.join('、');
                        cur.textContent = txt;
                    } else {
                        cur.textContent = '请选择基本性质';
                    }
                }
            }
            window.openAttendanceModal = function(dateStr) {
                _attModalDate = dateStr;
                const dateObj = new Date(dateStr);
                const weekDay = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][dateObj.getDay()];
                const titleEl = document.getElementById('att-modal-date');
                if (titleEl) titleEl.textContent = (dateObj.getMonth() + 1) + '月' + dateObj.getDate() + '日 ' + weekDay;
                const obj = getAttObj(dateStr);
                _attModalNature = obj ? obj.n : null;
                _attModalSubs = obj && obj.s ? obj.s.slice() : [];
                _updateAttModalUI();
                const m = document.getElementById('attendance-modal');
                if (m) m.style.display = 'flex';
            };
            window.closeAttendanceModal = function() {
                const m = document.getElementById('attendance-modal');
                if (m) m.style.display = 'none';
                _attModalDate = null;
                _attModalNature = null;
                _attModalSubs = [];
            };
            window.attModalPickNature = function(n) {
                if (!_attModalDate) return;
                _attModalNature = n;
                if (n !== '日' && n !== '差') _attModalSubs = [];
                _updateAttModalUI();
            };
            window.attModalToggleSub = function(ch) {
                if (!_attModalDate) return;
                if (_attModalNature !== '日' && _attModalNature !== '差') return;
                const idx = _attModalSubs.indexOf(ch);
                if (idx !== -1) {
                    _attModalSubs.splice(idx, 1);
                } else {
                    if (_attModalSubs.length >= ATT_MAX_SUB) { attToast('最多选择 ' + ATT_MAX_SUB + ' 个附加项'); return; }
                    _attModalSubs.push(ch);
                }
                _updateAttModalUI();
            };
            window.attModalClear = function() {
                if (!_attModalDate) return;
                setAttendance(_attModalDate, null, null);
                closeAttendanceModal();
            };
            window.attModalConfirm = function() {
                if (!_attModalDate) return;
                if (!_attModalNature) { attToast('请先选择基本性质'); return; }
                setAttendance(_attModalDate, _attModalNature, _attModalSubs.slice());
                closeAttendanceModal();
            };
            window.attModalViewDiary = function() {
                const d = _attModalDate;
                closeAttendanceModal();
                if (d) selectDate(d);
            };
            // 初始化考勤弹窗按钮（由 JS 生成，保证与数据源一致）
            buildAttModalButtons();

            // 复制日记中的工作内容（单一字段 → 直接复制）
            window.copyDiaryWork = function(date, btnEl) {
                const diary = diaries.find(d => d.date === date);
                const work = (diary && diary.work) ? String(diary.work).trim() : '';
                if (!work) { alert('没有工作内容可复制'); return; }
                _doCopy(work, btnEl, '已复制 ✓');
            };

            // 复制日记中的单个问题（含规章 → 弹选择：问题 / 规章 / 全部）
            window.copyDiaryIssue = function(date, index, btnEl) {
                const diary = diaries.find(d => d.date === date);
                if (!diary || !diary.issues || !diary.issues[index]) { alert('没有可复制的内容'); return; }
                const problem = diary.issues[index];
                const regulation = (diary.regulations && diary.regulations[index]) ? diary.regulations[index] : '';
                diaryAskPart(btnEl, index + 1, problem, regulation);   // 第二级：该条 复制哪部分
            };

            // 渲染日历
            function renderCalendar() {
                const container = document.getElementById('diary-calendar');
                const monthNames = ['1月', '2月', '3月', '4月', '5月', '6月', '7月', '8月', '9月', '10月', '11月', '12月'];

                // 获取该月的所有日期记录
                const datesWithRecords = new Set(diaries.map(d => d.date));
                const today = getLocalDateStr(new Date());

                let html = '<div class="diary-calendar-header">';
                html += '<span class="diary-calendar-title">' + _calendarYear + '年 ' + monthNames[_calendarMonth] + '</span>';
                html += '<div class="diary-calendar-nav">';
                html += '<button onclick="closeCalendar()" class="btn-close-calendar" title="关闭日历">✕</button>';
                html += '<button onclick="prevMonth()">◀</button>';
                html += '<button onclick="nextMonth()">▶</button>';
                html += '</div></div>';

                html += '<div class="diary-calendar-grid">';
                html += '<div class="diary-calendar-weekday">日</div>';
                html += '<div class="diary-calendar-weekday">一</div>';
                html += '<div class="diary-calendar-weekday">二</div>';
                html += '<div class="diary-calendar-weekday">三</div>';
                html += '<div class="diary-calendar-weekday">四</div>';
                html += '<div class="diary-calendar-weekday">五</div>';
                html += '<div class="diary-calendar-weekday">六</div>';

                const firstDay = new Date(_calendarYear, _calendarMonth, 1).getDay();
                const daysInMonth = new Date(_calendarYear, _calendarMonth + 1, 0).getDate();

                // 填充空白
                for (let i = 0; i < firstDay; i++) {
                    html += '<div class="diary-calendar-day empty"></div>';
                }

                // 填充日期
                for (let day = 1; day <= daysInMonth; day++) {
                    const dateStr = _calendarYear + '-' + String(_calendarMonth + 1).padStart(2, '0') + '-' + String(day).padStart(2, '0');
                    const isToday = dateStr === today;
                    const hasRecord = datesWithRecords.has(dateStr);
                    const isSelected = dateStr === _selectedDate;

                    let classes = 'diary-calendar-day';
                    if (isToday) classes += ' today';
                    if (hasRecord) classes += ' has-record';
                    if (isSelected) classes += ' selected';

                    const attObj = getAttObj(dateStr);
                    html += '<div class="' + classes + '" onclick="openAttendanceModal(\'' + dateStr + '\')">';
                    html += '<span class="att-date">' + day + '</span>';
                    if (attObj) {
                        html += '<span class="att-nature-badge att-cat-' + attObj.n + '">' + attObj.n + '</span>';
                        if (attObj.s && attObj.s.length) {
                            html += '<span class="att-sub-badges att-cat-' + attObj.n + '">';
                            attObj.s.slice(0, ATT_MAX_SUB).forEach(function(ch) {
                                html += '<span class="att-sub-char">' + ch + '</span>';
                            });
                            html += '</span>';
                        }
                    }
                    html += '</div>';
                }

                html += '</div>';

                const catCnt = { '日': 0, '差': 0, '休': 0, '公': 0, '培': 0, '假': 0 };
                let daysWithAtt = 0;
                for (let d = 1; d <= daysInMonth; d++) {
                    const ds = _calendarYear + '-' + String(_calendarMonth + 1).padStart(2, '0') + '-' + String(d).padStart(2, '0');
                    const obj = getAttObj(ds);
                    if (obj && catCnt[obj.n] !== undefined) { daysWithAtt++; catCnt[obj.n]++; }
                }
                // 按基本性质统计（六项始终显示）
                const summaryParts = [];
                ATT_NATURES.forEach(function(n) { summaryParts.push(n + (catCnt[n] || 0)); });
                html += '<div class="att-summary">本月考勤：' + summaryParts.join(' ') + ' ＝ ' + daysWithAtt + '/' + daysInMonth + '天</div>';

                container.innerHTML = html;
            }

            window.prevMonth = function() {
                _calendarMonth--;
                if (_calendarMonth < 0) {
                    _calendarMonth = 11;
                    _calendarYear--;
                }
                renderCalendar();
            };

            window.nextMonth = function() {
                _calendarMonth++;
                if (_calendarMonth > 11) {
                    _calendarMonth = 0;
                    _calendarYear++;
                }
                renderCalendar();
            };

            window.closeCalendar = function() {
                document.getElementById('diary-calendar').style.display = 'none';
                // 只清除选中状态，不关闭查询结果详情
                _selectedDate = null;
            };

            window.selectDate = function(dateStr) {
                _selectedDate = dateStr;
                renderCalendar();
                document.getElementById('diary-calendar').style.display = 'block';
                renderDateDetail(dateStr);
            };

            function renderDateDetail(dateStr) {
                const container = document.getElementById('diary-date-detail');
                const diary = diaries.find(d => d.date === dateStr);

                if (!diary) {
                    const _attObj0 = getAttObj(dateStr);
                    const _attTxt0 = _attObj0 ? ('考勤：' + attLabelOf(_attObj0)) : '设置考勤';
                    container.innerHTML = '<p style="color:var(--text-secondary);text-align:center;">该日期暂无记录</p><div style="text-align:center;margin-top:12px;"><button class="btn btn-secondary btn-small" onclick="openAttendanceModal(\'' + dateStr + '\')">🗓 ' + _attTxt0 + '</button></div>';
                    container.style.display = 'block';
                    return;
                }

                const dateObj = new Date(diary.date);
                const weekDay = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][dateObj.getDay()];
                const dateStr2 = (dateObj.getMonth() + 1) + '月' + dateObj.getDate() + '日 ' + weekDay;

                let html = '<div class="diary-date-detail-header">';
                html += '<span class="diary-date-detail-title">' + dateStr2 + '</span>';
                html += '<div><button class="btn btn-info btn-small" onclick="editDiary(\'' + diary.date + '\')">编辑</button> <button class="btn btn-danger btn-small" onclick="deleteDiary(\'' + diary.date + '\')">删除</button></div>';
                html += '</div>';

                html += '<div class="diary-work-block"><div class="diary-work-header"><span class="diary-work-title">📋 工作内容</span><button class="btn btn-small btn-secondary" onclick="copyDiaryWork(\'' + diary.date + '\', this)">📋 复制</button></div><div class="diary-work-content">' + escapeHtml(diary.work) + '</div></div>';

                if (diary.issues && diary.issues.length > 0) {
                    html += '<div class="diary-issues-block"><div class="diary-issues-header"><span class="diary-issues-title">⚠️ 发现问题 (' + diary.issues.length + '条)</span><button class="btn btn-small btn-secondary" onclick="diaryCopyIssuesCard(\'' + diary.date + '\', this)" title="先选第几条，再选 问题 / 规章">📋 复制▾</button></div>';
                    diary.issues.forEach((issue, idx) => {
                        const regulation = (diary.regulations && diary.regulations[idx]) ? diary.regulations[idx] : '';
                        html += '<div class="diary-issue-item"><div class="diary-issue-item-num">' + (idx + 1) + '</div><div class="diary-issue-item-content">' + escapeHtml(issue);
                        if (regulation) {
                            html += '<div style="margin-top:6px; font-size:0.8rem; color:var(--primary); border-left:2px solid var(--primary); padding-left:8px;"><strong>📜 完整引用句子：</strong>' + escapeHtml(regulation) + '</div>';
                        }
                        html += '</div><div class="diary-issue-item-actions"><button class="btn btn-small btn-secondary" onclick="copyDiaryIssue(\'' + diary.date + '\', ' + idx + ', this)">📋 复制</button><button class="btn btn-small btn-danger" onclick="deleteIssue(\'' + diary.date + '\', ' + idx + ')">删除</button></div></div>';
                    });
                    html += '</div>';
                }

                const _attObj1 = getAttObj(dateStr);
                const _attTxt1 = _attObj1 ? ('考勤：' + attLabelOf(_attObj1)) : '设置考勤';
                html += '<div style="margin-top:14px;text-align:center;"><button class="btn btn-secondary btn-small" onclick="openAttendanceModal(\'' + dateStr + '\')">🗓 ' + _attTxt1 + '</button></div>';
                container.innerHTML = html;
                container.style.display = 'block';
                // 渲染多媒体内容（替换标签为实际图片/视频）
                renderDiaryMedia(diary.mediaIds);
            }

            // 切换视图函数
            async function showInputView(skipAutoLoad) {
                diaryFilterMode = 'input';
                document.getElementById('diary-input-view').style.display = 'block';
                document.getElementById('diary-history-view').style.display = 'none';
                // 清空媒体缓存和预览
                _mediaFiles = [];
                _mediaPreviews = [];
                _mediaCaptureTimes = [];
                _existingMediaIds = [];
                document.getElementById('media-preview').innerHTML = '';
                diarySyncMediaPanel();      // 【v3.75】清空后一并隐藏预览区
                // 初始化焦点追踪（使多媒体按钮能检测到当前聚焦的文本框）
                initFocusTracking();
                // 如果当日已有记录，自动加载到输入框（在历史基础上追加）
                if (!skipAutoLoad) {
                    const d = new Date();
                    const todayStr = d.getFullYear() + '-' + 
                        String(d.getMonth() + 1).padStart(2, '0') + '-' + 
                        String(d.getDate()).padStart(2, '0');
                    const existing = diaries.find(d => d.date === todayStr);
                    if (existing) {
                        document.getElementById('diary-date').value = todayStr;
                        document.getElementById('diary-work').value = existing.work;
                        autoResize(document.getElementById('diary-work'));
                        renderIssueFields(existing.issues || [], existing.regulations || []);
                        // 加载已有媒体
                        await loadDiaryMedia(existing);
                    } else {
                        // 当日无记录：默认填入今天日期，保证自动保存有有效日期（不再依赖已删除的手动保存按钮）
                        document.getElementById('diary-date').value = todayStr;
                    }
                }
                // 按钮状态
                // 视图切换激活态：分段控件 .active（替代原先 btn-info / btn-secondary 互换）
                document.getElementById('diary-input-btn').classList.add('active');
                document.getElementById('diary-history-btn').classList.remove('active');
            }

            function showQuery() {
                diaryFilterMode = 'history';
                document.getElementById('diary-input-view').style.display = 'none';
                document.getElementById('diary-history-view').style.display = 'block';
                // 按钮状态
                document.getElementById('diary-input-btn').classList.remove('active');
                document.getElementById('diary-history-btn').classList.add('active');
                // 渲染今日记录与日历
                _selectedDate = null;
                // 查询视图只显示日历：当日写实改由点击日期后在日历下方展示，避免上下重复
                document.getElementById('diary-records-list').innerHTML = '';
                renderCalendar();
                document.getElementById('diary-calendar').style.display = 'block';
                document.getElementById('diary-date-detail').style.display = 'none';
            }
            window.showInputView = showInputView;
            window.showQuery = showQuery;
            
            // ---- 多媒体采集与处理 ----
            let _mediaFiles = [];          // 暂存的文件对象（含已加载的旧文件）
            let _mediaPreviews = [];      // 预览URL（blob）
            let _lastFocusedTextarea = null; // 最近聚焦的文本框
            let _mediaCaptureTimes = [];   // 拍摄时间戳
            let _existingMediaIds = [];    // 已有媒体对应的 IndexedDB ID（用于编辑时复用）

            // 格式化时间为 "YYYY-MM-DD HH:MM" 或更紧凑格式
            function formatTime(d) {
                const pad = n => String(n).padStart(2, '0');
                return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate())
                    + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
            }

            // 从已有日记记录加载媒体到 _mediaFiles / _existingMediaIds / 预览区
            async function loadDiaryMedia(diary) {
                if (!diary.mediaIds || diary.mediaIds.length === 0) return;
                const previewDiv = document.getElementById('media-preview');
                for (let i = 0; i < diary.mediaIds.length; i++) {
                    const record = await getMediaFromDB(diary.mediaIds[i]);
                    if (record && record.blob) {
                        const blob = new Blob([record.blob], { type: record.type || 'image/jpeg' });
                        const blobUrl = URL.createObjectURL(blob);
                        _mediaFiles.push(blob);
                        _mediaPreviews.push(blobUrl);
                        _mediaCaptureTimes.push(record.captureTime || '');
                        _existingMediaIds.push(diary.mediaIds[i]);
                        // 预览元素
                        const wrapper = document.createElement('div');
                        wrapper.style.cssText = 'position:relative;display:inline-block;vertical-align:top;';
                        const isVideo = record.type && record.type.startsWith('video/');
                        const isAudio = record.type && record.type.startsWith('audio/');
                        let el;
                        if (isVideo) {
                            el = document.createElement('video'); el.controls = true;
                            el.style.cssText = 'max-width:200px;max-height:200px;border-radius:6px;';
                        } else if (isAudio) {
                            el = document.createElement('audio'); el.controls = true; el.preload = 'auto';
                            el.style.cssText = 'width:220px;height:40px;border-radius:6px;margin:2px 0;';
                        } else {
                            el = document.createElement('img');
                            el.style.cssText = 'max-width:200px;max-height:200px;border-radius:6px;';
                        }
                        el.src = blobUrl;
                        wrapper.appendChild(el);
                        if (record.captureTime) {
                            const badge = document.createElement('div');
                            badge.textContent = record.captureTime;
                            badge.style.cssText = 'position:absolute;bottom:4px;left:4px;background:rgba(0,0,0,0.6);color:#fff;font-size:11px;padding:2px 6px;border-radius:3px;pointer-events:none;';
                            wrapper.appendChild(badge);
                        }
                        previewDiv.appendChild(wrapper);
                    }
                }
                diarySyncMediaPanel();      // 【v3.75】编辑已有记录时同样按预览内容决定是否显示
            }

            // 初始化焦点追踪（事件委托：捕获 diary-input-view 内的 textarea 焦点）
            function initFocusTracking() {
                const view = document.getElementById('diary-input-view');
                if (!view) return;
                // 移除旧监听避免重复绑定
                view.removeEventListener('focus', _focusHandler, true);
                view.addEventListener('focus', _focusHandler, true);
            }
            function _focusHandler(e) {
                if (e.target && e.target.tagName === 'TEXTAREA' && e.target.closest('#diary-input-view')) {
                    _lastFocusedTextarea = e.target;
                }
            }

            // 获取多媒体输入的目标文本框
            function getActiveTextarea() {
                // 优先用焦点追踪记录的上次聚焦文本框
                if (_lastFocusedTextarea && _lastFocusedTextarea.closest('#diary-input-view')) {
                    return _lastFocusedTextarea;
                }
                // 回退到 work 框
                return document.getElementById('diary-work');
            }

            // 【v3.75】拍照/录像按钮已并入输入行，多媒体面板只作为「预览区」：有媒体才显示，不再需要开关/关闭按钮
            function diarySyncMediaPanel() {
                const panel = document.getElementById('multimedia-panel');
                const prev = document.getElementById('media-preview');
                if (!panel || !prev) return;
                panel.style.display = prev.children.length ? 'block' : 'none';
            }
            window.diarySyncMediaPanel = diarySyncMediaPanel;

            // 打开/关闭多媒体面板（兼容保留：新界面无开关按钮，元素缺失时安全返回）
            function toggleMultimediaPanel() {
                const panel = document.getElementById('multimedia-panel');
                const toggleBtn = document.getElementById('btn-multimedia-toggle');
                if (!panel) return;
                if (panel.style.display === 'none' || !panel.style.display) {
                    panel.style.display = 'block';
                    if (toggleBtn) toggleBtn.textContent = '❌ 关闭多媒体';
                } else {
                    panel.style.display = 'none';
                    if (toggleBtn) toggleBtn.textContent = '📸 多媒体录入';
                }
            }
            window.toggleMultimediaPanel = toggleMultimediaPanel;

            // 处理拍照/录像/录音
            async function handleMediaCapture(input, type) {
                const file = input.files[0];
                if (!file) return;
                
                const now = new Date();
                const captureTimeStr = formatTime(now);
                
                let processedFile = file;
                if (type === 'photo') {
                    processedFile = await addTimestampToPhoto(file, captureTimeStr);
                }
                
                _mediaFiles.push(processedFile);
                _mediaCaptureTimes.push(captureTimeStr);
                
                // 预览（带时间戳叠加）
                const blobUrl = URL.createObjectURL(processedFile);
                _mediaPreviews.push(blobUrl);
                const previewDiv = document.getElementById('media-preview');
                const wrapper = document.createElement('div');
                wrapper.style.cssText = 'position:relative;display:inline-block;vertical-align:top;';
                let el;
                if (type === 'video') {
                    el = document.createElement('video');
                    el.src = blobUrl;
                    el.controls = true;
                    el.style.cssText = 'max-width:200px;max-height:200px;border-radius:6px;';
                } else {
                    el = document.createElement('img');
                    el.src = blobUrl;
                    el.style.cssText = 'max-width:200px;max-height:200px;border-radius:6px;';
                }
                wrapper.appendChild(el);
                // 时间戳标签（叠加在右下角）
                const badge = document.createElement('div');
                badge.textContent = captureTimeStr;
                badge.style.cssText = 'position:absolute;bottom:4px;left:4px;background:rgba(0,0,0,0.6);color:#fff;font-size:11px;padding:2px 6px;border-radius:3px;pointer-events:none;';
                wrapper.appendChild(badge);
                previewDiv.appendChild(wrapper);
                
                // 插入媒体标签到光标所在的文本框
                const idx = _mediaFiles.length;
                const tagMap = { photo: '📷照片', video: '🎥录像', audio: '🎤录音' };
                const tag = '[' + (tagMap[type] || '文件') + idx + ']';
                insertTextAtCursor(getActiveTextarea(), tag);
                diarySyncMediaPanel();      // 【v3.75】有媒体了才显示预览区

                // 重置 input value，允许再次选择同一文件
                input.value = '';
            }
            window.handleMediaCapture = handleMediaCapture;

            // 照片烧录时间戳（使用 Canvas）
            function addTimestampToPhoto(file, timeStr) {
                return new Promise((resolve) => {
                    const img = new Image();
                    img.onload = () => {
                        const canvas = document.createElement('canvas');
                        canvas.width = img.width;
                        canvas.height = img.height;
                        const ctx = canvas.getContext('2d');
                        // 原图
                        ctx.drawImage(img, 0, 0);
                        // 时间戳样式
                        const fontSize = Math.max(14, Math.min(canvas.width, canvas.height) * 0.025);
                        ctx.font = 'bold ' + fontSize + 'px "Microsoft YaHei", Arial, sans-serif';
                        ctx.textAlign = 'right';
                        ctx.textBaseline = 'bottom';
                        // 测量文字宽度
                        const textWidth = ctx.measureText(timeStr).width;
                        const padding = fontSize * 0.5;
                        const margin = 12;
                        const x = canvas.width - margin;
                        const y = canvas.height - margin;
                        const bgH = fontSize + padding * 2;
                        const bgW = textWidth + padding * 2;
                        // 半透明背景
                        ctx.fillStyle = 'rgba(0,0,0,0.55)';
                        ctx.fillRect(x - bgW, y - bgH, bgW, bgH);
                        // 白色文字
                        ctx.fillStyle = '#ffffff';
                        ctx.fillText(timeStr, x - padding, y - padding);
                        
                        canvas.toBlob(blob => {
                            if (blob) resolve(new File([blob], file.name, { type: 'image/jpeg' }));
                            else resolve(file);
                        }, 'image/jpeg', 0.92);
                    };
                    img.onerror = () => resolve(file);
                    img.src = URL.createObjectURL(file);
                });
            }

            // 在文本框光标位置插入文本
            function insertTextAtCursor(textarea, text) {
                const start = textarea.selectionStart;
                const end = textarea.selectionEnd;
                const before = textarea.value.substring(0, start);
                const after = textarea.value.substring(end);
                textarea.value = before + text + after;
                // 光标移到插入文本之后
                const newPos = start + text.length;
                textarea.selectionStart = textarea.selectionEnd = newPos;
                textarea.focus();
                autoResize(textarea);
            }

            function closeMultimediaPanel() {
                // 兼容保留：新界面已无「关闭」按钮，元素缺失时安全返回
                const panelEl = document.getElementById('multimedia-panel');
                if (!panelEl) return;
                panelEl.style.display = 'none';
                document.getElementById('btn-multimedia-toggle').textContent = '📸 多媒体录入';
            }
            window.closeMultimediaPanel = closeMultimediaPanel;

            // ---------- DiaryMediaDB schema：在【模块加载时】注册（而不是首次读写媒体时） ----------
            // ⚠️ 根因：utils.js 的 cleanupOldMedia、smart-writer 的写作中心都可能**先一步**调用
            // dbManager.getDB('DiaryMediaDB')。那时既没有升级回调、也没有 store 白名单，
            // dbManager 会用兜底 {version:1, fn:null, stores:null} 建出一个**没有 media store 的空库并缓存**；
            // 之后这里再 register（同版本）不会清缓存 → 事务抛 NotFoundError 且被静默吞掉，
            // 表现为「照片永远不入库」，且刷新也不自愈（版本已达标，不再触发 onupgradeneeded）。
            // 放到模块加载时执行即可从根上避免；刻意**不传 store 白名单**，以免启用"升版本重建"分支。
            // 下面 saveMediaToDB/getMediaFromDB 里保留了同样的兜底注册（被标记挡住，不会重复执行）。
            if (window.dbManager && typeof window.dbManager.register === 'function' && !window._diaryMediaDBRegistered) {
                window.dbManager.register('DiaryMediaDB', 1, function(db, e) {
                    e.target.result.createObjectStore('media', { keyPath: 'id', autoIncrement: true });
                });
                window._diaryMediaDBRegistered = true;
            }

            // 多媒体文件存储到 IndexedDB（使用 dbManager 共享连接）
            function saveMediaToDB(file, captureTime) {
                return new Promise((resolve) => {
                    // 注册 DiaryMediaDB schema（仅一次）
                    if (!window._diaryMediaDBRegistered) {
                        window.dbManager.register('DiaryMediaDB', 1, function(db, e) {
                            e.target.result.createObjectStore('media', { keyPath: 'id', autoIncrement: true });
                        });
                        window._diaryMediaDBRegistered = true;
                    }
                    const reader = new FileReader();
                    reader.onload = function() {
                        const data = reader.result; // ArrayBuffer
                        window.dbManager.getDB('DiaryMediaDB').then(function(db) {
                            const tx = db.transaction('media', 'readwrite');
                            const store = tx.objectStore('media');
                            const addReq = store.add({ blob: data, type: file.type, name: file.name, timestamp: Date.now(), captureTime: captureTime || '' });
                            addReq.onsuccess = e => resolve(e.target.result);
                            addReq.onerror = () => resolve(null);
                        }).catch(() => resolve(null));
                    };
                    reader.onerror = () => resolve(null);
                    reader.readAsArrayBuffer(file);
                });
            }
            window.saveMediaToDB = saveMediaToDB;

            // 从 IndexedDB 读取媒体文件（使用 dbManager 共享连接）
            function getMediaFromDB(id) {
                return new Promise((resolve) => {
                    if (!window._diaryMediaDBRegistered) {
                        window.dbManager.register('DiaryMediaDB', 1, function(db, e) {
                            e.target.result.createObjectStore('media', { keyPath: 'id', autoIncrement: true });
                        });
                        window._diaryMediaDBRegistered = true;
                    }
                    window.dbManager.getDB('DiaryMediaDB').then(function(db) {
                        const tx = db.transaction('media', 'readonly');
                        const store = tx.objectStore('media');
                        const getReq = store.get(id);
                        getReq.onsuccess = () => resolve(getReq.result || null);
                        getReq.onerror = () => resolve(null);
                    }).catch(() => resolve(null));
                });
            }

            // 渲染日记记录中的多媒体内容（替换 [📷照片N] / [🎥录像N] 标签为实际媒体）
            async function renderDiaryMedia(mediaIds) {
                if (!mediaIds || mediaIds.length === 0) return;
                const workContent = document.querySelector('.diary-work-content');
                const issueItems = document.querySelectorAll('.diary-issue-item-content');
                const elements = workContent ? [workContent, ...issueItems] : [...issueItems];
                for (const el of elements) {
                    await replaceMediaTags(el, mediaIds);
                }
            }
            // 在元素中替换媒体标签
            async function replaceMediaTags(el, mediaIds) {
                let html = el.innerHTML;
                const tagRegex = /\[(📷照片|🎥录像|🎤录音)(\d+)\]/g;
                const replacements = [];
                let match;
                while ((match = tagRegex.exec(html)) !== null) {
                    const fullTag = match[0];
                    const tagType = match[1];
                    const idx = parseInt(match[2]) - 1;
                    const mediaId = idx >= 0 && idx < mediaIds.length ? mediaIds[idx] : null;
                    replacements.push({ fullTag, mediaId, tagType });
                }
                if (replacements.length === 0) return;
                for (const rep of replacements) {
                    if (rep.mediaId !== null) {
                        const record = await getMediaFromDB(rep.mediaId);
                        if (record && record.blob) {
                            const blob = new Blob([record.blob], { type: record.type || 'image/jpeg' });
                            const url = URL.createObjectURL(blob);
                            const capTime = record.captureTime || '';
                            let mediaHtml;
                            if (rep.tagType === '🎥录像') {
                                // 视频：叠加时间戳标签
                                mediaHtml = '<div style="position:relative;display:inline-block;max-width:100%;vertical-align:top;">'
                                    + '<video src="' + url + '" controls style="max-width:100%;max-height:300px;border-radius:6px;margin:4px 0;"></video>'
                                    + '<div style="position:absolute;bottom:8px;left:8px;background:rgba(0,0,0,0.6);color:#fff;font-size:12px;padding:2px 8px;border-radius:4px;pointer-events:none;">' + capTime + '</div>'
                                    + '</div>';
                            } else if (rep.tagType === '🎤录音') {
                                // 录音：音频播放器 + 时间戳
                                mediaHtml = '<div style="display:flex;align-items:center;gap:6px;margin:4px 0;">'
                                    + '<audio src="' + url + '" controls style="height:36px;border-radius:6px;flex:1;"></audio>'
                                    + '<span style="font-size:11px;color:#64748b;white-space:nowrap;">' + capTime + '</span>'
                                    + '</div>';
                            } else {
                                // 照片：时间戳已烧录在图像内
                                mediaHtml = '<img src="' + url + '" style="max-width:100%;max-height:300px;border-radius:6px;margin:4px 0;cursor:pointer;" onclick="window.open(this.src)" />';
                            }
                            html = html.replace(rep.fullTag, mediaHtml);
                        }
                    }
                }
                el.innerHTML = html;
            }

            // 本地文件下载（统一走全局移动端兼容下载）
            function _downloadBlob(blob, filename) {
                window.downloadBlob(blob, filename);
            }

            // 根据媒体类型取扩展名
            function _mediaExt(type) {
                if (!type) return 'jpg';
                if (type.indexOf('png') !== -1) return 'png';
                if (type.indexOf('gif') !== -1) return 'gif';
                if (type.indexOf('webp') !== -1) return 'webp';
                if (type.indexOf('mp4') !== -1 || type.indexOf('video') !== -1) return 'mp4';
                if (type.indexOf('audio') !== -1 || type.indexOf('mp3') !== -1 || type.indexOf('wav') !== -1 || type.indexOf('ogg') !== -1) return 'mp3';
                return 'jpg';
            }

            // 导出日记数据（含媒体与考勤记录则打包 ZIP，否则纯 JSON）
            // 考勤记录(attendance_v1)与工作日志同时导出，方便整体迁移
            window.exportDiary = async function() {
                if (diaries.length === 0) { alert('没有数据可导出'); return; }
                window.showProgress(50, '正在导出工作日志…');
                const stamp = getLocalDateStr(new Date());
                const attMap = getAttendance();
                const attCount = attMap ? Object.keys(attMap).length : 0;
                // 统一封装：新格式含 diary 数组 + attendance 映射（旧版纯数组仍兼容）
                const payload = {
                    version: 2,
                    type: 'diary_export',
                    exportDate: new Date().toISOString(),
                    diary: diaries,
                    attendance: attMap || {}
                };
                // 收集全部媒体 id
                const allMediaIds = [];
                diaries.forEach(function(d) {
                    if (d.mediaIds && d.mediaIds.length) d.mediaIds.forEach(function(id) {
                        if (allMediaIds.indexOf(id) === -1) allMediaIds.push(id);
                    });
                });
                try {
                    if (allMediaIds.length === 0) {
                        _downloadBlob(new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' }), '工作写实_' + stamp + '.json');
                        window.finishProgress('✅ 工作日志导出成功' + (attCount > 0 ? '（含 ' + attCount + ' 天考勤）' : ''));
                        return;
                    }
                    // 用 requireLib：直接 await loadScript 会在离线时抛错，
                    // 使下面「降级导出纯文本 JSON」这条退路永远走不到
                    await window.requireLib(LIB_JSZIP_DIARY, { feature: 'ZIP 导出', silent: true });
                    if (typeof JSZip === 'undefined') {
                        // 降级：纯 JSON（不含媒体）
                        _downloadBlob(new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' }), '工作写实_' + stamp + '.json');
                        window.finishProgress('⚠️ JSZip 未加载，已导出纯文本（不含媒体），请联网后重试以打包图片' + (attCount > 0 ? '（含 ' + attCount + ' 天考勤）' : ''));
                        return;
                    }
                    const zip = new JSZip();
                    let mediaCount = 0;
                    for (let i = 0; i < allMediaIds.length; i++) {
                        const rec = await getMediaFromDB(allMediaIds[i]);
                        if (rec && rec.blob) {
                            const type = rec.type || 'image/jpeg';
                            zip.file('images/' + allMediaIds[i] + '.' + _mediaExt(type), new Blob([rec.blob], { type: type }));
                            mediaCount++;
                        }
                    }
                    zip.file('diary.json', JSON.stringify(payload, null, 2));
                    zip.file('manifest.json', JSON.stringify({ version: 2, exportDate: new Date().toISOString(), count: diaries.length, hasMedia: mediaCount > 0, hasAttendance: attCount > 0 }, null, 2));
                    const zipBlob = await zip.generateAsync({ type: 'blob' });
                    _downloadBlob(new Blob([zipBlob], { type: 'application/zip' }), '工作写实_' + stamp + '.zip');
                    window.finishProgress('✅ 工作日志导出成功（含 ' + mediaCount + ' 个媒体' + (attCount > 0 ? ' · ' + attCount + ' 天考勤' : '') + '）');
                } catch (err) {
                    window.hideProgress();
                    alert('导出失败：' + err.message);
                }
            };

            // 导入日记数据（支持 .json / .zip）
            window.importDiary = function() {
                window.showProgress(10, '正在导入工作日志…');
                const input = document.createElement('input');
                input.type = 'file';
                input.accept = '.json,.zip';
                input.onchange = function(e) {
                    const file = e.target.files[0];
                    if (!file) { window.hideProgress(); return; }
                    if (/\.zip$/i.test(file.name)) { importDiaryFromZip(file); return; }
                    importDiaryFromJson(file);
                };
                input.click();
            };

            // 从 JSON 导入（保持原有逻辑）
            function importDiaryFromJson(file) {
                const reader = new FileReader();
                reader.onload = function(evt) {
                    try {
                        const parsed = JSON.parse(evt.target.result);
                        _applyDiaryImport(parsed);
                    } catch (err) {
                        window.hideProgress();
                        alert('解析文件失败：' + err.message);
                    }
                };
                reader.readAsText(file);
            }

            var LIB_JSZIP_DIARY = 'https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js';

            // 从 ZIP 导入（含媒体重建 ID 映射）
            async function importDiaryFromZip(file) {
                try {
                    if (!(await window.requireLib(LIB_JSZIP_DIARY, { feature: 'ZIP 导入' }))) { window.hideProgress(); return; }
                    if (typeof JSZip === 'undefined') { window.hideProgress(); alert('JSZip 库未加载，无法导入 ZIP，请联网后重试'); return; }
                    const zip = await JSZip.loadAsync(file);
                    if (!zip.file('diary.json')) { window.hideProgress(); alert('ZIP 文件缺少 diary.json'); return; }
                    const jsonStr = await zip.file('diary.json').async('string');
                    const parsed = JSON.parse(jsonStr);
                    const ext = _extractDiaryExport(parsed);
                    if (!ext || !Array.isArray(ext.diary)) { window.hideProgress(); alert('导入数据格式错误：缺少日记数组'); return; }
                    const imported = ext.diary;
                    // 建立旧媒体 ID -> 新 ID 映射
                    const idMap = {};
                    const imageFiles = zip.file(/^images\//);
                    for (const zf of imageFiles) {
                        const oldId = parseInt(zf.name.replace(/^images\//, '').replace(/\.[^.]+$/, ''), 10);
                        const blob = await zf.async('blob');
                        const id = await saveMediaToDB(blob, '');
                        if (id !== null) idMap[oldId] = id;
                    }
                    // 重映射 mediaIds
                    imported.forEach(function(d) {
                        if (d.mediaIds && d.mediaIds.length) {
                            d.mediaIds = d.mediaIds.map(function(id) { return idMap[id] !== undefined ? idMap[id] : id; });
                        }
                    });
                    _applyDiaryImport(parsed);
                } catch (err) {
                    window.hideProgress();
                    alert('ZIP 导入失败：' + err.message);
                }
            }

            // 解析导入文件：兼容新格式 {type:'diary_export', diary:[], attendance:{}} 与旧版纯数组
            function _extractDiaryExport(parsed) {
                if (parsed && typeof parsed === 'object' && Array.isArray(parsed.diary)) {
                    return {
                        diary: parsed.diary,
                        attendance: (parsed.attendance && typeof parsed.attendance === 'object') ? parsed.attendance : null
                    };
                }
                if (Array.isArray(parsed)) {
                    return { diary: parsed, attendance: null };
                }
                return null;
            }

            // 合并考勤记录（导入值覆盖同日期已有值）
            function _mergeAttendance(att) {
                if (!att || typeof att !== 'object') return;
                const cur = getAttendance();
                let changed = false;
                Object.keys(att).forEach(function(date) {
                    if (att[date]) { cur[date] = att[date]; changed = true; }
                });
                if (changed) {
                    try { localStorage.setItem('attendance_v1', JSON.stringify(cur)); } catch (e) {}
                    // 若日历可见则刷新角标
                    try { if (typeof renderCalendar === 'function') renderCalendar(); } catch (e) {}
                }
            }

            // 统一入口：解析后合并日记 + 考勤
            function _applyDiaryImport(parsed) {
                const ext = _extractDiaryExport(parsed);
                if (!ext || !Array.isArray(ext.diary)) {
                    window.hideProgress();
                    alert('导入数据格式错误：需要日记数组或 diary_export 结构');
                    return;
                }
                // 先合并考勤（不影响日记的去重计数提示）
                if (ext.attendance) _mergeAttendance(ext.attendance);
                // 再合并日记
                _mergeDiaries(ext.diary);
            }

            // 合并导入数据（按日期去重）
            function _mergeDiaries(imported) {
                if (!Array.isArray(imported)) {
                    window.hideProgress();
                    alert('导入数据格式错误：需要数组格式');
                    return;
                }
                const valid = imported.every(function(item) { return item && (item.date || item.work || item.issues); });
                if (!valid) {
                    window.hideProgress();
                    alert('导入数据格式错误：部分数据缺少必要字段');
                    return;
                }
                const existingDates = new Set(diaries.map(function(d) { return d.date; }));
                let addedCount = 0;
                imported.forEach(function(item) {
                    if (!existingDates.has(item.date)) {
                        diaries.push(item);
                        addedCount++;
                    }
                });
                window.showProgress(60, '正在保存…');
                saveDiaries();
                updateDiaryCount();
                renderTodayRecords();
                window.finishProgress('✅ 成功导入 ' + addedCount + ' 条' + (imported.length - addedCount > 0 ? '（跳过' + (imported.length - addedCount) + '条重复）' : ''));
            }

            document.addEventListener('DOMContentLoaded', () => {
                loadDiaries();
                document.getElementById('diary-date').valueAsDate = new Date();
                renderIssueFields([]);
                updateDiaryCount();
                showInputView(); // 默认显示输入视图（写日志卡片）
            });
            // 暴露数据获取接口（供联动数据使用）
            window.getDiaryData = function() { return diaries; };

            // ================================================================
            // ── ✨ 一键 AI 修改（工作写实 + 检查问题 + 规章依据）2026-09-18 ──
            // 用户口径：
            //   · work / issues → 通顺、逻辑合理、书面化、不啰嗦 + 纠正错别字/多字少字/标点，**不得改事实**；
            //   · regulations   → **只纠错、不改写**（能回库定位到同一条款时，以库内原文为校对参照）；
            //   · 问题有、规章空的 → 用知识库索引（KB.searchRules）召回候选条款，AI 精排后**只给候选**，点「采纳」才写入。
            // 保存：每条改完立即 saveDiaries() 落 localStorage（即"自动保存写实"）；整批先备份，可一键撤销。
            // 安全：三道防线 —— 提示词硬约束 + 本地字段级守卫（数字/日期/书名号/相似度）+ 整批备份与撤销。
            // ================================================================
            var DIARY_AI_BK_K = 'diary_ai_fix_backup_v1';
            var DIARY_AI_LIMIT_K = 'diary_ai_fix_limit_v1';
            var _diaryAiBusy = false;
            var _diaryAiStop = false;
            var _diaryAiSuggests = {};     // 候选条款暂存：key → 文本（避免把长文本塞进 onclick 属性）
            var _diaryAiLastReport = null; // 上次回执的入参：采纳候选后原地重渲染（把该组标成"已采纳"）

            function diaryByDateDesc(a, b) { return a.date < b.date ? 1 : (a.date > b.date ? -1 : 0); }
            function diaryAiKeyword() {
                var el = document.getElementById('diary-search-input');
                return el ? String(el.value || '').trim() : '';
            }
            // 关键词过滤（与 diarySearch 共用同一套规则，避免两处逻辑漂移）
            function diaryFilterByKeyword(kw) {
                var k = String(kw || '').trim().toLowerCase();
                if (!k) return diaries.slice();
                return diaries.filter(function (d) {
                    if ((d.work || '').toLowerCase().indexOf(k) !== -1) return true;
                    if (d.issues && d.issues.some(function (x) { return (x || '').toLowerCase().indexOf(k) !== -1; })) return true;
                    if (d.regulations && d.regulations.some(function (x) { return (x || '').toLowerCase().indexOf(k) !== -1; })) return true;
                    return false;
                });
            }
            function diaryAiEligible(days) {
                var min = '';
                if (days > 0) { var d = new Date(); d.setDate(d.getDate() - days + 1); min = getLocalDateStr(d); }
                return diaries.filter(function (d) {
                    if (min && !(d.date >= min)) return false;
                    return !!(String(d.work || '').trim() || (d.issues || []).some(function (x) { return String(x || '').trim(); }));
                }).slice().sort(diaryByDateDesc);
            }
            function diaryAiPick(kind) {
                if (kind === 'match') return diaryFilterByKeyword(diaryAiKeyword()).slice().sort(diaryByDateDesc);
                if (kind.indexOf('day:') === 0) {
                    var d = kind.slice(4);
                    return diaryAiEligible(0).filter(function (x) { return x.date === d; });
                }
                return diaryAiEligible(kind === '7' ? 7 : (kind === '30' ? 30 : 0));
            }
            function diaryAiScopeLabel(kind) {
                if (kind === 'match') return '当前查询命中「' + diaryAiKeyword() + '」';
                if (kind.indexOf('day:') === 0) return '当天（' + kind.slice(4) + '）';
                if (kind === '7') return '近 7 天';
                if (kind === '30') return '近 30 天';
                return '全部';
            }
            /**
             * 默认范围（用户口径 2026-09-18）：优先"当前界面正在编辑/查看的那一天"，否则"当日"。
             * 大范围（全部/近30天/近7天）降级为扩展选项，避免顺手一点就烧掉几十次请求。
             */
            function diaryAiDefaultScope() {
                var inputView = document.getElementById('diary-input-view');
                var dateEl = document.getElementById('diary-date');
                var inputVisible = !!(inputView && inputView.style.display !== 'none');
                if (inputVisible && dateEl && dateEl.value) return { date: dateEl.value, label: '正在编辑 ' + dateEl.value };
                if (_selectedDate) return { date: _selectedDate, label: '当前查看 ' + _selectedDate };
                var t = getLocalDateStr(new Date());
                return { date: t, label: '当日（' + t + '）' };
            }
            function diaryAiLimit() {
                var v = parseInt(localStorage.getItem(DIARY_AI_LIMIT_K) || '20', 10);
                if (!v || v < 1) v = 20;
                return Math.min(v, 50);
            }
            // 数字/日期指纹：用于"不得改事实"的守卫。归一化去前导零（03 → 3），
            // 且按**去重集合**比较 —— 只合并重复表述不算改事实，改了数字才是。
            function diaryAiNums(s) {
                var t = String(s || '')
                    // ⚠️ 条号单独比对（diaryAiArticleNo），这里先把条号剔除：
                    //   「第十二条 → 第12条」属于**合规的格式规范化**，不该被当成"改了数字"拦下；
                    //   剔除后剩下的数字才是"事实数字"（数量/长度/日期），必须完全一致。
                    .replace(/第\s*[〇零一二三四五六七八九十百0-9.]{1,8}\s*条/g, ' ')
                    .replace(/》\s*[0-9]+(?:\.[0-9]+)*\s*[:：]/g, '》');
                var set = {};
                var norm = function (n) { return String(n).replace(/^0+(\d)/, '$1'); };
                (t.match(/\d+(?:\.\d+)?%?/g) || []).forEach(function (n) { set[norm(n)] = 1; });
                (t.match(/\d{4}\s*[-/年.]\s*\d{1,2}\s*[-/月.]\s*\d{1,2}\s*日?/g) || []).forEach(function (d) {
                    set['D' + d.replace(/\s/g, '').replace(/[年月日]/g, '-').replace(/^0+(\d)/, '$1')] = 1;
                });
                return Object.keys(set).sort().join('|');
            }
            function diaryAiTitles(s) { return (String(s || '').match(/《[^》]{1,40}》/g) || []).sort().join(','); }
            /** 中文数字 → 阿拉伯数字（条号比对用；支持 〇零一二三四五六七八九十百） */
            function diaryAiCn2Num(s) {
                s = String(s || '').trim();
                if (/^[0-9.]+$/.test(s)) return s.replace(/^0+(\d)/, '$1');
                var D = { '〇': 0, '零': 0, '一': 1, '二': 2, '三': 3, '四': 4, '五': 5, '六': 6, '七': 7, '八': 8, '九': 9 };
                var total = 0, num = 0;
                for (var i = 0; i < s.length; i++) {
                    var ch = s[i];
                    if (D[ch] != null) num = D[ch];
                    else if (ch === '十') { total += (num || 1) * 10; num = 0; }
                    else if (ch === '百') { total = (total + (num || 1)) * 100; num = 0; }
                }
                return String(total + num);
            }
            /** 条号提取：兼容「第十二条 / 第12条 / 第4.3.4条」与「《X》4.3.4：」两种写法，统一归一为阿拉伯数字 */
            function diaryAiArticleNo(text) {
                var t = String(text || '');
                var m = t.match(/第\s*([0-9]+(?:\.[0-9]+)*|[〇零一二三四五六七八九十百]{1,8})\s*条/);
                if (m) return diaryAiCn2Num(m[1]);
                var m2 = t.match(/》\s*([0-9]+(?:\.[0-9]+)*)\s*[:：]/);
                if (m2) return diaryAiCn2Num(m2[1]);
                return '';
            }
            /**
             * 字符级相似度（Levenshtein 归一化，1 - 距离/较长串长）。
             * 为什么不用 bigram Dice 判引文正文：短条款（20 字左右）里改**一个错别字**就会让
             * Dice 掉到 0.85 以下（两个 bigram 全变），把合规的纠错误判成"改写"（实测踩过）。
             * 编辑距离对"个别字替换"不敏感、对"整句换写"很敏感，正合这个判断。
             */
            function diaryAiSimEdit(a, b) {
                var norm = function (s) { return String(s || '').replace(/[\s，。、；：？！“”‘’"'（）()【】\[\]《》〈〉,.;:?!<>~—-]/g, ''); };
                var x = norm(a), y = norm(b);
                if (!x && !y) return 1;
                if (x === y) return 1;
                var n = x.length, m = y.length;
                if (!n || !m) return 0;
                var prev = new Array(m + 1), cur = new Array(m + 1), i, j;
                for (j = 0; j <= m; j++) prev[j] = j;
                for (i = 1; i <= n; i++) {
                    cur[0] = i;
                    for (j = 1; j <= m; j++) {
                        var cost = (x[i - 1] === y[j - 1]) ? 0 : 1;
                        cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
                    }
                    for (j = 0; j <= m; j++) prev[j] = cur[j];
                }
                return 1 - prev[m] / Math.max(n, m);
            }
            /**
             * 取"引文正文"：优先中文引号内的内容（新格式），否则剥掉书名号前缀/条号/结尾"的规定。"后的剩余部分。
             * 判定依据是它 —— 外壳（不符合…第X条"…"的规定。）允许规范化改写，正文必须逐字保留。
             */
            function diaryAiRegBody(text) {
                var t = String(text || '').trim();
                var q = t.match(/[“"]([^”"]{4,})[”"]/);
                if (q) return q[1];
                return t
                    .replace(/^[^《]*《[^》]*》/, '')
                    .replace(/^\s*第?\s*[〇零一二三四五六七八九十百0-9.]{1,8}\s*条?\s*[:：、]?\s*/, '')
                    .replace(/[，,。；;]?\s*的?\s*规定\s*[。.]?\s*$/, '')
                    .trim();
            }
            // 字符 bigram Dice 相似度（去标点空白）：用于"规章是否被改写""润色是否过头"的量化判断
            function diaryAiSim(a, b) {
                var norm = function (s) { return String(s || '').replace(/[\s，。、；：？！“”‘’"'（）()【】\[\]《》〈〉,.;:?!<>~—-]/g, ''); };
                var x = norm(a), y = norm(b);
                if (!x || !y) return 1;
                if (x === y) return 1;
                var big = function (s) { var m = {}, out = 0; for (var i = 0; i < s.length - 1; i++) { var g = s.substr(i, 2); m[g] = (m[g] || 0) + 1; out++; } return { m: m, n: out }; };
                var bx = big(x), by = big(y), inter = 0;
                Object.keys(bx.m).forEach(function (k) { if (by.m[k]) inter += Math.min(bx.m[k], by.m[k]); });
                return (2 * inter) / ((bx.n + by.n) || 1);
            }
            /**
             * 字段级守卫：AI 改完的文本先过这里，越界就**回退原值**（宁可少改，不可改错）。
             * kind='reg' 走更严的规章规则：书名号、条款编号不得变，相似度 <0.88 视为改写。
             */
            function diaryAiGuardField(kind, before, after) {
                var b = String(before == null ? '' : before), a = String(after == null ? '' : after);
                if (!a.trim()) return { ok: false, warn: '改成了空内容' };
                if (kind === 'reg') {
                    if (diaryAiTitles(b) !== diaryAiTitles(a)) return { ok: false, warn: '书名号/标题被改动' };
                    if (diaryAiArticleNo(b) !== diaryAiArticleNo(a)) return { ok: false, warn: '条款编号被改动（第' + (diaryAiArticleNo(b) || '?') + ' vs 第' + (diaryAiArticleNo(a) || '?') + '）' };
                    if (diaryAiNums(b) !== diaryAiNums(a)) return { ok: false, warn: '条款里的数字被改动' };
                    // 允许"违反《X》4.3.4：正文。" → "不符合《X》第4.3.4条“正文”的规定。"（外壳规范化），
                    // 但**引文正文**必须基本一致（≥0.9）—— 正文被改写才是必须拦下的情况
                    var bodyB = diaryAiRegBody(b), bodyA = diaryAiRegBody(a);
                    if (bodyB && bodyA) {
                        var sBody = diaryAiSimEdit(bodyB, bodyA);
                        if (sBody < 0.85) return { ok: false, warn: '引文正文被改写（相似度 ' + sBody.toFixed(2) + '<0.85）' };
                        return { ok: true, text: a };
                    }
                    var s1 = diaryAiSimEdit(b, a);
                    if (s1 < 0.85) return { ok: false, warn: '规章内容被改写（相似度 ' + s1.toFixed(2) + '<0.85）' };
                    return { ok: true, text: a };
                }
                if (diaryAiNums(b) !== diaryAiNums(a)) return { ok: false, warn: '数字/日期被改动' };
                var s2 = diaryAiSim(b, a);
                if (s2 < 0.5) return { ok: true, soft: true, text: a, warn: '改动较大（相似度 ' + s2.toFixed(2) + '）' };
                return { ok: true, text: a };
            }
            /** 规章回库校对照：在规章库里按《标题》+第X条定位同一条款原文 */
            function diaryAiLibLookup(regText) {
                try {
                    var rules = (typeof window.getRulesData === 'function') ? (window.getRulesData() || []) : [];
                    if (!rules.length) return null;
                    var t = String(regText || '');
                    var tm = t.match(/《([^》]+)》/);
                    var title = tm ? tm[1] : '';
                    var am = t.match(/第\s*([一二三四五六七八九十百零〇\d]{1,6})\s*条/);
                    var want = am ? am[1] : '';
                    var cands = title ? rules.filter(function (r) {
                        var rt = String(r.title || '');
                        if (diaryAiIsHandbook(rt)) return false;              // 手册不能当规章引用
                        return rt && (rt.indexOf(title) !== -1 || title.indexOf(rt) !== -1);
                    }) : [];
                    if (!cands.length) cands = rules.filter(function (r) { return !diaryAiIsHandbook(r.title); });
                    if (want) {
                        for (var i = 0; i < cands.length; i++) {
                            var body = String(cands[i].content || '');
                            var idx = body.indexOf('第' + want + '条');
                            if (idx < 0) idx = body.indexOf('第 ' + want + '条');
                            if (idx >= 0) {
                                var seg = body.slice(idx, idx + 400);
                                var nx = seg.slice(1).search(/第\s*[一二三四五六七八九十百零〇\d]+\s*条/);
                                if (nx > 0) seg = seg.slice(0, nx + 1);
                                return { title: cands[i].title || '', ref: '第' + want + '条', text: seg.trim(), sim: diaryAiSim(t, seg) };
                            }
                        }
                    }
                    var best = null;
                    cands.slice(0, 30).forEach(function (r) {
                        var s = diaryAiSim(t, r.content || '');
                        if (!best || s > best.sim) best = { title: r.title || '', ref: '', text: String(r.content || '').slice(0, 400), sim: s };
                    });
                    return best;
                } catch (e) { return null; }
            }
            // ── 台账（检查信息）引用优先 ────────────────────────────────────────
            // 用户口径（2026-09-18）：对规**优先用"检查信息"里已经引用过的规章** —— 同一条问题在台账里
            //   往往已经有 regulation（写实里的问题经常就是从台账「📝 记入日志」带过来的），相似就直接搬用，
            //   保证写实与台账口径一致；台账里没有，才去规章库找。
            //   另外：**《安全检查手册》不能当规章引用**（手册是检查项点，不是依据）。
            function diaryAiIsHandbook(s) { return /手册/.test(String(s || '')); }
            function diaryAiNormForMatch(s) {
                return String(s || '').replace(/[\s，。、；：？！“”‘’"'（）()【】\[\]《》〈〉,.;:?!<>~—-]/g, '').trim();
            }
            function diaryAiSampleGrams(s, n) {
                var t = diaryAiNormForMatch(s), out = [], seen = {};
                var step = Math.max(2, Math.floor(t.length / (n || 6)));
                for (var i = 0; i + 4 <= t.length; i += step) {
                    var g = t.substr(i, 4);
                    if (!seen[g]) { seen[g] = 1; out.push(g); }
                    if (out.length >= (n || 6)) break;
                }
                if (!out.length && t.length >= 2) out.push(t.slice(0, Math.min(4, t.length)));
                return out;
            }
            /**
             * 在检查信息台账里找"相似问题"，把它已引用的规章搬过来。
             *   sim = 1（归一化后完全一致）→ 可直接照搬（diaryAiAutoFillFromLedger 自动写入）
             *   0.62 ≤ sim < 0.8 → 作为候选给用户挑（排在最前）
             *   台账里没引用过规章 / 引用的是手册 → 返回 null（转规章库）
             * 性能：先 4 字滑窗预筛再算相似度，4 万条台账实测几十毫秒级；同一次运行内按问题文本缓存。
             */
            var _diaryAiLedgerCache = {};
            function diaryAiLedgerRegSuggest(issueText) {
                var key = String(issueText || '').trim();
                if (!key) return null;
                if (_diaryAiLedgerCache[key] !== undefined) return _diaryAiLedgerCache[key];
                var ALL = (typeof window.getIssueData === 'function') ? (window.getIssueData() || []) : [];
                var q0 = key, q = diaryAiNormForMatch(q0);
                if (!q || !ALL.length) { _diaryAiLedgerCache[key] = null; return null; }
                var grams = diaryAiSampleGrams(q, 6);
                var scanned = 0, exact = null, best = null;
                for (var i = ALL.length - 1; i >= 0 && scanned < 40000; i--) {
                    var r = ALL[i];
                    if (!r) continue;
                    var reg = String(r.regulation || '').trim();
                    if (!reg) continue;
                    if (diaryAiIsHandbook(reg)) continue;               // 手册不算规章依据
                    var c = String(r.content || '');
                    if (!c) continue;
                    scanned++;
                    var hay = c.length > 400 ? c.slice(0, 400) : c;
                    var hit = false;
                    for (var k = 0; k < grams.length; k++) { if (hay.indexOf(grams[k]) !== -1) { hit = true; break; } }
                    if (!hit) continue;
                    if (diaryAiNormForMatch(c) === q) {                 // 同一条问题 → 直接照搬
                        exact = { text: reg, sim: 1, date: r.datetime || '', content: c };
                        break;
                    }
                    var s = diaryAiSim(q0, c);
                    if (!best || s > best.sim || (s === best.sim && String(r.datetime || '') > String(best.date || ''))) {
                        best = { text: reg, sim: s, date: r.datetime || '', content: c };
                    }
                }
                var picked = exact || best;
                if (picked && !exact && picked.sim < 0.62) picked = null;
                _diaryAiLedgerCache[key] = picked;
                return picked;
            }
            // ⚠️ 用户口径（2026-09-18 纠正）：台账里已引用的规章**只"搬到采纳选项里"**，
            //   **绝不自动写入** —— 由用户在回执里点「采纳」确认（与规章库候选同一套确认流程）。
            function diaryAiSyncRegDom(date, idx, text) {
                var dateEl = document.getElementById('diary-date');
                if (!dateEl || dateEl.value !== date) return;
                var el = document.getElementById('diary-regulation-' + idx);
                if (el && el.value !== text) { el.value = text; if (typeof autoResize === 'function') autoResize(el); }
            }
            /** 知识库索引召回候选条款（无规章依据时用；与「智能对规」同一套 KB 索引；**排除手册**） */
            async function diaryAiRecallRules(text, topK) {
                if (!window.KB || typeof window.KB.searchRules !== 'function') return [];
                try {
                    if (typeof window.KB.ensure === 'function') {
                        // ⚠️ 最多等 4 秒：规章索引首次建立/恢复可能耗时，但绝不能因此让"一键修改"长时间无响应
                        //    （超时就用现有索引 / 无候选继续，模型仍可正常改文字）
                        await Promise.race([
                            window.KB.ensure(['rules']),
                            new Promise(function (r) { setTimeout(r, 4000); })
                        ]);
                    }
                    var hits = window.KB.searchRules(String(text || '').slice(0, 400), topK || 4) || [];
                    return hits
                        // ⚠️ 手册（如《安全检查手册3》）写在规章库里也不能当规章引用 —— 用户明确口径
                        .filter(function (h) { return !diaryAiIsHandbook((h.title || '') + ' ' + (h.path || '')); })
                        .map(function (h) {
                            return { ref: h.ref || '', title: h.title || '', trade: h.trade || '', path: h.path || '', text: String(h.text || '').slice(0, 300), from: 'rules' };
                        });
                } catch (e) { console.warn('[diary][ai] 规章召回失败：', e && e.message); return []; }
            }
            function diaryAiSys() {
                return [
                    '你是铁路安全监察领域的文字校订专家。请对"工作写实"与"检查发现问题"做校订：只改文字，不改事实。',
                    '',
                    '【可以改】',
                    '1. 语句通顺：消除生硬拼接、重复、"的"字叠加，必要时调整语序；',
                    '2. 逻辑合理：按"做了什么 → 发现什么 → 如何处置"理顺前后关系，不改变原意；',
                    '3. 语言书面化、简洁：去口语（"弄了/搞了/看了一下"）、去空话套话，同一事实只说一次；',
                    '4. 纠正错别字、多字、少字、标点符号（统一中文标点），同一事实的重复表述可合并。',
                    '',
                    '【绝对不能改】',
                    '5. 事实：日期、时间、地点、单位/部门、人名、设备名称与编号、数量、计量单位、专业术语 —— 原样保留；',
                    '6. 不得新增原文没有的信息（不得编造检查发现、不得补写整改措施、不得加评价性结论）；',
                    '7. 不得删除原文已有的信息（重复表述只做合并表达，不丢信息）；',
                    '8. 不动小标题、序号与层级（"一、""（一）""1."），不动【】（）中的标注。',
                    '',
                    '【规章依据 regulations —— 外壳按"对规结论"规范改写，引文正文一句都不许改】',
                    '9. 统一写成结论式：**不符合《法规名称》第X条“条款原文”的规定。**',
                    '   示例：原「违反《高速铁路信号维护规则技术标准》4.3.4：轨道电路送、受端电缆应按照调整表要求补偿到规定长度，实际电缆长度通过电缆环阻测试计算：L=环阻/45 (km)。」',
                    '   → 改「不符合《高速铁路信号维护规则技术标准》第4.3.4条“轨道电路送、受端电缆应按照调整表要求补偿到规定长度，实际电缆长度通过电缆环阻测试计算：L=环阻/45 (km)”的规定。」',
                    '   · 前缀统一用"不符合"（原文写"违反""不符合…规定"等一律归一到这一句式）；',
                    '   · 条号统一写成「第X条」（4.3.4 → 第4.3.4条；第十二条 → 第12条；第12条 → 第12条）；',
                    '   · 条款原文用中文引号“ ”包起来；结尾统一加"的规定。"；书名号《》必须保留。',
                    '10. **引号内的条款原文必须逐字保留**：只允许纠正错别字、多字少字与标点符号，不得改动用词、语序、句式，不得增删内容、不得改引其它条款；',
                    '    若给了"规章库原文"，以库内原文为准逐字校对；原文没有书名号或定位不到条款时，保持原样、不要编造。',
                    '',
                    '【缺规章依据时 —— 先搬台账、再查规章库；给 1~3 个候选供用户挑选】',
                    '11. 数据来源优先级（用户口径，必须遵守）：① 标着 [检查信息台账已引用·优先] 的候选，是**同一条问题在"检查信息"里已经引用过的规章** —— 优先采用（**列为候选第 1 条**，保持写实与台账一致）；',
                    '    ② 台账候选不适用、或没有台账候选时，才从标着 [规章库] 的候选里挑；③ **《…手册…》不是规章依据，一律不得引用**（候选里若出现手册类内容，直接忽略）。',
                    '12. 输出候选：某条问题"规章依据"为空且给了【候选条款】时，从中挑**最多 3 条**（按贴合度从高到低；台账候选排最前），每条一个 ruleSuggest 项（i 相同）：',
                    '    · rule：按第 9 条的结论式写，如「不符合《X》第Y条“条款原文”的规定。」；台账候选原样搬也要整理成结论式；',
                    '    · ref / title：照抄候选的条号与标题，不得改写；cid：把该候选编号（如 c0）一并返回；',
                    '    · why：≤15 字说明"为什么这条最贴切"（如"直接对应确认信号"），供用户判断；',
                    '    · 贴合度不足就少给（只给 1~2 条也正常），候选都不相关返回空数组；**严禁自行编造条款**。',
                    '',
                    '【输出】只输出一个合法 JSON 对象（禁止代码块、禁止任何解释），结构如下：',
                    '{"work":{"text":"…","changes":[{"type":"错别字","from":"已径","to":"已经"}]},',
                    ' "issues":[{"i":0,"text":"…","changes":[]}],',
                    ' "regulations":[{"i":0,"text":"…","changes":[{"type":"标点","from":"，。","to":"。"}]}],',
                    ' "ruleSuggest":[{"i":1,"rule":"不符合《X》第Y条“条款原文”的规定。","ref":"第Y条","title":"X","why":"同一专业条款","cid":"c0"}]}',
                    '要求：issues/regulations 的 i 与输入编号严格对应、条数不得增减；changes 只列真正改过的地方（原→改），没改就给空数组；没有可改之处时 text 原样返回。'
                ].join('\n');
            }
            function diaryAiBuildUser(rec, ctx) {
                var L = [];
                L.push('【日期】' + rec.date);
                L.push('【工作写实】');
                L.push(String(rec.work || '').slice(0, 3000) || '（无）');
                L.push('');
                L.push('【检查发现问题（i 即编号，必须逐条对应返回）】');
                (rec.issues || []).forEach(function (x, i) {
                    var reg = String(((rec.regulations || [])[i]) || '').trim();
                    L.push(i + '. ' + (String(x || '').slice(0, 400) || '（空）'));
                    L.push('   ↳ 规章依据：' + (reg || '（无 → 请从下方候选条款中挑 1 条填入 ruleSuggest）'));
                    var lib = reg ? ctx.libMap[i] : null;
                    if (lib && lib.text) L.push('   ↳ 规章库原文（仅作校对参照）：' + (lib.title ? '《' + lib.title + '》' : '') + (lib.ref || '') + ' ' + String(lib.text).slice(0, 400));
                });
                if (ctx.cands.length) {
                    L.push('');
                    L.push('【候选条款（只能从这里选，不得编造；请把选中的候选编号 cid 一并返回）】');
                    ctx.cands.forEach(function (c, i) {
                        var label = (c.from === 'ledger') ? '[检查信息台账已引用·优先]' : '[规章库]';
                        L.push('[c' + i + ']' + label + ' '
                            + (c.from === 'ledger'
                                ? String(c.text || '').slice(0, 240)
                                : ((c.title ? '《' + c.title + '》' : '') + (c.ref ? c.ref + '：' : '') + String(c.text || '').slice(0, 200)))
                            + (c.path ? '（' + c.path + '）' : ''));
                    });
                }
                return L.join('\n');
            }
            async function diaryAiBuildCtx(rec) {
                var ctx = { libMap: {}, cands: [], candMeta: [], signal: null };
                (rec.regulations || []).forEach(function (x, i) {
                    if (!String(x || '').trim()) return;
                    var lib = diaryAiLibLookup(x);
                    if (lib && lib.text) ctx.libMap[i] = lib;
                });
                var missing = (rec.issues || []).map(function (x, i) {
                    return (String(x || '').trim() && !String(((rec.regulations || [])[i]) || '').trim()) ? i : -1;
                }).filter(function (i) { return i >= 0; });
                if (missing.length) {
                    _diaryAiNote = '正在从检查信息台账/知识库匹配规章条款…';
                    var seen = {};
                    var pushCand = function (c) {
                        var key = (c.from || '') + '|' + (c.title || '') + '|' + (c.ref || '') + '|' + String(c.text || '').slice(0, 30);
                        if (seen[key] || ctx.cands.length >= 10) return;
                        seen[key] = 1;
                        ctx.cands.push(c);
                    };
                    for (var k = 0; k < missing.length && ctx.cands.length < 10; k++) {
                        var it = String((rec.issues || [])[missing[k]] || '');
                        // ① 检查信息台账里相似问题已引用的规章 —— **优先**（照搬，保持与台账一致）
                        var led = diaryAiLedgerRegSuggest(it);
                        if (led) {
                            pushCand({
                                from: 'ledger', title: '检查信息台账已引用', ref: '',
                                text: String(led.text).slice(0, 400),
                                path: (led.date ? (String(led.date).slice(0, 10) + ' 台账') : '台账'),
                                sim: led.sim
                            });
                        }
                        // ② 规章库（KB 条款召回，已排除手册）
                        var hits = await diaryAiRecallRules(it, 5);
                        hits.forEach(pushCand);
                    }
                    ctx.cands.forEach(function (c, i) {
                        c.cid = 'c' + i;
                        ctx.candMeta[i] = { from: c.from || '', title: c.title || '', sim: (c.sim != null ? c.sim : null) };
                    });
                }
                return ctx;
            }
            /** 结果归一 + 字段守卫（越界回退原值并计入 warns） */
            function diaryAiNormalizeRecord(rec, j, ctx) {
                var out = { work: null, issues: null, regulations: null, changes: [], warns: [], notes: [], ruleSuggest: [] };
                if (!j || typeof j !== 'object') return null;
                var pushChanges = function (field, list) {
                    (list || []).forEach(function (c) {
                        var from = String((c && c.from) || '').trim(), to = String((c && c.to) || '').trim();
                        if (!from && !to) return;
                        out.changes.push({ field: field, type: String((c && c.type) || '修改'), from: from, to: to });
                    });
                };
                if (j.work && typeof j.work.text === 'string' && String(rec.work || '').trim()) {
                    var g = diaryAiGuardField('text', rec.work, j.work.text);
                    if (g.ok) { out.work = g.text; pushChanges('工作写实', j.work.changes); }
                    else out.warns.push('工作写实：' + g.warn + ' → 已保留原文');
                    if (g.ok && g.warn) (g.soft ? out.notes : out.warns).push('工作写实：' + g.warn);
                }
                var arr = (rec.issues || []).slice();
                if (Array.isArray(j.issues)) {
                    j.issues.forEach(function (it) {
                        var i = parseInt(it && it.i, 10);
                        if (!(i >= 0 && i < arr.length)) return;
                        if (typeof it.text !== 'string' || !String(arr[i] || '').trim()) return;
                        var g2 = diaryAiGuardField('text', arr[i], it.text);
                        if (g2.ok) { arr[i] = g2.text; pushChanges('问题' + (i + 1), it.changes); }
                        else out.warns.push('问题' + (i + 1) + '：' + g2.warn + ' → 已保留原文');
                        if (g2.ok && g2.warn) (g2.soft ? out.notes : out.warns).push('问题' + (i + 1) + '：' + g2.warn);
                    });
                    out.issues = arr;
                }
                var regs = (rec.regulations || []).slice();
                while (regs.length < arr.length) regs.push('');
                if (Array.isArray(j.regulations)) {
                    j.regulations.forEach(function (it) {
                        var i = parseInt(it && it.i, 10);
                        if (!(i >= 0 && i < regs.length)) return;
                        if (typeof it.text !== 'string' || !String(regs[i] || '').trim()) return;   // 原本为空 → 走候选
                        var g3 = diaryAiGuardField('reg', regs[i], it.text);
                        if (g3.ok) { regs[i] = g3.text; pushChanges('规章' + (i + 1), it.changes); }
                        else out.warns.push('规章依据' + (i + 1) + '：' + g3.warn + ' → 已保留原文');
                    });
                }
                out.regulations = regs;
                if (Array.isArray(j.ruleSuggest)) {
                    // 每条问题最多 3 个候选（用户口径：给 1~3 条更准），并去重、丢弃越界 i
                    var perIssue = {}, seenSug = {};
                    j.ruleSuggest.forEach(function (s) {
                        var i = parseInt(s && s.i, 10);
                        var txt = String((s && (s.rule || s.text)) || '').trim();
                        if (!(i >= 0 && i < regs.length) || !txt) return;
                        if (String(regs[i] || '').trim()) return;               // 已有规章的不覆盖
                        if (seenSug[i + '|' + txt]) return;                     // 去重
                        if ((perIssue[i] || 0) >= 3) return;                    // 超量截断
                        seenSug[i + '|' + txt] = 1;
                        perIssue[i] = (perIssue[i] || 0) + 1;
                        // 用模型回传的候选编号(cid)反查来源（台账优先 / 规章库），回执里如实标注
                        var cidM = String((s && s.cid) || '').match(/^c?(\d+)$/);
                        var meta = (ctx && ctx.candMeta && cidM) ? ctx.candMeta[parseInt(cidM[1], 10)] : null;
                        out.ruleSuggest.push({
                            i: i, text: txt,
                            ref: String((s && s.ref) || ''), title: String((s && s.title) || ''),
                            why: String((s && s.why) || '').slice(0, 30),
                            src: (meta && meta.from) || '', cid: String((s && s.cid) || ''),
                            note: (meta && meta.from === 'ledger' && meta.sim != null)
                                ? ('台账相似度 ' + (meta.sim >= 0.999 ? '完全一致' : meta.sim.toFixed(2))) : ''
                        });
                    });
                    // 台账来源的排前面（用户口径：优先台账）
                    out.ruleSuggest.sort(function (a, b) { return (b.src === 'ledger' ? 1 : 0) - (a.src === 'ledger' ? 1 : 0); });
                }
                return out;
            }
            async function diaryAiFixOne(rec, ctx) {
                var user = diaryAiBuildUser(rec, ctx);
                var r = await window.dsCallOnce(diaryAiSys(), user, {
                    temperature: 0.1,
                    maxTokens: Math.min(8000, Math.round(user.length * 1.6) + 600),
                    timeoutMs: 60000,
                    signal: ctx.signal
                });
                if (!r || !r.ok) throw new Error(String((r && r.error) || '调用失败'));
                var j = window.dsParseJsonLoose ? window.dsParseJsonLoose(r.text) : null;
                if (!j) throw new Error('返回内容不是合法 JSON');
                return diaryAiNormalizeRecord(rec, j, ctx);
            }
            /** 写回内存 + 落盘 + （若正在编辑同一天）同步输入框 */
            function diaryAiApplyResult(date, res) {
                var i = diaries.findIndex(function (d) { return d.date === date; });
                if (i === -1) return { changed: 0 };
                var d = diaries[i], changed = 0;
                if (res.work != null && res.work !== d.work) { d.work = res.work; changed++; }
                if (Array.isArray(res.issues)) {
                    var nextIssues = [];
                    for (var k = 0; k < d.issues.length; k++) {
                        var nv = res.issues[k];
                        if (nv != null && nv !== d.issues[k]) { nextIssues.push(nv); changed++; } else nextIssues.push(d.issues[k]);
                    }
                    d.issues = nextIssues;
                }
                if (Array.isArray(res.regulations)) {
                    var regs = (d.regulations || []).slice();
                    while (regs.length < d.issues.length) regs.push('');
                    var nextRegs = [];
                    for (var m = 0; m < regs.length; m++) {
                        var rv = res.regulations[m];
                        if (rv != null && rv !== regs[m]) { nextRegs.push(rv); changed++; } else nextRegs.push(regs[m]);
                    }
                    d.regulations = nextRegs;
                }
                diaries[i] = d;
                saveDiaries();
                updateDiaryCount();
                diaryAiSyncDom(date);
                return { changed: changed };
            }
            /** 记录指纹：用于判断"请求期间这条写实是否被改过"（含自动保存落盘） */
            function diaryAiRecSig(rec) {
                return JSON.stringify([String(rec.work || ''), rec.issues || [], rec.regulations || []]);
            }
            function diaryAiDomSnapshot(date) {
                var inputView = document.getElementById('diary-input-view');
                var dateEl = document.getElementById('diary-date');
                if (!dateEl || !inputView || inputView.style.display === 'none' || dateEl.value !== date) return null;
                var c = collectIssuesAndRegulations();
                return JSON.stringify({ w: (document.getElementById('diary-work') || {}).value || '', i: c.issues, r: c.regulations });
            }
            function diaryAiSyncDom(date) {
                var inputView = document.getElementById('diary-input-view');
                var dateEl = document.getElementById('diary-date');
                if (!dateEl || !inputView || inputView.style.display === 'none' || dateEl.value !== date) return;
                var rec = diaries.filter(function (d) { return d.date === date; })[0];
                if (!rec) return;
                var workEl = document.getElementById('diary-work');
                if (workEl && workEl.value !== (rec.work || '')) { workEl.value = rec.work || ''; if (typeof autoResize === 'function') autoResize(workEl); }
                renderIssueFields(rec.issues || [], rec.regulations || []);
            }
            function diaryAiRefreshViews() {
                try {
                    if (document.getElementById('diary-calendar')) renderCalendar();
                    if (diaryFilterMode === 'history') {
                        var kw = diaryAiKeyword();
                        if (kw) window.diarySearch(kw); else document.getElementById('diary-records-list').innerHTML = '';
                        if (_selectedDate) renderDateDetail(_selectedDate);
                    }
                } catch (e) { console.warn('[diary][ai] 刷新视图失败：', e && e.message); }
                // 知识库：写实源按天分块，就地改内容可能不触发重建 → 主动失效，保证之后检索到的是新文本
                try { if (typeof window.dsInvalidateRagCache === 'function') window.dsInvalidateRagCache('diary'); } catch (e) {}
            }
            function diaryAiPanel(html) {
                var el = document.getElementById('diary-ai-fix-panel');
                if (!el) return;
                el.innerHTML = html;
                el.style.display = 'block';
            }
            // ---- 悬浮气泡（点击后的"有反应"反馈）：固定右下角，不受滚动位置影响 ----
            //   为什么必须有它：回执面板在卡片顶部，用户在下方编辑区点按钮时它在屏幕外；
            //   而模型单条要 10~40 秒，界面若一动不动就会被当成"点坏了"（用户实测反馈）。
            var _diaryAiToastTimer = null, _diaryAiTick = null, _diaryAiNote = '';
            var DIARY_AI_VER = '2026-09-18d';       // 版本号：回执页脚会显示，用来确认是不是新版本（旧缓存排查用）
            // 按钮旁的进度文字（点击后立刻出现，最不会错过的反馈位置）
            function diaryAiInline(text) {
                var el = document.getElementById('diary-ai-fix-inline');
                if (el) el.textContent = text || '';
            }
            function diaryAiToast(html, opts) {
                opts = opts || {};
                var el = document.getElementById('diary-ai-toast');
                if (!el) {
                    el = document.createElement('div');
                    el.id = 'diary-ai-toast';
                    // 放在**屏幕顶部居中**：底部右下角容易被手机底部栏/悬浮按钮挡住（实测"气泡没出现"的可能原因之一）
                    Object.assign(el.style, {
                        position: 'fixed', top: '12px', left: '50%', transform: 'translateX(-50%)',
                        maxWidth: 'min(94vw, 460px)',
                        background: '#1e293b', color: '#fff', padding: '10px 14px', borderRadius: '14px',
                        fontSize: '0.84rem', lineHeight: '1.5', fontWeight: '600',
                        boxShadow: '0 4px 14px rgba(0,0,0,.3)', zIndex: '10150',
                        opacity: '0', transition: 'opacity .25s ease', cursor: 'default'
                    });
                    document.body.appendChild(el);
                }
                el.innerHTML = html;
                el.style.opacity = '1';
                el.style.cursor = opts.onClick ? 'pointer' : 'default';
                el.onclick = opts.onClick || null;
                if (_diaryAiToastTimer) { clearTimeout(_diaryAiToastTimer); _diaryAiToastTimer = null; }
                if (opts.sticky !== true) {
                    _diaryAiToastTimer = setTimeout(function () { el.style.opacity = '0'; }, opts.ms || 4000);
                }
                return el;
            }
            function diaryAiTickStart(stats) {
                diaryAiTickStop();
                var render = function () {
                    var sec = Math.round((Date.now() - stats.t0) / 1000);
                    var head = '✨ AI 修改中…' + (stats.total > 1 ? ('（' + Math.max(1, stats.done + 1) + '/' + stats.total + '）') : '')
                        + ' 已用 ' + sec + 's';
                    diaryAiToast(head + '<div style="font-weight:400;font-size:0.78rem;opacity:.85;margin-top:2px;">'
                        + escapeHtml(_diaryAiNote || '正在调用模型（单条通常 10~40 秒）') + '<br>点此停止</div>',
                        { sticky: true, onClick: function () { window.diaryAiStop(); } });
                    diaryAiInline('✨ 修改中 ' + sec + 's…');      // 按钮旁：最不会错过的反馈
                    if (_diaryAiBusy) diaryAiProgress(stats, _diaryAiNote);
                };
                render();                              // 【关键】立即渲染：点击瞬间就有反馈，不等第一个 500ms 周期
                _diaryAiTick = setInterval(render, 500);
            }
            function diaryAiTickStop() {
                if (_diaryAiTick) { clearInterval(_diaryAiTick); _diaryAiTick = null; }
                diaryAiInline('');
            }
            /** 回执面板若在屏幕外（用户正在下方编辑区），滚到可见处 —— 免得"点了没动静" */
            function diaryAiPanelEnsureVisible() {
                var el = document.getElementById('diary-ai-fix-panel');
                if (!el || el.style.display === 'none') return;
                try {
                    var r = el.getBoundingClientRect();
                    if (r.top < 0 || r.bottom > (window.innerHeight || 0)) el.scrollIntoView({ block: 'nearest' });
                } catch (e) {}
            }
            function diaryAiElapsed(stats) { return stats && stats.t0 ? Math.round((Date.now() - stats.t0) / 1000) : 0; }
            function diaryAiProgress(stats, note) {
                diaryAiPanel([
                    '<div style="font-weight:600;">✨ 一键 AI 修改 ' + (stats.done + '/' + stats.total) + ' · ✏️ 已改 ' + stats.changed + ' 处 · 📜 候选 ' + stats.suggestions + ' · ⚠️ 拦下 ' + stats.warns + ' · 🔎 待复核 ' + stats.notes + ' · ⏭️ 跳过 ' + stats.skipped + ' · ❌ 失败 ' + stats.failed + ' · ⏱ ' + diaryAiElapsed(stats) + 's</div>',
                    '<div style="color:var(--text-secondary);margin-top:4px;">' + escapeHtml(note || '') + '</div>',
                    '<div style="margin-top:8px;"><button class="btn btn-secondary btn-small" onclick="diaryAiStop()">⏹ 停止（已完成的不回退）</button></div>'
                ].join(''));
            }
            function diaryAiBackup(list) {
                try {
                    // 整条深拷贝（不挑字段）：撤销才能做到字节级还原，也保留 mediaIds 等既有字段
                    var items = list.map(function (d) { return JSON.parse(JSON.stringify(d)); });
                    localStorage.setItem(DIARY_AI_BK_K, JSON.stringify({ ts: Date.now(), items: items }));
                } catch (e) { console.warn('[diary][ai] 备份失败：', e && e.message); }
            }
            window.diaryAiStop = function () { _diaryAiStop = true; };
            // 诊断钩子（排查"为什么这条没被改/被拦下"时看它，取证脚本也用它做定点断言；不参与业务逻辑）
            window.__diaryAiDiag = {
                guard: diaryAiGuardField,
                simEdit: diaryAiSimEdit,
                articleNo: diaryAiArticleNo,
                regBody: diaryAiRegBody,
                nums: diaryAiNums
            };
            // 入口（用户口径 2026-09-18，最终版）：
            //   「✨ 一键修改」= **只改当前编辑页面这一天**的写实与检查问题（输入界面正在编辑的那天 / 日历选中那天 / 当日）。
            //   没有范围选择面板、没有 ▾ 菜单、不弹任何确认 —— 点一下就对这一天开跑（≤上限条数），改完自动保存、可撤销。
            //   ⚠️ 回执面板必须放在 index.html 的两个视图**之外**，否则在编辑界面点按钮时回执渲染在隐藏的
            //      查询视图里，表现为"点击无反应"（实测就是这个原因）。
            window.diaryAiFix = function () {
                if (typeof console !== 'undefined') console.log('[diary][ai] 引擎 v' + DIARY_AI_VER);
                if (_diaryAiBusy) { alert('AI 修改正在进行中，请等它跑完。'); return; }
                if (!window.dsCallOnce) { alert('底层 AI 调用未就绪（doubao-common.js 未加载）。'); return; }
                if (!(localStorage.getItem('ds_api_key_v1') || '')) { alert('请先在「设置 → API 配置」里填写 API Key。'); return; }
                var def = diaryAiDefaultScope();
                var kind = 'day:' + def.date;
                var n = diaryAiPick(kind).length;
                if (!n) {
                    diaryAiPanel('<div style="font-weight:600;">✨ 一键 AI 修改</div>'
                        + '<div style="color:var(--text-secondary);margin-top:4px;">' + escapeHtml(def.label) + ' 还没有可修改的内容。'
                        + '先在「📋 工作内容 / ⚠️ 检查发现问题」里写点什么，再点「✨ 一键修改」。</div>'
                        + '<div style="margin-top:8px;"><button class="btn btn-secondary btn-small" onclick="document.getElementById(\'diary-ai-fix-panel\').style.display=\'none\'">关闭</button></div>');
                    diaryAiInline('');
                    diaryAiToast('ℹ️ ' + escapeHtml(def.label) + ' 还没有可修改的内容', { ms: 4000 });
                    return;
                }
                window.diaryAiRun(kind);
            };
            window.diaryAiRun = async function (kind) {
                if (_diaryAiBusy) return;
                var list = diaryAiPick(kind).slice(0, diaryAiLimit());
                if (!list.length) return;
                _diaryAiBusy = true; _diaryAiStop = false;
                var ctrl = (typeof AbortController !== 'undefined') ? new AbortController() : null;
                diaryAiBackup(list);
                var stats = { total: list.length, done: 0, changed: 0, skipped: 0, failed: 0, warns: 0, notes: 0, suggestions: 0, t0: Date.now() };
                var details = [];
                _diaryAiLedgerCache = {};    // 台账相似检索缓存（按问题文本），每次运行重置
                var needKb = list.some(function (d) {
                    return (d.issues || []).some(function (x, i) { return String(x || '').trim() && !String(((d.regulations || [])[i]) || '').trim(); });
                });
                _diaryAiNote = '准备中…' + (needKb ? '（含规章索引恢复/建立，最多等 4 秒）' : '');
                diaryAiProgress(stats, _diaryAiNote);
                diaryAiPanelEnsureVisible();
                diaryAiTickStart(stats);      // 按钮旁文字 + 顶部气泡：点击后立刻有反馈 + 秒表 + 可点停止
                try {
                    for (var idx = 0; idx < list.length; idx++) {
                        if (_diaryAiStop) break;
                        var target = list[idx].date;
                        var live = diaries.filter(function (d) { return d.date === target; })[0];
                        if (!live) { stats.skipped++; continue; }                    // 已被删除
                        // 请求前记录两条指纹，返回时比对，任一变化就跳过（绝不覆盖用户的新内容）：
                        //   ① snap：当前正在编辑的那一天，输入框内容（用户在等待期间又敲了字）
                        //   ② recSig：记录本身（自动保存 2 秒防抖会在请求期间把输入框内容落盘，记录因此变了）
                        var snap = diaryAiDomSnapshot(target);
                        var recSig = diaryAiRecSig(live);
                        _diaryAiNote = '正在修改 ' + target + '（' + (idx + 1) + '/' + list.length + '）…';
                        diaryAiProgress(stats, _diaryAiNote);
                        try {
                            var ctx = await diaryAiBuildCtx(live);
                            ctx.signal = ctrl ? ctrl.signal : null;
                            var res = await diaryAiFixOne(live, ctx);
                            if (!res) throw new Error('返回结构异常');
                            if (_diaryAiStop) { break; }
                            // 等待期间该日内容变了（输入框被敲字 / 自动保存已落盘）→ 跳过，绝不覆盖
                            var nowRec = diaries.filter(function (d) { return d.date === target; })[0];
                            var domChanged = (snap !== null && diaryAiDomSnapshot(target) !== snap);
                            var recChanged = (!nowRec || diaryAiRecSig(nowRec) !== recSig);
                            if (domChanged || recChanged) {
                                stats.skipped++;
                                details.push({ date: target, changes: [], warns: ['⏭️ 等待期间该日内容已更新（' + (domChanged ? '输入框有新输入' : '自动保存刚落盘') + '），本条跳过以免覆盖；稍后再点一次即可'], notes: [], suggests: [] });
                                continue;
                            }
                            var ap = diaryAiApplyResult(target, res);
                            stats.changed += ap.changed;
                            stats.warns += res.warns.length;
                            stats.notes += (res.notes || []).length;
                            stats.suggestions += res.ruleSuggest.length;
                            details.push({ date: target, changes: res.changes, warns: res.warns, notes: res.notes || [], suggests: res.ruleSuggest });
                        } catch (e) {
                            stats.failed++;
                            details.push({ date: target, changes: [], warns: ['❌ 失败：' + ((e && e.message) || e)], notes: [], suggests: [] });
                        }
                        stats.done++;
                    }
                } finally {
                    _diaryAiBusy = false;
                    diaryAiTickStop();
                    diaryAiRefreshViews();
                    diaryAiReport(kind, stats, details, Date.now() - stats.t0);
                    diaryAiToast('✅ AI 修改完成：改动 ' + stats.changed + ' 处 · 拦下 ' + stats.warns + ' · 待复核 ' + stats.notes
                        + (stats.suggestions ? ' · 候选条款 ' + stats.suggestions : '')
                        + (stats.failed ? ' · ❌ 失败 ' + stats.failed : '')
                        + (stats.skipped ? ' · ⏭️ 跳过 ' + stats.skipped : '')
                        + ' ｜ 已用 ' + diaryAiElapsed(stats) + 's'
                        + '<div style="font-weight:400;font-size:0.78rem;opacity:.85;margin-top:2px;">点此查看改动明细与「↩️ 撤销」</div>',
                        { ms: 8000, onClick: function () { var p = document.getElementById('diary-ai-fix-panel'); if (p) p.scrollIntoView({ behavior: 'smooth', block: 'center' }); } });
                }
            };
            function diaryAiReport(kind, stats, details, ms) {
                _diaryAiSuggests = {};
                _diaryAiLastReport = { kind: kind, stats: stats, details: details, ms: ms };   // 采纳后重渲染用
                var sugRows = [], chgRows = [], warnRows = [], noteRows = [];
                var ledCandN = 0;   // 其中来自"检查信息台账已引用"的候选数（只是计数，均需用户点采纳）
                details.forEach(function (d) {
                    (d.notes || []).forEach(function (n) { noteRows.push('<div style="margin:2px 0;">' + escapeHtml(d.date) + ' · ' + escapeHtml(n) + '</div>'); });
                    (d.suggests || []).forEach(function (s) { if (s.src === 'ledger') ledCandN++; });
                    // 建议补的规章依据：**按"问题"分组**，每条问题给 1~3 个候选（用户口径：给几条让他挑才准）
                    (function () {
                        var byIssue = {};
                        (d.suggests || []).forEach(function (s) { (byIssue[s.i] = byIssue[s.i] || []).push(s); });
                        Object.keys(byIssue).forEach(function (iStr) {
                            var i = parseInt(iStr, 10);
                            var list = byIssue[iStr];
                            var adopted = list.filter(function (x) { return x.adopted; })[0];
                            if (adopted) {
                                var chosen = list.filter(function (x) { return x.chosen; })[0] || adopted;
                                sugRows.push('<div style="margin:6px 0 2px;"><b>' + escapeHtml(d.date) + ' · 问题' + (i + 1) + '</b>'
                                    + '<span style="color:#047857;margin-left:6px;">✅ 已采纳：' + escapeHtml(chosen.text) + '</span></div>');
                                return;
                            }
                            var rows = list.map(function (s, k) {
                                var key = d.date + '#' + i + '#' + k;
                                _diaryAiSuggests[key] = s.text;
                                return '<div style="margin:3px 0;display:flex;gap:6px;align-items:flex-start;">'
                                    + '<span style="opacity:.6;flex-shrink:0;">' + '①②③'.charAt(k) + '</span>'
                                    + '<span style="flex:1;min-width:0;">'
                                    + (s.src === 'ledger'
                                        ? '<span style="background:#ecfdf5;color:#047857;border-radius:5px;padding:0 4px;margin-right:4px;font-size:0.74rem;">台账已引用·优先</span>'
                                        : (s.src === 'rules' ? '<span style="background:#eff6ff;color:#1d4ed8;border-radius:5px;padding:0 4px;margin-right:4px;font-size:0.74rem;">规章库</span>' : ''))
                                    + escapeHtml(s.text)
                                    + (s.note ? ' <span style="color:#047857;font-size:0.74rem;">（' + escapeHtml(s.note) + '）</span>' : '')
                                    + (s.why ? ' <span style="color:var(--text-secondary);font-size:0.76rem;">（' + escapeHtml(s.why) + '）</span>' : '')
                                    + '</span>'
                                    + '<button class="btn btn-secondary btn-small" style="flex-shrink:0;" onclick="diaryAiAdoptRule(\'' + d.date + '\',' + i + ',\'' + key + '\')">采纳</button></div>';
                            }).join('');
                            sugRows.push('<div style="margin:6px 0 2px;"><b>' + escapeHtml(d.date) + ' · 问题' + (i + 1) + '</b>'
                                + (list.length > 1 ? '<span style="color:var(--text-secondary);font-size:0.78rem;margin-left:6px;">共 ' + list.length + ' 个候选，选最贴切的一条</span>' : '')
                                + rows + '</div>');
                        });
                    })();
                    (d.changes || []).slice(0, 12).forEach(function (c) {
                        chgRows.push('<div style="margin:2px 0;">' + escapeHtml(d.date) + ' · ' + escapeHtml(c.field) + ' · ' + escapeHtml(c.type) + '：'
                            + '<span style="color:#b91c1c;text-decoration:line-through;">' + escapeHtml(c.from || '（新增）') + '</span> → '
                            + '<span style="color:#047857;">' + escapeHtml(c.to || '（删除）') + '</span></div>');
                    });
                    (d.warns || []).forEach(function (w) { warnRows.push('<div style="margin:2px 0;">' + escapeHtml(d.date) + ' · ' + escapeHtml(w) + '</div>'); });
                });
                var html = [
                    '<div style="font-weight:600;">✨ 一键修改完成：共 ' + stats.total + ' 条 · ✏️ 改动 ' + stats.changed + ' 处 · 📥 台账候选 ' + ledCandN + ' 条 · 📜 候选条款 ' + stats.suggestions + ' 条 · ⚠️ 拦下 ' + stats.warns + ' 处 · 🔎 待复核 ' + stats.notes + ' 处 · ⏭️ 跳过 ' + stats.skipped + ' 条 · ❌ 失败 ' + stats.failed + ' 条 ｜ 用时 ' + (ms / 1000).toFixed(1) + 's</div>',
                    '<div style="color:var(--text-secondary);margin-top:4px;">已自动保存（' + escapeHtml(diaryAiScopeLabel(kind)) + '）。数字/日期/书名号被改动的字段已自动回退为原文；规章依据只做纠错与规范化，检查手册不作为规章依据。<b>所有候选（含台账已引用的）都需要你点「采纳」才会写入。</b> ｜ 引擎 v' + DIARY_AI_VER + '</div>'
                ];
                if (sugRows.length) html.push('<div style="margin-top:8px;"><b>📜 建议补的规章依据（点「采纳」写入该条问题；台账已引用的排在最前）</b>' + sugRows.join('') + '</div>');
                if (chgRows.length) html.push('<div style="margin-top:8px;"><b>✏️ 改动明细（前 ' + Math.min(chgRows.length, 60) + ' 条）</b>' + chgRows.slice(0, 60).join('') + '</div>');
                if (warnRows.length) html.push('<div style="margin-top:8px;color:#b45309;"><b>⚠️ 已被拦下的越界改动（字段已回退为原文）</b>' + warnRows.slice(0, 30).join('') + '</div>');
                if (noteRows.length) html.push('<div style="margin-top:8px;color:#0369a1;"><b>🔎 改动较大，建议过一眼</b>' + noteRows.slice(0, 30).join('') + '</div>');
                html.push('<div style="margin-top:10px;display:flex;gap:8px;flex-wrap:wrap;">'
                    + '<button class="btn btn-secondary btn-small" onclick="diaryAiUndoAiFix()">↩️ 撤销本次修改</button>'
                    + '<button class="btn btn-secondary btn-small" onclick="document.getElementById(\'diary-ai-fix-panel\').style.display=\'none\'">关闭</button>'
                    + '</div>');
                diaryAiPanel(html.join(''));
                var undoBtn = document.getElementById('diary-ai-undo-btn');
                if (undoBtn && (stats.changed || stats.skipped || stats.suggestions)) undoBtn.style.display = '';
            }
            window.diaryAiAdoptRule = function (date, issueIdx, key) {
                var txt = _diaryAiSuggests[key];
                if (!txt) { alert('候选内容已过期，请重新运行一次。'); return; }
                var i = diaries.findIndex(function (d) { return d.date === date; });
                if (i === -1) return;
                var d = diaries[i];
                var regs = (d.regulations || []).slice();
                while (regs.length < (d.issues || []).length) regs.push('');
                if (String(regs[issueIdx] || '').trim()) { alert('该条问题已有规章依据，未覆盖。'); return; }
                regs[issueIdx] = txt;
                d.regulations = regs;
                diaries[i] = d;
                saveDiaries();
                // 正在编辑同一天 → 同步对应输入框
                var regEl = document.getElementById('diary-regulation-' + issueIdx);
                if (regEl && document.getElementById('diary-date') && document.getElementById('diary-date').value === date) {
                    regEl.value = txt;
                    if (typeof autoResize === 'function') autoResize(regEl);
                }
                // 回执里把该条问题的整组候选标成"已采纳"（并记住用户选的是哪一条），再原地重渲染
                if (_diaryAiLastReport) {
                    (_diaryAiLastReport.details || []).forEach(function (dd) {
                        if (dd.date !== date) return;
                        (dd.suggests || []).forEach(function (s) {
                            if (s.i !== issueIdx) return;
                            s.adopted = true;
                            if (s.text === txt) s.chosen = true;
                        });
                    });
                    diaryAiReport(_diaryAiLastReport.kind, _diaryAiLastReport.stats, _diaryAiLastReport.details, _diaryAiLastReport.ms);
                }
                diaryAiRefreshViews();
                diaryAiToast('✅ 已写入规章依据：' + escapeHtml(String(txt).slice(0, 42)) + (String(txt).length > 42 ? '…' : ''), { ms: 3000 });
            };
            window.diaryAiUndoAiFix = function () {
                var bk = null;
                try { bk = JSON.parse(localStorage.getItem(DIARY_AI_BK_K) || 'null'); } catch (e) { bk = null; }
                if (!bk || !Array.isArray(bk.items) || !bk.items.length) { alert('没有可撤销的 AI 修改记录。'); return; }
                if (!confirm('撤销上一次 AI 修改（' + bk.items.length + ' 条，' + new Date(bk.ts).toLocaleString() + '）？')) return;
                bk.items.forEach(function (it) {
                    var i = diaries.findIndex(function (d) { return d.date === it.date; });
                    var clone = JSON.parse(JSON.stringify(it));
                    if (i === -1) { diaries.push(clone); return; }     // 期间被删掉的记录也一并恢复
                    diaries[i] = clone;
                });
                saveDiaries();
                updateDiaryCount();
                try { localStorage.removeItem(DIARY_AI_BK_K); } catch (e) {}
                var undoBtn = document.getElementById('diary-ai-undo-btn');
                if (undoBtn) undoBtn.style.display = 'none';
                diaryAiRefreshViews();
                diaryAiPanel('<div>↩️ 已撤销上一次 AI 修改，恢复 ' + bk.items.length + ' 条原文。</div>');
            };

            window.clearAllDiaries = function() {
                if (!confirm('⚠️ 确定清空所有工作日志吗？此操作不可恢复！')) return;
                diaries = [];
                saveDiaries();
                alert('已清空所有工作日志');
            };
        })();
