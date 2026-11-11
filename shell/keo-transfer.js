// Moving the data of an identity from one webputer to another, SHELL side: the dialog in which a person saves it as a file and adds
// such a file on another webputer where the SAME identity is signed in (usually one it was just linked to: keo-enroll.js carries the
// identity, not what it stored). Runs in the extension's own page; the sandboxed world is assumed hostile.
//
// What goes in the file: the saved worlds (with their tags, notes and search text) and the library (Books, Music and Gallery items with
// their pictures and files). It is the sealed records as they are on disk (keo-worlds.js / keo-library.js exportSealed), so the file is
// readable only by this identity's key: the person may keep it, move it by any means, and a copy in the wrong hands shows nothing. Not
// in it: the friends, the message history and the settings (each is its own store and was not asked for).
// Adding a file never overwrites: a world whose name is taken, and a library item or file that is already there, are left alone and
// reported. Every record is opened with the signed-in identity's key before anything is written, so a damaged file, or one made for
// another identity, is refused with a sentence and changes nothing.
// LARGE FILES (library files kept in chunks, keo-library.js) are too big for that one text. When there are any, the data is saved in
// a second form instead, which is read a piece at a time and so is never held whole: the marker KEOD2 and a newline, then frames of
// one type byte, a four-byte length and the payload: 1 the same text as above (worlds, library items, small files), 2 a large file's
// sealed manifest, 3 one sealed chunk of it (raw bytes: iv then ciphertext), 4 an end mark with the counts. Without large files the
// first form is written exactly as before. Adding is then in two steps: the text first, as a whole or not at all, then the large
// files one by one; a file is made visible only once every chunk has been opened and the bytes have come to its name, so a file cut
// short is not added and the ones before it stay.
//
// The rules (the world is assumed hostile):
//  - The world can only ASK for the dialog (transfer.open). There is no op that saves, adds, or reads what is in a file.
//  - Only a real click counts (isTrusted), and a file is chosen with the browser's own chooser, so nothing can be fed in from code.
//  - Asked again while one is up, or within a few seconds of one being closed, the world is refused.
// Not for: backups on a schedule, merging two different identities, or moving anything without the person there.
(function () {
  'use strict';
  var kd = window.keoDid, ident = window.keoIdentity, icons = window.keoIdenticon;
  var MAX_FILE = 256 * 1024 * 1024;        // one file: a guard (the whole thing is held in memory), not a quota
  var DISMISS_MS = 10000;
  var FILE_NAME = 'keo-data.json', FILE_NAME_BIG = 'keo-data.keo';
  var MAGIC = 'KEOD2\n', T_BODY = 1, T_FILE = 2, T_CHUNK = 3, T_END = 4;
  var MAX_FRAME = 8 * 1024 * 1024;                 // any frame but the first holds one chunk (4 MiB and a few bytes)
  var MAX_EXPORT = 2 * 1024 * 1024 * 1024;         // a file with large files in it
  var B64U = /^[A-Za-z0-9_-]*$/;
  var open = null, lastClosed = 0, listener = null, ui = null;

  function emit(ev) { if (listener) { try { listener(ev); } catch (e) {} } }
  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  function shortDid(did) {
    var m = /^did:keo:[^:]+:([A-Za-z0-9_-]{43})$/.exec(String(did));
    return m ? 'keo:' + m[1].slice(0, 4) + '…' + m[1].slice(-4) : String(did).slice(0, 24);
  }
  function plural(n, one, many) { return n + ' ' + (n === 1 ? one : many); }

  // ---- the file --------------------------------------------------------------------------------------------------------
  function encRec(r) { var o = { iv: r.iv, ct: kd.b64u(r.ct) }; if (r.id !== undefined) o.id = r.id; return o; }
  // A record from a file: only the three fields, each a string of the right alphabet and size, so what reaches the stores is plain.
  function decRec(r, withId) {
    if (!r || typeof r !== 'object' || typeof r.iv !== 'string' || r.iv.length > 32 || !B64U.test(r.iv) || typeof r.ct !== 'string' || !B64U.test(r.ct)) throw new Error('This file is damaged.');
    var o = { iv: r.iv, ct: kd.unb64u(r.ct) };
    if (withId) { if (typeof r.id !== 'string' || r.id.length > 200) throw new Error('This file is damaged.'); o.id = r.id; }
    return o;
  }
  async function makeFile() {
    var s = await ident.current();
    if (!s) throw new Error('Sign in first.');
    var w = await window.keoWorlds.exportSealed(), l = await window.keoLibrary.exportSealed();
    if (w.did !== s.did || l.did !== s.did) throw new Error('The signed-in identity changed.');
    var body = JSON.stringify({ keo: 'data', v: 1, did: s.did, at: new Date().toISOString(),
      worlds: { index: w.index && encRec(w.index), bodies: w.bodies.map(encRec), texts: w.texts.map(encRec) },
      library: { docs: l.docs.map(encRec), blobs: l.blobs.map(encRec) } });
    if (body.length > MAX_FILE) throw new Error('Your data is too big for one file here.');
    var big = await window.keoLibrary.exportFileList();
    var counts = { worlds: w.bodies.length, docs: l.docs.length, blobs: l.blobs.length, files: big.files.length, skippedFiles: big.unreadable, pointedFiles: big.pointed || 0 };
    if (!big.files.length) return Object.assign({ blob: new Blob([body], { type: 'application/json' }), name: FILE_NAME }, counts);
    // the second form: one chunk is read, wrapped in its own blob and let go, so the browser can keep the file off the page's memory
    if (big.files.reduce(function (a, f) { return a + f.size; }, 0) + body.length > MAX_EXPORT) throw new Error('Your data is too big for one file here.');
    var te = new TextEncoder(), bodyBytes = te.encode(body), parts = [te.encode(MAGIC), frameHead(T_BODY, bodyBytes.length), bodyBytes], chunks = 0;
    for (var i = 0; i < big.files.length; i++) {
      var f = big.files[i], man = te.encode(JSON.stringify({ id: f.id, iv: f.manifest.iv, ct: kd.b64u(f.manifest.ct), chunks: f.chunks }));
      parts.push(frameHead(T_FILE, man.length), man);
      for (var n = 0; n < f.chunks; n++) {
        var rec = await window.keoLibrary.exportFileChunk({ fid: f.fid, n: n }), iv = kd.unb64u(rec.iv);
        parts.push(frameHead(T_CHUNK, iv.length + rec.ct.length), new Blob([iv, rec.ct]));
        chunks++;
      }
    }
    var end = te.encode(JSON.stringify({ files: big.files.length, chunks: chunks }));
    parts.push(frameHead(T_END, end.length), end);
    return Object.assign({ blob: new Blob(parts, { type: 'application/octet-stream' }), name: FILE_NAME_BIG }, counts);
  }
  function frameHead(type, len) { var h = new Uint8Array(5); h[0] = type; new DataView(h.buffer).setUint32(1, len); return h; }
  // Reads the frames of a file in the second form one after another; a payload is read only when asked for, so a frame can be skipped.
  function frames(f) {
    var off = MAGIC.length;
    return { next: async function () {
      if (off + 5 > f.size) return null;
      var h = new DataView(await f.slice(off, off + 5).arrayBuffer()), type = h.getUint8(0), len = h.getUint32(1);
      if (type < T_BODY || type > T_END || len > (type === T_BODY ? MAX_FILE : MAX_FRAME)) throw new Error('This file is damaged.');
      if (off + 5 + len > f.size) throw new Error('This file ends too early.');
      var start = off + 5; off = start + len;
      return { type: type, len: len, bytes: async function () { return new Uint8Array(await f.slice(start, start + len).arrayBuffer()); } };
    } };
  }
  // The large files of a file in the second form, one by one (the frames after the first). Never throws for a damaged file: it stops
  // and says so. { added, skipped, bad (could not be used), bytes, ended (the end mark was there), broken (it stopped being readable) }.
  async function addLarge(cur, q) {
    var out = { added: 0, skipped: 0, bad: 0, bytes: 0, ended: false, broken: false }, n = 0, dec = new TextDecoder();
    try {
      for (;;) {
        var fr = await cur.next();
        if (!fr) break;
        if (fr.type === T_END) { out.ended = true; break; }
        if (fr.type !== T_FILE) throw new Error('This file is damaged.');
        var info = JSON.parse(dec.decode(await fr.bytes()));
        if (!info || typeof info.id !== 'string' || typeof info.iv !== 'string' || info.iv.length > 32 || !B64U.test(info.iv) || typeof info.ct !== 'string' || !B64U.test(info.ct)
          || typeof info.chunks !== 'number' || Math.floor(info.chunks) !== info.chunks || info.chunks < 0 || info.chunks > 1000000) throw new Error('This file is damaged.');
        n++; say('Adding large file ' + n + ' …');
        if (open !== q) return out;
        var used = 0;
        var readChunk = async function () {
          var c = await cur.next();
          if (!c || c.type !== T_CHUNK) throw new Error('This file is damaged.');
          used++;
          var b = await c.bytes();
          if (b.length < 12 + 16) throw new Error('This file is damaged.');
          return { iv: kd.b64u(b.subarray(0, 12)), ct: b.subarray(12) };
        };
        var res = null, failed = false;
        try { res = await window.keoLibrary.importFile({ id: info.id, manifest: { iv: info.iv, ct: kd.unb64u(info.ct) }, readChunk: readChunk }); } catch (e) { failed = true; }
        // line up with the next file: skip the chunks this one did not take (the frame headers only)
        for (; used < info.chunks; used++) { var sk = await cur.next(); if (!sk || sk.type !== T_CHUNK) throw new Error('This file is damaged.'); }
        if (failed) out.bad++; else if (res.status === 'added') { out.added++; out.bytes += res.size; } else out.skipped++;
      }
    } catch (e) { out.broken = true; }
    return out;
  }
  function mb(n) { return (n / 1048576).toFixed(1) + ' MB'; }
  function readFile(text, did) {
    var j;
    try { j = JSON.parse(text); } catch (e) { throw new Error('That is not a valid keo data file.'); }
    if (!j || j.keo !== 'data' || j.v !== 1 || typeof j.did !== 'string' || !j.worlds || !j.library) throw new Error('That is not a valid keo data file.');
    if (j.did !== did) throw new Error('That data was saved for another identity (' + shortDid(j.did) + '). Sign in as that identity to add it.');
    var w = j.worlds, l = j.library;
    if (!Array.isArray(w.bodies) || !Array.isArray(w.texts) || !Array.isArray(l.docs) || !Array.isArray(l.blobs)) throw new Error('This file is damaged.');
    return {
      worlds: { did: did, index: w.index ? decRec(w.index, false) : null, bodies: w.bodies.map(function (r) { return decRec(r, true); }), texts: w.texts.map(function (r) { return decRec(r, true); }) },
      library: { did: did, docs: l.docs.map(function (r) { return decRec(r, true); }), blobs: l.blobs.map(function (r) { return decRec(r, true); }) }
    };
  }

  // ---- the dialog ------------------------------------------------------------------------------------------------------
  function build() {
    if (ui) return ui;
    var root = el('div'); root.id = 'keo-transfer'; root.hidden = true;
    var box = el('div', 'box'); box.setAttribute('role', 'dialog'); box.setAttribute('aria-modal', 'true'); box.setAttribute('aria-label', 'Move my data to another webputer');
    var title = el('div', 'title', 'Move my data to another webputer');
    var head = el('div', 'head'), img = el('img', 'who-img'), who = el('div', 'who'), wname = el('div', 'who-name'), wdid = el('div', 'who-did');
    img.width = img.height = 40; img.alt = '';
    who.appendChild(wname); who.appendChild(wdid); head.appendChild(img); head.appendChild(who);
    var text = el('div', 'text', 'Your saved worlds and your library (Books, Music and Gallery, with their pictures and files, large ones too) go into one file that only this identity can open. Take the file to the other webputer, signed in as the same identity, and add it there. Nothing is overwritten: what is already on a webputer stays. Not included: friends, messages and settings.');
    var save = el('button', 'yes', 'Save my data as a file'), add = el('button', 'tool', 'Add data from a file ...');
    save.type = add.type = 'button'; save.setAttribute('data-act', 'save'); add.setAttribute('data-act', 'add');
    var file = el('input', 'file'); file.type = 'file'; file.hidden = true; file.accept = '.json,.keo,application/json,application/octet-stream,text/plain';
    var acts = el('div', 'acts'); acts.appendChild(save); acts.appendChild(add); acts.appendChild(file);
    var result = el('div', 'result'); result.setAttribute('role', 'status');
    var hint = el('div', 'hint'), btns = el('div', 'btns'), close = el('button', 'no', 'Close'); close.type = 'button'; close.setAttribute('data-act', 'close');
    btns.appendChild(close);
    [title, head, text, acts, result, hint, btns].forEach(function (x) { box.appendChild(x); });
    root.appendChild(box); document.body.appendChild(root);

    root.addEventListener('click', function (ev) {
      if (!ev.isTrusted) return;
      var b = ev.target && ev.target.closest && ev.target.closest('button[data-act]');
      if (!b || b.disabled) return;
      var act = b.getAttribute('data-act');
      if (act === 'close') return hide();
      if (act === 'save') return doSave();
      if (act === 'add') return file.click();
    });
    file.addEventListener('change', function () { var f = file.files && file.files[0]; file.value = ''; if (f) doAdd(f); });
    ui = { root: root, wname: wname, wdid: wdid, img: img, save: save, add: add, close: close, result: result, hint: hint, file: file };
    return ui;
  }
  function say(msg, cls) { ui.hint.className = 'hint' + (cls ? ' ' + cls : ''); ui.hint.textContent = msg || ''; }
  function busy(on) { open.busy = on; ui.save.disabled = ui.add.disabled = on; }
  function hide() {
    open = null; lastClosed = Date.now();
    if (ui) { ui.root.hidden = true; ui.result.textContent = ''; say(''); ui.save.disabled = ui.add.disabled = false; }
  }

  async function doSave() {
    var q = open;
    if (!q || q.busy) return;
    busy(true); ui.result.textContent = ''; say('Collecting your data …');
    try {
      var f = await makeFile();
      if (open !== q) return;
      // Nothing saved yet: no file is made, so nobody carries an empty one to another webputer and wonders why nothing arrived.
      if (f.worlds + f.docs + f.blobs + f.files === 0) { ui.result.textContent = ''; return say('There is nothing to save yet: no saved worlds and no library items.', 'bad'); }
      var url = URL.createObjectURL(f.blob);
      var a = el('a'); a.href = url; a.download = f.name;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(function () { URL.revokeObjectURL(url); }, 10000);
      var what = [plural(f.worlds, 'saved world', 'saved worlds'), plural(f.docs, 'library item', 'library items'), plural(f.blobs, 'file', 'files')];
      if (f.files) what.push(plural(f.files, 'large file', 'large files'));
      ui.result.textContent = 'Saved ' + f.name + ': ' + what.slice(0, -1).join(', ') + ' and ' + what[what.length - 1] + '. Only this identity can open it.'
        + (f.skippedFiles ? ' ' + plural(f.skippedFiles, 'large file', 'large files') + ' could not be read and ' + (f.skippedFiles === 1 ? 'is' : 'are') + ' not in it.' : '')
        + (f.pointedFiles ? ' ' + plural(f.pointedFiles, 'file', 'files') + ' you left where ' + (f.pointedFiles === 1 ? 'it is' : 'they are') + ' on this computer ' + (f.pointedFiles === 1 ? 'is' : 'are') + ' not in it: add ' + (f.pointedFiles === 1 ? 'it' : 'them') + ' again on the other computer.' : '');
      say('');
    } catch (e) { if (open === q) { ui.result.textContent = ''; say((e && e.message) || String(e), 'bad'); } }
    finally { if (open === q) busy(false); }
  }

  async function doAdd(f) {
    var q = open;
    if (!q || q.busy) return;
    busy(true); ui.result.textContent = '';
    try {
      say('Checking the file …');        // first: the last message must not stay on screen while the file is looked at
      var isBig = (await f.slice(0, MAGIC.length).text()) === MAGIC;
      if (isBig ? f.size > MAX_EXPORT : f.size > MAX_FILE) throw new Error('That file is too big to be keo data.');
      var s = await ident.current();
      if (!s || s.did !== q.did) throw new Error('The signed-in identity changed. Close this and open it again.');
      var cur = null, pack;
      if (isBig) {
        cur = frames(f);
        var first = await cur.next();
        if (!first || first.type !== T_BODY) throw new Error('That is not a valid keo data file.');
        pack = readFile(new TextDecoder().decode(await first.bytes()), s.did);
      } else pack = readFile(await f.text(), s.did);
      if (open !== q) return;
      say('Adding …');
      var w = await window.keoWorlds.importSealed(pack.worlds);
      var l = await window.keoLibrary.importSealed(pack.library);
      var big = isBig ? await addLarge(cur, q) : { added: 0, skipped: 0, bad: 0, bytes: 0, ended: true, broken: false };
      if (open !== q) return;
      var lines = [];
      var added = [plural(w.added.length, 'saved world', 'saved worlds'), plural(l.docs, 'library item', 'library items'), plural(l.blobs, 'file', 'files')];
      if (isBig) added.push(plural(big.added, 'large file', 'large files') + (big.added ? ' (' + mb(big.bytes) + ')' : ''));
      lines.push('Added ' + added.slice(0, -1).join(', ') + ' and ' + added[added.length - 1] + '.');
      var left = w.skipped.length + l.skippedDocs + l.skippedBlobs + big.skipped;
      if (left) lines.push('Left alone because they are already here: ' + [w.skipped.length ? plural(w.skipped.length, 'saved world', 'saved worlds') + ' (' + w.skipped.slice(0, 5).join(', ') + (w.skipped.length > 5 ? ', …' : '') + ')' : '', l.skippedDocs ? plural(l.skippedDocs, 'library item', 'library items') : '', l.skippedBlobs ? plural(l.skippedBlobs, 'file', 'files') : '', big.skipped ? plural(big.skipped, 'large file', 'large files') : ''].filter(Boolean).join(', ') + '.');
      var bad = w.unreadable.length + l.unreadable + big.bad;
      if (bad) lines.push('Could not be used (damaged, or not valid here): ' + bad + '.');
      if (big.broken || (isBig && !big.ended)) lines.push('The file stops early or is damaged, so some large files may be missing. Save it again on the other webputer and add the new file.');
      ui.result.textContent = lines.join(' ');
      say('Open My worlds again to see them.', w.added.length + l.docs + l.blobs + big.added ? 'good' : '');
      emit({ type: 'transfer', kind: 'added', worlds: w.added.length, docs: l.docs, blobs: l.blobs, files: big.added });
    } catch (e) { if (open === q) { ui.result.textContent = ''; say((e && e.message) || String(e), 'bad'); } }
    finally { if (open === q) busy(false); }
  }

  // ---- what the world may ask ------------------------------------------------------------------------------------------
  // Puts the dialog in front of the person. Adds nothing and shows nothing the world sent.
  async function start() {
    if (open) throw new Error('This is already open.');
    if (Date.now() - lastClosed < DISMISS_MS) throw new Error('This was closed a moment ago.');
    var s = await ident.current();
    if (!s) throw new Error('Sign in first: this moves the data of the identity that is signed in.');
    if (open) throw new Error('This is already open.');
    build();
    open = { did: s.did, busy: false };
    ui.wname.textContent = s.label || ''; ui.wdid.textContent = shortDid(s.did); ui.wdid.title = s.did; ui.img.src = icons.dataUrl(s.did, 80);
    ui.result.textContent = ''; say('');
    ui.root.hidden = false;
    ui.save.focus();
    return true;
  }
  // For code in THIS page (shell.js, when the session ends): nothing of one identity's dialog is left for the next to find.
  function reset() { if (open) hide(); lastClosed = 0; }

  window.keoTransfer = { start: start, reset: reset, onEvent: function (fn) { listener = fn; } };
})();
