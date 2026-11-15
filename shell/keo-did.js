// keo DID and inception event. Pure functions over WebCrypto: no storage, no WebAuthn, no DOM.
//
// Loaded as a plain script in the shell page (window.keoDid) and require()d from Node tests (module.exports). Node 20+ and
// current browsers all have Ed25519 in WebCrypto; nothing here needs a library.
//
// What lives here, and why it is separate from keo-identity.js (which does the ceremonies and the storage):
//   - the DID string  did:keo:<z32 discovery public key>:<b64url SHA-256 of the canonical inception>   (7.3)
//   - the inception event hash H(e): SHA-256 of canonicalJson(e without "sigs")                         (7.4)
//   - the discovery key derivation: Ed25519 seed = HMAC-SHA-256(accountSecret, "keo/discovery/v1" || 0x01) (7.2)
//   - verifyInception: a verifier that needs nothing but the event and its signatures (no server, no DNS, no lookup),
//     which is the property the whole identity scheme is for. It is what the tests use to check what the shell produced.
// canonicalJson is the repo's own (core/servers/identity/CryptoVerify.js), copied here because this file must run in a
// browser extension page that has no module system; the two must stay byte-identical.
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api; else root.keoDid = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var subtle = globalThis.crypto && globalThis.crypto.subtle;
  var enc = new TextEncoder();

  // ---- encodings ------------------------------------------------------------------------------------------------
  function bytesOf(b) { return b instanceof Uint8Array ? b : new Uint8Array(b.buffer ? b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) : b); }

  function b64u(buf) {
    var u = bytesOf(buf), s = '';
    for (var i = 0; i < u.length; i++) s += String.fromCharCode(u[i]);
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  function unb64u(s) {
    var t = String(s).replace(/-/g, '+').replace(/_/g, '/');
    while (t.length % 4) t += '=';
    var bin = atob(t), out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  // z-base-32 (the alphabet pkarr names use). 32 bytes -> 52 characters (the last one carries 1 bit, padded with zeros).
  var Z32 = 'ybndrfg8ejkmcpqxot1uwisza345h769';
  function z32encode(buf) {
    var u = bytesOf(buf), out = '', acc = 0, bits = 0;
    for (var i = 0; i < u.length; i++) {
      acc = (acc << 8) | u[i]; bits += 8;
      while (bits >= 5) { out += Z32[(acc >> (bits - 5)) & 31]; bits -= 5; }
      acc &= (1 << bits) - 1;
    }
    if (bits > 0) out += Z32[(acc << (5 - bits)) & 31];
    return out;
  }
  function z32decode(str) {
    var out = [], acc = 0, bits = 0;
    for (var i = 0; i < str.length; i++) {
      var v = Z32.indexOf(str[i]);
      if (v < 0) throw new Error('keoDid: not z-base-32');
      acc = (acc << 5) | v; bits += 5;
      if (bits >= 8) { out.push((acc >> (bits - 8)) & 255); bits -= 8; acc &= (1 << bits) - 1; }
    }
    return new Uint8Array(out);
  }

  // ---- canonical form and hashing (7.4) -------------------------------------------------------------------------
  function canonicalJson(obj) {
    if (obj === null || typeof obj !== 'object') return JSON.stringify(obj);
    if (Array.isArray(obj)) {
      return '[' + obj.map(function (item) { return item === undefined ? 'null' : canonicalJson(item); }).join(',') + ']';
    }
    var keys = Object.keys(obj).filter(function (k) { return obj[k] !== undefined; }).sort();
    return '{' + keys.map(function (k) { return JSON.stringify(k) + ':' + canonicalJson(obj[k]); }).join(',') + '}';
  }
  function sha256(bytes) { return subtle.digest('SHA-256', bytes).then(function (d) { return new Uint8Array(d); }); }

  // H(e): the signatures are left out so that neither the DID nor any later "prev" link depends on non-deterministic
  // ECDSA output. Resolves to the 32 raw bytes.
  function eventHash(event) {
    var copy = {};
    Object.keys(event).forEach(function (k) { if (k !== 'sigs') copy[k] = event[k]; });
    return sha256(enc.encode(canonicalJson(copy)));
  }

  // ---- the DID (7.3) ---------------------------------------------------------------------------------------------
  var DID_RE = /^did:keo:([ybndrfg8ejkmcpqxot1uwisza345h769]{52}):([A-Za-z0-9_-]{43})$/;
  function didFor(discoveryKeyZ32, hashB64u) { return 'did:keo:' + discoveryKeyZ32 + ':' + hashB64u; }
  // -> { dk, h } or null. dk is only a HINT (7.8): the caller must still check it against the inception.
  function parseDid(did) { var m = DID_RE.exec(String(did)); return m ? { dk: m[1], h: m[2] } : null; }

  // ---- discovery key (7.2) ---------------------------------------------------------------------------------------
  // HKDF-Expand with one output block: T(1) = HMAC(PRK, info || 0x01). PRK is the account secret (an HMAC CryptoKey with
  // 'sign' usage). Resolves to 32 bytes. The label carries a version so a later rotation derives a different key.
  function discoverySeed(accountSecretKey, version) {
    var info = enc.encode('keo/discovery/v' + (version || 1));
    var input = new Uint8Array(info.length + 1); input.set(info); input[info.length] = 1;
    return subtle.sign('HMAC', accountSecretKey, input).then(function (s) { return new Uint8Array(s); });
  }
  // PKCS#8 wrapper for a raw 32-byte Ed25519 seed (RFC 8410): fixed 16-byte prefix. WebCrypto cannot import a bare seed
  // and cannot derive the public half from a private key, so the public key is read from a JWK export of a throwaway,
  // extractable import, and the key that is kept is imported again as non-extractable.
  var ED25519_PKCS8_PREFIX = new Uint8Array([0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20]);
  function ed25519FromSeed(seed) {
    if (seed.length !== 32) return Promise.reject(new Error('keoDid: an Ed25519 seed is 32 bytes'));
    var pk8 = new Uint8Array(48); pk8.set(ED25519_PKCS8_PREFIX); pk8.set(seed, 16);
    return subtle.importKey('pkcs8', pk8, { name: 'Ed25519' }, true, ['sign']).then(function (tmp) {
      return subtle.exportKey('jwk', tmp);
    }).then(function (jwk) {
      var pub = unb64u(jwk.x);
      return subtle.importKey('pkcs8', pk8, { name: 'Ed25519' }, false, ['sign']).then(function (priv) {
        return { privateKey: priv, publicBytes: pub, publicZ32: z32encode(pub) };
      });
    });
  }

  // ---- WebAuthn signatures ---------------------------------------------------------------------------------------
  // A WebAuthn ES256 signature is ASN.1 DER, WebCrypto verifies the raw r||s form.
  function derToRaw(der) {
    var u = bytesOf(der), p = 0;
    function len() { var l = u[p++]; if (l & 0x80) { var n = l & 0x7f; l = 0; while (n--) l = (l << 8) | u[p++]; } return l; }
    function int32() {
      if (u[p++] !== 0x02) throw new Error('keoDid: bad DER integer');
      var l = len(), v = u.slice(p, p + l); p += l;
      while (v.length > 32 && v[0] === 0) v = v.slice(1);
      if (v.length > 32) throw new Error('keoDid: DER integer too long');
      var out = new Uint8Array(32); out.set(v, 32 - v.length); return out;
    }
    if (u[p++] !== 0x30) throw new Error('keoDid: bad DER sequence');
    len();
    var r = int32(), s = int32(), raw = new Uint8Array(64); raw.set(r); raw.set(s, 32);
    return raw;
  }

  // Verify one assertion {keyId, authenticatorData, clientDataJSON, signature} (all base64url) whose challenge must be the
  // base64url of `expectedChallengeBytes`, against the authority key `jwk`. rpIdHash and origin are NOT checked: they are
  // only signed bytes, which is what lets the DID outlive the domain it was created on (7.4).
  function verifyAssertion(sig, jwk, expectedChallengeBytes, expectedType) {
    var clientDataBytes = unb64u(sig.clientDataJSON), clientData;
    try { clientData = JSON.parse(new TextDecoder().decode(clientDataBytes)); } catch (e) { return Promise.resolve(false); }
    if (clientData.type !== (expectedType || 'webauthn.get')) return Promise.resolve(false);
    if (clientData.challenge !== b64u(expectedChallengeBytes)) return Promise.resolve(false);
    return sha256(clientDataBytes).then(function (cdHash) {
      var ad = unb64u(sig.authenticatorData), input = new Uint8Array(ad.length + 32); input.set(ad); input.set(cdHash, ad.length);
      return subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']).then(function (key) {
        return subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, derToRaw(unb64u(sig.signature)), input);
      });
    }).catch(function () { return false; });
  }

  // ---- the phone's signature scheme ------------------------------------------------------------------------------
  // A phone is not a WebAuthn authenticator: its app signs with a key in the phone's secure hardware and nothing else is wrapped
  // around the signature. So that a signature made for one job can never be replayed for another, what is signed is NOT the bare
  // hash but
  //     utf8("keo/authority/v1") || 0x00 || utf8(purpose) || 0x00 || H
  // where H is the 32-byte hash the log or certificate defines (the same H a passkey would have as its challenge) and `purpose` is
  // one of PURPOSES below. Neither label can contain 0x00, so the three parts cannot slide into one another. The signature itself
  // is the 64 bytes r||s (WebCrypto's form; an app that gets DER from its platform converts it). Exactly 64 bytes is required, so
  // that a DER blob is never mistaken for a raw one.
  //
  //   sig = { keyId, scheme: 'p256-raw', signature: b64u(r||s) }
  //
  // This is what a phone-app implementer must reproduce byte for byte; rawMessage below and the phone tests in tests/keo-did-test.js are the reference.
  var RAW_SCHEME = 'p256-raw';
  var PURPOSES = ['inception', 'add-authority', 'add-device', 'session', 'remove-authority', 'remove-device'];
  var KEY_KINDS = ['platform', 'security-key', 'phone'];
  function rawMessage(purpose, hashBytes) {
    var label = enc.encode('keo/authority/v1'), p = enc.encode(purpose), h = bytesOf(hashBytes);
    var out = new Uint8Array(label.length + 1 + p.length + 1 + h.length), o = 0;
    out.set(label, o); o += label.length; out[o++] = 0; out.set(p, o); o += p.length; out[o++] = 0; out.set(h, o);
    return out;
  }
  function verifyRaw(sig, jwk, hashBytes, purpose) {
    if (PURPOSES.indexOf(purpose) < 0 || typeof sig.signature !== 'string') return Promise.resolve(false);
    var raw;
    try { raw = unb64u(sig.signature); } catch (e) { return Promise.resolve(false); }
    if (raw.length !== 64) return Promise.resolve(false);
    return subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']).then(function (key) {
      return subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, raw, rawMessage(purpose, hashBytes));
    }).catch(function () { return false; });
  }

  // The one place a signature by an authority key is checked, whatever the key is. `key` is the log's key entry { id, jwk, kind }:
  // its kind decides the scheme, so a phone key can only ever be satisfied by a raw signature and a passkey only by an assertion
  // (a signature in the other form is refused, not tried). `purpose` is used by the raw scheme only; a passkey's challenge is H.
  function verifySignature(sig, key, hashBytes, purpose) {
    if (!sig || typeof sig !== 'object' || !key) return Promise.resolve(false);
    var phone = key.kind === 'phone';
    if (phone !== (sig.scheme === RAW_SCHEME)) return Promise.resolve(false);
    return phone ? verifyRaw(sig, key.jwk, hashBytes, purpose) : verifyAssertion(sig, key.jwk, hashBytes, 'webauthn.get');
  }

  // A key entry as a log may carry it. `kind` is optional for logs made before phones existed, but when present it must be known.
  function keyEntryError(key) {
    if (!key || typeof key.id !== 'string' || !isPublicEcJwk(key.jwk)) return 'malformed key';
    if (key.kind !== undefined && KEY_KINDS.indexOf(key.kind) < 0) return 'unknown key kind';
    return null;
  }

  // A P-256 public key as a JWK, with no private member: the only kind a log may carry (authority keys and device keys).
  function isPublicEcJwk(j) {
    return !!j && j.kty === 'EC' && j.crv === 'P-256' && typeof j.x === 'string' && typeof j.y === 'string' && j.d === undefined;
  }

  // ---- verifying an inception (7.5, 7.8 steps 3) -----------------------------------------------------------------
  // `rec` is { inception, sigs: { discovery: b64u, authority: [ assertion... ] } }. Resolves to { ok, did, error? }.
  // Needs no network: it checks that the event is well formed, that the discovery key proves possession, and that at
  // least `authority.threshold` distinct listed authority keys signed H(e). The DID it returns is the one the event
  // defines; a caller that was GIVEN a DID must compare it (and its key hint) to this result.
  function verifyInception(rec) {
    var e = rec && rec.inception, sigs = rec && rec.sigs;
    function fail(msg) { return { ok: false, error: msg }; }
    if (!e || !sigs) return Promise.resolve(fail('missing inception or sigs'));
    if (e.v !== 1 || e.type !== 'inception' || e.seq !== 0 || e.prev !== null) return Promise.resolve(fail('not an inception event'));
    var st = e.state, disc = st && st.discovery, auth = st && st.authority;
    if (!disc || typeof disc.key !== 'string' || !auth || !Array.isArray(auth.keys) || typeof auth.threshold !== 'number' || auth.threshold < 1) {
      return Promise.resolve(fail('state is missing discovery or authority'));
    }
    // devices is optional (a log may delegate no device in its inception); when present it must be well formed: each entry names an
    // ECDSA P-256 public key, because a session's certificate is checked against this list.
    if (st.devices !== undefined) {
      var devOk = Array.isArray(st.devices) && st.devices.every(function (d) { return d && typeof d.id === 'string' && isPublicEcJwk(d.jwk); });
      if (!devOk) return Promise.resolve(fail('state.devices is malformed'));
    }
    if (auth.keys.some(keyEntryError)) return Promise.resolve(fail('state.authority has a malformed key'));
    // revoked is the list of key ids that may never be added (verifyLog fills it as keys are removed), so it must be a list of ids
    if (st.revoked !== undefined && !(Array.isArray(st.revoked) && st.revoked.every(function (id) { return typeof id === 'string'; }))) {
      return Promise.resolve(fail('state.revoked is malformed'));
    }
    var dkBytes;
    try { dkBytes = z32decode(disc.key); } catch (err) { return Promise.resolve(fail('discovery key is not z-base-32')); }
    if (dkBytes.length !== 32 || z32encode(dkBytes) !== disc.key) return Promise.resolve(fail('discovery key is not 32 bytes'));
    return eventHash(e).then(function (H) {
      return subtle.importKey('raw', dkBytes, { name: 'Ed25519' }, false, ['verify']).then(function (dk) {
        return subtle.verify({ name: 'Ed25519' }, dk, unb64u(sigs.discovery || ''), H);
      }).catch(function () { return false; }).then(function (discOk) {
        if (!discOk) return fail('discovery key possession signature does not verify');
        var seen = {}, checks = (sigs.authority || []).map(function (a) {
          var k = auth.keys.filter(function (x) { return x.id === a.keyId; })[0];
          if (!k || seen[a.keyId]) return Promise.resolve(false);
          seen[a.keyId] = true;
          return verifySignature(a, k, H, 'inception');
        });
        return Promise.all(checks).then(function (rs) {
          var good = rs.filter(Boolean).length;
          if (good < auth.threshold) return fail('only ' + good + ' of ' + auth.threshold + ' required authority signatures verify');
          return { ok: true, did: didFor(disc.key, b64u(H)) };
        });
      });
    });
  }

  // ---- the log after the inception: adding an authority key on another origin -------------------------------------
  // A passkey is bound to the origin it was made on and cannot move. What moves is the identity: a second passkey, made on
  // another origin (the desktop app, a new extension id), is added to the same DID by an event that the identity's EXISTING
  // authority keys sign (as many as the current threshold) and that the NEW key signs too, so a log can never list a key
  // nobody holds. Both sign H(e) as a WebAuthn assertion, exactly as the inception does, and neither rpId nor origin is
  // checked (see verifyAssertion), so the DID does not depend on where any one key lives.
  //
  //   { v: 1, type: 'add-authority', seq: n, prev: b64u(H(event n-1)), time,
  //     add: { key: { id, jwk, rpId, kind, addedAt }, device: { id, jwk, addedAt } } }       (device is optional)
  //   sigs: { authority: [ { keyId, ...assertion } ], newKey: { keyId, ...assertion } }
  //
  // The chain is linear: seq must follow the last event and prev must be its hash. Two devices that each extend the same
  // event produce a fork, which this verifier does not accept (the second one fails on seq/prev); resolving forks is the
  // sync layer's job, not this file's.
  //
  // `prevEvent` is the event to extend (the inception, or the last event of the log). Returns the unsigned event.
  function addAuthorityEvent(prevEvent, key, device, time) {
    return eventHash(prevEvent).then(function (h) {
      var add = { key: key };
      if (device) add.device = device;
      return { v: 1, type: 'add-authority', seq: prevEvent.seq + 1, prev: b64u(h), time: time || new Date().toISOString(), add: add };
    });
  }

  // A device key delegated by the authority that already exists, with no new authority key: one phone key serves many computers,
  // and linking another computer to a phone-held identity must not mint a second phone key. Signed like add-authority, minus the
  // new key's own signature (there is none):
  //   { v: 1, type: 'add-device', seq: n, prev, time, add: { device: { id, jwk, addedAt } } }
  //   sigs: { authority: [ { keyId, ...signature } ] }
  function addDeviceEvent(prevEvent, device, time) {
    return eventHash(prevEvent).then(function (h) {
      return { v: 1, type: 'add-device', seq: prevEvent.seq + 1, prev: b64u(h), time: time || new Date().toISOString(), add: { device: device } };
    });
  }

  // ---- the log after the inception: removing a key or a device ---------------------------------------------------
  // The two events that end what the add events began. Signed like the add events, by as many EXISTING authority keys as the
  // current threshold, with one difference: the key being removed is not one of the signers (it does not count, so a key can never
  // vote for its own removal). Both sign H(e) as an assertion, or as a raw message for a phone key with the purpose set to the type.
  //
  //   { v: 1, type: 'remove-authority', seq: n, prev, time, remove: { keyId, deviceId? } }   deviceId: the device that belongs to that key,
  //                                                                                           removed in the same event (one approval, not two)
  //   { v: 1, type: 'remove-device',    seq: n, prev, time, remove: { deviceId } }
  //   sigs: { authority: [ { keyId, ...signature } ] }
  //
  // What the verifier enforces (and verifyLog's tests pin down): the thing removed must be listed exactly once; the last authority key,
  // and any removal that would leave fewer keys than the threshold, are refused (an identity must stay able to sign); a removed key or
  // device is never listed again, whether it comes back under its old id or a new id with the same public key; a removed key's later
  // signatures count for nothing; `remove` carries exactly the members named above and the event carries no `add`.
  // What it does NOT do: a verifier shown only an older, shorter log still sees the removed key in it. Pinning the longest log seen for
  // an identity is the caller's job (design note, D-2), as is deciding between two logs that fork.
  function removeAuthorityEvent(prevEvent, keyId, deviceId, time) {
    return eventHash(prevEvent).then(function (h) {
      var remove = { keyId: keyId };
      if (deviceId) remove.deviceId = deviceId;
      return { v: 1, type: 'remove-authority', seq: prevEvent.seq + 1, prev: b64u(h), time: time || new Date().toISOString(), remove: remove };
    });
  }
  function removeDeviceEvent(prevEvent, deviceId, time) {
    return eventHash(prevEvent).then(function (h) {
      return { v: 1, type: 'remove-device', seq: prevEvent.seq + 1, prev: b64u(h), time: time || new Date().toISOString(), remove: { deviceId: deviceId } };
    });
  }

  // The authority keys after every event, WITHOUT checking anything (no signature, no chain): for showing a person how many keys an
  // identity lists. Whatever decides a signature goes through verifyLog, which does check.
  function listedKeys(log) {
    var keys = ((log && log.inception && log.inception.state && log.inception.state.authority && log.inception.state.authority.keys) || []).slice();
    ((log && log.events) || []).forEach(function (x) {
      var e = x && x.event;
      if (!e) return;
      if (e.type === 'add-authority' && e.add && e.add.key) keys.push(e.add.key);
      if (e.type === 'remove-authority' && e.remove) keys = keys.filter(function (k) { return k.id !== e.remove.keyId; });
    });
    return keys;
  }

  var EVENT_TYPES = ['add-authority', 'add-device', 'remove-authority', 'remove-device'];
  // Two P-256 public keys are the same key when x and y are (kty and crv are fixed by isPublicEcJwk).
  function sameKey(a, b) { return !!a && !!b && a.x === b.x && a.y === b.y; }

  // `log` is { inception, sigs, events: [ { event, sigs } ] }. Verifies the inception, then each event in order, and
  // resolves to { ok, did, state, error?, failedAt? } where `state` is the authority and device lists after the last event
  // (the inception's `state` with the additions folded in and the removals taken out). `state.revoked` lists the ids of the keys
  // that were removed and `state.revokedDevices` the { id, jwk } of the devices that were, so a caller can refuse a certificate for a
  // device the log has since removed. A caller that was GIVEN a DID passes it as `expectDid`.
  async function verifyLog(log, expectDid) {
    function fail(msg, at) { return { ok: false, error: msg, failedAt: at }; }
    var inc = await verifyInception(log);
    if (!inc.ok) return fail(inc.error, 0);
    if (expectDid && inc.did !== expectDid) return fail('the log is for ' + inc.did + ', not ' + expectDid, 0);
    var st = JSON.parse(JSON.stringify(log.inception.state));
    st.devices = st.devices || [];
    st.revoked = st.revoked || [];
    st.revokedDevices = [];
    var goneKeys = [];                // { id, jwk } of every key removed so far: a key may not come back under a new id
    var last = log.inception, lastSeq = 0, events = log.events || [];
    if (!Array.isArray(events)) return fail('events is not a list', 1);
    for (var i = 0; i < events.length; i++) {
      var e = events[i] && events[i].event, sigs = events[i] && events[i].sigs, at = i + 1;
      if (!e || !sigs) return fail('event ' + at + ' has no signatures', at);
      if (e.v !== 1 || EVENT_TYPES.indexOf(e.type) < 0) return fail('event ' + at + ' is not a known event', at);
      if (e.seq !== lastSeq + 1) return fail('event ' + at + ' does not follow the last event (seq)', at);
      var lastHash = b64u(await eventHash(last));
      if (e.prev !== lastHash) return fail('event ' + at + ' does not point at the last event (prev)', at);
      var addAuth = e.type === 'add-authority', removeAuth = e.type === 'remove-authority', removing = removeAuth || e.type === 'remove-device';
      // (set explicitly: a bare `var dev` would keep the value of the previous event, and a removal would push that device again)
      var key = null, dev = undefined, goneKey = null, goneDev = null;
      if (removing) {
        var rm = e.remove, allowed = removeAuth ? ['keyId', 'deviceId'] : ['deviceId'];
        if (e.add !== undefined) return fail('event ' + at + ' removes and adds in one event', at);
        if (!rm || typeof rm !== 'object' || Array.isArray(rm) || Object.keys(rm).some(function (m) { return allowed.indexOf(m) < 0; })) return fail('event ' + at + ' does not say what it removes', at);
        if (removeAuth) {
          var ks = typeof rm.keyId === 'string' ? st.authority.keys.filter(function (k) { return k.id === rm.keyId; }) : [];
          if (ks.length !== 1) return fail('event ' + at + ' removes a key the identity does not list exactly once', at);
          goneKey = ks[0];
          var left = st.authority.keys.length - 1;
          if (left < 1) return fail('event ' + at + ' removes the identity\'s last authority key', at);
          if (left < st.authority.threshold) return fail('event ' + at + ' would leave ' + left + ' authority keys, and ' + st.authority.threshold + ' are needed to sign', at);
        }
        if (!removeAuth || rm.deviceId !== undefined) {
          var ds = typeof rm.deviceId === 'string' ? st.devices.filter(function (d) { return d.id === rm.deviceId; }) : [];
          if (ds.length !== 1) return fail('event ' + at + ' removes a device the identity does not list exactly once', at);
          goneDev = ds[0];
        }
      } else {
        key = addAuth ? e.add && e.add.key : null; dev = e.add && e.add.device;
        if (addAuth) {
          if (keyEntryError(key)) return fail('event ' + at + ' adds a malformed key', at);
          if (st.authority.keys.some(function (k) { return k.id === key.id; }) || st.revoked.indexOf(key.id) >= 0) return fail('event ' + at + ' adds a key the identity already has or revoked', at);
          if (goneKeys.some(function (g) { return sameKey(g.jwk, key.jwk); })) return fail('event ' + at + ' adds a key the identity removed', at);
        } else if (!dev) return fail('event ' + at + ' adds no device', at);
        if (dev !== undefined && (!dev || typeof dev.id !== 'string' || !isPublicEcJwk(dev.jwk))) return fail('event ' + at + ' adds a malformed device', at);
        if (dev && st.devices.some(function (d) { return d.id === dev.id; })) return fail('event ' + at + ' adds a device the identity already has', at);
        if (dev && st.revokedDevices.some(function (d) { return d.id === dev.id || sameKey(d.jwk, dev.jwk); })) return fail('event ' + at + ' adds a device the identity removed', at);
      }
      var H = await eventHash(e);
      // the existing keys: distinct, each listed before this event, as many as the threshold; the key being removed does not count
      var seen = {}, good = 0, list = sigs.authority || [];
      for (var j = 0; j < list.length; j++) {
        var a = list[j], k = st.authority.keys.filter(function (x) { return x.id === (a && a.keyId) && x !== goneKey; })[0];
        if (!k || seen[a.keyId]) continue;
        seen[a.keyId] = true;
        if (await verifySignature(a, k, H, e.type)) good++;
      }
      if (good < st.authority.threshold) return fail('event ' + at + ': only ' + good + ' of ' + st.authority.threshold + ' required authority signatures verify', at);
      if (addAuth) {
        // the new key must prove it is held by whoever is adding it
        var nk = sigs.newKey;
        if (!nk || nk.keyId !== key.id || !(await verifySignature(nk, key, H, e.type))) return fail('event ' + at + ': the new key did not sign', at);
        st.authority.keys.push(key);
      }
      if (dev) st.devices.push(dev);
      if (goneKey) {
        st.authority.keys = st.authority.keys.filter(function (x) { return x !== goneKey; });
        st.revoked.push(goneKey.id);
        goneKeys.push({ id: goneKey.id, jwk: goneKey.jwk });
      }
      if (goneDev) {
        st.devices = st.devices.filter(function (x) { return x !== goneDev; });
        st.revokedDevices.push({ id: goneDev.id, jwk: goneDev.jwk });
      }
      last = e; lastSeq = e.seq;
    }
    return { ok: true, did: inc.did, state: st, seq: lastSeq };
  }

  return {
    addAuthorityEvent: addAuthorityEvent, addDeviceEvent: addDeviceEvent, removeAuthorityEvent: removeAuthorityEvent, removeDeviceEvent: removeDeviceEvent,
    verifyLog: verifyLog, listedKeys: listedKeys, isPublicEcJwk: isPublicEcJwk,
    verifySignature: verifySignature, rawMessage: rawMessage, RAW_SCHEME: RAW_SCHEME, PURPOSES: PURPOSES, KEY_KINDS: KEY_KINDS,
    b64u: b64u, unb64u: unb64u, z32encode: z32encode, z32decode: z32decode,
    canonicalJson: canonicalJson, sha256: sha256, eventHash: eventHash,
    didFor: didFor, parseDid: parseDid,
    discoverySeed: discoverySeed, ed25519FromSeed: ed25519FromSeed,
    derToRaw: derToRaw, verifyAssertion: verifyAssertion, verifyInception: verifyInception
  };
});
