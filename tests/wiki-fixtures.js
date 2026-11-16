// Fixtures for the wiki store tests (node and browser): people with real identity logs and device keys, and the signed edits a device writes
// (real Yjs updates, signed with keo-wikilog.js). Shared by tests/keo-wikistore-test.js and tests/keo-wikistore-idb-test.js, which carries
// the envelopes and logs it builds into the shell page as plain JSON. Test code only: it makes keys in memory and signs with them.
const path = require('path');
const kd = require(path.join(__dirname, '..', 'shell', 'keo-did.js'));
const Y = require(path.join(__dirname, '..', 'shell', 'keo-yjs.js'));
const W = require(path.join(__dirname, '..', 'shell', 'keo-wikilog.js'));
const subtle = globalThis.crypto.subtle;
const enc = new TextEncoder();

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
// A page is named by its owner and a name. `pageOf(person)` is the page of that name that person owns; a writer who is not its owner
// can write it only once the owner has signed them in (policy below).
const pageOf = (person, name) => W.pageId(person.did, name || 'page-one');
let nonceCounter = 0;
// One device's way of writing a page: its Yjs document under its derived client id, and a function that signs what changed. The page
// is `objId`, by default the page of that name the writer's own identity owns.
async function writer(person, dev, nonce, objId) {
  nonce = nonce || ('nonce-w' + (++nonceCounter).toString().padStart(4, '0') + 'xx');
  objId = objId || pageOf(person);
  const doc = new Y.Doc(); doc.clientID = await W.clientIdFor(dev.id, objId, nonce);
  const w = { person, dev, doc, nonce, objId: objId };
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
// A signed change of a page's writer list, made by `person`'s device `dev` (the page's owner, or someone pretending to be, in a test of
// the refusal): `change` is { op: 'add-writer' | 'remove-writer', did }, `parents` the versions the owner's device holds as the heads.
// `o`: { objId (default: the person's own page), point (a point of the person's log), created }.
async function policy(person, dev, change, parents, o) {
  o = o || {};
  const ev = W.buildPolicy({ objId: o.objId || pageOf(person), parents: parents || [], author: { did: person.did, deviceId: dev.id }, authorLog: o.point || await person.point(), change, created: o.created });
  return W.seal(ev, person.signer(dev));
}
const cidOf = (env) => W.versionId(env.event);
const textOf = (update) => { const d = new Y.Doc(); Y.applyUpdate(d, update); return d.getText('body').toString(); };

module.exports = { pageOf, rawToDer, assertion, plain, newPair, makeDevice, makePerson, writer, policy, cidOf, textOf };
