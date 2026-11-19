// The wiki page operations through the real bridge: the world frame asks (`keo.call('wiki.list' | 'wiki.open' | 'wiki.edit' | 'wiki.close')`),
// the shell of a built package answers (shell/keo-wikipages.js over the sealed store on its real disk), and the page comes back after a
// reload. The pure logic has its own no-browser test (keo-wikipages-test.js); this one is about what only a browser can show: that the bytes
// survive the bridge in both directions, that a refusal reaches the world as an answer and a mistake as an error, that nothing readable is
// on disk, and that an open page does not outlive the session it was opened in.
//
// The editor's side (a Yjs document under the client id the shell hands out) is played here by this script, outside the page, with the vendored Yjs, and its bytes
// are carried into the world frame as plain numbers: the world's own editor is not involved (that is the kernel part of this slice).
//
// Usage: [KEO_HEADLESS=1] node keo-wikipages-bridge-test.js <repo root> <package folder> <work dir>
// Headed unless KEO_HEADLESS=1 (the mode is printed first). A headless pass is not a headed pass. NOT covered: the kernel editor, a real
// authenticator, another browser, a restart of the browser (a virtual authenticator does not survive one).
const fs = require('fs');
const path = require('path');
const { REPO, EXT, WORK } = require('./args.js')();
const { chromium } = require(path.join(REPO, 'node_modules', 'playwright-core'));
const Y = require(path.join(__dirname, '..', 'shell', 'keo-yjs.js'));
const W = require(path.join(__dirname, '..', 'shell', 'keo-wikilog.js'));
const ID = 'keoapnoighmdpncpbfffhcdgdjgjmpdn';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
function check(name, ok, detail) { console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail !== undefined && !ok ? '  -> ' + JSON.stringify(detail).slice(0, 900) : '')); if (!ok) failed++; }
const note = (s) => console.log('NOTE ' + s);
const errors = [];
let phase = '0 start';
const headless = !!process.env.KEO_HEADLESS;

const worldFrame = (page) => page.frames().find((f) => /world\.html$/.test(f.url()));
async function waitForWorld(page, kind) {
  let frame = null;
  for (let i = 0; i < 200; i++) {
    frame = worldFrame(page);
    if (frame) { try { if (await frame.evaluate((k) => !!(window.$world && window.$world.submorphs && window.keo && window.keo.init && window.keo.init.startup && window.keo.init.startup.kind === k), kind)) break; } catch (e) { /* not ready */ } }
    frame = null; await sleep(300);
  }
  if (!frame) throw new Error('the world did not start as ' + kind);
  await sleep(2500);
  return frame;
}
async function waitForAnyWorld(page, kinds) {
  for (let i = 0; i < 200; i++) {
    const fr = worldFrame(page);
    if (fr) { try { const k = await fr.evaluate(() => !!(window.$world && window.$world.submorphs && window.keo && window.keo.init && window.keo.init.startup) && window.keo.init.startup.kind); if (kinds.indexOf(k) >= 0) { await sleep(2500); return fr; } } catch (e) { /* not ready */ } }
    await sleep(300);
  }
  throw new Error('the world did not start as one of ' + kinds.join(', '));
}
// A call from the world frame. `update` goes in as plain numbers and is made into bytes inside the frame (the way an editor would hand
// them over); a `state` that comes back is described (its type) and turned into plain numbers to cross back to the test.
const keoCall = (frame, op, args) => frame.evaluate(([o, a]) => {
  if (a && Array.isArray(a.update)) a.update = new Uint8Array(a.update);
  if (a && a.updateAsBuffer) { a.update = new Uint8Array(a.updateAsBuffer).buffer; delete a.updateAsBuffer; }
  return window.keo.call(o, a, 60000).then((r) => {
    if (r && r.state) { r.stateType = Object.prototype.toString.call(r.state); r.state = Array.from(r.state); }
    return { ok: true, r };
  }, (e) => ({ ok: false, e: e.message }));
}, [op, args || {}]);
const bytes = (a) => Uint8Array.from(a);
const textOf = (arr) => { const d = new Y.Doc(); if (arr.length) Y.applyUpdate(d, bytes(arr)); return d.getText('body').toString(); };
// the editor's side
function editor(o) {
  const doc = new Y.Doc(); doc.clientID = o.clientId;
  if (o.state && o.state.length) Y.applyUpdate(doc, bytes(o.state));
  let sv = Y.encodeStateVector(doc), n = 0;
  return { doc, change: (fn) => { fn(doc); const u = Y.encodeStateAsUpdate(doc, sv); sv = Y.encodeStateVector(doc); return Array.from(u); }, n: () => n++ };
}
const type = (s) => (d) => d.getText('body').insert(d.getText('body').length, s);

(async () => {
  fs.mkdirSync(WORK, { recursive: true });
  const profile = path.join(WORK, 'profile-wikipages-' + process.pid);
  const ctx = await chromium.launchPersistentContext(profile, Object.assign({ headless, viewport: { width: 1280, height: 860 },
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--host-resolver-rules=MAP localhost ~NOTFOUND, MAP 127.0.0.1 ~NOTFOUND'] }, headless ? { channel: 'chromium' } : {}));
  console.log('MODE ' + (headless ? 'HEADLESS (newer headless mode, channel chromium)' : 'headed') + '; browser ' + (ctx.browser() ? ctx.browser().version() : 'unknown') + '; package ' + path.basename(EXT));
  await sleep(2500);
  try {
    await ctx.addInitScript(() => {
      if (!(location.protocol === 'chrome-extension:' && /start\.html/.test(location.pathname))) return;
      // every sealed record of the wiki database, read through a separate connection, searched for the given words (keys, nonces, bytes)
      window.__scan = async (words) => {
        const db = await new Promise((res, rej) => { const q = indexedDB.open('keo-wiki'); q.onupgradeneeded = () => q.transaction.abort(); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); });
        try {
          const all = await new Promise((res, rej) => { const t = db.transaction('records'), st = t.objectStore('records'), ks = st.getAllKeys(), vs = st.getAll(); t.oncomplete = () => res({ keys: ks.result, vals: vs.result }); t.onerror = () => rej(t.error); });
          const enc = new TextEncoder(), found = [];
          all.keys.forEach((k, i) => { const hay = enc.encode(k + '\n' + all.vals[i].iv); const ct = all.vals[i].ct; words.forEach((w) => { const nb = enc.encode(w); const has = (h) => { outer: for (let a = 0; a + nb.length <= h.length; a++) { for (let b = 0; b < nb.length; b++) if (h[a + b] !== nb[b]) continue outer; return true; } return false; }; if (has(hay) || has(ct)) found.push(w); }); });
          return { records: all.keys.length, found: Array.from(new Set(found)) };
        } finally { db.close(); }
      };
    });
    const page = await ctx.newPage();
    page.on('pageerror', (e) => errors.push('PAGEERROR ' + e.message.slice(0, 200)));
    page.on('console', (m) => { if (m.type() === 'error' && !/compute-pressure|ERR_FILE_NOT_FOUND/.test(m.text())) errors.push('console: [' + phase + '] ' + m.text().slice(0, 200)); });
    const cdp = await ctx.newCDPSession(page);
    await cdp.send('WebAuthn.enable', { enableUI: false });
    await cdp.send('WebAuthn.addVirtualAuthenticator', { options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true, hasPrf: true } });

    await page.goto(`chrome-extension://${ID}/start.html`);
    let frame = await waitForWorld(page, 'gate');

    phase = '0 nobody signed in';
    check('the shell page has the page operations and the package lists them', await page.evaluate(() => !!window.keoWikiPages && typeof window.keoWiki.pages === 'function'));
    for (const [op, args] of [['wiki.list', {}], ['wiki.open', { name: 'notes' }], ['wiki.edit', { session: 'x', n: 0, update: [1, 2, 3] }], ['wiki.search', { query: 'x' }]]) {
      const r = await keoCall(frame, op, args);
      check(op + ' with nobody signed in is an error that says so', r.ok === false && /Sign in/.test(r.e), r);
    }
    const unknown = await keoCall(frame, 'wiki.sign', {});
    check('there is no operation that signs, and none that names who may write', unknown.ok === false && /unknown op/.test(unknown.e), unknown);

    phase = '1 identity and world';
    const did = await page.evaluate(() => window.keoIdentity.create({ label: 'Maya' }).then(() => window.keoIdentity.current()).then((s) => s.did));
    check('a signed-in identity was made', /^did:keo:/.test(did), did);
    await keoCall(frame, 'world.go', { kind: 'enter' }).catch(() => {});
    frame = await waitForWorld(page, 'homestar');

    phase = '2 list and open';
    let r = await keoCall(frame, 'wiki.list');
    check('a new identity holds no pages', r.ok && Array.isArray(r.r) && r.r.length === 0, r);
    r = await keoCall(frame, 'wiki.open', { name: 'notes' });
    const o1 = r.r;
    check('opening a new page answers a session, an id made of this identity and the name, and a client id', r.ok && o1.id === did + '/notes' && o1.isNew === true && o1.canEdit === true && o1.mine === true && Number.isSafeInteger(o1.clientId) && typeof o1.session === 'string', r);
    check('the page\'s state crosses the bridge as bytes', o1.stateType === '[object Uint8Array]' && textOf(o1.state) === '', o1.stateType);

    phase = '3 write';
    const e1 = editor(o1);
    r = await keoCall(frame, 'wiki.edit', { session: o1.session, n: e1.n(), update: e1.change(type('hello')) });
    check('the first edit is accepted by the shell', r.ok && r.r.status === 'accepted' && r.r.saved === true, r);
    const cid1 = r.r.cid;
    r = await keoCall(frame, 'wiki.edit', { session: o1.session, n: e1.n(), update: e1.change(type(' world')) });
    check('a second edit is accepted', r.ok && r.r.status === 'accepted', r);
    const t0 = Date.now(); let slow = 0;
    for (let i = 0; i < 20; i++) { const s = Date.now(); const rr = await keoCall(frame, 'wiki.edit', { session: o1.session, n: e1.n(), update: e1.change(type(' w' + i)) }); if (!(rr.ok && rr.r.status === 'accepted')) slow = -1000; slow = Math.max(slow, Date.now() - s); }
    check('twenty more edits are all accepted', slow >= 0, slow);
    note('twenty edits through the bridge: ' + (Date.now() - t0) + ' ms in all, the slowest ' + slow + ' ms (headless, one machine, one run, a virtual authenticator, a short page)');
    const typed = 'hello world' + Array.from({ length: 20 }, (_, i) => ' w' + i).join('');
    r = await keoCall(frame, 'wiki.edit', { session: o1.session, n: 22, update: [] });
    check('an empty change is an error, not a saved edit', r.ok === false && /nothing to save/.test(r.e), r);
    const buf = e1.change(type('!'));
    r = await keoCall(frame, 'wiki.edit', { session: o1.session, n: e1.n() + 0, updateAsBuffer: buf });
    check('a change handed over as a whole ArrayBuffer is taken', r.ok && r.r.saved === true, r);

    phase = '4 the list and reopening';
    r = await keoCall(frame, 'wiki.list');
    check('the page is listed, mine, with its versions', r.ok && r.r.length === 1 && r.r[0].name === 'notes' && r.r[0].mine === true && r.r[0].versions === 23 && r.r[0].pending === 0 && r.r[0].id === did + '/notes', r);
    r = await keoCall(frame, 'wiki.open', { name: 'notes' });
    const o2 = r.r;
    check('reopening gives the text that was saved, and a fresh client id', r.ok && textOf(o2.state) === typed + '!' && o2.isNew === false && o2.clientId !== o1.clientId && o2.session !== o1.session, [r.ok && textOf(o2.state), typed]);

    phase = '4b searching the text of the pages';
    // A page written the way the editor writes it (paragraphs in the `prosemirror` fragment): the shell reads its text and answers which
    // pages mention some words. What comes back over the bridge is rows with a short snippet, never a page's text.
    const oT = (await keoCall(frame, 'wiki.open', { name: 'trip' })).r, dT = new Y.Doc(); dT.clientID = oT.clientId;
    const svT = Y.encodeStateVector(dT), pT = new Y.XmlElement('paragraph'), xT = new Y.XmlText();
    xT.insert(0, 'We saw the lighthouse at dusk'); pT.insert(0, [xT]); dT.getXmlFragment('prosemirror').insert(0, [pT]);
    r = await keoCall(frame, 'wiki.edit', { session: oT.session, n: 0, update: Array.from(Y.encodeStateAsUpdate(dT, svT)) });
    check('(setup) a page written the way the editor writes it is accepted', r.ok && r.r.saved === true, r);
    r = await keoCall(frame, 'wiki.search', { query: 'lighthouse' });
    check('searching finds the page by a word of its text, with the piece of the text around it', r.ok && r.r.length === 1 && r.r[0].name === 'trip' && r.r[0].id === did + '/trip' && r.r[0].mine === true && r.r[0].where.join() === 'text' && /lighthouse at dusk/.test(r.r[0].snippet), r);
    check('a row has these fields and no text of the page', r.ok && JSON.stringify(Object.keys(r.r[0]).sort()) === JSON.stringify(['category', 'id', 'mine', 'name', 'owner', 'score', 'snippet', 'tags', 'where']), r.ok && Object.keys(r.r[0]));
    r = await keoCall(frame, 'wiki.search', { query: 'NOTES' });
    check('a page is found by its name, whatever the case', r.ok && r.r.length === 1 && r.r[0].name === 'notes' && r.r[0].where.join() === 'name', r);
    r = await keoCall(frame, 'wiki.search', { query: 'hello' });
    check('words that are only in the plain body of a page (what the editor does not write) are not found', r.ok && r.r.length === 0, r);
    r = await keoCall(frame, 'wiki.search', { query: '' });
    check('an empty query finds nothing and is not an error', r.ok && Array.isArray(r.r) && r.r.length === 0, r);
    const noQuery = await keoCall(frame, 'wiki.search', {}), numQuery = await keoCall(frame, 'wiki.search', { query: 42 });
    check('a query that is not text is an error with a sentence', noQuery.ok === false && /Say what to search for/.test(noQuery.e) && numQuery.ok === false && /Say what to search for/.test(numQuery.e), [noQuery, numQuery]);

    phase = '5 what is refused';
    const forged = new Y.Doc(); forged.clientID = o2.clientId + 1; const sv0 = Y.encodeStateVector(forged); forged.getText('body').insert(0, 'forged');
    r = await keoCall(frame, 'wiki.edit', { session: o2.session, n: 0, update: Array.from(Y.encodeStateAsUpdate(forged, sv0)) });
    check('an edit under a client id the shell did not hand out is refused, as an answer', r.ok && r.r.status === 'refused' && r.r.saved === false && typeof r.r.error === 'string', r);
    r = await keoCall(frame, 'wiki.edit', { session: 'no-such-session', n: 0, update: [1, 2, 3] });
    check('an unknown session is an error', r.ok === false && /not open for editing/.test(r.e), r);
    r = await keoCall(frame, 'wiki.edit', { session: o2.session, n: 0, update: [1, 2, 3] });
    check('bytes that are not a Yjs update are not saved', r.ok ? (r.r.saved === false) : true, r);
    r = await keoCall(frame, 'wiki.open', { name: '' });
    check('a name that cannot be a page is an error with a sentence', r.ok === false && /named by its owner/.test(r.e), r);
    r = await keoCall(frame, 'wiki.open', { id: 'did:keo:nobody/notes' });
    check('an id that is not a page is an error', r.ok === false && /not the name of a page/.test(r.e), r);
    const other = 'did:keo:' + 'a'.repeat(52) + ':' + 'B'.repeat(43);
    r = await keoCall(frame, 'wiki.open', { id: other + '/theirs' });
    check('a page of someone else opens, read-only', r.ok && r.r.canEdit === false && r.r.mine === false && r.r.isNew === true, r);
    r = await keoCall(frame, 'wiki.list');
    check('and was not made by opening it (the two pages that were saved are all it lists)', r.ok && r.r.length === 2, r);
    r = await keoCall(frame, 'wiki.close', { session: o2.session });
    check('closing a session answers true', r.ok && r.r === true, r);
    r = await keoCall(frame, 'wiki.edit', { session: o2.session, n: 1, update: [1] });
    check('a closed session cannot save', r.ok === false && /not open for editing/.test(r.e), r);

    phase = '6 on disk';
    const scan = await page.evaluate(() => window.__scan(['notes', 'hello world', 'Maya', 'forged', 'lighthouse', 'trip']));
    check('the records are on disk and nothing readable is in them (name, text, label)', scan.records > 20 && scan.found.length === 0, scan);
    // the control: the identity's DID IS readable in every key (keo-wiki.js says so), so a scan that cannot find it proves nothing
    const ctl = await page.evaluate((d) => window.__scan([d]), did);
    check('(control) the same scan finds the one thing that is meant to be readable, the identity in the keys', ctl.found.length === 1 && ctl.found[0] === did, ctl);

    phase = '7 reload';
    // A reload ends this page's memory (the open sessions) and keeps the session key and the records.
    await page.reload();
    // whether a reload keeps the session or shows the gate again is the shell's business, not this test's: go on from whichever it is
    frame = await waitForAnyWorld(page, ['gate', 'homestar']);
    const kindNow = await frame.evaluate(() => window.keo.init.startup.kind);
    note('after the reload the world started as ' + kindNow);
    if (kindNow === 'gate') { await page.evaluate((d) => window.keoIdentity.signIn({ did: d }), did); await keoCall(frame, 'world.go', { kind: 'enter' }).catch(() => {}); frame = await waitForWorld(page, 'homestar'); }
    r = await keoCall(frame, 'wiki.edit', { session: o1.session, n: 99, update: [1] });
    check('after a reload an old session is not valid', r.ok === false && /not open for editing/.test(r.e), r);
    r = await keoCall(frame, 'wiki.list');
    check('the page is still listed after the reload', r.ok && r.r.length === 2 && r.r.some((p) => p.name === 'notes' && p.versions === 23), r);
    r = await keoCall(frame, 'wiki.search', { query: 'lighthouse dusk' });
    check('and the text is still searchable after the reload (the kept text is on the disk)', r.ok && r.r.length === 1 && r.r[0].name === 'trip', r);
    r = await keoCall(frame, 'wiki.open', { name: 'notes' });
    const o3 = r.r;
    check('and opens with its text, under yet another client id', r.ok && textOf(o3.state) === typed + '!' && o3.clientId !== o2.clientId && o3.clientId !== o1.clientId, r.ok && textOf(o3.state));
    const e3 = editor(o3);
    r = await keoCall(frame, 'wiki.edit', { session: o3.session, n: e3.n(), update: e3.change(type(' after the reload')) });
    check('an edit after the reload is accepted (a new client id starts its own clock)', r.ok && r.r.status === 'accepted', r);
    r = await keoCall(frame, 'wiki.open', { name: 'notes' });
    check('and the page holds both', r.ok && textOf(r.r.state) === typed + '! after the reload', r.ok && textOf(r.r.state));

    phase = '8 sign out';
    const stale = r.r.session;
    await page.evaluate(() => window.keoIdentity.signOut());
    check('after signing out the shell gives no page operations', await page.evaluate(() => { try { window.keoWiki.pages(); return false; } catch (e) { return /Sign in/.test(e.message); } }));
    await page.evaluate((d) => window.keoIdentity.signIn({ did: d }), did);
    const after = await page.evaluate((s) => window.keoWiki.pages().edit({ session: s, n: 0, update: new Uint8Array([1]) }).then(() => 'taken', (e) => e.message), stale);
    check('and after signing in again a session from before is not valid', /not open for editing/.test(after), after);
    const again = await page.evaluate(() => window.keoWiki.pages().list().then((l) => l.map((p) => p.name + ':' + p.versions)));
    check('but the pages are there', JSON.stringify(again) === JSON.stringify(['notes:24', 'trip:1']), again);

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
