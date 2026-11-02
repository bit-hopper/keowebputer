/**
 * lively.identity.NewWikiPageDialog
 *
 * Small BuildSpec dialog collecting Title/Category/Tags for a new wiki
 * page, replacing the old window.prompt()-only flow (WikiIndex.js's and
 * ConstellationCanvas.js's own former _promptNewWikiPage). Styled after
 * lively.morphic.tools.PublishToInventoryDialog (same style tokens: border
 * radii, Color.rgb(...) values, padding, button styling) and opened the
 * same way (world-tracked singleton via lively.BuildSpec(...).createMorph()
 * + openInWorldCenter().comeForward()) — see NewWikiPageDialog.open below.
 *
 * The dialog itself never touches storage/embedding — it only collects and
 * validates { wikiName, title, category, tags, editPolicy? } (editPolicy, "who
 * can edit", only for a constellation scope — see WikiPolicy.js) and hands them to the
 * caller's onCreate callback. Callers (WikiIndexController, Constellation-
 * CanvasController) decide what "create" means for their surface (inline
 * embed vs. a new canvas placement).
 *
 * scope (passed to .open, not otherwise used by this dialog) is either
 * { constellation: name } or { handle: handle } — purely informational for
 * callers; kept out of this file's own logic so the dialog stays
 * scope-agnostic.
 *
 * No dropdown/select morph exists anywhere else in this codebase — the
 * Category field is a minimal self-contained morphic dropdown local to
 * this file (trigger Box + a popup list of Text rows added to $world),
 * not a native <select> (this codebase's established strong preference is
 * full morphic construction, see CLAUDE.md's Material Symbols section).
 */

module('lively.identity.NewWikiPageDialog')
  .requires('lively.persistence.BuildSpec', 'lively.identity.WikiPolicy')
  .toRun(function () {

    var CATEGORIES = ['Biography', 'Place', 'Event', 'Concept', 'Organization', 'How-To'];

    lively.BuildSpec('lively.identity.NewWikiPageDialog', {
      _BorderRadius: 7,
      _Extent: lively.pt(380.0, 250.0),
      _Fill: Color.rgb(86, 150, 251),
      className: 'lively.morphic.Window',
      name: 'NewWikiPageDialog',
      sourceModule: 'lively.identity.NewWikiPageDialog',
      contentOffset: lively.pt(3.0, 22.0),
      draggingEnabled: true,
      layout: { adjustForNewBounds: true },
      minExtent: lively.pt(380.0, 250.0),
      submorphs: [{
        _BorderColor: Color.rgb(95, 94, 95),
        _BorderRadius: 4,
        _Extent: lively.pt(374.0, 222.0),
        _Fill: Color.rgb(243, 243, 243),
        _Position: lively.pt(3.0, 23.0),
        className: 'lively.morphic.Box',
        doNotCopyProperties: [],
        doNotSerialize: [],
        layout: { adjustForNewBounds: true, resizeWidth: true },
        name: 'NewWikiPageDialogPane',
        sourceModule: 'lively.morphic.Core',
        submorphs: [{
          _Extent: lively.pt(100.0, 16.0),
          _FontFamily: 'Arial, sans-serif',
          _FontSize: 11,
          _Padding: lively.rect(4, 3, 0, 0),
          _Position: lively.pt(10.0, 8.0),
          _InputAllowed: false,
          allowInput: false,
          className: 'lively.morphic.Text',
          droppingEnabled: false,
          fixedWidth: true,
          grabbingEnabled: false,
          name: 'TitleLabel',
          sourceModule: 'lively.morphic.TextCore',
          submorphs: [],
          textString: 'Title',
        }, {
          _BorderColor: Color.rgb(203, 203, 203),
          _BorderRadius: 3.75,
          _BorderWidth: 1,
          _ClipMode: 'hidden',
          _Extent: lively.pt(354.0, 22.0),
          _Fill: Color.rgb(255, 255, 255),
          _FontFamily: 'Helvetica',
          _Padding: lively.rect(4, 4, 0, 0),
          _Position: lively.pt(10.0, 30.0),
          allowInput: true,
          className: 'lively.morphic.Text',
          doNotSerialize: ['charsTyped'],
          evalEnabled: false,
          fixedHeight: true,
          fixedWidth: true,
          isInputLine: true,
          layout: { resizeWidth: true },
          name: 'TitleText',
          sourceModule: 'lively.morphic.TextCore',
          submorphs: [],
          textString: '',
        }, {
          _Extent: lively.pt(150.0, 16.0),
          _FontFamily: 'Arial, sans-serif',
          _FontSize: 11,
          _Padding: lively.rect(4, 3, 0, 0),
          _Position: lively.pt(10.0, 64.0),
          _InputAllowed: false,
          allowInput: false,
          className: 'lively.morphic.Text',
          droppingEnabled: false,
          fixedWidth: true,
          grabbingEnabled: false,
          name: 'CategoryLabel',
          sourceModule: 'lively.morphic.TextCore',
          submorphs: [],
          textString: 'Category',
        }, {
          _BorderColor: Color.rgb(203, 203, 203),
          _BorderRadius: 3.75,
          _BorderWidth: 1,
          _Extent: lively.pt(354.0, 22.0),
          _Fill: Color.rgb(255, 255, 255),
          _Position: lively.pt(10.0, 86.0),
          className: 'lively.morphic.Box',
          doNotCopyProperties: [],
          doNotSerialize: [],
          name: 'CategoryTrigger',
          sourceModule: 'lively.morphic.Core',
          submorphs: [{
            _Extent: lively.pt(320.0, 18.0),
            _Position: lively.pt(8.0, 2.0),
            _FontFamily: 'Helvetica',
            _FontSize: 12,
            className: 'lively.morphic.Text',
            eventsAreIgnored: true,
            fixedWidth: true,
            fixedHeight: true,
            name: 'CategoryValueLabel',
            sourceModule: 'lively.morphic.TextCore',
            submorphs: [],
            textColor: Color.rgb(150, 150, 150),
            textString: 'Select…',
          }, {
            _Extent: lively.pt(20.0, 18.0),
            _Position: lively.pt(328.0, 2.0),
            _FontFamily: "'Material Symbols Rounded'",
            _FontSize: 13,
            className: 'lively.morphic.Text',
            eventsAreIgnored: true,
            fixedWidth: true,
            fixedHeight: true,
            name: 'CategoryChevron',
            sourceModule: 'lively.morphic.TextCore',
            submorphs: [],
            textColor: Color.rgb(120, 120, 120),
            textString: 'expand_more',
          }],
          onMouseDown: function onMouseDown(evt) {
            this.owner.toggleCategoryPopup();
            evt.stop();
            return true;
          },
        }, {
          _Extent: lively.pt(200.0, 16.0),
          _FontFamily: 'Arial, sans-serif',
          _FontSize: 11,
          _Padding: lively.rect(4, 3, 0, 0),
          _Position: lively.pt(10.0, 120.0),
          _InputAllowed: false,
          allowInput: false,
          className: 'lively.morphic.Text',
          droppingEnabled: false,
          fixedWidth: true,
          grabbingEnabled: false,
          name: 'TagsLabel',
          sourceModule: 'lively.morphic.TextCore',
          submorphs: [],
          textString: 'Tags (comma-separated)',
        }, {
          // ── Permissions (constellation pages only; positions here are the
          // expanded layout's, relayout() below places/hides them per scope).
          _Extent: lively.pt(200.0, 16.0),
          _FontFamily: 'Arial, sans-serif',
          _FontSize: 11,
          _Padding: lively.rect(4, 3, 0, 0),
          _Position: lively.pt(10.0, 176.0),
          _InputAllowed: false,
          allowInput: false,
          className: 'lively.morphic.Text',
          droppingEnabled: false,
          fixedWidth: true,
          grabbingEnabled: false,
          name: 'PermissionsLabel',
          sourceModule: 'lively.morphic.TextCore',
          submorphs: [],
          textString: 'Who can edit',
        }, {
          _BorderColor: Color.rgb(203, 203, 203),
          _BorderRadius: 3.75,
          _BorderWidth: 1,
          _Extent: lively.pt(354.0, 22.0),
          _Fill: Color.rgb(255, 255, 255),
          _Position: lively.pt(10.0, 198.0),
          className: 'lively.morphic.Box',
          doNotCopyProperties: [],
          doNotSerialize: [],
          name: 'PermissionsTrigger',
          sourceModule: 'lively.morphic.Core',
          submorphs: [{
            _Extent: lively.pt(320.0, 18.0),
            _Position: lively.pt(8.0, 2.0),
            _FontFamily: 'Helvetica',
            _FontSize: 12,
            className: 'lively.morphic.Text',
            eventsAreIgnored: true,
            fixedWidth: true,
            fixedHeight: true,
            name: 'PermissionValueLabel',
            sourceModule: 'lively.morphic.TextCore',
            submorphs: [],
            textColor: Color.rgb(30, 30, 30),
            textString: 'All members',
          }, {
            _Extent: lively.pt(20.0, 18.0),
            _Position: lively.pt(328.0, 2.0),
            _FontFamily: "'Material Symbols Rounded'",
            _FontSize: 13,
            className: 'lively.morphic.Text',
            eventsAreIgnored: true,
            fixedWidth: true,
            fixedHeight: true,
            name: 'PermissionChevron',
            sourceModule: 'lively.morphic.TextCore',
            submorphs: [],
            textColor: Color.rgb(120, 120, 120),
            textString: 'expand_more',
          }],
          onMouseDown: function onMouseDown(evt) {
            this.owner.togglePermissionPopup();
            evt.stop();
            return true;
          },
        }, {
          _Extent: lively.pt(250.0, 16.0),
          _FontFamily: 'Arial, sans-serif',
          _FontSize: 11,
          _Padding: lively.rect(4, 3, 0, 0),
          _Position: lively.pt(10.0, 232.0),
          _InputAllowed: false,
          allowInput: false,
          className: 'lively.morphic.Text',
          droppingEnabled: false,
          fixedWidth: true,
          grabbingEnabled: false,
          name: 'HandlesLabel',
          sourceModule: 'lively.morphic.TextCore',
          submorphs: [],
          textString: 'Handles (comma-separated)',
        }, {
          _BorderColor: Color.rgb(203, 203, 203),
          _BorderRadius: 3.75,
          _BorderWidth: 1,
          _ClipMode: 'hidden',
          _Extent: lively.pt(354.0, 22.0),
          _Fill: Color.rgb(255, 255, 255),
          _FontFamily: 'Helvetica',
          _Padding: lively.rect(4, 4, 0, 0),
          _Position: lively.pt(10.0, 254.0),
          allowInput: true,
          className: 'lively.morphic.Text',
          doNotSerialize: ['charsTyped'],
          evalEnabled: false,
          fixedHeight: true,
          fixedWidth: true,
          isInputLine: true,
          layout: { resizeWidth: true },
          name: 'HandlesText',
          sourceModule: 'lively.morphic.TextCore',
          submorphs: [],
          textString: '',
        }, {
          _BorderColor: Color.rgb(203, 203, 203),
          _BorderRadius: 3.75,
          _BorderWidth: 1,
          _ClipMode: 'hidden',
          _Extent: lively.pt(354.0, 22.0),
          _Fill: Color.rgb(255, 255, 255),
          _FontFamily: 'Helvetica',
          _Padding: lively.rect(4, 4, 0, 0),
          _Position: lively.pt(10.0, 142.0),
          allowInput: true,
          className: 'lively.morphic.Text',
          doNotSerialize: ['charsTyped'],
          evalEnabled: false,
          fixedHeight: true,
          fixedWidth: true,
          isInputLine: true,
          layout: { resizeWidth: true },
          name: 'TagsText',
          sourceModule: 'lively.morphic.TextCore',
          submorphs: [],
          textString: '',
        }, {
          _Extent: lively.pt(354.0, 18.0),
          _FontFamily: 'Arial, sans-serif',
          _FontSize: 11,
          _Padding: lively.rect(4, 3, 0, 0),
          _Position: lively.pt(10.0, 176.0),
          _InputAllowed: false,
          allowInput: false,
          className: 'lively.morphic.Text',
          droppingEnabled: false,
          fixedWidth: true,
          grabbingEnabled: false,
          name: 'StatusText',
          sourceModule: 'lively.morphic.TextCore',
          submorphs: [],
          textColor: Color.rgb(153, 153, 153),
          textString: '',
        }, {
          _BorderColor: Color.rgb(214, 214, 214),
          _BorderRadius: 5,
          _BorderWidth: 1,
          _Extent: lively.pt(80.0, 24.0),
          _Position: lively.pt(204.0, 182.0),
          className: 'lively.morphic.Button',
          doNotCopyProperties: [],
          doNotSerialize: [],
          isPressed: false,
          label: 'cancel',
          name: 'CancelButton',
          sourceModule: 'lively.morphic.Widgets',
          submorphs: [],
          toggle: false,
          value: false,
          connectionRebuilder: function connectionRebuilder() {
            lively.bindings.connect(this, 'fire', this.get('NewWikiPageDialogPane'), 'onCancel', {});
          },
        }, {
          _BorderColor: Color.rgb(150, 190, 250),
          _BorderRadius: 5.2,
          _BorderWidth: 1.184,
          _Extent: lively.pt(80.0, 24.0),
          _Fill: Color.rgb(235, 244, 255),
          _Position: lively.pt(288.0, 182.0),
          className: 'lively.morphic.Button',
          doNotCopyProperties: [],
          doNotSerialize: [],
          isPressed: false,
          label: 'create',
          name: 'CreateButton',
          sourceModule: 'lively.morphic.Widgets',
          submorphs: [],
          toggle: false,
          value: false,
          connectionRebuilder: function connectionRebuilder() {
            lively.bindings.connect(this, 'fire', this.get('NewWikiPageDialogPane'), 'onSubmit', {});
          },
        }],
        target: null,

        // ─── lifecycle ──────────────────────────────────────────────────────────

        // scope: { constellation: name } | { handle: handle } — informational
        // only, threaded straight through to onCreate's caller-supplied
        // callback; this dialog never itself decides what scope means.
        configure: function configure(opts) {
          this._scope = (opts && opts.scope) || null;
          this._onCreateCallback = (opts && opts.onCreate) || null;
          this._category = null;
          this._permMode = 'members';
          this.get('TitleText').textString = '';
          this.get('TagsText').textString = '';
          this.get('HandlesText').textString = '';
          this.get('CategoryValueLabel').textString = 'Select…';
          this.get('CategoryValueLabel').setTextColor(Color.rgb(150, 150, 150));
          this.get('PermissionValueLabel').textString = lively.identity.WikiPolicy.label('members');
          this.setStatus('');
          this.relayout();
        },

        // Permissions ("who can edit") only exists for a constellation page --
        // a personal page is author-only -- so for a personal scope this puts
        // everything back exactly where the original three-field dialog had
        // it. For a constellation the Permissions row is added below Tags, plus
        // a Handles field while "Specific handles" is chosen; the status line,
        // buttons and the window itself move down / grow to fit.
        relayout: function relayout() {
          var constellation = !!(this._scope && this._scope.constellation);
          var handlesMode = constellation && this._permMode === 'handles';
          var y = 176; // where the block after Tags starts

          ['PermissionsLabel', 'PermissionsTrigger'].forEach(function (n) {
            this.get(n).setVisible(constellation);
          }, this);
          ['HandlesLabel', 'HandlesText'].forEach(function (n) {
            this.get(n).setVisible(handlesMode);
          }, this);

          if (constellation) {
            this.get('PermissionsLabel').setPosition(lively.pt(10, y));
            this.get('PermissionsTrigger').setPosition(lively.pt(10, y + 22));
            y += 56;
          }
          if (handlesMode) {
            this.get('HandlesLabel').setPosition(lively.pt(10, y));
            this.get('HandlesText').setPosition(lively.pt(10, y + 22));
            y += 56;
          }
          this.get('StatusText').setPosition(lively.pt(10, y));
          this.get('CancelButton').setPosition(lively.pt(204, y + 6));
          this.get('CreateButton').setPosition(lively.pt(288, y + 6));

          var paneH = y + 46;
          this.setExtent(lively.pt(374, paneH));
          this.owner.setExtent(lively.pt(380, paneH + 28));
        },

        onCancel: function onCancel() {
          this.owner.remove();
        },

        onRemove: function onRemove() {
          if (this._categoryPopup) { this._categoryPopup.remove(); this._categoryPopup = null; }
          if (this._permissionPopup) { this._permissionPopup.remove(); this._permissionPopup = null; }
          $world.newWikiPageDialog && $world.newWikiPageDialog.remove();
        },

        setStatus: function setStatus(text, isError) {
          var t = this.get('StatusText');
          t.textString = text || '';
          t.setTextColor(isError ? Color.rgb(204, 51, 51) : Color.rgb(153, 153, 153));
        },

        // ─── category dropdown ──────────────────────────────────────────────────
        // No dropdown/select morph exists elsewhere in this codebase — built
        // as a minimal popup here: a floating Box of Text rows added to
        // $world (not nested inside this dialog, so it isn't clipped by the
        // dialog's own bounds), positioned from the trigger's live DOM
        // rect. $world coordinates equal screen pixels in this app (no
        // pan/zoom), same assumption WikiIndex.js's own layout already
        // relies on, so a raw getBoundingClientRect() needs no further
        // translation.

        toggleCategoryPopup: function toggleCategoryPopup() {
          if (this._categoryPopup) {
            this._categoryPopup.remove();
            this._categoryPopup = null;
            return;
          }
          var trigger = this.get('CategoryTrigger');
          var rect = trigger.renderContext().shapeNode.getBoundingClientRect();
          var rowH = 26;
          var categories = ['Biography', 'Place', 'Event', 'Concept', 'Organization', 'How-To'];

          var popup = new lively.morphic.Box(lively.rect(0, 0, rect.width, categories.length * rowH + 8));
          popup.setFill(Color.white);
          popup.applyStyle({ borderWidth: 1, borderColor: Color.rgb(180, 180, 180), borderRadius: 4 });
          popup.setPosition(lively.pt(rect.left, rect.bottom + 4));

          var self = this;
          categories.forEach(function (cat, i) {
            var row = new lively.morphic.Text(lively.rect(6, 4 + i * rowH, rect.width - 12, rowH - 4), cat);
            row.applyStyle({
              fontSize: 12, fontFamily: 'Helvetica', textColor: Color.rgb(40, 40, 40),
              fill: null, borderWidth: 0, borderColor: null,
            });
            row.eventsAreIgnored = false;
            row.renderContext().shapeNode.style.cursor = 'pointer';
            row.onMouseDown = function () { self.selectCategory(cat); return true; };
            row.onMouseOver = function () { row.setFill(Color.rgb(235, 244, 255)); };
            row.onMouseOut = function () { row.setFill(null); };
            popup.addMorph(row);
          });

          $world.addMorph(popup);
          popup.bringToFront();
          this._categoryPopup = popup;
        },

        selectCategory: function selectCategory(cat) {
          this._category = cat;
          var label = this.get('CategoryValueLabel');
          label.textString = cat;
          label.setTextColor(Color.rgb(30, 30, 30));
          if (this._categoryPopup) { this._categoryPopup.remove(); this._categoryPopup = null; }
        },

        // ─── permissions dropdown ───────────────────────────────────────────────
        // Same minimal popup as the category dropdown above: rows added to
        // $world, positioned from the trigger's live DOM rect. Rows read
        // "Label — hint" so the choice is self-explanatory without a
        // separate description line.

        togglePermissionPopup: function togglePermissionPopup() {
          if (this._permissionPopup) {
            this._permissionPopup.remove();
            this._permissionPopup = null;
            return;
          }
          var trigger = this.get('PermissionsTrigger');
          var rect = trigger.renderContext().shapeNode.getBoundingClientRect();
          // Two lines per option -- the label, and its hint underneath in grey --
          // instead of one "Label — hint" line, which wrapped and overlapped
          // its neighbours at this width. The row Box takes the click and the
          // hover fill; its Text children ignore events so they can't
          // intercept either.
          var rowH = 44;
          var modes = lively.identity.WikiPolicy.MODES;

          var popup = new lively.morphic.Box(lively.rect(0, 0, rect.width, modes.length * rowH + 8));
          popup.setFill(Color.white);
          popup.applyStyle({ borderWidth: 1, borderColor: Color.rgb(180, 180, 180), borderRadius: 4 });
          popup.setPosition(lively.pt(rect.left, rect.bottom + 4));

          var self = this;
          function plainText(bounds, text, style) {
            var t = new lively.morphic.Text(bounds, text);
            t.applyStyle(Object.extend({ fontFamily: 'Helvetica', fill: null, borderWidth: 0, borderColor: null }, style));
            t.eventsAreIgnored = true;
            return t;
          }
          modes.forEach(function (mode, i) {
            var chosen = mode.key === self._permMode;
            var row = new lively.morphic.Box(lively.rect(4, 4 + i * rowH, rect.width - 8, rowH - 2));
            row.applyStyle({ fill: null, borderWidth: 0, borderRadius: 3 });
            row.draggingEnabled = false;
            row.droppingEnabled = false;
            row.grabbingEnabled = false;
            row.renderContext().shapeNode.style.cursor = 'pointer';
            row.addMorph(plainText(lively.rect(8, 3, rect.width - 60, 20), mode.label,
              { fontSize: 11, fontWeight: '600', textColor: Color.rgb(30, 30, 30) }));
            row.addMorph(plainText(lively.rect(8, 22, rect.width - 60, 18), mode.hint,
              { fontSize: 8.5, textColor: Color.rgb(130, 130, 130) }));
            if (chosen) {
              row.addMorph(plainText(lively.rect(rect.width - 40, 10, 24, 22), 'check',
                { fontSize: 11, fontFamily: "'Material Symbols Rounded'", textColor: Color.rgb(70, 130, 220) }));
            }
            row.onMouseDown = function () { self.selectPermission(mode.key); return true; };
            row.onMouseOver = function () { row.setFill(Color.rgb(235, 244, 255)); };
            row.onMouseOut = function () { row.setFill(null); };
            popup.addMorph(row);
          });

          $world.addMorph(popup);
          popup.bringToFront();
          this._permissionPopup = popup;
        },

        selectPermission: function selectPermission(modeKey) {
          this._permMode = modeKey;
          this.get('PermissionValueLabel').textString = lively.identity.WikiPolicy.label(modeKey);
          if (this._permissionPopup) { this._permissionPopup.remove(); this._permissionPopup = null; }
          this.setStatus('');
          this.relayout();
        },

        // ─── submit ──────────────────────────────────────────────────────────────

        slugify: function slugify(s) {
          return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64);
        },

        onSubmit: function onSubmit() {
          var titleRaw = this.get('TitleText').textString.trim();
          if (!titleRaw) { this.setStatus('Title is required', true); return; }
          var wikiName = this.slugify(titleRaw);
          if (!wikiName) { this.setStatus('Title must contain at least one letter or number', true); return; }
          if (!this._category) { this.setStatus('Choose a category', true); return; }

          var tagsRaw = this.get('TagsText').textString.trim();
          var tags = tagsRaw
            ? tagsRaw.split(',').map(function (t) { return t.trim(); }).filter(Boolean)
            : [];

          var fields = { wikiName: wikiName, title: titleRaw, category: this._category, tags: tags };

          // Who can edit: only a constellation page has the choice. "All
          // members" is the default and is left unset (an absent editPolicy
          // means exactly that), so only a restriction is stored.
          if (this._scope && this._scope.constellation) {
            var built = lively.identity.WikiPolicy.build(this._permMode, this.get('HandlesText').textString);
            if (built.error) { this.setStatus(built.error, true); return; }
            fields.editPolicy = built.policy.mode === 'members' ? null : built.policy;
          }

          var cb = this._onCreateCallback;
          this.owner.remove();
          if (cb) cb(fields);
        },
      }],
      titleBar: 'New Wiki Page',
      connectionRebuilder: function connectionRebuilder() {
        lively.bindings.connect(this, 'remove', this.get('NewWikiPageDialogPane'), 'onRemove', {});
      },
    });

    // Static open helper — mirrors the world-tracked-singleton pattern
    // PartsBin.js already uses inline for PublishToInventoryDialog, pulled
    // out here since this dialog has multiple call sites (WikiIndex.js,
    // ConstellationCanvas.js) that would otherwise each repeat the same
    // four lines of BuildSpec/world-tracking boilerplate.
    //
    // Object.extend, NOT a flat `lively.identity.NewWikiPageDialog = {...}`
    // reassignment — lively.BuildSpec('lively.identity.NewWikiPageDialog',
    // {...}) above already registered the real class at that dotted path
    // (same mechanism WikiEditor.js's `.subclass('lively.identity.
    // WikiEditor', ...)` uses, extended with static methods via
    // `Object.extend(WikiEditorClass, {...})` rather than overwriting the
    // path). A flat reassignment here would silently replace that
    // registered class with a plain object — confirmed live: BuildSpec's
    // own createMorph() does `lively.module(object.sourceModule)` to
    // resolve `sourceModule: 'lively.identity.NewWikiPageDialog'` on the
    // spec above, and a clobbered path breaks that lookup with
    // "sourceMod.isLoaded is not a function" the moment .open() runs.
    //
    // opts: { scope: {constellation:name}|{handle:handle}, onCreate(fields) }
    // fields: { wikiName, title, category, tags, editPolicy? } — editPolicy only
    // for a constellation scope, and null for "all members" (the default).
    Object.extend(lively.identity.NewWikiPageDialog, {
      open: function (opts) {
        var world = lively.morphic.World.current();
        if (world.newWikiPageDialog) world.newWikiPageDialog.remove();
        var dlg = lively.BuildSpec('lively.identity.NewWikiPageDialog').createMorph();
        dlg.openInWorldCenter().comeForward();
        world.newWikiPageDialog = dlg;
        dlg.get('NewWikiPageDialogPane').configure(opts || {});
        return dlg;
      },
    });

  }); // end of module
