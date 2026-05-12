// ═══════════════════════════════════════════════════════════════════════════
// Klaser preference sync — bridges localStorage ⇄ Supabase (`user_preferences`).
// ─────────────────────────────────────────────────────────────────────────
// Why: until now the user's categories, custom tabs, sub-branches and UI
// state lived only in localStorage. That meant a fresh browser/device saw
// none of the user's customisations. This module keeps everything in
// localStorage (so the rest of the app keeps working unchanged) but mirrors
// each write back to the server via `KlaserAPI.putPreference`. On login we
// hydrate from the server first, so the local cache is warm before any
// renderer runs.
//
// Design: monkey-patch `Storage.prototype.setItem` for a fixed allow-list
// of keys. This avoids touching dozens of call sites scattered across the
// codebase. Writes are debounced per server-key so rapid edits coalesce.
//
// Server schema: see backend/routes/preferences.py (ALLOWED_KEYS).
// ═══════════════════════════════════════════════════════════════════════════
(function () {
  // ─── Local → server key mapping (1:1 keys) ───────────────────────────
  const KEY_MAP = {
    'klaser_categories':     'categories',
    'klaser_custom_tabs':    'custom_tabs',
    'tabOrder':              'tab_order',
    'klaser_user_settings':  'user_settings',
    'klaser_alerts_handled': 'alerts_handled',
    'klaser_alerts_pending': 'alerts_pending',
    'klaser_avatar_color':   'avatar_color',
    'klaser_people':         'people',
  };
  // All `subBranches_<cat>` keys roll up into one server key `sub_branches`.
  const SUB_BRANCHES_PREFIX = 'subBranches_';
  const SUB_BRANCHES_SERVER_KEY = 'sub_branches';

  // ─── Internal state ──────────────────────────────────────────────────
  // _hydrated: have we pulled server state at least once? Until true, we
  //   do NOT push local writes back — otherwise a fresh page load would
  //   overwrite the server with stale localStorage data from a logged-out
  //   session.
  // _suspended: counter used to disable the monkey-patch during hydrate
  //   itself, so writes from the server don't bounce back as syncs.
  const state = {
    _hydrated: false,
    _suspended: 0,
    _queue: new Map(), // serverKey → { value, timer }
  };

  // ─── Helpers ─────────────────────────────────────────────────────────
  function _canSync() {
    if (!state._hydrated || state._suspended > 0) return false;
    const auth = window.KlaserAuth;
    if (!auth || typeof auth.getToken !== 'function') return false;
    return !!auth.getToken();
  }

  function _parseMaybe(raw) {
    if (raw == null) return null;
    if (typeof raw !== 'string') return raw;
    try { return JSON.parse(raw); } catch { return raw; }
  }

  function _collectAllSubBranches() {
    const out = {};
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (!k || !k.startsWith(SUB_BRANCHES_PREFIX)) continue;
      const cat = k.slice(SUB_BRANCHES_PREFIX.length);
      const parsed = _parseMaybe(localStorage.getItem(k));
      if (Array.isArray(parsed)) out[cat] = parsed;
    }
    return out;
  }

  function _flushSoon(serverKey, value) {
    const existing = state._queue.get(serverKey);
    if (existing) clearTimeout(existing.timer);
    state._queue.set(serverKey, {
      value,
      timer: setTimeout(() => {
        const item = state._queue.get(serverKey);
        state._queue.delete(serverKey);
        if (!item) return;
        if (!window.KlaserAPI) return;
        KlaserAPI.putPreference(serverKey, item.value).catch(err => {
          console.warn('[prefs_sync] PUT', serverKey, 'failed:', err.message || err);
        });
      }, 800),
    });
  }

  function _onLocalWrite(lsKey, rawValue) {
    if (!_canSync()) return;
    if (KEY_MAP[lsKey]) {
      _flushSoon(KEY_MAP[lsKey], _parseMaybe(rawValue));
      return;
    }
    if (lsKey.startsWith(SUB_BRANCHES_PREFIX)) {
      // Bundle ALL sub-branches together so the server stays consistent
      // even if multiple categories change in the same tick.
      _flushSoon(SUB_BRANCHES_SERVER_KEY, _collectAllSubBranches());
    }
  }

  // ─── Monkey-patch setItem ────────────────────────────────────────────
  const origSetItem = Storage.prototype.setItem;
  Storage.prototype.setItem = function (key, value) {
    origSetItem.call(this, key, value);
    // Only mirror writes to LOCALstorage (not sessionStorage).
    if (this === window.localStorage) {
      try { _onLocalWrite(key, value); } catch (e) {
        console.warn('[prefs_sync] mirror failed:', e);
      }
    }
  };

  // Also catch deletes for our managed keys so the server can clear them.
  const origRemoveItem = Storage.prototype.removeItem;
  Storage.prototype.removeItem = function (key) {
    origRemoveItem.call(this, key);
    if (this !== window.localStorage) return;
    if (!_canSync()) return;
    if (KEY_MAP[key]) {
      // Treat removal as a write of `null` — simpler than a DELETE round-trip.
      _flushSoon(KEY_MAP[key], null);
    } else if (key.startsWith(SUB_BRANCHES_PREFIX)) {
      _flushSoon(SUB_BRANCHES_SERVER_KEY, _collectAllSubBranches());
    }
  };

  // ─── Public API ──────────────────────────────────────────────────────
  /**
   * Pull every preference from the server and seed localStorage. Called
   * once on app start after auth is ready. Safe to call again (idempotent
   * apart from cache warming).
   */
  async function hydrate() {
    if (!window.KlaserAPI) return;
    state._suspended++;
    try {
      const data = await KlaserAPI.listPreferences();
      // 1:1 keys
      for (const [lsKey, srvKey] of Object.entries(KEY_MAP)) {
        if (!(srvKey in data) || data[srvKey] == null) continue;
        const raw = typeof data[srvKey] === 'string'
          ? data[srvKey]
          : JSON.stringify(data[srvKey]);
        origSetItem.call(localStorage, lsKey, raw);
      }
      // sub_branches: { cat: [..], ... } → many subBranches_<cat> keys
      const sb = data[SUB_BRANCHES_SERVER_KEY];
      if (sb && typeof sb === 'object') {
        for (const [cat, list] of Object.entries(sb)) {
          origSetItem.call(localStorage, SUB_BRANCHES_PREFIX + cat, JSON.stringify(list));
        }
      }
      state._hydrated = true;
    } catch (e) {
      console.warn('[prefs_sync] hydrate failed:', e.message || e);
      // Even on failure, mark hydrated so subsequent local writes still
      // attempt to push (better to overwrite empty server state than to
      // silently lose user changes forever).
      state._hydrated = true;
    } finally {
      state._suspended--;
    }
  }

  /** Clear hydrated flag (call on logout so a different user can hydrate). */
  function reset() {
    state._hydrated = false;
    state._queue.forEach(item => clearTimeout(item.timer));
    state._queue.clear();
  }

  /** Force-flush any pending debounced writes immediately. */
  async function flushNow() {
    const pending = [...state._queue.entries()];
    state._queue.forEach(item => clearTimeout(item.timer));
    state._queue.clear();
    if (!window.KlaserAPI) return;
    await Promise.allSettled(
      pending.map(([k, v]) => KlaserAPI.putPreference(k, v.value))
    );
  }

  window.KlaserPrefs = { hydrate, reset, flushNow };
})();
