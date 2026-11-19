// How a person's pages are listed, opened and written, SHELL side: the glue between what the world asks for over the bridge and the
// checked, sealed store of keo-wikistore.js. Pure logic over a store and two small functions about the signed-in identity, so a test with no
// browser can run it. No DOM, no network, no passkey (the device key signs, as for the other things the session does without asking again).
//
// WHAT THE WORLD MAY DO, and nothing else: list the pages, open one, hand over what an editing session changed, close it. It never builds
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
  var api = factory(node ? require('./keo-did.js') : root.keoDid, node ? require('./keo-wikilog.js') : root.keoWikiLog);
  if (node) module.exports = api; else root.keoWikiPages = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (kd, W) {
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

  // o: { store (keo-wikistore.js), identity: { proof() -> { did, deviceId, log }, sign(bytes, did) -> base64url signature } }
  // `proof` throws when nobody is signed in; `sign` throws when the identity signed in is no longer `did`.
  function create(o) {
    var store = o.store, identity = o.identity;
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
    function describe(row, did) {
      var p = W.parsePageId(row.objId);
      return { id: row.objId, name: p.name, owner: p.owner, mine: p.owner === did, versions: row.versions, pending: row.pending, updated: row.touched };
    }

    // [{ id, name, owner, mine, versions, pending, updated }], newest change first. `updated` is when THIS device last took a change into
    // the page, by its own clock.
    async function list() {
      var proof = await identity.proof(), rows = await store.pages();
      return rows.filter(function (r) { return W.parsePageId(r.objId); }).map(function (r) { return describe(r, proof.did); });
    }

    // a: { name } for a page of the signed-in identity (made when it is first saved), or { id } for any page the store holds.
    // Answers { session, id, name, owner, mine, isNew, canEdit, clientId, heads, state }: `state` is the page's Yjs update (empty for a new
    // page), `canEdit` whether this identity may write it as of those heads. A page that cannot be written is still opened, to be read.
    async function open(a) {
      var proof = await identity.proof(), id;
      if (a && typeof a.id === 'string') id = a.id;
      else if (a && typeof a.name === 'string') id = W.pageId(proof.did, a.name);       // throws a sentence for a name the page id cannot hold
      else throw new Error('Say which page to open: a name, or the id of a page.');
      var parsed = W.parsePageId(id);
      if (!parsed) throw new Error('That is not the name of a page (its owner\'s identity, a slash and a name).');
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
    // The session ended: nothing about an open page stays.
    function reset() { sessions.clear(); offered = { did: null, events: -1 }; }

    return { list: list, open: open, edit: edit, close: close, reset: reset, MAX_SESSIONS: MAX_SESSIONS };
  }

  return { create: create, MAX_SESSIONS: MAX_SESSIONS };
});
