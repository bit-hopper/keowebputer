// keo sign-in screen, SHELL side. The world does not start until a person has chosen how to enter, so the choice of
// identity and every passkey prompt happen in this page and never inside the (untrusted) world. What it decides is the
// world's STARTUP, which shell.js hands over in the bridge handshake:
//   { kind: 'guest' }                           no identity: nothing is saved under a name, as before sign-in existed
//   { kind: 'homestar', session }               signed in and nothing saved yet (a new identity): open the identity's home page
//   { kind: 'world', session, name, doc }       signed in and a world was saved before: open the one saved last
// `session` is the public part of the session (keoIdentity.current); `doc` is the decrypted saved page. If the last saved
// world cannot be read the person still gets in, on the home page, with `warning` set, rather than locked out by one bad record.
// `start.html#guest` skips the screen. Reachable from a link, so it can only ever lead to the guest world, never to a session.
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var busy = false;

  function msg(text, isErr) { var m = $('msg'); m.textContent = text || ''; m.className = isErr ? 'err' : ''; }
  function shortDid(did) { var m = /^did:keo:[^:]+:([A-Za-z0-9_-]{43})$/.exec(String(did)); return m ? 'keo:' + m[1].slice(0, 4) + '…' + m[1].slice(-4) : String(did); }

  function begin(startup) {
    $('gate').classList.add('hidden');
    if (startup.session) {
      $('status').textContent = 'Signed in as ' + startup.session.label;
      $('signout').hidden = false;
    } else {
      $('status').textContent = 'No identity';
    }
    window.keoShell.start(startup);
  }

  // One passkey prompt, then whatever the identity saved last.
  async function enter(did) {
    if (busy) return;
    busy = true;
    try {
      msg('Waiting for your passkey…');
      var r = await window.keoIdentity.signIn({ did: did });
      var startup = { kind: 'homestar', session: r.session };
      try {
        var last = await window.keoWorlds.last();
        if (last) startup = { kind: 'world', session: r.session, name: last.name, doc: last.doc };
      } catch (e) {
        startup.warning = 'Your last saved world could not be opened: ' + (e && e.message || e);
      }
      begin(startup);
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
      var id = await window.keoIdentity.create({ label: label });
      busy = false;
      await enter(id.did);      // a third prompt: the certificate that signs this device in is made under its own assertion
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
  $('signout').onclick = function () {
    window.keoIdentity.signOut().then(function () { location.reload(); });
  };

  if (location.hash === '#guest') return begin({ kind: 'guest' });
  window.keoIdentity.list().then(showIdentities, function (e) { msg('Could not read the identities on this device: ' + e.message, true); });
})();
