// Local identities against a REAL authenticator. A person must approve the OS prompts.
// Usage: node keo-identity-real.js <repo root> <extension folder> <work dir>
// Same flow as keo-identity-test.js but with no virtual authenticator, so whatever the OS offers (the OS's built-in passkey provider, a security
// key, a phone) answers. Prompts, in order:
//   1 + 2  create: make the passkey, then sign the inception with it (the second follows the first immediately)
//   3      sign in
//   4      sign in again after a page reload
// Every step is announced BEFORE it starts, with a timestamp, so the person knows a prompt is coming. A failure is reported
// with the error's name and message and the script carries on where it can: NotAllowedError means the prompt was dismissed,
// timed out, or the browser/OS refused (an environment problem can look the same: check it before suspecting the code).
// The passkey it creates stays in the authenticator (a web page cannot delete one): remove "Real authenticator test" for
// the extension id in your OS passkey settings if it is not wanted.
const fs = require('fs');
const path = require('path');
const { REPO, EXT, WORK } = require('./args.js')();
const { chromium } = require(path.join(REPO, 'node_modules', 'playwright-core'));
const ID = 'cgjphijackijgcjkfdfieihkbfooigjp';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => new Date().toLocaleTimeString();
const say = (m) => console.log('[' + now() + '] ' + m);
const results = {};
function check(name, ok, detail) { results[name] = { ok: !!ok, detail }; say((ok ? 'PASS ' : 'FAIL ') + name + (detail && !ok ? '  -> ' + JSON.stringify(detail).slice(0, 700) : '')); }

async function waitForWorld(page) {
  let frame = null;
  for (let i = 0; i < 100 && !frame; i++) { frame = page.frames().find((f) => /world\.html$/.test(f.url())); if (!frame) await sleep(200); }
  for (let i = 0; i < 150; i++) { try { if (await frame.evaluate(() => !!(window.$world && window.$world.submorphs && window.keo && window.keo.init))) break; } catch (e) {} await sleep(300); }
  await sleep(1500);
  await frame.evaluate(() => new Promise((res) => lively.require('lively.identity.LocalIdentity').toRun(res)));
  return frame;
}
const asResult = (e, r) => (e ? { err: e.name + ': ' + e.message } : { r });

(async () => {
  fs.mkdirSync(WORK, { recursive: true });
  const profile = path.join(WORK, 'profile-real');
  fs.rmSync(profile, { recursive: true, force: true });
  const ctx = await chromium.launchPersistentContext(profile, {
    headless: false, viewport: { width: 1280, height: 860 },
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--host-resolver-rules=MAP localhost ~NOTFOUND, MAP 127.0.0.1 ~NOTFOUND'] });
  try {
    await sleep(2500);
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push('PAGEERROR ' + e.message.slice(0, 200)));
    page.on('console', (m) => { if (m.type() === 'error' && !/compute-pressure/.test(m.text())) errors.push('console: ' + m.text().slice(0, 200)); });
    await page.goto(`chrome-extension://${ID}/start.html#guest`);
    let frame = await waitForWorld(page);
    const env = await page.evaluate(() => ({ ua: navigator.userAgent, uvpaa: null, caps: null }));
    env.uvpaa = await page.evaluate(() => PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable());
    env.caps = await page.evaluate(() => (PublicKeyCredential.getClientCapabilities ? PublicKeyCredential.getClientCapabilities() : null));
    say('browser: ' + env.ua); say('platform authenticator available: ' + env.uvpaa);
    say('client capabilities (relevant): ' + JSON.stringify(env.caps && { prf: env.caps['extension:prf'], hybrid: env.caps.hybridTransport, uvpaa: env.caps.userVerifyingPlatformAuthenticator, conditional: env.caps.conditionalGet }));
    results.environment = { ok: true, detail: env };
    await page.bringToFront();

    // ---- create: two prompts
    say('>>> PROMPT 1 of 4 coming: creating the passkey. Approve it (built-in authenticator / security key / phone).');
    say('>>> PROMPT 2 of 4 follows right after: signing the new identity with that passkey. Approve it too.');
    const t0 = Date.now();
    const created = await frame.evaluate(() => new Promise((res) => lively.identity.localIdentity.create('Real authenticator test', (e, r) => res(e ? { err: e.name + ': ' + e.message } : { r }))));
    say('create finished after ' + Math.round((Date.now() - t0) / 1000) + ' s');
    check('create: succeeded on the real authenticator', !created.err && created.r && created.r.did, created);
    const A = created.r || null;
    if (A) {
      say('DID: ' + A.did);
      say('authenticatorAttachment: ' + A.authenticatorAttachment + ', transports: ' + JSON.stringify(A.transports) + ', PRF at create: ' + A.prfAtCreate);
      results.authenticator = { ok: true, detail: { attachment: A.authenticatorAttachment, transports: A.transports, prfAtCreate: A.prfAtCreate } };
      say('focus diagnostics per ceremony: ' + JSON.stringify(A.diag));
      results.createDiag = { ok: true, detail: A.diag };
      check('create: DID shape and not-recoverable flag', /^did:keo:[ybndrfg8ejkmcpqxot1uwisza345h769]{52}:[A-Za-z0-9_-]{43}$/.test(A.did) && A.notRecoverable === true && A.rpId === 'chrome-extension://' + ID, A);
      const stored = await page.evaluate(async (did) => {
        const kd = window.keoDid;
        const rec = await new Promise((res, rej) => { const q = indexedDB.open('keo-identities'); q.onsuccess = () => { const r = q.result.transaction('identities').objectStore('identities').get(did); r.onsuccess = () => { q.result.close(); res(r.result); }; r.onerror = () => rej(r.error); }; q.onerror = () => rej(q.error); });
        if (!rec) return { missing: true };
        const v = await kd.verifyInception({ inception: rec.inception, sigs: rec.sigs });
        const a = rec.sigs.authority[0], cd = JSON.parse(new TextDecoder().decode(kd.unb64u(a.clientDataJSON))), ad = kd.unb64u(a.authenticatorData);
        return { verify: v, origin: cd.origin, type: cd.type, flags: ad[32], rpIdHashMatches: kd.b64u(ad.slice(0, 32)) === kd.b64u(await kd.sha256(new TextEncoder().encode(rec.rpId))),
          sigLen: kd.unb64u(a.signature).length, wrappedLen: kd.unb64u(rec.wrappedAccountSecret).length, deviceExtractable: rec.deviceKey.privateKey.extractable, discExtractable: rec.discoveryKey.extractable };
      }, A.did);
      check('stored: the inception, signed by the REAL passkey, verifies on its own and defines this DID', stored.verify && stored.verify.ok && stored.verify.did === A.did, stored);
      check('stored: the assertion names the extension origin, is a webauthn.get, rpIdHash matches the recorded rpId', stored.origin === 'chrome-extension://' + ID && stored.type === 'webauthn.get' && stored.rpIdHashMatches === true, stored);
      check('stored: user-present and user-verified flags set (bits 0 and 2 of authenticatorData flags)', (stored.flags & 0x01) === 1 && (stored.flags & 0x04) === 4, stored.flags);
      check('stored: wrapped secret 40 bytes, device and discovery keys non-extractable', stored.wrappedLen === 40 && stored.deviceExtractable === false && stored.discExtractable === false, stored);

      // ---- sign in
      say('>>> PROMPT 3 of 4 coming: signing in with the new identity. Approve it.');
      const si = await frame.evaluate((did) => new Promise((res) => lively.identity.localIdentity.signIn(did, (e, r) => res(e ? { err: e.name + ': ' + e.message } : { r }))), A.did);
      say('focus diagnostics: ' + JSON.stringify(si.r && si.r.diag));
      check('signIn: works with the real authenticator (PRF unwrap, secret non-extractable)', !si.err && si.r && si.r.secretNonExtractable === true && si.r.assertionOrigin === 'chrome-extension://' + ID, si);

      // ---- sign in again after a reload
      await page.reload();
      frame = await waitForWorld(page);
      await page.bringToFront();
      const l = await frame.evaluate(() => new Promise((res) => lively.identity.localIdentity.list((e, r) => res(e ? { err: e.message } : r))));
      check('reload: the identity is still listed', Array.isArray(l) && l.length === 1 && l[0].did === A.did, l);
      say('>>> PROMPT 4 of 4 coming: signing in again after a page reload. Approve it.');
      const si2 = await frame.evaluate((did) => new Promise((res) => lively.identity.localIdentity.signIn(did, (e, r) => res(e ? { err: e.name + ': ' + e.message } : { r }))), A.did);
      say('focus diagnostics: ' + JSON.stringify(si2.r && si2.r.diag));
      check('signIn after reload: works, and the PRF output unwraps the same secret', !si2.err && si2.r && si2.r.secretNonExtractable === true, si2);
    } else {
      say('create failed, so the later steps are skipped. If this is NotAllowedError, check the environment (the browser and the OS passkey provider) before suspecting the code.');
    }
    check('no page errors', errors.filter((e) => !/IdentityServer\/session/.test(e)).length === 0, errors);
  } finally { await ctx.close(); }
  fs.writeFileSync(path.join(WORK, 'keo-identity-real.json'), JSON.stringify(results, null, 2));
  const failed = Object.keys(results).filter((k) => !results[k].ok);
  say(failed.length ? 'FAILED: ' + failed.length + ' (' + failed.join('; ') + ')' : 'ALL PASSED (' + Object.keys(results).length + ')');
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.log('FATAL', e); process.exit(2); });
