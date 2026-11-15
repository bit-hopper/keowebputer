// The local store of a shared wiki page's history, SHELL side: the version events (keo-wikilog.js) a device holds, the ones still waiting
// for something, and the identity logs they are checked against. Pure logic over a small backend (memoryBackend below, or one over
// IndexedDB later), so a Node test can run it. No DOM, no network, no passkey.
//
// SEALED ON DISK. Like the chats, the contacts and the library, every record is AES-GCM under the signed-in identity's session key
// (keoIdentity.sessionWorldKey(), passed in as `key`), with the store, the identity and the record's id as additional data, so a record
// cannot be moved to another identity or slot. Readable without the key: random-looking ids (hashes), sizes and the order of writes.
// Which pages, which authors, whose identity logs and what was written are all inside the encryption.
// This is encryption AT REST on this device. It is not the encryption of a private page's events for its readers (a later step): the
// events themselves are signed, plain and the same on every device.
//
// WHAT IT DOES
//   offerLog(did, log)  keeps, for each identity, the LONGEST verified log it has been shown (the check of keo-wikilog.js reads the
//                       author's log). A longer log that extends the kept one replaces it; a shorter one, or the same, changes nothing;
//                       one that disagrees with it about an event it already holds (a fork) is NOT taken: the first one seen stays, and
//                       the disagreement is kept as an alert for the person to see. This is the core of "pin the longest log": it is
//                       what lets a removal reach everyone who is shown the newer log. Feeding it from connections and cards is later.
//   add(envelope)       checks one version event with keo-wikilog.js and then, which that file cannot, against the ancestry it follows:
//                       each client id's clock numbers must continue exactly where the earlier edits under it stopped. An edit that skips
//                       ahead (Yjs would hold it back for ever) or that reuses numbers already used (a device that lost its copy and
//                       started again under the same id) is refused. Two different edits that claim the same numbers are an
//                       EQUIVOCATION: the one that arrives second is refused and the pair is kept as an alert (first seen wins; a
//                       device that behaves honestly never does this, because it starts over under a fresh nonce).
//                       An edit that is only waiting for a parent, a log or the writer list is kept as pending and checked again, by
//                       itself, whenever something arrives that could settle it.
//   heads, versions, state   what a page's history looks like and the Yjs state at a set of versions (default: the current heads).
//   close()             for a session that ended: operations that have not started are refused from then on (see serial()).
// Not here: checkpoints and dropping old events, private pages, how events travel. The IndexedDB backend and the store's lifetime in the
// shell (made for the signed-in identity, closed when the session ends, its records deleted when the identity is removed) are keo-wiki.js.
(function (root, factory) {
  var node = typeof module === 'object' && module.exports;
  var api = factory(node ? require('./keo-did.js') : root.keoDid, node ? require('./keo-wikilog.js') : root.keoWikiLog, node ? require('./keo-yjs.js') : root.keoYjs);
  if (node) module.exports = api; else root.keoWikiStore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (kd, W, Yjs) {
  'use strict';

  var enc = new TextEncoder(), dec = new TextDecoder();
  var MAX_PENDING = 200, MAX_ALERTS = 200;

  // The backend is { get(kind, id), put(kind, id, rec), del(kind, id), ids(kind) }, all async; a record is { iv: base64url, ct: Uint8Array }.
  // Kinds used: 'page', 'version', 'pending', 'log', 'meta'.
  function memoryBackend() {
    var data = {};
    function bucket(k) { return data[k] || (data[k] = new Map()); }
    return {
      get: async function (k, id) { return bucket(k).get(id); },
      put: async function (k, id, rec) { bucket(k).set(id, rec); },
      del: async function (k, id) { bucket(k).delete(id); },
      ids: async function (k) { return Array.from(bucket(k).keys()); },
      // for tests: what is on "disk"
      dump: function () { var out = {}; Object.keys(data).forEach(function (k) { out[k] = Array.from(data[k].entries()); }); return out; }
    };
  }

  // o: { backend, key (an AES-GCM CryptoKey), did (the identity whose store this is), writers(objId, parents) -> the DIDs that may write
  //      that page as of those parents, or null when not known yet (it may return a promise), now? (a clock for the alerts), Y? (testing) }
  function create(o) {
    var backend = o.backend, key = o.key, owner = o.did, now = o.now || function () { return new Date().toISOString(); };
    var Y = o.Y || Yjs;
    var pages = new Map(), logs = new Map(), chain = Promise.resolve(), closed = false;
    // Operations run one after another: two adds that both read the same page state could each accept an edit the other makes impossible.
    // After close() an operation that has not started refuses to; the one that is running finishes (it was begun while the session was).
    function serial(fn) {
      var p = chain.then(function () { if (closed) throw new Error('The wiki store is closed (the session ended).'); return fn(); });
      chain = p.catch(function () {});
      return p;
    }

    async function pageKey(objId) { return kd.b64u(await kd.sha256(enc.encode('keo-wiki-page\u0000' + objId))); }
    async function logKey(did) { return kd.b64u(await kd.sha256(enc.encode('keo-wiki-log\u0000' + did))); }
    function aad(kind, id) { return enc.encode('keo-wiki-' + kind + '\n' + owner + '\n' + id); }
    async function seal(kind, id, obj) {
      var iv = crypto.getRandomValues(new Uint8Array(12));
      var ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv, additionalData: aad(kind, id) }, key, enc.encode(JSON.stringify(obj)));
      return { iv: kd.b64u(iv), ct: new Uint8Array(ct) };
    }
    async function open(kind, id, rec) {
      try { return JSON.parse(dec.decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: kd.unb64u(rec.iv), additionalData: aad(kind, id) }, key, rec.ct))); }
      catch (e) { throw new Error('The wiki store could not be decrypted (wrong identity, or a record was changed).'); }
    }
    async function read(kind, id) { var rec = await backend.get(kind, id); return rec ? open(kind, id, rec) : null; }
    async function write(kind, id, obj) { await backend.put(kind, id, await seal(kind, id, obj)); }

    // ---- alerts: what a person may need to be told (a fork of an identity's log, two edits that claim the same clock numbers) ----------
    async function alert(entry) {
      var list = (await read('meta', 'alerts')) || [];
      list.push(Object.assign({ at: now() }, entry));
      if (list.length > MAX_ALERTS) list = list.slice(list.length - MAX_ALERTS);
      await write('meta', 'alerts', list);
    }

    // ---- identity logs: the longest verified log per identity -----------------------------------------------------------------------
    async function pinnedLog(did) {
      if (logs.has(did)) return logs.get(did);
      var l = await read('log', await logKey(did));
      if (l) logs.set(did, l);
      return l;
    }
    async function offerLogNow(did, log) {
      var v;
      try { v = await kd.verifyLog(log, did); } catch (e) { v = { ok: false, error: 'the log could not be checked' }; }
      if (!v.ok) return { status: 'refused', error: 'that identity log does not verify: ' + v.error };
      var clean = { inception: log.inception, sigs: log.sigs, events: (log.events || []).map(function (x) { return { event: x.event, sigs: x.sigs }; }) };
      var kept = await pinnedLog(did);
      async function pin() { await write('log', await logKey(did), clean); logs.set(did, clean); }
      if (!kept) { await pin(); return { status: 'new', seq: clean.events.length }; }
      var cmp = kd.compareLogs(kept, clean);
      if (cmp.status === 'fork') {
        await alert({ kind: 'log-fork', did: did, at: cmp.at });
        return { status: 'fork', at: cmp.at, error: 'that identity log disagrees with the one already kept about event ' + cmp.at + '; the first one seen is kept' };
      }
      if (cmp.status === 'extended') { await pin(); return { status: 'extended', seq: clean.events.length }; }
      return { status: cmp.status, seq: kept.events.length };
    }
    async function offerLog(did, log) {
      return serial(async function () {
        var r = await offerLogNow(did, log);
        if (r.status === 'extended' || r.status === 'new') r.settled = await settleAll();
        return r;
      });
    }

    // ---- pages ----------------------------------------------------------------------------------------------------------------------
    async function loadPage(objId) {
      if (pages.has(objId)) return pages.get(objId);
      var id = await pageKey(objId), rec = (await read('page', id)) || { objId: objId, cids: [], pending: [] };
      var page = { objId: objId, id: id, versions: new Map(), pending: new Map(), byClient: new Map() };
      for (var i = 0; i < rec.cids.length; i++) {
        var v = await read('version', rec.cids[i]);
        if (!v) throw new Error('The wiki store is missing a version it lists (' + rec.cids[i].slice(0, 8) + ').');
        index(page, rec.cids[i], v);
      }
      for (var j = 0; j < rec.pending.length; j++) { var pr = await read('pending', rec.pending[j]); if (pr) page.pending.set(rec.pending[j], pr); }
      pages.set(objId, page);
      return page;
    }
    function index(page, cid, v) {
      page.versions.set(cid, v);
      Object.keys(v.ranges).forEach(function (c) {
        var list = page.byClient.get(c) || [];
        list.push({ cid: cid, start: v.ranges[c].start, end: v.ranges[c].end });
        page.byClient.set(c, list);
      });
    }
    async function savePage(page) { await write('page', page.id, { objId: page.objId, cids: Array.from(page.versions.keys()), pending: Array.from(page.pending.keys()) }); }

    function ctxFor(page) {
      return {
        log: async function (did) { return pinnedLog(did); },
        versions: function (cid) { return page.versions.has(cid); },
        writers: async function (objId, parents) { return o.writers ? o.writers(objId, parents) : null; },
        Y: o.Y
      };
    }
    // The end of each client's clock numbers among a set of versions and everything they follow, from what each held version recorded.
    function endsAmong(page, parents) {
      var ends = {};
      parents.forEach(function (p) { var v = page.versions.get(p); Object.keys(v.ends).forEach(function (c) { if (!(ends[c] >= v.ends[c])) ends[c] = v.ends[c]; }); });
      return ends;
    }
    // null when the edit's clock numbers continue exactly where its ancestry left each client, else { kind, error, ... }
    function clockProblem(page, env, ranges) {
      var base = endsAmong(page, env.event.parents), clients = Object.keys(ranges);
      for (var i = 0; i < clients.length; i++) {
        var c = clients[i], want = base[c] || 0, r = ranges[c];
        if (r.start > want) return { kind: 'clock-ahead', client: c, error: 'the edit skips ahead of its author\'s earlier edits (client id ' + c + ' starts at ' + r.start + ', the edits it follows end at ' + want + ')' };
        if (r.start < want) return { kind: 'clock-reused', client: c, error: 'the edit reuses clock numbers its author already used (client id ' + c + ' starts at ' + r.start + ', the edits it follows end at ' + want + ')' };
        var clash = (page.byClient.get(c) || []).filter(function (x) { return x.start < r.end && r.start < x.end; })[0];
        if (clash) return { kind: 'equivocation', client: c, other: clash.cid, error: 'two different edits claim the same clock numbers under client id ' + c + ' (the first one seen is kept)' };
      }
      return null;
    }

    // Runs the check of keo-wikilog.js and the clock check; returns { status, ... } without changing anything.
    async function judge(page, env) {
      var r = await W.verifyVersion(env, ctxFor(page));
      if (r.ok) {
        var bad = clockProblem(page, env, r.ranges);
        if (bad) return { status: 'refused', cid: r.cid, error: bad.error, problem: bad };
        return { status: 'accepted', cid: r.cid, result: r };
      }
      if (r.pending) return { status: 'pending', waitFor: r.waitFor, error: r.error };
      return { status: 'refused', error: r.error };
    }
    async function accept(page, cid, env, r) {
      var ends = endsAmong(page, env.event.parents);
      Object.keys(r.ranges).forEach(function (c) { ends[c] = r.ranges[c].end; });
      var v = { env: env, ranges: r.ranges, ends: ends };
      await write('version', cid, v);          // the version first, then the list that names it: a crash between them leaves an unused record, never a list with a hole
      index(page, cid, v);
      page.pending.delete(cid);
      await backend.del('pending', cid);
      await savePage(page);
    }
    // Checks every pending edit of a page again, as long as one more of them gets settled; returns the cids accepted.
    async function settle(page) {
      var accepted = [], progress = true;
      while (progress) {
        progress = false;
        var cids = Array.from(page.pending.keys());
        for (var i = 0; i < cids.length; i++) {
          var rec = page.pending.get(cids[i]);
          var j = await judge(page, rec.env);
          if (j.status === 'accepted') { await accept(page, j.cid, rec.env, j.result); accepted.push(j.cid); progress = true; }
          else if (j.status === 'refused') {
            page.pending.delete(cids[i]); await backend.del('pending', cids[i]); await savePage(page); progress = true;
            await alert({ kind: 'pending-refused', objId: page.objId, cid: cids[i], error: j.error });
          } else { rec.waitFor = j.waitFor; }
        }
      }
      return accepted;
    }
    async function settleAll() {
      var out = [];
      for (var it of Array.from(pages.values())) { if (it.pending.size) out = out.concat(await settle(it)); }
      return out;
    }

    async function addNow(env) {
      var objId = env && env.event && typeof env.event.objId === 'string' ? env.event.objId : null;
      if (objId === null) { var shape = await W.verifyVersion(env, { log: async function () { return null; }, versions: function () { return false; }, writers: async function () { return null; } }); return { status: 'refused', error: shape.error }; }
      var page = await loadPage(objId), cid;
      try { cid = await W.versionId(env.event); } catch (e) { return { status: 'refused', error: 'that is not a wiki version event' }; }
      if (page.versions.has(cid)) return { status: 'duplicate', cid: cid };
      var j = await judge(page, env);
      if (j.status === 'accepted') {
        await accept(page, cid, env, j.result);
        var more = await settle(page);
        return { status: 'accepted', cid: cid, alsoAccepted: more };
      }
      if (j.status === 'pending') {
        if (!page.pending.has(cid) && page.pending.size >= MAX_PENDING) return { status: 'refused', cid: cid, error: 'too many edits are waiting for something that has not arrived' };
        var rec = { env: env, waitFor: j.waitFor, since: now() };
        page.pending.set(cid, rec);
        await write('pending', cid, rec);
        await savePage(page);
        return { status: 'pending', cid: cid, waitFor: j.waitFor, error: j.error };
      }
      if (j.problem && j.problem.kind === 'equivocation') await alert({ kind: 'equivocation', objId: objId, did: env.event.author.did, client: j.problem.client, cids: [j.problem.other, cid] });
      else if (j.problem) await alert({ kind: j.problem.kind, objId: objId, did: env.event.author.did, cid: cid });
      return { status: 'refused', cid: cid, error: j.error };
    }

    // ---- reading --------------------------------------------------------------------------------------------------------------------
    function getter(page) { return function (cid) { var v = page.versions.get(cid); return v && v.env; }; }

    var api = {
      offerLog: offerLog,
      logOf: function (did) { return serial(function () { return pinnedLog(did); }); },
      add: function (env) { return serial(function () { return addNow(env); }); },
      // checks the page's waiting edits again (after the caller learned something: a new writer list, say)
      recheck: function (objId) { return serial(async function () { return settle(await loadPage(objId)); }); },
      heads: function (objId) { return serial(async function () { var p = await loadPage(objId); return W.headsOf(Array.from(p.versions.keys()), getter(p)); }); },
      has: function (objId, cid) { return serial(async function () { return (await loadPage(objId)).versions.has(cid); }); },
      pending: function (objId) { return serial(async function () { var p = await loadPage(objId); return Array.from(p.pending.entries()).map(function (e) { return { cid: e[0], waitFor: e[1].waitFor, since: e[1].since }; }); }); },
      // the page's versions, parents before children: for a history list
      versions: function (objId) {
        return serial(async function () {
          var p = await loadPage(objId), get = getter(p), cl = W.closure(W.headsOf(Array.from(p.versions.keys()), get), get);
          return cl.order.map(function (cid) { var e = get(cid).event; return { cid: cid, did: e.author.did, parents: e.parents, created: e.created }; });
        });
      },
      // the Yjs state at `heads` (default: the page's current heads): { update, cids }; apply `update` to a Y.Doc to read the page
      state: function (objId, heads) {
        return serial(async function () {
          var p = await loadPage(objId), get = getter(p);
          var at = heads || W.headsOf(Array.from(p.versions.keys()), get), cl = W.closure(at, get);
          if (cl.missing.length) throw new Error('That version is not held here.');
          var updates = cl.order.map(function (cid) { return kd.unb64u(get(cid).event.payload.update); });
          return { update: updates.length ? Y.mergeUpdates(updates) : Y.encodeStateAsUpdate(new Y.Doc()), cids: cl.order };
        });
      },
      alerts: function () { return serial(async function () { return (await read('meta', 'alerts')) || []; }); },
      // removes everything this store holds (an identity removed from this device takes its pages with it)
      purge: function () {
        return serial(async function () {
          var kinds = ['page', 'version', 'pending', 'log', 'meta'];
          for (var k = 0; k < kinds.length; k++) { var ids = await backend.ids(kinds[k]); for (var i = 0; i < ids.length; i++) await backend.del(kinds[k], ids[i]); }
          pages.clear(); logs.clear();
        });
      },
      // forgets what is held in memory, so the next call reads the (sealed) records again: for tests and for a session that ended
      unload: function () { return serial(async function () { pages.clear(); logs.clear(); }); },
      // For a session that ended: every operation that has not started yet is refused from now on, and what is held in memory is dropped once
      // the one that is running has finished. Resolves then, which is when nothing of this store can still be written (the caller removing
      // an identity waits for it before it deletes the records, so a late write cannot bring them back). It cannot be undone: open a new store.
      close: function () { closed = true; return chain.then(function () { pages.clear(); logs.clear(); }); }
    };
    return api;
  }

  return { create: create, memoryBackend: memoryBackend };
});
