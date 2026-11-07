// End-to-end test of moving an identity to ANOTHER ORIGIN: two browsers, each with the extension loaded under its own id (so its own
// origin and passkey rpId), each with a CDP virtual authenticator with PRF. The messages that cross between them are plain JSON that
// this driver carries by hand, as any channel would. The second package is built here with a throwaway key.
// Usage: node keo-enroll-test.js <repo root> <package folder> <work dir>
//   <package folder> is the normal build (the extension id in extension-key.json); the second origin is built into <work dir>/pkg-b.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const cp = require('child_process');
const { REPO, EXT, WORK } = require('./args.js')();
const { chromium } = require(path.join(REPO, 'node_modules', 'playwright-core'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let passed = 0, failed = 0;
function check(name, ok, detail) { if (ok) passed++; else failed++; console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail && !ok ? '  -> ' + JSON.stringify(detail).slice(0, 700) : '')); }
const { idOfPackage, buildSecond, launch: launchIn } = require('./two-origins.js');
const launch = (dir, profile) => launchIn(chromium, dir, profile, WORK);

// Calls a function on the shell page and returns { ok, r } or { ok:false, err } so a rejection is a result, not a crash.
const call = (page, fn, arg) => page.evaluate(async ([src, a]) => {
  try { return { ok: true, r: await (new Function('return (' + src + ')')())(a) }; } catch (e) { return { ok: false, err: (e && e.name) + ': ' + (e && e.message) }; }
}, [fn.toString(), arg]);

(async () => {
  fs.mkdirSync(WORK, { recursive: true });
  // ---- the second origin: the same code under another key
  const second = buildSecond(REPO, WORK), EXT_B = second.dir;
  const ID_A = idOfPackage(EXT), ID_B = second.id;
  check('the two packages are two different origins', ID_A !== ID_B, { ID_A, ID_B });

  const A = await launch(EXT, 'profile-enroll-a'), B = await launch(EXT_B, 'profile-enroll-b');
  try {
    await A.page.goto(`chrome-extension://${ID_A}/start.html#guest`);
    await B.page.goto(`chrome-extension://${ID_B}/start.html#guest`);
    await sleep(3000);
    for (const [n, p] of [['A', A.page], ['B', B.page]]) {
      const ready = await p.evaluate(() => !!(window.keoIdentity && window.keoIdentity.enrollRequest && window.keoFingerprint && window.keoHello));
      check(n + ': the shell page has the identity, fingerprint and hello modules', ready);
    }

    // ---- the identity on the OLD side (A)
    const made = await call(A.page, () => window.keoIdentity.create({ label: 'Alice laptop' }));
    const idA = made.r || {};
    check('A: an identity is made and signed in', made.ok && /^did:keo:/.test(idA.did) && idA.session && idA.notRecoverable === true && idA.authorityKeys === 1, made);
    const DID = idA.did;

    // ---- 1. B asks to join
    const req = await call(B.page, () => window.keoIdentity.enrollRequest({ label: 'Alice desktop' }));
    const R = req.r || {};
    check('B: a request is made, with a passkey of its own on B\'s origin', req.ok && R.request && R.request.kind === 'enroll-request' && R.rpId === 'chrome-extension://' + ID_B && R.words.length === 8, req);
    check('B: the request holds public data only (no private member anywhere)', req.ok && !/"d":/.test(JSON.stringify(R.request)), R.request);
    const said = R.words.join(' ');

    // ---- 2. A grants: the words are the guard
    const wrongWords = await call(A.page, (a) => window.keoIdentity.enrollGrant(a), { did: DID, request: R.request, confirm: 'abandon '.repeat(8) });
    check('A: wrong words are refused, nothing is approved', !wrongWords.ok && /words do not match/.test(wrongWords.err), wrongWords);
    const noWords = await call(A.page, (a) => window.keoIdentity.enrollGrant(a), { did: DID, request: R.request });
    check('A: no words at all are refused', !noWords.ok && /words do not match/.test(noWords.err), noWords);
    const swapped = JSON.parse(JSON.stringify(R.request)); swapped.ecdh = (await call(A.page, async () => {
      const k = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
      const j = await crypto.subtle.exportKey('jwk', k.publicKey); return { kty: j.kty, crv: j.crv, x: j.x, y: j.y };
    })).r;
    const swappedRes = await call(A.page, (a) => window.keoIdentity.enrollGrant(a), { did: DID, request: swapped, confirm: said });
    check('A: a request whose receiving key was swapped on the way no longer matches the words', !swappedRes.ok && /words do not match/.test(swappedRes.err), swappedRes);
    const junk = await call(A.page, (a) => window.keoIdentity.enrollGrant(a), { did: DID, request: { v: 1, kind: 'enroll-request' }, confirm: said });
    check('A: a malformed request is refused', !junk.ok && /not a valid request/.test(junk.err), junk);
    await A.page.evaluate(() => window.keoIdentity.signOut());
    const signedOut = await call(A.page, (a) => window.keoIdentity.enrollGrant(a), { did: DID, request: R.request, confirm: said });
    check('A: nobody signed in, nothing is granted', !signedOut.ok && /Sign in/.test(signedOut.err), signedOut);
    const si = await call(A.page, (d) => window.keoIdentity.signIn({ did: d }), DID);
    check('A: signs in again', si.ok && si.r.session && si.r.session.did === DID, si);

    const gr = await call(A.page, (a) => window.keoIdentity.enrollGrant(a), { did: DID, request: R.request, confirm: said });
    const G = gr.r || {};
    check('A: with the right words a grant is made (one prompt)', gr.ok && G.kind === 'enroll-grant' && G.event && G.event.type === 'add-authority' && G.event.seq === 1, gr);
    check('A: the grant carries the existing log, the event signed by A\'s passkey, and the sealed secret',
      !!(G.inception && G.sigs && Array.isArray(G.events) && G.authority && typeof G.authority.keyId === 'string' && G.authority.keyId === G.inception.state.authority.keys[0].id && typeof G.sealed === 'string' && G.sealed.length > 40), Object.keys(G));
    check('A: nothing in the grant is a raw secret or a private key', !/"(d|k)":/.test(JSON.stringify(G)), null);
    const aKeysBefore = await call(A.page, async (d) => (await window.keoIdentity.list()).filter((x) => x.did === d)[0], DID);
    check('A: granting does not change A\'s own log yet', aKeysBefore.ok && aKeysBefore.r.authorityKeys === 1 && aKeysBefore.r.notRecoverable === true, aKeysBefore);

    // ---- 3. B completes: the words of the identity are the guard on this side
    const pre = await call(B.page, (g) => window.keoIdentity.enrollPreview(g), G);
    check('B: the preview names the identity and gives its words', pre.ok && pre.r.did === DID && pre.r.words.length === 8, pre);
    const wrongDid = await call(B.page, (a) => window.keoIdentity.enrollComplete(a), { grant: G, confirm: 'abandon '.repeat(8) });
    check('B: wrong words for the identity are refused', !wrongDid.ok && /words do not match/.test(wrongDid.err), wrongDid);
    const tamperedSeal = JSON.parse(JSON.stringify(G)); tamperedSeal.sealed = (tamperedSeal.sealed[0] === 'A' ? 'B' : 'A') + tamperedSeal.sealed.slice(1);
    const t1 = await call(B.page, (a) => window.keoIdentity.enrollComplete(a), { grant: tamperedSeal, confirm: pre.r.words.join(' ') });
    check('B: a grant whose sealed secret was altered cannot be opened', !t1.ok && /could not be opened/.test(t1.err), t1);
    const otherKey = JSON.parse(JSON.stringify(G)); otherKey.event.add.key.rpId = 'evil.test';
    const t2 = await call(B.page, (a) => window.keoIdentity.enrollComplete(a), { grant: otherKey, confirm: pre.r.words.join(' ') });
    check('B: a grant for a different key than B asked for is refused', !t2.ok && /not for the request/.test(t2.err), t2);
    const stillPending = await call(B.page, (a) => window.keoIdentity.enrollComplete(a), { grant: G, confirm: pre.r.words.join(' ') });
    const done = stillPending.r || {};
    check('B: after refusals the request is still valid and the right grant completes', stillPending.ok && done.did === DID && done.session && done.session.did === DID, stillPending);
    check('B: the identity now has two passkeys on two origins and is recoverable', done.authorityKeys === 2 && done.notRecoverable === false && done.rpId === 'chrome-extension://' + ID_B, done);
    check('B: the finished event is returned for A to keep', done.done && done.done.events.length === 1 && done.done.events[0].sigs.newKey && done.done.events[0].sigs.authority.length === 1, done.done);
    const replay = await call(B.page, (a) => window.keoIdentity.enrollComplete(a), { grant: G, confirm: pre.r.words.join(' ') });
    check('B: nothing is waiting any more, so the same grant cannot be used again', !replay.ok && /No request is waiting/.test(replay.err), replay);

    // ---- what B stored
    const stored = await B.page.evaluate(async (did) => {
      const rec = await new Promise((res, rej) => { const q = indexedDB.open('keo-identities'); q.onsuccess = () => { const r = q.result.transaction('identities').objectStore('identities').get(did); r.onsuccess = () => { q.result.close(); res(r.result); }; r.onerror = () => rej(r.error); }; q.onerror = () => rej(q.error); });
      if (!rec) return { missing: true };
      const v = await window.keoDid.verifyLog({ inception: rec.inception, sigs: rec.sigs, events: rec.events }, did);
      return { v: v.ok, keys: v.state && v.state.authority.keys.map((k) => k.rpId), devices: v.state && v.state.devices.length,
        credIsNew: v.ok && v.state.authority.keys[1].id === rec.credentialId, deviceExtractable: rec.deviceKey.privateKey.extractable,
        wrappedPresent: typeof rec.wrappedAccountSecret === 'string', plainSecret: JSON.stringify(Object.keys(rec)).includes('secret') && rec.accountSecret !== undefined };
    }, DID);
    check('B: the stored log verifies against the DID, lists both origins, and B\'s own passkey is the new one', stored.v === true && stored.keys.length === 2 && stored.keys[0] === 'chrome-extension://' + ID_A && stored.keys[1] === 'chrome-extension://' + ID_B && stored.credIsNew, stored);
    check('B: the device key is non-extractable and the secret is stored only wrapped', stored.deviceExtractable === false && stored.wrappedPresent && !stored.plainSecret, stored);

    // ---- B signs in with its own passkey, on its own origin
    await B.page.evaluate(() => window.keoIdentity.signOut());
    const siB = await call(B.page, (d) => window.keoIdentity.signIn({ did: d }), DID);
    check('B: signs in again with the new passkey (assertion made on B\'s origin)', siB.ok && siB.r.assertionOrigin === 'chrome-extension://' + ID_B && siB.r.session.cert.authorityKeyId === done.done.events[0].event.add.key.id && siB.r.secretNonExtractable === true, siB);

    // ---- the same secret on both sides: what A seals, B opens
    const sealed = await call(A.page, async () => {
      const wk = window.keoIdentity.sessionWorldKey(); const iv = crypto.getRandomValues(new Uint8Array(12));
      const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, wk.key, new TextEncoder().encode('sealed on A')));
      return { iv: Array.from(iv), ct: Array.from(ct) };
    });
    const opened = await call(B.page, async (s) => {
      const wk = window.keoIdentity.sessionWorldKey();
      return new TextDecoder().decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: new Uint8Array(s.iv) }, wk.key, new Uint8Array(s.ct)));
    }, sealed.r);
    check('data sealed under the identity on A opens on B (the same account secret, the same world key)', opened.ok && opened.r === 'sealed on A', opened);
    const sealedB = await call(B.page, async () => {
      const wk = window.keoIdentity.sessionWorldKey(); const iv = crypto.getRandomValues(new Uint8Array(12));
      const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, wk.key, new TextEncoder().encode('sealed on B')));
      return { iv: Array.from(iv), ct: Array.from(ct) };
    });
    const openedA = await call(A.page, async (s) => {
      const wk = window.keoIdentity.sessionWorldKey();
      return new TextDecoder().decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: new Uint8Array(s.iv) }, wk.key, new Uint8Array(s.ct)));
    }, sealedB.r);
    check('and the other way round', openedA.ok && openedA.r === 'sealed on B', openedA);

    // ---- A takes the finished log
    const short = await call(A.page, (a) => window.keoIdentity.enrollAccept(a), { did: DID, events: [] });
    check('A: an empty log adds nothing', short.ok && short.r.authorityKeys === 1, short);
    const forged = JSON.parse(JSON.stringify(done.done.events)); forged[0].event.add.key.rpId = 'evil.test';
    const forgedRes = await call(A.page, (a) => window.keoIdentity.enrollAccept(a), { did: DID, events: forged });
    check('A: an altered log is refused', !forgedRes.ok && /does not verify/.test(forgedRes.err), forgedRes);
    const acc = await call(A.page, (a) => window.keoIdentity.enrollAccept(a), { did: DID, events: done.done.events });
    check('A: takes the finished log; now both devices hold the same identity with two passkeys', acc.ok && acc.r.authorityKeys === 2 && acc.r.notRecoverable === false, acc);
    const accAgain = await call(A.page, (a) => window.keoIdentity.enrollAccept(a), { did: DID, events: done.done.events });
    check('A: taking it twice changes nothing', accAgain.ok && accAgain.r.authorityKeys === 2, accAgain);
    const older = await call(A.page, (a) => window.keoIdentity.enrollAccept(a), { did: DID, events: [] });
    check('A: an older copy of the log (shorter, and the start of its own) changes nothing and is not an error', older.ok && older.r.authorityKeys === 2, older);
    await A.page.evaluate(() => window.keoIdentity.signOut());
    const siA = await call(A.page, (d) => window.keoIdentity.signIn({ did: d }), DID);
    check('A: signs in with its own passkey after the log grew', siA.ok && siA.r.assertionOrigin === 'chrome-extension://' + ID_A && siA.r.authorityKeys === 2, siA);

    // ---- each device's proof is accepted by the other, with the log in it
    const proofOf = (page, audience) => call(page, async (a) => {
      const h = window.keoHello, ident = window.keoIdentity, proof = await ident.deviceProof();
      const hello = h.proofBuild('offer', a.fps, proof, { name: a.name });
      const sig = await ident.signWithDevice(h.signedBytes(hello), proof.did);
      return JSON.parse(JSON.stringify({ hello, sig }));
    }, { fps: ['AA:AA', 'BB:BB'], name: 'x' });
    const pB = await proofOf(B.page), pA = await proofOf(A.page);
    check('B\'s proof carries the log', pB.ok && pB.r.hello.events && pB.r.hello.events.length === 1, pB);
    const vAB = await call(A.page, (a) => window.keoHello.verifyProof(a.msg, { role: 'offer', fps: a.fps, audience: a.aud }), { msg: pB.r, fps: ['AA:AA', 'BB:BB'], aud: 'chrome-extension://' + ID_B });
    check('A accepts B\'s proof: same DID, a passkey from another origin', vAB.ok && vAB.r.ok === true && vAB.r.did === DID, vAB);
    const vBA = await call(B.page, (a) => window.keoHello.verifyProof(a.msg, { role: 'offer', fps: a.fps, audience: a.aud }), { msg: pA.r, fps: ['AA:AA', 'BB:BB'], aud: 'chrome-extension://' + ID_A });
    check('B accepts A\'s proof', vBA.ok && vBA.r.ok === true && vBA.r.did === DID, vBA);
    const noLog = JSON.parse(JSON.stringify(pB.r)); delete noLog.hello.events;
    const vNo = await call(A.page, (a) => window.keoHello.verifyProof(a.msg, { role: 'offer', fps: a.fps, audience: a.aud }), { msg: noLog, fps: ['AA:AA', 'BB:BB'], aud: 'chrome-extension://' + ID_B });
    check('B\'s proof without the log is refused (and its signature would not match anyway)', vNo.ok && vNo.r.ok === false, vNo);

    // ---- a second identity: a grant for someone else's request does not land
    const made2 = await call(A.page, () => window.keoIdentity.create({ label: 'Alice second' }));
    const req2 = await call(B.page, () => window.keoIdentity.enrollRequest({ label: 'Alice second at B' }));
    const req3 = await call(B.page, () => window.keoIdentity.enrollRequest({ label: 'a newer request' }));
    check('B: asking again replaces the waiting request', req2.ok && req3.ok && req2.r.words.join(' ') !== req3.r.words.join(' '), null);
    const siA2 = await call(A.page, (d) => window.keoIdentity.signIn({ did: d }), made2.r.did);
    const gr2 = await call(A.page, (a) => window.keoIdentity.enrollGrant(a), { did: made2.r.did, request: req2.r.request, confirm: req2.r.words.join(' ') });
    check('A: grants the older request (A cannot know it was replaced)', siA2.ok && gr2.ok, gr2);
    const pre2 = await call(B.page, (g) => window.keoIdentity.enrollPreview(g), gr2.r);
    const late = await call(B.page, (a) => window.keoIdentity.enrollComplete(a), { grant: gr2.r, confirm: pre2.r.words.join(' ') });
    check('B: a grant for the replaced request is refused', !late.ok && /not for the request/.test(late.err), late);
    await call(B.page, () => window.keoIdentity.enrollCancel());
    const none = await call(B.page, (a) => window.keoIdentity.enrollComplete(a), { grant: gr2.r, confirm: pre2.r.words.join(' ') });
    check('B: after cancelling, nothing is waiting', !none.ok && /No request is waiting/.test(none.err), none);
  } catch (e) {
    failed++; console.log('FAIL the test crashed: ' + (e && e.stack || e));
  } finally {
    // each context is closed by its own handle: nothing is stopped by name
    await A.ctx.close().catch(() => {}); await B.ctx.close().catch(() => {});
  }
  console.log(passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})();
