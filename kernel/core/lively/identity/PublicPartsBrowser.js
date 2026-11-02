module('lively.identity.PublicPartsBrowser').requires('lively.persistence.BuildSpec', 'lively.PartsBin', 'lively.identity.IdentityPartsSpace').toRun(function() {

// SUPERSEDED by lively.identity.Inventory (core/lively/identity/Inventory.js)
// — full layout/feature parity with the classic PartsBin browser (instance
// chooser, category sidebar, thumbnail grid, collapsible info panel with
// Share Link/Inspect/version history). The "Browse Public Inventory" menu
// entry (core/lively/morphic/Widgets.js) now opens that instead. This file
// is kept on disk (not deleted) only because start.html — a live serialized
// world snapshot, not source — still has a leftover serialized
// PublicPartsBrowser window instance from a previous session; deleting the
// module would break that snapshot's deserialization on boot. Do not open
// this from new code.

// A small window for browsing/searching every publicly "Published to
// Inventory" part across ALL users — the classic PartsBinBrowser's
// "*myparts*"/"#tag" categories and its WebDAV-backed Search command can
// neither of them find these (see the /parts/public route's own doc
// comment in IdentityServer.js). Talks directly to that new cross-user
// index route rather than going through IdentityPartsSpace/ObjectStore
// (both of which are hardwired to the current signed-in user's own local
// IndexedDB cache).
lively.BuildSpec('lively.identity.PublicPartsBrowser', {
    _BorderRadius: 7,
    _Extent: lively.pt(440.0, 420.0),
    _Fill: Color.rgb(251,86,213),
    className: 'lively.morphic.Window',
    name: 'PublicPartsBrowser',
    sourceModule: 'lively.identity.PublicPartsBrowser',
    contentOffset: lively.pt(3.0, 22.0),
    draggingEnabled: true,
    layout: { adjustForNewBounds: true },
    minExtent: lively.pt(440.0, 420.0),
    submorphs: [{
        _BorderColor: Color.rgb(95,94,95),
        _BorderRadius: 4,
        _Extent: lively.pt(434.0, 392.0),
        _Fill: Color.rgb(243,243,243),
        _Position: lively.pt(3.0, 23.0),
        className: 'lively.morphic.Box',
        doNotCopyProperties: [],
        doNotSerialize: [],
        layout: { adjustForNewBounds: true, resizeWidth: true, resizeHeight: true },
        name: 'PublicPartsBrowserPane',
        sourceModule: 'lively.morphic.Core',
        submorphs: [{
            _Extent: lively.pt(200.0, 16.0),
            _FontFamily: 'Arial, sans-serif',
            _FontSize: 11,
            _Padding: lively.rect(4,3,0,0),
            _Position: lively.pt(10.0, 8.0),
            _InputAllowed: false,
            allowInput: false,
            className: 'lively.morphic.Text',
            droppingEnabled: false,
            fixedWidth: true,
            grabbingEnabled: false,
            name: 'SearchLabel',
            sourceModule: 'lively.morphic.TextCore',
            submorphs: [],
            textString: 'Search public Inventory'
        },{
            _BorderColor: Color.rgb(203,203,203),
            _BorderRadius: 3.75,
            _BorderWidth: 1,
            _ClipMode: 'hidden',
            _Extent: lively.pt(324.0, 22.0),
            _Fill: Color.rgb(255,255,255),
            _FontFamily: 'Helvetica',
            _Padding: lively.rect(4,4,0,0),
            _Position: lively.pt(10.0, 26.0),
            allowInput: true,
            className: 'lively.morphic.Text',
            doNotSerialize: ['charsTyped'],
            evalEnabled: false,
            fixedHeight: true,
            layout: { resizeWidth: true },
            name: 'SearchText',
            sourceModule: 'lively.morphic.TextCore',
            submorphs: [],
            isInputLine: true,
            textString: '',
            connectionRebuilder: function connectionRebuilder() {
                lively.bindings.connect(this, 'savedTextString', this.owner, 'onSearch', {});
            }
        },{
            _BorderColor: Color.rgb(214,214,214),
            _BorderRadius: 5,
            _BorderWidth: 1,
            _Extent: lively.pt(70.0, 24.0),
            _Position: lively.pt(344.0, 25.0),
            className: 'lively.morphic.Button',
            doNotCopyProperties: [],
            doNotSerialize: [],
            isPressed: false,
            label: 'search',
            name: 'SearchButton',
            sourceModule: 'lively.morphic.Widgets',
            submorphs: [],
            toggle: false,
            value: false,
            connectionRebuilder: function connectionRebuilder() {
                lively.bindings.connect(this, 'fire', this.owner, 'onSearch', {});
            }
        },{
            _BorderColor: Color.rgb(203,203,203),
            _BorderRadius: 3,
            _BorderWidth: 1,
            _ClipMode: { x: 'hidden', y: 'scroll' },
            _Extent: lively.pt(414.0, 300.0),
            _Fill: Color.rgb(255,255,255),
            _Position: lively.pt(10.0, 58.0),
            className: 'lively.morphic.List',
            doNotCopyProperties: [],
            doNotSerialize: [],
            droppingEnabled: false,
            itemList: [],
            layout: { resizeWidth: true, resizeHeight: true },
            name: 'ResultsList',
            sourceModule: 'lively.morphic.Lists',
            submorphs: [],
            connectionRebuilder: function connectionRebuilder() {
                lively.bindings.connect(this, 'selection', this.owner, 'onSelectionChanged', {});
            }
        },{
            _Extent: lively.pt(300.0, 16.0),
            _FontFamily: 'Arial, sans-serif',
            _FontSize: 11,
            _Padding: lively.rect(4,3,0,0),
            _Position: lively.pt(10.0, 362.0),
            _InputAllowed: false,
            allowInput: false,
            className: 'lively.morphic.Text',
            droppingEnabled: false,
            fixedWidth: true,
            grabbingEnabled: false,
            name: 'StatusText',
            sourceModule: 'lively.morphic.TextCore',
            submorphs: [],
            textColor: Color.rgb(153,153,153),
            textString: ''
        },{
            _BorderColor: Color.rgb(214,214,214),
            _BorderRadius: 5,
            _BorderWidth: 1,
            _Extent: lively.pt(80.0, 24.0),
            _Position: lively.pt(344.0, 358.0),
            className: 'lively.morphic.Button',
            doNotCopyProperties: [],
            doNotSerialize: [],
            isPressed: false,
            label: 'open',
            name: 'OpenButton',
            sourceModule: 'lively.morphic.Widgets',
            submorphs: [],
            toggle: false,
            value: false,
            connectionRebuilder: function connectionRebuilder() {
                lively.bindings.connect(this, 'fire', this.owner, 'onOpenSelected', {});
            }
        }],

        // ─── state ───────────────────────────────────────────────────────

        cursor: null,
        results: [],

        // ─── loading ─────────────────────────────────────────────────────

        onLoad: function onLoad() {
            this.loadResults('');
        },

        setStatus: function setStatus(text, isError) {
            var t = this.get('StatusText');
            t.textString = text || '';
            t.setTextColor(isError ? Color.rgb(204,51,51) : Color.rgb(153,153,153));
        },

        onSearch: function onSearch() {
            this.loadResults(this.get('SearchText').textString.trim());
        },

        loadResults: function loadResults(q) {
            var self = this;
            this.setStatus('Loading…');
            var url = '/parts/public?limit=40' + (q ? '&q=' + encodeURIComponent(q) : '');
            fetch(url, { credentials: 'include' })
                .then(function(res) { return res.json(); })
                .then(function(body) {
                    if (!body || !body.parts) { self.setStatus('Load failed', true); return; }
                    self.results = body.parts;
                    self.cursor = body.cursor;
                    self.get('ResultsList').updateList(self.results.map(function(p) {
                        var name = (p.state && p.state.partName) || p.objId;
                        var handle = p.handle ? ('@' + p.handle) : '(unknown)';
                        var tags = (p.state && p.state.tags && p.state.tags.length) ? ' — ' + p.state.tags.join(', ') : '';
                        return { isListItem: true, string: name + '  ·  ' + handle + tags, value: p };
                    }));
                    self.setStatus(self.results.length + (self.results.length === 1 ? ' part found' : ' parts found') + (self.cursor ? ' (more available)' : ''));
                })
                .catch(function(err) {
                    self.setStatus('Load failed: ' + (err && err.message || err), true);
                });
        },

        onSelectionChanged: function onSelectionChanged() {
            // no-op for now — selection just enables "open"; kept as its
            // own hook in case a preview pane gets added later.
        },

        // ─── opening a result ────────────────────────────────────────────

        onOpenSelected: function onOpenSelected() {
            var self = this;
            var meta = this.get('ResultsList').selection;
            if (!meta || !meta.objId) { this.setStatus('Select a part first', true); return; }
            var handle = meta.handle || '_';
            this.setStatus('Opening ' + ((meta.state && meta.state.partName) || meta.objId) + '…');

            fetch('/@' + encodeURIComponent(handle) + '/' + encodeURIComponent(meta.objId), { credentials: 'include' })
                .then(function(res) {
                    if (!res.ok) throw new Error('HTTP ' + res.status);
                    return res.json();
                })
                .then(function(envelope) {
                    self._openEnvelope(envelope);
                })
                .catch(function(err) {
                    self.setStatus('Failed to fetch part: ' + (err && err.message || err), true);
                });
        },

        // Builds a throwaway lively.identity.IdentityPartItem directly from
        // an arbitrary fetched envelope (not via
        // UserSpace.getPersonalPartsSpace, which is hardwired to the
        // CURRENT signed-in user's own space) — IdentityPartItem.loadPart
        // only ever reads this.envelope/this.loadedMetaInfo, so it works
        // for any owner's public envelope just as well. Mirrors
        // IdentityPartsSpace.createPartItemFromEnvelope's construction
        // (core/lively/identity/IdentityPartsSpace.js) without needing a
        // full IdentityPartsSpace scoped to someone else's handle.
        //
        // Pre-loads the part's own class module via lively.require(...)
        // BEFORE deserializing, rather than letting Morph.deserialize
        // discover the missing class mid-deserialize and load it itself.
        // Confirmed live: that internal fallback logs "Loading sync
        // <url>" (core/lively/bootstrap.js JSLoader.loadJs) and, on top of
        // that, lively.require(...).toRun(fn) itself was confirmed live to
        // sometimes fire fn BEFORE the module has actually finished
        // loading when triggered from a real UI event handler (reliably
        // reproducible clicking through the actual browser UI; a bare
        // console-driven call didn't show it) — Module.isLoaded() still
        // false at that point, and deserializing before the class exists
        // produces a broken non-morph "part" (TypeError later on
        // part.comeForward). _waitForModules below re-checks
        // isLoaded() on every named module and polls a bit longer if
        // toRun fired early, instead of trusting that callback alone.
        _openEnvelope: function _openEnvelope(envelope) {
            var self = this;
            var state = envelope.state || {};
            var partName = state.partName || envelope.objId;
            var payload = envelope.record && envelope.record.payload;
            var json = typeof payload === 'string' ? payload : JSON.stringify(payload);

            var modules;
            try {
                modules = lively.persistence.Serializer.sourceModulesIn(JSON.parse(json));
            } catch (e) {
                modules = [];
            }

            lively.require(modules).toRun(function() {
                self._waitForModules(modules, 0, function(err) {
                    if (err) { self.setStatus('Failed to load part: ' + err.message, true); return; }

                    var item = new lively.identity.IdentityPartItem(partName, '*public*');
                    item.envelope = envelope;
                    item.handle = self.get('ResultsList').selection && self.get('ResultsList').selection.handle;

                    var metaInfo = new lively.PartsBin.PartsBinMetaInfo();
                    metaInfo.partName        = partName;
                    metaInfo.comment         = state.comment || '';
                    metaInfo.tags            = state.tags || [];
                    metaInfo.requiredModules = state.requiredModules || [];
                    metaInfo.migrationLevel  = state.migrationLevel || 9;
                    metaInfo.partsSpaceName  = '*public*';
                    metaInfo.lastModifiedDate = envelope.created ? new Date(envelope.created) : new Date();
                    item.loadedMetaInfo = metaInfo;

                    item.loadPart(false, false, null, function(err2, part) {
                        if (err2) { self.setStatus('Failed to load part: ' + (err2.message || err2), true); return; }
                        if (!part || typeof part.openInWorld !== 'function') {
                            self.setStatus('Failed to load part: deserialized object is not a morph', true);
                            return;
                        }
                        var world = self.world();
                        part.openInWorld(world.visibleBounds().center().subPt(part.getExtent().scaleBy(0.5)));
                        // Not every morph class defines comeForward (e.g.
                        // lively.morphic.Box subclasses like Shop don't —
                        // confirmed live: only some classes, such as
                        // Window, do) — guard rather than assume it's a
                        // universal Morph method.
                        if (typeof part.comeForward === 'function') part.comeForward();
                        self.setStatus('Opened "' + partName + '"');
                    });
                });
            });
        },

        // Polls for each module's actual global namespace value directly
        // (walking e.g. "Global.lively.commerce.Shop" -> window.lively
        // .commerce.Shop) rather than lively.module(name).isLoaded() —
        // confirmed live that isLoaded is undefined whenever the module's
        // own namespace resolves to a class/function (as any module(X)
        // .toRun(fn){ X.subclass(...) }) declaration does), since
        // lively.module(name) then returns that class itself, not a real
        // Module bookkeeping object. That made the isLoaded-based version
        // of this check report "never loaded" unconditionally, even once
        // the class genuinely was ready — retrying up to 4s. cb(err).
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
            if (elapsedMs >= 4000) {
                cb(new Error('module(s) never finished loading: ' + pending.join(', ')));
                return;
            }
            setTimeout(function() {
                self._waitForModules(modules, elapsedMs + 100, cb);
            }, 100);
        },

        onCancel: function onCancel() {
            this.owner.remove();
        },
    }],
    titleBar: 'Browse Public Inventory',
    withLayers: '[GrabbingLayer]',
});

// Assign onto the module's own namespace object rather than replacing it
// (lively.identity.PublicPartsBrowser = {...} would do that) — module(...)
// already sets that name to point at internal bookkeeping BuildSpec's
// createMorph() reads via lively.module(sourceModule).isLoaded(); clobbering
// it with a plain object broke createMorph with "sourceMod.isLoaded is not
// a function", confirmed live.
lively.identity.PublicPartsBrowser.open = function(optPos) {
    if ($world.publicPartsBrowser) $world.publicPartsBrowser.remove();
    var win = lively.BuildSpec('lively.identity.PublicPartsBrowser').createMorph();
    win.openInWorld(optPos || $world.visibleBounds().center().subPt(lively.pt(220, 210)));
    win.comeForward();
    $world.publicPartsBrowser = win;
    win.get('PublicPartsBrowserPane').onLoad();
    return win;
};

}); // end module('lively.identity.PublicPartsBrowser')
