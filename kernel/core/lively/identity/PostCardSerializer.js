/**
 * lively.identity.PostCardSerializer
 *
 * Serializes and deserializes post card envelopes for the Lively identity system.
 * Parallel to lively.identity.SignedSerializer, but for Yjs-based documents
 * rather than ObjectGraphLinearizer-based worlds/parts.
 *
 * Envelope payload shape (§3.2), wiki-mode postcards (PostcardDesignSpec-v2.md §2.4):
 *   record.payload = {
 *     format:      "yjs-update-v1",
 *     update:      "<base64url(Y.encodeStateAsUpdate(doc))>",
 *     snapshot:    <ProseMirror JSON from y-prosemirror>,
 *     attachments: [{ objId, dek, blobCid, blobNonce, name, mime }, ...]
 *       — Encryption.md §6: dek is null for public postcards (attachment
 *       blobs are already plaintext there); for private/shared cards each
 *       dek travels here in the clear (inside THIS ciphertext), so decrypting
 *       the card also unlocks its attachments with no separate reseal.
 *   }
 *
 * Status: the yjs-update-v1 pair above (serializeToEnvelope/
 * deserializeFromEnvelope, serializeEncrypted/deserializeEncrypted,
 * deserializeEncryptedAuto) is kept here ONLY for backward compatibility
 * with plain postcards saved before the plain/wiki split (confirmed still
 * present in the dev DB: ~400 type:'postcard' rows, public/private/shared,
 * with payload.format 'yjs-update-v1' and no wikiName — pre-split test
 * data, not migrated, per this codebase's established "no backfill"
 * posture elsewhere). Every NEW postcard goes through the plain pair
 * below. Wiki pages (type: 'wikipage') never use this file at all anymore
 * — see WikiSerializer.js, which now owns the Yjs-based pair for genuinely
 * new documents.
 *
 * Envelope payload shape, plain postcards (everything that is NOT a
 * constellation wiki page: standalone posts, constellation-feed posts, and
 * every sent/DM/self post card). No Yjs doc, no CRDT machinery — a plain
 * post card is single-author (or, once sent to someone else, frozen) so
 * there is no "shared" state to reconcile:
 *   record.payload = {
 *     format:      "prosemirror-doc-v1",
 *     doc:         <ProseMirror JSON document — IS the snapshot, no
 *                    separate extraction step needed>,
 *     partState:   { "<embedId>": {...plain JSON, opaque to the envelope...} },
 *     attachments: [...same shape as the wiki-mode format above...]
 *   }
 *
 * serializePlainToEnvelope/deserializePlainFromEnvelope (public) and
 * serializePlainEncrypted/deserializePlainEncrypted (private) are this
 * format's counterparts to the yjs-update-v1 pair above. They share the
 * envelope-building/signing/KEK-DEK-sealing steps with the Yjs pair —
 * only payload construction differs. PostCardEditor.js always uses the
 * plain pair for a brand-new card; the Yjs pair is read (and, if resaved,
 * written) only for a loaded legacy card whose stored payload.format is
 * already 'yjs-update-v1' — see the Status note above.
 *
 * deserializeFromEnvelope/deserializeEncrypted both call thenDo(null, doc,
 * payload) — the third arg is how callers (PostCardEditor.js) reach
 * `attachments` without a second decrypt round trip.
 *
 * CRITICAL: All post card Y.Docs MUST be created with gc: false (§9.3).
 *           This cannot be retrofitted. The serializer enforces this by
 *           checking doc.gc when a yDoc is passed in.
 *
 * Key architecture (§3.6):
 *   - objIds are genesis-derived: H(authorDid + ":" + genesisNonce)[0..12]
 *     via lively.identity.webKey.generateGenesisObjId
 *   - Encryption uses KEK/DEK (§3.6 Plane 3): Crypto.wrapDek / encryptPayload
 *     rather than per-object PRF calls
 *
 * Yjs dependency:
 *   Yjs must be loaded as a plain script (/lib/yjs/yjs.js or CDN) before
 *   calling serializeToEnvelope. The global Y (or window.Y) must expose
 *   Y.encodeStateAsUpdate and Y.Doc. y-prosemirror must also be loaded for
 *   snapshot extraction. This module does NOT require() Yjs — same pattern
 *   as Crypto.js's libsodium dependency.
 *
 * Async pattern: thenDo(err, result) throughout.
 *
 * Dependencies:
 *   lively.identity.Crypto     — computeCid, encryptPayload, wrapDek, signJws
 *   lively.identity.DID        — currentUser(), findMethodByCredentialId
 *   lively.identity.WebKey     — generateGenesisObjId, buildObjectUrl
 *   lively.identity.WebAuthn   — _kekCache (for envelope signing)
 */

module('lively.identity.PostCardSerializer')
  .requires(
    'lively.identity.Crypto',
    'lively.identity.DID',
    'lively.identity.WebKey',
    'lively.identity.WebAuthn',
    'lively.identity.EnvelopeSigning',
    'lively.identity.AudienceRules',
  )
  .toRun(function () {

    Object.subclass('lively.identity.PostCardSerializer',

    // ─── Yjs access ──────────────────────────────────────────────────────────────

    'yjs', {

      // Returns the global Y (Yjs) object, or null if not loaded.
      _Y: function () {
        return (typeof Y !== 'undefined' && Y) ||
               (typeof window !== 'undefined' && window.Y) ||
               null;
      },

      // Returns the global yProsemirror object, or null.
      _yProsemirror: function () {
        return (typeof yProsemirror !== 'undefined' && yProsemirror) ||
               (typeof window !== 'undefined' && window.yProsemirror) ||
               null;
      },

      // Checks that yDoc.gc is false. Logs a hard warning if not — this cannot
      // be fixed at runtime; the doc must be recreated.
      _checkGcDisabled: function (yDoc) {
        if (yDoc && yDoc.gc !== false) {
          console.error(
            '[PostCardSerializer] CRITICAL: Y.Doc has gc: true. ' +
            'Post card docs must be created with gc: false or history playback ' +
            '(§9) will be permanently unavailable for this document. ' +
            'Recreate the doc with new Y.Doc({ gc: false }).'
          );
        }
      },

    },

    // ─── public objects (signed, unencrypted) ────────────────────────────────────

    'public', {

      // Serialize a Yjs document to a signed postcard envelope.
      //
      // params: {
      //   yDoc:        Y.Doc     — MUST have been created with gc: false
      //   title:       String    — optional; auto-extracted from first block if absent
      //   titleExplicit: Boolean — if true, title was user-set (§10.5)
      //   constellation: String  — optional; constellation name for indexing (§2.2)
      //   replyTo:     Object    — optional; { objId, anchor } for inline replies (§10.3)
      //   visibility:  String    — 'public' | 'private' | 'shared' (default 'public')
      //   prevEnvelope: Object   — previous version envelope for version chaining
      //   stateMeta:   Object    — extra state fields to merge into envelope.state
      // }
      //
      // Calls thenDo(null, envelope).
      serializeToEnvelope: function (params, thenDo) {
        var self = this;
        var c = lively.identity.crypto;
        var user = lively.identity.did.currentUser();

        if (!user) {
          return thenDo(new Error(
            'PostCardSerializer.serializeToEnvelope: no identity session active. ' +
            'Call lively.identity.did.establishSession() before serializing.'
          ));
        }

        var Y = self._Y();
        if (!Y) {
          return thenDo(new Error(
            'PostCardSerializer.serializeToEnvelope: Yjs not loaded. ' +
            'Include /lib/yjs/yjs.js before calling this method.'
          ));
        }

        var yDoc = params.yDoc;
        if (!yDoc) return thenDo(new Error('PostCardSerializer: yDoc is required'));
        self._checkGcDisabled(yDoc);

        // Step 1: Extract Yjs update bytes and encode as base64url
        var updateBytes;
        try {
          updateBytes = Y.encodeStateAsUpdate(yDoc);
        } catch (e) {
          return thenDo(new Error('PostCardSerializer: Y.encodeStateAsUpdate failed: ' + e.message));
        }
        var updateB64 = c.base64urlEncode(updateBytes);

        // Step 2: Extract ProseMirror snapshot for fast read-only rendering
        var snapshot = self._extractSnapshot(yDoc);

        // Step 3: Extract title from first block unless explicitly set
        var title = params.title;
        if (!title && snapshot && snapshot.content && snapshot.content.length) {
          title = self._extractTitleFromBlocks(snapshot.content);
        }

        var payload = {
          format: 'yjs-update-v1',
          update: updateB64,
          snapshot: snapshot,
          // Attachment metadata (§6): pass-through, same as snapshot. Public
          // postcards' attachments carry no dek (their blobs are already
          // plaintext) — the field only ever holds { objId, dek: null,
          // blobCid, blobNonce: null, name, mime } entries here.
          attachments: params.attachments || []
        };

        // Step 4: Compute CID over the canonical JSON payload (§3.5)
        c.computeCid(payload, function (err, cid) {
          if (err) return thenDo(err);

          // Step 5: Determine objId — reuse on update, generate new on genesis
          var prevEnvelope = params.prevEnvelope || null;
          var prevCid = prevEnvelope && prevEnvelope.record ? (prevEnvelope.record.cid || null) : null;

          if (prevEnvelope && prevEnvelope.objId) {
            _buildEnvelope(prevEnvelope.objId, null);
          } else {
            lively.identity.webKey.generateGenesisObjId(user.did, function (err, result) {
              if (err) return thenDo(err);
              _buildEnvelope(result.objId, result.genesisNonce);
            });
          }

          function _buildEnvelope(objId, genesisNonce) {
            var state = Object.assign({}, params.stateMeta || {}, { title: title || '' });
            if (params.titleExplicit) state.titleExplicit = true;

            var envelope = {
              objId:  objId,
              did:    user.did,
              type:   'postcard',
              visibility: params.visibility || 'public',
              created: (prevEnvelope && prevEnvelope.created) || new Date().toISOString(),
              record: { cid: cid, prevCid: prevCid, payload: payload },
              state:  state,
            };
            if (genesisNonce) envelope.genesisNonce = genesisNonce;
            if (params.constellation) envelope.constellation = params.constellation;
            if (params.replyTo)       envelope.replyTo       = params.replyTo;

            // Step 6: Sign with device soft key if delegation cert + KEK available
            _signEnvelopeIfPossible(envelope, user, c, function (signErr, signed) {
              if (signErr) return thenDo(signErr);
              thenDo(null, signed || envelope);
            });
          }
        });
      },

      // Deserialize a postcard envelope back into a Y.Doc.
      // Creates a new Y.Doc (with gc: false) and applies the stored Yjs update.
      //
      // Returns thenDo(null, Y.Doc).
      deserializeFromEnvelope: function (envelope, thenDo) {
        var self = this;
        var c = lively.identity.crypto;

        if (!envelope || !envelope.record || !envelope.record.payload) {
          return thenDo(new Error('deserializeFromEnvelope: invalid envelope structure'));
        }

        var payload = envelope.record.payload;
        if (payload.format !== 'yjs-update-v1') {
          return thenDo(new Error(
            'deserializeFromEnvelope: unsupported payload format "' + payload.format + '"'
          ));
        }

        // CID integrity check -- non-fatal on mismatch. record.cid is itself
        // covered by the envelope's signature (Crypto.js's
        // verifyEnvelopeIntegrity), so the signature check is the real
        // tamper-detection guarantee; this recompute used to hash-check via
        // plain JSON.stringify (not canonicalJson, fixed 2026-09-13) and
        // abort the whole load on any mismatch, which made any postcard
        // round-tripped through Postgres jsonb storage permanently
        // unopenable even when untampered. See WikiSerializer.js's identical
        // fix for the full writeup.
        c.computeCid(payload, function (err, expectedCid) {
          if (err) return thenDo(err);
          var cidMismatch = expectedCid !== envelope.record.cid;

          var Y = self._Y();
          if (!Y) {
            return thenDo(new Error('deserializeFromEnvelope: Yjs not loaded'));
          }

          var doc = new Y.Doc({ gc: false });
          try {
            var updateBytes = c.base64urlDecode(payload.update);
            Y.applyUpdate(doc, updateBytes);
            // Third arg (payload) lets callers reach attachments (§6) without
            // a second round trip — the only caller today (PostCardEditor.js)
            // reads it; anyone still using the 2-arg (err, doc) form is
            // unaffected. Fourth arg (info.cidMismatch) is likewise optional.
            thenDo(null, doc, payload, { cidMismatch: cidMismatch });
          } catch (e) {
            thenDo(new Error('deserializeFromEnvelope: failed to apply Yjs update: ' + e.message));
          }
        });
      },

    },

    // ─── plain post cards, public (no Yjs — §2.3) ────────────────────────────────

    'plain-public', {

      // Serialize a plain (single-author) post card to a signed envelope.
      // No Yjs doc involved — this is for everything that is NOT a
      // constellation wiki page (PostcardDesignSpec-v2.md §1.1).
      //
      // params: {
      //   doc:         Object    — ProseMirror JSON document (required)
      //   partState:   Object    — optional; { embedId: {...plain JSON...} }
      //   title:       String    — optional; auto-extracted from first block if absent
      //   titleExplicit: Boolean — if true, title was user-set (§10.5)
      //   constellation: String  — optional; constellation name for indexing (§2.2)
      //   replyTo:     Object    — optional; { objId, anchor } — anchor is
      //                 always null for a plain card (§16.3); inline anchors
      //                 are wiki-only.
      //   attachments: Array     — optional; same shape as the Yjs pair
      //   visibility:  String    — 'public' | 'private' | 'shared' (default 'public')
      //   prevEnvelope: Object   — previous version envelope for version chaining
      //   stateMeta:   Object    — extra state fields to merge into envelope.state
      // }
      //
      // Calls thenDo(null, envelope).
      serializePlainToEnvelope: function (params, thenDo) {
        var self = this;
        var c = lively.identity.crypto;
        var user = lively.identity.did.currentUser();

        if (!user) {
          return thenDo(new Error(
            'PostCardSerializer.serializePlainToEnvelope: no identity session active. ' +
            'Call lively.identity.did.establishSession() before serializing.'
          ));
        }

        var doc = params.doc;
        if (!doc) return thenDo(new Error('PostCardSerializer: doc is required'));

        var payload = {
          format: 'prosemirror-doc-v1',
          doc: doc,
          partState: params.partState || {},
          attachments: params.attachments || []
        };
        // Back-of-card stamps (see PostCardEditor._backStamps) — omitted
        // when empty so a stamp-less card's payload (and CID) is unchanged.
        if (params.backStamps && params.backStamps.length) payload.backStamps = params.backStamps;
        // A game block (the Gaming template's "share as postcard"): { title, cover_url, ... }
        // Omitted when there is none, so an ordinary card's payload (and CID) is unchanged.
        if (params.game) payload.game = params.game;

        var title = params.title;
        if (!title && doc.content && doc.content.length) {
          title = self._extractTitleFromBlocks(doc.content);
        }

        c.computeCid(payload, function (err, cid) {
          if (err) return thenDo(err);

          var prevEnvelope = params.prevEnvelope || null;
          var prevCid = prevEnvelope && prevEnvelope.record ? (prevEnvelope.record.cid || null) : null;

          if (prevEnvelope && prevEnvelope.objId) {
            _buildEnvelope(prevEnvelope.objId, null);
          } else {
            lively.identity.webKey.generateGenesisObjId(user.did, function (err, result) {
              if (err) return thenDo(err);
              _buildEnvelope(result.objId, result.genesisNonce);
            });
          }

          function _buildEnvelope(objId, genesisNonce) {
            var state = Object.assign({}, params.stateMeta || {}, { title: title || '' });
            if (params.titleExplicit) state.titleExplicit = true;

            var envelope = {
              objId:  objId,
              did:    user.did,
              type:   'postcard',
              visibility: params.visibility || 'public',
              created: (prevEnvelope && prevEnvelope.created) || new Date().toISOString(),
              record: { cid: cid, prevCid: prevCid, payload: payload },
              state:  state,
            };
            if (genesisNonce) envelope.genesisNonce = genesisNonce;
            if (params.constellation) envelope.constellation = params.constellation;
            if (params.replyTo)       envelope.replyTo       = params.replyTo;

            _signEnvelopeIfPossible(envelope, user, c, function (signErr, signed) {
              if (signErr) return thenDo(signErr);
              thenDo(null, signed || envelope);
            });
          }
        });
      },

      // Deserialize a plain postcard envelope back into ProseMirror JSON.
      // No Y.Doc involved — payload.doc is already the document.
      //
      // Calls thenDo(null, doc, payload) — third arg mirrors the Yjs pair's
      // shape so PostCardEditor.js can read partState/attachments the same
      // way regardless of which pair loaded the card.
      deserializePlainFromEnvelope: function (envelope, thenDo) {
        var c = lively.identity.crypto;

        if (!envelope || !envelope.record || !envelope.record.payload) {
          return thenDo(new Error('deserializePlainFromEnvelope: invalid envelope structure'));
        }

        var payload = envelope.record.payload;
        if (payload.format !== 'prosemirror-doc-v1') {
          return thenDo(new Error(
            'deserializePlainFromEnvelope: unsupported payload format "' + payload.format + '"'
          ));
        }

        // Non-fatal on mismatch -- see deserializeFromEnvelope's identical
        // comment above (record.cid's real tamper-detection guarantee is the
        // envelope signature, not this recompute).
        c.computeCid(payload, function (err, expectedCid) {
          if (err) return thenDo(err);
          var cidMismatch = expectedCid !== envelope.record.cid;
          thenDo(null, payload.doc, payload, { cidMismatch: cidMismatch });
        });
      },

    },

    // ─── encrypted post cards (§3.6 KEK/DEK plan) ────────────────────────────────

    'private', {

      // Serialize and encrypt a postcard for owner-only or shared access.
      //
      // params: same as serializeToEnvelope, plus:
      //   recipients: Array of { did, x25519PublicKey } for shared visibility
      //               (each recipient's account X25519 public key, base64url)
      //
      // Requires the KEK to be cached in WebAuthn._kekCache[credentialId].
      // If not cached, fails with an actionable error — call WebAuthn.deriveKek first.
      //
      // Calls thenDo(null, envelope).
      serializeEncrypted: function (params, thenDo) {
        var self = this;
        var c = lively.identity.crypto;
        var wa = lively.identity.webAuthn;
        var user = lively.identity.did.currentUser();

        if (!user) return thenDo(new Error('serializeEncrypted: no identity session'));

        if (!wa || !wa._kekCache || !wa._kekCache[user.credentialId]) {
          return thenDo(new Error(
            'serializeEncrypted: KEK not cached for this session. ' +
            'Call WebAuthn.deriveKek first (prompts once per session).'
          ));
        }
        var kek = wa._kekCache[user.credentialId];

        var Y = self._Y();
        if (!Y) return thenDo(new Error('serializeEncrypted: Yjs not loaded'));

        var yDoc = params.yDoc;
        if (!yDoc) return thenDo(new Error('serializeEncrypted: yDoc is required'));
        self._checkGcDisabled(yDoc);

        // Extract and encode the Yjs update
        var updateBytes;
        try { updateBytes = Y.encodeStateAsUpdate(yDoc); }
        catch (e) { return thenDo(new Error('serializeEncrypted: encodeStateAsUpdate failed: ' + e.message)); }

        var snapshot = self._extractSnapshot(yDoc);
        // §16.4: never auto-extract a title from content for an encrypted
        // card — state.title is stored in the clear (server-readable
        // metadata, used for search/listings) even though record.payload
        // is ciphertext, so falling back to the first line of a private
        // note would leak it right back out. Only an explicitly user-set
        // title is ever stored here; see _buildEncryptedEnvelope below.
        var title = params.title || '';

        var payload = {
          format: 'yjs-update-v1',
          update: c.base64urlEncode(updateBytes),
          snapshot: snapshot,
          // Attachment metadata (§6), pass-through: each entry carries its
          // own DEK (base64url) since it travels inside THIS ciphertext —
          // anyone who can decrypt the postcard already holds the keys to
          // its attachments, no separate resealing ceremony needed when
          // recipients change.
          attachments: params.attachments || []
        };

        // Generate a fresh DEK, wrap it with the KEK
        c.wrapDek(kek, function (err, dekResult) {
          if (err) return thenDo(err);
          var dek = dekResult.dek;

          // Encrypt the payload JSON with the DEK
          c.encryptPayload(payload, dek, function (err, encrypted) {
            if (err) return thenDo(err);

            c.computeCid(encrypted.ciphertext, function (err, cid) {
              if (err) return thenDo(err);

              // Build recipient key wraps for shared visibility
              var prevEnvelope = params.prevEnvelope || null;
              var prevCid = prevEnvelope && prevEnvelope.record ? (prevEnvelope.record.cid || null) : null;

              function _buildEncryptedEnvelope(objId, genesisNonce, recipientWraps) {
                // §16.4: only ever store a title here if one was explicitly
                // given — no auto-extracted fallback (see the comment above
                // where `title` is computed).
                var state = Object.assign({}, params.stateMeta || {});
                if (title) state.title = title;
                if (params.titleExplicit) state.titleExplicit = true;
                var visibility = (params.recipients && params.recipients.length) ? 'shared' : 'private';

                var envelope = {
                  objId: objId,
                  did: user.did,
                  type: 'postcard',
                  visibility: visibility,
                  created: (prevEnvelope && prevEnvelope.created) || new Date().toISOString(),
                  record: {
                    cid: cid,
                    prevCid: prevCid,
                    payload: encrypted.ciphertext,
                    nonce: encrypted.nonce,
                    wrappedDek: dekResult.wrappedDek,
                    recipients: recipientWraps,
                  },
                  state: state,
                };
                if (genesisNonce) envelope.genesisNonce = genesisNonce;
                if (params.constellation) envelope.constellation = params.constellation;
                if (params.replyTo) envelope.replyTo = params.replyTo;

                _signEnvelopeIfPossible(envelope, user, c, function (signErr, signed) {
                  if (signErr) return thenDo(signErr);
                  thenDo(null, signed || envelope);
                });
              }

              function _withObjId(callback) {
                if (prevEnvelope && prevEnvelope.objId) return callback(prevEnvelope.objId, null);
                lively.identity.webKey.generateGenesisObjId(user.did, function (err, r) {
                  if (err) return thenDo(err);
                  callback(r.objId, r.genesisNonce);
                });
              }

              _withObjId(function (objId, genesisNonce) {
                if (!params.recipients || !params.recipients.length) {
                  return _buildEncryptedEnvelope(objId, genesisNonce, []);
                }
                // Seal the DEK for each recipient's account X25519 public key
                var recipientWraps = [];
                var remaining = params.recipients.length;
                var hadError = false;
                params.recipients.forEach(function (r) {
                  c.sealForRecipient(dek, r.x25519PublicKey, function (err, sealed) {
                    if (hadError) return;
                    if (err) { hadError = true; return thenDo(err); }
                    recipientWraps.push(_recipientWrap(prevEnvelope, r.did, sealed, cid));
                    if (--remaining === 0) _buildEncryptedEnvelope(objId, genesisNonce, recipientWraps);
                  });
                });
              });
            });
          });
        });
      },

      // Decrypt and deserialize a private/shared postcard envelope.
      // Returns thenDo(null, Y.Doc).
      deserializeEncrypted: function (envelope, thenDo) {
        var self = this;
        var c = lively.identity.crypto;
        var wa = lively.identity.webAuthn;
        var user = lively.identity.did.currentUser();

        if (!user) return thenDo(new Error('deserializeEncrypted: no identity session'));

        if (!envelope || !envelope.record || !envelope.record.payload) {
          return thenDo(new Error('deserializeEncrypted: invalid envelope structure'));
        }

        // CID check on ciphertext
        c.computeCid(envelope.record.payload, function (err, expectedCid) {
          if (err) return thenDo(err);
          if (expectedCid !== envelope.record.cid) {
            return thenDo(new Error('deserializeEncrypted: CID mismatch for objId=' + envelope.objId));
          }

          // Unwrap the DEK: owner uses KEK, recipients use sealedDek —
          // shared with deserializePlainEncrypted/deserializeEncryptedAuto.
          _unwrapDekForEnvelope(envelope, user, wa, c, function (err, dek) {
            if (err) return thenDo(err);

            c.decryptPayload(envelope.record.payload, envelope.record.nonce, dek, function (err, payload) {
              if (err) return thenDo(err);

              var Y = self._Y();
              if (!Y) return thenDo(new Error('deserializeEncrypted: Yjs not loaded'));

              var doc = new Y.Doc({ gc: false });
              try {
                var updateBytes = c.base64urlDecode(payload.update);
                Y.applyUpdate(doc, updateBytes);
                // Third arg (payload): gives the caller the decrypted
                // attachments array (§6) — each entry's dek travels here,
                // already decrypted, no separate per-attachment unwrap needed.
                thenDo(null, doc, payload);
              } catch (e) {
                thenDo(new Error('deserializeEncrypted: Yjs apply failed: ' + e.message));
              }
            });
          });
        });
      },

    },

    // ─── plain post cards, encrypted (no Yjs — §2.3, §3.6 KEK/DEK plan) ──────────

    'plain-private', {

      // Serialize and encrypt a plain (single-author) post card for
      // owner-only or shared access. No Yjs doc involved.
      //
      // params: same as serializePlainToEnvelope, plus:
      //   recipients: Array of { did, x25519PublicKey } for shared visibility
      //
      // Requires the KEK to be cached, same precondition as serializeEncrypted.
      //
      // Calls thenDo(null, envelope).
      serializePlainEncrypted: function (params, thenDo) {
        var self = this;
        var c = lively.identity.crypto;
        var wa = lively.identity.webAuthn;
        var user = lively.identity.did.currentUser();

        if (!user) return thenDo(new Error('serializePlainEncrypted: no identity session'));

        if (!wa || !wa._kekCache || !wa._kekCache[user.credentialId]) {
          return thenDo(new Error(
            'serializePlainEncrypted: KEK not cached for this session. ' +
            'Call WebAuthn.deriveKek first (prompts once per session).'
          ));
        }
        var kek = wa._kekCache[user.credentialId];

        var doc = params.doc;
        if (!doc) return thenDo(new Error('serializePlainEncrypted: doc is required'));

        // §16.4: never auto-extract a title from content for an encrypted
        // card — same reasoning as serializeEncrypted above. Only an
        // explicitly user-set title is ever stored here.
        var title = params.title || '';

        var payload = {
          format: 'prosemirror-doc-v1',
          doc: doc,
          partState: params.partState || {},
          attachments: params.attachments || []
        };
        if (params.backStamps && params.backStamps.length) payload.backStamps = params.backStamps;
        // Game block, as in serializePlainToEnvelope. Inside the encrypted payload, so only
        // the people the card is sealed to can read which game it is about.
        if (params.game) payload.game = params.game;

        c.wrapDek(kek, function (err, dekResult) {
          if (err) return thenDo(err);
          var dek = dekResult.dek;

          c.encryptPayload(payload, dek, function (err, encrypted) {
            if (err) return thenDo(err);

            c.computeCid(encrypted.ciphertext, function (err, cid) {
              if (err) return thenDo(err);

              var prevEnvelope = params.prevEnvelope || null;
              var prevCid = prevEnvelope && prevEnvelope.record ? (prevEnvelope.record.cid || null) : null;

              function _buildEncryptedEnvelope(objId, genesisNonce, recipientWraps) {
                // §16.4: only ever store a title here if one was explicitly
                // given — no auto-extracted fallback (see the comment above
                // where `title` is computed).
                var state = Object.assign({}, params.stateMeta || {});
                if (title) state.title = title;
                if (params.titleExplicit) state.titleExplicit = true;
                var visibility = (params.recipients && params.recipients.length) ? 'shared' : 'private';

                var envelope = {
                  objId: objId,
                  did: user.did,
                  type: 'postcard',
                  visibility: visibility,
                  created: (prevEnvelope && prevEnvelope.created) || new Date().toISOString(),
                  record: {
                    cid: cid,
                    prevCid: prevCid,
                    payload: encrypted.ciphertext,
                    nonce: encrypted.nonce,
                    wrappedDek: dekResult.wrappedDek,
                    recipients: recipientWraps,
                  },
                  state: state,
                };
                if (genesisNonce) envelope.genesisNonce = genesisNonce;
                if (params.constellation) envelope.constellation = params.constellation;
                if (params.replyTo) envelope.replyTo = params.replyTo;

                _signEnvelopeIfPossible(envelope, user, c, function (signErr, signed) {
                  if (signErr) return thenDo(signErr);
                  thenDo(null, signed || envelope);
                });
              }

              function _withObjId(callback) {
                if (prevEnvelope && prevEnvelope.objId) return callback(prevEnvelope.objId, null);
                lively.identity.webKey.generateGenesisObjId(user.did, function (err, r) {
                  if (err) return thenDo(err);
                  callback(r.objId, r.genesisNonce);
                });
              }

              _withObjId(function (objId, genesisNonce) {
                if (!params.recipients || !params.recipients.length) {
                  return _buildEncryptedEnvelope(objId, genesisNonce, []);
                }
                var recipientWraps = [];
                var remaining = params.recipients.length;
                var hadError = false;
                params.recipients.forEach(function (r) {
                  c.sealForRecipient(dek, r.x25519PublicKey, function (err, sealed) {
                    if (hadError) return;
                    if (err) { hadError = true; return thenDo(err); }
                    recipientWraps.push(_recipientWrap(prevEnvelope, r.did, sealed, cid));
                    if (--remaining === 0) _buildEncryptedEnvelope(objId, genesisNonce, recipientWraps);
                  });
                });
              });
            });
          });
        });
      },

      // Decrypt and deserialize a plain private/shared postcard envelope.
      // No Y.Doc involved — payload.doc is already the document.
      //
      // Calls thenDo(null, doc, payload).
      deserializePlainEncrypted: function (envelope, thenDo) {
        var c = lively.identity.crypto;
        var wa = lively.identity.webAuthn;
        var user = lively.identity.did.currentUser();

        if (!user) return thenDo(new Error('deserializePlainEncrypted: no identity session'));

        if (!envelope || !envelope.record || !envelope.record.payload) {
          return thenDo(new Error('deserializePlainEncrypted: invalid envelope structure'));
        }

        c.computeCid(envelope.record.payload, function (err, expectedCid) {
          if (err) return thenDo(err);
          if (expectedCid !== envelope.record.cid) {
            return thenDo(new Error('deserializePlainEncrypted: CID mismatch for objId=' + envelope.objId));
          }

          _unwrapDekForEnvelope(envelope, user, wa, c, function (err, dek) {
            if (err) return thenDo(err);

            c.decryptPayload(envelope.record.payload, envelope.record.nonce, dek, function (err, payload) {
              if (err) return thenDo(err);
              thenDo(null, payload.doc, payload);
            });
          });
        });
      },

      // Decrypt a private/shared postcard envelope WITHOUT assuming which
      // payload format it holds — needed because, unlike a public envelope
      // (whose record.payload is a plain, readable object), an encrypted
      // envelope's payload is ciphertext: there is no way to read
      // payload.format and pick deserializeEncrypted vs.
      // deserializePlainEncrypted *before* decrypting, since that field only
      // exists inside the plaintext this call produces. DEK unwrapping is
      // identical either way, so this decrypts once and branches on
      // payload.format afterward.
      //
      // Calls thenDo(null, 'wiki'|'plain', content, payload) where content is
      // a Y.Doc for 'wiki' or a ProseMirror JSON doc for 'plain'. Callers
      // that already know the mode ahead of time (e.g. creating a brand new
      // card, where there's nothing to decrypt yet) should keep using
      // deserializeEncrypted/deserializePlainEncrypted directly — this is
      // specifically for loading an existing envelope of unknown format.
      deserializeEncryptedAuto: function (envelope, thenDo) {
        var self = this;
        var c = lively.identity.crypto;
        var wa = lively.identity.webAuthn;
        var user = lively.identity.did.currentUser();

        if (!user) return thenDo(new Error('deserializeEncryptedAuto: no identity session'));

        if (!envelope || !envelope.record || !envelope.record.payload) {
          return thenDo(new Error('deserializeEncryptedAuto: invalid envelope structure'));
        }

        c.computeCid(envelope.record.payload, function (err, expectedCid) {
          if (err) return thenDo(err);
          if (expectedCid !== envelope.record.cid) {
            return thenDo(new Error('deserializeEncryptedAuto: CID mismatch for objId=' + envelope.objId));
          }

          _unwrapDekForEnvelope(envelope, user, wa, c, function (err, dek) {
            if (err) return thenDo(err);

            c.decryptPayload(envelope.record.payload, envelope.record.nonce, dek, function (err, payload) {
              if (err) return thenDo(err);

              if (payload.format === 'prosemirror-doc-v1') {
                return thenDo(null, 'plain', payload.doc, payload);
              }

              // Every envelope predating this split used yjs-update-v1
              // unconditionally (no format field needed to exist before
              // now) — treat that as the wiki/Yjs path, same as
              // deserializeEncrypted's own assumption.
              var Y = self._Y();
              if (!Y) return thenDo(new Error('deserializeEncryptedAuto: Yjs not loaded'));
              var doc = new Y.Doc({ gc: false });
              try {
                var updateBytes = c.base64urlDecode(payload.update);
                Y.applyUpdate(doc, updateBytes);
                thenDo(null, 'wiki', doc, payload);
              } catch (e) {
                thenDo(new Error('deserializeEncryptedAuto: Yjs apply failed: ' + e.message));
              }
            });
          });
        });
      },

    },

    // ─── helpers ─────────────────────────────────────────────────────────────────

    'helpers', {

      // Extract a ProseMirror document JSON from a Y.Doc using y-prosemirror.
      // Returns null if y-prosemirror is not loaded.
      _extractSnapshot: function (yDoc) {
        var yPM = this._yProsemirror();
        if (!yPM || !yPM.yDocToProsemirrorJSON) return null;
        try {
          return yPM.yDocToProsemirrorJSON(yDoc, 'prosemirror');
        } catch (e) {
          console.warn('[PostCardSerializer] Could not extract PM snapshot:', e.message);
          return null;
        }
      },

      // Extract the plain-text content of the first block node (§10.5).
      _extractFirstBlockText: function (node) {
        if (!node || !node.content) return '';
        return node.content.map(function (child) {
          if (child.text) return child.text;
          if (child.content) return child.content.map(function(c) { return c.text || ''; }).join('');
          return '';
        }).join('').trim().slice(0, 200);
      },

      // Title auto-extraction (§10.5) only ever tried content[0] — if the
      // very first block is itself a bare media node (an image/video as the
      // first thing typed, no text), _extractFirstBlockText(content[0])
      // returns '' and the title silently falls back to "(untitled)" even
      // though the doc has real text further down. Scan forward for the
      // first block that actually yields non-empty text instead. Public/
      // private plaintext paths only (serializeToEnvelope,
      // serializePlainToEnvelope) — the encrypted path deliberately never
      // auto-extracts a title at all (state.title is clear-text
      // server-readable metadata; see that path's own comment), so this
      // helper is never called from there and shouldn't be.
      _extractTitleFromBlocks: function (content) {
        if (!content || !content.length) return '';
        for (var i = 0; i < content.length; i++) {
          var text = this._extractFirstBlockText(content[i]);
          if (text) return text;
        }
        return '';
      },

    });

    // ─── shared signing helper ────────────────────────────────────────────────────
    // Extracted to lively.identity.EnvelopeSigning (EnvelopeSigning.js) so
    // RoomCrypto.js's room-key-epoch envelopes can reuse the exact same
    // signing logic instead of forking it. See that file for the full
    // rationale (deriveKek's on-demand-prompt behavior, F20 mandatory
    // signing, etc.) — kept there now, not duplicated here.
    // One record.recipients entry for a new version. sinceCid marks the version the
    // person was first sealed into (see AudienceRules.sinceCidFor); the whole list is
    // covered by the envelope signature.
    function _recipientWrap(prevEnvelope, did, sealedDek, cid) {
      var wrap = { did: did, sealedDek: sealedDek };
      var prevRecipients = prevEnvelope && prevEnvelope.record && prevEnvelope.record.recipients;
      var since = lively.identity.AudienceRules.sinceCidFor(prevRecipients, did, cid);
      if (since) wrap.sinceCid = since;
      return wrap;
    }

    function _signEnvelopeIfPossible(envelope, user, c, thenDo) {
      return lively.identity.envelopeSigning.signEnvelopeIfPossible(envelope, user, c, thenDo);
    }

    // ─── shared DEK-unwrap helper ─────────────────────────────────────────────────
    // Used by deserializeEncrypted, deserializePlainEncrypted, and
    // deserializeEncryptedAuto — unwrapping the DEK is identical regardless
    // of which payload format it ends up decrypting (owner via cached/
    // freshly-derived KEK, recipient via their own sealedDek entry).
    function _unwrapDekForEnvelope(envelope, user, wa, c, thenDo) {
      var isOwner = user.did === envelope.did;
      if (isOwner) {
        function withKek(dekCallback) {
          if (wa && wa._kekCache && wa._kekCache[user.credentialId]) {
            return dekCallback(null, wa._kekCache[user.credentialId]);
          }
          // Not cached (e.g. a restored session that never went through
          // LoginDialog's post-login warm-up) — prompt on demand instead of
          // hard-failing, same self-contained ceremony the recipient branch
          // below already does for deriveX25519KeyPair.
          var ch = new Uint8Array(32);
          crypto.getRandomValues(ch);
          wa.deriveKek({ credentialId: user.credentialId, rpId: user.rpId, challenge: ch }, dekCallback);
        }
        withKek(function (err, kek) {
          if (err) return thenDo(err);
          c.unwrapDek(envelope.record.wrappedDek, kek, thenDo);
        });
      } else {
        // Recipient: find their sealed DEK entry and open it. Account
        // X25519 keypair is deterministically re-derived from PRF (same
        // credentialId + salt as at registration) and cached by
        // WebAuthn.deriveX25519KeyPair, same pattern as the owner's KEK.
        var myEntry = (envelope.record.recipients || []).find(function (r) {
          return r.did === user.did;
        });
        if (!myEntry) return thenDo(new Error('_unwrapDekForEnvelope: no sealed DEK for current user'));
        var ch = new Uint8Array(32);
        crypto.getRandomValues(ch);
        wa.deriveX25519KeyPair({ credentialId: user.credentialId, rpId: user.rpId, challenge: ch }, function (err, pair) {
          if (err) return thenDo(err);
          c.openSealedBox(myEntry.sealedDek, pair.publicKey, pair.privateKey, thenDo);
        });
      }
    }

    // Opens the content key (DEK) of any encrypted envelope for the signed-in person:
    // the owner through their KEK, a recipient through their own sealed copy and their
    // account X25519 key. Not specific to postcards, which is why it is public: other
    // kinds of record that are sealed the same way (the Gaming template's game
    // entries) use it instead of keeping a second copy of the recipient branch.
    // Use it rather than calling crypto.unwrapDek / openSealedBox directly, so a
    // change to how recipients open an envelope is made in one place.
    // thenDo(err, dek). Errors when the person is a recipient with no sealed copy.
    lively.identity.PostCardSerializer.unwrapEnvelopeDek = function (envelope, thenDo) {
      var user = lively.identity.did.currentUser();
      if (!user) return thenDo(new Error('unwrapEnvelopeDek: no identity session'));
      _unwrapDekForEnvelope(envelope, user, lively.identity.webAuthn, lively.identity.crypto, thenDo);
    };

    // Singleton
    lively.identity.postCardSerializer = new lively.identity.PostCardSerializer();

  }); // end module('lively.identity.PostCardSerializer')
