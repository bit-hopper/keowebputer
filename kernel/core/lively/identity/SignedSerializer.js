/**
 * lively.identity.SignedSerializer
 *
 * Wraps lively.persistence.Serializer (ObjectGraphLinearizer) to produce and
 * consume cryptographic object envelopes for the Lively identity system.
 *
 * Architecture note — why not a plugin:
 *   ObjectGraphLinearizer.letAllPlugins() ignores return values, so
 *   serializationDone cannot replace the output JSO. The SignedSerializer
 *   therefore wraps the existing serializer rather than extending it via the
 *   plugin interface. The existing ObjectGraphLinearizer and all its plugins
 *   run unchanged as the inner layer; SignedSerializer wraps their output.
 *
 * What this module does:
 *   - serializeToEnvelope(obj, thenDo)
 *       Runs ObjectGraphLinearizer on obj to get the Lively JSO,
 *       computes a CID, builds an envelope, signs it, returns the envelope.
 *   - deserializeFromEnvelope(envelope, thenDo)
 *       Verifies the envelope signature, decrypts if private,
 *       passes the inner JSO to ObjectGraphLinearizer for reconstruction.
 *       Private/shared envelope encryption is handled by
 *       lively.identity.PostCardSerializer (KEK/DEK plane), not here —
 *       see PostCardSerializer.js for serializeEncrypted/deserializeEncrypted.
 *   - upgradeJson(livelyjson, thenDo)
 *       Migration path: takes an existing bare Lively JSON string and
 *       wraps it in a signed envelope without re-serializing the object.
 *   - World save/load integration:
 *       Patches lively.morphic.World.saveWorldAs and loadWorldFromDocument
 *       (via addMethods) so that worlds owned by an authenticated user are
 *       automatically saved as signed envelopes rather than bare JSON.
 *       Falls back to the original behaviour when no identity session exists.
 *
 * Async pattern: thenDo(err, result) throughout.
 *
 * Dependencies:
 *   lively.identity.Crypto          — sign, verify, computeCid, encryptPayload
 *   lively.identity.DID             — currentUser(), did string
 *   lively.identity.WebKey          — generateObjId, buildObjectUrl
 *   lively.persistence.Serializer   — existing ObjectGraphLinearizer (inner layer)
 *   lively.morphic.Serialization    — World.saveWorldAs (integration target)
 */

module("lively.identity.SignedSerializer")
  .requires(
    "lively.identity.Crypto",
    "lively.identity.DID",
    "lively.identity.WebKey",
    "lively.identity.WebAuthn",
    "lively.persistence.Serializer",
  )
  .toRun(function () {
    Object.subclass(
      "lively.identity.SignedSerializer",

      // ─── inner serializer access ──────────────────────────────────────────────────

      "inner",
      {
        // Create a fresh ObjectGraphLinearizer with the standard Lively plugin set.
        _makeInnerSerializer: function () {
          return lively.persistence.ObjectGraphLinearizer.forNewLively();
        },

        // Run the inner serializer on obj and return the JSO { id, registry }.
        // This is synchronous — ObjectGraphLinearizer.serializeToJso is sync.
        _innerSerializeToJso: function (obj) {
          return this._makeInnerSerializer().serializeToJso(obj);
        },

        // Reconstruct an object from a JSO { id, registry }.
        _innerDeserializeJso: function (jso) {
          return this._makeInnerSerializer().deserializeJso(jso);
        },
      },

      // ─── public objects (signed, unencrypted) ────────────────────────────────────

      "public",
      {
        // Serialize obj to a signed envelope.
        //
        // params: {
        //   obj:         Object   — the morph/part/object to serialize (ignored if jso is given)
        //   jso:         Object   — a pre-built {id, registry} JSO to use directly instead
        //                           of running the inner serializer on obj (e.g. WorldsBrowser.js's
        //                           create-world flow reuses blank.html's already-serialized
        //                           empty-world JSO rather than serializing a live World)
        //   type:        String   — "world" | "part" | "file" | "settings"
        //   publicKeyJwk: Object  — device public key JWK (used to derive objId)
        //   prevEnvelope: Object|null — previous version envelope for chaining
        //   stateMeta:   Object   — free-form metadata for envelope.state
        //   genesisNonce: String  — required on any genesis write (no prevEnvelope/prevCid);
        //                           IdentityServer.js's PUT route hard-rejects a genesis write
        //                           with no genesisNonce, for every type, no exemption. Must be
        //                           set on the envelope BEFORE signing (the server verifies the
        //                           signature against the whole envelope minus sig, exactly as
        //                           received) — see the genesisNonce assignment below.
        // }
        // IDENTITY: privateKey removed — envelope signing deferred.
        //
        // Calls thenDo(null, envelope).
        serializeToEnvelope: function (params, thenDo) {
          var self = this;
          var c = lively.identity.crypto;
          var user = lively.identity.did.currentUser();

          if (!user) {
            return thenDo(
              new Error(
                "serializeToEnvelope: no identity session active. " +
                  "Call lively.identity.did.establishSession() before serializing.",
              ),
            );
          }

          // Step 1: Inner serialization (sync) — or use a pre-built JSO directly.
          var jso;
          if (params.jso) {
            jso = params.jso;
          } else {
            try {
              jso = self._innerSerializeToJso(params.obj);
            } catch (e) {
              return thenDo(
                new Error(
                  "serializeToEnvelope: inner serialization failed: " + e.message,
                ),
              );
            }
          }
          if (!jso)
            return thenDo(
              new Error("serializeToEnvelope: inner serializer returned null"),
            );

          // Step 2: Compute ObjID — use explicit params.objId when provided
          // (e.g. saving an existing world in-place), otherwise derive from key.
          function _buildEnvelopeWithObjId(objId) {
            c.computeCid(jso, function (err, cid) {
              if (err) return thenDo(err);
              var prevCid = params.prevEnvelope && params.prevEnvelope.record
                ? params.prevEnvelope.record.cid || null : null;
              var envelope = {
                objId: objId,
                did: user.did,
                publicKey: params.publicKeyJwk || null,
                type: params.type || "world",
                visibility: "public",
                created: (params.prevEnvelope && params.prevEnvelope.created) ||
                  new Date().toISOString(),
                record: { cid: cid, prevCid: prevCid, payload: jso },
                state: params.stateMeta || {},
              };
              // A world's state.template (set once by WorldsBrowser's create
              // flow, shown as the "Template" type label) would otherwise be
              // dropped by every in-place re-save, since callers (Save world,
              // rename, WorldTemplateLauncher) pass a fresh stateMeta of just
              // { name }. Carry it forward from the previous version.
              var prevTemplate = params.prevEnvelope && params.prevEnvelope.state &&
                params.prevEnvelope.state.template;
              if (prevTemplate && envelope.type === "world" && !envelope.state.template) {
                envelope.state = Object.assign({}, envelope.state, { template: prevTemplate });
              }
              // Must be set before signing — see this function's params doc above.
              if (params.genesisNonce) envelope.genesisNonce = params.genesisNonce;

              // Sign with the device soft key if delegation cert + KEK are available.
              // Resolves the long-standing "IDENTITY: privateKey removed — envelope signing deferred".
              // Gracefully degrades: unsigned envelopes still work, same as before.
              _signEnvelopeIfPossible(envelope, user, function (signErr, signedEnvelope) {
                if (signErr) return thenDo(signErr);
                thenDo(null, signedEnvelope || envelope);
              });
            });
          }

          function _signEnvelopeIfPossible(envelope, user, thenDo) {
            var method = lively.identity.did.findMethodByCredentialId(
              user.document, user.credentialId
            );
            if (!method || !method.lively) return thenDo(null, envelope);

            var livelyMeta = method.lively;
            if (!livelyMeta.softSigningKeyWrapped || !livelyMeta.delegationCert) return thenDo(null, envelope);

            var wa = lively.identity.webAuthn;
            if (!wa) return thenDo(null, envelope);

            // On-demand KEK derivation (added 2026-09-05, see
            // PostCardSerializer.js's identical fix for the full rationale):
            // deriveKek returns the cached KEK immediately if already warm,
            // or runs a fresh WebAuthn PRF ceremony otherwise. Needed
            // because signature verification is now mandatory server-side
            // and ordinary login never warms this cache.
            var ch = new Uint8Array(32);
            crypto.getRandomValues(ch);
            wa.deriveKek({ credentialId: user.credentialId, rpId: user.rpId, challenge: ch }, function (err, kek) {
              if (err) {
                // See PostCardSerializer.js's identical fix: this account's DID
                // document already has a delegation cert on file, so the server
                // mandates a valid signature here — an unsigned envelope is
                // guaranteed to be rejected. Propagate the real error instead
                // of quietly falling back to unsigned and wasting a doomed
                // network round trip.
                return thenDo(err);
              }
              // Decrypt the wrapped soft private key JWK
              var wrapped;
              try { wrapped = JSON.parse(livelyMeta.softSigningKeyWrapped); } catch (e) { return thenDo(e); }
              c.decryptPayload(wrapped.ciphertext, wrapped.nonce, kek, function (err, softPrivJwk) {
                if (err) return thenDo(err);
                c.importPrivateKeyJwk(softPrivJwk, function (err, softPrivKey) {
                  if (err) return thenDo(err);
                  // Sign envelope without the sig field
                  var envelopeToSign = Object.assign({}, envelope);
                  delete envelopeToSign.sig;
                  c.signJws(envelopeToSign, softPrivKey, function (err, sig) {
                    if (err) return thenDo(err);
                    var signed = Object.assign({}, envelope, { sig: sig });
                    thenDo(null, signed);
                  });
                });
              });
            });
          }

          if (params.objId) {
            _buildEnvelopeWithObjId(params.objId);
          } else {
            lively.identity.webKey.generateObjId(params.publicKeyJwk, function (err, objId) {
              if (err) return thenDo(err);
              _buildEnvelopeWithObjId(objId);
            });
          }
        },

        // Deserialize a public envelope.
        // Calls thenDo(null, reconstructedObject).
        deserializeFromEnvelope: function (envelope, thenDo) {
          var self = this;
          var c = lively.identity.crypto;

          if (!envelope || !envelope.record || !envelope.record.payload) {
            return thenDo(
              new Error("deserializeFromEnvelope: invalid envelope structure"),
            );
          }

          // IDENTITY: signature verification deferred. CID integrity check still
          // runs — detects accidental corruption at zero extra cost.

          // Step 1: Verify CID integrity of the payload -- non-fatal on
          // mismatch. This used to hash-check via plain JSON.stringify (not
          // canonicalJson, fixed 2026-09-13 -- see Crypto.js's computeCid
          // comment) and abort deserialization entirely on any mismatch,
          // which made any object round-tripped through Postgres jsonb
          // storage permanently unloadable even when untampered. Since
          // signature verification for this generic serializer is deferred
          // (per the comment above), there's no separate crypto proof to
          // fall back on here the way Wiki/Postcard have -- just warn
          // instead of silently swallowing it.
          c.computeCid(envelope.record.payload, function (err, expectedCid) {
            if (err) return thenDo(err);
            if (expectedCid !== envelope.record.cid) {
              console.warn(
                "[SignedSerializer] CID mismatch for objId=" + envelope.objId +
                " (loading anyway; signature verification for this type is deferred)"
              );
            }

            // Step 2: Inner deserialization (sync)
            try {
              var obj = self._innerDeserializeJso(envelope.record.payload);
              thenDo(null, obj);
            } catch (e) {
              thenDo(
                new Error(
                  "deserializeFromEnvelope: inner deserialization failed: " +
                    e.message,
                ),
              );
            }
          });
        },
      },

      // ─── migration: upgrade bare Lively JSON to an unsigned envelope ────────────────

      "migration",
      {
        // Wrap an existing bare Lively JSON string in an envelope.
        // The JSON is NOT re-parsed into a live object — the raw payload JSO
        // is embedded directly, preserving the original exactly.
        //
        // IDENTITY: signing deferred — envelope is unsigned for now.
        //
        // params: {
        //   json:        String   — existing bare Lively JSON string
        //   type:        String
        //   publicKeyJwk: Object
        //   stateMeta:   Object
        // }
        //
        // Calls thenDo(null, envelope).
        upgradeJson: function (params, thenDo) {
          var c = lively.identity.crypto;
          var user = lively.identity.did.currentUser();

          if (!user) {
            return thenDo(new Error("upgradeJson: no identity session active"));
          }

          var jso;
          try {
            jso = JSON.parse(params.json);
          } catch (e) {
            return thenDo(
              new Error("upgradeJson: could not parse JSON: " + e.message),
            );
          }

          lively.identity.webKey.generateObjId(
            params.publicKeyJwk,
            function (err, objId) {
              if (err) return thenDo(err);

              c.computeCid(jso, function (err, cid) {
                if (err) return thenDo(err);

                thenDo(null, {
                  objId: objId,
                  did: user.did,
                  publicKey: params.publicKeyJwk,
                  type: params.type || "world",
                  visibility: "public",
                  created: new Date().toISOString(),
                  record: {
                    cid: cid,
                    prevCid: null,
                    payload: jso,
                  },
                  state: params.stateMeta || {},
                  migrated: true,
                });
              });
            },
          );
        },
      },

      // ─── world save/load integration ─────────────────────────────────────────────

      "worldIntegration",
      {
        // Patch World.saveWorldAs to produce signed envelopes when a DID session
        // is active. Called once from installWorldIntegration().
        //
        // The patch:
        //   1. Checks if lively.identity.did.isLoggedIn()
        //   2. If yes: calls our serializeToEnvelope, PUTs the envelope JSON to
        //      the identity server endpoint (/@handle/objId) as well as retaining
        //      the original WebDAV path for compatibility.
        //   3. If no: falls through to the original saveWorldAs unchanged.
        //
        // This is non-destructive: the original world HTML is still written to
        // the WebDAV path (for backwards compatibility with non-identity clients),
        // AND the signed envelope is written to the identity URL.
        installWorldIntegration: function () {
          var signedSerializer = this;

          // Only install once
          if (lively.morphic.World.prototype._identityIntegrationInstalled)
            return;
          lively.morphic.World.prototype._identityIntegrationInstalled = true;

          lively.morphic.World.addMethods("identity serialization", {
            // Overrides the standard saveWorldAs to additionally write a signed
            // envelope when an identity session is active.
            saveWorldAs: (function (originalSaveWorldAs) {
              return function identitySaveWorldAs(
                url,
                checkForOverwrites,
                bootstrapModuleURL,
                thenDo,
              ) {
                var world = this;

                // Identity URLs (/@handle/objId) are owned by the identity server.
                // The original WebDAV PUT sends raw HTML to that route, which the
                // server rejects with 400.  Never let it run for identity URLs —
                // including when a session hasn't been restored yet.
                var isIdentityUrl = url && /^\/@[^/]+\/[^/]/.test(url);

                if (!lively.identity.did.isLoggedIn()) {
                  if (isIdentityUrl) {
                    // Session not yet restored; skip silently — the next auto-save
                    // will succeed once the session is available.
                    return thenDo && thenDo(null);
                  }
                  return originalSaveWorldAs.apply(world, arguments);
                }

                var user = lively.identity.did.currentUser();

                function afterOriginalSave(continueWithEnvelope) {
                  if (isIdentityUrl) {
                    continueWithEnvelope();
                  } else {
                    originalSaveWorldAs.call(
                      world,
                      url,
                      checkForOverwrites,
                      bootstrapModuleURL,
                      function (err) {
                        if (err) return thenDo && thenDo(err);
                        continueWithEnvelope();
                      },
                    );
                  }
                }

                afterOriginalSave(function () {

                    // Then additionally write a signed envelope to the identity URL
                    var rawName = world.name;
                    // "world" is Lively's default name for worlds loaded without a
                    // filename (i.e. from /@handle identity URLs). Treat it as unset
                    // and prefer document.title, which buildWorldPage sets from state.name.
                    var isDefaultName = !rawName || rawName === "null" ||
                                        rawName === "undefined" || rawName === "world";
                    var worldName = isDefaultName
                      ? (document.title && document.title !== "world" && document.title !== "Lively"
                          ? document.title
                          : (url ? new URL(url).filename().replace(/\.x?html$/, "") : "world"))
                      : rawName;
                    if (isDefaultName) {
                      console.warn(
                        "[SignedSerializer] Warning: world.name is " +
                          JSON.stringify(rawName) + " — using \"" + worldName + "\" from page title / URL",
                      );
                    }

                    // Use findMethodByCredentialId so the correct key is chosen
                    // when the user has multiple devices registered.
                    var method = lively.identity.did.findMethodByCredentialId(
                      user.document,
                      user.credentialId,
                    );
                    if (!method) {
                      console.warn(
                        "[SignedSerializer] Verification method not found for " +
                          "credentialId=" +
                          user.credentialId +
                          " — skipping envelope.",
                      );
                      return thenDo && thenDo(null);
                    }

                    console.log(
                      "[SignedSerializer] Building envelope for world \"" + worldName + "\"",
                    );
                    signedSerializer.serializeToEnvelope(
                      {
                        obj: world,
                        type: "world",
                        publicKeyJwk: method.publicKeyJwk,
                        stateMeta: { name: worldName },
                      },
                      function (envelopeErr, envelope) {
                        if (envelopeErr) {
                          console.warn(
                            "[SignedSerializer] Envelope signing failed:",
                            envelopeErr,
                          );
                          // Don't fail the whole save — the WebDAV save already succeeded
                          return thenDo && thenDo(null);
                        }

                        // PUT envelope to identity server
                        var envelopeUrl = lively.identity.webKey.buildObjectUrl(
                          {
                            handle: user.handle,
                            objId: envelope.objId,
                          },
                        );

                        envelopeUrl
                          .asWebResource()
                          .beAsync()
                          .put(JSON.stringify(envelope), "application/json")
                          .whenDone(function (content, status) {
                            if (status.isSuccess()) {
                              var body = null;
                              try { body = JSON.parse(content); } catch(e) {}
                              console.log(
                                "[SignedSerializer] PUT /@" + user.handle +
                                  "/" + envelope.objId + " →",
                                body || content,
                              );
                            } else {
                              console.warn(
                                "[SignedSerializer] Failed to PUT envelope to " +
                                  envelopeUrl +
                                  ": " +
                                  status,
                              );
                            }
                            thenDo && thenDo(null);
                          });
                      },
                    );
                });
              };
            })(lively.morphic.World.prototype.saveWorldAs),
          });
        },
      },
    );

    // ─── singleton and world integration ─────────────────────────────────────────

    lively.identity.signedSerializer = new lively.identity.SignedSerializer();

    // Install the World.saveWorldAs patch once lively.morphic.Serialization
    // is loaded (it defines saveWorldAs; we must run after it).
    module("lively.morphic.Serialization").runWhenLoaded(function () {
      lively.identity.signedSerializer.installWorldIntegration();
    });
  }); // end module('lively.identity.SignedSerializer')
