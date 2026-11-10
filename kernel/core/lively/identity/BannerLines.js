/**
 * lively.identity.BannerLines
 *
 * The default banner behind a profile, a room or a constellation that has no
 * image of its own. It replaced the earlier quilt-pattern banners, whose
 * module has been removed.
 *
 * A banner is a contour map drawn in three colours: green lowlands climb
 * through teal to pink peaks, with a heavier line every fifth level. The map
 * is generated from a seed string (a handle, a room id) with the same
 * xorshift128-from-charcodes generator identiconDataUrl uses, so the same
 * person always gets the same banner. The seed also decides which of the three
 * colours leads and where the hills are.
 *
 * It is drawn at the size of the morph it is applied to, not tiled, so the
 * lines are never cut by a tile edge and never scaled.
 */

module('lively.identity.BannerLines')
  .requires('lively.morphic.HTML')
  .toRun(function () {

    lively.identity = lively.identity || {};

    // The accent pink, the button green, and teal. These three are the whole
    // palette: a banner must never use a fourth colour.
    var PINK = '#e8497e', GREEN = '#2f9e5b', TEAL = '#1fa7ad';
    // Almost white, with a hint of the accent, so a banner sits on a white
    // card without looking like a hole in it.
    var GROUND = '#fffafc';
    var TAU = Math.PI * 2;
    var LINE_WEIGHT = 1.4;
    var CELL = 3;

    // ─── seeded PRNG (same technique as PostCardUtils.js's identiconDataUrl) ──

    function _seededRnd(seedStr) {
      var seed = String(seedStr == null ? '?' : seedStr).toLowerCase();
      var rs = [0, 0, 0, 0];
      for (var i = 0; i < seed.length; i++) {
        rs[i % 4] = ((rs[i % 4] << 5) - rs[i % 4]) + seed.charCodeAt(i);
        rs[i % 4] |= 0;
      }
      function rnd() {
        var t = rs[0] ^ (rs[0] << 11);
        rs[0] = rs[1]; rs[1] = rs[2]; rs[2] = rs[3];
        rs[3] = (rs[3] ^ (rs[3] >> 19) ^ t ^ (t >> 8));
        return (rs[3] >>> 0) / ((1 << 31) >>> 0);
      }
      // A short seed leaves rs[1..3] at zero, so the first outputs stay
      // near-zero until the recurrence has spread bits through the state.
      // Everything below reads the very first draws (which colour leads, where
      // the first hill is), so warm up before handing it over.
      for (var w = 0; w < 24; w++) rnd();
      return rnd;
    }

    // ─── colour helpers ─────────────────────────────────────────────────────

    function _lerpColor(a, b, t) {
      function ch(c, i) { return parseInt(c.slice(1 + i * 2, 3 + i * 2), 16); }
      function mix(i) { return Math.round(ch(a, i) + (ch(b, i) - ch(a, i)) * t); }
      return 'rgb(' + mix(0) + ',' + mix(1) + ',' + mix(2) + ')';
    }

    // A colour at position t (0..1) along a ramp through the given colours.
    function _ramp(colors, t) {
      var s = Math.max(0, Math.min(1, t)) * (colors.length - 1);
      var i = Math.min(colors.length - 2, Math.floor(s));
      return _lerpColor(colors[i], colors[i + 1], s - i);
    }

    // ─── height field ───────────────────────────────────────────────────────

    // A smooth, repeatable wobble in two dimensions: three sine pairs.
    function _wobble(r, scale) {
      var a = [];
      for (var k = 0; k < 3; k++) {
        a.push({
          fx: (0.6 + r() * 1.2) / scale, fy: (0.6 + r() * 1.2) / scale,
          px: r() * TAU, py: r() * TAU, am: 1 / (k + 1)
        });
      }
      return function (x, y) {
        var s = 0;
        for (var k = 0; k < a.length; k++) s += a[k].am * Math.sin(x * a[k].fx + a[k].px) * Math.cos(y * a[k].fy + a[k].py);
        return s;
      };
    }

    // A few gaussian hills and dips scattered over the banner.
    function _hills(r, w, h, perHill) {
      var n = Math.max(3, Math.round(w / perHill)), b = [];
      for (var k = 0; k < n; k++) {
        b.push({
          x: w * r(), y: h * (0.1 + 0.8 * r()), s: h * (0.4 + 0.5 * r()),
          a: (r() < 0.3 ? -1 : 1) * (0.6 + 0.6 * r())
        });
      }
      return function (x, y) {
        var v = 0;
        for (var k = 0; k < b.length; k++) {
          var dx = x - b[k].x, dy = y - b[k].y;
          v += b[k].a * Math.exp(-(dx * dx + dy * dy) / (2 * b[k].s * b[k].s));
        }
        return v;
      };
    }

    function _sample(w, h, fn) {
      var cols = Math.ceil(w / CELL) + 2, rows = Math.ceil(h / CELL) + 2;
      var f = new Float32Array(cols * rows), lo = Infinity, hi = -Infinity;
      for (var j = 0; j < rows; j++) {
        for (var i = 0; i < cols; i++) {
          var v = fn(i * CELL, j * CELL);
          f[j * cols + i] = v;
          if (v < lo) lo = v;
          if (v > hi) hi = v;
        }
      }
      return { f: f, cols: cols, rows: rows, lo: lo, hi: hi };
    }

    // ─── contour tracing (marching squares) ────────────────────────────────
    // Corner bits: top-left 8, top-right 4, bottom-right 2, bottom-left 1 (set
    // when the corner is above the level). Cell edges: 0 top, 1 right, 2
    // bottom, 3 left. Each entry lists pairs of edges a line segment joins; the
    // two saddle cases (5 and 10) are drawn as two separate segments.
    var CASES = {
      1: [3, 2], 2: [2, 1], 3: [3, 1], 4: [0, 1], 5: [0, 1, 3, 2], 6: [0, 2], 7: [3, 0],
      8: [3, 0], 9: [0, 2], 10: [3, 0, 2, 1], 11: [0, 1], 12: [3, 1], 13: [2, 1], 14: [3, 2]
    };

    function _traceInto(ctx, F, lv) {
      var cols = F.cols, rows = F.rows, f = F.f;
      for (var j = 0; j < rows - 1; j++) {
        for (var i = 0; i < cols - 1; i++) {
          var tl = f[j * cols + i], tr = f[j * cols + i + 1];
          var br = f[(j + 1) * cols + i + 1], bl = f[(j + 1) * cols + i];
          var cs = (tl > lv ? 8 : 0) | (tr > lv ? 4 : 0) | (br > lv ? 2 : 0) | (bl > lv ? 1 : 0);
          if (cs === 0 || cs === 15) continue;
          var x0 = i * CELL, y0 = j * CELL;
          var E = [
            [x0 + CELL * (lv - tl) / (tr - tl), y0],
            [x0 + CELL, y0 + CELL * (lv - tr) / (br - tr)],
            [x0 + CELL * (lv - bl) / (br - bl), y0 + CELL],
            [x0, y0 + CELL * (lv - tl) / (bl - tl)]
          ];
          var pr = CASES[cs];
          for (var s = 0; s < pr.length; s += 2) {
            ctx.moveTo(E[pr[s]][0], E[pr[s]][1]);
            ctx.lineTo(E[pr[s + 1]][0], E[pr[s + 1]][1]);
          }
        }
      }
    }

    // ─── drawing ────────────────────────────────────────────────────────────

    // Draws the banner for a seed onto a w x h area of ctx (already scaled to
    // css pixels).
    function _draw(ctx, w, h, seedStr) {
      var r = _seededRnd(seedStr + '/contour');
      // Which colour leads differs per seed.
      var off = Math.floor(r() * 3);
      var pal = [PINK, GREEN, TEAL];
      pal = pal.slice(off).concat(pal.slice(0, off));

      ctx.fillStyle = GROUND;
      ctx.fillRect(0, 0, w, h);

      var hill = _hills(r, w, h, 95), wob = _wobble(r, h * 0.7);
      var F = _sample(w, h, function (x, y) { return hill(x, y) + 0.3 * wob(x, y); });

      // Heights run green (low) -> teal -> pink (high), whatever leads.
      var order = [pal[1], pal[2], pal[0]];
      var levels = h > 100 ? 34 : 22;
      ctx.lineCap = 'round';
      for (var L = 1; L <= levels; L++) {
        var lv = F.lo + (F.hi - F.lo) * L / (levels + 1);
        var index = L % 5 === 0;
        ctx.beginPath();
        _traceInto(ctx, F, lv);
        ctx.strokeStyle = _ramp(order, L / (levels + 1));
        ctx.globalAlpha = index ? 1 : 0.7;
        ctx.lineWidth = index ? LINE_WEIGHT * 1.5 : LINE_WEIGHT * 0.7;
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
    }

    // ─── caching + public API ───────────────────────────────────────────────

    // A banner is drawn once per (seed, size) and the data URL reused: a list
    // of rooms or profiles asks for the same few again on every refresh.
    var _cache = {}, _cacheKeys = [], CACHE_MAX = 24;

    function bannerDataUrl(seedStr, width, height) {
      var w = Math.max(20, Math.round(width)), h = Math.max(20, Math.round(height));
      var dpr = Math.min(2, (typeof window !== 'undefined' && window.devicePixelRatio) || 1);
      var key = String(seedStr).toLowerCase() + '|' + w + 'x' + h + '@' + dpr;
      if (_cache[key]) return _cache[key];
      var canvas = document.createElement('canvas');
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      var ctx = canvas.getContext('2d');
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      _draw(ctx, w, h, seedStr);
      var url = canvas.toDataURL();
      _cache[key] = url;
      _cacheKeys.push(key);
      if (_cacheKeys.length > CACHE_MAX) delete _cache[_cacheKeys.shift()];
      return url;
    }

    // The fill is cover-fitted, so a banner whose morph is resized a little
    // later still fills it; it is not meant to be stretched far.
    function bannerFillForSeed(seedStr, width, height) {
      var bg = GROUND + ' url("' + bannerDataUrl(seedStr, width, height) + '") center / cover no-repeat';
      return new lively.morphic.CSS.Fill(bg);
    }

    // Paints the banner for a seed onto a morph, at the morph's current size.
    // Call it after the morph has its final extent.
    function applyBannerBackground(morph, seedStr) {
      var ext = morph.getExtent();
      var fill = bannerFillForSeed(seedStr, ext.x, ext.y);
      morph.applyStyle({ fill: fill, borderWidth: 0 });
      // Defensive DOM-write fallback: applyStyle({fill:...}) can silently
      // fail to reach the DOM on an already-rendered morph (see CLAUDE.md).
      var node = morph.renderContext && morph.renderContext().shapeNode;
      if (node) node.style.background = fill.cssBackgroundString;
      return fill;
    }

    lively.identity.bannerLines = {
      applyBannerBackground: applyBannerBackground,
      bannerFillForSeed: bannerFillForSeed,
      bannerDataUrl: bannerDataUrl
    };

  });
