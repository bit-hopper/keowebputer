// Receiving files from a phone over the local network, SHELL side (desktop app only). The world draws the "Connect a phone" window
// (kernel: lively.identity.PhoneDialog); this page does the parts the world must not be trusted with. The app (keo-desktop, lib/phone.js)
// runs a small web server on this computer while the window is open; this page starts and stops it, draws each address as a QR code, asks the
// person about every batch of files a phone offers, and moves what arrives into the library in pieces (the same ingest a drop uses:
// keo-library.js fileBegin / fileChunk / fileEnd, so a file is named by its hash and sealed under the identity), into a folder called
// "Dropped" where it waits until the person looks at it.
//
// WHO IS TRUSTED WITH WHAT.
//  - The world is less trusted than this page: any script in it can call the bridge. So the QUESTION is drawn and answered here, never in
//    the world. Accept and Decline count only for a real click (isTrusted); the question never takes the keyboard focus by itself. The world
//    cannot say yes for the person, and no bridge op does.
//  - The world is told what it needs to draw the window: the addresses (as text and as QR pictures), that a phone opened the page, that
//    a question is up, progress, and how many files were saved. It is NOT told file names, and it never gets a byte of what was sent.
//    The addresses are not secret from it (it has to draw them); they are useless without the person's yes.
//  - Nothing here can say WHO the phone is: it has no keo identity. The question shows its address and what its browser says it is, and says
//    that this is not verified. The check that matters is the person's: they scanned the code themselves, and they accept every batch.
//  - The server runs only between start() and stop(); signing out, closing the window (the world calls stop) and the app ending all stop it.
// Not for: friends' devices (keo-p2p.js, keo-lan.js), or pointing to a file where it lies (keo-point.js).
(function () {
  'use strict';
  var POLL_MS = 400, ROWS = 6;
  var FOLDER = 'Dropped';
  var ask = null, sess = null, listener = null;

  function emit(ev) { if (listener) { try { listener(ev); } catch (e) {} } }
  function post(op, args) { return window.keoHost.post('phone', Object.assign({ op: op }, args || {})); }
  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  function sizeText(n) {
    if (n < 1000) return n + ' bytes';
    var u = ['KB', 'MB', 'GB', 'TB'], i = -1;
    do { n /= 1000; i++; } while (n >= 1000 && i < u.length - 1);
    return (n >= 100 ? Math.round(n) : Math.round(n * 10) / 10) + ' ' + u[i];
  }
  function plural(n, one, many) { return n + ' ' + (n === 1 ? one : many); }
  // What the phone's browser says it is, said plainly. It is the phone's own claim (anything can say anything here), so it is only ever worded as one.
  function deviceWords(ua) { return /Mobile|Android|iPhone|iPad|iPod/i.test(String(ua || '')) ? 'a phone or tablet' : 'a device'; }
  function typeOf(name) { return window.keoPoint && window.keoPoint.typeOf ? window.keoPoint.typeOf(name) : 'application/octet-stream'; }

  // ---- the question -----------------------------------------------------------------------------------------------------------
  // A dialog of this page's own, in the style of the "point to a local file" and "add a friend" questions: nothing else on screen can reach it.
  function build() {
    if (ask) return ask;
    var root = el('div'); root.id = 'keo-phone'; root.hidden = true;
    var box = el('div', 'box'); box.setAttribute('role', 'dialog'); box.setAttribute('aria-modal', 'true'); box.setAttribute('aria-label', 'Files from a phone');
    var title = el('div', 'title', 'Files from a phone'), text = el('div', 'text'), list = el('ul', 'list'), note = el('div', 'note'), btns = el('div', 'btns');
    var no = el('button', null, 'Decline'), yes = el('button', 'go', 'Accept');
    no.type = yes.type = 'button'; no.setAttribute('data-ans', 'no'); yes.setAttribute('data-ans', 'yes');
    btns.appendChild(no); btns.appendChild(yes);
    [title, text, list, note, btns].forEach(function (x) { box.appendChild(x); });
    root.appendChild(box);
    document.body.appendChild(root);
    root.addEventListener('click', function (ev) {
      var b = ev.target && ev.target.closest && ev.target.closest('button[data-ans]');
      if (!b || !ev.isTrusted || !sess || !sess.pending) return;
      answer(b.getAttribute('data-ans') === 'yes');
    });
    ask = { root: root, text: text, list: list, note: note, no: no, yes: yes };
    return ask;
  }
  function showAsk(r) {
    var u = build(), names = r.files.slice(0, ROWS);
    u.text.textContent = 'Allow ' + plural(r.files.length, 'file', 'files') + ' (' + sizeText(r.total) + ') from ' + deviceWords(r.ua) + ' at ' + r.ip + '?';
    u.list.textContent = '';
    names.forEach(function (f) { var li = el('li'); li.appendChild(el('span', 'n', f.name)); li.appendChild(el('span', 's', sizeText(f.size))); u.list.appendChild(li); });
    if (r.files.length > ROWS) u.list.appendChild(el('li', 'more', 'and ' + (r.files.length - ROWS) + ' more'));
    u.note.textContent = 'This device is not verified: its address and what it says it is can be wrong. Accept only what you chose to send from your own phone. The files are kept in a folder called ' + FOLDER + ' until you look at them.';
    sess.pending = r;
    u.root.hidden = false;
    emit({ type: 'asked', count: r.files.length, total: r.total });
  }
  function closeAsk() { if (ask) ask.root.hidden = true; if (sess) sess.pending = null; }
  function answer(yes) {
    var r = sess && sess.pending; if (!r) return;
    closeAsk();
    if (yes) sess.batches[r.id] = { id: r.id, files: r.files, total: r.total, got: 0, saved: 0, existed: 0, failed: 0 };
    emit({ type: 'answered', accepted: yes });
    post('decide', { id: r.id, accept: yes }).then(function (x) { if (!x.ok) { delete sess.batches[r.id]; emit({ type: 'cancelled' }); } }, function () { emit({ type: 'error', message: 'The app could not be reached.' }); });
  }

  // ---- what happens in the app ------------------------------------------------------------------------------------------------
  function onEvent(e) {
    if (!sess || !e) return;
    if (e.type === 'claimed') { sess.claimed = true; sess.phone = { who: deviceWords(e.ua), ip: e.ip }; emit({ type: 'claimed', who: sess.phone.who, ip: e.ip }); }
    else if (e.type === 'request') showAsk(e);
    else if (e.type === 'refused') emit({ type: 'refused', reason: e.reason });
    else if (e.type === 'cancelled') {
      if (sess.pending && sess.pending.id === e.id) closeAsk();
      else delete sess.batches[e.id];
      emit({ type: 'cancelled' });
    }
    else if (e.type === 'progress') { var pb = sess.batches[e.id]; if (pb && e.size) emit({ type: 'progress', done: pb.got + e.received, total: pb.total }); }
    else if (e.type === 'file') { var fb = sess.batches[e.id]; if (fb) { fb.got += e.size; sess.queue.push(e); pump(); } }
    else if (e.type === 'failed') emit({ type: 'error', message: 'A file did not finish. The phone can try again.' });
    else if (e.type === 'expired') { emit({ type: 'expired' }); shutdown(true); }
  }
  function tick() {
    if (!sess || sess.polling) return;
    sess.polling = true;
    post('events').then(function (r) { (r.events || []).forEach(onEvent); }, function () { emit({ type: 'error', message: 'The app could not be reached.' }); }).then(function () { if (sess) sess.polling = false; });
  }

  // ---- into the library ------------------------------------------------------------------------------------------------------
  async function droppedFolder() {
    var lib = window.keoLibrary, list = await lib.folderList();
    var f = list.folders.filter(function (x) { return x.parent === null && x.name === FOLDER; })[0];
    if (f) return f.id;
    try { return (await lib.folderCreate({ name: FOLDER })).id; }
    catch (e) { var again = (await lib.folderList()).folders.filter(function (x) { return x.parent === null && x.name === FOLDER; })[0]; if (again) return again.id; throw e; }
  }
  async function ingest(f) {
    var lib = window.keoLibrary, CH = lib.CHUNK_BYTES, size = f.size;
    var b = await lib.fileBegin({ name: f.name, type: typeOf(f.name), size: size });
    try {
      for (var off = 0, n = 0; off < size; n++) {
        var len = Math.min(CH, size - off);
        var r = await post('read', { id: f.id, fid: f.fid, offset: off, length: len });
        if (!r || r.error || !r.bytes || r.bytes.length !== len) throw new Error('The file could not be read back from the app.');
        await lib.fileChunk({ upload: b.upload, n: n, bytes: r.bytes });
        off += len;
      }
    } catch (e) { try { await lib.fileAbort({ upload: b.upload }); } catch (x) {} throw e; }
    var end = await lib.fileEnd({ upload: b.upload });
    var moved = false;
    if (!end.existed) { try { await lib.fileMove({ ids: [end.id], folder: await droppedFolder() }); moved = true; } catch (e) { /* kept, just not in the folder */ } }
    return { id: end.id, existed: !!end.existed, moved: moved };
  }
  function pump() {
    if (!sess || sess.pumping) return;
    sess.pumping = true;
    (async function () {
      while (sess && sess.queue.length) {
        var f = sess.queue.shift(), s = sess, bt = s.batches[f.id];
        if (!bt) { post('discard', { id: f.id, fid: f.fid }).catch(function () {}); continue; }
        emit({ type: 'saving', index: bt.saved + bt.existed + bt.failed + 1, count: bt.files.length });
        try {
          var r = await ingest(f);
          if (r.existed) bt.existed++; else bt.saved++;
        } catch (e) {
          bt.failed++;
          if (sess === s) emit({ type: 'error', message: '"' + f.name + '" was not saved: ' + String(e && e.message || e) });
        }
        post('discard', { id: f.id, fid: f.fid }).catch(function () {});
        if (sess !== s) return;
        if (bt.saved + bt.existed + bt.failed >= bt.files.length) finishBatch(bt);
      }
      if (sess) sess.pumping = false;
    })().then(function () { if (sess) sess.pumping = false; }, function () { if (sess) sess.pumping = false; });
  }
  function finishBatch(bt) {
    delete sess.batches[bt.id];
    emit({ type: 'saved', count: bt.saved, existed: bt.existed, failed: bt.failed, folder: FOLDER });
  }

  // ---- starting and stopping --------------------------------------------------------------------------------------------------
  function available() {
    if (!(window.keoHost && window.keoHost.available())) return Promise.resolve(false);
    return post('hello').then(function (r) { return !!(r && r.ok === true); }, function () { return false; });
  }
  // A picture of the QR code for each address, as a data URL: the world has no way to draw one, and the picture is what it needs.
  function pictures(urls) {
    return urls.map(function (u) { var c = document.createElement('canvas'); window.keoQr.draw(c, u, 240); return c.toDataURL('image/png'); });
  }
  function shutdown(keepExpiredNote) {
    if (!sess) return;
    var s = sess; sess = null;
    if (s.timer) clearInterval(s.timer);
    closeAsk();
    post('stop').catch(function () {});
    if (!keepExpiredNote) emit({ type: 'closed' });
  }
  function view() { return { running: true, urls: sess.urls, qrs: sess.qrs, claimed: sess.claimed, phone: sess.phone, asking: !!sess.pending }; }
  // Starts the server (or answers for the one already running). Resolves { running, urls, qrs, claimed, phone, asking }.
  function start() {
    if (sess) return Promise.resolve(view());
    return Promise.resolve().then(function () { return window.keoIdentity.current(); }).then(function (s) {
      if (!s) throw new Error('Sign in first: what a phone sends is kept in your files.');
      return available();
    }).then(function (ok) {
      if (!ok) throw new Error('Connecting a phone works only in the desktop app.');
      if (sess) return null;
      return post('start');
    }).then(function (st) {
      if (!st) return view();
      if (st.error || !st.running) throw new Error('The app could not start listening for a phone.');
      sess = { urls: st.urls || [], qrs: pictures(st.urls || []), claimed: false, phone: null, pending: null, batches: {}, queue: [], polling: false, pumping: false, timer: null };
      sess.timer = setInterval(tick, POLL_MS);
      return view();
    });
  }
  function stop() { shutdown(false); return Promise.resolve({ running: false }); }
  function state() { return Promise.resolve(sess ? view() : { running: false, urls: [], qrs: [], claimed: false, phone: null, asking: false }); }

  // The session ended or the identity changed: the question goes away, the server stops, nothing is kept.
  function reset() { if (sess) shutdown(false); }

  window.keoPhone = { available: available, start: start, stop: stop, state: state, reset: reset, onEvent: function (fn) { listener = fn; } };
})();
