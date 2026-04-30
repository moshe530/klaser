// ─── Klaser API Client ───
(function () {
  const cfg = window.KLASER_CONFIG;

  function headers() {
    return {
      'Content-Type': 'application/json',
      'X-Dev-User-Id': cfg.DEV_USER_ID,
    };
  }

  async function request(path, opts = {}) {
    const res = await fetch(cfg.API_URL + path, {
      ...opts,
      headers: { ...headers(), ...(opts.headers || {}) },
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
        headers: { 'X-Dev-User-Id': cfg.DEV_USER_ID }, // לא לציין Content-Type — דפדפן יוסיף boundary
        body: fd,
      });
      if (!res.ok) {
        let detail; try { detail = (await res.json()).detail; } catch { detail = res.statusText; }
        throw new Error(`Upload ${res.status}: ${JSON.stringify(detail)}`);
      }
      return res.json();
    },
    getFileUrl: (id) => request(`/documents/${id}/file-url`),
    analyzeDocument: (id) => request(`/documents/${id}/analyze`, { method: 'POST' }),

    // Reminders
    listReminders: () => request('/reminders'),
    createReminder: (payload) => request('/reminders', { method: 'POST', body: JSON.stringify(payload) }),
    deleteReminder: (id) => request(`/reminders/${id}`, { method: 'DELETE' }),
  };
})();
