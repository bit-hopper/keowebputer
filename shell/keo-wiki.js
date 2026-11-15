// The shell's hold on the local wiki store (keo-wikistore.js): WHERE its sealed records are kept (IndexedDB `keo-wiki`) and WHICH SESSION
// owns it. The checking and the sealing are keo-wikistore.js's; this file only gives it a disk and a lifetime. Runs in the extension's own
// page; nothing in the world can reach it (there is no bridge op yet: the code that will let the world read and write a page, W-3, decides
// what it may ask, and every edit still goes through the store's checks).
//
//   IndexedDB `keo-wiki`, one object store `records`: key `<DID> NUL <kind> NUL <id>` -> { iv, ct } (the sealed record of keo-wikistore.js).
//   The key is the only thing readable without the session key besides the sizes and the order of writes: the identity's DID (as in the
//   contacts book and the message history), the kind of record, and a hash id. Page names, authors, other identities' logs and every
//   edit's content are inside the encryption. The DID is in the key because the store's ids are hashes of a page's name, which two
//   identities on one device would share: without it the second would write over the first.
//
// LIFETIME. store() gives the store of the signed-in identity (made on first use, the same object until the session ends). When the
// session ends for any reason (sign-out, expiry, removal) reset() closes the store: what it was doing finishes, nothing more starts, and
// nothing about the identity stays in memory for the next one to sign in. purge(did) deletes every record of an identity, with no key
// (a removed identity's key is gone), and first waits for the closed store to finish so that a write already under way cannot bring
// records back after they were deleted.
//
// WHO MAY WRITE A PAGE is not decided here. Until setWriters() is given a function (the signed writer list, W-5) the store is told that
// the writers of every page are unknown, so an edit waits as pending and nothing is accepted. That is on purpose: an edit is accepted only
// when someone has said who may write the page.
(function () {
  'use strict';
  var DB_NAME = 'keo-wiki', STORE = 'records', SEP = '\u0000', MAXCH = '￿';
  var KINDS = { page: 1, version: 1, pending: 1, log: 1, meta: 1 };
  var dbPromise = null;

  function openDb() {
    if (dbPromise) return dbPromise;
    var p = new Promise(function (resolve, reject) {
      var q = indexedDB.open(DB_NAME, 1);
      q.onupgradeneeded = function () { q.result.createObjectStore(STORE); };
      q.onsuccess = function () {
        var db = q.result;
        // Another page of this origin that wants to upgrade or delete the database must not wait for this one: close, and open again next time.
        db.onversionchange = function () { db.close(); if (dbPromise === p) dbPromise = null; };
        db.onclose = function () { if (dbPromise === p) dbPromise = null; };
        resolve(db);
      };
      q.onerror = function () { reject(q.error); };
    });
    dbPromise = p;
    p.catch(function () { if (dbPromise === p) dbPromise = null; });
    return p;
  }
  // Runs fn on the object store inside one transaction; what fn returns is passed through, and a function it returns is called when the
  // transaction has completed (a request's result is only there then).
  function run(mode, fn) {
    return openDb().then(function (db) {
      return new Promise(function (resolve, reject) {
        var t = db.transaction(STORE, mode), out;
        try { out = fn(t.objectStore(STORE)); } catch (e) { try { t.abort(); } catch (e2) { /* already over */ } return reject(e); }
        t.oncomplete = function () { resolve(typeof out === 'function' ? out() : out); };
        t.onabort = t.onerror = function () { reject(t.error || new Error('The wiki store could not be written.')); };
      });
    });
  }
  function prefix(did) {
    if (typeof did !== 'string' || !did || did.indexOf(SEP) >= 0) throw new Error('The wiki store needs an identity.');
    return did + SEP;
  }
  function keyOf(did, kind, id) {
    if (!KINDS[kind]) throw new Error('The wiki store has no record kind ' + kind + '.');
    if (typeof id !== 'string' || !id) throw new Error('The wiki store needs a record id.');
    return prefix(did) + kind + SEP + id;
  }

  // The backend keo-wikistore.js asks for ({ get, put, del, ids }, all async), over one identity's part of the database.
  function backend(did) {
    prefix(did);
    return {
      get: function (kind, id) { var k = keyOf(did, kind, id); return run('readonly', function (st) { var r = st.get(k); return function () { return r.result; }; }); },
      put: function (kind, id, rec) { var k = keyOf(did, kind, id); return run('readwrite', function (st) { st.put({ iv: rec.iv, ct: rec.ct }, k); }); },
      del: function (kind, id) { var k = keyOf(did, kind, id); return run('readwrite', function (st) { st['delete'](k); }); },
      ids: function (kind) {
        var p = keyOf(did, kind, 'x').slice(0, -1);       // `<DID> NUL <kind> NUL`
        return run('readonly', function (st) { var r = st.getAllKeys(IDBKeyRange.bound(p, p + MAXCH)); return function () { return r.result.map(function (k) { return k.slice(p.length); }); }; });
      }
    };
  }

  var cur = null;                 // { did, key, store } for the signed-in identity
  var draining = Promise.resolve();
  var writersFn = null;

  function store() {
    var s = window.keoIdentity && window.keoIdentity.sessionWorldKey();
    if (!s) throw new Error('Sign in to use wiki pages.');
    if (cur && (cur.did !== s.did || cur.key !== s.key)) reset();
    if (!cur) {
      cur = { did: s.did, key: s.key, store: window.keoWikiStore.create({ backend: backend(s.did), key: s.key, did: s.did,
        writers: function (objId, parents) { return writersFn ? writersFn(objId, parents) : null; } }) };
    }
    return cur.store;
  }
  // For the code that knows who may write a page (the signed writer list, W-5): fn(objId, parents) -> the DIDs, or null when not known yet.
  // It lasts until the session ends. Not for the world.
  function setWriters(fn) { if (fn !== null && typeof fn !== 'function') throw new Error('Writers must be a function.'); writersFn = fn; }
  // The session ended: nothing of the identity stays in memory, and the store starts nothing more.
  function reset() {
    var c = cur;
    cur = null; writersFn = null;
    if (c) draining = Promise.all([draining, c.store.close().catch(function () {})]).then(function () {});
    return draining;
  }
  // Removes every record of an identity from this device. Needs no key.
  function purge(did) {
    var p = prefix(did);
    if (cur && cur.did === did) reset();
    return draining.then(function () { return run('readwrite', function (st) { st['delete'](IDBKeyRange.bound(p, p + MAXCH)); }); });
  }

  window.keoWiki = { store: store, setWriters: setWriters, reset: reset, purge: purge, backend: backend };
})();
