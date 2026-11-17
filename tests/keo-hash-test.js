// Test for shell/keo-hash.js and shell/keo-hash-worker.js (naming a file's bytes on a worker): no browser. Two kinds of worker are
// used. (1) The REAL worker file, run in a worker thread (worker_threads) with a small adapter that gives it the page's worker globals (self,
// postMessage, importScripts): the digests it gives are compared with the platform's own digest and with keo-sha256.js. (2) A fake worker
// the test controls message by message, for what only a slow, silent, failing or stopped worker shows: how far ahead of the worker the
// page may get, the order and the copying of the bytes, giving up, a worker that does not start or stops, and small files that never
// need one. What this cannot say: whether the BROWSER lets the package's worker run under the shell's policy (tests/keo-hash-page-test.js
// does, in a real build), and how long the page's thread is held up in a browser (a profile script kept outside the repository measures that).
// Usage: node tests/keo-hash-test.js
const fs = require('fs');
const path = require('path');
const { Worker } = require('worker_threads');
const SHELL = path.join(__dirname, '..', 'shell');
const sha = require(path.join(SHELL, 'keo-sha256.js'));
const hashMod = require(path.join(SHELL, 'keo-hash.js'));
const subtle = globalThis.crypto.subtle;
let passed = 0;
const ok = (name, cond, extra) => { if (!cond) { console.error('FAIL ' + name + (extra !== undefined ? ' ' + JSON.stringify(extra) : '')); process.exitCode = 1; } else { passed++; console.log('ok   ' + name); } };
const hex = (u8) => Array.from(u8, (b) => b.toString(16).padStart(2, '0')).join('');
const ref = async (u8) => hex(new Uint8Array(await subtle.digest('SHA-256', u8)));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function fill(n, seed) { const u = new Uint8Array(n); let x = seed >>> 0 || 1; for (let i = 0; i < n; i++) { x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0; u[i] = x & 255; } return u; }
// 'resolved', 'rejected' or 'pending' (after a short wait) without making a rejection unhandled
const stateOf = (p) => Promise.race([p.then(() => 'resolved', () => 'rejected'), sleep(25).then(() => 'pending')]);
const message = (p) => p.then(() => null, (e) => e.message);
const unhandled = [];
process.on('unhandledRejection', (e) => unhandled.push(String(e && e.message || e)));

// ---- the real worker file in a worker thread, with the page's worker globals -------------------------------------------
function realWorkerFactory() {
  const made = [];
  const f = function () {
    const boot = [
      "const { parentPort } = require('worker_threads'), fs = require('fs'), vm = require('vm'), path = require('path');",
      'const dir = ' + JSON.stringify(SHELL) + ';',
      'delete globalThis.module; delete globalThis.exports;                       // a page worker has neither: the SHA-256 file must find none',
      'globalThis.self = globalThis;',
      'globalThis.postMessage = (m, t) => parentPort.postMessage(m, t || []);',
      "globalThis.importScripts = (f) => vm.runInThisContext(fs.readFileSync(path.join(dir, f), 'utf8'), { filename: f });",
      "parentPort.on('message', (data) => globalThis.self.onmessage({ data }));",
      "vm.runInThisContext(fs.readFileSync(path.join(dir, 'keo-hash-worker.js'), 'utf8'), { filename: 'keo-hash-worker.js' });"
    ].join('\n');
    const w = new Worker(boot, { eval: true });
    const api = { onmessage: null, onerror: null, onmessageerror: null, postMessage: (d, t) => w.postMessage(d, t || []), terminate: () => { api.terminated = true; return w.terminate(); }, terminated: false };
    w.on('message', (data) => { if (api.onmessage) api.onmessage({ data }); });
    w.on('error', (e) => { if (api.onerror) api.onerror(e); });
    made.push(api);
    return api;
  };
  f.made = made;
  return f;
}
// ---- a fake worker the test drives by hand ----------------------------------------------------------------------------------
function fakeFactory(opts) {
  opts = opts || {};
  const made = [];
  const f = function () {
    if (opts.throws) throw new Error('no Worker here');
    const w = {
      sent: [], onmessage: null, onerror: null, onmessageerror: null, terminated: false,
      postMessage(d, t) { this.sent.push({ d, t }); }, terminate() { this.terminated = true; },
      say(m) { if (this.onmessage) this.onmessage({ data: m }); },
      updates() { return this.sent.filter((s) => s.d.op === 'update'); },
      ops() { return this.sent.map((s) => s.d.op); }
    };
    made.push(w);
    if (opts.ready !== false) setTimeout(() => w.say({ ready: true }), 0);
    if (opts.errorAtStart) setTimeout(() => { if (w.onerror) w.onerror(new Error('blocked')); }, 0);
    return w;
  };
  f.made = made;
  return f;
}
const makeWith = (factory, extra) => hashMod.make(Object.assign({ newWorker: factory, sha256: sha }, extra || {}));

(async () => {
  const BIG = 1e9;       // a size hint that is never "small": the hash goes to the worker

  // ================= the real worker file ==================================================================================
  {
    const factory = realWorkerFactory(), H = makeWith(factory);
    const sizes = [0, 1, 55, 56, 63, 64, 65, 1000, 1 << 20, (4 << 20) + 7, (9 << 20) + 1];
    let bad = null, wrongPlace = null;
    for (const n of sizes) {
      const d = fill(n, n + 3), want = await ref(d), h = H.create(BIG), CH = 1 << 20;
      for (let o = 0; o < n; o += CH) await h.update(d.subarray(o, Math.min(o + CH, n)));
      const got = hex(await h.digest());
      if (got !== want && bad === null) bad = n;
      if (n > 0 && h.where() !== 'worker' && wrongPlace === null) wrongPlace = n;
    }
    ok('the real worker gives the platform digest for lengths 0 to 9 MiB (fed in 1 MiB pieces)', bad === null, bad);
    ok('every non-empty one of them was hashed on the worker', wrongPlace === null, wrongPlace);
    ok('one worker was made for all of them', factory.made.length === 1);

    const e = H.create(BIG);
    ok('nothing fed: the empty-input digest, with no help from the worker', hex(await e.digest()) === 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855' && e.where() === 'local');

    // uneven pieces, and a view into a bigger buffer
    const big = fill(3000000, 11), want2 = await ref(big.subarray(1000, 2999000)), h2 = H.create(BIG);
    for (let o = 1000; o < 2999000;) { const n = 1 + (o * 7919) % 400000; await h2.update(big.subarray(o, Math.min(o + n, 2999000))); o += n; }
    ok('uneven pieces, taken from a view into a bigger buffer, give the platform digest', hex(await h2.digest()) === want2);

    // two hashes open at once, fed in turn
    const A = fill(2500000, 21), B = fill(2500000, 22), ha = H.create(BIG), hb = H.create(BIG);
    for (let o = 0; o < A.length; o += 500000) { await ha.update(A.subarray(o, o + 500000)); await hb.update(B.subarray(o, o + 500000)); }
    ok('two hashes fed in turn do not mix', hex(await ha.digest()) === await ref(A) && hex(await hb.digest()) === await ref(B));

    // the caller reuses its buffer at once
    const src = fill(1 << 20, 31), keep = src.slice(), want3 = await ref(keep), h3 = H.create(BIG);
    const pending = h3.update(src); src.fill(0); await pending;                  // overwritten before the worker could have read it
    ok('bytes are copied when update is called: overwriting the buffer afterwards changes nothing', hex(await h3.digest()) === want3);

    // the finished hash is kept
    const h4 = H.create(BIG); await h4.update(keep);
    const d1 = await h4.digest(), d2 = await h4.digest();
    ok('asking for the digest again gives the same bytes, in a new array', hex(d1) === want3 && hex(d2) === want3 && d1 !== d2);
    ok('feeding a finished hash is refused', (await message(h4.update(keep))) === 'This SHA-256 is finished.');
    ok('a string is not bytes, and the hash can still be used', (await message(H.create(BIG).update('abc'))) === 'SHA-256 needs bytes.');
    const h5 = H.create(BIG); await message(h5.update('abc')); await h5.update(keep);
    ok('after a refused piece the same hash goes on', hex(await h5.digest()) === want3);

    // 64 MiB in 4 MiB chunks, with how long the event loop was held up (printed, not asserted: it depends on the machine's load)
    const d64 = fill(64 << 20, 3), want64 = await ref(d64), h64 = H.create(BIG);
    let worst = 0, last = Date.now();
    const tick = setInterval(() => { const n = Date.now(); worst = Math.max(worst, n - last); last = n; }, 5);
    const t0 = Date.now();
    for (let o = 0; o < d64.length; o += 4 << 20) await h64.update(d64.subarray(o, o + (4 << 20)));
    const got64 = hex(await h64.digest()), t1 = Date.now() - t0;
    clearInterval(tick);
    ok('64 MiB in 4 MiB chunks through the real worker gives the platform digest', got64 === want64);
    console.log('     (64 MiB: ' + t1 + ' ms here; the longest wait of the main thread for a 5 ms timer was ' + worst + ' ms; the stats say ' + JSON.stringify(H.stats()) + ')');
    ok('the stats count the bytes handed to the worker', H.stats().fedWorker > 64 << 20);

    // the session ends: open hashes are given up and the worker stops; the next file starts a fresh one
    const hs = H.create(BIG); await hs.update(keep);
    const before = factory.made.length;
    H.shutdown();
    ok('shutdown stops the worker', factory.made[before - 1].terminated === true && H.stats().state === 'idle');
    ok('a hash that was open at shutdown is refused afterwards', (await message(hs.update(keep))) === 'This file is no longer being named.');
    const hn = H.create(BIG); await hn.update(keep);
    ok('the next big file starts a new worker and is named correctly', factory.made.length === before + 1 && hex(await hn.digest()) === want3);
    H.shutdown();
  }

  // ================= small files never need a worker ======================================================================
  {
    const factory = fakeFactory(), H = makeWith(factory), d = fill(100000, 5), h = H.create(d.length);
    await h.update(d);
    ok('a file within the small limit is hashed in place, with no worker made', hex(await h.digest()) === await ref(d) && factory.made.length === 0 && h.where() === 'local');
    const edge = H.create(H.LOCAL_MAX); await edge.update(fill(H.LOCAL_MAX, 6));
    ok('a file of exactly the small limit is still hashed in place', factory.made.length === 0 && edge.where() === 'local');
    const over = H.create(H.LOCAL_MAX + 1); const u = over.update(fill(1000, 7));
    await sleep(5);
    ok('one byte over the limit goes to the worker', factory.made.length === 1);
    over.abort(); await u.catch(() => {});
    H.shutdown();
  }

  // ================= how far ahead of the worker the page may get ==========================================================
  {
    const factory = fakeFactory(), H = makeWith(factory), h = H.create(BIG);
    const chunks = [1, 2, 3, 4, 5].map((i) => fill(1000 + i, i));
    const ps = chunks.map((c) => h.update(c));
    await sleep(40);
    const w = factory.made[0], id = w.updates()[0] && w.updates()[0].d.h;
    ok('with no answers from the worker, only ' + (H.MAX_INFLIGHT + 1) + ' chunks have been handed to it', w.updates().length === H.MAX_INFLIGHT + 1, w.updates().length);
    ok('the first two updates have resolved and the third waits', (await stateOf(ps[0])) === 'resolved' && (await stateOf(ps[1])) === 'resolved' && (await stateOf(ps[2])) === 'pending');
    ok('they went in the order given, numbered from 1', w.updates().map((s) => s.d.seq).join() === '1,2,3');
    ok('what was handed over equals what was given, and the caller\'s array is untouched', w.updates().every((s, i) => hex(s.d.bytes) === hex(chunks[i])) && chunks.every((c, i) => c.length === 1001 + i && c.buffer.byteLength >= c.length));
    ok('the copy was handed over by moving its buffer', w.updates().every((s) => Array.isArray(s.t) && s.t[0] === s.d.bytes.buffer));
    w.say({ h: id, seq: 1 });
    await sleep(25);
    ok('an answer for the oldest chunk lets the third update resolve and the fourth go out', (await stateOf(ps[2])) === 'resolved' && w.updates().length === 4);
    w.say({ h: id, seq: 2 }); w.say({ h: id, seq: 3 }); w.say({ h: id, seq: 4 });
    await sleep(25);
    w.say({ h: id, seq: 5 });
    const dp = h.digest();
    await sleep(25);
    ok('the digest is asked for only after every update was answered', w.ops().filter((o) => o === 'digest').length === 1 && w.ops().lastIndexOf('digest') === w.ops().length - 1);
    const answer = new Uint8Array(32).fill(9);
    w.say({ h: id, digest: answer });
    ok('the digest is what the worker said', hex(await dp) === hex(answer));
    ok('once finished, the worker is not asked to drop it', !w.ops().includes('drop'));
    H.shutdown();
  }

  // ================= giving up =============================================================================================
  {
    const factory = fakeFactory(), H = makeWith(factory), h = H.create(BIG);
    const p1 = h.update(fill(500, 1)), p2 = h.update(fill(500, 2)), p3 = h.update(fill(500, 3));
    await sleep(30);
    const w = factory.made[0], id = w.updates()[0].d.h;
    ok('setup: the third update is waiting', (await stateOf(p3)) === 'pending');
    h.abort();
    ok('giving up lets the worker know', w.ops().includes('drop') && w.sent.filter((s) => s.d.op === 'drop').every((s) => s.d.h === id));
    ok('an update that was waiting is refused', (await message(p3)) === 'This file is no longer being named.');
    ok('an update after giving up is refused', (await message(h.update(fill(10, 4)))) === 'This file is no longer being named.');
    ok('the digest after giving up is refused', (await message(h.digest())) === 'This file is no longer being named.');
    const dropsBefore = w.sent.filter((s) => s.d.op === 'drop').length;
    h.abort();
    ok('giving up twice does nothing more', w.sent.filter((s) => s.d.op === 'drop').length === dropsBefore);
    await p1.catch(() => {}); await p2.catch(() => {});
    // abort after a finished digest sends nothing
    const h2 = H.create(BIG), q = h2.update(fill(10, 5)); await sleep(20);
    const id2 = w.updates().find((s) => s.d.h !== id).d.h; w.say({ h: id2, seq: 1 }); await q;
    const dq = h2.digest(); await sleep(20); w.say({ h: id2, digest: new Uint8Array(32) }); await dq;
    const drops = w.sent.filter((s) => s.d.op === 'drop').length; h2.abort();
    ok('giving up a finished hash tells the worker nothing', w.sent.filter((s) => s.d.op === 'drop').length === drops);
    H.shutdown();
  }

  // ================= a worker that says no ==========================================================================================
  {
    const factory = fakeFactory(), H = makeWith(factory), h = H.create(BIG);
    const p = h.update(fill(10, 1)); await sleep(20);
    const w = factory.made[0], id = w.updates()[0].d.h;
    ok('setup: the first update had been taken before the worker spoke', (await stateOf(p)) === 'resolved');
    w.say({ h: id, seq: 1, error: 'Unknown request.' });
    const q = h.update(fill(10, 2)), want = 'The file could not be named (Unknown request.).';
    ok('after an error from the worker for an update, the next update on that hash is refused at once, with its sentence', (await message(q)) === want, await message(q));
    ok('and so is the digest', (await message(h.digest())) === want);
    const other = H.create(BIG);
    ok('another hash on the same worker is not affected', (await stateOf(other.update(fill(10, 3)))) === 'resolved');
    H.shutdown();
  }

  // ================= a worker that is missing, silent or stops ===============================================================
  {
    const d = fill(300000, 8), want = await ref(d);
    // no Worker at all
    let factory = fakeFactory({ throws: true }), H = makeWith(factory), h = H.create(BIG);
    await h.update(d);
    ok('no Worker in the page: the digest is the same, made in place', hex(await h.digest()) === want && h.where() === 'local' && H.stats().state === 'dead');
    const hb = H.create(BIG); await hb.update(d);
    ok('and later hashes do not try again', hex(await hb.digest()) === want && hb.where() === 'local');
    // an error event when it starts (a policy that forbids it)
    factory = fakeFactory({ ready: false, errorAtStart: true }); H = makeWith(factory); h = H.create(BIG);
    await h.update(d);
    ok('a worker that fails to load: the digest is the same, made in place', hex(await h.digest()) === want && h.where() === 'local' && factory.made[0].terminated);
    // never says it is ready
    factory = fakeFactory({ ready: false }); H = makeWith(factory, { startMs: 60 }); h = H.create(BIG);
    const t0 = Date.now(); await h.update(d);
    ok('a worker that never says it is ready is given up on after the wait, and the digest is the same', hex(await h.digest()) === want && h.where() === 'local' && Date.now() - t0 >= 50 && factory.made[0].terminated);
    // stops in the middle
    factory = fakeFactory(); H = makeWith(factory); h = H.create(BIG);
    const a = h.update(fill(1000, 1)), b = h.update(fill(1000, 2)), c = h.update(fill(1000, 3));
    await sleep(30);
    factory.made[0].onerror(new Error('crashed'));
    const sentence = 'The file could not be named: the part of keo that does it stopped. Try again.';
    ok('a worker that stops refuses what was waiting, with a sentence a person can read', (await message(c)) === sentence, await message(c));
    ok('the digest of that file is refused too', (await message(h.digest())) === sentence);
    await a.catch(() => {}); await b.catch(() => {});
    const h2 = H.create(BIG); await h2.update(d);
    ok('the next file after a stop is named in place, correctly', hex(await h2.digest()) === want && h2.where() === 'local');
    // shutdown while a worker is still starting must not leave a file waiting for ever
    factory = fakeFactory({ ready: false }); H = makeWith(factory); h = H.create(BIG);
    const pending = h.update(d); await sleep(20);
    H.shutdown();
    ok('shutdown while the worker is still starting does not leave an update waiting', (await stateOf(pending)) !== 'pending');
    await pending.catch(() => {});
  }

  // ================= wiring: the page loads it, the build ships it ===========================================================
  {
    const html = fs.readFileSync(path.join(SHELL, 'start.html'), 'utf8');
    const at = (f) => html.indexOf('<script src="' + f + '"></script>');
    ok('start.html loads keo-hash.js after keo-sha256.js and before keo-library.js', at('keo-sha256.js') >= 0 && at('keo-hash.js') > at('keo-sha256.js') && at('keo-library.js') > at('keo-hash.js'));
    ok('the worker file is not a script tag (it is started by keo-hash.js)', at('keo-hash-worker.js') === -1);
    const build = fs.readFileSync(path.join(__dirname, '..', 'extension', 'build.js'), 'utf8');
    ok('the build puts both files in the package', /'keo-hash\.js'/.test(build) && /'keo-hash-worker\.js'/.test(build));
    ok('the worker file loads the package file keo-sha256.js by a plain relative name', /importScripts\('keo-sha256\.js'\)/.test(fs.readFileSync(path.join(SHELL, 'keo-hash-worker.js'), 'utf8')));
  }

  await sleep(20);
  ok('no rejection was left unhandled', unhandled.length === 0, unhandled);
  console.log(passed + ' checks passed' + (process.exitCode ? ' (with failures)' : ''));
})().catch((e) => { console.error('TEST CRASHED', e); process.exit(1); });
