// ─── Klaser Auth (Supabase) ───
// Manages user session, login, signup, logout. Exposes window.KlaserAuth.
(function () {
  const cfg = window.KLASER_CONFIG;
  if (!window.supabase) {
    console.error('Supabase JS SDK not loaded');
    return;
  }
  const client = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY, {
    auth: { persistSession: true, autoRefreshToken: true },
  });

  let currentSession = null;

  async function init() {
    const { data } = await client.auth.getSession();
    currentSession = data.session;
    client.auth.onAuthStateChange((_event, session) => {
      currentSession = session;
      if (typeof window.onAuthChange === 'function') window.onAuthChange(session);
    });
    return currentSession;
  }

  async function signUp(email, password) {
    const { data, error } = await client.auth.signUp({ email, password });
    if (error) throw error;
    return data;
  }

  async function signIn(email, password) {
    const { data, error } = await client.auth.signInWithPassword({ email, password });
    if (error) throw error;
    currentSession = data.session;
    return data;
  }

  async function signOut() {
    await client.auth.signOut();
    currentSession = null;
  }

  function getToken() {
    return currentSession?.access_token || null;
  }

  function getUser() {
    return currentSession?.user || null;
  }

  function isLoggedIn() {
    return !!currentSession;
  }

  async function refreshToken() {
    const { data } = await client.auth.refreshSession();
    currentSession = data.session;
    return currentSession;
  }

  window.KlaserAuth = {
    init, signUp, signIn, signOut,
    getToken, getUser, isLoggedIn, refreshToken,
    _client: client,
  };
})();
