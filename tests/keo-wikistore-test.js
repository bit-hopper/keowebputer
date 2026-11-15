// Node test for keo-wikistore.js (the sealed local store of a wiki page's history, with the log book): no browser, no authenticator.
// Identities, logs, device keys and removals are built with keo-did.js; edits are real Yjs updates signed by device keys through
// keo-wikilog.js. The backend is the in-memory one, whose contents the tests inspect as the "disk".
// Usage: node keo-wikistore-test.js
const path = require('path');
const kd = require(path.join(__dirname, '..', 'shell', 'keo-did.js'));
const Y = require(path.join(__dirname, '..', 'shell', 'keo-yjs.js'));
const W = require(path.join(__dirname, '..', 'shell', 'keo-wikilog.js'));
const S = require(path.join(__dirname, '..', 'shell', 'keo-wikistore.js'));
const subtle = globalThis.crypto.subtle;
const enc = new TextEncoder();
let passed = 0;
const ok = (name, cond, extra) => { if (!cond) { console.error('FAIL ' + name + (extra !== undefined ? ' ' + (typeof extra === 'string' ? extra : JSON.stringify(extra)).slice(0, 600) : '')); process.exitCode = 1; } else { passed++; console.log('ok   ' + name); } };
const rejects = async (p) => { try { await p; return null; } catch (e) { return e.message; } };

// ---- people, as in keo-wikilog-test.js
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
async function makeDevice() { const pair = await newPair(), jwk = plain(await subtle.exportKey('jwk', pair.publicKey)); return { pair, jwk, id: kd.b64u(await kd.sha256(enc.encode(kd.canonicalJson(jwk)))) }; }
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
  const push = async (e, sigsFrom) => { const entry = { event: e, sigs: { authority: [Object.assign({ keyId }, await assertion(authPair.privateKey, await kd.eventHash(e)))] } }; (sigsFrom || p.log.events).push(entry); return entry; };
  p.addDevice = async () => { const d = await makeDevice(); await push(await kd.addDeviceEvent(last(), { id: d.id, jwk: d.jwk, addedAt: new Date().toISOString() })); return d; };
  p.removeDevice = async (d) => { await push(await kd.removeDeviceEvent(last(), d.id)); return p.log.events.length; };
  p.snapshot = () => JSON.parse(JSON.stringify(p.log));
  p.point = () => W.logPoint(p.log);
  p.signer = (dev) => async (bytes) => kd.b64u(new Uint8Array(await subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, dev.pair.privateKey, bytes)));
  return p;
}
const OBJ = 'page-one';
let nonceCounter = 0;
// One device's way of writing a page: its Yjs document under its derived client id, and a function that signs what changed.
async function writer(person, dev, nonce, objId) {
  nonce = nonce || ('nonce-w' + (++nonceCounter).toString().padStart(4, '0') + 'xx');
  const doc = new Y.Doc(); doc.clientID = await W.clientIdFor(dev.id, objId || OBJ, nonce);
  const w = { person, dev, doc, nonce, objId: objId || OBJ };
  // `parents`: the cids this edit follows. `fn` edits the document; the delta since the last publish is what is sent.
  w.publish = async (fn, parents, o) => {
    o = o || {};
    const sv = Y.encodeStateVector(doc); fn(doc);
    const update = Y.encodeStateAsUpdate(doc, sv);
    const ev = await W.buildVersion({ objId: w.objId, parents: parents || [], author: { did: person.did, deviceId: dev.id }, authorLog: o.point || await person.point(), nonces: [w.nonce], update, created: o.created });
    return W.seal(ev, person.signer(dev));
  };
  w.apply = (update) => Y.applyUpdate(doc, update);
  w.text = () => doc.getText('body').toString();
  return w;
}
const cidOf = (env) => W.versionId(env.event);
const textOf = (update) => { const d = new Y.Doc(); Y.applyUpdate(d, update); return d.getText('body').toString(); };

async function makeStore(people, o) {
  o = o || {};
  const backend = o.backend || S.memoryBackend();
  const key = o.key || await subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  const reader = o.did || 'did:keo:' + 'y'.repeat(52) + ':' + 'A'.repeat(43);
  const store = S.create({ backend, key, did: reader, writers: o.writers || (async () => people.map((p) => p.did)), now: o.now });
  return { store, backend, key, did: reader };
}
const feedLogs = async (store, people) => { for (const p of people) await store.offerLog(p.did, p.snapshot()); };

(async () => {
  const A = await makePerson(), B = await makePerson(), C = await makePerson();
  const people = [A, B, C];

  // ================================================================ a first edit, accepted and read back
  const S1 = await makeStore(people);
  await feedLogs(S1.store, people);
  const wa = await writer(A, A.d1);
  const e1 = await wa.publish((d) => d.getText('body').insert(0, 'hello'));
  const r1 = await S1.store.add(e1);
  ok('a first edit is accepted and the answer names it', r1.status === 'accepted' && r1.cid === await cidOf(e1), r1);
  ok('the page has that one head', JSON.stringify(await S1.store.heads(OBJ)) === JSON.stringify([r1.cid]));
  ok('the same edit again is a duplicate, not a second copy', (await S1.store.add(e1)).status === 'duplicate' && (await S1.store.versions(OBJ)).length === 1);
  ok('the state at the head reads as the text that was written', textOf((await S1.store.state(OBJ)).update) === 'hello');
  const e2 = await wa.publish((d) => d.getText('body').insert(5, ' world'), [r1.cid]);
  const r2 = await S1.store.add(e2);
  ok('the author\'s next edit, which names the first as its parent, continues its clock numbers and is accepted', r2.status === 'accepted', r2);
  ok('the history lists both, parents first, with their author and date', (await S1.store.versions(OBJ)).map((v) => v.cid).join() === [r1.cid, r2.cid].join() && (await S1.store.versions(OBJ))[1].did === A.did && (await S1.store.versions(OBJ))[1].parents[0] === r1.cid);
  ok('the state at the older head is the older text (the state at a version, not only the latest)', textOf((await S1.store.state(OBJ, [r1.cid])).update) === 'hello' && textOf((await S1.store.state(OBJ)).update) === 'hello world');
  ok('asking for the state at a version that is not held says so', /not held/.test(await rejects(S1.store.state(OBJ, ['z'.repeat(43)])) || ''));
  ok('another page is a separate history', (await S1.store.heads('page-two')).length === 0 && (await S1.store.versions('page-two')).length === 0);

  // ================================================================ sealed on disk
  const dump = S1.backend.dump(), kinds = Object.keys(dump);
  const allText = (() => { let s = ''; for (const k of kinds) for (const [id, rec] of dump[k]) s += id + '\n' + rec.iv + '\n' + Buffer.from(rec.ct).toString('latin1') + '\n'; return s; })();
  ok('the disk holds pages, versions and logs', ['page', 'version', 'log'].every((k) => dump[k] && dump[k].length > 0) && dump.version.length === 2, kinds);
  ok('nothing on disk shows the text that was written, the page name, or anyone\'s identity', !allText.includes('hello') && !allText.includes('world') && !allText.includes(OBJ) && !allText.includes(A.did) && !allText.includes(A.did.slice(8, 30)) && !allText.includes(kd.parseDid(A.did).dk));
  ok('record ids are hashes: a version\'s id is its version id, a page\'s and a log\'s are not the page name or the DID', dump.version.some(([id]) => id === r1.cid) && dump.page.every(([id]) => /^[A-Za-z0-9_-]{43}$/.test(id) && id !== OBJ) && dump.log.every(([id]) => !id.includes('did:keo')));
  ok('every record is sealed (a random 12-byte nonce and ciphertext, never the plain event)', kinds.every((k) => dump[k].every(([, rec]) => typeof rec.iv === 'string' && rec.iv.length === 16 && rec.ct instanceof Uint8Array && rec.ct.length > 16)));
  // reload from disk: a fresh store object over the same backend and key
  await S1.store.unload();
  ok('after the store forgets what is in memory it reads everything back from the sealed records', JSON.stringify(await S1.store.heads(OBJ)) === JSON.stringify([r2.cid]) && textOf((await S1.store.state(OBJ)).update) === 'hello world');
  const fresh = S.create({ backend: S1.backend, key: S1.key, did: S1.did, writers: async () => people.map((p) => p.did) });
  ok('and so does a second store object over the same disk and key', JSON.stringify(await fresh.heads(OBJ)) === JSON.stringify([r2.cid]) && (await fresh.logOf(A.did)).events.length === 0);
  const wrongKey = S.create({ backend: S1.backend, key: await subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']), did: S1.did, writers: async () => [] });
  ok('with another key nothing can be read', /could not be decrypted/.test(await rejects(wrongKey.heads(OBJ)) || ''));
  const otherIdentity = S.create({ backend: S1.backend, key: S1.key, did: 'did:keo:' + 'z'.repeat(52) + ':' + 'B'.repeat(43), writers: async () => [] });
  ok('with the same key but another identity\'s store nothing can be read either (the identity is part of what is sealed)', /could not be decrypted/.test(await rejects(otherIdentity.heads(OBJ)) || ''));
  // damage on disk: flip a byte of a version record, and swap two records' contents
  const damaged = await makeStore(people); await feedLogs(damaged.store, people);
  const dw = await writer(A, A.d1); const d1 = await dw.publish((d) => d.getText('body').insert(0, 'one')); const dr1 = await damaged.store.add(d1);
  const d2 = await dw.publish((d) => d.getText('body').insert(3, ' two'), [dr1.cid]); const dr2 = await damaged.store.add(d2);
  await damaged.store.unload();
  const vrec = await damaged.backend.get('version', dr1.cid); const flipped = { iv: vrec.iv, ct: new Uint8Array(vrec.ct) }; flipped.ct[5] ^= 1;
  await damaged.backend.put('version', dr1.cid, flipped);
  ok('a record changed on disk is noticed when it is read', /could not be decrypted/.test(await rejects(damaged.store.heads(OBJ)) || ''));
  await damaged.backend.put('version', dr1.cid, await damaged.backend.get('version', dr2.cid));
  await damaged.store.unload();
  ok('a record moved into another record\'s slot is noticed too (its own id is part of what is sealed)', /could not be decrypted/.test(await rejects(damaged.store.heads(OBJ)) || ''));

  // ================================================================ the log book (pin the longest verified log)
  const L = await makeStore([A, B]);
  ok('a log the store has not seen is kept', (await L.store.offerLog(A.did, A.snapshot())).status === 'new');
  ok('the same log again changes nothing', (await L.store.offerLog(A.did, A.snapshot())).status === 'same');
  const A2 = await A.addDevice();
  const longer = A.snapshot();
  ok('a longer log that extends the kept one replaces it', (await L.store.offerLog(A.did, longer)).status === 'extended' && (await L.store.logOf(A.did)).events.length === 1);
  const shorterLog = A.snapshot(); shorterLog.events = [];
  const rs = await L.store.offerLog(A.did, shorterLog);
  ok('a SHORTER log is not taken, and the kept one stays the longer (an older copy cannot undo what a newer one says)', rs.status === 'shorter' && (await L.store.logOf(A.did)).events.length === 1, rs);
  await A.removeDevice(A2);
  const withRemoval = A.snapshot();
  ok('the log that adds the removal extends it again', (await L.store.offerLog(A.did, withRemoval)).status === 'extended' && (await L.store.logOf(A.did)).events.length === 2);
  ok('and the older copy, offered after that, is still refused as shorter', (await L.store.offerLog(A.did, longer)).status === 'shorter' && (await L.store.logOf(A.did)).events.length === 2);
  ok('a log that does not verify is refused and nothing is kept for it', (await L.store.offerLog(B.did, { inception: B.log.inception, sigs: Object.assign({}, B.log.sigs, { discovery: 'AAAA' }), events: [] })).status === 'refused' && (await L.store.logOf(B.did)) === null);
  ok('a log offered under another identity\'s DID is refused', (await L.store.offerLog(B.did, A.snapshot())).status === 'refused');
  // a fork: two different second events that both extend the same first
  const F = await makePerson();
  const Fx = await F.addDevice();                                   // event 1 (shared)
  const forkA = F.snapshot();
  const forkB = F.snapshot();
  const devY = await makeDevice();
  const e2a = await kd.addDeviceEvent(forkA.events[0].event, { id: 'dev-fork-a', jwk: devY.jwk, addedAt: new Date().toISOString() });
  const e2b = await kd.addDeviceEvent(forkB.events[0].event, { id: 'dev-fork-b', jwk: devY.jwk, addedAt: new Date().toISOString() });
  const signFork = async (e) => ({ event: e, sigs: { authority: [Object.assign({ keyId: F.keyId }, await assertion(F.authPair.privateKey, await kd.eventHash(e)))] } });
  forkA.events.push(await signFork(e2a)); forkB.events.push(await signFork(e2b));
  const FL = await makeStore([F]);
  ok('the first of two logs that fork is kept', (await FL.store.offerLog(F.did, forkA)).status === 'new');
  const rf = await FL.store.offerLog(F.did, forkB);
  ok('the second, which disagrees about event 2, is NOT taken: the first one seen stays', rf.status === 'fork' && rf.at === 2 && (await FL.store.logOf(F.did)).events[1].event.add.device.id === 'dev-fork-a', rf);
  ok('and the disagreement is kept for the person to see', (await FL.store.alerts()).some((a) => a.kind === 'log-fork' && a.did === F.did && a.at === 2));
  const e3b = await kd.addDeviceEvent(e2b, { id: 'dev-fork-c', jwk: devY.jwk, addedAt: new Date().toISOString() });
  const longerOnOtherBranch = JSON.parse(JSON.stringify(forkB)); longerOnOtherBranch.events.push(await signFork(e3b));
  const rfl = await FL.store.offerLog(F.did, longerOnOtherBranch);
  ok('a LONGER log built on the other branch is a fork too, however long it is: it is not taken', rfl.status === 'fork' && rfl.at === 2 && (await FL.store.logOf(F.did)).events.length === 2, rfl);

  // ================================================================ edits that wait, and are settled by themselves
  const P = await makeStore(people);          // no logs yet
  const pw = await writer(A, A.d1);
  const p1 = await pw.publish((d) => d.getText('body').insert(0, 'first'));
  const p1cid = await cidOf(p1);
  const p2 = await pw.publish((d) => d.getText('body').insert(5, ' second'), [p1cid]);
  const rw = await P.store.add(p2);
  ok('an edit whose author\'s identity log has not arrived waits (it is not refused)', rw.status === 'pending' && rw.waitFor.log === A.did, rw);
  ok('what waits is listed, with what it waits for', (await P.store.pending(OBJ)).length === 1);
  ok('and it is on disk, sealed', (await P.backend.ids('pending')).length === 1 && !Buffer.from((await P.backend.get('pending', rw.cid)).ct).toString('latin1').includes('second'));
  await P.store.offerLog(A.did, A.snapshot());
  const stillWaiting = await P.store.pending(OBJ);
  ok('with the log it now waits only for its parent', stillWaiting.length === 1 && stillWaiting[0].waitFor.parents && stillWaiting[0].waitFor.parents[0] === p1cid, stillWaiting);
  const rp1 = await P.store.add(p1);
  ok('when the parent arrives, both are accepted by themselves: the answer lists the one that was waiting', rp1.status === 'accepted' && rp1.alsoAccepted.length === 1 && rp1.alsoAccepted[0] === rw.cid, rp1);
  ok('nothing is waiting any more, on disk or in memory, and the page has the later edit as its head', (await P.store.pending(OBJ)).length === 0 && (await P.backend.ids('pending')).length === 0 && (await P.store.heads(OBJ))[0] === rw.cid);
  // a waiting edit survives a restart and is settled by an explicit recheck
  const R = await makeStore(people); await feedLogs(R.store, people);
  const rw2 = await writer(A, A.d1); const q1 = await rw2.publish((d) => d.getText('body').insert(0, 'a')); const q2 = await rw2.publish((d) => d.getText('body').insert(1, 'b'), [await cidOf(q1)]);
  await R.store.add(q2); await R.store.unload();
  ok('a waiting edit is still waiting after the store was reloaded from disk', (await R.store.pending(OBJ)).length === 1);
  await R.store.add(q1);
  ok('and the parent arriving after the reload settles it', (await R.store.pending(OBJ)).length === 0 && (await R.store.heads(OBJ)).length === 1);
  // the writer list not known yet
  let known = null;
  const WR = await makeStore(people, { writers: async () => known }); await feedLogs(WR.store, people);
  const ww = await writer(A, A.d1); const w1 = await ww.publish((d) => d.getText('body').insert(0, 'x'));
  const rww = await WR.store.add(w1);
  ok('an edit waits while who may write the page is not known', rww.status === 'pending' && rww.waitFor.writers === true, rww);
  known = [A.did];
  const rec = await WR.store.recheck(OBJ);
  ok('and is accepted when the caller says the list is known and asks for a recheck', rec.length === 1 && rec[0] === rww.cid && (await WR.store.heads(OBJ)).length === 1, rec);
  // a waiting edit that turns out to be refused is dropped, and the person is told
  const T = await makeStore(people);
  const tw = await writer(A, A.d1);
  const Adev2 = await A.addDevice();
  const tw2 = await writer(A, Adev2);
  const ptBefore = { seq: 0, head: (await W.logPoint({ inception: A.log.inception, events: [] })).head };
  const bad = await tw2.publish((d) => d.getText('body').insert(0, 'early'), [], { point: ptBefore });     // claims a point where this device was not listed yet
  const rbad = await T.store.add(bad);
  ok('an edit that waits for the author\'s log, before the log is here', rbad.status === 'pending');
  await T.store.offerLog(A.did, A.snapshot());
  ok('when the log arrives and shows the device was not listed at that point, the edit is dropped from the waiting list and an alert says why', (await T.store.pending(OBJ)).length === 0 && (await T.store.heads(OBJ)).length === 0 && (await T.store.alerts()).some((a) => a.kind === 'pending-refused' && /not listed/.test(a.error)));
  // too many waiting
  const M = await makeStore(people);                    // no logs: every edit waits
  const mw = await writer(A, A.d1);
  let last = null; let refusedAt = 0;
  for (let i = 0; i < 202; i++) { const env = await mw.publish((d) => d.getText('body').insert(0, 'a')); const r = await M.store.add(env); if (r.status === 'refused') { refusedAt = i + 1; last = r; break; } }
  ok('at most 200 edits wait: the 201st is refused with a plain message', refusedAt === 201 && /too many edits are waiting/.test(last.error) && (await M.store.pending(OBJ)).length === 200, { refusedAt, last });

  // ================================================================ the author's clock numbers must continue
  const K = await makeStore(people); await feedLogs(K.store, people);
  const kw = await writer(A, A.d1);
  const k1 = await kw.publish((d) => d.getText('body').insert(0, 'hello'));
  const rk1 = await K.store.add(k1);
  // skipping ahead: an edit made on a document that also holds an unsent edit
  await kw.publish((d) => d.getText('body').insert(5, ' (never sent)'));
  const kSkip = await kw.publish((d) => d.getText('body').insert(0, '>> '), [rk1.cid]);
  const rSkip = await K.store.add(kSkip);
  ok('an edit that skips ahead of its author\'s earlier edits is refused (Yjs would hold it back for ever)', rSkip.status === 'refused' && /skips ahead/.test(rSkip.error), rSkip);
  ok('it is not stored and an alert says so', (await K.store.heads(OBJ)).length === 1 && (await K.store.alerts()).some((a) => a.kind === 'clock-ahead' && a.cid === rSkip.cid));
  // an edit that does not name its own earlier edit as an ancestor
  const kw2 = await writer(A, A.d1); const first = await kw2.publish((d) => d.getText('body').insert(0, 'aaaaa'));
  const K2 = await makeStore(people); await feedLogs(K2.store, people);
  await K2.store.add(first);
  const nextNoParent = await kw2.publish((d) => d.getText('body').insert(5, 'bbbbb'), []);
  ok('an edit that follows an earlier edit of its own author without naming it as a parent is refused: its numbers cannot continue from nothing', (await K2.store.add(nextNoParent)).status === 'refused');
  // reusing numbers: a device that lost its copy and started again under the SAME nonce
  const lost = await writer(A, A.d1, 'nonce-lost-1');
  const l1 = await lost.publish((d) => d.getText('body').insert(0, 'original'));
  const K3 = await makeStore(people); await feedLogs(K3.store, people);
  const rl1 = await K3.store.add(l1);
  const restarted = await writer(A, A.d1, 'nonce-lost-1');                           // same device, same page, same nonce: the same client id, clocks back at zero
  const l2 = await restarted.publish((d) => d.getText('body').insert(0, 'different'), [rl1.cid]);
  const rl2 = await K3.store.add(l2);
  ok('a device that starts again under the same nonce reuses numbers its earlier edits used and is refused', rl2.status === 'refused' && /reuses clock numbers/.test(rl2.error), rl2);
  const restartedFresh = await writer(A, A.d1, 'nonce-lost-2');                      // a fresh nonce: a fresh client id
  restartedFresh.apply(Y.encodeStateAsUpdate(lost.doc));                              // it re-reads what the page holds
  const l3 = await restartedFresh.publish((d) => d.getText('body').insert(8, ' again'), [rl1.cid]);
  ok('the same device under a FRESH nonce is a new client and its edit is accepted', (await K3.store.add(l3)).status === 'accepted');
  // equivocation: two different edits under the same client id and the same numbers, on the same parents
  const eq = await writer(A, A.d1, 'nonce-equiv-1');
  const q0 = await eq.publish((d) => d.getText('body').insert(0, 'base'));
  const K4 = await makeStore(people); await feedLogs(K4.store, people);
  const rq0 = await K4.store.add(q0);
  const eqTwin = await writer(A, A.d1, 'nonce-equiv-1'); eqTwin.doc.getText('body').insert(0, 'base');   // the same device and numbers, built again on its own (applying eq's update would make Yjs rename the twin's client id)
  const qa = await eq.publish((d) => d.getText('body').insert(4, ' A'), [rq0.cid]);
  const qb = await eqTwin.publish((d) => d.getText('body').insert(4, ' B'), [rq0.cid]);
  ok('two different edits by one device claiming the same clock numbers are different events', (await cidOf(qa)) !== (await cidOf(qb)));
  const rqa = await K4.store.add(qa), rqb = await K4.store.add(qb);
  ok('the first one seen is accepted and the second is refused as an equivocation, whatever order a receiver sees them in (first seen wins)', rqa.status === 'accepted' && rqb.status === 'refused' && /two different edits claim the same clock numbers/.test(rqb.error), [rqa, rqb]);
  const eqAlert = (await K4.store.alerts()).filter((a) => a.kind === 'equivocation')[0];
  ok('the pair is kept as an alert, naming the author and both edits', eqAlert && eqAlert.did === A.did && eqAlert.cids[0] === rqa.cid && eqAlert.cids[1] === rqb.cid, eqAlert);
  ok('only the first is in the page', (await K4.store.versions(OBJ)).length === 2 && (await K4.store.has(OBJ, rqb.cid)) === false);
  ok('the same edit sent again is a duplicate, not an equivocation', (await K4.store.add(qa)).status === 'duplicate' && (await K4.store.alerts()).filter((a) => a.kind === 'equivocation').length === 1);
  // an edit that follows two versions, one of which saw less of the author's own earlier edits than the other: it continues from the later
  const MX = await makeStore(people); await feedLogs(MX.store, people);
  const xa = await writer(A, A.d1), xb = await writer(B, B.d1);
  const xe1 = await xa.publish((d) => d.getText('body').insert(0, 'one')); const rx1 = await MX.store.add(xe1);
  const xe2 = await xa.publish((d) => d.getText('body').insert(3, ' two'), [rx1.cid]); const rx2 = await MX.store.add(xe2);
  xb.apply(kd.unb64u(xe1.event.payload.update));
  const xf = await xb.publish((d) => d.getText('body').insert(0, 'F: '), [rx1.cid]); const rxf = await MX.store.add(xf);       // B saw only the first of A's edits
  xa.apply(kd.unb64u(xf.event.payload.update));
  const xe3 = await xa.publish((d) => d.getText('body').insert(d.getText('body').length, ' three'), [rx2.cid, rxf.cid]);
  const rx3 = await MX.store.add(xe3);
  ok('an edit that follows two versions, one of which had seen less of its author\'s own earlier edits, continues from the LATER one (the larger end of the clock numbers)', rx3.status === 'accepted' && (await MX.store.heads(OBJ)).length === 1, rx3);
  // a page that names a version the disk no longer holds is reported, not silently shortened
  await MX.backend.del('version', rx2.cid); await MX.store.unload();
  ok('a page record that names a version missing from the disk is reported when the page is loaded', /missing a version/.test(await rejects(MX.store.heads(OBJ)) || ''));
  // two authors write under different client ids and never clash
  const D2 = await makeStore(people); await feedLogs(D2.store, people);
  const aw = await writer(A, A.d1), bw = await writer(B, B.d1);
  const ar = await D2.store.add(await aw.publish((d) => d.getText('body').insert(0, 'from A')));
  const br = await D2.store.add(await bw.publish((d) => d.getText('body').insert(0, 'from B')));
  ok('two authors\' first edits on the same (empty) page, each starting at zero under its own client id, both stand', ar.status === 'accepted' && br.status === 'accepted' && (await D2.store.heads(OBJ)).length === 2);
  const mergeEnv = await (async () => { const m = await writer(A, A.d1, 'nonce-merge-1'); return m.publish(() => {}, [ar.cid, br.cid]); })();
  const rm = await D2.store.add(mergeEnv);
  ok('an event that names both heads and adds nothing merges them: one head', rm.status === 'accepted' && (await D2.store.heads(OBJ)).length === 1);
  const mergedText = textOf((await D2.store.state(OBJ)).update);
  ok('and the page reads as both edits together (' + JSON.stringify(mergedText) + ')', mergedText.includes('from A') && mergedText.includes('from B'));

  // ================================================================ removal and the pinned log, together (the owner's rule, now across logs)
  const RM = await makePerson(); const rmDev = await RM.addDevice();                 // log: 1 event (device added)
  const rmStore = await makeStore([RM]); await rmStore.store.offerLog(RM.did, RM.snapshot());
  const rmW = await writer(RM, rmDev);
  const ptAdded = await RM.point();
  const made = await rmW.publish((d) => d.getText('body').insert(0, 'made while listed'), [], { point: ptAdded });
  await RM.removeDevice(rmDev);                                                       // log: 2 events
  await rmStore.store.offerLog(RM.did, RM.snapshot());
  ok('an edit made while the device was listed is accepted even though the store already holds the log that removed it', (await rmStore.store.add(made)).status === 'accepted');
  const after = await rmW.publish((d) => d.getText('body').insert(0, 'after '), [await cidOf(made)], { point: await RM.point() });
  const rAfter = await rmStore.store.add(after);
  ok('an edit that claims a point after the removal is refused', rAfter.status === 'refused' && /not listed/.test(rAfter.error), rAfter);
  const olderLog = RM.snapshot(); olderLog.events = olderLog.events.slice(0, 1);
  const rOld = await rmStore.store.offerLog(RM.did, olderLog);
  ok('offering the older log, from before the removal, does not bring the device back: it is refused as shorter and the edit after the removal is still refused', rOld.status === 'shorter' && (await rmStore.store.add(after)).status === 'refused');
  const storeOld = await makeStore([RM]); await storeOld.store.offerLog(RM.did, olderLog);
  const lateWriter = await writer(RM, rmDev);                                          // a fresh document: its first edit starts at zero
  const lateEdit = await lateWriter.publish((d) => d.getText('body').insert(0, 'x'), [], { point: await RM.point() });     // claims the point AFTER the removal
  const rLate = await storeOld.store.add(lateEdit);
  ok('a store that was only ever shown the older log does not accept an edit that claims a point beyond that log (the point after the removal): it waits for the newer log', rLate.status === 'pending' && rLate.waitFor.seq === 2, rLate);
  await storeOld.store.offerLog(RM.did, RM.snapshot());
  ok('and once the store is shown the newer log it settles the waiting edit by refusing it', (await storeOld.store.pending(OBJ)).length === 0 && (await storeOld.store.heads(OBJ)).length === 0 && (await storeOld.store.alerts()).some((a) => a.kind === 'pending-refused'));

  // ================================================================ order of arrival does not change the result
  const O = await makePerson(); const OW = await writer(O, O.d1);
  const chain = []; let parents = [];
  for (let i = 0; i < 6; i++) { const env = await OW.publish((d) => d.getText('body').insert(d.getText('body').length, 'w' + i + ' '), parents); chain.push(env); parents = [await cidOf(env)]; }
  const results = new Set();
  for (let trial = 0; trial < 6; trial++) {
    const order = chain.map((e, i) => [e, ((i * 7 + trial * 3) % 11) + Math.sin(trial + i)]).sort((a, b) => a[1] - b[1]).map((x) => x[0]);
    const OS = await makeStore([O]); await OS.store.offerLog(O.did, O.snapshot());
    const answers = await Promise.all(order.map((e) => OS.store.add(e)));            // all at once: the store runs them one after another
    results.add(JSON.stringify([(await OS.store.heads(OBJ)), textOf((await OS.store.state(OBJ)).update), (await OS.store.pending(OBJ)).length, answers.filter((a) => a.status === 'refused').length]));
  }
  ok('six edits sent in six different orders, all at once, always end with the same head and the same text, nothing waiting and nothing refused', results.size === 1 && JSON.parse(Array.from(results)[0])[1] === 'w0 w1 w2 w3 w4 w5 ' && JSON.parse(Array.from(results)[0])[2] === 0 && JSON.parse(Array.from(results)[0])[3] === 0, Array.from(results));

  // ================================================================ writers as of the parents, through the store
  const asked = [];
  const WP = await makeStore(people, { writers: async (objId, parents) => { asked.push([objId, parents.length]); return parents.length ? [A.did] : [A.did, B.did]; } });
  await feedLogs(WP.store, people);
  const wpa = await writer(A, A.d1), wpb = await writer(B, B.d1);
  const ra = await WP.store.add(await wpa.publish((d) => d.getText('body').insert(0, 'a')));
  ok('the writer list is asked about the page and the parents of each edit', ra.status === 'accepted' && asked.some(([o, n]) => o === OBJ && n === 0));
  wpb.apply(Y.encodeStateAsUpdate(wpa.doc));
  const rb = await WP.store.add(await wpb.publish((d) => d.getText('body').insert(1, 'b'), [ra.cid]));
  ok('a person the list does not name for those parents is refused, and nothing of theirs is kept', rb.status === 'refused' && /may not write/.test(rb.error) && (await WP.store.versions(OBJ)).length === 1, rb);

  // ================================================================ purge
  await S1.store.purge();
  ok('removing the store\'s contents leaves nothing on disk and nothing in memory', (await Promise.all(['page', 'version', 'pending', 'log', 'meta'].map((k) => S1.backend.ids(k)))).every((l) => l.length === 0) && (await S1.store.heads(OBJ)).length === 0 && (await S1.store.logOf(A.did)) === null);

  // ================================================================ never throws on garbage
  const G = await makeStore(people); await feedLogs(G.store, people);
  const junk = [null, undefined, 0, 'x', [], {}, { event: {}, sig: 'a' }, { event: { objId: 'p' }, sig: 'a' }, { event: { objId: 5 }, sig: 'a' }];
  const answers = [];
  for (const j of junk) answers.push(await G.store.add(j).catch((e) => ({ threw: e.message })));
  ok('nothing that is not a signed wiki version is accepted, and none of ' + junk.length + ' malformed inputs makes the store throw', answers.every((a) => a.status === 'refused'), answers);

  console.log(passed + ' checks passed' + (process.exitCode ? ', SOME FAILED' : ''));
})().catch((e) => { console.error(e); process.exit(1); });
