/**
 * lively.gaming.LibraryView
 *
 * The library screen of the Gaming template: header (world name, count, theme
 * switch), a left rail of shelves and platforms, a toolbar (search, sort, grid or
 * list, add) and the grid of games. A controller, not a morph: it owns one morph
 * subtree that it builds into its host (lively.gaming.Gaming) and lays out from one
 * place, layout(w, h), the way PostcardReel and Homestar do. Nothing here talks to
 * the server: the host owns the data (host.state.entries) and the writes
 * (host.saveEntry / addGame / removeEntry); this view only asks.
 *
 * THE GRID IS WINDOWED. A library of 3,000 games at 9 morphs a tile would be 27,000
 * live morphs, which a morphic world cannot carry. Instead only the rows in view
 * (plus a buffer) are realised: a scroll Box holds one tall spacer (so the scrollbar
 * is the right size) and a small POOL of tiles that are recycled as the list scrolls.
 * Measured at 3,000 games: ~170 morphs, ~250 ms to first paint, no long frames.
 * A tile is therefore never "the tile of game N": it is a pool slot that is currently
 * showing game N (tile.__idx), and everything about it is re-filled by _fillTile.
 *
 * A tile's clickable surface is the tile itself. Its children are decorative
 * (eventsAreIgnored, drag flags cleared) and the tile's own handler hit-tests the one
 * child that is a separate target (the visibility badge), because a mouse handler on
 * an ancestor runs BEFORE its descendants' and would otherwise swallow their clicks.
 *
 * Re-rendering on a click: a handler never rebuilds the morph that received the click
 * while it is still handling it; changes that rebuild controls are deferred one tick
 * (setTimeout 0), after the event has finished dispatching.
 */

module("lively.gaming.LibraryView")
  .requires("lively.morphic.Complete", "lively.gaming.GamingUI", "lively.gaming.GameLog")
  .toRun(function () {

    var HEADER_H = 68;
    var RAIL_W = 232;
    var TOOLBAR_H = 64;
    var PAD = 24;
    var GAP = 14;
    var TILE_W = 176, TILE_H = 334;       // grid tile
    var ROW_H = 64, ROW_GAP = 8;          // list row
    var BUFFER_ROWS = 1;                  // rows realised above and below the viewport

    var SORTS = [
      { key: "added", label: "Sort: Recently added" },
      { key: "title", label: "Sort: Title" },
      { key: "playtime", label: "Sort: Playtime" },
      { key: "rating", label: "Sort: My rating" },
    ];
    var SHELVES = [
      { key: "all", label: "All games" }, { key: "playing", label: "Playing" }, { key: "backlog", label: "Backlog" },
      { key: "completed", label: "Completed" }, { key: "dropped", label: "Dropped" }, { key: "wishlist", label: "Wishlist" },
    ];
    var PLATFORMS = [
      { key: "all", label: "All platforms" }, { key: "steam", label: "Steam" },
      { key: "itch", label: "itch.io" }, { key: "manual", label: "Added by hand" },
    ];
    var VIS_ICON = { private: "lock", public: "public", shared: "group" };
    var VIS_LABEL = { private: "Only you", public: "Public", shared: "Shared" };

    // Which platform(s) an entry belongs to, for the platform filter and the tile's
    // meta line. An entry with no external ids was added by hand.
    function platformsOf(entry) {
      var ids = entry.payload.external_ids || {}, out = [];
      if (ids.steam) out.push("steam");
      if (ids.itch) out.push("itch");
      return out.length ? out : ["manual"];
    }

    function hoursText(minutes) {
      if (minutes == null) return null;
      if (minutes < 60) return minutes + " min";
      var h = minutes / 60;
      return (h >= 10 ? Math.round(h) : Math.round(h * 10) / 10) + " h";
    }

    // "47 h · <source>" / "3 h · by you" / "No playtime": always with its source.
    function metaText(entry) {
      var pt = lively.gaming.GameLog.playtimeOf(entry.payload);
      if (pt.minutes == null) return "No playtime";
      var src = pt.source === "manual" ? "by you" : pt.source === "itch" ? "itch.io" : "Steam";
      return hoursText(pt.minutes) + " · " + src;
    }

    Object.subclass("lively.gaming.LibraryView", {

      // host: the lively.gaming.Gaming morph that owns the data and the writes.
      initialize: function (host) {
        this.host = host;
        this.filter = { status: "all", platform: "all", query: "", sort: "added", mode: "grid" };
        this.items = [];          // the filtered, sorted entries currently shown
        this.pool = [];           // recyclable tiles
        this.cols = 1;
        this.w = 0; this.h = 0;
        this.root = null;         // the morph holding everything this view builds
        this._searchTimer = null;
      },

      // ─── building ────────────────────────────────────────────────────────

      // Builds every morph into the host, from the current theme. Call once after the host
      // has been emptied; a theme switch calls it again on a freshly emptied host.
      build: function () {
        var UI = lively.gaming.GamingUI, th = UI.theme(), self = this;
        this.th = th;
        this.pool = [];
        this.root = UI.box(lively.rect(0, 0, 10, 10), null, { clip: false });
        this.root.eventsAreIgnored = true;
        this.host.addMorph(this.root);

        // header
        this.titleLabel = UI.label(lively.rect(0, 0, 520, 34), this.host.worldName(), { px: 24, font: "display", color: th.text });
        this.countLabel = UI.label(lively.rect(0, 0, 320, 18), "", { px: 13, color: th.muted });
        this.root.addMorph(this.titleLabel);
        this.root.addMorph(this.countLabel);
        this._buildThemeSwitch();

        // the rail and toolbar are rebuilt by refresh(); the search field persists (typing
        // must not lose focus when the counts change)
        this.railBox = UI.box(lively.rect(0, 0, RAIL_W, 10), null, { clip: false });
        this.railBox.eventsAreIgnored = true;
        this.root.addMorph(this.railBox);
        this.railLine = UI.box(lively.rect(0, 0, 1, 10), th.line);
        this.railLine.eventsAreIgnored = true;
        this.root.addMorph(this.railLine);

        this.toolBox = UI.box(lively.rect(0, 0, 10, TOOLBAR_H), null, { clip: false });
        this.toolBox.eventsAreIgnored = true;
        this.root.addMorph(this.toolBox);
        this.search = UI.input(lively.rect(0, 0, 300, 38), {
          placeholder: "Search your library", maxLen: 80,
          onInput: function (v) {
            self.filter.query = v;
            clearTimeout(self._searchTimer);
            self._searchTimer = setTimeout(function () { self.refresh(); }, 120);
          },
        });
        this.toolBox.addMorph(this.search.box);

        // the scrolling grid
        this.scroll = UI.box(lively.rect(0, 0, 10, 10), null, { clip: true });
        this.scroll.applyStyle({ clipMode: "auto" });
        this.scroll.eventsAreIgnored = false;
        this.root.addMorph(this.scroll);
        UI.scroller(this.scroll, th);
        this.spacer = UI.box(lively.rect(0, 0, 4, 10), null, { clip: false });
        this.spacer.eventsAreIgnored = true;
        this.scroll.addMorph(this.spacer);
        var node = this.scroll.renderContext().shapeNode, pending = false;
        node.addEventListener("scroll", function () {
          if (pending) return;
          pending = true;
          requestAnimationFrame(function () { pending = false; self._syncTiles(); });
        });

        this.msgBox = null;
        this._buildToolbarButtons();
      },

      _buildThemeSwitch: function () {
        var UI = lively.gaming.GamingUI, th = this.th, self = this;
        var pref = UI.getThemePref();
        var opts = [["auto", "Auto"], ["light", "Light"], ["dark", "Dark"]];
        var segW = 58, h = 30;
        var holder = UI.box(lively.rect(0, 0, segW * 3 + 4, h + 4), th.surface, { radius: (h + 4) / 2, border: th.line });
        opts.forEach(function (o, i) {
          var on = pref === o[0];
          var seg = UI.box(lively.rect(2 + i * segW, 2, segW, h), on ? th.accent : null, { radius: h / 2 });
          seg.addMorph(UI.label(lively.rect(0, Math.round((h - 18) / 2), segW, 22), o[1], { px: 12, bold: true, align: "center", color: on ? th.onAccent : th.muted }));
          seg.onMouseUp = function (evt) {
            evt.stop();
            // The theme switch rebuilds this whole view, so do it after this click has finished.
            setTimeout(function () { UI.setThemePref(o[0]); }, 0);
            return true;
          };
          UI.makeInteractive(seg, { role: "radio", label: "Theme: " + o[1], pressed: on, onActivate: function () { UI.setThemePref(o[0]); } });
          holder.addMorph(seg);
        });
        this.themeSwitch = holder;
        this.root.addMorph(holder);
      },

      // ─── toolbar ─────────────────────────────────────────────────────────

      // The sort, view and add buttons, laid out right to left; the search field takes the
      // rest. Rebuilt when the sort changes (its label changes width) and on resize.
      _buildToolbarButtons: function () {
        var UI = lively.gaming.GamingUI, self = this;
        (this._toolBtns || []).forEach(function (b) { b.remove(); });
        this._toolBtns = [];
        var w = Math.max(this.w - RAIL_W, 300), x = w - PAD, y = 15;
        var add = function (b) { self.toolBox.addMorph(b); self._toolBtns.push(b); return b; };

        if (this.host.isOwner()) {
          var addBtn = UI.button(0, y, "Add game", { variant: "primary", icon: "add", onClick: function () { self.host.openAdd(); } });
          x -= addBtn.getExtent().x; addBtn.setPosition(lively.pt(x, y)); add(addBtn);
          x -= 8;
          // Reading a linked account's library is always the owner's own action: the dialog
          // explains and offers to connect an account when none is linked yet.
          var importBtn = UI.button(0, y, "Import", { variant: "secondary", icon: "sync", onClick: function () { self.host.openImport(); }, ariaLabel: "Import games from a linked account" });
          x -= importBtn.getExtent().x; importBtn.setPosition(lively.pt(x, y)); add(importBtn);
          x -= 12;
        }
        var modeBtn = function (mode, icon, label) {
          var on = self.filter.mode === mode, th = self.th;
          var b = UI.box(lively.rect(0, y, 34, 32), on ? th.accentSoft : th.surface, { radius: 10, border: on ? th.accent : th.line });
          b.addMorph(UI.icon(lively.rect(0, 5, 34, 22), icon, 18, on ? th.accent : th.muted));
          b.onMouseUp = function (evt) { evt.stop(); setTimeout(function () { self.setMode(mode); }, 0); return true; };
          UI.makeInteractive(b, { role: "radio", label: label, pressed: on, onActivate: function () { self.setMode(mode); } });
          x -= 34; b.setPosition(lively.pt(x, y)); x -= 6;
          return add(b);
        };
        modeBtn("list", "view_list", "List view");
        modeBtn("grid", "grid_view", "Grid view");
        x -= 6;
        var sort = SORTS.filter(function (s) { return s.key === this.filter.sort; }, this)[0];
        var sortBtn = UI.button(0, y, sort.label, { variant: "secondary", onClick: function () { self.cycleSort(); }, ariaLabel: sort.label + ". Click to change." });
        x -= sortBtn.getExtent().x; sortBtn.setPosition(lively.pt(x, y)); add(sortBtn);
        x -= 14;

        var sw = Math.max(160, x - PAD);
        this.search.box.setExtent(lively.pt(sw, 38));
        this.search.box.setPosition(lively.pt(PAD, 13));
        this.search.text.setExtent(lively.pt(sw - 20, 20));
      },

      setMode: function (mode) {
        if (this.filter.mode === mode) return;
        this.filter.mode = mode;
        this._buildToolbarButtons();
        this._relayoutTiles();
        this.scroll.renderContext().shapeNode.scrollTop = 0;
        this.refresh();
      },

      cycleSort: function () {
        var i = SORTS.findIndex(function (s) { return s.key === this.filter.sort; }, this);
        this.filter.sort = SORTS[(i + 1) % SORTS.length].key;
        var self = this;
        setTimeout(function () { self._buildToolbarButtons(); self.refresh(); }, 0);
      },

      // ─── rail ────────────────────────────────────────────────────────────

      _buildRail: function () {
        var UI = lively.gaming.GamingUI, th = this.th, self = this;
        this.railBox.submorphs.slice().forEach(function (m) { m.remove(); });
        var entries = this.host.state.entries;
        var counts = { status: { all: entries.length }, platform: { all: entries.length } };
        entries.forEach(function (e) {
          counts.status[e.payload.status] = (counts.status[e.payload.status] || 0) + 1;
          platformsOf(e).forEach(function (p) { counts.platform[p] = (counts.platform[p] || 0) + 1; });
        });
        var y = 20, w = RAIL_W - 24;
        function section(title) {
          var head = UI.label(lively.rect(0, 0, w, 16), title.toUpperCase(), { px: 11, bold: true, color: th.muted });
          self.railBox.addMorph(head);
          head.setPosition(lively.pt(PAD, y));
          y += 22;
        }
        function row(def, group) {
          var on = self.filter[group] === def.key, n = counts[group][def.key] || 0;
          var r = UI.box(lively.rect(12, y, w, 34), on ? th.accentSoft : null, { radius: 10 });
          var name = UI.label(lively.rect(0, 0, w - 56, 20), def.label, { px: 13, weight: on ? 700 : 500, color: on ? th.accentText : th.text });
          var cnt = UI.label(lively.rect(0, 0, 40, 20), String(n), { px: 12, weight: 600, align: "right", color: on ? th.accentText : th.muted });
          r.addMorph(name); r.addMorph(cnt);
          name.setPosition(lively.pt(10, 6)); cnt.setPosition(lively.pt(w - 50, 7));
          r.onMouseUp = function (evt) {
            evt.stop();
            setTimeout(function () { self.filter[group] = def.key; self.scroll.renderContext().shapeNode.scrollTop = 0; self.refresh(); }, 0);
            return true;
          };
          UI.makeInteractive(r, { role: "button", label: def.label + ", " + n + (n === 1 ? " game" : " games"), pressed: on,
            onActivate: function () { self.filter[group] = def.key; self.refresh(); } });
          self.railBox.addMorph(r);
          y += 36;
        }
        section("Shelves");
        SHELVES.forEach(function (s) { row(s, "status"); });
        y += 12;
        section("Platforms");
        PLATFORMS.forEach(function (p) { row(p, "platform"); });
      },

      // ─── data to tiles ───────────────────────────────────────────────────

      // Recomputes what is shown (filter, search, sort) and redraws the rail, count and
      // grid. Call after ANY change to entries or filters. Cheap enough to call often.
      refresh: function () {
        var UI = lively.gaming.GamingUI, f = this.filter;
        var entries = this.host.state.entries;
        var q = f.query.trim().toLowerCase();
        var items = entries.filter(function (e) {
          if (f.status !== "all" && e.payload.status !== f.status) return false;
          if (f.platform !== "all" && platformsOf(e).indexOf(f.platform) < 0) return false;
          if (q && (e.payload.title || "").toLowerCase().indexOf(q) < 0) return false;
          return true;
        });
        var cmpTitle = function (a, b) { return (a.payload.title || "").localeCompare(b.payload.title || ""); };
        items.sort({
          added: function (a, b) { return (b.envelope.created || "").localeCompare(a.envelope.created || ""); },
          title: cmpTitle,
          playtime: function (a, b) {
            var pa = lively.gaming.GameLog.playtimeOf(a.payload).minutes || 0, pb = lively.gaming.GameLog.playtimeOf(b.payload).minutes || 0;
            return pb - pa || cmpTitle(a, b);
          },
          rating: function (a, b) { return (b.payload.rating || 0) - (a.payload.rating || 0) || cmpTitle(a, b); },
        }[f.sort]);
        this.items = items;
        var n = entries.length;
        this.countLabel.setTextString(n + (n === 1 ? " game" : " games") + (items.length !== n ? " · " + items.length + " shown" : ""));
        this._buildRail();
        this._updateSpacer();
        this._showEmptyState();
        this._syncTiles(true);
      },

      // The empty / loading / error states, centred in the grid area. Returns true when one
      // is showing (and so the grid has nothing to draw).
      _showEmptyState: function () {
        var UI = lively.gaming.GamingUI, th = this.th, self = this, st = this.host.state;
        if (this.msgBox) { this.msgBox.remove(); this.msgBox = null; }
        var kind = null, title = "", hint = "", icon = "sports_esports", action = null;
        if (st.error === "signin") { kind = "signin"; icon = "lock"; title = "Sign in to see this library"; hint = "This library belongs to an account. Sign in, or open it from its owner's page to see the games they made public."; }
        else if (st.error) { kind = "error"; icon = "error"; title = "Couldn't load the library"; hint = String(st.error).slice(0, 140);
          action = { label: "Try again", fn: function () { self.host.reload(); } }; }
        else if (!st.loaded) { kind = "loading"; icon = "hourglass_top"; title = "Loading your games…"; }
        else if (!this.items.length && !st.entries.length) {
          kind = "empty"; icon = "sports_esports";
          if (this.host.isOwner()) { title = "Your library is empty"; hint = "Add the games you play, have played, or want to play. Everything starts private."; action = { label: "Add a game", fn: function () { self.host.openAdd(); } }; }
          else { title = "Nothing public yet"; hint = "This person hasn't shared any games."; }
        } else if (!this.items.length) { kind = "nomatch"; icon = "search_off"; title = "No games match"; hint = "Try another shelf, platform or search."; }
        if (!kind) return false;
        var aw = this.w - RAIL_W, ah = this.h - HEADER_H - TOOLBAR_H, bw = Math.min(460, aw - 48);
        var box = UI.box(lively.rect(0, 0, bw, 220), null, { clip: false });
        box.eventsAreIgnored = true;
        box.addMorph(UI.icon(lively.rect(0, 0, bw, 44), icon, 38, th.muted));
        var t = UI.label(lively.rect(0, 0, bw, 24), title, { px: 17, bold: true, align: "center" });
        box.addMorph(t); t.setPosition(lively.pt(0, 56));
        if (hint) { var hh = UI.label(lively.rect(0, 0, bw, 54), hint, { px: 13, align: "center", color: th.muted, wrap: true }); box.addMorph(hh); hh.setPosition(lively.pt(0, 88)); }
        if (action) {
          var btn = UI.button(0, 150, action.label, { variant: "primary", onClick: action.fn });
          btn.setPosition(lively.pt(Math.round((bw - btn.getExtent().x) / 2), 152));
          box.addMorph(btn);
          box.eventsAreIgnored = false;       // the button inside needs the click; the box itself has no handler
        }
        this.root.addMorph(box);
        box.setPosition(lively.pt(RAIL_W + Math.round((aw - bw) / 2), HEADER_H + TOOLBAR_H + Math.max(24, Math.round((ah - 220) / 2) - 30)));
        this.msgBox = box;
        return true;
      },

      // ─── layout ──────────────────────────────────────────────────────────

      layout: function (w, h) {
        this.w = w; this.h = h;
        var th = this.th, UI = lively.gaming.GamingUI;
        this.titleLabel.setPosition(lively.pt(PAD, 12));
        this.countLabel.setPosition(lively.pt(PAD, 44));
        this.themeSwitch.setPosition(lively.pt(w - PAD - this.themeSwitch.getExtent().x, 16));
        this.railBox.setPosition(lively.pt(0, HEADER_H));
        this.railBox.setExtent(lively.pt(RAIL_W, h - HEADER_H));
        this.railLine.setPosition(lively.pt(RAIL_W - 1, HEADER_H));
        this.railLine.setExtent(lively.pt(1, h - HEADER_H));
        this.toolBox.setPosition(lively.pt(RAIL_W, HEADER_H));
        this.toolBox.setExtent(lively.pt(w - RAIL_W, TOOLBAR_H));
        this.scroll.setPosition(lively.pt(RAIL_W, HEADER_H + TOOLBAR_H));
        this.scroll.setExtent(lively.pt(w - RAIL_W, h - HEADER_H - TOOLBAR_H));
        this._buildToolbarButtons();
        this._relayoutTiles();
        this._updateSpacer();
        this._showEmptyState();
        this._syncTiles(true);
      },

      // Grid geometry for the current mode and width.
      _geom: function () {
        var areaW = this.w - RAIL_W;
        if (this.filter.mode === "list") {
          return { cols: 1, tw: areaW - PAD * 2 - 12, th: ROW_H, stepX: 0, stepY: ROW_H + ROW_GAP };
        }
        var cols = Math.max(1, Math.floor((areaW - PAD * 2 - 12 + GAP) / (TILE_W + GAP)));
        return { cols: cols, tw: TILE_W, th: TILE_H, stepX: TILE_W + GAP, stepY: TILE_H + GAP };
      },

      _updateSpacer: function () {
        var g = this._geom();
        this.cols = g.cols;
        var rows = Math.ceil(this.items.length / g.cols);
        // + 96 below the last row: the world's presence panel floats over the bottom-right
        // corner, and the last row has to be able to scroll clear of it.
        this.spacer.setExtent(lively.pt(4, rows ? rows * g.stepY + PAD + 96 : 4));
      },

      // ─── the tile pool ───────────────────────────────────────────────────

      // Builds one pool tile (a container and its children). Children are built at
      // (0, 0) and positioned by _layoutTile: a Text built at rect(x, y) and later moved
      // is offset twice.
      _makeTile: function () {
        var UI = lively.gaming.GamingUI, th = this.th, self = this;
        var tile = UI.box(lively.rect(0, 0, TILE_W, TILE_H), th.surface, { radius: 12, border: th.line });
        var c = {};
        c.cover = UI.box(lively.rect(0, 0, 10, 10), th.surface2, { clip: true }); c.cover.eventsAreIgnored = true;
        c.initial = UI.label(lively.rect(0, 0, 10, 10), "", { px: 56, font: "display", color: Color.rgba(255, 255, 255, 0.85), align: "center" });
        c.img = new lively.morphic.Image(lively.rect(0, 0, 10, 10), "");
        UI.noDrag(c.img); c.img.eventsAreIgnored = true;
        c.title = UI.label(lively.rect(0, 0, 10, 10), "", { px: 13, bold: true, wrap: true, color: th.text });
        c.status = UI.statusPill(0, 0, "backlog");
        c.stars = UI.label(lively.rect(0, 0, 10, 10), "", { px: 14, color: th.star });
        c.meta = UI.label(lively.rect(0, 0, 10, 10), "", { px: 11, weight: 500, color: th.muted, align: "right" });
        c.sub = UI.label(lively.rect(0, 0, 10, 10), "", { px: 12, color: th.muted });
        c.vis = new lively.morphic.Text(lively.rect(0, 0, 28, 28), "lock");
        c.vis.applyStyle({
          fontFamily: "'Material Symbols Rounded'", fontSize: 16 * 0.75, textColor: Color.white, fill: Color.rgba(0, 0, 0, 0.55),
          borderWidth: 0, borderColor: null, borderRadius: 14, align: "center", allowInput: false, selectable: false,
          clipMode: "hidden", whiteSpaceHandling: "pre", fixedWidth: true, fixedHeight: true,
        });
        UI.noDrag(c.vis); c.vis.eventsAreIgnored = true; c.vis.renderContext().shapeNode.style.pointerEvents = "none";
        tile.addMorph(c.cover); tile.addMorph(c.img); tile.addMorph(c.initial);
        tile.addMorph(c.title); tile.addMorph(c.status); tile.addMorph(c.stars); tile.addMorph(c.meta); tile.addMorph(c.sub); tile.addMorph(c.vis);
        tile.__c = c; tile.__idx = null;
        // a cover that fails to load falls back to the placeholder
        var imgEl = c.img.renderContext().shapeNode.querySelector("img");
        if (imgEl) {
          imgEl.addEventListener("error", function () { c.img.setVisible(false); c.initial.setVisible(true); });
          imgEl.addEventListener("load", function () { if (imgEl.naturalWidth) { c.img.setVisible(true); c.initial.setVisible(false); } });
        }
        tile.onMouseUp = function (evt) {
          var entry = tile.__entry;
          if (!entry) return false;
          evt.stop();
          if (self.host.isOwner() && c.vis.isVisible() && self._pointInChild(tile, c.vis, evt)) self.host.openVisibility(entry);
          else self.host.openDetail(entry);
          return true;
        };
        UI.makeInteractive(tile, { role: "button", label: "Game", onActivate: function () { if (tile.__entry) self.host.openDetail(tile.__entry); } });
        this._wireTileKeys(tile);
        this.scroll.addMorph(tile);
        return tile;
      },

      // Is the event's point inside `child` (a submorph of tile)? Uses the real nodes, so it
      // stays right however the page has scrolled.
      _pointInChild: function (tile, child, evt) {
        var r = child.renderContext().shapeNode.getBoundingClientRect();
        var p = evt.getPosition();
        var x = p.x - (window.pageXOffset || 0), y = p.y - (window.pageYOffset || 0);
        return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
      },

      // Arrow keys move between tiles (the grid is only keyboard-reachable by Tab otherwise).
      // The target may not be realised yet, so scroll it into view first, sync, then focus.
      _wireTileKeys: function (tile) {
        var self = this, mnode = tile.renderContext().morphNode;
        mnode.addEventListener("keydown", function (e) {
          if (e.target !== mnode || tile.__idx == null) return;
          var d = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: self.cols, ArrowUp: -self.cols }[e.key];
          if (d === undefined) return;
          e.preventDefault(); e.stopPropagation();
          self.focusIndex(Math.max(0, Math.min(self.items.length - 1, tile.__idx + d)));
        });
      },

      focusIndex: function (i) {
        var g = this._geom(), node = this.scroll.renderContext().shapeNode;
        var top = Math.floor(i / g.cols) * g.stepY + PAD / 2, bottom = top + g.th;
        if (top < node.scrollTop) node.scrollTop = Math.max(0, top - PAD);
        else if (bottom > node.scrollTop + node.clientHeight) node.scrollTop = bottom - node.clientHeight + PAD;
        this._syncTiles(true);
        var t = this.pool.filter(function (p) { return p.__idx === i; })[0];
        if (t) t.renderContext().morphNode.focus();
      },

      // Positions a tile's children for the current mode and width. Done for every pooled tile when
      // the mode or width changes, not on every recycle.
      _layoutTile: function (tile) {
        var g = this._geom(), c = tile.__c, UI = lively.gaming.GamingUI;
        tile.setExtent(lively.pt(g.tw, g.th));
        var set = function (m, x, y, w, h) { m.setPosition(lively.pt(x, y)); m.setExtent(lively.pt(w, h)); };
        if (this.filter.mode === "list") {
          var W = g.tw;
          set(c.cover, 8, 6, 40, 52); set(c.img, 8, 6, 40, 52); set(c.initial, 8, 14, 40, 30);
          c.initial.applyStyle({ fontSize: 20 * 0.75 });
          set(c.title, 60, 8, Math.max(120, W - 60 - 470), 22);
          set(c.sub, 60, 34, Math.max(120, W - 60 - 470), 20);
          set(c.status, W - 440, 22, c.status.getExtent().x, 19);
          set(c.stars, W - 350, 20, 90, 22);
          set(c.meta, W - 250, 22, 190, 20);
          set(c.vis, W - 44, 18, 28, 28);
        } else {
          set(c.cover, 0, 0, g.tw - 2, 232); set(c.img, 0, 0, g.tw - 2, 232); set(c.initial, 0, 84, g.tw - 2, 70);
          c.initial.applyStyle({ fontSize: 56 * 0.75 });
          set(c.title, 10, 240, g.tw - 20, 38);
          set(c.sub, 10, 0, 10, 10); c.sub.setVisible(false);
          set(c.status, 10, 284, c.status.getExtent().x, 19);
          set(c.stars, 8, 308, 90, 22);
          set(c.meta, g.tw - 8 - 92, 310, 90, 20);
          set(c.vis, g.tw - 2 - 36, 8, 28, 28);
        }
        c.sub.setVisible(this.filter.mode === "list");
      },

      _relayoutTiles: function () {
        var self = this;
        this.pool.forEach(function (t) { self._layoutTile(t); t.__idx = null; });
      },

      // Fills a pool tile from an entry: every visible fact on it. This is the one place a
      // tile's content is decided.
      _fillTile: function (tile, entry, idx) {
        var UI = lively.gaming.GamingUI, th = this.th, c = tile.__c, p = entry.payload, g = this._geom();
        tile.__entry = entry; tile.__idx = idx;
        // Cut by measured width, with an ellipsis: a grid title gets two lines, a list title one.
        var list = this.filter.mode === "list";
        var titleW = (list ? Math.max(120, g.tw - 60 - 470) : g.tw - 20) - 10;
        c.title.setTextString(list ? UI.fit(p.title, 13, 700, titleW) : UI.fitLines(p.title, 13, 700, titleW, 2));
        // status chip: text, fill, colour and width all change with the status
        var s = th.status[p.status] || th.status.backlog;
        c.status.setTextString(UI.STATUS_LABEL[p.status] || p.status);
        c.status.setExtent(lively.pt(UI.STATUS_W[p.status] || 68, UI.PILL_H));
        c.status.applyStyle({ fill: s.bg, textColor: s.fg });
        c.stars.setTextString(UI.starsText(p.rating));
        c.meta.setTextString(metaText(entry));
        var subText = [p.genre, p.year].filter(Boolean).join(" · ");
        c.sub.setTextString(UI.fit(subText, 12, 400, Math.max(120, g.tw - 60 - 470) - 10));
        // List mode: a title with nothing under it sits in the middle of the row, not at the top.
        if (list) c.title.setPosition(lively.pt(60, subText ? 8 : 20));
        // cover: the real art when there is a url, else a stable gradient with the initial
        var colors = UI.coverColors(p.title);
        c.cover.applyStyle({ fill: UI.gradient(colors.a, colors.b) });
        c.initial.setTextString((String(p.title || "?").trim().charAt(0) || "?").toUpperCase());
        if (p.cover_url) {
          if (c.img.getImageURL() !== p.cover_url) c.img.setImageURL(p.cover_url);
          c.img.setVisible(true); c.initial.setVisible(false);
        } else { c.img.setVisible(false); c.initial.setVisible(true); }
        // visibility badge (owner only: a visitor only ever sees public entries)
        var owner = this.host.isOwner();
        c.vis.setVisible(owner);
        if (owner) c.vis.setTextString(VIS_ICON[entry.visibility] || "lock");
        UI.setLabel(tile, p.title + ", " + (UI.STATUS_LABEL[p.status] || p.status) + (owner ? ", " + (VIS_LABEL[entry.visibility] || "") : ""));
        // the grid places a tile by its index
        tile.setPosition(lively.pt(PAD + (idx % g.cols) * g.stepX, PAD / 2 + Math.floor(idx / g.cols) * g.stepY));
      },

      // Makes the pool show exactly the rows in view (+ buffer). `force` refills tiles whose
      // entry may have changed (after a refresh); a plain scroll only fills tiles whose
      // slot moved to a game they were not already showing.
      _syncTiles: function (force) {
        if (!this.scroll || !this.w) return;
        var g = this._geom(), node = this.scroll.renderContext().shapeNode;
        var viewH = Math.max(node.clientHeight, this.h - HEADER_H - TOOLBAR_H, 200);
        var firstRow = Math.max(0, Math.floor(node.scrollTop / g.stepY) - BUFFER_ROWS);
        var rowsVis = Math.ceil(viewH / g.stepY) + 1 + BUFFER_ROWS * 2;
        var need = Math.min(this.items.length - firstRow * g.cols, rowsVis * g.cols);
        while (this.pool.length < need) { var t = this._makeTile(); this.pool.push(t); this._layoutTile(t); }
        var want = [];
        for (var i = firstRow * g.cols; i < firstRow * g.cols + rowsVis * g.cols && i < this.items.length; i++) want.push(i);
        var wantSet = {};
        want.forEach(function (i) { wantSet[i] = true; });
        var showing = {};
        this.pool.forEach(function (t) { if (t.__idx != null && wantSet[t.__idx] && !force) showing[t.__idx] = t; });
        var free = this.pool.filter(function (t) { return !(t.__idx != null && wantSet[t.__idx] && !force); });
        var self = this;
        want.forEach(function (i) {
          if (showing[i]) return;
          var t = free.pop();
          if (t) self._fillTile(t, self.items[i], i);
        });
        // anything left over is parked off-screen
        free.forEach(function (t) { t.__idx = null; t.__entry = null; t.setPosition(lively.pt(-9999, -9999)); });
      },

      // Called by the host after one entry changed (a save): redraws it where it is.
      // The list is re-derived (the change may move it under another filter or sort).
      entryChanged: function () { this.refresh(); },

      // Releases timers. The host calls this before it rebuilds or goes away.
      dispose: function () {
        clearTimeout(this._searchTimer);
      },
    });

    lively.gaming.LibraryView.METRICS = { HEADER_H: HEADER_H, RAIL_W: RAIL_W, TOOLBAR_H: TOOLBAR_H, PAD: PAD };
  }); // end module('lively.gaming.LibraryView')
