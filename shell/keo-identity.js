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
// exists after the first and the inception has to contain it. That is all creating costs: the device key is listed in the
// inception (state.devices), so the signature that makes the identity also delegates this device, and the new identity's
// first session needs no third prompt (see "sign-in and the session").
//
// `next` is null: a first-run account is allowed to have no pre-committed next key and is flagged notRecoverable until a
// second credential on another rpId is enrolled. Nothing here enrolls one.
// The label is the user's own name for the identity on this device. It is never part of the log and never leaves the
// device; it is also written into the passkey's user name, so the authenticator's own picker shows it.
// Not here (later steps of 9.4l): export/import, registering to a host.
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
  // The identity's log as it is kept here: the inception with its signatures, then the events after it (rec.events, absent on a
  // record made before events existed). keo-did.js verifyLog checks it and folds it into the current keys and devices.
  function logOf(rec) { return { inception: rec.inception, sigs: rec.sigs, events: rec.events || [] }; }
  // The authority keys after every event, WITHOUT checking anything: for display only. Whatever decides a signature goes through
  // verifyLog, which does check.
  function keysOf(rec) {
    return rec.inception.state.authority.keys.concat((rec.events || []).map(function (x) { return x.event.add.key; }));
  }
  function summary(rec) {
    var next = rec.inception.state.next, keys = keysOf(rec), rpIds = {};
    keys.forEach(function (k) { rpIds[k.rpId] = true; });
    return {
      did: rec.did, label: rec.label, createdAt: rec.createdAt, rpId: rec.rpId,
      authorityKeys: keys.length,
      // true until a second credential on another rpId is enrolled (a pre-committed `next` key is what makes recovery possible)
      notRecoverable: (next === null || next === undefined) && Object.keys(rpIds).length < 2
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
      // The device key this identity was made on. Listing it here is what lets the inception signature delegate it.
      devices: [{ id: kd.b64u(await kd.sha256(enc.encode(kd.canonicalJson(deviceJwk)))), jwk: deviceJwk, addedAt: now }],
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
    // Signing in as the identity just made: the secret is in hand, and the inception's own authority signature is the
    // delegation of this device (cert.via = 'inception': a verifier checks the device key against the verified inception's
    // state.devices). Only when nobody is signed in: the world can ask for an identity to be made, and that must not swap
    // the session a person is using.
    if (!session) {
      await startSession(rec, secret, await worldKeyFrom(secret), {
        v: 1, via: 'inception', did: did, devicePubKeyJwk: deviceJwk, authorityKeyId: credentialId,
        issuedAt: now, exp: new Date(Date.parse(now) + SESSION_MS).toISOString(), aud: location.origin, scope: SESSION_SCOPE.slice(),
        assertion: { authenticatorData: sigs.authority[0].authenticatorData, clientDataJSON: sigs.authority[0].clientDataJSON, signature: sigs.authority[0].signature }
      });
    }
    var out = summary(rec);
    out.session = sessionInfo();
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

  // ---- sign-in and the session ----------------------------------------------------------------------------------------
  // Signing in is ONE passkey prompt that does two things: it unlocks the account secret (PRF) and it delegates the device
  // key (7.6). The assertion's challenge is H(cert) where cert = { v, did, devicePubKeyJwk, issuedAt, exp, aud, scope,
  // authorityKeyId }, so the same authority key that signed the inception vouches for this device for a limited time.
  //   - aud is this extension's origin: the certificate is for this shell and its world, not for a host. A host will want
  //     its own (registering with a host, a later step).
  //   - scope names what the session is for. The strings are this prototype's own and nothing enforces them yet.
  //   - exp: SESSION_MS after sign-in. A session that has expired is ended; it is never renewed without a prompt.
  // The session is held in this page's memory. The world can read the public part (session.current) and can neither start,
  // extend nor swap it, and never receives a key. Ending it is open to the world (it only lowers privilege).
  //
  // SURVIVING A REFRESH. A refresh of the tab destroys this page's memory, and a passkey prompt on every refresh made the
  // app unusable, so the session is also kept in IndexedDB (keo-session: the public part and the world key, a NON-extractable
  // key) and found again by an id in this tab's sessionStorage. What that costs: while the record exists, anyone who can read
  // this browser profile's files can use the world key without the passkey (the identity's own secret stays wrapped under
  // the passkey either way). So the record is short-lived: the live tab refreshes its 'seen' time every HEARTBEAT_MS, a
  // record is resumed only if it was seen within RESUME_WINDOW_MS, and a record not seen for longer is deleted by the next
  // page that loads. A tab closed for longer than that, or a browser restart, needs the passkey again. sessionStorage is
  // per tab, so another tab never picks up this one's session.
  var SESSION_MS = 12 * 60 * 60 * 1000;
  var SESSION_SCOPE = ['world:read', 'world:write', 'sign'];
  var HEARTBEAT_MS = 20 * 1000, RESUME_WINDOW_MS = 2 * 60 * 1000;
  var SESSION_DB = 'keo-session', SESSION_STORE = 's', TAB_KEY = 'keo.session';
  var session = null;      // { id, info, worldKey, timer, beat }

  function sessionDb() {
    return new Promise(function (res, rej) {
      var q = indexedDB.open(SESSION_DB, 1);
      q.onupgradeneeded = function () { q.result.createObjectStore(SESSION_STORE, { keyPath: 'id' }); };
      q.onsuccess = function () { res(q.result); };
      q.onerror = function () { rej(q.error); };
    });
  }
  function sessionTx(mode, fn) {
    return sessionDb().then(function (db) {
      return new Promise(function (res, rej) {
        var t = db.transaction(SESSION_STORE, mode), out;
        try { out = fn(t.objectStore(SESSION_STORE)); } catch (e) { db.close(); return rej(e); }
        t.oncomplete = function () { db.close(); res(out && 'result' in out ? out.result : undefined); };
        t.onabort = t.onerror = function () { db.close(); rej(t.error || new Error('session store transaction failed')); };
      });
    });
  }
  function tabId(set) {
    try { if (set === null) sessionStorage.removeItem(TAB_KEY); else if (set) sessionStorage.setItem(TAB_KEY, set); else return sessionStorage.getItem(TAB_KEY); } catch (e) {}
    return null;
  }
  function saveSession() {
    if (!session) return Promise.resolve();
    return sessionTx('readwrite', function (st) { return st.put({ id: session.id, info: session.info, worldKey: session.worldKey, seen: Date.now() }); }).catch(function () {});
  }
  // Records nobody has touched within the window belong to a tab that is gone (or a browser that was closed).
  function purgeStale() {
    return sessionTx('readwrite', function (st) {
      var c = st.openCursor();
      c.onsuccess = function () { var cur = c.result; if (!cur) return; if (Date.now() - cur.value.seen > RESUME_WINDOW_MS) cur.delete(); cur.continue(); };
    }).catch(function () {});
  }

  // Code in THIS page that holds things which belong to the session (the open connections, messages waiting for the world) asks to
  // be told when it ends, however it ends: sign-out, expiry, removal of the identity. Called once per ended session, after the
  // session is gone, so a listener that looks for it finds nobody signed in.
  var endListeners = [];
  function onEnd(fn) { endListeners.push(fn); }

  function endSession() {
    if (session) {
      if (session.timer) clearTimeout(session.timer);
      if (session.beat) clearInterval(session.beat);
      var id = session.id;
      session = null;
      tabId(null);
      endListeners.forEach(function (fn) { try { fn(); } catch (e) {} });
      return sessionTx('readwrite', function (st) { return st.delete(id); }).catch(function () {});
    }
    return Promise.resolve();
  }
  // Public view of the session: plain data, safe to hand to the world. The certificate is a public document.
  function sessionInfo() { return session ? session.info : null; }
  function current() { return Promise.resolve(sessionInfo()); }
  function signOut() { return endSession().then(function () { return true; }); }
  // For code in THIS page only (the saved-worlds store). Never put it behind a bridge op: it is the key that decrypts
  // everything the identity has saved. Null when nobody is signed in.
  function sessionWorldKey() { return session ? { did: session.info.did, key: session.worldKey } : null; }

  function armSession(id, info, worldKey) {
    var left = Date.parse(info.exp) - Date.now();
    var timer = setTimeout(function () { if (session && session.info === info) endSession(); }, Math.max(0, left));
    var beat = setInterval(function () { if (session && session.id === id) saveSession(); }, HEARTBEAT_MS);
    session = { id: id, info: info, worldKey: worldKey, timer: timer, beat: beat };
  }
  // The key for saved worlds: one HMAC output of the secret under its own label, kept as a non-extractable AES-GCM key. The
  // label is all that separates it from the discovery seed and the check value, so it is never reused.
  async function worldKeyFrom(secret) {
    var wk = new Uint8Array(await crypto.subtle.sign('HMAC', secret, enc.encode('keo/worlds/v1')));
    var key = await crypto.subtle.importKey('raw', wk, 'AES-GCM', false, ['encrypt', 'decrypt']);
    wk.fill(0);
    return key;
  }
  // Starts the session for an identity whose secret was just unlocked (or just made). cert carries its own assertion.
  async function startSession(rec, secret, worldKey, cert) {
    await endSession();
    var id = kd.b64u(rnd(16));
    var info = { did: rec.did, label: rec.label, issuedAt: cert.issuedAt, exp: cert.exp, cert: cert };
    armSession(id, info, worldKey);
    tabId(id);
    await saveSession();
    return info;
  }

  // Called once when a page loads, before anything is shown: picks this tab's session up again after a refresh. Null when
  // there is none, it has expired, or it was not seen within the window (the tab was closed for a while).
  async function resume() {
    await purgeStale();
    var id = tabId();
    if (!id || session) return sessionInfo();
    var rec = await sessionTx('readonly', function (st) { return st.get(id); }).catch(function () { return null; });
    if (!rec || Date.now() - rec.seen > RESUME_WINDOW_MS || Date.parse(rec.info.exp) <= Date.now()) { tabId(null); return null; }
    var ident = await dbGet(rec.info.did);
    if (!ident) { tabId(null); return null; }
    armSession(rec.id, rec.info, rec.worldKey);
    await saveSession();
    return sessionInfo();
  }

  // Unlock and delegate with one passkey prompt, check the answer against the authority key in the identity's own log, unwrap
  // the account secret non-extractable and compare it with its stored check value, and start the session. Returns plain data.
  async function signIn(args) {
    var rec = await dbGet(String(args.did));
    if (!rec) throw new Error('No such identity on this device.');
    var now = Date.now(), diag = [];
    var cert = { v: 1, did: rec.did, devicePubKeyJwk: rec.deviceKey.publicJwk, issuedAt: new Date(now).toISOString(),
      exp: new Date(now + SESSION_MS).toISOString(), aud: location.origin, scope: SESSION_SCOPE.slice(), authorityKeyId: rec.credentialId };
    var challenge = await kd.eventHash(cert);
    var a = await ceremony(diag, 'unlocking with the passkey', function () { return navigator.credentials.get({ publicKey: {
      challenge: challenge, allowCredentials: [{ type: 'public-key', id: kd.unb64u(rec.credentialId) }], userVerification: 'required',
      extensions: { prf: { eval: { first: SALT } } } } }); });
    // the key is looked up in the log AFTER its events: a passkey added by a later event (one made on another origin) is not in the inception
    var folded = await kd.verifyLog(logOf(rec));
    if (!folded.ok) throw new Error('This identity\'s log does not verify: ' + folded.error);
    var key = folded.state.authority.keys.filter(function (k) { return k.id === rec.credentialId; })[0];
    var sig = assertionSig(rec.credentialId, a);
    if (!key || !(await kd.verifyAssertion(sig, key.jwk, challenge))) throw new Error('The passkey assertion did not verify.');
    var prf = prfOf(a);
    if (!prf) throw new Error('No PRF output on sign-in.');
    var secret = await crypto.subtle.unwrapKey('raw', kd.unb64u(rec.wrappedAccountSecret), await prfKek(prf), 'AES-KW',
      { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    if (kd.b64u(await crypto.subtle.sign('HMAC', secret, enc.encode('keo/check'))) !== rec.check) throw new Error('The account secret did not unlock.');
    var msg = rnd(16), dsig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, rec.deviceKey.privateKey, msg);
    if (!(await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, rec.deviceKey.publicKey, dsig, msg))) throw new Error('The device key did not verify.');
    var info = await startSession(rec, secret, await worldKeyFrom(secret),
      Object.assign({}, cert, { assertion: { authenticatorData: sig.authenticatorData, clientDataJSON: sig.clientDataJSON, signature: sig.signature } }));

    var out = summary(rec);
    out.assertionOrigin = JSON.parse(new TextDecoder().decode(a.response.clientDataJSON)).origin;
    out.secretNonExtractable = secret.extractable === false;
    out.session = info;
    out.diag = diag;
    return out;
  }

  // For code in THIS page only (the peer handshake, keo-p2p.js): what a stranger needs to check a signature of the signed-in
  // identity's device key (keo-hello.js): the inception with its signatures and the session's delegation certificate. Public
  // documents all of them, but kept off the bridge so the world is not handed more than session.current gives it.
  async function deviceProof() {
    if (!session) throw new Error('Sign in first.');
    var info = session.info, rec = await dbGet(info.did);
    if (!rec) throw new Error('This identity is no longer on this device.');
    return { did: rec.did, inception: rec.inception, sigs: rec.sigs, events: rec.events || [], cert: info.cert };
  }
  // Signs `bytes` with the device key of the identity `did`, which must still be the one signed in. Never put it behind a
  // bridge op: it signs whatever it is given, so the world could make this device vouch for anything. Callers decide what is
  // signed. No passkey prompt: the device key is what the session's certificate delegates, for as long as the session lasts.
  // Resolves to the raw ECDSA signature (base64url).
  async function signWithDevice(bytes, did) {
    if (!session || session.info.did !== did) throw new Error('The signed-in identity changed.');
    var rec = await dbGet(did);
    if (!rec) throw new Error('This identity is no longer on this device.');
    if (!session || session.info.did !== did) throw new Error('The signed-in identity changed.');
    return kd.b64u(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, rec.deviceKey.privateKey, bytes));
  }

  // ---- the same identity on another origin -------------------------------------------------------------------------------
  // A passkey is bound to the origin it was made on. To use an identity on another origin (the desktop app, a new extension id) a
  // SECOND passkey is made there and added to the identity's log by an event (keo-did.js add-authority), and the account secret is
  // carried over so the new passkey can wrap it. The data sealed under the secret (saved worlds, the local library) then opens on
  // both. Three messages, each plain JSON, so any channel can carry them (the connection two devices already make, a file):
  //   1. NEW side  enrollRequest()           -> request   { key, device, ecdh } : public data only. The passkey is made here.
  //   2. OLD side  enrollGrant(did, request) -> grant     : the event signed by an existing passkey, and the secret sealed to the
  //                                                        request's ecdh key. ONE prompt: it signs the event and unlocks the secret.
  //   3. NEW side  enrollComplete(grant)     -> done      : this side's passkey co-signs, the secret is wrapped under it and kept.
  //      OLD side  enrollAccept(done)                     : takes the finished event into its own log (the logs are then equal).
  // Nothing here is meant for the world, and none of it is behind a bridge op. The reason is the words below.
  //
  // WHAT STOPS A STRANGER GETTING THE SECRET. The request travels over a channel nobody has vouched for, so a request swapped on the
  // way would make the old side seal the secret to the wrong key. Both ends therefore show eight words for the request
  // (keo-fingerprint.js requestWords) and the person compares them; enrollGrant will not run without the words the person TYPED, and
  // checks them against the request it was given. The same holds the other way: a forged grant (an attacker's own identity, adding
  // this side's key) would give the new side an identity it does not want, so enrollComplete needs the words of the identity's DID as
  // read from the old device. The words must come from a dialog the SHELL draws: a caller that could supply them could compute them.
  // A pending request lives in this page's memory only. If the page is closed after the passkey was made, the passkey stays
  // unused in the authenticator (a page cannot delete one) and the person starts again.
  var pendingEnroll = null;
  var ENROLL_OK_KINDS = ['platform', 'security-key'];

  function enrollText(req) { return kd.canonicalJson(req); }
  async function deviceIdOf(jwk) { return kd.b64u(await kd.sha256(enc.encode(kd.canonicalJson(plainEcJwk(jwk))))); }
  // Rebuilds a request from its known members only, so nothing else a sender added can enter the log; throws on anything malformed.
  async function cleanRequest(req) {
    var bad = new Error('That is not a valid request to add a device.');
    if (!req || req.v !== 1 || req.kind !== 'enroll-request' || !req.key || !req.device || !req.ecdh) throw bad;
    var k = req.key, d = req.device;
    if (typeof k.id !== 'string' || !k.id || k.id.length > 1400 || !kd.isPublicEcJwk(k.jwk) || typeof k.rpId !== 'string' || !k.rpId ||
        ENROLL_OK_KINDS.indexOf(k.kind) < 0 || typeof k.addedAt !== 'string') throw bad;
    if (typeof d.id !== 'string' || !kd.isPublicEcJwk(d.jwk) || d.id !== await deviceIdOf(d.jwk) || typeof d.addedAt !== 'string') throw bad;
    if (!kd.isPublicEcJwk(req.ecdh)) throw bad;
    return { v: 1, kind: 'enroll-request',
      key: { id: k.id, jwk: plainEcJwk(k.jwk), rpId: k.rpId, kind: k.kind, addedAt: k.addedAt },
      device: { id: d.id, jwk: plainEcJwk(d.jwk), addedAt: d.addedAt },
      ecdh: plainEcJwk(req.ecdh) };
  }
  // The key the secret is sealed under: ECDH between the two ephemeral keys, then HKDF salted with the event hash, so a grant is
  // tied to this request AND this event and cannot be replayed under another.
  async function sealingKey(privateKey, peerPublicJwk, eventHash) {
    var pub = await crypto.subtle.importKey('jwk', plainEcJwk(peerPublicJwk), { name: 'ECDH', namedCurve: 'P-256' }, false, []);
    var bits = await crypto.subtle.deriveBits({ name: 'ECDH', public: pub }, privateKey, 256);
    var base = await crypto.subtle.importKey('raw', bits, 'HKDF', false, ['deriveKey']);
    return crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: eventHash, info: enc.encode('keo/enroll/v1') }, base,
      { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  }

  // For the dialog's live hint: do these words (as typed) belong to this request? The same test enrollGrant makes at the click, over the
  // request as it will be used (cleaned), so the hint and the gate cannot disagree. A request that is not valid is just "no".
  async function enrollWordsMatch(request, said) {
    try { return await window.keoFingerprint.requestMatches(enrollText(await cleanRequest(request)), said); } catch (e) { return false; }
  }

  // NEW side. Makes the passkey (this origin's), a device key, and a throwaway key to receive the secret with.
  async function enrollRequest(opts) {
    opts = opts || {};
    var label = cleanLabel(opts.label), diag = [];
    var cred = await ceremony(diag, 'creating the passkey', function () { return navigator.credentials.create({ publicKey: {
      rp: { name: 'keo' }, user: { id: rnd(16), name: label, displayName: label }, challenge: rnd(32),
      pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
      authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
      extensions: { prf: { eval: { first: SALT } } } } }); });
    if (cred.response.getPublicKeyAlgorithm() !== -7) throw new Error('This authenticator did not make an ES256 passkey.');
    var rpId = await effectiveRpId(new Uint8Array(cred.response.getAuthenticatorData()));
    var authJwk = plainEcJwk(await crypto.subtle.exportKey('jwk', await crypto.subtle.importKey('spki',
      cred.response.getPublicKey(), { name: 'ECDSA', namedCurve: 'P-256' }, true, ['verify'])));
    var attachment = cred.authenticatorAttachment || null, now = new Date().toISOString();
    var deviceKey = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']);
    var deviceJwk = plainEcJwk(await crypto.subtle.exportKey('jwk', deviceKey.publicKey));
    var ecdh = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
    var request = await cleanRequest({ v: 1, kind: 'enroll-request',
      key: { id: kd.b64u(cred.rawId), jwk: authJwk, rpId: rpId, kind: attachment === 'cross-platform' ? 'security-key' : 'platform', addedAt: now },
      device: { id: await deviceIdOf(deviceJwk), jwk: deviceJwk, addedAt: now },
      ecdh: plainEcJwk(await crypto.subtle.exportKey('jwk', ecdh.publicKey)) });
    pendingEnroll = { request: request, label: label, rawId: cred.rawId, prfAtCreate: prfOf(cred), deviceKey: deviceKey, ecdh: ecdh };
    return { request: request, words: await window.keoFingerprint.requestWords(enrollText(request)), rpId: rpId, diag: diag };
  }
  function enrollCancel() { pendingEnroll = null; return Promise.resolve(true); }

  // OLD side. `args`: { did, request, confirm } where `confirm` is the words the person typed from the NEW device's screen.
  async function enrollGrant(args) {
    if (!session || session.info.did !== String(args.did)) throw new Error('Sign in as this identity first.');
    var rec = await dbGet(String(args.did));
    if (!rec) throw new Error('No such identity on this device.');
    var req = await cleanRequest(args.request);
    if (!(await window.keoFingerprint.requestMatches(enrollText(req), args.confirm))) throw new Error('The words do not match the request, so nothing was approved.');
    var folded = await kd.verifyLog(logOf(rec));
    if (!folded.ok) throw new Error('This identity\'s log does not verify: ' + folded.error);
    if (folded.state.authority.threshold !== 1) throw new Error('Adding a device to an identity that needs several passkeys is not supported yet.');
    var key = folded.state.authority.keys.filter(function (k) { return k.id === rec.credentialId; })[0];
    if (!key) throw new Error('This device\'s passkey is not in the identity\'s log.');
    var events = rec.events || [];
    var ev = await kd.addAuthorityEvent(events.length ? events[events.length - 1].event : rec.inception, req.key, req.device);
    var H = await kd.eventHash(ev), diag = [];
    // one prompt: the assertion signs the event, and the PRF output it carries unlocks the secret to hand over
    var a = await ceremony(diag, 'approving the new device', function () { return navigator.credentials.get({ publicKey: {
      challenge: H, allowCredentials: [{ type: 'public-key', id: kd.unb64u(rec.credentialId) }], userVerification: 'required',
      extensions: { prf: { eval: { first: SALT } } } } }); });
    var sig = assertionSig(rec.credentialId, a);
    if (!(await kd.verifyAssertion(sig, key.jwk, H))) throw new Error('The passkey assertion did not verify.');
    var prf = prfOf(a);
    if (!prf) throw new Error('No PRF output, so the secret cannot be unlocked.');
    var secret = await crypto.subtle.unwrapKey('raw', kd.unb64u(rec.wrappedAccountSecret), await prfKek(prf), 'AES-KW',
      { name: 'HMAC', hash: 'SHA-256' }, true, ['sign']);          // extractable for the length of this function only
    if (kd.b64u(await crypto.subtle.sign('HMAC', secret, enc.encode('keo/check'))) !== rec.check) throw new Error('The account secret did not unlock.');
    var raw = new Uint8Array(await crypto.subtle.exportKey('raw', secret));
    var eph = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
    var iv = rnd(12), sealed;
    try { sealed = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv, additionalData: H }, await sealingKey(eph.privateKey, req.ecdh, H), raw); }
    finally { raw.fill(0); }
    return { v: 1, kind: 'enroll-grant', inception: rec.inception, sigs: rec.sigs, events: events, event: ev, authority: sig,
      ecdh: plainEcJwk(await crypto.subtle.exportKey('jwk', eph.publicKey)), iv: kd.b64u(iv), sealed: kd.b64u(new Uint8Array(sealed)), check: rec.check };
  }

  // NEW side, before asking the person anything: whose identity this grant is for, and the words to compare with the old device's.
  async function enrollPreview(grant) {
    var v = await kd.verifyLog({ inception: grant && grant.inception, sigs: grant && grant.sigs, events: grant && grant.events });
    if (!v.ok) throw new Error('That is not a valid grant: ' + v.error);
    return { did: v.did, words: await window.keoFingerprint.words(v.did) };
  }

  // NEW side. `args`: { grant, confirm } where `confirm` is the words of the DID as the person read them off the old device.
  async function enrollComplete(args) {
    var p = pendingEnroll, g = args && args.grant;
    if (!p) throw new Error('No request is waiting. Start again from "add this device".');
    if (!g || g.kind !== 'enroll-grant' || g.v !== 1 || !g.event || !g.authority || typeof g.sealed !== 'string' || typeof g.iv !== 'string' || !g.ecdh) throw new Error('That is not a valid grant.');
    var base = await kd.verifyLog({ inception: g.inception, sigs: g.sigs, events: g.events });
    if (!base.ok) throw new Error('That is not a valid grant: ' + base.error);
    if (!(await window.keoFingerprint.matches(base.did, args.confirm))) throw new Error('The words do not match the identity, so nothing was added.');
    if (await dbGet(base.did)) throw new Error('This identity is already on this device.');
    var ev = g.event, add = ev.add || {};
    if (kd.canonicalJson(add.key) !== kd.canonicalJson(p.request.key) || kd.canonicalJson(add.device) !== kd.canonicalJson(p.request.device)) {
      throw new Error('The grant is not for the request this device made.');
    }
    var H = await kd.eventHash(ev), diag = [];
    // this side's passkey signs the same event; the PRF output that comes with it is what will wrap the secret
    var a = await ceremony(diag, 'adding this device', function () { return navigator.credentials.get({ publicKey: {
      challenge: H, allowCredentials: [{ type: 'public-key', id: p.rawId }], userVerification: 'required',
      extensions: { prf: { eval: { first: SALT } } } } }); });
    var newSig = assertionSig(p.request.key.id, a);
    var prf = prfOf(a) || p.prfAtCreate;
    if (!prf) throw new Error('This authenticator did not return a PRF output, so it cannot protect the account secret.');
    var events = (g.events || []).concat([{ event: ev, sigs: { authority: [g.authority], newKey: newSig } }]);
    var log = { inception: g.inception, sigs: g.sigs, events: events };
    var v = await kd.verifyLog(log, base.did);
    if (!v.ok) throw new Error('The finished log does not verify: ' + v.error);
    var raw;
    try {
      raw = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: kd.unb64u(g.iv), additionalData: H },
        await sealingKey(p.ecdh.privateKey, g.ecdh, H), kd.unb64u(g.sealed)));
    } catch (e) { throw new Error('The secret in the grant could not be opened.'); }
    var secret = await crypto.subtle.importKey('raw', raw, { name: 'HMAC', hash: 'SHA-256' }, true, ['sign']);
    raw.fill(0);
    var check = kd.b64u(await crypto.subtle.sign('HMAC', secret, enc.encode('keo/check')));
    if (check !== g.check) throw new Error('The secret in the grant is not this identity\'s.');
    var disc = await kd.ed25519FromSeed(await kd.discoverySeed(secret, 1));
    if (disc.publicZ32 !== g.inception.state.discovery.key) throw new Error('The secret in the grant does not belong to this identity.');
    var now = new Date().toISOString();
    var wrapped = await crypto.subtle.wrapKey('raw', secret, await prfKek(prf), 'AES-KW');
    var rec = { did: base.did, label: p.label, createdAt: now, rpId: p.request.key.rpId, credentialId: p.request.key.id,
      inception: g.inception, sigs: g.sigs, events: events,
      wrappedAccountSecret: kd.b64u(wrapped), check: check,
      deviceKey: { privateKey: p.deviceKey.privateKey, publicKey: p.deviceKey.publicKey, publicJwk: p.request.device.jwk },
      discoveryKey: disc.privateKey };
    await dbPut(rec);
    pendingEnroll = null;
    if (!session) {
      await startSession(rec, secret, await worldKeyFrom(secret), {
        v: 1, via: 'log', did: rec.did, devicePubKeyJwk: p.request.device.jwk, authorityKeyId: rec.credentialId,
        issuedAt: now, exp: new Date(Date.parse(now) + SESSION_MS).toISOString(), aud: location.origin, scope: SESSION_SCOPE.slice(),
        assertion: { authenticatorData: newSig.authenticatorData, clientDataJSON: newSig.clientDataJSON, signature: newSig.signature }
      });
    }
    var out = summary(rec);
    out.session = sessionInfo();
    out.done = { v: 1, kind: 'enroll-done', did: rec.did, events: events };
    out.diag = diag;
    return out;
  }

  // OLD side (or any device that holds the identity): takes a longer log that EXTENDS the one it has. A log that is not an extension
  // (a fork: the same position holds another event) is refused, as is one that does not verify, whoever sent it.
  async function enrollAccept(args) {
    var rec = await dbGet(String(args && args.did));
    if (!rec) throw new Error('No such identity on this device.');
    var theirs = args.events;
    if (!Array.isArray(theirs)) throw new Error('That is not a valid log.');
    var v = await kd.verifyLog({ inception: rec.inception, sigs: rec.sigs, events: theirs }, rec.did);
    if (!v.ok) throw new Error('That log does not verify: ' + v.error);
    var mine = rec.events || [];
    // The shorter of the two must be the start of the longer. If it is not, they disagree about what came first (a fork).
    var common = Math.min(mine.length, theirs.length);
    for (var i = 0; i < common; i++) {
      if (kd.canonicalJson(mine[i].event) !== kd.canonicalJson(theirs[i].event)) throw new Error('That log disagrees with this device\'s own (a fork), so it was not taken.');
    }
    // The same log, or an older copy of it (a code that was kept from before): nothing new, nothing wrong.
    if (theirs.length <= mine.length) return summary(rec);
    rec.events = theirs;
    await dbPut(rec);
    return summary(rec);
  }

  window.keoIdentity = { create: create, list: list, rename: rename, remove: remove, signIn: signIn, current: current,
    signOut: signOut, onEnd: onEnd, resume: resume, sessionWorldKey: sessionWorldKey, deviceProof: deviceProof, signWithDevice: signWithDevice,
    enrollRequest: enrollRequest, enrollWordsMatch: enrollWordsMatch, enrollCancel: enrollCancel, enrollGrant: enrollGrant, enrollPreview: enrollPreview, enrollComplete: enrollComplete, enrollAccept: enrollAccept };
})();
