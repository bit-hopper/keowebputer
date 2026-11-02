module('lively.morphic.tools.PublishToInventoryDialog').requires('lively.persistence.BuildSpec', 'lively.PartsBin', 'lively.identity.PartSerializer').toRun(function() {

lively.BuildSpec("lively.morphic.tools.PublishToInventoryDialog", {
    _BorderRadius: 7,
    _Extent: lively.pt(380.0,412.0),
    _Fill: Color.rgb(251,86,213),
    className: "lively.morphic.Window",
    name: "PublishToInventoryDialog",
    sourceModule: "lively.morphic.tools.PublishToInventoryDialog",
    contentOffset: lively.pt(3.0,22.0),
    draggingEnabled: true,
    layout: {
        adjustForNewBounds: true
    },
    minExtent: lively.pt(380.0,412.0),
    submorphs: [{
        _BorderColor: Color.rgb(95,94,95),
        _BorderRadius: 4,
        _Extent: lively.pt(374.0,384.0),
        _Fill: Color.rgb(243,243,243),
        _Position: lively.pt(3.0,23.0),
        className: "lively.morphic.Box",
        doNotCopyProperties: [],
        doNotSerialize: [],
        layout: {
            adjustForNewBounds: true,
            resizeWidth: true
        },
        name: "PublishToInventoryPane",
        sourceModule: "lively.morphic.Core",
        submorphs: [{
            _Extent: lively.pt(100.0,16.0),
            _FontFamily: "Arial, sans-serif",
            _FontSize: 11,
            _Padding: lively.rect(4,3,0,0),
            _Position: lively.pt(10.0,8.0),
            _InputAllowed: false,
            allowInput: false,
            className: "lively.morphic.Text",
            droppingEnabled: false,
            fixedWidth: true,
            grabbingEnabled: false,
            name: "NameLabel",
            sourceModule: "lively.morphic.TextCore",
            submorphs: [],
            textString: "Name"
        },{
            _BorderColor: Color.rgb(203,203,203),
            _BorderRadius: 3.75,
            _BorderWidth: 1,
            _ClipMode: "hidden",
            _Extent: lively.pt(354.0,22.0),
            _Fill: Color.rgb(255,255,255),
            _FontFamily: "Helvetica",
            _Padding: lively.rect(4,4,0,0),
            _Position: lively.pt(10.0,30.0),
            allowInput: true,
            className: "lively.morphic.Text",
            doNotSerialize: ["charsTyped"],
            evalEnabled: false,
            fixedHeight: true,
            fixedWidth: true,
            isInputLine: true,
            layout: {
                resizeWidth: true
            },
            name: "NameText",
            sourceModule: "lively.morphic.TextCore",
            submorphs: [],
            textString: ""
        },{
            _Extent: lively.pt(150.0,16.0),
            _FontFamily: "Arial, sans-serif",
            _FontSize: 11,
            _Padding: lively.rect(4,3,0,0),
            _Position: lively.pt(10.0,64.0),
            _InputAllowed: false,
            allowInput: false,
            className: "lively.morphic.Text",
            droppingEnabled: false,
            fixedWidth: true,
            grabbingEnabled: false,
            name: "CommentLabel",
            sourceModule: "lively.morphic.TextCore",
            submorphs: [],
            textString: "Comment"
        },{
            _BorderColor: Color.rgb(203,203,203),
            _BorderRadius: 4.5,
            _BorderWidth: 1,
            _ClipMode: "auto",
            _Extent: lively.pt(354.0,50.0),
            _Fill: Color.rgb(255,255,255),
            _FontFamily: "Helvetica",
            _Padding: lively.rect(4,4,0,0),
            _Position: lively.pt(10.0,86.0),
            allowInput: true,
            className: "lively.morphic.Text",
            doNotSerialize: ["charsTyped"],
            evalEnabled: false,
            fixedHeight: true,
            fixedWidth: true,
            isInputLine: false,
            layout: {
                resizeWidth: true
            },
            name: "CommentText",
            sourceModule: "lively.morphic.TextCore",
            submorphs: [],
            textString: ""
        },{
            _Extent: lively.pt(200.0,16.0),
            _FontFamily: "Arial, sans-serif",
            _FontSize: 11,
            _Padding: lively.rect(4,3,0,0),
            _Position: lively.pt(10.0,148.0),
            _InputAllowed: false,
            allowInput: false,
            className: "lively.morphic.Text",
            droppingEnabled: false,
            fixedWidth: true,
            grabbingEnabled: false,
            name: "CategoryLabel",
            sourceModule: "lively.morphic.TextCore",
            submorphs: [],
            textString: "Category"
        },{
            // Curated dropdown (inventory.md §7) — required at publish
            // time, unlike the freeform Tags field below it. No default
            // selection (selectedLineNo:-1) so onPublish can reject an
            // unset category rather than silently publishing one.
            _BorderColor: Color.rgb(203,203,203),
            _BorderRadius: 3.75,
            _BorderWidth: 1,
            _ClipMode: "hidden",
            _Extent: lively.pt(354.0,22.0),
            _Fill: Color.rgb(255,255,255),
            _FontFamily: "Helvetica",
            _FontSize: 10,
            _Position: lively.pt(10.0,170.0),
            _StyleClassNames: ["Morph","Box","OldList","DropDownList"],
            changeTriggered: false,
            className: "lively.morphic.DropDownList",
            droppingEnabled: false,
            layout: {
                resizeWidth: true
            },
            name: "CategoryChooser",
            selectedLineNo: -1,
            sourceModule: "lively.morphic.Lists",
            submorphs: [],
            withoutLayers: []
        },{
            _Extent: lively.pt(300.0,16.0),
            _FontFamily: "Arial, sans-serif",
            _FontSize: 11,
            _Padding: lively.rect(4,3,0,0),
            _Position: lively.pt(10.0,204.0),
            _InputAllowed: false,
            allowInput: false,
            className: "lively.morphic.Text",
            droppingEnabled: false,
            fixedWidth: true,
            grabbingEnabled: false,
            name: "TagsLabel",
            sourceModule: "lively.morphic.TextCore",
            submorphs: [],
            textString: "Tags (optional, comma-separated)"
        },{
            _BorderColor: Color.rgb(203,203,203),
            _BorderRadius: 3.75,
            _BorderWidth: 1,
            _ClipMode: "hidden",
            _Extent: lively.pt(354.0,22.0),
            _Fill: Color.rgb(255,255,255),
            _FontFamily: "Helvetica",
            _Padding: lively.rect(4,4,0,0),
            _Position: lively.pt(10.0,226.0),
            allowInput: true,
            className: "lively.morphic.Text",
            doNotSerialize: ["charsTyped"],
            evalEnabled: false,
            fixedHeight: true,
            fixedWidth: true,
            isInputLine: true,
            layout: {
                resizeWidth: true
            },
            name: "TagsText",
            sourceModule: "lively.morphic.TextCore",
            submorphs: [],
            textString: ""
        },{
            _Extent: lively.pt(100.0,16.0),
            _FontFamily: "Arial, sans-serif",
            _FontSize: 11,
            _Padding: lively.rect(4,3,0,0),
            _Position: lively.pt(10.0,260.0),
            _InputAllowed: false,
            allowInput: false,
            className: "lively.morphic.Text",
            droppingEnabled: false,
            fixedWidth: true,
            grabbingEnabled: false,
            name: "VisibilityLabel",
            sourceModule: "lively.morphic.TextCore",
            submorphs: [],
            textString: "Visibility"
        },{
            _BorderColor: Color.rgb(180,180,180),
            _BorderRadius: 5,
            _BorderWidth: 1,
            _Extent: lively.pt(76.0,24.0),
            _Position: lively.pt(10.0,282.0),
            className: "lively.morphic.Button",
            doNotCopyProperties: [],
            doNotSerialize: [],
            isPressed: false,
            label: "Public",
            name: "PublicButton",
            sourceModule: "lively.morphic.Widgets",
            submorphs: [],
            toggle: false,
            value: false,
            connectionRebuilder: function connectionRebuilder() {
            lively.bindings.connect(this, "fire", this.get("PublishToInventoryPane"), "selectVisibility", {
                converter: function() { return "public"; }
            });
        }
        },{
            _BorderColor: Color.rgb(180,180,180),
            _BorderRadius: 5,
            _BorderWidth: 1,
            _Extent: lively.pt(84.0,24.0),
            _Position: lively.pt(94.0,282.0),
            className: "lively.morphic.Button",
            doNotCopyProperties: [],
            doNotSerialize: [],
            isPressed: false,
            label: "Private",
            name: "PrivateButton",
            sourceModule: "lively.morphic.Widgets",
            submorphs: [],
            toggle: false,
            value: false,
            connectionRebuilder: function connectionRebuilder() {
            lively.bindings.connect(this, "fire", this.get("PublishToInventoryPane"), "selectVisibility", {
                converter: function() { return "private"; }
            });
        }
        },{
            _BorderColor: Color.rgb(180,180,180),
            _BorderRadius: 5,
            _BorderWidth: 1,
            _Extent: lively.pt(76.0,24.0),
            _Position: lively.pt(186.0,282.0),
            className: "lively.morphic.Button",
            doNotCopyProperties: [],
            doNotSerialize: [],
            isPressed: false,
            label: "Shared",
            name: "SharedButton",
            sourceModule: "lively.morphic.Widgets",
            submorphs: [],
            toggle: false,
            value: false,
            connectionRebuilder: function connectionRebuilder() {
            lively.bindings.connect(this, "fire", this.get("PublishToInventoryPane"), "selectVisibility", {
                converter: function() { return "shared"; }
            });
        }
        },{
            _Extent: lively.pt(340.0,16.0),
            _FontFamily: "Arial, sans-serif",
            _FontSize: 11,
            _Padding: lively.rect(4,3,0,0),
            _Position: lively.pt(10.0,318.0),
            _InputAllowed: false,
            allowInput: false,
            className: "lively.morphic.Text",
            droppingEnabled: false,
            fixedWidth: true,
            grabbingEnabled: false,
            name: "RecipientsLabel",
            sourceModule: "lively.morphic.TextCore",
            submorphs: [],
            textString: "Recipients (comma-separated handles)"
        },{
            _BorderColor: Color.rgb(203,203,203),
            _BorderRadius: 3.75,
            _BorderWidth: 1,
            _ClipMode: "hidden",
            _Extent: lively.pt(354.0,22.0),
            _Fill: Color.rgb(255,255,255),
            _FontFamily: "Helvetica",
            _Padding: lively.rect(4,4,0,0),
            _Position: lively.pt(10.0,340.0),
            allowInput: true,
            className: "lively.morphic.Text",
            doNotSerialize: ["charsTyped"],
            evalEnabled: false,
            fixedHeight: true,
            fixedWidth: true,
            isInputLine: true,
            layout: {
                resizeWidth: true
            },
            name: "RecipientsText",
            sourceModule: "lively.morphic.TextCore",
            submorphs: [],
            textString: ""
        },{
            _Extent: lively.pt(354.0,18.0),
            _FontFamily: "Arial, sans-serif",
            _FontSize: 11,
            _Padding: lively.rect(4,3,0,0),
            _Position: lively.pt(10.0,318.0),
            _InputAllowed: false,
            allowInput: false,
            className: "lively.morphic.Text",
            droppingEnabled: false,
            fixedWidth: true,
            grabbingEnabled: false,
            name: "StatusText",
            sourceModule: "lively.morphic.TextCore",
            submorphs: [],
            textColor: Color.rgb(153,153,153),
            textString: ""
        },{
            _BorderColor: Color.rgb(214,214,214),
            _BorderRadius: 5,
            _BorderWidth: 1,
            _Extent: lively.pt(80.0,24.0),
            _Position: lively.pt(204.0,346.0),
            className: "lively.morphic.Button",
            doNotCopyProperties: [],
            doNotSerialize: [],
            isPressed: false,
            label: "cancel",
            name: "CancelButton",
            sourceModule: "lively.morphic.Widgets",
            submorphs: [],
            toggle: false,
            value: false,
            connectionRebuilder: function connectionRebuilder() {
            lively.bindings.connect(this, "fire", this.get("PublishToInventoryPane"), "onCancel", {});
        }
        },{
            _BorderColor: Color.rgb(150,214,150),
            _BorderRadius: 5.2,
            _BorderWidth: 1.184,
            _Extent: lively.pt(80.0,24.0),
            _Fill: Color.rgb(239,255,239),
            _Position: lively.pt(288.0,346.0),
            className: "lively.morphic.Button",
            doNotCopyProperties: [],
            doNotSerialize: [],
            isPressed: false,
            label: "publish",
            name: "PublishButton",
            sourceModule: "lively.morphic.Widgets",
            submorphs: [],
            toggle: false,
            value: false,
            connectionRebuilder: function connectionRebuilder() {
            lively.bindings.connect(this, "fire", this.get("PublishToInventoryPane"), "onPublish", {});
        }
        }],
        target: null,
        visibility: "public",
        withLayers: "[GrabbingLayer]",
        // Layout anchors for the footer (status text + Cancel/Publish),
        // which shifts down to make room when the Recipients field is
        // shown (Shared) and back up when it's hidden (Public/Private) --
        // see selectVisibility. Keeping these as named constants rather
        // than recomputing from sibling bounds each time, since several of
        // the fields they'd be computed from are themselves conditionally
        // hidden.
        footerYCompact: 318,
        footerYExpanded: 374,
        buttonsYCompact: 346,
        buttonsYExpanded: 402,
        contentHeightCompact: 384,
        contentHeightExpanded: 440,
        onCancel: function onCancel() {
        this.owner.remove();
    },
        onRemove: function onRemove() {
        $world.publishToInventoryDialog && $world.publishToInventoryDialog.remove();
    },
        reset: function reset() {
        this.setTarget(null);
    },
        setStatus: function setStatus(text, isError) {
        var t = this.get('StatusText');
        t.textString = text || '';
        t.setTextColor(isError ? Color.rgb(204,51,51) : Color.rgb(153,153,153));
    },
        setTarget: function setTarget(morph) {
        this.target = morph;
        // A morph opened from Inventory (or already published once this
        // session) carries its originating envelope -- see Inventory.js's
        // _openEnvelope and PartsBin.js's _publishToInventoryImpl, both of
        // which stash morph._inventoryEnvelope + doNotSerialize. When
        // present, this republish continues that objId's version chain
        // (prevCid) instead of minting a new genesis object -- prefill the
        // form from its last-known state so the user isn't retyping
        // metadata that's already on record.
        var prevEnvelope = (morph && morph._inventoryEnvelope) || null;
        this.prevEnvelope = prevEnvelope;
        var prevState = (prevEnvelope && prevEnvelope.state) || null;
        this.get('NameText').textString = prevState ? (prevState.partName || morph.name) : (morph ? morph.name : '');
        this.get('CommentText').textString = (prevState && prevState.comment) || '';
        var chooser = this.get('CategoryChooser');
        // A leading placeholder entry (value: null) so the rendered native
        // <select> visually matches the logical "nothing chosen yet" state
        // -- confirmed live that a plain DropDownList with no selection
        // (selectedLineNo:-1) still visually displays its first real item
        // as if selected, which would silently mismatch onPublish's
        // required-category check (a user could click Publish believing
        // the visibly-shown first category was already chosen).
        var categoryNames = lively.identity.PartSerializer.CATEGORY_NAMES;
        chooser.setList([{ isListItem: true, string: '— Select a category —', value: null }].concat(
            categoryNames.map(function(name) {
                return { isListItem: true, string: name, value: name };
            })
        ));
        var prevCategoryIdx = prevState && prevState.category ? categoryNames.indexOf(prevState.category) : -1;
        chooser.selectAt(prevCategoryIdx === -1 ? 0 : prevCategoryIdx + 1);
        this.get('TagsText').textString = (prevState && prevState.tags) ? prevState.tags.join(', ') : '';
        // Recipient handles are never persisted in the envelope (only each
        // recipient's DID/sealed key is) -- a "shared" republish still
        // needs the user to re-enter handles, same as a first-time publish.
        this.get('RecipientsText').textString = '';
        this.setStatus(prevEnvelope
            ? ('Updating published item "' + (prevState && prevState.partName || morph.name) + '".')
            : '');
        this.selectVisibility((prevEnvelope && prevEnvelope.visibility) || 'public');
    },
        // Manual 3-way radio group -- Lively has no built-in RadioButton
        // widget, so each of the three buttons just connects its 'fire' to
        // this with a converter supplying its own value (see
        // connectionRebuilder on each button above); this restyles all
        // three to reflect whichever was clicked, shows/hides the
        // Recipients field, and slides the footer (status text + Cancel/
        // Publish) up or down to close the gap the Recipients field would
        // otherwise leave behind when hidden, resizing the dialog to match
        // so there's no dead space below the buttons either.
        selectVisibility: function selectVisibility(v) {
        this.visibility = v;
        var selectedFill = Color.rgb(204,229,255), selectedBorder = Color.rgb(51,122,204);
        var normalFill = Color.rgb(243,243,243), normalBorder = Color.rgb(180,180,180);
        [['PublicButton','public'],['PrivateButton','private'],['SharedButton','shared']].forEach(function(pair) {
            var btn = this.get(pair[0]);
            var isSelected = pair[1] === v;
            btn.setFill(isSelected ? selectedFill : normalFill);
            btn.setBorderColor(isSelected ? selectedBorder : normalBorder);
        }, this);

        var showRecipients = v === 'shared';
        this.get('RecipientsLabel').setVisible(showRecipients);
        this.get('RecipientsText').setVisible(showRecipients);

        var footerY = showRecipients ? this.footerYExpanded : this.footerYCompact;
        var buttonsY = showRecipients ? this.buttonsYExpanded : this.buttonsYCompact;
        var contentHeight = showRecipients ? this.contentHeightExpanded : this.contentHeightCompact;

        this.get('StatusText').setPosition(pt(10, footerY));
        this.get('CancelButton').setPosition(pt(204, buttonsY));
        this.get('PublishButton').setPosition(pt(288, buttonsY));

        this.setExtent(pt(this.getExtent().x, contentHeight));
        var win = this.owner;
        if (win && win.setExtent) {
            win.setExtent(pt(win.getExtent().x, contentHeight + win.contentOffset.y + 3));
        }
    },
        onPublish: function onPublish() {
        if (!this.target) { this.setStatus('No target to publish', true); return; }
        var name = this.get('NameText').textString.trim();
        if (!name) { this.setStatus('Name is required', true); return; }
        var category = this.get('CategoryChooser').selection;
        if (!category) { this.setStatus('Category is required', true); return; }
        var tagsRaw = this.get('TagsText').textString.trim();
        var tags = tagsRaw ? tagsRaw.split(',').map(function(t) { return t.trim().replace(/^#/, ''); }).filter(Boolean) : [];
        var recipientHandles = this.visibility === 'shared'
            ? this.get('RecipientsText').textString.split(',').map(function(h) { return h.trim().replace(/^@/, ''); }).filter(Boolean)
            : [];
        if (this.visibility === 'shared' && !recipientHandles.length) {
            this.setStatus('Enter at least one recipient handle', true);
            return;
        }

        var self = this, target = this.target;
        this.get('PublishButton').disable && this.get('PublishButton').disable();
        this.get('CancelButton').disable && this.get('CancelButton').disable();
        this.setStatus('Publishing…');

        if (name !== target.name) target.setName(name);

        target._publishToInventory({
            name: name,
            comment: this.get('CommentText').textString,
            category: category,
            tags: tags,
            visibility: this.visibility,
            recipientHandles: recipientHandles,
            prevEnvelope: this.prevEnvelope || null,
            onWaiting: function() { self.setStatus('Confirm passkey…'); },
        }, function(err) {
            self.get('PublishButton').enable && self.get('PublishButton').enable();
            self.get('CancelButton').enable && self.get('CancelButton').enable();
            if (err) { self.setStatus(err.message || 'Publish failed', true); return; }
            self.setStatus('Published "' + name + '" to Inventory.');
            (function() { self.owner.remove(); }).delay(0.9);
        });
    }
    }],
    titleBar: "Publish to Inventory",
    connectionRebuilder: function connectionRebuilder() {
    lively.bindings.connect(this, "remove", this.get("PublishToInventoryPane"), "onRemove", {});
}
});

}) // end of module
