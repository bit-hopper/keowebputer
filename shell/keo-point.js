// Using a file where it lies instead of copying it into the library, SHELL side (desktop app only). The world may ASK to add one
// (`library.point`); this page puts the question to the person, opens the system's own file chooser through the app, reads the chosen
// file once through the app to name it by its SHA-256 and to take the hash of every chunk, and keeps a sealed record of it
// (keo-library.js pointStore). Showing the file later reads it through the app again and checks every chunk against those hashes.
//
// The rules:
//  - The world never names a path, never sees one, and cannot open the chooser itself. The dialog is drawn and worded here; only a real
//    click on its button (isTrusted) opens the chooser, and the chooser is the system's own, so the person sees which file they pick.
//  - One at a time. A request while one is up, or within a few seconds of the person saying no, is refused, so a world cannot keep
//    putting the question in front of them.
//  - The person is told what pointing means: the file stays where it is, it is not sealed under the identity's key, it is not on their
//    other devices, and a file that is moved or changed is reported rather than shown wrong.
// Where there is no app (the extension, a plain browser page) nothing here works and the question is never asked.
// Not for: copying a file into the library (that is the drop route and keo-library.js fileBegin), or anything the world could name.
(function () {
  'use strict';
  var kd = window.keoDid;
  var WAIT_MS = 5 * 60 * 1000, REFUSE_MS = 10000;
  var MAX_BYTES = 64 * 1024 * 1024 * 1024;          // a record holds a hash for every 4 MiB, so this keeps a record under a megabyte
  var open = null, starting = false, lastNo = 0, ui = null;      // `starting`: asked, the app not yet answered, the question not yet up

  // What a file is called by its ending, for the kinds the library shows. Only a label for the world; the bytes decide nothing here.
  var TYPES = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp', svg: 'image/svg+xml',
    mp4: 'video/mp4', m4v: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime', ogv: 'video/ogg',
    mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', oga: 'audio/ogg', flac: 'audio/flac', m4a: 'audio/mp4', opus: 'audio/ogg', mid: 'audio/midi', midi: 'audio/midi',
    pdf: 'application/pdf', txt: 'text/plain', md: 'text/markdown', markdown: 'text/markdown', html: 'text/html', htm: 'text/html', epub: 'application/epub+zip',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', json: 'application/json', zip: 'application/zip' };
  function typeOf(name) { var m = /\.([A-Za-z0-9]+)$/.exec(String(name)); return (m && TYPES[m[1].toLowerCase()]) || 'application/octet-stream'; }

  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  function sizeText(n) {
    if (n < 1000) return n + ' bytes';
    var u = ['KB', 'MB', 'GB', 'TB'], i = -1;
    do { n /= 1000; i++; } while (n >= 1000 && i < u.length - 1);
    return (n >= 100 ? Math.round(n) : Math.round(n * 10) / 10) + ' ' + u[i];
  }
  function build() {
    if (ui) return ui;
    var root = el('div'); root.id = 'keo-point'; root.hidden = true;
    var box = el('div', 'box'); box.setAttribute('role', 'dialog'); box.setAttribute('aria-modal', 'true'); box.setAttribute('aria-label', 'Point to a local file');
    var title = el('div', 'title'), text = el('div', 'text'), note = el('div', 'note'), bar = el('div', 'bar'), fill = el('div', 'fill'), btns = el('div', 'btns');
    bar.appendChild(fill);
    var no = el('button'), go = el('button', 'go');
    no.type = go.type = 'button'; no.setAttribute('data-ans', 'no'); go.setAttribute('data-ans', 'go');
    btns.appendChild(no); btns.appendChild(go);
    [title, text, note, bar, btns].forEach(function (x) { box.appendChild(x); });
    root.appendChild(box);
    document.body.appendChild(root);
    root.addEventListener('click', function (ev) {
      var b = ev.target && ev.target.closest && ev.target.closest('button[data-ans]');
      if (!b || !ev.isTrusted || !open) return;
      if (b.getAttribute('data-ans') === 'go') { if (open.phase === 'ask') open.choose(); }
      else open.cancel();
    });
    ui = { root: root, title: title, text: text, note: note, bar: bar, fill: fill, no: no, go: go };
    return ui;
  }
  function close() { if (open) { clearTimeout(open.timer); open = null; } ui.root.hidden = true; }

  // Resolves null when the person cancels or chooses nothing, { id, name, type, size, existed, pointed } when a file was added, and
  // rejects with a sentence when it cannot be done. `existed` and not `pointed`: the library already holds a copy of those bytes, which
  // is kept as it is (a copy is safer than a pointer).
  function start() {
    if (open || starting) return Promise.reject(new Error('Another file is being added.'));
    if (Date.now() - lastNo < REFUSE_MS) return Promise.reject(new Error('That was declined a moment ago.'));
    if (!(window.keoHost && window.keoHost.available())) return Promise.reject(new Error('Pointing to a local file works only in the desktop app.'));
    starting = true;
    return window.keoHost.post('file', { op: 'hello' }).then(function (r) {
      if (!r || r.ok !== true) throw new Error('Pointing to a local file works only in the desktop app.');
    }, function () { throw new Error('Pointing to a local file works only in the desktop app.'); }).then(function () {}, function (e) { starting = false; throw e; }).then(function () {
      var u = build();
      u.title.textContent = 'Point to a local file';
      u.text.textContent = 'keo will point to the file you choose, where it lies on this computer. It is not copied, so it takes no room in your library.';
      u.note.textContent = 'It is not sealed with your identity, it will not be on your other devices, and if you move, rename or change it keo will tell you instead of showing it.';
      u.note.hidden = false; u.bar.hidden = true; u.fill.style.width = '0%';
      u.no.textContent = 'Cancel'; u.go.textContent = 'Choose a file …'; u.go.hidden = false;
      return new Promise(function (resolve, reject) {
        starting = false;
        var q = open = { phase: 'ask', stop: false, resolve: resolve, reject: reject, timer: null,
          cancel: function () { q.stop = true; if (q.phase === 'ask') { lastNo = Date.now(); close(); resolve(null); } else u.no.disabled = true; },
          choose: function () { q.phase = 'chose'; run(q, u).then(function (r) { close(); if (r === null) lastNo = Date.now(); resolve(r); }, function (e) { close(); reject(e); }); } };
        q.timer = setTimeout(function () { if (q.phase === 'ask') q.cancel(); }, WAIT_MS);
        u.no.disabled = false;
        u.root.hidden = false;
        u.no.focus();
      });
    });
  }

  function hostError(r, fallback) {
    var words = { missing: 'That file cannot be found.', denied: 'This computer will not let keo read that file.', notfile: 'That is not a file.', busy: 'A file is already being chosen.' };
    return new Error(words[r.error] || fallback);
  }
  async function run(q, u) {
    var g = await window.keoHost.post('file', { op: 'choose' });
    if (g.cancelled) return null;
    if (g.error) throw hostError(g, 'That file could not be chosen.');
    if (q.stop) return null;
    var size = g.size, name = g.name;
    if (!(typeof size === 'number' && size >= 0 && Math.floor(size) === size) || typeof g.path !== 'string' || typeof g.mac !== 'string') throw new Error('That file could not be chosen.');
    if (size > MAX_BYTES) throw new Error('That file is too big to use here (the limit is ' + sizeText(MAX_BYTES) + ').');
    u.title.textContent = 'Reading ' + name;
    u.text.textContent = 'keo is reading the file once to give it a name that only these bytes have. It stays where it is.';
    u.note.hidden = true; u.go.hidden = true; u.bar.hidden = false; u.no.textContent = 'Stop';
    var CH = window.keoLibrary.CHUNK_BYTES, hasher = window.keoSha256.create(), hashes = [], off = 0, lastPaint = 0;
    while (off < size) {
      if (q.stop) return null;
      var len = Math.min(CH, size - off);
      var r = await window.keoHost.post('file', { op: 'read', path: g.path, mac: g.mac, offset: off, length: len });
      if (r.error) throw hostError(r, 'That file could not be read.');
      if (!r.bytes || r.bytes.length !== len) throw new Error('"' + name + '" changed while it was being read. Try again when nothing is writing to it.');
      hasher.update(r.bytes);
      hashes.push(kd.b64u(new Uint8Array(await crypto.subtle.digest('SHA-256', r.bytes))));
      off += len;
      if (Date.now() - lastPaint > 150) { lastPaint = Date.now(); u.fill.style.width = (size ? Math.floor(off / size * 100) : 100) + '%'; u.text.textContent = 'Reading ' + sizeText(off) + ' of ' + sizeText(size) + '. It stays where it is.'; }
    }
    // The file must be the same size and time after the read as before it: a file written to while it was read is not one file.
    var after = await window.keoHost.post('file', { op: 'stat', path: g.path, mac: g.mac });
    if (after.error || after.size !== g.size || after.mtimeMs !== g.mtimeMs) throw new Error('"' + name + '" changed while it was being read. Try again when nothing is writing to it.');
    if (q.stop) return null;
    var cid = kd.b64u(hasher.digest()), type = typeOf(name);
    var kept = await window.keoLibrary.pointStore({ cid: cid, name: name, type: type, size: size, mtimeMs: g.mtimeMs, point: { path: g.path, mac: g.mac }, hashes: hashes });
    return { id: kept.id, name: name, type: type, size: size, existed: kept.existed, pointed: kept.pointed };
  }

  // Whether this page can use a file where it lies: only inside the desktop app, which answers a hello on its file path.
  function available() {
    if (!(window.keoHost && window.keoHost.available())) return Promise.resolve(false);
    return window.keoHost.post('file', { op: 'hello' }).then(function (r) { return !!(r && r.ok === true); }, function () { return false; });
  }

  // The session ended or the identity changed: a question still up goes away.
  function reset() { if (open) { open.stop = true; if (open.phase === 'ask') { var o = open; close(); o.resolve(null); } } }

  window.keoPoint = { start: start, available: available, reset: reset, typeOf: typeOf };
})();
