/**
 * core/lively/identity/KeoReader.js
 *
 * Reads a .keo account export (settings.md §5a) in the browser, with no
 * library: a .keo is a plain tar archive, so this is ~100 lines of header
 * parsing. Its job is the "verify" step before an account is deleted — the
 * user picks the file they downloaded and this checks it is complete and
 * uncorrupted against its own manifest, so "I've saved my data" can be
 * trusted.
 *
 *   lively.identity.KeoReader.verify(file, onProgress)  → Promise<result>
 *     result = { ok, problems: [string], warnings: [string], manifest|null,
 *                counts, entries: number }
 *
 * What verify checks:
 *   - the first entry is format.json naming "keo-account-export", version 1
 *   - the last entry is manifest.json (a truncated download has none)
 *   - no path appears twice, nothing is in the archive that the manifest
 *     doesn't list (or the reverse)
 *   - every listed entry has the manifest's size and SHA-256
 * An entry larger than MAX_HASH_BYTES is size-checked only (hashing needs the
 * whole entry in memory) and says so in `warnings`.
 *
 * lively.identity.KeoReader.compareWithSummary(manifest, summary) → [string]
 * lists disagreements with the server's GET /@:handle/account/summary.
 */

module("lively.identity.KeoReader")
  .requires()
  .toRun(function () {

    var BLOCK = 512;
    var MAX_HASH_BYTES = 256 * 1024 * 1024;

    function readBytes(blob, start, end) {
      return blob.slice(start, end).arrayBuffer().then(function (buf) { return new Uint8Array(buf); });
    }

    function cString(bytes, start, len) {
      var end = start;
      while (end < start + len && bytes[end] !== 0) end++;
      return new TextDecoder("utf-8").decode(bytes.subarray(start, end));
    }

    function octal(bytes, start, len) {
      var s = cString(bytes, start, len).trim();
      return s ? parseInt(s, 8) : 0;
    }

    function allZero(bytes) {
      for (var i = 0; i < bytes.length; i++) if (bytes[i] !== 0) return false;
      return true;
    }

    // PAX records: "<len> key=value\n" repeated.
    function paxPath(bytes) {
      var text = new TextDecoder("utf-8").decode(bytes);
      var m = /(?:^|\n)\d+ path=([^\n]*)\n/.exec(text);
      return m ? m[1] : null;
    }

    function hex(buf) {
      var b = new Uint8Array(buf), s = "";
      for (var i = 0; i < b.length; i++) s += (b[i] < 16 ? "0" : "") + b[i].toString(16);
      return s;
    }

    // Walks the tar headers. Resolves { entries: [{path, size, offset}], truncated }.
    // `offset` is where the entry's content starts. Entries come back in archive order.
    function scan(blob) {
      var entries = [];
      var pendingPath = null;
      function step(pos) {
        if (pos + BLOCK > blob.size) return Promise.resolve({ entries: entries, truncated: pos < blob.size });
        return readBytes(blob, pos, pos + BLOCK).then(function (h) {
          if (allZero(h)) return { entries: entries, truncated: false };
          var name = cString(h, 0, 100);
          var prefix = cString(h, 345, 155);
          var size = octal(h, 124, 12);
          var type = String.fromCharCode(h[156] || 48);
          var contentStart = pos + BLOCK;
          var next = contentStart + Math.ceil(size / BLOCK) * BLOCK;
          if (contentStart + size > blob.size) return { entries: entries, truncated: true };
          if (type === "x") {
            return readBytes(blob, contentStart, contentStart + size).then(function (body) {
              pendingPath = paxPath(body);
              return step(next);
            });
          }
          var full = pendingPath || (prefix ? prefix + "/" + name : name);
          pendingPath = null;
          if (type === "0" || type === "\0") entries.push({ path: full, size: size, offset: contentStart });
          return step(next);
        });
      }
      return step(0);
    }

    function sha256Hex(blob, start, size) {
      return blob.slice(start, start + size).arrayBuffer().then(function (buf) {
        return crypto.subtle.digest("SHA-256", buf);
      }).then(hex);
    }

    function verify(file, onProgress) {
      var problems = [], warnings = [];
      var out = { ok: false, problems: problems, warnings: warnings, manifest: null, counts: null, entries: 0 };
      function progress(msg) { if (onProgress) onProgress(msg); }

      progress("Reading the archive…");
      return scan(file).then(function (scanned) {
        var entries = scanned.entries;
        out.entries = entries.length;
        if (scanned.truncated) problems.push("The file ends early: it looks like an incomplete download.");
        if (!entries.length) { problems.push("This doesn't look like a .keo file (no entries found)."); return out; }

        var byPath = {};
        entries.forEach(function (e) {
          if (byPath[e.path]) problems.push("The archive contains " + e.path + " more than once.");
          byPath[e.path] = e;
        });

        var first = entries[0], last = entries[entries.length - 1];
        var chain = Promise.resolve();

        chain = chain.then(function () {
          if (first.path !== "format.json") { problems.push("The first entry should be format.json, not " + first.path + "."); return; }
          return readBytes(file, first.offset, first.offset + first.size).then(function (b) {
            var f = null;
            try { f = JSON.parse(new TextDecoder("utf-8").decode(b)); } catch (e) {}
            if (!f || f.format !== "keo-account-export") problems.push("format.json does not identify a keo account export.");
            else if (f.version !== 1) problems.push("This export is version " + f.version + "; this app only understands version 1.");
          });
        });

        chain = chain.then(function () {
          if (last.path !== "manifest.json") {
            problems.push("The archive has no manifest.json at the end: the download is incomplete.");
            return null;
          }
          return readBytes(file, last.offset, last.offset + last.size).then(function (b) {
            try { out.manifest = JSON.parse(new TextDecoder("utf-8").decode(b)); }
            catch (e) { problems.push("manifest.json is not valid JSON."); }
          });
        });

        chain = chain.then(function () {
          var m = out.manifest;
          if (!m || !Array.isArray(m.entries)) return;
          out.counts = m.counts || null;
          (m.warnings || []).forEach(function (w) { warnings.push("Noted by the server: " + w); });

          var listed = {};
          m.entries.forEach(function (e) { listed[e.path] = true; });
          entries.forEach(function (e) {
            if (e.path !== "manifest.json" && !listed[e.path]) problems.push("The archive contains " + e.path + ", which the manifest does not list.");
          });

          var i = 0;
          function next() {
            if (i >= m.entries.length) return Promise.resolve();
            var want = m.entries[i++];
            if (i % 10 === 0 || i === m.entries.length) progress("Checking " + i + " of " + m.entries.length + "…");
            var got = byPath[want.path];
            if (!got) { problems.push("Missing from the archive: " + want.path); return next(); }
            if (got.size !== want.size) { problems.push(want.path + " is " + got.size + " bytes; the manifest says " + want.size + "."); return next(); }
            if (got.size > MAX_HASH_BYTES) {
              warnings.push(want.path + " is too large to hash in the browser; only its size was checked.");
              return next();
            }
            return sha256Hex(file, got.offset, got.size).then(function (h) {
              if (h !== want.sha256) problems.push(want.path + " is corrupted (its SHA-256 does not match the manifest).");
              return next();
            });
          }
          return next();
        });

        return chain.then(function () {
          out.ok = problems.length === 0;
          return out;
        });
      });
    }

    // Disagreements between the file's manifest and what the server says the
    // account holds right now. Blobs the server lists but could not read are
    // recorded in the manifest's warnings, so they're accounted for here.
    function compareWithSummary(manifest, summary) {
      var diffs = [];
      if (!manifest || !summary || !manifest.counts) return diffs;
      var c = manifest.counts;
      if (c.objects !== summary.objects) diffs.push("The file has " + c.objects + " objects; your account now has " + summary.objects + ". Download a fresh copy.");
      if (c.versions !== summary.versions) diffs.push("The file has " + c.versions + " saved versions; your account now has " + summary.versions + ". Download a fresh copy.");
      var missing = (manifest.warnings || []).filter(function (w) { return /referenced but missing/.test(w); }).length;
      if (c.blobs + missing !== summary.blobs) diffs.push("The file has " + c.blobs + " files; your account now references " + summary.blobs + ". Download a fresh copy.");
      if (c.files !== summary.files) diffs.push("The file has " + c.files + " legacy files; your account now has " + summary.files + ". Download a fresh copy.");
      return diffs;
    }

    lively.identity.KeoReader = {
      scan: scan,
      verify: verify,
      compareWithSummary: compareWithSummary,
      MAX_HASH_BYTES: MAX_HASH_BYTES,
    };

  });
