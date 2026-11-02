/**
 * lively.identity.EnvelopeSigning
 *
 * Shared "sign this envelope if the account has device-key delegation set
 * up" helper. Extracted out of PostCardSerializer.js's closure-private
 * _signEnvelopeIfPossible so a new caller (RoomCrypto.js, for room-key-epoch
 * envelopes) can reuse the exact same signing logic instead of forking it —
 * PostCardSerializer.js's version was unreachable from outside that file
 * (plain function in its module closure, never exported).
 *
 * FileCrypto.js and SignedSerializer.js keep their own pre-existing copies
 * of this same logic for now; this extraction is scoped to PostCardSerializer
 * and RoomCrypto only, not a repo-wide consolidation.
 *
 * Dependencies:
 *   lively.identity.Crypto     — decryptPayload, importPrivateKeyJwk, signJws
 *   lively.identity.DID        — findMethodByCredentialId
 *   lively.identity.WebAuthn   — deriveKek
 */

module('lively.identity.EnvelopeSigning')
  .requires(
    'lively.identity.Crypto',
    'lively.identity.DID',
    'lively.identity.WebAuthn',
  )
  .toRun(function () {

    Object.subclass('lively.identity.EnvelopeSigning', {

      // envelope: the built, unsigned envelope.
      // user: lively.identity.did.currentUser().
      // c: lively.identity.crypto.
      // Calls thenDo(null, envelope) — unchanged if this account doesn't sign,
      // or with .sig attached if it does — or thenDo(err) if this account's
      // DID document expects a signature but producing one failed (e.g. the
      // user cancelled the WebAuthn prompt). Callers must propagate that
      // error rather than falling back to sending the envelope unsigned —
      // the server mandatorily rejects unsigned envelopes for any account
      // with delegation configured (postcard_audit.md F20).
      signEnvelopeIfPossible: function (envelope, user, c, thenDo) {
        var method = lively.identity.did.findMethodByCredentialId(user.document, user.credentialId);
        if (!method || !method.lively) return thenDo(null, envelope);
        var livelyMeta = method.lively;
        if (!livelyMeta.softSigningKeyWrapped || !livelyMeta.delegationCert) return thenDo(null, envelope);
        var wa = lively.identity.webAuthn;
        if (!wa) return thenDo(null, envelope);

        var ch = new Uint8Array(32);
        crypto.getRandomValues(ch);
        wa.deriveKek({ credentialId: user.credentialId, rpId: user.rpId, challenge: ch }, function (err, kek) {
          if (err) return thenDo(err);
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

    });

    // Singleton
    lively.identity.envelopeSigning = new lively.identity.EnvelopeSigning();

  }); // end module('lively.identity.EnvelopeSigning')
