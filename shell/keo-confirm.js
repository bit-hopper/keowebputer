// A question put to the person by THIS page, for things the world may ask for but must not be able to do on its own (today:
// removing an identity from the device, which destroys its keys for good). Runs in the extension's own page; the sandboxed world is
// assumed hostile.
//
// The rules:
//  - The dialog is drawn, placed and worded here. The world can only trigger it (through an op that calls ask()), never supply its
//    text, move it, answer it or hide it: the caller of ask() builds the wording from this page's own records.
//  - Only a real click counts (isTrusted). Nothing in the world can reach this page's elements, but the check costs nothing. The
//    focus starts on the safe answer, so a stray Enter keeps things as they are.
//  - One question at a time. A request while one is up, or within a few seconds of the person saying no, is refused, so a world
//    cannot keep putting the question in front of them until they give in.
//  - A question nobody answers goes away on its own and counts as a no.
// A hostile world can still DRAW something that looks like this dialog inside its own frame. Its clicks never reach this page, so
// it cannot confirm anything, and what it draws changes nothing here. start.html keeps the dialog below the identity vault's
// unlock frame, which must never be covered.
// Not for: asking about something a click in the world could legitimately mean (that is the world's own business), or about
// anything that is cheap to undo.
(function () {
  'use strict';
  var icons = window.keoIdenticon;
  var WAIT_MS = 25000, REFUSE_MS = 10000;      // WAIT_MS stays below the world's own timeout for the op (30 s)
  var open = null, lastNo = 0, ui = null;

  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  function shortDid(did) {
    var m = /^did:keo:[^:]+:([A-Za-z0-9_-]{43})$/.exec(String(did));
    return m ? 'keo:' + m[1].slice(0, 4) + '…' + m[1].slice(-4) : String(did).slice(0, 24);
  }
  function build() {
    if (ui) return ui;
    var root = el('div'); root.id = 'keo-confirm'; root.hidden = true;
    var box = el('div', 'box'); box.setAttribute('role', 'alertdialog'); box.setAttribute('aria-modal', 'true'); box.setAttribute('aria-label', 'Confirm');
    var title = el('div', 'title'), head = el('div', 'head'), img = el('img', 'who-img'), who = el('div', 'who'), name = el('div', 'who-name'), did = el('div', 'who-did');
    img.width = img.height = 40; img.alt = '';
    who.appendChild(name); who.appendChild(did); head.appendChild(img); head.appendChild(who);
    var text = el('div', 'text'), btns = el('div', 'btns');
    var no = el('button', 'no'), yes = el('button', 'yes');
    no.type = yes.type = 'button'; no.setAttribute('data-ans', 'no'); yes.setAttribute('data-ans', 'yes');
    btns.appendChild(no); btns.appendChild(yes);
    [title, head, text, btns].forEach(function (x) { box.appendChild(x); });
    root.appendChild(box);
    document.body.appendChild(root);
    root.addEventListener('click', function (ev) {
      var b = ev.target && ev.target.closest && ev.target.closest('button[data-ans]');
      if (!b || !ev.isTrusted) return;
      finish(b.getAttribute('data-ans') === 'yes');
    });
    ui = { root: root, title: title, head: head, img: img, name: name, did: did, text: text, no: no, yes: yes };
    return ui;
  }
  function finish(yes) {
    var q = open;
    if (!q) return;
    open = null;
    clearTimeout(q.timer);
    if (!yes) lastNo = Date.now();
    ui.root.hidden = true;
    q.resolve(!!yes);
  }

  // opts: { title, text, did?, label?, yes, no }. Every field is text chosen by the caller in THIS page. `did` and `label` (an
  // identity this page holds) are shown with the identity's picture. Resolves true only after a real click on the confirming button.
  function ask(opts) {
    if (open) return Promise.reject(new Error('Another question is waiting for an answer.'));
    if (Date.now() - lastNo < REFUSE_MS) return Promise.reject(new Error('That was declined a moment ago.'));
    var u = build();
    u.title.textContent = String(opts.title);
    u.text.textContent = String(opts.text);
    u.head.hidden = !opts.did;
    if (opts.did) {
      u.name.textContent = String(opts.label || 'Unnamed identity');
      u.did.textContent = shortDid(opts.did);
      u.did.title = String(opts.did);
      u.img.src = icons.dataUrl(String(opts.did), 80);
    }
    u.no.textContent = String(opts.no || 'Keep');
    u.yes.textContent = String(opts.yes || 'OK');
    return new Promise(function (resolve) {
      open = { resolve: resolve, timer: setTimeout(function () { lastNo = Date.now(); finish(false); }, WAIT_MS) };
      u.root.hidden = false;
      u.no.focus();
    });
  }

  window.keoConfirm = { ask: ask };
})();
