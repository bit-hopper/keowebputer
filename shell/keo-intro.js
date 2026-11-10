// keo introductions, SHELL side: the screen that SHOWS this device's introduction as a QR code (and as text), and the screen that READS
// someone else's and adds them as a friend. Runs in the extension's own page; the sandboxed world is assumed hostile and can only ASK for
// the screen to open (intro.show, intro.read): what is drawn, our helper addresses, and the Add button stay in this page, like the friend
// dialog (keo-friend.js), and for the same reasons. The text, how it is made and read, and what it does and does not say is keo-hello.js
// (introToText / introFromText); the QR drawing is keo-qr.js.
//
// The rules (the world is assumed hostile; an introduction is NOT signed):
//  - Reading an introduction adds nobody. The DID in it is only what the sender claims, so a friend is added only after the person has
//    typed the eight words the OTHER person reads out and they match THAT DID, then clicked Add with a real click. Our own words are shown
//    in the other screen to be read out; the other side's words are never shown, so the check cannot be passed by copying from the screen.
//  - The name in an introduction is text somebody chose. It is shown as "calls themselves ..." beside the picture and short DID that
//    come from the DID, and it is never what identifies anyone.
//  - The addresses in it are shown as a hint and NOT kept: the signed card the friend's device sends once connected (keo-cards.js) is what
//    is stored. A wrong address only fails to connect; whoever answers still has to prove the DID.
//  - The world can ask for a screen, never fill, answer or close it. Asked again while one is up, while the friend dialog is up, or within
//    a few seconds of a dismissal, it is refused, so it cannot keep putting the screen in front of the person.
(function () {
  'use strict';
  var hello = window.keoHello, contacts = window.keoContacts, fp = window.keoFingerprint, icons = window.keoIdenticon, ident = window.keoIdentity,
    cards = window.keoCards, qr = window.keoQr, p2p = window.keoP2p;
  var DISMISS_MS = 10000, QR_PX = 264;
  var open = null;                  // { mode, id } while the screen is up
  var lastDismissed = 0, listener = null, ui = null, serial = 0;

  function emit(ev) { if (listener) { try { listener(ev); } catch (e) {} } }
  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  function shortDid(did) {
    var m = /^did:keo:[^:]+:([A-Za-z0-9_-]{43})$/.exec(String(did));
    return m ? 'keo:' + m[1].slice(0, 4) + '…' + m[1].slice(-4) : String(did).slice(0, 24);
  }
  function helperText(list) {
    return list.map(function (x) { return (x.kind === 'ws' ? 'ws://' : 'http://') + (x.host.indexOf(':') >= 0 ? '[' + x.host + ']' : x.host) + ':' + x.port; }).join('\n');
  }
  function friendDialogUp() { var r = document.getElementById('keo-friend'); return !!r && !r.hidden; }

  // ---- the screen -----------------------------------------------------------------------------------------------------
  function build() {
    if (ui) return ui;
    var root = el('div'); root.id = 'keo-intro'; root.hidden = true;
    var box = el('div', 'box'); box.setAttribute('role', 'dialog'); box.setAttribute('aria-modal', 'true'); box.setAttribute('aria-label', 'Introduction');
    var tabs = el('div', 'tabs'), tShow = el('button', 'tab', 'Show mine'), tRead = el('button', 'tab', 'Read one');
    tShow.type = tRead.type = 'button'; tShow.setAttribute('data-tab', 'show'); tRead.setAttribute('data-tab', 'read');
    tabs.setAttribute('role', 'tablist'); tShow.setAttribute('role', 'tab'); tRead.setAttribute('role', 'tab');
    tabs.appendChild(tShow); tabs.appendChild(tRead);

    // show
    var vShow = el('div', 'view show');
    var sHead = el('div', 'head'), sImg = el('img', 'who-img'), sWho = el('div', 'who'), sName = el('div', 'who-name'), sDid = el('div', 'who-did');
    sImg.width = sImg.height = 40; sImg.alt = ''; sWho.appendChild(sName); sWho.appendChild(sDid); sHead.appendChild(sImg); sHead.appendChild(sWho);
    var qrBox = el('div', 'qr'), canvas = document.createElement('canvas'); canvas.setAttribute('role', 'img'); canvas.setAttribute('aria-label', 'QR code of your introduction'); qrBox.appendChild(canvas);
    var sText = el('div', 'text', 'Show this to the person next to you and have them scan it with the keo phone app, or send them the text below. It says who you are and where you can be reached. It is not a password.');
    var sWordsL = el('div', 'label', 'Your words — read these to them'), sWords = el('div', 'words');
    var sReachL = el('div', 'label', 'Where you can be reached'), sReach = el('div', 'reach');
    var sRawL = el('div', 'label', 'The same as text'), sRaw = el('textarea', 'raw'); sRaw.readOnly = true; sRaw.rows = 3; sRaw.spellcheck = false; sRaw.setAttribute('aria-label', 'Your introduction as text');
    var sCopy = el('button', 'copy', 'Copy text'); sCopy.type = 'button'; sCopy.setAttribute('data-act', 'copy');
    var sHint = el('div', 'hint');
    [sHead, qrBox, sText, sWordsL, sWords, sReachL, sReach, sRawL, sRaw, sCopy, sHint].forEach(function (x) { vShow.appendChild(x); });

    // read
    var vRead = el('div', 'view read');
    var rPasteL = el('label', 'label', 'Paste the introduction you were sent or scanned'), rPaste = el('textarea', 'paste'); rPaste.rows = 3; rPaste.spellcheck = false;
    rPaste.setAttribute('autocapitalize', 'off'); rPaste.setAttribute('aria-label', 'An introduction as text'); rPasteL.appendChild(rPaste);
    var rHint = el('div', 'hint');
    var rResult = el('div', 'result'); rResult.hidden = true;
    var rHead = el('div', 'head'), rImg = el('img', 'who-img'), rWho = el('div', 'who'), rName = el('div', 'who-name'), rDid = el('div', 'who-did');
    rImg.width = rImg.height = 40; rImg.alt = ''; rWho.appendChild(rName); rWho.appendChild(rDid); rHead.appendChild(rImg); rHead.appendChild(rWho);
    var rReach = el('div', 'reach');
    var rText = el('div', 'text', 'Anyone can make an introduction that names someone else. Make sure this is the person you mean: ask them to read you their eight words (from their Show mine screen), type them here and add them only if they match.');
    var rTheirL = el('label', 'label', 'Their words — type what they read to you'), rTheir = el('input', 'theirs');
    rTheir.type = 'text'; rTheir.autocomplete = 'off'; rTheir.spellcheck = false; rTheir.setAttribute('autocapitalize', 'off'); rTheir.setAttribute('aria-label', 'Their eight words'); rTheirL.appendChild(rTheir);
    var rCheck = el('div', 'hint');
    [rHead, rReach, rText, rTheirL, rCheck].forEach(function (x) { rResult.appendChild(x); });
    [rPasteL, rHint, rResult].forEach(function (x) { vRead.appendChild(x); });

    var btns = el('div', 'btns'), close = el('button', 'no', 'Close'), yes = el('button', 'yes', 'Add as friend');
    close.type = yes.type = 'button'; close.setAttribute('data-ans', 'no'); yes.setAttribute('data-ans', 'yes'); yes.disabled = true; yes.hidden = true;
    btns.appendChild(close); btns.appendChild(yes);
    [tabs, vShow, vRead, btns].forEach(function (x) { box.appendChild(x); });
    root.appendChild(box);
    document.body.appendChild(root);

    // Only a real click counts. Nothing in the world can reach this page's elements, but the check costs nothing.
    root.addEventListener('click', function (ev) {
      if (!ev.isTrusted) return;
      var t = ev.target && ev.target.closest && ev.target.closest('button[data-tab]');
      if (t) return switchTo(t.getAttribute('data-tab'));
      var c = ev.target && ev.target.closest && ev.target.closest('button[data-act="copy"]');
      if (c) return copyText();
      var b = ev.target && ev.target.closest && ev.target.closest('button[data-ans]');
      if (!b) return;
      if (b.getAttribute('data-ans') === 'no') return dismiss();
      add();
    });
    // Escape closes the screen wherever the focus is while it is up (on the page, not only inside the box); Tab stays inside it, as a
    // modal screen should: the page behind is not reachable from it.
    document.addEventListener('keydown', function (ev) {
      if (!open || !ev.isTrusted) return;
      if (ev.key === 'Escape') return dismiss();
      if (ev.key === 'Tab') trapTab(ev);
    });
    box.tabIndex = -1;
    rPaste.addEventListener('input', readPasted);
    rTheir.addEventListener('input', checkWords);
    ui = { root: root, tShow: tShow, tRead: tRead, vShow: vShow, vRead: vRead, sImg: sImg, sName: sName, sDid: sDid, canvas: canvas, sWords: sWords, sReach: sReach, sRaw: sRaw, sHint: sHint,
      rPaste: rPaste, rHint: rHint, rResult: rResult, rImg: rImg, rName: rName, rDid: rDid, rReach: rReach, rTheir: rTheir, rCheck: rCheck, close: close, yes: yes };
    return ui;
  }
  // What Tab can reach inside the screen right now (the hidden view and disabled buttons are not in it).
  function focusables() {
    return Array.prototype.filter.call(ui.root.querySelectorAll('button, textarea, input'), function (x) { return !x.disabled && !x.hidden && x.offsetParent !== null; });
  }
  function trapTab(ev) {
    var list = focusables();
    if (!list.length) return;
    var first = list[0], last = list[list.length - 1], a = document.activeElement, box = ui.root.querySelector('.box');
    if (!ui.root.contains(a) || (ev.shiftKey && (a === first || a === box))) { ev.preventDefault(); (ev.shiftKey ? last : first).focus(); }
    else if (!ev.shiftKey && a === last) { ev.preventDefault(); first.focus(); }
  }
  function hide() {
    open = null;
    if (!ui) return;
    ui.root.hidden = true;
    ui.rPaste.value = ''; ui.rTheir.value = ''; ui.sRaw.value = ''; ui.sWords.textContent = ''; ui.rResult.hidden = true; ui.yes.disabled = true; ui.yes.hidden = true;
    ui.canvas.width = ui.canvas.height = 0;
  }
  function dismiss() { lastDismissed = Date.now(); hide(); }

  function switchTo(mode) {
    if (!open || open.mode === mode) return;
    open.mode = mode; open.id = ++serial;
    var u = ui;
    u.tShow.classList.toggle('on', mode === 'show'); u.tRead.classList.toggle('on', mode === 'read');
    u.tShow.setAttribute('aria-selected', String(mode === 'show')); u.tRead.setAttribute('aria-selected', String(mode === 'read'));
    u.vShow.hidden = mode !== 'show'; u.vRead.hidden = mode !== 'read';
    u.yes.hidden = mode !== 'read'; u.yes.disabled = true;
    if (mode === 'show') fillShow(open); else { u.rPaste.focus(); }
  }

  // ---- showing ours ---------------------------------------------------------------------------------------------------
  function fillShow(q) {
    var u = ui;
    u.sName.textContent = ''; u.sDid.textContent = ''; u.sWords.textContent = '…'; u.sReach.textContent = ''; u.sHint.textContent = ''; u.sHint.className = 'hint';
    ident.current().then(function (s) {
      if (!s) throw new Error('Sign in first.');
      return Promise.all([cards.exportIntro(), fp.words(s.did)]).then(function (r) { return { s: s, text: r[0], words: r[1] }; });
    }).then(function (r) {
      if (open !== q || q.mode !== 'show') return;
      u.sName.textContent = r.s.label || 'Unnamed';
      u.sDid.textContent = shortDid(r.s.did); u.sDid.title = r.s.did;
      u.sImg.src = icons.dataUrl(r.s.did, 80);
      u.sWords.textContent = r.words.join(' ');
      var helpers = cards.diag().helpers || [];
      u.sReach.textContent = helpers.length ? helperText(helpers) : 'Nowhere yet: this device has no helper. The person who scans this can still add you; connecting then works only while you are on the same network.';
      u.sRaw.value = r.text;
      try { qr.draw(u.canvas, r.text, QR_PX); } catch (e) { u.sHint.className = 'hint bad'; u.sHint.textContent = 'The code could not be drawn: ' + e.message + ' Send the text instead.'; }
    }).catch(function (e) {
      if (open !== q) return;
      u.sHint.className = 'hint bad'; u.sHint.textContent = 'Could not make your introduction: ' + (e && e.message || e);
    });
  }
  function copyText() {
    var u = ui, text = u.sRaw.value;
    if (!text) return;
    var done = function () { u.sHint.className = 'hint good'; u.sHint.textContent = 'Copied.'; };
    var fail = function () { u.sRaw.focus(); u.sRaw.select(); u.sHint.className = 'hint'; u.sHint.textContent = 'Press Ctrl+C to copy the selected text.'; };
    try { navigator.clipboard.writeText(text).then(done, fail); } catch (e) { fail(); }
  }

  // ---- reading theirs -------------------------------------------------------------------------------------------------
  // What was pasted: its shape is checked by keo-hello.js, then the person is shown who it names and asked for the other person's words.
  function readPasted() {
    var q = open, u = ui;
    if (!q || q.mode !== 'read') return;
    var id = ++q.id, text = u.rPaste.value;
    q.intro = null; u.rResult.hidden = true; u.yes.disabled = true; u.rTheir.value = ''; u.rCheck.textContent = ''; u.rCheck.className = 'hint';
    if (!text.trim()) { u.rHint.textContent = ''; u.rHint.className = 'hint'; return; }
    var intro;
    try { intro = hello.introFromText(text); } catch (e) { u.rHint.className = 'hint bad'; u.rHint.textContent = e.message; return; }
    contacts.ensure().then(function () {
      if (open !== q || q.id !== id) return;
      var did = intro.did;
      q.intro = intro;
      u.rImg.src = icons.dataUrl(did, 80);
      u.rName.textContent = intro.name ? 'calls themselves “' + intro.name + '”' : 'No name given';
      u.rDid.textContent = shortDid(did); u.rDid.title = did;
      u.rReach.textContent = intro.helpers.length ? 'They say they can be reached at:\n' + helperText(intro.helpers) : 'They give no address to reach them at.';
      u.rResult.hidden = false;
      var known = contacts.isAdded(did);
      u.rTheir.disabled = known;
      if (known) { u.rHint.className = 'hint good'; u.rHint.textContent = 'This is already one of your friends.'; return; }
      u.rHint.className = 'hint'; u.rHint.textContent = '';
      u.rTheir.focus();
    }).catch(function (e) { if (open === q && q.id === id) { u.rHint.className = 'hint bad'; u.rHint.textContent = 'Could not read the friend list: ' + (e && e.message || e); } });
  }
  // What was typed, against the words of the DID in the introduction. The hint says what is wrong; the button wakes only on a match.
  function checkWords() {
    var q = open, u = ui;
    if (!q || q.mode !== 'read' || !q.intro) return;
    var intro = q.intro, id = ++q.id, text = u.rTheir.value, said = fp.parse(text);
    u.yes.disabled = true; u.rCheck.className = 'hint';
    if (!text.trim()) { u.rCheck.textContent = ''; return; }
    if (said === null) { u.rCheck.textContent = 'That is not one of the words from the list.'; return; }
    if (said.length < fp.COUNT) { u.rCheck.textContent = said.length + ' of ' + fp.COUNT + ' words.'; return; }
    if (said.length > fp.COUNT) { u.rCheck.textContent = 'That is more than ' + fp.COUNT + ' words.'; return; }
    fp.matches(intro.did, text).then(function (ok) {
      if (open !== q || q.id !== id || q.intro !== intro) return;
      u.yes.disabled = !ok;
      u.rCheck.className = ok ? 'hint good' : 'hint bad';
      u.rCheck.textContent = ok ? 'They match.' : 'Those are not their words. This introduction may not be from the person you think: do not add them until you have sorted it out.';
    });
  }
  async function add() {
    var q = open, u = ui;
    if (!q || q.mode !== 'read' || !q.intro || u.yes.disabled) return;
    var intro = q.intro, did = intro.did, name = intro.name || '';
    try {
      // Checked again at the click, from the DID in the introduction, not from what the button's state says.
      if (!(await fp.matches(did, u.rTheir.value))) return checkWords();
      if (open !== q || q.intro !== intro) return;
      await contacts.add(did, name);
    } catch (e) {
      if (open === q) { u.rCheck.className = 'hint bad'; u.rCheck.textContent = 'Could not add: ' + (e && e.message || e); }
      return;
    }
    hide();
    p2p.friendChanged(did);
    emit({ type: 'friend', kind: 'added', peer: { did: did, name: name || null } });
  }

  // ---- what the world may ask -----------------------------------------------------------------------------------------
  function mayOpen() {
    if (open) throw new Error('An introduction screen is already open.');
    if (friendDialogUp()) throw new Error('A friend request is already waiting for an answer.');
    if (Date.now() - lastDismissed < DISMISS_MS) throw new Error('The introduction screen was closed a moment ago.');
  }
  function openIn(mode) {
    return ident.current().then(function (s) {
      if (!s) throw new Error('Sign in first.');
      mayOpen();
      var u = build();
      open = { mode: null, id: 0, intro: null };
      u.root.hidden = false;
      switchTo(mode);
      if (mode === 'show') u.root.querySelector('.box').focus();   // so the keyboard is in the screen (Escape, Tab) from the start
      return true;
    });
  }
  function show() { return openIn('show'); }
  function read() { return openIn('read'); }
  // For code in THIS page (shell.js, when the session ends): nothing of one identity's screen is left for the next.
  function reset() { hide(); lastDismissed = 0; }

  window.keoIntro = { show: show, read: read, reset: reset, onEvent: function (fn) { listener = fn; } };
})();
