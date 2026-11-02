/**
 * lively.identity.WalletVault
 *
 * WalletSpec.md step 2 (§15): implements generate/import/encrypt/store/
 * unlock/lock/reveal and runs the §5.1 HKDF synthetic-pool-mnemonic
 * derivation. Step 3 additions: getAddress (the "trivial method"
 * WalletBridge.js's postMessage plumbing is proven against), the vault-side
 * postMessage RPC responder, and the reduced-isolation dev-mode banner
 * (§3.2). Step 4 additions: signTransaction (§6.6 — never broadcasts,
 * only signs), real setup UI (§8.1/§8.2 — mnemonic display + write-down
 * ack + confirmation quiz for create, a plain textarea for import, all
 * rendered inside this page, never returned to a caller), and a fix to a
 * real gap step 3 introduced: setup()'s RPC-facing result used to include
 * the plaintext mnemonic, which crossed the postMessage boundary the
 * moment WalletBridge.setup() was called — undermining §3's whole premise.
 * The RPC responder now strips it; setup's own return value to direct/
 * local callers is unchanged. Step 6 additions: a same-origin ZK proving
 * Worker (§5.6, WalletVaultProver.worker.js) and _proveCommitmentForTest/
 * _proveWithdrawalForTest — test-only entry points proving the Worker
 * plumbing works, deliberately not RPC-exposed; real proveCommitment/
 * proveWithdrawal (deriving secrets from unlocked wallet state) is later
 * steps' job — deposit turned out not to need either: §6.2/§3.4 confirm
 * deposit only ever calls deriveDepositSecrets, a plain Poseidon hash with
 * no ZK proof involved, correcting §15's own step-7 summary phrase
 * ("vault-side proveCommitment/deposit flow"), which doesn't match its own
 * cited §6.2 text on closer reading. Step 7 addition: deriveDepositSecrets
 * — real, RPC-exposed, derives from unlocked wallet state. Step 8 addition:
 * proveWithdrawal — real, RPC-exposed (§3.4's corrected table), re-derives
 * a spendable commitment's existing nullifier/secret plus a fresh
 * change-output nullifier/secret from unlocked wallet state, then runs the
 * same step-6 prover Worker _proveWithdrawalForTest already proved works —
 * the difference is where the witness values come from, not the proving
 * path itself. Step 9 addition: proveCommitment — real, RPC-exposed,
 * ragequit's proof (§6.6). Simpler than step 8's: a ragequit spends the
 * SAME nullifier/secret the original deposit used (generateDepositSecrets
 * (scope, index) again, no change output, no Merkle proofs — §6.6's
 * corrected finding that ragequit has no on-chain timing gate means there's
 * no eligibility check to perform here either, just re-derive and prove.
 *
 * BUG FIX, found live post-step-10: every wallet-touching method here used
 * to key its IndexedDB record off a single fixed constant ('wallet-blob')
 * and cache one single in-memory DEK — meaning every Lively identity using
 * the same browser/device shared the exact same wallet, directly
 * contradicting §0's own stated scope ("a single Ethereum keypair per
 * Lively identity"). The vault had no concept of "which identity is
 * asking" anywhere in its storage or session-cache layer at all. Fixed:
 * every record is now keyed by the calling identity's DID (_recordKey),
 * _unlockedDeks is a per-DID map instead of a single value, and every
 * method that touches either one (setup/unlock/lock/isSetUp/getAddress/
 * signTransaction/deriveDepositSecrets/proveWithdrawal/proveCommitment/
 * exportBackupBlob/revealMnemonic/getPoolMasterKeys/_withUnlockedMnemonic)
 * now takes a did — sourced from WalletBridge.js's call(), which injects
 * the current lively.identity.did.currentUser().did into every RPC call's
 * params, so no caller above WalletBridge needed to change at all. setup()
 * also now targets the calling identity's own known passkey credential
 * (options.credentialId/rpId, when known) rather than letting the platform
 * offer any discoverable credential for the rpId — a related, smaller
 * correctness fix riding along with the same root cause.
 *
 * §8.3's memory model, implemented as of step 3: an unlocked vault holds
 * the derived DEK at rest (per-DID, see above), not the decrypted
 * mnemonic. _withUnlockedMnemonic decrypts the stored record on demand — a
 * cheap local symmetric decrypt against the already-cached DEK, no new
 * WebAuthn/password ceremony — for whatever single operation needs the
 * mnemonic, rather than keeping a long-lived plaintext copy in memory.
 *
 * Deliberately PLAIN JS — no module()/Object.subclass(). This file is
 * served standalone by GET /wallet-vault (core/servers/IdentityServer.js),
 * a page that does NOT load bootstrap.js/the morphic stack/PartsBin (§3.3):
 * the Lively class/module system that module()/Object.subclass() depend on
 * only exists after bootstrap.js runs, so this file can't use it. It mirrors
 * the *shape* of lively.identity.Crypto/WebAuthn (thenDo(err, result)
 * throughout, lazy dependency injection, base64url conventions) without
 * depending on those modules being loaded — this page never loads them.
 *
 * Because of that, every DOM/browser-API touch (document, indexedDB,
 * navigator.credentials, window) happens lazily inside method bodies, never
 * at load time. That's what lets the pure derivation logic in the
 * "derivation" section below also run under plain Node (see
 * scripts/wallet-vault-key-separation-test.js), by injecting
 * global.window = global before requiring this file and this
 * vault-deps.js, and never calling the DOM-dependent methods.
 *
 * §5.1's fix, implemented here exactly as specified: the vault never hands
 * the user's real mnemonic (or any of its low account indices) to
 * generateMasterKeys. Instead it derives a second, synthetic BIP-39
 * mnemonic via a one-way KDF over the real mnemonic's BIP-39 seed, and only
 * that synthetic mnemonic ever reaches generateMasterKeys. The synthetic
 * mnemonic is never persisted separately — it's fully reconstructable from
 * the real mnemonic plus this fixed HKDF salt/info every time (§5.1, §6.1).
 *
 * Storage: a dedicated IndexedDB database (NOT lively.IndexedDB's "identity"
 * store — that store's keys already belong to DID/credential data, per
 * IDENTITY_DESIGN.md §13, and this page doesn't load that module anyway).
 * One record: the mnemonic, encrypted at rest under a DEK wrapped by a KEK
 * from either a WebAuthn PRF ceremony or an Argon2id-derived password key.
 *
 * Async pattern: thenDo(err, result), matching the rest of
 * lively.identity.*.
 */

(function () {
  'use strict';

  var HKDF_SALT = 'lively-wallet-pool-v1';
  var HKDF_INFO = 'pool-account-entropy';
  var PRF_SALT = 'lively-kek-v1'; // same fixed salt lively.identity.WebAuthn.deriveKek uses

  var DB_NAME = 'lively-wallet-vault';
  var DB_VERSION = 1;
  var STORE_NAME = 'wallet';
  // Bug fix (found live: every Lively identity using the same browser saw
  // the SAME wallet): this used to be a single fixed key, 'wallet-blob',
  // shared by every caller regardless of who was asking — the vault had no
  // concept of "which identity" anywhere in its storage layer at all,
  // directly contradicting §0's own stated scope ("a single Ethereum
  // keypair per Lively identity"). Every record is now keyed by the
  // calling identity's DID (_recordKey below), so different identities
  // sharing one device/browser each get their own independent wallet-blob,
  // matching how every other per-identity store in this codebase already
  // partitions by DID/credential (per this file's own header note on
  // lively.IndexedDB's "identity" store).
  var RECORD_KEY_PREFIX = 'wallet-blob:';

  function WalletVault() {
    // §8.3: holds the derived DEK while unlocked, NOT the decrypted
    // mnemonic — see _withUnlockedMnemonic below. In-memory only, never
    // persisted, cleared on lock()/reload either way. Keyed by DID (see
    // RECORD_KEY_PREFIX's own comment) — a map, not a single value, since
    // one vault iframe instance now serves every identity that logs in on
    // this device without being reloaded between them (§8.2's own "never
    // reparent the iframe" constraint means this instance's lifetime can
    // span an identity switch).
    this._unlockedDeks = {};
  }

  WalletVault.prototype._recordKey = function (did) {
    return RECORD_KEY_PREFIX + did;
  };

  // ─── vault-deps lazy loading (mirrors WalletCrypto.js's withWalletCryptoLibs) ──

  WalletVault.prototype.withVaultLibs = function (thenDo) {
    var self = this;
    var libs = this._vaultLibs ||
                (typeof window !== 'undefined' && window.walletVaultLibs) ||
                (typeof global !== 'undefined' && global.walletVaultLibs) ||
                null;
    if (libs) return thenDo(null, libs);

    if (typeof document === 'undefined') {
      return thenDo(new Error(
        'vault-deps.js not loaded and no document to inject it into ' +
        '(non-browser context) — set walletVault._vaultLibs directly.'
      ));
    }

    if (window._walletVaultLibsLoading) {
      var poll = setInterval(function () {
        if (window.walletVaultLibs) {
          clearInterval(poll);
          self.withVaultLibs(thenDo);
        }
      }, 50);
      return;
    }

    window._walletVaultLibsLoading = true;
    var s = document.createElement('script');
    s.src = '/core/lib/wallet/vault-deps.js';
    s.onload = function () {
      window._walletVaultLibsLoading = false;
      // The script resource can load successfully yet still fail to set
      // window.walletVaultLibs (e.g. a ReferenceError partway through
      // evaluating the bundle) — treat that as a hard error rather than
      // recursing back into "inject a script" again, which would silently
      // reload and re-throw forever instead of surfacing the failure.
      if (!window.walletVaultLibs) {
        return thenDo(new Error(
          '/core/lib/wallet/vault-deps.js loaded but did not set window.walletVaultLibs ' +
          '— it likely threw while evaluating; check the console.'
        ));
      }
      self.withVaultLibs(thenDo);
    };
    s.onerror = function () {
      window._walletVaultLibsLoading = false;
      thenDo(new Error('Failed to load /core/lib/wallet/vault-deps.js'));
    };
    document.head.appendChild(s);
  };

  // ─── libsodium lazy loading (self-contained copy of Crypto.js's withSodium
  //     pattern — this page doesn't load lively.identity.Crypto). Loads its
  //     OWN build (vault-sodium.js, libsodium-wrappers-SUMO), not the main
  //     world's /core/lib/wallet/vault-sodium.js: the base libsodium-wrappers
  //     package that build uses has no crypto_pwhash (Argon2id) at all —
  //     confirmed at implementation time — only the sumo build does, and
  //     swapping the main world's existing build to sumo is out of scope
  //     here (see scripts/build-wallet-vault-sodium.js's header for the
  //     full reasoning). ───────────────────────────────────────────────────

  WalletVault.prototype.withSodium = function (thenDo) {
    var self = this;
    var _sodium = this._sodium ||
                  (typeof window !== 'undefined' && window.sodium) ||
                  (typeof global !== 'undefined' && global.sodium) ||
                  null;
    if (_sodium) {
      return _sodium.ready.then(function () { thenDo(null, _sodium); })
        .catch(function (err) { thenDo(err); });
    }

    if (typeof document === 'undefined') {
      return thenDo(new Error(
        'libsodium-wrappers not loaded and no document to inject it into ' +
        '(non-browser context) — set walletVault._sodium directly.'
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
    s.src = '/core/lib/wallet/vault-sodium.js';
    s.onload = function () {
      window._sodiumLoading = false;
      if (!window.sodium) {
        return thenDo(new Error(
          '/core/lib/wallet/vault-sodium.js loaded but did not set window.sodium ' +
          '— it likely threw while evaluating; check the console.'
        ));
      }
      self.withSodium(thenDo);
    };
    s.onerror = function () {
      window._sodiumLoading = false;
      thenDo(new Error('Failed to load /core/lib/wallet/vault-sodium.js'));
    };
    document.head.appendChild(s);
  };

  // ─── derivation (pure — no DOM/browser API touched here; Node-loadable) ────

  // BIP-39 mnemonic generation. wordCount: 12 or 24 (§0: "12 or 24 BIP-39 words").
  WalletVault.prototype.generateMnemonic = function (wordCount, thenDo) {
    this.withVaultLibs(function (err, libs) {
      if (err) return thenDo(err);
      try {
        var strength = wordCount === 24 ? 256 : 128;
        thenDo(null, libs.generateMnemonic(strength));
      } catch (e) { thenDo(e); }
    });
  };

  WalletVault.prototype.validateMnemonic = function (mnemonic, thenDo) {
    this.withVaultLibs(function (err, libs) {
      if (err) return thenDo(err);
      try { thenDo(null, libs.validateMnemonic(mnemonic)); }
      catch (e) { thenDo(e); }
    });
  };

  // The §5.1 fix, exactly: HKDF-SHA256 over the real mnemonic's BIP-39 seed
  // (salt/info fixed and versioned, never reused for another derivation
  // purpose) → 32 bytes of entropy → a synthetic 24-word mnemonic. Never
  // handed the real mnemonic's account indices; never persisted — fully
  // reconstructable from the real mnemonic alone every time.
  WalletVault.prototype.deriveSyntheticPoolMnemonic = function (realMnemonic, thenDo) {
    this.withVaultLibs(function (err, libs) {
      if (err) return thenDo(err);
      try {
        var seed = libs.mnemonicToSeedSync(realMnemonic);
        var salt = new TextEncoder().encode(HKDF_SALT);
        var info = new TextEncoder().encode(HKDF_INFO);
        var entropy = libs.hkdfSha256(seed, salt, info, 32);
        thenDo(null, libs.entropyToMnemonic(entropy));
      } catch (e) { thenDo(e); }
    });
  };

  // masterNullifier/masterSecret from the SYNTHETIC pool mnemonic only —
  // never the real one. Calls thenDo(null, { masterNullifier, masterSecret })
  // where both are BigInt (poseidon outputs, per @0xbow/privacy-pools-core-sdk).
  WalletVault.prototype.derivePoolMasterKeys = function (realMnemonic, thenDo) {
    var self = this;
    this.deriveSyntheticPoolMnemonic(realMnemonic, function (err, syntheticMnemonic) {
      if (err) return thenDo(err);
      self.withVaultLibs(function (err2, libs) {
        if (err2) return thenDo(err2);
        try { thenDo(null, libs.generateMasterKeys(syntheticMnemonic)); }
        catch (e) { thenDo(e); }
      });
    });
  };

  // ─── KEK derivation: WebAuthn PRF (primary) ─────────────────────────────

  // No credentialId known ahead of time on this standalone page (no
  // lively.identity.DID loaded to read it from) — omit allowCredentials so
  // the platform shows any discoverable credential for this rpId, and
  // capture the credential actually used so future unlocks can target it
  // directly (options.credentialId, once known).
  WalletVault.prototype._resolveRpId = function () {
    return (typeof window !== 'undefined' && window.WalletVaultConfig && window.WalletVaultConfig.identityRpId) ||
           (typeof window !== 'undefined' && window.location.hostname) ||
           'localhost';
  };

  WalletVault.prototype.deriveKekViaWebAuthn = function (options, thenDo) {
    options = options || {};
    var self = this;
    if (typeof navigator === 'undefined' || !navigator.credentials) {
      return thenDo(new Error('WebAuthn is not available in this browser'));
    }

    var challenge = new Uint8Array(32);
    crypto.getRandomValues(challenge);
    var prfInput = new TextEncoder().encode(PRF_SALT);

    var publicKeyOptions = {
      challenge: challenge,
      rpId: options.rpId || self._resolveRpId(),
      userVerification: 'required',
      extensions: { prf: { eval: { first: prfInput.buffer } } }
    };
    if (options.credentialId) {
      publicKeyOptions.allowCredentials = [
        { type: 'public-key', id: self._base64urlDecode(options.credentialId) }
      ];
    }

    navigator.credentials.get({ publicKey: publicKeyOptions })
      .then(function (credential) {
        var ext = credential.getClientExtensionResults();
        if (!ext.prf || !ext.prf.results || !ext.prf.results.first) {
          return thenDo(new Error(
            'deriveKekViaWebAuthn: PRF extension not available for this credential.'
          ));
        }
        var kek = new Uint8Array(ext.prf.results.first);
        thenDo(null, { kek: kek, credentialId: credential.id, rpId: publicKeyOptions.rpId });
      })
      .catch(function (err) { thenDo(err); });
  };

  // ─── KEK derivation: Argon2id password fallback (libsodium crypto_pwhash) ──

  // Uses libsodium's own INTERACTIVE preset (opslimit=2, memlimit=64MiB),
  // which exceeds §7.1's stated OWASP floor (memory >= 19456 KiB, passes
  // >= 2) — reusing a vetted preset rather than hand-picking custom
  // parameters. Real Argon2id (RFC 9106) via libsodium's crypto_pwhash,
  // not a second WASM dependency (the vault already needs libsodium for
  // crypto_secretbox).
  WalletVault.prototype.deriveKekViaPassword = function (password, saltB64, thenDo) {
    this.withSodium(function (err, sodium) {
      if (err) return thenDo(err);
      try {
        var salt = saltB64
          ? sodium.from_base64(saltB64, sodium.base64_variants.URLSAFE_NO_PADDING)
          : sodium.randombytes_buf(sodium.crypto_pwhash_SALTBYTES);
        var kek = sodium.crypto_pwhash(
          32,
          password,
          salt,
          sodium.crypto_pwhash_OPSLIMIT_INTERACTIVE,
          sodium.crypto_pwhash_MEMLIMIT_INTERACTIVE,
          sodium.crypto_pwhash_ALG_ARGON2ID13
        );
        thenDo(null, {
          kek: kek,
          salt: sodium.to_base64(salt, sodium.base64_variants.URLSAFE_NO_PADDING)
        });
      } catch (e) { thenDo(e); }
    });
  };

  // ─── wrap/unwrap DEK (self-contained copy of Crypto.js's wrapDek/unwrapDek —
  //     this page doesn't load lively.identity.Crypto) ───────────────────────

  WalletVault.prototype._base64urlEncode = function (bytes) {
    var binary = '';
    for (var i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
  };

  WalletVault.prototype._base64urlDecode = function (str) {
    var padded = str + '='.repeat((4 - (str.length % 4)) % 4);
    var binary = atob(padded.replace(/-/g, '+').replace(/_/g, '/'));
    var bytes = new Uint8Array(binary.length);
    for (var i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  };

  WalletVault.prototype.wrapDek = function (kek, thenDo) {
    this.withSodium(function (err, sodium) {
      if (err) return thenDo(err);
      try {
        var dek = sodium.randombytes_buf(32);
        var nonce = sodium.randombytes_buf(sodium.crypto_secretbox_NONCEBYTES);
        var wrapped = sodium.crypto_secretbox_easy(dek, nonce, kek);
        var combined = new Uint8Array(nonce.length + wrapped.length);
        combined.set(nonce);
        combined.set(wrapped, nonce.length);
        thenDo(null, {
          dek: dek,
          wrappedDek: sodium.to_base64(combined, sodium.base64_variants.URLSAFE_NO_PADDING)
        });
      } catch (e) { thenDo(e); }
    });
  };

  WalletVault.prototype.unwrapDek = function (wrappedDek, kek, thenDo) {
    this.withSodium(function (err, sodium) {
      if (err) return thenDo(err);
      try {
        var combined = sodium.from_base64(wrappedDek, sodium.base64_variants.URLSAFE_NO_PADDING);
        var nonce = combined.slice(0, sodium.crypto_secretbox_NONCEBYTES);
        var ct = combined.slice(sodium.crypto_secretbox_NONCEBYTES);
        var dek = sodium.crypto_secretbox_open_easy(ct, nonce, kek);
        if (!dek) return thenDo(new Error('unwrapDek: authentication tag mismatch — wrong KEK or corrupted wrappedDek'));
        thenDo(null, dek);
      } catch (e) { thenDo(e); }
    });
  };

  // ─── IndexedDB (dedicated DB — not lively.IndexedDB's "identity" store) ────

  WalletVault.prototype._withDb = function (thenDo) {
    if (typeof indexedDB === 'undefined') {
      return thenDo(new Error('WalletVault: indexedDB is not available in this context'));
    }
    var req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = function () {
      if (!req.result.objectStoreNames.contains(STORE_NAME)) {
        req.result.createObjectStore(STORE_NAME);
      }
    };
    req.onsuccess = function () { thenDo(null, req.result); };
    req.onerror = function () { thenDo(req.error || new Error('WalletVault: failed to open IndexedDB')); };
  };

  WalletVault.prototype._putRecord = function (did, record, thenDo) {
    var self = this;
    this._withDb(function (err, db) {
      if (err) return thenDo(err);
      var tx = db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).put(record, self._recordKey(did));
      tx.oncomplete = function () { thenDo(null); };
      tx.onerror = function () { thenDo(tx.error || new Error('WalletVault: failed to store record')); };
    });
  };

  WalletVault.prototype._getRecord = function (did, thenDo) {
    var self = this;
    this._withDb(function (err, db) {
      if (err) return thenDo(err);
      var tx = db.transaction(STORE_NAME, 'readonly');
      var req = tx.objectStore(STORE_NAME).get(self._recordKey(did));
      req.onsuccess = function () { thenDo(null, req.result || null); };
      req.onerror = function () { thenDo(req.error || new Error('WalletVault: failed to read record')); };
    });
  };

  WalletVault.prototype.isSetUp = function (did, thenDo) {
    this._getRecord(did, function (err, record) {
      if (err) return thenDo(err);
      thenDo(null, !!record);
    });
  };

  // §7.2, §15 step 10: returns the SAME opaque encrypted record already
  // sitting in this vault's own IndexedDB (§7.1) — ciphertext, wrappedDek,
  // kdf metadata — for the main world to re-encrypt under the identity's
  // OWN Files-encryption-plane KEK/DEK (lively.identity.WalletBackup)
  // before uploading. No KEK/DEK operation happens here at all: this is a
  // plain local-storage read, safe to call even while locked, and matches
  // §3.4's table exactly ("No — ciphertext only, same guarantee as any
  // other encrypted-at-rest export").
  WalletVault.prototype.exportBackupBlob = function (did, thenDo) {
    this._getRecord(did, function (err, record) {
      if (err) return thenDo(err);
      if (!record) return thenDo(new Error('exportBackupBlob: no wallet set up on this device for this identity'));
      thenDo(null, record);
    });
  };

  // Reverse of exportBackupBlob — reinstalls an already-encrypted blob
  // (as previously produced by exportBackupBlob, round-tripped through a
  // Files backup and decrypted back down a layer by
  // lively.identity.WalletBackup's own recoverBackup) directly into this
  // identity's IndexedDB record. Never decrypts anything here: the blob is
  // already correctly shaped and already encrypted under whatever
  // KDF/credential it was originally set up with — importing it just
  // reinstalls it, exactly where a normal setup() would have put it, so
  // the ordinary unlock() flow works unchanged afterward. Refuses to
  // silently clobber an already-set-up wallet for this identity —
  // recovery is for a MISSING wallet, never a way to overwrite an
  // existing, possibly-different one; the caller must lock/clear it first
  // if that's genuinely intended (not offered as a one-step action).
  WalletVault.prototype.importBackupBlob = function (did, blob, thenDo) {
    var self = this;
    if (!did) return thenDo(new Error('importBackupBlob: no identity (did) provided'));
    if (!blob || !blob.ciphertext || !blob.wrappedDek || !blob.nonce || !blob.kdf) {
      return thenDo(new Error('importBackupBlob: blob does not look like a real wallet-blob record'));
    }
    this._getRecord(did, function (err, existing) {
      if (err) return thenDo(err);
      if (existing) {
        return thenDo(new Error('importBackupBlob: a wallet is already set up on this device for this identity — recovery refuses to overwrite it'));
      }
      self._putRecord(did, blob, function (err2) {
        if (err2) return thenDo(err2);
        thenDo(null, { ok: true });
      });
    });
  };

  // ─── setup / import / unlock / lock / reveal ────────────────────────────

  // options: { mode: 'create' | 'import' (default 'create'),
  //            wordCount (create, default 12),
  //            kdf: 'webauthn-prf' | 'argon2id', password (required for argon2id),
  //            skipConfirmation, mnemonic — TEST-ONLY, see below }
  //
  // §8.1/§8.2: for a real caller, this always renders real UI *inside this
  // page* and waits for it — mnemonic display + write-down ack + a
  // confirmation quiz (create), or a plain textarea (import, mnemonic typed
  // directly into this page, never passed in as a param) — before deriving
  // any key material. Calls thenDo(null, { mnemonic, address }): this
  // method's own return value still includes the mnemonic, for the vault
  // page's own callers (e.g. its own UI code, or direct/local testing) —
  // it's the RPC responder below, not this method, that enforces §3.4's
  // rule that the mnemonic never crosses the postMessage boundary.
  //
  // skipConfirmation/mnemonic (import) are TEST-ONLY escape hatches for
  // scripted/local calls (see scripts/wallet-vault-key-separation-test.js
  // and this project's own browser-console testing) so automated checks
  // don't need a human clicking through a quiz. The RPC responder actively
  // strips both before calling this method — a real postMessage caller
  // cannot set them, by construction, not just by convention.
  WalletVault.prototype.setup = function (options, thenDo) {
    var self = this;
    options = options || {};
    var did = options.did;
    if (!did) return thenDo(new Error('setup: no identity (did) provided — the wallet is scoped per Lively identity, not per device'));
    var mode = options.mode === 'import' ? 'import' : 'create';

    function obtainMnemonic(cb) {
      if (mode === 'import') {
        if (options.skipConfirmation && options.mnemonic) return cb(null, options.mnemonic);
        return self._showImportForm(cb);
      }
      self.generateMnemonic(options.wordCount || 12, function (err, mnemonic) {
        if (err) return cb(err);
        if (options.skipConfirmation) return cb(null, mnemonic);
        self._showMnemonicConfirmation(mnemonic, function (err2) {
          if (err2) return cb(err2);
          cb(null, mnemonic);
        });
      });
    }

    obtainMnemonic(function (err, mnemonic) {
      if (err) return thenDo(err);
      self.validateMnemonic(mnemonic, function (err2, valid) {
        if (err2) return thenDo(err2);
        if (!valid) return thenDo(new Error('setup: invalid mnemonic'));

        function withKek(cb) {
          if (options.kdf === 'argon2id') {
            if (!options.password) return thenDo(new Error('setup: password required for argon2id'));
            self.deriveKekViaPassword(options.password, null, function (err3, res) {
              if (err3) return cb(err3);
              cb(null, { kek: res.kek, kdf: 'argon2id', argon2Salt: res.salt });
            });
          } else {
            // Multi-identity fix: target THIS identity's own passkey
            // credential when known (the same one its Lively login already
            // uses) rather than letting the platform offer any discoverable
            // credential for this rpId — avoids a confusing "which passkey
            // is this even for" picker on a device with more than one
            // Lively identity's passkey registered. Falls back to the
            // broader picker when credentialId is unknown (deriveKekViaWebAuthn
            // only sets allowCredentials when one is actually provided),
            // same behavior as before this fix.
            self.deriveKekViaWebAuthn({ credentialId: options.credentialId, rpId: options.rpId }, function (err3, res) {
              if (err3) return cb(err3);
              cb(null, { kek: res.kek, kdf: 'webauthn-prf', credentialId: res.credentialId, rpId: res.rpId });
            });
          }
        }

        withKek(function (err3, kekInfo) {
          if (err3) return thenDo(err3);
          self.wrapDek(kekInfo.kek, function (err4, dekInfo) {
            if (err4) return thenDo(err4);
            self.withSodium(function (err5, sodium) {
              if (err5) return thenDo(err5);
              try {
                var payload = JSON.stringify({ mnemonic: mnemonic });
                var nonce = sodium.randombytes_buf(sodium.crypto_secretbox_NONCEBYTES);
                var ciphertext = sodium.crypto_secretbox_easy(
                  sodium.from_string(payload), nonce, dekInfo.dek
                );
                var record = {
                  version: 1,
                  did: did,
                  kdf: kekInfo.kdf,
                  wrappedDek: dekInfo.wrappedDek,
                  nonce: sodium.to_base64(nonce, sodium.base64_variants.URLSAFE_NO_PADDING),
                  ciphertext: sodium.to_base64(ciphertext, sodium.base64_variants.URLSAFE_NO_PADDING),
                  createdAt: new Date().toISOString()
                };
                if (kekInfo.kdf === 'argon2id') {
                  record.argon2Salt = kekInfo.argon2Salt;
                } else {
                  record.credentialId = kekInfo.credentialId;
                  record.rpId = kekInfo.rpId;
                }
                self._putRecord(did, record, function (err6) {
                  if (err6) return thenDo(err6);
                  // §8.3: cache the DEK, not the mnemonic — see
                  // _withUnlockedMnemonic. dekInfo.dek is already the
                  // unwrapped 32-byte key from wrapDek above.
                  self._unlockedDeks[did] = dekInfo.dek;
                  self.withVaultLibs(function (err7, libs) {
                    if (err7) return thenDo(err7);
                    try {
                      var address = libs.mnemonicToAccount(mnemonic, { accountIndex: 0 }).address;
                      thenDo(null, { mnemonic: mnemonic, address: address });
                    } catch (e) { thenDo(e); }
                  });
                });
              } catch (e) { thenDo(e); }
            });
          });
        });
      });
    });
  };

  // ─── setup UI: mnemonic display + confirmation quiz, import textarea ───
  // §8.1/§8.2: this is the "renders inside the vault iframe, never as a
  // postMessage payload" UI the setup() flow above waits on. Plain DOM,
  // matching this file's existing no-framework style. The overlay uses a
  // z-index just under the reduced-isolation banner's max value so the
  // banner (when present) stays visible above it, with top padding so the
  // banner strip never covers this content.

  WalletVault.prototype._overlayContainer = function () {
    var el = document.createElement('div');
    el.style.cssText =
      'position:fixed;inset:0;z-index:2147483646;overflow:auto;' +
      'background:#141414;color:#eee;font:14px/1.5 -apple-system,sans-serif;' +
      'box-sizing:border-box;padding:40px 24px 24px 24px;';
    document.body.appendChild(el);
    return el;
  };

  // Purple-accent button pair matching WalletSetupDialog.js's own pill
  // language (rgb(147,51,234)) -- kept as plain inline CSS here since this
  // file is deliberately framework-free (see the file header) and has no
  // access to that dialog's morph-specific paint helpers. "Primary" (the
  // forward-moving action) is a solid purple pill; "secondary" (Back) is a
  // plain ghost-style text button -- same right/left action-row convention
  // WalletSetupDialog.js's own screens now use.
  function _stylePrimaryButton(btn) {
    btn.style.cssText =
      'background:rgb(147,51,234);color:#fff;border:none;border-radius:999px;' +
      'padding:9px 22px;font:600 14px -apple-system,sans-serif;cursor:pointer;';
  }

  function _styleSecondaryButton(btn) {
    btn.style.cssText =
      'background:transparent;color:#aaa;border:none;border-radius:999px;' +
      'padding:9px 14px;font:14px -apple-system,sans-serif;cursor:pointer;';
  }

  // Lays out a bottom action row: secondary (Back, if given) flush left,
  // primary (Continue/Confirm) flush right -- mirrors
  // WalletSetupDialog.js's _addActionRow. No "Cancel" button here by
  // design: the outer WalletSetupDialog morph window already has its own
  // close (X) button, which triggers that dialog's onRemove and safely
  // tears down the vault frame/sync loop -- a second, redundant Cancel
  // inside the iframe's own content was removed from all three screens
  // below (write-down, quiz, import) rather than kept as a duplicate.
  function _appendActionRow(container, primaryLabel, onPrimary, secondaryLabel, onSecondary) {
    var row = document.createElement('div');
    row.style.cssText = 'display:flex;justify-content:space-between;align-items:center;margin-top:16px;';

    if (secondaryLabel) {
      var secondaryBtn = document.createElement('button');
      secondaryBtn.textContent = secondaryLabel;
      _styleSecondaryButton(secondaryBtn);
      secondaryBtn.addEventListener('click', onSecondary);
      row.appendChild(secondaryBtn);
    } else {
      row.appendChild(document.createElement('span'));
    }

    var primaryBtn = document.createElement('button');
    primaryBtn.textContent = primaryLabel;
    _stylePrimaryButton(primaryBtn);
    primaryBtn.addEventListener('click', onPrimary);
    row.appendChild(primaryBtn);

    container.appendChild(row);
    return primaryBtn;
  }

  // mnemonic: string (already generated). onDone: thenDo(err) — no result,
  // just "confirmed, proceed" or "failed/cancelled."
  WalletVault.prototype._showMnemonicConfirmation = function (mnemonic, onDone) {
    var words = mnemonic.trim().split(/\s+/);
    var container = this._overlayContainer();

    function renderWriteDownScreen() {
      container.innerHTML = '';

      var heading = document.createElement('h2');
      heading.style.cssText = 'margin:0 0 10px;';
      heading.textContent = 'Write down your recovery phrase';
      container.appendChild(heading);

      var warn = document.createElement('p');
      warn.style.cssText = 'margin:0 0 14px;';
      warn.textContent =
        'This is the ONLY way to recover your wallet. Write it down and ' +
        'store it somewhere safe — it will not be shown again unless ' +
        'you unlock and reveal it later.';
      container.appendChild(warn);

      // 4 columns (rather than 3) so a 24-word phrase needs only 6 rows
      // instead of 8 -- shrinks the grid's total height enough, combined
      // with WalletSetupDialog.js's own widened/heightened vault-flow
      // window, that this screen renders in full with no scrolling even
      // at 24 words (confirmed live at the actual iframe size, see
      // startVaultFlow's own sizing comment).
      var grid = document.createElement('div');
      grid.style.cssText = 'display:grid;grid-template-columns:repeat(4,1fr);gap:6px;margin:0 0 14px;';
      words.forEach(function (w, i) {
        var cell = document.createElement('div');
        cell.style.cssText = 'background:#262626;padding:6px 8px;border-radius:6px;font-family:monospace;font-size:13px;';
        cell.textContent = (i + 1) + '. ' + w;
        grid.appendChild(cell);
      });
      container.appendChild(grid);

      var ackLabel = document.createElement('label');
      ackLabel.style.cssText = 'display:block;margin:0;';
      var ackBox = document.createElement('input');
      ackBox.type = 'checkbox';
      ackLabel.appendChild(ackBox);
      ackLabel.appendChild(document.createTextNode(' I have written this phrase down and stored it safely'));
      container.appendChild(ackLabel);

      // "Back" here means back to WalletSetupDialog.js's own options
      // screen (word count / unlock method), not a vault-internal
      // previous screen -- there isn't one before write-down. Tagged
      // error.code:'user-back' so it survives the postMessage boundary
      // (see the RPC responder's own comment below) distinguishably from
      // a genuine setup failure -- WalletSetupDialog.js's setup()
      // callback checks for it and rebuilds the options screen instead of
      // showing an error screen.
      var primaryBtn = _appendActionRow(container, 'Continue', renderQuizScreen, 'Back', function () {
        document.body.removeChild(container);
        var err = new Error('Setup cancelled — back to options');
        err.code = 'user-back';
        onDone(err);
      });
      primaryBtn.disabled = true;
      primaryBtn.style.opacity = '0.5';
      ackBox.addEventListener('change', function () {
        primaryBtn.disabled = !ackBox.checked;
        primaryBtn.style.opacity = ackBox.checked ? '1' : '0.5';
      });
    }

    function renderQuizScreen() {
      container.innerHTML = '';

      var heading = document.createElement('h2');
      heading.style.cssText = 'margin:0 0 10px;';
      heading.textContent = 'Confirm your recovery phrase';
      container.appendChild(heading);

      var positions = [];
      while (positions.length < Math.min(3, words.length)) {
        var idx = Math.floor(Math.random() * words.length);
        if (positions.indexOf(idx) === -1) positions.push(idx);
      }
      positions.sort(function (a, b) { return a - b; });

      var inputs = positions.map(function (idx) {
        var label = document.createElement('label');
        label.style.cssText = 'display:block;margin:8px 0;max-width:240px;';
        label.textContent = 'Word #' + (idx + 1) + ':';
        var input = document.createElement('input');
        input.type = 'text';
        input.autocomplete = 'off';
        input.spellcheck = false;
        input.style.cssText = 'display:block;margin-top:4px;width:100%;box-sizing:border-box;';
        label.appendChild(input);
        container.appendChild(label);
        return { idx: idx, input: input };
      });

      var errorMsg = document.createElement('p');
      errorMsg.style.cssText = 'color:#f66;display:none;';
      errorMsg.textContent = "Those don't match — check your written-down copy and try again.";
      container.appendChild(errorMsg);

      _appendActionRow(container, 'Confirm', function () {
        var allCorrect = inputs.every(function (pair) {
          return pair.input.value.trim().toLowerCase() === words[pair.idx].toLowerCase();
        });
        if (!allCorrect) {
          errorMsg.style.display = 'block';
          return;
        }
        document.body.removeChild(container);
        onDone(null);
      }, 'Back', renderWriteDownScreen);
    }

    renderWriteDownScreen();
  };

  // onDone: thenDo(err, mnemonic) — the vault reads the phrase directly
  // from its own <textarea>, never a param passed in from the caller
  // (§8.2: "never typed into a main-world DOM node").
  WalletVault.prototype._showImportForm = function (onDone) {
    var self = this;
    var container = this._overlayContainer();

    var heading = document.createElement('h2');
    heading.style.cssText = 'margin:0 0 10px;';
    heading.textContent = 'Import your recovery phrase';
    container.appendChild(heading);

    var info = document.createElement('p');
    info.style.cssText = 'margin:0 0 14px;';
    info.textContent = 'Enter your 12 or 24-word recovery phrase, separated by spaces.';
    container.appendChild(info);

    var textarea = document.createElement('textarea');
    textarea.rows = 4;
    textarea.autocomplete = 'off';
    textarea.spellcheck = false;
    textarea.style.cssText = 'width:100%;box-sizing:border-box;font:14px monospace;display:block;';
    container.appendChild(textarea);

    var errorMsg = document.createElement('p');
    errorMsg.style.cssText = 'color:#f66;display:none;';
    container.appendChild(errorMsg);

    // "Back" means back to WalletSetupDialog.js's own options screen
    // (unlock method / password) -- same code:'user-back' signal
    // renderWriteDownScreen's own Back button uses, see its comment above.
    _appendActionRow(container, 'Continue', function () {
      var mnemonic = textarea.value.trim().replace(/\s+/g, ' ');
      self.validateMnemonic(mnemonic, function (err, valid) {
        if (err || !valid) {
          errorMsg.textContent = "That doesn't look like a valid recovery phrase — check the words and try again.";
          errorMsg.style.display = 'block';
          return;
        }
        document.body.removeChild(container);
        onDone(null, mnemonic);
      });
    }, 'Back', function () {
      document.body.removeChild(container);
      var err = new Error('Import cancelled — back to options');
      err.code = 'user-back';
      onDone(err);
    });
  };

  // ─── signing (§3.4, §6.6) ────────────────────────────────────────────────

  // unsignedTx: viem-shaped tx params (to, value, nonce, gas, maxFeePerGas,
  // maxPriorityFeePerGas, chainId, ...) — built by the caller (main world;
  // no secrets in an unsigned tx). Requires an already-unlocked vault, same
  // "deliberately simple" reasoning as getAddress. Returns thenDo(null,
  // signedRawTxHex) — a fully serialized, ready-to-broadcast raw
  // transaction. This method never broadcasts anything itself; per
  // WalletSpec.md §15 step 4's own scope, nothing in this codebase calls
  // eth_sendRawTransaction yet at all.
  WalletVault.prototype.signTransaction = function (did, unsignedTx, thenDo) {
    var self = this;
    this._withUnlockedMnemonic(did, function (err, mnemonic) {
      if (err) return thenDo(new Error('signTransaction: ' + err.message));
      self.withVaultLibs(function (err2, libs) {
        if (err2) return thenDo(err2);
        try {
          var account = libs.mnemonicToAccount(mnemonic, { accountIndex: 0 });
          account.signTransaction(unsignedTx)
            .then(function (signed) { thenDo(null, signed); })
            .catch(function (e) { thenDo(e); });
        } catch (e) { thenDo(e); }
      });
    });
  };

  // ─── ZK proving Worker (§5.6, §15 step 6) ───────────────────────────────
  // Same-origin Worker, spawned once and reused. postMessage to/from this
  // Worker never crosses §3's cross-origin boundary — the Worker and this
  // page are the same trusted realm (§5.6's own note).
  //
  // Scope boundary, matching the spec's own step 6/7 split: this only
  // proves the Worker plumbing itself works — _proveCommitmentForTest below
  // is deliberately NOT exposed through the postMessage RPC responder, and
  // takes already-computed witness values rather than deriving them from
  // unlocked wallet state. Wiring real proveCommitment/proveWithdrawal RPC
  // methods (deriving secrets from the unlocked mnemonic, tied into
  // setup/unlock state) is step 7's job.

  WalletVault.prototype._withProverWorker = function (thenDo) {
    if (this._proverWorker) return thenDo(null, this._proverWorker);
    if (typeof Worker === 'undefined') {
      return thenDo(new Error('_withProverWorker: Worker is not available in this context'));
    }
    try {
      var worker = new Worker('/core/lively/identity/WalletVaultProver.worker.js');
      this._proverWorker = worker;
      this._proverPending = {};
      this._proverNextId = 1;
      var self = this;
      worker.addEventListener('message', function (event) {
        var msg = event.data;
        if (!msg || typeof msg.id === 'undefined') return;
        var pending = self._proverPending[msg.id];
        if (!pending) return;
        if (msg.type === 'progress') {
          if (pending.onProgress) pending.onProgress(msg.phase);
          return;
        }
        if (msg.type === 'result') {
          delete self._proverPending[msg.id];
          if (msg.error) return pending.thenDo(new Error(msg.error.message));
          pending.thenDo(null, { proof: msg.proof, publicSignals: msg.publicSignals });
        }
      });
      thenDo(null, worker);
    } catch (e) { thenDo(e); }
  };

  WalletVault.prototype._proverCall = function (method, params, onProgress, thenDo) {
    var self = this;
    this._withProverWorker(function (err, worker) {
      if (err) return thenDo(err);
      var id = self._proverNextId++;
      self._proverPending[id] = { thenDo: thenDo, onProgress: onProgress };
      worker.postMessage({ id: id, method: method, params: params });
    });
  };

  // Test-only entry point for §15 step 6's own required check ("provable
  // in isolation... check the proof verifies") — drives the real Worker
  // end-to-end from inside the vault page, the same way
  // scripts/wallet-vault-prover-isolation-test.js drives the same
  // underlying SDK classes directly from Node. Both should produce a
  // proof that verifies true for the same inputs.
  WalletVault.prototype._proveCommitmentForTest = function (value, label, nullifier, secret, onProgress, thenDo) {
    this._proverCall('proveCommitment', { value: value, label: label, nullifier: nullifier, secret: secret }, onProgress, thenDo);
  };

  WalletVault.prototype._proveWithdrawalForTest = function (commitment, input, onProgress, thenDo) {
    this._proverCall('proveWithdrawal', { commitment: commitment, input: input }, onProgress, thenDo);
  };

  // Real, RPC-exposed proveWithdrawal (§3.4's corrected table, §15 step 8) —
  // deriving secrets from unlocked wallet state, unlike the test-only
  // method above which takes already-computed witness values directly.
  // Re-derives the spendable commitment's existing nullifier/secret via
  // generateDepositSecrets(scope, index) — the SAME formula that created
  // this commitment at deposit time (§6.1) — and a fresh newNullifier/
  // newSecret for the change output via generateWithdrawalSecrets(keys,
  // label, withdrawalIndex), §6.1's own distinct index space, keyed by
  // label rather than scope. Only the finished proof crosses back out via
  // onProgress/thenDo — every nullifier/secret preimage here stays local
  // to this function call.
  //
  // params: { scope, index, label, value, withdrawalIndex,
  // input: { context, withdrawalAmount, stateMerkleProof, aspMerkleProof,
  // stateRoot, stateTreeDepth, aspRoot, aspTreeDepth } } — everything
  // except newSecret/newNullifier from §3.4's table; those two are
  // deliberately NOT accepted as params (the vault derives them itself,
  // same "never accept secret input from outside" shape as
  // deriveDepositSecrets). onProgress(phase) mirrors the Worker's own
  // 'loading_circuits'/'generating_proof'/'verifying_proof' phases (§5.6).
  WalletVault.prototype.proveWithdrawal = function (params, onProgress, thenDo) {
    var self = this;
    params = params || {};
    this.getPoolMasterKeys(params.did, function (err, keys) {
      if (err) return thenDo(new Error('proveWithdrawal: ' + err.message));
      self.withVaultLibs(function (err2, libs) {
        if (err2) return thenDo(err2);
        try {
          var scope = BigInt(params.scope);
          var index = BigInt(params.index);
          var label = BigInt(params.label);
          var value = BigInt(params.value);
          var withdrawalIndex = BigInt(params.withdrawalIndex || 0);
          var input = params.input || {};

          var existingSecrets = libs.generateDepositSecrets(keys, scope, index);
          var newSecrets = libs.generateWithdrawalSecrets(keys, label, withdrawalIndex);

          var commitment = {
            value: value,
            label: label,
            nullifier: existingSecrets.nullifier,
            secret: existingSecrets.secret
          };
          var proverInput = {
            context: BigInt(input.context),
            withdrawalAmount: BigInt(input.withdrawalAmount),
            stateMerkleProof: input.stateMerkleProof,
            aspMerkleProof: input.aspMerkleProof,
            stateRoot: BigInt(input.stateRoot),
            stateTreeDepth: BigInt(input.stateTreeDepth),
            aspRoot: BigInt(input.aspRoot),
            aspTreeDepth: BigInt(input.aspTreeDepth),
            newSecret: newSecrets.secret,
            newNullifier: newSecrets.nullifier
          };
          self._proverCall('proveWithdrawal', { commitment: commitment, input: proverInput }, onProgress, thenDo);
        } catch (e) { thenDo(e); }
      });
    });
  };

  // Real, RPC-exposed proveCommitment (§6.6, §15 step 9) — the ragequit
  // proof. Re-derives the SAME nullifier/secret the original deposit used
  // (generateDepositSecrets(scope, index) — identical call proveWithdrawal
  // makes for its existingSecrets), since a ragequit spends the original
  // commitment outright rather than producing a change output; no
  // withdrawalIndex, no Merkle proofs, no second secret pair. §6.6's
  // corrected finding (no on-chain timing gate) means there's no
  // eligibility check to run here either — proveWithdrawal's own
  // Merkle-proof-driven "is this even associated" question doesn't apply to
  // ragequit at all, since ragequit bypasses the ASP root check by design.
  //
  // params: { scope, index, label, value } — all public (§3.4's table:
  // deriveDepositSecrets already crosses scope/index the same way). Only
  // the finished proof crosses back out via onProgress/thenDo.
  WalletVault.prototype.proveCommitment = function (params, onProgress, thenDo) {
    var self = this;
    params = params || {};
    this.getPoolMasterKeys(params.did, function (err, keys) {
      if (err) return thenDo(new Error('proveCommitment: ' + err.message));
      self.withVaultLibs(function (err2, libs) {
        if (err2) return thenDo(err2);
        try {
          var scope = BigInt(params.scope);
          var index = BigInt(params.index);
          var label = BigInt(params.label);
          var value = BigInt(params.value);

          var secrets = libs.generateDepositSecrets(keys, scope, index);

          self._proverCall('proveCommitment', {
            value: value,
            label: label,
            nullifier: secrets.nullifier,
            secret: secrets.secret
          }, onProgress, thenDo);
        } catch (e) { thenDo(e); }
      });
    });
  };

  // options: { did, password } for the argon2id path; { did } to trigger a
  // WebAuthn ceremony against the stored credentialId/rpId.
  WalletVault.prototype.unlock = function (options, thenDo) {
    var self = this;
    options = options || {};
    var did = options.did;
    if (!did) return thenDo(new Error('unlock: no identity (did) provided'));
    this._getRecord(did, function (err, record) {
      if (err) return thenDo(err);
      if (!record) return thenDo(new Error('unlock: no wallet set up on this device for this identity'));

      function withKek(cb) {
        if (record.kdf === 'argon2id') {
          if (!options.password) return thenDo(new Error('unlock: password required'));
          self.deriveKekViaPassword(options.password, record.argon2Salt, function (err2, res) {
            if (err2) return cb(err2);
            cb(null, res.kek);
          });
        } else {
          self.deriveKekViaWebAuthn({ credentialId: record.credentialId, rpId: record.rpId }, function (err2, res) {
            if (err2) return cb(err2);
            cb(null, res.kek);
          });
        }
      }

      withKek(function (err2, kek) {
        if (err2) return thenDo(err2);
        self.unwrapDek(record.wrappedDek, kek, function (err3, dek) {
          if (err3) return thenDo(err3);
          self.withSodium(function (err4, sodium) {
            if (err4) return thenDo(err4);
            try {
              // Decrypt here only to VERIFY the derived DEK is actually
              // correct (a wrong password/credential must surface as an
              // error, same as before) — the decrypted plaintext itself
              // goes out of scope right after this check. §8.3: cache the
              // DEK, not the mnemonic bytes.
              var nonce = sodium.from_base64(record.nonce, sodium.base64_variants.URLSAFE_NO_PADDING);
              var ct = sodium.from_base64(record.ciphertext, sodium.base64_variants.URLSAFE_NO_PADDING);
              var plaintext = sodium.crypto_secretbox_open_easy(ct, nonce, dek);
              if (!plaintext) return thenDo(new Error('unlock: authentication tag mismatch — wrong password/credential or corrupted data'));
              self._unlockedDeks[did] = dek;
              thenDo(null, { ok: true });
            } catch (e) { thenDo(e); }
          });
        });
      });
    });
  };

  // did: which identity's cached DEK to drop. A falsy did is a no-op
  // (never clears every identity's session as a side effect of a caller
  // bug) rather than defaulting to "lock everything."
  WalletVault.prototype.lock = function (did, thenDo) {
    if (did) delete this._unlockedDeks[did];
    if (thenDo) thenDo(null, 'ok');
  };

  WalletVault.prototype.isUnlocked = function (did) {
    return !!(did && this._unlockedDeks[did]);
  };

  // §8.3: the vault holds the DEK at rest while unlocked, not the
  // plaintext mnemonic. This decrypts the stored record on demand using
  // the cached DEK — a cheap local symmetric decrypt, no new WebAuthn/
  // password ceremony — for whatever single operation needs the mnemonic
  // right now, rather than keeping a long-lived decrypted copy in memory.
  // Note on limits: this narrows the window a live reference to the
  // plaintext exists; it doesn't (and can't, from JS) guarantee the bytes
  // are scrubbed from the engine's heap — GC timing isn't under our
  // control. Real hardening, not a promise of erasure.
  WalletVault.prototype._withUnlockedMnemonic = function (did, thenDo) {
    var self = this;
    var dek = did && self._unlockedDeks[did];
    if (!dek) return thenDo(new Error('vault is locked'));
    self._getRecord(did, function (err, record) {
      if (err) return thenDo(err);
      if (!record) return thenDo(new Error('vault is locked'));
      self.withSodium(function (err2, sodium) {
        if (err2) return thenDo(err2);
        try {
          var nonce = sodium.from_base64(record.nonce, sodium.base64_variants.URLSAFE_NO_PADDING);
          var ct = sodium.from_base64(record.ciphertext, sodium.base64_variants.URLSAFE_NO_PADDING);
          var plaintext = sodium.crypto_secretbox_open_easy(ct, nonce, dek);
          if (!plaintext) {
            return thenDo(new Error('_withUnlockedMnemonic: authentication tag mismatch — cached DEK no longer matches the stored record'));
          }
          var payload = JSON.parse(sodium.to_string(plaintext));
          thenDo(null, payload.mnemonic);
        } catch (e) { thenDo(e); }
      });
    });
  };

  // Re-derives the KEK fresh (a real ceremony/password prompt) before
  // revealing, regardless of whether the vault is already unlocked in
  // memory — matches WalletSpec.md §3.4's revealMnemonic contract ("re-runs
  // a fresh WebAuthn/password ceremony first"). Rendered by the vault
  // page's own UI; per §3.4 this never crosses the postMessage boundary in
  // either direction, in any step — not exposed in the RPC responder below.
  WalletVault.prototype.revealMnemonic = function (options, thenDo) {
    var self = this;
    options = options || {};
    this.unlock(options, function (err) {
      if (err) return thenDo(err);
      self._withUnlockedMnemonic(options.did, thenDo);
    });
  };

  // Requires an unlocked vault. Re-derives the synthetic pool mnemonic and
  // master keys fresh from the on-demand-decrypted real mnemonic every
  // call — never cached, never persisted (§5.1, §5.3).
  WalletVault.prototype.getPoolMasterKeys = function (did, thenDo) {
    var self = this;
    this._withUnlockedMnemonic(did, function (err, mnemonic) {
      if (err) return thenDo(new Error('getPoolMasterKeys: ' + err.message));
      self.derivePoolMasterKeys(mnemonic, thenDo);
    });
  };

  // §6.1/§6.2, §15 step 7: precommitment = Poseidon(nullifier, secret),
  // where nullifier/secret are themselves derived deterministically from
  // the pool master keys + scope + index (generateDepositSecrets, §6.1's
  // exact formula). No ZK proof here — deposit only ever needs this hash;
  // see this file's own header for why that corrects §15's step-7 summary
  // text. scope/index are public (§3.4's table lists them as the caller-
  // supplied params) — the vault stays stateless per call, same as
  // signTransaction/getPoolMasterKeys; picking which index is "next" for a
  // given scope is the main world's job (PrivacyPoolClient.js), not
  // tracked here. Only the precommitment hash crosses back out —
  // nullifier/secret are discarded the instant this function returns.
  WalletVault.prototype.deriveDepositSecrets = function (did, scope, index, thenDo) {
    var self = this;
    this.getPoolMasterKeys(did, function (err, keys) {
      if (err) return thenDo(new Error('deriveDepositSecrets: ' + err.message));
      self.withVaultLibs(function (err2, libs) {
        if (err2) return thenDo(err2);
        try {
          var secrets = libs.generateDepositSecrets(keys, BigInt(scope), BigInt(index));
          var precommitment = libs.hashPrecommitment(secrets.nullifier, secrets.secret);
          thenDo(null, { precommitment: precommitment });
        } catch (e) { thenDo(e); }
      });
    });
  };

  // §15 step 3: the "trivial method" WalletBridge's postMessage plumbing
  // is proven against. §5.1: derived from the REAL mnemonic's account
  // index 0 directly — the ordinary Ethereum spending key, never routed
  // through the synthetic pool mnemonic. Requires an already-unlocked
  // vault — deliberately simple; auto-prompting an unlock here is a later
  // UI-flow concern (§8.3), not this method's job.
  WalletVault.prototype.getAddress = function (did, thenDo) {
    var self = this;
    this._withUnlockedMnemonic(did, function (err, mnemonic) {
      if (err) return thenDo(new Error('getAddress: ' + err.message));
      self.withVaultLibs(function (err2, libs) {
        if (err2) return thenDo(err2);
        try {
          thenDo(null, libs.mnemonicToAccount(mnemonic, { accountIndex: 0 }).address);
        } catch (e) { thenDo(e); }
      });
    });
  };

  // ─── same-origin dev-fallback detection (§3.2) ──────────────────────────
  // Self-contained — no coordination needed from whatever embeds this page.
  // Succeeds only when genuinely same-origin (dev fallback, no real cross-
  // origin infra exists in this codebase yet); a real cross-origin embed
  // makes window.top.location inaccessible, so this throws and both the
  // banner and the RPC responder's origin check below naturally stop
  // trusting it — exactly the behavior wanted once a real second origin
  // exists in a later step, with no code change required here.
  function sameOriginParentOrigin() {
    if (window.self === window.top) return null; // not embedded at all
    try {
      var origin = window.top.location.origin;
      return origin === window.location.origin ? origin : null;
    } catch (e) {
      return null;
    }
  }

  // ─── reduced-isolation dev-mode banner (§3.2's checklist item: "actually
  //     renders and is unmissable when identityWalletOrigin is unset") ────

  function renderReducedIsolationBannerIfNeeded() {
    if (!sameOriginParentOrigin()) return;
    var banner = document.createElement('div');
    banner.textContent =
      'Running in reduced-isolation dev mode — the wallet vault is NOT ' +
      'cross-origin isolated. Never use this configuration in production.';
    banner.style.cssText =
      'position:fixed;top:0;left:0;right:0;z-index:2147483647;' +
      'background:#b00020;color:#fff;font:bold 13px/1.4 sans-serif;' +
      'padding:6px 10px;text-align:center;';
    document.body.appendChild(banner);
  }

  // ─── postMessage RPC responder (vault side, §3.4) ───────────────────────
  // Only registered when embedded — direct navigation to /wallet-vault (as
  // in step 2's own testing) never sets this up, matching §3.3's shape:
  // the vault's RPC surface only exists once something has actually
  // embedded it.
  //
  // Method allowlist is deliberately narrow — only what's reachable as of
  // WalletSpec.md §15 step 4: setup/unlock/lock/getAddress/isSetUp/
  // signTransaction; step 7 adds deriveDepositSecrets (§3.4's table —
  // scope/index in, precommitment hash out, never the nullifier/secret
  // preimage). Step 8 adds proveWithdrawal (§3.4's corrected table) — the
  // first RPC method that reports progress (loading_circuits/
  // generating_proof/verifying_proof, §5.6) rather than a single response,
  // so handlers now optionally receive a sendProgress callback alongside
  // the usual cb. Step 9 adds proveCommitment (§6.6) — same progress-
  // reporting shape, the ragequit proof. Step 10 adds exportBackupBlob
  // (§7.2) — a plain single-response read, no progress, no unlock
  // required. revealMnemonic is NEVER exposed here — see its own comment
  // above; it renders inside the vault's own UI and never crosses this
  // boundary, in any step.
  //
  // Multi-identity bug fix (see this file's own header): every handler
  // below now reads params.did — injected transparently by WalletBridge.
  // js's call() for every RPC round trip — and passes it through to the
  // corresponding WalletVault method, which uses it to look up the RIGHT
  // identity's own record/session rather than a single global one.
  //
  // setup's wrapper is not a passthrough: it strips skipConfirmation and
  // (for import) mnemonic from the incoming params before calling through —
  // those are TEST-ONLY escape hatches for direct/local calls (see
  // setup()'s own comment), and a real postMessage caller must not be able
  // to set them just by including them in the message it sends. It also
  // strips mnemonic from the OUTGOING result — §3.4: the mnemonic must
  // never cross this boundary in either direction, in any flow, including
  // setup (confirmation already happened inside this page's own UI before
  // setup() even resolves).

  var RPC_METHODS = {
    setup: function (params, cb) {
      var safeParams = {};
      for (var k in (params || {})) {
        if (k !== 'skipConfirmation' && k !== 'mnemonic') safeParams[k] = params[k];
      }
      window.lively.identity.walletVault.setup(safeParams, function (err, result) {
        cb(err, result ? { address: result.address } : result);
      });
    },
    unlock:          function (params, cb) { window.lively.identity.walletVault.unlock(params, cb); },
    lock:            function (params, cb) { window.lively.identity.walletVault.lock((params || {}).did, cb); },
    getAddress:      function (params, cb) { window.lively.identity.walletVault.getAddress((params || {}).did, cb); },
    isSetUp:         function (params, cb) { window.lively.identity.walletVault.isSetUp((params || {}).did, cb); },
    // WalletBridge.signTransaction now sends { unsignedTx, did, ... } rather
    // than the bare unsignedTx object directly as params — multi-identity
    // fix: did/credentialId/rpId are injected as SIBLINGS of unsignedTx,
    // never merged into it, so viem's signTransaction never sees stray
    // extra fields mixed into the tx shape it expects.
    signTransaction: function (params, cb) {
      window.lively.identity.walletVault.signTransaction((params || {}).did, (params || {}).unsignedTx, cb);
    },
    deriveDepositSecrets: function (params, cb) {
      window.lively.identity.walletVault.deriveDepositSecrets((params || {}).did, (params || {}).scope, (params || {}).index, cb);
    },
    proveWithdrawal: function (params, cb, sendProgress) {
      window.lively.identity.walletVault.proveWithdrawal(params, sendProgress, cb);
    },
    proveCommitment: function (params, cb, sendProgress) {
      window.lively.identity.walletVault.proveCommitment(params, sendProgress, cb);
    },
    exportBackupBlob: function (params, cb) {
      window.lively.identity.walletVault.exportBackupBlob((params || {}).did, cb);
    },
    importBackupBlob: function (params, cb) {
      window.lively.identity.walletVault.importBackupBlob((params || {}).did, (params || {}).blob, cb);
    }
  };

  function startRpcResponder() {
    if (window.self === window.top) return; // not embedded, nothing to serve

    window.addEventListener('message', function (event) {
      var expectedOrigin = sameOriginParentOrigin();
      if (!expectedOrigin || event.origin !== expectedOrigin) return;
      if (event.source !== window.top) return;

      var msg = event.data;
      if (!msg || typeof msg.id === 'undefined' || !msg.method) return;

      var handler = RPC_METHODS[msg.method];
      if (!handler) {
        return event.source.postMessage(
          { id: msg.id, error: { message: 'Unknown method: ' + msg.method }, result: null },
          expectedOrigin
        );
      }
      // §5.6/§9.4: a small, backward-compatible protocol extension —
      // existing handlers ignore this third arg entirely (their final
      // response still looks exactly like before), so this doesn't change
      // any single-response method's wire shape. Progress messages are
      // tagged type:'progress' precisely so WalletBridge.js's listener can
      // tell them apart from the one final {id, error, result} message.
      function sendProgress(phase) {
        event.source.postMessage({ id: msg.id, type: 'progress', phase: phase }, expectedOrigin);
      }
      handler(msg.params, function (err, result) {
        // err.code (when present) rides along too -- setup()'s own
        // "user clicked Back on the write-down/import screen" case tags
        // its error with code:'user-back' so WalletSetupDialog.js's
        // setup() callback can tell "go back to the options screen" apart
        // from a genuine failure, across this postMessage boundary, which
        // otherwise only carries a plain message string.
        event.source.postMessage(
          { id: msg.id, error: err ? { message: err.message, code: err.code } : null, result: result === undefined ? null : result },
          expectedOrigin
        );
      }, sendProgress);
    });
  }

  // ─── singleton, namespaced to match WalletSpec.md §11's module map ─────────

  window.lively = window.lively || {};
  window.lively.identity = window.lively.identity || {};
  window.lively.identity.WalletVault = WalletVault;
  window.lively.identity.walletVault = new WalletVault();

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = WalletVault;
  }

  if (typeof window !== 'undefined' && typeof document !== 'undefined') {
    renderReducedIsolationBannerIfNeeded();
    startRpcResponder();
  }
})();
