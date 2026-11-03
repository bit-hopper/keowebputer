// End-to-end test of the in-world sign-in: the runtime's LoginDialog and RegisterDialog in their local mode, and the shell's choice
// of sign-in screen.
// Usage: node keo-gate-test.js <repo root> <extension folder> <work dir>
// A headed browser with the extension loaded, `localhost` unresolvable, and a CDP virtual authenticator with PRF. Identities are
// made through the shell, then the dialog is opened inside a world that has no session (start.html#guest, which every package
// can run) and driven like a person would: the list shows the identities by label, a click is ONE passkey prompt and lands on the
// home page or on the world saved last, "New identity" creates one in two prompts and lands on its home page. If the package
// carries a landing page (keo-build.json gateWorld, a local build only) the same is done from it, and the page without a hash
// must start it instead of the shell's HTML screen; `start.html#html` always shows the HTML screen.
// NOT covered: a real authenticator, a browser restart, clicking the landing page's own "get started" link (it is the user's
// unfinished page; the dialog it opens is what is tested).
const fs = require('fs');
const path = require('path');
const { REPO, EXT, WORK } = require('./args.js')();
const { chromium } = require(path.join(REPO, 'node_modules', 'playwright-core'));
const ID = 'cgjphijackijgcjkfdfieihkbfooigjp';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function check(name, ok, detail) { console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail !== undefined && !ok ? '  -> ' + JSON.stringify(detail).slice(0, 700) : '')); if (!ok) failed++; }
let failed = 0;
const errors = [];

const worldFrame = (page) => page.frames().find((f) => /world\.html$/.test(f.url()));
async function waitForWorld(page, kind, label) {
  let frame = null;
  for (let i = 0; i < 200; i++) {
    frame = worldFrame(page);
    if (frame) {
      try {
        if (await frame.evaluate(([k, l]) => { const s = window.keo && window.keo.init && window.keo.init.startup; return !!(window.$world && window.$world.submorphs && s && s.kind === k && (!l || (s.session && s.session.label === l))); }, [kind, label || null])) break;
      } catch (e) {}
    }
    frame = null; await sleep(300);
  }
  if (!frame) {
    const f = worldFrame(page);
    const state = f ? await f.evaluate(() => ({ kind: window.keo && keo.init && keo.init.startup && keo.init.startup.kind, label: keo.init.startup && keo.init.startup.session && keo.init.startup.session.label, world: !!window.$world })).catch((e) => 'eval failed: ' + e.message.slice(0, 80)) : 'no world frame';
    throw new Error('the world did not start as ' + kind + (label ? ' for ' + label : '') + ' (state: ' + JSON.stringify(state) + ')');
  }
  await sleep(2500);       // the page-specific setup (home page, menu) runs after the world is up
  return frame;
}
const keoCall = (frame, op, args) => frame.evaluate(([o, a]) => window.keo.call(o, a, 60000).then((r) => ({ ok: true, r }), (e) => ({ ok: false, e: e.message })), [op, args || {}]);

// The dialog's morphs, found by walking the world (names are not unique: one identityBtn per identity).
const dialogState = (frame) => frame.evaluate(() => {
  const found = [];
  (function walk(m) { if (m.name === 'IdentityLoginDialog') found.push(m); (m.submorphs || []).forEach(walk); })($world);
  const d = found[0];
  if (!d) return null;
  const btns = []; let status = '';
  (function walk(m) { if (m.name === 'identityBtn') btns.push(m.getLabel ? m.getLabel() : m.label); if (m.name === 'statusText') status = String(m.textString || ''); (m.submorphs || []).forEach(walk); })(d);
  return { buttons: btns, status, height: Math.round(d.getExtent().y) };
});
const openLogin = (frame) => frame.evaluate(() => { lively.require('lively.identity.LoginDialog').toRun(function () { lively.BuildSpec('lively.identity.LoginDialog').createMorph().openInWorldCenter(); }); });
const clickNamed = (frame, name, index) => frame.evaluate(([n, i]) => {
  const hits = [];
  (function walk(m) { if (m.name === n) hits.push(m); (m.submorphs || []).forEach(walk); })($world);
  const m = hits[i || 0];
  if (!m) return false;
  m.simulateButtonClick(); return true;
}, [name, index || 0]);
async function waitDialog(frame, n) {
  for (let i = 0; i < 60; i++) { const s = await dialogState(frame).catch(() => null); if (s && s.buttons.length === n) return s; await sleep(300); }
  return await dialogState(frame).catch(() => null);
}
// A change of the hash alone is not a new page load, so go through a blank page first.
async function openShell(page, hash) { await page.goto('about:blank'); await page.goto(`chrome-extension://${ID}/start.html${hash || ''}`); }
const creds = (page) => page.evaluate(() => Object.assign({}, window.__cred));
const delta = (a, b) => JSON.stringify({ create: b.create - a.create, get: b.get - a.get });

(async () => {
  fs.mkdirSync(WORK, { recursive: true });
  const ctx = await chromium.launchPersistentContext(path.join(WORK, 'profile-gate'), {
    headless: false, viewport: { width: 1280, height: 860 },
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--host-resolver-rules=MAP localhost ~NOTFOUND, MAP 127.0.0.1 ~NOTFOUND'] });
  await sleep(2500);
  try {
    await ctx.addInitScript(() => { if (location.protocol === 'chrome-extension:' && /start\.html/.test(location.pathname) && navigator.credentials) { window.__cred = { create: 0, get: 0 }; for (const k of ['create', 'get']) { const o = navigator.credentials[k].bind(navigator.credentials); navigator.credentials[k] = function () { window.__cred[k]++; return o.apply(null, arguments); }; } } });
    const page = await ctx.newPage();
    page.on('pageerror', (e) => errors.push('PAGEERROR ' + e.message.slice(0, 200)));
    page.on('console', (m) => { if (m.type() === 'error' && !/compute-pressure|ERR_FILE_NOT_FOUND/.test(m.text())) errors.push('console: ' + m.text().slice(0, 200)); });
    const cdp = await ctx.newCDPSession(page);
    await cdp.send('WebAuthn.enable', { enableUI: false });
    await cdp.send('WebAuthn.addVirtualAuthenticator', { options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true,
      hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true, hasPrf: true } });

    // ---- 1. which sign-in screen the shell starts
    await openShell(page, '#guest');
    const gateWorld = await page.evaluate(() => fetch('keo-build.json').then((r) => r.json()).then((b) => !!b.gateWorld));
    console.log('INFO the package ' + (gateWorld ? 'has' : 'has no') + ' landing page (keo-build.json gateWorld)');
    await openShell(page, '#html');
    await sleep(1500);
    check('screen: #html always shows the shell\'s HTML screen, and starts no world', await page.evaluate(() => !document.getElementById('gate').classList.contains('hidden')) && !worldFrame(page));
    await openShell(page, '');
    await sleep(gateWorld ? 6000 : 1500);
    if (gateWorld) {
      const f = worldFrame(page);
      const kind = f ? await f.evaluate(() => window.keo.init.startup.kind).catch(() => null) : null;
      check('screen: with a landing page in the package, the world starts from it and the HTML screen stays hidden', kind === 'gate' && await page.evaluate(() => document.getElementById('gate').classList.contains('hidden')), kind);
    } else {
      check('screen: without a landing page the HTML screen is shown, and starts no world', await page.evaluate(() => !document.getElementById('gate').classList.contains('hidden')) && !worldFrame(page));
    }

    // ---- 2. two identities on the device, nobody signed in
    await openShell(page, '#guest');
    let frame = await waitForWorld(page, 'guest');
    await frame.evaluate(() => { lively.require('lively.identity.PasskeyPrimingDialog').toRun(function () { lively.LocalStorage.set(lively.identity.PasskeyPrimingDialog.SKIP_FLAG_KEY, true); }); });
    await page.evaluate(async () => { await window.keoIdentity.create({ label: 'Maya' }); await window.keoIdentity.create({ label: 'Noor' }); await window.keoIdentity.signOut(); });
    check('setup: two identities, no session', (await page.evaluate(async () => (await window.keoIdentity.list()).map((i) => i.label).sort().join())) === 'Maya,Noor' && (await page.evaluate(() => window.keoIdentity.current())) === null);

    // ---- 3. the dialog lists them by label
    await openLogin(frame);
    let st = await waitDialog(frame, 2);
    check('dialog: one button per identity on the device, by label (no handle field)', st && st.buttons.slice().sort().join() === 'Maya,Noor', st);
    check('dialog: the window grew to fit the list', st && st.height > 174, st);
    await page.screenshot({ path: path.join(WORK, 'gate-dialog.png') });

    // ---- 4. a click is one passkey prompt and lands on the home page
    const c0 = await creds(page);
    const noorIdx = st.buttons.indexOf('Noor');
    await clickNamed(frame, 'identityBtn', noorIdx);
    frame = await waitForWorld(page, 'homestar', 'Noor');
    const sNoor = (await frame.evaluate(() => window.keo.init.startup.session));
    check('sign in: one passkey prompt, no creation', delta(c0, await creds(page)) === '{"create":0,"get":1}', { c0, c1: await creds(page) });
    check('sign in: the world restarted on the home page of the identity that was clicked', sNoor && sNoor.label === 'Noor', sNoor);
    check('sign in: the shell holds the session, the world can read it', (await keoCall(frame, 'session.current')).r.label === 'Noor');

    // ---- 5. a saved world is what a returning identity lands on
    await keoCall(frame, 'world.go', { kind: 'blank' });
    frame = await waitForWorld(page, 'blank');
    await frame.evaluate(() => { const m = new lively.morphic.Box(lively.rect(40, 80, 90, 60)); m.setName('gate-marker'); $world.addMorph(m); });
    const saved = await frame.evaluate(() => new Promise((res) => $world.saveWorldAs(URL.root.withFilename('first.html'), false, undefined, (e) => res(e ? { err: e.message } : { ok: true }))));
    check('setup: Noor saved a world', saved.ok === true, saved);
    await frame.evaluate(() => { lively.identity.localIdentity.signOut(function () {}); });
    frame = await waitForWorld(page, 'guest');
    check('sign out: back to a world with no session', (await page.evaluate(() => window.keoIdentity.current())) === null);

    // Maya has saved nothing: she lands on her home page, not on Noor's world
    await openLogin(frame);
    st = await waitDialog(frame, 2);
    await clickNamed(frame, 'identityBtn', st.buttons.indexOf('Maya'));
    frame = await waitForWorld(page, 'homestar', 'Maya');
    check('returning, nothing saved: lands on her own home page, not on the other identity\'s world', (await frame.evaluate(() => keo.init.startup.session.label)) === 'Maya');
    await frame.evaluate(() => { lively.identity.localIdentity.signOut(function () {}); });
    frame = await waitForWorld(page, 'guest');

    await openLogin(frame);
    st = await waitDialog(frame, 2);
    await clickNamed(frame, 'identityBtn', st.buttons.indexOf('Noor'));
    frame = await waitForWorld(page, 'world');
    const sw = await frame.evaluate(() => ({ name: keo.init.startup.name, label: keo.init.startup.session.label, marker: !!$world.get('gate-marker') }));
    check('returning, with a saved world: lands on the world saved last, with its contents', sw.name === 'first' && sw.label === 'Noor' && sw.marker === true, sw);
    await frame.evaluate(() => { lively.identity.localIdentity.signOut(function () {}); });
    frame = await waitForWorld(page, 'guest');

    // ---- 6. a new identity from the dialog: two prompts, lands on its home page
    await openLogin(frame);
    st = await waitDialog(frame, 2);
    check('new identity: the dialog offers it', await clickNamed(frame, 'newIdentityBtn', 0));
    await sleep(2500);
    const c2 = await creds(page);
    await frame.evaluate(() => {
      const hits = []; (function walk(m) { if (m.name === 'labelInput') hits.push(m); (m.submorphs || []).forEach(walk); })($world);
      hits[0].setTextString('Ola');
    });
    check('new identity: the create button was pressed', await clickNamed(frame, 'registerBtn', 0));
    frame = await waitForWorld(page, 'homestar', 'Ola');
    check('new identity: two passkey prompts (create, sign the inception) and a session on the home page', delta(c2, await creds(page)) === '{"create":1,"get":1}' && (await keoCall(frame, 'session.current')).r.label === 'Ola', { c2, c3: await creds(page) });
    await page.screenshot({ path: path.join(WORK, 'gate-new-identity.png') });

    // ---- 7. the same from the landing page
    if (gateWorld) {
      await frame.evaluate(() => { lively.identity.localIdentity.signOut(function () {}); });
      await sleep(1500);
      await openShell(page, '');
      frame = await waitForWorld(page, 'gate');
      await openLogin(frame);
      st = await waitDialog(frame, 3);
      check('landing page: the dialog lists the three identities', st && st.buttons.slice().sort().join() === 'Maya,Noor,Ola', st);
      await page.screenshot({ path: path.join(WORK, 'gate-landing.png') });
      const c4 = await creds(page);
      await clickNamed(frame, 'identityBtn', st.buttons.indexOf('Noor'));
      frame = await waitForWorld(page, 'world');
      check('landing page: one prompt, then the world Noor saved last', delta(c4, await creds(page)) === '{"create":0,"get":1}' && (await frame.evaluate(() => keo.init.startup.name)) === 'first', await creds(page));
      // a refresh keeps the session: it must not show the landing page again
      await page.reload();
      frame = await waitForWorld(page, 'world');
      check('landing page: a refresh goes straight back in, with no prompt', (await creds(page)).get === 0 && (await keoCall(frame, 'session.current')).r.label === 'Noor', await creds(page));
    }

    // The landing page is the user's own world; it embeds a video player and a map that want location, which the extension's policy blocks, and a refresh asks to confirm.
    const mine = errors.filter((e) => !(gateWorld && /beforeunload|youtube\.com|Geolocation access/.test(e)));
    check('no page errors', mine.length === 0, mine.slice(0, 5));
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
