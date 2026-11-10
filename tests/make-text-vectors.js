// Writes tests/vectors/texts.json: fixed texts that a phone app (any language) checks its reader and writer of keo's two text forms against:
//   - the INTRODUCTION ('keointro1.', unsigned, small enough for a QR): shell/keo-hello.js introToText / introFromText. Fully deterministic.
//   - the signed CARD ('keocard1.'): cardToText / cardFromText / verifyCard. The signatures come from keys made when this runs, so the card
//     part changes every time: run it only to REPLACE the vectors, and then replace the app's own copy of the file too. The private keys
//     exist only in this process and are never written anywhere. The checks are made at a fixed time, so the vectors do not expire.
// Usage: node tests/make-text-vectors.js
const fs = require('fs');
const path = require('path');
const kd = require(path.join(__dirname, '..', 'shell', 'keo-did.js'));
const hello = require(path.join(__dirname, '..', 'shell', 'keo-hello.js'));
const subtle = globalThis.crypto.subtle;
const enc = new TextEncoder();
const plain = (j) => ({ kty: j.kty, crv: j.crv, x: j.x, y: j.y });
const AUD = 'chrome-extension://example';
const T = '2026-01-01T00:00:00.000Z';
const NOW = '2026-01-01T01:00:00.000Z';      // the time every card check is made at (the certificate lasts until 12:00)
const LATER = '2026-01-01T13:00:00.000Z';    // after the certificate has expired

(async () => {
  // ---- introductions
  const disc = kd.z32encode(new Uint8Array(32).map((_, i) => i + 1));
  const did = kd.didFor(disc, kd.b64u(await kd.sha256(enc.encode('keo text vector identity'))));
  const did2 = kd.didFor(disc, kd.b64u(await kd.sha256(enc.encode('keo text vector identity two'))));
  const H1 = { kind: 'ws', host: '203.0.113.9', port: 47431 }, H2 = { kind: 'http', host: 'home.example.org', port: 8443 };
  const b = (o) => 'keointro1.' + kd.b64u(enc.encode(typeof o === 'string' ? o : JSON.stringify(o)));
  const writerCases = [
    { name: 'only an identity', input: { did } },
    { name: 'an identity and a name', input: { did, name: 'Maya' } },
    { name: 'an identity, a name and two helpers', input: { did, name: 'Maya', helpers: [H1, H2] } },
    { name: 'four helpers and the longest name (64 characters)', input: { did, name: 'N'.repeat(64), helpers: [1, 2, 3, 4].map((i) => ({ kind: 'http', host: 'helper-' + i + '.example.org', port: 8443 })) } },
    { name: 'a helper at an IPv6 address in the full form', input: { did: did2, helpers: [{ kind: 'ws', host: '2001:db8:0:0:0:0:0:7', port: 1234 }] } },
    { name: 'a name with non-ASCII text', input: { did, name: 'Zoë ✓' } }
  ].map((c) => {
    const text = hello.introToText(c.input), r = hello.introFromText(text);
    return { name: c.name, input: c.input, text, expect: { did: r.did, name: r.name, helpers: r.helpers } };
  });
  // texts a reader must accept that a writer would not produce
  const readerCases = [
    { name: 'the same record with its keys in another order', text: b({ name: 'Maya', helpers: [H1], did, v: 1 }) },
    { name: 'a helper host written in capitals (read as lower case)', text: b({ v: 1, did, helpers: [{ kind: 'http', host: 'Home.Example.ORG', port: 80 }] }) },
    { name: 'a helper at an IPv6 address written short (read in the full form)', text: b({ v: 1, did, helpers: [{ kind: 'ws', host: '2001:DB8::7', port: 1234 }] }) },
    { name: 'a name with line breaks and runs of spaces (read on one line, spaces collapsed)', text: b({ v: 1, did, name: 'A\n   B  C' }) },
    { name: 'an extra top-level part (ignored)', text: b({ v: 1, did, extra: 'ignored' }) },
    { name: 'inside a link', text: 'https://example.org/add#' + hello.introToText({ did, name: 'Maya' }) },
    { name: 'inside a message with words before and after, and a line break', text: 'hello\nhere: ' + hello.introToText({ did, name: 'Maya' }) + ' (see you)' }
  ].map((c) => { const r = hello.introFromText(c.text); return { name: c.name, text: c.text, expect: { did: r.did, name: r.name, helpers: r.helpers } }; });
  const refusedSource = [
    ['no introduction in it', 'hello there'], ['empty text', ''], ['the prefix and nothing else', 'keointro1.'], ['bytes that are not JSON', 'keointro1.AAAA'],
    ['a card, not an introduction', 'keocard1.' + kd.b64u(enc.encode('{}'))], ['another version', b({ v: 2, did })], ['no version', b({ did })],
    ['no identity', b({ v: 1 })], ['an identity that is not one', b({ v: 1, did: '<script>' })], ['an identity with the wrong parts', b({ v: 1, did: 'did:keo:abc:def' })],
    ['a list that is not a list', b({ v: 1, did, helpers: 'ws://203.0.113.9:47431' })], ['five helpers', b({ v: 1, did, helpers: [1, 2, 3, 4, 5].map((i) => ({ kind: 'ws', host: '203.0.113.' + i, port: 1 })) })],
    ['a helper with an extra part', b({ v: 1, did, helpers: [{ kind: 'ws', host: '203.0.113.9', port: 1, user: 'x' }] })],
    ['a helper on this machine itself (loopback)', b({ v: 1, did, helpers: [{ kind: 'ws', host: '127.0.0.1', port: 1 }] })],
    ['a helper at "any address"', b({ v: 1, did, helpers: [{ kind: 'ws', host: '0.0.0.0', port: 1 }] })],
    ['a helper at a link-local IPv6 address', b({ v: 1, did, helpers: [{ kind: 'ws', host: 'fe80:0:0:0:0:0:0:1', port: 1 }] })],
    ['a helper named localhost', b({ v: 1, did, helpers: [{ kind: 'ws', host: 'localhost', port: 1 }] })],
    ['a helper with a ".local" name', b({ v: 1, did, helpers: [{ kind: 'ws', host: 'printer.local', port: 1 }] })],
    ['a helper with a one-word name', b({ v: 1, did, helpers: [{ kind: 'ws', host: 'intranet', port: 1 }] })],
    ['a helper with a path in its host', b({ v: 1, did, helpers: [{ kind: 'ws', host: 'https://home.example.org/x', port: 1 }] })],
    ['a helper with port 0', b({ v: 1, did, helpers: [{ kind: 'ws', host: '203.0.113.9', port: 0 }] })],
    ['a helper with port 70000', b({ v: 1, did, helpers: [{ kind: 'ws', host: '203.0.113.9', port: 70000 }] })],
    ['a helper with a port that is text', b({ v: 1, did, helpers: [{ kind: 'ws', host: '203.0.113.9', port: '1234' }] })],
    ['a helper with a kind the page would not speak', b({ v: 1, did, helpers: [{ kind: 'file', host: '203.0.113.9', port: 1 }] })],
    ['a name that is a number', b({ v: 1, did, name: 5 })], ['a name over 64 characters', b({ v: 1, did, name: 'N'.repeat(65) })],
    ['the part after the prefix over 2000 characters', 'keointro1.' + 'A'.repeat(2001)], ['a whole text over 4000 characters', 'x'.repeat(4001) + hello.introToText({ did })]
  ];
  const refused = refusedSource.map(([name, text]) => {
    let error = null; try { hello.introFromText(text); } catch (e) { error = e.message; }
    if (!error) throw new Error('this was meant to be refused: ' + name);
    return { name, text, error };
  });

  // ---- cards: an identity whose only authority is a phone, with a computer the phone added (so the card's certificate is that event)
  const pair = await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const device = await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const deviceJwk = plain(await subtle.exportKey('jwk', device.publicKey));
  const dev = { id: kd.b64u(await kd.sha256(enc.encode(kd.canonicalJson(deviceJwk)))), jwk: deviceJwk, addedAt: T };
  // the discovery key is the public half of an Ed25519 key made from a fixed seed; it signs the inception too, as for every identity
  const discPair = await kd.ed25519FromSeed(new Uint8Array(32).map((_, i) => 40 - i));
  const dkey = discPair.publicZ32;
  const keyId = 'dmVjdG9yLXBob25lLWtleQ';
  const state = { authority: { threshold: 1, keys: [{ id: keyId, jwk: plain(await subtle.exportKey('jwk', pair.publicKey)), kind: 'phone', addedAt: T }] }, next: null,
    recovery: { guardians: [], threshold: 2, delayDays: 3 }, discovery: { key: dkey, version: 1 }, services: [], claims: { handles: [] }, revoked: [] };
  const inception = { v: 1, type: 'inception', seq: 0, prev: null, time: T, state };
  const H = await kd.eventHash(inception), cardDid = kd.didFor(dkey, kd.b64u(H));
  const phoneSig = async (purpose, h) => ({ scheme: 'p256-raw', signature: kd.b64u(new Uint8Array(await subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, pair.privateKey, Buffer.concat([Buffer.from('keo/authority/v1'), Buffer.from([0]), Buffer.from(purpose), Buffer.from([0]), Buffer.from(h)])))) });
  const sigs = { discovery: kd.b64u(await subtle.sign({ name: 'Ed25519' }, discPair.privateKey, H)), authority: [Object.assign({ keyId }, await phoneSig('inception', H))] };
  const addEv = await kd.addDeviceEvent(inception, dev, T);
  const events = [{ event: addEv, sigs: { authority: [Object.assign({ keyId }, await phoneSig('add-device', await kd.eventHash(addEv)))] } }];
  const cert = { via: 'log', v: 1, did: cardDid, devicePubKeyJwk: deviceJwk, issuedAt: T, exp: '2026-01-01T12:00:00.000Z', aud: AUD, scope: ['world:read', 'world:write', 'sign'], authorityKeyId: keyId };
  const makeCard = async (helpers, seq, edit) => {
    const h = hello.cardBuild({ did: cardDid, inception, sigs: sigs, events, cert }, { helpers, seq, now: Date.parse(T) + 60e3 });
    const sig = kd.b64u(new Uint8Array(await subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, device.privateKey, hello.signedBytes(h))));
    const msg = JSON.parse(JSON.stringify({ hello: h, sig }));
    if (edit) edit(msg);
    return msg;
  };
  const cardCase = async (name, helpers, seq, edit) => { const message = await makeCard(helpers, seq, edit); return { name, message, text: hello.cardToText(message) }; };
  const opts = (now) => ({ now: Date.parse(now), audience: AUD });
  const validCards = [await cardCase('a card with two helpers', [H1, H2], 1700000000), await cardCase('a card with no helpers ("not reachable there")', [], 1700000001)];
  for (const c of validCards) {
    const v = await hello.verifyCard(hello.cardFromText(c.text), opts(NOW));
    if (!v.ok) throw new Error('a valid card did not verify: ' + v.error);
    delete c.message;   // the text holds it
    c.at = NOW; c.audience = AUD; c.expect = { ok: true, did: v.did, deviceId: v.deviceId, helpers: v.helpers, seq: v.seq, time: new Date(v.time).toISOString() };
  }
  const refusedCards = [];
  const refuse = async (name, c, now, audience) => {
    const msg = hello.cardFromText(c.text), v = await hello.verifyCard(msg, { now: Date.parse(now), audience: audience || AUD });
    if (v.ok) throw new Error('this card was meant to be refused: ' + name);
    refusedCards.push({ name, text: c.text, at: now, audience: audience || AUD, error: v.error });
  };
  await refuse('checked after its certificate has expired', validCards[0], LATER);
  await refuse('checked for another app\'s origin', validCards[0], NOW, 'chrome-extension://other');
  await refuse('a helper address changed after signing', await cardCase('x', [H1, H2], 1700000000, (m) => { m.hello.helpers[0].host = '203.0.113.66'; }), NOW);
  await refuse('the version number changed after signing (still near its date: the signature fails)', await cardCase('x', [H1], 1700000000, (m) => { m.hello.seq = 1700000005; }), NOW);
  await refuse('a version number far ahead of the date of the card, signed properly (refused for the number, whoever signed it)', await cardCase('x', [H1], 1800000000), NOW);
  await refuse('a loopback helper (a card that was signed anyway)', await cardCase('x', [H1], 1700000000, (m) => { m.hello.helpers = [{ kind: 'ws', host: '127.0.0.1', port: 1 }]; }), NOW);
  // texts that are not a card at all
  const textRefused = [['no card in it', 'hello there'], ['the prefix and nothing else', 'keocard1.'], ['bytes that are not JSON', 'keocard1.AAAA'], ['an introduction, not a card', hello.introToText({ did })],
    ['JSON that is not a card message', 'keocard1.' + kd.b64u(enc.encode('{"a":1}'))]].map(([name, text]) => {
    let error = null; try { hello.cardFromText(text); } catch (e) { error = e.message; }
    if (!error) throw new Error('this was meant to be refused: ' + name);
    return { name, text, error };
  });

  const out = {
    about: 'Test vectors for keo\'s two text forms (shell/keo-hello.js). INTRODUCTION: a reader must turn every text of introductions.writer and introductions.reader into its expect (the DID, the name or null, the helpers), and must refuse every text of introductions.refused (the error sentence is what the reference code says; only the refusal matters). A writer must produce exactly the text of introductions.writer from its input: the keys in the order v, did, helpers, name, a helper\'s keys kind, host, port, no spaces, base64url without padding. CARD: a reader must read cards.valid texts back into their message, verify each at `at` for `audience` (the signature, the identity, the device, the certificate, the helper rules) and get its expect, and must refuse every cards.refused at its `at`. A card is only ever READ and checked by a phone; its signature is made by a computer\'s device key. cards.textRefused are texts that hold no card. Introductions are not signed: nothing here says who a person is, only what a text means. The card part is made with new keys every time the vectors are written.',
    introductions: { prefix: 'keointro1.', maxPart: 2000, maxWhole: 4000, did, writer: writerCases, reader: readerCases, refused },
    cards: { prefix: 'keocard1.', audience: AUD, at: NOW, valid: validCards, refused: refusedCards, textRefused: textRefused }
  };
  fs.mkdirSync(path.join(__dirname, 'vectors'), { recursive: true });
  fs.writeFileSync(path.join(__dirname, 'vectors', 'texts.json'), JSON.stringify(out, null, 2) + '\n');
  console.log('wrote tests/vectors/texts.json: introductions ' + writerCases.length + ' writer, ' + readerCases.length + ' reader, ' + refused.length + ' refused; cards ' + validCards.length + ' valid, ' + refusedCards.length + ' refused, ' + textRefused.length + ' not cards');
})().catch((e) => { console.error(e); process.exit(1); });
