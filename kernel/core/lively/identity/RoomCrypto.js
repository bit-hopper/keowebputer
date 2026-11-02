/**
 * lively.identity.RoomCrypto
 *
 * Client-side crypto for E2EE room chat (e2eeclusters.md §3, Phase 1).
 * Everything server-side (schema, rotation-pending bookkeeping, the
 * /e2ee/members|epoch routes) already exists — see e2eeclusters.md §9.2.
 * This file is the piece that was still missing per §9.3: the actual
 * room-key mint/rotate/seal/unseal operations and message-level
 * encrypt/decrypt. It does NOT build or send room-message envelopes itself
 * (RoomView.js's job, still open per §9.3) — it hands back ciphertext/nonce/
 * epoch (encryptMessage) or a decrypted payload (decryptMessage) and leaves
 * envelope construction/XHR-send to the caller, same division of labor
 * PostCardSerializer.js keeps from PostCardEditor.js.
 *
 * Room-key-epoch envelope shape (mintInitialEpoch/rotateEpoch write this):
 *   type: 'postcard', visibility: 'shared' (always has recipients — every
 *   current effective member, including whoever minted it: there is no
 *   KEK-owner distinction here, unlike PostCardSerializer's private/shared
 *   postcards — the minter reads their own DEK back the exact same way
 *   every other member does, via their own sealedDek entry).
 *   record: { cid, prevCid: null, recipients: [{ did, sealedDek }, ...] }
 *     — never updated in place; a new epoch is always a fresh genesis
 *     object (ObjectRepository.getRoomKeyEpoch's own comment).
 *   state: { kind: 'room-key-epoch', roomId, epoch }
 *
 * Room-message envelopes for an e2eeEnabled room (RoomView.js builds these,
 * NOT this file) carry record.payload = ciphertext (a plain string, not a
 * JSON wrapper object — the server never has anything to parse here),
 * record.nonce, and state.epoch — see IdentityServer.js's messages route
 * and ObjectRepository._runRoomMessageQuery for the server-side half of
 * this contract.
 *
 * Every member's account X25519 public key comes from their own published
 * profile (payload.accountX25519Pub, same field RegisterDialog.js writes at
 * registration) — the server's batch /e2ee/members route is a round-trip
 * optimization over fetching every member's /profile individually, NOT a
 * trust shortcut (that route's own header comment). This file independently
 * re-fetches and re-verifies each member's key against their own profile
 * envelope before ever sealing a room DEK to it — same integrity stance
 * PartSerializer.resolveRecipientPubKeys already takes for a single
 * recipient elsewhere. A profile CID mismatch alone is non-fatal here (see
 * _resolveAndVerifyMembers) — matches the rest of the codebase's policy
 * since the canonicalJson/jsonb-reordering fix
 * (project-cid-non-canonical-hash-bug) of treating a stale pre-2026-09-13
 * hash as a known artifact, not tampering — falling back to the profile
 * envelope's own signature when one exists, and only blocking on an
 * actually-invalid signature.
 *
 * A member with no published X25519 key (or one that fails that
 * re-verification) BLOCKS the whole mint/rotate, loudly, naming who —
 * e2eeclusters.md §9's "Decisions locked in" list, never a silent
 * exclusion.
 *
 * Async pattern: thenDo(err, result) throughout, matching every other
 * identity serializer in this codebase.
 *
 * Dependencies:
 *   lively.identity.Crypto          — computeCid, encryptPayload/decryptPayload,
 *                                     sealForRecipient, openSealedBox
 *   lively.identity.DID             — currentUser(), baseUrl()
 *   lively.identity.WebKey          — generateGenesisObjId
 *   lively.identity.WebAuthn        — deriveX25519KeyPair
 *   lively.identity.EnvelopeSigning — signEnvelopeIfPossible
 */

module('lively.identity.RoomCrypto')
  .requires(
    'lively.identity.Crypto',
    'lively.identity.DID',
    'lively.identity.WebKey',
    'lively.identity.WebAuthn',
    'lively.identity.EnvelopeSigning',
  )
  .toRun(function () {

    // ─── small private XHR helper ──────────────────────────────────────────
    // thenDo(err, status, json) — network/transport errors call thenDo(err)
    // with no further args; anything that got an HTTP response (including a
    // 4xx/5xx) calls thenDo(null, status, parsedBodyOrNull) and leaves the
    // status check to the caller, same shape RoomView.js's own inline XHRs
    // already use.
    function _xhrJson(method, url, body, thenDo) {
      var xhr = new XMLHttpRequest();
      xhr.open(method, url, true);
      xhr.withCredentials = true;
      if (body !== undefined && body !== null) {
        xhr.setRequestHeader('Content-Type', 'application/json');
      }
      xhr.onload = function () {
        var json = null;
        if (xhr.responseText) {
          try { json = JSON.parse(xhr.responseText); } catch (e) { /* leave null */ }
        }
        thenDo(null, xhr.status, json);
      };
      xhr.onerror = function () {
        thenDo(new Error(method + ' ' + url + ': network error'));
      };
      xhr.send(body !== undefined && body !== null ? JSON.stringify(body) : undefined);
    }

    function _roomPath(constellationName, roomId) {
      return '/c/' + encodeURIComponent(constellationName) + '/rooms/' + roomId;
    }

    Object.subclass('lively.identity.RoomCrypto',

    'members', {

      // Fetches /e2ee/members, then independently re-verifies each member's
      // accountX25519Pub against their own fetched /profile envelope (cid
      // recompute, same check PartSerializer.resolveRecipientPubKeys does
      // for one recipient) before trusting it for sealing.
      //
      // Calls thenDo(null, { verified: [{ did, handle, x25519PublicKey }],
      //                       missing: [{ did, handle, reason }] }).
      _resolveAndVerifyMembers: function (constellationName, roomId, thenDo) {
        var c = lively.identity.crypto;
        var base = lively.identity.did.baseUrl();
        var url = base + _roomPath(constellationName, roomId) + '/e2ee/members';

        _xhrJson('GET', url, null, function (err, status, json) {
          if (err) return thenDo(err);
          if (status !== 200) {
            return thenDo(new Error('_resolveAndVerifyMembers: GET /e2ee/members failed (' + status + ')'));
          }
          var candidates = (json && json.members) || [];
          if (!candidates.length) return thenDo(null, { verified: [], missing: [] });

          var verified = [];
          var missing = [];
          var remaining = candidates.length;
          function done() {
            if (--remaining === 0) thenDo(null, { verified: verified, missing: missing });
          }

          candidates.forEach(function (member) {
            if (!member.accountX25519Pub) {
              missing.push({ did: member.did, handle: member.handle, reason: 'no published X25519 key' });
              return done();
            }
            if (!member.handle) {
              // Can't independently re-fetch /@handle/profile without a
              // handle — treat as unverifiable rather than trusting the
              // batch route's claim outright.
              missing.push({ did: member.did, handle: null, reason: 'no handle to verify against' });
              return done();
            }
            var profileUrl = base + '/@' + encodeURIComponent(member.handle) + '/profile';
            _xhrJson('GET', profileUrl, null, function (err2, status2, profileJson) {
              if (err2 || status2 !== 200 || !profileJson || !profileJson.record) {
                missing.push({ did: member.did, handle: member.handle, reason: 'profile fetch failed' });
                return done();
              }
              var payload = profileJson.record.payload;
              var pub = payload && payload.accountX25519Pub;
              if (!pub) {
                missing.push({ did: member.did, handle: member.handle, reason: 'profile has no X25519 key' });
                return done();
              }
              c.computeCid(payload, function (cidErr, cid) {
                var cidOk = !cidErr && cid === profileJson.record.cid;
                var pubMatchesBatch = pub === member.accountX25519Pub;
                var cidMatchesBatch = profileJson.record.cid === member.profileCid;
                if (!pubMatchesBatch || !cidMatchesBatch) {
                  missing.push({ did: member.did, handle: member.handle, reason: 'X25519 key failed re-verification' });
                  return done();
                }
                if (cidOk) {
                  verified.push({ did: member.did, handle: member.handle, x25519PublicKey: pub });
                  return done();
                }
                // CID mismatch alone is non-fatal here, matching the rest of
                // the codebase's policy since the canonicalJson/jsonb-
                // reordering fix (project-cid-non-canonical-hash-bug):
                // pre-2026-09-13 profiles never had their stored cid
                // migrated, since doing so would invalidate their signature.
                // Opportunistically verify the profile's own signature
                // instead, when it has one — a present-but-invalid signature
                // IS real tamper evidence and still blocks; a missing
                // signature (true for every profile saved before signing
                // existed, e.g. accounts created mid-2026-08) doesn't, same
                // as every other read site in this codebase.
                console.warn('RoomCrypto._resolveAndVerifyMembers: CID mismatch for @' + member.handle +
                  ' (likely a pre-2026-09-13 non-canonical hash, not tampering) — falling back to signature check');
                if (!profileJson.sig) {
                  verified.push({ did: member.did, handle: member.handle, x25519PublicKey: pub });
                  return done();
                }
                lively.identity.did.resolveEnvelopeSignerJwk(member.handle, function (jwkErr, signerJwk) {
                  if (jwkErr || !signerJwk) {
                    // Couldn't resolve a signer key to check against — treat
                    // like "nothing to verify," not a failure; a DID-document
                    // fetch hiccup shouldn't block a member who has a signed
                    // profile we simply failed to cross-check this time.
                    verified.push({ did: member.did, handle: member.handle, x25519PublicKey: pub });
                    return done();
                  }
                  c.verifyEnvelopeIntegrity(profileJson, signerJwk, function (viErr, result) {
                    if (!viErr && result && result.sigStatus === 'invalid') {
                      missing.push({ did: member.did, handle: member.handle, reason: 'X25519 key failed signature re-verification' });
                      return done();
                    }
                    verified.push({ did: member.did, handle: member.handle, x25519PublicKey: pub });
                    done();
                  });
                });
              });
            });
          });
        });
      },

    },

    'epoch-fetch', {

      // Fetches the room-key-epoch envelope (current/highest if epoch is
      // null/undefined, a specific one otherwise). Calls thenDo(null, null)
      // — not an error — when none exists yet (a brand-new e2eeEnabled room
      // with no epoch minted, e2eeclusters.md §9.1). thenDo(err) for a real
      // transport/server failure.
      _fetchEpochEnvelope: function (constellationName, roomId, epoch, thenDo) {
        var base = lively.identity.did.baseUrl();
        var url = base + _roomPath(constellationName, roomId) + '/e2ee/epoch';
        if (epoch != null) url += '?epoch=' + encodeURIComponent(epoch);
        _xhrJson('GET', url, null, function (err, status, json) {
          if (err) return thenDo(err);
          if (status === 404) return thenDo(null, null);
          if (status !== 200) {
            return thenDo(new Error('_fetchEpochEnvelope: GET /e2ee/epoch failed (' + status + ')'));
          }
          thenDo(null, json && json.envelope);
        });
      },

    },

    'dek', {

      // Resolves the signed-in user's own room DEK for a given epoch (or
      // the current/highest one if epoch is null/undefined). Cached per
      // (roomId, resolved epoch) for the lifetime of this singleton — the
      // underlying X25519 keypair derivation is itself cached by
      // WebAuthn.deriveX25519KeyPair, but skipping the sealed-box open and
      // the network round trip on every message matters for a chat that
      // polls.
      //
      // Calls thenDo(null, { dek: Uint8Array[32], epoch: Number }).
      getRoomDek: function (params, thenDo) {
        var self = this;
        var c = lively.identity.crypto;
        var wa = lively.identity.webAuthn;
        var user = lively.identity.did.currentUser();
        if (!user) return thenDo(new Error('getRoomDek: no identity session'));

        var constellationName = params.constellationName;
        var roomId = params.roomId;
        var epoch = params.epoch != null ? params.epoch : null;

        if (epoch != null && self._dekCache && self._dekCache[roomId + ':' + epoch]) {
          return thenDo(null, { dek: self._dekCache[roomId + ':' + epoch], epoch: epoch });
        }

        self._fetchEpochEnvelope(constellationName, roomId, epoch, function (err, envelope) {
          if (err) return thenDo(err);
          if (!envelope) {
            return thenDo(new Error('getRoomDek: no room key epoch found for room ' + roomId +
              (epoch != null ? (' at epoch ' + epoch) : '')));
          }
          var actualEpoch = envelope.state && envelope.state.epoch;
          if (!self._dekCache) self._dekCache = {};
          var cacheKey = roomId + ':' + actualEpoch;
          if (self._dekCache[cacheKey]) {
            return thenDo(null, { dek: self._dekCache[cacheKey], epoch: actualEpoch });
          }

          var myEntry = (envelope.record && envelope.record.recipients || []).find(function (r) {
            return r.did === user.did;
          });
          if (!myEntry) {
            return thenDo(new Error('getRoomDek: no sealed room key for you at epoch ' + actualEpoch +
              ' — you may not have been a member of this room when this epoch was minted'));
          }

          var ch = new Uint8Array(32);
          crypto.getRandomValues(ch);
          wa.deriveX25519KeyPair({ credentialId: user.credentialId, rpId: user.rpId, challenge: ch }, function (err2, pair) {
            if (err2) return thenDo(err2);
            c.openSealedBox(myEntry.sealedDek, pair.publicKey, pair.privateKey, function (err3, dek) {
              if (err3) return thenDo(err3);
              self._dekCache[cacheKey] = dek;
              thenDo(null, { dek: dek, epoch: actualEpoch });
            });
          });
        });
      },

      // Drops any cached DEK for a room (every epoch) — call after a
      // rotation this client itself performed or confirmed, since an older
      // cached epoch is still valid but a caller that only ever asks for
      // "the current epoch" would otherwise keep serving the stale one from
      // cache instead of re-fetching the new highest epoch.
      invalidateRoomDekCache: function (roomId) {
        if (!this._dekCache) return;
        var prefix = roomId + ':';
        Object.keys(this._dekCache).forEach(function (key) {
          if (key.indexOf(prefix) === 0) delete this._dekCache[key];
        }, this);
      },

    },

    'mint-rotate', {

      // Shared mint/rotate implementation. epoch: the epoch number this
      // call is minting (1 for mintInitialEpoch, currentEpoch+1 for
      // rotateEpoch). Not exposed directly — see the two public wrappers
      // below.
      _mintEpoch: function (params, epoch, thenDo) {
        var self = this;
        var c = lively.identity.crypto;
        var user = lively.identity.did.currentUser();
        if (!user) return thenDo(new Error('_mintEpoch: no identity session'));

        var constellationName = params.constellationName;
        var roomId = params.roomId;

        self._resolveAndVerifyMembers(constellationName, roomId, function (err, result) {
          if (err) return thenDo(err);
          if (result.missing.length) {
            var names = result.missing.map(function (m) {
              return (m.handle ? '@' + m.handle : m.did) + ' (' + m.reason + ')';
            }).join(', ');
            return thenDo(new Error(
              'Cannot mint room key epoch ' + epoch + ': missing or unverifiable X25519 key for: ' + names
            ));
          }
          var verified = result.verified;
          if (!verified.some(function (m) { return m.did === user.did; })) {
            return thenDo(new Error('_mintEpoch: you are not among this room\'s effective members'));
          }

          var dek = new Uint8Array(32);
          crypto.getRandomValues(dek);

          var recipientWraps = [];
          var remaining = verified.length;
          var hadError = false;
          verified.forEach(function (member) {
            c.sealForRecipient(dek, member.x25519PublicKey, function (err2, sealed) {
              if (hadError) return;
              if (err2) { hadError = true; return thenDo(err2); }
              recipientWraps.push({ did: member.did, sealedDek: sealed });
              if (--remaining === 0) _build();
            });
          });

          function _build() {
            c.computeCid(recipientWraps, function (err3, cid) {
              if (err3) return thenDo(err3);
              lively.identity.webKey.generateGenesisObjId(user.did, function (err4, genesis) {
                if (err4) return thenDo(err4);

                var envelope = {
                  objId: genesis.objId,
                  genesisNonce: genesis.genesisNonce,
                  did: user.did,
                  type: 'postcard',
                  visibility: 'shared',
                  created: new Date().toISOString(),
                  record: { cid: cid, prevCid: null, recipients: recipientWraps },
                  state: { kind: 'room-key-epoch', roomId: roomId, epoch: epoch },
                };

                lively.identity.envelopeSigning.signEnvelopeIfPossible(envelope, user, c, function (signErr, signed) {
                  if (signErr) return thenDo(signErr);
                  var toSend = signed || envelope;
                  var base = lively.identity.did.baseUrl();
                  var putUrl = base + '/@' + encodeURIComponent(user.handle) + '/' + encodeURIComponent(toSend.objId);
                  _xhrJson('PUT', putUrl, toSend, function (err5, status5) {
                    if (err5) return thenDo(err5);
                    if (status5 !== 200) {
                      return thenDo(new Error('_mintEpoch: PUT envelope failed (' + status5 + ')'));
                    }
                    var confirmUrl = base + _roomPath(constellationName, roomId) + '/e2ee/epoch';
                    _xhrJson('POST', confirmUrl, { objId: toSend.objId }, function (err6, status6) {
                      if (err6) return thenDo(err6);
                      if (status6 !== 201) {
                        return thenDo(new Error('_mintEpoch: confirm POST failed (' + status6 + ')'));
                      }
                      if (!self._dekCache) self._dekCache = {};
                      self._dekCache[roomId + ':' + epoch] = dek;
                      thenDo(null, { epoch: epoch, objId: toSend.objId });
                    });
                  });
                });
              });
            });
          }
        });
      },

      // Mints epoch 1 for a brand-new e2eeEnabled room. Fails loudly if an
      // epoch already exists for this room (use rotateEpoch instead) —
      // never silently overwrites/re-mints epoch 1.
      mintInitialEpoch: function (params, thenDo) {
        var self = this;
        self._fetchEpochEnvelope(params.constellationName, params.roomId, null, function (err, existing) {
          if (err) return thenDo(err);
          if (existing) {
            return thenDo(new Error('mintInitialEpoch: room ' + params.roomId +
              ' already has epoch ' + existing.state.epoch + ' — use rotateEpoch instead'));
          }
          self._mintEpoch(params, 1, thenDo);
        });
      },

      // Mints the next epoch (current highest + 1) after a membership
      // change. Fails loudly if no epoch exists yet (use mintInitialEpoch
      // instead — this is the "room exists but has no working key yet"
      // case e2eeclusters.md §9.1 folds into the same rotation-pending flag).
      rotateEpoch: function (params, thenDo) {
        var self = this;
        self._fetchEpochEnvelope(params.constellationName, params.roomId, null, function (err, current) {
          if (err) return thenDo(err);
          if (!current) {
            return thenDo(new Error('rotateEpoch: room ' + params.roomId +
              ' has no existing epoch — use mintInitialEpoch instead'));
          }
          self._mintEpoch(params, current.state.epoch + 1, thenDo);
        });
      },

      // Picks mintInitialEpoch or rotateEpoch automatically, depending on
      // whether this room already has an epoch — the single entry point a
      // "retry rotation" UI (RoomView.js's banner, RoomSettingsDialog.js)
      // should call. From that side there's no way to know in advance which
      // case applies: a brand-new e2eeEnabled room is born
      // e2ee_rotation_pending with no epoch minted yet (e2eeclusters.md
      // §9.1) — the exact same flag a post-creation membership-change
      // rotation sets — so "retry" has to cover both.
      ensureEpoch: function (params, thenDo) {
        var self = this;
        self._fetchEpochEnvelope(params.constellationName, params.roomId, null, function (err, current) {
          if (err) return thenDo(err);
          if (current) return self.rotateEpoch(params, thenDo);
          self.mintInitialEpoch(params, thenDo);
        });
      },

    },

    'message', {

      // Encrypts a JSON-serializable message payload under the room's
      // CURRENT epoch DEK. Calls thenDo(null, { ciphertext, nonce, epoch }).
      // The caller (RoomView.js) builds the actual room-message postcard
      // envelope from this (record.payload = ciphertext, record.nonce =
      // nonce, state.epoch = epoch, state.kind = 'room-message') — see this
      // file's header comment.
      encryptMessage: function (params, thenDo) {
        var c = lively.identity.crypto;
        this.getRoomDek({ constellationName: params.constellationName, roomId: params.roomId }, function (err, result) {
          if (err) return thenDo(err);
          c.encryptPayload(params.payload, result.dek, function (err2, encrypted) {
            if (err2) return thenDo(err2);
            thenDo(null, { ciphertext: encrypted.ciphertext, nonce: encrypted.nonce, epoch: result.epoch });
          });
        });
      },

      // Decrypts a room message's ciphertext/nonce under the epoch it was
      // actually encrypted with (not necessarily the room's current epoch —
      // a message from before the last rotation still needs that older
      // epoch's DEK, which a member present at the time keeps forever via
      // their own sealedDek entry on that epoch's never-updated envelope).
      // Calls thenDo(null, payload).
      decryptMessage: function (params, thenDo) {
        var c = lively.identity.crypto;
        if (params.epoch == null) return thenDo(new Error('decryptMessage: epoch is required'));
        this.getRoomDek({
          constellationName: params.constellationName,
          roomId: params.roomId,
          epoch: params.epoch
        }, function (err, result) {
          if (err) return thenDo(err);
          c.decryptPayload(params.ciphertext, params.nonce, result.dek, thenDo);
        });
      },

    });

    // Singleton
    lively.identity.roomCrypto = new lively.identity.RoomCrypto();

  }); // end module('lively.identity.RoomCrypto')
