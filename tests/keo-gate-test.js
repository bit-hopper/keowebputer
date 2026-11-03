// End-to-end test of the in-world sign-in: the runtime's LoginDialog and RegisterDialog in their local mode, and what the shell
// starts when nobody is signed in.
// Usage: node keo-gate-test.js <repo root> <extension folder> <work dir>
// A headed browser with the extension loaded, `localhost` unresolvable, and a CDP virtual authenticator with PRF. Identities are
// made through the shell, then the dialog is opened inside a world that has no session (start.html#guest, which every package
// can run) and driven like a person would: the list shows the identities by label, a click is ONE passkey prompt and lands on the
// home page or on the world saved last, "New identity" creates one in two prompts and lands on its home page. The same is done from
// the page the shell starts with no hash: the package's landing page (keo-build.json gateWorld, a local build only; the dialog
// is opened from it), or on a package without one the blank world with the dialog already open. The shell draws no sign-in
// screen of its own.
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
const warns = [];        // the shell's and the boot code's own "keo:" console lines, for the failure report

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
  const btns = [], avatars = []; let status = '';
  (function walk(m) { if (m.name === 'identityBtn') btns.push(m.getLabel ? m.getLabel() : m.label); if (m.name === 'identityAvatar') avatars.push(m.getImageURL ? m.getImageURL() : null); if (m.name === 'statusText') status = String(m.textString || ''); (m.submorphs || []).forEach(walk); })(d);
  return { buttons: btns, avatars, status, height: Math.round(d.getExtent().y) };
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
    page.on('console', (m) => { if (/keo:/.test(m.text())) warns.push(m.type() + ': ' + m.text().slice(0, 200)); });
    page.on('console', (m) => { if (m.type() === 'error' && !/compute-pressure|ERR_FILE_NOT_FOUND/.test(m.text())) errors.push('console: ' + m.text().slice(0, 200)); });
    const cdp = await ctx.newCDPSession(page);
    await cdp.send('WebAuthn.enable', { enableUI: false });
    await cdp.send('WebAuthn.addVirtualAuthenticator', { options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true,
      hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true, hasPrf: true } });

    // ---- 1. which sign-in screen the shell starts
    await openShell(page, '#guest');
    const gateWorld = await page.evaluate(() => fetch('keo-build.json').then((r) => r.json()).then((b) => !!b.gateWorld));
    console.log('INFO the package ' + (gateWorld ? 'has' : 'has no') + ' landing page (keo-build.json gateWorld)');
    await openShell(page, '');
    const f0 = await waitForWorld(page, 'gate');
    check('start: the shell page draws no sign-in screen of its own', await page.evaluate(() => !document.getElementById('gate') && !document.getElementById('idlist') && !document.getElementById('create')));
    if (gateWorld) {
      // (Whether the landing page itself opens the dialog is its own business and not asserted.)
      console.log('INFO landing page started; the dialog is ' + ((await dialogState(f0).catch(() => null)) ? 'already' : 'not') + ' open on it');
    } else {
      // The package has no landing page: the blank world starts and the sign-in dialog is opened on it (world/keo-boot.js).
      let d0 = null;
      for (let i = 0; i < 40 && !d0; i++) { d0 = await dialogState(f0).catch(() => null); if (!d0) await sleep(300); }
      check('start: without a landing page the blank world starts with the sign-in dialog open', d0 !== null, d0);
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
    // The identicon is the one the menu bar and the home page show: seeded by the DID, so two identities differ and a rename keeps it.
    const want = await frame.evaluate(() => { return new Promise((res) => lively.identity.localIdentity.list((e, ids) => res(ids.map((i) => ({ label: i.label, url: lively.identity.postCardUtils.identiconDataUrl(i.did, 28) }))))); });
    check('dialog: each identity shows its identicon next to the label', st && st.avatars.length === 2 && new Set(st.avatars).size === 2 && st.buttons.every((l, i) => (want.find((w) => w.label === l) || {}).url === st.avatars[i]), { avatars: st && st.avatars.map((a) => String(a).slice(0, 40)), want: want.map((w) => w.url.slice(0, 40)) });
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
    // Which step fails when the marker is missing later: the save (the stored page has no marker) or the load (it has).
    const stored = await keoCall(frame, 'world.load', { name: 'first' });
    check('setup: the stored page holds the marker morph', stored.ok && /gate-marker/.test(String(stored.r && stored.r.doc)), { ok: stored.ok, len: stored.r && String(stored.r.doc).length });
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
    // The saved world's morphs are made while the page finishes starting: wait for the marker, and say how long it took.
    const sw = await frame.evaluate(async () => {
      const t0 = Date.now();
      while (!$world.get('gate-marker') && Date.now() - t0 < 15000) await new Promise((r) => setTimeout(r, 200));
      const script = document.querySelector('script[type="text/x-lively-world"]');
      const d = String(keo.init.startup.doc), at = d.indexOf('x-lively-world');
      const parsed = new DOMParser().parseFromString(d, 'text/html').querySelector('script[type="text/x-lively-world"]');
      const docShape = { len: d.length, worldScriptAt: at, parserFindsIt: !!parsed, parsedLen: parsed ? parsed.textContent.length : -1, scripts: (d.match(/<script/g) || []).length,
        head: d.slice(0, 120), around: at >= 0 ? d.slice(Math.max(0, at - 60), at + 120) : null, tail: d.slice(-120) };
      const texts = []; (function walk(m) { if (m.textString && texts.length < 12) texts.push(String(m.textString).slice(0, 40)); (m.submorphs || []).forEach(walk); })($world);
      return { name: keo.init.startup.name, label: keo.init.startup.session.label, marker: !!$world.get('gate-marker'), docHasMarker: /gate-marker/.test(String(keo.init.startup.doc)), docLen: String(keo.init.startup.doc).length,
        pageScriptHasMarker: !!script && /gate-marker/.test(script.textContent), pageScriptLen: script ? script.textContent.length : -1, readyState: document.readyState,
        docShape, waitedMs: Date.now() - t0, morphs: $world.submorphs.length, names: $world.submorphs.map((m) => m.name || m.constructor.type || '?'), texts };
    });
    sw.keoWarnings = warns.slice();
    console.log('INFO saved world: marker after ' + sw.waitedMs + ' ms, ' + sw.morphs + ' top-level morphs');
    console.log('INFO doc handed to the world: ' + JSON.stringify(Object.assign({}, sw.docShape, { head: undefined, around: undefined, tail: undefined })));
    if (!sw.marker) console.log('INFO marker missing, full state: ' + JSON.stringify(sw));
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

    // ---- 7. the same from the page the shell starts when nobody is signed in (the landing page, or the blank world with the dialog open)
    await frame.evaluate(() => { lively.identity.localIdentity.signOut(function () {}); });
    await sleep(1500);
    await openShell(page, '');
    frame = await waitForWorld(page, 'gate');
    if (gateWorld) await openLogin(frame);
    st = await waitDialog(frame, 3);
    check('start page: the dialog lists the three identities', st && st.buttons.slice().sort().join() === 'Maya,Noor,Ola', st);
    await page.screenshot({ path: path.join(WORK, 'gate-landing.png') });
    const c4 = await creds(page);
    await clickNamed(frame, 'identityBtn', st.buttons.indexOf('Noor'));
    frame = await waitForWorld(page, 'world');
    check('start page: one prompt, then the world Noor saved last', delta(c4, await creds(page)) === '{"create":0,"get":1}' && (await frame.evaluate(() => keo.init.startup.name)) === 'first', await creds(page));
    // a refresh keeps the session: it must not start the sign-in again
    await page.reload();
    frame = await waitForWorld(page, 'world');
    check('start page: a refresh goes straight back in, with no prompt', (await creds(page)).get === 0 && (await keoCall(frame, 'session.current')).r.label === 'Noor', await creds(page));

    // The landing page is the user's own world; it embeds a video player and a map that want location, which the extension's policy blocks, and a refresh asks to confirm.
    // The refresh in section 7 asks to confirm leaving a world that has unsaved changes (any package), and the landing page adds the rest.
    const mine = errors.filter((e) => !(/beforeunload/.test(e) || (gateWorld && /youtube\.com|Geolocation access/.test(e))));
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
