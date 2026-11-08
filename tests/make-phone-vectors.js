// Writes tests/vectors/phone-signatures.json: fixed inputs and signatures that a phone app (any language) checks itself against.
// Run only to REPLACE the vectors (a new key and new signatures every time; ECDSA is randomised): a phone app's own copy of the
// file must then be replaced too. The private key exists only in this process and is never written anywhere.
// Usage: node tests/make-phone-vectors.js
const fs = require('fs');
const path = require('path');
const kd = require(path.join(__dirname, '..', 'shell', 'keo-did.js'));
const subtle = globalThis.crypto.subtle;
const enc = new TextEncoder();
const hex = (u) => Buffer.from(u).toString('hex');

function rawToDer(raw) {
  const int = (b) => { let i = 0; while (i < b.length - 1 && b[i] === 0) i++; b = b.slice(i); if (b[0] & 0x80) b = Buffer.concat([Buffer.from([0]), b]); return Buffer.concat([Buffer.from([0x02, b.length]), b]); };
  const body = Buffer.concat([int(Buffer.from(raw.slice(0, 32))), int(Buffer.from(raw.slice(32)))]);
  return Buffer.concat([Buffer.from([0x30, body.length]), body]);
}
const plain = (j) => ({ kty: j.kty, crv: j.crv, x: j.x, y: j.y });

(async () => {
  const pair = await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const jwk = plain(await subtle.exportKey('jwk', pair.publicKey));
  const key = { id: 'dmVjdG9yLXBob25lLWtleQ', jwk, kind: 'phone' };
  const second = plain(await subtle.exportKey('jwk', (await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])).publicKey));
  const device = plain(await subtle.exportKey('jwk', (await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])).publicKey));
  const T = '2026-01-01T00:00:00.000Z';
  const discKey = kd.z32encode(new Uint8Array(32).map((_, i) => i + 1));

  const inception = { v: 1, type: 'inception', seq: 0, prev: null, time: T, state: {
    authority: { threshold: 1, keys: [{ id: key.id, jwk, kind: 'phone', addedAt: T }] }, next: null,
    recovery: { guardians: [], threshold: 2, delayDays: 3 }, discovery: { key: discKey, version: 1 }, services: [], claims: { handles: [] }, revoked: [] } };
  const devEntry = { id: 'dGVzdC1kZXZpY2U', jwk: device, addedAt: T };
  const addDevice = await kd.addDeviceEvent(inception, devEntry, T);
  const addAuthority = await kd.addAuthorityEvent(inception, { id: 'c2Vjb25kLXBob25l', jwk: second, kind: 'phone', addedAt: T }, undefined, T);
  const did = kd.didFor(discKey, kd.b64u(await kd.eventHash(inception)));
  const cert = { v: 1, did, devicePubKeyJwk: device, issuedAt: T, exp: '2026-01-01T12:00:00.000Z', aud: 'chrome-extension://example', scope: ['world:read', 'world:write', 'sign'], authorityKeyId: key.id };

  const sign = async (purpose, H) => new Uint8Array(await subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, pair.privateKey, kd.rawMessage(purpose, H)));
  const mk = async (name, purpose, subject) => {
    const H = await kd.eventHash(subject), sig = await sign(purpose, H);
    return { name, purpose, subject, canonical: kd.canonicalJson(subject), hash: kd.b64u(H), hashHex: hex(H), messageHex: hex(kd.rawMessage(purpose, H)),
      signature: kd.b64u(sig), signatureDer: kd.b64u(rawToDer(sig)), expect: true };
  };
  const cases = [
    await mk('inception signed by the phone', 'inception', inception),
    await mk('add-authority signed by the existing phone', 'add-authority', addAuthority),
    await mk('add-device signed by the phone', 'add-device', addDevice),
    await mk('session certificate signed by the phone', 'session', cert)
  ];
  // "hash" of the event or certificate: the bare cert is hashed exactly as events are (canonical JSON, SHA-256, "sigs" left out)
  const wrong = [
    { name: 'a signature for the inception presented as a session signature', purpose: 'session', hash: cases[0].hash, signature: cases[0].signature, expect: false },
    { name: 'a signature for the session presented as an add-device signature', purpose: 'add-device', hash: cases[3].hash, signature: cases[3].signature, expect: false },
    { name: 'a signature over another hash', purpose: 'inception', hash: cases[1].hash, signature: cases[0].signature, expect: false },
    { name: 'the DER form of a valid signature (only 64-byte r||s is accepted)', purpose: 'inception', hash: cases[0].hash, signature: cases[0].signatureDer, expect: false },
    { name: 'a purpose that is not one of the four', purpose: 'inception ', hash: cases[0].hash, signature: cases[0].signature, expect: false }
  ];
  const out = {
    about: 'Test vectors for the phone signature scheme p256-raw (see rawMessage in shell/keo-did.js). A phone app must (1) rebuild messageHex from purpose and hashHex, (2) verify signature over it with key.jwk (ECDSA P-256, SHA-256, signature = r||s, 64 bytes), (3) turn signatureDer into the same r||s, and (4) refuse every entry in "wrong". It must also sign each message itself and have shell/keo-did.js accept it (tests/keo-phone-vectors-test.js shows how). The hash is SHA-256 of "canonical", which is the subject with its signature members ("sigs" on an event, "assertion" on a certificate) left out; the subjects here carry none, so canonical is the whole subject.',
    message: 'utf8("keo/authority/v1") || 0x00 || utf8(purpose) || 0x00 || hash (32 bytes)',
    key, cases, wrong
  };
  fs.mkdirSync(path.join(__dirname, 'vectors'), { recursive: true });
  fs.writeFileSync(path.join(__dirname, 'vectors', 'phone-signatures.json'), JSON.stringify(out, null, 2) + '\n');
  console.log('wrote tests/vectors/phone-signatures.json: ' + cases.length + ' cases, ' + wrong.length + ' refusals');
})().catch((e) => { console.error(e); process.exit(1); });
