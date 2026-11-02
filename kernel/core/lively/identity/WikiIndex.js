/**
 * lively.identity.WikiIndex
 *
 * Boots as a full standalone Lively world at /c/:name/wiki — every wiki
 * page in a constellation, laid out as a grid of real morphs (search field,
 * "+ New wiki page" button, one card per page), rather than the plain
 * server-rendered <ul> the route used to fall back to for an HTML request.
 * Same two-mode shape as ConstellationLounge/ConstellationCanvas: a static
 * skeleton for fast first paint (buildWikiIndexPage, IdentityServer.js),
 * then this controller takes over once $world exists.
 *
 * Every visible element is a real morph added via $world.addMorph/
 * box.addMorph — same rationale as ConstellationLounge.js's file header
 * (halo-select/Object-Editor inspectability, and avoiding the raw-DOM
 * focus-stealing/z-order bugs that file documents from its own first pass).
 * The search field reuses ConstellationLounge.js's exact technique (a
 * lively.morphic.Text with beInputLine(), not a native <input>) rather than
 * re-deriving the native-input-in-a-morph gotchas CLAUDE.md documents.
 *
 * Clicking a page card opens it via lively.identity.WikiView.open(handle,
 * objId) with no target, which centers it standalone in $world — the same
 * entry point ConstellationLounge.js's own wiki panel uses (just without a
 * target/bounds override), so the page reuses that class's fetch/render/
 * verify logic outright instead of duplicating it here.
 *
 * Open: lively.identity.WikiIndex.open(name) — called from
 * buildWikiIndexPage's onStartWorld hook once $world exists.
 */

module("lively.identity.WikiIndex")
  .requires(
    "lively.identity.DID",
    "lively.identity.WikiView",
    "lively.identity.WikiEditor",
    "lively.identity.NewWikiPageDialog",
    "lively.morphic.Complete",
  )
  .toRun(function () {

    var TOP = 64;              // top margin below the menu bar
    var SIDE_MARGIN = 40;
    var BACK_BTN_LIFT = 10;   // how far the back pill sits above the header row's TOP
    // Header block height: the back pill (34px, top-aligned with the search
    // row) plus the title beneath it. 52 -> 62 along with the title's y
    // moving 28 -> 38 below, so the grid keeps its gap when the back link
    // became a 34px pill instead of a ~25px text label.
    var HEADER_H = 62;
    var GRID_TOP_GAP = 24;     // gap between the header row and the card grid
    var HEADER_ROW_H = 34;      // height of the back-row's sort-by/new-page controls
    // The centered, full-content wiki search bar (replaces the old
    // top-right title-only filter box) — sits on its own row, between the
    // header row and the card grid, see _layout/_buildContentSearchBar.
    var SEARCH_BAR_W = 520, SEARCH_BAR_H = 44;
    // Narrowest the bar is allowed to shrink to, and the width below which
    // "+ New wiki page" collapses to a "+" circle to give it room back.
    var SEARCH_BAR_MIN_W = 240, SEARCH_BAR_COMPACT_BELOW = 360;
    var SEARCH_DEBOUNCE_MS = 250;
    var RESULT_ROW_H = 58;      // one search-result dropdown row
    var RESULTS_MAX = 8;
    // NEW_BTN_W is only the pre-measurement fallback: the "+ New wiki page"
    // pill's real width is measured from its label (_buildPill) and stored
    // in this._newBtnW, which _layout reads.
    var NEW_BTN_W = 150, NEW_BTN_H = 34;
    // Pill fills (same values as ConstellationLounge.js's "+ Postcard" pink
    // and its blue "Wiki" pill) and their hover shades.
    var PILL_PINK = Color.rgb(232, 73, 126), PILL_PINK_HOVER = Color.rgb(212, 56, 108);
    var PILL_BLUE = Color.rgb(37, 99, 235),  PILL_BLUE_HOVER = Color.rgb(29, 78, 216);
    var SORT_W = 150, SORT_H = HEADER_ROW_H;   // same row/height as the header controls
    var SORT_GAP = 10;          // gap between the sort-by button and the "+ New wiki page" pill
    var SORT_ITEM_H = 30;
    var SORT_OPTIONS = [
      { key: "modified", label: "last modified" },
      { key: "created",  label: "last created" },
      { key: "alpha",    label: "alphabetical" },
    ];
    var CARD_W = 260, CARD_H = 96; // CARD_H is a floor — _fitCard grows a card taller if its title wraps
    var GRID_GAP = 16;
    var SIDEBAR_W = 260;       // reserved gutter to the left of the wiki view for a future sidebar panel
    var SIDEBAR_GAP = 24;      // gap between that gutter and the wiki view
    var SIDEBAR_PAD = 12;      // left/top inset for the home button + search row
    var SIDEBAR_TOOLROW_H = 28; // shared height of the home button and search field
    var SIDEBAR_HEADER_TOP = SIDEBAR_PAD + SIDEBAR_TOOLROW_H + 10; // "ON THIS PAGE" label y
    var SIDEBAR_ITEMS_TOP = SIDEBAR_HEADER_TOP + 26;               // first outline item y

    // Reserved gutter to the right of the wiki view — categories/tags
    // browse panel, always visible (unlike SIDEBAR_W's left gutter, which
    // only shows once a page is open). Same fixed order as
    // NewWikiPageDialog.js's own CATEGORIES list (duplicated here rather
    // than imported — that list is a closure-local var in a BuildSpec
    // module, not something exported for another file to depend on) so
    // categories appear in a stable, expected order instead of whatever
    // order pages happen to be fetched in.
    var CATEGORY_ORDER = ["Biography", "Place", "Event", "Concept", "Organization", "How-To"];
    var RIGHT_PANEL_W = 260;
    var RIGHT_PANEL_GAP = 24;
    // Pinned side panels (see _pinPanels): once the page scrolls under this
    // viewport y they hold here, clear of the menu bar.
    var PANEL_STICKY_TOP = 48;
    var PAGE_BOTTOM_MARGIN = 48; // world background kept below the open page
    // Narrowest the open page may get beside the two panels; below it the
    // panels hide and the page takes the full width (_panelsFit).
    var PAGE_MIN_W = 600;

    // A plain Box/Text defaults to draggable, droppable AND grabbable
    // (CLAUDE.md), and drag-start is decided by the morph actually under
    // the cursor — so every morph in a panel needs all three off, not just
    // its container. Applies to a morph and everything inside it.
    function noDragTree(m) {
      m.draggingEnabled = false;
      m.droppingEnabled = false;
      m.grabbingEnabled = false;
      (m.submorphs || []).forEach(noDragTree);
    }
    var PANEL_PAD = 14;
    var PANEL_HEADER_TOP = 14;
    var PANEL_ITEMS_TOP = PANEL_HEADER_TOP + 26;
    var CATEGORY_LABEL_H = 20;
    var CATEGORY_BLOCK_GAP = 16;   // vertical gap after a category's tag pills, before the next category
    var PILL_H = 24;
    var PILL_PAD_X = 10;
    var PILL_GAP_X = 6;
    var PILL_GAP_Y = 8;

    Object.subclass("lively.identity.WikiIndexController",

    "initializing", {
      initialize: function () {
        // scope: { kind: 'constellation', name } | { kind: 'personal', handle }
        // — everything below that used to assume a constellation name
        // branches on scope.kind instead. See open()/openPersonal() below.
        this._scope = null;
        this._pages = [];
        this._pagesFiltered = [];
        this._canWrite = false;
        this._searchBar = null;
        this._searchDropdown = null;
        this._searchDebounceTimer = null;
        this._searchRequestId = 0;
        this._quickInfo = null;
        this._cardMorphs = [];
        this._didHandleCache = {};
        this._activeContentMorph = null; // a read-only WikiView or an editable WikiEditor
        this._sidebarBox = null;
        this._sidebarMode = "list"; // "outline" (current page's headings) | "list" (all wiki pages); starts as the page list, shown with no page open
        this._sidebarOutline = [];     // cached getOutline() result for the active page
        this._sidebarListQuery = "";
        this._sortBy = "modified";     // "modified" | "created" | "alpha" — see SORT_OPTIONS
        this._sortByDropdown = null;
        this._categoriesPanel = null;
        this._categoryFilter = null;   // selected category string, or null
        this._tagFilter = null;        // selected tag string (only meaningful alongside _categoryFilter), or null
      },
    },

    // ─── boot ─────────────────────────────────────────────────────────────────

    "boot", {
      // Back-compat entry point — every existing caller (buildWikiIndexPage's
      // onStartWorld hook, ConstellationLounge.js's "Open wiki" link target)
      // passes a bare constellation name string.
      open: function (name) {
        this._openScope({ kind: "constellation", name: name });
      },

      openPersonal: function (handle) {
        this._openScope({ kind: "personal", handle: handle });
      },

      // What to SHOW for this wiki's owner, and what to build page links from:
      // a verified domain handle when the owner has one (/@tinylil.world/wiki
      // rather than /@tinasnow/wiki), else the registered handle / constellation
      // name. Data requests keep using the real handle/name; the domain URL is
      // only an alias for them server-side.
      _shownHandle: function () {
        return this._scope.displayHandle || this._scope.handle;
      },
      _shownName: function () {
        return (this._quickInfo && this._quickInfo.domain) || this._scope.name;
      },

      _openScope: function (scope) {
        this._scope = scope;
        if (scope.kind === "personal") return this._startPersonal();
        this._loadSpaceToken();
      },

      // Constellation scope: canWrite/quickInfo come from a space-token
      // round trip (membership isn't known client-side).
      _loadSpaceToken: function () {
        var self = this;
        var name = this._scope.name;
        var base = lively.identity.did.baseUrl();
        var xhr = new XMLHttpRequest();
        xhr.open("GET", base + "/c/" + encodeURIComponent(name) + "/space-token", true);
        xhr.withCredentials = true;
        xhr.setRequestHeader("Accept", "application/json");
        xhr.onload = function () {
          if (xhr.status !== 200) return self._showError("Failed to load c/" + name + " (" + xhr.status + ")");
          var data;
          try { data = JSON.parse(xhr.responseText); } catch (e) { return self._showError("Bad space-token response"); }
          self._canWrite = !!data.canWrite;
          self._quickInfo = data.quickInfo || {};
          self._fetchWikiIndex();
        };
        xhr.onerror = function () { self._showError("Network error loading c/" + name); };
        xhr.send();
      },

      // Personal scope: canWrite is just "is this session's own handle" —
      // no membership concept, no round trip needed (confirmed server-side:
      // GET /@:handle/wiki and the wikipage PUT owner check both key off
      // the session did directly).
      _startPersonal: function () {
        var user = lively.identity.did.currentUser();
        this._canWrite = !!(user && lively.identity.did.isOwnHandle(this._scope.handle));
        this._quickInfo = {};
        // Look up the owner's verified domain (if any) before building the
        // page, so the header shows it from the first render. Best-effort:
        // on any failure the registered handle is shown.
        var self = this;
        var scope = this._scope;
        fetch("/@" + encodeURIComponent(scope.handle) + "/domains", { credentials: "include" })
          .then(function (r) { return r.ok ? r.json() : { domains: [] }; })
          .then(function (b) {
            var v = (b.domains || []).filter(function (d) { return d.status === "verified"; })[0];
            scope.displayHandle = v ? String(v.domain).toLowerCase() : null;
          })
          .catch(function () {})
          .then(function () { self._fetchWikiIndex(); });
      },

      _fetchWikiIndex: function () {
        var self = this;
        var base = lively.identity.did.baseUrl();
        var url = this._scope.kind === "personal"
          ? base + "/@" + encodeURIComponent(this._scope.handle) + "/wiki"
          : base + "/c/" + encodeURIComponent(this._scope.name) + "/wiki";
        var xhr = new XMLHttpRequest();
        xhr.open("GET", url, true);
        xhr.withCredentials = true;
        xhr.setRequestHeader("Accept", "application/json");
        xhr.onload = function () {
          if (xhr.status !== 200) return self._showError("Failed to load wiki index (" + xhr.status + ")");
          var data;
          try { data = JSON.parse(xhr.responseText); } catch (e) { return self._showError("Bad wiki index response"); }
          self._pages = data.pages || [];
          self._start();
        };
        xhr.onerror = function () { self._showError("Network error loading wiki index"); };
        xhr.send();
      },

      _start: function () {
        document.title = this._scope.kind === "personal"
          ? "@" + this._shownHandle() + " wiki"
          : "c/" + this._shownName() + " wiki";
        this._buildChrome();
        this._installStacking();
        this._renderCategoriesPanel();
        this._renderPages();
        this._installMenuBarEntry();
        var self = this;
        window.addEventListener("resize", function () { self._layout(); });
        var pinQueued = false;
        window.addEventListener("scroll", function () {
          if (pinQueued) return;
          pinQueued = true;
          requestAnimationFrame(function () { pinQueued = false; self._pinPanels(); });
        }, { passive: true });
        // "?new=1" is how other worlds (WorldsBrowser's "Wiki page" card) hand
        // off page creation to this route instead of opening a wiki editor
        // inside their own world. Consumed once so a reload doesn't re-prompt.
        if (this._canWrite && /(^|[?&])new=1(&|$)/.test(window.location.search)) {
          try {
            var clean = window.location.search.replace(/([?&])new=1(&|$)/, function (m, pre, post) { return post ? pre : ""; });
            window.history.replaceState(null, "", window.location.pathname + clean + window.location.hash);
          } catch (e) {}
          this._promptNewWikiPage();
        }
      },
    },

    // ─── chrome ─────────────────────────────────────────────────────────────────

    "chrome", {
      _buildChrome: function () {
        var loader = document.getElementById("wiki-index-loader");
        if (loader) loader.remove();
        var staticEl = document.getElementById("wiki-index-static");
        if (staticEl) staticEl.remove();

        this._backBtn = this._buildBackButton();
        $world.addMorph(this._backBtn);

        var titleText = this._scope.kind === "personal"
          ? "@" + this._shownHandle() + " wiki"
          : "c/" + this._shownName() + " wiki";
        this._titleLabel = lively.morphic.Text.makeLabel(titleText, {
          fontSize: 22, fontWeight: "bold", textColor: Color.rgb(20, 20, 20),
        });
        $world.addMorph(this._titleLabel);

        this._sortByBox = this._buildSortByButton();
        $world.addMorph(this._sortByBox);

        this._searchBar = this._buildContentSearchBar();
        $world.addMorph(this._searchBar);

        var self = this;
        // Blue counterpart of ConstellationLounge.js's pink "+ Postcard".
        this._newBtn = this._buildPill("+ New wiki page", {
          fill: PILL_BLUE, hover: PILL_BLUE_HOVER,
          onClick: function () { self._promptNewWikiPage(); },
        });
        this._newBtnW = this._newBtn.getExtent().x;
        $world.addMorph(this._newBtn);
        this._newBtn.setVisible(this._canWrite);

        // Bare "+" circle swapped in by _layout when the header gets too
        // tight for the full pill (ConstellationLounge.js does the same
        // for "+ Postcard"). Its own pill so the label/click handling is
        // the exact same code path; padX 11.5 makes ~11px of "+" glyph
        // come out to the pill's 34px height, i.e. a circle.
        this._newBtnCompact = this._buildPill("+", {
          fill: PILL_BLUE, hover: PILL_BLUE_HOVER, padX: 11.5,
          tooltip: "New wiki page",
          onClick: function () { self._promptNewWikiPage(); },
        });
        this._newBtnCompactW = this._newBtnCompact.getExtent().x;
        $world.addMorph(this._newBtnCompact);
        this._newBtnCompact.setVisible(false);

        this._gridBox = new lively.morphic.Box(lively.rect(0, 0, 10, 10));
        this._gridBox.applyStyle({ fill: null, borderWidth: 0 });
        $world.addMorph(this._gridBox);

        // Reserved gutter to the left of the wiki view (see SIDEBAR_W) —
        // built hidden and only shown once a page is actually open
        // (_setActiveContentMorph), same as before; it now defaults to
        // that page's outline but its home button switches it to a
        // filtered list of every wiki page without leaving the open page.
        this._sidebarBox = this._buildSidebar();
        $world.addMorph(this._sidebarBox);
        this._sidebarBox.enableFixedPositioning(); // pinned while the page scrolls, see _pinPanels
        this._sidebarBox.setVisible(false);

        // Right-hand categories/tags browse panel — unlike _sidebarBox,
        // visible from the start (it's a way to find a page, not a
        // per-open-page outline), see _renderCategoriesPanel.
        this._categoriesPanel = this._buildCategoriesPanel();
        $world.addMorph(this._categoriesPanel);
        this._categoriesPanel.enableFixedPositioning();

        this._layout();
      },

      // A hardcoded-width label here once wrapped onto a second line for
      // constellation names anywhere near that width, overlapping whatever
      // sits below it (confirmed live with "wikitest") — hence the width
      // below is measured from the actual label text.
      _buildBackButton: function () {
        var self = this;
        var isPersonal = this._scope.kind === "personal";
        var label = isPersonal ? "← @" + this._shownHandle() : "← c/" + this._shownName();
        var href = isPersonal
          ? "/@" + encodeURIComponent(this._shownHandle())
          : "/c/" + encodeURIComponent(this._shownName());
        // Pink pill, same look as ConstellationLounge.js's "+ Postcard". It
        // replaces a bare makeLabel link whose click never fired — makeLabel
        // -> beLabel() calls ignoreEvents() unconditionally, and Events.js
        // drops every mouse event on an ignored morph before its handler
        // runs (eventsAreIgnored was true, cursor "default").
        return this._buildPill(label, {
          fill: PILL_PINK, hover: PILL_PINK_HOVER, padX: 14,
          tooltip: isPersonal ? "Back to your homestar" : "Back to c/" + this._scope.name,
          onClick: function () { window.location.href = href; },
        });
      },

      // A "+ Postcard"-style pill (ConstellationLounge.js's
      // _buildCreatePostcardButton): a plain Box with a fully rounded end
      // holding a white bold 14pt label. opts: { fill, hover, padX, tooltip,
      // onClick }. The Box takes the clicks — its label child stays
      // eventsAreIgnored on purpose so a click resolves to the pill, not the
      // text. Returns the Box; read its width with getExtent().x.
      _buildPill: function (labelText, opts) {
        var H = 34, LINE_H = 20, LABEL_H = 25;
        var padX = opts.padX !== undefined ? opts.padX : 12;
        // Width comes from a canvas text measurement in the label's own font
        // (bold 14pt = 18.67px Helvetica), not from a rendered span — the
        // label isn't in the DOM yet, and same-tick DOM reads race layout
        // (CLAUDE.md). Label text varies (constellation name), so this
        // can't be a hardcoded width.
        var ctx = document.createElement("canvas").getContext("2d");
        ctx.font = "700 18.6667px Helvetica";
        var textW = ctx.measureText(labelText).width;
        var pillW = Math.ceil(textW + padX * 2);
        // Label slot >= text + the shapeNode's 8px padding or it wraps; the
        // label is centered within it (align:'center'). LABEL_H is the box's
        // *total* height — under ~25 it clips descenders (the "p" in a name);
        // -2.35 cancels the shapeNode's own vertical padding so the text
        // sits centered in the pill (both measured live on the
        // constellation quick-info pills, same font/size).
        var slotW = Math.ceil(textW + 8.5);

        var btn = new lively.morphic.Box(lively.rect(0, 0, pillW, H));
        btn.setFill(opts.fill);
        btn.applyStyle({ borderWidth: 0, borderRadius: H / 2, handStyle: "pointer" });
        btn.disableDragging();
        btn.disableGrabbing();
        btn.droppingEnabled = false;
        if (opts.tooltip) btn.toolTip = opts.tooltip;

        var text = lively.morphic.Text.makeLabel(labelText, {
          fontSize: 14, fontWeight: "700", textColor: Color.rgb(255, 255, 255),
          align: "center", fixedWidth: true, fixedHeight: true,
        });
        text.setExtent(lively.pt(slotW, LABEL_H));
        text.setPosition(lively.pt((pillW - slotW) / 2, (H - LINE_H) / 2 - 2.35));
        text.applyStyle({ borderWidth: 0 });
        text.disableDragging();
        text.disableGrabbing();
        text.eventsAreIgnored = true;
        btn.addMorph(text);

        btn.onMouseOver = function () { btn.setFill(opts.hover); };
        btn.onMouseOut  = function () { btn.setFill(opts.fill); };
        // Acts on mouse-up (not down) so a press that slides off the button
        // can be abandoned.
        btn.onMouseUp = function (evt) {
          opts.onClick();
          evt.stop();
          return true;
        };
        return btn;
      },

      // The centered, full-content wiki search bar — searches every wiki
      // page's actual body text (not just wikiName/title, unlike the old
      // top-right box this replaces) via GET .../wiki/search, and shows
      // live results in a dropdown as the user types (see
      // _queueContentSearch/_runContentSearch/_renderSearchResults below).
      _buildContentSearchBar: function () {
        var self = this;
        var box = new lively.morphic.Box(lively.rect(0, 0, SEARCH_BAR_W, SEARCH_BAR_H));
        box.setFill(Color.white);
        box.applyStyle({ borderWidth: 1.5, borderColor: Color.rgb(236, 64, 122), borderRadius: SEARCH_BAR_H / 2 });

        // Vertically centered by position, not by spanning the full bar
        // height with align:'center' — that only centers horizontally
        // (CLAUDE.md's Text-centering notes; confirmed live here too, the
        // full-height box rendered the glyph pinned near the top with a
        // large gap below, not centered). 20 is the glyph's own designed
        // render size at fontSize 15pt (fontSize * 4/3, same icon-sizing
        // rule CLAUDE.md documents), so a 20-tall box positioned at
        // (SEARCH_BAR_H - 20) / 2 centers it.
        var ICON_SIZE = 23;
        var icon = lively.morphic.Text.makeLabel("search", {
          fontFamily: "'Material Symbols Rounded'", fontSize: 17,
          textColor: Color.rgb(236, 64, 122), fixedWidth: true, fixedHeight: true,
        });
        // -4: the formula's y lands the glyph 4px low relative to the bar's
        // true center — confirmed by comparing the rendered glyph span's
        // own getBoundingClientRect() against the bar's, same live-measure-
        // and-correct idiom CLAUDE.md's Text-centering notes describe (the
        // box's own render padding isn't perfectly symmetric top/bottom).
        icon.setPosition(lively.pt(17, Math.round((SEARCH_BAR_H - ICON_SIZE) / 2) - 4));
        icon.setExtent(lively.pt(ICON_SIZE, ICON_SIZE));
        icon.applyStyle({ borderWidth: 0 });
        icon.eventsAreIgnored = true;
        box.addMorph(icon);

        var fieldRect = lively.rect(46, 8, SEARCH_BAR_W - 46 - 16, SEARCH_BAR_H - 16);
        this._searchBarW = SEARCH_BAR_W;

        var placeholder = lively.morphic.Text.makeLabel("Search this wiki…", {
          fontSize: 13, textColor: Color.rgb(170, 170, 170),
        });
        placeholder.setPosition(fieldRect.topLeft());
        placeholder.setExtent(fieldRect.extent());
        placeholder.eventsAreIgnored = true;
        box.addMorph(placeholder);
        this._searchPlaceholder = placeholder;

        var field = new lively.morphic.Text(fieldRect, "");
        field.applyStyle({ allowInput: true, fontSize: 13, fill: null, borderWidth: 0 });
        field.beInputLine();
        var superKeyDown = field.onKeyDown;
        field.onKeyDown = function (evt) {
          var result = superKeyDown.call(this, evt);
          // The keystroke that produced this event hasn't necessarily landed
          // in field.textString yet at this point (confirmed live on the
          // old field this replaces — reading it synchronously here always
          // lagged one character behind) — defer to the next tick.
          setTimeout(function () {
            var q = field.textString || "";
            self._searchPlaceholder.setVisible(!q);
            self._queueContentSearch(q);
          }, 0);
          return result;
        };
        box.addMorph(field);
        this._searchField = field;

        // A plain Box/Text defaults to draggable, droppable, AND grabbable
        // (CLAUDE.md) — without this, dragging inside the bar (e.g. to
        // select text, or just clicking and moving slightly) picks up and
        // moves the whole search bar instead. Every visible child needs
        // this individually, not just the container.
        [box, icon, placeholder, field].forEach(function (m) {
          m.draggingEnabled = false;
          m.droppingEnabled = false;
          m.grabbingEnabled = false;
        });

        return box;
      },

      // The bar is SEARCH_BAR_W wide unless _layout says the header row
      // is too tight, in which case it shrinks. Re-extents the bar's own
      // field/placeholder to match (fixed 46px icon gutter left, 16px
      // right). An open dropdown is closed rather than resized: its rows
      // were built at the old width.
      _setSearchBarWidth: function (w) {
        w = Math.round(w);
        if (w === this._searchBarW) return;
        this._searchBarW = w;
        this._closeSearchDropdown();
        this._searchBar.setExtent(lively.pt(w, SEARCH_BAR_H));
        var fieldExt = lively.pt(w - 46 - 16, SEARCH_BAR_H - 16);
        this._searchField.setExtent(fieldExt);
        this._searchPlaceholder.setExtent(fieldExt);
      },

      // Debounces keystrokes into one round trip per pause instead of
      // firing a request per character, and closes the dropdown outright
      // for an empty query rather than asking the server.
      _queueContentSearch: function (query) {
        var self = this;
        clearTimeout(this._searchDebounceTimer);
        var q = (query || "").trim();
        if (!q) {
          this._closeSearchDropdown();
          return;
        }
        this._searchDebounceTimer = setTimeout(function () {
          self._runContentSearch(q);
        }, SEARCH_DEBOUNCE_MS);
      },

      _runContentSearch: function (query) {
        var self = this;
        var base = lively.identity.did.baseUrl();
        var url = this._scope.kind === "personal"
          ? base + "/@" + encodeURIComponent(this._scope.handle) + "/wiki/search?q=" + encodeURIComponent(query)
          : base + "/c/" + encodeURIComponent(this._scope.name) + "/wiki/search?q=" + encodeURIComponent(query);
        var xhr = new XMLHttpRequest();
        xhr.open("GET", url, true);
        xhr.withCredentials = true;
        xhr.setRequestHeader("Accept", "application/json");
        // A slower-arriving earlier request must not clobber a
        // faster-arriving later one's results once the user has kept
        // typing past it — stamp and check the request that's actually
        // still current when the response comes back.
        var requestId = ++this._searchRequestId;
        xhr.onload = function () {
          if (requestId !== self._searchRequestId || xhr.status !== 200) return;
          var data;
          try { data = JSON.parse(xhr.responseText); } catch (e) { return; }
          self._renderSearchResults(data.results || [], query);
        };
        xhr.send();
      },

      _renderSearchResults: function (results, query) {
        this._closeSearchDropdown();
        var self = this;
        var rows = results.slice(0, RESULTS_MAX);
        var dropdown = new lively.morphic.Box(
          lively.rect(0, 0, this._searchBarW || SEARCH_BAR_W, rows.length ? rows.length * RESULT_ROW_H + 8 : 40),
        );
        dropdown.setFill(Color.white);
        dropdown.applyStyle({ borderWidth: 1.5, borderColor: Color.rgb(236, 64, 122), borderRadius: 10 });
        dropdown.draggingEnabled = false;
        dropdown.droppingEnabled = false;
        dropdown.grabbingEnabled = false;

        if (!rows.length) {
          var empty = lively.morphic.Text.makeLabel("No wiki pages match “" + query + "”.", {
            fontSize: 12, textColor: Color.gray,
          });
          empty.setPosition(lively.pt(16, 12));
          empty.eventsAreIgnored = true;
          empty.draggingEnabled = false;
          empty.droppingEnabled = false;
          empty.grabbingEnabled = false;
          dropdown.addMorph(empty);
        } else {
          rows.forEach(function (result, i) {
            var row = self._buildSearchResultRow(result, query, i === rows.length - 1);
            // x=8, matching the row's own reduced width below (see
            // _buildSearchResultRow) — a row flush against the dropdown's
            // own left/right edges paints its sharp white corners directly
            // over the dropdown's thin border along the straight run,
            // confirmed live via elementsFromPoint at the border pixel
            // (returned the row's own DOM node on top of the dropdown's).
            // Only the corner arcs (where no row reaches) survive uninset.
            row.setPosition(lively.pt(8, 4 + i * RESULT_ROW_H));
            dropdown.addMorph(row);
          });
        }

        $world.addMorph(dropdown);
        var barPos = this._searchBar.getPosition();
        dropdown.setPosition(lively.pt(barPos.x, barPos.y + SEARCH_BAR_H + 6));
        dropdown.bringToFront();
        // bringToFront only reorders within the world's own DOM node, but
        // the categories panel (and menu bar) are enableFixedPositioning()
        // morphs whose nodes live directly under <body>, painting above
        // everything in the world regardless of order — confirmed live at
        // a narrow window, where they covered the result rows' category
        // chips. An explicit z-index lets the dropdown win against them.
        dropdown.renderContext().shapeNode.style.zIndex = "1000";
        this._searchDropdown = dropdown;
      },

      _closeSearchDropdown: function () {
        if (!this._searchDropdown) return;
        this._searchDropdown.remove();
        this._searchDropdown = null;
      },

      // One row in the search-results dropdown: a bold title, a small
      // category chip, and a snippet with the matched term set off in a
      // bold accent color. Both the chip and the snippet's pre/match/post
      // runs are sized via canvas text measurement (same pre-DOM-insertion
      // technique _buildPill above uses to size a pill from its label)
      // rather than this file's usual "measure the live DOM" idiom —
      // there's nothing to hug-fit here, just runs that must sit
      // edge-to-edge with no gap/overlap, and canvas measurement doesn't
      // require the morph to already be in $world.
      _buildSearchResultRow: function (result, query, isLast) {
        var self = this;
        // 16px narrower than the dropdown (8px inset each side — see the
        // setPosition call at this row's use site in _renderSearchResults):
        // a row flush against the dropdown's own edges paints its sharp
        // white corners directly over the dropdown's thin border along the
        // straight run, hiding it everywhere except the corner arcs.
        var ROW_W = (this._searchBarW || SEARCH_BAR_W) - 16;
        var row = new lively.morphic.Box(lively.rect(0, 0, ROW_W, RESULT_ROW_H));
        row.setFill(Color.white);
        row.applyStyle({ borderWidth: 0 });
        if (!isLast) {
          row.renderContext().shapeNode.style.borderBottom = "1px solid " + Color.rgb(230, 230, 230).toString();
        }
        row.renderContext().shapeNode.style.cursor = "pointer";
        row.onMouseOver = function () { row.setFill(Color.rgb(247, 248, 250)); };
        row.onMouseOut = function () { row.setFill(Color.white); };
        row.onMouseDown = function () {
          self._closeSearchDropdown();
          self._openPage(result, { highlightQuery: query });
        };

        var chip = this._buildResultCategoryChip(result.category);
        chip.setPosition(lively.pt(ROW_W - 14 - chip.getExtent().x, 10));
        row.addMorph(chip);

        var titleAvailW = chip.getPosition().x - 14 - 14;
        var titleText = this._truncateToWidth(result.title || result.wikiName || "(untitled)", "700", 13, titleAvailW);
        var title = lively.morphic.Text.makeLabel(titleText, {
          fontSize: 13, fontWeight: "700", textColor: Color.rgb(30, 30, 30),
          fixedWidth: true, fixedHeight: true,
        });
        title.setPosition(lively.pt(14, 8));
        // 21, not 18: live-measured real rendered content height for this
        // fontSize/weight is 20px (CLAUDE.md's fontSize-is-points gotcha —
        // 13pt bold Helvetica renders taller than the naive 18px guess), so
        // 18 was clipping descenders (p/y/g/q) at the bottom of the row.
        title.setExtent(lively.pt(titleAvailW, 21));
        title.eventsAreIgnored = true;
        row.addMorph(title);

        // 20, not 18 — same descender-clipping gap as the title above,
        // confirmed live (measured run content height ~18.7px vs the old
        // 18px clip box).
        var snippetClip = new lively.morphic.Box(lively.rect(14, 32, ROW_W - 28, 20));
        snippetClip.applyStyle({ fill: null, borderWidth: 0, clipMode: "hidden" });
        snippetClip.eventsAreIgnored = true;
        row.addMorph(snippetClip);
        this._layoutSnippetRuns(snippetClip, result.snippet || "", query);

        [row, chip, title, snippetClip].forEach(function (m) {
          m.draggingEnabled = false;
          m.droppingEnabled = false;
          m.grabbingEnabled = false;
        });
        return row;
      },

      _buildResultCategoryChip: function (category) {
        var label = category || "General";
        var fontPx = 10 * 4 / 3; // fontSize is points, not px — CLAUDE.md
        var ctx = document.createElement("canvas").getContext("2d");
        ctx.font = "600 " + fontPx + "px Helvetica";
        var textW = Math.ceil(ctx.measureText(label).width);
        var H = 18, padX = 8;
        var chip = new lively.morphic.Box(lively.rect(0, 0, textW + padX * 2, H));
        chip.applyStyle({ fill: Color.rgb(235, 235, 240), borderWidth: 0, borderRadius: H / 2 });
        var text = lively.morphic.Text.makeLabel(label, {
          fontSize: 10, fontWeight: "600", textColor: Color.rgb(90, 90, 90),
          fixedWidth: true, fixedHeight: true,
        });
        text.setPosition(lively.pt(padX, 0));
        text.setExtent(lively.pt(textW + 4, H));
        text.applyStyle({ borderWidth: 0 });
        text.eventsAreIgnored = true;
        chip.addMorph(text);
        return chip;
      },

      // Trims `text` with a trailing "…" so it renders within availW at the
      // given fontSize (points, not px — CLAUDE.md; the canvas font string
      // below converts via *4/3) and weight, measured via canvas rather
      // than the live DOM (see _buildSearchResultRow's header comment).
      _truncateToWidth: function (text, weight, fontSize, availW) {
        var fontPx = fontSize * 4 / 3;
        var ctx = document.createElement("canvas").getContext("2d");
        ctx.font = weight + " " + fontPx + "px Helvetica";
        if (ctx.measureText(text).width <= availW) return text;
        var lo = 0, hi = text.length;
        while (lo < hi) {
          var mid = Math.ceil((lo + hi) / 2);
          if (ctx.measureText(text.slice(0, mid) + "…").width <= availW) lo = mid;
          else hi = mid - 1;
        }
        return text.slice(0, lo) + "…";
      },

      // Splits `snippet` into pre/match/post around the first
      // case-insensitive occurrence of `query` and lays the three out as
      // adjacent Text morphs (the match run bold + accent-colored) inside
      // `container`, which clips overflow — a snippet wider than the row
      // is simply cut off at its right edge rather than pre-truncated,
      // same as any other overflow-hidden text row.
      _layoutSnippetRuns: function (container, snippet, query) {
        var idx = query ? snippet.toLowerCase().indexOf(query.toLowerCase()) : -1;
        var fontPx = 12 * 4 / 3;
        var ctx = document.createElement("canvas").getContext("2d");
        var x = 0;

        function addRun(text, bold) {
          if (!text) return;
          ctx.font = (bold ? "700 " : "400 ") + fontPx + "px Helvetica";
          var w = Math.ceil(ctx.measureText(text).width);
          var run = lively.morphic.Text.makeLabel(text, {
            fontSize: 12, fontWeight: bold ? "700" : "400",
            textColor: bold ? Color.rgb(37, 99, 235) : Color.rgb(120, 120, 120),
            fixedWidth: true, fixedHeight: true, whiteSpaceHandling: "pre",
          });
          run.setPosition(lively.pt(x, 0));
          run.setExtent(lively.pt(w + 6, 20));
          run.applyStyle({ borderWidth: 0 });
          run.eventsAreIgnored = true;
          container.addMorph(run);
          x += w;
        }

        if (idx === -1) {
          addRun(snippet, false);
        } else {
          addRun(snippet.slice(0, idx), false);
          addRun(snippet.slice(idx, idx + query.length), true);
          addRun(snippet.slice(idx + query.length), false);
        }
      },

      // Sits immediately left of the "+ New wiki page" pill, same row/height
      // — shows the current sort selection and toggles _sortByDropdown (see
      // the "sort by" category below) on click. Same rounded-pill styling as
      // _buildContentSearchBar above rather than ConstellationLounge.js's
      // pink-accented placeholder version of this button, since this one
      // actually re-sorts the grid instead of just remembering a label.
      _buildSortByButton: function () {
        var self = this;
        var box = new lively.morphic.Box(lively.rect(0, 0, SORT_W, SORT_H));
        box.setFill(Color.white);
        box.applyStyle({ borderWidth: 1, borderColor: Color.rgb(200, 200, 200), borderRadius: 17 });

        var label = lively.morphic.Text.makeLabel(this._sortOptionLabel(), {
          fontSize: 12, textColor: Color.rgb(70, 70, 70), fixedWidth: true, fixedHeight: true,
        });
        label.setPosition(lively.pt(14, 0));
        label.setExtent(lively.pt(SORT_W - 36, SORT_H));
        label.applyStyle({ borderWidth: 0 });
        label.eventsAreIgnored = true;
        box.addMorph(label);
        this._sortByLabel = label;

        // fixedWidth/fixedHeight: true — required here, not decorative; see
        // ConstellationLounge.js's _buildSortByButton comment for why an
        // icon-font ligature label without them gets its box silently
        // blown out by Text's own deferred re-layout once it's in the world.
        var chevron = lively.morphic.Text.makeLabel("expand_more", {
          fontFamily: "'Material Symbols Rounded'", fontSize: 13.5, textColor: Color.rgb(120, 120, 120),
          fixedWidth: true, fixedHeight: true,
        });
        chevron.setPosition(lively.pt(SORT_W - 24, 0));
        chevron.setExtent(lively.pt(18, SORT_H));
        chevron.applyStyle({ borderWidth: 0 });
        chevron.eventsAreIgnored = true;
        box.addMorph(chevron);

        box.renderContext().shapeNode.style.cursor = "pointer";
        box.onMouseDown = function () { self._toggleSortByDropdown(); };

        return box;
      },

      // Left-hand sidebar panel — a "home" icon button + search field
      // pinned along its top edge (this method), and below that either the
      // current page's heading outline or a filtered list of every wiki
      // page (_renderSidebarOutline/_renderSidebarPageList, switched via
      // _sidebarMode). _repositionWikiView keeps the whole box pinned
      // alongside the open wiki view.
      _buildSidebar: function () {
        var box = new lively.morphic.Box(lively.rect(0, 0, SIDEBAR_W, 80));
        box.setFill(Color.white);
        box.applyStyle({ borderWidth: 1, borderColor: Color.rgb(230, 230, 230), borderRadius: 8 });

        var homeBtn = this._buildSidebarHomeButton();
        homeBtn.setPosition(lively.pt(SIDEBAR_PAD, SIDEBAR_PAD));
        box.addMorph(homeBtn);
        this._sidebarHomeBtn = homeBtn;

        var searchBox = this._buildSidebarSearchField();
        searchBox.setPosition(lively.pt(SIDEBAR_PAD + SIDEBAR_TOOLROW_H + 8, SIDEBAR_PAD));
        box.addMorph(searchBox);
        this._sidebarSearchBox = searchBox;

        var header = lively.morphic.Text.makeLabel("ON THIS PAGE", {
          fontSize: 11, fontWeight: "700", textColor: Color.rgb(150, 150, 150),
        });
        header.setPosition(lively.pt(16, SIDEBAR_HEADER_TOP));
        // The label hugs "ON THIS PAGE" at creation (112px) and doesn't
        // re-hug when its text is swapped, so the longer "ALL WIKI PAGES"
        // lost its last letter (confirmed live: span 117px in a 112px box).
        // Full sidebar width instead; 21 is the hugged height it already had.
        header.setExtent(lively.pt(SIDEBAR_W - 32, 21));
        header.eventsAreIgnored = true;
        box.addMorph(header);
        this._sidebarHeader = header;

        // Not a draggable part: it was picked up and moved by a plain
        // click-drag (confirmed live) — same three flags the categories
        // panel opposite already sets, on every child too.
        noDragTree(box);

        box._itemMorphs = [];
        return box;
      },

      // Small round icon button matching the Material-Symbols-glyph-as-Text
      // idiom (CLAUDE.md "Icons" section) — a single Text morph, ligature
      // name as its content, centered by fixed rect + align:center rather
      // than measure-and-position (fine here since the glyph is always the
      // same single "home" character, unlike the variable-length labels
      // CLAUDE.md's Text-centering gotchas are about).
      _buildSidebarHomeButton: function () {
        var self = this;
        var size = SIDEBAR_TOOLROW_H;
        var btn = new lively.morphic.Text(lively.rect(0, 0, size, size), "home");
        btn.applyStyle({
          fontFamily: "'Material Symbols Rounded'",
          fontSize: 13.5, // 13.5pt ≈ 18px, see CLAUDE.md's fontSize-is-points note
          textColor: Color.rgb(90, 90, 90),
          fill: Color.rgb(245, 245, 245),
          borderWidth: 0,
          borderRadius: size / 2,
          align: "center",
          padding: lively.Rectangle.inset(0, Math.round((size - 18) / 2), 0, 0),
          allowInput: false,
          selectable: false,
          clipMode: "hidden",
          whiteSpaceHandling: "pre",
        });
        btn.renderContext().shapeNode.style.cursor = "pointer";
        btn.toolTip = "All wiki pages";
        btn.onMouseOver = function () { btn.applyStyle({ fill: Color.rgb(230, 230, 230) }); };
        btn.onMouseOut = function () { btn.applyStyle({ fill: Color.rgb(245, 245, 245) }); };
        btn.onMouseDown = function () { self._showSidebarPageList(""); };
        return btn;
      },

      // Deliberately separate from the centered top-of-page _searchField/
      // _buildContentSearchBar above — that one does a full-content server
      // search across every page; this one is a quick client-side
      // wikiName filter for jumping to a page from inside the sidebar
      // while a page is already open (where the top bar may be scrolled
      // out of view). Same beInputLine()-based technique, see
      // _buildContentSearchBar.
      _buildSidebarSearchField: function () {
        var self = this;
        var w = SIDEBAR_W - SIDEBAR_PAD * 2 - SIDEBAR_TOOLROW_H - 8;
        var h = SIDEBAR_TOOLROW_H;
        var box = new lively.morphic.Box(lively.rect(0, 0, w, h));
        box.setFill(Color.white);
        box.applyStyle({ borderWidth: 1, borderColor: Color.rgb(200, 200, 200), borderRadius: h / 2 });

        var fieldRect = lively.rect(10, 4, w - 20, h - 8);

        var placeholder = lively.morphic.Text.makeLabel("Find a page…", {
          fontSize: 11, textColor: Color.rgb(170, 170, 170),
        });
        placeholder.setPosition(fieldRect.topLeft());
        placeholder.setExtent(fieldRect.extent());
        placeholder.eventsAreIgnored = true;
        box.addMorph(placeholder);

        var field = new lively.morphic.Text(fieldRect, "");
        field.applyStyle({ allowInput: true, fontSize: 11, fill: null, borderWidth: 0 });
        field.beInputLine();
        var superKeyDown = field.onKeyDown;
        field.onKeyDown = function (evt) {
          var result = superKeyDown.call(this, evt);
          // Same one-tick defer as _buildContentSearchBar above — reading
          // field.textString synchronously here lags a character behind.
          setTimeout(function () {
            placeholder.setVisible(!field.textString);
            self._showSidebarPageList(field.textString || "");
          }, 0);
          return result;
        };
        box.addMorph(field);
        this._sidebarSearchField = field;
        this._sidebarSearchPlaceholder = placeholder;

        return box;
      },

      // Right-hand browse panel — content built/rebuilt by
      // _renderCategoriesPanel (see the "categories" category below); this
      // just sets up the box + its static "CATEGORIES" header, same shape
      // as _buildSidebar's own header.
      _buildCategoriesPanel: function () {
        var box = new lively.morphic.Box(lively.rect(0, 0, RIGHT_PANEL_W, 80));
        box.setFill(Color.white);
        box.applyStyle({ borderWidth: 1, borderColor: Color.rgb(230, 230, 230), borderRadius: 8 });

        var header = lively.morphic.Text.makeLabel("CATEGORIES", {
          fontSize: 11, fontWeight: "700", textColor: Color.rgb(150, 150, 150),
        });
        header.setPosition(lively.pt(PANEL_PAD, PANEL_HEADER_TOP));
        header.eventsAreIgnored = true;
        box.addMorph(header);

        // Not a draggable part: all three flags (see CLAUDE.md, drag/
        // drop/grab section) so the panel doesn't get picked up by a
        // click-drag the way a plain Box otherwise defaults to.
        [box, header].forEach(function (m) {
          m.draggingEnabled = false;
          m.droppingEnabled = false;
          m.grabbingEnabled = false;
        });

        box._itemMorphs = [];
        return box;
      },
    },

    // ─── layout ─────────────────────────────────────────────────────────────────

    "layout", {
      // The two panels (and the menu bar, presence panel) are
      // enableFixedPositioning morphs: their nodes live directly under
      // <body>, after the world's own node, so they paint above EVERYTHING
      // in the world — a window opened onto the canvas (confirmed live: the
      // Terminal) slid under the left menu and the categories panel.
      // Reordering inside the world can't fix that, only z-index can: every
      // world-level morph node gets z-index 1 (beating the panels' auto),
      // and every OTHER fixed body-level node (menu bar, presence panel) is
      // lifted to 2 so they stay above windows as they are on other pages.
      // The observer lifts fixed morphs created later (e.g. the presence
      // panel after sign-in).
      _installStacking: function () {
        if (document.getElementById("wiki-index-stacking")) return;
        var self = this;
        var style = document.createElement("style");
        style.id = "wiki-index-stacking";
        style.textContent = ".Morph.World > div > .morphNode { z-index: 1; }";
        document.head.appendChild(style);

        function raiseOthers() {
          var panels = [self._sidebarBox, self._categoriesPanel].map(function (m) {
            return m && m.renderContext().shapeNode.parentNode;
          });
          Array.prototype.forEach.call(document.body.children, function (c) {
            if (!c.classList.contains("morphNode") || panels.indexOf(c) !== -1) return;
            if (window.getComputedStyle(c).position === "fixed") c.style.zIndex = "2";
          });
        }
        raiseOthers();
        new MutationObserver(raiseOthers).observe(document.body, { childList: true });
      },

      // Sizes the title box to its own rendered text. The label hugs its
      // content, but the shapeNode subtracts ~8px of padding from whatever
      // extent it's given, so a box exactly as wide as the text clips the
      // last glyph (confirmed live: "wiki" lost its right edge) — hence
      // +8 on the width and -4 on x so the visible glyph still lines up
      // with SIDE_MARGIN. Reads the real span, which is 0 wide right after
      // addMorph (CLAUDE.md), so it bails then and re-runs once web fonts
      // have loaded, when the span's width is final.
      _fitTitleLabel: function () {
        var label = this._titleLabel;
        label.setPosition(lively.pt(SIDE_MARGIN - 4, TOP + 38));
        var span = label.renderContext().shapeNode.querySelector("span");
        var w = span ? span.getBoundingClientRect().width : 0;
        if (w > 0) {
          label.setExtent(lively.pt(Math.ceil(w) + 8, label.getExtent().y));
        }
        if (!this._titleFontsHooked && document.fonts && document.fonts.ready) {
          this._titleFontsHooked = true;
          var self = this;
          document.fonts.ready.then(function () { self._fitTitleLabel(); });
        }
      },

      _layout: function () {
        var W = this._pageW();

        // Sits BACK_BTN_LIFT px above the sort/new-page header row (the
        // title stays at TOP + 38) — leaves ~20px clear under the menu
        // bar. The centered search bar below is vertically aligned with
        // this pill's own row, not the sort/new row.
        this._backBtn.setPosition(lively.pt(SIDE_MARGIN, TOP - BACK_BTN_LIFT));
        this._fitTitleLabel();

        var backBtnW = this._backBtn.getExtent().x;
        var leftBound = SIDE_MARGIN + backBtnW + 24;
        var fullNewW = this._newBtnW || NEW_BTN_W;
        var compactNewW = this._newBtnCompactW || NEW_BTN_H;
        function sortXFor(newW) { return W - SIDE_MARGIN - newW - SORT_GAP - SORT_W; }

        // The bar shrinks first (down to SEARCH_BAR_COMPACT_BELOW), and
        // only once even that isn't enough does "+ New wiki page" give up
        // its label and become a bare "+" circle (same degrade as
        // ConstellationLounge.js's "+ Postcard"), handing ~130px back to
        // the bar. Both pills are separate morphs; only one is visible.
        var compactNew = (sortXFor(fullNewW) - 24 - leftBound) < SEARCH_BAR_COMPACT_BELOW;
        var newBtnW = compactNew ? compactNewW : fullNewW;
        this._newBtn.setVisible(!!this._canWrite && !compactNew);
        this._newBtnCompact.setVisible(!!this._canWrite && compactNew);
        var newBtn = compactNew ? this._newBtnCompact : this._newBtn;
        newBtn.setPosition(lively.pt(W - SIDE_MARGIN - newBtnW, TOP + (HEADER_ROW_H - NEW_BTN_H) / 2));
        // The hidden variant is kept in bounds too (it counts toward the
        // page's scroll width even while hidden — a stale far-right spot
        // from a wider window gave a horizontal scrollbar at 800px).
        var otherBtn = compactNew ? this._newBtn : this._newBtnCompact;
        var otherW = compactNew ? fullNewW : compactNewW;
        otherBtn.setPosition(lively.pt(W - SIDE_MARGIN - otherW, TOP + (HEADER_ROW_H - NEW_BTN_H) / 2));

        var sortX = sortXFor(newBtnW);
        this._sortByBox.setPosition(lively.pt(sortX, TOP));
        if (this._sortByDropdown) this._sortByDropdown.setPosition(lively.pt(sortX, TOP + SORT_H + 4));

        // The full-content search bar shares the back pill's row
        // (vertically centered against it) rather than sitting on its own
        // row below the title. It's centered on the page itself, but only
        // has the space between the back pill and the sort-by pill:
        // SEARCH_BAR_W when that fits, otherwise it shrinks to what's left
        // (floored at SEARCH_BAR_MIN_W, below which it'd just overlap the
        // controls — confirmed live at a 1000px window, where a fixed
        // 520px bar covered ~86px of the sort pill) and is clamped into
        // that gap instead of centered.
        var rightBound = sortX - 24;
        var barW = Math.max(SEARCH_BAR_MIN_W, Math.min(SEARCH_BAR_W, rightBound - leftBound));
        this._setSearchBarWidth(barW);
        var barX = Math.max(leftBound, Math.min(Math.round((W - barW) / 2), rightBound - barW));
        var barY = (TOP - BACK_BTN_LIFT) + Math.round((HEADER_ROW_H - SEARCH_BAR_H) / 2);
        this._searchBar.setPosition(lively.pt(barX, barY));
        if (this._searchDropdown) this._searchDropdown.setPosition(lively.pt(barX, barY + SEARCH_BAR_H + 6));

        this._gridY = TOP + HEADER_H + GRID_TOP_GAP;
        // Position/width/height depend on whether a page is open, so
        // _layoutGrid owns them (it's also called when that changes).
        this._layoutGrid();
      },

      // Two modes, switched by whether a page is open:
      //  - no page open: the cards wrap into as many rows as they need,
      //    filling the space between the left sidebar and the right
      //    categories panel (the same span the open page uses, see
      //    _contentWidth), with both panels starting level with the grid.
      //  - a page open: ONE shelf row across the full width that scrolls
      //    horizontally (native overflow, via clipMode) once there are
      //    more cards than fit. The grid used to always be a wrapping
      //    grid, which pushed the open wiki view (positioned right below
      //    the grid, see _repositionWikiView) far down the page; one row
      //    keeps the grid's own height to a single card regardless of how
      //    many pages exist, freeing the viewport for the page itself.
      // Cards can be taller than the CARD_H floor if _fitCard hugs a
      // wrapped title, so row heights come from the tallest card actually
      // in each row, not a hardcoded constant.
      _layoutGrid: function () {
        var pageOpen = !!this._activeContentMorph;
        var gridX = pageOpen ? SIDE_MARGIN : SIDE_MARGIN + SIDEBAR_W + SIDEBAR_GAP;
        var gridW = pageOpen
          ? Math.max(CARD_W, this._pageW() - SIDE_MARGIN * 2)
          : Math.max(CARD_W, this._spanBetweenPanels());
        this._gridW = gridW;
        this._gridBox.setPosition(lively.pt(gridX, this._gridY));

        var cards = this._cardMorphs || [];
        if (pageOpen) {
          var rowH = 0;
          var x = 0;
          cards.forEach(function (card) {
            card.setPosition(lively.pt(x, 0));
            x += CARD_W + GRID_GAP;
            rowH = Math.max(rowH, card._cardH || CARD_H);
          });
          var contentW = cards.length ? (x - GRID_GAP) : 0;
          var overflowing = contentW > gridW;

          // +16: room for the native horizontal scrollbar so it doesn't clip
          // the cards' own bottom edge (clipMode's overflow-y is 'hidden').
          var boxH = cards.length ? rowH + (overflowing ? 16 : 0) : rowH;
          this._gridBox.setExtent(lively.pt(gridW, boxH));
          this._gridBox.applyStyle({ clipMode: overflowing ? { x: "auto", y: "hidden" } : "visible" });
          this._gridContentHeight = cards.length ? rowH : 0;
        } else {
          var cols = Math.max(1, Math.floor((gridW + GRID_GAP) / (CARD_W + GRID_GAP)));
          // Center the block of columns in the span between the panels:
          // cards are a fixed width, so the columns rarely fill it exactly
          // and the leftover (~190px at 1923px) used to all sit on the
          // right. The block is sized by the column count, not the card
          // count, so a filter that leaves fewer cards doesn't shift the
          // columns sideways; rows stay left-aligned within the block.
          var blockW = cols * CARD_W + (cols - 1) * GRID_GAP;
          this._gridW = blockW;
          this._gridBox.setPosition(lively.pt(gridX + Math.max(0, Math.floor((gridW - blockW) / 2)), this._gridY));
          var cx = 0, cy = 0, col = 0, tallest = 0;
          cards.forEach(function (card) {
            if (col === cols) {
              col = 0;
              cx = 0;
              cy += tallest + GRID_GAP;
              tallest = 0;
            }
            card.setPosition(lively.pt(cx, cy));
            cx += CARD_W + GRID_GAP;
            col++;
            tallest = Math.max(tallest, card._cardH || CARD_H);
          });
          var totalH = cards.length ? cy + tallest : 0;
          this._gridBox.setExtent(lively.pt(blockW, Math.max(totalH, CARD_H)));
          this._gridBox.applyStyle({ clipMode: "visible" });
          this._gridContentHeight = totalH;
        }
        this._repositionWikiView();
      },

      // Keeps the currently-open topic WikiView (see _openPage) and its
      // "On this page" sidebar pinned just below the grid's real content,
      // not the world-centered position WikiView.open's own _openInWorld
      // would otherwise give the view — called after every grid reflow
      // (search filtering, window resize) since the grid's content height
      // can change under it. The view is held off SIDE_MARGIN by
      // SIDEBAR_W + SIDEBAR_GAP so the sidebar has room alongside it.
      _repositionWikiView: function () {
        var y = (this._gridY || 0) + (this._gridContentHeight || 0) + GRID_TOP_GAP;
        var m = this._activeContentMorph;
        if (m && m.world()) {
          m.setPosition(lively.pt(this._contentLeft(), y));
          // Keep the page filling the space between the sidebar and the
          // categories panel as the window (or the scrollbar) changes width.
          var w = this._contentWidth(), ext = m.getExtent();
          if (Math.abs(ext.x - w) >= 1) m.setExtent(lively.pt(w, ext.y));
        }
        this._pinPanels();
        this._syncPageHeight();
      },

      // Width of the area the page can use: the document's client width, so
      // it excludes the vertical scrollbar once the page is tall enough to
      // scroll (window.innerWidth includes it, which left the right margin
      // 15px short of the left one).
      _pageW: function () {
        return document.documentElement.clientWidth;
      },

      // The sidebar and categories panel are position:fixed (see
      // _buildChrome's enableFixedPositioning calls) so they stay on screen
      // while the page scrolls. They sit at the top of the page content
      // until it scrolls up under PANEL_STICKY_TOP, then hold there. A fixed
      // morph's setPosition takes WORLD coordinates and subtracts the current
      // scroll offset itself, so the viewport y is passed back as
      // viewportY + scrollY.
      _pinPanels: function () {
        var scrollY = window.pageYOffset || 0;
        // Level with the grid's top while it fills the middle (no page
        // open); below the one-row shelf once a page is open.
        var naturalY = this._activeContentMorph
          ? (this._gridY || 0) + (this._gridContentHeight || 0) + GRID_TOP_GAP
          : (this._gridY || 0);
        var viewportY = Math.max(PANEL_STICKY_TOP, naturalY - scrollY);
        // getScrollOffset reads a cached window rect; drop it so it matches
        // the scroll position just read.
        if ($world) $world.cachedWindowBounds = null;
        // Too narrow for the panels beside an open page: hide both (the
        // page takes their room, see _contentWidth). Only on a change of
        // state, so the sidebar's own show/hide logic isn't fought every
        // scroll tick; the sidebar's renders re-check _panelsHidden too.
        var hidden = this._panelsHidden();
        if (hidden !== !!this._panelsWereHidden) {
          this._panelsWereHidden = hidden;
          if (this._categoriesPanel) this._categoriesPanel.setVisible(!hidden);
          if (this._sidebarBox) this._sidebarBox.setVisible(!hidden);
        }
        // Positioned even while hidden: a hidden node still counts toward
        // the page's scroll width, so one left at its old wide-window spot
        // gave the page a horizontal scrollbar at narrow widths (measured:
        // scrollWidth 1883 in an 800px window, from the hidden categories
        // panel at x=1623).
        if (this._categoriesPanel && this._categoriesPanel.world()) {
          var rightX = this._pageW() - SIDE_MARGIN - RIGHT_PANEL_W;
          this._categoriesPanel.setPosition(lively.pt(rightX, viewportY + scrollY));
        }
        if (hidden) return;
        if (this._sidebarBox && this._sidebarBox.world() && this._sidebarBox.isVisible()) {
          this._sidebarBox.setPosition(lively.pt(SIDE_MARGIN, viewportY + scrollY));
        }
      },

      // Extends the world's own extent to cover the open page, so the browser
      // page gets a scroll range matching the page's height and the world
      // background fills all of it (a world is normally viewport-sized).
      _syncPageHeight: function () {
        var m = this._activeContentMorph;
        // With no page open the bottom is the wrapped card grid's, which
        // can be taller than the viewport.
        var bottom = (m && m.world())
          ? m.getPosition().y + m.getExtent().y
          : (this._gridY || 0) + (this._gridContentHeight || 0);
        var h = Math.max(window.innerHeight, Math.ceil(bottom + PAGE_BOTTOM_MARGIN));
        // clientWidth, not innerWidth: innerWidth includes the vertical
        // scrollbar this very height creates, which would add a horizontal
        // one. And 1px under even that: a world exactly clientWidth wide still
        // gets a horizontal scrollbar (measured: 1601 does, 1600 and below
        // don't, with nothing measurably overflowing).
        var pageW = this._pageW();
        var w = pageW - 1;
        var ext = $world.getExtent();
        if (Math.abs(ext.y - h) < 1 && Math.abs(ext.x - w) < 1) return;
        $world.setExtent(lively.pt(w, h));
        // Growing past the viewport adds the vertical scrollbar (and removing
        // it takes it away), which changes the usable width: relayout once
        // against the new width. _lastPageW stops this recursing.
        if (this._pageW() !== this._lastPageW) {
          this._lastPageW = this._pageW();
          this._layout();
        }
      },

      // Passed to WikiView.open / WikiEditor.openCard|newCard so the open
      // page grows with its content instead of scrolling inside a fixed box.
      _autoHeightOpts: function (opts) {
        var self = this;
        opts.autoHeight = true;
        opts.onHeightChanged = function () { self._syncPageHeight(); };
        return opts;
      },

      // Shared by _openPage/_createNewPage — available width for the open
      // wiki view/editor between the left sidebar gutter and the right
      // categories panel gutter. Uncapped: the page runs right up to
      // RIGHT_PANEL_GAP from the categories panel, the same gap it has from
      // the sidebar on the left (SIDEBAR_GAP), at any window width.
      //
      // When that space would be narrower than PAGE_MIN_W the two panels
      // give way instead (_panelsFit): the page takes the full width and
      // _pinPanels hides them while it's open.
      _contentWidth: function () {
        if (!this._panelsFit()) return Math.max(320, this._pageW() - SIDE_MARGIN * 2);
        return this._spanBetweenPanels();
      },

      // The space between the two panels, whether or not a page fills it —
      // also what the wrapped card grid is centered in (_layoutGrid).
      _spanBetweenPanels: function () {
        var leftEdge = SIDE_MARGIN + SIDEBAR_W + SIDEBAR_GAP;
        var rightGutter = RIGHT_PANEL_W + RIGHT_PANEL_GAP;
        return Math.max(400, this._pageW() - leftEdge - rightGutter - SIDE_MARGIN);
      },

      // True while the window is wide enough to show both panels beside a
      // page at least PAGE_MIN_W wide.
      _panelsFit: function () {
        var gutters = SIDE_MARGIN * 2 + SIDEBAR_W + SIDEBAR_GAP + RIGHT_PANEL_W + RIGHT_PANEL_GAP;
        return this._pageW() - gutters >= PAGE_MIN_W;
      },

      // The panels are only ever hidden for an open page — with none open
      // they're the way to find one, so they stay.
      _panelsHidden: function () {
        return !!this._activeContentMorph && !this._panelsFit();
      },

      // Left edge of the open page: past the sidebar, or the page margin
      // when the panels are hidden.
      _contentLeft: function () {
        return this._panelsFit() ? SIDE_MARGIN + SIDEBAR_W + SIDEBAR_GAP : SIDE_MARGIN;
      },
    },

    // ─── sort by ────────────────────────────────────────────────────────────────

    "sort by", {
      _sortOptionLabel: function () {
        var self = this;
        var opt = SORT_OPTIONS.find(function (o) { return o.key === self._sortBy; });
        return (opt || SORT_OPTIONS[0]).label;
      },

      _toggleSortByDropdown: function () {
        if (this._sortByDropdown) return this._closeSortByDropdown();

        var self = this;
        // While a page is open the menu gets one more row below the sort
        // options — "All pages", the way back from the one-row shelf to
        // the wrapped grid. It's an action, not a sort key, so it sits
        // under a divider and never gets the ✓.
        var pageOpen = !!this._activeContentMorph;
        var DIVIDER_H = 9;
        var itemsH = SORT_OPTIONS.length * SORT_ITEM_H + (pageOpen ? DIVIDER_H + SORT_ITEM_H : 0);
        var dropdown = new lively.morphic.Box(lively.rect(0, 0, SORT_W, itemsH + 8));
        dropdown.setFill(Color.white);
        dropdown.applyStyle({ borderWidth: 1, borderColor: Color.rgb(200, 200, 200), borderRadius: 8 });

        SORT_OPTIONS.forEach(function (opt, i) {
          var isSelected = opt.key === self._sortBy;
          var row = new lively.morphic.Text(
            lively.rect(0, 4 + i * SORT_ITEM_H, SORT_W, SORT_ITEM_H),
            (isSelected ? "✓ " : "   ") + opt.label,
          );
          row.applyStyle({
            fontSize: 12,
            fontWeight: isSelected ? "600" : "400",
            textColor: isSelected ? Color.rgb(20, 20, 20) : Color.rgb(90, 90, 90),
            fill: null, borderWidth: 0, borderColor: null, align: "left",
          });
          row.renderContext().shapeNode.style.cursor = "pointer";
          row.onMouseDown = function () { self._selectSortOption(opt.key); };
          row.onMouseOver = function () { row.applyStyle({ fill: Color.rgb(245, 245, 245) }); };
          row.onMouseOut = function () { row.applyStyle({ fill: null }); };
          dropdown.addMorph(row);
        });

        if (pageOpen) {
          var rowsBottom = 4 + SORT_OPTIONS.length * SORT_ITEM_H;
          var divider = new lively.morphic.Box(lively.rect(10, rowsBottom + 4, SORT_W - 20, 1));
          divider.setFill(Color.rgb(230, 230, 230));
          divider.applyStyle({ borderWidth: 0 });
          divider.eventsAreIgnored = true;
          dropdown.addMorph(divider);

          var allRow = new lively.morphic.Text(
            lively.rect(0, rowsBottom + DIVIDER_H, SORT_W, SORT_ITEM_H),
            "    All pages", // 4 spaces, not the sort rows' 3: this row is bolder, whose spaces are narrower, and measured 5px short of their label x
          );
          allRow.applyStyle({
            fontSize: 12, fontWeight: "600", textColor: Color.rgb(20, 20, 20),
            fill: null, borderWidth: 0, borderColor: null, align: "left",
          });
          allRow.renderContext().shapeNode.style.cursor = "pointer";
          allRow.onMouseDown = function () {
            self._closeSortByDropdown();
            self._closeActivePage();
          };
          allRow.onMouseOver = function () { allRow.applyStyle({ fill: Color.rgb(245, 245, 245) }); };
          allRow.onMouseOut = function () { allRow.applyStyle({ fill: null }); };
          dropdown.addMorph(allRow);
        }

        $world.addMorph(dropdown);
        // Same stacking fix as the search dropdown: this one spans the top
        // of the fixed categories panel, whose body-level node otherwise
        // paints over it.
        dropdown.renderContext().shapeNode.style.zIndex = "1000";
        this._sortByDropdown = dropdown;

        // Click anywhere else closes it. Its rows are decided when it's
        // built (the "All pages" row only exists while a page is open), so
        // a menu left open across a page opening/closing went stale —
        // confirmed live: opened with no page, then a card click left it
        // open with its three old rows. A document-level capture listener
        // sees the click before any morph does; the sort button's own
        // click is left to its own toggle.
        this._sortOutsideHandler = function (evt) {
          var dd = self._sortByDropdown;
          if (!dd) return;
          if (dd.renderContext().shapeNode.contains(evt.target)) return;
          if (self._sortByBox.renderContext().shapeNode.contains(evt.target)) return;
          self._closeSortByDropdown();
        };
        document.addEventListener("mousedown", this._sortOutsideHandler, true);
        this._layout();
      },

      _closeSortByDropdown: function () {
        if (this._sortOutsideHandler) {
          document.removeEventListener("mousedown", this._sortOutsideHandler, true);
          this._sortOutsideHandler = null;
        }
        if (!this._sortByDropdown) return;
        this._sortByDropdown.remove();
        this._sortByDropdown = null;
      },

      _selectSortOption: function (key) {
        this._sortBy = key;
        if (this._sortByLabel) this._sortByLabel.setTextString(this._sortOptionLabel());
        this._closeSortByDropdown();
        this._renderPages();
      },

      // Applied after search-filtering, before the grid is built
      // (_renderPages) — "modified"/"created" both fall back to wikiName
      // ordering when two pages tie exactly on a timestamp, so the grid
      // order stays deterministic instead of flapping between renders.
      _sortPages: function (pages) {
        var sortBy = this._sortBy;
        var sorted = pages.slice();
        if (sortBy === "alpha") {
          sorted.sort(function (a, b) {
            return (a.wikiName || "").toLowerCase().localeCompare((b.wikiName || "").toLowerCase());
          });
        } else {
          var field = sortBy === "created" ? "createdAt" : "updatedAt";
          sorted.sort(function (a, b) {
            var diff = new Date(b[field] || 0).getTime() - new Date(a[field] || 0).getTime();
            if (diff) return diff;
            return (a.wikiName || "").toLowerCase().localeCompare((b.wikiName || "").toLowerCase());
          });
        }
        return sorted;
      },
    },

    // ─── categories & tags ──────────────────────────────────────────────────────

    "categories", {
      // { category -> { count, tagSet } } from every page's own
      // category/tags fields (both null/empty for a page created before
      // this existed, or via any path that skips NewWikiPageDialog —
      // those pages just don't contribute to the panel), then sorted into
      // [{ category, count, tags }, ...] — known categories in
      // CATEGORY_ORDER's fixed order first, any others alphabetically
      // after (defensive: covers legacy/manually-set category strings
      // outside that list rather than silently dropping them).
      _categoryTagMap: function () {
        var map = {};
        this._pages.forEach(function (p) {
          if (!p.category) return;
          if (!map[p.category]) map[p.category] = { count: 0, tagSet: {} };
          map[p.category].count++;
          (p.tags || []).forEach(function (t) { if (t) map[p.category].tagSet[t] = true; });
        });
        var categories = Object.keys(map);
        categories.sort(function (a, b) {
          var ia = CATEGORY_ORDER.indexOf(a); if (ia === -1) ia = CATEGORY_ORDER.length;
          var ib = CATEGORY_ORDER.indexOf(b); if (ib === -1) ib = CATEGORY_ORDER.length;
          return ia !== ib ? ia - ib : a.localeCompare(b);
        });
        return categories.map(function (cat) {
          var tags = Object.keys(map[cat].tagSet).sort(function (a, b) { return a.localeCompare(b); });
          return { category: cat, count: map[cat].count, tags: tags };
        });
      },

      // Rebuilds the whole right-hand panel from scratch — cheap enough
      // (a handful of categories/tags) to just do on every data change or
      // filter-selection change, same rebuild-heavy approach the sidebar's
      // outline/page-list rendering already uses. Category labels are
      // clickable rows; tags render as flow-wrapped pill morphs
      // (_buildTagPill/_fitPill) beneath their own category, wrapping to a
      // new line once a row would overflow the panel's content width.
      _renderCategoriesPanel: function () {
        var self = this;
        var box = this._categoriesPanel;
        (box._itemMorphs || []).forEach(function (m) { m.remove(); });
        box._itemMorphs = [];

        var groups = this._categoryTagMap();
        var y = PANEL_ITEMS_TOP;

        if (!groups.length) {
          var empty = lively.morphic.Text.makeLabel("No categories yet.", {
            fontSize: 12, textColor: Color.rgb(170, 170, 170),
          });
          empty.setPosition(lively.pt(PANEL_PAD, y));
          empty.draggingEnabled = false;
          empty.droppingEnabled = false;
          empty.grabbingEnabled = false;
          box.addMorph(empty);
          box._itemMorphs.push(empty);
          y += 22;
        } else {
          groups.forEach(function (g) {
            var isSelectedCat = self._categoryFilter === g.category;
            var label = new lively.morphic.Text(
              lively.rect(PANEL_PAD, y, RIGHT_PANEL_W - PANEL_PAD * 2, CATEGORY_LABEL_H),
              g.category + " (" + g.count + ")",
            );
            label.applyStyle({
              fontSize: 13, fontWeight: isSelectedCat ? "700" : "600",
              textColor: isSelectedCat ? Color.rgb(20, 20, 20) : Color.rgb(60, 60, 60),
              fill: null, borderWidth: 0, borderColor: null,
            });
            label.renderContext().shapeNode.style.cursor = "pointer";
            label.onMouseDown = function () { self._selectCategory(g.category); };
            label.draggingEnabled = false;
            label.droppingEnabled = false;
            label.grabbingEnabled = false;
            box.addMorph(label);
            box._itemMorphs.push(label);
            y += CATEGORY_LABEL_H + 6;

            var x = PANEL_PAD;
            g.tags.forEach(function (tag) {
              var isSelectedTag = isSelectedCat && self._tagFilter === tag;
              // Pill built empty and added to `box` (already in $world)
              // *before* its label exists — see _fitPill's comment for why
              // that order matters.
              var pill = self._buildTagPill(g.category, tag, isSelectedTag);
              box.addMorph(pill);
              var pillW = self._fitPill(pill, g.category, tag, isSelectedTag);
              if (x + pillW > RIGHT_PANEL_W - PANEL_PAD && x > PANEL_PAD) {
                x = PANEL_PAD;
                y += PILL_H + PILL_GAP_Y;
              }
              pill.setPosition(lively.pt(x, y));
              x += pillW + PILL_GAP_X;
              box._itemMorphs.push(pill);
            });
            if (g.tags.length) y += PILL_H;
            y += CATEGORY_BLOCK_GAP;
          });
        }

        box.setExtent(lively.pt(RIGHT_PANEL_W, y + 8));
      },

      // Builds only the pill's outer Box, with no label child yet — see
      // _fitPill for why the label has to be added later instead of here.
      _buildTagPill: function (category, tag, isSelected) {
        var self = this;
        var pill = new lively.morphic.Box(lively.rect(0, 0, 10, PILL_H));
        pill.applyStyle({
          fill: isSelected ? Color.rgb(55, 55, 55) : Color.rgb(235, 235, 240),
          borderWidth: 0, borderRadius: PILL_H / 2,
        });
        pill.renderContext().shapeNode.style.cursor = "pointer";
        pill.onMouseDown = function () { self._selectTag(category, tag); };
        pill.draggingEnabled = false;
        pill.droppingEnabled = false;
        pill.grabbingEnabled = false;
        return pill;
      },

      // Creates the pill's tag-text label and sizes both it and the pill
      // to hug it. Deliberately split out from _buildTagPill and called
      // only *after* the caller has already added the (still-empty) pill
      // to `box` — confirmed live: adding the label as a child of `pill`
      // while `pill` itself was still a detached morph (not yet in
      // $world) rendered the label off-document, and its text metrics
      // came back wrapped ("claude" → "claud"/"e") and stayed wrapped
      // even after later resizing, despite offsetWidth/style.width
      // otherwise looking correct — a stricter version of the "must
      // already be in $world to measure" rule CLAUDE.md documents for
      // _fitCard, since here even indirect (grandparent-only) world
      // membership at creation time wasn't enough.
      //
      // Mirrors _fitCard's idioms: the label starts at 1px height so
      // offsetHeight isn't floored by the shapeNode's own min-height, and
      // the measured height gets +4 added back (2px top + 2px bottom) to
      // compensate for setExtentHTML subtracting the shapeNode's internal
      // padding. Width compensation is +10, not the +8 (4px each side)
      // _buildPageCard/_fitCard's own header comment uses — confirmed
      // live: +8 (exactly canceling the padding subtraction, zero extra
      // slack) still wrapped "claude" about half the time depending on
      // the word, because offsetWidth rounds to a whole CSS px while the
      // real layout width can be a fraction above that (more visible at
      // this window's 1.5 devicePixelRatio), and a pill's fit is snug
      // enough that even a sub-pixel shortfall triggers wrap. +2px of
      // real slack on top of the padding compensation reliably avoided it
      // across every word tested ("claude", "verification", "test",
      // "save-test", a single "a"). _fitCard's own case tolerates the
      // same rounding fine because its card width has much more slack
      // than a hug-fit pill does.
      _fitPill: function (pill, category, tag, isSelected) {
        var label = new lively.morphic.Text(lively.rect(PILL_PAD_X, 0, 160, 1), tag);
        label.applyStyle({
          fontSize: 11, fontWeight: isSelected ? "700" : "500",
          textColor: isSelected ? Color.white : Color.rgb(70, 70, 70),
          fill: null, borderWidth: 0, borderColor: null,
        });
        label.eventsAreIgnored = true;
        label.draggingEnabled = false;
        label.droppingEnabled = false;
        label.grabbingEnabled = false;
        pill.addMorph(label);

        var innerDiv = label.renderContext().shapeNode.querySelector("div");
        var span = innerDiv ? innerDiv.querySelector("span") : null;
        var textW = span ? span.offsetWidth : 30;
        var textH = innerDiv ? innerDiv.offsetHeight : 14;
        label.setExtent(lively.pt(textW + 10, textH + 4));
        label.setPosition(lively.pt(PILL_PAD_X, Math.round((PILL_H - (textH + 4)) / 2)));
        var pillW = textW + PILL_PAD_X * 2;
        pill.setExtent(lively.pt(pillW, PILL_H));
        return pillW;
      },

      // Clicking a category toggles it as the active filter and clears
      // any tag filter (a tag only makes sense scoped to the category row
      // it's rendered under — see _selectTag).
      _selectCategory: function (category) {
        if (this._categoryFilter === category) {
          this._categoryFilter = null;
          this._tagFilter = null;
        } else {
          this._categoryFilter = category;
          this._tagFilter = null;
        }
        this._renderCategoriesPanel();
        this._renderPages();
      },

      // Clicking a tag pill selects both its category and the tag
      // together (that pair is exactly what's shown grouped under the
      // category label), or clears just the tag if that exact pair is
      // already active.
      _selectTag: function (category, tag) {
        if (this._categoryFilter === category && this._tagFilter === tag) {
          this._tagFilter = null;
        } else {
          this._categoryFilter = category;
          this._tagFilter = tag;
        }
        this._renderCategoriesPanel();
        this._renderPages();
      },
    },

    // ─── page grid ──────────────────────────────────────────────────────────────

    "pages", {
      _renderPages: function () {
        var self = this;
        (this._cardMorphs || []).forEach(function (m) { m.remove(); });
        this._cardMorphs = [];

        var pages = this._pages;
        if (this._categoryFilter) {
          pages = pages.filter(function (p) { return p.category === self._categoryFilter; });
        }
        if (this._tagFilter) {
          pages = pages.filter(function (p) { return (p.tags || []).indexOf(self._tagFilter) !== -1; });
        }
        pages = this._sortPages(pages);
        this._pagesFiltered = pages;

        if (!pages.length) {
          var emptyMsg = "No wiki pages yet.";
          if (this._pages.length) {
            if (this._tagFilter) emptyMsg = "No wiki pages tagged “" + this._tagFilter + "”.";
            else if (this._categoryFilter) emptyMsg = "No wiki pages in “" + this._categoryFilter + "”.";
          }
          var empty = lively.morphic.Text.makeLabel(emptyMsg, { fontSize: 13, textColor: Color.gray });
          empty.setPosition(lively.pt(0, 0));
          this._gridBox.addMorph(empty);
          this._cardMorphs.push(empty);
          // Reset back to a plain single-row slot — a previous non-empty
          // render may have left this box taller/scrollable (_layoutGrid's
          // +16 scrollbar allowance and clipMode:{x:'auto'}), which would
          // otherwise linger through a search that temporarily matches
          // nothing.
          this._gridBox.setExtent(lively.pt(this._gridW || CARD_W, CARD_H));
          this._gridBox.applyStyle({ clipMode: "visible" });
          this._gridContentHeight = 0;
          this._showPageListIfNoPageOpen();
          this._repositionWikiView();
          return;
        }

        pages.forEach(function (p) {
          var card = self._buildPageCard(p);
          self._gridBox.addMorph(card);
          self._fitCard(card);
          self._cardMorphs.push(card);
        });
        this._showPageListIfNoPageOpen();
        this._layoutGrid();
      },

      // With no page open the left menu is the page list (there's no
      // outline to show), filled in here once the pages exist and again
      // when they change — before the grid's layout, since _pinPanels only
      // positions the menu once it's visible. A page's own outline
      // (_setActiveContentMorph) is never overwritten while one is open.
      _showPageListIfNoPageOpen: function () {
        if (this._activeContentMorph || !this._sidebarBox) return;
        this._renderSidebarPageList(this._sidebarListQuery || "");
      },

      _buildPageCard: function (page) {
        var self = this;
        var card = new lively.morphic.Box(lively.rect(0, 0, CARD_W, CARD_H));
        card.setFill(Color.white);
        card.applyStyle({ borderWidth: 1, borderColor: Color.rgb(230, 230, 230), borderRadius: 8 });
        card.renderContext().shapeNode.style.cursor = "pointer";

        // Fixed width, left to wrap naturally (wiki page names are
        // letters/numbers/hyphens only, no spaces — see
        // _promptNewWikiPage's charset — so wrapping happens at hyphen
        // boundaries) instead of the old nowrap+ellipsis truncation.
        // _fitCard below measures the real (possibly wrapped) height once
        // this card is actually live in the world and hugs the card/date
        // position to it.
        // KNOWN ISSUE (open): some pages come back with page.wikiName == null and
        // render here as a card with no title. Seen 2026-09-18 on @tinasnow's
        // personal wiki: 5 of 10 pages. Verified via GET /@handle/:objId — each
        // such page's latest version has a `state.wikiName` key whose value is
        // null (while `title` and `category` are present), and the index list
        // (listWikiPagesForUser / listWikiPages in ObjectRepository.js) just
        // reads state.wikiName, so the null is in the stored data, not a
        // display or query bug. NOT yet investigated: how those versions were
        // saved with a null name (an editor save path that drops it?), and
        // whether they're also unreachable via /wiki/:pageName (it looks pages
        // up by wikiName). Possible stopgaps: fall back to the page's `title`
        // in the list query + here, and/or repair the stored data. Note that
        // `|| ""` sorting/filtering elsewhere in this file already tolerates
        // null names, so only this label is affected.
        var nameLabel = new lively.morphic.Text(lively.rect(14, 14, CARD_W - 28, 1), page.wikiName);
        nameLabel.applyStyle({
          fontSize: 15, fontWeight: "600", textColor: Color.rgb(30, 30, 30),
          fill: null, borderWidth: 0, borderColor: null,
        });
        nameLabel.eventsAreIgnored = true;
        card.addMorph(nameLabel);

        var dateLabel = lively.morphic.Text.makeLabel("Updated " + this._formatDate(page.updatedAt), {
          fontSize: 12, textColor: Color.rgb(150, 150, 150),
        });
        dateLabel.eventsAreIgnored = true;
        card.addMorph(dateLabel);

        card._nameLabel = nameLabel;
        card._dateLabel = dateLabel;
        card._cardH = CARD_H;
        card.onMouseDown = function () { self._openPage(page); };
        // Clickable card, not a draggable part: all three flags on the card
        // and each child (see CLAUDE.md, drag/drop/grab section).
        [card, nameLabel, dateLabel].forEach(function (m) {
          m.draggingEnabled = false;
          m.droppingEnabled = false;
          m.grabbingEnabled = false;
        });
        return card;
      },

      // Only safe to call once `card` is actually in the world (added to
      // _gridBox, itself already in $world) — a Text morph's rendered
      // height reads back as garbage before that. The box's own height was
      // set to 1px (not a generous guess) when the label was created: the
      // rendered content div's CSS is `min-height: calc(100% - 4px)` of the
      // box's *own* height, so a generous throwaway height becomes a floor
      // a short title's true content height can never measure below — see
      // CLAUDE.md's Text-morph sizing notes. A 1px box makes that floor
      // negligible, so offsetHeight reflects the real (possibly
      // multi-line) wrapped content.
      _fitCard: function (card) {
        var nameLabel = card._nameLabel, dateLabel = card._dateLabel;
        var innerDiv = nameLabel.renderContext().shapeNode.querySelector("div");
        var titleH = innerDiv ? innerDiv.offsetHeight : 20;
        // +4: shapeNode's own top/bottom padding that setExtent subtracts
        // back out, see CLAUDE.md.
        nameLabel.setExtent(lively.pt(CARD_W - 28, titleH + 4));

        var dateY = 14 + titleH + 4 + 8;
        dateLabel.setPosition(lively.pt(14, dateY));

        var cardH = Math.max(CARD_H, dateY + 18 + 14);
        card.setExtent(lively.pt(CARD_W, cardH));
        card._cardH = cardH;
      },

      // WikiView.open's own _openInWorld centers a standalone view on the
      // visible viewport, which overlaps this page's topic grid — pin it
      // below the grid's real content instead (_repositionWikiView), and
      // cap its width to the available space rather than WikiView's
      // fixed 1180px default. Passes the envelope _resolveHandle already
      // fetched straight through as opts.envelope: WikiView.open renders it
      // synchronously in that case (see WikiView.js's _setup), which both
      // saves a redundant fetch and means getOutline() below already has
      // real content to read the instant open() returns.
      // extraOpts.highlightQuery (optional): set by the search-results
      // dropdown (_buildSearchResultRow) so the opened WikiView highlights
      // and scrolls to the term that was searched for.
      _openPage: function (page, extraOpts) {
        var self = this;
        this._resolveHandle(page.objId, function (handle, envelope) {
          var w = self._contentWidth();
          var opts = self._autoHeightOpts({ bounds: lively.rect(0, 0, w, 780) });
          if (envelope) opts.envelope = envelope;
          opts.onEdit = function (h, o, v, restore) { self._editExistingPage(h, o, restore); };
          opts.onDeleted = function (h, o) { self._handlePageDeleted(o); };
          if (extraOpts && extraOpts.highlightQuery) opts.highlightQuery = extraOpts.highlightQuery;
          self._setActiveContentMorph(lively.identity.WikiView.open(handle, page.objId, opts));
        });
      },

      // Mirrors _createNewPage below, but for an already-existing page
      // (openCard, not newCard) -- wired as _openPage's opts.onEdit so
      // clicking Edit swaps the WikiView in this slot for a WikiEditor in
      // place, symmetric to the editor->view swap _createNewPage already
      // does on Save. `restore` (optional, from the history panel's Restore):
      // an old version's content for the editor to apply and save as a new
      // version -- see WikiEditor.openCard's opts.restore.
      _editExistingPage: function (handle, objId, restore) {
        var self = this;
        var w = self._contentWidth();
        var editor = lively.identity.WikiEditor.openCard(handle, objId, self._autoHeightOpts({
          target: $world,
          bounds: lively.rect(0, 0, w, 780),
          restore: restore || null,
          onSaved: function (h, o, extra) {
            self._setActiveContentMorph(lively.identity.WikiView.open(h, o, self._autoHeightOpts({
              target: $world,
              bounds: lively.rect(0, 0, self._contentWidth(), 780),
              openHistory: !!(extra && extra.openHistory),
              onEdit: function (h2, o2, v2, r2) { self._editExistingPage(h2, o2, r2); },
              onDeleted: function (h2, o2) { self._handlePageDeleted(o2); },
            })));
          },
        }));
        self._setActiveContentMorph(editor);
      },

      // "All pages" (sort-by menu): drops the open page/editor and goes back to the
      // wrapped grid of every page, with the left menu back on the page
      // list. A WikiEditor autosaves on a 2s debounce, so a pending save
      // is flushed first rather than left to a timer on a removed morph.
      _closeActivePage: function () {
        var view = this._activeContentMorph;
        if (!view) return;
        if (view._saveTimer && view._saveNow) view._saveNow();
        view.remove();
        this._activeContentMorph = null;
        this._closeSortByDropdown();
        this._showSidebarPageList("");
        if (this._sidebarSearchField) this._sidebarSearchField.textString = "";
        if (this._sidebarSearchPlaceholder) this._sidebarSearchPlaceholder.setVisible(true);
        this._layoutGrid();
        window.scrollTo(0, 0);
      },

      // Runs after WikiView's "Delete page" has permanently removed a page
      // server-side: drops the now-dead view from the content slot, refetches
      // the page list (rather than patching it locally, so the grid and the
      // categories/tags panel reflect exactly what the server has), and
      // returns the sidebar to the "all pages" list.
      _handlePageDeleted: function (objId) {
        var self = this;
        var view = this._activeContentMorph;
        if (view) view.remove();
        this._activeContentMorph = null;
        this._closeSortByDropdown();
        this._layoutGrid(); // back to the wrapped grid while the refetch runs
        this._pages = (this._pages || []).filter(function (p) { return p.objId !== objId; });
        this._fetchWikiIndexSilently(function () {
          self._renderCategoriesPanel();
          self._renderPages();
          self._showSidebarPageList("");
          if (self._sidebarSearchField) self._sidebarSearchField.textString = "";
          if (self._sidebarSearchPlaceholder) self._sidebarSearchPlaceholder.setVisible(true);
        });
      },

      // Both the read-only WikiView (existing page) and the editable
      // WikiEditor (newly-created page, see _createNewPage) end up pinned
      // in this same slot and expose getOutline() — this is the one place
      // that swap happens, so _openPage/_createNewPage don't need to know
      // about each other's shape.
      _setActiveContentMorph: function (morph) {
        if (this._activeContentMorph && this._activeContentMorph !== morph) {
          this._activeContentMorph.remove();
        }
        this._activeContentMorph = morph;
        // Behind everything else in the world, not in front: the page is the
        // backdrop, and a window the visitor opened earlier (git control, a
        // workspace, a dialog) belongs above it. WikiView.open / WikiEditor.openCard
        // have just added the morph at the top of the z-order, which would paint it
        // over any such window and hide it. The page never overlaps the other index
        // panels (_repositionWikiView lays it out below the grid), so order among
        // them does not matter.
        morph.sendToBack();
        // Opening/re-opening a page always lands the sidebar back on that
        // page's own outline — the home button (_showSidebarPageList) is
        // the only way to switch it into "all pages" mode from here.
        this._sidebarMode = "outline";
        // An open sort menu was built for the no-page state (no "All
        // pages" row); close it rather than leave it stale.
        this._closeSortByDropdown();
        if (this._sidebarSearchField) this._sidebarSearchField.textString = "";
        if (this._sidebarSearchPlaceholder) this._sidebarSearchPlaceholder.setVisible(true);
        this._renderSidebarOutline(morph);
        // The grid collapses to its one-row shelf now that a page is open.
        this._layoutGrid();
      },

      // Populates the "On this page" sidebar from the page's real rendered
      // headings (WikiView#getOutline) — clicking an entry scrolls that
      // exact heading element into view inside the WikiView's own
      // (overflow-y:auto) content area.
      _renderSidebarOutline: function (view) {
        this._sidebarOutline = (view && view.getOutline) ? view.getOutline() : [];
        if (this._sidebarHeader) this._sidebarHeader.setTextString("ON THIS PAGE");

        var box = this._sidebarBox;
        var outline = this._sidebarOutline;
        (box._itemMorphs || []).forEach(function (m) { m.remove(); });
        box._itemMorphs = [];
        var y = SIDEBAR_ITEMS_TOP;

        if (!outline.length) {
          var empty = lively.morphic.Text.makeLabel("No headings in this page.", {
            fontSize: 12, textColor: Color.rgb(170, 170, 170),
          });
          empty.setPosition(lively.pt(16, y));
          noDragTree(empty);
          box.addMorph(empty);
          box._itemMorphs.push(empty);
          y += 22;
        } else {
          var minLevel = Math.min.apply(null, outline.map(function (h) { return h.level; }));
          outline.forEach(function (h) {
            var indent = Math.min(3, h.level - minLevel) * 14;
            var item = new lively.morphic.Text(
              lively.rect(16 + indent, y, SIDEBAR_W - 32 - indent, 18),
              h.text || "(untitled heading)",
            );
            item.applyStyle({
              fontSize: h.level === minLevel ? 13 : 12,
              fontWeight: h.level === minLevel ? "600" : "400",
              textColor: Color.rgb(50, 50, 50), fill: null, borderWidth: 0, borderColor: null,
            });
            box.addMorph(item);
            // A TOC entry is meant to read as one line per heading (unlike
            // the topic-card titles above, which wrap on purpose) — force
            // single-line ellipsis truncation the same way those used to.
            var itemNode = item.renderContext().shapeNode;
            itemNode.style.cursor = "pointer";
            var itemDiv = itemNode.querySelector("div");
            if (itemDiv) {
              itemDiv.style.whiteSpace = "nowrap";
              itemDiv.style.overflow = "hidden";
              itemDiv.style.textOverflow = "ellipsis";
              // Explicit width: the ellipsis used to rely on the framework's
              // max-width on this div, which getTextExtentHTML (HTML.js)
              // strips for any non-"pre" text and never restores — one
              // measurement call and the names spilled out of the panel
              // (reproduced live with getTextExtent()).
              itemDiv.style.width = "calc(100% - 8px)";
            }
            noDragTree(item);
            item.onMouseDown = function () {
              if (h.el && h.el.scrollIntoView) h.el.scrollIntoView({ behavior: "smooth", block: "start" });
            };
            box._itemMorphs.push(item);
            y += 22;
          });
        }

        box.setExtent(lively.pt(SIDEBAR_W, y + 14));
        box.setVisible(!this._panelsHidden());
      },

      // Home button handler — switches the sidebar out of "this page's
      // outline" mode into a flat, searchable list of every wiki page in
      // this scope, filtered by `query` (also called live as the sidebar
      // search field is typed into). Reuses the same wikiName substring
      // match _renderPages uses for the top-of-page grid search.
      _showSidebarPageList: function (query) {
        this._sidebarMode = "list";
        this._renderSidebarPageList(query || "");
      },

      _renderSidebarPageList: function (query) {
        var self = this;
        this._sidebarListQuery = query || "";
        if (this._sidebarHeader) this._sidebarHeader.setTextString("ALL WIKI PAGES");

        var box = this._sidebarBox;
        (box._itemMorphs || []).forEach(function (m) { m.remove(); });
        box._itemMorphs = [];
        var y = SIDEBAR_ITEMS_TOP;

        var q = this._sidebarListQuery.toLowerCase();
        var pages = q
          ? this._pages.filter(function (p) { return (p.wikiName || "").toLowerCase().indexOf(q) !== -1; })
          : this._pages;

        if (!pages.length) {
          var empty = lively.morphic.Text.makeLabel(
            this._pages.length ? "No pages match “" + this._sidebarListQuery + "”." : "No wiki pages yet.",
            { fontSize: 12, textColor: Color.rgb(170, 170, 170) },
          );
          empty.setPosition(lively.pt(16, y));
          noDragTree(empty);
          box.addMorph(empty);
          box._itemMorphs.push(empty);
          y += 22;
        } else {
          pages.forEach(function (page) {
            var item = new lively.morphic.Text(
              lively.rect(16, y, SIDEBAR_W - 32, 18),
              page.wikiName,
            );
            item.applyStyle({
              fontSize: 13, fontWeight: "500", textColor: Color.rgb(50, 50, 50),
              fill: null, borderWidth: 0, borderColor: null,
            });
            box.addMorph(item);
            var itemNode = item.renderContext().shapeNode;
            itemNode.style.cursor = "pointer";
            var itemDiv = itemNode.querySelector("div");
            if (itemDiv) {
              itemDiv.style.whiteSpace = "nowrap";
              itemDiv.style.overflow = "hidden";
              itemDiv.style.textOverflow = "ellipsis";
              // Explicit width: the ellipsis used to rely on the framework's
              // max-width on this div, which getTextExtentHTML (HTML.js)
              // strips for any non-"pre" text and never restores — one
              // measurement call and the names spilled out of the panel
              // (reproduced live with getTextExtent()).
              itemDiv.style.width = "calc(100% - 8px)";
            }
            noDragTree(item);
            item.onMouseDown = function () { self._openPage(page); };
            box._itemMorphs.push(item);
            y += 22;
          });
        }

        box.setExtent(lively.pt(SIDEBAR_W, y + 14));
        box.setVisible(!this._panelsHidden());
      },

      // Wiki pages carry their author's DID only inside the envelope, not
      // in listWikiPages' summary rows — fetch the envelope once (reusing
      // the same read path every other constellation-scoped object uses),
      // then resolve that DID to a handle the same way WikiView.js's own
      // top-bar avatar does. Hands the already-fetched envelope back too
      // (thenDo(handle, envelope)) so _openPage can pass it straight to
      // WikiView.open as opts.envelope instead of making WikiView re-fetch
      // the exact same thing a moment later.
      // Personal scope already knows the owning handle (there's only ever
      // one — the scope's own handle), so this skips straight to the plain
      // /@handle/:objId read instead of the constellation path's DID
      // resolution dance.
      _resolveHandle: function (objId, thenDo) {
        if (this._scope.kind === "personal") return this._resolveHandlePersonal(objId, thenDo);
        var self = this;
        var base = lively.identity.did.baseUrl();
        var xhr = new XMLHttpRequest();
        xhr.open("GET", base + "/c/" + encodeURIComponent(this._scope.name) + "/" + encodeURIComponent(objId), true);
        xhr.withCredentials = true;
        xhr.setRequestHeader("Accept", "application/json");
        xhr.onload = function () {
          if (xhr.status !== 200) return thenDo(null, null);
          var envelope;
          try { envelope = JSON.parse(xhr.responseText); } catch (e) { return thenDo(null, null); }
          var did = envelope.did;
          if (!did) return thenDo(null, envelope);
          var qi = self._quickInfo || {};
          if (qi.memberHandles && qi.memberHandles[did]) return thenDo(qi.memberHandles[did], envelope);
          if (self._didHandleCache[did]) return thenDo(self._didHandleCache[did], envelope);
          var hxhr = new XMLHttpRequest();
          hxhr.open("GET", base + "/dids/handles?dids=" + encodeURIComponent(did), true);
          hxhr.withCredentials = true;
          hxhr.setRequestHeader("Accept", "application/json");
          hxhr.onload = function () {
            if (hxhr.status !== 200) return thenDo(null, envelope);
            try {
              var handle = (JSON.parse(hxhr.responseText).handles || {})[did] || null;
              if (handle) self._didHandleCache[did] = handle;
              thenDo(handle, envelope);
            } catch (e) { thenDo(null, envelope); }
          };
          hxhr.onerror = function () { thenDo(null, envelope); };
          hxhr.send();
        };
        xhr.onerror = function () { thenDo(null, null); };
        xhr.send();
      },

      _resolveHandlePersonal: function (objId, thenDo) {
        var handle = this._scope.handle;
        var base = lively.identity.did.baseUrl();
        var xhr = new XMLHttpRequest();
        xhr.open("GET", base + "/@" + encodeURIComponent(handle) + "/" + encodeURIComponent(objId), true);
        xhr.withCredentials = true;
        xhr.setRequestHeader("Accept", "application/json");
        xhr.onload = function () {
          if (xhr.status !== 200) return thenDo(null, null);
          var envelope;
          try { envelope = JSON.parse(xhr.responseText); } catch (e) { return thenDo(null, null); }
          thenDo(handle, envelope);
        };
        xhr.onerror = function () { thenDo(null, null); };
        xhr.send();
      },

      _formatDate: function (iso) {
        if (!iso) return "—";
        var d = new Date(iso);
        if (isNaN(d.getTime())) return String(iso);
        return d.toLocaleDateString();
      },

      // Opens the Title/Category/Tags dialog (replacing the old
      // window.prompt-only flow) and, on Create, embeds a brand-new
      // WikiEditor directly in-page — the same pinned-below-grid slot
      // _openPage's read-only WikiView uses (_setActiveContentMorph) —
      // instead of the old floating-window-plus-polling-for-completion
      // hack (_pollForWikiPage/_fetchWikiIndexSilently, both removed: the
      // editor is embedded synchronously now, so there's nothing to poll
      // for).
      _promptNewWikiPage: function () {
        var self = this;
        var user = lively.identity.did.currentUser();
        if (!user) return this._showError("Not signed in.");
        var scope = this._scope.kind === "personal"
          ? { handle: this._scope.handle }
          : { constellation: this._scope.name };
        lively.require("lively.identity.NewWikiPageDialog").toRun(function () {
          lively.identity.NewWikiPageDialog.open({
            scope: scope,
            onCreate: function (fields) { self._createNewPage(user.handle, fields); },
          });
        });
      },

      _createNewPage: function (handle, fields) {
        var self = this;
        lively.require("lively.identity.WikiEditor").toRun(function () {
          var w = self._contentWidth();
          var newCardOpts = {
            wikiName: fields.wikiName,
            category: fields.category,
            tags: fields.tags,
            // Who may edit (constellation pages; null/absent = all members).
            editPolicy: fields.editPolicy || null,
            bounds: lively.rect(0, 0, w, 780),
            // Added directly to $world (not a floating window) — the same
            // top-level-morph shape _openPage's read-only WikiView already
            // has, so _setActiveContentMorph/_repositionWikiView can
            // position either one identically via plain setPosition.
            target: $world,
            // Clicking Save (not autosave — see WikiEditor.js's _buildSaveControls)
            // swaps the editor for the same read-only WikiView _openPage
            // already uses to display an existing page, so a freshly-created
            // page ends up presented exactly like any other once you're done
            // with it, rather than staying in edit mode indefinitely.
            onSaved: function (savedHandle, objId) {
              var opts2 = self._autoHeightOpts({ bounds: lively.rect(0, 0, w, 780) });
              opts2.onDeleted = function (h2, o2) { self._handlePageDeleted(o2); };
              self._setActiveContentMorph(lively.identity.WikiView.open(savedHandle, objId, opts2));
            },
          };
          self._autoHeightOpts(newCardOpts);
          if (self._scope.kind === "constellation") newCardOpts.constellation = self._scope.name;

          var editor = lively.identity.WikiEditor.newCard(handle, newCardOpts);
          self._setActiveContentMorph(editor);
          // this._pages is refreshed (silently, not re-rendering the grid
          // mid-edit) once the genesis autosave lands, so the new card
          // appears in the grid without a manual reload — independent of
          // onSaved above, which only fires on an explicit Save click and
          // handles swapping the open view, not the grid card.
          self._pollForFirstSave(editor, fields.wikiName, 0);
        });
      },

      _pollForFirstSave: function (editor, wikiName, attempt) {
        var self = this;
        if (attempt >= 20) return;
        setTimeout(function () {
          if (editor._objId) {
            self._fetchWikiIndexSilently(function () {
              var found = self._pages.some(function (p) { return p.wikiName === wikiName; });
              if (found) {
                self._renderCategoriesPanel();
                self._renderPages();
              }
            });
            return;
          }
          self._pollForFirstSave(editor, wikiName, attempt + 1);
        }, 500);
      },

      _fetchWikiIndexSilently: function (thenDo) {
        var self = this;
        var base = lively.identity.did.baseUrl();
        var url = this._scope.kind === "personal"
          ? base + "/@" + encodeURIComponent(this._scope.handle) + "/wiki"
          : base + "/c/" + encodeURIComponent(this._scope.name) + "/wiki";
        var xhr = new XMLHttpRequest();
        xhr.open("GET", url, true);
        xhr.withCredentials = true;
        xhr.setRequestHeader("Accept", "application/json");
        xhr.onload = function () {
          if (xhr.status === 200) {
            try { self._pages = JSON.parse(xhr.responseText).pages || self._pages; } catch (e) {}
          }
          thenDo();
        };
        xhr.onerror = function () { thenDo(); };
        xhr.send();
      },
    },

    // ─── menu bar ───────────────────────────────────────────────────────────────

    "menu bar", {
      _installMenuBarEntry: function () {
        var self = this;
        var attempts = 0;
        (function tryInstall() {
          var entry = null;
          var menuBar = typeof $world !== "undefined" && $world && $world.get(/^MenuBar/);
          if (menuBar) {
            entry = (menuBar.submorphs || []).find(function (m) { return m.name === "WorldNameMenuBarEntry"; });
          }
          if (entry) return self._patchMenuBarEntry(entry);
          if (++attempts > 25) return;
          setTimeout(tryInstall, 200);
        })();
      },

      _patchMenuBarEntry: function (entry) {
        var self = this;
        var isPersonal = this._scope.kind === "personal";
        var label = isPersonal ? "@" + this._shownHandle() + " wiki" : "c/" + this._shownName() + " wiki";
        var backHref = isPersonal
          ? "/@" + encodeURIComponent(this._shownHandle())
          : "/c/" + encodeURIComponent(this._shownName());
        var tooltip = isPersonal
          ? "@" + this._shownHandle() + " — back to your homestar"
          : "Constellation " + this._shownName() + " — back to c/" + this._shownName();
        entry.currentWorldDisplayName = function () { return label; };
        entry.toolTip = tooltip;
        entry.onMouseUp = function (evt) {
          window.location.href = backHref;
          evt.stop();
          return true;
        };
        entry.update();
      },

      _showError: function (msg) {
        console.error("[WikiIndex]", msg);
      },
    });

    // Static open helpers — construct a fresh controller bound to $world.
    // Callers (buildWikiIndexPage's/buildPersonalWikiIndexPage's
    // onStartWorld hooks) are expected to only call these once $world
    // already exists.
    lively.identity.WikiIndex = {
      open: function (name) {
        var controller = new lively.identity.WikiIndexController();
        controller.open(name);
        return controller;
      },
      openPersonal: function (handle) {
        var controller = new lively.identity.WikiIndexController();
        controller.openPersonal(handle);
        return controller;
      },
    };

  });
