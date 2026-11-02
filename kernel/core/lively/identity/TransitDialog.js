/**
 * lively.identity.TransitDialog
 *
 * "Your transit card": the owner picks the BART station the homestar's Transit card
 * shows the next trains for, and who sees the card. Both choices are stored in the
 * private settings (state.transitStation and state.transitVisibility,
 * TransitCard.js) and applied by the server's GET /@:handle/transit, so a visitor
 * outside the choice is never told the station.
 *
 * A station is a coarse place (where this person gets on a train), so the card gets
 * the same four choices as the map and the constellations card. Picking "No Transit
 * card" clears the station and the card disappears for everyone, the owner's prompt
 * aside.
 *
 *   lively.identity.TransitDialog.open({
 *     onSave(),          // after the choices were saved
 *     onClose()
 *   });
 *
 * Same shape as ConstellationsDialog (viewport scrim, one Box per row owning the
 * click, Escape cancels).
 */

module("lively.identity.TransitDialog")
  .requires("lively.morphic.Complete", "lively.identity.HomestarUI", "lively.identity.PostcardAudience", "lively.transit.BartData")
  .toRun(function () {

    var UI = lively.identity.HomestarUI;

    var VISIBILITIES = [
      { key: "anyone",  text: "Anyone",  desc: "Anyone who visits your homestar can see this card." },
      { key: "friends", text: "Friends", desc: "Only your friends can see this card." },
      { key: "orbit",   text: "Orbit",   desc: "Only the friends in your orbit can see this card." },
      { key: "private", text: "Only me", desc: "Only you can see this card." },
    ];

    var W = 460;
    var PAD = 24;
    var ROW_H = 40;
    var LIST_MAX_H = 240;
    var NONE = "";                 // the list's first row: no card

    function viewportWidth() { return document.documentElement.clientWidth - 1; }

    function Dialog(opts) {
      this.opts = opts;
      this.loaded = false;
      this.loadError = null;
      this.codes = [];             // station codes by name, after the "no card" row
      this.station = NONE;
      this.visibility = "anyone";
      this.error = null;
      this.busy = false;
      this.scrim = null;
      this.panel = null;
      this.listBox = null;
      this.scrollTop = null;       // kept across the redraw a click causes
    }

    Dialog.prototype.open = function () {
      var self = this;
      this.codes = lively.transit.BartData.allStationCodes();
      var scrim = this.scrim = UI.viewportScrim(function () { if (self.scrim) self.render(); });
      // Only a click outside the panel is the scrim's; the rest must reach the rows.
      scrim.onMouseUp = function (evt) {
        if (!self.panel) return false;
        if (UI.pointOnPanel(self.panel, evt)) return false;
        evt.stop();
        self.close();
        return true;
      };
      this._onKey = function (e) {
        if (e.key !== "Escape") return;
        e.preventDefault();
        e.stopPropagation();
        self.close();
      };
      document.addEventListener("keydown", this._onKey, true);
      this.render();
      this._load();
      return this;
    };

    Dialog.prototype.close = function () {
      if (!this.scrim) return;
      document.removeEventListener("keydown", this._onKey, true);
      UI.closeScrim(this.scrim);
      this.scrim = this.panel = this.listBox = null;
      if (this.opts.onClose) this.opts.onClose();
    };

    Dialog.prototype._load = function () {
      var self = this;
      if (!lively.identity.did.currentUser()) return this._loadFailed(new Error("Not signed in"));
      lively.identity.postcardAudience.readSettingsState(function (err, st) {
        if (err) return self._loadFailed(err);
        var code = typeof st.transitStation === "string" ? st.transitStation : NONE;
        self.station = lively.transit.BartData.stations[code] ? code : NONE;
        self.visibility = st.transitVisibility || "anyone";
        self.loaded = true;
        // open the list at the chosen station, a couple of rows down from the top edge
        var i = self.codes.indexOf(self.station);
        self.scrollTop = i < 0 ? 0 : Math.max(0, (i + 1 - 2) * ROW_H);
        if (self.scrim) self.render();
      });
    };

    Dialog.prototype._loadFailed = function (e) {
      this.loadError = "Could not load: " + ((e && e.message) || e);
      if (this.scrim) this.render();
    };

    Dialog.prototype._save = function () {
      var self = this;
      if (this.busy || !this.loaded) return;
      this.busy = true;
      this.error = null;
      this.render();
      var station = this.station || null, vis = this.visibility;
      lively.identity.postcardAudience.patchSettings(function (state) {
        state.transitStation = station;
        state.transitVisibility = vis;
      }, function (err) {
        self.busy = false;
        if (err) {
          self.error = "Could not save: " + ((err && err.message) || err);
          if (self.scrim) self.render();
          return;
        }
        self.close();
        if (self.opts.onSave) self.opts.onSave();
      });
    };

    // A round radio mark: a pink ring with a pink dot inside when chosen.
    Dialog.prototype._radio = function (x, y, on) {
      var ring = new lively.morphic.Box(lively.rect(x, y, 20, 20));
      ring.applyStyle({ fill: Color.white, borderRadius: 10, borderWidth: 2, borderColor: on ? UI.PINK : Color.rgb(190, 184, 206), clipMode: "hidden" });
      UI.noDrag(ring);
      ring.eventsAreIgnored = true;
      if (on) {
        var dot = new lively.morphic.Box(lively.rect(6, 6, 8, 8));   // children start at the outer edge, not inside the 2px border
        dot.applyStyle({ fill: UI.PINK, borderRadius: 4, borderWidth: 0 });
        UI.noDrag(dot);
        dot.eventsAreIgnored = true;
        ring.addMorph(dot);
      }
      return ring;
    };

    // Four pills, the chosen one filled, and a line saying what it means. Returns the height used.
    Dialog.prototype._visibilityRow = function (panel, y) {
      var self = this;
      var gap = 8, n = VISIBILITIES.length, w = Math.floor((W - 2 * PAD - (n - 1) * gap) / n);
      VISIBILITIES.forEach(function (v, i) {
        var p = UI.pill(0, y, v.text, {
          primary: self.visibility === v.key, w: w,
          onClick: function () { self.visibility = v.key; self.render(); },
        });
        p.setPosition(lively.pt(PAD + i * (w + gap), y));
        panel.addMorph(p);
      });
      var desc = VISIBILITIES.filter(function (v) { return v.key === self.visibility; })[0].desc;
      panel.addMorph(UI.label(lively.rect(PAD, y + 38, W - 2 * PAD, 18), desc, { px: 11, color: UI.MUTED }));
      return 66;
    };

    Dialog.prototype._row = function (box, i, code, rowW) {
      var self = this;
      var B = lively.transit.BartData;
      var on = this.station === code;
      var r = new lively.morphic.Box(lively.rect(4, 4 + i * ROW_H, rowW, ROW_H));
      r.applyStyle({ fill: null, borderWidth: 0, borderRadius: 8, handStyle: "pointer" });
      UI.noDrag(r);
      r.addMorph(this._radio(8, 10, on));
      if (code === NONE) {
        r.addMorph(UI.label(lively.rect(40, 10, rowW - 48, 20), "No Transit card", { px: 13, bold: true }));
      } else {
        var lines = B.linesAt(code);
        var dotsW = lines.length * 14;
        r.addMorph(UI.label(lively.rect(40, 10, rowW - 40 - dotsW - 12, 20), UI.trunc(B.stationName(code), 34), { px: 13, bold: true }));
        lines.forEach(function (l, k) {
          var d = new lively.morphic.Box(lively.rect(rowW - 10 - dotsW + k * 14, 15, 10, 10));
          d.applyStyle({ fill: Color.rgbHex(l.color), borderRadius: 5, borderWidth: 0 });
          UI.noDrag(d);
          d.eventsAreIgnored = true;
          r.addMorph(d);
        });
      }
      r.onMouseUp = function (evt) {
        evt.stop();
        self.station = code;
        self.render();
        return true;
      };
      box.addMorph(r);
    };

    Dialog.prototype._list = function (panel, y) {
      var self = this;
      var innerW = W - 2 * PAD;
      var codes = [NONE].concat(this.codes);
      var h = Math.min(LIST_MAX_H, codes.length * ROW_H + 8);
      var box = this.listBox = new lively.morphic.Box(lively.rect(PAD, y, innerW, h));
      box.applyStyle({ fill: UI.PAGE_FILL, borderWidth: 1, borderColor: UI.CARD_BORDER, borderRadius: 10, clipMode: "auto" });
      UI.noDrag(box);
      var rowW = innerW - 8 - 14;
      codes.forEach(function (code, i) { self._row(box, i, code, rowW); });
      panel.addMorph(box);
      UI.scroller(box);
      return h;
    };

    Dialog.prototype.render = function () {
      var self = this;
      if (!this.scrim) return;      // closed while a request was still on its way
      if (this.listBox) {
        var node = this.listBox.renderContext().shapeNode;
        if (node) this.scrollTop = node.scrollTop;
      }
      if (this.panel) this.panel.remove();
      this.listBox = null;

      var panel = this.panel = new lively.morphic.Box(lively.rect(0, 0, W, 400));
      panel.applyStyle({ fill: Color.white, borderWidth: 1, borderColor: UI.CARD_BORDER, borderRadius: 16, clipMode: "hidden" });
      UI.noDrag(panel);

      var textW = W - 2 * PAD;
      var y = 20;
      panel.addMorph(UI.label(lively.rect(PAD, y, textW, 24), "Your transit card", { px: 16, bold: true }));
      y += 32;

      if (!this.loaded) {
        var msg = this.loadError || "Loading…";
        panel.addMorph(UI.label(lively.rect(PAD, y, textW, 36), msg, { px: 13, color: this.loadError ? UI.PINK : UI.MUTED, wrap: true }));
        y += 48;
        var close0 = UI.pill(0, y, "Close", { primary: false, w: 92, onClick: function () { self.close(); } });
        close0.setPosition(lively.pt(W - PAD - 92, y));
        panel.addMorph(close0);
        y += 30 + 22;
        return this._place(panel, y);
      }

      panel.addMorph(UI.label(lively.rect(PAD, y, textW, 18), "Who can see the card", { px: 12, bold: true, color: UI.MUTED }));
      y += 24;
      y += this._visibilityRow(panel, y);

      var help = "The card shows the next trains at one BART station, live from 511.org. " +
        "A station says roughly where you get on, so only the people you allow are told which one.";
      panel.addMorph(UI.label(lively.rect(PAD, y, textW, 40), help, { px: 11, color: UI.MUTED, wrap: true }));
      y += 46;

      panel.addMorph(UI.label(lively.rect(PAD, y, textW, 18), "Station", { px: 12, bold: true, color: UI.MUTED }));
      y += 24;
      y += this._list(panel, y) + 10;

      if (this.error) {
        panel.addMorph(UI.label(lively.rect(PAD, y, textW, 36), this.error, { px: 12, color: UI.PINK, bold: true, wrap: true }));
        y += 40;
      }
      y += 4;

      var save = UI.pill(0, y, this.busy ? "Saving…" : "Save", {
        primary: true, w: 92, disabled: this.busy, onClick: function () { self._save(); },
      });
      save.setPosition(lively.pt(W - PAD - 92, y));
      panel.addMorph(save);
      var cancel = UI.pill(0, y, "Cancel", { primary: false, w: 92, onClick: function () { self.close(); } });
      cancel.setPosition(lively.pt(W - PAD - 92 - 8 - 92, y));
      panel.addMorph(cancel);
      y += 30 + 22;
      this._place(panel, y);
      if (this.listBox && this.scrollTop != null) this.listBox.renderContext().shapeNode.scrollTop = this.scrollTop;
    };

    // Sized and placed before it is added (CLAUDE.md: a setPosition right after addMorph
    // can desync the render tree). The scrim's origin is the top of the viewport.
    Dialog.prototype._place = function (panel, h) {
      var vh = window.innerHeight, vw = viewportWidth();
      panel.setExtent(lively.pt(W, h));
      panel.setPosition(lively.pt(Math.round((vw - W) / 2), Math.max(16, Math.round((vh - h) / 2))));
      this.scrim.addMorph(panel);
    };

    lively.identity.TransitDialog = {
      open: function (opts) { return new Dialog(opts || {}).open(); }
    };

  }); // end module('lively.identity.TransitDialog')
