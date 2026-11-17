// Node test for keo-wikilog.js (the signed wiki version event), keo-yupdate.js (the small update reader) and the vendored Yjs copy
// (keo-yjs.js): no browser, no authenticator. Identities, their logs, device keys and removals are built with keo-did.js exactly as the
// shell builds them; a WebAuthn assertion is imitated as in keo-did-test.js. Everything random is seeded, so a run can be repeated.
// Usage: node keo-wikilog-test.js
const path = require('path');
const kd = require(path.join(__dirname, '..', 'shell', 'keo-did.js'));
const Y = require(path.join(__dirname, '..', 'shell', 'keo-yjs.js'));
const U = require(path.join(__dirname, '..', 'shell', 'keo-yupdate.js'));
const W = require(path.join(__dirname, '..', 'shell', 'keo-wikilog.js'));
const nodeCrypto = require('crypto');
const subtle = globalThis.crypto.subtle;
const enc = new TextEncoder();
let passed = 0;
const ok = (name, cond, extra) => { if (!cond) { console.error('FAIL ' + name + (extra !== undefined ? ' ' + (typeof extra === 'string' ? extra : JSON.stringify(extra)).slice(0, 700) : '')); process.exitCode = 1; } else { passed++; console.log('ok   ' + name); } };

// ---- imitated WebAuthn, as in keo-did-test.js
function rawToDer(raw) {
  const int = (b) => { let i = 0; while (i < b.length - 1 && b[i] === 0) i++; b = b.slice(i); if (b[0] & 0x80) b = Buffer.concat([Buffer.from([0]), b]); return Buffer.concat([Buffer.from([0x02, b.length]), b]); };
  const body = Buffer.concat([int(Buffer.from(raw.slice(0, 32))), int(Buffer.from(raw.slice(32)))]);
  return Buffer.concat([Buffer.from([0x30, body.length]), body]);
}
async function assertion(privateKey, challengeBytes) {
  const authenticatorData = crypto.getRandomValues(new Uint8Array(37));
  const clientDataJSON = enc.encode(JSON.stringify({ type: 'webauthn.get', challenge: kd.b64u(challengeBytes), origin: 'chrome-extension://test' }));
  const input = Buffer.concat([Buffer.from(authenticatorData), Buffer.from(await kd.sha256(clientDataJSON))]);
  const raw = new Uint8Array(await subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, privateKey, input));
  return { authenticatorData: kd.b64u(authenticatorData), clientDataJSON: kd.b64u(clientDataJSON), signature: kd.b64u(rawToDer(raw)) };
}
const plain = (j) => ({ kty: j.kty, crv: j.crv, x: j.x, y: j.y });
const newPair = () => subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);

// A person: an identity whose first device is listed in the inception, with methods that grow its log the way the shell does.
async function makeDevice() {
  const pair = await newPair(), jwk = plain(await subtle.exportKey('jwk', pair.publicKey));
  return { pair, jwk, id: kd.b64u(await kd.sha256(enc.encode(kd.canonicalJson(jwk)))) };
}
async function makePerson() {
  const authPair = await newPair(), disc = await kd.ed25519FromSeed(crypto.getRandomValues(new Uint8Array(32)));
  const keyId = kd.b64u(crypto.getRandomValues(new Uint8Array(16))), t0 = new Date().toISOString(), d1 = await makeDevice();
  const inception = { v: 1, type: 'inception', seq: 0, prev: null, time: t0, state: {
    authority: { threshold: 1, keys: [{ id: keyId, jwk: plain(await subtle.exportKey('jwk', authPair.publicKey)), rpId: 'testid', kind: 'platform', addedAt: t0 }] },
    next: null, recovery: { guardians: [], threshold: 2, delayDays: 3 }, discovery: { key: disc.publicZ32, version: 1 }, services: [], claims: { handles: [] }, revoked: [],
    devices: [{ id: d1.id, jwk: d1.jwk, addedAt: t0 }] } };
  const H = await kd.eventHash(inception);
  const p = { authPair, keyId, d1, did: kd.didFor(disc.publicZ32, kd.b64u(H)),
    log: { inception, sigs: { discovery: kd.b64u(await subtle.sign({ name: 'Ed25519' }, disc.privateKey, H)), authority: [Object.assign({ keyId }, await assertion(authPair.privateKey, H))] }, events: [] } };
  const last = () => (p.log.events.length ? p.log.events[p.log.events.length - 1].event : p.log.inception);
  const push = async (e) => { p.log.events.push({ event: e, sigs: { authority: [Object.assign({ keyId }, await assertion(authPair.privateKey, await kd.eventHash(e)))] } }); return p.log.events.length; };
  p.addDevice = async () => { const d = await makeDevice(); await push(await kd.addDeviceEvent(last(), { id: d.id, jwk: d.jwk, addedAt: new Date().toISOString() })); return d; };
  p.removeDevice = async (d) => push(await kd.removeDeviceEvent(last(), d.id));      // resolves to the seq of the removal
  p.point = () => W.logPoint(p.log);
  p.signer = (dev) => async (bytes) => kd.b64u(new Uint8Array(await subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, dev.pair.privateKey, bytes)));
  return p;
}

// A receiver: the logs it holds, the versions it holds, and who may write.
function makeCtx(people, o) {
  o = o || {};
  const store = new Map();
  const ctx = { store,
    log: async (did) => { const p = people.filter((x) => x.did === did)[0]; return p ? (o.logOf ? o.logOf(p) : p.log) : null; },
    versions: (cid) => store.has(cid),
    writers: o.writers || (async () => people.map((p) => p.did)),
    Y: o.Y };
  return ctx;
}
let OBJ = 'page-one';              // becomes A's page once A exists: a page is named by its owner and a name
const NONCE1 = 'nonce-aaaa1', NONCE2 = 'nonce-bbbb2';

// A Yjs document that edits under a device's derived client id; `edit` returns the update of only what the function changed.
async function peerDoc(dev, nonce, objId) { const d = new Y.Doc(); d.clientID = await W.clientIdFor(dev.id, objId || OBJ, nonce); return d; }
function edit(doc, fn) { const sv = Y.encodeStateVector(doc); fn(doc); return Y.encodeStateAsUpdate(doc, sv); }
// A signed version: `o` overrides parents, nonces, point (authorLog), objId, created, attachments.
async function version(person, dev, update, o) {
  o = o || {};
  const ev = await W.buildVersion({ objId: o.objId || OBJ, parents: o.parents || [], author: { did: person.did, deviceId: dev.id }, authorLog: o.point || await person.point(),
    nonces: o.nonces || [NONCE1], update, attachments: o.attachments, created: o.created });
  return W.seal(ev, person.signer(dev));
}
const accept = async (ctx, env) => { const r = await W.verifyVersion(env, ctx); if (r.ok) ctx.store.set(r.cid, env); return r; };
const clone = (x) => JSON.parse(JSON.stringify(x));
const tamper = (env, f) => { const c = clone(env); f(c); return c; };
// the same envelope with its event changed and RE-SIGNED by the device, to reach the checks that come after the signature
const resigned = async (person, dev, env, f) => { const c = clone(env); f(c.event); return W.seal(c.event, person.signer(dev)); };

(async () => {
  // ================================================================ the vendored Yjs and the client id
  ok('the vendored Yjs is the version the file says it is made from', /Yjs 13\.6\.31 with lib0 0\.2\.117/.test(require('fs').readFileSync(path.join(__dirname, '..', 'shell', 'keo-yjs.js'), 'utf8').slice(0, 200)));
  ok('the vendored Yjs round-trips an edit between two documents', (() => { const a = new Y.Doc(), b = new Y.Doc(); a.getText('t').insert(0, 'hello'); Y.applyUpdate(b, Y.encodeStateAsUpdate(a)); return b.getText('t').toString() === 'hello'; })());
  // an independent computation of the id: node's own hash and BigInt, not the module's arithmetic
  const refId = (deviceId, objId, nonce) => Number(BigInt('0x' + nodeCrypto.createHash('sha256').update(Buffer.concat([Buffer.from('keo/wiki-client/v1'), Buffer.from([0]), Buffer.from(deviceId), Buffer.from([0]), Buffer.from(objId), Buffer.from([0]), Buffer.from(nonce)])).digest('hex').slice(0, 16)) >> 11n);
  let same = true, big = 0;
  for (let i = 0; i < 300; i++) { const d = 'dev' + i, o = 'obj' + (i % 7), n = 'nonce' + i + 'xxxxxxxx'; const a = await W.clientIdFor(d, o, n); if (a !== refId(d, o, n)) same = false; if (a > 2 ** 52) big++; if (!Number.isSafeInteger(a)) same = false; }
  ok('the client id is 53 bits of the hash, equal to an independent computation on 300 inputs, always a safe integer', same);
  ok('and it does use the whole 53 bits (about half of 300 random ids are above 2^52)', big > 100 && big < 200, big);
  const idA = await W.clientIdFor('devA', 'page', 'nonce-123456'), idB = await W.clientIdFor('devB', 'page', 'nonce-123456');
  ok('the client id changes with the device, the page and the nonce', idA !== idB && idA !== await W.clientIdFor('devA', 'page2', 'nonce-123456') && idA !== await W.clientIdFor('devA', 'page', 'nonce-123457'));
  ok('a device and a page whose names run together do not give the same id (the parts are separated)', await W.clientIdFor('ab', 'c', 'nonce-123456') !== await W.clientIdFor('a', 'bc', 'nonce-123456'));
  ok('Yjs keeps an id of 2^53-1 exactly through an update', (() => { const d = new Y.Doc(); d.clientID = Number.MAX_SAFE_INTEGER; d.getText('t').insert(0, 'x'); const u = Y.encodeStateAsUpdate(d); return U.readUpdate(u).structs[0].client === Number.MAX_SAFE_INTEGER && Y.decodeUpdate(u).structs[0].id.client === Number.MAX_SAFE_INTEGER; })());

  // ================================================================ a first accepted edit, and what it returns
  const A = await makePerson(), B = await makePerson(), C = await makePerson();
  const people = [A, B, C];
  OBJ = W.pageId(A.did, 'page-one');
  const ctx = makeCtx(people);
  const docA = await peerDoc(A.d1, NONCE1);
  const u1 = edit(docA, (d) => d.getText('body').insert(0, 'hello'));
  const e1 = await version(A, A.d1, u1);
  const r1 = await accept(ctx, e1);
  ok('a first edit by the page\'s author verifies', r1.ok === true && r1.did === A.did && r1.deviceId === A.d1.id && r1.structs === 1, r1);
  ok('the version id is the SHA-256 of the canonical event, and does not depend on the signature', r1.cid === kd.b64u(nodeCrypto.createHash('sha256').update(kd.canonicalJson(e1.event)).digest()) && r1.cid === await W.versionId(tamper(e1, (c) => { c.sig = 'AAAA'; }).event));
  const e1again = await version(A, A.d1, u1, { created: e1.event.created });
  const otherEventSig = (await version(A, A.d1, edit(docA, (d) => d.getText('body').insert(5, '?')))).sig;
  ok('the same edit signed again has the same id (ECDSA signatures differ every time, ids must not)', e1again.sig !== e1.sig && await W.versionId(e1again.event) === r1.cid);
  ok('verifying the same version a second time gives the same answer (duplicates are harmless)', (await W.verifyVersion(e1, ctx)).cid === r1.cid && (await W.verifyVersion(e1again, ctx)).cid === r1.cid);
  ok('the envelope is not changed by verifying it', (() => { const c = clone(e1); return JSON.stringify(c) === JSON.stringify(e1); })());
  const e1parents = await W.buildVersion({ objId: OBJ, parents: ['b'.repeat(43), 'a'.repeat(43), 'b'.repeat(43)], author: { did: A.did, deviceId: A.d1.id }, authorLog: await A.point(), nonces: [NONCE1], update: u1 });
  ok('parents are sorted and unique whatever order they are given in, so the id does not depend on it', JSON.stringify(e1parents.parents) === JSON.stringify(['a'.repeat(43), 'b'.repeat(43)]));

  // ================================================================ what cannot be changed after signing
  const refusedBy = async (name, env, c, re) => { const r = await W.verifyVersion(env, c || ctx); ok(name, r.ok === false && !r.pending && (!re || re.test(r.error)), r); };
  await refusedBy('changing the update after signing is refused', tamper(e1, (c) => { c.event.payload.update = kd.b64u(edit(docA, (d) => d.getText('body').insert(5, '!'))); }), null, /signature/);
  await refusedBy('changing the page after signing is refused', tamper(e1, (c) => { c.event.objId = W.pageId(A.did, 'page-two'); }), null, /signature|client id/);
  await refusedBy('changing the parents after signing is refused', tamper(e1, (c) => { c.event.parents = ['a'.repeat(43)]; }), null, /signature/);
  await refusedBy('changing the date after signing is refused', tamper(e1, (c) => { c.event.created = '2001-01-01T00:00:00.000Z'; }), null, /signature/);
  await refusedBy('changing the attachments after signing is refused', tamper(e1, (c) => { c.event.payload.attachments = ['x'.repeat(30)]; }), null, /signature/);
  await refusedBy('changing the point of the author\'s log after signing is refused', tamper(e1, (c) => { c.event.authorLog.seq = 0; c.event.authorLog.head = 'z'.repeat(43); }), null, /does not end where|signature/);
  await refusedBy('changing the client ids after signing is refused', tamper(e1, (c) => { c.event.clients[0].nonce = 'other-nonce1'; }), null, /signature/);
  ok('(the same event signed again carries a different but equally valid signature)', (await W.verifyVersion(tamper(e1, (c) => { c.sig = e1again.sig; }), ctx)).ok === true);
  await refusedBy('a signature made over another event by the same device is refused', tamper(e1, (c) => { c.sig = otherEventSig; }), null, /signature/);
  await refusedBy('a signature cut short is refused', tamper(e1, (c) => { c.sig = c.sig.slice(0, 40); }), null, /signature/);
  await refusedBy('a signature that is not base64url is refused', tamper(e1, (c) => { c.sig = '!!!!'; }), null, /signature/);
  const strangerDev = await makeDevice();
  await refusedBy('an edit signed by a key that is not the author\'s device is refused', await W.seal(e1.event, A.signer(strangerDev)), null, /signature/);
  const A2 = await A.addDevice();
  const e1bySecond = await W.seal(e1.event, A.signer(A2));
  await refusedBy('an edit that names one of the author\'s devices but is signed by another of them is refused', e1bySecond, null, /signature/);
  await refusedBy('an edit naming a device the author\'s log does not list is refused', await resigned(A, strangerDev, e1, (e) => { e.author.deviceId = strangerDev.id; e.clients[0].id = 1; }), null, /not listed/);
  await refusedBy('an edit that claims another identity\'s did is refused (that identity\'s log does not list the device)', await resigned(A, A.d1, e1, (e) => { e.author.did = B.did; }), null, /not listed|does not end/);

  // ================================================================ the point of the author's log: "until the device was removed"
  const pt0 = await W.logPoint({ inception: A.log.inception, events: [] });          // the log before the second device was added
  const e1ok = await version(A, A.d1, u1, { point: pt0 });
  const pt1 = await A.point();                                   // after the device A2 was added: seq 1
  ok('the point of a log is the number of events after the inception and the hash of the last of them', pt1.seq === 1 && pt0.seq === 0 && pt0.head !== pt1.head && pt1.head === kd.b64u(await kd.eventHash(A.log.events[0].event)));
  const eAt0byA2 = await version(A, A2, edit(await peerDoc(A2, NONCE1), (d) => d.getText('body').insert(0, 'x')), { point: pt0 });
  await refusedBy('a device cannot write at a point of the log where it was not listed yet', eAt0byA2, null, /not listed/);
  const eAt1byA2 = await version(A, A2, edit(await peerDoc(A2, NONCE1), (d) => d.getText('body').insert(0, 'x')), { point: pt1 });
  const rA2 = await W.verifyVersion(eAt1byA2, ctx);
  ok('the same device can write once the point is the one that added it', rA2.ok === true, rA2);
  ok('and the first device can still write at the earlier point', (await W.verifyVersion(e1ok, ctx)).ok === true);
  const seqRemoved = await A.removeDevice(A2);                   // the removal is event number 2
  const ptBefore = pt1, ptAtRemoval = await A.point();
  ok('the removal is at position 2 and the point after it names it', seqRemoved === 2 && ptAtRemoval.seq === 2);
  const lateButHonest = await W.verifyVersion(eAt1byA2, ctx);
  ok('an edit the device made while it was listed STAYS valid after the device was removed: the receiver now holds the removal and still accepts it', lateButHonest.ok === true, lateButHonest);
  const eAfter = await version(A, A2, edit(await peerDoc(A2, NONCE2), (d) => d.getText('body').insert(0, 'y')), { point: ptAtRemoval, nonces: [NONCE2] });
  await refusedBy('an edit that claims a point where the device was already removed is refused', eAfter, null, /not listed/);
  const eLieOld = await version(A, A2, edit(await peerDoc(A2, NONCE2), (d) => d.getText('body').insert(0, 'z')), { point: ptBefore, nonces: [NONCE2] });
  ok('KNOWN LIMIT: an edit signed after the removal that claims an old point is accepted, because nothing in it can say when it was made', (await W.verifyVersion(eLieOld, ctx)).ok === true);
  const farAhead = await version(A, A.d1, u1, { point: { seq: 9, head: pt1.head } });
  const rFar = await W.verifyVersion(farAhead, ctx);
  ok('an edit that names a point the receiver\'s copy of the log has not reached yet waits instead of being refused', rFar.ok === false && rFar.pending === true && rFar.waitFor.log === A.did && rFar.waitFor.seq === 9, rFar);
  const ctxShort = makeCtx(people, { logOf: (p) => ({ inception: p.log.inception, sigs: p.log.sigs, events: p.log.events.slice(0, 1) }) });
  const rShort = await W.verifyVersion(eAfter, ctxShort);
  ok('a receiver that holds only the log up to the device\'s addition cannot yet say the later edit is wrong: it waits', rShort.pending === true, rShort);
  ok('and a receiver that holds only the earlier part of the log accepts the earlier edit, as the receiver with the whole log does', (await W.verifyVersion(eAt1byA2, ctxShort)).ok === true);
  const noLog = makeCtx([B, C]);
  const rNoLog = await W.verifyVersion(e1, noLog);
  ok('an edit whose author\'s log the receiver does not hold waits', rNoLog.pending === true && rNoLog.waitFor.log === A.did, rNoLog);
  await refusedBy('a head that is not the head of the author\'s log at that point is refused', tamper(e1ok, (c) => { c.event.authorLog.head = pt1.head; }), null, /does not end where|signature/);
  await refusedBy('an edit RE-SIGNED with another point\'s head (so only the head can give it away) is refused', await resigned(A, A.d1, e1ok, (e) => { e.authorLog.head = pt1.head; }), null, /does not end where/);
  await refusedBy('a point that is not a whole number is refused', await resigned(A, A.d1, e1ok, (e) => { e.authorLog.seq = 1.5; }), null, /point of the author/);
  await refusedBy('a negative point is refused', await resigned(A, A.d1, e1ok, (e) => { e.authorLog.seq = -1; }), null, /point of the author/);
  const evilLog = makeCtx(people, { logOf: (p) => (p === A ? { inception: B.log.inception, sigs: B.log.sigs, events: [] } : p.log) });
  await refusedBy('a log that belongs to another identity is refused for the author', e1ok, evilLog, /does not verify/);
  const brokenLog = makeCtx(people, { logOf: (p) => (p === A ? { inception: A.log.inception, sigs: Object.assign({}, A.log.sigs, { discovery: 'AAAA' }), events: [] } : p.log) });
  await refusedBy('an author log whose own signatures do not verify is refused', e1ok, brokenLog, /does not verify/);
  const forkedLog = makeCtx(people, { logOf: (p) => (p === A ? { inception: A.log.inception, sigs: A.log.sigs, events: [{ event: Object.assign({}, A.log.events[0].event, { time: '2001-01-01T00:00:00.000Z' }), sigs: A.log.events[0].sigs }] } : p.log) });
  await refusedBy('a receiver whose copy of the author\'s log differs at that point (a fork) refuses the edit rather than guessing', eAt1byA2, forkedLog, /does not verify|does not end where/);
  await refusedBy('a removal event nobody signed in the log makes the whole log fail, so no edit at that point verifies', eAfter, makeCtx(people, { logOf: (p) => (p === A ? { inception: A.log.inception, sigs: A.log.sigs, events: [A.log.events[0], { event: A.log.events[1].event, sigs: { authority: [] } }] } : p.log) }), /does not verify/);

  // ================================================================ remembering that an author's log checked out
  // A receiver may hand over a logCheckCache so that the many edits of one page do not each check the same log again. Nothing that was
  // refused may stop being refused: the cache holds answers of "it verified" only, under a hash of the exact prefix that was presented.
  // `kd.verifyLog` is wrapped here to count how often the log is really checked.
  {
    const realVerifyLog = kd.verifyLog; let calls = 0;
    kd.verifyLog = function () { calls++; return realVerifyLog.apply(this, arguments); };
    try {
      const P = await makePerson(), R = await makePerson();
      const P2 = await P.addDevice();                                    // P's log: the inception and one event
      const pt0 = await W.logPoint({ inception: P.log.inception, events: [] }), pt1 = await P.point();
      const mk = async (who, dev, text, point) => { const objId = W.pageId(who.did, 'cache-page'); return version(who, dev, edit(await peerDoc(dev, NONCE1, objId), (d) => d.getText('body').insert(0, text)), { objId, point }); };
      const cache = W.logCheckCache();
      const withCache = (o) => Object.assign(makeCtx([P, R], o), { logChecks: cache });
      const x1 = await mk(P, P.d1, 'one', pt1), x2 = await mk(P, P.d1, 'two', pt1);
      let c0 = calls;
      const plain1 = await W.verifyVersion(x1, makeCtx([P, R])), plain2 = await W.verifyVersion(x2, makeCtx([P, R]));
      ok('without a cache every edit checks its author\'s log in full', plain1.ok && plain2.ok && calls - c0 === 2, calls - c0);
      c0 = calls;
      const h1 = await W.verifyVersion(x1, withCache()), h2 = await W.verifyVersion(x2, withCache()), h3 = await W.verifyVersion(x1, withCache());
      ok('with a cache the log is checked once, and the next edits at the same point of it are served from the cache', h1.ok && h2.ok && h3.ok && calls - c0 === 1 && cache.size === 1, { calls: calls - c0, size: cache.size });
      ok('and the answers are the same as without one', JSON.stringify(h1) === JSON.stringify(plain1) && JSON.stringify(h2) === JSON.stringify(plain2) && JSON.stringify(h3) === JSON.stringify(plain1));
      c0 = calls;
      const xOld = await mk(P, P.d1, 'old', pt0);
      const rOld = await W.verifyVersion(xOld, withCache());
      ok('an edit at an EARLIER point of the log is another prefix: checked once more, and the later point is still remembered', rOld.ok && calls - c0 === 1 && (await W.verifyVersion(x1, withCache())).ok && calls - c0 === 1 && cache.size === 2, { calls: calls - c0, size: cache.size });
      const P3 = await P.addDevice(), pt2 = await P.point();             // the log has grown by one event
      const xNew = await mk(P, P3, 'new', pt2);
      c0 = calls;
      ok('a log that has grown is a new prefix: it is checked again, and an edit by the device it added verifies', (await W.verifyVersion(xNew, withCache())).ok && calls - c0 === 1 && (await W.verifyVersion(xNew, withCache())).ok && calls - c0 === 1);
      const rEarly = await W.verifyVersion(await mk(P, P3, 'early', pt1), withCache());
      ok('and that device still cannot write at the older point the cache holds (what is remembered lists the devices of THAT point)', rEarly.ok === false && /not listed/.test(rEarly.error), rEarly);

      // A FORK of the same length, validly signed by the same authority key: it verifies by itself, and it must not get the answer
      // remembered for the real log (a key of identity and number of events would hand it over), nor the real log the fork's.
      const forkDev = await makeDevice();
      const forkEvent = await kd.addDeviceEvent(P.log.inception, { id: forkDev.id, jwk: forkDev.jwk, addedAt: new Date().toISOString() });
      const forkLog = { inception: P.log.inception, sigs: P.log.sigs, events: [{ event: forkEvent, sigs: { authority: [Object.assign({ keyId: P.keyId }, await assertion(P.authPair.privateKey, await kd.eventHash(forkEvent)))] } }] };
      const forkPt = await W.logPoint(forkLog);
      ok('(the fork is a real log of the same length: it verifies by itself and ends in another event)', (await realVerifyLog(forkLog, P.did)).ok === true && forkPt.seq === pt1.seq && forkPt.head !== pt1.head);
      const onFork = () => withCache({ logOf: (p) => (p === P ? forkLog : p.log) });
      await refusedBy('an edit made on the real log is refused by a receiver that holds the fork, though the real log\'s answer is in the cache', x1, onFork(), /does not end where/);
      ok('an edit by the fork\'s own device verifies against the fork (it is not served the real log\'s answer, which does not list that device)', (await W.verifyVersion(await mk(P, forkDev, 'fork', forkPt), onFork())).ok === true);
      await refusedBy('and the real log\'s own second device is not listed in the fork', await mk(P, P2, 'p2', forkPt), onFork(), /not listed/);
      ok('while the real log is still served its own answer afterwards', (await W.verifyVersion(x1, withCache())).ok === true);

      // The same events with a signature that does not verify: an event's hash does not cover its signatures, so (identity, number of
      // events, hash of the last) would be the same key as the good log's.
      const logWith = (sigs0) => ({ inception: P.log.inception, sigs: P.log.sigs, events: [{ event: P.log.events[0].event, sigs: sigs0 }] });
      const goodSig = P.log.events[0].sigs.authority[0];
      for (const [what, sigs0] of [['has no signatures', { authority: [] }], ['carries a signature made for another event', { authority: [Object.assign({}, goodSig, { signature: P.log.events[1].sigs.authority[0].signature })] }]]) {
        await refusedBy('the SAME events as a log the cache holds, with an event that ' + what + ', are refused: the key covers the signatures too', x1, withCache({ logOf: (p) => (p === P ? logWith(sigs0) : p.log) }), /does not verify/);
      }
      const badCtx = () => withCache({ logOf: (p) => (p === P ? logWith({ authority: [] }) : p.log) });
      const sizeBefore = cache.size; c0 = calls;
      await W.verifyVersion(x1, badCtx()); await W.verifyVersion(x1, badCtx());
      ok('a refusal is not remembered: each time the bad log is checked in full, and the cache does not grow', calls - c0 === 2 && cache.size === sizeBefore, { calls: calls - c0, size: cache.size, sizeBefore });

      // A log that is not plain JSON is looked up under no key at all. canonicalJson leaves out a member that is undefined, so this log has
      // the same canonical text as the good one while verifyLog refuses it (a removal may say nothing more than what it removes).
      const R2 = await R.addDevice(); await R.removeDevice(R2);
      const y1 = await mk(R, R.d1, 'r1', await R.point());
      ok('a log with a removal verifies and is remembered', (await W.verifyVersion(y1, withCache())).ok === true);
      const odd = clone(R.log); odd.events[1].event.remove.zzz = undefined;
      ok('(the variant has the very same canonical text as the log that was remembered)', kd.canonicalJson(odd) === kd.canonicalJson(R.log));
      c0 = calls;
      await refusedBy('and is refused without a cache', y1, makeCtx([P, R], { logOf: (p) => (p === R ? odd : p.log) }), /does not verify/);
      await refusedBy('and with one that holds the good log\'s answer', y1, withCache({ logOf: (p) => (p === R ? odd : p.log) }), /does not verify/);
      ok('(it was checked in full both times: it never reached the cache)', calls - c0 === 2, calls - c0);

      // what stays outside the cache: the edit's own signature, and the point it claims
      await refusedBy('the edit\'s own signature is still checked at a point the cache holds', tamper(x1, (c) => { c.event.created = '2001-01-01T00:00:00.000Z'; }), withCache(), /signature/);
      await refusedBy('and so is the head it claims for the point (re-signed, so only the head gives it away)', await resigned(P, P.d1, x1, (e) => { e.authorLog.head = pt0.head; }), withCache(), /does not end where/);
      await refusedBy('and so is whether the author\'s device is listed at that point (a stranger\'s key)', await resigned(P, strangerDev, x1, (e) => { e.author.deviceId = strangerDev.id; e.clients[0].id = 1; }), withCache(), /not listed/);

      const small = W.logCheckCache(3);
      ['a', 'b', 'c'].forEach((k) => small.set(k, k)); small.get('a'); small.set('d', 'd');
      ok('the cache is bounded and drops the entry used longest ago (a use counts)', small.size === 3 && small.get('b') === undefined && small.get('a') === 'a' && small.get('c') === 'c' && small.get('d') === 'd');
      small.clear();
      ok('and it can be emptied', small.size === 0 && small.get('a') === undefined);
    } finally { kd.verifyLog = realVerifyLog; }
  }

  // ================================================================ client ids: the rule that stops a forged id
  const docB = await peerDoc(B.d1, NONCE1);
  await accept(ctx, e1);
  const ctxAll = ctx;
  const idOfA = await W.clientIdFor(A.d1.id, OBJ, NONCE1);
  ok('the author\'s derived client id is the one its document edited with', e1.event.clients[0].id === idOfA && docA.clientID === idOfA && Y.decodeUpdate(u1).structs[0].id.client === idOfA);
  // B writes an update with A's client id (the forgery) and signs it with B's own, perfectly valid device key
  const forger = new Y.Doc(); forger.clientID = idOfA;
  const forged = edit(forger, (d) => d.getText('body').insert(0, 'EVIL'));
  const eForged = await version(B, B.d1, forged, { nonces: [NONCE1] });
  await refusedBy('an edit written under ANOTHER person\'s client id is refused, though it is validly signed by a listed device', eForged, null, /client id \d+, which is not one of this author/);
  ok('(why the rule exists: two receivers that apply a real edit and a forged one under the same client id in opposite orders end with different pages, for good)', (() => {
    const base = new Y.Doc(); base.clientID = idOfA; base.getText('body').insert(0, 'hello');
    const common = Y.encodeStateAsUpdate(base);
    const legit = edit(base, (d) => d.getText('body').insert(5, ' LEGIT'));            // the author's own next edit: clock 5 onward
    const f = new Y.Doc(); f.clientID = idOfA; f.getText('body').insert(0, 'hello');   // someone else, who knows the id and the first five letters
    const forgedNext = edit(f, (d) => d.getText('body').insert(5, ' EVIL'));          // writing under that id at the same clock
    const x = new Y.Doc(), y = new Y.Doc(); Y.applyUpdate(x, common); Y.applyUpdate(y, common);
    Y.applyUpdate(x, legit); Y.applyUpdate(x, forgedNext);
    Y.applyUpdate(y, forgedNext); Y.applyUpdate(y, legit);
    const tx = x.getText('body').toString(), ty = y.getText('body').toString();
    return tx !== ty && Buffer.from(Y.encodeStateVector(x)).equals(Buffer.from(Y.encodeStateVector(y)));      // different text, EQUAL state vectors: nothing can notice it
  })());
  const twoNonces = await version(A, A.d1, edit(await peerDoc(A.d1, NONCE2), (d) => d.getText('body').insert(0, 'second client')), { nonces: [NONCE2] });
  ok('an edit written under another one of the author\'s own derived ids, when it declares it, is fine', (await W.verifyVersion(twoNonces, ctx)).ok === true);
  await refusedBy('an edit whose struct uses one of the author\'s ids that it did NOT declare is refused', await version(A, A.d1, edit(await peerDoc(A.d1, NONCE2), (d) => d.getText('body').insert(0, 'q')), { nonces: [NONCE1] }), null, /not one of this author/);
  const bothDeclared = await version(A, A.d1, (() => { const d1 = new Y.Doc(); d1.clientID = idOfA; const u = edit(d1, (d) => d.getText('t').insert(0, 'a')); return u; })(), { nonces: [NONCE1, NONCE2] });
  ok('declaring more of one\'s ids than are used is fine', (await W.verifyVersion(bothDeclared, ctx)).ok === true);
  await refusedBy('a client id that is not derived from the nonce is refused', await resigned(A, A.d1, e1, (e) => { e.clients[0].id = idOfA + 1; }), null, /not the one this author/);
  await refusedBy('the same client id stated twice is refused', await resigned(A, A.d1, e1, (e) => { e.clients.push({ nonce: NONCE1, id: idOfA }); }), null, /stated twice/);
  await refusedBy('more client ids than the limit are refused', await resigned(A, A.d1, e1, (e) => { e.clients = Array.from({ length: W.MAX_CLIENTS + 1 }, (_, i) => ({ nonce: 'nonce-limit' + i, id: 1 })); }), null, /client ids/);
  await refusedBy('no client ids at all is refused', await resigned(A, A.d1, e1, (e) => { e.clients = []; }), null, /client ids/);
  // a delete that names ANOTHER person's content is allowed: any writer may delete anything, as in a wiki
  const sync = new Y.Doc(); sync.clientID = await W.clientIdFor(B.d1.id, OBJ, NONCE1); Y.applyUpdate(sync, Y.encodeStateAsUpdate(docA));
  const deleting = edit(sync, (d) => d.getText('body').delete(0, 3));
  const eDel = await version(B, B.d1, deleting, { parents: [r1.cid] });
  const rDel = await W.verifyVersion(eDel, ctx);
  ok('an edit that deletes another person\'s text verifies (its delete set names their client id, its structs carry only its own)', rDel.ok === true && Object.keys(U.readUpdate(deleting).deletes).includes(String(idOfA)), rDel);
  ok('an edit that carries nothing at all (no structs, no deletes) is a valid merge or marker event', (await W.verifyVersion(await version(A, A.d1, Y.encodeStateAsUpdate(new Y.Doc()), { parents: [r1.cid] }), ctx)).ok === true);
  const subdoc = new Y.Doc(); subdoc.clientID = idOfA; const sd = edit(subdoc, (d) => d.getMap('m').set('child', new Y.Doc()));
  await refusedBy('an edit that holds a sub-document is refused: a wiki page has none', await version(A, A.d1, sd), null, /sub-document/);

  // ================================================================ the two readers agree on real updates, and disagree on none of many damaged ones
  const rng = (() => { let s = 20261115; return () => { s = (s + 0x6D2B79F5) | 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; })();
  const rint = (n) => Math.floor(rng() * n);
  const WORDS = ['alpha', 'beta', 'gamma', '😀 emoji', 'naïve café', '日本語', 'tab\tand\nnewline', '', 'x'.repeat(200)];
  function randomDoc(gc) {
    const d = new Y.Doc({ gc }); d.clientID = rint(2 ** 40) + 1;
    const updates = [];
    const step = (fn) => updates.push(edit(d, fn));
    const t = d.getText('t'), m = d.getMap('m'), a = d.getArray('a'), x = d.getXmlFragment('x');
    const n = 4 + rint(12);
    for (let i = 0; i < n; i++) {
      switch (rint(11)) {
        case 0: step(() => t.insert(rint(t.length + 1), WORDS[rint(WORDS.length)])); break;
        case 1: if (t.length) step(() => t.delete(rint(t.length), 1 + rint(3))); break;
        case 2: if (t.length) step(() => t.format(0, Math.max(1, rint(t.length)), { bold: true, link: rint(2) ? 'https://example.org' : null })); break;
        case 3: step(() => t.insertEmbed(rint(t.length + 1), { image: 'h' + rint(99) })); break;
        case 4: step(() => m.set('k' + rint(5), [{ n: rint(1000) - 500, f: rng() * 100, s: WORDS[rint(WORDS.length)], b: rint(2) === 0, z: null, u: undefined, big: BigInt(rint(1e6)), bytes: new Uint8Array([1, 2, 3]) }])); break;
        case 5: step(() => m.set('bin' + rint(3), new Uint8Array([rint(256), rint(256)]))); break;
        case 6: step(() => a.push([rint(100), WORDS[rint(WORDS.length)], { deep: { er: [1, [2, [3]]] } }])); break;
        case 7: if (a.length) step(() => a.delete(rint(a.length), 1)); break;
        case 8: step(() => { const el = new Y.XmlElement(['p', 'h1', 'code_cell'][rint(3)]); el.setAttribute('lang', 'scheme'); const tx = new Y.XmlText(); tx.insert(0, WORDS[rint(WORDS.length)]); el.insert(0, [tx]); x.insert(rint(x.length + 1), [el]); }); break;
        case 9: step(() => m.set('nested', new Y.Map())); step(() => m.get('nested').set('inner', new Y.Text('abc'))); break;
        case 10: if (x.length) step(() => x.delete(rint(x.length), 1)); break;
      }
    }
    return { doc: d, updates };
  }
  const corpus = [];
  let agreeFull = 0, vectorAgrees = 0, structTotal = 0;
  for (let i = 0; i < 120; i++) {
    const { doc, updates } = randomDoc(i % 3 !== 0);
    const full = Y.encodeStateAsUpdate(doc);
    for (const u of [full].concat(updates)) {
      const mine = U.readUpdate(u), theirs = Y.decodeUpdate(u), diff = U.sameAs(mine, theirs, Y);
      if (diff) ok('the readers agree on a generated update', false, diff); else agreeFull++;
      structTotal += mine.structs.length;
      corpus.push(u);
    }
    // what applying the full state really integrates: the clock each client reaches is the sum of its struct lengths
    const scratch = new Y.Doc(); Y.applyUpdate(scratch, full);
    const sv = Y.decodeStateVector(Y.encodeStateVector(scratch)), reach = {};
    U.readUpdate(full).structs.forEach((s) => { reach[s.client] = (reach[s.client] || 0) + s.length; });
    if (Object.keys(reach).every((c) => sv.get(Number(c)) === reach[c]) && Object.keys(reach).length === sv.size) vectorAgrees++;
  }
  ok('the small reader and Yjs\'s decoder agree on every one of ' + agreeFull + ' generated updates (' + structTotal + ' structs: text, formats, embeds, maps, arrays, nested types, xml, binary, deletions, with and without garbage collection)', agreeFull > 1000, agreeFull);
  ok('and the clock each client reaches after APPLYING a full state equals the sum of the lengths the small reader found (so its lengths are the ones Yjs integrates)', vectorAgrees === 120, vectorAgrees);
  const kinds = new Set(), refs = new Set();
  corpus.forEach((u) => U.readUpdate(u).structs.forEach((s) => { kinds.add(s.kind); if (s.ref) refs.add(s.ref); }));
  ok('the generated updates covered structs, garbage-collected ranges, and content kinds ' + Array.from(refs).sort().join(','), kinds.has('item') && kinds.has('gc') && [1, 3, 4, 5, 6, 7, 8].every((r) => refs.has(r)), { kinds: Array.from(kinds), refs: Array.from(refs) });
  const gapDoc = new Y.Doc(); gapDoc.clientID = 4242;
  const gapUpdates = [0, 1, 2].map((i) => edit(gapDoc, (d) => d.getText('t').insert(i, 'abc')));
  const merged = Y.mergeUpdates([gapUpdates[0], gapUpdates[2]]);                      // the middle edit is missing: Yjs writes a Skip for the hole
  ok('an update with a gap in it (merged from two edits of one client that do not touch) is read the same, its Skip struct included', U.readUpdate(merged).structs.some((s) => s.kind === 'skip') && U.sameAs(U.readUpdate(merged), Y.decodeUpdate(merged), Y) === null);
  // a legacy JSON-content struct and a sub-document, which the generator does not make, written byte by byte
  const varStr = (s) => { const b = Buffer.from(s); return Buffer.concat([Buffer.from([b.length]), b]); };
  const legacy = Buffer.concat([Buffer.from([1, 1, 5, 0, 2, 1]), varStr('t'), Buffer.from([2]), varStr('{"a":1}'), varStr('undefined'), Buffer.from([0])]);
  ok('a legacy JSON content struct (two entries, one the text "undefined") is read the same by both', U.sameAs(U.readUpdate(new Uint8Array(legacy)), Y.decodeUpdate(new Uint8Array(legacy)), Y) === null && U.readUpdate(new Uint8Array(legacy)).structs[0].length === 2);
  const subdocBytes = Y.encodeStateAsUpdate((() => { const d = new Y.Doc(); d.clientID = 7; d.getMap('m').set('c', new Y.Doc()); return d; })());
  ok('a sub-document struct is read the same by both, and the reader reports its content kind so the check can refuse it', U.sameAs(U.readUpdate(subdocBytes), Y.decodeUpdate(subdocBytes), Y) === null && U.readUpdate(subdocBytes).structs.some((s) => s.ref === U.CONTENT.DOC));

  // sameAs must SEE every kind of difference: the fuzz below only ever finds updates the readers agree on, so make Yjs's answer differ by hand
  {
    const dd = new Y.Doc(); dd.clientID = 31; const tt = dd.getText('t'); tt.insert(0, 'hello'); const base1 = Y.encodeStateAsUpdate(dd);
    dd.getText('t').delete(1, 2); const withDelete = Y.encodeStateAsUpdate(dd);
    const mineD = U.readUpdate(withDelete), fresh = () => Y.decodeUpdate(withDelete);
    ok('sameAs says nothing when the two agree (the control for what follows)', U.sameAs(mineD, fresh(), Y) === null && mineD.structs.length >= 1 && Object.keys(mineD.deletes).length === 1);
    const differs = (name, f) => { const d = fresh(); f(d); const s = U.sameAs(mineD, d, Y); ok('sameAs sees it when ' + name, typeof s === 'string' && s.length > 0, s); };
    differs('Yjs found one struct fewer', (d) => { d.structs.pop(); });
    differs('Yjs found one struct more', (d) => { d.structs.push(d.structs[0]); });
    differs('a struct has another client id', (d) => { d.structs[0].id = Y.createID(32, d.structs[0].id.clock); });
    differs('a struct has another clock', (d) => { d.structs[0].id = Y.createID(d.structs[0].id.client, d.structs[0].id.clock + 1); });
    differs('a struct has another length', (d) => { d.structs[0].length += 1; });
    differs('a struct is a garbage-collected range in Yjs\'s eyes and an item in ours', (d) => { d.structs[0] = new Y.GC(d.structs[0].id, d.structs[0].length); });
    differs('a struct is a skip in Yjs\'s eyes and an item in ours', (d) => { d.structs[0] = new Y.Skip(d.structs[0].id, d.structs[0].length); });
    differs('Yjs found no deleted ranges', (d) => { d.ds.clients.clear(); });
    differs('Yjs found a deleted range for another client', (d) => { d.ds.clients.set(999, d.ds.clients.get(31)); d.ds.clients.delete(31); });
    differs('Yjs found a deleted range starting elsewhere', (d) => { d.ds.clients.get(31)[0].clock += 1; });
    differs('Yjs found a deleted range of another length', (d) => { d.ds.clients.get(31)[0].len += 1; });
    differs('Yjs found one deleted range more', (d) => { d.ds.clients.get(31).push(d.ds.clients.get(31)[0]); });
    differs('Yjs found a deleted range for a second client', (d) => { d.ds.clients.set(40, [d.ds.clients.get(31)[0]]); });
    ok('sameAs refuses what is not a decoded update at all', U.sameAs(mineD, null, Y) !== null && U.sameAs(mineD, {}, Y) !== null && U.sameAs(mineD, { structs: [], ds: {} }, Y) !== null);
    ok('and the update with no deletes, as Yjs and the small reader see it, has an empty deleted set on both sides', U.sameAs(U.readUpdate(base1), Y.decodeUpdate(base1), Y) === null && Object.keys(U.readUpdate(base1).deletes).length === 0);
  }

  // damaged updates: flip, cut, add, insert, remove and repeat bytes of the corpus, and compare what each reader does with the SAME bytes
  const mutate = (u) => {
    const b = Array.from(u);
    switch (rint(6)) {
      case 0: b[rint(b.length)] = rint(256); break;
      case 1: b.length = rint(b.length); break;
      case 2: for (let i = 0, n = 1 + rint(4); i < n; i++) b.push(rint(256)); break;
      case 3: b.splice(rint(b.length + 1), 0, rint(256)); break;
      case 4: b.splice(rint(b.length), 1); break;
      case 5: { const at = rint(b.length), n = 1 + rint(6); b.splice(at, 0, ...b.slice(at, at + n)); break; }
    }
    return new Uint8Array(b);
  };
  const tally = { bothThrow: 0, bothReadAndAgree: 0, bothReadButDiffer: 0, onlyYjsThrows: 0, onlySmallThrows: 0 };
  const examples = {}, smallWhy = {};
  const N = 30000;
  for (let i = 0; i < N; i++) {
    const u = mutate(corpus[rint(corpus.length)]);
    let mine = null, theirs = null;
    try { mine = U.readUpdate(new Uint8Array(u)); } catch (e) { /* refused */ }
    try { theirs = Y.decodeUpdate(new Uint8Array(u)); } catch (e) { /* refused */ }
    const key = mine && theirs ? (U.sameAs(mine, theirs, Y) ? 'bothReadButDiffer' : 'bothReadAndAgree') : !mine && !theirs ? 'bothThrow' : theirs ? 'onlySmallThrows' : 'onlyYjsThrows';
    tally[key]++;
    if (!examples[key]) examples[key] = Buffer.from(u).toString('hex').slice(0, 80);
    if (key === 'onlySmallThrows') { try { U.readUpdate(new Uint8Array(u)); } catch (e) { const why = e.message.replace('keoYUpdate: ', ''); smallWhy[why] = (smallWhy[why] || 0) + 1; } }
  }
  console.log('     (damaged-update comparison, seeded, ' + N + ' updates: ' + JSON.stringify(tally) + ')');
  console.log('     (why the small reader refused alone: ' + JSON.stringify(smallWhy) + ')');
  ok('on ' + N + ' damaged updates the two readers NEVER read the same bytes differently (' + tally.bothReadAndAgree + ' read by both and equal, ' + tally.bothThrow + ' refused by both)', tally.bothReadButDiffer === 0 && tally.bothReadAndAgree > 1000 && tally.bothThrow > 1000, { tally, example: examples.bothReadButDiffer });
  ok('(where only one of them refuses, the check refuses: ' + tally.onlySmallThrows + ' updates the small reader refused alone, ' + tally.onlyYjsThrows + ' only Yjs refused)', true);
  const trailing = Buffer.concat([Buffer.from(corpus[0]), Buffer.from([0])]);
  ok('bytes after the end of an update are refused by the small reader although Yjs ignores them', (() => { try { U.readUpdate(new Uint8Array(trailing)); return false; } catch (e) { return true; } })() && (() => { try { Y.decodeUpdate(new Uint8Array(trailing)); return true; } catch (e) { return false; } })());
  ok('a number above 2^53-1 is refused by the small reader (Yjs lets it lose precision)', (() => { try { U.readUpdate(new Uint8Array([1, 1, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x7f, 0, 0, 0])); return false; } catch (e) { return /2\^53/.test(e.message); } })());
  ok('a skip with a flag bit set is refused by both (Yjs\'s two readers disagree about it, so it must not pass)', (() => { const b = new Uint8Array([1, 1, 5, 0, 10 | 32, 3, 0]); let m = false, t = false; try { U.readUpdate(b); } catch (e) { m = true; } try { Y.decodeUpdate(b); } catch (e) { t = true; } return m && t; })());
  // the check really needs both readers: a Yjs that read the same bytes differently stops the edit
  const lyingY = Object.assign({}, Y, { decodeUpdate: (u) => { const r = Y.decodeUpdate(u); r.structs[0].id.client = 99; return r; } });
  await refusedBy('an edit is refused when Yjs\'s decoder and the small reader do not agree on what is in it', e1, makeCtx(people, { Y: lyingY }), /two readers/);
  const throwingY = Object.assign({}, Y, { decodeUpdate: () => { throw new Error('boom'); } });
  await refusedBy('and when only Yjs\'s decoder refuses', e1, makeCtx(people, { Y: throwingY }), /Yjs reads/);
  await refusedBy('and when only the small reader refuses (bytes after the end)', await version(A, A.d1, new Uint8Array(trailing), { nonces: [NONCE1] }), null, /well-formed/);

  // ================================================================ parents: the history is a set of versions
  const store = makeCtx(people);
  const g1 = await version(A, A.d1, u1);
  const rg1 = await accept(store, g1);
  const lateParent = await version(A, A.d1, edit(docA, (d) => d.getText('body').insert(5, ' (parent)')), { parents: [rg1.cid] });
  const lateParentCid = await W.versionId(lateParent.event);
  const child = await version(A, A.d1, edit(docA, (d) => d.getText('body').insert(0, '(child) ')), { parents: [lateParentCid] });
  const rUnk = await W.verifyVersion(child, store);
  ok('an edit that follows a version the receiver does not hold waits for it, and says which', rUnk.pending === true && JSON.stringify(rUnk.waitFor.parents) === JSON.stringify([lateParentCid]), rUnk);
  await accept(store, lateParent);
  const rUnk2 = await W.verifyVersion(child, store);
  ok('a pending edit is NOT refused: the very same envelope verifies once its parent has arrived', rUnk2.ok === true, rUnk2);
  const unknownParent = await version(B, B.d1, edit(docB, (d) => d.getText('body').insert(0, 'later')), { parents: ['q'.repeat(43)] });
  ok('(an edit with a bad signature is refused even while a parent is missing: pending never hides a bad edit)', (await W.verifyVersion(tamper(unknownParent, (c) => { c.event.created = '2001-01-01T00:00:00.000Z'; }), store)).pending !== true);
  // two people edit at the same time on top of g1, then A merges them
  const docOfB = await peerDoc(B.d1, NONCE1); Y.applyUpdate(docOfB, u1);
  const docM = await peerDoc(A.d1, NONCE1); docM.getText('body').insert(0, 'hello');       // A's own document, with exactly what A has sent so far and nothing else
  const uA2 = edit(docM, (d) => d.getText('body').insert(5, ' from A'));
  const uB2 = edit(docOfB, (d) => d.getText('body').insert(0, 'B says: '));
  const gA = await version(A, A.d1, uA2, { parents: [rg1.cid] }), gB = await version(B, B.d1, uB2, { parents: [rg1.cid] });
  const rgA = await accept(store, gA), rgB = await accept(store, gB);
  ok('two edits made at the same time on the same version both verify', rgA.ok && rgB.ok && rgA.cid !== rgB.cid, [rgA, rgB]);
  const get = (cid) => store.store.get(cid);
  ok('the page then has TWO heads', JSON.stringify(W.headsOf([rg1.cid, rgA.cid, rgB.cid], get)) === JSON.stringify([rgA.cid, rgB.cid].sort()));
  const merge = await version(A, A.d1, Y.encodeStateAsUpdate(new Y.Doc()), { parents: [rgA.cid, rgB.cid] });
  const rM = await accept(store, merge);
  ok('an event that names both heads (with nothing to add) merges them and verifies', rM.ok === true, rM);
  ok('after the merge the page has ONE head again', JSON.stringify(W.headsOf([rg1.cid, rgA.cid, rgB.cid, rM.cid], get)) === JSON.stringify([rM.cid]));
  const cl = W.closure([rM.cid], get);
  ok('the closure of the merge lists every version, parents first, and nothing is missing', cl.order.length === 4 && cl.missing.length === 0 && cl.order[0] === rg1.cid && cl.order[3] === rM.cid, cl);
  ok('the closure is listed in the same order whatever order the heads are given in', JSON.stringify(W.closure([rgB.cid, rgA.cid], get).order) === JSON.stringify(W.closure([rgA.cid, rgB.cid], get).order));
  ok('a version named but not held is reported missing, not skipped', W.closure([rM.cid, 'm'.repeat(43)], get).missing.join() === 'm'.repeat(43));
  // the state of a version is what applying its closure gives, in ANY order
  const updatesOf = cl.order.map((c) => kd.unb64u(get(c).event.payload.update));
  const permute = (arr) => arr.length <= 1 ? [arr] : arr.flatMap((x, i) => permute(arr.slice(0, i).concat(arr.slice(i + 1))).map((p) => [x].concat(p)));
  const texts = new Set();
  permute(updatesOf).forEach((p) => { const d = new Y.Doc(); p.forEach((u) => Y.applyUpdate(d, u)); texts.add(d.getText('body').toString()); });
  ok('applying the four updates in each of the 24 possible orders gives the same page (' + JSON.stringify(Array.from(texts)[0]) + ')', texts.size === 1, Array.from(texts));
  ok('both people\'s edits are in it', (() => { const t = Array.from(texts)[0]; return t.includes('B says: ') && t.includes('from A') && t.includes('hello'); })(), Array.from(texts));
  // what one edit shows by itself about its own clock numbers: the run it fills under each client id, which must be one unbroken stretch
  ok('a verified edit reports the run of clock numbers it fills under each client id', (await W.verifyVersion(e1, ctx)).ranges[idOfA].start === 0 && (await W.verifyVersion(e1, ctx)).ranges[idOfA].end === 5, (await W.verifyVersion(e1, ctx)).ranges);
  const gapDoc2 = await peerDoc(A.d1, 'nonce-gap-01');
  const gapUps = [0, 1, 2].map((i) => edit(gapDoc2, (d) => d.getText('t').insert(i, 'abc')));
  const gapEvent = await version(A, A.d1, Y.mergeUpdates([gapUps[0], gapUps[2]]), { nonces: ['nonce-gap-01'] });
  await refusedBy('an edit with a hole in its own run of clock numbers (a Skip between two of its changes) is refused', gapEvent, null, /gap in the changes it writes/);
  ok('an edit that fills a run but starts above zero is fine by itself (whether it continues the author\'s earlier edits is for the store)', (await W.verifyVersion(await version(A, A.d1, gapUps[2], { nonces: ['nonce-gap-01'] }), ctx)).ranges[await W.clientIdFor(A.d1.id, OBJ, 'nonce-gap-01')].start === 6);
  // two sections for one client, written byte by byte: Yjs decodes both but applies only the last (measured below)
  const varUint = (n) => { const out = []; while (n > 127) { out.push((n % 128) | 128); n = Math.floor(n / 128); } out.push(n); return out; };
  const twoSections = new Uint8Array([2].concat([1], varUint(idOfA), [0], [0, 2], [1], varUint(idOfA), [2], [0, 3], [0]));
  const sections = new Y.Doc(); Y.applyUpdate(sections, twoSections);
  const decodedTotal = Y.decodeUpdate(twoSections).structs.reduce((n, s) => n + s.length, 0);
  ok('(measured: Yjs DECODES both sections of one client, five clock numbers in all, but applying them leaves the first section out: state vector ' + JSON.stringify(Array.from(Y.decodeStateVector(Y.encodeStateVector(sections)))) + ')', decodedTotal === 5 && U.sameAs(U.readUpdate(twoSections), Y.decodeUpdate(twoSections), Y) === null && !Y.decodeStateVector(Y.encodeStateVector(sections)).has(idOfA), { decodedTotal, sv: Array.from(Y.decodeStateVector(Y.encodeStateVector(sections))) });
  await refusedBy('an edit that writes under one client in two separate parts of the update is refused', await version(A, A.d1, twoSections, { nonces: [NONCE1] }), null, /two separate parts/);
  // KNOWN GAP, recorded so it is not forgotten: an author whose edit skips ahead of its own earlier clocks (an unsent edit in between)
  // still verifies here, and Yjs then holds that edit back as pending for ever. Keeping each author's clocks continuous is for the
  // store that holds the events, which sees the whole ancestry; this check sees one edit.
  const skipping = await version(A, A.d1, edit(docA, (d) => d.getText('body').insert(0, 'skipped ahead')), { parents: [rM.cid] });
  const skippingOk = (await W.verifyVersion(skipping, store)).ok === true, skipDoc = new Y.Doc();
  Y.applyUpdate(skipDoc, kd.unb64u(skipping.event.payload.update));
  ok('KNOWN GAP: an edit whose clock skips ahead of its author\'s earlier edits verifies, and Yjs then keeps it back (pending) instead of showing it', skippingOk && skipDoc.store.pendingStructs !== null && skipDoc.getText('body').toString() === '');
  // restoring an older version is a NEW edit on top of the current state, so nothing is lost from the history
  const now = new Y.Doc(); updatesOf.forEach((u) => Y.applyUpdate(now, u)); now.clientID = idOfA;     // A's next edit continues A's clock: it holds all of A's earlier ones
  const old = new Y.Doc(); Y.applyUpdate(old, updatesOf[0]);
  const oldText = old.getText('body').toString();
  const restoreUpdate = edit(now, (d) => { const t = d.getText('body'); t.delete(0, t.length); t.insert(0, oldText); });
  const restore = await version(A, A.d1, restoreUpdate, { parents: [rM.cid] });
  const rRestore = await accept(store, restore);
  const after = new Y.Doc(); W.closure([rRestore.cid], get).order.forEach((c) => Y.applyUpdate(after, kd.unb64u(get(c).event.payload.update)));
  ok('restoring the first version is one more event: the page reads as that version again, and the history still holds all five versions', rRestore.ok && after.getText('body').toString() === oldText && W.closure([rRestore.cid], get).order.length === 5, after.getText('body').toString());
  ok('and the version restored from, and the ones in between, can still be read in full', W.closure([rM.cid], get).order.length === 4);

  // ================================================================ who may write: as of the parents
  const policy = new Map();     // cid -> the writers as of the version that follows it
  const writersAsOf = async (objId, parents) => { if (!parents.length) return [A.did]; let w = null; for (const p of parents) { const x = policy.get(p); if (x === undefined) return null; w = w ? w.filter((d) => x.includes(d)) : x; } return w; };
  const pol = makeCtx(people, { writers: writersAsOf });
  const p0 = await version(A, A.d1, u1);
  const rp0 = await accept(pol, p0);
  ok('the page\'s owner writes the first edit when the owner is the only writer', rp0.ok === true, rp0);
  const pB = await version(B, B.d1, edit(docOfB, (d) => d.getText('body').insert(0, 'B')), { parents: [rp0.cid] });
  const rpB = await W.verifyVersion(pB, pol);
  ok('an edit follows versions whose writers are not known yet: it waits', rpB.pending === true && rpB.waitFor.writers === true, rpB);
  policy.set(rp0.cid, [A.did]);
  await refusedBy('a person who is not a writer as of the parents is refused', pB, pol, /may not write/);
  policy.set(rp0.cid, [A.did, B.did]);
  const rpB2 = await W.verifyVersion(pB, pol);
  ok('the same edit is accepted once the owner has made that person a writer', rpB2.ok === true, rpB2);
  // the owner removes B from the list in a version p2; an edit made on p1 (before the removal was seen) stays valid, one built on p2 is refused
  const p1 = await accept(pol, await version(A, A.d1, edit(docA, (d) => d.getText('body').insert(0, '1')), { parents: [rp0.cid] }));
  policy.set(p1.cid, [A.did, B.did]);
  const p2 = await accept(pol, await version(A, A.d1, edit(docA, (d) => d.getText('body').insert(0, '2')), { parents: [p1.cid] }));
  policy.set(p2.cid, [A.did]);
  const bOnP1 = await version(B, B.d1, edit(docOfB, (d) => d.getText('body').insert(0, 'b1')), { parents: [p1.cid], nonces: [NONCE1] });
  const bOnP2 = await version(B, B.d1, edit(docOfB, (d) => d.getText('body').insert(0, 'b2')), { parents: [p2.cid], nonces: [NONCE1] });
  ok('a writer removed in a later version can still have an edit made BEFORE that version (it was a writer as of its own parents)', (await W.verifyVersion(bOnP1, pol)).ok === true);
  await refusedBy('but not one built on the version that removed it', bOnP2, pol, /may not write/);
  const cOnP1 = await version(C, C.d1, edit(await peerDoc(C.d1, NONCE1), (d) => d.getText('body').insert(0, 'c')), { parents: [p1.cid] });
  await refusedBy('and a person who was never on the list is refused on any version', cOnP1, pol, /may not write/);
  // The receiver must HOLD the parent, or the edit only waits for it and never reaches the list (an earlier version of this check
  // used an empty receiver and so could not fail for the reason it names: found by breaking the rule and seeing no test notice).
  const oddList = makeCtx(people, { writers: async () => 'everyone' }); oddList.store.set(rp0.cid, p0);
  const rOdd = await W.verifyVersion(pB, oddList);
  ok('a writer list that is not a list is refused, never trusted (the parent is held, so it is the list that is judged)', rOdd.ok === false && !rOdd.pending && /may not write/.test(rOdd.error), rOdd);

  // ================================================================ the page's id: its owner and a name
  ok('a page id is the owner\'s DID, a slash and a name, and reads back', (() => { const id = W.pageId(A.did, 'notes'), p = W.parsePageId(id); return id === A.did + '/notes' && p.owner === A.did && p.name === 'notes'; })());
  ok('a name may hold slashes, spaces and any letters (it is not interpreted)', W.parsePageId(W.pageId(A.did, 'a/b c é 日本')).name === 'a/b c é 日本');
  ok('a name of exactly the longest size is a page, one more is not', !!W.parsePageId(A.did + '/' + 'n'.repeat(W.MAX_NAME)) && W.parsePageId(A.did + '/' + 'n'.repeat(W.MAX_NAME + 1)) === null);
  const DID_LEN = A.did.length;              // 104: the owner's part of a page id has exactly the length of a DID, so the shape of what stands there is the check
  const notPages = ['x'.repeat(DID_LEN) + '/notes', A.did.slice(0, DID_LEN - 1) + '!/notes', A.did + '/', A.did + 'x', A.did + '/a\u0000b', A.did + '/a\nb', A.did + '/a\u007fb', 'page-one', 'notes/' + A.did, A.did.slice(0, 50) + '/x', '/' + A.did, '', null, 5, undefined, {}];
  ok('an empty name, a missing slash, a control character in a name, an owner that is not a DID and things that are not text are all not pages', notPages.every((x) => W.parsePageId(x) === null), notPages.filter((x) => W.parsePageId(x) !== null));
  ok('pageId refuses what parsePageId would', (() => { try { W.pageId(A.did, ''); return false; } catch (e) { return true; } })() && (() => { try { W.pageId('someone', 'x'); return false; } catch (e) { return true; } })());
  ok('two owners\' pages with the same name are two pages: another id, and another client id for the same device', W.pageId(A.did, 'notes') !== W.pageId(B.did, 'notes') && await W.clientIdFor('d', W.pageId(A.did, 'notes'), 'nonce-123456') !== await W.clientIdFor('d', W.pageId(B.did, 'notes'), 'nonce-123456'));
  const noList = makeCtx(people, { writers: async () => [] }), nullList = makeCtx(people, { writers: async () => null });
  ok('the page\'s owner may always write, whatever a list says, and never waits for one', (await W.verifyVersion(e1, noList)).ok === true && (await W.verifyVersion(e1, nullList)).ok === true);
  let askedList = 0;
  const countList = makeCtx(people, { writers: async () => { askedList++; return [A.did, B.did]; } });
  await W.verifyVersion(e1, countList);
  ok('the list is not even asked about the owner', askedList === 0);
  await W.verifyVersion(await version(B, B.d1, edit(await peerDoc(B.d1, NONCE1), (d) => d.getText('body').insert(0, 'b'))), countList);
  ok('but it is asked about anyone else', askedList === 1);

  // ================================================================ a change of the writer list
  const policyOf = async (person, dev, change, o) => { o = o || {}; return W.seal(W.buildPolicy({ objId: o.objId || OBJ, parents: o.parents || [], author: { did: person.did, deviceId: dev.id }, authorLog: o.point || await person.point(), change, created: o.created }), person.signer(dev)); };
  const refusedPolicy = async (name, env, c, re) => { const r = await W.verifyPolicy(env, c || ctx); ok(name, r.ok === false && !r.pending && (!re || re.test(r.error)), r); };
  const addB = await policyOf(A, A.d1, { op: 'add-writer', did: B.did });
  const rAddB = await W.verifyPolicy(addB, ctx);
  ok('the owner\'s signed change of the list verifies, names what it changes, and writes no text', rAddB.ok === true && rAddB.policy.op === 'add-writer' && rAddB.policy.did === B.did && Object.keys(rAddB.ranges).length === 0 && rAddB.did === A.did, rAddB);
  ok('its id is the SHA-256 of the canonical event, as for an edit, and the same change signed again keeps it', rAddB.cid === kd.b64u(nodeCrypto.createHash('sha256').update(kd.canonicalJson(addB.event)).digest()) && rAddB.cid === await W.versionId((await policyOf(A, A.d1, { op: 'add-writer', did: B.did }, { created: addB.event.created })).event));
  await refusedPolicy('a change signed by someone who is not the page\'s owner is refused', await policyOf(B, B.d1, { op: 'add-writer', did: C.did }), null, /only the page's owner/);
  await refusedPolicy('so is a person making themselves a writer', await policyOf(B, B.d1, { op: 'add-writer', did: B.did }), null, /only the page's owner/);
  await refusedPolicy('a change that names the owner is refused: the owner is always a writer and cannot be removed', await policyOf(A, A.d1, { op: 'remove-writer', did: A.did }), null, /owner/);
  await refusedPolicy('changing who is added after signing is refused', tamper(addB, (c) => { c.event.change.did = C.did; }), null, /signature/);
  await refusedPolicy('changing the operation after signing is refused', tamper(addB, (c) => { c.event.change.op = 'remove-writer'; }), null, /signature/);
  await refusedPolicy('changing the page after signing is refused', tamper(addB, (c) => { c.event.objId = W.pageId(A.did, 'page-two'); }), null, /signature/);
  await refusedPolicy('changing the parents after signing is refused', tamper(addB, (c) => { c.event.parents = ['a'.repeat(43)]; }), null, /signature/);
  await refusedPolicy('a signature of a key that is not the owner\'s device is refused', await W.seal(addB.event, A.signer(strangerDev)), null, /signature/);
  await refusedPolicy('a change signed by another of the owner\'s devices than the one it names is refused', await W.seal(addB.event, A.signer(A2)), null, /signature/);
  await refusedPolicy('a change by a device the owner\'s log lists only later is refused', await policyOf(A, A2, { op: 'add-writer', did: B.did }, { point: pt0 }), null, /not listed/);
  await refusedPolicy('a change by a device that the owner\'s log had already removed at the point it claims is refused', await policyOf(A, A2, { op: 'add-writer', did: B.did }, { point: ptAtRemoval }), null, /not listed/);
  ok('but a change a device made while it was listed stays valid after it was removed', (await W.verifyPolicy(await policyOf(A, A2, { op: 'add-writer', did: B.did }, { point: pt1 }), ctx)).ok === true);
  const rPendP = await W.verifyPolicy(await policyOf(A, A.d1, { op: 'remove-writer', did: B.did }, { parents: ['q'.repeat(43)] }), ctx);
  ok('a change that follows a version that has not arrived waits for it', rPendP.pending === true && rPendP.waitFor.parents[0] === 'q'.repeat(43), rPendP);
  const rPendL = await W.verifyPolicy(addB, makeCtx([B, C]));
  ok('and one whose owner\'s log is not known here waits for the log', rPendL.pending === true && rPendL.waitFor.log === A.did, rPendL);
  await refusedPolicy('an operation that is not add-writer or remove-writer is refused', await resigned(A, A.d1, addB, (e) => { e.change.op = 'make-owner'; }), null, /does not name an identity/);
  await refusedPolicy('a change that names something that is not an identity is refused', await resigned(A, A.d1, addB, (e) => { e.change.did = 'everyone'; }), null, /does not name an identity/);
  await refusedPolicy('a change with an extra member is refused', await resigned(A, A.d1, addB, (e) => { e.change.role = 'admin'; }), null, /does not name an identity/);
  await refusedPolicy('an event with an extra member is refused', await resigned(A, A.d1, addB, (e) => { e.extra = 1; }), null, /not a change of who may write/);
  await refusedPolicy('an edit is not a change of the list', e1, null, /not a change of who may write/);
  const addAsEdit = await W.verifyVersion(addB, ctx);
  ok('and a change of the list is not an edit: the two cannot be taken for each other', addAsEdit.ok === false && /not a wiki version/.test(addAsEdit.error), addAsEdit);
  let hostileP = true, changedP = 0;
  for (let i = 0; i < 200; i++) {
    const c = clone(addB), keys = ['objId', 'parents', 'author', 'authorLog', 'change', 'created'], k = keys[rint(keys.length)];
    c.event[k] = [null, 0, 'x', [], {}, -1, 1e99, true][rint(8)];
    if (kd.canonicalJson(c.event[k]) === kd.canonicalJson(addB.event[k])) continue;
    changedP++;
    try { const r = await W.verifyPolicy(c, ctx); if (r.ok) hostileP = false; } catch (e) { hostileP = false; }
  }
  ok('200 changes with one member replaced by junk: none accepted and none throws (' + changedP + ' really changed)', hostileP && changedP > 150, changedP);
  let junkP = true;
  for (const j of [null, undefined, 0, 'x', [], {}, { event: null, sig: 'a' }, { event: {}, sig: 1 }, { event: addB.event }, { sig: 'a' }]) { try { if ((await W.verifyPolicy(j, ctx)).ok) junkP = false; } catch (e) { junkP = false; } }
  ok('nothing that is not a signed change is accepted and nothing makes the check throw', junkP);

  // ================================================================ the rule: who may write as of a set of list changes
  // Records made by hand ({ event: { change }, pol }), so the rule is tested without signatures: pol is the list changes in a change's own
  // history, itself included, which is what the store keeps.
  const O = A.did, X = B.did, Z = C.did;
  const rec = (op, did, pol) => ({ event: { change: { op, did } }, pol });
  const book = {
    a1: rec('add-writer', X, ['a1']), r1: rec('remove-writer', X, ['a1', 'r1']), a2: rec('add-writer', X, ['a1', 'a2', 'r1']),                 // add, then remove, then add again
    a1b: rec('add-writer', X, ['a1b']), r2: rec('remove-writer', X, ['a1', 'r2']), a3: rec('add-writer', X, ['a1', 'a1b', 'a3', 'r2']),         // a1b is concurrent with a1 and r2
    rboth: rec('remove-writer', X, ['a1', 'a1b', 'rboth']), z1: rec('add-writer', Z, ['z1']), o1: rec('add-writer', O, ['o1']) };
  const wf = (cids) => W.writersFrom(O, cids, (c) => book[c]);
  const sameList = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  ok('with no list changes only the owner may write', sameList(wf([]), [O]));
  ok('a person who was added may write', sameList(wf(['a1']), [O, X]));
  ok('a person who was added and then removed may not', sameList(wf(['a1', 'r1']), [O]));
  ok('a person added again after the removal was seen may write again', sameList(wf(['a1', 'r1', 'a2']), [O, X]));
  ok('a removal and an add made at the same time, neither having seen the other: the removal wins', sameList(wf(['a1b', 'r2']), [O]) && sameList(wf(['a1', 'a1b', 'r2']), [O]));
  ok('one more add that did see both brings the person back', sameList(wf(['a1', 'a1b', 'r2', 'a3']), [O, X]));
  ok('one removal that saw two separate adds removes the person', sameList(wf(['a1', 'a1b', 'rboth']), [O]));
  ok('an add that saw one removal but not another made at the same time does not bring the person back', sameList(wf(['a1', 'r1', 'r2', 'a2']), [O]) && sameList(wf(['a1', 'r1', 'a2']), [O, X]));
  ok('everyone is listed once, the owner first and the others in a fixed order', sameList(wf(['a1', 'z1']), [O].concat([X, Z].sort())));
  ok('the owner named by an add is not listed twice', sameList(wf(['o1']), [O]));
  const base = ['a1', 'r1', 'a2', 'z1'], perms = (arr) => arr.length <= 1 ? [arr] : arr.flatMap((x, i) => perms(arr.slice(0, i).concat(arr.slice(i + 1))).map((p) => [x].concat(p)));
  ok('whatever order the changes are handed over in, the answer is the same (all 24 orders)', new Set(perms(base).map((p) => JSON.stringify(wf(p)))).size === 1 && sameList(wf(base), [O].concat([X, Z].sort())));
  ok('a change that is not known gives "not known yet", never a guess', wf(['a1', 'nope']) === null && W.writersFrom(O, ['x'], () => ({ event: { change: { op: 'add-writer', did: X } } })) === null);

  // ================================================================ shape, sizes, and never throwing
  await refusedBy('an update over the size limit is refused before it is decoded', await resigned(A, A.d1, e1, (e) => { e.payload.update = kd.b64u(new Uint8Array(W.MAX_UPDATE_BYTES + 3)); }), null, /larger than the limit/);
  // the size is judged on the text BEFORE anything is decoded: watch what is handed to the base64url decoder
  const bigEnv = await resigned(A, A.d1, e1, (e) => { e.payload.update = 'A'.repeat(20 * 1024 * 1024); });
  const realUnb64u = kd.unb64u; let largest = 0;
  kd.unb64u = (s) => { largest = Math.max(largest, String(s).length); return realUnb64u(s); };
  const rBig = await W.verifyVersion(bigEnv, ctx);
  kd.unb64u = realUnb64u;
  ok('a 20 MB update is refused without being decoded (nothing longer than a signature was handed to the decoder)', rBig.ok === false && /larger than the limit/.test(rBig.error) && largest < 200, { largest, rBig });
  await refusedBy('an update that is not canonical base64url is refused', await resigned(A, A.d1, e1, (e) => { e.payload.update = e.payload.update + '='; }), null, /base64url/);
  await refusedBy('a page name that is empty is refused', await resigned(A, A.d1, e1, (e) => { e.objId = ''; }), null, /page name/);
  await refusedBy('a page name that is too long is refused', await resigned(A, A.d1, e1, (e) => { e.objId = 'p'.repeat(200); }), null, /page name/);
  await refusedBy('parents that are not sorted are refused (there is one canonical form, so one id)', await resigned(A, A.d1, e1, (e) => { e.parents = ['b'.repeat(43), 'a'.repeat(43)]; }), null, /sorted/);
  await refusedBy('the same parent twice is refused', await resigned(A, A.d1, e1, (e) => { e.parents = ['a'.repeat(43), 'a'.repeat(43)]; }), null, /sorted and unique/);
  await refusedBy('more parents than the limit are refused', await resigned(A, A.d1, e1, (e) => { e.parents = Array.from({ length: 65 }, (_, i) => String(i).padStart(43, 'a')).sort(); }), null, /parents/);
  await refusedBy('a parent that is not a version id is refused', await resigned(A, A.d1, e1, (e) => { e.parents = ['short']; }), null, /parents/);
  await refusedBy('an unknown format is refused', await resigned(A, A.d1, e1, (e) => { e.payload.format = 'yjs-update-v2'; }), null, /format/);
  await refusedBy('an attachment that is not a hash is refused', await resigned(A, A.d1, e1, (e) => { e.payload.attachments = ['no spaces allowed here at all']; }), null, /attachments/);
  await refusedBy('a date that is not a date is refused', await resigned(A, A.d1, e1, (e) => { e.created = 'yesterday'; }), null, /date/);
  await refusedBy('an event of another purpose (a connection proof, say) is refused', await resigned(A, A.d1, e1, (e) => { e.purpose = 'keo-peer-proof'; }), null, /not a wiki version/);
  await refusedBy('an event of another version number is refused', await resigned(A, A.d1, e1, (e) => { e.v = 2; }), null, /not a wiki version/);
  await refusedBy('an event with an extra member is refused (what is signed is all there is)', await resigned(A, A.d1, e1, (e) => { e.extra = 1; }), null, /not a wiki version/);
  await refusedBy('an author with an extra member is refused', await resigned(A, A.d1, e1, (e) => { e.author.role = 'admin'; }), null, /author/);
  const junk = [null, undefined, 0, 'x', [], {}, { event: null, sig: 'a' }, { event: {}, sig: 1 }, { event: [], sig: 'a' }, { event: e1.event }, { sig: 'a' }, { event: Object.assign({}, e1.event, { author: null }), sig: 'a' },
    { event: Object.assign({}, e1.event, { clients: 'x' }), sig: 'a' }, { event: Object.assign({}, e1.event, { payload: null }), sig: 'a' }, { event: Object.assign({}, e1.event, { parents: null }), sig: 'a' }];
  let threw = false, accepted = false;
  for (const j of junk) { try { const r = await W.verifyVersion(j, ctx); if (r.ok) accepted = true; } catch (e) { threw = true; } }
  ok('nothing that is not a signed wiki version is accepted, and none of ' + junk.length + ' malformed envelopes makes the check throw', !threw && !accepted);
  let hostile = true;
  let changed = 0;
  for (let i = 0; i < 300; i++) {
    const c = clone(e1), keys = ['objId', 'parents', 'author', 'authorLog', 'clients', 'payload', 'created'], k = keys[rint(keys.length)];
    c.event[k] = [null, 0, 'x', [], {}, -1, 1e99, true][rint(8)];
    if (kd.canonicalJson(c.event[k]) === kd.canonicalJson(e1.event[k])) continue;            // an empty parents list is what e1 has: not a change
    changed++;
    try { const r = await W.verifyVersion(c, ctx); if (r.ok) hostile = false; } catch (e) { hostile = false; }
  }
  ok('(' + changed + ' of those 300 really changed the event)', changed > 250, changed);
  ok('300 versions with one member replaced by junk are refused, none accepted and none throws', hostile);
  ok('a receiver whose log or writer lookup throws gets a refusal, not an exception', (await W.verifyVersion(e1, { log: async () => { throw new Error('disk'); }, versions: () => true, writers: async () => [A.did] })).ok === false);

  console.log(passed + ' checks passed' + (process.exitCode ? ', SOME FAILED' : ''));
})().catch((e) => { console.error(e); process.exit(1); });
