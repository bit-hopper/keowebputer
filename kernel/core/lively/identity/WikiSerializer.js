/**
 * lively.identity.WikiSerializer
 *
 * Serializes and deserializes wiki page envelopes (type: 'wikipage') for the
 * Lively identity system. Split out of lively.identity.PostCardSerializer
 * when wiki pages became their own envelope type instead of a
 * type:'postcard' + state.wikiName combination — this module keeps exactly
 * the Yjs-based (yjs-update-v1) pair PostCardSerializer used to carry for
 * wiki mode; PostCardSerializer itself now only ever produces plain
 * (prosemirror-doc-v1) postcards.
 *
 * Envelope payload shape:
 *   record.payload = {
 *     format:      "yjs-update-v1",
 *     update:      "<base64url(Y.encodeStateAsUpdate(doc))>",
 *     snapshot:    <ProseMirror JSON from y-prosemirror>,
 *     attachments: [{ objId, dek, blobCid, blobNonce, name, mime }, ...]
 *   }
 *
 * Always public/unencrypted — deliberately, no per-page visibility toggle:
 * a wiki page's readability is governed by its constellation's own
 * canRead check (ConstellationRegistry) at the route level, not by
 * encrypting individual pages. Building a private/encrypted wiki page
 * would need its own answer to "a constellation member who joins later
 * can't decrypt content sealed before they joined" — a real design
 * question, deliberately not tackled here (out of scope for this pass).
 *
 * did stays fixed at genesis: unlike a plain postcard (always single-
 * author, so envelope.did == the current session's did is always true), a
 * wiki page can be saved by any constellation member with write access
 * (ConstellationRegistry.canWrite). envelope.did identifies which handle
 * this object lives under and must never change across saves — the same
 * precedent ConstellationSpace.js's saveSpaceSnapshot already established
 * for a constellation's own space envelope (did stays the constellation's
 * did:web regardless of who last moved a placement). Attribution for
 * individual edits lives in the Yjs update history, not in this field.
 *
 * CRITICAL: All wiki page Y.Docs MUST be created with gc: false (playback).
 *
 * Async pattern: thenDo(err, result) throughout.
 *
 * Dependencies:
 *   lively.identity.Crypto     — computeCid, signJws
 *   lively.identity.DID        — currentUser(), findMethodByCredentialId
 *   lively.identity.WebKey     — generateGenesisObjId
 *   lively.identity.WebAuthn   — _kekCache (for envelope signing only)
 */

module('lively.identity.WikiSerializer')
  .requires(
    'lively.identity.Crypto',
    'lively.identity.DID',
    'lively.identity.WebKey',
    'lively.identity.WebAuthn',
  )
  .toRun(function () {

    Object.subclass('lively.identity.WikiSerializer',

    // ─── Yjs access ──────────────────────────────────────────────────────────────

    'yjs', {

      _Y: function () {
        return (typeof Y !== 'undefined' && Y) ||
               (typeof window !== 'undefined' && window.Y) ||
               null;
      },

      _yProsemirror: function () {
        return (typeof yProsemirror !== 'undefined' && yProsemirror) ||
               (typeof window !== 'undefined' && window.yProsemirror) ||
               null;
      },

      _checkGcDisabled: function (yDoc) {
        if (yDoc && yDoc.gc !== false) {
          console.error(
            '[WikiSerializer] CRITICAL: Y.Doc has gc: true. ' +
            'Wiki page docs must be created with gc: false or history playback ' +
            'will be permanently unavailable for this document. ' +
            'Recreate the doc with new Y.Doc({ gc: false }).'
          );
        }
      },

    },

    // ─── public wiki pages (signed, unencrypted) ─────────────────────────────────

    'public', {

      // Serialize a Yjs document to a signed wiki page envelope.
      //
      // params: {
      //   yDoc:        Y.Doc     — MUST have been created with gc: false
      //   title:       String    — optional; auto-extracted from first block if absent
      //   titleExplicit: Boolean
      //   constellation: String  — optional; the owning constellation's name.
      //                             Omitted entirely for a personal (home-world)
      //                             wiki page, which belongs to params/user's own
      //                             did instead of any constellation.
      //   wikiName:    String    — required; the page's human-friendly name
      //   replyTo:     Object    — optional; { objId, anchor }
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
            'WikiSerializer.serializeToEnvelope: no identity session active. ' +
            'Call lively.identity.did.establishSession() before serializing.'
          ));
        }

        var Y = self._Y();
        if (!Y) {
          return thenDo(new Error(
            'WikiSerializer.serializeToEnvelope: Yjs not loaded. ' +
            'Include /lib/yjs/yjs.js before calling this method.'
          ));
        }

        var yDoc = params.yDoc;
        if (!yDoc) return thenDo(new Error('WikiSerializer: yDoc is required'));
        self._checkGcDisabled(yDoc);

        var updateBytes;
        try {
          updateBytes = Y.encodeStateAsUpdate(yDoc);
        } catch (e) {
          return thenDo(new Error('WikiSerializer: Y.encodeStateAsUpdate failed: ' + e.message));
        }
        var updateB64 = c.base64urlEncode(updateBytes);

        var snapshot = self._extractSnapshot(yDoc);

        var title = params.title;
        if (!title && snapshot && snapshot.content && snapshot.content.length) {
          title = self._extractTitleFromBlocks(snapshot.content);
        }

        var payload = {
          format: 'yjs-update-v1',
          update: updateB64,
          snapshot: snapshot,
          attachments: params.attachments || []
        };

        c.computeCid(payload, function (err, cid) {
          if (err) return thenDo(err);

          var prevEnvelope = params.prevEnvelope || null;
          var prevCid = prevEnvelope && prevEnvelope.record ? (prevEnvelope.record.cid || null) : null;
          // did stays fixed at genesis — see file header. A first save has
          // no prevEnvelope, so the creating user's did is genesis-did.
          var ownerDid = (prevEnvelope && prevEnvelope.did) || user.did;

          if (prevEnvelope && prevEnvelope.objId) {
            _buildEnvelope(prevEnvelope.objId, null);
          } else {
            lively.identity.webKey.generateGenesisObjId(user.did, function (err, result) {
              if (err) return thenDo(err);
              _buildEnvelope(result.objId, result.genesisNonce);
            });
          }

          function _buildEnvelope(objId, genesisNonce) {
            var state = Object.assign({}, params.stateMeta || {}, {
              title: title || '',
              wikiName: params.wikiName,
            });
            if (params.titleExplicit) state.titleExplicit = true;

            var envelope = {
              objId:  objId,
              did:    ownerDid,
              type:   'wikipage',
              constellation: params.constellation,
              visibility: 'public',
              created: (prevEnvelope && prevEnvelope.created) || new Date().toISOString(),
              record: { cid: cid, prevCid: prevCid, payload: payload },
              state:  state,
            };
            if (genesisNonce) envelope.genesisNonce = genesisNonce;
            if (params.replyTo) envelope.replyTo = params.replyTo;

            // Signed with the CURRENT saver's device key regardless of
            // ownerDid — a co-editor's own signature over an envelope whose
            // did field names the original author. Verifiers care that the
            // signer had a valid delegation chain, not that they equal
            // envelope.did (server-side write auth for wikipage envelopes
            // is checked separately, against constellation membership).
            _signEnvelopeIfPossible(envelope, user, c, function (signErr, signed) {
              if (signErr) return thenDo(signErr);
              thenDo(null, signed || envelope);
            });
          }
        });
      },

      // Deserialize a wiki page envelope back into a Y.Doc.
      // Returns thenDo(null, Y.Doc, payload).
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

        c.computeCid(payload, function (err, expectedCid) {
          // A CID mismatch is NOT treated as fatal here -- record.cid is
          // itself covered by the envelope's signature (Crypto.js's
          // verifyEnvelopeIntegrity signs envelope-minus-sig-minus-state,
          // which includes record.cid), so the signature check is the real
          // tamper-detection guarantee and it already uses canonicalJson
          // (robust to jsonb key reordering). This computeCid comparison
          // used to hash-check independently via plain JSON.stringify and
          // abort the whole load on any mismatch -- which made every wiki
          // page ever saved-then-reloaded through a jsonb round-trip
          // permanently uneditable (Edit opened a blank editor) even though
          // nothing was tampered, since the fix to computeCid itself
          // (2026-09-13) can't retroactively correct a CID that was already
          // baked into an existing signed envelope. Surface the mismatch as
          // a flag instead so WikiView's already-correct signature-based
          // badge can inform the user, without blocking editing.
          var cidMismatch = !err && expectedCid !== envelope.record.cid;

          var Y = self._Y();
          if (!Y) {
            return thenDo(new Error('deserializeFromEnvelope: Yjs not loaded'));
          }

          var doc = new Y.Doc({ gc: false });
          try {
            var updateBytes = c.base64urlDecode(payload.update);
            Y.applyUpdate(doc, updateBytes);
            thenDo(null, doc, payload, { cidMismatch: cidMismatch });
          } catch (e) {
            thenDo(new Error('deserializeFromEnvelope: failed to apply Yjs update: ' + e.message));
          }
        });
      },

    },

    // ─── helpers ─────────────────────────────────────────────────────────────────

    'helpers', {

      _extractSnapshot: function (yDoc) {
        var yPM = this._yProsemirror();
        if (!yPM || !yPM.yDocToProsemirrorJSON) return null;
        try {
          return yPM.yDocToProsemirrorJSON(yDoc, 'prosemirror');
        } catch (e) {
          console.warn('[WikiSerializer] Could not extract PM snapshot:', e.message);
          return null;
        }
      },

      _extractFirstBlockText: function (node) {
        if (!node || !node.content) return '';
        return node.content.map(function (child) {
          if (child.text) return child.text;
          if (child.content) return child.content.map(function(c) { return c.text || ''; }).join('');
          return '';
        }).join('').trim().slice(0, 200);
      },

      // BUG FIX: title auto-extraction only ever tried content[0] — if the
      // very first block is itself a bare atom node with no text (an
      // image/video, or now a link_preview_card from pasting a bare URL as
      // a page's opening line — see LinkPreviewServer.js),
      // _extractFirstBlockText(content[0]) returns '' and the title
      // silently falls back to "(untitled)" even though the doc has real
      // text further down. Scan forward for the first block that actually
      // yields non-empty text instead. Ported from PostCardSerializer.js's
      // identical fix (_extractTitleFromBlocks) — that file got this fix
      // when the same bug first showed up there; this copy never did.
      _extractTitleFromBlocks: function (content) {
        if (!content || !content.length) return '';
        for (var i = 0; i < content.length; i++) {
          var text = this._extractFirstBlockText(content[i]);
          if (text) return text;
        }
        return '';
      },

    });

    // ─── shared signing helper (mirrors SignedSerializer._signEnvelopeIfPossible) ──
    // Signs with the CURRENT session's device key — see the note in
    // serializeToEnvelope's _buildEnvelope about why this is independent of
    // envelope.did for a wiki page.

    function _signEnvelopeIfPossible(envelope, user, c, thenDo) {
      var method = lively.identity.did.findMethodByCredentialId(user.document, user.credentialId);
      if (!method || !method.lively) return thenDo(null, envelope);
      var livelyMeta = method.lively;
      if (!livelyMeta.softSigningKeyWrapped || !livelyMeta.delegationCert) return thenDo(null, envelope);
      var wa = lively.identity.webAuthn;
      if (!wa) return thenDo(null, envelope);

      // On-demand KEK derivation (added 2026-09-05, see
      // PostCardSerializer.js's identical fix for the full rationale):
      // deriveKek returns the cached KEK immediately if already warm, or
      // runs a fresh WebAuthn PRF ceremony otherwise. Needed because
      // signature verification is now mandatory server-side and ordinary
      // login never warms this cache.
      var ch = new Uint8Array(32);
      crypto.getRandomValues(ch);
      wa.deriveKek({ credentialId: user.credentialId, rpId: user.rpId, challenge: ch }, function (err, kek) {
        if (err) {
          // This account's DID document already has a delegation cert on
          // file, so the server mandates a valid signature — an unsigned
          // envelope here is guaranteed to be rejected. Propagate the real
          // error instead of quietly falling back to unsigned (see
          // PostCardSerializer.js's identical fix for the full rationale).
          // This was the root cause of WikiEditor autosave silently
          // submitting doomed unsigned envelopes whenever the ceremony failed.
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
    }

    // Singleton
    lively.identity.wikiSerializer = new lively.identity.WikiSerializer();

  }); // end module('lively.identity.WikiSerializer')
