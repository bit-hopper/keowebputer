// SHA-256 that can be fed in pieces. The browser's own digest takes the whole input in one call, which a file of hundreds of megabytes
// must not be made to do (it would have to be held in memory in full just to be named). The library names a file by the SHA-256 of
// its bytes and checks that name (keo-library.js), so this routine reads a file one chunk at a time and gives the same answer.
// It is the plain FIPS 180-4 algorithm, written here and checked against the browser's digest and the published test vectors
// (tests/keo-sha256-test.js).
// Use it ONLY to name and check content of unbounded size. For a small input use the browser's digest, and never use this for
// anything that is secret or keyed: it makes no attempt to run in constant time and is slower than the browser's own.
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api; else root.keoSha256 = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var K = new Uint32Array([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2]);
  var INIT = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
  var BLOCK = 64;

  // One 64-byte block of p, starting at o, folded into the state h. w is scratch space of 64 words.
  function compress(h, w, p, o) {
    var i, x, y, s0, s1;
    for (i = 0; i < 16; i++, o += 4) w[i] = (p[o] << 24) | (p[o + 1] << 16) | (p[o + 2] << 8) | p[o + 3];
    for (i = 16; i < 64; i++) {
      x = w[i - 15]; y = w[i - 2];
      s0 = ((x >>> 7) | (x << 25)) ^ ((x >>> 18) | (x << 14)) ^ (x >>> 3);
      s1 = ((y >>> 17) | (y << 15)) ^ ((y >>> 19) | (y << 13)) ^ (y >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
    }
    var a = h[0], b = h[1], c = h[2], d = h[3], e = h[4], f = h[5], g = h[6], hh = h[7];
    for (i = 0; i < 64; i++) {
      var S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
      var t1 = (hh + S1 + ((e & f) ^ (~e & g)) + K[i] + w[i]) | 0;
      var S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
      var t2 = (S0 + ((a & b) ^ (a & c) ^ (b & c))) | 0;
      hh = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
    }
    h[0] = (h[0] + a) | 0; h[1] = (h[1] + b) | 0; h[2] = (h[2] + c) | 0; h[3] = (h[3] + d) | 0;
    h[4] = (h[4] + e) | 0; h[5] = (h[5] + f) | 0; h[6] = (h[6] + g) | 0; h[7] = (h[7] + hh) | 0;
  }

  // The bytes of a typed array or an ArrayBuffer, as a Uint8Array over the same memory (nothing is copied).
  function bytesOf(v) {
    if (ArrayBuffer.isView(v)) return new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
    if (Object.prototype.toString.call(v) === '[object ArrayBuffer]') return new Uint8Array(v);
    throw new Error('SHA-256 needs bytes.');
  }

  function Hash() {
    this.h = new Int32Array(INIT);      // signed words: the arithmetic above is done with | 0
    this.w = new Int32Array(64);
    this.buf = new Uint8Array(BLOCK);   // the part of a block that has arrived but cannot be folded in yet
    this.held = 0;                      // how many bytes of buf are in use
    this.length = 0;                    // bytes fed so far
    this.out = null;                    // the digest once finished
  }
  // Feeds more bytes. Returns the hash, so calls can be chained.
  Hash.prototype.update = function (data) {
    if (this.out) throw new Error('This SHA-256 is finished.');
    var p = bytesOf(data), n = p.length, o = 0;
    this.length += n;
    if (this.held) {
      var take = Math.min(BLOCK - this.held, n);
      this.buf.set(p.subarray(0, take), this.held);
      this.held += take; o = take;
      if (this.held < BLOCK) return this;
      compress(this.h, this.w, this.buf, 0);
      this.held = 0;
    }
    for (; o + BLOCK <= n; o += BLOCK) compress(this.h, this.w, p, o);
    if (o < n) { this.buf.set(p.subarray(o), 0); this.held = n - o; }
    return this;
  };
  // The 32-byte digest. The hash is finished by this; asking again gives the same bytes.
  Hash.prototype.digest = function () {
    if (this.out) return this.out.slice();
    var bits_hi = Math.floor(this.length / 536870912), bits_lo = (this.length % 536870912) * 8;   // the length in bits, as two words
    var pad = this.held < 56 ? 56 - this.held : 120 - this.held, tail = new Uint8Array(pad + 8);
    tail[0] = 0x80;
    for (var i = 0; i < 4; i++) { tail[pad + i] = (bits_hi >>> (24 - 8 * i)) & 255; tail[pad + 4 + i] = (bits_lo >>> (24 - 8 * i)) & 255; }
    var keep = this.length;
    this.update(tail);
    this.length = keep;
    var out = new Uint8Array(32);
    for (var j = 0; j < 8; j++) { out[4 * j] = this.h[j] >>> 24; out[4 * j + 1] = (this.h[j] >>> 16) & 255; out[4 * j + 2] = (this.h[j] >>> 8) & 255; out[4 * j + 3] = this.h[j] & 255; }
    this.out = out;
    return out.slice();
  };

  function create() { return new Hash(); }
  // One call over bytes already in memory (a convenience for tests; prefer the browser's digest for small inputs).
  function hash(data) { return new Hash().update(data).digest(); }

  return { BLOCK: BLOCK, create: create, hash: hash };
});
