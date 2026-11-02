module('lively.ide.tools.WorldThemeDialog').requires('lively.persistence.BuildSpec', 'lively.morphic.ColorChooserDraft').toRun(function() {

// A simple, end-user-facing front door onto the same world.setStyleSheet()
// machinery that the raw "Edit world CSS" tool (WorldCSSEditor.js) exposes --
// pick a background/accent/cursor/font instead of typing CSS by hand. Apply
// composes a plain CSS string and calls world.setStyleSheet(css), exactly
// what WorldCSSEditor's own Apply button does, so the two tools stay
// consistent (reopening "Edit world CSS" afterward shows the generated text).

lively.BuildSpec("lively.ide.tools.WorldThemeDialog", {
    _BorderRadius: 7,
    _Extent: lively.pt(360.0,398.0),
    _Fill: Color.rgb(90,60,180),
    className: "lively.morphic.Window",
    name: "WorldThemeDialog",
    sourceModule: "lively.ide.tools.WorldThemeDialog",
    contentOffset: lively.pt(3.0,22.0),
    draggingEnabled: true,
    layout: {
        adjustForNewBounds: true
    },
    minExtent: lively.pt(360.0,398.0),
    submorphs: [{
        _BorderColor: Color.rgb(95,94,95),
        _BorderRadius: 4,
        _Extent: lively.pt(354.0,373.0),
        _Fill: Color.rgb(243,243,243),
        _Position: lively.pt(3.0,23.0),
        className: "lively.morphic.Box",
        layout: {
            adjustForNewBounds: true,
            resizeWidth: true
        },
        name: "WorldThemePane",
        sourceModule: "lively.morphic.Core",
        submorphs: [{
            _Extent: lively.pt(200.0,16.0),
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
            name: "BackgroundLabel",
            sourceModule: "lively.morphic.TextCore",
            submorphs: [],
            textString: "Background"
        },{
            _BorderColor: Color.rgb(200,200,200),
            _BorderRadius: 5,
            _BorderWidth: 1,
            _Extent: lively.pt(50.0,30.0),
            _Fill: Color.rgb(27,16,51),
            _Position: lively.pt(10.0,26.0),
            className: "lively.morphic.Button",
            isPressed: false,
            label: "",
            name: "PresetSunset",
            sourceModule: "lively.morphic.Widgets",
            submorphs: [],
            toggle: false,
            value: false,
            presetName: "sunset",
            presetCss: "linear-gradient(160deg, #1b1033, #3a1c71, #d76d77, #ffaf7b)",
            connectionRebuilder: function connectionRebuilder() {
            lively.bindings.connect(this, "fire", this.get("WorldThemePane"), "selectPresetButton", {converter: function() { return this.sourceObj; }});
        }
        },{
            _BorderColor: Color.rgb(200,200,200),
            _BorderRadius: 5,
            _BorderWidth: 1,
            _Extent: lively.pt(50.0,30.0),
            _Fill: Color.rgb(32,58,67),
            _Position: lively.pt(66.0,26.0),
            className: "lively.morphic.Button",
            isPressed: false,
            label: "",
            name: "PresetOcean",
            sourceModule: "lively.morphic.Widgets",
            submorphs: [],
            toggle: false,
            value: false,
            presetName: "ocean",
            presetCss: "linear-gradient(135deg, #0f2027, #203a43, #2c5364)",
            connectionRebuilder: function connectionRebuilder() {
            lively.bindings.connect(this, "fire", this.get("WorldThemePane"), "selectPresetButton", {converter: function() { return this.sourceObj; }});
        }
        },{
            _BorderColor: Color.rgb(200,200,200),
            _BorderRadius: 5,
            _BorderWidth: 1,
            _Extent: lively.pt(50.0,30.0),
            _Fill: Color.rgb(255,154,158),
            _Position: lively.pt(122.0,26.0),
            className: "lively.morphic.Button",
            isPressed: false,
            label: "",
            name: "PresetBubblegum",
            sourceModule: "lively.morphic.Widgets",
            submorphs: [],
            toggle: false,
            value: false,
            presetName: "bubblegum",
            presetCss: "linear-gradient(135deg, #ff9a9e, #fad0c4, #a18cd1)",
            connectionRebuilder: function connectionRebuilder() {
            lively.bindings.connect(this, "fire", this.get("WorldThemePane"), "selectPresetButton", {converter: function() { return this.sourceObj; }});
        }
        },{
            _BorderColor: Color.rgb(200,200,200),
            _BorderRadius: 5,
            _BorderWidth: 1,
            _Extent: lively.pt(50.0,30.0),
            _Fill: Color.rgb(113,178,128),
            _Position: lively.pt(178.0,26.0),
            className: "lively.morphic.Button",
            isPressed: false,
            label: "",
            name: "PresetForest",
            sourceModule: "lively.morphic.Widgets",
            submorphs: [],
            toggle: false,
            value: false,
            presetName: "forest",
            presetCss: "linear-gradient(160deg, #134e5e, #71b280)",
            connectionRebuilder: function connectionRebuilder() {
            lively.bindings.connect(this, "fire", this.get("WorldThemePane"), "selectPresetButton", {converter: function() { return this.sourceObj; }});
        }
        },{
            _BorderColor: Color.rgb(200,200,200),
            _BorderRadius: 5,
            _BorderWidth: 1,
            _Extent: lively.pt(50.0,30.0),
            _Fill: Color.rgb(244,244,244),
            _Position: lively.pt(234.0,26.0),
            className: "lively.morphic.Button",
            isPressed: false,
            label: "",
            name: "PresetClassic",
            sourceModule: "lively.morphic.Widgets",
            submorphs: [],
            toggle: false,
            value: false,
            presetName: "classic",
            presetCss: null,
            connectionRebuilder: function connectionRebuilder() {
            lively.bindings.connect(this, "fire", this.get("WorldThemePane"), "selectPresetButton", {converter: function() { return this.sourceObj; }});
        }
        },{
            _BorderColor: Color.rgb(214,214,214),
            _BorderRadius: 5,
            _BorderWidth: 1,
            _Extent: lively.pt(120.0,22.0),
            _Position: lively.pt(10.0,64.0),
            className: "lively.morphic.Button",
            isPressed: false,
            label: "Custom image...",
            name: "CustomImageButton",
            sourceModule: "lively.morphic.Widgets",
            submorphs: [],
            toggle: false,
            value: false,
            connectionRebuilder: function connectionRebuilder() {
            lively.bindings.connect(this, "fire", this.get("WorldThemePane"), "onPickImage", {});
        }
        },{
            _BorderColor: Color.rgb(204,0,0),
            _Extent: lively.pt(12.0,12.0),
            _Position: lively.pt(140.0,68.0),
            checked: false,
            className: "lively.morphic.CheckBox",
            droppingEnabled: true,
            name: "TileCheckBox",
            sourceModule: "lively.morphic.Widgets"
        },{
            _Extent: lively.pt(170.0,16.0),
            _FontFamily: "Arial, sans-serif",
            _FontSize: 11,
            _Padding: lively.rect(4,3,0,0),
            _Position: lively.pt(156.0,65.0),
            _InputAllowed: false,
            allowInput: false,
            className: "lively.morphic.Text",
            droppingEnabled: false,
            fixedWidth: true,
            grabbingEnabled: false,
            name: "TileLabel",
            sourceModule: "lively.morphic.TextCore",
            submorphs: [],
            textString: "Tile image"
        },{
            _BorderColor: Color.rgb(214,214,214),
            _BorderRadius: 4,
            _BorderWidth: 1,
            _Extent: lively.pt(334.0,46.0),
            _Fill: Color.rgb(27,16,51),
            _Position: lively.pt(10.0,94.0),
            className: "lively.morphic.Box",
            droppingEnabled: false,
            grabbingEnabled: false,
            name: "PreviewBox",
            sourceModule: "lively.morphic.Core",
            submorphs: [{
                _Extent: lively.pt(300.0,16.0),
                _FontFamily: "Arial, sans-serif",
                _FontSize: 10,
                _Padding: lively.rect(4,3,0,0),
                _Position: lively.pt(8.0,15.0),
                _InputAllowed: false,
                _TextColor: Color.white,
                allowInput: false,
                className: "lively.morphic.Text",
                droppingEnabled: false,
                eventsAreIgnored: true,
                fixedWidth: true,
                grabbingEnabled: false,
                name: "PreviewLabel",
                sourceModule: "lively.morphic.TextCore",
                submorphs: [],
                textString: "Preview"
            }]
        },{
            _Extent: lively.pt(90.0,16.0),
            _FontFamily: "Arial, sans-serif",
            _FontSize: 11,
            _Padding: lively.rect(4,3,0,0),
            _Position: lively.pt(10.0,152.0),
            _InputAllowed: false,
            allowInput: false,
            className: "lively.morphic.Text",
            droppingEnabled: false,
            fixedWidth: true,
            grabbingEnabled: false,
            name: "AccentLabel",
            sourceModule: "lively.morphic.TextCore",
            submorphs: [],
            textString: "Accent color"
        },{
            _BorderColor: Color.rgb(200,200,200),
            _BorderRadius: 4,
            _BorderWidth: 1,
            _Extent: lively.pt(28.0,20.0),
            _Fill: Color.rgb(255,220,0),
            _Position: lively.pt(110.0,150.0),
            className: "lively.morphic.Button",
            isPressed: false,
            label: "",
            name: "AccentSwatch",
            sourceModule: "lively.morphic.Widgets",
            submorphs: [],
            toggle: false,
            value: false,
            connectionRebuilder: function connectionRebuilder() {
            lively.bindings.connect(this, "fire", this.get("WorldThemePane"), "onPickAccentColor", {});
        }
        },{
            _Extent: lively.pt(60.0,16.0),
            _FontFamily: "Arial, sans-serif",
            _FontSize: 11,
            _Padding: lively.rect(4,3,0,0),
            _Position: lively.pt(10.0,184.0),
            _InputAllowed: false,
            allowInput: false,
            className: "lively.morphic.Text",
            droppingEnabled: false,
            fixedWidth: true,
            grabbingEnabled: false,
            name: "CursorLabel",
            sourceModule: "lively.morphic.TextCore",
            submorphs: [],
            textString: "Cursor"
        },{
            _BorderColor: Color.rgb(203,203,203),
            _BorderRadius: 3.75,
            _BorderWidth: 1,
            _ClipMode: "hidden",
            _Extent: lively.pt(160.0,22.0),
            _Fill: Color.rgb(255,255,255),
            _FontFamily: "Helvetica",
            _FontSize: 10,
            _Position: lively.pt(80.0,180.0),
            _StyleClassNames: ["Morph","Box","OldList","DropDownList"],
            changeTriggered: false,
            className: "lively.morphic.DropDownList",
            droppingEnabled: false,
            itemList: ["auto","default","crosshair","pointer","move","text","wait","help","progress"],
            name: "CursorList",
            selection: "auto",
            selectedLineNo: 0,
            sourceModule: "lively.morphic.Lists",
            submorphs: []
        },{
            _Extent: lively.pt(60.0,16.0),
            _FontFamily: "Arial, sans-serif",
            _FontSize: 11,
            _Padding: lively.rect(4,3,0,0),
            _Position: lively.pt(10.0,214.0),
            _InputAllowed: false,
            allowInput: false,
            className: "lively.morphic.Text",
            droppingEnabled: false,
            fixedWidth: true,
            grabbingEnabled: false,
            name: "FontLabel",
            sourceModule: "lively.morphic.TextCore",
            submorphs: [],
            textString: "Font"
        },{
            _BorderColor: Color.rgb(203,203,203),
            _BorderRadius: 3.75,
            _BorderWidth: 1,
            _ClipMode: "hidden",
            _Extent: lively.pt(200.0,22.0),
            _Fill: Color.rgb(255,255,255),
            _FontFamily: "Helvetica",
            _FontSize: 10,
            _Position: lively.pt(80.0,210.0),
            _StyleClassNames: ["Morph","Box","OldList","DropDownList"],
            changeTriggered: false,
            className: "lively.morphic.DropDownList",
            droppingEnabled: false,
            itemList: ["Helvetica","Arial","Georgia","Courier New","Verdana","Comic Sans MS","Papyrus","Impact"],
            name: "FontList",
            selection: "Helvetica",
            selectedLineNo: 0,
            sourceModule: "lively.morphic.Lists",
            submorphs: []
        },{
            _Extent: lively.pt(300.0,16.0),
            _FontFamily: "Arial, sans-serif",
            _FontSize: 10,
            _Padding: lively.rect(4,3,0,0),
            _Position: lively.pt(10.0,246.0),
            _TextColor: Color.rgb(153,153,153),
            _InputAllowed: false,
            allowInput: false,
            className: "lively.morphic.Text",
            droppingEnabled: false,
            fixedWidth: true,
            grabbingEnabled: false,
            name: "StatusText",
            sourceModule: "lively.morphic.TextCore",
            submorphs: [],
            textString: ""
        },{
            _BorderColor: Color.rgb(214,214,214),
            _BorderRadius: 5,
            _BorderWidth: 1,
            _Extent: lively.pt(120.0,22.0),
            _Position: lively.pt(10.0,336.0),
            className: "lively.morphic.Button",
            isPressed: false,
            label: "Edit CSS directly",
            name: "EditCssButton",
            sourceModule: "lively.morphic.Widgets",
            submorphs: [],
            toggle: false,
            value: false,
            connectionRebuilder: function connectionRebuilder() {
            lively.bindings.connect(this, "fire", this.get("WorldThemePane"), "onEditCss", {});
        }
        },{
            _BorderColor: Color.rgb(214,214,214),
            _BorderRadius: 5,
            _BorderWidth: 1,
            _Extent: lively.pt(70.0,24.0),
            _Position: lively.pt(194.0,335.0),
            className: "lively.morphic.Button",
            isPressed: false,
            label: "Close",
            name: "CloseButton",
            sourceModule: "lively.morphic.Widgets",
            submorphs: [],
            toggle: false,
            value: false,
            connectionRebuilder: function connectionRebuilder() {
            lively.bindings.connect(this, "fire", this.get("WorldThemePane"), "onClose", {});
        }
        },{
            _BorderColor: Color.rgb(150,214,150),
            _BorderRadius: 5.2,
            _BorderWidth: 1.184,
            _Extent: lively.pt(70.0,24.0),
            _Fill: Color.rgb(239,255,239),
            _Position: lively.pt(274.0,335.0),
            className: "lively.morphic.Button",
            isPressed: false,
            label: "Apply",
            name: "ApplyButton",
            sourceModule: "lively.morphic.Widgets",
            submorphs: [],
            toggle: false,
            value: false,
            connectionRebuilder: function connectionRebuilder() {
            lively.bindings.connect(this, "fire", this.get("WorldThemePane"), "onApply", {});
        }
        }],

        selectedBackground: {type: "preset", name: "sunset", css: "linear-gradient(160deg, #1b1033, #3a1c71, #d76d77, #ffaf7b)"},
        accentColor: Color.rgb(255,220,0),

        updatePreview: function updatePreview() {
            var box = this.get('PreviewBox'),
                node = box.renderContext().shapeNode,
                bg = this.selectedBackground;
            if (bg && bg.type === 'image') {
                node.style.backgroundImage = "url('" + bg.css + "')";
                node.style.backgroundRepeat = this.get('TileCheckBox').checked ? 'repeat' : 'no-repeat';
                node.style.backgroundSize = this.get('TileCheckBox').checked ? 'auto' : 'cover';
                node.style.backgroundColor = '';
            } else if (bg && bg.css) {
                node.style.backgroundImage = bg.css;
                node.style.backgroundRepeat = '';
                node.style.backgroundSize = '';
                node.style.backgroundColor = '';
            } else {
                node.style.backgroundImage = '';
                node.style.backgroundColor = 'rgb(244,244,244)';
            }
        },

        selectPresetButton: function selectPresetButton(btn) {
            this.selectedBackground = btn.presetCss ?
                {type: 'preset', name: btn.presetName, css: btn.presetCss} :
                {type: 'preset', name: btn.presetName, css: null};
            this.setStatus('Background set to "' + btn.presetName + '".');
            this.updatePreview();
        },

        onPickImage: function onPickImage() {
            var self = this,
                input = document.createElement('input');
            input.type = 'file';
            input.accept = 'image/*';
            input.style.display = 'none';
            document.body.appendChild(input);
            input.addEventListener('change', function() {
                var file = input.files && input.files[0];
                document.body.removeChild(input);
                if (!file) return;
                self.setStatus('Uploading...');
                var ext = (file.name.match(/\.[^.]+$/) || [''])[0];
                lively.identity.fileCrypto.encryptAndUpload(file, {
                    visibility: 'public',
                    name: 'world-bg-' + Date.now() + ext,
                    onWaiting: function() { self.setStatus('Confirm passkey…'); }
                }, function(err, result) {
                    if (err) {
                        self.setStatus(err.message || 'Upload failed', true);
                        return;
                    }
                    self.selectedBackground = {type: 'image', css: result.url};
                    self.setStatus('Custom image selected.');
                    self.updatePreview();
                });
            });
            input.click();
        },

        onPickAccentColor: function onPickAccentColor() {
            var self = this,
                swatch = this.get('AccentSwatch'),
                picker = new lively.morphic.AwesomeColorPicker(),
                pos = swatch.getGlobalTransform().transformPoint(swatch.innerBounds().bottomLeft());
            picker.open(this.world(), pos);
            lively.bindings.connect(picker, 'color', this, 'onAccentColorChosen');
        },

        onAccentColorChosen: function onAccentColorChosen(color) {
            this.accentColor = color;
            var node = this.get('AccentSwatch').renderContext().shapeNode;
            node.style.background = color.toString();
        },

        onEditCss: function onEditCss() {
            this.world().openWorldCSSEditor();
        },

        onClose: function onClose() {
            this.owner.remove();
        },

        onRemove: function onRemove() {
            if ($world && $world.worldThemeDialog === this.owner) $world.worldThemeDialog = null;
        },

        setStatus: function setStatus(text, isError) {
            var t = this.get('StatusText');
            t.textString = text || '';
            t.setTextColor(isError ? Color.rgb(204,51,51) : Color.rgb(153,153,153));
        },

        generateCss: function generateCss() {
            var bg = this.selectedBackground,
                cursor = this.get('CursorList').selection,
                font = this.get('FontList').selection,
                accent = this.accentColor,
                lines = [];

            lines.push('/* Generated by Customize My World */');
            lines.push('.World {');
            if (bg && bg.type === 'image') {
                lines.push('\tbackground-image: url(\'' + bg.css + '\') !important;');
                lines.push('\tbackground-repeat: ' + (this.get('TileCheckBox').checked ? 'repeat' : 'no-repeat') + ' !important;');
                if (!this.get('TileCheckBox').checked) {
                    lines.push('\tbackground-size: cover !important;');
                }
            } else if (bg && bg.css) {
                lines.push('\tbackground-image: ' + bg.css + ' !important;');
            } else {
                lines.push('\tbackground-image: none !important;');
            }
            lines.push('\tcursor: ' + cursor + ' !important;');
            lines.push('\tfont-family: "' + font + '" !important;');
            lines.push('}');
            lines.push('.World .Button:hover {');
            lines.push('\tbackground-color: ' + accent.toString() + ' !important;');
            lines.push('}');
            return lines.join('\n');
        },

        onApply: function onApply() {
            var world = this.world();
            if (!world || !world.cssIsEnabled) {
                this.setStatus('StyleSheets module is not loaded.', true);
                return;
            }
            world.setStyleSheet(this.generateCss());
            this.setStatus('Applied to your world.');
        },

        onFromBuildSpecCreated: function onFromBuildSpecCreated() {
            this.updatePreview();
        }
    }],
    titleBar: "Customize My World",
    connectionRebuilder: function connectionRebuilder() {
    lively.bindings.connect(this, "remove", this.get("WorldThemePane"), "onRemove", {});
}
});

}) // end of module
