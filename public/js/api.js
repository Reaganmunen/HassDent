/**
 * HassDent frontend core: session storage + fetch wrapper for the API.
 * Loaded on every page BEFORE the page's own script:  <script src="/js/api.js"></script>
 * Exposes one global:  HD  { api, Session, logout, config }
 */
(function (global) {
  'use strict';

  const config = {
    API_BASE: '/api/v1',
    LOGIN_PAGE: '/login.html',
    HOME_PAGE: '/dashboard.html', // where a successful login lands (built next)
    SESSION_KEY: 'hassdent.session',
  };

  class ApiError extends Error {
    constructor(message, status, code, details) {
      super(message);
      this.name = 'ApiError';
      this.status = status;
      this.code = code;
      this.details = details;
    }
  }

  // ---- session: { access_token, refresh_token, user } ----------------------------------------
  // "Remember me" -> localStorage (survives closing the browser); otherwise sessionStorage (this tab only).
  const Session = {
    _store() {
      if (localStorage.getItem(config.SESSION_KEY)) return localStorage;
      if (sessionStorage.getItem(config.SESSION_KEY)) return sessionStorage;
      return null;
    },
    get() {
      const s = this._store();
      if (!s) return null;
      try { return JSON.parse(s.getItem(config.SESSION_KEY)); } catch (e) { return null; }
    },
    /** remember: true/false on login; leave undefined on token refresh to keep the current storage. */
    save(data, remember) {
      const current = this._store();
      const target = remember === undefined ? (current || sessionStorage) : (remember ? localStorage : sessionStorage);
      localStorage.removeItem(config.SESSION_KEY);
      sessionStorage.removeItem(config.SESSION_KEY);
      target.setItem(config.SESSION_KEY, JSON.stringify(data));
    },
    clear() {
      localStorage.removeItem(config.SESSION_KEY);
      sessionStorage.removeItem(config.SESSION_KEY);
    },
    user() { const s = this.get(); return s ? s.user : null; },
    can(permission) { const u = this.user(); return Boolean(u && u.permissions && u.permissions.includes(permission)); },
  };

  // ---- fetch wrapper ------------------------------------------------------------------------
  let refreshing = null; // refresh tokens are single-use, so concurrent 401s must share ONE refresh call

  function refreshSession() {
    if (refreshing) return refreshing;
    const s = Session.get();
    if (!s || !s.refresh_token) return Promise.reject(new ApiError('Session expired', 401, 'NO_SESSION'));
    refreshing = fetch(config.API_BASE + '/auth/refresh', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ refresh_token: s.refresh_token }),
    })
      .then(async (res) => {
        const p = await res.json().catch(() => null);
        if (!res.ok || !p || !p.success) throw new ApiError('Session expired', res.status, 'REFRESH_INVALID');
        Session.save({ ...s, access_token: p.data.access_token, refresh_token: p.data.refresh_token });
      })
      .finally(() => { refreshing = null; });
    return refreshing;
  }

  function toLogin() {
    Session.clear();
    if (location.pathname.replace(/\.html$/, '') !== config.LOGIN_PAGE.replace(/\.html$/, '')) {
      location.replace(config.LOGIN_PAGE);
    }
  }

  /**
   * api('/products?limit=20')                      -> resolves to response.data
   * api('/auth/login', { method:'POST', body, auth:false })
   * api('/products', { full:true })                -> resolves to { success, data, meta }
   * Rejects with ApiError { message, status, code }.
   */
  async function api(path, { method = 'GET', body, auth = true, full = false, _retried = false } = {}) {
    const headers = { Accept: 'application/json' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const session = Session.get();
    if (auth && session && session.access_token) headers.Authorization = 'Bearer ' + session.access_token;

    let res;
    try {
      res = await fetch(config.API_BASE + path, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
    } catch (e) {
      throw new ApiError('Cannot reach the server. Check your connection and try again.', 0, 'NETWORK_ERROR');
    }

    const payload = await res.json().catch(() => null);

    if (res.ok && payload && payload.success) return full ? payload : payload.data;

    const err = payload && payload.error ? payload.error : {};
    if (auth && res.status === 401 && err.code === 'TOKEN_EXPIRED' && !_retried) {
      try { await refreshSession(); } catch (e) { toLogin(); throw new ApiError('Session expired, please log in again', 401, 'REFRESH_INVALID'); }
      return api(path, { method, body, auth, full, _retried: true });
    }
    if (auth && res.status === 401) { toLogin(); }

    throw new ApiError(err.message || 'Something went wrong. Please try again.', res.status, err.code || 'UNKNOWN', err.details);
  }

  async function logout() {
    const s = Session.get();
    try { if (s) await api('/auth/logout', { method: 'POST', body: { refresh_token: s.refresh_token } }); } catch (e) { /* leave anyway */ }
    Session.clear();
    location.replace(config.LOGIN_PAGE);
  }

  global.HD = { api, ApiError, Session, logout, config };
})(window);
