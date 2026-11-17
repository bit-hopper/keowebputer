// The worker that does the SHA-256 of a file's bytes for keo-hash.js, so that naming a big file does not hold up the shell's thread.
// It runs shell/keo-sha256.js, the same routine the shell used on its own thread, so every name comes out as it did before.
// It has no power: no bridge, no storage, no keys. It is given bytes of files (public to the shell already), answers with a digest, and
// keeps nothing but the running state of the files it is hashing. Nothing here may be used for anything secret or keyed (see keo-sha256.js).
// Messages in:  { op: 'update', h, seq, bytes }  feed bytes (in order) to hash h, made on first use;  { op: 'digest', h }  finish h;
//               { op: 'drop', h }  forget h.   Messages out: { ready: true } once, { h, seq } when an update has been folded in,
//               { h, digest } for a digest, { h, seq?, error } when a message could not be handled.
'use strict';
importScripts('keo-sha256.js');       // a file of the package, next to this one (the page's policy lets a worker run only those)
var open = {};                        // hash id -> running SHA-256

self.onmessage = function (e) {
  var m = e.data || {}, h, d;
  try {
    if (m.op === 'update') {
      h = open[m.h] || (open[m.h] = self.keoSha256.create());
      h.update(m.bytes);
      self.postMessage({ h: m.h, seq: m.seq });
    } else if (m.op === 'digest') {
      h = open[m.h] || self.keoSha256.create();     // nothing fed is the empty input, and has a digest
      d = h.digest();
      delete open[m.h];
      self.postMessage({ h: m.h, digest: d }, [d.buffer]);
    } else if (m.op === 'drop') {
      delete open[m.h];
    } else {
      self.postMessage({ h: m.h, seq: m.seq, error: 'Unknown request.' });
    }
  } catch (err) {
    self.postMessage({ h: m.h, seq: m.seq, error: String(err && err.message || err) });
  }
};
self.postMessage({ ready: true });
