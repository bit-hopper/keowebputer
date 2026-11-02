module("lively.morphic.TextFormattingToolbar")
  .requires(
    "lively.morphic.TextCore",
    "lively.morphic.ColorChooserDraft",
    "lively.persistence.BuildSpec",
  )
  .toRun(function () {

    // The formatting toolbar shown above a rich text morph
    // (TextFormattingSupport.js turns it on per morph). Left to right:
    //
    //   [font family v] [size | v] | B I U link | A fill | [list v]
    //
    // NOTE: lively.BuildSpec methods (and anything installed via
    // Morph#addScript) get reconstructed from their own source text at
    // runtime (BuildSpec's evalJS path / addScript's Function.fromString),
    // which throws away the closure over this toRun(function(){...})
    // wrapper's own `var`s (see CLAUDE.md's "lively.BuildSpec / Morph#addScript
    // methods lose their closure" section). So every constant/helper those
    // methods need lives on the lively.morphic.TextFormattingToolbar
    // namespace object itself instead of a closure var. This toolbar is a
    // runtime-only ephemeral HUD (isEpiMorph, one shared instance, never
    // itself saved into a world or published to PartsBin) so BuildSpec is
    // fine here.
    Object.extend(lively.morphic.TextFormattingToolbar, {
      BAR_H: 40,
      BTN_SIZE: 28,
      PAD: 6,
      GAP: 2,
      DIV_GAP: 6,

      // light, quiet palette -- the bar floats over the user's own content,
      // so it stays white with a hairline border and a soft shadow
      BAR_BG: Color.rgb(255, 255, 255),
      BAR_BORDER: Color.rgb(224, 224, 230),
      DIVIDER: Color.rgb(228, 228, 234),
      ICON_DEFAULT: Color.rgb(60, 64, 72),
      ICON_MUTED: Color.rgb(122, 126, 136),
      ACTIVE_BG: Color.rgba(255, 64, 160, 0.14),
      ACTIVE_FG: Color.rgb(200, 30, 120),
      HOVER_BG: Color.rgba(0, 0, 0, 0.06),
      FIELD_BORDER: Color.rgb(214, 214, 222),
      MENU_SHADOW: "0 6px 20px rgba(20,20,40,0.18), 0 1px 3px rgba(20,20,40,0.12)",
      BAR_SHADOW: "0 4px 16px rgba(20,20,40,0.16), 0 1px 2px rgba(20,20,40,0.10)",

      FONT_DD_W: 136,
      SIZE_FIELD_W: 44,
      SIZE_CHEVRON_W: 20,
      LIST_DD_W: 50,

      // 12 presets in a compact popup grid, built once and cached (the full
      // AwesomeColorPicker builds ~1000 tile morphs per open, so it stays
      // behind a "More colors..." row).
      QUICK_COLORS: [
        Color.rgb(0, 0, 0), Color.rgb(80, 80, 80), Color.rgb(190, 190, 190), Color.rgb(255, 255, 255),
        Color.rgb(235, 87, 87), Color.rgb(242, 153, 74), Color.rgb(242, 201, 76), Color.rgb(111, 207, 151),
        Color.rgb(39, 174, 96), Color.rgb(45, 156, 219), Color.rgb(155, 81, 224), Color.rgb(216, 90, 167)
      ],
      QUICK_COLOR_COLS: 6,
      QUICK_SWATCH_SIZE: 22,
      QUICK_SWATCH_GAP: 6,
      QUICK_MENU_PAD: 10,
      QUICK_MENU_MORE_H: 24,

      FONT_MENU_W: 210,
      MENU_ITEM_H: 28,
      FONT_MENU_MAX_VISIBLE: 8,

      // point sizes (Text fontSize is in pt, see CLAUDE.md)
      FONT_SIZES: [8, 9, 10, 11, 12, 14, 16, 18, 20, 24, 30, 36, 48, 60, 72],
      SIZE_MENU_W: 64,
      SIZE_MENU_MAX_VISIBLE: 8,

      LIST_MENU_W: 196,
      LIST_MENU_ITEM_H: 32,
      LIST_ITEMS: [
        { label: "Bulleted list", glyph: "format_list_bulleted", kind: "bullet" },
        { label: "Numbered list", glyph: "format_list_numbered", kind: "number" },
        { label: "To-do list", glyph: "checklist", kind: "check" },
        { label: "Remove list", glyph: "format_clear", kind: "none", separated: true }
      ],

      // Vendored decorative Google Fonts (core/lib/google-fonts/, loaded via
      // core/styles/google-fonts.css) -- also listed in TextCore.js's
      // getKnownFonts(). Kept here too because browsers lazy-load
      // @font-face resources: nothing fetches the actual font file until
      // something on the page tries to render with that family, and
      // availableFonts()'s width-comparison check is synchronous. Confirmed
      // live: the very first call to availableFonts() after a fresh page
      // load measured ALL 43 of these as "unavailable" (0% hit rate) purely
      // because none of their downloads had been triggered yet, not because
      // anything was actually missing -- a second call moments later (after
      // that first call's own measurements had incidentally triggered the
      // downloads in the background) found 42/43. This list exists so
      // warmVendoredFonts() (below) can explicitly request each one via the
      // CSS Font Loading API and await real completion before the
      // availability check ever runs, rather than depending on incidental
      // prior triggers or racing an in-flight download.
      VENDORED_FONT_NAMES: [
        'Cedarville Cursive', 'Coiny', 'Comic Neue', 'Creepster', 'Eater',
        'Emilys Candy', 'Freckle Face', 'Give You Glory', 'Gloria Hallelujah', 'Gluten',
        'Gochi Hand', 'Grandstander', 'Gravitas One', 'IBM Plex Serif', 'Indie Flower',
        'Jolly Lodger', 'Just Me Again Down Here', 'Kablammo',
        'Loved by the King', 'Manufacturing Consent', 'Matemasie',
        'Menbere', 'Miltonian', 'Mystery Quest', 'Offside', 'Patrick Hand', 'Peralta',
        'Rancho', 'Reem Kufi Fun', 'Rubik Beastly', 'Rubik Burned', 'Rubik Distressed',
        'Rubik Gemstones', 'Rubik Glitch', 'Rubik Moonrocks',
        'Rubik Vinyl', 'Shadows Into Light Two', 'Short Stack',
        'Slackey', 'Stack Sans Notch', 'Sue Ellen Francisco',
        'Yuyu', 'Yuyu Short'
      ],

      // Returns a Promise (resolves once every vendored font has either
      // loaded or failed) -- awaited by showFontMenu before the first
      // getFontList() call. A no-op after the first successful run, and
      // safe to call even where the CSS Font Loading API is unavailable.
      warmVendoredFonts: function () {
        var NS = lively.morphic.TextFormattingToolbar;
        if (NS._fontsWarmed) return Promise.resolve();
        if (!document.fonts || !document.fonts.load) { NS._fontsWarmed = true; return Promise.resolve(); }
        var loads = NS.VENDORED_FONT_NAMES.map(function (name) {
          return document.fonts.load('16px "' + name + '"').catch(function () {});
        });
        return Promise.all(loads).then(function () { NS._fontsWarmed = true; });
      },

      // TextCore.js's lively.morphic.Text.Fonts.availableFonts() actually
      // measures each candidate name's rendered glyph width against the
      // browser's own default, so this returns only fonts genuinely
      // available on this deployment -- not a guessed "web-safe" list
      // (TextMarkupEditorSpec.md section 3, "verify against what's
      // actually available"). Cached because the measurement re-appends a
      // throwaway <span> to document.body per call. Callers must await
      // warmVendoredFonts() first (see showFontMenu) or this cache can
      // permanently exclude vendored fonts whose download hadn't finished
      // yet on the first call.
      getFontList: function () {
        var NS = lively.morphic.TextFormattingToolbar;
        if (!NS._fontListCache) {
          var available = lively.morphic.Text.Fonts.availableFonts(
            lively.morphic.Text.Fonts.getKnownFonts());
          // The known-font list spells many families twice ("Arial" and
          // "arial"), and CSS font names are case-insensitive, so both pass
          // the availability check and would show as two menu rows for one
          // font. Keep one per case-insensitive name, preferring a spelling
          // that isn't all lowercase, then sort the result.
          var byName = {};
          available.forEach(function (name) {
            var key = name.toLowerCase();
            var kept = byName[key];
            if (!kept || (kept === kept.toLowerCase() && name !== name.toLowerCase())) byName[key] = name;
          });
          // Families the list only has in lowercase ("book antiqua") are
          // title-cased for display; CSS ignores the case, and the
          // foundry suffixes MT / MS / ITC stay upper case.
          var titleCase = function (name) {
            if (name !== name.toLowerCase()) return name;
            return name.replace(/\b[a-z]+/g, function (w) {
              return /^(mt|ms|itc)$/.test(w) ? w.toUpperCase() : w.charAt(0).toUpperCase() + w.slice(1);
            });
          };
          NS._fontListCache = Object.keys(byName).map(function (k) { return titleCase(byName[k]); })
            .sort(function (a, b) { return a.toLowerCase() < b.toLowerCase() ? -1 : a.toLowerCase() > b.toLowerCase() ? 1 : 0; });
        }
        return NS._fontListCache;
      },

      // Native mousedown on a toolbar morph would move DOM focus off the
      // target Text (collapsing its selection and hiding the toolbar), so a
      // capture-phase listener calls the real preventDefault(). Only the
      // ROOT of a built tree needs it (capture reaches every descendant).
      guardMousedown: function (morph) {
        var node = morph.renderContext && morph.renderContext().shapeNode;
        if (node) node.addEventListener("mousedown", function (e) { e.preventDefault(); }, true);
      },

      // Purely visual children (labels/icons inside a button Box) must not
      // catch clicks: Lively-level `eventsAreIgnored` and, for the browser's
      // own hit-testing, real CSS pointer-events (CLAUDE.md, "eventsAreIgnored
      // does not stop a morph from blocking real native browser clicks").
      markDecorative: function (morph) {
        morph.eventsAreIgnored = true;
        morph._decorative = true;
        return morph;
      },

      // Walks a built morph tree once it is in the world: pointer-events
      // none on decorative nodes, and (root only) the mousedown guard.
      finishTree: function (morph, isRoot) {
        var NS = lively.morphic.TextFormattingToolbar;
        var node = morph.renderContext && morph.renderContext().shapeNode;
        if (node && morph._decorative) node.style.pointerEvents = "none";
        if (isRoot && !morph._noMousedownGuard) NS.guardMousedown(morph);
        (morph.submorphs || []).forEach(function (m) { NS.finishTree(m, false); });
      },

      noDrag: function (morph) {
        morph.draggingEnabled = false;
        morph.droppingEnabled = false;
        morph.grabbingEnabled = false;
        return morph;
      },

      // applyStyle on an already-rendered morph can update the model but
      // never reach the DOM (CLAUDE.md), so paint straight onto the node too.
      setFill: function (morph, color) {
        morph.applyStyle({ fill: color });
        var node = morph.renderContext && morph.renderContext().shapeNode;
        if (node) node.style.background = color ? color.toCSSString() : "";
      },
      setTextColor: function (morph, color) {
        morph.applyStyle({ textColor: color });
        var node = morph.renderContext && morph.renderContext().shapeNode;
        if (!node) return;
        var css = color.toCSSString();
        node.style.color = css;
        var inner = node.querySelectorAll("div, span");
        for (var i = 0; i < inner.length; i++) inner[i].style.color = css;
      },

      // Material Symbols glyph (vendored font, core/styles/material-symbols.css).
      // fontSize renders as pt: 13.5pt = 18px. No scripts -- a plain image.
      makeGlyph: function (x, y, w, h, glyph, color, fontPt) {
        var NS = lively.morphic.TextFormattingToolbar;
        var pt = fontPt || 13.5;
        var px = Math.round(pt * 4 / 3);
        var g = new lively.morphic.Text(lively.rect(x, y, w, h));
        g.textString = glyph;
        g.applyStyle({
          fontFamily: "'Material Symbols Rounded'", fontSize: pt,
          textColor: color || NS.ICON_DEFAULT, fill: null,
          borderWidth: 0, align: "center",
          padding: lively.Rectangle.inset(0, Math.round((h - px) / 2), 0, 0),
          allowInput: false, selectable: false, clipMode: "hidden",
          whiteSpaceHandling: "pre"
        });
        return NS.noDrag(g);
      },

      // Single-line text label. Built at its final position (a Text moved
      // with setPosition after construction is offset twice, see CLAUDE.md).
      makeLabel: function (x, y, w, h, str, opts) {
        var NS = lively.morphic.TextFormattingToolbar;
        opts = opts || {};
        var pt = opts.fontPt || 9.5;
        var px = Math.round(pt * 4 / 3);
        var t = new lively.morphic.Text(lively.rect(x, y, w, h), str);
        t.applyStyle({
          fontFamily: opts.family || "Arial, sans-serif", fontSize: pt,
          textColor: opts.color || NS.ICON_DEFAULT, fill: null,
          borderWidth: 0, align: opts.align || "left",
          padding: lively.Rectangle.inset(0, Math.round((h - px * 1.15) / 2) + 2, 0, 0),
          allowInput: false, selectable: false, clipMode: "hidden",
          whiteSpaceHandling: "pre"
        });
        return NS.noDrag(t);
      },

      // Square icon button (B, I, U, link, colors, chevrons).
      makeIconButton: function (x, glyph, actionName, width) {
        var NS = lively.morphic.TextFormattingToolbar;
        var size = NS.BTN_SIZE, w = width || size;
        var btn = new lively.morphic.Text(lively.rect(x, (NS.BAR_H - size) / 2, w, size));
        btn.textString = glyph;
        btn.applyStyle({
          fontFamily: "'Material Symbols Rounded'",
          fontSize: 13.5,
          textColor: NS.ICON_DEFAULT,
          fill: null,
          borderRadius: 6,
          borderWidth: 0,
          align: "center",
          padding: lively.Rectangle.inset(0, Math.round((size - 18) / 2), 0, 0),
          allowInput: false,
          selectable: false,
          clipMode: "hidden",
          whiteSpaceHandling: "pre",
          handStyle: "pointer"
        });
        btn._actionName = actionName;
        NS.noDrag(btn);
        NS.wireButton(btn);
        return btn;
      },

      // Click/hover wiring shared by icon buttons and dropdown boxes: mouse
      // down only flags the toolbar as busy (so it doesn't auto-hide), the
      // action runs on mouse up.
      wireButton: function (btn) {
        btn.addScript(function onMouseOver() {
          if (!this._active) lively.morphic.TextFormattingToolbar.setFill(this, lively.morphic.TextFormattingToolbar.HOVER_BG);
        });
        btn.addScript(function onMouseOut() {
          if (!this._active) lively.morphic.TextFormattingToolbar.setFill(this, null);
        });
        btn.addScript(function onMouseDown(evt) {
          this.owner._interacting = true;
          evt.stop();
          return true;
        });
        btn.addScript(function onMouseUp(evt) {
          this.owner[this._actionName]();
          this.owner._interacting = false;
          this.owner.refreshToggleState();
          evt.stop();
          return true;
        });
      },

      // Highlight state for the toggle buttons (bold/italic/underline/link).
      setActive: function (btn, isActive) {
        var NS = lively.morphic.TextFormattingToolbar;
        if (!!btn._active === !!isActive && btn._activePainted) return;
        btn._active = !!isActive;
        btn._activePainted = true;
        NS.setFill(btn, isActive ? NS.ACTIVE_BG : null);
        NS.setTextColor(btn, isActive ? NS.ACTIVE_FG : NS.ICON_DEFAULT);
      },

      // A dropdown trigger: label on the left, chevron on the right. The Box
      // takes the click, its two children are decorative.
      // `glyph` (optional) puts an icon in place of the text label.
      makeDropdown: function (x, w, text, actionName, glyph) {
        var NS = lively.morphic.TextFormattingToolbar;
        var h = NS.BTN_SIZE;
        var box = new lively.morphic.Box(lively.rect(x, (NS.BAR_H - h) / 2, w, h));
        box.applyStyle({ fill: null, borderWidth: 0, borderRadius: 6, handStyle: "pointer" });
        box._actionName = actionName;
        NS.noDrag(box);
        if (glyph) {
          box.addMorph(NS.markDecorative(NS.makeGlyph(6, 0, 24, h, glyph, NS.ICON_DEFAULT, 13.5)));
        } else {
          box.label = NS.markDecorative(NS.makeLabel(8, 0, w - 8 - 22, h, text));
          box.addMorph(box.label);
        }
        box.chevron = NS.markDecorative(NS.makeGlyph(w - 22, 0, 20, h, "expand_more", NS.ICON_MUTED, 12));
        box.addMorph(box.chevron);
        NS.wireButton(box);
        return box;
      },

      // Truncate a single-line label with an ellipsis instead of cutting a
      // glyph in half. The width is set explicitly because the framework's
      // own max-width on the text node is dropped by getTextExtent()
      // (CLAUDE.md, "A nowrap Text morph's ellipsis can vanish").
      ellipsize: function (textMorph) {
        var node = textMorph.renderContext && textMorph.renderContext().textNode;
        if (!node) return;
        node.style.whiteSpace = "nowrap";
        node.style.overflow = "hidden";
        node.style.textOverflow = "ellipsis";
        node.style.width = "calc(100% - 8px)";
      },

      makeDivider: function (x) {
        var NS = lively.morphic.TextFormattingToolbar;
        var d = new lively.morphic.Box(lively.rect(x, (NS.BAR_H - 20) / 2, 1, 20));
        d.applyStyle({ fill: NS.DIVIDER, borderWidth: 0 });
        NS.noDrag(d);
        return NS.markDecorative(d);
      },

      // Thin colored strip under the A / bucket glyph showing the last picked
      // color. Sits on the glyph's own built-in color slot.
      makeColorStrip: function (btnX, color) {
        var NS = lively.morphic.TextFormattingToolbar;
        var s = new lively.morphic.Box(lively.rect(btnX + 8, (NS.BAR_H + NS.BTN_SIZE) / 2 - 6, NS.BTN_SIZE - 16, 3));
        s.applyStyle({ fill: color, borderWidth: 0, borderRadius: 1 });
        NS.noDrag(s);
        return NS.markDecorative(s);
      },

      // Popup menu shell: white card, hairline border, soft shadow.
      makeMenuBox: function (w, h, scrolls) {
        var NS = lively.morphic.TextFormattingToolbar;
        var menu = new lively.morphic.Box(lively.rect(0, 0, w, h));
        menu.applyStyle({
          fill: NS.BAR_BG, borderRadius: 8, borderWidth: 1, borderColor: NS.BAR_BORDER,
          clipMode: scrolls ? "auto" : "hidden"
        });
        menu._scrolls = !!scrolls;
        return NS.noDrag(menu);
      },

      // Once a menu is in the world: shadow (written straight to the node)
      // and a slim scrollbar for the long lists.
      styleMenuChrome: function (menu) {
        var NS = lively.morphic.TextFormattingToolbar;
        var node = menu.renderContext && menu.renderContext().shapeNode;
        if (!node) return;
        node.style.boxShadow = NS.MENU_SHADOW;
        if (menu._scrolls) {
          // no scrollbar (Windows draws arrow buttons even on thin ones); the
          // wheel still scrolls and the half-visible last row hints at it
          node.style.scrollbarWidth = "none";
          node.style.overflowX = "hidden";
        }
      },

      // One row of any dropdown menu. opts: label, glyph (optional icon),
      // family (render the label in this font), pickName/arg (toolbar method
      // run on click), previewName/revertName (optional hover preview).
      makeMenuRow: function (toolbar, x, y, w, h, opts) {
        var NS = lively.morphic.TextFormattingToolbar;
        var row = new lively.morphic.Box(lively.rect(x, y, w, h));
        row.applyStyle({ fill: null, borderWidth: 0, borderRadius: 5, handStyle: "pointer" });
        NS.noDrag(row);
        var lx = 12;
        if (opts.glyph) {
          row.addMorph(NS.markDecorative(NS.makeGlyph(8, 0, 24, h, opts.glyph, NS.ICON_DEFAULT, 12.75)));
          lx = 40;
        }
        row.addMorph(NS.markDecorative(NS.makeLabel(lx, 0, w - lx - 6, h, opts.label, {
          family: opts.family, fontPt: opts.fontPt || 9.75
        })));
        row._toolbar = toolbar;
        row._pickName = opts.pickName;
        row._arg = opts.arg;
        row._previewName = opts.previewName;
        row._revertName = opts.revertName;
        row.addScript(function onMouseOver() {
          lively.morphic.TextFormattingToolbar.setFill(this, lively.morphic.TextFormattingToolbar.HOVER_BG);
          if (this._previewName) this._toolbar[this._previewName](this._arg);
        });
        row.addScript(function onMouseOut() {
          lively.morphic.TextFormattingToolbar.setFill(this, null);
          if (this._revertName) this._toolbar[this._revertName]();
        });
        row.addScript(function onMouseDown(evt) { this._toolbar._interacting = true; evt.stop(); return true; });
        row.addScript(function onMouseUp(evt) {
          this._toolbar[this._pickName](this._arg);
          this._toolbar._interacting = false;
          this._toolbar.hideAllMenus();
          evt.stop();
          return true;
        });
        return row;
      },

      // Round swatch inside the quick-color popup; owner there is the popup
      // Box, so toolbar and callback live on the swatch itself.
      makeQuickColorSwatch: function (x, y, size, color, toolbar, callbackName) {
        var NS = lively.morphic.TextFormattingToolbar;
        var btn = new lively.morphic.Morph();
        btn.setShape(new lively.morphic.Shapes.Ellipse(lively.rect(x, y, size, size)));
        btn.applyStyle({ fill: color, borderWidth: 1, borderColor: Color.rgba(0, 0, 0, 0.18) });
        btn._color = color;
        btn._toolbar = toolbar;
        btn._callbackName = callbackName;
        NS.noDrag(btn);
        btn.addScript(function onMouseDown(evt) { this._toolbar._interacting = true; evt.stop(); return true; });
        btn.addScript(function onMouseUp(evt) {
          this._toolbar[this._callbackName](this._color);
          this._toolbar._interacting = false;
          this._toolbar.hideQuickColorMenus();
          evt.stop();
          return true;
        });
        return btn;
      },

      // The font-size text field: a real native <input> inside a plain Box
      // (CLAUDE.md, "Native HTML dialogs/overlays": native inputs nested in a
      // morph's own shapeNode type correctly). It is the one toolbar control
      // that has to take real DOM focus, which blurs the target Text, so:
      // on mousedown it remembers the target's selection and flags the
      // toolbar busy; on commit it hands focus back, restores that selection
      // and only then applies the size.
      installSizeInput: function (toolbar) {
        var NS = lively.morphic.TextFormattingToolbar;
        if (toolbar._sizeInput) return;
        var node = toolbar._sizeBox.renderContext().shapeNode;
        var input = document.createElement("input");
        input.type = "text";
        input.setAttribute("inputmode", "decimal");
        input.setAttribute("aria-label", "Font size");
        input.spellcheck = false;
        input.autocomplete = "off";
        var s = input.style;
        s.position = "absolute"; s.left = "0px"; s.top = "3px";
        s.width = (NS.SIZE_FIELD_W - 2) + "px"; s.height = (NS.BTN_SIZE - 6) + "px";
        s.boxSizing = "border-box"; s.margin = "0"; s.padding = "2px 2px 0";
        s.border = "1px solid " + NS.FIELD_BORDER.toCSSString();
        s.borderRadius = "6px"; s.background = "#fff";
        s.color = NS.ICON_DEFAULT.toCSSString();
        s.font = "13px Arial, sans-serif"; s.textAlign = "center";
        s.outline = "none"; s.userSelect = "text"; s.webkitUserSelect = "text";
        node.appendChild(input);

        // capture-phase mousedown: runs BEFORE the target Text blurs
        input.addEventListener("mousedown", function () {
          var t = toolbar._target;
          if (t && t.isFocused && t.isFocused()) toolbar._savedRange = t.getSelectionRange();
          toolbar._interacting = true;
        }, true);
        input.addEventListener("focus", function () {
          toolbar._interacting = true;
          s.borderColor = NS.ACTIVE_FG.toCSSString();
          input.select();
        });
        input.addEventListener("blur", function () {
          s.borderColor = NS.FIELD_BORDER.toCSSString();
          toolbar._interacting = false;
          // focus went somewhere else (not back to the text): let the
          // toolbar decide whether to hide, same as a text blur would
          if (toolbar._target) NS.hideForSoon(toolbar._target);
        });
        input.addEventListener("keydown", function (e) {
          if (e.key === "Enter") {
            e.preventDefault();
            toolbar.commitFontSize(input.value);
          } else if (e.key === "Escape") {
            e.preventDefault();
            toolbar.cancelSizeInput();
          } else if (e.key === "ArrowUp" || e.key === "ArrowDown") {
            e.preventDefault();
            var cur = parseFloat(input.value);
            if (!(cur > 0)) return;
            var next = cur + (e.key === "ArrowUp" ? 1 : -1);
            input.value = String(next);
            toolbar.commitFontSize(next, true);
          }
        });
        toolbar._sizeInput = input;
      },

      // -- shared-instance lifecycle -----------------------------------
      sharedInstance: null,
      _hideTimer: null,

      showFor: function (targetMorph) {
        var NS = lively.morphic.TextFormattingToolbar;
        if (NS._hideTimer) { clearTimeout(NS._hideTimer); NS._hideTimer = null; }
        var inst = NS.sharedInstance;
        if (!inst || !inst.world()) {
          inst = NS.sharedInstance = lively.BuildSpec("lively.morphic.TextFormattingToolbar").createMorph();
          (targetMorph.world() || $world).addMorph(inst);
          inst.installNativeMousedownGuards();
        }
        inst._target = targetMorph;
        inst.positionAboveTarget(targetMorph);
        inst.hideAllMenus();
        inst.setVisible(true);
        inst.bringToFront();
        inst.refreshToggleState();
      },

      hideForSoon: function (targetMorph) {
        var NS = lively.morphic.TextFormattingToolbar;
        if (NS._hideTimer) clearTimeout(NS._hideTimer);
        NS._hideTimer = setTimeout(function () {
          NS._hideTimer = null;
          var inst = NS.sharedInstance;
          if (inst && inst._target === targetMorph && !inst._interacting && !inst._colorPickerOpen) {
            inst.setVisible(false);
            // Focus has really left the text: drop its text selection too
            // (see Text>>clearStaleSelection in Events.js).
            targetMorph.clearStaleSelection();
          }
        }, 200);
      }
    });

    lively.BuildSpec("lively.morphic.TextFormattingToolbar", {
      isEpiMorph: true,
      className: "lively.morphic.Box",
      name: "TextFormattingToolbar",
      draggingEnabled: false,
      droppingEnabled: false,
      grabbingEnabled: false,
      style: {
        fill: undefined, // set in _render once width is known
        borderRadius: 10,
        borderWidth: 1
      },

      _target: null,
      _interacting: false,
      _savedRange: null,

      onFromBuildSpecCreated: function onFromBuildSpecCreated() {
        this._render();
        this.setVisible(false);
        // Poll-based selection-state refresh: there is no selectionRange
        // signal to hook, so use Lively's own step loop (the same mechanism
        // TextCore.js uses for logTextForSharing).
        this.startStepping(300, "refreshToggleState");
      },

      // Runs once the toolbar is in the world (needs real DOM nodes):
      // mousedown guards + pointer-events on decorative children, the bar's
      // own shadow, and the native size input.
      installNativeMousedownGuards: function installNativeMousedownGuards() {
        var NS = lively.morphic.TextFormattingToolbar;
        this.submorphs.forEach(function (m) { NS.finishTree(m, true); });
        var node = this.renderContext().shapeNode;
        node.style.boxShadow = NS.BAR_SHADOW;
        NS.installSizeInput(this);
        NS.ellipsize(this._fontDD.label);
      },

      _render: function _render() {
        var NS = lively.morphic.TextFormattingToolbar;
        this.removeAllMorphs();
        var x = NS.PAD;

        // 1. font family dropdown
        this._fontDD = NS.makeDropdown(x, NS.FONT_DD_W, "Arial", "toggleFontMenu");
        this.addMorph(this._fontDD);
        x += NS.FONT_DD_W + NS.GAP;

        // 2. font size: manual input + dropdown
        var sizeBox = new lively.morphic.Box(lively.rect(x, (NS.BAR_H - NS.BTN_SIZE) / 2, NS.SIZE_FIELD_W, NS.BTN_SIZE));
        sizeBox.applyStyle({ fill: null, borderWidth: 0 });
        NS.noDrag(sizeBox);
        sizeBox._noMousedownGuard = true; // its native <input> needs real focus
        this._sizeBox = sizeBox;
        this.addMorph(sizeBox);
        x += NS.SIZE_FIELD_W;
        this._sizeDD = NS.makeIconButton(x, "expand_more", "toggleSizeMenu", NS.SIZE_CHEVRON_W);
        this._sizeDD.applyStyle({ fontSize: 12, padding: lively.Rectangle.inset(0, Math.round((NS.BTN_SIZE - 16) / 2), 0, 0) });
        NS.setTextColor(this._sizeDD, NS.ICON_MUTED);
        this.addMorph(this._sizeDD);
        x += NS.SIZE_CHEVRON_W + NS.DIV_GAP;

        this.addMorph(NS.makeDivider(x)); x += 1 + NS.DIV_GAP;

        // 3-6. bold, italic, underline, link
        this._boldBtn = NS.makeIconButton(x, "format_bold", "toggleBold"); this.addMorph(this._boldBtn); x += NS.BTN_SIZE + NS.GAP;
        this._italicBtn = NS.makeIconButton(x, "format_italic", "toggleItalic"); this.addMorph(this._italicBtn); x += NS.BTN_SIZE + NS.GAP;
        this._underlineBtn = NS.makeIconButton(x, "format_underlined", "toggleUnderline"); this.addMorph(this._underlineBtn); x += NS.BTN_SIZE + NS.GAP;
        this._linkBtn = NS.makeIconButton(x, "link", "toggleLink"); this.addMorph(this._linkBtn); x += NS.BTN_SIZE + NS.DIV_GAP;

        this.addMorph(NS.makeDivider(x)); x += 1 + NS.DIV_GAP;

        // 7-8. text color, background color (each shows its last pick)
        this._textColorPickerBtn = NS.makeIconButton(x, "format_color_text", "toggleTextColorMenu");
        this.addMorph(this._textColorPickerBtn);
        this._textColorStrip = NS.makeColorStrip(x, Color.rgb(0, 0, 0));
        this.addMorph(this._textColorStrip);
        x += NS.BTN_SIZE + NS.GAP;
        this._bgColorPickerBtn = NS.makeIconButton(x, "format_color_fill", "toggleBackgroundColorMenu");
        this.addMorph(this._bgColorPickerBtn);
        this._bgColorStrip = NS.makeColorStrip(x, Color.rgb(255, 235, 59));
        this.addMorph(this._bgColorStrip);
        x += NS.BTN_SIZE + NS.DIV_GAP;

        this.addMorph(NS.makeDivider(x)); x += 1 + NS.DIV_GAP;

        // 9. list dropdown (to-do, bulleted, numbered)
        this._listDD = NS.makeDropdown(x, NS.LIST_DD_W, "", "toggleListMenu", "checklist");
        this.addMorph(this._listDD);
        x += NS.LIST_DD_W + NS.PAD;

        this.setExtent(lively.pt(x, NS.BAR_H));
        this.applyStyle({ fill: NS.BAR_BG, borderColor: NS.BAR_BORDER });
      },

      positionAboveTarget: function positionAboveTarget(targetMorph) {
        var topLeftWorld = targetMorph.worldPoint(lively.pt(0, 0));
        var extent = this.getExtent();
        var world = targetMorph.world() || $world;
        var visible = world.visibleBounds ? world.visibleBounds() : null;
        var y = topLeftWorld.y - extent.y - 8;
        if (visible && y < visible.top()) {
          // not enough room above -- show below the target instead
          var bottomLeftWorld = targetMorph.worldPoint(lively.pt(0, targetMorph.getExtent().y));
          y = bottomLeftWorld.y + 8;
        }
        this.setPosition(lively.pt(topLeftWorld.x, y));
      },

      // -- target-mutating actions (all delegate to lively.morphic.Text's
      // own rich-text API -- see TextCore.js / TextFormattingSupport.js) ----
      // With only a caret these set a pending style for the next typed
      // characters (see TextFormattingSupport.js) instead of doing nothing.
      toggleBold: function toggleBold() { this._target && this._target.toggleEmphasisOrPending("Boldness"); },
      toggleItalic: function toggleItalic() { this._target && this._target.toggleEmphasisOrPending("Italics"); },
      toggleUnderline: function toggleUnderline() { this._target && this._target.toggleEmphasisOrPending("Underline"); },
      toggleLink: function toggleLink() { this._target && this._target.toggleEmphasisOrPending("Link"); },

      // Apply an emphasis to the target's selection. Normally the text has
      // focus and its own selection is used. While the full color picker is
      // open its hex field holds the DOM focus, so the text reports no
      // selection at all: fall back to the range remembered when the picker
      // opened (_pickerRange) and emphasize that range directly.
      _emphasizeTarget: function _emphasizeTarget(spec) {
        var t = this._target;
        if (!t) return;
        if (t.isFocused && t.isFocused()) { t.emphasizeOrPending(spec); return; }
        t.emphasizeRangeOrPending(spec, this._pickerRange || t.priorSelectionRange);
      },

      pickTextColor: function pickTextColor(color) {
        if (!this._target) return;
        this._emphasizeTarget({ color: color });
        lively.morphic.TextFormattingToolbar.setFill(this._textColorStrip, color);
      },
      pickBackgroundColor: function pickBackgroundColor(color) {
        if (!this._target) return;
        this._emphasizeTarget({ backgroundColor: color });
        lively.morphic.TextFormattingToolbar.setFill(this._bgColorStrip, color);
      },

      // `null` (not undefined) so the font cleanly falls back to the cascade:
      // TextEmphasis writes node.style.fontFamily whenever the property
      // exists, and CSSOM turns `undefined` into the literal string
      // "undefined" but `null` into "" (a real property removal).
      pickFontFamily: function pickFontFamily(font) { this._target && this._target.emphasizeOrPending({ fontFamily: font === undefined ? null : font }); },

      // -- font size -------------------------------------------------------
      // Used by both the size field (Enter / arrow keys) and the size menu.
      // When the field has the focus the target Text is blurred: give focus
      // back, restore the selection saved on mousedown, then apply.
      commitFontSize: function commitFontSize(value, keepFieldFocus) {
        var t = this._target;
        if (!t) return;
        var n = parseFloat(value);
        if (!(n > 0)) { this.refreshToggleState(true); return; }
        n = Math.max(1, Math.min(400, Math.round(n * 2) / 2));
        var range = this._savedRange;
        var needsFocus = !(t.isFocused && t.isFocused());
        if (needsFocus && range) {
          // Text>>onFocus re-applies priorSelectionRange on a later tick, so
          // it must already hold the range we restore here
          t.priorSelectionRange = range;
          t.focus();
          t.setSelectionRange(range[0], range[1]);
        }
        t.emphasizeOrPending({ fontSize: n });
        if (this._sizeInput) this._sizeInput.value = String(n);
        if (keepFieldFocus && this._sizeInput) {
          // arrow-key stepping keeps typing in the field; refresh the range
          // from the (now re-focused) text first, then move focus back
          this._savedRange = t.getSelectionRange();
          this._interacting = true;
          this._sizeInput.focus();
        } else {
          this._savedRange = null;
        }
      },
      pickFontSize: function pickFontSize(size) { this.commitFontSize(size); },

      cancelSizeInput: function cancelSizeInput() {
        var t = this._target, range = this._savedRange;
        this._savedRange = null;
        if (t && range) { t.priorSelectionRange = range; t.focus(); t.setSelectionRange(range[0], range[1]); }
        this.refreshToggleState(true);
      },

      toggleSizeMenu: function toggleSizeMenu() {
        if (this._sizeMenu && this._sizeMenu.isVisible()) { this.hideAllMenus(); return; }
        this.hideAllMenus();
        var NS = lively.morphic.TextFormattingToolbar;
        if (!this._sizeMenu) this._buildSizeMenu();
        this._sizeMenu.setPosition(lively.pt(this._sizeBox.getPosition().x, NS.BAR_H + 4));
        this._sizeMenu.setVisible(true);
        this._sizeMenu.bringToFront();
      },

      _buildSizeMenu: function _buildSizeMenu() {
        var NS = lively.morphic.TextFormattingToolbar;
        var sizes = NS.FONT_SIZES, itemH = NS.MENU_ITEM_H, pad = 4;
        var scrolls = sizes.length > NS.SIZE_MENU_MAX_VISIBLE;
        var rowsShown = scrolls ? NS.SIZE_MENU_MAX_VISIBLE - 0.5 : sizes.length;
        var menu = NS.makeMenuBox(NS.SIZE_MENU_W, itemH * rowsShown + pad * 2, scrolls);
        sizes.forEach(function (size, i) {
          menu.addMorph(NS.makeMenuRow(this, pad, pad + i * itemH, NS.SIZE_MENU_W - pad * 2, itemH, {
            label: String(size), pickName: "pickFontSize", arg: size
          }));
        }, this);
        menu.setVisible(false);
        this.addMorph(menu);
        NS.finishTree(menu, true);
        NS.styleMenuChrome(menu);
        this._sizeMenu = menu;
      },

      // -- list dropdown ---------------------------------------------------
      pickList: function pickList(kind) { this._target && this._target.toggleListForSelection(kind); },

      toggleListMenu: function toggleListMenu() {
        if (this._listMenu && this._listMenu.isVisible()) { this.hideAllMenus(); return; }
        this.hideAllMenus();
        var NS = lively.morphic.TextFormattingToolbar;
        if (!this._listMenu) this._buildListMenu();
        this._listMenu.setPosition(lively.pt(this._listDD.getPosition().x, NS.BAR_H + 4));
        this._listMenu.setVisible(true);
        this._listMenu.bringToFront();
      },

      _buildListMenu: function _buildListMenu() {
        var NS = lively.morphic.TextFormattingToolbar;
        var items = NS.LIST_ITEMS, itemH = NS.LIST_MENU_ITEM_H, pad = 4, w = NS.LIST_MENU_W;
        var h = pad * 2 + items.length * itemH + 9;
        var menu = NS.makeMenuBox(w, h, false);
        var y = pad;
        items.forEach(function (item) {
          if (item.separated) {
            var sep = new lively.morphic.Box(lively.rect(10, y + 4, w - 20, 1));
            sep.applyStyle({ fill: NS.DIVIDER, borderWidth: 0 });
            NS.noDrag(sep);
            menu.addMorph(NS.markDecorative(sep));
            y += 9;
          }
          menu.addMorph(NS.makeMenuRow(this, pad, y, w - pad * 2, itemH, {
            label: item.label, glyph: item.glyph, pickName: "pickList", arg: item.kind
          }));
          y += itemH;
        }, this);
        menu.setVisible(false);
        this.addMorph(menu);
        NS.finishTree(menu, true);
        NS.styleMenuChrome(menu);
        this._listMenu = menu;
      },

      // -- quick color popups (built once, cached) --------------------------
      toggleTextColorMenu: function toggleTextColorMenu() { this._toggleQuickColorMenu("text"); },
      toggleBackgroundColorMenu: function toggleBackgroundColorMenu() { this._toggleQuickColorMenu("background"); },

      _toggleQuickColorMenu: function _toggleQuickColorMenu(kind) {
        var menuProp = kind === "text" ? "_textColorMenu" : "_bgColorMenu";
        var wasOpen = this[menuProp] && this[menuProp].isVisible();
        this.hideAllMenus();
        if (!wasOpen) this._showQuickColorMenu(kind);
      },

      _showQuickColorMenu: function _showQuickColorMenu(kind) {
        var NS = lively.morphic.TextFormattingToolbar;
        var menuProp = kind === "text" ? "_textColorMenu" : "_bgColorMenu";
        var anchorBtn = kind === "text" ? this._textColorPickerBtn : this._bgColorPickerBtn;
        if (!this[menuProp]) this._buildQuickColorMenu(kind);
        this[menuProp].setPosition(lively.pt(anchorBtn.getPosition().x, NS.BAR_H + 4));
        this[menuProp].setVisible(true);
        this[menuProp].bringToFront();
      },

      hideQuickColorMenus: function hideQuickColorMenus() {
        if (this._textColorMenu) this._textColorMenu.setVisible(false);
        if (this._bgColorMenu) this._bgColorMenu.setVisible(false);
      },

      hideFontMenu: function hideFontMenu() {
        if (this._fontMenu) this._fontMenu.setVisible(false);
      },

      hideAllMenus: function hideAllMenus() {
        this.hideQuickColorMenus();
        this.hideFontMenu();
        if (this._sizeMenu) this._sizeMenu.setVisible(false);
        if (this._listMenu) this._listMenu.setVisible(false);
      },

      _buildQuickColorMenu: function _buildQuickColorMenu(kind) {
        var NS = lively.morphic.TextFormattingToolbar;
        var toolbar = this;
        var callbackName = kind === "text" ? "pickTextColor" : "pickBackgroundColor";
        var openFullPickerName = kind === "text" ? "openTextColorPicker" : "openBackgroundColorPicker";
        var cols = NS.QUICK_COLOR_COLS;
        var sw = NS.QUICK_SWATCH_SIZE, gap = NS.QUICK_SWATCH_GAP, pad = NS.QUICK_MENU_PAD;
        var rows = Math.ceil(NS.QUICK_COLORS.length / cols);
        var gridW = cols * sw + (cols - 1) * gap;
        var gridH = rows * sw + (rows - 1) * gap;
        var menu = NS.makeMenuBox(gridW + pad * 2, gridH + pad * 2 + NS.QUICK_MENU_MORE_H + 6, false);

        NS.QUICK_COLORS.forEach(function (color, i) {
          var col = i % cols, row = Math.floor(i / cols);
          menu.addMorph(NS.makeQuickColorSwatch(
            pad + col * (sw + gap), pad + row * (sw + gap), sw, color, toolbar, callbackName));
        });

        var sepY = pad + gridH + 6;
        var more = NS.makeMenuRow(toolbar, 4, sepY, gridW + pad * 2 - 8, NS.QUICK_MENU_MORE_H, {
          label: "More colors…", pickName: "_openFullPicker", arg: openFullPickerName, fontPt: 9
        });
        menu.addMorph(more);

        menu.setVisible(false);
        this.addMorph(menu);
        NS.finishTree(menu, true);
        NS.styleMenuChrome(menu);
        this[kind === "text" ? "_textColorMenu" : "_bgColorMenu"] = menu;
      },

      _openFullPicker: function _openFullPicker(methodName) { this[methodName](); },

      // -- richer color pickers: reuses lively.morphic.AwesomeColorPicker
      // (ColorChooserDraft.js). Reached only via a quick-color popup's "More
      // colors..." row. --
      openTextColorPicker: function openTextColorPicker() { this._openColorPicker("pickTextColor"); },
      openBackgroundColorPicker: function openBackgroundColorPicker() { this._openColorPicker("pickBackgroundColor"); },

      _openColorPicker: function _openColorPicker(callbackName) {
        var NS = lively.morphic.TextFormattingToolbar;
        var toolbar = this;
        var picker = new lively.morphic.AwesomeColorPicker();
        var t = this._target;
        this._pickerRange = t && t.isFocused && t.isFocused() ? t.getSelectionRange() : (t && t.priorSelectionRange) || null;
        var pos = this.worldPoint(lively.pt(0, NS.BAR_H + 4));
        picker.open($world, pos);
        // The picker's hue/sat-brightness fields and alpha slider are plain
        // morphic drag surfaces: guard their native mousedown like every
        // toolbar button so dragging them doesn't collapse the target's
        // selection. NOT the rgbValueField -- that one is a real native
        // <input> that needs genuine focus to accept typed hex values.
        NS.guardMousedown(picker.hueField);
        NS.guardMousedown(picker.satBrtField);
        NS.guardMousedown(picker.alphaSlider);
        // Keep the toolbar from auto-hiding while this popup (which lives on
        // $world, outside the toolbar's own tree) is open.
        toolbar._colorPickerOpen = true;
        var origRemove = picker.remove;
        picker.remove = function () {
          toolbar._colorPickerOpen = false;
          toolbar._pickerRange = null;
          return origRemove.call(this);
        };
        lively.bindings.connect(picker, "color", toolbar, callbackName);
      },

      // -- font-family dropdown ---------------------------------------------
      toggleFontMenu: function toggleFontMenu() {
        if (this._fontMenu && this._fontMenu.isVisible()) { this.hideAllMenus(); return; }
        this.showFontMenu();
      },

      showFontMenu: function showFontMenu() {
        var NS = lively.morphic.TextFormattingToolbar;
        var toolbar = this;
        this.hideAllMenus();
        // Capture the current selection's font synchronously, before the
        // possible async gap below, so hover-preview can revert to it when
        // the mouse leaves an item without a click.
        var range = this._target && this._target.getSelectionRange && this._target.getSelectionRange();
        var emph = range && this._target.getEmphasisAt(range[0]);
        this._fontMenuOriginalFamily = emph ? emph.getFontFamily() : undefined;
        // Reset each time the menu opens (see commitFontFamily).
        this._fontMenuCommitted = false;

        if (this._fontMenu) {
          this._positionAndShowFontMenu();
          return;
        }
        // First open only: wait for the vendored Google Fonts to actually
        // finish loading before measuring availability / building the list
        // (see warmVendoredFonts/getFontList) -- otherwise they race their
        // own @font-face download and get cached as "unavailable".
        NS.warmVendoredFonts().then(function () {
          toolbar._buildFontMenu();
          toolbar._positionAndShowFontMenu();
        });
      },

      _positionAndShowFontMenu: function _positionAndShowFontMenu() {
        var NS = lively.morphic.TextFormattingToolbar;
        this._fontMenu.setPosition(lively.pt(this._fontDD.getPosition().x, NS.BAR_H + 4));
        this._fontMenu.setVisible(true);
        this._fontMenu.bringToFront();
      },

      // Hover preview: temporarily applies the hovered font to the real
      // selection, reverts to the font the selection had when the menu opened
      // if the mouse leaves without a click. Clicking commits first
      // (_fontMenuCommitted) because hiding the menu under the cursor fires a
      // native mouseout, whose revert would otherwise undo the pick.
      // Preview only makes sense on a real selection; with just a caret
      // there is nothing on screen to preview on (a click still sets it).
      _hasRealSelection: function _hasRealSelection() {
        var r = this._target && this._target.getSelectionRange();
        return !!r && r[0] !== r[1];
      },
      previewFont: function previewFont(font) { if (this._target && this._hasRealSelection()) this.pickFontFamily(font); },
      revertFontPreview: function revertFontPreview() {
        if (this._fontMenuCommitted || !this._target || !this._hasRealSelection()) return;
        this.pickFontFamily(this._fontMenuOriginalFamily);
      },
      commitFontFamily: function commitFontFamily(font) {
        this._fontMenuCommitted = true;
        this.pickFontFamily(font);
      },

      _buildFontMenu: function _buildFontMenu() {
        var NS = lively.morphic.TextFormattingToolbar;
        var fonts = NS.getFontList();
        var itemH = NS.MENU_ITEM_H, pad = 4;
        var scrolls = fonts.length > NS.FONT_MENU_MAX_VISIBLE;
        var rowsShown = scrolls ? NS.FONT_MENU_MAX_VISIBLE - 0.5 : Math.max(1, fonts.length);
        var menu = NS.makeMenuBox(NS.FONT_MENU_W, itemH * rowsShown + pad * 2, scrolls);
        fonts.forEach(function (font, i) {
          menu.addMorph(NS.makeMenuRow(this, pad, pad + i * itemH, NS.FONT_MENU_W - pad * 2, itemH, {
            label: font, family: font, fontPt: 10.5,
            pickName: "commitFontFamily", arg: font,
            previewName: "previewFont", revertName: "revertFontPreview"
          }));
        }, this);
        menu.setVisible(false);
        this.addMorph(menu);
        NS.finishTree(menu, true);
        NS.styleMenuChrome(menu);
        this._fontMenu = menu;
      },

      // -- selection-state readback (polled) ----------------------------------
      refreshToggleState: function refreshToggleState(force) {
        var NS = lively.morphic.TextFormattingToolbar;
        if (!this._target || !this.isVisible()) return;
        var t = this._target;
        var range = t.getSelectionRange && t.getSelectionRange();
        // a bare caret reads the character before it (what typing inherits)
        var emph = range && (range[0] === range[1] ? t.getEmphasisForCaret(range[0]) : t.getEmphasisAt(range[0]));
        // ...and a style set with only a caret (not typed yet) wins over it
        var pend = (t.getPendingEmphasis && t.getPendingEmphasis()) || {};
        var flag = function (key, on, read) {
          return pend[key] !== undefined ? pend[key] === on : !!emph && read(emph) === on;
        };
        NS.setActive(this._boldBtn, flag("fontWeight", "bold", function (e) { return e.getFontWeight(); }));
        NS.setActive(this._italicBtn, flag("italics", "italic", function (e) { return e.getItalics(); }));
        NS.setActive(this._underlineBtn, flag("textDecoration", "underline", function (e) { return e.getTextDecoration(); }));
        NS.setActive(this._linkBtn, !!emph && !!emph.getURI());

        // current font family, shown on the dropdown
        var fam = pend.fontFamily || (emph && emph.getFontFamily && emph.getFontFamily()) || (t.getFontFamily && t.getFontFamily()) || "";
        fam = String(fam).split(",")[0].replace(/^\s*["']|["']\s*$/g, "");
        if (fam && this._fontDD.label.textString !== fam) {
          this._fontDD.label.setTextString(fam);
          NS.ellipsize(this._fontDD.label);
        }

        // current size, shown in the field unless the user is typing in it
        var input = this._sizeInput;
        if (input && (force || document.activeElement !== input)) {
          var size = pend.fontSize || (emph && emph.getFontSize && emph.getFontSize()) || (t.getFontSize && t.getFontSize());
          if (size) {
            var shown = String(Math.round(size * 10) / 10);
            if (input.value !== shown) input.value = shown;
          }
        }
      }
    });

  });
