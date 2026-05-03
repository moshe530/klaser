// ─── DATA (in-memory cache, populated from backend) ───
let docs = [];

const reminders = [
  { type: 'birthday', name: 'יום הולדת — אמא', date: '2025-05-12', dot: '#EC4899' },
  { type: 'appt',     name: 'רופא עיניים',      date: '2025-05-03', dot: '#0D9488' },
  { type: 'warranty', name: 'אחריות מקרר',       date: '2025-03-30', dot: '#D97706' },
  { type: 'anniv',    name: 'יום נישואין',       date: '2025-06-15', dot: '#7C3AED' },
  { type: 'periodic', name: 'טיפול רכב',         date: '2025-04-20', dot: '#1A56DB' },
];

const CAT_ICON = {
  'מוצרים':         { bg: '#E1F5EE', e: '🛍️' },
  'ביטוח':          { bg: '#EDE9FE', e: '🛡️' },
  'דירה':           { bg: '#FEF3C7', e: '🏠' },
  'רכב':            { bg: '#E6F1FB', e: '🚗' },
  'מסמכים אישיים':  { bg: '#EEEDFE', e: '🪪' },
  'חשמל':           { bg: '#FEF9C3', e: '⚡' },
  'גז':             { bg: '#FFE4E6', e: '🔥' },
  'מים':            { bg: '#E0F2FE', e: '💧' },
  'תלוש שכר':       { bg: '#F0FDF4', e: '💼' },
  'רפואי':          { bg: '#FEF2F2', e: '🏥' },
  'בנק':            { bg: '#FFFBEB', e: '🏦' },
  'אשראי':          { bg: '#FDF4FF', e: '💳' },
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
  return [...INVOICE_BUILTIN, ...getInvoiceBranches()];
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
  if (d < 0)  return { label: 'פג תוקף', cls: 'expired', urgent: true };
  if (d < 30) return { label: d + ' ימים', cls: 'warn', expiring: true };
  return { label: 'בתוקף', cls: 'ok' };
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
    <div class="doc-icon" style="background:${ic.bg}">${ic.e}</div>
    <div class="doc-info">
      <div class="doc-name">${d.name}</div>
      <div class="doc-meta">${d.cat}${amountDisplay ? ' · ' + amountDisplay : ''}</div>
      ${aiMetaHtml}
    </div>
    <div class="doc-right">${tag}${dt}</div>
    <div class="doc-actions">
      <button class="ico-btn" data-act="edit" title="עריכה">✏️</button>
      <button class="ico-btn danger" data-act="del" title="מחיקה">🗑️</button>
    </div>
  </div>`;
}

function fillList(id, arr) {
  const el = document.getElementById(id);
  if (el) el.innerHTML = arr.map(makeCard).join('') || '<p style="color:var(--text3);text-align:center;padding:32px 0">אין פריטים</p>';
}

function renderInvoiceChips() {
  const row = document.getElementById('utilFilter');
  if (!row) return;
  const branches = allInvoiceCats();
  const chips = [
    `<button class="chip ${activeInvoiceFilter==='הכל'?'active':''}" onclick="filterInvoice('הכל',this)">הכל</button>`,
    ...branches.map(b => {
      const ic = CAT_ICON[b] || { e: '📄' };
      const isActive = activeInvoiceFilter === b ? 'active' : '';
      return `<button class="chip ${isActive}" onclick="filterInvoice('${b}',this)">${ic.e} ${b}</button>`;
    }),
    `<button class="chip add-branch" onclick="addBranch()">+ ענף חדש</button>`,
  ];
  row.innerHTML = chips.join('');
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
  renderReminders('all');
  renderCal();
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

// ─── Add a new invoice branch (sub-category) ───
function addBranch() {
  const name = prompt('שם הענף החדש (למשל: ארנונה, אינטרנט):');
  if (!name) return;
  const trimmed = name.trim();
  if (!trimmed) return;
  const branches = getInvoiceBranches();
  if (branches.includes(trimmed) || INVOICE_BUILTIN.includes(trimmed)) {
    alert('הענף כבר קיים');
    return;
  }
  branches.push(trimmed);
  setInvoiceBranches(branches);
  // Auto-register icon if missing
  if (!CAT_ICON[trimmed]) CAT_ICON[trimmed] = { bg: '#F0EDE6', e: '🧾' };
  renderInvoiceChips();
  refreshCategoryDropdowns();
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
    ['מוצרים', '🛍️'], ['ביטוח', '🛡️'], ['דירה', '🏠'], ['רכב', '🚗'],
    ['מסמכים אישיים', '🪪'], ['חשמל', '⚡'], ['גז', '🔥'], ['מים', '💧'],
    ['תלוש שכר', '💼'], ['רפואי', '🏥'], ['בנק', '🏦'], ['אשראי', '💳'],
  ];
  const all = [...builtIn, ...customBranches.map(b => [b, (CAT_ICON[b]?.e || '🧾')])];
  ['fm-cat', 'ed-cat'].forEach(id => {
    const sel = document.getElementById(id);
    if (!sel) return;
    const prev = sel.value;
    sel.innerHTML = all.map(([v, e]) => `<option value="${v}">${e} ${v}</option>`).join('');
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
  document.getElementById('tab-' + tab).classList.add('active');
  document.querySelectorAll('.topnav-tab').forEach(t => t.classList.remove('active'));
  if (el) el.classList.add('active');
  document.querySelectorAll('.bn-item').forEach(b => b.classList.remove('active'));
  if (mobEl) mobEl.classList.add('active');
  ['docs', 'calendar', 'reminders', 'settings'].forEach(t => {
    const g = document.getElementById('sb-' + t);
    if (g) g.style.display = (t === tab) ? 'block' : 'none';
  });
  if (window.innerWidth < 768) document.getElementById('sidebar').classList.remove('open');
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
const HEB_MONTHS = ['ינואר', 'פברואר', 'מרץ', 'אפריל', 'מאי', 'יוני', 'יולי', 'אוגוסט', 'ספטמבר', 'אוקטובר', 'נובמבר', 'דצמבר'];

function calEvents() {
  // Build calendar events from real docs (warranty_end dates)
  return docs.filter(d => d.exp).map(d => ({
    date: d.exp,
    text: d.name,
    cls: status(d.exp)?.urgent ? 'ev-warn' : 'ev-accent',
  }));
}

function renderCal() {
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
  document.getElementById('calBody').innerHTML = html;
}

function changeMonth(dir) { calDate.setMonth(calDate.getMonth() + dir); renderCal(); }
function goToday() { calDate = new Date(); renderCal(); }
function calDayClick(ds) { console.log('day', ds); }
function setCalView(v, sbEl, topEl) {
  document.getElementById('calSubtitle').textContent = { month: 'חודשי', week: 'שבועי', day: 'יומי' }[v];
  if (sbEl) { document.querySelectorAll('#sb-calendar .sb-item').forEach(i => i.classList.remove('active')); sbEl.classList.add('active'); }
  if (topEl) { topEl.closest('.view-toggle').querySelectorAll('.vt-btn').forEach(b => b.classList.remove('active')); topEl.classList.add('active'); }
}
function exportCal() {
  const f = document.getElementById('expFrom').value, t = document.getElementById('expTo').value;
  alert(`יוצא אירועים מ-${f || 'תחילה'} עד ${t || 'סיום'} (בגרסה המלאה ייוצא לקובץ ICS/PDF)`);
}

// ─── REMINDERS ───
function renderReminders(filter) {
  const arr = filter === 'all' ? reminders : reminders.filter(r => r.type === filter);
  const el = document.getElementById('reminderList');
  if (!el) return;
  el.innerHTML = arr.map(r => `
    <div class="rem-item">
      <div class="rem-dot" style="background:${r.dot}"></div>
      <div class="rem-info">
        <div class="rem-name">${r.name}</div>
        <div class="rem-when">${r.date}</div>
      </div>
      <span class="rem-type">${{ birthday: '🎂 יום הולדת', anniv: '💍 יום שנה', appt: '🏥 תור', periodic: '🔁 תקופתי', warranty: '🛡️ אחריות' }[r.type] || '📌'}</span>
    </div>`).join('') || '<p style="color:var(--text3);text-align:center;padding:32px 0">אין תזכורות</p>';
}
function filterRem(type, el) {
  if (el) { document.querySelectorAll('#sb-reminders .sb-item').forEach(i => i.classList.remove('active')); el.classList.add('active'); }
  renderReminders(type);
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
  const name = nameRaw || (pendingFile ? '⏳ ממתין לניתוח AI' : 'מסמך חדש');

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
    const updated = await KlaserAPI.analyzeDocument(docId);
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
    return;
  }
  if (e.shiftKey) { delDoc(id); return; }
  openDocFile(id);
});

// ─── SIDEBAR TOGGLE ───
function toggleSidebar() { document.getElementById('sidebar').classList.toggle('open'); }

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
});
