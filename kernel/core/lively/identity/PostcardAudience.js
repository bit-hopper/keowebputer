/**
 * lively.identity.PostcardAudience
 *
 * Owner-side audience management for postcards: who each of the owner's cards is
 * shared with (Friends, Orbit, named lists, specific people), and keeping every
 * card's actual recipient list in step with that as friends, the orbit and the
 * lists change. The rules (set union, recipient diff) are in AudienceRules.js;
 * this file does the fetching, sealing, signing and writing. It also serves the
 * Gaming template's game entries (type 'gamelog', see SYNCABLE_TYPES): they are
 * sealed the same way and recorded in the same state.cardAudiences, so a friend
 * added to a list reaches an already shared game exactly as it reaches a card.
 *
 * Where the data lives (the owner's private settings envelope, state.*; the server
 * checks its shape in core/servers/identity/AudienceLists.js):
 *   state.audienceLists = [{ id, name, memberDids }]
 *   state.cardAudiences = { <objId>: { tiers: ['friends'|'orbit'|'list:<id>'], people: [did] } }
 * A card with no cardAudiences entry is not touched by syncAudiences.
 *
 * How a card is brought up to date (syncCard): the card's payload stays as it is.
 * Its key (DEK) is opened with the owner's KEK, sealed again for each person who
 * was added, the recipients list is rewritten, the envelope is signed again (the
 * signature covers record.recipients and visibility), and it is PUT with the SAME
 * record.cid. The server stores that in place without a new version, and checks
 * only that payload, nonce and wrappedDek did not change.
 *
 * Withdrawing someone stops the server serving them the card from then on; anyone
 * who already opened it keeps what they saw. A card that was delivered through the
 * inbox (state.sentAt) is frozen by the server and is skipped.
 *
 * Dependencies:
 *   lively.identity.Crypto, DID, WebAuthn, EnvelopeSigning, AudienceRules
 */

module('lively.identity.PostcardAudience')
  .requires(
    'lively.identity.Crypto',
    'lively.identity.DID',
    'lively.identity.WebAuthn',
    'lively.identity.EnvelopeSigning',
    'lively.identity.AudienceRules'
  )
  .toRun(function () {

    // A recipient's public key is cached this long, so a sync over many cards does
    // not fetch the same profile again for each; short enough that a rotated key is
    // picked up in a later session.
    var PUB_KEY_CACHE_TTL_MS = 5 * 60 * 1000;

    // The kinds of record whose recipients this keeps in step with state.cardAudiences.
    // Postcards, and the Gaming template's game entries ('gamelog'), which are sealed
    // the same way: a content key wrapped for the owner and sealed again per person.
    // A kind not listed here is skipped as 'not-owner', so adding one is a deliberate
    // act: it must keep the key outside the signed payload and have no frozen state.
    var SYNCABLE_TYPES = ['postcard', 'gamelog'];

    function rules() { return lively.identity.AudienceRules; }

    function enc(s) { return encodeURIComponent(s); }

    // thenDo(err, { status, json }). A body that is not JSON gives json: null.
    // Accept must say JSON: GET /@handle/<objId> answers a browser's default
    // "*/*" with an HTML page, not the envelope.
    function request(method, url, body, thenDo) {
      var opts = { method: method, credentials: 'include', headers: { Accept: 'application/json' } };
      if (body !== undefined) {
        opts.headers['Content-Type'] = 'application/json';
        opts.body = JSON.stringify(body);
      }
      fetch(url, opts).then(function (r) {
        return r.text().then(function (text) {
          var json = null;
          try { json = text ? JSON.parse(text) : null; } catch (e) { /* not JSON */ }
          return { status: r.status, json: json, text: text };
        });
      }).then(function (res) { thenDo(null, res); }, function (err) { thenDo(err); });
    }

    function failure(what, res) {
      var detail = (res.json && res.json.error) || (res.text || '').slice(0, 200);
      return new Error(what + ' failed (' + res.status + ')' + (detail ? ': ' + detail : ''));
    }

    Object.subclass('lively.identity.PostcardAudience', {

      _syncing: false,
      _pubKeyCache: null,

      // ─── settings: lists and per-card audiences ──────────────────────────────

      // Read-modify-write on the settings envelope, always from a fresh GET so a
      // change made from another window or tab is not overwritten by a stale copy.
      // mutate(state) edits env.state in place. thenDo(err, env).
      patchSettings: function (mutate, thenDo) {
        var user = lively.identity.did.currentUser();
        if (!user) return thenDo(new Error('Not signed in'));
        var url = lively.identity.did.baseUrl() + '/@' + enc(user.handle) + '/settings';
        request('GET', url, undefined, function (err, res) {
          if (err) return thenDo(err);
          if (res.status !== 200 || !res.json) return thenDo(failure('Loading settings', res));
          var env = res.json;
          env.state = env.state || {};
          mutate(env.state);
          var payload = (env.record && env.record.payload) || {};
          lively.identity.crypto.computeCid(payload, function (cidErr, cid) {
            if (cidErr) return thenDo(cidErr);
            env.record.cid = cid;
            request('PUT', url, env, function (putErr, putRes) {
              if (putErr) return thenDo(putErr);
              if (putRes.status !== 200) return thenDo(failure('Saving settings', putRes));
              // DID.js keeps its own copy of this envelope for the block list; hand it
              // the new one so a block made later in this session does not write the
              // old lists back.
              var did = lively.identity.did;
              if (did._relationshipsEnvelope) did._relationshipsEnvelope = env;
              thenDo(null, env);
            });
          });
        });
      },

      // The owner's settings state as stored now, without writing anything.
      // thenDo(err, state).
      readSettingsState: function (thenDo) {
        var user = lively.identity.did.currentUser();
        if (!user) return thenDo(new Error('Not signed in'));
        var url = lively.identity.did.baseUrl() + '/@' + enc(user.handle) + '/settings';
        request('GET', url, undefined, function (err, res) {
          if (err) return thenDo(err);
          if (res.status !== 200 || !res.json) return thenDo(failure('Loading settings', res));
          thenDo(null, res.json.state || {});
        });
      },

      // Replace all of the owner's named lists. lists: [{ id, name, memberDids }].
      // The server drops members who are not friends and card tiers whose list is
      // gone; thenDo(err, savedState) gives the state as stored.
      saveLists: function (lists, thenDo) {
        this.patchSettings(function (state) { state.audienceLists = lists; }, function (err, env) {
          thenDo(err, env && env.state);
        });
      },

      // Set (audience = { tiers, people }) or clear (audience = null, for a card that
      // became public) the audience of one card. This records the intent only;
      // syncCard / syncAudiences make the card match it.
      setCardAudience: function (objId, audience, thenDo) {
        this.patchSettings(function (state) {
          var all = state.cardAudiences = state.cardAudiences || {};
          if (audience) all[objId] = { tiers: audience.tiers || [], people: audience.people || [] };
          else delete all[objId];
        }, function (err, env) {
          thenDo(err, env && env.state);
        });
      },

      // ─── context: friends, orbit, lists, per-card audiences ──────────────────

      // Loads everything the rules need. Fails as a whole if any part fails to load:
      // computing audiences from an incomplete friend list would withdraw people by
      // mistake. thenDo(err, ctx) with the shape AudienceRules documents plus
      // { handle, handleByDid, lists, cardAudiences }.
      loadContext: function (thenDo) {
        var user = lively.identity.did.currentUser();
        if (!user) return thenDo(new Error('Not signed in'));
        var base = lively.identity.did.baseUrl() + '/@' + enc(user.handle);
        var got = {};
        var pending = 3;
        var failed = false;
        function part(name, what) {
          return function (err, res) {
            if (failed) return;
            if (err || res.status !== 200 || !res.json) {
              failed = true;
              return thenDo(err || failure(what, res));
            }
            got[name] = res.json;
            if (--pending === 0) finish();
          };
        }
        function finish() {
          var friends = got.friends.friends || [];
          var handleByDid = {};
          var friendDids = [];
          friends.forEach(function (f) {
            friendDids.push(f.did);
            if (f.handle) handleByDid[f.did] = f.handle;
          });
          var orbit = got.orbit || {};
          var orbitDids = [];
          (orbit.members || []).forEach(function (m) {
            orbitDids.push(m.did);
            if (m.handle && !handleByDid[m.did]) handleByDid[m.did] = m.handle;
          });
          var state = (got.settings && got.settings.state) || {};
          thenDo(null, {
            ownerDid: user.did,
            handle: user.handle,
            friendDids: friendDids,
            orbitDids: orbitDids,
            handleByDid: handleByDid,
            lists: state.audienceLists || [],
            cardAudiences: state.cardAudiences || {}
          });
        }
        request('GET', base + '/friends', undefined, part('friends', 'Loading friends'));
        request('GET', base + '/orbit', undefined, part('orbit', 'Loading orbit'));
        request('GET', base + '/settings', undefined, part('settings', 'Loading settings'));
      },

      // ─── recipient keys ──────────────────────────────────────────────────────

      // The X25519 public key a card key is sealed to, taken from the person's
      // public profile. The profile must belong to the DID we expect (a handle that
      // now points elsewhere must not receive the key) and pass its CID check, as
      // PostCardEditor does for its recipients. thenDo(err, pub).
      _fetchPubKey: function (did, handle, thenDo) {
        var cache = this._pubKeyCache = this._pubKeyCache || {};
        var hit = cache[did];
        if (hit && (Date.now() - hit.at) < PUB_KEY_CACHE_TTL_MS) return thenDo(null, hit.pub);
        if (!handle) return thenDo(new Error('no handle known for ' + did));
        var url = lively.identity.did.baseUrl() + '/@' + enc(handle) + '/profile';
        request('GET', url, undefined, function (err, res) {
          if (err) return thenDo(err);
          if (res.status !== 200 || !res.json) return thenDo(failure('Loading the profile of @' + handle, res));
          var env = res.json;
          if (env.did !== did) return thenDo(new Error('@' + handle + ' is not the account we expected'));
          var pub = env.record && env.record.payload && env.record.payload.accountX25519Pub;
          if (!pub) return thenDo(new Error('@' + handle + ' has not set up encryption yet'));
          lively.identity.crypto.computeCid(env.record.payload, function (cidErr, cid) {
            if (cidErr) return thenDo(cidErr);
            if (cid !== env.record.cid) return thenDo(new Error('the profile of @' + handle + ' failed its integrity check'));
            cache[did] = { pub: pub, at: Date.now() };
            thenDo(null, pub);
          });
        });
      },

      // Seals dek for each of dids. thenDo(null, { sealed: [{did, sealedDek}], failed: [{did, error}] }).
      _sealFor: function (dek, dids, ctx, thenDo) {
        var self = this;
        var c = lively.identity.crypto;
        var sealed = [];
        var failed = [];
        if (!dids.length) return thenDo(null, { sealed: sealed, failed: failed });
        var remaining = dids.length;
        function done() { if (--remaining === 0) thenDo(null, { sealed: sealed, failed: failed }); }
        dids.forEach(function (did) {
          self._fetchPubKey(did, ctx.handleByDid[did], function (err, pub) {
            if (err) { failed.push({ did: did, error: String(err.message || err) }); return done(); }
            c.sealForRecipient(dek, pub, function (sealErr, sealedDek) {
              if (sealErr) failed.push({ did: did, error: String(sealErr.message || sealErr) });
              else sealed.push({ did: did, sealedDek: sealedDek });
              done();
            });
          });
        });
      },

      // The owner's KEK, from the session cache when it is there, else one passkey
      // prompt. thenDo(err, kek).
      _kek: function (user, thenDo) {
        var ch = new Uint8Array(32);
        crypto.getRandomValues(ch);
        lively.identity.webAuthn.deriveKek({ credentialId: user.credentialId, rpId: user.rpId, challenge: ch }, thenDo);
      },

      // ─── syncing ─────────────────────────────────────────────────────────────

      // Bring one card's recipients in line with its recorded audience.
      // thenDo(err, result) where result is
      //   { objId, result: 'updated', added: [did], removed: [did], failed: [{did, error}] }
      //   { objId, result: 'skipped', reason: 'unmanaged'|'missing'|'not-owner'|'not-encrypted'|
      //                                      'deleted'|'sent'|'current' }
      // `failed` lists people who should have been added but whose key could not be
      // fetched; the card is updated for everyone else and the next sync tries again.
      syncCard: function (objId, ctx, thenDo) {
        var self = this;
        var R = rules();
        var c = lively.identity.crypto;
        var user = lively.identity.did.currentUser();
        if (!user) return thenDo(new Error('Not signed in'));
        function skip(reason) { thenDo(null, { objId: objId, result: 'skipped', reason: reason }); }

        var entry = ctx.cardAudiences[objId];
        if (!entry) return skip('unmanaged');
        var url = lively.identity.did.baseUrl() + '/@' + enc(user.handle) + '/' + enc(objId);

        request('GET', url, undefined, function (err, res) {
          if (err) return thenDo(err);
          if (res.status === 404) return skip('missing');
          if (res.status !== 200 || !res.json) return thenDo(failure('Loading ' + objId, res));
          var env = res.json;
          if (SYNCABLE_TYPES.indexOf(env.type) === -1 || env.did !== ctx.ownerDid) return skip('not-owner');
          if (env.state && env.state.deleted) return skip('deleted');
          if (env.state && env.state.sentAt) return skip('sent');
          if (env.visibility === 'public' || !env.record || !env.record.wrappedDek) return skip('not-encrypted');

          var desired = R.unionDids(entry, ctx);
          var plan = R.planRecipients(env.record.recipients, desired);
          var mirror = R.mirrorFor(entry);
          var sameMirror = R.sameMirror(env.state && env.state.audience, mirror);
          if (!plan.changed && sameMirror && env.visibility === R.visibilityFor(plan.keep.length)) {
            return skip('current');
          }

          // fileIds: the files the card carries, for the people in `added` to be
          // granted access to as well (see _grantFiles).
          function write(recipients, failedAdds, added, fileIds) {
            var next = Object.assign({}, env, {
              visibility: R.visibilityFor(recipients.length),
              record: Object.assign({}, env.record, { recipients: recipients }),
              state: Object.assign({}, env.state || {}, { audience: mirror })
            });
            // The old signature covered the old recipients and would read as invalid.
            delete next.sig;
            lively.identity.envelopeSigning.signEnvelopeIfPossible(next, user, c, function (signErr, signed) {
              if (signErr) return thenDo(signErr);
              request('PUT', url, signed || next, function (putErr, putRes) {
                if (putErr) return thenDo(putErr);
                if (putRes.status === 409) return skip('sent');
                if (putRes.status !== 200 && putRes.status !== 201) return thenDo(failure('Saving ' + objId, putRes));
                var result = {
                  objId: objId, result: 'updated',
                  added: added, removed: plan.remove, failed: failedAdds
                };
                if (!added.length || !fileIds || !fileIds.length) return thenDo(null, result);
                self._grantFiles(fileIds, added, ctx, function (grantFailed) {
                  if (grantFailed.length) result.fileGrantsFailed = grantFailed;
                  thenDo(null, result);
                });
              });
            });
          }

          if (!plan.add.length) return write(plan.keep, [], []);

          self._kek(user, function (kekErr, kek) {
            if (kekErr) return thenDo(kekErr);
            c.unwrapDek(env.record.wrappedDek, kek, function (dekErr, dek) {
              if (dekErr) return thenDo(dekErr);
              self._fileIds(env, dek, function (fileIds) {
                self._sealFor(dek, plan.add, ctx, function (_e, sealResult) {
                  // A person added here is sealed into this version (the cid stays the
                  // same), which is the baseline a later "edited since" diff starts from.
                  var added = sealResult.sealed.map(function (e) {
                    return { did: e.did, sealedDek: e.sealedDek, sinceCid: env.record.cid };
                  });
                  var recipients = plan.keep.concat(added);
                  // Nobody could be added and nobody is being withdrawn: writing would
                  // only re-sign an unchanged card on every sync. Report it instead.
                  if (!sealResult.sealed.length && !plan.remove.length && sameMirror &&
                      env.visibility === R.visibilityFor(recipients.length)) {
                    return thenDo(null, { objId: objId, result: 'skipped', reason: 'unsealable', failed: sealResult.failed });
                  }
                  write(recipients, sealResult.failed, sealResult.sealed.map(function (s) { return s.did; }), fileIds);
                });
              });
            });
          });
        });
      },

      // The objIds of the files a card carries (inline attachments and the stamps on
      // its back are both entries in payload.attachments), read from the decrypted
      // payload. The key to open a file travels inside the card, but the server serves
      // a file only to people on that file's own recipient list, so sharing the card
      // is not enough to let someone open its attachments. thenDo(ids); a payload that
      // cannot be read gives [] (the card is still shared).
      _fileIds: function (env, dek, thenDo) {
        lively.identity.crypto.decryptPayload(env.record.payload, env.record.nonce, dek, function (err, payload) {
          if (err || !payload) return thenDo([]);
          var ids = [];
          (payload.attachments || []).forEach(function (a) {
            if (a && a.objId && ids.indexOf(a.objId) === -1) ids.push(a.objId);
          });
          thenDo(ids);
        });
      },

      // Put each of dids on each file's recipient list (the owner-only grant-access
      // route, by handle). Withdrawing is not done here: a person who was sealed to the
      // card already holds the key to its files, as the dialog's help line says.
      // thenDo([{ objId, did, error }]) lists the grants that did not go through; the
      // card itself is already shared by then.
      _grantFiles: function (fileIds, dids, ctx, thenDo) {
        var failed = [];
        var jobs = [];
        fileIds.forEach(function (objId) {
          dids.forEach(function (did) { jobs.push({ objId: objId, did: did }); });
        });
        if (!jobs.length) return thenDo(failed);
        var remaining = jobs.length;
        function done() { if (--remaining === 0) thenDo(failed); }
        jobs.forEach(function (job) {
          var handle = ctx.handleByDid[job.did];
          if (!handle) { failed.push({ objId: job.objId, did: job.did, error: 'no handle known' }); return done(); }
          var url = lively.identity.did.baseUrl() + '/nodejs/IdentityServer/grant-access/' + enc(job.objId);
          request('POST', url, { recipientHandle: handle }, function (err, res) {
            if (err) failed.push({ objId: job.objId, did: job.did, error: String(err.message || err) });
            else if (res.status !== 200) failed.push({ objId: job.objId, did: job.did, error: 'HTTP ' + res.status });
            done();
          });
        });
      },

      // True when the owner's KEK is already in the session cache, so a sync can seal
      // and sign without asking for the passkey.
      kekIsCached: function () {
        var user = lively.identity.did.currentUser();
        var wa = lively.identity.webAuthn;
        return !!(user && wa && wa._kekCache && wa._kekCache[user.credentialId]);
      },

      // Sync every card that has a recorded audience, one after another. Run it when
      // the homestar opens and after friends, the orbit or a list change.
      // syncAudiences([opts,] thenDo) -> thenDo(err, { updated: [result],
      //   skipped: [result], failed: [{objId, error}] }).
      // opts.onlyIfKekCached: a sync nobody asked for (the one on page load) must not
      //   open a passkey prompt; without a cached KEK it does nothing and reports
      //   { deferred: true }.
      // A second call while one is running returns { busy: true } straight away.
      syncAudiences: function (opts, thenDo) {
        var self = this;
        if (typeof opts === 'function') { thenDo = opts; opts = {}; }
        opts = opts || {};
        if (opts.onlyIfKekCached && !this.kekIsCached()) {
          return thenDo(null, { deferred: true, updated: [], skipped: [], failed: [] });
        }
        if (this._syncing) return thenDo(null, { busy: true, updated: [], skipped: [], failed: [] });
        this._syncing = true;
        function finish(err, report) { self._syncing = false; thenDo(err, report); }

        this.loadContext(function (err, ctx) {
          if (err) return finish(err);
          var ids = Object.keys(ctx.cardAudiences);
          var report = { updated: [], skipped: [], failed: [] };
          (function next(i) {
            if (i >= ids.length) return finish(null, report);
            self.syncCard(ids[i], ctx, function (cardErr, r) {
              if (cardErr) report.failed.push({ objId: ids[i], error: String(cardErr.message || cardErr) });
              else if (r.result === 'updated') report.updated.push(r);
              else report.skipped.push(r);
              next(i + 1);
            });
          })(0);
        });
      }
    });

    lively.identity.postcardAudience = new lively.identity.PostcardAudience();

  }); // end module('lively.identity.PostcardAudience')
