// Checks tests/vectors/texts.json against shell/keo-hello.js: no browser. A phone app does the same checks in its own language, with its own
// reader and writer (see `about` in the file). Here the reference code must agree with the file it wrote, so a change to the format shows up
// as a failure of this test, and the file must then be written again (tests/make-text-vectors.js) and given to the app.
// Usage: node tests/keo-text-vectors-test.js
const path = require('path');
const fs = require('fs');
const hello = require(path.join(__dirname, '..', 'shell', 'keo-hello.js'));
const v = JSON.parse(fs.readFileSync(path.join(__dirname, 'vectors', 'texts.json'), 'utf8'));
let passed = 0;
const ok = (name, cond, extra) => { if (!cond) { console.error('FAIL ' + name + (extra !== undefined ? ' ' + JSON.stringify(extra).slice(0, 300) : '')); process.exitCode = 1; } else { passed++; console.log('ok   ' + name); } };
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const throwsWith = (fn) => { try { fn(); return null; } catch (e) { return e.message; } };

(async () => {
  const I = v.introductions;
  ok('the introduction prefix and limits are the ones in the code', I.prefix === 'keointro1.' && I.maxPart === 2000 && I.maxWhole === 4000);
  ok('the identity used in the vectors has the shape of a DID', /^did:keo:[ybndrfg8ejkmcpqxot1uwisza345h769]{52}:[A-Za-z0-9_-]{43}$/.test(I.did));
  for (const c of I.writer) {
    ok('writer: ' + c.name + ': the text is exactly what the writer makes', hello.introToText(c.input) === c.text);
    ok('writer: ' + c.name + ': the text starts with the prefix and holds only base64url characters', /^keointro1\.[A-Za-z0-9_-]+$/.test(c.text));
    ok('writer: ' + c.name + ': it reads back as its expect', same(hello.introFromText(c.text), c.expect), hello.introFromText(c.text));
    ok('writer: ' + c.name + ': it fits a QR (' + c.text.length + ' characters)', c.text.length <= 700);
  }
  for (const c of I.reader) ok('reader: ' + c.name, same(hello.introFromText(c.text), c.expect), hello.introFromText(c.text));
  for (const c of I.refused) {
    const e = throwsWith(() => hello.introFromText(c.text));
    ok('refused: ' + c.name, e === c.error && !!e, { got: e, want: c.error });
  }

  const C = v.cards;
  ok('the card prefix is the one in the code', C.prefix === 'keocard1.');
  for (const c of C.valid) {
    const msg = hello.cardFromText(c.text);
    ok('card: ' + c.name + ': the text reads back and writes to the same text', hello.cardToText(msg) === c.text);
    const r = await hello.verifyCard(msg, { now: Date.parse(c.at), audience: c.audience });
    ok('card: ' + c.name + ': it verifies at the fixed time, with the DID, the device, the helpers, the version and the time', r.ok === true && r.did === c.expect.did && r.deviceId === c.expect.deviceId && same(r.helpers, c.expect.helpers) && r.seq === c.expect.seq && new Date(r.time).toISOString() === c.expect.time, r);
    ok('card: ' + c.name + ': the text is long (' + c.text.length + ' characters): too long for a QR, which is why introductions exist', c.text.length > 2500);
  }
  for (const c of C.refused) {
    const r = await hello.verifyCard(hello.cardFromText(c.text), { now: Date.parse(c.at), audience: c.audience });
    ok('card refused: ' + c.name, r.ok === false && r.error === c.error, r);
  }
  for (const c of C.textRefused) {
    const e = throwsWith(() => hello.cardFromText(c.text));
    ok('card text refused: ' + c.name, e === c.error && !!e, { got: e, want: c.error });
  }
  console.log(passed + ' checks passed' + (process.exitCode ? ', SOME FAILED' : ''));
})().catch((e) => { console.error(e); process.exit(1); });
