// Node test for shell/keo-qr.js (drawing a QR code with the vendored encoder): no browser. A drawn code is turned into pixels and READ BACK
// with a separate decoder (jsQR, a dev dependency used only here), which is what proves the code is a real, readable one. The decoder
// is not shipped: nothing in the shell reads QR codes.
// Usage: node keo-qr-test.js
const path = require('path');
const jsQR = require('jsqr');
const qr = require(path.join(__dirname, '..', 'shell', 'keo-qr.js'));
const hello = require(path.join(__dirname, '..', 'shell', 'keo-hello.js'));
let passed = 0;
const ok = (name, cond, extra) => { if (!cond) { console.error('FAIL ' + name + (extra !== undefined ? ' ' + JSON.stringify(extra) : '')); process.exitCode = 1; } else { passed++; console.log('ok   ' + name); } };
const read = (text, scale) => { const img = qr.toRgba(text, scale); const r = jsQR(img.data, img.width, img.height); return r ? r.data : null; };

// a real introduction, as keo makes it
const DID = 'did:keo:' + 'y'.repeat(52) + ':' + 'A'.repeat(43);
const HELP = [{ kind: 'ws', host: '203.0.113.9', port: 47431 }, { kind: 'http', host: 'home.example.org', port: 8443 }];
const intro = hello.introToText({ did: DID, name: 'Maya', helpers: HELP });
const big = hello.introToText({ did: DID, name: 'N'.repeat(64), helpers: [1, 2, 3, 4].map((i) => ({ kind: 'http', host: 'a-long-helper-name-' + i + '.example.org', port: 8443 })) });

ok('an introduction is read back exactly from its drawing: ' + intro.length + ' characters', read(intro, 4) === intro);
ok('the largest introduction (a long name and four helpers) is read back exactly: ' + big.length + ' characters', read(big, 4) === big);
ok('the same at a smaller scale (3 pixels to a module)', read(intro, 3) === intro);
ok('the same at a larger scale (8 pixels to a module)', read(intro, 8) === intro);
const m = qr.matrix(intro);
ok('its symbol is small enough for a phone to read from a screen: version ' + m.version + ', ' + m.size + ' modules a side', m.version <= 16 && m.size <= 81, m);
const mbig = qr.matrix(big);
ok('even the largest is within version 20: ' + mbig.version, mbig.version <= 20, mbig.version);

let allOk = true, tried = 0;
for (let len = 1; len <= 900; len += (len < 60 ? 1 : 37)) {
  const t = 'keointro1.' + 'aB3_-'.repeat(200).slice(0, len);
  tried++;
  if (read(t, 3) !== t) { allOk = false; console.error('  length', t.length, 'did not read back'); }
}
ok('texts of ' + tried + ' different lengths (one to 900 characters) all read back exactly', allOk);
ok('text with non-ASCII characters is read back (as UTF-8)', read('café ✓ keo', 4) === 'café ✓ keo');

// the picture itself
const img = qr.toRgba(intro, 4);
ok('the picture is square, in whole modules, with the margin on every side', img.width === img.height && img.width === (img.modules + 2 * qr.QUIET) * 4 && qr.QUIET >= 4);
let marginLight = true;
for (let y = 0; y < img.height; y++) for (let x = 0; x < img.width; x++) {
  const inMargin = x < qr.QUIET * 4 || y < qr.QUIET * 4 || x >= img.width - qr.QUIET * 4 || y >= img.height - qr.QUIET * 4;
  if (inMargin && img.data[(y * img.width + x) * 4] !== 255) marginLight = false;
}
ok('the margin is all light', marginLight);
let onlyBlackWhite = true, dark = 0;
for (let i = 0; i < img.data.length; i += 4) { const v = img.data[i]; if ((v !== 0 && v !== 255) || img.data[i + 1] !== v || img.data[i + 2] !== v || img.data[i + 3] !== 255) onlyBlackWhite = false; if (v === 0) dark++; }
ok('every pixel is black or white and opaque (dark on light whatever the page theme)', onlyBlackWhite);
const ratio = dark / (img.width * img.height);
ok('about half of the symbol is dark, not blank or solid: ' + ratio.toFixed(2), ratio > 0.2 && ratio < 0.6, ratio);
ok('the same text gives the same picture', Buffer.from(qr.toRgba(intro, 4).data).equals(Buffer.from(img.data)));
ok('a different text gives a different picture', !Buffer.from(qr.toRgba(intro + 'x', 4).data).equals(Buffer.from(img.data)));

// refusals
const throws = (name, fn, re) => ok(name, (() => { try { fn(); return false; } catch (e) { return re.test(e.message); } })());
throws('nothing to draw is refused', () => qr.matrix(''), /nothing to draw/);
throws('missing text is refused', () => qr.matrix(null), /nothing to draw/);
throws('a text too long for a phone to read is refused', () => qr.matrix('x'.repeat(2001)), /too long/);
throws('a scale of zero is refused', () => qr.toRgba(intro, 0), /scale/);
throws('a fractional scale is refused', () => qr.toRgba(intro, 2.5), /scale/);
throws('a scale far too large is refused', () => qr.toRgba(intro, 100), /scale/);

console.log(passed + ' checks passed' + (process.exitCode ? ', SOME FAILED' : ''));
