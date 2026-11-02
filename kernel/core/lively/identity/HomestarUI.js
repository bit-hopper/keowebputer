/**
 * lively.identity.HomestarUI
 *
 * Morph-building helpers and colour tokens shared by the homestar page
 * (Homestar.js) and its postcard reel (PostcardReel.js). Plain functions on a
 * namespace object, so callers can alias them without depending on a closure.
 */

module("lively.identity.HomestarUI")
  .requires("lively.morphic.Complete")
  .toRun(function () {

    var PINK = Color.rgb(0xCC, 0x00, 0x57);              // frame / button color shared with ProfileCard
    var PINK_SOFT = Color.rgb(253, 235, 243);
    var CARD_BORDER = Color.rgb(232, 230, 236);
    var INK = Color.rgb(42, 36, 56);
    var MUTED = Color.rgb(122, 115, 144);

    lively.identity.HomestarUI = {
      PINK: PINK,
      PINK_SOFT: PINK_SOFT,
      PAGE_FILL: Color.rgb(250, 248, 252),
      CARD_BORDER: CARD_BORDER,
      INK: INK,
      MUTED: MUTED,

      // Plain Box/Text/Image morphs default to draggable, droppable and
      // grabbable; all three flags have to go, on every child (CLAUDE.md
      // "Disabling drag/drop/grab").
      noDrag: function (m) {
        m.draggingEnabled = false;
        m.droppingEnabled = false;
        m.grabbingEnabled = false;
        return m;
      },

      // The dim layer behind a modal dialog: a box over the whole viewport that is
      // FIXED to it. A plain world child sized to the viewport at the moment of
      // opening scrolls away with the page (leaving a bright band where the page has
      // since moved), and anything sticking out past the world's bottom grows the
      // document and brings a scrollbar in. A fixed morph is outside the document
      // flow altogether. It follows window resizes (onResize is where the dialog
      // re-centres its panel); pair with closeScrim. Dialog panels are children of
      // it, positioned in viewport coordinates.
      viewportScrim: function (onResize) {
        var UI = lively.identity.HomestarUI;
        var scrim = new lively.morphic.Box(lively.rect(0, 0, 10, 10));
        scrim.applyStyle({ fill: Color.rgba(30, 24, 44, 0.45), borderWidth: 0 });
        UI.noDrag(scrim);
        $world.addMorph(scrim);
        scrim.enableFixedPositioning();
        var place = function () {
          $world.cachedWindowBounds = null;     // the fixed morph's position reads the scroll offset from this
          scrim.setExtent(lively.pt(document.documentElement.clientWidth - 1, window.innerHeight));
          scrim.setPosition(lively.pt(0, window.pageYOffset || 0));   // page coordinates: this is the top of the viewport
        };
        place();
        scrim._onWindowResize = function () { place(); if (onResize) onResize(); };
        window.addEventListener("resize", scrim._onWindowResize);
        return scrim;
      },

      closeScrim: function (scrim) {
        if (!scrim) return;
        window.removeEventListener("resize", scrim._onWindowResize);
        scrim.remove();
      },

      // Is the click on the panel? Judged on the real node (page coordinates), so it
      // stays right however far the page has scrolled since the dialog opened.
      pointOnPanel: function (panel, evt) {
        var r = panel.renderContext().shapeNode.getBoundingClientRect();
        var p = evt.getPosition();
        var x = p.x - (window.pageXOffset || 0), y = p.y - (window.pageYOffset || 0);
        return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
      },

      // A scrolling list's scrollbar: thin and in the page's colours instead of the
      // browser's classic one with arrow buttons, and its space reserved from the start
      // so the rows do not shift sideways when the list loads and starts to overflow.
      // Call it once the morph exists (it styles the real node).
      scroller: function (m) {
        var s = m.renderContext().shapeNode.style;
        s.scrollbarWidth = "thin";
        s.scrollbarColor = "rgb(206, 200, 222) transparent";
        s.scrollbarGutter = "stable";
        return m;
      },

      trunc: function (s, max) {
        s = String(s == null ? "" : s);
        return s.length > max ? s.slice(0, max - 1).replace(/\s+$/, "") + "…" : s;
      },

      // A glyph's run width is ~0.6em for the sans fonts used here; used only to
      // size hug-fit pills/chips from their text, with generous padding so a
      // mis-estimate shows as extra air rather than a clipped word.
      textW: function (s, px, bold) {
        return Math.ceil(String(s).length * px * (bold ? 0.64 : 0.58));
      },

      label: function (rect, text, opts) {
        opts = opts || {};
        var t = new lively.morphic.Text(rect);
        t.textString = text;
        t.applyStyle({
          fontSize: (opts.px || 13) * 0.75,
          fontWeight: opts.bold ? "bold" : "normal",
          textColor: opts.color || INK,
          fill: null, borderWidth: 0,
          align: opts.align || "left",
          allowInput: false, selectable: false,
          clipMode: "hidden",
          whiteSpaceHandling: opts.wrap ? "normal" : "pre",
        });
        lively.identity.HomestarUI.noDrag(t);
        t.eventsAreIgnored = true;
        return t;
      },

      // Material Symbols glyph; the box is sized from the glyph's designed px
      // size rather than measured (CLAUDE.md "Icons").
      icon: function (rect, ligature, px, color) {
        var t = new lively.morphic.Text(rect, ligature);
        t.applyStyle({
          fontFamily: "'Material Symbols Rounded'", fontSize: px * 0.75,
          textColor: color || MUTED, fill: null, borderWidth: 0, align: "center",
          allowInput: false, selectable: false, clipMode: "hidden", whiteSpaceHandling: "pre",
        });
        lively.identity.HomestarUI.noDrag(t);
        t.eventsAreIgnored = true;
        return t;
      },

      panel: function (rect) {
        var b = new lively.morphic.Box(rect);
        b.applyStyle({ fill: Color.white, borderWidth: 1, borderColor: CARD_BORDER, borderRadius: 14, clipMode: "hidden" });
        lively.identity.HomestarUI.noDrag(b);
        return b;
      },

      // A rounded pill button: a Box that owns the click, with a non-interactive
      // label centered inside. opts: { primary, onClick, w, h, disabled }.
      pill: function (x, y, text, opts) {
        var UI = lively.identity.HomestarUI;
        var px = 12;
        var h = opts.h || 30;
        var w = opts.w || (UI.textW(text, px, true) + 36);
        var fill = opts.primary ? PINK : Color.white;
        var hover = opts.primary ? Color.rgb(0xA8, 0x00, 0x48) : PINK_SOFT;
        var box = new lively.morphic.Box(lively.rect(x, y, w, h));
        box.applyStyle({ fill: fill, borderRadius: h / 2, borderWidth: 1, borderColor: opts.disabled ? CARD_BORDER : PINK, clipMode: "hidden" });
        UI.noDrag(box);
        var lineH = 18;
        var t = UI.label(lively.rect(0, Math.round((h - lineH) / 2) - 2, w, lineH + 4), text, {
          px: px, bold: true, align: "center",
          color: opts.disabled ? MUTED : (opts.primary ? Color.white : PINK),
        });
        box.addMorph(t);
        if (!opts.disabled) {
          box.applyStyle({ handStyle: "pointer" });
          box.onMouseOver = function () { box.applyStyle({ fill: hover }); };
          box.onMouseOut  = function () { box.applyStyle({ fill: fill }); };
          box.onMouseUp = function (evt) { evt.stop(); if (opts.onClick) opts.onClick(box); return true; };
        }
        return box;
      },

      getJSON: function (path, thenDo) {
        fetch(path, { credentials: "include", headers: { Accept: "application/json" } })
          .then(function (res) { return res.ok ? res.json() : null; })
          .then(function (body) { thenDo(null, body); })
          .catch(function (err) { thenDo(err, null); });
      },
    };

  });
