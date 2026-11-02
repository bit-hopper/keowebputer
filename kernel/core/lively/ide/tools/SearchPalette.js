/**
 * lively.ide.tools.SearchPalette
 *
 * The floating search palette (search.md): a glass panel under the menu bar
 * over a lightly dimmed world, with a field, scope pills and a hint footer.
 *
 * Plain imperative morphic construction (handlers are ordinary closures, none
 * is reconstructed from source text, so the BuildSpec/addScript closure-loss
 * gotcha does not apply). Result items come from lively.ide.tools.Search.
 */

module("lively.ide.tools.SearchPalette")
  .requires("lively.morphic.Complete", "lively.identity.HomestarUI", "lively.ide.tools.Search", "lively.ide.tools.SearchThumbnail")
  .toRun(function () {

    var ACCENT = Color.rgb(240, 26, 105);
    var ACCENT_TEXT = Color.rgb(200, 15, 85);
    var INK = Color.rgb(42, 36, 56);
    var MUTED = Color.rgb(122, 115, 144);
    var HAIRLINE = Color.rgba(30, 24, 44, 0.08);

    var MAX_W = 940;
    var TOP = 52;               // below the menu bar
    var MAX_H = 560;
    var FIELD_H = 56;
    var PILLS_H = 44;
    var FOOTER_H = 36;
    var PILL_H = 28;
    var SIDE = 20;

    var FONT = "'Atkinson Hyperlegible', Helvetica, Arial, sans-serif";

    // The input's editable div gets the browser's focus ring (a black box inside
    // the field); the field has its own look, so drop it.
    function ensureStyle() {
      if (document.getElementById("search-palette-style")) return;
      var st = document.createElement("style");
      st.id = "search-palette-style";
      st.textContent = ".search-palette-input, .search-palette-input * { outline: none !important; }";
      document.head.appendChild(st);
    }

    var SCOPES = [
      { id: "all", label: "All" },
      { id: "morphs", label: "Morphs" },
      { id: "worlds", label: "Worlds" },
      { id: "code", label: "Code" },
      { id: "files", label: "Files" },
    ];

    var PREVIEW_W = 330;           // right pane (search.md section 3.1)
    var PREVIEW_MIN_PANEL = 760;   // hidden when the panel is narrower than this
    var ROW_H = 52;
    var ROW_GAP = 2;
    var MAX_ROWS = 60;           // rendered at once; the rest is "refine your search"
    var ALL_CAP = 4;             // per group under scope All (search.md section 3.1)
    var SELECTED_WASH = Color.rgba(240, 26, 105, 0.09);

    // Type -> chip icon, tint (semantic colours, never pink) and tag text (search.md section 3.2).
    var TYPES = {
      text:   { icon: "title",        tint: Color.rgb(59, 130, 246),  label: "Text" },
      window: { icon: "web_asset",    tint: Color.rgb(139, 92, 246),  label: "Window" },
      image:  { icon: "image",        tint: Color.rgb(20, 184, 166),  label: "Image" },
      button: { icon: "smart_button", tint: Color.rgb(245, 158, 11),  label: "Button" },
      box:    { icon: "crop_square",  tint: Color.rgb(100, 116, 139), label: "Box" },
      world:  { icon: "public",       tint: Color.rgb(249, 115, 22),  label: "World" },
      code:   { icon: "code",         tint: Color.rgb(34, 197, 94),   label: "Code" },
      file:   { icon: "draft",        tint: Color.rgb(96, 125, 160),  label: "File" },
      folder: { icon: "folder",       tint: Color.rgb(202, 138, 4),   label: "Folder" },
    };

    // Result groups in display order; `scope` is the tab "Show N more" switches to.
    var GROUPS = [
      { id: "world", title: "IN THIS WORLD", scope: "morphs" },
      { id: "worlds", title: "SAVED WORLDS", scope: "worlds" },
      { id: "saved", title: "IN SAVED WORLDS", scope: "morphs" },
      { id: "files", title: "FILES", scope: "files" },
      { id: "code", title: "CODE", scope: "code" },
    ];
    var CODE_MIN_QUERY = 2;        // a one-letter code search is all noise
    var CODE_DELAY = 200;          // ms after the last keystroke
    var THUMB_DELAY = 120;         // ms a row stays highlighted before its thumbnail is loaded

    // Width of a string in the palette's font, via canvas: synchronous, so it cannot
    // race font loading or DOM layout the way reading a rendered span can.
    var measureCtx = null;
    function textWidth(str, px, bold) {
      if (!measureCtx) measureCtx = document.createElement("canvas").getContext("2d");
      measureCtx.font = (bold ? "bold " : "") + px + "px " + FONT;
      return measureCtx.measureText(str).width;
    }

    function setBg(m, color) {
      // applyStyle({fill}) on a rendered morph can miss the DOM; write it too.
      m.applyStyle({ fill: color });
      m.renderContext().shapeNode.style.background = color ? color.toString() : "transparent";
    }

    function noDrag(m) { return lively.identity.HomestarUI.noDrag(m); }

    function box(rect, fill) {
      var b = new lively.morphic.Box(rect);
      b.applyStyle({ fill: fill || null, borderWidth: 0 });
      return noDrag(b);
    }

    // A one-line label. Decorative unless opts.clickable.
    function label(rect, text, opts) {
      opts = opts || {};
      var t = new lively.morphic.Text(rect);
      t.textString = text;
      t.applyStyle({
        fontSize: (opts.px || 13) * 0.75,
        fontWeight: opts.bold ? "bold" : "normal",
        textColor: opts.color || INK,
        fontFamily: opts.family || FONT,
        fill: null, borderWidth: 0, borderColor: null,
        align: opts.align || "left",
        allowInput: false, selectable: false,
        clipMode: "hidden",
        whiteSpaceHandling: "pre",
      });
      noDrag(t);
      t.eventsAreIgnored = true;
      return t;
    }

    function icon(rect, glyph, px, color) {
      return label(rect, glyph, { px: px, color: color, family: "'Material Symbols Rounded'", align: "center" });
    }

    lively.ide.tools.SearchPalette = {

      current: null,

      isOpen: function () { return !!lively.ide.tools.SearchPalette.current; },

      // The menu bar's search entry shows a pink "open" state while the palette is
      // open. Found by name so the palette also updates it when opened by the command.
      syncMenuEntry: function (open) {
        try {
          var entry = $world.get("livelySearchMenuBarEntry");
          if (entry && entry.setPaletteActive) entry.setPaletteActive(open);
        } catch (e) { /* no menu bar in this world */ }
      },

      toggle: function () {
        var P = lively.ide.tools.SearchPalette;
        if (P.isOpen()) P.close(); else P.open();
      },

      close: function () {
        var P = lively.ide.tools.SearchPalette, s = P.current;
        if (!s) return;
        P.current = null;
        s.closed = true;
        clearTimeout(s.codeTimer);
        clearTimeout(s.thumbTimer);
        document.removeEventListener("keydown", s.onDocKeydown, true);
        document.removeEventListener("selectionchange", s.onSelectionChange);
        // free the blob URLs of image thumbnails
        Object.keys(s.thumbs).forEach(function (k) { if (s.thumbs[k].revoke) URL.revokeObjectURL(s.thumbs[k].src); });
        P.syncMenuEntry(false);
        lively.identity.HomestarUI.closeScrim(s.scrim);
      },

      open: function () {
        var P = lively.ide.tools.SearchPalette,
          UI = lively.identity.HomestarUI,
          Search = lively.ide.tools.Search;
        if (P.current) return P.current;

        var s = (P.current = {
          scopeIndex: 0,
          query: "",
          items: Search.worldItems(),   // live morphs; saved-world items join later
          codeItems: [],                // runtime code hits for the current query
          codeSeq: 0,
          thumbs: {},                   // thumbnail per item key, kept while the palette is open
          thumbPending: {},             // keys being loaded right now
          closed: false,
        });

        function geometry() {
          var vw = document.documentElement.clientWidth - 1;
          var w = Math.min(MAX_W, vw - 24);
          var h = Math.min(MAX_H, window.innerHeight - TOP - 24);
          return { w: w, h: h, x: Math.round((vw - w) / 2), y: TOP };
        }
        var g = geometry();

        var scrim = (s.scrim = UI.viewportScrim(function () { layout(); }));
        scrim.applyStyle({ fill: Color.rgba(30, 24, 44, 0.22) });
        // Judge "on the panel" on the real node; the panel itself has no mouse
        // handler, so a click on a row/pill reaches that child (capture-first
        // dispatch -- CLAUDE.md "A modal scrim must not claim clicks...").
        scrim.onMouseUp = function (evt) {
          if (UI.pointOnPanel(panel, evt)) return false;
          evt.stop();
          P.close();
          return true;
        };

        var panel = (s.panel = box(lively.rect(g.x, g.y, g.w, g.h), Color.rgba(255, 255, 255, 0.8)));
        panel.applyStyle({ borderRadius: 22, clipMode: "hidden" });
        scrim.addMorph(panel);
        var pn = panel.renderContext().shapeNode;
        pn.style.backdropFilter = pn.style.webkitBackdropFilter = "blur(24px) saturate(180%)";
        pn.style.boxShadow =
          "inset 0 0 0 1px rgba(30,24,44,0.08), 0 24px 60px rgba(240,26,105,0.14), 0 8px 24px rgba(30,24,44,0.12)";

        // ---- field row
        s.searchGlyph = icon(lively.rect(SIDE, 14, 28, 28), "search", 22, ACCENT);
        panel.addMorph(s.searchGlyph);

        var input = (s.input = new lively.morphic.Text(lively.rect(SIDE + 36, 14, g.w - SIDE * 2 - 36 - 56, 28)));
        input.applyStyle({
          fontFamily: FONT, fontSize: 17 * 0.75, textColor: INK, fill: null, borderWidth: 0, borderColor: null,
          fixedWidth: true, fixedHeight: true, clipMode: "hidden", whiteSpaceHandling: "pre",
        });
        input.textString = "";
        input.beInputLine();
        noDrag(input);
        panel.addMorph(input);
        ensureStyle();
        input.renderContext().shapeNode.classList.add("search-palette-input");
        input.renderContext().shapeNode.style.caretColor = ACCENT.toString();

        s.placeholder = label(lively.rect(SIDE + 36 + 4, 14, 400, 28), "Search morphs, worlds, code, files", {
          px: 17, color: Color.rgba(122, 115, 144, 0.75),
        });
        panel.addMorph(s.placeholder);
        // eventsAreIgnored is only Lively-level; a covering label must also let the
        // browser's own click-to-focus through to the input beneath.
        s.placeholder.renderContext().shapeNode.style.pointerEvents = "none";

        s.escTag = box(lively.rect(g.w - SIDE - 36, 16, 36, 24), Color.rgba(30, 24, 44, 0.06));
        s.escTag.applyStyle({ borderRadius: 8 });
        s.escTag.addMorph(label(lively.rect(0, 3, 36, 18), "esc", { px: 11, color: MUTED, align: "center" }));
        panel.addMorph(s.escTag);

        // ---- scope pills
        s.pills = SCOPES.map(function (scope, i) {
          var pill = box(lively.rect(0, FIELD_H + (PILLS_H - PILL_H) / 2, 60, PILL_H));
          pill.applyStyle({ borderRadius: PILL_H / 2 });
          pill.eventsAreIgnored = false;
          pill.handStyle = "pointer";
          pill._label = label(lively.rect(0, 5, 60, 18), scope.label, { px: 12, align: "center", bold: true });
          pill.addMorph(pill._label);
          pill.onMouseDown = function (evt) { evt.stop(); return true; };   // keep focus in the field
          pill.onMouseUp = function (evt) {
            P.setScope(i);
            evt.stop();
            return true;
          };
          panel.addMorph(pill);
          var pnode = pill.renderContext().shapeNode;
          pnode.setAttribute("role", "button");
          pnode.setAttribute("aria-label", "Search scope: " + scope.label);
          return pill;
        });

        // ---- dividers, body, footer
        s.divTop = box(lively.rect(0, FIELD_H, g.w, 1), HAIRLINE);
        s.divPills = box(lively.rect(0, FIELD_H + PILLS_H, g.w, 1), HAIRLINE);
        s.divFooter = box(lively.rect(0, g.h - FOOTER_H, g.w, 1), HAIRLINE);
        panel.addMorph(s.divTop);
        panel.addMorph(s.divPills);
        panel.addMorph(s.divFooter);

        // The results list scrolls (clipMode auto); rows are rebuilt by renderRows.
        var wide0 = g.w >= PREVIEW_MIN_PANEL;
        s.wide = wide0;
        s.list = box(lively.rect(0, FIELD_H + PILLS_H + 1, wide0 ? g.w - PREVIEW_W : g.w, g.h - FIELD_H - PILLS_H - 1 - FOOTER_H));
        s.list.applyStyle({ clipMode: "auto" });
        panel.addMorph(s.list);
        UI.scroller(s.list);

        // Preview pane for the highlighted row, with a hairline at its left edge.
        // Contents are rebuilt by renderPreview on every selection change.
        s.previewDiv = box(lively.rect(0, 0, 1, 10), HAIRLINE);
        s.preview = box(lively.rect(0, 0, PREVIEW_W - 1, 10));
        panel.addMorph(s.previewDiv);
        panel.addMorph(s.preview);

        // Empty states (no query / no match): icon, title, hint, centred. Texts that
        // layout() moves are built at (0,0): a Text built at rect(x,y) and later moved
        // with setPosition ends up offset twice (shape node + wrapper).
        s.emptyIcon = icon(lively.rect(0, 0, g.w, 40), "search_off", 34, Color.rgba(122, 115, 144, 0.55));
        s.bodyTitle = label(lively.rect(0, 0, g.w, 22), "", { px: 15, bold: true, color: INK, align: "center" });
        s.bodyHint = label(lively.rect(0, 0, g.w, 20), "", { px: 13, color: MUTED, align: "center" });
        panel.addMorph(s.emptyIcon);
        panel.addMorph(s.bodyTitle);
        panel.addMorph(s.bodyHint);

        s.footer = label(lively.rect(0, 0, 500, 18), "↑↓ navigate      ↵ show halo      tab scope      esc close", {
          px: 11, color: MUTED,
        });
        panel.addMorph(s.footer);

        // ---- keys. Plain DOM listeners, not the Text morph's own onKeyDown/onKeyUp:
        // Lively routes key events to its "focused morph", which can lag behind real
        // DOM focus right after opening, so keys typed at once were dropped (the text
        // landed in the field but the palette never saw it). The DOM's own `input`
        // event fires whenever the field's text changes, however it changed.
        var inputNode = input.renderContext().shapeNode;
        inputNode.addEventListener("input", function () { P.setQuery(inputNode.textContent); });

        // Focus must never leave the field while the palette is open. A click anywhere
        // else in the panel used to land focus on a Lively wrapper node (tabindex -1),
        // after which typing, Esc and the arrows no longer reached the palette; a click
        // inside the field could do the same. So: a mousedown outside the field does not
        // move focus at all, one inside it is followed by a refocus if Lively took it
        // away, and the palette's keys are handled on the document, refocusing the field
        // first if something else somehow has focus (the palette is modal).
        function refocus() {
          if (s.closed || inputNode.contains(document.activeElement)) return;
          input.focus();
          caretToEnd();   // typing continues at the end of the text
        }
        function caretToEnd() {
          try {
            var editable = inputNode.querySelector("[contenteditable]") || inputNode, range = document.createRange(), sel = window.getSelection();
            range.selectNodeContents(editable);
            range.collapse(false);
            sel.removeAllRanges();
            sel.addRange(range);
          } catch (e) { /* no selection API */ }
        }
        var downAt = null;
        panel.renderContext().shapeNode.addEventListener("mousedown", function (evt) {
          if (inputNode.contains(evt.target)) { downAt = { x: evt.clientX, y: evt.clientY }; setTimeout(refocus, 0); return; }
          evt.preventDefault();
        }, true);
        // Lively selects the whole text when the field is clicked, and the next key
        // would replace the query. A plain click (not a drag) puts the caret at the end
        // instead, and a select-all that shows up in the 250 ms after it is undone
        // (watched through selectionchange, so it does not matter which of the two
        // handlers runs first). A real drag-selection is left alone.
        var clickUntil = 0;
        inputNode.addEventListener("mouseup", function (evt) {
          var click = downAt && Math.abs(evt.clientX - downAt.x) < 4 && Math.abs(evt.clientY - downAt.y) < 4;
          downAt = null;
          if (!click) return;
          clickUntil = Date.now() + 250;
          // Done at once, and again before the first key that follows: input events
          // run ahead of timers, so a fast keystroke can arrive before any timeout.
          s.caretFixPending = true;
          caretToEnd();
        });
        s.onSelectionChange = function () {
          if (s.closed || Date.now() > clickUntil) return;
          var sel = window.getSelection();
          if (!sel.isCollapsed && inputNode.contains(sel.anchorNode) && sel.toString() === inputNode.textContent) caretToEnd();
        };
        document.addEventListener("selectionchange", s.onSelectionChange);
        s.onDocKeydown = function (evt) {
          if (s.closed) return;
          refocus();
          if (s.caretFixPending) { s.caretFixPending = false; caretToEnd(); }
          if (evt.key === "Escape") {
            evt.preventDefault(); evt.stopPropagation();
            P.close();
          } else if (evt.key === "ArrowDown" || evt.key === "ArrowUp") {
            evt.preventDefault(); evt.stopPropagation();
            P.move(evt.key === "ArrowDown" ? 1 : -1);
          } else if (evt.key === "Enter") {
            evt.preventDefault(); evt.stopPropagation();
            P.activate(s.selIndex);
          } else if (evt.key === "Tab") {
            evt.preventDefault(); evt.stopPropagation();
            P.setScope((s.scopeIndex + (evt.shiftKey ? SCOPES.length - 1 : 1)) % SCOPES.length);
          }
        };
        document.addEventListener("keydown", s.onDocKeydown, true);

        function layout() {
          if (s.closed) return;
          var g = geometry();
          panel.setExtent(lively.pt(g.w, g.h));
          panel.setPosition(lively.pt(g.x, g.y));
          input.setExtent(lively.pt(g.w - SIDE * 2 - 36 - 56, 28));
          s.escTag.setPosition(lively.pt(g.w - SIDE - 36, 16));
          s.divTop.setExtent(lively.pt(g.w, 1));
          s.divPills.setExtent(lively.pt(g.w, 1));
          s.divFooter.setExtent(lively.pt(g.w, 1));
          s.divFooter.setPosition(lively.pt(0, g.h - FOOTER_H));
          s.footer.setPosition(lively.pt(SIDE, g.h - FOOTER_H + 9));
          var top = FIELD_H + PILLS_H + 1;
          s.wide = g.w >= PREVIEW_MIN_PANEL;
          var bodyH = g.h - top - FOOTER_H;
          s.list.setExtent(lively.pt(s.wide ? g.w - PREVIEW_W : g.w, bodyH));
          s.previewDiv.setPosition(lively.pt(g.w - PREVIEW_W, top));
          s.previewDiv.setExtent(lively.pt(1, bodyH));
          s.preview.setPosition(lively.pt(g.w - PREVIEW_W + 1, top));
          s.preview.setExtent(lively.pt(PREVIEW_W - 1, bodyH));
          s.emptyIcon.setExtent(lively.pt(g.w, 40));
          s.bodyTitle.setExtent(lively.pt(g.w, 22));
          s.bodyHint.setExtent(lively.pt(g.w, 20));
          s.emptyIcon.setPosition(lively.pt(0, top + 90));
          s.bodyTitle.setPosition(lively.pt(0, top + 138));
          s.bodyHint.setPosition(lively.pt(0, top + 166));
          s.previewItem = null;   // the pane's size may have changed: rebuild it
          if (s.matches) P.renderRows(true);
        }
        s.layout = layout;
        layout();

        // Early keystrokes must not be lost: take focus right away.
        input.focus();
        P.refresh();
        P.syncMenuEntry(true);

        // Saved-world rows join when the listing returns.
        Search.fetchSaved(function (saved) {
          var found = saved.worlds.concat(saved.files, saved.morphs);
          if (s.closed || !found.length) return;
          s.items = s.items.concat(found);
          P.refresh(true);
        });
        return s;
      },

      setScope: function (i) {
        var s = lively.ide.tools.SearchPalette.current;
        if (!s) return;
        s.scopeIndex = i;
        lively.ide.tools.SearchPalette.refresh();
      },

      setQuery: function (q) {
        var s = lively.ide.tools.SearchPalette.current;
        if (!s || s.query === q) return;
        s.query = q;
        s.codeItems = [];   // hits for the old query would be wrong now
        lively.ide.tools.SearchPalette.fetchCode();
        lively.ide.tools.SearchPalette.refresh();
      },

      // Runtime code hits for the current query, after a short pause in typing.
      // A late answer for an older query is dropped.
      fetchCode: function () {
        var P = lively.ide.tools.SearchPalette, s = P.current;
        if (!s) return;
        clearTimeout(s.codeTimer);
        var q = s.query.trim();
        s.codeSeq++;
        if (q.length < CODE_MIN_QUERY) return;
        var seq = s.codeSeq;
        s.codeTimer = setTimeout(function () {
          lively.ide.tools.Search.codeItems(q, function (items) {
            if (s.closed || seq !== s.codeSeq) return;
            s.codeItems = items;
            P.refresh(true);
          }, {
            // not the palette's own morphs, which are in the world while it is open
            exclude: function (found) {
              return !!(found.object && found.object.isMorph && found.object.ownerChain &&
                found.object.ownerChain().indexOf(s.scrim) >= 0) || found.object === s.scrim;
            },
          });
        }, CODE_DELAY);
      },

      // Items matching a query, ranked: name prefix > name contains > text
      // contains > world contains (search.md §3.3). Case-insensitive substring.
      match: function (items, query) {
        var q = String(query || "").trim().toLowerCase();
        if (!q) return [];
        var ranked = [];
        items.forEach(function (it) {
          var name = (it.name || "").toLowerCase(),
            rank = name.indexOf(q) === 0 ? 0
              : name.indexOf(q) > 0 ? 1
              : (it.text || "").toLowerCase().indexOf(q) >= 0 ? 2
              : (it.world || it.path || "").toLowerCase().indexOf(q) >= 0 ? 3 : -1;
          if (rank >= 0) ranked.push({ rank: rank, item: it });
        });
        ranked.sort(function (a, b) { return a.rank - b.rank; });
        return ranked.map(function (r) { return r.item; });
      },

      // Items per scope tab, for the current query.
      countsFor: function (matches) {
        var morphs = matches.filter(function (i) { return i.group === "world" || i.group === "saved"; }).length;
        var worlds = matches.filter(function (i) { return i.group === "worlds"; }).length;
        var code = matches.filter(function (i) { return i.group === "code"; }).length;
        var files = matches.filter(function (i) { return i.group === "files"; }).length;
        return { all: matches.length, morphs: morphs, worlds: worlds, code: code, files: files };
      },

      // Re-render everything that depends on scope/query/items.
      refresh: function (keepSelection) {
        var P = lively.ide.tools.SearchPalette, s = P.current;
        if (!s || s.closed) return;
        var matches = P.match(s.items, s.query).concat(s.codeItems || []);
        s.matches = matches;
        var counts = P.countsFor(matches);

        s.placeholder.setVisible(!s.query);
        s.placeholder.renderContext().shapeNode.style.display = s.query ? "none" : "";

        var x = SIDE;
        s.pills.forEach(function (pill, i) {
          var scope = SCOPES[i], selected = i === s.scopeIndex,
            n = counts[scope.id],
            text = scope.label + (s.query ? "  " + (scope.id === "code" && n >= lively.ide.tools.Search.CODE_CAP ? n + "+" : n) : ""),
            w = lively.identity.HomestarUI.textW(text, 12, true) + 28;
          pill.setExtent(lively.pt(w, PILL_H));
          pill.setPosition(lively.pt(x, FIELD_H + (PILLS_H - PILL_H) / 2));
          pill._label.setExtent(lively.pt(w, 18));
          pill._label.textString = text;
          pill._label.applyStyle({ textColor: selected ? Color.white : MUTED });
          pill.applyStyle({ fill: selected ? ACCENT : null });
          var pn = pill.renderContext().shapeNode;
          pn.style.background = selected ? ACCENT.toString() : "transparent";
          pn.style.boxShadow = selected ? "none" : "inset 0 0 0 1px rgba(30,24,44,0.14)";
          pill._label.renderContext().shapeNode.style.color = selected ? "#fff" : MUTED.toString();
          x += w + 8;
        });

        P.renderRows(keepSelection);
      },

      // Items visible under a scope tab. Code/Files have no sources yet.
      visibleFor: function (matches, scopeId) {
        if (scopeId === "all") return matches;
        if (scopeId === "morphs") return matches.filter(function (i) { return i.group === "world" || i.group === "saved"; });
        if (scopeId === "worlds") return matches.filter(function (i) { return i.group === "worlds"; });
        if (scopeId === "code") return matches.filter(function (i) { return i.group === "code"; });
        if (scopeId === "files") return matches.filter(function (i) { return i.group === "files"; });
        return [];
      },

      // Rebuild the list (or the empty state) for the current scope/query. The
      // selection goes back to the first row unless keepSelection and the
      // previously selected item is still shown.
      renderRows: function (keepSelection) {
        var P = lively.ide.tools.SearchPalette, s = P.current;
        if (!s || s.closed) return;
        var scopeId = SCOPES[s.scopeIndex].id,
          shown = s.query ? P.visibleFor(s.matches, scopeId) : [],
          prevItem = keepSelection && s.rows && s.rows[s.selIndex] && s.rows[s.selIndex].item;

        s.list.removeAllMorphs();
        s.rows = [];
        s.selIndex = 0;

        var empty = !shown.length;
        s.emptyShown = empty;
        s.emptyIcon.setVisible(empty);
        s.bodyTitle.setVisible(empty);
        s.bodyHint.setVisible(empty);
        s.list.setVisible(!empty);
        if (empty) {
          var none = !!s.query;
          s.emptyIcon.textString = none ? "search_off" : "history";
          s.bodyTitle.textString = none ? "No matches for “" + s.query.trim() + "”" : "Recent";
          s.bodyHint.textString = none
            ? "Try a morph name, text inside a morph, or a saved world."
            : "Nothing yet. Type a morph name, text inside a morph, or a saved world.";
          P.updateFooter();
          P.renderPreview();
          return;
        }

        var listW = s.list.getExtent().x, rowW = listW - 20 - 14,
          y = 8, rendered = 0, truncated = false;
        GROUPS.forEach(function (grp) {
          var its = shown.filter(function (i) { return i.group === grp.id; });
          if (!its.length) return;
          var cap = scopeId === "all" ? ALL_CAP : Infinity,
            vis = its.slice(0, Math.min(cap, MAX_ROWS - rendered));
          if (!vis.length) { truncated = true; return; }
          if (vis.length < its.length && scopeId !== "all") truncated = true;

          // group header: "IN THIS WORLD  3" and, when capped, "Show N more"
          s.list.addMorph(label(lively.rect(SIDE - 4, y, 300, 18), grp.title + "  " + its.length, { px: 11, bold: true, color: MUTED }));
          if (its.length > vis.length && scopeId === "all") {
            var more = label(lively.rect(listW - SIDE - 14 - 160 + 4, y, 160, 18), "Show " + (its.length - vis.length) + " more", {
              px: 12, bold: true, color: ACCENT_TEXT, align: "right",
            });
            more.eventsAreIgnored = false;
            more.handStyle = "pointer";
            more.onMouseDown = function (evt) { evt.stop(); return true; };
            more.onMouseUp = function (evt) {
              P.setScope(SCOPES.map(function (sc) { return sc.id; }).indexOf(grp.scope));
              evt.stop();
              return true;
            };
            s.list.addMorph(more);
          }
          y += 24;
          vis.forEach(function (item) {
            s.rows.push(P.buildRow(item, y, rowW, s.rows.length));
            y += ROW_H + ROW_GAP;
            rendered++;
          });
          y += 10;
        });
        if (truncated) {
          s.list.addMorph(label(lively.rect(SIDE - 4, y, 500, 18), "Showing the first " + MAX_ROWS + ". Refine your search to see the rest.", { px: 12, color: MUTED }));
          y += 26;
        }
        s.list.addMorph(box(lively.rect(0, y, 1, 4)));   // bottom breathing room in the scroll extent

        var keep = prevItem ? s.rows.map(function (r) { return r.item; }).indexOf(prevItem) : -1;
        P.select(keep >= 0 ? keep : 0, true);
        if (keep < 0) s.list.renderContext().shapeNode.scrollTop = 0;
      },

      // One result row: chip, name with the matched part highlighted, meta line, type tag.
      buildRow: function (item, y, rowW, index) {
        var P = lively.ide.tools.SearchPalette, s = P.current,
          type = TYPES[item.type] || TYPES.box,
          row = box(lively.rect(10, y, rowW, ROW_H));
        row.applyStyle({ borderRadius: 12 });
        row.eventsAreIgnored = false;
        row.handStyle = "pointer";

        var chip = box(lively.rect(10, 9, 34, 34), Color.rgba(type.tint.r * 255, type.tint.g * 255, type.tint.b * 255, 0.14));
        chip.applyStyle({ borderRadius: 10 });
        chip.eventsAreIgnored = true;
        chip.addMorph(icon(lively.rect(0, 6, 34, 24), type.icon, 18, type.tint));
        row.addMorph(chip);

        // Tag, right aligned. A saved-world row also gets an open-in-new glyph:
        // picking it leaves the page.
        var tagW = Math.ceil(textWidth(type.label, 11, true)) + 18,
          tagX = rowW - 12 - tagW,
          tag = box(lively.rect(tagX, 15, tagW, 22), Color.rgba(30, 24, 44, 0.06));
        tag.applyStyle({ borderRadius: 8 });
        tag.eventsAreIgnored = true;
        var tagLabel = label(lively.rect(0, 2, tagW, 18), type.label, { px: 11, bold: true, color: MUTED, align: "center" });
        tag.addMorph(tagLabel);
        row.addMorph(tag);
        var rightEdge = tagX;
        if (item.url) {
          row.addMorph(icon(lively.rect(tagX - 28, 14, 24, 24), "open_in_new", 16, Color.rgb(249, 115, 22)));
          rightEdge = tagX - 30;
        }

        // Name: before / match / after as adjacent Text morphs, placed by measured
        // width (a Text cannot mix colours). Each box is the measure plus the 4px
        // side padding the Text shape node carries.
        var NAME_X = 54, NAME_PX = 14, maxW = rightEdge - NAME_X - 8,
          name = item.name || "(unnamed)", q = (s.query || "").trim().toLowerCase(),
          idx = item.name && q ? name.toLowerCase().indexOf(q) : -1,
          parts = idx < 0 ? [{ t: name }] : [
            { t: name.slice(0, idx) },
            { t: name.slice(idx, idx + q.length), hl: true },
            { t: name.slice(idx + q.length) },
          ],
          cx = 0;
        parts.forEach(function (part) {
          if (!part.t || cx >= maxW) return;
          var w = Math.ceil(textWidth(part.t, NAME_PX, part.hl)),
            boxW = Math.min(w, maxW - cx) + 8;
          row.addMorph(label(lively.rect(NAME_X + cx - 4, 8, boxW, 22), part.t, {
            px: NAME_PX, bold: part.hl, color: part.hl ? ACCENT_TEXT : item.name ? INK : MUTED,
          }));
          cx += w;
        });

        var meta = item.meta ? item.meta : item.cls + (item.text ? "  ·  “" + item.text + "”" : "") + (item.world ? "  ·  in " + item.world : "");
        row.addMorph(label(lively.rect(NAME_X - 4, 29, maxW + 8, 18), meta, { px: 12, color: MUTED }));

        row.onMouseDown = function (evt) { evt.stop(); return true; };   // keep focus in the field
        row.onMouseOver = function () {
          if (Date.now() - (s.kbAt || 0) > 250) P.select(index, false);   // not while the keyboard is scrolling under the cursor
        };
        row.onMouseUp = function (evt) { P.activate(index); evt.stop(); return true; };
        s.list.addMorph(row);

        var rnode = row.renderContext().shapeNode;
        rnode.setAttribute("role", "button");
        rnode.setAttribute("aria-label", "Result: " + name);
        return { item: item, row: row, tag: tag, tagLabel: tagLabel, y: y };
      },

      // Highlight one row (the pink wash, and the tag becomes the pink enter key).
      select: function (i, scrollIntoView) {
        var P = lively.ide.tools.SearchPalette, s = P.current;
        if (!s || !s.rows) return;
        if (!s.rows.length) { s.selIndex = 0; P.updateFooter(); return; }
        i = Math.max(0, Math.min(s.rows.length - 1, i));
        var prev = s.rows[s.selIndex];
        function paint(r, on) {
          if (!r) return;
          var type = TYPES[r.item.type] || TYPES.box;
          setBg(r.row, on ? SELECTED_WASH : null);
          setBg(r.tag, on ? ACCENT : Color.rgba(30, 24, 44, 0.06));
          r.tagLabel.textString = on ? "↵" : type.label;
          r.tagLabel.applyStyle({ textColor: on ? Color.white : MUTED, fontSize: (on ? 15 : 11) * 0.75 });
          r.tagLabel.renderContext().shapeNode.style.color = on ? "#fff" : MUTED.toString();
        }
        if (prev && prev !== s.rows[i]) paint(prev, false);
        s.selIndex = i;
        paint(s.rows[i], true);
        P.updateFooter();
        P.renderPreview();
        if (scrollIntoView) {
          var node = s.list.renderContext().shapeNode, r = s.rows[i],
            top = r.y - 30, bottom = r.y + ROW_H + 10;
          if (top < node.scrollTop) node.scrollTop = top < 40 ? 0 : top;
          else if (bottom > node.scrollTop + node.clientHeight) node.scrollTop = bottom - node.clientHeight;
        }
      },

      // Arrow keys: wrap around, and keep the highlighted row in view.
      move: function (delta) {
        var P = lively.ide.tools.SearchPalette, s = P.current;
        if (!s || !s.rows || !s.rows.length) return;
        s.kbAt = Date.now();
        P.select((s.selIndex + delta + s.rows.length) % s.rows.length, true);
      },

      // Run the row's primary action. The palette closes first, so a halo is
      // not shown under the scrim.
      activate: function (i) {
        var P = lively.ide.tools.SearchPalette, s = P.current, r = s && s.rows && s.rows[i];
        if (!r) return;
        P.close();
        r.item.run();
      },

      // What Enter does for an item: the button's label and the footer's hint.
      actionOf: function (item) {
        if (item.type === "code") return { label: "Open in browser", hint: "open in code browser" };
        if (item.type === "folder") return { label: "Open folder", hint: "open folder in Files" };
        if (item.type === "file") return { label: "Open file", hint: "open file" };
        if (item.url) return { label: "Open world", hint: "open world in new tab" };
        return { label: "Show halo", hint: "show halo" };
      },

      // key/value lines shown under the preview art for an item
      previewFields: function (item) {
        var fields = [];
        if (item.type === "world") {
          var info = item.info || {};
          if (info.morphs != null) fields.push(["Morphs", String(info.morphs)]);
          fields.push(["Visibility", info.visibility && info.visibility !== "public" ? "Private" : "Public"]);
          var d = new Date(info.created);
          if (!isNaN(d.getTime())) fields.push(["Created", d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" })]);
          fields.push(["Opens", "In a new tab"]);
          return fields;
        }
        if (item.type === "file" || item.type === "folder") {
          var fi = item.info || {};
          fields.push(["Kind", item.cls]);
          if (fi.folder) fields.push(["Files", String(fi.fileCount)]);
          if (fi.size != null) fields.push(["Size", lively.ide.tools.Search.formatSize(fi.size)]);
          fields.push(["Visibility", fi.visibility.charAt(0).toUpperCase() + fi.visibility.slice(1)]);
          var fd = new Date(fi.created);
          if (!isNaN(fd.getTime())) fields.push([fi.folder ? "Created" : "Added", fd.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" })]);
          fields.push(["Opens", fi.folder ? "In the Files window" : "In a preview or a new tab"]);
          return fields;
        }
        if (item.type === "code") {
          var ci = item.info || {};
          fields.push(["Kind", item.cls]);
          fields.push(["Object", ci.object || ""]);
          if (ci.member) fields.push(["Member", ci.member]);
          if (item.text) fields.push(["Match", "\u201c" + item.text + "\u201d"]);
          fields.push(["Opens", "In the code browser"]);
          return fields;
        }
        fields.push(["Class", item.cls]);
        fields.push(["Where", item.world ? item.world : "This world"]);
        if (item.morph && item.morph.getExtent) {
          var ext = item.morph.getExtent();
          fields.push(["Size", Math.round(ext.x) + " × " + Math.round(ext.y)]);
        }
        if (item.text) fields.push(["Text", "“" + item.text + "”"]);
        if (item.url) fields.push(["Opens", "In a new tab"]);
        return fields;
      },

      // The right pane: stylised art for the type, name, type, key/value lines and
      // two buttons. Rebuilt on every selection change (about 15 small morphs).
      renderPreview: function () {
        var P = lively.ide.tools.SearchPalette, s = P.current;
        if (!s || !s.preview) return;
        var r = s.rows && s.rows[s.selIndex],
          on = !!(s.wide && r && !s.emptyShown);
        s.preview.setVisible(on);
        s.previewDiv.setVisible(on);
        // Late results (saved worlds, code) re-render the list; leave the preview
        // alone when it is already showing this item, or a click in progress on one
        // of its buttons would land on a morph that has just been replaced.
        if (on && s.previewItem === r.item && s.preview.submorphs.length) return;
        s.preview.removeAllMorphs();
        s.previewItem = on ? r.item : null;
        if (!on) return;

        var item = r.item, type = TYPES[item.type] || TYPES.box,
          W = PREVIEW_W - 1, pad = 20, innerW = W - pad * 2,
          tint = type.tint,
          rgba = function (a) { return "rgba(" + Math.round(tint.r * 255) + "," + Math.round(tint.g * 255) + "," + Math.round(tint.b * 255) + "," + a + ")"; };

        // The art tile shrinks (to at least 80px) when there are many key/value lines,
        // so the last line never runs into the buttons pinned to the bottom.
        var fields = P.previewFields(item),
          paneH = s.preview.getExtent().y,
          buttonsY = paneH - 18 - 36,
          artH = Math.max(80, Math.min(150, buttonsY - 10 - 26 * fields.length - 34 - 26 - 16 - 18));

        // art: a soft gradient tile with two washed circles and the type's icon
        var art = box(lively.rect(pad, 18, innerW, artH));
        art.applyStyle({ borderRadius: 16, clipMode: "hidden" });
        s.preview.addMorph(art);
        art.renderContext().shapeNode.style.background = "linear-gradient(135deg, " + rgba(0.22) + ", " + rgba(0.06) + ")";
        var c1 = box(lively.rect(innerW - 80, -30, 120, 120), Color.rgba(tint.r * 255, tint.g * 255, tint.b * 255, 0.10));
        c1.applyStyle({ borderRadius: 60 });
        var c2 = box(lively.rect(-30, 96, 90, 90), Color.rgba(tint.r * 255, tint.g * 255, tint.b * 255, 0.08));
        c2.applyStyle({ borderRadius: 45 });
        art.addMorph(c1);
        art.addMorph(c2);
        var artIcon = icon(lively.rect(0, Math.round(artH / 2 - 31), innerW, 64), type.icon, 56, tint);
        art.addMorph(artIcon);
        s.currentArt = art;                 // a thumbnail replaces these once it is ready
        s.artParts = [c1, c2, artIcon];

        var nameY = 18 + artH + 16;
        s.preview.addMorph(label(lively.rect(pad - 4, nameY, innerW + 8, 24), item.name || "(unnamed)", {
          px: 17, bold: true, color: item.name ? INK : MUTED,
        }));
        s.preview.addMorph(label(lively.rect(pad - 4, nameY + 26, innerW + 8, 18), type.label, { px: 12, color: MUTED }));

        var y = nameY + 26 + 34;
        fields.forEach(function (f) {
          s.preview.addMorph(label(lively.rect(pad - 4, y, 80, 18), f[0], { px: 12, color: MUTED }));
          s.preview.addMorph(label(lively.rect(pad + 72, y, innerW - 72 + 4, 20), f[1], { px: 13, color: INK }));
          y += 26;
        });

        // buttons, pinned to the bottom of the pane
        var BH = 36, by = buttonsY,
          primaryText = P.actionOf(item).label + "  ↵",
          w1 = Math.ceil(textWidth(primaryText, 13, true)) + 36,
          w2 = Math.ceil(textWidth("Copy name", 13, true)) + 32;

        var primary = box(lively.rect(pad, by, w1, BH), ACCENT);
        primary.applyStyle({ borderRadius: 18 });
        primary.addMorph(label(lively.rect(0, 9, w1, 18), primaryText, { px: 13, bold: true, color: Color.white, align: "center" }));
        primary.eventsAreIgnored = false;
        primary.handStyle = "pointer";
        primary.onMouseDown = function (evt) { evt.stop(); return true; };   // keep focus in the field
        primary.onMouseUp = function (evt) { P.activate(s.selIndex); evt.stop(); return true; };
        s.preview.addMorph(primary);
        var pnode = primary.renderContext().shapeNode;
        pnode.style.background = ACCENT.toString();
        pnode.setAttribute("role", "button");
        pnode.setAttribute("aria-label", "Preview action");

        var copyLabel = label(lively.rect(0, 9, w2, 18), "Copy name", { px: 13, bold: true, color: INK, align: "center" });
        var copy = box(lively.rect(pad + w1 + 10, by, w2, BH));
        copy.applyStyle({ borderRadius: 18 });
        copy.addMorph(copyLabel);
        copy.eventsAreIgnored = false;
        copy.handStyle = "pointer";
        copy.onMouseDown = function (evt) { evt.stop(); return true; };
        copy.onMouseUp = function (evt) {
          P.copyName(item.name || "", function (ok) {
            copyLabel.textString = ok ? "Copied" : "Copy failed";
            setTimeout(function () { if (copyLabel.owner) copyLabel.textString = "Copy name"; }, 1200);
          });
          evt.stop();
          return true;
        };
        s.preview.addMorph(copy);
        var cnode = copy.renderContext().shapeNode;
        cnode.style.boxShadow = "inset 0 0 0 1px rgba(30,24,44,0.14)";
        cnode.setAttribute("role", "button");
        cnode.setAttribute("aria-label", "Copy name");

        P.loadThumb(item);
      },

      // Replaces the drawn art with a real thumbnail of the highlighted item, when
      // it has one: a source excerpt at once, anything else after THUMB_DELAY (so
      // holding an arrow key does not start a render per row). A result is only
      // shown if its item is still the highlighted one; the palette closing, the
      // highlight moving and the same item being asked for twice are all handled.
      loadThumb: function (item) {
        var P = lively.ide.tools.SearchPalette, s = P.current, T = lively.ide.tools.SearchThumbnail;
        if (!s) return;
        clearTimeout(s.thumbTimer);
        var code = T.forCode(item);
        if (code) return P.showThumb(item, code);
        var key = T.keyFor(item);
        if (!key) return;
        if (s.thumbs[key]) return P.showThumb(item, s.thumbs[key]);
        if (s.thumbPending[key]) return;   // on its way: shown when it arrives, if still highlighted
        s.thumbTimer = setTimeout(function () {
          if (s.closed || s.previewItem !== item) return;
          s.thumbPending[key] = true;
          T.load(item, function (err, t) {
            delete s.thumbPending[key];
            if (err || !t) return;           // keeps the drawn art
            if (s.closed) { if (t.revoke) URL.revokeObjectURL(t.src); return; }
            s.thumbs[key] = t;
            if (s.previewItem === item) P.showThumb(item, t);
          }, function wanted() { return !s.closed && s.previewItem === item; });
        }, THUMB_DELAY);
      },

      showThumb: function (item, t) {
        var P = lively.ide.tools.SearchPalette, s = P.current;
        if (!s || s.closed || s.previewItem !== item || !s.currentArt || !s.currentArt.owner) return;
        var node = s.currentArt.renderContext().shapeNode,
          old = node.querySelector("[data-thumb]"),
          el;
        if (old) old.parentNode.removeChild(old);
        if (t.kind === "img") {
          el = document.createElement("img");
          el.alt = item.name || "";
          el.style.cssText = "position:absolute;left:0;top:0;width:100%;height:100%;object-fit:contain;opacity:0;" +
            "transition:opacity .15s;pointer-events:none;user-select:none;border-radius:inherit";
          el.onload = function () { el.style.opacity = "1"; };
          el.src = t.src;
          node.style.background = "#fff";
          node.style.boxShadow = "inset 0 0 0 1px rgba(30,24,44,0.08)";
        } else {
          el = document.createElement("pre");
          el.textContent = t.text;
          el.style.cssText = "margin:0;position:absolute;left:0;top:0;right:0;bottom:0;padding:10px 12px;overflow:hidden;" +
            "font:11px/1.45 ui-monospace,Menlo,Consolas,monospace;color:#1f2a37;white-space:pre;pointer-events:none;user-select:none";
        }
        el.setAttribute("data-thumb", "1");
        el.setAttribute("data-key", lively.ide.tools.SearchThumbnail.keyFor(item) || "code");   // which item it belongs to
        node.appendChild(el);
        (s.artParts || []).forEach(function (m) { m.setVisible(false); });
      },

      copyName: function (text, done) {
        try {
          navigator.clipboard.writeText(text).then(function () { done(true); }, function () { done(false); });
        } catch (e) {
          done(false);
        }
      },


      updateFooter: function () {
        var s = lively.ide.tools.SearchPalette.current;
        if (!s) return;
        var r = s.rows && s.rows[s.selIndex],
          action = !r ? "" : lively.ide.tools.SearchPalette.actionOf(r.item).hint;
        s.footer.textString = "↑↓ navigate      " + (action ? "↵ " + action + "      " : "") + "tab scope      esc close";
      },
    };

  }); // end module('lively.ide.tools.SearchPalette')
