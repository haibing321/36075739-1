// 来源：C:/Users/asus/Desktop/index.html 第5911-6815行 | 工作写实模块

        // ========== 工作写实模块 ==========
        (function() {
            const STORAGE_KEY = 'railway_work_diary_v2';
            let diaries = [];
            let issueCount = 0;
            const MAX_ISSUES = 20;
            let diaryFilterMode = 'today';
            let isEditMode = false; // 标记是否为编辑模式
            let currentEditDate = null; // 记录编辑时的原始日期

            // 本地日期字符串（避免 toISOString 的 UTC 时区错位：东8区凌晨会取到昨天）
            function getLocalDateStr(d) {
                return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
            }

            function loadDiaries() { try { const data = localStorage.getItem(STORAGE_KEY); if (data) { diaries = JSON.parse(data); diaries.forEach(d => { if (!d.regulations) d.regulations = []; if (d.issues && d.issues.length > d.regulations.length) { while (d.regulations.length < d.issues.length) d.regulations.push(''); } }); } } catch (e) { diaries = []; } }
            function saveDiaries() { try { localStorage.setItem(STORAGE_KEY, JSON.stringify(diaries)); } catch (e) { alert('保存失败：' + e.message); } }

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
                        <button class="btn btn-small btn-secondary" onclick="copyIssueWithRegulation(${index}, this)" style="white-space:nowrap; padding:4px 10px; flex-shrink:0;" title="复制问题及规章依据">📋 复制</button>
                        ${index > 0 ? '<button class="btn-remove-issue" onclick="removeIssueField(' + index + ')">×</button>' : ''}
                    </div>
                    <div style="display:flex; gap:6px; align-items:flex-start; margin-top:4px;">
                        <textarea class="diary-regulation-input" id="diary-regulation-${index}" placeholder="规章依据" rows="2" oninput="autoResize(this);diaryAutoSave()" style="flex:1; padding:6px 10px; border:1px solid var(--border); border-radius:6px; font-size:0.85rem; resize:vertical; font-family:inherit; background:#f8fafc;">${escapeHtml(regulation)}</textarea>
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
            window.addIssueToDiary = function(content, regulation, date) {
                if (!content || !content.trim()) return;
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
                        return;
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
            };

            window.saveDiary = async function(opts) {
                var noToast = opts && opts.noToast;
                const date = document.getElementById('diary-date').value;
                const work = document.getElementById('diary-work').value.trim();
                if (!date) { alert('请选择日期'); return; }
                if (!work && collectIssues().filter(i => i).length === 0) { alert('请输入工作内容或问题'); return; }
                const { issues, regulations } = collectIssuesAndRegulations();

                // 保存媒体文件到 IndexedDB（新文件存入，旧文件复用 ID）
                const mediaIds = [];
                if (_mediaFiles && _mediaFiles.length > 0) {
                    for (let i = 0; i < _mediaFiles.length; i++) {
                        if (_existingMediaIds[i] !== undefined) {
                            // 已有媒体，复用旧 ID
                            mediaIds.push(_existingMediaIds[i]);
                        } else {
                            // 新文件，存入 IndexedDB
                            const capTime = _mediaCaptureTimes[i] || '';
                            const id = await saveMediaToDB(_mediaFiles[i], capTime);
                            if (id !== null) mediaIds.push(id);
                        }
                    }
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
            // 复制输入框中的工作内容
            window.copyWorkContent = function() {
                const work = document.getElementById('diary-work').value.trim();
                if (!work) { alert('没有工作内容可复制'); return; }
                const btnEl = document.querySelector('.diary-section:first-of-type .diary-copy-work-btn');
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
            window.copyAllToday = function(btnEl) {
                const work = document.getElementById('diary-work').value.trim();
                const { issues, regulations } = collectIssuesAndRegulations();
                const hasContent = work || issues.some(i => i);
                if (!hasContent) { alert('没有可复制的内容'); return; }
                let text = '';
                if (work) text += work;
                issues.forEach((issue, idx) => {
                    if (!issue) return;
                    if (text) text += '\n';
                    text += issue;
                    if (regulations[idx]) text += '\n' + regulations[idx];
                });
                _doCopy(text, btnEl, '已复制 ✓');
            };
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

            // 更新记录数显示
            function updateDiaryCount() {
                document.getElementById('diary-count').textContent = diaries.length + ' 条';
            }

            // 生成单条日记卡片 HTML（供今日记录与搜索结果共用）
            function buildDiaryCardHtml(diary) {
                const dateObj = new Date(diary.date);
                const weekDay = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][dateObj.getDay()];
                const dateStr = (dateObj.getMonth() + 1) + '月' + dateObj.getDate() + '日 ' + weekDay;

                let html = '<div class="diary-card">';
                html += '<div class="diary-card-header"><div class="diary-card-date">' + dateStr + '</div><div class="diary-card-actions"><button class="btn btn-info btn-small" onclick="editDiary(\'' + diary.date + '\')">编辑</button><button class="btn btn-danger btn-small" onclick="deleteDiary(\'' + diary.date + '\')">删除</button></div></div>';
                html += '<div class="diary-work-block"><div class="diary-work-header"><span class="diary-work-title">📋 工作内容</span><button class="btn btn-small btn-secondary" onclick="copyDiaryWork(\'' + diary.date + '\', this)">复制</button></div><div class="diary-work-content">' + escapeHtml(diary.work) + '</div></div>';

                if (diary.issues && diary.issues.length > 0) {
                    html += '<div class="diary-issues-block"><div class="diary-issues-header"><span class="diary-issues-title">⚠️ 发现问题 (' + diary.issues.length + '条)</span></div>';
                    diary.issues.forEach((issue, idx) => {
                        html += '<div class="diary-issue-item"><div class="diary-issue-item-num">' + (idx + 1) + '</div><div class="diary-issue-item-content">' + escapeHtml(issue) + '</div><div class="diary-issue-item-actions"><button class="btn btn-small btn-secondary" onclick="copyDiaryIssue(\'' + diary.date + '\', ' + idx + ', this)">复制</button><button class="btn btn-small btn-danger" onclick="deleteIssue(\'' + diary.date + '\', ' + idx + ')">删除</button></div></div>';
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
            window.diarySearch = function(keyword) {
                const container = document.getElementById('diary-records-list');
                const kw = (keyword || '').trim().toLowerCase();
                if (!kw) { document.getElementById('diary-records-list').innerHTML = ''; return; }
                const matched = diaries.filter(function(d) {
                    if ((d.work || '').toLowerCase().indexOf(kw) !== -1) return true;
                    if (d.issues && d.issues.some(function(x) { return (x || '').toLowerCase().indexOf(kw) !== -1; })) return true;
                    if (d.regulations && d.regulations.some(function(x) { return (x || '').toLowerCase().indexOf(kw) !== -1; })) return true;
                    return false;
                });
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

            // 复制日记中的工作内容
            window.copyDiaryWork = function(date, btnEl) {
                const diary = diaries.find(d => d.date === date);
                if (diary) _doCopy(diary.work, btnEl, '已复制 ✓');
            };

            // 复制日记中的单个问题
            window.copyDiaryIssue = function(date, index, btnEl) {
                const diary = diaries.find(d => d.date === date);
                if (!diary || !diary.issues || !diary.issues[index]) return;
                const problem = diary.issues[index];
                const regulation = (diary.regulations && diary.regulations[index]) ? diary.regulations[index] : '';
                let copyContent = problem;
                if (regulation) copyContent += '\n' + regulation;
                _doCopy(copyContent, btnEl, '已复制 ✓');
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

                html += '<div class="diary-work-block"><div class="diary-work-header"><span class="diary-work-title">📋 工作内容</span><button class="btn btn-small btn-secondary" onclick="copyDiaryWork(\'' + diary.date + '\', this)">复制</button></div><div class="diary-work-content">' + escapeHtml(diary.work) + '</div></div>';

                if (diary.issues && diary.issues.length > 0) {
                    html += '<div class="diary-issues-block"><div class="diary-issues-header"><span class="diary-issues-title">⚠️ 发现问题 (' + diary.issues.length + '条)</span></div>';
                    diary.issues.forEach((issue, idx) => {
                        const regulation = (diary.regulations && diary.regulations[idx]) ? diary.regulations[idx] : '';
                        html += '<div class="diary-issue-item"><div class="diary-issue-item-num">' + (idx + 1) + '</div><div class="diary-issue-item-content">' + escapeHtml(issue);
                        if (regulation) {
                            html += '<div style="margin-top:6px; font-size:0.8rem; color:var(--primary); border-left:2px solid var(--primary); padding-left:8px;"><strong>📜 完整引用句子：</strong>' + escapeHtml(regulation) + '</div>';
                        }
                        html += '</div><div class="diary-issue-item-actions"><button class="btn btn-small btn-secondary" onclick="copyDiaryIssue(\'' + diary.date + '\', ' + idx + ', this)">复制</button><button class="btn btn-small btn-danger" onclick="deleteIssue(\'' + diary.date + '\', ' + idx + ')">删除</button></div></div>';
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
                document.getElementById('diary-input-btn').classList.add('btn-info');
                document.getElementById('diary-input-btn').classList.remove('btn-secondary');
                document.getElementById('diary-history-btn').classList.add('btn-secondary');
                document.getElementById('diary-history-btn').classList.remove('btn-info');
            }

            function showQuery() {
                diaryFilterMode = 'history';
                document.getElementById('diary-input-view').style.display = 'none';
                document.getElementById('diary-history-view').style.display = 'block';
                // 按钮状态
                document.getElementById('diary-input-btn').classList.add('btn-secondary');
                document.getElementById('diary-input-btn').classList.remove('btn-info');
                document.getElementById('diary-history-btn').classList.add('btn-info');
                document.getElementById('diary-history-btn').classList.remove('btn-secondary');
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

            // 打开/关闭多媒体面板
            function toggleMultimediaPanel() {
                const panel = document.getElementById('multimedia-panel');
                const toggleBtn = document.getElementById('btn-multimedia-toggle');
                if (panel.style.display === 'none' || !panel.style.display) {
                    panel.style.display = 'block';
                    toggleBtn.textContent = '❌ 关闭多媒体';
                } else {
                    panel.style.display = 'none';
                    toggleBtn.textContent = '📸 多媒体录入';
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
                document.getElementById('multimedia-panel').style.display = 'none';
                document.getElementById('btn-multimedia-toggle').textContent = '📸 多媒体录入';
            }
            window.closeMultimediaPanel = closeMultimediaPanel;

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
                    await loadScript('https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js');
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

            // 从 ZIP 导入（含媒体重建 ID 映射）
            async function importDiaryFromZip(file) {
                try {
                    await loadScript('https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js');
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
            window.clearAllDiaries = function() {
                if (!confirm('⚠️ 确定清空所有工作日志吗？此操作不可恢复！')) return;
                diaries = [];
                saveDiaries();
                alert('已清空所有工作日志');
            };
        })();
