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

const { pageOf, assertion, plain, makeDevice, makePerson, writer, policy, cidOf, textOf } = require(path.join(__dirname, 'wiki-fixtures.js'));

async function makeStore(people, o) {
  o = o || {};
  const backend = o.backend || S.memoryBackend();
  const key = o.key || await subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  const reader = o.did || 'did:keo:' + 'y'.repeat(52) + ':' + 'A'.repeat(43);
  const store = S.create({ backend, key, did: reader, now: o.now });
  return { store, backend, key, did: reader };
}
const feedLogs = async (store, people) => { for (const p of people) await store.offerLog(p.did, p.snapshot()); };
// The text of a page that has changes of the writer list in its history. A state that cannot be built must FAIL a check, not end the whole run
// with an exception: the rule that a list change carries no text is only seen by a test that survives the call being wrong (a breakage of
// that rule once ended the run with a TypeError before any check about it was reached).
const safeText = async (store, objId) => { try { return textOf((await store.state(objId)).update); } catch (x) { return 'THREW: ' + x; } };

(async () => {
  const A = await makePerson(), B = await makePerson(), C = await makePerson();
  const people = [A, B, C];
  const OBJ = pageOf(A);                                  // a page is named by its owner (A) and a name

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
  ok('another page is a separate history', (await S1.store.heads(pageOf(A, 'page-two'))).length === 0 && (await S1.store.versions(pageOf(A, 'page-two'))).length === 0);

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
  const fresh = S.create({ backend: S1.backend, key: S1.key, did: S1.did });
  ok('and so does a second store object over the same disk and key', JSON.stringify(await fresh.heads(OBJ)) === JSON.stringify([r2.cid]) && (await fresh.logOf(A.did)).events.length === 0);
  const wrongKey = S.create({ backend: S1.backend, key: await subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']), did: S1.did });
  ok('with another key nothing can be read', /could not be decrypted/.test(await rejects(wrongKey.heads(OBJ)) || ''));
  const otherIdentity = S.create({ backend: S1.backend, key: S1.key, did: 'did:keo:' + 'z'.repeat(52) + ':' + 'B'.repeat(43) });
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
  const rsKept = await L.store.offerLog(A.did, longer), rsSame = await L.store.offerLog(A.did, withRemoval);
  ok('an answer of "shorter" hands back the log that is kept, with all its events (a verifier checks the device against it)', rsKept.status === 'shorter' && !!rsKept.kept && rsKept.kept.events.length === 2 && kd.canonicalJson(rsKept.kept.inception) === kd.canonicalJson(withRemoval.inception) && kd.canonicalJson(rsKept.kept.events[1].event) === kd.canonicalJson(withRemoval.events[1].event), rsKept.status);
  const rsNew = await (await makeStore([A])).store.offerLog(A.did, A.snapshot());
  ok('and no other answer carries one', rsSame.status === 'same' && !('kept' in rsSame) && rsNew.status === 'new' && !('kept' in rsNew));
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
  const xpol = await MX.store.add(await policy(A, A.d1, { op: 'add-writer', did: B.did }, []));
  const xa = await writer(A, A.d1), xb = await writer(B, B.d1, undefined, OBJ);
  const xe1 = await xa.publish((d) => d.getText('body').insert(0, 'one'), [xpol.cid]); const rx1 = await MX.store.add(xe1);
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
  // two authors write under different client ids and never clash (B writes A's page because A signed B in: the list change comes first)
  const D2 = await makeStore(people); await feedLogs(D2.store, people);
  const polAB = await D2.store.add(await policy(A, A.d1, { op: 'add-writer', did: B.did }, []));
  const aw = await writer(A, A.d1), bw = await writer(B, B.d1, undefined, OBJ);
  const ar = await D2.store.add(await aw.publish((d) => d.getText('body').insert(0, 'from A'), [polAB.cid]));
  const br = await D2.store.add(await bw.publish((d) => d.getText('body').insert(0, 'from B'), [polAB.cid]));
  ok('two authors\' first edits on the same page, each starting at zero under its own client id, both stand', polAB.status === 'accepted' && ar.status === 'accepted' && br.status === 'accepted' && (await D2.store.heads(OBJ)).length === 2);
  const mergeEnv = await (async () => { const m = await writer(A, A.d1, 'nonce-merge-1'); return m.publish(() => {}, [ar.cid, br.cid]); })();
  const rm = await D2.store.add(mergeEnv);
  ok('an event that names both heads and adds nothing merges them: one head', rm.status === 'accepted' && (await D2.store.heads(OBJ)).length === 1);
  const mergedText = await safeText(D2.store, OBJ);
  ok('and the page reads as both edits together (' + JSON.stringify(mergedText) + ')', mergedText.includes('from A') && mergedText.includes('from B'));

  // ================================================================ removal and the pinned log, together (the owner's rule, now across logs)
  const RM = await makePerson(); const rmDev = await RM.addDevice();                 // log: 1 event (device added)
  const OBJ_RM = pageOf(RM);
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
  ok('and once the store is shown the newer log it settles the waiting edit by refusing it', (await storeOld.store.pending(OBJ_RM)).length === 0 && (await storeOld.store.heads(OBJ_RM)).length === 0 && (await storeOld.store.alerts()).some((a) => a.kind === 'pending-refused'));

  // ================================================================ order of arrival does not change the result
  const O = await makePerson(); const OW = await writer(O, O.d1); const OBJ_O = pageOf(O);
  const chain = []; let parents = [];
  for (let i = 0; i < 6; i++) { const env = await OW.publish((d) => d.getText('body').insert(d.getText('body').length, 'w' + i + ' '), parents); chain.push(env); parents = [await cidOf(env)]; }
  const results = new Set();
  for (let trial = 0; trial < 6; trial++) {
    const order = chain.map((e, i) => [e, ((i * 7 + trial * 3) % 11) + Math.sin(trial + i)]).sort((a, b) => a[1] - b[1]).map((x) => x[0]);
    const OS = await makeStore([O]); await OS.store.offerLog(O.did, O.snapshot());
    const answers = await Promise.all(order.map((e) => OS.store.add(e)));            // all at once: the store runs them one after another
    results.add(JSON.stringify([(await OS.store.heads(OBJ_O)), textOf((await OS.store.state(OBJ_O)).update), (await OS.store.pending(OBJ_O)).length, answers.filter((a) => a.status === 'refused').length]));
  }
  ok('six edits sent in six different orders, all at once, always end with the same head and the same text, nothing waiting and nothing refused', results.size === 1 && JSON.parse(Array.from(results)[0])[1] === 'w0 w1 w2 w3 w4 w5 ' && JSON.parse(Array.from(results)[0])[2] === 0 && JSON.parse(Array.from(results)[0])[3] === 0, Array.from(results));

  // ================================================================ the owner's signed writer list, through the store
  const WL = await makeStore(people); await feedLogs(WL.store, people);
  const freshW = (person, nonce, objId) => writer(person, person.d1, nonce, objId || OBJ);       // a device writing under a client id of its own
  ok('a page nobody has changed the list of may be written by its owner alone', JSON.stringify(await WL.store.writers(OBJ)) === JSON.stringify([A.did]));
  ok('asking who may write something that is not a page name is refused, not answered', /not the name of a page/.test(await rejects(WL.store.writers('page-one')) || ''));
  const rEarly = await WL.store.add(await (await freshW(B, 'nonce-b-early1')).publish((d) => d.getText('body').insert(0, 'B too early'), []));
  ok('a person nobody has signed in is refused, and nothing of theirs is kept', rEarly.status === 'refused' && /may not write/.test(rEarly.error) && (await WL.store.heads(OBJ)).length === 0 && (await WL.backend.ids('version')).length === 0, rEarly);
  const wlA = await freshW(A, undefined), wlB = await freshW(B, undefined);
  const wlA1 = await wlA.publish((d) => d.getText('body').insert(0, 'owner: hello'), []);
  const rA1 = await WL.store.add(wlA1);
  ok('the owner writes with no list at all', rA1.status === 'accepted', rA1);
  const addB = await policy(A, A.d1, { op: 'add-writer', did: B.did }, [rA1.cid]);
  const rAddB = await WL.store.add(addB);
  ok('the owner signs a person in: the change is accepted and is the page\'s head', rAddB.status === 'accepted' && JSON.stringify(await WL.store.heads(OBJ)) === JSON.stringify([rAddB.cid]), rAddB);
  ok('the page now says who may write it, as of its head and as of the version before the change', JSON.stringify(await WL.store.writers(OBJ)) === JSON.stringify([A.did, B.did]) && JSON.stringify(await WL.store.writers(OBJ, [rA1.cid])) === JSON.stringify([A.did]));
  wlB.apply(kd.unb64u(wlA1.event.payload.update));
  const rB1 = await WL.store.add(await wlB.publish((d) => d.getText('body').insert(0, 'B: '), [rAddB.cid]));
  ok('the person signed in can write, on top of the change that signed them in', rB1.status === 'accepted', rB1);
  const rNoFollow = await WL.store.add(await (await freshW(B, 'nonce-b-nofol1')).publish((d) => d.getText('body').insert(0, 'x'), [rA1.cid]));
  ok('but an edit that does not follow that change is refused: who may write is read from the history an edit follows, not from what this receiver knows now', rNoFollow.status === 'refused' && /may not write/.test(rNoFollow.error), rNoFollow);
  const rCIn = await WL.store.add(await (await freshW(C, 'nonce-c-never1')).publish((d) => d.getText('body').insert(0, 'C'), [rAddB.cid]));
  ok('someone who was never signed in is refused, whatever version they build on', rCIn.status === 'refused' && /may not write/.test(rCIn.error), rCIn);
  const rBsigns = await WL.store.add(await policy(B, B.d1, { op: 'add-writer', did: C.did }, [rB1.cid], { objId: OBJ }));
  ok('a person who was signed in cannot sign anyone else in: only the owner changes the list', rBsigns.status === 'refused' && /only the page's owner/.test(rBsigns.error) && JSON.stringify(await WL.store.writers(OBJ)) === JSON.stringify([A.did, B.did]), rBsigns);
  const remB = await policy(A, A.d1, { op: 'remove-writer', did: B.did }, [rB1.cid]);
  const rRemB = await WL.store.add(remB);
  ok('the owner removes the person: they are no longer on the list', rRemB.status === 'accepted' && JSON.stringify(await WL.store.writers(OBJ)) === JSON.stringify([A.did]), rRemB);
  const rFollow = await WL.store.add(await (await freshW(B, 'nonce-b-follw1')).publish((d) => d.getText('body').insert(0, 'after the removal'), [rRemB.cid]));
  ok('an edit that follows the removal is refused', rFollow.status === 'refused' && /may not write/.test(rFollow.error), rFollow);
  ok('and what the person wrote before the removal stays in the page', (await safeText(WL.store, OBJ)).includes('B: '));
  const rLateB = await WL.store.add(await (await freshW(B, 'nonce-b-late01')).publish((d) => d.getText('body').insert(0, 'LATE '), [rB1.cid]));
  ok('KNOWN LIMIT: a removed person can still write an edit whose parents are from before the removal (nothing in an edit says when it was made); it stands as a separate head until someone merges it', rLateB.status === 'accepted' && (await WL.store.heads(OBJ)).length === 2, rLateB);
  const rAddB2 = await WL.store.add(await policy(A, A.d1, { op: 'add-writer', did: B.did }, [rRemB.cid, rLateB.cid]));
  const rBack = await WL.store.add(await (await freshW(B, 'nonce-b-back01')).publish((d) => d.getText('body').insert(0, 'back '), [rAddB2.cid]));
  ok('signed in again after the removal was seen, the person can write again', rAddB2.status === 'accepted' && rBack.status === 'accepted' && JSON.stringify(await WL.store.writers(OBJ)) === JSON.stringify([A.did, B.did]), [rAddB2, rBack]);
  const listing = await WL.store.versions(OBJ);
  ok('the history lists the list changes beside the edits, marked as what they are, with what they changed', listing.filter((v) => v.kind === 'policy').length === 3 && listing.filter((v) => v.kind === 'edit').length === 4 && listing.some((v) => v.kind === 'policy' && v.change.op === 'remove-writer' && v.change.did === B.did && v.did === A.did), listing.map((v) => v.kind));
  const wlText = await safeText(WL.store, OBJ);
  ok('and the text of the page is made of the edits alone (a list change carries no text, so asking for the text of a page that has list changes in its history works)', !wlText.startsWith('THREW') && ['owner: hello', 'B: ', 'LATE ', 'back '].every((t) => wlText.includes(t)) && !/add-writer|remove-writer/.test(wlText), wlText);
  // on disk, and after the store forgets what is in memory
  let wlDisk = ''; { const dump = WL.backend.dump(); for (const k of Object.keys(dump)) for (const [id, rec] of dump[k]) wlDisk += id + '\n' + rec.iv + '\n' + Buffer.from(rec.ct).toString('latin1') + '\n'; }
  ok('the list changes are sealed on disk like everything else: neither the kind of event, the operation, nor the person named can be read', !wlDisk.includes('keo-wiki-policy') && !wlDisk.includes('add-writer') && !wlDisk.includes('remove-writer') && !wlDisk.includes(B.did) && !wlDisk.includes(kd.parseDid(B.did).dk));
  const wlHeads = JSON.stringify(await WL.store.heads(OBJ));
  await WL.store.unload();
  ok('after the store forgets what is in memory, the list is read from the sealed records again: the same heads, the same writers, and the same refusal of an edit that does not follow the signing-in',
    JSON.stringify(await WL.store.heads(OBJ)) === wlHeads && JSON.stringify(await WL.store.writers(OBJ)) === JSON.stringify([A.did, B.did]) && JSON.stringify(await WL.store.writers(OBJ, [rRemB.cid])) === JSON.stringify([A.did]));
  // nothing a caller can pass or call gives a right the owner did not sign
  const sneaky = S.create({ backend: S.memoryBackend(), key: WL.key, did: WL.did, writers: async () => [A.did, B.did, C.did] });
  await feedLogs(sneaky, people);
  ok('there is no way to tell the store who may write: a "writers" option is not read, and the store has no call that sets them', typeof WL.store.setWriters === 'undefined' && (await sneaky.add(await (await freshW(B, 'nonce-b-snk001')).publish((d) => d.getText('body').insert(0, 'sneak'), []))).status === 'refused');

  // two devices of the owner change the list at the same moment: a removal beats an add, an add made after seeing both brings the person back
  const CO = await makePerson(), CO2 = await CO.addDevice(), OBJ_CO = pageOf(CO);
  const CS = await makeStore([CO, B]); await feedLogs(CS.store, [CO, B]);
  const coAdd = await CS.store.add(await policy(CO, CO.d1, { op: 'add-writer', did: B.did }, []));
  const coRem = await CS.store.add(await policy(CO, CO.d1, { op: 'remove-writer', did: B.did }, [coAdd.cid]));
  const coAdd2 = await CS.store.add(await policy(CO, CO2, { op: 'add-writer', did: B.did }, [coAdd.cid]));
  ok('the owner\'s two devices both made their change on top of the first one: three changes, two heads', coAdd.status === 'accepted' && coRem.status === 'accepted' && coAdd2.status === 'accepted' && (await CS.store.heads(OBJ_CO)).length === 2);
  ok('seen together, the removal wins: the person is not a writer', JSON.stringify(await CS.store.writers(OBJ_CO)) === JSON.stringify([CO.did]) && JSON.stringify(await CS.store.writers(OBJ_CO, [coRem.cid, coAdd2.cid])) === JSON.stringify([CO.did]));
  ok('seen on the add\'s side alone, the person is a writer (an edit built there before the removal was seen stands)', JSON.stringify(await CS.store.writers(OBJ_CO, [coAdd2.cid])) === JSON.stringify([CO.did, B.did]));
  const coB = await CS.store.add(await (await writer(B, B.d1, 'nonce-b-conc01', OBJ_CO)).publish((d) => d.getText('body').insert(0, 'b'), [coAdd2.cid]));
  const coBoth = await CS.store.add(await (await writer(B, B.d1, 'nonce-b-conc02', OBJ_CO)).publish((d) => d.getText('body').insert(0, 'b'), [coRem.cid, coAdd2.cid]));
  ok('so an edit on the add\'s side is accepted and one that follows both changes is refused', coB.status === 'accepted' && coBoth.status === 'refused' && /may not write/.test(coBoth.error), [coB, coBoth]);
  const coAdd3 = await CS.store.add(await policy(CO, CO.d1, { op: 'add-writer', did: B.did }, [coRem.cid, coAdd2.cid]));
  ok('an add made after seeing both brings the person back', coAdd3.status === 'accepted' && JSON.stringify(await CS.store.writers(OBJ_CO, [coAdd3.cid])) === JSON.stringify([CO.did, B.did]));

  // waiting: a change waits for what it follows and for the owner's log, and an edit waits for the change that signs its author in
  const PW = await makeStore(people);
  const pwA = await freshW(A, 'nonce-a-wait01'), pwB = await freshW(B, 'nonce-b-wait01');
  const pwE1 = await pwA.publish((d) => d.getText('body').insert(0, 'first'), []), pwE1cid = await cidOf(pwE1);
  const pwAdd = await policy(A, A.d1, { op: 'add-writer', did: B.did }, [pwE1cid]), pwAddCid = await cidOf(pwAdd);
  const pwB1 = await pwB.publish((d) => d.getText('body').insert(0, 'B'), [pwAddCid]);
  const rWaitLog = await PW.store.add(pwAdd);
  ok('a change whose owner\'s log has not arrived waits (it is not refused)', rWaitLog.status === 'pending' && rWaitLog.waitFor.log === A.did, rWaitLog);
  await feedLogs(PW.store, people);
  ok('with the logs it waits only for the version it follows', (await PW.store.pending(OBJ)).length === 1 && (await PW.store.pending(OBJ))[0].waitFor.parents[0] === pwE1cid);
  const rWaitB = await PW.store.add(pwB1);
  ok('an edit by the person it signs in waits for that change', rWaitB.status === 'pending' && rWaitB.waitFor.parents[0] === pwAddCid, rWaitB);
  const rFirst = await PW.store.add(pwE1);
  ok('when the first version arrives the change and then the edit are accepted by themselves, in that order', rFirst.status === 'accepted' && rFirst.alsoAccepted.join() === [pwAddCid, rWaitB.cid].join() && (await PW.store.pending(OBJ)).length === 0 && JSON.stringify(await PW.store.writers(OBJ)) === JSON.stringify([A.did, B.did]), rFirst);

  // order of arrival: a chain of a change, an edit it allowed, the removal, and the owner's edit after it, in every order
  const OBJ_ORD = pageOf(A, 'order'), ordA = await freshW(A, 'nonce-a-order1', OBJ_ORD), ordB = await freshW(B, 'nonce-b-order1', OBJ_ORD);
  const oPol1 = await policy(A, A.d1, { op: 'add-writer', did: B.did }, [], { objId: OBJ_ORD }), oPol1cid = await cidOf(oPol1);
  const oB1 = await ordB.publish((d) => d.getText('body').insert(0, 'b '), [oPol1cid]), oB1cid = await cidOf(oB1);
  const oPol2 = await policy(A, A.d1, { op: 'remove-writer', did: B.did }, [oB1cid], { objId: OBJ_ORD }), oPol2cid = await cidOf(oPol2);
  const oA1 = await ordA.publish((d) => d.getText('body').insert(0, 'a '), [oPol2cid]);
  const permsOf = (arr) => arr.length <= 1 ? [arr] : arr.flatMap((x, i) => permsOf(arr.slice(0, i).concat(arr.slice(i + 1))).map((p) => [x].concat(p)));
  const ordResults = new Set();
  for (const order of permsOf([oPol1, oB1, oPol2, oA1])) {
    const OS = await makeStore(people); await feedLogs(OS.store, people);
    const answers = await Promise.all(order.map((e) => OS.store.add(e)));
    ordResults.add(JSON.stringify([await OS.store.heads(OBJ_ORD), await OS.store.writers(OBJ_ORD), (await OS.store.pending(OBJ_ORD)).length, answers.filter((a) => a.status === 'refused').length, await safeText(OS.store, OBJ_ORD)]));
  }
  ok('a signing-in, the edit it allowed, the removal and the owner\'s edit after it, sent in each of the 24 possible orders, always end with the same head, the same writers, the same text, nothing waiting and nothing refused', ordResults.size === 1 && JSON.parse(Array.from(ordResults)[0])[1].length === 1 && JSON.parse(Array.from(ordResults)[0])[2] === 0 && JSON.parse(Array.from(ordResults)[0])[3] === 0, Array.from(ordResults));

  // two owners, one name: two pages
  const SP = await makeStore(people); await feedLogs(SP.store, people);
  const nA = pageOf(A, 'notes'), nB = pageOf(B, 'notes');
  const sA = await SP.store.add(await (await writer(A, A.d1, undefined, nA)).publish((d) => d.getText('body').insert(0, 'A notes'), []));
  const sB = await SP.store.add(await (await writer(B, B.d1, undefined, nB)).publish((d) => d.getText('body').insert(0, 'B notes'), []));
  const sAonB = await SP.store.add(await (await writer(A, A.d1, 'nonce-a-onb001', nB)).publish((d) => d.getText('body').insert(0, 'A on B'), []));
  ok('two owners\' pages with the same name are two pages with their own history, kept apart on disk', sA.status === 'accepted' && sB.status === 'accepted' && JSON.stringify(await SP.store.heads(nA)) === JSON.stringify([sA.cid]) && JSON.stringify(await SP.store.heads(nB)) === JSON.stringify([sB.cid]) && SP.backend.dump().page.length === 2);
  ok('and neither owner can write the other\'s page by having picked the same name', sAonB.status === 'refused' && /may not write/.test(sAonB.error), sAonB);

  // the two limits that keep what is held per page bounded
  const fakeDid = (i) => 'did:keo:' + 'y'.repeat(52) + ':' + String(i).padStart(43, 'a');
  const LM = await makeStore(people); await feedLogs(LM.store, people);
  let lmParents = [], lmAccepted = 0, lmFull = null;
  for (let i = 0; i < W.MAX_WRITERS + 1; i++) { const r = await LM.store.add(await policy(A, A.d1, { op: 'add-writer', did: fakeDid(i) }, lmParents)); if (r.status !== 'accepted') { lmFull = r; break; } lmParents = [r.cid]; lmAccepted++; }
  ok('the list takes ' + W.MAX_WRITERS + ' people besides the owner and refuses one more, with a plain message', lmAccepted === W.MAX_WRITERS && lmFull && lmFull.status === 'refused' && /list of who may write this page is full/.test(lmFull.error) && (await LM.store.writers(OBJ)).length === W.MAX_WRITERS + 1, { lmAccepted, lmFull });
  const lmAgain = await LM.store.add(await policy(A, A.d1, { op: 'add-writer', did: fakeDid(0) }, lmParents));
  ok('signing in someone who is already on a full list is not refused (it changes nothing)', lmAgain.status === 'accepted', lmAgain);
  const lmRemove = await LM.store.add(await policy(A, A.d1, { op: 'remove-writer', did: fakeDid(1) }, [lmAgain.cid]));
  const lmReplace = await LM.store.add(await policy(A, A.d1, { op: 'add-writer', did: fakeDid(900) }, [lmRemove.cid]));
  ok('removing one makes room for another', lmRemove.status === 'accepted' && lmReplace.status === 'accepted', [lmRemove, lmReplace]);
  const LE = await makeStore(people); await feedLogs(LE.store, people);
  let leParents = [], leAccepted = 0, leStop = null;
  for (let i = 0; i < W.MAX_POLICY_EVENTS + 1; i++) { const r = await LE.store.add(await policy(A, A.d1, { op: i % 2 ? 'remove-writer' : 'add-writer', did: fakeDid(7) }, leParents)); if (r.status !== 'accepted') { leStop = r; break; } leParents = [r.cid]; leAccepted++; }
  ok('a page takes ' + W.MAX_POLICY_EVENTS + ' changes of its list and refuses the next, with a plain message', leAccepted === W.MAX_POLICY_EVENTS && leStop && leStop.status === 'refused' && /as many changes of who may write it as this version allows/.test(leStop.error), { leAccepted, leStop });
  const polJunk = [{ event: { purpose: 'keo-wiki-policy', objId: 5 }, sig: 'a' }, { event: { purpose: 'keo-wiki-policy' }, sig: 'a' }, { event: { purpose: 'keo-wiki-policy', objId: OBJ, change: null }, sig: 'a' }];
  const polJunkAnswers = []; for (const j of polJunk) polJunkAnswers.push(await WL.store.add(j).catch((e) => ({ threw: e.message })));
  ok('a malformed change of the list is refused and never makes the store throw', polJunkAnswers.every((a) => a.status === 'refused'), polJunkAnswers);

  // ================================================================ purge
  await S1.store.purge();
  ok('removing the store\'s contents leaves nothing on disk and nothing in memory', (await Promise.all(['page', 'version', 'pending', 'log', 'meta'].map((k) => S1.backend.ids(k)))).every((l) => l.length === 0) && (await S1.store.heads(OBJ)).length === 0 && (await S1.store.logOf(A.did)) === null);

  // ================================================================ close (a session that ended)
  // A backend whose write of a version waits for a gate, so that one add is RUNNING while the store is closed and another has not started.
  const mem = S.memoryBackend(); let release, started = false; const gate = new Promise((r) => { release = r; });
  const slow = { get: mem.get, del: mem.del, ids: mem.ids, put: async (k, id, rec) => { if (k === 'version') { started = true; await gate; } return mem.put(k, id, rec); } };
  const CL = await makeStore(people, { backend: slow }); await feedLogs(CL.store, people);
  const clw = await writer(A, A.d1);
  const c1 = await clw.publish((d) => d.getText('body').insert(0, 'one'));
  const c2 = await clw.publish((d) => d.getText('body').insert(3, ' two'), [await cidOf(c1)]);
  const running = CL.store.add(c1);
  for (let i = 0; i < 200 && !started; i++) await new Promise((r) => setTimeout(r, 5));         // the add is now inside its write, waiting at the gate
  ok('setup: the first add is running, held inside its write of the version', started === true);
  const queuedMsg = rejects(CL.store.add(c2));
  const closing = CL.store.close(); let closeDone = false; closing.then(() => { closeDone = true; });
  await new Promise((r) => setTimeout(r, 30));
  ok('close does not finish while an operation is still running', closeDone === false && (await mem.ids('version')).length === 0);
  release();
  const ran = await running; await closing;
  ok('the operation that was running finishes and its edit is kept', ran.status === 'accepted' && (await mem.ids('version')).length === 1, ran);
  ok('the one that had not started is refused, and writes nothing', /closed/.test(await queuedMsg || '') && (await mem.ids('version')).length === 1);
  const afterClose = await Promise.all([rejects(CL.store.heads(OBJ)), rejects(CL.store.add(c2)), rejects(CL.store.offerLog(A.did, A.snapshot())), rejects(CL.store.alerts()), rejects(CL.store.purge()), rejects(CL.store.state(OBJ))]);
  ok('after close every kind of operation refuses to run', afterClose.every((m) => /closed/.test(m || '')), afterClose);
  ok('closing a second time is harmless', (await CL.store.close()) === undefined);
  const reopened = S.create({ backend: mem, key: CL.key, did: CL.did });
  ok('a new store over the same disk and key reads what the closed one kept', JSON.stringify(await reopened.heads(OBJ)) === JSON.stringify([ran.cid]));

  // ================================================================ never throws on garbage
  const G = await makeStore(people); await feedLogs(G.store, people);
  const junk = [null, undefined, 0, 'x', [], {}, { event: {}, sig: 'a' }, { event: { objId: 'p' }, sig: 'a' }, { event: { objId: 5 }, sig: 'a' }];
  const answers = [];
  for (const j of junk) answers.push(await G.store.add(j).catch((e) => ({ threw: e.message })));
  ok('nothing that is not a signed wiki version is accepted, and none of ' + junk.length + ' malformed inputs makes the store throw', answers.every((a) => a.status === 'refused'), answers);

  console.log(passed + ' checks passed' + (process.exitCode ? ', SOME FAILED' : ''));
})().catch((e) => { console.error(e); process.exit(1); });
