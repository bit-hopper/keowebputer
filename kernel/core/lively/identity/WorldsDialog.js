/**
 * lively.identity.WorldsDialog
 *
 * "Featured worlds": the owner picks which of their worlds the homestar lists and in
 * what order. The choice is stored in the public profile, under homestar.featuredWorlds
 * (a world's own state cannot hold it: SignedSerializer keeps only `template` on save).
 * Visitors still only see the featured worlds they are allowed to open (GET /@h/worlds
 * filters by viewer), so featuring a private world shows it to the owner alone.
 *
 *   lively.identity.WorldsDialog.open({
 *     featured,              // objIds listed now, in order
 *     onSave(),              // after the profile was saved
 *     onClose()
 *   });
 *
 * One list of every world the owner has: tick to feature, and a ticked row has up and
 * down arrows. A row is one Box that owns the click and tells a tick from an arrow by
 * where in the row it landed (a nested clickable child would never get the click, see
 * CLAUDE.md "Mouse dispatch is capture-first"). Escape cancels.
 */

module("lively.identity.WorldsDialog")
  .requires("lively.morphic.Complete", "lively.identity.HomestarUI", "lively.identity.UserSpace")
  .toRun(function () {

    var UI = lively.identity.HomestarUI;

    var W = 460;
    var PAD = 24;
    var ROW_H = 46;
    var LIST_MAX_H = 276;
    var MAX_FEATURED = 8;
    var ARROW_ZONE = 76;        // right-hand part of a ticked row that moves it instead of ticking it

    function viewportWidth() { return document.documentElement.clientWidth - 1; }

    function Dialog(opts) {
      this.opts = opts;
      this.featured = (opts.featured || []).slice();   // objIds, in display order
      this.worlds = null;                              // null = still loading; else every world, oldest first
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

      var user = lively.identity.did.currentUser();
      UI.getJSON("/@" + encodeURIComponent(user ? user.handle : "") + "/worlds", function (err, body) {
        if (!self.scrim) return;
        if (err || !body) { self.error = "Could not load your worlds."; self.worlds = []; return self.render(); }
        self.worlds = body.worlds || [];
        // A featured id whose world is gone is dropped.
        var known = {};
        self.worlds.forEach(function (w) { known[w.objId] = true; });
        self.featured = self.featured.filter(function (id) { return known[id]; });
        self.render();
      });
      return this;
    };

    Dialog.prototype.close = function () {
      if (!this.scrim) return;
      document.removeEventListener("keydown", this._onKey, true);
      UI.closeScrim(this.scrim);
      this.scrim = this.panel = null;
      if (this.opts.onClose) this.opts.onClose();
    };

    Dialog.prototype._toggle = function (id) {
      var i = this.featured.indexOf(id);
      if (i !== -1) {
        this.featured.splice(i, 1);
        this.error = null;
      } else if (this.featured.length >= MAX_FEATURED) {
        this.error = "You can feature up to " + MAX_FEATURED + " worlds. Untick one first.";
      } else {
        this.featured.push(id);
        this.error = null;
      }
      this.render();
    };

    Dialog.prototype._move = function (id, delta) {
      var i = this.featured.indexOf(id), j = i + delta;
      if (i === -1 || j < 0 || j >= this.featured.length) return;
      this.featured.splice(j, 0, this.featured.splice(i, 1)[0]);
      this.error = null;
      this.render();
    };

    // The profile's other homestar settings (the layout, the orbit's neighbours) must
    // survive: saveProfile merges only one level deep, so merge into a fresh copy of
    // the stored homestar object.
    Dialog.prototype._save = function () {
      var self = this;
      if (this.busy) return;
      this.busy = true;
      this.error = null;
      this.render();
      var ids = this.featured.slice();
      var us = lively.identity.userSpace;
      us.getProfile(function (err, env) {
        if (err || !env) return fail(err || new Error("no profile"));
        var current = (env.record && env.record.payload && env.record.payload.homestar) || {};
        us.saveProfile({ homestar: Object.assign({}, current, { featuredWorlds: ids }) }, function (saveErr) {
          if (saveErr) return fail(saveErr);
          self.busy = false;
          self.close();
          if (self.opts.onSave) self.opts.onSave(ids);
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

    // Featured worlds first, in their order, then the rest, oldest first.
    Dialog.prototype._ordered = function () {
      var byId = {};
      this.worlds.forEach(function (w) { byId[w.objId] = w; });
      var first = this.featured.map(function (id) { return byId[id]; }).filter(Boolean);
      var rest = this.worlds.filter(function (w) { return this.featured.indexOf(w.objId) === -1; }, this);
      return first.concat(rest);
    };

    Dialog.prototype._list = function (panel, y) {
      var self = this;
      var innerW = W - 2 * PAD;
      var worlds = this.worlds ? this._ordered() : [];
      var h = Math.min(LIST_MAX_H, Math.max(1, worlds.length) * ROW_H + 8);
      var box = new lively.morphic.Box(lively.rect(PAD, y, innerW, h));
      box.applyStyle({ fill: UI.PAGE_FILL, borderWidth: 1, borderColor: UI.CARD_BORDER, borderRadius: 10, clipMode: "auto" });
      UI.noDrag(box);
      if (!this.worlds) {
        box.addMorph(UI.label(lively.rect(12, 8, innerW - 24, 20), "Loading your worlds…", { px: 12, color: UI.MUTED }));
      } else if (!worlds.length) {
        box.addMorph(UI.label(lively.rect(12, 8, innerW - 24, 20), "You have no worlds yet.", { px: 12, color: UI.MUTED }));
      }
      var rowW = innerW - 8 - 14;
      worlds.forEach(function (wd, i) {
        var pos = self.featured.indexOf(wd.objId);
        var on = pos !== -1;
        var r = new lively.morphic.Box(lively.rect(4, 4 + i * ROW_H, rowW, ROW_H));
        r.applyStyle({ fill: null, borderWidth: 0, borderRadius: 8, handStyle: "pointer" });
        UI.noDrag(r);
        r.addMorph(self._checkbox(8, 13, on));
        var detail = wd.template ? String(wd.template).replace(/[-_]/g, " ") : "blank world";
        r.addMorph(UI.label(lively.rect(40, 5, rowW - 40 - ARROW_ZONE - 30, 20), UI.trunc(wd.name || "Untitled", 30), { px: 13, bold: true }));
        r.addMorph(UI.label(lively.rect(40, 24, rowW - 40 - ARROW_ZONE - 30, 18), UI.trunc(detail, 30), { px: 11, color: UI.MUTED }));
        var vis = wd.visibility === "public" ? "lock_open" : (wd.visibility === "shared" ? "group" : "lock");
        r.addMorph(UI.icon(lively.rect(rowW - ARROW_ZONE - 28, 13, 20, 20), vis, 16, UI.MUTED));
        if (on) {
          r.addMorph(UI.icon(lively.rect(rowW - ARROW_ZONE + 6, 11, 24, 24), "arrow_upward", 18, pos > 0 ? UI.PINK : UI.CARD_BORDER));
          r.addMorph(UI.icon(lively.rect(rowW - 32, 11, 24, 24), "arrow_downward", 18, pos < self.featured.length - 1 ? UI.PINK : UI.CARD_BORDER));
        }
        r.onMouseUp = function (evt) {
          evt.stop();
          var x = r.localize(evt.getPosition()).x;
          if (on && x > rowW - ARROW_ZONE) self._move(wd.objId, x < rowW - ARROW_ZONE / 2 ? -1 : 1);
          else self._toggle(wd.objId);
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
      panel.addMorph(UI.label(lively.rect(PAD, y, textW, 24), "Featured worlds", { px: 16, bold: true }));
      y += 28;
      var help = "The worlds your homestar lists, in this order. Visitors only see the ones they are allowed to open, " +
        "so a private world shows for you alone.";
      panel.addMorph(UI.label(lively.rect(PAD, y, textW, 40), help, { px: 11, color: UI.MUTED, wrap: true }));
      y += 46;

      panel.addMorph(UI.label(lively.rect(PAD, y, textW - 160, 18), "Your worlds", { px: 12, bold: true, color: UI.MUTED }));
      panel.addMorph(UI.label(lively.rect(W - PAD - 160, y, 160, 18), this.featured.length + " featured", { px: 12, color: UI.MUTED, align: "right" }));
      y += 24;
      y += this._list(panel, y) + 10;

      if (this.error) {
        panel.addMorph(UI.label(lively.rect(PAD, y, textW, 36), this.error, { px: 12, color: UI.PINK, bold: true, wrap: true }));
        y += 40;
      }
      y += 4;

      var save = UI.pill(0, y, this.busy ? "Saving…" : "Save", {
        primary: true, w: 92, disabled: this.busy || !this.worlds, onClick: function () { self._save(); },
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

    lively.identity.WorldsDialog = {
      open: function (opts) { return new Dialog(opts).open(); }
    };

  }); // end module('lively.identity.WorldsDialog')
