// keo IndexedDB stand-in, WORLD side. Loaded after keo-bridge.js, before the Lively bootstrap.
//
// A sandboxed page may not touch IndexedDB, but the runtime uses it directly in several places (lively.IndexedDB, the
// identity object store, direct messages, the key vault, the wallet vault). This is an implementation of the part of
// the API those callers use, held in memory in the world and persisted by the shell (which has the real IndexedDB):
//   - indexedDB.open(name, version) with upgradeneeded / createObjectStore / createIndex, deleteDatabase, databases, cmp;
//   - object stores: keyPath (string, dotted, or array) or out-of-line keys, autoIncrement;
//   - put / add / get / getKey / getAll / getAllKeys / delete / clear / count / openCursor / openKeyCursor;
//   - indexes (unique or not, multiEntry), IDBKeyRange (the native one; it is a plain value class and needs no database);
//   - transactions: readonly / readwrite / versionchange, complete / error / abort events, rollback on abort.
// How it works: open() asks the shell for the stored copy of the database ('idb.load') and builds the in-memory model;
// from then on every operation runs against the model at once (so a request sees the writes of earlier requests in the
// same transaction) and its result is delivered asynchronously, the way a real request is. Every mutation is queued and
// sent to the shell ('idb.apply') in order, in batches. Values are structured-cloned on the way in and out, so CryptoKeys,
// Blobs, ArrayBuffers and the like survive.
// LIMITS (do not rely on more than this):
//   - no cross-tab coordination: each world instance holds its own copy; two tabs writing the same database overwrite each
//     other record by record, and a tab does not see the other's later writes until it reopens the database;
//   - "readwrite" transactions on the same store do not wait for each other (everything is already applied), so
//     interleavings can differ from a real database; abort restores the records and schema the transaction changed;
//   - cursors run over a snapshot taken when they are opened; direction 'prev' is supported, 'nextunique' too, but
//     writes made through a cursor while iterating are not re-visited;
//   - unsupported: getAll with a count beyond what is stored, IDBObjectStore.getAllRecords, openCursor on an index with
//     a key range using array keys that mix types beyond the ordering rules below, durability hints, blocked/versionchange events.
// Key order follows the specification: numbers < dates < strings < binary < arrays.
(function () {
  'use strict';
  var keo = window.keo;
  // Not "if indexedDB is missing": in a sandboxed page window.indexedDB exists but throws SecurityError from open().
  // Install whenever the bridge is live; with no shell (standalone) there is nothing to persist to, so leave it as is.
  if (!keo || typeof keo.call !== 'function') return;

  // set window.__keoIdbDebug = true to trace the stand-in's own steps to the console (debugging only)
  function dbg() { if (window.__keoIdbDebug) console.log.apply(console, ['keo-idb:'].concat([].slice.call(arguments))); }

  // ---------- errors ----------
  function dom(msg, name) { return new DOMException(msg, name); }

  // ---------- keys ----------
  function rank(k) {
    if (typeof k === 'number') return isNaN(k) ? 0 : 1;
    if (k instanceof Date) return isNaN(k.getTime()) ? 0 : 2;
    if (typeof k === 'string') return 3;
    if (k instanceof ArrayBuffer || ArrayBuffer.isView(k)) return 4;
    if (Array.isArray(k)) return 5;
    return 0;
  }
  function validKey(k, seen) {
    var r = rank(k);
    if (!r) return false;
    if (r !== 5) return true;
    seen = seen || [];
    if (seen.indexOf(k) !== -1) return false;
    seen.push(k);
    for (var i = 0; i < k.length; i++) if (!validKey(k[i], seen)) return false;
    seen.pop();
    return true;
  }
  function bytes(k) { return k instanceof ArrayBuffer ? new Uint8Array(k) : new Uint8Array(k.buffer, k.byteOffset, k.byteLength); }
  function cmp(a, b) {
    var ra = rank(a), rb = rank(b);
    if (ra !== rb) return ra < rb ? -1 : 1;
    switch (ra) {
      case 1: return a < b ? -1 : a > b ? 1 : 0;
      case 2: return a.getTime() < b.getTime() ? -1 : a.getTime() > b.getTime() ? 1 : 0;
      case 3: return a < b ? -1 : a > b ? 1 : 0;
      case 4: {
        var x = bytes(a), y = bytes(b), n = Math.min(x.length, y.length);
        for (var i = 0; i < n; i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
        return x.length < y.length ? -1 : x.length > y.length ? 1 : 0;
      }
      case 5: {
        var m = Math.min(a.length, b.length);
        for (var j = 0; j < m; j++) { var c = cmp(a[j], b[j]); if (c) return c; }
        return a.length < b.length ? -1 : a.length > b.length ? 1 : 0;
      }
    }
    return 0;
  }
  function clone(v) { return structuredClone(v); }

  // ---------- key paths ----------
  function getByPath(value, path) {
    if (path === '') return value;
    var parts = path.split('.'), v = value;
    for (var i = 0; i < parts.length; i++) {
      if (v === null || v === undefined || typeof v !== 'object' && typeof v !== 'string') return undefined;
      if (typeof v === 'string' && parts[i] !== 'length') return undefined;
      if (!(parts[i] in Object(v))) return undefined;
      v = v[parts[i]];
    }
    return v;
  }
  function keyFromPath(value, kp) {
    if (Array.isArray(kp)) {
      var out = [];
      for (var i = 0; i < kp.length; i++) { var k = getByPath(value, kp[i]); if (k === undefined || !validKey(k)) return undefined; out.push(k); }
      return out;
    }
    var key = getByPath(value, kp);
    return key !== undefined && validKey(key) ? key : undefined;
  }
  function setByPath(value, path, key) {
    var parts = path.split('.'), o = value;
    for (var i = 0; i < parts.length - 1; i++) {
      if (!(parts[i] in o) || o[parts[i]] === null || typeof o[parts[i]] !== 'object') o[parts[i]] = {};
      o = o[parts[i]];
    }
    o[parts[parts.length - 1]] = key;
  }

  // ---------- ranges ----------
  function normRange(q) {
    if (q === undefined || q === null) return null;
    if (q && typeof q === 'object' && ('lower' in q) && ('upper' in q) && ('lowerOpen' in q)) return q;     // an IDBKeyRange
    if (!validKey(q)) throw dom('The parameter is not a valid key or key range.', 'DataError');
    return { lower: q, upper: q, lowerOpen: false, upperOpen: false, _only: true };
  }
  function inRange(r, key) {
    if (!r) return true;
    if (r.lower !== undefined) { var c = cmp(key, r.lower); if (c < 0 || (c === 0 && r.lowerOpen)) return false; }
    if (r.upper !== undefined) { var d = cmp(key, r.upper); if (d > 0 || (d === 0 && r.upperOpen)) return false; }
    return true;
  }

  // ---------- events ----------
  function Emitter() { this._l = {}; }
  Emitter.prototype.addEventListener = function (t, f) { (this._l[t] = this._l[t] || []).push(f); };
  Emitter.prototype.removeEventListener = function (t, f) { var a = this._l[t]; if (a) { var i = a.indexOf(f); if (i >= 0) a.splice(i, 1); } };
  Emitter.prototype._fire = function (type, extra, bubbleTo) {
    var ev = { type: type, target: this, currentTarget: this, defaultPrevented: false,
      preventDefault: function () { this.defaultPrevented = true; }, stopPropagation: function () { this._stop = true; } };
    if (extra) Object.keys(extra).forEach(function (k) { ev[k] = extra[k]; });
    var node = this;
    while (node) {
      ev.currentTarget = node;
      var h = node['on' + type];
      try { if (typeof h === 'function') h.call(node, ev); } catch (e) { setTimeout(function () { throw e; }); }
      (node._l[type] || []).slice().forEach(function (f) { try { f.call(node, ev); } catch (e) { setTimeout(function () { throw e; }); } });
      if (ev._stop || !bubbleTo) break;
      node = node._parent && type === 'error' ? node._parent : null;
    }
    return ev;
  };

  // ---------- persistence queue ----------
  var queue = {}, chains = {};
  function persist(dbName, op) {
    dbg('persist', dbName, op.t, op.s || '');
    (queue[dbName] = queue[dbName] || []).push(op);
    if (queue[dbName].length === 1) Promise.resolve().then(function () { flush(dbName); });
  }
  function flush(dbName) {
    var ops = queue[dbName]; queue[dbName] = [];
    if (!ops || !ops.length) return;
    chains[dbName] = (chains[dbName] || Promise.resolve()).then(function () {
      return keo.call('idb.apply', { name: dbName, ops: ops }, 60000);
    }).catch(function (e) { console.warn('keo idb: could not persist ' + ops.length + ' change(s) to ' + dbName + ': ' + e.message); });
  }

  // ---------- model ----------
  function Store(name, opts) {
    opts = opts || {};
    this.name = name;
    this.keyPath = opts.keyPath === undefined ? null : opts.keyPath;
    this.autoIncrement = !!opts.autoIncrement;
    this.indexes = {};              // name -> { name, keyPath, unique, multiEntry }
    this.records = [];              // sorted by key: { key, value }
    this.nextKey = 1;
  }
  Store.prototype.schema = function () {
    var self = this;
    return { keyPath: this.keyPath, autoIncrement: this.autoIncrement, nextKey: this.nextKey,
      indexes: Object.keys(this.indexes).map(function (n) { return self.indexes[n]; }) };
  };
  Store.prototype.pos = function (key) {      // -> { i, found }
    var lo = 0, hi = this.records.length;
    while (lo < hi) {
      var mid = (lo + hi) >> 1, c = cmp(this.records[mid].key, key);
      if (c === 0) return { i: mid, found: true };
      if (c < 0) lo = mid + 1; else hi = mid;
    }
    return { i: lo, found: false };
  };
  Store.prototype.indexKeys = function (ix, value) {
    var k = keyFromPath(value, ix.keyPath);
    if (k === undefined) {
      // multiEntry with an array value indexes each element
      if (ix.multiEntry && !Array.isArray(ix.keyPath)) {
        var raw = getByPath(value, ix.keyPath);
        if (Array.isArray(raw)) {
          var out = [];
          raw.forEach(function (e) { if (validKey(e) && !out.some(function (o) { return cmp(o, e) === 0; })) out.push(e); });
          return out;
        }
      }
      return [];
    }
    if (ix.multiEntry && Array.isArray(k) && !Array.isArray(ix.keyPath)) {
      var uniq = [];
      k.forEach(function (e) { if (validKey(e) && !uniq.some(function (o) { return cmp(o, e) === 0; })) uniq.push(e); });
      return uniq;
    }
    return [k];
  };
  // index entries as [{ ikey, pkey, value }] sorted by (ikey, pkey)
  Store.prototype.indexEntries = function (ix) {
    var self = this, out = [];
    this.records.forEach(function (r) { self.indexKeys(ix, r.value).forEach(function (ik) { out.push({ ikey: ik, pkey: r.key, value: r.value }); }); });
    out.sort(function (a, b) { return cmp(a.ikey, b.ikey) || cmp(a.pkey, b.pkey); });
    return out;
  };
  Store.prototype.checkUnique = function (key, value) {
    var self = this;
    Object.keys(this.indexes).forEach(function (n) {
      var ix = self.indexes[n];
      if (!ix.unique) return;
      self.indexKeys(ix, value).forEach(function (ik) {
        for (var i = 0; i < self.records.length; i++) {
          var r = self.records[i];
          if (cmp(r.key, key) === 0) continue;
          if (self.indexKeys(ix, r.value).some(function (o) { return cmp(o, ik) === 0; })) throw dom('Unable to add key to index \'' + n + '\': at least one key does not satisfy the uniqueness requirements.', 'ConstraintError');
        }
      });
    });
  };

  function DbModel(name, version) { this.name = name; this.version = version; this.stores = {}; }
  DbModel.prototype.schema = function () {
    var out = {}, self = this;
    Object.keys(this.stores).forEach(function (n) { out[n] = self.stores[n].schema(); });
    return out;
  };
  var models = {};      // name -> DbModel (this world's copy)

  function modelFromStored(name, data) {
    var m = new DbModel(name, data.version);
    Object.keys(data.stores || {}).forEach(function (sn) {
      var d = data.stores[sn], s = new Store(sn, { keyPath: d.keyPath, autoIncrement: d.autoIncrement });
      s.nextKey = d.nextKey || 1;
      (d.indexes || []).forEach(function (ix) { s.indexes[ix.name] = ix; });
      s.records = (d.records || []).map(function (p) { return { key: p[0], value: p[1] }; }).sort(function (a, b) { return cmp(a.key, b.key); });
      m.stores[sn] = s;
    });
    return m;
  }

  // ---------- requests and transactions ----------
  // Run f in a later task (not a microtask). A real database commits or aborts a transaction only after the callback that
  // issued its last request AND every microtask that callback started (an `await` continuation that issues the next request)
  // have run; a microtask-scheduled finish check can run between a request's delivery and that continuation and finish the
  // transaction too early. A MessageChannel is used rather than setTimeout so a background tab's timer throttling cannot
  // stall every database call.
  var taskQueue = [], taskChannel = new MessageChannel();
  taskChannel.port1.onmessage = function () { var f = taskQueue.shift(); if (f) f(); };
  function nextTask(f) { taskQueue.push(f); taskChannel.port2.postMessage(0); }

  function Request(source, tx) { Emitter.call(this); this.source = source || null; this.transaction = tx || null; this.readyState = 'pending'; this.result = undefined; this.error = null; this._parent = tx || null; }
  Request.prototype = Object.create(Emitter.prototype);

  function Transaction(db, names, mode) {
    Emitter.call(this);
    this.db = db; this.mode = mode; this.objectStoreNames = names.slice(); this.error = null;
    this._pending = 0; this._done = false; this._aborted = false; this._undo = {}; this._schemaUndo = null; this._parent = db;
    this._handles = {};
    var self = this;
    nextTask(function () { self._maybeFinish(); });
  }
  Transaction.prototype = Object.create(Emitter.prototype);
  Transaction.prototype.objectStore = function (name) {
    if (this._done) throw dom('The transaction has finished.', 'InvalidStateError');
    if (this.objectStoreNames.indexOf(name) === -1) throw dom('The specified object store was not found.', 'NotFoundError');
    return this._handles[name] || (this._handles[name] = new StoreHandle(this.db._model.stores[name], this));
  };
  // snapshot a store's records once, before this transaction first changes it, so abort can restore them
  Transaction.prototype._touch = function (store) {
    if (!this._undo[store.name]) this._undo[store.name] = { store: store, records: store.records.slice(), nextKey: store.nextKey };
  };
  Transaction.prototype._enqueue = function (req, work) {
    var self = this;
    if (this._done) throw dom('The transaction has finished.', 'TransactionInactiveError');
    this._pending++;
    var outcome;
    try { outcome = { ok: true, value: work() }; } catch (e) { outcome = { ok: false, error: e }; }
    Promise.resolve().then(function () {
      if (self._aborted) { self._pending--; return; }
      req.readyState = 'done';
      if (outcome.ok) {
        req.result = outcome.value; req.error = null;
        if (req._beforeSuccess) req._beforeSuccess();
        req._fire('success');
      }
      else {
        req.error = outcome.error;
        var ev = req._fire('error', null, true);
        if (!ev.defaultPrevented) self._abort(outcome.error);
      }
      self._pending--;
      nextTask(function () { self._maybeFinish(); });
    });
    return req;
  };
  Transaction.prototype._maybeFinish = function () {
    if (this._done || this._aborted || this._pending > 0 || this._holding) return;
    dbg('complete tx', this.mode);
    this._done = true;
    if (this.mode === 'versionchange' && this._onSchemaDone) this._onSchemaDone();
    var self = this;
    nextTask(function () { self._fire('complete'); });     // a task later, as a real database does: callers attach tx.oncomplete after an await
  };
  Transaction.prototype._abort = function (err) {
    dbg('abort tx', this.mode, err && err.name);
    if (this._done || this._aborted) return;
    this._aborted = true;
    var self = this;
    Object.keys(this._undo).forEach(function (n) { var u = self._undo[n]; u.store.records = u.records; u.store.nextKey = u.nextKey; });
    if (this._schemaUndo) this._schemaUndo();
    // tell the shell the restored state (records of every touched store, rewritten whole)
    Object.keys(this._undo).forEach(function (n) {
      var s = self._undo[n].store;
      persist(self.db._model.name, { t: 'replace', s: s.name, schema: s.schema(), records: s.records.map(function (r) { return [r.key, r.value]; }) });
    });
    this.error = err || null;
    this._done = true;
    nextTask(function () { self._fire('abort'); });     // a task later, as a real database does: a caller awaiting a failed request attaches tx.onabort a few microtasks after the error
    if (this._onAbort) this._onAbort();
  };
  Transaction.prototype.abort = function () {
    if (this._done) throw dom('The transaction has already finished.', 'InvalidStateError');
    this._abort(null);
  };

  // ---------- object store and index handles ----------
  function StoreHandle(store, tx) {
    this._s = store; this._tx = tx; this.name = store.name; this.transaction = tx;
    Object.defineProperty(this, 'keyPath', { get: function () { return store.keyPath; } });
    Object.defineProperty(this, 'autoIncrement', { get: function () { return store.autoIncrement; } });
    Object.defineProperty(this, 'indexNames', { get: function () { return Object.keys(store.indexes).sort(); } });      // a DOMStringList is sorted
    this._ix = {};
  }
  function writable(h) {
    if (h._tx.mode === 'readonly') throw dom('The transaction is read-only.', 'ReadOnlyError');
  }
  StoreHandle.prototype._put = function (value, key, noOverwrite) {
    var s = this._s;
    writable(this);
    if (this._tx._done) throw dom('The transaction has finished.', 'InvalidStateError');
    if (s.keyPath !== null && key !== undefined) throw dom('The object store uses in-line keys and the key parameter was provided.', 'DataError');
    if (s.keyPath === null && key === undefined && !s.autoIncrement) throw dom('The object store uses out-of-line keys and has no key generator and the key parameter was not provided.', 'DataError');
    var tx = this._tx, self = this;
    var v = clone(value);
    // a value or key that can never be stored is refused at once (DataError), not by failing the request later, which would abort the transaction
    if (s.keyPath !== null && (keyFromPath(v, s.keyPath) === undefined) && (!s.autoIncrement || Array.isArray(s.keyPath))) throw dom('Evaluating the object store\'s key path did not yield a value.', 'DataError');
    if (key !== undefined && !validKey(key)) throw dom('The parameter is not a valid key.', 'DataError');
    var req = new Request(this, tx);
    return tx._enqueue(req, function () {
      var k = key, generated = false;
      if (s.keyPath !== null) {
        k = keyFromPath(v, s.keyPath);
        if (k === undefined) {
          if (!s.autoIncrement || Array.isArray(s.keyPath)) throw dom('Evaluating the object store\'s key path did not yield a value.', 'DataError');
          k = s.nextKey; generated = true;
          if (v === null || typeof v !== 'object') throw dom('The value cannot hold the generated key.', 'DataError');
          setByPath(v, s.keyPath, k);
        }
      } else if (k === undefined) { k = s.nextKey; generated = true; }
      else if (!validKey(k)) throw dom('The parameter is not a valid key.', 'DataError');
      k = clone(k);
      var p = s.pos(k);
      if (p.found && noOverwrite) throw dom('Unable to add key to object store: a record with this key already exists.', 'ConstraintError');
      s.checkUnique(k, v);
      tx._touch(s);
      var before = s.nextKey;
      if (typeof k === 'number' && s.autoIncrement && k >= s.nextKey) s.nextKey = Math.floor(k) + 1;
      else if (generated) s.nextKey = k + 1;
      var rec = { key: k, value: v };
      if (p.found) s.records[p.i] = rec; else s.records.splice(p.i, 0, rec);
      persist(tx.db._model.name, { t: 'put', s: s.name, k: k, v: v });
      if (s.nextKey !== before) persist(tx.db._model.name, { t: 'next', s: s.name, n: s.nextKey });
      return clone(k);
    });
  };
  StoreHandle.prototype.put = function (value, key) { return this._put(value, key, false); };
  StoreHandle.prototype.add = function (value, key) { return this._put(value, key, true); };
  StoreHandle.prototype.get = function (q) {
    var r = normRange(q); if (!r) throw dom('The parameter is not a valid key.', 'DataError');
    var s = this._s;
    return this._tx._enqueue(new Request(this, this._tx), function () {
      for (var i = 0; i < s.records.length; i++) if (inRange(r, s.records[i].key)) return clone(s.records[i].value);
      return undefined;
    });
  };
  StoreHandle.prototype.getKey = function (q) {
    var r = normRange(q); if (!r) throw dom('The parameter is not a valid key.', 'DataError');
    var s = this._s;
    return this._tx._enqueue(new Request(this, this._tx), function () {
      for (var i = 0; i < s.records.length; i++) if (inRange(r, s.records[i].key)) return clone(s.records[i].key);
      return undefined;
    });
  };
  StoreHandle.prototype._all = function (q, count, keysOnly) {
    var r = normRange(q), s = this._s;
    return this._tx._enqueue(new Request(this, this._tx), function () {
      var out = [];
      for (var i = 0; i < s.records.length && (count === undefined || out.length < count); i++) {
        if (inRange(r, s.records[i].key)) out.push(clone(keysOnly ? s.records[i].key : s.records[i].value));
      }
      return out;
    });
  };
  StoreHandle.prototype.getAll = function (q, count) { return this._all(q, count, false); };
  StoreHandle.prototype.getAllKeys = function (q, count) { return this._all(q, count, true); };
  StoreHandle.prototype.count = function (q) {
    var r = normRange(q), s = this._s;
    return this._tx._enqueue(new Request(this, this._tx), function () {
      var n = 0; for (var i = 0; i < s.records.length; i++) if (inRange(r, s.records[i].key)) n++; return n;
    });
  };
  StoreHandle.prototype['delete'] = function (q) {
    writable(this);
    var r = normRange(q); if (!r) throw dom('The parameter is not a valid key.', 'DataError');
    var s = this._s, tx = this._tx;
    return tx._enqueue(new Request(this, tx), function () {
      tx._touch(s);
      var keep = [], dropped = [];
      s.records.forEach(function (rec) { (inRange(r, rec.key) ? dropped : keep).push(rec); });
      s.records = keep;
      dropped.forEach(function (rec) { persist(tx.db._model.name, { t: 'del', s: s.name, k: rec.key }); });
      return undefined;
    });
  };
  StoreHandle.prototype.clear = function () {
    writable(this);
    var s = this._s, tx = this._tx;
    return tx._enqueue(new Request(this, tx), function () {
      tx._touch(s); s.records = []; persist(tx.db._model.name, { t: 'clear', s: s.name }); return undefined;
    });
  };
  StoreHandle.prototype.index = function (name) {
    if (!this._s.indexes[name]) throw dom('The specified index was not found.', 'NotFoundError');
    return this._ix[name] || (this._ix[name] = new IndexHandle(this, this._s.indexes[name]));
  };
  StoreHandle.prototype.createIndex = function (name, keyPath, opts) {
    if (this._tx.mode !== 'versionchange') throw dom('The database is not running a version change transaction.', 'InvalidStateError');
    if (this._s.indexes[name]) throw dom('An index with the specified name already exists.', 'ConstraintError');
    opts = opts || {};
    var ix = { name: name, keyPath: keyPath, unique: !!opts.unique, multiEntry: !!opts.multiEntry };
    var s = this._s, tx = this._tx;
    // existing records must satisfy a unique index
    if (ix.unique) {
      var seen = [];
      s.records.forEach(function (r) {
        s.indexKeys(ix, r.value).forEach(function (k) {
          if (seen.some(function (o) { return cmp(o, k) === 0; })) throw dom('Unable to create the unique index: existing records collide.', 'ConstraintError');
          seen.push(k);
        });
      });
    }
    s.indexes[name] = ix;
    persist(tx.db._model.name, { t: 'index', s: s.name, ix: ix });
    return this.index(name);
  };
  StoreHandle.prototype.deleteIndex = function (name) {
    if (this._tx.mode !== 'versionchange') throw dom('The database is not running a version change transaction.', 'InvalidStateError');
    if (!this._s.indexes[name]) throw dom('The specified index was not found.', 'NotFoundError');
    delete this._s.indexes[name]; delete this._ix[name];
    persist(this._tx.db._model.name, { t: 'unindex', s: this._s.name, n: name });
  };
  // cursors: a request that is delivered once per record, see makeCursorRequest below
  StoreHandle.prototype._cursor = function (q, dir, keyOnly) {
    var r = normRange(q), s = this._s;
    var entries = s.records.filter(function (rec) { return inRange(r, rec.key); }).map(function (rec) { return { ikey: rec.key, pkey: rec.key, value: rec.value }; });
    return makeCursorRequest(this, this._tx, entries, keyOnly, dir || 'next');
  };
  StoreHandle.prototype.openCursor = function (q, dir) { return this._cursor(q, dir, false); };
  StoreHandle.prototype.openKeyCursor = function (q, dir) { return this._cursor(q, dir, true); };

  function IndexHandle(sh, ix) {
    this._sh = sh; this._ix = ix; this.name = ix.name; this.objectStore = sh;
    Object.defineProperty(this, 'keyPath', { get: function () { return ix.keyPath; } });
    Object.defineProperty(this, 'unique', { get: function () { return ix.unique; } });
    Object.defineProperty(this, 'multiEntry', { get: function () { return ix.multiEntry; } });
  }
  IndexHandle.prototype._entries = function (q, dir) {
    var r = normRange(q), s = this._sh._s, ix = this._ix;
    return s.indexEntries(ix).filter(function (e) { return inRange(r, e.ikey); });
  };
  IndexHandle.prototype.get = function (q) {
    var self = this;
    if (q === undefined) throw dom('The parameter is not a valid key.', 'DataError');
    return this._sh._tx._enqueue(new Request(this, this._sh._tx), function () { var e = self._entries(q)[0]; return e ? clone(e.value) : undefined; });
  };
  IndexHandle.prototype.getKey = function (q) {
    var self = this;
    if (q === undefined) throw dom('The parameter is not a valid key.', 'DataError');
    return this._sh._tx._enqueue(new Request(this, this._sh._tx), function () { var e = self._entries(q)[0]; return e ? clone(e.pkey) : undefined; });
  };
  IndexHandle.prototype.getAll = function (q, count) {
    var self = this;
    return this._sh._tx._enqueue(new Request(this, this._sh._tx), function () {
      var e = self._entries(q); if (count !== undefined) e = e.slice(0, count); return e.map(function (x) { return clone(x.value); });
    });
  };
  IndexHandle.prototype.getAllKeys = function (q, count) {
    var self = this;
    return this._sh._tx._enqueue(new Request(this, this._sh._tx), function () {
      var e = self._entries(q); if (count !== undefined) e = e.slice(0, count); return e.map(function (x) { return clone(x.pkey); });
    });
  };
  IndexHandle.prototype.count = function (q) {
    var self = this;
    return this._sh._tx._enqueue(new Request(this, this._sh._tx), function () { return self._entries(q).length; });
  };
  IndexHandle.prototype._cursor = function (q, dir, keyOnly) {
    return makeCursorRequest(this, this._sh._tx, this._entries(q), keyOnly, dir || 'next');
  };
  IndexHandle.prototype.openCursor = function (q, dir) { return this._cursor(q, dir, false); };
  IndexHandle.prototype.openKeyCursor = function (q, dir) { return this._cursor(q, dir, true); };

  // A cursor request is delivered once per record: the first delivery is the open itself, then one per continue().
  function makeCursorRequest(source, tx, entries, keyOnly, dir) {
    var req = new Request(source, tx);
    if (dir === 'prev' || dir === 'prevunique') entries = entries.slice().reverse();
    if (dir === 'nextunique' || dir === 'prevunique') {
      var u = []; entries.forEach(function (e) { if (!u.length || cmp(u[u.length - 1].ikey, e.ikey) !== 0) u.push(e); }); entries = u;
    }
    var cursor = { source: source, direction: dir, key: undefined, primaryKey: undefined, value: undefined, request: req };
    var i = -1, canContinue = false;
    // set true at DELIVERY time, so a second continue() inside the same callback is refused like a real cursor does
    req._beforeSuccess = function () { canContinue = !!req.result; };
    function load() {
      i++;
      if (i >= entries.length) return null;
      var e = entries[i];
      cursor.key = clone(e.ikey); cursor.primaryKey = clone(e.pkey);
      if (!keyOnly) cursor.value = clone(e.value);
      return cursor;
    }
    function advance(n, target) {
      if (!canContinue) throw dom('The cursor is being iterated or has iterated past its end.', 'InvalidStateError');
      canContinue = false;
      tx._enqueue(req, function () {
        var c = null;
        for (var s = 0; s < (n || 1); s++) c = load();
        if (target !== undefined) { while (c && ((dir === 'prev' || dir === 'prevunique') ? cmp(c.key, target) > 0 : cmp(c.key, target) < 0)) c = load(); }
        return c;
      });
    }
    cursor['continue'] = function (key) { advance(1, key); };
    cursor.advance = function (n) { if (!(n > 0)) throw new TypeError('advance count must be positive'); advance(n); };
    cursor.update = function (v) { var st = source._s || source._sh._s; return new StoreHandle(st, tx).put(v, st.keyPath === null ? cursor.primaryKey : undefined); };
    cursor['delete'] = function () { var st = source._s || source._sh._s; return new StoreHandle(st, tx)['delete'](cursor.primaryKey); };
    tx._enqueue(req, function () { return load(); });      // the first delivery is the open itself
    return req;
  }

  // ---------- connections ----------
  function Connection(model) {
    Emitter.call(this);
    this._model = model; this.name = model.name; this._closed = false; this._upgradeTx = null;
    var self = this;
    Object.defineProperty(this, 'version', { get: function () { return model.version; } });
    Object.defineProperty(this, 'objectStoreNames', { get: function () {
      var a = Object.keys(model.stores).sort(); a.contains = function (n) { return a.indexOf(n) !== -1; }; a.item = function (i) { return a[i] === undefined ? null : a[i]; }; return a; } });
  }
  Connection.prototype = Object.create(Emitter.prototype);
  Connection.prototype.close = function () { this._closed = true; };
  Connection.prototype.transaction = function (names, mode) {
    if (this._closed) throw dom('The database connection is closing.', 'InvalidStateError');
    if (this._upgradeTx && !this._upgradeTx._done) throw dom('A version change transaction is running.', 'InvalidStateError');
    names = typeof names === 'string' ? [names] : Array.prototype.slice.call(names);
    if (!names.length) throw dom('The storeNames parameter is empty.', 'InvalidAccessError');
    var self = this;
    names.forEach(function (n) { if (!self._model.stores[n]) throw dom('One of the specified object stores was not found.', 'NotFoundError'); });
    mode = mode || 'readonly';
    if (mode !== 'readonly' && mode !== 'readwrite') throw new TypeError('invalid transaction mode');
    return new Transaction(this, names, mode);
  };
  Connection.prototype.createObjectStore = function (name, opts) {
    var tx = this._upgradeTx;
    if (!tx || tx._done) throw dom('The database is not running a version change transaction.', 'InvalidStateError');
    if (this._model.stores[name]) throw dom('An object store with the specified name already exists.', 'ConstraintError');
    opts = opts || {};
    if (opts.autoIncrement && (opts.keyPath === '' || Array.isArray(opts.keyPath))) throw dom('autoIncrement cannot be used with an empty or array key path.', 'InvalidAccessError');
    var s = new Store(name, opts);
    this._model.stores[name] = s;
    tx.objectStoreNames.push(name);
    persist(this._model.name, { t: 'store', s: name, schema: s.schema() });
    return tx.objectStore(name);
  };
  Connection.prototype.deleteObjectStore = function (name) {
    var tx = this._upgradeTx;
    if (!tx || tx._done) throw dom('The database is not running a version change transaction.', 'InvalidStateError');
    if (!this._model.stores[name]) throw dom('The specified object store was not found.', 'NotFoundError');
    delete this._model.stores[name];
    tx.objectStoreNames = tx.objectStoreNames.filter(function (n) { return n !== name; }); delete tx._handles[name];
    persist(this._model.name, { t: 'unstore', s: name });
  };

  // ---------- the factory ----------
  function loadModel(name) {
    if (models[name]) return Promise.resolve(models[name]);
    return keo.call('idb.load', { name: name }, 60000).then(function (data) {
      if (models[name]) return models[name];          // another open() got there first
      return (models[name] = data ? modelFromStored(name, data) : new DbModel(name, 0));
    });
  }

  var factory = {
    open: function (name, version) {
      if (version !== undefined && (!(version >= 1) || version !== Math.floor(version))) throw new TypeError("The version provided must be a positive integer.");
      name = String(name);
      var req = new Request(null, null);
      loadModel(name).then(function (model) {
        var old = model.version;
        var want = version === undefined ? (old || 1) : version;
        if (want < old) {
          req.readyState = 'done'; req.error = dom('The requested version (' + want + ') is less than the existing version (' + old + ').', 'VersionError');
          return void req._fire('error');
        }
        var conn = new Connection(model);
        function succeed() { req.readyState = 'done'; req.result = conn; req._fire('success'); }
        if (want === old) return Promise.resolve().then(succeed);
        // version change: run upgradeneeded inside a versionchange transaction
        var tx = new Transaction(conn, Object.keys(model.stores), 'versionchange');
        tx._holding = true;
        conn._upgradeTx = tx;
        var oldSchema = model.schema(), oldVersion = old;
        var snapshotStores = {}; Object.keys(model.stores).forEach(function (n) { snapshotStores[n] = { s: model.stores[n], records: model.stores[n].records.slice(), nextKey: model.stores[n].nextKey, ix: Object.assign({}, model.stores[n].indexes) }; });
        tx._schemaUndo = function () {
          model.stores = {}; Object.keys(snapshotStores).forEach(function (n) { var u = snapshotStores[n]; u.s.records = u.records; u.s.nextKey = u.nextKey; u.s.indexes = u.ix; model.stores[n] = u.s; });
          model.version = oldVersion;
          persist(name, { t: 'replaceAll', version: oldVersion, stores: Object.keys(model.stores).map(function (n) { var s = model.stores[n]; return { s: n, schema: s.schema(), records: s.records.map(function (r) { return [r.key, r.value]; }) }; }) });
        };
        model.version = want;
        persist(name, { t: 'version', version: want });
        req.readyState = 'done'; req.result = conn; req.transaction = tx;
        tx._onAbort = function () {
          conn._closed = true; req.error = dom('The upgrade transaction was aborted.', 'AbortError'); req.result = undefined;
          req._fire('error');
        };
        tx._onSchemaDone = function () { req.transaction = null; Promise.resolve().then(succeed); };
        req._fire('upgradeneeded', { oldVersion: oldVersion, newVersion: want });
        tx._holding = false;
        tx._maybeFinish();
      }).catch(function (e) { req.readyState = 'done'; req.error = e; req._fire('error'); });
      return req;
    },
    deleteDatabase: function (name) {
      name = String(name);
      var req = new Request(null, null);
      loadModel(name).then(function () {
        delete models[name];
        persist(name, { t: 'dropdb' });
        flush(name);                                // send it now, then wait for it (and everything before it) to land
        return chains[name] || null;
      }).then(function () {
        req.readyState = 'done'; req.result = undefined; req._fire('success', { oldVersion: 0, newVersion: null });
      }).catch(function (e) { req.readyState = 'done'; req.error = e; req._fire('error'); });
      return req;
    },
    databases: function () {
      return keo.call('idb.list', {}).then(function (rows) {
        var seen = {}; rows.forEach(function (r) { seen[r.name] = r.version; });
        Object.keys(models).forEach(function (n) { if (models[n].version) seen[n] = models[n].version; });
        return Object.keys(seen).map(function (n) { return { name: n, version: seen[n] }; });
      });
    },
    cmp: function (a, b) {
      if (!validKey(a) || !validKey(b)) throw dom('The parameter is not a valid key.', 'DataError');
      return cmp(a, b);
    }
  };

  // IDBKeyRange is a plain value class and exists without a database; fall back to a small one if the page has none.
  if (typeof window.IDBKeyRange === 'undefined') {
    var R = function (l, u, lo, uo) { this.lower = l; this.upper = u; this.lowerOpen = !!lo; this.upperOpen = !!uo; };
    R.only = function (k) { return new R(k, k, false, false); };
    R.lowerBound = function (k, o) { return new R(k, undefined, o, true); };
    R.upperBound = function (k, o) { return new R(undefined, k, true, o); };
    R.bound = function (l, u, lo, uo) { return new R(l, u, lo, uo); };
    window.IDBKeyRange = R;
  }

  try { Object.defineProperty(window, 'indexedDB', { configurable: true, get: function () { return factory; } }); } catch (e) {}
  window.keo.idbModels = models;       // for tests and debugging only
})();
