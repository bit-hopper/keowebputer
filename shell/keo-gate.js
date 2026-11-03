// keo sign-in screen, SHELL side. The world does not start until a person has chosen how to enter, so the choice of
// identity and every passkey prompt happen in this page and never inside the (untrusted) world. What it decides is the
// world's STARTUP, which shell.js hands over in the bridge handshake:
//   { kind: 'gate' }                            nobody signed in, and the package has a landing page (keo-build.json gateWorld): the
//                                               world starts from it and its sign-in / create buttons ask this page for the identity
//                                               ceremonies; then it asks for world.go {kind:'enter'}, which picks one of the two below
//   { kind: 'guest' }                           no identity: nothing is saved under a name, as before sign-in existed
//   { kind: 'homestar', session }               signed in and nothing saved yet (a new identity): open the identity's home page
//   { kind: 'world', session, name, doc }       signed in and a world was saved before: open the one saved last
// `session` is the public part of the session (keoIdentity.current); `doc` is the decrypted saved page. If the last saved
// world cannot be read the person still gets in, on the home page, with `warning` set, rather than locked out by one bad record.
// This page's own HTML screen (#gate) is the fallback for a package without a landing page, and what `start.html#html` shows
// whatever the package has. `start.html#guest` skips the screen. Both are reachable from a link, so they can only ever lead to
// the guest world or to this screen, never to a session.
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var busy = false;

  function msg(text, isErr) { var m = $('msg'); m.textContent = text || ''; m.className = isErr ? 'err' : ''; }
  function shortDid(did) { var m = /^did:keo:[^:]+:([A-Za-z0-9_-]{43})$/.exec(String(did)); return m ? 'keo:' + m[1].slice(0, 4) + '…' + m[1].slice(-4) : String(did); }

  function begin(startup) {
    $('gate').classList.add('hidden');
    window.keoShell.start(startup);
  }

  // Where a signed-in identity lands is the shell's to decide (shell.js), so the world's sign-in screen gets the same answer.
  var landing = function (session) { return window.keoShell.landing(session); };

  // The HTML screen starts hidden, so a package with a landing page never flashes it before the world starts.
  function showGate(list) {
    $('gate').classList.remove('hidden');
    if (list) showIdentities(list);
  }

  // True when the package carries a landing page for the world to start from (the build says so).
  function hasGateWorld() {
    return fetch('keo-build.json', { cache: 'no-store' }).then(function (r) { return r.ok ? r.json() : {}; }).then(function (b) { return !!b.gateWorld; }, function () { return false; });
  }

  // One passkey prompt, then wherever the identity lands.
  async function enter(did) {
    if (busy) return;
    busy = true;
    try {
      msg('Waiting for your passkey…');
      var r = await window.keoIdentity.signIn({ did: did });
      begin(await landing(r.session));
    } catch (e) {
      busy = false;
      msg((e && e.message) || String(e), true);
    }
  }

  async function createAndEnter() {
    if (busy) return;
    var label = $('label').value;
    busy = true;
    try {
      msg('Waiting for your passkey (two prompts)…');
      var id = await window.keoIdentity.create({ label: label });      // starts the session: no third prompt
      begin(await landing(id.session));
    } catch (e) {
      busy = false;
      msg((e && e.message) || String(e), true);
    }
  }

  function showIdentities(list) {
    var box = $('idlist');
    box.textContent = '';
    list.forEach(function (id) {
      var b = document.createElement('button');
      b.textContent = id.label;
      var small = document.createElement('small');
      small.textContent = shortDid(id.did);
      b.appendChild(small);
      b.onclick = function () { enter(id.did); };
      box.appendChild(b);
    });
    $('signinbox').hidden = list.length === 0;
  }

  $('create').onclick = createAndEnter;
  $('label').onkeydown = function (ev) { if (ev.key === 'Enter') createAndEnter(); };
  $('guest').onclick = function () { begin({ kind: 'guest' }); };

  if (location.hash === '#guest') return begin({ kind: 'guest' });
  if (location.hash === '#gate') return begin({ kind: 'gate' });      // the landing page in the world, whatever the package says
  // A refresh of this tab keeps the session (see keo-identity.js): go straight back in, with no prompt.
  window.keoIdentity.resume().then(function (session) {
    if (session) return landing(session).then(begin);
    return hasGateWorld().then(function (morphic) {
      if (morphic && location.hash !== '#html') return begin({ kind: 'gate' });
      return window.keoIdentity.list().then(showGate, function (e) { showGate(); msg('Could not read the identities on this device: ' + e.message, true); });
    });
  }, function (e) { showGate(); msg('Could not restore the session: ' + e.message, true); });
})();
