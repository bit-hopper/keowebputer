// keo saved worlds, SHELL side. A world is saved on THIS device, encrypted, under the signed-in identity; nothing here talks
// to a server. Runs in the extension's own page; the sandboxed world reaches it only through the bridge ops in shell.js
// (world.*), which take plain data and never see the key.
//
// What is stored (IndexedDB `keo-worlds`, which survives a reload and a browser restart like the identity store):
//   - `bodies`: one record per saved world, { id, did, iv, ct }. ct is AES-GCM of the world's document (the whole saved page), with the
//     identity and the record id as additional data, so a body cannot be moved to another identity or another slot.
//   - `index`: one record per identity, { did, iv, ct }. Its plaintext is { worlds: { <name>: { id, savedAt, bytes } },
//     last: <name or null> }. The NAMES of worlds are inside the encryption too, and so is which one was saved last, so what
//     is readable without the key is only the identity's DID, record ids, ciphertext sizes and the order of writes.
// The key comes from the identity module (sessionWorldKey): an HMAC output of the account secret, held non-extractable in
// memory while signed in. Nothing here works without a session, and nothing here may hand the key to the world.
//
// Not here: sync to a host, versions of a world (a save replaces the previous body), and unreadable-record repair.
(function () {
  'use strict';
  var enc = new TextEncoder(), dec = new TextDecoder();
  var kd = window.keoDid;
  var DB_NAME = 'keo-worlds';
  var MAX_BYTES = 64 * 1024 * 1024;           // one serialized world; a guard against a runaway save, not a quota

  function openDb() {
    return new Promise(function (res, rej) {
      var q = indexedDB.open(DB_NAME, 1);
      q.onupgradeneeded = function () {
        q.result.createObjectStore('index', { keyPath: 'did' });
        q.result.createObjectStore('bodies', { keyPath: 'id' }).createIndex('did', 'did');
      };
      q.onsuccess = function () { res(q.result); };
      q.onerror = function () { rej(q.error); };
    });
  }
  // fn(tx) starts requests and returns the value to resolve with once the transaction has completed.
  function tx(stores, mode, fn) {
    return openDb().then(function (db) {
      return new Promise(function (res, rej) {
        var t = db.transaction(stores, mode), out;
        try { out = fn(t); } catch (e) { db.close(); return rej(e); }
        t.oncomplete = function () { db.close(); res(typeof out === 'function' ? out() : out); };
        t.onabort = t.onerror = function () { db.close(); rej(t.error || new Error('saved-worlds transaction failed')); };
      });
    });
  }
  function get(t, store, key) { var r = t.objectStore(store).get(key); return function () { return r.result; }; }

  // ---- crypto ----------------------------------------------------------------------------------------------------------
  function session() {
    var s = window.keoIdentity && window.keoIdentity.sessionWorldKey();
    if (!s) throw new Error('Sign in to use saved worlds.');
    return s;
  }
  async function seal(key, plain, aad) {
    var iv = crypto.getRandomValues(new Uint8Array(12));
    var ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv, additionalData: enc.encode(aad) }, key, plain);
    return { iv: kd.b64u(iv), ct: new Uint8Array(ct) };
  }
  async function open(key, rec, aad) {
    try { return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: kd.unb64u(rec.iv), additionalData: enc.encode(aad) }, key, rec.ct)); }
    catch (e) { throw new Error('A saved world could not be decrypted (wrong identity, or the record was changed).'); }
  }
  function indexAad(did) { return 'keo-worlds-index\n' + did; }
  function bodyAad(did, id) { return 'keo-worlds-body\n' + did + '\n' + id; }

  async function readIndex(s) {
    var rec = await tx(['index'], 'readonly', function (t) { return get(t, 'index', s.did); });
    if (!rec) return { worlds: {}, last: null };
    return JSON.parse(dec.decode(await open(s.key, rec, indexAad(s.did))));
  }
  function cleanName(n) {
    n = String(n == null ? '' : n).replace(/\s+/g, ' ').trim().slice(0, 128);
    if (!n) throw new Error('A world needs a name.');
    return n;
  }

  // Saves and loads of one identity are applied one after another, so two saves cannot both read the same index and lose one.
  var chain = Promise.resolve();
  function serial(fn) { var p = chain.then(fn); chain = p.catch(function () {}); return p; }

  // ---- ops ---------------------------------------------------------------------------------------------------------------
  function save(args) {
    return serial(async function () {
      var s = session(), name = cleanName(args.name), doc = String(args.doc == null ? '' : args.doc);
      var bytes = enc.encode(doc);
      if (!bytes.length) throw new Error('Nothing to save.');
      if (bytes.length > MAX_BYTES) throw new Error('This world is too large to save here.');
      var index = await readIndex(s);
      var prev = index.worlds[name];
      var id = prev ? prev.id : kd.b64u(crypto.getRandomValues(new Uint8Array(16)));
      var body = await seal(s.key, bytes, bodyAad(s.did, id));
      index.worlds[name] = { id: id, savedAt: new Date().toISOString(), bytes: bytes.length };
      index.last = name;
      var idx = await seal(s.key, enc.encode(JSON.stringify(index)), indexAad(s.did));
      // body and index land together or not at all
      await tx(['bodies', 'index'], 'readwrite', function (t) {
        t.objectStore('bodies').put({ id: id, did: s.did, iv: body.iv, ct: body.ct });
        t.objectStore('index').put({ did: s.did, iv: idx.iv, ct: idx.ct });
      });
      return { name: name, savedAt: index.worlds[name].savedAt, bytes: bytes.length };
    });
  }

  function list() {
    return serial(async function () {
      var s = session(), index = await readIndex(s);
      return Object.keys(index.worlds).map(function (n) {
        return { name: n, savedAt: index.worlds[n].savedAt, bytes: index.worlds[n].bytes, last: index.last === n };
      }).sort(function (a, b) { return a.savedAt < b.savedAt ? 1 : -1; });
    });
  }

  async function readBody(s, index, name) {
    var w = index.worlds[name];
    if (!w) return null;
    var rec = await tx(['bodies'], 'readonly', function (t) { return get(t, 'bodies', w.id); });
    if (!rec || rec.did !== s.did) return null;
    return { name: name, savedAt: w.savedAt, doc: dec.decode(await open(s.key, rec, bodyAad(s.did, w.id))) };
  }
  function load(args) {
    return serial(async function () {
      var s = session(), index = await readIndex(s);
      return readBody(s, index, cleanName(args.name));
    });
  }
  // The world saved last, or null (a new identity, or one that has saved nothing).
  function last() {
    return serial(async function () {
      var s = session(), index = await readIndex(s);
      return index.last ? readBody(s, index, index.last) : null;
    });
  }
  function setLast(args) {
    return serial(async function () {
      var s = session(), index = await readIndex(s), name = cleanName(args.name);
      if (!index.worlds[name]) throw new Error('No such saved world.');
      index.last = name;
      var idx = await seal(s.key, enc.encode(JSON.stringify(index)), indexAad(s.did));
      await tx(['index'], 'readwrite', function (t) { t.objectStore('index').put({ did: s.did, iv: idx.iv, ct: idx.ct }); });
      return true;
    });
  }
  function remove(args) {
    return serial(async function () {
      var s = session(), index = await readIndex(s), name = cleanName(args.name), w = index.worlds[name];
      if (!w) return false;
      delete index.worlds[name];
      if (index.last === name) {
        var names = Object.keys(index.worlds).sort(function (a, b) { return index.worlds[a].savedAt < index.worlds[b].savedAt ? 1 : -1; });
        index.last = names[0] || null;
      }
      var idx = await seal(s.key, enc.encode(JSON.stringify(index)), indexAad(s.did));
      await tx(['bodies', 'index'], 'readwrite', function (t) {
        t.objectStore('bodies').delete(w.id);
        t.objectStore('index').put({ did: s.did, iv: idx.iv, ct: idx.ct });
      });
      return true;
    });
  }

  // Drops everything of one identity (it was removed from the device, so the key is gone for good). Needs no session.
  function purge(did) {
    return serial(function () {
      return tx(['bodies', 'index'], 'readwrite', function (t) {
        t.objectStore('index').delete(did);
        var c = t.objectStore('bodies').index('did').openKeyCursor(IDBKeyRange.only(did));
        c.onsuccess = function () { var cur = c.result; if (cur) { t.objectStore('bodies').delete(cur.primaryKey); cur.continue(); } };
      }).then(function () { return true; });
    });
  }

  window.keoWorlds = { save: save, list: list, load: load, last: last, setLast: setLast, remove: remove, purge: purge };
})();
