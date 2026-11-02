/**
 * lively.identity.TurtleCanvas
 *
 * The painter for a Logo cell's turtle picture (LOGO.md 6.2, 7.4). It turns the draw operations the engine's turtle emits
 * (core/lib/logo/src/turtle.js: line, arc, label, fill, polygon, bg, clear) into pixels on a <canvas>, draws the turtle
 * itself on a second canvas above it, and offers the toolbar's actions: light paper, clear, save as PNG, save as SVG.
 *
 * Why it keeps the operations. The engine holds no picture (LOGO.md decision 8); this painter holds the operation log
 * since the last clear, so the picture can be redrawn whenever the canvas is resized, the paper colour is toggled, or an
 * SVG is asked for. Each new batch is drawn onto the bitmap as it arrives and appended to the log; a redraw replays the
 * log from the start. The log is capped like the engine's own counter (see MAX_LOG) so a runaway program cannot use up
 * the page's memory; the engine stops sending past its cap anyway.
 *
 * Coordinates. Operations are in "screen space": the turtle's logical coordinates already multiplied by the scrunch,
 * origin at the window centre, +x right, +y UP, the window being [-half, half] on both axes (half arrives with the turtle
 * state, 250 by default). The painter draws in exactly those units by putting a y-flipped transform on the canvas
 * context, so no operation is converted point by point; only text is flipped back, and arcs account for the flip.
 *
 * Paper. The bitmap is transparent where nothing was drawn, and the canvas element's CSS background is the paper colour
 * (the `bg` operation sets it). That makes the erasing pen a plain "destination-out" and means a background change never
 * touches the drawn lines. "Light paper" swaps pure black and pure white at paint time only (strokes, fills, the paper), so a
 * program's colour numbers keep their meaning while the picture can look like the printed books.
 *
 * Use. One painter per output pane: `TurtleCanvas.create(host)` with the graphics host element the pane made
 * (createSchemeOutput's graphicsHost, which holds one <canvas>). The painter adds its overlay canvas and toolbar to that
 * host. Then `painter.apply(ops, turtle)` for each draw message. Do NOT call it with another painter's operations, and do
 * not draw into the canvas yourself: a resize would erase it.
 */

module('lively.identity.TurtleCanvas')
  .requires()
  .toRun(function () {

    // Operations kept for replay, per painter. Matches the engine's cap (turtle.js MAX_OPS).
    var MAX_LOG = 500000;
    // The window half-size until the turtle state says otherwise.
    var DEFAULT_HALF = 250;

    function rgb(c) { return 'rgb(' + c[0] + ',' + c[1] + ',' + c[2] + ')'; }

    // The colour as painted: on light paper pure black and pure white trade places.
    function paper(c, light) {
      if (!light) return c;
      if (c[0] === 0 && c[1] === 0 && c[2] === 0) return [255, 255, 255];
      if (c[0] === 255 && c[1] === 255 && c[2] === 255) return [0, 0, 0];
      return c;
    }

    function escapeXml(s) {
      return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    // A flood fill on the bitmap: every pixel connected to (x, y) that is as empty (alpha < 128) as the seed becomes `color`,
    // fully opaque. The manual calls FILL "not portable"; this is the behaviour that suits a transparent-layer picture. If
    // the seed pixel is already part of a line it fills the connected line pixels instead, which is how it behaves on paper
    // too. Scanline algorithm; a fill touching a huge area costs one getImageData / putImageData.
    function floodFill(ctx, w, h, px, py, color) {
      px = Math.floor(px); py = Math.floor(py);
      if (px < 0 || py < 0 || px >= w || py >= h) return;
      var img = ctx.getImageData(0, 0, w, h), d = img.data;
      var seedEmpty = d[(py * w + px) * 4 + 3] < 128;
      function matches(i) { return (d[i * 4 + 3] < 128) === seedEmpty; }
      if (!seedEmpty && d[(py * w + px) * 4] === color[0] && d[(py * w + px) * 4 + 1] === color[1] && d[(py * w + px) * 4 + 2] === color[2]) return;
      var seen = new Uint8Array(w * h);
      var stack = [py * w + px];
      while (stack.length) {
        var i = stack.pop();
        if (seen[i] || !matches(i)) continue;
        var y = Math.floor(i / w), x = i - y * w;
        var left = x, right = x;
        while (left > 0 && !seen[y * w + left - 1] && matches(y * w + left - 1)) left--;
        while (right < w - 1 && !seen[y * w + right + 1] && matches(y * w + right + 1)) right++;
        for (var xx = left; xx <= right; xx++) {
          var j = y * w + xx;
          seen[j] = 1;
          d[j * 4] = color[0]; d[j * 4 + 1] = color[1]; d[j * 4 + 2] = color[2]; d[j * 4 + 3] = 255;
          if (y > 0 && !seen[j - w] && matches(j - w)) stack.push(j - w);
          if (y < h - 1 && !seen[j + w] && matches(j + w)) stack.push(j + w);
        }
      }
      ctx.putImageData(img, 0, 0);
    }

    lively.identity.TurtleCanvas = {

      MAX_LOG: MAX_LOG,

      // Makes the painter for `host` (the pane's graphics element: a div holding the one <canvas>). Returns
      //   { apply(ops, turtle), setLight(bool), isLight(), clear(), toDataURL(cb), toSVG(), redraw(), log(), destroy() }.
      create: function (host) {
        var canvas = host.querySelector('canvas');
        var overlay = document.createElement('canvas');
        overlay.className = 'lively-code-cell-canvas lively-code-cell-turtle-layer';
        var ctx = canvas.getContext('2d');
        var octx = overlay.getContext('2d');
        // The two canvases share a stage so the overlay covers exactly the picture and not the toolbar below it. The overlay
        // never takes a click.
        var stage = document.createElement('div');
        stage.className = 'lively-code-cell-stage';
        stage.style.cssText = 'position:relative;';
        overlay.style.cssText = 'position:absolute;left:0;top:0;width:100%;height:100%;background:transparent;pointer-events:none;';
        host.insertBefore(stage, canvas);
        stage.appendChild(canvas);
        stage.appendChild(overlay);

        var log = [];           // operations since the last clear, for replay and SVG
        var logFull = false;
        var half = DEFAULT_HALF;
        var turtle = null;      // the last turtle state
        var bg = [0, 0, 0];     // the paper colour as the program set it
        var light = false;
        var scale = 1, pxSize = 0;
        var overlayQueued = false;
        var destroyed = false;

        // Sets the drawing buffers to the element's CSS size (times the device pixel ratio) and the transform that maps
        // logical coordinates, y up, onto them. Returns true if the size changed (the bitmap was wiped by that).
        function fit() {
          var rect = canvas.getBoundingClientRect();
          var css = Math.max(1, Math.round(rect.width || 480));
          var dpr = window.devicePixelRatio || 1;
          var size = Math.max(1, Math.round(css * dpr));
          if (size === pxSize && canvas.width === size) return false;
          pxSize = size;
          canvas.width = size; canvas.height = size;
          overlay.width = size; overlay.height = size;
          return true;
        }
        function setTransform(c) {
          scale = pxSize / (2 * half);
          c.setTransform(scale, 0, 0, -scale, pxSize / 2, pxSize / 2);
        }

        function strokeStyleFor(c, mode) {
          return mode === 'erase' ? '#000' : rgb(paper(mode === 'reverse' ? [255, 255, 255] : c, light));
        }
        function composite(mode) {
          return mode === 'erase' ? 'destination-out' : (mode === 'reverse' ? 'difference' : 'source-over');
        }

        // The paper: the canvas element's CSS background. It is state of its own, not part of the log, because CLEAN keeps the
        // background.
        function applyPaper() { canvas.style.backgroundColor = rgb(paper(bg, light)); }

        // Paints one operation onto the base canvas (the transform is already set).
        function paint(op) {
          switch (op.op) {
            case 'line':
              ctx.globalCompositeOperation = composite(op.m);
              ctx.strokeStyle = strokeStyleFor(op.c, op.m);
              ctx.lineWidth = Math.max(op.w, 1 / scale);   // never thinner than one device pixel
              ctx.lineCap = 'round';
              ctx.beginPath(); ctx.moveTo(op.x1, op.y1); ctx.lineTo(op.x2, op.y2); ctx.stroke();
              break;
            case 'arc': {
              ctx.globalCompositeOperation = composite(op.m);
              ctx.strokeStyle = strokeStyleFor(op.c, op.m);
              ctx.lineWidth = Math.max(op.w, 1 / scale);   // never thinner than one device pixel
              var t0 = (90 - op.heading) * Math.PI / 180;       // heading is clockwise from up; canvas angles (y up) are counterclockwise from +x
              var t1 = t0 - op.angle * Math.PI / 180;
              ctx.beginPath(); ctx.ellipse(op.x, op.y, Math.max(op.rx, 0.01), Math.max(op.ry, 0.01), 0, t0, t1, op.angle > 0); ctx.stroke();
              break;
            }
            case 'label':
              ctx.globalCompositeOperation = 'source-over';
              ctx.fillStyle = rgb(paper(op.c, light));
              ctx.save();
              ctx.translate(op.x, op.y); ctx.scale(1, -1);       // text must not be mirrored
              ctx.font = Math.max(op.h * 0.8, 1) + 'px sans-serif';
              ctx.textBaseline = 'bottom';
              ctx.fillText(op.text, 0, 0);
              ctx.restore();
              break;
            case 'polygon': {
              ctx.globalCompositeOperation = 'source-over';
              ctx.beginPath();
              op.pts.forEach(function (p, i) { if (i === 0) ctx.moveTo(p[0], p[1]); else ctx.lineTo(p[0], p[1]); });
              ctx.closePath();
              ctx.fillStyle = rgb(paper(op.fill, light)); ctx.fill();
              ctx.strokeStyle = rgb(paper(op.c, light)); ctx.lineWidth = 1; ctx.stroke();
              break;
            }
            case 'fill': {
              // Pixel work in buffer coordinates: undo the transform for the duration.
              var m = ctx.getTransform();
              ctx.setTransform(1, 0, 0, 1, 0, 0);
              var bx = op.x * scale + pxSize / 2, by = pxSize / 2 - op.y * scale;
              floodFill(ctx, pxSize, pxSize, bx, by, paper(op.c, light));
              ctx.setTransform(m);
              break;
            }
          }
        }

        // The turtle on the overlay: a triangle (or a small turtle) with its position at the midpoint of the base, drawn one
        // step behind its true position so it does not hide a line drawn straight ahead (the manual's description).
        function paintTurtle() {
          overlayQueued = false;
          if (destroyed) return;
          octx.setTransform(1, 0, 0, 1, 0, 0);
          octx.clearRect(0, 0, pxSize, pxSize);
          if (!turtle || !turtle.shown) return;
          setTransform(octx);
          var h = turtle.heading * Math.PI / 180;
          var dx = Math.sin(h), dy = Math.cos(h);               // unit vector ahead, y up
          var step = 1 / scale;                                  // one pixel in logical units
          var bx = turtle.x - dx * step, by = turtle.y - dy * step;
          var len = 14, halfBase = 6;
          var col = rgb(paper(turtle.color || [255, 255, 255], light));
          octx.fillStyle = col; octx.strokeStyle = col; octx.lineWidth = 1;
          octx.beginPath();
          if (turtle.shape === 'turtle') {
            // A body, a head and four feet, small enough to read at a glance.
            var px = -dy, py = dx;                               // unit vector to the turtle's left
            octx.arc(bx + dx * 8, by + dy * 8, 7, 0, 2 * Math.PI);
            octx.moveTo(bx + dx * 17, by + dy * 17);
            octx.arc(bx + dx * 17, by + dy * 17, 3, 0, 2 * Math.PI);
            [[1, 1], [1, -1], [-1, 1], [-1, -1]].forEach(function (s) {
              var fx = bx + dx * (8 + 5 * s[0]) + px * 7 * s[1], fy = by + dy * (8 + 5 * s[0]) + py * 7 * s[1];
              octx.moveTo(fx + 2, fy); octx.arc(fx, fy, 2, 0, 2 * Math.PI);
            });
            octx.fill();
          } else {
            octx.moveTo(bx + dx * len, by + dy * len);
            octx.lineTo(bx - dy * halfBase, by + dx * halfBase);
            octx.lineTo(bx + dy * halfBase, by - dx * halfBase);
            octx.closePath();
            octx.fill();
          }
        }
        function queueTurtle() {
          if (overlayQueued) return;
          overlayQueued = true;
          if (typeof requestAnimationFrame === 'function') requestAnimationFrame(paintTurtle); else setTimeout(paintTurtle, 0);
        }

        // Wipes the bitmap and replays the whole log (after a resize, a paper change, or a clear that dropped the log).
        function redraw() {
          fit();
          setTransform(ctx);
          ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, pxSize, pxSize); ctx.restore();
          setTransform(ctx);
          applyPaper();
          log.forEach(paint);
          queueTurtle();
        }

        var observer = null;
        if (typeof ResizeObserver === 'function') {
          observer = new ResizeObserver(function () {
            if (destroyed) return;
            var before = pxSize;
            fit();
            if (pxSize !== before) redraw();
          });
          observer.observe(canvas);
        }
        fit();
        setTransform(ctx);
        applyPaper();

        // The toolbar. Clear wipes the picture on screen only; the turtle and the workspace are untouched.
        var bar = document.createElement('div');
        bar.className = 'lively-code-cell-graphics-bar';
        function button(label, title, onClick) {
          var b = document.createElement('button');
          b.type = 'button'; b.textContent = label; b.title = title;
          b.addEventListener('mousedown', function (e) { e.preventDefault(); e.stopPropagation(); });
          b.addEventListener('click', function (e) { e.stopPropagation(); onClick(b); });
          bar.appendChild(b);
          return b;
        }

        var painter = {
          apply: function (ops, state) {
            if (destroyed) return;
            if (state) {
              turtle = state;
              if (state.half && state.half[0] !== half) { half = state.half[0]; redraw(); }
            }
            if (ops && ops.length) {
              setTransform(ctx);
              for (var i = 0; i < ops.length; i++) {
                var op = ops[i];
                if (op.op === 'bg') { bg = op.c; applyPaper(); continue; }
                if (op.op === 'clear') {
                  log = [];
                  ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, pxSize, pxSize); ctx.restore();
                  continue;
                }
                if (log.length < MAX_LOG) log.push(op); else logFull = true;
                paint(op);
              }
            }
            queueTurtle();
          },
          setLight: function (on) {
            light = !!on;
            redraw();
          },
          isLight: function () { return light; },
          // Clears the picture on screen.
          clear: function () {
            log = [];
            redraw();
          },
          redraw: redraw,
          log: function () { return log.slice(); },
          logTruncated: function () { return logFull; },
          // Calls back with a PNG data URL of the picture as painted (paper included), without the turtle.
          toDataURL: function (cb) {
            var out = document.createElement('canvas');
            out.width = canvas.width; out.height = canvas.height;
            var o = out.getContext('2d');
            o.fillStyle = canvas.style.backgroundColor || 'rgb(0,0,0)';
            o.fillRect(0, 0, out.width, out.height);
            o.drawImage(canvas, 0, 0);
            cb(out.toDataURL('image/png'));
          },
          // The picture as an SVG document (string). Lines, arcs, labels, polygons and the paper; FILL (a pixel operation)
          // and the reversing pen are not representable and are left out.
          toSVG: function () {
            var size = 2 * half;
            var X = function (x) { return +(x + half).toFixed(3); };
            var Y = function (y) { return +(half - y).toFixed(3); };
            var paperColor = bg;
            var parts = ['<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + size + ' ' + size + '" width="' + size + '" height="' + size + '">',
              '<rect width="' + size + '" height="' + size + '" fill="' + rgb(paper(paperColor, light)) + '"/>'];
            log.forEach(function (o) {
              var stroke = o.m === 'erase' ? rgb(paper(paperColor, light)) : (o.c ? rgb(paper(o.c, light)) : '');
              if (o.op === 'line' && o.m !== 'reverse') {
                parts.push('<line x1="' + X(o.x1) + '" y1="' + Y(o.y1) + '" x2="' + X(o.x2) + '" y2="' + Y(o.y2) + '" stroke="' + stroke +
                  '" stroke-width="' + Math.max(o.w, 1) + '" stroke-linecap="round"/>');
              } else if (o.op === 'arc' && o.m !== 'reverse') {
                var t0 = (90 - o.heading) * Math.PI / 180, t1 = t0 - o.angle * Math.PI / 180;
                if (Math.abs(o.angle) >= 360) {
                  parts.push('<ellipse cx="' + X(o.x) + '" cy="' + Y(o.y) + '" rx="' + o.rx + '" ry="' + o.ry + '" fill="none" stroke="' + stroke + '" stroke-width="' + Math.max(o.w, 1) + '"/>');
                } else {
                  var sx = o.x + o.rx * Math.cos(t0), sy = o.y + o.ry * Math.sin(t0), ex = o.x + o.rx * Math.cos(t1), ey = o.y + o.ry * Math.sin(t1);
                  parts.push('<path d="M ' + X(sx) + ' ' + Y(sy) + ' A ' + o.rx + ' ' + o.ry + ' 0 ' + (Math.abs(o.angle) > 180 ? 1 : 0) + ' ' + (o.angle > 0 ? 1 : 0) + ' ' +
                    X(ex) + ' ' + Y(ey) + '" fill="none" stroke="' + stroke + '" stroke-width="' + Math.max(o.w, 1) + '"/>');
                }
              } else if (o.op === 'label') {
                parts.push('<text x="' + X(o.x) + '" y="' + Y(o.y) + '" font-family="sans-serif" font-size="' + Math.max(o.h * 0.8, 1) + '" fill="' + rgb(paper(o.c, light)) + '">' + escapeXml(o.text) + '</text>');
              } else if (o.op === 'polygon') {
                parts.push('<polygon points="' + o.pts.map(function (p) { return X(p[0]) + ',' + Y(p[1]); }).join(' ') + '" fill="' + rgb(paper(o.fill, light)) + '" stroke="' + rgb(paper(o.c, light)) + '"/>');
              }
            });
            parts.push('</svg>');
            return parts.join('\n');
          },
          destroy: function () {
            destroyed = true;
            if (observer) observer.disconnect();
          },
        };

        function download(href, name) {
          var a = document.createElement('a');
          a.href = href; a.download = name;
          document.body.appendChild(a); a.click(); document.body.removeChild(a);
        }
        button('Clear', 'Wipe the picture (the turtle and the workspace are not touched)', function () { painter.clear(); });
        var lightBtn = button('Light paper', 'Show black on white, like the printed books', function () {
          painter.setLight(!painter.isLight());
          lightBtn.classList.toggle('lively-code-cell-toggle-on', painter.isLight());
        });
        button('Save PNG', 'Download the picture as a PNG image', function () {
          painter.toDataURL(function (url) { download(url, 'turtle.png'); });
        });
        button('Save SVG', 'Download the picture as an SVG drawing (FILL is not included)', function () {
          var url = URL.createObjectURL(new Blob([painter.toSVG()], { type: 'image/svg+xml' }));
          download(url, 'turtle.svg');
          setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
        });
        host.appendChild(bar);

        return painter;
      },
    };

  });
