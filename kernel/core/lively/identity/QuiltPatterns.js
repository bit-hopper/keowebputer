/**
 * lively.identity.QuiltPatterns
 *
 * Ankara-inspired "quilt" SVG background patterns (quiltspec.md, repo root),
 * rendered to canvas data URLs and applied as a deterministic, per-identity
 * background — same tradition as PostCardUtils.js's identiconDataUrl, just
 * for a whole banner strip instead of an 8x8 avatar grid.
 *
 * Three approved tile patterns (R2/R3/R6), each composed from a shared
 * library of ~24 motif-drawing primitives (concentric target, chevron
 * waves, adinkra key, etc. — quiltspec.md's own vocabulary). A seed string
 * (a handle, a room id) deterministically picks one of the three patterns
 * plus a pan offset into it, via the same xorshift128-from-charcodes PRNG
 * identiconDataUrl already uses.
 */

module('lively.identity.QuiltPatterns')
  .requires('lively.morphic.HTML')
  .toRun(function () {

    lively.identity = lively.identity || {};

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
      // A short seed (e.g. a single-digit room id) leaves rs[1..3] at zero,
      // so the first several outputs stay near-zero until the recurrence
      // has had a chance to spread bits through the whole state — fine for
      // identiconDataUrl's dozens of downstream calls, but fatal for this
      // module's 3-value pattern pick, which reads only the very first
      // draw. Warm up before returning control to the caller.
      for (var w = 0; w < 24; w++) rnd();
      return rnd;
    }

    // ─── motif primitives ───────────────────────────────────────────────────
    // Each fn(ctx, size, colors, params, bg) draws into a size x size tile
    // whose top-left corner is already (0,0) (callers ctx.save()/translate()
    // before invoking). `bg` is passed through for motifs that punch a
    // background-colored hole (dot matrix, starburst core, etc).

    function drawConcentricTarget(ctx, size, colors, params) {
      params = params || {};
      var cx = size / 2, cy = size / 2;
      var maxR = size * 0.42;
      var radii = [maxR, maxR * 0.64, maxR * 0.28];
      ctx.strokeStyle = colors[0]; ctx.lineWidth = Math.max(1.5, size * 0.07);
      ctx.beginPath(); ctx.arc(cx, cy, radii[0], 0, Math.PI * 2); ctx.stroke();
      ctx.strokeStyle = colors[1]; ctx.lineWidth = Math.max(1.5, size * 0.05);
      ctx.beginPath(); ctx.arc(cx, cy, radii[1], 0, Math.PI * 2); ctx.stroke();
      ctx.fillStyle = colors[2];
      ctx.beginPath(); ctx.arc(cx, cy, radii[2], 0, Math.PI * 2); ctx.fill();
      if (params.spokes) {
        ctx.strokeStyle = colors[0]; ctx.lineWidth = Math.max(1, size * 0.02);
        ctx.beginPath(); ctx.moveTo(cx, 0); ctx.lineTo(cx, size); ctx.moveTo(0, cy); ctx.lineTo(size, cy); ctx.stroke();
      }
      if (params.cornerDots) {
        var r = size * 0.06, m = size * 0.14;
        ctx.fillStyle = colors[0];
        [[m, m], [size - m, m], [m, size - m], [size - m, size - m]].forEach(function (p) {
          ctx.beginPath(); ctx.arc(p[0], p[1], r, 0, Math.PI * 2); ctx.fill();
        });
      }
    }

    function drawChevronWaves(ctx, size, colors, params) {
      params = params || {};
      var rows = params.rows || 6;
      var rowH = size / rows;
      ctx.lineWidth = params.strokeWidth || Math.max(2, size * 0.06);
      ctx.lineCap = 'round'; ctx.lineJoin = 'round';
      for (var r = 0; r < rows; r++) {
        var y = r * rowH + rowH / 2;
        ctx.strokeStyle = colors[r % colors.length];
        var peakW = rowH * 1.4;
        ctx.beginPath();
        for (var x = -peakW / 2; x < size + peakW; x += peakW) {
          ctx.moveTo(x, y + rowH * 0.3);
          ctx.lineTo(x + peakW / 2, y - rowH * 0.3);
          ctx.lineTo(x + peakW, y + rowH * 0.3);
        }
        ctx.stroke();
      }
    }

    function drawCalabashDrop(ctx, size, colors, params, bg) {
      var cx = size / 2, mainColor = colors[0];
      ctx.fillStyle = mainColor;
      ctx.beginPath(); ctx.ellipse(cx, size * 0.42, size * 0.22, size * 0.38, 0, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = bg;
      ctx.beginPath(); ctx.ellipse(cx, size * 0.42, size * 0.11, size * 0.20, 0, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = mainColor;
      [-1, 1].forEach(function (side) {
        ctx.beginPath(); ctx.ellipse(cx + side * size * 0.22, size * 0.80, size * 0.14, size * 0.15, 0, 0, Math.PI * 2); ctx.fill();
      });
    }

    function drawAdinkraKey(ctx, size, colors) {
      var stroke = colors[0], fill = colors[1] || colors[0];
      var cx = size / 2, headR = size * 0.16, topY = size * 0.22;
      ctx.strokeStyle = stroke; ctx.lineWidth = Math.max(1.5, size * 0.05);
      ctx.beginPath(); ctx.arc(cx, topY, headR, 0, Math.PI * 2); ctx.stroke();
      ctx.fillStyle = fill;
      ctx.beginPath(); ctx.arc(cx, topY, headR * 0.5, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = stroke; ctx.lineWidth = Math.max(1.5, size * 0.06);
      ctx.beginPath(); ctx.moveTo(cx, topY + headR); ctx.lineTo(cx, size * 0.82); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(cx - size * 0.16, size * 0.52); ctx.lineTo(cx + size * 0.16, size * 0.52); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(cx - size * 0.18, size * 0.82); ctx.lineTo(cx + size * 0.18, size * 0.82); ctx.stroke();
    }

    function drawPalmFan(ctx, size, colors, params) {
      params = params || {};
      var baseX = size / 2, baseY = size * 0.92;
      var count = 5, spread = Math.PI * 0.8;
      var startAngle = -Math.PI / 2 - spread / 2;
      var len = size * 0.72;
      for (var i = 0; i < count; i++) {
        var t = i / (count - 1);
        var angle = startAngle + spread * t;
        var ex = baseX + Math.cos(angle) * len;
        var ey = baseY + Math.sin(angle) * len;
        ctx.strokeStyle = colors[i % 2];
        ctx.lineWidth = i % 2 === 0 ? Math.max(2, size * 0.075) : Math.max(1.5, size * 0.055);
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.moveTo(baseX, baseY);
        ctx.quadraticCurveTo(baseX + (ex - baseX) * 0.5, baseY - len * 0.3, ex, ey);
        ctx.stroke();
      }
      ctx.fillStyle = colors[colors.length - 1];
      ctx.beginPath(); ctx.arc(baseX, baseY, size * 0.1, 0, Math.PI * 2); ctx.fill();
    }

    function drawDotMatrix(ctx, size, colors, params, bg) {
      var n = 3, cellSize = size / n, r = cellSize * 0.36, innerR = cellSize * 0.14;
      for (var row = 0; row < n; row++) {
        for (var col = 0; col < n; col++) {
          var cx = col * cellSize + cellSize / 2, cy = row * cellSize + cellSize / 2;
          ctx.fillStyle = colors[0];
          ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.fill();
          ctx.fillStyle = bg;
          ctx.beginPath(); ctx.arc(cx, cy, innerR, 0, Math.PI * 2); ctx.fill();
        }
      }
    }

    function drawMudclothBars(ctx, size, colors) {
      ctx.fillStyle = colors[0];
      var hBarH = size * 0.12;
      [0.15, 0.48, 0.81].forEach(function (f) { ctx.fillRect(0, f * size - hBarH / 2, size, hBarH); });
      ctx.globalAlpha = 0.55;
      var vBarW = size * 0.12;
      [0.3, 0.7].forEach(function (f) { ctx.fillRect(f * size - vBarW / 2, 0, vBarW, size); });
      ctx.globalAlpha = 1;
    }

    function drawConcentricSpiral(ctx, size, colors, params) {
      params = params || {};
      var cx = params.cx != null ? params.cx : size / 2;
      var cy = size / 2;
      var maxR = params.maxR || size * 0.4;
      var radii = [maxR, maxR * 0.66, maxR * 0.33];
      var cols = [colors[0], colors[1], colors[0]];
      for (var i = 0; i < 3; i++) {
        ctx.strokeStyle = cols[i]; ctx.lineWidth = Math.max(1.2, size * 0.045);
        ctx.beginPath(); ctx.arc(cx, cy, radii[i], 0, Math.PI * 2); ctx.stroke();
      }
      ctx.fillStyle = colors[1];
      ctx.beginPath(); ctx.arc(cx, cy, radii[2] * 0.4, 0, Math.PI * 2); ctx.fill();
    }

    function drawBoldX(ctx, size, colors, params) {
      params = params || {};
      var pad = size * 0.12;
      ctx.strokeStyle = colors[0];
      ctx.lineWidth = params.strokeWidth || Math.max(2.5, size * (params.heavy ? 0.11 : 0.08));
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(pad, pad); ctx.lineTo(size - pad, size - pad);
      ctx.moveTo(size - pad, pad); ctx.lineTo(pad, size - pad);
      ctx.stroke();
      ctx.fillStyle = colors[1];
      ctx.beginPath(); ctx.arc(size / 2, size / 2, size * 0.16, 0, Math.PI * 2); ctx.fill();
      if (params.cornerCircles) {
        var r = size * 0.1, m = size * 0.14;
        ctx.fillStyle = colors[1];
        [[m, m], [size - m, m], [m, size - m], [size - m, size - m]].forEach(function (p) {
          ctx.beginPath(); ctx.arc(p[0], p[1], r, 0, Math.PI * 2); ctx.fill();
        });
      }
    }

    function drawKenteColumns(ctx, size, colors) {
      var n = 3, colW = size / n;
      var structColors = [colors[0], colors[1]];
      var inlayColors = [colors[2], colors[3], colors[4]];
      for (var i = 0; i < n; i++) {
        ctx.fillStyle = structColors[i % 2];
        ctx.fillRect(i * colW, 0, colW, size);
        var blockH = size / 3;
        for (var b = 0; b < 3; b++) {
          ctx.fillStyle = inlayColors[(i + b) % inlayColors.length];
          var iw = colW * 0.5, ix = i * colW + (colW - iw) / 2;
          ctx.fillRect(ix, b * blockH + blockH * 0.15, iw, blockH * 0.7);
        }
      }
    }

    function drawStarburst(ctx, size, colors, params, bg) {
      params = params || {};
      var cx = size / 2, cy = size / 2;
      ctx.strokeStyle = colors[0];
      ctx.lineWidth = params.crossWidth || Math.max(2, size * 0.09);
      ctx.beginPath(); ctx.moveTo(cx, 0); ctx.lineTo(cx, size); ctx.moveTo(0, cy); ctx.lineTo(size, cy); ctx.stroke();
      ctx.strokeStyle = colors[1];
      ctx.lineWidth = params.diagWidth || Math.max(1.5, size * 0.05);
      ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(size, size); ctx.moveTo(size, 0); ctx.lineTo(0, size); ctx.stroke();
      var outerR = size * 0.22, innerR = size * 0.1;
      ctx.strokeStyle = colors[0]; ctx.lineWidth = Math.max(1.5, size * 0.05);
      ctx.beginPath(); ctx.arc(cx, cy, outerR, 0, Math.PI * 2); ctx.stroke();
      ctx.fillStyle = bg;
      ctx.beginPath(); ctx.arc(cx, cy, innerR, 0, Math.PI * 2); ctx.fill();
    }

    function drawFloralRosette(ctx, size, colors) {
      var cx = size / 2, cy = size / 2, petalLen = size * 0.32, petalW = size * 0.18, offset = size * 0.24;
      ctx.fillStyle = colors[0];
      [[0, -offset, 0], [0, offset, 0], [offset, 0, Math.PI / 2], [-offset, 0, Math.PI / 2]].forEach(function (p) {
        ctx.save(); ctx.translate(cx + p[0], cy + p[1]); ctx.rotate(p[2]);
        ctx.beginPath(); ctx.ellipse(0, 0, petalW / 2, petalLen / 2, 0, 0, Math.PI * 2); ctx.fill();
        ctx.restore();
      });
      ctx.fillStyle = colors[1];
      ctx.beginPath(); ctx.arc(cx, cy, size * 0.14, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = colors[2];
      ctx.beginPath(); ctx.arc(cx, cy, size * 0.06, 0, Math.PI * 2); ctx.fill();
    }

    function drawDiagonalNet(ctx, size, colors) {
      ctx.strokeStyle = colors[0]; ctx.lineWidth = Math.max(1.5, size * 0.045);
      ctx.beginPath();
      ctx.moveTo(0, 0); ctx.lineTo(size, size);
      ctx.moveTo(size, 0); ctx.lineTo(0, size);
      ctx.moveTo(size / 2, 0); ctx.lineTo(size / 2, size);
      ctx.moveTo(0, size / 2); ctx.lineTo(size, size / 2);
      ctx.stroke();
      var r = size * 0.09, m = size * 0.12;
      ctx.fillStyle = colors[0];
      [[m, m], [size - m, m], [m, size - m], [size - m, size - m]].forEach(function (p) {
        ctx.beginPath(); ctx.arc(p[0], p[1], r, 0, Math.PI * 2); ctx.fill();
      });
      ctx.fillStyle = colors[1];
      ctx.beginPath(); ctx.arc(size / 2, size / 2, size * 0.1, 0, Math.PI * 2); ctx.fill();
    }

    function drawNestedTriangle(ctx, size, colors) {
      var cx = size / 2, baseY = size * 0.85, apexY = size * 0.12;
      var scales = [1, 0.66, 0.33];
      for (var i = 0; i < 3; i++) {
        var s = scales[i];
        var halfW = size * 0.38 * s;
        var top = apexY + (baseY - apexY) * (1 - s);
        ctx.strokeStyle = colors[i]; ctx.lineWidth = Math.max(1.5, size * 0.045);
        ctx.beginPath();
        ctx.moveTo(cx, top); ctx.lineTo(cx - halfW, baseY); ctx.lineTo(cx + halfW, baseY); ctx.closePath();
        ctx.stroke();
      }
      ctx.strokeStyle = colors[0]; ctx.lineWidth = Math.max(1.5, size * 0.045);
      ctx.beginPath(); ctx.moveTo(cx, baseY); ctx.lineTo(cx, size * 0.95); ctx.stroke();
    }

    function drawCircleGrid(ctx, size, colors) {
      var n = 3, cellSize = size / n, r = cellSize * 0.36;
      for (var row = 0; row < n; row++) {
        for (var col = 0; col < n; col++) {
          var cx = col * cellSize + cellSize / 2, cy = row * cellSize + cellSize / 2;
          var isCenter = row === 1 && col === 1;
          ctx.strokeStyle = isCenter ? colors[1] : colors[0];
          ctx.lineWidth = Math.max(1.2, size * 0.03);
          ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.stroke();
        }
      }
    }

    function drawZigzagBands(ctx, size, colors, params) {
      params = params || {};
      var rows = params.rows || 5;
      var rowH = size / rows;
      ctx.strokeStyle = colors[0];
      ctx.lineWidth = params.strokeWidth || Math.max(2, size * 0.055);
      ctx.lineJoin = 'miter';
      for (var r = 0; r < rows; r++) {
        var y = r * rowH + rowH / 2;
        var amp = rowH * 0.3, step = rowH * 0.9;
        ctx.beginPath();
        var up = true;
        for (var x = 0; x <= size + step; x += step) {
          ctx.lineTo(x, y + (up ? -amp : amp));
          up = !up;
        }
        ctx.stroke();
      }
    }

    function drawDiamondLattice(ctx, size, colors, params) {
      var n = 2, cellSize = size / n;
      ctx.strokeStyle = colors[0];
      ctx.lineWidth = (params && params.strokeWidth) || Math.max(1.5, size * 0.05);
      for (var row = 0; row < n; row++) {
        for (var col = 0; col < n; col++) {
          var cx = col * cellSize + cellSize / 2, cy = row * cellSize + cellSize / 2;
          var half = cellSize * 0.38;
          ctx.beginPath();
          ctx.moveTo(cx, cy - half); ctx.lineTo(cx + half, cy); ctx.lineTo(cx, cy + half); ctx.lineTo(cx - half, cy); ctx.closePath();
          ctx.stroke();
        }
      }
    }

    function drawAbstractFlora(ctx, size, colors, params, bg) {
      var cx = size / 2, cy = size * 0.38;
      ctx.fillStyle = colors[0];
      ctx.beginPath(); ctx.arc(cx, cy, size * 0.2, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = bg;
      ctx.beginPath(); ctx.arc(cx, cy, size * 0.08, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = colors[1];
      ctx.beginPath(); ctx.ellipse(cx - size * 0.28, cy + size * 0.05, size * 0.09, size * 0.15, 0.4, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.ellipse(cx + size * 0.28, cy + size * 0.05, size * 0.09, size * 0.15, -0.4, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = colors[0]; ctx.lineWidth = Math.max(1.5, size * 0.04);
      ctx.beginPath();
      ctx.moveTo(cx, cy + size * 0.18); ctx.lineTo(cx, size * 0.9);
      ctx.moveTo(cx, size * 0.75); ctx.lineTo(cx - size * 0.18, size * 0.9);
      ctx.moveTo(cx, size * 0.75); ctx.lineTo(cx + size * 0.18, size * 0.9);
      ctx.stroke();
    }

    function drawVesicaLens(ctx, size, colors) {
      var cx = size / 2, cy = size / 2;
      ctx.fillStyle = colors[0];
      ctx.beginPath(); ctx.ellipse(cx, cy, size * 0.14, size * 0.4, 0, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = colors[1];
      ctx.beginPath(); ctx.ellipse(cx, cy, size * 0.4, size * 0.14, 0, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = colors[2];
      ctx.beginPath(); ctx.arc(cx, cy, size * 0.09, 0, Math.PI * 2); ctx.fill();
    }

    function drawPolkaDotField(ctx, size, colors) {
      var n = 3, cellSize = size / n, r = cellSize * 0.3;
      ctx.fillStyle = colors[0];
      for (var row = 0; row < n; row++) {
        for (var col = 0; col < n; col++) {
          var cx = col * cellSize + cellSize / 2, cy = row * cellSize + cellSize / 2;
          ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.fill();
        }
      }
    }

    function drawCheckerVariant(ctx, size, colors) {
      var half = size * 0.32 * 0.6, m = size * 0.22;
      function diamond(cx, cy, h, color) {
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.moveTo(cx, cy - h); ctx.lineTo(cx + h, cy); ctx.lineTo(cx, cy + h); ctx.lineTo(cx - h, cy); ctx.closePath();
        ctx.fill();
      }
      [[m, m], [size - m, m], [m, size - m], [size - m, size - m]].forEach(function (p) { diamond(p[0], p[1], half, colors[0]); });
      diamond(size / 2, size / 2, half * 1.1, colors[1]);
    }

    function drawBoldStar(ctx, size, colors) {
      var cx = size / 2, cy = size / 2, outerR = size * 0.42, innerR = size * 0.18, points = 5;
      ctx.beginPath();
      for (var i = 0; i < points * 2; i++) {
        var r = i % 2 === 0 ? outerR : innerR;
        var angle = Math.PI * i / points - Math.PI / 2;
        var x = cx + Math.cos(angle) * r, y = cy + Math.sin(angle) * r;
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.closePath();
      ctx.fillStyle = colors[0]; ctx.fill();
      ctx.strokeStyle = colors[1]; ctx.lineWidth = Math.max(1.5, size * 0.045); ctx.stroke();
    }

    function drawSinusoidalWave(ctx, size, colors) {
      var widths = [Math.max(2, size * 0.075), Math.max(1.5, size * 0.055), Math.max(2, size * 0.075)];
      var cols = [colors[0], colors[1], colors[0]];
      for (var i = 0; i < 3; i++) {
        var yOff = size * (0.22 + i * 0.28);
        ctx.strokeStyle = cols[i]; ctx.lineWidth = widths[i];
        ctx.beginPath();
        for (var x = 0; x <= size; x += 2) {
          var y = yOff + Math.sin((x / size) * Math.PI * 2) * size * 0.12;
          if (x === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        }
        ctx.stroke();
      }
    }

    // ─── motif registry — transcribed from quiltspec.md's R2/R3/R6 tables ──

    var MOTIFS = {
      m1:  { fn: drawConcentricTarget, bg: '#D62828', colors: ['#F7B731', '#fff', '#F7B731'], params: { spokes: true, cornerDots: true } },
      m2:  { fn: drawChevronWaves,     bg: '#005F73', colors: ['#94D2BD', '#EE9B00', '#AE2012'] },
      m3:  { fn: drawCalabashDrop,     bg: '#EE9B00', colors: ['#9B2226'] },
      m4:  { fn: drawAdinkraKey,       bg: '#370617', colors: ['#F48C06'] },
      m5:  { fn: drawPalmFan,          bg: '#6A0572', colors: ['#FF6B6B', '#FFE66D'] },
      m6:  { fn: drawDotMatrix,        bg: '#0A3D62', colors: ['#F9CA24'] },
      m7:  { fn: drawMudclothBars,     bg: '#F4845F', colors: ['#2D1B00'] },
      m8:  { fn: drawConcentricSpiral, bg: '#2B9348', colors: ['#AACC00', '#FFE66D'] },
      m9:  { fn: drawBoldX,            bg: '#C1121F', colors: ['#fff', '#FFD166'] },
      m10: { fn: drawKenteColumns,     bg: '#FFD166', colors: ['#EF476F', '#073B4C', '#06D6A0', '#118AB2', '#073B4C'] },
      m11: { fn: drawStarburst,        bg: '#073B4C', colors: ['#FFD166', '#EF476F'] },
      m12: { fn: drawFloralRosette,    bg: '#E63946', colors: ['#FF6B35', '#FFE66D', '#E63946'] },
      m13: { fn: drawDiagonalNet,      bg: '#3D0066', colors: ['#FF9F1C', '#FFFD77'] },
      m14: { fn: drawNestedTriangle,   bg: '#38A3A5', colors: ['#22577A', '#38A3A5', '#57CC99'] },
      m15: { fn: drawCircleGrid,       bg: '#FF6B35', colors: ['#fff', '#073B4C'] },
      m16: { fn: drawZigzagBands,      bg: '#1B1B1E', colors: ['#E9C46A'], params: { strokeWidth: 4 } },
      m17: { fn: drawDiamondLattice,   bg: '#9B2226', colors: ['#EE9B00'], params: { strokeWidth: 3.5 } },
      m18: { fn: drawAbstractFlora,    bg: '#003049', colors: ['#FCBF49', '#EAE2B7'] },
      m19: { fn: drawBoldX,            bg: '#4CC9F0', colors: ['#3A0CA3', '#F72585'], params: { heavy: true } },
      m20: { fn: drawVesicaLens,       bg: '#7209B7', colors: ['#F72585', '#4CC9F0', '#FFBE0B'] },
      m21: { fn: drawPolkaDotField,    bg: '#F72585', colors: ['#fff'] },
      m22: { fn: drawCheckerVariant,   bg: '#023E8A', colors: ['#0096C7', '#48CAE4'] },
      m23: { fn: drawBoldStar,         bg: '#55A630', colors: ['#AACC00', '#1B4332'] },
      m24: { fn: drawSinusoidalWave,   bg: '#FF9F1C', colors: ['#2D00F7', '#6A00F4'] },

      s1: { fn: drawConcentricTarget, bg: '#D62828', colors: ['#F7B731', '#fff', '#F7B731'], params: { cornerDots: true } },
      s2: { fn: drawChevronWaves,     bg: '#005F73', colors: ['#94D2BD', '#EE9B00', '#AE2012'], params: { rows: 7 } },
      s5: { fn: drawPalmFan,          bg: '#6A0572', colors: ['#FF6B6B', '#FFE66D'] },
      s6: { fn: drawStarburst,        bg: '#073B4C', colors: ['#FFD166', '#EF476F'] },
      s7: { fn: drawCalabashDrop,     bg: '#EE9B00', colors: ['#9B2226'] },
      s8: { fn: drawBoldX,            bg: '#C1121F', colors: ['#fff', '#FFD166'], params: { heavy: true, cornerCircles: true } },
      s9: { fn: drawDotMatrix,        bg: '#0A3D62', colors: ['#F9CA24'] },

      band1: { fn: drawConcentricTarget, bg: '#D62828', colors: ['#F7B731', '#fff', '#F7B731'], params: { cornerDots: true }, tileWidth: 50 },
      band2: { fn: drawChevronWaves,     bg: '#005F73', colors: ['#94D2BD', '#EE9B00', '#AE2012'], params: { rows: 4 }, tileWidth: 40 },
      band3: { fn: drawAdinkraKey,       bg: '#370617', colors: ['#F48C06'], tileWidth: 44 },
      band5: { fn: drawPalmFan,          bg: '#6A0572', colors: ['#FF6B6B', '#FFE66D'], tileWidth: 36 },
      band6: { fn: drawStarburst,        bg: '#073B4C', colors: ['#FFD166', '#EF476F'], tileWidth: 48 },
      band7: { fn: drawCalabashDrop,     bg: '#EE9B00', colors: ['#9B2226'], tileWidth: 44 },
      band8: { fn: drawBoldX,            bg: '#C1121F', colors: ['#fff', '#FFD166'], params: { cornerCircles: true }, tileWidth: 50 },
    };

    // s3/s4 (R3) and band4 (R6) are documented as *arrangements* of an
    // existing motif (a 2x2 grid of adinkra keys / spirals, or a
    // side-by-side twin spiral) rather than a new single-call primitive —
    // handled directly in the composition functions below.

    function _drawMotif(ctx, id, size, bg) {
      var m = MOTIFS[id];
      ctx.fillStyle = m.bg;
      ctx.fillRect(0, 0, size, size);
      m.fn(ctx, size, m.colors, m.params || {}, bg == null ? m.bg : bg);
    }

    // ─── R2: 6x6 micro grid, 396x396 ────────────────────────────────────────

    var R2_GRID = [
      ['m1', 'm2', 'm3', 'm4', 'm5', 'm6'],
      ['m7', 'm8', 'm9', 'm10', 'm11', 'm12'],
      ['m13', 'm14', 'm15', 'm16', 'm17', 'm18'],
      ['m19', 'm20', 'm15', 'm22', 'm9', 'm7'],
      ['m4', 'm21', 'm2', 'm11', 'm20', 'm3'],
      ['m22', 'm3', 'm16', 'm9', 'm24', 'm13'],
    ];

    function _renderR2() {
      var TILE = 66, SIZE = TILE * 6;
      var canvas = document.createElement('canvas');
      canvas.width = canvas.height = SIZE;
      var ctx = canvas.getContext('2d');
      for (var row = 0; row < 6; row++) {
        for (var col = 0; col < 6; col++) {
          ctx.save();
          ctx.translate(col * TILE, row * TILE);
          _drawMotif(ctx, R2_GRID[row][col], TILE);
          ctx.restore();
        }
      }
      ctx.strokeStyle = 'rgba(0,0,0,0.4)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (var i = 1; i < 6; i++) {
        ctx.moveTo(i * TILE, 0); ctx.lineTo(i * TILE, SIZE);
        ctx.moveTo(0, i * TILE); ctx.lineTo(SIZE, i * TILE);
      }
      ctx.stroke();
      return canvas.toDataURL();
    }

    // ─── R3: 3x3 vivid sashing, 400x400 ─────────────────────────────────────

    var R3_BLOCKS = ['s1', 's2', 's3', 's4', 's5', 's6', 's7', 's8', 's9'];
    var R3_POS = [8, 136, 264];

    function _renderR3() {
      var SIZE = 400, BLOCK = 112;
      var canvas = document.createElement('canvas');
      canvas.width = canvas.height = SIZE;
      var ctx = canvas.getContext('2d');
      ctx.fillStyle = '#FF006E';
      ctx.fillRect(0, 0, SIZE, SIZE);

      R3_BLOCKS.forEach(function (id, i) {
        var row = Math.floor(i / 3), col = i % 3;
        var x = R3_POS[col], y = R3_POS[row];
        ctx.save();
        ctx.translate(x, y);
        if (id === 's3') {
          // Adinkra key x4: 2x2 sub-grid, alternating stroke colors.
          var sub = BLOCK / 2;
          ctx.fillStyle = '#370617'; ctx.fillRect(0, 0, BLOCK, BLOCK);
          [['#F48C06', 0, 0], ['#FFE66D', 1, 0], ['#FFE66D', 0, 1], ['#F48C06', 1, 1]].forEach(function (c) {
            ctx.save();
            ctx.translate(c[1] * sub, c[2] * sub);
            drawAdinkraKey(ctx, sub, [c[0]]);
            ctx.restore();
          });
        } else if (id === 's4') {
          // Concentric spiral x4: 2x2 sub-grid, alternating outer-ring color.
          var sub2 = BLOCK / 2;
          ctx.fillStyle = '#2B9348'; ctx.fillRect(0, 0, BLOCK, BLOCK);
          [['#AACC00', 0, 0], ['#FFE66D', 1, 0], ['#FFE66D', 0, 1], ['#AACC00', 1, 1]].forEach(function (c) {
            ctx.save();
            ctx.translate(c[1] * sub2, c[2] * sub2);
            drawConcentricSpiral(ctx, sub2, [c[0], c[0] === '#AACC00' ? '#FFE66D' : '#AACC00']);
            ctx.restore();
          });
        } else {
          _drawMotif(ctx, id, BLOCK);
        }
        ctx.restore();
      });

      ctx.fillStyle = '#FFE66D';
      [[120, 120], [248, 120], [120, 248], [248, 248]].forEach(function (p) {
        ctx.fillRect(p[0], p[1], 16, 16);
      });

      return canvas.toDataURL();
    }

    // ─── R6: 8 horizontal bands, rendered as one 400x400 square tile ───────

    var R6_BANDS = ['band1', 'band2', 'band3', 'band4', 'band5', 'band6', 'band7', 'band8'];

    function _renderR6() {
      var SIZE = 400, BAND_H = 50;
      var canvas = document.createElement('canvas');
      canvas.width = canvas.height = SIZE;
      var ctx = canvas.getContext('2d');

      R6_BANDS.forEach(function (id, bandIndex) {
        var y = bandIndex * BAND_H;
        if (id === 'band4') {
          var tw = 56;
          for (var x = 0; x < SIZE; x += tw) {
            ctx.save();
            ctx.translate(x, y);
            ctx.fillStyle = '#2B9348'; ctx.fillRect(0, 0, tw, BAND_H);
            drawConcentricSpiral(ctx, BAND_H, ['#AACC00', '#FFE66D'], { cx: 14 });
            drawConcentricSpiral(ctx, BAND_H, ['#AACC00', '#FFE66D'], { cx: 42 });
            ctx.restore();
          }
          return;
        }
        var m = MOTIFS[id];
        var tw2 = m.tileWidth;
        for (var x2 = 0; x2 < SIZE; x2 += tw2) {
          ctx.save();
          ctx.translate(x2, y);
          ctx.fillStyle = m.bg; ctx.fillRect(0, 0, tw2, BAND_H);
          m.fn(ctx, BAND_H, m.colors, m.params || {}, m.bg);
          ctx.restore();
        }
      });

      ctx.strokeStyle = 'rgba(0,0,0,0.5)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      for (var i = 1; i < 8; i++) { ctx.moveTo(0, i * BAND_H); ctx.lineTo(SIZE, i * BAND_H); }
      ctx.stroke();

      return canvas.toDataURL();
    }

    // ─── caching + public API ───────────────────────────────────────────────

    var _patternCache = {};

    function _renderPattern(name) {
      if (name === 'R2') return _renderR2();
      if (name === 'R3') return _renderR3();
      return _renderR6();
    }

    function patternDataUrl(name) {
      if (!_patternCache[name]) _patternCache[name] = _renderPattern(name);
      return _patternCache[name];
    }

    var PATTERN_NAMES = ['R2', 'R3', 'R6'];
    var TILE_SIZE = { R2: 396, R3: 400, R6: 400 };

    function quiltFillForSeed(seedStr) {
      var rnd = _seededRnd(seedStr);
      var pattern = PATTERN_NAMES[Math.floor(rnd() * PATTERN_NAMES.length)];
      var size = TILE_SIZE[pattern];
      var offX = Math.floor(rnd() * size), offY = Math.floor(rnd() * size);
      var bgString = 'url("' + patternDataUrl(pattern) + '") ' +
        offX + 'px ' + offY + 'px / ' + size + 'px ' + size + 'px repeat';
      return new lively.morphic.CSS.Fill(bgString);
    }

    function applyQuiltBackground(morph, seedStr) {
      var fill = quiltFillForSeed(seedStr);
      morph.applyStyle({ fill: fill, borderWidth: 0 });
      // Defensive DOM-write fallback — applyStyle({fill:...}) can silently
      // fail to reach the DOM on an already-rendered morph (see CLAUDE.md).
      var node = morph.renderContext && morph.renderContext().shapeNode;
      if (node) node.style.background = fill.cssBackgroundString;
      return fill;
    }

    lively.identity.quiltPatterns = {
      quiltFillForSeed: quiltFillForSeed,
      applyQuiltBackground: applyQuiltBackground,
      patternDataUrl: patternDataUrl,
    };

  });
