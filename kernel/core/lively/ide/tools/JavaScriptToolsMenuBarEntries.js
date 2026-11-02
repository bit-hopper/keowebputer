module("lively.ide.tools.JavaScriptToolsMenuBarEntries").requires("lively.morphic.tools.MenuBar").toRun(function() {

lively.BuildSpec('lively.ide.tools.JavaScriptToolsMenuBarEntry', lively.BuildSpec("lively.morphic.tools.MenuBarEntry").customize({

  name: "jsToolsMenuBarEntry",
  menuBarAlign: "left",
  textString: "open",

  style: lively.lang.obj.merge(lively.BuildSpec("lively.morphic.tools.MenuBarEntry").attributeStore.style, {
    align: "center",
    extent: lively.pt(60,20),
    textColor: Color.gray.darker(),
    toolTip: "Access to JavaScript tools",
  }),

  morphMenuItems: function morphMenuItems() {
    function cmd(name) { return function() { lively.ide.commands.exec(name); }; }
    return [
      ['Inventory', cmd("lively.PartsBin.open")],
      ['JavaScript Workspace', cmd('lively.ide.openWorkspace')],
      ['JavaScript Browser', cmd('lively.ide.openSystemCodeBrowser')],
      ['Subserver Viewer', cmd('lively.ide.openSubserverViewer')]
    ]
  },

  update: function update() {},
  
}));

lively.BuildSpec('lively.ide.tools.LivelySearchMenuBarEntry', lively.BuildSpec("lively.morphic.tools.MenuBarEntry").customize({

  name: "livelySearchMenuBarEntry",
  menuBarAlign: "left",
  textString: "search",

  style: lively.lang.obj.merge(lively.BuildSpec("lively.morphic.tools.MenuBarEntry").attributeStore.style, {
    align: "center",
    extent: lively.pt(60,20),
    textColor: Color.gray.darker(),
    toolTip: "Search morphs, worlds, files and code (shift-click for the older tools)",
  }),

  // A click opens (or closes) the search palette; shift-click opens the dropdown of
  // the older tools, which the palette does not replace (they use the server).
  // The palette keeps this entry's pink "open" look in step (setPaletteActive).
  onMouseUp: function onMouseUp(evt) {
    evt.stop();
    if (evt.isShiftDown && evt.isShiftDown()) {
      this.update();
      if (this.menu) this.removeMenu(); else this.showMenu();
      return true;
    }
    if (this._openingPalette) return true;   // the module is still loading: a second click must not toggle it shut
    this._openingPalette = true;
    var self = this;
    lively.require("lively.ide.tools.SearchPalette").toRun(function () {
      self._openingPalette = false;
      lively.ide.tools.SearchPalette.toggle();
    });
    return true;
  },

  setPaletteActive: function setPaletteActive(on) {
    this.applyStyle(on ? {fill: Color.rgb(240, 26, 105), textColor: Color.white} : {fill: null, textColor: Color.gray.darker()});
  },

  morphMenuItems: function morphMenuItems() {
    function cmd(name) { return function() { lively.ide.commands.exec(name); }; }
    return [
      ['Code search', cmd('lively.ide.codeSearch')],
      ['Search for worlds, modules, parts', cmd('lively.ide.resourceSearch')],
      ['Search for files', cmd('lively.ide.browseFiles')],
      ['Search in files', cmd('lively.ide.CommandLineInterface.doGrepSearch')]
    ]
  },

  update: function update() {},
  
}));

Object.extend(lively.ide.tools.JavaScriptToolsMenuBarEntries, {

  getMenuBarEntries: function() {
    return [
      lively.BuildSpec('lively.ide.tools.JavaScriptToolsMenuBarEntry').createMorph(),
      lively.BuildSpec('lively.ide.tools.LivelySearchMenuBarEntry').createMorph()]
  }
});

}) // end of module
