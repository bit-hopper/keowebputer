/**
 * lively.identity.HomestarMap
 *
 * The homestar's "Where I have been" panel: a Leaflet map of the postcards on
 * this page that carry a location and that the viewer may read. Clicking a pin
 * jumps the postcard reel to that card; the card the reel is showing has the
 * violet pin.
 *
 * The map itself (Leaflet loading, sizing, the fan-out of pins that share a
 * ~5.5 km Plus Code cell) is ConstellationMap's; HomestarMap only changes where
 * the cards come from, how a pin looks, and adds a faint halo that shows how
 * coarse a location is. The lounge is not touched.
 *
 * Like the reel, one HomestarMapPanel lives for the whole page: the controller
 * rebuilds its own morphs on every fetch and resize, but a Leaflet map must not
 * be rebuilt, so the panel keeps its morphs and is only re-positioned with
 * attach(x, y, w). It stays hidden (and takes no room) until the located cards
 * have loaded and there is at least one.
 *
 * Handlers below are plain closures in an Object.subclass, not BuildSpec or
 * addScript, so module-level helpers are safe to reference.
 */

module("lively.identity.HomestarMap")
  .requires(
    "lively.identity.HomestarUI",
    "lively.identity.ConstellationMap",
    "lively.morphic.Complete",
  )
  .toRun(function () {

    var UI = lively.identity.HomestarUI;
    var MUTED = UI.MUTED;
    var icon = UI.icon, label = UI.label, panel = UI.panel, pill = UI.pill;

    var PAGE_SIZE = 100, MAX_CARDS = 500;
    var MAP_H = 260;
    var CELL_HALO_M = 2750;     // half of the ~5.5 km cell the location is floored to
    var VIOLET = "#7c4dff";
    var VISIBLE_TO = { anyone: "Shown to anyone", friends: "Shown to friends", orbit: "Shown to your orbit", "private": "Shown to only you" };

    function pinHtml(current) {
      var d = current ? 30 : 24;
      return '<div style="width:' + d + 'px;height:' + d + 'px;display:flex;align-items:center;' +
        'justify-content:center;background:#fff;border:2px solid ' + (current ? VIOLET : "#d33") + ';' +
        'border-radius:50%;box-shadow:0 1px 4px rgba(0,0,0,0.3);font-size:' + (current ? 15 : 12) + 'px;line-height:1;">✉️</div>';
    }

    // ConstellationMap with its cards handed in, and pins that know which one is
    // current. opts: { cards, onPin(objId), onPlaced(placedCount, cellCount) }
    lively.identity.ConstellationMap.subclass(
      "lively.identity.HomestarMapView",

      "cards", {
        _fetchPage: function () {
          this._cards = (this._opts.cards || []).slice();
          this._markers = {};
          // _current is left alone: the reel can name its card before the map is sized.
          this._placeAll();
        },

        _placeMarkers: function ($super) {
          $super();
          var L = window.L;
          var seen = {}, cells = 0;
          var olc = new window.OpenLocationCode();
          this._cards.forEach(function (c) {
            var loc = c.state && c.state.location;
            if (!loc || seen[loc]) return;
            seen[loc] = true;
            var area;
            try { area = olc.decode(loc); } catch (e) { return; }
            cells++;
            // Under the pins: how far off a location may be, not where anyone is.
            L.circle([area.latitudeCenter, area.longitudeCenter], {
              radius: CELL_HALO_M, color: "#e8497e", weight: 1, opacity: 0.35,
              fillColor: "#e8497e", fillOpacity: 0.08, interactive: false,
            }).addTo(this._map);
          }, this);
          this._setStatus("");
          if (this._opts.onPlaced) this._opts.onPlaced(Object.keys(this._markers).length, cells);
        },

        _addMarker: function (latlng, postcard) {
          var self = this;
          var marker = window.L.marker(latlng, { icon: this._iconFor(false), zIndexOffset: 0 }).addTo(this._map);
          var tip = document.createElement("span");
          tip.textContent = (postcard.state && postcard.state.title) || "(untitled)";
          marker.bindTooltip(tip);
          marker.on("click", function () {
            if (self._opts.onPin) self._opts.onPin(postcard.objId);
          });
          this._markers[postcard.objId] = marker;
          if (this._current === postcard.objId) this._paintCurrent(postcard.objId);
        },

        _iconFor: function (current) {
          var d = current ? 30 : 24;
          return window.L.divIcon({
            className: "lively-homestarmap-marker",
            html: pinHtml(current),
            iconSize: [d, d],
            iconAnchor: [d / 2, d / 2],
          });
        },

        // The pin for the card the reel is showing is violet and drawn on top.
        setCurrent: function (objId) {
          var prev = this._current;
          this._current = objId;
          if (!this._map) return;
          if (prev && prev !== objId && this._markers[prev]) {
            this._markers[prev].setIcon(this._iconFor(false));
            this._markers[prev].setZIndexOffset(0);
          }
          this._paintCurrent(objId);
        },

        _paintCurrent: function (objId) {
          var m = this._markers && this._markers[objId];
          if (!m) return;
          m.setIcon(this._iconFor(true));
          m.setZIndexOffset(1000);
        },
      }
    );

    Object.subclass("lively.identity.HomestarMapPanel",
    "init", {
      // opts: { handle, shown, isOwner, onPin(objId), onManage(), getCurrent(), getHidden(), onResize() }
      initialize: function (opts) {
        this._getCurrent = opts.getCurrent || null;
        this._getHidden = opts.getHidden || null;
        this._handle = opts.handle;
        this._shown = opts.shown || opts.handle;
        this._isOwner = !!opts.isOwner;
        this._onPin = opts.onPin || null;
        this._onManage = opts.onManage || null;
        this._onResize = opts.onResize || null;
        this._cards = [];             // every located card this viewer may see (the owner's include non-public ones)
        this._locked = false;         // the owner does not show their map to this viewer
        this._visibility = "anyone";  // who the owner shows it to (only the owner is told)
        this._loaded = false;
        this._shownPanel = false;     // there is something to draw
        this._built = false;
        this._current = null;
        this._w = 0;
        this._load(null);
      },

      dispose: function () {
        if (this._map) this._map.remove();
        if (this._panel) this._panel.remove();
      },
    },

    "feed", {
      // Pages through the located cards the server lets this viewer see. Only the
      // owner's map carries a card that is not public: a shared or private card is
      // theirs to see there, and nobody else's pin shows it even if they can read it.
      _load: function (cursor) {
        var self = this;
        var url = "/@" + encodeURIComponent(this._handle) + "/postcards?hasLocation=1&sort=new&limit=" + PAGE_SIZE +
          (cursor ? "&cursor=" + encodeURIComponent(cursor) : "");
        UI.getJSON(url, function (err, body) {
          var rows = ((body && body.postcards) || []).filter(function (c) {
            return c.state && c.state.location && (self._isOwner || (c.visibility || "public") === "public");
          });
          if (body && body.locked) self._locked = true;
          if (body && body.mapVisibility) self._visibility = body.mapVisibility;
          self._cards = self._cards.concat(rows);
          if (body && body.cursor && self._cards.length < MAX_CARDS) return self._load(body.cursor);
          self._loaded = true;
          self._refresh();
        });
      },

      // The ids the owner chose to keep off the map (profile.homestar.mapHidden).
      hiddenIds: function () {
        var ids = this._getHidden ? this._getHidden() : [];
        return Array.isArray(ids) ? ids : [];
      },

      // Every located card the viewer may see, for the owner's chooser.
      allCards: function () { return this._cards; },

      // Who the owner shows the map to: "anyone" | "friends" | "orbit" | "private".
      visibility: function () { return this._visibility; },

      // The owner changed it in the chooser (already saved); the caption names it.
      setVisibility: function (v) {
        this._visibility = v;
        if (this._caption) this._setCaption(this._cells || 0);
      },

      // The cards the map draws: all of them minus the ones the owner hid.
      _visibleCards: function () {
        var hidden = {};
        this.hiddenIds().forEach(function (id) { hidden[id] = true; });
        return this._cards.filter(function (c) { return !hidden[c.objId]; });
      },

      // The owner always keeps the panel once they have a located card (the way back
      // to the chooser); a visitor gets it only while something is shown.
      _refresh: function () {
        if (this._locked) this._shownPanel = false;
        else this._shownPanel = this._isOwner ? this._cards.length > 0 : this._visibleCards().length > 0;
        if (this._shownPanel && !this._built) this._build();
        else if (this._built) this._rebuildMap();
        if (this._onResize) this._onResize();
      },

      // The hidden list changed (after the chooser saved): draw the map again.
      refresh: function () { if (this._loaded) this._refresh(); },
    },

    "build", {
      _build: function () {
        if (this._built) return;
        this._built = true;
        var self = this;
        var p = panel(lively.rect(0, 0, 310, 340));
        this._panel = p;
        // Hidden until attach() places it. The panel is created at (0, 0) because
        // its real place depends on the page layout, which only runs afterwards
        // (the controller's re-render, a timer later plus the render itself); left
        // visible it showed in the page's top-left corner for ~180 ms before
        // jumping to its slot. attach() makes it visible once it is positioned.
        p.setVisible(false);
        p.addMorph(icon(lively.rect(16, 14, 22, 22), "map", 18, UI.PINK));
        this._title = label(lively.rect(44, 14, 170, 22), this._isOwner ? "Where I have been" : "Where @" + this._shown + " has been", { px: 15, bold: true });
        p.addMorph(this._title);
        this._manageBtn = null;
        if (this._isOwner) {
          this._manageBtn = pill(0, 0, "Manage", { w: 72, h: 26, onClick: function () { if (self._onManage) self._onManage(); } });
          p.addMorph(this._manageBtn);
        }

        this._caption = label(lively.rect(16, 46 + MAP_H + 8, 278, 36), "", { px: 12, color: MUTED, wrap: true });
        p.addMorph(this._caption);
        this._makeMap();
        // Behind everything already in the world, like the rest of the page
        // (HomestarController._add). This runs when the pins arrive, which can be
        // after the visitor opened a window; a plain addMorph would paint the map
        // card over that window.
        $world.addMorphBack(p);
      },

      _makeMap: function () {
        var self = this;
        var cards = this._visibleCards();
        this._map = new lively.identity.HomestarMapView(lively.rect(12, 46, Math.max(100, (this._w || 310) - 24), MAP_H), {
          cards: cards,
          onPin: function (objId) { if (self._onPin) self._onPin(objId); },
          onPlaced: function (pins, cells) { self._setCaption(cells); },
        });
        this._map.applyStyle({ borderRadius: 12, clipMode: "hidden" });
        this._panel.addMorph(this._map);
        this._setCaption(this._countCells(cards));
        // The reel may already be showing a card by the time the pins arrive.
        var cur = this._current || (this._getCurrent && this._getCurrent());
        if (cur) this.setCurrent(cur);
      },

      // A Leaflet map is not edited in place: drop it and draw a new one.
      _rebuildMap: function () {
        if (this._map) { this._map.remove(); this._map = null; }
        this._makeMap();
      },

      _countCells: function (cards) {
        var seen = {}, n = 0;
        cards.forEach(function (c) {
          var l = c.state && c.state.location;
          if (l && !seen[l]) { seen[l] = true; n++; }
        });
        return n;
      },

      _setCaption: function (cells) {
        this._cells = cells;
        if (!this._caption) return;
        var places = cells + (cells === 1 ? " place" : " places");
        var tail = " Pins are rounded to about 5 km.";
        if (!this._isOwner) this._caption.textString = places + " you can see." + tail;
        else if (!cells) this._caption.textString = "Nothing is on your map. Use Manage to choose cards.";
        else this._caption.textString = places + " on your map. " + VISIBLE_TO[this._visibility || "anyone"] + "." + tail;
      },
    },

    "layout", {
      // Positions the panel and returns the y of its bottom edge; when there is
      // nothing to show it takes no room (the same as the worlds panel for a visitor).
      attach: function (x, y, w, gap) {
        this._w = w;
        if (!this._shownPanel || !this._panel) {
          if (this._panel) this._panel.setVisible(false);
          return y - (gap || 0);
        }
        var p = this._panel;
        p.setVisible(true);
        p.setPosition(lively.pt(x, y));
        var h = 46 + MAP_H + 8 + 36 + 12;
        p.setExtent(lively.pt(w, h));
        this._title.setExtent(lively.pt(w - 60 - 72, 22));
        if (this._manageBtn) this._manageBtn.setPosition(lively.pt(w - 16 - 72, 11));
        this._caption.setExtent(lively.pt(w - 32, 36));
        this._map.setPosition(lively.pt(12, 46));
        this._map.fitTo(w - 24, MAP_H);
        return y + h;
      },

      // The reel is showing this card: its pin goes violet.
      setCurrent: function (objId) {
        this._current = objId;
        if (this._map) this._map.setCurrent(objId);
      },
    });

  });
