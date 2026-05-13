// ═══════════════════════════════════════════════════════════════════════════
// Command Palette (Ctrl+K / Cmd+K)
// ─────────────────────────────────────────────────────────────────────────
// Full-text search across the user's documents and reminders, plus quick
// actions (new document, open a tab, etc.). Purely client-side — uses the
// already-loaded `window.docs` / `window.reminders` arrays. A backend
// endpoint isn't needed because those collections are small and already
// resident for the UI.
//
// Keyboard:
//   Ctrl+K / Cmd+K   → open
//   Esc              → close
//   ↑ / ↓            → navigate results
//   Enter            → activate focused result
//
// Design: kept in its own file so it doesn't bloat app.js and can be
// independently swapped out (e.g., for a server-side search later).
// ═══════════════════════════════════════════════════════════════════════════
(function () {
  const MAX_RESULTS_PER_SECTION = 6;

  let activeIndex = 0;        // index within the currently-rendered flat list
  let flatResults = [];       // [{kind, ...}] in render order — for Enter/arrows

  // ─── Public entry points ────────────────────────────────────────────────
  function openCommandPalette() {
    const overlay = document.getElementById('cmdkOverlay');
    const input = document.getElementById('cmdkInput');
    if (!overlay || !input) return;
    overlay.classList.add('open');
    input.value = '';
    renderResults('');
    // Defer focus so the input is actually visible — otherwise some browsers
    // swallow the focus.
    setTimeout(() => input.focus(), 10);
  }

  function closeCommandPalette() {
    const overlay = document.getElementById('cmdkOverlay');
    if (overlay) overlay.classList.remove('open');
  }

  // ─── Search helpers ─────────────────────────────────────────────────────
  function _scoreMatch(haystack, needle) {
    // Tiny scoring helper: exact substring match wins, word-start bonus,
    // else falls back to fuzzy char-sequence presence. Good enough for a
    // few hundred docs; replace with a real fuzzy lib if the dataset grows.
    if (!haystack || !needle) return 0;
    const h = haystack.toLowerCase();
    const n = needle.toLowerCase();
    if (h === n) return 1000;
    if (h.startsWith(n)) return 500;
    const idx = h.indexOf(n);
    if (idx === 0) return 400;
    if (idx > 0) return 200 - idx;
    // Fuzzy fallback: every char of needle appears in order somewhere.
    let i = 0;
    for (const c of h) {
      if (c === n[i]) i++;
      if (i >= n.length) return 50;
    }
    return 0;
  }

  function _searchDocs(query) {
    const arr = Array.isArray(window.docs) ? window.docs : [];
    if (!arr.length) return [];
    if (!query) return arr.slice(0, MAX_RESULTS_PER_SECTION);
    const results = [];
    for (const d of arr) {
      const name = d.name || '';
      const cat = d.cat || d.category || '';
      const sub = d.sub || d.sub_category || '';
      const tags = Array.isArray(d.tags) ? d.tags.join(' ') : '';
      const ocr = d.ocr_text || (d.aiData && d.aiData.raw_text) || '';
      const score = Math.max(
        _scoreMatch(name, query) * 1.5,
        _scoreMatch(cat, query),
        _scoreMatch(sub, query),
        _scoreMatch(tags, query),
        _scoreMatch(ocr.slice(0, 500), query) * 0.3, // OCR matches count less
      );
      if (score > 0) results.push({ score, doc: d });
    }
    results.sort((a, b) => b.score - a.score);
    return results.slice(0, MAX_RESULTS_PER_SECTION).map(r => r.doc);
  }

  function _searchReminders(query) {
    const arr = Array.isArray(window.reminders) ? window.reminders : [];
    if (!arr.length) return [];
    if (!query) return [];
    const results = [];
    for (const r of arr) {
      const score = Math.max(
        _scoreMatch(r.name || '', query) * 1.2,
        _scoreMatch(r.type || '', query),
      );
      if (score > 0) results.push({ score, rem: r });
    }
    results.sort((a, b) => b.score - a.score);
    return results.slice(0, MAX_RESULTS_PER_SECTION).map(r => r.rem);
  }

  function _quickActions(query) {
    // Static list — filtered by query so typing "הוסף" surfaces "הוסף מסמך".
    const all = [
      { id: 'add_doc',   icon: '➕', title: 'הוסף מסמך חדש',     tab: null, action: () => (typeof openModal === 'function') && openModal('add') },
      { id: 'tab_docs',  icon: '📁', title: 'עבור למסמכים',        action: () => _switchTab('docs') },
      { id: 'tab_cal',   icon: '📅', title: 'עבור ללוח שנה',       action: () => _switchTab('calendar') },
      { id: 'tab_rem',   icon: '🔔', title: 'עבור לתזכורות',       action: () => _switchTab('reminders') },
      { id: 'tab_set',   icon: '⚙️', title: 'עבור להגדרות',        action: () => _switchTab('settings') },
      { id: 'add_rem',   icon: '🔔', title: 'תזכורת חדשה',         action: () => (typeof openModal === 'function') && openModal('reminder') },
      { id: 'add_tab',   icon: '🗂️', title: 'הוסף ענף מותאם',      action: () => (typeof showAddTabMenu === 'function') && showAddTabMenu() },
    ];
    if (!query) return all.slice(0, MAX_RESULTS_PER_SECTION);
    const q = query.toLowerCase();
    return all
      .map(a => ({ a, score: _scoreMatch(a.title, q) }))
      .filter(x => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, MAX_RESULTS_PER_SECTION)
      .map(x => x.a);
  }

  function _switchTab(tab) {
    const btn = document.querySelector(`.topnav-tab[onclick*="'${tab}'"]`);
    if (btn) btn.click();
    else if (typeof showTab === 'function') showTab(tab);
  }

  // ─── Rendering ──────────────────────────────────────────────────────────
  function renderResults(query) {
    const wrap = document.getElementById('cmdkResults');
    if (!wrap) return;

    const docs = _searchDocs(query);
    const reminders = _searchReminders(query);
    const actions = _quickActions(query);

    flatResults = [];
    let html = '';

    if (docs.length) {
      html += '<div class="cmdk-section-title">מסמכים</div>';
      docs.forEach(d => {
        flatResults.push({ kind: 'doc', doc: d });
        const sub = [d.cat, d.sub].filter(Boolean).join(' · ') || 'ללא קטגוריה';
        html += _renderItem(flatResults.length - 1, '📄', d.name || '(ללא שם)', sub, d.exp ? 'פג ' + d.exp : '');
      });
    }
    if (reminders.length) {
      html += '<div class="cmdk-section-title">תזכורות</div>';
      reminders.forEach(r => {
        flatResults.push({ kind: 'reminder', rem: r });
        const when = r.remind_at ? new Date(r.remind_at).toLocaleDateString('he-IL') : '';
        html += _renderItem(flatResults.length - 1, '🔔', r.name || '(תזכורת)', r.type || '', when);
      });
    }
    if (actions.length) {
      html += '<div class="cmdk-section-title">פעולות</div>';
      actions.forEach(a => {
        flatResults.push({ kind: 'action', action: a });
        html += _renderItem(flatResults.length - 1, a.icon, a.title, '', '');
      });
    }

    if (!flatResults.length) {
      html = '<div class="cmdk-empty">לא נמצאו תוצאות</div>';
    }

    wrap.innerHTML = html;
    activeIndex = 0;
    _highlight();
  }

  function _renderItem(idx, icon, title, sub, badge) {
    return `
      <div class="cmdk-item" data-idx="${idx}" onclick="CommandPalette._pick(${idx})" onmouseenter="CommandPalette._setActive(${idx})">
        <div class="cmdk-item-icon">${icon}</div>
        <div class="cmdk-item-body">
          <div class="cmdk-item-title">${_esc(title)}</div>
          ${sub ? `<div class="cmdk-item-sub">${_esc(sub)}</div>` : ''}
        </div>
        ${badge ? `<div class="cmdk-item-badge">${_esc(badge)}</div>` : ''}
      </div>`;
  }

  function _esc(s) {
    return String(s).replace(/[&<>"']/g, c => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
  }

  function _highlight() {
    const items = document.querySelectorAll('#cmdkResults .cmdk-item');
    items.forEach((el, i) => el.classList.toggle('active', i === activeIndex));
    const active = items[activeIndex];
    if (active) active.scrollIntoView({ block: 'nearest' });
  }

  function _setActive(i) { activeIndex = i; _highlight(); }

  function _pick(i) {
    const r = flatResults[i];
    if (!r) return;
    closeCommandPalette();
    if (r.kind === 'doc') {
      // Open the doc's edit modal. The function is `openEdit` in app.js
      // (not `openEditModal` — the latter never existed). Falls back to
      // a tab switch if app.js hasn't loaded for some reason.
      if (typeof openEdit === 'function') {
        openEdit(r.doc.id);
      } else if (typeof showTab === 'function') {
        showTab('docs');
      }
    } else if (r.kind === 'reminder') {
      _switchTab('reminders');
    } else if (r.kind === 'action') {
      try { r.action.action && r.action.action(); } catch (e) { console.warn(e); }
    }
  }

  // ─── Keyboard wiring ────────────────────────────────────────────────────
  document.addEventListener('keydown', (e) => {
    const overlay = document.getElementById('cmdkOverlay');
    const isOpen = overlay && overlay.classList.contains('open');

    // Global Ctrl/Cmd+K opens the palette from anywhere.
    //
    // IMPORTANT: we match on `e.code` (physical key location, e.g. "KeyK")
    // rather than `e.key` (the produced character). On a Hebrew layout the
    // physical K key produces the character 'ל', so an `e.key === 'k'` check
    // would silently miss Hebrew users — and the browser would then handle
    // Ctrl+K as its own shortcut (focus the address bar with a search prefix
    // in Chrome/Firefox). `e.code` is layout-independent.
    if ((e.ctrlKey || e.metaKey) && e.code === 'KeyK' && !e.shiftKey && !e.altKey) {
      e.preventDefault();
      e.stopPropagation();
      if (isOpen) closeCommandPalette(); else openCommandPalette();
      return;
    }

    if (!isOpen) return;
    if (e.key === 'Escape') { e.preventDefault(); closeCommandPalette(); return; }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (flatResults.length) {
        activeIndex = (activeIndex + 1) % flatResults.length;
        _highlight();
      }
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (flatResults.length) {
        activeIndex = (activeIndex - 1 + flatResults.length) % flatResults.length;
        _highlight();
      }
    } else if (e.key === 'Enter') {
      e.preventDefault();
      _pick(activeIndex);
    }
  });

  // Input updates (debounced — search is cheap but reflow is not).
  let inputTimer = null;
  document.addEventListener('input', (e) => {
    if (e.target && e.target.id === 'cmdkInput') {
      clearTimeout(inputTimer);
      inputTimer = setTimeout(() => renderResults(e.target.value.trim()), 80);
    }
  });

  // Expose globals (`onclick` handlers on items need them).
  window.openCommandPalette = openCommandPalette;
  window.closeCommandPalette = closeCommandPalette;
  window.CommandPalette = { _pick, _setActive };
})();
