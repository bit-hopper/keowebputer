// Signing in and signing out must not trigger the browser's "Leave site?" warning, while an ordinary reload still does.
// Usage: node keo-leave-test.js <repo root> <extension folder> <work dir>
// The warning is the runtime's own exit warning (Config.askBeforeQuit, bootstrap.js). It replaces the world frame on sign-in and
// reloads the page on sign-out, and the browser only shows it for a page the person has clicked in, so each step first clicks in
// the world with a real mouse click. Every dialog the browser raises is recorded by type. One headed browser, a virtual authenticator.
// NOT covered: a real authenticator; a world with unsaved edits (the warning is not conditional on them).
const fs = require('fs');
const path = require('path');
const { REPO, EXT, WORK } = require('./args.js')();
const { chromium } = require(path.join(REPO, 'node_modules', 'playwright-core'));
const ID = 'keoapnoighmdpncpbfffhcdgdjgjmpdn';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0, passed = 0;
function check(name, ok, detail) { if (ok) passed++; else failed++; console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail !== undefined && !ok ? '  -> ' + JSON.stringify(detail).slice(0, 700) : '')); }
const dialogs = [];

const worldFrame = (page) => page.frames().find((f) => /world\.html$/.test(f.url()));
async function waitForWorld(page, kind) {
  for (let i = 0; i < 200; i++) {
    const f = worldFrame(page);
    if (f) { try { if (await f.evaluate((k) => !!(window.$world && window.$world.submorphs && window.keo && window.keo.init && window.keo.init.startup && window.keo.init.startup.kind === k), kind)) { await sleep(2500); return f; } } catch (e) {} }
    await sleep(300);
  }
  throw new Error('the world did not start as ' + kind);
}
const call = (frame, op, args) => frame.evaluate(([o, a]) => window.keo.call(o, a, 60000).then((r) => ({ ok: true, r }), (e) => ({ ok: false, e: e.message })), [op, args || {}]);
// A real click inside the world: the browser shows a leave warning only for a page the person has interacted with.
const clickWorld = async (page) => { await page.bringToFront(); await page.mouse.click(600, 400); await sleep(300); };
const types = (from) => dialogs.slice(from).map((d) => d.type);

(async () => {
  const ctx = await chromium.launchPersistentContext(path.join(WORK, 'profile-leave'), {
    headless: false, viewport: { width: 1200, height: 800 },
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--host-resolver-rules=MAP localhost ~NOTFOUND, MAP 127.0.0.1 ~NOTFOUND'] });
  await sleep(2000);
  try {
    const page = await ctx.newPage();
    page.on('dialog', (d) => { dialogs.push({ type: d.type(), message: d.message() }); d.accept().catch(() => {}); });
    const cdp = await ctx.newCDPSession(page);
    await cdp.send('WebAuthn.enable', { enableUI: false });
    await cdp.send('WebAuthn.addVirtualAuthenticator', { options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true, hasPrf: true } });
    await page.goto(`chrome-extension://${ID}/start.html#guest`);
    let frame = await waitForWorld(page, 'guest');
    const created = await page.evaluate(() => window.keoIdentity.create({ label: 'Maya' }));
    check('setup: an identity is made and signed in', !!created && !!created.did);
    const flag = () => worldFrame(page).evaluate(() => lively.Config.askBeforeQuit);
    const before = await flag();
    check('the runtime\'s exit warning is on by default (what makes the browser ask)', before === true, before);

    // ---- control: an ordinary reload by the person still asks
    await clickWorld(page);
    let n = dialogs.length;
    await page.evaluate(() => { setTimeout(() => location.reload(), 0); });
    await sleep(2500);
    check('control: a plain reload of the page after a click still raises the browser\'s warning', types(n).includes('beforeunload'), dialogs.slice(n));
    frame = await waitForWorld(page, 'guest').catch(async () => null);
    if (!frame) { await page.goto(`chrome-extension://${ID}/start.html#guest`); frame = await waitForWorld(page, 'guest'); }

    // ---- sign-in: the landing replaces the world frame (the reload above ended the session: sign in again, which is one passkey prompt)
    await page.evaluate((did) => window.keoIdentity.signIn({ did }), created.did);
    await frame.evaluate(() => lively.require('lively.identity.PasskeyPrimingDialog').toRun(function () { lively.LocalStorage.set(lively.identity.PasskeyPrimingDialog.SKIP_FLAG_KEY, true); }));
    await clickWorld(page);
    n = dialogs.length;
    const entered = await call(frame, 'world.go', { kind: 'enter' });
    check('sign-in: the shell takes the person in', entered.ok === true, entered);
    frame = await waitForWorld(page, 'homestar');
    check('sign-in: no browser warning was raised', types(n).length === 0, dialogs.slice(n));
    check('sign-in: and the exit warning is back on once the new page is up', (await flag()) === true, await flag());

    // ---- moving between pages is NOT sign-in: it keeps the warning
    await clickWorld(page);
    n = dialogs.length;
    await call(frame, 'world.go', { kind: 'blank' });
    await sleep(2500);
    check('moving to another page (not a sign-in) still raises the browser\'s warning', types(n).includes('beforeunload'), dialogs.slice(n));
    frame = await waitForWorld(page, 'blank');

    // ---- sign-out reloads the page
    await clickWorld(page);
    n = dialogs.length;
    const out = await call(frame, 'session.signOut');
    check('sign-out: the shell ends the session', out.ok === true, out);
    await sleep(3000);
    check('sign-out: no browser warning was raised', types(n).length === 0, dialogs.slice(n));
    frame = await waitForWorld(page, 'guest').catch(() => null);
    check('sign-out: the page came back to a page with nobody signed in', !!frame);
    check('sign-out: and the exit warning is on again', !!frame && (await frame.evaluate(() => lively.Config.askBeforeQuit)) === true);

    // ---- a call that leaves nothing behind gives the warning back
    await clickWorld(page);
    const refused = await call(frame, 'world.go', { kind: 'enter' });
    check('a sign-in step that is refused (nobody is signed in)', refused.ok === false, refused);
    await sleep(3500);
    check('and the exit warning is on again afterwards', (await frame.evaluate(() => lively.Config.askBeforeQuit)) === true);
  } catch (e) {
    check('test ran to the end', false, String(e && e.stack || e));
  } finally {
    await ctx.close().catch(() => {});
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
