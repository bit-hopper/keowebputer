// Adding an identity to a second webputer, SHELL side: the dialog in which a person does it, on both webputers. Runs in the extension's own
// page; the sandboxed world is assumed hostile. What happens underneath is keo-identity.js (enrollRequest / enrollGrant / enrollComplete /
// enrollAccept); the text carried between the webputers is keo-enroll-code.js. This file is only the person's part of it.
//
//   NEW webputer ("mode new"): makes a request code and shows eight words for it. The person gives the code to the webputer that has the
//     identity (pasted, sent, or saved as a file), pastes the reply code back, types the eight words of the IDENTITY that the old webputer
//     shows, and clicks Add. Then it shows a finished code to take back.
//   OLD webputer ("mode old", needs someone signed in): shows the eight words of the signed-in identity, takes the request code, and wants
//     the eight words the NEW webputer shows for it. Only on a match does Approve work, and approving is where the passkey prompt appears.
//     It then shows the reply code, and takes the finished code when it comes back.
//
// The rules (the world is assumed hostile):
//  - The two sets of words are the whole protection (see keo-identity.js: a request swapped on the way, or a forged reply, is caught only
//    by a person comparing them). So each dialog shows the words the OTHER webputer has to be given and never the ones it has to be
//    TYPED from: the old webputer shows its identity's words but never the request's, the new webputer shows the request's but never the
//    identity's. A person who only copies from the screen therefore has nothing to copy.
//  - The words are typed into this page's own input and checked here against the code that was pasted, never against anything the world
//    sends. The world can only ASK for the dialog (enroll.open, with a mode): there is no op that fills it in, answers it, or reads it.
//  - Only a real click counts (isTrusted). Asked again while one is up, or within a few seconds of one being closed, the world is refused,
//    so it cannot keep the question in front of the person.
//  - What is shown about a request (where the new passkey lives) is text the other webputer chose, shown as text and nothing more.
// Not for: anything that has to work without a person present. There is no way to approve a webputer from code.
(function () {
  'use strict';
  var ident = window.keoIdentity, fp = window.keoFingerprint, codec = window.keoEnrollCode, icons = window.keoIdenticon;
  var DISMISS_MS = 10000;
  var open = null;                  // { mode, step, ... } while the dialog is up
  var lastClosed = 0, listener = null, ui = null;

  function emit(ev) { if (listener) { try { listener(ev); } catch (e) {} } }
  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  function shortDid(did) {
    var m = /^did:keo:[^:]+:([A-Za-z0-9_-]{43})$/.exec(String(did));
    return m ? 'keo:' + m[1].slice(0, 4) + '…' + m[1].slice(-4) : String(did).slice(0, 24);
  }
  function group(label, node) {
    var g = el('div', 'group'), l = el('div', 'label', label);
    g.appendChild(l); g.appendChild(node); g.labelEl = l;
    return g;
  }

  // ---- the dialog -----------------------------------------------------------------------------------------------------
  function build() {
    if (ui) return ui;
    var root = el('div'); root.id = 'keo-enroll'; root.hidden = true;
    var box = el('div', 'box'); box.setAttribute('role', 'dialog'); box.setAttribute('aria-modal', 'true'); box.setAttribute('aria-label', 'Link a webputer to an identity');
    var title = el('div', 'title'), text = el('div', 'text');
    var head = el('div', 'head'), img = el('img', 'who-img'), who = el('div', 'who'), wname = el('div', 'who-name'), wdid = el('div', 'who-did');
    img.width = img.height = 40; img.alt = '';
    who.appendChild(wname); who.appendChild(wdid); head.appendChild(img); head.appendChild(who);

    var nameIn = el('input', 'name'); nameIn.type = 'text'; nameIn.maxLength = 64; nameIn.autocomplete = 'off'; nameIn.setAttribute('aria-label', 'Name for this identity on this webputer');
    var gName = group('A name for this identity on this webputer', nameIn);

    var words = el('div', 'words'), gWords = group('Words', words);

    var out = el('textarea', 'code'); out.readOnly = true; out.rows = 4; out.setAttribute('aria-label', 'Code to give to the other webputer');
    var copy = el('button', 'tool', 'Copy'), save = el('button', 'tool', 'Save as file'); copy.type = save.type = 'button';
    copy.setAttribute('data-act', 'copy'); save.setAttribute('data-act', 'save');
    var outTools = el('div', 'tools'); outTools.appendChild(copy); outTools.appendChild(save);
    var gOut = group('Code', out); gOut.appendChild(outTools);

    var inp = el('textarea', 'code'); inp.rows = 4; inp.spellcheck = false; inp.setAttribute('aria-label', 'Code from the other webputer');
    var file = el('input', 'file'); file.type = 'file'; file.hidden = true; file.accept = '.txt,text/plain';
    var openF = el('button', 'tool', 'Open a file'); openF.type = 'button'; openF.setAttribute('data-act', 'open');
    var inTools = el('div', 'tools'); inTools.appendChild(openF); inTools.appendChild(file);
    var gIn = group('Code', inp); gIn.appendChild(inTools);

    var typed = el('input', 'typed'); typed.type = 'text'; typed.autocomplete = 'off'; typed.spellcheck = false; typed.setAttribute('autocapitalize', 'off'); typed.setAttribute('aria-label', 'Eight words');
    var gTyped = group('Words', typed);

    var hint = el('div', 'hint'), btns = el('div', 'btns');
    var no = el('button', 'no', 'Cancel'), yes = el('button', 'yes', 'OK');
    no.type = yes.type = 'button'; no.setAttribute('data-ans', 'no'); yes.setAttribute('data-ans', 'yes');
    btns.appendChild(no); btns.appendChild(yes);
    [title, head, text, gName, gWords, gOut, gIn, gTyped, hint, btns].forEach(function (x) { box.appendChild(x); });
    root.appendChild(box);
    document.body.appendChild(root);

    // Only a real click counts. Nothing in the world can reach this page's elements, but the check costs nothing.
    root.addEventListener('click', function (ev) {
      if (!ev.isTrusted) return;
      var b = ev.target && ev.target.closest && ev.target.closest('button[data-ans], button[data-act]');
      if (!b) return;
      var act = b.getAttribute('data-act');
      if (act === 'copy') return copyOut();
      if (act === 'save') return saveOut();
      if (act === 'open') return file.click();
      if (b.getAttribute('data-ans') === 'no') return close();
      go();
    });
    file.addEventListener('change', function () {
      var f = file.files && file.files[0];
      if (!f) return;
      if (f.size > codec.MAX_CHARS * 2) { say('That file is too big to be a code.', 'bad'); file.value = ''; return; }
      f.text().then(function (t) { inp.value = t; file.value = ''; gotIn(); }, function () { say('That file could not be read.', 'bad'); });
    });
    inp.addEventListener('input', gotIn);
    typed.addEventListener('input', checkWords);
    ui = { root: root, title: title, text: text, head: head, img: img, wname: wname, wdid: wdid, gName: gName, nameIn: nameIn, gWords: gWords, words: words,
      gOut: gOut, out: out, gIn: gIn, inp: inp, gTyped: gTyped, typed: typed, hint: hint, no: no, yes: yes };
    return ui;
  }
  function say(msg, cls) { ui.hint.className = 'hint' + (cls ? ' ' + cls : ''); ui.hint.textContent = msg || ''; }
  function hide() { open = null; lastClosed = Date.now(); if (ui) { ui.root.hidden = true; ui.inp.value = ''; ui.out.value = ''; ui.typed.value = ''; ui.words.textContent = ''; ui.yes.disabled = true; say(''); } }
  function close() {
    var q = open, reload = q && q.mode === 'new' && q.step === 'done';
    if (q && q.mode === 'new' && q.step !== 'done') ident.enrollCancel();      // a request that was never answered is dropped
    hide();
    // A webputer with nobody signed in is signed in as the identity just added: the world on screen is still the sign-in screen.
    if (reload) setTimeout(function () { location.reload(); }, 0);
  }

  // What each step shows. One place, so a step cannot leave a piece of the last one on screen.
  function render() {
    var q = open, u = ui, s = q.step, isNew = q.mode === 'new';
    var show = { head: false, name: false, words: false, out: false, inp: false, typed: false, yes: true };
    u.yes.disabled = true; u.yes.className = 'yes'; u.no.textContent = 'Cancel';
    u.title.textContent = isNew ? 'Link this webputer to an identity' : 'Link a new webputer to this identity';
    if (isNew && s === 'start') {
      u.text.textContent = 'Use this on a webputer that does not have your identity yet. It makes a new passkey for this webputer, then a code to give to the webputer that has the identity. Nothing leaves this webputer until you give it the code.';
      show.name = true; u.yes.textContent = 'Make a code'; u.yes.disabled = false;
    } else if (isNew && s === 'wait') {
      u.text.textContent = 'On the webputer that has your identity, choose "Link a new webputer" and give it the code below (copy it, or save it as a file). It will ask you for the eight words: type them there. Then paste or open the reply it gives you here.';
      show.out = show.words = show.inp = true; u.yes.textContent = 'Link this webputer';
      u.gOut.labelEl.textContent = 'Code to give to the other webputer'; u.gWords.labelEl.textContent = 'Words to type on the other webputer (they are not secret, but they must be the ones shown here)';
      u.gIn.labelEl.textContent = 'Reply from the other webputer';
    } else if (isNew && s === 'confirm') {
      u.text.textContent = 'Make sure this is the identity you mean. The other webputer shows eight words for it: type them here exactly as it shows them.';
      show.head = show.typed = true; u.yes.textContent = 'Link this webputer'; u.gTyped.labelEl.textContent = 'The words the other webputer shows for the identity';
    } else if (isNew && s === 'done') {
      u.text.textContent = 'This webputer now has the identity, with a passkey of its own. Give the finished code below back to the other webputer (paste it there, or open the file) so both keep the same list of passkeys. You can do that later.';
      show.head = show.out = true; show.yes = false; u.no.textContent = 'Close'; u.gOut.labelEl.textContent = 'Finished code to give back to the other webputer';
    } else if (!isNew && s === 'paste') {
      u.text.textContent = 'On the new webputer, choose "Link this webputer to an identity" and make a code. Paste it here (or open the file). Read the words below to the new webputer if it asks for them.';
      show.head = show.words = show.inp = true; u.yes.textContent = 'Approve this webputer';
      u.gWords.labelEl.textContent = 'The words of this identity: the new webputer asks for these'; u.gIn.labelEl.textContent = 'Code from the new webputer';
    } else if (!isNew && s === 'confirm') {
      u.text.textContent = 'A new webputer asks to use this identity, with a passkey on ' + q.where + '. Only approve it if it is a webputer of yours that you are holding. Type the eight words the NEW webputer shows. Approving asks for your passkey, then gives you a reply to take to it.';
      show.head = show.typed = true; u.yes.textContent = 'Approve this webputer'; u.gTyped.labelEl.textContent = 'The words the new webputer shows';
    } else if (!isNew && s === 'granted') {
      u.text.textContent = 'Give the reply below to the new webputer (copy it, or save it as a file). When the new webputer has finished it shows one more code: paste it below so this webputer keeps the same list of passkeys. You can do that later.';
      show.head = show.out = show.inp = true; show.yes = false; u.no.textContent = 'Close';
      u.gOut.labelEl.textContent = 'Reply to give to the new webputer'; u.gIn.labelEl.textContent = 'Finished code from the new webputer (optional)';
    }
    u.head.hidden = !show.head; u.gName.hidden = !show.name; u.gWords.hidden = !show.words; u.gOut.hidden = !show.out; u.gIn.hidden = !show.inp;
    u.gTyped.hidden = !show.typed; u.yes.hidden = !show.yes;
    if (show.out) u.out.value = q.code || '';
    if (show.words) u.words.textContent = q.words ? q.words.join(' ') : '…';
    if (show.head && q.did) { u.wname.textContent = q.label || ''; u.wdid.textContent = shortDid(q.did); u.wdid.title = q.did; u.img.src = icons.dataUrl(q.did, 80); }
    if (show.typed) { u.typed.value = ''; u.typed.focus(); }
    else if (show.inp) { u.inp.value = ''; u.inp.focus(); }
    else if (show.name) u.nameIn.focus();
    say('');
  }

  // ---- what the person puts in ----------------------------------------------------------------------------------------
  function copyOut() {
    var u = ui, t = u.out.value;
    function fallback() { u.out.select(); try { document.execCommand('copy'); say('Copied.', 'good'); } catch (e) { say('Select the code and copy it yourself.', 'bad'); } }
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(t).then(function () { say('Copied.', 'good'); }, fallback); else fallback();
  }
  function saveOut() {
    var q = open, kind = q.step === 'wait' ? 'request' : q.step === 'done' ? 'done' : 'grant';
    var url = URL.createObjectURL(new Blob([ui.out.value + '\n'], { type: 'text/plain' }));
    var a = el('a'); a.href = url; a.download = 'keo-enroll-' + kind + '.txt';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 10000);
    say('Saved as ' + a.download + '.', 'good');
  }

  // Text arrived in the paste box (typed, pasted or read from a file).
  async function gotIn() {
    var q = open, u = ui;
    if (!q || q.busy) return;
    var id = ++q.inId, text = u.inp.value;
    if (!text.trim()) return say('');
    try {
      if (q.mode === 'new' && q.step === 'wait') {
        var grant = codec.decode('grant', text), pre = await ident.enrollPreview(grant);
        if (open !== q || q.inId !== id) return;
        q.grant = grant; q.did = pre.did; q.label = ''; q.step = 'confirm'; render();
      } else if (q.mode === 'old' && q.step === 'paste') {
        var req = codec.decode('request', text);
        if (!req.key || typeof req.key.rpId !== 'string') throw new Error('That is not a valid code.');
        if (open !== q || q.inId !== id) return;
        q.request = req; q.where = req.key.rpId.slice(0, 80); q.step = 'confirm'; render();
      } else if (q.mode === 'old' && q.step === 'granted') {
        var done = codec.decode('done', text);
        var sum = await ident.enrollAccept({ did: q.did, events: done.events });
        if (open !== q || q.inId !== id) return;
        say('Done. This webputer now lists ' + sum.authorityKeys + ' passkeys for this identity.', 'good');
        emit({ type: 'enroll', kind: 'accepted', did: q.did });
      }
    } catch (e) {
      if (open === q && q.inId === id) say(e && e.message || String(e), 'bad');
    }
  }

  // The words typed, against the code that was pasted. The hint says what is wrong; the button wakes only on a match.
  function checkWords() {
    var q = open, u = ui;
    if (!q || q.step !== 'confirm') return;
    var id = ++q.checkId, text = u.typed.value, said = fp.parse(text);
    u.yes.disabled = true; u.hint.className = 'hint';
    if (!text.trim()) { u.hint.textContent = ''; return; }
    if (said === null) { u.hint.textContent = 'That is not one of the words from the list.'; return; }
    if (said.length < fp.COUNT) { u.hint.textContent = said.length + ' of ' + fp.COUNT + ' words.'; return; }
    if (said.length > fp.COUNT) { u.hint.textContent = 'That is more than ' + fp.COUNT + ' words.'; return; }
    var test = q.mode === 'new' ? fp.matches(q.did, text) : ident.enrollWordsMatch(q.request, text);
    test.then(function (ok) {
      if (open !== q || q.checkId !== id) return;
      u.yes.disabled = !ok;
      u.hint.className = ok ? 'hint good' : 'hint bad';
      u.hint.textContent = ok ? 'They match.' : 'Those are not the words. Do not go on: this may not be the webputer or the identity you think it is.';
    });
  }

  // The primary button.
  async function go() {
    var q = open, u = ui;
    if (!q || q.busy || u.yes.disabled) return;
    q.busy = true; u.yes.disabled = true; u.no.disabled = true; say('Waiting for your passkey…');
    try {
      if (q.mode === 'new' && q.step === 'start') {
        var r = await ident.enrollRequest({ label: u.nameIn.value });
        if (open !== q) return;
        q.words = r.words; q.code = codec.encode('request', r.request); q.step = 'wait';
      } else if (q.mode === 'new' && q.step === 'confirm') {
        // Checked again at the click, from the code that was pasted, not from what the button's state says.
        if (!(await fp.matches(q.did, u.typed.value))) { q.busy = false; u.no.disabled = false; return checkWords(); }
        var res = await ident.enrollComplete({ grant: q.grant, confirm: u.typed.value });
        if (open !== q) return;
        q.code = codec.encode('done', res.done); q.label = res.label; q.step = 'done';
        emit({ type: 'enroll', kind: 'added', did: q.did });
      } else if (q.mode === 'old' && q.step === 'confirm') {
        if (!(await ident.enrollWordsMatch(q.request, u.typed.value))) { q.busy = false; u.no.disabled = false; return checkWords(); }
        var g = await ident.enrollGrant({ did: q.did, request: q.request, confirm: u.typed.value });
        if (open !== q) return;
        q.code = codec.encode('grant', g); q.step = 'granted';
        emit({ type: 'enroll', kind: 'granted', did: q.did });
      }
      q.busy = false; u.no.disabled = false; render();
    } catch (e) {
      q.busy = false; u.no.disabled = false;
      // Whatever the person had to do for the button to work is still done, so it stays usable for another try.
      if (open === q) { if (q.step === 'start' || q.step === 'confirm') u.yes.disabled = false; say((e && e.message) || String(e), 'bad'); }
    }
  }

  // ---- what the world may ask -----------------------------------------------------------------------------------------
  // Puts the dialog in front of the person. Adds nothing and shows nothing the world sent.
  async function start(args) {
    var mode = args && args.mode;
    if (mode !== 'new' && mode !== 'old') throw new Error('Unknown way of linking a webputer.');
    if (open) throw new Error('This is already waiting for an answer.');
    if (Date.now() - lastClosed < DISMISS_MS) throw new Error('This was closed a moment ago.');
    var q = { mode: mode, step: mode === 'new' ? 'start' : 'paste', inId: 0, checkId: 0, busy: false };
    if (mode === 'old') {
      var s = await ident.current();
      if (!s) throw new Error('Sign in first: this is for linking a new webputer to the identity that is signed in.');
      q.did = s.did; q.label = s.label; q.words = await fp.words(s.did);
    }
    if (open) throw new Error('This is already waiting for an answer.');
    build();
    open = q;
    ui.root.hidden = false;
    render();
    return true;
  }
  // For code in THIS page (shell.js, when the session ends): nothing of one identity's dialog is left for the next to find.
  function reset() { if (open && open.mode === 'new' && open.step !== 'done') ident.enrollCancel(); hide(); lastClosed = 0; }

  window.keoEnroll = { start: start, reset: reset, onEvent: function (fn) { listener = fn; } };
})();
