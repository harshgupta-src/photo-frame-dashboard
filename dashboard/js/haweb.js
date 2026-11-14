// Home Assistant straight from the browser, for the dashboard installed on phones (IPHONE.md). The
// frame reaches HA through the kiosk's window.HomeHQ bridge instead (ha.js). Each person signs in
// with their own HA account through HA's built-in OAuth (no app registration: the client id is the
// dashboard's own URL), or pastes a long-lived token. The tokens stay in this device's storage.
// HA must list the dashboard's origin in its CORS origins (IPHONE.md).
// Free of DOM APIs apart from what's passed in, so node --test can run it (test/haweb.test.js).

// Same requests the kiosk bridge allows (kiosk MainActivity HA_GET / HA_POST), so the phone can do
// exactly what the frame can.
var HA_GET = /^\/api\/(config|states|states\/[a-z0-9_]+\.[a-z0-9_]+|calendars\/calendar\.[a-z0-9_]+\?start=[0-9A-Za-z:.%+-]+&end=[0-9A-Za-z:.%+-]+)$/;
var HA_POST = /^(\/api\/services\/(light|switch|fan|climate|media_player|vacuum|scene|script)\/[a-z0-9_]+|\/api\/services\/todo\/update_item|\/api\/services\/todo\/get_items\?return_response)$/;

export var AUTH_KEY = 'ha-auth-v1';
export var STATE_KEY = 'ha-oauth-state';
var EARLY_MS = 60000; // refresh this long before the access token expires

export function allowed(method, path) {
  return (method === 'GET' && HA_GET.test(path)) || (method === 'POST' && HA_POST.test(path));
}

export function authorizeUrl(haUrl, clientId, redirectUri, state) {
  return haUrl + '/auth/authorize?response_type=code&client_id=' + encodeURIComponent(clientId) +
    '&redirect_uri=' + encodeURIComponent(redirectUri) + '&state=' + encodeURIComponent(state);
}

// opts: { haUrl, clientId, storage, fetch, now }. storage is localStorage-like; fetch and now are
// injectable for tests.
export function createWebHA(opts) {
  var haUrl = opts.haUrl.replace(/\/+$/, ''), storage = opts.storage, doFetch = opts.fetch;
  var now = opts.now || function () { return Date.now(); };
  var refreshing = null;

  function load() {
    try { return JSON.parse(storage.getItem(AUTH_KEY) || 'null'); } catch (e) { return null; }
  }
  function save(a) {
    if (a) storage.setItem(AUTH_KEY, JSON.stringify(a)); else storage.removeItem(AUTH_KEY);
  }
  function form(params) {
    return Object.keys(params).map(function (k) { return encodeURIComponent(k) + '=' + encodeURIComponent(params[k]); }).join('&');
  }
  function token(params) {
    return doFetch(haUrl + '/auth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form(Object.assign({ client_id: opts.clientId }, params)),
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) {
        if (!r.ok || !j.access_token) {
          var e = new Error(j.error_description || j.error || 'HA sign-in failed (' + r.status + ')');
          e.status = r.status;
          throw e;
        }
        return j;
      });
    });
  }

  function refresh() {
    var a = load();
    if (!a || !a.refresh) return Promise.reject(new Error('signed out'));
    if (!refreshing) {
      refreshing = token({ grant_type: 'refresh_token', refresh_token: a.refresh }).then(function (j) {
        a.access = j.access_token;
        a.expires = now() + j.expires_in * 1000;
        save(a);
        return a.access;
      }, function (e) {
        // 400 means HA refused the refresh token (revoked or expired): sign out. Anything else
        // (offline, HA restarting) keeps it for the next try.
        if (e.status === 400) { save(null); e = new Error('signed out'); }
        throw e;
      }).then(function (t) { refreshing = null; return t; }, function (e) { refreshing = null; throw e; });
    }
    return refreshing;
  }

  function access() {
    var a = load();
    if (!a) return Promise.reject(new Error('signed out'));
    if (a.longLived || (a.access && a.expires - EARLY_MS > now())) return Promise.resolve(a.access);
    return refresh();
  }

  function call(method, path, body) {
    if (!allowed(method, path)) return Promise.reject(new Error('request not allowed'));
    function send(t) {
      var init = { method: method, headers: { Authorization: 'Bearer ' + t } };
      if (method === 'POST') { init.headers['Content-Type'] = 'application/json'; init.body = JSON.stringify(body || {}); }
      return doFetch(haUrl + path, init);
    }
    return access().then(send).then(function (r) {
      if (r.status !== 401) return r;
      var a = load();
      if (!a || a.longLived) { save(null); throw new Error('signed out'); }
      return refresh().then(send);
    }).then(function (r) {
      if (r.status === 401) { save(null); throw new Error('signed out'); }
      if (!r.ok) throw new Error('HA ' + r.status);
      return r.text().then(function (t) { return t ? JSON.parse(t) : null; });
    });
  }

  return {
    signedIn: function () { return !!load(); },
    call: call,
    // The ?code= HA redirected back with, swapped for tokens.
    exchange: function (code) {
      return token({ grant_type: 'authorization_code', code: code }).then(function (j) {
        save({ access: j.access_token, refresh: j.refresh_token, expires: now() + j.expires_in * 1000 });
      });
    },
    useToken: function (t) {
      t = String(t || '').trim();
      if (!t) return Promise.reject(new Error('empty token'));
      return doFetch(haUrl + '/api/config', { headers: { Authorization: 'Bearer ' + t } }).then(function (r) {
        if (!r.ok) throw new Error(r.status === 401 ? 'Home Assistant refused that token' : 'HA ' + r.status);
        save({ access: t, longLived: true });
      });
    },
    signOut: function () {
      var a = load();
      save(null);
      // Revoke the refresh token too (best effort).
      if (a && a.refresh) return doFetch(haUrl + '/auth/revoke', {
        method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: form({ token: a.refresh }),
      }).then(function () {}, function () {});
      return Promise.resolve();
    },
  };
}
