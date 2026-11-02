/**
 * lively.morphic.tools.ItemInspector
 *
 * Standalone, read-only inspector for an Inventory item's raw serialized
 * JSON -- Overview (morph list + reference-path viewer), JSON, Serialization
 * Info, and Object Graph tabs. Decoupled from the classic
 * `PartsBin/Debugging/PartInspector.json` part: that part's
 * PartsBinURLChooser/PartsBinCategoryChooser/PartsBinPartItemChooser +
 * Load-button UI (and its ObjectEditor scripts/connections sub-widget) only
 * ever made sense for real classic WebDAV paths and are dropped here --
 * Inventory items have no such path. The underlying JSON/registry-graph
 * logic (updateJSON/updateMorphList/showRefs/refreshJSONView/
 * refreshSerializationInfoView/refreshObjectGraphView) is generic and is
 * ported over unchanged. See inventory.md for the fuller writeup.
 *
 * Shared by Inventory.js's "Inspect" menu (openPartInspectorForSelection).
 * The classic PartInspector.json part and the classic PartsBin browser's own
 * inspect flow are untouched -- this is purely additive.
 */
module('lively.morphic.tools.ItemInspector')
  .requires('lively.persistence.BuildSpec', 'lively.persistence.Serializer', 'lively.persistence.Debugging')
  .toRun(function () {

    lively.morphic.tools = lively.morphic.tools || {};

    lively.BuildSpec('lively.morphic.tools.ItemInspector', {
        _Extent: lively.pt(760, 560),
        _Position: lively.pt(160, 90),
        _StyleClassNames: ["Morph", "Window"],
        className: "lively.morphic.Window",
        contentOffset: lively.pt(4, 22),
        draggingEnabled: true,
        layout: { adjustForNewBounds: true },
        minExtent: lively.pt(480, 360),
        name: "ItemInspector",
        sourceModule: "lively.morphic.tools.ItemInspector",
        titleBar: "Item Inspector",
        submorphs: [{
            _Extent: lively.pt(752, 534),
            _Position: lively.pt(4, 22),
            _StyleClassNames: ["Morph", "Box"],
            className: "lively.morphic.Box",
            name: "ItemInspectorBody",
            layout: { adjustForNewBounds: true, resizeHeight: true, resizeWidth: true },

            // ── internal state ──────────────────────────────────────────
            itemJSO: null,
            itemJSOArray: [],
            doNotSerialize: ['itemJSO', 'itemJSOArray', 'itemSerializer', '_tabContainer'],

            // Not declared as a BuildSpec submorph -- see TabContainer note
            // below. TabContainer gets built here, by hand, in onLoad.
            submorphs: [],

            // ── lifecycle ────────────────────────────────────────────────
            // onLoad is not auto-invoked by createMorph() for a BuildSpec
            // window -- the caller (ItemInspector.open, below) calls it
            // explicitly right after creating/opening the window, same as
            // Inventory.js's own open() does for its browser window.
            onLoad: function onLoad() {
                // TabContainer's real initialize($super, optTabBarStrategy)
                // treats a truthy first arg as a tab-bar strategy object and
                // calls strategy.applyTo(this) on it. BuildSpec.createMorph
                // would instantiate it as `new klass(buildSpecWrapper)` --
                // the wrapper isn't a strategy and has no applyTo, so that
                // would throw; and even if it didn't, BuildSpec immediately
                // resets submorphs=[] after construction, wiping out the
                // TabBar the real constructor just built. So: build this one
                // via its own documented constructor usage (TabMorphs.js's
                // own example()) instead of declaring it in the spec tree.
                var tc = new lively.morphic.TabContainer();
                // addTabLabeled builds each new TabPane from
                // getTabPaneExtent() (TabMorphs.js:306), a separate field
                // from the container's own _Extent that isn't kept in sync
                // by a plain setExtent() call -- left at its 600x400
                // construction-time default, a newly built pane (and
                // anything sized from pane.getExtent() synchronously at
                // construction time, like Overview's MorphList/
                // MorphReferences below) ends up the wrong size. Set it
                // explicitly before adding any tabs.
                var tabBarH = tc.getTabBar().getDefaultHeight();
                tc.setTabPaneExtent(lively.pt(this.getExtent().x, this.getExtent().y - tabBarH));
                tc.setPosition(lively.pt(0, 0));
                tc.setExtent(this.getExtent());
                this.addMorph(tc);
                this._tabContainer = tc;

                var overview = tc.addTabLabeled('Overview');
                this._buildOverviewPane(overview.getPane());
                var jsonTab = tc.addTabLabeled('JSON');
                this._buildJSONPane(jsonTab.getPane());
                var infoTab = tc.addTabLabeled('Serialization Info');
                this._buildSerializationInfoPane(infoTab.getPane());
                var graphTab = tc.addTabLabeled('Object Graph');
                this._buildObjectGraphPane(graphTab.getPane());
                tc.activateTab(overview);
            },

            // ── Overview tab construction ───────────────────────────────
            _buildOverviewPane: function _buildOverviewPane(pane) {
                var paneExtent = pane.getExtent();
                var listH = Math.round(paneExtent.y * 0.4);
                var list = lively.BuildSpec('lively.morphic.List', {
                    className: "lively.morphic.List",
                    sourceModule: "lively.morphic.Lists",
                    name: "MorphList",
                    _Position: lively.pt(0, 0),
                    _Extent: lively.pt(paneExtent.x, listH)
                }).createMorph();
                pane.addMorph(list);

                var refs = lively.BuildSpec('lively.morphic.CodeEditor', {
                    className: "lively.morphic.CodeEditor",
                    sourceModule: "lively.ide.CodeEditor",
                    name: "MorphReferences",
                    _TextMode: "text",
                    _Theme: "chrome",
                    allowInput: false,
                    _Position: lively.pt(0, listH + 4),
                    _Extent: lively.pt(paneExtent.x, paneExtent.y - listH - 4)
                }).createMorph();
                pane.addMorph(refs);

                var body = this;
                lively.bindings.connect(list, 'selection', body, 'showRefs');
            },

            // ── JSON tab construction ───────────────────────────────────
            _buildJSONPane: function _buildJSONPane(pane) {
                var ed = lively.BuildSpec('lively.morphic.CodeEditor', {
                    className: "lively.morphic.CodeEditor",
                    sourceModule: "lively.ide.CodeEditor",
                    name: "JSONEditor",
                    _TextMode: "json",
                    _Theme: "chrome",
                    allowInput: false,
                    _Position: lively.pt(0, 0),
                    _Extent: pane.getExtent()
                }).createMorph();
                pane.addMorph(ed);
                var body = this;
                // Tab.activate() (TabMorphs.js) calls getPane().onActivate()
                // on every real click, including a later click back onto a
                // tab that was only pre-populated once by loadFromJSON's own
                // initial refresh -- wire each pane's onActivate (a no-op
                // hook by default) to its refresh method so a manual tab
                // switch always shows current data, not just the tab that
                // happened to be requested when loadFromJSON last ran.
                pane.onActivate = function () { body.refreshJSONView(); };
            },

            // ── Serialization Info tab construction ─────────────────────
            _buildSerializationInfoPane: function _buildSerializationInfoPane(pane) {
                var ed = lively.BuildSpec('lively.morphic.CodeEditor', {
                    className: "lively.morphic.CodeEditor",
                    sourceModule: "lively.ide.CodeEditor",
                    name: "SerializationInfoEditor",
                    _TextMode: "text",
                    _Theme: "chrome",
                    allowInput: false,
                    _Position: lively.pt(0, 0),
                    _Extent: pane.getExtent()
                }).createMorph();
                pane.addMorph(ed);
                var body = this;
                pane.onActivate = function () { body.refreshSerializationInfoView(); };
            },

            // ── Object Graph tab construction ───────────────────────────
            // Deliberately empty -- the apps.Graphviz.Display embed is
            // expensive and is built lazily on first activation, matching
            // the original PartInspector's own "build only if not already
            // present" guard in _renderObjectGraph below.
            _buildObjectGraphPane: function _buildObjectGraphPane(pane) {
                var body = this;
                pane.onActivate = function () { body.refreshObjectGraphView(); };
            },

            // ── public entry point ──────────────────────────────────────
            loadFromJSON: function loadFromJSON(json, label, tabName) {
                this.updateJSON(json);
                var win = this.getWindow && this.getWindow();
                if (win && label) win.setTitle('Inspector: ' + label);
                tabName = tabName || 'Overview';
                var tab = this._tabContainer && this._tabContainer.getTabByName(tabName);
                if (tab) this._tabContainer.activateTab(tab);
                if (tabName === 'JSON') this.refreshJSONView();
                else if (tabName === 'Serialization Info') this.refreshSerializationInfoView();
                else if (tabName === 'Object Graph') this.refreshObjectGraphView();
                // Overview needs no extra refresh -- updateJSON already
                // called updateMorphList() below.
            },

            // ── Overview tab logic (ported from PartInspector.json, generic) ──
            updateJSON: function updateJSON(json) {
                this.itemJSO = JSON.parse(json);
                // registry is a plain object with contiguous numeric-string
                // keys, not a real array -- Array.from needs an explicit
                // .length to treat it as array-like (confirmed live: without
                // this, Array.from returns []). -1 drops a non-numeric own
                // property the parsed registry object itself carries.
                this.itemJSO.registry.length = Object.getOwnPropertyNames(this.itemJSO.registry).length - 1;
                this.itemJSOArray = Array.from(this.itemJSO.registry);
                this.updateMorphList();
                lively.bindings.signal(this, 'itemLoaded', this.itemJSO);
            },

            updateMorphList: function updateMorphList() {
                if (!this.itemJSOArray) return;
                var allMorphs = this.itemJSOArray.map(function (ea) {
                    var klass = ea && ea.__LivelyClassName__,
                        moduleName = ea && ea.__SourceModuleName__;
                    if (moduleName && !module(moduleName).isLoaded())
                        module(moduleName).load(true);
                    if (!klass || !lively.Class.forName(klass) ||
                        !lively.Class.forName(klass).isSubclassOf(lively.morphic.Morph))
                        return null;
                    return ea;
                });
                this.get('MorphList').setList(allMorphs.reduce(function (lst, m, idx) {
                    if (m != null) {
                        lst.push({
                            isitem: true,
                            string: m.name || Strings.format('<%s#%s>', m.__LivelyClassName__, String(m.id).truncate(8)),
                            jsoIdx: idx
                        });
                    }
                    return lst;
                }, []));
            },

            showRefs: function showRefs(item) {
                var editor = this.get('MorphReferences');
                editor.scrollToTop();
                if (!item) { editor.setTextString(''); return; }
                if (item.jsoIdx === 0) { editor.setTextString('this'); return; }
                this.itemSerializer = lively.persistence.Serializer.createObjectGraphLinearizer();
                this.itemSerializer.registry = this.itemSerializer.createRealRegistry(this.itemJSO.registry);
                var path = this.itemSerializer.findIdReferencePathFromToId(0, item.jsoIdx, { showClassNames: false, showPath: false });
                if (!path) { editor.setTextString('(no reference path found from root)'); return; }
                path.push(item.jsoIdx);
                editor.setTextString(this.printPath(path));
            },

            printPath: function printPath(path) {
                var result = 'this';
                for (var i = 0; i < path.length - 1; i++) {
                    var currId = path[i], nextId = path[i + 1];
                    var ref = this.itemSerializer.referencesOfId(currId, true).detect(
                        function (ea) { return ea.id == nextId; });
                    result += '.' + (ref ? ref.key : '?');
                }
                return result;
            },

            // ── JSON tab logic ───────────────────────────────────────────
            refreshJSONView: function refreshJSONView() {
                if (!this.itemJSO) return;
                var ed = this.get('JSONEditor');
                if (!ed) return;
                var pane = ed.owner;
                if (pane) ed.setExtent(pane.getExtent());
                ed.setTextString(JSON.stringify(this.itemJSO, null, 4));
                if (ed.withAceDo) ed.withAceDo(function (editor) { editor.resize(true); });
            },

            // ── Serialization Info tab logic ────────────────────────────
            refreshSerializationInfoView: function refreshSerializationInfoView() {
                if (!this.itemJSO) return;
                var ed = this.get('SerializationInfoEditor');
                if (!ed) return;
                var pane = ed.owner;
                var printer = lively.persistence.Debugging.Helper.listObjects(this.itemJSO);
                if (pane) ed.setExtent(pane.getExtent());
                ed.setTextString(printer.toString());
                if (ed.withAceDo) ed.withAceDo(function (editor) { editor.resize(true); });
            },

            // ── Object Graph tab logic ──────────────────────────────────
            refreshObjectGraphView: function refreshObjectGraphView() {
                if (!this.itemJSO) return;
                var self = this;
                var ready = (window.apps && apps.Graphviz && apps.Graphviz.Display) ?
                    Promise.resolve() : module("apps.Graphviz").load(true);
                ready.then(function () { self._renderObjectGraph(); });
            },

            _renderObjectGraph: function _renderObjectGraph() {
                var tab = this._tabContainer && this._tabContainer.getTabByName('Object Graph');
                var pane = tab && tab.getPane();
                if (!pane) return;
                var display = this.get('ItemInspectorGraphDisplay');
                if (!display) {
                    display = lively.BuildSpec('apps.Graphviz.Display').createMorph();
                    display.setName('ItemInspectorGraphDisplay');
                    pane.addMorph(display);
                }
                display.setExtent(pane.getExtent());
                var size = Object.keys(this.itemJSO.registry).length;
                lively.persistence.Debugging.svgGraphForSerializedObjectGraph(this.itemJSO, {
                    inverse: true,
                    asWindow: false,
                    display: display,
                    graphSettings: size < 2000 ? [] : ["layout=sfdp;", "overlap=prism;", "K=3;"],
                    convertToMorphs: size < 1000,
                    labelWithReferencePaths: size < 5000
                });
            }
        }]
    });

    // Module-level opener, mirrors lively.morphic.tools.ItemSourceViewer.open.
    // Singleton reuse (not fresh-every-time): the Object Graph tab's
    // apps.Graphviz.Display embed is expensive to build and
    // _renderObjectGraph already guards "build only if not already
    // present" -- reusing the window means a repeat Inspect click doesn't
    // re-pay that cost. The inspector's own state is just "whatever JSON
    // was last loaded," which loadFromJSON fully overwrites every call, so
    // reuse carries no staleness risk.
    lively.morphic.tools.ItemInspector.open = function (itemName, json, optTabName) {
        var win = $world._itemInspectorWindow;
        if (!win || !win.world()) {
            win = lively.BuildSpec('lively.morphic.tools.ItemInspector').createMorph();
            win.openInWorld();
            win.get('ItemInspectorBody').onLoad();
            $world._itemInspectorWindow = win;
        }
        win.comeForward();
        win.get('ItemInspectorBody').loadFromJSON(json, itemName, optTabName || 'Overview');
        return win;
    };

  });
