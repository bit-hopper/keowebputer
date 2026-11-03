// keo bridge, WORLD side. Runs in the sandboxed world page before the Lively bootstrap.
//
// The world realm has an opaque origin: no IndexedDB, cookies, localStorage or passkeys. The shell page (start.html,
// the extension's own origin) has all of them. This file gives the world the APIs it expects, backed by the shell
// over postMessage:
//   - window.keo.call(op, args) -> Promise: one request/response RPC to the shell;
//   - window.keo.ready          -> Promise: resolves once the shell has answered the handshake (keo-boot.js waits
//                                  for it before it loads the bootstrap, so boot-time code finds its storage filled);
//   - localStorage / sessionStorage: synchronous APIs, filled from a snapshot the shell sends in the handshake
//                                  (localStorage only), writes forwarded to the shell afterwards (write-behind);
//   - document.cookie: always empty (the runtime only reads it for a user-name cookie that does not exist here);
//   - navigator.credentials.create/get and the static PublicKeyCredential helpers: run in the shell, results come
//                                  back as plain objects shaped like the real ones.
// IndexedDB is in keo-idb.js. The identity vault protocol (IdentityVaultBridge) does not use this RPC: it posts its
// own {id, op, args} messages to the parent, and the shell forwards them to the vault page (see shell.js).
//
// Message shapes (every message carries keo:1 so it can be told apart from the vault protocol):
//   world -> shell   { keo: 1, id, op, args }
//   shell -> world   { keo: 1, id, ok: true, result }  |  { keo: 1, id, ok: false, error: { name, message } }
// The world only accepts messages whose source is window.parent and whose origin is the shell's.
(function () {
  'use strict';
  if (window.keo) return;

  var SHELL_ORIGIN = new URL(location.href).origin;     // chrome-extension://<id>; location.origin is not trustworthy here
  var parentWin = window.parent;
  if (!parentWin || parentWin === window) {
    // Opened on its own, not inside the shell: there is nobody to ask. Give the runtime throwaway in-memory storage so
    // its boot does not die on a SecurityError, and no IndexedDB (it checks for it and copes), and do nothing else.
    var mem = function () {
      var d = {};
      return new Proxy(Object.create(null), {
        get: function (t, p) { if (p === 'getItem') return function (k) { return k in d ? d[k] : null; }; if (p === 'setItem') return function (k, v) { d[k] = String(v); };
          if (p === 'removeItem') return function (k) { delete d[k]; }; if (p === 'clear') return function () { d = {}; }; if (p === 'key') return function (i) { return Object.keys(d)[i] || null; };
          if (p === 'length') return Object.keys(d).length; return typeof p === 'string' ? d[p] : undefined; },
        set: function (t, p, v) { d[p] = String(v); return true; },
        ownKeys: function () { return Object.keys(d); },
        getOwnPropertyDescriptor: function (t, p) { return p in d ? { value: d[p], writable: true, enumerable: true, configurable: true } : undefined; }
      });
    };
    ['localStorage', 'sessionStorage'].forEach(function (n) { var s = mem(); try { Object.defineProperty(window, n, { configurable: true, get: function () { return s; } }); } catch (e) {} });
    try { Object.defineProperty(Document.prototype, 'cookie', { configurable: true, get: function () { return ''; }, set: function () {} }); } catch (e) {}
    try { Object.defineProperty(window, 'indexedDB', { configurable: true, get: function () { return undefined; } }); } catch (e) {}
    window.keo = { standalone: true, ready: Promise.resolve({}) };
    return;
  }

  var nextId = 1, pending = {};

  function call(op, args, timeoutMs) {
    return new Promise(function (resolve, reject) {
      var id = nextId++;
      var timer = setTimeout(function () {
        delete pending[id];
        reject(new Error('keo bridge: ' + op + ' timed out'));
      }, timeoutMs || 30000);
      pending[id] = { resolve: resolve, reject: reject, timer: timer };
      parentWin.postMessage({ keo: 1, id: id, op: op, args: args || {} }, SHELL_ORIGIN);
    });
  }

  // Events the shell pushes without being asked ({keo:1, event, data}): window.keo.on(name, fn) -> a function that stops listening.
  // Not queued: one sent before a listener exists is lost, so a listener asks for the current state when it registers.
  var listeners = {};
  function on(name, fn) {
    (listeners[name] = listeners[name] || []).push(fn);
    return function () { listeners[name] = (listeners[name] || []).filter(function (f) { return f !== fn; }); };
  }

  window.addEventListener('message', function (ev) {
    if (ev.source !== parentWin || ev.origin !== SHELL_ORIGIN) return;
    var m = ev.data;
    if (m && m.keo === 1 && typeof m.event === 'string') {
      (listeners[m.event] || []).slice().forEach(function (f) { try { f(m.data); } catch (e) { console.warn('keo bridge: a ' + m.event + ' listener threw: ' + e.message); } });
      return;
    }
    if (!m || m.keo !== 1 || m.id === undefined) return;
    var p = pending[m.id];
    if (!p) return;
    delete pending[m.id];
    clearTimeout(p.timer);
    if (m.ok) return p.resolve(m.result);
    var e = new Error((m.error && m.error.message) || 'keo bridge error');
    e.name = (m.error && m.error.name) || 'Error';
    p.reject(e);
  });

  // ---- Storage objects ------------------------------------------------------------------------------------------
  // A Storage look-alike: named items as own enumerable properties (lively.LocalStorage lists keys with
  // Object.getOwnPropertyNames(localStorage)), the usual methods, string coercion of values. `onChange(op, key, value)`
  // is told about every mutation, which is how localStorage reaches the shell.
  function makeStorage(initial, onChange) {
    var data = new Map(Object.keys(initial || {}).map(function (k) { return [k, String(initial[k])]; }));
    var methods = {
      getItem: function (k) { k = String(k); return data.has(k) ? data.get(k) : null; },
      setItem: function (k, v) { k = String(k); v = String(v); data.set(k, v); onChange && onChange('set', k, v); },
      removeItem: function (k) { k = String(k); if (data.delete(k)) onChange && onChange('remove', k); },
      clear: function () { data.clear(); onChange && onChange('clear'); },
      key: function (i) { var ks = Array.from(data.keys()); return i >= 0 && i < ks.length ? ks[i] : null; }
    };
    return new Proxy(Object.create(null), {
      get: function (t, p) {
        if (p === 'length') return data.size;
        if (typeof p === 'symbol') return undefined;
        if (Object.prototype.hasOwnProperty.call(methods, p)) return methods[p];
        return data.has(p) ? data.get(p) : undefined;
      },
      set: function (t, p, v) { if (typeof p === 'string') methods.setItem(p, v); return true; },
      deleteProperty: function (t, p) { if (typeof p === 'string') methods.removeItem(p); return true; },
      has: function (t, p) { return typeof p === 'string' && (data.has(p) || Object.prototype.hasOwnProperty.call(methods, p)); },
      ownKeys: function () { return Array.from(data.keys()); },
      getOwnPropertyDescriptor: function (t, p) {
        return typeof p === 'string' && data.has(p) ? { value: data.get(p), writable: true, enumerable: true, configurable: true } : undefined;
      }
    });
  }

  function install(name, value) {
    try { Object.defineProperty(window, name, { configurable: true, get: function () { return value; } }); } catch (e) {}
  }

  // ---- WebAuthn in the shell ------------------------------------------------------------------------------------
  // The real navigator.credentials in this document refuses ("publickey-credentials-* is not enabled": a sandboxed
  // page is not allowed the feature). The shell can run the ceremony, so create/get are forwarded there. Options go
  // over as structured clones (ArrayBuffers and typed arrays survive); the result comes back as plain data and is
  // rebuilt into an object with the properties and methods the identity code reads.
  function ceremony(kind, options) {
    options = options || {};
    if (!options.publicKey) return Promise.reject(new TypeError("keo bridge: only {publicKey} credential requests are supported"));
    return call('webauthn.' + kind, { publicKey: options.publicKey }, 180000).then(function (r) {
      var resp = r.response || {};
      var response = {};
      ['clientDataJSON', 'attestationObject', 'authenticatorData', 'signature', 'userHandle'].forEach(function (k) {
        if (resp[k] !== undefined) response[k] = resp[k];
      });
      if (resp.transports) response.getTransports = function () { return resp.transports.slice(); };
      if (resp.publicKey !== undefined) response.getPublicKey = function () { return resp.publicKey; };
      if (resp.publicKeyAlgorithm !== undefined) response.getPublicKeyAlgorithm = function () { return resp.publicKeyAlgorithm; };
      if (resp.authenticatorDataGetter !== undefined) response.getAuthenticatorData = function () { return resp.authenticatorDataGetter; };
      var ext = r.clientExtensionResults || {};
      return {
        id: r.id, rawId: r.rawId, type: r.type, authenticatorAttachment: r.authenticatorAttachment || null,
        response: response,
        getClientExtensionResults: function () { return ext; }
      };
    });
  }
  var credentialsFacade = {
    create: function (options) { return ceremony('create', options); },
    get: function (options) { return ceremony('get', options); },
    store: function () { return Promise.reject(new DOMException('not supported', 'NotSupportedError')); },
    preventSilentAccess: function () { return Promise.resolve(); }
  };

  // PublicKeyCredential's static feature probes also need the shell (they consult the authenticator).
  function patchPublicKeyCredential() {
    if (typeof window.PublicKeyCredential === 'undefined') {
      window.PublicKeyCredential = function PublicKeyCredential() {};
    }
    var P = window.PublicKeyCredential;
    P.isUserVerifyingPlatformAuthenticatorAvailable = function () { return call('webauthn.uvpaa').catch(function () { return false; }); };
    P.isConditionalMediationAvailable = function () { return Promise.resolve(false); };
    P.getClientCapabilities = function () { return call('webauthn.capabilities').catch(function () { return {}; }); };
  }

  // ---- handshake and stand-ins ----------------------------------------------------------------------------------
  var ready = (function handshake() {
    // The shell sets the iframe's src after its listener exists, so the first request should arrive, but retry anyway:
    // 'init' is idempotent.
    return new Promise(function (resolve, reject) {
      var tries = 0, done = false;
      function attempt() {
        if (done) return;
        if (++tries > 100) return reject(new Error('keo bridge: the shell did not answer the handshake'));
        call('init', {}, 400).then(function (r) { done = true; resolve(r); }, function () { attempt(); });
      }
      attempt();
    });
  })().then(function (init) {
    var ls = makeStorage(init.localStorage, function (op, k, v) {
      var args = { op: op, key: k, value: v };
      call('ls.apply', args).catch(function (e) { console.warn('keo bridge: could not persist localStorage change: ' + e.message); });
    });
    install('localStorage', ls);
    install('sessionStorage', makeStorage({}, null));      // per world instance, like a tab; never persisted
    try { Object.defineProperty(Document.prototype, 'cookie', { configurable: true, get: function () { return ''; }, set: function () {} }); } catch (e) {}
    try { Object.defineProperty(navigator, 'credentials', { configurable: true, get: function () { return credentialsFacade; } }); } catch (e) {}
    patchPublicKeyCredential();
    if (window.__keoSetOverlay) window.__keoSetOverlay(init.overlay);   // before keo-boot loads the bootstrap
    window.keo.init = init;
    return init;
  });

  window.keo = { call: call, on: on, ready: ready, shellOrigin: SHELL_ORIGIN, makeStorage: makeStorage };
})();
