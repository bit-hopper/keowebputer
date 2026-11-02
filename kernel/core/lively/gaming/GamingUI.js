/**
 * lively.gaming.GamingUI
 *
 * Colour tokens and the morph-building helper kit for the Gaming world template.
 * Plain functions on one namespace object (like lively.identity.HomestarUI), never
 * module-local `var`s that a BuildSpec / addScript method would need to reach: a
 * method rebuilt from its own source loses its closure (CLAUDE.md), so anything a
 * handler needs is reached by the dotted path lively.gaming.GamingUI.<name>.
 *
 * WHAT IS HERE, and what to use INSTEAD of hand-rolling it:
 *   theme()                  the resolved colour tokens (light or dark). Read it when you BUILD
 *                            a morph; never recolour a built morph (see "Themes" below).
 *   getThemePref / setThemePref / onThemeChange   the Auto / Light / Dark preference
 *   ensureFonts()            the Caprasimo / Figtree <link>, once per page
 *   textW(text, px, weight, font)  a text's real width, measured on a canvas (use for hug-fit boxes
 *                            instead of reading a span, which races the layout)
 *   fit / fitLines           cut a text to a width with an ellipsis, so it is never clipped mid-glyph
 *                            (use these, not UI.trunc, whenever the box has a real width)
 *   onFontsReady             run once when the web fonts have loaded (widths measured before are off)
 *   label / icon             a Text for words / a Material Symbols glyph
 *   box / panel              a plain Box with the drag flags already cleared
 *   button                   a themed pill button that owns its click
 *   makeInteractive          THE call that turns a clickable morph into a real control: pointer,
 *                            role, aria-label, Tab stop, focus ring, Enter and Space
 *   statusPill / starsText   the status chip and the rating stars
 *   input / textArea         editable text fields (one line / many)
 *   scroller                 the thin themed scrollbar for a clipMode "auto" box
 *   openModal / closeModal   a dialog on a viewport-fixed scrim
 *   toast                    a short message at the bottom of the viewport
 *   coverColors              the placeholder colours for a game with no cover art
 *
 * THEMES. Morphs have no CSS variables, and CLAUDE.md records that applyStyle({fill}) /
 * setTextColor on an already-rendered morph can update the model while the DOM keeps
 * the old paint. So a theme switch REBUILDS the visible morphs from the new tokens
 * (Gaming#rebuild) instead of recolouring them in place. Every builder here reads
 * theme() at the moment it runs.
 */

module("lively.gaming.GamingUI")
  .requires("lively.morphic.Complete", "lively.identity.HomestarUI")
  .toRun(function () {

    // "#rrggbb" -> Color. Keeps the token table below readable.
    function hex(h) {
      return Color.rgb(parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16));
    }

    // The token table. Values were chosen for contrast: white text on the light accent
    // is about 5.4:1 (the usual lighter pink is only ~3.9:1 and fails). Dark is true
    // black, as in the photo gallery's dark theme.
    var THEMES = {
      light: {
        name: "light", bg: hex("#fdf0f5"), surface: hex("#ffffff"), surface2: hex("#f8e6ee"), line: hex("#ecd3df"),
        text: hex("#2a1a22"), muted: hex("#6a5560"), accent: hex("#cc0057"), accentHover: hex("#a80048"),
        onAccent: hex("#ffffff"), accentSoft: hex("#fdebf3"), accentText: hex("#a3003f"), star: hex("#d6246e"),
        impBg: hex("#f4eff2"), danger: hex("#a8231b"), ok: hex("#1f8f66"), scrim: Color.rgba(42, 26, 34, 0.5),
        status: {
          playing: { bg: hex("#fdebf3"), fg: hex("#a3003f") }, completed: { bg: hex("#e3f4ec"), fg: hex("#14604a") },
          backlog: { bg: hex("#e8edf7"), fg: hex("#34456b") }, dropped: { bg: hex("#eeeaec"), fg: hex("#5d5258") },
          wishlist: { bg: hex("#f0e9fa"), fg: hex("#5a3a8a") },
        },
        scrollThumb: "rgb(214, 180, 196)",
      },
      dark: {
        name: "dark", bg: hex("#000000"), surface: hex("#0d0d0f"), surface2: hex("#17171a"), line: hex("#2a2a2f"),
        text: hex("#f2f2f4"), muted: hex("#a9a9b3"), accent: hex("#ff5c8a"), accentHover: hex("#ff7aa0"),
        onAccent: hex("#1a0810"), accentSoft: hex("#2a0f1a"), accentText: hex("#ff8fb0"), star: hex("#ff5c8a"),
        impBg: hex("#131316"), danger: hex("#ff9a90"), ok: hex("#5fd0a8"), scrim: Color.rgba(0, 0, 0, 0.78),
        status: {
          playing: { bg: hex("#2a0f1a"), fg: hex("#ff8fb0") }, completed: { bg: hex("#0e2a20"), fg: hex("#7fe0b8") },
          backlog: { bg: hex("#141c30"), fg: hex("#a9bdf0") }, dropped: { bg: hex("#1f1f23"), fg: hex("#c4c4cc") },
          wishlist: { bg: hex("#1e1630"), fg: hex("#cdb6f5") },
        },
        scrollThumb: "rgb(70, 70, 78)",
      },
    };

    var FONT_DISPLAY = "Caprasimo, serif";
    var FONT_BODY = "Figtree, sans-serif";
    var THEME_KEY = "lively.gaming.theme";
    var themeListeners = [];
    var mediaQuery = null, mediaHandler = null;

    // The status chips are a closed set of five strings, so their widths are measured
    // once (Figtree 600 at 12px, on a canvas) and fixed here: text width + 24px padding.
    // A single Text morph with its own fill and radius is the whole chip; its height is
    // line height + 4 (19), which is what centres the glyph vertically (a round 24
    // leaves it pinned near the top: the Text shape node pads 2px, not symmetrically).
    var STATUS_W = { playing: 64, backlog: 68, completed: 86, dropped: 72, wishlist: 68 };
    var STATUS_LABEL = { playing: "Playing", backlog: "Backlog", completed: "Completed", dropped: "Dropped", wishlist: "Wishlist" };
    var PILL_H = 19;

    lively.gaming.GamingUI = {

      THEMES: THEMES,
      FONT_DISPLAY: FONT_DISPLAY,
      FONT_BODY: FONT_BODY,
      STATUS_W: STATUS_W,
      STATUS_LABEL: STATUS_LABEL,
      PILL_H: PILL_H,
      hex: hex,

      // ─── themes ──────────────────────────────────────────────────────────

      // "auto" | "light" | "dark". Stored per browser (not per account): it is a display
      // preference. Storage can be blocked, so every access is guarded.
      getThemePref: function () {
        try { var v = window.localStorage.getItem(THEME_KEY); if (v === "light" || v === "dark") return v; } catch (e) { /* blocked */ }
        return "auto";
      },

      // Saves the preference and tells every listener, which then rebuild. Listeners
      // are plain functions; onThemeChange returns a function that removes the listener.
      setThemePref: function (pref) {
        try { window.localStorage.setItem(THEME_KEY, pref); } catch (e) { /* blocked */ }
        themeListeners.slice().forEach(function (fn) { fn(); });
      },

      // The resolved tokens: the explicit choice, or the operating system's when "auto".
      theme: function () {
        var pref = lively.gaming.GamingUI.getThemePref();
        if (pref === "auto") pref = (window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches) ? "dark" : "light";
        return THEMES[pref];
      },

      // Calls fn whenever the theme may have changed (the preference was set, or the OS
      // switched while on "auto"). Returns the unsubscribe function: CALL IT when the
      // template is removed, or the listener (and the whole template it closes over) leaks.
      onThemeChange: function (fn) {
        themeListeners.push(fn);
        if (!mediaQuery && window.matchMedia) {
          mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
          mediaHandler = function () {
            if (lively.gaming.GamingUI.getThemePref() === "auto") themeListeners.slice().forEach(function (f) { f(); });
          };
          if (mediaQuery.addEventListener) mediaQuery.addEventListener("change", mediaHandler);
        }
        return function () {
          var i = themeListeners.indexOf(fn);
          if (i >= 0) themeListeners.splice(i, 1);
          if (!themeListeners.length && mediaQuery && mediaHandler) {
            if (mediaQuery.removeEventListener) mediaQuery.removeEventListener("change", mediaHandler);
            mediaQuery = null; mediaHandler = null;
          }
        };
      },

      // ─── fonts and styles ────────────────────────────────────────────────

      // Injects the web-font stylesheet <link> (Caprasimo for titles, Figtree for text) and the
      // few global CSS rules the template needs, once per page. Safe to call again. The
      // fonts load asynchronously: text built before they arrive is simply re-laid-out
      // by the browser, but measure widths with textW (canvas), not from a live node.
      ensureFonts: function () {
        if (!document.getElementById("gaming-fonts")) {
          var l = document.createElement("link");
          l.id = "gaming-fonts"; l.rel = "stylesheet";
          l.href = "https://fonts.googleapis.com/css2?family=Caprasimo&family=Figtree:wght@400;500;600;700&display=swap";
          document.head.appendChild(l);
        }
        if (!document.getElementById("gaming-style")) {
          var st = document.createElement("style");
          st.id = "gaming-style";
          // An editable Text shows a browser focus outline on its inner node; the field draws its own border.
          st.textContent = ".gaming-input, .gaming-input * { outline: none !important; }";
          document.head.appendChild(st);
        }
        lively.gaming.GamingUI._watchFonts();
      },

      // True once the faces the template measures with have loaded.
      fontsReady: function () {
        try { return document.fonts.check("400 12px Figtree") && document.fonts.check("700 12px Figtree") && document.fonts.check("400 20px Caprasimo"); }
        catch (e) { return true; }
      },

      // Calls fn once, when the fonts are loaded (at once, if they already are). WHY: every hug-fit
      // width (buttons, pills, truncation) is measured with textW, and measured before the web fonts
      // arrive it uses the fallback font, so the first paint has buttons a few px too narrow or wide
      // and labels cut short. The template rebuilds once when this fires (Gaming#_setup).
      onFontsReady: function (fn) {
        var UI = lively.gaming.GamingUI;
        if (UI.fontsReady()) return fn();
        (UI._fontWaiters = UI._fontWaiters || []).push(fn);
        UI._watchFonts();
      },

      // Starts loading the faces and runs the waiting callbacks when they are in. Idempotent.
      _watchFonts: function () {
        var UI = lively.gaming.GamingUI;
        if (UI._fontsWatching || !document.fonts || !document.fonts.load) return;
        UI._fontsWatching = true;
        Promise.all(["400 13px Figtree", "600 13px Figtree", "700 13px Figtree", "400 20px Caprasimo"].map(function (f) { return document.fonts.load(f); }))
          .catch(function () { /* offline: the fallback font stays, nothing to wait for */ })
          .then(function () {
            UI._fontsWatching = false;
            var w = UI._fontWaiters || []; UI._fontWaiters = [];
            w.forEach(function (fn) { try { fn(); } catch (e) { console.warn("[GamingUI] font waiter failed:", e); } });
          });
      },

      // The real rendered width of `text` in the body font, measured on a canvas, so it
      // does not depend on a morph being laid out yet (reading a span's offsetWidth right
      // after addMorph can return 0; CLAUDE.md). If the font has not loaded yet the
      // fallback font is measured instead, so callers add a few px of slack.
      // `font` is "display" for the heading face, anything else (or nothing) for the body face.
      textW: function (text, px, weight, font) {
        var c = lively.gaming.GamingUI._cv || (lively.gaming.GamingUI._cv = document.createElement("canvas").getContext("2d"));
        c.font = (weight || 400) + " " + px + "px " + (font === "display" ? FONT_DISPLAY : FONT_BODY);
        return Math.ceil(c.measureText(String(text)).width);
      },

      // `text` cut to fit on ONE line `maxW` px wide, ending in an ellipsis when it had to be cut.
      // Exists because a label box clips whatever does not fit, mid-glyph and with no sign that
      // anything is missing; cutting by measured width (not by character count, as trunc does)
      // makes the cut deliberate. Same arguments as textW, plus the width. A box also carries
      // about 8 px of its own padding: pass its width minus that.
      fit: function (text, px, weight, maxW, font) {
        var UI = lively.gaming.GamingUI, s = String(text == null ? "" : text);
        if (UI.textW(s, px, weight, font) <= maxW) return s;
        var lo = 0, hi = s.length;                       // longest prefix that fits with the ellipsis
        while (lo < hi) {
          var mid = Math.ceil((lo + hi) / 2);
          if (UI.textW(s.slice(0, mid).replace(/\s+$/, "") + "\u2026", px, weight, font) <= maxW) lo = mid; else hi = mid - 1;
        }
        return s.slice(0, lo).replace(/\s+$/, "") + "\u2026";
      },

      // `text` cut to fit in `lines` lines of `maxW` px, as a string the label will wrap the same
      // way: whole words fill the earlier lines, the last line is cut with an ellipsis. For a
      // wrapping label whose box holds a fixed number of lines (a tile's title).
      fitLines: function (text, px, weight, maxW, lines, font) {
        var UI = lively.gaming.GamingUI, words = String(text == null ? "" : text).split(/\s+/).filter(Boolean);
        var out = [], line = "";
        for (var i = 0; i < words.length && out.length < lines - 1; i++) {
          var tryLine = line ? line + " " + words[i] : words[i];
          if (UI.textW(tryLine, px, weight, font) <= maxW) line = tryLine;
          else if (!line) { out.push(UI.fit(words[i], px, weight, maxW, font)); line = ""; }   // one word wider than the line
          else { out.push(line); line = words[i]; }
        }
        // the last line takes everything that is left, cut to fit
        var rest = (line ? [line] : []).concat(words.slice(i)).join(" ");
        if (out.length >= lines) return out.join(" ");
        out.push(UI.fit(rest, px, weight, maxW, font));
        return out.join(" ");
      },

      trunc: function (s, max) { return lively.identity.HomestarUI.trunc(s, max); },

      // ─── basic morphs ────────────────────────────────────────────────────

      // Clears all three drag flags (dragging, dropping AND grabbing: any one left on
      // still lets a click that twitches become a drag, CLAUDE.md).
      noDrag: function (m) { return lively.identity.HomestarUI.noDrag(m); },

      // A plain Box with no drag behaviour. opts: { radius, border (Color), borderWidth, clip }.
      // Not interactive: give it a handler through makeInteractive, or leave it decorative.
      box: function (rect, fill, opts) {
        opts = opts || {};
        var b = new lively.morphic.Box(rect);
        b.applyStyle({
          fill: fill || null, borderWidth: opts.border ? (opts.borderWidth || 1) : 0, borderColor: opts.border || null,
          borderRadius: opts.radius || 0, clipMode: opts.clip === false ? "visible" : "hidden",
        });
        lively.gaming.GamingUI.noDrag(b);
        return b;
      },

      panel: function (rect, th) {
        return lively.gaming.GamingUI.box(rect, th.surface, { radius: 14, border: th.line });
      },

      // A text label. `rect` is the box; the glyphs sit at its top-left (a Text does not
      // centre vertically: size the box to one line and position the BOX). Build a label
      // you will move later at rect(0, 0, w, h) and position it with setPosition: a Text
      // built at rect(x, y) and then moved is offset twice (CLAUDE.md).
      // opts: { px, bold, weight (400..700), color, align, wrap, font: "display"|"body" }
      // Labels ignore events (Lively level) AND let native clicks through (pointer-events),
      // so one laid over a field or a button never swallows the click.
      // A single-line label is never given a box shorter than its line plus the Text's own padding
      // (about 1.3 x the pixel size + 3): a Text clips at its box, so a box sized to "the font size"
      // cuts the bottom off descenders (g, j, p, q, y) and the tails of heavier glyphs. Callers can
      // keep passing the height they had; a too-short one is raised, and being a plain label (no
      // fill, events ignored) nothing else about it changes.
      label: function (rect, text, opts) {
        opts = opts || {};
        var UI = lively.gaming.GamingUI;
        if (!opts.wrap) {
          var need = Math.ceil((opts.px || 13) * 1.3) + 3;
          if (rect.height < need) rect = lively.rect(rect.x, rect.y, rect.width, need);
        }
        var t = new lively.morphic.Text(rect);
        t.textString = text == null ? "" : String(text);
        t.applyStyle({
          fontFamily: opts.font === "display" ? FONT_DISPLAY : FONT_BODY,
          fontSize: (opts.px || 13) * 0.75,                 // fontSize is in POINTS: px * 0.75
          fontWeight: String(opts.weight || (opts.bold ? 700 : 400)),
          textColor: opts.color || UI.theme().text,
          fill: null, borderWidth: 0, borderColor: null,
          align: opts.align || "left",
          allowInput: false, selectable: false, clipMode: "hidden",
          whiteSpaceHandling: opts.wrap ? "normal" : "pre",
          fixedWidth: true, fixedHeight: true,
        });
        UI.noDrag(t);
        t.eventsAreIgnored = true;
        var n = t.renderContext().shapeNode;
        if (n) n.style.pointerEvents = "none";
        return t;
      },

      // A Material Symbols glyph (the font is vendored and loaded with the world). The
      // box is sized from the glyph's DESIGNED size, never measured: measuring right
      // after setting the font races its load and returns the ligature name's width.
      icon: function (rect, ligature, px, color) {
        var UI = lively.gaming.GamingUI;
        var t = new lively.morphic.Text(rect, ligature);
        t.applyStyle({
          fontFamily: "'Material Symbols Rounded'", fontSize: px * 0.75, textColor: color || UI.theme().muted,
          fill: null, borderWidth: 0, borderColor: null, align: "center", allowInput: false, selectable: false,
          clipMode: "hidden", whiteSpaceHandling: "pre", fixedWidth: true, fixedHeight: true,
        });
        UI.noDrag(t);
        t.eventsAreIgnored = true;
        var n = t.renderContext().shapeNode;
        if (n) n.style.pointerEvents = "none";
        return t;
      },

      // ─── interactive morphs ──────────────────────────────────────────────

      // Turns a morph into a real control. CALL THIS ON EVERY MORPH THAT REACTS TO A
      // CLICK, instead of setting a handler and a cursor by hand: it is what gives the
      // control a name for assistive technology, a place in the Tab order, a visible focus
      // ring and the Enter / Space keys. A morph is a bare <div>: none of that exists
      // unless it is added here (CLAUDE.md, and S13 in the design notes).
      //   opts.role        "button" | "tab" | "radio" | "checkbox" ... (required)
      //   opts.label       the accessible name, e.g. "Hades, Playing" (required)
      //   opts.pressed     true/false for a toggle (aria-pressed); leave undefined otherwise
      //   opts.onActivate  called on click (via the caller's own mouse handler), Enter or Space
      //   opts.focusable   false to keep it out of the Tab order (default true)
      //   opts.disabled    marks it aria-disabled and out of the Tab order
      // It does NOT install the mouse handler (a Box that owns a click sets onMouseUp itself;
      // see button()); it only covers the keyboard and the semantics. Re-call it after a
      // re-render that replaces the node, and use setLabel() to change the name later.
      // Warns in the console when role or label is missing: that is the dev-time check.
      makeInteractive: function (morph, opts) {
        opts = opts || {};
        if (!opts.role || !opts.label) console.warn("[GamingUI] interactive morph without a role or label:", opts);
        morph.eventsAreIgnored = false;
        morph.applyStyle({ handStyle: opts.disabled ? "default" : "pointer" });
        var ctx = morph.renderContext();
        var shape = ctx.shapeNode, mnode = ctx.morphNode;
        if (shape) {
          shape.setAttribute("role", opts.role || "button");
          shape.setAttribute("aria-label", opts.label || "");
          if (opts.pressed !== undefined) shape.setAttribute("aria-pressed", opts.pressed ? "true" : "false");
          if (opts.disabled) shape.setAttribute("aria-disabled", "true");
        }
        if (opts.focusable !== false && !opts.disabled && mnode && shape) {
          // The focus target is the morphNode (a 0x0 wrapper), so the browser's own ring would
          // be a dot at the corner and the default style draws none at all. Draw it on the
          // visible shapeNode instead.
          morph.morphicSetter("Focusable", 0);          // enableFocus(0) would give -1 (0 || true)
          mnode.addEventListener("focus", function () {
            shape.style.outline = "2px solid " + lively.gaming.GamingUI.theme().accent.toString();
            shape.style.outlineOffset = "2px";
          });
          mnode.addEventListener("blur", function () { shape.style.outline = ""; });
          mnode.addEventListener("keydown", function (e) {
            if (e.target !== mnode) return;               // a key typed in a field INSIDE this control is not ours
            if ((e.key === "Enter" || e.key === " ") && opts.onActivate) { e.preventDefault(); e.stopPropagation(); opts.onActivate(); }
          });
        }
        return morph;
      },

      // Updates the accessible name of an interactive morph (after its text changed).
      setLabel: function (morph, label) {
        var n = morph.renderContext().shapeNode;
        if (n) n.setAttribute("aria-label", label);
      },

      // A themed pill button: a Box that owns the click, with a non-interactive label.
      //   opts: { variant: "primary"|"secondary"|"ghost"|"danger", onClick, w, h, disabled,
      //           px, ariaLabel, icon (ligature shown before the text) }
      // Width defaults to the measured text width plus padding. Returns the Box.
      button: function (x, y, text, opts) {
        opts = opts || {};
        var UI = lively.gaming.GamingUI, th = UI.theme();
        var px = opts.px || 12, h = opts.h || 32;
        var textPx = UI.textW(text, px, 700);
        var iconW = opts.icon ? px + 8 : 0;
        var w = opts.w || (textPx + iconW + 36);
        var v = opts.variant || "secondary";
        var fill = v === "primary" ? th.accent : v === "danger" ? th.surface : v === "ghost" ? null : th.surface;
        var hover = v === "primary" ? th.accentHover : th.accentSoft;
        var fg = v === "primary" ? th.onAccent : v === "danger" ? th.danger : th.accent;
        var edge = v === "primary" ? th.accent : v === "ghost" ? null : (v === "danger" ? th.danger : th.accent);
        var b = new lively.morphic.Box(lively.rect(x, y, w, h));
        b.applyStyle({ fill: fill, borderRadius: h / 2, borderWidth: edge ? 1 : 0, borderColor: edge, clipMode: "hidden" });
        UI.noDrag(b);
        // Positions below were set from live measurements (gaps read off getBoundingClientRect):
        // a one-line label box at (h - 18) / 2 puts the glyphs ~0.4px off centre; the icon
        // box has to sit ~2px higher than its arithmetic centre; and with an icon the
        // group (icon + text) is shifted 3px left because the text box carries 4px of padding.
        var lineH = 18, ly = Math.round((h - lineH) / 2);
        if (opts.icon) {
          var gx = Math.round((w - textPx - iconW) / 2) - 3;
          b.addMorph(UI.icon(lively.rect(gx, Math.round((h - px - 6) / 2) - 2, px + 4, px + 6), opts.icon, px + 2, opts.disabled ? th.muted : fg));
          b.addMorph(UI.label(lively.rect(gx + iconW, ly, textPx + 8, lineH + 4), text, { px: px, bold: true, color: opts.disabled ? th.muted : fg }));
        } else {
          b.addMorph(UI.label(lively.rect(0, ly, w, lineH + 4), text, { px: px, bold: true, align: "center", color: opts.disabled ? th.muted : fg }));
        }
        if (opts.disabled) {
          b.applyStyle({ borderColor: th.line });
          UI.makeInteractive(b, { role: "button", label: opts.ariaLabel || text, disabled: true });
          b.onMouseUp = function (evt) { evt.stop(); return true; };
          return b;
        }
        b.onMouseOver = function () { if (hover) b.applyStyle({ fill: hover }); };
        b.onMouseOut = function () { b.applyStyle({ fill: fill }); };
        b.onMouseUp = function (evt) { evt.stop(); if (opts.onClick) opts.onClick(b); return true; };
        UI.makeInteractive(b, { role: "button", label: opts.ariaLabel || text, onActivate: function () { if (opts.onClick) opts.onClick(b); } });
        return b;
      },

      // ─── game-specific pieces ────────────────────────────────────────────

      // The status chip: ONE Text morph with its own fill, radius and centred label.
      // `status` is one of the five keys. Returns a Text positioned at (x, y); width comes
      // from the fixed table above. NOT interactive by itself (the tile that holds it is).
      statusPill: function (x, y, status) {
        var UI = lively.gaming.GamingUI, th = UI.theme();
        var s = th.status[status] || th.status.backlog;
        var t = new lively.morphic.Text(lively.rect(x, y, STATUS_W[status] || 68, PILL_H), STATUS_LABEL[status] || status);
        t.applyStyle({
          fontFamily: FONT_BODY, fontSize: 12 * 0.75, fontWeight: "600", textColor: s.fg, fill: s.bg, borderWidth: 0, borderColor: null,
          borderRadius: PILL_H / 2, align: "center", allowInput: false, selectable: false, clipMode: "hidden", whiteSpaceHandling: "pre",
          fixedWidth: true, fixedHeight: true,
        });
        UI.noDrag(t);
        t.eventsAreIgnored = true;
        var n = t.renderContext().shapeNode;
        if (n) n.style.pointerEvents = "none";
        return t;
      },

      // "★★★☆☆" for a rating of 0 to 5 (0 shows five outlines). Plain text, no icon font.
      starsText: function (rating) {
        var r = Math.max(0, Math.min(5, Math.round(rating || 0)));
        return "★★★★★".slice(0, r) + "☆☆☆☆☆".slice(0, 5 - r);
      },

      // Two colours for a game with no cover art, stable for a given title: the same game
      // always gets the same placeholder. Returns { a, b } as Colors.
      coverColors: function (title) {
        var h = 0, s = String(title || "?");
        for (var i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
        var hue = h % 360;
        return { a: Color.hsb(hue, 0.55, 0.80), b: Color.hsb((hue + 45) % 360, 0.65, 0.52) };
      },

      // A top-to-bottom gradient fill from two colours.
      gradient: function (a, b) {
        return new lively.morphic.LinearGradient([{ offset: 0, color: a }, { offset: 1, color: b }], "southeast");
      },

      // ─── editable fields ─────────────────────────────────────────────────

      // A single-line text field. Returns { box, text, getValue, setValue, focus }.
      //   opts: { px, placeholder, value, onInput(value), onEnter(value), maxLen }
      // `box` is the bordered container to add to a parent; `text` is the editable Text.
      // Reading the value goes through the real DOM node's textContent, on the DOM `input`
      // event: the morph's own textString and onKeyUp lag behind keystrokes typed right
      // after the field opens (the search palette hit exactly this). The caret is kept
      // visible in dark mode, the browser outline is suppressed (the box draws the border),
      // and a click that Lively turns into a select-all becomes a caret at the end.
      input: function (rect, opts) {
        opts = opts || {};
        var UI = lively.gaming.GamingUI, th = UI.theme();
        var px = opts.px || 13;
        var box = UI.box(rect, th.surface, { radius: 10, border: th.line });
        var pad = 10, innerH = 20;
        var text = new lively.morphic.Text(lively.rect(pad, Math.round((rect.height - innerH) / 2) - 1, rect.width - pad * 2, innerH));
        text.applyStyle({
          fontFamily: FONT_BODY, fontSize: px * 0.75, textColor: th.text, fill: null, borderWidth: 0, borderColor: null,
          fixedWidth: true, fixedHeight: true, clipMode: "hidden", whiteSpaceHandling: "pre",
        });
        text.textString = opts.value || "";
        text.beInputLine();
        UI.noDrag(text);
        box.addMorph(text);
        var node = text.renderContext().shapeNode;
        node.classList.add("gaming-input");
        node.style.caretColor = th.accent.toString();
        var ph = null;
        if (opts.placeholder) {
          ph = UI.label(lively.rect(pad + 4, Math.round((rect.height - innerH) / 2) - 1, rect.width - pad * 2, innerH), opts.placeholder, { px: px, color: th.muted });
          ph.setVisible(!(opts.value));
          box.addMorph(ph);
        }
        function value() { return node.textContent.replace(/ /g, " "); }
        node.addEventListener("input", function () {
          var v = value();
          if (opts.maxLen && v.length > opts.maxLen) return;
          if (ph) ph.setVisible(v.length === 0);
          if (opts.onInput) opts.onInput(v);
        });
        UI._onFieldKey(node, function (e) {
          if (e.key === "Enter") { e.preventDefault(); if (opts.onEnter) opts.onEnter(value()); }
          else if (e.key === "Tab") { e.preventDefault(); UI._tabFrom(node, e.shiftKey); }   // Tab would otherwise stay in the field
        });
        var downAt = null;
        node.addEventListener("mousedown", function (e) { downAt = { x: e.clientX, y: e.clientY }; });
        node.addEventListener("mouseup", function (e) {
          var click = downAt && Math.abs(e.clientX - downAt.x) < 4 && Math.abs(e.clientY - downAt.y) < 4;
          downAt = null;
          if (!click) return;
          var sel = window.getSelection();
          if (!sel.isCollapsed && sel.toString() === value()) UI._caretToEnd(node);
        });
        return {
          box: box, text: text,
          getValue: value,
          setValue: function (v) { text.textString = v; if (ph) ph.setVisible(!v); },
          focus: function () { text.focus(); UI._caretToEnd(node); },
        };
      },

      // A multi-line text field (a review, a note). Same return shape as input(). Wraps,
      // Enter inserts a line break. getValue() returns the text with line breaks as \n.
      textArea: function (rect, opts) {
        opts = opts || {};
        var UI = lively.gaming.GamingUI, th = UI.theme();
        var px = opts.px || 13;
        var box = UI.box(rect, th.surface, { radius: 10, border: th.line });
        var pad = 10;
        var text = new lively.morphic.Text(lively.rect(pad, 8, rect.width - pad * 2, rect.height - 16));
        text.applyStyle({
          fontFamily: FONT_BODY, fontSize: px * 0.75, textColor: th.text, fill: null, borderWidth: 0, borderColor: null,
          fixedWidth: true, fixedHeight: true, clipMode: "auto", whiteSpaceHandling: "pre-wrap", allowInput: true,
        });
        text.textString = opts.value || "";
        UI.noDrag(text);
        box.addMorph(text);
        var node = text.renderContext().shapeNode;
        node.classList.add("gaming-input");
        node.style.caretColor = th.accent.toString();
        var ph = null;
        if (opts.placeholder) {
          ph = UI.label(lively.rect(pad + 4, 8, rect.width - pad * 2, 20), opts.placeholder, { px: px, color: th.muted });
          ph.setVisible(!(opts.value));
          box.addMorph(ph);
        }
        function value() { return (node.innerText || node.textContent || "").replace(/ /g, " ").replace(/\n$/, ""); }
        node.addEventListener("input", function () {
          var v = value();
          if (ph) ph.setVisible(v.length === 0);
          if (opts.onInput) opts.onInput(v);
        });
        UI._onFieldKey(node, function (e) { if (e.key === "Tab") { e.preventDefault(); UI._tabFrom(node, e.shiftKey); } });
        return {
          box: box, text: text, getValue: value,
          setValue: function (v) { text.textString = v; if (ph) ph.setVisible(!v); },
          focus: function () { text.focus(); UI._caretToEnd(node); },
        };
      },

      // Registers a keydown handler for an editable field's node. WHY NOT a listener on the
      // node itself: every ancestor morph registers its own capture-phase key handler, which
      // runs before one on a descendant node and can stop the event (confirmed: Enter never
      // reached a capture listener on the field's node). A listener on the DOCUMENT, in the
      // capture phase, sees the key first (the search palette does the same). One router is
      // installed for the whole page; handlers live in a WeakMap keyed by the field's node, so
      // a field that is removed takes its handler with it and nothing leaks.
      _onFieldKey: function (node, handler) {
        var UI = lively.gaming.GamingUI;
        if (!UI._fieldKeys) {
          UI._fieldKeys = new WeakMap();
          document.addEventListener("keydown", function (e) {
            var el = e.target && e.target.closest && e.target.closest(".gaming-input");
            var h = el && UI._fieldKeys.get(el);
            if (h) h(e);
          }, true);
        }
        UI._fieldKeys.set(node, handler);
      },

      // Puts the caret after the last character of an editable's content.
      _caretToEnd: function (node) {
        try {
          var editable = node.querySelector("[contenteditable]") || node, range = document.createRange(), sel = window.getSelection();
          range.selectNodeContents(editable); range.collapse(false);
          sel.removeAllRanges(); sel.addRange(range);
        } catch (e) { /* no selection API */ }
      },

      // Moves DOM focus to the next (or previous) Tab stop after `from`, in document order.
      // An editable Text swallows Tab (it would be a keyboard trap), so fields call this.
      _tabFrom: function (from, backwards) {
        var stops = Array.prototype.slice.call(document.querySelectorAll('[tabindex]:not([tabindex="-1"]), [contenteditable="true"]'))
          .filter(function (n) { return n.offsetParent !== null || n.getClientRects().length; });
        var cur = stops.findIndex(function (n) { return n === from || n.contains(from) || from.contains(n); });
        var next = stops[(cur + (backwards ? stops.length - 1 : 1)) % stops.length];
        if (next && next !== from) next.focus();
      },

      // The thin themed scrollbar for a clipMode "auto" box, with its space reserved so the
      // content does not shift sideways when the list starts to overflow. Call once the box
      // exists (it styles the real node).
      scroller: function (m, th) {
        th = th || lively.gaming.GamingUI.theme();
        var s = m.renderContext().shapeNode.style;
        s.scrollbarWidth = "thin";
        s.scrollbarColor = th.scrollThumb + " transparent";
        s.scrollbarGutter = "stable";
        return m;
      },

      // ─── modals and toasts ───────────────────────────────────────────────

      // Opens a dialog: a dim layer FIXED to the viewport with a bordered panel centred on
      // it. The panel has NO mouse handler of its own; the scrim's handler hit-tests first
      // and only cancels a click that lands OUTSIDE the panel (an ancestor's handler runs
      // before its children's, so a panel handler that stopped the click would starve every
      // button inside it; CLAUDE.md "A modal scrim must not claim clicks inside its panel").
      //   opts: { w, h, label (accessible name), onClose, dismissOnScrim (default true),
      //           host (the Gaming root: pass it, so the dialog is never saved with the world) }
      // Returns { scrim, panel, close, relayout }. Esc closes the TOPMOST modal. Only one
      // is open at a time: opening another closes the first. While `UI._overlay` is true (a
      // dialog that is not one of ours, such as the audience dialog, is on top) Esc is left
      // alone so it reaches that dialog instead of closing this one underneath it.
      openModal: function (opts) {
        var UI = lively.gaming.GamingUI, th = UI.theme();
        if (UI._modal) UI._modal.close();
        var m = { closed: false };
        function size() {
          var vw = document.documentElement.clientWidth - 1, vh = window.innerHeight;
          return { w: Math.min(opts.w, vw - 32), h: Math.min(opts.h, vh - 32), vw: vw, vh: vh };
        }
        var s0 = size();
        var scrim = lively.identity.HomestarUI.viewportScrim(function () { place(); });
        scrim.applyStyle({ fill: th.scrim });
        // viewportScrim adds the scrim to the world. A morph that is a child of the world is saved
        // with it, so a dialog open at the moment of a save would be written into the world file.
        // Reparenting it under the template's root keeps it out of the save (the root's submorphs
        // are never serialized) and removes it when the root goes. It stays position:fixed.
        if (opts.host) opts.host.addMorph(scrim);
        var panel = UI.box(lively.rect(0, 0, s0.w, s0.h), th.surface, { radius: 16, border: th.line });
        scrim.addMorph(panel);
        function place() {
          var s = size();
          // A fixed morph's position is relative to its owner, so under the host (which sits below
          // the menu bar, not at the page origin) the scrim has to be shifted back by the host's own
          // position. HomestarUI's resize handler has just put it at (0, scroll) in page coordinates.
          if (opts.host) {
            var off = opts.host.getPosition();
            scrim.setPosition(lively.pt(-off.x, (window.pageYOffset || 0) - off.y));
          }
          panel.setExtent(lively.pt(s.w, s.h));
          panel.setPosition(lively.pt(Math.round((s.vw - s.w) / 2), Math.round((s.vh - s.h) / 2)));
          if (m.onResize) m.onResize(s);
        }
        place();
        var pn = panel.renderContext().shapeNode;
        pn.setAttribute("role", "dialog"); pn.setAttribute("aria-modal", "true"); pn.setAttribute("aria-label", opts.label || "Dialog");
        pn.style.boxShadow = "0 24px 60px rgba(0,0,0,0.28)";
        scrim.onMouseUp = function (evt) {
          if (lively.identity.HomestarUI.pointOnPanel(panel, evt)) return false;     // not ours: let the panel's children have it
          evt.stop();
          if (opts.dismissOnScrim !== false) m.close();
          return true;
        };
        m.onKey = function (e) { if (e.key === "Escape" && !m.closed && !UI._overlay) { e.preventDefault(); e.stopPropagation(); m.close(); } };
        document.addEventListener("keydown", m.onKey, true);
        m.scrim = scrim; m.panel = panel; m.relayout = place;
        m.close = function () {
          if (m.closed) return;
          m.closed = true;
          document.removeEventListener("keydown", m.onKey, true);
          lively.identity.HomestarUI.closeScrim(scrim);
          if (UI._modal === m) UI._modal = null;
          if (opts.onClose) opts.onClose();
        };
        UI._modal = m;
        return m;
      },

      closeModal: function () {
        var m = lively.gaming.GamingUI._modal;
        if (m) m.close();
      },

      // A short message at the bottom centre of the viewport, gone after `ms` (default
      // 2.4 s). The box is FIXED, so it stays on screen if the page scrolls.
      // `host` (the Gaming root) is where the toast lives, for the reason given at openModal.
      toast: function (text, ms, host) {
        var UI = lively.gaming.GamingUI, th = UI.theme();
        if (UI._toast) { UI._toast.remove(); UI._toast = null; }
        var w = Math.min(UI.textW(text, 13, 600) + 40, document.documentElement.clientWidth - 40), h = 38;
        var t = UI.box(lively.rect(0, 0, w, h), th.text, { radius: h / 2 });
        $world.addMorph(t);
        t.enableFixedPositioning();
        t.addMorph(UI.label(lively.rect(0, 8, w, 22), text, { px: 13, weight: 600, color: th.bg, align: "center" }));
        $world.cachedWindowBounds = null;
        t.setPosition(lively.pt(Math.round((document.documentElement.clientWidth - 1 - w) / 2), window.innerHeight - 72 + (window.pageYOffset || 0)));
        // Move it under the host AFTER positioning (enableFixedPositioning keeps it in the world, and a
        // fixed morph's position is relative to its owner, so shift by the host's own position), so it
        // is not saved with the world.
        if (host) {
          var hp = host.getPosition(), cp = t.getPosition();
          host.addMorph(t);
          t.setPosition(lively.pt(cp.x - hp.x, cp.y - hp.y));
        }
        t.eventsAreIgnored = true;
        var tn = t.renderContext().shapeNode;
        tn.setAttribute("role", "status"); tn.setAttribute("aria-live", "polite"); tn.style.pointerEvents = "none";
        UI._toast = t;
        setTimeout(function () { if (UI._toast === t) UI._toast = null; try { t.remove(); } catch (e) { /* already gone */ } }, ms || 2400);
        return t;
      },

      // The offer that follows a game's status becoming Playing or Completed: a small card at
      // the bottom centre with a line of text, "Share as postcard" and "Not now". Goes away by
      // itself after `opts.ms` (12 s by default), when either button is pressed, or when
      // another prompt replaces it. Only one exists at a time.
      //   host            the Gaming root (the prompt lives under it, so it is never saved
      //                   with the world; same reason and same positioning as toast)
      //   opts.text       the question
      //   opts.onShare()  "Share as postcard" was pressed
      //   opts.onDismiss() optional: "Not now" was pressed (NOT called on the timeout)
      // Why not a modal: it must never take focus or block the work that triggered it (the
      // owner is usually in the middle of editing the game), and it must not steal Esc.
      // Returns the prompt Box. Call dismissSharePrompt() to remove it early.
      sharePrompt: function (host, opts) {
        var UI = lively.gaming.GamingUI, th = UI.theme();
        UI.dismissSharePrompt();
        var vw = document.documentElement.clientWidth - 1;
        var w = Math.min(460, vw - 40), h = 104;
        var box = UI.box(lively.rect(0, 0, w, h), th.surface, { radius: 16, border: th.line });
        $world.addMorph(box);
        box.enableFixedPositioning();
        var line = UI.label(lively.rect(0, 0, w - 36, 22), opts.text, { px: 14, weight: 600 });
        box.addMorph(line); line.setPosition(lively.pt(18, 16));
        var timer = null;
        function end() { clearTimeout(timer); if (UI._sharePrompt && UI._sharePrompt.box === box) UI._sharePrompt = null; try { box.remove(); } catch (e) { /* already gone */ } }
        var share = UI.button(18, 54, "Share as postcard", { variant: "primary", icon: "mail", onClick: function () { end(); if (opts.onShare) opts.onShare(); } });
        var later = UI.button(0, 54, "Not now", { variant: "ghost", onClick: function () { end(); if (opts.onDismiss) opts.onDismiss(); } });
        later.setPosition(lively.pt(18 + share.getExtent().x + 8, 54));
        box.addMorph(share); box.addMorph(later);
        $world.cachedWindowBounds = null;
        box.setPosition(lively.pt(Math.round((vw - w) / 2), window.innerHeight - h - 24 + (window.pageYOffset || 0)));
        // Under the host AFTER positioning, and shifted by the host's own position (a fixed
        // morph's position is relative to its owner), exactly as toast does.
        if (host) {
          var hp = host.getPosition(), cp = box.getPosition();
          host.addMorph(box);
          box.setPosition(lively.pt(cp.x - hp.x, cp.y - hp.y));
        }
        var n = box.renderContext().shapeNode;
        n.setAttribute("role", "region"); n.setAttribute("aria-label", opts.text);
        n.style.boxShadow = "0 12px 36px rgba(0,0,0,0.25)";
        timer = setTimeout(end, opts.ms || 12000);
        UI._sharePrompt = { box: box, end: end };
        return box;
      },

      // Removes the share prompt if one is showing (also called when the template is torn down).
      dismissSharePrompt: function () {
        var p = lively.gaming.GamingUI._sharePrompt;
        if (p) p.end();
      },
    };
  }); // end module('lively.gaming.GamingUI')
