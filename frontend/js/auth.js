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
    client.auth.onAuthStateChange((event, session) => {
      currentSession = session;
      // When the user clicks the password-reset email link, Supabase fires
      // PASSWORD_RECOVERY with a temporary recovery session. The app should
      // show the "set new password" modal instead of normal login.
      if (event === 'PASSWORD_RECOVERY' && typeof window.onPasswordRecovery === 'function') {
        window.onPasswordRecovery(session);
      }
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

  // Send a password-reset email. Supabase emails the user a magic link that
  // returns to our site with `type=recovery` in the URL hash.
  async function sendPasswordResetEmail(email) {
    const redirectTo = window.location.origin + window.location.pathname;
    const { error } = await client.auth.resetPasswordForEmail(email, { redirectTo });
    if (error) throw error;
  }

  // Update the current user's password. Must be called while a recovery
  // session is active (after clicking the email link).
  async function updatePassword(newPassword) {
    const { data, error } = await client.auth.updateUser({ password: newPassword });
    if (error) throw error;
    return data;
  }

  window.KlaserAuth = {
    init, signUp, signIn, signOut,
    getToken, getUser, isLoggedIn, refreshToken,
    sendPasswordResetEmail, updatePassword,
    _client: client,
  };
})();
