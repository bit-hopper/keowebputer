// keo message history, SHELL side: the conversations of the signed-in identity, kept on THIS device, encrypted under that identity.
// Runs in the extension's own page; the sandboxed world reaches it only through the bridge ops in shell.js (chat.*), which take
// plain data and never see the key. It is laid out like the saved worlds (keo-worlds.js) and uses the same session key:
//   IndexedDB `keo-chat`: `index` (one record per identity, { did, iv, ct }) and `bodies` (one per conversation, { id, did, iv, ct }).
//   The index plaintext is { threads: { <peer DID>: { id, label, lastText, lastAt, lastDir } } }, a body's is { msgs: [ { k, dir, text,
//   at } ] }, both AES-GCM with the identity (and the record id) as additional data, so a record cannot be moved to another identity
//   or slot. What is readable without the key: the identity's DID, random record ids, sizes and the order of writes. WHO the
//   conversations are with, their labels, previews and times are inside the encryption.
// Nothing here works without a session, only the signed-in identity's own conversations are reachable, and removing an identity
// removes its conversations (purge). Earlier history that the world kept in its own storage is not read or moved (no migration).
// Limits: a conversation keeps its last MAX_MSGS messages; text up to MAX_TEXT; at most MAX_THREADS conversations.
// Not here: sync, search, deleting a single message, export, the history of a conversation with nobody left to message.
(function () {
  'use strict';
  var enc = new TextEncoder(), dec = new TextDecoder();
  var kd = window.keoDid;
  var DB_NAME = 'keo-chat';
  var MAX_MSGS = 1000, MAX_TEXT = 8000, MAX_THREADS = 200, MAX_LABEL = 64, MAX_KEY = 200;
  var PEER = /^did:keo:[^\s]{1,190}$/;

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
  function tx(stores, mode, fn) {
    return openDb().then(function (db) {
      return new Promise(function (res, rej) {
        var t = db.transaction(stores, mode), out;
        try { out = fn(t); } catch (e) { db.close(); return rej(e); }
        t.oncomplete = function () { db.close(); res(typeof out === 'function' ? out() : out); };
        t.onabort = t.onerror = function () { db.close(); rej(t.error || new Error('message history transaction failed')); };
      });
    });
  }
  function get(t, store, key) { var r = t.objectStore(store).get(key); return function () { return r.result; }; }

  function session() {
    var s = window.keoIdentity && window.keoIdentity.sessionWorldKey();
    if (!s) throw new Error('Sign in to use messages.');
    return s;
  }
  async function seal(key, obj, aad) {
    var iv = crypto.getRandomValues(new Uint8Array(12));
    var ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv, additionalData: enc.encode(aad) }, key, enc.encode(JSON.stringify(obj)));
    return { iv: kd.b64u(iv), ct: new Uint8Array(ct) };
  }
  async function open(key, rec, aad) {
    try { return JSON.parse(dec.decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: kd.unb64u(rec.iv), additionalData: enc.encode(aad) }, key, rec.ct))); }
    catch (e) { throw new Error('Message history could not be decrypted (wrong identity, or the record was changed).'); }
  }
  function indexAad(did) { return 'keo-chat-index\n' + did; }
  function bodyAad(did, id) { return 'keo-chat-body\n' + did + '\n' + id; }
  async function readIndex(s) {
    var rec = await tx(['index'], 'readonly', function (t) { return get(t, 'index', s.did); });
    return rec ? open(s.key, rec, indexAad(s.did)) : { threads: {} };
  }
  async function readBody(s, id) {
    var rec = await tx(['bodies'], 'readonly', function (t) { return get(t, 'bodies', id); });
    if (!rec || rec.did !== s.did) return { msgs: [] };
    return open(s.key, rec, bodyAad(s.did, id));
  }

  // Appends and reads of one identity run one after another, so two appends cannot both read the same body and lose one.
  var chain = Promise.resolve();
  function serial(fn) { var p = chain.then(fn); chain = p.catch(function () {}); return p; }

  function peerOf(v) {
    v = String(v == null ? '' : v);
    if (!PEER.test(v)) throw new Error('That is not a device identity.');
    return v;
  }

  // ---- ops ---------------------------------------------------------------------------------------------------------------
  // args: { peerDid, label, k, dir: 'in' | 'out', text, at (ISO) }. `k` names the message, so one that is added twice is kept once.
  function append(args) {
    return serial(async function () {
      var s = session(), peer = peerOf(args.peerDid), text = String(args.text == null ? '' : args.text);
      var k = String(args.k == null ? '' : args.k), dir = args.dir, label = String(args.label == null ? '' : args.label).slice(0, MAX_LABEL);
      var at = String(args.at || ''), when = Date.parse(at);
      if (!k || k.length > MAX_KEY) throw new Error('A message needs a name.');
      if (dir !== 'in' && dir !== 'out') throw new Error('A message is either in or out.');
      if (!text.length || text.length > MAX_TEXT) throw new Error('A message is 1 to ' + MAX_TEXT + ' characters.');
      if (isNaN(when)) throw new Error('A message needs a time.');
      var index = await readIndex(s), th = index.threads[peer];
      if (!th) {
        if (Object.keys(index.threads).length >= MAX_THREADS) throw new Error('There are too many conversations.');
        th = index.threads[peer] = { id: kd.b64u(crypto.getRandomValues(new Uint8Array(16))) };
      }
      var body = await readBody(s, th.id);
      if (body.msgs.some(function (m) { return m.k === k; })) return { added: false };
      body.msgs.push({ k: k, dir: dir, text: text, at: new Date(when).toISOString() });
      body.msgs.sort(function (a, b) { return a.at < b.at ? -1 : a.at > b.at ? 1 : 0; });
      if (body.msgs.length > MAX_MSGS) body.msgs = body.msgs.slice(body.msgs.length - MAX_MSGS);
      var last = body.msgs[body.msgs.length - 1];
      th.label = label || th.label || ''; th.lastText = last.text.slice(0, 200); th.lastAt = last.at; th.lastDir = last.dir;
      var b = await seal(s.key, body, bodyAad(s.did, th.id)), x = await seal(s.key, index, indexAad(s.did));
      await tx(['bodies', 'index'], 'readwrite', function (t) {          // the conversation and the list change together or not at all
        t.objectStore('bodies').put({ id: th.id, did: s.did, iv: b.iv, ct: b.ct });
        t.objectStore('index').put({ did: s.did, iv: x.iv, ct: x.ct });
      });
      return { added: true };
    });
  }
  // The conversation with one device, oldest first: [{ k, dir, text, at }].
  function thread(args) {
    return serial(async function () {
      var s = session(), peer = peerOf(args.peerDid), index = await readIndex(s), th = index.threads[peer];
      return th ? (await readBody(s, th.id)).msgs : [];
    });
  }
  // The list of conversations, latest first: [{ peerDid, label, lastText, lastAt, lastDir }].
  function threads() {
    return serial(async function () {
      var index = await readIndex(session());
      return Object.keys(index.threads).map(function (d) {
        var t = index.threads[d];
        return { peerDid: d, label: t.label || '', lastText: t.lastText || '', lastAt: t.lastAt || '', lastDir: t.lastDir || 'in' };
      }).sort(function (a, b) { return a.lastAt < b.lastAt ? 1 : -1; });
    });
  }
  function remove(args) {
    return serial(async function () {
      var s = session(), peer = peerOf(args.peerDid), index = await readIndex(s), th = index.threads[peer];
      if (!th) return false;
      delete index.threads[peer];
      var x = await seal(s.key, index, indexAad(s.did));
      await tx(['bodies', 'index'], 'readwrite', function (t) {
        t.objectStore('bodies').delete(th.id);
        t.objectStore('index').put({ did: s.did, iv: x.iv, ct: x.ct });
      });
      return true;
    });
  }
  // Removing an identity removes its conversations. Needs no key: the records are found by DID.
  function purge(did) {
    return serial(function () {
      return tx(['bodies', 'index'], 'readwrite', function (t) {
        t.objectStore('index').delete(did);
        var ix = t.objectStore('bodies').index('did').openKeyCursor(IDBKeyRange.only(did));
        ix.onsuccess = function () { var c = ix.result; if (c) { t.objectStore('bodies').delete(c.primaryKey); c.continue(); } };
      });
    });
  }

  window.keoChatLog = { append: append, thread: thread, threads: threads, remove: remove, purge: purge };
})();
