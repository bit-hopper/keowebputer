// Linking a webputer to an identity against a REAL authenticator. A person must approve the OS prompts, and must be at the keyboard
// for the whole run (about two minutes). Two browsers are opened, each with the extension loaded under its own id (so its own origin
// and its own passkey rpId); no virtual authenticator is attached, so whatever the OS offers answers. The messages that cross between
// the two (the request, the grant, the finished log) are plain JSON that this script carries by hand, as the dialog's copy and paste would.
// Usage: node tests/keo-enroll-real.js <repo root> <package folder> <work dir> [<second package folder>]
//   <package folder> is side A (the identity is made here, and A grants). The second origin, side B, is the optional fourth argument
//   (a package built under another key, for instance the old-id package next to a new-id one); without it a package is built into
//   <work dir>/pkg-b under a throwaway key, which is another origin and so another rpId, as the real pair is.
// Prompts, in order (seven; each is announced BEFORE it starts, with a timestamp):
//   1 + 2  A  create the identity: make the passkey, then sign the inception with it (the second follows the first at once)
//   3      B  make B's own passkey for the request
//   4      A  approve the new webputer (the passkey signs the event and unlocks the secret to hand over)
//   5      B  add this webputer (B's passkey co-signs the same event)
//   6      B  sign in again with its own passkey
//   7      A  sign in again after its log grew
// A failure is reported with the error's name and message; steps that depend on it are skipped. NotAllowedError means the prompt was
// dismissed, timed out, or the browser or OS refused: an environment problem can look the same, so check it before suspecting the code.
// What this does NOT cover: the dialog (keo-enroll-ui-test.js drives that, with a virtual authenticator), another operating system,
// a security key or a phone as the authenticator (whatever the OS offers is what answers; the run records which), another browser.
// Passkeys made here stay in the authenticator (a web page cannot delete one): remove "Real link test A" and "Real link test B" for
// the two extension ids in the OS passkey settings if they are not wanted. The work dir's browser profiles hold the records.
const fs = require('fs');
const path = require('path');
const { REPO, EXT, WORK } = require('./args.js')();
const { chromium } = require(path.join(REPO, 'node_modules', 'playwright-core'));
const { idOfPackage, buildSecond } = require('./two-origins.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => new Date().toLocaleTimeString();
const say = (m) => console.log('[' + now() + '] ' + m);
const results = {};
function check(name, ok, detail) { results[name] = { ok: !!ok, detail }; say((ok ? 'PASS ' : 'FAIL ') + name + (detail && !ok ? '  -> ' + JSON.stringify(detail).slice(0, 700) : '')); }

// Calls a function on a shell page and returns { ok, r } or { ok:false, err }, so a refused prompt is a result and not a crash.
const call = (page, fn, arg) => page.evaluate(async ([src, a]) => {
  try { return { ok: true, r: await (new Function('return (' + src + ')')())(a) }; } catch (e) { return { ok: false, err: (e && e.name) + ': ' + (e && e.message) }; }
}, [fn.toString(), arg]);

async function launch(dir, profile) {
  const p = path.join(WORK, profile);
  fs.rmSync(p, { recursive: true, force: true });
  const ctx = await chromium.launchPersistentContext(p, {
    headless: false, viewport: { width: 1100, height: 760 },
    args: [`--disable-extensions-except=${dir}`, `--load-extension=${dir}`, '--host-resolver-rules=MAP localhost ~NOTFOUND, MAP 127.0.0.1 ~NOTFOUND'] });
  await sleep(2500);
  const page = await ctx.newPage();
  page.on('pageerror', (e) => say('PAGEERROR ' + e.message.slice(0, 200)));
  return { ctx, page };
}

(async () => {
  fs.mkdirSync(WORK, { recursive: true });
  const argB = process.argv[5] ? path.resolve(process.argv[5]) : null;
  let EXT_B, ID_B;
  if (argB) { EXT_B = argB; ID_B = idOfPackage(EXT_B); } else { const s = buildSecond(REPO, WORK); EXT_B = s.dir; ID_B = s.id; }
  const ID_A = idOfPackage(EXT);
  check('the two packages are two different origins', ID_A !== ID_B, { ID_A, ID_B });
  if (ID_A === ID_B) { say('Stopping: one origin cannot be linked to itself.'); process.exit(1); }
  say('side A: ' + ID_A + '   side B: ' + ID_B);
  say('Have the OS passkey prompt ready. Seven approvals are coming; each is announced first. Do not touch the browser windows.');

  const A = await launch(EXT, 'profile-real-link-a'), B = await launch(EXT_B, 'profile-real-link-b');
  try {
    await A.page.goto(`chrome-extension://${ID_A}/start.html#guest`);
    await B.page.goto(`chrome-extension://${ID_B}/start.html#guest`);
    await sleep(3000);
    for (const [n, p] of [['A', A.page], ['B', B.page]]) {
      const ready = await p.evaluate(() => !!(window.keoIdentity && window.keoIdentity.enrollRequest && window.keoFingerprint && window.keoHello));
      check(n + ': the shell page has the identity, fingerprint and hello modules', ready);
    }
    const env = await A.page.evaluate(async () => ({ ua: navigator.userAgent, uvpaa: await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable(),
      caps: PublicKeyCredential.getClientCapabilities ? await PublicKeyCredential.getClientCapabilities() : null }));
    say('browser: ' + env.ua); say('platform authenticator available: ' + env.uvpaa);
    say('client capabilities (relevant): ' + JSON.stringify(env.caps && { prf: env.caps['extension:prf'], hybrid: env.caps.hybridTransport, uvpaa: env.caps.userVerifyingPlatformAuthenticator }));
    results.environment = { ok: true, detail: env };

    // ---- prompts 1 + 2: the identity, on side A
    await A.page.bringToFront();
    say('>>> PROMPTS 1 and 2 of 7 coming (side A): creating the passkey, then signing the new identity with it. Approve both.');
    const t0 = Date.now();
    const made = await call(A.page, () => window.keoIdentity.create({ label: 'Real link test A' }));
    say('create finished after ' + Math.round((Date.now() - t0) / 1000) + ' s');
    const idA = made.r || {};
    check('A: an identity is made on the real authenticator and signed in', made.ok && /^did:keo:/.test(idA.did) && idA.session && idA.authorityKeys === 1 && idA.rpId === 'chrome-extension://' + ID_A, made);
    if (!made.ok) { say('Stopping: nothing to link.'); throw new Error('create failed'); }
    const DID = idA.did;
    say('DID: ' + DID + '   attachment: ' + idA.authenticatorAttachment + '   transports: ' + JSON.stringify(idA.transports));
    if (idA.diag) say('focus diagnostics for the create ceremonies: ' + JSON.stringify(idA.diag));
    results.authenticator = { ok: true, detail: { attachment: idA.authenticatorAttachment, transports: idA.transports } };

    // ---- prompt 3: B's request
    await B.page.bringToFront();
    say('>>> PROMPT 3 of 7 coming (side B): making B\'s own passkey for the request. Approve it.');
    const req = await call(B.page, () => window.keoIdentity.enrollRequest({ label: 'Real link test B' }));
    const R = req.r || {};
    check('B: a request is made, with a passkey of its own on B\'s origin', req.ok && R.request && R.request.kind === 'enroll-request' && R.rpId === 'chrome-extension://' + ID_B && R.words && R.words.length === 8, req);
    if (!req.ok) throw new Error('request failed');
    if (R.diag) say('focus diagnostics: ' + JSON.stringify(R.diag));
    check('B: the request holds public data only', !/"d":/.test(JSON.stringify(R.request)), null);
    const said = R.words.join(' ');
    say('the eight words B shows: ' + said);

    // ---- prompt 4: A grants (the typed words are the guard; here the script plays the person who typed them)
    await A.page.bringToFront();
    say('>>> PROMPT 4 of 7 coming (side A): approving the new webputer. Approve it.');
    const gr = await call(A.page, (a) => window.keoIdentity.enrollGrant(a), { did: DID, request: R.request, confirm: said });
    const G = gr.r || {};
    check('A: with the right words a grant is made', gr.ok && G.kind === 'enroll-grant' && G.event && G.event.type === 'add-authority', gr);
    if (!gr.ok) throw new Error('grant failed');
    check('A: nothing in the grant is a raw secret or a private key', !/"(d|k)":/.test(JSON.stringify(G)), null);

    // ---- prompt 5: B completes
    await B.page.bringToFront();
    const pre = await call(B.page, (g) => window.keoIdentity.enrollPreview(g), G);
    check('B: the preview names the identity and gives its words', pre.ok && pre.r.did === DID && pre.r.words.length === 8, pre);
    if (!pre.ok) throw new Error('preview failed');
    say('>>> PROMPT 5 of 7 coming (side B): adding this webputer to the identity. Approve it.');
    const done = await call(B.page, (a) => window.keoIdentity.enrollComplete(a), { grant: G, confirm: pre.r.words.join(' ') });
    const D = done.r || {};
    check('B: the identity now has two passkeys on two origins and B holds a session', done.ok && D.did === DID && D.authorityKeys === 2 && D.session && D.session.did === DID && D.rpId === 'chrome-extension://' + ID_B, done);
    if (!done.ok) throw new Error('complete failed');
    if (D.diag) say('focus diagnostics: ' + JSON.stringify(D.diag));

    // ---- A takes the finished log (no prompt)
    const acc = await call(A.page, (a) => window.keoIdentity.enrollAccept(a), { did: DID, events: D.done.events });
    check('A: takes the finished log; both sides now hold the same identity with two passkeys', acc.ok && acc.r.authorityKeys === 2, acc);

    // ---- prompt 6: B signs in again with its own passkey
    await B.page.bringToFront();
    await B.page.evaluate(() => window.keoIdentity.signOut());
    say('>>> PROMPT 6 of 7 coming (side B): signing in with B\'s own passkey. Approve it.');
    const siB = await call(B.page, (d) => window.keoIdentity.signIn({ did: d }), DID);
    check('B: signs in again with its own passkey (the assertion names B\'s origin) and the secret unwraps', siB.ok && siB.r.assertionOrigin === 'chrome-extension://' + ID_B && siB.r.secretNonExtractable === true, siB);
    if (siB.ok && siB.r.diag) say('focus diagnostics: ' + JSON.stringify(siB.r.diag));

    // ---- prompt 7: A signs in again after its log grew
    await A.page.bringToFront();
    await A.page.evaluate(() => window.keoIdentity.signOut());
    say('>>> PROMPT 7 of 7 coming (side A): signing in again now that the identity has two passkeys. Approve it.');
    const siA = await call(A.page, (d) => window.keoIdentity.signIn({ did: d }), DID);
    check('A: signs in again with its own passkey after the log grew', siA.ok && siA.r.assertionOrigin === 'chrome-extension://' + ID_A && siA.r.authorityKeys === 2 && siA.r.secretNonExtractable === true, siA);
    if (siA.ok && siA.r.diag) say('focus diagnostics: ' + JSON.stringify(siA.r.diag));

    // ---- no more prompts: the same account secret on both sides, and each side's proof is accepted by the other
    const seal = (page, text) => call(page, async (t) => {
      const wk = window.keoIdentity.sessionWorldKey(), iv = crypto.getRandomValues(new Uint8Array(12));
      return { iv: Array.from(iv), ct: Array.from(new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, wk.key, new TextEncoder().encode(t)))) };
    }, text);
    const open = (page, s) => call(page, async (x) => new TextDecoder().decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: new Uint8Array(x.iv) }, window.keoIdentity.sessionWorldKey().key, new Uint8Array(x.ct))), s);
    const sA = await seal(A.page, 'sealed on A'), sB = await seal(B.page, 'sealed on B');
    const oB = sA.ok ? await open(B.page, sA.r) : sA, oA = sB.ok ? await open(A.page, sB.r) : sB;
    check('data sealed on A opens on B, and the other way round (the same account secret)', oB.ok && oB.r === 'sealed on A' && oA.ok && oA.r === 'sealed on B', { oB, oA });

    const proofOf = (page) => call(page, async () => {
      const h = window.keoHello, ident = window.keoIdentity, proof = await ident.deviceProof();
      const hello = h.proofBuild('offer', ['AA:AA', 'BB:BB'], proof, { name: 'x' });
      return JSON.parse(JSON.stringify({ hello, sig: await ident.signWithDevice(h.signedBytes(hello), proof.did) }));
    });
    const pA = await proofOf(A.page), pB = await proofOf(B.page);
    const vAB = pB.ok ? await call(A.page, (a) => window.keoHello.verifyProof(a.msg, { role: 'offer', fps: ['AA:AA', 'BB:BB'], audience: a.aud }), { msg: pB.r, aud: 'chrome-extension://' + ID_B }) : pB;
    const vBA = pA.ok ? await call(B.page, (a) => window.keoHello.verifyProof(a.msg, { role: 'offer', fps: ['AA:AA', 'BB:BB'], audience: a.aud }), { msg: pA.r, aud: 'chrome-extension://' + ID_A }) : pA;
    check('each side accepts the other\'s proof: the same DID, a passkey from another origin', vAB.ok && vAB.r.ok === true && vAB.r.did === DID && vBA.ok && vBA.r.ok === true && vBA.r.did === DID, { vAB, vBA });
  } catch (e) {
    check('the run completed', false, String(e && e.message || e));
  } finally {
    // each context is closed by its own handle: nothing is stopped by name
    await A.ctx.close().catch(() => {}); await B.ctx.close().catch(() => {});
  }
  fs.writeFileSync(path.join(WORK, 'keo-enroll-real.json'), JSON.stringify(results, null, 2));
  const failed = Object.keys(results).filter((k) => !results[k].ok);
  say(failed.length ? 'FAILED: ' + failed.length + ' (' + failed.join('; ') + ')' : 'ALL PASSED (' + Object.keys(results).length + ')');
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.log('FATAL', e); process.exit(2); });
