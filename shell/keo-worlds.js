// keo saved worlds, SHELL side. A world is saved on THIS device, encrypted, under the signed-in identity; nothing here talks
// to a server. Runs in the extension's own page; the sandboxed world reaches it only through the bridge ops in shell.js
// (world.*), which take plain data and never see the key.
//
// What is stored (IndexedDB `keo-worlds`, which survives a reload and a browser restart like the identity store):
//   - `bodies`: one record per saved world, { id, did, iv, ct }. ct is AES-GCM of the world's document (the whole saved page), with the
//     identity and the record id as additional data, so a body cannot be moved to another identity or another slot.
//   - `texts`: one record per saved world, same shape, sealed the same way (its own additional data). Its plaintext is the readable
//     text of the world (keo-worldtext.js `extract`), kept so a search does not have to open every body. A world saved by an earlier
//     version has none until the first search, which makes it (`ensureText`). A body and its text are always written together.
//   - `index`: one record per identity, { did, iv, ct }. Its plaintext is { worlds: { <name>: { id, savedAt, bytes, createdAt, tags,
//     note, template?, t, fl? } }, last: <name or null>, prefs: { <key>: <value> } }. `t` says a text record exists for the world. `fl`
//     ({ at, ids }) is the list of library files the world shows, read from its body the first time `usedIn` is asked after the world
//     was saved, and read again only when `at` no longer equals the world's savedAt. `prefs` is the
//     identity's own small settings (see PREF_KEYS): they are kept here because this record is already encrypted under the
//     signed-in identity's key. The NAMES of worlds, their tags and notes are inside the encryption too, and so is which one was
//     saved last, so what is readable without the key is only the identity's DID, record ids, ciphertext sizes and the order of writes.
// The key comes from the identity module (sessionWorldKey): an HMAC output of the account secret, held non-extractable in
// memory while signed in. Nothing here works without a session, and nothing here may hand the key to the world.
//
// Not here: sync to a host, versions of a world (a save replaces the previous body), and unreadable-record repair.
(function () {
  'use strict';
  var enc = new TextEncoder(), dec = new TextDecoder();
  var kd = window.keoDid;
  var wt = window.keoWorldText;
  var DB_NAME = 'keo-worlds';
  var MAX_BYTES = 64 * 1024 * 1024;           // one serialized world; a guard against a runaway save, not a quota
  var MAX_TAGS = 16, MAX_TAG = 32, MAX_NOTE = 1000;
  // The presets a new world can start from (the runtime's "My worlds" > Create > Template). Only these names are kept with a world:
  // the world asks for one by name, and what it is shown as ("Template · Books") comes from here.
  var TEMPLATES = ['shop', 'inventory', 'gallery', 'books', 'game', 'music', 'diary'];
  // The settings an identity may keep, and what a value may be. The world asks to set them, so nothing else gets in.
  //   homeTheme  the name of the theme of the home page (the home page is rebuilt on every visit, so a theme applied to it
  //              would otherwise be lost), or null for none
  var PREF_KEYS = { homeTheme: function (v) { return v === null || (typeof v === 'string' && /^[A-Za-z0-9 _-]{1,64}$/.test(v)); },
    lanVisible: function (v) { return typeof v === 'boolean'; } };

  function openDb() {
    return new Promise(function (res, rej) {
      var q = indexedDB.open(DB_NAME, 2);
      // version 1 had `index` and `bodies`; version 2 adds `texts`. Each is created only if it is not there, so an upgrade keeps
      // everything a version 1 database held.
      q.onupgradeneeded = function () {
        var db = q.result, names = db.objectStoreNames;
        if (!names.contains('index')) db.createObjectStore('index', { keyPath: 'did' });
        if (!names.contains('bodies')) db.createObjectStore('bodies', { keyPath: 'id' }).createIndex('did', 'did');
        if (!names.contains('texts')) db.createObjectStore('texts', { keyPath: 'id' }).createIndex('did', 'did');
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
  function textAad(did, id) { return 'keo-worlds-text\n' + did + '\n' + id; }

  async function readIndex(s) {
    var rec = await tx(['index'], 'readonly', function (t) { return get(t, 'index', s.did); });
    if (!rec) return { worlds: {}, last: null };
    return JSON.parse(dec.decode(await open(s.key, rec, indexAad(s.did))));
  }
  // The index as a record ready to be put; sealed before a transaction starts (a transaction cannot wait for the crypto).
  async function sealIndex(s, index) {
    var idx = await seal(s.key, enc.encode(JSON.stringify(index)), indexAad(s.did));
    return { did: s.did, iv: idx.iv, ct: idx.ct };
  }
  function cleanName(n) {
    n = String(n == null ? '' : n).replace(/\s+/g, ' ').trim().slice(0, 128);
    if (!n) throw new Error('A world needs a name.');
    return n;
  }
  // Tags: a list of short words or phrases, kept in the order given, the same tag once whatever its case. A string is read as a
  // comma-separated list so a text field can be passed straight through.
  function cleanTags(t) {
    if (typeof t === 'string') t = t.split(',');
    if (!Array.isArray(t)) throw new Error('Tags must be a list.');
    var out = [], seen = {};
    t.forEach(function (x) {
      x = String(x == null ? '' : x).replace(/\s+/g, ' ').trim().slice(0, MAX_TAG);
      var k = x.toLowerCase();
      if (x && !seen[k]) { seen[k] = 1; out.push(x); }
    });
    if (out.length > MAX_TAGS) throw new Error('A world can have at most ' + MAX_TAGS + ' tags.');
    return out;
  }
  function cleanNote(n) {
    n = String(n == null ? '' : n).replace(/[ \t]+/g, ' ').trim();
    if (n.length > MAX_NOTE) throw new Error('A note can be at most ' + MAX_NOTE + ' characters.');
    return n;
  }
  // A template name, or null for none; anything that is not one of TEMPLATES is refused.
  function cleanTemplate(t) {
    if (t === undefined || t === null || t === '') return null;
    if (typeof t !== 'string' || TEMPLATES.indexOf(t) < 0) throw new Error('Not a template: ' + String(t).slice(0, 40));
    return t;
  }
  // What the world may see of an entry. Entries made before tags and notes existed have none.
  function view(index, name) {
    var w = index.worlds[name];
    return { name: name, savedAt: w.savedAt, createdAt: w.createdAt || w.savedAt, bytes: w.bytes, tags: w.tags || [], note: w.note || '', template: w.template || null, last: index.last === name };
  }
  function needText() {
    if (!wt) throw new Error('Searching saved worlds is not available here.');
    return wt;
  }

  // Saves and loads of one identity are applied one after another, so two saves cannot both read the same index and lose one.
  var chain = Promise.resolve();
  function serial(fn) { var p = chain.then(fn); chain = p.catch(function () {}); return p; }

  // ---- ops ---------------------------------------------------------------------------------------------------------------
  // A save under a name that exists replaces that world and keeps its creation date, tags and note (unless the call gives new
  // ones). A new name makes a new world.
  function save(args) {
    return serial(async function () {
      var s = session(), name = cleanName(args.name), doc = String(args.doc == null ? '' : args.doc);
      var bytes = enc.encode(doc);
      if (!bytes.length) throw new Error('Nothing to save.');
      if (bytes.length > MAX_BYTES) throw new Error('This world is too large to save here.');
      var tags = args.tags === undefined ? undefined : cleanTags(args.tags), note = args.note === undefined ? undefined : cleanNote(args.note);
      var template = args.template === undefined ? undefined : cleanTemplate(args.template);
      var index = await readIndex(s);
      var prev = index.worlds[name];
      var id = prev ? prev.id : kd.b64u(crypto.getRandomValues(new Uint8Array(16)));
      var now = new Date().toISOString();
      var body = await seal(s.key, bytes, bodyAad(s.did, id));
      var text = await seal(s.key, enc.encode(needText().extract(doc)), textAad(s.did, id));
      index.worlds[name] = {
        id: id, savedAt: now, bytes: bytes.length, createdAt: prev ? (prev.createdAt || prev.savedAt) : now,
        tags: tags !== undefined ? tags : (prev && prev.tags) || [], note: note !== undefined ? note : (prev && prev.note) || '', t: true
      };
      var kept = template !== undefined ? template : (prev && prev.template) || null;
      if (kept) index.worlds[name].template = kept;
      index.last = name;
      var rec = await sealIndex(s, index);
      // body, text and index land together or not at all
      await tx(['bodies', 'texts', 'index'], 'readwrite', function (t) {
        t.objectStore('bodies').put({ id: id, did: s.did, iv: body.iv, ct: body.ct });
        t.objectStore('texts').put({ id: id, did: s.did, iv: text.iv, ct: text.ct });
        t.objectStore('index').put(rec);
      });
      return { name: name, savedAt: now, bytes: bytes.length };
    });
  }

  function list() {
    return serial(async function () {
      var s = session(), index = await readIndex(s);
      return Object.keys(index.worlds).map(function (n) { return view(index, n); }).sort(function (a, b) { return a.savedAt < b.savedAt ? 1 : -1; });
    });
  }
  // Whether a world of this name is saved. Used before a new world is given a name that is already taken.
  function has(args) {
    return serial(async function () { var s = session(), index = await readIndex(s); return !!index.worlds[cleanName(args.name)]; });
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
      var rec = await sealIndex(s, index);
      await tx(['index'], 'readwrite', function (t) { t.objectStore('index').put(rec); });
      return true;
    });
  }
  // A new name for a saved world. Only the index changes: the body and the text are sealed under the record id, not the name.
  // Refuses a name that is taken, so one world can never replace another by being renamed.
  function rename(args) {
    return serial(async function () {
      var s = session(), index = await readIndex(s), from = cleanName(args.from), to = cleanName(args.to);
      if (!index.worlds[from]) throw new Error('No such saved world.');
      if (from === to) return view(index, from);
      if (index.worlds[to]) throw new Error('A world named "' + to + '" already exists.');
      index.worlds[to] = index.worlds[from];
      delete index.worlds[from];
      if (index.last === from) index.last = to;
      var rec = await sealIndex(s, index);
      await tx(['index'], 'readwrite', function (t) { t.objectStore('index').put(rec); });
      return view(index, to);
    });
  }
  // The tags and the note of a world; whichever the call leaves out stays as it is.
  function setMeta(args) {
    return serial(async function () {
      var s = session(), index = await readIndex(s), name = cleanName(args.name), w = index.worlds[name];
      if (!w) throw new Error('No such saved world.');
      if (args.tags !== undefined) w.tags = cleanTags(args.tags);
      if (args.note !== undefined) w.note = cleanNote(args.note);
      var rec = await sealIndex(s, index);
      await tx(['index'], 'readwrite', function (t) { t.objectStore('index').put(rec); });
      return view(index, name);
    });
  }
  // A copy under a new name: its own record, so changing either never touches the other. Refuses a name that is taken.
  function duplicate(args) {
    return serial(async function () {
      var s = session(), index = await readIndex(s), from = cleanName(args.from), to = cleanName(args.to), w = index.worlds[from];
      if (!w) throw new Error('No such saved world.');
      if (index.worlds[to]) throw new Error('A world named "' + to + '" already exists.');
      var src = await readBody(s, index, from);
      if (!src) throw new Error('That saved world could not be read.');
      var id = kd.b64u(crypto.getRandomValues(new Uint8Array(16))), now = new Date().toISOString();
      var body = await seal(s.key, enc.encode(src.doc), bodyAad(s.did, id));
      var text = await seal(s.key, enc.encode(needText().extract(src.doc)), textAad(s.did, id));
      index.worlds[to] = { id: id, savedAt: now, bytes: w.bytes, createdAt: now, tags: (w.tags || []).slice(), note: w.note || '', t: true };
      if (w.template) index.worlds[to].template = w.template;
      var rec = await sealIndex(s, index);
      await tx(['bodies', 'texts', 'index'], 'readwrite', function (t) {
        t.objectStore('bodies').put({ id: id, did: s.did, iv: body.iv, ct: body.ct });
        t.objectStore('texts').put({ id: id, did: s.did, iv: text.iv, ct: text.ct });
        t.objectStore('index').put(rec);
      });
      return view(index, to);
    });
  }

  // Makes the text record of every world that has none (saved before texts existed). A world whose body cannot be read is left
  // alone and counted: one bad record must not stop a search of the others. Returns how many were made and how many were skipped.
  async function ensureText(s, index) {
    var todo = Object.keys(index.worlds).filter(function (n) { return !index.worlds[n].t; }), made = [], skipped = 0;
    for (var i = 0; i < todo.length; i++) {
      try {
        var b = await readBody(s, index, todo[i]);
        if (!b) { skipped++; continue; }
        var rec = await seal(s.key, enc.encode(needText().extract(b.doc)), textAad(s.did, index.worlds[todo[i]].id));
        made.push({ name: todo[i], rec: { id: index.worlds[todo[i]].id, did: s.did, iv: rec.iv, ct: rec.ct } });
      } catch (e) { skipped++; }
    }
    if (made.length) {
      made.forEach(function (m) { index.worlds[m.name].t = true; });
      var idx = await sealIndex(s, index);
      await tx(['texts', 'index'], 'readwrite', function (t) {
        made.forEach(function (m) { t.objectStore('texts').put(m.rec); });
        t.objectStore('index').put(idx);
      });
    }
    return { made: made.length, skipped: skipped };
  }
  // Which saved worlds show which library files. args: { ids: [file id, ...] } (at most 500). Resolves { <id>: [world name, ...] }, every
  // asked id present (an empty list when no saved world shows it), names in order. Each world's list of files is kept in the sealed
  // index as `fl: { at, ids }`, where `at` is the world's savedAt when the list was read from its body: a world saved again has a newer
  // savedAt, so its list is read again and nothing else is (a world the person never saved since this existed is opened once, the first
  // time it is asked). A body that cannot be read is skipped and counted in `unreadable`, never guessed at. Only a SAVED world counts: the
  // world that is open and not saved yet is known to the world itself. The result also holds `_unreadable`, how many saved worlds could not
  // be read (a key that cannot be mistaken for an id: ids are exactly 43 characters).
  function usedIn(args) {
    return serial(async function () {
      var s = session(), wanted = Array.isArray(args && args.ids) ? args.ids.slice(0, 500).map(String) : [];
      var index = await readIndex(s), out = Object.create(null), changed = false, unreadable = 0;
      wanted.forEach(function (id) { out[id] = []; });
      var names = Object.keys(index.worlds).sort();
      for (var i = 0; i < names.length; i++) {
        var w = index.worlds[names[i]];
        if (!w.fl || w.fl.at !== w.savedAt || !Array.isArray(w.fl.ids)) {
          try {
            var b = await readBody(s, index, names[i]);
            if (!b) { unreadable++; continue; }
            w.fl = { at: w.savedAt, ids: needText().fileIds(b.doc) };
            changed = true;
          } catch (e) { unreadable++; continue; }
        }
        w.fl.ids.forEach(function (id) { if (out[id]) out[id].push(names[i]); });
      }
      if (changed) {
        var rec = await sealIndex(s, index);
        await tx(['index'], 'readwrite', function (t) { t.objectStore('index').put(rec); });
      }
      var res = {};
      Object.keys(out).forEach(function (id) { res[id] = out[id]; });
      res._unreadable = unreadable;
      return res;
    });
  }

  // Finds worlds by name, tags, note and the text inside them (all of the words, any order; "quoted phrases"). Opens the text
  // records only, never a body, except to make the text of a world saved before texts existed. Nothing leaves this page but the
  // names, the tags and short snippets of the signed-in identity's own worlds.
  function search(args) {
    return serial(async function () {
      var s = session(), index = await readIndex(s), query = String(args.query == null ? '' : args.query);
      if (!needText().terms(query).length) return { hits: [], skipped: 0 };
      var made = await ensureText(s, index);
      var recs = await tx(['texts'], 'readonly', function (t) {
        var r = t.objectStore('texts').index('did').getAll(IDBKeyRange.only(s.did));
        return function () { return r.result; };
      });
      var byId = {};
      for (var i = 0; i < recs.length; i++) {
        try { byId[recs[i].id] = dec.decode(await open(s.key, recs[i], textAad(s.did, recs[i].id))); } catch (e) { made.skipped++; }
      }
      var entries = Object.keys(index.worlds).map(function (n) {
        var w = index.worlds[n];
        return { name: n, tags: w.tags || [], note: w.note || '', text: byId[w.id] || '' };
      });
      var hits = wt.search(entries, query).map(function (h) {
        var v = view(index, h.name);
        v.score = h.score; v.where = h.where; v.snippet = h.snippet;
        return v;
      });
      return { hits: hits, skipped: made.skipped };
    });
  }

  function prefsGet() {
    return serial(async function () { return (await readIndex(session())).prefs || {}; });
  }
  function prefsSet(args) {
    return serial(async function () {
      var s = session(), key = String(args.key);
      if (!Object.prototype.hasOwnProperty.call(PREF_KEYS, key) || !PREF_KEYS[key](args.value)) throw new Error('Not a setting that can be kept: ' + key);
      var index = await readIndex(s);
      index.prefs = index.prefs || {};
      index.prefs[key] = args.value;
      var rec = await sealIndex(s, index);
      await tx(['index'], 'readwrite', function (t) { t.objectStore('index').put(rec); });
      return index.prefs;
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
      var rec = await sealIndex(s, index);
      await tx(['bodies', 'texts', 'index'], 'readwrite', function (t) {
        t.objectStore('bodies').delete(w.id);
        t.objectStore('texts').delete(w.id);
        t.objectStore('index').put(rec);
      });
      return true;
    });
  }

  // Drops everything of one identity (it was removed from the device, so the key is gone for good). Needs no session.
  function purge(did) {
    return serial(function () {
      return tx(['bodies', 'texts', 'index'], 'readwrite', function (t) {
        t.objectStore('index').delete(did);
        ['bodies', 'texts'].forEach(function (store) {
          var c = t.objectStore(store).index('did').openKeyCursor(IDBKeyRange.only(did));
          c.onsuccess = function () { var cur = c.result; if (cur) { t.objectStore(store).delete(cur.primaryKey); cur.continue(); } };
        });
      }).then(function () { return true; });
    });
  }

  // ---- moving between origins (keo-transfer.js) -------------------------------------------------------------------------
  // The signed-in identity's records AS THEY ARE ON DISK: sealed under its key, so a copy is only readable where the same identity
  // is signed in, and nothing here decrypts a body. A record is sealed with the identity and its own id as additional data, so one
  // copied to another origin that holds the same identity is valid there as it is. Not for anything but keo-transfer.js: it hands
  // back sealed bytes the caller must not interpret.
  function exportSealed() {
    return serial(async function () {
      var s = session();
      var got = await tx(['index', 'bodies', 'texts'], 'readonly', function (t) {
        var i = t.objectStore('index').get(s.did), b = t.objectStore('bodies').index('did').getAll(IDBKeyRange.only(s.did)),
          x = t.objectStore('texts').index('did').getAll(IDBKeyRange.only(s.did));
        return function () { return { index: i.result, bodies: b.result, texts: x.result }; };
      });
      function rec(r) { return { id: r.id, iv: r.iv, ct: r.ct }; }
      return { did: s.did, index: got.index ? { iv: got.index.iv, ct: got.index.ct } : null, bodies: got.bodies.map(rec), texts: got.texts.map(rec) };
    });
  }
  // Adds the worlds of a pack made by exportSealed (on another origin, for the same identity) that this identity does not have yet.
  // Nothing is overwritten: a name that is taken here is left alone and reported. Every record is opened with this identity's key
  // first, so a damaged or foreign one is refused before anything is written, and what is added is cleaned as a save would clean it.
  // The save order ("last") and the settings are this device's own and are not touched. Returns { added: [names], skipped: [names],
  // unreadable: [names] }.
  function importSealed(pack) {
    return serial(async function () {
      var s = session();
      if (!pack || pack.did !== s.did) throw new Error('That data belongs to another identity.');
      var cur = await readIndex(s), theirs = { worlds: {} };
      if (pack.index) theirs = JSON.parse(dec.decode(await open(s.key, pack.index, indexAad(s.did))));
      if (!theirs || typeof theirs.worlds !== 'object' || !theirs.worlds) throw new Error('That is not valid saved-world data.');
      var bodies = {}, texts = {};
      (pack.bodies || []).forEach(function (r) { bodies[r.id] = r; });
      (pack.texts || []).forEach(function (r) { texts[r.id] = r; });
      var haveIds = {};
      Object.keys(cur.worlds).forEach(function (n) { haveIds[cur.worlds[n].id] = true; });
      var added = [], skipped = [], unreadable = [], put = [];
      var names = Object.keys(theirs.worlds);
      for (var i = 0; i < names.length; i++) {
        var raw = names[i], w = theirs.worlds[raw], name;
        try { name = cleanName(raw); } catch (e) { unreadable.push(String(raw).slice(0, 40)); continue; }
        if (cur.worlds[name]) { skipped.push(name); continue; }
        if (!w || typeof w.id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(w.id) || haveIds[w.id] || !bodies[w.id]) { unreadable.push(name); continue; }
        try {
          await open(s.key, bodies[w.id], bodyAad(s.did, w.id));
          var hasText = !!texts[w.id];
          if (hasText) await open(s.key, texts[w.id], textAad(s.did, w.id));
          var e = { id: w.id, savedAt: String(w.savedAt || ''), bytes: Math.max(0, Number(w.bytes) || 0), createdAt: String(w.createdAt || w.savedAt || ''),
            tags: cleanTags(w.tags || []), note: cleanNote(w.note || '') };
          if (hasText) e.t = true;
          var tpl = cleanTemplate(w.template);
          if (tpl) e.template = tpl;
          cur.worlds[name] = e; haveIds[w.id] = true; added.push(name);
          put.push({ store: 'bodies', rec: { id: w.id, did: s.did, iv: bodies[w.id].iv, ct: bodies[w.id].ct } });
          if (hasText) put.push({ store: 'texts', rec: { id: w.id, did: s.did, iv: texts[w.id].iv, ct: texts[w.id].ct } });
        } catch (err) { unreadable.push(name); }
      }
      if (added.length) {
        var rec = await sealIndex(s, cur);
        await tx(['bodies', 'texts', 'index'], 'readwrite', function (t) {
          put.forEach(function (p) { t.objectStore(p.store).put(p.rec); });
          t.objectStore('index').put(rec);
        });
      }
      return { added: added, skipped: skipped, unreadable: unreadable };
    });
  }

  window.keoWorlds = {
    exportSealed: exportSealed, importSealed: importSealed,
    save: save, list: list, has: has, load: load, last: last, setLast: setLast, remove: remove, purge: purge,
    rename: rename, setMeta: setMeta, duplicate: duplicate, search: search, usedIn: usedIn, prefsGet: prefsGet, prefsSet: prefsSet,
    cleanTemplate: cleanTemplate
  };
})();
