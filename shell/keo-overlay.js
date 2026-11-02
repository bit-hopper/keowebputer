// keo overlay store, SHELL side: files that replace the package's own files when the world starts (updates).
// One IndexedDB database, 'keo-overlay', one object store 'files': package path ('core/lively/Foo.js') -> text.
// The shell sends the whole overlay to the world in the bridge handshake; the world's shim serves those paths instead of
// the package's (world/keo-shim.js). Text only: a changed binary file needs a new package.
//
// This is storage and nothing else. It does not check a signature or a hash: only the updater, after it has verified a
// release, may call put. No bridge op reaches it, so the world cannot write here. Do not add one, and do not use this to
// keep anything the user typed.
(function () {
  'use strict';
  var DB_NAME = 'keo-overlay', STORE = 'files';
  var dbPromise = null;

  function open() {
    return dbPromise || (dbPromise = new Promise(function (resolve, reject) {
      var q = indexedDB.open(DB_NAME, 1);
      q.onupgradeneeded = function () { q.result.createObjectStore(STORE); };
      q.onsuccess = function () { resolve(q.result); };
      q.onerror = function () { reject(q.error); };
    }));
  }
  function wrap(r) { return new Promise(function (res, rej) { r.onsuccess = function () { res(r.result); }; r.onerror = function () { rej(r.error); }; }); }
  function done(tx) { return new Promise(function (res, rej) { tx.oncomplete = function () { res(); }; tx.onerror = tx.onabort = function () { rej(tx.error); }; }); }

  window.keoOverlay = {
    // every file: { path: text }
    all: function () {
      return open().then(function (db) {
        var s = db.transaction(STORE, 'readonly').objectStore(STORE), out = {};
        return Promise.all([wrap(s.getAllKeys()), wrap(s.getAll())]).then(function (r) {
          r[0].forEach(function (k, i) { out[k] = r[1][i]; });
          return out;
        });
      });
    },
    put: function (path, text) {
      if (typeof path !== 'string' || typeof text !== 'string') return Promise.reject(new Error('keoOverlay: a path and a text'));
      return open().then(function (db) { var tx = db.transaction(STORE, 'readwrite'); tx.objectStore(STORE).put(text, path); return done(tx); });
    },
    // back to the package's own files
    clear: function () {
      return open().then(function (db) { var tx = db.transaction(STORE, 'readwrite'); tx.objectStore(STORE).clear(); return done(tx); });
    }
  };
})();
