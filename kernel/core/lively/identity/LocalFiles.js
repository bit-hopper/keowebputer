/**
 * lively.identity.LocalFiles
 *
 * World-side client for the FILES kept in keo's local library (shell/keo-library.js: library.fileBegin / fileChunk / fileEnd /
 * fileAbort / fileInfo / fileRead). A dropped picture, video or document is sent to the shell in slices and kept there sealed under
 * the signed-in identity; the world keeps only a small reference ({ handle: HANDLE, objId: <the file's id> }), so a saved world stays
 * small however many files it shows, and a file is never read into memory whole on the way in.
 *
 * Showing a file goes the other way and ends in the world on purpose: a blob address made by the shell page does not load inside the
 * sandboxed world (measured: video error, picture fails, fetch fails), so the slices travel here and the blob is made here.
 *
 * isAvailable() is true only inside the keo package (the bridge exists and is not the standalone stand-in), the same switch as
 * lively.identity.LocalIdentity: on a page a host serves it is false and the host-style upload keeps being used.
 * Not for: files a host keeps (FileCrypto), sharing, or anything that needs the bytes of a very large file in one array
 * (bytesFor holds the whole file; use urlFor for a picture or a video, which holds a blob the browser may keep off the heap).
 *
 * Async convention: thenDo(err, result) throughout, like the rest of lively.identity.
 */

module("lively.identity.LocalFiles")
  .requires("lively.identity.LocalIdentity")
  .toRun(function () {

    // What the world stores as a file reference's "handle" for a library file. A host's handles are names a person chose; this one
    // can never be mistaken for one (a handle has no colon) and tells the media morphs to ask the shell instead of a host.
    var HANDLE = "keo:local";
    var STEP_TIMEOUT = 120000;

    Object.subclass("lively.identity.LocalFiles", {

      HANDLE: HANDLE,

      isAvailable: function isAvailable() {
        var li = lively.identity.localIdentity;
        return !!(li && li.isAvailable());
      },

      isRef: function isRef(handle) { return handle === HANDLE; },

      _call: function _call(op, args, thenDo) {
        window.keo.call(op, args, STEP_TIMEOUT).then(
          function (result) { thenDo(null, result); },
          function (err) { thenDo(err instanceof Error ? err : new Error(String(err && err.message || err))); }
        );
      },

      // Sends `file` (a File or Blob) to the library. opts.onProgress(fraction 0..1), opts.name overrides file.name.
      // thenDo(null, { id, name, type, size, existed, ref }) with ref = { handle, objId, blobCid } for the media morphs.
      // The file is read in slices of the size the shell asks for (File.slice), one at a time, and on any failure the shell is told to
      // drop what it stored so far.
      // Files dropped together are sent one after the other (the shell takes only a couple at once and a refusal for that would lose
      // the later pictures), so this queues; a file waits its turn without a word and its callback comes when it has been stored.
      put: function put(file, opts, thenDo) {
        var self = this;
        if (!this._queue) this._queue = [];
        this._queue.push({ file: file, opts: opts, thenDo: thenDo });
        this._pump();
      },

      _pump: function _pump() {
        var self = this;
        if (this._busy || !this._queue.length) return;
        this._busy = true;
        var job = this._queue.shift();
        this._putNow(job.file, job.opts, function (err, result) {
          self._busy = false;
          setTimeout(function () { self._pump(); }, 0);
          job.thenDo(err, result);
        });
      },

      _putNow: function _putNow(file, opts, thenDo) {
        var self = this;
        opts = opts || {};
        var name = opts.name || file.name || "file", type = file.type || "application/octet-stream";
        if (!this.isAvailable()) return thenDo(new Error("Files can be kept only inside the keo app."));
        this._call("library.fileBegin", { name: name, type: type, size: file.size }, function (err, begin) {
          if (err) return thenDo(err);
          var upload = begin.upload, step = begin.chunkBytes, n = 0, off = 0;
          function fail(e) {
            self._call("library.fileAbort", { upload: upload }, function () { thenDo(e instanceof Error ? e : new Error(String(e))); });
          }
          function next() {
            if (off >= file.size) {
              return self._call("library.fileEnd", { upload: upload }, function (err, end) {
                if (err) return fail(err);
                opts.onProgress && opts.onProgress(1);
                thenDo(null, { id: end.id, name: name, type: type, size: end.size, existed: end.existed,
                  ref: { handle: HANDLE, objId: end.id, blobCid: end.id } });
              });
            }
            file.slice(off, Math.min(off + step, file.size)).arrayBuffer().then(function (bytes) {
              self._call("library.fileChunk", { upload: upload, n: n, bytes: bytes }, function (err) {
                if (err) return fail(err);
                n++; off += bytes.byteLength;
                opts.onProgress && opts.onProgress(off / file.size);
                next();
              });
            }, fail);
          }
          next();
        });
      },

      // The file's description: { id, name, type, size, chunks, ... } or null when this identity has no such file.
      info: function info(id, thenDo) { this._call("library.fileInfo", { id: id }, thenDo); },

      // A Blob of the whole file, made here from the slices (never one array of the whole file). thenDo(null, blob, info).
      blobFor: function blobFor(id, thenDo) {
        var self = this;
        this.info(id, function (err, info) {
          if (err) return thenDo(err);
          if (!info) return thenDo(new Error("That file is not in this device's library."));
          var parts = [], n = 0;
          (function next() {
            if (n >= info.chunks) return thenDo(null, new Blob(parts, { type: info.type || "application/octet-stream" }), info);
            self._call("library.fileRead", { id: id, n: n }, function (err, bytes) {
              if (err) return thenDo(err);
              if (!bytes) return thenDo(new Error("A library file is damaged: a chunk is missing."));
              parts.push(bytes); n++; next();
            });
          })();
        });
      },

      // An object URL for the file, the same one every time in a session (so a picture shown twice is read from the library once).
      // `mime` is used when the library has no type for the file (an older single-record file). thenDo(null, url).
      urlFor: function urlFor(id, mime, thenDo) {
        if (!this._urls) this._urls = {};
        if (this._urls[id]) return thenDo(null, this._urls[id]);
        var self = this;
        this.blobFor(id, function (err, blob, info) {
          if (err) return thenDo(err);
          if (self._urls[id]) return thenDo(null, self._urls[id]);      // another request finished first
          if (!blob.type && mime) blob = new Blob([blob], { type: mime });
          self._urls[id] = URL.createObjectURL(blob);
          thenDo(null, self._urls[id]);
        });
      },

      // The whole file as a Uint8Array (for a PDF, which pdf.js takes as bytes). thenDo(null, bytes, info).
      bytesFor: function bytesFor(id, thenDo) {
        this.blobFor(id, function (err, blob, info) {
          if (err) return thenDo(err);
          blob.arrayBuffer().then(function (buf) { thenDo(null, new Uint8Array(buf), info); }, thenDo);
        });
      }
    });

    lively.identity.localFiles = new lively.identity.LocalFiles();

  }); // end module('lively.identity.LocalFiles')
