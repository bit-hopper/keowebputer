// Node test for keo-did.js: no browser, no authenticator.
// A WebAuthn assertion is imitated: an ES256 key signs authenticatorData || SHA-256(clientDataJSON) and the signature is
// converted to DER, which is the form an authenticator returns.
// Usage: node keo-did-test.js
const assert = require('assert');
const path = require('path');
const kd = require(path.join(__dirname, '..', 'shell', 'keo-did.js'));
const subtle = globalThis.crypto.subtle;
const enc = new TextEncoder();
let passed = 0;
const ok = (name, cond, extra) => { if (!cond) { console.error('FAIL ' + name + (extra ? ' ' + extra : '')); process.exitCode = 1; } else { passed++; console.log('ok   ' + name); } };

function rawToDer(raw) {
  const int = (b) => { let i = 0; while (i < b.length - 1 && b[i] === 0) i++; b = b.slice(i); if (b[0] & 0x80) b = Buffer.concat([Buffer.from([0]), b]); return Buffer.concat([Buffer.from([0x02, b.length]), b]); };
  const body = Buffer.concat([int(Buffer.from(raw.slice(0, 32))), int(Buffer.from(raw.slice(32)))]);
  return Buffer.concat([Buffer.from([0x30, body.length]), body]);
}

async function makeAssertion(privateKey, challengeBytes, type) {
  const authenticatorData = crypto.getRandomValues(new Uint8Array(37));
  const clientDataJSON = enc.encode(JSON.stringify({ type: type || 'webauthn.get', challenge: kd.b64u(challengeBytes), origin: 'chrome-extension://test' }));
  const input = Buffer.concat([Buffer.from(authenticatorData), Buffer.from(await kd.sha256(clientDataJSON))]);
  const raw = new Uint8Array(await subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, privateKey, input));
  return { authenticatorData: kd.b64u(authenticatorData), clientDataJSON: kd.b64u(clientDataJSON), signature: kd.b64u(rawToDer(raw)) };
}

(async () => {
  // ---- encodings
  ok('z32: 0x00 encodes to "yy"', kd.z32encode(new Uint8Array([0])) === 'yy');
  // An independent encoder (a string of bits cut into groups of five) instead of a remembered test vector.
  const slowZ32 = (bytes) => { const bits = Array.from(bytes).map((b) => b.toString(2).padStart(8, '0')).join(''); let o = ''; for (let i = 0; i < bits.length; i += 5) o += 'ybndrfg8ejkmcpqxot1uwisza345h769'[parseInt(bits.slice(i, i + 5).padEnd(5, '0'), 2)]; return o; };
  ok('z32: agrees with a bit-string encoder on 300 random inputs of 1-40 bytes', (() => { for (let i = 0; i < 300; i++) { const b = crypto.getRandomValues(new Uint8Array(1 + (i % 40))); const e = kd.z32encode(b); if (e !== slowZ32(b) || !Buffer.from(kd.z32decode(e)).equals(Buffer.from(b))) return false; } return true; })());
  ok('z32: "hello" is pb1sa5dx', kd.z32encode(enc.encode('hello')) === 'pb1sa5dx', kd.z32encode(enc.encode('hello')));
  const rnd = crypto.getRandomValues(new Uint8Array(32));
  ok('z32: 32 bytes -> 52 chars and back', kd.z32encode(rnd).length === 52 && Buffer.from(kd.z32decode(kd.z32encode(rnd))).equals(Buffer.from(rnd)));
  ok('b64u round trip', Buffer.from(kd.unb64u(kd.b64u(rnd))).equals(Buffer.from(rnd)));
  ok('derToRaw handles short and padded integers', (() => { for (let i = 0; i < 200; i++) { const r = crypto.getRandomValues(new Uint8Array(64)); if (i % 3 === 0) { r[0] = 0; r[32] = 0; } if (i % 3 === 1) { r[0] |= 0x80; r[32] |= 0x80; } if (!Buffer.from(kd.derToRaw(rawToDer(r))).equals(Buffer.from(r))) return false; } return true; })());

  // ---- discovery key derivation
  const secret = await subtle.generateKey({ name: 'HMAC', hash: 'SHA-256', length: 256 }, true, ['sign']);
  const seed1 = await kd.discoverySeed(secret, 1), seed1b = await kd.discoverySeed(secret, 1), seed2 = await kd.discoverySeed(secret, 2);
  ok('seed is 32 bytes and deterministic', seed1.length === 32 && Buffer.from(seed1).equals(Buffer.from(seed1b)));
  ok('seed changes with the version label', !Buffer.from(seed1).equals(Buffer.from(seed2)));
  const other = await subtle.generateKey({ name: 'HMAC', hash: 'SHA-256', length: 256 }, true, ['sign']);
  ok('seed changes with the secret', !Buffer.from(await kd.discoverySeed(other, 1)).equals(Buffer.from(seed1)));
  const disc = await kd.ed25519FromSeed(seed1), disc2 = await kd.ed25519FromSeed(seed1);
  ok('same seed gives the same public key', disc.publicZ32 === disc2.publicZ32 && disc.publicZ32.length === 52);
  ok('the kept private key is not extractable', disc.privateKey.extractable === false);

  // ---- an inception with one authority key
  const authPair = await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const authJwk = await subtle.exportKey('jwk', authPair.publicKey);
  const keyId = kd.b64u(crypto.getRandomValues(new Uint8Array(16)));
  const inception = { v: 1, type: 'inception', seq: 0, prev: null, time: new Date().toISOString(), state: {
    authority: { threshold: 1, keys: [{ id: keyId, jwk: authJwk, rpId: 'testid', kind: 'platform', addedAt: new Date().toISOString() }] },
    next: null, recovery: { guardians: [], threshold: 2, delayDays: 3 }, discovery: { key: disc.publicZ32, version: 1 },
    services: [], claims: { handles: [] }, revoked: [] } };
  const H = await kd.eventHash(inception);
  const good = { inception, sigs: {
    discovery: kd.b64u(await subtle.sign({ name: 'Ed25519' }, disc.privateKey, H)),
    authority: [Object.assign({ keyId }, await makeAssertion(authPair.privateKey, H))] } };
  const did = kd.didFor(disc.publicZ32, kd.b64u(H));
  const v = await kd.verifyInception(good);
  ok('a well-formed inception verifies and yields the DID', v.ok === true && v.did === did, JSON.stringify(v));
  ok('the DID parses back to its two parts', (() => { const p = kd.parseDid(did); return p && p.dk === disc.publicZ32 && p.h === kd.b64u(H); })());
  ok('parseDid rejects the draft form and junk', kd.parseDid('did:keo-draft:abc') === null && kd.parseDid('did:keo:short:x') === null && kd.parseDid(null) === null);
  ok('"sigs" never enters the hash', kd.b64u(await kd.eventHash(Object.assign({}, inception, { sigs: { x: 1 } }))) === kd.b64u(H));

  // ---- the device list in the inception (optional, validated when present)
  const withDevices = async (devices) => {
    const e = JSON.parse(JSON.stringify(inception)); e.state.devices = devices;
    const He = await kd.eventHash(e);
    return { inception: e, sigs: { discovery: kd.b64u(await subtle.sign({ name: 'Ed25519' }, disc.privateKey, He)),
      authority: [Object.assign({ keyId }, await makeAssertion(authPair.privateKey, He))] } };
  };
  const devPair = await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const devJwk = await subtle.exportKey('jwk', devPair.publicKey), devPrivJwk = await subtle.exportKey('jwk', devPair.privateKey);
  const devEntry = { id: kd.b64u(await kd.sha256(enc.encode(kd.canonicalJson({ kty: devJwk.kty, crv: devJwk.crv, x: devJwk.x, y: devJwk.y })))), jwk: { kty: devJwk.kty, crv: devJwk.crv, x: devJwk.x, y: devJwk.y }, addedAt: new Date().toISOString() };
  ok('an inception that lists a device key verifies', (await kd.verifyInception(await withDevices([devEntry]))).ok === true);
  ok('a device list that is not an array is rejected', (await kd.verifyInception(await withDevices('x'))).ok === false);
  ok('a device entry with a private member is rejected', (await kd.verifyInception(await withDevices([{ id: 'a', jwk: devPrivJwk, addedAt: 'x' }]))).ok === false);
  ok('a device entry that is not a P-256 key is rejected', (await kd.verifyInception(await withDevices([{ id: 'a', jwk: { kty: 'OKP', crv: 'Ed25519', x: 'aa' }, addedAt: 'x' }]))).ok === false);

  // ---- things that must NOT verify
  const clone = () => JSON.parse(JSON.stringify(good));
  let t = clone(); t.inception.state.services = [{ id: 'x', type: 'https', endpoint: 'https://evil.example' }];
  ok('changing the state after signing is rejected', (await kd.verifyInception(t)).ok === false);
  t = clone(); t.sigs.discovery = kd.b64u(await subtle.sign({ name: 'Ed25519' }, (await kd.ed25519FromSeed(crypto.getRandomValues(new Uint8Array(32)))).privateKey, H));
  ok('a discovery signature from another key is rejected', (await kd.verifyInception(t)).ok === false);
  t = clone(); delete t.sigs.discovery;
  ok('no discovery possession signature is rejected', (await kd.verifyInception(t)).ok === false);
  t = clone(); t.sigs.authority = [];
  ok('no authority signature is rejected', (await kd.verifyInception(t)).ok === false);
  const stranger = await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  t = clone(); t.sigs.authority = [Object.assign({ keyId }, await makeAssertion(stranger.privateKey, H))];
  ok('an authority signature from a key not in the state is rejected', (await kd.verifyInception(t)).ok === false);
  t = clone(); t.sigs.authority = [Object.assign({ keyId }, await makeAssertion(authPair.privateKey, crypto.getRandomValues(new Uint8Array(32))))];
  ok('an assertion over another challenge is rejected', (await kd.verifyInception(t)).ok === false);
  t = clone(); t.sigs.authority = [Object.assign({ keyId }, await makeAssertion(authPair.privateKey, H, 'webauthn.create'))];
  ok('an assertion of the wrong ceremony type is rejected', (await kd.verifyInception(t)).ok === false);
  t = clone(); t.sigs.authority = [good.sigs.authority[0], good.sigs.authority[0]]; t.inception.state.authority.threshold = 2;
  ok('one key signing twice does not meet a threshold of two', (await kd.verifyInception(t)).ok === false);
  t = clone(); t.inception.seq = 1;
  ok('a non-inception event is rejected', (await kd.verifyInception(t)).ok === false);
  t = clone(); t.inception.state.discovery.key = 'tooshort';
  ok('a malformed discovery key is rejected', (await kd.verifyInception(t)).ok === false);

  // ---- the log after the inception: a second passkey, made on another origin, added to the same identity
  const pubOf = async (pair) => { const j = await subtle.exportKey('jwk', pair.publicKey); return { kty: j.kty, crv: j.crv, x: j.x, y: j.y }; };
  const mkKey = async (rpId) => {
    const pair = await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
    return { pair, entry: { id: kd.b64u(crypto.getRandomValues(new Uint8Array(16))), jwk: await pubOf(pair), rpId: rpId || 'keo.test', kind: 'platform', addedAt: new Date().toISOString() } };
  };
  const as = (keyId, pair) => ({ keyId, pair });
  // signs an event the way the two sides would: the existing keys and the new one each sign H(e)
  const signEvent = async (e, oldSigners, nw) => {
    const He = await kd.eventHash(e);
    return { event: e, sigs: {
      authority: await Promise.all(oldSigners.map(async (s) => Object.assign({ keyId: s.keyId }, await makeAssertion(s.pair.privateKey, He)))),
      newKey: nw ? Object.assign({ keyId: nw.keyId }, await makeAssertion(nw.pair.privateKey, He)) : undefined } };
  };
  const logOf = (events) => ({ inception: good.inception, sigs: good.sigs, events });
  const k2 = await mkKey(), k3 = await mkKey('another.test');
  const dev2 = { id: devEntry.id, jwk: devEntry.jwk, addedAt: devEntry.addedAt };
  const e1 = await kd.addAuthorityEvent(good.inception, k2.entry, dev2);
  const s1 = await signEvent(e1, [as(keyId, authPair)], as(k2.entry.id, k2.pair));
  ok('the first event follows the inception: seq 1, prev is the inception hash', e1.seq === 1 && e1.prev === kd.b64u(H) && e1.type === 'add-authority');
  let r = await kd.verifyLog(logOf([s1]));
  ok('a log with a second authority key verifies and the DID is unchanged', r.ok === true && r.did === did, JSON.stringify(r));
  ok('the folded state lists both keys and the new device', r.ok && r.state.authority.keys.length === 2 && r.state.devices.length === 1 && r.seq === 1);
  ok('verifying does not change the log it was given', !JSON.stringify(good.inception).includes(k2.entry.id));
  ok('a log with no events verifies like the inception alone', (await kd.verifyLog(logOf([]))).ok === true && (await kd.verifyLog({ inception: good.inception, sigs: good.sigs })).ok === true);
  ok('the DID the caller expects is checked', (await kd.verifyLog(logOf([s1]), did)).ok === true && (await kd.verifyLog(logOf([s1]), did.slice(0, -1) + (did.endsWith('A') ? 'B' : 'A'))).ok === false);
  const e2 = await kd.addAuthorityEvent(e1, k3.entry);
  const s2 = await signEvent(e2, [as(k2.entry.id, k2.pair)], as(k3.entry.id, k3.pair));
  r = await kd.verifyLog(logOf([s1, s2]));
  ok('the key added by an event can authorise the next one, and the chain folds in order', r.ok === true && r.state.authority.keys.length === 3 && r.seq === 2, JSON.stringify(r));

  const bad = async (name, events, at) => { const x = await kd.verifyLog(logOf(events)); ok(name, x.ok === false && (at === undefined || x.failedAt === at), JSON.stringify(x)); };
  const tamper = (s, f) => { const c = JSON.parse(JSON.stringify(s)); f(c); return c; };
  await bad('an event the new key did not sign is rejected', [await signEvent(e1, [as(keyId, authPair)], null)], 1);
  await bad('an event signed by a stranger instead of the new key is rejected', [await signEvent(e1, [as(keyId, authPair)], as(k2.entry.id, stranger))], 1);
  await bad('an event with no signature from an existing key is rejected', [await signEvent(e1, [], as(k2.entry.id, k2.pair))], 1);
  await bad('an event the new key signed but a stranger posed as an existing key is rejected', [await signEvent(e1, [as(keyId, stranger)], as(k2.entry.id, k2.pair))], 1);
  await bad('the new key cannot authorise its own addition', [await signEvent(e1, [as(k2.entry.id, k2.pair)], as(k2.entry.id, k2.pair))], 1);
  await bad('changing the event after signing is rejected', [tamper(s1, (c) => { c.event.add.key.rpId = 'evil.test'; })], 1);
  await bad('swapping the added key after signing is rejected', [tamper(s1, (c) => { c.event.add.key.jwk = k3.entry.jwk; })], 1);
  await bad('a wrong seq is rejected', [await signEvent(Object.assign({}, e1, { seq: 2 }), [as(keyId, authPair)], as(k2.entry.id, k2.pair))], 1);
  await bad('a wrong prev is rejected', [await signEvent(Object.assign({}, e1, { prev: kd.b64u(crypto.getRandomValues(new Uint8Array(32))) }), [as(keyId, authPair)], as(k2.entry.id, k2.pair))], 1);
  await bad('an event of an unknown type is rejected', [await signEvent(Object.assign({}, e1, { type: 'rotate' }), [as(keyId, authPair)], as(k2.entry.id, k2.pair))], 1);
  await bad('a second event that extends the inception again (a fork) is rejected', [s1, await signEvent(await kd.addAuthorityEvent(good.inception, k3.entry), [as(keyId, authPair)], as(k3.entry.id, k3.pair))], 2);
  await bad('adding a key id the identity already has is rejected', [s1, await signEvent(await kd.addAuthorityEvent(e1, Object.assign({}, k3.entry, { id: k2.entry.id })), [as(keyId, authPair)], as(k2.entry.id, k3.pair))], 2);
  await bad('a key with a private member is rejected', [await signEvent(await kd.addAuthorityEvent(good.inception, Object.assign({}, k2.entry, { jwk: await subtle.exportKey('jwk', k2.pair.privateKey) })), [as(keyId, authPair)], as(k2.entry.id, k2.pair))], 1);
  await bad('an event list that is not a list is rejected', 'x');
  // an event signed for one identity does not graft onto another: prev is that identity's inception hash
  const other2 = JSON.parse(JSON.stringify(good)); other2.inception.state.services = [{ id: 'y', type: 'https', endpoint: 'https://other.example' }];
  const Hother = await kd.eventHash(other2.inception);
  other2.sigs = { discovery: kd.b64u(await subtle.sign({ name: 'Ed25519' }, disc.privateKey, Hother)), authority: [Object.assign({ keyId }, await makeAssertion(authPair.privateKey, Hother))] };
  r = await kd.verifyLog({ inception: other2.inception, sigs: other2.sigs, events: [s1] });
  ok('an event made for one identity is rejected on another, even with the same keys', r.ok === false && r.failedAt === 1, JSON.stringify(r));
  ok('isPublicEcJwk accepts a public P-256 key and refuses private, non-EC and incomplete ones',
    kd.isPublicEcJwk(k2.entry.jwk) && !kd.isPublicEcJwk(await subtle.exportKey('jwk', k2.pair.privateKey)) &&
    !kd.isPublicEcJwk({ kty: 'OKP', crv: 'Ed25519', x: 'aa' }) && !kd.isPublicEcJwk({ kty: 'EC', crv: 'P-256', x: 'aa' }) && !kd.isPublicEcJwk(null));

  // an identity that needs TWO authority keys: one key signing twice must not add a third, two different ones must
  const kb = await mkKey('b.test');
  const inc2 = JSON.parse(JSON.stringify(inception));
  inc2.state.authority = { threshold: 2, keys: [inception.state.authority.keys[0], kb.entry] };
  const H2 = await kd.eventHash(inc2);
  const base2 = { inception: inc2, sigs: { discovery: kd.b64u(await subtle.sign({ name: 'Ed25519' }, disc.privateKey, H2)),
    authority: [Object.assign({ keyId }, await makeAssertion(authPair.privateKey, H2)), Object.assign({ keyId: kb.entry.id }, await makeAssertion(kb.pair.privateKey, H2))] } };
  ok('an inception with two required keys verifies', (await kd.verifyInception(base2)).ok === true);
  const kc = await mkKey('c.test');
  const ec = await kd.addAuthorityEvent(inc2, kc.entry);
  const twice = await signEvent(ec, [as(keyId, authPair), as(keyId, authPair)], as(kc.entry.id, kc.pair));
  let r2 = await kd.verifyLog({ inception: base2.inception, sigs: base2.sigs, events: [twice] });
  ok('one key signing twice does not meet a threshold of two for an added key', r2.ok === false && r2.failedAt === 1, JSON.stringify(r2));
  const both = await signEvent(ec, [as(keyId, authPair), as(kb.entry.id, kb.pair)], as(kc.entry.id, kc.pair));
  r2 = await kd.verifyLog({ inception: base2.inception, sigs: base2.sigs, events: [both] });
  ok('two different existing keys do', r2.ok === true && r2.state.authority.keys.length === 3 && r2.state.authority.threshold === 2, JSON.stringify(r2));

  const withTwo = JSON.parse(JSON.stringify(good)); withTwo.inception.state.authority.threshold = 2;
  ok('verifyInception is untouched by all of this (a threshold the lone key cannot meet still fails)', (await kd.verifyInception(withTwo)).ok === false);

  // ---- the phone: a key that signs raw, domain-separated messages instead of WebAuthn assertions
  // The software "phone" below builds the signed message WITHOUT keo-did's rawMessage, from the written rule, so a drift in the
  // verifier and in this file cannot hide each other: a phone app has to reproduce the same bytes.
  const rawMsg = (purpose, h) => Buffer.concat([Buffer.from('keo/authority/v1'), Buffer.from([0]), Buffer.from(purpose), Buffer.from([0]), Buffer.from(h)]);
  const phoneSign = async (keyId, pair, purpose, h) => ({ keyId, scheme: 'p256-raw', signature: kd.b64u(new Uint8Array(await subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, pair.privateKey, rawMsg(purpose, h)))) });
  const mkPhone = async () => { const m = await mkKey('phone'); m.entry.kind = 'phone'; delete m.entry.rpId; return m; };
  ok('rawMessage is the label, a zero, the purpose, a zero, then the hash', Buffer.from(kd.rawMessage('session', H)).equals(rawMsg('session', H)));
  ok('the six purposes are the ones the log and the certificate use (the first four unchanged, the two removals after them)', kd.PURPOSES.join() === 'inception,add-authority,add-device,session,remove-authority,remove-device');

  // an identity whose ONLY authority is a phone (allowed: a lost phone is then a lost identity unless a second way back exists)
  const ph = await mkPhone();
  const incP = JSON.parse(JSON.stringify(inception)); incP.state.authority = { threshold: 1, keys: [ph.entry] };
  const HP = await kd.eventHash(incP);
  const goodP = { inception: incP, sigs: { discovery: kd.b64u(await subtle.sign({ name: 'Ed25519' }, disc.privateKey, HP)), authority: [await phoneSign(ph.entry.id, ph.pair, 'inception', HP)] } };
  const vP = await kd.verifyInception(goodP);
  ok('an inception signed only by a phone key verifies', vP.ok === true && vP.did === kd.didFor(disc.publicZ32, kd.b64u(HP)), JSON.stringify(vP));
  const inceptionBad = async (name, sig) => ok(name, (await kd.verifyInception({ inception: incP, sigs: { discovery: goodP.sigs.discovery, authority: [sig] } })).ok === false);
  await inceptionBad('a phone signature made for another purpose is rejected', await phoneSign(ph.entry.id, ph.pair, 'session', HP));
  await inceptionBad('a phone signature over another hash is rejected', await phoneSign(ph.entry.id, ph.pair, 'inception', H));
  await inceptionBad('a phone signature by a stranger is rejected', await phoneSign(ph.entry.id, stranger, 'inception', HP));
  await inceptionBad('a bare signature over the hash (no label, no purpose) is rejected', { keyId: ph.entry.id, scheme: 'p256-raw', signature: kd.b64u(new Uint8Array(await subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, ph.pair.privateKey, HP))) });
  const noSeparator = Buffer.concat([Buffer.from('keo/authority/v1'), Buffer.from([0]), Buffer.from('inception'), Buffer.from(HP)]);
  await inceptionBad('a message without the zero between the purpose and the hash is rejected', { keyId: ph.entry.id, scheme: 'p256-raw', signature: kd.b64u(new Uint8Array(await subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, ph.pair.privateKey, noSeparator))) });
  await inceptionBad('a DER-encoded signature is rejected, only r||s is accepted', { keyId: ph.entry.id, scheme: 'p256-raw', signature: kd.b64u(rawToDer(kd.unb64u((await phoneSign(ph.entry.id, ph.pair, 'inception', HP)).signature))) });
  await inceptionBad('a signature with no scheme is not read as raw', Object.assign({}, await phoneSign(ph.entry.id, ph.pair, 'inception', HP), { scheme: undefined }));
  await inceptionBad('an unknown scheme is rejected', Object.assign({}, await phoneSign(ph.entry.id, ph.pair, 'inception', HP), { scheme: 'p384-raw' }));
  await inceptionBad('a raw signature for a key that is not listed is rejected', await phoneSign('nobody', ph.pair, 'inception', HP));
  // the kind decides the scheme, in both directions
  await inceptionBad('a WebAuthn assertion cannot stand in for a phone key', Object.assign({ keyId: ph.entry.id }, await makeAssertion(ph.pair.privateKey, HP)));
  const rawForPasskey = async () => { const r = JSON.parse(JSON.stringify(good)); r.sigs.authority = [await phoneSign(keyId, authPair, 'inception', H)]; return r; };
  ok('a raw signature cannot stand in for a passkey', (await kd.verifyInception(await rawForPasskey())).ok === false);
  const kindOf = async (kind) => { const e = JSON.parse(JSON.stringify(inception)); e.state.authority.keys[0].kind = kind; const He = await kd.eventHash(e); return { inception: e, sigs: { discovery: kd.b64u(await subtle.sign({ name: 'Ed25519' }, disc.privateKey, He)), authority: [Object.assign({ keyId }, await makeAssertion(authPair.privateKey, He))] } }; };
  ok('a key kind of "security-key" is accepted', (await kd.verifyInception(await kindOf('security-key'))).ok === true);
  ok('an unknown key kind is rejected', (await kd.verifyInception(await kindOf('tpm'))).ok === false);
  ok('a key with no kind (a log made before phones) still verifies', (await kd.verifyInception(await kindOf(undefined))).ok === true);

  // a phone is added to an identity that has a passkey, and the passkey can then be left out
  const logP = (events) => ({ inception: good.inception, sigs: good.sigs, events });
  const phoneEvent = async (prev, key, device) => kd.addAuthorityEvent(prev, key.entry, device);
  const eP = await phoneEvent(good.inception, ph);
  const signAdd = async (e, oldSigners, newKey, newPair) => { const He = await kd.eventHash(e); return { event: e, sigs: { authority: oldSigners, newKey: newKey } , He }; };
  let sAdd = await signAdd(eP);
  sAdd.sigs.authority = [Object.assign({ keyId }, await makeAssertion(authPair.privateKey, sAdd.He))];
  sAdd.sigs.newKey = await phoneSign(ph.entry.id, ph.pair, 'add-authority', sAdd.He);
  r = await kd.verifyLog(logP([{ event: sAdd.event, sigs: sAdd.sigs }]));
  ok('a passkey identity adds a phone: the passkey signs, the phone signs for itself', r.ok === true && r.state.authority.keys.length === 2 && r.state.authority.keys[1].kind === 'phone', JSON.stringify(r));
  const badNew = JSON.parse(JSON.stringify(sAdd.sigs)); badNew.newKey = await phoneSign(ph.entry.id, ph.pair, 'session', sAdd.He);
  r = await kd.verifyLog(logP([{ event: sAdd.event, sigs: badNew }]));
  ok('a phone that signed for the wrong purpose does not count as having signed', r.ok === false && r.failedAt === 1, JSON.stringify(r));
  const badNew2 = JSON.parse(JSON.stringify(sAdd.sigs)); badNew2.newKey = Object.assign({ keyId: ph.entry.id }, await makeAssertion(ph.pair.privateKey, sAdd.He));
  r = await kd.verifyLog(logP([{ event: sAdd.event, sigs: badNew2 }]));
  ok('a new phone key cannot prove itself with a WebAuthn assertion', r.ok === false && r.failedAt === 1);

  // the phone, as the only authority, adds a second phone and a computer
  const ph2 = await mkPhone();
  const eP2 = await kd.addAuthorityEvent(incP, ph2.entry);
  const HP2 = await kd.eventHash(eP2);
  const sP2 = { event: eP2, sigs: { authority: [await phoneSign(ph.entry.id, ph.pair, 'add-authority', HP2)], newKey: await phoneSign(ph2.entry.id, ph2.pair, 'add-authority', HP2) } };
  const logPhone = (events) => ({ inception: incP, sigs: goodP.sigs, events });
  r = await kd.verifyLog(logPhone([sP2]));
  ok('a phone that is the only authority adds a second phone', r.ok === true && r.state.authority.keys.length === 2, JSON.stringify(r));
  const sP2bad = JSON.parse(JSON.stringify(sP2)); sP2bad.sigs.authority = [await phoneSign(ph.entry.id, ph.pair, 'add-device', HP2)];
  r = await kd.verifyLog(logPhone([sP2bad]));
  ok('the existing phone\'s signature for another purpose does not authorise adding a key', r.ok === false && r.failedAt === 1);

  // ---- add-device: a computer's key delegated by an existing authority, no new authority key
  const eD = await kd.addDeviceEvent(incP, dev2);
  const HD = await kd.eventHash(eD);
  const sD = { event: eD, sigs: { authority: [await phoneSign(ph.entry.id, ph.pair, 'add-device', HD)] } };
  ok('an add-device event is typed, numbered and chained', eD.type === 'add-device' && eD.seq === 1 && eD.prev === kd.b64u(HP) && eD.add.device.id === dev2.id && eD.add.key === undefined);
  r = await kd.verifyLog(logPhone([sD]));
  ok('a computer is added to a phone identity by the phone alone', r.ok === true && r.state.devices.length === 1 && r.state.authority.keys.length === 1 && r.seq === 1, JSON.stringify(r));
  ok('the DID does not change when a computer is added', r.did === kd.didFor(disc.publicZ32, kd.b64u(HP)));
  const badD = async (name, entry, at) => { const x = await kd.verifyLog(logPhone(entry)); ok(name, x.ok === false && x.failedAt === (at || 1), JSON.stringify(x)); };
  await badD('an add-device event signed for the add-authority purpose is rejected', [{ event: eD, sigs: { authority: [await phoneSign(ph.entry.id, ph.pair, 'add-authority', HD)] } }]);
  await badD('an add-device event with no signature is rejected', [{ event: eD, sigs: { authority: [] } }]);
  await badD('an add-device event signed by a stranger is rejected', [{ event: eD, sigs: { authority: [await phoneSign(ph.entry.id, stranger, 'add-device', HD)] } }]);
  await badD('an add-device event whose device was swapped after signing is rejected', [tamper(sD, (c) => { c.event.add.device.jwk = k3.entry.jwk; })]);
  await badD('an add-device event with no device is rejected', [await (async () => { const e = Object.assign({}, eD, { add: {} }); const He = await kd.eventHash(e); return { event: e, sigs: { authority: [await phoneSign(ph.entry.id, ph.pair, 'add-device', He)] } }; })()]);
  r = await kd.verifyLog(logPhone([await (async () => { const e = Object.assign({}, eD, { add: { device: dev2, key: ph2.entry } }); const He = await kd.eventHash(e); return { event: e, sigs: { authority: [await phoneSign(ph.entry.id, ph.pair, 'add-device', He)] } }; })()]));
  ok('a key smuggled into an add-device event is ignored, never added', r.ok === true && r.state.authority.keys.length === 1, JSON.stringify(r));
  const eD2 = await kd.addDeviceEvent(eD, dev2); const HD2 = await kd.eventHash(eD2);
  await badD('adding the same device twice is rejected', [sD, { event: eD2, sigs: { authority: [await phoneSign(ph.entry.id, ph.pair, 'add-device', HD2)] } }], 2);
  await badD('an add-device event cannot fork the chain (it must extend the last event)', [sD, await (async () => { const e = await kd.addDeviceEvent(incP, Object.assign({}, dev2, { id: 'other' })); const He = await kd.eventHash(e); return { event: e, sigs: { authority: [await phoneSign(ph.entry.id, ph.pair, 'add-device', He)] } }; })()], 2);
  // add-device also works for a passkey identity (WebAuthn signatures, challenge = H(e))
  const eDw = await kd.addDeviceEvent(good.inception, dev2);
  r = await kd.verifyLog(logP([{ event: eDw, sigs: { authority: [Object.assign({ keyId }, await makeAssertion(authPair.privateKey, await kd.eventHash(eDw)))] } }]));
  ok('add-device with a passkey signature verifies too', r.ok === true && r.state.devices.length === 1 && r.state.authority.keys.length === 1, JSON.stringify(r));
  // the event type is part of what a raw signature covers, so an add-device signature cannot be turned into an add-authority one
  const eSwap = Object.assign({}, eD, { type: 'add-authority' });
  await badD('an add-device event cannot be relabelled as add-authority', [{ event: eSwap, sigs: sD.sigs }]);
  // a threshold of two with one passkey and one phone
  const inc3 = JSON.parse(JSON.stringify(inception)); inc3.state.authority = { threshold: 2, keys: [inception.state.authority.keys[0], ph.entry] };
  const H3 = await kd.eventHash(inc3);
  const mixed = { inception: inc3, sigs: { discovery: kd.b64u(await subtle.sign({ name: 'Ed25519' }, disc.privateKey, H3)), authority: [Object.assign({ keyId }, await makeAssertion(authPair.privateKey, H3)), await phoneSign(ph.entry.id, ph.pair, 'inception', H3)] } };
  ok('an identity that needs a passkey AND a phone verifies with both', (await kd.verifyInception(mixed)).ok === true);
  const onlyOne = JSON.parse(JSON.stringify(mixed)); onlyOne.sigs.authority.pop();
  ok('and not with the passkey alone', (await kd.verifyInception(onlyOne)).ok === false);

  // ---- removal: remove-authority and remove-device (D-1). Everything below is built from the pieces above, so a removal is held to the
  // same signing rules as an addition: a threshold of EXISTING keys, none of them the key being removed.
  const A = as(keyId, authPair), B = as(k2.entry.id, k2.pair), C = as(k3.entry.id, k3.pair);
  const sign = (e, signers) => signEvent(e, signers, null);
  const check = async (name, log, expectOk, at, errRe) => {
    const x = await kd.verifyLog(log);
    ok(name, expectOk ? x.ok === true : (x.ok === false && (at === undefined || x.failedAt === at) && (!errRe || errRe.test(x.error))), JSON.stringify(x));
    return x;
  };
  const devX = { id: 'device-x', jwk: k3.entry.jwk, addedAt: new Date().toISOString() };

  // one key removes another; e1 added key B and the device dev2 together
  const eRmB = await kd.removeAuthorityEvent(e1, k2.entry.id);
  const sRmB = await sign(eRmB, [A]);
  ok('a remove-authority event is typed, numbered and chained, and names only the key', eRmB.type === 'remove-authority' && eRmB.seq === 2 && eRmB.prev === kd.b64u(await kd.eventHash(e1)) && eRmB.remove.keyId === k2.entry.id && !('deviceId' in eRmB.remove) && eRmB.add === undefined);
  r = await kd.verifyLog(logOf([s1, sRmB]), did);
  ok('the key that stays removes the other: one key left, the DID unchanged', r.ok === true && r.did === did && r.seq === 2 && r.state.authority.keys.length === 1 && r.state.authority.keys[0].id === keyId, JSON.stringify(r));
  ok('the removed key is on the revoked list; its device is not touched, because the event did not name it (and not listed twice)', r.ok && r.state.revoked.length === 1 && r.state.revoked[0] === k2.entry.id && r.state.devices.length === 1 && r.state.devices[0].id === dev2.id && r.state.revokedDevices.length === 0, JSON.stringify(r.state));
  r = await kd.verifyLog(logOf([s1]));
  ok('a log with no removal has an empty revoked list and no removed devices', r.ok && r.state.revoked.length === 0 && r.state.revokedDevices.length === 0);
  const rmLog = logOf([s1, sRmB]), rmBefore = JSON.stringify(rmLog);
  await kd.verifyLog(rmLog);
  ok('verifying a log with a removal does not change the log it was given', JSON.stringify(rmLog) === rmBefore);

  await check('a key cannot be removed on its own say-so (the removed key is the only signer)', logOf([s1, await sign(eRmB, [B])]), false, 2, /only 0 of 1/);
  await check('the first key cannot be removed by itself either (A signs the removal of A: nobody else signed)', logOf([s1, await sign(await kd.removeAuthorityEvent(e1, keyId), [A])]), false, 2, /only 0 of 1/);
  await check('a removed key\'s signature beside a good one is ignored, not an error', logOf([s1, await sign(eRmB, [A, B])]), true);
  await check('a removal with no signature at all is rejected', logOf([s1, await sign(eRmB, [])]), false, 2);
  await check('a removal signed by a stranger is rejected', logOf([s1, await sign(eRmB, [as(keyId, stranger)])]), false, 2);

  // the other direction: the key the identity began with is removed by the key that was added
  const eRmA = await kd.removeAuthorityEvent(e1, keyId);
  const sRmA = await sign(eRmA, [B]);
  r = await kd.verifyLog(logOf([s1, sRmA]), did);
  ok('the first key can be removed by a key added later; the DID still does not change', r.ok === true && r.state.authority.keys.length === 1 && r.state.authority.keys[0].id === k2.entry.id && r.state.revoked[0] === keyId && r.did === did, JSON.stringify(r));

  // a removed key's later signatures count for nothing
  const eAfterB = await kd.addDeviceEvent(eRmB, devX), eAfterA = await kd.addDeviceEvent(eRmA, devX);
  await check('an event after the removal, signed by the key that stayed, verifies', logOf([s1, sRmB, await sign(eAfterB, [A])]), true);
  await check('an event after the removal, signed only by the removed key, is rejected', logOf([s1, sRmB, await sign(eAfterB, [B])]), false, 3, /only 0 of 1/);
  await check('the same holds when the removed key is the first one (signed by it: rejected)', logOf([s1, sRmA, await sign(eAfterA, [A])]), false, 3, /only 0 of 1/);
  await check('and the key that stayed still signs (B after A was removed)', logOf([s1, sRmA, await sign(eAfterA, [B])]), true);

  // the last key, and a threshold that must stay reachable
  await check('the last authority key cannot be removed (the identity would not be able to sign again)', logOf([await sign(await kd.removeAuthorityEvent(good.inception, keyId), [A])]), false, 1, /last authority key/);
  const eRmKb = await kd.removeAuthorityEvent(inc2, kb.entry.id);
  await check('with two keys needed, removing one is refused before any signature is looked at', { inception: base2.inception, sigs: base2.sigs, events: [await sign(eRmKb, [as(keyId, authPair), as(kb.entry.id, kb.pair)])] }, false, 1, /would leave 1 authority keys, and 2 are needed/);
  const log2 = (events) => ({ inception: base2.inception, sigs: base2.sigs, events: [both].concat(events) });
  const eRmKc = await kd.removeAuthorityEvent(ec, kc.entry.id);
  await check('with three keys and two needed, removing one needs the other two', log2([await sign(eRmKc, [as(keyId, authPair), as(kb.entry.id, kb.pair)])]), true);
  await check('the key being removed does not make up the two (A and the removed key: one counts)', log2([await sign(eRmKc, [as(keyId, authPair), as(kc.entry.id, kc.pair)])]), false, 2, /only 1 of 2/);
  await check('one key signing twice does not make up the two for a removal either', log2([await sign(eRmKc, [as(keyId, authPair), as(keyId, authPair)])]), false, 2, /only 1 of 2/);
  r = await kd.verifyLog(log2([await sign(await kd.removeAuthorityEvent(ec, keyId), [as(kb.entry.id, kb.pair), as(kc.entry.id, kc.pair)])]));
  ok('the key the identity began with can be removed by the other two', r.ok === true && r.state.authority.keys.length === 2 && r.state.authority.threshold === 2, JSON.stringify(r));

  // a removed key never comes back, by id or by its public key under a new id
  const eReB = await kd.addAuthorityEvent(eRmB, k2.entry), eReBnew = await kd.addAuthorityEvent(eRmB, Object.assign({}, k2.entry, { id: 'a-new-id-for-the-same-key' })), eAddC = await kd.addAuthorityEvent(eRmB, k3.entry);
  await check('a removed key cannot be added again under its own id', logOf([s1, sRmB, await signEvent(eReB, [A], B)]), false, 3, /already has or revoked/);
  await check('nor under a new id with the same public key', logOf([s1, sRmB, await signEvent(eReBnew, [A], as('a-new-id-for-the-same-key', k2.pair))]), false, 3, /removed/);
  await check('(control) a different key is added after a removal without trouble', logOf([s1, sRmB, await signEvent(eAddC, [A], C)]), true);
  const wr = async (revoked) => { const e = JSON.parse(JSON.stringify(inception)); e.state.revoked = revoked; const He = await kd.eventHash(e);
    return { inception: e, sigs: { discovery: kd.b64u(await subtle.sign({ name: 'Ed25519' }, disc.privateKey, He)), authority: [Object.assign({ keyId }, await makeAssertion(authPair.privateKey, He))] } }; };
  const prerevoked = await wr([k2.entry.id]);
  await check('a key id the inception already lists as revoked cannot be added', { inception: prerevoked.inception, sigs: prerevoked.sigs, events: [await signEvent(await kd.addAuthorityEvent(prerevoked.inception, k2.entry), [A], B)] }, false, 1, /already has or revoked/);
  await check('(control) the same addition on an inception that revokes nothing verifies', logOf([s1]), true);
  ok('a revoked list that is not a list of ids is rejected at the inception', (await kd.verifyInception(await wr('x'))).ok === false && (await kd.verifyInception(await wr([1]))).ok === false && (await kd.verifyInception(await wr({}))).ok === false);
  ok('a revoked list of ids, or none at all, is accepted', (await kd.verifyInception(prerevoked)).ok === true && (await kd.verifyInception(await wr(undefined))).ok === true);

  // a key and its device together, in one event
  const eRmBD = await kd.removeAuthorityEvent(e1, k2.entry.id, dev2.id);
  r = await kd.verifyLog(logOf([s1, await sign(eRmBD, [A])]));
  ok('removing a key with its device in one event takes out both, and both are on the removed lists', r.ok === true && r.state.authority.keys.length === 1 && r.state.devices.length === 0 && r.state.revoked[0] === k2.entry.id && r.state.revokedDevices.length === 1 && r.state.revokedDevices[0].id === dev2.id && r.state.revokedDevices[0].jwk.x === dev2.jwk.x, JSON.stringify(r));
  await check('a device named by a key removal must be listed', logOf([s1, await sign(await kd.removeAuthorityEvent(e1, k2.entry.id, 'nobody'), [A])]), false, 2, /does not list exactly once/);

  // a device on its own
  const sDw = await sign(await kd.addDeviceEvent(good.inception, dev2), [A]);
  const eRmDev = await kd.removeDeviceEvent(sDw.event, dev2.id), sRmDev = await sign(eRmDev, [A]);
  ok('a remove-device event is typed, numbered, chained and names only the device', eRmDev.type === 'remove-device' && eRmDev.seq === 2 && eRmDev.prev === kd.b64u(await kd.eventHash(sDw.event)) && eRmDev.remove.deviceId === dev2.id && Object.keys(eRmDev.remove).length === 1);
  r = await kd.verifyLog(logOf([sDw, sRmDev]), did);
  ok('a device is removed: no devices left, the key untouched, the device on the removed list with its public key', r.ok === true && r.state.devices.length === 0 && r.state.authority.keys.length === 1 && r.state.revoked.length === 0 && r.state.revokedDevices.length === 1 && r.state.revokedDevices[0].jwk.x === dev2.jwk.x && r.seq === 2, JSON.stringify(r));
  await check('a device removal needs the threshold of keys too (no signature: rejected)', logOf([sDw, await sign(eRmDev, [])]), false, 2);
  await check('a device removal signed by a stranger is rejected', logOf([sDw, await sign(eRmDev, [as(keyId, stranger)])]), false, 2);
  r = await kd.verifyLog(logOf([s1, sRmB, await sign(await kd.addDeviceEvent(eRmB, devX), [A])]));
  ok('devices added before and after a removal each appear once (a stale device must not be added again)', r.ok === true && r.state.devices.length === 2 && r.state.devices[0].id === dev2.id && r.state.devices[1].id === 'device-x', JSON.stringify(r.state.devices));
  const wdLog = await withDevices([devEntry]);
  r = await kd.verifyLog({ inception: wdLog.inception, sigs: wdLog.sigs, events: [await sign(await kd.removeDeviceEvent(wdLog.inception, devEntry.id), [A])] });
  ok('a device listed in the inception can be removed', r.ok === true && r.state.devices.length === 0 && r.state.revokedDevices.length === 1, JSON.stringify(r));
  const dupLog = await withDevices([devEntry, devEntry]);
  await check('a device id the inception lists twice cannot be removed (it is not clear which)', { inception: dupLog.inception, sigs: dupLog.sigs, events: [await sign(await kd.removeDeviceEvent(dupLog.inception, devEntry.id), [A])] }, false, 1, /does not list exactly once/);

  // a removed device never comes back, by id or by its public key under a new id, even inside an add-authority event
  const eReDev = await kd.addDeviceEvent(eRmDev, dev2), eReDevNew = await kd.addDeviceEvent(eRmDev, Object.assign({}, dev2, { id: 'new-id-same-device-key' })), eOther = await kd.addDeviceEvent(eRmDev, devX);
  await check('a removed device cannot be added again under its own id', logOf([sDw, sRmDev, await sign(eReDev, [A])]), false, 3, /removed/);
  await check('nor under a new id with the same public key', logOf([sDw, sRmDev, await sign(eReDevNew, [A])]), false, 3, /removed/);
  await check('nor inside an add-authority event', logOf([sDw, sRmDev, await signEvent(await kd.addAuthorityEvent(eRmDev, k3.entry, dev2), [A], C)]), false, 3, /removed/);
  await check('(control) another device is added after a removal without trouble', logOf([sDw, sRmDev, await sign(eOther, [A])]), true);

  // removing what is not there, or the wrong kind of thing
  await check('removing a key the identity does not have is rejected', logOf([s1, await sign(await kd.removeAuthorityEvent(e1, 'nobody'), [A])]), false, 2, /does not list exactly once/);
  await check('removing a device the identity does not have is rejected', logOf([s1, await sign(await kd.removeDeviceEvent(e1, 'nobody'), [A])]), false, 2, /does not list exactly once/);
  await check('a key id given as a device id removes nothing (the two lists are not mixed up)', logOf([s1, await sign(await kd.removeDeviceEvent(e1, k2.entry.id), [A])]), false, 2, /does not list exactly once/);
  await check('removing the same key twice is rejected the second time', logOf([s1, sRmB, await sign(await kd.removeAuthorityEvent(eRmB, k2.entry.id), [A])]), false, 3, /does not list exactly once/);
  await check('removing the same device twice is rejected the second time', logOf([sDw, sRmDev, await sign(await kd.removeDeviceEvent(eRmDev, dev2.id), [A])]), false, 3, /does not list exactly once/);

  // what an event must look like
  const resign = async (e, signers) => sign(e, signers || [A]);
  await check('a removal with no `remove` member is rejected', logOf([s1, await resign(Object.assign({}, eRmB, { remove: undefined }))]), false, 2, /does not say what it removes/);
  await check('a `remove` member that is a list is rejected', logOf([s1, await resign(Object.assign({}, eRmB, { remove: [k2.entry.id] }))]), false, 2, /does not say what it removes/);
  await check('a `remove` member that is a string is rejected', logOf([s1, await resign(Object.assign({}, eRmB, { remove: k2.entry.id }))]), false, 2, /does not say what it removes/);
  await check('a remove-authority event with an extra member is rejected', logOf([s1, await resign(Object.assign({}, eRmB, { remove: { keyId: k2.entry.id, note: 'x' } }))]), false, 2, /does not say what it removes/);
  await check('a remove-device event that also names a key is rejected (what was signed must be what happens)', logOf([sDw, await resign(Object.assign({}, eRmDev, { remove: { deviceId: dev2.id, keyId: keyId } }))]), false, 2, /does not say what it removes/);
  await check('a removal that also carries an `add` member is rejected', logOf([s1, await resign(Object.assign({}, eRmB, { add: { device: devX } }))]), false, 2, /removes and adds/);
  await check('a remove-authority event with no key id is rejected', logOf([s1, await resign(Object.assign({}, eRmB, { remove: {} }))]), false, 2, /does not list exactly once/);
  await check('a key id that is not a string is rejected', logOf([s1, await resign(Object.assign({}, eRmB, { remove: { keyId: 7 } }))]), false, 2, /does not list exactly once/);

  // the chain, and what was signed
  await check('a removal with a wrong seq is rejected', logOf([s1, await resign(Object.assign({}, eRmB, { seq: 3 }))]), false, 2, /seq/);
  await check('a removal with a wrong prev is rejected', logOf([s1, await resign(Object.assign({}, eRmB, { prev: kd.b64u(crypto.getRandomValues(new Uint8Array(32))) }))]), false, 2, /prev/);
  await check('changing the removal after signing is rejected (B signed for, the event now removes A)', logOf([s1, tamper(sRmB, (c) => { c.event.remove.keyId = keyId; })]), false, 2);
  await check('swapping the removed device after signing is rejected', logOf([sDw, tamper(sRmDev, (c) => { c.event.remove.deviceId = 'device-x'; })]), false, 2);
  await check('a remove-authority event cannot be relabelled as remove-device', logOf([sDw, { event: Object.assign({}, eRmDev, { type: 'remove-authority' }), sigs: sRmDev.sigs }]), false, 2);
  await check('a second event built on the same previous event (a fork) is rejected', logOf([s1, sRmB, await sign(await kd.addDeviceEvent(e1, devX), [A])]), false, 3, /seq|prev/);
  await check('an event of a kind nobody defined is still rejected', logOf([s1, await resign(Object.assign({}, eRmB, { type: 'remove-everything' }))]), false, 2, /not a known event/);

  // a phone key signs a removal for the purpose named by the event type, and for no other
  const eRmP2 = await kd.removeAuthorityEvent(eP2, ph2.entry.id), eRmP1 = await kd.removeAuthorityEvent(eP2, ph.entry.id);
  const phoneRm = async (e, signerKey, signerPair, purpose) => ({ event: e, sigs: { authority: [await phoneSign(signerKey, signerPair, purpose, await kd.eventHash(e))] } });
  r = await kd.verifyLog(logPhone([sP2, await phoneRm(eRmP2, ph.entry.id, ph.pair, 'remove-authority')]));
  ok('a phone removes a second phone with a raw signature for the remove-authority purpose', r.ok === true && r.state.authority.keys.length === 1 && r.state.authority.keys[0].id === ph.entry.id && r.state.revoked[0] === ph2.entry.id, JSON.stringify(r));
  for (const wrong of ['remove-device', 'add-authority', 'add-device', 'session', 'inception']) {
    r = await kd.verifyLog(logPhone([sP2, await phoneRm(eRmP2, ph.entry.id, ph.pair, wrong)]));
    ok('a phone signature made for the ' + wrong + ' purpose does not remove a key', r.ok === false && r.failedAt === 2, JSON.stringify(r));
  }
  r = await kd.verifyLog(logPhone([sP2, await phoneRm(eRmP2, ph2.entry.id, ph2.pair, 'remove-authority')]));
  ok('the second phone cannot sign its own removal, with the right purpose', r.ok === false && r.failedAt === 2 && /only 0 of 1/.test(r.error), JSON.stringify(r));
  const sRmP1 = await phoneRm(eRmP1, ph2.entry.id, ph2.pair, 'remove-authority');
  r = await kd.verifyLog(logPhone([sP2, sRmP1]));
  ok('and the second phone can remove the first (the key the identity began with)', r.ok === true && r.state.authority.keys.length === 1 && r.state.authority.keys[0].id === ph2.entry.id, JSON.stringify(r));
  r = await kd.verifyLog(logPhone([sP2, sRmP1, await phoneRm(await kd.addDeviceEvent(eRmP1, devX), ph.entry.id, ph.pair, 'add-device')]));
  ok('a phone that was removed can no longer sign an add-device event', r.ok === false && r.failedAt === 3, JSON.stringify(r));
  const eRmPD = await kd.removeDeviceEvent(eD, dev2.id);
  r = await kd.verifyLog(logPhone([sD, await phoneRm(eRmPD, ph.entry.id, ph.pair, 'remove-device')]));
  ok('a phone removes a computer\'s device key with the remove-device purpose', r.ok === true && r.state.devices.length === 0 && r.state.revokedDevices.length === 1 && r.state.authority.keys.length === 1, JSON.stringify(r));
  r = await kd.verifyLog(logPhone([sD, await phoneRm(eRmPD, ph.entry.id, ph.pair, 'add-device')]));
  ok('an add-device signature cannot be replayed to remove the same device', r.ok === false && r.failedAt === 2, JSON.stringify(r));
  r = await kd.verifyLog(logPhone([sD, await phoneRm(eRmPD, ph.entry.id, ph.pair, 'remove-authority')]));
  ok('a remove-authority signature cannot be replayed to remove a device', r.ok === false && r.failedAt === 2, JSON.stringify(r));
  r = await kd.verifyLog(logPhone([sD, { event: eRmPD, sigs: { authority: [Object.assign({ keyId: ph.entry.id }, await makeAssertion(ph.pair.privateKey, await kd.eventHash(eRmPD)))] } }]));
  ok('a WebAuthn assertion cannot stand in for a phone key on a removal either', r.ok === false && r.failedAt === 2, JSON.stringify(r));

  // listedKeys: the unchecked list for display, which must follow removals and must not trip over an event that adds no key
  ok('listedKeys follows additions and removals, and does not trip over a device event', (() => {
    const ids = (l) => kd.listedKeys(l).map((x) => x.id).join();
    return ids(logOf([])) === keyId && ids(logOf([s1])) === keyId + ',' + k2.entry.id && ids(logOf([s1, sRmB])) === keyId && ids(logOf([s1, sRmA])) === k2.entry.id
      && ids(logOf([sDw, sRmDev])) === keyId && ids(logOf([sDw])) === keyId;
  })());
  ok('listedKeys of nothing is an empty list, not a crash', kd.listedKeys(null).length === 0 && kd.listedKeys({}).length === 0 && kd.listedKeys({ inception: good.inception, events: [null, {}, { event: null }] }).length === 1);

  // compareLogs: how a shown log relates to the one kept for the same identity (the one rule behind "pin the longest log")
  const cmp = (kept, shown) => kd.compareLogs(kept, shown);
  ok('compareLogs: nothing kept is "new"', cmp(null, logOf([])).status === 'new' && cmp(undefined, logOf([s1])).status === 'new');
  ok('compareLogs: the same events are "same", whoever signed them', cmp(logOf([s1]), logOf([s1])).status === 'same' && cmp(logOf([s1]), { inception: good.inception, events: [{ event: s1.event, sigs: { authority: [] } }] }).status === 'same');
  ok('compareLogs: a log that holds the kept events and more is "extended"', cmp(logOf([]), logOf([s1])).status === 'extended' && cmp(logOf([s1]), logOf([s1, sRmB])).status === 'extended');
  ok('compareLogs: a log that is a prefix of the kept one is "shorter", also when the longer one is a removal', cmp(logOf([s1, sRmB]), logOf([s1])).status === 'shorter' && cmp(logOf([s1]), logOf([])).status === 'shorter');
  const f1 = cmp(logOf([s1]), logOf([sDw])), f2 = cmp(logOf([s1, sRmB]), logOf([s1, sRmA]));
  ok('compareLogs: two logs that disagree about an event both hold are a "fork" at that place, however long each is', f1.status === 'fork' && f1.at === 1 && f2.status === 'fork' && f2.at === 2 && cmp(logOf([s1]), logOf([sDw, sRmDev])).status === 'fork');
  ok('compareLogs: a fork is a fork even when the shown log is shorter than the kept one', cmp(logOf([s1, sRmB]), logOf([sDw])).status === 'fork');
  ok('compareLogs: a shown log with no events is the inception alone', cmp(logOf([]), {}).status === 'same' && cmp(logOf([]), null).status === 'same' && cmp(logOf([s1]), {}).status === 'shorter');

  console.log(passed + ' checks passed' + (process.exitCode ? ', SOME FAILED' : ''));
})().catch((e) => { console.error(e); process.exit(1); });
