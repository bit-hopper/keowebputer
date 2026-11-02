/**
 * lively.ide.tools.SearchThumbnail
 *
 * Real thumbnails for the search palette's preview pane. No UI here: each
 * source produces a plain thumbnail object
 *   { kind: "img", src, revoke? }   an image URL (revoke: a blob URL to free)
 *   { kind: "code", text }          a source excerpt
 * and the palette decides where to show it.
 *
 *   live morph          rendered with the framework's own html2canvas helper
 *                       (lively.morphic.Preview), one at a time, with a timeout
 *   saved world / a morph inside one
 *                       drawn on a canvas from the serialized registry (shapes,
 *                       fills, borders, text, same-origin images): the world is
 *                       never loaded or run
 *   public image file   its own bytes (a private file would need a passkey
 *                       decrypt, so it keeps the drawn art)
 *   code                the first lines of the method's source
 */

module("lively.ide.tools.SearchThumbnail").requires().toRun(function () {

Object.extend(lively.ide.tools.SearchThumbnail, {

  MAX_W: 640,
  MAX_H: 360,
  MORPH_TIMEOUT: 5000,
  MAX_FILE_BYTES: 3 * 1024 * 1024,
  MAX_DRAWN: 500,        // morphs drawn from a registry
  MAX_IMAGES: 12,        // same-origin images preloaded for a registry drawing
  CODE_LINES: 12,

  // Which source an item uses, and the cache key for it ("" when it has none).
  // Code is synchronous and needs no key.
  keyFor: function (item) {
    var info = item.info || {};
    if (item.morph) return "m:" + item.morph.id;
    if (info.thumb && info.thumb.registry) return "r:" + (item.url || "") + ":" + info.thumb.rootId;
    if (info.fileThumb) return "f:" + info.fileThumb.objId;
    return "";
  },

  forCode: function (item) {
    var src = item.info && item.info.source;
    if (!src) return null;
    var lines = String(src).split("\n").slice(0, lively.ide.tools.SearchThumbnail.CODE_LINES);
    return { kind: "code", text: lines.map(function (l) { return l.length > 70 ? l.slice(0, 69) + "…" : l; }).join("\n") };
  },

  // Starts the item's async thumbnail; thenDo(err, thumb). Morph renders are
  // queued so only one html2canvas runs at a time.
  // wanted() (optional) is asked just before a queued render starts: a highlight
  // that has moved on costs nothing.
  load: function (item, thenDo, wanted) {
    var T = lively.ide.tools.SearchThumbnail, info = item.info || {};
    if (item.morph) return T._queued(function (next) {
      if (wanted && !wanted()) { next(); return thenDo(new Error("no longer wanted")); }
      T.forMorph(item.morph, function (e, t) { next(); thenDo(e, t); });
    });
    if (info.thumb && info.thumb.registry) return T.forRegistry(info.thumb, thenDo);
    if (info.fileThumb) return T.forFile(info.fileThumb, thenDo);
    thenDo(new Error("no thumbnail source"));
  },

  _queue: null,
  _queued: function (job) {
    var T = lively.ide.tools.SearchThumbnail;
    T._queue = (T._queue || Promise.resolve()).then(function () {
      return new Promise(function (resolve) { job(resolve); });
    });
  },

  _scaled: function (canvas) {
    var T = lively.ide.tools.SearchThumbnail,
      k = Math.min(1, T.MAX_W / canvas.width, T.MAX_H / canvas.height);
    if (k >= 1) return canvas.toDataURL("image/png");
    var out = document.createElement("canvas");
    out.width = Math.max(1, Math.round(canvas.width * k));
    out.height = Math.max(1, Math.round(canvas.height * k));
    out.getContext("2d").drawImage(canvas, 0, 0, out.width, out.height);
    return out.toDataURL("image/png");
  },

  // ---- live morph

  forMorph: function (morph, thenDo) {
    var T = lively.ide.tools.SearchThumbnail, finished = false;
    function finish(err, thumb) {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      thenDo(err, thumb);
    }
    var timer = setTimeout(function () { finish(new Error("thumbnail timed out")); }, T.MORPH_TIMEOUT);
    lively.require("lively.morphic.Preview").toRun(function () {
      try {
        if (!morph.world()) return finish(new Error("morph is gone"));
        lively.morphic.Preview.renderNode(morph.renderContext().shapeNode, {}, function (err, canvas) {
          if (err || !canvas || !canvas.width || !canvas.height) return finish(err || new Error("empty render"));
          try { finish(null, { kind: "img", src: T._scaled(canvas) }); } catch (e) { finish(e); }
        });
      } catch (e) {
        finish(e);
      }
    });
  },

  // ---- public image file

  forFile: function (spec, thenDo) {
    lively.require("lively.identity.FileCrypto").toRun(function () {
      try {
        var handle = lively.identity.did.currentUser().handle;
        lively.identity.fileCrypto.objectUrlFor(handle, spec.objId, function (err, url) {
          if (err || !url) return thenDo(err || new Error("no url"));
          thenDo(null, { kind: "img", src: url, revoke: /^blob:/.test(url) });
        });
      } catch (e) {
        thenDo(e);
      }
    });
  },

  // ---- saved world (or a morph in one), drawn from its serialized registry

  _pt: function (s) {
    var m = /^lively\.pt\(\s*(-?[\d.eE+-]+)\s*,\s*(-?[\d.eE+-]+)\s*\)$/.exec(String(s || ""));
    return m ? { x: +m[1], y: +m[2] } : null;
  },

  _color: function (s) {
    var m = /^Color\.rgba?\(([^)]*)\)$/.exec(String(s || ""));
    if (!m) return null;
    var p = m[1].split(",").map(Number);
    if (p.length < 3 || p.some(isNaN)) return null;
    return "rgba(" + p[0] + "," + p[1] + "," + p[2] + "," + (p.length > 3 ? p[3] : 1) + ")";
  },

  // spec: { registry, rootId }. Calls thenDo(err, thumb). Only same-origin images
  // are fetched (the world's own blobs), a few at a time, with a short timeout.
  forRegistry: function (spec, thenDo) {
    var T = lively.ide.tools.SearchThumbnail, reg = spec.registry, finished = false;
    function finish(err, thumb) { if (!finished) { finished = true; thenDo(err, thumb); } }
    try {
      var root = reg[spec.rootId];
      if (!root) return finish(new Error("no root"));
      var rootShape = root.shape && reg[root.shape.id],
        ext = rootShape && T._pt(rootShape._Extent);
      if (!ext || ext.x < 1 || ext.y < 1) return finish(new Error("root has no size"));

      // preload the registry's same-origin images
      var urls = [];
      Object.keys(reg).forEach(function (k) {
        var e = reg[k], u = e && e.__LivelyClassName__ === "lively.morphic.Shapes.Image" && e._ImageURL;
        if (!u || urls.length >= T.MAX_IMAGES) return;
        try { if (new URL(u, location.href).origin === location.origin && urls.indexOf(u) < 0) urls.push(u); } catch (e2) { /* not a URL */ }
      });
      var images = {}, pending = urls.length, started = false;
      function drawAll() {
        if (started) return;
        started = true;
        try { finish(null, { kind: "img", src: T._draw(reg, spec.rootId, ext, images) }); } catch (e) { finish(e); }
      }
      if (!pending) return drawAll();
      urls.forEach(function (u) {
        var img = new Image();
        img.onload = function () { images[u] = img; if (!--pending) drawAll(); };
        img.onerror = function () { if (!--pending) drawAll(); };
        img.src = u;
      });
      setTimeout(drawAll, 2000);   // do not wait for slow images
    } catch (e) {
      finish(e);
    }
  },

  _draw: function (reg, rootId, ext, images) {
    var T = lively.ide.tools.SearchThumbnail,
      k = Math.min(T.MAX_W / ext.x, T.MAX_H / ext.y, 2),
      canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(ext.x * k));
    canvas.height = Math.max(1, Math.round(ext.y * k));
    var ctx = canvas.getContext("2d"), budget = { n: T.MAX_DRAWN };
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    function rr(x, y, w, h, r) {
      r = Math.max(0, Math.min(r, w / 2, h / 2));
      ctx.beginPath();
      ctx.moveTo(x + r, y);
      ctx.arcTo(x + w, y, x + w, y + h, r);
      ctx.arcTo(x + w, y + h, x, y + h, r);
      ctx.arcTo(x, y + h, x, y, r);
      ctx.arcTo(x, y, x + w, y, r);
      ctx.closePath();
    }

    function drawMorph(id, ox, oy, isRoot) {
      var e = reg[id];
      if (!e || budget.n <= 0) return;
      var cls = e.__LivelyClassName__ || "";
      if (/HandMorph|Menu|Halo|Epi|Selection/.test(cls)) return;
      var p = isRoot ? { x: 0, y: 0 } : T._pt(e._Position) || { x: 0, y: 0 },
        x = ox + p.x, y = oy + p.y,
        shape = e.shape && reg[e.shape.id],
        sz = (shape && T._pt(shape._Extent)) || { x: 0, y: 0 },
        px = x * k, py = y * k, w = sz.x * k, h = sz.y * k;
      budget.n--;

      if (shape && w > 0.5 && h > 0.5) {
        var fill = T._color(shape._Fill), bw = parseFloat(shape._BorderWidth) || 0,
          bc = T._color(shape._BorderColor), br = (parseFloat(shape._BorderRadius) || 0) * k,
          img = shape._ImageURL && images[shape._ImageURL];
        if (/Ellipse/.test(shape.__LivelyClassName__ || "")) br = Math.min(w, h) / 2;
        if (fill) { rr(px, py, w, h, br); ctx.fillStyle = fill; ctx.fill(); }
        if (img) {
          ctx.save(); rr(px, py, w, h, br); ctx.clip(); ctx.drawImage(img, px, py, w, h); ctx.restore();
        } else if (shape.__LivelyClassName__ === "lively.morphic.Shapes.Image") {
          rr(px, py, w, h, br); ctx.fillStyle = "#e3e7ef"; ctx.fill();   // an image that is not drawn here
        }
        if (bw > 0 && bc) { rr(px, py, w, h, br); ctx.lineWidth = Math.max(0.5, bw * k); ctx.strokeStyle = bc; ctx.stroke(); }
        var text = typeof e.textString === "string" ? e.textString : typeof e.storedTextString === "string" ? e.storedTextString : "";
        if (text && w > 8 && h > 4) {
          var fs = Math.max(4, (parseFloat(e._FontSize) || 9) * 4 / 3 * k);
          ctx.save();
          rr(px, py, w, h, 0); ctx.clip();
          ctx.font = fs + "px sans-serif";
          ctx.fillStyle = T._color(e._TextColor) || "#222";
          ctx.textBaseline = "top";
          text.split("\n").slice(0, Math.max(1, Math.floor(h / (fs * 1.25)))).forEach(function (line, i) {
            ctx.fillText(line, px + 3 * k, py + 2 * k + i * fs * 1.25);
          });
          ctx.restore();
        }
      }

      var clip = /hidden|scroll|auto/.test(String(e._ClipMode || "")) && w > 0 && h > 0;
      if (clip) { ctx.save(); rr(px, py, w, h, 0); ctx.clip(); }
      (e.submorphs || []).forEach(function (ref) { if (ref && ref.id != null) drawMorph(ref.id, x, y, false); });
      if (clip) ctx.restore();
    }

    drawMorph(rootId, 0, 0, true);
    return canvas.toDataURL("image/png");
  },

});

});
