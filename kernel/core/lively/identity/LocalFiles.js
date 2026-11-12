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

      _call: function _call(op, args, thenDo, timeoutMs) {
        window.keo.call(op, args, timeoutMs || STEP_TIMEOUT).then(
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
        var name = opts.name || file.name || "file", type = this.docTypeOf(name) || file.type || "application/octet-stream";
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
                self.changed();
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

      // ---- files kept where they lie (the desktop app only; shell/keo-point.js) --------------------------------------------------
      // The world can only ASK. The shell puts the question to the person, opens the system's file chooser on their click and reads the
      // file; no path comes in or goes out. What comes back is a library file like any other (a reference by the file's hash), marked
      // pointed. Whether the question can be asked here is learned once (checkPointAvailable) and kept in pointAvailable, so a menu can
      // be drawn without waiting.
      pointAvailable: false,

      checkPointAvailable: function checkPointAvailable(thenDo) {
        var self = this;
        if (!this.isAvailable()) return thenDo && thenDo(null, false);
        this._call("library.pointAvailable", {}, function (err, yes) {
          self.pointAvailable = !err && yes === true;
          thenDo && thenDo(null, self.pointAvailable);
        });
      },

      // thenDo(err, null) when the person cancelled; thenDo(null, { id, name, type, size, existed, pointed, ref }) otherwise (existed and
      // not pointed: the library already holds a copy of those bytes, which is kept). Reading a big file takes minutes, hence the wait.
      point: function point(thenDo) {
        this._call("library.point", {}, function (err, r) {
          if (err) return thenDo(err);
          if (!r) return thenDo(null, null);
          r.ref = { handle: HANDLE, objId: r.id, blobCid: r.id };
          lively.identity.localFiles.changed();
          thenDo(null, r);
        }, 60 * 60 * 1000);
      },

      // The sign on a picture, video, sound or PDF whose file cannot be shown: a small red label in its corner with two or three words
      // ("file missing", "file changed"), and the whole sentence as its tooltip. The sign is drawn only: it is not part of what a world
      // is rebuilt from (isEpiMorph keeps it out of the saved data). Not for anything but media morphs that show a library file.
      PROBLEM_WORDS: { missing: "file missing", changed: "file changed", denied: "cannot open file", elsewhere: "not on this computer", other: "cannot be shown" },

      // Which kind of problem a sentence from the shell describes (shell/keo-library.js words them).
      problemKind: function problemKind(sentence) {
        var t = String(sentence || "");
        if (/has changed/.test(t)) return "changed";
        if (/not where it was|no longer there|not a file any more/.test(t)) return "missing";
        if (/will not let keo read|cannot be opened/.test(t)) return "denied";
        if (/another computer or app/.test(t)) return "elsewhere";
        return "other";
      },

      markProblem: function markProblem(morph, kind, sentence) {
        if (!morph || !morph.addMorph) return;
        this.clearProblem(morph);
        var words = this.PROBLEM_WORDS[kind] || this.PROBLEM_WORDS.other;
        // a small red box holding the warning icon (Material Symbols Rounded) and the words, each its own Text morph
        var box = new lively.morphic.Box(lively.rect(4, 4, Math.round(words.length * 6.2 + 30), 20));
        box.applyStyle({ fill: Color.rgb(192, 57, 43), borderWidth: 0, borderRadius: 3 });
        box.name = "KeoFileProblem";
        box.isEpiMorph = true;
        box.draggingEnabled = false; box.droppingEnabled = false; box.grabbingEnabled = false;
        var icon = new lively.morphic.Text(lively.rect(3, 2, 16, 16), "warning");
        icon.applyStyle({ allowInput: false, fontFamily: "'Material Symbols Rounded'", fontSize: 11, textColor: Color.white, fill: null, borderWidth: 0, borderColor: null });
        icon.eventsAreIgnored = true;
        box.addMorph(icon);
        var label = new lively.morphic.Text(lively.rect(20, 2, Math.round(words.length * 6.2 + 8), 16), words);
        label.applyStyle({ allowInput: false, fontSize: 9, textColor: Color.white, fill: null, borderWidth: 0, borderColor: null });
        label.eventsAreIgnored = true;
        box.addMorph(label);
        var tip = String(sentence || "");
        if (box.setToolTip) box.setToolTip(tip); else box.toolTip = tip;
        morph.addMorph(box);
        morph._keoProblem = box;
      },

      clearProblem: function clearProblem(morph) {
        var old = morph && morph._keoProblem;
        if (old) { try { old.remove(); } catch (e) {} }
        if (morph) morph._keoProblem = null;
      },

      // Called when a morph starts showing the library file `id`: a file kept where it lies that is gone, changed or locked gets the
      // sign at once (the shell compares its size and time; only reading the file can say whether bytes changed, and that fails with a
      // sentence, which also becomes the sign). Anything else clears the sign.
      checkMorph: function checkMorph(morph, id) {
        var self = this;
        this.info(id, function (err, info) {
          if (err || !info || !info.pointed) return;
          var sentences = {
            missing: "This file is kept where it was added on this computer, and it is no longer there.",
            changed: "This file is kept where it was added on this computer, and it has changed since, so keo will not show it.",
            denied: "This file is kept on this computer, which will not let keo open it now.",
          };
          if (sentences[info.state]) self.markProblem(morph, info.state, info.name ? '"' + info.name + '": ' + sentences[info.state] : sentences[info.state]);
          else self.clearProblem(morph);
        });
      },

      // ---- the library's files, for a screen that lists them (MyFilesBrowser) ------------------------------------------------------
      // Tells every window of this world that the library's files changed (one was added, pointed at or removed), so a list showing them
      // can read again. A page event, not a bridge message: all of it happens in this one world.
      changed: function changed() {
        try { window.dispatchEvent(new CustomEvent("keo-files-changed")); } catch (e) { /* no page events here */ }
      },

      // opts: { query, type, folder, sort, limit, offset }. thenDo(err, { items: [{ id, name, type, size, created, folder, pointed? }], total, unreadable }).
      // Words in the name, in any order and case; type is a kind or the start of one ("image/", "application/pdf"); folder is left out for
      // every file, "unsorted" for the files in no folder, or a folder's id (its files and those of the folders inside it); sort is
      // "added" (newest first, the default), "name", "size" (largest first) or "type".
      search: function search(opts, thenDo) {
        opts = opts || {};
        var args = { query: opts.query || "", type: opts.type || "", limit: opts.limit || 50, offset: opts.offset || 0 };
        if (opts.folder) args.folder = opts.folder;
        if (opts.sort) args.sort = opts.sort;
        this._call("library.fileSearch", args, thenDo);
      },

      // ---- names and folders (the sealed record of a file holds both; the shell changes them) -----------------------------------------
      // Each of these tells the other windows afterwards, like add and remove do. Folders go two levels deep; deleting one never deletes
      // a file (its files and folders go up a level).
      // thenDo(err, { id, name, folder, same }): `same` is how many other files in that folder already have the name (allowed; warn).
      rename: function rename(id, name, thenDo) { this._changing("library.fileRename", { id: id, name: name }, thenDo); },
      // folder: a folder's id, or "unsorted". thenDo(err, { moved, unchanged, missing }).
      move: function move(ids, folder, thenDo) { this._changing("library.fileMove", { ids: ids, folder: folder }, thenDo); },
      // thenDo(err, { folders: [{ id, name, parent, created, count, total }], unsorted, all, unreadable }).
      folders: function folders(thenDo) { this._call("library.folderList", {}, thenDo); },
      // thenDo(err, { id, name, parent }). parent: a top-level folder's id, or left out for the top level.
      folderCreate: function folderCreate(name, parent, thenDo) { this._changing("library.folderCreate", parent ? { name: name, parent: parent } : { name: name }, thenDo); },
      folderRename: function folderRename(id, name, thenDo) { this._changing("library.folderRename", { id: id, name: name }, thenDo); },
      // thenDo(err, { id, files, folders, parent }): how many files and folders went up, and to which folder (null: no folder).
      folderDelete: function folderDelete(id, thenDo) { this._changing("library.folderDelete", { id: id }, thenDo); },

      _changing: function _changing(op, args, thenDo) {
        var self = this;
        this._call(op, args, function (err, result) {
          if (!err) self.changed();
          thenDo(err, result);
        });
      },

      // Takes the file out of the library (for one kept where it lies: only the record, never the file on the computer). thenDo(err, removed).
      // Worlds that show it will not be able to: nothing yet counts which worlds do.
      remove: function remove(id, thenDo) {
        var self = this;
        this._call("library.fileRemove", { id: id }, function (err, removed) {
          if (!err) self.changed();
          thenDo(err, removed);
        });
      },

      // The documents other than PDF that keo can show (lively.data.DocumentUpload), by the ending of the name. A browser often gives such
      // a file no type at all (or a wrong one), so a library file with one of these endings is kept under the type below.
      DOC_TYPES: {
        md: "text/markdown", markdown: "text/markdown", txt: "text/plain", html: "text/html", htm: "text/html",
        epub: "application/epub+zip", docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
      },

      // What the Docs filter asks the library for: PDF and every document above, as a list the search takes.
      DOC_KINDS: "application/pdf,text/markdown,text/plain,text/html,application/epub+zip,application/vnd.openxmlformats-officedocument.wordprocessingml.document",

      // The type for a name's ending, or null when it is not one of the documents above.
      docTypeOf: function docTypeOf(name) {
        var m = /\.([A-Za-z0-9]+)$/.exec(String(name || ""));
        var ext = m ? m[1].toLowerCase() : "";
        return Object.prototype.hasOwnProperty.call(this.DOC_TYPES, ext) ? this.DOC_TYPES[ext] : null;
      },

      // True for PDF and for the types above.
      isDocType: function isDocType(type) {
        var t = String(type || "").toLowerCase(), d = this.DOC_TYPES;
        return t === "application/pdf" || Object.keys(d).some(function (k) { return d[k] === t; });
      },

      // What kind of thing a media type is, in a word a person reads: "Picture", "Video", "Sound", "PDF", "Document", "File".
      kindWord: function kindWord(type) {
        var t = String(type || "");
        if (/^image\//.test(t)) return "Picture";
        if (/^video\//.test(t)) return "Video";
        if (/^audio\//.test(t)) return "Sound";
        if (t === "application/pdf") return "PDF";
        if (this.isDocType(t)) return "Document";
        return "File";
      },

      // "820 MB", "1.2 GB": 1024-based like the shell's sentences. Room is rounded down so a line never promises more than there is.
      sizeText: function sizeText(n, down) {
        var u = ["bytes", "KB", "MB", "GB", "TB"], i = 0, v = n;
        while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
        if (i === 0) return Math.round(v) + (Math.round(v) === 1 ? " byte" : " bytes");
        var r = (down ? Math.floor(v * 10) : Math.round(v * 10)) / 10;
        return (r % 1 === 0 ? r.toFixed(0) : r.toFixed(1)) + " " + u[i];
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
    // Learn once whether this app can keep a file where it lies, so the identity menu can offer it without waiting (it is offered
    // only where the answer is yes: the desktop app).
    try { lively.identity.localFiles.checkPointAvailable(); } catch (e) { /* not inside keo */ }

  }); // end module('lively.identity.LocalFiles')
