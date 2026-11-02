/**
 * lively.identity.ObjectStore
 *
 * Client-side envelope cache backed by IndexedDB. Works fully offline;
 * syncs to the identity server when online.
 *
 * Database: 'LivelyIdentityObjects' (separate from the existing LivelyDatabase)
 * Stores:
 *   envelopes — out-of-line key (objId:cid), indexed by objId
 *               value: { objId, cid, prevCid, created, envelope: JSON string, synced: bool }
 *   heads     — keyPath 'objId'
 *               value: { objId, cid } pointing to the local HEAD version
 *
 * Envelope versions are append-only (content-addressed). Putting the same cid
 * twice is a no-op. Sync is pull-then-push per object.
 */

module('lively.identity.ObjectStore')
  .requires('lively.identity.Crypto')
  .toRun(function() {

Object.subclass('lively.identity.ObjectStore',

'setup', {

  DB_NAME:    'LivelyIdentityObjects',
  DB_VERSION: 1,

  initialize: function() {
    this._db = null;
  },

  withDB: function(thenDo) {
    if (this._db) return thenDo(null, this._db);
    var self = this;
    var req = window.indexedDB.open(this.DB_NAME, this.DB_VERSION);
    req.onerror = function(e) { thenDo(e.target.error); };
    req.onsuccess = function(e) {
      self._db = e.target.result;
      thenDo(null, self._db);
    };
    req.onupgradeneeded = function(e) {
      var db = e.target.result;
      // envelopes: out-of-line key "objId:cid", with a by-objId index for listing
      var envStore = db.createObjectStore('envelopes');
      envStore.createIndex('by-objId', 'objId', { unique: false });
      // heads: one entry per objId, keyPath so get/put by objId directly
      db.createObjectStore('heads', { keyPath: 'objId' });
    };
  }

},

'storage', {

  // Store an envelope version locally.
  // Content-addressed: duplicate cid is a silent no-op.
  // Calls thenDo(err, { objId, cid, isNew }).
  put: function(envelope, thenDo) {
    if (!envelope || !envelope.objId || !envelope.record || !envelope.record.cid) {
      return thenDo(new Error('ObjectStore.put: envelope missing objId or record.cid'));
    }
    var objId = envelope.objId;
    var cid   = envelope.record.cid;
    var key   = objId + ':' + cid;

    this.withDB(function(err, db) {
      if (err) return thenDo(err);
      var done = false;
      var tx = db.transaction(['envelopes', 'heads'], 'readwrite');
      tx.onerror = function(e) {
        if (!done) { done = true; thenDo(e.target.error); }
      };
      tx.onabort = function() {
        if (!done) { done = true; thenDo(new Error('ObjectStore.put: transaction aborted')); }
      };

      var envStore  = tx.objectStore('envelopes');
      var headStore = tx.objectStore('heads');

      // Check existence before inserting (getKey is cheaper than get)
      var checkReq = envStore.getKey(key);
      checkReq.onerror = function(e) {
        if (!done) { done = true; thenDo(e.target.error); }
      };
      checkReq.onsuccess = function(e) {
        if (e.target.result !== undefined) {
          done = true;
          return thenDo(null, { objId: objId, cid: cid, isNew: false });
        }

        envStore.put({
          objId:    objId,
          cid:      cid,
          prevCid:  envelope.record.prevCid || null,
          created:  new Date().toISOString(),
          envelope: JSON.stringify(envelope),
          synced:   false
        }, key);

        headStore.put({ objId: objId, cid: cid });

        // Both puts are in the same transaction — oncomplete fires after both commit.
        tx.oncomplete = function() {
          if (!done) { done = true; thenDo(null, { objId: objId, cid: cid, isNew: true }); }
        };
      };
    });
  },

  // Overwrite the stored envelope for an existing (objId, cid) key — for
  // metadata-only changes (e.g. state.tags) where the cid is unchanged
  // because cid only ever hashes record.payload (mirrors the server's
  // ObjectRepository._updateInPlace, same reasoning). put()'s dedup check
  // above only compares the (objId, cid) key, not the stored content, so it
  // silently no-ops a metadata-only change with the same cid — this bypasses
  // that check for callers that specifically know they're updating state.
  // Marks synced:false so the normal sync path pushes it to the server.
  // Calls thenDo(err).
  updateState: function(envelope, thenDo) {
    if (!envelope || !envelope.objId || !envelope.record || !envelope.record.cid) {
      return thenDo(new Error('ObjectStore.updateState: envelope missing objId or record.cid'));
    }
    var key = envelope.objId + ':' + envelope.record.cid;
    this.withDB(function(err, db) {
      if (err) return thenDo(err);
      var tx = db.transaction(['envelopes', 'heads'], 'readwrite');
      tx.onerror = function(e) { thenDo(e.target.error); };
      tx.onabort = function() { thenDo(new Error('ObjectStore.updateState: transaction aborted')); };
      tx.objectStore('envelopes').put({
        objId:    envelope.objId,
        cid:      envelope.record.cid,
        prevCid:  envelope.record.prevCid || null,
        created:  new Date().toISOString(),
        envelope: JSON.stringify(envelope),
        synced:   false
      }, key);
      tx.objectStore('heads').put({ objId: envelope.objId, cid: envelope.record.cid });
      tx.oncomplete = function() { thenDo(null); };
    });
  },

  // Get the HEAD (latest) envelope for an objId.
  // Calls thenDo(null, envelope) or thenDo(null, null).
  get: function(objId, thenDo) {
    this.withDB(function(err, db) {
      if (err) return thenDo(err);
      var tx = db.transaction(['envelopes', 'heads'], 'readonly');
      tx.onerror = function(e) { thenDo(e.target.error); };

      var headReq = tx.objectStore('heads').get(objId);
      headReq.onerror = function(e) { thenDo(e.target.error); };
      headReq.onsuccess = function(e) {
        var head = e.target.result;
        if (!head) return thenDo(null, null);

        var envReq = tx.objectStore('envelopes').get(objId + ':' + head.cid);
        envReq.onerror = function(e) { thenDo(e.target.error); };
        envReq.onsuccess = function(e) {
          var rec = e.target.result;
          if (!rec) return thenDo(null, null);
          try { thenDo(null, JSON.parse(rec.envelope)); }
          catch (ex) { thenDo(new Error('ObjectStore.get: corrupt envelope for ' + objId)); }
        };
      };
    });
  },

  // Get a specific envelope version by cid.
  // Calls thenDo(null, envelope) or thenDo(null, null).
  getVersion: function(objId, cid, thenDo) {
    this.withDB(function(err, db) {
      if (err) return thenDo(err);
      var req = db.transaction('envelopes', 'readonly')
                  .objectStore('envelopes').get(objId + ':' + cid);
      req.onerror  = function(e) { thenDo(e.target.error); };
      req.onsuccess = function(e) {
        var rec = e.target.result;
        if (!rec) return thenDo(null, null);
        try { thenDo(null, JSON.parse(rec.envelope)); }
        catch (ex) { thenDo(new Error('ObjectStore.getVersion: corrupt envelope')); }
      };
    });
  },

  // List all stored versions of an object (insertion order via cursor).
  // Calls thenDo(null, [{ cid, prevCid, createdAt }]).
  listVersions: function(objId, thenDo) {
    this.withDB(function(err, db) {
      if (err) return thenDo(err);
      var index   = db.transaction('envelopes', 'readonly')
                      .objectStore('envelopes').index('by-objId');
      var results = [];
      var req = index.openCursor(IDBKeyRange.only(objId));
      req.onerror  = function(e) { thenDo(e.target.error); };
      req.onsuccess = function(e) {
        var cursor = e.target.result;
        if (!cursor) return thenDo(null, results);
        results.push({
          cid:       cursor.value.cid,
          prevCid:   cursor.value.prevCid,
          createdAt: cursor.value.created
        });
        cursor.continue();
      };
    });
  },

  // Return the HEAD envelope for every known object.
  // Calls thenDo(null, envelope[]).
  listAll: function(thenDo) {
    var self = this;
    this.withDB(function(err, db) {
      if (err) return thenDo(err);
      var heads = [];
      var req = db.transaction('heads', 'readonly').objectStore('heads').openCursor();
      req.onerror  = function(e) { thenDo(e.target.error); };
      req.onsuccess = function(e) {
        var cursor = e.target.result;
        if (!cursor) {
          if (heads.length === 0) return thenDo(null, []);
          var remaining  = heads.length;
          var envelopes  = [];
          var failed     = false;
          heads.forEach(function(h) {
            self.get(h.objId, function(err, env) {
              if (failed) return;
              if (err) { failed = true; return thenDo(err); }
              if (env) envelopes.push(env);
              if (--remaining === 0) thenDo(null, envelopes);
            });
          });
          return;
        }
        heads.push(cursor.value);
        cursor.continue();
      };
    });
  }

},

'sync', {

  // Mark a stored version as successfully pushed to the server.
  _markSynced: function(objId, cid, thenDo) {
    this.withDB(function(err, db) {
      if (err) return thenDo(err);
      var key   = objId + ':' + cid;
      var store = db.transaction('envelopes', 'readwrite').objectStore('envelopes');
      var getReq = store.get(key);
      getReq.onerror  = function(e) { thenDo(e.target.error); };
      getReq.onsuccess = function(e) {
        var rec = e.target.result;
        if (!rec) return thenDo(null);
        rec.synced = true;
        var putReq = store.put(rec, key); // same tx, still open
        putReq.onerror  = function(e) { thenDo(e.target.error); };
        putReq.onsuccess = function() { thenDo(null); };
      };
    });
  },

  // Verify an incoming envelope's CID integrity, then store it.
  // IDENTITY: signature verification deferred — WebAuthn assertion signing
  // comes in a future iteration. CID check catches accidental corruption and
  // costs nothing since the payload is already loaded. Non-fatal on
  // mismatch: this used to hash-check via plain JSON.stringify (not
  // canonicalJson, fixed 2026-09-13 -- see Crypto.js's computeCid comment)
  // and reject the sync entirely on any mismatch, which made any object
  // round-tripped through Postgres jsonb storage permanently unsyncable even
  // when untampered. No separate crypto proof exists for this generic sync
  // path (signature verification is deferred per the comment above), so warn
  // instead of silently swallowing it.
  // Calls thenDo(err, result).
  _verifyAndPut: function(envelope, thenDo) {
    var self = this;
    if (!envelope || !envelope.record) {
      return thenDo(new Error('ObjectStore._verifyAndPut: invalid envelope'));
    }
    lively.identity.crypto.computeCid(envelope.record.payload, function(err, expectedCid) {
      if (err) return thenDo(err);
      if (expectedCid !== envelope.record.cid) {
        console.warn(
          'ObjectStore: CID mismatch on incoming envelope ' + envelope.objId +
          ' (syncing anyway; signature verification for this path is deferred)'
        );
      }
      self.put(envelope, thenDo);
    });
  },

  // Pull new versions of one object from the server since localCid.
  // Applies versions in server order, verifying each signature.
  // Calls thenDo(err, addedCount).
  _pullObject: function(objId, handle, serverBaseUrl, localCid, thenDo) {
    var self = this;
    var since = localCid || 'genesis';
    var url = serverBaseUrl.replace(/\/$/, '') +
              '/@' + handle + '/' + objId + '/since/' + since;

    fetch(url, { credentials: 'include' })
      .then(function(res) {
        if (res.status === 404) return { deltas: [] };
        if (!res.ok) throw new Error('Pull failed for ' + objId + ': HTTP ' + res.status);
        return res.json();
      })
      .then(function(body) {
        var deltas = (body && body.deltas) || [];
        if (deltas.length === 0) return thenDo(null, 0);

        // Apply versions in the order the server returned them (ascending)
        var added = 0;
        var i = 0;
        function next(err) {
          if (err) return thenDo(err);
          if (i >= deltas.length) return thenDo(null, added);
          self._verifyAndPut(deltas[i++], function(err, result) {
            if (err) return thenDo(err);
            if (result && result.isNew) added++;
            next(null);
          });
        }
        next(null);
      })
      .catch(thenDo);
  },

  // Push all locally-unsynced versions of one object to the server.
  // Calls thenDo(err, pushedCount).
  _pushObject: function(objId, handle, serverBaseUrl, thenDo) {
    var self = this;
    this.withDB(function(err, db) {
      if (err) return thenDo(err);
      var index    = db.transaction('envelopes', 'readonly')
                       .objectStore('envelopes').index('by-objId');
      var unsynced = [];
      var req = index.openCursor(IDBKeyRange.only(objId));
      req.onerror  = function(e) { thenDo(e.target.error); };
      req.onsuccess = function(e) {
        var cursor = e.target.result;
        if (!cursor) {
          unsynced = unsynced.filter(function(r) { return !r.synced; });
          if (unsynced.length === 0) return thenDo(null, 0);

          var pushed = 0;
          var i = 0;
          function pushNext(err) {
            if (err) return thenDo(err);
            if (i >= unsynced.length) return thenDo(null, pushed);
            var rec = unsynced[i++];
            var url = serverBaseUrl.replace(/\/$/, '') + '/@' + handle + '/' + objId;
            fetch(url, {
              method:      'PUT',
              credentials: 'include',
              headers:     { 'Content-Type': 'application/json' },
              body:        rec.envelope
            }).then(function(res) {
              if (res.ok) {
                self._markSynced(rec.objId, rec.cid, function() { pushed++; pushNext(null); });
              } else {
                pushNext(null); // server rejected (auth, conflict) — skip, don't abort
              }
            }).catch(pushNext);
          }
          pushNext(null);
          return;
        }
        unsynced.push(cursor.value);
        cursor.continue();
      };
    });
  },

  // Sync a single object: pull new versions from server, then push unsynced local versions.
  // Calls thenDo(err, { pulled, pushed }).
  syncObject: function(objId, handle, serverBaseUrl, thenDo) {
    var self = this;
    this.get(objId, function(err, head) {
      if (err) return thenDo(err);
      var localCid = head ? head.record.cid : null;

      self._pullObject(objId, handle, serverBaseUrl, localCid, function(err, pulled) {
        if (err) return thenDo(err);
        self._pushObject(objId, handle, serverBaseUrl, function(err, pushed) {
          if (err) return thenDo(err);
          thenDo(null, { pulled: pulled, pushed: pushed });
        });
      });
    });
  },

  // Sync all locally known objects for a handle.
  // Returns immediately with { skipped: true } when offline.
  // Calls thenDo(err, { pulled, pushed } | { skipped, reason }).
  sync: function(handle, serverBaseUrl, thenDo) {
    var self = this;
    lively.net.SessionTracker.whenOnline(function(err) {
      if (err) return thenDo(null, { skipped: true, reason: 'offline' });

      self.listAll(function(err, envelopes) {
        if (err) return thenDo(err);
        if (envelopes.length === 0) return thenDo(null, { pulled: 0, pushed: 0 });

        var totalPulled = 0;
        var totalPushed = 0;
        var remaining   = envelopes.length;
        var failed      = false;

        envelopes.forEach(function(env) {
          self.syncObject(env.objId, handle, serverBaseUrl, function(err, result) {
            if (failed) return;
            if (err) { failed = true; return thenDo(err); }
            totalPulled += result.pulled;
            totalPushed += result.pushed;
            if (--remaining === 0) thenDo(null, { pulled: totalPulled, pushed: totalPushed });
          });
        });
      });
    });
  }

});

lively.identity.objectStore = new lively.identity.ObjectStore();

}); // end module('lively.identity.ObjectStore')
