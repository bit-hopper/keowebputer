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
// bytes. How much ALL the files of an identity may take together is what the browser says it has room for (navigator.storage.estimate:
// the quota less what is in use, less a reserve kept for worlds and chats), asked each time a file is announced; only when the browser
// gives no answer does the old fixed figure (FALLBACK_TOTAL) stand in. Measured on one machine: about 10 GiB, counted exactly.
// FILES (the second kind of file, for anything too big to be one record): a file is announced (fileBegin), sent in order in chunks of
// CHUNK_BYTES (fileChunk), and finished (fileEnd); the shell holds ONE chunk at a time, seals it as it arrives and hashes it as it
// arrives (keo-sha256.js), so the file's name, the SHA-256 of all its bytes, is known only at the end and is checked there, not
// taken from the world. Each chunk is sealed with the identity, a random file id and its number as additional data, so a chunk cannot
// be moved, dropped or reordered; the sealed manifest (name, type, size, chunk count) is stored under the file's name. IndexedDB `files`
// (manifests), `chunks`, `pending` (an upload that has not finished: whatever is left of it is swept at the next upload, at purge).
// A file of the first kind (one record in `blobs`) is still read the same way: as one chunk. Files count toward the same running total
// as blobs. A search by name opens the manifests as it goes (fileSearch). They move with "Move my data" one chunk at a time
// (exportFileList, exportFileChunk, importFile: for keo-transfer.js only). `space` says how much the files take and how much room is
// left (the sandboxed world cannot ask the browser itself: its storage estimate is not available there). Not here yet: reclaiming a
// file nothing refers to any more.
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
  var FALLBACK_TOTAL = 1024 * 1024 * 1024;         // the files' total limit ONLY when the browser does not report its room
  var RESERVE_MAX = 256 * 1024 * 1024;              // room kept back from files for saved worlds, chats and the database's own overhead,
  var RESERVE_FRACTION = 0.1;                       // or this part of the quota when that is less (a small quota keeps a small reserve)
  var CHUNK_BYTES = 4 * 1024 * 1024;               // every chunk of a file but the last is exactly this long
  var MAX_UPLOADS = 2;                              // files being added at once
  var UPLOAD_IDLE_MS = 5 * 60 * 1000;               // an upload that sends nothing for this long is given up
  var MAX_NAME = 255;
  var MAX_QUERY = 200, MAX_TERMS = 8, MAX_RESULTS = 200, DEFAULT_RESULTS = 50;
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
  // A write the browser refused for lack of room says so in one sentence the person can read, whichever write it was.
  function friendly(e) {
    if (e && e.name === 'QuotaExceededError') return new Error('The library is full: this browser has no room left to keep more.');
    return e;
  }
  function tx(stores, mode, fn) {
    return openDb().then(function (db) {
      return new Promise(function (res, rej) {
        var t = db.transaction(stores, mode), out;
        try { out = fn(t); } catch (e) { db.close(); return rej(friendly(e)); }
        t.oncomplete = function () { db.close(); res(typeof out === 'function' ? out() : out); };
        t.onabort = t.onerror = function () { db.close(); rej(friendly(t.error) || new Error('library transaction failed')); };
      });
    });
  }
  // ---- room ---------------------------------------------------------------------------------------------------------------
  // What the browser says this origin may still keep: { quota, usage, reserve, free } in bytes (free = quota - usage - reserve, never
  // below 0), or null when it does not say (no estimate in this context, a failed or nonsensical answer). The estimate counts every
  // store of the origin, not only the library, which is why the reserve is held back.
  async function browserRoom() {
    try {
      if (!navigator.storage || typeof navigator.storage.estimate !== 'function') return null;
      var e = await navigator.storage.estimate();
      if (!e || !(e.quota > 0) || !(e.usage >= 0) || !isFinite(e.quota) || !isFinite(e.usage)) return null;
      var reserve = Math.min(RESERVE_MAX, Math.floor(e.quota * RESERVE_FRACTION));
      return { quota: e.quota, usage: e.usage, reserve: reserve, free: Math.max(0, e.quota - e.usage - reserve) };
    } catch (x) { return null; }
  }
  // Sizes for sentences the person reads: 1024-based, rounded DOWN to one decimal for room (so the sentence never promises more than
  // there is) and UP for a size asked for.
  function sizeText(n, up) {
    var u = ['bytes', 'KB', 'MB', 'GB', 'TB'], i = 0, v = n;
    while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
    if (i === 0) return Math.round(v) + (Math.round(v) === 1 ? ' byte' : ' bytes');
    var r = (up ? Math.ceil(v * 10) : Math.floor(v * 10)) / 10;
    return (r % 1 === 0 ? r.toFixed(0) : r.toFixed(1)) + ' ' + u[i];
  }
  // Throws a sentence when `size` more bytes of files would not fit. `spokenFor` is room already promised to uploads that are still
  // going (their unsent bytes: the browser's estimate does not count those yet). `used` is what the identity's files already take: only
  // needed for the old fixed limit that stands in when the browser gives no answer. `would` picks the wording ("The library would be
  // full" is for data being added from a file, "is full" for a file being added now).
  async function checkRoom(size, spokenFor, used, would) {
    var room = await browserRoom(), lead = would ? 'The library would be full' : 'The library is full';
    if (room) {
      var left = Math.max(0, room.free - spokenFor);
      if (size <= left) return;
      throw new Error(lead + ': ' + (left > 0 ? 'this browser has room for ' + sizeText(left) + ' more and ' : 'this browser has no room left and ') + (would ? 'the data needs ' : 'this file needs ') + sizeText(size, true) + '.');
    }
    if (used + spokenFor + size > FALLBACK_TOTAL) throw new Error(lead + ': its files can take at most ' + sizeText(FALLBACK_TOTAL) + ' together.');
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
      await checkRoom(bytes.length, remainingOfUploads(s.did), used);
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
  // What the uploads still going have announced but not yet stored: room that is already spoken for, though the browser's estimate
  // does not count it yet.
  function remainingOfUploads(did) {
    return liveUploads(did).reduce(function (a, u) { return a + (u.size - u.got); }, 0);
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
  // Opens one stored manifest record (of the identity in s) for the file named cid.
  async function openRecord(s, rec, cid) {
    var m;
    try { m = JSON.parse(dec.decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: kd.unb64u(rec.iv), additionalData: enc.encode(fileAad(s.did, cid)) }, s.key, rec.ct))); }
    catch (e) { throw new Error('A library file could not be decrypted (wrong identity, or the record was changed).'); }
    if (!m || m.v !== 1 || m.cid !== cid || !(m.chunks >= 0) || !(m.size >= 0) || m.chunkBytes !== CHUNK_BYTES
      || m.chunks !== Math.ceil(m.size / m.chunkBytes)) throw new Error('A library file is damaged.');
    if (m.kind === 'path') {
      // A file kept where it lies: no chunks of its own, a grant for the desktop app, and the hash of every chunk as it was when added.
      if (!m.point || typeof m.point.path !== 'string' || typeof m.point.mac !== 'string' || !Array.isArray(m.hashes) || m.hashes.length !== m.chunks
        || !m.hashes.every(function (h) { return typeof h === 'string' && h.length === 43; })) throw new Error('A library file is damaged.');
    } else if (typeof m.fid !== 'string') throw new Error('A library file is damaged.');
    return m;
  }
  // Opens the manifest of the file with that name, or null when this identity has no such file of this kind.
  async function openManifest(s, cid) {
    var rec = await tx(['files'], 'readonly', function (t) { return get(t, 'files', idOf(s.did, cid)); });
    if (!rec || rec.did !== s.did) return null;
    return openRecord(s, rec, cid);
  }
  function chunkLength(m, n) { return n < m.chunks - 1 ? m.chunkBytes : m.size - n * m.chunkBytes; }

  // args: { name, type, size }. Announces a file of exactly `size` bytes. Resolves { upload, chunkBytes }.
  function fileBegin(args) {
    return serial(async function () {
      var s = session(), size = args && args.size;
      if (!(typeof size === 'number' && isFinite(size) && size >= 0 && Math.floor(size) === size)) throw new Error('A file needs its size.');
      var live = liveUploads(s.did);
      if (live.length >= MAX_UPLOADS) throw new Error('Too many files are being added at once.');
      // What the live uploads have yet to send is spoken for (what they have sent is already in the browser's estimate); the old fixed
      // limit counts the running total, so it is given what they have sent as well.
      await checkRoom(size, remainingOfUploads(s.did), await readTotal(s.did) + live.reduce(function (a, u) { return a + u.got; }, 0));
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
      // A copy of bytes that were only kept where they lie replaces that record: the copy cannot be moved away or changed under it.
      if (existed && have.iv && have.ct) { try { if ((await openRecord(s, have, cid)).kind === 'path') existed = false; } catch (e) { /* kept as it is */ } }
      // No room check here: the room was checked when the file was announced (with the other uploads' unsent bytes counted), and the
      // chunks are already stored, so a browser that ran out of room refused one of them with the sentence from friendly().
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
      if (m && m.kind === 'path') return { id: cid, name: m.name, type: m.type, size: m.size, chunks: m.chunks, chunkBytes: m.chunkBytes, created: m.created, legacy: false, pointed: true, state: await pointState(m) };
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
      if (m.kind === 'path') return readPointed(m, n);
      var rec = await tx(['chunks'], 'readonly', function (t) { return get(t, 'chunks', s.did + '|' + m.fid + '|' + n); });
      if (!rec || rec.did !== s.did) throw new Error('A library file is damaged: a chunk is missing.');
      var plain;
      try { plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: kd.unb64u(rec.iv), additionalData: enc.encode(chunkAad(s.did, m.fid, n)) }, s.key, rec.ct); }
      catch (e) { throw new Error('A library file could not be decrypted (wrong identity, or the record was changed).'); }
      if (plain.byteLength !== chunkLength(m, n)) throw new Error('A library file is damaged: a chunk has the wrong length.');
      return plain;
    });
  }
  // Search by name (and, optionally, by kind of file). A name lives only in the sealed manifest, and a manifest is a few hundred bytes,
  // so a search opens them as it goes instead of keeping a second, readable index of names that would have to be kept in step and
  // protected. Files of the older single-record kind have no name and are not found.
  function fold(v) { return String(v == null ? '' : v).normalize('NFC').toLowerCase(); }
  // args: { query, type, limit, offset }. query: words that must ALL appear in the name, in any case ('' matches every file);
  // type: a media type or the start of one ('image/', 'application/pdf'); newest first. Resolves
  // { items: [{ id, name, type, size, created }], total (all matches), unreadable (records that could not be opened and were skipped) }.
  function fileSearch(args) {
    return serial(async function () {
      var s = session(); args = args || {};
      var q = fold(args.query).trim();
      if (q.length > MAX_QUERY) throw new Error('A search can be at most ' + MAX_QUERY + ' characters.');
      var terms = q ? q.split(/\s+/) : [];
      if (terms.length > MAX_TERMS) throw new Error('A search can have at most ' + MAX_TERMS + ' words.');
      var type = fold(args.type).trim();
      if (type.length > 100) throw new Error('That is not a kind of file.');
      var limit = typeof args.limit === 'number' && Math.floor(args.limit) === args.limit && args.limit >= 1 ? Math.min(args.limit, MAX_RESULTS) : DEFAULT_RESULTS;
      var offset = typeof args.offset === 'number' && Math.floor(args.offset) === args.offset && args.offset >= 0 ? args.offset : 0;
      var recs = await tx(['files'], 'readonly', function (t) { var r = t.objectStore('files').index('did').getAll(IDBKeyRange.only(s.did)); return function () { return r.result; }; });
      var found = [], unreadable = 0, prefix = s.did + '|';
      for (var i = 0; i < recs.length; i++) {
        var rec = recs[i], cid = String(rec.id).slice(prefix.length), m;
        try { m = await openRecord(s, rec, cid); } catch (e) { unreadable++; continue; }
        var name = fold(m.name);
        if (type && String(m.type).indexOf(type) !== 0) continue;
        if (terms.some(function (w) { return name.indexOf(w) < 0; })) continue;
        found.push(m.kind === 'path' ? { id: cid, name: m.name, type: m.type, size: m.size, created: m.created, pointed: true } : { id: cid, name: m.name, type: m.type, size: m.size, created: m.created });
      }
      found.sort(function (a, b) { return a.created < b.created ? 1 : a.created > b.created ? -1 : a.name < b.name ? -1 : a.name > b.name ? 1 : 0; });
      return { items: found.slice(offset, offset + limit), total: found.length, unreadable: unreadable };
    });
  }

  // args: { id }. true when a file (of either kind) was removed.
  function fileRemove(args) {
    return serial(async function () {
      var s = session(), cid = cidOf(args.id), m = await openManifest(s, cid);
      if (!m) return removeLegacy(s, cid);
      // A file kept where it lies has nothing of its own to take back: only the record goes, never the file on the computer.
      if (m.kind === 'path') { await tx(['files'], 'readwrite', function (t) { t.objectStore('files').delete(idOf(s.did, cid)); }); return true; }
      var used = await readTotal(s.did), fk = s.did + '|' + m.fid;
      await tx(['files', 'chunks', 'blobtotal'], 'readwrite', function (t) {
        t.objectStore('files').delete(idOf(s.did, cid));
        dropChunks(t, fk);
        t.objectStore('blobtotal').put({ did: s.did, total: Math.max(0, used - m.size) });
      });
      return true;
    });
  }
  // ---- files kept where they lie (desktop app only; keo-point.js makes them) ----------------------------------------------------
  // The record is sealed like any manifest (name, type, size, the file's SHA-256 name) and adds a grant for the app (keo-host.js, the
  // app's lib/point.js) and the SHA-256 of every chunk as it was when the file was added. A read asks the app for that range and checks
  // it against the sealed hash, so a file that was edited, cut short or swapped is never shown as if it were the one that was added:
  // the person is told instead. Nothing is copied, so nothing counts toward the room the library may take.
  var HOST_WORDS = {
    missing: ' is not where it was when it was added. Put it back there, or add it again from where it is now.',
    denied: ' cannot be opened now: this computer will not let keo read it.',
    notfile: ' is not a file any more. Add it again from where it is now.',
    refused: ' was added on another computer or app and cannot be read here.',
    unreadable: ' could not be read.'
  };
  function pointedSentence(m, code) { return '"' + m.name + '"' + (HOST_WORDS[code] || HOST_WORDS.unreadable); }
  function changedSentence(m) { return '"' + m.name + '" has changed since it was added, so keo will not show it. Put the original back, or add the changed file as a new one.'; }
  // What the file on the computer looks like now: 'ok', 'missing', 'changed' (another size), 'touched' (same size, another time: only
  // reading it can say), 'denied', or 'away' (this page has no app to ask). Advice for a screen; a read is what decides.
  async function pointState(m) {
    if (!(window.keoHost && window.keoHost.available())) return 'away';
    var r;
    try { r = await window.keoHost.post('file', { op: 'stat', path: m.point.path, mac: m.point.mac }); } catch (e) { return 'away'; }
    if (r.error) return r.error === 'missing' || r.error === 'notfile' ? 'missing' : r.error === 'denied' ? 'denied' : 'away';
    if (r.size !== m.size) return 'changed';
    return Math.abs(r.mtimeMs - m.mtimeMs) < 1 ? 'ok' : 'touched';     // under a millisecond is a clock's rounding, not an edit
  }
  async function readPointed(m, n) {
    if (!(window.keoHost && window.keoHost.available())) throw new Error('"' + m.name + '" is kept on another computer or app and cannot be reached here.');
    var len = chunkLength(m, n), r;
    try { r = await window.keoHost.post('file', { op: 'read', path: m.point.path, mac: m.point.mac, offset: n * m.chunkBytes, length: len }); }
    catch (e) { throw new Error('"' + m.name + '" is kept on this computer, and the app could not be reached to read it.'); }
    if (r.error) throw new Error(pointedSentence(m, r.error));
    var bytes = r.bytes;
    if (!bytes || bytes.length !== len) throw new Error(changedSentence(m));
    var h = kd.b64u(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)));
    if (h !== m.hashes[n]) throw new Error(changedSentence(m));
    return bytes.buffer;
  }
  // args: { cid, name, type, size, mtimeMs, point: { path, mac }, hashes: [SHA-256 of each chunk, base64url] }: all made by keo-point.js,
  // which read the whole file through the app. For code in this page only; NOT a bridge op, the world never supplies any of it. Keeps a
  // copy if the library already has these bytes as one (resolves { existed: true, pointed: false }); a pointed record for the same bytes is
  // replaced by this one (the person pointed at the file again, e.g. after moving it). Resolves { id, existed, pointed }.
  function pointStore(args) {
    return serial(async function () {
      var s = session(), cid = cidOf(args.cid), size = args.size;
      if (!(typeof size === 'number' && isFinite(size) && size >= 0 && Math.floor(size) === size)) throw new Error('A file needs its size.');
      var count = Math.ceil(size / CHUNK_BYTES);
      if (!args.point || typeof args.point.path !== 'string' || typeof args.point.mac !== 'string' || !Array.isArray(args.hashes) || args.hashes.length !== count) throw new Error('That file could not be recorded.');
      var key = idOf(s.did, cid);
      var have = await tx(['files', 'blobs'], 'readonly', function (t) { var a = get(t, 'files', key), b = get(t, 'blobs', key); return function () { return { f: a(), b: b() }; }; });
      if (have.b && have.b.did === s.did) return { id: cid, existed: true, pointed: false };
      if (have.f && have.f.did === s.did) {
        var old = null; try { old = await openRecord(s, have.f, cid); } catch (e) { /* damaged: replaced below */ }
        if (old && old.kind !== 'path') return { id: cid, existed: true, pointed: false };
      }
      var manifest = { v: 1, kind: 'path', cid: cid, name: cleanName(args.name), type: cleanType(args.type), size: size, chunks: count, chunkBytes: CHUNK_BYTES,
        created: new Date().toISOString(), mtimeMs: Number(args.mtimeMs) || 0, point: { path: String(args.point.path), mac: String(args.point.mac) }, hashes: args.hashes.map(String) };
      var iv = crypto.getRandomValues(new Uint8Array(12));
      var ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv, additionalData: enc.encode(fileAad(s.did, cid)) }, s.key, enc.encode(JSON.stringify(manifest))));
      await openRecord(s, { iv: kd.b64u(iv), ct: ct }, cid);        // what is about to be kept must open again, or it is not kept
      await tx(['files'], 'readwrite', function (t) { t.objectStore('files').put({ id: key, did: s.did, iv: kd.b64u(iv), ct: ct }); });
      return { id: cid, existed: !!(have.f && have.f.did === s.did), pointed: true };
    });
  }

  // ---- moving files in chunks between origins (keo-transfer.js) ----------------------------------------------------------
  // The sealed manifests and chunks AS THEY ARE ON DISK, like exportSealed, one chunk at a time so a large file is never held whole.
  // Not for anything but keo-transfer.js: nothing here is a bridge op.
  // { files: [{ id, fid, chunks, size, manifest: { iv, ct } }], unreadable } for the signed-in identity. A manifest that cannot be
  // opened is counted, not listed: the person is told how many files could not be saved.
  function exportFileList() {
    return serial(async function () {
      var s = session(), prefix = s.did + '|';
      var recs = await tx(['files'], 'readonly', function (t) { var r = t.objectStore('files').index('did').getAll(IDBKeyRange.only(s.did)); return function () { return r.result; }; });
      var files = [], unreadable = 0, pointed = 0;
      for (var i = 0; i < recs.length; i++) {
        var cid = String(recs[i].id).slice(prefix.length), m;
        try { m = await openRecord(s, recs[i], cid); } catch (e) { unreadable++; continue; }
        if (m.kind === 'path') { pointed++; continue; }       // a place on THIS computer: it means nothing anywhere else
        files.push({ id: cid, fid: m.fid, chunks: m.chunks, size: m.size, manifest: { iv: recs[i].iv, ct: recs[i].ct } });
      }
      return { files: files, unreadable: unreadable, pointed: pointed };
    });
  }
  // args: { fid, n }. { iv, ct } of that chunk as stored (nothing is opened).
  function exportFileChunk(args) {
    return serial(async function () {
      var s = session(), fid = String(args.fid), n = args.n;
      if (!(typeof n === 'number' && Math.floor(n) === n && n >= 0)) throw new Error('A chunk number is a whole number.');
      var rec = await tx(['chunks'], 'readonly', function (t) { return get(t, 'chunks', s.did + '|' + fid + '|' + n); });
      if (!rec || rec.did !== s.did) throw new Error('A library file is damaged: a chunk is missing.');
      return { iv: rec.iv, ct: rec.ct };
    });
  }
  // args: { id, manifest: { iv, ct }, readChunk: async (n) => { iv, ct } }. Adds one file of a pack made by exportFileList and
  // exportFileChunk (for the same identity) that this identity does not have yet. The manifest is opened with this identity's key
  // (so a file made for another identity, or changed, is refused), each chunk is opened with its own place in its additional data, the
  // bytes are hashed as they come and must come to the file's name, and only then is the file made visible; whatever it stored
  // before that is removed if anything fails. The same bytes already here (either kind) are left alone. Resolves
  // { status: 'added' | 'skipped', size }, or throws a sentence.
  async function importFile(args) {
    var begun = await serial(async function () {
      var s = session(), cid = cidOf(args.id), man = args.manifest;
      if (!man || typeof man.iv !== 'string' || !(man.ct instanceof Uint8Array)) throw new Error('This file is damaged.');
      var m = await openRecord(s, man, cid);
      if (m.kind === 'path') throw new Error('This file is damaged.');       // a place on another computer is never carried in
      var have = await tx(['files', 'blobs'], 'readonly', function (t) { var a = get(t, 'files', idOf(s.did, cid)), b = get(t, 'blobs', idOf(s.did, cid)); return function () { return a() || b(); }; });
      if (have && have.did === s.did) return { skip: true };
      await checkRoom(m.size, remainingOfUploads(s.did), await readTotal(s.did), true);
      await sweepPending(s.did);
      var fk = s.did + '|' + m.fid;
      var clash = await tx(['chunks'], 'readonly', function (t) { var r = t.objectStore('chunks').index('fk').count(IDBKeyRange.only(fk)); return function () { return r.result; }; });
      if (clash) throw new Error('A file in this data clashes with one that is already here.');
      await tx(['pending'], 'readwrite', function (t) { t.objectStore('pending').put({ id: fk, did: s.did, at: Date.now() }); });
      return { did: s.did, m: m, cid: cid, fk: fk, man: man };
    });
    if (begun.skip) return { status: 'skipped', size: 0 };
    var hasher = window.keoSha256.create(), m = begun.m;
    try {
      for (var n = 0; n < m.chunks; n++) {
        var rec = await args.readChunk(n);
        if (!rec || typeof rec.iv !== 'string' || !(rec.ct instanceof Uint8Array)) throw new Error('This file is damaged.');
        await serial(async function () {
          var cur = session();
          if (cur.did !== begun.did) throw new Error('The signed-in identity changed.');
          var plain;
          try { plain = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: kd.unb64u(rec.iv), additionalData: enc.encode(chunkAad(cur.did, m.fid, n)) }, cur.key, rec.ct)); }
          catch (e) { throw new Error('A file in this data could not be decrypted (wrong identity, or it was changed).'); }
          if (plain.length !== chunkLength(m, n)) throw new Error('A file in this data is damaged: a chunk has the wrong length.');
          hasher.update(plain);
          await tx(['chunks', 'pending'], 'readwrite', function (t) {
            t.objectStore('chunks').put({ id: begun.fk + '|' + n, did: cur.did, fk: begun.fk, iv: rec.iv, ct: rec.ct });
            t.objectStore('pending').put({ id: begun.fk, did: cur.did, at: Date.now() });
          });
        });
      }
      return await serial(async function () {
        var cur = session();
        if (cur.did !== begun.did) throw new Error('The signed-in identity changed.');
        if (kd.b64u(hasher.digest()) !== begun.cid) throw new Error('A file in this data does not match its name.');
        var used = await readTotal(cur.did);
        await tx(['files', 'pending', 'blobtotal'], 'readwrite', function (t) {
          t.objectStore('files').put({ id: idOf(cur.did, begun.cid), did: cur.did, iv: begun.man.iv, ct: begun.man.ct });
          t.objectStore('pending').delete(begun.fk);
          t.objectStore('blobtotal').put({ did: cur.did, total: used + m.size });
        });
        return { status: 'added', size: m.size };
      });
    } catch (e) {
      await serial(function () { return tx(['chunks', 'pending'], 'readwrite', function (t) { dropChunks(t, begun.fk); t.objectStore('pending').delete(begun.fk); }); }).catch(function () {});
      throw e;
    }
  }

  // What the signed-in identity's files take (plain sizes, as counted for the old limit) and the room the browser says is left for
  // more: { files, free, quota, usage }, with free/quota/usage null when the browser gives no answer. `free` is the same number the
  // checks use (reserve already held back, other uploads' unsent bytes taken off). Read-only; for the library screens.
  function space() {
    return serial(async function () {
      var s = session(), files = await readTotal(s.did), room = await browserRoom();
      if (!room) return { files: files, free: null, quota: null, usage: null };
      return { files: files, free: Math.max(0, room.free - remainingOfUploads(s.did)), quota: room.quota, usage: room.usage };
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
      await checkRoom(addBytes, remainingOfUploads(s.did), used, true);
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
    fileBegin: fileBegin, fileChunk: fileChunk, fileEnd: fileEnd, fileAbort: fileAbort, fileInfo: fileInfo, fileRead: fileRead, fileSearch: fileSearch, fileRemove: fileRemove,
    exportFileList: exportFileList, exportFileChunk: exportFileChunk, importFile: importFile, space: space, pointStore: pointStore,
    reset: reset, purge: purge, CHUNK_BYTES: CHUNK_BYTES };
})();
