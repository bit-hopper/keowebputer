// keo library, SHELL side: the small objects that the runtime's own apps (Books, Music, Gallery) keep, held on THIS device, encrypted
// under the signed-in identity. On a host the same objects live on the host's server; this is their home when there is no host.
// Runs in the extension's own page; the sandboxed world reaches it only through the bridge ops in shell.js (library.*), which take
// plain data and never see the key. It is laid out like the saved worlds (keo-worlds.js) and uses the same session key.
//   IndexedDB `keo-library`: `docs`, one record per object, { id: <DID>|<objId>, did, iv, ct }.
// A document is what the runtime calls an envelope: { objId, did, type, created, record: { cid, prevCid, payload, ... }, state, ... }.
// The shell does not read it beyond the checks below: it stores what the world sends and hands it back. AES-GCM with the identity
// and the objId as additional data, so a record cannot be moved to another identity or another slot. What is readable without the
// key: the identity's DID, the objIds (a hash, not a name), sizes and the order of writes.
// Nothing here works without a session, only the signed-in identity's own objects are reachable, and removing an identity removes
// its library (purge).
// Limits: one document is at most MAX_DOC bytes of JSON; an identity keeps at most MAX_DOCS documents.
// Not here: files and pictures (blobs; Gallery's photos need them), sync to a host, signatures (a host checks them; a local object
// is unsigned), a version history (a put replaces the previous document), listing or searching the library.
(function () {
  'use strict';
  var enc = new TextEncoder(), dec = new TextDecoder();
  var kd = window.keoDid;
  var DB_NAME = 'keo-library';
  var MAX_DOC = 2 * 1024 * 1024;
  var MAX_DOCS = 20000;
  var OBJ_ID = /^[A-Za-z0-9_-]{12}$/;
  // What kind of object a document may be. The runtime's apps use these; anything else is refused so the store is not a general
  // place for the world to put arbitrary data under another name.
  var TYPES = ['folder', 'book', 'album'];

  function openDb() {
    return new Promise(function (res, rej) {
      var q = indexedDB.open(DB_NAME, 1);
      q.onupgradeneeded = function () {
        q.result.createObjectStore('docs', { keyPath: 'id' }).createIndex('did', 'did');
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
  // Removing an identity removes its library. Needs no key: the records are found by DID.
  function purge(did) {
    return serial(function () {
      return tx(['docs'], 'readwrite', function (t) {
        var ix = t.objectStore('docs').index('did').openKeyCursor(IDBKeyRange.only(did));
        ix.onsuccess = function () { var c = ix.result; if (c) { t.objectStore('docs').delete(c.primaryKey); c.continue(); } };
      });
    });
  }

  window.keoLibrary = { get: getDoc, put: putDoc, purge: purge };
})();
