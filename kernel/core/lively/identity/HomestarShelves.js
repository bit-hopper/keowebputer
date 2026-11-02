/**
 * lively.identity.HomestarShelves
 *
 * The small cards in the row under the homestar's columns: Sky tonight and the
 * most recent wiki pages. Each card is described by {h, build(x, y, w, h)}: its
 * height is known up front (a card with nothing to show is simply not described),
 * so layout() can work out the auto-fit grid first and each panel is then built at
 * its final rect, as the page's other panels are (rebuilt on every
 * Homestar._render, like the worlds panel).
 *
 * Plain functions on a namespace object, so callers do not depend on a closure.
 */

module("lively.identity.HomestarShelves")
  .requires(
    "lively.identity.HomestarUI",
    "lively.identity.SkyWidget",
    "lively.transit.BartData",
    "lively.morphic.Complete",
  )
  .toRun(function () {

    var UI = lively.identity.HomestarUI;
    var PINK = UI.PINK, PINK_SOFT = UI.PINK_SOFT;
    var INK = UI.INK, MUTED = UI.MUTED;
    var noDrag = UI.noDrag, trunc = UI.trunc;
    var label = UI.label, icon = UI.icon, panel = UI.panel;

    var CARD_MIN_W = 290;
    var SKY_H = 150;
    var WIKI_MAX = 6, WIKI_ROW_H = 34;
    var GUEST_SHOWN = 3, GUEST_ROW_H = 58;
    var GUEST_PER_WINDOW = 5, GUEST_WINDOW_HOURS = 36;   // what the server allows one guest
    var TRANSIT_MAX = 3, TRANSIT_ROWS_Y = 68, TRANSIT_ROW_H = 28;

    var SIGNS  = ["Aries", "Taurus", "Gemini", "Cancer", "Leo", "Virgo",
                  "Libra", "Scorpio", "Sagittarius", "Capricorn", "Aquarius", "Pisces"];
    var GLYPHS = ["♈︎", "♉︎", "♊︎", "♋︎", "♌︎", "♍︎", "♎︎", "♏︎", "♐︎", "♑︎", "♒︎", "♓︎"];

    // The moon as an SVG: a dark disc with the lit part drawn over it. The lit side
    // is the right when waxing and the left when waning. The terminator is an
    // ellipse arc whose half-width is |cos(2 pi f)| of the radius; it bulges toward
    // the lit side for a crescent and away from it for a gibbous.
    function moonSvg(fraction, size) {
      var r = size / 2 - 2, c = size / 2;
      var k = Math.cos(fraction * 2 * Math.PI);
      var rx = Math.abs(k) * r;
      var waxing = fraction <= 0.5;
      var lit = "";
      if (Math.abs(fraction - 0.5) < 0.0001) {
        lit = '<circle cx="' + c + '" cy="' + c + '" r="' + r + '" fill="#f4e9c8"/>';
      } else if (fraction >= 0.005 && fraction <= 0.995) {
        lit = '<path d="M ' + c + ' ' + (c - r) + ' A ' + r + ' ' + r + ' 0 0 1 ' + c + ' ' + (c + r) +
          ' A ' + rx.toFixed(2) + ' ' + r + ' 0 0 ' + (k > 0 ? 0 : 1) + ' ' + c + ' ' + (c - r) + ' Z" fill="#f4e9c8"' +
          (waxing ? "" : ' transform="translate(' + size + ' 0) scale(-1 1)"') + '/>';
      }
      var svg = '<svg xmlns="http://www.w3.org/2000/svg" width="' + size + '" height="' + size + '" viewBox="0 0 ' + size + ' ' + size + '">' +
        '<circle cx="' + c + '" cy="' + c + '" r="' + r + '" fill="#2b2547"/>' + lit +
        '<circle cx="' + c + '" cy="' + c + '" r="' + r + '" fill="none" stroke="#cfc6e6" stroke-width="1"/></svg>';
      return "data:image/svg+xml;utf8," + encodeURIComponent(svg);
    }

    function dayWord(n) {
      n = Math.round(n);
      return n <= 0 ? "today" : (n === 1 ? "in 1 day" : "in " + n + " days");
    }

    // "3 days ago" style age from an ISO timestamp.
    function agoLabel(iso, now) {
      var t = Date.parse(iso);
      if (!isFinite(t)) return "";
      var s = Math.max(0, ((now || Date.now()) - t) / 1000);
      if (s < 90) return "just now";
      var m = Math.round(s / 60);
      if (m < 60) return m + " min ago";
      var h = Math.round(m / 60);
      if (h < 24) return h + (h === 1 ? " hour ago" : " hours ago");
      var d = Math.round(h / 24);
      if (d < 14) return d + (d === 1 ? " day ago" : " days ago");
      var w = Math.round(d / 7);
      if (w < 9) return w + " weeks ago";
      var mo = Math.round(d / 30);
      if (mo < 18) return mo + (mo === 1 ? " month ago" : " months ago");
      return Math.round(d / 365) + " years ago";
    }

    // ─── On the shelf: book spines and the record on the turntable ──────────────

    var SHELF_SIDE_MIN_W = 380;       // wide enough for spines and the vinyl side by side
    var SPINE_COLORS = ["#7a3b5e", "#3f5d7d", "#5b7a4f", "#8a5a2b", "#5a4a86", "#2f6f6d", "#a14b4b", "#6b6b3a"];
    var VINYL_D = 84, VINYL_SECONDS = 6;
    var MAX_BOOK_FETCH = 24, MAX_ALBUM_FETCH = 12;
    var T0 = Date.now();              // the record's phase is kept across the page's re-renders

    function safeUrl(u) {
      u = String(u || "").trim();
      return /^(https?:\/\/|\/(?!\/))/i.test(u) ? u : null;
    }

    function hashOf(s) {
      var h = 0;
      s = String(s);
      for (var i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
      return h;
    }

    function xmlEsc(s) {
      return String(s).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; });
    }

    function svgUrl(svg) { return "data:image/svg+xml;utf8," + encodeURIComponent(svg); }

    // One book's spine: a colour picked from the title, two light bands, the title
    // running down it, and a pink dot when the owner is reading it now.
    function spineSpec(book, maxH) {
      var h = hashOf(book.title || "?");
      return { w: 18 + (h % 8), h: maxH - 6 - (((h >>> 4) % 4) * 7), color: SPINE_COLORS[(h >>> 8) % SPINE_COLORS.length] };
    }

    function spineSvg(book, w, h, color) {
      var maxChars = Math.max(3, Math.floor((h - 32) / 5.2));
      var title = trunc(book.title || "Untitled", maxChars);
      var reading = book.shelf === "reading";
      return svgUrl('<svg xmlns="http://www.w3.org/2000/svg" width="' + w + '" height="' + h + '" viewBox="0 0 ' + w + " " + h + '">' +
        '<rect width="' + w + '" height="' + h + '" rx="2" fill="' + color + '"/>' +
        '<rect x="0" y="6" width="' + w + '" height="2" fill="#fff" fill-opacity="0.35"/>' +
        '<rect x="0" y="10" width="' + w + '" height="1" fill="#fff" fill-opacity="0.2"/>' +
        '<text transform="translate(' + (w / 2) + ' 18) rotate(90)" dominant-baseline="middle" font-family="sans-serif" ' +
        'font-size="9" font-weight="600" fill="#fff">' + xmlEsc(title) + '</text>' +
        (reading ? '<circle cx="' + (w / 2) + '" cy="' + (h - 8) + '" r="2.6" fill="#ff9ec4"/>'
                 : '<rect x="0" y="' + (h - 8) + '" width="' + w + '" height="2" fill="#fff" fill-opacity="0.35"/>') +
        '</svg>');
    }

    // A record seen from above: dark disc, grooves, two sheen arcs so the turning
    // shows, and a pink label (the album's cover is laid over it).
    function vinylSvg() {
      return svgUrl('<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100" viewBox="0 0 100 100">' +
        '<circle cx="50" cy="50" r="49" fill="#1d1b26"/>' +
        '<circle cx="50" cy="50" r="44" fill="none" stroke="#34314a" stroke-width="0.8"/>' +
        '<circle cx="50" cy="50" r="38" fill="none" stroke="#34314a" stroke-width="0.8"/>' +
        '<circle cx="50" cy="50" r="32" fill="none" stroke="#34314a" stroke-width="0.8"/>' +
        '<path d="M 50 9 A 41 41 0 0 1 91 50" fill="none" stroke="#fff" stroke-opacity="0.2" stroke-width="3" stroke-linecap="round"/>' +
        '<path d="M 50 91 A 41 41 0 0 1 9 50" fill="none" stroke="#fff" stroke-opacity="0.2" stroke-width="3" stroke-linecap="round"/>' +
        '<circle cx="50" cy="50" r="19" fill="#e8497e"/></svg>');
    }

    function ensureShelfStyle() {
      if (document.getElementById("homestar-shelf-style")) return;
      var s = document.createElement("style");
      s.id = "homestar-shelf-style";
      s.textContent = "@keyframes homestar-vinyl-spin{from{transform:rotate(0deg)}to{transform:rotate(360deg)}}" +
        "@media (prefers-reduced-motion: reduce){.homestar-vinyl-spin{animation:none!important}}";
      document.head.appendChild(s);
    }

    function openWorld(handle, objId) {
      window.location.href = "/@" + encodeURIComponent(handle) + "/" + encodeURIComponent(objId);
    }

    var OBJ_ID = /^[A-Za-z0-9_-]{6,64}$/;

    // The library folder a Books or Music world keeps its things in: the world's
    // saved morph carries its id as a plain property. Calls thenDo(folderEnvelope |
    // null, worldPayloadText). Only an object of this account counts.
    function worldLibrary(prefix, handle, did, world, thenDo) {
      UI.getJSON("/@" + encodeURIComponent(handle) + "/" + encodeURIComponent(world.objId), function (err, env) {
        var payload = env && env.record && env.record.payload;
        var text = payload && typeof payload === "object" ? JSON.stringify(payload) : "";
        var m = text.match(new RegExp('"' + prefix + 'LibraryObjId":"([^"]+)"'));
        if (!m || !OBJ_ID.test(m[1])) return thenDo(null, text);
        UI.getJSON("/@" + encodeURIComponent(handle) + "/" + encodeURIComponent(m[1]), function (err2, folder) {
          var ok = folder && folder.type === "folder" && folder.did === did && folder.visibility === "public" &&
            folder.record && folder.record.payload && Array.isArray(folder.record.payload.files);
          thenDo(ok ? folder : null, text);
        });
      });
    }

    // Fetches the objects a library's pointers name, newest pointer first, keeping
    // that order, skipping any that are deleted, of another type or another account.
    // Calls thenDo([payload, ...]).
    function fetchPointed(handle, did, folder, refType, type, limit, thenDo) {
      var ptrs = folder.record.payload.files
        .filter(function (f) { return f && f.refType === refType && OBJ_ID.test(String(f.refObjId)); })
        .reverse().slice(0, limit);
      if (!ptrs.length) return thenDo([]);
      var out = new Array(ptrs.length), left = ptrs.length;
      ptrs.forEach(function (p, i) {
        UI.getJSON("/@" + encodeURIComponent(handle) + "/" + encodeURIComponent(p.refObjId), function (err, env) {
          if (env && env.type === type && env.did === did && !(env.state && env.state.deleted) &&
              env.record && env.record.payload && typeof env.record.payload === "object") {
            out[i] = env.record.payload;
          }
          if (--left === 0) thenDo(out.filter(Boolean));
        });
      });
    }

    function header(box, w, iconName, title) {
      box.addMorph(icon(lively.rect(16, 14, 22, 22), iconName, 18, PINK));
      box.addMorph(label(lively.rect(44, 14, w - 60, 22), title, { px: 15, bold: true }));
    }

    lively.identity.HomestarShelves = {
      CARD_MIN_W: CARD_MIN_W,
      moonSvg: moonSvg,
      agoLabel: agoLabel,

      // Sky tonight: the moon now (phase picture, name, share lit, the next full or
      // new moon) and the profile's sun, moon and rising signs when it has them.
      // Computed in the browser; needs no server.
      sky: function (profile, now) {
        return { h: SKY_H, build: function (x, y, w, h) {
          return lively.identity.HomestarShelves._skyPanel(x, y, w, h, profile || {}, now);
        } };
      },

      _skyPanel: function (x, y, w, h, profile, now) {
        var astro = lively.identity.SkyWidget._astro;
        var mp = astro.moonPhase(now || new Date());
        var box = panel(lively.rect(x, y, w, h));
        header(box, w, "dark_mode", "Sky tonight");

        var MOON = 64;
        var img = new lively.morphic.Image(lively.rect(16, 52, MOON, MOON));
        img.setImageURL(moonSvg(mp.fraction, MOON));
        img.applyStyle({ borderWidth: 0, fill: null });
        noDrag(img);
        img.eventsAreIgnored = true;
        box.addMorph(img);

        var tx = 16 + MOON + 14, tw = w - tx - 16;
        var toFull = astro.daysToPhase(mp, 0.5), toNew = astro.daysToPhase(mp, 0);
        var next = toFull < toNew ? "Full moon " + dayWord(toFull) : "New moon " + dayWord(toNew);
        box.addMorph(label(lively.rect(tx, 54, tw, 22), mp.name, { px: 15, bold: true }));
        box.addMorph(label(lively.rect(tx, 76, tw, 18), Math.round(mp.illumination * 100) + "% lit", { px: 12, color: MUTED }));
        box.addMorph(label(lively.rect(tx, 94, tw, 18), next, { px: 12, color: MUTED }));

        var signs = [["☉", profile.sunSign], ["☽", profile.moonSign], ["↑", profile.risingSign]]
          .map(function (pair) {
            var i = SIGNS.indexOf(pair[1]);
            return i >= 0 ? pair[0] + " " + GLYPHS[i] + " " + SIGNS[i] : null;
          }).filter(Boolean);
        if (signs.length) {
          box.addMorph(label(lively.rect(16, 122, w - 32, 18), signs.join("   "), { px: 12, color: INK }));
        }
        return box;
      },

      // The newest few wiki pages, each a link to the page; null when there are none (the
      // owner who hid every page still gets the card, with a line pointing at Manage).
      // pages: GET /@handle/wiki-card rows { objId, wikiName, updatedAt, createdAt }.
      // opts: { isOwner, hiddenCount, onManage() }.
      wiki: function (handle, pages, opts) {
        opts = opts || {};
        var rows = (pages || []).filter(function (p) { return p && p.wikiName; })
          .sort(function (a, b) { return Date.parse(b.updatedAt) - Date.parse(a.updatedAt); })
          .slice(0, WIKI_MAX);
        var allHidden = !rows.length && opts.isOwner && opts.hiddenCount > 0;
        if (!rows.length && !allHidden) return null;
        return { h: 48 + Math.max(1, rows.length) * WIKI_ROW_H + 10, build: function (x, y, w, h) {
          return lively.identity.HomestarShelves._wikiPanel(x, y, w, h, handle, rows, opts);
        } };
      },

      _wikiPanel: function (x, y, w, h, handle, rows, opts) {
        var box = panel(lively.rect(x, y, w, h));
        box.addMorph(icon(lively.rect(16, 14, 22, 22), "menu_book", 18, PINK));
        box.addMorph(label(lively.rect(44, 14, w - 60 - (opts.isOwner ? 80 : 0), 22), "Wiki pages", { px: 15, bold: true }));
        if (opts.isOwner) {
          var manage = UI.pill(0, 0, "Manage", { w: 72, h: 26, onClick: function () { opts.onManage(); } });
          manage.setPosition(lively.pt(w - 16 - 72, 11));
          box.addMorph(manage);
        }
        if (!rows.length) {
          box.addMorph(label(lively.rect(16, 50, w - 32, 20), "Nothing is shown. Use Manage to choose pages.", { px: 13, color: MUTED }));
        }
        rows.forEach(function (p, i) {
          var row = new lively.morphic.Box(lively.rect(8, 46 + i * WIKI_ROW_H, w - 16, WIKI_ROW_H - 4));
          row.applyStyle({ fill: null, borderWidth: 0, borderRadius: 8, clipMode: "hidden", handStyle: "pointer" });
          noDrag(row);
          row.addMorph(label(lively.rect(8, 4, w - 16 - 16 - 96, 20), trunc(p.wikiName, 30), { px: 13, bold: true }));
          row.addMorph(label(lively.rect(w - 16 - 8 - 96, 5, 96, 18), agoLabel(p.updatedAt), { px: 11, color: MUTED, align: "right" }));
          row.onMouseOver = function () { row.applyStyle({ fill: PINK_SOFT }); };
          row.onMouseOut  = function () { row.applyStyle({ fill: null }); };
          row.onMouseUp = function (evt) {
            evt.stop();
            window.location.href = "/@" + encodeURIComponent(handle) + "/wiki/" + encodeURIComponent(p.wikiName);
            return true;
          };
          box.addMorph(row);
        });
        return box;
      },

      // The books of the account's Books world, as their saved payloads (title,
      // author, shelf, ...), the ones being read first, then the rest newest first.
      // world: the account's Books world as GET /worlds lists it (the first the
      // viewer may open). Calls thenDo([]) when there is none or it cannot be read.
      loadBooks: function (handle, did, world, thenDo) {
        if (!world) return thenDo([]);
        worldLibrary("books", handle, did, world, function (folder) {
          if (!folder) return thenDo([]);
          fetchPointed(handle, did, folder, "book", "book", MAX_BOOK_FETCH, function (books) {
            var reading = books.filter(function (b) { return b.shelf === "reading"; });
            var rest = books.filter(function (b) { return b.shelf !== "reading"; });
            thenDo(reading.concat(rest));
          });
        });
      },

      // The album on the owner's turntable: the newest one on the "Listening" shelf,
      // else the newest "Listened". Calls thenDo(null | {album, spinning}). A library
      // its owner made private shows to the owner alone.
      loadAlbum: function (handle, did, world, isOwner, thenDo) {
        if (!world) return thenDo(null);
        worldLibrary("music", handle, did, world, function (folder, worldText) {
          if (!folder) return thenDo(null);
          if (!isOwner && /"musicLibPublic":false/.test(worldText)) return thenDo(null);
          fetchPointed(handle, did, folder, "album", "album", MAX_ALBUM_FETCH, function (albums) {
            var now = albums.filter(function (a) { return a.shelf === "listening"; })[0];
            var last = albums.filter(function (a) { return a.shelf === "listened"; })[0];
            thenDo(now ? { album: now, spinning: true } : (last ? { album: last, spinning: false } : null));
          });
        });
      },

      // On the shelf: the spines of the books (reading first, newest next) on a
      // plank, and the record on the turntable, spinning slowly. Each opens its
      // world. null when there is neither. opts: { handle, books, record,
      // booksWorld, musicWorld } (record from loadAlbum).
      shelf: function (opts) {
        var books = opts.books || [], rec = opts.record || null;
        if (!books.length && !rec) return null;
        return {
          h: function (w) {
            if (books.length && rec) return w >= SHELF_SIDE_MIN_W ? 204 : 246;
            return books.length ? 152 : 150;
          },
          build: function (x, y, w, h) {
            return lively.identity.HomestarShelves._shelfPanel(x, y, w, h, opts);
          },
        };
      },

      _shelfPanel: function (x, y, w, h, opts) {
        var books = opts.books || [], rec = opts.record || null, handle = opts.handle;
        var box = panel(lively.rect(x, y, w, h));
        header(box, w, "shelves", "On the shelf");
        var sideBySide = books.length > 0 && !!rec && w >= SHELF_SIDE_MIN_W;
        var VCOL = 130;

        if (books.length) {
          var maxH = sideBySide ? 112 : 84;
          var areaW = sideBySide ? w - 32 - VCOL : w - 32;
          var shelfY = 48 + maxH;
          var plank = new lively.morphic.Box(lively.rect(12, shelfY, areaW + 8, 4));
          plank.applyStyle({ fill: Color.rgb(217, 195, 165), borderWidth: 0, borderRadius: 2 });
          noDrag(plank);
          plank.eventsAreIgnored = true;
          box.addMorph(plank);
          var sx = 16;
          for (var i = 0; i < books.length; i++) {
            var b = books[i], sp = spineSpec(b, maxH);
            if (sx + sp.w > 16 + areaW) break;
            var img = new lively.morphic.Image(lively.rect(sx, shelfY - sp.h, sp.w, sp.h));
            img.setImageURL(spineSvg(b, sp.w, sp.h, sp.color));
            img.applyStyle({ borderWidth: 0, fill: null, handStyle: "pointer" });
            noDrag(img);
            img.toolTip = (b.title || "Untitled") + (b.author ? " — " + b.author : "") + (b.shelf === "reading" ? " (reading now)" : "");
            (function (worldId) {
              img.onMouseUp = function (evt) { evt.stop(); if (worldId) openWorld(handle, worldId); return true; };
            })(opts.booksWorld && opts.booksWorld.objId);
            box.addMorph(img);
            sx += sp.w + 3;
          }
        }

        if (rec) {
          ensureShelfStyle();
          var a = rec.album, D = VINYL_D;
          var vx, vy, tx, ty, tw, align;
          if (sideBySide) {
            vx = w - 16 - VCOL + Math.round((VCOL - D) / 2); vy = 52;
            tx = w - 16 - VCOL; ty = vy + D + 4; tw = VCOL; align = "center";
          } else if (books.length) {
            vx = 16; vy = 48 + 84 + 4 + 12;
            tx = 16 + D + 14; ty = vy + 10; tw = w - tx - 16; align = "left";
          } else {
            vx = 16; vy = 52;
            tx = 16 + D + 14; ty = vy + 10; tw = w - tx - 16; align = "left";
          }
          var vinyl = new lively.morphic.Box(lively.rect(vx, vy, D, D));
          vinyl.applyStyle({ fill: null, borderWidth: 0, clipMode: "visible", handStyle: "pointer" });
          noDrag(vinyl);
          var disc = new lively.morphic.Image(lively.rect(0, 0, D, D));
          disc.setImageURL(vinylSvg());
          disc.applyStyle({ borderWidth: 0, fill: null });
          noDrag(disc);
          disc.eventsAreIgnored = true;
          vinyl.addMorph(disc);
          var L = Math.round(D * 0.38);
          var coverUrl = safeUrl(a.coverUrl);
          if (coverUrl) {
            var cover = new lively.morphic.Image(lively.rect(Math.round((D - L) / 2), Math.round((D - L) / 2), L, L));
            cover.setImageURL(coverUrl);
            cover.applyStyle({ borderWidth: 0, fill: null, borderRadius: L / 2, clipMode: "hidden" });
            noDrag(cover);
            cover.eventsAreIgnored = true;
            vinyl.addMorph(cover);
            // a cover that will not load leaves the pink label showing
            setTimeout(function () {
              var el = cover.renderContext().shapeNode.querySelector("img");
              if (el) el.addEventListener("error", function () { el.style.display = "none"; });
            }, 0);
          }
          var hole = new lively.morphic.Box(lively.rect(Math.round(D / 2 - 3), Math.round(D / 2 - 3), 6, 6));
          hole.applyStyle({ fill: UI.PAGE_FILL, borderWidth: 0, borderRadius: 3 });
          noDrag(hole);
          hole.eventsAreIgnored = true;
          vinyl.addMorph(hole);
          var openMusic = function (evt) { evt.stop(); if (opts.musicWorld) openWorld(handle, opts.musicWorld.objId); return true; };
          vinyl.toolTip = (a.title || "Untitled") + (a.artist ? " — " + a.artist : "");
          vinyl.onMouseUp = openMusic;
          box.addMorph(vinyl);
          var node = vinyl.renderContext().shapeNode;
          node.classList.add("homestar-vinyl-spin");
          node.style.animation = "homestar-vinyl-spin " + VINYL_SECONDS + "s linear " +
            (-(((Date.now() - T0) / 1000) % VINYL_SECONDS)).toFixed(2) + "s infinite";

          var chars = Math.max(10, Math.floor(tw / 8));
          box.addMorph(label(lively.rect(tx, ty, tw, 16), rec.spinning ? "Now spinning" : "Last spun", { px: 11, color: PINK, bold: true, align: align }));
          box.addMorph(label(lively.rect(tx, ty + 16, tw, 20), trunc(a.title || "Untitled", chars), { px: 13, bold: true, align: align }));
          if (a.artist) box.addMorph(label(lively.rect(tx, ty + 36, tw, 18), trunc(a.artist, chars + 4), { px: 12, color: MUTED, align: align }));
        }
        return box;
      },

      // The guestbook: the newest entries (comments on the profile object), and a way
      // to sign it. null until the entries are known (opts.entries is null while
      // loading or when they could not be read). opts: { handle, entries, isOwner,
      // viewer, avatarFor(entry), onSign(), onSignIn(), onDelete(entry), onProfile(entry, rect) }
      // entry: { id, did, handle, body, createdAt }, newest first.
      guestbook: function (opts) {
        if (!opts.entries) return null;
        var n = Math.min(GUEST_SHOWN, opts.entries.length);
        var canSign = !opts.isOwner;
        var h = 48 + (n ? n * GUEST_ROW_H : 30) + (canSign ? 46 : 8) + (opts.entries.length > GUEST_SHOWN ? 20 : 0) + 10;
        return { h: h, build: function (x, y, w, hh) {
          return lively.identity.HomestarShelves._guestbookPanel(x, y, w, hh, opts);
        } };
      },

      _guestbookPanel: function (x, y, w, h, opts) {
        var box = panel(lively.rect(x, y, w, h));
        header(box, w, "draw", "Guestbook");
        var entries = opts.entries.slice(0, GUEST_SHOWN);
        var cy = 46;
        if (!entries.length) {
          box.addMorph(label(lively.rect(16, cy, w - 32, 20),
            opts.isOwner ? "Nobody has signed your guestbook yet." : "Nobody has signed it yet. Be the first.",
            { px: 13, color: MUTED }));
          cy += 30;
        }
        entries.forEach(function (e) {
          var row = new lively.morphic.Box(lively.rect(0, cy, w, GUEST_ROW_H));
          row.applyStyle({ fill: null, borderWidth: 0, clipMode: "hidden" });
          noDrag(row);

          var av = new lively.morphic.Image(lively.rect(16, 4, 28, 28));
          av.setImageURL(opts.avatarFor(e));
          av.applyStyle({ borderRadius: 14, borderWidth: 0, clipMode: "hidden", handStyle: "pointer" });
          noDrag(av);
          av.toolTip = e.handle ? "@" + e.handle : "";
          av.onMouseUp = function (evt) {
            evt.stop();
            if (e.handle && opts.onProfile) opts.onProfile(e, av.renderContext().shapeNode.getBoundingClientRect());
            return true;
          };
          row.addMorph(av);

          var canDelete = opts.isOwner || (opts.viewer && opts.viewer.did === e.did);
          var right = canDelete ? 30 : 16;
          row.addMorph(label(lively.rect(52, 2, w - 52 - right - 84, 18), e.handle ? "@" + trunc(e.handle, 22) : "someone", { px: 12, bold: true }));
          row.addMorph(label(lively.rect(w - right - 84, 3, 84, 16), agoLabel(e.createdAt), { px: 11, color: MUTED, align: "right" }));
          row.addMorph(label(lively.rect(52, 20, w - 52 - 16, 34), trunc(String(e.body || "").replace(/\s+/g, " "), 110), { px: 12, color: INK, wrap: true }));
          if (canDelete) {
            var del = new lively.morphic.Box(lively.rect(w - 28, 2, 22, 22));
            del.applyStyle({ fill: null, borderWidth: 0, borderRadius: 11, handStyle: "pointer" });
            noDrag(del);
            del.toolTip = opts.isOwner && !(opts.viewer && opts.viewer.did === e.did) ? "Remove this entry" : "Delete your entry";
            del.addMorph(icon(lively.rect(3, 3, 16, 16), "close", 14, MUTED));
            del.onMouseOver = function () { del.applyStyle({ fill: PINK_SOFT }); };
            del.onMouseOut  = function () { del.applyStyle({ fill: null }); };
            del.onMouseUp = function (evt) { evt.stop(); opts.onDelete(e); return true; };
            row.addMorph(del);
          }
          box.addMorph(row);
          cy += GUEST_ROW_H;
        });
        if (opts.entries.length > GUEST_SHOWN) {
          // the entries beyond the newest few are not listed here
          box.addMorph(label(lively.rect(16, h - 22, w - 32, 16), "Showing the newest " + GUEST_SHOWN + ".", { px: 11, color: MUTED }));
        }
        if (!opts.isOwner) {
          // the server allows a guest GUEST_PER_WINDOW entries in GUEST_WINDOW_HOURS; once the ones on the
          // page (the newest 20) use that up, say so instead of offering a button that would fail
          var since = (opts.now || Date.now()) - GUEST_WINDOW_HOURS * 3600 * 1000;
          var used = opts.viewer ? opts.entries.filter(function (e) {
            return e.did === opts.viewer.did && Date.parse(e.createdAt) > since;
          }).length : 0;
          if (used >= GUEST_PER_WINDOW) {
            box.addMorph(label(lively.rect(16, cy + 8, w - 32, 20), "You have left " + GUEST_PER_WINDOW + " entries recently. Come back later.", { px: 12, color: MUTED }));
          } else {
            var sign = UI.pill(0, 0, opts.viewer ? "Sign the guestbook" : "Sign in to sign the guestbook", {
              primary: true, h: 30, w: opts.viewer ? 150 : 210, onClick: function () { return opts.viewer ? opts.onSign() : opts.onSignIn(); },
            });
            sign.setPosition(lively.pt(16, cy + 4));
            box.addMorph(sign);
          }
        }
        return box;
      },

      // Transit: the next trains at the owner's BART station. opts: { station (code or
      // null), times (null while loading, else the predictions from TransitClient or
      // false when live times could not be had), isOwner, onManage() }. null when there
      // is nothing for this viewer to see: no station chosen (the owner gets a prompt
      // instead) or a code BartData does not know.
      transit: function (opts) {
        var B = lively.transit.BartData;
        var known = !!(opts.station && B.stations[opts.station]);
        if (!known && !opts.isOwner) return null;
        var rows = known ? lively.identity.HomestarShelves._nextTrains(opts.times, Date.now()) : [];
        // the station line, the rows (or one line of message), the source note
        var h = known ? TRANSIT_ROWS_Y + Math.max(1, rows.length) * TRANSIT_ROW_H + 32 : 112;
        return { h: h, build: function (x, y, w, hh) {
          return lively.identity.HomestarShelves._transitPanel(x, y, w, hh, opts, known, rows);
        } };
      },

      // The soonest arrivals, at most TRANSIT_MAX, with minutes counted from `now` (the
      // times were fetched a while ago). Each: { lineKey, destination, minutes }.
      _nextTrains: function (times, now) {
        if (!Array.isArray(times)) return [];
        return times.map(function (p) {
          var t = Date.parse(p.expectedArrival);
          var m = isFinite(t) ? Math.max(0, Math.round((t - now) / 60000)) : p.minutesAway;
          return { lineKey: p.lineKey, destination: p.destination || p.line || "", minutes: m };
        }).filter(function (p) { return typeof p.minutes === "number" && isFinite(p.minutes); })
          .sort(function (a, b) { return a.minutes - b.minutes; })
          .slice(0, TRANSIT_MAX);
      },

      _transitPanel: function (x, y, w, h, opts, known, rows) {
        var B = lively.transit.BartData;
        var box = panel(lively.rect(x, y, w, h));
        box.addMorph(icon(lively.rect(16, 14, 22, 22), "train", 18, PINK));
        box.addMorph(label(lively.rect(44, 14, w - 60 - (opts.isOwner ? 80 : 0), 22), "Transit", { px: 15, bold: true }));
        if (opts.isOwner) {
          var manage = UI.pill(0, 0, "Manage", { w: 72, h: 26, onClick: function () { opts.onManage(); } });
          manage.setPosition(lively.pt(w - 16 - 72, 11));
          box.addMorph(manage);
        }
        if (!known) {
          box.addMorph(label(lively.rect(16, 46, w - 32, 36), "Show the trains at your BART station. Use Manage to pick one.", { px: 13, color: MUTED, wrap: true }));
          return box;
        }
        box.addMorph(label(lively.rect(16, 42, w - 32, 20), trunc(B.stationName(opts.station), 38), { px: 13, color: MUTED }));

        var cy = TRANSIT_ROWS_Y;
        var note = "Live from 511.org";
        if (!rows.length) {
          var msg = opts.times === null ? "Loading times…"
            : (opts.times === false ? "Unavailable right now" : "No trains listed right now.");
          if (opts.times !== null) note = "";
          box.addMorph(label(lively.rect(16, cy + 4, w - 32, 20), msg, { px: 13, color: MUTED }));
          cy += TRANSIT_ROW_H;
        }
        var destChars = Math.max(8, Math.floor((w - 32 - 24 - 64) / 7.2));
        rows.forEach(function (r) {
          var line = B.lines.filter(function (l) { return l.key === r.lineKey; })[0];
          var dot = new lively.morphic.Box(lively.rect(16, cy + 8, 10, 10));
          dot.applyStyle({ fill: line ? Color.rgbHex(line.color) : MUTED, borderRadius: 5, borderWidth: 0 });
          noDrag(dot);
          dot.eventsAreIgnored = true;
          dot.toolTip = line ? line.label : "";
          box.addMorph(dot);
          box.addMorph(label(lively.rect(34, cy + 3, w - 34 - 16 - 64, 20), trunc(r.destination, destChars), { px: 13, bold: true }));
          box.addMorph(label(lively.rect(w - 16 - 64, cy + 3, 64, 20), r.minutes < 1 ? "now" : r.minutes + " min", { px: 13, color: PINK, bold: true, align: "right" }));
          cy += TRANSIT_ROW_H;
        });
        if (note) box.addMorph(label(lively.rect(16, h - 26, w - 32, 16), note, { px: 11, color: MUTED }));
        return box;
      },

      // Plans the grid for the described cards (null ones are skipped): rows of as
      // many columns as fit, each row as tall as its tallest card. A card's h is a
      // number, or a function of the card width. Calls addMorph(panel) for each
      // built panel and returns the y below the last row, or y itself when there
      // are no cards.
      layout: function (cards, x, y, w, gap, addMorph) {
        cards = cards.filter(Boolean);
        if (!cards.length) return y;
        var cols = Math.max(1, Math.min(cards.length, Math.floor((w + gap) / (CARD_MIN_W + gap))));
        var cw = Math.floor((w - gap * (cols - 1)) / cols);
        var heightOf = function (c) { return typeof c.h === "function" ? c.h(cw) : c.h; };
        for (var i = 0; i < cards.length; i += cols) {
          var row = cards.slice(i, i + cols);
          var rowH = row.reduce(function (m, c) { return Math.max(m, heightOf(c)); }, 0);
          row.forEach(function (c, j) { addMorph(c.build(x + j * (cw + gap), y, cw, rowH)); });
          y += rowH + gap;
        }
        return y - gap;
      },
    };

  });
