// The signed version event of a shared wiki page: what one person's edit looks like on the wire, and how a receiver decides whether to
// accept it. Pure functions over WebCrypto and the vendored Yjs (keo-yjs.js): no storage, no network, no DOM, no passkey.
//
// A page has no server. Its history is a set of version events, each one naming the events it was made after (`parents`, a SET, so two
// people who edit at the same time simply make two events with the same parent, and a later event can name both). An event carries a
// Yjs UPDATE (only what this edit changed), so the state of the page at a version is what you get by applying the updates of that
// version's whole ancestry, in any order (Yjs updates commute).
//
//   envelope = { event, sig }                       sig: base64url, the raw ECDSA P-256 / SHA-256 signature (r||s) of the author's
//                                                   device key over canonicalJson(event), the same bytes keo-identity.js signWithDevice signs
//   event    = { v: 1, purpose: 'keo-wiki-version',
//                objId,                             the page: `<the owner's DID>/<a name>` (pageId, parsePageId), so the owner is part of the
//                                                   page's identity and nobody can take over a page by choosing its name
//                parents: [ cid, ... ],             sorted, no duplicates; empty for the first event
//                author: { did, deviceId },         the identity and the id of its device key, as that identity's log lists it
//                authorLog: { seq, head },          the point of the author's identity log this edit was made at: seq events after the
//                                                   inception, head = the hash (b64u) of the last of them (of the inception for 0)
//                clients: [ { nonce, id } ],        the Yjs client ids the update's structs may use, each derived from the author's
//                                                   device id, the page and the nonce (clientIdFor): `id` is stored so a reader need not
//                                                   hash, and it is checked
//                payload: { format: 'yjs-update-v1', update: b64url, attachments: [ hash, ... ] },
//                created }                          when the author says it was made; nothing here depends on it
//   cid      = base64url SHA-256 of canonicalJson(event)       (the signature is not in it, so it does not depend on ECDSA's randomness)
//
// WHAT A RECEIVER CHECKS (verifyVersion), in this order, so garbage is refused before anything is waited for:
//   1. the shape and the sizes (before any byte of the update is decoded);
//   2. the author's identity log up to `authorLog.seq` verifies, ends in `authorLog.head`, and lists the author's device AT THAT POINT.
//      A device removed later does not undo what it signed while it was listed; a device removed before that point cannot sign. Every
//      receiver that holds the author's log reaches the same answer, which is what keeps the pages of different people the same.
//      What it cannot do: a thief who holds a device that has not been removed yet can write a LATE edit that claims an old point,
//      and nothing can tell it from an honest late one. The page history (restore an older version as a new edit) is the remedy;
//   3. the signature of that device key;
//   4. the Yjs client ids: each is derived as stated, and EVERY struct in the update uses one of them (an edit that writes with
//      another person's client id breaks that person's later edits for good and no resync repairs it: tested). The update is read twice,
//      by keo-yupdate.js and by Yjs's own decoder, and refused unless they agree on every struct and deleted range. What an edit
//      DELETES is not restricted: any writer may delete anything, as in a wiki; undoing it is restoring an older version;
//   5. the parents are known (otherwise the event waits: `pending`), and the author is a writer of the page as of those parents: the
//      page's owner always is, anyone else only when the owner's signed list names them in the history those parents follow.
//
// WHO MAY WRITE (the signed writer list). The owner changes the list with a second kind of event in the SAME history as the edits:
//   policy = { v: 1, purpose: 'keo-wiki-policy', objId, parents, author, authorLog,       as an edit, and checked the same way
//              change: { op: 'add-writer' | 'remove-writer', did }, created }
// Only the owner (the DID in the page's id) signs one; it names an identity, not a device. "Who may write as of these parents" (writersFrom)
// is the owner plus everyone added in the history those parents follow, minus everyone removed. A removal wins over an add made at the same
// time by another of the owner's devices: a name counts only if some add of it comes AFTER every removal of it. The list as of an edit is a
// function of the history that edit follows and of nothing else (not of what else a receiver has heard since), so every receiver that holds
// that history reads the same list, whenever it heard of the changes. (The other checks of an edit, the author's log and the clock numbers,
// have their own rules.) The consequences, stated:
//   - what a writer wrote before a removal stays, and an edit that follows the removal is refused;
//   - a removed writer can still write an edit whose parents are from BEFORE the removal, and it verifies: nothing in an edit says when
//     it was made. It stands as a separate head and only matters if someone merges it (the same gap as a removed device's late edit).
//
// A result is { ok: true, cid, ... }, or { ok: false, error }, or { ok: false, pending: true, waitFor, error } when only something that
// has not arrived yet is missing (the author's log, a parent, the page's writer list). A pending event is neither accepted nor
// refused: the caller keeps it and asks again when the missing piece arrives.
//
// NOT DONE HERE (later steps of the same track): how events travel, and the check that one author's clocks continue where its earlier
// edits stopped, which needs the whole ancestry and so belongs to the store that holds the events (keo-wikistore.js), as does reading
// the list out of the history it holds (this file only gives the rule, writersFrom, and checks each event by itself). What this file does
// check is what one edit shows by itself: its changes under each client form one unbroken run, returned as `ranges`.
(function (root, factory) {
  var node = typeof module === 'object' && module.exports;
  var api = factory(node ? require('./keo-did.js') : root.keoDid, node ? require('./keo-yupdate.js') : root.keoYUpdate, node ? require('./keo-yjs.js') : root.keoYjs);
  if (node) module.exports = api; else root.keoWikiLog = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (kd, yu, Yjs) {
  'use strict';

  var subtle = globalThis.crypto.subtle, enc = new TextEncoder();
  var PURPOSE = 'keo-wiki-version', POLICY_PURPOSE = 'keo-wiki-policy', FORMAT = 'yjs-update-v1', OPS = ['add-writer', 'remove-writer'];
  var MAX_UPDATE_BYTES = 4 * 1024 * 1024, MAX_PARENTS = 64, MAX_CLIENTS = 8, MAX_ATTACHMENTS = 64, MAX_SEQ = 1e9;
  // The size of the writer list and of a page's list history are my numbers, not measured: they keep what a receiver holds per page
  // bounded (the store keeps, with every event, which list changes it follows), not a judgement of how many people should share a page.
  var MAX_WRITERS = 64, MAX_POLICY_EVENTS = 128;
  var MAX_NAME = 128, DID_LENGTH = 104, CONTROL = /[\u0000-\u001f\u007f]/;       // DID_LENGTH: 'did:keo:' + 52 + ':' + 43, the one shape parseDid accepts
  var CID = /^[A-Za-z0-9_-]{43}$/, NONCE = /^[A-Za-z0-9_-]{8,43}$/, HASHISH = /^[A-Za-z0-9_-]{16,128}$/;
  var ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;

  function isObj(x) { return !!x && typeof x === 'object' && !Array.isArray(x); }
  function hasOnly(o, keys) { return Object.keys(o).every(function (k) { return keys.indexOf(k) >= 0; }); }
  function fail(error) { return { ok: false, error: error }; }
  function pending(error, waitFor) { return { ok: false, pending: true, waitFor: waitFor, error: error }; }
  function bytesFromB64u(s) { var b = kd.unb64u(s); if (kd.b64u(b) !== s) throw new Error('not canonical base64url'); return b; }

  // ---- the page's id --------------------------------------------------------------------------------------------------------------
  // `<the owner's DID>/<name>`. The owner is read out of the id, never from anything else, so a page cannot be claimed by someone who
  // picks the same name (that is a different page: another owner's DID in front), and a receiver needs no "creation" event to know who
  // owns a page. The name is not interpreted beyond its size, and it may not hold a control character (the parts of a client id are told
  // apart by a zero byte, and a name must not be able to run into them). The owner is fixed for the life of the page.
  function pageId(ownerDid, name) {
    var id = String(ownerDid) + '/' + String(name);
    if (!parsePageId(id)) throw new Error('A page is named by its owner\'s identity and a name of 1 to ' + MAX_NAME + ' characters without control characters.');
    return id;
  }
  // { owner, name } or null.
  function parsePageId(objId) {
    if (typeof objId !== 'string' || objId.length < DID_LENGTH + 2 || objId.length > DID_LENGTH + 1 + MAX_NAME || objId.charAt(DID_LENGTH) !== '/') return null;
    var owner = objId.slice(0, DID_LENGTH), name = objId.slice(DID_LENGTH + 1);
    if (!kd.parseDid(owner) || CONTROL.test(name)) return null;
    return { owner: owner, name: name };
  }

  // ---- the Yjs client id ----------------------------------------------------------------------------------------------------------
  // The first 53 bits (Yjs keeps ids as JavaScript numbers; 53 bits is the most one holds exactly) of SHA-256 over a labelled,
  // zero-separated triple, so anyone can recompute it and nobody can pick an id that belongs to someone else's device short of grinding for a hash
  // (about 2^53 tries, and a writer's device key must also be listed in a log the page trusts). The nonce lets one device start over
  // with a fresh id after it lost its local copy of the page: re-using an id with clocks back at zero would write different content
  // under ids the others already hold, which splits the pages for good.
  async function clientIdFor(deviceId, objId, nonce) {
    var h = await kd.sha256(enc.encode('keo/wiki-client/v1\u0000' + deviceId + '\u0000' + objId + '\u0000' + nonce));
    var hi = ((h[0] << 24) | (h[1] << 16) | (h[2] << 8) | h[3]) >>> 0, lo = ((h[4] << 24) | (h[5] << 16) | (h[6] << 8) | h[7]) >>> 0;
    return hi * 2097152 + (lo >>> 11);                    // the first 53 bits of the hash, read as a big-endian number (the 64-bit value shifted right by 11)
  }

  // ---- building ----------------------------------------------------------------------------------------------------------------------
  function sortedUnique(list) { return Array.from(new Set(list)).sort(); }
  // The unsigned event. o: { objId, parents, author: { did, deviceId }, authorLog: { seq, head }, nonces: [ ... ], update (Uint8Array),
  // attachments?, created? }. The client ids are derived here, so the one who builds an event cannot state any other id.
  async function buildVersion(o) {
    var clients = [];
    for (var i = 0; i < o.nonces.length; i++) clients.push({ nonce: o.nonces[i], id: await clientIdFor(o.author.deviceId, o.objId, o.nonces[i]) });
    return { v: 1, purpose: PURPOSE, objId: o.objId, parents: sortedUnique(o.parents || []),
      author: { did: o.author.did, deviceId: o.author.deviceId }, authorLog: { seq: o.authorLog.seq, head: o.authorLog.head }, clients: clients,
      payload: { format: FORMAT, update: kd.b64u(o.update), attachments: (o.attachments || []).slice() },
      created: o.created || new Date().toISOString() };
  }
  function signedBytes(event) { return enc.encode(kd.canonicalJson(event)); }
  async function versionId(event) { return kd.b64u(await kd.sha256(signedBytes(event))); }
  // `signBytes(bytes)` resolves to the raw signature in base64url, as keo-identity.js signWithDevice does (it must be the device key
  // the event names). Never pass anything here that signs for the world: the caller builds the event itself.
  async function seal(event, signBytes) { return { event: event, sig: await signBytes(signedBytes(event)) }; }
  // The point of a log an author would write into `authorLog` now: how many events follow the inception, and the hash of the last one.
  async function logPoint(log) {
    var events = log.events || [], last = events.length ? events[events.length - 1].event : log.inception;
    return { seq: events.length, head: kd.b64u(await kd.eventHash(last)) };
  }

  // ---- checking ----------------------------------------------------------------------------------------------------------------------
  // What every event of a page's history states the same way: the page, the parents, the author and the point of the author's log.
  // null when it is stated properly, else a sentence. Looks at nothing but the shape.
  function headerError(e) {
    if (!parsePageId(e.objId)) return 'the page name is not an owner\'s identity, a slash and a name of 1 to ' + MAX_NAME + ' characters';
    if (!Array.isArray(e.parents) || e.parents.length > MAX_PARENTS || !e.parents.every(function (p) { return typeof p === 'string' && CID.test(p); })) return 'the parents are not a short list of version ids';
    if (kd.canonicalJson(e.parents) !== kd.canonicalJson(sortedUnique(e.parents))) return 'the parents are not sorted and unique';
    if (!isObj(e.author) || !hasOnly(e.author, ['did', 'deviceId']) || !kd.parseDid(e.author.did) || typeof e.author.deviceId !== 'string' || !e.author.deviceId || e.author.deviceId.length > 64) return 'the author is not named properly';
    var al = e.authorLog;
    if (!isObj(al) || !hasOnly(al, ['seq', 'head']) || !Number.isInteger(al.seq) || al.seq < 0 || al.seq > MAX_SEQ || typeof al.head !== 'string' || !CID.test(al.head)) return 'the point of the author\'s log is not stated properly';
    return null;
  }
  // null when the envelope has the right shape and sizes, else a sentence. Looks at nothing but the shape.
  function shapeError(env) {
    if (!isObj(env) || !hasOnly(env, ['event', 'sig']) || !isObj(env.event) || typeof env.sig !== 'string') return 'that is not a signed wiki version';
    var e = env.event;
    if (!hasOnly(e, ['v', 'purpose', 'objId', 'parents', 'author', 'authorLog', 'clients', 'payload', 'created']) || e.v !== 1 || e.purpose !== PURPOSE) return 'that is not a wiki version event';
    var head = headerError(e);
    if (head) return head;
    if (!Array.isArray(e.clients) || e.clients.length < 1 || e.clients.length > MAX_CLIENTS) return 'the client ids are missing or too many';
    for (var i = 0; i < e.clients.length; i++) {
      var c = e.clients[i];
      if (!isObj(c) || !hasOnly(c, ['nonce', 'id']) || typeof c.nonce !== 'string' || !NONCE.test(c.nonce) || !Number.isSafeInteger(c.id) || c.id < 0) return 'a client id is not stated properly';
    }
    var p = e.payload;
    if (!isObj(p) || !hasOnly(p, ['format', 'update', 'attachments']) || p.format !== FORMAT || typeof p.update !== 'string') return 'the edit is not in a format this version reads';
    if (p.update.length > Math.ceil(MAX_UPDATE_BYTES * 4 / 3) + 4) return 'the edit is larger than the limit';
    if (!Array.isArray(p.attachments) || p.attachments.length > MAX_ATTACHMENTS || !p.attachments.every(function (a) { return typeof a === 'string' && HASHISH.test(a); })) return 'the attachments are not a short list of hashes';
    if (typeof e.created !== 'string' || !ISO.test(e.created) || isNaN(Date.parse(e.created))) return 'the date is not stated properly';
    return null;
  }

  // Steps 2 and 3 of what a receiver checks, the same for an edit and for a list change: the author's log up to the point the event
  // names, the device listed there, and the device's signature. { ok: true } or a refusal or a wait as verifyVersion returns them.
  async function checkAuthor(env, ctx) {
    var e = env.event, did = e.author.did;
    // 2. the author's log at the point the event names
    var log = await ctx.log(did);
    if (!log || !log.inception) return pending('the author\'s identity log is not known here yet', { log: did });
    var events = log.events || [];
    if (!Array.isArray(events)) return fail('the author\'s identity log is damaged');
    if (e.authorLog.seq > events.length) return pending('the author\'s identity log is not known as far as this edit says', { log: did, seq: e.authorLog.seq });
    var v = await kd.verifyLog({ inception: log.inception, sigs: log.sigs, events: events.slice(0, e.authorLog.seq) }, did);
    if (!v.ok) return fail('the author\'s identity log does not verify: ' + v.error);
    var headEvent = e.authorLog.seq === 0 ? log.inception : events[e.authorLog.seq - 1].event;
    if (kd.b64u(await kd.eventHash(headEvent)) !== e.authorLog.head) return fail('the author\'s identity log does not end where the edit says it did');
    var dev = (v.state.devices || []).filter(function (d) { return d.id === e.author.deviceId; })[0];
    if (!dev) return fail('the author\'s device is not listed in the identity\'s log at that point (it was not added yet, or it had been removed)');

    // 3. the signature
    var okSig = false;
    try {
      var sig = bytesFromB64u(env.sig);
      if (sig.length === 64) okSig = await subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, await subtle.importKey('jwk', { kty: 'EC', crv: 'P-256', x: dev.jwk.x, y: dev.jwk.y }, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']), sig, signedBytes(e));
    } catch (x) { okSig = false; }
    if (!okSig) return fail('the signature does not verify');
    return { ok: true };
  }

  // ctx = { log(did) -> the author's identity log { inception, sigs, events } as this receiver holds it, or null if it holds none;
  //         versions(cid) -> true when this receiver has that event (an edit or a list change);
  //         writers(objId, parents) -> the DIDs that may write this page as of those parents, or null when that is not known yet
  //             (asked only for an author who is not the page's owner: the owner may always write);
  //         Y? -> the Yjs library (testing only: the default is the vendored copy) }
  async function verifyVersion(env, ctx) {
    try {
      var bad = shapeError(env);
      if (bad) return fail(bad);
      var e = env.event, did = e.author.did, Y = (ctx && ctx.Y) || Yjs;

      var who = await checkAuthor(env, ctx);          // 2 and 3: the author's log, then the signature
      if (!who.ok) return who;

      // 4. client ids, then the update itself
      var mine = {};
      for (var i = 0; i < e.clients.length; i++) {
        var want = await clientIdFor(e.author.deviceId, e.objId, e.clients[i].nonce);
        if (want !== e.clients[i].id) return fail('a client id is not the one this author\'s device would have for this page');
        if (mine[want]) return fail('a client id is stated twice');
        mine[want] = true;
      }
      var update;
      try { update = new Uint8Array(bytesFromB64u(e.payload.update)); } catch (x) { return fail('the edit is not valid base64url'); }   // a copy that owns its buffer
      if (update.length > MAX_UPDATE_BYTES) return fail('the edit is larger than the limit');
      var read, theirs;
      try { read = yu.readUpdate(update); } catch (x) { return fail('the edit is not a well-formed update'); }
      try { theirs = Y.decodeUpdate(update); } catch (x) { return fail('the edit is not an update Yjs reads'); }
      var differ = yu.sameAs(read, theirs, Y);
      if (differ) return fail('the edit is read differently by two readers (' + differ + ')');
      // `ranges`: for each client id the edit writes under, the run of clock numbers it fills, { start, end } (end is one past the last).
      // The run must be one unbroken stretch in one section of the update: a Skip inside it, a hole between two structs, or a second
      // section for the same client are all refused (Yjs applies only the last of two sections, and holds back what sits behind a hole).
      var ranges = {}, sectionOf = {};
      for (var s = 0; s < read.structs.length; s++) {
        var st = read.structs[s];
        if (!mine[st.client]) return fail('the edit writes with client id ' + st.client + ', which is not one of this author\'s');
        if (st.ref === yu.CONTENT.DOC) return fail('the edit holds a sub-document, which a wiki page does not');
        if (st.kind === 'skip') return fail('the edit has a gap in the changes it writes under client id ' + st.client);
        if (sectionOf[st.client] === undefined) sectionOf[st.client] = st.section;
        else if (sectionOf[st.client] !== st.section) return fail('the edit writes under client id ' + st.client + ' in two separate parts');
        var run = ranges[st.client];
        if (!run) ranges[st.client] = { start: st.clock, end: st.clock + st.length };
        else if (st.clock !== run.end) return fail('the changes under client id ' + st.client + ' are not one unbroken run');
        else run.end += st.length;
      }

      // 5. the parents and the right to write
      var unknown = e.parents.filter(function (p) { return !ctx.versions(p); });
      if (unknown.length) return pending('the edit follows versions that have not arrived yet', { parents: unknown });
      if (did !== parsePageId(e.objId).owner) {
        var writers = await ctx.writers(e.objId, e.parents);
        if (writers === null || writers === undefined) return pending('who may write this page is not known yet', { writers: true });
        if (!Array.isArray(writers) || writers.indexOf(did) < 0) return fail('the author may not write this page (as of the versions this edit follows)');
      }
      return { ok: true, cid: await versionId(e), did: did, deviceId: e.author.deviceId, clients: e.clients.map(function (c) { return c.id; }), structs: read.structs.length, ranges: ranges };
    } catch (x) {
      return fail('the edit could not be checked');
    }
  }

  // ---- the writer list ------------------------------------------------------------------------------------------------------------
  // The unsigned list change. o: { objId, parents, author: { did, deviceId }, authorLog: { seq, head }, change: { op, did }, created? }.
  // `parents` are the page's heads as the owner's device holds them, so that every edit made after this one follows it.
  function buildPolicy(o) {
    return { v: 1, purpose: POLICY_PURPOSE, objId: o.objId, parents: sortedUnique(o.parents || []),
      author: { did: o.author.did, deviceId: o.author.deviceId }, authorLog: { seq: o.authorLog.seq, head: o.authorLog.head },
      change: { op: o.change.op, did: o.change.did }, created: o.created || new Date().toISOString() };
  }
  function policyShapeError(env) {
    if (!isObj(env) || !hasOnly(env, ['event', 'sig']) || !isObj(env.event) || typeof env.sig !== 'string') return 'that is not a signed change of who may write a page';
    var e = env.event;
    if (!hasOnly(e, ['v', 'purpose', 'objId', 'parents', 'author', 'authorLog', 'change', 'created']) || e.v !== 1 || e.purpose !== POLICY_PURPOSE) return 'that is not a change of who may write a page';
    var head = headerError(e);
    if (head) return head;
    if (!isObj(e.change) || !hasOnly(e.change, ['op', 'did']) || OPS.indexOf(e.change.op) < 0 || typeof e.change.did !== 'string' || !kd.parseDid(e.change.did)) return 'the change does not name an identity to add or to remove';
    if (typeof e.created !== 'string' || !ISO.test(e.created) || isNaN(Date.parse(e.created))) return 'the date is not stated properly';
    return null;
  }
  // The check of one list change by itself, with the same ctx as verifyVersion (`writers` is not asked). { ok: true, cid, policy: { op, did },
  // ranges: {} (it writes no text) }, or a refusal, or a wait (the owner's log, a parent) as verifyVersion returns them. Only the page's owner
  // may sign one, it may not name the owner, and the owner's device must be listed at the point of the owner's log it claims.
  async function verifyPolicy(env, ctx) {
    try {
      var bad = policyShapeError(env);
      if (bad) return fail(bad);
      var e = env.event, page = parsePageId(e.objId);
      if (e.author.did !== page.owner) return fail('only the page\'s owner may change who may write it');
      if (e.change.did === page.owner) return fail('the page\'s owner may always write it, so the list does not name the owner');
      var who = await checkAuthor(env, ctx);
      if (!who.ok) return who;
      var unknown = e.parents.filter(function (p) { return !ctx.versions(p); });
      if (unknown.length) return pending('the change follows versions that have not arrived yet', { parents: unknown });
      return { ok: true, cid: await versionId(e), did: e.author.did, deviceId: e.author.deviceId, policy: { op: e.change.op, did: e.change.did }, ranges: {} };
    } catch (x) {
      return fail('the change could not be checked');
    }
  }
  // WHO MAY WRITE as of the list changes in the history an edit follows: the DIDs, the owner first and then the others in order, or null
  // when a change is not known (get has nothing for it). `cids` lists every list change in that history once. `get(cid)` gives
  // { event, pol }: the change's event and `pol`, the cids of the list changes in ITS OWN history, itself included (the store keeps this with
  // every event). A name counts when some add of it comes after every removal of it: "after" is "that removal is in the add's own history",
  // so a removal made at the same time as an add, on another device of the owner, beats it, and an add made once the removal was seen
  // brings the name back. It decides nothing about WHEN an edit was made: it is a function of the history alone.
  function writersFrom(owner, cids, get) {
    var adds = {}, removes = {};
    for (var i = 0; i < cids.length; i++) {
      var p = get(cids[i]);
      if (!p || !p.event || !isObj(p.event.change) || !Array.isArray(p.pol)) return null;
      var c = p.event.change, bucket = c.op === 'add-writer' ? adds : removes;
      (bucket[c.did] || (bucket[c.did] = [])).push({ cid: cids[i], pol: p.pol });
    }
    var out = [];
    Object.keys(adds).sort().forEach(function (x) {
      if (x === owner) return;
      var counts = adds[x].some(function (a) { return (removes[x] || []).every(function (r) { return a.pol.indexOf(r.cid) >= 0; }); });
      if (counts) out.push(x);
    });
    return [owner].concat(out);
  }

  // ---- the history as a graph ----------------------------------------------------------------------------------------------------
  // `get(cid)` returns the envelope the receiver holds for that version, or undefined.
  // The cids of `heads` and of everything they follow, parents before children (ties broken by cid, so every receiver lists them in the
  // same order); `missing` lists the versions that were named and are not held.
  function closure(heads, get) {
    var order = [], state = {}, missing = [];
    function visit(cid) {
      if (state[cid]) return;
      state[cid] = 1;
      var env = get(cid);
      if (!env) { missing.push(cid); return; }
      env.event.parents.slice().sort().forEach(visit);
      order.push(cid);
    }
    heads.slice().sort().forEach(visit);
    return { order: order, missing: missing };
  }
  // Of a set of held versions, the ones no other of them follows: the page's heads. One head is a plain history; several are
  // edits made at the same time that nobody has merged yet.
  function headsOf(cids, get) {
    var named = {};
    cids.forEach(function (c) { var env = get(c); if (env) env.event.parents.forEach(function (p) { named[p] = true; }); });
    return cids.filter(function (c) { return !named[c]; }).sort();
  }

  return { PURPOSE: PURPOSE, POLICY_PURPOSE: POLICY_PURPOSE, FORMAT: FORMAT, OPS: OPS, MAX_UPDATE_BYTES: MAX_UPDATE_BYTES, MAX_CLIENTS: MAX_CLIENTS,
    MAX_WRITERS: MAX_WRITERS, MAX_POLICY_EVENTS: MAX_POLICY_EVENTS, MAX_NAME: MAX_NAME,
    pageId: pageId, parsePageId: parsePageId, clientIdFor: clientIdFor, buildVersion: buildVersion, buildPolicy: buildPolicy,
    signedBytes: signedBytes, versionId: versionId, seal: seal, logPoint: logPoint,
    verifyVersion: verifyVersion, verifyPolicy: verifyPolicy, writersFrom: writersFrom, closure: closure, headsOf: headsOf };
});
