/**
 * lively.music.PlaylistIO
 *
 * Pure (DOM-free, network-free) logic for importing and exporting playlists:
 *   - parse():   CSV / plain-text list  ->  rows { title, artist, album, group, ... }
 *   - rank():    one parsed row + catalog search results  ->  { status, hit, note }
 *   - toCsv() / toText():  a playlist's tracks  ->  file contents
 * Music.js owns the UI and the catalog calls; keeping this separate means it
 * can be exercised against real exported files without a browser.
 *
 * Input shapes seen in real transfer-tool files (see music-template.md §0.7):
 *   - header `Track name,Artist name,Album,Playlist name,Type,ISRC` plus ONE
 *     service-specific id column appended last (`Apple - id`, `Spotify - id`);
 *   - a video-sourced file has the whole `Artist - Title` in the track column
 *     and empty artist/album cells;
 *   - collaborations in the artist cell are joined by ` & ` or `, `;
 *   - one file can hold several playlists (the `Playlist name` column).
 */

module("lively.music.PlaylistIO")
  .requires()
  .toRun(function () {
    var MAX_ROWS = 2000; // ~1 MB of inline entries, saves in under a second
    var QUAL_RE = /\b(remix|edit|live|instrumental|acoustic|demo|karaoke|a cappella|acapella|sped up|slowed|reverb)\b/g;

    function qualsIn(text) {
      var out = {};
      var m;
      var re = new RegExp(QUAL_RE.source, "g");
      while ((m = re.exec(String(text).toLowerCase()))) out[m[1]] = true;
      return out;
    }
    function sameSet(a, b) {
      var ka = Object.keys(a).sort().join("|");
      var kb = Object.keys(b).sort().join("|");
      return ka === kb;
    }

    Object.extend(lively.music.PlaylistIO, {
      MAX_ROWS: MAX_ROWS,

      // lowercase, drop diacritics, drop (..)/[..] and a trailing feat clause,
      // remove apostrophes without inserting a space, & -> and, strip the rest.
      norm: function (x) {
        return String(x || "")
          .normalize("NFKD").replace(/[̀-ͯ]/g, "")
          .toLowerCase()
          .replace(/\(.*?\)|\[.*?\]/g, " ")
          .replace(/\b(feat|ft|featuring)\.?\s.*$/, " ")
          .replace(/['’]/g, "")
          .replace(/&/g, " and ")
          .replace(/[^a-z0-9 ]+/g, " ")
          .replace(/\s+/g, " ")
          .trim();
      },

      lev: function (a, b) {
        var m = a.length, n = b.length;
        if (!m) return n;
        if (!n) return m;
        var prev = [], j, i;
        for (j = 0; j <= n; j++) prev.push(j);
        for (i = 1; i <= m; i++) {
          var cur = [i];
          for (j = 1; j <= n; j++) cur.push(Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)));
          prev = cur;
        }
        return prev[n];
      },

      // A title split into its comparable base and its version qualifiers
      // (remix / live / edit / ...). Qualifiers are KEPT, not discarded, so a
      // remix row can't silently bind to the original recording: they come
      // from parentheses, brackets and a ` - Something Remix` suffix.
      titleParts: function (title) {
        var t = String(title || "");
        var removed = [];
        var s = t.replace(/\((?:[^()]|\([^()]*\))*\)|\[[^\]]*\]/g, function (m) { removed.push(m); return " "; });
        s = s.replace(/\s[-–—]\s(.+)$/, function (m, rest) {
          if (new RegExp(QUAL_RE.source).test(rest.toLowerCase())) { removed.push(rest); return " "; }
          return m;
        });
        return { base: this.norm(s), quals: qualsIn(removed.join(" ")) };
      },

      // Splits a CSV artist cell ("A, B & C" / "A; B") into comparable names.
      artistNames: function (cell) {
        var self = this;
        var parts = String(cell || "").split(/\s*(?:;|,|&|\band\b|·|\bfeat\.?|\bft\.?|\bwith\b|\bx\b)\s*/i);
        var out = [];
        parts.concat([cell]).forEach(function (p) {
          var n = self.norm(p);
          if (n && out.indexOf(n) === -1) out.push(n);
        });
        return out;
      },

      artistOk: function (itemArtist, candArtist) {
        if (!String(itemArtist || "").trim()) return true;
        var a = this.artistNames(itemArtist), b = this.artistNames(candArtist);
        return a.some(function (x) {
          return b.some(function (y) {
            return x === y || (x.length > 3 && y.length > 3 && (x.indexOf(y) !== -1 || y.indexOf(x) !== -1));
          });
        });
      },

      parseCsv: function (text) {
        var rows = [], row = [], cur = "", q = false, i, c;
        for (i = 0; i < text.length; i++) {
          c = text[i];
          if (q) {
            if (c === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c;
          } else if (c === '"') q = true;
          else if (c === ",") { row.push(cur); cur = ""; }
          else if (c === "\n" || c === "\r") {
            if (c === "\r" && text[i + 1] === "\n") i++;
            row.push(cur); cur = "";
            if (row.some(function (x) { return x.trim() !== ""; })) rows.push(row);
            row = [];
          } else cur += c;
        }
        row.push(cur);
        if (row.some(function (x) { return x.trim() !== ""; })) rows.push(row);
        return rows;
      },

      // "Artist - Title" / "Artist · Guest - Title (feat. Guest)" -> { artist, title } | null
      splitCombined: function (t) {
        var m = String(t).match(/^(.+?)\s[-–—]\s(.+)$/);
        if (!m) return null;
        return { artist: m[1].split(/\s·\s/)[0].trim(), title: m[2].trim() };
      },

      // opts: { format: 'auto'|'csv'|'text', order: 'artist-title'|'title-artist' }
      // Returns { mode, items, groups, detected, idKind, truncated }.
      // Every group in the file is imported (one playlist per group).
      parse: function (rawText, opts) {
        opts = opts || {};
        var format = opts.format || "auto";
        var order = opts.order || "artist-title";
        var text = String(rawText || "").replace(/^﻿/, "");
        var empty = { mode: "none", items: [], groups: [], detected: "", idKind: null, truncated: 0 };
        if (!text.trim()) return empty;

        var items, mode, detected, idKind = null;
        var self = this;

        if (format !== "text") {
          var rows = this.parseCsv(text);
          var lc = (rows[0] || []).map(function (x) { return x.trim().toLowerCase(); });
          var find = function (names) { return lc.findIndex(function (h) { return names.indexOf(h) >= 0; }); };
          var ti = find(["track name", "track", "title", "song", "song name", "track title", "name"]);
          var ai = find(["artist name(s)", "artist name", "artist", "artists", "artist(s)"]);
          var bi = find(["album name", "album", "album title"]);
          var gi = find(["playlist name", "playlist"]);
          var ci = find(["isrc"]);
          var di = find(["apple - id"]);
          var hasHeader = ti >= 0 && ai >= 0 && ti !== ai;
          if (hasHeader || format === "csv") {
            var T = hasHeader ? ti : 0, A = hasHeader ? ai : 1, B = hasHeader ? bi : 2, G = hasHeader ? gi : -1;
            var body = hasHeader ? rows.slice(1) : rows;
            items = body.map(function (r) {
              var title = (r[T] || "").trim();
              var artistFull = (r[A] || "").trim();
              var artist = artistFull.split(";")[0].trim();
              var wasSplit = false;
              if (!artist) {
                var sp = self.splitCombined(title);
                if (sp) { artist = sp.artist; artistFull = sp.artist; title = sp.title; wasSplit = true; }
              }
              var appleId = di >= 0 ? (r[di] || "").trim() : "";
              return {
                line: r.join(","), title: title, artist: artist, artistFull: artistFull,
                album: B >= 0 ? (r[B] || "").trim() : "", group: G >= 0 ? (r[G] || "").trim() : "",
                wasSplit: wasSplit, isrc: ci >= 0 ? (r[ci] || "").trim() : "",
                appleId: /^\d+$/.test(appleId) ? appleId : "",
              };
            });
            if (items.some(function (it) { return it.appleId; })) idKind = "apple";
            mode = "csv";
            var cols = hasHeader
              ? "“" + rows[0][ti].trim() + "” as the title, “" + rows[0][ai].trim() + "” as the artist" + (bi >= 0 ? ", “" + rows[0][bi].trim() + "” as the album" : "")
              : "columns read as title, artist, album";
            var nSplit = items.filter(function (it) { return it.wasSplit; }).length;
            detected = "Detected CSV · " + items.length + (items.length === 1 ? " row" : " rows") + " · " + cols +
              (nSplit ? " · artist read from “Artist - Title” in " + nSplit + (nSplit === 1 ? " row" : " rows") : "");
          }
        }
        if (!items) {
          var lines = text.split(/\r?\n/).map(function (l) { return l.trim(); }).filter(function (l) { return l !== ""; });
          items = lines.map(function (l) {
            var line = l.replace(/^\d+[\.\)]\s+/, "");
            var a = "", t = line;
            var m = line.match(/^(.+?)\s[-–—]\s(.+)$/);
            if (m) {
              if (order === "artist-title") { a = m[1]; t = m[2]; } else { t = m[1]; a = m[2]; }
            } else {
              var by = line.match(/^(.+?)\s+by\s+(.+)$/i);
              if (by) { t = by[1]; a = by[2]; }
            }
            return { line: l, title: t.trim(), artist: a.trim(), artistFull: a.trim(), album: "", group: "", wasSplit: false, isrc: "", appleId: "" };
          });
          mode = "text";
          detected = "Detected text · " + items.length + (items.length === 1 ? " line" : " lines");
        }

        var truncated = Math.max(0, items.length - MAX_ROWS);
        if (truncated) items = items.slice(0, MAX_ROWS);
        items.forEach(function (it, i) { it.index = i; });

        var names = [];
        items.forEach(function (it) { if (names.indexOf(it.group) === -1) names.push(it.group); });
        var groups = names.map(function (n) {
          return { key: n, name: n, count: items.filter(function (it) { return it.group === n; }).length };
        });
        if (idKind === "apple") detected += " · Apple ids found, matching exactly by id";
        return { mode: mode, items: items, groups: groups, detected: detected, idKind: idKind, truncated: truncated };
      },

      // The search term for one row: artist + title with parentheticals and a
      // feat clause stripped (those hurt recall and the ranker re-checks them).
      queryFor: function (item) {
        var title = String(item.title || "")
          .replace(/\((?:[^()]|\([^()]*\))*\)|\[[^\]]*\]/g, " ")
          .replace(/\s[-–—]\s.*$/, " ")
          .replace(/\b(feat|ft|featuring)\.?\s.*$/i, " ");
        var artist = item.artist || "";
        return (artist + " " + title).replace(/\s+/g, " ").trim();
      },

      // Ranks catalog song results (raw rows with trackName / artistName /
      // collectionName) for one parsed row. Returns { status, hit, note } with
      // status 'ok' | 'check' | 'miss'.
      //   ok     same base title, artist agrees, same version qualifiers
      //   check  same title but a different artist or a different version
      //          (remix/live/...), or a near-miss spelling with the right artist
      //   miss   nothing close
      // An exact title with the WRONG artist must never be 'ok'.
      rank: function (item, rows) {
        var self = this;
        var title = String(item.title || "").trim();
        if (!title) return { status: "miss", hit: null, note: "No title on this line" };
        var it = this.titleParts(title);
        var albumN = this.norm(String(item.album || "").replace(/\s[-–—]\s(single|ep)$/i, ""));
        var artist = item.artistFull || item.artist || "";
        var cands = (rows || []).map(function (row, idx) {
          var cp = self.titleParts(row.trackName);
          var titleEq = cp.base === it.base && it.base !== "";
          var close = !titleEq && it.base.length >= 4 && cp.base.length >= 1 &&
            self.lev(it.base, cp.base) <= Math.max(1, Math.round(it.base.length * 0.2));
          var artistOk = self.artistOk(artist, row.artistName);
          var qualEq = sameSet(it.quals, cp.quals);
          var albumEq = !!albumN && self.norm(String(row.collectionName || "").replace(/\s[-–—]\s(single|ep)$/i, "")) === albumN;
          var score = (titleEq ? 8 : (close ? 3 : 0)) + (artistOk ? 4 : 0) + (qualEq ? 2 : 0) + (albumEq ? 1 : 0);
          return { row: row, idx: idx, titleEq: titleEq, close: close, artistOk: artistOk, qualEq: qualEq, score: score };
        });
        cands.sort(function (a, b) { return b.score - a.score || a.idx - b.idx; });
        var top = cands[0];
        if (!top) return { status: "miss", hit: null, note: "Not in the catalog" };
        if (top.titleEq && top.artistOk && top.qualEq) return { status: "ok", hit: top.row, note: "Matched on title and artist" };
        if (top.titleEq && top.artistOk) {
          var a = Object.keys(it.quals), b = Object.keys(self.titleParts(top.row.trackName).quals);
          return { status: "check", hit: top.row, note: "Different version: " + (b.join(", ") || "original") + " (you have " + (a.join(", ") || "original") + ")" };
        }
        var sameTitle = cands.filter(function (c) { return c.titleEq; })[0];
        if (sameTitle) return { status: "check", hit: sameTitle.row, note: "Same title, different artist: " + sameTitle.row.artistName };
        if (top.close && top.artistOk) return { status: "check", hit: top.row, note: "Close match, check the spelling" };
        return { status: "miss", hit: null, note: "Not in the catalog" };
      },

      // ---- export ---------------------------------------------------------
      csvCell: function (v) { return '"' + String(v == null ? "" : v).replace(/"/g, '""') + '"'; },

      // tracks: playlist entries { title, artist, albumTitle }. Same header
      // as a transfer-tool export so the file round-trips through parse().
      toCsv: function (playlistName, tracks) {
        var self = this;
        var lines = ["Track name,Artist name,Album,Playlist name,Type,ISRC"];
        tracks.forEach(function (t) {
          lines.push([t.title, t.artist, t.albumTitle || "", playlistName, "Playlist", ""].map(self.csvCell).join(","));
        });
        return lines.join("\n");
      },

      toText: function (tracks) {
        return tracks.map(function (t) { return t.artist + " - " + t.title; }).join("\n");
      },

      slug: function (name) {
        return String(name || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "playlist";
      },
    });
  }); // end module('lively.music.PlaylistIO')
