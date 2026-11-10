// Node test for shell/keo-sha256.js (SHA-256 fed in pieces): no browser. The answers are checked against the published test vectors
// and against the platform's own digest, over every length near a block edge, over inputs fed in uneven pieces and as views into a
// larger buffer, and over a file-sized input.
// Usage: node tests/keo-sha256-test.js
const path = require('path');
const sha = require(path.join(__dirname, '..', 'shell', 'keo-sha256.js'));
const subtle = globalThis.crypto.subtle;
let passed = 0;
const ok = (name, cond, extra) => { if (!cond) { console.error('FAIL ' + name + (extra !== undefined ? ' ' + JSON.stringify(extra) : '')); process.exitCode = 1; } else { passed++; console.log('ok   ' + name); } };
const hex = (u8) => Array.from(u8, (b) => b.toString(16).padStart(2, '0')).join('');
const ref = async (u8) => hex(new Uint8Array(await subtle.digest('SHA-256', u8)));
const te = new TextEncoder();
// a reproducible stream of bytes (not random, so a failure can be repeated)
function fill(n, seed) { const u = new Uint8Array(n); let x = seed >>> 0 || 1; for (let i = 0; i < n; i++) { x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0; u[i] = x & 255; } return u; }

(async () => {
  // ---- published vectors (FIPS 180-4 examples and the long test)
  ok('the empty message', hex(sha.hash(new Uint8Array(0))) === 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  ok('"abc"', hex(sha.hash(te.encode('abc'))) === 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  ok('the 448-bit message', hex(sha.hash(te.encode('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq'))) === '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1');
  const million = sha.create(); const a1000 = te.encode('a'.repeat(1000)); for (let i = 0; i < 1000; i++) million.update(a1000);
  ok('one million "a", fed in a thousand pieces', hex(million.digest()) === 'cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0');

  // ---- every length around the block edges (0 to 300) against the platform's digest
  let bad = null;
  for (let n = 0; n <= 300 && !bad; n++) { const d = fill(n, n + 7); if (hex(sha.hash(d)) !== await ref(d)) bad = n; }
  ok('every length from 0 to 300 bytes gives the platform digest', bad === null, bad);

  // ---- uneven pieces give the same answer as one piece
  let pieceBad = null;
  for (const n of [0, 1, 55, 56, 57, 63, 64, 65, 119, 120, 121, 127, 128, 129, 1000, 4097, 65536, 100003]) {
    const d = fill(n, n + 99), want = await ref(d);
    const sizes = [[1], [3], [63], [64], [65], [1, 2, 3, 4, 5, 6, 7], [0, 64, 0, 1, 127], [4096]];
    for (const s of sizes) {
      const h = sha.create(); let o = 0, k = 0;
      while (o < n) { const m = Math.min(s[k++ % s.length], n - o); h.update(d.subarray(o, o + m)); o += m; }
      if (hex(h.digest()) !== want) { pieceBad = { n, s }; break; }
    }
    if (pieceBad) break;
  }
  ok('a message fed in pieces of every awkward size gives the platform digest', pieceBad === null, pieceBad);

  // ---- views and buffers
  const big = fill(1000, 5), view = new Uint8Array(big.buffer, 13, 700), viewRef = await ref(big.slice(13, 713));
  ok('a view into a larger buffer is hashed over its own bytes only', hex(sha.hash(view)) === viewRef);
  ok('an ArrayBuffer is accepted', hex(sha.hash(big.buffer)) === await ref(big));
  const dv = new DataView(big.buffer, 100, 50);
  ok('a DataView is accepted, over its own bytes', hex(sha.hash(dv)) === await ref(big.slice(100, 150)));
  const u16 = new Uint16Array(big.buffer, 10, 20);
  ok('a wider typed array is hashed over its bytes', hex(sha.hash(u16)) === await ref(big.slice(10, 50)));

  // ---- refusals and state
  let t = false; try { sha.hash('a string'); } catch (e) { t = /needs bytes/.test(e.message); }
  ok('a string is refused with a sentence (it is not bytes)', t);
  t = false; try { sha.create().update([1, 2, 3]); } catch (e) { t = /needs bytes/.test(e.message); }
  ok('a plain array is refused', t);
  t = false; try { sha.create().update(null); } catch (e) { t = /needs bytes/.test(e.message); }
  ok('null is refused', t);
  const fin = sha.create().update(te.encode('abc')); const d1 = fin.digest(), d2 = fin.digest();
  ok('asking twice for the digest gives the same bytes', hex(d1) === hex(d2));
  d1[0] ^= 255;
  ok('the returned bytes are a copy: changing them changes nothing', hex(fin.digest()) === 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  t = false; try { fin.update(te.encode('more')); } catch (e) { t = /finished/.test(e.message); }
  ok('feeding a finished hash is refused', t);
  ok('update returns the hash, so calls chain', hex(sha.create().update(te.encode('a')).update(te.encode('bc')).digest()) === 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');

  // ---- file-sized input, in the chunk size the library will use
  const CHUNK = 4 * 1024 * 1024;
  for (const n of [CHUNK - 1, CHUNK, CHUNK + 1, 3 * CHUNK + 12345]) {
    const d = fill(n, n), want = await ref(d), h = sha.create();
    for (let o = 0; o < n; o += CHUNK) h.update(d.subarray(o, Math.min(o + CHUNK, n)));
    ok('a ' + n + '-byte input in 4 MiB chunks gives the platform digest', hex(h.digest()) === want);
  }
  const t0 = Date.now(), d64 = fill(64 * 1024 * 1024, 3), tFill = Date.now() - t0, h2 = sha.create(), t1 = Date.now();
  for (let o = 0; o < d64.length; o += CHUNK) h2.update(d64.subarray(o, o + CHUNK));
  const mine = hex(h2.digest()), tMine = Date.now() - t1;
  ok('a 64 MiB input in 4 MiB chunks gives the platform digest', mine === await ref(d64));
  console.log('     (64 MiB: ' + tMine + ' ms here, ' + Math.round(64 / (tMine / 1000)) + ' MiB per second; the input took ' + tFill + ' ms to make)');

  console.log(passed + ' checks passed' + (process.exitCode ? ' (with failures)' : ''));
})();
