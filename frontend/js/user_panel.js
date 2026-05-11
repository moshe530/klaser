// ═══════════════════════════════════════════════════════════════════════════
// User Panel + Bell Notifications
// ───────────────────────────────────────────────────────────────────────────
// Self-contained module that powers:
//   • The avatar badge in the topbar + account panel (profile, plan, usage,
//     preferences, logout). Reads/writes to Supabase via KlaserAuth.
//   • The bell button + alerts panel, which surfaces expired/expiring docs
//     and active reminders. Each alert can be marked "handled" (hidden
//     permanently) or "handle later" (moved into a pending sub-list).
// ═══════════════════════════════════════════════════════════════════════════

// ─── Local state (survives reloads via localStorage) ───────────────────────
const ALERTS_HANDLED_KEY = 'klaser_alerts_handled';
const ALERTS_PENDING_KEY = 'klaser_alerts_pending';
const AVATAR_COLOR_KEY = 'klaser_avatar_color';

// Palette shown in the avatar-color picker. IDs must be stable (stored).
const AVATAR_COLORS = [
  '#7C3AED', '#2563EB', '#0EA5E9', '#0D9488', '#16A34A',
  '#D97706', '#DC2626', '#DB2777', '#4B5563', '#1A4A9E',
];

function _readSet(key) {
  try { return new Set(JSON.parse(localStorage.getItem(key) || '[]')); }
  catch { return new Set(); }
}
function _writeSet(key, set) {
  localStorage.setItem(key, JSON.stringify([...set]));
}
function getHandledAlerts() { return _readSet(ALERTS_HANDLED_KEY); }
function getPendingAlerts() { return _readSet(ALERTS_PENDING_KEY); }
function markAlertHandled(id) {
  const h = getHandledAlerts(); h.add(id); _writeSet(ALERTS_HANDLED_KEY, h);
  const p = getPendingAlerts(); if (p.delete(id)) _writeSet(ALERTS_PENDING_KEY, p);
  renderBell();
}
function markAlertPending(id) {
  const p = getPendingAlerts(); p.add(id); _writeSet(ALERTS_PENDING_KEY, p);
  renderBell();
}
function getAvatarColor() {
  return localStorage.getItem(AVATAR_COLOR_KEY) || AVATAR_COLORS[0];
}
function setAvatarColor(c) {
  localStorage.setItem(AVATAR_COLOR_KEY, c);
  applyAvatarColor();
}

// ─── Avatar rendering ──────────────────────────────────────────────────────
function _avatarLetter() {
  const user = window.KlaserAuth && KlaserAuth.getUser();
  if (!user) return '?';
  const md = user.user_metadata || {};
  const name = md.full_name || md.name || user.email || '';
  const first = name.trim().charAt(0);
  return first ? first.toUpperCase() : (user.email || '?').charAt(0).toUpperCase();
}
function applyAvatarColor() {
  const c = getAvatarColor();
  const small = document.getElementById('avatarCircle');
  const big = document.getElementById('upAvatarLg');
  if (small) { small.style.background = c; small.textContent = _avatarLetter(); }
  if (big) { big.style.background = c; big.textContent = _avatarLetter(); }
}

// ─── Alerts: aggregate from docs + reminders ───────────────────────────────
// Each alert is `{ id, title, date, dateLabel, severity, kind, docId }`.
// id must be stable across reloads (doc:<id>:expiry, rem:<id>).
function _gatherAlerts() {
  const out = [];
  const now = new Date();
  const in30 = new Date(Date.now() + 30 * 86400000);
  // From docs — expired or expiring-soon via warranty_end.
  if (Array.isArray(window.docs)) {
    for (const d of docs) {
      if (!d.exp) continue;
      const exp = new Date(d.exp);
      if (isNaN(exp.getTime())) continue;
      if (exp < now) {
        out.push({
          id: `doc:${d.id}:exp`,
          title: `${d.name} — פג תוקף`,
          date: exp, dateLabel: d.exp,
          severity: 'red', kind: 'expired', docId: d.id,
        });
      } else if (exp <= in30) {
        const days = Math.ceil((exp - now) / 86400000);
        out.push({
          id: `doc:${d.id}:exp`,
          title: `${d.name} — פוג בעוד ${days} ימים`,
          date: exp, dateLabel: d.exp,
          severity: 'yellow', kind: 'expiring', docId: d.id,
        });
      }
    }
  }
  // From reminders — active + in the future (or past but not yet handled).
  if (Array.isArray(window.reminders)) {
    for (const r of reminders) {
      if (!r.remind_at || r.status === 'done' || r.status === 'archived') continue;
      const when = new Date(r.remind_at);
      if (isNaN(when.getTime())) continue;
      const past = when < now;
      out.push({
        id: `rem:${r.id}`,
        title: r.name || 'תזכורת',
        date: when,
        dateLabel: when.toISOString().slice(0, 10),
        severity: past ? 'red' : 'blue',
        kind: past ? 'overdue' : 'reminder',
      });
    }
  }
  // Sort: earliest first.
  out.sort((a, b) => a.date - b.date);
  return out;
}

function _getActiveAlerts() {
  const handled = getHandledAlerts();
  return _gatherAlerts().filter(a => !handled.has(a.id));
}

// Compute bell-dot color: red (any expired/overdue), yellow (any active
// non-pending), or green (nothing actionable — pending still counts as none).
function _bellSeverity() {
  const pending = getPendingAlerts();
  const active = _getActiveAlerts().filter(a => !pending.has(a.id));
  if (active.some(a => a.severity === 'red')) return 'red';
  if (active.length > 0) return 'yellow';
  return 'green';
}

function renderBell() {
  const dot = document.getElementById('bellDot');
  if (dot) {
    dot.classList.remove('green', 'yellow', 'red');
    dot.classList.add(_bellSeverity());
  }
  // Re-render the panel if open.
  const panel = document.getElementById('bellPanel');
  if (panel) renderBellPanel(panel);
}

function renderBellPanel(panel) {
  const pending = getPendingAlerts();
  const alerts = _getActiveAlerts();
  const active = alerts.filter(a => !pending.has(a.id));
  const later = alerts.filter(a => pending.has(a.id));
  const alertHtml = (a) => `
    <div class="alert-item severity-${a.severity} ${pending.has(a.id) ? 'is-pending' : ''}" data-id="${a.id}" data-doc-id="${a.docId || ''}">
      <div class="alert-title">${_escHtml(a.title)}</div>
      <div class="alert-meta">📅 ${a.dateLabel}</div>
      <div class="alert-actions">
        <button class="alert-btn primary" data-act="handled">✓ טופל</button>
        ${pending.has(a.id)
          ? `<button class="alert-btn" data-act="unpending">↩ החזר לפעילים</button>`
          : `<button class="alert-btn warning" data-act="pending">⏰ לטיפול בהמשך</button>`}
      </div>
    </div>`;
  const sections = [];
  sections.push(`<div class="bell-panel-head"><h3>התראות</h3>
    <button class="alert-btn" onclick="closeBell()" style="flex:0;padding:4px 10px;">סגור</button></div>`);
  sections.push('<div class="bell-panel-sections">');
  if (active.length === 0 && later.length === 0) {
    sections.push(`<div class="bell-empty">אין התראות פעילות 🎉</div>`);
  } else {
    if (active.length) {
      sections.push(`<div class="bell-section-title">פעילות (${active.length})</div>`);
      sections.push(active.map(alertHtml).join(''));
    }
    if (later.length) {
      sections.push(`<div class="bell-section-title">לטיפול בהמשך (${later.length})</div>`);
      sections.push(later.map(alertHtml).join(''));
    }
  }
  sections.push('</div>');
  panel.innerHTML = sections.join('');
}

function _escHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ─── Bell open/close ───────────────────────────────────────────────────────
function toggleBell(e) {
  if (e) e.stopPropagation();
  const existing = document.getElementById('bellPanel');
  if (existing) { existing.remove(); return; }
  closeUserPanel();
  const panel = document.createElement('div');
  panel.id = 'bellPanel';
  panel.className = 'bell-panel';
  document.body.appendChild(panel);
  renderBellPanel(panel);
  panel.addEventListener('click', _onBellPanelClick);
  setTimeout(() => document.addEventListener('click', _docClickBell), 0);
}
function closeBell() {
  const p = document.getElementById('bellPanel');
  if (p) p.remove();
  document.removeEventListener('click', _docClickBell);
}
function _docClickBell(e) {
  const p = document.getElementById('bellPanel');
  const btn = document.getElementById('bellBtn');
  if (!p) return;
  if (p.contains(e.target) || (btn && btn.contains(e.target))) return;
  closeBell();
}
function _onBellPanelClick(e) {
  const btn = e.target.closest('.alert-btn[data-act]');
  if (!btn) return;
  const item = btn.closest('.alert-item');
  if (!item) return;
  const id = item.dataset.id;
  const act = btn.dataset.act;
  if (act === 'handled') markAlertHandled(id);
  else if (act === 'pending') markAlertPending(id);
  else if (act === 'unpending') {
    const p = getPendingAlerts();
    if (p.delete(id)) _writeSet(ALERTS_PENDING_KEY, p);
    renderBell();
  }
}

// ─── User Panel ────────────────────────────────────────────────────────────
function toggleUserPanel(e) {
  if (e) e.stopPropagation();
  const existing = document.getElementById('userPanel');
  if (existing) { existing.remove(); return; }
  closeBell();
  const panel = document.createElement('div');
  panel.id = 'userPanel';
  panel.className = 'user-panel';
  document.body.appendChild(panel);
  renderUserPanel(panel);
  setTimeout(() => document.addEventListener('click', _docClickUser), 0);
}
function closeUserPanel() {
  const p = document.getElementById('userPanel');
  if (p) p.remove();
  document.removeEventListener('click', _docClickUser);
}
function _docClickUser(e) {
  const p = document.getElementById('userPanel');
  const btn = document.getElementById('avatarBtn');
  if (!p) return;
  if (p.contains(e.target) || (btn && btn.contains(e.target))) return;
  closeUserPanel();
}

function renderUserPanel(panel) {
  const user = window.KlaserAuth && KlaserAuth.getUser();
  const md = (user && user.user_metadata) || {};
  const email = (user && user.email) || '';
  const fullName = md.full_name || md.name || '';
  const phone = md.phone || '';
  const color = getAvatarColor();
  const accountType = (typeof getAccountType === 'function' ? getAccountType() : 'personal');
  const accountLabel = accountType === 'business' ? 'עסקי' : 'אישי / משפחה';
  const timeout = (typeof getUserSettings === 'function') ? (getUserSettings().aiSuggestionTimeout || 0) : 0;
  const defaultAction = (typeof getUserSettings === 'function' && getUserSettings().aiSuggestionDefault === 'pending') ? 'pending' : 'accept';
  const darkOn = (localStorage.getItem('klaser_dark_mode') === '1');

  const colorsHtml = AVATAR_COLORS.map(c => `
    <span class="up-color ${c === color ? 'active' : ''}" style="background:${c}" data-color="${c}" title="${c}"></span>
  `).join('');

  panel.innerHTML = `
    <div class="up-head">
      <div class="up-avatar-lg" id="upAvatarLg" style="background:${color}">${_avatarLetter()}</div>
      <div class="up-name">${_escHtml(fullName || email.split('@')[0] || 'משתמש')}</div>
      <div class="up-email">${_escHtml(email)}</div>
    </div>

    <div class="up-section">
      <div class="up-section-title">תוכנית ושימוש</div>
      <div id="upUsage" style="font-size:12px;color:var(--text3);text-align:center;padding:14px 0;">טוען נתונים...</div>
    </div>

    <div class="up-section">
      <div class="up-section-title">פרטי משתמש</div>
      <div class="up-field"><label>שם מלא</label><input type="text" id="up-fullname" value="${_escHtml(fullName)}" /></div>
      <div class="up-field"><label>אימייל (לא ניתן לשינוי)</label><input type="email" value="${_escHtml(email)}" disabled /></div>
      <div class="up-field"><label>טלפון</label><input type="tel" id="up-phone" value="${_escHtml(phone)}" /></div>
      <div class="up-field">
        <label>צבע תגית</label>
        <div class="up-colors" id="upColors">${colorsHtml}</div>
      </div>
      <div style="display:flex;gap:8px;margin-top:10px;">
        <button class="up-btn primary" onclick="saveUserProfile()">שמור פרטים</button>
      </div>
    </div>

    <div class="up-section">
      <div class="up-section-title">העדפות תצוגה</div>
      <div class="up-row">
        <div class="label">מצב כהה</div>
        <div class="toggle ${darkOn ? 'on' : ''}" id="up-dark-toggle" onclick="toggleDarkMode(this)"></div>
      </div>
      <div class="up-field" style="margin-top:10px;">
        <label>זמן בחירה אוטומטית להצעות AI (שניות, 0 = כבוי)</label>
        <input type="number" min="0" max="120" id="up-ai-timeout" value="${timeout}" />
      </div>
      <div class="up-field">
        <label>ברירת מחדל בסוף הספירה</label>
        <select id="up-ai-default">
          <option value="accept" ${defaultAction === 'accept' ? 'selected' : ''}>קבל הצעת AI</option>
          <option value="pending" ${defaultAction === 'pending' ? 'selected' : ''}>השאר למיון בהמשך</option>
        </select>
      </div>
      <button class="up-btn secondary" onclick="saveUserPreferences()">שמור העדפות</button>
    </div>

    <div class="up-section">
      <div class="up-section-title">חשבון</div>
      <div class="up-row"><div class="label">סוג חשבון</div><div class="value">${accountLabel}</div></div>
      <div style="display:flex;gap:8px;margin-top:10px;">
        <button class="up-btn secondary" onclick="showTab('settings',document.querySelectorAll('.topnav-tab')[4]);closeUserPanel();setTab('privacy',document.querySelector('#settingsTabs .st-tab:nth-child(4)'));">החלף סיסמה</button>
        <button class="up-btn danger" onclick="doLogout()">התנתק</button>
      </div>
    </div>
  `;

  // Wire color swatches.
  panel.querySelectorAll('#upColors .up-color').forEach(el => {
    el.addEventListener('click', () => {
      panel.querySelectorAll('#upColors .up-color').forEach(c => c.classList.remove('active'));
      el.classList.add('active');
      setAvatarColor(el.dataset.color);
    });
  });

  // Kick off async usage load.
  _loadAndRenderUsage();
}

// Fetches plan + usage from the API and renders a progress bar + counters.
async function _loadAndRenderUsage() {
  const host = document.getElementById('upUsage');
  if (!host) return;
  try {
    const data = await KlaserAPI.getAccountUsage();
    const mbUsed = (data.storage_bytes / (1024 * 1024));
    const mbLimit = (data.storage_limit_bytes / (1024 * 1024));
    const storagePct = mbLimit > 0 ? Math.min(100, (mbUsed / mbLimit) * 100) : 0;
    const docsPct = data.docs_limit > 0 ? Math.min(100, (data.docs_count / data.docs_limit) * 100) : 0;
    const storageCls = storagePct >= 90 ? 'danger' : storagePct >= 70 ? 'warn' : '';
    const docsCls = docsPct >= 90 ? 'danger' : docsPct >= 70 ? 'warn' : '';
    host.innerHTML = `
      <div class="up-row"><div class="label">תוכנית נוכחית</div><div class="value">${_escHtml(data.plan.label)}</div></div>
      <div style="margin-top:12px;">
        <div class="up-row" style="padding:2px 0;"><div class="label">מסמכים</div><div class="value">${data.docs_count} / ${data.docs_limit}</div></div>
        <div class="progress-bar"><div class="progress-fill ${docsCls}" style="width:${docsPct.toFixed(1)}%"></div></div>
      </div>
      <div style="margin-top:12px;">
        <div class="up-row" style="padding:2px 0;"><div class="label">זיכרון בשימוש</div><div class="value">${mbUsed.toFixed(1)} / ${mbLimit.toFixed(0)} MB</div></div>
        <div class="progress-bar"><div class="progress-fill ${storageCls}" style="width:${storagePct.toFixed(1)}%"></div></div>
      </div>
    `;
  } catch (e) {
    console.error('usage load failed', e);
    host.innerHTML = `<div style="color:var(--red)">שגיאה בטעינת נתוני שימוש</div>`;
  }
}

// ─── Save profile (name + phone into Supabase user_metadata) ──────────────
async function saveUserProfile() {
  const nameEl = document.getElementById('up-fullname');
  const phoneEl = document.getElementById('up-phone');
  if (!nameEl || !phoneEl) return;
  try {
    await KlaserAuth.updateUserMetadata({
      full_name: nameEl.value.trim() || null,
      phone: phoneEl.value.trim() || null,
    });
    applyAvatarColor(); // letter may have changed
    if (typeof showToast === 'function') showToast('פרטים נשמרו');
    else alert('הפרטים נשמרו');
  } catch (e) {
    alert('שגיאה בשמירה:\n' + (e.message || e));
  }
}

// ─── Save preferences (dark mode + AI timeout) ────────────────────────────
function saveUserPreferences() {
  const tEl = document.getElementById('up-ai-timeout');
  const dEl = document.getElementById('up-ai-default');
  if (tEl && dEl && typeof setUserSetting === 'function') {
    const sec = Math.max(0, Math.min(120, Math.round(Number(tEl.value) || 0)));
    setUserSetting('aiSuggestionTimeout', sec);
    setUserSetting('aiSuggestionDefault', dEl.value === 'pending' ? 'pending' : 'accept');
  }
  if (typeof showToast === 'function') showToast('ההעדפות נשמרו');
  else alert('ההעדפות נשמרו');
}

// Toggle dark mode from the panel. Persists to localStorage and applies class.
function toggleDarkMode(toggleEl) {
  if (!toggleEl) return;
  toggleEl.classList.toggle('on');
  const on = toggleEl.classList.contains('on');
  localStorage.setItem('klaser_dark_mode', on ? '1' : '0');
  document.body.classList.toggle('dark-mode', on);
}

// ─── Password change (Privacy tab) ─────────────────────────────────────────
async function changePassword() {
  const cur = document.getElementById('pw-current');
  const neu = document.getElementById('pw-new');
  const conf = document.getElementById('pw-confirm');
  const msg = document.getElementById('pw-msg');
  if (!cur || !neu || !conf || !msg) return;
  msg.style.color = 'var(--red)';
  msg.textContent = '';
  const current = cur.value;
  const next = neu.value;
  const confirm = conf.value;
  if (!current || !next) { msg.textContent = 'נא למלא את כל השדות'; return; }
  if (next.length < 8)   { msg.textContent = 'הסיסמה חייבת להיות באורך 8 תווים לפחות'; return; }
  if (next !== confirm)  { msg.textContent = 'הסיסמה החדשה והאימות אינם תואמים'; return; }
  const user = KlaserAuth.getUser();
  if (!user || !user.email) { msg.textContent = 'לא מחובר'; return; }
  try {
    // 1) Re-auth with current password to verify it's correct.
    await KlaserAuth.signIn(user.email, current);
    // 2) Update to the new password.
    await KlaserAuth.updatePassword(next);
    cur.value = neu.value = conf.value = '';
    msg.style.color = '#10B981';
    msg.textContent = '✓ הסיסמה הוחלפה בהצלחה';
  } catch (e) {
    msg.style.color = 'var(--red)';
    const m = (e && e.message) || '';
    if (/invalid login|invalid credentials|incorrect/i.test(m)) {
      msg.textContent = 'הסיסמה הנוכחית שגויה';
    } else {
      msg.textContent = 'שגיאה בהחלפת הסיסמה: ' + m;
    }
  }
}

// ─── Wiring on auth state change ───────────────────────────────────────────
// Hook into whatever auth-ready signal exists; updateAuthUI() in app.js is
// called after login and we augment its behaviour by showing/hiding the
// bell + avatar buttons.
function refreshTopbarForAuth() {
  const logged = !!(window.KlaserAuth && KlaserAuth.getUser());
  const bell = document.getElementById('bellBtn');
  const ava = document.getElementById('avatarBtn');
  if (bell) bell.style.display = logged ? '' : 'none';
  if (ava) ava.style.display = logged ? '' : 'none';
  if (logged) { applyAvatarColor(); renderBell(); }
}

// Apply dark mode on load if the user had it on before.
function applyDarkModeOnLoad() {
  if (localStorage.getItem('klaser_dark_mode') === '1') {
    document.body.classList.add('dark-mode');
  }
}

// Expose helpers that other scripts in the page expect.
window.toggleBell = toggleBell;
window.closeBell = closeBell;
window.toggleUserPanel = toggleUserPanel;
window.closeUserPanel = closeUserPanel;
window.saveUserProfile = saveUserProfile;
window.saveUserPreferences = saveUserPreferences;
window.changePassword = changePassword;
window.toggleDarkMode = toggleDarkMode;
window.refreshTopbarForAuth = refreshTopbarForAuth;
window.applyDarkModeOnLoad = applyDarkModeOnLoad;
window.renderBell = renderBell;

document.addEventListener('DOMContentLoaded', applyDarkModeOnLoad);
