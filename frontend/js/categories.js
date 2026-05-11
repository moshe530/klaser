// ═══════════════════════════════════════════════════════════════════════════════
// DYNAMIC CATEGORIES & SUBCATEGORIES — single source of truth in localStorage
// ═══════════════════════════════════════════════════════════════════════════════

const CATEGORIES_KEY = 'klaser_categories';

const DEFAULT_CATEGORIES_PERSONAL = {
  'מוצרים':       { id: 'cat_products',  subcategories: ['אלקטרוניקה', 'מכשירי חשמל', 'ריהוט', 'אחר'] },
  'ביטוח':        { id: 'cat_insurance', subcategories: ['רכב', 'דירה', 'חיים', 'בריאות', 'נסיעות'] },
  'דירה':         { id: 'cat_home',      subcategories: ['חוזה שכירות', 'שכר דירה', 'תיקונים', 'ועד בית', 'ארנונה'] },
  'רכב':          { id: 'cat_car',       subcategories: ['רישיון רכב', 'טסט', 'תיקונים', 'ביטוח רכב', 'דלק'] },
  'חשבוניות':     { id: 'cat_invoices',  subcategories: ['חשמל', 'מים', 'גז', 'תקשורת', 'ארנונה'] },
  'תלוש שכר':     { id: 'cat_payslips',  subcategories: ['תלוש חודשי', 'טופס 106', 'בונוסים'] },
  'רפואי':        { id: 'cat_medical',   subcategories: ['בדיקות', 'מרשמים', 'אישורים', 'תוצאות'] },
  'מסמכים אישיים':{ id: 'cat_personal',  subcategories: ['תעודת זהות', 'דרכון', 'רישיון נהיגה'] },
  'בנק':          { id: 'cat_bank',      subcategories: ['דפי חשבון', 'הלוואות', 'חיסכון'] },
  'אשראי':        { id: 'cat_credit',    subcategories: ['פירוט', 'אישורי עסקה'] },
  'פנסיה':        { id: 'cat_pension',   subcategories: ['קרן פנסיה', 'קרן השתלמות', 'ביטוח מנהלים'] },
  'מיסים':        { id: 'cat_taxes',     subcategories: ['מס הכנסה', 'מעמ', 'החזרים'] },
  'חינוך':        { id: 'cat_education', subcategories: ['שכר לימוד', 'תעודות', 'מלגות'] },
  'משפטי':        { id: 'cat_legal',     subcategories: ['חוזים', 'ייפוי כוח', 'פסקי דין'] },
  'אחר':          { id: 'cat_other',     subcategories: [] },
};

const DEFAULT_CATEGORIES_BUSINESS = {
  'עובדים':   { id: 'cat_employees', subcategories: ['חוזי עבודה', 'תלושי שכר', 'אישורי חופש'] },
  'לקוחות':   { id: 'cat_clients',   subcategories: ['חוזים', 'הצעות מחיר', 'חשבוניות'] },
  'ספקים':    { id: 'cat_suppliers', subcategories: ['חוזי אספקה', 'הזמנות', 'חשבוניות ספק'] },
  'רישיונות': { id: 'cat_licenses',  subcategories: ['רישיון עסק', 'אישור עירייה', 'ביטוח עסק'] },
  'חשבוניות': { id: 'cat_invoices',  subcategories: ['חשמל', 'מים', 'גז', 'תקשורת', 'ארנונה'] },
  'ביטוח':    { id: 'cat_insurance', subcategories: ['ביטוח עסק', 'ביטוח אחריות', 'ביטוח רכב'] },
  'משפטי':    { id: 'cat_legal',     subcategories: ['חוזים', 'NDA', 'ייפוי כוח'] },
  'מיסים':    { id: 'cat_taxes',     subcategories: ['מעמ', 'מס הכנסה', 'דוחות שנתיים'] },
  'בנק':      { id: 'cat_bank',      subcategories: ['דפי חשבון', 'הלוואות עסק', 'ערבויות'] },
  'אחר':      { id: 'cat_other',     subcategories: [] },
};

function _normCats(raw) {
  const out = {};
  for (const [cat, val] of Object.entries(raw || {})) {
    if (!val || typeof val !== 'object') continue;
    const subs = Array.isArray(val.subcategories) ? val.subcategories : [];
    out[cat] = {
      id: val.id || ('cat_' + cat.replace(/\s+/g, '_')),
      subcategories: subs.map(s => typeof s === 'string'
        ? { name: s, custom: false }
        : (s && s.name ? { name: s.name, custom: !!s.custom, added_at: s.added_at, source: s.source } : null)
      ).filter(Boolean),
    };
  }
  return out;
}

function _seedDefaults() {
  const isBiz = (typeof getAccountType === 'function' && getAccountType() === 'business');
  const defs = isBiz ? DEFAULT_CATEGORIES_BUSINESS : DEFAULT_CATEGORIES_PERSONAL;
  const out = {};
  for (const [cat, val] of Object.entries(defs)) {
    out[cat] = { id: val.id, subcategories: val.subcategories.map(s => ({ name: s, custom: false })) };
  }
  return out;
}

function getCategories() {
  try {
    const raw = JSON.parse(localStorage.getItem(CATEGORIES_KEY) || 'null');
    if (!raw) {
      const seeded = _seedDefaults();
      localStorage.setItem(CATEGORIES_KEY, JSON.stringify(seeded));
      return seeded;
    }
    return _normCats(raw);
  } catch { return _seedDefaults(); }
}

function saveCategories(cats) {
  localStorage.setItem(CATEGORIES_KEY, JSON.stringify(cats));
  if (typeof renderAllCategoryTabs === 'function') renderAllCategoryTabs();
}

function getCategoryNames() { return Object.keys(getCategories()); }

function getSubcategories(cat) {
  const c = getCategories()[cat];
  return c ? (c.subcategories || []) : [];
}

function addCategory(name, opts) {
  name = (name || '').trim();
  if (!name) return false;
  const cats = getCategories();
  if (cats[name]) return false;
  cats[name] = {
    id: 'cat_' + name.replace(/\s+/g, '_') + '_' + Date.now(),
    subcategories: [], custom: true, added_at: Date.now(),
    source: (opts && opts.source) || 'user',
  };
  saveCategories(cats);
  return true;
}

function addSubcategory(cat, name, opts) {
  name = (name || '').trim();
  if (!cat || !name) return false;
  const cats = getCategories();
  if (!cats[cat]) {
    cats[cat] = { id: 'cat_' + cat.replace(/\s+/g, '_') + '_' + Date.now(), subcategories: [] };
  }
  const subs = cats[cat].subcategories;
  if (subs.some(s => s.name === name)) return false;
  subs.push({ name, custom: true, added_at: Date.now(), source: (opts && opts.source) || 'user' });
  saveCategories(cats);
  return true;
}

function renameSubcategory(cat, oldName, newName) {
  newName = (newName || '').trim();
  if (!newName) return false;
  const cats = getCategories();
  if (!cats[cat]) return false;
  const sub = cats[cat].subcategories.find(s => s.name === oldName);
  if (!sub) return false;
  if (cats[cat].subcategories.some(s => s.name === newName)) return false;
  sub.name = newName;
  saveCategories(cats);
  if (typeof docs !== 'undefined' && Array.isArray(docs)) {
    docs.forEach(d => { if (d.cat === cat && d.sub === oldName) d.sub = newName; });
    if (typeof renderAll === 'function') renderAll();
  }
  return true;
}

function countDocsInSubcategory(cat, name) {
  if (typeof docs === 'undefined' || !Array.isArray(docs)) return 0;
  return docs.filter(d => d.cat === cat && d.sub === name).length;
}

function deleteSubcategory(cat, name) {
  const count = countDocsInSubcategory(cat, name);
  if (count > 0) {
    alert(`יש ${count} מסמכים בתת-ענף "${name}". העבר אותם קודם.`);
    return false;
  }
  const cats = getCategories();
  if (!cats[cat]) return false;
  cats[cat].subcategories = cats[cat].subcategories.filter(s => s.name !== name);
  saveCategories(cats);
  return true;
}

const NEW_BADGE_DAYS = 7;
function isSubcategoryNew(s) {
  return s && s.added_at && (Date.now() - s.added_at) < (NEW_BADGE_DAYS * 86400000);
}

// ─── HTML helpers (defined here so this file is self-contained) ─────────
function _esc(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function _attr(s) {
  return String(s == null ? '' : s).replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/"/g, '&quot;');
}

// ─── DROPDOWNS ──────────────────────────────────────────────────────────
function populateCategoryDropdown(sel, selected) {
  if (!sel) return;
  const names = getCategoryNames();
  const cur = selected || sel.value || names[0] || '';
  sel.innerHTML = names.map(n => `<option value="${_esc(n)}"${n === cur ? ' selected' : ''}>${_esc(n)}</option>`).join('');
}

function populateSubcategoryDropdown(sel, cat, selected) {
  if (!sel) return;
  const subs = getSubcategories(cat);
  const cur = selected || '';
  let html = '<option value="">בחר תת-ענף...</option>';
  html += subs.map(s => {
    const badge = isSubcategoryNew(s) ? ' [חדש]' : '';
    return `<option value="${_esc(s.name)}"${s.name === cur ? ' selected' : ''}>${_esc(s.name)}${badge}</option>`;
  }).join('');
  html += '<option value="__add__" style="font-weight:600;color:var(--accent,#3B82F6);">+ הוסף תת-ענף חדש</option>';
  sel.innerHTML = html;
}

// ─── FORM HANDLERS (used by index.html dropdowns) ───────────────────────
function onCategoryChange(cat) {
  const subSel = document.getElementById('fm-subcat');
  if (subSel) {
    populateSubcategoryDropdown(subSel, cat, '');
    cancelAddSubcategoryInline();
  }
}

function onSubcategoryChange(val) {
  if (val === '__add__') showAddSubcategoryInline();
}

function showAddSubcategoryInline() {
  const row = document.getElementById('fm-subcat-add-row');
  if (row) {
    row.style.display = 'flex';
    const inp = document.getElementById('fm-subcat-new');
    if (inp) { inp.value = ''; setTimeout(() => inp.focus(), 50); }
  }
}

function cancelAddSubcategoryInline() {
  const row = document.getElementById('fm-subcat-add-row');
  if (row) row.style.display = 'none';
  const sel = document.getElementById('fm-subcat');
  if (sel && sel.value === '__add__') sel.value = '';
}

function confirmAddSubcategoryInline() {
  const inp = document.getElementById('fm-subcat-new');
  const catSel = document.getElementById('fm-cat');
  const subSel = document.getElementById('fm-subcat');
  if (!inp || !catSel || !subSel) return;
  const name = (inp.value || '').trim();
  if (!name) { inp.focus(); return; }
  const ok = addSubcategory(catSel.value, name, { source: 'user' });
  if (!ok) { alert('תת-הענף כבר קיים'); return; }
  populateSubcategoryDropdown(subSel, catSel.value, name);
  cancelAddSubcategoryInline();
}

// ─── EDIT MODAL HANDLERS (mirror of add modal) ──────────────────────────
function onEditCategoryChange(cat) {
  const subSel = document.getElementById('ed-sub');
  if (subSel) {
    populateSubcategoryDropdown(subSel, cat, '');
    cancelAddEditSubcategoryInline();
  }
}

function onEditSubcategoryChange(val) {
  if (val === '__add__') showAddEditSubcategoryInline();
}

function showAddEditSubcategoryInline() {
  const row = document.getElementById('ed-subcat-add-row');
  if (row) {
    row.style.display = 'flex';
    const inp = document.getElementById('ed-subcat-new');
    if (inp) { inp.value = ''; setTimeout(() => inp.focus(), 50); }
  }
}

function cancelAddEditSubcategoryInline() {
  const row = document.getElementById('ed-subcat-add-row');
  if (row) row.style.display = 'none';
  const sel = document.getElementById('ed-sub');
  if (sel && sel.value === '__add__') sel.value = '';
}

function confirmAddEditSubcategoryInline() {
  const inp = document.getElementById('ed-subcat-new');
  const catSel = document.getElementById('ed-cat');
  const subSel = document.getElementById('ed-sub');
  if (!inp || !catSel || !subSel) return;
  const name = (inp.value || '').trim();
  if (!name) { inp.focus(); return; }
  const ok = addSubcategory(catSel.value, name, { source: 'user' });
  if (!ok) { alert('תת-הענף כבר קיים'); return; }
  populateSubcategoryDropdown(subSel, catSel.value, name);
  cancelAddEditSubcategoryInline();
}

// ─── MANAGEMENT MODAL ────────────────────────────────────────────────────
function openSubcategoryManager(cat) {
  let overlay = document.getElementById('subcat-manager-overlay');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = 'subcat-manager-overlay';
    overlay.className = 'overlay';
    overlay.style.cssText = 'display:none;align-items:center;justify-content:center;';
    overlay.onclick = (e) => { if (e.target === overlay) closeSubcategoryManager(); };
    overlay.innerHTML = `
      <div class="modal" style="max-width:480px;">
        <div class="modal-head">
          <h2 id="subcat-manager-title">ניהול תתי-ענפים</h2>
          <button class="close-btn" onclick="closeSubcategoryManager()">×</button>
        </div>
        <div id="subcat-manager-list" style="max-height:50vh;overflow-y:auto;margin-bottom:16px;"></div>
        <div class="form-group">
          <label>הוסף תת-ענף חדש</label>
          <div style="display:flex;gap:8px;">
            <input class="form-input" id="subcat-manager-new" placeholder="שם תת-ענף" style="flex:1;" />
            <button class="btn-primary" onclick="addSubcategoryFromManager()" style="padding:10px 18px;">+ הוסף</button>
          </div>
        </div>
      </div>`;
    document.body.appendChild(overlay);
  }
  overlay.dataset.category = cat;
  document.getElementById('subcat-manager-title').textContent = `ניהול תתי-ענפים — ${cat}`;
  renderSubcategoryManagerList();
  overlay.style.display = 'flex';
}

function closeSubcategoryManager() {
  const o = document.getElementById('subcat-manager-overlay');
  if (o) o.style.display = 'none';
}

function renderSubcategoryManagerList() {
  const o = document.getElementById('subcat-manager-overlay');
  if (!o) return;
  const cat = o.dataset.category;
  const list = document.getElementById('subcat-manager-list');
  if (!list || !cat) return;
  const subs = getSubcategories(cat);
  if (!subs.length) {
    list.innerHTML = '<p style="text-align:center;color:var(--text3,#888);padding:20px;">אין תתי-ענפים. הוסף אחד למטה.</p>';
    return;
  }
  list.innerHTML = subs.map(s => {
    const count = countDocsInSubcategory(cat, s.name);
    const badge = isSubcategoryNew(s) ? '<span style="background:#FF6B6B;color:#fff;font-size:10px;padding:2px 6px;border-radius:8px;margin-right:6px;">[חדש]</span>' : '';
    return `
      <div style="display:flex;align-items:center;justify-content:space-between;padding:10px;border-bottom:1px solid var(--border,#eee);">
        <div style="display:flex;align-items:center;gap:8px;">
          <span style="font-weight:500;">${_esc(s.name)}</span>${badge}
          ${count > 0 ? `<span style="font-size:12px;color:var(--text3,#888);">(${count} מסמכים)</span>` : ''}
        </div>
        <div style="display:flex;gap:6px;">
          <button onclick="renameSubcategoryFromManager('${_attr(s.name)}')" title="שנה שם" style="background:transparent;border:1px solid var(--border,#ccc);border-radius:6px;padding:4px 10px;cursor:pointer;font-size:12px;">✎</button>
          <button onclick="deleteSubcategoryFromManager('${_attr(s.name)}')" title="מחק" style="background:transparent;border:1px solid #FF6B6B;color:#FF6B6B;border-radius:6px;padding:4px 10px;cursor:pointer;font-size:12px;">×</button>
        </div>
      </div>`;
  }).join('');
}

function addSubcategoryFromManager() {
  const o = document.getElementById('subcat-manager-overlay');
  if (!o) return;
  const cat = o.dataset.category;
  const inp = document.getElementById('subcat-manager-new');
  if (!inp || !cat) return;
  const name = (inp.value || '').trim();
  if (!name) { inp.focus(); return; }
  if (!addSubcategory(cat, name, { source: 'user' })) { alert('תת-הענף כבר קיים'); return; }
  inp.value = '';
  renderSubcategoryManagerList();
}

function renameSubcategoryFromManager(oldName) {
  const o = document.getElementById('subcat-manager-overlay');
  if (!o) return;
  const cat = o.dataset.category;
  const newName = prompt(`שם חדש ל-"${oldName}":`, oldName);
  if (!newName || newName === oldName) return;
  if (!renameSubcategory(cat, oldName, newName.trim())) { alert('שם כבר קיים או לא תקין'); return; }
  renderSubcategoryManagerList();
}

function deleteSubcategoryFromManager(name) {
  const o = document.getElementById('subcat-manager-overlay');
  if (!o) return;
  const cat = o.dataset.category;
  if (!confirm(`למחוק את "${name}"?`)) return;
  if (deleteSubcategory(cat, name)) renderSubcategoryManagerList();
}

// ─── AI SYNC ────────────────────────────────────────────────────────────
function syncAICategory(aiResult) {
  if (!aiResult || typeof aiResult !== 'object') return;
  const cat = aiResult.category || aiResult.cat;
  const sub = aiResult.subcategory || aiResult.sub_category || aiResult.sub;
  if (!cat) return;
  const cats = getCategories();
  if (!cats[cat]) {
    showAddCategoryPrompt(cat, sub);
    return;
  }
  if (sub && !cats[cat].subcategories.some(s => s.name === sub)) {
    showAddSubcategoryPrompt(cat, sub);
  }
}

// Shared helper that wraps attachBannerCountdown when available (defined in app.js).
function _bannerCountdown(banner, onExpire) {
  if (typeof getAiSuggestionTimeout !== 'function' || typeof attachBannerCountdown !== 'function') return () => {};
  const sec = getAiSuggestionTimeout();
  if (sec <= 0) return () => {};
  const cancel = attachBannerCountdown(banner, sec, onExpire);
  banner.addEventListener('mouseenter', () => cancel());
  return cancel;
}

function showAddCategoryPrompt(cat, sub) {
  removeAISuggestionBanner();
  const banner = document.createElement('div');
  banner.id = 'ai-suggestion-banner';
  banner.style.cssText = 'position:fixed;bottom:24px;left:50%;transform:translateX(-50%);background:#fff;border:2px solid var(--accent,#3B82F6);border-radius:12px;box-shadow:0 12px 32px rgba(0,0,0,0.18);padding:16px 20px;z-index:9999;max-width:420px;direction:rtl;';
  banner.innerHTML = `
    <div style="display:flex;align-items:flex-start;gap:12px;">
      <div style="font-size:24px;">🤖</div>
      <div style="flex:1;">
        <div style="font-weight:600;margin-bottom:4px;">ה-AI זיהה קטגוריה חדשה</div>
        <div style="font-size:13px;color:var(--text2,#666);margin-bottom:10px;">
          <strong>"${_esc(cat)}"</strong>${sub ? ` → ${_esc(sub)}` : ''}<br/>להוסיף לרשימת הקטגוריות?
        </div>
        <div style="display:flex;gap:6px;flex-wrap:wrap;">
          <button data-act="accept" class="btn-primary" style="padding:6px 14px;font-size:13px;">הוסף לרשימה</button>
          <button data-act="dismiss" style="padding:6px 10px;font-size:13px;border:1px solid var(--border,#ccc);background:#fff;border-radius:8px;cursor:pointer;">לא תודה</button>
        </div>
      </div>
    </div>`;
  document.body.appendChild(banner);

  const acceptFn = () => {
    addCategory(cat, { source: 'ai' });
    if (sub) addSubcategory(cat, sub, { source: 'ai' });
    removeAISuggestionBanner();
    if (typeof showToast === 'function') showToast(`נוספה קטגוריה: ${cat}`);
  };
  banner.querySelector('[data-act="accept"]').onclick = acceptFn;
  banner.querySelector('[data-act="dismiss"]').onclick = removeAISuggestionBanner;

  _bannerCountdown(banner, () => {
    const decision = (typeof getAiSuggestionDefault === 'function') ? getAiSuggestionDefault() : 'accept';
    if (decision === 'accept') acceptFn();
    else removeAISuggestionBanner();
  }) || setTimeout(removeAISuggestionBanner, 30000);
}

function showAddSubcategoryPrompt(cat, sub) {
  removeAISuggestionBanner();
  const banner = document.createElement('div');
  banner.id = 'ai-suggestion-banner';
  banner.style.cssText = 'position:fixed;bottom:24px;left:50%;transform:translateX(-50%);background:#fff;border:2px solid var(--accent,#3B82F6);border-radius:12px;box-shadow:0 12px 32px rgba(0,0,0,0.18);padding:16px 20px;z-index:9999;max-width:420px;direction:rtl;';
  banner.innerHTML = `
    <div style="display:flex;align-items:flex-start;gap:12px;">
      <div style="font-size:24px;">AI</div>
      <div style="flex:1;">
        <div style="font-weight:600;margin-bottom:4px;">ה-AI זיהה תת-ענף חדש</div>
        <div style="font-size:13px;color:var(--text2,#666);margin-bottom:10px;">
          ${_esc(cat)} → <strong>"${_esc(sub)}"</strong>
        </div>
        <div style="display:flex;gap:6px;flex-wrap:wrap;">
          <button data-act="accept" class="btn-primary" style="padding:6px 14px;font-size:13px;">הוסף</button>
          <button data-act="rename" style="padding:6px 14px;font-size:13px;border:1px solid var(--border,#ccc);background:#fff;border-radius:8px;cursor:pointer;">שנה שם</button>
          <button data-act="dismiss" style="padding:6px 10px;font-size:13px;border:1px solid var(--border,#ccc);background:#fff;border-radius:8px;cursor:pointer;">✕</button>
        </div>
      </div>
    </div>`;
  document.body.appendChild(banner);

  banner.querySelector('[data-act="accept"]').onclick = () => acceptAISubcategory(cat, sub);
  banner.querySelector('[data-act="rename"]').onclick = () => renameAISubcategory(cat, sub);
  banner.querySelector('[data-act="dismiss"]').onclick = removeAISuggestionBanner;

  _bannerCountdown(banner, () => {
    const decision = (typeof getAiSuggestionDefault === 'function') ? getAiSuggestionDefault() : 'accept';
    if (decision === 'accept') acceptAISubcategory(cat, sub);
    else removeAISuggestionBanner();
  }) || setTimeout(removeAISuggestionBanner, 30000);
}

function acceptAISubcategory(cat, sub) {
  addSubcategory(cat, sub, { source: 'ai' });
  removeAISuggestionBanner();
  if (typeof showToast === 'function') showToast(`נוסף: ${sub}`);
}

function renameAISubcategory(cat, suggested) {
  const name = prompt('שנה שם:', suggested);
  if (!name) return;
  addSubcategory(cat, name.trim(), { source: 'ai' });
  removeAISuggestionBanner();
  if (typeof showToast === 'function') showToast(`נוסף: ${name}`);
}

function removeAISuggestionBanner() {
  const b = document.getElementById('ai-suggestion-banner');
  if (b) b.remove();
}

// ─── GLOBAL REFRESH ─────────────────────────────────────────────────────
function renderAllCategoryTabs() {
  updateCategoryDropdowns();
  updateTabFilters();
  updateSearchFilters();
  updateDashboardCards();
}

function updateCategoryDropdowns() {
  const catSel = document.getElementById('fm-cat');
  const subSel = document.getElementById('fm-subcat');
  if (catSel) {
    populateCategoryDropdown(catSel, catSel.value);
    if (subSel) {
      const keep = subSel.value && subSel.value !== '__add__' ? subSel.value : '';
      populateSubcategoryDropdown(subSel, catSel.value, keep);
    }
  }
  const eCatSel = document.getElementById('ed-cat');
  const eSubSel = document.getElementById('ed-sub');
  if (eCatSel) {
    populateCategoryDropdown(eCatSel, eCatSel.value);
    if (eSubSel) {
      const keep = eSubSel.value && eSubSel.value !== '__add__' ? eSubSel.value : '';
      populateSubcategoryDropdown(eSubSel, eCatSel.value, keep);
    }
  }
}

function updateTabFilters() {
  document.querySelectorAll('[data-category-page]').forEach(page => {
    const cat = page.dataset.categoryPage;
    const filterRow = page.querySelector('.subcat-chips');
    if (filterRow) renderSubcategoryChips(filterRow, cat);
  });
}

function renderSubcategoryChips(row, cat) {
  const subs = getSubcategories(cat);
  const active = row.dataset.activeSub || 'הכל';
  let html = `<button class="chip ${active === 'הכל' ? 'active' : ''}" onclick="filterSubChip(this,'הכל','${_attr(cat)}')">הכל</button>`;
  html += subs.map(s => {
    const badge = isSubcategoryNew(s) ? ' [חדש]' : '';
    return `<button class="chip ${active === s.name ? 'active' : ''}" onclick="filterSubChip(this,'${_attr(s.name)}','${_attr(cat)}')">${_esc(s.name)}${badge}</button>`;
  }).join('');
  html += `<button class="chip" title="ניהול תתי-ענפים" onclick="openSubcategoryManager('${_attr(cat)}')" style="background:transparent;border:1px dashed var(--border,#ccc);">+</button>`;
  row.innerHTML = html;
}

function filterSubChip(btn, sub, cat) {
  const row = btn.closest('.subcat-chips');
  if (!row) return;
  row.dataset.activeSub = sub;
  row.querySelectorAll('.chip').forEach(c => c.classList.remove('active'));
  btn.classList.add('active');
  // Apply filter to docs in this category page
  const page = row.closest('[data-category-page]');
  const list = page ? page.querySelector('.doc-list') : null;
  if (!list) return;
  list.querySelectorAll('.doc-card').forEach(c => {
    const ok = sub === 'הכל' || c.dataset.sub === sub;
    c.style.display = ok ? '' : 'none';
  });
}

function updateSearchFilters() {
  // Hook for search-bar category chips. If a #searchCategoryChips row exists, repopulate.
  const row = document.getElementById('searchCategoryChips');
  if (!row) return;
  const names = getCategoryNames();
  row.innerHTML = `<button class="chip active" onclick="filterSearchByCat(this,'הכל')">הכל</button>` +
    names.map(n => `<button class="chip" onclick="filterSearchByCat(this,'${_attr(n)}')">${_esc(n)}</button>`).join('');
}

function filterSearchByCat(btn, cat) {
  const row = btn.parentElement;
  row.querySelectorAll('.chip').forEach(c => c.classList.remove('active'));
  btn.classList.add('active');
  document.querySelectorAll('.doc-card').forEach(c => {
    c.style.display = (cat === 'הכל' || c.dataset.cat === cat) ? '' : 'none';
  });
}

function updateDashboardCards() {
  // Hook for dashboard. Currently a no-op — categories don't drive dashboard cards.
  // Kept here for the documented contract: adding/removing cats → refresh dashboard.
}

