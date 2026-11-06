// keo library, SHELL side: the small objects that the runtime's own apps (Books, Music, Gallery) keep, held on THIS device, encrypted
// under the signed-in identity. On a host the same objects live on the host's server; this is their home when there is no host.
// Runs in the extension's own page; the sandboxed world reaches it only through the bridge ops in shell.js (library.*), which take
// plain data and never see the key. It is laid out like the saved worlds (keo-worlds.js) and uses the same session key.
//   IndexedDB `keo-library`: `docs`, one record per object, { id: <DID>|<objId>, did, iv, ct }; `blobs`, one record per file (a
//   picture, a track: any bytes the runtime keeps by their hash), { id: <DID>|<cid>, did, iv, ct }; `blobtotal`, the bytes one
//   identity's blobs take, { did, total }, kept in the same transaction as the blob so it cannot drift.
// A document is what the runtime calls an envelope: { objId, did, type, created, record: { cid, prevCid, payload, ... }, state, ... }.
// The shell does not read it beyond the checks below: it stores what the world sends and hands it back. AES-GCM with the identity
// and the objId as additional data, so a record cannot be moved to another identity or another slot. What is readable without the
// key: the identity's DID, the objIds (a hash, not a name), sizes and the order of writes.
// Nothing here works without a session, only the signed-in identity's own objects are reachable, and removing an identity removes
// its library (purge).
// A blob is named by the SHA-256 of its bytes (base64url, as the runtime names them on a host) and the shell checks that, so a name
// cannot be given to other bytes; the same bytes put twice are kept once. Sealed with the identity and the name as additional data.
// Limits: one document is at most MAX_DOC bytes of JSON; an identity keeps at most MAX_DOCS documents; one blob is at most MAX_BLOB
// bytes and an identity's blobs at most MAX_BLOBS_TOTAL together (a guard against a runaway app, not a quota the browser enforces).
// Not here: sync to a host, signatures (a host checks them; a local object is unsigned), a version history (a put replaces the
// previous document), listing or searching the library, reclaiming a blob that nothing refers to any more (removing an item
// leaves its blob, as the host's store does).
(function () {
  'use strict';
  var enc = new TextEncoder(), dec = new TextDecoder();
  var kd = window.keoDid;
  var DB_NAME = 'keo-library';
  var MAX_DOC = 2 * 1024 * 1024;
  var MAX_DOCS = 20000;
  var MAX_BLOB = 25 * 1024 * 1024;
  var MAX_BLOBS_TOTAL = 1024 * 1024 * 1024;
  var CID = /^[A-Za-z0-9_-]{43}$/;
  var OBJ_ID = /^[A-Za-z0-9_-]{12}$/;
  // What kind of object a document may be. The runtime's apps use these; anything else is refused so the store is not a general
  // place for the world to put arbitrary data under another name.
  var TYPES = ['folder', 'book', 'album'];

  function openDb() {
    return new Promise(function (res, rej) {
      var q = indexedDB.open(DB_NAME, 2);
      // version 1 had `docs`; version 2 adds the blob stores. Each is made only if it is not there, so an upgrade keeps what a
      // version 1 database held.
      q.onupgradeneeded = function () {
        var db = q.result, names = db.objectStoreNames;
        if (!names.contains('docs')) db.createObjectStore('docs', { keyPath: 'id' }).createIndex('did', 'did');
        if (!names.contains('blobs')) db.createObjectStore('blobs', { keyPath: 'id' }).createIndex('did', 'did');
        if (!names.contains('blobtotal')) db.createObjectStore('blobtotal', { keyPath: 'did' });
      };
      q.onsuccess = function () { res(q.result); };
      q.onerror = function () { rej(q.error); };
    });
  }
  function tx(stores, mode, fn) {
    return openDb().then(function (db) {
      return new Promise(function (res, rej) {
        var t = db.transaction(stores, mode), out;
        try { out = fn(t); } catch (e) { db.close(); return rej(e); }
        t.oncomplete = function () { db.close(); res(typeof out === 'function' ? out() : out); };
        t.onabort = t.onerror = function () { db.close(); rej(t.error || new Error('library transaction failed')); };
      });
    });
  }
  function get(t, store, key) { var r = t.objectStore(store).get(key); return function () { return r.result; }; }

  function session() {
    var s = window.keoIdentity && window.keoIdentity.sessionWorldKey();
    if (!s) throw new Error('Sign in to use the library.');
    return s;
  }
  function aad(did, objId) { return 'keo-library-doc\n' + did + '\n' + objId; }
  function idOf(did, objId) { return did + '|' + objId; }
  function objIdOf(v) {
    v = String(v == null ? '' : v);
    if (!OBJ_ID.test(v)) throw new Error('That is not a valid library id.');
    return v;
  }

  // Writes of one identity run one after another, so two puts cannot both count the documents and pass the limit together.
  var chain = Promise.resolve();
  function serial(fn) { var p = chain.then(fn); chain = p.catch(function () {}); return p; }

  // The document with that id, or null when this identity has none.
  function getDoc(args) {
    return serial(async function () {
      var s = session(), objId = objIdOf(args.objId);
      var rec = await tx(['docs'], 'readonly', function (t) { return get(t, 'docs', idOf(s.did, objId)); });
      if (!rec || rec.did !== s.did) return null;
      try { return JSON.parse(dec.decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: kd.unb64u(rec.iv), additionalData: enc.encode(aad(s.did, objId)) }, s.key, rec.ct))); }
      catch (e) { throw new Error('A library item could not be decrypted (wrong identity, or the record was changed).'); }
    });
  }
  // args: { objId, doc }. The document's own objId must be the same one, and it must belong to this identity: a local object is only
  // ever the signed-in identity's own, so a document that names another author is refused.
  function putDoc(args) {
    return serial(async function () {
      var s = session(), objId = objIdOf(args.objId), doc = args.doc;
      if (!doc || typeof doc !== 'object' || Array.isArray(doc)) throw new Error('A library item must be an object.');
      if (doc.objId !== objId) throw new Error('A library item must carry the id it is stored under.');
      if (doc.did !== s.did) throw new Error('A library item must belong to the signed-in identity.');
      if (TYPES.indexOf(doc.type) < 0) throw new Error('Not a kind of library item: ' + String(doc.type).slice(0, 40));
      var text = JSON.stringify(doc);
      if (text.length > MAX_DOC) throw new Error('A library item can be at most ' + (MAX_DOC / 1024 / 1024) + ' MB.');
      var id = idOf(s.did, objId);
      var iv = crypto.getRandomValues(new Uint8Array(12));
      var ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv, additionalData: enc.encode(aad(s.did, objId)) }, s.key, enc.encode(text)));
      var full = false;
      try {
        await tx(['docs'], 'readwrite', function (t) {
          var st = t.objectStore('docs');
          var have = st.get(id), count = st.index('did').count(IDBKeyRange.only(s.did));
          have.onsuccess = function () {
            count.onsuccess = function () {
              if (!have.result && count.result >= MAX_DOCS) { full = true; t.abort(); return; }
              st.put({ id: id, did: s.did, iv: kd.b64u(iv), ct: ct });
            };
          };
        });
      } catch (e) {
        if (full) throw new Error('The library is full: it holds at most ' + MAX_DOCS + ' items.');
        throw e;
      }
      return true;
    });
  }

  // ---- blobs ---------------------------------------------------------------------------------------------------------------
  function blobAad(did, cid) { return 'keo-library-blob\n' + did + '\n' + cid; }
  function cidOf(v) {
    v = String(v == null ? '' : v);
    if (!CID.test(v)) throw new Error('That is not a valid file id.');
    return v;
  }
  // The bytes of an ArrayBuffer or a typed array, as a Uint8Array (a message from the world arrives as one of them).
  function bytesOf(v) {
    if (ArrayBuffer.isView(v)) return new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
    if (Object.prototype.toString.call(v) === '[object ArrayBuffer]') return new Uint8Array(v);
    throw new Error('A file must be bytes.');
  }
  // args: { cid, bytes }. The cid must be the SHA-256 of the bytes.
  function putBlob(args) {
    return serial(async function () {
      var s = session(), cid = cidOf(args.cid), bytes = bytesOf(args.bytes);
      if (bytes.length > MAX_BLOB) throw new Error('A file can be at most ' + (MAX_BLOB / 1024 / 1024) + ' MB here.');
      var got = kd.b64u(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)));
      if (got !== cid) throw new Error('A file id must be the hash of its bytes.');
      var id = idOf(s.did, cid);
      var have = await tx(['blobs'], 'readonly', function (t) { return get(t, 'blobs', id); });
      if (have && have.did === s.did) return true;                // the same bytes are kept once
      var total = await tx(['blobtotal'], 'readonly', function (t) { return get(t, 'blobtotal', s.did); });
      var used = total ? total.total : 0;
      if (used + bytes.length > MAX_BLOBS_TOTAL) throw new Error('The library is full: its files can take at most ' + (MAX_BLOBS_TOTAL / 1024 / 1024 / 1024) + ' GB together.');
      var iv = crypto.getRandomValues(new Uint8Array(12));
      var ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv, additionalData: enc.encode(blobAad(s.did, cid)) }, s.key, bytes));
      await tx(['blobs', 'blobtotal'], 'readwrite', function (t) {   // the file and the running total change together or not at all
        t.objectStore('blobs').put({ id: id, did: s.did, iv: kd.b64u(iv), ct: ct });
        t.objectStore('blobtotal').put({ did: s.did, total: used + bytes.length });
      });
      return true;
    });
  }
  // The bytes (an ArrayBuffer), or null when this identity has no file with that id.
  function getBlob(args) {
    return serial(async function () {
      var s = session(), cid = cidOf(args.cid);
      var rec = await tx(['blobs'], 'readonly', function (t) { return get(t, 'blobs', idOf(s.did, cid)); });
      if (!rec || rec.did !== s.did) return null;
      try { return await crypto.subtle.decrypt({ name: 'AES-GCM', iv: kd.unb64u(rec.iv), additionalData: enc.encode(blobAad(s.did, cid)) }, s.key, rec.ct); }
      catch (e) { throw new Error('A library file could not be decrypted (wrong identity, or the record was changed).'); }
    });
  }
  // true when a file was removed. The size taken back is the sealed size less the 16-byte tag.
  function removeBlob(args) {
    return serial(async function () {
      var s = session(), cid = cidOf(args.cid), id = idOf(s.did, cid);
      var rec = await tx(['blobs'], 'readonly', function (t) { return get(t, 'blobs', id); });
      if (!rec || rec.did !== s.did) return false;
      var total = await tx(['blobtotal'], 'readonly', function (t) { return get(t, 'blobtotal', s.did); });
      var left = Math.max(0, (total ? total.total : 0) - Math.max(0, rec.ct.length - 16));
      await tx(['blobs', 'blobtotal'], 'readwrite', function (t) {
        t.objectStore('blobs').delete(id);
        t.objectStore('blobtotal').put({ did: s.did, total: left });
      });
      return true;
    });
  }

  // Removing an identity removes its library. Needs no key: the records are found by DID.
  function purge(did) {
    return serial(function () {
      return tx(['docs', 'blobs', 'blobtotal'], 'readwrite', function (t) {
        ['docs', 'blobs'].forEach(function (name) {
          var ix = t.objectStore(name).index('did').openKeyCursor(IDBKeyRange.only(did));
          ix.onsuccess = function () { var c = ix.result; if (c) { t.objectStore(name).delete(c.primaryKey); c.continue(); } };
        });
        t.objectStore('blobtotal').delete(did);
      });
    });
  }

  window.keoLibrary = { get: getDoc, put: putDoc, getBlob: getBlob, putBlob: putBlob, removeBlob: removeBlob, purge: purge };
})();
