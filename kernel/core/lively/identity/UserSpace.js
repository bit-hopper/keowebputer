/**
 * lively.identity.UserSpace
 *
 * The user's identity-rooted object index: home manifest CRUD, world/part/file
 * registration, and a PartsSpace-compatible personal parts provider.
 *
 * The home manifest is an unsigned envelope stored under the objId derived from
 * the user's primary device key (verificationMethod[0].publicKeyJwk):
 *
 *   objId = computeObjId(primaryDevicePublicKeyJwk)
 *
 * This gives a stable, user-unique identifier that is consistent across sessions
 * and devices. It does not collide with world/part envelopes because those use
 * per-object freshly-generated key pairs (via SignedSerializer).
 *
 * IDENTITY: Envelope signing deferred — manifests are stored unsigned for now.
 * When WebAuthn assertion signing is added (future iteration), saveHomeManifest
 * will take a challenge + rpId and produce a sig via navigator.credentials.get.
 *
 * Manifest payload shape:
 *   {
 *     did:    String,
 *     worlds: [{ objId, cid, title, url }, ...],
 *     parts:  { [category]: [{ objId, cid, title, partName }, ...] },
 *     files:  [{ objId, cid, title, mimeType }, ...]
 *   }
 *
 * All writes are local-first: the envelope is stored in IndexedDB (via
 * ObjectStore), then synced to the identity server. Sync failure is non-fatal.
 *
 * Async convention: thenDo(err, result) throughout.
 *
 * Dependencies:
 *   lively.identity.DID         — currentUser(), isLoggedIn()
 *   lively.identity.Crypto      — computeObjId, computeCid
 *   lively.identity.ObjectStore — local IndexedDB cache + server sync
 */

module("lively.identity.UserSpace")
  .requires(
    "lively.identity.DID",
    "lively.identity.Crypto",
    "lively.identity.WebAuthn",
    "lively.identity.ObjectStore",
    "lively.identity.IdentityPartsSpace",
    "lively.PartsBin",
  )
  .toRun(function () {

    Object.subclass(
      "lively.identity.UserSpace",

      // ─── identity delegation ──────────────────────────────────────────────────────

      "identity",
      {
        // Delegate to DID for the in-memory session record.
        // Returns { did, handle, displayName, credentialId, rpId, document }
        // or null if not logged in.
        currentUser: function () {
          return lively.identity.did.currentUser();
        },

        // Retroactively run the delegation-cert + KEK + X25519 ceremony for
        // the CURRENT device, for an account that skipped "Enable encryption"
        // at registration (RegisterDialog.js's _promptEnableEncryption) or
        // whose PRF ceremony failed then — until this runs, `accountX25519Pub`
        // is never published, so nobody can send them a private/shared
        // postcard or file (PostCardEditor._resolveRecipientPubKeys and
        // FileCrypto's recipient sealing both read it from the profile and
        // fail closed with "hasn't set up encryption yet" when it's absent).
        // Same combined-PRF-ceremony shape as RegisterDialog.js (one prompt
        // for delegation sig + KEK + X25519 rather than two) — kept as a
        // fresh implementation here rather than extracted from RegisterDialog,
        // which is hardened against real, previously-debugged browser quirks
        // (see its module doc comment) that a refactor risks disturbing.
        //
        // Publishes to: (1) the current device's verification method in the
        // DID document — a real PUT with a propagated error, not
        // DID.saveDocument's non-fatal-on-server-failure semantics, since a
        // silently-failed publish here reproduces exactly the
        // postcard_fixes_tranche3.md bug ("ceremony succeeded locally, server
        // never learned about it"); (2) the profile envelope's
        // `accountX25519Pub` field via saveProfile (merges, never replaces).
        //
        // Calls thenDo(null, { accountX25519Pub }) on success.
        enableEncryption: function (thenDo) {
          var self = this;
          var c = lively.identity.crypto;
          var wa = lively.identity.webAuthn;
          var user = this.currentUser();
          if (!user) return thenDo(new Error('enableEncryption: no identity session active'));

          c.generateSigningKeyPair(function (err, softKeyPair) {
            if (err) return thenDo(err);
            c.exportPublicKeyJwk(softKeyPair.publicKey, function (err, devicePubKeyJwk) {
              if (err) return thenDo(err);

              var issuedAt = new Date().toISOString();
              var delegationPayload = {
                devicePubKeyJwk: devicePubKeyJwk,
                credentialId: user.credentialId,
                issuedAt: issuedAt,
              };

              c.sha256(c.canonicalJson(delegationPayload), function (err, digestB64) {
                if (err) return thenDo(err);
                var certChallenge = c.base64urlDecode(digestB64);
                var prfKekInput = new TextEncoder().encode('lively-kek-v1');
                var prfX25519Input = new TextEncoder().encode('lively-x25519:' + user.credentialId);

                navigator.credentials.get({
                  publicKey: {
                    challenge: certChallenge,
                    rpId: user.rpId,
                    allowCredentials: [{ type: 'public-key', id: c.base64urlDecode(user.credentialId) }],
                    userVerification: 'required',
                    extensions: { prf: { eval: { first: prfKekInput.buffer, second: prfX25519Input.buffer } } },
                  },
                }).then(function (credential) {
                  var assertion = credential.response;
                  var ext = credential.getClientExtensionResults();
                  var prfResults = ext && ext.prf && ext.prf.results;
                  if (!prfResults || !prfResults.first || !prfResults.second) {
                    return thenDo(new Error(
                      'enableEncryption: PRF extension not available for this credential/browser — ' +
                      're-register with a PRF-capable authenticator to enable encryption.'
                    ));
                  }

                  var delegationCert = {
                    devicePubKeyJwk: devicePubKeyJwk,
                    credentialId: user.credentialId,
                    issuedAt: issuedAt,
                    authenticatorData: c.base64urlEncode(new Uint8Array(assertion.authenticatorData)),
                    clientDataJSON: c.base64urlEncode(new Uint8Array(assertion.clientDataJSON)),
                    signature: c.base64urlEncode(new Uint8Array(assertion.signature)),
                  };

                  var kek = new Uint8Array(prfResults.first);
                  wa.cacheKek(user.credentialId, kek);

                  c.exportPrivateKeyJwk(softKeyPair.privateKey, function (err, softPrivJwk) {
                    if (err) return thenDo(err);
                    c.encryptPayload(softPrivJwk, kek, function (err, enc) {
                      if (err) return thenDo(err);
                      var softSigningKeyWrapped = JSON.stringify({ ciphertext: enc.ciphertext, nonce: enc.nonce });

                      c.withSodium(function (err, sodium) {
                        if (err) return thenDo(err);
                        var x25519Pub;
                        try {
                          var privBytes = new Uint8Array(prfResults.second);
                          // X25519 private key clamping (RFC 7748) — same as
                          // WebAuthn.deriveX25519KeyPair/RegisterDialog.js.
                          privBytes[0] &= 248;
                          privBytes[31] &= 127;
                          privBytes[31] |= 64;
                          var pubBytes = sodium.crypto_scalarmult_base(privBytes);
                          x25519Pub = sodium.to_base64(pubBytes, sodium.base64_variants.URLSAFE_NO_PADDING);
                        } catch (e) { return thenDo(e); }

                        self._publishDelegationFields(user, {
                          delegationCert: delegationCert,
                          softSigningKeyWrapped: softSigningKeyWrapped,
                          accountX25519Pub: x25519Pub,
                        }, function (err) {
                          if (err) return thenDo(err);
                          thenDo(null, { accountX25519Pub: x25519Pub });
                        });
                      });
                    });
                  });
                }).catch(function (e) {
                  thenDo(new Error('Encryption setup failed (' + e.name + '): ' + e.message));
                });
              });
            });
          });
        },

        // Merge delegation fields into the CURRENT device's verification
        // method and publish: a real server PUT (errors propagate — see
        // enableEncryption's comment on why this can't reuse
        // DID.saveDocument's swallow-server-errors behavior here), a
        // best-effort local IndexedDB copy, then the profile's
        // accountX25519Pub (merged via saveProfile, not replaced).
        _publishDelegationFields: function (user, fields, thenDo) {
          var self = this;
          var did = lively.identity.did;
          fetch('/@' + user.handle + '/did-document', { credentials: 'include' })
            .then(function (res) {
              if (!res.ok) throw new Error('Could not fetch current DID document (HTTP ' + res.status + ')');
              return res.json();
            })
            .then(function (doc) {
              var method = did.findMethodByCredentialId(doc, user.credentialId);
              if (!method) throw new Error('enableEncryption: current device credential not found in DID document');
              method.lively = Object.assign({}, method.lively, fields);
              doc.updated = new Date().toISOString();

              return fetch('/@' + user.handle + '/did-document', {
                method: 'PUT',
                credentials: 'include',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(doc),
              }).then(function (res) {
                if (!res.ok) throw new Error('Could not publish DID document update (HTTP ' + res.status + ')');
                // Keep the live, in-memory currentUser() in sync with what
                // the server now has -- `user` here is the same object
                // DID.currentUser() returns (enableEncryption passes it
                // through by reference, not a copy), so this is what every
                // later signEnvelopeIfPossible call in THIS session reads to
                // find its device's delegationCert/softSigningKeyWrapped.
                // Without this, those calls keep using the now-orphaned
                // pre-rotation key pair (whatever findMethodByCredentialId
                // last saw at login/restoreSession time) while the server
                // verifies against the NEW one just published above --
                // every signature produced afterward in this session fails
                // with "no verification method validated the signature"
                // until the page is reloaded. Confirmed live 2026-10-02.
                user.document = doc;
                // Best-effort local copy — failure here doesn't block the
                // (already-succeeded) server publish other users depend on.
                did.saveDocument(doc, function () {});
                self.saveProfile({ accountX25519Pub: fields.accountX25519Pub }, thenDo);
              });
            })
            .catch(function (err) { thenDo(err); });
        },
      },

      // ─── home manifest ────────────────────────────────────────────────────────────

      "home manifest",
      {
        // Derive the stable home manifest objId from the primary device public key.
        // The genesis device key (verificationMethod[0]) is used so the objId is
        // consistent even when new devices are added to the DID document.
        // Calls thenDo(err, objId).
        _homeObjId: function (user, thenDo) {
          var methods =
            user.document && user.document.verificationMethod;
          if (!methods || !methods[0] || !methods[0].publicKeyJwk) {
            return thenDo(
              new Error(
                "UserSpace: DID document missing verificationMethod[0].publicKeyJwk",
              ),
            );
          }
          lively.identity.crypto.computeObjId(methods[0].publicKeyJwk, thenDo);
        },

        // Load the home manifest payload (local ObjectStore first, server fallback).
        // Returns the parsed payload or null if no manifest exists yet.
        // Calls thenDo(null, payload | null).
        getHomeManifest: function (thenDo) {
          var user = this.currentUser();
          if (!user) return thenDo(new Error("UserSpace: not logged in"));

          var self = this;
          this._homeObjId(user, function (err, objId) {
            if (err) return thenDo(err);

            // ObjectStore is the authoritative local source.
            lively.identity.objectStore.get(objId, function (err, envelope) {
              if (err) return thenDo(err);
              if (
                envelope &&
                envelope.record &&
                envelope.record.payload !== undefined
              ) {
                return thenDo(null, envelope.record.payload);
              }

              // Fall back to server. GET /@handle/:objId returns the envelope.
              fetch("/@" + user.handle + "/" + objId, { credentials: "include" })
                .then(function (res) {
                  if (res.status === 404) return void thenDo(null, null);
                  if (!res.ok) {
                    throw new Error(
                      "UserSpace.getHomeManifest: HTTP " +
                        res.status +
                        " from /@" +
                        user.handle +
                        "/" +
                        objId,
                    );
                  }
                  return res.json().then(function (serverEnvelope) {
                    // Cache locally with CID integrity check.
                    lively.identity.objectStore._verifyAndPut(
                      serverEnvelope,
                      function (cacheErr) {
                        if (cacheErr) {
                          console.warn(
                            "[UserSpace] Could not cache home manifest locally:",
                            cacheErr,
                          );
                        }
                        thenDo(
                          null,
                          serverEnvelope.record
                            ? serverEnvelope.record.payload
                            : null,
                        );
                      },
                    );
                  });
                })
                .catch(thenDo);
            });
          });
        },

        // Save the home manifest payload as a CID-chained envelope.
        // IDENTITY: envelope is unsigned for now — signing deferred to a future
        // iteration where WebAuthn assertion signing is implemented.
        // Calls thenDo(null, { objId, cid }) on success.
        saveHomeManifest: function (payload, thenDo) {
          var user = this.currentUser();
          if (!user) return thenDo(new Error("UserSpace: not logged in"));

          var methods = user.document && user.document.verificationMethod;
          if (!methods || !methods[0] || !methods[0].publicKeyJwk) {
            return thenDo(
              new Error("UserSpace: DID document missing verificationMethod"),
            );
          }
          var publicKeyJwk = methods[0].publicKeyJwk;
          var c = lively.identity.crypto;

          c.computeObjId(publicKeyJwk, function (err, objId) {
            if (err) return thenDo(err);

            // Load previous local version to chain prevCid.
            lively.identity.objectStore.get(objId, function (err, prevEnvelope) {
              if (err) return thenDo(err);

              c.computeCid(payload, function (err, cid) {
                if (err) return thenDo(err);

                var prevCid =
                  prevEnvelope && prevEnvelope.record
                    ? prevEnvelope.record.cid
                    : null;

                var envelope = {
                  objId: objId,
                  did: user.did,
                  publicKey: publicKeyJwk,
                  type: "home-manifest",
                  visibility: "public",
                  // created is fixed at genesis; subsequent versions keep the same
                  // timestamp so it reflects when the object first appeared.
                  created: prevEnvelope
                    ? prevEnvelope.created
                    : new Date().toISOString(),
                  record: {
                    cid: cid,
                    prevCid: prevCid,
                    payload: payload,
                  },
                  state: {},
                };

                lively.identity.objectStore.put(envelope, function (err) {
                  if (err) return thenDo(err);

                  // Non-fatal sync: local save already succeeded.
                  lively.identity.objectStore.syncObject(
                    objId,
                    user.handle,
                    window.location.origin,
                    function (syncErr) {
                      if (syncErr) {
                        console.warn(
                          "[UserSpace] Server sync failed (will retry at next sync):",
                          syncErr,
                        );
                      }
                      thenDo(null, { objId: objId, cid: cid });
                    },
                  );
                });
              });
            });
          });
        },

        // Replace an entry (matched by objId) in a list, or append if not found.
        _upsertList: function (list, entry) {
          for (var i = 0; i < list.length; i++) {
            if (list[i].objId === entry.objId) {
              list[i] = entry;
              return;
            }
          }
          list.push(entry);
        },

        // Read-modify-write the home manifest via mutator(manifest).
        // Creates a genesis manifest if none exists.
        // Calls thenDo(err, { objId, cid }).
        //
        // TOCTOU: concurrent calls from two tabs will both read the same
        // version, apply independent mutations, and the second write wins —
        // the first mutation is silently lost. Acceptable for now; a
        // server-side compare-and-swap (If-Match: <cid>) will be needed
        // before collaborative editing or multi-tab write merging.
        _updateManifest: function (mutator, thenDo) {
          var user = this.currentUser();
          if (!user) return thenDo(new Error("UserSpace: not logged in"));

          var self = this;
          this.getHomeManifest(function (err, manifest) {
            if (err) return thenDo(err);
            manifest = manifest || {
              did: user.did,
              worlds: [],
              parts: {},
              files: [],
            };
            mutator(manifest);
            self.saveHomeManifest(manifest, thenDo);
          });
        },

        // Register a world in the home manifest.
        // entry: { objId, cid, title, url }
        // Calls thenDo(null, { objId, cid }) after saving.
        addWorld: function (entry, thenDo) {
          var self = this;
          this._updateManifest(function (manifest) {
            manifest.worlds = manifest.worlds || [];
            self._upsertList(manifest.worlds, entry);
          }, thenDo);
        },

        // Register a part in the home manifest under the given category.
        // entry: { objId, cid, title, partName }
        // Calls thenDo(null, { objId, cid }) after saving.
        addPart: function (category, entry, thenDo) {
          var self = this;
          this._updateManifest(function (manifest) {
            manifest.parts = manifest.parts || {};
            manifest.parts[category] = manifest.parts[category] || [];
            self._upsertList(manifest.parts[category], entry);
          }, thenDo);
        },

        // Register a file in the home manifest.
        // entry: { objId, cid, title, mimeType }
        // Calls thenDo(null, { objId, cid }) after saving.
        addFile: function (entry, thenDo) {
          var self = this;
          this._updateManifest(function (manifest) {
            manifest.files = manifest.files || [];
            self._upsertList(manifest.files, entry);
          }, thenDo);
        },
      },

      // ─── parts space integration ──────────────────────────────────────────────────

      "parts space integration",
      {
        // Return a lively.identity.IdentityPartsSpace for this user's personal
        // parts. Registers it with the global lively.PartsBin registry so that
        // PartItem.getPartsSpace() can resolve it by name.
        // Calls thenDo(null, IdentityPartsSpace).
        getPersonalPartsSpace: function (thenDo) {
          var user = this.currentUser();
          if (!user) return thenDo(new Error("UserSpace: not logged in"));
          var space = new lively.identity.IdentityPartsSpace(user.handle, user.did);
          lively.PartsBin.addPartsSpace(space);
          thenDo(null, space);
        },
      },

      // ─── profile ──────────────────────────────────────────────────────────────

      "profile",
      {
        // Fetch the current user's full profile envelope from the server.
        // Returns null (not an error) if no profile exists yet.
        // Calls thenDo(null, envelope | null).
        getProfile: function (thenDo) {
          var user = this.currentUser();
          if (!user) return thenDo(new Error("UserSpace: not logged in"));
          fetch("/@" + user.handle + "/profile", { credentials: "include" })
            .then(function (res) {
              if (res.status === 404) return thenDo(null, null);
              if (!res.ok)
                throw new Error("UserSpace.getProfile: HTTP " + res.status);
              return res.json().then(function (env) { thenDo(null, env); });
            })
            .catch(thenDo);
        },

        // Save updated profile data. Reads existing envelope for objId/prevCid
        // chain, computes a new CID, and PUTs to /@handle/profile.
        // payload: { displayName, bio, avatarUrl, bannerUrl, links }
        // Calls thenDo(null, { objId, cid, changed }) on success.
        saveProfile: function (payload, thenDo) {
          var user = this.currentUser();
          if (!user) return thenDo(new Error("UserSpace: not logged in"));
          var c = lively.identity.crypto;
          var self = this;

          self.getProfile(function (err, existing) {
            if (err) return thenDo(err);
            if (!existing)
              return thenDo(
                new Error(
                  "UserSpace.saveProfile: no profile found — server creates one at registration",
                ),
              );

            // Merge onto the existing payload rather than replacing it outright:
            // this editor's payload only carries display fields (displayName,
            // bio, avatarUrl, ...), never accountX25519Pub (set once at
            // registration, see RegisterDialog.js). Replacing wholesale would
            // silently wipe a previously-published encryption key on every
            // profile edit, breaking new shared-postcard sends to this user
            // from that point on (postcard-audit F26).
            //
            // updatedAt keeps every version's cid unique: profiles are
            // public plaintext, so editing a field X->Y->X would otherwise
            // reproduce an earlier version's exact payload/cid and be
            // rejected by ObjectRepository as a cid collision.
            var mergedPayload = Object.assign({}, existing.record.payload || {}, payload, { updatedAt: new Date().toISOString() });

            c.computeCid(mergedPayload, function (err, cid) {
              if (err) return thenDo(err);

              var primaryKey =
                user.document &&
                user.document.verificationMethod &&
                user.document.verificationMethod[0]
                  ? user.document.verificationMethod[0].publicKeyJwk
                  : null;

              var envelope = {
                objId:      existing.objId,
                did:        user.did,
                publicKey:  primaryKey,
                type:       "profile",
                visibility: "public",
                created:    existing.created || new Date().toISOString(),
                record:     { cid: cid, prevCid: existing.record.cid, payload: mergedPayload },
                state:      { name: "profile" },
              };

              // Sign the envelope if possible (postcard-audit F22) — same
              // opportunistic pattern as SignedSerializer/PostCardSerializer;
              // profile envelopes were previously never signed anywhere,
              // including the accountX25519Pub other users' clients read to
              // seal a shared postcard's DEK.
              _signProfileEnvelopeIfPossible(envelope, function (signErr, signedEnvelope) {
                if (signErr) console.warn('[UserSpace] Could not sign profile envelope (non-fatal):', signErr.message);

                fetch("/@" + user.handle + "/profile", {
                  method: "PUT",
                  credentials: "include",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify(signedEnvelope || envelope),
                })
                  .then(function (res) {
                    if (!res.ok)
                      return res.json().then(function (b) {
                        throw new Error(
                          b.error || "PUT profile HTTP " + res.status,
                        );
                      });
                    return res.json().then(function (r) { thenDo(null, r); });
                  })
                  .catch(thenDo);
              });
            });
          });
        },
      },

      // ─── domain handles ──────────────────────────────────────────────────────

      "domain handles",
      {
        // List the current user's (or `handle`'s) verified/invalid domain
        // handles. Calls thenDo(null, [{ domain, status, verifiedAt, lastCheckedAt }]).
        listDomains: function (handle, thenDo) {
          var user = this.currentUser();
          var target = handle || (user && user.handle);
          if (!target) return thenDo(new Error("UserSpace: not logged in"));
          fetch("/@" + target + "/domains", { credentials: "include" })
            .then(function (res) {
              if (!res.ok) throw new Error("UserSpace.listDomains: HTTP " + res.status);
              return res.json().then(function (r) { thenDo(null, r.domains || []); });
            })
            .catch(thenDo);
        },

        // Ask the server to fetch and verify https://<domain>/.well-known/lively-did
        // against the current user's DID, and register it on success.
        // The caller is responsible for having already published the signed
        // document at that URL (see ProfileCard.js's "Generate & Verify" flow,
        // which builds it via lively.identity.webKey.signWellKnown).
        // Calls thenDo(null, { domain }) on success, thenDo(err) otherwise
        // (err.message carries the server's rejection reason, e.g. signature
        // mismatch or the domain being unreachable).
        verifyDomain: function (domain, thenDo) {
          var user = this.currentUser();
          if (!user) return thenDo(new Error("UserSpace: not logged in"));
          fetch("/@" + user.handle + "/domains", {
            method: "POST",
            credentials: "include",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ domain: domain }),
          })
            .then(function (res) {
              return res.json().then(function (body) {
                if (!res.ok) throw new Error(body.error || "POST domains HTTP " + res.status);
                thenDo(null, body);
              });
            })
            .catch(thenDo);
        },

        // Remove a previously-verified domain handle. Calls thenDo(err).
        removeDomain: function (domain, thenDo) {
          var user = this.currentUser();
          if (!user) return thenDo(new Error("UserSpace: not logged in"));
          fetch("/@" + user.handle + "/domains/" + encodeURIComponent(domain), {
            method: "DELETE",
            credentials: "include",
          })
            .then(function (res) {
              if (!res.ok)
                return res.json().then(function (b) {
                  throw new Error(b.error || "DELETE domains HTTP " + res.status);
                });
              thenDo(null);
            })
            .catch(thenDo);
        },
      },
    );

    lively.identity.userSpace = new lively.identity.UserSpace();

    // Mirrors SignedSerializer.js / PostCardSerializer.js's private
    // _signEnvelopeIfPossible — signs with the device's soft signing key if
    // a delegation cert and cached KEK are available, no-ops otherwise.
    function _signProfileEnvelopeIfPossible(envelope, thenDo) {
      var did = lively.identity.did;
      var user = did.currentUser();
      if (!user) return thenDo(null, envelope);
      var method = did.findMethodByCredentialId(user.document, user.credentialId);
      if (!method || !method.lively) return thenDo(null, envelope);
      var livelyMeta = method.lively;
      if (!livelyMeta.softSigningKeyWrapped || !livelyMeta.delegationCert) return thenDo(null, envelope);
      var wa = lively.identity.webAuthn;
      if (!wa || !wa._kekCache || !wa._kekCache[user.credentialId]) return thenDo(null, envelope);
      var kek = wa._kekCache[user.credentialId];
      var c = lively.identity.crypto;
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
    }

  }); // end module('lively.identity.UserSpace')
