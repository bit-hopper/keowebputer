// The introduction screens (shell/keo-intro.js, keo-qr.js): one device SHOWS its introduction as a QR code and as text, another READS it,
// the person types the eight words the first reads out, clicks Add, and the friend is added without any connection.
// Usage: node keo-intro-test.js <repo root> <extension folder> <work dir>
// Two headed browsers (two profiles = two devices on one machine), each with the package loaded, `localhost` unresolvable and its own
// virtual authenticator. The screens are asked for through the world's bridge (as the Friends window will) and answered the way a person
// does: real typing and real clicks. The QR drawn on the canvas is read back with a separate decoder (jsQR, dev dependency).
// NOT covered: a phone scanning the screen, a real camera, two real machines, a real authenticator, how it looks (set SHOT_DIR and look),
// the kernel's Friends window button (not built yet), a session that expires while the screen is up.
const fs = require('fs');
const path = require('path');
const { REPO, EXT, WORK } = require('./args.js')();
const { chromium } = require(path.join(REPO, 'node_modules', 'playwright-core'));
const jsQR = require(path.join(REPO, 'node_modules', 'jsqr'));
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
const shot = (page, n) => process.env.SHOT_DIR ? page.screenshot({ path: path.join(process.env.SHOT_DIR, n + '.png') }) : null;

async function device(label, name) {
  const ctx = await chromium.launchPersistentContext(path.join(WORK, 'profile-in-' + name), {
    headless: false, viewport: { width: 1000, height: 800 },
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--host-resolver-rules=MAP localhost ~NOTFOUND, MAP 127.0.0.1 ~NOTFOUND'] });
  ctxs.push(ctx);
  await sleep(2000);
  const page = await ctx.newPage();
  page.on('dialog', (d) => d.accept().catch(() => {}));
  page.on('pageerror', (e) => errors.push(name + ' PAGEERROR ' + e.message.slice(0, 200)));
  // The two extra messages are the home world's own (a video player script its policy blocks, a geolocation call it is not allowed).
  page.on('console', (m) => { if (m.type() === 'error' && !/compute-pressure|ERR_FILE_NOT_FOUND|youtube\.com\/iframe_api|Geolocation access has been blocked/.test(m.text())) errors.push(name + ' console: ' + m.text().slice(0, 200)); });
  const cdp = await ctx.newCDPSession(page);
  await cdp.send('WebAuthn.enable', { enableUI: false });
  await cdp.send('WebAuthn.addVirtualAuthenticator', { options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true, hasPrf: true } });
  await page.goto(`chrome-extension://${ID}/start.html`);
  let frame = await waitForWorld(page, 'gate');
  const created = await page.evaluate((l) => window.keoIdentity.create({ label: l }), label);
  await frame.evaluate(() => window.keo.call('world.go', { kind: 'enter' }, 60000)).catch(() => {});
  frame = await waitForWorld(page, 'homestar');
  await frame.evaluate(() => { window.__fr = []; window.keo.on('friend', (e) => window.__fr.push(e)); });
  return { label, name, ctx, page, frame, did: created.did };
}
// What the screen shows, as a person sees it.
const screen = (P) => P.page.evaluate(() => {
  const r = document.getElementById('keo-intro');
  if (!r) return null;
  const q = (s) => r.querySelector(s), vis = (e) => !!e && !e.hidden && e.offsetParent !== null;
  const c = q('canvas');
  return { hidden: r.hidden, tabOn: (r.querySelector('.tab.on') || {}).textContent || null, showUp: vis(q('.view.show')), readUp: vis(q('.view.read')),
    name: q('.show .who-name').textContent, did: q('.show .who-did').textContent, didFull: q('.show .who-did').title, words: q('.show .words').textContent, reach: q('.show .reach').textContent,
    raw: q('.show textarea.raw').value, showHint: q('.show .hint').textContent, canvasW: c.width,
    pasteHint: q('.read > .hint').textContent, pasteHintClass: q('.read > .hint').className, resultUp: vis(q('.read .result')), rName: q('.read .who-name').textContent, rDid: q('.read .who-did').textContent,
    rDidFull: q('.read .who-did').title, rReach: q('.read .reach').textContent, rImg: q('.read .who-img').src.slice(0, 22), checkHint: q('.read .result .hint').textContent, checkClass: q('.read .result .hint').className,
    yesHidden: q('button.yes').hidden, yesDisabled: q('button.yes').disabled, theirsDisabled: q('input.theirs').disabled, text: r.textContent };
});
const screenOpen = (P) => waitFor(async () => { const d = await screen(P); return d && !d.hidden ? d : null; }, 10000);
const screenGone = (P) => waitFor(async () => { const d = await screen(P); return !d || d.hidden ? true : null; }, 8000);
// The drawn code, read back with a separate decoder.
async function scanCanvas(P) {
  const img = await P.page.evaluate(() => { const c = document.querySelector('#keo-intro canvas'); const d = c.getContext('2d').getImageData(0, 0, c.width, c.height); return { w: c.width, h: c.height, data: Array.from(d.data) }; });
  const r = jsQR(Uint8ClampedArray.from(img.data), img.w, img.h);
  return r ? r.data : null;
}
const isAdded = (P, did) => P.page.evaluate((d) => window.keoContacts.ensure().then(() => window.keoContacts.isAdded(d)), did);

(async () => {
  fs.mkdirSync(WORK, { recursive: true });
  const hard = setTimeout(async () => { console.log('HARD TIMEOUT'); for (const c of ctxs) await c.close().catch(() => {}); process.exit(3); }, 420000);
  const A = await device('Maya', 'a'), B = await device('Jun', 'b');
  try {
    const H = [{ kind: 'ws', host: '203.0.113.9', port: 47431 }, { kind: 'http', host: 'home.example.org', port: 8443 }];
    await A.page.evaluate((h) => window.keoCards.setHelpers(h), H);

    // ---- 1. showing ours
    check('nothing is on screen before it is asked for', !(await screen(A)) || (await screen(A)).hidden);
    const asked = await call(A.frame, 'intro.show');
    check('the world can ask for the screen and is told only that it opened (no text, no address)', asked.ok && asked.r === true, asked);
    const s = await screenOpen(A);
    check('the screen opens on "Show mine", with the other view hidden', !!s && s.tabOn === 'Show mine' && s.showUp === true && s.readUp === false, s);
    await waitFor(async () => (await screen(A)).raw ? true : null, 8000);
    const sA = await screen(A);
    check('it shows our name and short DID (the full DID on hover)', sA.name === 'Maya' && /^keo:[A-Za-z0-9_-]{4}…[A-Za-z0-9_-]{4}$/.test(sA.did) && sA.didFull === A.did, sA);
    check('it shows our eight words to read out', sA.words.split(' ').length === 8, sA.words);
    check('it lists our helper addresses (only in this page)', /ws:\/\/203\.0\.113\.9:47431/.test(sA.reach) && /home\.example\.org:8443/.test(sA.reach), sA.reach);
    check('the text is a keo introduction for this DID, name and helpers', /^keointro1\./.test(sA.raw) && (await A.page.evaluate((t) => { const i = window.keoHello.introFromText(t); return i.did; }, sA.raw)) === A.did, sA.raw.slice(0, 40));
    check('the QR code is drawn at a readable size', sA.canvasW >= 200 && sA.canvasW <= 400, sA.canvasW);
    const scanned = await scanCanvas(A);
    check('the QR code, read back by a separate decoder, is exactly the text shown', scanned === sA.raw, { scanned: scanned && scanned.slice(0, 30) });
    await shot(A.page, 'intro-show');

    check('asked again while it is up, the world is refused', (await call(A.frame, 'intro.show')).ok === false && /already open/.test((await call(A.frame, 'intro.read')).e || ''));
    check('the world is handed nothing of it through the bridge (no op returns text)', !(await call(A.frame, 'intro.text')).ok);
    await A.page.keyboard.press('Escape');
    check('Escape closes it', (await screenGone(A)) === true);
    const soon = await call(A.frame, 'intro.show');
    check('asked again a moment after it was closed, the world is refused', soon.ok === false && /a moment ago/.test(soon.e || ''), soon);
    const cleared = await A.page.evaluate(() => { const r = document.getElementById('keo-intro'); return { raw: r.querySelector('textarea.raw').value, words: r.querySelector('.show .words').textContent, w: r.querySelector('canvas').width }; });
    check('closing clears the text, the words and the code from the page', cleared.raw === '' && cleared.words === '' && cleared.w === 0, cleared);

    // ---- 2. reading theirs: nothing is added until the words match and a real click
    await B.page.bringToFront();
    const askedB = await call(B.frame, 'intro.read');
    check('the world can ask for the reading screen', askedB.ok && askedB.r === true, askedB);
    const r0 = await screenOpen(B);
    check('it opens on "Read one": the paste box, no result, no Add button yet', r0.tabOn === 'Read one' && r0.readUp === true && r0.showUp === false && r0.resultUp === false && r0.yesHidden === false && r0.yesDisabled === true, r0);

    await B.page.fill('#keo-intro textarea.paste', 'hello there');
    let r1 = await screen(B);
    check('text that is not an introduction gets a sentence and no result', /not a keo introduction/.test(r1.pasteHint) && r1.pasteHintClass.indexOf('bad') >= 0 && r1.resultUp === false, r1);
    await B.page.fill('#keo-intro textarea.paste', 'keointro1.AAAA');
    r1 = await screen(B);
    check('an unreadable introduction gets a sentence', /not a valid keo introduction/.test(r1.pasteHint) && r1.resultUp === false, r1);

    await B.page.fill('#keo-intro textarea.paste', 'Here you go: ' + sA.raw + ' (see you)');
    const r2 = await waitFor(async () => { const d = await screen(B); return d.resultUp ? d : null; }, 8000);
    check('a valid introduction inside a longer message shows who it names: the name as a claim, the short DID, a picture', !!r2 && r2.rName === 'calls themselves “Maya”' && r2.rDid === sA.did && r2.rDidFull === A.did && /^data:image\//.test(r2.rImg), r2);
    check('it shows the addresses given as a hint', !!r2 && /203\.0\.113\.9:47431/.test(r2.rReach), r2 && r2.rReach);
    check('it shows none of the other side\'s eight words, and Add is off', !!r2 && r2.text.indexOf(sA.words) < 0 && r2.yesDisabled === true, r2 && r2.yesDisabled);
    check('nobody is added by reading it', (await isAdded(B, A.did)) === false);
    await shot(B.page, 'intro-read');

    await B.page.fill('#keo-intro input.theirs', 'abandon ability able about above absent absorb abstract');
    const r3 = await waitFor(async () => { const d = await screen(B); return /not their words|not one of the words/.test(d.checkHint) ? d : null; }, 8000);
    check('wrong words keep Add off and say so', !!r3 && r3.yesDisabled === true && r3.checkClass.indexOf('bad') >= 0, r3);
    await B.page.click('#keo-intro button.yes', { force: true, timeout: 1500 }).catch(() => {});
    check('and clicking the disabled Add adds nobody', (await isAdded(B, A.did)) === false);

    await B.page.fill('#keo-intro input.theirs', sA.words);
    const r4 = await waitFor(async () => { const d = await screen(B); return d.yesDisabled === false ? d : null; }, 8000);
    check('the right words (as A read them out) wake the Add button and say they match', !!r4 && /match/.test(r4.checkHint) && r4.checkClass.indexOf('good') >= 0, r4);
    check('still nobody is added before the click', (await isAdded(B, A.did)) === false);
    await B.page.click('#keo-intro button.yes');
    check('the click adds the friend and the screen goes', (await screenGone(B)) === true && (await waitFor(async () => (await isAdded(B, A.did)) ? true : null, 5000)) === true);
    const rec = await B.page.evaluate((d) => window.keoContacts.get(d), A.did);
    check('the friend is kept with the name the introduction gave', rec && rec.name === 'Maya', rec);
    check('no card or address was stored from the introduction', (await B.page.evaluate((d) => window.keoContacts.cards(d), A.did)).length === 0);
    const told = await waitFor(async () => (await B.frame.evaluate(() => window.__fr.slice())).find((e) => e.kind === 'added' && e.peer && e.peer.did) || null, 5000);
    check('the world is told a friend was added (the same event as the friend dialog)', !!told && told.peer.did === A.did && told.peer.name === 'Maya', told);

    // ---- 3. an introduction for someone already added, and the tab switch
    await sleep(10200);
    await call(B.frame, 'intro.read');
    await screenOpen(B);
    await B.page.fill('#keo-intro textarea.paste', sA.raw);
    const r5 = await waitFor(async () => { const d = await screen(B); return d.resultUp ? d : null; }, 8000);
    check('reading it again says they are already a friend and offers no words box', !!r5 && /already one of your friends/.test(r5.pasteHint) && r5.theirsDisabled === true && r5.yesDisabled === true, r5);
    await B.page.click('#keo-intro button[data-tab="show"]');
    const r6 = await waitFor(async () => { const d = await screen(B); return d.showUp && d.raw ? d : null; }, 8000);
    check('the tab switches this screen to our own introduction, for the other direction', !!r6 && r6.tabOn === 'Show mine' && r6.name === 'Jun' && r6.didFull === B.did && r6.yesHidden === true, r6);
    check('with no helper set, our introduction says so plainly', /Nowhere yet/.test(r6.reach), r6.reach);
    check('and it is a valid code of its own: read back it is the text', (await scanCanvas(B)) === r6.raw);
    await B.page.click('#keo-intro button[data-ans="no"]');
    await screenGone(B);

    // ---- 4. a name made up inside the introduction is not what identifies anyone; a forged DID needs the right words
    await sleep(10200);
    const forged = await B.page.evaluate((d) => window.keoHello.introToText({ did: d.slice(0, -4) + 'AAAA', name: 'Maya' }), A.did);
    check('a forged introduction naming a look-alike DID can be made (it is unsigned: that is why the words are checked)', /^keointro1\./.test(forged));
    await A.page.bringToFront();
    const askedA2 = await call(A.frame, 'intro.read');
    check('the first device can open the reading screen too once the pause has passed', askedA2.ok === true, askedA2);
    await screenOpen(A);
    await A.page.fill('#keo-intro textarea.paste', forged);
    const f1 = await waitFor(async () => { const d = await screen(A); return d.resultUp ? d : null; }, 8000);
    await A.page.fill('#keo-intro input.theirs', sA.words);
    await sleep(800);
    const f2 = await screen(A);
    check('the real owner\'s words do not match a look-alike DID, so it cannot be added', !!f1 && f2.yesDisabled === true && /not their words/.test(f2.checkHint), f2);
    check('and the look-alike was not added', (await isAdded(A, A.did.slice(0, -4) + 'AAAA')) === false);
    await A.page.keyboard.press('Escape');

    check('no page errors were logged', errors.length === 0, errors.slice(0, 5));
  } finally { clearTimeout(hard); for (const c of ctxs) await c.close().catch(() => {}); }
  console.log(passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})().catch(async (e) => { console.error('FATAL', e); for (const c of ctxs) await c.close().catch(() => {}); process.exit(2); });
