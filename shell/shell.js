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
    // Removing an identity destroys its key for good, so the world can only ASK: this page puts the question to the person (worded
    // from its own record of the identity, not from anything the world sends) and nothing happens until they click Remove. It also
    // drops what the identity saved. Removing the identity that is signed in ends that session, like signing out.
    'identity.remove': function (a) {
      var did = String(a.did);
      return window.keoIdentity.list().then(function (all) {
        var rec = all.filter(function (x) { return x.did === did; })[0];
        if (!rec) throw new Error('No such identity on this device.');
        return window.keoConfirm.ask({
          title: 'Remove this identity from this device?', did: rec.did, label: rec.label, yes: 'Remove', no: 'Keep',
          text: 'The world you are in asked for this. Its keys, saved worlds, library items and messages are deleted from this device and cannot be brought back. The passkey stays in your authenticator: a web page cannot delete it.'
        });
      }).then(function (yes) {
        if (!yes) throw new Error('Not removed: it was not confirmed.');
        return window.keoIdentity.remove({ did: did });
      }).then(function () { return window.keoWorlds.purge(did); }).then(function () { return window.keoChatLog.purge(did); }).then(function () { return window.keoLibrary.purge(did); }).then(function () { return window.keoContacts.purge(did); }).then(function () {
        return window.keoIdentity.current();
      }).then(function (s) {
        if (!s || s.did !== did) return true;
        return window.keoIdentity.signOut().then(function () { setTimeout(function () { location.reload(); }, 0); return true; });
      });
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
    'session.signOut': function () { return window.keoIdentity.signOut().then(function () { setTimeout(function () { location.reload(); }, 0); return true; }); },
    // Saved worlds, encrypted under the signed-in identity (keo-worlds.js). `doc` is the whole saved page as text.
    'world.save': function (a) { return window.keoWorlds.save({ name: a.name, doc: a.doc, template: a.template }); },
    'world.list': function () { return window.keoWorlds.list(); },
    'world.load': function (a) { return window.keoWorlds.load({ name: a.name }); },
    'world.last': function () { return window.keoWorlds.last(); },
    'world.setLast': function (a) { return window.keoWorlds.setLast({ name: a.name }); },
    'world.remove': function (a) { return window.keoWorlds.remove({ name: a.name }); },
    // The library: whether a name is taken, a new name for a world, its tags and note, a copy, and a search over names, tags, notes
    // and the text inside the worlds. All of it is the signed-in identity's own and returns plain data (names, tags, short snippets).
    'world.has': function (a) { return window.keoWorlds.has({ name: a.name }); },
    'world.rename': function (a) { return window.keoWorlds.rename({ from: a.from, to: a.to }); },
    'world.meta': function (a) { return window.keoWorlds.setMeta({ name: a.name, tags: a.tags, note: a.note }); },
    'world.duplicate': function (a) { return window.keoWorlds.duplicate({ from: a.from, to: a.to }); },
    'world.search': function (a) { return window.keoWorlds.search({ query: a.query }); },
    // The small objects the runtime's own apps keep (books, albums, folders), encrypted under the signed-in identity (keo-library.js).
    // `doc` is one object the world built; the shell checks whose it is and what kind, and stores it as it is.
    'library.get': function (a) { return window.keoLibrary.get({ objId: a.objId }); },
    'library.put': function (a) { return window.keoLibrary.put({ objId: a.objId, doc: a.doc }); },
    // Files the apps keep by their hash (a picture, say): the bytes go in and out as an ArrayBuffer, and the shell checks the hash.
    'library.blobPut': function (a) { return window.keoLibrary.putBlob({ cid: a.cid, bytes: a.bytes }); },
    'library.blobGet': function (a) { return window.keoLibrary.getBlob({ cid: a.cid }); },
    'library.blobRemove': function (a) { return window.keoLibrary.removeBlob({ cid: a.cid }); },
    // Files too big for one message: announced, sent in order in chunks, finished (the shell names the file by the hash of its bytes
    // itself), then read back chunk by chunk. Plain data in and out; the shell holds one chunk at a time.
    'library.fileBegin': function (a) { return window.keoLibrary.fileBegin({ name: a.name, type: a.type, size: a.size }); },
    'library.fileChunk': function (a) { return window.keoLibrary.fileChunk({ upload: a.upload, n: a.n, bytes: a.bytes }); },
    'library.fileEnd': function (a) { return window.keoLibrary.fileEnd({ upload: a.upload }); },
    'library.fileAbort': function (a) { return window.keoLibrary.fileAbort({ upload: a.upload }); },
    'library.fileInfo': function (a) { return window.keoLibrary.fileInfo({ id: a.id }); },
    'library.fileRead': function (a) { return window.keoLibrary.fileRead({ id: a.id, n: a.n }); },
    'library.fileRemove': function (a) { return window.keoLibrary.fileRemove({ id: a.id }); },
    // A read of the music catalogue's search or lookup (keo-catalog.js): the world cannot read it itself, the shell can. Signed in only.
    'catalog.get': function (a) {
      return window.keoIdentity.current().then(function (s) {
        if (!s) throw new Error('Sign in to look something up.');
        return window.keoCatalog.get({ url: a.url });
      });
    },
    // The identity's own small settings (encrypted with its worlds): only the names keo-worlds.js allows.
    'prefs.get': function () { return window.keoWorlds.prefsGet(); },
    'prefs.set': function (a) { return window.keoWorlds.prefsSet({ key: a.key, value: a.value }); },
    // Move to another page: the home page, a blank world, or a saved world by name. The world frame is restarted with a new
    // startup; the session stays. This is all a link would do, so the world may ask for it, but only for the signed-in identity.
    'world.go': function (a) { return go(a); },
    // Direct connections to another device and file sharing (keo-p2p.js). The connections live in this page; the world drives
    // them and gets plain-data events back (see the listener below). Received bytes never reach the world: p2p.save hands a
    // received file to the browser's download. All of it needs a signed-in identity (the invitation is signed with its device).
    'p2p.offer': function (a) { return window.keoP2p.offer({ name: a.name, expect: a.expect }); },
    'p2p.answer': function (a) { return window.keoP2p.answer({ code: a.code, name: a.name, expect: a.expect }); },
    'p2p.finish': function (a) { return window.keoP2p.finish({ id: a.id, code: a.code }); },
    'p2p.send': function (a) { return window.keoP2p.send({ id: a.id, file: a.file, name: a.name }); },
    'p2p.respond': function (a) { return window.keoP2p.respond({ id: a.id, fid: a.fid, accept: a.accept }); },
    'p2p.cancel': function (a) { return window.keoP2p.cancel({ id: a.id, fid: a.fid }); },
    'p2p.save': function (a) { return window.keoP2p.save({ id: a.id, fid: a.fid }); },
    'p2p.close': function (a) { return window.keoP2p.close({ id: a.id }); },
    'p2p.list': function () { return window.keoP2p.list(); },
    // Calls over a connection (keo-call.js). The world can only ASK: call.start puts a prompt in front of the person, in this page,
    // and nothing is captured until they click it; there is deliberately no op to accept, answer, move or hide anything. call.end
    // and call.state only lower or read what the world can do. The events below carry text only, never a stream.
    'call.start': function (a) { return window.keoCall.start({ id: a.id, audioOnly: a.audioOnly === true }); },
    'call.end': function (a) { return window.keoCall.end({ id: a.id }); },
    'call.lower': function (a) { return window.keoCall.lower({ id: a.id, what: a.what }); },
    'call.state': function () { return window.keoCall.state(); },
    // Text messages over a connection (keo-dm.js). The world sends, and PULLS what arrived: dm.take lists the waiting messages,
    // dm.done drops the ones it has saved. The events only say that something is waiting.
    'dm.send': function (a) { return window.keoDm.send({ id: a.id, text: a.text }); },
    'dm.take': function () { return window.keoDm.take(); },
    'dm.done': function (a) { return window.keoDm.done({ mids: a.mids }); },
    // The signed-in identity's message history, encrypted under it (keo-chatlog.js). Only its own conversations are reachable.
    'chat.append': function (a) { return window.keoChatLog.append({ peerDid: a.peerDid, label: a.label, k: a.k, dir: a.dir, text: a.text, at: a.at }); },
    'chat.thread': function (a) { return window.keoChatLog.thread({ peerDid: a.peerDid }); },
    'chat.threads': function () { return window.keoChatLog.threads(); },
    'chat.remove': function (a) { return window.keoChatLog.remove({ peerDid: a.peerDid }); },
    // Friends (keo-friend.js, keo-contacts.js). Messages, calls and file offers work only between friends: the person here checks the
    // other device's eight words and adds it, in a dialog this page draws. The world can only ASK for that dialog, list who has been
    // added, read OUR words (to show them) and ask to remove a friend (the person confirms in this page). It cannot add, answer or hide.
    'friend.start': function (a) { return window.keoFriend.start({ id: a.id }); },
    'friend.list': function () { return window.keoFriend.list(); },
    'friend.words': function () { return window.keoFriend.myWords(); },
    'friend.remove': function (a) { return window.keoFriend.remove({ did: a.did }); },
    // Introductions (keo-intro.js): the screen with our QR code, and the one that reads someone else's and adds them after the eight-word
    // check. The world can only ASK for a screen to open. It is handed no text, no address and no answer; it cannot fill, add or close.
    'intro.show': function () { return window.keoIntro.show(); },
    'intro.read': function () { return window.keoIntro.read(); },
    // Friends on the local network (keo-lan.js), in the desktop app: who of the friends is on this network, whether this device is
    // visible to them, and a dial to one of them (the ordinary connection, its two codes carried over the network). The world gets
    // names and DIDs and a connection id, never an address, a tag or a code. Elsewhere `available` is false and a dial is refused.
    'lan.status': function () { return window.keoLan.status(); },
    'lan.visible': function (a) { return window.keoLan.setVisible({ on: a.on }); },
    'lan.dial': function (a) { return window.keoLan.dial({ did: a.did }); },
    // Adding an identity to a second device (keo-enroll.js). The world can only ASK for the dialog, naming which side it is: 'new' (this
    // device wants an identity) or 'old' (the identity signed in here is to be added to another device). The words, the codes and the
    // passkey prompt are all in this page's dialog; there is no op that fills it in, approves, or reads what is in it.
    'enroll.open': function (a) { return window.keoEnroll.start({ mode: a.mode }); },
    // Moving the signed-in identity's saved worlds and library to another webputer, as a file (keo-transfer.js). The world can only ASK for
    // the dialog: what is saved, what is added and the file chosen are all in this page's dialog, by real clicks.
    'transfer.open': function () { return window.keoTransfer.start(); },
    // The world's answer to 'leaving' (see keoPrepareToLeave below): its exit warning is off. Harmless when nothing waits.
    'exit.ready': function () { var w = leaveWaiting; if (w) w(); return !!w; },
    // The vault asked to be shown (its "Unlock with passkey" button needs a click inside its own frame), or hidden again.
    'vault.frame': function (a) { vault.classList.toggle('shown', !!a.shown); return true; }
  };

  // For code in THIS page that reloads it on the person's own click (the link dialog): asks the world to lift its exit warning and
  // resolves when it says it has (op 'exit.ready'), so the reload does not raise the browser's "Leave site?" prompt. The timer is only
  // for a world that is not up, which has no warning to lift. Not for anything the world can start: a reload it wants goes through an op.
  var leaveWaiting = null;
  window.keoPrepareToLeave = function () {
    return new Promise(function (resolve) {
      var done = false;
      function fin() { if (done) return; done = true; if (leaveWaiting === fin) leaveWaiting = null; resolve(); }
      leaveWaiting = fin;
      toWorld({ keo: 1, event: 'leaving' });
      setTimeout(fin, 1500);
    });
  };

  // Events from the connections go to the world as {keo:1, event:'p2p', data}. They are not queued: a world that is not up yet (or
  // is restarting) misses them, and asks p2p.list for the current state when it starts.
  window.keoP2p.onEvent(function (data) { toWorld({ keo: 1, event: 'p2p', data: data }); });
  // Call events go the same way, as {keo:1, event:'call', data}; ask call.state for the call at hand when a listener starts.
  window.keoCall.onEvent(function (data) { toWorld({ keo: 1, event: 'call', data: data }); });
  window.keoDm.onEvent(function (data) { toWorld({ keo: 1, event: 'dm', data: data }); });
  window.keoFriend.onEvent(function (data) { toWorld({ keo: 1, event: 'friend', data: data }); });
  window.keoIntro.onEvent(function (data) { toWorld({ keo: 1, event: 'friend', data: data }); });   // adding a friend from an introduction is told the same way
  window.keoLan.onEvent(function (data) { toWorld({ keo: 1, event: 'lan', data: data }); });
  window.keoEnroll.onEvent(function (data) { toWorld({ keo: 1, event: 'enroll', data: data }); });
  window.keoTransfer.onEvent(function (data) { toWorld({ keo: 1, event: 'transfer', data: data }); });
  // The person asked, in the toolbar popup, to reconnect to a friend: {keo:1, event:'reconnect', data:{did, name}}. The world opens its
  // Connect a device window for it and makes the invitation (p2p.offer with `expect`); this page only says that it was asked.
  window.keoStatus.onReconnect(function (data) { toWorld({ keo: 1, event: 'reconnect', data: data }); });
  // Other things the person asked for in the popup: {keo:1, event:'open', data:{what:'chat'|'connect'|'signout', did?, name?}}. Signing
  // out goes through the world so that its bridge lifts the exit warning around it (world/keo-bridge.js); this page only says it was asked.
  window.keoStatus.onOpen(function (data) { toWorld({ keo: 1, event: 'open', data: data }); });
  // Connections, a call under way (closing its connection ends it and stops the camera and microphone) and messages nobody has taken
  // yet belong to the identity that was signed in. However its session ends (sign-out, expiry, removal), they go with it: the
  // connections were proven with that identity's device key, and the next one to sign in must not inherit them.
  window.keoIdentity.onEnd(function () { window.keoP2p.closeAll(); window.keoDm.clear(); window.keoFriend.reset(); window.keoCards.reset(); window.keoIntro.reset(); window.keoLan.reset(); window.keoEnroll.reset(); window.keoTransfer.reset(); window.keoLibrary.reset(); window.keoContacts.clear(); });

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
      if (kind === 'homestar') return { kind: kind, session: session };
      if (kind === 'blank') {
        // A blank world may be given its name up front ("New world"): the world then saves it under that name as soon as it is up,
        // so it is in the library at once. A name that is taken is refused here, so creating can never replace a saved world.
        if (a.name === undefined || a.name === null || a.name === '') return { kind: kind, session: session };
        // `template` names a preset the world starts from; the world fills it in once it is up (world/keo-boot.js). Only the known names pass.
        var template = window.keoWorlds.cleanTemplate(a.template);
        return window.keoWorlds.has({ name: a.name }).then(function (taken) {
          if (taken) throw new Error('A world named "' + String(a.name).trim() + '" already exists.');
          var next = { kind: kind, session: session, name: String(a.name).replace(/\s+/g, ' ').trim().slice(0, 128) };
          if (template) next.template = template;
          return next;
        });
      }
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
