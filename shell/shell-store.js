// keo shell store: the real, persistent storage behind the world's localStorage and IndexedDB.
// Lives in the shell page (the extension's own origin), which is allowed IndexedDB; the sandboxed world is not.
// One database, 'keo-world-store', three object stores:
//   ls      key -> string                      the world's localStorage
//   meta    emulated db name -> { version, stores: { <store>: { keyPath, autoIncrement, nextKey, indexes: [...] } } }
//   records '<db>\0<store>\0<encoded key>' -> { k: <key>, v: <value> }     every record of every emulated database
// The record id is a string made from the database, the store and a type-tagged encoding of the key, so all records of
// one store share a prefix and one key range reads or clears them; the original key travels inside the value (k) because
// the world needs it back unchanged (numbers, dates, binary, arrays).
// Values are structured-cloned by IndexedDB, so CryptoKey, Blob, ArrayBuffer and friends are stored as they are.
// Everything here is promise-based; window.keoStore is the whole interface.
(function () {
  'use strict';
  var DB_NAME = 'keo-world-store', SEP = '\u0000', MAXCH = '￿';
  var dbPromise = null;

  function open() {
    return dbPromise || (dbPromise = new Promise(function (resolve, reject) {
      var q = indexedDB.open(DB_NAME, 1);
      q.onupgradeneeded = function () {
        ['ls', 'meta', 'records'].forEach(function (n) { q.result.createObjectStore(n); });
      };
      q.onsuccess = function () { resolve(q.result); };
      q.onerror = function () { reject(q.error); };
    }));
  }
  function wrap(r) { return new Promise(function (res, rej) { r.onsuccess = function () { res(r.result); }; r.onerror = function () { rej(r.error); }; }); }
  function done(tx) { return new Promise(function (res, rej) { tx.oncomplete = function () { res(); }; tx.onerror = tx.onabort = function () { rej(tx.error); }; }); }

  // Type-tagged key encoding: distinct keys of distinct types never collide ('s1' vs 'n1').
  function enc(k) {
    if (typeof k === 'number') return 'n' + (Object.is(k, -0) ? '0' : String(k));
    if (typeof k === 'string') return 's' + k;
    if (k instanceof Date) return 'd' + k.getTime();
    if (k instanceof ArrayBuffer || ArrayBuffer.isView(k)) {
      var u = k instanceof ArrayBuffer ? new Uint8Array(k) : new Uint8Array(k.buffer, k.byteOffset, k.byteLength), s = '';
      for (var i = 0; i < u.length; i++) s += String.fromCharCode(u[i]);
      return 'b' + btoa(s);
    }
    if (Array.isArray(k)) return 'a[' + k.map(function (e) { return JSON.stringify(enc(e)); }).join(',') + ']';
    throw new Error('keoStore: not a valid key');
  }
  function rid(db, store, key) { return db + SEP + store + SEP + enc(key); }
  function storeRange(db, store) { return IDBKeyRange.bound(db + SEP + store + SEP, db + SEP + store + SEP + MAXCH); }
  function dbRange(db) { return IDBKeyRange.bound(db + SEP, db + SEP + MAXCH); }

  var api = {
    // ---- localStorage ----
    lsAll: function () {
      return open().then(function (db) {
        var tx = db.transaction('ls', 'readonly'), s = tx.objectStore('ls'), out = {};
        return Promise.all([wrap(s.getAllKeys()), wrap(s.getAll())]).then(function (r) {
          r[0].forEach(function (k, i) { out[k] = r[1][i]; });
          return out;
        });
      });
    },
    lsApply: function (a) {
      return open().then(function (db) {
        var tx = db.transaction('ls', 'readwrite'), s = tx.objectStore('ls');
        if (a.op === 'set') s.put(String(a.value), String(a.key));
        else if (a.op === 'remove') s['delete'](String(a.key));
        else if (a.op === 'clear') s.clear();
        else throw new Error('keoStore.lsApply: unknown op ' + a.op);
        return done(tx);
      });
    },

    // ---- emulated IndexedDB databases ----
    idbList: function () {
      return open().then(function (db) {
        var s = db.transaction('meta', 'readonly').objectStore('meta');
        return Promise.all([wrap(s.getAllKeys()), wrap(s.getAll())]).then(function (r) {
          return r[0].map(function (k, i) { return { name: k, version: r[1][i].version }; });
        });
      });
    },
    // -> null (no such database) or { version, stores: { name: { keyPath, autoIncrement, nextKey, indexes, records: [[k, v], ...] } } }
    idbLoad: function (name) {
      return open().then(function (db) {
        var tx = db.transaction(['meta', 'records'], 'readonly');
        return wrap(tx.objectStore('meta').get(name)).then(function (meta) {
          if (!meta) return null;
          var names = Object.keys(meta.stores || {});
          return Promise.all(names.map(function (sn) { return wrap(tx.objectStore('records').getAll(storeRange(name, sn))); })).then(function (lists) {
            var out = { version: meta.version, stores: {} };
            names.forEach(function (sn, i) {
              var m = meta.stores[sn];
              out.stores[sn] = { keyPath: m.keyPath, autoIncrement: m.autoIncrement, nextKey: m.nextKey, indexes: m.indexes || [],
                records: lists[i].map(function (e) { return [e.k, e.v]; }) };
            });
            return out;
          });
        });
      });
    },
    // Apply the world's queued changes to one emulated database, in order, in one transaction.
    idbApply: function (name, ops) {
      return open().then(function (db) {
        var tx = db.transaction(['meta', 'records'], 'readwrite'), meta = tx.objectStore('meta'), rec = tx.objectStore('records');
        var finished = done(tx);
        return wrap(meta.get(name)).then(function (m) {
          m = m || { version: 0, stores: {} };
          var dropped = false, chain = Promise.resolve();
          function schemaOf(s) { return { keyPath: s.keyPath, autoIncrement: s.autoIncrement, nextKey: s.nextKey, indexes: s.indexes || [] }; }
          ops.forEach(function (op) {
            if (op.t !== 'dropdb') dropped = false;        // a database dropped and then re-created in the same batch
            switch (op.t) {
              case 'version': m.version = op.version; break;
              case 'store': m.stores[op.s] = schemaOf(op.schema); break;
              case 'unstore': delete m.stores[op.s]; rec['delete'](storeRange(name, op.s)); break;
              case 'index': { var st = m.stores[op.s]; if (st) { st.indexes = (st.indexes || []).filter(function (x) { return x.name !== op.ix.name; }).concat([op.ix]); } break; }
              case 'unindex': { var st2 = m.stores[op.s]; if (st2) st2.indexes = (st2.indexes || []).filter(function (x) { return x.name !== op.n; }); break; }
              case 'next': if (m.stores[op.s]) m.stores[op.s].nextKey = op.n; break;
              case 'put': rec.put({ k: op.k, v: op.v }, rid(name, op.s, op.k)); break;
              case 'del':
                if (op.k !== undefined) rec['delete'](rid(name, op.s, op.k));
                break;
              case 'clear': rec['delete'](storeRange(name, op.s)); break;
              case 'replace':
                m.stores[op.s] = schemaOf(op.schema);
                rec['delete'](storeRange(name, op.s));
                op.records.forEach(function (p) { rec.put({ k: p[0], v: p[1] }, rid(name, op.s, p[0])); });
                break;
              case 'replaceAll':
                rec['delete'](dbRange(name));
                m.version = op.version; m.stores = {};
                op.stores.forEach(function (s) {
                  m.stores[s.s] = schemaOf(s.schema);
                  s.records.forEach(function (p) { rec.put({ k: p[0], v: p[1] }, rid(name, s.s, p[0])); });
                });
                break;
              case 'dropdb': dropped = true; m = { version: 0, stores: {} }; meta['delete'](name); rec['delete'](dbRange(name)); break;
              default: throw new Error('keoStore.idbApply: unknown op ' + op.t);
            }
          });
          if (!dropped) meta.put(m, name);
          return finished;
        });
      });
    },
    // wipe everything the world has stored (used by "Clear local data" in the shell)
    clearAll: function () {
      return open().then(function (db) {
        var tx = db.transaction(['ls', 'meta', 'records'], 'readwrite');
        ['ls', 'meta', 'records'].forEach(function (n) { tx.objectStore(n).clear(); });
        return done(tx);
      });
    }
  };
  window.keoStore = api;
})();
