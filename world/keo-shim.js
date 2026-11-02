// keo world shim: runs in the sandboxed world page BEFORE the Lively bootstrap.
// The world has no server behind it. This file does two things and nothing else:
//   1. a WebSocket stand-in for the socket URLs Lively derives from the page location (which is chrome-extension://...);
//   2. rewrite or answer the few server-only requests the boot makes, from static files in the package.
// Storage (localStorage, IndexedDB), cookies and passkeys are not here: keo-bridge.js and keo-idb.js provide them through the shell.
(function () {
  'use strict';

  // ---- 1. WebSocket to the package origin ----
  // Lively derives its socket URLs from the page location (SessionTracker, Lively2Lively), which here is
  // chrome-extension://..., and the WebSocket constructor throws on that scheme. There is no server to talk to, so hand
  // back a socket that is already closed: it reports an error and a close asynchronously, like an unreachable host.
  var RealWebSocket = window.WebSocket;
  class DeadSocket extends EventTarget {
    constructor(url) {
      super();
      this.url = String(url); this.protocol = ''; this.extensions = ''; this.bufferedAmount = 0; this.binaryType = 'blob';
      this.readyState = 3;
      var self = this;
      setTimeout(function () {
        var err = new Event('error'), close = new CloseEvent('close', { code: 1006, reason: 'no server in the package', wasClean: false });
        if (typeof self.onerror === 'function') self.onerror(err);
        self.dispatchEvent(err);
        if (typeof self.onclose === 'function') self.onclose(close);
        self.dispatchEvent(close);
      }, 0);
    }
    send() { throw new DOMException('WebSocket is already in CLOSING or CLOSED state.', 'InvalidStateError'); }
    close() {}
  }
  window.WebSocket = function WebSocket(url, protocols) {
    if (!/^(wss?|https?):/i.test(String(url))) return new DeadSocket(url);
    return protocols === undefined ? new RealWebSocket(url) : new RealWebSocket(url, protocols);
  };
  window.WebSocket.prototype = RealWebSocket.prototype;
  window.WebSocket.CONNECTING = 0; window.WebSocket.OPEN = 1; window.WebSocket.CLOSING = 2; window.WebSocket.CLOSED = 3;

  // ---- 1b. Workers from the package ----
  // A sandboxed page may not start a worker from a chrome-extension: URL (its origin is opaque), but its CSP allows blob:
  // workers (manifest sandbox policy). So a worker whose script is a file of the package is started from a blob made of
  // that file's text, behind a small preamble. Two things change inside a blob worker and the preamble puts them back:
  //   - its base URL is the blob's, so a root-relative ('/core/lib/...') or relative path in importScripts, fetch or XHR no
  //     longer resolves to the package: those three are wrapped to resolve against the original script URL / the package root;
  //   - importScripts and fetch of an absolute chrome-extension: URL still work (the sandbox page can read the package).
  // The same rewrite is applied to the script text for the quoted form '/core/ (so a path handed to a library as a plain
  // string, e.g. Pyodide's indexURL, is absolute too). Module workers ({type:'module'}) are not handled: their imports
  // would need the same treatment and nothing here uses one. Workers whose URL is not in the package (blob:, data:, https:)
  // are created untouched.
  var RealWorker = window.Worker;
  var PKG = new URL('./', location.href).href;           // chrome-extension://<id>/
  function syncText(url) {
    var x = new XMLHttpRequest();
    x.open('GET', url, false);
    x.send(null);
    if (x.status && x.status !== 200) throw new Error('worker script ' + url + ' -> HTTP ' + x.status);
    return x.responseText;
  }
  function workerPreamble(base) {
    return '(' + function (PKG, BASE) {
      function fix(u) {
        if (u instanceof URL) return u.href;
        u = String(u);
        if (/^[a-z][a-z0-9+.\-]*:/i.test(u) || u.indexOf('//') === 0) return u;
        if (u.charAt(0) === '/') return PKG + u.slice(1);
        return new URL(u, BASE).href;
      }
      var imp = self.importScripts;
      self.importScripts = function () { return imp.apply(self, Array.prototype.map.call(arguments, fix)); };
      var f = self.fetch;
      if (f) self.fetch = function (input, init) {
        if (typeof input === 'string' || input instanceof URL) input = fix(input);
        return f.call(self, input, init);
      };
      if (self.XMLHttpRequest) {
        var xo = XMLHttpRequest.prototype.open;
        XMLHttpRequest.prototype.open = function (m, u) { arguments[1] = fix(u); return xo.apply(this, arguments); };
      }
      self.__keoWorkerBase = BASE;
    } + ')(' + JSON.stringify(PKG) + ',' + JSON.stringify(base) + ');\n';
  }
  window.Worker = function Worker(url, options) {
    var abs;
    // blob: and data: URLs are already complete (resolving a blob URL against the page URL yields a bogus package path here)
    if (/^(blob|data):/i.test(String(url))) return new RealWorker(url, options);
    try { abs = new URL(String(url), location.href).href; } catch (e) { abs = null; }
    if (!abs || abs.indexOf(PKG) !== 0 || (options && options.type === 'module')) return new RealWorker(url, options);
    var src = syncText(abs).replace(/(['"])\/core\//g, function (m, q) { return q + PKG + 'core/'; });
    var blob = new Blob([workerPreamble(abs), src, '\n//# sourceURL=' + abs + '\n'], { type: 'text/javascript' });
    return new RealWorker(URL.createObjectURL(blob), options);
  };
  window.Worker.prototype = RealWorker.prototype;

  // ---- 1c. overlay: files that replace the package's own (updates) ----
  // The shell sends them in the bridge handshake ({ package path: text }, see shell/keo-overlay.js) and the bridge hands them
  // to __keoSetOverlay once, before the bootstrap is added. The kernel loads code three ways and all three are covered:
  // a <script src> tag (the tag is given the text inline instead: the sandbox policy allows inline script but not blob: script
  // URLs), XHR, and fetch (getViaXHR uses it). A worker script is read with a synchronous XHR above, so it is covered too.
  // Not covered: anything the browser fetches by itself (<link> stylesheets, images, fonts, css url(...)). Text files only.
  var OVERLAY = {}, overlaySet = false;
  window.__keoSetOverlay = function (files) {
    if (overlaySet) return;      // once: what the shell sent at start is what this world runs
    overlaySet = true;
    if (files && typeof files === 'object') Object.keys(files).forEach(function (k) { if (typeof files[k] === 'string') OVERLAY[k] = files[k]; });
  };
  function overlayKey(url) {
    var u;
    try { u = new URL(String(url), location.href); } catch (e) { return null; }
    if (u.href.indexOf(PKG) !== 0) return null;
    var p = decodeURIComponent(u.pathname.slice(new URL(PKG).pathname.length));     // query and hash (cache busters) are dropped
    return Object.prototype.hasOwnProperty.call(OVERLAY, p) ? p : null;
  }
  function overlayType(p) {
    return /\.js$/.test(p) ? 'application/javascript; charset=utf-8' : /\.json$/.test(p) ? 'application/json' :
      /\.css$/.test(p) ? 'text/css' : /\.xml$/.test(p) ? 'text/xml' : 'text/plain; charset=utf-8';
  }
  // A script element whose src is an overlaid path gets the text instead, and the load event the browser would have fired.
  // The kernel sets src after it has appended the element, so the text is set on a connected, empty script, which runs it.
  function overlayScript(script, url) {
    var key = overlayKey(url);
    if (key === null) return false;
    script.textContent = OVERLAY[key] + '\n//# sourceURL=' + PKG + key + '\n';
    setTimeout(function () { script.dispatchEvent(new Event('load')); }, 0);
    return true;
  }
  var origSetAttribute = Element.prototype.setAttribute;
  Element.prototype.setAttribute = function (name, value) {
    if (this instanceof HTMLScriptElement && String(name).toLowerCase() === 'src' && overlayScript(this, value)) return;
    return origSetAttribute.apply(this, arguments);
  };
  var srcDesc = Object.getOwnPropertyDescriptor(HTMLScriptElement.prototype, 'src');
  Object.defineProperty(HTMLScriptElement.prototype, 'src', {
    configurable: true, enumerable: srcDesc.enumerable, get: srcDesc.get,
    set: function (v) { if (!overlayScript(this, v)) srcDesc.set.call(this, v); }
  });
  var realFetch = window.fetch;
  window.fetch = function (input, init) {
    var isReq = typeof Request !== 'undefined' && input instanceof Request;
    var method = String((init && init.method) || (isReq && input.method) || 'GET').toUpperCase();
    var key = method === 'GET' ? overlayKey(isReq ? input.url : input) : null;
    if (key !== null) return Promise.resolve(new Response(OVERLAY[key], { status: 200, headers: { 'content-type': overlayType(key) } }));
    return realFetch.apply(this, arguments);
  };

  // ---- 2. server-only requests -> static files in the package, or a canned reply ----
  // - A WebDAV directory listing (PROPFIND) is answered from the XML the dev server returned when the package was built
  //   (webdav-index/<path with / replaced by _>.xml).
  // - POST /login is answered with a fixed anonymous reply (stub/login.json).
  // - /nodejs/CommandLineServer/ is answered with the 401 the real server gives a signed-out visitor; a missing file
  //   would instead surface as a network error, which the client logs as an error.
  // Everything else is left alone.
  var FAKE = [
    { re: /\/nodejs\/CommandLineServer\/?$/, status: 401, statusText: 'Unauthorized', text: 'Authentication required.' }
  ];
  function rewrite(method, url) {
    var path;
    try { path = new URL(url, location.href).pathname; } catch (e) { return null; }
    if (method === 'GET') {
      var ok = overlayKey(url);
      if (ok !== null) return { fake: { status: 200, statusText: 'OK', text: OVERLAY[ok] } };
    }
    for (var i = 0; i < FAKE.length; i++) if (FAKE[i].re.test(path)) return { fake: FAKE[i] };
    if (method === 'PROPFIND') {
      return { method: 'GET', url: 'webdav-index/' + path.replace(/^\/+/, '').replace(/\//g, '_') + '.xml' };
    }
    if (method === 'POST' && /\/login$/.test(path)) return { method: 'GET', url: 'stub/login.json' };
    return null;
  }
  function log(line) { (window.__keoRewritten = window.__keoRewritten || []).push(line); }

  var origOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url, async) {
    var m = String(method).toUpperCase();
    var r = rewrite(m, String(url));
    this.__keoRewritten = !!r && !r.fake;
    this.__keoFake = r && r.fake || null;
    this.__keoAsync = async !== false;
    if (r && r.fake) {
      // open a harmless local file so setRequestHeader & co. keep working; send() will not actually send it
      log(m + ' ' + url + ' -> fake ' + r.fake.status);
      return origOpen.call(this, 'GET', new URL('stub/empty.txt', location.href).href, this.__keoAsync);
    }
    if (r) {
      arguments[0] = r.method;
      arguments[1] = new URL(r.url, location.href).href;
      log(m + ' ' + url + ' -> ' + r.method + ' ' + r.url);
    }
    return origOpen.apply(this, arguments);
  };
  var origSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.send = function (body) {
    var f = this.__keoFake, xhr = this;
    if (f) {
      var props = { readyState: 4, status: f.status, statusText: f.statusText, responseText: f.text, response: f.text,
        responseXML: null, responseURL: String(xhr.__keoUrl || '') };
      Object.keys(props).forEach(function (k) { Object.defineProperty(xhr, k, { configurable: true, value: props[k] }); });
      Object.defineProperty(xhr, 'getResponseHeader', { configurable: true, value: function () { return null; } });
      Object.defineProperty(xhr, 'getAllResponseHeaders', { configurable: true, value: function () { return ''; } });
      if (!this.__keoAsync) return;   // a synchronous request has no events; the properties are enough
      setTimeout(function () {
        ['readystatechange', 'load', 'loadend'].forEach(function (t) {
          var ev = new Event(t);
          var h = t === 'readystatechange' ? xhr.onreadystatechange : t === 'load' ? xhr.onload : xhr.onloadend;
          if (typeof h === 'function') h.call(xhr, ev);
          xhr.dispatchEvent(ev);
        });
      }, 0);
      return;
    }
    // A rewritten request became a GET, so it must not carry the original body (only those; others pass through untouched).
    return origSend.call(this, this.__keoRewritten ? undefined : body);
  };
})();
