// keo release manifest: what a signed release says, and the checks a client makes before it trusts any of it.
// Pure functions over WebCrypto: no storage, no network, no DOM. Loaded as a plain script in the shell page (window.keoRelease,
// after keo-did.js) and require()d from Node (the signing tool and the tests use the same code that verifies).
//
// A release is an envelope  { v: 1, kid, payload, sig }  where payload is the base64url of the manifest's JSON text and sig is an
// Ed25519 signature over  "keo-release-v1\n" || payload bytes  (the prefix keeps this key's signatures from ever being valid
// for another kind of message). The signature is checked over the exact bytes sent, before anything is parsed, so no
// canonical form is needed. The manifest:
//   { v: 1, type: 'keo-release', version: <integer, rises with every release>, name: '0.1.0', issuedAt, kernel: { commit },
//     files: { '<package path>': { sha256: <hex>, size: <bytes> } } }
// and lists EVERY file of the package, so a client can tell what changed, and a file that is not listed is not part of the release.
//
// What this file does not do: fetch anything, store anything, or apply anything. A caller applies a plan only after
// verifyEnvelope resolved, and puts a downloaded file in place only after checkFile resolved true for it.
// The keys a release may be signed with are pinned in the package (update-key.json), never taken from the envelope or the network.
(function (root, factory) {
  var kd = typeof module === 'object' && module.exports ? require('./keo-did.js') : root.keoDid;
  var api = factory(kd);
  if (typeof module === 'object' && module.exports) module.exports = api; else root.keoRelease = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (kd) {
  'use strict';

  var subtle = globalThis.crypto.subtle;
  var enc = new TextEncoder();
  var DOMAIN = 'keo-release-v1\n';
  var MAX_PAYLOAD_BYTES = 8 * 1024 * 1024, MAX_FILES = 20000, MAX_PATH = 300;
  // One path segment: letters, digits and . _ @ + ~ - . Every file of the package fits; nothing that a URL, a query or a
  // percent-escape could give a second meaning to is allowed.
  var SEGMENT = /^[A-Za-z0-9._@+~-]+$/;

  function fail(msg) { return new Error('keoRelease: ' + msg); }
  function isObj(x) { return x !== null && typeof x === 'object' && !Array.isArray(x); }
  function hex(bytes) { var u = new Uint8Array(bytes), s = ''; for (var i = 0; i < u.length; i++) s += (u[i] < 16 ? '0' : '') + u[i].toString(16); return s; }
  function sha256hex(bytes) { return subtle.digest('SHA-256', bytes).then(hex); }

  // ---- keys -----------------------------------------------------------------------------------------------------
  // A key id is the first 8 bytes (16 hex digits) of SHA-256 of the raw 32-byte public key.
  function keyId(publicKeyB64u) { return sha256hex(kd.unb64u(publicKeyB64u)).then(function (h) { return h.slice(0, 16); }); }

  // The pinned list: { keys: [{ kid, alg: 'Ed25519', publicKey: <b64url raw> }] }. A kid that is not the hash of its own
  // key is a mistake in the file and is refused rather than trusted.
  function loadKeys(doc) {
    if (!isObj(doc) || !Array.isArray(doc.keys) || !doc.keys.length) return Promise.reject(fail('no pinned keys'));
    return Promise.all(doc.keys.map(function (k) {
      if (!isObj(k) || k.alg !== 'Ed25519' || typeof k.publicKey !== 'string' || typeof k.kid !== 'string') throw fail('malformed pinned key');
      if (kd.unb64u(k.publicKey).length !== 32) throw fail('a pinned key is not 32 bytes');
      return keyId(k.publicKey).then(function (id) {
        if (id !== k.kid) throw fail('pinned key ' + k.kid + ' does not match its id');
        return subtle.importKey('raw', kd.unb64u(k.publicKey), 'Ed25519', false, ['verify']).then(function (key) { return { kid: k.kid, key: key }; });
      });
    }));
  }

  // ---- paths ----------------------------------------------------------------------------------------------------
  function validPath(p) {
    if (typeof p !== 'string' || !p.length || p.length > MAX_PATH) return false;
    var segs = p.split('/');
    for (var i = 0; i < segs.length; i++) if (segs[i] === '.' || segs[i] === '..' || !SEGMENT.test(segs[i])) return false;
    return true;
  }

  // May the world run this path from the overlay? Only files the world itself loads. Everything an extension page runs
  // (the shell, the vault page and what it loads), the world's own document and its shim, and the configuration that
  // names the vault's origin and the passkey's rpId are fixed in the package: changing them takes a new package. This is
  // the policy the shell enforces; a release that changes such a file is reported as needing a new package, not applied.
  var FIXED_EXACT = {
    'manifest.json': 1, 'bg.js': 1, 'start.html': 1, 'shell.js': 1, 'shell-store.js': 1, 'keo-overlay.js': 1,
    'keo-release.js': 1, 'keo-did.js': 1, 'keo-hello.js': 1, 'keo-identity.js': 1, 'keo-p2p.js': 1, 'keo-callsdp.js': 1, 'keo-identicon.js': 1, 'keo-call.js': 1, 'keo-dm.js': 1, 'keo-worlds.js': 1, 'keo-gate.js': 1, 'vault.html': 1, 'update-key.json': 1, 'keo-files.json': 1,
    'world.html': 1, 'keo-shim.js': 1, 'keo-bridge.js': 1, 'keo-idb.js': 1, 'keo-boot.js': 1,
    'core/lively/localconfig.js': 1, 'core/lively/identity/IdentityVaultFrame.js': 1
  };
  var TEXT = /\.(js|json|css|xml|txt|html|svg|snippets)$/;
  function overlayable(p) {
    if (!validPath(p) || FIXED_EXACT[p] === 1) return false;
    if (p.indexOf('core/lib/libsodium/') === 0) return false;            // the vault page loads this
    if (!/^(core|generated|webdav-index|stub)\//.test(p)) return false;
    return TEXT.test(p);
  }

  // ---- the manifest -----------------------------------------------------------------------------------------------
  function validateManifest(m) {
    if (!isObj(m) || m.v !== 1 || m.type !== 'keo-release') throw fail('not a release manifest');
    if (!Number.isSafeInteger(m.version) || m.version < 1) throw fail('bad version');
    if (typeof m.name !== 'string' || !m.name.length || m.name.length > 64) throw fail('bad name');
    if (typeof m.issuedAt !== 'string' || isNaN(Date.parse(m.issuedAt))) throw fail('bad issuedAt');
    var commit = isObj(m.kernel) ? m.kernel.commit : null;
    if (commit !== null && !/^[0-9a-f]{7,64}$/.test(String(commit))) throw fail('bad kernel commit');
    if (!isObj(m.files)) throw fail('no file list');
    var names = Object.keys(m.files);
    if (!names.length || names.length > MAX_FILES) throw fail('bad file count');
    var files = Object.create(null);
    names.forEach(function (p) {
      var e = m.files[p];
      if (!validPath(p)) throw fail('bad path in the file list: ' + JSON.stringify(p).slice(0, 80));
      if (!isObj(e) || typeof e.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(e.sha256) || !Number.isSafeInteger(e.size) || e.size < 0) throw fail('bad entry for ' + p);
      files[p] = { sha256: e.sha256, size: e.size };
    });
    return { version: m.version, name: m.name, issuedAt: m.issuedAt, kernel: { commit: commit }, files: files };
  }

  // Resolves to the validated manifest, or rejects. `keys` is what loadKeys resolved to.
  function verifyEnvelope(env, keys) {
    return Promise.resolve().then(function () {
      if (!isObj(env) || env.v !== 1 || typeof env.kid !== 'string' || typeof env.payload !== 'string' || typeof env.sig !== 'string') throw fail('malformed envelope');
      if (env.payload.length > MAX_PAYLOAD_BYTES * 4 / 3 + 4) throw fail('payload too large');
      var k = keys.filter(function (x) { return x.kid === env.kid; })[0];
      if (!k) throw fail('signed with a key that is not pinned (' + env.kid.slice(0, 20) + ')');
      var payload = kd.unb64u(env.payload), sig = kd.unb64u(env.sig);
      if (sig.length !== 64) throw fail('bad signature length');
      var signed = new Uint8Array(DOMAIN.length + payload.length);
      signed.set(enc.encode(DOMAIN)); signed.set(payload, DOMAIN.length);
      return subtle.verify('Ed25519', k.key, sig, signed).then(function (ok) {
        if (!ok) throw fail('bad signature');
        var text;
        try { text = new TextDecoder('utf-8', { fatal: true }).decode(payload); return validateManifest(JSON.parse(text)); }
        catch (e) { throw e.message && e.message.indexOf('keoRelease') === 0 ? e : fail('the signed payload is not a manifest'); }
      });
    });
  }

  // ---- what to do with a verified manifest ------------------------------------------------------------------------
  // `installed`: { version: the highest release already applied (0 for the package alone), files: { path: sha256 hex } of what
  // the world runs now (the package's files with the overlay on top) }.
  // Returns { version, name, apply: [{ path, sha256, size }], needsNewPackage: [paths], removed: [paths], unchanged: n }.
  //   apply            changed or new files the overlay may carry (download these)
  //   needsNewPackage  changed or new files the overlay may not carry: the update cannot be applied whole while this is non-empty
  //   removed          files of the package the release no longer lists (the overlay does not delete; reported only)
  // A version that is not higher than the installed one is refused, so an older signed release can not be replayed.
  function planUpdate(manifest, installed) {
    var have = (installed && installed.files) || {}, from = (installed && installed.version) || 0;
    if (!(manifest.version > from)) throw fail('release ' + manifest.version + ' is not newer than ' + from);
    var plan = { version: manifest.version, name: manifest.name, apply: [], needsNewPackage: [], removed: [], unchanged: 0 };
    Object.keys(manifest.files).sort().forEach(function (p) {
      var e = manifest.files[p];
      if (Object.prototype.hasOwnProperty.call(have, p) && have[p] === e.sha256) { plan.unchanged++; return; }
      if (overlayable(p)) plan.apply.push({ path: p, sha256: e.sha256, size: e.size }); else plan.needsNewPackage.push(p);
    });
    Object.keys(have).sort().forEach(function (p) { if (!(p in manifest.files)) plan.removed.push(p); });
    return plan;
  }

  // Does `bytes` (Uint8Array/ArrayBuffer) have the size and hash the manifest gives for it? Resolves to a boolean.
  function checkFile(entry, bytes) {
    var u = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    if (u.length !== entry.size) return Promise.resolve(false);
    return sha256hex(u).then(function (h) { return h === entry.sha256; });
  }

  return {
    DOMAIN: DOMAIN, sha256hex: sha256hex, keyId: keyId, loadKeys: loadKeys, validPath: validPath, overlayable: overlayable,
    validateManifest: validateManifest, verifyEnvelope: verifyEnvelope, planUpdate: planUpdate, checkFile: checkFile
  };
});
