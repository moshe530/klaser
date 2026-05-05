// ─── DATA (in-memory cache, populated from backend) ───
let docs = [];
let reminders = [];

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
  return {
    name: ui.name,
    category: ui.cat || null,
    sub_category: ui.sub || null,
    purchase_date: ui.buy || null,
    warranty_end: ui.exp || null,
    amount: ui.amount != null && ui.amount !== '' ? Number(ui.amount) : null,
  };
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
  const ic = CAT_ICON[d.cat] || { bg: '#F0EDE6', e: '📄' };
  const st = status(d.exp);
  const cls = st?.urgent ? 'urgent' : st?.expiring ? 'expiring' : '';
  const tag = st ? `<span class="tag ${st.cls}">${st.label}</span>` : '';
  const dt = d.exp
    ? `<div class="doc-date">עד ${d.exp}</div>`
    : (d.buy ? `<div class="doc-date">${d.buy}</div>` : '');

  // AI fields display
  const aiMeta = [];
  if (d.needs_review) {
    aiMeta.push(`<span class="ai-badge ai-review">⚠️ צריך בדיקה</span>`);
  }
  if (d.confidence != null) {
    const confColor = d.confidence >= 80 ? '#10B981' : d.confidence >= 60 ? '#F59E0B' : '#EF4444';
    aiMeta.push(`<span class="ai-badge ai-confidence" style="color:${confColor}">${d.confidence}%</span>`);
  }
  if (d.merchant) {
    aiMeta.push(`<span class="ai-badge ai-merchant">🏪 ${d.merchant}</span>`);
  }
  if (d.document_period) {
    aiMeta.push(`<span class="ai-badge ai-period">📅 ${d.document_period}</span>`);
  }
  if (d.document_type) {
    aiMeta.push(`<span class="ai-badge ai-type">📄 ${d.document_type}</span>`);
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

  return `<div class="doc-card ${cls}" data-id="${d.id}" data-cat="${d.cat}" data-sub="${d.sub || ''}" data-name="${(d.name || '').toLowerCase()}">
    <div class="doc-icon" style="background:${ic.bg}"></div>
    <div class="doc-info">
      <div class="doc-name">${d.name}</div>
      <div class="doc-meta">${d.cat}${amountDisplay ? ' · ' + amountDisplay : ''}</div>
      ${aiMetaHtml}
    </div>
    <div class="doc-right">${tag}${dt}</div>
    <div class="doc-actions">
      <button class="ico-btn" data-act="view" title="הצג">👁</button>
      <button class="ico-btn" data-act="edit" title="עריכה">✎</button>
      <button class="ico-btn danger" data-act="del" title="מחיקה">✕</button>
    </div>
  </div>`;
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

function renderAll() {
  fillList('docList', docs);
  fillList('alertList', docs.filter(d => { const s = status(d.exp); return s?.urgent || s?.expiring; }));
  fillList('productsList',  docs.filter(d => d.cat === 'מוצרים'));
  const invCats = allInvoiceCats();
  fillList('utilitiesList', docs.filter(d => invCats.includes(d.cat)));
  renderInvoiceChips();
  applyInvoiceFilter();
  fillList('apartmentList', docs.filter(d => d.cat === 'דירה'));
  fillList('payslipsList',  docs.filter(d => d.cat === 'תלוש שכר'));
  fillList('approvalsList', docs.filter(d => d.cat === 'אישורים'));
  fillList('medicalList',   docs.filter(d => d.cat === 'רפואי'));
  fillList('reportsList',   docs.filter(d => ['בנק', 'אשראי'].includes(d.cat)));
  fillList('carList',       docs.filter(d => d.cat === 'רכב'));
  fillList('insuranceList', docs.filter(d => d.cat === 'ביטוח'));
  fillList('personalList',  docs.filter(d => d.cat === 'מסמכים אישיים'));
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

// Open add-doc modal pre-filled with the current invoice branch
function openAddForBranch() {
  const sel = document.getElementById('fm-cat');
  if (sel && activeInvoiceFilter !== 'הכל') {
    // Make sure the option exists (custom branches need to be added)
    refreshCategoryDropdowns();
    sel.value = activeInvoiceFilter;
  }
  openModal('add');
}

// Re-build category <select> options to include custom invoice branches
function refreshCategoryDropdowns() {
  const customBranches = getInvoiceBranches();
  const builtIn = [
    'מוצרים', 'ביטוח', 'דירה', 'רכב',
    'מסמכים אישיים', 'חשמל', 'גז', 'מים',
    'תלוש שכר', 'רפואי', 'בנק', 'אשראי',
  ];
  const all = [...builtIn, ...customBranches];
  ['fm-cat', 'ed-cat'].forEach(id => {
    const sel = document.getElementById(id);
    if (!sel) return;
    const prev = sel.value;
    sel.innerHTML = all.map(v => `<option value="${v}">${v}</option>`).join('');
    if (prev) sel.value = prev;
  });
}

// ─── DATA LOAD FROM BACKEND ───
async function loadDocs() {
  setStatusBadge('טוען...', 'loading');
  try {
    const data = await KlaserAPI.listDocuments();
    docs = data.map(fromApi);
    renderAll();
    setStatusBadge(`מחובר · ${docs.length} מסמכים`, 'ok');
  } catch (e) {
    console.error(e);
    setStatusBadge('שגיאת חיבור לשרת', 'err');
    alert('לא הצלחתי לטעון מסמכים מהשרת.\n' + e.message);
  }
}

function setStatusBadge(text, cls) {
  const el = document.getElementById('connBadge');
  if (!el) return;
  el.textContent = text;
  el.dataset.state = cls || '';
}

// ─── TABS ───
function showTab(tab, el, mobEl) {
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  const target = document.getElementById('tab-' + tab);
  if (target) target.classList.add('active');
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
  // Show/hide topnav-subnav rows — only the matching tab's subnav is visible
  document.querySelectorAll('.topnav-subnav').forEach(n => {
    n.style.setProperty('display', 'none', 'important');
  });
  const subnavMap = { docs: 'docsSubnav', calendar: 'calSubnav', reminders: 'remSubnav', settings: 'settSubnav' };
  const activeSubnav = document.getElementById(subnavMap[tab]);
  if (activeSubnav) activeSubnav.style.setProperty('display', 'flex', 'important');
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
function filterChip(cat, el, listId) {
  const row = el.closest('.filter-row');
  row.querySelectorAll('.chip').forEach(c => c.classList.remove('active'));
  el.classList.add('active');
  const list = listId ? document.getElementById(listId) : el.closest('.docpage').querySelector('.doc-list');
  if (!list) return;
  list.querySelectorAll('.doc-card').forEach(c => {
    c.style.display = (cat === 'הכל' || c.dataset.cat === cat || c.dataset.sub === cat) ? '' : 'none';
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
  pending: '', sent: ' ✓ נשלח', failed: ' ⚠ נכשל', cancelled: ' • בוטל',
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
    renderReminders('all');
  } catch (e) {
    console.error('Failed to load reminders', e);
  }
}

function renderReminders(filter) {
  const arr = (filter && filter !== 'all') ? reminders.filter(r => r.type === filter) : reminders;
  const el = document.getElementById('reminderList');
  if (el) {
    el.innerHTML = arr.map(r => {
      const typeTag = REM_TYPE_LABEL[r.type] || '📌';
      const statusTag = REM_STATUS_LABEL[r.status] || '';
      return `
      <div class="rem-item" data-id="${r.id}">
        <div class="rem-dot" style="background:${r.dot}"></div>
        <div class="rem-info">
          <div class="rem-name">${r.name}${statusTag}</div>
          <div class="rem-when">${fmtRemindAt(r.remind_at)}</div>
        </div>
        <span class="rem-type">${typeTag}</span>
        <button class="ico-btn danger" onclick="delReminder('${r.id}')" title="מחק" style="margin-right:8px;">🗑️</button>
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
      alert('✅ התזכורת נשמרה\n\n📧 המייל יישלח בסמוך לתאריך שבחרת.\n⚠️ בהתחלה ייתכן שיגיע לתיקיית SPAM — סמן אותו כ"לא ספאם" כדי לקבל את הבאים בתיבה הראשית.');
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
function openModal(id) { document.getElementById('modal-' + id).classList.add('open'); }
function closeModal(id) { document.getElementById('modal-' + id).classList.remove('open'); }

// Holds the currently-selected file for the add-doc modal
let pendingFile = null;

function handleFile(inp) {
  if (!inp.files[0]) return;
  pendingFile = inp.files[0];
  const z = document.getElementById('uz');
  const sizeKb = (pendingFile.size / 1024).toFixed(1);
  z.innerHTML = `<div class="uz-icon">✅</div><p>${pendingFile.name}</p><small>${sizeKb} KB · יועלה עם השמירה</small>`;
  z.style.borderColor = 'var(--green)';
  z.style.background = 'var(--green-bg)';
}

function resetUploadZone() {
  pendingFile = null;
  const z = document.getElementById('uz');
  z.innerHTML = `<div class="uz-icon">📄</div><p>גרור קובץ או לחץ להעלאה</p><small>PNG · JPG · PDF עד 10MB</small><input type="file" id="fi" style="display:none" accept="image/*,.pdf" onchange="handleFile(this)">`;
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

  const payload = toApi({
    name,
    cat: document.getElementById('fm-cat').value,
    buy: document.getElementById('fm-buy').value,
    exp: document.getElementById('fm-exp').value || null,
    amount: document.getElementById('fm-note').value, // השדה הזה במודל הוא "הערות" — נשמר כסכום אם נומרי
  });

  // אם הערות לא נומרי — נכניס כ-tag ולא כסכום
  const noteRaw = document.getElementById('fm-note').value;
  if (noteRaw && isNaN(Number(noteRaw))) {
    payload.amount = null;
    payload.tags = [noteRaw];
  }

  try {
    let created = await KlaserAPI.createDocument(payload);

    // אם נבחר קובץ — העלה אותו ואז הפעל ניתוח AI
    let didUpload = false;
    if (pendingFile) {
      setStatusBadge('מעלה קובץ...', 'loading');
      try {
        created = await KlaserAPI.uploadFile(created.id, pendingFile);
        didUpload = true;
      } catch (uploadErr) {
        console.error(uploadErr);
        alert('המסמך נוצר אבל הקובץ לא הועלה:\n' + uploadErr.message);
      }
    }

    docs.unshift(fromApi(created));
    renderAll();
    closeModal('add');
    document.getElementById('fm-name').value = '';
    document.getElementById('fm-exp').value = '';
    document.getElementById('fm-note').value = '';
    resetUploadZone();
    setStatusBadge(`מחובר · ${docs.length} מסמכים`, 'ok');

    // ניתוח AI ברקע — לא חוסם את המשתמש
    if (didUpload) {
      runAnalyze(created.id);
    }
  } catch (e) {
    console.error(e);
    alert('שגיאה ביצירת מסמך:\n' + e.message);
  }
}

async function runAnalyze(docId) {
  setStatusBadge('🤖 מנתח מסמך...', 'loading');
  try {
    // Send current user-added branches, custom tabs, and people (with ID numbers)
    // so the AI can classify documents and identify medical/personal docs by ID.
    const userCats = [
      ...getInvoiceBranches(),
      ...getCustomTabs().map(t => t.name),
    ];
    const people = getPeople();
    const updated = await KlaserAPI.analyzeDocument(docId, userCats, people);
    // החלף את המסמך ברשימה ב-data החדש
    const idx = docs.findIndex(d => d.id === docId);
    if (idx >= 0) docs[idx] = fromApi(updated);
    renderAll();
    setStatusBadge(`✓ נותח · ${docs.length} מסמכים`, 'ok');
    setTimeout(() => setStatusBadge(`מחובר · ${docs.length} מסמכים`, 'ok'), 3000);
  } catch (e) {
    console.error(e);
    setStatusBadge('ניתוח AI נכשל', 'err');
    setTimeout(() => setStatusBadge(`מחובר · ${docs.length} מסמכים`, 'ok'), 4000);
  }
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
  document.getElementById('ed-cat').value = d.cat || '';
  document.getElementById('ed-sub').value = d.sub || '';
  document.getElementById('ed-buy').value = d.buy || '';
  document.getElementById('ed-exp').value = d.exp || '';
  const amt = d._raw && d._raw.amount != null ? d._raw.amount : '';
  document.getElementById('ed-amount').value = amt;
  openModal('edit');
}

async function saveEdit() {
  const id = document.getElementById('ed-id').value;
  if (!id) return;
  const name = document.getElementById('ed-name').value.trim();
  if (!name) { alert('נא להזין שם'); return; }
  const amountStr = document.getElementById('ed-amount').value;
  const patch = {
    name,
    category:      document.getElementById('ed-cat').value || null,
    sub_category:  document.getElementById('ed-sub').value.trim() || null,
    purchase_date: document.getElementById('ed-buy').value || null,
    warranty_end:  document.getElementById('ed-exp').value || null,
    amount: amountStr === '' ? null : Number(amountStr),
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
  const actBtn = e.target.closest('.doc-actions .ico-btn');
  const card = e.target.closest('.doc-card');
  if (!card) return;
  const id = card.dataset.id;
  if (!id) return;
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

function toggleAuthMode() {
  authMode = authMode === 'login' ? 'signup' : 'login';
  document.getElementById('authTitle').textContent = authMode === 'login' ? 'התחברות' : 'הרשמה';
  document.getElementById('authSubmit').textContent = authMode === 'login' ? 'התחבר' : 'הירשם';
  document.getElementById('authToggleText').textContent = authMode === 'login' ? 'אין לך חשבון?' : 'כבר רשום?';
  document.getElementById('authToggleLink').textContent = authMode === 'login' ? 'הירשם' : 'התחבר';
  document.getElementById('auth-password').setAttribute('autocomplete', authMode === 'login' ? 'current-password' : 'new-password');
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
  try {
    if (authMode === 'signup') {
      const data = await KlaserAuth.signUp(email, password);
      if (!data.session) {
        // Email confirmation required
        showAuthError('נשלח אימייל אימות. בדוק את תיבת הדואר.');
        btn.disabled = false;
        btn.textContent = originalText;
        return;
      }
    } else {
      await KlaserAuth.signIn(email, password);
    }
    // Success — hide modal and start app
    closeModal('auth');
    document.body.classList.remove('locked');
    await startApp();
  } catch (e) {
    console.error(e);
    showAuthError(e.message || 'שגיאה בהתחברות');
  } finally {
    btn.disabled = false;
    btn.textContent = originalText;
  }
}

async function doLogout() {
  if (!confirm('להתנתק?')) return;
  await KlaserAuth.signOut();
  location.reload();
}

function updateAuthUI() {
  const user = KlaserAuth.getUser();
  const emailEl = document.getElementById('userEmail');
  const logoutEl = document.getElementById('logoutBtn');
  if (user) {
    emailEl.textContent = user.email;
    emailEl.style.display = '';
    logoutEl.style.display = '';
  } else {
    emailEl.style.display = 'none';
    logoutEl.style.display = 'none';
  }
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

// ─── ADD NEW TAB (from top subnav) ───
function addNewTab() {
  const name = prompt('שם הענף/הלשונית החדשה:');
  if (!name || !name.trim()) return;
  const trimmed = name.trim();

  // Check if exists
  const existingTabs = Array.from(document.querySelectorAll('#docsSubnav .subnav-tab:not(.add-branch-tab)')).map(t => t.textContent.replace(/\s*\d+$/, '').trim());
  if (existingTabs.includes(trimmed)) {
    alert('לשונית עם שם זה כבר קיימת');
    return;
  }

  // Save to custom tabs
  const customTabs = getCustomTabs();
  customTabs.push({ id: 'custom-' + Date.now(), name: trimmed });
  setCustomTabs(customTabs);

  // Create the new tab button
  const addBtn = document.querySelector('#docsSubnav .add-branch-tab');
  const newBtn = document.createElement('button');
  newBtn.className = 'subnav-tab';
  newBtn.textContent = trimmed;
  newBtn.setAttribute('data-custom-tab', 'true');
  newBtn.onclick = function() { sbNav('custom', this, 'docs'); setSubnavActive(this); showCustomTab(trimmed); };
  newBtn.oncontextmenu = function(e) {
    e.preventDefault();
    if (confirm('להסיר את הלשונית "' + trimmed + '"?')) {
      removeCustomTab(trimmed, newBtn);
    }
  };

  // Insert before the + button
  addBtn.parentNode.insertBefore(newBtn, addBtn);

  // Create the page div for this tab
  createCustomTabPage(trimmed);

  alert('הלשונית "' + trimmed + '" נוספה בהצלחה!');
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
    <div class="ph"><div class="ph-left"><h1>${name}</h1></div><div class="ph-actions"><button class="btn-primary" onclick="openModal('add')">+</button></div></div>
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

// Load custom tabs on init
function loadCustomTabs() {
  const customTabs = getCustomTabs();
  const addBtn = document.querySelector('#docsSubnav .add-branch-tab');

  customTabs.forEach(tab => {
    const newBtn = document.createElement('button');
    newBtn.className = 'subnav-tab';
    newBtn.textContent = tab.name;
    newBtn.setAttribute('data-custom-tab', 'true');
    newBtn.onclick = function() { sbNav('custom', this, 'docs'); setSubnavActive(this); showCustomTab(tab.name); };
    newBtn.oncontextmenu = function(e) {
      e.preventDefault();
      if (confirm('להסיר את הלשונית "' + tab.name + '"?')) {
        removeCustomTab(tab.name, newBtn);
      }
    };
    addBtn.parentNode.insertBefore(newBtn, addBtn);
    createCustomTabPage(tab.name);
  });
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
  // Filter medical docs
  const list = document.getElementById('medicalList');
  if (!list) return;
  list.querySelectorAll('.doc-card').forEach(c => {
    c.style.display = (name === 'הכל' || c.dataset.person === name) ? '' : 'none';
  });
}

function renderPeople() {
  const row = document.getElementById('personFilter');
  if (!row) return;
  const people = getPeople();
  let html = `<button class="chip ${activePerson==='הכל'?'active':''}" onclick="filterByPerson('הכל',this)">כולם</button>`;
  people.forEach(p => {
    const active = activePerson === p.name ? 'active' : '';
    const tooltip = p.id_number ? `title="ת.ז.: ${p.id_number}"` : '';
    html += `<button class="chip ${active}" ${tooltip} onclick="filterByPerson('${p.name}',this)" oncontextmenu="deletePerson(event,'${p.name}')">${p.name}</button>`;
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
    return;
  }
  const session = await KlaserAuth.init();

  // Enter key triggers auth submit
  ['auth-email', 'auth-password'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.addEventListener('keydown', (e) => { if (e.key === 'Enter') authSubmit(); });
  });

  if (!session) {
    document.body.classList.add('locked');
    openModal('auth');
    document.getElementById('auth-email').focus();
    return;
  }

  document.body.classList.remove('locked');
  await startApp();

  // Load custom tabs after app starts
  loadCustomTabs();

  // Load sub-branches for all categories
  loadAllSubBranches();

  // Load people
  renderPeople();
  // Keep server alive - ping every 10 minutes
  const BACKEND_URL = window.KlaserConfig?.apiBase || 'https://klaser.onrender.com';
  setInterval(async () => {
    try {
      await fetch(`${BACKEND_URL}/health`);
    } catch (e) {}
  }, 10 * 60 * 1000);
});
