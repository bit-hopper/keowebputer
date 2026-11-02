/**
 * lively.identity.WalletBackup
 *
 * WalletSpec.md §7.2, §15 step 10: the wallet's OPTIONAL encrypted backup
 * into the identity's existing private Files/encryption plane
 * (Encryption.md §2-§5) — a fourth payload type through that one plane,
 * not a new one (WalletSpec.md §4). Main-world only; touches no wallet
 * secrets directly — the vault's own exportBackupBlob (§3.4) is the only
 * thing this ever calls into the vault for, and what it returns is already
 * ciphertext (the wallet-blob record already sitting in the vault's own
 * IndexedDB, §7.1), never a decrypted mnemonic or key.
 *
 * Two changes from FileCrypto.js's ordinary private-file path (§7.2's own
 * corrections against an earlier draft):
 *   1. type: 'wallet-backup', not type: 'file' — kept out of
 *      FilesBrowser's listing (it filters client-side for type === 'file')
 *      so a casual look at "my private files" doesn't surface "I have a
 *      wallet."
 *   2. state: {} — no descriptive name field the way FileCrypto sets
 *      state.name in the clear; nothing server-visible identifies this
 *      object as wallet-related beyond the type string itself.
 * No BlobStore involved either (§7.2's own correction to an earlier
 * draft): the vault's exported blob is well under a kilobyte, so it goes
 * directly into record.payload, the same way any other small envelope
 * type already works.
 *
 * §7.2.1 revision — deterministic objId, not a local pointer: the original
 * design used WebKey.generateGenesisObjId (a fresh random 16-byte nonce
 * every call, so it hashed to something different each time) and tracked
 * the resulting objId in localStorage, keyed by DID, since nothing else
 * could rediscover it. That meant recovery only ever worked on the exact
 * device/browser that created the backup — and the scenarios that
 * actually drive someone to need recovery (dead machine, wiped/corrupted
 * profile, switched devices) are exactly the scenarios most likely to
 * have *also* destroyed that pointer, since both live in the same
 * browser storage. Replaced with a fixed per-identity objId —
 * Crypto.js's computeWalletBackupObjId(did) = base64url(SHA-256(did +
 * ':wallet-backup'))[0..12] — so any device that can authenticate as this
 * DID recomputes the exact same objId and can fetch/decrypt without any
 * prior local state. Accepted tradeoff, decided deliberately (not a gap):
 * a backup's *existence* becomes probeable by anyone who knows the DID
 * (a 403-vs-404 distinction on GET) — never the ciphertext itself, which
 * stays exactly as protected as before by _canReadEnvelope's owner-only
 * check plus the KEK/DEK encryption layer.
 *
 * A legacy local pointer (the old localStorage-keyed objId) is still
 * read, on a device that has one, purely to migrate that backup's
 * ciphertext across to the new deterministic objId the first time it's
 * needed (see _resolve) — never written for anything created from here
 * on.
 *
 * "Delete," similarly, can only ever mean "overwrite the current version
 * with inert content," never true server-side erasure — objects.db is an
 * append-only version log (same fact FilesBrowser._deleteFile's own
 * comment documents for files). See deleteBackup's own comment.
 *
 * Async pattern: thenDo(err, result), matching the rest of
 * lively.identity.*.
 */

module('lively.identity.WalletBackup')
  .requires(
    'lively.identity.WalletBridge',
    'lively.identity.Crypto',
    'lively.identity.WebAuthn',
    'lively.identity.DID',
  )
  .toRun(function () {

Object.subclass('lively.identity.WalletBackup',

// ─── KEK (identity's own Files-encryption-plane key, not the vault's) ───

'kek', {

  // Same withKek pattern as FileCrypto._withKek/PostCardEditor._saveNowPrivate
  // — reuse the session's cached KEK, otherwise prompt once via a fresh
  // WebAuthn ceremony (onWaiting lets a caller show "Confirm passkey…").
  _withKek: function (user, onWaiting, thenDo) {
    var wa = lively.identity.webAuthn;
    if (wa._kekCache && wa._kekCache[user.credentialId]) {
      return thenDo(null, wa._kekCache[user.credentialId]);
    }
    if (onWaiting) onWaiting();
    var ch = new Uint8Array(32);
    crypto.getRandomValues(ch);
    wa.deriveKek({ credentialId: user.credentialId, rpId: user.rpId, challenge: ch }, thenDo);
  },

},

// ─── legacy local pointer (pre-§7.2.1-revision devices only) ────────────
//     Superseded by the deterministic objId below (Crypto.js
//     computeWalletBackupObjId) — kept only so a device that still has one
//     can migrate a backup created before this revision. Never written to
//     for anything new.

'legacy local pointer', {

  _objIdKey: function (did) {
    return 'lively.wallet.filesBackupObjId.' + did;
  },

  _getLegacyObjId: function (did) {
    return window.localStorage.getItem(this._objIdKey(did));
  },

  _clearLegacyObjId: function (did) {
    window.localStorage.removeItem(this._objIdKey(did));
  },

},

// ─── server I/O (plain PUT/GET /@:handle/:objId, §3's universal envelope
//     route — no new server storage mechanism, §7.2's own point) ────────

'server', {

  _putEnvelope: function (handle, envelope, thenDo) {
    var base = lively.identity.did.baseUrl();
    fetch(base + '/@' + handle + '/' + envelope.objId, {
      method: 'PUT',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(envelope),
    }).then(function (res) {
      if (!res.ok) return res.json().then(function (b) {
        throw new Error(b.error || ('wallet-backup save failed: ' + res.status));
      });
      return res.json();
    }).then(function (body) { thenDo(null, body); })
      .catch(function (e) { thenDo(e); });
  },

  // Resolves null (not an error) on a 404 — every caller here treats "no
  // envelope at this objId" as a normal not-yet-created case, not a hard
  // failure by itself.
  _getEnvelope: function (handle, objId, thenDo) {
    var base = lively.identity.did.baseUrl();
    fetch(base + '/@' + handle + '/' + objId, { credentials: 'include' })
      .then(function (res) {
        if (res.status === 404) return null;
        if (!res.ok) throw new Error('wallet-backup fetch failed: ' + res.status);
        return res.json();
      })
      .then(function (envelope) { thenDo(null, envelope); })
      .catch(function (e) { thenDo(e); });
  },

  // Overwrites the envelope at objId with inert, provably-undecryptable
  // content (a throwaway, immediately-discarded KEK). objects.db is
  // append-only, so this retires a version rather than truly erasing it.
  // Shared by deleteBackup and by the legacy-pointer migration in
  // _resolve below, which retires the pre-revision envelope once its
  // content has been re-addressed under the new deterministic objId.
  // Takes the full `user` record (not just handle/did) since it now has to
  // sign the envelope — see _signEnvelopeIfPossible's own header.
  _tombstone: function (user, objId, prevCid, thenDo) {
    var self = this;
    var c = lively.identity.crypto;
    var throwawayKek = new Uint8Array(32);
    crypto.getRandomValues(throwawayKek);
    c.wrapDek(throwawayKek, function (err, dekResult) {
      if (err) return thenDo(err);
      c.encryptPayload({ deleted: true }, dekResult.dek, function (err2, encrypted) {
        if (err2) return thenDo(err2);
        c.computeCid(encrypted.ciphertext, function (err3, cid) {
          if (err3) return thenDo(err3);
          var tombstone = {
            objId: objId,
            did: user.did,
            type: 'wallet-backup',
            visibility: 'private',
            created: new Date().toISOString(),
            record: {
              cid: cid,
              prevCid: prevCid,
              payload: encrypted.ciphertext,
              nonce: encrypted.nonce,
              wrappedDek: dekResult.wrappedDek,
              recipients: [],
            },
            state: {},
          };
          self._signEnvelopeIfPossible(tombstone, user, c, function (signErr, signed) {
            if (signErr) return thenDo(signErr);
            self._putEnvelope(user.handle, signed || tombstone, thenDo);
          });
        });
      });
    });
  },

  // Mirrors SignedSerializer._signEnvelopeIfPossible / PostCardSerializer.js's
  // own copy of the same helper — this codebase's established pattern is a
  // module-local copy per serializer rather than one shared function (see
  // PostCardSerializer.js/WikiSerializer.js/PartSerializer.js, each with
  // their own). Needed here because WalletBackup builds its envelopes by
  // hand rather than going through SignedSerializer, so it never picked up
  // this step when signature verification became mandatory server-side
  // (postcard_audit.md F20, 2026-09-05) — every write was landing unsigned
  // and getting 403'd. Gracefully degrades to an unsigned envelope only if
  // delegation/soft-key setup isn't present at all. If that setup IS
  // present but the KEK can't actually be derived, the account's DID
  // document already commits it to signing, so the deriveKek error itself
  // is propagated as fatal rather than silently producing an unsigned
  // envelope the server's mandatory signature check is guaranteed to 403.
  _signEnvelopeIfPossible: function (envelope, user, c, thenDo) {
    var method = lively.identity.did.findMethodByCredentialId(user.document, user.credentialId);
    if (!method || !method.lively) return thenDo(null, envelope);
    var livelyMeta = method.lively;
    if (!livelyMeta.softSigningKeyWrapped || !livelyMeta.delegationCert) return thenDo(null, envelope);
    var wa = lively.identity.webAuthn;
    if (!wa) return thenDo(null, envelope);

    var ch = new Uint8Array(32);
    crypto.getRandomValues(ch);
    wa.deriveKek({ credentialId: user.credentialId, rpId: user.rpId, challenge: ch }, function (err, kek) {
      if (err) {
        return thenDo(err);
      }
      var wrapped;
      try { wrapped = JSON.parse(livelyMeta.softSigningKeyWrapped); } catch (e) { return thenDo(e); }
      c.decryptPayload(wrapped.ciphertext, wrapped.nonce, kek, function (err, softPrivJwk) {
        if (err) return thenDo(err);
        c.importPrivateKeyJwk(softPrivJwk, function (err, softPrivKey) {
          if (err) return thenDo(err);
          var envelopeToSign = Object.assign({}, envelope);
          delete envelopeToSign.sig;
          c.signJws(envelopeToSign, softPrivKey, function (err, sig) {
            if (err) return thenDo(err);
            thenDo(null, Object.assign({}, envelope, { sig: sig }));
          });
        });
      });
    });
  },

},

// ─── create / refresh / recover / delete (§9.2's own actions; §7.2.1
//     revision: deterministic per-identity objId, so finding a backup
//     never depends on local device state — see Crypto.js
//     computeWalletBackupObjId for the reasoning) ─────────────────────

'backup', {

  // Resolves this identity's wallet-backup objId and whatever's currently
  // there, computing the deterministic objId fresh every call. If nothing
  // exists yet there but this device still has a legacy (pre-revision)
  // local pointer, migrates it transparently first: the
  // ciphertext/nonce/wrappedDek/cid are re-addressed as-is under the new
  // deterministic objId — no decryption needed, none of those fields
  // depend on objId — the old envelope is tombstoned, and the legacy
  // pointer is forgotten. onProgress(stage) — 'resolving', then
  // 'migrating' if a legacy backup gets pulled in — lets a caller surface
  // what's happening rather than one opaque wait; pass a no-op for a
  // silent check (status() does). Calls thenDo(null, { objId, exists,
  // envelope }).
  _resolve: function (user, onProgress, thenDo) {
    var self = this;
    onProgress('resolving');
    lively.identity.crypto.computeWalletBackupObjId(user.did, function (err, objId) {
      if (err) return thenDo(err);
      self._getEnvelope(user.handle, objId, function (err2, envelope) {
        if (err2) return thenDo(err2);
        if (envelope) return thenDo(null, { objId: objId, exists: true, envelope: envelope });

        var legacyObjId = self._getLegacyObjId(user.did);
        if (!legacyObjId || legacyObjId === objId) {
          return thenDo(null, { objId: objId, exists: false, envelope: null });
        }

        self._getEnvelope(user.handle, legacyObjId, function (err3, legacy) {
          if (err3) return thenDo(err3);
          if (!legacy) {
            self._clearLegacyObjId(user.did);
            return thenDo(null, { objId: objId, exists: false, envelope: null });
          }
          onProgress('migrating');

          var migrated = {
            objId: objId,
            did: user.did,
            type: 'wallet-backup',
            visibility: 'private',
            created: new Date().toISOString(),
            record: {
              cid: legacy.record.cid,
              prevCid: null,
              payload: legacy.record.payload,
              nonce: legacy.record.nonce,
              wrappedDek: legacy.record.wrappedDek,
              recipients: [],
            },
            state: {},
          };
          self._signEnvelopeIfPossible(migrated, user, lively.identity.crypto, function (signErr, signed) {
            if (signErr) return thenDo(signErr);
            self._putEnvelope(user.handle, signed || migrated, function (errPut) {
              if (errPut) return thenDo(errPut);
              // Migration succeeding is what matters; a failed tombstone of
              // the now-superseded legacy envelope isn't worth failing the
              // whole resolve over.
              self._tombstone(user, legacyObjId, legacy.record.cid, function () {
                self._clearLegacyObjId(user.did);
                thenDo(null, { objId: objId, exists: true, envelope: migrated });
              });
            });
          });
        });
      });
    });
  },

  // Encrypts the vault's own opaque exported blob (§3.4 exportBackupBlob —
  // already ciphertext; this module never sees a decrypted mnemonic) under
  // the identity's OWN existing Files-encryption-plane DEK/KEK
  // (Encryption.md §2-3, the same primitives FileCrypto.js uses for a
  // private file's metadata), then PUTs it as a type: 'wallet-backup'
  // envelope. onProgress(stage): 'exporting' → 'waiting-passkey' (only if
  // the KEK isn't already cached) → 'encrypting' → 'uploading' — a caller
  // showing one flat "Confirm passkey…" for this whole multi-step chain
  // was flagged as confusing, since most of the wait isn't the passkey at
  // all. Calls thenDo(null, { objId }).
  _encryptAndPut: function (objId, prevCid, onProgress, thenDo) {
    var self = this;
    var c = lively.identity.crypto;
    var user = lively.identity.did.currentUser();
    if (!user) return thenDo(new Error('WalletBackup: no identity session active'));

    onProgress('exporting');
    lively.identity.walletBridge.exportBackupBlob(function (err, blob) {
      if (err) return thenDo(err);
      self._withKek(user, function () { onProgress('waiting-passkey'); }, function (err2, kek) {
        if (err2) return thenDo(err2);
        onProgress('encrypting');
        c.wrapDek(kek, function (err3, dekResult) {
          if (err3) return thenDo(err3);
          c.encryptPayload(blob, dekResult.dek, function (err4, encrypted) {
            if (err4) return thenDo(err4);
            c.computeCid(encrypted.ciphertext, function (err5, cid) {
              if (err5) return thenDo(err5);
              var envelope = {
                objId: objId,
                did: user.did,
                type: 'wallet-backup',
                visibility: 'private',
                created: new Date().toISOString(),
                record: {
                  cid: cid,
                  prevCid: prevCid || null,
                  payload: encrypted.ciphertext,
                  nonce: encrypted.nonce,
                  wrappedDek: dekResult.wrappedDek,
                  recipients: [],
                },
                state: {},
              };
              self._signEnvelopeIfPossible(envelope, user, c, function (signErr, signed) {
                if (signErr) return thenDo(signErr);
                onProgress('uploading');
                self._putEnvelope(user.handle, signed || envelope, function (err6) {
                  if (err6) return thenDo(err6);
                  thenDo(null, { objId: objId });
                });
              });
            });
          });
        });
      });
    });
  },

  // Calls thenDo(null, { exists, objId }) — a real (single GET) network
  // check now rather than a local synchronous read: the whole point of
  // the deterministic objId is that "does a backup exist" is a server
  // fact, not local device state. May also transparently migrate a legacy
  // backup in (see _resolve).
  status: function (thenDo) {
    var self = this;
    var user = lively.identity.did.currentUser();
    if (!user) return thenDo(new Error('WalletBackup: no identity session active'));
    self._resolve(user, function () {}, function (err, r) {
      if (err) return thenDo(err);
      thenDo(null, { exists: r.exists, objId: r.objId });
    });
  },

  // Human-readable label for each onProgress(stage) value create/refresh/
  // recoverBackup emit — centralized here so the UI call sites (Wallet.js,
  // WalletSetupDialog.js) don't duplicate/drift on wording.
  progressLabel: function (stage) {
    return {
      resolving:         'Checking…',
      migrating:         'Migrating existing backup…',
      exporting:         'Preparing…',
      'waiting-passkey': 'Confirm passkey…',
      encrypting:        'Encrypting…',
      uploading:         'Uploading…',
      decrypting:        'Decrypting…',
      installing:        'Installing…',
    }[stage] || stage;
  },

  // Creates a fresh wallet-backup envelope. Errors if one already exists
  // at this identity's deterministic objId (including one just migrated
  // in from a legacy pointer) — use refreshBackup to update an existing
  // one instead (§9.2: create/refresh/delete are distinct actions, not
  // one "save" button). onProgress(stage) — see _resolve/_encryptAndPut
  // for the stage sequence.
  createBackup: function (onProgress, thenDo) {
    var self = this;
    var user = lively.identity.did.currentUser();
    if (!user) return thenDo(new Error('WalletBackup: no identity session active'));
    self._resolve(user, onProgress, function (err, r) {
      if (err) return thenDo(err);
      if (r.exists) {
        return thenDo(new Error('createBackup: a backup already exists for this identity — use refreshBackup instead'));
      }
      self._encryptAndPut(r.objId, null, onProgress, thenDo);
    });
  },

  // Re-encrypts and re-uploads the SAME wallet-backup envelope (e.g. after
  // changing unlock methods, or just to confirm it's still current) —
  // chains record.prevCid correctly (same versioning convention every
  // other envelope type uses). onProgress(stage) — see _resolve/
  // _encryptAndPut for the stage sequence.
  refreshBackup: function (onProgress, thenDo) {
    var self = this;
    var user = lively.identity.did.currentUser();
    if (!user) return thenDo(new Error('WalletBackup: no identity session active'));
    self._resolve(user, onProgress, function (err, r) {
      if (err) return thenDo(err);
      if (!r.exists) {
        return thenDo(new Error('refreshBackup: no backup exists yet for this identity — use createBackup first'));
      }
      self._encryptAndPut(r.objId, r.envelope.record.cid, onProgress, thenDo);
    });
  },

  // Recovery: reverse of createBackup/refreshBackup. Recomputes this
  // identity's deterministic objId (§7.2.1 revision — works from any
  // device that can authenticate as this DID, no local pointer needed),
  // decrypts the fetched envelope (this module's own Files-encryption-
  // plane KEK/DEK — the SAME crypto create/refresh already use, reversed),
  // and reinstalls the resulting opaque vault blob directly into this
  // identity's vault record via WalletBridge.importBackupBlob. Never
  // touches the decrypted mnemonic itself: what this decrypts is still the
  // vault's own opaque, separately-encrypted blob (§7.2's whole point —
  // the vault's own encryption is a second, independent layer this module
  // never has the keys to open). WalletVault's own importBackupBlob
  // refuses to overwrite an already-set-up wallet, so this is safe to
  // offer even if the caller isn't sure whether one already exists.
  // onProgress(stage): 'resolving' → 'waiting-passkey' (only if the KEK
  // isn't already cached) → 'decrypting' → 'installing'.
  recoverBackup: function (onProgress, thenDo) {
    var self = this;
    var c = lively.identity.crypto;
    var user = lively.identity.did.currentUser();
    if (!user) return thenDo(new Error('WalletBackup: no identity session active'));
    self._resolve(user, onProgress, function (err, r) {
      if (err) return thenDo(err);
      if (!r.exists) {
        return thenDo(new Error('recoverBackup: no backup found for this identity'));
      }
      self._withKek(user, function () { onProgress('waiting-passkey'); }, function (err2, kek) {
        if (err2) return thenDo(err2);
        onProgress('decrypting');
        c.unwrapDek(r.envelope.record.wrappedDek, kek, function (err3, dek) {
          if (err3) return thenDo(err3);
          c.decryptPayload(r.envelope.record.payload, r.envelope.record.nonce, dek, function (err4, blob) {
            if (err4) return thenDo(err4);
            onProgress('installing');
            lively.identity.walletBridge.importBackupBlob(blob, thenDo);
          });
        });
      });
    });
  },

  // Per this module's own header: "delete" can only ever mean "overwrite
  // the current version with inert content," never true server-side
  // erasure — objects.db is an append-only version log, so an older
  // ciphertext version is not guaranteed gone. Needs no passkey/password
  // prompt: unlike create/refresh, nothing here needs the real KEK, so
  // there's no multi-step wait worth surfacing — stays a plain thenDo.
  // Calls thenDo(null) if there was nothing to delete.
  deleteBackup: function (thenDo) {
    var self = this;
    var user = lively.identity.did.currentUser();
    if (!user) return thenDo(new Error('WalletBackup: no identity session active'));
    self._resolve(user, function () {}, function (err, r) {
      if (err) return thenDo(err);
      if (!r.exists) return thenDo(null);
      self._tombstone(user, r.objId, r.envelope.record.cid, function (errPut) {
        thenDo(errPut || null);
      });
    });
  },

});

lively.identity.walletBackup = new lively.identity.WalletBackup();

}); // end module('lively.identity.WalletBackup')
