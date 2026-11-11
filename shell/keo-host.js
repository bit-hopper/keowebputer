// The way from this page to the desktop app that runs it (keo-desktop), SHELL side. The app answers a few reserved paths on its own
// address ('/.keo-host/lan' for the local network, '/.keo-host/file' for files where they lie) and takes a request only with a secret it
// pushes into this page's main frame. This file is the one place that reads the secret, so every module that talks to the app shares it.
//
// The secret is pushed when the document is ready, read here once, taken off `window` and kept in this closure. The world page is a
// different, sandboxed frame: it cannot read it, and no bridge op returns it. Without it the app answers 403.
// Where there is no app (the extension, a plain browser page) `available()` is false and nothing else here is used.
//
// What this must not be used for: handing the secret, or a function that can call the app, to the world. Never put `post` behind a bridge op.
(function () {
  'use strict';
  var tokenWanted = null;
  function getToken() {
    if (tokenWanted) return tokenWanted;
    tokenWanted = new Promise(function (resolve) {
      var t0 = Date.now();
      (function look() {
        if (typeof window.__keoHostToken === 'string') { var t = window.__keoHostToken; try { delete window.__keoHostToken; } catch (e) { window.__keoHostToken = undefined; } return resolve(t); }
        if (Date.now() - t0 > 15000) return resolve(null);
        setTimeout(look, 100);
      })();
    });
    return tokenWanted;
  }

  // POST `args` as JSON to the app's reserved path for `area` ('lan', 'file'). Resolves the parsed JSON answer, or, when the app answers
  // with bytes (a content type that is not JSON), `{ bytes: Uint8Array }`. A refusal by the app (a status that is not 2xx) throws.
  function post(area, args) {
    if (!/^[a-z]+$/.test(String(area))) return Promise.reject(new Error('That is not an area of the app.'));
    return getToken().then(function (token) {
      if (!token) throw new Error('The app gave this page no way to reach it.');
      return fetch('/.keo-host/' + area, { method: 'POST', headers: { 'x-keo-host': token, 'content-type': 'application/json' }, body: JSON.stringify(args || {}) });
    }).then(function (r) {
      if (!r.ok) throw new Error('The app answered ' + r.status + '.');
      if (/^application\/json/.test(r.headers.get('content-type') || '')) return r.json();
      return r.arrayBuffer().then(function (b) { return { bytes: new Uint8Array(b) }; });
    });
  }

  // Only an address of the app itself can have the pipe: the extension and a plain browser page do not.
  function available() { return location.protocol === 'https:'; }

  window.keoHost = { post: post, available: available };
})();
