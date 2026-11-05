// What the toolbar popup learns from the keo tab (shell/keo-status.js, shell/popup.js): who is signed in, the session's end, and for each
// friend whether a connection is up and how the last one ended.
// Usage: node keo-popup-status-test.js <repo root> <extension folder> <work dir>
// TWO headed browsers (two profiles = two devices on one machine), each with the package loaded, `localhost` unresolvable and its own
// virtual authenticator, connected through the world's bridge and made friends through the shell's dialog (tests/friends-helper.js). Each
// device also gets a popup page, opened in a TAB at its own address (a test cannot click the toolbar icon, so this is not the browser's own
// popup surface). Covered: the friends list is empty until a friend is added; a connected friend; a friend's name is drawn as text; the
// connection ending from the other side reads "Connection lost" with the reason, ending it here reads "Not connected"; connecting again
// clears that; what the shell answers holds only the fields it should; signing out empties it, shows nobody's name and drops the record of
// how connections ended.
// NOT covered: the state "connected, waiting for them to add you", a connection that ends for a reason other than the other side leaving,
// two real machines, the browser's real popup surface.
const fs = require('fs');
const path = require('path');
const { REPO, EXT, WORK } = require('./args.js')();
const { chromium } = require(path.join(REPO, 'node_modules', 'playwright-core'));
const { befriend } = require('./friends-helper.js');
const ID = 'cgjphijackijgcjkfdfieihkbfooigjp';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0, passed = 0;
function check(name, ok, detail) { if (ok) passed++; else failed++; console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail !== undefined && !ok ? '  -> ' + JSON.stringify(detail).slice(0, 900) : '')); }
const errors = [], ctxs = [];

const worldFrame = (page) => page.frames().find((f) => /world\.html$/.test(f.url()));
async function waitForWorld(page, kind) {
  for (let i = 0; i < 200; i++) {
    const f = worldFrame(page);
    if (f) { try { if (await f.evaluate((k) => !!(window.$world && window.$world.submorphs && window.keo && window.keo.init && window.keo.init.startup && window.keo.init.startup.kind === k), kind)) { await sleep(2500); return f; } } catch (e) {} }
    await sleep(300);
  }
  throw new Error('the world did not start as ' + kind);
}
async function waitFor(fn, ms) { const t0 = Date.now(); while (Date.now() - t0 < (ms || 20000)) { const v = await fn().catch(() => null); if (v) return v; await sleep(200); } return null; }
const call = (frame, op, args) => frame.evaluate(([o, a]) => window.keo.call(o, a, 60000).then((r) => ({ ok: true, r }), (e) => ({ ok: false, e: e.message })), [op, args || {}]);
const p2pEvents = (P) => P.frame.evaluate(() => window.__p2p.slice());
const findP2p = (P, type, pred, ms) => waitFor(async () => (await p2pEvents(P)).find((e) => e.type === type && (!pred || pred(e))), ms);

async function device(label, name) {
  const ctx = await chromium.launchPersistentContext(path.join(WORK, 'profile-ps-' + name), {
    headless: false, viewport: { width: 1000, height: 700 },
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--host-resolver-rules=MAP localhost ~NOTFOUND, MAP 127.0.0.1 ~NOTFOUND'] });
  ctxs.push(ctx);
  await sleep(2000);
  const page = await ctx.newPage();
  page.on('dialog', (d) => d.accept().catch(() => {}));
  page.on('pageerror', (e) => errors.push(name + ' PAGEERROR ' + e.message.slice(0, 200)));
  // Only errors from the shell's and the popup's own files count: the kernel's home page logs blocked third-party scripts and a policy line of its own, and asks for a badge picture the package does not hold (Media/badges/by-sa.svg).
  page.on('console', (m) => { if (m.type() === 'error' && new RegExp('^chrome-extension://' + ID + '/(?!core/|generated/|Media/)').test(m.location().url || '')) errors.push(name + ' console: ' + m.text().slice(0, 200) + ' @ ' + (m.location().url || '').slice(0, 160)); });
  const cdp = await ctx.newCDPSession(page);
  await cdp.send('WebAuthn.enable', { enableUI: false });
  await cdp.send('WebAuthn.addVirtualAuthenticator', { options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true, hasPrf: true } });
  await page.goto(`chrome-extension://${ID}/start.html`);
  let frame = await waitForWorld(page, 'gate');
  const created = await page.evaluate((l) => window.keoIdentity.create({ label: l }), label);
  await frame.evaluate(() => window.keo.call('world.go', { kind: 'enter' }, 60000)).catch(() => {});
  frame = await waitForWorld(page, 'homestar');
  await frame.evaluate(() => { window.__p2p = []; window.keo.on('p2p', (e) => window.__p2p.push(e)); window.__fr = []; window.keo.on('friend', (e) => window.__fr.push(e)); });
  const pop = await ctx.newPage();
  pop.on('pageerror', (e) => errors.push(name + ' popup PAGEERROR ' + e.message.slice(0, 200)));
  pop.on('console', (m) => { if (m.type() === 'error') errors.push(name + ' popup console: ' + m.text().slice(0, 200)); });
  await pop.goto(`chrome-extension://${ID}/popup.html`);
  return { label, name, ctx, page, frame, pop, did: created.did };
}
async function connect(A, B) {
  const inv = await call(A.frame, 'p2p.offer', { name: A.label });
  const ans = await call(B.frame, 'p2p.answer', { code: inv.r.code, name: B.label });
  await call(A.frame, 'p2p.finish', { id: inv.r.id, code: ans.r.code });
  const ra = await findP2p(A, 'state', (e) => e.id === inv.r.id && e.state === 'ready'), rb = await findP2p(B, 'state', (e) => e.id === ans.r.id && e.state === 'ready');
  if (!ra || !rb) throw new Error('the devices did not connect');
  return { a: inv.r.id, b: ans.r.id };
}
// The popup as a person sees it: the pill, the rows of friends, the count and the foot.
const seen = (P) => P.pop.evaluate(() => ({
  pill: (document.querySelector('.pill') || {}).textContent, count: (document.querySelector('.sec-h span') || {}).textContent,
  empty: (document.querySelector('.empty') || {}).textContent, foot: (document.querySelector('.foot') || {}).textContent, text: document.body.innerText,
  me: (document.querySelector('.me .who b') || {}).textContent,
  rows: [...document.querySelectorAll('.dev')].map((r) => ({ name: r.querySelector('.l1 span').textContent, dot: r.querySelector('.dot').className, word: r.querySelector('.l2 b').textContent, tone: r.querySelector('.l2 b').className, l2: r.querySelector('.l2').textContent, why: (r.querySelector('.why') || {}).textContent || null, markup: r.querySelector('.l1 span').children.length }))
}));
const until = (P, pred, ms) => waitFor(async () => { const s = await seen(P); return pred(s) ? s : null; }, ms || 15000);

(async () => {
  fs.mkdirSync(WORK, { recursive: true });
  const hard = setTimeout(async () => { console.log('HARD TIMEOUT'); for (const c of ctxs) await c.close().catch(() => {}); process.exit(3); }, 420000);
  // Jun's label has markup in it: it reaches Maya's popup as the friend's name, which must be drawn as text.
  const A = await device('Maya', 'a'), B = await device('<i>Jun</i>', 'b');
  try {
    // ---- 1. signed in, no friends
    let s = await until(A, (x) => x.pill === 'Signed in');
    check('signed in: the popup says so and names who', !!s && s.me === 'Maya', s);
    check('signed in: the foot says when the session ends (twelve hours from sign-in)', !!s && /^Session ends in (12 h|11 h \d+ min)$/.test(s.foot), s && s.foot);
    check('signed in: no friends yet, and the popup says how to add one', !!s && /^No friends yet/.test(s.empty || '') && s.rows.length === 0, s);

    // ---- 2. a device that is connected but not a friend is not listed
    let k = await connect(A, B);
    await sleep(2500);
    s = await seen(A);
    check('connected but not a friend: still no row (the list is the people the person added)', s.rows.length === 0, s);

    // ---- 3. friends
    await befriend(A, B, k);
    s = await until(A, (x) => x.rows.length === 1 && x.rows[0].word === 'Connected');
    check('a connected friend: a row with a green dot and the word Connected, and the count', !!s && s.rows[0].tone === 'good' && /good/.test(s.rows[0].dot) && s.count === '1 of 1 connected', s);
    check('a connected friend: the row says for how long', !!s && /· (under a minute|\d+ min)$/.test(s.rows[0].l2), s && s.rows[0]);
    check('a friend\'s name is drawn as text, never as markup', !!s && s.rows[0].name === '<i>Jun</i>' && s.rows[0].markup === 0, s && s.rows[0]);
    await A.pop.screenshot({ path: path.join(WORK, 'status-connected.png') });
    const bs = await until(B, (x) => x.rows.length === 1 && x.rows[0].word === 'Connected');
    check('the other device sees Maya as a connected friend too', !!bs && bs.rows[0].name === 'Maya', bs);

    // ---- 4. what the shell answers
    const raw = await A.page.evaluate(() => window.keoStatus.build());
    const keys = (o) => Object.keys(o).sort().join();
    check('the shell\'s answer holds only the expected fields', keys(raw) === 'exp,friends,me,signedIn,v' && keys(raw.me) === 'did,label' && keys(raw.friends[0]) === 'did,ended,name,since,state', { raw });
    check('the shell\'s answer has no key, code, address or message text', !/sdp|candidate|ice-ufrag|secret|private|\"d\":|BEGIN/i.test(JSON.stringify(raw)), raw);

    // ---- 5. the other side ends the connection: that is a lost connection here, and a quiet one there
    await call(B.frame, 'p2p.close', { id: k.b });
    s = await until(A, (x) => x.rows.length === 1 && x.rows[0].word === 'Connection lost');
    check('the other side left: Connection lost, a red dot, and the reason', !!s && s.rows[0].tone === 'bad' && /bad/.test(s.rows[0].dot) && /closed the connection/.test(s.rows[0].why || '') && /ago$/.test(s.rows[0].l2.replace(s.rows[0].why || '', '')), s && s.rows[0]);
    check('and the count drops', !!s && s.count === '0 of 1 connected', s && s.count);
    await A.pop.screenshot({ path: path.join(WORK, 'status-lost.png') });
    const bq = await until(B, (x) => x.rows.length === 1 && x.rows[0].word === 'Not connected');
    check('ending it here is not a loss: the closing side reads Not connected, with no reason', !!bq && bq.rows[0].why === null && !/bad/.test(bq.rows[0].dot), bq && bq.rows[0]);

    // ---- 6. connecting again clears the loss
    k = await connect(A, B);
    await befriend(A, B, k);
    s = await until(A, (x) => x.rows.length === 1 && x.rows[0].word === 'Connected');
    check('connected again: the loss is gone from the row', !!s && s.rows[0].why === null && s.count === '1 of 1 connected', s && s.rows[0]);

    // ---- 7. signing out: nothing about anyone, and the record of endings goes
    await call(B.frame, 'p2p.close', { id: k.b });
    await until(A, (x) => x.rows.length === 1 && x.rows[0].word === 'Connection lost');
    await call(A.frame, 'session.signOut');
    await A.page.waitForLoadState('load').catch(() => {});
    s = await until(A, (x) => x.pill === 'Open' && /Nobody is signed in yet/.test(x.text));
    check('signed out (the keo tab still open): the popup says nobody is signed in and shows no name', !!s && s.rows.length === 0 && !/Maya|Jun/.test(s.text), s);
    const after = await A.page.evaluate(() => window.keoP2p.status());
    check('signing out dropped the record of how connections ended', after.connections.length === 0 && Object.keys(after.ended).length === 0, after);
    const rawOut = await A.page.evaluate(() => window.keoStatus.build());
    check('signed out: the shell answers only that nobody is signed in', JSON.stringify(rawOut) === '{"v":1,"signedIn":false}', rawOut);

    check('no page error or console error on either device', errors.length === 0, errors);
  } catch (e) {
    check('test ran to the end', false, String(e && e.stack || e));
  } finally {
    clearTimeout(hard);
    for (const c of ctxs) await c.close().catch(() => {});
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
