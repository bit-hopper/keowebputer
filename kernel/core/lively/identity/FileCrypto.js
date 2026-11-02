/**
 * lively.identity.FileCrypto
 *
 * Encrypt-before-upload file handling for the Lively identity system
 * (Encryption.md §5). Shared by FilesBrowser, ProfileCard, and (§6)
 * PostCardEditor's attachment flow. Also owns the encrypted-folder
 * operations (Encryption.md §15, added 2026-09-04) — a folder is not
 * different enough from a file to warrant a separate module: both are
 * KEK/DEK/sealedDek envelopes over the same BlobStore, just with a folder's
 * DEK fixed for its lifetime instead of rotated per version (see §15.2 for
 * why, and the "folder" section below).
 *
 * A "file" object is a small encrypted-metadata envelope (type: 'file',
 * stored via the ordinary PUT /@:handle/:objId route) plus the actual file
 * bytes in the content-addressed BlobStore (PUT/GET /@:handle/blobs/:cid).
 * Both halves share one DEK — wrapping/sealing already covers both, so
 * there's no separate key ceremony for the blob.
 *
 * Envelope payload shape (§5.1), before encryption:
 *   { name, mime, size, blobCid, blobNonce }
 * blobCid = sha256 of the RAW ciphertext bytes (or plaintext bytes for a
 * public file) — must match exactly what BlobStore.put verifies server-side,
 * so it is computed via Crypto.sha256 on the raw bytes, NOT via computeCid's
 * canonical-JSON path (which is only for the envelope's own record.cid).
 *
 * Async pattern: thenDo(err, result) throughout.
 *
 * Dependencies:
 *   lively.identity.Crypto     — encryptBytes/decryptBytes, encryptPayload/
 *                                decryptPayload, wrapDek/unwrapDek, sha256,
 *                                sealForRecipient/openSealedBox, computeCid
 *   lively.identity.WebAuthn   — _kekCache, deriveKek, deriveX25519KeyPair
 *   lively.identity.DID        — currentUser()
 *   lively.identity.WebKey     — generateGenesisObjId
 */

module('lively.identity.FileCrypto')
  .requires(
    'lively.identity.Crypto',
    'lively.identity.WebAuthn',
    'lively.identity.DID',
    'lively.identity.WebKey',
  )
  .toRun(function () {

    // Plaintext bytes per chunk for the streaming (crypto_secretstream)
    // encrypt/decrypt path below — see DeployCheckList.md's large-file
    // scoping note. 1 MiB: large enough that per-chunk overhead (both the
    // 17-byte MAC and the JS call itself) is negligible, small enough that
    // peak resident memory during encrypt/decrypt stays in the low single-
    // digit MB regardless of total file size. A plain `var` here (not a
    // namespace property) is safe: unlike lively.BuildSpec/addScript
    // methods, Object.subclass methods are ordinary closures, not
    // reconstructed from source text at call time.
    var FILE_CHUNK_SIZE = 1024 * 1024;

    Object.subclass('lively.identity.FileCrypto',

    'kek', {

      // Same withKek pattern as PostCardEditor._saveNowPrivate: reuse the
      // session's cached KEK, otherwise prompt once (this may show a
      // "Confirm passkey…" moment to the caller via the optional onWaiting
      // callback — FilesBrowser/ProfileCard can use it to update status text).
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

      // Mirrors SignedSerializer._signEnvelopeIfPossible / PostCardSerializer.js's
      // own copy of the same helper — this codebase's established pattern is a
      // module-local copy per serializer rather than one shared function (see
      // PostCardSerializer.js/WikiSerializer.js/PartSerializer.js, each with
      // their own). Needed here because FileCrypto builds its envelopes by
      // hand rather than going through SignedSerializer, so it never picked up
      // this step when signature verification became mandatory server-side
      // (postcard_audit.md F20, 2026-09-05) — every content write (new file,
      // new/edited folder) was landing unsigned and getting 403'd. A
      // metadata-only write (shareFolder/revokeFolderRecipient, which only
      // ever touch record.recipients/visibility and never change record.cid)
      // doesn't need this — the server already exempts those entirely.
      // Gracefully degrades to an unsigned envelope only if delegation/soft-key
      // setup isn't present at all (no credential on file expects a
      // signature). If that setup IS present but the KEK can't actually be
      // derived, the account's DID document already commits it to signing, so
      // the deriveKek error itself is propagated as fatal here rather than
      // silently producing an unsigned envelope the server's mandatory
      // signature check is guaranteed to 403.
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
            // Unlike the two early-return branches above (no delegation cert
            // at all), this account's DID document already has one on file,
            // so the server mandates a valid signature — an unsigned envelope
            // here is guaranteed to be rejected. Propagate the real error
            // instead of quietly falling back to unsigned (see
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
      },

    },

    'upload', {

      // Read a File/Blob into a Uint8Array. Only used for public (unencrypted)
      // uploads and small non-file payloads — the private/shared file path
      // below reads (and encrypts) in bounded FILE_CHUNK_SIZE chunks instead,
      // via _encryptFileChunked, specifically to avoid this.
      _readFile: function (file, thenDo) {
        var reader = new FileReader();
        reader.onload = function () { thenDo(null, new Uint8Array(reader.result)); };
        reader.onerror = function () { thenDo(reader.error || new Error('FileCrypto: could not read file')); };
        reader.readAsArrayBuffer(file);
      },

      // Encrypt a File/Blob under `dek` using crypto_secretstream, reading
      // and encrypting FILE_CHUNK_SIZE bytes at a time so the full plaintext
      // is never resident in memory at once (DeployCheckList.md's large-file
      // scoping note — the whole reason this exists instead of just calling
      // c.encryptBytes on the result of _readFile). Wire format: [header]
      // [chunk1 ciphertext]...[chunkN ciphertext, pushed with isFinal=true].
      // A zero-byte file still produces exactly one (empty) final chunk.
      //
      // The ciphertext is assembled as a Blob built from an array of
      // per-chunk Blob parts, not one concatenated Uint8Array/ArrayBuffer —
      // this is what actually keeps peak *contiguous* memory bounded: a
      // browser does not require a Blob built this way to be backed by one
      // contiguous heap allocation the way a manually-concatenated typed
      // array would be, and `fetch`'s Blob-body path (see _putBlob) streams
      // it without materializing it either.
      //
      // Calls thenDo(null, { blob: <Blob>, size: <original plaintext bytes> }).
      _encryptFileChunked: function (file, dek, thenDo) {
        var c = lively.identity.crypto;
        var total = file.size;

        c.streamInitPush(dek, function (err, push) {
          if (err) return thenDo(err);
          var parts = [push.header];
          var offset = 0;

          function nextChunk() {
            var end = Math.min(offset + FILE_CHUNK_SIZE, total);
            var isFinal = end >= total;
            file.slice(offset, end).arrayBuffer().then(function (buf) {
              c.streamPush(push.state, new Uint8Array(buf), isFinal, function (err, ciphertext) {
                if (err) return thenDo(err);
                parts.push(ciphertext);
                offset = end;
                if (isFinal) return thenDo(null, { blob: new Blob(parts), size: total });
                nextChunk();
              });
            }).catch(function (e) { thenDo(e); });
          }

          nextChunk();
        });
      },

      // Decrypt a chunked-secretstream blob as it downloads, symmetric to
      // _encryptFileChunked: reads the fetch Response's body incrementally
      // (res.body.getReader(), not res.arrayBuffer()) so the full ciphertext
      // is never resident at once either. `response`: a fetch Response whose
      // body is the wire format _encryptFileChunked produced.
      // Calls thenDo(null, <Blob of decrypted plaintext>).
      _decryptBlobChunked: function (response, dek, thenDo) {
        var c = lively.identity.crypto;
        var self = this;
        var failed = false;
        function fail(e) { if (failed) return; failed = true; thenDo(e); }

        c.streamHeaderBytes(function (err, HEADERBYTES) {
          if (err) return fail(err);
          c.streamAbytes(function (err, ABYTES) {
            if (err) return fail(err);

            var CIPHER_CHUNK = FILE_CHUNK_SIZE + ABYTES;
            var reader = response.body.getReader();
            var pending = new Uint8Array(0);
            var pullState = null;
            var sawFinal = false;
            var decryptedParts = [];

            function appendPending(chunk) {
              var merged = new Uint8Array(pending.length + chunk.length);
              merged.set(pending, 0);
              merged.set(chunk, pending.length);
              pending = merged;
            }

            function pullOne(bytes, cb) {
              c.streamPull(pullState, bytes, function (err, res) {
                if (err) return fail(err);
                decryptedParts.push(res.message);
                if (res.isFinal) sawFinal = true;
                cb();
              });
            }

            // Consumes as many complete CIPHER_CHUNK-sized pieces of
            // `pending` as are available. Once the underlying stream is
            // done, whatever (necessarily shorter) remainder is left must be
            // the final chunk — a real transfer never ends mid-chunk.
            function drain(streamDone, cb) {
              if (sawFinal) return cb();
              if (pending.length >= CIPHER_CHUNK) {
                var chunk = pending.slice(0, CIPHER_CHUNK);
                pending = pending.slice(CIPHER_CHUNK);
                return pullOne(chunk, function () { drain(streamDone, cb); });
              }
              if (!streamDone) return cb();
              if (pending.length === 0) return cb();
              var last = pending;
              pending = new Uint8Array(0);
              pullOne(last, cb);
            }

            function ensureHeaderThen(cb) {
              if (pullState) return cb();
              if (pending.length < HEADERBYTES) return cb(); // wait for more bytes
              var header = pending.slice(0, HEADERBYTES);
              pending = pending.slice(HEADERBYTES);
              c.streamInitPull(header, dek, function (err, state) {
                if (err) return fail(err);
                pullState = state;
                cb();
              });
            }

            function pump() {
              reader.read().then(function (result) {
                if (result.value) appendPending(result.value);
                ensureHeaderThen(function () {
                  if (!pullState) {
                    if (result.done) return fail(new Error('_decryptBlobChunked: stream ended before the header was fully received'));
                    return pump();
                  }
                  drain(result.done, function () {
                    if (failed) return;
                    if (!result.done) return pump();
                    if (!sawFinal) return fail(new Error('_decryptBlobChunked: stream ended before a final chunk was seen — truncated or corrupted blob'));
                    thenDo(null, new Blob(decryptedParts));
                  });
                });
              }).catch(fail);
            }

            pump();
          });
        });
      },

      // PUT raw bytes (or a Blob — fetch streams a Blob body without
      // materializing it, which is why _encryptFileChunked hands this a
      // Blob rather than a concatenated Uint8Array) to the content-addressed
      // blob store.
      _putBlob: function (handle, cid, bytes, thenDo) {
        var base = lively.identity.did.baseUrl();
        fetch(base + '/@' + handle + '/blobs/' + cid, {
          method: 'PUT',
          credentials: 'include',
          headers: { 'Content-Type': 'application/octet-stream' },
          body: bytes,
        }).then(function (res) {
          if (!res.ok) return res.json().then(function (b) {
            throw new Error('Blob upload failed: ' + (b.error || res.status));
          });
          return res.json();
        }).then(function (body) { thenDo(null, body); })
          .catch(function (e) { thenDo(e); });
      },

      // DELETE a blob's bytes — same call FilesBrowser._deleteFile makes for
      // a top-level file delete, factored out here too since moveFileInto
      // Folder needs it to reclaim the original blob after re-encrypting the
      // file's bytes under the folder's own dek.
      _deleteBlob: function (handle, blobCid, thenDo) {
        var base = lively.identity.did.baseUrl();
        fetch(base + '/@' + handle + '/blobs/' + blobCid, {
          method: 'DELETE',
          credentials: 'include',
        }).then(function (res) {
          if (!res.ok) return res.json().then(function (b) {
            throw new Error(b.error || ('Blob delete failed: ' + res.status));
          });
          thenDo(null);
        }).catch(function (e) { thenDo(e); });
      },

      _putEnvelope: function (handle, envelope, thenDo) {
        var base = lively.identity.did.baseUrl();
        fetch(base + '/@' + handle + '/' + envelope.objId, {
          method: 'PUT',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(envelope),
        }).then(function (res) {
          if (!res.ok) return res.json().then(function (b) {
            throw new Error('File envelope save failed: ' + (b.error || res.status));
          });
          return res.json();
        }).then(function (body) { thenDo(null, body); })
          .catch(function (e) { thenDo(e); });
      },

      // opts: {
      //   visibility: 'private' | 'public'  (default 'private' — §0 goal:
      //               encrypted unless explicitly marked public)
      //   recipients: [{ did, x25519PublicKey }]  — for 'shared' (implied by
      //               a non-empty recipients list, same rule as postcards)
      //   name:       optional override for file.name — a cropped-avatar
      //               canvas Blob (ProfileCard.js) has no .name of its own
      //   onWaiting:  optional callback fired if a passkey prompt is needed
      // }
      // Calls thenDo(null, { objId, blobCid, dek }). dek (Uint8Array, or null
      // for a public file) is returned so a caller embedding this file inside
      // another encrypted payload (postcard attachments, §6) can carry the
      // same key without a second key ceremony.
      encryptAndUpload: function (file, opts, thenDo) {
        var self = this;
        var c = lively.identity.crypto;
        var user = lively.identity.did.currentUser();
        if (!user) return thenDo(new Error('encryptAndUpload: no identity session active'));

        opts = opts || {};
        var isPublic = opts.visibility === 'public';
        var fileName = opts.name || file.name || 'file';
        var recipients = opts.recipients || [];

        function withDek(cb) {
          if (isPublic) return cb(null, null);
          self._withKek(user, opts.onWaiting, function (err, kek) {
            if (err) return cb(err);
            c.wrapDek(kek, function (err, dekResult) { cb(err, dekResult); });
          });
        }

        withDek(function (err, dekResult) {
          if (err) return thenDo(err);
          var dek = dekResult ? dekResult.dek : null;

          // Private/shared files go through the chunked crypto_secretstream
          // path (_encryptFileChunked) so the plaintext is never fully
          // resident in memory — the whole point of this codepath (see
          // DeployCheckList.md's large-file scoping note). Public files
          // still go through the old whole-file _readFile path: there's no
          // encryption to chunk in the first place, and hashing a large
          // public file has the identical unsolved incremental-hash gap
          // documented in that same scoping note — left as-is, out of scope
          // here.
          function withCipherBlob(cb) {
            if (isPublic) {
              self._readFile(file, function (err, plainBytes) {
                if (err) return cb(err);
                cb(null, { blob: new Blob([plainBytes]), size: plainBytes.length, chunked: false });
              });
              return;
            }
            self._encryptFileChunked(file, dek, function (err, result) {
              if (err) return cb(err);
              cb(null, { blob: result.blob, size: result.size, chunked: true });
            });
          }

          withCipherBlob(function (err, cipher) {
            if (err) return thenDo(err);

            cipher.blob.arrayBuffer().then(function (buf) {
              c.sha256(new Uint8Array(buf), function (err, blobCid) {
                if (err) return thenDo(err);

                self._putBlob(user.handle, blobCid, cipher.blob, function (err, putResult) {
                  if (err) return thenDo(err);
                  // Server-computed, federation-safe absolute URL for this
                  // blob (see IdentityServer.js's canonicalOrigin) -- never
                  // construct one client-side from location.origin, which
                  // just reflects whichever hostname alias served this page.
                  var blobUrl = putResult && putResult.url;

                  var metadata = {
                    name: fileName,
                    mime: file.type || 'application/octet-stream',
                    size: cipher.size,
                    blobCid: blobCid,
                    // A chunked blob's nonce is its inline header (part of
                    // the blob bytes themselves, see _encryptFileChunked) —
                    // there is no separate per-blob nonce to store here the
                    // way the old whole-file secretbox path needed. `chunked`
                    // is what fetchAndDecrypt/folderFileUrl/resolveAttachmentUrl
                    // branch on to know which decrypt path applies; absent/
                    // false means the old secretbox format (real blobNonce
                    // required) — every already-uploaded file is this shape.
                    blobNonce: null,
                    chunked: cipher.chunked,
                  };

                  lively.identity.webKey.generateGenesisObjId(user.did, function (err, gen) {
                    if (err) return thenDo(err);

                    function _buildAndPut(record, envelopeExtra) {
                      var envelope = Object.assign({
                        objId: gen.objId,
                        did: user.did,
                        genesisNonce: gen.genesisNonce,
                        type: 'file',
                        visibility: isPublic ? 'public' : (recipients.length ? 'shared' : 'private'),
                        created: new Date().toISOString(),
                        record: record,
                        blobCid: blobCid,
                        state: { name: fileName },
                      }, envelopeExtra || {});
                      self._signEnvelopeIfPossible(envelope, user, c, function (signErr, signed) {
                        if (signErr) return thenDo(signErr);
                        self._putEnvelope(user.handle, signed || envelope, function (err) {
                          if (err) return thenDo(err);
                          // blobNonce is always null now (public: blob is
                          // plaintext; private/shared: the header travels
                          // inline in the blob instead, see
                          // _encryptFileChunked) — kept in the result shape
                          // for callers that already read it. `chunked` is
                          // returned (along with dek) for callers that embed
                          // both directly rather than going through
                          // fetchAndDecrypt — e.g. postcard attachments
                          // (Encryption.md §6), which need it to pick the
                          // right decrypt path in resolveAttachmentUrl.
                          thenDo(null, { objId: gen.objId, blobCid: blobCid, blobNonce: null, chunked: cipher.chunked, dek: dek, url: blobUrl });
                        });
                      });
                    }

                    if (isPublic) {
                      c.computeCid(metadata, function (err, cid) {
                        if (err) return thenDo(err);
                        _buildAndPut({ cid: cid, prevCid: null, payload: metadata });
                      });
                      return;
                    }

                    c.encryptPayload(metadata, dek, function (err, encrypted) {
                      if (err) return thenDo(err);
                      c.computeCid(encrypted.ciphertext, function (err, cid) {
                        if (err) return thenDo(err);

                        function _withRecipientWraps(cb) {
                          if (!recipients.length) return cb(null, []);
                          var wraps = [];
                          var remaining = recipients.length;
                          var hadError = false;
                          recipients.forEach(function (r) {
                            c.sealForRecipient(dek, r.x25519PublicKey, function (err, sealed) {
                              if (hadError) return;
                              if (err) { hadError = true; return cb(err); }
                              wraps.push({ did: r.did, sealedDek: sealed });
                              if (--remaining === 0) cb(null, wraps);
                            });
                          });
                        }

                        _withRecipientWraps(function (err, recipientWraps) {
                          if (err) return thenDo(err);
                          _buildAndPut({
                            cid: cid,
                            prevCid: null,
                            payload: encrypted.ciphertext,
                            nonce: encrypted.nonce,
                            wrappedDek: dekResult.wrappedDek,
                            recipients: recipientWraps,
                          });
                        });
                      });
                    });
                  });
                });
              });
            });
          });
        });
      },

    },

    'fetch', {

      // Fetch a file envelope + blob and decrypt back to the original bytes.
      // handle: owner's handle. objId: the file envelope's objId.
      // Calls thenDo(null, { bytes: Uint8Array, mime, name, size }).
      fetchAndDecrypt: function (handle, objId, thenDo) {
        var self = this;
        var c = lively.identity.crypto;
        var base = lively.identity.did.baseUrl();

        fetch(base + '/@' + handle + '/' + objId, { credentials: 'include' })
          .then(function (res) {
            if (!res.ok) throw new Error('Could not fetch file envelope (HTTP ' + res.status + ')');
            return res.json();
          })
          .then(function (envelope) {
            if (envelope.type !== 'file') {
              throw new Error('fetchAndDecrypt: envelope ' + objId + ' is not a file');
            }
            if (envelope.visibility === 'public') {
              return self._fetchPublic(handle, envelope, thenDo);
            }
            self._fetchPrivate(handle, envelope, thenDo);
          })
          .catch(function (e) { thenDo(e); });
      },

      _fetchPublic: function (handle, envelope, thenDo) {
        var metadata = envelope.record.payload;
        this._fetchBlobBytes(handle, metadata.blobCid, function (err, bytes) {
          if (err) return thenDo(err);
          thenDo(null, { bytes: bytes, mime: metadata.mime, name: metadata.name, size: metadata.size });
        });
      },

      _fetchPrivate: function (handle, envelope, thenDo) {
        var self = this;
        var c = lively.identity.crypto;
        var wa = lively.identity.webAuthn;
        var user = lively.identity.did.currentUser();
        if (!user) return thenDo(new Error('fetchAndDecrypt: no identity session'));

        // CID check on the ciphertext, same invariant as every other envelope type.
        c.computeCid(envelope.record.payload, function (err, expectedCid) {
          if (err) return thenDo(err);
          if (expectedCid !== envelope.record.cid) {
            return thenDo(new Error('fetchAndDecrypt: CID mismatch for objId=' + envelope.objId));
          }

          function withDek(cb) {
            var isOwner = user.did === envelope.did;
            if (isOwner) {
              self._withKek(user, null, function (err, kek) {
                if (err) return cb(err);
                c.unwrapDek(envelope.record.wrappedDek, kek, cb);
              });
              return;
            }
            var myEntry = (envelope.record.recipients || []).find(function (r) { return r.did === user.did; });
            if (!myEntry) return cb(new Error('fetchAndDecrypt: no sealed DEK for current user'));
            var ch = new Uint8Array(32);
            crypto.getRandomValues(ch);
            wa.deriveX25519KeyPair({ credentialId: user.credentialId, rpId: user.rpId, challenge: ch }, function (err, pair) {
              if (err) return cb(err);
              c.openSealedBox(myEntry.sealedDek, pair.publicKey, pair.privateKey, cb);
            });
          }

          withDek(function (err, dek) {
            if (err) return thenDo(err);
            c.decryptPayload(envelope.record.payload, envelope.record.nonce, dek, function (err, metadata) {
              if (err) return thenDo(err);
              if (metadata.chunked) {
                // Streamed download+decrypt (_decryptBlobChunked never holds
                // the full ciphertext at once) -- the one remaining
                // materialization here is the final decrypted Blob into a
                // Uint8Array, to keep fetchAndDecrypt's existing return
                // contract unchanged for every caller. objectUrlFor
                // immediately re-wraps `bytes` into another Blob anyway, so
                // a future pass could return the Blob directly and skip
                // this — not done here to keep this change's blast radius
                // limited to the encrypt/decrypt path itself.
                self._fetchBlobResponse(handle, metadata.blobCid, function (err, response) {
                  if (err) return thenDo(err);
                  self._decryptBlobChunked(response, dek, function (err, blob) {
                    if (err) return thenDo(err);
                    blob.arrayBuffer().then(function (buf) {
                      thenDo(null, { bytes: new Uint8Array(buf), mime: metadata.mime, name: metadata.name, size: metadata.size });
                    }).catch(function (e) { thenDo(e); });
                  });
                });
                return;
              }
              self._fetchBlobBytes(handle, metadata.blobCid, function (err, cipherBytes) {
                if (err) return thenDo(err);
                c.decryptBytes(cipherBytes, metadata.blobNonce, dek, function (err, plainBytes) {
                  if (err) return thenDo(err);
                  thenDo(null, { bytes: plainBytes, mime: metadata.mime, name: metadata.name, size: metadata.size });
                });
              });
            });
          });
        });
      },

      _fetchBlobBytes: function (handle, blobCid, thenDo) {
        var base = lively.identity.did.baseUrl();
        fetch(base + '/@' + handle + '/blobs/' + blobCid, { credentials: 'include' })
          .then(function (res) {
            if (!res.ok) throw new Error('Could not fetch blob ' + blobCid + ' (HTTP ' + res.status + ')');
            return res.arrayBuffer();
          })
          .then(function (buf) { thenDo(null, new Uint8Array(buf)); })
          .catch(function (e) { thenDo(e); });
      },

      // Sibling of _fetchBlobBytes that hands back the raw Response instead
      // of materializing it, for the chunked decrypt path (_decryptBlobChunked)
      // to stream incrementally via response.body.getReader().
      _fetchBlobResponse: function (handle, blobCid, thenDo) {
        var base = lively.identity.did.baseUrl();
        fetch(base + '/@' + handle + '/blobs/' + blobCid, { credentials: 'include' })
          .then(function (res) {
            if (!res.ok) throw new Error('Could not fetch blob ' + blobCid + ' (HTTP ' + res.status + ')');
            thenDo(null, res);
          })
          .catch(function (e) { thenDo(e); });
      },

    },

    'objectUrl', {

      // fetchAndDecrypt -> Blob -> URL.createObjectURL, cached per objId+cid
      // so repeated opens/renders of the same version don't re-decrypt.
      // Calls thenDo(null, objectUrl).
      objectUrlFor: function (handle, objId, thenDo) {
        if (!this._urlCache) this._urlCache = {};
        var cacheKey = handle + '/' + objId;
        if (this._urlCache[cacheKey]) return thenDo(null, this._urlCache[cacheKey]);

        var self = this;
        this.fetchAndDecrypt(handle, objId, function (err, result) {
          if (err) return thenDo(err);
          var blob = new Blob([result.bytes], { type: result.mime });
          var url = URL.createObjectURL(blob);
          self._urlCache[cacheKey] = url;
          thenDo(null, url);
        });
      },

      // Postcard-attachment variant of objectUrlFor (Encryption.md §6): the
      // attachment's dek travels inside the postcard's own decrypted payload
      // rather than being wrapped/sealed in the attachment's own file
      // envelope, so this skips fetchAndDecrypt's envelope fetch + KEK/
      // sealedDek unwrap entirely and goes straight blob-fetch -> decrypt.
      // attachment: { blobCid, blobNonce, dek, mime, chunked } — dek/blobNonce
      // null for a public postcard's attachment (blob is already plaintext);
      // chunked true for an attachment uploaded via the crypto_secretstream
      // path (see encryptAndUpload/PostCardEditor.js's attachment entry).
      // Cached per blobCid (content-addressed, so this is safe across
      // versions/attachments that happen to share bytes).
      // Calls thenDo(null, objectUrl).
      resolveAttachmentUrl: function (handle, attachment, thenDo) {
        if (!this._urlCache) this._urlCache = {};
        var cacheKey = 'attachment:' + attachment.blobCid;
        if (this._urlCache[cacheKey]) return thenDo(null, this._urlCache[cacheKey]);

        var self = this;
        var c = lively.identity.crypto;

        function withPlainBlob(plainBlob) {
          var url = URL.createObjectURL(plainBlob);
          self._urlCache[cacheKey] = url;
          thenDo(null, url);
        }

        if (attachment.dek && attachment.chunked) {
          this._fetchBlobResponse(handle, attachment.blobCid, function (err, response) {
            if (err) return thenDo(err);
            self._decryptBlobChunked(response, attachment.dek, function (err, plainBlob) {
              if (err) return thenDo(err);
              withPlainBlob(new Blob([plainBlob], { type: attachment.mime || 'application/octet-stream' }));
            });
          });
          return;
        }

        this._fetchBlobBytes(handle, attachment.blobCid, function (err, bytes) {
          if (err) return thenDo(err);
          function asBlob(plainBytes) {
            withPlainBlob(new Blob([plainBytes], { type: attachment.mime || 'application/octet-stream' }));
          }
          if (!attachment.dek) return asBlob(bytes); // public: already plaintext
          c.decryptBytes(bytes, attachment.blobNonce, attachment.dek, function (err, plainBytes) {
            if (err) return thenDo(err);
            asBlob(plainBytes);
          });
        });
      },

      // Revoke and forget every cached object URL — call on world unload.
      revokeAll: function () {
        var self = this;
        Object.keys(this._urlCache || {}).forEach(function (key) {
          URL.revokeObjectURL(self._urlCache[key]);
        });
        this._urlCache = {};
        this._folderDekCache = {};
      },

    },

    'folder', {

      // Random opaque id for a folder member entry (Encryption.md §15.3) —
      // deliberately NOT generateGenesisObjId: a folder member has no
      // standalone envelope of its own to address, this is purely a stable
      // list key for UI/fetch calls into the folder's own decrypted list.
      _randomId: function () {
        var bytes = new Uint8Array(9);
        crypto.getRandomValues(bytes);
        return lively.identity.crypto.base64urlEncode(bytes);
      },

      _cacheFolderDek: function (objId, dek) {
        if (!this._folderDekCache) this._folderDekCache = {};
        this._folderDekCache[objId] = dek;
      },

      // Generic envelope GET — factored out here (rather than reusing
      // fetchAndDecrypt's inline fetch) since every folder operation below
      // needs the raw envelope first, whereas fetchAndDecrypt's fetch is
      // file-specific and already covered by its own test path.
      _getEnvelope: function (handle, objId, thenDo) {
        var base = lively.identity.did.baseUrl();
        fetch(base + '/@' + handle + '/' + objId, { credentials: 'include' })
          .then(function (res) {
            if (!res.ok) throw new Error('Could not fetch envelope (HTTP ' + res.status + ')');
            return res.json();
          })
          .then(function (envelope) { thenDo(null, envelope); })
          .catch(function (e) { thenDo(e); });
      },

      // Re-saves {name, files, albums} as a new envelope version — the
      // shared tail of create/add/remove/rename. prevEnvelope supplies
      // did/wrappedDek/recipients/created unchanged; only
      // record.{cid,prevCid,payload,nonce} and blobCids/state advance.
      // albums is optional (pass [] or omit for plain non-album folders,
      // e.g. FilesBrowser.js's existing callers which never pass it) —
      // consumers that don't know about albums just never see the key.
      // A 'public' prevEnvelope (dek === null, mirrors encryptAndUpload's
      // public path) re-saves the payload as plaintext with no encryption
      // ceremony at all; private/shared re-encrypts under the same dek with
      // a fresh nonce, same as before.
      _saveFolderVersion: function (handle, prevEnvelope, dek, name, files, albums, thenDo) {
        if (typeof albums === 'function') { thenDo = albums; albums = []; }
        var self = this;
        var c = lively.identity.crypto;
        var user = lively.identity.did.currentUser();
        if (!user) return thenDo(new Error('_saveFolderVersion: no identity session active'));
        // updatedAt keeps every public version's cid unique -- without it, a
        // save that reverts the folder to an exact earlier state (rename
        // A->B->A, add then remove a file) reproduces that old version's cid,
        // collides with ObjectRepository's (obj_id, cid) unique index, and is
        // rejected as a cid collision. Never read by the UI; encrypted
        // versions are already unique via their random nonce.
        var payload = { name: name, files: files, albums: albums || [], updatedAt: new Date().toISOString() };
        var isPublic = prevEnvelope.visibility === 'public';

        function withRecord(cb) {
          if (isPublic) {
            c.computeCid(payload, function (err, cid) {
              if (err) return cb(err);
              cb(null, { cid: cid, prevCid: prevEnvelope.record.cid, payload: payload, nonce: null, wrappedDek: null, recipients: [] });
            });
            return;
          }
          c.encryptPayload(payload, dek, function (err, encrypted) {
            if (err) return cb(err);
            c.computeCid(encrypted.ciphertext, function (err, cid) {
              if (err) return cb(err);
              cb(null, {
                cid: cid,
                prevCid: prevEnvelope.record.cid,
                payload: encrypted.ciphertext,
                nonce: encrypted.nonce,
                wrappedDek: prevEnvelope.record.wrappedDek,
                recipients: prevEnvelope.record.recipients || [],
              });
            });
          });
        }

        withRecord(function (err, record) {
          if (err) return thenDo(err);
          var envelope = {
            objId: prevEnvelope.objId,
            did: prevEnvelope.did,
            type: 'folder',
            visibility: isPublic ? 'public' : ((prevEnvelope.record.recipients || []).length ? 'shared' : 'private'),
            created: prevEnvelope.created,
            record: record,
            blobCids: files.map(function (f) { return f.blobCid; }),
            state: { name: name, fileCount: files.length },
          };
          self._signEnvelopeIfPossible(envelope, user, c, function (signErr, signed) {
            if (signErr) return thenDo(signErr);
            self._putEnvelope(handle, signed || envelope, function (err) {
              if (err) return thenDo(err);
              if (!isPublic) self._cacheFolderDek(envelope.objId, dek);
              thenDo(null, { objId: envelope.objId, cid: record.cid, fileCount: files.length });
            });
          });
        });
      },

      // opts: { visibility: 'private'|'shared'|'public' (default 'private',
      // implied 'shared' by a non-empty recipients list, same rule as
      // encryptAndUpload), recipients, onWaiting, albums }. albums is an
      // optional array of { id, name } used by album-aware folders (e.g.
      // Gallery) — plain folder consumers (FilesBrowser.js) just never pass
      // it, and it round-trips as [] for them.
      // A 'public' folder (mirrors encryptAndUpload's public-file path) has
      // no dek/KEK ceremony at all — its payload is stored and read as
      // plaintext, so anyone can fetchFolder() it with no identity session.
      // Calls thenDo(null, { objId, dek }) — dek is null for a public folder.
      createFolder: function (name, opts, thenDo) {
        var self = this;
        var c = lively.identity.crypto;
        var user = lively.identity.did.currentUser();
        if (!user) return thenDo(new Error('createFolder: no identity session active'));
        opts = opts || {};
        var isPublic = opts.visibility === 'public';
        var recipients = opts.recipients || [];
        var albums = opts.albums || [];

        function withEnvelope(dek, dekResult, cb) {
          var payload = { name: name, files: [], albums: albums };

          if (isPublic) {
            c.computeCid(payload, function (err, cid) {
              if (err) return cb(err);
              cb(null, {
                visibility: 'public',
                record: { cid: cid, prevCid: null, payload: payload, nonce: null, wrappedDek: null, recipients: [] },
              });
            });
            return;
          }

          c.encryptPayload(payload, dek, function (err, encrypted) {
            if (err) return cb(err);
            c.computeCid(encrypted.ciphertext, function (err, cid) {
              if (err) return cb(err);

              function withRecipientWraps(cb2) {
                if (!recipients.length) return cb2(null, []);
                var wraps = [];
                var remaining = recipients.length;
                var hadError = false;
                recipients.forEach(function (r) {
                  c.sealForRecipient(dek, r.x25519PublicKey, function (err, sealed) {
                    if (hadError) return;
                    if (err) { hadError = true; return cb2(err); }
                    wraps.push({ did: r.did, sealedDek: sealed });
                    if (--remaining === 0) cb2(null, wraps);
                  });
                });
              }

              withRecipientWraps(function (err, recipientWraps) {
                if (err) return cb(err);
                cb(null, {
                  visibility: recipientWraps.length ? 'shared' : 'private',
                  record: {
                    cid: cid,
                    prevCid: null,
                    payload: encrypted.ciphertext,
                    nonce: encrypted.nonce,
                    wrappedDek: dekResult.wrappedDek,
                    recipients: recipientWraps,
                  },
                });
              });
            });
          });
        }

        function finish(dek, dekResult) {
          withEnvelope(dek, dekResult, function (err, parts) {
            if (err) return thenDo(err);
            lively.identity.webKey.generateGenesisObjId(user.did, function (err, gen) {
              if (err) return thenDo(err);
              var envelope = Object.assign({
                objId: gen.objId,
                did: user.did,
                genesisNonce: gen.genesisNonce,
                type: 'folder',
                created: new Date().toISOString(),
                blobCids: [],
                state: { name: name, fileCount: 0 },
              }, parts);
              self._signEnvelopeIfPossible(envelope, user, c, function (signErr, signed) {
                if (signErr) return thenDo(signErr);
                self._putEnvelope(user.handle, signed || envelope, function (err) {
                  if (err) return thenDo(err);
                  if (dek) self._cacheFolderDek(envelope.objId, dek);
                  thenDo(null, { objId: envelope.objId, dek: dek || null });
                });
              });
            });
          });
        }

        if (isPublic) return finish(null, null);

        self._withKek(user, opts.onWaiting, function (err, kek) {
          if (err) return thenDo(err);
          c.wrapDek(kek, function (err, dekResult) {
            if (err) return thenDo(err);
            finish(dekResult.dek, dekResult);
          });
        });
      },

      // GET + decrypt a folder envelope. Calls thenDo(null, { objId, name,
      // files, albums, dek, isOwner, envelope }). Caches the dek per objId so
      // a session's worth of add/remove/rename/fetch calls only pay the
      // KEK/sealedDek ceremony once.
      // A 'public' folder (mirrors fetchAndDecrypt's _fetchPublic path)
      // needs no identity session at all and skips the CID check entirely —
      // same precedent as _fetchPublic for plain files.
      fetchFolder: function (handle, folderObjId, thenDo) {
        var self = this;
        var c = lively.identity.crypto;
        var wa = lively.identity.webAuthn;
        var user = lively.identity.did.currentUser();

        self._getEnvelope(handle, folderObjId, function (err, envelope) {
          if (err) return thenDo(err);
          if (envelope.type !== 'folder') {
            return thenDo(new Error('fetchFolder: ' + folderObjId + ' is not a folder'));
          }

          if (envelope.visibility === 'public') {
            var publicPayload = envelope.record.payload;
            return thenDo(null, {
              objId: envelope.objId,
              name: publicPayload.name,
              files: publicPayload.files || [],
              albums: publicPayload.albums || [],
              dek: null,
              isOwner: !!(user && user.did === envelope.did),
              envelope: envelope,
            });
          }

          if (!user) return thenDo(new Error('fetchFolder: no identity session'));

          c.computeCid(envelope.record.payload, function (err, expectedCid) {
            if (err) return thenDo(err);
            if (expectedCid !== envelope.record.cid) {
              return thenDo(new Error('fetchFolder: CID mismatch for objId=' + envelope.objId));
            }

            var isOwner = user.did === envelope.did;

            function withDek(cb) {
              var cached = self._folderDekCache && self._folderDekCache[envelope.objId];
              if (cached) return cb(null, cached);
              if (isOwner) {
                self._withKek(user, null, function (err, kek) {
                  if (err) return cb(err);
                  c.unwrapDek(envelope.record.wrappedDek, kek, cb);
                });
                return;
              }
              var myEntry = (envelope.record.recipients || []).find(function (r) { return r.did === user.did; });
              if (!myEntry) return cb(new Error('fetchFolder: no sealed DEK for current user'));
              var ch = new Uint8Array(32);
              crypto.getRandomValues(ch);
              wa.deriveX25519KeyPair({ credentialId: user.credentialId, rpId: user.rpId, challenge: ch }, function (err, pair) {
                if (err) return cb(err);
                c.openSealedBox(myEntry.sealedDek, pair.publicKey, pair.privateKey, cb);
              });
            }

            withDek(function (err, dek) {
              if (err) return thenDo(err);
              self._cacheFolderDek(envelope.objId, dek);
              c.decryptPayload(envelope.record.payload, envelope.record.nonce, dek, function (err, payload) {
                if (err) return thenDo(err);
                thenDo(null, {
                  objId: envelope.objId,
                  name: payload.name,
                  files: payload.files || [],
                  albums: payload.albums || [],
                  dek: dek,
                  isOwner: isOwner,
                  envelope: envelope,
                });
              });
            });
          });
        });
      },

      // Upload a new member file into the folder, then save a new folder
      // version whose file list includes it. opts: { name, caption, albumId }
      // — name overrides file.name (same as encryptAndUpload); caption/
      // albumId are optional free-form extras an album-aware folder (e.g.
      // Gallery) can attach to an entry — plain folder consumers
      // (FilesBrowser.js) never set or read them.
      // A public folder's member files are stored as plaintext blobs (no
      // dek at all, mirrors encryptAndUpload's public path) — a private/
      // shared folder's are chunk-encrypted under the folder's own dek, same
      // as before. Calls thenDo(null, { id, blobCid }).
      addFileToFolder: function (handle, folderObjId, file, opts, thenDo) {
        if (typeof opts === 'function') { thenDo = opts; opts = {}; }
        opts = opts || {};
        var self = this;
        var c = lively.identity.crypto;

        self.fetchFolder(handle, folderObjId, function (err, folder) {
          if (err) return thenDo(err);
          var isPublic = folder.envelope.visibility === 'public';

          function withCipherBlob(cb) {
            if (isPublic) {
              self._readFile(file, function (err, plainBytes) {
                if (err) return cb(err);
                cb(null, { blob: new Blob([plainBytes]), size: plainBytes.length, chunked: false });
              });
              return;
            }
            self._encryptFileChunked(file, folder.dek, function (err, result) {
              if (err) return cb(err);
              cb(null, { blob: result.blob, size: result.size, chunked: true });
            });
          }

          withCipherBlob(function (err, cipher) {
            if (err) return thenDo(err);
            cipher.blob.arrayBuffer().then(function (buf) {
              c.sha256(new Uint8Array(buf), function (err, blobCid) {
                if (err) return thenDo(err);
                self._putBlob(handle, blobCid, cipher.blob, function (err) {
                  if (err) return thenDo(err);
                  var entry = {
                    id: self._randomId(),
                    name: opts.name || file.name || 'file',
                    mime: file.type || 'application/octet-stream',
                    size: cipher.size,
                    blobCid: blobCid,
                    blobNonce: null,
                    chunked: cipher.chunked,
                    addedAt: new Date().toISOString(),
                    caption: opts.caption || '',
                    albumId: opts.albumId || null,
                  };
                  var newFiles = folder.files.concat([entry]);
                  self._saveFolderVersion(handle, folder.envelope, folder.dek, folder.name, newFiles, folder.albums, function (err) {
                    if (err) return thenDo(err);
                    thenDo(null, { id: entry.id, blobCid: blobCid });
                  });
                });
              });
            }).catch(function (e) { thenDo(e); });
          });
        });
      },

      // Adds a lightweight membership pointer (no blob) to the folder's file
      // list — for a folder used as a List (lively.books.Books), where
      // membership of a book is what's being tracked, not an uploaded file.
      // The pointer needs no blob-level encryption of its own: the whole
      // folder payload (the entire `files` array) is already encrypted as
      // one unit under the folder's dek, same as every other field in it.
      // pointer: { refObjId, refType } — refType defaults to 'book'.
      // Calls thenDo(null, { id }).
      addPointerToFolder: function (handle, folderObjId, pointer, thenDo) {
        var self = this;
        self.fetchFolder(handle, folderObjId, function (err, folder) {
          if (err) return thenDo(err);
          var entry = {
            id: self._randomId(),
            type: 'pointer',
            refType: pointer.refType || 'book',
            refObjId: pointer.refObjId,
            addedAt: new Date().toISOString(),
          };
          var newFiles = folder.files.concat([entry]);
          self._saveFolderVersion(handle, folder.envelope, folder.dek, folder.name, newFiles, folder.albums, function (err) {
            if (err) return thenDo(err);
            thenDo(null, { id: entry.id });
          });
        });
      },

      // Batch sibling of addPointerToFolder for self-contained inline
      // entries (e.g. a playlist's track snapshots): appends all of
      // `entries` in ONE _saveFolderVersion call, so importing N tracks is
      // one write, not N. Each entry gets a fresh `id` (and `addedAt`)
      // unless it already carries one; no blobCid, so setFolderVisibility
      // passes them through untouched. Calls thenDo(null, { ids }).
      addEntriesToFolder: function (handle, folderObjId, entries, thenDo) {
        var self = this;
        if (!entries || !entries.length) return thenDo(null, { ids: [] });
        self.fetchFolder(handle, folderObjId, function (err, folder) {
          if (err) return thenDo(err);
          var now = new Date().toISOString();
          var added = entries.map(function (e) {
            return Object.assign({}, e, {
              id: e.id || self._randomId(),
              addedAt: e.addedAt || now,
            });
          });
          var newFiles = folder.files.concat(added);
          self._saveFolderVersion(handle, folder.envelope, folder.dek, folder.name, newFiles, folder.albums, function (err) {
            if (err) return thenDo(err);
            thenDo(null, { ids: added.map(function (e) { return e.id; }) });
          });
        });
      },

      // Drops one member entry from the folder's file list. Does NOT delete
      // the now-unreferenced blob from BlobStore — storage reclamation isn't
      // built anywhere else in this codebase either, left as a separate,
      // not-yet-built concern (Encryption.md §15.5).
      removeFileFromFolder: function (handle, folderObjId, fileId, thenDo) {
        var self = this;
        self.fetchFolder(handle, folderObjId, function (err, folder) {
          if (err) return thenDo(err);
          var newFiles = folder.files.filter(function (f) { return f.id !== fileId; });
          self._saveFolderVersion(handle, folder.envelope, folder.dek, folder.name, newFiles, folder.albums, thenDo);
        });
      },

      // Patches an existing member entry's free-form metadata (caption,
      // albumId) without touching its blob. patch: { caption, albumId } —
      // only keys present in patch are applied.
      // Calls thenDo(null, { id }).
      updateFolderFileMeta: function (handle, folderObjId, fileId, patch, thenDo) {
        var self = this;
        self.fetchFolder(handle, folderObjId, function (err, folder) {
          if (err) return thenDo(err);
          var found = false;
          var newFiles = folder.files.map(function (f) {
            if (f.id !== fileId) return f;
            found = true;
            var updated = Object.assign({}, f);
            if ('caption' in patch) updated.caption = patch.caption;
            if ('albumId' in patch) updated.albumId = patch.albumId;
            return updated;
          });
          if (!found) return thenDo(new Error('updateFolderFileMeta: no such file ' + fileId));
          self._saveFolderVersion(handle, folder.envelope, folder.dek, folder.name, newFiles, folder.albums, function (err) {
            if (err) return thenDo(err);
            thenDo(null, { id: fileId });
          });
        });
      },

      // Reorders the folder's file list to match orderedFileIds. Any id not
      // present in orderedFileIds is dropped from the result (callers should
      // always pass every current file's id); any current file id missing
      // from orderedFileIds would otherwise silently vanish, so this is
      // intentionally strict rather than tolerant. Calls thenDo(null, {}).
      reorderFolderFiles: function (handle, folderObjId, orderedFileIds, thenDo) {
        var self = this;
        self.fetchFolder(handle, folderObjId, function (err, folder) {
          if (err) return thenDo(err);
          var byId = {};
          folder.files.forEach(function (f) { byId[f.id] = f; });
          var newFiles = orderedFileIds.map(function (id) { return byId[id]; }).filter(Boolean);
          self._saveFolderVersion(handle, folder.envelope, folder.dek, folder.name, newFiles, folder.albums, function (err) {
            if (err) return thenDo(err);
            thenDo(null, {});
          });
        });
      },

      // Replaces the folder's albums list wholesale (add/rename/remove all
      // go through the caller building the new full array and passing it
      // here) — same shape as opts.albums in createFolder: [{ id, name }].
      // Calls thenDo(null, {}).
      setFolderAlbums: function (handle, folderObjId, albums, thenDo) {
        var self = this;
        self.fetchFolder(handle, folderObjId, function (err, folder) {
          if (err) return thenDo(err);
          self._saveFolderVersion(handle, folder.envelope, folder.dek, folder.name, folder.files, albums || [], function (err) {
            if (err) return thenDo(err);
            thenDo(null, {});
          });
        });
      },

      // Switches a folder between 'public'/'private'/'shared'. This is NOT a
      // metadata-only flip — a public member blob is plaintext and a
      // private/shared one is dek-encrypted, two incompatible wire formats —
      // so every member's blob is decrypted under the OLD scheme and
      // re-uploaded under the NEW one (sequentially; a gallery-wide privacy
      // flip is already a rare, slow, passkey-gated operation, no need to
      // race N concurrent crypto ceremonies for it). Old blobs are left
      // orphaned, same accepted non-goal as removeFileFromFolder (no storage
      // reclamation exists anywhere in this codebase yet).
      // opts: { recipients, onWaiting } — same shape as createFolder, used
      // only when newVisibility isn't 'public'.
      // Calls thenDo(null, { objId, dek }) — dek is null for 'public'.
      setFolderVisibility: function (handle, folderObjId, newVisibility, opts, thenDo) {
        if (typeof opts === 'function') { thenDo = opts; opts = {}; }
        opts = opts || {};
        var self = this;
        var c = lively.identity.crypto;
        var user = lively.identity.did.currentUser();
        if (!user) return thenDo(new Error('setFolderVisibility: no identity session active'));

        self.fetchFolder(handle, folderObjId, function (err, folder) {
          if (err) return thenDo(err);
          if (!folder.isOwner) return thenDo(new Error('setFolderVisibility: only the owner can change visibility'));
          if (folder.envelope.visibility === newVisibility) return thenDo(null, { objId: folderObjId, dek: folder.dek });

          var isNewPublic = newVisibility === 'public';
          var recipients = opts.recipients || [];

          function withNewDek(cb) {
            if (isNewPublic) return cb(null, null, null);
            self._withKek(user, opts.onWaiting, function (err, kek) {
              if (err) return cb(err);
              c.wrapDek(kek, function (err, dekResult) { cb(err, dekResult && dekResult.dek, dekResult); });
            });
          }

          withNewDek(function (err, newDek, dekResult) {
            if (err) return thenDo(err);

            var newFiles = [];
            function nextFile(i) {
              if (i >= folder.files.length) return afterFiles();
              var entry = folder.files[i];
              // A pointer entry (see addPointerToFolder — used by Lists,
              // lively.books.Books) has no blob of its own to re-encrypt: its
              // membership data is already protected by the whole-payload
              // encryption this function is already re-doing below. Fetching
              // it as if it had a blobCid would throw (there's nothing at
              // that cid), so carry it through unchanged instead.
              if (!entry.blobCid) { newFiles.push(entry); return nextFile(i + 1); }
              self._fetchFolderFileBytes(handle, folderObjId, entry, function (err, result) {
                if (err) return thenDo(err);
                var plainBlob = new Blob([result.bytes], { type: result.mime || 'application/octet-stream' });

                function withCipherBlob(cb) {
                  if (isNewPublic) return cb(null, { blob: plainBlob, size: result.bytes.length, chunked: false });
                  self._encryptFileChunked(plainBlob, newDek, function (err, cipher) {
                    if (err) return cb(err);
                    cb(null, { blob: cipher.blob, size: cipher.size, chunked: true });
                  });
                }

                withCipherBlob(function (err, cipher) {
                  if (err) return thenDo(err);
                  cipher.blob.arrayBuffer().then(function (buf) {
                    c.sha256(new Uint8Array(buf), function (err, blobCid) {
                      if (err) return thenDo(err);
                      self._putBlob(handle, blobCid, cipher.blob, function (err) {
                        if (err) return thenDo(err);
                        newFiles.push(Object.assign({}, entry, { blobCid: blobCid, blobNonce: null, chunked: cipher.chunked }));
                        nextFile(i + 1);
                      });
                    });
                  }).catch(function (e) { thenDo(e); });
                });
              });
            }

            function afterFiles() {
              function withRecipientWraps(cb) {
                if (isNewPublic || !recipients.length) return cb(null, []);
                var wraps = [];
                var remaining = recipients.length;
                var hadError = false;
                recipients.forEach(function (r) {
                  c.sealForRecipient(newDek, r.x25519PublicKey, function (err, sealed) {
                    if (hadError) return;
                    if (err) { hadError = true; return cb(err); }
                    wraps.push({ did: r.did, sealedDek: sealed });
                    if (--remaining === 0) cb(null, wraps);
                  });
                });
              }

              withRecipientWraps(function (err, recipientWraps) {
                if (err) return thenDo(err);
                // updatedAt: see _saveFolderVersion -- public->private->public
                // with no other change otherwise reproduces the first
                // public version's exact payload/cid.
                var payload = { name: folder.name, files: newFiles, albums: folder.albums, updatedAt: new Date().toISOString() };

                function withRecord(cb) {
                  if (isNewPublic) {
                    c.computeCid(payload, function (err, cid) {
                      if (err) return cb(err);
                      cb(null, { cid: cid, prevCid: folder.envelope.record.cid, payload: payload, nonce: null, wrappedDek: null, recipients: [] });
                    });
                    return;
                  }
                  c.encryptPayload(payload, newDek, function (err, encrypted) {
                    if (err) return cb(err);
                    c.computeCid(encrypted.ciphertext, function (err, cid) {
                      if (err) return cb(err);
                      cb(null, {
                        cid: cid, prevCid: folder.envelope.record.cid, payload: encrypted.ciphertext,
                        nonce: encrypted.nonce, wrappedDek: dekResult.wrappedDek, recipients: recipientWraps,
                      });
                    });
                  });
                }

                withRecord(function (err, record) {
                  if (err) return thenDo(err);
                  var envelope = {
                    objId: folder.envelope.objId,
                    did: folder.envelope.did,
                    type: 'folder',
                    visibility: isNewPublic ? 'public' : (recipientWraps.length ? 'shared' : 'private'),
                    created: folder.envelope.created,
                    record: record,
                    blobCids: newFiles.map(function (f) { return f.blobCid; }),
                    state: { name: folder.name, fileCount: newFiles.length },
                  };
                  self._signEnvelopeIfPossible(envelope, user, c, function (signErr, signed) {
                    if (signErr) return thenDo(signErr);
                    self._putEnvelope(handle, signed || envelope, function (err) {
                      if (err) return thenDo(err);
                      if (newDek) self._cacheFolderDek(envelope.objId, newDek);
                      thenDo(null, { objId: envelope.objId, dek: newDek });
                    });
                  });
                });
              });
            }

            nextFile(0);
          });
        });
      },

      renameFolder: function (handle, folderObjId, newName, thenDo) {
        var self = this;
        self.fetchFolder(handle, folderObjId, function (err, folder) {
          if (err) return thenDo(err);
          self._saveFolderVersion(handle, folder.envelope, folder.dek, newName, folder.files, folder.albums, thenDo);
        });
      },

      // Owner-only: seal the folder's existing (unchanged) dek for each new
      // recipient and PUT the envelope. Payload ciphertext is untouched, so
      // this lands on ObjectRepository's same-cid metadata-update path —
      // no file bytes are re-encrypted (Encryption.md §15.2).
      // recipients: [{ did, x25519PublicKey }]. Calls thenDo(null, { objId, added }).
      shareFolder: function (handle, folderObjId, recipients, thenDo) {
        var self = this;
        var c = lively.identity.crypto;
        self.fetchFolder(handle, folderObjId, function (err, folder) {
          if (err) return thenDo(err);
          if (!folder.isOwner) return thenDo(new Error('shareFolder: only the owner can share a folder'));

          var existingDids = (folder.envelope.record.recipients || []).map(function (r) { return r.did; });
          var toAdd = (recipients || []).filter(function (r) { return existingDids.indexOf(r.did) === -1; });
          if (!toAdd.length) return thenDo(null, { objId: folderObjId, added: 0 });

          var wraps = [];
          var remaining = toAdd.length;
          var hadError = false;
          toAdd.forEach(function (r) {
            c.sealForRecipient(folder.dek, r.x25519PublicKey, function (err, sealed) {
              if (hadError) return;
              if (err) { hadError = true; return thenDo(err); }
              wraps.push({ did: r.did, sealedDek: sealed });
              if (--remaining === 0) {
                var envelope = Object.assign({}, folder.envelope);
                envelope.record = Object.assign({}, folder.envelope.record, {
                  recipients: (folder.envelope.record.recipients || []).concat(wraps),
                });
                envelope.visibility = 'shared';
                self._putEnvelope(handle, envelope, function (err) {
                  if (err) return thenDo(err);
                  thenDo(null, { objId: folderObjId, added: wraps.length });
                });
              }
            });
          });
        });
      },

      // Owner-only: drop one recipient's sealedDek entry. See Encryption.md
      // §15.2 before presenting this as an unconditional "they can no longer
      // read anything" in any UI copy that calls this — it stops them from
      // being resealed into any FUTURE save, it does not retroactively
      // invalidate a dek they already obtained.
      revokeFolderRecipient: function (handle, folderObjId, did, thenDo) {
        var self = this;
        self.fetchFolder(handle, folderObjId, function (err, folder) {
          if (err) return thenDo(err);
          if (!folder.isOwner) return thenDo(new Error('revokeFolderRecipient: only the owner can revoke access'));
          var remainingRecipients = (folder.envelope.record.recipients || []).filter(function (r) { return r.did !== did; });
          var envelope = Object.assign({}, folder.envelope);
          envelope.record = Object.assign({}, folder.envelope.record, { recipients: remainingRecipients });
          envelope.visibility = remainingRecipients.length ? 'shared' : 'private';
          self._putEnvelope(handle, envelope, function (err) {
            if (err) return thenDo(err);
            thenDo(null, { objId: folderObjId, remaining: remainingRecipients.length });
          });
        });
      },

      // Decrypt a folder member's bytes back to plaintext, without wrapping
      // them in an object URL — the shared decrypt path behind both
      // folderFileUrl (below) and the flat-file<->folder move helpers.
      // Calls thenDo(null, { bytes: Uint8Array, mime, name, size }).
      _fetchFolderFileBytes: function (handle, folderObjId, fileEntry, thenDo) {
        var self = this;
        var c = lively.identity.crypto;

        self.fetchFolder(handle, folderObjId, function (err, folder) {
          if (err) return thenDo(err);

          if (folder.envelope.visibility === 'public') {
            self._fetchBlobBytes(handle, fileEntry.blobCid, function (err, plainBytes) {
              if (err) return thenDo(err);
              thenDo(null, { bytes: plainBytes, mime: fileEntry.mime, name: fileEntry.name, size: fileEntry.size });
            });
            return;
          }

          if (fileEntry.chunked) {
            self._fetchBlobResponse(handle, fileEntry.blobCid, function (err, response) {
              if (err) return thenDo(err);
              self._decryptBlobChunked(response, folder.dek, function (err, plainBlob) {
                if (err) return thenDo(err);
                plainBlob.arrayBuffer().then(function (buf) {
                  thenDo(null, { bytes: new Uint8Array(buf), mime: fileEntry.mime, name: fileEntry.name, size: fileEntry.size });
                }).catch(function (e) { thenDo(e); });
              });
            });
            return;
          }

          self._fetchBlobBytes(handle, fileEntry.blobCid, function (err, cipherBytes) {
            if (err) return thenDo(err);
            c.decryptBytes(cipherBytes, fileEntry.blobNonce, folder.dek, function (err, plainBytes) {
              if (err) return thenDo(err);
              thenDo(null, { bytes: plainBytes, mime: fileEntry.mime, name: fileEntry.name, size: fileEntry.size });
            });
          });
        });
      },

      // fetchFolder (dek cache hit after the first call) -> blob fetch ->
      // decrypt -> object URL, cached per blobCid same as objectUrlFor.
      // fileEntry: one entry from fetchFolder's `files` array.
      folderFileUrl: function (handle, folderObjId, fileEntry, thenDo) {
        if (!this._urlCache) this._urlCache = {};
        var cacheKey = 'folder-file:' + fileEntry.blobCid;
        if (this._urlCache[cacheKey]) return thenDo(null, this._urlCache[cacheKey]);

        var self = this;
        self._fetchFolderFileBytes(handle, folderObjId, fileEntry, function (err, result) {
          if (err) return thenDo(err);
          var blob = new Blob([result.bytes], { type: result.mime || 'application/octet-stream' });
          var url = URL.createObjectURL(blob);
          self._urlCache[cacheKey] = url;
          thenDo(null, url);
        });
      },

      // Moves an existing flat file into a folder. There is no "attach
      // existing blob" shortcut here — a flat file's blob is encrypted under
      // its own standalone dek, a folder member's under the folder's fixed
      // dek, and those never coincide — so this is a genuine decrypt +
      // re-encrypt + reupload, then the original (now orphaned) blob is
      // deleted to reclaim storage. fileEnvelope needs only .objId (to fetch
      // and decrypt) and .blobCid (to delete afterward) — a caller chaining
      // this after moveFileOutOfFolder can pass a minimal {objId, blobCid}
      // rather than a full envelope. The original envelope itself can't be
      // removed (append-only store, same limitation as _deleteFile) so it
      // keeps listing with a now-gone blob, same as any other file delete.
      // opts: { name } — override for the member's name, same as
      // addFileToFolder. Calls thenDo(null, { id, folderObjId }).
      moveFileIntoFolder: function (handle, fileEnvelope, folderObjId, opts, thenDo) {
        if (typeof opts === 'function') { thenDo = opts; opts = {}; }
        opts = opts || {};
        var self = this;
        self.fetchAndDecrypt(handle, fileEnvelope.objId, function (err, result) {
          if (err) return thenDo(err);
          var blob = new Blob([result.bytes], { type: result.mime || 'application/octet-stream' });
          self.addFileToFolder(handle, folderObjId, blob, { name: opts.name || result.name }, function (err, added) {
            if (err) return thenDo(err);
            self._deleteBlob(handle, fileEnvelope.blobCid, function (deleteErr) {
              if (deleteErr) console.warn('[FileCrypto] moveFileIntoFolder: could not delete original blob (non-fatal):', deleteErr.message);
              thenDo(null, { id: added.id, folderObjId: folderObjId });
            });
          });
        });
      },

      // Reverse of moveFileIntoFolder: decrypt a folder member's bytes and
      // re-upload them as a brand-new standalone file envelope under a FRESH
      // dek — never reuse the folder's own dek for a file living outside the
      // folder, that would leak the container's shared secret past its own
      // scope — then drop the member entry from the folder (the now-
      // unreferenced blob is left in place, same accepted non-goal
      // removeFileFromFolder's own comment already documents).
      // fileEntry: one entry from fetchFolder's `files` array. opts:
      // { visibility, name, onWaiting } — visibility defaults to 'private'
      // (a folder member has no visibility of its own to inherit; it can
      // never have been public in the first place).
      // Calls thenDo(null, { objId, blobCid }).
      moveFileOutOfFolder: function (handle, folderObjId, fileEntry, opts, thenDo) {
        if (typeof opts === 'function') { thenDo = opts; opts = {}; }
        opts = opts || {};
        var self = this;
        self._fetchFolderFileBytes(handle, folderObjId, fileEntry, function (err, result) {
          if (err) return thenDo(err);
          var blob = new Blob([result.bytes], { type: result.mime || 'application/octet-stream' });
          self.encryptAndUpload(blob, {
            visibility: opts.visibility || 'private',
            name: opts.name || result.name,
            onWaiting: opts.onWaiting,
          }, function (err, uploaded) {
            if (err) return thenDo(err);
            self.removeFileFromFolder(handle, folderObjId, fileEntry.id, function (removeErr) {
              if (removeErr) console.warn('[FileCrypto] moveFileOutOfFolder: could not remove folder member (non-fatal):', removeErr.message);
              thenDo(null, { objId: uploaded.objId, blobCid: uploaded.blobCid });
            });
          });
        });
      },

      // Decrypt a private/shared file envelope's small metadata payload only
      // (no blob fetch) — for on-demand size display (FilesBrowser's "sort
      // by size", which deliberately avoids doing this for every file on
      // every open). A public file's metadata is already plaintext.
      // Calls thenDo(null, { name, mime, size, blobCid, blobNonce, chunked }).
      decryptFileEnvelopeMetadata: function (envelope, thenDo) {
        var self = this;
        var c = lively.identity.crypto;
        var wa = lively.identity.webAuthn;
        var user = lively.identity.did.currentUser();
        if (!user) return thenDo(new Error('decryptFileEnvelopeMetadata: no identity session'));
        if (envelope.visibility === 'public') return thenDo(null, envelope.record.payload);

        c.computeCid(envelope.record.payload, function (err, expectedCid) {
          if (err) return thenDo(err);
          if (expectedCid !== envelope.record.cid) {
            return thenDo(new Error('decryptFileEnvelopeMetadata: CID mismatch for objId=' + envelope.objId));
          }

          function withDek(cb) {
            var isOwner = user.did === envelope.did;
            if (isOwner) {
              self._withKek(user, null, function (err, kek) {
                if (err) return cb(err);
                c.unwrapDek(envelope.record.wrappedDek, kek, cb);
              });
              return;
            }
            var myEntry = (envelope.record.recipients || []).find(function (r) { return r.did === user.did; });
            if (!myEntry) return cb(new Error('decryptFileEnvelopeMetadata: no sealed DEK for current user'));
            var ch = new Uint8Array(32);
            crypto.getRandomValues(ch);
            wa.deriveX25519KeyPair({ credentialId: user.credentialId, rpId: user.rpId, challenge: ch }, function (err, pair) {
              if (err) return cb(err);
              c.openSealedBox(myEntry.sealedDek, pair.publicKey, pair.privateKey, cb);
            });
          }

          withDek(function (err, dek) {
            if (err) return thenDo(err);
            c.decryptPayload(envelope.record.payload, envelope.record.nonce, dek, thenDo);
          });
        });
      },

    },

    // ─── book (books-template.md) ────────────────────────────────────────
    // A Book is a small, always-PUBLIC (plaintext) envelope -- one per
    // shelved book, type:'book', addressable by its own objId so a List (a
    // folder, via addPointerToFolder/addFileToFolder's pointer convention
    // above) can reference it via refObjId. Unlike a folder/file, a book
    // never goes through a KEK/dek ceremony at all: title/author/shelf/
    // rating/cover are meant to be visible on the owner's public shelf the
    // same way a public Inventory listing is, and prompting a passkey touch
    // on every single "add a book"/"rate a book" action would be bad UX for
    // what's meant to be a lightweight, frequent-interaction tracker.
    //
    // The per-book `isPublic` field inside the payload (and the
    // cascade-from-Lists computation ported into lively.books.Books from
    // the approved mockup) is a plain-data DISPLAY preference gating only
    // whether the Reviews & Notes section (a separate mechanism -- see
    // below) is shown to a non-owner viewer. It is not real end-to-end
    // encryption -- the same non-cryptographic-privacy precedent already
    // established by Inventory's own 'public' item listings elsewhere in
    // this codebase. A determined visitor reading the raw envelope JSON
    // could still see isPublic:false; this only hides it in the normal UI.
    // See books-template.md for the full reasoning.
    //
    // Reviews/notes themselves are NOT stored in this envelope at all --
    // they reuse the existing generic `/@:handle/:objId/comments` REST
    // routes (IdentityServer.js, originally built for Inventory items) via
    // plain fetch calls in Books.js, keyed by the book's own objId. That
    // route already works for any objId whose envelope passes
    // _canReadEnvelope (true for every book, since books are always
    // public), lets ANY signed-in viewer post a review (not just the
    // owner -- matching the mockup's seed data showing other people's
    // comments on a book), and needed zero server changes to reuse.
    //
    // Every payload below carries `updatedAt` (bumped on every save, never
    // read by the UI). This is NOT cosmetic -- confirmed live 2026-10-05:
    // ObjectRepository.js's put() de-dupes by (objId, cid), where cid is a
    // canonical hash of the payload alone. Toggling `isPublic` off then
    // back ON, with no other field changed in between, reproduces the
    // EXACT payload (and therefore cid) of an earlier version in the same
    // object's history -- the second PUT's prevCid chain-check correctly
    // passes, but the INSERT then collides with that old row's (objId,
    // cid) uniqueness constraint, and put() treats it as a no-op duplicate
    // ({duplicate:true, changed:'none'}) rather than moving the tip --
    // even though the client-sent payload was genuinely isPublic:true
    // again. The toggle's own PUT reports {ok:true}, so this fails
    // completely silently; only a fresh fetchBook (or a different browser
    // profile) reveals the stale value survived. `updatedAt` guarantees
    // every save's canonical payload is unique, so this collision can
    // never occur. (Folders -- Lists/Gallery -- share this same
    // content-addressed-store property and could in principle hit the
    // identical bug on a value that cycles back to an exact prior state;
    // not fixed here since it's shared infra outside Books' scope and
    // hasn't been reproduced for folders specifically -- flagged for a
    // separate pass.)
    'book', {

      // data: { title, author, shelf, rating, description, coverUrl,
      //         coverSource, isbn, isPublic }. Calls thenDo(null, { objId }).
      createBook: function (data, thenDo) {
        var self = this;
        var c = lively.identity.crypto;
        var user = lively.identity.did.currentUser();
        if (!user) return thenDo(new Error('createBook: no identity session active'));

        var payload = Object.assign({
          title: '', author: '', shelf: 'want', rating: 0, description: '',
          coverUrl: null, coverSource: null, isbn: null, isPublic: true,
        }, data, { updatedAt: new Date().toISOString() });

        c.computeCid(payload, function (err, cid) {
          if (err) return thenDo(err);
          lively.identity.webKey.generateGenesisObjId(user.did, function (err, gen) {
            if (err) return thenDo(err);
            var envelope = {
              objId: gen.objId, did: user.did, genesisNonce: gen.genesisNonce,
              type: 'book', visibility: 'public', created: new Date().toISOString(),
              record: { cid: cid, prevCid: null, payload: payload, nonce: null, wrappedDek: null, recipients: [] },
              blobCids: [], state: { title: payload.title },
            };
            self._signEnvelopeIfPossible(envelope, user, c, function (signErr, signed) {
              if (signErr) return thenDo(signErr);
              self._putEnvelope(user.handle, signed || envelope, function (err) {
                if (err) return thenDo(err);
                thenDo(null, { objId: envelope.objId });
              });
            });
          });
        });
      },

      // Calls thenDo(null, { objId, book: <payload>, isOwner, envelope }).
      fetchBook: function (handle, bookObjId, thenDo) {
        var user = lively.identity.did.currentUser();
        this._getEnvelope(handle, bookObjId, function (err, envelope) {
          if (err) return thenDo(err);
          if (envelope.type !== 'book') return thenDo(new Error('fetchBook: ' + bookObjId + ' is not a book'));
          thenDo(null, {
            objId: envelope.objId,
            book: envelope.record.payload,
            isOwner: !!(user && user.did === envelope.did),
            envelope: envelope,
          });
        });
      },

      // Shallow-merges patch into the book's payload and re-saves a new
      // envelope version (owner-only -- the server's mandatory signature
      // check would 403 a non-owner's PUT anyway, this is just a clearer
      // client-side error). Calls thenDo(null, { objId }).
      updateBook: function (handle, bookObjId, patch, thenDo) {
        var self = this;
        var c = lively.identity.crypto;
        var user = lively.identity.did.currentUser();
        if (!user) return thenDo(new Error('updateBook: no identity session active'));

        self.fetchBook(handle, bookObjId, function (err, result) {
          if (err) return thenDo(err);
          if (!result.isOwner) return thenDo(new Error('updateBook: only the owner can edit a book'));
          var payload = Object.assign({}, result.book, patch, { updatedAt: new Date().toISOString() });
          c.computeCid(payload, function (err, cid) {
            if (err) return thenDo(err);
            var envelope = {
              objId: result.envelope.objId, did: result.envelope.did, type: 'book',
              visibility: 'public', created: result.envelope.created,
              record: { cid: cid, prevCid: result.envelope.record.cid, payload: payload, nonce: null, wrappedDek: null, recipients: [] },
              blobCids: [], state: { title: payload.title },
            };
            self._signEnvelopeIfPossible(envelope, user, c, function (signErr, signed) {
              if (signErr) return thenDo(signErr);
              self._putEnvelope(handle, signed || envelope, function (err) {
                if (err) return thenDo(err);
                thenDo(null, { objId: envelope.objId });
              });
            });
          });
        });
      },

      // Soft-delete only (state.deleted:true) -- there's no hard-delete in
      // this append-only store, same limitation as every other object type
      // here. The caller (Books.js's _deleteBook) is responsible for also
      // removing the Library/List pointer entries referencing this objId.
      // Calls thenDo(null, { objId }).
      deleteBook: function (handle, bookObjId, thenDo) {
        var self = this;
        var c = lively.identity.crypto;
        var user = lively.identity.did.currentUser();
        if (!user) return thenDo(new Error('deleteBook: no identity session active'));
        self.fetchBook(handle, bookObjId, function (err, result) {
          if (err) return thenDo(err);
          if (!result.isOwner) return thenDo(new Error('deleteBook: only the owner can delete a book'));
          var payload = result.book;
          c.computeCid(payload, function (err, cid) {
            if (err) return thenDo(err);
            var envelope = {
              objId: result.envelope.objId, did: result.envelope.did, type: 'book',
              visibility: 'public', created: result.envelope.created,
              record: { cid: cid, prevCid: result.envelope.record.cid, payload: payload, nonce: null, wrappedDek: null, recipients: [] },
              blobCids: [], state: { title: payload.title, deleted: true },
            };
            self._signEnvelopeIfPossible(envelope, user, c, function (signErr, signed) {
              if (signErr) return thenDo(signErr);
              self._putEnvelope(handle, signed || envelope, function (err) {
                if (err) return thenDo(err);
                thenDo(null, { objId: envelope.objId });
              });
            });
          });
        });
      },

    },

    // ─── album (Music template) ──────────────────────────────────────────
    // Same shape and reasoning as the 'book' category above: a small,
    // always-PUBLIC envelope per shelved album, no KEK/dek ceremony, with
    // the title/artist/year/cover/tracklist snapshotted at add-time. The
    // per-album `isPublic` field only gates the Reviews & Notes section in
    // the UI (display privacy, not encryption). Reviews reuse the generic
    // `/@:handle/:objId/comments` routes keyed by the album's objId.
    // `updatedAt` is bumped on EVERY save (including delete) so a value
    // that cycles back to an earlier state can't reproduce an old cid --
    // see the cid-collision note on the 'book' category.
    'album', {

      // data: { title, artist, year, coverUrl, coverSource, ids, tracks,
      //         shelf, rating, isPublic }. Calls thenDo(null, { objId }).
      createAlbum: function (data, thenDo) {
        var self = this;
        var c = lively.identity.crypto;
        var user = lively.identity.did.currentUser();
        if (!user) return thenDo(new Error('createAlbum: no identity session active'));

        var payload = Object.assign({
          title: '', artist: '', year: null, coverUrl: null, coverSource: null,
          ids: {}, tracks: [], shelf: 'want', rating: 0, isPublic: true,
        }, data, { updatedAt: new Date().toISOString() });

        c.computeCid(payload, function (err, cid) {
          if (err) return thenDo(err);
          lively.identity.webKey.generateGenesisObjId(user.did, function (err, gen) {
            if (err) return thenDo(err);
            var envelope = {
              objId: gen.objId, did: user.did, genesisNonce: gen.genesisNonce,
              type: 'album', visibility: 'public', created: new Date().toISOString(),
              record: { cid: cid, prevCid: null, payload: payload, nonce: null, wrappedDek: null, recipients: [] },
              blobCids: [], state: { title: payload.title },
            };
            self._signEnvelopeIfPossible(envelope, user, c, function (signErr, signed) {
              if (signErr) return thenDo(signErr);
              self._putEnvelope(user.handle, signed || envelope, function (err) {
                if (err) return thenDo(err);
                thenDo(null, { objId: envelope.objId });
              });
            });
          });
        });
      },

      // Calls thenDo(null, { objId, album: <payload>, isOwner, envelope }).
      fetchAlbum: function (handle, albumObjId, thenDo) {
        var user = lively.identity.did.currentUser();
        this._getEnvelope(handle, albumObjId, function (err, envelope) {
          if (err) return thenDo(err);
          if (envelope.type !== 'album') return thenDo(new Error('fetchAlbum: ' + albumObjId + ' is not an album'));
          thenDo(null, {
            objId: envelope.objId,
            album: envelope.record.payload,
            isOwner: !!(user && user.did === envelope.did),
            envelope: envelope,
          });
        });
      },

      // Shallow-merges patch into the album's payload and re-saves a new
      // envelope version (owner-only). Calls thenDo(null, { objId }).
      updateAlbum: function (handle, albumObjId, patch, thenDo) {
        var self = this;
        var c = lively.identity.crypto;
        var user = lively.identity.did.currentUser();
        if (!user) return thenDo(new Error('updateAlbum: no identity session active'));

        self.fetchAlbum(handle, albumObjId, function (err, result) {
          if (err) return thenDo(err);
          if (!result.isOwner) return thenDo(new Error('updateAlbum: only the owner can edit an album'));
          var payload = Object.assign({}, result.album, patch, { updatedAt: new Date().toISOString() });
          c.computeCid(payload, function (err, cid) {
            if (err) return thenDo(err);
            var envelope = {
              objId: result.envelope.objId, did: result.envelope.did, type: 'album',
              visibility: 'public', created: result.envelope.created,
              record: { cid: cid, prevCid: result.envelope.record.cid, payload: payload, nonce: null, wrappedDek: null, recipients: [] },
              blobCids: [], state: { title: payload.title },
            };
            self._signEnvelopeIfPossible(envelope, user, c, function (signErr, signed) {
              if (signErr) return thenDo(signErr);
              self._putEnvelope(handle, signed || envelope, function (err) {
                if (err) return thenDo(err);
                thenDo(null, { objId: envelope.objId });
              });
            });
          });
        });
      },

      // Soft-delete only (state.deleted:true). The caller (Music.js) is
      // responsible for also removing the library pointer entry. Calls
      // thenDo(null, { objId }).
      deleteAlbum: function (handle, albumObjId, thenDo) {
        var self = this;
        var c = lively.identity.crypto;
        var user = lively.identity.did.currentUser();
        if (!user) return thenDo(new Error('deleteAlbum: no identity session active'));
        self.fetchAlbum(handle, albumObjId, function (err, result) {
          if (err) return thenDo(err);
          if (!result.isOwner) return thenDo(new Error('deleteAlbum: only the owner can delete an album'));
          var payload = Object.assign({}, result.album, { updatedAt: new Date().toISOString() });
          c.computeCid(payload, function (err, cid) {
            if (err) return thenDo(err);
            var envelope = {
              objId: result.envelope.objId, did: result.envelope.did, type: 'album',
              visibility: 'public', created: result.envelope.created,
              record: { cid: cid, prevCid: result.envelope.record.cid, payload: payload, nonce: null, wrappedDek: null, recipients: [] },
              blobCids: [], state: { title: payload.title, deleted: true },
            };
            self._signEnvelopeIfPossible(envelope, user, c, function (signErr, signed) {
              if (signErr) return thenDo(signErr);
              self._putEnvelope(handle, signed || envelope, function (err) {
                if (err) return thenDo(err);
                thenDo(null, { objId: envelope.objId });
              });
            });
          });
        });
      },

    });

    // Singleton: lively.identity.fileCrypto.encryptAndUpload(...), etc.
    lively.identity.fileCrypto = new lively.identity.FileCrypto();

  }); // end module('lively.identity.FileCrypto')
