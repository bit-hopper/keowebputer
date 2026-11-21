// How a person's pages are listed, opened and written, SHELL side: the glue between what the world asks for over the bridge and the
// checked, sealed store of keo-wikistore.js. Pure logic over a store and two small functions about the signed-in identity, so a test with no
// browser can run it. No DOM, no network, no passkey (the device key signs, as for the other things the session does without asking again).
//
// WHAT THE WORLD MAY DO, and nothing else: list the pages, ask which of them mention some words (it is given the names and a short piece of
// text around the first match, not the texts), read one (its text and what a reading view shows, with no editing session), open one for
// editing, hand over what an editing session changed, close it, and delete one of the person's own pages. It never builds
// an event, never names a client id of its own choosing, never sees a key, and is never the judge of its own edit: the SHELL builds the
// signed event from the bytes the editor changed, adds it to the store, and says what the store made of it (accepted, pending, refused).
// There is no operation here that signs anything it is handed, and none that lets the world say who may write a page.
//
// AN EDITING SESSION. open() gives the editor the page's Yjs state at its current heads and a session. The session holds, shell side only:
// the page, a FRESH NONCE made at that moment, the Yjs client id derived from it (the editor sets its document's client id to that number,
// so everything it writes carries ids the store will accept), and the heads the next edit follows. A fresh nonce every time a page is opened
// is the owner's rule for the writing side (two copies of one device, a restored backup, must not write under one id); a session is not
// carried over a reload: after one the editor opens again and gets another id.
//   edit({ session, n, update }) builds ONE event from `update` (a Yjs update of what the editor changed since its last save, written under
//   the session's client id) with the session's heads as parents; when the store accepts it, the session's heads become that event.
//   Edits of one session run one after another (two in flight would both name the same parents and fork the device's own history, and
//   the store would call that two conflicting edits). `n` counts the editor's saves: the same `n` again, with the same bytes, gets the
//   earlier answer back and builds nothing, so an answer that was lost on the way does not turn a retry into a second event over the same
//   clock numbers (which the store would refuse as a device writing two edits under one id, and tell the person about).
// Not here: events that arrive from another device (the next slice), the history view, checkpoints.
(function (root, factory) {
  var node = typeof module === 'object' && module.exports;
  var api = factory(node ? require('./keo-did.js') : root.keoDid, node ? require('./keo-wikilog.js') : root.keoWikiLog, node ? require('./keo-worldtext.js') : root.keoWorldText,
    node ? require('./keo-wikiexport.js') : root.keoWikiExport);
  if (node) module.exports = api; else root.keoWikiPages = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (kd, W, WT, E) {
  'use strict';

  // A person has a handful of pages open at once; this keeps what the shell holds per open page bounded, and the least recently used
  // session is dropped when it is passed (that editor's next save is told to open the page again).
  var MAX_SESSIONS = 32;
  var NOT_OPEN = 'That page is not open for editing here (it was closed, or you signed out). Open it again.';

  function randomId() { return kd.b64u(globalThis.crypto.getRandomValues(new Uint8Array(16))); }
  function sameBytes(a, b) { if (a.length !== b.length) return false; for (var i = 0; i < a.length; i++) if (a[i] !== b[i]) return false; return true; }
  // A copy that owns its bytes, from the bytes, a view or a buffer the world handed over; null for anything else.
  function bytesOf(x) {
    if (x instanceof Uint8Array) return new Uint8Array(x);
    if (x instanceof ArrayBuffer) return new Uint8Array(x.slice(0));
    return null;
  }

  // A file may be made at most once a second, and one at a time: the world can ask for as many as it likes, and every one of them ends as a
  // download on the person's disk (keo-wiki.js hands it to the browser), so a world that asks in a loop is stopped here, not by the browser.
  var EXPORT_GAP_MS = 1000;

  // o: { store (keo-wikistore.js), identity: { proof() -> { did, deviceId, log }, sign(bytes, did) -> base64url signature }, now? (a clock in ms) }
  // `proof` throws when nobody is signed in; `sign` throws when the identity signed in is no longer `did`.
  function create(o) {
    var store = o.store, identity = o.identity, clock = o.now || Date.now, exporting = false, lastExport = -Infinity;
    var sessions = new Map();               // session id -> { objId, name, did, deviceId, nonce, clientId, heads, canEdit, chain, last }
    var offered = { did: null, events: -1 };

    // The signed-in identity's own log must sit in the store's log book before an edit of this identity can be checked against it.
    async function offerOwn(proof) {
      var seq = (proof.log.events || []).length;
      if (offered.did === proof.did && offered.events === seq) return;
      var r = await store.offerLog(proof.did, proof.log);
      if (r.status === 'refused' || r.status === 'fork' || r.status === 'shorter') throw new Error('This device\'s copy of your identity could not be kept for the wiki (' + r.status + ').');
      offered = { did: proof.did, events: seq };
    }
    function describe(row, did, meta) {
      var p = W.parsePageId(row.objId);
      return { id: row.objId, name: p.name, owner: p.owner, mine: p.owner === did, versions: row.versions, pending: row.pending, updated: row.touched,
        created: meta.created, category: meta.category, tags: meta.tags, unreadable: !!meta.unreadable };
    }

    // [{ id, name, owner, mine, versions, pending, updated, created, category, tags, unreadable }], newest change first.
    //   updated   when THIS device last took a change into the page, by its own clock.
    //   created   the earliest date an edit of the page states (the author's word: it orders a list, nothing depends on it); null for a page
    //             with no edit yet.
    //   category, tags   from the page's own `meta` map, cut to a short label and a short list (the store's summary says how); null and [].
    //   unreadable   the page's history could not be read (a record is missing or damaged): it is still listed, with nothing but its name, so
    //             that one damaged page does not take the list of every other page with it.
    // The store keeps what it works out per page, so a page that has not changed since it was last listed costs one small record.
    async function list() {
      var proof = await identity.proof(), rows = (await store.pages()).filter(function (r) { return W.parsePageId(r.objId); }), out = [];
      for (var i = 0; i < rows.length; i++) {
        var meta = rows[i].meta;
        if (!meta) {
          try { meta = await store.summary(rows[i].objId); }
          catch (e) { meta = { created: null, category: null, tags: [], unreadable: true }; }
        }
        out.push(describe(rows[i], proof.did, meta));
      }
      return out;
    }

    // Which pages mention the words of a query, best first: [{ id, name, owner, mine, category, tags, score, where, snippet }], at most
    // MAX_HITS. The same rules as the search of saved worlds (keo-worldtext.js: every word, or "quoted phrase", has to be found; case and
    // accents do not matter; a name ranks above a category or tag, those above the text), over each page's name, its category and tags and
    // its text. `where` says which of 'name', 'tags', 'text' matched, `snippet` is a piece of the text around the first match ('' when only
    // the name, category or tags matched). Every page this device holds is searched, the person's own and others'; the caller says what it
    // shows. A page whose history cannot be read is still found by its name. Each page is matched on its own because two pages of different
    // owners may share a name.
    var MAX_QUERY = 200, MAX_HITS = 50;
    async function search(a) {
      var query = a && typeof a.query === 'string' ? a.query.slice(0, MAX_QUERY) : null;
      if (query === null) throw new Error('Say what to search for.');
      if (!WT.terms(query).length) return [];
      var proof = await identity.proof(), rows = (await store.pages()).filter(function (r) { return W.parsePageId(r.objId); }), hits = [];
      for (var i = 0; i < rows.length; i++) {
        var p = W.parsePageId(rows[i].objId), meta = rows[i].meta, text = '';
        if (!meta) { try { meta = await store.summary(rows[i].objId); } catch (e) { meta = { category: null, tags: [] }; } }
        try { text = await store.text(rows[i].objId); } catch (e) { text = ''; }
        var h = WT.search([{ name: p.name, tags: (meta.category ? [meta.category] : []).concat(meta.tags || []), text: text }], query)[0];
        if (h) hits.push({ id: rows[i].objId, name: p.name, owner: p.owner, mine: p.owner === proof.did, category: meta.category, tags: meta.tags || [], score: h.score, where: h.where, snippet: h.snippet });
      }
      hits.sort(function (x, y) { return y.score - x.score || (x.name < y.name ? -1 : x.name > y.name ? 1 : x.id < y.id ? -1 : 1); });
      return hits.slice(0, MAX_HITS);
    }

    // Which page a request means: { name } is a page of the signed-in identity (made when it is first saved), { id } is any page's id.
    // Throws a sentence for anything else.
    function refOf(proof, a) {
      var id;
      if (a && typeof a.id === 'string') id = a.id;
      else if (a && typeof a.name === 'string') id = W.pageId(proof.did, a.name);       // throws a sentence for a name the page id cannot hold
      else throw new Error('Say which page to open: a name, or the id of a page.');
      var parsed = W.parsePageId(id);
      if (!parsed) throw new Error('That is not the name of a page (its owner\'s identity, a slash and a name).');
      return { id: id, parsed: parsed };
    }

    // Whether a page can be made the world a person is taken to (shell.js `go`, kind 'wiki'): the signed-in identity's own page, held or not
    // (a new one is made when it is first saved), or a page of someone else's that this device holds. A page of someone else's that it does
    // not hold would open empty and unwritable, so no world is started for it. Answers { id, name, owner, mine, held }; opens no session.
    // `held` is whether this device has the page now: a page that is held is read (its reading view) and a page that is not (a new name of the
    // person's own) is written (the editor), so the world that is started for it knows which to show without asking again.
    async function locate(a) {
      var proof = await identity.proof(), r = refOf(proof, a), mine = r.parsed.owner === proof.did;
      var held = (await store.heads(r.id)).length > 0;
      if (!mine && !held) throw new Error('This device holds no such page.');
      return { id: r.id, name: r.parsed.name, owner: r.parsed.owner, mine: mine, held: held };
    }

    // a: { name } for a page of the signed-in identity (made when it is first saved), or { id } for any page the store holds.
    // Answers { session, id, name, owner, mine, isNew, canEdit, clientId, heads, state }: `state` is the page's Yjs update (empty for a new
    // page), `canEdit` whether this identity may write it as of those heads. A page that cannot be written is still opened, to be read.
    async function open(a) {
      var proof = await identity.proof(), r = refOf(proof, a), id = r.id, parsed = r.parsed;
      await offerOwn(proof);
      // The heads first, then the state AT those heads: asking for the state alone could read a newer one than the heads name.
      var heads = await store.heads(id);
      var st = await store.state(id, heads), writers = await store.writers(id, heads);
      var nonce = randomId(), clientId = await W.clientIdFor(proof.deviceId, id, nonce), session = randomId();
      if (sessions.size >= MAX_SESSIONS) sessions.delete(sessions.keys().next().value);
      var canEdit = writers.indexOf(proof.did) >= 0;
      sessions.set(session, { id: session, objId: id, did: proof.did, deviceId: proof.deviceId, nonce: nonce, clientId: clientId, heads: heads.slice(), canEdit: canEdit, chain: Promise.resolve(), last: null });
      return { session: session, id: id, name: parsed.name, owner: parsed.owner, mine: parsed.owner === proof.did, isNew: heads.length === 0,
        canEdit: canEdit, clientId: clientId, heads: heads, state: st.update };
    }

    // A page to READ, not to edit: a: { name } or { id }, as for open(). Answers { id, name, owner, mine, canEdit, heads, state, versions,
    // pending, updated, authors }: `state` is the page's Yjs update at its current heads, `canEdit` whether this identity may write it, `versions`
    // how many edits it holds (a change of the writer list is not one), `pending` how many more wait for something and are not in the text,
    // `updated` when THIS device last took a change into it (its own clock), `authors` the DIDs that wrote an edit, in the order they first
    // did (the owner's own page lists the owner first). Opens NO editing session: nothing is held for the reader, so there is nothing to give
    // back, and a reader of a page cannot end up writing one. Throws a sentence for a page this device does not hold (a page that was never
    // saved is not one: it is only made when it is first written).
    async function read(a) {
      var proof = await identity.proof(), r = refOf(proof, a), id = r.id;
      var heads = await store.heads(id);
      if (!heads.length) throw new Error('This device holds no such page.');
      var st = await store.state(id, heads), writers = await store.writers(id, heads), rows = await store.versions(id), info = await store.info(id);
      var authors = [], edits = 0;
      rows.forEach(function (v) {
        if (v.kind !== 'edit') return;
        edits++;
        if (authors.indexOf(v.did) < 0) authors.push(v.did);
      });
      return { id: id, name: r.parsed.name, owner: r.parsed.owner, mine: r.parsed.owner === proof.did, canEdit: writers.indexOf(proof.did) >= 0,
        heads: heads, state: st.update, versions: edits, pending: info.pending, updated: info.touched, authors: authors };
    }

    // A file made of a page (Markdown or a standalone web page: keo-wikiexport.js), for the shell to hand to the browser's download.
    // a: { id } (or { name }) and { format: 'markdown' | 'html' }. Answers { name, type, bytes }: the BYTES STAY IN THE SHELL (shell.js's
    // wiki.export answers the world with the file's name and size only). A page is read the way read() reads it, so the same pages and the same
    // refusals; at most one file at a time and one a second (EXPORT_GAP_MS), and a refused or failed one does not count.
    async function exportFile(a) {
      if (exporting) throw new Error('A file is being made. Wait for it.');
      if (clock() - lastExport < EXPORT_GAP_MS) throw new Error('Wait a moment before saving another file.');
      exporting = true;
      try {
        var r = await read({ id: a && a.id, name: a && a.name });
        var f = E.exportPage({ name: r.name, update: r.state, format: a && a.format });
        lastExport = clock();
        return f;
      } finally { exporting = false; }
    }

    // Takes one of the signed-in identity's own pages off this device, with its whole history. a: { id } (or { name }). Answers
    // { removed, versions, pending } (the store's own answer). Not for a page someone else made: a copy of theirs is not this person's to
    // destroy for everyone (there is no other device to destroy it on yet, but the rule is the one that will hold when there is), so that is
    // refused with a sentence. Any editing session on the page is given up FIRST (before the store is asked, in the same turn): an edit that
    // is still being built when the page goes cannot bring it back, because it is checked against its session just before it is added.
    async function remove(a) {
      var proof = await identity.proof(), r = refOf(proof, a);
      if (r.parsed.owner !== proof.did) throw new Error('Only a page you made can be deleted here.');
      Array.from(sessions.keys()).forEach(function (k) { if (sessions.get(k).objId === r.id) sessions.delete(k); });
      return store.remove(r.id);
    }

    // a: { session, n, update }. Answers { status, cid?, error?, saved }: `saved` is true when the store holds the edit now (accepted, or
    // already held). Anything else leaves the session where it was, and the editor keeps what it has not saved.
    function edit(a) {
      var s = a && typeof a.session === 'string' ? sessions.get(a.session) : null;
      if (!s) return Promise.reject(new Error(NOT_OPEN));
      var update = bytesOf(a.update);
      if (!update || !update.length) return Promise.reject(new Error('There is nothing to save.'));
      if (update.length > W.MAX_UPDATE_BYTES) return Promise.reject(new Error('That change is larger than a page edit may be (' + W.MAX_UPDATE_BYTES + ' bytes).'));
      if (!Number.isSafeInteger(a.n) || a.n < 0) return Promise.reject(new Error('A save needs a number.'));
      // most recently used goes last, so that the one dropped for room is the one idle the longest
      sessions.delete(a.session); sessions.set(a.session, s);
      var run = s.chain.then(function () { return editNow(s, a.n, update); });
      s.chain = run.catch(function () {});
      return run;
    }
    async function editNow(s, n, update) {
      // closed or dropped for room while this save waited its turn
      if (sessions.get(s.id) !== s) throw new Error(NOT_OPEN);
      if (s.last && n === s.last.n) {
        if (!sameBytes(update, s.last.update)) throw new Error('That save number was already used for a different change.');
        return s.last.answer;
      }
      if (s.last && n < s.last.n) throw new Error('That save is older than one already made.');
      var proof = await identity.proof();
      if (proof.did !== s.did) throw new Error('The signed-in identity changed. Open the page again.');
      await offerOwn(proof);
      var point = await W.logPoint(proof.log);
      var ev = await W.buildVersion({ objId: s.objId, parents: s.heads, author: { did: s.did, deviceId: s.deviceId }, authorLog: point, nonces: [s.nonce], update: update });
      var env = await W.seal(ev, function (bytes) { return identity.sign(bytes, s.did); });
      // The page may have been deleted while the event was being built (remove() gives its sessions up): adding it now would make a one-edit
      // page out of nothing. Nothing awaits between this check and the call, so a delete that comes after it is queued behind the add.
      if (sessions.get(s.id) !== s) throw new Error(NOT_OPEN);
      var r = await store.add(env);
      var answer = { status: r.status, cid: r.cid, error: r.error, saved: r.status === 'accepted' || r.status === 'duplicate' };
      if (r.status === 'accepted') s.heads = [r.cid];            // it names every earlier head as a parent, so it is the only head now
      // A refused or waiting edit is not remembered: the editor may send the same bytes again under the same number after it fixed what was wrong.
      if (answer.saved) s.last = { n: n, update: update, answer: answer };
      return answer;
    }

    function close(a) {
      if (a && typeof a.session === 'string') sessions.delete(a.session);
      return Promise.resolve(true);
    }
    // Every editing session is given up, and nothing else changes: the world frame that held the editors is being replaced, so no editor is
    // left to use one (a session whose editor is gone would otherwise sit here until later ones pushed it out).
    function closeAll() { sessions.clear(); }
    // The session ended: nothing about an open page stays.
    function reset() { sessions.clear(); offered = { did: null, events: -1 }; lastExport = -Infinity; }

    return { list: list, search: search, locate: locate, read: read, exportFile: exportFile, remove: remove, open: open, edit: edit, close: close, closeAll: closeAll, reset: reset, MAX_SESSIONS: MAX_SESSIONS };
  }

  return { create: create, MAX_SESSIONS: MAX_SESSIONS };
});
