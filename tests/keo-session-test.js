// End-to-end test of the sign-in screen, the session and saved worlds in the built keo extension.
// Usage: node keo-session-test.js <repo root> <extension folder> <work dir>
// A headed browser with the extension loaded, `localhost` unresolvable, and a CDP virtual authenticator with PRF. It drives the
// real sign-in screen: create an identity (two passkey prompts, lands on the home page), check the menu bar and the ambient panel
// see the session, start a blank world and save it, refresh the tab (the session comes back with no prompt), look at what is
// stored on disk, sign out from the world, sign in again (lands on the saved world), and break a saved record on purpose.
// NOT covered: a browser RESTART (a virtual authenticator does not survive one, so its passkey is gone), and a real
// authenticator. Those need keo-identity-real.js-style runs by a person.
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
async function waitForWorld(page, kind) {
  let frame = null;
  for (let i = 0; i < 200; i++) {
    frame = worldFrame(page);
    if (frame) {
      try { if (await frame.evaluate((k) => !!(window.$world && window.$world.submorphs && window.keo && window.keo.init && window.keo.init.startup && window.keo.init.startup.kind === k), kind)) break; } catch (e) {}
    }
    frame = null; await sleep(300);
  }
  if (!frame) {
    const f = worldFrame(page);
    const state = f ? await f.evaluate(() => ({ kind: window.keo && keo.init && keo.init.startup && keo.init.startup.kind, world: !!window.$world, sub: !!(window.$world && window.$world.submorphs) })).catch((e) => 'eval failed: ' + e.message.slice(0, 80)) : 'no world frame';
    throw new Error('the world did not start as ' + kind + ' (frames: ' + page.frames().map((x) => x.url().slice(-20)).join(', ') + '; state: ' + JSON.stringify(state) + ')');
  }
  await sleep(2500);       // the page-specific setup (home page, menu) runs after the world is up
  return frame;
}
const keoCall = (frame, op, args) => frame.evaluate(([o, a]) => window.keo.call(o, a, 60000).then((r) => ({ ok: true, r }), (e) => ({ ok: false, e: e.message })), [op, args || {}]);

(async () => {
  fs.mkdirSync(WORK, { recursive: true });
  const ctx = await chromium.launchPersistentContext(path.join(WORK, 'profile-session'), {
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

    // ---- 1. the gate: nothing runs until someone chooses
    await page.goto(`chrome-extension://${ID}/start.html`);
    await sleep(1500);
    check('gate: the sign-in screen is showing', await page.evaluate(() => !document.getElementById('gate').classList.contains('hidden')));
    check('gate: no world has been started', !worldFrame(page));
    check('gate: no identity yet, so no sign-in list', await page.evaluate(() => document.getElementById('signinbox').hidden));

    // ---- 2. a new identity lands on the home page
    await page.fill('#label', 'Maya');
    await page.click('#create');
    let frame = await waitForWorld(page, 'homestar');
    const st = await frame.evaluate(() => window.keo.init.startup);
    check('new identity: the world starts as the home page', st.kind === 'homestar' && st.session && st.session.label === 'Maya', st);
    const did = st.session.did;
    check('new identity: two passkey prompts (create, sign the inception), not three', JSON.stringify(await page.evaluate(() => window.__cred)) === '{"create":1,"get":1}', await page.evaluate(() => window.__cred));
    check('new identity: the gate is gone and there is no top bar (the world has the whole page)', await page.evaluate(() => document.getElementById('gate').classList.contains('hidden') && !document.getElementById('bar') && document.getElementById('world').getBoundingClientRect().height >= innerHeight - 1));
    const menu = await frame.evaluate(() => {
      const did = lively.identity.did, bar = $world.get(/MenuBar/), entry = $world.get('IdentityMenuBarEntry') || (bar && bar.submorphs.filter((m) => m.name === 'IdentityMenuBarEntry')[0]);
      const items = entry ? entry.morphMenuItems().map((i) => i[0]) : null;
      const panel = lively.identity.AmbientPresencePanel && lively.identity.AmbientPresencePanel._panel;
      return { loggedIn: did.isLoggedIn(), label: did.handleLabel(), entryText: entry && entry.textString, items, ambient: !!(panel && panel.world && panel.world()), local: did.currentUser() && did.currentUser().local };
    });
    check('menu bar: the world knows it is signed in, and shows the label (not a handle, not the DID)', menu.loggedIn && menu.local && menu.label === 'Maya' && menu.entryText === 'Maya', menu);
    check('menu bar: the menu has a short DID line, Copy DID, My homestar, Rename, Sign out', menu.items && /^keo:.{4}….{4}/.test(menu.items[0]) && menu.items.includes('Copy DID') && menu.items.includes('My homestar') && menu.items.includes('Sign out'), menu.items);
    check('ambient panel: it is open for the signed-in identity', menu.ambient === true, menu);
    await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: 'chrome-extension://' + ID }).catch(() => {});
    const copied = await frame.evaluate(() => new Promise((res) => lively.identity.localIdentity.copyText(lively.identity.did.currentUser().did, res)));
    const clip = await page.evaluate(() => navigator.clipboard.readText().catch((e) => 'ERR ' + e.message));
    check('copy DID: the full DID is on the clipboard', copied === true && clip === did, { copied, clip: String(clip).slice(0, 80) });
    const text = await frame.evaluate(() => { const out = []; (function walk(m) { if (m.textString) out.push(String(m.textString)); (m.submorphs || []).forEach(walk); })($world); return out.join(' | '); });
    check('new identity: the home page shows the label', /Maya/.test(text), text.slice(0, 300));
    await page.screenshot({ path: path.join(WORK, 'session-homestar.png') });

    // ---- 3. the session
    const cur = await keoCall(frame, 'session.current');
    check('session: the world can read it', cur.ok && cur.r && cur.r.did === did && cur.r.cert && cur.r.cert.aud === 'chrome-extension://' + ID, cur);
    const certOk = await page.evaluate(async () => {
      const s = await window.keoIdentity.current();
      const rec = await new Promise((res, rej) => { const q = indexedDB.open('keo-identities'); q.onsuccess = () => { const r = q.result.transaction('identities').objectStore('identities').get(s.did); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }; q.onerror = () => rej(q.error); });
      const cert = Object.assign({}, s.cert); const assertion = cert.assertion; delete cert.assertion;
      const key = rec.inception.state.authority.keys.filter((k) => k.id === cert.authorityKeyId)[0];
      // A session made by creating the identity is delegated by the inception itself: the device key must be listed in the
      // verified inception, and the assertion is the authority's signature over H(inception). A later sign-in signs H(cert).
      const viaInception = cert.via === 'inception';
      const H = await window.keoDid.eventHash(viaInception ? rec.inception : cert);
      const listed = !viaInception || rec.inception.state.devices.some((d) => JSON.stringify(d.jwk) === JSON.stringify({ kty: cert.devicePubKeyJwk.kty, crv: cert.devicePubKeyJwk.crv, x: cert.devicePubKeyJwk.x, y: cert.devicePubKeyJwk.y }));
      return { verifies: await window.keoDid.verifyAssertion({ keyId: cert.authorityKeyId, authenticatorData: assertion.authenticatorData, clientDataJSON: assertion.clientDataJSON, signature: assertion.signature }, key.jwk, H),
        deviceKeyIsOurs: JSON.stringify(cert.devicePubKeyJwk) === JSON.stringify(rec.deviceKey.publicJwk) && listed, via: cert.via || 'cert', exp: Date.parse(cert.exp) > Date.now() };
    });
    check('session: the delegation certificate is signed by the identity\'s own passkey over H(cert)', certOk.verifies && certOk.deviceKeyIsOurs && certOk.exp, certOk);
    const swap = await keoCall(frame, 'identity.signIn', { did });
    check('session: the world cannot sign in as someone else while a session exists', !swap.ok && /Already signed in/.test(swap.e), swap);
    const keyLeak = JSON.stringify(cur.r);
    check('session: nothing the world can read is a key', !/"(d|k|privateKey|seed|secret|worldKey)"/.test(keyLeak));

    // ---- 4. the home page cannot be saved as a world
    const homeSave = await frame.evaluate(() => new Promise((res) => $world.saveWorldAs(URL.root.withFilename('home.html'), false, undefined, (e) => res(e ? e.message : 'saved'))));
    check('save: the home page refuses to be saved', /home page/.test(homeSave), homeSave);
    check('save: nothing was stored', (await keoCall(frame, 'world.list')).r.length === 0);

    // ---- 4b. a theme chosen on the home page (world menu > Preferences > Themes) is kept for the identity
    await frame.evaluate(() => new Promise((res) => lively.require('lively.morphic.Themes').toRun(() => { lively.morphic.Themes.apply('savanna', $world); res(); })));
    await sleep(1500);
    check('home theme: the world menu offers the themes', await frame.evaluate(() => { const items = $world.morphMenuItems(); const find = (l) => { for (const i of l) { if (Array.isArray(i[1]) && /Preferences/.test(i[0])) return i[1]; } return null; }; const prefs = find(items); return !!prefs && prefs.some((i) => i[0] === 'Themes'); }));
    await page.reload();
    frame = await waitForWorld(page, 'homestar');
    await sleep(2500);
    const th = await frame.evaluate(() => $world.themeName);
    check('home theme: it is applied again when the home page is rebuilt after a refresh', th === 'savanna', th);
    await frame.evaluate(() => new Promise((res) => { lively.morphic.Themes.clear($world); res(); }));
    await sleep(1000);
    await page.reload();
    frame = await waitForWorld(page, 'homestar');
    await sleep(2500);
    check('home theme: clearing it sticks too', (await frame.evaluate(() => $world.themeName)) === undefined);

    // ---- 5. a blank world, saved
    const goRes = await keoCall(frame, 'world.go', { kind: 'blank' }).catch((e) => ({ navigated: e.message.slice(0, 80) }));
    console.log('INFO go blank ->', JSON.stringify(goRes));
    frame = await waitForWorld(page, 'blank');
    check('go: the world restarted blank, still signed in', (await keoCall(frame, 'session.current')).r.did === did);
    await frame.evaluate(() => { const m = new lively.morphic.Box(lively.rect(40, 80, 90, 60)); m.setName('keo-marker-secret'); m.setFill(Color.red); $world.addMorph(m); });
    const saved = await frame.evaluate(() => new Promise((res) => $world.saveWorldAs(URL.root.withFilename('mine.html'), false, undefined, (e) => res(e ? { err: e.message } : { ok: true }))));
    check('save: a world saved under a name', saved.ok === true, saved);
    const l1 = (await keoCall(frame, 'world.list')).r;
    check('save: it is listed, and it is the last one', l1.length === 1 && l1[0].name === 'mine' && l1[0].last === true && l1[0].bytes > 1000, l1);
    await frame.evaluate(() => $world.get('keo-marker-secret').setPosition(lively.pt(300, 200)));
    const saved2 = await frame.evaluate(() => new Promise((res) => $world.saveWorld((e) => res(e ? { err: e.message } : { ok: true }))));
    const l2 = (await keoCall(frame, 'world.list')).r;
    check('save: saving again replaces the world of that name (not a second copy)', saved2.ok === true && l2.length === 1 && l2[0].name === 'mine', { saved2, l2 });

    // ---- 6. what is on disk is not readable
    const disk = await page.evaluate(async () => {
      const db = await new Promise((res, rej) => { const q = indexedDB.open('keo-worlds'); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); });
      const all = (s) => new Promise((res) => { const r = db.transaction(s).objectStore(s).getAll(); r.onsuccess = () => res(r.result); });
      const bodies = await all('bodies'), index = await all('index'); db.close();
      const hay = (recs) => recs.map((r) => String.fromCharCode.apply(null, new Uint8Array(r.ct).subarray(0, 4e6))).join('');
      return { nBodies: bodies.length, nIndex: index.length, bodyHasMarker: /keo-marker-secret|lively\.morphic/.test(hay(bodies)), indexHasName: /mine/.test(hay(index) + JSON.stringify(index.map((r) => ({ did: r.did, iv: r.iv })))), bodySize: bodies[0] && bodies[0].ct.byteLength };
    });
    check('disk: one body and one index record', disk.nBodies === 1 && disk.nIndex === 1, disk);
    check('disk: the saved world is ciphertext (no morph names or class names in it)', disk.bodyHasMarker === false && disk.bodySize > 1000, disk);
    check('disk: the world\'s name is not readable either', disk.indexHasName === false, disk);

    // ---- 7. refresh the tab: the session comes back with no prompt, on the world saved last
    await page.reload();
    frame = await waitForWorld(page, 'world');
    const st2 = await frame.evaluate(() => window.keo.init.startup);
    check('refresh: the session survives, with no passkey prompt', JSON.stringify(await page.evaluate(() => window.__cred)) === '{"create":0,"get":0}' && st2.session && st2.session.did === did, await page.evaluate(() => window.__cred));
    check('refresh: it lands on the world saved last', st2.kind === 'world' && st2.name === 'mine', { kind: st2.kind, name: st2.name });
    const marker = await frame.evaluate(() => { const m = $world.get('keo-marker-secret'); return m ? { x: m.getPosition().x, y: m.getPosition().y } : null; });
    check('refresh: the morph is there, where the second save left it', marker && Math.round(marker.x) === 300 && Math.round(marker.y) === 200, marker);
    const rec = await page.evaluate(async () => { const db = await new Promise((res, rej) => { const q = indexedDB.open('keo-session'); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); }); const r = await new Promise((res) => { const g = db.transaction('s').objectStore('s').getAll(); g.onsuccess = () => res(g.result); }); db.close(); return r.map((x) => ({ extractable: x.worldKey && x.worldKey.extractable, seenAgo: Date.now() - x.seen })); });
    check('refresh: what is kept for it is one non-extractable key, seen recently', rec.length === 1 && rec[0].extractable === false && rec[0].seenAgo < 60000, rec);
    await page.screenshot({ path: path.join(WORK, 'session-returning.png') });
    const other = await ctx.newPage();
    await other.goto('chrome-extension://' + ID + '/start.html');
    await sleep(1500);
    check('another tab does not pick the session up: it shows the sign-in screen', await other.evaluate(() => !document.getElementById('gate').classList.contains('hidden') && /Maya/.test(document.getElementById('idlist').textContent)));
    await other.close();
    await page.bringToFront();

    // ---- 8. sign out
    await frame.evaluate(() => { lively.identity.localIdentity.signOut(function () {}); });
    await sleep(2500);
    check('sign out (asked by the world): back at the gate with no session and no world', await page.evaluate(async () => !document.getElementById('gate').classList.contains('hidden') && (await window.keoIdentity.current()) === null) && !worldFrame(page));

    // ---- 9. a broken record must not lock the person out
    await page.evaluate(async () => {
      const db = await new Promise((res, rej) => { const q = indexedDB.open('keo-worlds'); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); });
      await new Promise((res) => { const t = db.transaction('bodies', 'readwrite'), s = t.objectStore('bodies'), g = s.getAll();
        g.onsuccess = () => { const r = g.result[0]; const ct = new Uint8Array(r.ct); ct[100] ^= 1; r.ct = ct; s.put(r); }; t.oncomplete = res; });
      db.close();
    });
    await page.click('#idlist button');
    frame = await waitForWorld(page, 'homestar');
    const st3 = await frame.evaluate(() => window.keo.init.startup);
    check('tamper: a changed body is refused, the person lands on the home page with a warning', st3.kind === 'homestar' && /could not be opened/.test(st3.warning || ''), st3.warning);

    // ---- 10. guest: nothing is saved under a name
    const g = await ctx.newPage();
    await g.goto(`chrome-extension://${ID}/start.html#guest`);
    const gf = await waitForWorld(g, 'guest');
    const gs = await keoCall(gf, 'world.save', { name: 'x', doc: '<html></html>' });
    check('guest: saving needs a session', !gs.ok && /Sign in/.test(gs.e), gs);
    await g.close();

    // ---- 11. removing the identity removes what it saved
    await page.bringToFront();
    const rm = await keoCall(frame, 'identity.remove', { did });
    const left = await page.evaluate(async () => {
      const db = await new Promise((res, rej) => { const q = indexedDB.open('keo-worlds'); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); });
      const n = (s) => new Promise((res) => { const r = db.transaction(s).objectStore(s).count(); r.onsuccess = () => res(r.result); });
      const out = { bodies: await n('bodies'), index: await n('index') }; db.close(); return out;
    });
    check('remove: the identity and its saved worlds are gone', rm.ok && left.bodies === 0 && left.index === 0, { rm, left });

    check('no page errors', errors.length === 0, errors.slice(0, 5));
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
