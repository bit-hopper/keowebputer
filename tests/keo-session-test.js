// End-to-end test of the sign-in screen, the session and saved worlds in the built keo extension.
// Usage: node keo-session-test.js <repo root> <extension folder> <work dir>
// A headed browser with the extension loaded, `localhost` unresolvable, and a CDP virtual authenticator with PRF. It drives the
// real sign-in screen: create an identity (lands on the home page), start a blank world, save it, reload the page (the shell
// forgets the session, the storage stays), sign in again (lands on the saved world), look at what is stored on disk, sign
// out, and break a saved record on purpose.
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
    check('new identity: the gate is gone and the bar says who is signed in', await page.evaluate(() => document.getElementById('gate').classList.contains('hidden') && /Maya/.test(document.getElementById('status').textContent)));
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
      const H = await window.keoDid.eventHash(cert);
      return { verifies: await window.keoDid.verifyAssertion({ keyId: cert.authorityKeyId, authenticatorData: assertion.authenticatorData, clientDataJSON: assertion.clientDataJSON, signature: assertion.signature }, key.jwk, H),
        deviceKeyIsOurs: JSON.stringify(cert.devicePubKeyJwk) === JSON.stringify(rec.deviceKey.publicJwk), exp: Date.parse(cert.exp) > Date.now() };
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

    // ---- 7. reload the page: the session is gone, the storage is not; sign in lands on the saved world
    await page.reload();
    await sleep(1500);
    check('reload: back at the gate, no session', await page.evaluate(async () => !document.getElementById('gate').classList.contains('hidden') && (await window.keoIdentity.current()) === null));
    check('reload: the identity is offered by its label', await page.evaluate(() => /Maya/.test(document.getElementById('idlist').textContent)));
    const locked = await page.evaluate(() => window.keoWorlds.list().then(() => 'listed', (e) => e.message));
    check('reload: saved worlds cannot be read while signed out', /Sign in/.test(locked), locked);
    await page.click('#idlist button');
    frame = await waitForWorld(page, 'world');
    const st2 = await frame.evaluate(() => window.keo.init.startup);
    check('returning: the world starts as the last saved one', st2.kind === 'world' && st2.name === 'mine', { kind: st2.kind, name: st2.name });
    const marker = await frame.evaluate(() => { const m = $world.get('keo-marker-secret'); return m ? { x: m.getPosition().x, y: m.getPosition().y } : null; });
    check('returning: the morph is there, where the second save left it', marker && Math.round(marker.x) === 300 && Math.round(marker.y) === 200, marker);
    await page.screenshot({ path: path.join(WORK, 'session-returning.png') });

    // ---- 8. sign out
    await page.click('#signout');
    await sleep(1500);
    check('sign out: back at the gate with no session and no world', await page.evaluate(async () => !document.getElementById('gate').classList.contains('hidden') && (await window.keoIdentity.current()) === null) && !worldFrame(page));

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
