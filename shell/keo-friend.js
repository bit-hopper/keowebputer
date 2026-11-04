// keo friends, SHELL side: how two devices become friends, and the dialog in which a person decides. Runs in the extension's own page;
// the sandboxed world is assumed hostile. Messages, calls and file offers are accepted only between friends (keo-p2p.js); a device that
// is not one can only say whether it has added us, and this is where that is heard.
//
// A friendship has two halves. MINE: the person here compared this device's eight words (keo-fingerprint.js) with the person at the
// other end and added it (kept in the encrypted book, keo-contacts.js). THEIRS: the device told us, over the channel that proved its DID,
// that it has added us. It is learned live on every connection and never remembered, so a friend who has removed us cannot be taken for
// one from an old record. Both halves make a friend; either one alone is only a request.
//   friend.set { added: boolean }   sent by each side as soon as the other has proven itself (added: whether it has added the other),
//                                   and again whenever that changes. The peer's DID is the one the proof named, never anything in the message.
//
// The rules (the world is assumed hostile):
//  - Adding a friend happens only in this page's own dialog, after a REAL click on the button, and only after the person has typed the
//    other side's eight words and they match the proven DID. The dialog shows OUR words for the person to read out and never the other
//    side's, so the check cannot be passed by copying from the screen. The world can only ASK for the dialog (friend.start): there is no
//    op that adds a friend, answers the dialog, or hides it. Asked again while one is up, or within a few seconds of a dismissal, it is
//    refused, so it cannot keep putting the question in front of the person.
//  - A device that says it has added us may bring the dialog up on its own (once; the same limits apply). Nothing is added by that.
//  - Removing a friend goes through the same kind of question as removing an identity (keo-confirm.js), and the device is told.
//  - The name a device shows is text it chose. The picture and short DID are the proven DID's.
// What a match says: the DID in front of the person is the one the other person is reading from. It does not say who that person is;
// the call to make that out (a voice they know, a person in the room) is theirs. A hostile world can DRAW something like this dialog in
// its own frame: its clicks never reach this page, so it cannot add anyone, but it can mislead, which is why the dialog names the
// device by the proven DID.
(function () {
  'use strict';
  var p2p = window.keoP2p, contacts = window.keoContacts, fp = window.keoFingerprint, icons = window.keoIdenticon, ident = window.keoIdentity;
  var DISMISS_MS = 10000, MAX_SETS = 40;
  var open = null;                  // { h, kind, checkId } while the dialog is up
  var lastDismissed = 0, listener = null, ui = null, sets = {};

  function emit(ev) { if (listener) { try { listener(ev); } catch (e) {} } }
  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  function shortDid(did) {
    var m = /^did:keo:[^:]+:([A-Za-z0-9_-]{43})$/.exec(String(did));
    return m ? 'keo:' + m[1].slice(0, 4) + '…' + m[1].slice(-4) : String(did).slice(0, 24);
  }
  function sendSet(h, added) { try { h.send({ t: 'friend.set', added: added }); } catch (e) {} }

  // ---- the protocol ---------------------------------------------------------------------------------------------------
  function ready(h) { sendSet(h, contacts.isAdded(h.peer.did)); }
  function message(h, m) {
    if (m.t !== 'friend.set' || typeof m.added !== 'boolean') throw new Error('a bad message (' + m.t + ')');
    sets[h.id] = (sets[h.id] || 0) + 1;
    if (sets[h.id] > MAX_SETS) throw new Error('too many friend messages');
    var was = h.theirs;
    p2p.setTheirs(h.id, m.added);
    emit({ type: 'friend', kind: m.added ? 'theirs' : 'untheirs', id: h.id, peer: { did: h.peer.did, name: h.peer.name || null } });
    // Someone we have not added says it has added us: put the question to the person, once (the limits of offer() apply).
    if (m.added && !was && !contacts.isAdded(h.peer.did)) offer(h, 'incoming');
  }
  function closed(h) {
    delete sets[h.id];
    if (open && open.h.id === h.id) hide();
  }

  // ---- the dialog -----------------------------------------------------------------------------------------------------
  function build() {
    if (ui) return ui;
    var root = el('div'); root.id = 'keo-friend'; root.hidden = true;
    var box = el('div', 'box'); box.setAttribute('role', 'dialog'); box.setAttribute('aria-modal', 'true'); box.setAttribute('aria-label', 'Add a friend');
    var title = el('div', 'title'), head = el('div', 'head'), img = el('img', 'who-img'), who = el('div', 'who'), name = el('div', 'who-name'), did = el('div', 'who-did');
    img.width = img.height = 40; img.alt = '';
    who.appendChild(name); who.appendChild(did); head.appendChild(img); head.appendChild(who);
    var text = el('div', 'text');
    var mineL = el('div', 'label', 'Your words — read these to them'), mine = el('div', 'words');
    var theirL = el('label', 'label', 'Their words — type what they read to you'), input = el('input', 'theirs');
    input.type = 'text'; input.autocomplete = 'off'; input.spellcheck = false; input.setAttribute('autocapitalize', 'off'); input.setAttribute('aria-label', 'Their eight words');
    theirL.appendChild(input);
    var hint = el('div', 'hint'), btns = el('div', 'btns');
    var no = el('button', 'no', 'Not now'), yes = el('button', 'yes', 'Add as friend');
    no.type = yes.type = 'button'; no.setAttribute('data-ans', 'no'); yes.setAttribute('data-ans', 'yes'); yes.disabled = true;
    btns.appendChild(no); btns.appendChild(yes);
    [title, head, text, mineL, mine, theirL, hint, btns].forEach(function (x) { box.appendChild(x); });
    root.appendChild(box);
    document.body.appendChild(root);
    // Only a real click counts. Nothing in the world can reach this page's elements, but the check costs nothing.
    root.addEventListener('click', function (ev) {
      var b = ev.target && ev.target.closest && ev.target.closest('button[data-ans]');
      if (!b || !ev.isTrusted) return;
      if (b.getAttribute('data-ans') === 'no') return dismiss();
      add();
    });
    input.addEventListener('input', check);
    ui = { root: root, title: title, img: img, name: name, did: did, text: text, mine: mine, input: input, hint: hint, no: no, yes: yes };
    return ui;
  }
  function hide() { open = null; if (ui) { ui.root.hidden = true; ui.input.value = ''; ui.yes.disabled = true; } }
  function dismiss() { lastDismissed = Date.now(); hide(); }

  // Is the dialog allowed to come up now? (not while another is, nor right after a "not now")
  function mayOffer() { return !open && Date.now() - lastDismissed >= DISMISS_MS; }
  function offer(h, kind) {
    if (!mayOffer() || !h.ready() || !h.peer) return false;
    var u = build(), p = h.peer, n = p.name || 'Unnamed device';
    u.title.textContent = kind === 'incoming' ? n + ' has added you as a friend' : 'Add ' + n + ' as a friend?';
    u.name.textContent = n;
    u.did.textContent = shortDid(p.did);
    u.did.title = p.did;
    u.img.src = icons.dataUrl(p.did, 80);
    u.text.textContent = 'Friends can message, call and share files with each other. Make sure this is the person you mean: read your eight words to them (on a call, or in the same room) and type the eight words they read to you. Add them only if the words match.';
    u.mine.textContent = '…';
    u.input.value = ''; u.yes.disabled = true; u.hint.textContent = ''; u.hint.className = 'hint';
    open = { h: h, kind: kind, checkId: 0 };
    var mine = open;
    ident.current().then(function (s) { return s && fp.words(s.did); }).then(function (w) { if (open === mine && w) u.mine.textContent = w.join(' '); });
    u.root.hidden = false;
    u.input.focus();
    return true;
  }

  // What was typed, against the words of the DID that proved itself. The hint says what is wrong; the button wakes only on a match.
  function check() {
    var q = open;
    if (!q) return;
    var u = ui, id = ++q.checkId, text = u.input.value, said = fp.parse(text);
    u.yes.disabled = true;
    u.hint.className = 'hint';
    if (!text.trim()) { u.hint.textContent = ''; return; }
    if (said === null) { u.hint.textContent = 'That is not one of the words from the list.'; return; }
    if (said.length < fp.COUNT) { u.hint.textContent = said.length + ' of ' + fp.COUNT + ' words.'; return; }
    if (said.length > fp.COUNT) { u.hint.textContent = 'That is more than ' + fp.COUNT + ' words.'; return; }
    fp.matches(q.h.peer.did, text).then(function (ok) {
      if (open !== q || q.checkId !== id) return;
      u.yes.disabled = !ok;
      u.hint.className = ok ? 'hint good' : 'hint bad';
      u.hint.textContent = ok ? 'They match.' : 'Those are not their words. This may not be the person you think it is: do not add them until you have sorted it out.';
    });
  }

  async function add() {
    var q = open;
    if (!q || ui.yes.disabled) return;
    var h = q.h, did = h.peer.did, name = h.peer.name || '';
    try {
      // Checked again at the click, from the DID the proof named, not from what the button's state says.
      if (!(await fp.matches(did, ui.input.value))) return check();
      if (open !== q) return;
      await contacts.add(did, name);
    } catch (e) {
      if (open === q) { ui.hint.className = 'hint bad'; ui.hint.textContent = 'Could not add: ' + (e && e.message || e); }
      return;
    }
    hide();
    p2p.connectionsTo(did).forEach(function (c) { sendSet(c, true); });
    p2p.friendChanged(did);
    emit({ type: 'friend', kind: 'added', peer: { did: did, name: name || null } });
  }

  // ---- what the world may ask -----------------------------------------------------------------------------------------
  // Puts the dialog in front of the person for a connection that is ready. Adds nothing.
  function start(args) {
    var h = p2p.handle(args.id);
    if (contacts.isAdded(h.peer.did)) throw new Error('You have already added this device.');
    if (open) throw new Error('A friend request is already waiting for an answer.');
    if (Date.now() - lastDismissed < DISMISS_MS) throw new Error('A friend request was dismissed a moment ago.');
    offer(h, 'asked');
    return true;
  }
  function list() { return contacts.ensure().then(function () { return contacts.list(); }); }
  // The words of the signed-in identity itself, for a screen of the world that wants to show them. Public information about
  // ourselves; the words of the OTHER device are never handed out.
  function myWords() {
    return ident.current().then(function (s) { if (!s) throw new Error('Sign in first.'); return fp.words(s.did); });
  }
  // Removing a friend is a decision the person confirms in this page. The device is told before the connection ends.
  function remove(args) {
    var did = String(args.did);
    return contacts.ensure().then(function () {
      var rec = contacts.get(did);
      if (!rec) throw new Error('That device is not in your friends.');
      return window.keoConfirm.ask({
        title: 'Remove this friend?', did: did, label: rec.name, yes: 'Remove', no: 'Keep',
        text: 'The world you are in asked for this. You will not be able to message, call or share files with them until you check their words and add them again. They are told, and any connection to them ends.'
      });
    }).then(function (yes) {
      if (!yes) throw new Error('Not removed: it was not confirmed.');
      p2p.connectionsTo(did).forEach(function (c) { sendSet(c, false); });
      return contacts.remove(did);
    }).then(function () {
      p2p.friendChanged(did);
      emit({ type: 'friend', kind: 'removed', peer: { did: did, name: null } });
      return true;
    });
  }
  // For code in THIS page (shell.js, when the session ends): nothing of one identity's dialog is left for the next to find.
  function reset() { hide(); sets = {}; lastDismissed = 0; }

  p2p.attach('friend', { message: message, ready: ready, closed: closed }, { open: true });
  window.keoFriend = { start: start, list: list, myWords: myWords, remove: remove, reset: reset, onEvent: function (fn) { listener = fn; } };
})();
