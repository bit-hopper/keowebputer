// keo shell page logic: the other end of the world bridge, plus the account-panel toggle.
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

  document.getElementById('toggle').onclick = function () { document.getElementById('acct').classList.toggle('open'); };

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
        return { localStorage: r[0], overlay: r[1], extensionId: location.hostname, origin: EXT_ORIGIN };
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
    'identity.remove': function (a) { return window.keoIdentity.remove({ did: a.did }); },
    'identity.signIn': function (a) { return window.keoIdentity.signIn({ did: a.did }); },
    // The vault asked to be shown (its "Unlock with passkey" button needs a click inside its own frame), or hidden again.
    'vault.frame': function (a) { vault.classList.toggle('shown', !!a.shown); return true; }
  };

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

  // Start the frames only now, with the listener in place, so the world's first request cannot arrive unheard.
  vault.src = 'vault.html';
  world.src = 'world.html';
})();
