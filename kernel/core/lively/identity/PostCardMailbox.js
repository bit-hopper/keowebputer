/**
 * lively.identity.PostCardMailbox
 *
 * Tabbed morph showing the views of the user's postcard mailbox:
 *
 *   Inbox        — cards delivered to your inbox (GET /@:handle/inbox)
 *   Sent         — cards you sent that were accepted (GET /@:handle/deliveries?status=delivered)
 *   Returned     — cards that got the postal rejection  (GET /@:handle/deliveries?status=returned)
 *   Blocked      — manage your block list (GET/PUT /@:handle/settings)
 *   My Postcards — your own authored drafts/standalone/constellation posts
 *                  (GET /@:handle/postcards) — the one tab whose rows are
 *                  cards *you wrote*, as opposed to references to a
 *                  delivery event. Each row has a ⋯ menu (currently just
 *                  Delete, §6.3's tombstone path — author-only, since this
 *                  codebase has no wiki-mode postcards yet).
 *   Aliases      — manage forwarding addresses (GET/POST /@:handle/aliases,
 *                  DELETE /@:handle/aliases/:alias) — rotatable, randomly
 *                  generated handles that resolve to the same DID as your
 *                  primary handle, independently revocable (§3.2).
 *
 * Entry point:
 *   lively.identity.PostCardMailbox.open(tab)
 *     tab: 'received' | 'delivered' | 'returned' | 'blocked' | 'own' | 'aliases'  (defaults to 'received')
 */

module('lively.identity.PostCardMailbox')
  .requires(
    'lively.identity.DID',
    'lively.identity.PostCardView',
    'lively.identity.MailboxThread',
    'lively.identity.PostcardEdits',
  )
  .toRun(function () {

    // Modern content design system for the mailbox's tab bar / search /
    // cards / buttons / menu — injected once per world (idempotent, same
    // guard idiom as _ensureAccentChromeCss below, which handles only the
    // outer Window's own accent color). Everything here is scoped under
    // `.pcm-root` (added to this morph's own shapeNode in _buildChrome) so
    // it can't leak onto unrelated DOM elsewhere in the world. Tokens are
    // CSS custom properties so every inline cssText string in this file
    // can reference them via var(--pcm-*) instead of repeating hex
    // literals — the map tab's own marker/legend colors are deliberately
    // left alone (own/received need to stay visually distinct, unrelated
    // to this button/tab palette).
    function _ensureMailboxContentStyle() {
      var STYLE_ID = 'postcard-mailbox-content-style';
      if (document.getElementById(STYLE_ID)) return;
      var styleEl = document.createElement('style');
      styleEl.id = STYLE_ID;
      styleEl.textContent = [
        '.pcm-root {',
        '  --pcm-bg: #fafafa; --pcm-surface: #ffffff;',
        '  --pcm-border: #e4e4e7; --pcm-border-strong: #d4d4d8;',
        '  --pcm-text: #18181b; --pcm-text-secondary: #52525b; --pcm-text-tertiary: #a1a1aa;',
        '  --pcm-accent: #16a34a; --pcm-accent-soft: #f0fdf4; --pcm-accent-soft-border: #bbf7d0;',
        '  --pcm-danger: #e11d48; --pcm-danger-soft: #fff1f2; --pcm-danger-soft-border: #fecdd3;',
        '  --pcm-warn: #b45309; --pcm-warn-soft: #fffbeb; --pcm-warn-soft-border: #fde68a;',
        '  --pcm-info: #4f46e5; --pcm-info-soft: #eef2ff;',
        '  --pcm-radius: 12px; --pcm-radius-sm: 8px; --pcm-radius-pill: 999px;',
        '  --pcm-shadow-card: 0 1px 2px rgba(24,24,27,0.04), 0 1px 8px rgba(24,24,27,0.04);',
        '  --pcm-shadow-card-hover: 0 2px 6px rgba(24,24,27,0.06), 0 4px 16px rgba(24,24,27,0.08);',
        '  --pcm-shadow-menu: 0 8px 24px rgba(24,24,27,0.14), 0 2px 6px rgba(24,24,27,0.08);',
        '  --pcm-font: -apple-system, BlinkMacSystemFont, "Segoe UI", Inter, Roboto, Helvetica, Arial, sans-serif;',
        '  font-family: var(--pcm-font);',
        '}',
        '.pcm-content::-webkit-scrollbar { width: 9px; height: 9px; }',
        '.pcm-content::-webkit-scrollbar-thumb { background: var(--pcm-border-strong); border-radius: 5px; border: 2px solid var(--pcm-bg); }',
        '.pcm-content::-webkit-scrollbar-track { background: transparent; }',

        '.pcm-tabbar { display: flex; align-items: center; gap: 2px; overflow-x: auto; scrollbar-width: none; height: 100%; }',
        '.pcm-tabbar::-webkit-scrollbar { display: none; }',
        '.pcm-tab { display: flex; align-items: center; gap: 4px; flex: none; border: none; background: transparent;',
        '  cursor: pointer; font-size: 12px; font-weight: 500; color: var(--pcm-text-secondary);',
        '  padding: 7px 9px; border-radius: var(--pcm-radius-pill); white-space: nowrap;',
        '  font-family: var(--pcm-font); transition: background .15s, color .15s; }',
        '.pcm-tab-icon { font-family: "Material Symbols Rounded"; font-size: 15px; line-height: 1; }',
        '.pcm-tab:hover { background: var(--pcm-bg); color: var(--pcm-text); }',
        '.pcm-tab.active { background: var(--pcm-accent-soft); color: var(--pcm-accent); font-weight: 600; }',

        '.pcm-search { display: flex; align-items: center; gap: 8px; background: var(--pcm-bg);',
        '  border-radius: var(--pcm-radius-sm); padding: 0 10px; }',
        '.pcm-search-icon { font-family: "Material Symbols Rounded"; font-size: 16px; color: var(--pcm-text-tertiary); }',
        '.pcm-search input { flex: 1; border: none; background: transparent; outline: none;',
        '  font-size: 12.5px; padding: 8px 0; color: var(--pcm-text); font-family: var(--pcm-font); }',
        '.pcm-search input::placeholder { color: var(--pcm-text-tertiary); }',

        '.pcm-card { background: var(--pcm-surface); border: 1px solid var(--pcm-border);',
        '  border-radius: var(--pcm-radius); padding: 12px 14px; margin-bottom: 8px; position: relative;',
        '  box-shadow: var(--pcm-shadow-card); transition: box-shadow .15s, border-color .15s; }',
        '.pcm-card:hover { box-shadow: var(--pcm-shadow-card-hover); border-color: var(--pcm-border-strong); }',

        '.pcm-empty { display: flex; flex-direction: column; align-items: center; justify-content: center;',
        '  gap: 8px; color: var(--pcm-text-tertiary); padding: 48px 16px; text-align: center; font-size: 12.5px; }',
        '.pcm-empty-icon { font-family: "Material Symbols Rounded"; font-size: 32px; color: var(--pcm-border-strong); }',
        '.pcm-empty.danger { color: var(--pcm-danger); }',
        '.pcm-empty.danger .pcm-empty-icon { color: var(--pcm-danger); }',

        '.pcm-btn { display: inline-flex; align-items: center; gap: 4px; font-size: 11.5px; font-weight: 500;',
        '  padding: 5px 11px; cursor: pointer; border-radius: var(--pcm-radius-pill); border: 1px solid var(--pcm-border);',
        '  background: var(--pcm-surface); color: var(--pcm-text-secondary); font-family: var(--pcm-font);',
        '  transition: background .15s, border-color .15s, color .15s; }',
        '.pcm-btn:hover { background: var(--pcm-bg); }',
        '.pcm-btn:disabled { opacity: .5; cursor: default; }',
        '.pcm-btn-icon-glyph { font-family: "Material Symbols Rounded"; font-size: 13px; line-height: 1; }',
        '.pcm-btn-accent { border-color: var(--pcm-accent-soft-border); color: var(--pcm-accent); background: var(--pcm-accent-soft); }',
        '.pcm-btn-accent:hover { background: var(--pcm-accent-soft-border); }',
        '.pcm-btn-danger { border-color: var(--pcm-danger-soft-border); color: var(--pcm-danger); background: var(--pcm-danger-soft); }',
        '.pcm-btn-danger:hover { background: var(--pcm-danger-soft-border); }',
        '.pcm-btn-ghost-danger { border-color: var(--pcm-border); color: var(--pcm-danger); background: var(--pcm-surface); }',
        '.pcm-btn-ghost-danger:hover { background: var(--pcm-danger-soft); border-color: var(--pcm-danger-soft-border); }',

        '.pcm-icon-btn { display: flex; align-items: center; justify-content: center; width: 26px; height: 26px;',
        '  border: none; border-radius: 50%; background: transparent; color: var(--pcm-text-tertiary);',
        '  cursor: pointer; transition: background .15s, color .15s; padding: 0; }',
        '.pcm-icon-btn-glyph { font-family: "Material Symbols Rounded"; font-size: 16px; }',
        '.pcm-icon-btn:hover { background: var(--pcm-bg); color: var(--pcm-text); }',

        '.pcm-menu { position: absolute; z-index: 20; background: var(--pcm-surface); border: 1px solid var(--pcm-border);',
        '  border-radius: var(--pcm-radius-sm); box-shadow: var(--pcm-shadow-menu); padding: 4px; min-width: 130px; }',
        '.pcm-menu-item { display: block; width: 100%; text-align: left; font-size: 12px; padding: 7px 10px;',
        '  cursor: pointer; border: none; background: none; border-radius: 6px; color: var(--pcm-text);',
        '  font-family: var(--pcm-font); }',
        '.pcm-menu-item:hover { background: var(--pcm-bg); }',
        '.pcm-menu-item.danger { color: var(--pcm-danger); }',
        '.pcm-menu-item.danger:hover { background: var(--pcm-danger-soft); }',

        '.pcm-badge { display: inline-block; margin-bottom: 6px; padding: 2px 8px; font-size: 10px; font-weight: 600;',
        '  border-radius: var(--pcm-radius-pill); background: var(--pcm-info-soft); color: var(--pcm-info); }',
        '.pcm-badge-warn { background: var(--pcm-warn-soft); color: var(--pcm-warn); }',
        '.pcm-badge-danger { background: var(--pcm-danger); color: #fff; }',

        '.pcm-chip { display: inline-flex; align-items: center; gap: 6px; max-width: 260px;',
        '  background: var(--pcm-info-soft); color: var(--pcm-info); font-size: 11px;',
        '  padding: 4px 10px; border-radius: var(--pcm-radius-pill); }',

        '.pcm-row-input { flex: 1; font-size: 12px; padding: 7px 10px; border: 1px solid var(--pcm-border);',
        '  border-radius: var(--pcm-radius-sm); box-sizing: border-box; font-family: var(--pcm-font);',
        '  background: var(--pcm-surface); color: var(--pcm-text); outline: none; transition: border-color .15s; }',
        '.pcm-row-input:focus { border-color: var(--pcm-accent); }',

        // Inbox: filter chips, reply-thread rows, unread counts.
        '.pcm-tab-badge { min-width: 16px; height: 16px; padding: 0 4px; border-radius: 8px; background: var(--pcm-accent);',
        '  color: #fff; font-size: 10px; font-weight: 700; display: inline-flex; align-items: center; justify-content: center; }',
        '.pcm-chips { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; margin-bottom: 10px; }',
        '.pcm-filter { font-size: 11.5px; font-weight: 600; padding: 4px 10px; border-radius: var(--pcm-radius-pill);',
        '  border: 1px solid var(--pcm-border); background: var(--pcm-surface); color: var(--pcm-text-secondary);',
        '  cursor: pointer; font-family: var(--pcm-font); display: inline-flex; gap: 6px; align-items: center; }',
        '.pcm-filter.on { background: var(--pcm-text); border-color: var(--pcm-text); color: #fff; }',
        '.pcm-filter .n { color: var(--pcm-accent); }',
        '.pcm-filter.on .n { color: #fff; opacity: .85; }',
        '.pcm-thread { cursor: pointer; display: flex; gap: 12px; align-items: flex-start; }',
        '.pcm-thread.unread { border-color: var(--pcm-accent-soft-border); }',
        '.pcm-thread .body { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }',
        '.pcm-thread .l1 { display: flex; gap: 8px; align-items: baseline; }',
        '.pcm-thread .ttl { flex: 1; min-width: 0; font-size: 13px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }',
        '.pcm-thread.unread .ttl { font-weight: 700; }',
        '.pcm-thread .when { flex: none; font-size: 11px; color: var(--pcm-text-secondary); }',
        '.pcm-thread .l2 { font-size: 12px; color: var(--pcm-text-secondary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }',
        '.pcm-thread .side { flex: none; display: flex; align-items: center; }',
        '.pcm-count { min-width: 20px; height: 20px; padding: 0 6px; border-radius: 10px; background: var(--pcm-accent); color: #fff;',
        '  font-size: 11.5px; font-weight: 700; display: inline-flex; align-items: center; justify-content: center; }',
        '.pcm-kind { flex: none; font-size: 10.5px; font-weight: 600; padding: 1px 8px; border-radius: var(--pcm-radius-pill);',
        '  background: var(--pcm-accent-soft); color: var(--pcm-accent); border: 1px solid var(--pcm-accent-soft-border); }',
      ].join('\n');
      document.head.appendChild(styleEl);
    }

    var MailboxClass = lively.morphic.Box.subclass('lively.identity.PostCardMailbox',

    'serialization', {
      doNotSerialize: [
        '_contentDiv', '_tabBtns', '_openMenuEl', '_openMenuAnchor', '_menuCloseHandler',
        '_searchBar', '_searchInput', '_contentLoadStarted', '_leafletMap', '_threadCtrl',
      ],
    },

    'initialization', {

      initialize: function ($super, bounds) {
        $super(bounds);
        this._activeTab = 'received';
        this._contentDiv = null;
        this._tabBtns    = {};
        this._openMenuEl = null;
        this._openMenuAnchor = null;
        this._menuCloseHandler = null;
        this._searchQuery = '';
        this._leafletMap = null;
        this._threadCtrl = null;
        this._inboxFilter = 'all';
        this._buildChrome();
        // Guards prepareForNewRenderContext below against redundantly
        // re-running _switchTab once this constructor returns and
        // open() attaches the new instance to the world — see that
        // method's own comment for the mechanism.
        this._contentLoadStarted = true;
        this._switchTab('received');
      },

      // $super(bounds) above (Morph.initialize) is what calls
      // prepareForNewRenderContext the first time, before _activeTab exists
      // yet — the guard there skips that call, leaving this constructor's
      // own _buildChrome()/_switchTab() as the only build on fresh
      // construction. On a world-reload restore, _activeTab already has its
      // serialized value (survives fine, it's a plain string) but none of
      // the DOM _buildChrome built does, so it re-runs here instead.
      //
      // It ALSO fires as an *immediate* same-turn duplicate of the
      // constructor's own explicit _buildChrome()/_switchTab() call above:
      // PostCardMailbox.open() attaches this freshly-constructed morph to
      // the world (via openInWindow's wrapping classic Window) right after
      // construction, which re-triggers this method, and by then
      // _activeTab is already set, so the guard above doesn't skip
      // it — same mechanism as the identical fix in PostCardEditor.js/
      // PostCardView.js. _buildChrome() still runs every time (cheap,
      // idempotent, and needed for the genuine restore case); only the
      // _switchTab (network fetch + render) is guarded, via
      // _contentLoadStarted — doNotSerialize'd so a genuine future
      // restore still starts falsy and loads normally.
      prepareForNewRenderContext: function ($super, renderCtx) {
        $super(renderCtx);
        if (!this._activeTab) return;
        var tab = this._activeTab;
        this._tabBtns = {};
        this._openMenuEl = null;
        this._openMenuAnchor = null;
        this._menuCloseHandler = null;
        // _buildChrome() below rebuilds _contentDiv from scratch, orphaning
        // whatever DOM node any live Leaflet map (Map tab) was attached to
        // — tear it down first rather than leaking it.
        if (this._leafletMap) { this._leafletMap.remove(); this._leafletMap = null; }
        this._buildChrome();
        if (this._contentLoadStarted) return;
        this._contentLoadStarted = true;
        this._switchTab(tab);
      },

      // Chrome (title bar, close button) is now the real classic
      // lively.morphic.Window this morph is framed in via openInWindow()
      // below — see CalendarApp.js's identical precedent — so this only
      // builds the tab bar / search bar / content area, not a hand-rolled
      // title bar.
      _buildChrome: function () {
        var self = this;
        _ensureMailboxContentStyle();
        this.setFill(Color.white);
        this.setDroppingEnabled(false);
        var shapeNode = this.renderContext().shapeNode;
        shapeNode.innerHTML = ''; // idempotent: safe if this ever runs twice on one instance
        shapeNode.classList.add('pcm-root');

        // ── tab bar — a horizontally-scrolling row of icon+label pills
        // (Material Symbols Rounded, same vendored font every other
        // morphic UI in this codebase uses) rather than the old flex-
        // stretched plain-text tabs, so 9 tabs read as a friendly nav
        // strip instead of a cramped fixed grid.
        var tabBarWrap = document.createElement('div');
        tabBarWrap.style.cssText = [
          'position:absolute', 'top:0', 'left:0', 'right:0', 'height:44px',
          'border-bottom:1px solid var(--pcm-border)', 'background:var(--pcm-surface)',
          'display:flex', 'align-items:center', 'box-sizing:border-box', 'padding:0 8px',
        ].join(';');
        var tabBar = document.createElement('div');
        tabBar.className = 'pcm-tabbar';

        var tabs = [
          { id: 'received',  label: 'Inbox',         icon: 'inbox' },
          { id: 'delivered', label: 'Sent',          icon: 'outbox' },
          { id: 'returned',  label: 'Returned',      icon: 'assignment_return' },
          { id: 'blocked',   label: 'Blocked',       icon: 'block' },
          { id: 'own',       label: 'My Postcards',  icon: 'draft' },
          { id: 'collections', label: 'Collections', icon: 'collections_bookmark' },
          { id: 'aliases',   label: 'Aliases',       icon: 'alternate_email' },
          { id: 'friends',   label: 'Friends',       icon: 'group' },
          { id: 'rss',       label: 'RSS',           icon: 'rss_feed' },
          { id: 'map',       label: 'Map',           icon: 'map' },
        ];
        tabs.forEach(function (t) {
          var btn = document.createElement('button');
          btn.className = 'pcm-tab';
          var icon = document.createElement('span');
          icon.className = 'pcm-tab-icon';
          icon.textContent = t.icon;
          btn.appendChild(icon);
          btn.appendChild(document.createTextNode(t.label));
          btn.addEventListener('click', function () { self._switchTab(t.id); });
          tabBar.appendChild(btn);
          self._tabBtns[t.id] = btn;
        });
        tabBarWrap.appendChild(tabBar);
        shapeNode.appendChild(tabBarWrap);

        // ── search bar (§8.1) — title-only metadata search, shown only for
        // tabs whose rows are actual postcards (Received/Delivered/
        // Returned/My Postcards); hidden for Blocked/Aliases, which have
        // no title to search. Lives outside _contentDiv deliberately —
        // every render function clears _contentDiv wholesale, which would
        // otherwise wipe this input (and drop focus/keystrokes) on every
        // reload a search itself triggers.
        var searchBarWrap = document.createElement('div');
        searchBarWrap.style.cssText = [
          'position:absolute', 'top:44px', 'left:0', 'right:0', 'height:40px',
          'background:var(--pcm-surface)', 'border-bottom:1px solid var(--pcm-border)',
          'display:none', 'align-items:center', 'padding:0 12px', 'box-sizing:border-box',
        ].join(';');
        var searchBar = document.createElement('div');
        searchBar.className = 'pcm-search';
        searchBar.style.width = '100%';
        var searchIcon = document.createElement('span');
        searchIcon.className = 'pcm-search-icon';
        searchIcon.textContent = 'search';
        searchBar.appendChild(searchIcon);
        var searchInput = document.createElement('input');
        searchInput.type = 'text';
        searchInput.placeholder = 'Search by title…';
        var searchDebounce = null;
        searchInput.addEventListener('input', function () {
          clearTimeout(searchDebounce);
          searchDebounce = setTimeout(function () {
            self._searchQuery = searchInput.value.trim();
            self._reloadCurrentTab();
          }, 300);
        });
        searchBar.appendChild(searchInput);
        searchBarWrap.appendChild(searchBar);
        shapeNode.appendChild(searchBarWrap);
        this._searchBar = searchBarWrap;
        this._searchInput = searchInput;

        // ── content area ──
        var contentDiv = document.createElement('div');
        contentDiv.className = 'pcm-content';
        contentDiv.style.cssText = [
          'position:absolute', 'top:84px', 'left:0', 'right:0', 'bottom:0',
          'overflow-y:auto', 'padding:14px 16px', 'box-sizing:border-box',
          'font-family:var(--pcm-font)', 'font-size:13px', 'background:var(--pcm-bg)',
        ].join(';');
        shapeNode.appendChild(contentDiv);
        this._contentDiv = contentDiv;
      },

      _switchTab: function (tab) {
        var self = this;
        this._activeTab = tab;
        this._closePostcardMenu();

        // Update tab button styles
        Object.keys(this._tabBtns).forEach(function (id) {
          self._tabBtns[id].classList.toggle('active', id === tab);
        });

        // Each tab starts with a fresh (empty) search — a query typed into
        // one tab carrying silently into an unrelated one would be more
        // confusing than having to retype it.
        this._searchQuery = '';
        if (this._searchInput) this._searchInput.value = '';
        var searchable = tab === 'received' || tab === 'delivered' || tab === 'returned' || tab === 'own' || tab === 'collections';
        if (this._searchBar) this._searchBar.style.display = searchable ? 'flex' : 'none';

        // An open reply thread takes over _contentDiv's whole layout (see
        // _openThread); give it back its normal geometry on any tab switch.
        if (this._threadCtrl) { this._threadCtrl.destroy(); this._threadCtrl = null; }
        this._contentDiv.style.top = '84px';
        this._contentDiv.style.overflowY = 'auto';

        // The Map tab's Leaflet instance owns real DOM nodes inside
        // _contentDiv — tear it down before that div gets wiped below (not
        // after), and before its container is orphaned out from under it.
        if (this._leafletMap) { this._leafletMap.remove(); this._leafletMap = null; }
        // Only the Map tab wants a full-bleed content area; every other
        // tab (including a tab switched away from Map) uses the normal
        // padded/scrollable card layout.
        this._contentDiv.style.padding = tab === 'map' ? '0' : '12px 16px';

        this._contentDiv.innerHTML = this._emptyHtml('hourglass_top', 'Loading…');

        if (tab === 'received')  this._loadReceived();
        if (tab === 'delivered') this._loadDeliveries('delivered');
        if (tab === 'returned')  this._loadDeliveries('returned');
        if (tab === 'blocked')   this._loadBlocked();
        if (tab === 'own')       this._loadOwn();
        if (tab === 'collections') this._loadCollections();
        if (tab === 'aliases')   this._loadAliases();
        if (tab === 'friends')   this._loadFriends();
        if (tab === 'rss')       this._loadRssFeeds();
        if (tab === 'map')       this._loadMapTab();
      },

      // Re-runs whichever load function backs the active tab — used by the
      // search box (§8.1) after this._searchQuery changes, so it doesn't
      // need its own copy of the tab -> loader mapping.
      _reloadCurrentTab: function () {
        if (this._activeTab === 'received')  this._loadReceived();
        if (this._activeTab === 'delivered') this._loadDeliveries('delivered');
        if (this._activeTab === 'returned')  this._loadDeliveries('returned');
        if (this._activeTab === 'own')       this._loadOwn();
        if (this._activeTab === 'collections') this._loadCollections();
      },

      // ── data fetching ─────────────────────────────────────────────────────

      // '' when unset, else '&q=<encoded>' — appended to every searchable
      // tab's list URL (§8.1).
      _qParam: function () {
        return this._searchQuery ? '&q=' + encodeURIComponent(this._searchQuery) : '';
      },

      _loadReceived: function () {
        var self   = this;
        var handle = lively.identity.did.currentUser().handle;
        var base   = lively.identity.did.baseUrl();
        var xhr    = new XMLHttpRequest();
        xhr.open('GET', base + '/@' + handle + '/inbox?limit=30' + this._qParam());
        xhr.withCredentials = true;
        xhr.onload = function () {
          // Guards against the exact race PostCardMailbox.open(tab)'s own
          // two-switch construction can trigger (constructor default's
          // _switchTab('received') immediately followed by open()'s own
          // _switchTab(tab) for any other tab): both loads are in flight at
          // once, and without this check whichever XHR resolves LAST wins
          // regardless of which tab is actually showing — confirmed live,
          // opening straight to the new Friends tab intermittently rendered
          // a stray Received postcard row on top of it. See _loadFriends's
          // identical guard.
          // (An open reply thread owns the content area; a late list
          // response must not paint over it.)
          if (self._activeTab !== 'received' || self._threadCtrl) return;
          if (xhr.status !== 200) return self._showError('Could not load inbox (' + xhr.status + ')');
          var result;
          try { result = JSON.parse(xhr.responseText); } catch (e) { return self._showError('Bad response'); }
          self._setInboxBadge(result.unreadReplies || 0);
          self._renderReceivedRecords(result.records || []);
        };
        xhr.onerror = function () { if (self._activeTab === 'received') self._showError('Network error'); };
        xhr.send();
      },

      _loadDeliveries: function (status) {
        var self   = this;
        var handle = lively.identity.did.currentUser().handle;
        var base   = lively.identity.did.baseUrl();
        var xhr    = new XMLHttpRequest();
        xhr.open('GET', base + '/@' + handle + '/deliveries?status=' + status + '&limit=30' + this._qParam());
        xhr.withCredentials = true;
        xhr.onload = function () {
          // See _loadReceived's identical guard for why this is needed.
          if (self._activeTab !== status) return;
          if (xhr.status !== 200) return self._showError('Could not load deliveries (' + xhr.status + ')');
          var result;
          try { result = JSON.parse(xhr.responseText); } catch (e) { return self._showError('Bad response'); }
          self._renderDeliveryRecords(result.records || [], status);
        };
        xhr.onerror = function () { if (self._activeTab === status) self._showError('Network error'); };
        xhr.send();
      },

      // The one tab whose rows are cards the current user actually
      // authored (drafts, standalone posts, constellation-feed posts) —
      // Received/Delivered/Returned are all references to delivery events,
      // not this. §6.3's Delete lives here for exactly that reason.
      _loadOwn: function () {
        var self   = this;
        var handle = lively.identity.did.currentUser().handle;
        var base   = lively.identity.did.baseUrl();
        var xhr    = new XMLHttpRequest();
        xhr.open('GET', base + '/@' + handle + '/postcards?limit=30' + this._qParam());
        xhr.withCredentials = true;
        xhr.onload = function () {
          // See _loadReceived's identical guard for why this is needed.
          if (self._activeTab !== 'own') return;
          if (xhr.status !== 200) return self._showError('Could not load your postcards (' + xhr.status + ')');
          var result;
          try { result = JSON.parse(xhr.responseText); } catch (e) { return self._showError('Bad response'); }
          self._renderOwnRecords(result.postcards || []);
        };
        xhr.onerror = function () { if (self._activeTab === 'own') self._showError('Network error'); };
        xhr.send();
      },

      _loadCollections: function () {
        var self   = this;
        var handle = lively.identity.did.currentUser().handle;
        var base   = lively.identity.did.baseUrl();
        var xhr    = new XMLHttpRequest();
        xhr.open('GET', base + '/@' + handle + '/collections?limit=30' + this._qParam());
        xhr.withCredentials = true;
        xhr.onload = function () {
          // See _loadReceived's identical guard for why this is needed.
          if (self._activeTab !== 'collections') return;
          if (xhr.status !== 200) return self._showError('Could not load collections (' + xhr.status + ')');
          var result;
          try { result = JSON.parse(xhr.responseText); } catch (e) { return self._showError('Bad response'); }
          self._renderCollectionsRecords(result.records || []);
        };
        xhr.onerror = function () { if (self._activeTab === 'collections') self._showError('Network error'); };
        xhr.send();
      },

      // Saves (bookmarks) objId into the current user's Collections tab —
      // called from the "Save to Collections" ⋯-menu item on
      // Received/Delivered/Own rows (PostcardDesignSpec-v2.md §6.2). One-
      // directional from those tabs (idempotent PUT, no "already saved"
      // state tracked per-row); removal only happens from inside the
      // Collections tab itself via _removeFromCollections.
      _saveToCollections: function (objId, onDone) {
        var handle = lively.identity.did.currentUser().handle;
        var base   = lively.identity.did.baseUrl();
        var xhr    = new XMLHttpRequest();
        xhr.open('PUT', base + '/@' + handle + '/collections/' + encodeURIComponent(objId));
        xhr.withCredentials = true;
        xhr.onload = function () { if (onDone) onDone(xhr.status === 200); };
        xhr.onerror = function () { if (onDone) onDone(false); };
        xhr.send();
      },

      _removeFromCollections: function (objId, onDone) {
        var handle = lively.identity.did.currentUser().handle;
        var base   = lively.identity.did.baseUrl();
        var xhr    = new XMLHttpRequest();
        xhr.open('DELETE', base + '/@' + handle + '/collections/' + encodeURIComponent(objId));
        xhr.withCredentials = true;
        xhr.onload = function () { if (onDone) onDone(xhr.status === 200); };
        xhr.onerror = function () { if (onDone) onDone(false); };
        xhr.send();
      },

      _loadBlocked: function () {
        var self   = this;
        var handle = lively.identity.did.currentUser().handle;
        var base   = lively.identity.did.baseUrl();
        var xhr    = new XMLHttpRequest();
        xhr.open('GET', base + '/@' + handle + '/settings');
        xhr.withCredentials = true;
        xhr.onload = function () {
          // See _loadReceived's identical guard for why this is needed.
          if (self._activeTab !== 'blocked') return;
          if (xhr.status !== 200) return self._showError('Could not load settings (' + xhr.status + ')');
          var env;
          try { env = JSON.parse(xhr.responseText); } catch (e) { return self._showError('Bad response'); }
          self._settingsEnvelope = env;
          self._renderBlockedList((env.state && env.state.blockedHandles) || []);
        };
        xhr.onerror = function () { if (self._activeTab === 'blocked') self._showError('Network error'); };
        xhr.send();
      },

      // Subscribed feed URLs live in the same settings envelope as the
      // block list (state.rssFeeds — an array of { url }), reusing
      // _patchSettings for writes; this tab's own GET populates
      // _settingsEnvelope independently of whether the Blocked tab has
      // ever been visited this session.
      _loadRssFeeds: function () {
        var self   = this;
        var handle = lively.identity.did.currentUser().handle;
        var base   = lively.identity.did.baseUrl();
        var xhr    = new XMLHttpRequest();
        xhr.open('GET', base + '/@' + handle + '/settings');
        xhr.withCredentials = true;
        xhr.onload = function () {
          if (self._activeTab !== 'rss') return;
          if (xhr.status !== 200) return self._showError('Could not load settings (' + xhr.status + ')');
          var env;
          try { env = JSON.parse(xhr.responseText); } catch (e) { return self._showError('Bad response'); }
          self._settingsEnvelope = env;
          self._renderRssTab((env.state && env.state.rssFeeds) || []);
        };
        xhr.onerror = function () { if (self._activeTab === 'rss') self._showError('Network error'); };
        xhr.send();
      },

      _addRssFeed: function (url, thenDo) {
        this._patchSettings(function (state) {
          state.rssFeeds = state.rssFeeds || [];
          if (!state.rssFeeds.some(function (f) { return f.url === url; })) {
            state.rssFeeds.push({ url: url });
          }
        }, thenDo);
      },

      _removeRssFeed: function (url, thenDo) {
        this._patchSettings(function (state) {
          state.rssFeeds = (state.rssFeeds || []).filter(function (f) { return f.url !== url; });
        }, thenDo);
      },

      // Fetches every subscribed feed's entries in parallel through the
      // server-side proxy (RssProxyServer.js — a plain browser fetch()
      // straight to an external feed almost always fails on CORS), merges
      // them into one newest-first list. A feed that errors contributes no
      // entries but is NOT silently dropped — its message is collected into
      // `errors` (feed url -> message) so _renderRssTab can show the real
      // reason (bad hostname, timeout, 502, malformed feed, ...) instead of
      // an undifferentiated "nothing here." Calls thenDo(entries, errors) —
      // never a top-level err, since a total failure is just every feed
      // having its own entry in `errors`.
      _fetchFeedEntries: function (feeds, thenDo) {
        var base = lively.identity.did.baseUrl();
        if (!feeds.length) return thenDo([], {});
        var remaining = feeds.length;
        var allEntries = [];
        var errors = {};
        feeds.forEach(function (feed) {
          var xhr = new XMLHttpRequest();
          xhr.open('GET', base + '/nodejs/RssProxyServer/fetch?url=' + encodeURIComponent(feed.url));
          xhr.withCredentials = true;
          xhr.onload = function () {
            if (xhr.status === 200) {
              try {
                var result = JSON.parse(xhr.responseText);
                (result.entries || []).forEach(function (e) {
                  allEntries.push({
                    title: e.title, link: e.link, published: e.published, summary: e.summary,
                    feedTitle: result.title || feed.url,
                    _ts: e.published ? Date.parse(e.published) : NaN,
                  });
                });
              } catch (e) { errors[feed.url] = 'Malformed response from the feed proxy'; }
            } else {
              var msg = 'Request failed (' + xhr.status + ')';
              try { msg = JSON.parse(xhr.responseText).error || msg; } catch (e) {}
              errors[feed.url] = msg;
            }
            if (--remaining === 0) finish();
          };
          xhr.onerror = function () {
            errors[feed.url] = 'Network error';
            if (--remaining === 0) finish();
          };
          xhr.send();
        });
        function finish() {
          allEntries.sort(function (a, b) {
            var ta = isNaN(a._ts) ? -Infinity : a._ts;
            var tb = isNaN(b._ts) ? -Infinity : b._ts;
            return tb - ta;
          });
          thenDo(allEntries, errors);
        }
      },

      // ── Map tab (postcards you authored + mail you received, either one
      // carrying a location tag) ───────────────────────────────────────────
      // Two sources, merged: "My Postcards"' own envelopes (state.location
      // is already part of the full envelope /@:handle/postcards returns)
      // and the Received tab's inbox log, whose records are normally
      // metadata-only but now also carry `location` — piggybacked for free
      // onto ObjectRepository.js's existing per-page `_enrichWithConstellationTag`
      // envelope lookup (see that function's own comment). Delivered/
      // Returned aren't fetched separately: those reference the exact same
      // cards "My Postcards" already covers, just from the sender's own
      // side. Leaflet + open-location-code are the same lazily-loaded
      // runtime LocalMap.js/PostCardEditor.js already use
      // (core/lib/geo/geo-runtime.js) — duplicated here rather than shared,
      // matching this codebase's existing tolerance for small per-module
      // copies of this exact pattern (see LocalMap.js's own comment on
      // _ensureGeoRuntime).
      _loadMapTab: function () {
        var self = this;
        var mapEl = document.createElement('div');
        mapEl.style.cssText = 'position:absolute;inset:0;';
        this._contentDiv.innerHTML = '';
        this._contentDiv.appendChild(mapEl);

        var statusEl = document.createElement('div');
        statusEl.style.cssText = [
          'position:absolute', 'inset:0', 'display:flex', 'align-items:center',
          'justify-content:center', 'color:#999', 'font-size:13px', 'text-align:center',
          'padding:20px', 'box-sizing:border-box', 'background:#fff',
        ].join(';');
        statusEl.textContent = 'Loading…';
        this._contentDiv.appendChild(statusEl);

        this._ensureGeoRuntime(function () {
          self._fetchLocatedPostcards(function (items) {
            if (self._activeTab !== 'map') return;
            if (!items.length) {
              statusEl.textContent = 'No located postcards yet — tag a postcard with a ' +
                'location when composing (or wait for one to arrive) to see it here.';
              return;
            }
            statusEl.remove();
            self._initMailboxMap(mapEl, items);
          });
        });
      },

      // Same guard/poll/CSS-link shape as LocalMap.js's own
      // _ensureGeoRuntime — intentionally duplicated, not shared (see this
      // method's caller for why).
      _ensureGeoRuntime: function (callback) {
        if (window.L && window.OpenLocationCode) return callback();
        if (window._geoRuntimeLoading) {
          var poll = setInterval(function () {
            if (window.L && window.OpenLocationCode) { clearInterval(poll); callback(); }
          }, 80);
          return;
        }
        window._geoRuntimeLoading = true;
        if (!document.getElementById('leaflet-css')) {
          var link = document.createElement('link');
          link.id = 'leaflet-css';
          link.rel = 'stylesheet';
          link.href = '/core/lib/geo/leaflet.css';
          document.head.appendChild(link);
        }
        var s = document.createElement('script');
        s.src = '/core/lib/geo/geo-runtime.js';
        s.onload = function () { window._geoRuntimeLoading = false; callback(); };
        s.onerror = function () { window._geoRuntimeLoading = false; callback(); };
        document.head.appendChild(s);
      },

      // Fetches both sources in parallel and normalizes them into one
      // common marker shape: { objId, location, title, openHandle, kind }.
      // `openHandle` is null for "own" (PostCardView.open falls back to the
      // current user's own handle) and the sender's handle for "received"
      // (a received card lives in the SENDER's own object namespace, same
      // as every other received-card Open button in this file — see
      // _renderReceivedRecords' own use of rec.senderHandle). A source that
      // errors just contributes nothing rather than failing the whole map,
      // same "never thenDo(err, ...)" idiom as _fetchFeedEntries.
      _fetchLocatedPostcards: function (thenDo) {
        var remaining = 2;
        var combined = [];
        function done() { if (--remaining === 0) thenDo(combined); }

        this._fetchOwnLocatedPostcards(function (postcards) {
          postcards.forEach(function (pc) {
            combined.push({
              objId: pc.objId, location: pc.state.location,
              title: (pc.state && pc.state.title) || '(untitled)',
              openHandle: null, kind: 'own',
            });
          });
          done();
        });

        this._fetchReceivedLocatedPostcards(function (records) {
          records.forEach(function (rec) {
            combined.push({
              objId: rec.objId, location: rec.location,
              title: rec.senderHandle ? ('From @' + rec.senderHandle) : 'Received card',
              openHandle: rec.senderHandle || null, kind: 'received',
            });
          });
          done();
        });
      },

      // Calls thenDo(postcards) — never an error, an empty array on failure.
      _fetchOwnLocatedPostcards: function (thenDo) {
        var handle = lively.identity.did.currentUser().handle;
        var base   = lively.identity.did.baseUrl();
        var xhr    = new XMLHttpRequest();
        xhr.open('GET', base + '/@' + handle + '/postcards?limit=100');
        xhr.withCredentials = true;
        xhr.onload = function () {
          if (xhr.status !== 200) return thenDo([]);
          var result;
          try { result = JSON.parse(xhr.responseText); } catch (e) { return thenDo([]); }
          thenDo((result.postcards || []).filter(function (pc) { return pc.state && pc.state.location; }));
        };
        xhr.onerror = function () { thenDo([]); };
        xhr.send();
      },

      // Calls thenDo(records) — never an error, an empty array on failure.
      // `location` on inbox records only exists because
      // ObjectRepository.js's _enrichWithConstellationTag now also copies
      // it over — see that function's comment.
      _fetchReceivedLocatedPostcards: function (thenDo) {
        var handle = lively.identity.did.currentUser().handle;
        var base   = lively.identity.did.baseUrl();
        var xhr    = new XMLHttpRequest();
        xhr.open('GET', base + '/@' + handle + '/inbox?limit=100');
        xhr.withCredentials = true;
        xhr.onload = function () {
          if (xhr.status !== 200) return thenDo([]);
          var result;
          try { result = JSON.parse(xhr.responseText); } catch (e) { return thenDo([]); }
          thenDo((result.records || []).filter(function (rec) { return rec.location; }));
        };
        xhr.onerror = function () { thenDo([]); };
        xhr.send();
      },

      // Groups items by their (already-floored) location cell first, so a
      // cell with more than one item spreads its markers on a small
      // deterministic ring instead of stacking exactly on top of each other
      // — same technique and same constant as LocalMap.js's _placeMarkers/
      // _offsetPosition. "own" and "received" render as different marker
      // colors/glyphs (green envelope vs. blue inbox tray) so the map reads
      // as two overlaid layers, not one undifferentiated pile of pins.
      _initMailboxMap: function (mapEl, items) {
        var self   = this;
        var handle = lively.identity.did.currentUser().handle;
        var olc    = new window.OpenLocationCode();

        if (this._leafletMap) { this._leafletMap.remove(); this._leafletMap = null; }
        var map = window.L.map(mapEl);
        this._leafletMap = map;
        window.L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
          maxZoom: 19,
          attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
        }).addTo(map);

        var groups = {};
        items.forEach(function (item) {
          (groups[item.location] = groups[item.location] || []).push(item);
        });

        var bounds = [];
        Object.keys(groups).forEach(function (loc) {
          var area;
          try { area = olc.decode(loc); } catch (e) { return; }
          var center = [area.latitudeCenter, area.longitudeCenter];
          var group = groups[loc];
          group.forEach(function (item, idx) {
            var pos = self._offsetMapPosition(center, idx, group.length);
            bounds.push(pos);
            var isOwn = item.kind === 'own';
            var icon = window.L.divIcon({
              className: 'lively-mailbox-map-marker',
              html: '<div style="width:24px;height:24px;display:flex;align-items:center;' +
                'justify-content:center;background:#fff;border:2px solid ' + (isOwn ? '#61D565' : '#007aff') + ';' +
                'border-radius:50%;box-shadow:0 1px 4px rgba(0,0,0,0.3);' +
                'font-size:12px;line-height:1;">' + (isOwn ? '✉️' : '📥') + '</div>',
              iconSize: [24, 24],
              iconAnchor: [12, 12],
            });
            var marker = window.L.marker(pos, { icon: icon }).addTo(map);
            marker.bindTooltip(item.title);
            marker.on('click', function () {
              lively.identity.PostCardView.open(item.openHandle || handle, item.objId, {});
            });
          });
        });

        if (bounds.length === 1) map.setView(bounds[0], 12);
        else if (bounds.length > 1) map.fitBounds(bounds, { padding: [24, 24] });

        self._addMapLegend(mapEl);
      },

      // Small always-on-top key distinguishing the two marker colors —
      // added without one, the color difference alone would read as
      // arbitrary rather than meaningful.
      _addMapLegend: function (mapEl) {
        var legend = document.createElement('div');
        legend.style.cssText = [
          'position:absolute', 'right:10px', 'top:10px', 'z-index:1000',
          'background:rgba(255,255,255,0.92)', 'border-radius:6px',
          'box-shadow:0 1px 4px rgba(0,0,0,0.25)', 'padding:6px 10px',
          'font-size:11px', 'color:#3a3a3c', 'line-height:1.6',
        ].join(';');
        legend.innerHTML =
          '<div>✉️ <span style="color:#61D565;font-weight:600;">&#9679;</span> My Postcards</div>' +
          '<div>📥 <span style="color:#007aff;font-weight:600;">&#9679;</span> Received</div>';
        mapEl.appendChild(legend);
      },

      _offsetMapPosition: function (center, idx, groupSize) {
        if (groupSize <= 1) return center;
        var OFFSET = 0.0006; // ~60-70m at mid-latitudes — see LocalMap.js's identical constant
        var angle = (2 * Math.PI * idx) / groupSize;
        return [center[0] + OFFSET * Math.sin(angle), center[1] + OFFSET * Math.cos(angle)];
      },

      _loadAliases: function () {
        var self   = this;
        var handle = lively.identity.did.currentUser().handle;
        var base   = lively.identity.did.baseUrl();
        var xhr    = new XMLHttpRequest();
        xhr.open('GET', base + '/@' + handle + '/aliases');
        xhr.withCredentials = true;
        xhr.onload = function () {
          // See _loadReceived's identical guard for why this is needed.
          if (self._activeTab !== 'aliases') return;
          if (xhr.status !== 200) return self._showError('Could not load aliases (' + xhr.status + ')');
          var result;
          try { result = JSON.parse(xhr.responseText); } catch (e) { return self._showError('Bad response'); }
          self._renderAliasesList(result.aliases || []);
        };
        xhr.onerror = function () { if (self._activeTab === 'aliases') self._showError('Network error'); };
        xhr.send();
      },

      // Incoming pending friend requests + confirmed friends — two separate
      // FriendRegistry-backed routes (not postcard/object envelopes; see
      // that module's header comment for why), fetched together since both
      // back this one tab. Calls _renderFriendsList once both resolve.
      _loadFriends: function () {
        var self   = this;
        var handle = lively.identity.did.currentUser().handle;
        var base   = lively.identity.did.baseUrl();

        function getJSON(path) {
          return new Promise(function (resolve, reject) {
            var xhr = new XMLHttpRequest();
            xhr.open('GET', base + path);
            xhr.withCredentials = true;
            xhr.onload = function () {
              if (xhr.status !== 200) return reject(new Error('Request failed (' + xhr.status + ')'));
              try { resolve(JSON.parse(xhr.responseText)); } catch (e) { reject(e); }
            };
            xhr.onerror = function () { reject(new Error('Network error')); };
            xhr.send();
          });
        }

        Promise.all([
          getJSON('/@' + handle + '/friend-requests'),
          getJSON('/@' + handle + '/friend-requests?direction=sent'),
          getJSON('/@' + handle + '/friends'),
        ]).then(function (results) {
          // PostCardMailbox.open('friends') triggers this fetch pair
          // immediately after the constructor's own default-tab
          // _switchTab('received') already kicked off _loadReceived's XHR
          // (see MailboxClass.open below) — without this check, whichever
          // one resolves last wins and overwrites whatever the other
          // already (correctly) rendered, regardless of which tab is
          // actually showing. Confirmed live: opening straight to this tab
          // intermittently showed a stray Received postcard row on top of
          // it instead of the friends list.
          if (self._activeTab !== 'friends') return;
          self._renderFriendsList(results[0].requests || [], results[1].requests || [], results[2].friends || []);
        }).catch(function (err) {
          if (self._activeTab === 'friends') self._showError(err.message || 'Could not load friends');
        });
      },

      // ── rendering ─────────────────────────────────────────────────────────

      _renderReceivedRecords: function (records) {
        var self    = this;
        var content = this._contentDiv;
        content.innerHTML = '';

        if (!records.length) {
          content.innerHTML = self._emptyHtml('inbox', 'Your inbox is empty.');
          return;
        }

        // Filter chips: All / Replies (threads) / Postcards / Invites. The
        // choice lives on the morph so it survives the reloads a search or a
        // returning-from-a-thread triggers.
        var filter = self._inboxFilter || 'all';
        var isInviteRec = function (r) { return r.kind === 'constellation-invite'; };
        // An edit notice (r.edited === true) is its own row; a thread row can also carry
        // one (r.edited is then an object). Both count towards the unread total.
        var isEditRow = function (r) { return r.edited === true; };
        var unreadReplies = records.reduce(function (n, r) { return n + ((r.thread || isEditRow(r)) ? (r.unread || 0) : 0); }, 0);
        var chips = document.createElement('div');
        chips.className = 'pcm-chips';
        [['all', 'All'], ['replies', 'Replies'], ['cards', 'Postcards'], ['invites', 'Invites']].forEach(function (f) {
          var b = document.createElement('button');
          b.className = 'pcm-filter' + (filter === f[0] ? ' on' : '');
          b.textContent = f[1];
          if (f[0] === 'replies' && unreadReplies) {
            var n = document.createElement('span');
            n.className = 'n';
            n.textContent = unreadReplies + ' new';
            b.appendChild(n);
          }
          b.addEventListener('click', function () { self._inboxFilter = f[0]; self._renderReceivedRecords(records); });
          chips.appendChild(b);
        });
        if (unreadReplies) {
          var markAll = self._makeIconTextButton('done_all', 'Mark all read');
          markAll.style.marginLeft = 'auto';
          markAll.addEventListener('click', function () { self._markAllThreadsRead(); });
          chips.appendChild(markAll);
        }
        content.appendChild(chips);

        var shown = records.filter(function (r) {
          if (filter === 'replies') return !!r.thread || isEditRow(r);
          if (filter === 'invites') return !r.thread && !isEditRow(r) && isInviteRec(r);
          if (filter === 'cards')   return !r.thread && !isEditRow(r) && !isInviteRec(r);
          return true;
        });
        if (!shown.length) {
          content.appendChild(self._emptyEl('inbox', filter === 'replies' ? 'No replies yet.' : 'Nothing here.'));
          return;
        }

        shown.forEach(function (rec) {
          if (rec.thread) { content.appendChild(self._makeThreadRow(rec)); return; }
          if (isEditRow(rec)) { content.appendChild(self._wrapMutedIfNeeded(self._makeEditRow(rec), rec)); return; }
          var card = self._makeCard();

          var from = self._makeIdentityRow('From: ', rec.senderHandle, rec.senderDid);

          var id = document.createElement('div');
          id.style.cssText  = 'color:var(--pcm-text-secondary);font-size:11px;margin-bottom:3px;';
          id.textContent    = rec.title ? rec.title : 'Card: ' + rec.objId;

          var when = document.createElement('div');
          when.style.cssText = 'color:var(--pcm-text-tertiary);font-size:11px;';
          when.textContent   = self._formatDate(rec.sentAt);

          card.appendChild(from);
          // Constellation tag — lets a controller spot a join-request card
          // (or any other constellation-tagged card) in the list without
          // opening every row. rec.constellation/rec.kind are enriched
          // server-side onto this page's records only (bounded to the page
          // size, not the whole inbox log) — see ObjectRepository.js's
          // _enrichWithConstellationTag.
          var isInvite = rec.kind === 'constellation-invite';
          var isFlag = rec.kind === 'profile-flag';
          if (rec.constellation) {
            var isJoinRequest = rec.kind === 'constellation-join-request';
            var tag = document.createElement('div');
            tag.className = 'pcm-badge' + ((isJoinRequest || isInvite || isFlag) ? ' pcm-badge-warn' : '');
            tag.textContent = (isJoinRequest ? '📨 join request · ' : isInvite ? '✉️ invite · ' : isFlag ? '🚩 flagged profile report · ' : '') + 'c/' + rec.constellation;
            card.appendChild(tag);
          }
          card.appendChild(id);
          card.appendChild(when);

          // Invite accept/decline — inline on the card, per the "Invites"
          // door's design (see IdentityServer.js's /c/:name/invites routes):
          // unlike a join-request (whose Approve/Decline lives in
          // PostCardView.js, opened via this card's Open button), an invite
          // is addressed straight at the viewer, so acting on it belongs
          // right here rather than behind an extra click. There's no
          // pre-fetch of the invite's live status before rendering these
          // (unlike PostCardView.js's join-request check) — clicking
          // Accept/Decline on an already-resolved invite just surfaces the
          // server's 409 via _showError rather than silently no-opping, so
          // double-acting is safe even though a stale row (from before a
          // reload) still shows the buttons.
          if (isInvite) {
            var statusLine = document.createElement('div');
            statusLine.style.cssText = 'font-size:11px;color:var(--pcm-accent);font-weight:600;margin-top:4px;display:none;';
            card.appendChild(statusLine);

            var declineInviteBtn = self._makeIconTextButton('close', 'Decline', 'danger');
            var acceptInviteBtn  = self._makeIconTextButton('check', 'Accept', 'accent');
            function respond(action, btn, otherBtn, resultLabel) {
              btn.disabled = true;
              otherBtn.disabled = true;
              self._respondConstellationInvite(rec.constellation, action, function (err) {
                if (err) {
                  btn.disabled = false;
                  otherBtn.disabled = false;
                  return self._showError(err.message || 'Failed to respond to invite');
                }
                actionsCluster.style.display = 'none';
                statusLine.textContent = resultLabel;
                statusLine.style.display = 'block';
              });
            }
            declineInviteBtn.addEventListener('click', function () {
              respond('decline', declineInviteBtn, acceptInviteBtn, 'Declined.');
            });
            acceptInviteBtn.addEventListener('click', function () {
              respond('approve', acceptInviteBtn, declineInviteBtn, '✓ Joined c/' + rec.constellation + '.');
            });
            var actionsCluster = self._makeActionsCluster([declineInviteBtn, acceptInviteBtn]);
            card.appendChild(actionsCluster);
            content.appendChild(self._wrapMutedIfNeeded(card, rec));
            return;
          }

          var buttons = [];
          buttons.push(self._makeMenuBtn(function (anchorBtn) {
            self._toggleRowMenu(anchorBtn, [
              { label: '🔖 Save to Collections', onClick: function () {
                self._saveToCollections(rec.objId, function (ok) {
                  if (!ok) self._showError('Could not save to Collections');
                });
              } },
              { label: '🗑 Delete', danger: true, onClick: function () {
                self._hideFromMailbox(rec.objId, function () { self._loadReceived(); });
              } },
            ]);
          }));
          // /@:handle/... routes resolve handles, not DIDs — without a
          // senderHandle there is no working link to open, so omit the
          // Open button rather than ship a 404 (audit F4); Delete has no
          // such dependency, so it's always offered.
          if (rec.senderHandle) {
            buttons.push(self._makeInlineOpenBtn(function () {
              // In-world, same as the Delivered tab's Open button — not
              // window.open() to the standalone page, which has no working
              // live-render path (audit F2, deliberately not fixed; see
              // postcard_audit.md). PostCardView shows an Edit button of its
              // own when the viewer turns out to be the card's owner.
              lively.identity.PostCardView.open(rec.senderHandle, rec.objId);
            }));
          }
          card.appendChild(self._makeActionsCluster(buttons));
          content.appendChild(self._wrapMutedIfNeeded(card, rec));
        });
      },

      // ── reply threads ─────────────────────────────────────────────────────
      // Someone answered one of your postcards: the server folds every reply
      // to a card into one thread record (see ObjectRepository.js's
      // listInboxForHandle), shown here as a single row that jumps to the
      // top of the Inbox whenever a new reply lands.

      _makeThreadRow: function (rec) {
        var self = this;
        var card = this._makeCard();
        card.className += ' pcm-thread' + (rec.unread ? ' unread' : '');
        card.tabIndex = 0;
        card.setAttribute('role', 'button');

        var latest = rec.latest || {};
        var who = latest.senderHandle || null;
        var img = document.createElement('img');
        img.style.cssText = 'width:40px;height:40px;border-radius:50%;flex:none;border:1px solid var(--pcm-border);box-sizing:border-box;';
        img.src = lively.identity.postCardUtils.identiconDataUrl(who || latest.senderDid || '', 40);
        card.appendChild(img);
        if (who) {
          fetch(lively.identity.did.baseUrl() + '/@' + encodeURIComponent(who) + '/profile', { credentials: 'include' })
            .then(function (res) { return res.ok ? res.json() : null; })
            .then(function (env) {
              var url = env && env.record && env.record.payload && env.record.payload.avatarUrl;
              if (url) img.src = url;
            })
            .catch(function () {});
        }

        var body = document.createElement('div');
        body.className = 'body';

        var l1 = document.createElement('div');
        l1.className = 'l1';
        var kind = document.createElement('span');
        kind.className = 'pcm-kind';
        kind.textContent = 'Replies';
        var ttl = document.createElement('span');
        ttl.className = 'ttl';
        ttl.textContent = rec.title || 'Untitled postcard';
        var when = document.createElement('span');
        when.className = 'when';
        when.textContent = (rec.muted ? '🔕 ' : '') + self._formatDate(rec.sentAt);
        l1.appendChild(kind);
        l1.appendChild(ttl);
        l1.appendChild(when);
        body.appendChild(l1);

        var names = (rec.participants || []).map(function (h) { return '@' + h; });
        var who2 = names.length <= 1 ? names.join('') :
          names.length === 2 ? names[0] + ' and ' + names[1] :
          names.slice(0, 2).join(', ') + ' and ' + (names.length - 2) + ' more';
        var l2 = document.createElement('div');
        l2.className = 'l2';
        l2.textContent = (who2 ? who2 + ' · ' : '') +
          // The unread count of a row that carries an edit notice includes the edit, so it can
          // exceed the reply count; say "N new" after the edit instead of "N new of M replies".
          (rec.edited
            ? rec.replyCount + (rec.replyCount === 1 ? ' reply' : ' replies') +
              ' · edited by @' + (rec.edited.senderHandle || 'the author') + (rec.unread ? ' · ' + rec.unread + ' new' : '')
            : (rec.unread ? rec.unread + ' new of ' + rec.replyCount : rec.replyCount + (rec.replyCount === 1 ? ' reply' : ' replies'))) +
          (rec.visibility && rec.visibility !== 'public' ? ' · private' : '');
        body.appendChild(l2);
        card.appendChild(body);

        if (rec.unread) {
          var side = document.createElement('div');
          side.className = 'side';
          var count = document.createElement('span');
          count.className = 'pcm-count';
          count.textContent = rec.unread;
          side.appendChild(count);
          card.appendChild(side);
        }

        card.addEventListener('click', function () { self._openThread(rec); });
        card.addEventListener('keydown', function (e) {
          if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); self._openThread(rec); }
        });
        return card;
      },

      // Someone changed a card you can read (the server files this when an edit
      // session starts, see EditTracking.js; it carries no content). The row opens
      // what changed, worked out in this browser.
      _makeEditRow: function (rec) {
        var self = this;
        var card = this._makeCard();
        card.className += ' pcm-thread' + (rec.unread ? ' unread' : '');
        card.tabIndex = 0;
        card.setAttribute('role', 'button');

        var who = rec.senderHandle || null;
        var img = document.createElement('img');
        img.style.cssText = 'width:40px;height:40px;border-radius:50%;flex:none;border:1px solid var(--pcm-border);box-sizing:border-box;';
        img.src = lively.identity.postCardUtils.identiconDataUrl(who || rec.senderDid || '', 40);
        card.appendChild(img);

        var body = document.createElement('div');
        body.className = 'body';
        var l1 = document.createElement('div');
        l1.className = 'l1';
        var kind = document.createElement('span');
        kind.className = 'pcm-kind';
        kind.textContent = 'Edited';
        var ttl = document.createElement('span');
        ttl.className = 'ttl';
        ttl.textContent = rec.title || 'Untitled postcard';
        var when = document.createElement('span');
        when.className = 'when';
        when.textContent = (rec.muted ? '🔕 ' : '') + self._formatDate(rec.sentAt);
        l1.appendChild(kind);
        l1.appendChild(ttl);
        l1.appendChild(when);
        body.appendChild(l1);
        var l2 = document.createElement('div');
        l2.className = 'l2';
        l2.textContent = (who ? '@' + who : 'The author') + ' changed this postcard · tap to see what changed';
        body.appendChild(l2);
        card.appendChild(body);

        var side = null;
        if (rec.unread) {
          side = document.createElement('div');
          side.className = 'side';
          var count = document.createElement('span');
          count.className = 'pcm-count';
          count.textContent = rec.unread;
          side.appendChild(count);
          card.appendChild(side);
        }

        var open = function () { self._openEditNotice(rec, card, side); };
        card.addEventListener('click', open);
        card.addEventListener('keydown', function (e) {
          if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); }
        });
        return card;
      },

      _openEditNotice: function (rec, card, side) {
        var self = this;
        var user = lively.identity.did.currentUser();
        if (!user) return;
        if (rec.unread) {
          rec.unread = 0;
          card.className = card.className.replace(' unread', '');
          if (side) side.remove();
          var xhr = new XMLHttpRequest();
          xhr.open('POST', lively.identity.did.baseUrl() + '/@' + encodeURIComponent(user.handle) + '/inbox/threads/' + encodeURIComponent(rec.objId) + '/read');
          xhr.withCredentials = true;
          xhr.setRequestHeader('Content-Type', 'application/json');
          xhr.onload = function () { self._refreshInboxBadge(); };
          xhr.send('{}');
        }
        lively.identity.postcardEdits.openDialog({
          handle: rec.senderHandle,
          objId: rec.objId,
          title: rec.title,
          editedAt: rec.sentAt,
        });
      },

      // Replaces the Inbox list with the conversation under one card. The
      // thread view owns _contentDiv's whole area (header, scroller,
      // composer) until _switchTab('received') gives it back.
      _openThread: function (rec) {
        var self = this;
        var user = lively.identity.did.currentUser();
        if (!user) return;
        this._closePostcardMenu();
        if (this._threadCtrl) { this._threadCtrl.destroy(); this._threadCtrl = null; }
        if (this._searchBar) this._searchBar.style.display = 'none';
        var c = this._contentDiv;
        c.style.top = '44px';
        c.style.padding = '0';
        c.style.overflowY = 'hidden';
        c.innerHTML = '';
        var host = document.createElement('div');
        host.style.cssText = 'position:absolute;top:0;left:0;right:0;bottom:0;';
        c.appendChild(host);
        this._threadCtrl = lively.identity.mailboxThread.mount(host, {
          rootHandle: rec.authorHandle || user.handle,
          rootObjId: rec.rootObjId,
          title: rec.title,
          inbox: true,
          onBack: function () { self._switchTab('received'); },
          onRead: function () { self._refreshInboxBadge(); },
        });
      },

      // The Inbox tab's unread-reply badge. n === 0 removes it.
      _setInboxBadge: function (n) {
        // n is always the unread total across every thread, so the menu
        // bar's dot can follow it.
        var bar = lively.identity.MenuBarEntry;
        if (bar && bar.setUnreadReplies) bar.setUnreadReplies(n);
        var btn = this._tabBtns && this._tabBtns.received;
        if (!btn) return;
        var old = btn.querySelector('.pcm-tab-badge');
        if (old) old.remove();
        if (!n) return;
        var badge = document.createElement('span');
        badge.className = 'pcm-tab-badge';
        badge.textContent = n > 99 ? '99+' : String(n);
        btn.appendChild(badge);
      },

      // Re-reads just the unread total (limit=1 keeps it cheap) after a
      // thread is opened, muted or marked read.
      _refreshInboxBadge: function () {
        var self = this;
        var user = lively.identity.did.currentUser();
        if (!user) return;
        var xhr = new XMLHttpRequest();
        xhr.open('GET', lively.identity.did.baseUrl() + '/@' + user.handle + '/inbox?limit=1');
        xhr.withCredentials = true;
        xhr.onload = function () {
          if (xhr.status !== 200) return;
          try { self._setInboxBadge(JSON.parse(xhr.responseText).unreadReplies || 0); } catch (e) { /* badge stays as is */ }
        };
        xhr.send();
      },

      _markAllThreadsRead: function () {
        var self = this;
        var user = lively.identity.did.currentUser();
        if (!user) return;
        var xhr = new XMLHttpRequest();
        xhr.open('POST', lively.identity.did.baseUrl() + '/@' + user.handle + '/inbox/threads/read-all');
        xhr.withCredentials = true;
        xhr.setRequestHeader('Content-Type', 'application/json');
        xhr.onload = function () {
          if (xhr.status !== 200) return self._showError('Could not mark replies read (' + xhr.status + ')');
          self._loadReceived();
        };
        xhr.onerror = function () { self._showError('Network error'); };
        xhr.send('{}');
      },

      // De-emphasizes a fully-built received-record card for a muted sender
      // (DID.js's relationships category — "Ignore" from MiniProfileCard.js)
      // — moves whatever content the card already has into a hidden wrapper
      // and shows a one-line "click to show" summary instead. Works
      // regardless of the card's internal structure (plain postcard or the
      // invite branch's extra buttons), since it just relocates whatever
      // children already exist rather than special-casing them. No-op
      // (returns card unchanged) when the sender isn't muted.
      _wrapMutedIfNeeded: function (card, rec) {
        if (!lively.identity.did.isMuted(rec.senderDid, rec.senderHandle)) return card;
        var wrap = document.createElement('div');
        while (card.firstChild) wrap.appendChild(card.firstChild);
        wrap.style.display = 'none';
        var summary = document.createElement('div');
        summary.style.cssText = 'font-size:11px;color:var(--pcm-text-tertiary);cursor:pointer;text-decoration:underline;padding:2px 0;';
        summary.textContent = 'Message from ignored profile — click to show';
        card.style.opacity = '0.55';
        card.appendChild(summary);
        card.appendChild(wrap);
        summary.addEventListener('click', function (e) {
          // A row that is itself clickable (an edit notice) must not also act on this.
          e.stopPropagation();
          var showing = wrap.style.display !== 'none';
          wrap.style.display = showing ? 'none' : '';
          card.style.opacity = showing ? '0.55' : '1';
          summary.textContent = showing
            ? 'Message from ignored profile — click to show'
            : 'Message from ignored profile (click to hide)';
        });
        return card;
      },

      _renderCollectionsRecords: function (records) {
        var self    = this;
        var content = this._contentDiv;
        content.innerHTML = '';

        if (!records.length) {
          content.innerHTML = self._emptyHtml('collections_bookmark', 'No saved items yet.');
          return;
        }

        records.forEach(function (rec) {
          var card = self._makeCard();

          var title = document.createElement('div');
          title.style.cssText = 'font-weight:600;color:var(--pcm-text);margin-bottom:3px;padding-right:76px;';
          title.textContent   = (rec.state && rec.state.title) || '(untitled)';
          card.appendChild(title);

          card.appendChild(self._makeIdentityRow('By: ', rec.senderHandle, rec.did));

          // Same constellation-badge idiom as _renderReceivedRecords, minus
          // the join-request/invite kinds — a saved card is never one of
          // those (they're addressed at the viewer, not something you'd
          // bookmark for later).
          if (rec.constellation) {
            var tag = document.createElement('div');
            tag.className = 'pcm-badge';
            tag.textContent = 'c/' + rec.constellation;
            card.appendChild(tag);
          }

          var when = document.createElement('div');
          when.style.cssText = 'color:var(--pcm-text-tertiary);font-size:11px;';
          when.textContent   = 'Saved ' + self._formatDate(rec.savedAt);
          card.appendChild(when);

          var menuBtn = self._makeMenuBtn(function (anchorBtn) {
            self._toggleRowMenu(anchorBtn, [
              { label: '🔖 Remove from Collections', danger: true, onClick: function () {
                self._removeFromCollections(rec.objId, function () { self._loadCollections(); });
              } },
            ]);
          });

          // Same audit-F4 guard as _renderReceivedRecords: no working
          // /@:handle/... link without a resolved senderHandle.
          var buttons = [menuBtn];
          if (rec.senderHandle) {
            buttons.push(self._makeInlineOpenBtn(function () {
              lively.identity.PostCardView.open(rec.senderHandle, rec.objId);
            }));
          }
          card.appendChild(self._makeActionsCluster(buttons));
          content.appendChild(card);
        });
      },

      _renderDeliveryRecords: function (records, status) {
        var self    = this;
        var content = this._contentDiv;
        content.innerHTML = '';

        var emptyMsg = status === 'returned'
          ? 'No returned postcards.'
          : 'No sent postcards yet.';

        if (!records.length) {
          content.innerHTML = self._emptyHtml(status === 'returned' ? 'assignment_return' : 'outbox', emptyMsg);
          return;
        }

        records.forEach(function (rec) {
          var card = self._makeCard();

          if (rec.status === 'returned') {
            var badge = document.createElement('span');
            badge.className = 'pcm-badge pcm-badge-danger';
            badge.textContent = rec.reply ? '✉ Reply returned' : '✉ Returned';
            card.appendChild(badge);
          }

          var to = self._makeIdentityRow('To: ', rec.recipientHandle, null);

          // A returned reply was never shown to anyone and its stored copy
          // is marked deleted, so there is no card to open; say what it was
          // a reply to instead.
          var id = document.createElement('div');
          id.style.cssText  = 'color:var(--pcm-text-secondary);font-size:11px;margin-bottom:3px;';
          id.textContent    = rec.reply
            ? 'Your reply to “' + (rec.rootTitle || 'a postcard') + '”'
            : 'Card: ' + rec.objId;

          var when = document.createElement('div');
          when.style.cssText = 'color:var(--pcm-text-tertiary);font-size:11px;';
          when.textContent   = self._formatDate(rec.sentAt);

          var openBtn = self._makeInlineOpenBtn(function () {
            var user = lively.identity.did.currentUser();
            // _handle is bare (no '@') — PostCardView prepends '/@' itself
            // when building its GET URL.
            lively.identity.PostCardView.open(user.handle, rec.objId);
          });
          var menuBtn = self._makeMenuBtn(function (anchorBtn) {
            self._toggleRowMenu(anchorBtn, [
              { label: '🔖 Save to Collections', onClick: function () {
                self._saveToCollections(rec.objId, function (ok) {
                  if (!ok) self._showError('Could not save to Collections');
                });
              } },
              { label: '🗑 Delete', danger: true, onClick: function () {
                self._hideFromMailbox(rec.objId, function () { self._loadDeliveries(status); });
              } },
            ]);
          });

          card.appendChild(to);
          card.appendChild(id);
          if (rec.reply) card.appendChild(self._makeReturnedReplyQuote(rec));
          card.appendChild(when);
          card.appendChild(self._makeActionsCluster(rec.reply ? [menuBtn] : [menuBtn, openBtn]));
          content.appendChild(card);
        });
      },

      _renderBlockedList: function (blockedHandles) {
        var self    = this;
        var content = this._contentDiv;
        content.innerHTML = '';

        var addRow = document.createElement('div');
        addRow.style.cssText = 'display:flex;gap:6px;margin-bottom:12px;';

        var input = document.createElement('input');
        input.type = 'text';
        input.placeholder = 'handle to block (no @)';
        input.className = 'pcm-row-input';
        addRow.appendChild(input);

        var addBtn = document.createElement('button');
        addBtn.textContent = 'Block';
        addBtn.className = 'pcm-btn pcm-btn-danger';
        function submitBlock() {
          var h = input.value.trim().replace(/^@/, '');
          if (!h) return;
          addBtn.disabled = true;
          self._blockHandle(h, function (err) {
            addBtn.disabled = false;
            if (err) return self._showError(err.message || 'Failed to block');
            input.value = '';
            self._loadBlocked();
          });
        }
        addBtn.addEventListener('click', submitBlock);
        input.addEventListener('keydown', function (e) { if (e.key === 'Enter') submitBlock(); });
        addRow.appendChild(addBtn);
        content.appendChild(addRow);

        if (!blockedHandles.length) {
          content.appendChild(self._emptyEl('block', 'No blocked handles.'));
          return;
        }

        blockedHandles.forEach(function (h) {
          var card = self._makeCard();

          card.appendChild(self._makeIdentityRow('', h, null));

          var removeBtn = document.createElement('button');
          removeBtn.textContent = 'Unblock';
          removeBtn.className = 'pcm-btn pcm-btn-ghost-danger';
          removeBtn.style.cssText = 'position:absolute;top:10px;right:10px;';
          removeBtn.addEventListener('click', function () {
            removeBtn.disabled = true;
            self._unblockHandle(h, function (err) {
              removeBtn.disabled = false;
              if (err) return self._showError(err.message || 'Failed to unblock');
              self._loadBlocked();
            });
          });
          card.appendChild(removeBtn);
          content.appendChild(card);
        });
      },

      // Forwarding aliases (§3.2) — a rotatable, randomly generated handle
      // is server-generated on demand (no text input like Block's, since
      // aliases are never user-chosen), listed with Copy + Revoke.
      _renderAliasesList: function (aliases) {
        var self    = this;
        var content = this._contentDiv;
        content.innerHTML = '';

        var intro = document.createElement('div');
        intro.style.cssText = 'color:var(--pcm-text-tertiary);font-size:11px;margin-bottom:10px;line-height:1.4;';
        intro.textContent = 'Give out an alias instead of your primary handle to reduce spam exposure. ' +
          'Mail sent to any alias lands in your normal inbox. Revoke one at any time without affecting the others.';
        content.appendChild(intro);

        var addRow = document.createElement('div');
        addRow.style.cssText = 'margin-bottom:12px;';
        var genBtn = document.createElement('button');
        genBtn.textContent = 'Generate new alias';
        genBtn.className = 'pcm-btn pcm-btn-accent';
        genBtn.addEventListener('click', function () {
          genBtn.disabled = true;
          self._generateAlias(function (err) {
            genBtn.disabled = false;
            if (err) return self._showError(err.message || 'Failed to generate alias');
            self._loadAliases();
          });
        });
        addRow.appendChild(genBtn);
        content.appendChild(addRow);

        if (!aliases.length) {
          content.appendChild(self._emptyEl('alternate_email', 'No active aliases.'));
          return;
        }

        aliases.forEach(function (a) {
          var card = self._makeCard();

          var label = document.createElement('div');
          label.style.cssText = 'font-weight:600;color:var(--pcm-text);font-family:monospace;margin-bottom:3px;padding-right:120px;';
          label.textContent = '@' + a.handle;
          card.appendChild(label);

          var when = document.createElement('div');
          when.style.cssText = 'color:var(--pcm-text-tertiary);font-size:11px;';
          when.textContent = 'Created ' + self._formatDate(a.created_at);
          card.appendChild(when);

          var copyBtn = document.createElement('button');
          copyBtn.textContent = 'Copy';
          copyBtn.className = 'pcm-btn pcm-btn-accent';
          copyBtn.addEventListener('click', function () {
            self._copyToClipboard('@' + a.handle, copyBtn);
          });

          var revokeBtn = document.createElement('button');
          revokeBtn.textContent = 'Revoke';
          revokeBtn.className = 'pcm-btn pcm-btn-ghost-danger';
          revokeBtn.addEventListener('click', function () {
            self.world().confirm(
              'Revoke @' + a.handle + '? Anyone still using it will get the same "not deliverable" ' +
              'response as an unknown handle — this can\'t be undone.',
              function (answer) {
                if (!answer) return;
                revokeBtn.disabled = true;
                self._revokeAliasHandle(a.handle, function (err) {
                  revokeBtn.disabled = false;
                  if (err) return self._showError(err.message || 'Failed to revoke alias');
                  self._loadAliases();
                });
              }
            );
          });

          card.appendChild(self._makeActionsCluster([copyBtn, revokeBtn]));
          content.appendChild(card);
        });
      },

      // requests: [{did, handle, requestedAt}] (incoming, pending only —
      // already filtered server-side). friends: [{did, handle, since}].
      // Two sections in one tab, each with its own empty state, matching
      // the constellation lounge's own request-list-with-actions pattern
      // (approve/decline) this route set was modeled on. Three sections:
      // incoming (requests you can accept/decline), outgoing (requests you
      // sent, cancellable), and confirmed friends (removable).
      _renderFriendsList: function (requests, sent, friends) {
        var self    = this;
        var content = this._contentDiv;
        content.innerHTML = '';

        function heading(text, topMargin) {
          var h = document.createElement('div');
          h.style.cssText = 'font-weight:600;color:var(--pcm-text-secondary);font-size:11px;text-transform:uppercase;letter-spacing:.04em;margin:' + topMargin + 'px 0 8px;';
          h.textContent = text;
          content.appendChild(h);
        }

        function emptyMsg(text) {
          var e = document.createElement('div');
          e.style.cssText = 'color:var(--pcm-text-tertiary);padding:4px 0 16px;font-size:12.5px;';
          e.textContent = text;
          content.appendChild(e);
        }

        heading('Requests', 4);
        if (!requests.length) {
          emptyMsg('No pending friend requests.');
        } else {
          requests.forEach(function (r) {
            var card = self._makeCard();
            card.appendChild(self._makeIdentityRow('', r.handle, r.did));

            var when = document.createElement('div');
            when.style.cssText = 'color:var(--pcm-text-tertiary);font-size:11px;';
            when.textContent = self._formatDate(r.requestedAt);
            card.appendChild(when);

            var declineBtn = self._makeIconTextButton('close', 'Decline', 'danger');
            declineBtn.addEventListener('click', function () {
              declineBtn.disabled = true;
              self._respondFriendRequest(r.did, 'decline', function (err) {
                declineBtn.disabled = false;
                if (err) return self._showError(err.message || 'Failed to decline request');
                self._loadFriends();
              });
            });

            var acceptBtn = self._makeIconTextButton('check', 'Accept', 'accent');
            acceptBtn.addEventListener('click', function () {
              acceptBtn.disabled = true;
              self._respondFriendRequest(r.did, 'approve', function (err) {
                acceptBtn.disabled = false;
                if (err) return self._showError(err.message || 'Failed to accept request');
                self._loadFriends();
              });
            });

            card.appendChild(self._makeActionsCluster([declineBtn, acceptBtn]));
            content.appendChild(card);
          });
        }

        heading('Sent', 12);
        if (!sent.length) {
          emptyMsg('No outstanding sent requests.');
        } else {
          sent.forEach(function (s) {
            var card = self._makeCard();
            card.appendChild(self._makeIdentityRow('', s.handle, s.did));

            var when = document.createElement('div');
            when.style.cssText = 'color:var(--pcm-text-tertiary);font-size:11px;';
            when.textContent = self._formatDate(s.requestedAt);
            card.appendChild(when);

            var cancelBtn = self._makeIconTextButton('cancel', 'Cancel', 'danger');
            cancelBtn.style.position = 'absolute';
            cancelBtn.style.top = '10px';
            cancelBtn.style.right = '10px';
            cancelBtn.addEventListener('click', function () {
              cancelBtn.disabled = true;
              self._cancelFriendRequest(s.did, function (err) {
                cancelBtn.disabled = false;
                if (err) return self._showError(err.message || 'Failed to cancel request');
                self._loadFriends();
              });
            });
            card.appendChild(cancelBtn);
            content.appendChild(card);
          });
        }

        heading('Friends', 12);
        if (!friends.length) {
          emptyMsg('No friends yet.');
        } else {
          friends.forEach(function (f) {
            var card = self._makeCard();
            card.appendChild(self._makeIdentityRow('', f.handle, f.did));

            var since = document.createElement('div');
            since.style.cssText = 'color:var(--pcm-text-tertiary);font-size:11px;';
            since.textContent = 'Friends since ' + self._formatDate(f.since);
            card.appendChild(since);

            var removeBtn = self._makeIconTextButton('person_remove', 'Remove', 'danger');
            removeBtn.style.position = 'absolute';
            removeBtn.style.top = '10px';
            removeBtn.style.right = '10px';
            removeBtn.addEventListener('click', function () {
              self.world().confirm('Remove @' + (f.handle || f.did) + ' as a friend?', function (answer) {
                if (!answer) return;
                removeBtn.disabled = true;
                self._removeFriend(f.did, function (err) {
                  removeBtn.disabled = false;
                  if (err) return self._showError(err.message || 'Failed to remove friend');
                  self._loadFriends();
                });
              });
            });
            card.appendChild(removeBtn);
            content.appendChild(card);
          });
        }
      },

      _renderOwnRecords: function (postcards) {
        var self    = this;
        var content = this._contentDiv;
        var handle  = lively.identity.did.currentUser().handle;
        content.innerHTML = '';

        if (!postcards.length) {
          content.innerHTML = self._emptyHtml('draft', 'No postcards yet.');
          return;
        }

        postcards.forEach(function (pc) {
          var card = self._makeCard();

          var title = document.createElement('div');
          title.style.cssText = 'font-weight:600;color:var(--pcm-text);margin-bottom:3px;padding-right:76px;';
          title.textContent   = (pc.state && pc.state.title) || '(untitled)';

          var meta = document.createElement('div');
          meta.style.cssText = 'color:var(--pcm-text-tertiary);font-size:11px;';
          meta.textContent   = (pc.visibility || 'public') + ' · ' + self._formatDate(pc.created);

          card.appendChild(title);
          card.appendChild(meta);

          var menuBtn = self._makeMenuBtn(function (anchorBtn) {
            self._toggleRowMenu(anchorBtn, [
              { label: '🔖 Save to Collections', onClick: function () {
                self._saveToCollections(pc.objId, function (ok) {
                  if (!ok) self._showError('Could not save to Collections');
                });
              } },
              { label: '🗑 Delete', danger: true, onClick: function () { self._deletePostcard(handle, pc); } },
            ]);
          });
          var openBtn = self._makeInlineOpenBtn(function () {
            lively.identity.PostCardView.open(handle, pc.objId);
          });

          card.appendChild(self._makeActionsCluster([menuBtn, openBtn]));
          content.appendChild(card);
        });
      },

      // Add-feed row + subscribed-feed chips + a merged, newest-first entry
      // list fetched through RssProxyServer.js. Every feed-supplied string
      // (title/summary/link) is untrusted third-party content — this
      // renders it via textContent/href assignment only, never innerHTML,
      // and _safeHref below blocks a javascript: URL hiding in a malicious
      // feed's <link>.
      _renderRssTab: function (feeds) {
        var self    = this;
        var content = this._contentDiv;
        content.innerHTML = '';

        var addRow = document.createElement('div');
        addRow.style.cssText = 'display:flex;gap:6px;margin-bottom:12px;';
        var input = document.createElement('input');
        input.type = 'text';
        input.placeholder = 'https://example.com/feed.xml';
        input.className = 'pcm-row-input';
        addRow.appendChild(input);
        var addBtn = document.createElement('button');
        addBtn.textContent = 'Add';
        addBtn.className = 'pcm-btn pcm-btn-accent';
        function submitAdd() {
          var url = input.value.trim();
          if (!url) return;
          addBtn.disabled = true;
          self._addRssFeed(url, function (err) {
            addBtn.disabled = false;
            if (err) return self._showError(err.message || 'Failed to add feed');
            input.value = '';
            self._loadRssFeeds();
          });
        }
        addBtn.addEventListener('click', submitAdd);
        input.addEventListener('keydown', function (e) { if (e.key === 'Enter') submitAdd(); });
        addRow.appendChild(addBtn);
        content.appendChild(addRow);

        if (!feeds.length) {
          content.appendChild(self._emptyEl('rss_feed', 'No feeds yet — add an RSS or Atom feed URL above.'));
          return;
        }

        var chipsRow = document.createElement('div');
        chipsRow.style.cssText = 'display:flex;flex-wrap:wrap;gap:6px;margin-bottom:12px;';
        feeds.forEach(function (feed) {
          var chip = document.createElement('div');
          chip.className = 'pcm-chip';
          var label = document.createElement('span');
          label.style.cssText = 'overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
          label.textContent = feed.url;
          chip.appendChild(label);
          var removeBtn = document.createElement('span');
          removeBtn.textContent = '✕';
          removeBtn.title = 'Unsubscribe';
          removeBtn.style.cssText = 'cursor:pointer;font-weight:600;flex-shrink:0;';
          removeBtn.addEventListener('click', function () {
            self._removeRssFeed(feed.url, function (err) {
              if (err) return self._showError(err.message || 'Failed to remove feed');
              self._loadRssFeeds();
            });
          });
          chip.appendChild(removeBtn);
          chipsRow.appendChild(chip);
        });
        content.appendChild(chipsRow);

        var entriesDiv = document.createElement('div');
        entriesDiv.innerHTML = this._emptyHtml('hourglass_top', 'Loading entries…');
        content.appendChild(entriesDiv);

        this._fetchFeedEntries(feeds, function (entries, errors) {
          if (self._activeTab !== 'rss') return;
          entriesDiv.innerHTML = '';

          var errorUrls = Object.keys(errors);
          errorUrls.forEach(function (url) {
            var errDiv = document.createElement('div');
            errDiv.style.cssText = [
              'color:var(--pcm-danger)', 'font-size:11px', 'padding:6px 10px', 'margin-bottom:8px',
              'background:var(--pcm-danger-soft)', 'border:1px solid var(--pcm-danger-soft-border)',
              'border-radius:var(--pcm-radius-sm)', 'word-break:break-all',
            ].join(';');
            errDiv.textContent = 'Could not load ' + url + ': ' + errors[url];
            entriesDiv.appendChild(errDiv);
          });

          if (!entries.length) {
            entriesDiv.appendChild(self._emptyEl('rss_feed', errorUrls.length
              ? 'No entries could be loaded — see the error' + (errorUrls.length > 1 ? 's' : '') + ' above.'
              : 'No entries found in your subscribed feeds.'));
            return;
          }
          entries.forEach(function (entry) {
            var card = self._makeCard();

            var feedBadge = document.createElement('div');
            feedBadge.className = 'pcm-badge';
            feedBadge.textContent = entry.feedTitle;
            card.appendChild(feedBadge);

            var titleEl = document.createElement('div');
            titleEl.style.cssText = 'font-weight:600;color:var(--pcm-text);margin-bottom:3px;';
            var safeLink = self._safeHref(entry.link);
            if (safeLink) {
              var a = document.createElement('a');
              a.href = safeLink;
              a.target = '_blank';
              a.rel = 'noopener noreferrer';
              a.style.cssText = 'color:var(--pcm-text);text-decoration:none;';
              a.textContent = entry.title || '(untitled)';
              titleEl.appendChild(a);
            } else {
              titleEl.textContent = entry.title || '(untitled)';
            }
            card.appendChild(titleEl);

            if (entry.published) {
              var when = document.createElement('div');
              when.style.cssText = 'color:var(--pcm-text-tertiary);font-size:11px;margin-bottom:4px;';
              when.textContent = self._formatDate(entry.published);
              card.appendChild(when);
            }

            if (entry.summary) {
              var summary = document.createElement('div');
              summary.style.cssText = 'color:var(--pcm-text-secondary);font-size:12px;line-height:1.4;';
              summary.textContent = entry.summary;
              card.appendChild(summary);
            }

            entriesDiv.appendChild(card);
          });
        });
      },

      // Only http(s)/mailto get through — blocks a javascript: (or other
      // executable-scheme) URL hiding in a feed's <link>, same rule
      // PostCardUtils.js's own internal safeHref applies to postcard body
      // content, duplicated here rather than exported since it's this
      // small (see LocalMap.js's _ensureGeoRuntime comment on this
      // codebase's tolerance for small per-module copies).
      _safeHref: function (raw) {
        var s = String(raw || '').trim();
        if (!s) return null;
        var m = /^([a-z][a-z0-9+.\-]*):/i.exec(s);
        if (!m) return s; // relative/anchor — allowed
        var scheme = m[1].toLowerCase();
        return (scheme === 'http' || scheme === 'https' || scheme === 'mailto') ? s : null;
      },

      // ── shared row-action helpers ────────────────────────────────────────

      // A single top-right [⋯][Open]-shaped cluster — every row in this
      // file has more than one action now, hence a shared flex wrapper
      // rather than a single self-positioning button.
      _makeActionsCluster: function (buttons) {
        var wrap = document.createElement('div');
        wrap.style.cssText = 'position:absolute;top:10px;right:10px;display:flex;gap:6px;align-items:center;';
        buttons.forEach(function (b) { wrap.appendChild(b); });
        return wrap;
      },

      _makeMenuBtn: function (onClick) {
        var btn = document.createElement('button');
        btn.className = 'pcm-icon-btn';
        btn.title = 'More actions';
        var glyph = document.createElement('span');
        glyph.className = 'pcm-icon-btn-glyph';
        glyph.textContent = 'more_horiz';
        btn.appendChild(glyph);
        btn.addEventListener('click', function (e) { e.stopPropagation(); onClick(btn); });
        return btn;
      },

      // "Open" styled to sit inside _makeActionsCluster's flex row (no
      // self-positioning, unlike a standalone action button would need).
      _makeInlineOpenBtn: function (onClick) {
        var btn = document.createElement('button');
        btn.textContent = 'Open';
        btn.className = 'pcm-btn pcm-btn-accent';
        btn.addEventListener('click', onClick);
        return btn;
      },

      // Icon + text action button (Accept/Decline/Cancel/Remove) — renders
      // through the vendored Material Symbols Rounded font
      // (core/styles/material-symbols.css, loaded once per world) by
      // setting a span's content to the icon's ligature name, same
      // technique as AmbientPresencePanel.js's makeIconButton but paired
      // with a real text label here rather than icon-only. `variant` is
      // 'accent' or 'danger', matching the pcm-btn-* classes.
      _makeIconTextButton: function (glyph, label, variant) {
        var btn = document.createElement('button');
        btn.className = 'pcm-btn pcm-btn-' + variant;
        var icon = document.createElement('span');
        icon.className = 'pcm-btn-icon-glyph';
        icon.textContent = glyph;
        btn.appendChild(icon);
        btn.appendChild(document.createTextNode(label));
        return btn;
      },

      // ── ⋯ menu — items: [{ label, danger, onClick }] ────────────────────────

      _toggleRowMenu: function (anchorBtn, items) {
        var self = this;
        var reopening = this._openMenuAnchor === anchorBtn;
        this._closePostcardMenu();
        if (reopening) return; // second click on the same ⋯ just closes it

        var menu = document.createElement('div');
        menu.className = 'pcm-menu';

        // Positioned relative to _contentDiv (its nearest positioned
        // ancestor) using getBoundingClientRect math, accounting for
        // its current scroll offset, so the menu tracks the row it
        // belongs to rather than a fixed spot.
        var anchorRect  = anchorBtn.getBoundingClientRect();
        var contentRect = this._contentDiv.getBoundingClientRect();
        menu.style.top   = (anchorRect.bottom - contentRect.top + this._contentDiv.scrollTop + 4) + 'px';
        menu.style.right = (contentRect.right - anchorRect.right) + 'px';

        items.forEach(function (item) {
          var itemBtn = document.createElement('button');
          itemBtn.textContent = item.label;
          itemBtn.className = 'pcm-menu-item' + (item.danger ? ' danger' : '');
          itemBtn.addEventListener('click', function (e) {
            e.stopPropagation();
            self._closePostcardMenu();
            item.onClick();
          });
          menu.appendChild(itemBtn);
        });

        this._contentDiv.appendChild(menu);
        this._openMenuEl = menu;
        this._openMenuAnchor = anchorBtn;

        // Deferred to the next tick so the same click that opened the menu
        // (bubbling to document) doesn't immediately close it.
        setTimeout(function () {
          self._menuCloseHandler = function () { self._closePostcardMenu(); };
          document.addEventListener('click', self._menuCloseHandler);
        }, 0);
      },

      _closePostcardMenu: function () {
        if (this._openMenuEl && this._openMenuEl.parentNode) {
          this._openMenuEl.parentNode.removeChild(this._openMenuEl);
        }
        this._openMenuEl = null;
        this._openMenuAnchor = null;
        if (this._menuCloseHandler) {
          document.removeEventListener('click', this._menuCloseHandler);
          this._menuCloseHandler = null;
        }
      },

      // §6.3, tombstone path — this codebase has no wiki-mode postcards yet
      // (§1.2 is unbuilt; every card today is single-author), so this is
      // scoped to the one authorization rule that's actually real right
      // now: author-only (this tab only ever lists the current user's own
      // cards in the first place, so there's no separate ownership check
      // needed beyond that).
      //
      // The "has this ever been delivered, so use per-mailbox-hide instead"
      // decision is now partially implemented: a GET happens first so
      // state.sentAt (§2.5) can be checked before picking a mechanism — a
      // frozen card (delivered to a different DID at least once) delegates
      // straight to _hideFromMailbox instead of attempting a tombstone PUT,
      // which would otherwise 409 (PUT /@:handle/:objId rejects EVERY write
      // to a frozen envelope, tombstone included, once §2.5 landed). This is
      // still not the spec's full rule, though: a card that's only ever
      // been self-sent never sets state.sentAt (§2.5's self-send carve-out)
      // even though §6.3 says a self-send counts as "delivered" and should
      // also use the hide mechanism — telling that case apart from "never
      // delivered at all" needs a real delivery-history check (has this
      // objId ever appeared in this handle's own /inbox log), which isn't
      // wired up here. That residual gap predates this fix and isn't new.
      //
      // The mailbox listing (`pc`) is metadata-only — no record.payload —
      // so a GET is needed first to get the full envelope before PUTting
      // it back with only state.deleted added; record.payload/cid stay
      // untouched, so ObjectRepository.put() takes its existing
      // metadata-only-update path (matching cid) rather than creating a
      // new version. `sig` is dropped rather than carried over stale —
      // PostCardView's integrity check treats a present-but-mismatched sig
      // as "tampered" and an absent one as neutrally "unsigned"; dropping
      // it is the less alarming of the two inaccurate options, and
      // re-signing here would need the owner's WebAuthn/KEK material this
      // mailbox was never given.
      _deletePostcard: function (handle, pc) {
        var self = this;
        var base = lively.identity.did.baseUrl();
        var url  = base + '/@' + handle + '/' + pc.objId;

        var getXhr = new XMLHttpRequest();
        getXhr.open('GET', url, true);
        getXhr.setRequestHeader('Accept', 'application/json');
        getXhr.withCredentials = true;
        getXhr.onload = function () {
          if (getXhr.status !== 200) {
            return self.world().inform('Could not load this post card to delete it (' + getXhr.status + ').');
          }
          var envelope;
          try { envelope = JSON.parse(getXhr.responseText); } catch (e) {
            return self.world().inform('Could not delete this post card: bad response.');
          }

          if (envelope.state && envelope.state.sentAt) {
            // Frozen — a tombstone PUT would 409. Same mechanism (and same
            // confirm-dialog wording) as the Received/Delivered/Returned
            // tabs already use for any delivered card.
            return self._hideFromMailbox(pc.objId, function () { self._loadOwn(); });
          }

          self.world().confirm(
            "Delete this post card? It'll disappear from your postcards, " +
            "feeds, and mailboxes that reference it. Past versions in its " +
            "history aren't erased.",
            function (answer) {
              if (!answer) return;

              var updated = Object.assign({}, envelope, {
                state: Object.assign({}, envelope.state || {}, { deleted: true }),
              });
              delete updated.sig;

              var putXhr = new XMLHttpRequest();
              putXhr.open('PUT', url, true);
              putXhr.setRequestHeader('Content-Type', 'application/json');
              putXhr.withCredentials = true;
              putXhr.onload = function () {
                if (putXhr.status !== 200) {
                  return self.world().inform('Could not delete this post card (' + putXhr.status + ').');
                }
                self._loadOwn();
              };
              putXhr.onerror = function () { self.world().inform('Network error deleting this post card.'); };
              putXhr.send(JSON.stringify(updated));
            }
          );
        };
        getXhr.onerror = function () { self.world().inform('Network error loading this post card.'); };
        getXhr.send();
      },

      // §6.3, Layer 1 — per-viewer hide, for any delivered card (Received/
      // Delivered/Returned rows are all delivery-event references; the
      // current user may be the sender, the recipient, or both — the
      // mechanism doesn't need to know which). Never mutates the shared
      // envelope, so it can't remove the card from anyone else's mailbox —
      // that's the whole reason this exists as a separate mechanism from
      // _deletePostcard's tombstone above, per the spec's own reasoning
      // ("deleting a sent card shouldn't delete it for the recipient").
      _hideFromMailbox: function (objId, onSuccess) {
        var self = this;
        this.world().confirm(
          "Delete this post card? It'll disappear from your postcards and " +
          "mailboxes. This doesn't affect the recipient's copy, or any " +
          "other recipient's — they keep exactly what was sent to them, " +
          "same as a mailed postcard.",
          function (answer) {
            if (!answer) return;
            var handle = lively.identity.did.currentUser().handle;
            var base   = lively.identity.did.baseUrl();
            var xhr    = new XMLHttpRequest();
            xhr.open('DELETE', base + '/@' + handle + '/mailbox/' + objId, true);
            xhr.withCredentials = true;
            xhr.onload = function () {
              if (xhr.status !== 200) return self.world().inform('Could not delete this post card (' + xhr.status + ').');
              onSuccess();
            };
            xhr.onerror = function () { self.world().inform('Network error deleting this post card.'); };
            xhr.send();
          }
        );
      },

      // §3.2 — the server generates the alias string; this just asks for one.
      // Calls thenDo(err).
      _generateAlias: function (thenDo) {
        var handle = lively.identity.did.currentUser().handle;
        var base   = lively.identity.did.baseUrl();
        var xhr    = new XMLHttpRequest();
        xhr.open('POST', base + '/@' + handle + '/aliases', true);
        xhr.setRequestHeader('Content-Type', 'application/json');
        xhr.withCredentials = true;
        xhr.onload = function () {
          if (xhr.status !== 200) {
            var msg = 'Request failed (' + xhr.status + ')';
            try { msg = JSON.parse(xhr.responseText).error || msg; } catch (e) {}
            return thenDo(new Error(msg));
          }
          thenDo(null);
        };
        xhr.onerror = function () { thenDo(new Error('Network error')); };
        xhr.send();
      },

      // Calls thenDo(err).
      _revokeAliasHandle: function (alias, thenDo) {
        var handle = lively.identity.did.currentUser().handle;
        var base   = lively.identity.did.baseUrl();
        var xhr    = new XMLHttpRequest();
        xhr.open('DELETE', base + '/@' + handle + '/aliases/' + encodeURIComponent(alias), true);
        xhr.withCredentials = true;
        xhr.onload = function () {
          if (xhr.status !== 200) return thenDo(new Error('Request failed (' + xhr.status + ')'));
          thenDo(null);
        };
        xhr.onerror = function () { thenDo(new Error('Network error')); };
        xhr.send();
      },

      // requesterDid is the OTHER party (the person whose request this is) —
      // the route's own :handle is always the caller's own (the target of
      // the request). Calls thenDo(err).
      _respondFriendRequest: function (requesterDid, action, thenDo) {
        var handle = lively.identity.did.currentUser().handle;
        var base   = lively.identity.did.baseUrl();
        var xhr    = new XMLHttpRequest();
        xhr.open('PUT', base + '/@' + handle + '/friend-requests/' + encodeURIComponent(requesterDid), true);
        xhr.setRequestHeader('Content-Type', 'application/json');
        xhr.withCredentials = true;
        xhr.onload = function () {
          if (xhr.status !== 200) {
            var msg = 'Request failed (' + xhr.status + ')';
            try { msg = JSON.parse(xhr.responseText).error || msg; } catch (e) {}
            return thenDo(new Error(msg));
          }
          thenDo(null);
        };
        xhr.onerror = function () { thenDo(new Error('Network error')); };
        xhr.send(JSON.stringify({ action: action }));
      },

      // action: 'approve' or 'decline'. The invite is keyed by the current
      // viewer's own DID (they're the invitee, not a controller) — see
      // IdentityServer.js's PUT /c/:name/invites/:did. Calls thenDo(err).
      _respondConstellationInvite: function (constellationName, action, thenDo) {
        var did  = lively.identity.did.currentUser().did;
        var base = lively.identity.did.baseUrl();
        var xhr  = new XMLHttpRequest();
        xhr.open('PUT', base + '/c/' + encodeURIComponent(constellationName) + '/invites/' + encodeURIComponent(did), true);
        xhr.setRequestHeader('Content-Type', 'application/json');
        xhr.withCredentials = true;
        xhr.onload = function () {
          if (xhr.status !== 200) {
            var msg = 'Request failed (' + xhr.status + ')';
            try { msg = JSON.parse(xhr.responseText).error || msg; } catch (e) {}
            return thenDo(new Error(msg));
          }
          thenDo(null);
        };
        xhr.onerror = function () { thenDo(new Error('Network error')); };
        xhr.send(JSON.stringify({ action: action }));
      },

      // Calls thenDo(err).
      _removeFriend: function (friendDid, thenDo) {
        var handle = lively.identity.did.currentUser().handle;
        var base   = lively.identity.did.baseUrl();
        var xhr    = new XMLHttpRequest();
        xhr.open('DELETE', base + '/@' + handle + '/friends/' + encodeURIComponent(friendDid), true);
        xhr.withCredentials = true;
        xhr.onload = function () {
          if (xhr.status !== 200) return thenDo(new Error('Request failed (' + xhr.status + ')'));
          thenDo(null);
        };
        xhr.onerror = function () { thenDo(new Error('Network error')); };
        xhr.send();
      },

      // Withdraws a request the caller themselves sent to targetDid. Calls
      // thenDo(err).
      _cancelFriendRequest: function (targetDid, thenDo) {
        var handle = lively.identity.did.currentUser().handle;
        var base   = lively.identity.did.baseUrl();
        var xhr    = new XMLHttpRequest();
        xhr.open('DELETE', base + '/@' + handle + '/friend-requests/' + encodeURIComponent(targetDid), true);
        xhr.withCredentials = true;
        xhr.onload = function () {
          if (xhr.status !== 200) {
            var msg = 'Request failed (' + xhr.status + ')';
            try { msg = JSON.parse(xhr.responseText).error || msg; } catch (e) {}
            return thenDo(new Error(msg));
          }
          thenDo(null);
        };
        xhr.onerror = function () { thenDo(new Error('Network error')); };
        xhr.send();
      },

      // Async Clipboard API with a textarea/execCommand fallback for
      // contexts where it's unavailable.
      _copyToClipboard: function (text, btn) {
        var restore = btn.textContent;
        function copied() {
          btn.textContent = 'Copied!';
          setTimeout(function () { btn.textContent = restore; }, 1200);
        }
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(text).then(copied).catch(function () {});
        } else {
          var ta = document.createElement('textarea');
          ta.value = text;
          ta.style.cssText = 'position:fixed;opacity:0;';
          document.body.appendChild(ta);
          ta.select();
          try { document.execCommand('copy'); copied(); } catch (e2) {}
          document.body.removeChild(ta);
        }
      },

      // Delegates to DID.js's shared blockDid/unblockDid (same "relationships"
      // primitive MiniProfileCard.js's Block menu item uses) so there's one
      // source of truth for the mutate-and-PUT dance over this same settings
      // envelope, instead of a second independent copy of it here. Resolve to
      // a DID too so both blockedDids and blockedHandles get populated — the
      // inbox check (IdentityServer.js) matches on either. After a
      // successful mutation, re-GET via _loadBlocked so this tab's own
      // _settingsEnvelope/rendered list reflect the server's actual state
      // (DID.js's cache is a separate copy, used for synchronous
      // isBlocked/isMuted checks elsewhere, not this tab's source of truth).
      _blockHandle: function (handle, thenDo) {
        var self = this;
        lively.identity.webKey.resolveHandle(handle, function (err, info) {
          var did = (!err && info) ? info.did : null;
          lively.identity.did.blockDid(did, handle, function (err2) {
            if (err2) return thenDo(err2);
            self._loadBlocked();
            thenDo(null);
          });
        });
      },

      _unblockHandle: function (handle, thenDo) {
        var self = this;
        // Only the handle is shown in the Blocked list, but the server
        // matches blocks on blockedDids too (a reply or postcard from a
        // blocked DID is returned even with blockedHandles empty), so the
        // DID has to come out as well. Resolve it the way _blockHandle did
        // when adding; if the handle no longer resolves, fall back to
        // removing just the handle.
        lively.identity.webKey.resolveHandle(handle, function (err, info) {
          var did = (!err && info) ? info.did : null;
          lively.identity.did.unblockDid(did, handle, function (err2) {
            if (err2) return thenDo(err2);
            self._loadBlocked();
            thenDo(null);
          });
        });
      },

      // mutate(state) edits the settings envelope's state object in place
      // (block list, RSS feed subscriptions — whatever a caller needs
      // persisted server-side and readable without decrypting a payload,
      // per tranche 2's F18). The write goes through DID.js, which re-GETs the envelope first so a
      // copy loaded earlier in this tab cannot drop the audience lists or other
      // state saved since.
      _patchSettings: function (mutate, thenDo) {
        var self = this;
        lively.identity.did._patchRelationships(mutate, function (err, env) {
          if (err) return thenDo(err);
          self._settingsEnvelope = env;
          thenDo(null);
        });
      },

      // ── helpers ───────────────────────────────────────────────────────────

      _makeCard: function () {
        var card = document.createElement('div');
        card.className = 'pcm-card';
        return card;
      },

      // What the sender wrote in a returned reply. A public reply's text
      // comes with the record (replyExcerpt); anything else (a private
      // reply, or a photo-only one) is read from the sender's own stored
      // copy when they ask, since a private one may need a passkey prompt.
      _makeReturnedReplyQuote: function (rec) {
        var box = document.createElement('div');
        box.style.cssText = 'margin:2px 0 6px;padding:6px 10px;border-left:3px solid var(--pcm-border-strong, #d4d4d8);' +
          'color:var(--pcm-text-secondary);font-size:12px;white-space:pre-wrap;word-break:break-word;';
        function showText(text, hasMedia) {
          box.innerHTML = '';
          box.textContent = text || (hasMedia ? '(photo or video only)' : '(empty reply)');
          if (text && hasMedia) box.textContent += '\n+ photo or video';
        }
        if (rec.replyExcerpt) {
          showText(rec.replyExcerpt, false);
          return box;
        }
        var btn = document.createElement('button');
        btn.className = 'pcm-btn';
        btn.textContent = 'Show my reply';
        btn.addEventListener('click', function () {
          btn.disabled = true;
          btn.textContent = 'Opening…';
          lively.identity.mailboxThread.readOwnReplyText(rec.objId, function (err, text, hasMedia) {
            if (err) {
              btn.disabled = false;
              btn.textContent = 'Couldn’t open it — try again';
              return;
            }
            box.style.borderLeft = '3px solid var(--pcm-border-strong, #d4d4d8)';
            box.style.padding = '6px 10px';
            showText(text, hasMedia);
          });
        });
        box.style.borderLeft = 'none';
        box.style.padding = '0';
        box.appendChild(btn);
        return box;
      },

      // Centered icon + message, used for every "nothing here yet" state
      // and for the loading/error placeholders — replaces the old flat
      // gray "No X yet." string dropped into innerHTML. `danger:true`
      // tints it for error states (_showError).
      _emptyHtml: function (icon, text, danger) {
        return '<div class="pcm-empty' + (danger ? ' danger' : '') + '"><span class="pcm-empty-icon">' + icon + '</span><div>' + text + '</div></div>';
      },

      _emptyEl: function (icon, text, danger) {
        var el = document.createElement('div');
        el.className = 'pcm-empty' + (danger ? ' danger' : '');
        var i = document.createElement('span');
        i.className = 'pcm-empty-icon';
        i.textContent = icon;
        el.appendChild(i);
        var t = document.createElement('div');
        t.textContent = text;
        el.appendChild(t);
        return el;
      },

      _formatDate: function (iso) {
        if (!iso) return '';
        try {
          var d = new Date(iso);
          return d.toLocaleDateString() + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        } catch (e) { return iso; }
      },

      // Avatar + handle row — identicon shown immediately (cheap, always
      // correct as a fallback), upgraded to the real avatar if that
      // handle's profile has one set, same two-step pattern
      // PostCardView.js's _loadAvatar already uses. `handle` may be
      // missing for a handful of legacy inbox records that predate
      // storing senderHandle (audit F4) — falls back to a truncated DID
      // with a DID-seeded identicon rather than no row at all.
      _makeIdentityRow: function (prefix, handle, didFallback) {
        var row = document.createElement('div');
        row.style.cssText = 'display:flex;align-items:center;gap:7px;margin-bottom:3px;';

        var img = document.createElement('img');
        img.style.cssText = 'width:24px;height:24px;border-radius:50%;flex:none;border:1px solid var(--pcm-border);box-sizing:border-box;';
        img.src = lively.identity.postCardUtils.identiconDataUrl(handle || didFallback || '', 24);
        row.appendChild(img);

        var text = document.createElement('span');
        text.style.cssText = 'font-weight:600;color:var(--pcm-text);';
        text.textContent = prefix + (handle ? '@' + handle : (didFallback ? didFallback.slice(0, 24) + '…' : '(unknown)'));
        row.appendChild(text);

        if (handle) {
          var base = lively.identity.did.baseUrl();
          fetch(base + '/@' + encodeURIComponent(handle) + '/profile', { credentials: 'include' })
            .then(function (res) { return res.ok ? res.json() : null; })
            .then(function (env) {
              var avatarUrl = env && env.record && env.record.payload && env.record.payload.avatarUrl;
              if (avatarUrl) img.src = avatarUrl;
            })
            .catch(function () {}); // network error — keep the identicon fallback
        }

        return row;
      },

      _showError: function (msg) {
        this._contentDiv.innerHTML = this._emptyHtml('error', msg, true);
      },

    }); // end subclass

    // ── class-side entry point ───────────────────────────────────────────────

    // A plain setFill()/applyStyle({fill:...}) on an already-rendered
    // classic Window can silently update the model without ever reaching
    // the DOM (see CLAUDE.md's applyStyle-DOM-sync gotcha) — this drives
    // the color via a scoped CSS class instead (same technique DMChat.js's
    // applyAccentChrome uses), which also survives collapse/expand and any
    // other Window-internal re-render, unlike a one-off inline style write.
    // `!important` beats base_theme.css's own `.Window.highlighted`
    // background rule so the color doesn't fade to gray when unfocused.
    //
    // Two bugs confirmed live via getComputedStyle on the real focused
    // window, both inherited from base_theme.css's default (light-chrome-
    // tuned) rules and never overridden here, unlike DMChat.js's own
    // applyAccentChrome which already covers both for its own accent:
    //   1. `.Window .Text.window-title` is #555/#333 dark gray — unreadable
    //      against a saturated green title bar (rgb(51,51,51) bold-on-green,
    //      confirmed low contrast).
    //   2. `.Window.highlighted` adds a stray `1px solid white` border plus
    //      a plain #333 shadow tuned for the gray default chrome — reads as
    //      a white ring leaking around the green frame when focused
    //      (confirmed: computed border was "0.67px solid rgb(255,255,255)").
    function _ensureAccentChromeCss() {
      var STYLE_ID = 'postcard-mailbox-accent-chrome-style';
      if (document.getElementById(STYLE_ID)) return;
      var styleEl = document.createElement('style');
      styleEl.id = STYLE_ID;
      styleEl.textContent = [
        '.Window.mailbox-accent-chrome { background-color: #61D565 !important; }',
        '.Window.mailbox-accent-chrome .Text.window-title { color: #fff; }',
        '.Window.mailbox-accent-chrome.highlighted .Text.window-title { color: #fff; font-weight: bold; }',
        '.Window.mailbox-accent-chrome.highlighted { border: none !important; box-shadow: 0px 3px 10px rgba(20,60,20,0.35) !important; }',
      ].join('\n');
      document.head.appendChild(styleEl);
    }

    Object.extend(MailboxClass, {
      open: function (tab) {
        // 820px wide, comfortably fits all 9 tab pills without scrolling
        // at this window's default size; the tab bar itself scrolls
        // horizontally (pcm-tabbar's overflow-x:auto) if it's ever
        // resized narrower than that.
        var morph = new lively.identity.PostCardMailbox(lively.rect(0, 0, 820, 480));
        morph.setName('Mailbox');
        // Real classic Window chrome (drag/resize/collapse/close, Material
        // Symbols icon controls by default) rather than the hand-rolled
        // title bar this used to draw itself — same pattern as
        // CalendarApp.js's CalendarAppClass.open.
        morph.openInWindow({
          title: 'Mailbox',
          pos: lively.morphic.World.current().visibleBounds().center().subPt(lively.pt(410, 240)),
        });
        var win = morph.getWindow();
        _ensureAccentChromeCss();
        win.addStyleClassName('mailbox-accent-chrome');
        win.comeForward();
        if (tab && tab !== 'received') morph._switchTab(tab);
        return morph;
      },
    });

  }); // end module('lively.identity.PostCardMailbox')
