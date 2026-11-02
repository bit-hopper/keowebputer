/**
 * lively.gaming.GameLog
 *
 * The data layer of the Gaming world template: one signed envelope per game in a
 * person's library (type 'gamelog'). No morphs in here, so everything can be driven
 * and tested without a world. The template's views (LibraryView, GameDialogs) talk
 * only to this module and never build an envelope themselves.
 *
 * An ENTRY, as handed to callers, is a plain object:
 *   { objId, did, visibility, envelope, payload }
 * where `payload` is the decrypted game record (see defaults()), `envelope` is the
 * latest stored version (kept so the next save can chain on its cid) and
 * `visibility` is 'private' | 'shared' | 'public'. A saved entry may also carry
 * `audience` ({ tiers, people }, who it is shared with) and `shareFailed` (people it
 * could not be sealed to this time); both are absent on an entry that was only read.
 *
 * How an entry is stored:
 *   - PRIVATE: the payload is encrypted with a fresh one-time key (DEK); the DEK is
 *     wrapped under the account's KEK (record.wrappedDek). The server stores
 *     ciphertext and can read nothing about the game, not even its title.
 *   - SHARED: encrypted exactly like a private one, and the one-time key is ALSO
 *     sealed once per recipient (record.recipients), so each of those people can open
 *     it with their own account key and nobody else can. Who the recipients are comes
 *     from the owner's recorded audience (Friends, Orbit, lists, specific people; the
 *     same settings state the postcards use, see lively.identity.PostcardAudience),
 *     which also keeps them in step when friends or lists change. Withdrawing someone
 *     stops the server serving the entry to them; anyone who already opened it keeps
 *     what they saw.
 *   - PUBLIC: the payload is stored as plain JSON, readable by anyone.
 *   An entry the signed-in person cannot open (sealed to other people only) is counted
 *   as `hidden` in list() and skipped.
 * `state` (the part of an envelope the server can read) carries only
 * { kind: 'gamelog' } and, once removed, { deleted: true }. NEVER put a title or any
 * other game detail in `state`: that is exactly what the encryption is there to hide.
 *
 * `updated_at` is bumped on EVERY write, including deletes and visibility changes.
 * This is not cosmetic: the server de-duplicates a version by (objId, cid), and the
 * cid is a hash of the payload, so a save that happens to reproduce an earlier
 * payload (toggle a rating up and back down) would be silently dropped as "already
 * stored" while still reporting success. A timestamp makes every payload unique.
 * (Private writes also differ by their fresh DEK and nonce, but do not rely on that
 * for public ones.)
 *
 * Public entry points (all asynchronous, callback style thenDo(err, result)):
 *   create(fields, visibility, thenDo)   -> entry
 *   save(entry, changes, thenDo)         -> entry   (changes: payload fields, plus
 *                                           optionally { visibility, audience })
 *   remove(entry, thenDo)                -> entry   (soft delete)
 *   list(handle, opts, thenDo)           -> { entries, hidden }   (all pages)
 *   open(envelope, thenDo)               -> entry or null (null: cannot be opened here)
 */

module("lively.gaming.GameLog")
  .requires(
    "lively.identity.Crypto",
    "lively.identity.DID",
    "lively.identity.WebAuthn",
    "lively.identity.WebKey",
    "lively.identity.EnvelopeSigning",
    "lively.identity.AudienceRules",
    "lively.identity.PostcardAudience",
    "lively.identity.PostCardSerializer",
  )
  .toRun(function () {

    // The five shelves a game can sit on. Order is the display order everywhere.
    var STATUSES = ["playing", "backlog", "completed", "dropped", "wishlist"];

    // Entries per request when reading a library. The server caps a page at 200.
    var PAGE_SIZE = 100;

    // How long the owner's friends / orbit / lists / recorded audiences, as loaded for
    // sealing, are reused. Saving a shared game (every review autosave) needs them to
    // know who to seal to, and loading them is three requests; a minute is short enough
    // that a friend added or removed is picked up by the next save, and anyone removed
    // in between is caught by the audience sync on the next load.
    var CTX_TTL_MS = 60 * 1000;
    var ctxCache = null;     // { at, ctx } or null

    // An audience that names nobody: how an entry is told to share with no one before it is
    // made private, so the audience sync cannot put the people back while the write is in flight.
    var NOBODY = { tiers: [], people: [] };

    Object.extend(lively.gaming.GameLog, {

      STATUSES: STATUSES,

      // A complete payload with every field present, so views never test for
      // undefined. `fields` overrides the defaults. Field names are snake_case on
      // purpose (they follow the library's own spec, not the camelCase the older
      // templates use). `playtime_minutes` is the number an import supplied;
      // `manual_playtime_minutes` is what the person typed. They are separate so an
      // import never overwrites a value typed by hand and vice versa.
      defaults: function (fields) {
        return Object.assign({
          title: "", year: null, genre: null, studio: null,
          cover_url: null, cover_source: null,       // 'igdb' | 'steam' | 'itch' | null
          igdb_id: null,
          external_ids: {},                          // e.g. { steam: "570" }, the import de-dupe keys
          platforms: [],
          status: "backlog",                         // one of STATUSES
          rating: 0,                                 // 0 = not rated, else 1 to 5
          review: "",
          playtime_minutes: null, playtime_source: null,   // 'steam' | 'manual' | null
          manual_playtime_minutes: null,
          last_synced_at: null, last_played_at: null,
          share_playtime: false,
          last_activity: { kind: "added", at: new Date().toISOString() },
          updated_at: new Date().toISOString(),
        }, fields || {});
      },

      // The playtime to SHOW for an entry, and where it came from. A value an import
      // supplied wins; otherwise the typed one. Returns { minutes, source } with
      // minutes null when there is nothing to show. Playtime is never shown without
      // its source, which is why this returns both.
      playtimeOf: function (payload) {
        if (payload.playtime_minutes != null) return { minutes: payload.playtime_minutes, source: payload.playtime_source || "steam" };
        if (payload.manual_playtime_minutes != null) return { minutes: payload.manual_playtime_minutes, source: "manual" };
        return { minutes: null, source: null };
      },

      // ─── sharing as a postcard ─────────────────────────────────────────────

      // The block of facts a postcard carries about a game: just enough to show which game
      // and how the owner is getting on, and nothing the owner did not tick.
      //   opts.rating    include the owner's rating (only if they have rated it)
      //   opts.playtime  include the playtime and where it came from (only if there is any)
      // The title, cover, status and database id always go in (the card is about this game);
      // the review never does (it goes in the card's own text, where the owner can edit it).
      shareBlock: function (payload, opts) {
        opts = opts || {};
        var b = { title: payload.title, cover_url: payload.cover_url || null, igdb_id: payload.igdb_id || null, status: payload.status };
        if (opts.rating && payload.rating) b.rating = payload.rating;
        var pt = this.playtimeOf(payload);
        if (opts.playtime && pt.minutes != null) { b.playtime_minutes = pt.minutes; b.playtime_source = pt.source; }
        return b;
      },

      // The opening words of a postcard about a game, as paragraphs: a line for what just
      // happened to it, then the review if there is one. The owner reads and edits them in
      // the postcard editor before anything is sent.
      shareText: function (payload) {
        var t = payload.title;
        var line = { playing: "Just started " + t, completed: "Finished " + t, dropped: "Dropped " + t,
          wishlist: "Wishlisting " + t, backlog: "Up next: " + t }[payload.status] || t;
        var review = String(payload.review || "").trim();
        return review ? [line, review] : [line];
      },

      // ─── reading ───────────────────────────────────────────────────────────

      // Turns a stored envelope into an entry, decrypting a private one with the
      // account's key. Calls thenDo(null, entry), or thenDo(null, null) when the
      // envelope is valid but cannot be opened HERE (sealed to other people, or a
      // private entry belonging to someone else), or thenDo(err) when it is broken
      // (the stored cid does not match the stored payload, or decryption fails).
      open: function (envelope, thenDo) {
        var self = this, c = lively.identity.crypto;
        if (!envelope || !envelope.record || !envelope.objId) return thenDo(new Error("GameLog.open: not an envelope"));
        var rec = envelope.record;
        var vis = envelope.visibility || "public";
        function done(payload) {
          thenDo(null, { objId: envelope.objId, did: envelope.did, visibility: vis, envelope: envelope, payload: self.defaults(payload) });
        }
        if (!rec.wrappedDek) {                              // public: the payload is the plain record
          if (!rec.payload || typeof rec.payload !== "object") return thenDo(new Error("GameLog.open: empty payload"));
          return done(rec.payload);
        }
        var user = lively.identity.did.currentUser();
        if (!user) return thenDo(null, null);
        var isOwner = user.did === envelope.did;
        // Someone else's entry opens only if it was sealed to this person.
        if (!isOwner && !(rec.recipients || []).some(function (r) { return r && r.did === user.did && r.sealedDek; })) {
          return thenDo(null, null);
        }
        // The cid is a hash of the ciphertext: check it before trusting anything inside.
        c.computeCid(rec.payload, function (err, cid) {
          if (err) return thenDo(err);
          if (cid !== rec.cid) return thenDo(new Error("GameLog.open: cid mismatch for " + envelope.objId));
          // The owner opens with their account key; a recipient with the copy sealed to them
          // (one passkey prompt per session either way; both keys are cached after that).
          function withDek(err, dek) {
            if (err) return thenDo(err);
            c.decryptPayload(rec.payload, rec.nonce, dek, function (err, payload) {
              if (err) return thenDo(err);
              done(payload);
            });
          }
          if (!isOwner) return lively.identity.PostCardSerializer.unwrapEnvelopeDek(envelope, withDek);
          self._kek(user, function (err, kek) {
            if (err) return thenDo(err);
            c.unwrapDek(rec.wrappedDek, kek, withDek);
          });
        });
      },

      // Every entry of `handle`'s library that the signed-in person (or an
      // anonymous visitor) may read, fetched page by page. The server decides what is
      // visible (owner: everything not deleted; others: public entries and ones sealed
      // to them), so this simply opens what comes back.
      //   opts.onPage(entriesSoFar)  optional, called after each page so a large
      //                              library can start painting before it is all in
      // Calls thenDo(null, { entries, hidden }); `hidden` counts envelopes that were
      // returned but cannot be opened here (see the header). Entries are newest first.
      list: function (handle, opts, thenDo) {
        var self = this;
        opts = opts || {};
        var entries = [], hidden = 0;
        (function page(cursor) {
          var url = "/@" + handle + "/games?limit=" + PAGE_SIZE + (cursor ? "&cursor=" + encodeURIComponent(cursor) : "");
          fetch(url, { credentials: "include", headers: { Accept: "application/json" } })
            .then(function (res) {
              if (!res.ok) throw new Error("GameLog.list: HTTP " + res.status);
              return res.json();
            })
            .then(function (body) {
              var envs = body.games || [], i = 0;
              (function next() {
                if (i >= envs.length) {
                  if (opts.onPage) opts.onPage(entries.slice());
                  return body.cursor ? page(body.cursor) : thenDo(null, { entries: entries, hidden: hidden });
                }
                self.open(envs[i++], function (err, entry) {
                  if (err) { hidden++; console.warn("[GameLog] skipped an unreadable entry:", err.message); }
                  else if (entry) entries.push(entry);
                  else hidden++;
                  next();
                });
              })();
            })
            .catch(function (err) { thenDo(err); });
        })(null);
      },

      // ─── writing ───────────────────────────────────────────────────────────

      // Adds a game to the signed-in person's library.
      //   fields      payload fields (merged over defaults(); title is required)
      //   visibility  'private' (the default) or 'public'
      // Calls thenDo(null, entry).
      create: function (fields, visibility, thenDo) {
        var self = this, user = lively.identity.did.currentUser();
        if (!user) return thenDo(new Error("GameLog.create: nobody is signed in"));
        if (!fields || !String(fields.title || "").trim()) return thenDo(new Error("GameLog.create: a game needs a title"));
        var payload = this.defaults(fields);
        payload.updated_at = new Date().toISOString();
        lively.identity.webKey.generateGenesisObjId(user.did, function (err, gen) {
          if (err) return thenDo(err);
          self._write(user, { objId: gen.objId, genesisNonce: gen.genesisNonce, created: new Date().toISOString(),
            prevCid: null, payload: payload, visibility: visibility || "private", deleted: false }, thenDo);
        });
      },

      // Applies `changes` to an entry and stores a new version. `changes` is a patch
      // over the payload plus two special keys that are not payload fields:
      //   visibility  'private' | 'shared' | 'public': moves the entry between the
      //               three, re-sealing or un-sealing it
      //   audience    { tiers, people } for visibility 'shared': who it is shared with
      //               (tiers are 'friends', 'orbit' and 'list:<id>', as for postcards)
      // Saving a shared entry WITHOUT naming an audience keeps it shared with the audience
      // recorded for it, so an ordinary edit (a rating, a review) never drops the people
      // who can open it. Only the owner can save. Calls thenDo(null, entry) with the entry
      // as now stored; the caller's old entry object is left untouched. If some people
      // could not be sealed to (their account has no encryption key yet, say), the entry
      // carries `shareFailed: [{ did, error }]`; it is stored for everyone else and the
      // audience sync tries those people again later.
      save: function (entry, changes, thenDo) {
        var self = this, user = lively.identity.did.currentUser();
        if (!user || user.did !== entry.did) return thenDo(new Error("GameLog.save: only the owner can change an entry"));
        changes = Object.assign({}, changes);
        var visibility = changes.visibility || entry.visibility;
        var audience = changes.audience || null;
        delete changes.visibility;
        delete changes.audience;
        var payload = Object.assign({}, entry.payload, changes, { updated_at: new Date().toISOString() });
        this._sharing(entry, visibility, audience, function (err, sharing) {
          if (err) return thenDo(err);
          self._write(user, { objId: entry.objId, created: entry.envelope.created,
            prevCid: entry.envelope.record.cid, payload: payload, visibility: visibility, deleted: false,
            audience: sharing.audience, recipientDids: sharing.dids, ctx: sharing.ctx }, function (err, saved) {
            if (err) return thenDo(err);
            // Now that the new version is stored, drop the recorded audience when the entry
            // stopped being shared (see _sharing for why it was first set to name nobody).
            if (!sharing.clearAfter) return thenDo(null, saved);
            self._recordAudience(entry.objId, null, function (err) {
              if (err) console.warn("[GameLog] could not clear the audience of " + entry.objId + ":", err.message);
              thenDo(null, saved);
            });
          });
        });
      },

      // Soft delete: the store is append-only, so a removal is a new version flagged
      // state.deleted, which the listing then leaves out. The payload is kept in that
      // last version (a library cannot truly forget a game it has stored; say so
      // honestly if a "delete" button ever promises otherwise). A shared entry is
      // re-sealed to nobody, so the people it was shared with lose it too. Calls
      // thenDo(null, entry).
      remove: function (entry, thenDo) {
        var self = this, user = lively.identity.did.currentUser();
        if (!user || user.did !== entry.did) return thenDo(new Error("GameLog.remove: only the owner can remove an entry"));
        var payload = Object.assign({}, entry.payload, { updated_at: new Date().toISOString() });
        var vis = entry.visibility === "shared" ? "private" : entry.visibility;
        this._sharing(entry, vis, null, function (err, sharing) {
          if (err) return thenDo(err);
          self._write(user, { objId: entry.objId, created: entry.envelope.created,
            prevCid: entry.envelope.record.cid, payload: payload, visibility: vis, deleted: true }, function (err, saved) {
            if (err) return thenDo(err);
            if (!sharing.clearAfter) return thenDo(null, saved);
            self._recordAudience(entry.objId, null, function () { thenDo(null, saved); });
          });
        });
      },

      // ─── sharing ───────────────────────────────────────────────────────────

      // Decides who a save is sealed to. Calls thenDo(null, sharing) with
      //   audience     { tiers, people } the entry ends up shared with, or null
      //   dids         the people to seal the content key to (empty unless shared)
      //   ctx          what the sealing needs (handles to look up keys by), or null
      //   clearAfter   true when a recorded audience must be removed once the write is stored
      // A change of visibility reads the owner's friends and recorded audiences fresh; an
      // ordinary edit of a shared entry may reuse what was read a minute ago (CTX_TTL_MS);
      // an entry that is neither shared nor becoming shared costs no extra request at all.
      //
      // Two ordering rules, both for safety:
      //  - Sharing records the audience FIRST, then writes. If the write fails the audience
      //    is still recorded, and the audience sync completes the job later; the other
      //    order would leave an entry shared with nobody managing it.
      //  - Un-sharing first records an audience that names NOBODY, then writes, then removes
      //    the record. If the record were removed first and the write failed, the entry would
      //    stay open to its old readers with nothing tracking that; if it were left in place,
      //    the audience sync would quietly share the entry again.
      _sharing: function (entry, visibility, audience, thenDo) {
        var self = this, R = lively.identity.AudienceRules;
        var wasShared = entry.visibility === "shared";
        var none = { audience: null, dids: [], ctx: null, clearAfter: false };
        if (visibility !== "shared" && !wasShared) return thenDo(null, none);      // private <-> public, never shared
        var changing = visibility !== entry.visibility || !!audience;
        this._context(changing, function (err, ctx) {
          if (err) return thenDo(err);
          var recorded = ctx.cardAudiences[entry.objId] || null;
          if (visibility === "shared") {
            var aud = audience || recorded;
            if (!aud) return thenDo(null, none);                                    // shared, but nothing recorded: seal to nobody
            var dids = R.unionDids(aud, ctx);
            if (!audience) return thenDo(null, { audience: aud, dids: dids, ctx: ctx, clearAfter: false });
            self._recordAudience(entry.objId, audience, function (err) {
              if (err) return thenDo(err);
              ctxCache = null;                                                      // the recorded audience just changed
              thenDo(null, { audience: audience, dids: dids, ctx: ctx, clearAfter: false });
            });
            return;
          }
          // Moving away from shared (to private or public).
          if (!recorded) return thenDo(null, none);
          self._recordAudience(entry.objId, NOBODY, function (err) {
            if (err) return thenDo(err);
            ctxCache = null;
            thenDo(null, { audience: null, dids: [], ctx: null, clearAfter: true });
          });
        });
      },

      // The owner's friends, orbit, lists and recorded audiences (PostcardAudience's
      // context). `fresh` skips the short-lived cache. thenDo(err, ctx).
      _context: function (fresh, thenDo) {
        if (!fresh && ctxCache && Date.now() - ctxCache.at < CTX_TTL_MS) return thenDo(null, ctxCache.ctx);
        lively.identity.postcardAudience.loadContext(function (err, ctx) {
          if (err) return thenDo(err);
          ctxCache = { at: Date.now(), ctx: ctx };
          thenDo(null, ctx);
        });
      },

      // Records (audience = { tiers, people }) or clears (null) the audience of one entry in
      // the owner's settings. Only the intent: the entry's recipients are written by save().
      // thenDo(err).
      _recordAudience: function (objId, audience, thenDo) {
        lively.identity.postcardAudience.setCardAudience(objId, audience, function (err) { thenDo(err); });
      },

      // Forgets the cached friends / audiences. Call after anything else changes them (the
      // audience dialog edits lists), so the next shared save reads them again.
      forgetContext: function () { ctxCache = null; },

      // The owner's context as the audience dialog needs it (friends, orbit, lists, handles),
      // always read fresh. thenDo(err, ctx).
      loadContext: function (thenDo) { this._context(true, thenDo); },

      // ─── internals ─────────────────────────────────────────────────────────

      // The account's key-encryption key. deriveKek answers from its per-session cache
      // when it can (one passkey prompt per session, not one per write). The rpId must
      // be passed explicitly: left out, it falls back to the configured production
      // domain and the ceremony fails on any other host (CLAUDE.md, Playwright notes).
      _kek: function (user, thenDo) {
        var ch = new Uint8Array(32);
        crypto.getRandomValues(ch);
        lively.identity.webAuthn.deriveKek({ credentialId: user.credentialId, rpId: user.rpId || window.location.hostname, challenge: ch }, thenDo);
      },

      // Builds, signs and stores one version.
      //   p: { objId, genesisNonce?, created, prevCid, payload, visibility, deleted,
      //        audience?, recipientDids?, ctx? }
      // `visibility` 'shared' seals the content key to each of p.recipientDids (looking up
      // their keys through p.ctx); the stored envelope says 'shared' only if at least one
      // person could be sealed to, else 'private'. p.audience is mirrored into the
      // envelope's readable state as just its coarse shape (Friends / Orbit / "custom",
      // never a list name or a person), which is what the readers' badge shows.
      // Calls thenDo(null, entry) once the server has accepted it.
      _write: function (user, p, thenDo) {
        var self = this, c = lively.identity.crypto;
        var wantsShared = p.visibility === "shared";
        var visibility = p.visibility === "public" ? "public" : "private";
        var state = { kind: "gamelog" };
        if (p.deleted) state.deleted = true;

        // record.recipients holds the sealed copies; `failed` lists people who could not be sealed to.
        function finish(record, failed) {
          if (record.recipients.length) visibility = "shared";
          if (visibility === "shared" && p.audience) state.audience = lively.identity.AudienceRules.mirrorFor(p.audience);
          var envelope = { objId: p.objId, did: user.did, type: "gamelog", visibility: visibility, created: p.created, record: record, state: state };
          if (p.genesisNonce) envelope.genesisNonce = p.genesisNonce;
          lively.identity.envelopeSigning.signEnvelopeIfPossible(envelope, user, c, function (err, signed) {
            if (err) return thenDo(err);
            var toSend = signed || envelope;
            self._put(user.handle, toSend, function (err) {
              if (err) return thenDo(err);
              var saved = { objId: toSend.objId, did: user.did, visibility: visibility, envelope: toSend, payload: self.defaults(p.payload) };
              if (wantsShared && p.audience) saved.audience = p.audience;
              if (failed && failed.length) saved.shareFailed = failed;
              thenDo(null, saved);
            });
          });
        }

        if (visibility === "public") {
          c.computeCid(p.payload, function (err, cid) {
            if (err) return thenDo(err);
            finish({ cid: cid, prevCid: p.prevCid, payload: p.payload, nonce: null, wrappedDek: null, recipients: [] });
          });
          return;
        }
        this._kek(user, function (err, kek) {
          if (err) return thenDo(err);
          c.wrapDek(kek, function (err, dekResult) {
            if (err) return thenDo(err);
            c.encryptPayload(p.payload, dekResult.dek, function (err, enc) {
              if (err) return thenDo(err);
              c.computeCid(enc.ciphertext, function (err, cid) {
                if (err) return thenDo(err);
                function store(recipients, failed) {
                  finish({ cid: cid, prevCid: p.prevCid, payload: enc.ciphertext, nonce: enc.nonce, wrappedDek: dekResult.wrappedDek, recipients: recipients }, failed);
                }
                var dids = wantsShared ? (p.recipientDids || []) : [];
                if (!dids.length) return store([], []);
                lively.identity.postcardAudience._sealFor(dekResult.dek, dids, p.ctx, function (err, sealed) {
                  if (err) return thenDo(err);
                  store(sealed.sealed.map(function (s) { return { did: s.did, sealedDek: s.sealedDek }; }), sealed.failed);
                });
              });
            });
          });
        });
      },

      // PUT an envelope. A non-2xx answer becomes an Error carrying the status and
      // whatever message the server gave (never the envelope, which holds ciphertext).
      _put: function (handle, envelope, thenDo) {
        fetch("/@" + handle + "/" + envelope.objId, {
          method: "PUT", credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(envelope),
        }).then(function (res) {
          if (res.ok) return thenDo(null);
          return res.text().then(function (t) {
            var e = new Error("GameLog: the server refused the save (HTTP " + res.status + ") " + String(t).slice(0, 160));
            e.status = res.status;
            thenDo(e);
          });
        }).catch(function (err) { thenDo(err); });
      },
    });
  }); // end module('lively.gaming.GameLog')
