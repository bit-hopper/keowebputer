/**
 * lively.identity.OrbitDialog
 *
 * "Your orbit": the owner picks which friends are close friends, which (up to three)
 * are pinned to the inner ring, and who may see the orbit at all. Save writes
 * state.orbit on the private settings envelope (PostcardAudience.patchSettings); the
 * server drops anyone who is not a friend and cuts pinned to three (Orbit.js).
 *
 *   lively.identity.OrbitDialog.open({
 *     orbit,                 // { visibility, members: [{did, handle}], pinned: [did] } as GET /orbit gave the owner
 *     onSave(),              // after a successful save
 *     onClose()
 *   });
 *
 * Friends come from PostcardAudience.loadContext. A row is one Box that owns the click
 * and tells a tick from a pin by where in the row it landed, because a nested clickable
 * child would never get the click (CLAUDE.md "Mouse dispatch is capture-first").
 */

module("lively.identity.OrbitDialog")
  .requires("lively.morphic.Complete", "lively.identity.HomestarUI", "lively.identity.PostcardAudience")
  .toRun(function () {

    var UI = lively.identity.HomestarUI;

    var W = 460;
    var PAD = 24;
    var ROW_H = 36;
    var PICKER_MAX_H = 252;
    var MAX_PINNED = 3;
    var PIN_ZONE = 48;          // right-hand part of a row that pins instead of ticks

    var VISIBILITIES = [
      { key: "anyone",  text: "Anyone",  desc: "Anyone who visits your homestar can see your orbit." },
      { key: "friends", text: "Friends", desc: "Only your friends can see your orbit." },
      { key: "private", text: "Only me", desc: "Only you can see your orbit." },
    ];

    function viewportWidth() { return document.documentElement.clientWidth - 1; }

    function Dialog(opts) {
      this.opts = opts;
      var o = opts.orbit || {};
      this.visibility = o.visibility || "friends";
      this.members = (o.members || []).map(function (m) { return m.did; });
      this.pinned = (o.pinned || []).slice();
      this.handleByDid = {};
      (o.members || []).forEach(function (m) { if (m.handle) this.handleByDid[m.did] = m.handle; }, this);
      this.friendDids = null;     // null = still loading
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
      // Escape cancels. On the document in the capture phase, ahead of the world's own
      // key handling, so it works wherever the focus is.
      this._onKey = function (e) {
        if (e.key !== "Escape") return;
        e.preventDefault();
        e.stopPropagation();
        self.close();
      };
      document.addEventListener("keydown", this._onKey, true);
      this.render();

      lively.identity.postcardAudience.loadContext(function (err, ctx) {
        if (!self.scrim) return;
        if (err) { self.error = "Could not load your friends: " + (err.message || err); return self.render(); }
        self.friendDids = ctx.friendDids;
        Object.keys(ctx.handleByDid).forEach(function (d) { self.handleByDid[d] = ctx.handleByDid[d]; });
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

    Dialog.prototype._toggleMember = function (did) {
      var i = this.members.indexOf(did);
      if (i === -1) {
        this.members.push(did);
      } else {
        this.members.splice(i, 1);
        var p = this.pinned.indexOf(did);
        if (p !== -1) this.pinned.splice(p, 1);
      }
      this.error = null;
      this.render();
    };

    Dialog.prototype._togglePin = function (did) {
      var p = this.pinned.indexOf(did);
      if (p !== -1) {
        this.pinned.splice(p, 1);
        this.error = null;
      } else if (this.pinned.length >= MAX_PINNED) {
        this.error = "At most " + MAX_PINNED + " can be pinned. Unpin someone first.";
      } else {
        this.pinned.push(did);
        this.error = null;
      }
      this.render();
    };

    Dialog.prototype._save = function () {
      var self = this;
      if (this.busy) return;
      var orbit = { visibility: this.visibility, members: this.members.slice(), pinned: this.pinned.slice() };
      this.busy = true;
      this.error = null;
      this.render();
      lively.identity.postcardAudience.patchSettings(function (state) { state.orbit = orbit; }, function (err) {
        self.busy = false;
        if (err) {
          self.error = "Could not save: " + (err.message || err);
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

    Dialog.prototype._visibilityRow = function (panel, y) {
      var self = this;
      var gap = 8, w = Math.floor((W - 2 * PAD - 2 * gap) / 3);
      VISIBILITIES.forEach(function (v, i) {
        var pill = UI.pill(0, y, v.text, {
          primary: self.visibility === v.key, w: w,
          onClick: function () { self.visibility = v.key; self.render(); },
        });
        pill.setPosition(lively.pt(PAD + i * (w + gap), y));
        panel.addMorph(pill);
      });
      var desc = VISIBILITIES.filter(function (v) { return v.key === self.visibility; })[0].desc;
      panel.addMorph(UI.label(lively.rect(PAD, y + 38, W - 2 * PAD, 18), desc, { px: 11, color: UI.MUTED }));
      return 62;
    };

    Dialog.prototype._picker = function (panel, y) {
      var self = this;
      var friends = this.friendDids || [];
      var rows = Math.max(1, friends.length);
      var h = Math.min(PICKER_MAX_H, rows * ROW_H + 8);
      var innerW = W - 2 * PAD;
      var box = new lively.morphic.Box(lively.rect(PAD, y, innerW, h));
      box.applyStyle({ fill: UI.PAGE_FILL, borderWidth: 1, borderColor: UI.CARD_BORDER, borderRadius: 10, clipMode: "auto" });
      UI.noDrag(box);
      if (!this.friendDids) {
        box.addMorph(UI.label(lively.rect(12, 8, innerW - 24, 20), "Loading your friends…", { px: 12, color: UI.MUTED }));
      } else if (!friends.length) {
        box.addMorph(UI.label(lively.rect(12, 8, innerW - 24, 20), "You have no friends yet.", { px: 12, color: UI.MUTED }));
      }
      var rowW = innerW - 8 - 14;
      friends.forEach(function (did, i) {
        var handle = self.handleByDid[did];
        var on = self.members.indexOf(did) !== -1;
        var pinned = self.pinned.indexOf(did) !== -1;
        var r = new lively.morphic.Box(lively.rect(4, 4 + i * ROW_H, rowW, ROW_H));
        r.applyStyle({ fill: null, borderWidth: 0, borderRadius: 8, handStyle: "pointer" });
        UI.noDrag(r);
        r.addMorph(self._checkbox(8, 8, on));
        r.addMorph(UI.label(lively.rect(40, 8, rowW - 40 - PIN_ZONE, 20), handle ? "@" + handle : "(unknown)", { px: 13 }));
        if (on) {
          // The icon font only has the outline glyph, so a pin is a pink disc with a white star.
          if (pinned) {
            var disc = new lively.morphic.Box(lively.rect(rowW - 36, 6, 24, 24));
            disc.applyStyle({ fill: UI.PINK, borderRadius: 12, borderWidth: 0 });
            UI.noDrag(disc);
            disc.eventsAreIgnored = true;
            r.addMorph(disc);
          }
          r.addMorph(UI.icon(lively.rect(rowW - 36, 6, 24, 24), "star", 18, pinned ? Color.white : UI.MUTED));
        }
        r.onMouseUp = function (evt) {
          evt.stop();
          var local = r.localize(evt.getPosition());
          if (on && local.x > rowW - PIN_ZONE) self._togglePin(did); else self._toggleMember(did);
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
      panel.addMorph(UI.label(lively.rect(PAD, y, textW, 24), "Your orbit", { px: 16, bold: true }));
      y += 28;
      var help = "Your close friends, shown on your homestar. Star up to three to pin them to the inner ring. " +
        "Only friends can be in your orbit.";
      panel.addMorph(UI.label(lively.rect(PAD, y, textW, 40), help, { px: 11, color: UI.MUTED, wrap: true }));
      y += 46;

      panel.addMorph(UI.label(lively.rect(PAD, y, textW, 18), "Who can see it", { px: 12, bold: true, color: UI.MUTED }));
      y += 24;
      y += this._visibilityRow(panel, y);

      panel.addMorph(UI.label(lively.rect(PAD, y, textW - 160, 18), "Close friends", { px: 12, bold: true, color: UI.MUTED }));
      panel.addMorph(UI.label(lively.rect(W - PAD - 160, y, 160, 18),
        this.members.length + " selected · " + this.pinned.length + " pinned", { px: 12, color: UI.MUTED, align: "right" }));
      y += 24;
      y += this._picker(panel, y) + 10;

      if (this.error) {
        panel.addMorph(UI.label(lively.rect(PAD, y, textW, 36), this.error, { px: 12, color: UI.PINK, bold: true, wrap: true }));
        y += 40;
      }
      y += 4;

      var save = UI.pill(0, y, this.busy ? "Saving…" : "Save", {
        primary: true, w: 92, disabled: this.busy || !this.friendDids, onClick: function () { self._save(); },
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

    lively.identity.OrbitDialog = {
      open: function (opts) { return new Dialog(opts).open(); }
    };

  }); // end module('lively.identity.OrbitDialog')
