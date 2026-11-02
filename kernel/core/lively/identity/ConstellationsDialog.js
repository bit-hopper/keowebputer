/**
 * lively.identity.ConstellationsDialog
 *
 * "Your constellations": the owner chooses who sees the homestar's Constellations
 * card and which of the constellations they belong to it lists. Both choices are
 * stored in the private settings (state.constellationsVisibility and
 * state.constellationsHidden, ConstellationsCard.js) and applied by the server's
 * GET /@:handle/constellations/public, so a visitor outside the choice gets nothing
 * and a hidden constellation's name never reaches the public profile.
 *
 * Every constellation the owner is in starts ticked (a newly joined one appears by
 * itself); the unticked ones are stored by name. A hidden name this dialog could not
 * list (a constellation the owner has since left) stays hidden, like the map's list.
 *
 *   lively.identity.ConstellationsDialog.open({
 *     onSave(),          // after both were saved
 *     onClose()
 *   });
 *
 * The dialog reads the owner's settings and the full membership list itself
 * (GET /@:handle/constellations, owner-only), so it needs nothing from the page.
 *
 * This only changes the homestar. A public constellation's members are still
 * readable on the constellation itself, and the dialog says so.
 *
 * Same shape as MapDialog (viewport scrim, one Box per row owning the click, Escape
 * cancels).
 */

module("lively.identity.ConstellationsDialog")
  .requires("lively.morphic.Complete", "lively.identity.HomestarUI", "lively.identity.PostcardAudience")
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
    var ROW_H = 46;
    var LIST_MAX_H = 276;

    function viewportWidth() { return document.documentElement.clientWidth - 1; }

    function Dialog(opts) {
      this.opts = opts;
      this.loaded = false;          // both reads are back
      this.loadError = null;
      this.rows = [];               // every constellation the owner is in
      this.shown = {};              // name -> true while ticked
      this.hidden0 = [];            // hidden names as stored when the dialog opened
      this.visibility0 = "anyone";
      this.visibility = "anyone";
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
      this._load();
      return this;
    };

    Dialog.prototype.close = function () {
      if (!this.scrim) return;
      document.removeEventListener("keydown", this._onKey, true);
      UI.closeScrim(this.scrim);
      this.scrim = this.panel = null;
      if (this.opts.onClose) this.opts.onClose();
    };

    Dialog.prototype._load = function () {
      var self = this;
      var user = lively.identity.did.currentUser();
      if (!user) return this._loadFailed(new Error("Not signed in"));
      var pending = 2, failed = false, state = null, rows = null;
      function done() {
        if (failed || --pending > 0) return;
        self.rows = rows;
        var hidden = Array.isArray(state.constellationsHidden) ? state.constellationsHidden : [];
        self.hidden0 = hidden.slice();
        var isHidden = {};
        hidden.forEach(function (n) { isHidden[n] = true; });
        rows.forEach(function (c) { if (!isHidden[c.name]) self.shown[c.name] = true; });
        self.visibility0 = self.visibility = state.constellationsVisibility || "anyone";
        self.loaded = true;
        if (self.scrim) self.render();
      }
      function fail(e) { if (failed) return; failed = true; self._loadFailed(e); }
      lively.identity.postcardAudience.readSettingsState(function (err, st) {
        if (err) return fail(err);
        state = st; done();
      });
      UI.getJSON("/@" + encodeURIComponent(user.handle) + "/constellations", function (err, body) {
        if (err || !body || !Array.isArray(body.constellations)) return fail(err || new Error("Could not load your constellations"));
        rows = body.constellations.slice().sort(function (a, b) { return a.name < b.name ? -1 : a.name > b.name ? 1 : 0; });
        done();
      });
    };

    Dialog.prototype._loadFailed = function (e) {
      this.loadError = "Could not load: " + ((e && e.message) || e);
      if (this.scrim) this.render();
    };

    Dialog.prototype._count = function () {
      return this.rows.filter(function (c) { return this.shown[c.name]; }, this).length;
    };

    Dialog.prototype._toggle = function (name) {
      if (this.shown[name]) delete this.shown[name]; else this.shown[name] = true;
      this.render();
    };

    Dialog.prototype._setAll = function (on) {
      this.shown = {};
      if (on) this.rows.forEach(function (c) { this.shown[c.name] = true; }, this);
      this.render();
    };

    // Hidden names this dialog could not list stay as they were; only the listed
    // constellations are decided here.
    Dialog.prototype._save = function () {
      var self = this;
      if (this.busy || !this.loaded) return;
      this.busy = true;
      this.error = null;
      this.render();
      var listed = {};
      this.rows.forEach(function (c) { listed[c.name] = true; });
      var kept = this.hidden0.filter(function (n) { return !listed[n]; });
      var hiddenNow = this.rows.filter(function (c) { return !self.shown[c.name]; }).map(function (c) { return c.name; });
      var names = kept.concat(hiddenNow);
      var vis = this.visibility;
      lively.identity.postcardAudience.patchSettings(function (state) {
        state.constellationsVisibility = vis;
        state.constellationsHidden = names;
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
      var rows = this.rows;
      var h = Math.min(LIST_MAX_H, Math.max(1, rows.length) * ROW_H + 8);
      var box = new lively.morphic.Box(lively.rect(PAD, y, innerW, h));
      box.applyStyle({ fill: UI.PAGE_FILL, borderWidth: 1, borderColor: UI.CARD_BORDER, borderRadius: 10, clipMode: "auto" });
      UI.noDrag(box);
      if (!rows.length) {
        box.addMorph(UI.label(lively.rect(12, 8, innerW - 24, 20), "You have not joined any constellations yet.", { px: 12, color: UI.MUTED }));
      }
      var rowW = innerW - 8 - 14;
      rows.forEach(function (c, i) {
        var on = !!self.shown[c.name];
        var isPublic = c.visibility === "public";
        var r = new lively.morphic.Box(lively.rect(4, 4 + i * ROW_H, rowW, ROW_H));
        r.applyStyle({ fill: null, borderWidth: 0, borderRadius: 8, handStyle: "pointer" });
        UI.noDrag(r);
        r.addMorph(self._checkbox(8, 13, on));
        var members = (c.memberCount || 0) + (c.memberCount === 1 ? " member" : " members");
        var detail = (isPublic ? "Public" : "Private, only you will see it") + "  ·  " + members;
        r.addMorph(UI.label(lively.rect(40, 5, rowW - 40 - 40, 20), UI.trunc("c/" + c.name, 34), { px: 13, bold: true }));
        r.addMorph(UI.label(lively.rect(40, 24, rowW - 40 - 40, 18), detail, { px: 11, color: UI.MUTED }));
        r.addMorph(UI.icon(lively.rect(rowW - 32, 13, 20, 20), isPublic ? "public" : "lock", 16, UI.MUTED));
        r.onMouseUp = function (evt) {
          evt.stop();
          self._toggle(c.name);
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
      panel.addMorph(UI.label(lively.rect(PAD, y, textW, 24), "Your constellations", { px: 16, bold: true }));
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

      var help = "The constellations the card lists. Others only ever see the public ones you leave ticked; " +
        "a private one shows on your own page only. This changes your homestar, not the constellations themselves.";
      panel.addMorph(UI.label(lively.rect(PAD, y, textW, 56), help, { px: 11, color: UI.MUTED, wrap: true }));
      y += 62;

      panel.addMorph(UI.label(lively.rect(PAD, y, textW - 190, 18), "Your constellations", { px: 12, bold: true, color: UI.MUTED }));
      panel.addMorph(UI.label(lively.rect(W - PAD - 190, y, 190, 18), this._count() + " of " + this.rows.length + " shown", { px: 12, color: UI.MUTED, align: "right" }));
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
      this._place(panel, y);
    };

    // Sized and placed before it is added (CLAUDE.md: a setPosition right after addMorph
    // can desync the render tree). The scrim's origin is the top of the viewport.
    Dialog.prototype._place = function (panel, h) {
      var vh = window.innerHeight, vw = viewportWidth();
      panel.setExtent(lively.pt(W, h));
      panel.setPosition(lively.pt(Math.round((vw - W) / 2), Math.max(16, Math.round((vh - h) / 2))));
      this.scrim.addMorph(panel);
    };

    lively.identity.ConstellationsDialog = {
      open: function (opts) { return new Dialog(opts || {}).open(); }
    };

  }); // end module('lively.identity.ConstellationsDialog')
