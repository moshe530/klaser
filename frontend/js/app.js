// ─── DATA (in-memory cache, populated from backend) ───
let docs = [];
let reminders = [];

// ─── USER SETTINGS (persisted in localStorage) ───
const USER_SETTINGS_KEY = 'klaser_user_settings';
function getUserSettings() {
  try { return JSON.parse(localStorage.getItem(USER_SETTINGS_KEY) || '{}'); }
  catch { return {}; }
}
function setUserSetting(key, value) {
  const s = getUserSettings();
  s[key] = value;
  localStorage.setItem(USER_SETTINGS_KEY, JSON.stringify(s));
}
// Returns 0 if disabled, otherwise seconds (>=3)
function getAiSuggestionTimeout() {
  const v = Number(getUserSettings().aiSuggestionTimeout);
  return Number.isFinite(v) && v >= 3 ? v : 0;
}
// 'accept' = auto-apply AI's suggestion, 'pending' = dismiss (leave for manual sort)
function getAiSuggestionDefault() {
  return getUserSettings().aiSuggestionDefault === 'pending' ? 'pending' : 'accept';
}

// Settings tab — read current values into the form fields.
function loadAiSuggestionSettingsForm() {
  const t = document.getElementById('user-ai-suggestion-timeout');
  const d = document.getElementById('user-ai-suggestion-default');
  if (!t || !d) return;
  const s = getUserSettings();
  t.value = Number.isFinite(Number(s.aiSuggestionTimeout)) ? Number(s.aiSuggestionTimeout) : 0;
  d.value = s.aiSuggestionDefault === 'pending' ? 'pending' : 'accept';
}

// Settings tab — persist the form values.
function saveAiSuggestionSettings() {
  const t = document.getElementById('user-ai-suggestion-timeout');
  const d = document.getElementById('user-ai-suggestion-default');
  if (!t || !d) return;
  const sec = Math.max(0, Math.min(120, Math.round(Number(t.value) || 0)));
  setUserSetting('aiSuggestionTimeout', sec);
  setUserSetting('aiSuggestionDefault', d.value === 'pending' ? 'pending' : 'accept');
  if (typeof showToast === 'function') showToast('ההגדרות נשמרו');
  else alert('ההגדרות נשמרו');
}

// ─── Theme (light / dark / auto) ────────────────────────────────────────
// Stored in the existing user-settings blob as `theme` (persisted + synced
// to Supabase via prefs_sync). Values:
//   'light' | 'dark' | 'auto' (default)
// `auto` follows the system preference and updates live.
function getThemePref() {
  const v = getUserSettings().theme;
  return v === 'dark' || v === 'light' ? v : 'auto';
}
function _resolvedTheme(pref) {
  if (pref === 'light' || pref === 'dark') return pref;
  const mq = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)');
  return mq && mq.matches ? 'dark' : 'light';
}
function applyTheme() {
  const pref = getThemePref();
  const resolved = _resolvedTheme(pref);
  document.documentElement.setAttribute('data-theme', resolved);
}
function setThemePref(pref) {
  if (!['light', 'dark', 'auto'].includes(pref)) pref = 'auto';
  setUserSetting('theme', pref);
  applyTheme();
  if (typeof showToast === 'function') showToast(pref === 'auto' ? 'מצב עיצוב: אוטומטי' : pref === 'dark' ? 'מצב כהה הופעל' : 'מצב בהיר הופעל');
}
// Apply saved theme as early as possible so there's no white-flash on
// dark-mode users. Runs at script parse time.
try { applyTheme(); } catch {}
// React to OS theme changes when the user is on 'auto'.
try {
  const mq = window.matchMedia('(prefers-color-scheme: dark)');
  mq.addEventListener && mq.addEventListener('change', () => {
    if (getThemePref() === 'auto') applyTheme();
  });
} catch {}

// Attach a countdown timer + opacity fade to a banner. Calls onExpire when done.
// Returns a cancel() function the banner buttons should call.
function attachBannerCountdown(banner, seconds, onExpire) {
  if (!banner || seconds <= 0) return () => {};
  const counter = document.createElement('div');
  counter.className = 'banner-countdown';
  counter.style.cssText = 'font-size:11px;color:var(--text3);margin-top:6px;text-align:center;';
  banner.appendChild(counter);
  banner.style.transition = `opacity ${seconds}s linear`;
  // Force a reflow so the transition starts.
  void banner.offsetWidth;
  banner.style.opacity = '0.35';
  let remaining = seconds;
  counter.textContent = `⏱ ${remaining}s — בחירה אוטומטית בעוד`;
  const interval = setInterval(() => {
    remaining -= 1;
    if (remaining <= 0) { counter.textContent = '⏱ מבצע...'; return; }
    counter.textContent = `⏱ ${remaining}s — בחירה אוטומטית בעוד`;
  }, 1000);
  const timer = setTimeout(() => {
    clearInterval(interval);
    try { onExpire(); } catch (e) { console.error('banner timeout handler:', e); }
  }, seconds * 1000);
  return () => { clearInterval(interval); clearTimeout(timer); banner.style.opacity = '1'; banner.style.transition = ''; };
}

const REM_TYPE_DOT = {
  birthday: '#EC4899', anniv: '#7C3AED', appt: '#0D9488',
  periodic: '#1A56DB', warranty: '#D97706', other: '#6B7280',
};

const CAT_ICON = {
  'מוצרים':         { bg: '#E1F5EE' },
  'ביטוח':          { bg: '#EDE9FE' },
  'דירה':           { bg: '#FEF3C7' },
  'רכב':            { bg: '#E6F1FB' },
  'מסמכים אישיים':  { bg: '#EEEDFE' },
  'חשמל':           { bg: '#FEF9C3' },
  'גז':             { bg: '#FFE4E6' },
  'מים':            { bg: '#E0F2FE' },
  'תלוש שכר':       { bg: '#F0FDF4' },
  'רפואי':          { bg: '#FEF2F2' },
  'בנק':            { bg: '#FFFBEB' },
  'אשראי':          { bg: '#FDF4FF' },
};

// ─── Invoice branches (sub-categories under "חשבוניות" page) ───
// Built-ins + user-added (saved to localStorage).
const INVOICE_BUILTIN = ['חשמל', 'מים', 'גז'];
const INVOICE_BRANCHES_KEY = 'klaser_invoice_branches';
function getInvoiceBranches() {
  try { return JSON.parse(localStorage.getItem(INVOICE_BRANCHES_KEY) || '[]'); }
  catch { return []; }
}
function setInvoiceBranches(arr) {
  localStorage.setItem(INVOICE_BRANCHES_KEY, JSON.stringify(arr));
}
function allInvoiceCats() {
  const builtin = INVOICE_BUILTIN;
  const custom = getInvoiceBranches();
  console.log('allInvoiceCats: builtin=', builtin, 'custom=', custom);
  return [...builtin, ...custom];
}

// Currently active invoice filter (chip) — used by openAddForBranch
let activeInvoiceFilter = 'הכל';

// ─── BACKEND <-> UI MAPPING ───
// Backend uses snake_case English keys; UI uses short hebrew-ish keys.
function fromApi(d) {
  return {
    id: d.id,
    name: d.name,
    cat: d.category || 'מסמכים אישיים',
    sub: d.sub_category || '',
    buy: d.purchase_date || '',
    exp: d.warranty_end || null,
    note: d.amount != null ? `₪${d.amount}` : '',
    // Family-profile assignment (see migration 005).
    // `assigned_to` keeps the legacy local-only field name used by the
    // family-profiles UI, mapped from the new server-side column. We also
    // expose `person` as the denormalized name, used by the chip filter
    // (`filterByPerson` matches against `data-person`).
    assigned_to: d.assigned_profile_id || null,
    person: d.assigned_profile_name || '',
    // New AI fields
    confidence: d.confidence,
    needs_review: d.needs_review,
    amount_candidates: d.amount_candidates || [],
    amount_labels: d.amount_labels || [],
    merchant: d.merchant,
    document_period: d.document_period,
    document_type: d.document_type,
    doc_type_detected: d.doc_type_detected,
    ocr_quality: d.ocr_quality,
    language: d.language,
    structure: d.structure,
    _raw: d,
  };
}

function toApi(ui) {
  const out = {
    name: ui.name,
    category: ui.cat || null,
    sub_category: ui.sub || null,
    purchase_date: ui.buy || null,
    warranty_end: ui.exp || null,
    amount: ui.amount != null && ui.amount !== '' ? Number(ui.amount) : null,
  };
  // Only include assignment fields if the caller explicitly set them —
  // this lets callers patch (e.g. only `amount`) without clobbering the
  // existing assignment. `null` is a meaningful "clear assignment".
  if (Object.prototype.hasOwnProperty.call(ui, 'assigned_to')) {
    out.assigned_profile_id = ui.assigned_to || null;
    out.assigned_profile_name = ui.person || null;
  }
  return out;
}

// ─── STATUS BADGE ───
function status(exp) {
  if (!exp) return null;
  const d = Math.round((new Date(exp) - new Date()) / 86400000);
  if (d < 0)  return { label: 'פג תוקף', cls: 'expired', urgent: true, expired: true, days: d };
  if (d < 30) return { label: d + ' ימים', cls: 'warn', expiring: true, days: d };
  return { label: 'בתוקף', cls: 'ok', days: d };
}

function makeCard(d) {
  const ic = CAT_ICON[d.cat] || { bg: '#F0EDE6', e: '' };
  const st = status(d.exp);
  const cls = st?.urgent ? 'urgent' : st?.expiring ? 'expiring' : '';
  const tag = st ? `<span class="tag ${st.cls}">${st.label}</span>` : '';
  const dt = d.exp
    ? `<div class="doc-date">עד ${d.exp}</div>`
    : (d.buy ? `<div class="doc-date">${d.buy}</div>` : '');

  // AI fields display
  const aiMeta = [];
  if (d.needs_review) {
    aiMeta.push(`<span class="ai-badge ai-review">צריך בדיקה</span>`);
  }
  if (d.confidence != null) {
    const confColor = d.confidence >= 80 ? '#10B981' : d.confidence >= 60 ? '#F59E0B' : '#EF4444';
    aiMeta.push(`<span class="ai-badge ai-confidence" style="color:${confColor}">${d.confidence}%</span>`);
  }
  if (d.merchant) {
    aiMeta.push(`<span class="ai-badge ai-merchant">${d.merchant}</span>`);
  }
  if (d.document_period) {
    aiMeta.push(`<span class="ai-badge ai-period">${d.document_period}</span>`);
  }
  if (d.document_type) {
    aiMeta.push(`<span class="ai-badge ai-type">${d.document_type}</span>`);
  }

  // Amount candidates picker (if multiple candidates exist)
  let amountDisplay = d.note || '';
  if (d.amount_candidates && d.amount_candidates.length > 1) {
    const options = d.amount_candidates.map((amt, i) => {
      const label = d.amount_labels[i] || `סכום ${i + 1}`;
      return `<option value="${amt}">${label}: ₪${amt}</option>`;
    }).join('');
    amountDisplay = `
      <select class="amount-picker" onchange="selectAmount('${d.id}', this.value)">
        ${options}
      </select>
    `;
  }

  const aiMetaHtml = aiMeta.length ? `<div class="ai-meta">${aiMeta.join('')}</div>` : '';

  // Per-card AI status (optimistic UI)
  let aiStatusHtml = '';
  let stateClass = '';
  if (d._aiStatus === 'processing') {
    aiStatusHtml = `<div class="doc-ai-status processing"><span class="spinner dark"></span>מנותח...</div>`;
    stateClass = 'is-processing';
  } else if (d._aiStatus === 'done') {
    aiStatusHtml = `<div class="doc-ai-status done">✓ נותח בהצלחה</div>`;
  } else if (d._aiStatus === 'failed') {
    aiStatusHtml = `<div class="doc-ai-status failed">⚠️ הניתוח נכשל <button class="doc-ai-retry" data-act="retry">נסה שוב</button></div>`;
    stateClass = 'is-failed';
  }

  // Build the per-column cells matching the table header:
  // [שם המסמך] [קטגוריה] [הוסף] [תוקף] [סטטוס] [פעולות]
  const subTxt = d.sub ? `<span class="sub">${d.sub}</span>` : '';
  const buyTxt = d.buy ? `<div class="doc-date">${d.buy}</div>` : '<div class="doc-date" style="color:var(--text3)">—</div>';
  const expTxt = tag || (d.exp ? `<div class="doc-date">${d.exp}</div>` : '<div class="doc-date" style="color:var(--text3)">—</div>');

  // Status column: AI status badge + needs_review + confidence + AI metas
  const statusBits = [];
  if (aiStatusHtml) statusBits.push(aiStatusHtml);
  if (d.needs_review) statusBits.push(`<span class="ai-badge ai-review">צריך בדיקה</span>`);
  if (d.confidence != null) {
    const confColor = d.confidence >= 80 ? '#10B981' : d.confidence >= 60 ? '#F59E0B' : '#EF4444';
    statusBits.push(`<span class="ai-badge ai-confidence" style="color:${confColor}">${d.confidence}%</span>`);
  }

  return `<div class="doc-card ${cls} ${stateClass}" data-id="${d.id}" data-cat="${d.cat}" data-sub="${d.sub || ''}" data-name="${(d.name || '').toLowerCase()}" data-person="${d.person || ''}">
    <div class="doc-name-cell">
      <div class="doc-icon" style="background:${ic.bg}"></div>
      <div class="doc-info">
        <div class="doc-name">${d.name}</div>
        ${amountDisplay ? `<div class="doc-meta">${amountDisplay}</div>` : ''}
        ${aiMetaHtml}
      </div>
    </div>
    <div><button class="doc-cat-cell" data-act="goto-cat" type="button">${d.cat}${subTxt}</button></div>
    <div>${buyTxt}</div>
    <div>${expTxt}</div>
    <div class="doc-status-cell">${statusBits.join('')}</div>
    <div class="doc-actions">
      <button class="ico-btn" data-act="view" title="הצג"><svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M1.5 8s2-4 6.5-4 6.5 4 6.5 4-2 4-6.5 4S1.5 8 1.5 8z" stroke="currentColor" stroke-width="1.3"/><circle cx="8" cy="8" r="2" stroke="currentColor" stroke-width="1.3"/></svg></button>
      <button class="ico-btn" data-act="edit" title="עריכה"><svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M8.5 1.5l2 2-7 7H1.5v-2l7-7z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/></svg></button>
      <button class="ico-btn danger" data-act="del" title="מחיקה"><svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M3 4h8M5.5 4V3h3v1M6 6.5v4M8 6.5v4M4 4l.5 6.5h5l.5-6.5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg></button>
    </div>
  </div>`;
}

// Navigate to a category from a doc card. Switches to the Documents tab,
// shows the "all" sub-page, and applies a chip filter for the category.
function navigateToCategory(cat) {
  if (!cat) return;
  // Switch to docs tab (topnav-tab[0] is "מסמכים" by convention)
  const docsBtn = document.querySelector('.topnav-tab');
  if (typeof showTab === 'function') showTab('docs', docsBtn);
  // Show the "all" docpage and filter its cards by the category.
  if (typeof sbNav === 'function') sbNav('all', null, 'docs');
  // Activate matching chip in #docFilters if present, otherwise apply manual filter.
  const filters = document.getElementById('docFilters');
  if (filters) {
    const chips = filters.querySelectorAll('.chip');
    chips.forEach(c => c.classList.remove('active'));
    const match = Array.from(chips).find(c => c.textContent.trim() === cat.trim());
    if (match) match.classList.add('active');
    else if (chips[0]) chips[0].classList.add('active');
  }
  const list = document.getElementById('docList');
  if (list) {
    list.querySelectorAll('.doc-card').forEach(c => {
      const ok = (c.dataset.cat === cat) || (c.dataset.sub === cat);
      c.style.display = ok ? '' : 'none';
    });
  }
  // Scroll the first matching card into view for a clear "you landed here" cue.
  const firstCard = list && list.querySelector('.doc-card:not([style*="display: none"])');
  if (firstCard) firstCard.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

function fillList(id, arr) {
  const el = document.getElementById(id);
  if (el) el.innerHTML = arr.map(makeCard).join('') || '<p style="color:var(--text3);text-align:center;padding:32px 0">אין פריטים</p>';
}

// ─── ACCORDION (About page) ───
function toggleAccordion(section) {
  // Don't toggle if click came from inside the body (e.g. a FAQ item)
  if (event && event.target.closest('.accordion-body') && !event.target.closest('.about-section.accordion > h2')) {
    return;
  }
  section.classList.toggle('open');
}

function toggleFaq(e, faqItem) {
  e.stopPropagation();
  // Close other FAQ items in the same group (mutual exclusion)
  const parent = faqItem.parentElement;
  if (parent) {
    parent.querySelectorAll('.faq-item').forEach(item => {
      if (item !== faqItem) item.classList.remove('open');
    });
  }
  faqItem.classList.toggle('open');
}

// Filter by document status (clicking on stats cards)
function filterByStatus(statusFilter) {
  const list = document.getElementById('docList');
  if (!list) return;
  // Make sure we're on docs tab and "all" page
  showTab('docs', document.querySelector('.topnav-tab'));
  sbNav('all', null, 'docs');
  // Clear chip filter
  document.querySelectorAll('#docFilters .chip').forEach(c => c.classList.remove('active'));
  document.querySelector('#docFilters .chip').classList.add('active');
  // Filter cards by status
  list.querySelectorAll('.doc-card').forEach(c => {
    let show = true;
    if (statusFilter === 'soon') show = c.classList.contains('expiring');
    else if (statusFilter === 'expired') show = c.classList.contains('urgent');
    else if (statusFilter === 'valid') show = !c.classList.contains('expiring') && !c.classList.contains('urgent');
    c.style.display = show ? '' : 'none';
  });
}

function renderInvoiceChips() {
  const row = document.getElementById('utilFilter');
  if (!row) {
    console.log('renderInvoiceChips: utilFilter not found');
    return;
  }
  const branches = allInvoiceCats();
  const customBranches = getInvoiceBranches(); // Only user-added branches can be deleted
  console.log('renderInvoiceChips: rendering', branches.length, 'branches');

  // Build chips
  let chipsHtml = `<button class="chip ${activeInvoiceFilter==='הכל'?'active':''}" onclick="filterInvoice('הכל',this)">הכל</button>`;

  branches.forEach(b => {
    const isActive = activeInvoiceFilter === b ? 'active' : '';
    const isCustom = customBranches.includes(b);
    const deleteAttr = isCustom ? ` oncontextmenu="deleteBranch(event, '${b}')"` : '';
    chipsHtml += `<button class="chip ${isActive}" onclick="filterInvoice('${b}',this)"${deleteAttr}>${b}</button>`;
  });

  // Add + button at the end
  chipsHtml += `<button class="chip add-branch" onclick="addBranch()">+</button>`;

  row.innerHTML = chipsHtml;
}

// Delete a branch with right-click
function deleteBranch(e, branchName) {
  e.preventDefault();
  if (!confirm('להסיר את הענף "' + branchName + '"?')) return;

  // Remove from storage
  let branches = getInvoiceBranches();
  branches = branches.filter(b => b !== branchName);
  setInvoiceBranches(branches);

  // Refresh display
  renderInvoiceChips();

  // Reset filter to "all" if the deleted branch was active
  if (activeInvoiceFilter === branchName) {
    activeInvoiceFilter = 'הכל';
    const invCats = allInvoiceCats();
    fillList('utilitiesList', docs.filter(d => invCats.includes(d.cat)));
  } else {
    applyInvoiceFilter();
  }
}

// Category mapping for default 5 tabs: All, Utilities, Work, Personal, Other
// Categories assigned to each default tab:
// - Utilities: חשמל, מים, גז, ארנונה, תקשורת (recurring bills)
// - Work: תלוש שכר, פנסיה, מיסים
// - Personal: מסמכים אישיים
// - Other: everything else (מוצרים, דירה, רפואי, רכב, ביטוח, חינוך, משפטי, אישורים, בנק, אשראי)
const WORK_CATS = new Set(['תלוש שכר', 'פנסיה', 'מיסים']);
const UTILITIES_CATS = new Set(['חשמל', 'מים', 'גז', 'ארנונה', 'תקשורת']);
// Categories that have their own dedicated visible subnav tab in BUSINESS
// mode (`#docsSubnavBusiness`). Used to keep their docs out of "אחר" when
// a business user views the list. The labels here must match what `d.cat`
// will be after AI classification / user edit.
const BUSINESS_TAB_CATS = new Set([
  'עובדים', 'לקוחות', 'ספקים', 'רישיונות', 'ביטוח', 'משפטי',
]);

// Full category to list mapping (for additional tabs that can be added)
const CAT_TO_LIST = {
  'מוצרים':         'productsList',
  'דירה':           'apartmentList',
  'אישורים':        'approvalsList',
  'רפואי':          'medicalList',
  'בנק':            'reportsList',
  'אשראי':          'reportsList',
  'רכב':            'carList',
  'ביטוח':          'insuranceList',
  'חינוך':          'educationList',
  'משפטי':          'legalList',
  'מסמכים אישיים':  'personalList',
  // Business-only pages
  'עובדים':         'employeesList',
  'לקוחות':         'clientsList',
  'ספקים':          'suppliersList',
  'רישיונות':       'licensesList',
};

function renderAll() {
  fillList('docList', docs);
  fillList('alertList', docs.filter(d => { const s = status(d.exp); return s?.urgent || s?.expiring; }));
  // Refresh the bell notifications dot + panel (if open).
  if (typeof renderBell === 'function') renderBell();

  // ── Utilities (חשבוניות): recurring bills
  const invCats = new Set([...allInvoiceCats(), 'תקשורת']);
  fillList('utilitiesList', docs.filter(d => invCats.has(d.cat)));
  renderInvoiceChips();
  applyInvoiceFilter();

  // ── Work: תלוש שכר + פנסיה + מיסים
  fillList('workList', docs.filter(d => WORK_CATS.has(d.cat)));

  // ── Personal: explicit category
  fillList('personalList', docs.filter(d => d.cat === 'מסמכים אישיים'));

  // ── Custom user tabs: filled so they take precedence over "other"
  const customTabNames = new Set();
  getCustomTabs().forEach(tab => {
    customTabNames.add(tab.name);
    const listId = 'list-' + tab.name;
    if (document.getElementById(listId)) {
      fillList(listId, docs.filter(d => d.cat === tab.name));
    }
  });

  // ── Other: everything that doesn't have its own display surface (any
  //   default/built-in category with a docpage, any custom tab, and any
  //   user-registered category). This prevents docs from appearing in both
  //   their proper tab AND the "other" catch-all.
  // A category is "handled" only if it has a *visible navigation surface*:
  //   - Aggregated default tabs (personal mode): חשבוניות, עבודה, אישי
  //   - Dedicated default tabs (business mode): עובדים, לקוחות, ספקים, ...
  //   - Custom tabs added by the user
  // CAT_TO_LIST entries are NOT auto-included here: defaults like חינוך/רכב
  // have list elements in the DOM but no default subnav-tab in PERSONAL mode.
  // Without a tab, they're unreachable — so we let those docs fall into
  // "אחר" until the user explicitly adds a custom tab with that name.
  const isBusiness = (typeof getAccountType === 'function' && getAccountType() === 'business');
  const handledCats = new Set([
    ...invCats,
    ...WORK_CATS,
    'מסמכים אישיים',
    ...(isBusiness ? BUSINESS_TAB_CATS : []),
    ...customTabNames,
  ]);
  fillList('otherList', docs.filter(d => !handledCats.has(d.cat)));

  // ── Additional built-in tabs (if user adds them): route by CAT_TO_LIST
  const buckets = {};
  docs.forEach(d => {
    // Skip docs already absorbed by default tabs or custom tabs
    if (invCats.has(d.cat)) return;
    if (WORK_CATS.has(d.cat)) return;
    if (d.cat === 'מסמכים אישיים') return;
    if (customTabNames.has(d.cat)) return;
    const listId = CAT_TO_LIST[d.cat];
    if (listId) (buckets[listId] = buckets[listId] || []).push(d);
  });
  Object.values(CAT_TO_LIST).forEach(listId => {
    fillList(listId, buckets[listId] || []);
  });

  renderReminders('all');
  renderCal();
  updateStats();
}

function updateStats() {
  const total = docs.length;
  let soon = 0, expired = 0, valid = 0;
  let soonestDoc = null, soonestDays = Infinity;
  docs.forEach(d => {
    const s = status(d.exp);
    if (!s) { valid++; return; }
    if (s.expired) expired++;
    else if (s.urgent || s.expiring) {
      soon++;
      if (typeof s.days === 'number' && s.days >= 0 && s.days < soonestDays) {
        soonestDays = s.days;
        soonestDoc = d;
      }
    }
    else valid++;
  });
  const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
  set('stat-total', total);
  set('stat-soon', soon);
  set('stat-expired', expired);
  set('stat-valid', valid);
  const sub = document.getElementById('docsSubtitle');
  if (sub) {
    const need = soon + expired;
    sub.textContent = total === 0
      ? 'אין מסמכים — הוסף את הראשון'
      : (need > 0 ? `${total} מסמכים · ${need} דורשים תשומת לב` : `${total} מסמכים`);
  }
  const bar = document.getElementById('docsAlertBar');
  const barTxt = document.getElementById('docsAlertText');
  if (bar && barTxt) {
    if (soonestDoc && soonestDays !== Infinity) {
      barTxt.innerHTML = `${soonestDoc.name} — פג בעוד <strong style="margin:0 3px">${soonestDays} יום</strong>`;
      bar.style.display = '';
    } else {
      bar.style.display = 'none';
    }
  }
  // Update sidebar alert badge (soon + expired)
  const alertCount = soon + expired;
  const alertBadge = document.getElementById('alertBadge');
  if (alertBadge) {
    if (alertCount > 0) {
      alertBadge.textContent = alertCount;
      alertBadge.style.display = '';
    } else {
      alertBadge.style.display = 'none';
    }
  }
  // Keep the bell panel (dot color + open-panel stats) in sync with the
  // same numbers we just rendered on the documents page.
  if (typeof renderBell === 'function') renderBell();
  // Refresh the plan-usage hint bar (shows up at ≥70% of plan doc limit).
  refreshPlanUsageBar();
}

// ─── Plan usage hint bar ────────────────────────────────────────────────
// Fetches /api/account/usage and shows a yellow progress bar on the docs
// page when the user is ≥70% of their plan limit. Cached so we don't hit
// the API on every `updateStats` call.
let _planUsageCache = null;
let _planUsageInFlight = null;
function refreshPlanUsageBar(force = false) {
  if (!window.KlaserAPI || !KlaserAPI.getAccountUsage) return;
  if (!force && _planUsageCache && Date.now() - _planUsageCache.at < 60000) {
    _renderPlanUsageBar(_planUsageCache.data);
    return;
  }
  if (_planUsageInFlight) return;
  _planUsageInFlight = KlaserAPI.getAccountUsage()
    .then(data => {
      _planUsageCache = { at: Date.now(), data };
      _renderPlanUsageBar(data);
    })
    .catch(() => { /* silent — no UI on failure */ })
    .finally(() => { _planUsageInFlight = null; });
}
function _renderPlanUsageBar(data) {
  const bar = document.getElementById('planUsageBar');
  const txt = document.getElementById('planUsageText');
  const fill = document.getElementById('planUsageFill');
  if (!bar || !txt || !fill) return;
  const limit = (data && data.docs_limit) || 0;
  const used = (data && data.docs_count) || 0;
  if (!limit) { bar.style.display = 'none'; return; }
  const pct = Math.min(100, Math.round((used / limit) * 100));
  // Only show once we cross the 70% threshold. Hidden otherwise to keep
  // the docs page clean for everyday use.
  if (pct < 70) { bar.style.display = 'none'; return; }
  txt.textContent = `השתמשת ב-${used} מתוך ${limit} מסמכים (${pct}%)`;
  fill.style.width = pct + '%';
  fill.className = 'progress-fill ' + (pct >= 90 ? 'danger' : 'warn');
  bar.style.display = '';
}

// ─── Invoice page filter ───
function filterInvoice(cat, el) {
  activeInvoiceFilter = cat;
  if (el) {
    el.closest('.filter-row').querySelectorAll('.chip').forEach(c => c.classList.remove('active'));
    el.classList.add('active');
  }
  applyInvoiceFilter();
}
function applyInvoiceFilter() {
  const list = document.getElementById('utilitiesList');
  if (!list) return;
  list.querySelectorAll('.doc-card').forEach(c => {
    c.style.display = (activeInvoiceFilter === 'הכל' || c.dataset.cat === activeInvoiceFilter) ? '' : 'none';
  });
}

// ─── SUB-BRANCHES STORAGE ───
const SUB_BRANCHES_KEY = 'klaser_sub_branches';
function getSubBranches(branchName) {
  try {
    const all = JSON.parse(localStorage.getItem(SUB_BRANCHES_KEY) || '{}');
    return all[branchName] || ['+'];
  } catch { return ['+']; }
}
function setSubBranches(branchName, subBranches) {
  try {
    const all = JSON.parse(localStorage.getItem(SUB_BRANCHES_KEY) || '{}');
    all[branchName] = subBranches;
    localStorage.setItem(SUB_BRANCHES_KEY, JSON.stringify(all));
  } catch {}
}

// ─── Add a new invoice branch (sub-category) ───
function addBranch() {
  try {
    console.log('addBranch: started');
    const name = prompt('שם הענף החדש (למשל: ארנונה, אינטרנט):');
    console.log('addBranch: user entered:', name);
    if (!name) return;
    const trimmed = name.trim();
    if (!trimmed) return;
    const branches = getInvoiceBranches();
    console.log('addBranch: current branches:', branches);
    if (branches.includes(trimmed) || INVOICE_BUILTIN.includes(trimmed)) {
      alert('הענף כבר קיים');
      return;
    }
    branches.push(trimmed);
    console.log('addBranch: saving branches:', branches);
    setInvoiceBranches(branches);
    // Auto-add + sub-branch for this new branch
    setSubBranches(trimmed, ['+']);
    // Auto-register icon if missing
    if (!CAT_ICON[trimmed]) CAT_ICON[trimmed] = { bg: '#F0EDE6', e: '' };
    // ALSO register as a proper category (categories.js) so it flows into
    // the edit-modal dropdown and is sent to the AI for classification.
    if (typeof addCategory === 'function') addCategory(trimmed, { source: 'user' });
    console.log('addBranch: calling renderInvoiceChips and refreshCategoryDropdowns');
    renderInvoiceChips();
    refreshCategoryDropdowns();
    // Also refresh the utilities list to include the new category
    console.log('addBranch: refreshing utilitiesList');
    const invCats = allInvoiceCats();
    fillList('utilitiesList', docs.filter(d => invCats.includes(d.cat)));
    applyInvoiceFilter();
    // Check if utilFilter is visible
    const utilFilter = document.getElementById('utilFilter');
    if (!utilFilter || utilFilter.offsetParent === null) {
      alert(`הענף "${trimmed}" נוסף בהצלחה עם תת ענף +. הוא יופיע ברשימת הכפתורים כשתעבור לדף "חשבוניות".`);
    } else {
      alert(`הענף "${trimmed}" נוסף בהצלחה עם תת ענף +.`);
    }
  } catch (e) {
    console.error('addBranch error:', e);
    alert('שגיאה בהוספת ענף: ' + e.message);
  }
}

// Pending preselect the user picked via a tab/chip "+ הוסף" click.
// When set, runAnalyze() will respect this category/sub even if the AI
// disagrees (and offer an inline "switch" suggestion instead of silently
// overriding the user's intent).
let currentAddPreselect = null; // { cat, sub }
// Preselect per created document id — kept until AI returns so we can decide
// whether to lock or propose a switch.
const docPreselects = new Map();

// Open the add-doc modal pre-filled with a category (and optional sub-branch).
// When `cat` is empty/"הכל" the modal opens in "let AI decide" mode. The
// modal is opened FIRST; preselect logic is wrapped in try/catch so a DOM
// edge-case can never block the add flow.
function openAddForTab(cat, sub) {
  // Always open the modal first — failure to apply preselect shouldn't
  // prevent the user from adding a document.
  try { openModal('add'); } catch (e) { console.error('openAddForTab: openModal failed', e); return; }
  currentAddPreselect = null;
  try {
    if (typeof refreshCategoryDropdowns === 'function') refreshCategoryDropdowns();
  } catch (e) { console.warn('refreshCategoryDropdowns failed', e); }
  try {
    const catSel = document.getElementById('fm-cat');
    const subSel = document.getElementById('fm-subcat');
    const realCat = (cat && cat !== 'הכל') ? cat : '';
    // Auto-detect active sub-chip from the currently-visible docpage when
    // the caller didn't pass one explicitly.
    let effectiveSub = (sub && sub !== 'הכל') ? sub : '';
    if (!effectiveSub) {
      const visiblePage = Array.from(document.querySelectorAll('.docpage'))
        .find(p => p && p.offsetParent !== null && p.style.display !== 'none');
      const row = visiblePage ? visiblePage.querySelector('.filter-row') : null;
      if (row && row.dataset && row.dataset.activeSub) effectiveSub = row.dataset.activeSub;
    }
    if (catSel && realCat) {
      catSel.value = realCat;
      if (typeof populateSubcategoryDropdown === 'function' && subSel) {
        populateSubcategoryDropdown(subSel, realCat, effectiveSub || '');
      }
    }
    if (realCat) {
      currentAddPreselect = { cat: realCat, sub: effectiveSub };
    }
    _renderAddPreselectHint();
  } catch (e) {
    console.warn('openAddForTab: preselect apply failed (modal is still open)', e);
  }
}

// Back-compat: legacy call site (invoices branch chip).
function openAddForBranch() {
  const cat = (typeof activeInvoiceFilter !== 'undefined') ? activeInvoiceFilter : '';
  openAddForTab(cat);
}

// Render a small banner inside the add-modal showing the preselected target
// and offering a "שנה / נקה" link so the user can fall back to full AI mode.
function _renderAddPreselectHint() {
  const modal = document.querySelector('#modal-add .modal');
  if (!modal) return;
  let hint = document.getElementById('addPreselectHint');
  if (!currentAddPreselect) { if (hint) hint.remove(); return; }
  if (!hint) {
    hint = document.createElement('div');
    hint.id = 'addPreselectHint';
    hint.style.cssText = 'margin:8px 0 12px;padding:10px 14px;background:#EEF4FF;border:1px solid #BFD6FF;border-radius:10px;font-size:13px;color:#1A4A9E;display:flex;align-items:center;justify-content:space-between;gap:10px;direction:rtl;';
    const head = modal.querySelector('.modal-head');
    if (head && head.nextSibling) modal.insertBefore(hint, head.nextSibling);
    else modal.insertBefore(hint, modal.firstChild);
  }
  const p = currentAddPreselect;
  const subTxt = p.sub ? ` · <strong>${p.sub}</strong>` : '';
  hint.innerHTML = `
    <div>ייווסף ל: <strong>${p.cat}</strong>${subTxt}</div>
    <button type="button" onclick="clearAddPreselect()" style="background:transparent;border:1px solid #BFD6FF;color:#1A4A9E;border-radius:6px;padding:4px 10px;font-size:12px;cursor:pointer;">נקה — תן ל-AI להחליט</button>
  `;
}

function clearAddPreselect() {
  currentAddPreselect = null;
  _renderAddPreselectHint();
  // Keep the currently-visible category choice so the user can still edit
  // it manually if they want a specific category without the "lock".
}

// Non-blocking banner: offered when AI disagrees with the user's preselected
// category. User can accept AI's suggestion (→ updates cat/sub) or dismiss.
function _showAICategorySuggestion(docId, userChoice, aiChoice) {
  // Remove any previous banner.
  const prev = document.getElementById('aiCatSuggestBanner');
  if (prev) prev.remove();
  const el = document.createElement('div');
  el.id = 'aiCatSuggestBanner';
  el.dataset.docId = String(docId);
  el.style.cssText = 'position:fixed;bottom:24px;left:50%;transform:translateX(-50%);background:#fff;border:2px solid #1A4A9E;border-radius:12px;box-shadow:0 12px 32px rgba(0,0,0,0.18);padding:14px 18px;z-index:9999;max-width:460px;direction:rtl;font-size:14px;';
  const aiSubTxt = aiChoice.sub ? ` · ${aiChoice.sub}` : '';
  const userSubTxt = userChoice.sub ? ` · ${userChoice.sub}` : '';
  el.innerHTML = `
    <div style="font-weight:600;margin-bottom:6px;">ה-AI חושב שהמסמך שייך לקטגוריה אחרת</div>
    <div style="font-size:13px;color:#444;margin-bottom:10px;">
      שמרת תחת: <strong>${userChoice.cat}${userSubTxt}</strong><br/>
      ה-AI מציע: <strong>${aiChoice.cat}${aiSubTxt}</strong>
    </div>
    <div style="display:flex;gap:8px;flex-wrap:wrap;">
      <button type="button" class="btn-primary" data-act="accept" style="padding:6px 14px;font-size:13px;">העבר לקטגוריה של ה-AI</button>
      <button type="button" data-act="dismiss" style="padding:6px 14px;font-size:13px;border:1px solid var(--border,#ccc);background:#fff;border-radius:8px;cursor:pointer;">השאר כמו שהגדרתי</button>
    </div>
  `;
  document.body.appendChild(el);

  // Wire buttons (replaces inline onclick so countdown can cancel cleanly).
  const safeCat = String(aiChoice.cat);
  const safeSub = String(aiChoice.sub || '');
  let cancelCountdown = () => {};
  el.querySelector('[data-act="accept"]').onclick = () => { cancelCountdown(); acceptAICategorySuggestion(String(docId), safeCat, safeSub); };
  el.querySelector('[data-act="dismiss"]').onclick = () => { cancelCountdown(); el.remove(); };

  // Optional countdown — auto-decision per user setting.
  const timeout = getAiSuggestionTimeout();
  if (timeout > 0) {
    cancelCountdown = attachBannerCountdown(el, timeout, () => {
      const decision = getAiSuggestionDefault();
      if (decision === 'accept') {
        acceptAICategorySuggestion(String(docId), safeCat, safeSub);
      } else {
        // 'pending' → leave doc as-is (user's preselect), dismiss banner.
        el.remove();
      }
    });
    // Hover pauses the countdown so the user can read.
    el.addEventListener('mouseenter', () => { cancelCountdown(); cancelCountdown = () => {}; });
  } else {
    setTimeout(() => { const b = document.getElementById('aiCatSuggestBanner'); if (b && b.dataset.docId === String(docId)) b.remove(); }, 30000);
  }
}

async function acceptAICategorySuggestion(docId, aiCat, aiSub) {
  const banner = document.getElementById('aiCatSuggestBanner');
  if (banner) banner.remove();
  try {
    // 1. Ensure the AI's category has a real visible tab. If no tab yet,
    //    create one (which also registers the category + sub).
    if (aiCat) {
      const existingTabs = Array.from(document.querySelectorAll('#docsSubnav .subnav-tab:not(.add-branch-tab)'))
        .map(t => t.textContent.trim());
      if (!existingTabs.includes(aiCat) && typeof addNewTabWithData === 'function') {
        try { addNewTabWithData(aiCat, aiSub ? [aiSub] : [], false); }
        catch (e) {
          console.warn('addNewTabWithData failed in acceptAICategorySuggestion', e);
          if (typeof addCategory === 'function') addCategory(aiCat, { source: 'ai' });
          if (aiSub && typeof addSubcategory === 'function') addSubcategory(aiCat, aiSub, { source: 'ai' });
        }
      } else {
        // Tab already exists — just make sure category + subcategory are registered.
        if (typeof addCategory === 'function') addCategory(aiCat, { source: 'ai' });
        if (aiSub && typeof addSubcategory === 'function') addSubcategory(aiCat, aiSub, { source: 'ai' });
      }
    }
    // 3. Move the document to the AI's category on the backend.
    const updated = await KlaserAPI.updateDocument(docId, {
      category: aiCat || null,
      sub_category: aiSub || null,
    });
    const idx = docs.findIndex(d => String(d.id) === String(docId));
    if (idx >= 0) docs[idx] = fromApi(updated);
    renderAll();
  } catch (e) {
    alert('שגיאה בהחלפת קטגוריה:\n' + e.message);
  }
}

// Re-build category <select> options from the dynamic categories store.
// Delegates to renderAllCategoryTabs (single source of truth) when available.
function refreshCategoryDropdowns() {
  if (typeof renderAllCategoryTabs === 'function') {
    renderAllCategoryTabs();
    return;
  }
  // Fallback (categories.js not loaded yet) — minimal static list.
  const fallback = ['מוצרים', 'ביטוח', 'דירה', 'רכב', 'מסמכים אישיים', 'חשמל', 'גז', 'מים', 'תלוש שכר', 'רפואי', 'בנק', 'אשראי', 'אחר'];
  ['fm-cat', 'ed-cat'].forEach(id => {
    const sel = document.getElementById(id);
    if (!sel) return;
    const prev = sel.value;
    sel.innerHTML = fallback.map(v => `<option value="${v}">${v}</option>`).join('');
    if (prev) sel.value = prev;
  });
}

// ─── DATA LOAD FROM BACKEND ───
async function loadDocs() {
  setStatusBadge('טוען...', 'loading');
  try {
    const data = await KlaserAPI.listDocuments();
    docs = data.map(fromApi);
    // Explicitly mirror onto `window` so cross-script consumers (e.g.
    // `user_panel.js` for bell stats) see the latest array. `let` at script
    // scope does NOT auto-attach to window in classic scripts.
    window.docs = docs;
    renderAll();
    setStatusBadge(`מחובר · ${docs.length} מסמכים`, 'ok');
  } catch (e) {
    console.error(e);
    setStatusBadge('שגיאת חיבור לשרת', 'err');
    alert('לא הצלחתי לטעון מסמכים מהשרת.\n' + e.message);
  }
}

// ─── GLOBAL STATUS TOAST ───
// A single floating toast element (#klaserToast) displays loading/ok/err
// messages. Loading states include a spinner and never auto-hide; ok/err
// auto-hide after ~2.5s. Calls are debounced by replacing the content.
let _toastHideTimer = null;
function setStatusBadge(text, cls) {
  const el = document.getElementById('klaserToast');
  if (!el) return;
  clearTimeout(_toastHideTimer);
  const isLoading = cls === 'loading';
  const safe = String(text).replace(/[<>&]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));
  el.innerHTML = (isLoading ? '<span class="spinner"></span>' : '') + `<span>${safe}</span>`;
  el.dataset.state = cls || '';
  el.classList.add('show');
  if (!isLoading) {
    _toastHideTimer = setTimeout(() => el.classList.remove('show'), 2500);
  }
}

function hideStatusBadge() {
  const el = document.getElementById('klaserToast');
  if (el) el.classList.remove('show');
  clearTimeout(_toastHideTimer);
}

// Sets a button into a loading state with a spinner, preserving original text.
function setButtonLoading(btn, loadingText) {
  if (!btn) return;
  if (!btn.dataset.origHtml) btn.dataset.origHtml = btn.innerHTML;
  btn.classList.add('is-loading');
  btn.disabled = true;
  btn.innerHTML = `<span class="spinner"></span><span>${loadingText}</span>`;
}
function clearButtonLoading(btn) {
  if (!btn) return;
  if (btn.dataset.origHtml) btn.innerHTML = btn.dataset.origHtml;
  btn.classList.remove('is-loading');
  btn.disabled = false;
}

// ─── SUBNAV SCROLL ARROWS ───
// Wraps every `.topnav-subnav` in a `.subnav-wrap` and overlays half-
// transparent ‹/› arrow buttons on each edge. Arrows + edge fades are
// shown only when there's hidden content in that direction. Works in both
// LTR and RTL because we use `scrollBy` with relative deltas.
function setupSubnavArrows() {
  document.querySelectorAll('.topnav-subnav').forEach(nav => {
    if (nav.dataset.arrowsInit) return;
    nav.dataset.arrowsInit = '1';

    // Wrap nav in a positioning container (preserve DOM order).
    const wrap = document.createElement('div');
    wrap.className = 'subnav-wrap';
    nav.parentNode.insertBefore(wrap, nav);
    wrap.appendChild(nav);

    const mkArrow = (side, glyph) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'subnav-arrow subnav-arrow-' + side;
      b.innerHTML = glyph;
      b.setAttribute('aria-label', side === 'left' ? 'גלול שמאלה' : 'גלול ימינה');
      b.addEventListener('click', () => {
        const delta = Math.max(160, nav.clientWidth * 0.6);
        nav.scrollBy({ left: side === 'left' ? -delta : delta, behavior: 'smooth' });
      });
      return b;
    };
    const leftBtn = mkArrow('left', '‹');
    const rightBtn = mkArrow('right', '›');
    wrap.appendChild(leftBtn);
    wrap.appendChild(rightBtn);

    nav.addEventListener('scroll', updateSubnavArrows, { passive: true });

    // Initialize drag events on all tabs (including default ones)
    initTabDragging(nav);
  });
  updateSubnavArrows();
}

function initTabDragging(nav) {
  nav.querySelectorAll('.subnav-tab:not(.add-branch-tab)').forEach(tab => {
    if (tab.dataset.dragInit) return;
    tab.dataset.dragInit = '1';
    tab.addEventListener('dragstart', handleDragStart);
    tab.addEventListener('dragend', handleDragEnd);
    tab.addEventListener('dragover', handleDragOver);
    tab.addEventListener('drop', handleDrop);
    tab.addEventListener('dragenter', handleDragEnter);
    tab.addEventListener('dragleave', handleDragLeave);
  });
}

// Refreshes arrow + edge-fade visibility for every wrapped subnav.
// Safe to call multiple times (idempotent).
function updateSubnavArrows() {
  document.querySelectorAll('.subnav-wrap').forEach(wrap => {
    const nav = wrap.querySelector('.topnav-subnav');
    if (!nav) return;
    const leftBtn = wrap.querySelector('.subnav-arrow-left');
    const rightBtn = wrap.querySelector('.subnav-arrow-right');
    // If subnav is hidden (display:none), skip — no measurement possible.
    if (nav.offsetParent === null) {
      if (leftBtn) leftBtn.classList.remove('visible');
      if (rightBtn) rightBtn.classList.remove('visible');
      wrap.classList.remove('scroll-left', 'scroll-right');
      return;
    }
    const sl = nav.scrollLeft;          // can be negative in RTL on some browsers
    const max = nav.scrollWidth - nav.clientWidth;
    const overflow = max > 2;
    // Normalize scroll position: `pos` is 0 at start, `max` at end regardless of dir.
    const pos = Math.abs(sl);
    const canScrollStart = overflow && pos > 1;            // can go back toward start
    const canScrollEnd   = overflow && pos < max - 1;      // can go forward toward end
    // In RTL the visual "start" is the right side, so the right arrow scrolls back.
    const isRTL = getComputedStyle(nav).direction === 'rtl';
    const showLeft  = isRTL ? canScrollEnd   : canScrollStart;
    const showRight = isRTL ? canScrollStart : canScrollEnd;
    if (leftBtn)  leftBtn.classList.toggle('visible',  showLeft);
    if (rightBtn) rightBtn.classList.toggle('visible', showRight);
    wrap.classList.toggle('scroll-left',  showLeft);
    wrap.classList.toggle('scroll-right', showRight);
  });
}
window.addEventListener('resize', () => {
  if (typeof updateSubnavArrows === 'function') updateSubnavArrows();
});

// ─── MOBILE SIDEBAR ───
function toggleSidebar() {
  const sb = document.getElementById('mobileSidebar');
  const ov = document.getElementById('mobileSidebarOverlay');
  if (!sb) return;
  const isOpen = sb.classList.contains('open');
  if (isOpen) {
    sb.classList.remove('open');
    if (ov) ov.classList.remove('open');
  } else {
    sb.classList.add('open');
    if (ov) ov.classList.add('open');
  }
}
function closeSidebar() {
  const sb = document.getElementById('mobileSidebar');
  const ov = document.getElementById('mobileSidebarOverlay');
  if (sb) sb.classList.remove('open');
  if (ov) ov.classList.remove('open');
}

// ─── TABS ───
function showTab(tab, el, mobEl) {
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  const target = document.getElementById('tab-' + tab);
  if (target) target.classList.add('active');
  // Re-load settings form values when entering Settings.
  if (tab === 'settings') {
    loadAiSuggestionSettingsForm();
    if (typeof renderSettingsColorPicker === 'function') renderSettingsColorPicker();
    // Sync the settings dark-mode toggle with the resolved theme state.
    const dt = document.getElementById('settings-dark-toggle');
    if (dt) dt.classList.toggle('on', document.documentElement.getAttribute('data-theme') === 'dark');
  }
  document.querySelectorAll('.topnav-tab').forEach(t => t.classList.remove('active'));
  if (el) el.classList.add('active');
  // Highlight matching topnav-tab even when called without `el` (e.g. from mobile sidebar)
  if (!el) {
    const tabIndexMap = { docs: 0, calendar: 1, reminders: 2, settings: 3, about: 4 };
    const idx = tabIndexMap[tab];
    const tabs = document.querySelectorAll('.topnav-tab');
    if (idx != null && tabs[idx]) tabs[idx].classList.add('active');
  }
  document.querySelectorAll('.bn-item').forEach(b => b.classList.remove('active'));
  if (mobEl) mobEl.classList.add('active');
  // Old-style sb-* groups (legacy)
  ['docs', 'calendar', 'reminders', 'settings'].forEach(t => {
    const g = document.getElementById('sb-' + t);
    if (g) g.style.display = (t === tab) ? 'block' : 'none';
  });
  // Show/hide topnav-subnav rows — only the matching tab's subnav is visible.
  // Each subnav may be wrapped in a `.subnav-wrap` (added by setupSubnavArrows)
  // so we toggle the wrap's display when present, otherwise the subnav itself.
  document.querySelectorAll('.topnav-subnav').forEach(n => {
    const host = n.parentElement && n.parentElement.classList.contains('subnav-wrap') ? n.parentElement : n;
    host.style.setProperty('display', 'none', 'important');
  });
  // For docs tab, pick subnav based on account type (business uses a different nav)
  const isBusiness = (typeof getAccountType === 'function') && getAccountType() === 'business';
  const docsSubnavId = isBusiness ? 'docsSubnavBusiness' : 'docsSubnav';
  const subnavMap = { docs: docsSubnavId, calendar: 'calSubnav', reminders: 'remSubnav' };
  const activeSubnav = document.getElementById(subnavMap[tab]);
  if (activeSubnav) {
    const host = activeSubnav.parentElement && activeSubnav.parentElement.classList.contains('subnav-wrap') ? activeSubnav.parentElement : activeSubnav;
    host.style.setProperty('display', activeSubnav.parentElement?.classList.contains('subnav-wrap') ? 'block' : 'flex', 'important');
    activeSubnav.style.setProperty('display', 'flex', 'important');
    // Recompute arrow visibility now that the subnav has size again
    if (typeof updateSubnavArrows === 'function') setTimeout(updateSubnavArrows, 50);
  }
  // Update mobile sidebar active state
  document.querySelectorAll('.mobile-nav-item').forEach(item => {
    item.classList.remove('active');
    if (item.dataset.tab === tab) item.classList.add('active');
  });
  // Close legacy sidebar (if exists)
  if (window.innerWidth < 768) {
    const sb = document.getElementById('sidebar');
    if (sb) sb.classList.remove('open');
  }
}

// ─── SIDEBAR DOC NAV ───
function sbNav(page, el, tab) {
  document.querySelectorAll('#sb-' + tab + ' .sb-item').forEach(i => i.classList.remove('active'));
  if (el) el.classList.add('active');
  document.querySelectorAll('.docpage').forEach(p => p.style.display = 'none');
  const dp = document.getElementById('docpage-' + page);
  if (dp) dp.style.display = 'block';
  if (window.innerWidth < 768) document.getElementById('sidebar').classList.remove('open');
}

// ─── FILTER CHIPS ───
// Note: many call sites historically pass the FILTER ROW id as `listId` (e.g.
// `aptFilter`) rather than the list id. We resolve robustly: if listId points
// to a `.doc-list`, use it directly; otherwise fall back to the docpage's
// own `.doc-list`. This keeps every existing call site working.
function filterChip(cat, el, listId) {
  const row = el.closest('.filter-row');
  if (row) {
    row.querySelectorAll('.chip').forEach(c => c.classList.remove('active'));
    // Remember which sub-branch is active so "+ הוסף" in the page header can
    // pre-fill the sub-category automatically.
    row.dataset.activeSub = (cat && cat !== 'הכל') ? cat : '';
  }
  el.classList.add('active');
  let list = null;
  if (listId) {
    const node = document.getElementById(listId);
    if (node && node.classList.contains('doc-list')) list = node;
  }
  if (!list) {
    const page = el.closest('.docpage') || (row && row.closest('.docpage'));
    if (page) list = page.querySelector('.doc-list');
  }
  if (!list) return;
  list.querySelectorAll('.doc-card').forEach(c => {
    const ok = (cat === 'הכל' || c.dataset.cat === cat || c.dataset.sub === cat);
    c.style.display = ok ? '' : 'none';
  });
}

function doSearch(q) {
  document.querySelectorAll('.doc-card').forEach(c => {
    c.style.display = c.dataset.name.includes(q.toLowerCase()) ? '' : 'none';
  });
}

// ─── CALENDAR ───
let calDate = new Date();
let calViewMode = 'month'; // 'month' | 'week' | 'day'
const HEB_MONTHS = ['ינואר', 'פברואר', 'מרץ', 'אפריל', 'מאי', 'יוני', 'יולי', 'אוגוסט', 'ספטמבר', 'אוקטובר', 'נובמבר', 'דצמבר'];
const HEB_DAYS = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת'];

function calEvents() {
  // Build calendar events from real docs (warranty_end dates)
  return docs.filter(d => d.exp).map(d => ({
    date: d.exp,
    text: d.name,
    cls: status(d.exp)?.urgent ? 'ev-warn' : 'ev-accent',
  }));
}

function renderCal() {
  // Show/hide the weekday header row (Sunday/Monday/...) — only relevant for month/week.
  const header = document.getElementById('calHeader');
  if (header) header.style.display = (calViewMode === 'day') ? 'none' : '';
  if (calViewMode === 'month') renderCalMonth();
  else if (calViewMode === 'week') renderCalWeek();
  else if (calViewMode === 'day') renderCalDay();
}

function renderCalMonth() {
  const y = calDate.getFullYear(), m = calDate.getMonth();
  const titleEl = document.getElementById('calTitle');
  if (!titleEl) return;
  titleEl.textContent = HEB_MONTHS[m] + ' ' + y;
  const first = new Date(y, m, 1).getDay();
  const days = new Date(y, m + 1, 0).getDate();
  const today = new Date();
  const events = calEvents();
  let html = '';
  for (let i = 0; i < first; i++) {
    const d = new Date(y, m, 0 - (first - 1 - i));
    html += `<div class="cal-day other-month"><div class="day-num">${d.getDate()}</div></div>`;
  }
  for (let d = 1; d <= days; d++) {
    const ds = `${y}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    const evs = events.filter(e => e.date === ds);
    const isToday = today.getFullYear() === y && today.getMonth() === m && today.getDate() === d;
    html += `<div class="cal-day${isToday ? ' today' : ''}${evs.length ? ' has-events' : ''}" onclick="calDayClick('${ds}')">
      <div class="day-num">${isToday ? `<div style="width:24px;height:24px;background:var(--accent);color:#fff;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:12px">${d}</div>` : d}</div>
      ${evs.map(e => `<div class="cal-event ${e.cls}">${e.text}</div>`).join('')}
    </div>`;
  }
  const body = document.getElementById('calBody');
  if (body) {
    body.style.gridTemplateColumns = 'repeat(7, 1fr)';
    body.innerHTML = html;
  }
}

function renderCalWeek() {
  const startOfWeek = new Date(calDate);
  startOfWeek.setDate(calDate.getDate() - calDate.getDay()); // Sunday
  const titleEl = document.getElementById('calTitle');
  if (titleEl) {
    const endOfWeek = new Date(startOfWeek);
    endOfWeek.setDate(startOfWeek.getDate() + 6);
    titleEl.textContent = `${startOfWeek.getDate()}-${endOfWeek.getDate()} ${HEB_MONTHS[startOfWeek.getMonth()]} ${startOfWeek.getFullYear()}`;
  }
  const events = calEvents();
  let html = '';
  for (let i = 0; i < 7; i++) {
    const d = new Date(startOfWeek);
    d.setDate(startOfWeek.getDate() + i);
    const ds = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const evs = events.filter(e => e.date === ds);
    const isToday = new Date().toDateString() === d.toDateString();
    html += `<div class="cal-day${isToday ? ' today' : ''}${evs.length ? ' has-events' : ''}" onclick="calDayClick('${ds}')">
      <div class="day-num" style="font-size:14px;font-weight:700;margin-bottom:4px">${HEB_DAYS[i]} ${d.getDate()}</div>
      ${evs.map(e => `<div class="cal-event ${e.cls}">${e.text}</div>`).join('')}
    </div>`;
  }
  const body = document.getElementById('calBody');
  if (body) {
    body.style.gridTemplateColumns = 'repeat(7, 1fr)';
    body.innerHTML = html;
  }
}

function renderCalDay() {
  const titleEl = document.getElementById('calTitle');
  if (titleEl) {
    titleEl.textContent = `${HEB_DAYS[calDate.getDay()]} ${calDate.getDate()} ${HEB_MONTHS[calDate.getMonth()]} ${calDate.getFullYear()}`;
  }
  const y = calDate.getFullYear(), m = calDate.getMonth(), d = calDate.getDate();
  const ds = `${y}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  const events = calEvents().filter(e => e.date === ds);
  let html = '';
  for (let h = 0; h < 24; h++) {
    html += `<div class="day-hour" style="border-bottom:1px solid var(--border);padding:8px;display:flex;gap:12px;align-items:center">
      <div style="width:50px;color:var(--text3);font-size:12px;font-weight:600">${String(h).padStart(2,'0')}:00</div>
      <div style="flex:1"></div>
    </div>`;
  }
  const body = document.getElementById('calBody');
  if (body) {
    body.style.gridTemplateColumns = '1fr';
    body.innerHTML = `<div style="padding:16px">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px;gap:12px;">
        <h3 style="margin:0">${events.length ? 'אירועים:' : 'אין אירועים'}</h3>
        <button class="btn-sm" style="background:var(--accent);color:#fff;border:none;border-radius:var(--radius-sm);padding:6px 14px;font-weight:700;cursor:pointer;font-family:'Heebo',sans-serif;font-size:14px;"
                onclick="addReminderForDate('${ds}')"
                title="הוסף תזכורת ליום זה">+ הוסף תזכורת</button>
      </div>
      ${events.map(e => `<div class="cal-event ${e.cls}" style="margin-bottom:8px;padding:12px">${e.text}</div>`).join('')}
    </div>${html}`;
  }
}

// Open the reminder modal pre-filled with the given date.
function addReminderForDate(ds) {
  openModal('reminder');
  // Wait for the modal DOM to be ready, then prefill date.
  setTimeout(() => {
    const dateEl = document.getElementById('rem-date');
    if (dateEl) dateEl.value = ds;
    const nameEl = document.getElementById('rem-name');
    if (nameEl) nameEl.focus();
  }, 50);
}

function changeMonth(dir) {
  if (calViewMode === 'month') {
    calDate.setMonth(calDate.getMonth() + dir);
  } else if (calViewMode === 'week') {
    calDate.setDate(calDate.getDate() + (dir * 7));
  } else if (calViewMode === 'day') {
    calDate.setDate(calDate.getDate() + dir);
  }
  renderCal();
}
function goToday() { calDate = new Date(); renderCal(); }
function calDayClick(ds) {
  // Switch to day view for the clicked date.
  const [y, m, d] = ds.split('-').map(Number);
  calDate = new Date(y, m - 1, d);
  calViewMode = 'day';
  // Update subnav active state to match.
  const subnav = document.getElementById('calSubnav');
  if (subnav) {
    subnav.querySelectorAll('.subnav-tab').forEach((b, i) => {
      b.classList.toggle('active', i === 2); // 0=חודשי, 1=שבועי, 2=יומי
    });
  }
  document.getElementById('calSubtitle').textContent = 'יומי';
  renderCal();
}
function setCalView(v, sbEl, topEl) {
  calViewMode = v;
  document.getElementById('calSubtitle').textContent = { month: 'חודשי', week: 'שבועי', day: 'יומי' }[v];
  if (sbEl) {
    document.querySelectorAll('#sb-calendar .sb-item').forEach(i => i.classList.remove('active'));
    sbEl.classList.add('active');
  }
  if (topEl) {
    // Could be either old gray .view-toggle or new blue subnav. Activate within whichever container exists.
    const container = topEl.closest('.view-toggle') || topEl.closest('.topnav-subnav');
    if (container) {
      container.querySelectorAll('.vt-btn, .subnav-tab').forEach(b => b.classList.remove('active'));
    }
    topEl.classList.add('active');
  }
  renderCal();
}
function exportCal() {
  const f = document.getElementById('expFrom').value, t = document.getElementById('expTo').value;
  alert(`יוצא אירועים מ-${f || 'תחילה'} עד ${t || 'סיום'} (בגרסה המלאה ייוצא לקובץ ICS/PDF)`);
}

// ─── REMINDERS ───
const REM_TYPE_LABEL = {
  birthday: ' יום הולדת', anniv: ' יום שנה', appt: ' תור',
  periodic: ' תקופתי', warranty: ' אחריות', other: ' אחר',
};
const REM_STATUS_LABEL = {
  pending: '', sent: 'נשלח', failed: 'נכשל', cancelled: 'בוטל',
};

function fmtRemindAt(iso) {
  if (!iso) return '';
  try {
    const d = new Date(iso);
    return d.toLocaleString('he-IL', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  } catch { return iso; }
}

async function loadReminders() {
  try {
    const data = await KlaserAPI.listReminders();
    reminders = (data || []).map(r => ({
      id: r.id, type: r.type, name: r.name,
      remind_at: r.remind_at, status: r.status,
      doc_id: r.doc_id, channel: r.channel,
      dot: REM_TYPE_DOT[r.type] || '#6B7280',
    }));
    window.reminders = reminders; // mirror for cross-script readers
    renderReminders('all');
    if (typeof renderBell === 'function') renderBell();
  } catch (e) {
    console.error('Failed to load reminders', e);
  }
}

function renderReminders(filter) {
  const arr = (filter && filter !== 'all') ? reminders.filter(r => r.type === filter) : reminders;
  const el = document.getElementById('reminderList');
  if (el) {
    el.innerHTML = arr.map(r => {
      const typeTag = REM_TYPE_LABEL[r.type] || 'תזכורת';
      const statusTag = REM_STATUS_LABEL[r.status] || '';
      return `
      <div class="rem-item" data-id="${r.id}">
        <div class="rem-dot" style="background:${r.dot}"></div>
        <div class="rem-info">
          <div class="rem-name">${r.name}${statusTag}</div>
          <div class="rem-when">${fmtRemindAt(r.remind_at)}</div>
        </div>
        <span class="rem-type">${typeTag}</span>
        <button class="ico-btn danger" onclick="delReminder('${r.id}')" title="מחק" style="margin-right:8px;">מחק</button>
      </div>`;
    }).join('') || '<p style="color:var(--text3);text-align:center;padding:32px 0">אין תזכורות</p>';
  }
  updateReminderStats();
}

function updateReminderStats() {
  const pending = reminders.filter(r => r.status === 'pending');
  const badge = document.getElementById('remBadge');
  if (badge) {
    if (pending.length > 0) {
      badge.textContent = pending.length;
      badge.style.display = '';
    } else {
      badge.style.display = 'none';
    }
  }
  const sub = document.getElementById('remSubtitle');
  if (sub) {
    sub.textContent = reminders.length === 0
      ? 'אין תזכורות'
      : `${reminders.length} תזכורות · ${pending.length} ממתינות`;
  }
  // Per-category counts
  const types = ['birthday','anniv','appt','periodic','warranty','other'];
  types.forEach(t => {
    const el = document.querySelector(`[data-rem-count="${t}"]`);
    if (el) {
      const n = reminders.filter(r => r.type === t).length;
      el.textContent = n;
    }
  });
}

function filterRem(type, el) {
  if (el) { document.querySelectorAll('#sb-reminders .sb-item').forEach(i => i.classList.remove('active')); el.classList.add('active'); }
  renderReminders(type);
}

// Map Hebrew label from <option> back to enum value
const REM_LABEL_TO_TYPE = {
  ' יום הולדת': 'birthday',
  ' יום שנה': 'anniv',
  ' תור רפואי': 'appt',
  ' יומי': 'periodic',
  ' שבועי': 'periodic',
  ' חודשי': 'periodic',
  ' אחריות': 'warranty',
  ' אחר': 'other',
};

async function saveReminder() {
  const name = document.getElementById('rem-name').value.trim();
  const typeLabel = document.getElementById('rem-type').value;
  const type = REM_LABEL_TO_TYPE[typeLabel] || 'other';
  const dateVal = document.getElementById('rem-date').value;
  const timeVal = document.getElementById('rem-time').value || '09:00';

  if (!name) { alert('יש לציין שם תזכורת'); return; }
  if (!dateVal) { alert('יש לבחור תאריך'); return; }

  const remind_at = new Date(`${dateVal}T${timeVal}:00`).toISOString();

  try {
    await KlaserAPI.createReminder({ name, type, remind_at, channel: 'email' });
    await loadReminders();
    closeModal('reminder');
    document.getElementById('rem-name').value = '';
    document.getElementById('rem-date').value = '';
    document.getElementById('rem-time').value = '';
    // Show a one-time spam-check hint (hidden after user sees it once)
    if (!localStorage.getItem('klaser_spam_hint_seen')) {
      alert('התזכורת נשמרה\n\nהמייל יישלח בסמוך לתאריך שבחרת.\nבהתחלה ייתכן שיגיע לתיקיית SPAM — סמן אותו כ"לא ספאם" כדי לקבל את הבאים בתיבה הראשית.');
      localStorage.setItem('klaser_spam_hint_seen', '1');
    }
  } catch (e) {
    console.error(e);
    alert('שגיאה בשמירת תזכורת:\n' + e.message);
  }
}

async function delReminder(id) {
  if (!confirm('למחוק את התזכורת?')) return;
  try {
    await KlaserAPI.deleteReminder(id);
    reminders = reminders.filter(r => r.id !== id);
    renderReminders('all');
  } catch (e) {
    console.error(e);
    alert('שגיאה במחיקה:\n' + e.message);
  }
}

// ─── SETTINGS TABS ───
function setTab(t, el) {
  document.querySelectorAll('.settings-page').forEach(p => p.classList.remove('active'));
  document.getElementById('st-' + t).classList.add('active');
  document.querySelectorAll('#settingsTabs .st-tab').forEach(b => b.classList.remove('active'));
  if (el) el.classList.add('active');
  if (el) {
    const sbItems = document.querySelectorAll('#sb-settings .sb-item');
    sbItems.forEach(i => i.classList.remove('active'));
    sbItems.forEach(i => { if (i.onclick && i.onclick.toString().includes("'" + t + "'")) i.classList.add('active'); });
  }
}

// ─── MODAL ───
function openModal(id) {
  // Refresh the profile selector on the add modal each time it opens, so
  // newly-added profiles appear without needing a full page reload.
  if (id === 'add' && typeof renderProfileSelect === 'function') {
    renderProfileSelect('fm-assigned');
    const sel = document.getElementById('fm-assigned');
    if (sel) sel.value = '';
  }
  // Wake-up ping for the auth modal: if the user just opened the login form,
  // pre-warm the Render backend so the post-login data fetch is fast. The
  // initial <head> ping covers fresh page loads; this covers users who
  // opened the page hours ago and only now decided to sign in.
  if (id === 'auth') {
    try {
      const url = (window.KLASER_CONFIG && window.KLASER_CONFIG.API_URL) || 'https://klaser.onrender.com';
      fetch(url + '/health', { cache: 'no-store', mode: 'cors' }).catch(() => {});
    } catch (e) {}
  }
  document.getElementById('modal-' + id).classList.add('open');
}
function closeModal(id) { document.getElementById('modal-' + id).classList.remove('open'); }

// Holds the currently-selected file for the add-doc modal
let pendingFile = null;

function handleFile(inp) {
  if (!inp.files[0]) return;
  pendingFile = inp.files[0];
  const z = document.getElementById('uz');
  const sizeKb = (pendingFile.size / 1024).toFixed(1);
  z.innerHTML = `<div class="uz-icon"></div><p>${pendingFile.name}</p><small>${sizeKb} KB · יועלה עם השמירה</small>`;
  z.style.borderColor = 'var(--green)';
  z.style.background = 'var(--green-bg)';
}

function resetUploadZone() {
  pendingFile = null;
  const z = document.getElementById('uz');
  z.innerHTML = `<div class="uz-icon"></div><p>גרור קובץ או לחץ להעלאה</p><small>PNG · JPG · PDF עד 10MB</small><input type="file" id="fi" style="display:none" accept="image/*,.pdf" onchange="handleFile(this)">`;
  z.style.borderColor = '';
  z.style.background = '';
}

async function openDocFile(id) {
  try {
    const { url } = await KlaserAPI.getFileUrl(id);
    window.open(url, '_blank');
  } catch (e) {
    alert('אין קובץ מצורף או שגיאה:\n' + e.message);
  }
}

async function addDoc() {
  // אם המשתמש לא מילא שם — נשתמש בשם זמני; ה-AI ימלא שם אמיתי אחרי הניתוח
  const nameRaw = document.getElementById('fm-name').value.trim();
  const name = nameRaw || (pendingFile ? 'ממתין לניתוח AI' : 'מסמך חדש');

  const subSelEl = document.getElementById('fm-subcat');
  const subVal = subSelEl ? subSelEl.value : '';
  // Read the assigned profile (family member / business contact) from the
  // selector. The select stores the profile *id*; we also resolve to the
  // name (denormalized snapshot — see migration 005).
  const assignedEl = document.getElementById('fm-assigned');
  const assignedId = assignedEl ? assignedEl.value : '';
  let assignedName = '';
  if (assignedId && typeof getProfileById === 'function') {
    const p = getProfileById(assignedId);
    if (p) assignedName = p.name || '';
  }
  const payload = toApi({
    name,
    cat: document.getElementById('fm-cat').value,
    sub: (subVal && subVal !== '__add__') ? subVal : '',
    buy: document.getElementById('fm-buy').value,
    exp: document.getElementById('fm-exp').value || null,
    amount: document.getElementById('fm-note').value, // השדה הזה במודל הוא "הערות" — נשמר כסכום אם נומרי
    assigned_to: assignedId || null,
    person: assignedName,
  });

  // אם הערות לא נומרי — נכניס כ-tag ולא כסכום
  const noteRaw = document.getElementById('fm-note').value;
  if (noteRaw && isNaN(Number(noteRaw))) {
    payload.amount = null;
    payload.tags = [noteRaw];
  }

  const btn = document.getElementById('addDocBtn');
  const uz = document.getElementById('uz');
  setButtonLoading(btn, pendingFile ? 'מעלה קובץ...' : 'שומר...');
  setStatusBadge(pendingFile ? 'מעלה קובץ...' : 'שומר מסמך...', 'loading');

  try {
    let created = await KlaserAPI.createDocument(payload);

    // אם נבחר קובץ — העלה אותו ואז הפעל ניתוח AI
    let didUpload = false;
    if (pendingFile) {
      // Visual feedback inside the upload zone too (modal might be the
      // user's focus; the button spinner alone can be missed).
      if (uz) {
        uz.innerHTML = `<div class="uz-icon"><span class="spinner dark lg"></span></div><p>מעלה קובץ לשרת...</p><small>${pendingFile.name}</small>`;
      }
      try {
        created = await KlaserAPI.uploadFile(created.id, pendingFile);
        didUpload = true;
      } catch (uploadErr) {
        console.error(uploadErr);
        alert('המסמך נוצר אבל הקובץ לא הועלה:\n' + uploadErr.message);
      }
    }

    const newDocUi = fromApi(created);
    // Mark as "being analyzed" so the card shows a spinner immediately.
    if (pendingFile) newDocUi._aiStatus = 'processing';
    docs.unshift(newDocUi);
    renderAll();
    // Record any preselect so runAnalyze() can protect the user's choice.
    if (currentAddPreselect) {
      docPreselects.set(String(created.id), { ...currentAddPreselect });
    }
    const justPreselect = currentAddPreselect;
    currentAddPreselect = null;
    closeModal('add');
    document.getElementById('fm-name').value = '';
    document.getElementById('fm-exp').value = '';
    document.getElementById('fm-note').value = '';
    resetUploadZone();
    _renderAddPreselectHint();
    clearButtonLoading(btn);
    setStatusBadge(didUpload ? 'הקובץ הועלה' : 'המסמך נשמר', 'ok');

    // ניתוח AI ברקע — לא חוסם את המשתמש
    if (didUpload) {
      runAnalyze(created.id);
    }
  } catch (e) {
    console.error(e);
    clearButtonLoading(btn);
    resetUploadZone();
    setStatusBadge('שגיאה בשמירה', 'err');
    alert('שגיאה ביצירת מסמך:\n' + e.message);
  }
}

async function runAnalyze(docId) {
  setStatusBadge('🤖 מנתח מסמך...', 'loading');
  try {
    // Send current user-added branches, custom tabs, people, and account type
    // so the AI can classify documents and use business-specific prompts.
    // Union of every known category name so the AI can classify into them.
    const catSet = new Set([
      ...getInvoiceBranches(),
      ...getCustomTabs().map(t => t.name),
    ]);
    if (typeof getCategoryNames === 'function') {
      getCategoryNames().forEach(n => { if (n) catSet.add(n); });
    }
    const userCats = Array.from(catSet);
    // Build sub-branches map per category (default subs + user-added subs).
    // The AI is instructed to PREFER one of these names for sub_category.
    const subsMap = {};
    if (typeof getSubcategories === 'function') {
      userCats.forEach(c => {
        const names = (getSubcategories(c) || [])
          .map(s => (s && s.name) ? s.name : (typeof s === 'string' ? s : null))
          .filter(n => n && n !== '+');
        if (names.length) subsMap[c] = names;
      });
    }
    // Fall back / merge with the legacy `subBranches_<cat>` storage used by
    // custom-tab pages so AI sees ALL existing sub-branches.
    userCats.forEach(c => {
      try {
        const legacy = JSON.parse(localStorage.getItem('subBranches_' + c) || '[]');
        if (Array.isArray(legacy) && legacy.length) {
          const merged = new Set([...(subsMap[c] || []), ...legacy.filter(s => s && s !== '+')]);
          if (merged.size) subsMap[c] = Array.from(merged);
        }
      } catch {}
    });
    const people = getPeople();
    const accountType = getAccountType(); // 'personal' or 'business'
    const updated = await KlaserAPI.analyzeDocument(docId, userCats, people, accountType, subsMap);

    // If the user explicitly added the doc from a specific tab/sub-chip, we
    // protect that choice. Override the AI's category/sub back to the user's
    // preselect locally (in-memory) and patch the backend to match.
    const preselect = docPreselects.get(String(docId));
    let finalDoc = updated;
    let aiDisagrees = false;
    let aiSuggestion = null;
    if (preselect && preselect.cat) {
      const aiCat = updated.category || '';
      const aiSub = updated.sub_category || '';
      aiDisagrees = (aiCat && aiCat !== preselect.cat);
      if (aiDisagrees) {
        aiSuggestion = { cat: aiCat, sub: aiSub };
      }
      // Restore user's cat/sub on the returned object (others remain AI's).
      finalDoc = { ...updated, category: preselect.cat, sub_category: preselect.sub || updated.sub_category || null };
      // Persist to backend so state matches what the user sees.
      try {
        await KlaserAPI.updateDocument(docId, {
          category: preselect.cat,
          sub_category: preselect.sub || null,
        });
      } catch (patchErr) {
        console.warn('preselect restore patch failed', patchErr);
      }
    }

    // החלף את המסמך ברשימה ב-data החדש
    const idx = docs.findIndex(d => d.id === docId);
    if (idx >= 0) {
      const ui = fromApi(finalDoc);
      ui._aiStatus = 'done'; // ✓ flash that fades away via CSS animation
      docs[idx] = ui;
    }
    renderAll();
    setStatusBadge(`נותח · ${docs.length} מסמכים`, 'ok');
    // Clear the 'done' badge after the CSS fade so future re-renders don't show it.
    setTimeout(() => {
      const i = docs.findIndex(d => d.id === docId);
      if (i >= 0 && docs[i]._aiStatus === 'done') {
        docs[i]._aiStatus = null;
        renderAll();
      }
    }, 2200);

    // If AI proposed a different category than the user's preselect, offer
    // a non-blocking banner that lets them switch with one click.
    if (aiDisagrees && aiSuggestion) {
      _showAICategorySuggestion(docId, preselect, aiSuggestion);
    }
    docPreselects.delete(String(docId));

    // AI sync — if AI suggested a category/subcategory we don't know yet, prompt to add.
    if (typeof syncAICategory === 'function') {
      syncAICategory({
        category: updated.category,
        subcategory: updated.sub_category,
      });
    }
    setTimeout(() => setStatusBadge(`מחובר · ${docs.length} מסמכים`, 'ok'), 3000);
  } catch (e) {
    console.error(e);
    // Mark the doc as 'failed' so the user sees ⚠️ + a retry button on its card.
    // We never remove the doc from the list — its file is already uploaded.
    const idx = docs.findIndex(d => d.id === docId);
    if (idx >= 0) {
      docs[idx]._aiStatus = 'failed';
      renderAll();
    }
    setStatusBadge('ניתוח AI נכשל', 'err');
    setTimeout(() => setStatusBadge(`מחובר · ${docs.length} מסמכים`, 'ok'), 4000);
  }
}

// Retry button on a failed doc card: restart analysis without re-uploading.
function retryAnalyze(docId) {
  const idx = docs.findIndex(d => String(d.id) === String(docId));
  if (idx < 0) return;
  docs[idx]._aiStatus = 'processing';
  renderAll();
  runAnalyze(docs[idx].id);
}

async function selectAmount(docId, selectedAmount) {
  try {
    const updated = await KlaserAPI.updateDocument(docId, { amount: Number(selectedAmount) });
    const idx = docs.findIndex(d => String(d.id) === String(docId));
    if (idx >= 0) docs[idx] = fromApi(updated);
    renderAll();
  } catch (e) {
    console.error(e);
    alert('שגיאה בעדכון הסכום:\n' + e.message);
  }
}

async function delDoc(id) {
  if (!confirm('למחוק מסמך זה?')) return;
  try {
    await KlaserAPI.deleteDocument(id);
    docs = docs.filter(d => d.id !== id);
    renderAll();
    setStatusBadge(`מחובר · ${docs.length} מסמכים`, 'ok');
  } catch (e) {
    alert('שגיאה במחיקה:\n' + e.message);
  }
}

// ─── EDIT MODAL ───
function openEdit(id) {
  const d = docs.find(x => String(x.id) === String(id));
  if (!d) return;
  refreshCategoryDropdowns();
  document.getElementById('ed-id').value = d.id;
  document.getElementById('ed-name').value = d.name || '';
  // Populate categories first, then sub-list, then select doc's values.
  const catSel = document.getElementById('ed-cat');
  const subSel = document.getElementById('ed-sub');
  if (catSel && typeof populateCategoryDropdown === 'function') {
    populateCategoryDropdown(catSel, d.cat || '');
  } else if (catSel) {
    catSel.value = d.cat || '';
  }
  if (subSel && typeof populateSubcategoryDropdown === 'function') {
    populateSubcategoryDropdown(subSel, d.cat || '', d.sub || '');
  }
  document.getElementById('ed-buy').value = d.buy || '';
  document.getElementById('ed-exp').value = d.exp || '';
  const amt = d._raw && d._raw.amount != null ? d._raw.amount : '';
  document.getElementById('ed-amount').value = amt;
  // Populate the assigned-profile select with current profiles and the
  // doc's saved assignment. Uses the same renderer as the add modal but
  // targeted to the edit select.
  if (typeof renderProfileSelect === 'function') {
    renderProfileSelect('ed-assigned');
  }
  const assignedSel = document.getElementById('ed-assigned');
  if (assignedSel) assignedSel.value = d.assigned_to || '';
  openModal('edit');
}

async function saveEdit() {
  const id = document.getElementById('ed-id').value;
  if (!id) return;
  const name = document.getElementById('ed-name').value.trim();
  if (!name) { alert('נא להזין שם'); return; }
  const amountStr = document.getElementById('ed-amount').value;
  const subRaw = document.getElementById('ed-sub').value;
  const subVal = (subRaw && subRaw !== '__add__') ? subRaw.trim() : '';
  // Resolve the assigned profile (if any) for the denormalized name snapshot.
  const assignedSel = document.getElementById('ed-assigned');
  const assignedId = assignedSel ? assignedSel.value : '';
  let assignedName = '';
  if (assignedId && typeof getProfileById === 'function') {
    const p = getProfileById(assignedId);
    if (p) assignedName = p.name || '';
  }
  const patch = {
    name,
    category:              document.getElementById('ed-cat').value || null,
    sub_category:          subVal || null,
    purchase_date:         document.getElementById('ed-buy').value || null,
    warranty_end:          document.getElementById('ed-exp').value || null,
    amount: amountStr === '' ? null : Number(amountStr),
    assigned_profile_id:   assignedId || null,
    assigned_profile_name: assignedName || null,
  };
  try {
    const updated = await KlaserAPI.updateDocument(id, patch);
    const idx = docs.findIndex(x => String(x.id) === String(id));
    if (idx >= 0) docs[idx] = fromApi(updated);
    renderAll();
    closeModal('edit');
  } catch (e) {
    alert('שגיאה בשמירה:\n' + e.message);
  }
}

// Click on a doc card: action button (edit/del) → handle; otherwise opens file
document.addEventListener('click', (e) => {
  const retryBtn = e.target.closest('.doc-ai-retry');
  const catBtn = e.target.closest('.doc-cat-cell');
  const actBtn = e.target.closest('.doc-actions .ico-btn');
  const card = e.target.closest('.doc-card');
  if (!card) return;
  const id = card.dataset.id;
  if (!id) return;
  if (retryBtn) {
    e.stopPropagation();
    retryAnalyze(id);
    return;
  }
  if (catBtn) {
    e.stopPropagation();
    navigateToCategory(card.dataset.cat);
    return;
  }
  if (actBtn) {
    e.stopPropagation();
    const act = actBtn.dataset.act;
    if (act === 'edit') openEdit(id);
    else if (act === 'del') delDoc(id);
    else if (act === 'view') openDocFile(id);
    return;
  }
  if (e.shiftKey) { delDoc(id); return; }
  openDocFile(id);
});

// ─── AUTH UI ───
let authMode = 'login'; // 'login' | 'signup'

function showAuthError(msg) {
  const el = document.getElementById('authError');
  if (!el) return;
  el.textContent = msg;
  el.style.display = msg ? 'block' : 'none';
}

// ─── FORGOT / RESET PASSWORD ───
function openForgotPassword() {
  closeModal('auth');
  // Prefill email from auth modal if available
  const authEmail = document.getElementById('auth-email');
  const forgotEmail = document.getElementById('forgot-email');
  if (authEmail && forgotEmail && authEmail.value) forgotEmail.value = authEmail.value;
  // Hide previous messages
  const err = document.getElementById('forgotError');
  const ok = document.getElementById('forgotSuccess');
  if (err) err.style.display = 'none';
  if (ok) ok.style.display = 'none';
  openModal('forgot');
}

async function sendPasswordReset() {
  const email = (document.getElementById('forgot-email').value || '').trim();
  const errEl = document.getElementById('forgotError');
  const okEl = document.getElementById('forgotSuccess');
  errEl.style.display = 'none';
  okEl.style.display = 'none';
  if (!email) {
    errEl.textContent = 'נא להזין אימייל';
    errEl.style.display = 'block';
    return;
  }
  const btn = document.getElementById('forgotSubmit');
  const originalText = btn.textContent;
  btn.textContent = '...';
  btn.disabled = true;
  try {
    await KlaserAuth.sendPasswordResetEmail(email);
    okEl.textContent = 'נשלח! בדוק את תיבת הדואר שלך לקבלת קישור איפוס.';
    okEl.style.display = 'block';
  } catch (e) {
    errEl.textContent = 'שגיאה בשליחת המייל: ' + (e.message || e);
    errEl.style.display = 'block';
  } finally {
    btn.textContent = originalText;
    btn.disabled = false;
  }
}

async function submitPasswordReset() {
  const pw1 = document.getElementById('reset-pw1').value;
  const pw2 = document.getElementById('reset-pw2').value;
  const errEl = document.getElementById('resetError');
  errEl.style.display = 'none';
  if (!pw1 || pw1.length < 6) {
    errEl.textContent = 'הסיסמה חייבת להיות באורך 6 תווים לפחות';
    errEl.style.display = 'block';
    return;
  }
  if (pw1 !== pw2) {
    errEl.textContent = 'הסיסמאות אינן תואמות';
    errEl.style.display = 'block';
    return;
  }
  const btn = document.getElementById('resetSubmit');
  const originalText = btn.textContent;
  btn.textContent = '...';
  btn.disabled = true;
  try {
    await KlaserAuth.updatePassword(pw1);
    closeModal('reset');
    alert('הסיסמה עודכנה בהצלחה!');
    // Clear URL hash from recovery flow
    if (window.location.hash) history.replaceState(null, '', window.location.pathname);
  } catch (e) {
    errEl.textContent = 'שגיאה בעדכון הסיסמה: ' + (e.message || e);
    errEl.style.display = 'block';
  } finally {
    btn.textContent = originalText;
    btn.disabled = false;
  }
}

// Called by auth.js when Supabase fires PASSWORD_RECOVERY event
window.onPasswordRecovery = function (_session) {
  closeModal('auth');
  closeModal('forgot');
  openModal('reset');
};

function toggleAuthMode() {
  authMode = authMode === 'login' ? 'signup' : 'login';
  document.getElementById('authTitle').textContent = authMode === 'login' ? 'התחברות' : 'הרשמה';
  document.getElementById('authSubmit').textContent = authMode === 'login' ? 'התחבר' : 'הירשם';
  document.getElementById('authToggleText').textContent = authMode === 'login' ? 'אין לך חשבון?' : 'כבר רשום?';
  document.getElementById('authToggleLink').textContent = authMode === 'login' ? 'הירשם' : 'התחבר';
  document.getElementById('auth-password').setAttribute('autocomplete', authMode === 'login' ? 'current-password' : 'new-password');
  // Show "forgot password" only in login mode
  const forgotRow = document.getElementById('authForgotRow');
  if (forgotRow) forgotRow.style.display = authMode === 'login' ? '' : 'none';
  showAuthError('');
}

async function authSubmit() {
  const email = document.getElementById('auth-email').value.trim();
  const password = document.getElementById('auth-password').value;
  if (!email || !password) { showAuthError('נא למלא אימייל וסיסמה'); return; }
  if (password.length < 6) { showAuthError('סיסמה חייבת לפחות 6 תווים'); return; }
  const btn = document.getElementById('authSubmit');
  btn.disabled = true;
  const originalText = btn.textContent;
  btn.textContent = '...';
  // Cold-start UX: if the Render free-tier backend was sleeping, the first
  // request after sign-in can take 25-30s. We've already pre-warmed it on
  // page load (see <head>), but if the user opened the modal long ago the
  // dyno may have re-slept. After 4s of waiting, swap the button label to
  // tell them what's happening so it doesn't feel broken.
  const slowHintTimer = setTimeout(() => {
    if (btn.disabled) btn.textContent = '⏳ מתעורר...';
  }, 4000);
  const verySlowHintTimer = setTimeout(() => {
    if (btn.disabled) btn.textContent = '⏳ עוד רגע (כניסה ראשונה)';
  }, 12000);
  try {
    let isNewSignup = false;
    if (authMode === 'signup') {
      // Pass preselected account_type as user metadata so it persists across devices
      const preselected = localStorage.getItem('account_type_preselected');
      const metadata = (preselected === 'business' || preselected === 'personal')
        ? { account_type: preselected } : undefined;
      const data = await KlaserAuth.signUp(email, password, metadata);
      if (!data.session) {
        // Email confirmation required
        showAuthError('נשלח אימייל אימות. בדוק את תיבת הדואר.');
        btn.disabled = false;
        btn.textContent = originalText;
        return;
      }
      isNewSignup = true;
    } else {
      const data = await KlaserAuth.signIn(email, password);
      // Restore account_type from server-side user metadata (cross-device persistence)
      const meta = data?.user?.user_metadata;
      if (meta && (meta.account_type === 'business' || meta.account_type === 'personal')) {
        localStorage.setItem(ACCOUNT_TYPE_KEY, meta.account_type);
      }
    }
    // Success — hide modal and start app
    closeModal('auth');
    document.body.classList.remove('locked');
    await startApp();

    // After signup: account type selection (skipped if already set or preselected)
    if (isNewSignup) {
      const preselected = localStorage.getItem('account_type_preselected');
      const existing = localStorage.getItem('account_type');
      if (!existing && preselected && (preselected === 'personal' || preselected === 'business')) {
        // User already chose on landing page → auto-apply, skip modal
        localStorage.setItem('account_type', preselected);
        localStorage.removeItem('account_type_preselected');
        if (!localStorage.getItem('account_created')) {
          localStorage.setItem('account_created', String(Date.now()));
        }
        if (typeof applyAccountTypeUI === 'function') applyAccountTypeUI();
        if (typeof initOnboarding === 'function') setTimeout(initOnboarding, 400);
      } else if (!existing) {
        // No preselection → show the modal to choose
        if (typeof handleSignupSuccess === 'function') handleSignupSuccess();
      }
    }
  } catch (e) {
    console.error(e);
    const msg = (e && e.message) || '';
    const code = e && e.code;
    if (code === 'USER_ALREADY_REGISTERED' || /already.*registered/i.test(msg) || /User already registered/i.test(msg)) {
      // Show a friendlier message with login + reset password actions
      const errEl = document.getElementById('authError');
      if (errEl) {
        errEl.innerHTML = 'משתמש רשום כבר במערכת. <a href="#" onclick="switchToLoginMode();return false;" style="color:var(--accent);font-weight:600;text-decoration:underline;">התחבר</a> או <a href="#" onclick="openForgotPassword();return false;" style="color:var(--accent);font-weight:600;text-decoration:underline;">שכחתי סיסמה</a>';
        errEl.style.display = 'block';
      }
    } else if (/Invalid login credentials/i.test(msg)) {
      showAuthError('פרטי התחברות שגויים. בדוק אימייל וסיסמה.');
    } else {
      showAuthError(msg || 'שגיאה בהתחברות');
    }
  } finally {
    clearTimeout(slowHintTimer);
    clearTimeout(verySlowHintTimer);
    btn.disabled = false;
    btn.textContent = originalText;
  }
}

// Helper: switch from signup to login mode (used by inline error link)
function switchToLoginMode() {
  if (typeof authMode !== 'undefined' && authMode === 'signup' && typeof toggleAuthMode === 'function') {
    toggleAuthMode();
  }
  showAuthError('');
}

async function doLogout() {
  if (!confirm('להתנתק?')) return;
  try {
    // Flush any pending preference writes before signing out so a quick
    // logout right after a setting change doesn't lose the change.
    if (window.KlaserPrefs && KlaserPrefs.flushNow) await KlaserPrefs.flushNow();
  } catch {}
  // Clear local cache so the next user's hydrate starts from a clean slate.
  // (Keys that aren't synced — like dark mode — are intentionally cleared.)
  try { localStorage.clear(); } catch {}
  if (window.KlaserPrefs) KlaserPrefs.reset();
  await KlaserAuth.signOut();
  location.reload();
}

async function confirmDeleteAccount() {
  const first = confirm(
    'האם אתה בטוח שברצונך למחוק את החשבון שלך?\n\n' +
    'פעולה זו תמחק לצמיתות:\n' +
    '• את כל המסמכים שהעלית\n' +
    '• את כל התזכורות\n' +
    '• את ההגדרות וההיסטוריה\n' +
    '• את חשבון ההתחברות עצמו\n\n' +
    'אי אפשר לשחזר את הנתונים.'
  );
  if (!first) return;
  const typed = prompt('כדי לאשר, הקלד: מחק');
  if ((typed || '').trim() !== 'מחק') {
    alert('המחיקה בוטלה.');
    return;
  }
  try {
    await KlaserAuth.deleteAccount();
    // Clear local cache so the next session starts clean
    try {
      localStorage.clear();
    } catch {}
    alert('החשבון נמחק בהצלחה. נתראה!');
    location.reload();
  } catch (e) {
    console.error('deleteAccount failed:', e);
    alert('שגיאה במחיקת החשבון: ' + (e.message || e));
  }
}

function updateAuthUI() {
  // Topbar now shows a bell + avatar badge instead of email + logout.
  // The user_panel.js module owns their visibility and rendering.
  if (typeof refreshTopbarForAuth === 'function') refreshTopbarForAuth();
}

async function startApp() {
  updateAuthUI();
  // health check
  try {
    const h = await KlaserAPI.health();
    if (!h.supabase_configured) setStatusBadge('שרת רץ אבל DB לא מוגדר', 'err');
  } catch {
    setStatusBadge('השרת לא רץ', 'err');
    return;
  }
  // Pull cross-device preferences (categories, custom tabs, sub-branches,
  // avatar color, settings, etc.) BEFORE any renderer reads localStorage.
  if (window.KlaserPrefs) {
    try { await KlaserPrefs.hydrate(); } catch (e) { console.warn('prefs hydrate:', e); }
  }
  await loadDocs();
  await loadReminders();
  // Deep-link: #reminders / #calendar / #settings opens that tab
  const hash = (location.hash || '').replace('#', '');
  if (hash && ['reminders','calendar','settings','docs'].includes(hash)) {
    const btn = document.querySelector(`.topnav-tab[onclick*="'${hash}'"]`);
    if (btn) showTab(hash, btn);
  }
}

// ─── SUBNAV ACTIVE STATE ───
function setSubnavActive(el) {
  if (!el) return;
  const parent = el.closest('.topnav-subnav');
  if (!parent) return;
  parent.querySelectorAll('.subnav-tab').forEach(tab => tab.classList.remove('active'));
  el.classList.add('active');
}

// ─── CUSTOM TABS STORAGE ───
const CUSTOM_TABS_KEY = 'klaser_custom_tabs';
function getCustomTabs() {
  try {
    return JSON.parse(localStorage.getItem(CUSTOM_TABS_KEY) || '[]');
  } catch { return []; }
}
function setCustomTabs(tabs) {
  localStorage.setItem(CUSTOM_TABS_KEY, JSON.stringify(tabs));
}

// ─── ADD TAB MENU SYSTEM ───
// Available tab suggestions with default sub-branches
const TAB_SUGGESTIONS = [
  { name: 'התראות', subBranches: [] },
  { name: 'מוצרים', subBranches: ['מוצרי חשמל', 'ריהוט', 'מטבח', 'גינה'] },
  { name: 'ביטוחים', subBranches: ['רכב', 'דירה', 'חיים', 'בריאות'] },
  { name: 'דירה', subBranches: ['חוזה', 'שכר דירה', 'ועד בית'] },
  { name: 'תלושי שכר', subBranches: [] },
  { name: 'פנסיה', subBranches: [] },
  { name: 'רפואי', subBranches: [], hasPeople: true },
  { name: 'רכב', subBranches: ['רישיון', 'טסט', 'רענון נהיגה', 'תיקונים'] },
  { name: 'מיסים', subBranches: [] },
  { name: 'חינוך', subBranches: [] },
  { name: 'משפטי', subBranches: [] },
  { name: 'אישורים', subBranches: [] },
  { name: 'בנק', subBranches: [] },
  { name: 'אשראי', subBranches: [] },
];

const DEFAULT_TABS = new Set(['כל המסמכים', 'חשבוניות', 'עבודה', 'אישי', 'אחר']);

function showAddTabMenu() {
  const menu = document.getElementById('addTabMenu');
  const list = document.getElementById('addTabList');
  if (!menu || !list) return;

  // Get existing tabs (including custom)
  const existing = new Set(Array.from(document.querySelectorAll('#docsSubnav .subnav-tab:not(.add-branch-tab)')).map(t => t.textContent.trim()));

  // Build menu items
  list.innerHTML = '';
  TAB_SUGGESTIONS.forEach(sugg => {
    const isAdded = existing.has(sugg.name);
    const isDefault = DEFAULT_TABS.has(sugg.name);
    const item = document.createElement('div');
    item.className = 'add-tab-item' + (isAdded ? ' added' : '');
    if (isAdded) {
      item.innerHTML = `<span>${sugg.name}</span><span style="color:#E2544A;font-size:12px;">הסר</span>`;
      if (!isDefault) {
        // Allow removing custom tabs
        item.onclick = () => removeTabByName(sugg.name);
      } else {
        // Default tabs cannot be removed - show message
        item.onclick = () => alert('טאב ברירת מחדל לא ניתן להסרה');
      }
    } else {
      item.innerHTML = `<span>${sugg.name}</span>`;
      item.onclick = () => addTabFromSuggestion(sugg);
    }
    list.appendChild(item);
  });

  // Position menu under the + button
  const addBtn = document.querySelector('#docsSubnav .add-branch-tab');
  if (addBtn) {
    const rect = addBtn.getBoundingClientRect();
    menu.style.position = 'fixed';
    menu.style.top = (rect.bottom + 8) + 'px';
    menu.style.left = rect.left + 'px';
    menu.style.transform = 'none';
  }

  menu.classList.add('show');

  // Close on outside click
  setTimeout(() => {
    document.addEventListener('click', hideAddTabMenuOnOutside, { once: true });
  }, 100);
}

function hideAddTabMenu() {
  const menu = document.getElementById('addTabMenu');
  if (menu) menu.classList.remove('show');
}

function hideAddTabMenuOnOutside(e) {
  const menu = document.getElementById('addTabMenu');
  if (menu && !menu.contains(e.target)) {
    menu.classList.remove('show');
  }
}

function addTabFromSuggestion(sugg) {
  hideAddTabMenu();
  addNewTabWithData(sugg.name, sugg.subBranches, sugg.hasPeople);
}

function addCustomTabFromInput() {
  const input = document.getElementById('customTabName');
  const name = input?.value.trim();
  if (!name) return;
  input.value = '';
  hideAddTabMenu();
  addNewTabWithData(name, [], false);
}

function addNewTabWithData(name, subBranches = [], hasPeople = false) {
  // Check if exists
  const existingTabs = Array.from(document.querySelectorAll('#docsSubnav .subnav-tab:not(.add-branch-tab)')).map(t => t.textContent.trim());
  if (existingTabs.includes(name)) {
    alert('לשונית עם שם זה כבר קיימת');
    return;
  }

  // Save to custom tabs
  const customTabs = getCustomTabs();
  customTabs.push({ id: 'custom-' + Date.now(), name, subBranches, hasPeople });
  setCustomTabs(customTabs);

  // ALSO register as a proper category so it appears in the edit modal
  // dropdown and in the list the AI receives when classifying new documents.
  if (typeof addCategory === 'function') {
    addCategory(name, { source: 'user' });
    if (typeof addSubcategory === 'function') {
      subBranches.forEach(sb => { if (sb && sb !== '+') addSubcategory(name, sb, { source: 'user' }); });
    }
  }

  // Create the new tab button (with drag support)
  const addBtn = document.querySelector('#docsSubnav .add-branch-tab');
  const newBtn = createDraggableTabButton(name, 'custom', () => showCustomTab(name));

  // Insert before the + button
  addBtn.parentNode.insertBefore(newBtn, addBtn);

  // Create the page with sub-branches
  createCustomTabPageWithBranches(name, subBranches, hasPeople);

  // Save default sub-branches to storage if provided
  if (subBranches.length > 0) {
    const sbKey = 'subBranches_' + name;
    const existing = getSubBranchesForCat(name);
    const merged = [...new Set([...existing, ...subBranches])];
    localStorage.setItem(sbKey, JSON.stringify(merged));
  }

  // Refresh arrows and reindex draggables
  if (typeof updateSubnavArrows === 'function') updateSubnavArrows();
  reindexDraggables();

  // Re-render: docs whose category matches this new tab name should now
  // move out of "אחר" into the new tab.
  if (typeof renderAll === 'function') renderAll();

  // Switch to the new tab
  newBtn.click();
}

// Legacy function - now opens the menu
function addNewTab() {
  showAddTabMenu();
}

function createDraggableTabButton(name, type, onClick) {
  const btn = document.createElement('button');
  btn.className = 'subnav-tab';
  btn.textContent = name;
  btn.setAttribute('data-custom-tab', 'true');
  btn.setAttribute('draggable', 'true');
  btn.dataset.tabName = name;
  btn.dataset.tabType = type;

  btn.onclick = function() { sbNav(type === 'custom' ? 'custom' : name, this, 'docs'); setSubnavActive(this); onClick(); };
  btn.oncontextmenu = function(e) {
    e.preventDefault();
    if (confirm('להסיר את הלשונית "' + name + '"?')) {
      removeCustomTab(name, btn);
    }
  };

  // Drag events
  btn.addEventListener('dragstart', handleDragStart);
  btn.addEventListener('dragend', handleDragEnd);
  btn.addEventListener('dragover', handleDragOver);
  btn.addEventListener('drop', handleDrop);
  btn.addEventListener('dragenter', handleDragEnter);
  btn.addEventListener('dragleave', handleDragLeave);

  return btn;
}

// ─── DRAG AND DROP ───
let dragSrcEl = null;

function handleDragStart(e) {
  dragSrcEl = this;
  this.classList.add('dragging');
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('text/plain', this.dataset.tabName);
}

function handleDragEnd(e) {
  this.classList.remove('dragging');
  document.querySelectorAll('.subnav-tab').forEach(t => t.classList.remove('drag-over'));
  dragSrcEl = null;
}

function handleDragOver(e) {
  if (e.preventDefault) e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
  return false;
}

function handleDragEnter(e) {
  if (this !== dragSrcEl) {
    this.classList.add('drag-over');
  }
}

function handleDragLeave(e) {
  this.classList.remove('drag-over');
}

function handleDrop(e) {
  if (e.stopPropagation) e.stopPropagation();

  if (dragSrcEl !== this) {
    // Swap the tabs in DOM
    const parent = this.parentNode;
    const addBtn = parent.querySelector('.add-branch-tab');

    // Get all draggable tabs (excluding the + button)
    const allTabs = Array.from(parent.querySelectorAll('.subnav-tab:not(.add-branch-tab)'));
    const srcIndex = allTabs.indexOf(dragSrcEl);
    const targetIndex = allTabs.indexOf(this);

    if (srcIndex < targetIndex) {
      parent.insertBefore(dragSrcEl, this.nextSibling);
    } else {
      parent.insertBefore(dragSrcEl, this);
    }

    // Save new order
    saveTabOrder();
  }

  return false;
}

function saveTabOrder() {
  const tabs = Array.from(document.querySelectorAll('#docsSubnav .subnav-tab:not(.add-branch-tab)')).map(t => ({
    name: t.textContent.trim(),
    isCustom: t.hasAttribute('data-custom-tab')
  }));
  localStorage.setItem('tabOrder', JSON.stringify(tabs));
}

function reindexDraggables() {
  // Re-apply drag events to all custom tabs (in case new ones added)
  document.querySelectorAll('#docsSubnav .subnav-tab[data-custom-tab]').forEach(btn => {
    if (!btn.hasAttribute('draggable')) {
      btn.setAttribute('draggable', 'true');
      btn.addEventListener('dragstart', handleDragStart);
      btn.addEventListener('dragend', handleDragEnd);
      btn.addEventListener('dragover', handleDragOver);
      btn.addEventListener('drop', handleDrop);
      btn.addEventListener('dragenter', handleDragEnter);
      btn.addEventListener('dragleave', handleDragLeave);
    }
  });
}

function createCustomTabPageWithBranches(name, subBranches = [], hasPeople = false) {
  const tabDocs = document.getElementById('tab-docs');
  const pageId = 'docpage-custom-' + name;

  // Check if already exists
  if (document.getElementById(pageId)) return;

  // Build filter chips from sub-branches
  let chipsHtml = `<button class="chip active" onclick="filterChip('הכל',this,'filter-${name}')">הכל</button>`;
  subBranches.forEach(br => {
    chipsHtml += `<button class="chip" onclick="filterChip('${br}',this,'filter-${name}')">${br}</button>`;
  });
  chipsHtml += `<button class="chip add-sub-branch" onclick="addSubBranch('${name}')">+</button>`;

  const div = document.createElement('div');
  div.id = pageId;
  div.className = 'docpage';
  div.style.display = 'none';
  div.innerHTML = `
    <div class="ph"><div class="ph-left"><h1>${name}</h1></div><div class="ph-actions"><button class="btn-primary" onclick="openAddForTab('${name.replace(/'/g, "\\'")}')">+ הוסף</button></div></div>
    <div class="filter-row" id="filter-${name}">
      ${chipsHtml}
    </div>
    <div class="doc-list" id="list-${name}"></div>
  `;

  tabDocs.appendChild(div);
}

function createCustomTabPage(name) {
  const tabDocs = document.getElementById('tab-docs');
  const pageId = 'docpage-custom-' + name;

  // Check if already exists
  if (document.getElementById(pageId)) return;

  const div = document.createElement('div');
  div.id = pageId;
  div.className = 'docpage';
  div.style.display = 'none';
  div.innerHTML = `
    <div class="ph"><div class="ph-left"><h1>${name}</h1></div><div class="ph-actions"><button class="btn-primary" onclick="openAddForTab('${name.replace(/'/g, "\\'")}')">+ הוסף</button></div></div>
    <div class="filter-row" id="filter-${name}">
      <button class="chip active" onclick="filterChip('הכל',this,'filter-${name}')">הכל</button>
      <button class="chip add-sub-branch" onclick="addSubBranch('${name}')">+</button>
    </div>
    <div class="doc-list" id="list-${name}"></div>
  `;

  // Insert before the closing of tab-docs
  tabDocs.appendChild(div);
}

function showCustomTab(name) {
  // Hide all docpages
  document.querySelectorAll('.docpage').forEach(p => p.style.display = 'none');
  // Show this custom page
  const page = document.getElementById('docpage-custom-' + name);
  if (page) page.style.display = 'block';
}

function removeTabByName(name) {
  // Find the tab button
  const btn = Array.from(document.querySelectorAll('#docsSubnav .subnav-tab:not(.add-branch-tab)')).find(t => t.textContent.trim() === name);
  if (btn) {
    removeCustomTab(name, btn);
    hideAddTabMenu();
  }
}

function removeCustomTab(name, btnElement) {
  // Remove from storage
  let customTabs = getCustomTabs();
  customTabs = customTabs.filter(t => t.name !== name);
  setCustomTabs(customTabs);

  // Remove button
  if (btnElement) btnElement.remove();

  // Remove page
  const page = document.getElementById('docpage-custom-' + name);
  if (page) page.remove();

  // Go back to 'all' tab
  sbNav('all', null, 'docs');
}

// Load custom tabs on init - respects saved order and sub-branches
function loadCustomTabs() {
  const customTabs = getCustomTabs();
  const addBtn = document.querySelector('#docsSubnav .add-branch-tab');

  // Check for saved tab order and reorder if needed
  const savedOrder = JSON.parse(localStorage.getItem('tabOrder') || '[]');
  let orderedTabs = customTabs;
  if (savedOrder.length > 0) {
    const orderMap = new Map(savedOrder.map((t, i) => [t.name, i]));
    orderedTabs.sort((a, b) => (orderMap.get(a.name) ?? 999) - (orderMap.get(b.name) ?? 999));
  }

  orderedTabs.forEach(tab => {
    const newBtn = createDraggableTabButton(tab.name, 'custom', () => showCustomTab(tab.name));
    addBtn.parentNode.insertBefore(newBtn, addBtn);
    createCustomTabPageWithBranches(tab.name, tab.subBranches || [], tab.hasPeople || false);
  });
  // Re-render now that the custom-tab list elements exist in the DOM.
  // Without this, the initial renderAll() (triggered from loadDocs before
  // DOMContentLoaded reached loadCustomTabs) couldn't fill list-<name>
  // and docs belonging to custom tabs appeared nowhere until a later
  // user action re-triggered renderAll.
  if (orderedTabs.length && typeof renderAll === 'function') renderAll();
}

function getSubBranchesForCat(cat) {
  try {
    return JSON.parse(localStorage.getItem('subBranches_' + cat) || '[]');
  } catch { return []; }
}

// ─── PEOPLE STORAGE ───
// Stored as: [{ name: "X", id_number: "123456789" }, ...]
const PEOPLE_KEY = 'klaser_people';
function getPeople() {
  try {
    const raw = JSON.parse(localStorage.getItem(PEOPLE_KEY) || '[]');
    // Migrate legacy string-only entries to {name, id_number} objects
    return raw.map(p => typeof p === 'string' ? { name: p, id_number: '' } : p);
  } catch { return []; }
}
function setPeople(people) {
  localStorage.setItem(PEOPLE_KEY, JSON.stringify(people));
}

let activePerson = 'הכל';

// ─── ADD PERSON (with optional ID) ───
function addPerson() {
  const name = prompt('שם הנפש החדש:');
  if (!name || !name.trim()) return;
  const trimmedName = name.trim();
  const idRaw = prompt('מספר תעודת זהות (אופציונלי, מסייע ל-AI לזהות מסמכים):');
  const idNumber = (idRaw || '').trim();
  const people = getPeople();
  if (people.some(p => p.name === trimmedName)) {
    alert('הנפש כבר קיים');
    return;
  }
  people.push({ name: trimmedName, id_number: idNumber });
  setPeople(people);
  renderPeople();
  alert('הנפש "' + trimmedName + '" נוסף בהצלחה!' + (idNumber ? '\nת.ז.: ' + idNumber : ''));
}

function deletePerson(e, name) {
  e.preventDefault();
  if (!confirm('להסיר את הנפש "' + name + '"?')) return;
  let people = getPeople();
  people = people.filter(p => p.name !== name);
  setPeople(people);
  if (activePerson === name) activePerson = 'הכל';
  renderPeople();
}

function filterByPerson(name, btn) {
  activePerson = name;
  const row = document.getElementById('personFilter');
  if (row) row.querySelectorAll('.chip').forEach(c => c.classList.remove('active'));
  if (btn) btn.classList.add('active');
  // Apply the filter to every doc-card on the page (across all tabs/lists),
  // so the "by person" chip strip works regardless of which docs tab is
  // currently visible. Cards without a person assigned only show when
  // "הכל" is selected.
  document.querySelectorAll('.doc-card').forEach(c => {
    const p = c.dataset.person || '';
    c.style.display = (name === 'הכל' || p === name) ? '' : 'none';
  });
}

function renderPeople() {
  const row = document.getElementById('personFilter');
  if (!row) return;
  // Build the chip list from the *unified* set of names: family profiles
  // (the rich system, synced via user_preferences) PLUS any legacy entries
  // from the simple `klaser_people` chip list. This way the filter strip
  // mirrors whichever person UI the user is actually populating.
  const profiles = (typeof getFamilyProfiles === 'function') ? getFamilyProfiles() : [];
  const simple = getPeople();
  const seen = new Set();
  const entries = [];
  profiles.forEach(p => {
    if (p && p.name && !seen.has(p.name)) { seen.add(p.name); entries.push({ name: p.name, emoji: p.emoji || '', fromProfile: true }); }
  });
  simple.forEach(p => {
    if (p && p.name && !seen.has(p.name)) { seen.add(p.name); entries.push({ name: p.name, emoji: '', id_number: p.id_number || '', fromProfile: false }); }
  });

  let html = `<button class="chip ${activePerson==='הכל'?'active':''}" onclick="filterByPerson('הכל',this)">כולם</button>`;
  entries.forEach(p => {
    const active = activePerson === p.name ? 'active' : '';
    const tooltip = p.id_number ? `title="ת.ז.: ${p.id_number}"` : '';
    const emojiPrefix = p.emoji ? `${p.emoji} ` : '';
    // Only the legacy "simple" entries have a right-click delete action —
    // family profiles are managed from the dedicated profile modal.
    const del = p.fromProfile ? '' : `oncontextmenu="deletePerson(event,'${p.name}')"`;
    html += `<button class="chip ${active}" ${tooltip} onclick="filterByPerson('${p.name}',this)" ${del}>${emojiPrefix}${p.name}</button>`;
  });
  html += `<button class="chip add-sub-branch" onclick="addPerson()">+</button>`;
  row.innerHTML = html;
}

// ─── ADD SUB-BRANCH ───
function addSubBranch(categoryName) {
  const name = prompt('שם תת הענף החדש:');
  if (!name || !name.trim()) return;
  const trimmed = name.trim();

  // Get current sub-branches
  let subBranches = getSubBranches(categoryName);

  // Check if already exists (excluding +)
  if (subBranches.includes(trimmed)) {
    alert('תת הענף כבר קיים');
    return;
  }

  // Add new sub-branch before the +
  const plusIndex = subBranches.indexOf('+');
  if (plusIndex >= 0) {
    subBranches.splice(plusIndex, 0, trimmed);
  } else {
    subBranches.push(trimmed);
  }

  // Save
  setSubBranches(categoryName, subBranches);

  // ALSO register as a proper sub-category (categories.js) so it flows into
  // the edit-modal sub-category dropdown and is surfaced to the AI.
  if (typeof addCategory === 'function') addCategory(categoryName, { source: 'user' });
  if (typeof addSubcategory === 'function') addSubcategory(categoryName, trimmed, { source: 'user' });

  // Refresh the filter row
  refreshSubBranches(categoryName);

  alert('תת הענף "' + trimmed + '" נוסף בהצלחה!');
}

// Refresh sub-branches display in filter row
function refreshSubBranches(categoryName) {
  // Find the filter row for this category
  const filterRows = document.querySelectorAll('.filter-row');
  filterRows.forEach(row => {
    const addBtn = row.querySelector('.add-sub-branch');
    if (addBtn && addBtn.onclick && addBtn.onclick.toString().includes(categoryName)) {
      // This is the right row - rebuild it
      const subBranches = getSubBranches(categoryName);
      let html = `<button class="chip active" onclick="filterChip('הכל',this,'${row.id}')">הכל</button>`;

      subBranches.forEach(sb => {
        if (sb === '+') {
          html += `<button class="chip add-sub-branch" onclick="addSubBranch('${categoryName}')">+</button>`;
        } else {
          html += `<button class="chip" onclick="filterChip('${sb}',this,'${row.id}')" oncontextmenu="deleteSubBranch(event, '${categoryName}', '${sb}')">${sb}</button>`;
        }
      });

      row.innerHTML = html;
    }
  });
}

// Delete sub-branch with right-click
function deleteSubBranch(e, categoryName, subBranchName) {
  e.preventDefault();
  if (!confirm('להסיר את תת הענף "' + subBranchName + '"?')) return;

  let subBranches = getSubBranches(categoryName);
  subBranches = subBranches.filter(sb => sb !== subBranchName);

  // Ensure + is always there
  if (!subBranches.includes('+')) subBranches.push('+');

  setSubBranches(categoryName, subBranches);
  refreshSubBranches(categoryName);
}

// Load all sub-branches for existing categories
function loadAllSubBranches() {
  const categories = ['מוצרים', 'דירה', 'תלוש שכר', 'אישורים', 'רפואי', 'רכב', 'ביטוח', 'מסמכים אישיים'];
  categories.forEach(cat => {
    const subBranches = getSubBranches(cat);
    if (subBranches.length > 1) { // Has more than just +
      refreshSubBranches(cat);
    }
  });
}

// ─── INIT ───
document.addEventListener('DOMContentLoaded', async () => {
  // overlay click closes (but not for auth modal — must login)
  document.querySelectorAll('.overlay').forEach(o => o.addEventListener('click', function (e) {
    if (e.target === this && this.id !== 'modal-auth') this.classList.remove('open');
  }));

  const fmBuy = document.getElementById('fm-buy');
  if (fmBuy) fmBuy.valueAsDate = new Date();

  showTab('docs', document.querySelector('.topnav-tab'));
  refreshCategoryDropdowns();

  // Wait for Supabase auth init
  if (!window.KlaserAuth) {
    setStatusBadge('שגיאה בטעינת Supabase', 'err');
    document.body.classList.remove('app-loading');
    return;
  }
  const session = await KlaserAuth.init();

  // Enter key triggers auth submit
  ['auth-email', 'auth-password'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.addEventListener('keydown', (e) => { if (e.key === 'Enter') authSubmit(); });
  });

  // Auth is resolved → show the correct view (landing or app), no more flash.
  document.body.classList.remove('app-loading');

  if (!session) {
    document.body.classList.add('locked');
    return;
  }

  // Restore account_type from server-side user metadata (cross-device persistence)
  const meta = session.user && session.user.user_metadata;
  if (meta && (meta.account_type === 'business' || meta.account_type === 'personal')) {
    localStorage.setItem(ACCOUNT_TYPE_KEY, meta.account_type);
  }

  document.body.classList.remove('locked');
  await startApp();

  // Load custom tabs after app starts
  loadCustomTabs();

  // Wrap each subnav with scroll arrows (called AFTER custom tabs are added
  // so the wrap measurement is accurate from the start).
  setupSubnavArrows();

  // Ensure all tabs (default + custom) have drag handlers
  reindexDraggables();

  // Load sub-branches for all categories
  loadAllSubBranches();

  // Load people
  renderPeople();

  // ─── ONBOARDING INIT ───
  initOnboarding();

  // ─── APPLY ACCOUNT TYPE UI ───
  applyAccountTypeUI();

  // ─── CROSS-PROMO BANNER (show once after 7 days or 10+ docs) ───
  setTimeout(() => showCrossPromoIfEligible(), 3000);

  // Keep server alive - ping every 10 minutes
  const BACKEND_URL = window.KlaserConfig?.apiBase || 'https://klaser.onrender.com';
  setInterval(async () => {
    try {
      await fetch(`${BACKEND_URL}/health`);
    } catch (e) {}
  }, 10 * 60 * 1000);
});

// ═══════════════════════════════════════════════════════════════════════════════
// ═── FAMILY PROFILES ─════════════════════════════════════════════════════════════
// ═══════════════════════════════════════════════════════════════════════════════

const FAMILY_PROFILES_KEY = 'klaser_family_profiles';

// App mode is DERIVED from account_type — no separate storage.
// 'personal' account → 'family' mode; 'business' account → 'business' mode.
function getAppMode() {
  try {
    return (localStorage.getItem('account_type') === 'business') ? 'business' : 'family';
  } catch { return 'family'; }
}

// Kept for backward-compat callers; just re-applies UI based on account_type.
function setAppMode(mode) {
  applyAppMode(mode === 'business' ? 'business' : 'family');
}

function applyAppMode(mode) {
  document.body.dataset.mode = mode;
  // Update UI labels
  const labels = mode === 'business' ? BUSINESS_LABELS : FAMILY_LABELS;
  updateLabels(labels);
}

const FAMILY_LABELS = {
  profilesTitle: 'בני משפחה',
  profilesSubtitle: 'נהל מסמכים לכל בני הבית',
  addProfile: 'הוסף בן משפחה',
  allProfiles: 'כל המשפחה',
  noProfile: 'כללי',
  seeAllDocs: 'ראה כל המסמכים שלו ←'
};

const BUSINESS_LABELS = {
  profilesTitle: 'אנשי קשר / תיקים',
  profilesSubtitle: 'עובדים, לקוחות, ספקים, פרויקטים',
  addProfile: 'הוסף איש קשר',
  allProfiles: 'כל האנשי קשר',
  noProfile: 'כללי',
  seeAllDocs: 'ראה כל המסמכים ←',
  department: 'מחלקה',
  client: 'לקוח',
  employee: 'עובד',
  supplier: 'ספק',
  project: 'פרויקט'
};

function updateLabels(labels) {
  document.querySelectorAll('[data-label]').forEach(el => {
    const key = el.dataset.label;
    if (labels[key]) el.textContent = labels[key];
  });
}

// Profile management
function getFamilyProfiles() {
  try {
    return JSON.parse(localStorage.getItem(FAMILY_PROFILES_KEY) || '[]');
  } catch { return []; }
}

function setFamilyProfiles(profiles) {
  localStorage.setItem(FAMILY_PROFILES_KEY, JSON.stringify(profiles));
  renderProfileChips();
  renderProfileSelect();
  // Keep the simple person chip strip in sync with the rich profile list.
  if (typeof renderPeople === 'function') renderPeople();
}

function createProfile(data) {
  const profiles = getFamilyProfiles();
  const profile = {
    id: 'fp_' + Date.now(),
    name: data.name?.trim(),
    photo: data.photo || null, // base64
    emoji: data.emoji || '',
    color: data.color || getRandomProfileColor(),
    id_number: data.id_number || null,
    birth_date: data.birth_date || null,
    role: data.role?.trim() || '',
    // Business mode fields
    department: data.department || '',
    email: data.email || '',
    phone: data.phone || '',
    type: data.type || 'person', // person | project
    created_at: Date.now()
  };

  if (!profile.name) {
    showToast('שם הוא שדה חובה');
    return null;
  }

  profiles.push(profile);
  setFamilyProfiles(profiles);

  // Add birthday reminder if birth_date provided
  if (profile.birth_date) {
    addBirthdayReminder(profile);
  }

  return profile;
}

function updateProfile(id, updates) {
  const profiles = getFamilyProfiles();
  const idx = profiles.findIndex(p => p.id === id);
  if (idx === -1) return null;

  // Handle photo compression if new photo
  if (updates.photo && updates.photo !== profiles[idx].photo) {
    updates.photo = compressPhoto(updates.photo);
  }

  profiles[idx] = { ...profiles[idx], ...updates, updated_at: Date.now() };
  setFamilyProfiles(profiles);
  return profiles[idx];
}

async function deleteProfile(id) {
  const profiles = getFamilyProfiles();
  const filtered = profiles.filter(p => p.id !== id);
  setFamilyProfiles(filtered);

  // Unassign docs from this profile, both locally (optimistic) and on the
  // server. We fire-and-forget the API calls in parallel — if one fails
  // the next sync will heal it.
  const affected = docs.filter(d => d.assigned_to === id);
  affected.forEach(d => { d.assigned_to = null; d.person = ''; });
  renderAll();
  await Promise.allSettled(
    affected.map(d => KlaserAPI.updateDocument(d.id, {
      assigned_profile_id: null,
      assigned_profile_name: null,
    }).catch(e => console.warn('unassign failed for', d.id, e)))
  );
}

// Photo handling
function compressPhoto(base64, maxSize = 200 * 1024) {
  if (!base64 || base64.length < maxSize) return base64;

  // Simple compression: reduce quality for JPEG
  if (base64.startsWith('data:image/jpeg') || base64.startsWith('data:image/jpg')) {
    const img = new Image();
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');

    return new Promise((resolve) => {
      img.onload = () => {
        const size = Math.min(img.width, img.height, 400);
        canvas.width = size;
        canvas.height = size;
        ctx.drawImage(img, 0, 0, img.width, img.height, 0, 0, size, size);

        let quality = 0.9;
        let result = canvas.toDataURL('image/jpeg', quality);

        while (result.length > maxSize && quality > 0.1) {
          quality -= 0.1;
          result = canvas.toDataURL('image/jpeg', quality);
        }

        resolve(result);
      };
      img.src = base64;
    });
  }

  return base64;
}

function getRandomProfileColor() {
  const colors = ['#4A90E2', '#E94B8A', '#50C878', '#F5A623', '#9B59B6', '#1ABC9C', '#E74C3C', '#34495E'];
  return colors[Math.floor(Math.random() * colors.length)];
}

function addBirthdayReminder(profile) {
  if (!profile.birth_date) return;

  const [year, month, day] = profile.birth_date.split('-');
  const nextBirthday = new Date();
  nextBirthday.setMonth(parseInt(month) - 1);
  nextBirthday.setDate(parseInt(day));

  if (nextBirthday < new Date()) {
    nextBirthday.setFullYear(nextBirthday.getFullYear() + 1);
  }

  reminders.push({
    type: 'birthday',
    name: `יום הולדת — ${profile.name}`,
    date: nextBirthday.toISOString().split('T')[0],
    dot: profile.color,
    person_id: profile.id,
    recurring: true
  });

  renderReminders('all');
}

// Document assignment
// Assign a doc to a family/business profile. Persists through the API so
// the assignment survives reloads and syncs across devices.
async function assignDocToProfile(docId, profileId) {
  const doc = docs.find(d => String(d.id) === String(docId));
  if (!doc) return;
  // Resolve the profile name for the denormalized snapshot column.
  let profileName = '';
  if (profileId && typeof getProfileById === 'function') {
    const p = getProfileById(profileId);
    if (p) profileName = p.name || '';
  }
  // Optimistic update — apply locally first for snappy UI, then save.
  doc.assigned_to = profileId || null;
  doc.person = profileName;
  renderAll();
  try {
    const updated = await KlaserAPI.updateDocument(docId, {
      assigned_profile_id: profileId || null,
      assigned_profile_name: profileName || null,
    });
    const idx = docs.findIndex(d => String(d.id) === String(docId));
    if (idx >= 0) docs[idx] = fromApi(updated);
    renderAll();
  } catch (e) {
    console.error('Failed to assign doc to profile:', e);
    if (typeof showToast === 'function') showToast('שגיאה בשמירת השיוך');
  }
}

function getDocsByProfile(profileId) {
  return docs.filter(d => d.assigned_to === profileId);
}

function getProfileById(id) {
  return getFamilyProfiles().find(p => p.id === id);
}

// UI: Profile chips for filtering
function renderProfileChips() {
  const container = document.getElementById('profileFilter');
  if (!container) return;

  const profiles = getFamilyProfiles();
  const mode = getAppMode();
  const labels = mode === 'business' ? BUSINESS_LABELS : FAMILY_LABELS;

  let html = `<button class="chip ${activeProfile === null ? 'active' : ''}" onclick="filterByProfile(null, this)">${labels.allProfiles}</button>`;

  profiles.forEach(p => {
    const avatar = p.photo
      ? `<img src="${p.photo}" style="width:20px;height:20px;border-radius:50%;object-fit:cover;">`
      : `<span style="font-size:14px;">${p.emoji}</span>`;

    html += `<button class="chip ${activeProfile === p.id ? 'active' : ''}" onclick="filterByProfile('${p.id}', this)">
      ${avatar}
      <span>${p.name}</span>
    </button>`;
  });

  html += `<button class="chip add-sub-branch" onclick="openProfileModal()">+</button>`;
  container.innerHTML = html;
}

let activeProfile = null;

function filterByProfile(profileId, btn) {
  activeProfile = profileId;

  // Update active chip
  const row = btn?.closest('.filter-row');
  if (row) {
    row.querySelectorAll('.chip').forEach(c => c.classList.remove('active'));
    btn.classList.add('active');
  }

  // Filter all doc lists
  document.querySelectorAll('.doc-list').forEach(list => {
    list.querySelectorAll('.doc-card').forEach(card => {
      const docId = card.dataset.id;
      const doc = docs.find(d => String(d.id) === docId);
      const show = profileId === null || (doc && doc.assigned_to === profileId);
      card.style.display = show ? '' : 'none';
    });
  });
}

// UI: Profile selector in document form.
// Accepts an optional select id so the same renderer powers both the add
// modal (`fm-assigned`) and the edit modal (`ed-assigned`).
function renderProfileSelect(selectId = 'fm-assigned') {
  const select = document.getElementById(selectId);
  if (!select) return;

  const profiles = getFamilyProfiles();
  const mode = getAppMode();
  const labels = mode === 'business' ? BUSINESS_LABELS : FAMILY_LABELS;

  let html = `<option value="">${labels.noProfile}</option>`;
  profiles.forEach(p => {
    const role = p.role ? ` (${p.role})` : '';
    const emoji = p.emoji ? `${p.emoji} ` : '';
    html += `<option value="${p.id}">${emoji}${p.name}${role}</option>`;
  });

  select.innerHTML = html;
}

// Modal for profile creation/editing
function openProfileModal(profileId = null) {
  const profile = profileId ? getProfileById(profileId) : null;
  const mode = getAppMode();
  const isBusiness = mode === 'business';

  const html = `
    <div class="overlay open" id="modal-profile">
      <div class="modal" style="max-width:420px;">
        <div class="modal-head">
          <h2>${profile ? 'ערוך פרופיל' : isBusiness ? 'הוסף איש קשר' : 'הוסף בן משפחה'}</h2>
          <button class="icon-btn" onclick="closeModal('profile')">×</button>
        </div>

        <div style="text-align:center;margin-bottom:20px;">
          <div class="profile-photo-upload" onclick="selectProfilePhoto()" style="
            width:80px;height:80px;border-radius:50%;margin:0 auto;
            background:${profile?.color || getRandomProfileColor()};
            display:flex;align-items:center;justify-content:center;cursor:pointer;
            font-size:32px;overflow:hidden;border:3px dashed rgba(255,255,255,0.3);
          ">
            ${profile?.photo ? `<img src="${profile.photo}" style="width:100%;height:100%;object-fit:cover;">` :
              `<span id="profileEmoji">${profile?.emoji || ''}</span>`}
          </div>
          <p style="font-size:12px;color:var(--text2);margin-top:8px;">לחץ להעלאת תמונה</p>
          <input type="file" id="profilePhotoInput" accept="image/*" style="display:none;" onchange="handleProfilePhoto(this)">
        </div>

        <div class="form-group">
          <label>שם *</label>
          <input class="form-input" type="text" id="profileName" value="${profile?.name || ''}" placeholder="שם מלא">
        </div>

        ${isBusiness ? `
        <div class="form-group">
          <label>סוג</label>
          <select class="form-select" id="profileType" style="width:100%;">
            <option value="person" ${profile?.type === 'person' ? 'selected' : ''}>אדם</option>
            <option value="project" ${profile?.type === 'project' ? 'selected' : ''}>פרויקט</option>
          </select>
        </div>
        <div class="form-group">
          <label>תפקיד / קטגוריה</label>
          <input class="form-input" type="text" id="profileRole" value="${profile?.role || ''}" placeholder="למשל: עובד, לקוח, ספק, מחלקת שיווק">
        </div>
        <div class="form-group">
          <label>מחלקה</label>
          <input class="form-input" type="text" id="profileDepartment" value="${profile?.department || ''}" placeholder="שם המחלקה">
        </div>
        <div class="form-group">
          <label>אימייל</label>
          <input class="form-input" type="email" id="profileEmail" value="${profile?.email || ''}" placeholder="email@example.com">
        </div>
        <div class="form-group">
          <label>טלפון</label>
          <input class="form-input" type="tel" id="profilePhone" value="${profile?.phone || ''}" placeholder="050-0000000">
        </div>
        ` : `
        <div class="form-group">
          <label>תפקיד במשפחה</label>
          <input class="form-input" type="text" id="profileRole" value="${profile?.role || ''}" placeholder="למשל: אבא, אמא, ילד, סבא">
        </div>
        `}

        <div class="form-group">
          <label>מספר ת.ז / ח.פ</label>
          <input class="form-input" type="text" id="profileIdNumber" value="${profile?.id_number || ''}" placeholder="${isBusiness ? 'ח.פ' : '9 ספרות'}" maxlength="${isBusiness ? 9 : 9}">
          <p style="font-size:11px;color:var(--text3);margin-top:4px;">* יוצגו רק 4 ספרות אחרונות</p>
        </div>

        ${!isBusiness ? `
        <div class="form-group">
          <label>תאריך לידה</label>
          <input class="form-input" type="date" id="profileBirthDate" value="${profile?.birth_date || ''}">
          <p style="font-size:11px;color:var(--text3);margin-top:4px;">* יוצר תזכורת יום הולדת אוטומטית</p>
        </div>
        ` : ''}

        <div class="form-group">
          <label>צבע לזיהוי</label>
          <div class="color-picker" style="display:flex;gap:8px;flex-wrap:wrap;">
            ${['#4A90E2', '#E94B8A', '#50C878', '#F5A623', '#9B59B6', '#1ABC9C', '#E74C3C', '#34495E'].map(c => `
              <div onclick="selectProfileColor('${c}')" data-color="${c}" style="
                width:32px;height:32px;border-radius:50%;background:${c};cursor:pointer;
                border:3px solid ${profile?.color === c ? '#fff' : 'transparent'};
                box-shadow:0 0 0 2px ${profile?.color === c ? c : 'transparent'};
              "></div>
            `).join('')}
          </div>
          <input type="hidden" id="profileColor" value="${profile?.color || ''}">
        </div>

        <div class="form-group">
          <label>אמוג'י (אופציונלי)</label>
          <input class="form-input" type="text" id="profileEmoji" value="${profile?.emoji || ''}" placeholder="" maxlength="2">
        </div>

        <div style="display:flex;gap:10px;margin-top:24px;">
          ${profile ? `<button class="btn-secondary" style="flex:1;" onclick="deleteProfile('${profile.id}');closeModal('profile');">מחק</button>` : ''}
          <button class="btn-primary" style="flex:2;" onclick="saveProfile('${profile?.id || ''}')">שמור</button>
        </div>
      </div>
    </div>
  `;

  // Insert modal into DOM
  const existing = document.getElementById('modal-profile');
  if (existing) existing.remove();

  document.body.insertAdjacentHTML('beforeend', html);
}

function selectProfilePhoto() {
  document.getElementById('profilePhotoInput')?.click();
}

async function handleProfilePhoto(input) {
  const file = input.files[0];
  if (!file) return;

  if (file.size > 2 * 1024 * 1024) {
    showToast('התמונה גדולה מ-2MB. נסה שוב.');
    return;
  }

  const reader = new FileReader();
  reader.onload = async (e) => {
    const base64 = await compressPhoto(e.target.result);
    window.tempProfilePhoto = base64;

    // Update preview
    const uploadDiv = document.querySelector('.profile-photo-upload');
    if (uploadDiv) {
      uploadDiv.innerHTML = `<img src="${base64}" style="width:100%;height:100%;object-fit:cover;">`;
    }
  };
  reader.readAsDataURL(file);
}

function selectProfileColor(color) {
  document.getElementById('profileColor').value = color;
  document.querySelectorAll('.color-picker div').forEach(d => {
    d.style.boxShadow = 'none';
    d.style.border = '3px solid transparent';
  });
  const selected = document.querySelector(`[data-color="${color}"]`);
  if (selected) {
    selected.style.border = '3px solid #fff';
    selected.style.boxShadow = `0 0 0 2px ${color}`;
  }
}

function saveProfile(profileId) {
  const data = {
    name: document.getElementById('profileName')?.value,
    photo: window.tempProfilePhoto || null,
    emoji: document.getElementById('profileEmoji')?.value || '',
    color: document.getElementById('profileColor')?.value || getRandomProfileColor(),
    id_number: maskIdNumber(document.getElementById('profileIdNumber')?.value),
    birth_date: document.getElementById('profileBirthDate')?.value || null,
    role: document.getElementById('profileRole')?.value || '',
    department: document.getElementById('profileDepartment')?.value || '',
    email: document.getElementById('profileEmail')?.value || '',
    phone: document.getElementById('profilePhone')?.value || '',
    type: document.getElementById('profileType')?.value || 'person'
  };

  if (profileId) {
    updateProfile(profileId, data);
  } else {
    createProfile(data);
  }

  window.tempProfilePhoto = null;
  closeModal('profile');
}

function maskIdNumber(idNum) {
  if (!idNum) return null;
  // Store encrypted/hashed in real implementation
  // For now, just store last 4 digits with masking
  const clean = idNum.replace(/\D/g, '');
  if (clean.length >= 4) {
    return '****' + clean.slice(-4);
  }
  return clean;
}

// Render profile assignment chip on doc cards
function renderProfileChip(doc) {
  if (!doc.assigned_to) return '';

  const profile = getProfileById(doc.assigned_to);
  if (!profile) return '';

  const avatar = profile.photo
    ? `<img src="${profile.photo}" style="width:16px;height:16px;border-radius:50%;object-fit:cover;">`
    : `<span style="font-size:12px;">${profile.emoji}</span>`;

  return `<span class="profile-chip" style="
    display:inline-flex;align-items:center;gap:4px;
    padding:2px 8px;border-radius:12px;font-size:11px;
    background:${profile.color}20;color:${profile.color};border:1px solid ${profile.color}40;
  ">${avatar} ${profile.name}</span>`;
}

// ═══════════════════════════════════════════════════════════════════════════════
// ═── ONBOARDING WIZARD ─════════════════════════════════════════════════════════
// ═══════════════════════════════════════════════════════════════════════════════

const ONBOARDING_KEY = 'klaser_onboarding';
const ONBOARDING_STEP_KEY = 'klaser_onboarding_step';
const ONBOARDING_SKIPPED_KEY = 'klaser_onboarding_skipped';

// Shared first/last steps used by both account types.
const _ONBOARDING_WELCOME = {
  id: 'welcome',
  title: 'ברוכים הבאים לקלסר',
  desc: 'המערכת שתעזור לך לנהל את כל המסמכים שלך במקום אחד. בואו נתחיל!',
  icon: '',
  cta: 'הוסף מסמך ראשון',
  skip: 'אני רוצה להסתכל קודם',
  onComplete: () => openModal('add')
};
const _ONBOARDING_NOTIFICATIONS = {
  id: 'notifications',
  title: 'תזכורות חכמות',
  desc: 'קבל התראות לפני שמסמכים פגי תוקף. לא תפספס שום דדליין!',
  icon: '',
  cta: 'אפשר התראות',
  skip: 'אולי אחר כך',
  onComplete: () => requestNotificationPermission()
};
const _ONBOARDING_DONE = {
  id: 'done',
  title: 'הכל מוכן!',
  desc: 'אתה מוכן להתחיל. זכור: אתה יכול להוסיף מסמכים בכל עת.',
  icon: '✅',
  cta: 'בואו נתחיל',
  skip: null,
  onComplete: () => completeOnboarding()
};

// Personal-mode third step: add a family member.
const _ONBOARDING_FAMILY = {
  id: 'family',
  title: 'הוסף את המשפחה',
  desc: 'נהל מסמכים לכל בני הבית - ילדים, בן/בת זוג, הורים.',
  icon: '👨‍👩‍👧',
  cta: 'הוסף בן משפחה',
  skip: 'אני לבד',
  // `openProfileModal()` is the rich family-profiles dialog (with
  // avatar/color/role). The earlier `openModal('person')` referenced a
  // modal that never existed — this threw silently during onboarding.
  onComplete: () => {
    if (typeof openProfileModal === 'function') openProfileModal();
    else if (typeof addPerson === 'function') addPerson();
  }
};
// Business-mode third step: add a custom tab for clients/suppliers/etc.
const _ONBOARDING_BUSINESS_TAB = {
  id: 'business_tab',
  title: 'התאם לעסק שלך',
  desc: 'הוסף ענפים מותאמים: לקוחות, ספקים, חוזים — כל מה שצריך.',
  icon: '🏢',
  cta: 'הוסף ענף',
  skip: 'אולי אחר כך',
  onComplete: () => { if (typeof showAddTabMenu === 'function') showAddTabMenu(); }
};

// Built lazily so we can read the current account type at show time.
// `initOnboarding()` rebuilds this on each invocation.
let ONBOARDING_STEPS = [
  _ONBOARDING_WELCOME, _ONBOARDING_NOTIFICATIONS, _ONBOARDING_FAMILY, _ONBOARDING_DONE,
];

function _buildOnboardingSteps() {
  const isBiz = (typeof getAccountType === 'function' && getAccountType() === 'business');
  ONBOARDING_STEPS = [
    _ONBOARDING_WELCOME,
    _ONBOARDING_NOTIFICATIONS,
    isBiz ? _ONBOARDING_BUSINESS_TAB : _ONBOARDING_FAMILY,
    _ONBOARDING_DONE,
  ];
}

let currentOnboardingStep = 0;
let skippedSteps = [];

// Initialize onboarding on app load
function initOnboarding() {
  // Rebuild step list based on current account type — business users see
  // a custom-tab step instead of "add family member".
  _buildOnboardingSteps();
  // Load skipped steps
  try {
    skippedSteps = JSON.parse(localStorage.getItem(ONBOARDING_SKIPPED_KEY) || '[]');
  } catch { skippedSteps = []; }

  // Check if should show
  if (!shouldShowOnboarding()) return;

  // Resume from saved step if exists
  const savedStep = parseInt(localStorage.getItem(ONBOARDING_STEP_KEY) || '0');
  currentOnboardingStep = Math.min(savedStep, ONBOARDING_STEPS.length - 1);

  // Show after a short delay to let app render
  setTimeout(() => showOnboardingStep(currentOnboardingStep), 500);
}

function shouldShowOnboarding() {
  const completed = localStorage.getItem(ONBOARDING_KEY);
  if (completed) return false;

  // If user has documents, they probably don't need onboarding
  const docCount = docs?.length || 0;
  if (docCount > 3) {
    completeOnboarding();
    return false;
  }

  return true;
}

function showOnboardingStep(stepIndex) {
  const step = ONBOARDING_STEPS[stepIndex];
  if (!step) return;

  const overlay = document.getElementById('onboardingOverlay');
  const content = document.getElementById('onboardingContent');
  const progress = document.getElementById('onboardingProgress');

  if (!overlay || !content) return;

  // Update dots
  progress?.querySelectorAll('.onboarding-dot').forEach((dot, idx) => {
    dot.classList.toggle('active', idx === stepIndex);
  });

  // Use view transition if available
  const updateContent = () => {
    content.innerHTML = `
      <span class="onboarding-icon">${step.icon}</span>
      <h2 class="onboarding-title">${step.title}</h2>
      <p class="onboarding-desc">${step.desc}</p>
      <div class="onboarding-actions">
        <button class="onboarding-btn-primary" onclick="handleOnboardingAction(${stepIndex})">
          ${step.cta}
        </button>
        ${step.skip ? `<button class="onboarding-btn-skip" onclick="skipOnboardingStep(${stepIndex})">${step.skip}</button>` : ''}
      </div>
    `;
  };

  if (document.startViewTransition) {
    document.startViewTransition(updateContent);
  } else {
    updateContent();
  }

  overlay.classList.add('open');
  saveStep(stepIndex);
}

function handleOnboardingAction(stepIndex) {
  const step = ONBOARDING_STEPS[stepIndex];

  // Mark this step as not skipped
  skippedSteps = skippedSteps.filter(s => s !== step.id);
  saveSkippedSteps();

  // Execute step action
  if (step.onComplete) {
    step.onComplete();
  }

  // For steps 0-2, advance to next. For step 3, close.
  if (stepIndex < ONBOARDING_STEPS.length - 1) {
    goToStep(stepIndex + 1);
  }
}

function skipOnboardingStep(stepIndex) {
  const step = ONBOARDING_STEPS[stepIndex];

  // Mark as skipped
  if (!skippedSteps.includes(step.id)) {
    skippedSteps.push(step.id);
    saveSkippedSteps();
  }

  // Advance to next step or complete
  if (stepIndex < ONBOARDING_STEPS.length - 1) {
    goToStep(stepIndex + 1);
  } else {
    completeOnboarding();
  }
}

function goToStep(stepIndex) {
  currentOnboardingStep = stepIndex;
  showOnboardingStep(stepIndex);
}

function saveStep(stepIndex) {
  localStorage.setItem(ONBOARDING_STEP_KEY, stepIndex);
}

function saveSkippedSteps() {
  localStorage.setItem(ONBOARDING_SKIPPED_KEY, JSON.stringify(skippedSteps));
}

function completeOnboarding() {
  localStorage.setItem(ONBOARDING_KEY, Date.now());
  localStorage.removeItem(ONBOARDING_STEP_KEY);

  const overlay = document.getElementById('onboardingOverlay');
  if (overlay) overlay.classList.remove('open');

  // Show hints for skipped features
  setTimeout(() => showMissedFeaturesHint(), 1000);
}

function closeOnboarding() {
  const overlay = document.getElementById('onboardingOverlay');
  if (overlay) overlay.classList.remove('open');
}

// ═── NOTIFICATIONS PERMISSION ─═══════════════════════════════════════════════

async function requestNotificationPermission() {
  if (!('Notification' in window)) {
    showToast('הדפדפן שלך לא תומך בהתראות');
    return;
  }

  try {
    const permission = await Notification.requestPermission();

    if (permission === 'granted') {
      showToast('התראות הופעלו בהצלחה ✓');
      await registerServiceWorker();
    } else if (permission === 'denied') {
      showToast('התראות נחסמו. אפשר להפעיל בהגדרות הדפדפן.');
    }
  } catch (err) {
    console.error('Notification error:', err);
  }
}

async function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;

  try {
    const reg = await navigator.serviceWorker.register('/sw.js');
    console.log('Service Worker registered:', reg);

    // Subscribe to push notifications
    const sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(
        window.KlaserConfig?.vapidPublicKey || 'BDxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx'
      )
    });

    // Send subscription to server
    await KlaserAPI.savePushSubscription(sub);
  } catch (err) {
    console.error('Service Worker registration failed:', err);
  }
}

function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - base64String.length % 4) % 4);
  const base64 = (base64String + padding).replace(/\-/g, '+').replace(/_/g, '/');
  const rawData = window.atob(base64);
  return Uint8Array.from([...rawData].map(char => char.charCodeAt(0)));
}

// ═── MISSED FEATURES HINT ─═══════════════════════════════════════════════════

function showMissedFeaturesHint() {
  const banners = [];

  if (skippedSteps.includes('notifications')) {
    banners.push({ icon: '🔔', text: 'אפשר להפעיל תזכורות בכל עת דרך הגדרות' });
  }
  if (skippedSteps.includes('family')) {
    banners.push({ icon: '👨‍👩‍👧', text: 'אפשר להוסיף בני משפחה בכל עת דרך תפריט המסמכים' });
  }

  if (banners.length === 0) return;

  // Show first banner
  const banner = banners[0];
  const el = document.getElementById('missedFeaturesBanner');
  const iconEl = document.getElementById('bannerIcon');
  const textEl = document.getElementById('bannerText');

  if (el && iconEl && textEl) {
    iconEl.textContent = banner.icon;
    textEl.textContent = banner.text;
    el.classList.add('show');

    // Auto-hide after 8 seconds
    setTimeout(() => hideMissedFeaturesBanner(), 8000);
  }
}

function hideMissedFeaturesBanner() {
  const el = document.getElementById('missedFeaturesBanner');
  if (el) el.classList.remove('show');
}

// ═── RESET ONBOARDING (for testing) ─═══════════════════════════════════════════

function resetOnboarding() {
  localStorage.removeItem(ONBOARDING_KEY);
  localStorage.removeItem(ONBOARDING_STEP_KEY);
  localStorage.removeItem(ONBOARDING_SKIPPED_KEY);
  location.reload();
}

// ═══════════════════════════════════════════════════════════════════════════════
// ═── ACCOUNT TYPE SELECTION ─══════════════════════════════════════════════════
// ═══════════════════════════════════════════════════════════════════════════════

const ACCOUNT_TYPE_KEY = 'account_type';

let selectedAccountType = null;

function showAccountTypeModal() {
  const modal = document.getElementById('modal-account-type');
  if (modal) {
    modal.style.display = 'flex';
    modal.classList.add('open');
  }
  selectedAccountType = null;
  updateAccountTypeUI();
}

function closeAccountTypeModal() {
  const modal = document.getElementById('modal-account-type');
  if (modal) {
    modal.style.display = 'none';
    modal.classList.remove('open');
  }
}

function selectAccountType(type) {
  selectedAccountType = type;
  localStorage.setItem(ACCOUNT_TYPE_KEY, type);

  // Update UI
  document.querySelectorAll('.account-type-card').forEach(card => {
    card.classList.remove('selected');
  });
  const selectedCard = document.querySelector(`.account-type-card[data-type="${type}"]`);
  if (selectedCard) selectedCard.classList.add('selected');

  // Open auth modal after short delay
  setTimeout(() => {
    closeModal('account-type');
    openModal('auth');
  }, 400);
}

function updateAccountTypeUI() {
  document.querySelectorAll('.account-type-card').forEach(card => {
    card.classList.remove('selected');
  });

  const submitBtn = document.getElementById('accountTypeSubmit');
  if (submitBtn) {
    submitBtn.disabled = true;
    submitBtn.style.opacity = '0.5';
    submitBtn.style.pointerEvents = 'none';
  }
}

function confirmAccountType() {
  if (!selectedAccountType) return;

  // Persist the choice and clear any preselection from landing page
  localStorage.setItem(ACCOUNT_TYPE_KEY, selectedAccountType);
  localStorage.removeItem('account_type_preselected');
  if (!localStorage.getItem('account_created')) {
    localStorage.setItem('account_created', String(Date.now()));
  }

  // Sync to Supabase user metadata (cross-device persistence) — best-effort
  if (window.KlaserAuth && typeof window.KlaserAuth.updateUserMetadata === 'function') {
    window.KlaserAuth.updateUserMetadata({ account_type: selectedAccountType }).catch(err => {
      console.warn('Failed to sync account_type to user metadata:', err);
    });
  }

  closeAccountTypeModal();

  // Apply the unified account-type UI (handles nav + docpages + labels)
  applyAccountTypeUI();

  // Tailored onboarding for the chosen account type
  if (typeof initOnboarding === 'function') setTimeout(initOnboarding, 400);
}

function getAccountType() {
  return localStorage.getItem(ACCOUNT_TYPE_KEY) || 'personal';
}

function setAccountType(type) {
  localStorage.setItem(ACCOUNT_TYPE_KEY, type);
}

// Called when user clicks personal/business cards on landing page
function chooseAccountTypeAndAuth(type) {
  localStorage.setItem(ACCOUNT_TYPE_KEY, type);
  localStorage.setItem('account_type_preselected', type);
  selectedAccountType = type;
  openModal('auth');
  // Switch to signup mode
  if (authMode === 'login') toggleAuthMode();
  setTimeout(() => {
    const el = document.getElementById('auth-email');
    if (el) el.focus();
  }, 100);
}

// Handle signup success - show account type selection
function handleSignupSuccess() {
  // Save account creation date for cross-promo eligibility
  if (!localStorage.getItem('account_created')) {
    localStorage.setItem('account_created', Date.now());
  }
  closeModal('auth');
  showAccountTypeModal();
}

// Account type is set once during registration and cannot be changed
// Each account type shows completely different UI (like two separate apps)

function updateAccountTypeDisplay() {
  const type = getAccountType();
  const iconEl = document.getElementById('accountTypeIcon');
  const labelEl = document.getElementById('accountTypeLabel');

  if (iconEl && labelEl) {
    if (type === 'business') {
      iconEl.textContent = '🏢';
      labelEl.textContent = 'עסקי / משרד';
    } else {
      iconEl.textContent = '👤';
      labelEl.textContent = 'אישי / משפחה';
    }
  }
}

// Apply account-specific UI configuration (single entry point)
function applyAccountTypeUI() {
  const type = getAccountType();

  // body data-mode for CSS hooks (e.g. business/family-only chips)
  document.body.dataset.mode = (type === 'business') ? 'business' : 'family';
  document.body.dataset.accountType = type;

  // Switch nav, docpages
  if (type === 'business') {
    showBusinessTabs();
  } else {
    showPersonalTabs();
  }

  // Apply textual labels (people titles, etc.)
  if (typeof applyAppMode === 'function') {
    applyAppMode(type === 'business' ? 'business' : 'family');
  }

  // Re-render people chips/select (uses mode for labels)
  if (typeof renderProfileChips === 'function') renderProfileChips();
  if (typeof renderProfileSelect === 'function') renderProfileSelect();

  // Update read-only display in settings
  updateAccountTypeDisplay();

  // Refresh categories everywhere (subcategory chips, dropdowns)
  if (typeof renderAllCategoryTabs === 'function') renderAllCategoryTabs();
}

function showBusinessTabs() {
  // Hide personal nav, show business nav
  const personalNav = document.getElementById('docsSubnav');
  const businessNav = document.getElementById('docsSubnavBusiness');
  if (personalNav) personalNav.style.display = 'none';
  if (businessNav) businessNav.style.display = 'flex';

  // Hide personal-specific docpages
  document.querySelectorAll('.personal-only').forEach(el => {
    if (el.classList.contains('docpage')) el.style.display = 'none';
  });
  // Show business-specific docpages (but keep them hidden until selected)
  document.querySelectorAll('.business-only').forEach(el => {
    if (el.classList.contains('docpage')) el.style.display = 'none';
  });

  // Show 'all' page by default
  const allPage = document.getElementById('docpage-all');
  if (allPage) {
    document.querySelectorAll('.docpage').forEach(p => p.style.display = 'none');
    allPage.style.display = 'block';
    allPage.classList.add('active');
  }
}

function showPersonalTabs() {
  // Show personal nav, hide business nav
  const personalNav = document.getElementById('docsSubnav');
  const businessNav = document.getElementById('docsSubnavBusiness');
  if (personalNav) personalNav.style.display = 'flex';
  if (businessNav) businessNav.style.display = 'none';

  // Hide business-specific docpages
  document.querySelectorAll('.business-only').forEach(el => {
    if (el.classList.contains('docpage')) el.style.display = 'none';
  });
  // Show personal-specific docpages (but keep them hidden until selected)
  document.querySelectorAll('.personal-only').forEach(el => {
    if (el.classList.contains('docpage')) el.style.display = 'none';
  });

  // Show 'all' page by default
  const allPage = document.getElementById('docpage-all');
  if (allPage) {
    document.querySelectorAll('.docpage').forEach(p => p.style.display = 'none');
    allPage.style.display = 'block';
    allPage.classList.add('active');
  }
}

// Cross-promo banner - show once after 7 days or 10+ docs
const CROSS_PROMO_KEY = 'cross_promo_shown';

function showCrossPromoIfEligible() {
  // Only show if not already shown
  if (localStorage.getItem(CROSS_PROMO_KEY)) return;

  // Check if enough time has passed or enough docs
  const accountCreated = parseInt(localStorage.getItem('account_created') || '0');
  const daysSinceCreation = accountCreated ? (Date.now() - accountCreated) / (1000 * 60 * 60 * 24) : 0;
  const docCount = docs?.length || 0;

  if (daysSinceCreation >= 7 || docCount >= 10) {
    const type = getAccountType();
    const message = type === 'business'
      ? '💼 רוצה קלסר נפרד לבית? פתח חשבון אישי בחינם ←'
      : '💡 גם מנהל מסמכים בעסק? קלסר עסקי כולל ניהול עובדים וחוזים ←';

    // Show banner
    const banner = document.createElement('div');
    banner.id = 'crossPromoBanner';
    banner.innerHTML = `
      <div style="
        position:fixed;top:0;left:0;right:0;z-index:2001;
        background:linear-gradient(135deg, var(--accent) 0%, #2C5BA0 100%);
        color:#fff;padding:12px 20px;text-align:center;font-size:14px;
        display:flex;align-items:center;justify-content:center;gap:12px;
      ">
        <span>${message}</span>
        <button onclick="openCrossPromo()" style="
          background:#fff;color:var(--accent);border:none;padding:6px 16px;
          border-radius:6px;font-weight:600;cursor:pointer;
        ">התחל עכשיו</button>
        <button onclick="closeCrossPromo()" style="
          background:none;border:none;color:#fff;cursor:pointer;font-size:18px;margin-right:8px;
        ">×</button>
      </div>
    `;
    document.body.appendChild(banner);

    // Mark as shown
    localStorage.setItem(CROSS_PROMO_KEY, 'true');
  }
}

function openCrossPromo() {
  const type = getAccountType();
  const newType = type === 'business' ? 'personal' : 'business';
  localStorage.setItem('account_type_preselected', newType);
  openModal('auth');
}

function setAccountTypePreselected(type) {
  if (type === 'personal' || type === 'business') {
    localStorage.setItem('account_type_preselected', type);
  }
}

function closeCrossPromo() {
  const banner = document.getElementById('crossPromoBanner');
  if (banner) banner.remove();
}

// ═══════════════════════════════════════════════════════════════════════════════
