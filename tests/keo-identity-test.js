// End-to-end test of local identities in the built keo extension.
// Usage: node keo-identity-test.js <repo root> <extension folder> <work dir>
// A headed browser with the extension loaded, `localhost` unresolvable (so any request that needed the dev server fails),
// and a CDP virtual authenticator with PRF. The world asks the shell to create identities through the real bridge; the
// shell page's own IndexedDB is then read directly to check what was stored, and the stored inception is verified with
// keo-did.js, which needs nothing but the event.
const fs = require('fs');
const path = require('path');
const { REPO, EXT, WORK } = require('./args.js')();
const { chromium } = require(path.join(REPO, 'node_modules', 'playwright-core'));
const ID = 'keoapnoighmdpncpbfffhcdgdjgjmpdn';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = {};
function check(name, ok, detail) { results[name] = { ok: !!ok, detail }; console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail && !ok ? '  -> ' + JSON.stringify(detail).slice(0, 700) : '')); }

async function launch(profile) {
  const ctx = await chromium.launchPersistentContext(path.join(WORK, profile), {
    headless: false, viewport: { width: 1280, height: 860 },
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--host-resolver-rules=MAP localhost ~NOTFOUND, MAP 127.0.0.1 ~NOTFOUND'] });
  await sleep(2500);
  return ctx;
}
async function waitForWorld(page) {
  let frame = null;
  for (let i = 0; i < 100 && !frame; i++) { frame = page.frames().find((f) => /world\.html$/.test(f.url())); if (!frame) await sleep(200); }
  for (let i = 0; i < 150; i++) { try { if (await frame.evaluate(() => !!(window.$world && window.$world.submorphs && window.keo && window.keo.init))) break; } catch (e) {} await sleep(300); }
  await sleep(1500);
  return frame;
}

(async () => {
  fs.mkdirSync(WORK, { recursive: true });
  const ctx = await launch('profile-identity');
  try {
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push('PAGEERROR ' + e.message.slice(0, 200)));
    page.on('console', (m) => { if (m.type() === 'error' && !/compute-pressure/.test(m.text())) errors.push('console: ' + m.text().slice(0, 200) + ' @' + (m.location() && m.location().url || '')); });
    const cdp = await ctx.newCDPSession(page);
    await cdp.send('WebAuthn.enable', { enableUI: false });
    await cdp.send('WebAuthn.addVirtualAuthenticator', { options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true,
      hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true, hasPrf: true } });
    await page.goto(`chrome-extension://${ID}/start.html#guest`);
    let frame = await waitForWorld(page);

    // ---- create through the bridge, from the world (the module loads on demand, as RegisterDialog's requires would)
    await frame.evaluate(() => new Promise((res) => lively.require('lively.identity.LocalIdentity').toRun(res)));
    const created = await frame.evaluate(() => new Promise((res) => {
      const t0 = Date.now();
      lively.identity.localIdentity.create('Alice laptop', (e, r) => res({ err: e && (e.name + ': ' + e.message), r: r, ms: Date.now() - t0, available: lively.identity.localIdentity.isAvailable() }));
    }));
    check('create: the world sees the shell (isAvailable)', created.available === true, created);
    check('create: succeeds', !created.err && created.r && created.r.did, created);
    const A = created.r || {};
    check('create: signs the new identity in (no third prompt)', !!(A.session && A.session.did === A.did && A.session.cert && A.session.cert.via === 'inception'), A.session);
    await page.evaluate(() => window.keoIdentity.signOut());
    check('create: the DID is did:keo:<52 z32>:<43 b64url>', /^did:keo:[ybndrfg8ejkmcpqxot1uwisza345h769]{52}:[A-Za-z0-9_-]{43}$/.test(A.did), A.did);
    check('create: label, rpId and the not-recoverable flag', A.label === 'Alice laptop' && A.rpId === 'chrome-extension://' + ID && A.notRecoverable === true && A.authorityKeys === 1, A);
    check('create: PRF output came back at creation (virtual authenticator)', A.prfAtCreate === true, A);
    check('create: the summary carries no key material', !/"(d|k|privateKey|seed|secret)"/.test(JSON.stringify(A)), A);

    // ---- what the shell stored (read straight from the shell page's own IndexedDB)
    const stored = await page.evaluate(async (did) => {
      const kd = window.keoDid;
      const rec = await new Promise((res, rej) => { const q = indexedDB.open('keo-identities'); q.onsuccess = () => { const r = q.result.transaction('identities').objectStore('identities').get(did); r.onsuccess = () => { q.result.close(); res(r.result); }; r.onerror = () => rej(r.error); }; q.onerror = () => rej(q.error); });
      if (!rec) return { missing: true };
      const v = await kd.verifyInception({ inception: rec.inception, sigs: rec.sigs });
      const parsed = kd.parseDid(rec.did);
      const publicPart = JSON.stringify({ inception: rec.inception, sigs: rec.sigs });
      return {
        verify: v, parsed, hashMatches: parsed && parsed.h === kd.b64u(await kd.eventHash(rec.inception)),
        dkMatches: parsed && parsed.dk === rec.inception.state.discovery.key,
        next: rec.inception.state.next, threshold: rec.inception.state.authority.threshold,
        keyRpId: rec.inception.state.authority.keys[0].rpId, keyIdIsCredential: rec.inception.state.authority.keys[0].id === rec.credentialId,
        deviceExtractable: rec.deviceKey.privateKey.extractable, deviceType: rec.deviceKey.privateKey.type,
        discType: rec.discoveryKey.type, discAlg: rec.discoveryKey.algorithm.name, discExtractable: rec.discoveryKey.extractable,
        wrappedLen: kd.unb64u(rec.wrappedAccountSecret).length,
        // which string did the authenticator hash as the rpId? (authenticatorData bytes 0-31 are SHA-256(rpId))
        rpIdHashOf: await (async () => {
          const ad = kd.unb64u(rec.sigs.authority[0].authenticatorData).slice(0, 32), h = async (s) => kd.b64u(await kd.sha256(new TextEncoder().encode(s)));
          const got = kd.b64u(ad);
          return { hostname: got === await h(location.hostname), origin: got === await h(location.origin), hostnameStr: location.hostname, originStr: location.origin };
        })(),
        publicHasPrivateMember: /"d":/.test(publicPart),
        noHandle: JSON.stringify(rec.inception.state.claims.handles) === '[]',
        label: rec.label
      };
    }, A.did);
    check('stored: the inception verifies with nothing but itself, and defines this DID', stored.verify && stored.verify.ok && stored.verify.did === A.did, stored.verify);
    check('stored: the DID parts match the event (hash, discovery key)', stored.hashMatches === true && stored.dkMatches === true, stored);
    check('stored: next is null, threshold 1, authority bound to the extension origin (the rpId the browser uses)', stored.next === null && stored.threshold === 1 && stored.keyRpId === 'chrome-extension://' + ID && stored.keyIdIsCredential, stored);
    check('stored: the recorded rpId is the one the authenticator hashed', stored.rpIdHashOf && stored.rpIdHashOf.origin === true && stored.keyRpId === stored.rpIdHashOf.originStr, stored.rpIdHashOf);
    console.log('INFO rpIdHash of the stored assertion: ' + JSON.stringify(stored.rpIdHashOf) + '  recorded rpId: ' + stored.keyRpId);
    check('stored: no handle in the log', stored.noHandle === true, stored);
    check('stored: device key and discovery key are non-extractable', stored.deviceExtractable === false && stored.deviceType === 'private' && stored.discType === 'private' && stored.discAlg === 'Ed25519' && stored.discExtractable === false, stored);
    check('stored: wrapped account secret is 40 bytes (AES-KW of 32)', stored.wrappedLen === 40, stored);
    check('stored: the public part (inception + sigs) has no private member', stored.publicHasPrivateMember === false, stored);

    // ---- list, rename, sign in
    const l1 = await frame.evaluate(() => new Promise((res) => lively.identity.localIdentity.list((e, r) => res(e ? { err: e.message } : r))));
    check('list: one identity, same DID', Array.isArray(l1) && l1.length === 1 && l1[0].did === A.did, l1);
    const ren = await frame.evaluate((did) => new Promise((res) => lively.identity.localIdentity.rename(did, '  Work   laptop  ', (e, r) => res(e ? { err: e.message } : r))), A.did);
    check('rename: the label is the user\'s to change (whitespace tidied), the DID is not', ren.label === 'Work laptop' && ren.did === A.did, ren);
    const noSuch = await frame.evaluate(() => new Promise((res) => lively.identity.localIdentity.signIn('did:keo:nope', (e, r) => res(e ? e.message : 'no error'))));
    check('signIn: an unknown DID is an error, not a ceremony', /No such identity/.test(noSuch), noSuch);
    const si = await frame.evaluate((did) => new Promise((res) => lively.identity.localIdentity.signIn(did, (e, r) => res(e ? { err: e.name + ': ' + e.message } : r))), A.did);
    check('signIn: assertion origin is the extension, secret unlocks non-extractable', !si.err && si.assertionOrigin === 'chrome-extension://' + ID && si.secretNonExtractable === true && si.label === 'Work laptop', si);

    // ---- the same after a page reload (storage lives in the shell, not the page)
    await page.evaluate(() => window.keoIdentity.signOut());     // a refresh keeps a session, so end it to see sign-in from scratch
    await page.reload();
    frame = await waitForWorld(page);
    await frame.evaluate(() => new Promise((res) => lively.require('lively.identity.LocalIdentity').toRun(res)));
    const l2 = await frame.evaluate(() => new Promise((res) => lively.identity.localIdentity.list((e, r) => res(e ? { err: e.message } : r))));
    check('reload: the identity and its renamed label are still there', Array.isArray(l2) && l2.length === 1 && l2[0].did === A.did && l2[0].label === 'Work laptop', l2);
    const si2 = await frame.evaluate((did) => new Promise((res) => lively.identity.localIdentity.signIn(did, (e, r) => res(e ? { err: e.name + ': ' + e.message } : r))), A.did);
    check('reload: signing in again works', !si2.err && si2.secretNonExtractable === true, si2);

    // ---- two at once: the second is refused, not interleaved
    const both = await frame.evaluate(() => {
      const one = () => new Promise((res) => lively.identity.localIdentity.create('Race', (e, r) => res(e ? e.message : 'ok')));
      return Promise.all([one(), one()]);
    });
    check('create: a second create while one is running is refused', both.filter((x) => x === 'ok').length === 1 && both.some((x) => /already being created/.test(x)), both);

    // ---- the real dialog, in keo: local form, then create
    await frame.evaluate(() => lively.LocalStorage.set(lively.identity.PasskeyPrimingDialog ? lively.identity.PasskeyPrimingDialog.SKIP_FLAG_KEY : 'identity-skip-passkey-priming', true));
    const dlg = await frame.evaluate(() => new Promise((res) => {
      lively.require('lively.identity.RegisterDialog').toRun(() => {
        lively.LocalStorage.set(lively.identity.PasskeyPrimingDialog.SKIP_FLAG_KEY, true);
        const d = lively.BuildSpec('lively.identity.RegisterDialog').createMorph();
        d.openInWorldCenter();
        window.__dlg = d;
        setTimeout(() => res({ local: d._isLocal, hasLabel: !!d.get('labelInput'), hasHandle: !!d.get('handleInput'), btn: d.get('registerBtn') && d.get('registerBtn').getLabel && d.get('registerBtn').getLabel(), title: d.getTitle && d.getTitle() }), 500);
      });
    }));
    check('dialog: inside keo it shows the local form (a label, no handle)', dlg.local === true && dlg.hasLabel === true && dlg.hasHandle === false, dlg);
    await page.screenshot({ path: path.join(WORK, 'identity-dialog-form.png') });
    await frame.evaluate(() => { window.__dlg.get('labelInput').setTextString('Dialog made'); window.__dlg.register(); });
    let status = '';
    for (let i = 0; i < 40; i++) { await sleep(500); status = await frame.evaluate(() => window.__dlg.get('statusText').textString); if (/Created|Could not/.test(status)) break; }
    check('dialog: creating through it reports the identity on this device', /^Created Dialog made \(keo:[A-Za-z0-9_-]{4}…[A-Za-z0-9_-]{4}\) on this device\./.test(status) && /Not recoverable yet/.test(status), status);
    await page.screenshot({ path: path.join(WORK, 'identity-dialog-created.png') });
    const l3 = await frame.evaluate(() => new Promise((res) => lively.identity.localIdentity.list((e, r) => res(e ? { err: e.message } : r))));
    check('list: three identities with distinct DIDs and distinct discovery keys', Array.isArray(l3) && l3.length === 3 && new Set(l3.map((x) => x.did)).size === 3 && new Set(l3.map((x) => x.did.split(':')[2])).size === 3, l3);
    const labels = (l3 || []).map((x) => x.label).sort();
    check('list: labels are as given (Work laptop, Race, Dialog made)', JSON.stringify(labels) === JSON.stringify(['Dialog made', 'Race', 'Work laptop']), labels);

    // ---- remove one (not the signed-in one: removing that signs out and reloads, which the session test covers). The world only
    // asks; the shell page puts the question to the person, and the identity stays until a real click says Remove.
    const sess = await page.evaluate(() => window.keoIdentity.current());
    const victim = l3.find((x) => !sess || x.did !== sess.did);
    const asked = frame.evaluate((did) => new Promise((res) => lively.identity.localIdentity.remove(did, (e) => lively.identity.localIdentity.list((e2, r) => res({ err: e && e.message, list: r })))), victim.did);
    await page.waitForSelector('#keo-confirm:not([hidden])', { timeout: 10000 });
    await page.click('#keo-confirm button[data-ans="yes"]');
    const gone = await asked;
    check('remove: only the record on this device goes, after the person confirms', !gone.err && gone.list.length === 2 && !gone.list.some((x) => x.did === victim.did), gone);

    // ---- nothing needed the network
    const unexpected = errors.filter((e) => !/IdentityServer\/session/.test(e));
    check('no page errors', unexpected.length === 0, unexpected);
  } finally { await ctx.close(); }
  fs.writeFileSync(path.join(WORK, 'keo-identity-test.json'), JSON.stringify(results, null, 2));
  const failed = Object.keys(results).filter((k) => !results[k].ok);
  console.log(failed.length ? 'FAILED: ' + failed.length : 'ALL PASSED (' + Object.keys(results).length + ')');
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.log('FATAL', e); process.exit(2); });
