// Cards between two devices: a friend's card (where their device can be asked to connect) travels over the proven channel, is checked as
// coming from the DID that channel proved, and is kept in the encrypted friend book (shell/keo-cards.js, keo-hello.js, keo-contacts.js);
// our own card can also be written as text and read back.
// Usage: node keo-cardsync-test.js <repo root> <extension folder> <work dir>
// Two headed browsers (two profiles = two devices on one machine), each with the package loaded, `localhost` unresolvable and its own
// virtual authenticator; they become friends through the dialog (friends-helper.js). Hostile messages are imitated by sending raw ones
// from one shell page.
// NOT covered: two real machines, a real authenticator, a card made by a second device of one identity, a session that expires while the
// connection is up, any screen that shows a card (none exists), a QR (the text is longer than a small QR holds).
const fs = require('fs');
const path = require('path');
const { REPO, EXT, WORK } = require('./args.js')();
const { chromium } = require(path.join(REPO, 'node_modules', 'playwright-core'));
const { befriend } = require('./friends-helper.js');
const ID = 'keoapnoighmdpncpbfffhcdgdjgjmpdn';
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
async function waitFor(fn, ms) { const t0 = Date.now(); while (Date.now() - t0 < (ms || 20000)) { const v = await fn().catch(() => null); if (v) return v; await sleep(150); } return null; }
const call = (frame, op, args) => frame.evaluate(([o, a]) => window.keo.call(o, a, 60000).then((r) => ({ ok: true, r }), (e) => ({ ok: false, e: e.message })), [op, args || {}]);
const p2pEvents = (P) => P.frame.evaluate(() => window.__p2p.slice());
const findP2p = (P, type, pred, ms) => waitFor(async () => (await p2pEvents(P)).find((e) => e.type === type && (!pred || pred(e))), ms);
const listed = (P, id) => P.frame.evaluate((i) => window.keo.call('p2p.list', {}, 20000).then((l) => l.filter((c) => c.id === i)[0] || null), id);
const sendRaw = (P, id, m) => P.page.evaluate(([i, x]) => window.keoP2p.handle(i).send(x), [id, m]);
const cardsOf = (P, did) => P.page.evaluate((d) => window.keoContacts.cards(d), did);
const diag = (P) => P.page.evaluate(() => window.keoCards.diag());

async function device(label, name) {
  const ctx = await chromium.launchPersistentContext(path.join(WORK, 'profile-cs-' + name), {
    headless: false, viewport: { width: 1000, height: 700 },
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--host-resolver-rules=MAP localhost ~NOTFOUND, MAP 127.0.0.1 ~NOTFOUND'] });
  ctxs.push(ctx);
  await sleep(2000);
  const page = await ctx.newPage();
  page.on('dialog', (d) => d.accept().catch(() => {}));
  page.on('pageerror', (e) => errors.push(name + ' PAGEERROR ' + e.message.slice(0, 200)));
  // The two extra messages are the home world's own (a video player script its policy blocks, a geolocation call it is not allowed): seen
  // on every start of that world, nothing to do with cards.
  page.on('console', (m) => { if (m.type() === 'error' && !/compute-pressure|ERR_FILE_NOT_FOUND|youtube\.com\/iframe_api|Geolocation access has been blocked/.test(m.text())) errors.push(name + ' console: ' + m.text().slice(0, 200)); });
  const cdp = await ctx.newCDPSession(page);
  await cdp.send('WebAuthn.enable', { enableUI: false });
  await cdp.send('WebAuthn.addVirtualAuthenticator', { options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true, hasPrf: true } });
  await page.goto(`chrome-extension://${ID}/start.html`);
  let frame = await waitForWorld(page, 'gate');
  const created = await page.evaluate((l) => window.keoIdentity.create({ label: l }), label);
  await frame.evaluate(() => window.keo.call('world.go', { kind: 'enter' }, 60000)).catch(() => {});
  frame = await waitForWorld(page, 'homestar');
  await frame.evaluate(() => { window.__p2p = []; window.keo.on('p2p', (e) => window.__p2p.push(e)); });
  return { label, name, ctx, page, frame, did: created.did };
}
async function connect(A, B) {
  const inv = await call(A.frame, 'p2p.offer', { name: A.label });
  const ans = await call(B.frame, 'p2p.answer', { code: inv.r.code, name: B.label });
  await call(A.frame, 'p2p.finish', { id: inv.r.id, code: ans.r.code });
  const ra = await findP2p(A, 'state', (e) => e.id === inv.r.id && e.state === 'ready'), rb = await findP2p(B, 'state', (e) => e.id === ans.r.id && e.state === 'ready');
  if (!ra || !rb) throw new Error('the devices did not connect');
  return { a: inv.r.id, b: ans.r.id };
}
// A card signed by P's own device key with the version and helpers chosen here (what the shell would sign, but with a version we pick).
const mkCard = (P, helpers, seq, edit) => P.page.evaluate(async ([helpers, seq, edit]) => {
  const proof = await window.keoIdentity.deviceProof();
  const h = window.keoHello.cardBuild(proof, { helpers, seq });
  const sig = await window.keoIdentity.signWithDevice(window.keoHello.signedBytes(h), proof.did);
  if (edit === 'helper') h.helpers[0].host = '203.0.113.66';
  if (edit === 'did') h.did = 'did:keo:somebody-else';
  return { hello: h, sig };
}, [helpers, seq, edit || null]);

(async () => {
  fs.mkdirSync(WORK, { recursive: true });
  const hard = setTimeout(async () => { console.log('HARD TIMEOUT'); for (const c of ctxs) await c.close().catch(() => {}); process.exit(3); }, 420000);
  const A = await device('Maya', 'a'), B = await device('Jun', 'b');
  try {
    const H1 = [{ kind: 'ws', host: '203.0.113.9', port: 47431 }], H2 = [{ kind: 'http', host: 'home.example.org', port: 8443 }];

    // ---- 1. before they are friends: nothing is sent, and a card from a stranger is a violation
    let k = await connect(A, B);
    check('setHelpers is refused for a loopback address', await A.page.evaluate(() => window.keoCards.setHelpers([{ kind: 'ws', host: '127.0.0.1', port: 1 }]).then(() => 'accepted', (e) => e.message)).then((r) => /not valid/.test(r)) === true);
    // (setHelpers throws synchronously in the page; evaluate turns that into a rejection of the whole call)
    check('with no helpers set, the page knows of none', (await diag(A)).helpers === null);
    await A.page.evaluate((h) => window.keoCards.setHelpers(h), H1);
    check('helpers are set on the first device', JSON.stringify((await diag(A)).helpers) === JSON.stringify(H1));
    await sleep(2500);
    check('connected but not friends: the other device is told nothing', (await cardsOf(B, A.did)).length === 0 && Object.keys((await diag(B)).notes).length === 0);
    await sendRaw(A, k.a, { t: 'card.set', hello: {}, sig: 'x' });
    const closedB = await waitFor(async () => { const c = await listed(B, k.b); return !c || c.state === 'closed' ? true : null; }, 8000);
    check('a card from a device that is not a friend ends the connection (a friend\'s message only)', closedB === true);

    // ---- 2. becoming friends sends the card
    k = await connect(A, B);
    await befriend(A, B, k);
    const got = await waitFor(async () => { const c = await cardsOf(B, A.did); return c.length ? c : null; }, 15000);
    check('the card reached the friend as soon as they became friends: the helper and a version number', !!got && got.length === 1 && JSON.stringify(got[0].helpers) === JSON.stringify(H1) && got[0].seq > 1700000000, got);
    const seq1 = got && got[0].seq;
    check('the receiver knows which device it came from (the device id of the sender)', !!got && typeof got[0].deviceId === 'string' && got[0].deviceId.length > 10, got);
    check('the receiver noted that it kept a card', /kept a card/.test(Object.values((await diag(B)).notes).join()), await diag(B));

    // ---- 3. a changed list is sent again
    await A.page.evaluate((h) => window.keoCards.setHelpers(h), H2);
    const got2 = await waitFor(async () => { const c = await cardsOf(B, A.did); return c.length && c[0].helpers[0].host === 'home.example.org' ? c : null; }, 15000);
    check('new helpers replace the old ones on the friend\'s side, with a higher version', !!got2 && got2.length === 1 && got2[0].seq > seq1, got2);
    const seq2 = got2 && got2[0].seq;
    await A.page.evaluate(() => window.keoCards.setHelpers([]));
    const got3 = await waitFor(async () => { const c = await cardsOf(B, A.did); return c.length && c[0].helpers.length === 0 ? c : null; }, 15000);
    check('setHelpers([]) tells the friend "not reachable there": a card with no helpers replaces the list', !!got3 && got3[0].seq > seq2, got3);
    await A.page.evaluate((h) => window.keoCards.setHelpers(h), H2);
    await waitFor(async () => { const c = await cardsOf(B, A.did); return c.length && c[0].helpers.length === 1 ? c : null; }, 15000);

    // ---- 4. hostile or stale cards are dropped and the connection stays up
    const cur = (await cardsOf(B, A.did))[0];
    const stateB = async () => (await listed(B, k.b)).state;
    await sendRaw(A, k.a, { t: 'card.set', ...(await mkCard(A, H1, 5)) });
    await sleep(800);
    check('an older card (lower version) cannot roll the address back', (await cardsOf(B, A.did))[0].seq === cur.seq && (await cardsOf(B, A.did))[0].helpers[0].host === 'home.example.org');
    const edited = await mkCard(A, H1, cur.seq + 1000, 'helper');
    await sendRaw(A, k.a, { t: 'card.set', ...edited });
    await sleep(800);
    check('a card whose helper was changed after signing is dropped, and says why', (await cardsOf(B, A.did))[0].seq === cur.seq && /signature/.test(Object.values((await diag(B)).notes).join()), await diag(B));
    await sendRaw(A, k.a, { t: 'card.set', ...(await mkCard(A, H1, cur.seq + 1000, 'did')) });
    await sleep(800);
    check('a card that names another identity than the one the connection proved is dropped', (await cardsOf(B, A.did))[0].seq === cur.seq && /someone else|signature/.test(Object.values((await diag(B)).notes).join()), await diag(B));
    check('and the connection stays up after bad cards', (await stateB()) === 'ready');
    // (one more than the stored version, not far ahead: a version far ahead of the clock would hide every later real card)
    await sendRaw(A, k.a, { t: 'card.set', ...(await mkCard(A, H1, cur.seq + 1)) });
    const newer = await waitFor(async () => { const c = await cardsOf(B, A.did); return c[0].seq === cur.seq + 1 ? c : null; }, 8000);
    check('a good newer card still works afterwards', !!newer && newer[0].helpers[0].host === '203.0.113.9', newer);
    let closedAfterFlood = false;
    for (let i = 0; i < 40 && !closedAfterFlood; i++) { try { await sendRaw(A, k.a, { t: 'card.set', ...(await mkCard(A, H1, 10 + i)) }); } catch (e) { closedAfterFlood = true; } await sleep(100); }
    closedAfterFlood = closedAfterFlood || !!(await waitFor(async () => { const c = await listed(B, k.b); return !c || c.state === 'closed' ? true : null; }, 8000));
    check('a friend that sends card after card is cut off (a limit per connection)', closedAfterFlood);

    // ---- 5. what the world and the disk can see
    k = await connect(A, B);
    await befriend(A, B, k);
    await waitFor(async () => (await cardsOf(B, A.did)).length ? true : null, 15000);
    const worldList = await B.frame.evaluate(() => window.keo.call('friend.list', {}, 20000).then((r) => JSON.stringify(r), (e) => 'ERR ' + e.message));
    check('the friend list the world can ask for holds the name and no address or card', /Maya/.test(worldList) && !/203\.0\.113|home\.example|helpers|devices/.test(worldList), worldList);
    const opNames = await B.frame.evaluate(() => Object.keys(window.keo).concat(Object.keys(window.keo.ops || {})).join());
    check('the world has no way to reach cards (no bridge op)', await B.frame.evaluate(() => window.keo.call('card.set', {}, 3000).then(() => 'ok', (e) => e.message)).then((r) => r !== 'ok'), opNames);

    // ---- 6. the other direction, and a card as text
    await B.page.evaluate((h) => window.keoCards.setHelpers(h), H1);
    const back = await waitFor(async () => { const c = await cardsOf(A, B.did); return c.length ? c : null; }, 15000);
    check('the second device\'s card reaches the first as well', !!back && back[0].helpers[0].host === '203.0.113.9', back);
    const text = await A.page.evaluate(() => window.keoCards.exportText());
    check('our card exports as one line of text starting with its prefix', /^keocard1\.[A-Za-z0-9_-]+$/.test(text) && text.length > 1000, text.length);
    const before = (await cardsOf(B, A.did))[0].seq;
    const imp = await B.page.evaluate((t) => window.keoCards.importText('link: https://example.org/#' + t + ' bye').then((r) => r, (e) => ({ error: e.message })), text);
    check('the text read back by the friend is checked and kept: from the friend, a newer version', imp.added === true && imp.changed === true && imp.did === A.did && (await cardsOf(B, A.did))[0].seq > before, imp);
    const again = await B.page.evaluate((t) => window.keoCards.importText(t).then((r) => r, (e) => ({ error: e.message })), text);
    check('reading the same text again changes nothing', again.added === true && again.changed === false, again);
    const bad = await B.page.evaluate((t) => window.keoCards.importText(t.slice(0, -30) + 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAA').then(() => 'accepted', (e) => e.message), text);
    check('text that was altered is refused with a sentence', bad !== 'accepted' && /valid|signature|keo card/.test(bad), bad);
    const junk = await B.page.evaluate(() => window.keoCards.importText('hello').then(() => 'accepted', (e) => e.message));
    check('text with no card in it is refused with a sentence', /not a keo card/.test(junk), junk);

    // ---- 7. a card from someone who is not in the friend book is not kept
    await B.page.evaluate((d) => window.keoContacts.remove(d), A.did);
    const stranger = await B.page.evaluate((t) => window.keoCards.importText(t).then((r) => r, (e) => ({ error: e.message })), text);
    check('a genuine card from someone not in the friend book is recognised but nothing is kept', stranger.added === false && stranger.changed === false && stranger.did === A.did, stranger);
    check('and the friend book still holds no card for them', (await cardsOf(B, A.did)).length === 0);

    check('no page errors were logged', errors.length === 0, errors.slice(0, 5));
  } finally { clearTimeout(hard); for (const c of ctxs) await c.close().catch(() => {}); }
  console.log(passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})().catch(async (e) => { console.error('FATAL', e); for (const c of ctxs) await c.close().catch(() => {}); process.exit(2); });
