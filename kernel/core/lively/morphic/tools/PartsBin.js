module('lively.morphic.tools.PartsBin').requires('lively.persistence.BuildSpec', 'lively.PartsBin').toRun(function() {

lively.BuildSpec('lively.morphic.tools.PartsBin', {
    _BorderColor: Color.rgb(204,0,0),
    _Extent: lively.pt(838.0,520.2),
    _Position: lively.pt(251.0,241.4),
    _StyleClassNames: ["Morph","Window"],
    cameForward: false,
    className: "lively.morphic.Window",
    contentOffset: lively.pt(4.0,22.0),
    draggingEnabled: true,
    highlighted: false,
    layout: {
        adjustForNewBounds: true
    },
    name: "PartsBinBrowser",
    sourceModule: "lively.morphic.Widgets",
    submorphs: [{
        _BorderColor: Color.rgb(95,94,95),
        _Extent: lively.pt(830.2,494.2),
        _Fill: Color.rgba(245,245,245,0),
        _Position: lively.pt(4.0,22.0),
        _StyleClassNames: ["Morph","Box"],
        _StyleSheet: ".MorphList {\n\
    	overflow-y: scroll;\n\
    	overflow-x: hidden;\n\
    }\n\
    \n\
    .MorphList .selected {\n\
    	outline: 0px;\n\
    	background-color: rgb(42, 87, 192) !important;\n\
    }\n\
    \n\
    .MorphList .selected span {\n\
    	color: white !important;\n\
    }",
        allItemURLS: [],
        allURLs: [],
        borderWidth: 1,
        className: "lively.morphic.Box",
        connections: {
            toggleMorePane: {}
        },
        doNotSerialize: ["categories"],
        isCopyMorphRef: true,
        layout: {
            adjustForNewBounds: true,
            borderSize: 6.615,
            resizeHeight: true,
            resizeWidth: true,
            spacing: 3,
            type: "lively.morphic.Layout.HorizontalLayout"
        },
        minExtent: lively.pt(474.0,244.2),
        moreToggled: false,
        morphRefId: 1,
        name: "PartsBinBrowser",
        selectedPartItem: null,
        sourceModule: "lively.morphic.Core",
        submorphs: [{
            _BorderWidth: 0.74,
            _Extent: lively.pt(151.3,481.0),
            _Fill: Color.rgba(255,255,255,0),
            _Position: lively.pt(6.6,6.6),
            className: "lively.morphic.Box",
            droppingEnabled: false,
            isCopyMorphRef: true,
            layout: {
                borderSize: 0,
                extentWithoutPlaceholder: lively.pt(200.3,748.0),
                resizeHeight: true,
                resizeWidth: false,
                spacing: 9.26,
                type: "lively.morphic.Layout.VerticalLayout"
            },
            morphRefId: 1,
            name: "LeftSideContainer",
            sourceModule: "lively.morphic.Core",
            submorphs: [{
                _Extent: lively.pt(151.3,27.0),
                _Fill: Color.rgba(0,0,204,0),
                className: "lively.morphic.Box",
                droppingEnabled: false,
                layout: {
                    adjustForNewBounds: true,
                    centeredHorizontal: false,
                    centeredVertical: false,
                    layouter: undefined,
                    resizeWidth: true
                },
                name: "CategoryChooserContainer",
                sourceModule: "lively.morphic.Core",
                submorphs: [{
                    _ClipMode: "auto",
                    _Extent: lively.pt(151.3,17.0),
                    _Fill: Color.rgba(243,243,243,0),
                    _FontFamily: "Helvetica",
                    _FontSize: 10,
                    _Position: lively.pt(0.5,5.0),
                    _StyleClassNames: ["Morph","Box","OldList","DropDownList"],
                    changeTriggered: false,
                    className: "lively.morphic.DropDownList",
                    droppingEnabled: false,
                    layout: {
                        centeredHorizontal: true,
                        centeredVertical: true,
                        moveHorizontal: false,
                        resizeWidth: true
                    },
                    name: "PartsBinURLChooser",
                    selectOnMove: false,
                    selectedLineNo: -1,
                    sourceModule: "lively.morphic.Lists",
                    submorphs: [],
                    withoutLayers: [],
                    connectionRebuilder: function connectionRebuilder() {
                    lively.bindings.connect(this, "selection", this.get("PartsBinBrowser"), "setPartsBinURL", {});
                },
                    reset: function reset() {
                                        this.name = "PartsBinURLChooser";
                                    }
                }]
            },{
                _BorderWidth: 0.14800000000000002,
                _Extent: lively.pt(151.3,444.7),
                _Fill: Color.rgba(255,255,255,0),
                _Position: lively.pt(0.0,36.3),
                className: "lively.morphic.Box",
                droppingEnabled: false,
                layout: {
                    borderSize: 0,
                    resizeHeight: true,
                    resizeWidth: true,
                    spacing: 0,
                    type: "lively.morphic.Layout.VerticalLayout"
                },
                name: "CategoryListContainer",
                sourceModule: "lively.morphic.Core",
                submorphs: [{
                    _BorderColor: Color.rgb(210,210,210),
                    _Extent: lively.pt(151.3,27.0),
                    _Fill: Color.rgba(255,255,255,0),
                    className: "lively.morphic.Morph",
                    droppingEnabled: true,
                    layout: {
                        adjustForNewBounds: true,
                        resizeWidth: true
                    },
                    sourceModule: "lively.morphic.Core",
                    submorphs: [{
                        _BorderColor: Color.rgb(210,210,210),
                        _Extent: lively.pt(28.0,28.0),
                        _Fill: Color.rgb(204,204,204),
                        _Position: lively.pt(123.3,0.0),
                        _StyleClassNames: ["Morph","Button"],
                        className: "lively.morphic.Button",
                        isPressed: false,
                        label: "-",
                        layout: {
                            moveHorizontal: true
                        },
                        name: "removeCategoryButton",
                        sourceModule: "lively.morphic.Widgets",
                        style: {
                            borderRadius: 0,
                            padding: lively.rect(4,3,0,0)
                        },
                        toggle: false,
                        value: false,
                        withoutLayers: [],
                        connectionRebuilder: function connectionRebuilder() {
                        lively.bindings.connect(this, "fire", this, "onFire", {});
                    },
                        onFire: function onFire() {
                                                this.get('PartsBinBrowser').removeCategoryInteractively();
                                            }
                    },{
                        _BorderColor: Color.rgb(210,210,210),
                        _Extent: lively.pt(28.0,28.0),
                        _Fill: Color.rgb(204,204,204),
                        _Position: lively.pt(91.3,0.0),
                        _StyleClassNames: ["Morph","Button"],
                        className: "lively.morphic.Button",
                        isPressed: false,
                        label: "+",
                        layout: {
                            moveHorizontal: true
                        },
                        name: "addCategoryButton",
                        sourceModule: "lively.morphic.Widgets",
                        style: {
                            borderRadius: 0,
                            padding: lively.rect(4,3,0,0)
                        },
                        toggle: false,
                        value: false,
                        withoutLayers: [],
                        connectionRebuilder: function connectionRebuilder() {
                        lively.bindings.connect(this, "fire", this, "onFire", {});
                    },
                        onFire: function onFire() {
                                                this.get('PartsBinBrowser').addCategoryInteractively()
                                            }
                    },{
                        _BorderColor: Color.rgb(210,210,210),
                        _Extent: lively.pt(28.0,28.0),
                        _Fill: Color.rgb(204,204,204),
                        _StyleClassNames: ["Morph","Button","RectButton"],
                        className: "lively.morphic.Button",
                        isPressed: false,
                        label: "⟳",
                        name: "reloadButton",
                        sourceModule: "lively.morphic.Widgets",
                        style: {
                            borderRadius: 0,
                            padding: lively.rect(4,3,0,0)
                        },
                        value: false,
                        withoutLayers: [],
                        connectionRebuilder: function connectionRebuilder() {
                        lively.bindings.connect(this, "fire", this.get("PartsBinBrowser"), "reloadEverything", {});
                    }
                    }],
                    withoutLayers: []
                },{
                    _BorderColor: Color.rgb(210,210,210),
                    _ClipMode: {
                        x: "hidden",
                        y: "scroll"
                    },
                    _Extent: lively.pt(151.3,417.7),
                    _Fill: Color.rgb(255,255,255),
                    _Position: lively.pt(0.0,27.0),
                    _StyleClassNames: ["Morph","Box","List"],
                    _StyleSheet: ".List {\n\
                	border-width: 1px;\n\
                }",
                    className: "lively.morphic.List",
                    layout: {
                        adjustForNewBounds: true,
                        extent: lively.pt(151.3,417.7),
                        listItemHeight: 19,
                        maxExtent: lively.pt(151.3,417.7),
                        maxListItems: 22,
                        noOfCandidatesShown: 1,
                        padding: 0,
                        resizeHeight: true,
                        resizeWidth: true
                    },
                    name: "categoryList",
                    sourceModule: "lively.morphic.Lists",
                    submorphs: [{
                        _BorderColor: null,
                        _Extent: lively.pt(151.3,4.0),
                        className: "lively.morphic.Box",
                        droppingEnabled: true,
                        halosEnabled: false,
                        layout: {
                            adjustForNewBounds: true,
                            resizeWidth: true
                        },
                        sourceModule: "lively.morphic.Core",
                        submorphs: [],
                        withoutLayers: []
                    }],
                    withoutLayers: [],
                    connectionRebuilder: function connectionRebuilder() {
                    lively.bindings.connect(this, "selection", this.get("PartsBinBrowser"), "categoryName", {});
                }
                }],
                withoutLayers: []
            }],
            withoutLayers: []
        },{
            _BorderColor: null,
            _Extent: lively.pt(2.0,481.0),
            _Fill: Color.rgb(204,204,204),
            _Position: lively.pt(160.9,6.6),
            className: "lively.morphic.VerticalDivider",
            draggingEnabled: true,
            droppingEnabled: true,
            fixed: [],
            layout: {
                resizeHeight: true
            },
            minWidth: 92,
            name: "LeftRightDivider",
            oldPoint: lively.pt(767.0,279.0),
            pointerConnection: null,
            scalingLeft: "[<lively.morphic.Box#CDAB7... - LeftSideContainer>]",
            scalingRight: "[<lively.morphic.Box#518E8... - CategorieContainer>]",
            sourceModule: "lively.morphic.Widgets",
            submorphs: [],
            withoutLayers: []
        },{
            _Extent: lively.pt(657.7,481.0),
            _Fill: Color.rgba(255,255,255,0),
            _Position: lively.pt(165.9,6.6),
            className: "lively.morphic.Box",
            droppingEnabled: false,
            _ClipMode: "hidden",
            isCopyMorphRef: true,
            layout: {adjustForNewBounds: true, resizeHeight: true, resizeWidth: true},
            morphRefId: 2,
            name: "CategorieContainer",
            sourceModule: "lively.morphic.Core",
            submorphs: [{
                _Extent: lively.pt(658,473),
                _Fill: Color.rgba(255,255,255,0),
                className: "lively.morphic.Box",
                droppingEnabled: false,
                layout: {
                    borderSize: 0,
                    extentWithoutPlaceholder: lively.pt(1400,160),
                    resizeHeight: true,
                    resizeWidth: true,
                    spacing: 7,
                    type: "lively.morphic.Layout.VerticalLayout"
                },
                name: "CategoryContentContainer",
                sourceModule: "lively.morphic.Core",
                submorphs: [
                  lively.BuildSpec('lively.ide.tools.CommandLine').customize({
                    name: "searchText",
                    layout: {adjustForNewBounds: true, resizeHeight: false, resizeWidth: true},
                    _Extent: lively.pt(658,18),
                    labelString: "  ",
                    clearOnInput: false,
                    connectionRebuilder: function connectionRebuilder() {
                      lively.bindings.connect(this, "savedTextString", this.get("PartsBinBrowser"), "search", {});
                    }
                  }),
                  {
                    _BorderColor: Color.rgb(204,0,0),
                    _Extent: lively.pt(12.0,12.0),
                    _Position: lively.pt(2,2),
                    className: "lively.morphic.Image",
                    droppingEnabled: true,
                    isLayoutable: false,
                    url: "http://lively-web.org/core/media/halos/info.svg",
                },{
                    _BorderColor: Color.rgb(210,210,210),
                    _ClipMode: "auto",
                    _Extent: lively.pt(657.7,438.3),
                    _Fill: Color.rgb(255,255,255),
                    _Position: lively.pt(0.0,34.7),
                    className: "lively.morphic.Box",
                    droppingEnabled: false,
                    layout: {
                        resizeHeight: true,
                        resizeWidth: true
                    },
                    name: "partsBinContents",
                    selectedItem: "PartsItem(RhythmWheel,PartsSpace(PartsBin/Fun/))",
                    sourceModule: "lively.morphic.Core",
                    submorphs: [],
                    withoutLayers: [],
                    addPartItemAsync: function addPartItemAsync() {
                                        if (!this.partItemsToBeAdded || this.partItemsToBeAdded.length == 0) {
                                            this.stopAddingPartItemsAsync();
                                            return;
                                        }

                                        var partItem = this.partItemsToBeAdded.shift();
                                        var morph = partItem.asPartsBinItem();
                                        this.addMorph(morph);
                                        this.adjustForNewBounds()
                                    },
                    adjustForNewBounds: function adjustForNewBounds() {
                                        /*
                                            this.adjustForNewBounds()
                                        */
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
                    connectionRebuilder: function connectionRebuilder() {
                    lively.bindings.connect(this, "selectedItem", this.get("PartsBinBrowser"), "setSelectedPartItem", {});
                },
                    selectPartItem: function selectPartItem(item) {
                                        this.selectedItem = item && item.partItem;
                                        this.submorphs.without(item).invoke('showAsNotSelected');
                                    },
                    setExtent: function setExtent(point) {
                                        $super(point)
                                        this.adjustForNewBounds()
                                    },
                    startAddingPartItems: function startAddingPartItems(partItems) {
                                        this.partItemsToBeAdded = partItems.clone();
                                        this.startStepping(0, 'addPartItemAsync')
                                    },
                    stopAddingPartItemsAsync: function stopAddingPartItemsAsync() {
                                        this.stopStepping();
                                        delete this.partItemsToBeAdded;
                                    },
                    unselectAll: function unselectAll() {
                                        this.submorphs.invoke('showAsNotSelected');
                                    }
                }],
                withoutLayers: []
            },{
                _BorderColor: null,
                _Extent: lively.pt(657.7,2.0),
                _Fill: Color.rgb(204,204,204),
                _Position: lively.pt(0.0,476.0),
                className: "lively.morphic.HorizontalDivider",
                draggingEnabled: true,
                droppingEnabled: true,
                layout: {
                    adjustForNewBounds: true,
                    moveVertical: true,
                    resizeWidth: true
                },
                minHeight: -10,
                name: "MoreDivider",
                oldPoint: lively.pt(1685.0,977.0),
                pointerConnection: null,
                sourceModule: "lively.morphic.Widgets",
                submorphs: [{
                    _BorderColor: Color.rgb(204,204,204),
                    _Extent: lively.pt(59.8,30.0),
                    _Fill: Color.rgb(204,204,204),
                    _Position: lively.pt(590.2,-28.6),
                    _StyleClassNames: ["Morph","Button"],
                    className: "lively.morphic.Button",
                    droppingEnabled: false,
                    grabbingEnabled: false,
                    isPressed: false,
                    label: "more",
                    layout: {
                        moveHorizontal: true
                    },
                    name: "moreButton",
                    padding: lively.rect(5,0,0,0),
                    showsMorphMenu: true,
                    sourceModule: "lively.morphic.Widgets",
                    style: {
                        borderRadius: 0
                    },
                    value: false,
                    withoutLayers: [],
                    connectionRebuilder: function connectionRebuilder() {
                    lively.bindings.connect(this, "fire", this.get("PartsBinBrowser"), "toggleMorePane", {});
                }
                }],
                withoutLayers: [],
                movedVerticallyBy: function movedVerticallyBy(delta) {
                                $super(delta);
                                // toggle auto
                                  this.get('PartsBinBrowser').moreToggled =
                                    this.bounds().bottom() < this.get('CategorieContainer').innerBounds().bottom();
                            }
            },{
                _BorderColor: Color.rgb(204,204,204),
                _ClipMode: "hidden",
                _Extent: lively.pt(657.7,0.0),
                _Fill: Color.rgba(204,204,204,0),
                _Position: lively.pt(0.0,481.0),
                _StyleClassNames: ["Morph","Box"],
                _StyleSheet: " {\n\
            	border-width: 9px;\n\
            }",
                _Visible: true,
                className: "lively.morphic.Box",
                droppingEnabled: false,
                layout: {
                    adjustForNewBounds: true,
                    borderSize: 0,
                    extentWithoutPlaceholder: lively.pt(990.5,411.0),
                    moveHorizontal: false,
                    moveVertical: true,
                    resizeHeight: false,
                    resizeWidth: true,
                    spacing: 7.145,
                    type: "lively.morphic.Layout.VerticalLayout"
                },
                name: "MoreContainer",
                sourceModule: "lively.morphic.Core",
                submorphs: [{
                    _Extent: lively.pt(657.7,27.0),
                    _Fill: Color.rgba(255,255,255,0),
                    className: "lively.morphic.Box",
                    droppingEnabled: false,
                    layout: {
                        adjustForNewBounds: true,
                        borderSize: 0,
                        resizeHeight: false,
                        resizeWidth: true,
                        spacing: 6.615,
                        type: "lively.morphic.Layout.HorizontalLayout"
                    },
                    name: "MoreTitleContainer",
                    sourceModule: "lively.morphic.Core",
                    submorphs: [{
                        _ClipMode: "hidden",
                        _Extent: lively.pt(574.4,27.0),
                        _FontFamily: "Arial, sans-serif",
                        _FontSize: 14,
                        _HandStyle: "default",
                        _InputAllowed: false,
                        _IsSelectable: true,
                        _MaxTextWidth: 258,
                        _MinTextWidth: 258,
                        _Padding: lively.rect(0,2,0,0),
                        _Position: lively.pt(9.6,0.0),
                        _TextColor: Color.rgb(64,64,64),
                        allowInput: false,
                        className: "lively.morphic.Text",
                        emphasis: [[0,0,{}]],
                        eventsAreIgnored: true,
                        fixedHeight: true,
                        fixedWidth: true,
                        layout: {
                            centeredVertical: true,
                            resizeHeight: true,
                            resizeWidth: true
                        },
                        name: "selectedPartName",
                        sourceModule: "lively.morphic.TextCore",
                        submorphs: [],
                        withoutLayers: []
                    },

                    {
                        _Extent: lively.pt(67.0,15.0),
                        _FontFamily: "Arial, sans-serif",
                        _FontSize: 9,
                        _HandStyle: null,
                        _InputAllowed: false,
                        _IsSelectable: false,
                        _MaxTextWidth: 67,
                        _MinTextWidth: 67,
                        _Position: lively.pt(590.7,6.0),
                        _TextColor: Color.rgb(64,64,64),
                        className: "lively.morphic.Text",
                        emphasis: [[0,10,{
                            uri: "http://lively-web.org/viral.html?part=RhythmWheel&path=PartsBin%2FFun%2F"
                        }]],
                        fixedWidth: true,
                        layout: {
                            centeredVertical: true,
                            moveHorizontal: true,
                            moveVertical: false,
                            resizeHeight: false
                        },
                        name: "shareLink",
                        sourceModule: "lively.morphic.TextCore",
                        submorphs: [],
                        textString: "Share Link",
                        withoutLayers: []
                    },

                    {
                        _Position: lively.pt(510,6.0),
                        _Extent: lively.pt(50,15),
                        _HandStyle: null,
                        _InputAllowed: false,
                        _IsSelectable: false,
                        _FontFamily: "Arial, sans-serif",
                        _FontSize: 9,
                        className: "lively.morphic.Text",
                        emphasis: [[0, 7, {
                            doit: {code: "evt.getTargetMorph().get('PartsBinBrowser').openPartInspectorForSelection();",context: null},
                            color: Color.blue
                        }]],
                        fixedWidth: true,
                        grabbingEnabled: false,
                        layout: {
                            centeredVertical: true,
                            moveHorizontal: true,
                            moveVertical: false,
                            resizeHeight: false
                        },
                        name: "inspect label",
                        textString: "inspect"
                    },

                    {
                        _Position: lively.pt(425,6.0),
                        _Extent: lively.pt(80,15),
                        _HandStyle: null,
                        _InputAllowed: false,
                        _IsSelectable: false,
                        _FontFamily: "Arial, sans-serif",
                        _FontSize: 9,
                        className: "lively.morphic.Text",
                        emphasis: [[0, 11, {
                            doit: {code: "evt.getTargetMorph().get('PartsBinBrowser').viewSourceForSelection();",context: null},
                            color: Color.blue
                        }]],
                        fixedWidth: true,
                        grabbingEnabled: false,
                        layout: {
                            centeredVertical: true,
                            moveHorizontal: true,
                            moveVertical: false,
                            resizeHeight: false
                        },
                        name: "view source label",
                        textString: "view source"
                    },

                    {
                        _Align: "left",
                        _Extent: lively.pt(3.0,25.0),
                        _FontFamily: "Arial, sans-serif",
                        _HandStyle: "default",
                        _InputAllowed: false,
                        _IsSelectable: true,
                        _MaxTextWidth: 265,
                        _MinTextWidth: 265,
                        _Padding: lively.rect(5,7,0,0),
                        _TextColor: Color.rgb(64,64,64),
                        allowInput: false,
                        className: "lively.morphic.Text",
                        emphasis: [[0,0,{}]],
                        eventsAreIgnored: true,
                        fixedHeight: true,
                        fixedWidth: true,
                        name: "selectedPartSpaceName",
                        isLoggingEnabled:false,
                        sourceModule: "lively.morphic.TextCore",
                        submorphs: [],
                        withoutLayers: [],
                        connectionRebuilder: function connectionRebuilder() {
                        lively.bindings.connect(this, "textString", this, "refineBounds", {});
                    },
                        refineBounds: function refineBounds() {
                                                this.selectAll()
                                                var bounds = this.getSelectionBounds()
                                                this.setSelectionRange(0,0)
                                                this.blur();
                                                this.setExtent(pt(bounds.width + 3, this.getExtent().y))
                                                this.owner.adjustForNewBounds();
                                            }
                    }],
                    withoutLayers: []
                },{
                    _Extent: lively.pt(657.7,28.0),
                    _Fill: Color.rgba(255,255,255,0),
                    _Position: lively.pt(0.0,34.1),
                    className: "lively.morphic.Box",
                    droppingEnabled: false,
                    layout: {
                        borderSize: 0,
                        extentWithoutPlaceholder: lively.pt(1380.3,420.0),
                        resizeHeight: true,
                        resizeWidth: true,
                        spacing: 3,
                        type: "lively.morphic.Layout.HorizontalLayout"
                    },
                    name: "MoreContentContainer",
                    sourceModule: "lively.morphic.Core",
                    submorphs: [{
                        _Extent: lively.pt(320.0,28.0),
                        _Fill: Color.rgba(255,255,255,0),
                        className: "lively.morphic.Box",
                        droppingEnabled: false,
                        layout: {
                            borderSize: 0,
                            extentWithoutPlaceholder: lively.pt(437.3,136.0),
                            resizeHeight: true,
                            resizeWidth: true,
                            spacing: 0,
                            type: "lively.morphic.Layout.VerticalLayout"
                        },
                        name: "InfoContainer",
                        sourceModule: "lively.morphic.Core",
                        submorphs: [{
                            _BorderColor: Color.rgba(255,255,255,0),
                            _BorderWidth: 8,
                            _ClipMode: "auto",
                            _Extent: lively.pt(320.0,110.0),
                            _Fill: Color.rgba(255,255,255,0),
                            _FontFamily: "Arial, sans-serif",
                            _FontSize: 9,
                            _HandStyle: null,
                            _InputAllowed: false,
                            _IsSelectable: true,
                            _MaxTextWidth: 315.04,
                            _MinTextWidth: 315.04,
                            _TextColor: Color.rgb(120,120,120),
                            allowInput: false,
                            className: "lively.morphic.Text",
                            emphasis: [[0,0,{}]],
                            eventsAreIgnored: true,
                            fixedHeight: true,
                            fixedWidth: true,
                            layout: {
                                resizeHeight: true,
                                resizeWidth: true
                            },
                            // Populated only for identity-published parts (see
                            // PartsBinBrowser.describeIdentityPartMeta / setSelectedPartItem)
                            // — empty for WebDAV parts. Height is fixed (not 0) so
                            // all 4 metadata lines are visible without scrolling —
                            // resizeHeight:true alone doesn't auto-grow to fit
                            // content in this layout engine (confirmed live: a
                            // 0-height start plus resizeHeight:true still rendered
                            // as a small fixed-size scrollable box, same as the
                            // comment field below it).
                            name: "selectedPartIdentityMeta",
                            sourceModule: "lively.morphic.TextCore",
                            submorphs: [],
                            withoutLayers: []
                        },{
                            _BorderColor: Color.rgba(255,255,255,0),
                            _BorderWidth: 8,
                            _ClipMode: "auto",
                            _Extent: lively.pt(127.2,0.0),
                            _Fill: Color.rgb(255,255,255),
                            _FontFamily: "Arial, sans-serif",
                            _HandStyle: null,
                            _InputAllowed: true,
                            _IsSelectable: true,
                            _MaxTextWidth: 315.04,
                            _MinTextWidth: 315.04,
                            _TextColor: Color.rgb(64,64,64),
                            allowInput: true,
                            className: "lively.morphic.Text",
                            emphasis: [[0,0,{}]],
                            eventsAreIgnored: true,
                            fixedHeight: true,
                            fixedWidth: true,
                            layout: {
                                resizeHeight: true,
                                resizeWidth: true
                            },
                            name: "selectedPartComment",
                            sourceModule: "lively.morphic.TextCore",
                            submorphs: [],
                            withoutLayers: [],
                            connectionRebuilder: function connectionRebuilder() {
                            lively.bindings.connect(this, "savedTextString", this.get("PartsBinBrowser"), "saveCommentForSelectedPartItem", {});
                            lively.bindings.connect(this, "textString", this.get("ButtonLineMorph"), "activateButtons", {converter:
                        function (text) {
                                                                return text && text.length > 0
                                                            }});
                        }
                        },{
                            _Extent: lively.pt(127.2,28.0),
                            _Fill: Color.rgba(255,255,255,0),
                            className: "lively.morphic.Box",
                            droppingEnabled: false,
                            item: "[object Object]",
                            layout: {
                                borderSize: 0,
                                resizeHeight: false,
                                resizeWidth: true,
                                spacing: 4,
                                type: "lively.morphic.Layout.HorizontalLayout"
                            },
                            name: "ButtonLineMorph",
                            sourceModule: "lively.morphic.Core",
                            submorphs: [{
                                _BorderColor: Color.rgb(255,255,255),
                                _Extent: lively.pt(39.7,28.0),
                                _Fill: Color.rgb(204,204,204),
                                _StyleClassNames: ["Morph","Button","disabled"],
                                className: "lively.morphic.Button",
                                droppingEnabled: false,
                                grabbingEnabled: false,
                                isActive: false,
                                isPressed: false,
                                label: "remove",
                                layout: {
                                    moveVertical: true,
                                    resizeWidth: true
                                },
                                name: "removePartButton",
                                padding: lively.rect(5,0,0,0),
                                showsMorphMenu: true,
                                sourceModule: "lively.morphic.Widgets",
                                style: {
                                    borderRadius: 0
                                },
                                withoutLayers: [],
                                connectionRebuilder: function connectionRebuilder() {
                                lively.bindings.connect(this, "fire", this.get("PartsBinBrowser"), "interactivelyRemoveSelectedPartItem", {});
                            }
                            },{
                                _BorderColor: Color.rgb(255,255,255),
                                _Extent: lively.pt(39.7,28.0),
                                _Fill: Color.rgb(204,204,204),
                                _Position: lively.pt(87.4,0.0),
                                _StyleClassNames: ["Morph","Button","disabled"],
                                className: "lively.morphic.Button",
                                droppingEnabled: false,
                                grabbingEnabled: false,
                                isActive: false,
                                isPressed: false,
                                label: "move",
                                layout: {
                                    moveVertical: true,
                                    resizeWidth: true
                                },
                                name: "movePartButton",
                                padding: lively.rect(5,0,0,0),
                                sourceModule: "lively.morphic.Widgets",
                                style: {
                                    borderRadius: 0
                                },
                                withoutLayers: [],
                                connectionRebuilder: function connectionRebuilder() {
                                lively.bindings.connect(this, "fire", this.get("PartsBinBrowser"), "interactivelyMoveSelectedPartItem", {});
                            }
                            },{
                                _BorderColor: Color.rgb(255,255,255),
                                _Extent: lively.pt(39.7,28.0),
                                _Fill: Color.rgb(204,204,204),
                                _Position: lively.pt(43.7,0.0),
                                _StyleClassNames: ["Morph","Button","disabled"],
                                className: "lively.morphic.Button",
                                droppingEnabled: false,
                                grabbingEnabled: false,
                                isActive: false,
                                isPressed: false,
                                label: "copy",
                                layout: {
                                    moveVertical: true,
                                    resizeWidth: true
                                },
                                name: "copyPartButton",
                                padding: lively.rect(5,0,0,0),
                                showsMorphMenu: true,
                                sourceModule: "lively.morphic.Widgets",
                                style: {
                                    borderRadius: 0
                                },
                                withoutLayers: [],
                                connectionRebuilder: function connectionRebuilder() {
                                lively.bindings.connect(this, "fire", this.get("PartsBinBrowser"), "interactivelyCopySelectedPartItem", {});
                            }
                            }],
                            withoutLayers: [],
                            activateButtons: function activateButtons(bool) {
                                                        this.submorphs.invoke('setActive', !!bool)
                                                    }
                        }],
                        withoutLayers: []
                    },{
                        _Extent: lively.pt(329.7,28.0),
                        _Fill: Color.rgba(255,255,255,0),
                        _Position: lively.pt(328.0,0.0),
                        className: "lively.morphic.Box",
                        droppingEnabled: false,
                        layout: {
                            borderSize: 0,
                            extentWithoutPlaceholder: lively.pt(528.3,145.0),
                            resizeHeight: true,
                            resizeWidth: false,
                            spacing: 0,
                            type: "lively.morphic.Layout.VerticalLayout"
                        },
                        name: "CommitContainer",
                        sourceModule: "lively.morphic.Core",
                        submorphs: [{
                            _BorderColor: Color.rgba(255,255,255,0),
                            _ClipMode: "auto",
                            _Extent: lively.pt(522.5,0.0),
                            _Fill: Color.rgb(255,255,255),
                            _StyleClassNames: ["Morph","Box","MorphList"],
                            _StyleSheet: ".MorphList {\n\
                        	overflow-y: scroll;\n\
                        	overflow-x: hidden;\n\
                        }\n\
                        \n\
                        .MorphList .selected {\n\
                        	outline: 0px;\n\
                        	background-color: rgb(42, 87, 192) !important;\n\
                        }\n\
                        \n\
                        .MorphList .selected span {\n\
                        	color: white !important;\n\
                        }\n\
                        \n\
                        .Text {\n\
                        	box-shadow: 0px 2px 0px rgb(244, 244, 244);\n\
                        }",
                            allowDeselectClick: false,
                            className: "lively.morphic.MorphList",
                            droppingEnabled: false,
                            isAdding: false,
                            isCopyMorphRef: true,
                            isMultipleSelectionList: true,
                            itemList: [],
                            itemMorphs: [],
                            layout: {
                                adjustForNewBounds: true,
                                borderSize: 0,
                                extentWithoutPlaceholder: lively.pt(315.9,161.3),
                                resizeHeight: true,
                                resizeWidth: true,
                                spacing: 1,
                                type: "lively.morphic.Layout.TileLayout"
                            },
                            morphRefId: 2,
                            name: "selectedPartVersions",
                            selectedLineNo: null,
                            sourceModule: "lively.morphic.Lists",
                            submorphs: [],
                            withoutLayers: [],
                            adjustForNewBounds: function adjustForNewBounds() {
                                                        if (this.isAdding) { return }
                                                        this.submorphs.each(function(ea) {
                                                            ea.setExtent(pt(this.getExtent().x-1, ea.getExtent().y));
                                                        }, this)
                                                        $super();
                                                        this.submorphs.invoke.bind(this.submorphs, 'fit').delay(0);
                                                    },
                            connectionRebuilder: function connectionRebuilder() {
                            lively.bindings.connect(this, "selection", this.get("ButtonLineVersions"), "activateButtons", {converter:
                        function (sel) {
                                                        	    return sel && typeof sel.item.value.version !== 'undefined'
                                                        	}});
                        },
                            renderFunction: function renderFunction(listItem) {
                                                        var morph = $super(listItem);
                                                        morph.applyStyle({
                                                            fixedWidth: true,
                                                            textColor: (listItem.value && typeof listItem.value.version==='undefined') ?
                                                                Global.Color.gray : Global.Color.black,
                                                            borderWidth: 0,
                                                            padding: rect(4,5,0,0),
                                                            fill: Global.Color.white
                                                        });
                                                        morph.setExtent(pt(this.getExtent().x-2, morph.getExtent().y));
                                                        morph.emphasize({fontWeight: 'bold'}, 0, morph.getTextString().indexOf('\n'));
                                                        return morph;
                                                    },
                            updateList: function updateList(items) {
                                                        this.isAdding = true;
                                                        $super(items)
                                                        this.isAdding = false;
                                                        this.adjustForNewBounds();
                                                    }
                        },{
                            _Extent: lively.pt(522.5,28.0),
                            _Fill: Color.rgba(255,255,255,0),
                            className: "lively.morphic.Box",
                            droppingEnabled: false,
                            item: "[object Object]",
                            layout: {
                                borderSize: 0,
                                resizeHeight: false,
                                resizeWidth: true,
                                spacing: 4,
                                type: "lively.morphic.Layout.HorizontalLayout"
                            },
                            name: "ButtonLineVersions",
                            sourceModule: "lively.morphic.Core",
                            submorphs: [{
                                _BorderColor: Color.rgb(255,255,255),
                                _Extent: lively.pt(259.3,28.0),
                                _Fill: Color.rgb(204,204,204),
                                _StyleClassNames: ["Morph","Button","disabled"],
                                className: "lively.morphic.Button",
                                droppingEnabled: false,
                                grabbingEnabled: false,
                                isActive: false,
                                isPressed: false,
                                label: "load",
                                layout: {
                                    moveVertical: true,
                                    resizeWidth: true
                                },
                                name: "loadPartButton",
                                padding: lively.rect(5,0,0,0),
                                showsMorphMenu: true,
                                sourceModule: "lively.morphic.Widgets",
                                style: {
                                    borderRadius: 0
                                },
                                value: false,
                                withoutLayers: [],
                                connectionRebuilder: function connectionRebuilder() {
                                lively.bindings.connect(this, "fire", this.get("PartsBinBrowser"), "loadAndOpenSelectedPartItem", {});
                            }
                            },{
                                _BorderColor: Color.rgb(255,255,255),
                                _Extent: lively.pt(259.3,28.0),
                                _Fill: Color.rgb(204,204,204),
                                _Position: lively.pt(263.3,0.0),
                                _StyleClassNames: ["Morph","Button","disabled"],
                                className: "lively.morphic.Button",
                                droppingEnabled: false,
                                grabbingEnabled: false,
                                isActive: false,
                                isPressed: false,
                                label: "revert",
                                layout: {
                                    moveVertical: true,
                                    resizeWidth: true
                                },
                                name: "revertButton",
                                padding: lively.rect(5,0,0,0),
                                sourceModule: "lively.morphic.Widgets",
                                style: {
                                    borderRadius: 0
                                },
                                value: false,
                                withoutLayers: [],
                                connectionRebuilder: function connectionRebuilder() {
                                lively.bindings.connect(this, "fire", this.get("PartsBinBrowser"), "interactivelyRevertSelectedPart", {});
                            }
                            }],
                            withoutLayers: [],
                            activateButtons: function activateButtons(bool) {
                                                        this.submorphs.invoke('setActive', !!bool)
                                                    }
                        }],
                        withoutLayers: []
                    },{
                        _BorderColor: null,
                        _Extent: lively.pt(2.0,28.0),
                        _Fill: Color.rgb(204,204,204),
                        _Position: lively.pt(323.0,0.0),
                        className: "lively.morphic.VerticalDivider",
                        draggingEnabled: true,
                        droppingEnabled: true,
                        fixed: [],
                        layout: {
                            resizeHeight: true
                        },
                        minWidth: 59,
                        name: "VersionDivider",
                        oldPoint: lively.pt(1234.0,865.0),
                        pointerConnection: null,
                        scalingLeft: "[<lively.morphic.Box#71E27... - InfoContainer>]",
                        scalingRight: "[<lively.morphic.Box#8CFAA... - CommitContainer>]",
                        sourceModule: "lively.morphic.Widgets",
                        submorphs: [],
                        withoutLayers: []
                    }],
                    withoutLayers: []
                }],
                withoutLayers: []
            }],
            withoutLayers: []
        }],
        url: null,
        withLayers: "[GrabbingLayer]",
        withoutLayers: [],
        addCategory: function addCategory(categoryName, doNotUpdate) {
        if (!categoryName.startsWith("*")) {
            var url = this.partsBinURL().withFilename(categoryName);
            this.addExternalCategory(categoryName, url, true);
        } else {
            this.categories[categoryName] = {isSpecialCategory: true};
            this.updateCategoryList(categoryName, doNotUpdate);
        }
    },
        addCategoryInteractively: function addCategoryInteractively() {
        var partsBin = this, world = this.world();
        // categoryName's default selection (reloadEverything -> the
        // categoryList.setSelection('Basic') at the end of
        // updateCategoriesDictFromPartsBin) resolves only after an async
        // WebDAV directory listing completes — categoryName stays undefined
        // until then. Clicking "+" in that window used to fall through the
        // check below (undefined matches neither branch) straight to the
        // legacy "Name of new category?" prompt, silently creating a real
        // WebDAV directory even for a signed-in user who never saw a
        // WebDAV category selected. Fail safe instead of falling through.
        if (this.categoryName === undefined) {
            world.alert('Categories are still loading — try again in a moment.');
            return;
        }
        // While browsing identity parts (My Parts or an identity tag
        // category), "+" creates an identity-aware category instead of a
        // WebDAV directory — WebDAV categories are directories on disk and
        // meaningless for identity parts, which don't live on disk at all.
        // Identity categories are just envelope.state.tags (see
        // addTagToSelectedPart) — there's no empty-category concept since
        // categories are derived from what parts are actually tagged with,
        // so this requires a part to be selected to tag.
        if (this.categoryName === '*myparts*' || (this.categoryName && this.categoryName.charAt(0) === '#')) {
            var item = this.selectedPartItem;
            if (!item || !item.envelope) {
                world.alert('Select one of your published items first, then create a category to file it under.');
                return;
            }
            world.prompt('Name of new identity category?', function(tagName) {
                if (!tagName || tagName === '') { alert('no category created!'); return; }
                partsBin.addTagToSelectedPart(tagName.replace(/^#/, '').trim());
            });
            return;
        }
        world.prompt('Name of new category?', function(categoryName) {
            if (!categoryName || categoryName == '') {
           alert('no category created!')
           return;
        }
            partsBin.addCategory(categoryName)
        });
    },
        // Tags the currently selected identity part with a new category
        // name and persists it: local-first (ObjectStore.updateState — a
        // plain put() would silently no-op here since state.tags doesn't
        // change record.cid, see that method's comment), then synced to the
        // server the same way every other identity write is. Refreshes the
        // current listing + category sidebar afterward so the new tag
        // category shows up immediately.
        addTagToSelectedPart: function addTagToSelectedPart(tagName) {
        var item = this.selectedPartItem;
        if (!item || !item.envelope) { alert('Select an identity-published item first.'); return; }
        var envelope = item.envelope;
        var tags = (envelope.state && envelope.state.tags) || [];
        if (tags.indexOf(tagName) !== -1) { alert('Already tagged "' + tagName + '".'); return; }
        var newEnvelope = Object.assign({}, envelope, {
            state: Object.assign({}, envelope.state, { tags: tags.concat([tagName]) })
        });
        var self = this;
        if (typeof lively === 'undefined' || !lively.require) { alert('Identity module not available'); return; }
        lively.require('lively.identity.UserSpace').toRun(function () {
            var user = lively.identity.did.currentUser();
            if (!user) { alert('Not signed in'); return; }
            lively.identity.objectStore.updateState(newEnvelope, function (err) {
                if (err) { alert('Could not save category: ' + err.message); return; }
                item.envelope = newEnvelope;
                lively.identity.objectStore.syncObject(newEnvelope.objId, user.handle, lively.identity.did.baseUrl(), function (syncErr) {
                    if (syncErr) console.warn('[addTagToSelectedPart] sync failed (will retry later):', syncErr.message);
                });
                Global.alertOK('Tagged "' + item.name + '" with "#' + tagName + '"');
                self.loadPartsOfCategory(self.categoryName);
            });
        });
    },
        addExternalCategory: function addExternalCategory(categoryName, url, createPath) {
        url = url.asDirectory();
        this.categories[categoryName] = url;
        if (createPath) {
            this.getPartsSpaceForCategory(categoryName).ensureExistance();
        }
        this.updateCategoryList(categoryName);
    },
        addMorphsForPartItems: function addMorphsForPartItems(partItems, doNotSort) {
        this.removeParts();
        if (!doNotSort) {
            partItems = partItems.sortBy(function(ea) {
                return ea.name.toLowerCase()
            });
        }
        var pContents = this.get('partsBinContents');
        pContents.stopAddingPartItemsAsync();
        pContents.startAddingPartItems(partItems);
    },
        addPartsFromURLs: function addPartsFromURLs(urls) {
        var partsBin = this, partItems = [];
        urls.forEach(function(ea) {
            var partPath = ea.saveRelativePathFrom(Global.URL.root),
                match = partPath.match(/(.*\/)(.*).json/);
            if (match)
                partItems.push(lively.PartsBin.getPartItem(match[2], match[1]));
        });
        partsBin.addMorphsForPartItems(partItems, true);
    },
        addPartsOfCategory: function addPartsOfCategory(categoryName) {
        var partsSpace = this.getPartsSpaceForCategory(categoryName);
        // Stashed on partsSpace itself (read back via this.sourceObj below),
        // not captured as a closure variable — converter/updater functions
        // passed to Global.connect are persisted as source text and
        // reconstructed standalone (lively.Closure.fromSource) whenever this
        // part/world is reloaded from a saved state, which strips normal JS
        // closures entirely. Only `this` (the AttributeConnection itself —
        // sourceObj/targetObj) survives that round-trip; a captured
        // `categoryName` local does not (confirmed live: "ReferenceError:
        // categoryName is not defined" from exactly this pattern).
        partsSpace._requestedForCategory = categoryName;
        Global.connect(partsSpace, 'partItems', this, 'addMorphsForPartItems', {
            converter: function(partItemObj) { return Global.Properties.ownValues(partItemObj) },
            // Staleness guard, same reasoning as loadMyParts: this WebDAV
            // directory listing is async and can arrive after the user has
            // already switched to a different category (including
            // *myparts*) — applying it late would silently overwrite
            // whatever the current category already rendered.
            updater: function($upd, partItemObj) {
                if (this.targetObj.categoryName === this.sourceObj._requestedForCategory) $upd(partItemObj);
            }
        })
        partsSpace.load(true);
    },
        collectAllPartItemURLs: function collectAllPartItemURLs(spec) {
        var newURLs = spec.newURLs,
            targetCount = spec.targetCount;
        this.allItemURLs.pushAll(newURLs);
    },
        commitLogString: function commitLogString(metaInfo) {
        if (!metaInfo || !metaInfo.changes) return "";
        return metaInfo.changes
            .reverse()
            .collect(function(ea) {
                return Strings.format("%s %s: \n    %s\n\n",
                    ea.date.format("yyyy-mm-dd HH:MM") ,
                    ea.author, (ea.message || "no comment"));
            })
            .join('');
    },
        connectionRebuilder: function connectionRebuilder() {
        lively.bindings.connect(this, "categoryName", this, "loadPartsOfCategory", {});
        lively.bindings.connect(this, "moreToggled", this.get("moreButton"), "setLabel", {converter:
    function (bool) {
                        return bool ? 'less' : 'more';
                    }});
    },
        defaultPartsBinURL: function defaultPartsBinURL() {
        return new Global.URL(Global.Config.rootPath).withFilename('PartsBin/');
    },
        doSearch: function doSearch() {
        var serverRoot = Global.URL.root;
        if (Global.URL.root.hostname !== this.partsBinURL().hostname) {
            // FIXME: assuming parent directory
            serverRoot = this.partsBinURL().withFilename('..').withRelativePartsResolved();
        }

        this.showMsg("searching...");
        var pb = this;
        var searchString = this.get('searchText').getInput();
        if (!searchString || searchString.length === 0) return;
        // -=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-
        // find parts via cmdline
        var partsBinPath = this.partsBinURL().relativePathFrom(serverRoot),
            findPath = "$WORKSPACE_LK/" + partsBinPath.replace(/\/\//g, '\/');

        // The WebDAV filename search below and the identity-space ObjID
        // search run concurrently and both feed into one merged render —
        // addMorphsForPartItems clears the grid on every call, so rendering
        // each source separately would let whichever finishes last wipe out
        // the other's matches.
        var webDavResults = null, identityResults = null;
        function tryRender() {
            if (webDavResults === null || identityResults === null) return;
            if (pb.get('searchText').getInput() !== searchString) return; // stale: search text changed while we were waiting
            pb.addMorphsForPartItems(webDavResults.concat(identityResults), true);
            pb.get('searchText').focus();
        }

        doCommandLineSearch(processResult.curry(listPartItems), searchString);
        this.searchIdentityItemsByObjId(searchString, function(items) {
            identityResults = items;
            tryRender();
        });

        // -=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-

        function doCommandLineSearch(next, searchString) {
                var cmdTemplate = "find %s "
                                + "\\( -name node_modules -o -name '.svn' -o -name '.git' \\) -type d -prune "
                                + "-o -type f -iname '*%s*.json*' -print",
                cmd = Strings.format(cmdTemplate, findPath, searchString);
            lively.require('lively.ide.CommandLineInterface').toRun(function() {
                lively.shell.exec(cmd, next);
            });
        }
        function processResult(next, err, searchCmd) {
            if (searchCmd.getCode()) {
                pb.showMsg('Search failure:\n' + searchCmd.getStderr);
                next([]);
                return;
            }
            var lines = Strings.lines(searchCmd.getStdout());
            var partItemURLs = lines.map(function(line) {
                line = line.replace(/\/\//g, '\/') // double path slashes
                var partPath = line.split(partsBinPath).last();
                return pb.partsBinURL().withFilename(partPath);
            });
            next(partItemURLs);
        }

        function listPartItems(partItemURLs) {
            var partItems = [];
            partItemURLs.forEach(function(ea) {
                var partPath = ea.saveRelativePathFrom(Global.URL.root),
                    match = partPath.match(/(.*\/)(.*).json/);
                if (match) partItems.push(lively.PartsBin.getPartItem(match[2], match[1]));
            });
            webDavResults = partItems;
            tryRender();
        }
    },
        // Runs alongside the WebDAV filename search in doSearch so typing an
        // ObjID into the same search box also finds identity-published
        // items in the user's own space — those aren't WebDAV files and
        // wouldn't otherwise show up in a PartsBin search. Substring match
        // (not exact) so a partial/copied ID still finds the item. Yields no
        // matches when signed out or on error; the WebDAV results still
        // render on their own via doSearch's merge.
        searchIdentityItemsByObjId: function searchIdentityItemsByObjId(searchString, thenDo) {
        if (typeof lively === 'undefined' || !lively.require) { thenDo([]); return; }
        lively.require('lively.identity.UserSpace').toRun(function () {
            lively.identity.userSpace.getPersonalPartsSpace(function (err, space) {
                if (err) { thenDo([]); return; }
                space.load(function (loadErr) {
                    if (loadErr) { thenDo([]); return; }
                    var needle = searchString.toLowerCase();
                    var matches = space.getPartItems().filter(function (item) {
                        var objId = item.envelope && item.envelope.objId;
                        return objId && objId.toLowerCase().indexOf(needle) !== -1;
                    });
                    thenDo(matches);
                });
            });
        });
    },
        ensureCategories: function ensureCategories() {
        if (!this.categories)
            this.categories = {uncategorized: 'PartsBin/'};
    },
        formatVersionEntry: function formatVersionEntry(entry) {
        // date
        var formattedDate = entry.date;
        if (!formattedDate.format) {
            formattedDate = new Date(Date.parse(formattedDate));
        }
        formattedDate = formattedDate.format("yyyy-mm-dd HH:MM")
        // author
        var string = formattedDate + " " + entry.author;
        // version
        if (typeof entry.version !== 'undefined') {
            string += " (version " + entry.version + ")"
        }
        // comment
        string += '\n' + (entry.message || 'no comment')
        return {    string: string,
                    value: entry, isListItem: true};
    },
        getPartsSpaceForCategory: function getPartsSpaceForCategory(categoryName) {
        var url = this.getURLForCategoryNamed(categoryName);
        return lively.PartsBin.partsSpaceWithURL(url);
    },
        getURLForCategoryNamed: function getURLForCategoryNamed(categoryName) {
        this.ensureCategories()

        var relative = this.categories[categoryName];
        if (!relative) return null;
        return Global.URL.ensureAbsoluteCodeBaseURL(relative).withRelativePartsResolved()
    },
        interactivelyCopySelectedPartItem: function interactivelyCopySelectedPartItem(partMorph) {
        // FIXME duplication with interactivelyMoveSelectedPartItem
        var partItem = this.selectedPartItem, categories = this.categories, self = this;
        if (!partItem) { alert('no item selected'); return }
        var items = Global.Properties.own(categories).sort()
                .reject(function(ea) { return ea.startsWith("*") || ea.charAt(0) === '#' || ea === self. categoryName})
                .collect(function(catName) {
            return [catName, function() {
                var url = new Global.URL(categories[catName]);
                var partsSpace = lively.PartsBin.partsSpaceWithURL(url)
                partItem.copyToPartsSpace(partsSpace);
                Global.alertOK('Copied ' + partItem.name + ' to ' + url);
            }]
        })
        lively.morphic.Menu.openAtHand('Select category', items);
    },
        interactivelyMoveSelectedPartItem: function interactivelyMoveSelectedPartItem(partMorph) {
        var partItem = this.selectedPartItem, categories = this.categories, self = this;
        if (!partItem) { alert('no item selected'); return }
        var items = Global.Properties.own(categories).sort()
                .reject(function(ea) { return ea.startsWith("*") || ea.charAt(0) === '#' || ea === self. categoryName})
                .collect(function(catName) {
            return [catName, function() {
                var url = new Global.URL(categories[catName]);
                var partsSpace = lively.PartsBin.partsSpaceWithURL(url)
                partItem.moveToPartsSpace(partsSpace);
                self.reloadEverything();
                Global.alertOK('Moved ' + partItem.name + ' to ' + url);
            }]
        })
        lively.morphic.Menu.openAtHand('Select category', items);
    },
        interactivelyRemoveSelectedPartItem: function interactivelyRemoveSelectedPartItem(partMorph) {
        var item = this.selectedPartItem;
        if (!item) return;
        this.world().confirm("really delete " + item.name + " in Inventory?", function(answer) {
        if (!answer) return;
        item.del();
        this.reloadEverything();
        Global.alertOK("deleted " + item.name);
        }.bind(this))
    },
        interactivelyRevertSelectedPart: function interactivelyRevertSelectedPart(partMorph) {
        var version = this.get("selectedPartVersions").getSelectedItem();
        if (!version) return $world.alert("No version selected!");
        var item = this.selectedPartItem;
        if (!item) return $world.alert("No item selected!");

        var urls = [item.getFileURL(),
                    item.getHTMLLogoURL(),
                    item.getMetaInfoURL()];

        var prompt = 'Do you really want to revert \n'
                    + item.anem
                    + '\nto its version from\n'
                    + new Date(version.value.date).format('yy/mm/dd hh:MM:ss') + '?';

        $world.confirm(prompt, function(input) {
            if (!input) { $world.alertOK('Revert aborted.'); return; }
            lively.net.Wiki.revertResources(urls, version.value, function(err) {
                err ? $world.alert('Revert failed:\n' + (err.stack || err)) :
                      $world.alertOK(item.name + ' successfully reverted.');
                lively.bindings.connect(item, 'partVersions', self, 'setSelectedPartItem', {
                  removeAfterUpdate: true,
                  converter: function() { return this.sourceObj; },
                });
                item.loadPartVersions(true);
            });
        });
    },
        loadAndOpenSelectedPartItem: function loadAndOpenSelectedPartItem(partMorph) {
        var item = this.selectedPartItem;
        if (!item) return;
        Global.connect(item, 'part', this, 'openPart', {removeAfterUpdate: true});
        var selectedVersion = this.get('selectedPartVersions').getSelectedItem(),
            rev = selectedVersion ? selectedVersion.value.version : null;
        item.loadPart(true, null, rev);
        Global.alertOK('loading ' + item.name + '...');
    },
        loadPartsOfCategories: function loadPartsOfCategories(categoryResources) {
        categoryResources.mapAsync(function(webR, i, callback) {
            webR.beAsync();
            var answerObject = {
                answer: function (subDocuments) {
                    callback(null, subDocuments.invoke('getURL')
                        .select(function(ea) {return ea.filename().endsWith(".json")})
                        .sortBy(function(ea) {return ea.filename()}))
                }
            }
            Global.connect(webR, 'subDocuments', answerObject, 'answer');
            webR.getSubElements(1);
        }, function(err, list) {
                var urls = list.flatten();
                var partsBin = this, partItems = [];
                urls.forEach(function(ea) {
                    var partPath = ea.saveRelativePathFrom(Global.URL.root),
                        match = partPath.match(/(.*\/)(.*).json/);
                    if (match)
                        partItems.push(lively.PartsBin.getPartItem(match[2], match[1]));
                });
                partsBin.addMorphsForPartItems(partItems);
            }.bind(this));
    },
        loadPartsOfCategory: function loadPartsOfCategory(categoryName) {
        this.removeParts();
        this.setSelectedPartItem(null);
        if (!categoryName) return;
        var webR;
        if (categoryName == "*all*") {
            this.showMsg("loading all...");
            webR = new Global.WebResource(this.partsBinURL()).noProxy().beAsync();
            lively.bindings.connect(webR, 'subCollections', this, 'loadPartsOfCategories');
            webR.getSubElements(1)
        } else if (categoryName == "*latest*") {
            this.showMsg("loading latest...");
            var partsbinDir = this.partsBinURL().saveRelativePathFrom(URL.root);
            lively.ide.CommandLineSearch.findFiles('*.json', {rootDirectory: partsbinDir}, function(err, result) {
              result = result.sortByKey('lastModified').reverse().slice(0,20);
              this.onLoadLatest(result);
            }.bind(this));
        } else if (categoryName == "*myparts*") {
            this.showMsg("loading my parts...");
            this.loadMyParts();
        } else if (categoryName.charAt(0) === '#') {
            this.showMsg("loading " + categoryName + "...");
            this.loadIdentityTagCategory(categoryName);
        } else if (categoryName == "*search*") {
            this.doSearch();
        } else {
            this.addPartsOfCategory(categoryName);
        }
    },
        // Identity-published parts (Save to My Parts / copyToIdentityPartsSpace)
        // live in lively.identity.IdentityPartsSpace, backed by the signed-in
        // user's local ObjectStore — an entirely different space from the
        // WebDAV categories the rest of this browser reads from, so it can't
        // reuse addPartsOfCategory's WebDAV directory listing.
        loadMyParts: function loadMyParts() {
        var self = this;
        if (typeof lively === 'undefined' || !lively.require) {
            this.showMsg("Identity module not available");
            return;
        }
        lively.require('lively.identity.UserSpace').toRun(function () {
            lively.identity.userSpace.getPersonalPartsSpace(function (err, space) {
                if (err) { self.showMsg('Sign in to see My Parts'); return; }
                space.load(function (loadErr) {
                    if (loadErr) { self.showMsg('Error loading parts: ' + loadErr.message); return; }
                    // Guard against a stale response: if the user switched to
                    // another category while this (async ObjectStore) load was
                    // in flight, categoryName has already moved on — applying
                    // these results now would silently overwrite whatever the
                    // new category already rendered, leaving categoryName
                    // saying "*myparts*" while the visible list is really the
                    // old category's. addPartsOfCategory's WebDAV path has an
                    // analogous unguarded race, but that's pre-existing and
                    // out of scope here.
                    if (self.categoryName !== '*myparts*') return;
                    self._refreshIdentityCategories(space.getPartItems());
                    self.addMorphsForPartItems(space.getPartItems());
                });
            });
        });
    },
        // Identity categories aren't stored anywhere separately — they're
        // derived from the union of state.tags across the signed-in user's
        // own parts (set via addTagToSelectedPart), rendered as "#tagname"
        // entries in the same sidebar category list as WebDAV categories.
        // Called whenever *myparts* (re)loads, so the list stays in sync
        // with whatever tags actually exist right now — stale tags (from a
        // part that no longer has them, or was deleted) are dropped, not
        // just accumulated forever.
        _refreshIdentityCategories: function _refreshIdentityCategories(items) {
        this.ensureCategories();
        var self = this;
        var tags = {};
        items.forEach(function (item) {
            var itemTags = item.envelope && item.envelope.state && item.envelope.state.tags;
            (itemTags || []).forEach(function (t) { tags['#' + t] = true; });
        });
        var existingIdentityNames = Object.keys(this.categories).filter(function (name) {
            return self.categories[name] && self.categories[name].isIdentityCategory;
        });
        var newTagNames = Object.keys(tags);
        // Skip the rebuild entirely when the tag set hasn't actually
        // changed — categoryList.updateList (called by updateCategoryList)
        // internally tries to "restore the current selection at its new
        // index" any time it runs, and that restore can re-fire the
        // categoryName connection even for a no-op rebuild, which was
        // wiping out whatever part the user had just selected (confirmed
        // live: selecting an item, then re-entering *myparts*, silently
        // cleared the selection through exactly this path with no tags
        // having changed at all). A guard on the *caller* side
        // (loadPartsOfCategory) was tried first and rejected — it also
        // blocked a legitimate user re-click on the same category to
        // force a refresh, which is a real, more important use case (e.g.
        // to pick up a part just published while the browser was open).
        var unchanged = existingIdentityNames.length === newTagNames.length &&
            existingIdentityNames.every(function (name) { return tags[name]; });
        if (unchanged) return;
        existingIdentityNames.forEach(function (name) {
            if (!tags[name]) delete self.categories[name];
        });
        newTagNames.forEach(function (name) {
            self.categories[name] = { isIdentityCategory: true };
        });
        this.updateCategoryList(this.categoryName, true);
    },
        // Same shape as loadMyParts, filtered to items tagged with this
        // category's name. Loads the full personal space rather than a
        // separate tag-indexed query — identity part counts per user are
        // small enough that this is simpler than adding real tag-query
        // plumbing to IdentityPartsSpace/ObjectStore for what's currently a
        // client-side-only filter.
        loadIdentityTagCategory: function loadIdentityTagCategory(categoryName) {
        var self = this;
        var tag = categoryName.slice(1);
        if (typeof lively === 'undefined' || !lively.require) {
            this.showMsg("Identity module not available");
            return;
        }
        lively.require('lively.identity.UserSpace').toRun(function () {
            lively.identity.userSpace.getPersonalPartsSpace(function (err, space) {
                if (err) { self.showMsg('Sign in required'); return; }
                space.load(function (loadErr) {
                    if (loadErr) { self.showMsg('Error loading parts: ' + loadErr.message); return; }
                    if (self.categoryName !== categoryName) return;
                    var filtered = space.getPartItems().filter(function (item) {
                        var itemTags = item.envelope && item.envelope.state && item.envelope.state.tags;
                        return itemTags && itemTags.indexOf(tag) !== -1;
                    });
                    self._refreshIdentityCategories(space.getPartItems());
                    self.addMorphsForPartItems(filtered);
                });
            });
        });
    },
        makeUpPartNameFor: function makeUpPartNameFor(name) {
        if (!$morph(name)) return name;
        var i = 2;
        while($morph(name + i)) { i++ }
        return name + i;
    },

        openPartInspectorForSelection: function openPartInspectorForSelection() {
          var item = this.get('PartsBinBrowser').get('PartsBinBrowser').selectedPartItem;
          if (!item) {
            $world.inform("Nothing part item selected.");
            return;
          }

          var indicatorClose, indicator;
          lively.lang.fun.composeAsync(
            function(n) { Global.require("lively.morphic.tools.LoadingIndicator").toRun(function() { n(); }); },
            function(n) { indicator = lively.morphic.tools.LoadingIndicator.open("loading...", function (close) { indicatorClose = close; n(); }); },
            function(n) { lively.PartsBin.getPart("PartInspector", "PartsBin/Debugging/", function(err, inspector) { n(err, inspector); }); },
            function(inspector, n) {
              inspector.openInWorldCenter();
              indicator.bringToFront();
              inspector.targetMorph.loadPart(item.name, item.partsSpaceName, n);
            }
          )(function(err) {
            indicatorClose && indicatorClose();
          });

        },

        // Extracts and displays the selected part's embedded addScript/
        // BuildSpec source WITHOUT deserializing/evaling it (see
        // lively.persistence.Serializer.scriptSourcesIn / ItemSourceViewer)
        // -- lets a part's code be read before it's ever run.
        viewSourceForSelection: function viewSourceForSelection() {
          var item = this.get('PartsBinBrowser').get('PartsBinBrowser').selectedPartItem;
          if (!item) {
            $world.inform("Nothing part item selected.");
            return;
          }
          lively.require('lively.morphic.tools.ItemSourceViewer').toRun(function() {
            new WebResource(item.getFileURL()).noProxy().beAsync()
              .withJSONWhenDone(function(json, status) {
                if (!status || !status.isSuccess()) {
                  $world.inform('Failed to load source: ' + (status && status.code));
                  return;
                }
                lively.morphic.tools.ItemSourceViewer.open(item.name, json);
              })
              .get();
          });
        },

        onLoad: function onLoad() {
        this.updatePartsBinURLChooser();
        this.get("PartsBinURLChooser").selectAt(0);
    },
        onLoadAll: function onLoadAll(subDocuments) {
        // alertOK("load all " + subDocuments.length)
        var all = subDocuments.invoke('getURL')
        .select(function(ea) {return ea.filename().endsWith(".json")})
        .sortBy(function(ea) {return ea.filename()});

        this.addPartsFromURLs(all)
    },
        onLoadLatest: function onLoadLatest(latestFiles) {
        var latestURLs = latestFiles.pluck('path').map(function(path) { return Global.URL.root.withFilename(path); });
        this.addPartsFromURLs(latestURLs);
    },
        onWindowGetsFocus: function onWindowGetsFocus() {
          this.get("searchText").focus();
    },
        openPart: function openPart(partMorph) {
        partMorph.setName(this.makeUpPartNameFor(partMorph.getName()));
        lively.morphic.World.current().firstHand().grabMorph(partMorph, null);
        if(partMorph.onCreateFromPartsBin) partMorph.onCreateFromPartsBin();
        partMorph.setPosition(pt(0,0));
    },
        partsBinURL: function partsBinURL() {
        if (this.url) { return this.url; }
        return this.defaultPartsBinURL();
    },
        reloadEverything: function reloadEverything() {
        this.get('categoryList').updateList([]);
        this.get('partsBinContents').removeAllMorphs();
        this.setSelectedPartItem(null);
        this.updateCategoriesDictFromPartsBin(function() {
            this.addCategory("*latest*", true);
            this.addCategory("*all*", true);
            this.addCategory("*myparts*", true);
            this.addCategory("*search*", true);
            this.get('categoryList').setSelection('Basic');
        });
    },
        removeCategory: function removeCategory(categoryName) {
        var url = this.getURLForCategoryNamed(categoryName);
        if (!url) {
            alert('No category ' + categoryName + ' exists! Doing nothing')
        return;
        }
        var webR = new Global.WebResource(url);
        if (!webR.exists()) {
            alert('Does not exist: ' + url);
        delete this.categories[categoryName];
        lively.PartsBin.removePartsSpace(name);
        this.updateCategoryList();
        return
        }
        webR.getSubElements()
        if (!webR.subDocuments || webR.subDocuments.length > 0 ||
            !webR.subCollections || webR.subCollections.length > 0) {
            alert('Will not remove directory ' + url + ' because it is not empty')
        } else {
            webR.del();
            Global.alertOK('Removed ' + categoryName + ' url ' + url);
        }
        delete this.categories[categoryName];
        lively.PartsBin.removePartsSpace(name);
        this.updateCategoryList();
    },
        removeCategoryInteractively: function removeCategoryInteractively() {
        var partsBin = this, world = this.world();
        world.confirm('Really remove ' + this.categoryName + '?', function(result) {
        if (!result) {
           alert('no category removed!')
           return;
        }
        partsBin.removeCategory(partsBin.categoryName)
        });
    },
        removeParts: function removeParts() {
        this.get('partsBinContents').submorphs.clone().invoke('remove');
    },
        reset: function reset() {
        // this.get("PartsBinURLChooser").showHalos()
        lively.bindings.disconnect(this.get("PartsBinURLChooser"), 'selection', this, 'setPartsBinURL');
        this.connections = {toggleMorePane: {}};
        this.setSelectedPartItem(null);
        delete this.categories;
        this.getPartsBinMetaInfo().requiredModules = ['lively.PartsBin'];
        this.get('categoryList').updateList([]);
        this.get('partsBinContents').removeAllMorphs();
        this.get('searchText').setTextString("");
        this.get("PartsBinURLChooser").setList([]);
        lively.bindings.connect(this.get("PartsBinURLChooser"), 'selection', this, 'setPartsBinURL');
        this.url = null;
    },
        saveCommentForSelectedPartItem: function saveCommentForSelectedPartItem(comment) {
        if (!this.selectedPartItem) {
        alert('no item selected!')
        return;
        }
        var metaInfo = this.selectedPartItem.getMetaInfo();
        metaInfo.setComment(comment);
        this.selectedPartItem.uploadMetaInfoOnly();
    },
        search: function search(searchString) {
        // triggers search in this.loadPartsOfCategory through connection
        var list = this.get('categoryList');
        list.deselectAll();
        list.setSelection("*search*");
    },
        setMetaInfoOfSelectedItem: function setMetaInfoOfSelectedItem(metaInfo) {
        var comment = (metaInfo && metaInfo.getComment()) ||
            'No comment yet';
        // this.get('CommitLog').setTextString(this.commitLogString(metaInfo))
        this.setSelectedPartVersions(metaInfo && metaInfo.changes)
        this.get('selectedPartComment').textString = comment;
    },
        setPartsBinURL: function setPartsBinURL(url) {
        lively.PartsBin.partSpaces = {};
        this.url = url;
        this.reloadEverything();
    },
        setSelectedPartItem: function setSelectedPartItem(item) {
        this.selectedPartItem = item;
        this.get('selectedPartComment').textString = '';
        this.get('selectedPartIdentityMeta').textString = '';
        // this.get('CommitLog').textString = '';
        this.get('selectedPartVersions').updateList(item ? ['Loading versions...']: []);
        this.get('selectedPartVersions').setSelection(null);
        if (!item) {
            this.get('selectedPartName').textString = ''
            // '#'-prefixed identity tag categories (see loadIdentityTagCategory)
            // aren't WebDAV directories — getPartsSpaceForCategory would try to
            // resolve one as a URL and throw (confirmed live: "pathString.startsWith
            // is not a function", which aborted this entire method before
            // loadPartsOfCategory's '#' dispatch branch ever ran, since this
            // runs first via loadPartsOfCategory's own setSelectedPartItem(null)).
            this.get('selectedPartSpaceName').textString = this.categoryName ? (
                (this.categoryName.startsWith('*') || this.categoryName.charAt(0) === '#') ? this.categoryName :
                this.getPartsSpaceForCategory(this.categoryName).getName()) : '';
            return;
        }
        this.get('selectedPartName').textString = item.name
        this.get('selectedPartSpaceName').textString = this.describePartItemSource(item)
        this.renderIdentityPartMeta(item)

        // load versions
        Global.connect(item, 'partVersions', this, 'setSelectedPartVersions');
        item.loadPartVersions(true);

        // load meta info
        Global.connect(item, 'loadedMetaInfo', this, 'setMetaInfoOfSelectedItem');

        this.setShareLink(item);

        item.loadPartMetaInfo(true);
    },
        setSelectedPartVersions: function setSelectedPartVersions(versions) {
        var listMorph = this.get('selectedPartVersions');
        var list = listMorph.itemList.length !== 1 ||
                !listMorph.itemList.include('Loading versions...') ? listMorph.itemList : [];
        // merge lists
        (versions || []).each(function(newItem) {
            var oldDuplicate = list.find(function(oldItem) {
                // 2 items considered same with 2sec time diff and same author
                return Math.abs(Date.parse(oldItem.value.date) -
                        Date.parse(newItem.date)) <=10000 &&
                    oldItem.value.author === newItem.author
            })
            if (oldDuplicate) { // merge entries if redundant
                var oldFormatted = this.formatVersionEntry(Object.merge([newItem, oldDuplicate.value]));

                oldDuplicate.value = oldFormatted.value;
                oldDuplicate.string = oldFormatted.string;
            } else { // add new entry if not
                // here
                list.push(this.formatVersionEntry(newItem));
            }
        },this)
        list.sort(function(a, b) {
            return Date.parse(a.value.date) - Date.parse(b.value.date)
        })
        listMorph.updateList(list)
    },
        // Reused for the "space name" label: for a WebDAV part this is just
        // its partsSpaceName (unchanged behavior). For an identity-published
        // part (item.envelope set by IdentityPartsSpace.createPartItemFromEnvelope)
        // the WebDAV path is meaningless — show the publisher's handle
        // instead. Deliberately just the handle, not handle+date: this label
        // shares a tight, fixed-width HorizontalLayout row with the part
        // name/Share Link/inspect controls (MoreTitleContainer) with no room
        // to grow, and a longer string here doesn't wrap onto a visible
        // second line — it gets clipped. Full detail (including the publish
        // date) lives in describeIdentityPartMeta below, which has real room.
        describePartItemSource: function describePartItemSource(item) {
        if (!item.envelope) return item.partsSpaceName;
        return '@' + (item.handle || '?');
    },
        // Builds the metadata text plus the character range of the trailing
        // copy-icon glyph, so renderIdentityPartMeta can apply a click
        // handler to just that glyph via emphasize(). Returns null for
        // WebDAV parts (no envelope).
        describeIdentityPartMeta: function describeIdentityPartMeta(item) {
        if (!item.envelope) return null;
        var env = item.envelope;
        var created = env.created ? new Date(env.created).format('yyyy-mm-dd HH:MM') : 'unknown';
        // Full DIDs run ~200 chars — even at this panel's widened ~320px
        // column that's still too long for one line at full length, so it's
        // truncated for display; the icon glyph appended right after it
        // copies the full value (see renderIdentityPartMeta).
        var did = env.did || 'unknown';
        var didShort = did.length > 30 ? (did.slice(0, 20) + '…' + did.slice(-6)) : did;
        var iconGlyph = '⧉';
        var line1 = 'Published by: @' + (item.handle || '?');
        var line2 = 'Created: ' + created;
        // Icon sits at the end of THIS line, not the end of the full text —
        // text.length (what this used to compute iconStart/iconEnd from)
        // is the length of the whole 4-line string, which points past the
        // Hosting line entirely. Confirmed live: the emphasis landed on the
        // 'd' in "...world" instead of the icon, making it both invisible
        // as a clickable target and a stray blue-underlined character
        // where nothing should be styled.
        var didLinePrefix = 'Object ID: ' + (env.objId || 'unknown') + '   Author DID: ' + didShort + ' ';
        var didLine = didLinePrefix + iconGlyph;
        var line4 = 'Hosting: ' + (Global.URL.root.hostname || 'unknown');
        var text = [line1, line2, didLine, line4].join('\n');
        var iconStart = line1.length + 1 + line2.length + 1 + didLinePrefix.length;
        var iconEnd = iconStart + iconGlyph.length;
        return { text: text, did: env.did || null, iconStart: iconStart, iconEnd: iconEnd };
    },
        // Sets selectedPartIdentityMeta's text and, for identity parts,
        // makes the trailing copy-icon glyph clickable via a ranged
        // emphasis (same mechanism the static "Share Link"/"inspect" labels
        // use elsewhere in this file, just applied dynamically since the
        // text and the icon's position both vary per selection). Icon-only,
        // positioned inline right after the DID it copies — same idea as
        // ProfileCard.js's copy-DID button, adapted to sit inside flowing
        // text instead of as a separate morph.
        renderIdentityPartMeta: function renderIdentityPartMeta(item) {
        var metaMorph = this.get('selectedPartIdentityMeta');
        var meta = this.describeIdentityPartMeta(item);
        metaMorph.textString = meta ? meta.text : '';
        metaMorph._copyAuthorDid = meta ? meta.did : null;
        if (!meta) return;
        metaMorph.emphasize({
            color: Color.blue,
            doit: {
                code: "var m = evt.getTargetMorph();" +
                    "if (!m._copyAuthorDid || !navigator.clipboard) return;" +
                    "navigator.clipboard.writeText(m._copyAuthorDid);",
                context: null
            }
        }, meta.iconStart, meta.iconEnd);
    },
        setShareLink: function setShareLink(partItem) {
        var linkText = this.get('shareLink');
        linkText.setTextString('Share Link');
        var url;
        if (partItem.envelope && partItem.envelope.objId && partItem.handle) {
            url = Global.URL.root + '@' + partItem.handle + '/parts/' + partItem.envelope.objId;
        }
        if (!url) {
            url = Global.URL.root + 'viral.html?part='
                + partItem.name + '&path=' + partItem.partsSpaceName.replace(/\//g, '%2F');
        }
        // Copies to the clipboard instead of navigating (same doit-emphasis
        // mechanism as the DID-copy icon in renderIdentityPartMeta above)
        // since a share link is meant to be pasted elsewhere, not opened —
        // opening it here just reloaded this same PartsBin/Inventory view
        // in a new tab instead of showing anything useful.
        linkText._shareUrl = url;
        linkText.emphasizeAll({
            color: Color.blue,
            doit: {
                // Reverts by re-running setShareLink (rather than just
                // setTextString('Share Link')) since setTextString may
                // drop the chunk-level doit/emphasis along with the old
                // text, which would leave the label unclickable after the
                // first copy. Re-running also self-corrects if the
                // selected item changed during the timeout.
                code: "var m = evt.getTargetMorph();" +
                    "if (!m._shareUrl || !navigator.clipboard) return;" +
                    "navigator.clipboard.writeText(m._shareUrl);" +
                    "m.setTextString('Copied!');" +
                    "var pb = m.get('PartsBinBrowser');" +
                    "setTimeout(function() { pb ? pb.setShareLink(pb.selectedPartItem) : m.setTextString('Share Link'); }, 1200);",
                context: null
            }
        });
    },
        setupConnections: function setupConnections() {
        Global.connect(this.closeButton, 'fire', this, 'remove')
        Global.connect(this.addCategoryButton, 'fire', this, 'addCategoryInteractively')
        Global.connect(this.get('removeCategoryButton'), 'fire', this, 'removeCategoryInteractively')
        Global.connect(this.get('categoryList'), 'selection', this, 'categoryName')
        Global.connect(this, 'categoryName', this, 'loadPartsOfCategory')

        Global.connect(this.get('partsBinContents'), 'selectedItem', this, 'setSelectedPartItem')

        Global.connect(this.get('reloadButton'), "fire", this, "reloadEverything")

        Global.connect(this.get('loadPartButton'), "fire", this, "loadAndOpenSelectedPartItem")

        Global.connect(this.get('removePartButton'), "fire", this, "interactivelyRemoveSelectedPartItem")

        Global.connect(this.get('movePartButton'), "fire", this, "interactivelyMoveSelectedPartItem")
        Global.connect(this.get('copyPartButton'), "fire", this, "interactivelyCopySelectedPartItem")

        Global.connect(this.get('selectedPartComment'), "savedTextString", this, "saveCommentForSelectedPartItem")
    },
        showCommits: function showCommits() {
        if (!this.selectedPartItem) {
            alert('nothing selected');
            return;
        }
        var metaInfo = this.selectedPartItem.loadedMetaInfo;
        this.world().addTextWindow({
            title: 'Commits of ' + metaInfo.partName,
            content: this.commitLogString(metaInfo)
        });
    },
        showMsg: function showMsg(string) {
        var label = new lively.morphic.Text(new Global.Rectangle(0,0,200,30), string);
        label.applyStyle({fill: null, borderWidth: 0})
        this.get('partsBinContents').addMorph(label)
    },
        toggleMorePane: function toggleMorePane() {
        this.withCSSTransitionForAllSubmorphsDo(function () {
            var pane = this.get('MoreContainer'),
                title = this.get('MoreTitleContainer'),
                minY = this.get('CategorieContainer').getExtent().y - 250,
                maxY = this.get('CategorieContainer').getExtent().y + 3;
            this.get('MoreDivider').movedVerticallyBy(this.moreToggled ?
            maxY - pane.getPosition().y + this.get('MoreDivider').getExtent().y - 2: minY - pane.getPosition().y)
        }.bind(this), 350, function() {
            // this is set by MoreDivider
            // this.moreToggled = !this.moreToggled;
        }.bind(this))
    },
        updateCategoriesDictFromPartsBin: function updateCategoriesDictFromPartsBin(thenDo) {
        delete this.categories;
        this.ensureCategories();
        var webR = new Global.WebResource(this.partsBinURL()).noProxy().beAsync().getSubElements();

        var callback = function(collections) {
            collections.forEach(function(dir) {
                var unescape = Global.urlUnescape || Global.unescape,
                    unescaped = unescape(dir.getURL().filename()),
                    name = unescaped.replace(/\/$/,"");
                if (name.startsWith('.')) return;
                this.categories[name] = this.partsBinURL().withFilename(unescaped);
            }, this);
            this.updateCategoryList(this.categoryName);
            thenDo && thenDo.call(this);
        }.bind(this);

        lively.bindings.connect(webR, 'subCollections', {cb: callback}, 'cb', {
            updater: function($upd, value) {
                if (!(this.sourceObj.status && this.sourceObj.status.isDone())) return;
                if (!value) return;
                $upd(value);
            }
        });
    },
        updateCategoryList: function updateCategoryList(optCategoryName, doNotUpdate) {
        this.get('categoryList').updateList(
          lively.lang.properties.own(this.categories)
            .sortBy(function(name) { return name.toLowerCase()}));
        if (!doNotUpdate)
            this.get('categoryList').setSelection(optCategoryName)
    },
        updatePartsBinURLChooser: function updatePartsBinURLChooser() {
        // this.updatePartsBinURLChooser();
        this.get("PartsBinURLChooser").setList(lively.PartsBin.getPartsBinURLs());
    }
    }],
    titleBar: "Smalltalk Zoo",
    onFromBuildSpecCreated: function onFromBuildSpecCreated() {
        $super();
        this.targetMorph.onLoad();
        this.get('MoreDivider').scalingAbove = [this.get('CategoryContentContainer')];
        this.get('MoreDivider').scalingBelow = [this.get('MoreContainer')];
        this.get('MoreDivider').fixed = [];
        this.get('LeftRightDivider').scalingLeft = [this.get('LeftSideContainer')];
        this.get('LeftRightDivider').scalingRight = [this.get('CategorieContainer')];
        this.get('LeftRightDivider').fixed = [];
        this.get('VersionDivider').scalingLeft = [this.get('InfoContainer')];
        this.get('VersionDivider').scalingRight = [this.get('CommitContainer')];
        this.get('searchText').setTextString('enter search term');
        // this.get('PartsBinBrowser').lock();
    },
    onLoadFromPartsBin: function onLoadFromPartsBin() {
        $super();
        this.targetMorph.reloadEverything();
    },
    reset: function reset() {
        // this.partsBinMetaInfo = x.getPartsBinMetaInfo()
    }
});

}) // end of module
