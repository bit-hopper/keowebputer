// The toolbar popup (shell/popup.html), by real clicks on the page.
// Usage: node keo-popup-test.js <repo root> <extension folder> <work dir>
// A headed browser with the extension loaded and `localhost` unresolvable. The popup page is opened in a TAB at its own address,
// because a test cannot click the toolbar icon: it is the same page and the same script, but it is NOT the browser's popup
// surface, so what that surface does (closing when focus leaves, its size limits) is not covered. It checks: the manifest gives
// the icon a popup and no background worker; first run; an identity exists and no keo tab is open (signed out); a keo tab is open
// (the button brings it forward and makes no second tab); labels are drawn as text; the page asks nothing of the network.
// NOT covered: the real toolbar click, a real authenticator.
const fs = require('fs');
const path = require('path');
const { REPO, EXT, WORK } = require('./args.js')();
const { chromium } = require(path.join(REPO, 'node_modules', 'playwright-core'));
const ID = 'cgjphijackijgcjkfdfieihkbfooigjp';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
function check(name, ok, detail) { console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail !== undefined && !ok ? '  -> ' + JSON.stringify(detail).slice(0, 700) : '')); if (!ok) failed++; }
const errors = [], outside = [];

async function until(fn, ms) { const t = Date.now(); for (;;) { const v = await fn().catch(() => null); if (v) return v; if (Date.now() - t > (ms || 10000)) return null; await sleep(150); } }
const shellPages = (ctx) => ctx.pages().filter((p) => !p.isClosed() && new RegExp('^chrome-extension://' + ID + '/start\\.html').test(p.url()));
// A fresh popup page. It is watched for errors and for any request that is not to the extension itself.
async function openPopup(ctx, scheme) {
  const p = await ctx.newPage();
  if (scheme) await p.emulateMedia({ colorScheme: scheme });
  p.on('pageerror', (e) => errors.push('PAGEERROR ' + e.message.slice(0, 200)));
  p.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text().slice(0, 200)); });
  p.on('request', (r) => { if (!/^(chrome-extension|data|blob):/.test(r.url())) outside.push(r.url()); });
  await p.goto(`chrome-extension://${ID}/popup.html`);
  return p;
}
const pill = (p) => p.evaluate(() => { const e = document.querySelector('.pill'); return e && e.textContent; });
const btnText = (p) => p.evaluate(() => { const e = document.querySelector('.btn'); return e && e.textContent; });
const settled = (p) => until(() => p.evaluate(() => !!document.querySelector('.pill')), 8000);

(async () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(EXT, 'manifest.json'), 'utf8'));
  check('manifest: the icon has a popup', manifest.action && manifest.action.default_popup === 'popup.html', manifest.action);
  check('manifest: no background worker (a popup and a click handler cannot both exist)', !manifest.background, manifest.background);
  const sizes = ['16', '32', '48', '128'];
  check('manifest: the extension and its toolbar button have the mascot icon at four sizes', sizes.every((n) => manifest.icons && manifest.icons[n] === 'icons/keo-' + n + '.png' && manifest.action.default_icon && manifest.action.default_icon[n] === 'icons/keo-' + n + '.png' && fs.statSync(path.join(EXT, manifest.icons[n])).size > 100), [manifest.icons, manifest.action]);
  check('package: the popup page, its script, its styles and the mascot are in it', ['popup.html', 'popup.js', 'popup.css', 'core/media/face-masks/keo.png'].every((f) => fs.existsSync(path.join(EXT, f))));

  const ctx = await chromium.launchPersistentContext(path.join(WORK, 'profile-popup'), {
    headless: false, viewport: { width: 1000, height: 760 },
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--host-resolver-rules=MAP localhost ~NOTFOUND, MAP 127.0.0.1 ~NOTFOUND'] });
  await sleep(2500);
  try {
    // ---- 1. first run: no identity, no keo tab
    let pop = await openPopup(ctx, 'light');
    check('first run: the popup settles', await settled(pop));
    check('first run: says there is no identity', (await pill(pop)) === 'No identity', await pill(pop));
    check('first run: one button, "Make identity"', (await btnText(pop)) === 'Make identity' && (await pop.locator('.btn').count()) === 1, await btnText(pop));
    check('first run: the mascot drew', await pop.evaluate(() => { const i = document.querySelector('.hero img'); return !!i && i.complete && i.naturalWidth > 0; }));
    await pop.screenshot({ path: path.join(WORK, 'popup-first-run-light.png') });
    await pop.emulateMedia({ colorScheme: 'dark' });
    await pop.screenshot({ path: path.join(WORK, 'popup-first-run-dark.png') });
    check('first run: the dark scheme changes the panel colour', await pop.evaluate(() => getComputedStyle(document.getElementById('popup')).backgroundColor) === 'rgb(36, 25, 40)');
    check('first run: the content is a rounded card inset on a tinted ground', await pop.evaluate(() => {
      const c = getComputedStyle(document.getElementById('popup')), b = getComputedStyle(document.body);
      return c.borderTopLeftRadius === '16px' && b.paddingLeft === '8px' && b.backgroundColor !== c.backgroundColor && document.body.getBoundingClientRect().width === 360;
    }));
    check('first run: no keo tab yet', shellPages(ctx).length === 0);
    await pop.locator('.btn').click();
    const keo = await until(async () => shellPages(ctx)[0], 10000);
    check('first run: the button opens keo in a tab', !!keo, ctx.pages().map((p) => p.url()));
    check('first run: and the popup page closes itself', await until(async () => pop.isClosed(), 5000));
    if (!keo) throw new Error('no keo tab: the rest depends on it');

    // ---- 2. identities exist (made through the shell) and a keo tab is open
    await keo.waitForLoadState('load');
    // The virtual authenticator goes on the page that creates the passkeys.
    const cdp = await ctx.newCDPSession(keo);
    await cdp.send('WebAuthn.enable', { enableUI: false });
    await cdp.send('WebAuthn.addVirtualAuthenticator', { options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true,
      hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true, hasPrf: true } });
    await sleep(1500);
    // Two are made for real. The popup reads only label, DID and creation time, so the other two are bare records in the same store
    // (their DIDs are the right shape but belong to nobody): a fourth real creation in a row timed out in the virtual authenticator
    // here even without the popup involved (cause not looked into), and the test needs more than three to see the count.
    await keo.evaluate(async () => { for (const l of ['<b>Maya</b>', 'Noor']) await window.keoIdentity.create({ label: l }); });
    await keo.evaluate(() => new Promise((res, rej) => {
      const q = indexedDB.open('keo-identities', 1);
      q.onerror = () => rej(q.error);
      q.onsuccess = () => {
        const db = q.result, tx = db.transaction('identities', 'readwrite'), st = tx.objectStore('identities');
        ['Ines', 'Sam'].forEach((label, i) => st.put({ did: 'did:keo:zzzz:' + label.padEnd(43, 'A'), label, createdAt: new Date(Date.now() + 1000 * (i + 1)).toISOString() }));
        tx.oncomplete = () => { db.close(); res(); }; tx.onerror = () => rej(tx.error);
      };
    }));
    check('setup: four records in the identity store', (await keo.evaluate(() => new Promise((res) => { const q = indexedDB.open('keo-identities', 1); q.onsuccess = () => { const c = q.result.transaction('identities').objectStore('identities').count(); c.onsuccess = () => { q.result.close(); res(c.result); }; }; }))) === 4);
    pop = await openPopup(ctx, 'light');
    check('open: the popup settles', await settled(pop));
    // Creating an identity signs it in, so the keo tab has a session: the popup asks the tab and says so (keo-status.js).
    // (Which of the two identities is the one signed in is the shell's own business; the popup must show the same one.)
    const signedAs = await keo.evaluate(() => window.keoIdentity.current().then((s) => s && s.label));
    check('open: says who is signed in (the one the keo tab says) and offers Switch to keo', !!signedAs && (await pill(pop)) === 'Signed in' && (await btnText(pop)) === 'Switch to keo' && (await pop.locator('.me .who b').textContent()) === signedAs, [signedAs, await pill(pop), await btnText(pop), await pop.locator('.me .who b').allTextContents()]);
    // (document.visibilityState cannot show this: the test driver makes every page believe it is in front. The browser's own
    // record of the tab can.)
    const isActive = () => keo.evaluate(() => chrome.tabs.getCurrent().then((t) => t.active));
    check('open: the keo tab is in the background while the popup tab is in front', await until(async () => (await isActive()) === false, 3000));
    await pop.screenshot({ path: path.join(WORK, 'popup-open.png') });
    const nTabs = shellPages(ctx).length;
    await pop.locator('.btn').click();
    check('open: Switch to keo brings the keo tab forward', await until(async () => (await isActive()) === true, 8000));
    check('open: and opens no second keo tab', shellPages(ctx).length === nTabs, shellPages(ctx).map((p) => p.url()));
    check('open: and the popup page closes itself', await until(async () => pop.isClosed(), 5000));

    // ---- 3. the keo tab is closed: nobody is signed in
    await keo.close();
    check('signed out: no keo tab is left', shellPages(ctx).length === 0);
    pop = await openPopup(ctx, 'light');
    check('signed out: the popup settles', await settled(pop));
    check('signed out: says signed out, one button', (await pill(pop)) === 'Signed out' && (await btnText(pop)) === 'Open keo and sign in' && (await pop.locator('.btn').count()) === 1, [await pill(pop), await btnText(pop)]);
    const shown = await pop.evaluate(() => [...document.querySelectorAll('.me .who b')].map((b) => b.textContent));
    check('signed out: three identities shown by label, in the order made, and a count of the rest', JSON.stringify(shown) === JSON.stringify(['<b>Maya</b>', 'Noor', 'Ines']) && (await pop.evaluate(() => (document.querySelector('.more') || {}).textContent)) === '+ 1 more on this device', shown);
    check('signed out: a label is drawn as text, never as markup', await pop.evaluate(() => document.querySelectorAll('.who b *').length === 0));
    check('signed out: each shows its identicon and a short DID', await pop.evaluate(() => [...document.querySelectorAll('.me')].every((m) => /^data:image\/png/.test(m.querySelector('img').src) && /^keo:.{4}….{4}$/.test(m.querySelector('.did').textContent))));
    check('signed out: nothing but label and short DID reaches the page', await pop.evaluate(() => !/wrapped|secret|credential|inception/i.test(document.documentElement.innerHTML)));
    await pop.screenshot({ path: path.join(WORK, 'popup-signed-out.png') });
    await pop.locator('.btn').click();
    check('signed out: the button opens keo in a tab', !!(await until(async () => shellPages(ctx)[0], 10000)));
    check('signed out: and the popup page closes itself', await until(async () => pop.isClosed(), 5000));

    // ---- 4. the page asks nothing of the network and raises no error
    check('no request left the extension', outside.length === 0, outside);
    check('no page error or console error', errors.length === 0, errors);
  } catch (e) {
    check('test ran to the end', false, String(e && e.stack || e));
  } finally {
    await ctx.close().catch(() => {});
  }
  console.log(failed ? `\n${failed} FAILED` : '\nall passed');
  process.exit(failed ? 1 : 0);
})();
