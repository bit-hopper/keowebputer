module("lively.identity.IdentityPartsSpace")
  .requires(
    "lively.PartsBin",
    "lively.identity.ObjectStore",
    "lively.identity.DID",
    "lively.identity.PartSerializer",
    "lively.identity.Crypto",
    "lively.identity.ItemTrust",
  )
  .toRun(function () {

    // ─── IdentityPartItem ─────────────────────────────────────────────────────
    //
    // PartItem subclass whose loadPart reads from a pre-cached envelope
    // (set by IdentityPartsSpace.createPartItemFromEnvelope) instead of
    // issuing WebDAV HEAD/GET requests.
    //
    // The PartsBin UI calls loadPart(isAsync, optCached, rev, cb). We ignore
    // all those flags — the envelope payload is always available synchronously.

    lively.PartsBin.PartItem.subclass("lively.identity.IdentityPartItem",
      "loading",
      {
        loadPart: function (isAsync, optCached, rev, cb) {
          var self = this;
          var envelope = this.envelope;

          if (!envelope || !envelope.record || !envelope.record.payload) {
            var err = new Error("[IdentityPartItem] No envelope payload for: " + this.name);
            console.warn(err.message);
            if (cb) cb(err);
            return this;
          }

          function _apply(err, json) {
            if (err) {
              console.error("[IdentityPartItem] loadPart failed for " + self.name + ":", err);
              if (cb) cb(err);
              return;
            }
            var metaInfo = self.loadedMetaInfo;
            var cid = envelope.record.cid;
            try {
              // setPartFromJSON(json, metaInfo, rev, cb) requires metaInfo to
              // have lastModifiedDate set — our createPartItemFromEnvelope
              // ensures this. Completion is no longer reliably synchronous
              // (it may wait on the untrusted-part trust-gate confirm
              // dialog), so cb has to be threaded through rather than
              // called right after this call returns -- confirmed live: an
              // un-threaded cb(null, self.part) here fired before self.part
              // was actually set, for any part not from the signed-in
              // user's own DID or an already-trusted author.
              self.setPartFromJSON(json, metaInfo, cid, function (setErr, part) {
                if (setErr) { if (cb) cb(setErr); return; }
                if (cb) cb(null, part);
              });
            } catch (e) {
              console.error("[IdentityPartItem] loadPart failed for " + self.name + ":", e);
              if (cb) cb(e);
              return;
            }
          }

          if (envelope.visibility === "public") {
            // Routed through PartSerializer.deserializeFromEnvelope (rather
            // than the old inline stringify) so a blob-backed payload
            // ({blobCid, size, mime} -- see PartSerializer.js's size-
            // threshold branch) gets resolved to the real JSON here too, not
            // just the small reference object. Also picks up a real CID
            // check for free, matching the private/shared branch below,
            // which already had one.
            lively.identity.partSerializer.deserializeFromEnvelope(envelope, self.handle, function (err, json) {
              _apply(err, json);
            });
          } else {
            lively.identity.partSerializer.deserializeEncrypted(envelope, self.handle, function (err, json) {
              _apply(err, json);
            });
          }

          return this;
        },
      },

      "trust",
      {
        // Classifies this item into one of PartsBin.js's setPartFromJSON
        // load-gate tiers using the envelope's real DID signature -- unlike
        // the base PartItem (classic WebDAV path), an identity part carries
        // genuine cryptographic provenance to check. Cached on first call
        // per item (an item's envelope doesn't change once constructed),
        // same lazy-once idiom as fetchHtmlLogo elsewhere in this feature.
        // json is accepted (not used) only to match the base PartItem's
        // getTrustInfo(json, cb) call convention -- this override already
        // has everything it needs on this.envelope.
        getTrustInfo: function (json, cb) {
          var self = this;
          if (this._trustInfo) { cb(this._trustInfo); return; }

          var envelope = this.envelope;
          function done(info) { self._trustInfo = info; cb(info); }

          if (!envelope || !envelope.did) { done({tier: "unsigned", did: null}); return; }

          var currentUser = lively.identity.did.currentUser && lively.identity.did.currentUser();
          if (currentUser && currentUser.did === envelope.did) {
            done({tier: "own", did: envelope.did});
            return;
          }

          if (!envelope.sig || !this.handle) {
            done({tier: "unsigned", did: envelope.did});
            return;
          }

          lively.identity.did.resolveEnvelopeSignerJwk(this.handle, function (err, signerJwk) {
            if (err) { done({tier: "unsigned", did: envelope.did}); return; }
            lively.identity.crypto.verifyEnvelopeIntegrity(envelope, signerJwk, function (verErr, result) {
              var verified = !verErr && result && result.cidValid && result.sigStatus === "verified";
              if (!verified) { done({tier: "unsigned", did: envelope.did}); return; }
              var tier = lively.identity.ItemTrust.isTrusted(envelope.did) ? "signed-allowlisted" : "signed-unknown";
              done({tier: tier, did: envelope.did});
            });
          });
        },
      },

      "versioning",
      {
        // Override of PartItem.loadPartVersions (core/lively/PartsBin.js) —
        // the base implementation queries lively.store.ObjectRepository,
        // a WebDAV-backed version log identity parts were never written
        // through, so it can only ever come back empty for one of these.
        // Real version history lives in the identity ObjectRepository
        // (server-side, SQLite) and is already exposed at
        // GET /@:handle/:objId/versions — this fetches that and reshapes
        // it into the {date, author, version} entries the PartsBinBrowser's
        // formatVersionEntry/setSelectedPartVersions already expect, so the
        // existing "partVersions" binding (wired in setSelectedPartItem
        // before this is called) needs no changes on the browser side.
        loadPartVersions: function (isAsync) {
          var self = this;
          var envelope = this.envelope;
          var space = this.getPartsSpace();
          var handle = this.handle || (space && space.handle);
          if (!envelope || !envelope.objId || !handle ||
              typeof lively === "undefined" || !lively.identity || !lively.identity.did) {
            this.partVersions = [];
            return this;
          }

          // Inventory browser (core/lively/identity/Inventory.js) sets
          // _instanceBaseUrl on items constructed for a non-local chosen
          // instance, so version history is fetched from the same
          // instance the item's data actually came from rather than
          // always the local origin. Also prefer this.handle (set
          // directly by both IdentityPartsSpace.createPartItemFromEnvelope
          // and the Inventory browser's own item construction) over
          // space.handle — a *public* item built without a real owning
          // IdentityPartsSpace has no space.handle to fall back on.
          var base = this._instanceBaseUrl || lively.identity.did.baseUrl();
          var url = base + "/@" + encodeURIComponent(handle) + "/" +
            encodeURIComponent(envelope.objId) + "/versions";
          var xhr = new XMLHttpRequest();
          xhr.open("GET", url, true);
          xhr.setRequestHeader("Accept", "application/json");
          // A cross-origin request can't combine withCredentials:true with
          // the server's wildcard Access-Control-Allow-Origin:* (the
          // browser rejects that combination outright per the CORS spec —
          // wildcard-origin responses are only valid for *credential-less*
          // requests). Same-origin (browsing the local instance) keeps
          // credentials so an owner viewing their own non-public items
          // still authenticates as before; a different instance is always
          // fetched anonymously.
          var isCrossOrigin = typeof window !== "undefined" && window.location &&
            base && base !== window.location.origin;
          xhr.withCredentials = !isCrossOrigin;
          xhr.onload = function () {
            if (xhr.status !== 200) { self.partVersions = []; return; }
            var data;
            try { data = JSON.parse(xhr.responseText); }
            catch (e) { self.partVersions = []; return; }
            self.partVersions = (data.versions || []).map(function (v) {
              return { date: v.createdAt, author: "@" + handle, version: v.cid.slice(0, 8) };
            });
          };
          xhr.onerror = function () { self.partVersions = []; };
          xhr.send();
          return this;
        },

        // Override of PartItem.loadPartMetaInfo — metaInfo (comment, tags,
        // partName, etc.) was already populated synchronously from the
        // envelope by IdentityPartsSpace.createPartItemFromEnvelope, so
        // there is nothing to fetch here. Without this override, the base
        // implementation would still fire a WebDAV ObjectRepository query
        // for a path identity parts were never written through (guarded
        // against crashing, per the existing "IDENTITY: pre-existing bug"
        // comment in PartsBin.js, but a wasted round-trip on every select).
        //
        // Re-firing the (unchanged) value below is not a no-op, despite
        // looking like one: PartsBinBrowser.setSelectedItem wires up
        // Global.connect(item, 'loadedMetaInfo', ...) *after* this item was
        // already constructed with loadedMetaInfo set, so the connection's
        // listener (setMetaInfoOfSelectedItem, which populates the comment
        // panel) has never seen a value yet — the underlying lively.bindings
        // connection setter fires on every assignment regardless of whether
        // the value actually changed (no equality check), so a same-value
        // reassignment here is exactly what the base class's real network
        // round-trip was standing in for.
        loadPartMetaInfo: function (isAsync, rev) {
          var self = this;
          if (this.loadedMetaInfo) {
            (function () { self.loadedMetaInfo = self.loadedMetaInfo; }).delay(0);
          }
          return this;
        },
      },
    );

    // ─── IdentityPartsSpace ───────────────────────────────────────────────────
    //
    // PartsSpace subclass backed by the identity ObjectStore (IndexedDB)
    // rather than WebDAV. The PartsBin UI calls getURL(), load(),
    // getPartItems(), getPartItemNamed(), and setPartItem(); this subclass
    // satisfies that contract while routing reads through ObjectStore.listAll().
    //
    // Migration path: once parts are fully stored as envelopes, the WebDAV
    // PartsBin directory can be retired.

    lively.PartsBin.PartsSpace.subclass("lively.identity.IdentityPartsSpace",

      "initializing",
      {
        initialize: function ($super, handle, did) {
          this.handle = handle;
          this.did = did;
          $super("/@" + handle + "/parts/");
        },

        // Return IdentityPartItem instances so loadPart uses the envelope cache.
        createPartItemNamed: function (name) {
          return new lively.identity.IdentityPartItem(name, this.name);
        },
      },

      "accessing",
      {
        getURL: function () {
          return URL.root.withFilename("@" + this.handle + "/");
        },
      },

      "loading",
      {
        // Async replacement for the parent's sync WebResource-based load().
        // Populates this.partItems from ObjectStore envelopes of type 'part'.
        // thenDo(err, this) — may be undefined for legacy callers.
        load: function (thenDo) {
          var self = this;
          lively.identity.objectStore.listAll(function (err, envelopes) {
            if (err) return thenDo && thenDo(err);
            envelopes
              .filter(function (e) { return e.type === "part"; })
              .forEach(function (envelope) {
                var item = self.createPartItemFromEnvelope(envelope);
                if (item) self.setPartItem(item);
              });
            thenDo && thenDo(null, self);
          });
        },

        createPartItemFromEnvelope: function (envelope) {
          var state = envelope.state || {};
          var partName = state.partName;
          if (!partName) return null;

          var item = new lively.identity.IdentityPartItem(partName, this.name);
          item.envelope = envelope;
          // Set directly rather than resolved later via item.getPartsSpace().handle
          // — that goes through the shared, mutable lively.PartsBin.partSpaces
          // registry (keyed by partsSpaceName), which can be reset out from under
          // us (e.g. PartsBinBrowser.setPartsBinURL does
          // `lively.PartsBin.partSpaces = {}`) between when this item was built
          // and when something reads its handle. A registry miss falls back to
          // constructing a plain lively.PartsBin.PartsSpace (partsSpaceNamed's
          // fallback), which has no .handle — that's what was silently sending
          // Share Link down the WebDAV url branch instead of the intermittent
          // symptom looked like a real bug in the URL logic itself.
          item.handle = this.handle;

          var metaInfo = new lively.PartsBin.PartsBinMetaInfo();
          metaInfo.partName         = partName;
          metaInfo.comment          = state.comment          || "";
          metaInfo.tags             = state.tags             || [];
          metaInfo.requiredModules  = state.requiredModules  || [];
          metaInfo.migrationLevel   = state.migrationLevel   || 9;
          metaInfo.partsSpaceName   = this.name;
          // setPartFromJSON accesses metaInfo.lastModifiedDate — must be a Date.
          metaInfo.lastModifiedDate = envelope.created
            ? new Date(envelope.created)
            : new Date();

          item.loadedMetaInfo = metaInfo;
          return item;
        },
      },
    );

  }); // end module("lively.identity.IdentityPartsSpace")
