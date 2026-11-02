/**
 * lively.identity.PartSerializer
 *
 * Builds and reads identity-aware PartsBin envelopes (type: 'part').
 * Parallel to lively.identity.PostCardSerializer's plain (non-Yjs) pair,
 * but for a part's already-serialized Lively JSON instead of a ProseMirror
 * doc — the caller (lively.PartsBin's copyToIdentityPartsSpace) still owns
 * calling morph.getPartItem().serializePart(morph) to get that JSON; this
 * module only turns the result into a signed (and optionally encrypted)
 * envelope, and reverses that on load.
 *
 * Envelope payload shape:
 *   Public   — record.payload = <the part's Lively JSON, exactly as
 *              serializePart() produced it — this is the pre-existing
 *              shape lively.identity.IdentityPartItem.loadPart already
 *              expects, unchanged, so already-published public parts keep
 *              loading with no migration>.
 *   Private/
 *   shared   — record.payload = encryptPayload(json, dek).ciphertext,
 *              record.nonce/wrappedDek/recipients alongside it — same
 *              KEK/DEK/seal machinery as PostCardSerializer.serializePlainEncrypted.
 *
 * envelope.state (partName, comment, tags, htmlLogo) is always plaintext
 * regardless of visibility, same reasoning as FileCrypto's file envelopes:
 * it's what the *myparts* / tag-category listings render without needing a
 * decrypt round trip per item, and none of it is the actual part content.
 *
 * Async pattern: thenDo(err, result) throughout.
 *
 * Dependencies:
 *   lively.identity.Crypto     — computeCid, encryptPayload, decryptPayload,
 *                                wrapDek, unwrapDek, sealForRecipient,
 *                                openSealedBox, signJws
 *   lively.identity.DID        — currentUser(), findMethodByCredentialId
 *   lively.identity.WebKey     — generateGenesisObjId
 *   lively.identity.WebAuthn   — _kekCache, deriveKek, deriveX25519KeyPair
 */

module('lively.identity.PartSerializer')
  .requires(
    'lively.identity.Crypto',
    'lively.identity.DID',
    'lively.identity.WebKey',
    'lively.identity.WebAuthn',
  )
  .toRun(function () {

    // Payload byte size above which record.payload is stored as a
    // {blobCid,size,mime} reference into the content-addressed blob store
    // (/@:handle/blobs/:cid) instead of inline in the Postgres envelope row
    // -- same shape as FileCrypto.js's file envelopes. Below this, payload
    // stays inline exactly as before. A plain `var` here is safe: unlike
    // lively.BuildSpec/addScript methods, Object.subclass methods below are
    // ordinary closures, not reconstructed from source text at call time
    // (see FileCrypto.js's FILE_CHUNK_SIZE for the identical precedent/
    // reasoning in this same codebase).
    var PART_BLOB_THRESHOLD = 200 * 1024;

    // ─── blob-store helpers (module-private copies, mirroring FileCrypto.js's
    //     _putBlob/_fetchBlobBytes -- each serializer owns its own copy of
    //     shared helpers in this codebase rather than a cross-file call, same
    //     convention _signEnvelopeIfPossible below already follows) ─────────

    function _putBlob(handle, cid, bytes, thenDo) {
      var base = lively.identity.did.baseUrl();
      fetch(base + '/@' + handle + '/blobs/' + cid, {
        method: 'PUT',
        credentials: 'include',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: bytes,
      }).then(function (res) {
        if (!res.ok) return res.json().then(function (b) {
          throw new Error('PartSerializer: blob upload failed: ' + (b.error || res.status));
        });
        return res.json();
      }).then(function (body) { thenDo(null, body); })
        .catch(function (e) { thenDo(e); });
    }

    // Part payloads/ciphertext are always text (unlike FileCrypto's binary
    // files), so this returns a UTF-8 string rather than raw bytes -- the
    // one real difference from FileCrypto.js's _fetchBlobBytes.
    function _fetchBlobText(handle, cid, thenDo) {
      var base = lively.identity.did.baseUrl();
      fetch(base + '/@' + handle + '/blobs/' + cid, { credentials: 'include' })
        .then(function (res) {
          if (!res.ok) throw new Error('PartSerializer: could not fetch blob ' + cid + ' (HTTP ' + res.status + ')');
          return res.text();
        })
        .then(function (text) { thenDo(null, text); })
        .catch(function (e) { thenDo(e); });
    }

    // Resolves {cid, payload, blobCid} for record.payload/record.cid from a
    // piece of text (plaintext JSON for public parts, ciphertext for
    // private/shared). Below PART_BLOB_THRESHOLD: cid over the text itself,
    // payload is the text, inline, exactly as before. Above it: upload the
    // UTF-8 bytes to the blob store first, then cid over the small
    // {blobCid,size,mime} reference object instead (same precedent as
    // FileCrypto.js's computeCid(metadata, ...) for a public file).
    // handle: the current user's own handle (uploads are always to the
    // caller's own blob space, same as FileCrypto.js). mime: content type to
    // record on the reference object, only used when blob-backed.
    // Calls thenDo(null, { payload, cid, blobCid }) -- blobCid is null when
    // the payload stayed inline.
    function _resolveRecordPayload(c, handle, text, mime, thenDo) {
      var bytes = new TextEncoder().encode(text);
      if (bytes.length <= PART_BLOB_THRESHOLD) {
        c.computeCid(text, function (err, cid) {
          if (err) return thenDo(err);
          thenDo(null, { payload: text, cid: cid, blobCid: null });
        });
        return;
      }
      c.sha256(bytes, function (err, blobCid) {
        if (err) return thenDo(err);
        _putBlob(handle, blobCid, bytes, function (err) {
          if (err) return thenDo(err);
          var payloadRef = { blobCid: blobCid, size: bytes.length, mime: mime };
          c.computeCid(payloadRef, function (err, cid) {
            if (err) return thenDo(err);
            thenDo(null, { payload: payloadRef, cid: cid, blobCid: blobCid });
          });
        });
      });
    }

    Object.subclass('lively.identity.PartSerializer',

    // ─── public parts (signed, unencrypted) ───────────────────────────────────

    'public', {

      // params: {
      //   json:        String  — serializePart(morph).json (required)
      //   partName:    String
      //   comment:     String  — optional
      //   tags:        Array   — optional, freeform
      //   category:    String  — optional, one of the curated Inventory
      //                          categories (inventory.md §7); null for
      //                          items published before this field existed
      //   htmlLogo:    String  — optional, from serializePart(morph).htmlLogo
      //   prevEnvelope: Object — previous version envelope for chaining
      // }
      // Calls thenDo(null, envelope).
      serializeToEnvelope: function (params, thenDo) {
        var c = lively.identity.crypto;
        var user = lively.identity.did.currentUser();
        if (!user) return thenDo(new Error('PartSerializer.serializeToEnvelope: no identity session active'));
        if (!params.json) return thenDo(new Error('PartSerializer.serializeToEnvelope: json is required'));

        _resolveRecordPayload(c, user.handle, params.json, 'application/json', function (err, resolved) {
          if (err) return thenDo(err);
          var prevEnvelope = params.prevEnvelope || null;
          var prevCid = prevEnvelope && prevEnvelope.record ? (prevEnvelope.record.cid || null) : null;

          function _buildEnvelope(objId, genesisNonce) {
            var state = {
              partName: params.partName,
              comment:  params.comment || '',
              tags:     params.tags || [],
              category: params.category || null,
              htmlLogo: params.htmlLogo || null,
            };
            var envelope = {
              objId: objId,
              did: user.did,
              type: 'part',
              visibility: 'public',
              created: (prevEnvelope && prevEnvelope.created) || new Date().toISOString(),
              record: { cid: resolved.cid, prevCid: prevCid, payload: resolved.payload },
              state: state,
            };
            if (genesisNonce) envelope.genesisNonce = genesisNonce;
            if (resolved.blobCid) envelope.blobCid = resolved.blobCid;

            _signEnvelopeIfPossible(envelope, user, c, function (signErr, signed) {
              if (signErr) return thenDo(signErr);
              thenDo(null, signed || envelope);
            });
          }

          if (prevEnvelope && prevEnvelope.objId) {
            _buildEnvelope(prevEnvelope.objId, null);
          } else {
            lively.identity.webKey.generateGenesisObjId(user.did, function (err, result) {
              if (err) return thenDo(err);
              _buildEnvelope(result.objId, result.genesisNonce);
            });
          }
        });
      },

      // handle: owner's handle, used only to build the blob-fetch URL when
      // this envelope's payload is blob-backed (see PART_BLOB_THRESHOLD
      // above) -- unused for an inline payload. Pass null/undefined if not
      // known; the blob route doesn't actually validate it against the
      // owner (see IdentityServer.js's /blobs/:cid GET handler), so any
      // string works, but the real handle is preferred when the caller has
      // it.
      // Calls thenDo(null, json, htmlLogo) — json is the plain Lively JSON
      // string, ready for IdentityPartItem.setPartFromJSON.
      deserializeFromEnvelope: function (envelope, handle, thenDo) {
        var c = lively.identity.crypto;
        if (!envelope || !envelope.record || !envelope.record.payload) {
          return thenDo(new Error('PartSerializer.deserializeFromEnvelope: invalid envelope structure'));
        }
        var payload = envelope.record.payload;
        var htmlLogo = envelope.state && envelope.state.htmlLogo || null;
        // CID check against whatever record.payload literally is -- the
        // small {blobCid,...} reference object for a blob-backed item, the
        // full JSON string otherwise. Never re-checked against resolved
        // blob bytes below: BlobStore.put() already verified
        // SHA-256(bytes) === cid at write time (same precedent as
        // FileCrypto.js's _fetchPublic/_fetchPrivate).
        c.computeCid(payload, function (err, expectedCid) {
          if (err) return thenDo(err);
          if (expectedCid !== envelope.record.cid) {
            return thenDo(new Error('PartSerializer.deserializeFromEnvelope: CID mismatch for objId=' + envelope.objId));
          }
          if (payload && typeof payload === 'object' && typeof payload.blobCid === 'string') {
            _fetchBlobText(handle || '_', payload.blobCid, function (err, json) {
              if (err) return thenDo(err);
              thenDo(null, json, htmlLogo);
            });
            return;
          }
          var json = typeof payload === 'string' ? payload : JSON.stringify(payload);
          thenDo(null, json, htmlLogo);
        });
      },

    },

    // ─── private / shared parts (KEK/DEK plane, mirrors PostCardSerializer) ──

    'private', {

      // Resolve each handle to { did, handle, x25519PublicKey }, no caching
      // (a one-shot publish dialog has no autosave loop to amortize against,
      // unlike PostCardEditor's _resolveRecipientPubKeys). Calls
      // thenDo(null, { resolved: [...], failed: [handle, ...] }).
      resolveRecipientPubKeys: function (handles, thenDo) {
        if (!handles || !handles.length) return thenDo(null, { resolved: [], failed: [] });
        var base = lively.identity.did.baseUrl();
        var resolved = [];
        var failed = [];
        var remaining = handles.length;
        function done() {
          if (--remaining === 0) thenDo(null, { resolved: resolved, failed: failed });
        }
        handles.forEach(function (handle) {
          lively.identity.webKey.resolveHandle(handle, function (err, info) {
            if (err || !info || !info.did) { failed.push(handle); return done(); }
            var xhr = new XMLHttpRequest();
            xhr.open('GET', base + '/@' + encodeURIComponent(handle) + '/profile', true);
            xhr.withCredentials = true;
            xhr.onload = function () {
              if (xhr.status !== 200) { failed.push(handle); return done(); }
              var env;
              try { env = JSON.parse(xhr.responseText); } catch (e) { failed.push(handle); return done(); }
              var pub = env.record && env.record.payload && env.record.payload.accountX25519Pub;
              if (!pub) { failed.push(handle); return done(); }
              lively.identity.crypto.computeCid(env.record.payload, function (cidErr, cid) {
                if (cidErr || cid !== env.record.cid) { failed.push(handle); return done(); }
                resolved.push({ did: info.did, handle: handle, x25519PublicKey: pub });
                done();
              });
            };
            xhr.onerror = function () { failed.push(handle); done(); };
            xhr.send();
          });
        });
      },

      // params: same as serializeToEnvelope, plus:
      //   recipients: Array of { did, x25519PublicKey } — non-empty => 'shared'
      // Requires the KEK to be cached (WebAuthn._kekCache) — call
      // WebAuthn.deriveKek first, same precondition as PostCardSerializer.
      // Calls thenDo(null, envelope).
      serializeEncrypted: function (params, thenDo) {
        var c = lively.identity.crypto;
        var wa = lively.identity.webAuthn;
        var user = lively.identity.did.currentUser();
        if (!user) return thenDo(new Error('PartSerializer.serializeEncrypted: no identity session'));
        if (!wa || !wa._kekCache || !wa._kekCache[user.credentialId]) {
          return thenDo(new Error(
            'PartSerializer.serializeEncrypted: KEK not cached for this session. ' +
            'Call WebAuthn.deriveKek first (prompts once per session).'
          ));
        }
        if (!params.json) return thenDo(new Error('PartSerializer.serializeEncrypted: json is required'));
        var kek = wa._kekCache[user.credentialId];

        c.wrapDek(kek, function (err, dekResult) {
          if (err) return thenDo(err);
          var dek = dekResult.dek;

          c.encryptPayload(params.json, dek, function (err, encrypted) {
            if (err) return thenDo(err);

            _resolveRecordPayload(c, user.handle, encrypted.ciphertext, 'application/octet-stream', function (err, resolved) {
              if (err) return thenDo(err);

              var prevEnvelope = params.prevEnvelope || null;
              var prevCid = prevEnvelope && prevEnvelope.record ? (prevEnvelope.record.cid || null) : null;

              function _buildEnvelope(objId, genesisNonce, recipientWraps) {
                var state = {
                  partName: params.partName,
                  comment:  params.comment || '',
                  tags:     params.tags || [],
                  category: params.category || null,
                  htmlLogo: params.htmlLogo || null,
                };
                var visibility = (params.recipients && params.recipients.length) ? 'shared' : 'private';
                var envelope = {
                  objId: objId,
                  did: user.did,
                  type: 'part',
                  visibility: visibility,
                  created: (prevEnvelope && prevEnvelope.created) || new Date().toISOString(),
                  record: {
                    cid: resolved.cid,
                    prevCid: prevCid,
                    payload: resolved.payload,
                    nonce: encrypted.nonce,
                    wrappedDek: dekResult.wrappedDek,
                    recipients: recipientWraps,
                  },
                  state: state,
                };
                if (genesisNonce) envelope.genesisNonce = genesisNonce;
                if (resolved.blobCid) envelope.blobCid = resolved.blobCid;

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
                  return _buildEnvelope(objId, genesisNonce, []);
                }
                var recipientWraps = [];
                var remaining = params.recipients.length;
                var hadError = false;
                params.recipients.forEach(function (r) {
                  c.sealForRecipient(dek, r.x25519PublicKey, function (err, sealed) {
                    if (hadError) return;
                    if (err) { hadError = true; return thenDo(err); }
                    recipientWraps.push({ did: r.did, sealedDek: sealed });
                    if (--remaining === 0) _buildEnvelope(objId, genesisNonce, recipientWraps);
                  });
                });
              });
            });
          });
        });
      },

      // handle: owner's handle, for the blob-fetch URL when this envelope's
      // ciphertext is blob-backed -- same role/fallback as
      // deserializeFromEnvelope's handle param above.
      // Decrypts a private/shared part envelope for either its owner or one
      // of its recipients. Calls thenDo(null, json, htmlLogo).
      deserializeEncrypted: function (envelope, handle, thenDo) {
        var c = lively.identity.crypto;
        var wa = lively.identity.webAuthn;
        var user = lively.identity.did.currentUser();
        if (!user) return thenDo(new Error('PartSerializer.deserializeEncrypted: no identity session'));
        if (!envelope || !envelope.record || !envelope.record.payload) {
          return thenDo(new Error('PartSerializer.deserializeEncrypted: invalid envelope structure'));
        }

        c.computeCid(envelope.record.payload, function (err, expectedCid) {
          if (err) return thenDo(err);
          if (expectedCid !== envelope.record.cid) {
            return thenDo(new Error('PartSerializer.deserializeEncrypted: CID mismatch for objId=' + envelope.objId));
          }

          function withCiphertext(cb) {
            var payload = envelope.record.payload;
            if (payload && typeof payload === 'object' && typeof payload.blobCid === 'string') {
              return _fetchBlobText(handle || '_', payload.blobCid, cb);
            }
            cb(null, payload);
          }

          withCiphertext(function (err, ciphertext) {
            if (err) return thenDo(err);
            _unwrapDekForEnvelope(envelope, user, wa, c, function (err, dek) {
              if (err) return thenDo(err);
              c.decryptPayload(ciphertext, envelope.record.nonce, dek, function (err, parsed) {
                if (err) return thenDo(err);
                // decryptPayload always JSON.parses the plaintext (Crypto.js) —
                // parsed is the part's Lively JSON as a JS object here, not a
                // string. IdentityPartItem.setPartFromJSON wants a string.
                var json = JSON.stringify(parsed);
                var htmlLogo = envelope.state && envelope.state.htmlLogo || null;
                thenDo(null, json, htmlLogo);
              });
            });
          });
        });
      },

    });

    // ─── curated categories (inventory.md §7) ──────────────────────────────────
    // Shared source of truth for the 5 curated Inventory categories — a
    // namespace-object property (never a closure var), per this codebase's
    // documented BuildSpec-methods-lose-their-closure gotcha, since both
    // PublishToInventoryDialog.js's spec-level methods and Inventory.js's
    // future item-tile morph need to resolve this by a global path at call
    // time, not a lexical binding that gets discarded on reconstruction.
    Object.extend(lively.identity.PartSerializer, {
      CATEGORY_NAMES: ['Media', 'Games', 'Templates', 'Apps', 'Tools'],
      CATEGORY_META: {
        Media:     { icon: 'photo_camera',   tint: '#f4e9ff', accent: '#9333ea' },
        Games:     { icon: 'sports_esports', tint: '#eafaf0', accent: '#16a34a' },
        Templates: { icon: 'description',    tint: '#fdeaf1', accent: '#db2777' },
        Apps:      { icon: 'widgets',        tint: '#e9f0ff', accent: '#2563eb' },
        Tools:     { icon: 'build',          tint: '#fff7e6', accent: '#d97706' }
      },
      // Fallback icon/tint for an item with no category (published before
      // this field existed, or a legacy classic-WebDAV part) — a neutral
      // box glyph rather than reusing any one curated category's own icon.
      UNCATEGORIZED_META: { icon: 'inventory_2', tint: '#f0f0f0', accent: '#757575' }
    });

    // ─── shared signing helper (mirrors PostCardSerializer._signEnvelopeIfPossible,
    //     itself mirroring SignedSerializer._signEnvelopeIfPossible) ───────────────

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

    // ─── shared DEK-unwrap helper (mirrors PostCardSerializer._unwrapDekForEnvelope) ─

    function _unwrapDekForEnvelope(envelope, user, wa, c, thenDo) {
      var isOwner = user.did === envelope.did;
      if (isOwner) {
        function withKek(dekCallback) {
          if (wa && wa._kekCache && wa._kekCache[user.credentialId]) {
            return dekCallback(null, wa._kekCache[user.credentialId]);
          }
          var ch = new Uint8Array(32);
          crypto.getRandomValues(ch);
          wa.deriveKek({ credentialId: user.credentialId, rpId: user.rpId, challenge: ch }, dekCallback);
        }
        withKek(function (err, kek) {
          if (err) return thenDo(err);
          c.unwrapDek(envelope.record.wrappedDek, kek, thenDo);
        });
      } else {
        var myEntry = (envelope.record.recipients || []).find(function (r) { return r.did === user.did; });
        if (!myEntry) return thenDo(new Error('PartSerializer: no sealed DEK for current user'));
        var ch = new Uint8Array(32);
        crypto.getRandomValues(ch);
        wa.deriveX25519KeyPair({ credentialId: user.credentialId, rpId: user.rpId, challenge: ch }, function (err, pair) {
          if (err) return thenDo(err);
          c.openSealedBox(myEntry.sealedDek, pair.publicKey, pair.privateKey, thenDo);
        });
      }
    }

    // Singleton: lively.identity.partSerializer.serializeToEnvelope(...), etc.
    lively.identity.partSerializer = new lively.identity.PartSerializer();

  }); // end module('lively.identity.PartSerializer')
