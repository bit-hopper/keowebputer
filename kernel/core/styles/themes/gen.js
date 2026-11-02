// Procedural leopard/cheetah rosette tile generator.
// Produces a seamless SVG tile (wrapped placement) suitable for
// CSS background-image via data URI.

//commented here 7/8/26

// deterministic PRNG so the asset is reproducible
function mulberry32(seed) {
  return function () {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    var t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

var SEED = parseInt(process.argv[2] || "7", 10);
var rnd = mulberry32(SEED);
var T = 420; // tile size in px

var PALETTE = {
  bg: "#e9dfc6", // ivory/cream base
  bgWash: ["#e3d5b4", "#efe6cf"], // subtle large washes for unevenness
  patch: ["#c79a5a", "#b8874a", "#d2a968", "#ad7c3f"], // tan/caramel centers
  ink: ["#181310", "#241c15", "#2b2117"], // near-black rosette marks
};

function rr(a, b) {
  return a + rnd() * (b - a);
}
function pick(arr) {
  return arr[Math.floor(rnd() * arr.length)];
}

// irregular blob path: radial polygon with noise, smoothed by quadratic midpoints
function blobPath(cx, cy, r, irregularity, points, elong, rot) {
  points = points || 8;
  elong = elong || 1;
  rot = rot || 0;
  var pts = [];
  for (var i = 0; i < points; i++) {
    var a = (i / points) * Math.PI * 2;
    var rad = r * (1 + rr(-irregularity, irregularity));
    var x = Math.cos(a) * rad * elong;
    var y = Math.sin(a) * rad;
    var xr = x * Math.cos(rot) - y * Math.sin(rot);
    var yr = x * Math.sin(rot) + y * Math.cos(rot);
    pts.push([cx + xr, cy + yr]);
  }
  // smooth: quadratic through midpoints
  var d = "";
  for (var j = 0; j < pts.length; j++) {
    var p = pts[j],
      q = pts[(j + 1) % pts.length];
    var mx = (p[0] + q[0]) / 2,
      my = (p[1] + q[1]) / 2;
    if (j === 0) d += "M" + mx.toFixed(1) + " " + my.toFixed(1);
    else {
      // handled below via Q from previous mid
    }
  }
  d = "";
  var mids = pts.map(function (p, j) {
    var q = pts[(j + 1) % pts.length];
    return [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2];
  });
  d = "M" + mids[0][0].toFixed(1) + " " + mids[0][1].toFixed(1);
  for (var k = 1; k <= pts.length; k++) {
    var ctrl = pts[k % pts.length];
    var mid = mids[k % pts.length];
    d +=
      " Q" +
      ctrl[0].toFixed(1) +
      " " +
      ctrl[1].toFixed(1) +
      " " +
      mid[0].toFixed(1) +
      " " +
      mid[1].toFixed(1);
  }
  return d + " Z";
}

// emit a shape wrapped at tile offsets, but only copies that intersect the tile
var shapes = [];
var emitBounds = null; // set before calling emit: [cx, cy, boundR]
function emit(pathFn) {
  var offs = [-T, 0, T];
  for (var i = 0; i < 3; i++) {
    for (var j = 0; j < 3; j++) {
      if (emitBounds) {
        var x = emitBounds[0] + offs[i],
          y = emitBounds[1] + offs[j],
          r = emitBounds[2];
        if (x + r < 0 || x - r > T || y + r < 0 || y - r > T) continue;
      }
      shapes.push(pathFn(offs[i], offs[j]));
    }
  }
}

// ---- background washes (large soft tan clouds, very subtle) ----
var washes = [];
for (var w = 0; w < 5; w++) {
  (function () {
    var cx = rr(0, T),
      cy = rr(0, T),
      r = rr(110, 180);
    var col = pick(PALETTE.bgWash);
    emitBounds = [cx, cy, r * 1.4];
    emit(function (dx, dy) {
      return (
        '<path d="' +
        blobPath(cx + dx, cy + dy, r, 0.25, 9) +
        '" fill="' +
        col +
        '" opacity="0.35"/>'
      );
    });
  })();
}

// ---- rosette placement (poisson-ish rejection sampling, torus distance) ----
var centers = [];
function torusDist(a, b) {
  var dx = Math.abs(a[0] - b[0]);
  dx = Math.min(dx, T - dx);
  var dy = Math.abs(a[1] - b[1]);
  dy = Math.min(dy, T - dy);
  return Math.sqrt(dx * dx + dy * dy);
}
var tries = 0;
while (centers.length < 36 && tries < 8000) {
  tries++;
  var c = [rr(0, T), rr(0, T)];
  var ok = true;
  for (var ci = 0; ci < centers.length; ci++) {
    if (torusDist(c, centers[ci]) < 47) {
      ok = false;
      break;
    }
  }
  if (ok) centers.push(c);
}

// ---- rosettes: tan patch + broken black ring of petals ----
centers.forEach(function (c) {
  var cx = c[0],
    cy = c[1];
  var kind = rnd();
  if (kind < 0.72) {
    // full rosette
    var r = rr(10, 21);
    var patchCol = pick(PALETTE.patch);
    var inkCol = pick(PALETTE.ink);
    // tan center patch
    emitBounds = [cx, cy, r * 1.8];
    emit(function (dx, dy) {
      return (
        '<path d="' +
        blobPath(cx + dx, cy + dy, r, 0.28, 7, rr(0.9, 1.25), rr(0, 6.28)) +
        '" fill="' +
        patchCol +
        '"/>'
      );
    });
    // 3-6 ink petals around the rim, with gaps (broken ring)
    var n = 3 + Math.floor(rnd() * 4);
    var a0 = rr(0, Math.PI * 2);
    for (var p = 0; p < n; p++) {
      (function () {
        var ang = a0 + (p / n) * Math.PI * 2 + rr(-0.25, 0.25);
        if (rnd() < 0.18) return; // extra gap sometimes
        var pr = r * rr(0.95, 1.2);
        var px = cx + Math.cos(ang) * pr;
        var py = cy + Math.sin(ang) * pr;
        var pw = rr(4.5, 8) * (r / 14);
        var rot = ang + Math.PI / 2 + rr(-0.3, 0.3);
        emitBounds = [px, py, pw * 3.2];
        emit(function (dx, dy) {
          return (
            '<path d="' +
            blobPath(px + dx, py + dy, pw, 0.32, 6, rr(1.5, 2.3), rot) +
            '" fill="' +
            inkCol +
            '"/>'
          );
        });
      })();
    }
  } else if (kind < 0.9) {
    // solo ink spot
    var sr = rr(3.5, 7.5);
    var col2 = pick(PALETTE.ink);
    emitBounds = [cx, cy, sr * 2.6];
    emit(function (dx, dy) {
      return (
        '<path d="' +
        blobPath(cx + dx, cy + dy, sr, 0.3, 6, rr(1, 1.8), rr(0, 6.28)) +
        '" fill="' +
        col2 +
        '"/>'
      );
    });
  } else {
    // small open tan fleck with partial outline
    var fr = rr(6, 10);
    var fcol = pick(PALETTE.patch);
    emitBounds = [cx, cy, fr * 2.2];
    emit(function (dx, dy) {
      return (
        '<path d="' +
        blobPath(cx + dx, cy + dy, fr, 0.3, 6, rr(1, 1.6), rr(0, 6.28)) +
        '" fill="' +
        fcol +
        '" opacity="0.85"/>'
      );
    });
    var col3 = pick(PALETTE.ink);
    var ang3 = rr(0, 6.28);
    emitBounds = [cx, cy, fr * 3.5];
    emit(function (dx, dy) {
      return (
        '<path d="' +
        blobPath(
          cx + dx + Math.cos(ang3) * fr,
          cy + dy + Math.sin(ang3) * fr,
          rr(3, 5),
          0.3,
          6,
          rr(1.6, 2.2),
          ang3 + 1.57,
        ) +
        '" fill="' +
        col3 +
        '"/>'
      );
    });
  }
});

// tiny scattered flecks
for (var f = 0; f < 22; f++) {
  (function () {
    var cx = rr(0, T),
      cy = rr(0, T),
      r = rr(1.2, 2.6);
    var col = pick(PALETTE.ink);
    emitBounds = [cx, cy, r * 3];
    emit(function (dx, dy) {
      return (
        '<path d="' +
        blobPath(cx + dx, cy + dy, r, 0.35, 5) +
        '" fill="' +
        col +
        '" opacity="0.9"/>'
      );
    });
  })();
}

var svg =
  '<svg xmlns="http://www.w3.org/2000/svg" width="' +
  T +
  '" height="' +
  T +
  '" viewBox="0 0 ' +
  T +
  " " +
  T +
  '">' +
  '<rect width="' +
  T +
  '" height="' +
  T +
  '" fill="' +
  PALETTE.bg +
  '"/>' +
  shapes.join("") +
  "</svg>";

require("fs").writeFileSync(__dirname + "/panther_tile.svg", svg);
console.log(
  "tile bytes:",
  svg.length,
  "rosettes:",
  centers.length,
  "seed:",
  SEED,
);
