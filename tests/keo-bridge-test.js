// Tests for the shell <-> world bridge of the built extension.
// Usage: [KEO_HEADLESS=1] node keo-bridge-test.js <repo root> <extension folder> <work dir> [part ...]
// Parts: idb (differential test of the in-world IndexedDB against the real one), persist (localStorage and IndexedDB
// survive a reload, and land in the shell's real store), transfer (buffers a call hands over instead of copying, and the
// refusals), leave (a world may ask for a moment before it is left: keo.beforeLeave), webauthn (passkey ceremonies proxied to the shell, PRF included), vault (identity vault reached through the
// shell). Default: all. Headed unless KEO_HEADLESS=1 (the newer headless mode: no window, no focus taken); a headless pass is
// reported as headless.
// "Differential": the same operation script runs once in the shell page against the REAL indexedDB and once in the
// world against the stand-in; the transcripts of results and error names must be identical.
const fs = require('fs');
const path = require('path');
const { REPO, EXT, WORK } = require('./args.js')();
const PARTS = process.argv.length > 5 ? process.argv.slice(5) : ['idb', 'persist', 'transfer', 'leave', 'webauthn', 'vault'];
const HEADLESS = !!process.env.KEO_HEADLESS;      // the newer headless mode (no window, no focus taken); NOT how this suite is run to call it passed: headed is the default
const { chromium } = require(path.join(REPO, 'node_modules', 'playwright-core'));
const ID = 'keoapnoighmdpncpbfffhcdgdjgjmpdn';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- the operation script: runs in either context, returns a transcript (array of strings) ----
async function IDB_SCRIPT(prefix) {
  const out = [];
  // Dates by their time value: the world's Date.prototype.toJSON is Lively's own and prints differently from the browser's
  const j = (x) => (x === undefined ? 'undef' : JSON.stringify(x, function (k, v) { const raw = this[k]; return raw instanceof Date ? 'Date:' + raw.getTime() : v; }));
  const log = (...a) => { const line = a.map(j).join(' '); out.push(line); if (typeof console !== 'undefined') console.log('T:' + line); };
  const req = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  const errName = async (p) => { try { await p; return 'no error'; } catch (e) { return e && e.name; } };
  const txDone = (tx) => new Promise((res) => { tx.oncomplete = () => res('complete'); tx.onabort = () => res('abort'); });
  const open = (name, ver, upgrade) => new Promise((res, rej) => {
    const q = indexedDB.open(name, ver);
    q.onupgradeneeded = (e) => upgrade && upgrade(q.result, e, q.transaction);
    q.onsuccess = () => res(q.result);
    q.onerror = () => rej(q.error);
  });
  const nm = prefix + '-diff';
  await new Promise((r) => { const q = indexedDB.deleteDatabase(nm); q.onsuccess = () => r(); q.onerror = () => r(); });

  let db = await open(nm, 1, (d, e, tx) => {
    log('upgrade', e.oldVersion, e.newVersion, d.version, tx.mode);
    d.createObjectStore('plain');
    const m = d.createObjectStore('msgs', { keyPath: 'msgId' });
    m.createIndex('thread', 'threadId', { unique: false });
    m.createIndex('tags', 'tags', { multiEntry: true });
    d.createObjectStore('auto', { autoIncrement: true });
    d.createObjectStore('autokp', { keyPath: 'id', autoIncrement: true });
    d.createObjectStore('uniq', { keyPath: 'k' }).createIndex('u', 'u', { unique: true });
    log('storeNames in upgrade', Array.from(d.objectStoreNames));
  });
  log('version', db.version, 'stores', Array.from(db.objectStoreNames));

  // out-of-line keys and key ordering (numbers < dates < strings < arrays)
  let tx = db.transaction(['plain', 'msgs', 'auto', 'autokp', 'uniq'], 'readwrite');
  const plain = tx.objectStore('plain');
  const keys = ['b', 'a', 2, 1.5, new Date(1000), [1], [0, 'x'], 'ab', -3];
  const putKeys = [];
  for (const k of keys) putKeys.push(await req(plain.put('val-' + String(k), k)));
  log('put returned', putKeys);
  log('getAllKeys order', await req(plain.getAllKeys()));
  log('getAll', await req(plain.getAll()));
  log('get', await req(plain.get('a')), await req(plain.get('zz')), await req(plain.get(2)));
  log('count', await req(plain.count()), await req(plain.count(IDBKeyRange.bound('a', 'b'))), await req(plain.count(IDBKeyRange.lowerBound(1.5, true))));
  log('getAll(range,2)', await req(plain.getAll(IDBKeyRange.bound(-10, 10), 2)));
  log('getKey', await req(plain.getKey(IDBKeyRange.lowerBound('a'))));
  log('delete', await req(plain['delete'](IDBKeyRange.bound(1, 2))), await req(plain.getAllKeys()));
  log('add dup', await errName(req(plain.add('again', 'a'))));
  // the failed add aborts the transaction unless the error is prevented; make a new one
  log('tx after failed add', await txDone(tx));

  tx = db.transaction(['msgs', 'auto', 'autokp', 'uniq', 'plain'], 'readwrite');
  const msgs = tx.objectStore('msgs');
  const rows = [
    { msgId: 'm5', threadId: 't2', tags: ['x', 'y'], body: 'five' },
    { msgId: 'm1', threadId: 't1', tags: ['x'], body: 'one' },
    { msgId: 'm3', threadId: 't1', tags: [], body: 'three' },
    { msgId: 'm2', threadId: 't1', tags: ['y', 'y'], body: 'two' },
    { msgId: 'm4', threadId: 't3', body: 'four' },
  ];
  for (const r of rows) await req(msgs.put(r));
  log('keyPath get', await req(msgs.get('m3')));
  const thread = msgs.index('thread');
  log('index getAll only t1', (await req(thread.getAll(IDBKeyRange.only('t1')))).map((r) => r.msgId));
  log('index getAllKeys', await req(thread.getAllKeys()));
  log('index get', await req(thread.get('t1')), await req(thread.getKey('t2')), await req(thread.count('t1')));
  log('multiEntry x', (await req(msgs.index('tags').getAll('x'))).map((r) => r.msgId));
  log('multiEntry y keys', await req(msgs.index('tags').getAllKeys('y')));
  log('index names', Array.from(msgs.indexNames), msgs.keyPath, msgs.autoIncrement);
  // cursors
  const cur = [];
  await new Promise((res, rej) => {
    const c = thread.openCursor(IDBKeyRange.only('t1'));
    c.onsuccess = () => { const cc = c.result; if (!cc) return res(); cur.push([cc.key, cc.primaryKey, cc.value.body]); cc['continue'](); };
    c.onerror = () => rej(c.error);
  });
  log('cursor index only t1', cur);
  const cur2 = [];
  await new Promise((res) => {
    const c = msgs.openCursor(null, 'prev');
    c.onsuccess = () => { const cc = c.result; if (!cc) return res(); cur2.push(cc.primaryKey); cc.advance(2); };
  });
  log('cursor prev advance(2)', cur2);
  const cur3 = [];
  await new Promise((res) => {
    const c = msgs.openKeyCursor(IDBKeyRange.lowerBound('m2'));
    c.onsuccess = () => { const cc = c.result; if (!cc) return res(); cur3.push([cc.key, cc.value]); cc['continue'](); };
  });
  log('keycursor', cur3);
  const cur4 = [];
  await new Promise((res) => {
    const c = thread.openCursor(null, 'nextunique');
    c.onsuccess = () => { const cc = c.result; if (!cc) return res(); cur4.push([cc.key, cc.primaryKey]); cc['continue'](); };
  });
  log('cursor nextunique', cur4);
  // cursor.update / delete
  await new Promise((res) => {
    const c = msgs.openCursor(IDBKeyRange.only('m4'));
    c.onsuccess = async () => { const cc = c.result; if (!cc) return res(); await req(cc.update(Object.assign({}, cc.value, { body: 'FOUR' }))); await req(cc['delete']()); res(); };
  });
  log('after cursor update+delete', await req(msgs.get('m4')), await req(msgs.count()));
  // auto increment
  const auto = tx.objectStore('auto'), autokp = tx.objectStore('autokp');
  log('auto add', await req(auto.add('x')), await req(auto.add('y')), await req(auto.put('z', 10)), await req(auto.add('w')), await req(auto.put('back', 3)), await req(auto.add('after')));
  log('autokp add', await req(autokp.add({ v: 1 })), await req(autokp.add({ v: 2 })), await req(autokp.put({ id: 7, v: 3 })), await req(autokp.add({ v: 4 })));
  log('autokp get', await req(autokp.get(1)), await req(autokp.get(8)));
  log('autokp getAll', await req(autokp.getAll()));
  // errors
  // misuse that must throw at once: each case runs inside a request callback of its own fresh transaction, where the
  // transaction is certainly active (a real database reports TransactionInactiveError instead once the script has awaited
  // a few non-request promises, which would make the comparison depend on timing)
  const inCb = (fn) => new Promise((res) => {
    const mt = db.transaction(['plain', 'msgs'], 'readwrite'), mp = mt.objectStore('plain'), mm = mt.objectStore('msgs');
    const r = mp.count();
    r.onsuccess = () => { try { fn(mp, mm); res('no error'); } catch (e) { res(e.name); } };
  });
  log('inline key + key arg', await inCb((p, m) => m.put({ msgId: 'q' }, 'k')));
  log('no key', await inCb((p) => p.put('v')));
  log('missing keypath value', await inCb((p, m) => m.put({ nope: 1 })));
  log('bad key', await inCb((p) => p.get({})));
  log('get undefined', await inCb((p) => p.get(undefined)));
  log('missing index', await inCb((p, m) => m.index('nope')));
  log('missing store', await (async () => { try { db.transaction('nope'); return 'no error'; } catch (e) { return e.name; } })());
  log('createObjectStore outside upgrade', await (async () => { try { db.createObjectStore('z'); return 'no error'; } catch (e) { return e.name; } })());
  // unique index
  tx = db.transaction(['uniq', 'plain'], 'readwrite');      // fresh: the one above may already have committed
  const uniq = tx.objectStore('uniq');
  await req(uniq.put({ k: 1, u: 'same' }));
  const uErr = new Promise((res) => { const r = uniq.put({ k: 2, u: 'same' }); r.onerror = (e) => { e.preventDefault(); res(r.error.name); }; r.onsuccess = () => res('no error'); });
  log('unique violation', await uErr);
  log('uniq count after', await req(uniq.count()));
  log('tx2', await txDone(tx));
  db.close();

  // reopen: no upgrade, data there; readonly checks; abort rolls back
  db = await open(nm, undefined, () => log('UNEXPECTED upgrade'));
  log('reopen version', db.version);
  let ro = db.transaction('plain', 'readonly');
  log('readonly write', await (async () => { try { ro.objectStore('plain').put('x', 'k'); return 'no error'; } catch (e) { return e.name; } })());
  await txDone(ro);
  let rw = db.transaction(['msgs', 'plain'], 'readwrite');
  await req(rw.objectStore('msgs').put({ msgId: 'zz', threadId: 't9' }));
  await req(rw.objectStore('plain')['delete'](IDBKeyRange.lowerBound('a')));
  const aborted = txDone(rw);
  rw.abort();
  log('abort', await aborted);
  rw = db.transaction(['msgs', 'plain'], 'readonly');
  log('after abort', await req(rw.objectStore('msgs').get('zz')), await req(rw.objectStore('plain').count()), await req(rw.objectStore('msgs').count()));
  await txDone(rw);
  // a finished transaction refuses new requests
  const fin = db.transaction('plain', 'readonly'); await txDone(fin);
  log('finished tx', await (async () => { try { fin.objectStore('plain').get('a'); return 'no error'; } catch (e) { return e.name; } })());
  db.close();

  // version 2: new index over existing records, new store, delete a store
  db = await open(nm, 2, (d, e, tx2) => {
    log('upgrade2', e.oldVersion, e.newVersion);
    tx2.objectStore('msgs').createIndex('body', 'body', { unique: false });
    d.createObjectStore('extra', { keyPath: 'id' });
    d.deleteObjectStore('uniq');
  });
  log('v2 stores', db.version, Array.from(db.objectStoreNames));
  const t2 = db.transaction('msgs', 'readonly');
  log('new index on old data', (await req(t2.objectStore('msgs').index('body').getAll('one'))).map((r) => r.msgId), Array.from(t2.objectStore('msgs').indexNames));
  await txDone(t2);
  db.close();
  log('downgrade', await errName(open(nm, 1)));
  log('bad version', await (async () => { try { indexedDB.open(nm, 0); return 'no error'; } catch (e) { return e.name; } })());

  // aborted upgrade: schema and data restored
  const abortErr = await new Promise((res) => {
    const q = indexedDB.open(nm, 3);
    q.onupgradeneeded = () => { q.result.createObjectStore('willvanish'); q.transaction.abort(); };
    q.onerror = () => res(q.error && q.error.name);
    q.onsuccess = () => res('success');
  });
  log('aborted upgrade', abortErr);
  db = await open(nm);
  log('after aborted upgrade', db.version, Array.from(db.objectStoreNames));
  db.close();
  await new Promise((r) => { const q = indexedDB.deleteDatabase(nm); q.onsuccess = () => r(); });
  const list = await indexedDB.databases();
  log('databases has it after delete', list.some((d) => d.name === nm));
  log('cmp', indexedDB.cmp(1, 2), indexedDB.cmp('b', 'a'), indexedDB.cmp([1], [1, 0]), indexedDB.cmp(5, '5'));
  return out;
}

async function launch(profile) {
  const ctx = await chromium.launchPersistentContext(path.join(WORK, profile), Object.assign({
    headless: HEADLESS, viewport: { width: 1280, height: 860 },
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--host-resolver-rules=MAP localhost ~NOTFOUND, MAP 127.0.0.1 ~NOTFOUND'] }, HEADLESS ? { channel: 'chromium' } : {}));
  await sleep(2500);
  return ctx;
}
async function openShell(ctx, withAuthenticator) {
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push('PAGEERROR ' + e.message.slice(0, 200)));
  page.on('console', (m) => { if (m.text().startsWith('T:')) { if (process.env.TRACE) console.log(m.text().slice(0, 160)); return; } if (m.type() === 'error' && !/compute-pressure/.test(m.text())) errors.push('console: ' + m.text().slice(0, 200) + ' @' + (m.location() && m.location().url || '')); });
  if (withAuthenticator) {
    const cdp = await ctx.newCDPSession(page);
    await cdp.send('WebAuthn.enable', { enableUI: false });
    await cdp.send('WebAuthn.addVirtualAuthenticator', { options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true,
      hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true, hasPrf: true } });
  }
  await page.goto(`chrome-extension://${ID}/start.html#guest`);
  let frame = null;
  for (let i = 0; i < 100 && !frame; i++) { frame = page.frames().find((f) => /world\.html$/.test(f.url())); if (!frame) await sleep(200); }
  for (let i = 0; i < 150; i++) { try { if (await frame.evaluate(() => !!(window.$world && window.$world.submorphs))) break; } catch (e) {} await sleep(300); }
  await sleep(1500);
  return { page, frame, errors };
}

const results = {};
function check(name, ok, detail) { results[name] = { ok: !!ok, detail }; console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail && !ok ? '  -> ' + JSON.stringify(detail).slice(0, 600) : '')); }

(async () => {
  // ================= idb: differential =================
  if (PARTS.includes('idb')) {
    const ctx = await launch('profile-bridge-idb');
    try {
      const { page, frame, errors } = await openShell(ctx);
      const real = await page.evaluate(IDB_SCRIPT, 'real');
      const mine = await frame.evaluate(IDB_SCRIPT, 'world');
      const diffs = [];
      for (let i = 0; i < Math.max(real.length, mine.length); i++) if (real[i] !== mine[i]) diffs.push({ line: i, real: real[i], world: mine[i] });
      fs.writeFileSync(path.join(WORK, 'idb-transcript-real.txt'), real.join('\n'));
      fs.writeFileSync(path.join(WORK, 'idb-transcript-world.txt'), mine.join('\n'));
      check('idb: same transcript as the real IndexedDB (' + real.length + ' lines)', diffs.length === 0, diffs.slice(0, 8));
      check('idb: no page errors', errors.length === 0, errors);
    } finally { await ctx.close(); }
  }

  // ================= persist =================
  if (PARTS.includes('persist')) {
    const ctx = await launch('profile-bridge-persist');
    try {
      let s = await openShell(ctx);
      await s.frame.evaluate(async () => {
        localStorage.setItem('keo-test-a', 'one');
        lively.LocalStorage.set('keo-test-num', 42);
        localStorage.setItem('keo-test-gone', 'x'); localStorage.removeItem('keo-test-gone');
        // direct IndexedDB: keyPath + index + a non-extractable CryptoKey in a record
        const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
        await new Promise((res, rej) => {
          const q = indexedDB.open('keo-persist-test', 1);
          q.onupgradeneeded = () => { const st = q.result.createObjectStore('msgs', { keyPath: 'msgId' }); st.createIndex('thread', 'threadId'); q.result.createObjectStore('keys'); };
          q.onsuccess = () => {
            const tx = q.result.transaction(['msgs', 'keys'], 'readwrite');
            tx.objectStore('msgs').put({ msgId: 'a', threadId: 't', body: 'persisted body' });
            tx.objectStore('msgs').put({ msgId: 'b', threadId: 't', body: 'second' });
            tx.objectStore('keys').put(key, 'device');
            tx.oncomplete = () => { q.result.close(); res(); };
            tx.onabort = () => rej(tx.error);
          };
          q.onerror = () => rej(q.error);
        });
        // the runtime's own wrapper, and the identity record through DID.saveMeta
        await new Promise((res) => lively.IndexedDB.set('wrapper-key', 'wrapper-value', res, 'persist-store'));
        await new Promise((res) => lively.identity.did.saveMeta({ handle: 'bridge-test', displayName: 'Bridge Test', did: 'did:test:1', rpId: location.hostname }, res));
      });
      await sleep(1000);       // write-behind
      await s.page.close();
      s = await openShell(ctx);   // a fresh page: new world instance, everything read back from the shell's store
      const back = await s.frame.evaluate(async () => {
        const out = {};
        out.ls = localStorage.getItem('keo-test-a'); out.lsNum = lively.LocalStorage.get('keo-test-num'); out.lsGone = localStorage.getItem('keo-test-gone');
        out.lsKeys = Object.getOwnPropertyNames(localStorage).filter((k) => k.indexOf('keo-test') >= 0).sort();
        out.wrapper = await new Promise((res) => lively.IndexedDB.get('wrapper-key', (e, v) => res(v), 'persist-store'));
        out.meta = await new Promise((res) => lively.identity.did.loadMeta((e, m) => res(m)));
        await new Promise((res, rej) => {
          const q = indexedDB.open('keo-persist-test');
          q.onsuccess = () => {
            const tx = q.result.transaction(['msgs', 'keys'], 'readonly');
            const a = tx.objectStore('msgs').index('thread').getAll('t');
            const k = tx.objectStore('keys').get('device');
            tx.oncomplete = () => {
              out.msgs = a.result.map((r) => r.body);
              out.key = k.result && { type: k.result.type, extractable: k.result.extractable, algorithm: k.result.algorithm && k.result.algorithm.name };
              res();
            };
          };
          q.onerror = () => rej(q.error);
        });
        return out;
      });
      check('persist: localStorage value survives a new page', back.ls === 'one' && back.lsNum === 42 && back.lsGone === null, back);
      // lively.LocalStorage prefixes its keys with "lively"
      check('persist: Object.getOwnPropertyNames(localStorage) lists the keys', JSON.stringify(back.lsKeys) === JSON.stringify(['keo-test-a', 'livelykeo-test-num']), back.lsKeys);
      check('persist: lively.IndexedDB wrapper value survives', back.wrapper === 'wrapper-value', back.wrapper);
      check('persist: DID.saveMeta / loadMeta survives', back.meta && back.meta.handle === 'bridge-test' && back.meta.rpId === ID, back.meta);
      check('persist: keyPath store + index read back after reload', JSON.stringify(back.msgs) === JSON.stringify(['persisted body', 'second']), back.msgs);
      check('persist: a non-extractable CryptoKey in a record survives', back.key && back.key.type === 'secret' && back.key.extractable === false && back.key.algorithm === 'AES-GCM', back.key);
      // the shell's real store holds it (read straight from the shell page's own IndexedDB)
      const shellView = await s.page.evaluate(async () => {
        const ls = await keoStore.lsAll(); const db = await keoStore.idbLoad('keo-persist-test'); const list = await keoStore.idbList();
        return { ls: ls['keo-test-a'], stores: db && Object.keys(db.stores), records: db && db.stores.msgs.records.length, version: db && db.version, names: list.map((x) => x.name).sort() };
      });
      check('persist: the shell page\'s real IndexedDB holds the data', shellView.ls === 'one' && shellView.records === 2 && shellView.version === 1, shellView);
      // the restored fake identity ("bridge-test") makes the world call server routes the offline package does not have
      // (session, /@handle/..., users/<handle>/config.js); those failures are the next piece of work, not a bridge fault
      const unexpected = s.errors.filter((e) => !/IdentityServer\/session|\/@bridge-test\/|\/users\/bridge-test\/|XHR request failed for .*\/(users\/bridge-test|@bridge-test)/.test(e));
      check('persist: no page errors other than the fake identity server routes', unexpected.length === 0, unexpected);
    } finally { await ctx.close(); }
  }

  // ================= transfer: buffers handed over on a call, never taken by the bridge on its own =================
  if (PARTS.includes('transfer')) {
    const ctx = await launch('profile-bridge-transfer');
    try {
      const s = await openShell(ctx);
      // The shell page notes every call of the test's own op: what arrived (length, a checksum of the bytes, the other arguments).
      await s.page.evaluate(() => {
        window.__got = [];
        window.addEventListener('message', (ev) => {
          const m = ev.data;
          if (!m || m.keo !== 1 || m.op !== 'test.transfer') return;
          const b = m.args && m.args.bytes; let sum = 0, first = null, last = null;
          if (b instanceof ArrayBuffer) { const u = new Uint8Array(b); first = u[0]; last = u[u.length - 1]; for (let i = 0; i < u.length; i++) sum = (sum + u[i] * ((i % 251) + 1)) % 4294967291; }
          window.__got.push({ tag: m.args && m.args.tag, n: m.args && m.args.n, isBuffer: b instanceof ArrayBuffer, len: b ? b.byteLength : null, sum, first, last });
        });
      });
      const r = await s.frame.evaluate(async () => {
        const out = {};
        const mk = (n, seed) => { const u = new Uint8Array(n); for (let i = 0; i < n; i++) u[i] = (i * 31 + seed) & 255; return u.buffer; };
        const sumOf = (b) => { const u = new Uint8Array(b); let sum = 0; for (let i = 0; i < u.length; i++) sum = (sum + u[i] * ((i % 251) + 1)) % 4294967291; return sum; };
        const ask = async (args, transfer) => { const t0 = performance.now(); try { await window.keo.call('test.transfer', args, 4000, transfer); return { ms: performance.now() - t0 }; } catch (e) { return { name: e.name, message: e.message, ms: performance.now() - t0 }; } };
        const N = 1 << 20;
        // handed over: the buffer is empty here afterwards, and the shell got every byte
        const a = mk(N, 1); out.aSum = sumOf(a);
        out.aAnswer = await ask({ tag: 'a', n: 7, bytes: a }, [a]);
        out.aAfter = a.byteLength;
        // not listed: copied, the buffer is still whole
        const b = mk(N, 2); out.bSum = sumOf(b);
        out.bAnswer = await ask({ tag: 'b', n: 8, bytes: b });
        out.bAfter = b.byteLength; out.bSumAfter = sumOf(b);
        // listed in a call whose buffer is kept by the caller on purpose: ONLY what is listed is detached (a second buffer in the arguments is not)
        const c1 = mk(1024, 3), c2 = mk(2048, 4);
        out.cAnswer = await ask({ tag: 'c', n: 9, bytes: c1, other: c2 }, [c1]);
        out.cAfter = [c1.byteLength, c2.byteLength];
        // a transfer list that is not a list is ignored (a copy is made, nothing is detached)
        const d = mk(1024, 5);
        out.dAnswer = await ask({ tag: 'd', n: 10, bytes: d }, 'yes please');
        out.dAfter = d.byteLength;
        // a buffer that was handed over already cannot be handed over again: refused at once, not left waiting for the timeout
        out.eAnswer = await ask({ tag: 'e', n: 11, bytes: a }, [a]);
        // a view is not a transferable: refused at once
        const f = new Uint8Array(mk(1024, 6));
        out.fAnswer = await ask({ tag: 'f', n: 12, bytes: f }, [f]);
        out.fAfter = f.byteLength;
        // after refusals the bridge still answers (nothing is left stuck), and the refused calls did not reach the shell
        out.after = await ask({ tag: 'g', n: 13 });
        return out;
      });
      const got = await s.page.evaluate(() => window.__got);
      const g = (tag) => got.find((x) => x.tag === tag);
      check('transfer: a listed buffer arrives whole in the shell (length and every byte)', g('a') && g('a').isBuffer && g('a').len === (1 << 20) && g('a').sum === r.aSum && g('a').n === 7, [g('a'), r.aSum]);
      check('transfer: and is empty in the world afterwards (it was handed over, not copied)', r.aAfter === 0, r.aAfter);
      check('transfer: a call answered as usual (the shell here answers an unknown op, with that sentence)', /unknown op test\.transfer/.test(r.aAnswer.message || ''), r.aAnswer);
      check('transfer: a buffer that is not listed is copied: whole in the shell, and still whole in the world', g('b') && g('b').len === (1 << 20) && g('b').sum === r.bSum && r.bAfter === (1 << 20) && r.bSumAfter === r.bSum, [g('b'), r.bSum, r.bAfter]);
      check('transfer: only what is listed is detached, a second buffer in the same arguments is copied', r.cAfter[0] === 0 && r.cAfter[1] === 2048 && g('c') && g('c').len === 1024, [r.cAfter, g('c')]);
      check('transfer: something that is not a list is ignored, and the call goes through as a copy', r.dAfter === 1024 && g('d') && g('d').len === 1024, [r.dAfter, g('d')]);
      check('transfer: a buffer handed over twice is refused at once, by the browser, and never reaches the shell', r.eAnswer.name === 'DataCloneError' && r.eAnswer.ms < 1500 && !g('e'), [r.eAnswer, g('e')]);
      check('transfer: a view in the list is refused at once, and not detached', r.fAnswer.name === 'DataCloneError' && r.fAnswer.ms < 1500 && r.fAfter === 1024 && !g('f'), [r.fAnswer, r.fAfter, g('f')]);
      check('transfer: after refusals the bridge still answers', /unknown op test\.transfer/.test(r.after.message || '') && g('g') && g('g').isBuffer === false, [r.after, g('g')]);
      check('transfer: no page errors', s.errors.length === 0, s.errors);
    } finally { await ctx.close(); }
  }

  // ================= leave: a world may ask for a moment before it is left (keo.beforeLeave) =================
  if (PARTS.includes('leave')) {
    const ctx = await launch('profile-bridge-leave');
    try {
      const s = await openShell(ctx);
      // Every op the shell is asked, in order, kept on this side so that it survives the shell page reloading (sign-out reloads it).
      // Nobody is signed in here, so a move is answered by the shell with a sentence: no page is left behind.
      const shellOps = [];
      s.page.on('console', (m) => { const t = m.text(); if (t.startsWith('LEAVEOP ')) shellOps.push(t.slice(8)); });
      await s.page.evaluate(() => window.addEventListener('message', (ev) => { const m = ev.data; if (m && m.keo === 1 && typeof m.op === 'string') console.log('LEAVEOP ' + m.op); }));
      const api = await s.frame.evaluate(() => {
        window.__seen = [];
        window.__ask = async (op) => { const t0 = performance.now(); try { await window.keo.call(op, {}, 5000); return { ms: performance.now() - t0 }; } catch (e) { return { message: e.message, ms: performance.now() - t0 }; } };
        return typeof window.keo.beforeLeave;
      });
      const run = async (fn) => { const n0 = shellOps.length; const res = await s.frame.evaluate(fn); await sleep(400); return { res, ops: shellOps.slice(n0) }; };
      check('leave: the bridge offers beforeLeave', api === 'function', api);
      // 1: a hook runs first, and the call waits for it
      await s.frame.evaluate(() => { window.__off = window.keo.beforeLeave(async (op) => { window.__seen.push(op); await new Promise((r) => setTimeout(r, 500)); }); });
      const a = await run(() => window.__ask('world.go'));
      check('leave: a move to another page waits for the hook, then the shell is asked', a.res.ms >= 450 && JSON.stringify(a.ops) === '["world.go"]' && /Sign in/.test(a.res.message || ''), a);
      check('leave: the hook was given the name of the call', JSON.stringify(await s.frame.evaluate(() => window.__seen)) === '["world.go"]');
      // 2: a hook that rejects stops a move: the call answers with its reason and the shell is never asked
      await s.frame.evaluate(() => { window.__off(); window.__off = window.keo.beforeLeave(() => Promise.reject(new Error('not saved: disk full'))); });
      const b = await run(() => window.__ask('world.go'));
      check('leave: a hook that rejects stops a move to another page, with its own reason, and the shell is not asked', b.res.message === 'not saved: disk full' && b.ops.length === 0, b);
      // 3: a call that does not end the world does not meet the hook
      const c = await run(() => window.__ask('session.current'));
      check('leave: a call that does not end the world goes straight to the shell, whatever the hook says', c.res.message !== 'not saved: disk full' && JSON.stringify(c.ops) === '["session.current"]', c);
      // 4: a hook that throws is a hook that rejects
      await s.frame.evaluate(() => { window.__off(); window.__off = window.keo.beforeLeave(() => { throw new Error('threw'); }); });
      const d = await run(() => window.__ask('world.go'));
      check('leave: a hook that throws stops a move as one that rejects does', d.res.message === 'threw' && d.ops.length === 0, d);
      // 5: take the hook away and the call is sent at once, as before there was a hook
      await s.frame.evaluate(() => { window.__off(); });
      const e = await run(() => window.__ask('world.go'));
      check('leave: with the hook taken away the call is sent at once', e.res.ms < 300 && JSON.stringify(e.ops) === '["world.go"]' && /Sign in/.test(e.res.message || ''), e);
      check('leave: no page errors', s.errors.length === 0, s.errors);
      // 6: signing out is never stopped by a hook: the shell is asked although the hook rejects (and reloads its page, which ends this part)
      await s.frame.evaluate(() => { window.keo.beforeLeave(() => Promise.reject(new Error('not saved: disk full'))); window.__ask('session.signOut'); });
      await sleep(1500);
      check('leave: signing out is not stopped by a hook that rejects', shellOps.slice(-1)[0] === 'session.signOut', shellOps.slice(-3));
    } finally { await ctx.close(); }
  }

  // ================= webauthn: ceremonies proxied to the shell =================
  if (PARTS.includes('webauthn')) {
    const ctx = await launch('profile-bridge-webauthn');
    try {
      const s = await openShell(ctx, true);
      const r = await s.frame.evaluate(async () => {
        const out = {};
        const b64u = (ab) => btoa(String.fromCharCode(...new Uint8Array(ab))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
        const same = (a, b) => a.byteLength === b.byteLength && new Uint8Array(a).every((v, i) => v === new Uint8Array(b)[i]);
        out.isFacade = navigator.credentials.create.toString().indexOf('native code') === -1;
        out.uvpaa = await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable();
        const caps = await PublicKeyCredential.getClientCapabilities();
        out.capsIsObject = caps && typeof caps === 'object';
        const salt = new TextEncoder().encode('keo-test-salt');
        const cred = await navigator.credentials.create({ publicKey: { rp: { name: 'keo' }, user: { id: crypto.getRandomValues(new Uint8Array(16)), name: 't', displayName: 't' },
          challenge: crypto.getRandomValues(new Uint8Array(32)), pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
          authenticatorSelection: { residentKey: 'required', userVerification: 'required' }, extensions: { prf: { eval: { first: salt } } } } });
        const ext = cred.getClientExtensionResults();
        const cd = JSON.parse(new TextDecoder().decode(cred.response.clientDataJSON));
        out.create = {
          type: cred.type, idMatchesRawId: cred.id === b64u(cred.rawId), rawIdLen: cred.rawId.byteLength, rawIdIsArrayBuffer: cred.rawId instanceof ArrayBuffer,
          attestationObject: cred.response.attestationObject instanceof ArrayBuffer && cred.response.attestationObject.byteLength > 50,
          cdType: cd.type, cdOrigin: cd.origin, prfEnabled: ext.prf && ext.prf.enabled, prfAtCreate: ext.prf && ext.prf.results && ext.prf.results.first && ext.prf.results.first.byteLength,
          transports: cred.response.getTransports(), alg: cred.response.getPublicKeyAlgorithm(), pubKeyLen: cred.response.getPublicKey().byteLength,
          authDataLen: cred.response.getAuthenticatorData().byteLength, attachment: cred.authenticatorAttachment
        };
        const a = await navigator.credentials.get({ publicKey: { challenge: crypto.getRandomValues(new Uint8Array(32)), allowCredentials: [{ type: 'public-key', id: cred.rawId }],
          userVerification: 'required', extensions: { prf: { eval: { first: salt } } } } });
        const aext = a.getClientExtensionResults();
        const acd = JSON.parse(new TextDecoder().decode(a.response.clientDataJSON));
        out.get = {
          type: a.type, cdType: acd.type, cdOrigin: acd.origin, sigLen: a.response.signature.byteLength, authDataLen: a.response.authenticatorData.byteLength,
          userHandleLen: a.response.userHandle && a.response.userHandle.byteLength, prfLen: aext.prf && aext.prf.results && aext.prf.results.first.byteLength,
          prfSameAsAtCreate: aext.prf && ext.prf.results && same(aext.prf.results.first, ext.prf.results.first)
        };
        // a discoverable get (no allowCredentials) like the new-device login does
        const d = await navigator.credentials.get({ publicKey: { challenge: crypto.getRandomValues(new Uint8Array(32)), userVerification: 'required' } });
        out.discoverable = { rawIdMatches: same(d.rawId, cred.rawId), userHandle: !!d.response.userHandle };
        // an error from the real API keeps its name
        out.errorName = await navigator.credentials.get({ publicKey: { challenge: crypto.getRandomValues(new Uint8Array(32)), rpId: 'example.com' } }).then(() => 'no error', (e) => e.name);
        out.noPublicKey = await navigator.credentials.get({}).then(() => 'no error', (e) => e.name);
        return out;
      });
      check('webauthn: navigator.credentials in the world is the bridge facade', r.isFacade, r);
      check('webauthn: isUserVerifyingPlatformAuthenticatorAvailable / getClientCapabilities answered by the shell', r.uvpaa === true && r.capsIsObject, { uvpaa: r.uvpaa, caps: r.capsIsObject });
      const c = r.create;
      check('webauthn: create returns the fields the identity code reads', c.type === 'public-key' && c.idMatchesRawId && c.rawIdIsArrayBuffer && c.rawIdLen > 0 && c.attestationObject && c.pubKeyLen > 0 && c.authDataLen > 37 && c.alg === -7, c);
      check('webauthn: clientDataJSON names the extension origin', c.cdType === 'webauthn.create' && c.cdOrigin === 'chrome-extension://' + ID, c);
      check('webauthn: PRF enabled and a 32-byte PRF result at creation', c.prfEnabled === true && c.prfAtCreate === 32, c);
      check('webauthn: get returns signature, authenticator data and the same PRF output', r.get.type === 'public-key' && r.get.cdType === 'webauthn.get' && r.get.sigLen > 0 && r.get.authDataLen >= 37 && r.get.prfLen === 32 && r.get.prfSameAsAtCreate === true, r.get);
      check('webauthn: discoverable get (no allowCredentials) returns the credential and user handle', r.discoverable.rawIdMatches && r.discoverable.userHandle, r.discoverable);
      check('webauthn: an error from the real API keeps its name', r.errorName === 'SecurityError', r.errorName);
      check('webauthn: a request without publicKey is refused', r.noPublicKey === 'TypeError', r.noPublicKey);
      check('webauthn: no page errors', s.errors.length === 0, s.errors);
    } finally { await ctx.close(); }
  }

  // ================= vault: the identity vault reached through the shell =================
  if (PARTS.includes('vault')) {
    const ctx = await launch('profile-bridge-vault');
    try {
      const s = await openShell(ctx, true);
      const r = await s.frame.evaluate(async () => {
        const out = {};
        const b64u = (ab) => btoa(String.fromCharCode(...new Uint8Array(ab))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
        const same = (a, b) => a.length === b.length && Array.from(a).every((v, i) => v === b[i]);
        const vault = lively.identity.identityVault, wa = lively.identity.webAuthn;
        const call = (fn) => new Promise((res) => fn((e, v) => res(e ? { err: e.name + ': ' + e.message } : { ok: v })));
        out.config = { origin: lively.Config.get('identityVaultOrigin'), transport: lively.Config.get('identityVaultTransport'), rpId: lively.Config.get('identityRpId') };
        out.enabled = vault.isEnabled();
        out.hello = await call((cb) => vault.call('hello', {}, cb));
        // a credential with PRF, made through the proxied create, then the vault derives its keys with a ceremony of its own
        const cred = await navigator.credentials.create({ publicKey: { rp: { name: 'keo' }, user: { id: crypto.getRandomValues(new Uint8Array(16)), name: 'v', displayName: 'v' },
          challenge: crypto.getRandomValues(new Uint8Array(32)), pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
          authenticatorSelection: { residentKey: 'required', userVerification: 'required' }, extensions: { prf: { eval: { first: new TextEncoder().encode('x') } } } } });
        const credentialId = b64u(cred.rawId);
        out.derive = await call((cb) => vault.deriveKeys({ credentialId: credentialId, rpId: location.hostname, persist: false }, cb));
        const kek = wa._kekCache && wa._kekCache[credentialId];
        out.handles = { kek: !!(kek && vault.isHandle(kek)), noBytes: kek && !(kek instanceof Uint8Array), x25519: !!(wa._x25519Cache && wa._x25519Cache[credentialId] && vault.isHandle(wa._x25519Cache[credentialId].privateKey)) };
        const wrapped = await call((cb) => vault.wrapDek(kek, cb));
        out.wrap = { ok: !!(wrapped.ok && wrapped.ok.dek && wrapped.ok.wrappedDek), dekLen: wrapped.ok && wrapped.ok.dek.length, err: wrapped.err };
        if (wrapped.ok) {
          const un = await call((cb) => vault.unwrapDek(wrapped.ok.wrappedDek, kek, cb));
          out.unwrapMatches = !!(un.ok && same(new Uint8Array(un.ok), new Uint8Array(wrapped.ok.dek)));
        }
        const enc = await call((cb) => vault.encryptPayload({ hello: 'vault', n: 7 }, kek, cb));
        out.encrypted = !!(enc.ok && enc.ok.ciphertext && enc.ok.nonce);
        if (enc.ok) { const dec = await call((cb) => vault.decryptPayload(enc.ok.ciphertext, enc.ok.nonce, kek, cb)); out.decrypted = dec.ok; }
        out.list = await call((cb) => vault.call('list', {}, cb));
        // the vault drops everything on request, and then refuses to do key operations (Locked)
        out.destroy = await call((cb) => vault.call('destroy', {}, cb));
        out.lock = await call((cb) => vault.call('lock', {}, cb));
        const after = await call((cb) => vault.wrapDek(kek, cb));
        out.afterLock = after.err || 'no error';
        // a bridge reply with a colliding id must not be taken for a vault reply
        out.bridgeStillWorks = await window.keo.call('idb.list', {}).then(() => true, () => false);
        return out;
      });
      check('vault: the world is configured to use the shell as vault host', r.config.transport === 'parent' && r.config.origin === 'chrome-extension://' + ID && r.config.rpId === ID && r.enabled, r.config);
      check('vault: hello answered by the vault page through the shell', r.hello.ok && r.hello.ok.version === 1 && r.hello.ok.origin === 'chrome-extension://' + ID && r.hello.ok.hasWebCrypto, r.hello);
      check('vault: the vault runs a passkey ceremony and the world keeps only handles', !r.derive.err && r.handles.kek && r.handles.noBytes && r.handles.x25519, { derive: r.derive, handles: r.handles });
      check('vault: wrapDek then unwrapDek round-trips the key', r.wrap.ok && r.wrap.dekLen === 32 && r.unwrapMatches === true, r.wrap);
      check('vault: encryptPayload then decryptPayload round-trips', r.encrypted && r.decrypted && r.decrypted.hello === 'vault' && r.decrypted.n === 7, { enc: r.encrypted, dec: r.decrypted });
      check('vault: list shows the credential with its keys', r.list.ok && r.list.ok.length === 1 && r.list.ok[0].kek === true && r.list.ok[0].x25519 === true, r.list);
      check('vault: after lock, key operations fail with Locked', /^Locked/.test(r.afterLock), r.afterLock);
      check('vault: the bridge still works alongside the vault protocol', r.bridgeStillWorks === true, r.bridgeStillWorks);
      check('vault: no page errors', s.errors.length === 0, s.errors);
    } finally { await ctx.close(); }
  }

  fs.writeFileSync(path.join(WORK, 'keo-bridge-test.json'), JSON.stringify(results, null, 2));
  const failed = Object.keys(results).filter((k) => !results[k].ok);
  console.log(failed.length ? 'FAILED: ' + failed.length : 'ALL PASSED (' + Object.keys(results).length + ')');
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.log('FATAL', e); process.exit(2); });
