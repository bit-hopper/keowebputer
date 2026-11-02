// keo local identities, SHELL side. Runs in the extension's own page (start.html), the only
// realm that has passkeys, IndexedDB and non-extractable keys; the sandboxed world reaches it through the bridge ops in
// shell.js and only ever receives plain data back.
//
// An identity is created ON THIS DEVICE with no server and no handle. Creation, in order (every secret stays in this page):
//   1. a passkey is created under the extension's own origin (rpId = the extension id), asking for the PRF extension;
//   2. a random 32-byte `accountSecret` (HMAC key) is generated, and from it the discovery key (Ed25519, keo-did.js);
//   3. a per-device ECDSA key is generated NON-extractable;
//   4. the inception event is built (authority = the new passkey, discovery = the Ed25519 public key, next = null) and
//      hashed; the DID is did:keo:<discovery key>:<that hash>;
//   5. the new passkey signs the hash (a WebAuthn assertion whose challenge is H(e)); the same ceremony returns the PRF
//      output if step 1 did not; the discovery key signs it too (proof of possession);
//   6. the signed inception is verified (keo-did.js verifyInception) before anything is stored;
//   7. `accountSecret` is wrapped under the PRF-derived key and everything is written to IndexedDB. The secret itself is
//      then dropped; it exists unwrapped only inside this function.
// Two passkey prompts happen (create, then sign H(e)); the second is unavoidable, since the passkey's public key only
// exists after the first and the inception has to contain it.
//
// `next` is null: a first-run account is allowed to have no pre-committed next key and is flagged notRecoverable until a
// second credential on another rpId is enrolled. Nothing here enrols one.
// The label is the user's own name for the identity on this device. It is never part of the log and never leaves the
// device; it is also written into the passkey's user name, so the authenticator's own picker shows it.
// Not here (later steps of 9.4l): a session, export/import, registering to a host.
(function () {
  'use strict';
  var kd = window.keoDid;
  var enc = new TextEncoder();
  var SALT = enc.encode('keo-unlock-v1');          // PRF input; a label, not a secret (kept from the 9.4g prototype)
  var DB_NAME = 'keo-identities', STORE = 'identities';

  // ---- storage: one record per identity, keyed by DID --------------------------------------------------------------
  function openDb() {
    return new Promise(function (res, rej) {
      var q = indexedDB.open(DB_NAME, 1);
      q.onupgradeneeded = function () { q.result.createObjectStore(STORE, { keyPath: 'did' }); };
      q.onsuccess = function () { res(q.result); };
      q.onerror = function () { rej(q.error); };
    });
  }
  function withStore(mode, fn) {
    return openDb().then(function (db) {
      return new Promise(function (res, rej) {
        var tx = db.transaction(STORE, mode), out;
        try { out = fn(tx.objectStore(STORE)); } catch (e) { db.close(); return rej(e); }
        tx.oncomplete = function () { db.close(); res(out && 'result' in out ? out.result : undefined); };
        tx.onabort = tx.onerror = function () { db.close(); rej(tx.error || new Error('identity store transaction failed')); };
      });
    });
  }
  function dbAll() { return withStore('readonly', function (s) { return s.getAll(); }); }
  function dbGet(did) { return withStore('readonly', function (s) { return s.get(did); }); }
  function dbPut(rec) { return withStore('readwrite', function (s) { return s.put(rec); }); }
  function dbDelete(did) { return withStore('readwrite', function (s) { return s.delete(did); }); }

  // ---- helpers ------------------------------------------------------------------------------------------------------
  function cleanLabel(s) { s = String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, 64); return s || 'My identity'; }
  function rnd(n) { return crypto.getRandomValues(new Uint8Array(n)); }
  function prfKek(bytes) { return crypto.subtle.importKey('raw', bytes, 'AES-KW', false, ['wrapKey', 'unwrapKey']); }
  function prfOf(credential) {
    var r = credential.getClientExtensionResults().prf;
    return r && r.results && r.results.first ? new Uint8Array(r.results.first) : null;
  }
  // JWK reduced to its required members, so the same key always serialises (and hashes) the same way.
  function plainEcJwk(j) { return { kty: j.kty, crv: j.crv, x: j.x, y: j.y }; }
  function assertionSig(keyId, credential) {
    var r = credential.response;
    return { keyId: keyId, authenticatorData: kd.b64u(r.authenticatorData), clientDataJSON: kd.b64u(r.clientDataJSON), signature: kd.b64u(r.signature) };
  }
  function summary(rec) {
    var next = rec.inception.state.next;
    return {
      did: rec.did, label: rec.label, createdAt: rec.createdAt, rpId: rec.rpId,
      authorityKeys: rec.inception.state.authority.keys.length,
      // true until a second credential on another rpId is enrolled (a pre-committed `next` key is what makes recovery possible)
      notRecoverable: next === null || next === undefined
    };
  }

  // ---- ceremonies ---------------------------------------------------------------------------------------------------
  // The browser refuses a WebAuthn call from a page that does not have focus ("The operation is not allowed at this time
  // because the page does not have focus."). Creating an identity runs two ceremonies back to back, and the second starts
  // the moment the OS passkey dialog from the first closes, which may be before the browser window has taken focus back
  // (seen with a real authenticator, 2026-11-01; a virtual one never shows it). So each ceremony first waits, up to
  // FOCUS_WAIT_MS, for the page to have focus. If it never does, the call is made anyway and the browser's own error
  // surfaces, now naming the step. `diag` records what each step saw, so a failure can be told apart from a slow focus.
  var FOCUS_WAIT_MS = 15000;
  function whenFocused(maxMs) {
    return new Promise(function (resolve) {
      var t0 = Date.now();
      if (document.hasFocus()) return resolve({ focused: true, waitedMs: 0 });
      var timer, done = false;
      function finish(f) { if (done) return; done = true; clearInterval(timer); window.removeEventListener('focus', onFocus); resolve({ focused: f, waitedMs: Date.now() - t0 }); }
      function onFocus() { finish(true); }
      window.addEventListener('focus', onFocus);
      timer = setInterval(function () { if (document.hasFocus()) finish(true); else if (Date.now() - t0 > maxMs) finish(false); }, 100);
    });
  }
  // Runs fn() once the page has focus. A failure keeps its error name (callers and tests read it) and gains the step's
  // name and the focus state in its message.
  async function ceremony(diag, step, fn) {
    var hadFocus = document.hasFocus(), f = await whenFocused(FOCUS_WAIT_MS);
    diag.push({ step: step, hadFocusAtStart: hadFocus, focusedAfterWait: f.focused, waitedMs: f.waitedMs });
    try { return await fn(); }
    catch (e) {
      var err = new Error(step + ': ' + (e && e.message) + ' (page has focus now: ' + document.hasFocus() + ')');
      err.name = (e && e.name) || 'Error';
      throw err;
    }
  }

  // The rpId a passkey made on this page is bound to. With rp.id omitted it is the page's host on a web origin, but on an
  // extension page the browser uses the whole origin ("chrome-extension://<id>"), not just the id (checked 2026-11-01: the
  // assertion's rpIdHash matches SHA-256 of the origin, not of location.hostname). Rather than hard-code either, hash the
  // candidates and keep the one the authenticator reports in the first 32 bytes of the authenticator data. An rpId the
  // log records but does not enforce (7.4) should still be the true one.
  async function effectiveRpId(authData) {
    var got = kd.b64u(authData.slice(0, 32)), candidates = [location.origin, location.hostname];
    for (var i = 0; i < candidates.length; i++) {
      if (kd.b64u(await kd.sha256(enc.encode(candidates[i]))) === got) return candidates[i];
    }
    throw new Error('The passkey is bound to an rpId this page cannot account for.');
  }

  // ---- create -------------------------------------------------------------------------------------------------------
  var creating = false;
  function create(opts) {
    if (creating) return Promise.reject(new Error('An identity is already being created.'));
    creating = true;
    return doCreate(opts || {}).then(function (r) { creating = false; return r; }, function (e) { creating = false; throw e; });
  }

  async function doCreate(opts) {
    var label = cleanLabel(opts.label);
    var rpId;                                        // what the passkey is bound to; read from the creation response below
    var diag = [];

    // 1. the passkey. rp.id is omitted on purpose: the default is this origin's host, i.e. the extension id.
    var cred = await ceremony(diag, 'creating the passkey', function () { return navigator.credentials.create({ publicKey: {
      rp: { name: 'keo' }, user: { id: rnd(16), name: label, displayName: label }, challenge: rnd(32),
      pubKeyCredParams: [{ type: 'public-key', alg: -7 }],      // ES256 only: the log's verifier handles nothing else
      authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
      extensions: { prf: { eval: { first: SALT } } } } }); });
    if (cred.response.getPublicKeyAlgorithm() !== -7) throw new Error('This authenticator did not make an ES256 passkey.');
    rpId = await effectiveRpId(new Uint8Array(cred.response.getAuthenticatorData()));
    var credentialId = kd.b64u(cred.rawId);
    var authJwk = plainEcJwk(await crypto.subtle.exportKey('jwk', await crypto.subtle.importKey('spki',
      cred.response.getPublicKey(), { name: 'ECDSA', namedCurve: 'P-256' }, true, ['verify'])));
    var prfAtCreate = prfOf(cred);
    var attachment = cred.authenticatorAttachment || null;

    // 2 + 3. secret, discovery key, device key
    var secret = await crypto.subtle.generateKey({ name: 'HMAC', hash: 'SHA-256', length: 256 }, true, ['sign']);
    var disc = await kd.ed25519FromSeed(await kd.discoverySeed(secret, 1));
    var deviceKey = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']);
    var deviceJwk = plainEcJwk(await crypto.subtle.exportKey('jwk', deviceKey.publicKey));

    // 4. the inception event and the DID
    var now = new Date().toISOString();
    var inception = { v: 1, type: 'inception', seq: 0, prev: null, time: now, state: {
      authority: { threshold: 1, keys: [{ id: credentialId, jwk: authJwk, rpId: rpId, kind: attachment === 'cross-platform' ? 'security-key' : 'platform', addedAt: now }] },
      next: null,
      recovery: { guardians: [], threshold: 2, delayDays: 3 },
      discovery: { key: disc.publicZ32, version: 1 },
      services: [], claims: { handles: [] }, revoked: [] } };
    var H = await kd.eventHash(inception);
    var did = kd.didFor(disc.publicZ32, kd.b64u(H));

    // 5. signatures: the new passkey over H(e), the discovery key over H(e)
    var assertion = await ceremony(diag, 'signing the new identity', function () { return navigator.credentials.get({ publicKey: {
      challenge: H, allowCredentials: [{ type: 'public-key', id: cred.rawId }], userVerification: 'required',
      extensions: { prf: { eval: { first: SALT } } } } }); });
    var prf = prfAtCreate || prfOf(assertion);
    if (!prf) throw new Error('This authenticator did not return a PRF output, so it cannot protect the account secret.');
    var sigs = {
      discovery: kd.b64u(await crypto.subtle.sign({ name: 'Ed25519' }, disc.privateKey, H)),
      authority: [assertionSig(credentialId, assertion)] };

    // 6. never store something the verifier would reject
    var v = await kd.verifyInception({ inception: inception, sigs: sigs });
    if (!v.ok || v.did !== did) throw new Error('The new identity did not verify: ' + (v.error || 'DID mismatch'));

    // 7. wrap the secret under the passkey's PRF output, then keep the record
    var wrapped = await crypto.subtle.wrapKey('raw', secret, await prfKek(prf), 'AES-KW');
    var check = kd.b64u(await crypto.subtle.sign('HMAC', secret, enc.encode('keo/check')));
    var rec = {
      did: did, label: label, createdAt: now, rpId: rpId, credentialId: credentialId,
      inception: inception, sigs: sigs,
      wrappedAccountSecret: kd.b64u(wrapped), check: check,
      deviceKey: { privateKey: deviceKey.privateKey, publicKey: deviceKey.publicKey, publicJwk: deviceJwk },
      discoveryKey: disc.privateKey
    };
    await dbPut(rec);
    var out = summary(rec);
    out.prfAtCreate = !!prfAtCreate;
    out.authenticatorAttachment = attachment;
    // what kind of authenticator answered (not part of the log): e.g. ["internal"] for a built-in platform authenticator,
    // ["usb"], ["hybrid"] for a phone
    out.transports = typeof cred.response.getTransports === 'function' ? cred.response.getTransports() : [];
    out.diag = diag;
    return out;
  }

  // ---- the rest ------------------------------------------------------------------------------------------------------
  function list() {
    return dbAll().then(function (recs) { return recs.sort(function (a, b) { return a.createdAt < b.createdAt ? -1 : 1; }).map(summary); });
  }
  function rename(args) {
    return dbGet(String(args.did)).then(function (rec) {
      if (!rec) throw new Error('No such identity on this device.');
      rec.label = cleanLabel(args.label);
      return dbPut(rec).then(function () { return summary(rec); });
    });
  }
  // Removes the record from THIS device. The passkey stays in the authenticator (a web page cannot delete one), and
  // without the record its wrapped secret is gone.
  function remove(args) { return dbDelete(String(args.did)).then(function () { return true; }); }

  // Unlock: a passkey assertion (with PRF) over a fresh challenge, checked against the authority key in the identity's own
  // log; the account secret is unwrapped non-extractable and compared with its stored check value; the device key signs a
  // test message. Returns plain data only. A session is a later step.
  async function signIn(args) {
    var rec = await dbGet(String(args.did));
    if (!rec) throw new Error('No such identity on this device.');
    var challenge = rnd(32), diag = [];
    var a = await ceremony(diag, 'unlocking with the passkey', function () { return navigator.credentials.get({ publicKey: {
      challenge: challenge, allowCredentials: [{ type: 'public-key', id: kd.unb64u(rec.credentialId) }], userVerification: 'required',
      extensions: { prf: { eval: { first: SALT } } } } }); });
    var key = rec.inception.state.authority.keys.filter(function (k) { return k.id === rec.credentialId; })[0];
    if (!key || !(await kd.verifyAssertion(assertionSig(rec.credentialId, a), key.jwk, challenge))) throw new Error('The passkey assertion did not verify.');
    var prf = prfOf(a);
    if (!prf) throw new Error('No PRF output on sign-in.');
    var secret = await crypto.subtle.unwrapKey('raw', kd.unb64u(rec.wrappedAccountSecret), await prfKek(prf), 'AES-KW',
      { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    if (kd.b64u(await crypto.subtle.sign('HMAC', secret, enc.encode('keo/check'))) !== rec.check) throw new Error('The account secret did not unlock.');
    var msg = rnd(16), sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, rec.deviceKey.privateKey, msg);
    if (!(await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, rec.deviceKey.publicKey, sig, msg))) throw new Error('The device key did not verify.');
    var out = summary(rec);
    out.assertionOrigin = JSON.parse(new TextDecoder().decode(a.response.clientDataJSON)).origin;
    out.secretNonExtractable = secret.extractable === false;
    out.diag = diag;
    return out;
  }

  window.keoIdentity = { create: create, list: list, rename: rename, remove: remove, signIn: signIn };
})();
