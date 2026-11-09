// keo friends, SHELL side: the devices the signed-in identity has checked and added, kept on THIS device, encrypted under that identity.
// Runs in the extension's own page; the sandboxed world reaches it only through the bridge ops in shell.js (friend.*), which take plain
// data and never see the key. It is laid out like the message history (keo-chatlog.js) and uses the same session key:
//   IndexedDB `keo-contacts`: `book` (one record per identity, { did, iv, ct }). The plaintext is { people: { <peer DID>: { name, at, seen, devices } } },
//   AES-GCM with the identity as additional data, so a record cannot be moved to another identity. What is readable without the key:
//   the identity's DID, the size of the book and the order of writes. WHO the friends are is inside the encryption.
//
// An entry means "I compared this DID's eight words with the person and added them": it is made only by keo-friend.js, after the
// person typed matching words in the shell's own dialog. It is HALF of a friendship. The other half, that the device has added us, is
// never kept here: it is learned live on each connection (keo-friend.js, over the channel that proved the DID), so a friend who has
// since removed us cannot be taken for one from an old record. `name` is what the device called itself when it was added: text the
// other side chose, for showing and never for deciding anything.
// What this is NOT: a petname book, a list of every device ever seen, or proof of who a person is. It records a decision the person made
// by comparing words. Calls, messages and file offers are accepted only from friends (keo-p2p.js: added here AND added us).
// The book is read into memory once per session (ensure) so that the connection code can ask synchronously; every change is written
// before the caller is told, and the memory copy goes with the session (clear).
(function () {
  'use strict';
  var enc = new TextEncoder(), dec = new TextDecoder();
  var kd = window.keoDid;
  var DB_NAME = 'keo-contacts', MAX_PEOPLE = 500, MAX_NAME = 64;
  var PEER = /^did:keo:[^\s]{1,190}$/;
  var mem = null;                         // { did, people } for the signed-in identity, or null

  function openDb() {
    return new Promise(function (res, rej) {
      var q = indexedDB.open(DB_NAME, 1);
      q.onupgradeneeded = function () { q.result.createObjectStore('book', { keyPath: 'did' }); };
      q.onsuccess = function () { res(q.result); };
      q.onerror = function () { rej(q.error); };
    });
  }
  function tx(mode, fn) {
    return openDb().then(function (db) {
      return new Promise(function (res, rej) {
        var t = db.transaction(['book'], mode), out;
        try { out = fn(t.objectStore('book')); } catch (e) { db.close(); return rej(e); }
        t.oncomplete = function () { db.close(); res(typeof out === 'function' ? out() : out); };
        t.onabort = t.onerror = function () { db.close(); rej(t.error || new Error('friends transaction failed')); };
      });
    });
  }
  function session() {
    var s = window.keoIdentity && window.keoIdentity.sessionWorldKey();
    if (!s) throw new Error('Sign in to use friends.');
    return s;
  }
  function aad(did) { return 'keo-contacts-book\n' + did; }
  async function seal(key, obj, did) {
    var iv = crypto.getRandomValues(new Uint8Array(12));
    var ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv, additionalData: enc.encode(aad(did)) }, key, enc.encode(JSON.stringify(obj)));
    return { iv: kd.b64u(iv), ct: new Uint8Array(ct) };
  }
  async function open(key, rec, did) {
    try { return JSON.parse(dec.decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: kd.unb64u(rec.iv), additionalData: enc.encode(aad(did)) }, key, rec.ct))); }
    catch (e) { throw new Error('Friends could not be decrypted (wrong identity, or the record was changed).'); }
  }

  // Changes run one after another, so two cannot both start from the same book and lose one.
  var chain = Promise.resolve();
  function serial(fn) { var p = chain.then(fn); chain = p.catch(function () {}); return p; }

  function peerOf(v) {
    v = String(v == null ? '' : v);
    if (!PEER.test(v)) throw new Error('That is not a valid device identity.');
    return v;
  }
  // This view goes out through the bridge to the sandboxed world (keo-friend.js list), so it must never hold an address: the cards a friend's
  // devices sent (`devices` in the record) are read only by code in this page, through cards().
  function view(did, r) { return { did: did, name: r.name || '', at: r.at || '', seen: r.seen || '' }; }
  // Where each of this friend's devices said it can be asked to connect (keo-hello.js mergeCard), newest card first. Signed text the friend's
  // devices sent, kept so a call needs no new code swap: it can be out of date, and nothing here proves an address works. It is part of this
  // device's book only (nothing syncs the book to the person's other devices yet). NEVER pass the result to the bridge or to the world.
  function cards(did) {
    var r = isAdded(did) ? mem.people[did] : null, d = (r && r.devices) || {};
    return Object.keys(d).map(function (id) { return { deviceId: id, helpers: d[id].helpers, seq: d[id].seq, time: d[id].time }; })
      .sort(function (a, b) { return b.time - a.time; });
  }

  // Reads the book of the signed-in identity into memory (again if a different identity is signed in now).
  function ensure() {
    return serial(async function () {
      var s = session();
      if (mem && mem.did === s.did) return true;
      mem = null;
      var rec = await tx('readonly', function (st) { var r = st.get(s.did); return function () { return r.result; }; });
      var book = rec ? await open(s.key, rec, s.did) : { people: {} };
      if (!book || typeof book.people !== 'object' || !book.people) throw new Error('Friends could not be read.');
      mem = { did: s.did, people: book.people };
      return true;
    });
  }
  function need() { if (!mem) throw new Error('Friends are not loaded.'); return mem; }

  // ---- for code in THIS page (keo-p2p.js asks this on every message, so it never waits) ----------------------------------------
  function isAdded(did) { return !!(mem && Object.prototype.hasOwnProperty.call(mem.people, did)); }
  function get(did) { return isAdded(did) ? view(did, mem.people[did]) : null; }

  async function write() {
    var s = session();
    if (!mem || mem.did !== s.did) throw new Error('The session changed.');
    var x = await seal(s.key, { people: mem.people }, s.did);
    await tx('readwrite', function (st) { st.put({ did: s.did, iv: x.iv, ct: x.ct }); });
  }
  // Adds a device (the person has checked its words). Adding one that is there already keeps the first date and takes the new name.
  // Resolves the entry as saved. The memory copy changes only if the write succeeds.
  function add(did, name) {
    return serial(async function () {
      did = peerOf(did);
      var m = need(), before = m.people[did];
      if (!before && Object.keys(m.people).length >= MAX_PEOPLE) throw new Error('There are too many people in the list.');
      // Adding again keeps what the entry has learned since (the last time seen, the cards): only the name and the date are the add's own.
      var r = Object.assign({}, before, { name: String(name == null ? '' : name).slice(0, MAX_NAME) || (before && before.name) || '', at: (before && before.at) || new Date().toISOString() });
      var people = Object.assign({}, m.people), old = m.people;
      people[did] = r;
      m.people = people;
      try { await write(); } catch (e) { m.people = old; throw e; }
      return view(did, r);
    });
  }
  function list() {
    return ensure().then(function () {
      var m = need();
      return Object.keys(m.people).map(function (d) { return view(d, m.people[d]); }).sort(function (a, b) { return a.at < b.at ? 1 : a.at > b.at ? -1 : 0; });
    });
  }
  // Notes that this friend was connected at `ts` (ms): the "last seen" the toolbar popup shows. It is the time a connection to the friend
  // was last known to be up, not proof of anything. A failed write is dropped (the next one carries a newer time anyway), and a session
  // that has ended writes nothing. Resolves true if it was saved.
  function seen(did, ts) {
    return serial(async function () {
      var m = mem;
      if (!m || !m.people[did]) return false;
      var people = Object.assign({}, m.people), old = m.people;
      people[did] = Object.assign({}, m.people[did], { seen: new Date(ts).toISOString() });
      m.people = people;
      try { await write(); } catch (e) { m.people = old; return false; }
      return true;
    }).catch(function () { return false; });
  }
  // Keeps a card a friend's device sent. `card` is what keo-hello.js verifyCard resolved, and the caller has already checked it was made by
  // THIS friend (verifyCard with { did }); this refuses anyone who is not added, so a card from a stranger is never kept. Resolves
  // { changed } (false: an old or repeated card, nothing written), or throws when the write fails (the memory copy is put back).
  function setCard(did, card) {
    return serial(async function () {
      did = peerOf(did);
      var m = need(), r = m.people[did];
      if (!r) throw new Error('That device is not in the list.');
      if (!card || card.ok !== true || card.did !== did) throw new Error('That card is not from this friend.');
      var out = window.keoHello.mergeCard(r.devices, card);
      if (!out.changed) return { changed: false };
      var people = Object.assign({}, m.people), old = m.people;
      people[did] = Object.assign({}, r, { devices: out.devices });
      m.people = people;
      try { await write(); } catch (e) { m.people = old; throw e; }
      return { changed: true };
    });
  }
  // Takes a device out of the list: it is no longer a friend.
  function remove(did) {
    return serial(async function () {
      did = peerOf(did);
      var m = need();
      if (!m.people[did]) return false;
      var people = Object.assign({}, m.people), old = m.people;
      delete people[did];
      m.people = people;
      try { await write(); } catch (e) { m.people = old; throw e; }
      return true;
    });
  }
  // Removing an identity removes its friends. Needs no key: the record is found by DID.
  function purge(did) {
    if (mem && mem.did === did) mem = null;
    return serial(function () { return tx('readwrite', function (st) { st.delete(did); }); });
  }
  // The session ended: nothing about the identity stays in memory for the next one to sign in.
  function clear() { mem = null; }

  window.keoContacts = { ensure: ensure, isAdded: isAdded, get: get, add: add, seen: seen, setCard: setCard, cards: cards, list: list, remove: remove, purge: purge, clear: clear };
})();
