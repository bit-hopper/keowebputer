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
//                       An edit that is only waiting for a parent or a log is kept as pending and checked again, by itself, whenever
//                       something arrives that could settle it.
//                       The same call takes the owner's signed CHANGES OF THE WRITER LIST (keo-wikilog.js, the `keo-wiki-policy` event),
//                       which sit in the page's history beside the edits. Who may write a page is worked out here, from the history an
//                       edit follows: the owner (read out of the page's id) and whoever the owner's changes in that history name. Each
//                       held event records which list changes it follows (`pol`), so the answer is a merge of small lists, not a walk.
//   heads, versions, state   what a page's history looks like and the Yjs state at a set of versions (default: the current heads). The
//                       heads include list changes: a new edit names them as parents, so that it follows the list as the author knew it.
//   writers(objId, heads?)   who may write the page as of those versions (default: the current heads): the DIDs, the owner first.
//   pages(), summary(objId)  every page held, newest change first, with what a list shows of each (created, category, tags: read out of the
//                       page's own history and kept in its sealed record while it holds the same versions, see "what a list of pages shows").
//   text(objId)         the page's readable text for searching it, kept sealed in a record of its own while the page holds the same versions
//   info(objId)         how many versions and waiting edits a page holds and when this device last changed it (for a reading view)
//   remove(objId)       takes one page off this device: its record, versions, waiting edits and kept text (not undone)
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

  // o: { backend, key (an AES-GCM CryptoKey), did (the identity whose store this is), now? (a clock for the alerts), Y? (testing) }
  // There is no way to tell the store who may write a page: it reads that out of the history it holds (a page's owner, then the owner's
  // signed changes), so nobody who can call it can grant a right the owner did not sign.
  function create(o) {
    var backend = o.backend, key = o.key, owner = o.did, now = o.now || function () { return new Date().toISOString(); };
    var Y = o.Y || Yjs;
    var pages = new Map(), logs = new Map(), chain = Promise.resolve(), closed = false;
    // Which prefixes of an author's log have already been checked in full (keo-wikilog.js logCheckCache says what is kept and why it is safe).
    // Memory only, never written to disk, and emptied wherever the store forgets what it holds in memory.
    var logChecks = W.logCheckCache();
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
      // A shorter log is not taken, but the one that is kept is handed back with the answer: a verifier that was shown the older copy checks the
      // device against this one, which names everything removed since. The caller must not change it.
      if (cmp.status === 'shorter') return { status: 'shorter', seq: kept.events.length, kept: kept };
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
      var page = { objId: objId, id: id, versions: new Map(), pending: new Map(), byClient: new Map(), touched: rec.touched || null, sum: rec.sum || null };
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
    // `touched` is when THIS device last took something into the page (its own clock, set in accept): what a page list shows as "last
    // changed here". It is not the author's claim (an event's `created`), which nothing in a receiver should rely on. A page record written
    // before the field existed has none: null.
    async function savePage(page) { await write('page', page.id, { objId: page.objId, cids: Array.from(page.versions.keys()), pending: Array.from(page.pending.keys()), touched: page.touched, sum: page.sum }); }

    // ---- what a list of pages shows of each page (created, category, tags) ----------------------------------------------------------
    // Read out of the page's own history and kept in the page's record, so that listing the pages costs one small record each and not a read
    // of every version of every page. It is a CACHE: it names the versions it was worked out from (`k`: how many are held and the last one
    // taken in), it is used only while those are the versions the page holds, and it is worked out again, from the history, the moment they
    // are not. Nothing in it is a claim anyone made that the store takes on trust: category and tags are read from the page's `meta` map
    // (what any writer of the page may set, so they are cut to size and shape below: a writer could put anything there), and `created` is
    // the earliest date any held edit states (an author's own word, as every `created` is: it orders pages on this person's list, nothing
    // more). Not here: the page's title or text (a later step).
    var MAX_CATEGORY = 40, MAX_TAGS = 20, MAX_TAG = 40;
    function sumKey(cids) { return cids.length + ':' + (cids.length ? cids[cids.length - 1] : ''); }
    function cleanLabel(x, max) {
      if (typeof x !== 'string') return null;
      var s = x.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
      return s && s.length <= max ? s : null;
    }
    function metaOf(doc) {
      var map = doc.getMap('meta'), category = cleanLabel(map.get('category'), MAX_CATEGORY), raw = map.get('tags'), tags = [];
      if (Array.isArray(raw)) {
        for (var i = 0; i < raw.length && tags.length < MAX_TAGS; i++) { var t = cleanLabel(raw[i], MAX_TAG); if (t && tags.indexOf(t) < 0) tags.push(t); }
      }
      return { category: category, tags: tags };
    }
    // The summary of a loaded page: the cached one while it still matches what the page holds, else worked out now (and kept).
    async function summarize(page) {
      var cids = Array.from(page.versions.keys()), k = sumKey(cids);
      // A page with no version held (one that is only waiting for something, or that is not here at all) has nothing to summarise, and
      // writes nothing: asking about a page must never make a record for it.
      if (!cids.length) return { created: null, category: null, tags: [] };
      if (page.sum && page.sum.k === k) return page.sum.v;
      var get = getter(page), heads = W.headsOf(cids, get), created = null;
      cids.forEach(function (cid) {
        var e = get(cid).event;
        if (e.purpose !== W.PURPOSE) return;                    // a change of the writer list is not an edit of the page
        if (created === null || Date.parse(e.created) < Date.parse(created)) created = e.created;
      });
      var doc = new Y.Doc();
      Y.applyUpdate(doc, stateAt(page, heads).update);
      var v = Object.assign({ created: created }, metaOf(doc));
      page.sum = { k: k, v: v };
      await savePage(page);
      return v;
    }
    // The Yjs state at a set of versions: { update, cids }. Throws when one of them (or something it follows) is not held.
    function stateAt(page, at) {
      var get = getter(page), cl = W.closure(at, get);
      if (cl.missing.length) throw new Error('That version is not held here.');
      // a list change carries no text: only edits give updates
      var updates = cl.order.filter(function (cid) { return get(cid).event.purpose === W.PURPOSE; }).map(function (cid) { return kd.unb64u(get(cid).event.payload.update); });
      return { update: updates.length ? Y.mergeUpdates(updates) : Y.encodeStateAsUpdate(new Y.Doc()), cids: cl.order };
    }

    // ---- the page's text, for searching it ------------------------------------------------------------------------------------------
    // The readable text of a page (what a person typed into its paragraphs, headings, lists and code cells, one block to a line), worked out
    // from the history the way the summary is and kept the same way: sealed, in a record of its own (kind `meta`, id `text:<page id>`), naming
    // the versions it was worked out from and used only while those are the versions the page holds. A record of its own so that listing the
    // pages never decrypts every page's text. It is a CACHE of what the history says: nothing here is a claim anyone made, and what a writer
    // put in the page is cut to size (a page can be made to hold a great deal) and read without ever following more than MAX_NODES nodes.
    var MAX_TEXT = 256 * 1024, MAX_NODES = 200000;
    function textOf(doc) {
      var out = [], size = 0, nodes = 0, stack = [{ list: doc.getXmlFragment('prosemirror').toArray(), i: 0 }];
      function add(s) { if (size >= MAX_TEXT || !s) return; s = s.slice(0, MAX_TEXT - size); out.push(s); size += s.length; }
      while (stack.length && size < MAX_TEXT && nodes < MAX_NODES) {
        var top = stack[stack.length - 1];
        if (top.i >= top.list.length) { stack.pop(); if (stack.length) add('\n'); continue; }
        var n = top.list[top.i++];
        nodes++;
        if (n instanceof Y.XmlText) {
          // the pieces of typed text, not their formatting: toString() would bring the marks back as tags, and does not escape what is typed
          n.toDelta().forEach(function (op) { if (typeof op.insert === 'string') add(op.insert); });
        } else if (n instanceof Y.XmlElement) {
          stack.push({ list: n.toArray(), i: 0 });
        }
      }
      return out.join('').replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, ' ').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
    }
    async function textNow(objId) {
      var id = await pageKey(objId), held = pages.get(objId), cids = held ? Array.from(held.versions.keys()) : ((await read('page', id)) || { cids: [] }).cids;
      // a page with no version held has no text, and asking about it writes nothing
      if (!cids.length) return '';
      var k = sumKey(cids), kept = await read('meta', 'text:' + id);
      if (kept && kept.k === k && typeof kept.t === 'string') return kept.t;
      var page = await loadPage(objId), got = Array.from(page.versions.keys()), doc = new Y.Doc();
      Y.applyUpdate(doc, stateAt(page, W.headsOf(got, getter(page))).update);
      var t = textOf(doc);
      await write('meta', 'text:' + id, { k: sumKey(got), t: t });
      return t;
    }

    function ctxFor(page) {
      return {
        log: async function (did) { return pinnedLog(did); },
        logChecks: logChecks,
        versions: function (cid) { return page.versions.has(cid); },
        writers: async function (objId, parents) { return writersAmong(page, objId, parents); },
        Y: o.Y
      };
    }
    // The list changes (their cids, sorted) in the history a set of versions follows, merged from what each held version recorded.
    // A record written before list changes existed has no `pol`: it follows none.
    function polAmong(page, parents) {
      var set = new Set();
      parents.forEach(function (p) { var v = page.versions.get(p); ((v && v.pol) || []).forEach(function (c) { set.add(c); }); });
      return Array.from(set).sort();
    }
    // The DIDs that may write the page as of a set of versions, the owner first; null only if a list change is not held (it is, whenever
    // the versions that follow it are).
    function writersAmong(page, objId, parents) {
      var pid = W.parsePageId(objId);
      if (!pid) return null;
      return W.writersFrom(pid.owner, polAmong(page, parents), function (cid) { var v = page.versions.get(cid); return v && { event: v.env.event, pol: v.pol || [] }; });
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
      if (env && env.event && env.event.purpose === W.POLICY_PURPOSE) return judgePolicy(page, env);
      var r = await W.verifyVersion(env, ctxFor(page));
      if (r.ok) {
        var bad = clockProblem(page, env, r.ranges);
        if (bad) return { status: 'refused', cid: r.cid, error: bad.error, problem: bad };
        return { status: 'accepted', cid: r.cid, result: r };
      }
      if (r.pending) return { status: 'pending', waitFor: r.waitFor, error: r.error };
      return { status: 'refused', error: r.error };
    }
    // A change of the writer list: checked by itself (keo-wikilog.js verifyPolicy), then against the two limits that keep what is held per
    // page bounded. Nothing here depends on the clocks: a list change writes no text.
    async function judgePolicy(page, env) {
      var r = await W.verifyPolicy(env, ctxFor(page));
      if (r.pending) return { status: 'pending', waitFor: r.waitFor, error: r.error };
      if (!r.ok) return { status: 'refused', error: r.error };
      var parents = env.event.parents;
      if (polAmong(page, parents).length + 1 > W.MAX_POLICY_EVENTS) return { status: 'refused', cid: r.cid, error: 'this page has had as many changes of who may write it as this version allows (' + W.MAX_POLICY_EVENTS + ')' };
      if (r.policy.op === 'add-writer') {
        var now = writersAmong(page, page.objId, parents);
        if (now && now.indexOf(r.policy.did) < 0 && now.length - 1 >= W.MAX_WRITERS) return { status: 'refused', cid: r.cid, error: 'the list of who may write this page is full (' + W.MAX_WRITERS + ' besides the owner)' };
      }
      return { status: 'accepted', cid: r.cid, result: r };
    }
    async function accept(page, cid, env, r) {
      var ends = endsAmong(page, env.event.parents), pol = polAmong(page, env.event.parents);
      Object.keys(r.ranges).forEach(function (c) { ends[c] = r.ranges[c].end; });
      if (r.policy) pol = pol.concat([cid]).sort();
      var v = { env: env, ranges: r.ranges, ends: ends, pol: pol };
      await write('version', cid, v);          // the version first, then the list that names it: a crash between them leaves an unused record, never a list with a hole
      index(page, cid, v);
      page.pending.delete(cid);
      page.touched = now();
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
      // Every page this store holds, newest change first: [{ objId, versions, pending, touched, meta }]. Reads the small page records only, never
      // a page's versions, so a long list costs one decryption per page. `touched` is null for a page whose record predates the field.
      // `meta` is { created, category, tags } as kept by the last summary() while it still matches the versions the page holds, else null
      // (a page changed since, or never summarised): summary(objId) works it out.
      pages: function () {
        return serial(async function () {
          var ids = await backend.ids('page'), out = [];
          for (var i = 0; i < ids.length; i++) {
            var rec = await read('page', ids[i]);
            if (rec && typeof rec.objId === 'string') out.push({ objId: rec.objId, versions: rec.cids.length, pending: rec.pending.length, touched: rec.touched || null,
              meta: rec.sum && rec.sum.k === sumKey(rec.cids) ? rec.sum.v : null });
          }
          out.sort(function (a, b) { return (a.touched || '') < (b.touched || '') ? 1 : (a.touched || '') > (b.touched || '') ? -1 : (a.objId < b.objId ? -1 : 1); });
          return out;
        });
      },
      // checks the page's waiting edits again (after the caller learned something: a new writer list, say)
      recheck: function (objId) { return serial(async function () { return settle(await loadPage(objId)); }); },
      heads: function (objId) { return serial(async function () { var p = await loadPage(objId); return W.headsOf(Array.from(p.versions.keys()), getter(p)); }); },
      has: function (objId, cid) { return serial(async function () { return (await loadPage(objId)).versions.has(cid); }); },
      pending: function (objId) { return serial(async function () { var p = await loadPage(objId); return Array.from(p.pending.entries()).map(function (e) { return { cid: e[0], waitFor: e[1].waitFor, since: e[1].since }; }); }); },
      // the page's versions, parents before children: for a history list
      versions: function (objId) {
        return serial(async function () {
          var p = await loadPage(objId), get = getter(p), cl = W.closure(W.headsOf(Array.from(p.versions.keys()), get), get);
          return cl.order.map(function (cid) {
            var e = get(cid).event, row = { cid: cid, kind: e.purpose === W.POLICY_PURPOSE ? 'policy' : 'edit', did: e.author.did, parents: e.parents, created: e.created };
            if (row.kind === 'policy') row.change = e.change;
            return row;
          });
        });
      },
      // who may write the page as of `heads` (default: the page's current heads): the DIDs, the owner first
      writers: function (objId, heads) {
        return serial(async function () {
          if (!W.parsePageId(objId)) throw new Error('That is not the name of a page (its owner\'s identity, a slash and a name).');
          var p = await loadPage(objId), get = getter(p);
          var at = heads || W.headsOf(Array.from(p.versions.keys()), get);
          if (W.closure(at, get).missing.length) throw new Error('That version is not held here.');
          return writersAmong(p, objId, at);
        });
      },
      // the Yjs state at `heads` (default: the page's current heads): { update, cids }; apply `update` to a Y.Doc to read the page
      state: function (objId, heads) {
        return serial(async function () {
          var p = await loadPage(objId);
          return stateAt(p, heads || W.headsOf(Array.from(p.versions.keys()), getter(p)));
        });
      },
      // { created, category, tags } of the page as it stands now: the earliest date an edit of it states, and the category and tags in the
      // page's own `meta` map (see "what a list of pages shows" above for what is kept and why it can be trusted no further than a list).
      summary: function (objId) { return serial(async function () { return summarize(await loadPage(objId)); }); },
      // The page's text as it stands now (a string, '' for a page with nothing held): for searching it, see "the page's text" above.
      text: function (objId) { return serial(function () { return textNow(objId); }); },
      // What a page's reading view shows besides its text: { versions, pending, touched } (how many versions are held, how many edits wait
      // for something, and when this device last took a change into it, by its own clock: null for a page with none). Reads the page's
      // versions like state() does, and writes nothing.
      info: function (objId) {
        return serial(async function () {
          var p = await loadPage(objId);
          return { versions: p.versions.size, pending: p.pending.size, touched: p.touched };
        });
      },
      // Removes ONE page from this device: its list record, every version and waiting edit it names, and the text kept for searching it.
      // Answers { removed, versions, pending }: `removed` is false when no record of the page was held (nothing was changed). The page's own
      // record goes FIRST, so that a stop part-way leaves unused records and never a page that names a version that is gone. It works on a
      // page whose history cannot be read (it is still listed, and a person must be able to remove it): the versions it names are removed
      // when its record can be read, and when it cannot, the versions stay as records nothing names (sealed, and unreachable). Not undone;
      // and not a wiki-wide purge (purge() below is for an identity that is removed). The identity logs stay: they are shared by every page.
      remove: function (objId) {
        return serial(async function () {
          if (!W.parsePageId(objId)) throw new Error('That is not the name of a page (its owner\'s identity, a slash and a name).');
          var id = await pageKey(objId), rec = null, held = await backend.get('page', id);
          if (held) { try { rec = await open('page', id, held); } catch (e) { rec = null; } }
          pages.delete(objId);
          await backend.del('page', id);
          await backend.del('meta', 'text:' + id);
          var cids = rec && Array.isArray(rec.cids) ? rec.cids : [], pend = rec && Array.isArray(rec.pending) ? rec.pending : [];
          for (var i = 0; i < pend.length; i++) await backend.del('pending', pend[i]);
          for (var j = 0; j < cids.length; j++) await backend.del('version', cids[j]);
          return { removed: !!held, versions: cids.length, pending: pend.length };
        });
      },
      alerts: function () { return serial(async function () { return (await read('meta', 'alerts')) || []; }); },
      // removes everything this store holds (an identity removed from this device takes its pages with it)
      purge: function () {
        return serial(async function () {
          var kinds = ['page', 'version', 'pending', 'log', 'meta'];
          for (var k = 0; k < kinds.length; k++) { var ids = await backend.ids(kinds[k]); for (var i = 0; i < ids.length; i++) await backend.del(kinds[k], ids[i]); }
          pages.clear(); logs.clear(); logChecks.clear();
        });
      },
      // forgets what is held in memory, so the next call reads the (sealed) records again: for tests and for a session that ended
      unload: function () { return serial(async function () { pages.clear(); logs.clear(); logChecks.clear(); }); },
      // For a session that ended: every operation that has not started yet is refused from now on, and what is held in memory is dropped once
      // the one that is running has finished. Resolves then, which is when nothing of this store can still be written (the caller removing
      // an identity waits for it before it deletes the records, so a late write cannot bring them back). It cannot be undone: open a new store.
      close: function () { closed = true; return chain.then(function () { pages.clear(); logs.clear(); logChecks.clear(); }); }
    };
    return api;
  }

  return { create: create, memoryBackend: memoryBackend };
});
