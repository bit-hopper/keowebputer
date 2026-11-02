// Seamless topographic contour tile generator.
// Heightfield = sum of integer-frequency sinusoids over the tile => periodic
// => contours tile seamlessly. Iso-lines via marching squares, chained into
// polylines, simplified (RDP), emitted as stroked SVG paths.
// Usage: node gen_topo.js <seed> [levels]

var fs = require('fs');

function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    var t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

var SEED = parseInt(process.argv[2] || '3', 10);
var NLEVELS = parseInt(process.argv[3] || '11', 10);
var rnd = mulberry32(SEED);
var T = 440;      // tile px
var N = 110;      // grid cells (samples N+1, wrap-aware)

// ---- periodic heightfield: sum of sinusoids with integer wave numbers ----
var comps = [];
for (var k = 0; k < 18; k++) {
  var p, q;
  do { p = Math.floor(rnd() * 9) - 4; q = Math.floor(rnd() * 9) - 4; }
  while (p === 0 && q === 0);
  var f = Math.abs(p) + Math.abs(q);
  comps.push({ p: p, q: q, amp: (0.5 + rnd()) / Math.pow(f, 1.15), ph: rnd() * Math.PI * 2 });
}
function height(x, y) {
  var v = 0;
  for (var i = 0; i < comps.length; i++) {
    var c = comps[i];
    v += c.amp * Math.sin(2 * Math.PI * (c.p * x + c.q * y) / T + c.ph);
  }
  return v;
}

// sample grid (index 0..N inclusive; column/row N === column/row 0 by periodicity)
var H = [];
var mn = Infinity, mx = -Infinity;
for (var gy = 0; gy <= N; gy++) {
  H[gy] = [];
  for (var gx = 0; gx <= N; gx++) {
    // force exact wrap: border row/col reuse the opposite border's values
    var v = (gx === N) ? H[gy][0] : (gy === N) ? H[0][gx]
                       : height(gx * T / N, gy * T / N);
    H[gy][gx] = v;
    if (v < mn) mn = v; if (v > mx) mx = v;
  }
}

// ---- marching squares per level ----
function key(x, y) { return (Math.round(x * 100)) + ',' + (Math.round(y * 100)); }

function segmentsForLevel(L) {
  var segs = [];
  var cs = T / N;
  function interp(va, vb, a, b) { // returns point between corners a,b
    var t = (L - va) / (vb - va);
    return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
  }
  for (var gy = 0; gy < N; gy++) {
    for (var gx = 0; gx < N; gx++) {
      var x0 = gx * cs, y0 = gy * cs, x1 = x0 + cs, y1 = y0 + cs;
      var tl = H[gy][gx], tr = H[gy][gx + 1],
          br = H[gy + 1][gx + 1], bl = H[gy + 1][gx];
      var idx = (tl > L ? 8 : 0) | (tr > L ? 4 : 0) | (br > L ? 2 : 0) | (bl > L ? 1 : 0);
      if (idx === 0 || idx === 15) continue;
      var top    = function(){ return interp(tl, tr, [x0,y0], [x1,y0]); };
      var right  = function(){ return interp(tr, br, [x1,y0], [x1,y1]); };
      var bottom = function(){ return interp(bl, br, [x0,y1], [x1,y1]); };
      var left   = function(){ return interp(tl, bl, [x0,y0], [x0,y1]); };
      var add = function(a, b) { segs.push([a, b]); };
      switch (idx) {
        case 1:  add(left(), bottom()); break;
        case 2:  add(bottom(), right()); break;
        case 3:  add(left(), right()); break;
        case 4:  add(top(), right()); break;
        case 5:  add(top(), left()); add(bottom(), right()); break; // saddle (simple)
        case 6:  add(top(), bottom()); break;
        case 7:  add(top(), left()); break;
        case 8:  add(top(), left()); break;
        case 9:  add(top(), bottom()); break;
        case 10: add(top(), right()); add(bottom(), left()); break; // saddle
        case 11: add(top(), right()); break;
        case 12: add(left(), right()); break;
        case 13: add(bottom(), right()); break;
        case 14: add(left(), bottom()); break;
      }
    }
  }
  return segs;
}

// ---- chain segments into polylines ----
function chain(segs) {
  var byPt = {};
  segs.forEach(function (s, i) {
    [key(s[0][0], s[0][1]), key(s[1][0], s[1][1])].forEach(function (k) {
      (byPt[k] = byPt[k] || []).push(i);
    });
  });
  var used = new Array(segs.length).fill(false);
  var lines = [];
  for (var i = 0; i < segs.length; i++) {
    if (used[i]) continue;
    used[i] = true;
    var line = [segs[i][0], segs[i][1]];
    // extend forward then backward
    [true, false].forEach(function (fwd) {
      for (;;) {
        var end = fwd ? line[line.length - 1] : line[0];
        var k = key(end[0], end[1]);
        var cand = (byPt[k] || []).filter(function (j) { return !used[j]; });
        if (!cand.length) break;
        var j = cand[0]; used[j] = true;
        var s = segs[j];
        var nxt = key(s[0][0], s[0][1]) === k ? s[1] : s[0];
        if (fwd) line.push(nxt); else line.unshift(nxt);
      }
    });
    lines.push(line);
  }
  return lines;
}

// ---- Ramer-Douglas-Peucker simplification ----
function rdp(pts, eps) {
  if (pts.length < 3) return pts;
  var dmax = 0, idx = 0;
  var a = pts[0], b = pts[pts.length - 1];
  var dx = b[0] - a[0], dy = b[1] - a[1];
  var len = Math.sqrt(dx * dx + dy * dy) || 1e-9;
  for (var i = 1; i < pts.length - 1; i++) {
    var d = Math.abs(dy * pts[i][0] - dx * pts[i][1] + b[0] * a[1] - b[1] * a[0]) / len;
    if (d > dmax) { dmax = d; idx = i; }
  }
  if (dmax > eps) {
    var l = rdp(pts.slice(0, idx + 1), eps), r = rdp(pts.slice(idx), eps);
    return l.slice(0, -1).concat(r);
  }
  return [a, b];
}

// ---- build levels ----
var pad = (mx - mn) * 0.045;
var levels = [];
for (var li = 0; li < NLEVELS; li++) {
  levels.push(mn + pad + (mx - mn - 2 * pad) * (li / (NLEVELS - 1)));
}

var out = { T: T, levels: [] };
levels.forEach(function (L, li) {
  var lines = chain(segmentsForLevel(L)).map(function (line) { return rdp(line, 0.45); })
    .filter(function (line) { return line.length >= 2; });
  out.levels.push({ index: li, isIndex: li % 4 === 0, lines: lines });
});

// ---- emit SVG (styles injected via placeholder tokens for easy re-skinning) ----
function pathFor(lines) {
  return lines.map(function (line) {
    var d = 'M' + line[0][0].toFixed(1) + ' ' + line[0][1].toFixed(1);
    for (var i = 1; i < line.length; i++) {
      d += 'L' + line[i][0].toFixed(1) + ' ' + line[i][1].toFixed(1);
    }
    return d;
  }).join('');
}

function buildSVG(style) {
  var body = '';
  out.levels.forEach(function (lv) {
    var isIdx = lv.isIndex;
    body += '<path d="' + pathFor(lv.lines) + '" fill="none" stroke="' +
      (isIdx ? style.index : style.line) + '" stroke-width="' +
      (isIdx ? style.indexW : style.lineW) +
      '" stroke-linejoin="round" stroke-linecap="round"/>';
  });
  return '<svg xmlns="http://www.w3.org/2000/svg" width="' + T + '" height="' + T +
    '" viewBox="0 0 ' + T + ' ' + T + '">' +
    '<rect width="' + T + '" height="' + T + '" fill="' + style.bg + '"/>' + body + '</svg>';
}

var styles = {
  paper:     { bg: '#f3eee1', line: '#c3ab82', index: '#94794f', lineW: 1,   indexW: 1.7 },
  blueprint: { bg: '#16324c', line: '#3f647f', index: '#7fa8c4', lineW: 1,   indexW: 1.7 },
  sage:      { bg: '#e9ede4', line: '#a9b8a0', index: '#77896c', lineW: 1,   indexW: 1.7 }
};

Object.keys(styles).forEach(function (name) {
  var svg = buildSVG(styles[name]);
  fs.writeFileSync(__dirname + '/topo_' + name + '.svg', svg);
  console.log(name, 'bytes:', svg.length);
});
fs.writeFileSync(__dirname + '/topo_lines.json', JSON.stringify(out));
console.log('seed', SEED, 'levels', NLEVELS,
  'total pts:', out.levels.reduce(function (s, l) {
    return s + l.lines.reduce(function (a, ln) { return a + ln.length; }, 0);
  }, 0));
