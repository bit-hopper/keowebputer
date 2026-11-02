module('lively.identity.Inventory').requires('lively.persistence.BuildSpec', 'lively.PartsBin', 'lively.identity.IdentityPartsSpace').toRun(function() {

// Standalone window for browsing every publicly "Published to Inventory"
// item across ALL users, at feature/layout parity with the classic WebDAV
// browser (lively.morphic.tools.PartsBin, core/lively/morphic/tools/PartsBin.js
// — titleBar "Inventory"). That browser already treats a *signed-in user's
// own* identity-published parts as first-class (its "*myparts*"/"#tag"
// categories and WebDAV-backed Search can't see anyone else's public items —
// see the /parts/public route's own doc comment in IdentityServer.js), but
// has no notion of *other users'* items at all. This is the cross-user
// counterpart: same region layout (instance chooser + category sidebar,
// thumbnail grid, collapsible info panel with Share Link/Inspect/identity
// metadata/version history), reusing the same shared widget classes
// (lively.morphic.PartsBinItem, lively.identity.IdentityPartItem) the
// classic browser's own "*myparts*" category already relies on.
//
// Naming convention: this module/window is "Inventory" (not "PartsBin"),
// and its own UI/identifiers say "Item(s)" (not "Part(s)") — the shared
// classes it reuses (PartsBinItem, IdentityPartItem, the classic PartsBin.js
// browser itself) keep their existing names; renaming those is out of scope.
lively.BuildSpec('lively.identity.Inventory', {
    _BorderColor: Color.rgb(204,0,0),
    // Setting _BorderColor without a paired _BorderRadius silently zeroes
    // the window's corner radius at construction (setBorderColor rewrites
    // the whole inline border shorthand, radius included) — see CLAUDE.md's
    // "lively.BuildSpec / Morph#addScript methods lose their closure" doc's
    // sibling border-radius-reset gotcha. Explicit here so the window keeps
    // the classic rounded corner instead of rendering hard square ones.
    _BorderRadius: 3,
    // Teal window/frame fill -- shows through the title bar (`.Window
    // .TitleBar` is `background: none` in base_theme.css, so it inherits
    // whatever the window itself is filled with) and the ~4-6px margin
    // around InventoryBrowser's own fully-transparent content box below.
    // Scoped to this window only, not base_theme.css's global `.Window`
    // rule, which every other window in the system still uses.
    _Fill: Color.rgbHex('#57CFB3'),
    // Widened for the 3-column Phase D layout (220px rail + 840px flexible
    // main + 360px right panel + 2 dividers + the HorizontalLayout's own
    // borderSize/spacing below) -- see inventory.md §13 Phase D plan.
    _Extent: lively.pt(1460.0,760.0),
    _Position: lively.pt(140.0,80.0),
    _StyleClassNames: ["Morph","Window"],
    cameForward: false,
    className: "lively.morphic.Window",
    contentOffset: lively.pt(4.0,22.0),
    draggingEnabled: true,
    layout: { adjustForNewBounds: true },
    minExtent: lively.pt(900.0,560.0),
    name: "Inventory",
    sourceModule: "lively.identity.Inventory",
    submorphs: [{
        _BorderColor: Color.rgb(95,94,95),
        // same border-radius-reset gotcha as the outer window above.
        _BorderRadius: 3,
        _Extent: lively.pt(1452.0,734.0),
        _Fill: Color.rgba(245,245,245,0),
        _Position: lively.pt(4.0,22.0),
        _StyleClassNames: ["Morph","Box"],
        borderWidth: 1,
        className: "lively.morphic.Box",
        droppingEnabled: false,
        layout: {
            adjustForNewBounds: true,
            borderSize: 6,
            resizeHeight: true,
            resizeWidth: true,
            spacing: 3,
            type: "lively.morphic.Layout.HorizontalLayout"
        },
        minExtent: lively.pt(780.0,480.0),
        name: "InventoryBrowser",
        selectedItem: null,
        cursor: null,
        searchQuery: "",
        // scope: which data path _loadItemsPage hits -- 'public' (fan-out
        // across checkedInstances' /parts/public), 'mine'/'shared' (self-
        // only, always same-origin/credentialed, see inventory.md §13).
        scope: "public",
        // category: curated Inventory category filter (inventory.md §7) --
        // the sidebar's freeform "#tag" list (categoryName) was replaced
        // outright by this curated filter in Phase D, not layered alongside
        // it (inventory.md §13.1's own framing of what Phase D replaces).
        category: null,
        sort: "recent",
        // instances: the real federation directory (GET /instances,
        // inventory.md §3.2), loaded once via loadInstances(). checkedInstances
        // is the fan-out selection -- a baseUrl -> bool map, replacing the
        // old single-string instanceBaseUrl model so more than one instance
        // can be active at once. Defaults to "local origin only" (today's
        // pre-federation behavior) until loadInstances() populates it.
        instances: [],
        checkedInstances: {},
        // categoryCounts/categoryTotal: GET /parts/public/categories results
        // (inventory.md §13 Phase D), backing the curated Categories
        // sidebar's per-row counts. Public scope only.
        categoryCounts: {},
        categoryTotal: 0,
        // popularItems/popularStart: the "Popular this week" strip's own
        // independent top-8-by-stars fetch (loadPopularStrip) -- separate
        // from _loadItemsPage's cursor-paginated main grid. popularStart
        // steps by 4 (the visible window size) and is clamped in
        // popularPrev/popularNext.
        popularItems: [],
        popularStart: 0,
        // versionsExpanded: right-panel version-badge disclosure state.
        versionsExpanded: false,
        // selectedTileMorph: tracks whichever tile (in ItemsGrid OR the
        // Popular strip) is currently shown selected, so selectTile can
        // deselect it regardless of which container it lives in -- see
        // selectTile below.
        selectedTileMorph: null,
        sourceModule: "lively.morphic.Core",

        // ─── left sidebar (inventory.md §13 Phase D) ─────────────────────
        // Only ScopeTabsRow is static BuildSpec content -- the Categories
        // and Instances blocks below it are entirely data-driven (curated-
        // category counts, the federation directory) and are hand-
        // constructed/torn down at runtime by _renderSidebarExtras, the
        // same "build fresh each time" idiom _buildItemTile/ItemsGrid
        // already use for the item grid. All of LeftSideContainer's direct
        // children just hug their own natural content height (no child
        // declares resizeHeight:true) and the container itself scrolls as
        // one region via _ClipMode -- sidesteps the VerticalLayout fixed-
        // vs-flex-sibling trap entirely rather than juggling it, matching
        // this file's own MainContainer/ItemInfoPanel explicit-positioning
        // precedent in spirit (no shared flex/fixed conflict to resolve).

        submorphs: [{
            _BorderWidth: 0.7,
            _ClipMode: "auto",
            _Extent: lively.pt(220.0,601.0),
            _Fill: Color.rgba(255,255,255,0),
            _Position: lively.pt(6.0,6.0),
            className: "lively.morphic.Box",
            droppingEnabled: false,
            layout: {
                borderSize: 0,
                resizeHeight: true,
                resizeWidth: false,
                spacing: 14,
                type: "lively.morphic.Layout.VerticalLayout"
            },
            name: "LeftSideContainer",
            sourceModule: "lively.morphic.Core",
            submorphs: [{
                _Extent: lively.pt(220.0,26.0),
                _Fill: Color.rgb(236,236,236),
                className: "lively.morphic.Box",
                droppingEnabled: false,
                layout: { borderSize: 2, resizeWidth: true, spacing: 2, type: "lively.morphic.Layout.HorizontalLayout" },
                name: "ScopeTabsRow",
                sourceModule: "lively.morphic.Core",
                style: { borderRadius: 8 },
                submorphs: [{
                    _Extent: lively.pt(70.0,22.0),
                    _Fill: Color.white,
                    _Position: lively.pt(2.0,2.0),
                    _StyleClassNames: ["Morph","Button"],
                    className: "lively.morphic.Button",
                    isPressed: false,
                    label: "Public",
                    layout: { resizeWidth: true },
                    name: "scopePublicButton",
                    sourceModule: "lively.morphic.Widgets",
                    style: { borderRadius: 6 },
                    value: false,
                    withoutLayers: [],
                    connectionRebuilder: function connectionRebuilder() {
                        lively.bindings.connect(this, "fire", this.get("InventoryBrowser"), "setScope", { converter: function() { return "public"; } });
                    }
                },{
                    _Extent: lively.pt(70.0,22.0),
                    _Fill: Color.rgba(255,255,255,0),
                    _Position: lively.pt(74.0,2.0),
                    _StyleClassNames: ["Morph","Button"],
                    className: "lively.morphic.Button",
                    isPressed: false,
                    label: "My Items",
                    layout: { resizeWidth: true },
                    name: "scopeMineButton",
                    sourceModule: "lively.morphic.Widgets",
                    style: { borderRadius: 6 },
                    value: false,
                    withoutLayers: [],
                    connectionRebuilder: function connectionRebuilder() {
                        lively.bindings.connect(this, "fire", this.get("InventoryBrowser"), "setScope", { converter: function() { return "mine"; } });
                    }
                },{
                    _Extent: lively.pt(70.0,22.0),
                    _Fill: Color.rgba(255,255,255,0),
                    _Position: lively.pt(146.0,2.0),
                    _StyleClassNames: ["Morph","Button"],
                    className: "lively.morphic.Button",
                    isPressed: false,
                    label: "Shared",
                    layout: { resizeWidth: true },
                    name: "scopeSharedButton",
                    sourceModule: "lively.morphic.Widgets",
                    style: { borderRadius: 6 },
                    value: false,
                    withoutLayers: [],
                    connectionRebuilder: function connectionRebuilder() {
                        lively.bindings.connect(this, "fire", this.get("InventoryBrowser"), "setScope", { converter: function() { return "shared"; } });
                    }
                }],
                withoutLayers: []
            }],
            withoutLayers: []
        },{
            _BorderColor: null,
            _Extent: lively.pt(2.0,601.0),
            _Fill: Color.rgb(204,204,204),
            _Position: lively.pt(230.0,6.0),
            className: "lively.morphic.VerticalDivider",
            draggingEnabled: true,
            droppingEnabled: true,
            fixed: [],
            layout: { resizeHeight: true },
            minWidth: 150,
            name: "LeftRightDivider",
            pointerConnection: null,
            sourceModule: "lively.morphic.Widgets",
            submorphs: [],
            withoutLayers: []
        },

        // ─── main content (inventory.md §13 Phase D) ──────────────────────
        // MainContainer's own children (TopBar, PopularCard, AllItemsCard)
        // ARE under a shared VerticalLayout, unlike the old MainContentContainer/
        // ItemInfoPanel split above this comment used to warn against --
        // safe here because the flexible child (AllItemsCard, resizeHeight:
        // true) is LAST, mirroring LeftSideContainer's own proven-working
        // InstanceChooser(fixed)+CategoryListContainer(flexible-last) shape
        // from before this rewrite. PopularCard is only added for
        // scope==='public' (removed entirely otherwise, not just hidden),
        // so AllItemsCard stays the last child either way.

        {
            _Extent: lively.pt(840.0,601.0),
            _Fill: Color.rgba(255,255,255,0),
            _Position: lively.pt(235.0,6.0),
            _ClipMode: "hidden",
            className: "lively.morphic.Box",
            droppingEnabled: false,
            layout: {
                adjustForNewBounds: true, resizeHeight: true, resizeWidth: true,
                borderSize: 0, spacing: 14, type: "lively.morphic.Layout.VerticalLayout"
            },
            name: "MainContainer",
            sourceModule: "lively.morphic.Core",
            submorphs: [{
                // ─── search + sort bar ─────────────────────────────────
                _Extent: lively.pt(840.0,36.0),
                _Fill: Color.rgba(255,255,255,0),
                className: "lively.morphic.Box",
                droppingEnabled: false,
                layout: {},
                name: "TopBar",
                sourceModule: "lively.morphic.Core",
                submorphs: [
                    lively.BuildSpec('lively.ide.tools.CommandLine').customize({
                        name: "searchText",
                        _Position: lively.pt(0,2),
                        _Extent: lively.pt(520,32),
                        labelString: "  ",
                        clearOnInput: false,
                        connectionRebuilder: function connectionRebuilder() {
                            lively.bindings.connect(this, "savedTextString", this.get("InventoryBrowser"), "search", {});
                        }
                    }),
                    {
                        _Position: lively.pt(530,2),
                        _Extent: lively.pt(78,32),
                        _Fill: Color.white,
                        _StyleClassNames: ["Morph","Button"],
                        className: "lively.morphic.Button",
                        isPressed: false,
                        label: "Popular",
                        name: "sortPopularButton",
                        sourceModule: "lively.morphic.Widgets",
                        style: { borderRadius: 6 },
                        value: false,
                        withoutLayers: [],
                        connectionRebuilder: function connectionRebuilder() {
                            lively.bindings.connect(this, "fire", this.get("InventoryBrowser"), "setSort", { converter: function() { return "popular"; } });
                        }
                    },{
                        _Position: lively.pt(614,2),
                        _Extent: lively.pt(78,32),
                        _Fill: Color.white,
                        _StyleClassNames: ["Morph","Button"],
                        className: "lively.morphic.Button",
                        isPressed: false,
                        label: "Recent",
                        name: "sortRecentButton",
                        sourceModule: "lively.morphic.Widgets",
                        style: { borderRadius: 6 },
                        value: false,
                        withoutLayers: [],
                        connectionRebuilder: function connectionRebuilder() {
                            lively.bindings.connect(this, "fire", this.get("InventoryBrowser"), "setSort", { converter: function() { return "recent"; } });
                        }
                    },{
                        _Position: lively.pt(700,2),
                        _Extent: lively.pt(40,32),
                        _Fill: Color.white,
                        // InventorySortMenuBtn: a dedicated class (distinct
                        // from the plain-text Popular/Recent pills sharing
                        // this same Button styling) scoping the Material
                        // Symbols font-family/font-size CSS rule in
                        // base_theme.css -- same CSS-cascade sidestep for
                        // the JS-fontFamily-DOM-sync bug CLAUDE.md documents
                        // for .Button.WindowControl, and confirmed live here
                        // to need no !important: this label's own <span>
                        // never gets an inline font-family/font-size (only
                        // textColor does, fixed separately via
                        // _paintLabelColor), so the CSS class cleanly wins.
                        _StyleClassNames: ["Morph","Button","InventorySortMenuBtn"],
                        className: "lively.morphic.Button",
                        isPressed: false,
                        // Icon-only "filter_list" glyph, replacing the old
                        // literal "More ▾" text -- baked in at construction
                        // via the labelString constructor arg (not a later
                        // .setTextString/.applyStyle call), which sidesteps
                        // CLAUDE.md's separate "icon ligature re-widens the
                        // label box before the icon font loads" bug -- that
                        // one only hits a label swapped post-construction.
                        label: "filter_list",
                        name: "sortMenuButton",
                        sourceModule: "lively.morphic.Widgets",
                        style: { borderRadius: 6 },
                        value: false,
                        withoutLayers: [],
                        connectionRebuilder: function connectionRebuilder() {
                            lively.bindings.connect(this, "fire", this.get("InventoryBrowser"), "openSortMenu", {});
                        }
                    }
                ],
                withoutLayers: []
            },{
                // ─── all items card (Popular strip inserted before this,
                // at index 1, only for scope==='public') ─────────────────
                _Extent: lively.pt(840.0,540.0),
                _Fill: Color.white,
                _BorderColor: Color.rgb(230,230,230),
                _BorderWidth: 1,
                _ClipMode: "hidden",
                className: "lively.morphic.Box",
                droppingEnabled: false,
                layout: { resizeHeight: true, resizeWidth: true },
                style: { borderRadius: 12 },
                name: "AllItemsCard",
                sourceModule: "lively.morphic.Core",
                submorphs: [{
                    _Position: lively.pt(16,12),
                    _Extent: lively.pt(200,14),
                    _FontFamily: "Helvetica",
                    _FontSize: 7.5,
                    _InputAllowed: false,
                    allowInput: false,
                    className: "lively.morphic.Text",
                    droppingEnabled: false,
                    eventsAreIgnored: true,
                    fixedWidth: true,
                    fixedHeight: true,
                    grabbingEnabled: false,
                    name: "AllItemsHeader",
                    sourceModule: "lively.morphic.TextCore",
                    submorphs: [],
                    textColor: Color.rgb(153,153,153),
                    textString: "ALL ITEMS",
                    withoutLayers: []
                },{
                    // items grid — same async tile-population mechanics as
                    // the classic browser's partsBinContents box
                    // (addPartItemAsync/startAddingPartItems/adjustForNewBounds),
                    // populated with lively.identity.IdentityPartItem
                    // instances built by hand from /parts/public rows
                    // (there's no owning IdentityPartsSpace for another
                    // user's items — same approach the old
                    // PublicPartsBrowser.js's _openEnvelope already used).
                    _Position: lively.pt(16,34),
                    _ClipMode: "auto",
                    _Extent: lively.pt(808.0,462.0),
                    _Fill: Color.rgba(255,255,255,0),
                    className: "lively.morphic.Box",
                    droppingEnabled: false,
                    layout: {},
                    name: "ItemsGrid",
                    sourceModule: "lively.morphic.Core",
                    submorphs: [],
                    withoutLayers: [],
                    addItemAsync: function addItemAsync() {
                        if (!this.itemsToBeAdded || this.itemsToBeAdded.length === 0) {
                            this.stopAddingItemsAsync();
                            return;
                        }
                        var item = this.itemsToBeAdded.shift();
                        var morph = this.get('InventoryBrowser')._buildItemTile(item);
                        this.addMorph(morph);
                        this.adjustForNewBounds();
                    },
                    adjustForNewBounds: function adjustForNewBounds() {
                        $super();
                        var bounds = this.innerBounds(),
                            delta = 8,
                            left = bounds.x + delta,
                            top = bounds.y + delta,
                            x = left, y = top,
                            width = bounds.width;
                        this.submorphs.forEach(function(morph) {
                            var extent = morph.getExtent();
                            if (extent.x + x + delta > width) {
                                x = left;
                                y += extent.y + delta;
                            }
                            morph.setPosition(pt(x,y));
                            x += extent.x + delta;
                        });
                    },
                    setExtent: function setExtent(point) {
                        $super(point);
                        this.adjustForNewBounds();
                    },
                    startAddingItems: function startAddingItems(items) {
                        this.itemsToBeAdded = items.clone();
                        this.startStepping(0, 'addItemAsync');
                    },
                    stopAddingItemsAsync: function stopAddingItemsAsync() {
                        this.stopStepping();
                        delete this.itemsToBeAdded;
                    },
                    removeAllItems: function removeAllItems() {
                        this.submorphs.clone().invoke('remove');
                    }
                },{
                    // pagination — new relative to the classic browser
                    // (whose WebDAV categories load everything at once):
                    // cross-user public inventory can be large, and
                    // /parts/public already returns a cursor for exactly
                    // this purpose.
                    _Position: lively.pt(16,504),
                    _Extent: lively.pt(808.0,24.0),
                    _Fill: Color.rgba(255,255,255,0),
                    className: "lively.morphic.Box",
                    droppingEnabled: false,
                    layout: {},
                    name: "LoadMoreContainer",
                    sourceModule: "lively.morphic.Core",
                    submorphs: [{
                        _BorderColor: Color.rgb(214,214,214),
                        _Extent: lively.pt(100.0,22.0),
                        _Fill: Color.rgb(230,230,230),
                        _StyleClassNames: ["Morph","Button"],
                        className: "lively.morphic.Button",
                        isPressed: false,
                        label: "Load more",
                        name: "loadMoreButton",
                        sourceModule: "lively.morphic.Widgets",
                        style: { borderRadius: 4 },
                        value: false,
                        withoutLayers: [],
                        connectionRebuilder: function connectionRebuilder() {
                            lively.bindings.connect(this, "fire", this.get("InventoryBrowser"), "loadMoreItems", {});
                        }
                    },{
                        _Extent: lively.pt(400.0,16.0),
                        _FontFamily: "Arial, sans-serif",
                        _FontSize: 10,
                        _Position: lively.pt(108.0,4.0),
                        _InputAllowed: false,
                        allowInput: false,
                        className: "lively.morphic.Text",
                        droppingEnabled: false,
                        eventsAreIgnored: true,
                        fixedWidth: true,
                        grabbingEnabled: false,
                        name: "statusText",
                        sourceModule: "lively.morphic.TextCore",
                        submorphs: [],
                        textColor: Color.rgb(120,120,120),
                        textString: ""
                    }],
                    withoutLayers: []
                }],
                withoutLayers: [],
                // AllItemsCard is the flexible LAST child of MainContainer's
                // VerticalLayout -- when the layout resizes it, reflow its
                // own header/grid/load-more children explicitly rather than
                // via a nested layout (same custom-setExtent-override idiom
                // ItemsGrid itself already uses one level down).
                setExtent: function setExtent(point) {
                    $super(point);
                    var headerH = 34, loadMoreH = 30, pad = 16;
                    var grid = this.get('ItemsGrid');
                    var loadMore = this.get('LoadMoreContainer');
                    if (grid) {
                        grid.setPosition(pt(pad, headerH));
                        grid.setExtent(pt(Math.max(100, point.x - 2 * pad), Math.max(60, point.y - headerH - loadMoreH - pad)));
                    }
                    if (loadMore) {
                        loadMore.setPosition(pt(pad, point.y - loadMoreH - 4));
                        loadMore.setExtent(pt(Math.max(100, point.x - 2 * pad), loadMoreH));
                    }
                }
            }],
            withoutLayers: []
        },{
            _BorderColor: null,
            _Extent: lively.pt(2.0,601.0),
            // Softened from the original 204,204,204 -- part of the same
            // right-panel border-softening pass as renderRightPanel's own
            // borders below.
            _Fill: Color.rgb(224,224,224),
            _Position: lively.pt(1078.0,6.0),
            className: "lively.morphic.VerticalDivider",
            draggingEnabled: true,
            droppingEnabled: true,
            fixed: [],
            layout: { resizeHeight: true },
            minWidth: 260,
            name: "RightDivider",
            pointerConnection: null,
            sourceModule: "lively.morphic.Widgets",
            submorphs: [],
            withoutLayers: []
        },{
            // ─── right panel (inventory.md §13 Phase D) ───────────────────
            // Entirely dynamic content, rebuilt fresh on every selection/
            // star/comment/version change by InventoryBrowser.renderRightPanel
            // -- same "hand-construct fresh, don't patch named morphs in
            // place" idiom as the sidebar's Categories/Instances blocks and
            // _buildItemTile. No static submorphs here at all; the whole
            // panel scrolls as one region via _ClipMode, sidestepping any
            // fixed-vs-flex-sibling layout question entirely (every row
            // just hugs its own content).
            _Extent: lively.pt(360.0,601.0),
            // Soft-edges pass: a faint off-white fill (not pure white) plus a
            // rounded, hairline-bordered outer card -- the teal window gutter
            // (InventoryBrowser's own borderSize:6, see the window BuildSpec
            // above) now shows through the rounded corners, reading as a
            // floating panel rather than a flush rectangular column. Paired
            // _BorderColor/_BorderRadius together per this file's own
            // documented gotcha (setting one without the other silently
            // zeroes the radius at construction).
            _Fill: Color.rgb(252,252,253),
            _BorderColor: Color.rgb(232,232,235),
            _BorderRadius: 14,
            _Position: lively.pt(1083.0,6.0),
            _ClipMode: "auto",
            borderWidth: 1,
            className: "lively.morphic.Box",
            droppingEnabled: false,
            layout: { resizeHeight: true, resizeWidth: false },
            name: "RightPanel",
            sourceModule: "lively.morphic.Core",
            submorphs: [],
            withoutLayers: []
        }],
        withoutLayers: [],

        // ─── loading ────────────────────────────────────────────────────────

    onLoad: function onLoad() {
        this.get('searchText').setTextString('');
        this.renderRightPanel();
        var self = this;
        // checkedInstances must be populated before the first real load, or
        // _activeInstanceBaseUrls() would fall back to "local origin only"
        // for one extra round trip -- harmless, but loadInstances' own
        // callback sequencing avoids that flash-of-wrong-scope entirely.
        this.loadInstances(function() { self.reloadEverything(); });
    },

    onWindowGetsFocus: function onWindowGetsFocus() {
        this.get('searchText').focus();
    },

    reloadEverything: function reloadEverything() {
        this.cursor = null;
        this.get('ItemsGrid').removeAllItems();
        this.setSelectedItem(null);
        this._renderSidebarExtras();
        this._renderMainColumnForScope();
        this._loadItemsPage(false);
        if (this.scope === 'public') {
            this.loadCategoryCounts();
            this.loadPopularStrip();
        } else {
            this.categoryCounts = {};
            this.categoryTotal = 0;
            this.popularItems = [];
            this.popularStart = 0;
        }
    },

    // ─── scope / category / sort (inventory.md §13) ────────────────────────
    // Mechanical setters -- each resets pagination and reloads. Real UI for
    // these (scope segmented control, category sidebar rows, sort pills)
    // is Phase D's job; these are exercised directly for now (devtools /
    // future UI wiring), same "data layer before layout" split the rest of
    // this pass follows.

    setScope: function setScope(scope) {
        this.scope = scope;
        this.reloadEverything();
    },

    setCategory: function setCategory(category) {
        this.category = category || null;
        this.cursor = null;
        this._renderSidebarExtras();
        this._loadItemsPage(false);
    },

    setSort: function setSort(sort) {
        this.sort = sort || 'recent';
        this.cursor = null;
        this._repaintSortControls();
        this._loadItemsPage(false);
    },

    // ─── instances / federation directory (inventory.md §3.2) ─────────────

    // Flips one instance's fan-out membership (the Instances checkbox
    // panel, inventory.md §13 Phase D) -- replaces the old single-select
    // InstanceChooser dropdown/setInstanceBaseUrl entirely, now that real
    // multi-select fan-out has a real checkbox-per-row UI to drive it.
    toggleInstanceChecked: function toggleInstanceChecked(baseUrl) {
        var checked = Object.assign({}, this.checkedInstances);
        checked[baseUrl] = !checked[baseUrl];
        this.checkedInstances = checked;
        this.reloadEverything();
    },

    // "Select all" / "None" quick actions atop the Instances panel.
    // Unchecking every instance is safe -- _activeInstanceBaseUrls()
    // already falls back to the local origin whenever checkedInstances has
    // no true entries, so "None" can't leave fan-out with zero sources.
    setAllInstancesChecked: function setAllInstancesChecked(bool) {
        var urls = this.instances.length ? this.instances.map(function(i) { return i.baseUrl; }) : [window.location.origin];
        var checked = {};
        urls.forEach(function(u) { checked[u] = bool; });
        this.checkedInstances = checked;
        this.reloadEverything();
    },

    // GET /instances (the real directory), populating checkedInstances with
    // every known instance checked by default (matching §13's mockup
    // default: "browsing N of M instances", all pinned). One-time seeds the
    // directory from the legacy instanceURLs config if the directory comes
    // back empty and config has entries -- config is a migration seed, not
    // a permanent parallel source (inventory.md §13's own scoping decision:
    // otherwise a config-seeded instance could never be removed via the
    // real directory's own UI, since it would just reappear next load).
    // Calls cb() once ready (instances/checkedInstances populated), always
    // -- even on fetch failure, so callers aren't left waiting forever.
    loadInstances: function loadInstances(cb) {
        var self = this;
        cb = cb || function() {};
        this._fetchJson(window.location.origin + '/instances', function(err, body) {
            if (err || !body) { self._applyLocalOnlyInstances(); cb(); return; }
            var instances = body.instances || [];
            if (!instances.length) {
                var configured = (typeof lively !== 'undefined' && lively.Config &&
                    lively.Config.get('instanceURLs', true)) || [];
                if (configured.length) {
                    self._seedInstancesFromConfig(configured, function() {
                        self._fetchJson(window.location.origin + '/instances', function(err2, body2) {
                            self._applyInstancesResult(err2 ? null : body2);
                            cb();
                        });
                    });
                    return;
                }
            }
            self._applyInstancesResult(body);
            cb();
        });
    },

    _applyLocalOnlyInstances: function _applyLocalOnlyInstances() {
        this.instances = [];
        var checked = {};
        checked[window.location.origin] = true;
        this.checkedInstances = checked;
    },

    _applyInstancesResult: function _applyInstancesResult(body) {
        var instances = (body && body.instances) || [];
        var checked = {};
        instances.forEach(function(inst) { checked[inst.baseUrl] = true; });
        checked[window.location.origin] = true; // local instance always available
        this.instances = instances;
        this.checkedInstances = checked;
    },

    // Best-effort, silently ignored on failure (e.g. no signed-in session --
    // POST /instances requires auth) since this is only a one-time
    // convenience migration, not something the browsing UI depends on.
    _seedInstancesFromConfig: function _seedInstancesFromConfig(baseUrls, cb) {
        var remaining = baseUrls.length;
        if (!remaining) { cb(); return; }
        baseUrls.forEach(function(baseUrl) {
            this._postJson(window.location.origin + '/instances', {
                baseUrl: baseUrl, displayName: baseUrl.replace(/^https?:\/\//, '')
            }, function() { if (--remaining === 0) cb(); });
        }, this);
    },

    // The checked subset of known instances, always including local origin
    // as a safe default before loadInstances() has ever resolved.
    _activeInstanceBaseUrls: function _activeInstanceBaseUrls() {
        var self = this;
        var checked = Object.keys(this.checkedInstances || {}).filter(function(u) { return self.checkedInstances[u]; });
        return checked.length ? checked : [window.location.origin];
    },

    // ─── sidebar rendering (inventory.md §13 Phase D) ──────────────────────
    // Direct-DOM-write restyle helpers for anything recolored AFTER a morph
    // is already rendered (scope tabs, category rows) -- applyStyle({fill/
    // textColor:...}) is confirmed (this session's research + CLAUDE.md) to
    // silently no-op on an already-rendered morph for exactly these two
    // properties, so selection-driven restyling writes renderContext()
    // .shapeNode.style directly, same idiom as WalletSetupDialog.js's
    // _paintToggleButton. Border-related properties (width/color) DO reach
    // the DOM via the model layer in this codebase's own confirmed case, so
    // those still go through the normal setBorderColor/setBorderWidth calls.

    // A Text morph's own leaf <span> carries its OWN inline `color`,
    // baked in at first render from the model's textColor (Button's
    // default label style is Color.green) -- confirmed live: writing
    // color only to the label's outer shapeNode div (as this function
    // used to) left every scope-tab/sort-pill label stuck rendering
    // green, since a child's own inline color wins over an inherited one
    // from its ancestor div regardless of what the div's color says.
    // Every label recolor needs both nodes written.
    _paintLabelColor: function _paintLabelColor(labelMorph, color) {
        if (!labelMorph) return;
        var node = labelMorph.renderContext().shapeNode;
        node.style.color = color;
        var span = node.querySelector('span');
        if (span) span.style.color = color;
    },

    _paintScopeTab: function _paintScopeTab(btn, active) {
        var node = btn.renderContext().shapeNode;
        node.style.background = active ? '#fff' : 'transparent';
        node.style.boxShadow = active ? '0 1px 2px rgba(0,0,0,0.12)' : 'none';
        this._paintLabelColor(btn.label, active ? '#222' : '#666');
        if (btn.label) btn.label.renderContext().shapeNode.style.fontWeight = active ? '600' : 'normal';
    },

    // Rebuilds ScopeTabsRow's active-tab styling (always present) and tears
    // down + reconstructs the Categories/Instances blocks (only present for
    // scope==='public') -- called on every scope change and whenever
    // categoryCounts/instances data resolves. Categories/Instances blocks
    // are hand-constructed fresh each call, same "build fresh, don't try to
    // patch in place" idiom ItemsGrid/_buildItemTile already use for the
    // item grid, tagged with _isSidebarExtra so this method can find and
    // remove its own previous output without disturbing ScopeTabsRow.
    _renderSidebarExtras: function _renderSidebarExtras() {
        var self = this;
        this._paintScopeTab(this.get('scopePublicButton'), this.scope === 'public');
        this._paintScopeTab(this.get('scopeMineButton'), this.scope === 'mine');
        this._paintScopeTab(this.get('scopeSharedButton'), this.scope === 'shared');

        var rail = this.get('LeftSideContainer');
        rail.submorphs.filter(function(m) { return m._isSidebarExtra; }).forEach(function(m) { m.remove(); });
        if (this.scope !== 'public') return;

        var categoriesBlock = this._buildCategoriesBlock();
        categoriesBlock._isSidebarExtra = true;
        rail.addMorph(categoriesBlock);

        var instancesBlock = this._buildInstancesBlock();
        instancesBlock._isSidebarExtra = true;
        rail.addMorph(instancesBlock);
    },

    _buildCategoriesBlock: function _buildCategoriesBlock() {
        var self = this;
        var W = 220;
        var block = new lively.morphic.Box(lively.rect(0, 0, W, 10));
        block.applyStyle({ fill: null, borderWidth: 0 });
        block.draggingEnabled = false; block.droppingEnabled = false; block.grabbingEnabled = false;

        var header = new lively.morphic.Text(lively.rect(0, 0, W, 14), 'CATEGORIES');
        // Darkened from the original 153,153,153 -- that reads fine as a
        // quiet label on white (used elsewhere in this file, e.g. "ALL
        // ITEMS"/"POPULAR THIS WEEK"), but this sidebar sits directly on
        // the window's own teal fill (LeftSideContainer's own _Fill is
        // transparent), where light grays drop to ~1.5:1 contrast --
        // effectively invisible. Computed against #57CFB3's luminance
        // rather than eyeballed.
        header.applyStyle({ fontFamily: 'Helvetica', fontSize: 7.5, textColor: Color.rgb(60,60,60), fill: null, borderWidth: 0,
            allowInput: false, selectable: false, fixedWidth: true, fixedHeight: true, clipMode: 'hidden' });
        header.eventsAreIgnored = true; header.draggingEnabled = false; header.droppingEnabled = false; header.grabbingEnabled = false;
        block.addMorph(header);

        var names = ['All'].concat(lively.identity.PartSerializer.CATEGORY_NAMES);
        var y = 18;
        names.forEach(function(name) {
            var meta = name === 'All' ? { icon: 'apps' } : lively.identity.PartSerializer.CATEGORY_META[name];
            var count = name === 'All' ? self.categoryTotal : (self.categoryCounts[name] || 0);
            var active = (self.category || 'All') === name;

            var row = new lively.morphic.Box(lively.rect(0, y, W, 24));
            row.applyStyle({ fill: active ? Color.rgba(212,84,114,0.12) : null, borderWidth: 0, borderRadius: 6 });
            row.draggingEnabled = false; row.droppingEnabled = false; row.grabbingEnabled = false;
            row._categoryValue = name === 'All' ? null : name;

            // Box sized 22x22, not the glyph's own ~16x16 model extent -- a
            // Material Symbols glyph at fontSize 12 actually RENDERS at
            // 16x18.67px (fontSize is points, not px, and the glyph's real
            // line-height overshoots its own advance width -- CLAUDE.md's
            // fontSize-in-points gotcha), so a same-size 16x16 box clips it
            // under clipMode:'hidden'. Confirmed live via getBoundingClientRect
            // on the rendered span vs. its shapeNode before this fix.
            var icon = new lively.morphic.Text(lively.rect(8, 1, 22, 22), meta.icon);
            icon.applyStyle({ fontFamily: "'Material Symbols Rounded'", fontSize: 12, textColor: active ? Color.rgbHex('#D45472') : Color.rgb(51,51,51),
                fill: null, borderWidth: 0, allowInput: false, selectable: false, fixedWidth: true, fixedHeight: true, clipMode: 'hidden' });
            icon.eventsAreIgnored = true; icon.draggingEnabled = false; icon.droppingEnabled = false; icon.grabbingEnabled = false;
            row.addMorph(icon);

            var label = new lively.morphic.Text(lively.rect(34, 4, W - 74, 16), name);
            label.applyStyle({ fontFamily: 'Helvetica', fontSize: 9, textColor: active ? Color.rgbHex('#D45472') : Color.rgb(51,51,51),
                fontWeight: active ? 'bold' : 'normal', fill: null, borderWidth: 0, allowInput: false, selectable: false,
                fixedWidth: true, fixedHeight: true, clipMode: 'hidden' });
            label.eventsAreIgnored = true; label.draggingEnabled = false; label.droppingEnabled = false; label.grabbingEnabled = false;
            row.addMorph(label);

            var countLabel = new lively.morphic.Text(lively.rect(W - 38, 4, 30, 16), String(count));
            countLabel.applyStyle({ fontFamily: 'Helvetica', fontSize: 8, textColor: Color.rgb(70,70,70), fill: null, borderWidth: 0,
                allowInput: false, selectable: false, align: 'right', fixedWidth: true, fixedHeight: true, clipMode: 'hidden' });
            countLabel.eventsAreIgnored = true; countLabel.draggingEnabled = false; countLabel.droppingEnabled = false; countLabel.grabbingEnabled = false;
            row.addMorph(countLabel);

            row.onMouseUp = function() { self.setCategory(row._categoryValue); return true; };
            block.addMorph(row);
            y += 26;
        });
        block.setExtent(lively.pt(W, y));
        return block;
    },

    _buildInstancesBlock: function _buildInstancesBlock() {
        var self = this;
        var W = 220;
        var block = new lively.morphic.Box(lively.rect(0, 0, W, 10));
        block.applyStyle({ fill: null, borderWidth: 0 });
        block.draggingEnabled = false; block.droppingEnabled = false; block.grabbingEnabled = false;

        var header = new lively.morphic.Text(lively.rect(0, 0, 140, 14), 'INSTANCES');
        // Same teal-contrast darkening as _buildCategoriesBlock's header.
        header.applyStyle({ fontFamily: 'Helvetica', fontSize: 7.5, textColor: Color.rgb(60,60,60), fill: null, borderWidth: 0,
            allowInput: false, selectable: false, fixedWidth: true, fixedHeight: true, clipMode: 'hidden' });
        header.eventsAreIgnored = true; header.draggingEnabled = false; header.droppingEnabled = false; header.grabbingEnabled = false;
        block.addMorph(header);

        var activeCount = this._activeInstanceBaseUrls().length;
        var totalCount = Math.max(this.instances.length, 1);

        // "Select all" / "None" quick actions, right-aligned on the header's
        // own row -- dimmed (and non-interactive) when they'd be a no-op,
        // same active/inactive language as every other sidebar control.
        var allIsNoop = activeCount >= totalCount;
        var noneIsNoop = activeCount === 0;
        var selectAllLink = new lively.morphic.Text(lively.rect(150, 0, 30, 14), 'All');
        selectAllLink.applyStyle({ fontFamily: 'Helvetica', fontSize: 8, fontWeight: 'bold',
            textColor: allIsNoop ? Color.rgb(90,90,90) : Color.rgbHex('#D45472'),
            fill: null, borderWidth: 0, allowInput: false, selectable: false, fixedWidth: true, fixedHeight: true, clipMode: 'hidden' });
        selectAllLink.draggingEnabled = false; selectAllLink.droppingEnabled = false; selectAllLink.grabbingEnabled = false;
        if (!allIsNoop) selectAllLink.onMouseUp = function() { self.setAllInstancesChecked(true); return true; };
        block.addMorph(selectAllLink);

        var sep = new lively.morphic.Text(lively.rect(180, 0, 8, 14), '·');
        sep.applyStyle({ fontFamily: 'Helvetica', fontSize: 8, textColor: Color.rgb(90,90,90), fill: null, borderWidth: 0,
            allowInput: false, selectable: false, fixedWidth: true, fixedHeight: true, clipMode: 'hidden' });
        sep.eventsAreIgnored = true; sep.draggingEnabled = false; sep.droppingEnabled = false; sep.grabbingEnabled = false;
        block.addMorph(sep);

        var selectNoneLink = new lively.morphic.Text(lively.rect(188, 0, 32, 14), 'None');
        selectNoneLink.applyStyle({ fontFamily: 'Helvetica', fontSize: 8, fontWeight: 'bold',
            textColor: noneIsNoop ? Color.rgb(90,90,90) : Color.rgbHex('#D45472'),
            fill: null, borderWidth: 0, allowInput: false, selectable: false, fixedWidth: true, fixedHeight: true, clipMode: 'hidden' });
        selectNoneLink.draggingEnabled = false; selectNoneLink.droppingEnabled = false; selectNoneLink.grabbingEnabled = false;
        if (!noneIsNoop) selectNoneLink.onMouseUp = function() { self.setAllInstancesChecked(false); return true; };
        block.addMorph(selectNoneLink);
        var summary = new lively.morphic.Text(lively.rect(0, 16, W, 14), 'Browsing ' + activeCount + ' of ' + totalCount + ' instances');
        summary.applyStyle({ fontFamily: 'Helvetica', fontSize: 8.5, textColor: Color.rgb(70,70,70), fill: null, borderWidth: 0,
            allowInput: false, selectable: false, fixedWidth: true, fixedHeight: true, clipMode: 'hidden' });
        summary.eventsAreIgnored = true; summary.draggingEnabled = false; summary.droppingEnabled = false; summary.grabbingEnabled = false;
        block.addMorph(summary);

        var rows = this.instances.length ? this.instances : [{ baseUrl: window.location.origin, displayName: 'This instance' }];
        var y = 36;
        rows.forEach(function(inst) {
            var checked = !!self.checkedInstances[inst.baseUrl];
            var accent = self._instanceColor(inst.baseUrl);

            // Whole row is now the click target (replacing the old native
            // <input type=checkbox>, whose real click target was a tiny
            // ~13x13px box easy to miss) -- a Material Symbols check glyph
            // conveys the toggle state instead, and the row's own background
            // tints purple when checked, matching the category sidebar's
            // active-tint language (Color.rgba(212,84,114,...)) so both
            // filter controls in this rail read as one visual system rather
            // than two different UI idioms.
            var row = new lively.morphic.Box(lively.rect(0, y, W, 26));
            row.applyStyle({ fill: checked ? Color.rgba(212,84,114,0.10) : null, borderWidth: 0, borderRadius: 6 });
            row.draggingEnabled = false; row.droppingEnabled = false; row.grabbingEnabled = false;
            row.onMouseUp = function() { self.toggleInstanceChecked(inst.baseUrl); return true; };
            // Hover feedback writes the DOM node directly rather than via
            // applyStyle -- applyStyle({fill:...}) on an already-rendered
            // morph is confirmed (CLAUDE.md) to silently no-op on background/
            // color, so the model-layer call wouldn't actually repaint here.
            row.onMouseOver = function() {
                var node = row.renderContext().shapeNode;
                if (node) node.style.background = checked ? 'rgba(212,84,114,0.16)' : 'rgba(0,0,0,0.05)';
            };
            row.onMouseOut = function() {
                var node = row.renderContext().shapeNode;
                if (node) node.style.background = checked ? 'rgba(212,84,114,0.10)' : 'transparent';
            };

            // Check-state glyph, boxed 22x22 rather than its own ~16x18.7px
            // rendered size (fontSize is points not px -- CLAUDE.md) so
            // clipMode:'hidden' doesn't chop it, same fix already applied to
            // every other icon in this sidebar (§13.3).
            var checkIcon = new lively.morphic.Text(lively.rect(2, 2, 22, 22), checked ? 'check_box' : 'check_box_outline_blank');
            checkIcon.applyStyle({ fontFamily: "'Material Symbols Rounded'", fontSize: 12,
                textColor: checked ? Color.rgbHex('#D45472') : Color.rgb(85,85,85),
                fill: null, borderWidth: 0, allowInput: false, selectable: false, fixedWidth: true, fixedHeight: true, clipMode: 'hidden' });
            checkIcon.eventsAreIgnored = true; checkIcon.draggingEnabled = false; checkIcon.droppingEnabled = false; checkIcon.grabbingEnabled = false;
            row.addMorph(checkIcon);

            // "storage" glyph (a server/rack icon) tinted per-instance --
            // same _instanceColor hash as before, now a distinct identity
            // accent alongside (not instead of) the checked-state glyph.
            var icon = new lively.morphic.Text(lively.rect(26, 2, 22, 22), 'storage');
            icon.applyStyle({ fontFamily: "'Material Symbols Rounded'", fontSize: 12, textColor: Color.rgbHex(accent),
                fill: null, borderWidth: 0, allowInput: false, selectable: false, fixedWidth: true, fixedHeight: true, clipMode: 'hidden' });
            icon.eventsAreIgnored = true; icon.draggingEnabled = false; icon.droppingEnabled = false; icon.grabbingEnabled = false;
            row.addMorph(icon);

            var label = new lively.morphic.Text(lively.rect(50, 5, W - 56, 16),
                inst.displayName || inst.baseUrl.replace(/^https?:\/\//, ''));
            label.applyStyle({ fontFamily: 'Helvetica', fontSize: 8.5, textColor: checked ? Color.rgb(34,34,34) : Color.rgb(70,70,70),
                fontWeight: checked ? 'bold' : 'normal', fill: null, borderWidth: 0, allowInput: false, selectable: false,
                fixedWidth: true, fixedHeight: true, clipMode: 'hidden' });
            label.eventsAreIgnored = true; label.draggingEnabled = false; label.droppingEnabled = false; label.grabbingEnabled = false;
            row.addMorph(label);

            block.addMorph(row);
            y += 28;
        });
        block.setExtent(lively.pt(W, y));
        return block;
    },

    // Deterministic color per instance baseUrl (no server-side color
    // assignment exists) -- a small fixed palette keyed by a cheap hash, so
    // the same instance always gets the same dot color across reloads.
    _instanceColor: function _instanceColor(baseUrl) {
        var palette = ['#D45472', '#0d9488', '#ea580c', '#2563eb', '#db2777', '#16a34a'];
        var hash = 0;
        for (var i = 0; i < baseUrl.length; i++) hash = (hash * 31 + baseUrl.charCodeAt(i)) >>> 0;
        return palette[hash % palette.length];
    },

    // ─── curated categories (inventory.md §7/§13 Phase D) ─────────────────
    // Counts for the sidebar's All/Media/Games/Templates/Apps/Tools rows --
    // always against the local instance; fan-out category-count aggregation
    // across multiple instances is out of scope, same reasoning the old
    // freeform-tag aggregation this replaces already had.

    loadCategoryCounts: function loadCategoryCounts() {
        var self = this;
        this._fetchJson(window.location.origin + '/parts/public/categories', function(err, body) {
            if (err || !body || !body.categories) return;
            var counts = {};
            body.categories.forEach(function(c) { if (c.category) counts[c.category] = c.count; });
            self.categoryCounts = counts;
            self.categoryTotal = body.total || 0;
            self._renderSidebarExtras();
        });
    },

    // ─── loading items ──────────────────────────────────────────────────

    search: function search(text) {
        this.searchQuery = (text || '').trim();
        this.cursor = null;
        this._loadItemsPage(false);
    },

    loadMoreItems: function loadMoreItems() {
        if (!this.cursor) return;
        this._loadItemsPage(true);
    },

    _loadItemsPage: function _loadItemsPage(append) {
        if (this.scope === 'mine') return this._loadOwnedItemsPage(append, '/parts/mine');
        if (this.scope === 'shared') return this._loadOwnedItemsPage(append, '/parts/shared-with-me');
        this._loadPublicItemsPage(append);
    },

    // scope === 'public': fan out across every checked instance
    // (inventory.md §3.2). True cursor pagination only makes sense against
    // a single source -- juggling N independent opaque cursors across a
    // merged multi-instance feed is real added complexity this pass
    // deliberately skips (nothing in inventory.md §3.2 requires it either).
    // Checking more than one instance switches to one larger capped fetch
    // per instance instead, merged and re-sorted client-side, with "load
    // more" disabled -- the same "capped, no pagination" trade-off
    // ObjectRepository.listPublicParts already makes server-side for its
    // non-recent sorts (see IdentityServer.js/ObjectRepository.js).
    _loadPublicItemsPage: function _loadPublicItemsPage(append) {
        var self = this;
        var instances = this._activeInstanceBaseUrls();
        var fanningOut = instances.length > 1;
        var limit = fanningOut ? 48 : 24;

        var paramsFor = function(baseUrl) {
            var params = ['limit=' + limit];
            if (!fanningOut && self.cursor && append) params.push('cursor=' + encodeURIComponent(self.cursor));
            if (self.searchQuery) params.push('q=' + encodeURIComponent(self.searchQuery));
            if (self.category) params.push('category=' + encodeURIComponent(self.category));
            if (self.sort && self.sort !== 'recent') params.push('sort=' + encodeURIComponent(self.sort));
            return baseUrl + '/parts/public?' + params.join('&');
        };

        this.setStatus('Loading…');
        var remaining = instances.length;
        var allItems = [];
        var lastErr = null;
        var singleCursor = null;
        instances.forEach(function(baseUrl) {
            self._fetchJson(paramsFor(baseUrl), function(err, body) {
                if (err || !body || !body.parts) {
                    lastErr = lastErr || err || new Error('bad response from ' + baseUrl);
                } else {
                    body.parts.forEach(function(row) { allItems.push(self._buildItemFromListingRow(row, baseUrl)); });
                    if (!fanningOut) singleCursor = body.cursor;
                }
                if (--remaining === 0) finish();
            });
        });

        function finish() {
            if (!allItems.length && lastErr) { self.setStatus('Load failed', true); return; }
            if (!append) self.get('ItemsGrid').removeAllItems();
            if (fanningOut) allItems = self._sortMergedItems(allItems);
            self.get('ItemsGrid').startAddingItems(allItems);
            self.cursor = fanningOut ? null : singleCursor;
            var canLoadMore = !fanningOut && !!self.cursor;
            self.get('loadMoreButton').setVisible(canLoadMore);
            self.setStatus((append ? 'Loaded ' : '') + allItems.length + ' item' + (allItems.length === 1 ? '' : 's') +
                (canLoadMore ? ' (more available)' : ''));
        }
    },

    // scope === 'mine' | 'shared': always same-origin, always credentialed
    // (self-only routes, auth.requireAuth) -- no fan-out, no instance
    // concept at all. path is '/parts/mine' or '/parts/shared-with-me'.
    _loadOwnedItemsPage: function _loadOwnedItemsPage(append, path) {
        var self = this;
        var user = (typeof lively !== 'undefined' && lively.identity && lively.identity.did &&
            lively.identity.did.currentUser && lively.identity.did.currentUser());
        if (!user) {
            this.get('ItemsGrid').removeAllItems();
            this.setStatus('Sign in to see this.', true);
            this.get('loadMoreButton').setVisible(false);
            return;
        }
        var params = ['limit=24'];
        if (this.cursor && append) params.push('cursor=' + encodeURIComponent(this.cursor));
        this.setStatus('Loading…');
        var url = window.location.origin + '/@' + encodeURIComponent(user.handle) + path + '?' + params.join('&');
        this._fetchJson(url, function(err, body) {
            if (err || !body || !body.parts) { self.setStatus('Load failed', true); return; }
            if (!append) self.get('ItemsGrid').removeAllItems();
            var items = body.parts.map(function(row) { return self._buildItemFromListingRow(row, window.location.origin); });
            self.get('ItemsGrid').startAddingItems(items);
            self.cursor = body.cursor;
            self.get('loadMoreButton').setVisible(!!self.cursor);
            self.setStatus((append ? 'Loaded ' : '') + body.parts.length + ' item' + (body.parts.length === 1 ? '' : 's') +
                (self.cursor ? ' (more available)' : ''));
        });
    },

    // Best-effort re-sort of a fan-out-merged item list -- each source
    // instance's own SQL ordering doesn't compose once rows from several
    // instances are interleaved. Mirrors the same sort keys
    // ObjectRepository.listPublicParts supports server-side for a single
    // instance; 'recent' falls back to each item's own `created` timestamp
    // (fan-out mode never uses the id-based cursor ordering, since ids
    // aren't comparable across separate databases).
    _sortMergedItems: function _sortMergedItems(items) {
        var sort = this.sort || 'recent';
        var byCreatedDesc = function(a, b) {
            var ca = (a.envelope && a.envelope.created) || '';
            var cb = (b.envelope && b.envelope.created) || '';
            return ca < cb ? 1 : ca > cb ? -1 : 0;
        };
        if (sort === 'az') {
            return items.slice().sort(function(a, b) { return (a.name || '').localeCompare(b.name || ''); });
        }
        if (sort === 'popular') {
            return items.slice().sort(function(a, b) { return (b.starCount || 0) - (a.starCount || 0); });
        }
        // 'mostCommented' has no per-item comment count on listing rows
        // (deliberately not fetched for every row, same reasoning as
        // htmlLogo -- see _withStarCounts' own comment in IdentityServer.js)
        // -- falls back to recency, same as 'recentlyPublished'/'recent'.
        return items.slice().sort(byCreatedDesc);
    },

    // ─── popular strip (inventory.md §13 Phase D) ──────────────────────────
    // Independent top-8-by-stars fetch for the "Popular this week" strip --
    // deliberately NOT reusing _loadItemsPage/_sortMergedItems (those are
    // driven by this.sort, the main grid's own sort choice; the strip is
    // always popular-sorted regardless). Same fan-out-but-capped trade-off
    // as _loadPublicItemsPage: one bounded fetch per checked instance,
    // merged and re-sorted client-side, no pagination cursor -- chevron
    // paging below just re-slices the already-fetched top 8.
    loadPopularStrip: function loadPopularStrip() {
        var self = this;
        var instances = this._activeInstanceBaseUrls();
        var remaining = instances.length;
        var allItems = [];
        instances.forEach(function(baseUrl) {
            self._fetchJson(baseUrl + '/parts/public?limit=8&sort=popular', function(err, body) {
                if (!err && body && body.parts) {
                    body.parts.forEach(function(row) { allItems.push(self._buildItemFromListingRow(row, baseUrl)); });
                }
                if (--remaining === 0) finish();
            });
        });
        function finish() {
            allItems.sort(function(a, b) { return (b.starCount || 0) - (a.starCount || 0); });
            self.popularItems = allItems.slice(0, 8);
            self.popularStart = 0;
            self._renderPopularTiles();
        }
    },

    popularPrev: function popularPrev() {
        this.popularStart = Math.max(0, this.popularStart - 4);
        this._renderPopularTiles();
    },

    popularNext: function popularNext() {
        var maxStart = Math.max(0, this.popularItems.length - 4);
        this.popularStart = Math.min(maxStart, this.popularStart + 4);
        this._renderPopularTiles();
    },

    // Adds/removes the whole PopularCard block and shows/hides TopBar's
    // sort controls based on scope (public-only, per plan) -- called from
    // reloadEverything on every scope switch. PopularCard is inserted
    // before AllItemsCard (MainContainer.addMorph's 2-arg "insert before"
    // form) so AllItemsCard stays MainContainer's flexible LAST child
    // either way, matching the fixed-then-flexible-last VerticalLayout
    // shape this file already relies on elsewhere.
    _renderMainColumnForScope: function _renderMainColumnForScope() {
        var mainContainer = this.get('MainContainer');
        var topBar = this.get('TopBar');
        var showSort = this.scope === 'public';
        ['sortPopularButton', 'sortRecentButton', 'sortMenuButton'].forEach(function(name) {
            var m = topBar.get(name);
            if (m) m.setVisible(showSort);
        });
        var existingPopular = this.get('PopularCard');
        if (showSort && !existingPopular) {
            mainContainer.addMorph(this._buildPopularCard(), mainContainer.get('AllItemsCard'));
            this._renderPopularTiles();
        } else if (!showSort && existingPopular) {
            existingPopular.remove();
        }
        this._repaintSortControls();
    },

    _repaintSortControls: function _repaintSortControls() {
        if (this.scope !== 'public') return;
        var topBar = this.get('TopBar');
        this._paintSortPill(topBar.get('sortPopularButton'), this.sort === 'popular');
        this._paintSortPill(topBar.get('sortRecentButton'), this.sort === 'recent');
        var extraActive = ['az', 'mostCommented', 'recentlyPublished'].indexOf(this.sort) !== -1;
        this._paintSortMenuButton(topBar.get('sortMenuButton'), extraActive);
    },

    _paintSortPill: function _paintSortPill(btn, active) {
        if (!btn) return;
        var node = btn.renderContext().shapeNode;
        node.style.background = active ? '#D45472' : '#fff';
        node.style.border = active ? 'none' : '1px solid rgb(214,214,214)';
        this._paintLabelColor(btn.label, active ? '#fff' : '#333');
    },

    _paintSortMenuButton: function _paintSortMenuButton(btn, active) {
        if (!btn) return;
        var node = btn.renderContext().shapeNode;
        node.style.background = active ? '#D45472' : '#fff';
        node.style.border = active ? 'none' : '1px solid rgb(214,214,214)';
        this._paintLabelColor(btn.label, active ? '#fff' : '#333');
    },

    // Popup for the full sort-key list, opened from the filter_list icon
    // button -- "Recent" is repeated here (also its own quick-access pill)
    // so this menu reads as a complete "Sort by" list on its own, not just
    // the 3 keys that lack a dedicated pill.
    // Exact same lively.morphic.Menu.openAt mechanism as openInspectorMenu
    // below, so it doesn't need its own show/hide state.
    openSortMenu: function openSortMenu() {
        var btn = this.get('TopBar').get('sortMenuButton');
        var pos = btn.worldPoint(lively.pt(0, btn.getExtent().y));
        var self = this;
        var items = [
            ['Recent' + (self.sort === 'recent' ? '  ✓' : ''), function() { self.setSort('recent'); }],
            ['Alphabetical (A–Z)' + (self.sort === 'az' ? '  ✓' : ''), function() { self.setSort('az'); }],
            ['Most Commented' + (self.sort === 'mostCommented' ? '  ✓' : ''), function() { self.setSort('mostCommented'); }],
            ['Recently Published' + (self.sort === 'recentlyPublished' ? '  ✓' : ''), function() { self.setSort('recentlyPublished'); }]
        ];
        lively.morphic.Menu.openAt(pos, 'Sort by', items);
    },

    // ─── popular strip rendering (inventory.md §13 Phase D) ────────────────

    _buildPopularCard: function _buildPopularCard() {
        var card = new lively.morphic.Box(lively.rect(0, 0, 840, 232));
        card.applyStyle({ fill: Color.white, borderWidth: 1, borderColor: Color.rgb(230,230,230), borderRadius: 12 });
        card.name = 'PopularCard';
        card.draggingEnabled = false; card.droppingEnabled = false; card.grabbingEnabled = false;

        var header = new lively.morphic.Text(lively.rect(16, 12, 300, 14), 'POPULAR THIS WEEK');
        header.applyStyle({ fontFamily: 'Helvetica', fontSize: 7.5, textColor: Color.rgb(153,153,153), fill: null, borderWidth: 0,
            allowInput: false, selectable: false, fixedWidth: true, fixedHeight: true, clipMode: 'hidden' });
        header.eventsAreIgnored = true; header.draggingEnabled = false; header.droppingEnabled = false; header.grabbingEnabled = false;
        card.addMorph(header);

        // Empty content placeholder -- _renderPopularTiles fills this in
        // (tagged _isPopularContent so it can clear+rebuild without
        // touching the header above).
        return card;
    },

    _renderPopularTiles: function _renderPopularTiles() {
        var self = this;
        var card = this.get('PopularCard');
        if (!card) return;
        card.submorphs.filter(function(m) { return m._isPopularContent; }).forEach(function(m) { m.remove(); });

        var TILE_W = 168, GAP = 16, VISIBLE = 4;
        var visible = this.popularItems.slice(this.popularStart, this.popularStart + VISIBLE);
        var leftDisabled = this.popularStart <= 0;
        var rightDisabled = this.popularStart >= Math.max(0, this.popularItems.length - VISIBLE);

        function iconButton(x, glyph, disabled, onClick) {
            var btn = new lively.morphic.Box(lively.rect(x, 40, 32, 32));
            btn.applyStyle({ fill: Color.white, borderWidth: 1, borderColor: disabled ? Color.rgb(238,238,238) : Color.rgb(214,214,214), borderRadius: 16 });
            btn._isPopularContent = true;
            btn.draggingEnabled = false; btn.droppingEnabled = false; btn.grabbingEnabled = false;
            // 24x24, not 24x16 -- a fontSize:13 glyph renders ~17x21px tall,
            // taller than a 16px-tall box (same clipping gotcha as the
            // sidebar category icons above).
            var icon = new lively.morphic.Text(lively.rect(4, 4, 24, 24), glyph);
            icon.applyStyle({ fontFamily: "'Material Symbols Rounded'", fontSize: 13, textColor: disabled ? Color.rgb(204,204,204) : Color.rgb(51,51,51),
                fill: null, borderWidth: 0, allowInput: false, selectable: false, align: 'center', fixedWidth: true, fixedHeight: true, clipMode: 'hidden' });
            icon.eventsAreIgnored = true; icon.draggingEnabled = false; icon.droppingEnabled = false; icon.grabbingEnabled = false;
            btn.addMorph(icon);
            if (!disabled) btn.onMouseUp = function() { onClick(); return true; };
            return btn;
        }

        card.addMorph(iconButton(16, 'chevron_left', leftDisabled, function() { self.popularPrev(); }));
        card.addMorph(iconButton(792, 'chevron_right', rightDisabled, function() { self.popularNext(); }));

        visible.forEach(function(item, i) {
            var tile = self._buildItemTile(item);
            tile._isPopularContent = true;
            tile.setPosition(pt(56 + i * (TILE_W + GAP), 40));
            card.addMorph(tile);
        });
    },

    // POST helper (parallel to _fetchJson's GET) -- same-origin only
    // (federation directory writes are always local, per inventory.md
    // §3.2), credentialed.
    _postJson: function _postJson(url, body, cb) {
        fetch(url, {
            method: 'POST',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        })
            .then(function(res) {
                if (!res.ok) throw new Error('HTTP ' + res.status);
                return res.json();
            })
            .then(function(json) { cb(null, json); })
            .catch(function(err) { cb(err); });
    },

    setStatus: function setStatus(text, isError) {
        var t = this.get('statusText');
        t.textString = text || '';
        t.setTextColor(isError ? Color.rgb(204,51,51) : Color.rgb(120,120,120));
    },

    // ─── item construction ──────────────────────────────────────────────

    // Builds an IdentityPartItem from a /parts/public listing row — no
    // owning IdentityPartsSpace exists for another user's items, so this is
    // constructed by hand the same way the old PublicPartsBrowser.js's
    // _openEnvelope already did, just eagerly (once per grid item, not only
    // on open). fetchHtmlLogo is read by PartsBinItem.setupLogo
    // (core/lively/morphic/ScriptingSupport.js) to lazily fetch the full
    // envelope (and therefore the real htmlLogo snapshot) once this tile
    // actually mounts, mirroring setupHTMLLogo's own fetch-then-paint
    // pattern for WebDAV parts.
    _buildItemFromListingRow: function _buildItemFromListingRow(row, baseUrl) {
        var self = this;
        var state = row.state || {};
        var partName = state.partName || row.objId;
        var item = new lively.identity.IdentityPartItem(partName, '*public*');
        item.envelope = row;
        item.handle = row.handle;
        item._instanceBaseUrl = baseUrl;
        // Enrichment fields the row already carries but IdentityPartItem
        // itself has no slot for -- read directly by the item-tile morph
        // (inventory.md §13 Phase D) rather than round-tripping through
        // the envelope again.
        item.category = state.category || null;
        item.starCount = row.starCount || 0;

        var metaInfo = new lively.PartsBin.PartsBinMetaInfo();
        metaInfo.partName = partName;
        metaInfo.comment = state.comment || '';
        metaInfo.tags = state.tags || [];
        metaInfo.partsSpaceName = '*public*';
        metaInfo.lastModifiedDate = row.created ? new Date(row.created) : new Date();
        item.loadedMetaInfo = metaInfo;

        item.fetchHtmlLogo = function(cb) {
            self._fetchFullEnvelope(item, function(err, fullEnv) {
                if (err) { cb(err); return; }
                cb(null, fullEnv.state && fullEnv.state.htmlLogo);
            });
        };
        return item;
    },

    // ─── item tile (inventory.md §13 Phase D) ───────────────────────────
    // Display + select only, for the grid and (later) the popular-strip —
    // a category-tinted icon square (not a live rendered preview, matching
    // the §13 mockup's own design) with an instance badge and star-count
    // badge overlaid, plus title/author below. Deliberately NOT
    // lively.morphic.PartsBinItem/PartItem: no drag-to-load here (a real,
    // documented scope cut — see the module comment at the top of this
    // file's "Naming convention" block and inventory.md §13). Open Item /
    // View Source / Inspect in the right panel remain the only load path
    // from this grid, already trust-gated (inventory.md §11) via
    // IdentityPartItem.loadPart -> PartItem.setPartFromJSON regardless of
    // how the tile itself looks.
    //
    // Every decorative child sets draggingEnabled/droppingEnabled/
    // grabbingEnabled to false AND eventsAreIgnored:true (CLAUDE.md's
    // "three flags, every visual child individually" gotcha) so a click
    // anywhere on the tile reaches the tile's own onMouseUp instead of
    // being intermittently swallowed by whichever child happens to be
    // under the cursor. Category color/icon lookup goes through
    // lively.identity.PartSerializer's namespace-object properties (never
    // a closure var), matching CLAUDE.md's BuildSpec-closure-loss fix --
    // not strictly required here (tiles are hand-constructed each reload,
    // never serialized/reconstructed), but costs nothing and matches this
    // codebase's established idiom for the same lookup.
    _buildItemTile: function _buildItemTile(item) {
        var meta = (item.category && lively.identity.PartSerializer.CATEGORY_META[item.category]) ||
            lively.identity.PartSerializer.UNCATEGORIZED_META;
        var instanceLabel = (item._instanceBaseUrl || window.location.origin)
            .replace(/^https?:\/\//, '').replace(/\/$/, '');

        var W = 168, H = 180, ICON_H = 140, BORDER = 2;
        var tile = new lively.morphic.Box(lively.rect(0, 0, W, H));
        // borderWidth is fixed at BORDER (2) in BOTH selected and unselected
        // states (below) -- this codebase has no box-sizing:border-box
        // anywhere (checked core/styles/*.css), so content-box sizing means
        // growing borderWidth on selection (was 1 -> 2) actually grows the
        // tile's total rendered footprint by 2px right/bottom. With only an
        // 8px gap between tiles (ItemsGrid's adjustForNewBounds delta), that
        // growth reads as the selected tile's own highlight border getting
        // clipped/overlapped by whatever sits after it. Keeping the width
        // constant and only swapping *color* on selection (border color/
        // width both reach the DOM fine via the model layer here, per this
        // file's own established note on that) means the box footprint
        // never changes.
        tile.applyStyle({ fill: Color.white, borderWidth: BORDER, borderColor: Color.rgb(230,230,230), borderRadius: 10 });
        tile.partItem = item;
        tile.draggingEnabled = false;
        tile.droppingEnabled = false;
        tile.grabbingEnabled = false;
        tile.isSelected = false;

        function noDrag(m) {
            m.draggingEnabled = false; m.droppingEnabled = false; m.grabbingEnabled = false;
            m.eventsAreIgnored = true;
        }

        // Confirmed live (getBoundingClientRect on tile vs iconArea): a
        // child morph's local (0,0) lands at the PARENT's own outer/border-
        // box origin in this framework, not inset by the parent's border --
        // submorphs don't automatically sit inside the padding/content box
        // the way normal nested CSS boxes would. iconArea used to be built
        // flush at (0,0) with the tile's own full W -- since it's opaque and
        // painted after the tile's own border, it fully covered the top
        // edge of the tile's border (and the left/right edges for its own
        // height) regardless of border width, including before this session
        // ever touched borderWidth. This was the real cause of the
        // selection highlight only showing as a sliver on the left/bottom.
        // Fix: inset iconArea by BORDER on the three edges that coincide
        // with the tile's own outer edge (top/left/right) -- its bottom
        // edge is an interior boundary (between icon area and the title
        // below it), not touching the tile's own border, so it stays flush
        // at ICON_H unchanged. Every child positioned relative to iconArea
        // below uses innerW/innerH (iconArea's real size), not the outer
        // W/ICON_H, to stay correctly centered/anchored within the now-
        // smaller area.
        var innerW = W - 2 * BORDER, innerH = ICON_H - BORDER;
        var iconArea = new lively.morphic.Box(lively.rect(BORDER, BORDER, innerW, innerH));
        iconArea.applyStyle({ fill: Color.rgbHex(meta.tint), borderWidth: 0, borderRadius: 9 });
        noDrag(iconArea);
        tile.addMorph(iconArea);

        var icon = new lively.morphic.Text(lively.rect((innerW - 60) / 2, (innerH - 60) / 2, 60, 60), meta.icon);
        icon.applyStyle({
            fontFamily: "'Material Symbols Rounded'", fontSize: 33, textColor: Color.rgbHex(meta.accent),
            fill: null, borderWidth: 0, allowInput: false, selectable: false, align: 'center',
            fixedWidth: true, fixedHeight: true, clipMode: 'hidden'
        });
        noDrag(icon);
        iconArea.addMorph(icon);

        var badge = new lively.morphic.Box(lively.rect(6, 6, 74, 16));
        badge.applyStyle({ fill: Color.rgba(255,255,255,0.88), borderWidth: 0, borderRadius: 8 });
        noDrag(badge);
        iconArea.addMorph(badge);
        var badgeLabel = new lively.morphic.Text(lively.rect(5, 1, 64, 14), instanceLabel);
        badgeLabel.applyStyle({
            fontSize: 7, textColor: Color.rgb(68,68,68), fill: null, borderWidth: 0,
            allowInput: false, selectable: false, fixedWidth: true, fixedHeight: true, clipMode: 'hidden'
        });
        noDrag(badgeLabel);
        badge.addMorph(badgeLabel);

        // Badge grown from 16 to 20px tall (bottom edge held at ICON_H-6, same
        // as before) so a fontSize:9 star glyph (renders ~12x14.67px) has
        // room -- a 14x14 icon box was clipping it, same gotcha as the
        // sidebar category icons.
        var starBadge = new lively.morphic.Box(lively.rect(innerW - 6 - 44, innerH - 6 - 20, 44, 20));
        starBadge.applyStyle({ fill: Color.rgba(255,255,255,0.9), borderWidth: 0, borderRadius: 10 });
        noDrag(starBadge);
        iconArea.addMorph(starBadge);
        var starIcon = new lively.morphic.Text(lively.rect(4, 1, 17, 18), 'star');
        starIcon.applyStyle({
            fontFamily: "'Material Symbols Rounded'", fontSize: 9, textColor: Color.rgbHex('#d97706'),
            fill: null, borderWidth: 0, allowInput: false, selectable: false, fixedWidth: true, fixedHeight: true, clipMode: 'hidden'
        });
        noDrag(starIcon);
        var starText = new lively.morphic.Text(lively.rect(23, 3, 17, 14), String(item.starCount || 0));
        starText.applyStyle({
            fontFamily: "Helvetica", fontSize: 8, textColor: Color.rgb(68,68,68), fill: null, borderWidth: 0,
            allowInput: false, selectable: false, fixedWidth: true, fixedHeight: true, clipMode: 'hidden'
        });
        noDrag(starText);
        starBadge.addMorph(starText);
        starBadge.addMorph(starIcon);

        var title = new lively.morphic.Text(lively.rect(4, ICON_H + 4, W - 8, 16), item.name || '');
        title.applyStyle({
            fontFamily: "Helvetica", fontSize: 9, textColor: Color.rgb(34,34,34), fill: null, borderWidth: 0,
            allowInput: false, selectable: false, fixedWidth: true, fixedHeight: true, clipMode: 'hidden'
        });
        noDrag(title);
        tile.addMorph(title);

        var author = new lively.morphic.Text(lively.rect(4, ICON_H + 20, W - 8, 14), item.handle ? ('@' + item.handle) : '');
        author.applyStyle({
            fontFamily: "Helvetica", fontSize: 7.5, textColor: Color.rgb(136,136,136), fill: null, borderWidth: 0,
            allowInput: false, selectable: false, fixedWidth: true, fixedHeight: true, clipMode: 'hidden'
        });
        noDrag(author);
        tile.addMorph(author);

        tile.showAsSelected = function() {
            this.isSelected = true;
            this.applyStyle({ borderColor: Color.rgbHex('#D45472') });
        };
        tile.showAsNotSelected = function() {
            this.isSelected = false;
            this.applyStyle({ borderColor: Color.rgb(230,230,230) });
        };
        tile.onMouseUp = function(evt) {
            var browser = this.get('InventoryBrowser');
            if (browser) browser.selectTile(this);
            return true;
        };

        // Real per-item preview. item.fetchHtmlLogo (_buildItemFromListingRow,
        // above) lazily fetches the full envelope and resolves the part's own
        // asHTMLLogo() snapshot (state.htmlLogo, pre-scaled to an ~85px max
        // dimension at publish time -- see PartsBin.js's copyToIdentityPartsSpace)
        // -- built for exactly this "fetch once the tile actually mounts"
        // purpose (see that method's own comment, and ScriptingSupport.js's
        // PartsBinItem.setupLogo, which already reads it the same way for the
        // classic browser) but never wired into this tile design when it was
        // built (inventory.md §13 explicitly scoped this tile to "a category-
        // tinted icon square, not a live rendered preview"). Mounts the same
        // way setupIdentityHTMLLogo does: strip the <body> wrapper, mount the
        // raw markup via a Shapes.External morph, centered in the icon area,
        // added with addMorphBack so it paints behind the instance/star
        // badges (already added above) but in front of iconArea's own tint
        // fill. The generic category glyph is removed once a real logo
        // lands, so a part with no stored snapshot (published before this
        // existed, or fetch failure) still falls back to today's tinted icon.
        if (typeof item.fetchHtmlLogo === 'function') {
            item.fetchHtmlLogo(function(err, htmlLogo) {
                // tile.world() guards against a scope/category switch having
                // already torn the tile back out (ItemsGrid.removeAllItems)
                // by the time this async fetch resolves.
                if (err || !htmlLogo || !tile.world()) return;
                var source = htmlLogo.replace(/.*<body>/, '').replace(/<\/body>.*/, '');
                var node = XHTMLNS.create('div');
                try { node.innerHTML = source; } catch (e) { return; }
                var LOGO = 85;
                var logoMorph = new lively.morphic.Morph(new lively.morphic.Shapes.External(node));
                logoMorph.setBounds(lively.rect((innerW - LOGO) / 2, (innerH - LOGO) / 2, LOGO, LOGO));
                noDrag(logoMorph);
                icon.remove();
                iconArea.addMorphBack(logoMorph);
            });
        }

        return tile;
    },

    // Fetches the full envelope for `item` (record.payload + htmlLogo
    // included) and upgrades item.envelope in place — shared by
    // fetchHtmlLogo (thumbnail) and openSelectedItem (actual open), so a
    // tile whose thumbnail already loaded needs no second round-trip to
    // open.
    _fetchFullEnvelope: function _fetchFullEnvelope(item, cb) {
        if (item.envelope && item.envelope.record && item.envelope.record.payload) {
            cb(null, item.envelope);
            return;
        }
        var base = item._instanceBaseUrl || window.location.origin;
        var url = base + '/@' + encodeURIComponent(item.handle || '_') + '/' + encodeURIComponent(item.envelope.objId);
        this._fetchJson(url, function(err, envelope) {
            if (err) { cb(err); return; }
            item.envelope = envelope;
            cb(null, envelope);
        });
    },

    // Anonymous for a different instance (a wildcard Access-Control-Allow-Origin
    // response can't be combined with credentialed requests — see the
    // matching comment on IdentityPartItem.loadPartVersions), credentialed
    // for the local instance so a signed-in viewer's own richer optionalAuth
    // responses still apply exactly as before this feature existed.
    _fetchJson: function _fetchJson(url, cb) {
        var base = url.split('/').slice(0, 3).join('/');
        var isCrossOrigin = base !== window.location.origin;
        fetch(url, isCrossOrigin ? {} : { credentials: 'include' })
            .then(function(res) {
                if (!res.ok) throw new Error('HTTP ' + res.status);
                return res.json();
            })
            .then(function(body) { cb(null, body); })
            .catch(function(err) { cb(err); });
    },

    // ─── selection / info panel (inventory.md §13 Phase D) ────────────────
    // selectTile is the one entry point every tile's onMouseUp calls now
    // (both the All-items grid and the Popular strip share it) -- replaces
    // the old ItemsGrid-local selectPartItem/connectionRebuilder binding,
    // since a tile can now live in either container and selecting one must
    // deselect the other regardless of which one currently holds it.

    selectTile: function selectTile(tileMorph) {
        if (this.selectedTileMorph && this.selectedTileMorph !== tileMorph && this.selectedTileMorph.showAsNotSelected) {
            this.selectedTileMorph.showAsNotSelected();
        }
        this.selectedTileMorph = tileMorph;
        if (tileMorph && tileMorph.showAsSelected) tileMorph.showAsSelected();
        this.setSelectedItem(tileMorph && tileMorph.partItem);
    },

    setSelectedItem: function setSelectedItem(item) {
        this.selectedItem = item;
        if (!item) {
            this.selectedItemStarInfo = null;
            this.selectedItemComments = [];
            this.versionsExpanded = false;
            this.renderRightPanel();
            return;
        }
        this.versionsExpanded = false;
        this.renderRightPanel();

        var self = this;
        item.loadPartVersions();
        // loadPartVersions is a plain synchronous-looking call whose XHR
        // resolves later and just assigns item.partVersions once (no
        // incremental streaming the way the classic browser's WebDAV
        // metaInfo connect had to handle) — poll briefly rather than wiring
        // a lively.bindings connect for a single one-shot value.
        var waited = 0;
        (function poll() {
            if (self.selectedItem !== item) return; // selection moved on
            if (item.partVersions) { self.renderRightPanel(); return; }
            waited += 150;
            if (waited > 4000) return;
            setTimeout(poll, 150);
        })();

        this.loadStarInfoForSelectedItem();
        this.loadCommentsForSelectedItem();
    },

    // ─── stars (inventory.md §13) ───────────────────────────────────────
    // State lives on the browser (selectedItemStarInfo) rather than a
    // dedicated widget for now -- Phase D's right-panel star button reads
    // this the same way selectedItemVersions' poll above feeds a not-yet-
    // built version-badge UI. _itemUrl is shared with the comment methods
    // below.

    _itemUrl: function _itemUrl(item, suffix) {
        var base = item._instanceBaseUrl || window.location.origin;
        return base + '/@' + encodeURIComponent(item.handle || '_') + '/' + encodeURIComponent(item.envelope.objId) + suffix;
    },

    loadStarInfoForSelectedItem: function loadStarInfoForSelectedItem() {
        var self = this, item = this.selectedItem;
        this.selectedItemStarInfo = null;
        if (!item) return;
        this._fetchJson(this._itemUrl(item, '/stars'), function(err, info) {
            if (self.selectedItem !== item) return; // selection moved on
            if (err || !info) return;
            self.selectedItemStarInfo = info;
            self.renderRightPanel();
        });
    },

    toggleStarOnSelectedItem: function toggleStarOnSelectedItem() {
        var self = this, item = this.selectedItem;
        if (!item) return;
        var info = this.selectedItemStarInfo;
        var wantStar = !(info && info.mine);
        var base = item._instanceBaseUrl || window.location.origin;
        var url = base + '/@' + encodeURIComponent(item.handle || '_') + '/' + encodeURIComponent(item.envelope.objId) + '/stars' + (wantStar ? '' : '/self');
        this._postOrDeleteJson(wantStar ? 'PUT' : 'DELETE', url, function(err) {
            if (err) { self.setStatus('Could not update star: ' + (err.message || err), true); return; }
            self.loadStarInfoForSelectedItem();
        });
    },

    // ─── comments (inventory.md §13) ────────────────────────────────────

    loadCommentsForSelectedItem: function loadCommentsForSelectedItem() {
        var self = this, item = this.selectedItem;
        this.selectedItemComments = [];
        if (!item) return;
        this._fetchJson(this._itemUrl(item, '/comments?limit=50'), function(err, body) {
            if (self.selectedItem !== item) return;
            if (err || !body || !body.comments) return;
            self.selectedItemComments = body.comments;
            self.renderRightPanel();
        });
    },

    postCommentOnSelectedItem: function postCommentOnSelectedItem(body) {
        var self = this, item = this.selectedItem;
        var text = (body || '').trim();
        if (!item || !text) return;
        this._postJson(this._itemUrl(item, '/comments'), { body: text }, function(err) {
            if (err) { self.setStatus('Could not post comment: ' + (err.message || err), true); return; }
            self.loadCommentsForSelectedItem();
        });
    },

    // PUT/DELETE helper (parallel to _fetchJson/_postJson) -- used by the
    // star toggle, which needs both verbs against the same URL shape.
    _postOrDeleteJson: function _postOrDeleteJson(method, url, cb) {
        fetch(url, { method: method, credentials: 'include' })
            .then(function(res) {
                if (!res.ok) throw new Error('HTTP ' + res.status);
                return res.json();
            })
            .then(function(json) { cb(null, json); })
            .catch(function(err) { cb(err); });
    },

    // Referenced as this._formatBytes(...) from describeItemMeta below, not
    // a closure var -- this is a lively.BuildSpec(...) class (see this
    // file's own module() line), so a spec method's body is reconstructed
    // from its own source text at call time and loses any module-local
    // closure (CLAUDE.md's BuildSpec/addScript closure gotcha). A sibling
    // spec property is the documented fix.
    _formatBytes: function _formatBytes(n) {
        if (n == null || isNaN(n)) return 'unknown';
        if (n < 1024) return n + ' B';
        if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
        return (n / (1024 * 1024)).toFixed(1) + ' MB';
    },

    // Object ID and Author DID each get their own line (previously crammed
    // onto one "Object ID: X   Author DID: Y" line) -- objIdLineIndex/
    // didLineIndex are the zero-based line numbers within `text` that
    // renderRightPanel uses to position a copy-icon button next to each,
    // rather than encoding a clickable character range into the text
    // itself (the old single-line version only made the DID copiable, via
    // an emphasize()'d icon glyph baked into the text -- replaced below by
    // real copy buttons, one per field, following ProfileCard.js's own
    // established copy-button idiom).
    describeItemMeta: function describeItemMeta(item) {
        if (!item || !item.envelope) return null;
        var env = item.envelope;
        var created = env.created ? new Date(env.created).format('yyyy-mm-dd HH:MM') : 'unknown';
        var did = env.did || null;
        var didShort = did && did.length > 30 ? (did.slice(0, 20) + '…' + did.slice(-6)) : (did || 'unknown');
        var objId = env.objId || null;
        var hostingUrl = item._instanceBaseUrl || window.location.origin;
        var hostingHost = hostingUrl.replace(/^https?:\/\//, '').replace(/\/$/, '') || 'unknown';
        var tags = (item.loadedMetaInfo && item.loadedMetaInfo.tags) || [];
        var sizeBytes = env.state && env.state.sizeBytes;
        var lines = [
            'Published by: @' + (item.handle || '?'),
            'Created: ' + created,
            'Object ID: ' + (objId || 'unknown'),
            'Author DID: ' + didShort,
            'Size: ' + this._formatBytes(sizeBytes),
            'Hosting: ' + hostingHost,
            'Tags: ' + (tags.length ? tags.join(', ') : 'none')
        ];
        return { text: lines.join('\n'), lines: lines, objId: objId, did: did, objIdLineIndex: 2, didLineIndex: 3 };
    },

    toggleVersionsExpanded: function toggleVersionsExpanded() {
        this.versionsExpanded = !this.versionsExpanded;
        this.renderRightPanel();
    },

    // Rebuilds the entire right panel from scratch on every selection/
    // star/comment/version change -- same "hand-construct fresh" idiom as
    // the sidebar's Categories/Instances blocks and _buildItemTile, chosen
    // over patching named morphs in place because so much of this content
    // (version rows, comment rows) varies in COUNT, not just text.
    renderRightPanel: function renderRightPanel() {
        var self = this;
        var panel = this.get('RightPanel');
        panel.submorphs.clone().invoke('remove');
        var item = this.selectedItem;
        var PAD = 18, W = 360 - 2 * PAD;

        function noDrag(m) { m.draggingEnabled = false; m.droppingEnabled = false; m.grabbingEnabled = false; }
        // Soft-edges pass: boxShadow isn't a real BuildSpec/applyStyle style
        // key, so it's written straight to the DOM -- same idiom as
        // _paintScopeTab's direct style writes elsewhere in this file. Fine
        // to call on a morph that was just constructed this same pass (not
        // yet added to the panel): renderContext()/shapeNode are built
        // lazily on first access (Rendering.js), not on world insertion, so
        // the node already exists.
        function softShadow(m) { m.renderContext().shapeNode.style.boxShadow = '0 1px 3px rgba(20,20,30,0.05)'; }
        function textRow(rect, text, style) {
            var t = new lively.morphic.Text(rect, text);
            t.applyStyle(Object.assign({ fill: null, borderWidth: 0, allowInput: false, selectable: false,
                fixedWidth: true, fixedHeight: true, clipMode: 'hidden', fontFamily: 'Helvetica' }, style));
            t.eventsAreIgnored = true;
            noDrag(t);
            return t;
        }

        if (!item) {
            panel.addMorph(textRow(lively.rect(PAD, 60, W, 60),
                'Select an item to see its details.',
                { fontSize: 10.5, textColor: Color.rgb(153,153,153), align: 'center' }));
            return;
        }

        var y = 16;
        function place(m, h) { m.setPosition(pt(PAD, y)); panel.addMorph(m); y += h; }

        // Soft-edges pass: name + meta block now live inside one rounded
        // white card (instead of bare text sitting straight on the panel's
        // own fill), matching the panel's own new rounded-card treatment
        // above -- gives the top of the right panel a clear, softly
        // separated "header" instead of text floating with no boundary.
        var CARD_PAD = 14, innerW = W - 2 * CARD_PAD;
        var meta = this.describeItemMeta(item);
        var lineCount = meta ? meta.text.split('\n').length : 1;
        // 18px/line, not the naive fontSize-derived guess -- live-measured
        // (getComputedStyle/scrollHeight) at ~17.6px/line for this 8.5pt
        // text, confirmed by a real clipped-last-line bug this replaced.
        var metaH = lineCount * 18 + 8;
        var nameH = 20, nameGap = 10;
        var metaY = CARD_PAD + nameH + nameGap; // card-local, used by the copy buttons below
        var cardH = CARD_PAD * 2 + nameH + nameGap + metaH;
        var headerCard = new lively.morphic.Box(lively.rect(0, 0, W, cardH));
        headerCard.applyStyle({ fill: Color.white, borderWidth: 1, borderColor: Color.rgb(238,238,240), borderRadius: 12 });
        noDrag(headerCard);
        softShadow(headerCard);
        headerCard.addMorph(textRow(lively.rect(CARD_PAD, CARD_PAD, innerW, nameH), item.name || '',
            { fontSize: 10.5, fontWeight: 'bold', textColor: Color.rgb(34,34,34) }));
        var metaMorph = textRow(lively.rect(CARD_PAD, metaY, innerW, metaH), meta ? meta.text : '',
            { fontSize: 8.5, textColor: Color.rgb(85,85,85) });
        headerCard.addMorph(metaMorph);

        // Copy-icon buttons for Object ID / Author DID, one per field --
        // a real Text morph rendering a Material Symbols glyph, styled and
        // wired exactly like ProfileCard.js's own copy-DID/copy-address
        // buttons (see that file's comment on why this is a plain Text
        // morph, not a lively.morphic.Button: Button's internal label Text
        // silently ignores a fontFamily change, so the icon glyph never
        // actually swaps to the icon font). addScript's handler references
        // only this.* (never a closure var), matching CLAUDE.md's
        // BuildSpec/addScript-closure-loss fix.
        //
        // Sizing/position note: the previous 26x28 box (copied from
        // ProfileCard's own button, sized for a wider line spacing) was
        // TALLER than this panel's 18px meta line spacing -- confirmed live
        // (chrome-devtools MCP, cropped/zoomed screenshot) that two
        // consecutive buttons on adjacent lines actually overlapped each
        // other by ~9px, which is what read as "clipped" (each button's own
        // border/fill visually cut into its neighbor). Fixed by shrinking
        // the box to fit inside one 18px line slot and measuring the real
        // line-end position (canvas measureText, same font as the meta
        // text) instead of pinning to the panel's far-right edge -- ProfileCard.js's fixed-offset "right after the value" approach doesn't
        // apply directly since these lines' own leading label text varies
        // in width per field.
        function measureTextWidth(text, font) {
            var ctx = measureTextWidth._ctx || (measureTextWidth._ctx = document.createElement('canvas').getContext('2d'));
            ctx.font = font;
            return ctx.measureText(text).width;
        }
        function makeCopyButton(lineText, valueToCopy, lineIndex, tooltip) {
            var lineW = measureTextWidth(lineText, "8.5pt Helvetica");
            var btnSize = 18;
            // Card-local coordinates now (button lives inside headerCard,
            // not directly on the panel) -- base offset is CARD_PAD, not PAD.
            var btnX = CARD_PAD + Math.ceil(lineW) + 6;
            var btnY = metaY + lineIndex * 18;
            var btn = new lively.morphic.Text(lively.rect(btnX, btnY, btnSize, btnSize), 'content_copy');
            // Softened further (was 240/234) and rounder (was 3) as part of
            // the right-panel soft-edges pass.
            btn.applyStyle({ fill: Color.rgb(244,244,246), borderColor: Color.rgb(236,236,238),
                borderRadius: 7, borderWidth: 1, fontFamily: "'Material Symbols Rounded'", fontSize: 8.5,
                textColor: Color.rgb(80,80,80), align: 'center',
                allowInput: false, selectable: false, clipMode: 'hidden', whiteSpaceHandling: 'pre', handStyle: 'pointer' });
            btn._copyText = valueToCopy;
            btn.addScript(function onMouseUp(evt) {
                var theText = this._copyText;
                var m = this;
                if (theText && navigator.clipboard) {
                    navigator.clipboard.writeText(theText).then(function() {
                        m.setTextString('check');
                        setTimeout(function() { m.setTextString('content_copy'); }, 1500);
                    });
                }
                evt.stop();
                return true;
            });
            noDrag(btn);
            headerCard.addMorph(btn);
            btn.renderContext().morphNode.title = tooltip;
        }
        if (meta && meta.objId) makeCopyButton(meta.lines[meta.objIdLineIndex], meta.objId, meta.objIdLineIndex, 'Copy Object ID');
        if (meta && meta.did) makeCopyButton(meta.lines[meta.didLineIndex], meta.did, meta.didLineIndex, 'Copy Author DID');
        place(headerCard, cardH + 14);

        // Description (state.comment) -- publish-time free-text summary, distinct
        // from the COMMENTS discussion thread below. Deliberately NOT folded into
        // describeItemMeta's `lines` array: that array's metaH sizing assumes one
        // non-wrapping visual line per entry, which a free-text description can't
        // guarantee (see CLAUDE.md's lineCount*N+padding clipping gotcha, already
        // hit once in this exact file). Reuses the COMMENTS section's own
        // already-proven technique for arbitrary-length user text below: a
        // char-count line estimate plus clipMode:'auto' as the undershoot-safe
        // fallback (scrolls instead of silently clipping).
        var descText = ((item.loadedMetaInfo && item.loadedMetaInfo.comment) || '').trim();
        if (descText) {
            var descPad = 14, descInnerW = W - 2 * descPad;
            var descEstLines = Math.max(1, Math.ceil(descText.length * 6.2 / descInnerW));
            var descBodyH = descEstLines * 18 + 4;
            var descCardH = descPad * 2 + descBodyH;
            var descCard = new lively.morphic.Box(lively.rect(0, 0, W, descCardH));
            descCard.applyStyle({ fill: Color.white, borderWidth: 1, borderColor: Color.rgb(238,238,240), borderRadius: 12 });
            noDrag(descCard);
            softShadow(descCard);
            var descMorph = textRow(lively.rect(descPad, descPad, descInnerW, descBodyH), descText,
                { fontSize: 9, textColor: Color.rgb(68,68,68) });
            descMorph.applyStyle({ clipMode: 'auto' });
            descCard.addMorph(descMorph);
            place(descCard, descCardH + 14);
        }

        // Version badge + (conditionally) expandable version list. Built
        // from item.partVersions -- {date, author, version(shortCid)} rows,
        // ascending -- exactly as loadPartVersions already produces; no
        // real per-version signer exists yet (inventory.md §1.4/§9), so
        // every row shows the owning handle, matching today's actual data.
        if (!item.partVersions) {
            place(textRow(lively.rect(0,0,W,18), 'Loading versions…',
                { fontSize: 9, textColor: Color.rgb(153,153,153) }), 24);
        } else {
            var versions = item.partVersions.length ? item.partVersions : null;
            var latest = versions ? versions[versions.length - 1] : null;
            var badgeText = versions ?
                ('v' + versions.length + ' · updated ' + new Date(latest.date).format('yyyy-mm-dd') + ' · ' + latest.author) :
                'No version history';

            var badge = new lively.morphic.Box(lively.rect(0, 0, W, 30));
            // Soft-edges pass: rounder (was 8) and a touch lighter border
            // (was 234,234,234), white fill for contrast against the
            // panel's own new off-white background, plus a faint shadow so
            // it reads as its own raised card rather than a flat strip.
            badge.applyStyle({ fill: Color.white, borderWidth: 1, borderColor: Color.rgb(238,238,240), borderRadius: 14 });
            noDrag(badge);
            softShadow(badge);
            // Icon boxes grown past their glyphs' own 16x16 model extent --
            // a fontSize:12/14 Material Symbols glyph renders taller than
            // 16px (fontSize is points, not px) and clips under
            // clipMode:'hidden' otherwise; same gotcha as the sidebar
            // category icons above.
            badge.addMorph(textRow(lively.rect(8,4,22,22), 'history',
                { fontFamily: "'Material Symbols Rounded'", fontSize: 12, textColor: Color.rgb(136,136,136) }));
            badge.addMorph(textRow(lively.rect(34,8,W-62,14), badgeText,
                { fontSize: 8.5, textColor: Color.rgb(51,51,51) }));
            badge.addMorph(textRow(lively.rect(W-32,2,24,26), this.versionsExpanded ? 'expand_less' : 'expand_more',
                { fontFamily: "'Material Symbols Rounded'", fontSize: 14, textColor: Color.rgb(136,136,136) }));
            if (versions) badge.onMouseUp = function() { self.toggleVersionsExpanded(); return true; };
            place(badge, 40);

            if (this.versionsExpanded && versions) {
                var listBox = new lively.morphic.Box(lively.rect(0, 0, W, versions.length * 22));
                listBox.applyStyle({ fill: Color.rgb(252,252,253), borderWidth: 1, borderColor: Color.rgb(242,242,244), borderRadius: 12 });
                noDrag(listBox);
                versions.slice().reverse().forEach(function(v, i) {
                    listBox.addMorph(textRow(lively.rect(8, i * 22 + 3, W - 16, 16),
                        'v' + (versions.length - i) + ' · ' + new Date(v.date).format('yyyy-mm-dd') + ' · ' + v.version + ' · ' + v.author,
                        { fontSize: 7.5, textColor: Color.rgb(85,85,85) }));
                });
                place(listBox, versions.length * 22 + 10);
            }
        }

        // Star button -- radius bumped to a full pill (was 6, on a 28px-
        // tall box) as part of the soft-edges pass.
        var info = this.selectedItemStarInfo;
        var starCount = info ? info.count : (item.starCount || 0);
        var starred = !!(info && info.mine);
        var starBtn = new lively.morphic.Box(lively.rect(0, 0, 78, 28));
        starBtn.applyStyle({ fill: starred ? Color.rgbHex('#D45472') : Color.white,
            borderWidth: 1, borderColor: starred ? Color.rgbHex('#D45472') : Color.rgb(238,238,240), borderRadius: 14 });
        noDrag(starBtn);
        softShadow(starBtn);
        // 22x24, not 16x16 -- a fontSize:13 glyph renders ~17x21px tall
        // (fontSize is points, not px), clipping in a same-size box under
        // clipMode:'hidden'; same gotcha as the sidebar category icons.
        starBtn.addMorph(textRow(lively.rect(8,2,22,24), starred ? 'star' : 'star_border',
            { fontFamily: "'Material Symbols Rounded'", fontSize: 13, textColor: starred ? Color.white : Color.rgb(51,51,51) }));
        starBtn.addMorph(textRow(lively.rect(32,8,38,14), String(starCount),
            { fontSize: 9, textColor: starred ? Color.white : Color.rgb(51,51,51) }));
        starBtn.onMouseUp = function() { self.toggleStarOnSelectedItem(); return true; };
        place(starBtn, 40);

        // Open Item / View Source / Inspect -- radius bumped (was 6), lighter
        // border (was 234,234,234), plus the same faint card shadow as the
        // version badge/star button above.
        var buttonsRow = new lively.morphic.Box(lively.rect(0, 0, W, 26));
        buttonsRow.applyStyle({ fill: null, borderWidth: 0 });
        noDrag(buttonsRow);
        var btnW = (W - 12) / 3;
        [['Open Item', function() { self.openSelectedItem(); }],
         ['View Source', function() { self.viewSourceOfSelectedItem(); }],
         ['Inspect', function() { self.openInspectorMenu(); }]].forEach(function(pair, i) {
            var b = new lively.morphic.Box(lively.rect(i * (btnW + 6), 0, btnW, 26));
            b.applyStyle({ fill: Color.white, borderWidth: 1, borderColor: Color.rgb(238,238,240), borderRadius: 10 });
            noDrag(b);
            softShadow(b);
            b.addMorph(textRow(lively.rect(0,5,btnW,16), pair[0], { fontSize: 8, textColor: Color.rgb(51,51,51), align: 'center' }));
            b.onMouseUp = function() { pair[1](); return true; };
            if (pair[0] === 'Inspect') self._inspectButtonMorph = b;
            buttonsRow.addMorph(b);
        });
        place(buttonsRow, 44);

        // Comments
        place(textRow(lively.rect(0,4,W,16), 'COMMENTS', { fontSize: 7.5, textColor: Color.rgb(153,153,153) }), 26);

        var comments = (this.selectedItemComments || []).slice().reverse();
        if (!comments.length) {
            place(textRow(lively.rect(0,0,W,16), 'No comments yet.', { fontSize: 9, textColor: Color.rgb(153,153,153) }), 22);
        } else {
            comments.forEach(function(c) {
                // Wrapped-line-count estimate, not a live measurement (see
                // inventory.md Phase D plan's own flagged risk for this) --
                // clipMode stays 'auto' below rather than 'hidden' so an
                // undershoot scrolls instead of silently clipping.
                var estLines = Math.max(1, Math.ceil((c.body || '').length * 6.2 / (W - 34)));
                var bodyH = estLines * 18 + 4;
                var rowH = 16 + bodyH + 8;
                var row = new lively.morphic.Box(lively.rect(0, 0, W, rowH));
                row.applyStyle({ fill: null, borderWidth: 0 });
                noDrag(row);
                var avatar = new lively.morphic.Box(lively.rect(0, 2, 20, 20));
                avatar.applyStyle({ fill: Color.rgbHex(self._instanceColor(c.handle || c.did || '')), borderWidth: 0, borderRadius: 10 });
                noDrag(avatar);
                row.addMorph(avatar);
                row.addMorph(textRow(lively.rect(28,0,W-28,14),
                    (c.handle ? '@' + c.handle : '@?') + ' · ' + (c.created_at ? new Date(c.created_at).format('yyyy-mm-dd') : ''),
                    { fontSize: 7.5, textColor: Color.rgb(120,120,120) }));
                var body = textRow(lively.rect(28,16,W-28,bodyH), c.body || '', { fontSize: 9, textColor: Color.rgb(26,26,27) });
                body.applyStyle({ clipMode: 'auto' });
                row.addMorph(body);
                // Extra breathing room between comments (was +4) -- part of
                // the right-panel soft-edges pass.
                place(row, rowH + 10);
            });
        }

        // Comment input row -- a morphic Text#beInputLine() input (native
        // framework mechanism, not a raw DOM <input>), matching this file's
        // existing searchText precedent rather than a native-DOM-mount.
        // Both the input and Post button rounded further (were 6) as part
        // of the soft-edges pass -- Post is now a full pill on its 24px
        // height.
        var inputRow = new lively.morphic.Box(lively.rect(0, 0, W, 32));
        inputRow.applyStyle({ fill: null, borderWidth: 0 });
        noDrag(inputRow);
        var input = new lively.morphic.Text(lively.rect(0, 4, W - 66, 24), '');
        input.applyStyle({ fixedWidth: true, fixedHeight: true, clipMode: 'hidden', allowInput: true, fontSize: 8.5,
            borderWidth: 1, borderColor: Color.rgb(238,238,240), borderRadius: 12, fill: Color.white });
        inputRow.addMorph(input);
        var postBtn = new lively.morphic.Box(lively.rect(W - 58, 4, 58, 24));
        postBtn.applyStyle({ fill: Color.rgbHex('#e8497e'), borderWidth: 0, borderRadius: 12 });
        noDrag(postBtn);
        postBtn.addMorph(textRow(lively.rect(0,5,58,14), 'Post', { fontSize: 8.5, textColor: Color.white, align: 'center' }));
        postBtn.onMouseUp = function() {
            var text = input.textString;
            input.setTextString('');
            self.postCommentOnSelectedItem(text);
            return true;
        };
        inputRow.addMorph(postBtn);
        place(inputRow, 40);
        input.beInputLine({ fixedWidth: true });
    },

    // ─── inspect ─────────────────────────────────────────────────────────

    // lively.morphic.tools.ItemInspector is a standalone inspector built for
    // Inventory items specifically -- it just needs the item's raw JSON,
    // fetched via the same _fetchFullEnvelope every other item action
    // already shares. It replaces an earlier approach that reused the
    // classic WebDAV debugging tool PartInspector (PartsBin/Debugging/
    // PartInspector.json) via a loadFromJSON(json, label, tabName) entry
    // point bolted onto it: that part's own PartsBinCategoryChooser/
    // PartsBinPartItemChooser dropdowns only ever worked against a real
    // WebDAV PartsSpace -- an Inventory item has no such path, its
    // partsSpaceName is either '*public*' or another user's identity space
    // -- so those dropdowns (and the rest of PartInspector's WebDAV-chooser
    // UI) were always dead weight here. ItemInspector carries over only the
    // generic JSON/registry-graph logic (Overview's morph list + reference
    // viewer, JSON, Serialization Info, Object Graph) and drops the rest.
    // See inventory.md §12 for the full writeup.
    //
    // A single "Inspect" button (openInspectorMenu, below) fans out to this
    // for all three of ItemInspector's non-Overview tabs -- JSON,
    // Serialization Info, Object Graph -- rather than one physical button
    // per tab, which measured live (chrome-devtools MCP) to overflow the
    // right panel's fixed-width button row (originally ItemInfoPanel's
    // MetaContainer column, before the Phase D right-panel rewrite).
    openPartInspectorForSelection: function openPartInspectorForSelection(tabName) {
        tabName = tabName || 'Overview';
        var item = this.selectedItem;
        if (!item) { $world.inform('No item selected.'); return; }
        var self = this;
        this.setStatus('Loading ' + tabName + ' for ' + item.name + '…');
        this._fetchFullEnvelope(item, function(err, envelope) {
            if (err) { self.setStatus('Failed to load item: ' + (err.message || err), true); return; }
            // record.payload is ciphertext for private/shared items -- feeding
            // that into ItemInspector's JSON.parse would just fail or produce
            // garbage. Scoped to public items only for now (see inventory.md
            // §12's open question); private/shared is a deliberate follow-up,
            // not an oversight.
            if (envelope.visibility && envelope.visibility !== 'public') {
                self.setStatus('Inspector view only supports public items right now.', true);
                return;
            }
            self._resolvePayloadText(envelope, item.handle, item._instanceBaseUrl, function(errJson, json) {
                if (errJson) { self.setStatus('Failed to load item: ' + (errJson.message || errJson), true); return; }
                var indicatorClose, indicator;
                lively.lang.fun.composeAsync(
                    function(n) { Global.require('lively.morphic.tools.LoadingIndicator').toRun(function() { n(); }); },
                    function(n) {
                        // LoadingIndicator.open calls its callback
                        // synchronously, before returning -- assigning
                        // `indicator` from n() (itself called inside that
                        // callback) races the assignment below against
                        // whatever n() resumes synchronously. Call n() after
                        // the assignment completes, not from inside the
                        // callback, so a later step reading `indicator`
                        // (e.g. indicator.bringToFront()) never sees it
                        // still undefined. Confirmed live: reusing an
                        // already-open ItemInspector window (a faster path
                        // than first-time creation) was enough to flip this
                        // race and throw "Cannot read properties of
                        // undefined (reading 'bringToFront')".
                        indicator = lively.morphic.tools.LoadingIndicator.open('loading...', function(close) { indicatorClose = close; });
                        n();
                    },
                    function(n) { Global.require('lively.morphic.tools.ItemInspector').toRun(function() { n(); }); },
                    function(n) {
                        lively.morphic.tools.ItemInspector.open(item.name, json, tabName);
                        indicator.bringToFront();
                        n();
                    }
                )(function(err3) {
                    indicatorClose && indicatorClose();
                    if (err3) { self.setStatus('Failed to open inspector: ' + (err3.message || err3), true); return; }
                    self.setStatus('Opened ' + tabName + ' for "' + item.name + '"');
                });
            });
        });
    },

    // Popup menu behind the single "Inspect" button -- keeps the right
    // panel's button row at its existing 3-button width (Open Item / View
    // Source / Inspect) instead of growing to 5 buttons, which measured
    // live to overflow the fixed column width (confirmed via chrome-devtools
    // MCP before choosing this design over more buttons).
    openInspectorMenu: function openInspectorMenu() {
        var item = this.selectedItem;
        if (!item) { $world.inform('No item selected.'); return; }
        var btn = this._inspectButtonMorph;
        var pos = btn ? btn.worldPoint(lively.pt(0, btn.getExtent().y)) : $world.visibleBounds().center();
        var self = this;
        var items = [
            ['JSON', function() { self.openPartInspectorForSelection('JSON'); }],
            ['Serialization Info', function() { self.openPartInspectorForSelection('Serialization Info'); }],
            ['Object Graph', function() { self.openPartInspectorForSelection('Object Graph'); }]
        ];
        lively.morphic.Menu.openAt(pos, 'Inspect "' + item.name + '"', items);
    },

    // ─── opening an item ─────────────────────────────────────────────────

    openSelectedItem: function openSelectedItem() {
        var item = this.selectedItem;
        if (!item) { $world.alert('No item selected'); return; }
        var self = this;
        this.setStatus('Opening ' + item.name + '…');
        this._fetchFullEnvelope(item, function(err, envelope) {
            if (err) { self.setStatus('Failed to load item: ' + (err.message || err), true); return; }
            self._openEnvelope(envelope, item.handle, item._instanceBaseUrl);
        });
    },

    // Extracts and displays the item's embedded addScript/BuildSpec source
    // WITHOUT deserializing/evaling it (lively.persistence.Serializer
    // .scriptSourcesIn walks the raw parsed JSON only) -- lets a part's code
    // be read before it's ever run. Reuses _fetchFullEnvelope, which is a
    // no-op if the thumbnail fetch already pulled the full envelope in.
    viewSourceOfSelectedItem: function viewSourceOfSelectedItem() {
        var item = this.selectedItem;
        if (!item) { $world.alert('No item selected'); return; }
        var self = this;
        this.setStatus('Loading source for ' + item.name + '…');
        this._fetchFullEnvelope(item, function(err, envelope) {
            if (err) { self.setStatus('Failed to load source: ' + (err.message || err), true); return; }
            self._resolvePayloadText(envelope, item.handle, item._instanceBaseUrl, function(err2, json) {
                if (err2) { self.setStatus('Failed to load source: ' + (err2.message || err2), true); return; }
                lively.require('lively.morphic.tools.ItemSourceViewer').toRun(function() {
                    lively.morphic.tools.ItemSourceViewer.open(item.name, json);
                    self.setStatus('Opened source for "' + item.name + '"');
                });
            });
        });
    },

    // Pre-loads the item's own class module via lively.require(...) BEFORE
    // deserializing, then polls each named module's actual global namespace
    // value directly rather than trusting lively.module(name).isLoaded() or
    // the toRun callback alone — both were confirmed live (building the old
    // PublicPartsBrowser.js) to sometimes fire/report "loaded" before a
    // class-shaped module has actually finished loading, which produced a
    // broken non-morph "part" (later TypeError on part.comeForward).
    // Resolves record.payload when it's a blob-store reference object
    // ({blobCid, size, mime} -- added so a part's payload no longer has to
    // fit inline in the Postgres row, see PartSerializer.js's size-threshold
    // branch) into the real payload bytes as a string, fetched from the
    // content-addressed blob store. Passes the payload through unchanged
    // (coerced to a string, same as every call site already did before this
    // existed) when it's not a blob reference -- small/legacy items need no
    // extra round trip. No CID re-check here: BlobStore.put() already
    // verifies SHA-256(bytes) === cid at write time (FileCrypto.js's
    // identical precedent for file envelopes), and every one of these call
    // sites already skipped CID verification on the inline case too.
    _resolvePayloadText: function _resolvePayloadText(envelope, handle, baseUrl, thenDo) {
        var payload = envelope.record && envelope.record.payload;
        if (!payload || typeof payload !== 'object' || typeof payload.blobCid !== 'string') {
            thenDo(null, typeof payload === 'string' ? payload : JSON.stringify(payload));
            return;
        }
        var base = baseUrl || window.location.origin;
        var url = base + '/@' + encodeURIComponent(handle || '_') + '/blobs/' + encodeURIComponent(payload.blobCid);
        var xhr = new XMLHttpRequest();
        xhr.open('GET', url, true);
        // Same cross-origin credential rule as _fetchJson/loadPartVersions
        // elsewhere in this file: a wildcard Access-Control-Allow-Origin
        // response can't be combined with a credentialed request.
        var isCrossOrigin = base !== window.location.origin;
        xhr.withCredentials = !isCrossOrigin;
        xhr.onload = function() {
            if (xhr.status !== 200) { thenDo(new Error('Failed to fetch blob ' + payload.blobCid + ' (HTTP ' + xhr.status + ')')); return; }
            thenDo(null, xhr.responseText);
        };
        xhr.onerror = function() { thenDo(new Error('Failed to fetch blob ' + payload.blobCid)); };
        xhr.send();
    },

    _openEnvelope: function _openEnvelope(envelope, handle, baseUrl) {
        var self = this;
        var state = envelope.state || {};
        var partName = state.partName || envelope.objId;

        this._resolvePayloadText(envelope, handle, baseUrl, function(err0, json) {
            if (err0) { self.setStatus('Failed to load item: ' + (err0.message || err0), true); return; }

            var modules;
            try { modules = lively.persistence.Serializer.sourceModulesIn(JSON.parse(json)); }
            catch (e) { modules = []; }

            lively.require(modules).toRun(function() {
                self._waitForModules(modules, 0, function(err) {
                    if (err) { self.setStatus('Failed to load item: ' + err.message, true); return; }

                    var item = new lively.identity.IdentityPartItem(partName, '*public*');
                    item.envelope = envelope;
                    item.handle = handle;

                    var metaInfo = new lively.PartsBin.PartsBinMetaInfo();
                    metaInfo.partName = partName;
                    metaInfo.comment = state.comment || '';
                    metaInfo.tags = state.tags || [];
                    metaInfo.requiredModules = state.requiredModules || [];
                    metaInfo.migrationLevel = state.migrationLevel || 9;
                    metaInfo.partsSpaceName = '*public*';
                    metaInfo.lastModifiedDate = envelope.created ? new Date(envelope.created) : new Date();
                    item.loadedMetaInfo = metaInfo;

                    item.loadPart(false, false, null, function(err2, part) {
                        if (err2) { self.setStatus('Failed to load item: ' + (err2.message || err2), true); return; }
                        if (!part || typeof part.openInWorld !== 'function') {
                            self.setStatus('Failed to load item: deserialized object is not a morph', true);
                            return;
                        }
                        // Stash this part's provenance so a later "Publish to
                        // Inventory" on the same live morph continues the
                        // same objId's version chain (prevCid) instead of
                        // minting a new genesis object -- see
                        // PublishToInventoryDialog.js's setTarget and
                        // PartsBin.js's _publishToInventoryImpl.
                        // doNotSerialize is required, not optional: a plain
                        // own property here gets walked into the very next
                        // publish's serialized JSON by DoNotSerializePlugin,
                        // baking this envelope into the next version's own
                        // payload.
                        part._inventoryEnvelope = envelope;
                        part.doNotSerialize = (part.doNotSerialize || []).concat('_inventoryEnvelope');
                        var world = self.world();
                        part.openInWorld(world.visibleBounds().center().subPt(part.getExtent().scaleBy(0.5)));
                        if (typeof part.comeForward === 'function') part.comeForward();
                        self.setStatus('Opened "' + partName + '"');
                    });
                });
            });
        });
    },

    _waitForModules: function _waitForModules(modules, elapsedMs, cb) {
        var self = this;
        function resolveGlobal(name) {
            var path = name.replace(/^Global\./, '');
            var obj = window;
            var parts = path.split('.');
            for (var i = 0; i < parts.length && obj; i++) obj = obj[parts[i]];
            return obj;
        }
        var pending = modules.filter(function(name) { return !resolveGlobal(name); });
        if (!pending.length) { cb(null); return; }
        if (elapsedMs >= 4000) { cb(new Error('module(s) never finished loading: ' + pending.join(', '))); return; }
        setTimeout(function() { self._waitForModules(modules, elapsedMs + 100, cb); }, 100);
    },

    // ─── collapsible panel toggle (kept simple relative to the classic
    // browser's draggable MoreDivider — this panel is always shown, since
    // an item's info is the primary point of this browser rather than an
    // optional "more" extra) ──────────────────────────────────────────────

    reset: function reset() {}
    }],
    titleBar: "Public Inventory",
    withLayers: "[GrabbingLayer]"
});

// Assign onto the module's own namespace object rather than replacing it —
// module(...) already sets lively.identity.Inventory to point at internal
// bookkeeping BuildSpec's createMorph() reads via
// lively.module(sourceModule).isLoaded(); clobbering it with a plain object
// broke createMorph with "sourceMod.isLoaded is not a function" (same
// gotcha the old PublicPartsBrowser.js already documented).
//
// Wires up the dividers and calls onLoad() explicitly on the named content
// box after creation, rather than relying on Window's own `targetMorph`
// convention the classic PartsBin.js BuildSpec uses (this.targetMorph.onLoad()
// inside onFromBuildSpecCreated) — that convention is populated by the real
// `new lively.morphic.Window(targetMorph, ...)` constructor path, which
// isn't what created this BuildSpec-authored window, so targetMorph isn't
// guaranteed to resolve correctly here. win.get('InventoryBrowser') is the
// same "look the content box up by name" approach the old
// PublicPartsBrowser.js's own .open() already used successfully.
lively.identity.Inventory.open = function(optPos) {
    if ($world.inventoryBrowser) $world.inventoryBrowser.remove();
    var win = lively.BuildSpec('lively.identity.Inventory').createMorph();
    win.openInWorld(optPos || $world.visibleBounds().center().subPt(lively.pt(730, 380)));
    win.comeForward();
    $world.inventoryBrowser = win;
    var browser = win.get('InventoryBrowser');
    win.get('LeftRightDivider').scalingLeft = [win.get('LeftSideContainer')];
    win.get('LeftRightDivider').scalingRight = [win.get('MainContainer')];
    win.get('LeftRightDivider').fixed = [];
    win.get('RightDivider').scalingLeft = [win.get('MainContainer')];
    win.get('RightDivider').scalingRight = [win.get('RightPanel')];
    win.get('RightDivider').fixed = [];
    browser.onLoad();
    return win;
};

}); // end module('lively.identity.Inventory')
