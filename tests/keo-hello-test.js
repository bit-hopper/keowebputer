// Node test for keo-hello.js (the connection code and the peer proof): no browser, no authenticator.
// A passkey is imitated by an ES256 key that signs authenticatorData || SHA-256(clientDataJSON), as in keo-did-test.js.
// Usage: node keo-hello-test.js
const path = require('path');
const kd = require(path.join(__dirname, '..', 'shell', 'keo-did.js'));
const hello = require(path.join(__dirname, '..', 'shell', 'keo-hello.js'));
const subtle = globalThis.crypto.subtle;
const enc = new TextEncoder();
let passed = 0;
const ok = (name, cond, extra) => { if (!cond) { console.error('FAIL ' + name + (extra ? ' ' + JSON.stringify(extra) : '')); process.exitCode = 1; } else { passed++; console.log('ok   ' + name); } };
const throwsWith = async (fn, re) => { try { await fn(); return false; } catch (e) { return re.test(e.message); } };

// ================================================================ the code
// A description as the browser makes it: a real one from a run, plus the kinds of candidate that must not be put in a code.
const SDP = [
  'v=0', 'o=- 2277445988474023993 2 IN IP4 127.0.0.1', 's=-', 't=0 0', 'a=group:BUNDLE 0', 'a=extmap-allow-mixed', 'a=msid-semantic: WMS',
  'm=application 55145 UDP/DTLS/SCTP webrtc-datachannel', 'c=IN IP4 192.168.56.1',
  'a=candidate:2308092635 1 udp 2122260223 192.168.56.1 55145 typ host generation 0 network-id 2',
  'a=candidate:3389966045 1 udp 2122194687 172.23.48.1 55146 typ host generation 0 network-id 3',
  'a=candidate:1381020447 1 udp 2122129151 10.0.0.162 55147 typ host generation 0 network-id 1 network-cost 10',
  'a=candidate:1 1 tcp 1518280447 10.0.0.162 9 typ host tcptype active generation 0',
  'a=candidate:2 1 udp 2122 fe80::1ff:fe23:4567:890a 55148 typ host generation 0',
  'a=candidate:3 1 udp 2121 2001:db8::7 55149 typ host generation 0',
  'a=candidate:4 1 udp 2120 abcd1234-aaaa-bbbb-cccc-0123456789ab.local 55150 typ host generation 0',
  'a=candidate:5 1 udp 2119 127.0.0.1 55151 typ host generation 0',
  'a=candidate:6 1 udp 1677 203.0.113.9 40000 typ srflx raddr 10.0.0.162 rport 55147 generation 0',
  'a=ice-ufrag:DHpj', 'a=ice-pwd:CA2c0ohzHDWcDakNeuwyGOL7', 'a=ice-options:trickle',
  'a=fingerprint:sha-256 0C:DF:E7:AC:29:21:50:1D:2A:FF:BD:21:09:EE:9E:93:B3:01:40:B1:96:BF:CB:57:38:35:7C:20:EA:79:92:95',
  'a=setup:actpass', 'a=mid:0', 'a=sctp-port:5000', 'a=max-message-size:262144', ''].join('\r\n');

(async () => {
  const FPS_DIFFER = () => c.f !== ans.f;
  const c = hello.fromSdp(SDP, 'offer');
  ok('fromSdp keeps the UDP host candidates with a usable address (IPv4 and global IPv6), in order', JSON.stringify(c.c) === JSON.stringify([['192.168.56.1', 55145], ['172.23.48.1', 55146], ['10.0.0.162', 55147], ['2001:db8:0:0:0:0:0:7', 55149]]), c.c);
  ok('fromSdp drops TCP, link-local, mDNS names, loopback and server-reflexive candidates', c.c.length === 4);
  ok('fromSdp takes the credentials and the fingerprint', c.u === 'DHpj' && c.p === 'CA2c0ohzHDWcDakNeuwyGOL7' && c.f.startsWith('0C:DF:E7') && c.f.length === 95);
  ok('fromSdp says so, in words, when there is no address', await throwsWith(() => hello.fromSdp(SDP.replace(/^a=candidate.*\r\n/gm, ''), 'offer'), /no network address/));
  ok('fromSdp says so when the description lacks a fingerprint', await throwsWith(() => hello.fromSdp(SDP.replace(/^a=fingerprint.*\r\n/gm, ''), 'offer'), /could not make/));

  const text = await hello.encodeCode(c);
  ok('an invitation is a short plain text: keo2. and base64url', /^keo2\.[A-Za-z0-9_-]+$/.test(text) && text.length < 170, text.length);
  console.log('     (' + text.length + ' characters for 4 candidates, one of them IPv6)');
  const d = await hello.decodeCode(text, { role: 'offer' });
  ok('decode gives back what was encoded', JSON.stringify(d.c) === JSON.stringify(c.c) && d.u === c.u && d.p === c.p && d.f === c.f && d.role === 'offer' && d.tag === null && Math.abs(d.time - c.time) < 1000, d);
  ok('decode survives wrapping and blanks around the text', (await hello.decodeCode('  ' + text.replace(/(.{40})/g, '$1\n') + '\n')).u === 'DHpj');

  const tag = await hello.offerTag(d);
  const ans = hello.fromSdp(SDP.replace('a=ice-ufrag:DHpj', 'a=ice-ufrag:QQQQ').replace('actpass', 'active').replace('0C:DF:E7', '1C:DF:E7'), 'answer', { tag });
  const ansText = await hello.encodeCode(ans), ad = await hello.decodeCode(ansText, { role: 'answer' });
  ok('an answer carries the tag of the invitation it answers', ad.role === 'answer' && ad.tag === tag && tag.length === 8, ad.tag);
  ok('the two sides have different fingerprints in this test (the order check needs it)', FPS_DIFFER());
ok('the tag depends on the invitation\'s credentials and fingerprint', tag !== await hello.offerTag(Object.assign({}, d, { u: 'ZZZZ' })) && tag !== await hello.offerTag(Object.assign({}, d, { f: d.f.replace('0C', '0D') })) && tag === await hello.offerTag(d));

  // damage: every one of these must be refused with a sentence, not accepted
  const flip = (s, i) => s.slice(0, i) + (s[i] === 'A' ? 'B' : 'A') + s.slice(i + 1);
  ok('a code with one changed character is refused (the checksum)', await throwsWith(() => hello.decodeCode(flip(text, 30)), /damaged/));
  ok('every position of the code is covered by the checksum', await (async () => { for (let i = 5; i < text.length; i++) { try { await hello.decodeCode(flip(text, i)); return false; } catch (e) { if (!/damaged|different version|too old|future|invitation|answer/.test(e.message)) return false; } } return true; })());
  ok('a cut-off code is refused', await throwsWith(() => hello.decodeCode(text.slice(0, 60)), /damaged/));
  for (const [name, bad] of [['empty text', ''], ['null', null], ['other text', 'hello there'], ['the first version\'s prefix', 'keo1.' + text.slice(5)], ['a bad alphabet', 'keo2.@@@@@@@@@@@@@@@@'], ['far too long', 'keo2.' + 'A'.repeat(2000)]]) {
    ok('decode refuses ' + name, await throwsWith(() => hello.decodeCode(bad), /connection code/));
  }
  ok('an answer pasted where an invitation is wanted is refused with a sentence', await throwsWith(() => hello.decodeCode(ansText, { role: 'offer' }), /This is an answer/));
  ok('an invitation pasted where an answer is wanted is refused with a sentence', await throwsWith(() => hello.decodeCode(text, { role: 'answer' }), /This is an invitation/));
  ok('a code older than the allowed age is refused', await throwsWith(() => hello.decodeCode(text, { now: Date.now() + hello.MAX_AGE_MS + 5000 }), /too old/));
  ok('a code dated in the future is refused', await throwsWith(() => hello.decodeCode(text, { now: Date.now() - 10 * 60e3 }), /future/));
  // structurally bad records WITH a correct checksum, made by hand: the checksum is no defence against a code made to be bad
  const reseal = async (body) => { const sum = (await kd.sha256(body)).slice(0, 3), all = new Uint8Array(body.length + 3); all.set(body); all.set(sum, body.length); return 'keo2.' + kd.b64u(all); };
  const rawBody = kd.unb64u(text.slice(5)).slice(0, -3);
  const mutated = (fn) => { const b = Uint8Array.from(rawBody); const r = fn(b); return r || b; };
  ok('another format number is "a different version"', await throwsWith(async () => hello.decodeCode(await reseal(mutated((b) => { b[0] = 3; }))), /different version/));
  ok('bytes after the record are refused', await throwsWith(async () => hello.decodeCode(await reseal(mutated((b) => { const o = new Uint8Array(b.length + 1); o.set(b); return o; }))), /damaged/));
  ok('a record that ends early is refused', await throwsWith(async () => hello.decodeCode(await reseal(rawBody.slice(0, 30))), /damaged/));
  ok('zero candidates are refused', await throwsWith(async () => hello.decodeCode(await reseal(mutated((b) => { b[7 + 4 + 1 + 24 + 32] = 0; return b.slice(0, 7 + 4 + 1 + 24 + 32 + 1); }))), /damaged/));
  ok('a loopback address in a code is refused', await throwsWith(async () => hello.decodeCode(await reseal(mutated((b) => { const o = 7 + 4 + 1 + 24 + 32 + 1 + 1; b[o] = 127; b[o + 1] = 0; b[o + 2] = 0; b[o + 3] = 1; }))), /damaged/));
  ok('port 0 in a code is refused', await throwsWith(async () => hello.decodeCode(await reseal(mutated((b) => { const o = 7 + 4 + 1 + 24 + 32 + 1 + 1 + 4; b[o] = 0; b[o + 1] = 0; }))), /damaged/));

  // the description rebuilt from a code
  const rebuilt = hello.codeSdp(d);
  ok('codeSdp makes a data-channel description: the credentials, fingerprint, candidates and the offerer\'s DTLS role', /^v=0\r\n/.test(rebuilt) && rebuilt.includes('a=ice-ufrag:DHpj') && rebuilt.includes('a=fingerprint:sha-256 ' + c.f) && rebuilt.includes('a=setup:actpass') && /m=application 55145 UDP\/DTLS\/SCTP webrtc-datachannel/.test(rebuilt) && rebuilt.includes('2001:db8:0:0:0:0:0:7 55149'), rebuilt);
  ok('the answer\'s description is "active"', hello.codeSdp(ad).includes('a=setup:active'));
  const again = hello.fromSdp(rebuilt, 'offer');
  ok('a description rebuilt from a code gives the same code back (nothing is lost or invented)', JSON.stringify(again.c) === JSON.stringify(c.c) && again.u === c.u && again.p === c.p && again.f === c.f);
  ok('codeSdp for an IPv6-only code uses an IP6 connection line', hello.codeSdp(Object.assign({}, d, { c: [['2001:db8:0:0:0:0:0:7', 6000]] })).includes('c=IN IP6 2001:db8:0:0:0:0:0:7'));
  const v6c = hello.fromSdp(SDP.replace(/^a=candidate:.*\r\n/gm, '').replace('a=ice-ufrag', 'a=candidate:9 1 udp 5 2001:db8::1:0:0:2 7000 typ host\r\na=candidate:8 1 udp 5 2001:db8::5 7001 typ host\r\na=ice-ufrag'), 'offer');
  ok('IPv6 addresses with "::" are read, and written out in full', JSON.stringify(v6c.c) === JSON.stringify([['2001:db8:0:0:1:0:0:2', 7000], ['2001:db8:0:0:0:0:0:5', 7001]]), v6c.c);

  // ================================================================ the proof
  const AUD = 'chrome-extension://test';
  const FPS = [c.f, ans.f];
  function rawToDer(raw) {
    const int = (b) => { let i = 0; while (i < b.length - 1 && b[i] === 0) i++; b = b.slice(i); if (b[0] & 0x80) b = Buffer.concat([Buffer.from([0]), b]); return Buffer.concat([Buffer.from([0x02, b.length]), b]); };
    const body = Buffer.concat([int(Buffer.from(raw.slice(0, 32))), int(Buffer.from(raw.slice(32)))]);
    return Buffer.concat([Buffer.from([0x30, body.length]), body]);
  }
  async function assertion(privateKey, challengeBytes) {
    const authenticatorData = crypto.getRandomValues(new Uint8Array(37));
    const clientDataJSON = enc.encode(JSON.stringify({ type: 'webauthn.get', challenge: kd.b64u(challengeBytes), origin: AUD }));
    const input = Buffer.concat([Buffer.from(authenticatorData), Buffer.from(await kd.sha256(clientDataJSON))]);
    const raw = new Uint8Array(await subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, privateKey, input));
    return { authenticatorData: kd.b64u(authenticatorData), clientDataJSON: kd.b64u(clientDataJSON), signature: kd.b64u(rawToDer(raw)) };
  }
  const plain = (j) => ({ kty: j.kty, crv: j.crv, x: j.x, y: j.y });
  // An identity as keo-identity.js makes one. mode 'inception': the device is listed in the inception and the certificate is the
  // inception's own authority signature. mode 'signin': no device listed, a certificate signed by the passkey over H(cert).
  async function makeIdentity(mode, o) {
    o = o || {};
    const authPair = await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
    const authJwk = plain(await subtle.exportKey('jwk', authPair.publicKey));
    const device = await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']);
    const deviceJwk = plain(await subtle.exportKey('jwk', device.publicKey));
    const disc = await kd.ed25519FromSeed(crypto.getRandomValues(new Uint8Array(32)));
    const keyId = kd.b64u(crypto.getRandomValues(new Uint8Array(16)));
    const t0 = new Date().toISOString();
    const state = { authority: { threshold: 1, keys: [{ id: keyId, jwk: authJwk, rpId: 'testid', kind: 'platform', addedAt: t0 }] }, next: null,
      recovery: { guardians: [], threshold: 2, delayDays: 3 }, discovery: { key: disc.publicZ32, version: 1 }, services: [], claims: { handles: [] }, revoked: [] };
    if (mode === 'inception') state.devices = [{ id: kd.b64u(await kd.sha256(enc.encode(kd.canonicalJson(deviceJwk)))), jwk: deviceJwk, addedAt: t0 }];
    const inception = { v: 1, type: 'inception', seq: 0, prev: null, time: t0, state };
    const H = await kd.eventHash(inception);
    const did = kd.didFor(disc.publicZ32, kd.b64u(H));
    const authSig = Object.assign({ keyId }, await assertion(authPair.privateKey, H));
    const sigs = { discovery: kd.b64u(await subtle.sign({ name: 'Ed25519' }, disc.privateKey, H)), authority: [authSig] };
    const now = o.now || Date.now();
    let cert = { v: 1, did, devicePubKeyJwk: deviceJwk, issuedAt: new Date(now).toISOString(), exp: new Date(now + (o.ttl || 12 * 3600e3)).toISOString(), aud: o.aud || AUD, scope: o.scope || ['world:read', 'world:write', 'sign'], authorityKeyId: keyId };
    if (mode === 'inception') cert = Object.assign({ via: 'inception' }, cert, { assertion: { authenticatorData: authSig.authenticatorData, clientDataJSON: authSig.clientDataJSON, signature: authSig.signature } });
    else {
      const a = await assertion(authPair.privateKey, await kd.eventHash(cert));
      cert = Object.assign({}, cert, { assertion: { authenticatorData: a.authenticatorData, clientDataJSON: a.clientDataJSON, signature: a.signature } });
    }
    return { did, inception, sigs, cert, device };
  }
  // A proof message as it crosses the channel (JSON in, JSON out). `edit(hello)` changes the hello AFTER it is built and BEFORE it is
  // signed (a cheater signing something bad); `after(msg)` changes it after signing (tampering on the way).
  async function proofMsg(id, role, fps, o) {
    o = o || {};
    const h = hello.proofBuild(role, fps, { did: id.did, inception: id.inception, sigs: id.sigs, cert: id.cert }, { name: o.name, now: o.now });
    if (o.edit) o.edit(h);
    const sig = kd.b64u(await subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, (o.signWith || id).device.privateKey, hello.signedBytes(h)));
    const msg = JSON.parse(JSON.stringify({ hello: h, sig }));
    if (o.after) o.after(msg);
    return msg;
  }
  const verify = (msg, role, o) => hello.verifyProof(msg, Object.assign({ role, fps: FPS, audience: AUD }, o || {}));

  const A = await makeIdentity('inception'), B = await makeIdentity('signin');
  const vA = await verify(await proofMsg(A, 'offer', FPS, { name: 'Maya' }), 'offer');
  ok('a proof from a device listed in the inception verifies, with the DID and the name', vA.ok && vA.did === A.did && vA.name === 'Maya', vA);
  const vB = await verify(await proofMsg(B, 'answer', FPS), 'answer');
  ok('a proof from a device with a sign-in certificate verifies', vB.ok && vB.did === B.did && vB.name === null, vB);

  const refused = async (name, msg, role, o, pattern) => { const r = await verify(await msg, role, o); ok(name, r.ok === false && (!pattern || pattern.test(r.error)), r); };
  await refused('a proof made for another connection (other fingerprints) is refused: a relayed proof does not work', proofMsg(A, 'offer', [FPS[0], 'AA:' + FPS[1].slice(3)]), 'offer', {}, /different connection/);
  await refused('a proof with the fingerprints in the other order is refused', proofMsg(A, 'offer', [FPS[1], FPS[0]]), 'offer', {}, /different connection/);
  await refused('a proof claiming the other end of the connection is refused (an echo of our own proof)', proofMsg(A, 'offer', FPS), 'answer', {}, /wrong end/);
  await refused('something that is not a proof is refused', { hello: { v: 1, purpose: 'other' }, sig: 'x' }, 'offer', {}, /not a keo proof/);
  await refused('an empty message is refused without throwing', {}, 'offer', {}, /not a keo proof/);
  await refused('a changed name fails the signature', proofMsg(A, 'offer', FPS, { name: 'Maya', after: (m) => { m.hello.name = 'Someone else'; } }), 'offer', {}, /signature/);
  await refused('a proof signed by another identity\'s device key fails', proofMsg(A, 'offer', FPS, { signWith: B }), 'offer', {}, /signature/);
  await refused('a proof older than the allowed age is refused', proofMsg(A, 'offer', FPS), 'offer', { now: Date.now() + hello.MAX_AGE_MS + 5000 }, /too old/);
  await refused('a proof dated in the future is refused', proofMsg(A, 'offer', FPS, { now: Date.now() + 3600e3 }), 'offer', {}, /future/);
  await refused('a name longer than allowed is refused', proofMsg(A, 'offer', FPS, { edit: (h) => { h.name = 'x'.repeat(200); } }), 'offer', {}, /name/);
  await refused('an inception that was edited fails (the DID no longer follows from it)', proofMsg(A, 'offer', FPS, { edit: (h) => { h.inception = JSON.parse(JSON.stringify(h.inception)); h.inception.time = '2020-01-01T00:00:00.000Z'; } }), 'offer', {}, /identity/);
  await refused('another identity\'s proof under this DID fails', proofMsg(A, 'offer', FPS, { edit: (h) => { h.inception = B.inception; h.inceptionSigs = B.sigs; } }), 'offer', {}, /identity|vouched/);
  await refused('a certificate made for another identity is refused', proofMsg(A, 'offer', FPS, { edit: (h) => { h.cert = B.cert; } }), 'offer', {}, /not for this identity/);
  await refused('an expired delegation is refused', proofMsg(await makeIdentity('signin', { now: Date.now() - 20e3, ttl: 5e3 }), 'offer', FPS), 'offer', {}, /expired/);
  await refused('a delegation for another app is refused', proofMsg(await makeIdentity('signin', { aud: 'chrome-extension://other' }), 'offer', FPS), 'offer', {}, /another app/);
  await refused('a delegation without the signing scope is refused', proofMsg(await makeIdentity('signin', { scope: ['world:read'] }), 'offer', FPS), 'offer', {}, /signing/);
  await refused('a sign-in certificate edited after the passkey signed it is refused', proofMsg(B, 'offer', FPS, { edit: (h) => { h.cert = JSON.parse(JSON.stringify(h.cert)); h.cert.exp = new Date(Date.now() + 1000 * 3600 * 24 * 365).toISOString(); } }), 'offer', {}, /passkey signature/);
  await refused('a device key swapped into a sign-in certificate is refused', proofMsg(B, 'offer', FPS, { edit: (h) => { h.cert = JSON.parse(JSON.stringify(h.cert)); h.cert.devicePubKeyJwk = plain(A.cert.devicePubKeyJwk); } }), 'offer', {}, /passkey signature/);
  await refused('an inception-kind certificate for a device the inception does not list is refused', proofMsg(A, 'offer', FPS, { edit: (h) => { h.cert = JSON.parse(JSON.stringify(h.cert)); h.cert.devicePubKeyJwk = plain(B.cert.devicePubKeyJwk); } }), 'offer', {}, /not listed/);
  await refused('a delegation of an unknown kind is refused', proofMsg(B, 'offer', FPS, { edit: (h) => { h.cert = JSON.parse(JSON.stringify(h.cert)); h.cert.via = 'trust-me'; } }), 'offer', {}, /unknown kind/);
  await refused('a certificate naming an unknown authority key is refused', proofMsg(B, 'offer', FPS, { edit: (h) => { h.cert = JSON.parse(JSON.stringify(h.cert)); h.cert.authorityKeyId = 'nope'; } }), 'offer', {}, /authority key/);
  await refused('a proof with no identity at all is refused without throwing', proofMsg(A, 'offer', FPS, { edit: (h) => { delete h.inception; delete h.inceptionSigs; delete h.cert; } }), 'offer', {}, /identity|could not be checked/);

  console.log(passed + ' checks passed' + (process.exitCode ? ', SOME FAILED' : ''));
})().catch((e) => { console.error('FATAL', e); process.exit(2); });
