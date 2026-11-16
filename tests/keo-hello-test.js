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
  // 'A' becomes 'g' (the top bit of the six), not 'B' (the lowest): in the last character the low bits are padding that decoding
  // ignores, so a flip there is no damage at all, and the code's last character is 'A' in about a quarter of codes.
  const flip = (s, i) => s.slice(0, i) + (s[i] === 'A' ? 'g' : 'A') + s.slice(i + 1);
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
    return { did, inception, sigs, cert, device, authPair, keyId };
  }
  // The same identity after a second passkey (made on another origin) was added by an event, as keo-identity.js enroll does it:
  // returns what the NEW device holds. mode 'log': its device is listed by the event and the certificate is the event's own two
  // signatures; mode 'signin': the event lists no device and the new passkey signs a certificate for a device key of its own.
  async function addKey(id, mode, o) {
    o = o || {};
    const pair = await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
    const device = await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']);
    const deviceJwk = plain(await subtle.exportKey('jwk', device.publicKey));
    const key = { id: kd.b64u(crypto.getRandomValues(new Uint8Array(16))), jwk: plain(await subtle.exportKey('jwk', pair.publicKey)), rpId: 'keo.test', kind: 'platform', addedAt: new Date().toISOString() };
    const dev = { id: kd.b64u(await kd.sha256(enc.encode(kd.canonicalJson(deviceJwk)))), jwk: deviceJwk, addedAt: key.addedAt };
    const e = await kd.addAuthorityEvent(id.inception, key, mode === 'log' ? dev : undefined);
    const H = await kd.eventHash(e);
    const oldSig = Object.assign({ keyId: id.keyId }, await assertion(id.authPair.privateKey, H));
    const newSig = Object.assign({ keyId: key.id }, await assertion(pair.privateKey, H));
    const events = [{ event: e, sigs: { authority: [oldSig], newKey: newSig } }];
    const now = o.now || Date.now();
    let cert = { v: 1, did: id.did, devicePubKeyJwk: deviceJwk, issuedAt: new Date(now).toISOString(), exp: new Date(now + 12 * 3600e3).toISOString(), aud: AUD, scope: ['world:read', 'world:write', 'sign'], authorityKeyId: key.id };
    if (mode === 'log') cert = Object.assign({ via: 'log' }, cert, { assertion: newSig });
    else { const a = await assertion(pair.privateKey, await kd.eventHash(cert)); cert = Object.assign({}, cert, { assertion: { authenticatorData: a.authenticatorData, clientDataJSON: a.clientDataJSON, signature: a.signature } }); }
    return { did: id.did, inception: id.inception, sigs: id.sigs, events, cert, device, pair, keyId: key.id };
  }
  // A proof message as it crosses the channel (JSON in, JSON out). `edit(hello)` changes the hello AFTER it is built and BEFORE it is
  // signed (a cheater signing something bad); `after(msg)` changes it after signing (tampering on the way).
  async function proofMsg(id, role, fps, o) {
    o = o || {};
    const h = hello.proofBuild(role, fps, { did: id.did, inception: id.inception, sigs: id.sigs, events: id.events, cert: id.cert }, { name: o.name, now: o.now });
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

  // ---- a device whose passkey was added to the identity later (made on another origin)
  ok('a proof with no events has no "events" member: the shape of an identity that never added a key is unchanged', !('events' in (await proofMsg(A, 'offer', FPS)).hello));
  const A2 = await addKey(A, 'log'), A3 = await addKey(A, 'signin');
  const vA2 = await verify(await proofMsg(A2, 'offer', FPS, { name: 'Maya at the desktop' }), 'offer');
  ok('a device the log lists (added by an event both keys signed) verifies, under the same DID', vA2.ok && vA2.did === A.did, vA2);
  const vA3 = await verify(await proofMsg(A3, 'offer', FPS), 'offer');
  ok('a device on the added passkey with a sign-in certificate verifies', vA3.ok && vA3.did === A.did, vA3);
  ok('the original device still verifies once the log has grown (its proof may carry the longer log)', (await verify(await proofMsg(Object.assign({}, A, { events: A2.events }), 'offer', FPS), 'offer')).ok === true);
  await refused('the same proof WITHOUT the events is refused: the identity as first made does not know the added passkey', proofMsg(Object.assign({}, A2, { events: [] }), 'offer', FPS), 'offer', {}, /authority key/);
  await refused('a sign-in certificate by the added passkey is refused without the events', proofMsg(Object.assign({}, A3, { events: [] }), 'offer', FPS), 'offer', {}, /authority key/);
  await refused('an event edited after it was signed makes the identity fail', proofMsg(A2, 'offer', FPS, { edit: (h) => { h.events = JSON.parse(JSON.stringify(h.events)); h.events[0].event.add.key.rpId = 'evil.test'; } }), 'offer', {}, /identity does not verify/);
  await refused('an event that adds a different device than the certificate names is refused', proofMsg(A2, 'offer', FPS, { edit: (h) => { h.cert = JSON.parse(JSON.stringify(h.cert)); h.cert.devicePubKeyJwk = plain(B.cert.devicePubKeyJwk); } }), 'offer', {}, /not listed/);
  await refused('an inception-kind certificate cannot vouch for a device only a later event lists', proofMsg(A2, 'offer', FPS, { edit: (h) => { h.cert = JSON.parse(JSON.stringify(h.cert)); h.cert.via = 'inception'; } }), 'offer', {}, /not listed/);
  await refused('a log-kind certificate cannot vouch for a device nothing lists', proofMsg(A, 'offer', FPS, { edit: (h) => { h.cert = JSON.parse(JSON.stringify(h.cert)); h.cert.via = 'log'; h.cert.devicePubKeyJwk = plain(B.cert.devicePubKeyJwk); } }), 'offer', {}, /not listed/);
  await refused('events grafted onto another identity are refused', proofMsg(B, 'offer', FPS, { edit: (h) => { h.events = A2.events; } }), 'offer', {}, /identity does not verify/);

  // ---- a delegation that only the log vouches for carries no signature of its own, so its dates are the holder's say-so: it may cover
  // ---- only the session made when the device was listed (found by a probe: a one-year and a hundred-year certificate were accepted)
  const stretch = (ms, issuedMs) => (h) => { h.cert = JSON.parse(JSON.stringify(h.cert)); h.cert.exp = new Date(Date.now() + ms).toISOString(); if (issuedMs !== undefined) h.cert.issuedAt = new Date(Date.now() + issuedMs).toISOString(); };
  const DAY = 24 * 3600e3;
  await refused('an inception-kind certificate that runs for a year is refused', proofMsg(A, 'offer', FPS, { edit: stretch(365 * DAY) }), 'offer', {}, /first session has run out/);
  await refused('an inception-kind certificate that runs for a hundred years is refused', proofMsg(A, 'offer', FPS, { edit: stretch(100 * 365 * DAY) }), 'offer', {}, /first session has run out/);
  await refused('a log-kind certificate that runs for a year is refused', proofMsg(A2, 'offer', FPS, { edit: stretch(365 * DAY) }), 'offer', {}, /first session has run out/);
  await refused('a fresh 12-hour inception-kind certificate made two days later (the device key vouching for itself) is refused', proofMsg(A, 'offer', FPS, { now: Date.now() + 2 * DAY, edit: stretch(2 * DAY + 12 * 3600e3, 2 * DAY) }), 'offer', { now: Date.now() + 2 * DAY }, /first session has run out/);
  await refused('the same for a log-kind certificate', proofMsg(A2, 'offer', FPS, { now: Date.now() + 2 * DAY, edit: stretch(2 * DAY + 12 * 3600e3, 2 * DAY) }), 'offer', { now: Date.now() + 2 * DAY }, /first session has run out/);
  ok('the first session still verifies a few hours after the device was listed', (await verify(await proofMsg(A, 'offer', FPS, { now: Date.now() + 5 * 3600e3 }), 'offer', { now: Date.now() + 5 * 3600e3 })).ok === true);
  ok('a sign-in certificate (the passkey signs it) verifies two days after the identity was made', (await verify(await proofMsg(await makeIdentity('signin', { now: Date.now() + 2 * DAY }), 'offer', FPS, { now: Date.now() + 2 * DAY }), 'offer', { now: Date.now() + 2 * DAY })).ok === true);

  // ---- a device or a key the log has since removed (D-1). The removal has to reach every kind of delegation: the passkey-signed one is
  // ---- never checked against the device list, and the inception-kind one is checked against the INCEPTION's list, which a removal does
  // ---- not change. A proof that carries the log with the removal in it is refused; one that carries an older log is not (see D-2).
  const lastEvent = (id) => (id.events && id.events.length ? id.events[id.events.length - 1].event : id.inception);
  const devIdOf = async (id) => kd.b64u(await kd.sha256(enc.encode(kd.canonicalJson(plain(id.cert.devicePubKeyJwk)))));
  // `id` with `event` appended to its log, signed by `signers` ([{ keyId, pair }]) as WebAuthn assertions over H(event)
  const withEvent = async (id, event, signers) => {
    const H = await kd.eventHash(event);
    return Object.assign({}, id, { events: (id.events || []).concat([{ event, sigs: { authority: await Promise.all(signers.map(async (s) => Object.assign({ keyId: s.keyId }, await assertion(s.pair.privateKey, H)))) } }]) });
  };
  const signAs = (id) => ({ keyId: id.keyId, pair: id.authPair });
  const signinCertFor = async (id) => {
    const now = Date.now();
    const cert = { v: 1, did: id.did, devicePubKeyJwk: id.cert.devicePubKeyJwk, issuedAt: new Date(now).toISOString(), exp: new Date(now + 12 * 3600e3).toISOString(), aud: AUD, scope: ['world:read', 'world:write', 'sign'], authorityKeyId: id.keyId };
    return Object.assign({}, cert, { assertion: await assertion(id.authPair.privateKey, await kd.eventHash(cert)) });
  };
  // the same device as A, but with a certificate its passkey signed (what keo-identity.js makes at every sign-in)
  const Asign = Object.assign({}, A, { cert: await signinCertFor(A) });
  ok('(control) the passkey-signed certificate of a device the inception lists verifies before any removal', (await verify(await proofMsg(Asign, 'offer', FPS), 'offer')).ok === true);
  const Agone = await withEvent(A, await kd.removeDeviceEvent(lastEvent(A), await devIdOf(A)), [signAs(A)]);
  const AsignGone = Object.assign({}, Agone, { cert: Asign.cert });
  await refused('a device the log removed is refused: an inception-kind certificate', proofMsg(Agone, 'offer', FPS), 'offer', {}, /removed from the identity/);
  await refused('and the passkey-signed certificate of the same device, which no device list ever checked', proofMsg(AsignGone, 'offer', FPS), 'offer', {}, /removed from the identity/);
  ok('a proof that still carries the older log (before the removal) is NOT refused: only pinning the longest log seen (D-2) closes that', (await verify(await proofMsg(Asign, 'offer', FPS), 'offer')).ok === true && (await verify(await proofMsg(A, 'offer', FPS), 'offer')).ok === true);
  const A2gone = await withEvent(A2, await kd.removeDeviceEvent(lastEvent(A2), await devIdOf(A2)), [signAs(A)]);
  await refused('a device a later event listed is refused once another event removes it: a log-kind certificate', proofMsg(A2gone, 'offer', FPS), 'offer', {}, /removed from the identity/);
  await refused('a removal nobody signed makes the whole identity fail, not the device alone', proofMsg(await withEvent(A, await kd.removeDeviceEvent(lastEvent(A), await devIdOf(A)), []), 'offer', FPS), 'offer', {}, /identity does not verify/);
  const A3key = A3.events[0].event.add.key.id;
  await refused('a removed authority key takes its certificates with it: the sign-in certificate of the passkey that was removed', proofMsg(await withEvent(A3, await kd.removeAuthorityEvent(lastEvent(A3), A3key), [signAs(A)]), 'offer', FPS), 'offer', {}, /authority key/);
  const A3x = await withEvent(A3, await kd.removeAuthorityEvent(lastEvent(A3), A.keyId), [{ keyId: A3key, pair: A3.pair }]);
  await refused('the first passkey removed by the one added later: its inception-kind certificate is refused', proofMsg(Object.assign({}, A, { events: A3x.events }), 'offer', FPS), 'offer', {}, /authority key/);
  await refused('and its passkey-signed certificate', proofMsg(Object.assign({}, Asign, { events: A3x.events }), 'offer', FPS), 'offer', {}, /authority key/);
  const vA3x = await verify(await proofMsg(A3x, 'offer', FPS), 'offer');
  ok('while the passkey that stayed still verifies, under the same DID', vA3x.ok === true && vA3x.did === A.did, vA3x);
  ok('a device removed by one event does not take the identity\'s other devices with it (A2 verifies on the log that removed only A\'s own device)', (await verify(await proofMsg(Object.assign({}, A2, { events: (await withEvent(A2, await kd.removeDeviceEvent(lastEvent(A2), await devIdOf(A)), [signAs(A)])).events }), 'offer', FPS), 'offer')).ok === true);

  // ---- an identity whose only authority is a phone (raw signatures, kind 'phone'); software stands in for the phone
  const phoneSig = async (pair, purpose, h) => ({ scheme: 'p256-raw', signature: kd.b64u(new Uint8Array(await subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, pair.privateKey, Buffer.concat([Buffer.from('keo/authority/v1'), Buffer.from([0]), Buffer.from(purpose), Buffer.from([0]), Buffer.from(h)])))) });
  async function makePhoneIdentity(mode, o) {
    o = o || {};
    const pair = await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
    const device = await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']);
    const deviceJwk = plain(await subtle.exportKey('jwk', device.publicKey));
    const dev = { id: kd.b64u(await kd.sha256(enc.encode(kd.canonicalJson(deviceJwk)))), jwk: deviceJwk, addedAt: new Date().toISOString() };
    const disc = await kd.ed25519FromSeed(crypto.getRandomValues(new Uint8Array(32)));
    const keyId = kd.b64u(crypto.getRandomValues(new Uint8Array(16)));
    const t0 = new Date().toISOString();
    const state = { authority: { threshold: 1, keys: [{ id: keyId, jwk: plain(await subtle.exportKey('jwk', pair.publicKey)), kind: 'phone', addedAt: t0 }] }, next: null,
      recovery: { guardians: [], threshold: 2, delayDays: 3 }, discovery: { key: disc.publicZ32, version: 1 }, services: [], claims: { handles: [] }, revoked: [] };
    const inception = { v: 1, type: 'inception', seq: 0, prev: null, time: t0, state };
    const H = await kd.eventHash(inception), did = kd.didFor(disc.publicZ32, kd.b64u(H));
    const sigs = { discovery: kd.b64u(await subtle.sign({ name: 'Ed25519' }, disc.privateKey, H)), authority: [Object.assign({ keyId }, await phoneSig(pair, 'inception', H))] };
    let events = [];
    if (mode === 'device') { // the computer is added by the phone alone (add-device), and its certificate is that event
      const e = await kd.addDeviceEvent(inception, dev);
      events = [{ event: e, sigs: { authority: [Object.assign({ keyId }, await phoneSig(pair, 'add-device', await kd.eventHash(e)))] } }];
    }
    const now = Date.now();
    let cert = { v: 1, did, devicePubKeyJwk: deviceJwk, issuedAt: new Date(now).toISOString(), exp: new Date(now + 12 * 3600e3).toISOString(), aud: AUD, scope: ['world:read', 'world:write', 'sign'], authorityKeyId: keyId };
    if (mode === 'device') cert = Object.assign({ via: 'log' }, cert);
    else cert = Object.assign({}, cert, { assertion: await phoneSig(pair, o.purpose || 'session', await kd.eventHash(cert)) });
    return { did, inception, sigs, events, cert, device, pair, keyId };
  }
  const P1 = await makePhoneIdentity('signin'), P2 = await makePhoneIdentity('device');
  const vP1 = await verify(await proofMsg(P1, 'offer', FPS, { name: 'Maya' }), 'offer');
  ok('a phone-only identity: a sign-in certificate signed by the phone verifies', vP1.ok && vP1.did === P1.did && vP1.name === 'Maya', vP1);
  const vP2 = await verify(await proofMsg(P2, 'answer', FPS), 'answer');
  ok('a phone-only identity: a computer the phone added with add-device verifies', vP2.ok && vP2.did === P2.did, vP2);
  await refused('a phone sign-in certificate signed for another purpose is refused', proofMsg(await makePhoneIdentity('signin', { purpose: 'add-device' }), 'offer', FPS), 'offer', {}, /passkey signature/);
  await refused('a phone sign-in certificate edited after signing is refused', proofMsg(P1, 'offer', FPS, { edit: (h) => { h.cert = JSON.parse(JSON.stringify(h.cert)); h.cert.exp = new Date(Date.now() + 1000 * 3600 * 24 * 365).toISOString(); } }), 'offer', {}, /passkey signature/);
  await refused('the add-device computer is refused when the proof leaves the event out', proofMsg(Object.assign({}, P2, { events: [] }), 'offer', FPS), 'offer', {}, /not listed/);
  await refused('a WebAuthn-shaped certificate signature is refused for a phone key', proofMsg(P1, 'offer', FPS, { edit: (h) => { h.cert = JSON.parse(JSON.stringify(h.cert)); h.cert.assertion = { authenticatorData: 'AAAA', clientDataJSON: 'AAAA', signature: h.cert.assertion.signature }; } }), 'offer', {}, /passkey signature/);

  // ================================================================ the dial request (on the local network, keo-lan.js)
  // Signed by the sender's device, for ONE receiver and ONE code, fresh. `edit(hello)` changes it before signing, `after(msg)` after.
  const CODE_HASH = 'Zm9vYmFyYmF6cXV4';
  const NONCE = 'AAAAAAAAAAAAAAAAAAAAAA';
  async function dialMsg(id, o) {
    o = o || {};
    const h = hello.dialBuild({ did: id.did, inception: id.inception, sigs: id.sigs, events: id.events, cert: id.cert }, { to: o.to || B.did, nonce: o.nonce || NONCE, c: o.c || CODE_HASH, now: o.now });
    if (o.edit) o.edit(h);
    const sig = kd.b64u(await subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, (o.signWith || id).device.privateKey, hello.signedBytes(h)));
    const msg = JSON.parse(JSON.stringify({ hello: h, sig }));
    if (o.after) o.after(msg);
    return msg;
  }
  const dverify = (msg, o) => hello.verifyDial(msg, Object.assign({ to: B.did, c: CODE_HASH, audience: AUD }, o || {}));
  const dRefused = async (name, msg, o, pattern) => { const r = await dverify(await msg, o); ok(name, r.ok === false && (!pattern || pattern.test(r.error)), r); };

  const d1 = await dverify(await dialMsg(A));
  ok('a dial request from a device listed in the inception verifies: the DID, the nonce and the time come back', d1.ok && d1.did === A.did && d1.nonce === NONCE && Math.abs(d1.time - Date.now()) < 5000, d1);
  const d2 = await dverify(await dialMsg(A2));
  ok('and one from a device the log lists (a passkey added later) verifies under the same DID', d2.ok && d2.did === A.did, d2);
  const d3 = await dverify(await dialMsg(A3));
  ok('and one from a sign-in certificate on the added passkey verifies', d3.ok && d3.did === A.did, d3);
  await dRefused('a dial request for someone else is refused: it cannot be forwarded to a third device', dialMsg(A, { to: A.did }), {}, /someone else/);
  await dRefused('a dial request with another code\'s hash is refused: it cannot be used with a different code', dialMsg(A, { c: 'b3RoZXJjb2RlaGFzaA' }), {}, /different code/);
  await dRefused('a changed receiver fails the signature', dialMsg(A, { to: A.did, after: (m) => { m.hello.to = B.did; } }), {}, /signature/);
  await dRefused('a changed code hash fails the signature', dialMsg(A, { c: 'b3RoZXJjb2RlaGFzaA', after: (m) => { m.hello.c = CODE_HASH; } }), {}, /signature/);
  await dRefused('a dial request signed by another identity\'s device key fails', dialMsg(A, { signWith: B }), {}, /signature/);
  await dRefused('a dial request older than a minute is refused', dialMsg(A, { now: Date.now() - hello.DIAL_AGE_MS - 5000 }), {}, /too old/);
  await dRefused('a dial request dated in the future is refused', dialMsg(A, { now: Date.now() + 3600e3 }), {}, /future/);
  await dRefused('a dial request with a short or odd nonce is refused', dialMsg(A, { nonce: 'short' }), {}, /nonce/);
  await dRefused('a dial request with a nonce holding other characters is refused', dialMsg(A, { nonce: 'AAAAAAAAAAAAAAAA AAAAAA' }), {}, /nonce/);
  await dRefused('a peer proof is not accepted as a dial request (the purposes differ)', proofMsg(A, 'offer', FPS), {}, /not a keo dial request/);
  ok('and a dial request is refused as a peer proof', (await verify(await dialMsg(A), 'offer')).ok === false);
  await dRefused('something that is not a dial request is refused without throwing', {}, {}, /not a keo dial request/);
  await dRefused('a dial request for another app\'s origin is refused', dialMsg(await makeIdentity('signin', { aud: 'chrome-extension://other' })), {}, /another app/);
  await dRefused('an expired delegation is refused', dialMsg(await makeIdentity('signin', { now: Date.now() - 20e3, ttl: 5e3 })), {}, /expired/);
  await dRefused('an inception that was edited fails', dialMsg(A, { edit: (h) => { h.inception = JSON.parse(JSON.stringify(h.inception)); h.inception.time = '2020-01-01T00:00:00.000Z'; } }), {}, /identity|vouched|could not/);
  await dRefused('a certificate made for another identity is refused', dialMsg(A, { edit: (h) => { h.cert = B.cert; } }), {}, /not for this identity/);
  await dRefused('a dial request from a device the log removed is refused too', dialMsg(Agone), {}, /removed from the identity/);
  await dRefused('and from a removed device with a passkey-signed certificate', dialMsg(AsignGone), {}, /removed from the identity/);
  ok('(control) the same device\'s dial request still verifies on the older log, which the identity\'s own devices cannot tell is old', (await dverify(await dialMsg(Asign))).ok === true);
  await dRefused('a dial request with no identity at all is refused without throwing', dialMsg(A, { edit: (h) => { delete h.inception; delete h.inceptionSigs; delete h.cert; } }), {}, /identity|could not be checked/);
  await dRefused('events grafted onto another identity are refused', dialMsg(B, { to: A.did, edit: (h) => { h.events = A2.events; } }), { to: A.did }, /identity does not verify/);
  await dRefused('the added passkey\'s device without the events is refused', dialMsg(Object.assign({}, A2, { events: [] })), {}, /authority key/);

  // ================================================================ the card (where a device can be asked to connect)
  const HELP = [{ kind: 'ws', host: '203.0.113.9', port: 47431 }, { kind: 'http', host: 'home.example.org', port: 8443 }];
  async function cardMsg(id, o) {
    o = o || {};
    const h = hello.cardBuild({ did: id.did, inception: id.inception, sigs: id.sigs, events: id.events, cert: id.cert }, { helpers: o.helpers || HELP, seq: o.seq || 1, now: o.now });
    if (o.edit) o.edit(h);
    const sig = kd.b64u(await subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, (o.signWith || id).device.privateKey, hello.signedBytes(h)));
    const msg = JSON.parse(JSON.stringify({ hello: h, sig }));
    if (o.after) o.after(msg);
    return msg;
  }
  const cverify = (msg, o) => hello.verifyCard(msg, Object.assign({ audience: AUD }, o || {}));
  const cRefused = async (name, msg, o, pattern) => { const r = await cverify(await msg, o); ok(name, r.ok === false && (!pattern || pattern.test(r.error)), r); };

  const c1 = await cverify(await cardMsg(A, { seq: 3 }), { did: A.did });
  ok('a card from a device listed in the inception verifies: the DID, the device id, the helpers, the version and the time come back',
    c1.ok && c1.did === A.did && c1.deviceId === await hello.deviceIdOf(A.cert.devicePubKeyJwk) && JSON.stringify(c1.helpers) === JSON.stringify(HELP) && c1.seq === 3 && Math.abs(c1.time - Date.now()) < 5000, c1);
  ok('the device id is the one the identity\'s log gives that device', c1.deviceId === A.inception.state.devices[0].id, c1.deviceId);
  ok('a card from a device a later event lists, and one on an added passkey, verify under the same DID',
    (await cverify(await cardMsg(A2))).did === A.did && (await cverify(await cardMsg(A3))).did === A.did);
  ok('a card from a phone-only identity verifies', (await cverify(await cardMsg(P2))).did === P2.did);
  ok('two devices of one identity have different device ids', (await cverify(await cardMsg(A2))).deviceId !== c1.deviceId);
  ok('a card with no helpers is allowed (a device that can no longer be reached says so)', (await cverify(await cardMsg(A, { helpers: [], seq: 4 }))).helpers.length === 0);
  ok('an IPv6 address a person writes short is accepted by the builder and carried in full form', JSON.stringify((await cverify(await cardMsg(A, { helpers: [{ kind: 'ws', host: '2001:DB8::7', port: 1234 }] }))).helpers) === JSON.stringify([{ kind: 'ws', host: '2001:db8:0:0:0:0:0:7', port: 1234 }]));
  ok('a name written in capitals is carried in lower case', (await cverify(await cardMsg(A, { helpers: [{ kind: 'http', host: 'Home.Example.ORG', port: 80 }] }))).helpers[0].host === 'home.example.org');
  ok('an address on a private network is allowed (a helper may be on the same network)', (await cverify(await cardMsg(A, { helpers: [{ kind: 'ws', host: '192.168.1.20', port: 47431 }] }))).ok === true);
  ok('a card is not checked for age, only for the future: the certificate inside it decides', (await cverify(await cardMsg(A, { now: Date.now() - 3600e3 }))).ok === true);

  await cRefused('a card from another identity than the one the caller expected is refused', cardMsg(A), { did: B.did }, /someone else/);
  await cRefused('a changed helper fails the signature (an address cannot be swapped on the way)', cardMsg(A, { after: (m) => { m.hello.helpers[0].host = '203.0.113.66'; } }), {}, /signature/);
  await cRefused('a changed version number fails the signature', cardMsg(A, { after: (m) => { m.hello.seq = 99; } }), {}, /signature/);
  await cRefused('a card signed by another identity\'s device key fails', cardMsg(A, { signWith: B }), {}, /signature/);
  await cRefused('a card dated in the future is refused', cardMsg(A, { now: Date.now() + 3600e3 }), {}, /future/);
  await cRefused('a peer proof is not accepted as a card (the purposes differ)', proofMsg(A, 'offer', FPS), {}, /not a keo card/);
  await cRefused('a dial request is not accepted as a card', dialMsg(A), {}, /not a keo card/);
  ok('and a card is refused as a peer proof and as a dial request', (await verify(await cardMsg(A), 'offer')).ok === false && (await dverify(await cardMsg(A))).ok === false);
  await cRefused('something that is not a card is refused without throwing', {}, {}, /not a keo card/);
  await cRefused('a card for another app\'s origin is refused', cardMsg(await makeIdentity('signin', { aud: 'chrome-extension://other' })), {}, /another app/);
  await cRefused('a card from an expired delegation is refused', cardMsg(await makeIdentity('signin', { now: Date.now() - 20e3, ttl: 5e3 })), {}, /expired/);
  await cRefused('a certificate made for another identity is refused', cardMsg(A, { edit: (h) => { h.cert = B.cert; } }), {}, /not for this identity/);
  await cRefused('a card with no identity at all is refused without throwing', cardMsg(A, { edit: (h) => { delete h.inception; delete h.inceptionSigs; delete h.cert; } }), {}, /identity|could not be checked/);
  await cRefused('events grafted onto another identity are refused', cardMsg(B, { edit: (h) => { h.events = A2.events; } }), {}, /identity does not verify/);
  await cRefused('the added passkey\'s device without the events is refused', cardMsg(Object.assign({}, A2, { events: [] })), {}, /authority key/);

  // the version number is tied to the card's date: it may run ahead only by what a clock may be off, so no card can claim a version that every later card loses to
  const secs = (ms) => Math.floor(ms / 1000);
  const t0 = Date.now();
  await cRefused('a card whose version number is far ahead of its date is refused even though it is signed', cardMsg(A, { now: t0, seq: secs(t0) + 3600 }), {}, /ahead of its date/);
  await cRefused('and one a year ahead', cardMsg(A, { now: t0, seq: secs(t0) + 365 * 86400 }), {}, /ahead of its date/);
  await cRefused('one just past the allowed skew is refused', cardMsg(A, { now: t0, seq: secs(t0) + 121 }), {}, /ahead of its date/);
  ok('one at the allowed skew is accepted (cards made in the same second count up)', (await cverify(await cardMsg(A, { now: t0, seq: secs(t0) + 120 }))).ok === true);
  ok('a version number equal to the date in seconds is accepted', (await cverify(await cardMsg(A, { now: t0, seq: secs(t0) }))).ok === true);
  ok('a small counter far below the date is accepted (the version only has to move forward)', (await cverify(await cardMsg(A, { now: t0, seq: 7 }))).ok === true);
  ok('the date is the card\'s own, so an old card with an old version still passes (a stored card is not judged by the clock now)', (await cverify(await cardMsg(A, { now: t0 - 3600e3, seq: secs(t0 - 3600e3) }))).ok === true);

  // what a device that cheats could still sign: the checks are made on what the card SAYS, not only on the signature
  const bad = (name, helpers, pattern) => cRefused(name, cardMsg(A, { edit: (h) => { h.helpers = helpers; } }), {}, pattern || /not valid/);
  await bad('a helper on this machine itself is refused (loopback)', [{ kind: 'ws', host: '127.0.0.1', port: 1234 }]);
  await bad('a helper at "any address" is refused', [{ kind: 'ws', host: '0.0.0.0', port: 1234 }]);
  await bad('a helper at a link-local IPv6 address is refused', [{ kind: 'ws', host: 'fe80:0:0:0:0:0:0:1', port: 1234 }]);
  await bad('a helper at a multicast address is refused', [{ kind: 'ws', host: '224.0.0.1', port: 1234 }]);
  await bad('a helper named localhost is refused', [{ kind: 'ws', host: 'localhost', port: 1234 }]);
  await bad('a helper with a ".local" name is refused (not found beyond one network)', [{ kind: 'ws', host: 'printer.local', port: 1234 }]);
  await bad('a helper with a one-word name is refused', [{ kind: 'ws', host: 'intranet', port: 1234 }]);
  await bad('a helper with a name ending in a number is refused (looks like an address)', [{ kind: 'ws', host: 'a.b.300', port: 1234 }]);
  await bad('a helper with an address written another way (leading zeros) is refused', [{ kind: 'ws', host: '010.0.0.1', port: 1234 }]);
  await bad('a helper with an IPv6 address not in the full form is refused', [{ kind: 'ws', host: '2001:db8::7', port: 1234 }]);
  await bad('a helper with capitals in its name is refused', [{ kind: 'ws', host: 'Home.Example.org', port: 1234 }]);
  await bad('a helper with a path or a scheme in its host is refused', [{ kind: 'ws', host: 'https://home.example.org/x', port: 1234 }]);
  await bad('a helper with port 0 is refused', [{ kind: 'ws', host: '203.0.113.9', port: 0 }]);
  await bad('a helper with port 70000 is refused', [{ kind: 'ws', host: '203.0.113.9', port: 70000 }]);
  await bad('a helper with a port that is a string is refused', [{ kind: 'ws', host: '203.0.113.9', port: '1234' }]);
  await bad('a helper with an unknown kind (a scheme the page would not speak) is refused', [{ kind: 'file', host: '203.0.113.9', port: 1234 }]);
  await bad('a helper with an extra part is refused', [{ kind: 'ws', host: '203.0.113.9', port: 1234, user: 'x' }]);
  await bad('a helper that is not a record is refused', ['203.0.113.9:1234']);
  await bad('helpers that are not a list are refused', 'ws://203.0.113.9:1234', /too many/);
  await bad('more helpers than allowed are refused', [1, 2, 3, 4, 5].map((i) => ({ kind: 'ws', host: '203.0.113.' + i, port: 1234 })), /too many/);
  await cRefused('a card with no version number is refused', cardMsg(A, { edit: (h) => { delete h.seq; } }), {}, /version/);
  await cRefused('a card with version 0 is refused', cardMsg(A, { edit: (h) => { h.seq = 0; } }), {}, /version/);
  await cRefused('a card with a fractional version is refused', cardMsg(A, { edit: (h) => { h.seq = 1.5; } }), {}, /version/);
  await cRefused('a card with no date is refused', cardMsg(A, { edit: (h) => { h.time = 'yesterday'; } }), {}, /date/);

  // the builder refuses to sign the same things
  const buildThrows = (name, helpers, seq, re) => ok(name, (() => { try { hello.cardBuild({ did: A.did }, { helpers, seq }); return false; } catch (e) { return re.test(e.message); } })());
  buildThrows('the builder will not sign a loopback helper', [{ kind: 'ws', host: '127.0.0.1', port: 1234 }], 1, /not valid/);
  buildThrows('the builder will not sign five helpers', [1, 2, 3, 4, 5].map((i) => ({ kind: 'ws', host: '203.0.113.' + i, port: 1234 })), 1, /at most/);
  buildThrows('the builder will not sign without a whole version number', HELP, 0, /whole number/);
  buildThrows('the builder will not sign helpers that are not a list', null, 1, /at most/);

  // keeping cards: the one rule
  const cardOf = (deviceId, seq, time, host) => ({ ok: true, did: A.did, deviceId, helpers: [{ kind: 'ws', host: host || '203.0.113.9', port: 1 }], seq, time });
  let kept = hello.mergeCard(null, cardOf('d1', 2, 1000));
  ok('a first card for a device is kept', kept.changed && kept.devices.d1.seq === 2 && kept.devices.d1.helpers[0].host === '203.0.113.9');
  ok('a card with a higher version replaces it', hello.mergeCard(kept.devices, cardOf('d1', 3, 2000, '203.0.113.10')).devices.d1.helpers[0].host === '203.0.113.10');
  const replay = hello.mergeCard(kept.devices, cardOf('d1', 2, 3000, '203.0.113.66'));
  ok('a card with the SAME version changes nothing (the first one is kept)', !replay.changed && replay.devices.d1.helpers[0].host === '203.0.113.9');
  const older = hello.mergeCard(kept.devices, cardOf('d1', 1, 4000, '203.0.113.66'));
  ok('an older card cannot roll an address back, even if its time is newer', !older.changed && older.devices.d1.seq === 2);
  const second = hello.mergeCard(kept.devices, cardOf('d2', 1, 500));
  ok('a card for another device of the same friend is kept beside it', second.changed && Object.keys(second.devices).sort().join() === 'd1,d2');
  ok('merging does not change what it was given', kept.devices.d2 === undefined && JSON.stringify(kept.devices.d1) === JSON.stringify({ helpers: [{ kind: 'ws', host: '203.0.113.9', port: 1 }], seq: 2, time: 1000 }));
  let full = null;
  for (let i = 0; i < hello.MAX_CARD_DEVICES; i++) full = hello.mergeCard(full && full.devices, cardOf('x' + i, 1, 1000 + i));
  ok('a friend can have up to the allowed number of devices', Object.keys(full.devices).length === hello.MAX_CARD_DEVICES);
  const over = hello.mergeCard(full.devices, cardOf('new', 1, 5000));
  ok('one more pushes out the device whose card is the oldest', over.changed && Object.keys(over.devices).length === hello.MAX_CARD_DEVICES && !over.devices.x0 && !!over.devices.new && !!over.devices.x1);
  const upd = hello.mergeCard(full.devices, cardOf('x3', 2, 6000));
  ok('a newer card for a device already kept pushes nobody out', upd.changed && Object.keys(upd.devices).length === hello.MAX_CARD_DEVICES && !!upd.devices.x0);

  // a card written as text (a link, a QR, a paste)
  const cm = await cardMsg(A, { seq: 7 }), ctext = hello.cardToText(cm);
  ok('a card written as text starts with its prefix and is one line of safe characters', /^keocard1\.[A-Za-z0-9_-]+$/.test(ctext), ctext.slice(0, 40));
  ok('the text reads back as the same message, and that message verifies', JSON.stringify(hello.cardFromText(ctext)) === JSON.stringify(cm) && (await cverify(hello.cardFromText(ctext))).seq === 7);
  ok('the text is a few kilobytes (printed so a change is noticed): ' + ctext.length, ctext.length > 500 && ctext.length < 12000);
  ok('a card inside a longer line (a link with the card at its end, words around it) is found',
    JSON.stringify(hello.cardFromText('see https://example.org/add#' + ctext + ' thanks')) === JSON.stringify(cm) && JSON.stringify(hello.cardFromText('  \n' + ctext + '\n')) === JSON.stringify(cm));
  const altered = ctext.slice(0, -40) + (ctext.slice(-40, -36) === 'AAAA' ? 'BBBB' : 'AAAA') + ctext.slice(-36);
  let alteredOutcome = 'verified';
  try { alteredOutcome = (await cverify(hello.cardFromText(altered))).ok ? 'verified' : 'refused'; } catch (e) { alteredOutcome = /not a valid keo card/.test(e.message) ? 'refused' : 'wrong error ' + e.message; }
  ok('text altered on the way is either unreadable or fails the check, never accepted', alteredOutcome === 'refused', alteredOutcome);
  const edited = hello.cardFromText(hello.cardToText(Object.assign({}, cm, { hello: Object.assign({}, cm.hello, { helpers: [{ kind: 'ws', host: '203.0.113.66', port: 1 }] }) })));
  ok('text made from a card whose helper was changed fails the signature', /signature/.test((await cverify(edited)).error));
  const textThrows = (name, fn, re) => ok(name, (() => { try { fn(); return false; } catch (e) { return re.test(e.message); } })());
  textThrows('text with no card in it is refused', () => hello.cardFromText('hello there'), /not a keo card/);
  textThrows('an empty or missing text is refused', () => { hello.cardFromText(''); }, /not a keo card/);
  textThrows('the prefix with nothing behind it is refused', () => hello.cardFromText('keocard1.'), /not a valid keo card/);
  textThrows('the prefix with bytes that are not JSON is refused', () => hello.cardFromText('keocard1.AAAA'), /not a valid keo card/);
  textThrows('JSON that is not a card message is refused', () => hello.cardFromText('keocard1.' + kd.b64u(enc.encode('{"a":1}'))), /not a valid keo card/);
  textThrows('a text far too long is refused before it is decoded', () => hello.cardFromText('keocard1.' + 'A'.repeat(60000)), /too long/);
  textThrows('the writer refuses a message that is not a card', () => hello.cardToText(cm.hello), /not a keo card/);
  textThrows('the writer refuses a proof (another purpose)', () => hello.cardToText(JSON.parse(JSON.stringify({ hello: { purpose: 'keo-p2p-channel' }, sig: 's' }))), /not a keo card/);
  ok('text of a message of another purpose reads (the text form checks nothing) and the checker then refuses it',
    (await cverify(hello.cardFromText('keocard1.' + kd.b64u(enc.encode(JSON.stringify({ hello: { purpose: 'x' }, sig: 's' })))))).error === 'That is not a keo card.');

  // an introduction (who and where, unsigned, small enough for a QR)
  const introText = hello.introToText({ did: A.did, name: 'Maya', helpers: HELP });
  ok('an introduction is one line of safe characters with its prefix and is short enough for a QR: ' + introText.length, /^keointro1\.[A-Za-z0-9_-]+$/.test(introText) && introText.length < 600, introText.length);
  const intro = hello.introFromText(introText);
  ok('it reads back as the DID, the name and the helpers', intro.did === A.did && intro.name === 'Maya' && JSON.stringify(intro.helpers) === JSON.stringify(HELP), intro);
  ok('an introduction with no helpers and no name is allowed', (() => { const i = hello.introFromText(hello.introToText({ did: A.did })); return i.did === A.did && i.name === null && i.helpers.length === 0; })());
  ok('it is found inside a longer line', hello.introFromText('scan: https://example.org/#' + introText + ' ok').did === A.did);
  ok('a name with line breaks is written on one line and cut to the limit', (() => { const i = hello.introFromText(hello.introToText({ did: A.did, name: 'A\n  B' })); return i.name === 'A B'; })());
  ok('a host written in capitals is carried in lower case', hello.introFromText(hello.introToText({ did: A.did, helpers: [{ kind: 'http', host: 'Home.Example.ORG', port: 80 }] })).helpers[0].host === 'home.example.org');
  ok('an introduction is not a card, and a card is not an introduction', (() => { try { hello.cardFromText(introText); return false; } catch (e) { return /not a keo card/.test(e.message); } })() && (() => { try { hello.introFromText(ctext); return false; } catch (e) { return /not a keo introduction/.test(e.message); } })());
  const introThrows = (name, fn, re) => ok(name, (() => { try { fn(); return false; } catch (e) { return re.test(e.message); } })());
  introThrows('the writer refuses text that is not an identity', () => hello.introToText({ did: 'did:keo:nope' }), /names no identity/);
  introThrows('the writer refuses a loopback helper', () => hello.introToText({ did: A.did, helpers: [{ kind: 'ws', host: '127.0.0.1', port: 1 }] }), /cannot be reached/);
  introThrows('the writer refuses five helpers', () => hello.introToText({ did: A.did, helpers: [1, 2, 3, 4, 5].map((i) => ({ kind: 'ws', host: '203.0.113.' + i, port: 1 })) }), /too many/);
  introThrows('the writer refuses a helper with an extra part', () => hello.introToText({ did: A.did, helpers: [{ kind: 'ws', host: '203.0.113.9', port: 1, user: 'x' }] }), /extra parts/);
  introThrows('the writer refuses a name that is not text', () => hello.introToText({ did: A.did, name: 5 }), /name/);
  introThrows('the reader refuses text with no introduction', () => hello.introFromText('hello'), /not a keo introduction/);
  introThrows('the reader refuses bytes that are not JSON', () => hello.introFromText('keointro1.AAAA'), /not a valid keo introduction/);
  introThrows('the reader refuses another version', () => hello.introFromText('keointro1.' + kd.b64u(enc.encode(JSON.stringify({ v: 2, did: A.did })))), /not a valid keo introduction/);
  introThrows('the reader refuses a loopback helper written by someone else', () => hello.introFromText('keointro1.' + kd.b64u(enc.encode(JSON.stringify({ v: 1, did: A.did, helpers: [{ kind: 'ws', host: '127.0.0.1', port: 1 }] })))), /not a valid introduction/);
  introThrows('the reader refuses an identity that is not a DID', () => hello.introFromText('keointro1.' + kd.b64u(enc.encode(JSON.stringify({ v: 1, did: '<script>' })))), /names no identity/);
  introThrows('the reader refuses a text far too long', () => hello.introFromText('keointro1.' + 'A'.repeat(9000)), /too long/);

  // ================================================================ the log book: a shown log that is older than the one already seen
  // The book is the real one (keo-wikistore.js offerLog over an in-memory disk), given to the verifiers as `pin`. Without a pin a log is checked
  // on its own, so a device that was removed can show the log from before its removal and verify: that is what the tests above say in so many
  // words (the "NOT refused" checks), and what the pin closes for a verifier that has seen the newer log. A shown log that is only an OLDER copy
  // is not refused for that: the device is checked against the NEWER log the book keeps. A device the newer log removed (or whose passkey it
  // removed) is refused there; a device that has only missed a later event gets in, and the result says `behind`.
  const Store = require(path.join(__dirname, '..', 'shell', 'keo-wikistore.js'));
  async function newBook() {
    const store = Store.create({ backend: Store.memoryBackend(), key: await subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']), did: 'did:keo:' + 'r'.repeat(52) + ':' + 'R'.repeat(43) });
    const asked = [];
    return { store, asked, pin: (did, log) => { asked.push({ did, log }); return store.offerLog(did, log); } };
  }
  const seen = async (bk, did) => { const l = await bk.store.logOf(did); return l ? l.events.length : null; };
  const NOKEPT = /could not use it to check this one/;
  const REMOVED = /removed from the identity/;
  const bkA = await newBook();
  const pA = await verify(await proofMsg(A, 'offer', FPS), 'offer', { pin: bkA.pin });
  ok('a first proof is accepted with a book, and its log is kept; a result that is not behind has no "behind" member', pA.ok === true && pA.did === A.did && await seen(bkA, A.did) === 0 && !('behind' in pA), pA);
  ok('the book was asked with the DID and the log the proof carried', bkA.asked.length === 1 && bkA.asked[0].did === A.did && kd.canonicalJson(bkA.asked[0].log.inception) === kd.canonicalJson(A.inception) && Array.isArray(bkA.asked[0].log.events) && bkA.asked[0].log.events.length === 0);
  ok('the same log again is accepted ("same")', (await verify(await proofMsg(A, 'offer', FPS), 'offer', { pin: bkA.pin })).ok === true && await seen(bkA, A.did) === 0);
  const pA2 = await verify(await proofMsg(A2, 'offer', FPS), 'offer', { pin: bkA.pin });
  ok('a proof with a LONGER log that extends the kept one is accepted and the book now holds the longer log', pA2.ok === true && await seen(bkA, A.did) === 1, pA2);
  const pBehind = await verify(await proofMsg(A, 'offer', FPS), 'offer', { pin: bkA.pin });
  ok('a proof that carries the shorter log, from before the addition, is accepted while the device is still listed in the newer log, and says it is behind', pBehind.ok === true && pBehind.did === A.did && pBehind.behind === true, pBehind);
  const pBehindSign = await verify(await proofMsg(Asign, 'offer', FPS), 'offer', { pin: bkA.pin });
  ok('and so is the passkey-signed certificate of that same device on the shorter log', pBehindSign.ok === true && pBehindSign.behind === true, pBehindSign);
  ok('accepting it left the book as it was: the shorter log is not taken', await seen(bkA, A.did) === 1);

  // the case the pin exists for: a removed device shows the log from before it was removed
  const bkR = await newBook();
  await refused('a proof that carries the removal is refused as before (the device is removed)...', proofMsg(Agone, 'offer', FPS), 'offer', { pin: bkR.pin }, /removed from the identity/);
  ok('...and the book learned the longer log from it, although the proof was refused', await seen(bkR, A.did) === 1);
  await refused('the same removed device, shown with the log from BEFORE its removal (inception-kind certificate), is now refused, as removed', proofMsg(A, 'offer', FPS), 'offer', { pin: bkR.pin }, REMOVED);
  await refused('and with its passkey-signed certificate', proofMsg(Asign, 'offer', FPS), 'offer', { pin: bkR.pin }, REMOVED);
  ok('(control) with no book the same two proofs are still accepted: the protection is the book, nothing else', (await verify(await proofMsg(A, 'offer', FPS), 'offer')).ok === true && (await verify(await proofMsg(Asign, 'offer', FPS), 'offer')).ok === true);
  const A2afterA = Object.assign({}, A2, { events: (await withEvent(A2, await kd.removeDeviceEvent(lastEvent(A2), await devIdOf(A)), [signAs(A)])).events });
  const bkS = await newBook();
  ok('another device of the same identity, which was not removed, shows the log that removed the first one: accepted, and the longer log is kept', (await verify(await proofMsg(A2afterA, 'offer', FPS), 'offer', { pin: bkS.pin })).ok === true && await seen(bkS, A.did) === 2);
  await refused('after that the removed device, shown with the log from before its removal, is refused', proofMsg(A, 'offer', FPS), 'offer', { pin: bkS.pin }, REMOVED);
  // what the newer log removed is not only a device: a passkey it removed takes the certificates made with it
  const bkK = await newBook();
  ok('a log that removed the first passkey (the one added later signed the removal) is kept', (await verify(await proofMsg(A3x, 'offer', FPS), 'offer', { pin: bkK.pin })).ok === true && await seen(bkK, A.did) === 2);
  await refused('a device whose proof shows the older log, with an inception-kind certificate made by the removed passkey, is refused', proofMsg(A, 'offer', FPS), 'offer', { pin: bkK.pin }, /authority key/);
  await refused('and so is its passkey-signed certificate', proofMsg(Asign, 'offer', FPS), 'offer', { pin: bkK.pin }, /authority key/);
  const bkL = await newBook();
  await verify(await proofMsg(A2gone, 'offer', FPS), 'offer', { pin: bkL.pin });
  await refused('a device that a LATER event added and a still later event removed, shown with the log from when it was listed, is refused as removed', proofMsg(A2, 'offer', FPS), 'offer', { pin: bkL.pin }, REMOVED);
  const pLate = await verify(await proofMsg(Object.assign({}, A2, { events: [] }), 'offer', FPS), 'offer', { pin: bkA.pin });
  ok('the kept log is what counts: a device a later event added, shown with a copy that does not have that event yet, is accepted (and behind) because the kept log lists it (without a book the same proof is refused: "does not know the added passkey")', pLate.ok === true && pLate.behind === true, pLate);
  await refused('being behind is no way in for a passkey that only a different log lists: a device on the added passkey (A3), shown with no events, against a kept log that has another passkey (A2)', proofMsg(Object.assign({}, A3, { events: [] }), 'offer', FPS), 'offer', { pin: bkA.pin }, /authority key/);
  ok('a different identity is not held to this identity\'s log', (await verify(await proofMsg(B, 'answer', FPS), 'answer', { pin: bkR.pin })).ok === true && await seen(bkR, B.did) === 0);

  // two logs that disagree
  const bkF = await newBook();
  await verify(await proofMsg(A2, 'offer', FPS), 'offer', { pin: bkF.pin });
  await refused('a log that disagrees with the kept one about an event both hold is refused, whatever its length', proofMsg(Agone, 'offer', FPS), 'offer', { pin: bkF.pin }, /disagrees with what this device has already seen/);
  ok('the book kept the first log and wrote the disagreement down', await seen(bkF, A.did) === 1 && (await bkF.store.alerts()).some((a) => a.kind === 'log-fork' && a.did === A.did && a.at === 1));

  // the same rule for a dial request and for a card
  const dBehind = await dverify(await dialMsg(A), { pin: bkA.pin });
  ok('a dial request on the older log is accepted with the book while the device is still listed, and says it is behind', dBehind.ok === true && dBehind.behind === true && dBehind.did === A.did, dBehind);
  await dRefused('and one from the removed device with a passkey-signed certificate on the older log is refused, as removed', dialMsg(Asign), { pin: bkR.pin }, REMOVED);
  ok('a dial request on the newer log is accepted with the book', (await dverify(await dialMsg(A2), { pin: bkA.pin })).ok === true);
  const cBehind = await cverify(await cardMsg(A, { seq: 5 }), { pin: bkA.pin });
  ok('a card on the older log is accepted with the book while the device is still listed, and says it is behind', cBehind.ok === true && cBehind.behind === true && cBehind.did === A.did, cBehind);
  await cRefused('a card from the removed device on the older log is refused, as removed', cardMsg(Asign, { seq: 5 }), { pin: bkR.pin }, REMOVED);
  await cRefused('and a card that disagrees with the kept log', cardMsg(Agone, { seq: 5 }), { pin: bkF.pin }, /disagrees with what this device has already seen/);
  ok('a card on the newer log is accepted with the book, under the proven DID', (await cverify(await cardMsg(A2, { seq: 5 }), { pin: bkA.pin, did: A.did })).ok === true);

  // a book that cannot answer, or answers with something odd, never lets a proof through
  const odd = async (name, pin, re) => { const r = await verify(await proofMsg(A, 'offer', FPS), 'offer', { pin }); ok(name, r.ok === false && re.test(r.error), r); };
  await odd('a book that throws (nobody is signed in, say) refuses the proof, with the ordinary "could not be checked"', async () => { throw new Error('Sign in to use wiki pages.'); }, /could not be checked/);
  await odd('a book that answers "refused" refuses the proof', async () => ({ status: 'refused', error: 'x' }), /could not be checked against what this device already knows/);
  await odd('a book that answers something unknown refuses the proof', async () => ({ status: 'maybe' }), /could not be checked against what this device already knows/);
  await odd('a book that answers nothing refuses the proof', async () => undefined, /could not be checked against what this device already knows/);
  await odd('a book that says "shorter" and does not hand back the kept log refuses the proof (nothing to check the device against)', async () => ({ status: 'shorter' }), NOKEPT);
  await odd('and so does one whose kept log is not a log that verifies', async () => ({ status: 'shorter', kept: { inception: A.inception, sigs: A.sigs, events: [{ event: { v: 1, type: 'add-device', seq: 1 }, sigs: {} }] } }), NOKEPT);
  await odd('and one whose kept log is another identity\'s', async () => ({ status: 'shorter', kept: { inception: B.inception, sigs: B.sigs, events: [] } }), NOKEPT);
  ok('a log that does not verify never reaches the book', await (async () => { const bk = await newBook(); await verify(await proofMsg(A2, 'offer', FPS, { edit: (h) => { h.events = JSON.parse(JSON.stringify(h.events)); h.events[0].event.add.key.rpId = 'evil.test'; } }), 'offer', { pin: bk.pin }); return bk.asked.length === 0; })());

  console.log(passed + ' checks passed' + (process.exitCode ? ', SOME FAILED' : ''));
})().catch((e) => { console.error('FATAL', e); process.exit(2); });
