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
  var FILE_NAME = 'keo-data.json';
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
    return { blob: new Blob([body], { type: 'application/json' }), worlds: w.bodies.length, docs: l.docs.length, blobs: l.blobs.length, };
  }
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
    var text = el('div', 'text', 'Your saved worlds and your library (Books, Music and Gallery, with their pictures and files) go into one file that only this identity can open. Take the file to the other webputer, signed in as the same identity, and add it there. Nothing is overwritten: what is already on a webputer stays. Not included: friends, messages and settings.');
    var save = el('button', 'yes', 'Save my data as a file'), add = el('button', 'tool', 'Add data from a file ...');
    save.type = add.type = 'button'; save.setAttribute('data-act', 'save'); add.setAttribute('data-act', 'add');
    var file = el('input', 'file'); file.type = 'file'; file.hidden = true; file.accept = '.json,application/json,text/plain';
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
      if (f.worlds + f.docs + f.blobs === 0) { ui.result.textContent = ''; return say('There is nothing to save yet: no saved worlds and no library items.', 'bad'); }
      var url = URL.createObjectURL(f.blob);
      var a = el('a'); a.href = url; a.download = FILE_NAME;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(function () { URL.revokeObjectURL(url); }, 10000);
      ui.result.textContent = 'Saved ' + FILE_NAME + ': ' + plural(f.worlds, 'saved world', 'saved worlds') + ', ' + plural(f.docs, 'library item', 'library items') + ' and ' + plural(f.blobs, 'file', 'files') + '. Only this identity can open it.';
      say('');
    } catch (e) { if (open === q) { ui.result.textContent = ''; say((e && e.message) || String(e), 'bad'); } }
    finally { if (open === q) busy(false); }
  }

  async function doAdd(f) {
    var q = open;
    if (!q || q.busy) return;
    busy(true); ui.result.textContent = '';
    try {
      if (f.size > MAX_FILE) throw new Error('That file is too big to be keo data.');
      say('Checking the file …');
      var s = await ident.current();
      if (!s || s.did !== q.did) throw new Error('The signed-in identity changed. Close this and open it again.');
      var pack = readFile(await f.text(), s.did);
      if (open !== q) return;
      say('Adding …');
      var w = await window.keoWorlds.importSealed(pack.worlds);
      var l = await window.keoLibrary.importSealed(pack.library);
      if (open !== q) return;
      var lines = [];
      lines.push('Added ' + plural(w.added.length, 'saved world', 'saved worlds') + ', ' + plural(l.docs, 'library item', 'library items') + ' and ' + plural(l.blobs, 'file', 'files') + '.');
      var left = w.skipped.length + l.skippedDocs + l.skippedBlobs;
      if (left) lines.push('Left alone because they are already here: ' + [w.skipped.length ? plural(w.skipped.length, 'saved world', 'saved worlds') + ' (' + w.skipped.slice(0, 5).join(', ') + (w.skipped.length > 5 ? ', …' : '') + ')' : '', l.skippedDocs ? plural(l.skippedDocs, 'library item', 'library items') : '', l.skippedBlobs ? plural(l.skippedBlobs, 'file', 'files') : ''].filter(Boolean).join(', ') + '.');
      var bad = w.unreadable.length + l.unreadable;
      if (bad) lines.push('Could not be used (damaged, or not valid here): ' + bad + '.');
      ui.result.textContent = lines.join(' ');
      say('Open My worlds again to see them.', w.added.length + l.docs + l.blobs ? 'good' : '');
      emit({ type: 'transfer', kind: 'added', worlds: w.added.length, docs: l.docs, blobs: l.blobs });
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
