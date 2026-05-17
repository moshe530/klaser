// ─── Klaser API Client ───
(function () {
  const cfg = window.KLASER_CONFIG;

  function authHeaders(includeContentType = true) {
    const h = {};
    if (includeContentType) h['Content-Type'] = 'application/json';
    const token = window.KlaserAuth && window.KlaserAuth.getToken();
    if (token) h['Authorization'] = 'Bearer ' + token;
    return h;
  }

  async function request(path, opts = {}) {
    const res = await fetch(cfg.API_URL + path, {
      ...opts,
      headers: { ...authHeaders(true), ...(opts.headers || {}) },
    });
    if (!res.ok) {
      let detail;
      try { detail = (await res.json()).detail; } catch { detail = res.statusText; }
      throw new Error(`API ${res.status}: ${JSON.stringify(detail)}`);
    }
    if (res.status === 204) return null;
    return res.json();
  }

  window.KlaserAPI = {
    health: () => request('/health'),

    // Documents
    listDocuments: () => request('/documents'),
    createDocument: (payload) => request('/documents', { method: 'POST', body: JSON.stringify(payload) }),
    updateDocument: (id, patch) => request(`/documents/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),
    deleteDocument: (id) => request(`/documents/${id}`, { method: 'DELETE' }),

    // File attachments
    uploadFile: async (id, file) => {
      const fd = new FormData();
      fd.append('file', file);
      const res = await fetch(cfg.API_URL + `/documents/${id}/file`, {
        method: 'POST',
        headers: authHeaders(false), // לא Content-Type — דפדפן יוסיף boundary
        body: fd,
      });
      if (!res.ok) {
        let detail; try { detail = (await res.json()).detail; } catch { detail = res.statusText; }
        throw new Error(`Upload ${res.status}: ${JSON.stringify(detail)}`);
      }
      return res.json();
    },
    getFileUrl: (id) => request(`/documents/${id}/file-url`),
    analyzeDocument: (id, categories = null, people = null, accountType = 'personal', subcategories = null, profiles = null) => {
      const body = { account_type: accountType };
      if (categories) body.categories = categories;
      if (people && people.length) body.people = people;
      // Rich family-profiles (with id_number) — the backend matcher uses
      // these AFTER the AI runs to write `assigned_profile_id` with a
      // confidence score. See profile_matcher.py.
      if (profiles && profiles.length) body.profiles = profiles;
      if (subcategories && typeof subcategories === 'object' && Object.keys(subcategories).length) {
        body.subcategories = subcategories;
      }
      return request(`/documents/${id}/analyze`, {
        method: 'POST',
        body: JSON.stringify(body),
      });
    },
    // Confirm/reject a 'suggested' (medium-confidence) AI assignment.
    // action: 'confirm' | 'reject'. When rejecting, optionally pass
    // {profile_id, profile_name} to replace with a manual pick in one step.
    confirmAssignment: (id, action, replacement = null) => {
      const body = { action };
      if (replacement && replacement.profile_id) {
        body.profile_id = replacement.profile_id;
        body.profile_name = replacement.profile_name || null;
      }
      return request(`/documents/${id}/confirm-assignment`, {
        method: 'POST',
        body: JSON.stringify(body),
      });
    },
    // Back-fill: find existing documents that may belong to a newly-added
    // family profile. Returns {matches: [{document_id, confidence, ...}]}.
    matchProfileDocuments: (profile, minConfidence = 'medium') => request(
      '/documents/match-profile',
      { method: 'POST', body: JSON.stringify({ profile, min_confidence: minConfidence }) }
    ),
    // Retroactively rebuild names of existing documents into a canonical
    // form so similar docs look similar. Cheap — no AI calls. Pass
    // {dry_run:true} to preview the changes before applying.
    recanonicalizeDocuments: (opts = {}) => request(
      '/documents/recanonicalize',
      { method: 'POST', body: JSON.stringify(opts) }
    ),

    // Account
    getAccountUsage: () => request('/api/account/usage'),
    deleteAccount: () => request('/api/account/delete', { method: 'DELETE' }),

    // Preferences (cross-device persisted user state)
    listPreferences: () => request('/api/preferences'),
    getPreference: (key) => request(`/api/preferences/${encodeURIComponent(key)}`),
    putPreference: (key, value) => request(`/api/preferences/${encodeURIComponent(key)}`, {
      method: 'PUT', body: JSON.stringify({ value }),
    }),
    deletePreference: (key) => request(`/api/preferences/${encodeURIComponent(key)}`, { method: 'DELETE' }),

    // Reminders
    listReminders: () => request('/reminders'),
    createReminder: (payload) => request('/reminders', { method: 'POST', body: JSON.stringify(payload) }),
    updateReminder: (id, patch) => request(`/reminders/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),
    deleteReminder: (id) => request(`/reminders/${id}`, { method: 'DELETE' }),
  };
})();
