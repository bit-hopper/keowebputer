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
// FILES (the second kind of file, for anything too big to be one record): a file is announced (fileBegin), sent in order in chunks of
// CHUNK_BYTES (fileChunk), and finished (fileEnd); the shell holds ONE chunk at a time, seals it as it arrives and hashes it as it
// arrives (keo-sha256.js), so the file's name, the SHA-256 of all its bytes, is known only at the end and is checked there, not
// taken from the world. Each chunk is sealed with the identity, a random file id and its number as additional data, so a chunk cannot
// be moved, dropped or reordered; the sealed manifest (name, type, size, chunk count) is stored under the file's name. IndexedDB `files`
// (manifests), `chunks`, `pending` (an upload that has not finished: whatever is left of it is swept at the next upload, at purge).
// A file of the first kind (one record in `blobs`) is still read the same way: as one chunk. Files count toward the same running total
// as blobs. Not here yet: listing and search by name, moving them with "Move my data" (keo-transfer.js does NOT carry them), a limit
// that follows the browser's quota, reclaiming a file nothing refers to any more.
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
  var CHUNK_BYTES = 4 * 1024 * 1024;               // every chunk of a file but the last is exactly this long
  var MAX_UPLOADS = 2;                              // files being added at once
  var UPLOAD_IDLE_MS = 5 * 60 * 1000;               // an upload that sends nothing for this long is given up
  var MAX_NAME = 255;
  var CID = /^[A-Za-z0-9_-]{43}$/;
  var OBJ_ID = /^[A-Za-z0-9_-]{12}$/;
  // What kind of object a document may be. The runtime's apps use these; anything else is refused so the store is not a general
  // place for the world to put arbitrary data under another name.
  var TYPES = ['folder', 'book', 'album'];

  function openDb() {
    return new Promise(function (res, rej) {
      var q = indexedDB.open(DB_NAME, 3);
      // version 1 had `docs`; version 2 adds the blob stores; version 3 adds the stores for files sent in chunks. Each is made only
      // if it is not there, so an upgrade keeps what an older database held.
      q.onupgradeneeded = function () {
        var db = q.result, names = db.objectStoreNames;
        if (!names.contains('docs')) db.createObjectStore('docs', { keyPath: 'id' }).createIndex('did', 'did');
        if (!names.contains('blobs')) db.createObjectStore('blobs', { keyPath: 'id' }).createIndex('did', 'did');
        if (!names.contains('blobtotal')) db.createObjectStore('blobtotal', { keyPath: 'did' });
        if (!names.contains('files')) db.createObjectStore('files', { keyPath: 'id' }).createIndex('did', 'did');
        if (!names.contains('chunks')) { var c = db.createObjectStore('chunks', { keyPath: 'id' }); c.createIndex('did', 'did'); c.createIndex('fk', 'fk'); }
        if (!names.contains('pending')) db.createObjectStore('pending', { keyPath: 'id' }).createIndex('did', 'did');
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
  async function removeLegacy(s, cid) {
    var id = idOf(s.did, cid);
    var rec = await tx(['blobs'], 'readonly', function (t) { return get(t, 'blobs', id); });
    if (!rec || rec.did !== s.did) return false;
    var total = await tx(['blobtotal'], 'readonly', function (t) { return get(t, 'blobtotal', s.did); });
    var left = Math.max(0, (total ? total.total : 0) - Math.max(0, rec.ct.length - 16));
    await tx(['blobs', 'blobtotal'], 'readwrite', function (t) {
      t.objectStore('blobs').delete(id);
      t.objectStore('blobtotal').put({ did: s.did, total: left });
    });
    return true;
  }
  function removeBlob(args) {
    return serial(async function () { var s = session(); return removeLegacy(s, cidOf(args.cid)); });
  }

  // ---- files sent in chunks ----------------------------------------------------------------------------------------------
  var uploads = {};     // upload id -> { did, fid, name, type, size, next, got, hasher, last }. Memory only: a reload loses them.
  function chunkAad(did, fid, n) { return 'keo-library-chunk\n' + did + '\n' + fid + '\n' + n; }
  function fileAad(did, cid) { return 'keo-library-file\n' + did + '\n' + cid; }
  function randomId() { return kd.b64u(crypto.getRandomValues(new Uint8Array(16))); }
  // A name, never a path, without control characters; a name that comes to nothing is "file". Only a label: the file's identity is its hash.
  function cleanName(v) {
    var n = String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f]/g, '');
    n = n.split(/[\\/]/).pop().trim();
    return n.slice(0, MAX_NAME) || 'file';
  }
  function cleanType(v) {
    v = String(v == null ? '' : v).toLowerCase();
    return v.length <= 100 && /^[a-z0-9][a-z0-9.+-]*\/[a-z0-9][a-z0-9.+-]*$/.test(v) ? v : 'application/octet-stream';
  }
  function readTotal(did) { return tx(['blobtotal'], 'readonly', function (t) { return get(t, 'blobtotal', did); }).then(function (r) { return r ? r.total : 0; }); }
  // Removes every chunk of one file (fk = DID|file id) inside the transaction t.
  function dropChunks(t, fk) {
    var cur = t.objectStore('chunks').index('fk').openKeyCursor(IDBKeyRange.only(fk));
    cur.onsuccess = function () { var c = cur.result; if (c) { t.objectStore('chunks').delete(c.primaryKey); c.continue(); } };
  }
  // The uploads of this identity that are still going; an upload idle for too long is forgotten (its chunks are swept later).
  function liveUploads(did) {
    var now = Date.now(), out = [];
    Object.keys(uploads).forEach(function (k) { var u = uploads[k]; if (now - u.last > UPLOAD_IDLE_MS) delete uploads[k]; else if (u.did === did) out.push(u); });
    return out;
  }
  function getUpload(id, s) {
    var u = uploads[String(id)];
    if (!u || u.did !== s.did) throw new Error('That upload is not open (it may have timed out).');
    if (Date.now() - u.last > UPLOAD_IDLE_MS) { delete uploads[String(id)]; throw new Error('That upload timed out.'); }
    return u;
  }
  // Removes what an upload that never finished left behind. Only uploads that have been quiet for the idle time: another tab of the
  // same identity may be in the middle of one, and the stores are shared.
  async function sweepPending(did) {
    var cut = Date.now() - UPLOAD_IDLE_MS;
    var rows = await tx(['pending'], 'readonly', function (t) { var r = t.objectStore('pending').index('did').getAll(IDBKeyRange.only(did)); return function () { return r.result; }; });
    rows = rows.filter(function (p) { return !(p.at > cut); });
    if (!rows.length) return;
    await tx(['pending', 'chunks'], 'readwrite', function (t) { rows.forEach(function (p) { dropChunks(t, p.id); t.objectStore('pending').delete(p.id); }); });
  }
  // Opens the manifest of the file with that name, or null when this identity has no such file of this kind.
  async function openManifest(s, cid) {
    var rec = await tx(['files'], 'readonly', function (t) { return get(t, 'files', idOf(s.did, cid)); });
    if (!rec || rec.did !== s.did) return null;
    var m;
    try { m = JSON.parse(dec.decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: kd.unb64u(rec.iv), additionalData: enc.encode(fileAad(s.did, cid)) }, s.key, rec.ct))); }
    catch (e) { throw new Error('A library file could not be decrypted (wrong identity, or the record was changed).'); }
    if (!m || m.v !== 1 || m.cid !== cid || typeof m.fid !== 'string' || !(m.chunks >= 0) || !(m.size >= 0) || m.chunkBytes !== CHUNK_BYTES) throw new Error('A library file is damaged.');
    return m;
  }
  function chunkLength(m, n) { return n < m.chunks - 1 ? m.chunkBytes : m.size - n * m.chunkBytes; }

  // args: { name, type, size }. Announces a file of exactly `size` bytes. Resolves { upload, chunkBytes }.
  function fileBegin(args) {
    return serial(async function () {
      var s = session(), size = args && args.size;
      if (!(typeof size === 'number' && isFinite(size) && size >= 0 && Math.floor(size) === size)) throw new Error('A file needs its size.');
      var live = liveUploads(s.did);
      if (live.length >= MAX_UPLOADS) throw new Error('Too many files are being added at once.');
      var reserved = live.reduce(function (a, u) { return a + u.size; }, 0);
      if (await readTotal(s.did) + reserved + size > MAX_BLOBS_TOTAL) throw new Error('The library is full: its files can take at most ' + (MAX_BLOBS_TOTAL / 1024 / 1024 / 1024) + ' GB together.');
      await sweepPending(s.did);
      var fid = randomId(), up = randomId(), fk = s.did + '|' + fid;
      await tx(['pending'], 'readwrite', function (t) { t.objectStore('pending').put({ id: fk, did: s.did, at: Date.now() }); });
      uploads[up] = { did: s.did, fid: fid, name: cleanName(args.name), type: cleanType(args.type), size: size, next: 0, got: 0, hasher: window.keoSha256.create(), last: Date.now() };
      return { upload: up, chunkBytes: CHUNK_BYTES };
    });
  }
  // args: { upload, n, bytes }. The chunks arrive in order, every one but the last exactly chunkBytes long. Resolves { received }.
  function fileChunk(args) {
    return serial(async function () {
      var s = session(), u = getUpload(args.upload, s);
      if (args.n !== u.next) throw new Error('The chunks of a file must arrive in order.');
      var bytes = bytesOf(args.bytes), left = u.size - u.got;
      if (bytes.length === 0 || bytes.length > left) throw new Error('That chunk does not fit the size the file was announced with.');
      if (bytes.length !== CHUNK_BYTES && bytes.length !== left) throw new Error('Only the last chunk of a file may be short.');
      var iv = crypto.getRandomValues(new Uint8Array(12));
      var ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv, additionalData: enc.encode(chunkAad(s.did, u.fid, u.next)) }, s.key, bytes));
      var fk = s.did + '|' + u.fid;
      await tx(['chunks', 'pending'], 'readwrite', function (t) {
        t.objectStore('chunks').put({ id: fk + '|' + u.next, did: s.did, fk: fk, iv: kd.b64u(iv), ct: ct });
        t.objectStore('pending').put({ id: fk, did: s.did, at: Date.now() });      // alive: keeps another tab's sweep away
      });
      u.hasher.update(bytes);
      u.next++; u.got += bytes.length; u.last = Date.now();
      return { received: u.got };
    });
  }
  // Drops an upload and what it stored.
  async function discard(s, id, u) {
    delete uploads[id];
    var fk = s.did + '|' + u.fid;
    await tx(['chunks', 'pending'], 'readwrite', function (t) { dropChunks(t, fk); t.objectStore('pending').delete(fk); });
  }
  // args: { upload }. Checks that all of the file arrived, names it by the hash of its bytes (the world does not say what the name is)
  // and stores the manifest. The same bytes sent again are kept once. Resolves { id, size, existed }.
  function fileEnd(args) {
    return serial(async function () {
      var s = session(), id = String(args.upload), u = getUpload(id, s);
      if (u.got !== u.size) throw new Error('The file is not complete: ' + u.got + ' of ' + u.size + ' bytes arrived.');
      var cid = kd.b64u(u.hasher.digest()), key = idOf(s.did, cid), fk = s.did + '|' + u.fid;
      var have = await tx(['files', 'blobs'], 'readonly', function (t) { var a = get(t, 'files', key), b = get(t, 'blobs', key); return function () { return a() || b(); }; });
      var existed = !!(have && have.did === s.did), used = await readTotal(s.did);
      if (!existed && used + u.size > MAX_BLOBS_TOTAL) { await discard(s, id, u); throw new Error('The library is full: its files can take at most ' + (MAX_BLOBS_TOTAL / 1024 / 1024 / 1024) + ' GB together.'); }
      var rec = null;
      if (!existed) {
        var manifest = { v: 1, cid: cid, fid: u.fid, name: u.name, type: u.type, size: u.size, chunks: u.next, chunkBytes: CHUNK_BYTES, created: new Date().toISOString() };
        var iv = crypto.getRandomValues(new Uint8Array(12));
        var ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv, additionalData: enc.encode(fileAad(s.did, cid)) }, s.key, enc.encode(JSON.stringify(manifest))));
        rec = { id: key, did: s.did, iv: kd.b64u(iv), ct: ct };
      }
      await tx(['files', 'chunks', 'pending', 'blobtotal'], 'readwrite', function (t) {
        t.objectStore('pending').delete(fk);
        if (existed) { dropChunks(t, fk); return; }               // the file is already here: this copy's chunks are not needed
        t.objectStore('files').put(rec);
        t.objectStore('blobtotal').put({ did: s.did, total: used + u.size });
      });
      delete uploads[id];
      return { id: cid, size: u.size, existed: existed };
    });
  }
  // args: { upload }. Gives the upload up and removes what it stored. true.
  function fileAbort(args) {
    return serial(async function () {
      var s = session(), id = String(args.upload), u = uploads[id];
      if (!u || u.did !== s.did) return true;
      await discard(s, id, u);
      return true;
    });
  }
  // args: { id }. { id, name, type, size, chunks, chunkBytes, created, legacy } or null. A file of the first kind (one record) is
  // one chunk, with no name or type kept.
  function fileInfo(args) {
    return serial(async function () {
      var s = session(), cid = cidOf(args.id), m = await openManifest(s, cid);
      if (m) return { id: cid, name: m.name, type: m.type, size: m.size, chunks: m.chunks, chunkBytes: m.chunkBytes, created: m.created, legacy: false };
      var rec = await tx(['blobs'], 'readonly', function (t) { return get(t, 'blobs', idOf(s.did, cid)); });
      if (!rec || rec.did !== s.did) return null;
      var size = Math.max(0, rec.ct.length - 16);
      return { id: cid, name: '', type: '', size: size, chunks: size ? 1 : 0, chunkBytes: size, created: null, legacy: true };
    });
  }
  // args: { id, n }. Chunk number n of the file, as an ArrayBuffer (null when there is no such file). A chunk is opened with its own
  // position in its additional data, so a record moved or swapped is refused.
  function fileRead(args) {
    return serial(async function () {
      var s = session(), cid = cidOf(args.id), n = args.n, m = await openManifest(s, cid);
      if (!(typeof n === 'number' && Math.floor(n) === n && n >= 0)) throw new Error('A chunk number is a whole number.');
      if (!m) {
        var old = await tx(['blobs'], 'readonly', function (t) { return get(t, 'blobs', idOf(s.did, cid)); });
        if (!old || old.did !== s.did) return null;
        if (n !== 0) throw new Error('That file has no chunk ' + n + '.');
        try { return await crypto.subtle.decrypt({ name: 'AES-GCM', iv: kd.unb64u(old.iv), additionalData: enc.encode(blobAad(s.did, cid)) }, s.key, old.ct); }
        catch (e) { throw new Error('A library file could not be decrypted (wrong identity, or the record was changed).'); }
      }
      if (n >= m.chunks) throw new Error('That file has no chunk ' + n + '.');
      var rec = await tx(['chunks'], 'readonly', function (t) { return get(t, 'chunks', s.did + '|' + m.fid + '|' + n); });
      if (!rec || rec.did !== s.did) throw new Error('A library file is damaged: a chunk is missing.');
      var plain;
      try { plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: kd.unb64u(rec.iv), additionalData: enc.encode(chunkAad(s.did, m.fid, n)) }, s.key, rec.ct); }
      catch (e) { throw new Error('A library file could not be decrypted (wrong identity, or the record was changed).'); }
      if (plain.byteLength !== chunkLength(m, n)) throw new Error('A library file is damaged: a chunk has the wrong length.');
      return plain;
    });
  }
  // args: { id }. true when a file (of either kind) was removed.
  function fileRemove(args) {
    return serial(async function () {
      var s = session(), cid = cidOf(args.id), m = await openManifest(s, cid);
      if (!m) return removeLegacy(s, cid);
      var used = await readTotal(s.did), fk = s.did + '|' + m.fid;
      await tx(['files', 'chunks', 'blobtotal'], 'readwrite', function (t) {
        t.objectStore('files').delete(idOf(s.did, cid));
        dropChunks(t, fk);
        t.objectStore('blobtotal').put({ did: s.did, total: Math.max(0, used - m.size) });
      });
      return true;
    });
  }
  // The session ended: uploads that were open are gone (their chunks are swept by the next upload).
  function reset() { uploads = {}; }

  // Removing an identity removes its library. Needs no key: the records are found by DID.
  function purge(did) {
    return serial(function () {
      uploads = {};
      return tx(['docs', 'blobs', 'blobtotal', 'files', 'chunks', 'pending'], 'readwrite', function (t) {
        ['docs', 'blobs', 'files', 'chunks', 'pending'].forEach(function (name) {
          var ix = t.objectStore(name).index('did').openKeyCursor(IDBKeyRange.only(did));
          ix.onsuccess = function () { var c = ix.result; if (c) { t.objectStore(name).delete(c.primaryKey); c.continue(); } };
        });
        t.objectStore('blobtotal').delete(did);
      });
    });
  }

  // ---- moving between origins (keo-transfer.js) -------------------------------------------------------------------------
  // The signed-in identity's documents and files AS THEY ARE ON DISK: sealed under its key (identity and id as additional data), so a
  // copy is valid on another origin that holds the same identity and readable nowhere else. Nothing here decrypts. Not for anything
  // but keo-transfer.js.
  function exportSealed() {
    return serial(async function () {
      var s = session(), prefix = s.did + '|';
      var got = await tx(['docs', 'blobs'], 'readonly', function (t) {
        var d = t.objectStore('docs').index('did').getAll(IDBKeyRange.only(s.did)), b = t.objectStore('blobs').index('did').getAll(IDBKeyRange.only(s.did));
        return function () { return { docs: d.result, blobs: b.result }; };
      });
      function rec(r) { return { id: r.id.slice(prefix.length), iv: r.iv, ct: r.ct }; }
      return { did: s.did, docs: got.docs.map(rec), blobs: got.blobs.map(rec) };
    });
  }
  // Adds the documents and files of a pack made by exportSealed (for the same identity) that this identity does not have yet. Nothing
  // is overwritten. Every record is opened with this identity's key first, a document is checked as putDoc checks it, and a file must
  // still be the bytes its name is the hash of; the limits apply. All of it is written together or none of it. Returns
  // { docs: n added, blobs: n added, skippedDocs: n, skippedBlobs: n, unreadable: n }.
  function importSealed(pack) {
    return serial(async function () {
      var s = session();
      if (!pack || pack.did !== s.did) throw new Error('That data belongs to another identity.');
      var docs = pack.docs || [], blobs = pack.blobs || [];
      var haveDocs = await tx(['docs'], 'readonly', function (t) { var k = t.objectStore('docs').index('did').getAllKeys(IDBKeyRange.only(s.did)); return function () { return k.result; }; });
      var haveBlobs = await tx(['blobs'], 'readonly', function (t) { var k = t.objectStore('blobs').index('did').getAllKeys(IDBKeyRange.only(s.did)); return function () { return k.result; }; });
      var docSet = {}, blobSet = {};
      haveDocs.forEach(function (k) { docSet[k] = true; });
      haveBlobs.forEach(function (k) { blobSet[k] = true; });
      var out = { docs: 0, blobs: 0, skippedDocs: 0, skippedBlobs: 0, unreadable: 0 }, putDocs = [], putBlobs = [], addBytes = 0;
      for (var i = 0; i < docs.length; i++) {
        var r = docs[i], key = typeof r.id === 'string' && OBJ_ID.test(r.id) ? idOf(s.did, r.id) : null;
        if (!key) { out.unreadable++; continue; }
        if (docSet[key]) { out.skippedDocs++; continue; }
        try {
          var doc = JSON.parse(dec.decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: kd.unb64u(r.iv), additionalData: enc.encode(aad(s.did, r.id)) }, s.key, r.ct)));
          if (!doc || typeof doc !== 'object' || Array.isArray(doc) || doc.objId !== r.id || doc.did !== s.did || TYPES.indexOf(doc.type) < 0) throw new Error('not a library item');
          docSet[key] = true; putDocs.push({ id: key, did: s.did, iv: r.iv, ct: r.ct });
        } catch (e) { out.unreadable++; }
      }
      for (var j = 0; j < blobs.length; j++) {
        var b = blobs[j], bkey = typeof b.id === 'string' && CID.test(b.id) ? idOf(s.did, b.id) : null;
        if (!bkey) { out.unreadable++; continue; }
        if (blobSet[bkey]) { out.skippedBlobs++; continue; }
        try {
          var bytes = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: kd.unb64u(b.iv), additionalData: enc.encode(blobAad(s.did, b.id)) }, s.key, b.ct));
          if (bytes.length > MAX_BLOB || kd.b64u(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))) !== b.id) throw new Error('not that file');
          blobSet[bkey] = true; addBytes += bytes.length; putBlobs.push({ id: bkey, did: s.did, iv: b.iv, ct: b.ct });
        } catch (e) { out.unreadable++; }
      }
      var total = await tx(['blobtotal'], 'readonly', function (t) { return get(t, 'blobtotal', s.did); });
      var used = total ? total.total : 0;
      if (haveDocs.length + putDocs.length > MAX_DOCS) throw new Error('The library would be full: it holds at most ' + MAX_DOCS + ' items.');
      if (used + addBytes > MAX_BLOBS_TOTAL) throw new Error('The library would be full: its files can take at most ' + (MAX_BLOBS_TOTAL / 1024 / 1024 / 1024) + ' GB together.');
      if (putDocs.length || putBlobs.length) {
        await tx(['docs', 'blobs', 'blobtotal'], 'readwrite', function (t) {
          putDocs.forEach(function (p) { t.objectStore('docs').put(p); });
          putBlobs.forEach(function (p) { t.objectStore('blobs').put(p); });
          if (putBlobs.length) t.objectStore('blobtotal').put({ did: s.did, total: used + addBytes });
        });
      }
      out.docs = putDocs.length; out.blobs = putBlobs.length;
      return out;
    });
  }

  window.keoLibrary = { exportSealed: exportSealed, importSealed: importSealed, get: getDoc, put: putDoc, getBlob: getBlob, putBlob: putBlob, removeBlob: removeBlob,
    fileBegin: fileBegin, fileChunk: fileChunk, fileEnd: fileEnd, fileAbort: fileAbort, fileInfo: fileInfo, fileRead: fileRead, fileRemove: fileRemove,
    reset: reset, purge: purge, CHUNK_BYTES: CHUNK_BYTES };
})();
