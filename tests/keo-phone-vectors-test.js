// Checks tests/vectors/phone-signatures.json against shell/keo-did.js: no browser. A phone app does the same checks in its own language.
// Usage: node tests/keo-phone-vectors-test.js
const path = require('path');
const fs = require('fs');
const kd = require(path.join(__dirname, '..', 'shell', 'keo-did.js'));
const v = JSON.parse(fs.readFileSync(path.join(__dirname, 'vectors', 'phone-signatures.json'), 'utf8'));
let passed = 0;
const ok = (name, cond, extra) => { if (!cond) { console.error('FAIL ' + name + (extra ? ' ' + extra : '')); process.exitCode = 1; } else { passed++; console.log('ok   ' + name); } };
const hex = (u) => Buffer.from(u).toString('hex');

(async () => {
  ok('the key is a public phone key', kd.isPublicEcJwk(v.key.jwk) && v.key.kind === 'phone');
  for (const c of v.cases) {
    const H = await kd.eventHash(c.subject);
    ok(c.name + ': the canonical form is what the hash is taken over', kd.canonicalJson(c.subject) === c.canonical);
    ok(c.name + ': the hash follows from it', hex(H) === c.hashHex && kd.b64u(H) === c.hash);
    ok(c.name + ': the signed message is label, zero, purpose, zero, hash', hex(kd.rawMessage(c.purpose, H)) === c.messageHex);
    ok(c.name + ': the signature verifies', await kd.verifySignature({ scheme: 'p256-raw', signature: c.signature }, v.key, kd.unb64u(c.hash), c.purpose) === true);
    ok(c.name + ': the DER form converts to the same r||s', hex(kd.derToRaw(kd.unb64u(c.signatureDer))) === hex(kd.unb64u(c.signature)));
    ok(c.name + ': the signature is exactly 64 bytes', kd.unb64u(c.signature).length === 64);
  }
  for (const w of v.wrong) {
    ok('refused: ' + w.name, await kd.verifySignature({ scheme: 'p256-raw', signature: w.signature }, v.key, kd.unb64u(w.hash), w.purpose) === false);
  }
  console.log(passed + ' checks passed' + (process.exitCode ? ', SOME FAILED' : ''));
})().catch((e) => { console.error(e); process.exit(1); });
