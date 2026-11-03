// keo start, SHELL side. The world does not start until the shell knows how it should, so a resumed session and the world's
// own sign-in never have to race. What it decides is the world's STARTUP, which shell.js hands over in the bridge handshake:
//   { kind: 'gate' }                            nobody signed in: the world starts from the package's landing page (gate-world.html), and
//                                               its sign-in / create buttons ask this page for the identity ceremonies (LoginDialog and
//                                               RegisterDialog in their local mode); then the world asks for world.go {kind:'enter'},
//                                               which picks one of the two below. A package without a landing page starts the blank
//                                               world with the sign-in dialog opened on it (world/keo-boot.js)
//   { kind: 'guest' }                           no identity: nothing is saved under a name, as before sign-in existed
//   { kind: 'homestar', session }               signed in and nothing saved yet (a new identity): open the identity's home page
//   { kind: 'world', session, name, doc }       signed in and a world was saved before: open the one saved last
// `session` is the public part of the session (keoIdentity.current); `doc` is the decrypted saved page. If the last saved
// world cannot be read the person still gets in, on the home page, with `warning` set, rather than locked out by one bad record.
// This page draws nothing of its own: the identity ceremonies run here (never in the untrusted world), the screens are the world's.
// `start.html#guest` starts the guest world. It is reachable from a link, so it can only ever lead to the guest world or to
// the sign-in, never to a session.
(function () {
  'use strict';

  function begin(startup) { window.keoShell.start(startup); }

  if (location.hash === '#guest') return begin({ kind: 'guest' });
  // A refresh of this tab keeps the session (see keo-identity.js): go straight back in, with no prompt.
  window.keoIdentity.resume().then(function (session) {
    if (session) return window.keoShell.landing(session).then(begin);
    return begin({ kind: 'gate' });
  }, function (e) {
    console.warn('keo: could not restore the session (' + e.message + ')');
    begin({ kind: 'gate' });
  });
})();
