/**
 * Identity vault: the script that runs INSIDE the cross-origin vault page
 * (/identity-vault, served by IdentityServer.js on its own origin, e.g.
 * https://vault.dev.tinylil.world). Plain browser JS, not a Lively module:
 * the vault page has no Lively runtime on purpose.
 *
 * Holds the passkey-derived KEK and X25519 private key for the app and
 * exposes OPERATIONS over postMessage, never the key bytes. Encryption.md §19.5
 * has the design, the spike results and the open questions.
 *
 * Trust boundary:
 *   - Messages are accepted only if event.origin is in the allow-list the SERVER
 *     put in <meta name="vault-app-origins"> AND event.source is window.parent.
 *     The allow-list is never taken from the URL, so a hostile page that frames
 *     the vault cannot name itself as the app. Replies go only to the origin
 *     that asked.
 *   - Unknown / inherited op names are ignored.
 *   - Dependencies: libsodium (/core/lib/libsodium/sodium.js, loaded by the
 *     page before this file). CSP is script-src 'self' 'wasm-unsafe-eval'.
 *
 * Formats are exactly Crypto.js's, so everything already stored keeps working:
 *   wrappedDek = base64url(nonce24 || secretbox(dek, kek))
 *   encryptPayload = secretbox(JSON, kek) with a fresh nonce
 *   sealed boxes = libsodium crypto_box_seal
 *   KEK = PRF("lively-kek-v1"); X25519 scalar = clamp(PRF("lively-x25519:" + credentialId))
 *
 * Persistence (opt-in, same model as KeyVault.js): when a request says
 * persist:true the keys are encrypted with a NON-EXTRACTABLE AES-GCM device key
 * kept in THIS origin's IndexedDB and the blob goes in this origin's
 * sessionStorage (per tab, TTL 8 h, AAD binds slot + expiry). Neither is
 * reachable from the app's origin.
 *
 * What the app does NOT get: the KEK, the X25519 private key, the soft signing
 * key (decryptPayload returns a signer stub; signBytes signs here). What it still
 * gets: unwrapped DEKs and decrypted payloads (it has to, to show content).
 * A compromised app realm can still ASK for operations while unlocked.
 */
(function () {
  "use strict";

  var DB_NAME = "lively-identityvault", STORE = "keys", DEVICE_KEY = "device-v1";
  var PREFIX = "lively.iv1:", TTL_MS = 8 * 60 * 60 * 1000;
  var KEK_SALT = "lively-kek-v1";

  var metaEl = document.querySelector('meta[name="vault-app-origins"]');
  var ALLOWED = metaEl && metaEl.content ? metaEl.content.split(",").filter(Boolean) : [];

  // credentialId -> { kek: Uint8Array|null, pub: Uint8Array|null, priv: Uint8Array|null }
  var mem = {};
  var inflight = {};            // credentialId -> Promise (one ceremony at a time)
  var signers = {};             // token -> non-extractable ECDSA P-256 CryptoKey (the soft signing key)
  var armed = null;             // { op, args, origin, id } for the click fallback

  // ─── small helpers ─────────────────────────────────────────────────────────

  function sodiumReady() { return window.sodium.ready.then(function () { return window.sodium; }); }
  function b64u(sodium, u8) { return sodium.to_base64(u8, sodium.base64_variants.URLSAFE_NO_PADDING); }
  function unb64u(sodium, v) {
    return v instanceof Uint8Array ? v : sodium.from_base64(v, sodium.base64_variants.URLSAFE_NO_PADDING);
  }
  function enc(s) { return new TextEncoder().encode(s); }
  function fail(name, message) { var e = new Error(message); e.name = name; return e; }
  function zero(u8) { if (u8) u8.fill(0); }

  // ─── persistence (non-extractable device key + sessionStorage blob) ────────

  function openDb() {
    return new Promise(function (resolve, reject) {
      var req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = function () { req.result.createObjectStore(STORE); };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
    });
  }

  function tx(db, mode, fn) {
    return new Promise(function (resolve, reject) {
      var t = db.transaction(STORE, mode), out = fn(t.objectStore(STORE));
      t.oncomplete = function () { db.close(); resolve(out && out.result); };
      t.onerror = t.onabort = function () { db.close(); reject(t.error); };
    });
  }

  // Atomic get-or-create: generate first (a transaction cannot await), then
  // get+put in one readwrite transaction so two tabs racing share one key.
  function deviceKey(create) {
    return openDb().then(function (db) {
      return tx(db, "readonly", function (s) { return s.get(DEVICE_KEY); });
    }).then(function (existing) {
      if (existing || !create) return existing || null;
      return crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]).then(function (fresh) {
        return openDb().then(function (db) {
          return new Promise(function (resolve, reject) {
            var t = db.transaction(STORE, "readwrite"), s = t.objectStore(STORE), winner = fresh;
            var g = s.get(DEVICE_KEY);
            g.onsuccess = function () { if (g.result) winner = g.result; else s.put(fresh, DEVICE_KEY); };
            t.oncomplete = function () { db.close(); resolve(winner); };
            t.onerror = t.onabort = function () { db.close(); reject(t.error); };
          });
        });
      });
    });
  }

  function aad(slot, exp) { return enc("lively-iv1|" + slot + "|" + exp); }
  function b64(u8) { var s = ""; for (var i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]); return btoa(s); }
  function unb64(str) { var b = atob(str), u = new Uint8Array(b.length); for (var i = 0; i < b.length; i++) u[i] = b.charCodeAt(i); return u; }

  function remember(slot, bytes) {
    var exp = Date.now() + TTL_MS, iv = crypto.getRandomValues(new Uint8Array(12));
    return deviceKey(true).then(function (dk) {
      return crypto.subtle.encrypt({ name: "AES-GCM", iv: iv, additionalData: aad(slot, exp) }, dk, bytes);
    }).then(function (ct) {
      sessionStorage.setItem(PREFIX + slot, JSON.stringify({ v: 1, exp: exp, iv: b64(iv), ct: b64(new Uint8Array(ct)) }));
      return true;
    }).catch(function () { return false; });
  }

  // -> Uint8Array | null; drops the blob on any failure
  function recall(slot) {
    var key = PREFIX + slot, raw, blob;
    function drop() { try { sessionStorage.removeItem(key); } catch (e) {} return null; }
    try { raw = sessionStorage.getItem(key); } catch (e) { return Promise.resolve(null); }
    if (!raw) return Promise.resolve(null);
    try { blob = JSON.parse(raw); } catch (e) { return Promise.resolve(drop()); }
    if (!blob || blob.v !== 1 || typeof blob.exp !== "number" || Date.now() >= blob.exp) return Promise.resolve(drop());
    return deviceKey(false).then(function (dk) {
      if (!dk) return drop();
      return crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(blob.iv), additionalData: aad(slot, blob.exp) }, dk, unb64(blob.ct))
        .then(function (pt) { return new Uint8Array(pt); }, drop);
    }).catch(drop);
  }

  function persistedCredentialIds() {
    var ids = {};
    try {
      for (var i = 0; i < sessionStorage.length; i++) {
        var k = sessionStorage.key(i);
        if (k && k.indexOf(PREFIX) === 0) { var slot = k.slice(PREFIX.length); ids[slot.slice(slot.indexOf(":") + 1)] = true; }
      }
    } catch (e) {}
    return Object.keys(ids);
  }

  function forgetAllPersisted() {
    try {
      var keys = [];
      for (var i = 0; i < sessionStorage.length; i++) {
        var k = sessionStorage.key(i);
        if (k && k.indexOf(PREFIX) === 0) keys.push(k);
      }
      keys.forEach(function (k) { sessionStorage.removeItem(k); });
    } catch (e) {}
  }

  function persist(credentialId) {
    var st = mem[credentialId];
    if (!st) return Promise.resolve(false);
    var jobs = [];
    if (st.kek) jobs.push(remember("kek:" + credentialId, st.kek));
    if (st.pub && st.priv) {
      var both = new Uint8Array(64); both.set(st.pub, 0); both.set(st.priv, 32);
      jobs.push(remember("x25519:" + credentialId, both).then(function (ok) { zero(both); return ok; }));
    }
    return Promise.all(jobs).then(function (r) { return r.length > 0 && r.every(Boolean); });
  }

  // Bring a persisted copy into memory if we do not have one yet.
  function ensureLoaded(credentialId) {
    var st = mem[credentialId];
    if (st && st.kek && st.priv) return Promise.resolve(st);
    return Promise.all([recall("kek:" + credentialId), recall("x25519:" + credentialId)]).then(function (r) {
      var cur = mem[credentialId] || (mem[credentialId] = { kek: null, pub: null, priv: null });
      if (!cur.kek && r[0] && r[0].length === 32) cur.kek = r[0];
      if (!cur.priv && r[1] && r[1].length === 64) { cur.pub = r[1].slice(0, 32); cur.priv = r[1].slice(32); }
      return cur;
    });
  }

  // ─── key derivation ────────────────────────────────────────────────────────

  function clamp(sodium, prf) {
    var priv = new Uint8Array(prf);
    priv[0] &= 248; priv[31] &= 127; priv[31] |= 64;
    return { priv: priv, pub: sodium.crypto_scalarmult_base(priv) };
  }

  // ONE passkey ceremony yields both outputs (PRF `first` = KEK salt, `second` =
  // X25519 salt), so the user sees one prompt where the page-realm code needed two.
  function runCeremony(sodium, a) {
    var evalSalts = { first: enc(KEK_SALT).buffer, second: enc("lively-x25519:" + a.credentialId).buffer };
    return navigator.credentials.get({ publicKey: {
      challenge: crypto.getRandomValues(new Uint8Array(32)),
      rpId: a.rpId || undefined,
      allowCredentials: [{ type: "public-key", id: unb64u(sodium, a.credentialId) }],
      userVerification: "required",
      extensions: { prf: { eval: evalSalts } },
    } }).then(function (cred) {
      var ext = cred.getClientExtensionResults();
      if (!ext.prf || !ext.prf.results || !ext.prf.results.first || !ext.prf.results.second) {
        throw fail("PrfUnavailable", "PRF extension not available for this credential. Re-register with PRF requested to enable encryption.");
      }
      var kek = new Uint8Array(ext.prf.results.first);
      var x = clamp(sodium, new Uint8Array(ext.prf.results.second));
      var st = mem[a.credentialId] || (mem[a.credentialId] = {});
      st.kek = kek; st.pub = x.pub; st.priv = x.priv;
      return st;
    });
  }

  function opDerive(a) {
    if (!a.credentialId) return Promise.reject(fail("TypeError", "derive: credentialId is required"));
    var id = a.credentialId;
    if (inflight[id]) return inflight[id];
    var p = sodiumReady().then(function (sodium) {
      return ensureLoaded(id).then(function (st) {
        if (st.kek && st.priv && !a.force) return { publicKey: st.pub, fromCache: true };
        return runCeremony(sodium, a).then(function (st2) {
          var done = a.persist ? persist(id) : Promise.resolve(false);
          return done.then(function (persisted) { return { publicKey: st2.pub, fromCache: false, persisted: persisted }; });
        });
      });
    });
    inflight[id] = p;
    var clear = function () { delete inflight[id]; };
    p.then(clear, clear);
    return p;
  }

  // ─── operations that use the held keys ─────────────────────────────────────

  function needKek(id) {
    return ensureLoaded(id).then(function (st) {
      if (!st.kek) throw fail("Locked", "vault is locked: no KEK for this credential");
      return st.kek;
    });
  }
  function needX(id) {
    return ensureLoaded(id).then(function (st) {
      if (!st.priv) throw fail("Locked", "vault is locked: no X25519 key for this credential");
      return st;
    });
  }

  var OPS = {
    hello: function () { return Promise.resolve({ version: 1, origin: location.origin, hasWebCrypto: !!(crypto && crypto.subtle) }); },

    derive: opDerive,

    // Registration happens in the app page (it creates the credential), which
    // briefly has the PRF bytes; hand them over and the app keeps only a handle.
    importKeys: function (a) {
      return sodiumReady().then(function (sodium) {
        var st = mem[a.credentialId] || (mem[a.credentialId] = { kek: null, pub: null, priv: null });
        if (a.kek) st.kek = new Uint8Array(a.kek);
        if (a.privateKey && a.publicKey) { st.priv = new Uint8Array(a.privateKey); st.pub = new Uint8Array(a.publicKey); }
        var done = a.persist ? persist(a.credentialId) : Promise.resolve(false);
        return done.then(function (persisted) { return { persisted: persisted, publicKey: st.pub || null }; });
      });
    },

    status: function (a) {
      return ensureLoaded(a.credentialId).then(function (st) { return { kek: !!st.kek, x25519: !!st.priv }; });
    },

    list: function () {
      var ids = Object.keys(mem).concat(persistedCredentialIds());
      var seen = {}, uniq = ids.filter(function (i) { return seen[i] ? false : (seen[i] = true); });
      return Promise.all(uniq.map(function (id) {
        return ensureLoaded(id).then(function (st) { return st.kek || st.priv ? { credentialId: id, kek: !!st.kek, x25519: !!st.priv, publicKey: st.pub || null } : null; });
      })).then(function (rows) { return rows.filter(Boolean); });
    },

    persist: function (a) { return persist(a.credentialId).then(function (ok) { return { persisted: ok }; }); },

    // wrapDek: fresh random DEK wrapped under the KEK. Returns both, like Crypto.wrapDek.
    wrapDek: function (a) {
      return Promise.all([sodiumReady(), needKek(a.credentialId)]).then(function (r) {
        var sodium = r[0], kek = r[1];
        var dek = sodium.randombytes_buf(32);
        var nonce = sodium.randombytes_buf(sodium.crypto_secretbox_NONCEBYTES);
        var wrapped = sodium.crypto_secretbox_easy(dek, nonce, kek);
        var combined = new Uint8Array(nonce.length + wrapped.length);
        combined.set(nonce); combined.set(wrapped, nonce.length);
        return { dek: dek, wrappedDek: b64u(sodium, combined) };
      });
    },

    unwrapDek: function (a) {
      return Promise.all([sodiumReady(), needKek(a.credentialId)]).then(function (r) {
        var sodium = r[0], kek = r[1];
        var combined = unb64u(sodium, a.wrappedDek);
        var nb = sodium.crypto_secretbox_NONCEBYTES;
        var dek = sodium.crypto_secretbox_open_easy(combined.slice(nb), combined.slice(0, nb), kek);
        if (!dek) throw fail("Error", "unwrapDek: authentication tag mismatch — wrong KEK or corrupted wrappedDek");
        return dek;
      });
    },

    encryptPayload: function (a) {
      return Promise.all([sodiumReady(), needKek(a.credentialId)]).then(function (r) {
        var sodium = r[0], kek = r[1];
        var json = typeof a.payload === "string" ? a.payload : JSON.stringify(a.payload);
        var nonce = sodium.randombytes_buf(sodium.crypto_secretbox_NONCEBYTES);
        var ct = sodium.crypto_secretbox_easy(sodium.from_string(json), nonce, kek);
        return { ciphertext: b64u(sodium, ct), nonce: b64u(sodium, nonce) };
      });
    },

    decryptPayload: function (a) {
      return Promise.all([sodiumReady(), needKek(a.credentialId)]).then(function (r) {
        var sodium = r[0], kek = r[1];
        var pt = sodium.crypto_secretbox_open_easy(unb64u(sodium, a.ciphertext), unb64u(sodium, a.nonce), kek);
        if (!pt) throw fail("Error", "Decryption failed: authentication tag mismatch");
        var obj = JSON.parse(sodium.to_string(pt));
        // The soft signing key is the one secret that used to be handed back to the
        // page. Keep it here as a non-extractable key and return a stub (the public
        // half plus a token) that Crypto.importPrivateKeyJwk / signJws route to signBytes.
        if (obj && obj.kty === "EC" && obj.crv === "P-256" && typeof obj.d === "string") {
          return crypto.subtle.importKey("jwk", obj, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]).then(function (key) {
            var token = a.credentialId + "|" + obj.x;
            signers[token] = key;
            return { __identityVaultSigner: true, token: token, credentialId: a.credentialId, kty: obj.kty, crv: obj.crv, x: obj.x, y: obj.y };
          });
        }
        return obj;
      });
    },

    // Raw ES256 signature (r||s) over `data`; the caller builds the JWS signing input.
    signBytes: function (a) {
      var key = typeof a.token === "string" && a.token.indexOf(a.credentialId + "|") === 0 ? signers[a.token] : null;
      if (!key) return Promise.reject(fail("NoSigner", "vault has no signing key for this token (decrypt the signing key again)"));
      return crypto.subtle.sign({ name: "ECDSA", hash: { name: "SHA-256" } }, key, a.data).then(function (sig) { return new Uint8Array(sig); });
    },

    openSealedBox: function (a) {
      return Promise.all([sodiumReady(), needX(a.credentialId)]).then(function (r) {
        var sodium = r[0], st = r[1];
        var out = sodium.crypto_box_seal_open(unb64u(sodium, a.wrapped), st.pub, st.priv);
        if (!out) throw fail("Error", "Failed to open sealed box: wrong key or corrupted data");
        return out;
      });
    },

    lock: function (a) {
      var ids = a && a.credentialId ? [a.credentialId] : Object.keys(mem);
      ids.forEach(function (id) {
        var st = mem[id]; if (st) { zero(st.kek); zero(st.priv); } delete mem[id];
        Object.keys(signers).forEach(function (t) { if (t.indexOf(id + "|") === 0) delete signers[t]; });
      });
      return Promise.resolve({ locked: ids.length });
    },

    // Sign-out / "Stay unlocked" turned off: forget everything, including the
    // device key, so blobs in every tab become unreadable.
    destroy: function () {
      Object.keys(mem).forEach(function (id) { var st = mem[id]; zero(st.kek); zero(st.priv); delete mem[id]; });
      signers = {};
      forgetAllPersisted();
      return openDb().then(function (db) { return tx(db, "readwrite", function (s) { return s["delete"](DEVICE_KEY); }); })
        .then(function () { return { destroyed: true }; }, function () { return { destroyed: true }; });
    },

    // Click fallback: if the browser refuses a ceremony that no gesture inside
    // this frame started, the app shows the frame and arms an op; the user
    // clicks the button and we run it with a real activation.
    arm: function (a, origin, id) {
      armed = { op: a.op, args: a.args || {}, origin: origin, id: id };
      var b = document.getElementById("unlock");
      if (b) b.style.display = "block";
      return Promise.resolve({ armed: true });
    },
  };

  // ─── message loop ──────────────────────────────────────────────────────────

  function reply(origin, id, ok, payload) {
    var msg = ok ? { id: id, ok: true, result: payload } : { id: id, ok: false, error: { name: payload && payload.name || "Error", message: String(payload && payload.message || payload).slice(0, 300) } };
    try { window.parent.postMessage(msg, origin); } catch (e) {}
  }

  window.addEventListener("message", function (ev) {
    if (ALLOWED.indexOf(ev.origin) === -1 || ev.source !== window.parent) return;
    var m = ev.data;
    if (!m || typeof m.op !== "string" || !Object.prototype.hasOwnProperty.call(OPS, m.op)) return;
    var run;
    try { run = Promise.resolve(OPS[m.op](m.args || {}, ev.origin, m.id)); } catch (e) { run = Promise.reject(e); }
    run.then(function (r) { reply(ev.origin, m.id, true, r); }, function (e) { reply(ev.origin, m.id, false, e); });
  });

  var btn = document.getElementById("unlock");
  if (btn) {
    btn.style.cssText = "display:none;width:100%;height:100%;font:600 15px system-ui,sans-serif;border:0;background:#7c3aed;color:#fff;cursor:pointer";
    btn.addEventListener("click", function () {
      if (!armed) return;
      var job = armed; armed = null; btn.style.display = "none";
      var op = OPS[job.op];
      Promise.resolve(op ? op(job.args, job.origin, job.id) : Promise.reject(fail("TypeError", "bad armed op")))
        .then(function (r) { reply(job.origin, job.id + ":armed", true, r); }, function (e) { reply(job.origin, job.id + ":armed", false, e); });
    });
  }
  document.documentElement.style.cssText = "margin:0;height:100%";
  document.body.style.cssText = "margin:0;height:100%;overflow:hidden";
})();
