module('lively.morphic.tools.MenuBar').requires("lively.persistence.BuildSpec").toRun(function() {

lively.BuildSpec("lively.morphic.tools.MenuBar", {
    isEpiMorph: true,
    _Position: lively.pt(-1.0,-1.0),
    className: "lively.morphic.Box",
    draggingEnabled: false,
    droppingEnabled: false,
    grabbingEnabled: false,
    style: {
      fill: Color.rgba(255,255,255,0.62),
      borderWidth: 0,
      borderRadius: 16,
      clipMode: "hidden",
      adjustForNewBounds: true
    },
    layout: { adjustForNewBounds: true, resizeHeight: false, resizeWidth: true },
    name: "MenuBar",
    isGlobalMenuBar: true,

    leftsAndRights: function leftsAndRights() {
      var mid = this.innerBounds().center().x;
      return this.submorphs
        .sortBy(function(ea) { return ea.getPosition().x; })
        .partition(function(ea) { return ea.bounds().topRight().x < mid; });
    },

    // Entries are centered vertically (each at its own height) and the right-most
    // entry keeps the same margin to the bar's end as it has above and below.
    relayout: function relayout() {
      var innerH = this.innerBounds().height;
      function midY(m) { return (innerH - m.getExtent().y) / 2; }
      var morphs = this.leftsAndRights();
      morphs[0].reduce(function(pos, ea) {
        ea.setPosition(pt(pos, midY(ea)));
        return ea.bounds().right();
      }, 0);
      var last = morphs[1].last();
      morphs[1].reduceRight(function(pos, ea) {
        ea.setPosition(pt(pos-ea.bounds().width, midY(ea)));
        return ea.bounds().left();
      }, this.innerBounds().right() - (last ? midY(last) : 0));
    },

    // The frosted-glass pill look; blur/shadow have no morphic style, so those go to the DOM.
    // The thin pink outline is an inset ring in the box-shadow, not a real border: Lively
    // floors fractional borderWidths to 0, and a real 1px border is drawn at 0.667px at
    // fractional device-pixel ratios, which skews the bar's width and the entries' centering.
    applyPillChrome: function applyPillChrome() {
      var M = lively.morphic.tools.MenuBar;
      this.applyStyle({
        fill: Color.rgba(255,255,255,0.62),
        borderWidth: 0,
        borderRadius: M.HEIGHT / 2,
        clipMode: "hidden"
      });
      var node = this.renderContext().shapeNode;
      if (!node) return;
      node.style.backdropFilter = node.style.webkitBackdropFilter = M.BACKDROP_FILTER;
      node.style.boxShadow = "inset 0 0 0 " + M.RING_WIDTH + "px " + M.RING_COLOR + ", " + M.BOX_SHADOW;
    },

    add: function add(morph) {
      if (morph.name) {
        var existing = this.get(morph.name);
        existing && existing.remove();
      }

      var align = morph.menuBarAlign || "left";
      var posGroups = this.leftsAndRights();

      if (align === "right") {
        var rightMorph = posGroups[1].first();
        var pos = rightMorph ? rightMorph.bounds().topLeft() : this.innerBounds().topRight();
        morph.applyStyle({moveHorizontal: true});
      } else {
        var leftMorph = posGroups[0].last();
        var pos = leftMorph ? leftMorph.bounds().topRight() : this.innerBounds().topLeft();
      }

      this.addMorph(morph);
      morph.setExtent(morph.getExtent().withY(morph.entryHeight || lively.morphic.tools.MenuBar.ENTRY_HEIGHT));
      morph.align(morph.bounds()[align === "right" ? "topRight" : "topLeft"](), pos);
      morph.recenterText && morph.recenterText();
      this.relayout();
    },

    // Floating pill: inset from the top and sides of the visible world.
    alignInWorld: function alignInWorld() {
      var M = lively.morphic.tools.MenuBar, wBounds = $world.visibleBounds();
      this.align(this.bounds().topLeft(), wBounds.topLeft().addXY(M.INSET, M.INSET));
      this.setExtent(pt(wBounds.width - 2 * M.INSET, M.HEIGHT));
      this.applyPillChrome();
      this.relayout();
    },

    onMouseDownEntry: function onMouseDownEntry(evt) {
      var tMorph = evt.getTargetMorph();
      if (tMorph && tMorph.ownerChain().include(this)) {
        return $super(evt);
      }
      var morph = $world.submorphs.without(this).reverse().detect(function(ea) {
        return ea.fullContainsWorldPoint(evt.getPosition()); });
      if (morph) return morph.onMouseDownEntry(evt);
      return false;
    },

    onWorldResize: function onWorldResize() {
      lively.lang.fun.debounceNamed(this.id + '-onWorldResize', 300,
        this.alignInWorld.bind(this))();
    },

    removeEntry: function removeEntry(morph) {
      var m = this.getMorphNamed(morph.name);
      m && m.remove();
    },

    reset: function reset() {
      this.removeAllMorphs();
      this.disableGrabbing();
      this.disableDragging();
    },

    onLoad: function onLoad() {
      this.enableFixedPositioning();
      this.alignInWorld();
      return this;
    }

});

lively.BuildSpec("lively.morphic.tools.MenuBarEntry", {

  className: "lively.morphic.Text",
  name: "unnamed menu bar entry",
  textString: "",
  doNotSerialize: ["menu"],
  changeColorForMenu: true,

  style: {
    enableGrabbing: false,
    enableDragging: false,
    padding: lively.Rectangle.inset(6,2,6,0),
    align: "center",
    selectable: false,
    allowInput: false,
    clipMode: "hidden",
    extent: lively.pt(130,20),
    fixedHeight: true,
    fixedWidth: true,
    fontFamily: "'Helvetica Neue',Helvetica,sans-serif",
    whiteSpaceHandling: "pre",
    handStyle: "pointer",
    borderRadius: 12,
    fill: null,
    textColor: Color.gray.darker()
  },

  onMouseUp: function onMouseUp(evt) {
    this.update();
    if (this.menu) this.removeMenu();
    else this.showMenu();
    evt.stop(); return true;
  },

  morphMenuItems: function morphMenuItems() {
    return [["empty menu entry", function() { show("implement me!"); }]];
  },

  showMenu: function showMenu() {
    if (this.changeColorForMenu)
      this.applyStyle({fill: Color.rgb(240, 26, 105), textColor: Color.white});
    var items = this.morphMenuItems();
    // the bar floats above the world, so open the menu below the bar (not just below the entry)
    // and, once its width is known, keep its right edge inside the bar's right edge
    var M = lively.morphic.tools.MenuBar,
        bar = this.owner && this.owner.isGlobalMenuBar ? this.owner : null,
        entryBounds = this.globalBounds(),
        barBounds = bar ? bar.globalBounds() : entryBounds,
        pos = pt(entryBounds.left(), barBounds.bottom() + M.MENU_GAP);
    var menu = this.menu = lively.morphic.Menu.openAt(pos, null, items);
    lively.bindings.connect(menu, 'remove', this, 'removeMenu');
    (function() {
      if (!menu.owner) return;
      var overflow = menu.globalBounds().right() - barBounds.right();
      if (overflow > 0) menu.setPosition(menu.getPosition().addXY(-overflow, 0));
    }).delay(0.05);
  },

  removeMenu: function removeMenu() {
    var self = this;
    lively.lang.fun.debounceNamed(this.id+"removemenu", 100, function() {
      if (self.changeColorForMenu)
        self.applyStyle({fill: null, textColor: Color.gray.darker()});
      self.menu && self.menu.remove();
      self.menu = null;
    })();
  },

  // -=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-

  update: function update() {
    // implement me!
  },

  updateText: function updateText(text) {
    if (this.textString === text) return;
    var topRight = this.bounds().topRight();
    this.textString = text;
    this.applyStyle({fixedWidth: false, clipMode: "visible"});
    this.fitThenDo(function() {
      this.applyStyle({fixedWidth: true, clipMode: "hidden"});
      this.fixedWidth = true;
      this.owner && this.owner.relayout && this.owner.relayout();
      this.recenterText();
    }.bind(this));
  },

  // CSS vertical-align is a no-op on Lively's text morphs (they render as
  // plain block divs — see SkyWidget.js's _recenterLabel for the same fix).
  // Sizes the entry to its pill height and pads the top by half the
  // box/line difference, keeping whatever left/right padding is already
  // set (icon space, etc.) untouched.
  // getTextExtent() isn't usable for this: once the morph has an extent it just
  // echoes the box height back. Measure the rendered line instead. Padding has to
  // be set BEFORE the extent — setExtent derives the CSS height from the padding
  // in effect at that moment, so the other order leaves a stale, lopsided height.
  recenterText: function recenterText() {
    var text = this.getTextString ? this.getTextString() : this.textString;
    if (!text) return;
    var H = this.entryHeight || lively.morphic.tools.MenuBar.ENTRY_HEIGHT,
        node = this.renderContext().shapeNode,
        span = node && node.querySelector('span'),
        lineH = span ? span.getBoundingClientRect().height : 0;
    // not laid out yet: estimate from the font size (points -> px, line box ~1.1x)
    if (!lineH) lineH = this.getFontSize() * 4/3 * 1.1;
    var pad = this.getPadding(),
        topPad = Math.max(0, (H - lineH) / 2);
    this.applyStyle({ padding: lively.Rectangle.inset(pad.left(), topPad, pad.right(), 0) });
    this.setExtent(this.getExtent().withY(H));
  },

  onLoad: function onLoad() {
    (function() { this.update(); }).bind(this).delay(0);
    this.startStepping(30*1000, "update");
  },

  onFromBuildSpecCreated: function onFromBuildSpecCreated() {
    this.onLoad();
  }
});

// -=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-

Object.extend(lively.morphic.tools.MenuBar, {

  // Floating pill geometry (px). BuildSpec methods are rebuilt from source and
  // lose their closure, so everything they need lives here.
  INSET: 10,                 // gap between the bar and the top/sides of the world
  HEIGHT: 32,                // bar height
  ENTRY_HEIGHT: 24,          // height of a regular entry (its pill highlight)
  MENU_GAP: 6,               // gap between the bar and a dropdown menu
  RING_WIDTH: 0.5,           // thin pink outline (px, may be < 1)
  RING_COLOR: "rgb(240,26,105)",
  BACKDROP_FILTER: "blur(18px) saturate(180%)",
  BOX_SHADOW: "0 4px 18px rgba(0,0,0,0.14), 0 1px 3px rgba(0,0,0,0.10)",

  openOnWorldLoad: function() {
    // lively.morphic.tools.MenuBar.openOnWorldLoad();
    if (typeof $world === "undefined") {
      return lively.whenLoaded(function() {
        lively.morphic.tools.MenuBar.openOnWorldLoad();
      })
      return;
    }

    if ($world._MenuBarHidden) {
      lively.morphic.tools.MenuBar.remove();
      return;
    }

    lively.morphic.tools.MenuBar.addEntries(
      lively.Config.get("menuBarEntries"));
  },

  open: function() {
    var menuBar = $world.get(/^MenuBar/);
    // menuBar.remove()
    if (menuBar && !menuBar.isGlobalMenuBar)
      menuBar = null;

    // A menu bar already saved into a world (the common case — worlds
    // persist their morphs) is reused as-is here rather than rebuilt, so
    // dimension changes to this BuildSpec (e.g. bar height) would otherwise
    // never reach it. Re-run alignInWorld() on the reused bar too, so it
    // always picks up the current height/width, not whatever was baked in
    // at the time the world was last saved.
    if (menuBar) {
      menuBar.alignInWorld();
      return menuBar;
    }

    return lively.BuildSpec("lively.morphic.tools.MenuBar")
        .createMorph().openInWorld().onLoad();
  },

  remove: function() {
    var menuBar = $world.get(/^MenuBar/);
    if (menuBar && menuBar.isGlobalMenuBar) menuBar.remove();
  },

  addEntries: function(entries) {
    if (!$world) {
      (function() {
        lively.morphic.tools.MenuBar.addEntries(entries)
      }).delay(0.5);
      return;
    }

    lively.lang.arr.mapAsyncSeries(entries,
      function(ea, _, n) {
        if (typeof ea === "string") {
          lively.require(ea).toRun(function() {
            var entries = [];
            try { entries = module(ea).getMenuBarEntries(); } catch (e) {}
            n(null, entries);
          });
        } else { n(null, ea); }
    }, function(err, entries) {
        var bar = lively.morphic.tools.MenuBar.open();
        entries.flatten().forEach(bar.add.bind(bar));
        (function() { bar.relayout(); }).delay(0);
        // entries were first sized before their text was laid out; re-center once it is
        (function() {
          bar.submorphs.forEach(function(ea) { ea.recenterText && ea.recenterText(); });
          bar.relayout();
        }).delay(0.4);
      });
  },

  addEntry: function(menuBarEntry) { return this.open().add(menuBarEntry); }
});

}); // end of module
