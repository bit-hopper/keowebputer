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
//                objId,                             the page (a short text the page's owner fixes; not interpreted here)
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
//   5. the parents are known (otherwise the event waits: `pending`), and the author is a writer of the page as of those parents.
//
// A result is { ok: true, cid, ... }, or { ok: false, error }, or { ok: false, pending: true, waitFor, error } when only something that
// has not arrived yet is missing (the author's log, a parent, the page's writer list). A pending event is neither accepted nor
// refused: the caller keeps it and asks again when the missing piece arrives.
//
// NOT DONE HERE (later steps of the same track): the signed writer list that decides who may write (the caller passes `ctx.writers`),
// where events are kept, how they travel, and a check that one author's client clocks continue where its earlier events stopped.
(function (root, factory) {
  var node = typeof module === 'object' && module.exports;
  var api = factory(node ? require('./keo-did.js') : root.keoDid, node ? require('./keo-yupdate.js') : root.keoYUpdate, node ? require('./keo-yjs.js') : root.keoYjs);
  if (node) module.exports = api; else root.keoWikiLog = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (kd, yu, Yjs) {
  'use strict';

  var subtle = globalThis.crypto.subtle, enc = new TextEncoder();
  var PURPOSE = 'keo-wiki-version', FORMAT = 'yjs-update-v1';
  var MAX_UPDATE_BYTES = 4 * 1024 * 1024, MAX_PARENTS = 64, MAX_CLIENTS = 8, MAX_ATTACHMENTS = 64, MAX_OBJID = 128, MAX_SEQ = 1e9;
  var CID = /^[A-Za-z0-9_-]{43}$/, NONCE = /^[A-Za-z0-9_-]{8,43}$/, HASHISH = /^[A-Za-z0-9_-]{16,128}$/;
  var ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;

  function isObj(x) { return !!x && typeof x === 'object' && !Array.isArray(x); }
  function hasOnly(o, keys) { return Object.keys(o).every(function (k) { return keys.indexOf(k) >= 0; }); }
  function fail(error) { return { ok: false, error: error }; }
  function pending(error, waitFor) { return { ok: false, pending: true, waitFor: waitFor, error: error }; }
  function bytesFromB64u(s) { var b = kd.unb64u(s); if (kd.b64u(b) !== s) throw new Error('not canonical base64url'); return b; }

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
  // null when the envelope has the right shape and sizes, else a sentence. Looks at nothing but the shape.
  function shapeError(env) {
    if (!isObj(env) || !hasOnly(env, ['event', 'sig']) || !isObj(env.event) || typeof env.sig !== 'string') return 'that is not a signed wiki version';
    var e = env.event;
    if (!hasOnly(e, ['v', 'purpose', 'objId', 'parents', 'author', 'authorLog', 'clients', 'payload', 'created']) || e.v !== 1 || e.purpose !== PURPOSE) return 'that is not a wiki version event';
    if (typeof e.objId !== 'string' || !e.objId.length || e.objId.length > MAX_OBJID) return 'the page name is missing or too long';
    if (!Array.isArray(e.parents) || e.parents.length > MAX_PARENTS || !e.parents.every(function (p) { return typeof p === 'string' && CID.test(p); })) return 'the parents are not a short list of version ids';
    if (kd.canonicalJson(e.parents) !== kd.canonicalJson(sortedUnique(e.parents))) return 'the parents are not sorted and unique';
    if (!isObj(e.author) || !hasOnly(e.author, ['did', 'deviceId']) || !kd.parseDid(e.author.did) || typeof e.author.deviceId !== 'string' || !e.author.deviceId || e.author.deviceId.length > 64) return 'the author is not named properly';
    var al = e.authorLog;
    if (!isObj(al) || !hasOnly(al, ['seq', 'head']) || !Number.isInteger(al.seq) || al.seq < 0 || al.seq > MAX_SEQ || typeof al.head !== 'string' || !CID.test(al.head)) return 'the point of the author\'s log is not stated properly';
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

  // ctx = { log(did) -> the author's identity log { inception, sigs, events } as this receiver holds it, or null if it holds none;
  //         versions(cid) -> true when this receiver has that version;
  //         writers(objId, parents) -> the DIDs that may write this page as of those parents, or null when that is not known yet;
  //         Y? -> the Yjs library (testing only: the default is the vendored copy) }
  async function verifyVersion(env, ctx) {
    try {
      var bad = shapeError(env);
      if (bad) return fail(bad);
      var e = env.event, did = e.author.did, Y = (ctx && ctx.Y) || Yjs;

      // 2. the author's log at the point the edit names
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
      for (var s = 0; s < read.structs.length; s++) {
        if (!mine[read.structs[s].client]) return fail('the edit writes with client id ' + read.structs[s].client + ', which is not one of this author\'s');
        if (read.structs[s].ref === yu.CONTENT.DOC) return fail('the edit holds a sub-document, which a wiki page does not');
      }

      // 5. the parents and the right to write
      var unknown = e.parents.filter(function (p) { return !ctx.versions(p); });
      if (unknown.length) return pending('the edit follows versions that have not arrived yet', { parents: unknown });
      var writers = await ctx.writers(e.objId, e.parents);
      if (writers === null || writers === undefined) return pending('who may write this page is not known yet', { writers: true });
      if (!Array.isArray(writers) || writers.indexOf(did) < 0) return fail('the author may not write this page (as of the versions this edit follows)');
      return { ok: true, cid: await versionId(e), did: did, deviceId: e.author.deviceId, clients: e.clients.map(function (c) { return c.id; }), structs: read.structs.length };
    } catch (x) {
      return fail('the edit could not be checked');
    }
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

  return { PURPOSE: PURPOSE, FORMAT: FORMAT, MAX_UPDATE_BYTES: MAX_UPDATE_BYTES, MAX_CLIENTS: MAX_CLIENTS,
    clientIdFor: clientIdFor, buildVersion: buildVersion, signedBytes: signedBytes, versionId: versionId, seal: seal, logPoint: logPoint,
    verifyVersion: verifyVersion, closure: closure, headsOf: headsOf };
});
