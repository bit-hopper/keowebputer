// Names a file by the SHA-256 of its bytes WITHOUT holding up the shell's thread. keo-sha256.js does the arithmetic; on the shell's own
// thread it kept the page busy for about 12 ms per MiB (measured on one machine: 64 MiB in 0.85 s), in stretches of about 50 ms for every
// 4 MiB chunk, so while a big file was added the shell answered nothing else. This hands the chunks to one worker (keo-hash-worker.js, a
// file of the package) and gives the same digest, byte for byte, because the worker runs keo-sha256.js.
//   var h = keoHash.create(size);      size = bytes that will be fed in all, when known (small files are not worth a trip to the worker)
//   await h.update(bytes);             in order. Copies the bytes at the call, so the caller may reuse its buffer. Resolves when the worker
//                                      has taken the chunk; waits when two chunks are already waiting, so memory stays at a few chunks
//   var digest = await h.digest();     Uint8Array(32). Asking again gives the same answer (the finished hash is kept)
//   h.abort();                         gives up: the worker forgets it. Safe to call at any time, and after digest
//   keoHash.shutdown();                gives up every hash still open and stops the worker (the session ended)
// If the worker cannot start (a policy that does not allow it, a missing file, no Worker in this page) every hash is made on this
// thread with keo-sha256.js, exactly as before: slower for the page, never a different answer. keoHash.stats() says which happened.
// Use it ONLY to name and check content of unbounded size (see keo-sha256.js: nothing secret or keyed goes through here).
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.keoHash = api.make({
    newWorker: function () { return new root.Worker('keo-hash-worker.js'); },   // a path of the package: a worker may run only those
    sha256: { create: function () { return root.keoSha256.create(); } }          // looked up when used, so the order of the script tags does not matter
  });
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var LOCAL_MAX = 256 * 1024;    // up to this size a hash is made right here: about 3 ms, less than the trip to the worker is worth
  var MAX_INFLIGHT = 2;          // chunks the worker may hold unfinished for one file; the next update waits for the oldest
  var START_MS = 10000;          // a worker that has not said it is ready by then is given up on (and its files hashed here)

  // The bytes of a typed array or an ArrayBuffer, as a COPY of exactly those bytes (a view into a bigger buffer must not drag the rest along).
  function copyOf(data) {
    var v;
    if (ArrayBuffer.isView(data)) v = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    else if (Object.prototype.toString.call(data) === '[object ArrayBuffer]') v = new Uint8Array(data);
    else throw new Error('SHA-256 needs bytes.');
    return v.slice();
  }
  function stopped() { return new Error('The file could not be named: the part of keo that does it stopped. Try again.'); }
  function gaveUp() { return new Error('This file is no longer being named.'); }

  // env: { newWorker(): a Worker running keo-hash-worker.js, sha256: { create() } (keo-sha256.js) }. Separate from the module so a test can
  // give it another kind of worker.
  function make(env) {
    var worker = null, state = 'idle', ready = null, startTimer = null, resolveReady = null;   // state: idle, starting, ready, dead
    var startMs = env.startMs || START_MS;
    var nextId = 1, live = {}, fed = { worker: 0, local: 0 };            // live: hash id -> the hashes the worker has state for

    // Fails everything that is waiting on the worker.
    function failAll(err) {
      Object.keys(live).forEach(function (id) { settle(live[id], err); });
    }
    function settle(h, err) {
      Object.keys(h.waiting).forEach(function (s) { h.waiting[s].rej(err); });
      h.waiting = {};
      if (h.digestWait) { var d = h.digestWait; h.digestWait = null; d.rej(err); }
    }
    function dead() {
      if (state === 'dead') return;
      var w = worker; worker = null; state = 'dead'; clearTimeout(startTimer);
      if (w) { try { w.terminate(); } catch (e) { /* already gone */ } }
      if (resolveReady) { resolveReady(false); resolveReady = null; }       // whoever waits for the start is told: hash here
      failAll(stopped());
      live = {};
    }
    // What the worker says: an update was folded in, a digest, or a request it could not handle.
    function route(m) {
      var h = live[m.h];
      if (!h) return;
      if (m.digest) { var d = h.digestWait; h.digestWait = null; if (d) d.res(m.digest); return; }
      if (m.error) {
        // The worker could not do what it was asked: this file cannot be named, and nothing more is fed to it. Stays with the hash.
        var err = new Error('The file could not be named (' + m.error + ').');
        if (!h.failed) h.failed = err;
        if (m.seq !== undefined) { var bad = h.waiting[m.seq]; delete h.waiting[m.seq]; if (bad) bad.rej(err); }
        if (h.digestWait) { var dw = h.digestWait; h.digestWait = null; dw.rej(err); }
        return;
      }
      if (m.seq !== undefined) { var w = h.waiting[m.seq]; delete h.waiting[m.seq]; if (w) w.res(); }
    }
    // Starts the worker once. Resolves true when it is ready, false when this page has to hash for itself.
    function start() {
      if (state === 'dead') return Promise.resolve(false);
      if (ready) return ready;
      ready = new Promise(function (resolve) {
        var w;
        resolveReady = resolve;
        try { w = env.newWorker(); } catch (e) { state = 'dead'; resolve(false); return; }
        worker = w; state = 'starting';
        startTimer = setTimeout(function () { if (worker === w) dead(); }, startMs);
        w.onmessage = function (e) {
          if (worker !== w) return;                                           // a worker that was stopped says nothing that counts
          var m = e.data || {};
          if (m.ready) { clearTimeout(startTimer); if (state === 'starting') { state = 'ready'; resolve(true); } } else route(m);
        };
        w.onerror = w.onmessageerror = function () { if (worker === w) dead(); };
      });
      return ready;
    }
    async function decide(h) {
      var ok = await start();
      if (h.gone) return;
      if (ok && state === 'ready') { h.mode = 'worker'; live[h.id] = h; }
      else { h.mode = 'local'; h.local = env.sha256.create(); }
    }

    // Folds one chunk in. Runs one at a time per hash (see enqueue), so the worker sees the chunks in the order they were given.
    async function feed(h, bytes) {
      if (h.done) throw new Error('This SHA-256 is finished.');
      if (h.mode === null) await decide(h);
      if (h.gone) throw gaveUp();
      if (h.mode === 'local') { h.local.update(bytes); fed.local += bytes.length; return; }
      if (state !== 'ready') throw stopped();
      var seq = ++h.seq, ack = new Promise(function (res, rej) { h.waiting[seq] = { res: res, rej: rej }; });
      ack.catch(function () { /* told to the one that waits for it, below */ });
      var n = bytes.length;                      // counted before the hand-over: a buffer that was handed over has no length left
      worker.postMessage({ op: 'update', h: h.id, seq: seq, bytes: bytes }, [bytes.buffer]);   // the copy is handed over, not copied again
      fed.worker += n;
      h.outstanding.push(ack);
      if (h.outstanding.length > MAX_INFLIGHT) await h.outstanding.shift();
    }
    async function finish(h) {
      if (h.mode === null) { h.mode = 'local'; h.local = env.sha256.create(); }      // nothing was fed: the empty input, no worker needed
      if (h.mode === 'local') { var d = h.local.digest(); h.done = true; return d; }
      if (state !== 'ready') throw stopped();
      await Promise.all(h.outstanding);
      h.outstanding = [];
      var out = await new Promise(function (res, rej) { h.digestWait = { res: res, rej: rej }; worker.postMessage({ op: 'digest', h: h.id }); });
      h.done = true; delete live[h.id];
      return out;
    }
    // Runs fn after everything given to this hash before it. A failure stays with the hash: what comes after it fails the same way.
    function enqueue(h, fn) {
      var p = h.q.then(function () {
        if (h.failed) throw h.failed;
        if (h.gone) throw gaveUp();
        return fn();
      });
      h.q = p.then(null, function (e) { if (!h.failed) h.failed = e; });
      return p;
    }

    function create(size) {
      var h = { id: nextId++, mode: null, local: null, seq: 0, waiting: {}, outstanding: [], digestWait: null, digestP: null, q: Promise.resolve(), gone: false, done: false, failed: null };
      if (typeof size === 'number' && size >= 0 && size <= LOCAL_MAX) { h.mode = 'local'; h.local = env.sha256.create(); }
      return {
        update: function (data) {
          var copy;
          try { copy = copyOf(data); } catch (e) { return Promise.reject(e); }       // copied NOW: the caller may reuse its buffer at once
          return enqueue(h, function () { return feed(h, copy); });
        },
        digest: function () {
          if (!h.digestP) h.digestP = enqueue(h, function () { return finish(h); });
          return h.digestP.then(function (d) { return d.slice(); });
        },
        abort: function () {
          if (h.gone) return;
          h.gone = true;
          if (live[h.id]) {
            delete live[h.id];
            if (state === 'ready' && worker) { try { worker.postMessage({ op: 'drop', h: h.id }); } catch (e) { /* the worker is going away anyway */ } }
          }
          settle(h, gaveUp());
        },
        where: function () { return h.mode; }                                      // 'worker', 'local', or null before the first bytes
      };
    }
    // The session ended: give up every hash that is still open and stop the worker (the next big file starts it again).
    function shutdown() {
      Object.keys(live).forEach(function (id) { var h = live[id]; h.gone = true; settle(h, gaveUp()); });
      live = {};
      var w = worker; worker = null; state = 'idle'; ready = null; clearTimeout(startTimer);
      if (w) { try { w.terminate(); } catch (e) { /* already gone */ } }
      if (resolveReady) { resolveReady(false); resolveReady = null; }       // a file still waiting for the start is told to hash here
    }
    function stats() { return { state: state, open: Object.keys(live).length, fedWorker: fed.worker, fedLocal: fed.local }; }

    return { create: create, shutdown: shutdown, stats: stats, LOCAL_MAX: LOCAL_MAX, MAX_INFLIGHT: MAX_INFLIGHT };
  }

  return { make: make, LOCAL_MAX: LOCAL_MAX, MAX_INFLIGHT: MAX_INFLIGHT };
});
