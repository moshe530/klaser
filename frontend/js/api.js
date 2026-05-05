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
    analyzeDocument: (id, categories = null) => request(
      `/documents/${id}/analyze`,
      {
        method: 'POST',
        body: JSON.stringify(categories ? { categories } : {}),
      },
    ),

    // Reminders
    listReminders: () => request('/reminders'),
    createReminder: (payload) => request('/reminders', { method: 'POST', body: JSON.stringify(payload) }),
    updateReminder: (id, patch) => request(`/reminders/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),
    deleteReminder: (id) => request(`/reminders/${id}`, { method: 'DELETE' }),
  };
})();
