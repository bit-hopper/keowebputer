/**
 * lively.identity.MapDialog
 *
 * "Your map": the owner ticks which of their located postcards the homestar map
 * shows. Every located card starts ticked (a new one appears by itself); the cards
 * left unticked are stored in the public profile as homestar.mapHidden (a world's
 * or card's own state cannot hold it, and visitors' maps must respect it too).
 * The list only holds ids, no titles, so a hidden private card leaks nothing but
 * that an id exists.
 *
 *   lively.identity.MapDialog.open({
 *     cards,                 // the located cards the owner has (feed rows), newest first
 *     hidden,                // objIds hidden now
 *     visibility,            // who sees the map now: anyone | friends | orbit | private
 *     onSave(hiddenIds, visibility),   // after both were saved
 *     onClose()
 *   });
 *
 * The row of pills above the list is who the map is shown to. That is stored in the
 * private settings (state.mapVisibility, MapVisibility.js) and enforced by the
 * server's located-postcards listing, so a visitor outside the choice gets no pins;
 * the card itself is still as public as it was.
 *
 * Same shape as WorldsDialog (viewport scrim, one Box per row owning the click,
 * Escape cancels); there is no ordering, only ticks.
 */

module("lively.identity.MapDialog")
  .requires("lively.morphic.Complete", "lively.identity.HomestarUI", "lively.identity.UserSpace", "lively.identity.PostcardAudience")
  .toRun(function () {

    var UI = lively.identity.HomestarUI;

    var VISIBILITIES = [
      { key: "anyone",  text: "Anyone",  desc: "Anyone who visits your homestar can see your map." },
      { key: "friends", text: "Friends", desc: "Only your friends can see your map." },
      { key: "orbit",   text: "Orbit",   desc: "Only the friends in your orbit can see your map." },
      { key: "private", text: "Only me", desc: "Only you can see your map." },
    ];

    var W = 460;
    var PAD = 24;
    var ROW_H = 46;
    var LIST_MAX_H = 276;

    function viewportWidth() { return document.documentElement.clientWidth - 1; }

    function dateOf(created) {
      var d = created ? new Date(created) : null;
      return d && !isNaN(d) ? d.toISOString().slice(0, 10) : "";
    }

    function Dialog(opts) {
      this.opts = opts;
      this.cards = opts.cards || [];
      this.shown = {};                                  // objId -> true while ticked
      var hidden = {};
      (opts.hidden || []).forEach(function (id) { hidden[id] = true; });
      this.cards.forEach(function (c) { if (!hidden[c.objId]) this.shown[c.objId] = true; }, this);
      this.visibility0 = opts.visibility || "anyone";   // as it was when the dialog opened
      this.visibility = this.visibility0;
      this.error = null;
      this.busy = false;
      this.scrim = null;
      this.panel = null;
    }

    Dialog.prototype.open = function () {
      var self = this;
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
      return this;
    };

    Dialog.prototype.close = function () {
      if (!this.scrim) return;
      document.removeEventListener("keydown", this._onKey, true);
      UI.closeScrim(this.scrim);
      this.scrim = this.panel = null;
      if (this.opts.onClose) this.opts.onClose();
    };

    Dialog.prototype._count = function () {
      return this.cards.filter(function (c) { return this.shown[c.objId]; }, this).length;
    };

    Dialog.prototype._toggle = function (id) {
      if (this.shown[id]) delete this.shown[id]; else this.shown[id] = true;
      this.render();
    };

    Dialog.prototype._setAll = function (on) {
      this.shown = {};
      if (on) this.cards.forEach(function (c) { this.shown[c.objId] = true; }, this);
      this.render();
    };

    // Hidden ids this dialog could not list (a card that was deleted, or one beyond
    // what the page loaded) stay as they were; only the listed cards are decided here.
    Dialog.prototype._save = function () {
      var self = this;
      if (this.busy) return;
      this.busy = true;
      this.error = null;
      this.render();
      var listed = {};
      this.cards.forEach(function (c) { listed[c.objId] = true; });
      var us = lively.identity.userSpace;
      var vis = this.visibility;
      // Who sees the map goes to the private settings first (only if it changed), then
      // the list of hidden cards to the public profile.
      function saveVisibility(next) {
        if (vis === self.visibility0) return next();
        lively.identity.postcardAudience.patchSettings(function (state) { state.mapVisibility = vis; }, function (err) {
          if (err) return fail(err);
          self.visibility0 = vis;       // a later failure must not write it again
          next();
        });
      }
      saveVisibility(function () {
        us.getProfile(function (err, env) {
          if (err || !env) return fail(err || new Error("no profile"));
          // saveProfile merges only one level deep, so merge into a fresh copy of the
          // stored homestar object: the layout and featured worlds must survive.
          var current = (env.record && env.record.payload && env.record.payload.homestar) || {};
          var kept = (Array.isArray(current.mapHidden) ? current.mapHidden : []).filter(function (id) { return !listed[id]; });
          var hiddenNow = self.cards.filter(function (c) { return !self.shown[c.objId]; }).map(function (c) { return c.objId; });
          var ids = kept.concat(hiddenNow);
          us.saveProfile({ homestar: Object.assign({}, current, { mapHidden: ids }) }, function (saveErr) {
            if (saveErr) return fail(saveErr);
            self.busy = false;
            self.close();
            if (self.opts.onSave) self.opts.onSave(ids, vis);
          });
        });
      });
      function fail(e) {
        self.busy = false;
        self.error = "Could not save: " + ((e && e.message) || e);
        if (self.scrim) self.render();
      }
    };

    Dialog.prototype._checkbox = function (x, y, on) {
      var box = new lively.morphic.Box(lively.rect(x, y, 20, 20));
      box.applyStyle({
        fill: on ? UI.PINK : Color.white, borderRadius: 6, borderWidth: 2,
        borderColor: on ? UI.PINK : Color.rgb(190, 184, 206), clipMode: "hidden"
      });
      UI.noDrag(box);
      box.eventsAreIgnored = true;
      if (on) box.addMorph(UI.icon(lively.rect(0, 0, 16, 16), "check", 14, Color.white));
      return box;
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

    Dialog.prototype._list = function (panel, y) {
      var self = this;
      var innerW = W - 2 * PAD;
      var cards = this.cards;
      var h = Math.min(LIST_MAX_H, Math.max(1, cards.length) * ROW_H + 8);
      var box = new lively.morphic.Box(lively.rect(PAD, y, innerW, h));
      box.applyStyle({ fill: UI.PAGE_FILL, borderWidth: 1, borderColor: UI.CARD_BORDER, borderRadius: 10, clipMode: "auto" });
      UI.noDrag(box);
      if (!cards.length) {
        box.addMorph(UI.label(lively.rect(12, 8, innerW - 24, 20), "You have no postcards with a location yet.", { px: 12, color: UI.MUTED }));
      }
      var rowW = innerW - 8 - 14;
      cards.forEach(function (c, i) {
        var on = !!self.shown[c.objId];
        var vis = c.visibility || "public";
        var r = new lively.morphic.Box(lively.rect(4, 4 + i * ROW_H, rowW, ROW_H));
        r.applyStyle({ fill: null, borderWidth: 0, borderRadius: 8, handStyle: "pointer" });
        UI.noDrag(r);
        r.addMorph(self._checkbox(8, 13, on));
        var detail = (vis === "public" ? "Public" : (vis === "shared" ? "Shared" : "Only you")) +
          (dateOf(c.created) ? "  ·  " + dateOf(c.created) : "");
        r.addMorph(UI.label(lively.rect(40, 5, rowW - 40 - 40, 20), UI.trunc((c.state && c.state.title) || "(untitled)", 34), { px: 13, bold: true }));
        r.addMorph(UI.label(lively.rect(40, 24, rowW - 40 - 40, 18), detail, { px: 11, color: UI.MUTED }));
        r.addMorph(UI.icon(lively.rect(rowW - 32, 13, 20, 20), vis === "public" ? "lock_open" : (vis === "shared" ? "group" : "lock"), 16, UI.MUTED));
        r.onMouseUp = function (evt) {
          evt.stop();
          self._toggle(c.objId);
          return true;
        };
        box.addMorph(r);
      });
      panel.addMorph(box);
      UI.scroller(box);
      return h;
    };

    Dialog.prototype.render = function () {
      var self = this;
      if (!this.scrim) return;      // closed while a request was still on its way
      if (this.panel) this.panel.remove();

      var panel = this.panel = new lively.morphic.Box(lively.rect(0, 0, W, 400));
      panel.applyStyle({ fill: Color.white, borderWidth: 1, borderColor: UI.CARD_BORDER, borderRadius: 16, clipMode: "hidden" });
      UI.noDrag(panel);

      var textW = W - 2 * PAD;
      var y = 20;
      panel.addMorph(UI.label(lively.rect(PAD, y, textW, 24), "Your map", { px: 16, bold: true }));
      y += 28;
      panel.addMorph(UI.label(lively.rect(PAD, y, textW, 18), "Who can see your map", { px: 12, bold: true, color: UI.MUTED }));
      y += 24;
      y += this._visibilityRow(panel, y);

      var help = "The cards your map shows. A shared or private card is only ever pinned on your own map; " +
        "everyone else's shows the public cards you leave ticked.";
      panel.addMorph(UI.label(lively.rect(PAD, y, textW, 40), help, { px: 11, color: UI.MUTED, wrap: true }));
      y += 46;

      panel.addMorph(UI.label(lively.rect(PAD, y, textW - 190, 18), "Cards with a location", { px: 12, bold: true, color: UI.MUTED }));
      var total = this.cards.length;
      panel.addMorph(UI.label(lively.rect(W - PAD - 190, y, 190, 18), this._count() + " of " + total + " shown", { px: 12, color: UI.MUTED, align: "right" }));
      y += 24;
      y += this._list(panel, y) + 10;

      if (this.error) {
        panel.addMorph(UI.label(lively.rect(PAD, y, textW, 36), this.error, { px: 12, color: UI.PINK, bold: true, wrap: true }));
        y += 40;
      }
      y += 4;

      var all = UI.pill(0, y, "Show all", { primary: false, w: 84, onClick: function () { self._setAll(true); } });
      all.setPosition(lively.pt(PAD, y));
      panel.addMorph(all);
      var none = UI.pill(0, y, "Hide all", { primary: false, w: 84, onClick: function () { self._setAll(false); } });
      none.setPosition(lively.pt(PAD + 84 + 8, y));
      panel.addMorph(none);

      var save = UI.pill(0, y, this.busy ? "Saving…" : "Save", {
        primary: true, w: 92, disabled: this.busy, onClick: function () { self._save(); },
      });
      save.setPosition(lively.pt(W - PAD - 92, y));
      panel.addMorph(save);
      var cancel = UI.pill(0, y, "Cancel", { primary: false, w: 92, onClick: function () { self.close(); } });
      cancel.setPosition(lively.pt(W - PAD - 92 - 8 - 92, y));
      panel.addMorph(cancel);
      y += 30 + 22;

      // Sized and placed before it is added (CLAUDE.md: a setPosition right after addMorph
      // can desync the render tree). The scrim's origin is the top of the viewport.
      var vh = window.innerHeight, vw = viewportWidth();
      panel.setExtent(lively.pt(W, y));
      panel.setPosition(lively.pt(Math.round((vw - W) / 2), Math.max(16, Math.round((vh - y) / 2))));
      this.scrim.addMorph(panel);
    };

    lively.identity.MapDialog = {
      open: function (opts) { return new Dialog(opts).open(); }
    };

  }); // end module('lively.identity.MapDialog')
