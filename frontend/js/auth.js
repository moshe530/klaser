// ─── Klaser Auth (Supabase) ───
// Manages user session, login, signup, logout. Exposes window.KlaserAuth.

const TURNSTILE_SITE_KEY = '0x4AAAAAAAAADKm7CnBj4qQdKQh';

let captchaToken = null;

window.onTurnstileSuccess = function(token) {
  captchaToken = token;
};

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

  async function getCaptchaToken() {
    return null; // Turnstile disabled temporarily (Error 400020)
  }

  async function signUp(email, password, metadata) {
    const options = {};
    if (metadata && typeof metadata === 'object') {
      options.data = metadata;
    }
    const { data, error } = await client.auth.signUp({
      email,
      password,
      options
    });
    if (error) {
      console.error('signup error:', error);
      throw error;
    }
    // Detect duplicate signup: when email confirmation is on, Supabase returns
    // user with empty identities[] for existing emails (no error thrown).
    if (data && data.user && Array.isArray(data.user.identities) && data.user.identities.length === 0) {
      const err = new Error('USER_ALREADY_REGISTERED');
      err.code = 'USER_ALREADY_REGISTERED';
      throw err;
    }
    return data;
  }

  async function updateUserMetadata(metadata) {
    const { data, error } = await client.auth.updateUser({ data: metadata });
    if (error) throw error;
    return data;
  }

  async function signIn(email, password) {
    const { data, error } = await client.auth.signInWithPassword({
      email,
      password
    });
    if (error) {
      console.error('signin error:', error);
      throw error;
    }
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

  // Delete the current user's account by calling backend endpoint that uses
  // Supabase service role to fully remove the auth user + all their data.
  async function deleteAccount() {
    const token = getToken();
    if (!token) throw new Error('Not signed in');
    const apiBase = (cfg.API_URL || cfg.API_BASE_URL || '').replace(/\/$/, '');
    const res = await fetch(apiBase + '/api/account/delete', {
      method: 'DELETE',
      headers: { 'Authorization': 'Bearer ' + token },
    });
    if (!res.ok) {
      let msg = 'Account deletion failed';
      try { const j = await res.json(); if (j && j.detail) msg = j.detail; } catch {}
      throw new Error(msg);
    }
    await client.auth.signOut();
    currentSession = null;
    return true;
  }

  window.KlaserAuth = {
    init, signUp, signIn, signOut,
    getToken, getUser, isLoggedIn, refreshToken,
    sendPasswordResetEmail, updatePassword,
    updateUserMetadata, deleteAccount,
    _client: client,
  };
})();
