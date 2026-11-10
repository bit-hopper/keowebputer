// The Friends window's two introduction buttons (kernel lively.identity.FriendsDialog, lively.identity.LocalIdentity introShow / introRead):
// real mouse clicks on the morphic buttons put up the SHELL's screens (shell/keo-intro.js), and an introduction added there appears in the
// window's list. The screens themselves are tested in keo-intro-test.js.
// Usage: node keo-intro-window-test.js <repo root> <extension folder> <work dir>
// One headed browser, a virtual authenticator, `localhost` unresolvable. The other side's introduction is made here for a stand-in identity
// (a DID that no device holds), and its words are read from the same word list the shell uses.
// NOT covered: a second real device, a real authenticator, how the window looks at other sizes (set SHOT_DIR and look).
const fs = require('fs');
const path = require('path');
const { REPO, EXT, WORK } = require('./args.js')();
const { chromium } = require(path.join(REPO, 'node_modules', 'playwright-core'));
const ID = 'keoapnoighmdpncpbfffhcdgdjgjmpdn';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0, passed = 0;
function check(name, ok, detail) { if (ok) passed++; else failed++; console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail !== undefined && !ok ? '  -> ' + JSON.stringify(detail).slice(0, 900) : '')); }
const errors = [];
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
const shot = (page, n) => process.env.SHOT_DIR ? page.screenshot({ path: path.join(process.env.SHOT_DIR, n + '.png') }) : null;

(async () => {
  fs.mkdirSync(WORK, { recursive: true });
  const ctx = await chromium.launchPersistentContext(path.join(WORK, 'profile-inw'), {
    headless: false, viewport: { width: 1100, height: 900 },
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--host-resolver-rules=MAP localhost ~NOTFOUND, MAP 127.0.0.1 ~NOTFOUND'] });
  const hard = setTimeout(async () => { console.log('HARD TIMEOUT'); await ctx.close().catch(() => {}); process.exit(3); }, 300000);
  await sleep(2000);
  try {
    const page = await ctx.newPage();
    page.on('pageerror', (e) => errors.push('PAGEERROR ' + e.message.slice(0, 200)));
    page.on('console', (m) => { if (m.type() === 'error' && !/compute-pressure|ERR_FILE_NOT_FOUND|youtube\.com\/iframe_api|Geolocation access has been blocked/.test(m.text())) errors.push('console: ' + m.text().slice(0, 200)); });
    const cdp = await ctx.newCDPSession(page);
    await cdp.send('WebAuthn.enable', { enableUI: false });
    await cdp.send('WebAuthn.addVirtualAuthenticator', { options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true, hasPrf: true } });
    await page.goto(`chrome-extension://${ID}/start.html`);
    let frame = await waitForWorld(page, 'gate');
    const me = await page.evaluate(() => window.keoIdentity.create({ label: 'Maya' }));
    await frame.evaluate(() => window.keo.call('world.go', { kind: 'enter' }, 60000)).catch(() => {});
    frame = await waitForWorld(page, 'homestar');

    // the window, opened the way the menu opens it
    await frame.evaluate(() => new Promise((res) => lively.require('lively.identity.FriendsDialog').toRun(() => { lively.BuildSpec('lively.identity.FriendsDialog').createMorph().openInWorldCenter(); res(); })));
    const win = () => frame.evaluate(() => {
      const w = $world.submorphs.filter((m) => m.name === 'IdentityFriendsDialog')[0];
      if (!w) return null;
      const content = w.get('friendsContent'), pick = (n) => content.submorphs.filter((m) => m.name === n);
      return { words: (pick('myWords')[0] || {}).textString, names: pick('friendName').map((m) => m.textString), empty: !!pick('emptyText').length, status: (pick('statusText')[0] || {}).textString };
    });
    const w0 = await waitFor(async () => { const x = await win(); return x && x.words && x.words !== '…' && x.empty ? x : null; }, 15000);
    check('the Friends window opens with no friends yet', !!w0, w0);
    // where a button is on screen, and whether anything covers it
    const where = (name) => frame.evaluate((n) => {
      const w = $world.submorphs.filter((m) => m.name === 'IdentityFriendsDialog')[0], m = w.get('friendsContent').submorphs.filter((x) => x.name === n)[0];
      if (!m) return null;
      const node = m.renderContext().shapeNode, b = node.getBoundingClientRect(), win = w.renderContext().shapeNode.getBoundingClientRect(), x = b.left + b.width / 2, y = b.top + b.height / 2, top = document.elementFromPoint(x, y);
      return { x, y, label: node.textContent, inside: b.left >= win.left && b.right <= win.right && b.bottom <= win.bottom, covered: !(top && (node === top || node.contains(top) || top.contains(node))), left: b.left, right: b.right, top: b.top };
    }, name);
    const bShow = await where('introShowBtn'), bRead = await where('introReadBtn'), bConn = await where('connectBtn');
    check('both introduction buttons exist, with their labels, inside the window and not covered', !!bShow && !!bRead && bShow.inside && bRead.inside && !bShow.covered && !bRead.covered && /My introduction/.test(bShow.label) && /Read an introduction/.test(bRead.label), { bShow, bRead });
    check('they sit on the same row as "Connect a device" without overlapping it or each other', !!bConn && Math.abs(bShow.top - bConn.top) < 3 && bConn.right <= bShow.left + 1 && bShow.right <= bRead.left + 1, { bConn, bShow, bRead });
    await shot(page, 'intro-window');

    const intro = () => page.evaluate(() => { const r = document.getElementById('keo-intro'); if (!r || r.hidden) return null; const t = r.querySelector('.tab.on'); return { tab: t && t.textContent, raw: r.querySelector('textarea.raw').value, words: r.querySelector('.show .words').textContent }; });

    // ---- show mine, by a real click
    await page.mouse.click(bShow.x, bShow.y);
    const s1 = await waitFor(async () => { const x = await intro(); return x && x.raw ? x : null; }, 10000);
    check('clicking "My introduction" puts up the shell screen on "Show mine", with our introduction', !!s1 && s1.tab === 'Show mine' && /^keointro1\./.test(s1.raw) && s1.words === w0.words, s1);
    check('the text is for this identity', !!s1 && (await page.evaluate((t) => window.keoHello.introFromText(t).did, s1.raw)) === me.did);
    await page.keyboard.press('Escape');
    check('Escape closes the shell screen', !!(await waitFor(async () => (await intro()) ? null : true, 5000)));

    // ---- read one, by a real click, and add a stand-in friend
    await sleep(10200);
    const standIn = 'did:keo:' + 'y'.repeat(52) + ':' + 'B'.repeat(43);
    const text = await page.evaluate((d) => window.keoHello.introToText({ did: d, name: 'Jun' }), standIn);
    const theirWords = await page.evaluate((d) => window.keoFingerprint.words(d), standIn);
    await page.mouse.click(bRead.x, bRead.y);
    const r1 = await waitFor(async () => { const x = await intro(); return x && x.tab === 'Read one' ? x : null; }, 10000);
    check('clicking "Read an introduction" puts up the shell screen on "Read one"', !!r1, r1);
    await page.fill('#keo-intro textarea.paste', text);
    await page.fill('#keo-intro input.theirs', theirWords.join(' '));
    await waitFor(() => page.evaluate(() => !document.querySelector('#keo-intro button.yes').disabled), 8000);
    await page.click('#keo-intro button.yes');
    const w1 = await waitFor(async () => { const x = await win(); return x && x.names.length ? x : null; }, 12000);
    check('after adding there, the Friends window lists the new friend by the name in the introduction', !!w1 && w1.names.join() === 'Jun', w1);
    await shot(page, 'intro-window-after');

    check('no page errors were logged', errors.length === 0, errors.slice(0, 5));
  } finally { clearTimeout(hard); await ctx.close().catch(() => {}); }
  console.log(passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})().catch(async (e) => { console.error('FATAL', e); process.exit(2); });
