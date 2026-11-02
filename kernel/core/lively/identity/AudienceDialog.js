/**
 * lively.identity.AudienceDialog
 *
 * "Who can see this postcard": a modal of checkbox rows for Public, Friends,
 * Orbit, each of the owner's lists, and Specific people (a picker over the
 * owner's friends). Public is exclusive; everything else combines, and the count
 * shown is the de-duplicated union. The state and wording rules live in
 * AudienceRules.js; this file only draws them and passes the result back.
 *
 *   lively.identity.AudienceDialog.open({
 *     ctx,                  // from PostcardAudience.loadContext (friends, orbit, lists, handleByDid)
 *     audience,             // { tiers, people } the card has now
 *     isPublic,             // the card is public now
 *     allowPublic,          // false: Public is shown but cannot be chosen (see publicNote)
 *     publicNote,           // shown under Public when it cannot be chosen
 *     subtitle,             // e.g. the card's title
 *     noun,                 // what is shared, "card" by default ("game" for the Gaming template)
 *     helpPlace,            // for a noun other than card: where new friends catch up ("this library")
 *     warning,              // optional line shown above the buttons
 *     onSave(result),       // result = { pub, audience: { tiers, people } }
 *     onCancel()
 *   });
 *
 * Every element is a morph. Rows are boxes that own the click; their children are
 * non-interactive (CLAUDE.md "Disabling drag/drop/grab" and "Mouse dispatch is
 * capture-first"). The whole dialog is rebuilt from the state after each change.
 */

module("lively.identity.AudienceDialog")
  .requires("lively.morphic.Complete", "lively.identity.HomestarUI", "lively.identity.AudienceRules", "lively.identity.ListsDialog")
  .toRun(function () {

    var UI = lively.identity.HomestarUI;
    var R = lively.identity.AudienceRules;

    var W = 460;
    var PAD = 24;
    var ROW_H = 56;
    var PICKER_ROW_H = 34;
    var PICKER_MAX_H = 170;
    var HELP = "New friends added to a list or your orbit get access the next time you open your homestar. " +
      "If you withdraw someone, they lose access to future opens; anyone who has already opened the card keeps what they saw.";
    // Same text for something that is not a postcard (opts.noun), with the place where the catch-up happens.
    function helpFor(o) {
      if (!o.noun || o.noun === "card") return HELP;
      return "New friends added to a list or your orbit get access the next time you open " + (o.helpPlace || "your homestar") + ". " +
        "If you withdraw someone, they lose access to future opens; anyone who has already opened the " + o.noun + " keeps what they saw.";
    }

    function atHandle(handle) { return "@" + handle; }

    // One px short of clientWidth: a scrim exactly as wide as the viewport still
    // makes the page scroll sideways once a vertical scrollbar exists (CLAUDE.md,
    // "Pinning a morph on screen while the page scrolls").
    function viewportWidth() { return document.documentElement.clientWidth - 1; }

    // Lines a wrapped paragraph needs. textW is already an over-estimate of the run
    // width, so this errs towards a spare line rather than clipping the last one.
    function linesFor(text, px, width) {
      return Math.max(1, Math.ceil(UI.textW(text, px, false) / width));
    }

    function Dialog(opts) {
      this.opts = opts;
      this.ctx = opts.ctx;
      this.state = R.stateFromAudience(opts.audience, !!opts.isPublic);
      this.pickerOpen = this.state.people.length > 0;
      this.scrim = null;
      this.panel = null;
    }

    Dialog.prototype.open = function () {
      var self = this;
      var scrim = this.scrim = UI.viewportScrim(function () { if (self.scrim) self.render(); });
      // Mouse dispatch is capture-first: the scrim, as the outermost ancestor, sees a
      // click before any row inside the panel does, and stopping it there would keep
      // the row from ever getting it (CLAUDE.md). So it only claims clicks that land
      // outside the panel and lets the rest continue down to the rows.
      scrim.onMouseUp = function (evt) {
        if (!self.panel) return false;
        if (UI.pointOnPanel(self.panel, evt)) return false;
        evt.stop();
        self.cancel();
        return true;
      };
      this.render();
      return this;
    };

    Dialog.prototype.close = function () {
      UI.closeScrim(this.scrim);
      this.scrim = this.panel = null;
    };

    Dialog.prototype.cancel = function () {
      this.close();
      if (this.opts.onCancel) this.opts.onCancel();
    };

    Dialog.prototype.save = function () {
      var result = { pub: this.state.pub, audience: R.audienceFromState(this.state, this.ctx) };
      this.close();
      if (this.opts.onSave) this.opts.onSave(result);
    };

    // Make, rename or delete lists without leaving this dialog. The lists live in the
    // shared ctx, so this redraws from it; a list that is gone is unticked. The cards
    // that use a list are brought in line by the quiet sync (it never prompts for the
    // passkey) and otherwise the next time the homestar opens.
    Dialog.prototype.manageLists = function () {
      var self = this;
      lively.identity.ListsDialog.open({
        ctx: this.ctx,
        onChange: function (lists) {
          var kept = {};
          lists.forEach(function (l) { if (self.state.lists[l.id]) kept[l.id] = true; });
          self.state = Object.assign({}, self.state, { lists: kept });
          if (self.scrim) self.render();
          lively.identity.postcardAudience.syncAudiences({ onlyIfKekCached: true }, function (err) {
            if (err) console.warn("[AudienceDialog] audience sync after a list change failed:", err.message || err);
          });
        },
      });
    };

    Dialog.prototype.set = function (state) {
      this.state = state;
      this.render();
    };

    // A checkbox square with a tick when on.
    Dialog.prototype._checkbox = function (x, y, on, dim) {
      var box = new lively.morphic.Box(lively.rect(x, y, 20, 20));
      box.applyStyle({
        fill: on ? UI.PINK : Color.white, borderRadius: 6, borderWidth: 2,
        borderColor: on ? UI.PINK : (dim ? UI.CARD_BORDER : Color.rgb(190, 184, 206)), clipMode: "hidden"
      });
      UI.noDrag(box);
      box.eventsAreIgnored = true;
      if (on) box.addMorph(UI.icon(lively.rect(0, 0, 16, 16), "check", 14, Color.white));
      return box;
    };

    // One clickable row: checkbox, icon, title, description, right-aligned count.
    // spec: { y, key, icon, title, desc, count, on, disabled, onClick }
    Dialog.prototype._row = function (panel, spec) {
      var row = new lively.morphic.Box(lively.rect(PAD - 8, spec.y, W - 2 * PAD + 16, ROW_H));
      row.applyStyle({ fill: Color.white, borderWidth: 0, borderRadius: 10, clipMode: "hidden" });
      UI.noDrag(row);
      var dim = !!spec.disabled;
      var ink = dim ? UI.MUTED : UI.INK;
      row.addMorph(this._checkbox(8, 18, spec.on, dim));
      row.addMorph(UI.icon(lively.rect(40, 17, 22, 22), spec.icon, 20, dim ? UI.CARD_BORDER : UI.PINK));
      row.addMorph(UI.label(lively.rect(72, 9, W - 2 * PAD - 150, 20), spec.title, { px: 13, bold: true, color: ink }));
      row.addMorph(UI.label(lively.rect(72, 29, W - 2 * PAD - 100, 20), UI.trunc(spec.desc, 64), { px: 11, color: UI.MUTED }));
      if (spec.count !== undefined && spec.count !== null) {
        row.addMorph(UI.label(lively.rect(W - 2 * PAD - 52, 18, 56, 20), String(spec.count), { px: 12, color: UI.MUTED, align: "right" }));
      }
      if (!dim) {
        row.applyStyle({ handStyle: "pointer" });
        row.onMouseOver = function () { row.applyStyle({ fill: UI.PINK_SOFT }); };
        row.onMouseOut = function () { row.applyStyle({ fill: Color.white }); };
        row.onMouseUp = function (evt) { evt.stop(); spec.onClick(); return true; };
      }
      panel.addMorph(row);
      return row;
    };

    // The friends picker under "Specific people".
    Dialog.prototype._picker = function (panel, y) {
      var self = this;
      var friends = this.ctx.friendDids || [];
      var rows = Math.max(1, friends.length);
      var h = Math.min(PICKER_MAX_H, rows * PICKER_ROW_H + 8);
      var box = new lively.morphic.Box(lively.rect(PAD, y, W - 2 * PAD, h));
      box.applyStyle({ fill: UI.PAGE_FILL, borderWidth: 1, borderColor: UI.CARD_BORDER, borderRadius: 10, clipMode: "auto" });
      UI.noDrag(box);
      if (!friends.length) {
        box.addMorph(UI.label(lively.rect(12, 8, W - 2 * PAD - 24, 20), "You have no friends yet.", { px: 12, color: UI.MUTED }));
      }
      friends.forEach(function (did, i) {
        var handle = self.ctx.handleByDid[did];
        var on = self.state.people.indexOf(did) !== -1;
        var r = new lively.morphic.Box(lively.rect(4, 4 + i * PICKER_ROW_H, W - 2 * PAD - 8 - 14, PICKER_ROW_H));
        r.applyStyle({ fill: null, borderWidth: 0, borderRadius: 8, handStyle: "pointer" });
        UI.noDrag(r);
        r.addMorph(self._checkbox(8, 7, on, false));
        r.addMorph(UI.label(lively.rect(40, 7, W - 2 * PAD - 100, 20), handle ? atHandle(handle) : "(unknown)", { px: 13, color: UI.INK }));
        r.onMouseUp = function (evt) { evt.stop(); self.set(R.togglePerson(self.state, did)); return true; };
        box.addMorph(r);
      });
      panel.addMorph(box);
      return h;
    };

    Dialog.prototype._peopleDesc = function () {
      var self = this;
      var names = this.state.people.map(function (d) { return self.ctx.handleByDid[d]; }).filter(Boolean).map(atHandle);
      if (!names.length) return "Choose from your friends";
      return names.length > 3 ? names.slice(0, 3).join(", ") + " and " + (names.length - 3) + " more" : names.join(", ");
    };

    Dialog.prototype.render = function () {
      var self = this;
      var ctx = this.ctx, st = this.state, o = this.opts;
      if (this.panel) this.panel.remove();

      var panel = this.panel = new lively.morphic.Box(lively.rect(0, 0, W, 400));
      panel.applyStyle({ fill: Color.white, borderWidth: 1, borderColor: UI.CARD_BORDER, borderRadius: 16, clipMode: "hidden" });
      UI.noDrag(panel);

      var y = 20;
      panel.addMorph(UI.label(lively.rect(PAD, y, W - 2 * PAD, 24), "Who can see this " + (o.noun === "game" ? "game" : "postcard"), { px: 16, bold: true }));
      y += 28;
      if (o.subtitle) {
        panel.addMorph(UI.label(lively.rect(PAD, y, W - 2 * PAD, 18), UI.trunc(o.subtitle, 56), { px: 12, color: UI.MUTED }));
        y += 22;
      }
      y += 8;

      var allowPublic = o.allowPublic !== false;
      this._row(panel, {
        y: y, icon: "public", title: "Public", on: st.pub, disabled: !allowPublic,
        desc: allowPublic ? "Anyone, including people who are signed out" : (o.publicNote || "Make it public from the editor"),
        onClick: function () { self.set(R.toggle(st, "pub")); }
      });
      y += ROW_H;

      this._row(panel, {
        y: y, icon: "group", title: "Friends", on: st.friends, count: (ctx.friendDids || []).length,
        desc: "Everyone you are friends with", onClick: function () { self.set(R.toggle(st, "friends")); }
      });
      y += ROW_H;

      this._row(panel, {
        y: y, icon: "stars", title: "Orbit", on: st.orbit, count: (ctx.orbitDids || []).length,
        desc: "Your close friends", onClick: function () { self.set(R.toggle(st, "orbit")); }
      });
      y += ROW_H;

      (ctx.lists || []).forEach(function (l) {
        var n = (l.memberDids || []).filter(function (d) { return (ctx.friendDids || []).indexOf(d) !== -1; }).length;
        self._row(panel, {
          y: y, icon: "label", title: UI.trunc(l.name, 30), on: !!st.lists[l.id], count: n,
          desc: "Your list", onClick: function () { self.set(R.toggle(st, "list:" + l.id)); }
        });
        y += ROW_H;
      });

      this._row(panel, {
        y: y, icon: "person_add", title: "Specific people", on: st.people.length > 0, count: st.people.length || null,
        desc: this._peopleDesc(),
        onClick: function () { self.pickerOpen = !self.pickerOpen; self.render(); }
      });
      y += ROW_H;
      if (this.pickerOpen) {
        y += 2;
        y += this._picker(panel, y) + 8;
      }

      this._row(panel, {
        y: y, icon: "lock", title: "Only me", on: R.isOnlyMe(st),
        desc: "Encrypted. Only you can open it",
        onClick: function () { self.pickerOpen = false; self.set(R.toggle(st, "me")); }
      });
      y += ROW_H;

      y += 8;
      var textW = W - 2 * PAD;
      var footer = R.footerText(st, ctx, o.noun);
      panel.addMorph(UI.label(lively.rect(PAD, y, textW, 22), footer, { px: 13, bold: true, wrap: true }));
      y += 18 * linesFor(footer, 13, textW) + 8;

      var help = helpFor(o);
      panel.addMorph(UI.label(lively.rect(PAD, y, textW, 18 * linesFor(help, 11, textW) + 4), help, { px: 11, color: UI.MUTED, wrap: true }));
      y += 18 * linesFor(help, 11, textW) + 10;

      if (o.warning) {
        panel.addMorph(UI.label(lively.rect(PAD, y, textW, 18 * linesFor(o.warning, 12, textW) + 4), o.warning,
          { px: 12, color: UI.PINK, bold: true, wrap: true }));
        y += 18 * linesFor(o.warning, 12, textW) + 10;
      }

      y += 6;
      var save = UI.pill(0, y, "Save", { primary: true, w: 92, onClick: function () { self.save(); } });
      var cancel = UI.pill(0, y, "Cancel", { w: 92, onClick: function () { self.cancel(); } });
      var manage = UI.pill(0, y, "Manage lists", { w: 116, onClick: function () { self.manageLists(); } });
      save.setPosition(lively.pt(W - PAD - 92, y));
      cancel.setPosition(lively.pt(W - PAD - 92 - 100, y));
      manage.setPosition(lively.pt(PAD, y));
      panel.addMorph(manage);
      panel.addMorph(cancel);
      panel.addMorph(save);
      y += 30 + 22;

      // Sized and placed before it is added (CLAUDE.md: a setPosition right after addMorph
      // can desync the render tree). The scrim's origin is the top of the viewport, so the
      // panel's position is relative to that.
      var vh = window.innerHeight, vw = viewportWidth();
      panel.setExtent(lively.pt(W, y));
      panel.setPosition(lively.pt(Math.round((vw - W) / 2), Math.max(16, Math.round((vh - y) / 2))));
      this.scrim.addMorph(panel);
    };

    lively.identity.AudienceDialog = {
      open: function (opts) { return new Dialog(opts).open(); }
    };

  }); // end module('lively.identity.AudienceDialog')
