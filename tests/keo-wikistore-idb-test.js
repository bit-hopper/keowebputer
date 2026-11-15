// The wiki store on its real disk: shell/keo-wiki.js (the IndexedDB backend, the session's lifetime, the removal hook) running in the real
// shell page of a built package, over a real session key, with the pure logic of shell/keo-wikistore.js on top. The pure logic has its own
// no-browser test (keo-wikistore-test.js, an in-memory disk); this one is about what only a browser can show: that the sealed records
// survive a page reload and a sign-out, that nothing readable is on disk, that two identities do not share records, that a session that
// ends stops the store, and that removing an identity deletes its records.
//
// The people and the signed edits are made here in node (tests/wiki-fixtures.js) and carried into the page as plain JSON; the identity that
// OWNS the store is a real one made with a virtual authenticator, as keo-session-test.js does.
//
// Usage: [KEO_HEADLESS=1] node keo-wikistore-idb-test.js <repo root> <package folder> <work dir>
// The browser is headed and takes the foreground for a few minutes, unless KEO_HEADLESS=1: then it runs in the browser's newer headless mode
// (no window, no focus taken, extensions still load). The mode is printed first. A headless pass is not a headed pass: nothing here depends
// on focus (the one real click, on the removal question, is sent to the page by the test), but only a headed run shows that.
// NOT covered: a real authenticator, another browser, a browser restart (a virtual authenticator does not survive one), a crash in the middle
// of a write, a very large store (the measurement below is one size, on one machine, printed and not judged).
const fs = require('fs');
const path = require('path');
const { REPO, EXT, WORK } = require('./args.js')();
const { chromium } = require(path.join(REPO, 'node_modules', 'playwright-core'));
const kd = require(path.join(__dirname, '..', 'shell', 'keo-did.js'));
const Y = require(path.join(__dirname, '..', 'shell', 'keo-yjs.js'));
const F = require(path.join(__dirname, 'wiki-fixtures.js'));
const ID = 'keoapnoighmdpncpbfffhcdgdjgjmpdn';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
function check(name, ok, detail) { console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail !== undefined && !ok ? '  -> ' + JSON.stringify(detail).slice(0, 900) : '')); if (!ok) failed++; }
const note = (s) => console.log('NOTE ' + s);
const errors = [];
let phase = '0 start';          // the step the run is in, written on every console error so that a message can be placed
const headless = !!process.env.KEO_HEADLESS;

const worldFrame = (page) => page.frames().find((f) => /world\.html$/.test(f.url()));
async function waitForWorld(page, kind) {
  let frame = null;
  for (let i = 0; i < 200; i++) {
    frame = worldFrame(page);
    if (frame) { try { if (await frame.evaluate((k) => !!(window.$world && window.$world.submorphs && window.keo && window.keo.init && window.keo.init.startup && window.keo.init.startup.kind === k), kind)) break; } catch (e) { /* still loading */ } }
    frame = null; await sleep(300);
  }
  if (!frame) throw new Error('the world did not start as ' + kind);
  await sleep(2500);
  return frame;
}
const keoCall = (frame, op, args) => frame.evaluate(([o, a]) => window.keo.call(o, a, 60000).then((r) => ({ ok: true, r }), (e) => ({ ok: false, e: e.message })), [op, args || {}]);

// ---- what node makes and the page is given ------------------------------------------------------------------------------------------
async function fixtures() {
  const A = await F.makePerson(), B = await F.makePerson(), C = await F.makePerson(), D = await F.makePerson(), E = await F.makePerson();
  const wa = await F.writer(A, A.d1), wb = await F.writer(B, B.d1);
  const e1 = await wa.publish((d) => d.getText('body').insert(0, 'hello')), c1 = await F.cidOf(e1);
  const e2 = await wa.publish((d) => d.getText('body').insert(5, ' world'), [c1]), c2 = await F.cidOf(e2);
  const b1 = await wb.publish((d) => d.getText('body').insert(0, 'from B'), []), bc1 = await F.cidOf(b1);
  const b2 = await wb.publish((d) => d.getText('body').insert(6, '!'), [bc1]), bc2 = await F.cidOf(b2);
  const wc = await F.writer(C, C.d1);
  await wc.publish((d) => d.getText('body').insert(0, 'x'));                                   // made, never sent: the next one skips ahead of it
  const ahead = await wc.publish((d) => d.getText('body').insert(1, 'y'), []);
  const same = 'nonce-q0001xx';
  const t1 = await (await F.writer(D, D.d1, same, 'page-eq')).publish((d) => d.getText('body').insert(0, 'ONE'), []);
  const t2 = await (await F.writer(D, D.d1, same, 'page-eq')).publish((d) => d.getText('body').insert(0, 'TWO'), []);     // same device, page and nonce: the same client id, other content
  const olderA = A.snapshot();
  await A.addDevice();
  const longerA = A.snapshot();
  const mk = async (person, dev, objId, n, word) => {
    const w = await F.writer(person, dev, undefined, objId), out = []; let parents = [], text = '';
    for (let i = 0; i < n; i++) { const env = await w.publish((d) => d.getText('body').insert(d.getText('body').length, word + i + ' '), parents); out.push(env); parents = [await F.cidOf(env)]; text += word + i + ' '; }
    return { envs: out, text };
  };
  const long = await mk(A, A.d1, 'page-long', 300, 'w'), race = await mk(B, B.d1, 'page-race', 60, 'r');
  const lone = await (await F.writer(B, B.d1, undefined, 'page-lone')).publish((d) => d.getText('body').insert(0, 'lone'), []);
  const u = (env) => kd.unb64u(env.event.payload.update);
  return {
    dids: { A: A.did, B: B.did, C: C.did, D: D.did, E: E.did },
    logs: { A: olderA, B: B.snapshot(), C: C.snapshot(), D: D.snapshot(), E: E.snapshot() }, longerA,
    e1, e2, b1, b2, ahead, t1, t2, c1, c2, bc1, bc2, long: long.envs, race: race.envs, lone,
    expectMain: F.textOf(Y.mergeUpdates([u(e1), u(e2), u(b1), u(b2)])), expectLong: long.text
  };
}

(async () => {
  fs.mkdirSync(WORK, { recursive: true });
  const data = await fixtures();
  const profile = path.join(WORK, 'profile-wikiidb-' + process.pid);
  const ctx = await chromium.launchPersistentContext(profile, Object.assign({ headless, viewport: { width: 1280, height: 860 },
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--host-resolver-rules=MAP localhost ~NOTFOUND, MAP 127.0.0.1 ~NOTFOUND'] }, headless ? { channel: 'chromium' } : {}));
  console.log('MODE ' + (headless ? 'HEADLESS (newer headless mode, channel chromium)' : 'headed') + '; browser ' + (ctx.browser() ? ctx.browser().version() : 'unknown') + '; package ' + path.basename(EXT));
  await sleep(2500);
  try {
    // Page-side helpers, put in the shell page before its own scripts run, every time it loads: read the raw records through a separate
    // connection (so what the store says about itself is not what is checked).
    await ctx.addInitScript(() => {
      if (!(location.protocol === 'chrome-extension:' && /start\.html/.test(location.pathname))) return;
      const open = () => new Promise((res, rej) => { const q = indexedDB.open('keo-wiki'); q.onupgradeneeded = () => { q.transaction.abort(); }; q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); });
      const all = async () => { const db = await open(); try { return await new Promise((res, rej) => { const t = db.transaction('records'), st = t.objectStore('records'), ks = st.getAllKeys(), vs = st.getAll(); t.oncomplete = () => res({ keys: ks.result, vals: vs.result }); t.onerror = t.onabort = () => rej(t.error); }); } finally { db.close(); } };
      window.__t = {
        rows: async () => { const { keys, vals } = await all(); return keys.map((k, i) => ({ k, did: k.split('\u0000')[0], kind: k.split('\u0000')[1], ivLen: String(vals[i].iv).length, ctLen: vals[i].ct.length, bytes: vals[i].ct instanceof Uint8Array })); },
        scan: async (needles) => { const { keys, vals } = await all(); const found = new Set(); keys.forEach((k, i) => { let s = k + '\n' + vals[i].iv + '\n'; const ct = vals[i].ct; for (let j = 0; j < ct.length; j += 8192) s += String.fromCharCode.apply(null, ct.subarray(j, j + 8192)); needles.forEach((n) => { if (s.includes(n)) found.add(n); }); }); return Array.from(found); }
      };
    });
    const page = await ctx.newPage();
    page.on('pageerror', (e) => errors.push('PAGEERROR ' + e.message.slice(0, 200)));
    page.on('console', (m) => { if (m.type() === 'error' && !/compute-pressure|ERR_FILE_NOT_FOUND/.test(m.text())) errors.push('console: [' + phase + '] ' + m.text().slice(0, 200)); });
    const cdp = await ctx.newCDPSession(page);
    await cdp.send('WebAuthn.enable', { enableUI: false });
    await cdp.send('WebAuthn.addVirtualAuthenticator', { options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true, hasPrf: true } });

    await page.goto(`chrome-extension://${ID}/start.html`);
    await waitForWorld(page, 'gate');

    phase = '0 packages and the store signed out';
    // ---- 0. what the package loads, and the store with nobody signed in -------------------------------------------------------------
    check('the shell page has the Yjs copy, the update reader, the wiki event code, the store and its shell part',
      await page.evaluate(() => ['keoYjs', 'keoYUpdate', 'keoWikiLog', 'keoWikiStore', 'keoWiki'].every((n) => !!window[n])));
    check('with nobody signed in the store is not given out', await page.evaluate(() => { try { window.keoWiki.store(); return false; } catch (e) { return /Sign in/.test(e.message); } }));

    phase = '1 backend';
    // ---- 1. the backend, on its own (two made-up identities, no session) -------------------------------------------------------------
    const contract = await page.evaluate(async () => {
      const one = 'did:keo:contract-one', two = 'did:keo:contract-two', b1 = window.keoWiki.backend(one), b2 = window.keoWiki.backend(two), out = {};
      const bytes = (n, s) => { const a = new Uint8Array(n); for (let i = 0; i < n; i++) a[i] = (i * 7 + s) & 255; return a; };
      out.missing = (await b1.get('version', 'nothing-here')) === undefined;
      await b1.put('version', 'v-1', { iv: 'AAAAAAAAAAAAAAAA', ct: bytes(40, 1) }); await b1.put('version', 'v_2', { iv: 'BBBBBBBBBBBBBBBB', ct: bytes(41, 2) });
      await b1.put('log', 'L-1', { iv: 'CCCCCCCCCCCCCCCC', ct: bytes(5, 3) }); await b2.put('version', 'v-1', { iv: 'DDDDDDDDDDDDDDDD', ct: bytes(6, 4) });
      const g = await b1.get('version', 'v-1');
      out.roundTrip = !!g && g.iv === 'AAAAAAAAAAAAAAAA' && g.ct instanceof Uint8Array && g.ct.length === 40 && g.ct.every((x, i) => x === ((i * 7 + 1) & 255));
      out.ids = JSON.stringify([(await b1.ids('version')).sort(), (await b1.ids('log')), (await b1.ids('page')), (await b2.ids('version')), (await b2.ids('log'))]);
      out.scoped = (await b2.get('version', 'v-1')).iv === 'DDDDDDDDDDDDDDDD' && (await b2.get('version', 'v_2')) === undefined;
      await b1.put('version', 'v-1', { iv: 'EEEEEEEEEEEEEEEE', ct: bytes(3, 5) });
      out.overwrite = (await b1.get('version', 'v-1')).iv === 'EEEEEEEEEEEEEEEE' && (await b1.ids('version')).length === 2;
      await b1.del('version', 'v_2');
      out.del = JSON.stringify(await b1.ids('version')) === JSON.stringify(['v-1']);
      const bad = async (f) => { try { await f(); return false; } catch (e) { return true; } };
      out.badKind = await bad(() => b1.put('nonsense', 'x', { iv: 'a', ct: new Uint8Array(1) }));
      out.badId = await bad(() => b1.get('version', ''));
      out.badDid = await bad(async () => window.keoWiki.backend('did:keo:a\u0000b'));
      await window.keoWiki.purge(one);
      out.purgeScoped = (await b1.ids('version')).length === 0 && (await b1.ids('log')).length === 0 && (await b2.ids('version')).length === 1;
      await window.keoWiki.purge(two);
      out.gone = (await window.__t.rows()).filter((r) => /contract-/.test(r.did)).length === 0;
      return out;
    });
    check('backend: a record that is not there reads as undefined', contract.missing === true, contract);
    check('backend: what was put comes back byte for byte', contract.roundTrip === true, contract);
    check('backend: ids lists one kind of one identity and strips the prefix (and nothing of the other identity)', contract.ids === JSON.stringify([['v-1', 'v_2'], ['L-1'], [], ['v-1'], []]), contract.ids);
    check('backend: the same record id under another identity is another record', contract.scoped === true, contract);
    check('backend: putting again replaces; delete removes one record', contract.overwrite === true && contract.del === true, contract);
    check('backend: an unknown kind, an empty id and an identity with a NUL are refused', contract.badKind && contract.badId && contract.badDid, contract);
    check('backend: purge(did) removes that identity\'s records and no one else\'s, and needs no session', contract.purgeScoped === true && contract.gone === true, contract);

    phase = '2 identity and store';
    // ---- 2. a real identity, the store as the shell gives it, and the sealed history through it ---------------------------------------
    const did = await page.evaluate(() => window.keoIdentity.create({ label: 'Maya' }).then(() => window.keoIdentity.current()).then((s) => s.did));
    check('a signed-in identity was made', /^did:keo:/.test(did), did);
    const first = await page.evaluate((d) => {
      const s1 = window.keoWiki.store(), s2 = window.keoWiki.store();
      return { same: s1 === s2, ops: ['add', 'offerLog', 'heads', 'state', 'versions', 'alerts', 'pending', 'recheck', 'close'].every((m) => typeof s1[m] === 'function') };
    }, did);
    check('the shell gives one store per session, with the whole interface', first.same && first.ops, first);

    const S2 = await page.evaluate(async (d) => {
      const s = window.keoWiki.store(), out = {};
      for (const n of ['A', 'B', 'C', 'D']) out['log' + n] = (await s.offerLog(d.dids[n], d.logs[n])).status;
      const r = await s.add(d.e1);
      out.noWriters = { status: r.status, heads: (await s.heads('page-one')).length, pending: (await s.pending('page-one')).length };
      window.keoWiki.setWriters(async () => [d.dids.A, d.dids.B, d.dids.C, d.dids.D]);
      out.recheck = (await s.recheck('page-one')).length;
      out.afterRecheck = { heads: await s.heads('page-one'), pending: (await s.pending('page-one')).length };
      out.e2 = (await s.add(d.e2)).status;
      out.b2first = (await s.add(d.b2)).status;
      const rb1 = await s.add(d.b1);
      out.b1 = { status: rb1.status, also: rb1.alsoAccepted };
      out.dup = (await s.add(d.e1)).status;
      const heads = await s.heads('page-one'), st = await s.state('page-one'), doc = new window.keoYjs.Doc();
      window.keoYjs.applyUpdate(doc, st.update);
      out.heads = heads.slice().sort(); out.text = doc.getText('body').toString(); out.versions = (await s.versions('page-one')).length;
      const ra = await s.add(d.ahead); out.ahead = { status: ra.status, error: ra.error };
      out.t1 = (await s.add(d.t1)).status;
      const rt = await s.add(d.t2); out.t2 = { status: rt.status, error: rt.error };
      out.alerts = (await s.alerts()).map((a) => a.kind).sort();
      out.logExt = (await s.offerLog(d.dids.A, d.longerA)).status;
      out.logAgain = (await s.offerLog(d.dids.A, d.longerA)).status;
      out.logShort = (await s.offerLog(d.dids.A, d.logs.A)).status;
      return out;
    }, data);
    check('every identity log offered was kept', ['logA', 'logB', 'logC', 'logD'].every((k) => S2[k] === 'new'), S2);
    check('until someone says who may write a page, an edit waits as pending and nothing is accepted', S2.noWriters.status === 'pending' && S2.noWriters.heads === 0 && S2.noWriters.pending === 1, S2.noWriters);
    check('once the writers are named, rechecking settles that waiting edit', S2.recheck === 1 && JSON.stringify(S2.afterRecheck.heads) === JSON.stringify([data.c1]) && S2.afterRecheck.pending === 0, S2);
    check('the author\'s next edit is accepted; an edit that arrives before its parent waits and is settled when the parent comes; a repeat is a duplicate',
      S2.e2 === 'accepted' && S2.b2first === 'pending' && S2.b1.status === 'accepted' && JSON.stringify(S2.b1.also) === JSON.stringify([data.bc2]) && S2.dup === 'duplicate', S2);
    check('the page has the two heads and reads as both writers\' edits together (the text node computed from the same updates)', JSON.stringify(S2.heads) === JSON.stringify([data.c2, data.bc2].sort()) && S2.text === data.expectMain && S2.versions === 4, { heads: S2.heads, text: S2.text, want: data.expectMain });
    check('an edit that skips ahead of its author\'s clock numbers is refused', S2.ahead.status === 'refused' && /skips ahead/.test(S2.ahead.error), S2.ahead);
    check('two different edits under one client id: the first stays, the second is refused, and both refusals are in the alerts', S2.t1 === 'accepted' && S2.t2.status === 'refused' && S2.alerts.join() === 'clock-ahead,equivocation', S2);
    check('a longer log extends the kept one, the same again changes nothing, an older one is "shorter"', S2.logExt === 'extended' && S2.logAgain === 'same' && S2.logShort === 'shorter', S2);

    phase = '3 disk';
    // ---- 3. what is on disk ----------------------------------------------------------------------------------------------------------
    const rows = await page.evaluate(() => window.__t.rows());
    const count = (k) => rows.filter((r) => r.kind === k).length;
    check('every record is kept under the signed-in identity\'s DID, in the kinds the store uses, and the five accepted edits are five version records',
      rows.length > 0 && rows.every((r) => r.did === did && ['page', 'version', 'pending', 'log', 'meta'].includes(r.kind)) && count('version') === 5 && count('log') === 4 && count('page') === 2 && count('meta') === 1 && count('pending') === 0, { n: rows.length, versions: count('version'), logs: count('log'), pages: count('page') });
    check('every record is sealed: a 12-byte nonce and ciphertext as bytes', rows.every((r) => r.ivLen === 16 && r.bytes === true && r.ctLen > 16), rows.slice(0, 3));
    const needles = ['hello', 'world', 'from B', 'page-one', 'page-eq', 'keo-wiki-version', 'equivocation', 'clock-ahead', data.dids.A, data.dids.B, data.dids.C, data.dids.D, kd.parseDid(data.dids.A).dk];
    const leaked = await page.evaluate((n) => window.__t.scan(n), needles);
    check('nothing readable on disk: not the text, the page name, the kinds of alert, nor any author\'s identity (the owner\'s DID is in the key by design)', leaked.length === 0, leaked);

    // ---- 3b. the log book as the connection code uses it: pin (keo-hello.js verifiers get it as `pin`) and pinFriend (for what anyone can send)
    phase = '3b log book entry points';
    const S3b = await page.evaluate(async (d) => {
      const s = window.keoWiki.store(), me = (await window.keoIdentity.current()).did, out = {};
      out.older = (await window.keoWiki.pin(d.dids.A, d.logs.A)).status;                  // the book holds A's longer log since step 2
      out.same = (await window.keoWiki.pin(d.dids.A, d.longerA)).status;
      out.own = !!(await s.logOf(me));
      out.stranger = await window.keoWiki.pinFriend(d.dids.E, d.logs.E);
      out.strangerKept = !!(await s.logOf(d.dids.E));
      await window.keoContacts.ensure(); await window.keoContacts.add(d.dids.E, 'Eve');
      out.friend = (await window.keoWiki.pinFriend(d.dids.E, d.logs.E)).status;
      out.friendKept = !!(await s.logOf(d.dids.E));
      await window.keoContacts.remove(d.dids.E);
      return out;
    }, data);
    check('pin: an older log of an identity is "shorter", the kept one is "same", and the signed-in identity\'s own log is now in the book', S3b.older === 'shorter' && S3b.same === 'same' && S3b.own === true, S3b);
    check('pinFriend keeps nothing for an identity that is not a friend, and answers "new" so that a verifier does not refuse it for that', S3b.stranger.status === 'new' && S3b.stranger.kept === false && S3b.strangerKept === false, S3b);
    check('pinFriend keeps the log of a friend', S3b.friend === 'new' && S3b.friendKept === true, S3b);

    phase = '4 reload';
    // ---- 4. a reload: a new page load, the session comes back, the records are opened again --------------------------------------------
    await page.reload();
    let cur = null;
    for (let i = 0; i < 50 && !cur; i++) { cur = await page.evaluate(() => window.keoIdentity.current()).catch(() => null); if (!cur) await sleep(300); }
    check('after a reload the session is back with no prompt', !!cur && cur.did === did, cur);
    const S4 = await page.evaluate(async (d) => {
      const s = window.keoWiki.store(), doc = new window.keoYjs.Doc(), t0 = performance.now();
      const heads = await s.heads('page-one'); const st = await s.state('page-one'); window.keoYjs.applyUpdate(doc, st.update);
      return { heads: heads.slice().sort(), text: doc.getText('body').toString(), alerts: (await s.alerts()).map((a) => a.kind).sort(), pending: (await s.pending('page-one')).length,
        logA: (await s.logOf(d.dids.A)).events.length, ms: Math.round(performance.now() - t0), versions: (await s.versions('page-one')).length };
    }, data);
    check('the reloaded page reads back the same heads, text, alerts and pinned logs from the sealed records (same session key, new page load)',
      JSON.stringify(S4.heads) === JSON.stringify([data.c2, data.bc2].sort()) && S4.text === data.expectMain && S4.alerts.join() === 'clock-ahead,equivocation' && S4.pending === 0 && S4.logA === 1 && S4.versions === 4, S4);

    phase = '5 long page';
    // ---- 5. a longer page: 300 edits one after another, then read cold ----------------------------------------------------------------
    const S5 = await page.evaluate(async (d) => {
      const s = window.keoWiki.store(); window.keoWiki.setWriters(async () => [d.dids.A, d.dids.B]);
      const t0 = performance.now(); let bad = 0;
      for (const env of d.long) { const r = await s.add(env); if (r.status !== 'accepted') bad++; }
      const addMs = performance.now() - t0;
      await s.unload();
      const t1 = performance.now(); const heads = await s.heads('page-long'); const t2 = performance.now();
      const st = await s.state('page-long'); const t3 = performance.now();
      const doc = new window.keoYjs.Doc(); window.keoYjs.applyUpdate(doc, st.update);
      return { bad, addMs: Math.round(addMs), perAdd: Math.round(addMs / d.long.length * 10) / 10, headsMs: Math.round(t2 - t1), stateMs: Math.round(t3 - t2), n: heads.length, text: doc.getText('body').toString() };
    }, data);
    check('300 edits in a chain are all accepted, and read back cold (after the store forgot its memory) as one head and the whole text', S5.bad === 0 && S5.n === 1 && S5.text === data.expectLong, { bad: S5.bad, heads: S5.n });
    note('300 chained edits, headless=' + headless + ', one machine, one run: adding took ' + S5.addMs + ' ms in all (' + S5.perAdd + ' ms each, each add rewrites the page record), then reading the heads cold took ' + S5.headsMs + ' ms and building the state ' + S5.stateMs + ' ms. Not a benchmark: no repeats, no idle-machine control.');
    check('sanity bound only: the cold read of 300 edits took under 20 s', S5.headsMs + S5.stateMs < 20000, S5);

    phase = '6 second identity';
    // ---- 6. a second identity on the same device, the same page name ------------------------------------------------------------------
    const S6 = await page.evaluate(async (d) => {
      const decoy = 'did:keo:decoy-one', key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
      const other = window.keoWikiStore.create({ backend: window.keoWiki.backend(decoy), key, did: decoy, writers: async () => [d.dids.A] });
      const mine = window.keoWiki.store(), before = (await mine.heads('page-one')).length;
      await other.offerLog(d.dids.A, d.logs.A);
      const r = await other.add(d.e1);
      const readsMine = await window.keoWikiStore.create({ backend: window.keoWiki.backend((await window.keoIdentity.current()).did), key, did: decoy, writers: async () => [] }).heads('page-one').then(() => 'read', (e) => e.message);
      const out = { added: r.status, theirs: await other.heads('page-one'), mineBefore: before, mineAfter: (await mine.heads('page-one')).length, readsMine };
      await window.keoWiki.purge(decoy);                                   // the made-up identity goes again: later steps look at every record
      out.decoyGone = (await window.__t.rows()).filter((x) => x.did === decoy).length === 0;
      return out;
    }, data);
    check('a second identity keeps its own history of a page with the same name (and the same edit) without touching the first\'s', S6.added === 'accepted' && S6.theirs.length === 1 && S6.mineBefore === 2 && S6.mineAfter === 2 && S6.decoyGone === true, S6);
    check('another key cannot open the first identity\'s records', /could not be decrypted/.test(S6.readsMine), S6.readsMine);

    phase = '7 sign-out and sign-in';
    // ---- 7. the session ends: the store stops, the records stay, the same session key opens them again -----------------------------------
    const S7a = await page.evaluate(async () => {
      const old = window.keoWiki.store(); await window.keoIdentity.signOut();
      const out = { oldRefuses: await old.heads('page-one').then(() => 'read', (e) => e.message), newRefuses: (() => { try { window.keoWiki.store(); return 'given'; } catch (e) { return e.message; } })() };
      out.rows = (await window.__t.rows()).length;
      out.pinSignedOut = (() => { try { window.keoWiki.pin('did:keo:x', {}); return 'no error'; } catch (e) { return e.message; } })();
      out.pinFriendSignedOut = await window.keoWiki.pinFriend('did:keo:x', {}).then(() => 'resolved', (e) => e.message);
      return out;
    });
    check('after sign-out the old store refuses to run and no new one is given', /closed/.test(S7a.oldRefuses) && /Sign in/.test(S7a.newRefuses), S7a);
    check('signed out, the log book answers neither pin nor pinFriend (a verifier then refuses: nothing is accepted for want of a book)', /Sign in/.test(S7a.pinSignedOut) && /Sign in/.test(S7a.pinFriendSignedOut), S7a);
    check('signing out deletes nothing', S7a.rows > 300, S7a);
    await page.evaluate((d) => window.keoIdentity.signIn({ did: d }), did);
    const S7b = await page.evaluate(async (d) => {
      const s = window.keoWiki.store();
      const noWriters = (await s.add(d.lone)).status;             // the writer list of the earlier session must not have been carried over
      window.keoWiki.setWriters(async () => [d.dids.A, d.dids.B]);
      const doc = new window.keoYjs.Doc(); window.keoYjs.applyUpdate(doc, (await s.state('page-one')).update);
      return { text: doc.getText('body').toString(), heads: (await s.heads('page-one')).length, noWriters };
    }, data);
    check('signing in again opens the same records (the key is the identity\'s, not the session\'s)', S7b.text === data.expectMain && S7b.heads === 2, S7b);
    check('the writer list of the earlier session is not carried into the next one (an edit waits until it is given again)', S7b.noWriters === 'pending', S7b);

    phase = '8 sign-out during work';
    // ---- 8. a session that ends in the middle of work, and the removal of what it kept ----------------------------------------------------
    const S8 = await page.evaluate(async (d) => {
      const s = window.keoWiki.store(), who = (await window.keoIdentity.current()).did;
      await s.offerLog(d.dids.B, d.logs.B);
      let done = 0; const results = d.race.map((env) => s.add(env).then((r) => { done++; return r.status; }, (e) => { done++; return /closed/.test(e.message) ? 'closed' : 'error: ' + e.message; }));
      while (done < 3) await new Promise((r) => setTimeout(r, 1));        // some are finished, the rest are queued behind the one running
      await window.keoIdentity.signOut();
      const before = (await window.__t.rows()).filter((r) => r.did === who).length;
      const purged = window.keoWiki.purge(who);                           // asked at once, while the edit that was running may still be writing
      const res = await Promise.all(results), hist = {};
      res.forEach((x) => { hist[x] = (hist[x] || 0) + 1; });
      await purged;
      await new Promise((r) => setTimeout(r, 300));                       // a late write, if one could happen, would land by now
      return { hist, before, after: (await window.__t.rows()).filter((r) => r.did === who).length };
    }, data);
    note('sign-out in the middle of 60 queued edits: ' + JSON.stringify(S8.hist) + ' (what was already running finished; the rest were refused as closed)');
    check('the race was real: some edits were done and some were still queued when the session ended', (S8.hist.accepted || 0) >= 3 && (S8.hist.closed || 0) >= 1 && !Object.keys(S8.hist).some((k) => /^error|^refused|^pending/.test(k)), S8.hist);
    check('purge(did) after that leaves no record of the identity, even with work that was under way when the session ended', S8.before > 0 && S8.after === 0, S8);

    // The same, made certain instead of left to timing: one edit is held inside its write (the test holds the store's encryption of a version
    // at a gate), the session ends with nine more queued behind it, and purge is asked while that edit is still held. purge must wait for it,
    // so that when the gate opens and the edit finishes writing, the records it writes are deleted as well.
    await page.evaluate((d) => window.keoIdentity.signIn({ did: d }), did);
    const S8b = await page.evaluate(async (d) => {
      const s = window.keoWiki.store(), who = (await window.keoIdentity.current()).did, td = new TextDecoder();
      window.keoWiki.setWriters(async () => [d.dids.B]);
      await s.offerLog(d.dids.B, d.logs.B);
      const real = crypto.subtle.encrypt; let held = false, release; const gate = new Promise((r) => { release = r; });
      crypto.subtle.encrypt = function (alg, key, bytes) {
        const mine = !held && alg && alg.additionalData && td.decode(alg.additionalData).startsWith('keo-wiki-version');
        if (mine) { held = true; return gate.then(() => real.call(crypto.subtle, alg, key, bytes)); }
        return real.call(crypto.subtle, alg, key, bytes);
      };
      try {
        const running = s.add(d.race[0]).then((r) => r.status, (e) => e.message);
        const queued = d.race.slice(1, 10).map((env) => s.add(env).then((r) => r.status, (e) => (/closed/.test(e.message) ? 'closed' : 'error: ' + e.message)));
        for (let i = 0; i < 400 && !held; i++) await new Promise((r) => setTimeout(r, 5));
        if (!held) return { held: false };
        await window.keoIdentity.signOut();                               // the store is closed: one edit held inside its write, nine queued
        const purged = window.keoWiki.purge(who);
        await new Promise((r) => setTimeout(r, 150));                     // if purge did not wait for the held edit it has deleted by now
        release();
        await purged;
        const first = await running, rest = await Promise.all(queued);
        await new Promise((r) => setTimeout(r, 300));
        return { held: true, first, rest, after: (await window.__t.rows()).filter((r) => r.did === who).length };
      } finally { delete crypto.subtle.encrypt; release(); }
    }, data);
    check('the edit that was held inside its write when the session ended finishes, the nine queued behind it are refused as closed, and purge, asked while it was held, still leaves nothing of the identity',
      S8b.held === true && S8b.first === 'accepted' && S8b.rest.length === 9 && S8b.rest.every((x) => x === 'closed') && S8b.after === 0, S8b);

    phase = '9 removal (goto, world start)';
    // ---- 9. removing an identity, by the world's own request and the person's click: its wiki records go with it -----------------------------
    await page.goto(`chrome-extension://${ID}/start.html`);
    let frame = await waitForWorld(page, 'gate');
    await page.evaluate((d) => window.keoIdentity.signIn({ did: d }), did);
    await keoCall(frame, 'world.go', { kind: 'enter' }).catch(() => {});
    frame = await waitForWorld(page, 'homestar');
    const S9a = await page.evaluate(async (d) => {
      const s = window.keoWiki.store(); window.keoWiki.setWriters(async () => [d.dids.A]);
      await s.offerLog(d.dids.A, d.logs.A); const r = await s.add(d.e1);
      const decoy = window.keoWiki.backend('did:keo:decoy-two'); await decoy.put('version', 'v-1', { iv: 'AAAAAAAAAAAAAAAA', ct: new Uint8Array([1, 2, 3]) });
      const who = (await window.keoIdentity.current()).did, rows = await window.__t.rows();
      return { added: r.status, mine: rows.filter((x) => x.did === who).length, decoy: rows.filter((x) => x.did === 'did:keo:decoy-two').length };
    }, data);
    check('setup: the identity has wiki records, and another identity\'s record sits beside them', S9a.added === 'accepted' && S9a.mine > 0 && S9a.decoy === 1, S9a);
    await page.bringToFront();
    const pend = keoCall(frame, 'identity.remove', { did }).catch((e) => ({ ok: null, e: e.message }));       // the page reloads under it
    await page.waitForSelector('#keo-confirm:not([hidden])', { timeout: 15000 });
    await page.click('#keo-confirm button[data-ans="yes"]');
    let after = null;
    for (let i = 0; i < 80 && !(after && after.ids === 0); i++) {
      await sleep(500);
      after = await page.evaluate(async () => ({ ids: (await window.keoIdentity.list()).length, session: await window.keoIdentity.current(), rows: (await window.__t.rows()).map((r) => r.did) })).catch(() => null);
    }
    check('removing the identity ended its session and left no wiki record of it, and did not touch the other identity\'s', !!after && after.ids === 0 && after.session === null && after.rows.every((d) => d === 'did:keo:decoy-two') && after.rows.length === 1, after);
    await Promise.race([pend, sleep(1000)]);

    // A "Leave site?" confirmation the browser refuses to show: the test leaves a page that has the world's exit warning (page.reload,
    // page.goto) before any real click has been made on it, and the browser blocks such a prompt and says so. It is how the test moves, not
    // the store. The step it is seen in is printed, so a message that is NOT at a navigation would stand out.
    const unload = errors.filter((e) => /Blocked attempt to show a 'beforeunload' confirmation/.test(e));
    if (unload.length) note('the browser blocked ' + unload.length + ' "Leave site?" prompt(s), seen in: ' + unload.map((e) => e.match(/\[([^\]]*)\]/)[1]).join('; ') + ' (the test itself navigating before any click)');
    const mine = errors.filter((e) => !/youtube\.com|Geolocation access/.test(e) && !unload.includes(e));
    check('no page errors or console errors during the run', mine.length === 0, mine.slice(0, 5));
  } catch (e) {
    console.log('FAIL test aborted: ' + (e && e.stack || e));
    console.log('errors seen: ' + JSON.stringify(errors.filter((x) => !/ERR_FILE_NOT_FOUND/.test(x)).slice(-8)));
    failed++;
  } finally {
    await ctx.close();
  }
  console.log(failed ? 'FAILED: ' + failed : 'ALL PASSED');
  process.exit(failed ? 1 : 0);
})();
