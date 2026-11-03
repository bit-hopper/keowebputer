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

  console.log(passed + ' checks passed' + (process.exitCode ? ', SOME FAILED' : ''));
})().catch((e) => { console.error(e); process.exit(1); });
