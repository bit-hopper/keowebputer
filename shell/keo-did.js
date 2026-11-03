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
      var devOk = Array.isArray(st.devices) && st.devices.every(function (d) {
        return d && typeof d.id === 'string' && d.jwk && d.jwk.kty === 'EC' && d.jwk.crv === 'P-256' && typeof d.jwk.x === 'string' && typeof d.jwk.y === 'string' && d.jwk.d === undefined;
      });
      if (!devOk) return Promise.resolve(fail('state.devices is malformed'));
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
          return verifyAssertion(a, k.jwk, H, 'webauthn.get');
        });
        return Promise.all(checks).then(function (rs) {
          var good = rs.filter(Boolean).length;
          if (good < auth.threshold) return fail('only ' + good + ' of ' + auth.threshold + ' required authority signatures verify');
          return { ok: true, did: didFor(disc.key, b64u(H)) };
        });
      });
    });
  }

  return {
    b64u: b64u, unb64u: unb64u, z32encode: z32encode, z32decode: z32decode,
    canonicalJson: canonicalJson, sha256: sha256, eventHash: eventHash,
    didFor: didFor, parseDid: parseDid,
    discoverySeed: discoverySeed, ed25519FromSeed: ed25519FromSeed,
    derToRaw: derToRaw, verifyAssertion: verifyAssertion, verifyInception: verifyInception
  };
});
