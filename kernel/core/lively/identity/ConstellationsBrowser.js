/**
 * lively.identity.ConstellationsBrowser
 *
 * Tabbed browser for constellations:
 *
 *   My Constellations — every constellation the caller is a member of at
 *                        all (GET /@:handle/constellations), including ones
 *                        they merely joined, not just ones they created.
 *   Co-Creator         — the subset of the above where the caller is a
 *                        creator or moderator (role !== 'member'), badged
 *                        the same green/yellow as ConstellationLounge.js's
 *                        own member list.
 *   Discover           — the public network directory (GET /c), with three
 *                        sort sub-tabs: Popular (member count), Active
 *                        (live postcard count), New (created_at).
 *
 * A persistent search box filters whichever tab is active — client-side
 * substring filter over the cached membership list for the first two tabs,
 * a real `?q=` round trip to GET /c for Discover. "+ Create" replaces the
 * content pane with a small wizard (choice cards -> name form), the same
 * "Create new" flow WorldsBrowser.js uses for its own Blank world/Wiki
 * page/Template picker, rather than the old always-crammed small floating
 * panel with name+visibility+button all visible at once. The wizard builds
 * the signed genesis-objId creation payload IdentityServer.js's POST
 * /c/:name requires (same crypto/signing logic this file always had,
 * untouched by this redesign).
 *
 * Rebuilt as a lively.morphic.Box.subclass rendering its content as plain
 * DOM/CSS (rather than the previous lively.BuildSpec morphic-Text/Box
 * tree), framed by a real classic lively.morphic.Window via openInWindow()
 * — same convention PostCardMailbox.js/FilesBrowser.js/CalendarApp.js
 * already moved to for their own "modern card/pill UI" redesigns.
 *
 * Entry point: lively.identity.ConstellationsBrowser.open()
 */

module("lively.identity.ConstellationsBrowser")
  .requires(
    "lively.identity.DID",
    "lively.identity.WebKey",
    "lively.identity.WebAuthn",
    "lively.morphic.Complete",
  )
  .toRun(function () {

    // Modern content design system for the tab bar / search / cards /
    // buttons / badges — injected once per world (idempotent, same guard
    // idiom PostCardMailbox.js's _ensureMailboxContentStyle uses).
    // Everything is scoped under `.cxb-root` (added to this morph's own
    // shapeNode in _buildChrome) so it can't leak onto unrelated DOM
    // elsewhere in the world.
    function _ensureConstellationsBrowserStyle() {
      var STYLE_ID = "constellations-browser-content-style";
      if (document.getElementById(STYLE_ID)) return;
      var styleEl = document.createElement("style");
      styleEl.id = STYLE_ID;
      styleEl.textContent = [
        ".cxb-root {",
        "  --cxb-bg: #fafafa; --cxb-surface: #ffffff;",
        // Darker than the original tokens (#e4e4e7/#d4d4d8/#52525b/#a1a1aa) —
        // the light-gray borders and secondary/tertiary text read as
        // faint/washed-out against the white surface, especially at this
        // panel's small (11-13px) font sizes. Bumped for legibility.
        "  --cxb-border: #d8d8dd; --cxb-border-strong: #b0b0ba;",
        "  --cxb-text: #18181b; --cxb-text-secondary: #3f3f46; --cxb-text-tertiary: #71717a;",
        "  --cxb-accent: #673ab7; --cxb-accent-soft: #f3effc; --cxb-accent-soft-border: #d9cbf0;",
        "  --cxb-danger: #e11d48; --cxb-danger-soft: #fff1f2; --cxb-danger-soft-border: #fecdd3;",
        "  --cxb-creator: #2e7d32; --cxb-creator-soft: #e8f5e9;",
        "  --cxb-mod: #8a6d00; --cxb-mod-soft: #fff8e1;",
        "  --cxb-radius: 12px; --cxb-radius-sm: 8px; --cxb-radius-pill: 999px;",
        "  --cxb-shadow-card: 0 1px 2px rgba(24,24,27,0.04), 0 1px 8px rgba(24,24,27,0.04);",
        "  --cxb-shadow-card-hover: 0 2px 6px rgba(24,24,27,0.06), 0 4px 16px rgba(24,24,27,0.08);",
        "  --cxb-font: -apple-system, BlinkMacSystemFont, 'Segoe UI', Inter, Roboto, Helvetica, Arial, sans-serif;",
        // Baseline weight for anything that doesn't set its own — plain
        // browser-default (400) text at these sizes/colors was part of the
        // same faint/faded look; every element below that wants EXTRA
        // emphasis still sets its own heavier font-weight and overrides this.
        "  font-family: var(--cxb-font); font-weight: 500;",
        "}",
        ".cxb-content::-webkit-scrollbar { width: 9px; height: 9px; }",
        ".cxb-content::-webkit-scrollbar-thumb { background: var(--cxb-border-strong); border-radius: 5px; border: 2px solid var(--cxb-bg); }",
        ".cxb-content::-webkit-scrollbar-track { background: transparent; }",

        ".cxb-tabbar { display: flex; align-items: center; gap: 2px; overflow-x: auto; scrollbar-width: none; height: 100%; }",
        ".cxb-tabbar::-webkit-scrollbar { display: none; }",
        ".cxb-tab { display: flex; align-items: center; gap: 4px; flex: none; border: none; background: transparent;",
        "  cursor: pointer; font-size: 12px; font-weight: 500; color: var(--cxb-text-secondary);",
        "  padding: 7px 9px; border-radius: var(--cxb-radius-pill); white-space: nowrap;",
        "  font-family: var(--cxb-font); transition: background .15s, color .15s; }",
        ".cxb-tab-icon { font-family: 'Material Symbols Rounded'; font-size: 15px; line-height: 1; }",
        ".cxb-tab:hover { background: var(--cxb-bg); color: var(--cxb-text); }",
        ".cxb-tab.active { background: var(--cxb-accent-soft); color: var(--cxb-accent); font-weight: 600; }",

        ".cxb-subtab { border: 1px solid var(--cxb-border); background: var(--cxb-surface);",
        "  color: var(--cxb-text-secondary); font-size: 11px; font-weight: 500; padding: 4px 10px;",
        "  border-radius: var(--cxb-radius-pill); cursor: pointer; font-family: var(--cxb-font);",
        "  margin-right: 6px; transition: background .15s, color .15s, border-color .15s; }",
        ".cxb-subtab:hover { background: var(--cxb-bg); }",
        ".cxb-subtab.active { background: var(--cxb-accent); color: #fff; border-color: var(--cxb-accent); }",

        ".cxb-search { display: flex; align-items: center; gap: 8px; background: var(--cxb-bg);",
        "  border-radius: var(--cxb-radius-sm); padding: 0 10px; flex: 1; }",
        ".cxb-search-icon { font-family: 'Material Symbols Rounded'; font-size: 16px; color: var(--cxb-text-tertiary); }",
        ".cxb-search input { flex: 1; border: none; background: transparent; outline: none;",
        "  font-size: 12.5px; padding: 8px 0; color: var(--cxb-text); font-family: var(--cxb-font); }",
        ".cxb-search input::placeholder { color: var(--cxb-text-tertiary); }",

        ".cxb-card { background: var(--cxb-surface); border: 1px solid var(--cxb-border);",
        "  border-radius: var(--cxb-radius); padding: 12px 14px; margin-bottom: 8px; position: relative;",
        "  box-shadow: var(--cxb-shadow-card); transition: box-shadow .15s, border-color .15s; cursor: pointer; }",
        ".cxb-card:hover { box-shadow: var(--cxb-shadow-card-hover); border-color: var(--cxb-border-strong); }",
        ".cxb-card-name { font-weight: 600; font-size: 13px; color: var(--cxb-text); margin-bottom: 4px; }",
        ".cxb-card-meta { display: flex; align-items: center; gap: 10px; font-size: 11px; color: var(--cxb-text-tertiary); }",
        ".cxb-card-meta-icon { font-family: 'Material Symbols Rounded'; font-size: 13px; vertical-align: -2px; margin-right: 2px; }",

        ".cxb-empty { display: flex; flex-direction: column; align-items: center; justify-content: center;",
        "  gap: 8px; color: var(--cxb-text-tertiary); padding: 48px 16px; text-align: center; font-size: 12.5px; }",
        ".cxb-empty-icon { font-family: 'Material Symbols Rounded'; font-size: 32px; color: var(--cxb-border-strong); }",
        ".cxb-empty.danger { color: var(--cxb-danger); }",
        ".cxb-empty.danger .cxb-empty-icon { color: var(--cxb-danger); }",

        ".cxb-btn { display: inline-flex; align-items: center; gap: 4px; font-size: 11.5px; font-weight: 500;",
        "  padding: 5px 11px; cursor: pointer; border-radius: var(--cxb-radius-pill); border: 1px solid var(--cxb-border);",
        "  background: var(--cxb-surface); color: var(--cxb-text-secondary); font-family: var(--cxb-font);",
        "  transition: background .15s, border-color .15s, color .15s; white-space: nowrap; }",
        ".cxb-btn:hover { background: var(--cxb-bg); }",
        ".cxb-btn:disabled { opacity: .5; cursor: default; }",
        ".cxb-btn-icon-glyph { font-family: 'Material Symbols Rounded'; font-size: 13px; line-height: 1; }",
        ".cxb-btn-accent { border-color: var(--cxb-accent-soft-border); color: var(--cxb-accent); background: var(--cxb-accent-soft); }",
        ".cxb-btn-accent:hover { background: var(--cxb-accent-soft-border); }",

        ".cxb-badge { display: inline-block; padding: 2px 8px; font-size: 10px; font-weight: 600;",
        "  border-radius: var(--cxb-radius-pill); background: var(--cxb-creator-soft); color: var(--cxb-creator); }",
        ".cxb-badge-mod { background: var(--cxb-mod-soft); color: var(--cxb-mod); }",

        // Full-pane create wizard (replaces _contentDiv, same idiom
        // WorldsBrowser.js's showCreatePicker/showCreateForm use for "Create
        // new world" — a back link + header over either a list of choice
        // cards or a name form, instead of the old always-crammed small
        // floating panel with name+visibility+button all visible at once).
        ".cxb-create-back { display: inline-flex; align-items: center; gap: 2px; font-size: 12px;",
        "  font-weight: 500; color: var(--cxb-accent); cursor: pointer; margin-bottom: 14px; }",
        ".cxb-create-back:hover { text-decoration: underline; }",
        ".cxb-create-header { font-size: 15px; font-weight: 700; color: var(--cxb-text); margin-bottom: 14px; }",
        ".cxb-create-list { display: flex; flex-direction: column; gap: 8px; }",
        ".cxb-create-row { display: flex; align-items: center; gap: 12px; background: var(--cxb-surface);",
        "  border: 1px solid var(--cxb-border); border-radius: var(--cxb-radius); padding: 14px; cursor: pointer;",
        "  box-shadow: var(--cxb-shadow-card); transition: box-shadow .15s, border-color .15s; }",
        ".cxb-create-row:hover { box-shadow: var(--cxb-shadow-card-hover); border-color: var(--cxb-border-strong); }",
        ".cxb-create-row-icon { font-family: 'Material Symbols Rounded'; font-size: 22px; color: var(--cxb-accent); flex: none; }",
        ".cxb-create-row-title { font-size: 13px; font-weight: 600; color: var(--cxb-text); }",
        ".cxb-create-row-subtitle { font-size: 11.5px; color: var(--cxb-text-tertiary); margin-top: 2px; }",
        ".cxb-create-label { font-size: 11px; font-weight: 600; color: var(--cxb-text-secondary); margin-bottom: 6px; }",
        ".cxb-create-name-input { width: 100%; box-sizing: border-box; font-size: 13px; padding: 9px 11px;",
        "  border: 1px solid var(--cxb-border); border-radius: var(--cxb-radius-sm); font-family: var(--cxb-font);",
        "  outline: none; margin-bottom: 14px; }",
        ".cxb-create-name-input:focus { border-color: var(--cxb-accent); }",
        ".cxb-create-submit-row { display: flex; align-items: center; gap: 12px; }",
        ".cxb-create-status { font-size: 11px; color: var(--cxb-text-tertiary); }",
        ".cxb-create-status.danger { color: var(--cxb-danger); }",
      ].join("\n");
      document.head.appendChild(styleEl);
    }

    // Two contrast/focus-ring bugs base_theme.css's default (light-chrome-
    // tuned) rules leave unfixed on a saturated-color accent window — same
    // fix DMChat.js's applyAccentChrome/PostCardMailbox.js's
    // _ensureAccentChromeCss already apply for their own accents (see
    // CLAUDE.md's applyStyle-DOM-sync gotcha for why this is a CSS class
    // rather than a setFill/applyStyle call).
    function _ensureAccentChromeCss() {
      var STYLE_ID = "constellations-browser-accent-chrome-style";
      if (document.getElementById(STYLE_ID)) return;
      var styleEl = document.createElement("style");
      styleEl.id = STYLE_ID;
      styleEl.textContent = [
        ".Window.cxb-accent-chrome { background-color: #673ab7 !important; }",
        ".Window.cxb-accent-chrome .Text.window-title { color: #fff; }",
        ".Window.cxb-accent-chrome.highlighted .Text.window-title { color: #fff; font-weight: bold; }",
        ".Window.cxb-accent-chrome.highlighted { border: none !important; box-shadow: 0px 3px 10px rgba(40,20,70,0.35) !important; }",
      ].join("\n");
      document.head.appendChild(styleEl);
    }

    var ConstellationsBrowserClass = lively.morphic.Box.subclass("lively.identity.ConstellationsBrowser",

    "serialization", {
      doNotSerialize: [
        "_contentDiv", "_tabBtns", "_subtabBtns", "_subtabWrap", "_searchInput", "_searchBarWrap",
        "_createNameInput", "_createStatusEl", "_membership",
        "_contentLoadStarted",
      ],
    },

    "initialization", {

      initialize: function ($super, bounds) {
        $super(bounds);
        this._activeTab = "mine";
        this._discoverSort = "recent";
        this._searchQuery = "";
        this._visibility = "public";
        this._inCreateFlow = false;
        this._membership = null;
        this._contentDiv = null;
        this._tabBtns = {};
        this._subtabBtns = {};
        this._buildChrome();
        // Guards prepareForNewRenderContext below against redundantly
        // re-rendering once this constructor returns and open() attaches
        // the new instance to the world — same mechanism/reason as
        // PostCardMailbox.js's initialize/prepareForNewRenderContext pair.
        this._contentLoadStarted = true;
        this._switchTab("mine");
      },

      // $super(bounds) above (Morph.initialize) calls
      // prepareForNewRenderContext the first time, before _activeTab exists
      // yet — the guard below skips that call, leaving this constructor's
      // own _buildChrome()/_switchTab() as the only build on fresh
      // construction. On a world-reload restore, _activeTab already has its
      // serialized value but none of the DOM _buildChrome built does, so it
      // re-runs here instead. It also fires as an immediate same-turn
      // duplicate of the constructor's own call (open() attaches this
      // freshly-constructed morph to the world right after construction) —
      // _contentLoadStarted (doNotSerialize'd) guards against double-firing
      // the render in that case, same as PostCardMailbox.js.
      prepareForNewRenderContext: function ($super, renderCtx) {
        $super(renderCtx);
        if (!this._activeTab) return;
        var tab = this._activeTab;
        this._tabBtns = {};
        this._subtabBtns = {};
        this._buildChrome();
        if (this._contentLoadStarted) return;
        this._contentLoadStarted = true;
        this._switchTab(tab);
      },

      _buildChrome: function () {
        var self = this;
        _ensureConstellationsBrowserStyle();
        this.setFill(Color.white);
        this.setDroppingEnabled(false);
        var shapeNode = this.renderContext().shapeNode;
        shapeNode.innerHTML = ""; // idempotent: safe if this ever runs twice on one instance
        shapeNode.classList.add("cxb-root");

        // ── tab bar ──
        var tabBarWrap = document.createElement("div");
        tabBarWrap.style.cssText = [
          "position:absolute", "top:0", "left:0", "right:0", "height:44px",
          "border-bottom:1px solid var(--cxb-border)", "background:var(--cxb-surface)",
          "display:flex", "align-items:center",
          "box-sizing:border-box", "padding:0 8px",
        ].join(";");
        var tabBar = document.createElement("div");
        tabBar.className = "cxb-tabbar";
        var tabs = [
          { id: "mine",      label: "My Constellations", icon: "hub" },
          { id: "coCreator", label: "Co-Creator",         icon: "verified" },
          { id: "discover",  label: "Discover",           icon: "explore" },
        ];
        tabs.forEach(function (t) {
          var btn = document.createElement("button");
          btn.className = "cxb-tab";
          var icon = document.createElement("span");
          icon.className = "cxb-tab-icon";
          icon.textContent = t.icon;
          btn.appendChild(icon);
          btn.appendChild(document.createTextNode(t.label));
          btn.addEventListener("click", function () { self._switchTab(t.id); });
          tabBar.appendChild(btn);
          self._tabBtns[t.id] = btn;
        });

        // Right next to Discover, in the same scrolling tab row — not
        // pushed off to the far right edge of the window (the previous
        // space-between layout).
        var createBtn = document.createElement("button");
        createBtn.className = "cxb-btn cxb-btn-accent";
        createBtn.style.marginLeft = "8px";
        createBtn.innerHTML = "<span class=\"cxb-btn-icon-glyph\">add</span>Create";
        createBtn.addEventListener("click", function () { self._showCreatePicker(); });
        tabBar.appendChild(createBtn);

        tabBarWrap.appendChild(tabBar);
        shapeNode.appendChild(tabBarWrap);

        // ── search bar ──
        var searchBarWrap = document.createElement("div");
        searchBarWrap.style.cssText = [
          "position:absolute", "top:44px", "left:0", "right:0", "height:40px",
          "background:var(--cxb-surface)", "border-bottom:1px solid var(--cxb-border)",
          "display:flex", "align-items:center", "padding:0 12px", "box-sizing:border-box",
        ].join(";");
        var searchBar = document.createElement("div");
        searchBar.className = "cxb-search";
        var searchIcon = document.createElement("span");
        searchIcon.className = "cxb-search-icon";
        searchIcon.textContent = "search";
        searchBar.appendChild(searchIcon);
        var searchInput = document.createElement("input");
        searchInput.type = "text";
        searchInput.placeholder = "Search constellations…";
        var searchDebounce = null;
        searchInput.addEventListener("input", function () {
          clearTimeout(searchDebounce);
          searchDebounce = setTimeout(function () {
            self._searchQuery = searchInput.value.trim();
            self._reloadActiveTab();
          }, 300);
        });
        searchBar.appendChild(searchInput);
        searchBarWrap.appendChild(searchBar);
        shapeNode.appendChild(searchBarWrap);
        this._searchInput = searchInput;
        this._searchBarWrap = searchBarWrap;

        // ── Discover-only sort sub-tabs — shown only while the Discover
        // tab is active (see _switchTab), per-section rather than a single
        // sort dropdown.
        var subtabWrap = document.createElement("div");
        subtabWrap.style.cssText = [
          "position:absolute", "top:84px", "left:0", "right:0", "height:36px",
          "background:var(--cxb-bg)", "border-bottom:1px solid var(--cxb-border)",
          "display:none", "align-items:center", "padding:0 12px", "box-sizing:border-box",
        ].join(";");
        [["popular", "Popular"], ["active", "Active"], ["recent", "New"]].forEach(function (pair) {
          var sb = document.createElement("button");
          sb.className = "cxb-subtab" + (pair[0] === self._discoverSort ? " active" : "");
          sb.textContent = pair[1];
          sb.addEventListener("click", function () { self._switchDiscoverSort(pair[0]); });
          subtabWrap.appendChild(sb);
          self._subtabBtns[pair[0]] = sb;
        });
        shapeNode.appendChild(subtabWrap);
        this._subtabWrap = subtabWrap;

        // ── content area ──
        var contentDiv = document.createElement("div");
        contentDiv.className = "cxb-content";
        contentDiv.style.cssText = [
          "position:absolute", "left:0", "right:0", "bottom:0",
          "overflow-y:auto", "padding:12px 16px", "box-sizing:border-box",
          "font-family:var(--cxb-font)", "font-size:13px", "background:var(--cxb-bg)",
        ].join(";");
        shapeNode.appendChild(contentDiv);
        this._contentDiv = contentDiv;
        this._updateContentTop();
      },

      // While the create wizard is showing, the search bar and (if it was
      // visible) the Discover sort sub-tabs are hidden — both are
      // irrelevant to "name a new constellation" and just add clutter —
      // and the content pane starts right under the tab bar instead of
      // below them.
      _updateContentTop: function () {
        if (this._inCreateFlow) { this._contentDiv.style.top = "44px"; return; }
        this._contentDiv.style.top = (this._activeTab === "discover" ? 120 : 84) + "px";
      },
    },

    "tabs", {

      _switchTab: function (tab) {
        var self = this;
        this._activeTab = tab;
        this._inCreateFlow = false;
        if (this._searchBarWrap) this._searchBarWrap.style.display = "flex";
        Object.keys(this._tabBtns).forEach(function (id) {
          self._tabBtns[id].classList.toggle("active", id === tab);
        });
        // Fresh search per tab — a query typed into one tab silently
        // carrying into an unrelated one would be more confusing than
        // having to retype it (same convention PostCardMailbox.js uses).
        this._searchQuery = "";
        if (this._searchInput) this._searchInput.value = "";
        this._subtabWrap.style.display = tab === "discover" ? "flex" : "none";
        this._updateContentTop();
        this._reloadActiveTab();
      },

      _switchDiscoverSort: function (sort) {
        var self = this;
        this._discoverSort = sort;
        Object.keys(this._subtabBtns).forEach(function (id) {
          self._subtabBtns[id].classList.toggle("active", id === sort);
        });
        this._renderDiscover();
      },

      _reloadActiveTab: function () {
        if (this._activeTab === "mine") this._renderMine();
        else if (this._activeTab === "coCreator") this._renderCoCreator();
        else if (this._activeTab === "discover") this._renderDiscover();
      },
    },

    "data fetching", {

      // Loads (and caches) every constellation the caller belongs to —
      // shared by the My Constellations and Co-Creator tabs, since both are
      // just different filters over the same underlying list. Re-fetched
      // after a successful create so a brand-new constellation appears
      // immediately if the browser is ever left open across that.
      _loadMembership: function (cb) {
        var self = this;
        if (this._membership) return cb(null, this._membership);
        var user = lively.identity.did.currentUser();
        if (!user) return cb(new Error("Not signed in."));
        var base = lively.identity.did.baseUrl();
        var xhr = new XMLHttpRequest();
        xhr.open("GET", base + "/@" + encodeURIComponent(user.handle) + "/constellations", true);
        xhr.withCredentials = true;
        xhr.onload = function () {
          if (xhr.status !== 200) return cb(new Error("Failed to load (" + xhr.status + ")"));
          try {
            var data = JSON.parse(xhr.responseText);
            self._membership = data.constellations || [];
            cb(null, self._membership);
          } catch (e) { cb(e); }
        };
        xhr.onerror = function () { cb(new Error("Network error")); };
        xhr.send();
      },

      _renderMine: function () {
        var self = this;
        this._contentDiv.innerHTML = this._emptyHtml("hourglass_top", "Loading…");
        this._loadMembership(function (err, list) {
          if (err) return self._showError(err.message || "Could not load your constellations.");
          if (self._activeTab !== "mine") return; // tab changed while in flight
          self._renderConstellationList(self._filterBySearch(list), "hub", "You're not a member of any constellations yet.");
        });
      },

      _renderCoCreator: function () {
        var self = this;
        this._contentDiv.innerHTML = this._emptyHtml("hourglass_top", "Loading…");
        this._loadMembership(function (err, list) {
          if (err) return self._showError(err.message || "Could not load your constellations.");
          if (self._activeTab !== "coCreator") return;
          var filtered = list.filter(function (c) { return c.role !== "member"; });
          self._renderConstellationList(self._filterBySearch(filtered), "verified", "You're not a co-creator or moderator of any constellations yet.");
        });
      },

      _filterBySearch: function (list) {
        var q = this._searchQuery.toLowerCase();
        if (!q) return list;
        return list.filter(function (c) { return c.name.toLowerCase().indexOf(q) !== -1; });
      },

      _renderDiscover: function () {
        var self = this;
        this._contentDiv.innerHTML = this._emptyHtml("hourglass_top", "Loading…");
        var base = lively.identity.did.baseUrl();
        var url = base + "/c?limit=50&sort=" + encodeURIComponent(this._discoverSort);
        if (this._searchQuery) url += "&q=" + encodeURIComponent(this._searchQuery);
        var xhr = new XMLHttpRequest();
        xhr.open("GET", url, true);
        xhr.withCredentials = true;
        xhr.onload = function () {
          if (self._activeTab !== "discover") return;
          if (xhr.status !== 200) return self._showError("Failed to load (" + xhr.status + ")");
          try {
            var data = JSON.parse(xhr.responseText);
            self._renderConstellationList(data.constellations || [], "explore", "No public constellations found.");
          } catch (e) { self._showError("Bad response from server."); }
        };
        xhr.onerror = function () { if (self._activeTab === "discover") self._showError("Network error"); };
        xhr.send();
      },

      // Shared card renderer for all three tabs. `list` entries carry
      // `role` (mine/coCreator tabs only) and/or `postcardCount` (discover,
      // active sort only) — both are simply absent/undefined otherwise, so
      // this one function covers every tab without a tab-specific branch.
      _renderConstellationList: function (list, emptyIcon, emptyMsg) {
        var self = this;
        var content = this._contentDiv;
        content.innerHTML = "";
        if (!list.length) {
          if (this._searchQuery) {
            content.appendChild(this._emptyEl("search_off", "No constellations match your search."));
          } else {
            content.appendChild(this._emptyEl(emptyIcon, emptyMsg));
          }
          return;
        }
        list.forEach(function (c) {
          var card = self._makeCard();

          var name = document.createElement("div");
          name.className = "cxb-card-name";
          name.textContent = c.name;
          card.appendChild(name);

          if (c.role === "creator") {
            var b = document.createElement("span");
            b.className = "cxb-badge";
            b.style.marginBottom = "6px";
            b.textContent = "Co-creator";
            card.insertBefore(b, name);
            name.style.marginTop = "4px";
          } else if (c.role === "moderator") {
            var b2 = document.createElement("span");
            b2.className = "cxb-badge cxb-badge-mod";
            b2.style.marginBottom = "6px";
            b2.textContent = "Moderator";
            card.insertBefore(b2, name);
            name.style.marginTop = "4px";
          }

          var meta = document.createElement("div");
          meta.className = "cxb-card-meta";
          var memberSpan = document.createElement("span");
          memberSpan.innerHTML = "<span class=\"cxb-card-meta-icon\">group</span>" +
            c.memberCount + " member" + (c.memberCount === 1 ? "" : "s");
          meta.appendChild(memberSpan);
          if (typeof c.postcardCount === "number") {
            var pcSpan = document.createElement("span");
            pcSpan.innerHTML = "<span class=\"cxb-card-meta-icon\">mail</span>" +
              c.postcardCount + " postcard" + (c.postcardCount === 1 ? "" : "s");
            meta.appendChild(pcSpan);
          }
          if (c.visibility === "private") {
            var visSpan = document.createElement("span");
            visSpan.innerHTML = "<span class=\"cxb-card-meta-icon\">lock</span>Private";
            meta.appendChild(visSpan);
          }
          card.appendChild(meta);

          card.addEventListener("click", function () {
            window.location.href = "/c/" + encodeURIComponent(c.name);
          });
          content.appendChild(card);
        });
      },
    },

    "create wizard", {

      // Step 1: a full-pane choice screen (two cards: Public / Private) —
      // same "Create new" -> choice-cards -> name-form shape as
      // WorldsBrowser.js's showCreatePicker/showCreateForm, in place of the
      // old design's single small floating panel that showed the name
      // field, both visibility buttons, and the Create button all at once.
      _showCreatePicker: function () {
        var self = this;
        this._inCreateFlow = true;
        this._searchBarWrap.style.display = "none";
        this._subtabWrap.style.display = "none";
        this._updateContentTop();

        var content = this._contentDiv;
        content.innerHTML = "";

        var backLink = document.createElement("div");
        backLink.className = "cxb-create-back";
        backLink.textContent = "← Back";
        backLink.addEventListener("click", function () { self._exitCreateFlow(); });
        content.appendChild(backLink);

        var header = document.createElement("div");
        header.className = "cxb-create-header";
        header.textContent = "Create new constellation";
        content.appendChild(header);

        var list = document.createElement("div");
        list.className = "cxb-create-list";
        content.appendChild(list);

        [
          { icon: "public", title: "Public", subtitle: "Anyone can find and join.", vis: "public" },
          { icon: "lock", title: "Private", subtitle: "Only people you invite can join.", vis: "private" },
        ].forEach(function (opt) {
          var row = self._buildCreateChoiceRow(opt.icon, opt.title, opt.subtitle);
          row.addEventListener("click", function () { self._showCreateForm(opt.vis); });
          list.appendChild(row);
        });
      },

      _buildCreateChoiceRow: function (icon, title, subtitle) {
        var row = document.createElement("div");
        row.className = "cxb-create-row";
        row.innerHTML =
          "<span class=\"cxb-create-row-icon\">" + icon + "</span>" +
          "<div>" +
            "<div class=\"cxb-create-row-title\">" + title + "</div>" +
            "<div class=\"cxb-create-row-subtitle\">" + subtitle + "</div>" +
          "</div>";
        return row;
      },

      // Step 2: name form for the visibility chosen in step 1. The actual
      // signed genesis-objId creation logic (createConstellation, in the
      // 'creation' category below) is unchanged from before this redesign
      // — this only rebuilds the surrounding chrome.
      _showCreateForm: function (visibility) {
        var self = this;
        this._visibility = visibility;

        var content = this._contentDiv;
        content.innerHTML = "";

        var backLink = document.createElement("div");
        backLink.className = "cxb-create-back";
        backLink.textContent = "← Back";
        backLink.addEventListener("click", function () { self._showCreatePicker(); });
        content.appendChild(backLink);

        var header = document.createElement("div");
        header.className = "cxb-create-header";
        header.textContent = "New " + visibility + " constellation";
        content.appendChild(header);

        var label = document.createElement("div");
        label.className = "cxb-create-label";
        label.textContent = "Name";
        content.appendChild(label);

        var nameInput = document.createElement("input");
        nameInput.type = "text";
        nameInput.className = "cxb-create-name-input";
        nameInput.placeholder = "lowercase-letters-digits-hyphens";
        content.appendChild(nameInput);
        this._createNameInput = nameInput;

        var submitRow = document.createElement("div");
        submitRow.className = "cxb-create-submit-row";

        var createSubmitBtn = document.createElement("button");
        createSubmitBtn.className = "cxb-btn cxb-btn-accent";
        createSubmitBtn.textContent = "Create";
        createSubmitBtn.addEventListener("click", function () { self.createConstellation(); });
        submitRow.appendChild(createSubmitBtn);

        var statusEl = document.createElement("span");
        statusEl.className = "cxb-create-status";
        submitRow.appendChild(statusEl);
        this._createStatusEl = statusEl;

        content.appendChild(submitRow);
        nameInput.focus();
      },

      // Re-runs _switchTab for whichever tab was active before the wizard
      // was opened — restores the search bar/sub-tabs/content-top chrome
      // the wizard hid, and reloads that tab's list, in one step.
      _exitCreateFlow: function () {
        this._switchTab(this._activeTab);
      },
    },

    "creation", {

      // did:web spec: a port in the host becomes %3A<port>, not a literal
      // ':' (colons already separate the method-specific-id's own segments).
      _didWebForConstellation: function _didWebForConstellation(name) {
        var host = location.hostname + (location.port ? ("%3A" + location.port) : "");
        return "did:web:" + host + ":c:" + encodeURIComponent(name);
      },

      // Signs the bare creation payload with the device's soft signing key —
      // mirrors UserSpace.js's _signProfileEnvelopeIfPossible/
      // PostCardSerializer.js's _signEnvelopeIfPossible (same KEK-cache/
      // softSigningKeyWrapped/c.signJws dance), except: (1) there is no
      // envelope to wrap the signature into — this signs `payload` directly
      // and returns the raw JWS string; (2) missing prerequisites are a
      // real error here, not a silent no-op, since IdentityServer.js's
      // POST /c/:name hard-requires creationSig. If the KEK isn't cached
      // yet this prompts for it (same on-demand passkey ceremony
      // PostCardEditor.js's _saveNowPrivate already uses), rather than
      // failing outright.
      _signConstellationCreation: function _signConstellationCreation(payload, thenDo) {
        var user = lively.identity.did.currentUser();
        if (!user) return thenDo(new Error("Not signed in."));
        var method = lively.identity.did.findMethodByCredentialId(user.document, user.credentialId);
        if (!method || !method.lively || !method.lively.softSigningKeyWrapped || !method.lively.delegationCert) {
          return thenDo(new Error(
            "This device has no signing key set up — add a device with a fresh " +
            "passkey ceremony (menu bar -> Add device), then try again."
          ));
        }
        var livelyMeta = method.lively;
        var c = lively.identity.crypto;
        var wa = lively.identity.webAuthn;

        function withKek(cb) {
          if (wa._kekCache && wa._kekCache[user.credentialId]) return cb(null, wa._kekCache[user.credentialId]);
          var ch = new Uint8Array(32);
          crypto.getRandomValues(ch);
          wa.deriveKek({ credentialId: user.credentialId, rpId: user.rpId, challenge: ch }, function (err) {
            if (err) return cb(err);
            cb(null, wa._kekCache[user.credentialId]);
          });
        }

        withKek(function (err, kek) {
          if (err) return thenDo(err);
          var wrapped;
          try { wrapped = JSON.parse(livelyMeta.softSigningKeyWrapped); } catch (e) { return thenDo(e); }
          c.decryptPayload(wrapped.ciphertext, wrapped.nonce, kek, function (err, softPrivJwk) {
            if (err) return thenDo(err);
            c.importPrivateKeyJwk(softPrivJwk, function (err, softPrivKey) {
              if (err) return thenDo(err);
              c.signJws(payload, softPrivKey, thenDo);
            });
          });
        });
      },

      _setCreateStatus: function (msg, isError) {
        if (!this._createStatusEl) return;
        this._createStatusEl.textContent = msg || "";
        this._createStatusEl.classList.toggle("danger", !!isError);
      },

      createConstellation: function createConstellation() {
        var self = this;
        var name = (this._createNameInput.value || "").trim().toLowerCase();
        if (!/^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])?$/.test(name)) {
          return this._setCreateStatus("Invalid name — lowercase letters, digits, hyphens, 3-40 chars.", true);
        }
        var user = lively.identity.did.currentUser();
        if (!user) return this._setCreateStatus("Not signed in.", true);

        this._setCreateStatus("Generating…");
        lively.identity.webKey.generateGenesisObjId(user.did, function (err, gen) {
          if (err) return self._setCreateStatus("Error: " + err.message, true);

          var did = self._didWebForConstellation(name);
          var createdAt = new Date().toISOString();
          var payload = {
            name: name,
            did: did,
            controller: [user.did],
            threshold: 1,
            createdBy: user.did,
            createdAt: createdAt,
          };

          self._setCreateStatus("Signing… (confirm your passkey if prompted)");
          self._signConstellationCreation(payload, function (err, creationSig) {
            if (err) return self._setCreateStatus("Signing failed: " + err.message, true);

            self._setCreateStatus("Creating…");
            var base = lively.identity.did.baseUrl();
            var xhr = new XMLHttpRequest();
            xhr.open("POST", base + "/c/" + encodeURIComponent(name), true);
            xhr.withCredentials = true;
            xhr.setRequestHeader("Content-Type", "application/json");
            xhr.onload = function () {
              if (xhr.status === 201) {
                self._setCreateStatus("Created — opening…");
                window.location.href = "/c/" + encodeURIComponent(name);
                return;
              }
              var msg = "Create failed (" + xhr.status + ")";
              try {
                var body = JSON.parse(xhr.responseText);
                if (body && body.error) msg = body.error;
              } catch (e) {}
              self._setCreateStatus(msg, true);
            };
            xhr.onerror = function () { self._setCreateStatus("Network error", true); };
            xhr.send(JSON.stringify({
              did: did,
              genesisObjId: gen.objId,
              genesisNonce: gen.genesisNonce,
              createdAt: createdAt,
              creationSig: creationSig,
              visibility: self._visibility,
            }));
          });
        });
      },
    },

    "helpers", {

      _makeCard: function () {
        var card = document.createElement("div");
        card.className = "cxb-card";
        return card;
      },

      _emptyHtml: function (icon, text, danger) {
        return "<div class=\"cxb-empty" + (danger ? " danger" : "") + "\"><span class=\"cxb-empty-icon\">" + icon + "</span><div>" + text + "</div></div>";
      },

      _emptyEl: function (icon, text, danger) {
        var el = document.createElement("div");
        el.className = "cxb-empty" + (danger ? " danger" : "");
        var i = document.createElement("span");
        i.className = "cxb-empty-icon";
        i.textContent = icon;
        el.appendChild(i);
        var t = document.createElement("div");
        t.textContent = text;
        el.appendChild(t);
        return el;
      },

      _showError: function (msg) {
        this._contentDiv.innerHTML = this._emptyHtml("error", msg, true);
      },
    }

    ); // end subclass

    // ── class-side entry point ───────────────────────────────────────────────

    Object.extend(ConstellationsBrowserClass, {
      open: function () {
        var W = 480, H = 560;
        var morph = new lively.identity.ConstellationsBrowser(lively.rect(0, 0, W, H));
        morph.setName("ConstellationsBrowser");
        // Real classic Window chrome (drag/resize/collapse/close, Material
        // Symbols icon controls by default) rather than the previous
        // BuildSpec-drawn title bar — same pattern as
        // PostCardMailbox.js/CalendarApp.js's own open().
        morph.openInWindow({
          title: "My Constellations",
          pos: lively.morphic.World.current().visibleBounds().center().subPt(lively.pt(W / 2, H / 2)),
        });
        var win = morph.getWindow();
        _ensureAccentChromeCss();
        win.addStyleClassName("cxb-accent-chrome");
        win.comeForward();
        return morph;
      },
    });

  }); // end module('lively.identity.ConstellationsBrowser')
