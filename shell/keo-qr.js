// Drawing a QR code. This only WRITES one (keo-qrcodegen.js, the vendored encoder); nothing in the shell reads one: the phone scans.
// The text is encoded in byte mode at the medium error-correction level (about 15% of the symbol can be damaged), which for a keo
// introduction (about 350 characters, keo-hello.js introToText) comes out as a symbol of about 70 modules a side. A code is dark modules
// on a light ground with a light margin of at least four modules (the quiet zone): without that margin scanners often fail, so it is
// part of every drawing here, and the colours are fixed (a scanner needs dark on light, whatever the page's theme is).
// Pure functions over the text, so a Node test can render and decode one; only draw() touches a canvas.
(function (root, factory) {
  var gen = typeof module === 'object' && module.exports ? require('./keo-qrcodegen.js') : root.keoQrcodegen;
  var api = factory(gen);
  if (typeof module === 'object' && module.exports) module.exports = api; else root.keoQr = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (gen) {
  'use strict';

  var QUIET = 4, MAX_BYTES = 2000;

  // { size, dark(x, y) } for the text. Throws a sentence when the text is empty or too long for a code a phone can read.
  function matrix(text) {
    var s = String(text == null ? '' : text);
    if (!s) throw new Error('There is nothing to draw.');
    if (s.length > MAX_BYTES) throw new Error('That is too long for a QR code.');
    var code;
    try {
      // Always byte mode (UTF-8): that is what a reader expects of a link, and the text has lower-case letters, so no denser mode would apply.
      code = gen.QrCode.encodeBinary(Array.prototype.slice.call(new TextEncoder().encode(s)), gen.QrCode.Ecc.MEDIUM);
    } catch (e) { throw new Error('That could not be drawn as a QR code.'); }
    return { size: code.size, version: code.version, dark: function (x, y) { return code.getModule(x, y); } };
  }

  // Pixels (RGBA, 8 bits each) of the code with its margin, `scale` pixels to a module. { width, height, data (Uint8ClampedArray) }.
  function toRgba(text, scale) {
    scale = scale === undefined ? 4 : scale;
    if (!(scale >= 1 && scale <= 32) || scale % 1 !== 0) throw new Error('The scale must be a whole number from 1 to 32.');
    var m = matrix(text), n = m.size + 2 * QUIET, w = n * scale, data = new Uint8ClampedArray(w * w * 4);
    for (var y = 0; y < w; y++) {
      for (var x = 0; x < w; x++) {
        var mx = Math.floor(x / scale) - QUIET, my = Math.floor(y / scale) - QUIET, v = m.dark(mx, my) ? 0 : 255, i = (y * w + x) * 4;
        data[i] = data[i + 1] = data[i + 2] = v; data[i + 3] = 255;
      }
    }
    return { width: w, height: w, data: data, modules: m.size, version: m.version };
  }

  // Draws the code on a canvas, sized so the whole code with its margin is `px` pixels wide (a whole number of pixels to a module, so the edges
  // stay sharp), and returns { modules, version, width }. The canvas is made that size.
  function draw(canvas, text, px) {
    var m = matrix(text), n = m.size + 2 * QUIET, scale = Math.max(1, Math.floor((px || 256) / n)), w = n * scale;
    canvas.width = canvas.height = w;
    var ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, w, w);
    ctx.fillStyle = '#000000';
    for (var y = 0; y < m.size; y++) for (var x = 0; x < m.size; x++) if (m.dark(x, y)) ctx.fillRect((x + QUIET) * scale, (y + QUIET) * scale, scale, scale);
    return { modules: m.size, version: m.version, width: w };
  }

  return { QUIET: QUIET, matrix: matrix, toRgba: toRgba, draw: draw };
});
