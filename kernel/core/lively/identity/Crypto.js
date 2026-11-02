/**
 * lively.identity.Crypto
 *
 * Pure cryptographic utilities for the Lively identity system.
 * No Lively UI deps, no WebAuthn — fully testable in isolation.
 *
 * Responsibilities:
 *   - base64url encode/decode and canonical JSON serialization
 *   - ES256 (ECDSA P-256) key generation, import/export, sign, verify (Web Crypto API)
 *   - JWS Compact Serialization (sign + verify)
 *   - Object envelope signing and verification
 *   - ObjID computation (SHA-256 of canonical JWK, first 12 chars base64url)
 *   - CID computation (BLAKE2b-256 via libsodium crypto_generichash)
 *   - Symmetric encryption/decryption (XSalsa20-Poly1305 via libsodium crypto_secretbox_easy)
 *   - Chunked streaming symmetric encryption/decryption (XChaCha20-Poly1305
 *     via libsodium crypto_secretstream_xchacha20poly1305) for large files
 *     that can't be held fully in memory (Encryption.md's large-file scoping
 *     note) — a sibling of encryptBytes/decryptBytes, not a replacement;
 *     encryptBytes/decryptBytes stay the right tool for small payloads
 *     (envelope metadata) that are already fully in memory anyway.
 *   - ECDH sealed-box key wrapping (X25519 via libsodium crypto_box_seal)
 *
 * Async pattern: all async ops take a final `thenDo(err, result)` callback,
 * consistent with Lively's WebResource and lively.bindings signal patterns.
 *
 * libsodium dependency: withSodium() lazily injects
 * /core/lib/libsodium/sodium.js (built by scripts/build-libsodium.js, which
 * runs automatically via the postinstall npm script) the first time it's
 * needed, so callers don't need to load it themselves. The sodium global
 * exposes `sodium.ready` (a Promise), matching libsodium-wrappers' classic
 * API.
 */

module('lively.identity.Crypto')
  .requires()
  // Note: libsodium-wrappers is NOT a Lively module so it cannot appear in
  // .requires() — withSodium() injects it as a plain script on first use.
  .toRun(function() {

Object.subclass('lively.identity.Crypto',

// ─── base64url & canonical JSON ──────────────────────────────────────────────

'base64url', {

  base64urlEncode: function(buffer) {
    var bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
    var binary = '';
    for (var i = 0; i < bytes.length; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary)
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=/g, '');
  },

  base64urlDecode: function(str) {
    // Restore standard base64 padding
    var padded = str + '='.repeat((4 - (str.length % 4)) % 4);
    var binary = atob(padded.replace(/-/g, '+').replace(/_/g, '/'));
    var bytes = new Uint8Array(binary.length);
    for (var i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  },

  // Deterministic JSON serialization with recursively sorted keys (RFC 8785 spirit).
  // Used for signing so key ordering doesn't affect the digest regardless of engine.
  //
  // undefined handling must mirror real JSON.stringify exactly (omit an
  // undefined-valued object property entirely; emit `null` for an undefined
  // array element) — confirmed live as a real bug: this function used to
  // fall through to `JSON.stringify(k) + ':' + self.canonicalJson(obj[k])`
  // even when obj[k] === undefined, and the base case's `JSON.stringify(undefined)`
  // returns the actual JS `undefined` value (not a string), which string
  // concatenation then coerces to the literal text `undefined` — producing
  // syntactically invalid JSON (e.g. `{"pointerId":undefined}`) that the
  // server's decodeJwsPayload's JSON.parse rejects with "Unexpected token
  // 'u' ... is not valid JSON". Signing a whole serialized world's object
  // graph (SignedSerializer.js) only needs ONE stray undefined-valued
  // property anywhere in that huge tree to corrupt the entire signature —
  // e.g. Events.js's onMouseUpEntry does `evt.hand.pointerId = undefined`,
  // and a Hand's captured state can end up serialized as part of the world.
  canonicalJson: function(obj) {
    if (obj === null || typeof obj !== 'object') return JSON.stringify(obj);
    if (Array.isArray(obj)) {
      var self = this;
      return '[' + obj.map(function(item) {
        return item === undefined ? 'null' : self.canonicalJson(item);
      }).join(',') + ']';
    }
    var self = this;
    var keys = Object.keys(obj).filter(function(k) {
      return obj[k] !== undefined;
    }).sort();
    return '{' + keys.map(function(k) {
      return JSON.stringify(k) + ':' + self.canonicalJson(obj[k]);
    }).join(',') + '}';
  },

  // Canonical form of a JWK per RFC 7638 §3.2: only the required members for
  // the key type, lexicographically sorted. Extra fields (key_ops, ext, use,
  // alg, kid, d) are excluded so the thumbprint is stable regardless of what
  // crypto.subtle.exportKey returns.
  canonicalizeJwk: function(jwk) {
    var required;
    if (jwk.kty === 'EC') {
      required = { crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y };
    } else if (jwk.kty === 'OKP') {
      required = { crv: jwk.crv, kty: jwk.kty, x: jwk.x };
    } else {
      required = { kty: jwk.kty };
    }
    return this.canonicalJson(required);
  }

},

// ─── ECDSA P-256 key management ──────────────────────────────────────────────

'keys', {

  generateSigningKeyPair: function(thenDo) {
    crypto.subtle.generateKey(
      { name: 'ECDSA', namedCurve: 'P-256' },
      true,  // extractable so we can export JWK for storage
      ['sign', 'verify']
    ).then(function(keyPair) {
      thenDo(null, keyPair);
    }).catch(function(err) { thenDo(err); });
  },

  exportPublicKeyJwk: function(cryptoKey, thenDo) {
    crypto.subtle.exportKey('jwk', cryptoKey)
      .then(function(jwk) { thenDo(null, jwk); })
      .catch(function(err) { thenDo(err); });
  },

  exportPrivateKeyJwk: function(cryptoKey, thenDo) {
    crypto.subtle.exportKey('jwk', cryptoKey)
      .then(function(jwk) { thenDo(null, jwk); })
      .catch(function(err) { thenDo(err); });
  },

  importPublicKeyJwk: function(jwk, thenDo) {
    crypto.subtle.importKey(
      'jwk',
      jwk,
      { name: 'ECDSA', namedCurve: 'P-256' },
      true,
      ['verify']
    ).then(function(key) { thenDo(null, key); })
    .catch(function(err) { thenDo(err); });
  },

  importPrivateKeyJwk: function(jwk, thenDo) {
    // Identity vault: the "key" is a signer stub; the private key stays in the vault.
    var vault = lively.identity.identityVault;
    if (vault && vault.isSigner(jwk)) return thenDo(null, jwk);
    crypto.subtle.importKey(
      'jwk',
      jwk,
      { name: 'ECDSA', namedCurve: 'P-256' },
      true,
      ['sign']
    ).then(function(key) { thenDo(null, key); })
    .catch(function(err) { thenDo(err); });
  },

  // Convert a DER-encoded ECDSA signature (ASN.1 SEQUENCE of two INTEGERs
  // r, s — the format a real WebAuthn assertion signature comes in, per the
  // WebAuthn/CTAP2 spec) to the raw r||s format crypto.subtle.verify
  // requires for ECDSA (Web Crypto always uses raw IEEE P1363, never DER).
  // P-256 only (32-byte r/s, 64-byte output). Throws on malformed input.
  derToRawEcdsaSignature: function(derBytes) {
    var bytes = derBytes instanceof Uint8Array ? derBytes : new Uint8Array(derBytes);
    if (bytes[0] !== 0x30) throw new Error('derToRawEcdsaSignature: not a DER SEQUENCE');
    // P-256 signatures are always short enough for single-byte DER lengths
    // (content length <= ~70 bytes, well under the 0x80 long-form threshold).
    var offset = 2;
    if (bytes[offset] !== 0x02) throw new Error('derToRawEcdsaSignature: expected INTEGER (r)');
    var rLen = bytes[offset + 1];
    var rStart = offset + 2;
    var rBytes = bytes.slice(rStart, rStart + rLen);
    offset = rStart + rLen;
    if (bytes[offset] !== 0x02) throw new Error('derToRawEcdsaSignature: expected INTEGER (s)');
    var sLen = bytes[offset + 1];
    var sStart = offset + 2;
    var sBytes = bytes.slice(sStart, sStart + sLen);

    function toFixed32(intBytes) {
      // DER INTEGER is signed — a leading 0x00 pad byte is present whenever
      // the true value's high bit would otherwise look negative. Strip it,
      // then left-pad (with zeros) to the fixed 32-byte P-256 field width.
      var b = intBytes;
      if (b.length > 32 && b[0] === 0x00) b = b.slice(1);
      if (b.length > 32) throw new Error('derToRawEcdsaSignature: integer too long for P-256');
      var out = new Uint8Array(32);
      out.set(b, 32 - b.length);
      return out;
    }

    var raw = new Uint8Array(64);
    raw.set(toFixed32(rBytes), 0);
    raw.set(toFixed32(sBytes), 32);
    return raw;
  }

},

// ─── ObjID ───────────────────────────────────────────────────────────────────

'objId', {

  // ObjID = base64url(SHA-256(canonicalJwk))[0..12]
  // Used for the home manifest (backed by a held device key). All other objects
  // use computeGenesisObjId below.
  computeObjId: function(publicKeyJwk, thenDo) {
    var self = this;
    var canonical = this.canonicalizeJwk(publicKeyJwk);
    var encoded = new TextEncoder().encode(canonical);
    crypto.subtle.digest('SHA-256', encoded)
      .then(function(hash) {
        thenDo(null, self.base64urlEncode(new Uint8Array(hash)).slice(0, 12));
      })
      .catch(function(err) { thenDo(err); });
  },

  // objId = base64url(SHA-256(authorDid + ":" + base64url(genesisNonce)))[0..12]
  // Self-certifying: the genesis envelope proves it hashes to this objId;
  // every version chains via prevCid; every version is signed by its author.
  // No per-object private key exists.
  //
  // authorDid: String — the author's did:jwk string
  // genesisNonce: Uint8Array (16 bytes) — caller provides fresh random bytes
  // thenDo(null, objId) where objId is a 12-char base64url string.
  computeGenesisObjId: function(authorDid, genesisNonce, thenDo) {
    var self = this;
    var nonceB64 = self.base64urlEncode(genesisNonce);
    var input = new TextEncoder().encode(authorDid + ':' + nonceB64);
    crypto.subtle.digest('SHA-256', input)
      .then(function(hash) {
        thenDo(null, self.base64urlEncode(new Uint8Array(hash)).slice(0, 12));
      })
      .catch(function(err) { thenDo(err); });
  },

  // objId = base64url(SHA-256(authorDid + ':wallet-backup'))[0..12]
  // Deliberately NOT genesis-random (WalletSpec.md §7.2.1 revision): a fixed
  // per-identity slot so any device can recompute this exact objId from the
  // DID alone — no local pointer needed to find a previously-created wallet
  // backup, unlike every other object type here. Trades the object's
  // existence being probeable by anyone who knows the DID (a 403-vs-404
  // distinction on GET, never the ciphertext itself — access control is
  // unchanged) for eliminating the local-pointer single point of failure,
  // which is a deliberate, requested tradeoff for this one envelope type.
  computeWalletBackupObjId: function(authorDid, thenDo) {
    var self = this;
    var input = new TextEncoder().encode(authorDid + ':wallet-backup');
    crypto.subtle.digest('SHA-256', input)
      .then(function(hash) {
        thenDo(null, self.base64urlEncode(new Uint8Array(hash)).slice(0, 12));
      })
      .catch(function(err) { thenDo(err); });
  }

},

// ─── libsodium bridge ────────────────────────────────────────────────────────

'sodium', {

  // Ensures libsodium is loaded and initialized, then calls thenDo(null, sodium).
  // libsodium-wrappers exposes `window.sodium` with a `.ready` Promise. If it
  // isn't present yet in a browser context, lazily injects the bundled build
  // (see scripts/build-libsodium.js) the same way PostCardEditor._ensureRuntime
  // does for Yjs/ProseMirror — so callers don't each need their own loading logic.
  //
  // For Node.js testing, inject a sodium instance directly:
  //   lively.identity.crypto._sodium = require('libsodium-wrappers');
  withSodium: function(thenDo) {
    var self = this;
    var _sodium = this._sodium ||
                  (typeof window !== 'undefined' && window.sodium) ||
                  (typeof global !== 'undefined' && global.sodium) ||
                  (typeof sodium !== 'undefined' && sodium) ||
                  null;
    if (_sodium) {
      return _sodium.ready.then(function() { thenDo(null, _sodium); })
        .catch(function(err) { thenDo(err); });
    }

    if (typeof document === 'undefined') {
      return thenDo(new Error(
        'libsodium-wrappers not loaded and no document to inject it into ' +
        '(non-browser context) — set lively.identity.crypto._sodium directly.'
      ));
    }

    if (window._sodiumLoading) {
      var poll = setInterval(function () {
        if (window.sodium) { clearInterval(poll); self.withSodium(thenDo); }
      }, 50);
      return;
    }

    window._sodiumLoading = true;
    var s = document.createElement('script');
    s.src = '/core/lib/libsodium/sodium.js';
    s.onload = function () { window._sodiumLoading = false; self.withSodium(thenDo); };
    s.onerror = function () {
      window._sodiumLoading = false;
      thenDo(new Error('Failed to load /core/lib/libsodium/sodium.js'));
    };
    document.head.appendChild(s);
  }

},

// ─── hashing ─────────────────────────────────────────────────────────────────

'hashing', {

  // CID = base64url(SHA-256(canonicalJson(payload))). Must actually call
  // canonicalJson, not plain JSON.stringify -- this comment claimed
  // canonical form for a long time while the code below just did
  // JSON.stringify, which depends on object key insertion order. Postgres
  // jsonb storage does not preserve that order, so a payload round-tripped
  // through the server (saved, then GET'd back) hashed differently than it
  // did at save time even though nothing changed, producing false "content
  // tampered" verification failures and, worse, WikiEditor.js's
  // deserializeFromEnvelope treating that mismatch as fatal and refusing to
  // load the document at all. Confirmed live 2026-09-13 on wiki pages saved
  // in prior sessions. CryptoVerify.js's server-side port and
  // IdentityServer.js's computeCidSync must both stay byte-for-byte in sync
  // with this algorithm, since the server independently re-verifies
  // record.cid on every non-metadata-only PUT.
  // Uses Web Crypto API — no external dependency required.
  computeCid: function(payload, thenDo) {
    var self = this;
    try {
      var json = typeof payload === 'string' ? payload : self.canonicalJson(payload);
      self.sha256(json, thenDo);
    } catch (e) { thenDo(e); }
  },

  // SHA-256 via Web Crypto, returns base64url string.
  sha256: function(data, thenDo) {
    var self = this;
    var bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
    crypto.subtle.digest('SHA-256', bytes)
      .then(function(hash) {
        thenDo(null, self.base64urlEncode(new Uint8Array(hash)));
      })
      .catch(function(err) { thenDo(err); });
  }

},

// ─── JWS & envelope signing ──────────────────────────────────────────────────

'signing', {

  // Sign any JSON-serializable payload with ES256.
  // Returns a JWS Compact Serialization string: header.payload.signature
  // The payload is canonicalJson(payload) for objects, or the raw string if a string.
  signJws: function(payload, privateKey, thenDo) {
    var self = this;
    var header = { alg: 'ES256' };
    var headerB64 = self.base64urlEncode(new TextEncoder().encode(JSON.stringify(header)));
    var canonical = typeof payload === 'string' ? payload : self.canonicalJson(payload);
    var payloadB64 = self.base64urlEncode(new TextEncoder().encode(canonical));
    var signingInput = new TextEncoder().encode(headerB64 + '.' + payloadB64);

    // Identity vault: sign inside the vault with the key it holds for this stub.
    var vault = lively.identity.identityVault;
    if (vault && vault.isSigner(privateKey)) {
      return vault.signBytes(privateKey, signingInput, function(err, signature) {
        if (err) return thenDo(err);
        thenDo(null, headerB64 + '.' + payloadB64 + '.' + self.base64urlEncode(new Uint8Array(signature)));
      });
    }

    crypto.subtle.sign(
      { name: 'ECDSA', hash: { name: 'SHA-256' } },
      privateKey,
      signingInput
    ).then(function(signature) {
      thenDo(null, headerB64 + '.' + payloadB64 + '.' + self.base64urlEncode(new Uint8Array(signature)));
    }).catch(function(err) { thenDo(err); });
  },

  // Verify a JWS Compact string against a public key JWK.
  // Calls thenDo(null, true|false).
  verifyJws: function(jws, publicKeyJwk, thenDo) {
    var self = this;
    var parts = jws.split('.');
    if (parts.length !== 3) return thenDo(new Error('Invalid JWS compact: expected 3 parts'));

    var signingInput = new TextEncoder().encode(parts[0] + '.' + parts[1]);
    var signature = self.base64urlDecode(parts[2]);

    self.importPublicKeyJwk(publicKeyJwk, function(err, cryptoKey) {
      if (err) return thenDo(err);
      crypto.subtle.verify(
        { name: 'ECDSA', hash: { name: 'SHA-256' } },
        cryptoKey,
        signature,
        signingInput
      ).then(function(valid) { thenDo(null, valid); })
      .catch(function(err) { thenDo(err); });
    });
  },

  // IDENTITY: signEnvelope (as a WebAuthn-assertion-gated operation) is still
  // deferred. This is the display-only counterpart: given an envelope and the
  // signer's device public key (resolve via DID.resolveEnvelopeSignerJwk —
  // fetching that key requires a network call, kept out of this file per its
  // "no Lively UI deps, testable in isolation" contract), report whether the
  // envelope's content is intact and its signature (if any) checks out.
  // Calls thenDo(null, { cidValid, sigStatus }) where sigStatus is one of
  // 'verified' | 'invalid' | 'unsigned' | 'unresolved' (signerJwk missing).
  // Not a security gate — postcard-audit F20/F22's "not wired up yet" note
  // for PostCardEditor._resolveRecipientPubKeys still applies to encryption
  // sealing; this only drives a UI badge.
  verifyEnvelopeIntegrity: function(envelope, signerJwk, thenDo) {
    var self = this;
    self.computeCid(envelope.record.payload, function(cidErr, cid) {
      var cidValid = !cidErr && cid === envelope.record.cid;
      if (!envelope.sig) return thenDo(null, { cidValid: cidValid, sigStatus: 'unsigned' });
      if (!signerJwk) return thenDo(null, { cidValid: cidValid, sigStatus: 'unresolved' });

      var parts = envelope.sig.split('.');
      if (parts.length !== 3) return thenDo(null, { cidValid: cidValid, sigStatus: 'invalid' });

      // The JWS's own embedded payload must match the envelope-minus-sig —
      // minus `state` — exactly. verifyJws alone only proves the signature
      // is valid over whatever payload the JWS carries, not that it's still
      // THIS envelope's content (e.g. title changed after signing, cid
      // untouched), so that much still needs checking here. `state` is
      // excluded on both sides: ObjectRepository.js's put()/setSentAtIfUnset
      // legitimately rewrite state (sentAt freeze-stamp, recipient-add
      // reseal, mailbox hide, ...) in place, server-side, without
      // re-signing — by design, since record.cid only ever covered
      // record.payload, never state. Comparing state here would flag every
      // one of those legitimate updates as tampering.
      var envelopeSigned = Object.assign({}, envelope);
      delete envelopeSigned.sig;
      delete envelopeSigned.state;
      var expectedPayload = self.canonicalJson(envelopeSigned);
      var actualPayload;
      try {
        var actualObj = JSON.parse(new TextDecoder().decode(self.base64urlDecode(parts[1])));
        delete actualObj.state;
        actualPayload = self.canonicalJson(actualObj);
      } catch (e) {
        return thenDo(null, { cidValid: cidValid, sigStatus: 'invalid' });
      }
      if (actualPayload !== expectedPayload) {
        return thenDo(null, { cidValid: cidValid, sigStatus: 'invalid' });
      }

      self.verifyJws(envelope.sig, signerJwk, function(err, valid) {
        if (err) return thenDo(null, { cidValid: cidValid, sigStatus: 'invalid' });
        thenDo(null, { cidValid: cidValid, sigStatus: valid ? 'verified' : 'invalid' });
      });
    });
  },

},

// ─── symmetric encryption (XSalsa20-Poly1305) ────────────────────────────────

'encryption', {

  // Encrypt a JSON-serializable payload with a 32-byte symmetric key.
  // encKey: Uint8Array (32 bytes) or base64url string.
  // Returns thenDo(null, { ciphertext: <base64url>, nonce: <base64url> }).
  encryptPayload: function(payload, encKey, thenDo) {
    // Identity vault (Encryption.md §19.5): a handle stands in for the raw key,
    // which then never exists in this realm; the vault does the operation.
    var vault = lively.identity.identityVault;
    if (vault && vault.isHandle(encKey)) return vault.encryptPayload(payload, encKey, thenDo);
    this.withSodium(function(err, sodium) {
      if (err) return thenDo(err);
      try {
        var json = typeof payload === 'string' ? payload : JSON.stringify(payload);
        var message = sodium.from_string(json);
        var nonce = sodium.randombytes_buf(sodium.crypto_secretbox_NONCEBYTES);
        var keyBytes = encKey instanceof Uint8Array
          ? encKey
          : sodium.from_base64(encKey, sodium.base64_variants.URLSAFE_NO_PADDING);

        var ciphertext = sodium.crypto_secretbox_easy(message, nonce, keyBytes);
        thenDo(null, {
          ciphertext: sodium.to_base64(ciphertext, sodium.base64_variants.URLSAFE_NO_PADDING),
          nonce:      sodium.to_base64(nonce,       sodium.base64_variants.URLSAFE_NO_PADDING)
        });
      } catch (e) { thenDo(e); }
    });
  },

  // Generate a fresh random 32-byte DEK and wrap it under a KEK.
  // Returns thenDo(null, { dek: Uint8Array[32], wrappedDek: base64url }).
  // The wrappedDek is stored in the envelope; the dek is used for encryption
  // and then discarded. To recover the dek, call unwrapDek(wrappedDek, kek).
  wrapDek: function(kek, thenDo) {
    // Identity vault (Encryption.md §19.5): a handle stands in for the raw key,
    // which then never exists in this realm; the vault does the operation.
    var vault = lively.identity.identityVault;
    if (vault && vault.isHandle(kek)) return vault.wrapDek(kek, thenDo);
    this.withSodium(function(err, sodium) {
      if (err) return thenDo(err);
      try {
        var dek = sodium.randombytes_buf(32); // fresh random DEK
        var kekBytes = kek instanceof Uint8Array
          ? kek
          : sodium.from_base64(kek, sodium.base64_variants.URLSAFE_NO_PADDING);
        var nonce = sodium.randombytes_buf(sodium.crypto_secretbox_NONCEBYTES);
        var wrapped = sodium.crypto_secretbox_easy(dek, nonce, kekBytes);
        // Store nonce prepended to ciphertext so unwrapDek is self-contained
        var combined = new Uint8Array(nonce.length + wrapped.length);
        combined.set(nonce);
        combined.set(wrapped, nonce.length);
        thenDo(null, {
          dek: dek,
          wrappedDek: sodium.to_base64(combined, sodium.base64_variants.URLSAFE_NO_PADDING)
        });
      } catch (e) { thenDo(e); }
    });
  },

  // Unwrap a DEK that was wrapped by wrapDek.
  // wrappedDek: base64url string produced by wrapDek.
  // kek: Uint8Array or base64url string (32 bytes).
  // Returns thenDo(null, Uint8Array[32] dek).
  unwrapDek: function(wrappedDek, kek, thenDo) {
    // Identity vault (Encryption.md §19.5): a handle stands in for the raw key,
    // which then never exists in this realm; the vault does the operation.
    var vault = lively.identity.identityVault;
    if (vault && vault.isHandle(kek)) return vault.unwrapDek(wrappedDek, kek, thenDo);
    this.withSodium(function(err, sodium) {
      if (err) return thenDo(err);
      try {
        var combined = sodium.from_base64(wrappedDek, sodium.base64_variants.URLSAFE_NO_PADDING);
        var nonce = combined.slice(0, sodium.crypto_secretbox_NONCEBYTES);
        var ct = combined.slice(sodium.crypto_secretbox_NONCEBYTES);
        var kekBytes = kek instanceof Uint8Array
          ? kek
          : sodium.from_base64(kek, sodium.base64_variants.URLSAFE_NO_PADDING);
        var dek = sodium.crypto_secretbox_open_easy(ct, nonce, kekBytes);
        if (!dek) return thenDo(new Error('unwrapDek: authentication tag mismatch — wrong KEK or corrupted wrappedDek'));
        thenDo(null, dek);
      } catch (e) { thenDo(e); }
    });
  },

  // Encrypt raw bytes with a 32-byte symmetric key — sibling of encryptPayload
  // that skips the JSON-stringify step (§5.4 note in Encryption.md: don't
  // base64 file bytes through the JSON path, memory blowup on video).
  // bytes: Uint8Array. encKey: Uint8Array (32 bytes) or base64url string.
  // Returns thenDo(null, { ciphertext: <Uint8Array>, nonce: <base64url> }).
  encryptBytes: function(bytes, encKey, thenDo) {
    this.withSodium(function(err, sodium) {
      if (err) return thenDo(err);
      try {
        var nonce = sodium.randombytes_buf(sodium.crypto_secretbox_NONCEBYTES);
        var keyBytes = encKey instanceof Uint8Array
          ? encKey
          : sodium.from_base64(encKey, sodium.base64_variants.URLSAFE_NO_PADDING);

        var ciphertext = sodium.crypto_secretbox_easy(bytes, nonce, keyBytes);
        thenDo(null, {
          ciphertext: ciphertext,
          nonce: sodium.to_base64(nonce, sodium.base64_variants.URLSAFE_NO_PADDING)
        });
      } catch (e) { thenDo(e); }
    });
  },

  // Decrypt raw bytes produced by encryptBytes. Sibling of decryptPayload
  // that returns the raw plaintext Uint8Array instead of JSON.parse'ing it.
  // ciphertext, nonce: base64url strings or Uint8Arrays.
  // encKey: Uint8Array (32 bytes) or base64url string.
  // Calls thenDo(null, <Uint8Array plaintext>) on success.
  decryptBytes: function(ciphertext, nonce, encKey, thenDo) {
    this.withSodium(function(err, sodium) {
      if (err) return thenDo(err);
      try {
        var ctBytes = ciphertext instanceof Uint8Array
          ? ciphertext
          : sodium.from_base64(ciphertext, sodium.base64_variants.URLSAFE_NO_PADDING);
        var nonceBytes = nonce instanceof Uint8Array
          ? nonce
          : sodium.from_base64(nonce, sodium.base64_variants.URLSAFE_NO_PADDING);
        var keyBytes = encKey instanceof Uint8Array
          ? encKey
          : sodium.from_base64(encKey, sodium.base64_variants.URLSAFE_NO_PADDING);

        var plaintext = sodium.crypto_secretbox_open_easy(ctBytes, nonceBytes, keyBytes);
        if (!plaintext) return thenDo(new Error('decryptBytes: authentication tag mismatch'));

        thenDo(null, plaintext);
      } catch (e) { thenDo(e); }
    });
  },

  // Decrypt a ciphertext produced by encryptPayload.
  // ciphertext, nonce: base64url strings or Uint8Arrays.
  // encKey: Uint8Array (32 bytes) or base64url string.
  // Calls thenDo(null, parsedObject) on success.
  decryptPayload: function(ciphertext, nonce, encKey, thenDo) {
    // Identity vault (Encryption.md §19.5): a handle stands in for the raw key,
    // which then never exists in this realm; the vault does the operation.
    var vault = lively.identity.identityVault;
    if (vault && vault.isHandle(encKey)) return vault.decryptPayload(ciphertext, nonce, encKey, thenDo);
    this.withSodium(function(err, sodium) {
      if (err) return thenDo(err);
      try {
        var ctBytes = ciphertext instanceof Uint8Array
          ? ciphertext
          : sodium.from_base64(ciphertext, sodium.base64_variants.URLSAFE_NO_PADDING);
        var nonceBytes = nonce instanceof Uint8Array
          ? nonce
          : sodium.from_base64(nonce, sodium.base64_variants.URLSAFE_NO_PADDING);
        var keyBytes = encKey instanceof Uint8Array
          ? encKey
          : sodium.from_base64(encKey, sodium.base64_variants.URLSAFE_NO_PADDING);

        var plaintext = sodium.crypto_secretbox_open_easy(ctBytes, nonceBytes, keyBytes);
        if (!plaintext) return thenDo(new Error('Decryption failed: authentication tag mismatch'));

        thenDo(null, JSON.parse(sodium.to_string(plaintext)));
      } catch (e) { thenDo(e); }
    });
  }

},

// ─── chunked streaming symmetric encryption (XChaCha20-Poly1305) ────────────

// A `secretbox` call (encryptBytes/decryptBytes above) needs the whole
// plaintext resident in memory at once — fine for envelope metadata, not fine
// for a multi-GB file. crypto_secretstream instead keeps a small, opaque,
// per-stream `state` object so a file can be encrypted or decrypted one
// bounded-size chunk at a time. `state` is mutated in place by each push/pull
// call (matching libsodium-wrappers' own contract) and must never be
// serialized/persisted/reused across streams.
//
// Wire format for a chunked blob (FileCrypto.js is the caller that assembles
// this): [HEADERBYTES-byte header][chunk1 ciphertext]...[chunkN ciphertext].
// Each chunk's ciphertext is plaintext.length + streamAbytes() bytes longer
// than the plaintext. The LAST chunk must be pushed with isFinal=true — this
// is what lets a truncated/tampered stream be detected on decrypt, a
// property `secretbox`'s single-shot MAC already had implicitly and that
// chunking would otherwise silently lose.

'streamEncryption', {

  // The fixed header size in bytes (currently 24) — needed by callers to
  // know how many leading bytes of a chunked blob are the header rather than
  // ciphertext.
  streamHeaderBytes: function(thenDo) {
    this.withSodium(function(err, sodium) {
      if (err) return thenDo(err);
      thenDo(null, sodium.crypto_secretstream_xchacha20poly1305_HEADERBYTES);
    });
  },

  // The fixed per-chunk authentication overhead in bytes (currently 17) —
  // needed by callers sizing plaintext chunk buffers against a target
  // ciphertext chunk size, or vice versa.
  streamAbytes: function(thenDo) {
    this.withSodium(function(err, sodium) {
      if (err) return thenDo(err);
      thenDo(null, sodium.crypto_secretstream_xchacha20poly1305_ABYTES);
    });
  },

  // Begin an encryption stream. encKey: Uint8Array or base64url string.
  // Returns thenDo(null, { state, header: <Uint8Array, streamHeaderBytes() long> }).
  // `header` must travel with the ciphertext (this codebase prepends it to
  // the blob bytes) — streamInitPull needs it to begin decryption.
  streamInitPush: function(encKey, thenDo) {
    this.withSodium(function(err, sodium) {
      if (err) return thenDo(err);
      try {
        var keyBytes = encKey instanceof Uint8Array
          ? encKey
          : sodium.from_base64(encKey, sodium.base64_variants.URLSAFE_NO_PADDING);
        var res = sodium.crypto_secretstream_xchacha20poly1305_init_push(keyBytes);
        thenDo(null, { state: res.state, header: res.header });
      } catch (e) { thenDo(e); }
    });
  },

  // Encrypt one chunk. state: from streamInitPush (mutated in place across
  // calls — pass the same object back on every subsequent call for the same
  // stream). chunk: Uint8Array. isFinal: true for the stream's last chunk
  // (including a legitimately empty final chunk for a zero-length file —
  // every stream must end with exactly one TAG_FINAL chunk, never zero).
  // Returns thenDo(null, <Uint8Array ciphertext>).
  streamPush: function(state, chunk, isFinal, thenDo) {
    this.withSodium(function(err, sodium) {
      if (err) return thenDo(err);
      try {
        var tag = isFinal
          ? sodium.crypto_secretstream_xchacha20poly1305_TAG_FINAL
          : sodium.crypto_secretstream_xchacha20poly1305_TAG_MESSAGE;
        var ciphertext = sodium.crypto_secretstream_xchacha20poly1305_push(state, chunk, null, tag);
        thenDo(null, ciphertext);
      } catch (e) { thenDo(e); }
    });
  },

  // Begin a decryption stream. header: the Uint8Array (or base64url string)
  // produced by streamInitPush — the leading streamHeaderBytes() bytes of the
  // chunked blob. encKey: the same key used to encrypt.
  // Returns thenDo(null, <opaque state>) for use with streamPull.
  streamInitPull: function(header, encKey, thenDo) {
    this.withSodium(function(err, sodium) {
      if (err) return thenDo(err);
      try {
        var keyBytes = encKey instanceof Uint8Array
          ? encKey
          : sodium.from_base64(encKey, sodium.base64_variants.URLSAFE_NO_PADDING);
        var headerBytes = header instanceof Uint8Array
          ? header
          : sodium.from_base64(header, sodium.base64_variants.URLSAFE_NO_PADDING);
        var state = sodium.crypto_secretstream_xchacha20poly1305_init_pull(headerBytes, keyBytes);
        thenDo(null, state);
      } catch (e) { thenDo(e); }
    });
  },

  // Decrypt one chunk. state: from streamInitPull (mutated in place across
  // calls, same contract as streamPush). cipherChunk: Uint8Array.
  // Returns thenDo(null, { message: <Uint8Array plaintext>, isFinal: bool }).
  // Errors (rather than returning) on authentication failure (corrupted or
  // tampered chunk) or an out-of-order/rekey tag this codebase's chunked
  // format never produces — either indicates a corrupted or truncated blob,
  // never a legitimate stream this code wrote.
  streamPull: function(state, cipherChunk, thenDo) {
    this.withSodium(function(err, sodium) {
      if (err) return thenDo(err);
      try {
        var res = sodium.crypto_secretstream_xchacha20poly1305_pull(state, cipherChunk);
        if (!res) return thenDo(new Error('streamPull: authentication tag mismatch — corrupted or tampered chunk'));
        var FINAL = sodium.crypto_secretstream_xchacha20poly1305_TAG_FINAL;
        var MESSAGE = sodium.crypto_secretstream_xchacha20poly1305_TAG_MESSAGE;
        if (res.tag !== FINAL && res.tag !== MESSAGE) {
          return thenDo(new Error('streamPull: unexpected stream tag ' + res.tag + ' — corrupted or truncated blob'));
        }
        thenDo(null, { message: res.message, isFinal: res.tag === FINAL });
      } catch (e) { thenDo(e); }
    });
  }

},

// ─── ECDH sealed-box key wrapping (X25519) ───────────────────────────────────

'ecdh', {

  // Encrypt (seal) a symmetric key for a recipient's X25519 public key.
  // encKey: Uint8Array or base64url string.
  // recipientX25519PubKey: Uint8Array or base64url string (32 bytes, X25519 public key).
  // Returns thenDo(null, <base64url sealed-box string>).
  sealForRecipient: function(encKey, recipientX25519PubKey, thenDo) {
    this.withSodium(function(err, sodium) {
      if (err) return thenDo(err);
      try {
        var keyBytes = encKey instanceof Uint8Array
          ? encKey
          : sodium.from_base64(encKey, sodium.base64_variants.URLSAFE_NO_PADDING);
        var pubBytes = recipientX25519PubKey instanceof Uint8Array
          ? recipientX25519PubKey
          : sodium.from_base64(recipientX25519PubKey, sodium.base64_variants.URLSAFE_NO_PADDING);

        var sealed = sodium.crypto_box_seal(keyBytes, pubBytes);
        thenDo(null, sodium.to_base64(sealed, sodium.base64_variants.URLSAFE_NO_PADDING));
      } catch (e) { thenDo(e); }
    });
  },

  // Open a sealed box (decrypt a wrapped key for a recipient).
  // wrappedKey: base64url string or Uint8Array.
  // recipientX25519PubKey, recipientX25519PrivKey: Uint8Array or base64url strings.
  // Returns thenDo(null, <Uint8Array encKey>).
  openSealedBox: function(wrappedKey, recipientX25519PubKey, recipientX25519PrivKey, thenDo) {
    // Identity vault (Encryption.md §19.5): a handle stands in for the raw key,
    // which then never exists in this realm; the vault does the operation.
    var vault = lively.identity.identityVault;
    if (vault && vault.isHandle(recipientX25519PrivKey)) return vault.openSealedBox(wrappedKey, recipientX25519PrivKey, thenDo);
    this.withSodium(function(err, sodium) {
      if (err) return thenDo(err);
      try {
        var wrappedBytes = wrappedKey instanceof Uint8Array
          ? wrappedKey
          : sodium.from_base64(wrappedKey, sodium.base64_variants.URLSAFE_NO_PADDING);
        var pubBytes = recipientX25519PubKey instanceof Uint8Array
          ? recipientX25519PubKey
          : sodium.from_base64(recipientX25519PubKey, sodium.base64_variants.URLSAFE_NO_PADDING);
        var privBytes = recipientX25519PrivKey instanceof Uint8Array
          ? recipientX25519PrivKey
          : sodium.from_base64(recipientX25519PrivKey, sodium.base64_variants.URLSAFE_NO_PADDING);

        var decrypted = sodium.crypto_box_seal_open(wrappedBytes, pubBytes, privBytes);
        if (!decrypted) return thenDo(new Error('Failed to open sealed box: wrong key or corrupted data'));
        thenDo(null, decrypted);
      } catch (e) { thenDo(e); }
    });
  },

  // Generate a random X25519 key pair for ECDH key wrapping.
  // Returns thenDo(null, { publicKey: <base64url>, privateKey: <base64url> }).
  // In production, the recipient's X25519 key pair is derived in WebAuthn.js:
  // PRF gives 32 bytes → private key; crypto_scalarmult_base → public key.
  // Use this generator for tests and initial setup only.
  generateX25519KeyPair: function(thenDo) {
    this.withSodium(function(err, sodium) {
      if (err) return thenDo(err);
      try {
        var keyPair = sodium.crypto_box_keypair();
        thenDo(null, {
          publicKey:  sodium.to_base64(keyPair.publicKey,  sodium.base64_variants.URLSAFE_NO_PADDING),
          privateKey: sodium.to_base64(keyPair.privateKey, sodium.base64_variants.URLSAFE_NO_PADDING)
        });
      } catch (e) { thenDo(e); }
    });
  }

});

// Singleton: lively.identity.crypto.computeCid(...), .encryptPayload(...), etc.
lively.identity.crypto = new lively.identity.Crypto();

}); // end module('lively.identity.Crypto')
