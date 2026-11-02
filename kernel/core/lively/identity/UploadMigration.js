/**
 * lively.identity.UploadMigration
 *
 * One-time (per account, self-terminating once the legacy tree is empty)
 * client-driven migration of the legacy plaintext identity/uploads/<handle>/
 * tree onto the newer encrypted, content-addressed file-envelope + blob
 * system (FileCrypto.js / BlobStore.js / S3BlobStore.js). This is
 * Encryption.md §11 / "Phase 5 — Legacy upload migration", never built
 * until now — see DeployCheckList.md's "identity/uploads/ migration
 * scoping" section for the full investigation this implements.
 *
 * Has to run client-side: the server cannot produce DEKs for private
 * files, so encryption happens in the signed-in browser, not a server
 * script (same reasoning Encryption.md §11 already gives).
 *
 * Visibility — revised twice now, both times after a real live-testing
 * failure, not by reasoning alone:
 *
 * Round 1: defaulted everything outside avatars/banners to private — WRONG,
 * caught live against @gameboy's real world: a private/encrypted blob can
 * never render through a plain <img src>/<video src> binding, which is
 * exactly how every lively.data.FileUpload-created legacy file (the "drop
 * an image/video/audio/PDF onto the world" feature) is consumed. Fixed by
 * defaulting everything to public instead.
 *
 * Round 2 (2026-09-06, same day as the real fix): core/lively/data/
 * EncryptedMedia.js now teaches Image/Video/PDF morphs to decrypt-and-
 * render private content properly (see DeployCheckList.md's "Encrypted
 * media rendering" section) — but ONLY for morphs constructed through the
 * updated ImageUpload.js/VideoUpload.js/PDFUpload.js going forward. A
 * legacy file that's already embedded in an ALREADY-SAVED world is
 * embedded as a plain lively.morphic.Image / lively.morphic.Shapes.External
 * morph (serialized before EncryptedMedia.js existed) — migrating that
 * file to private and rewriting the world's URL string (the mechanism
 * _rewriteWorldsIfReferenced already does) does NOT upgrade the morph's
 * CLASS to the new Encrypted* type, so the old morph would still attempt a
 * direct undecryptable binding and break exactly the same way Round 1 did.
 * Fixing that properly means swapping the morph's class/shape in the
 * world's serialized graph, not just patching a URL string — real
 * additional surgery, not yet built (flagged as an open to-do in
 * DeployCheckList.md, not silently skipped).
 *
 * So the rule, as of Round 2:
 *   - WarpDrop/ (P2P-received files, only ever opened via FilesBrowser's
 *     own async fetchAndDecrypt/objectUrlFor flow, never a raw src
 *     binding) -> private
 *   - avatars/banners/ -> public, unconditionally. Not a rendering
 *     limitation of THIS module — ProfileCard.js displays them via its own
 *     plain <img>, a separate surface EncryptedMedia.js doesn't cover at
 *     all, so private would break there regardless of world-embedding.
 *   - everything else: private IF NOT referenced by any of the owner's
 *     worlds (safe — no old morph exists yet to worry about upgrading);
 *     public IF referenced by a world (preserves today's working
 *     behavior until the morph-class-upgrade gap above is actually built)
 *
 * Real correctness requirement Encryption.md's own §11 text never
 * anticipated (it only covered rewriting a profile's avatarUrl/bannerUrl):
 * a SAVED WORLD's plaintext payload can itself embed a legacy uploads URL
 * directly (e.g. an Image morph's _ImageURL), confirmed live against 4
 * real accounts with currently-working images this way. Deleting the
 * legacy file without first rewriting that reference would take a
 * currently-working image to newly broken — so every legacy file is
 * checked against the owner's own profile AND worlds, and any reference
 * found is rewritten to the new blob URL, BEFORE the legacy original is
 * ever deleted.
 *
 * Idempotency: deliberately no state.legacyPath marker (unlike
 * Encryption.md §11's original suggestion) — a file that still answers
 * GET /@:handle/uploads hasn't been fully migrated yet; once genuinely
 * deleted it naturally disappears from the next run's listing. A run that
 * dies between upload and delete just leaves one redundant (harmless,
 * content-deduplicated by blobCid) extra file envelope for next run to
 * recreate — same class of already-accepted append-only waste as
 * everywhere else in this codebase (worlds/postcards never get deleted
 * either), not a new failure mode.
 *
 * Processing is strictly SEQUENTIAL, one legacy file at a time — this is
 * a correctness requirement, not a style choice. ObjectRepository.put()
 * does not enforce prevCid ordering (confirmed by reading it directly),
 * so two overlapping world-envelope rewrites (e.g. one saved world with
 * two legacy-referencing morphs) could otherwise silently clobber each
 * other. Every world rewrite re-fetches that world fresh immediately
 * before computing its new payload, never reusing an earlier cached copy.
 */

module('lively.identity.UploadMigration')
  .requires(
    'lively.identity.DID',
    'lively.identity.Crypto',
    'lively.identity.FileCrypto',
    'lively.identity.UserSpace',
  )
  .toRun(function () {

    // See the header comment's "Round 2" for the full reasoning.
    var LEGACY_PRIVATE_PATH_RE = /^WarpDrop\//;
    var LEGACY_ALWAYS_PUBLIC_PATH_RE = /^(avatars|banners)\//;
    var _running = false;

    function _basename(path) {
      var i = path.lastIndexOf('/');
      return i === -1 ? path : path.slice(i + 1);
    }

    // Minimal sequential-async iterator -- runs iteratorFn(item, cb) for
    // each item in turn, never overlapping two at once (see header comment
    // for why overlap is unsafe here). cb() with no args to continue;
    // errors are the iterator's own job to swallow/log if they shouldn't
    // abort the whole run.
    function _eachSeries(items, iteratorFn, doneFn) {
      var i = 0;
      function next() {
        if (i >= items.length) return doneFn();
        iteratorFn(items[i++], next);
      }
      next();
    }

    function _fetchLegacyListing(handle, thenDo) {
      fetch('/@' + handle + '/uploads', { credentials: 'include' })
        .then(function (res) {
          if (!res.ok) throw new Error('HTTP ' + res.status);
          return res.json();
        })
        .then(function (body) { thenDo(null, body.files || []); })
        .catch(thenDo);
    }

    // Every object envelope readable by the owner, in one request -- used
    // only to cheaply pre-filter which worlds are worth re-checking; never
    // the basis for an actual write (see header comment).
    function _fetchOwnEnvelopes(handle, thenDo) {
      fetch('/@' + handle, {
        credentials: 'include',
        headers: { Accept: 'application/json' },
      })
        .then(function (res) {
          if (!res.ok) throw new Error('HTTP ' + res.status);
          return res.json();
        })
        .then(function (body) { thenDo(null, body.objects || []); })
        .catch(thenDo);
    }

    function _buildWorldCandidates(envelopes) {
      return envelopes
        .filter(function (e) { return e.type === 'world'; })
        .map(function (e) {
          return { objId: e.objId, textCache: JSON.stringify(e.record.payload) };
        });
    }

    // Rewrites the current profile's payload if (and only if) it contains
    // oldUrl anywhere -- catches avatarUrl/bannerUrl and, generically, any
    // other string field (e.g. a profile link) without hardcoding field
    // names. Reuses UserSpace.saveProfile's own fetch-fresh/merge/cid/sign
    // logic rather than reimplementing it.
    function _rewriteProfileIfReferenced(oldUrl, newUrl, thenDo) {
      lively.identity.userSpace.getProfile(function (err, profile) {
        if (err || !profile) return thenDo(); // no profile, or transient fetch error -- not fatal to this file's migration
        var payload = profile.record.payload || {};
        var text = JSON.stringify(payload);
        if (text.indexOf(oldUrl) === -1) return thenDo();

        var rewritten = JSON.parse(text.split(oldUrl).join(newUrl));
        var patch = {};
        Object.keys(rewritten).forEach(function (k) {
          if (JSON.stringify(rewritten[k]) !== JSON.stringify(payload[k])) patch[k] = rewritten[k];
        });
        if (!Object.keys(patch).length) return thenDo();

        lively.identity.userSpace.saveProfile(patch, function (err) {
          if (err) console.warn('[UploadMigration] profile rewrite failed for', oldUrl, err);
          thenDo();
        });
      });
    }

    // Rewrites every world whose CACHED payload text contained oldUrl.
    // Always re-fetches the world fresh right before computing the new
    // payload+cid+PUT -- required for correctness, see header comment.
    function _rewriteWorldsIfReferenced(handle, oldUrl, newUrl, worldCandidates, thenDo) {
      var candidates = worldCandidates.filter(function (c) { return c.textCache.indexOf(oldUrl) !== -1; });
      _eachSeries(candidates, function (candidate, next) {
        fetch('/@' + handle + '/' + candidate.objId, {
          credentials: 'include',
          headers: { Accept: 'application/json' },
        })
          .then(function (res) {
            if (!res.ok) throw new Error('HTTP ' + res.status);
            return res.json();
          })
          .then(function (envelope) {
            var text = JSON.stringify(envelope.record.payload);
            if (text.indexOf(oldUrl) === -1) return next(); // already rewritten earlier this run, or stale pre-filter hit

            var newPayload = JSON.parse(text.split(oldUrl).join(newUrl));
            lively.identity.crypto.computeCid(newPayload, function (err, newCid) {
              if (err) { console.warn('[UploadMigration] computeCid failed for world', candidate.objId, err); return next(); }
              var newEnvelope = {
                objId: envelope.objId,
                did: envelope.did,
                publicKey: envelope.publicKey,
                type: 'world',
                visibility: envelope.visibility,
                created: envelope.created,
                record: { cid: newCid, prevCid: envelope.record.cid, payload: newPayload },
                state: envelope.state,
              };
              fetch('/@' + handle + '/' + candidate.objId, {
                method: 'PUT',
                credentials: 'include',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(newEnvelope),
              })
                .then(function (res) {
                  if (!res.ok) throw new Error('HTTP ' + res.status);
                  next();
                })
                .catch(function (err) {
                  console.warn('[UploadMigration] world rewrite PUT failed for', candidate.objId, err);
                  next();
                });
            });
          })
          .catch(function (err) {
            console.warn('[UploadMigration] world re-fetch failed for', candidate.objId, err);
            next();
          });
      }, thenDo);
    }

    function _migrateOneFile(handle, fileEntry, worldCandidates, thenDo) {
      fetch(fileEntry.url, { credentials: 'include' })
        .then(function (res) {
          if (!res.ok) throw new Error('HTTP ' + res.status);
          return res.blob();
        })
        .then(function (blob) {
          var visibility;
          if (LEGACY_PRIVATE_PATH_RE.test(fileEntry.path)) {
            visibility = 'private';
          } else if (LEGACY_ALWAYS_PUBLIC_PATH_RE.test(fileEntry.path)) {
            visibility = 'public';
          } else {
            // Safe to go private only if no existing world already embeds
            // this file's URL as a plain, un-upgradeable morph -- see the
            // header comment's "Round 2" for why that case must stay
            // public until morph-class upgrading is actually built.
            var isWorldReferenced = worldCandidates.some(function (c) {
              return c.textCache.indexOf(fileEntry.url) !== -1;
            });
            visibility = isWorldReferenced ? 'public' : 'private';
          }
          lively.identity.fileCrypto.encryptAndUpload(blob, {
            visibility: visibility,
            name: _basename(fileEntry.path),
          }, function (err, result) {
            if (err) { console.warn('[UploadMigration] upload failed for', fileEntry.path, err); return thenDo(); }
            var oldUrl = fileEntry.url;
            var newUrl = result.url;
            _rewriteProfileIfReferenced(oldUrl, newUrl, function () {
              _rewriteWorldsIfReferenced(handle, oldUrl, newUrl, worldCandidates, function () {
                fetch(oldUrl, { method: 'DELETE', credentials: 'include' })
                  .then(function (res) {
                    if (!res.ok && res.status !== 404) console.warn('[UploadMigration] legacy delete failed for', fileEntry.path, res.status);
                    thenDo();
                  })
                  .catch(function (err) {
                    console.warn('[UploadMigration] legacy delete failed for', fileEntry.path, err);
                    thenDo();
                  });
              });
            });
          });
        })
        .catch(function (err) {
          console.warn('[UploadMigration] could not fetch legacy bytes for', fileEntry.path, err);
          thenDo();
        });
    }

    function _run(user) {
      var handle = user.handle;
      _fetchLegacyListing(handle, function (err, files) {
        if (err || !files.length) { _running = false; return; }

        _fetchOwnEnvelopes(handle, function (err, envelopes) {
          var worldCandidates = err ? [] : _buildWorldCandidates(envelopes);
          if (err) console.warn('[UploadMigration] could not fetch own envelopes, world references will not be rewritten this run', err);

          var progressBar = $world.addProgressBar(null, 'Migrating ' + files.length + ' legacy file(s)…');
          var done = 0;
          _eachSeries(files, function (fileEntry, next) {
            _migrateOneFile(handle, fileEntry, worldCandidates, function () {
              done++;
              progressBar.updateBar(done / files.length);
              next();
            });
          }, function () {
            progressBar.remove();
            console.log('[UploadMigration] finished, processed', done, 'of', files.length, 'legacy file(s)');
            _running = false;
          });
        });
      });
    }

    Object.extend(lively.identity.UploadMigration, {
      onIdentityChanged: function (user) {
        if (!user || _running) return;
        _running = true;
        // Defer well past initial boot so this never competes with page
        // interactivity -- migration is a background concern, not
        // launch-blocking.
        setTimeout(function () {
          var current = lively.identity.did.currentUser();
          if (!current) { _running = false; return; }
          _run(current);
        }, 2000);
      },
    });

    lively.bindings.connect(
      lively.identity.did, 'identityChanged',
      lively.identity.UploadMigration, 'onIdentityChanged',
    );

  });
