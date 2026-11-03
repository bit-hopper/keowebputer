// keo shell page logic: the other end of the world bridge. The world is started by keo-gate.js, once it knows how.
//
// The world runs in a sandboxed iframe (world.html): opaque origin, no storage, no passkeys. This page is the extension's
// own origin and has them all, so it serves the world's requests:
//   - tagged requests {keo:1, id, op, args}: init / ls.* / idb.* (persistent storage, shell-store.js) and
//     webauthn.* (passkey ceremonies run here, results sent back as plain data);
//   - untagged {id, op, args}: the identity vault protocol. IdentityVaultBridge (in the world) posts these to its parent;
//     they are forwarded to vault.html (an extension page in a child iframe, running IdentityVaultFrame.js unchanged,
//     with the shell as its parent) and the replies go back to the world untouched.
// Who may talk: only the world frame (event.source) and the vault frame. Anything else is ignored.
// The world is less trusted than this page: the handlers below take plain data and never evaluate anything it sends.
(function () {
  'use strict';
  var world = document.getElementById('world');
  var vault = document.getElementById('vault');
  var EXT_ORIGIN = location.origin;

  // How the world was asked to start (keo-gate.js decides, see there). The world gets it in the handshake and can read the
  // public part of the session again with session.current; it cannot change either.
  var startup = null;

  function toWorld(msg) { try { world.contentWindow.postMessage(msg, '*'); } catch (e) {} }   // '*': the world's origin is opaque
  function replyOk(id, result) { toWorld({ keo: 1, id: id, ok: true, result: result }); }
  function replyErr(id, e) {
    toWorld({ keo: 1, id: id, ok: false, error: { name: (e && e.name) || 'Error', message: String((e && e.message) || e).slice(0, 400) } });
  }

  // ---- WebAuthn ----
  // Plain-data form of a PublicKeyCredential (the object itself cannot be sent). The world rebuilds the methods.
  function serializeCredential(cred) {
    var resp = cred.response, out = {
      id: cred.id, rawId: cred.rawId, type: cred.type, authenticatorAttachment: cred.authenticatorAttachment || null,
      clientExtensionResults: cred.getClientExtensionResults(), response: {}
    };
    ['clientDataJSON', 'attestationObject', 'authenticatorData', 'signature', 'userHandle'].forEach(function (k) {
      if (resp[k] !== undefined && resp[k] !== null) out.response[k] = resp[k];
    });
    if (typeof resp.getTransports === 'function') out.response.transports = resp.getTransports();
    if (typeof resp.getPublicKey === 'function') out.response.publicKey = resp.getPublicKey();
    if (typeof resp.getPublicKeyAlgorithm === 'function') out.response.publicKeyAlgorithm = resp.getPublicKeyAlgorithm();
    if (typeof resp.getAuthenticatorData === 'function') out.response.authenticatorDataGetter = resp.getAuthenticatorData();
    return out;
  }

  var OPS = {
    init: function () {
      // The overlay is read-only for the world: this is the only way it gets one, and no op writes it. If it cannot be read the
      // world starts from the package alone.
      return Promise.all([window.keoStore.lsAll(), window.keoOverlay.all().catch(function () { return {}; })]).then(function (r) {
        return { localStorage: r[0], overlay: r[1], extensionId: location.hostname, origin: EXT_ORIGIN, startup: startup };
      });
    },
    'ls.apply': function (a) { return window.keoStore.lsApply(a); },
    'idb.list': function () { return window.keoStore.idbList(); },
    'idb.load': function (a) { return window.keoStore.idbLoad(String(a.name)); },
    'idb.apply': function (a) { return window.keoStore.idbApply(String(a.name), a.ops || []).then(function () { return true; }); },
    'webauthn.create': function (a) { return navigator.credentials.create({ publicKey: a.publicKey }).then(serializeCredential); },
    'webauthn.get': function (a) { return navigator.credentials.get({ publicKey: a.publicKey }).then(serializeCredential); },
    'webauthn.uvpaa': function () { return PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable(); },
    'webauthn.capabilities': function () {
      return typeof PublicKeyCredential.getClientCapabilities === 'function' ? PublicKeyCredential.getClientCapabilities() : {};
    },
    // Local identities (keo-identity.js). The world passes plain data and gets plain data back; the
    // passkey ceremonies, the account secret and the keys never leave this page. Each op names its fields explicitly so a
    // hostile world cannot reach anything the identity module does not expose.
    'identity.create': function (a) { return window.keoIdentity.create({ label: a.label }); },
    'identity.list': function () { return window.keoIdentity.list(); },
    'identity.rename': function (a) { return window.keoIdentity.rename({ did: a.did, label: a.label }); },
    // Removing an identity also drops what it saved: without its record the key is gone for good.
    'identity.remove': function (a) {
      return window.keoIdentity.remove({ did: a.did }).then(function () { return window.keoWorlds.purge(String(a.did)); }).then(function () { return true; });
    },
    // The world may sign in only while nobody is: it cannot swap the identity a person chose on the sign-in screen.
    'identity.signIn': function (a) {
      return window.keoIdentity.current().then(function (s) {
        if (s) throw new Error('Already signed in as ' + s.label + '. Sign out first.');
        return window.keoIdentity.signIn({ did: a.did });
      });
    },
    // The public part of the session (DID, label, expiry, the delegation certificate), or null.
    'session.current': function () { return window.keoIdentity.current(); },
    // Ends the session and shows the sign-in screen again. The world may ask: it only lowers what the world can do.
    'session.signOut': function () { window.keoP2p.closeAll(); return window.keoIdentity.signOut().then(function () { setTimeout(function () { location.reload(); }, 0); return true; }); },
    // Saved worlds, encrypted under the signed-in identity (keo-worlds.js). `doc` is the whole saved page as text.
    'world.save': function (a) { return window.keoWorlds.save({ name: a.name, doc: a.doc }); },
    'world.list': function () { return window.keoWorlds.list(); },
    'world.load': function (a) { return window.keoWorlds.load({ name: a.name }); },
    'world.last': function () { return window.keoWorlds.last(); },
    'world.setLast': function (a) { return window.keoWorlds.setLast({ name: a.name }); },
    'world.remove': function (a) { return window.keoWorlds.remove({ name: a.name }); },
    // The identity's own small settings (encrypted with its worlds): only the names keo-worlds.js allows.
    'prefs.get': function () { return window.keoWorlds.prefsGet(); },
    'prefs.set': function (a) { return window.keoWorlds.prefsSet({ key: a.key, value: a.value }); },
    // Move to another page: the home page, a blank world, or a saved world by name. The world frame is restarted with a new
    // startup; the session stays. This is all a link would do, so the world may ask for it, but only for the signed-in identity.
    'world.go': function (a) { return go(a); },
    // Direct connections to another device and file sharing (keo-p2p.js). The connections live in this page; the world drives
    // them and gets plain-data events back (see the listener below). Received bytes never reach the world: p2p.save hands a
    // received file to the browser's download. All of it needs a signed-in identity (the invitation is signed with its device).
    'p2p.offer': function (a) { return window.keoP2p.offer({ name: a.name }); },
    'p2p.answer': function (a) { return window.keoP2p.answer({ code: a.code, name: a.name }); },
    'p2p.finish': function (a) { return window.keoP2p.finish({ id: a.id, code: a.code }); },
    'p2p.send': function (a) { return window.keoP2p.send({ id: a.id, file: a.file, name: a.name }); },
    'p2p.respond': function (a) { return window.keoP2p.respond({ id: a.id, fid: a.fid, accept: a.accept }); },
    'p2p.cancel': function (a) { return window.keoP2p.cancel({ id: a.id, fid: a.fid }); },
    'p2p.save': function (a) { return window.keoP2p.save({ id: a.id, fid: a.fid }); },
    'p2p.close': function (a) { return window.keoP2p.close({ id: a.id }); },
    'p2p.list': function () { return window.keoP2p.list(); },
    // The vault asked to be shown (its "Unlock with passkey" button needs a click inside its own frame), or hidden again.
    'vault.frame': function (a) { vault.classList.toggle('shown', !!a.shown); return true; }
  };

  // Events from the connections go to the world as {keo:1, event:'p2p', data}. They are not queued: a world that is not up yet (or
  // is restarting) misses them, and asks p2p.list for the current state when it starts.
  window.keoP2p.onEvent(function (data) { toWorld({ keo: 1, event: 'p2p', data: data }); });

  window.addEventListener('message', function (ev) {
    var m = ev.data;
    if (ev.source === world.contentWindow) {
      if (m && m.keo === 1 && typeof m.op === 'string') {
        if (!Object.prototype.hasOwnProperty.call(OPS, m.op)) return replyErr(m.id, new Error('keo shell: unknown op ' + m.op));
        var run;
        try { run = Promise.resolve(OPS[m.op](m.args || {})); } catch (e) { run = Promise.reject(e); }
        run.then(function (r) { replyOk(m.id, r); }, function (e) { replyErr(m.id, e); });
        return;
      }
      // untagged {id, op, args} is the vault protocol: forward to the vault page, which checks it again itself
      if (m && typeof m.op === 'string' && m.id !== undefined && !m.keo) {
        try { vault.contentWindow.postMessage({ id: m.id, op: m.op, args: m.args || {} }, EXT_ORIGIN); } catch (e) {}
      }
      return;
    }
    if (ev.source === vault.contentWindow && ev.origin === EXT_ORIGIN) {
      // a reply from the vault ({id, ok, result|error}): hand it to the world as is
      if (m && m.id !== undefined && typeof m.ok === 'boolean') toWorld(m);
    }
  });

  // The vault starts now, with the listener in place. The world starts only when keo-gate.js calls
  // start(), so its first request cannot arrive unheard and cannot arrive before it is known how to enter.
  vault.src = 'vault.html';
  // Where a signed-in identity lands on entering: the world it saved last, else (a new identity, or nothing saved) its home page.
  // A last world that cannot be read does not lock the person out: they land on the home page with a warning.
  function landing(session) {
    var startup = { kind: 'homestar', session: session };
    return window.keoWorlds.last().then(function (last) {
      if (last) startup = { kind: 'world', session: session, name: last.name, doc: last.doc };
      return startup;
    }, function (e) {
      startup.warning = 'Your last saved world could not be opened: ' + (e && e.message || e);
      return startup;
    });
  }

  function go(a) {
    return window.keoIdentity.current().then(function (session) {
      if (!session) throw new Error('Sign in to move between pages.');
      var kind = String(a.kind);
      // 'enter': what the sign-in dialog does after a sign-in or a create. The world asks for it once the dialog has a
      // session; the choice of page stays with this page.
      if (kind === 'enter') return landing(session);
      if (kind === 'homestar' || kind === 'blank') return { kind: kind, session: session };
      if (kind !== 'world') throw new Error('Unknown page kind.');
      return window.keoWorlds.load({ name: a.name }).then(function (w) {
        if (!w) throw new Error('No such saved world.');
        return window.keoWorlds.setLast({ name: w.name }).then(function () { return { kind: 'world', session: session, name: w.name, doc: w.doc }; });
      });
    }).then(function (next) {
      startup = next;
      world.src = 'about:blank';
      setTimeout(function () { world.src = 'world.html'; }, 0);
      return true;
    });
  }
  window.keoShell = {
    landing: landing,
    start: function (s) {
      if (startup) return;           // once per page: another identity means signing out, which reloads this page
      startup = s;
      world.src = 'world.html';
    }
  };
})();
